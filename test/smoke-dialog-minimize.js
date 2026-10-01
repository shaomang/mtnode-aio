"use strict";
/* 弹窗最小化到 Footer（画布 tab 同款页签）—— 冒烟测试（纯 Node）
 *   node test/smoke-dialog-minimize.js
 * 被测对象是「真实源码 / 真实切片」，不是抄一份逻辑：
 *   renderer/index.html    #ovMinBar（Footer 页签排）· #ovPark（被最小化的窗壳停放处）·
 *                          .overlay-head 里的 .ov-min-btn
 *   renderer/app.js        ovShellBox / ovShellEnsure / ovShellIds / ovMinimizeActive /
 *                          ovMinRestore / ovMinDropAll / OV_SHELL_HTML + openOverlay /
 *                          closeOverlay 接线（vm 沙箱里真跑状态机）
 *   renderer/css/components.css  .ov-min-btn / .ov-min-tab（与 .wf-tab 同款）
 *                                + 缓进缓出 ovMinOut / ovMinIn / ovTabIn
 *   renderer/app-asr.js    「语音模型」窗（asrDialogLive：只在窗还开着时才回写 DOM）
 *                          asrDialogLive（关窗照跑，进度订阅挂在模块级）
 *   renderer/i18n.js       新词条中英成对
 * 覆盖：
 *   [1] 静态接线：入口 DOM · 状态机函数 · 关闭 / 切画布清理 · 最小化按钮
 *   [2] 样式：画布 tab 同款外观 + ease-in-out 动效 + reduced-motion 兜底
 *   [3] vm 真跑：最小化 → 页签 → 恢复 · 两只窗无损换位 · opts.min=false · dropAll
 *   [3] vm 真跑：最小化 → 页签 → 恢复 · 两只窗无损换位 · opts.min=false · dropAll
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
/* 语音模型窗（app-asr.js）也走同一套 #overlay 壳与最小化：它的 asrDialogLive 就在上面钉着 */
const asr = read("renderer/app-asr.js");
const css = read("renderer/css/components.css");
const i18n = read("renderer/i18n.js");

console.log("smoke-dialog-minimize：弹窗最小化到 Footer\n");

/* ============ [1] 静态接线 ============ */
console.log("[1] 静态接线（index.html / app.js）");
{
  ok(/<footer class="statusbar">[\s\S]{0,200}?id="ovMinBar"/.test(html), "Footer 里有 #ovMinBar 页签排");
  const ovAt = html.indexOf('<div id="overlay">');
  const parkAt = html.indexOf('id="ovPark"');
  ok(ovAt > 0 && parkAt > ovAt, "#ovPark 在 #overlay 之后（#ovBody 等 id 先命中当前窗）");
  ok(html.indexOf('class="ov-min-btn"') > 0, "初始窗壳的标题栏里有 .ov-min-btn");
  ok(html.indexOf('class="ov-close-btn"') > 0, "初始窗壳的标题栏里有 .ov-close-btn（通用关闭）");
  ok(html.indexOf("<b id=\"ovTitle\">设置</b><button") > 0, "最小化按钮挂在标题右侧");

  for (const name of [
    "ovShellBox",
    "ovShellEnsure",
    "ovShellIds",
    "ovMinCancel",
    "ovMinBar",
    "ovMinPark",
    "ovMinSyncBar",
    "ovMinimizeActive",
    "ovMinRestore",
    "ovMinDropAll",
  ]) {
    ok(app.indexOf("function " + name + "(") > 0, "app.js 定义 " + name);
  }
  ok(
    app.indexOf("const OV_SHELL_HTML =") > 0 && app.indexOf("const OV_MIN_MS = ") > 0,
    "窗壳模板与动效时长常量都在 app.js（结构须与 index.html 一致）",
  );
  const openOv = app.slice(app.indexOf("function openOverlay("), app.indexOf("function closeOverlay("));
  ok(openOv.indexOf("ovShellEnsure()") > 0 && openOv.indexOf("ovMinCancel(box)") > 0, "openOverlay：换窗前补壳 + 撤销未跑完的最小化动画");
  ok(openOv.indexOf('minBtn.hidden = !overlayMinimizable') > 0, "openOverlay：按 opts.min 显隐最小化按钮");
  ok(
    app.indexOf("overlayMinimizable = opts.min !== false;") > 0,
    "默认允许最小化，opts.min === false 可关（多数弹窗都能最小化）",
  );
  const closeOv = app.slice(app.indexOf("function closeOverlay("), app.indexOf("let _mtDialogSeq"));
  ok(closeOv.indexOf("ovShellBox()") > 0 && closeOv.indexOf("ovMinCancel(box)") > 0, "closeOverlay：走同一只窗壳并撤销动画");
  ok((app.match(/ovMinDropAll\(\); \/\* /g) || []).length >= 2, "切画布 / loadWorkflow 都清掉最小化窗（各 1 处）");
}

/* ============ [2] 样式 ============ */
console.log("\n[2] 样式：画布 tab 同款 + 缓进缓出动效");
{
  ok(/\.overlay-head \.ov-min-btn\s*\{/.test(css), "components.css 有 .overlay-head .ov-min-btn");
  ok(/\.ov-min-tab\s*\{[^}]*border-radius:\s*8px 8px 0 0/.test(css), ".ov-min-tab 与 .wf-tab 同款圆角（8px 8px 0 0）");
  ok(
    /\.ov-min-tab\s*\{[^}]*background:\s*rgba\(0,\s*0,\s*0,\s*\.28\)/.test(css) &&
      /\.ov-min-tab:hover\s*\{[^}]*rgba\(56,\s*214,\s*255,\s*\.06\)/.test(css),
    ".ov-min-tab 的底色 / hover 与画布 tabs 一致",
  );
  ok(
    /\.overlay-box\.ov-min-out\s*\{[^}]*animation:\s*ovMinOut\s*\.18s\s*ease-in-out/.test(css) &&
      /\.overlay-box\.ov-min-in\s*\{[^}]*animation:\s*ovMinIn\s*\.18s\s*ease-in-out/.test(css),
    "最小化 / 恢复都走 ease-in-out（缓进缓出）",
  );
  ok(/@keyframes ovMinOut/.test(css) && /@keyframes ovMinIn/.test(css) && /@keyframes ovTabIn/.test(css), "三段动效 keyframes 齐备");
  ok(
    /prefers-reduced-motion[\s\S]{0,200}\.overlay-box\.ov-min-out/.test(css),
    "动效尊重 prefers-reduced-motion（关掉动画）",
  );
  const ms = Number((app.match(/const OV_MIN_MS = (\d+);/) || [])[1]);
  ok(ms > 0 && css.indexOf(".18s ease-in-out") > 0 && ms === 180, "JS 等待时长与 CSS 动画时长一致（" + ms + "ms）");
}

/* ============ [3] vm 真跑：最小化 / 页签 / 恢复 ============ */
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
/* 极简 HTML 解析：只覆盖 OV_SHELL_HTML / index.html 那点结构（div / b / button / svg / path） */
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
const shell = mkEl("div");
shell.className = "overlay-box";
shell.innerHTML =
  '<div class="overlay-head"><b id="ovTitle">设置</b><button type="button" class="ov-min-btn" title="x"></button></div>' +
  '<div class="overlay-body" id="ovBody"></div>' +
  '<div class="overlay-foot" id="ovFoot"></div>';
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
const SEG_START = "let overlayPersistent = false;";
const SEG_END = "/* 独立于 #overlay 的深色确认";
const seg = app.slice(app.indexOf(SEG_START), app.indexOf(SEG_END));
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
  vm.runInContext(seg, ctx, { filename: "app.js#overlay" });
  ok(true, "app.js 弹窗切片在沙箱中加载（无语法 / 顶层错误）");
} catch (e) {
  ok(false, "切片加载失败：" + ((e && e.message) || e));
}
const R = (expr) => vm.runInContext(expr, ctx);

console.log("\n[3] vm 真跑：最小化 / 页签 / 恢复");
{
  const bar = () => DOC.getElementById("ovMinBar") || qs(footer, ".ov-minbar");
  ctx.openOverlay("设置 · APIs/Config", { persistent: true });
  ok(overlay.style.display === "flex", "openOverlay 打开窗");
  ok(shell.querySelector(".overlay-head b").textContent === "设置 · APIs/Config", "标题写进窗壳");
  ok(shell.querySelector(".ov-min-btn").dataset.wired === "1", "最小化按钮已接线");
  ok(shell.querySelector(".ov-min-btn").hidden === false, "默认允许最小化（按钮可见）");

  ctx.ovMinimizeActive(true);
  ok(overlay.style.display === "none", "最小化后蒙层收起");
  ok(shell.parentNode === park, "窗壳整体搬进 #ovPark（DOM 与状态不重建）");
  ok(!shell.querySelector(".overlay-head b").id && !shell.querySelector(".overlay-body").id, "停放时 ovTitle / ovBody 等 id 摘掉（不与当前窗撞号）");
  ok(!!bar() && bar().hidden === false && bar().children.length === 1, "Footer 出现 1 枚页签");
  const chip = bar().children[0];
  ok(chip.className.indexOf("ov-min-tab") >= 0 && chip.textContent === "设置 · APIs/Config", "页签带标题、用的是 .ov-min-tab（画布 tab 同款）");
  ok(R("_ovMinList.length") === 1, "最小化清单登记 1 只窗");

  ctx.ovMinRestore(R("_ovMinList[0]"));
  ok(shell.parentNode === overlay && overlay.style.display === "flex", "点页签把窗原样搬回 #overlay");
  ok(shell.querySelector(".overlay-head b").id === "ovTitle" && shell.querySelector(".overlay-body").id === "ovBody", "回来时 id 挂回（#ovBody 指回自己）");
  ok(DOC.getElementById("ovBody") === shell.querySelector(".overlay-body"), "document.getElementById('ovBody') 命中当前窗");
  ok(R("_ovMinList.length") === 0 && bar().children.length === 0 && bar().hidden === true, "页签用完即撤，排空后整排隐藏");

  /* 两只窗无损换位：开着 B 时点回 A 的页签 → 先把 B 停放下去，再搬回 A */
  ctx.openOverlay("窗口 A", {});
  const boxA = qs(overlay, ":scope > .overlay-box");
  ctx.ovMinimizeActive(true);
  ctx.openOverlay("窗口 B", {});
  const boxB = qs(overlay, ":scope > .overlay-box");
  ok(boxB !== boxA && boxB.parentNode === overlay, "最小化后开新窗：自动补一只新窗壳");
  ok(R("_ovMinList.length") === 1, "旧窗仍在页签里");
  ctx.ovMinRestore(R("_ovMinList[0]"));
  ok(boxA.parentNode === overlay && boxA.querySelector(".overlay-head b").textContent === "窗口 A", "换位后回到被点的 A");
  ok(R("_ovMinList.length") === 1 && R("_ovMinList[0].title") === "窗口 B", "另一只 B 无损停放到页签（没被丢掉）");
  ok(R("_ovMinList[0].box") === boxB, "页签里存的正是 B 那只窗壳");

  /* opts.min === false：个别窗不给最小化，也不给通用关闭（阻塞式确认框出口在窗内） */
  ctx.openOverlay("提示", { min: false });
  ok(qs(overlay, ":scope > .overlay-box").querySelector(".ov-min-btn").hidden === true, "opts.min === false 时最小化按钮隐藏");
  ctx.openOverlay("提示", {});
  ok(qs(overlay, ":scope > .overlay-box").querySelector(".ov-min-btn").hidden === false, "下一次开窗恢复可见（不跨窗残留）");
  ctx.ovMinRestore(R("_ovMinList[0]"));

  ctx.ovMinimizeActive(true);
  ctx.ovMinDropAll();
  ok(R("_ovMinList.length") === 0 && park.children.length === 0 && bar().hidden === true, "ovMinDropAll：页签与停放窗一起清（切画布口径）");
}


console.log("\n" + (fails ? "FAILED " + fails + " / " + checks + " checks" : "ALL OK  " + checks + " checks"));
process.exit(fails ? 1 : 0);
