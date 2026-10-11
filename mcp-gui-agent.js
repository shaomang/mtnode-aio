"use strict";
/**
 * MCP 的 GUI 动作执行器（主进程）：让第三方 MCP 客户端能**真的操作 MTNode 窗口** ——
 * 认元素、点、聚焦输入、设值、按键、滚动、等待、读结构快照，以及给某个窗口拍静帧。
 *
 * 为什么单独放在根目录一个模块（而不是塞进 mcp-server.js）：
 *   ① mcp-server.js 的定位是「协议与服务端」，执行一律转发渲染层；GUI 动作是**第一类
 *      在主进程执行**的工具（只有它拿得到 BrowserWindow 与 webContents），把它混进服务端
 *      会让「谁在执行」这件事变得不可读；
 *   ② 主进程其余窗口编排（plugins/main-install.js 等）不该 require MCP 相关代码。
 *
 * 执行方式：真实的 DOM 操作要用**页面自己的能力**——把一段自包含脚本交给
 *   `webContents.executeJavaScript(script, true)` 在渲染层里跑，于是元素匹配用的是页面
 *   自己的 CSS 与事件系统（比外部坐标点击稳得多，也不需要窗口在前台）。
 *   拍照走 `webContents.capturePage()`（与「窗口静帧截图」同一条链路，见 renderer/app-assets.js）。
 *
 * ⚠ 注入脚本的写法纪律（踩过一次，别再来一次）：本文件是**主进程模块**，而 pageScript 的
 *   字符串会被送进页面执行。所以注入脚本里一律**不许出现模板字面量**（反引号 + ${}）：
 *   那些 ${} 会在主进程求值（变量不存在时直接抛错，或悄悄替成 undefined），页面收到的
 *   就是坏脚本 —— 表现是「Unexpected token '}'」这种看不懂的错。
 *   一律用字符串拼接：下面的 PICK_FN / OUTLINE_BODY 等都是数组 join，不是模板字面量。
 *
 * 边界（如实写在这里，免得调用方白试）：
 *   · 抓不到原生菜单、系统文件选择对话框、托盘菜单 —— 那些不在渲染层的 DOM 里；
 *   · 窗口最小化 / 完全不可见时 capturePage 拿不到画面（回 empty）；
 *   · 不认密码、不代填凭据：需要凭据的表单请由人在窗口里输入。
 *
 * 纪律：本模块**不落盘**（除 screenshot 写出调用方指定路径的 PNG/JPG），不改画布，不碰数据目录。
 */
const fs = require("fs");
const path = require("path");
const { BrowserWindow, screen } = require("electron");

/** 一次 GUI 动作里等待元素出现的默认上限（毫秒）。 */
const DEFAULT_TIMEOUT_MS = 15000;
/** 单次动作后自动等待页面「安静」的上限（毫秒）——不阻塞太久，靠 wait 动作补。 */
const DEFAULT_SETTLE_MS = 400;
/** 结构快照返回的节点上限（防止一屏几百个元素把 token 烧光）。 */
const OUTLINE_MAX = 120;

function clamp(n, lo, hi) {
  const v = Number(n);
  if (!Number.isFinite(v)) return lo;
  return Math.max(lo, Math.min(hi, Math.round(v)));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, clamp(ms, 0, 60000)));
}

/* ------------------------------------------------------------------ */
/* 窗口解析                                                            */
/* ------------------------------------------------------------------ */

function winInfo(w) {
  return {
    win: w,
    id: w.id,
    title: String(w.getTitle() || ""),
    url: String((w.webContents && w.webContents.getURL()) || ""),
    hidden: !w.isVisible() || w.isMinimized(),
  };
}

function describe(w) {
  const i = winInfo(w);
  return (i.title || "(无标题)") + " [" + (i.url || "?") + "]";
}

/**
 * 找一个可操作的窗口。
 * which: "main"（默认，主窗口）· "install"（插件安装窗）· "any"（最近聚焦 / 首个可见窗）
 *      · 其它字符串 → 按窗口标题包含匹配（如 "Minimax H3"）。
 * 返回 { win, id, title, url, hidden }；找不到抛错（错误文本写给调用方照做）。
 */
function pickWindow(which) {
  const want = String(which || "main").trim() || "main";
  const all = BrowserWindow.getAllWindows().filter((w) => w && !w.isDestroyed());
  if (!all.length) throw new Error("MTNode 当前没有任何窗口（应用可能正在退出）");
  /* 安装窗的入口页：install/index.html（见 plugins/main-install.js 的 installEntry）——
     路径既可能是 file:///…/install/index.html，也可能是 …/install.html，两种都认。
     标题也认一次（「插件安装 · <插件名>」）：万一入口页换名，按标题仍能选中它。 */
  const isInstall = (w) => {
    const i = winInfo(w);
    return /[\\/]install[\\/]/i.test(i.url) || /install\.html/i.test(i.url) || /^插件安装/.test(i.title);
  };
  const isMain = (w) => /renderer[\\/]index\.html/i.test(winInfo(w).url);
  let target = null;
  if (want === "install") target = all.find(isInstall) || null;
  else if (want === "any") {
    target = BrowserWindow.getFocusedWindow() || all.find((w) => w.isVisible()) || all[0];
  } else if (want === "main") target = all.find(isMain) || all.find((w) => w.isVisible()) || all[0];
  else {
    const lower = want.toLowerCase();
    target =
      all.find((w) => winInfo(w).title.toLowerCase().includes(lower)) ||
      all.find((w) => winInfo(w).url.toLowerCase().includes(lower)) ||
      null;
    if (!target) {
      throw new Error("没找到标题包含「" + want + "」的窗口。当前窗口：" + all.map(describe).join(" · "));
    }
  }
  if (!target) {
    throw new Error(
      (want === "install"
        ? "当前没有插件安装窗。先在「插件」对话框里点某个插件的「开始安装」把窗打开。"
        : "没找到目标窗口（which=" + want + "）。") + "现有窗口：" + all.map(describe).join(" · "),
    );
  }
  const out = winInfo(target);
  if (!out.url) throw new Error("目标窗口还没有加载出页面（URL 为空），稍后再试");
  return out;
}

/** 只读的窗口清单（调用方先看清有哪几只窗，再决定 which）。 */
function listWindows() {
  return BrowserWindow.getAllWindows()
    .filter((w) => w && !w.isDestroyed())
    .map((w) => {
      const i = winInfo(w);
      return {
        id: i.id,
        title: i.title,
        url: i.url,
        visible: w.isVisible(),
        minimized: w.isMinimized(),
      };
    });
}

/* ------------------------------------------------------------------ */
/* 页面里跑的脚本（自包含：不依赖页面上的任何全局）                     */
/* ------------------------------------------------------------------ */

/** 把一段脚本体包成 IIFE，附上参数常量，交 executeJavaScript 执行。 */
function pageScript(body, args) {
  return (
    "(() => {\n" +
    "  const A = " + JSON.stringify(args || {}) + ";\n" +
    "  const out = { ok: false, error: '' };\n" +
    "  try {\n" +
    body +
    "\n  } catch (e) { out.error = String((e && e.message) || e); }\n" +
    "  return out;\n" +
    "})()"
  );
}

/** 元素选择器（页面侧共用）：把 A.target 解析成一个真正可点的元素。纯拼接，勿改成模板字面量。 */
const PICK_FN = [
  "  const VIS = (el) => {",
  "    if (!el || !el.isConnected) return false;",
  "    const cs = getComputedStyle(el);",
  "    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;",
  "    const r = el.getBoundingClientRect();",
  "    return r.width > 0 && r.height > 0;",
  "  };",
  "  const TEXT = (el) => String((el.innerText || el.textContent || '')).replace(/\\s+/g, ' ').trim();",
  "  const LABEL = (el) => String(el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || el.getAttribute('data-tip') || '').trim();",
  "  const DESC = (el) => ({ tag: el.tagName.toLowerCase(), id: el.id || '', cls: String(el.className || '').slice(0, 80), text: TEXT(el).slice(0, 60), label: LABEL(el).slice(0, 60) });",
  "  const DEEPEST = (list) => {",
  "    const arr = Array.from(list);",
  "    return arr.filter((el) => !arr.some((o) => o !== el && el.contains(o)));",
  "  };",
  "  function pick() {",
  "    const t = A.target;",
  "    if (!t || typeof t !== 'object') throw new Error('缺少 target：至少给 css / text / title / role / ref 之一');",
  "    let list = [];",
  "    if (t.css) list = document.querySelectorAll(t.css);",
  "    else if (t.ref) {",
  "      const sel = '[data-mtnode-mcp-ref=\"' + String(t.ref).replace(/\"/g, '') + '\"]';",
  "      const el = document.querySelector(sel);",
  "      if (!el) throw new Error('ref ' + t.ref + ' 已失效（页面重新渲染过）：重新跑一次 outline 拿新的 ref');",
  "      list = [el];",
  "    } else if (t.text != null && t.text !== '') {",
  "      const needle = String(t.text);",
  "      const exact = t.exact === true;",
  "      const hit = [];",
  "      for (const el of document.querySelectorAll('body *')) {",
  "        const s = TEXT(el);",
  "        if (!s) continue;",
  "        if (exact ? s === needle : s.indexOf(needle) >= 0) hit.push(el);",
  "      }",
  "      /* 取最深的一批：父节点也包含同样的文字，取父节点会点到一大片 */",
  "      list = DEEPEST(hit);",
  "      /* 非精确时优先「文字更短」的：短文字更可能是那个按钮自己的文案 */",
  "      if (!exact) list = Array.from(list).sort((a, b) => TEXT(a).length - TEXT(b).length);",
  "    } else if (t.title != null && t.title !== '') {",
  "      const needle = String(t.title).toLowerCase();",
  "      const all = document.querySelectorAll('[aria-label],[title],[data-tip],[placeholder],button,a,input,select,textarea');",
  "      list = Array.from(all).filter((el) => LABEL(el).toLowerCase().indexOf(needle) >= 0);",
  "    } else if (t.role != null && t.role !== '') {",
  "      const needle = String(t.role).toLowerCase();",
  "      list = Array.from(document.querySelectorAll('button,a,[role=\"button\"],input,select,textarea')).filter((el) => {",
  "        const role = String(el.getAttribute('role') || el.tagName).toLowerCase();",
  "        const lbl = LABEL(el).toLowerCase() + ' ' + TEXT(el).toLowerCase();",
  "        return role.indexOf(needle) >= 0 && (!t.name || lbl.indexOf(String(t.name).toLowerCase()) >= 0);",
  "      });",
  "    } else throw new Error('target 没给出可用的匹配条件（css / text / title / role / ref）');",
  "    let vis = Array.from(list).filter(VIS);",
  "    if (!vis.length && t.includeHidden) vis = Array.from(list);",
  "    if (!vis.length) throw new Error('没找到匹配元素（或它不可见）：' + JSON.stringify(t));",
  "    const idx = Number(t.index) || 0;",
  "    if (idx >= vis.length) throw new Error('匹配到 ' + vis.length + ' 个元素，但 index=' + idx + ' 越界（0 起）');",
  "    return { el: vis[idx], matched: vis.length };",
  "  }",
].join("\n");

/** outline 的脚本体（拼接，勿改模板字面量）。 */
const OUTLINE_BODY = [
  "    const MAX = A.max;",
  "    const rows = [];",
  "    const sel = A.selector || 'button,a,[role=\"button\"],input,select,textarea,[onclick],.card,.plugin-card';",
  "    for (const el of document.querySelectorAll(sel)) {",
  "      if (!VIS(el)) continue;",
  "      const r = el.getBoundingClientRect();",
  "      if (r.bottom < 0 || r.top > innerHeight + 400) continue;",
  "      const ref = 'r' + rows.length;",
  "      el.setAttribute('data-mtnode-mcp-ref', ref);",
  "      const d = DESC(el);",
  "      rows.push({ ref: ref, tag: d.tag, id: d.id, cls: d.cls, text: d.text, label: d.label, disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true', x: Math.round(r.x), y: Math.round(r.y) });",
  "      if (rows.length >= MAX) break;",
  "    }",
  "    out.ok = true;",
  "    out.docTitle = document.title;",
  "    out.url = location.href;",
  "    out.count = rows.length;",
  "    out.items = rows;",
  "    if (A.textMax !== 0) {",
  "      const lines = (document.body ? document.body.innerText || '' : '').split('\\n').map((s) => s.trim()).filter(Boolean);",
  "      out.text = lines.slice(0, Number(A.textMax) || 80);",
  "    }",
].join("\n");

/* ------------------------------------------------------------------ */
/* 动作实现                                                            */
/* ------------------------------------------------------------------ */

/** outline：页面结构快照（可见可交互元素 + ref），并可选回一段可见文字。 */
async function actOutline(w, params) {
  const script = pageScript(PICK_FN + "\n" + OUTLINE_BODY, {
    max: OUTLINE_MAX,
    selector: params.selector || "",
    textMax: params.textMax === undefined ? 80 : params.textMax,
  });
  return w.webContents.executeJavaScript(script, true);
}

/** click：点一个元素（页面内真实 DOM click，带完整鼠标事件序列）。 */
async function actClick(w, params) {
  const body = [
    PICK_FN,
    "    const picked = pick();",
    "    const el = picked.el;",
    "    const d = DESC(el);",
    "    if (!A.force && (el.disabled || el.getAttribute('aria-disabled') === 'true')) {",
    "      out.error = '目标元素是禁用状态：' + JSON.stringify(d);",
    "      out.element = d;",
    "      return out;",
    "    }",
    "    const r = el.getBoundingClientRect();",
    "    const cx = r.x + r.width / 2;",
    "    const cy = r.y + r.height / 2;",
    "    const o = { bubbles: true, cancelable: true, composed: true, clientX: cx, clientY: cy, button: 0, view: window };",
    "    try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}",
    "    try { el.dispatchEvent(new MouseEvent('mouseover', o)); el.dispatchEvent(new MouseEvent('mousedown', o)); } catch (e) {}",
    "    if (typeof el.focus === 'function') { try { el.focus(); } catch (e) {} }",
    "    try { el.dispatchEvent(new MouseEvent('mouseup', o)); } catch (e) {}",
    "    try { el.click(); } catch (e) { el.dispatchEvent(new MouseEvent('click', o)); }",
    "    if (A.dbl) {",
    "      try { el.dispatchEvent(new MouseEvent('dblclick', Object.assign({}, o, { detail: 2 }))); } catch (e) {}",
    "    }",
    "    out.ok = true;",
    "    out.element = d;",
    "    out.matched = picked.matched;",
    "    out.at = { x: Math.round(cx), y: Math.round(cy) };",
  ].join("\n");
  return w.webContents.executeJavaScript(
    pageScript(body, { target: params.target, force: !!params.force, dbl: params.mode === "dblclick" }),
    true,
  );
}

/** type：聚焦并输入（原生 value setter + input 事件；contenteditable 也认）。 */
async function actType(w, params) {
  const body = [
    PICK_FN,
    "    let el;",
    "    let matched = 0;",
    "    if (A.target) { const p = pick(); el = p.el; matched = p.matched; }",
    "    else el = document.activeElement;",
    "    if (!el) { out.error = '没有目标元素，也没有聚焦元素（先点一下输入框）'; return out; }",
    "    const d = DESC(el);",
    "    if (typeof el.focus === 'function') el.focus();",
    "    const text = String(A.text == null ? '' : A.text);",
    "    const tag = el.tagName.toLowerCase();",
    "    if (tag === 'input' || tag === 'textarea') {",
    "      const proto = tag === 'input' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;",
    "      const setter = Object.getOwnPropertyDescriptor(proto, 'value');",
    "      if (A.clear) {",
    "        if (setter && setter.set) setter.set.call(el, ''); else el.value = '';",
    "        el.dispatchEvent(new Event('input', { bubbles: true }));",
    "      }",
    "      if (text) {",
    "        if (setter && setter.set) setter.set.call(el, String(el.value || '') + text);",
    "        else el.value = String(el.value || '') + text;",
    "        el.dispatchEvent(new Event('input', { bubbles: true }));",
    "      }",
    "    } else if (el.isContentEditable) {",
    "      if (A.clear) { el.innerHTML = ''; el.dispatchEvent(new InputEvent('input', { bubbles: true })); }",
    "      if (text) {",
    "        el.textContent = String(el.textContent || '') + text;",
    "        el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));",
    "      }",
    "    } else { out.error = '目标不是输入类元素：' + JSON.stringify(d); out.element = d; return out; }",
    "    out.ok = true;",
    "    out.element = d;",
    "    out.matched = matched;",
    "    out.value = String(el.value != null ? el.value : el.textContent || '').slice(0, 200);",
  ].join("\n");
  const r = await w.webContents.executeJavaScript(
    pageScript(body, {
      target: params.target,
      text: params.text == null ? "" : String(params.text),
      clear: params.clear !== false,
    }),
    true,
  );
  if (r && r.ok && params.submit) {
    await actKey(w, { key: "Enter" });
  }
  return r;
}

/** set：给表单元素赋值（输入框 / select / checkbox / radio / contenteditable）。 */
async function actSet(w, params) {
  const body = [
    PICK_FN,
    "    const picked = pick();",
    "    const el = picked.el;",
    "    const d = DESC(el);",
    "    const v = A.value;",
    "    const tag = el.tagName.toLowerCase();",
    "    if (tag === 'select') {",
    "      const want = String(v);",
    "      const opt = Array.from(el.options).find((o) => o.value === want || String(o.textContent || '').trim() === want);",
    "      if (!opt) {",
    "        out.error = 'select 里没有这个选项：' + want + '（现有：' + Array.from(el.options).map((o) => o.value).join(' / ') + '）';",
    "        return out;",
    "      }",
    "      el.value = opt.value;",
    "      el.dispatchEvent(new Event('change', { bubbles: true }));",
    "    } else if (tag === 'input' && (el.type === 'checkbox' || el.type === 'radio')) {",
    "      const want = v === true || v === 'true' || v === 1 || v === '1';",
    "      if (el.checked !== want) el.click();",
    "    } else if (tag === 'input' || tag === 'textarea') {",
    "      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');",
    "      if (setter && setter.set) setter.set.call(el, String(v == null ? '' : v));",
    "      else el.value = String(v == null ? '' : v);",
    "      el.dispatchEvent(new Event('input', { bubbles: true }));",
    "      el.dispatchEvent(new Event('change', { bubbles: true }));",
    "    } else if (el.isContentEditable) {",
    "      el.textContent = String(v == null ? '' : v);",
    "      el.dispatchEvent(new InputEvent('input', { bubbles: true }));",
    "    } else { out.error = '目标不支持赋值：' + JSON.stringify(d); out.element = d; return out; }",
    "    out.ok = true;",
    "    out.element = d;",
    "    out.matched = picked.matched;",
    "    out.value = String(el.value != null ? el.value : el.textContent || '').slice(0, 200);",
  ].join("\n");
  return w.webContents.executeJavaScript(pageScript(body, { target: params.target, value: params.value }), true);
}

/** key：向聚焦元素派发一次键盘事件（Enter / Escape / Tab / 方向键 / 单字符）。 */
async function actKey(w, params) {
  const body = [
    "    const key = String(A.key || 'Enter');",
    "    const el = document.activeElement || document.body;",
    "    const map = { Enter: 'Enter', Escape: 'Escape', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete', ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', ' ': 'Space' };",
    "    const k = map[key] || key;",
    "    const o = { key: k, code: k, bubbles: true, cancelable: true, composed: true };",
    "    el.dispatchEvent(new KeyboardEvent('keydown', o));",
    "    el.dispatchEvent(new KeyboardEvent('keypress', o));",
    "    el.dispatchEvent(new KeyboardEvent('keyup', o));",
    "    out.ok = true;",
    "    out.target = { tag: el.tagName ? el.tagName.toLowerCase() : '', id: el.id || '' };",
  ].join("\n");
  return w.webContents.executeJavaScript(pageScript(body, { key: params.key }), true);
}

/** scroll：滚动窗口或某个可滚容器。 */
async function actScroll(w, params) {
  const body = [
    PICK_FN,
    "    const dy = Number(A.dy) || 0;",
    "    const dx = Number(A.dx) || 0;",
    "    if (A.target) {",
    "      const p = pick();",
    "      p.el.scrollTop = p.el.scrollTop + dy;",
    "      p.el.scrollLeft = p.el.scrollLeft + dx;",
    "      out.element = DESC(p.el);",
    "    } else {",
    "      window.scrollBy(dx, dy);",
    "    }",
    "    out.ok = true;",
    "    out.scrollY = Math.round(window.scrollY || 0);",
  ].join("\n");
  return w.webContents.executeJavaScript(
    pageScript(body, { target: params.target, dy: params.dy, dx: params.dx }),
    true,
  );
}

/** wait：等到元素出现 / 文字出现 / 元素消失，或干脆等一段时间。 */
async function actWait(w, params) {
  const timeout = clamp(params.timeoutMs == null ? DEFAULT_TIMEOUT_MS : params.timeoutMs, 50, 600000);
  const wantText = params.text == null ? "" : String(params.text);
  if (params.target && !wantText && !params.gone) {
    /* 元素等待在页面里轮询，省掉多次 IPC 往返 */
    const body = [
      PICK_FN,
      "    const deadline = Date.now() + A.timeoutMs;",
      "    const done = () => {",
      "      try { const p = pick(); out.ok = true; out.element = DESC(p.el); return true; }",
      "      catch (e) {",
      "        if (Date.now() > deadline) { out.error = '等待超时：元素没出现 ' + JSON.stringify(A.target); return true; }",
      "        return false;",
      "      }",
      "    };",
      "    if (done()) return out;",
      "    return new Promise((resolve) => {",
      "      const iv = setInterval(() => { if (done()) { clearInterval(iv); resolve(out); } }, 120);",
      "    });",
    ].join("\n");
    return w.webContents.executeJavaScript(pageScript(body, { target: params.target, timeoutMs: timeout }), true);
  }
  const probeBody = [
    PICK_FN,
    "    const raw = document.body ? document.body.innerText || '' : '';",
    "    if (A.text) { out.ok = raw.indexOf(A.text) >= 0; out.found = out.ok; return out; }",
    "    if (A.target) {",
    "      let found = false;",
    "      let desc = null;",
    "      try { const p = pick(); found = true; desc = DESC(p.el); } catch (e) { found = false; }",
    "      out.found = found;",
    "      out.element = desc;",
    "      out.ok = A.gone ? !found : found;",
    "      return out;",
    "    }",
    "    out.ok = true;",
  ].join("\n");
  const deadline = Date.now() + timeout;
  for (;;) {
    const probe = await w.webContents.executeJavaScript(
      pageScript(probeBody, { text: wantText, target: params.target, gone: !!params.gone }),
      true,
    );
    if (probe && probe.ok) return probe;
    if (Date.now() > deadline) {
      return {
        ok: false,
        found: false,
        error:
          "等待超时（" + timeout + "ms）：" +
          (wantText ? "页面里始终没有出现文字「" + wantText + "」" : "条件始终不成立"),
      };
    }
    await sleep(200);
  }
}

/** text：读页面可见文字（分页 / 截断，避免一次把整页灌进上下文）。 */
async function actText(w, params) {
  const body = [
    "    const raw = document.body ? document.body.innerText || '' : '';",
    "    const lines = raw.split('\\n').map((s) => s.trim()).filter(Boolean);",
    "    const off = Number(A.offset) || 0;",
    "    const lim = Number(A.limit) || 200;",
    "    out.ok = true;",
    "    out.total = lines.length;",
    "    out.lines = lines.slice(off, off + lim);",
    "    out.docTitle = document.title;",
    "    out.url = location.href;",
  ].join("\n");
  return w.webContents.executeJavaScript(pageScript(body, { offset: params.offset, limit: params.limit }), true);
}

/** eval：在页面里跑一小段只读表达式（排障用；要改状态请走 click / type / set）。
 *  原样返回表达式的值 —— 表达式可以返回 Promise（executeJavaScript 的 awaitPromise 会等它），
 *  所以「读一个要 await 的接口」写成 `window.api.xxx().then(r => JSON.stringify(r))` 最省事。
 *  ⚠ 不要把表达式再包一层 IIFE 去 try/catch：那样 Promise 会留在里层，awaitPromise 等不到它，
 *  返回的就是一个不可克隆的 Promise 对象（报「An object could not be cloned.」）。 */
async function actEval(w, params) {
  const expr = String(params.expression || "").trim();
  if (!expr) throw new Error("eval 需要 expression");
  const v = await w.webContents.executeJavaScript(expr, true);
  return { ok: true, value: v === undefined ? null : v };
}

/* ------------------------------------------------------------------ */
/* 截图                                                                */
/* ------------------------------------------------------------------ */

/** 瞬时浮层（右键菜单 / 图片灯箱）先藏起来，拍完恢复 —— 与「窗口静帧」同口径。 */
const HIDE_UI_FN =
  "(function(){var ids=['ctx','imgLb'];for(var i=0;i<ids.length;i++){var el=document.getElementById(ids[i]);" +
  "if(el){el.dataset.mcpShotHidden='1';el.style.display='none';}}return true})()";
const SHOW_UI_FN =
  "(function(){var els=document.querySelectorAll('[data-mcp-shot-hidden=\"1\"]');" +
  "for(var i=0;i<els.length;i++){els[i].style.display='';delete els[i].dataset.mcpShotHidden;}return true})()";
/** 画布视口矩形（CSS px → 设备像素），拿不到就退回整窗。 */
const CANVAS_RECT_EXPR =
  "(function(){var el=document.getElementById('stage')||document.getElementById('canvasWrap')||" +
  "document.querySelector('.stage')||document.querySelector('canvas');if(!el)return null;" +
  "var r=el.getBoundingClientRect();var s=window.devicePixelRatio||1;" +
  "return {x:Math.max(0,Math.round(r.x*s)),y:Math.max(0,Math.round(r.y*s))," +
  "width:Math.round(r.width*s),height:Math.round(r.height*s)};})()";

/**
 * 给一个窗口拍静帧并写出图片。
 * opts: { which, path, canvasOnly, hideUI, delayMs, quality, allowHidden }
 */
async function screenshot(params) {
  const p = params || {};
  const t = pickWindow(p.which || "main");
  const win = t.win;
  if (t.hidden && !p.allowHidden) {
    throw new Error(
      "目标窗口当前不可见（最小化 / 已隐藏），capturePage 拍不到画面：先在窗口里把它显示出来再拍" +
        "（也可以传 allowHidden:true 试一次，多半只会得到空图）。",
    );
  }
  if (p.hideUI) {
    await win.webContents.executeJavaScript(HIDE_UI_FN, true).catch(() => {});
  }
  await sleep(p.delayMs == null ? DEFAULT_SETTLE_MS : clamp(p.delayMs, 0, 30000));
  let img = null;
  if (p.canvasOnly) {
    const rect = await win.webContents.executeJavaScript(CANVAS_RECT_EXPR, true).catch(() => null);
    if (rect && rect.width > 8 && rect.height > 8) img = await win.webContents.capturePage(rect);
  }
  if (!img || img.isEmpty()) img = await win.webContents.capturePage();
  const size = img.getSize();
  const outPath = String(p.path || "").trim();
  if (!outPath) throw new Error("screenshot 需要 path（本机绝对路径，.png / .jpg）");
  const abs = path.resolve(outPath);
  const isJpg = /\.jpe?g$/i.test(abs);
  const buf = isJpg ? img.toJPEG(clamp(p.quality || 85, 40, 100)) : img.toPNG();
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, buf);
  if (p.hideUI) {
    await win.webContents.executeJavaScript(SHOW_UI_FN, true).catch(() => {});
  }
  return {
    ok: true,
    path: abs,
    bytes: buf.length,
    width: size.width,
    height: size.height,
    empty: img.isEmpty(),
    window: { id: t.id, title: t.title, url: t.url },
    /* 屏幕分区一并回来：调用方多半只拿到图片路径，有像素尺寸与窗口标题才能判断「这是哪只窗的哪一块」 */
    displays: screen.getAllDisplays().map((d) => ({ id: d.id, scale: d.scaleFactor, bounds: d.bounds })),
  };
}

/* ------------------------------------------------------------------ */
/* 对外入口                                                            */
/* ------------------------------------------------------------------ */

/**
 * 跑一次 GUI 动作或拍照。
 * action: windows | outline | text | click | type | set | key | scroll | wait | eval | screenshot
 * 返回纯 JSON（可直接进 MCP 回执）。
 */
async function run(action, params) {
  const act = String(action || "").trim();
  const p = params && typeof params === "object" ? params : {};
  if (act === "windows") return { ok: true, windows: listWindows() };
  if (act === "screenshot") return screenshot(p);
  const t = pickWindow(p.which || "main");
  const w = t.win;
  let out;
  switch (act) {
    case "outline":
      out = await actOutline(w, p);
      break;
    case "text":
      out = await actText(w, p);
      break;
    case "click":
      out = await actClick(w, p);
      break;
    case "type":
      out = await actType(w, p);
      break;
    case "set":
      out = await actSet(w, p);
      break;
    case "key":
      out = await actKey(w, p);
      break;
    case "scroll":
      out = await actScroll(w, p);
      break;
    case "wait":
      out = await actWait(w, p);
      break;
    case "eval":
      out = await actEval(w, p);
      break;
    default:
      throw new Error(
        "未知的 action：" +
          act +
          "（可用：windows / outline / text / click / type / set / key / scroll / wait / eval / screenshot）",
      );
  }
  if (p.settleMs !== 0) await sleep(p.settleMs == null ? DEFAULT_SETTLE_MS : clamp(p.settleMs, 0, 60000));
  const r = Object.assign({ window: { id: t.id, title: t.title, url: t.url } }, out || {});
  if (r && r.ok === false && !r.error) r.error = "动作没有生效（页面返回 ok:false）";
  return r;
}

module.exports = { run, listWindows, screenshot, pickWindow, OUTLINE_MAX };
