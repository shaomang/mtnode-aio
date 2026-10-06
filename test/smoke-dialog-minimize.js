"use strict";
/* 弹窗最小化 —— 冒烟测试（纯 Node）
 *   node test/smoke-dialog-minimize.js
 *
 * 本轮需求「移除 footer 最小化，以及所有的最小化，仅保留关闭」之后，这个文件从
 * 「最小化到 Footer 能用」翻面成「最小化已整体移除」的**回归闸**：谁再把
 * #ovMinBar / #ovPark / .ov-min-btn / ovMinimizeActive 那一套加回来，这里必红。
 *
 * 被测对象是真实源码，不是抄一份逻辑：
 *   renderer/index.html            没有 #ovMinBar / #ovPark / .ov-min-btn；✕ 仍在
 *   renderer/app.js                没有 ovMin* 任何定义与调用；OV_SHELL_HTML 只含 ✕；
 *                                  openOverlay 的 opts.min 只剩「给不给通用 ✕」一层语义
 *   renderer/css/components.css    没有 .ov-min-btn / .ov-minbar / .ov-min-tab / ovMin* 动效；
 *                                  ✕ 独占 margin-left:auto
 *   renderer/app-asr.js            语音模型窗的 asrDialogLive 照旧（不依赖最小化）
 *   renderer/i18n.js               「最小化到状态栏」词条已删，「关闭」中英成对
 * 覆盖：
 *   [1] 静态：DOM / 源码里最小化一套全无
 *   [2] 样式：最小化样式与动效全无，✕ 顶到最右
 *   [3] vm 真跑：窗壳只有 ✕ · 原地换窗 · opts.min=false 不给 ✕ · closeOverlay 收窗
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let fails = 0;
let checks = 0;
function ok(cond, msg) {
  checks++;
  if (cond) console.log("  ok    " + msg);
  else {
    fails++;
    console.log("FAIL  " + msg);
  }
}
const read = (rel) =>
  fs
    .readFileSync(path.join(__dirname, "..", rel.split("/").join(path.sep)), "utf8")
    .replace(/\r\n/g, "\n");
const html = read("renderer/index.html");
const app = read("renderer/app.js");
const asr = read("renderer/app-asr.js");
const css = read("renderer/css/components.css");
const i18n = read("renderer/i18n.js");

console.log("smoke-dialog-minimize：最小化已整体移除（只剩关闭）\n");

/* ============ [1] 静态：最小化一套全无 ============ */
console.log("[1] 静态：DOM 与源码里都没有最小化");
{
  ok(!/\sid="ovMinBar"/.test(html), "index.html 没有 #ovMinBar（Footer 页签排）");
  ok(!/class="ov-minbar"/.test(html), "index.html 没有 .ov-minbar");
  ok(!/\sid="ovPark"/.test(html), "index.html 没有 #ovPark（窗壳停放处）");
  ok(html.indexOf('class="ov-min-btn"') < 0, "index.html 初始窗壳里没有 .ov-min-btn");
  ok(html.indexOf('class="ov-close-btn"') > 0, "index.html 初始窗壳里仍有 .ov-close-btn（通用关闭）");
  ok(html.indexOf('id="ovTitle">设置</b><button type="button" class="ov-close-btn"') > 0, "✕ 仍是标题行里唯一那颗按钮");
  ok(/最小化[\s\S]{0,200}已整体移除/.test(html), "index.html 留了一句话说明最小化已移除（不是无声消失）");

  for (const name of ["ovMinimizeActive", "ovMinRestore", "ovMinDropAll", "ovMinDropWindow", "ovMinCancel", "ovMinBar", "ovMinPark", "ovMinSyncBar", "ovParkActiveBox", "ovBoxHasContent"]) {
    ok(app.indexOf("function " + name + "(") < 0, "app.js 不再定义 " + name);
  }
  ok(app.indexOf("let overlayMinimizable") < 0 && app.indexOf("overlayMinimizable") < 0, "app.js 没有 overlayMinimizable（旧的最小化开关）");
  ok(app.indexOf("const OV_MIN_MS") < 0, "app.js 没有 OV_MIN_MS（最小化动效时长）");
  ok(app.indexOf("_ovMinList") < 0 || !/const _ovMinList = /.test(app), "app.js 没有 _ovMinList（最小化清单）");
  ok(!/document\.getElementById\("ovMinBar"\)/.test(app) && !/getElementById\("ovPark"\)/.test(app), "app.js 不再去取 #ovMinBar / #ovPark");
  /* 窗壳模板与 index.html 同口径：只有 ✕ */
  const shell = app.slice(app.indexOf("const OV_SHELL_HTML ="), app.indexOf("/** 当前挂在 #overlay 上的窗壳 */"));
  ok(shell.indexOf("ov-min-btn") < 0 && shell.indexOf('class="ov-close-btn"') > 0, "OV_SHELL_HTML 只含 ✕（补壳不再带最小化按钮）");
  const openOv = app.slice(app.indexOf("function openOverlay("), app.indexOf("function closeOverlay("));
  ok(openOv.indexOf("overlayClosable = opts.min !== false;") > 0, "openOverlay：opts.min 只剩「给不给通用 ✕」");
  ok(openOv.indexOf("closeBtn.hidden = !overlayClosable") > 0, "openOverlay：✕ 按该开关显隐");
  ok(openOv.indexOf("ovMin") < 0, "openOverlay 里没有任何最小化 / 停放动作（原地换窗）");
  const closeOv = app.slice(app.indexOf("function closeOverlay("), app.indexOf("let _mtDialogSeq"));
  ok(closeOv.indexOf("ovShellBox()") > 0 && closeOv.indexOf('$("#overlay").style.display = "none"') > 0, "closeOverlay 仍是唯一收窗实现（✕ 复用同一条）");
  ok(app.indexOf("ovMinDropAll") < 0, "切画布 / loadWorkflow 里的 ovMinDropAll 调用已清掉");
  /* 语音模型窗的存活判定照旧（它跟最小化无关，只是历史注释里提过停放处） */
  ok(/function asrDialogLive\(/.test(asr), "app-asr.js 的 asrDialogLive 照旧在（不依赖最小化）");
  ok(asr.indexOf("ovPark") < 0, "app-asr.js 不再提 #ovPark");
  ok(i18n.indexOf('"最小化到状态栏"') < 0 && i18n.indexOf('"点击恢复到对话窗"') < 0, "i18n 的「最小化到状态栏 / 点击恢复到对话窗」词条已删");
  ok(i18n.indexOf('"关闭": "Close"') > 0, "i18n「关闭」中英仍成对");
}

/* ============ [2] 样式：最小化样式全无，✕ 顶到最右 ============ */
console.log("\n[2] 样式：最小化样式与动效全无");
{
  ok(!/\.overlay-head \.ov-min-btn/.test(css), "components.css 没有 .overlay-head .ov-min-btn");
  ok(!/\.ov-minbar/.test(css) && !/\.ov-min-tab/.test(css), "components.css 没有 .ov-minbar / .ov-min-tab");
  ok(!/ovMinOut|ovMinIn|ovTabIn/.test(css), "components.css 没有 ovMinOut / ovMinIn / ovTabIn 动效");
  ok(!/\.overlay-box\.ov-min-/.test(css), "components.css 没有 .overlay-box.ov-min-out / -in");
  const blocks = [...css.matchAll(/\.overlay-head \.ov-close-btn\s*\{([^}]*)\}/g)].map((m) => m[1]);
  ok(blocks.length >= 1 && blocks.some((b) => /margin-left:\s*auto/.test(b)), "✕ 独占 margin-left:auto（顶到标题行最右）");
  ok(/\.overlay-head \.ov-close-btn\[hidden\]\s*\{[^}]*display:\s*none/.test(css), "✕ 的 [hidden] 仍走 display:none");
}

/* ============ [3] vm 真跑：窗壳只有 ✕ / 原地换窗 ============ */
function mkEl(tag) {
  const el = {
    tagName: String(tag || "").toUpperCase(),
    id: "",
    style: {},
    dataset: {},
    hidden: false,
    children: [],
    parentNode: null,
    _cls: new Set(),
    _text: "",
    _h: {},
  };
  Object.defineProperty(el, "className", {
    get: () => [...el._cls].join(" "),
    set: (v) => {
      el._cls = new Set(String(v).split(/\s+/).filter(Boolean));
    },
  });
  el.classList = {
    add: (...c) => c.forEach((x) => el._cls.add(x)),
    remove: (...c) => c.forEach((x) => el._cls.delete(x)),
    contains: (c) => el._cls.has(c),
  };
  Object.defineProperty(el, "textContent", {
    get: () => el._text + el.children.map((c) => c.textContent).join(""),
    set: (v) => {
      el.children.length = 0;
      el._text = String(v == null ? "" : v);
    },
  });
  Object.defineProperty(el, "innerHTML", {
    get: () => "",
    set: (v) => {
      el.children.length = 0;
      el._text = "";
      parseInto(el, String(v));
    },
  });
  el.appendChild = (c) => {
    if (c.parentNode) c.parentNode.removeChild(c);
    c.parentNode = el;
    el.children.push(c);
    return c;
  };
  el.insertBefore = (c, ref) => {
    if (c.parentNode) c.parentNode.removeChild(c);
    c.parentNode = el;
    const i = el.children.indexOf(ref);
    if (i < 0) el.children.push(c);
    else el.children.splice(i, 0, c);
    return c;
  };
  el.removeChild = (c) => {
    const i = el.children.indexOf(c);
    if (i >= 0) el.children.splice(i, 1);
    c.parentNode = null;
    return c;
  };
  el.setAttribute = (k, v) => {
    if (k === "id") el.id = v;
  };
  el.getAttribute = (k) => (k === "id" ? el.id || null : null);
  el.removeAttribute = (k) => {
    if (k === "id") el.id = "";
  };
  el.addEventListener = (t, f) => {
    (el._h[t] = el._h[t] || []).push(f);
  };
  el.click = () => {
    const ev = { preventDefault() {}, stopPropagation() {} };
    (el._h.click || []).forEach((f) => f(ev));
    if (typeof el.onclick === "function") el.onclick(ev);
  };
  el.querySelector = (s) => qs(el, s);
  el.querySelectorAll = (s) => qsa(el, s);
  return el;
}
/* 极简 HTML 解析：只覆盖 index.html / OV_SHELL_HTML 那点结构（div / b / button / svg / path） */
function parseInto(host, src) {
  const re = /<\/?([a-zA-Z0-9]+)((?:\s+[^>]*?)?)(\/?)>/g;
  const stack = [host];
  let last = 0;
  let m;
  while ((m = re.exec(src))) {
    const text = src.slice(last, m.index);
    if (text.trim()) stack[stack.length - 1]._text += text;
    last = re.lastIndex;
    const tag = m[1].toLowerCase();
    if (m[0][1] === "/") {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const el = mkEl(tag);
    const attrs = m[2] || "";
    const idm = attrs.match(/\sid="([^"]*)"/);
    if (idm) el.id = idm[1];
    const cm = attrs.match(/\sclass="([^"]*)"/);
    if (cm) el.className = cm[1];
    stack[stack.length - 1].appendChild(el);
    if (m[3] !== "/" && tag !== "path" && tag !== "input" && tag !== "br") stack.push(el);
  }
}
function matchSimple(el, sel) {
  const idm = sel.match(/#([A-Za-z0-9_-]+)/);
  if (idm && el.id !== idm[1]) return false;
  const tagm = String(sel).match(/^([a-zA-Z][a-zA-Z0-9]*)/);
  if (tagm && el.tagName !== tagm[1].toUpperCase()) return false;
  return [...String(sel).matchAll(/\.([A-Za-z0-9_-]+)/g)].map((x) => x[1]).every((c) => el._cls.has(c));
}
function descAll(root) {
  const out = [];
  (function w(n) {
    n.children.forEach((c) => {
      out.push(c);
      w(c);
    });
  })(root);
  return out;
}
function qsa(root, sel) {
  let s = String(sel).trim();
  let pool;
  if (s.indexOf(":scope > ") === 0) {
    s = s.slice(9);
    pool = root.children.slice();
  } else {
    pool = descAll(root);
  }
  const parts = s.split(/\s+/);
  return pool.filter((el) => {
    if (!matchSimple(el, parts[parts.length - 1])) return false;
    let node = el.parentNode;
    for (let i = parts.length - 2; i >= 0; i--) {
      let hit = false;
      while (node) {
        if (matchSimple(node, parts[i])) {
          hit = true;
          break;
        }
        node = node.parentNode;
      }
      if (!hit) return false;
    }
    return true;
  });
}
function qs(root, sel) {
  return qsa(root, sel)[0] || null;
}

console.log("\n[3] vm 真跑：窗壳只有 ✕ · 原地换窗 · closeOverlay 收窗");
{
  const ROOT = mkEl("body");
  const footer = mkEl("footer");
  footer.className = "statusbar";
  ROOT.appendChild(footer);
  const overlay = mkEl("div");
  overlay.id = "overlay";
  overlay.style.display = "none";
  ROOT.appendChild(overlay);
  /* 初始窗壳：**照抄 index.html 的真实标记**（模板与页面失同步时这里必红） */
  const shellHtml = html.slice(
    html.indexOf('<div class="overlay-head"><b id="ovTitle">设置</b>'),
    html.indexOf('<div class="overlay-foot" id="ovFoot"></div>'),
  );
  const shell = mkEl("div");
  shell.className = "overlay-box";
  shell.innerHTML = shellHtml + '<div class="overlay-foot" id="ovFoot"></div>';
  overlay.appendChild(shell);
  const findByDom = (id) => descAll(ROOT).filter((e) => e.id === id)[0] || null;
  const DOC = {
    body: ROOT,
    createElement: (t) => mkEl(t),
    getElementById: (id) => findByDom(id),
    querySelector: (s) => qs(ROOT, s),
    querySelectorAll: (s) => qsa(ROOT, s),
  };
  const $ = (sel) =>
    String(sel).charAt(0) === "#" ? DOC.getElementById(String(sel).slice(1)) : DOC.querySelector(sel);
  const sandbox = {
    console,
    document: DOC,
    $,
    I18n: { t: (s) => String(s) },
    S: { thinkOpen: null },
    closeTplSubOverlay: () => {},
    setTimeout,
    clearTimeout,
  };
  const ctx = vm.createContext(sandbox);
  const seg = app.slice(app.indexOf("/* 弹窗 persistent 是全应用铁律"), app.indexOf("/* 独立于 #overlay 的深色确认"));
  try {
    vm.runInContext(seg, ctx, { filename: "app.js#overlay" });
    ok(true, "app.js 弹窗切片在沙箱中加载（无语法 / 顶层错误）");
  } catch (e) {
    ok(false, "切片加载失败：" + ((e && e.message) || e));
  }
  ok(shell.querySelector(".ov-min-btn") === null, "初始窗壳里没有最小化按钮");
  const footMinBar = descAll(footer).filter((e) => e.className.indexOf("ov-minbar") >= 0);
  ok(footMinBar.length === 0, "Footer 里没有页签排（连动态建的也没有）");

  ctx.openOverlay("设置 · APIs/Config", { persistent: true });
  ok(overlay.style.display === "flex", "openOverlay 打开窗");
  ok(shell.querySelector(".overlay-head b").textContent === "设置 · APIs/Config", "标题写进窗壳");
  const btn = shell.querySelector(".ov-close-btn");
  ok(!!btn && btn.dataset.wired === "1", "✕ 已接线（wired=1）");
  ok(btn.hidden === false, "默认开窗 ✕ 可见");
  ok(descAll(ROOT).filter((e) => e._cls.has("ov-min-tab")).length === 0, "开窗后也没有任何最小化页签");
  ok(vm.runInContext("typeof ovMinimizeActive", ctx) === "undefined", "沙箱里 ovMinimizeActive 已不存在（调用即报错，不会静默可用）");

  /* 原地换窗：连开两只仍是同一只壳，且#ovBody 已被清空重铺 */
  const bodyEl = shell.querySelector(".overlay-body");
  bodyEl.appendChild(mkEl("input"));
  ctx.openOverlay("确认画布修改", { persistent: true });
  ok(qsa(overlay, ":scope > .overlay-box").length === 1 && qs(overlay, ":scope > .overlay-box") === shell, "第二只窗原地接管同一只壳");
  ok(shell.querySelector(".overlay-body").children.length === 0, "旧窗内容当场清空（不再无损停放）");
  ok(shell.querySelector(".overlay-head b").textContent === "确认画布修改", "标题换成新窗的");
  ok(shell.querySelector(".ov-close-btn").hidden === false, "新窗的 ✕ 照旧可见");

  /* opts.min === false：阻塞式确认框不给通用 ✕ */
  ctx.openOverlay("提示", { min: false });
  ok(qs(overlay, ":scope > .overlay-box").querySelector(".ov-close-btn").hidden === true, "opts.min === false → ✕ 隐藏（出口只在窗内按钮）");
  ctx.openOverlay("提示", {});
  ok(qs(overlay, ":scope > .overlay-box").querySelector(".ov-close-btn").hidden === false, "下一次开窗 ✕ 恢复可见（不跨窗残留）");

  /* closeOverlay 仍是唯一收窗路径 */
  btn.click();
  ok(overlay.style.display === "none", "点 ✕ → closeOverlay 收窗");
  ok(shell.parentNode === overlay, "收窗不搬壳：仍挂在 #overlay 上（下一窗复用）");
  ok(descAll(ROOT).filter((e) => e._cls.has("ov-min-tab")).length === 0, "关窗后依旧没有任何页签残留");
}

console.log("\n" + (fails ? "FAILED " + fails + " / " + checks + " checks" : "ALL OK  " + checks + " checks"));
process.exit(fails ? 1 : 0);
