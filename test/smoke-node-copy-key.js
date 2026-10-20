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
 *   · 粘贴落点 = 鼠标指针（node-copy-paste-at-pointer）：粘贴集包围盒**左上角**贴到指针的
 *     世界坐标（吸附网格）；指针没进过画布 / 已不在画布上时才退回旧的「视口中心」。
 *     指针位置由 bindCanvas 的 mousemove 记屏幕坐标（pasteDropPoint 换算），滚轮缩放 /
 *     中键平移都不必重记。
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
    "\nlet nodeClipboard = null;\nlet nodeClipIsFresh = false;\nlet nodeClipAt = 0;\n" +
    "\nconst NODE_PASTE_WINDOW_MS = 120000;\n" +
    /* S 只保留 canvasPasteFromClipboard 读的那一个字段（视图闸门） */
    "\nlet S = { view: \"workflow\" };\n";
  vm.runInContext(PRELUDE, ctx, { filename: "prelude.js" });
  vm.runInContext(
    fnBody(APP, "markNodeClipFresh") +
      "\n" +
      fnBody(APP, "markNodeClipStale") +
      "\n" +
      fnBody(APP, "nodeClipPasteWanted") +
      "\n" +
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
      "  pasteWanted: nodeClipPasteWanted,\n" +
      "  markStale: markNodeClipStale,\n" +
      "  setSel: (a) => { selection = a; },\n" +
      "  setClip: (c) => { nodeClipboard = c; },\n" +
      "  setFresh: (v) => { nodeClipIsFresh = v; if (v) nodeClipAt = Date.now(); },\n" +
      "  ageClip: (ms) => { nodeClipAt = Date.now() - Number(ms || 0); },\n" +
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
  /* 本轮修的 bug：输入框里「一律让给编辑器」废掉了「点节点 → Ctrl+C → Ctrl+V」。
     口径收口在 nodeClipPasteWanted（标记热乎 + 粘贴板里确有节点 / 绘制）。 */
  has(APP, "function nodeClipPasteWanted()", "粘贴归属收口在 nodeClipPasteWanted（节点粘贴板是不是刚复制的节点）");
  has(APP, "function markNodeClipFresh()", "复制节点成功即打「热乎」标记（含时刻）");
  has(APP, "function markNodeClipStale()", "文字复制 / 切窗口把标记打陈旧（唯一的复位口）");
  has(
    APP,
    "if (!inCanvasField || !nodeClipPasteWanted()) return false;",
    "节点输入框里 Ctrl+V：只有「刚复制过节点」才粘节点，否则归原生粘贴文字",
  );
  hasnt(
    APP,
    "    if (inFieldHere) return false;",
    "旧的「输入框里一律让给编辑器」判据已删除（那正是复制完粘不出来的成因）",
  );
  ok(
    (APP.match(/\n\s*nodeClipIsFresh = false;/g) || []).length === 1,
    "「标记转陈旧」只剩 markNodeClipStale 里那一处赋值（其余全部走它，别各写一遍）",
  );
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

  /* Ctrl+V：节点输入框里 —— 刚复制过节点（标记热乎）就照粘节点。
     点选节点会把焦点落进它自己的正文框，旧口径在这里一律让给编辑器 ⇒「点节点 → Ctrl+C →
     Ctrl+V」粘不出来（本轮修的 bug）。 */
  resetState();
  API.setClip({ nodes: [{ id: "n1" }], marks: [] });
  API.setFresh(true);
  ctx.document.activeElement = nodeField;
  ev = keyEvent(nodeField);
  consumed = API.clipKey(ev, "v", true);
  ok(
    consumed === true && ev.prevented === true && pasteCalls === 1,
    "节点输入框里 Ctrl+V：最近复制的是节点 → 粘节点（本轮修的 bug：复制完粘不出来）",
  );

  /* 同一场合但标记已陈旧（用户随后复制过文字 / 超时）→ 归浏览器原生粘贴纯文本 */
  resetState();
  API.setClip({ nodes: [{ id: "n1" }], marks: [] });
  API.setFresh(true);
  API.ageClip(200000);
  ctx.document.activeElement = nodeField;
  ev = keyEvent(nodeField);
  consumed = API.clipKey(ev, "v", true);
  ok(
    consumed === false && pasteCalls === 0,
    "节点输入框里 Ctrl+V：复制节点已超时（>2 分钟）→ 归浏览器原生粘贴文字",
  );

  resetState();
  API.setClip({ nodes: [{ id: "n1" }], marks: [] });
  API.markStale();
  ctx.document.activeElement = nodeField;
  ev = keyEvent(nodeField);
  consumed = API.clipKey(ev, "v", true);
  ok(
    consumed === false && pasteCalls === 0,
    "节点输入框里 Ctrl+V：标记被文字复制打陈旧后 → 原生粘贴文字",
  );

  /* 画布文字标注（.mk-text 富文本）里一律不粘节点 */
  resetState();
  API.setClip({ nodes: [{ id: "n1" }], marks: [] });
  API.setFresh(true);
  ctx.document.activeElement = mkText;
  ev = keyEvent(mkText);
  consumed = API.clipKey(ev, "v", true);
  ok(
    consumed === false && pasteCalls === 0,
    "画布文字标注（.mk-text）里 Ctrl+V：不粘节点（纯文字编辑）",
  );

  /* Ctrl+V：焦点漂到 BODY（画布重绘后常见）但事件目标是节点输入框 + 标记热乎 → 仍要粘节点 */
  resetState();
  API.setClip({ nodes: [{ id: "n1" }], marks: [] });
  API.setFresh(true);
  ctx.document.activeElement = body;
  ev = keyEvent(nodeField);
  consumed = API.clipKey(ev, "v", true);
  ok(
    consumed === true && pasteCalls === 1,
    "焦点漂到 BODY 时在节点输入框里 Ctrl+V：照粘节点（inCanvasField 判据不看 activeElement）",
  );

  /* Ctrl+V：焦点漂到 BODY 但事件目标是画布之外的输入框 → 归原生 */
  resetState();
  API.setClip({ nodes: [{ id: "n1" }], marks: [] });
  API.setFresh(true);
  ctx.document.activeElement = body;
  ev = keyEvent(foreign);
  consumed = API.clipKey(ev, "v", true);
  ok(
    consumed === false && pasteCalls === 0,
    "画布之外的输入框（ev.target 是它）Ctrl+V：归原生粘贴，不被画布吃掉",
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

  /* nodeClipPasteWanted 本体：标记热乎 + 粘贴板非空才算「该粘节点」 */
  resetState();
  API.setClip({ nodes: [{ id: "n1" }], marks: [] });
  ok(API.pasteWanted() === false, "只有粘贴板、标记不热乎 → 不算要粘节点");
  API.setFresh(true);
  ok(API.pasteWanted() === true, "粘贴板有节点 + 刚复制过 → 要粘节点");
  API.markStale();
  ok(API.pasteWanted() === false, "标记被打陈旧后立刻不算要粘节点");
  API.setClip({ nodes: [], marks: [] });
  API.setFresh(true);
  ok(API.pasteWanted() === false, "粘贴板里没有节点 / 绘制 → 不算要粘节点（空粘贴板不报错）");
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
    'const bootToAgentOrTeam = bootView === "agent" || bootView === "team";',
    "agent / team 的 boot 判据收口成 bootToAgentOrTeam（视图切换仍由 setView 负责）",
  );
  has(
    BOOT,
    "if (bootToAgentOrTeam && S._bootSeen) setView(bootView);",
    "agent / team 的 boot 仍走 setView（启动首绘期不重复拆建 DOM，画布视图不调 setView）",
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

  console.log("── [6] 复制节点层：粘贴后壳内节点仍归新壳（不得被摊到同一层）");
  {
    /* 本轮 bug：`cloneNodesDeep` 已把壳内节点的 parentSuperId 重映射成新壳 id，
       `pasteNodesFromClipboard` 又拿新 id 去查 idMap（键是旧 id）→ 命中失败清成 ""，
       壳内节点（含嵌套壳 / super_io 端子）全被抬成顶层。
       这一节把 cloneNodesDeep / cloneWiresForSet / collectWithDescendants / pasteNodesFromClipboard
       的**真实实现**搬进沙箱跑，只桩外围（S / uid / 提示 / 渲染 / 收尾保存）。 */
    const ctx2 = {
      console,
      toast: null,
      I18n: { t: (s) => s },
      window: { LT: { LOCKED: [] }, innerWidth: 1280, innerHeight: 800 },
      document: { querySelector: () => null },
    };
    vm.createContext(ctx2);
    const PRELUDE2 = [
      "let nodeClipboard = null;",
      "let __superFocus = '';",
      "const S = { cam: { x: 0, y: 0, z: 1 }, wf: null, selSet: new Set(), sel: null, selGroup: null, selWire: null, selMark: null, selMarkSet: null };",
      "let __seq = 0;",
      "function uid(p) { __seq++; return String(p) + 'cp' + __seq; }",
      "function snap(v) { return Math.round((Number(v) || 0) / 8) * 8; }",
      "function grid() { return 8; }",
      "function toast() {}",
      "function pushHistory() {}",
      "function renderCanvas() {}",
      "function scheduleSave() {}",
      "function renderStatus() {}",
      "function $() { return null; }",
      'function isAbsPath(p) { return String(p || "").charAt(1) === ":"; }',
      'function wfWorkspace() { return "E:/ws"; }',
      "function joinPath() {",
      "  var a = [];",
      "  for (var i = 0; i < arguments.length; i++) {",
      "    var v = arguments[i];",
      '    if (v != null && String(v) !== "") a.push(String(v));',
      "  }",
      '  return a.join("/");',
      "}",
      "function uniqueTitleInWf(wf, desired) {",
      '  const base = String(desired || "节点").trim() || "节点";',
      "  const taken = new Set(((wf && wf.nodes) || []).map((n) => n.title));",
      "  if (!taken.has(base)) return base;",
      "  let i = 2;",
      '  while (taken.has(base + " " + i)) i++;',
      '  return base + " " + i;',
      "}",
      "function isPinnedCtrl() { return false; }",
      "function isMediaGenNode() { return false; }",
      "function isSaveNode() { return false; }",
      "function currentTaskFocus() { return ''; }",
      "function currentSuperFocus() { return __superFocus; }",
      "function nodeById(id) { return ((S.wf && S.wf.nodes) || []).find((n) => n.id === id) || null; }",
      "function superInnerOrigin() { return { ox: 10, oy: 40 }; }",
      "function superInnerPan(s) { return { x: Number(s && s.innerPanX) || 0, y: Number(s && s.innerPanY) || 0 }; }",
      "function markBounds(m) { return m ? { x: m.x, y: m.y, w: m.w || 10, h: m.h || 10 } : null; }",
      "let __drop = null;",
      "function pasteDropPoint() { return __drop ? { x: __drop.x, y: __drop.y } : null; }",
      "function marksOf() { return S.wf.marks; }",
      "function ensureSelMarkSet() { return (S.selMarkSet = S.selMarkSet || new Set()); }",
      "function blurMarkEditing() {}",
      "function ensureTaskScaffold() {}",
      "function probeMediaBackend() {}",
    ].join("\n");
    let C2 = null;
    try {
      vm.runInContext(PRELUDE2, ctx2, { filename: "prelude2.js" });
      vm.runInContext(
        fnBody(APP, "absImagePathOf") +
          "\n" +
          fnBody(APP, "cloneNodesDeep") +
          "\n" +
          fnBody(APP, "cloneWiresForSet") +
          "\n" +
          fnBody(APP, "copiedSuperIdsOf") +
          "\n" +
          fnBody(APP, "collectWithDescendants") +
          "\n" +
          fnBody(APP, "pasteNodesFromClipboard") +
          "\n" +
          "this.__copy = {\n" +
          "  withDesc: collectWithDescendants,\n" +
          "  paste: pasteNodesFromClipboard,\n" +
          "  setClip: (c) => { nodeClipboard = c; },\n" +
          "  setFocus: (f) => { __superFocus = String(f || ''); },\n" +
          "  setDrop: (d) => { __drop = d ? { x: Number(d.x), y: Number(d.y) } : null; },\n" +
          "  loadWf: (wf) => { S.wf = wf; },\n" +
          "  wf: () => S.wf,\n" +
          "};",
        ctx2,
        { filename: "extracted2.js" },
      );
      C2 = ctx2.__copy;
      ok(
        !!(C2 && C2.paste && C2.wf && C2.withDesc),
        "复制 / 粘贴真函数已搬进沙箱（cloneNodesDeep · cloneWiresForSet · collectWithDescendants · pasteNodesFromClipboard）",
      );
    } catch (e) {
      ok(false, "复制 / 粘贴真函数已搬进沙箱（" + ((e && e.message) || e) + "）");
    }

    if (C2) {
      const deep = (v) => JSON.parse(JSON.stringify(v));
      /* 源画布：一颗节点层（展开 + 内部平移）+ 4 个直接子节点（含 super_io 端子 / 嵌套壳 / 图像）
         + 嵌套壳里 1 个子节点 + 1 个壳外节点（跨集连线不该被复制） */
      const shellSrc = {
        id: "s1", kind: "super", title: "壳A", x: 400, y: 300, w: 400, h: 300,
        expandW: 720, expandH: 480, superOpen: true, innerPanX: 12, innerPanY: 34,
        ltShellTask: "T-1", ltShellPath: "a/b", parentSuperId: "", parentTaskId: "",
      };
      const innerSrc = [
        { id: "a", kind: "input_text", title: "内部文本", x: 20, y: 30, w: 180, h: 96, parentSuperId: "s1", parentTaskId: "" },
        { id: "b", kind: "proc_text", title: "内部处理", x: 220, y: 30, w: 200, h: 120, parentSuperId: "s1", parentTaskId: "" },
        { id: "io", kind: "super_io", title: "端子 1", x: 8, y: 120, w: 40, h: 40, superIoIndex: 1, parentSuperId: "s1", parentTaskId: "" },
        { id: "img", kind: "input_image", title: "内部图像", x: 300, y: 200, w: 200, h: 150, imageAsset: "img/pic.png", sourceName: "pic.png", parentSuperId: "s1", parentTaskId: "" },
        { id: "s2", kind: "super", title: "嵌套壳", x: 30, y: 180, w: 260, h: 200, superOpen: true, parentSuperId: "s1", parentTaskId: "" },
        { id: "c", kind: "proc_text", title: "壳中壳节点", x: 10, y: 10, w: 160, h: 90, parentSuperId: "s2", parentTaskId: "" },
      ];
      const outsideSrc = { id: "out1", kind: "proc_text", title: "壳外节点", x: 900, y: 300, w: 180, h: 96, parentSuperId: "", parentTaskId: "" };
      const srcWires = [
        { id: "w1", from: "a", to: "b", fromIndex: 0, toIndex: 0 },
        { id: "w2", from: "s1", to: "c", fromIndex: 0, toIndex: 0 },
        { id: "w3", from: "b", to: "out1", fromIndex: 0, toIndex: 0 },
      ];
      const copySet = [shellSrc].concat(innerSrc);

      /* ① 复制：只选壳一颗，后代必须被整棵收进粘贴板 */
      const wf0 = { id: "wf1", name: "t", nodes: deep([outsideSrc, shellSrc].concat(innerSrc)), wires: deep(srcWires), marks: [] };
      C2.loadWf(wf0);
      C2.setFocus("");
      const collected = C2.withDesc([wf0.nodes[1]], wf0);
      ok(collected.length === 7, "复制集合 = 壳 + 全部后代（实得 " + collected.length + " / 期望 7）");

      /* ② 粘贴 */
      C2.setClip({ wfId: "wf1", nodes: deep(copySet), wires: deep(srcWires), marks: [] });
      const pastedOk = C2.paste();
      const wf = C2.wf();
      ok(pastedOk === true, "粘贴执行成功");
      const added = wf.nodes.filter((n) => ["s1", "a", "b", "io", "img", "s2", "c", "out1"].indexOf(n.id) < 0);
      ok(added.length === 7, "粘贴出 7 颗新节点（实得 " + added.length + "）");
      const newShell = added.filter((n) => n.kind === "super" && !n.parentSuperId && n.title.indexOf("壳A") === 0)[0];
      const newNested = added.filter((n) => n.kind === "super" && n !== newShell && n.title.indexOf("嵌套壳") === 0)[0];
      const newA = added.filter((n) => n.title.indexOf("内部文本") === 0)[0];
      const newB = added.filter((n) => n.title.indexOf("内部处理") === 0)[0];
      const newIo = added.filter((n) => n.kind === "super_io")[0];
      const newImg = added.filter((n) => n.kind === "input_image")[0];
      const newC = added.filter((n) => n.title.indexOf("壳中壳节点") === 0)[0];
      ok(!!newShell && newShell.id !== "s1", "新壳另起 id（不与源撞车）");
      ok(
        added.filter((n) => !n.parentSuperId).length === 1,
        "只有新壳落在顶层：其余新节点都挂在壳里（实得顶层 " + added.filter((n) => !n.parentSuperId).length + " 颗）",
      );
      ok(
        [newA, newB, newIo, newImg].every((n) => n && n.parentSuperId === newShell.id),
        "壳内节点（文本 / 处理 / super_io 端子 / 图像）的 parentSuperId = 新壳 id（不再被清空）",
      );
      ok(
        newNested && newNested.parentSuperId === newShell.id && newC && newC.parentSuperId === newNested.id,
        "多层嵌套壳逐层归属正确（新壳 ← 新嵌套壳 ← 壳中壳节点）",
      );
      ok(
        wf.nodes.filter((n) => added.indexOf(n) >= 0).every((n) => n.parentSuperId !== "s1" && n.parentSuperId !== "s2"),
        "没有任何粘贴品还指着源画布的父 id",
      );

      /* ③ 位置：壳整体偏移，壳内相对坐标不动 */
      ok(newShell.x !== 400 || newShell.y !== 300, "新壳错开了源位置（不重叠）");
      ok(
        newA && newA.x === 20 && newA.y === 30 && newB && newB.x === 220 && newC && newC.x === 10,
        "壳内节点沿用内部相对坐标（不参与整体偏移）",
      );

      /* ④ 壳态与身份 */
      ok(
        newShell.superOpen === true && newShell.innerPanX === 12 && newShell.innerPanY === 34 && newShell.expandW === 720,
        "壳态照拷：展开态 / innerPan / 尺寸随副本",
      );
      ok(
        String(newShell.ltShellTask || "") === "" && String(newShell.ltShellPath || "") === "",
        "长任务壳身份摘除（副本当普通节点层用）",
      );

      /* ⑤ 标题唯一化 + 图像路径固化 */
      ok(
        added.every((n) => wf.nodes.filter((m) => m.title === n.title).length === 1),
        "壳内节点标题也走唯一化（重名加编号，不出现两个同名节点）",
      );
      ok(
        newImg && newImg.imageAsset === "E:/ws/img/pic.png",
        "壳内图像节点的相对路径已固化为绝对路径",
      );

      /* ⑥ 连线：两端都在复制集内的重建，跨集的丢掉 */
      const newWire = (from, to) => wf.wires.some((w) => w.from === from && w.to === to);
      ok(
        newA && newB && newIo && newWire(newA.id, newB.id),
        "壳内连线按新 id 重建",
      );
      ok(
        newC && newWire(newShell.id, newC.id),
        "壳边界线（壳 → 壳内节点）按新 id 重建",
      );
      ok(
        wf.wires.length === 5 &&
          wf.wires.filter((w) => w.to === "out1").length === 1 &&
          wf.wires.filter((w) => w.from === "b").length === 1,
        "跨复制集的连线不复制：新增的只有壳内 / 壳边界两条，源连线仍原样挂旧 id（共 " + wf.wires.length + " 条）",
      );

      /* ⑦ 粘到另一个展开壳内部：壳本身挂进当前壳，壳内节点仍归新壳 */
      const host = { id: "sx", kind: "super", title: "宿主壳", x: 0, y: 0, w: 600, h: 400, superOpen: true, parentSuperId: "", parentTaskId: "" };
      const wf2 = { id: "wf2", name: "t2", nodes: deep([host]), wires: [], marks: [] };
      C2.loadWf(wf2);
      C2.setFocus("sx");
      C2.setClip({ wfId: "wf2", nodes: deep(copySet), wires: deep(srcWires), marks: [] });
      C2.paste();
      const wf3 = C2.wf();
      const shell2 = wf3.nodes.filter((n) => n.kind === "super" && n.title.indexOf("壳A") === 0)[0];
      const kids2 = wf3.nodes.filter((n) => shell2 && n.parentSuperId === shell2.id);
      ok(
        !!shell2 && shell2.parentSuperId === "sx",
        "粘进展开的宿主壳内部：新壳自己挂到宿主壳下",
      );
      ok(
        kids2.length === 5 && kids2.every((n) => n.parentSuperId === shell2.id),
        "此时壳内节点仍归新壳（不会被「当前作用域」抢到宿主壳）",
      );

      /* ⑧ 粘贴落点 = 鼠标指针（本轮需求）：包围盒左上角贴到指针处（吸附网格）。
         旧行为是包围盒中心对准视口中心，复制品落在屏幕正中、与指针无关。 */
      C2.setDrop({ x: 1000, y: 800 });
      C2.setFocus("");
      C2.loadWf({ id: "wf4", name: "t4", nodes: [], wires: [], marks: [] });
      C2.setClip({
        wfId: "wf4",
        nodes: [{ id: "p1", kind: "proc_text", title: "针", x: 400, y: 300, w: 180, h: 96 }],
        wires: [],
        marks: [],
      });
      C2.paste();
      const atPointer = C2.wf().nodes[0];
      ok(
        !!atPointer && atPointer.x === 1000 && atPointer.y === 800,
        "指针处粘贴：新节点左上角 = 指针的世界坐标（实得 " +
          (atPointer ? atPointer.x + "," + atPointer.y : "无") +
          "）",
      );
      /* 多节点：整个粘贴集的包围盒左上角对准指针（不是每颗各自贴指针） */
      C2.loadWf({ id: "wf5", name: "t5", nodes: [], wires: [], marks: [] });
      C2.setClip({
        wfId: "wf5",
        nodes: [
          { id: "q1", kind: "proc_text", title: "A", x: 400, y: 300, w: 180, h: 96 },
          { id: "q2", kind: "proc_text", title: "B", x: 700, y: 500, w: 180, h: 96 },
        ],
        wires: [],
        marks: [],
      });
      C2.paste();
      const g = C2.wf().nodes;
      const minX = Math.min(...g.map((n) => n.x));
      const minY = Math.min(...g.map((n) => n.y));
      ok(
        g.length === 2 && minX === 1000 && minY === 800,
        "多节点粘贴：包围盒左上角对准指针，内部相对位置不变（实得 " + minX + "," + minY + "）",
      );

      /* ⑨ 没有指针落点（纯键盘 / 指针还没进过画布）→ 退回旧的视口中心：包围盒中心 = 视口中心 */
      C2.setDrop(null);
      C2.loadWf({ id: "wf6", name: "t6", nodes: [], wires: [], marks: [] });
      C2.setClip({
        wfId: "wf6",
        nodes: [{ id: "r1", kind: "proc_text", title: "中", x: 400, y: 300, w: 180, h: 96 }],
        wires: [],
        marks: [],
      });
      C2.paste();
      const atCenter = C2.wf().nodes[0];
      /* 视口中心路径沿用旧口径（dx 先吸附、落点再吸附一次），允许半格以内的偏差 */
      ok(
        !!atCenter &&
          Math.abs(atCenter.x + 90 - 640) <= 8 &&
          Math.abs(atCenter.y + 48 - 400) <= 8,
        "没有指针落点时退回视口中心（1280×800 视口中心 640,400；实得 " +
          (atCenter ? atCenter.x + 90 + "," + (atCenter.y + 48) : "无") +
          "）",
      );

      /* 结构口径：指针落点由 bindCanvas 的 mousemove 记、粘贴读同一份（别又退回视口中心） */
      has(APP, "function noteCanvasPointer(", "指针落点收口在 noteCanvasPointer");
      has(APP, "function pasteDropPoint(", "粘贴落点收口在 pasteDropPoint");
      has(
        APP,
        'canvas.addEventListener(\n    "mousemove",\n    (ev) => noteCanvasPointer(ev.clientX, ev.clientY),',
        "bindCanvas 在画布 mousemove 上记指针落点",
      );
      has(APP, "const drop = pasteDropPoint();", "pasteNodesFromClipboard 读指针落点");
      hasnt(APP, "包围盒中心对准当前视口中心（吸附网格）", "粘贴的旧口径（视口中心）已改掉");
    }
  }

  console.log("── [7] 粘贴后连着壳一起拖：壳内节点不得被甩到顶层（拖拽单元 = 壳，不含其后代）");
  {
    /* 本轮 bug：粘贴会把「壳 + 全部内部节点」一起选中；拖着壳在空白处松手时，
       finalizeNodeDragNest 按落点逐个改写 parentSuperId，壳内节点于是全被抬成顶层
       （撤销一次才回得来）。收口在 dragUnitIds：壳的后代不算独立拖拽成员。 */
    has(APP, "function dragUnitIds(ids)", "拖拽单元收口在 dragUnitIds（壳的后代随壳走）");
    has(APP, "dragIds = dragUnitIds(dragIds);", "startNodeDrag 用 dragUnitIds 收敛拖拽名单");
    has(APP, "const unitIds = dragUnitIds(ids || []);", "松手落定（finalizeNodeDragNest）也只认独立拖拽单元");
    hasnt(APP, "const openSupers = new Set(", "旧的「只剔展开壳的直接子节点」口径已移除（收起壳同样要带走内容）");

    const ctx3 = {
      console,
      S: { wf: { nodes: [] } },
      nodeById: null,
      nodeParentSuperId: null,
    };
    vm.createContext(ctx3);
    const PRELUDE3 = [
      "function nodeById(id) { return ((S.wf && S.wf.nodes) || []).find((n) => n.id === id) || null; }",
      "function nodeParentSuperId(n) { return (n && n.parentSuperId) || ''; }",
    ].join("\n");
    let D3 = null;
    try {
      vm.runInContext(PRELUDE3, ctx3, { filename: "prelude3.js" });
      vm.runInContext(
        fnBody(APP, "dragUnitIds") +
          "\nthis.__drag = { unit: dragUnitIds, load: (nodes) => { S.wf = { nodes: nodes }; } };",
        ctx3,
        { filename: "extracted3.js" },
      );
      D3 = ctx3.__drag;
      ok(!!(D3 && typeof D3.unit === "function"), "dragUnitIds 真函数已搬进沙箱");
    } catch (e) {
      ok(false, "dragUnitIds 真函数已搬进沙箱（" + ((e && e.message) || e) + "）");
    }

    if (D3) {
      const nodes = [
        { id: "shell", kind: "super", title: "壳", superOpen: false, parentSuperId: "" },
        { id: "a", kind: "input_text", title: "内 A", parentSuperId: "shell" },
        { id: "nest", kind: "super", title: "内壳", parentSuperId: "shell" },
        { id: "leaf", kind: "input_text", title: "叶子", parentSuperId: "nest" },
        { id: "other", kind: "proc_text", title: "壳外", parentSuperId: "" },
      ];
      D3.load(nodes);
      /* ① 粘贴后的选中集：壳 + 全部后代（收起壳也算） */
      const u1 = D3.unit(["shell", "a", "nest", "leaf", "other"]);
      ok(
        u1.length === 2 && u1.indexOf("shell") >= 0 && u1.indexOf("other") >= 0,
        "收起壳 + 全部后代入拖：只剩壳与壳外节点（实得 " + JSON.stringify(u1) + "）",
      );
      /* ② 只看壳：后代（含嵌套壳里的叶子）一律不单独拖 */
      const u2 = D3.unit(["shell", "a", "nest", "leaf"]);
      ok(u2.length === 1 && u2[0] === "shell", "任意深度的后代都不算独立拖拽成员（实得 " + JSON.stringify(u2) + "）");
      /* ③ 只选壳内某颗节点（壳没被选）：照旧可以单独拖 / 拖出壳 */
      const u3 = D3.unit(["a", "leaf"]);
      ok(u3.length === 2, "壳没被选中时，壳内节点仍能单独拖（实得 " + JSON.stringify(u3) + "）");
      /* ④ 没有壳的普通多选：原样返回 */
      const u4 = D3.unit(["a", "other"]);
      ok(u4.length === 2, "没有壳参与时拖拽名单原样不动");
    }
  }

  console.log("");
  if (fails) {
    console.log("✗ " + fails + " / " + checks + " 项失败");
    process.exit(1);
  }
  console.log("✓ 全部 " + checks + " 项通过");
})();
