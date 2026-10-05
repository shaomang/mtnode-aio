"use strict";
/* test/smoke-node-copy-key.js — Ctrl+C / Ctrl+V 复制节点（本轮修 bug）回归
 * ============================================================================
 * 运行：node test/smoke-node-copy-key.js
 *
 * 钉住的需求（bug：点了节点之后 Ctrl+C 复制不出节点）：
 *   · 点选一颗浏览态文本节点会把焦点落进它自己的主输入框；此时按 Ctrl+C 必须仍复制「节点」，
 *     不能因为「焦点在输入框里」整条快捷键直接早退；
 *   · 画布 .fn-canvas 是 user-select:none、节点 / 空白 mousedown 又普遍 preventDefault，
 *     浏览器既不移焦点也不清选区 —— 画布之外的输入焦点与残留选区必须由画布点击显式放下，
 *     否则它们会一直挂着，Ctrl+C 永远轮不到复制节点；
 *   · 真有文字选区（画布之外的选区 / 画布里的输入控件 · 可复制文本区 · 文字标注）时，
 *     Ctrl+C / Ctrl+V 仍归浏览器原生，别抢；
 *   · 焦点在画布之外的输入区（会话 / 弹窗 / 设置…）同样归浏览器；
 *   · Ctrl+V：焦点在节点输入框里时，只有「最近一次复制的是节点」（nodeClipIsFresh）
 *     才粘贴节点，否则让编辑器粘贴文字；
 *   · Ctrl+V：画布焦点（非编辑区）时一律**消费按键**并交给 canvasPasteFromClipboard ——
 *     剪贴板里可能有图像（截图 / 复制的图片文件），要先读一次剪贴板才知道该弹询问窗、
 *     该粘节点，还是提示「粘贴板为空」，同步判定不出来（本轮的剪贴板图像需求）。
 *   · Ctrl+V 的落点是 canvasPasteFromClipboard，它开头就是 `if (S.view !== "workflow") return;`
 *     —— 所以 **boot 进画布视图时 S.view 必须落定**：app-boot 那句 setView 只给 agent / team 调，
 *     画布视图只补 body 类；漏了这一步 S.view 一直是 undefined，画布 Ctrl+V 被整条吃掉
 *     （本轮修的 bug：Ctrl+C 提示「已复制 N 个节点」，Ctrl+V 却毫无反应）。
 *
 * 口径：与 test/smoke-ref-keyboard.js 同一套路 —— 用 vm 从 renderer/app.js 里按名字抠出
 * **真实函数** 来跑（textSelectionWantsNativeCopy / canvasClipboardKey /
 * canvasPointerReleaseFocus），只桩外围（window / document / toast / I18n / 选中集 /
 * 复制粘贴出口），不桩被测逻辑；其余为只读的接线断言。
 * ============================================================================
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
    .replace(/\r\n?/g, "\n");
const has = (hay, needle, msg) =>
  ok(String(hay).indexOf(needle) >= 0, msg + (String(hay).indexOf(needle) >= 0 ? "" : "（缺 " + JSON.stringify(needle) + "）"));
const hasnt = (hay, needle, msg) =>
  ok(String(hay).indexOf(needle) < 0, msg + (String(hay).indexOf(needle) < 0 ? "" : "（仍含 " + JSON.stringify(needle) + "）"));

/* ---------- 从源码里抠出顶层函数体（不改动源文件；async 函数连 async 前缀一起抠） ---------- */
function fnBody(src, name) {
  const m = src.match(new RegExp("\\n(?:async )?function " + name + "\\s*\\(", "m"));
  if (!m) throw new Error("找不到函数：" + name);
  const at = m.index + 1;
  const i = src.indexOf("{", at);
  let depth = 0;
  let inStr = null;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    const p = src[j - 1];
    if (inStr) {
      if (c === inStr && p !== "\\") inStr = null;
      continue;
    }
    if (c === "/" && src[j + 1] === "/") {
      j = src.indexOf("\n", j);
      continue;
    }
    if (c === "/" && src[j + 1] === "*") {
      j = src.indexOf("*/", j + 2) + 1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") inStr = c;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (!depth) return src.slice(at, j + 1);
    }
  }
  throw new Error("函数体不完整：" + name);
}

const APP = read("renderer/app.js");
const BOOT = read("renderer/app-boot.js");

/* ---------- 迷你 DOM：只实现被测函数用到的那点选择器 ---------- */
function mkEl(o) {
  o = o || {};
  const el = {
    nodeType: 1,
    tagName: String(o.tag || "div").toUpperCase(),
    __cls: new Set(String(o.cls || "").split(/\s+/).filter(Boolean)),
    __attrs: o.attrs || {},
    parentElement: o.parent || null,
    isContentEditable: !!o.editable,
    blurred: 0,
    contains(n) {
      let p = n;
      while (p) {
        if (p === el) return true;
        p = p.parentElement;
      }
      return false;
    },
    closest(sel) {
      let p = el;
      while (p) {
        if (matchSel(p, sel)) return p;
        p = p.parentElement;
      }
      return null;
    },
    blur() {
      el.blurred++;
      if (ctx.document.activeElement === el) ctx.document.activeElement = ctx.document.body;
    },
  };
  return el;
}
function matchOne(el, part) {
  part = part.trim();
  if (!part) return false;
  const attr = part.match(/^\[([^=\]]+)="([^"]*)"\]$/);
  if (attr)
    return (
      Object.prototype.hasOwnProperty.call(el.__attrs, attr[1]) &&
      String(el.__attrs[attr[1]]) === attr[2]
    );
  if (part.charAt(0) === ".") return el.__cls.has(part.slice(1));
  return el.tagName === part.toUpperCase();
}
function matchSel(el, sel) {
  return String(sel)
    .split(",")
    .some((part) => matchOne(el, part));
}

const ctx = {
  console,
  toast: null,
  I18n: { t: (s) => s },
  window: null,
  document: null,
  currentSelection: () => [],
  selectedMarks: () => [],
  copyNodesToClipboard: () => {},
  pasteNodesFromClipboard: () => {},
};
ctx.document = {
  body: null,
  documentElement: null,
  activeElement: null,
};
const body = mkEl({ tag: "body" });
ctx.document.body = body;
ctx.document.documentElement = mkEl({ tag: "html" });
ctx.document.activeElement = body;
let selection = null;
ctx.window = {
  getSelection: () => selection,
};
vm.createContext(ctx);

/* 把真实源码里的常量与函数搬进沙箱（同一份实现，不抄第二份）；
   源码里缺函数（例如修复被回退）时如实判失败，不让异常掀掉整只测试。 */
let API = null;
let EDITABLE_SRC = "";
try {
  const constStart = APP.indexOf("const SELECTABLE_TEXT_HOSTS =");
  if (constStart < 0) throw new Error("找不到 SELECTABLE_TEXT_HOSTS");
  const constEnd = APP.indexOf(";", APP.indexOf(".mt-dialog", constStart));
  const HOSTS_SRC = APP.slice(constStart, constEnd + 1);
  /* 可编辑控件选择器也是被测函数的依赖（输入框选区判定 / 焦点归属判定共用一份） */
  const editStart = APP.indexOf("const EDITABLE_SEL =");
  if (editStart >= 0) {
    const editEnd = APP.indexOf(";", APP.indexOf('role="textbox"', editStart));
    EDITABLE_SRC = APP.slice(editStart, editEnd + 1);
  }
  const PRELUDE =
    HOSTS_SRC +
    "\n" +
    EDITABLE_SRC +
    "\nlet nodeClipboard = null;\nlet nodeClipIsFresh = false;\n" +
    /* S 只保留 canvasPasteFromClipboard 读的那一个字段（视图闸门） */
    "\nlet S = { view: \"workflow\" };\n";
  vm.runInContext(PRELUDE, ctx, { filename: "prelude.js" });
  vm.runInContext(
    fnBody(APP, "textSelectionWantsNativeCopy") +
      "\n" +
      fnBody(APP, "canvasClipboardKey") +
      "\n" +
      fnBody(APP, "canvasPointerReleaseFocus") +
      "\n" +
      fnBody(APP, "canvasPasteFromClipboard") +
      "\n" +
      "this.__api = {\n" +
      "  wantsNative: textSelectionWantsNativeCopy,\n" +
      "  clipKey: canvasClipboardKey,\n" +
      "  release: canvasPointerReleaseFocus,\n" +
      "  paste: canvasPasteFromClipboard,\n" +
      "  setSel: (a) => { selection = a; },\n" +
      "  setClip: (c) => { nodeClipboard = c; },\n" +
      "  setFresh: (v) => { nodeClipIsFresh = v; },\n" +
      "  fresh: () => nodeClipIsFresh,\n" +
      "};",
    ctx,
    { filename: "extracted.js" },
  );
  API = ctx.__api;
  ok(
    !!(API && API.wantsNative && API.clipKey && API.release && API.paste),
    "被测函数齐全：textSelectionWantsNativeCopy / canvasClipboardKey / canvasPointerReleaseFocus / canvasPasteFromClipboard",
  );
  ok(
    EDITABLE_SRC.indexOf("textarea") > 0 && EDITABLE_SRC.indexOf("contenteditable") > 0,
    "EDITABLE_SEL 可编辑控件选择器已随源码搬进沙箱（归属判定与选区判定同源）",
  );
} catch (e) {
  ok(false, "被测函数齐全（" + ((e && e.message) || e) + "）");
}

/* ---------- 测试侧的桩：选中集 / 复制粘贴出口 / 提示 ---------- */
let selNodes = [];
let selMarks = [];
let copiedCalls = 0;
let pasteCalls = 0;
let canvasPasteCalls = 0;
let toasts = [];
ctx.currentSelection = () => selNodes;
ctx.selectedMarks = () => selMarks;
ctx.copyNodesToClipboard = () => {
  copiedCalls++;
  vm.runInContext("nodeClipboard = { nodes: [{ id: 'n1' }], marks: [] };", ctx);
};
ctx.pasteNodesFromClipboard = () => {
  pasteCalls++;
};
/* 画布非编辑区的 Ctrl+V 统一走它（异步读剪贴板 → 询问窗 / 粘节点 / 空提示），这里只记调用 */
ctx.canvasPasteFromClipboard = () => {
  canvasPasteCalls++;
};
/* canvasPasteFromClipboard 自己的外围（本节只跑「剪贴板里没有图像」那条路） */
ctx.canvasPasteModalOpen = () => false;
ctx.clipboardImagesOfCanvas = async () => [];
ctx.clipboardImageCount = () => 0;
ctx.toast = (m) => toasts.push(String(m));

const selOf = (anchor, focus, collapsed) => ({
  isCollapsed: !!collapsed,
  anchorNode: anchor || null,
  focusNode: focus || anchor || null,
  __text: "选中文字",
  toString: () => "选中文字",
  removeAllRanges() {
    selection = { isCollapsed: true, anchorNode: null, focusNode: null, toString: () => "", removeAllRanges() {} };
  },
});
const noSel = () =>
  selOf(null, null, true);
function keyEvent(target) {
  const ev = {
    target: target,
    prevented: false,
    preventDefault() {
      ev.prevented = true;
    },
    stopPropagation() {},
  };
  return ev;
}
function resetState() {
  selNodes = [];
  selMarks = [];
  copiedCalls = 0;
  pasteCalls = 0;
  canvasPasteCalls = 0;
  toasts = [];
  selection = noSel();
  API.setClip(null);
  API.setFresh(false);
  ctx.document.activeElement = body;
  body.blurred = 0;
}
/* 让某个输入控件「自己有一段选区」：给它 selectionStart / selectionEnd 两个属性
   （真实 textarea 就有；光标停在某处时两者相等 = 没有选区）。传 null 收尾清理。 */
let lastFieldSel = null;
function withFieldSelection(el, start, end) {
  if (lastFieldSel && lastFieldSel !== el) {
    delete lastFieldSel.selectionStart;
    delete lastFieldSel.selectionEnd;
  }
  lastFieldSel = el || null;
  if (!el) return;
  el.selectionStart = start;
  el.selectionEnd = end;
}

console.log("── [1] 接线：Ctrl+C / Ctrl+V 的判定必须先于「输入中直接返回」");
{
  const atDispatch = APP.indexOf(
    'if (mod && !ev.altKey && !ev.shiftKey && (key === "c" || key === "v")) {',
  );
  const atInField = APP.indexOf("    if (inField) return;");
  ok(atDispatch > 0, "keydown 里有 Ctrl+C / Ctrl+V 的专属入口");
  ok(
    atDispatch > 0 && atInField > 0 && atDispatch < atInField,
    "入口排在 `if (inField) return;` 之前（否则点完节点复制不了节点）",
  );
  has(
    APP,
    "if (canvasClipboardKey(ev, key, inField)) return;",
    "入口把归属判定交给 canvasClipboardKey",
  );
  hasnt(
    APP,
    'if (!copyNodesToClipboard())\n        toast(I18n.t("请先选中节点或绘制"), "warn");',
    "旧的 Ctrl+C 早退块已删除（有选区就 return 的那段）",
  );
  hasnt(
    APP,
    "assistPane.contains(document.activeElement)",
    "旧的「焦点在助手栏就整条早退」判据已去掉（改由 inField / 画布输入框分流）",
  );
  ok(
    (APP.match(/const SELECTABLE_TEXT_HOSTS/g) || []).length === 1,
    "SELECTABLE_TEXT_HOSTS 全文件只有一处定义（Ctrl+A 与 Ctrl+C/V 同源）",
  );
  has(APP, 'document.addEventListener("copy", () => {', "文字复制（copy 事件）会复位节点粘贴板标记");
  has(APP, 'window.addEventListener("blur", () => {', "切走窗口会复位节点粘贴板标记");
  has(APP, "function watchTextCopyOutlets()", "应用自己的「复制文字」出口被包了一层（writeText 不触发 copy 事件）");
  has(
    APP,
    'document.addEventListener("mousedown", canvasPointerReleaseFocus, true);',
    "画布 mousedown（捕获段）接线了焦点 / 选区释放",
  );
}

console.log("── [2] textSelectionWantsNativeCopy：什么算「真要复制的文字」");
if (API) {
  const canvas = mkEl({ tag: "div", cls: "fn-canvas" });
  const node = mkEl({ tag: "div", cls: "wf-node", parent: canvas });
  const title = mkEl({ tag: "div", cls: "n-title", parent: node });
  const mkText = mkEl({ tag: "div", cls: "mk-text", parent: canvas, editable: true, attrs: { contenteditable: "true" } });
  const out = mkEl({ tag: "div", cls: "n-out", parent: node });
  const ta = mkEl({ tag: "textarea", cls: "n-text", parent: node });
  const topbar = mkEl({ tag: "div", cls: "topbar" });

  resetState();
  selection = noSel();
  ok(API.wantsNative() === false, "没有选区 → 不是文字复制");

  resetState();
  selection = selOf(title, title, true);
  ok(API.wantsNative() === false, "选区是折叠的 → 不是文字复制");

  resetState();
  selection = selOf(title, title, false);
  ok(API.wantsNative() === false, "画布内、落在不可选中的节点元素上（陈旧残留选区）→ 不挡复制节点");

  resetState();
  selection = selOf(mkText, mkText, false);
  ok(API.wantsNative() === true, "画布文字标注 .mk-text 里的选区 → 交给浏览器");

  resetState();
  selection = selOf(out, out, false);
  ok(API.wantsNative() === true, "节点输出区 .n-out 里的选区 → 交给浏览器");

  resetState();
  selection = selOf(ta, ta, false);
  ok(API.wantsNative() === true, "输入控件（textarea）里的选区 → 交给浏览器");

  resetState();
  selection = selOf(topbar, topbar, false);
  ok(API.wantsNative() === true, "画布之外的选区 → 交给浏览器");

  /* 本轮 bug：输入框自己选中的那一段（window.getSelection 看不到，段落里甚至整个折叠） */
  const field = mkEl({ tag: "textarea", cls: "tb-wfname" });
  resetState();
  ctx.document.activeElement = field;
  withFieldSelection(field, 0, 6);
  ok(API.wantsNative() === true, "输入框自己的选区（拖选一段）→ 算「真要复制的文字」");
  withFieldSelection(field, 3, 3);
  ok(API.wantsNative() === false, "输入框里光标停在某处（没选字）→ 不算文字复制");
  withFieldSelection(null, 0, 0);
}

console.log("── [3] canvasClipboardKey：这次 Ctrl+C / Ctrl+V 归谁");
if (API) {
  const canvas = mkEl({ tag: "div", cls: "fn-canvas" });
  const node = mkEl({ tag: "div", cls: "wf-node", parent: canvas });
  const nodeField = mkEl({ tag: "textarea", cls: "n-text", parent: node });
  const foreign = mkEl({ tag: "textarea", cls: "chat-input" });
  const mkText = mkEl({ tag: "div", cls: "mk-text", parent: canvas, editable: true, attrs: { contenteditable: "true" } });

  /* 画布焦点 + 有选中节点 → 复制节点 */
  resetState();
  selNodes = [{}];
  ctx.document.activeElement = body;
  let ev = keyEvent(body);
  let consumed = API.clipKey(ev, "c", false);
  ok(consumed === true && ev.prevented === true, "画布焦点按 Ctrl+C：消费按键并拦默认");
  ok(copiedCalls === 1, "确实调了 copyNodesToClipboard");
  ok(API.fresh() === true, "复制成功后标记「节点粘贴板是最新一次复制」");

  /* 本轮 bug：焦点在画布节点的输入框里 */
  resetState();
  selNodes = [{}];
  ctx.document.activeElement = nodeField;
  ev = keyEvent(nodeField);
  consumed = API.clipKey(ev, "c", true);
  ok(consumed === true, "焦点在节点自己的输入框里（inField）按 Ctrl+C：仍然复制节点");
  ok(copiedCalls === 1, "没有因为「输入中」整条早退");

  /* 画布之外的输入区：让给浏览器 */
  resetState();
  selNodes = [{}];
  ctx.document.activeElement = foreign;
  ev = keyEvent(foreign);
  consumed = API.clipKey(ev, "c", true);
  ok(consumed === false && copiedCalls === 0, "焦点在画布之外的输入区（会话 / 弹窗）：交给浏览器原生复制");

  /* 画布文字标注编辑中：让给浏览器 */
  resetState();
  selNodes = [{}];
  ctx.document.activeElement = mkText;
  ev = keyEvent(mkText);
  consumed = API.clipKey(ev, "c", true);
  ok(consumed === false && copiedCalls === 0, "画布文字标注（.mk-text 富文本）编辑中：交给浏览器");

  /* 真有文字选区：让给浏览器，并把粘贴板标记改成「文字」 */
  resetState();
  selNodes = [{}];
  API.setFresh(true);
  const outEl = mkEl({ tag: "div", cls: "n-out", parent: node });
  selection = selOf(outEl, outEl, false);
  ev = keyEvent(body);
  consumed = API.clipKey(ev, "c", false);
  ok(consumed === false && copiedCalls === 0, "有文字选区时 Ctrl+C 不抢（交给浏览器）");
  ok(API.fresh() === false, "文字复制后节点粘贴板标记复位");

  /* Ctrl+V：画布焦点（非编辑区）→ 一律消费按键，交给 canvasPasteFromClipboard
     （剪贴板里可能有图像，要先读一次剪贴板才知道该弹询问窗还是粘节点） */
  resetState();
  ev = keyEvent(body);
  consumed = API.clipKey(ev, "v", false);
  ok(
    consumed === true && ev.prevented === true && canvasPasteCalls === 1,
    "画布焦点 + Ctrl+V：消费按键并交给 canvasPasteFromClipboard（异步判定图像 / 节点 / 空）",
  );
  ok(
    pasteCalls === 0 && toasts.length === 0,
    "判定前不抢着粘节点、也不抢先报「粘贴板为空」（都移到 canvasPasteFromClipboard 里）",
  );

  /* Ctrl+V：节点输入框里 → 一律归浏览器原生粘贴（本轮改的口径：画布不再把「最近复制过节点」
     当成要粘节点的信号；复制的节点只在画布非编辑区 Ctrl+V 时粘贴） */
  resetState();
  API.setClip({ nodes: [{ id: "n1" }], marks: [] });
  API.setFresh(true);
  ctx.document.activeElement = nodeField;
  ev = keyEvent(nodeField);
  consumed = API.clipKey(ev, "v", true);
  ok(
    consumed === false && pasteCalls === 0 && canvasPasteCalls === 0,
    "节点输入框里按 Ctrl+V：归浏览器原生粘贴纯文本（不再抢去粘节点）",
  );

  /* Ctrl+V：焦点漂到 BODY（画布重绘后常见）但事件目标是输入框 → 仍要归原生粘贴 */
  resetState();
  API.setClip({ nodes: [{ id: "n1" }], marks: [] });
  API.setFresh(true);
  ctx.document.activeElement = body;
  ev = keyEvent(nodeField);
  consumed = API.clipKey(ev, "v", true);
  ok(
    consumed === false && pasteCalls === 0 && canvasPasteCalls === 0,
    "焦点漂到 BODY 时在输入框里 Ctrl+V：不再被画布吃掉（本轮修的 bug）",
  );

  /* Ctrl+C：焦点漂到 BODY（画布重绘后常见）但页面上没有输入焦点 → 画布仍要复制节点，
     不能因为 activeElement 是 <body> 就以为「没有焦点」。 */
  resetState();
  selNodes = [{}];
  ctx.document.activeElement = body;
  ev = keyEvent(body);
  consumed = API.clipKey(ev, "c", false);
  ok(
    consumed === true && copiedCalls === 1,
    "画布空白 / 页面空白聚焦时 Ctrl+C：照旧复制节点",
  );

  /* 本轮 bug 的正面口径：顶栏一类「画布之外的输入框」拿到焦点时，Ctrl+C / Ctrl+V 都归原生 ——
     即使 ev.target 被报成 <body>（focusEl 取 activeElement 而不是 ev.target） */
  resetState();
  selNodes = [{}];
  const nameInput = mkEl({ tag: "input", cls: "tb-wfname" });
  ctx.document.activeElement = nameInput;
  ev = keyEvent(body);
  consumed = API.clipKey(ev, "c", true);
  ok(
    consumed === false && copiedCalls === 0,
    "画布外输入框聚焦（哪怕 ev.target 是 body）：Ctrl+C 归原生，不再被画布吃掉",
  );
  ev = keyEvent(body);
  consumed = API.clipKey(ev, "v", true);
  ok(consumed === false && canvasPasteCalls === 0, "同一情形下 Ctrl+V 也归原生");

  /* Ctrl+V：画布焦点 + 有节点粘贴板 → 同样交给 canvasPasteFromClipboard（由它按剪贴板定夺） */
  resetState();
  API.setClip({ nodes: [{ id: "n1" }], marks: [] });
  ev = keyEvent(body);
  consumed = API.clipKey(ev, "v", false);
  ok(
    consumed === true && canvasPasteCalls === 1,
    "画布焦点按 Ctrl+V：交给入口（剪贴板里没图像时由它粘贴节点）",
  );
}

console.log("── [4] canvasPointerReleaseFocus：画布按下鼠标要把旧的输入焦点 / 残留选区放下");
if (API) {
  const canvas = mkEl({ tag: "div", cls: "fn-canvas" });
  const node = mkEl({ tag: "div", cls: "wf-node", parent: canvas });
  const nodeField = mkEl({ tag: "textarea", cls: "n-text", parent: node });
  const foreign = mkEl({ tag: "textarea", cls: "chat-input" });
  const topbar = mkEl({ tag: "div", cls: "topbar" });

  /* 画布之外的输入框持有焦点 + 页面上还留着选区 → 点画布节点：全部放下 */
  resetState();
  ctx.document.activeElement = foreign;
  selection = selOf(topbar, topbar, false);
  let changed = API.release({ target: node });
  ok(changed === true, "点画布节点：报告「放下了什么」");
  ok(foreign.blurred === 1, "画布之外的输入框被 blur（焦点不再被它吃掉 Ctrl+C）");
  ok(selection.isCollapsed === true, "页面上残留的文字选区被清掉");

  /* 点的是「正在编辑的那颗节点内部」：不打断 */
  resetState();
  ctx.document.activeElement = nodeField;
  changed = API.release({ target: nodeField });
  ok(nodeField.blurred === 0, "点自己所在的节点内部：不 blur（就地打字不打断）");

  /* 画布之外的点击根本不进这条判据 */
  resetState();
  foreign.blurred = 0;
  ctx.document.activeElement = foreign;
  changed = API.release({ target: topbar });
  ok(changed === false && foreign.blurred === 0, "点画布之外（顶栏 / 弹窗）：不动焦点");
}

/* [5] 的落点是异步函数（canvasPasteFromClipboard 要先读一次剪贴板），收尾与总结一并放进异步尾巴，
     否则「复制节点后粘不出来」这条正好会在同步总结之后才判出来。 */
(async () => {
  console.log(
    "── [5] boot 进画布视图时 S.view 必须落定（否则 canvasPasteFromClipboard 早退，Ctrl+V 静默失效）",
  );
  /* 接线：boot 那句 setView 只给 agent / team 调，画布视图必须自己把 S.view 落下来 */
  const atBootView = BOOT.indexOf("const bootView =");
  const atAssign = BOOT.indexOf("S.view = bootView;");
  ok(atBootView > 0, "app-boot.js 里有 bootView（(S.config && S.config.view) || \"workflow\"）");
  ok(
    atAssign > atBootView,
    "bootView 算出来之后立刻落定 S.view（画布视图不调 setView，漏了这句 S.view 一直是 undefined）",
  );
  has(
    BOOT,
    'if (bootView === "agent" || bootView === "team") setView(bootView);',
    "agent / team 的 boot 仍走 setView（视图切换收口不变，画布视图不多跑一遍 renderCanvas）",
  );
  has(
    APP,
    'if (S.view !== "workflow") return;',
    "canvasPasteFromClipboard 的视图闸门仍在（会话 / 团队视图里 Ctrl+V 不动画布）",
  );

  /* 行为：把真函数搬进沙箱，用 S.view 的三种取值各跑一次 */
  if (API) {
    const setView = (v) =>
      vm.runInContext(
        v === undefined ? "delete S.view;" : "S.view = " + JSON.stringify(v) + ";",
        ctx,
      );
    API.setClip({ nodes: [{ id: "n1" }], marks: [] });
    setView("workflow");
    pasteCalls = 0;
    await API.paste();
    ok(pasteCalls === 1, "S.view=\"workflow\"（boot 进画布后的取值）：Ctrl+V 真的去粘节点");
    setView("agent");
    pasteCalls = 0;
    await API.paste();
    ok(pasteCalls === 0, "S.view=\"agent\"：不粘画布（会话视图里 Ctrl+V 不动画布）");
    setView(undefined);
    pasteCalls = 0;
    await API.paste();
    ok(
      pasteCalls === 0,
      "S.view 没落定：直接早退 —— 这就是本轮修的 bug 现场（复制有提示、粘贴没反应），所以 boot 必须落定它",
    );
  }

  console.log("");
  if (fails) {
    console.log("✗ " + fails + " / " + checks + " 项失败");
    process.exit(1);
  }
  console.log("✓ 全部 " + checks + " 项通过");
})();
