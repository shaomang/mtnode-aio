"use strict";
/* 弹窗通用关闭（✕）—— 冒烟测试（纯 Node）
 *   node test/smoke-dialog-close.js
 * 需求：**后续所有打开的 dialogue 都要有关闭选项**（起因：长周期任务「修改任务链」窗
 *       只有最小化 / 稍后，用户找不到关窗的地方）。
 * 被测对象是「真实源码 / 真实切片」，不是抄一份逻辑：
 *   renderer/index.html          #overlay 初始窗壳标题栏里的 .ov-close-btn
 *   renderer/app.js              OV_SHELL_HTML / ovShellEnsure 接线 / openOverlay 的
 *                                opts.min === false 口径 / closeOverlay 真跑（vm 沙箱）
 *   renderer/css/components.css  .overlay-head .ov-close-btn（与 .ov-min-btn 同尺寸同风格）
 *   renderer/i18n.js             「关闭」中英成对
 *   renderer/app-longtask-edit.js 任务链修改窗补显式「关闭」（走 lteLater 收口）
 * 覆盖：
 *   [1] 静态接线：窗壳两处结构一致 · wired 接线 · 显隐口径 · 样式 · 词条
 *   [2] vm 真跑：开窗 → 点 ✕ → 关窗；最小化停放 → 补壳 → ✕ 仍在；恢复后 ✕ 关得掉；
 *       opts.min === false 不给 ✕
 *   [3] 任务链修改窗：显式关闭按钮 + 收口走 lteLater
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
const css = read("renderer/css/components.css");
const i18n = read("renderer/i18n.js");
const lte = read("renderer/app-longtask-edit.js");
/* 切片：openOverlay 之前是窗壳状态机（OV_SHELL_HTML / ovShellEnsure / ovMin*），
   到 emoji 深色确认框为止（与 smoke-dialog-minimize 同一切法）。 */
const overlaySeg = app.slice(app.indexOf("/* 弹窗 persistent 是全应用铁律"), app.indexOf("/* 独立于 #overlay 的深色确认"));

console.log("smoke-dialog-close：每只 #overlay 弹窗的通用关闭（✕）\n");

/* ============ [1] 静态接线 ============ */
console.log("[1] 静态接线（index.html / app.js / css / i18n）");
{
  ok(html.indexOf('class="ov-close-btn"') > 0, "index.html 初始窗壳标题栏里有 .ov-close-btn");
  ok(/class="ov-close-btn"[^>]*title="关闭"[^>]*aria-label="关闭"/.test(html), "✕ 带「关闭」title / aria-label（可读、可点）");
  ok(html.indexOf('class="ov-min-btn"') < html.indexOf('class="ov-close-btn"'), "✕ 排在最小化按钮之后（右上角两颗方钮）");
  ok(html.indexOf('id="ovTitle">设置</b><button type="button" class="ov-min-btn"') > 0, "标题 → 最小化 →  的结构没被拆散");
  const closeBlocks = // 把 .ov-close-btn 的规则块逐条取出来（不能拿全文正则会误伤注释）
    [...css.matchAll(/\.overlay-head \.ov-close-btn\s*\{([^}]*)\}/g)].map((m) => m[1]);
  ok(closeBlocks.length >= 1, "components.css 有 .ov-close-btn 规则块");
  ok(!closeBlocks.some((b) => /margin-left/.test(b)), "✕ 不抢 margin-left:auto（auto 归最小化那颗，✕ 紧贴它）");

  const shell = app.slice(app.indexOf("const OV_SHELL_HTML ="), app.indexOf("let _ovMinSeq = 0"));
  ok(shell.indexOf('class="ov-close-btn"') > 0, "OV_SHELL_HTML（补壳模板）里也有 ✕");
  ok(shell.indexOf('I18n.t("关闭")') > 0, "补壳模板的 ✕ 文案走 i18n（不写死中文）");
  ok(shell.indexOf('class="ov-min-btn"') < shell.indexOf('class="ov-close-btn"'), "补壳模板里 ✕ 同样排在最小化之后");
  /* 两处窗壳（index.html 的初始壳 + app.js 的补壳模板）必须成对出现：少一处就是「有的窗没有 ✕」 */
  for (const [file, src, label] of [
    ["index.html", html, "初始窗壳"],
    ["app.js", shell, "补壳模板"],
  ]) {
    ok(
      src.indexOf('class="ov-min-btn"') > 0 && src.indexOf('class="ov-close-btn"') > 0,
      file + " 的" + label + "最小化 + 关闭两颗方钮齐备",
    );
  }

  const ensure = app.slice(app.indexOf("function ovShellEnsure("), app.indexOf("/** 停放时摘 id"));
  ok(ensure.indexOf('box.querySelector(".ov-close-btn")') > 0, "ovShellEnsure：补壳时就地取 ✕");
  ok(ensure.indexOf("closeBtn.dataset.wired") > 0, "✕ 只挂一次监听（wired 幂等，停放 / 恢复不重复挂）");
  ok(/closeBtn\.addEventListener\(\s*"click"/.test(ensure) || /closeBtn\.addEventListener\("click"/.test(ensure), "✕ 点按有监听");
  ok(ensure.indexOf("closeOverlay();") > 0, "✕ 只走 closeOverlay（不改蒙层 / 不挂点外部即关）");
  ok(ensure.indexOf("ovMinimizeActive()") > 0, "最小化那颗仍走 ovMinimizeActive（两颗各管各的）");

  const openOv = app.slice(app.indexOf("function openOverlay("), app.indexOf("function closeOverlay("));
  ok(openOv.indexOf('minBtn.hidden = !overlayMinimizable') > 0, "openOverlay：最小化按 opts.min 显隐");
  ok(openOv.indexOf('closeBtn.hidden = !overlayMinimizable') > 0, "openOverlay：✕ 同一档显隐（min:false 的阻塞框不给通用关闭）");

  const closeOv = app.slice(app.indexOf("function closeOverlay("), app.indexOf("let _mtDialogSeq"));
  ok(closeOv.indexOf("ovShellBox()") > 0 && closeOv.indexOf('$("#overlay").style.display = "none"') > 0, "closeOverlay 仍是唯一收窗实现（✕ 复用同一条）");
  ok(closeOv.indexOf("closeNodePopsExcept") < 0, "closeOverlay 不新挂任何点外部 / 点蒙层监听");

  ok(/\.overlay-head \.ov-close-btn\s*\{/.test(css), "components.css 有 .overlay-head .ov-close-btn");
  ok(/\.overlay-head \.ov-close-btn\s*\{[^}]*width:\s*20px[^}]*height:\s*20px/.test(css), "✕ 与最小化同尺寸（20×20）");
  ok(/\.overlay-head \.ov-close-btn:hover\s*\{/.test(css), "✕ 有 hover 态（可辨识）");
  ok(/\.overlay-head \.ov-close-btn\[hidden\]\s*\{[^}]*display:\s*none/.test(css), "✕ 的 [hidden] 走 display:none（不跨窗残留 / 不占位）");

  ok(i18n.indexOf('"关闭": "Close"') > 0, "i18n「关闭」中英成对");
}

/* ============ [2] vm 真跑：点 ✕ 关窗 ============ */
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
  Object.defineProperty(el, "firstChild", { get: () => el.children[0] || null });
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

const ROOT = mkEl("body");
const footer = mkEl("footer");
footer.className = "statusbar";
ROOT.appendChild(footer);
const overlay = mkEl("div");
overlay.id = "overlay";
overlay.style.display = "none";
ROOT.appendChild(overlay);
const park = mkEl("div");
park.id = "ovPark";
park.hidden = true;
ROOT.appendChild(park);
/* 初始窗壳：**照抄 index.html 的真实标记**（不是自己另写一份），这样模板与页面失同步时必红 */
const shellHtml = html.slice(
  html.indexOf('<div class="overlay-head"><b id="ovTitle">设置</b>'),
  html.indexOf('<div class="overlay-foot" id="ovFoot"></div>'),
);
ok(shellHtml.indexOf("ov-close-btn") > 0, "从 index.html 切出真实窗壳标记（含 ✕）");
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
function $(sel) {
  return String(sel).charAt(0) === "#" ? DOC.getElementById(String(sel).slice(1)) : DOC.querySelector(sel);
}
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
try {
  vm.runInContext(overlaySeg, ctx, { filename: "app.js#overlay" });
  ok(true, "app.js 弹窗切片在沙箱中加载（无语法 / 顶层错误）");
} catch (e) {
  ok(false, "切片加载失败：" + ((e && e.message) || e));
}
const R = (expr) => vm.runInContext(expr, ctx);

console.log("\n[2] vm 真跑：点  关窗（真跑 closeOverlay）");
{
  ctx.openOverlay("设置 · APIs/Config", { persistent: true });
  ok(overlay.style.display === "flex", "开窗后蒙层可见");
  const btn = shell.querySelector(".ov-close-btn");
  ok(!!btn && btn.dataset.wired === "1", "✕ 已接线（wired=1）");
  ok(btn.hidden === false, "默认开窗时 ✕ 可见");
  btn.click();
  ok(overlay.style.display === "none", "点  → 关窗（closeOverlay 真跑）");
  ok(shell.parentNode === overlay, "关窗不搬壳：仍挂在 #overlay 上（下一窗复用）");

  /* 最小化停放 → 补壳：新壳的 ✕ 也必须可用 */
  ctx.openOverlay("窗口 A", {});
  ctx.ovMinimizeActive(true);
  ctx.openOverlay("窗口 B", {});
  const boxB = qs(overlay, ":scope > .overlay-box");
  ok(boxB !== shell, "最小化后开新窗：照 OV_SHELL_HTML 补了一只新壳");
  const btnB = boxB.querySelector(".ov-close-btn");
  ok(!!btnB && btnB.dataset.wired === "1", "补壳里的 ✕ 同样接线（模板没漏 ✕）");
  btnB.click();
  ok(overlay.style.display === "none", "补壳的 ✕ 也关得掉窗");

  /* 恢复停放的窗 → ✕ 仍认它 */
  ctx.ovMinRestore(R("_ovMinList[0]"));
  ok(overlay.style.display === "flex", "点页签把窗口 A 搬回来");
  shell.querySelector(".ov-close-btn").click();
  ok(overlay.style.display === "none", "恢复后的 ✕ 关掉的正是这只窗");

  /* opts.min === false：阻塞式确认框不给通用关闭 */
  ctx.openOverlay("提示", { min: false });
  const boxC = qs(overlay, ":scope > .overlay-box");
  ok(boxC.querySelector(".ov-close-btn").hidden === true, "opts.min === false → ✕ 隐藏（出口只在窗内按钮）");
  ctx.openOverlay("提示", {});
  ok(boxC.querySelector(".ov-close-btn").hidden === false, "下一次开窗 ✕ 恢复可见（不跨窗残留）");
  boxC.querySelector(".ov-close-btn").click();
  ok(overlay.style.display === "none", "普通窗的 ✕ 收窗");
}

/* ============ [3] 任务链修改窗：显式关闭 + 收口 ============ */
console.log("\n[3] 任务链修改窗（app-longtask-edit.js）：补显式关闭");
{
  ok(lte.indexOf('getElementById("ovFoot")') > 0, "本窗往 #ovFoot 补按钮");
  ok(lte.indexOf('lteT("关闭")') > 0, "有「关闭」按钮文案");
  ok(/foot\.appendChild\(\s*lteBtn\(lteT\("关闭"\), "lt-btn", \(\) => lteLater\(\)/.test(lte), "「关闭」走 lteLater（关窗前把这条修改会话落盘）");
  ok(lte.indexOf("function lteLater(") > 0 && lte.indexOf("persistAgentSession()") > 0, "lteLater 仍负责会话落盘（不另造收口）");
  ok(lte.indexOf('lteT("稍后")') > 0, "「稍后」出口保留（快捷出口不删）");
  ok((lte.match(/closeOverlay\(\)/g) || []).length >= 1, "关窗仍只走 closeOverlay（没有第二套收窗实现）");
}

console.log("\n" + (fails ? "✗ " + fails + " / " + checks + " 项失败" : "✓ 全部 " + checks + " 项通过"));
process.exit(fails ? 1 : 0);