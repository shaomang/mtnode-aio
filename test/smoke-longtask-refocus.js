"use strict";
/* 长任务右栏输入失焦回归 —— 纯 Node，只读源码文本 + vm 跑判据（不依赖 Electron）
 *   node test/smoke-longtask-refocus.js
 *
 * 缺陷：长任务跑着时在条带**右栏**（审批卡的理由框 / 环节参数 / 交付清单文件名）打字，
 * 打一半就失焦（中文输入法连组合态一起断），紧接着敲的 J / K / L / 空格 / 1 / 2 / 3
 * 还会被顶栏快捷键收走 —— 看上去像「菜单快捷键抢焦点」。
 * 起因不是快捷键：ltRenderStrip() 原来一律 main.innerHTML = "" 把左右两栏一起重建，
 * 而长任务在跑时这条重绘非常密（Agent 每段流式正文都叫一次 ltRenderStripSoon，
 * app-longtask.js 的 onEvent → 90ms 节流），右栏的输入控件每 ~90ms 被换掉一只新的，
 * 焦点自然跟着没了；失焦后 app-keys.js 的让位判据（焦点还在可编辑元素里）不再成立，
 * 快捷键才开始生效 —— 快捷键是症状。
 *
 * 规则要保住的行为（本文件就是它的回归口径）：
 *   [1] 判据就位：ltEditHost / ltFocusCol / ltFocusInside / ltColOf / ltRenderWhenFocusLeaves
 *   [2] 判据口径：可编辑焦点才拦重绘；按钮 / 栏外 / body 上的焦点不拦
 *   [3] 真跑 ltRenderMain：焦点在哪一栏，那一栏的 DOM 节点**原样留在文档里**（不重建、不摘出），
 *       只重建另一栏；没有可编辑焦点时才走原来的整块重建
 *   [4] 推迟的那一次重绘：焦点离开两栏才补，且只挂一条监听、不重复补
 *   [5] 症状对照：重绘密度（onEvent 逐帧叫重绘）与快捷键让位判据都还在 ——
 *       所以修的是「不许在用户打字时重建那一栏」，不是去动快捷键
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
/* 源码统一按 \n 处理（仓库是 CRLF），切段与断言不必管行尾差异 */
const read = (rel) =>
  fs
    .readFileSync(path.join(__dirname, "..", rel.split("/").join(path.sep)), "utf8")
    .replace(/\r\n/g, "\n");

const LTU = read("renderer/app-longtask-ui.js");
const LTV = read("renderer/app-longtask.js");
const KEYS = read("renderer/app-keys.js");

function fnBody(src, name) {
  const m = src.match(new RegExp("\\nfunction " + name + "\\s*\\(", "m"));
  if (!m) throw new Error("找不到函数：" + name);
  const at = src.indexOf("{", m.index);
  let depth = 0;
  let inStr = null;
  for (let j = at; j < src.length; j++) {
    const c = src[j];
    if (inStr) {
      if (c === "\\") j++;
      else if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") inStr = c;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (!depth) return src.slice(m.index + 1, j + 1);
    }
  }
  throw new Error("函数体没闭合：" + name);
}

/* ── 迷你 DOM：够 ltRenderMain 用（children / appendChild / insertBefore / removeChild /
      contains / classList / innerHTML = ""），并在整块重建时记一笔 ── */
function mkEl(cls) {
  const el = {
    nodeType: 1,
    tagName: "DIV",
    className: cls || "",
    children: [],
    parentNode: null,
    _cleared: 0,
    contains(t) {
      let p = t;
      while (p) {
        if (p === this) return true;
        p = p.parentNode;
      }
      return false;
    },
  };
  el.classList = { contains: (c) => String(el.className).split(/\s+/).indexOf(c) >= 0 };
  el.appendChild = function (c) {
    if (c && c.parentNode && c.parentNode !== this) c.parentNode.removeChild(c);
    this.children.push(c);
    if (c) c.parentNode = this;
    return c;
  };
  el.insertBefore = function (c, ref) {
    if (c && c.parentNode && c.parentNode !== this) c.parentNode.removeChild(c);
    const i = this.children.indexOf(ref);
    if (i < 0) return this.appendChild(c);
    this.children.splice(i, 0, c);
    if (c) c.parentNode = this;
    return c;
  };
  el.removeChild = function (c) {
    const i = this.children.indexOf(c);
    if (i >= 0) this.children.splice(i, 1);
    if (c) c.parentNode = null;
    return c;
  };
  Object.defineProperty(el, "innerHTML", {
    get() {
      return "";
    },
    set() {
      this._cleared++;
      for (const c of this.children.slice()) this.removeChild(c);
    },
  });
  return el;
}
/* 输入控件（判据只看 tagName / isContentEditable，不需要真渲染）。
   closest 给一份最小实现：只认 ltHoldCtrlEl 那条选择器里用到的 `tag` / `tag[type="x"]` 两种写法。 */
function mkClosest(el, tag, type) {
  const T = String(tag || el.tagName || "").toLowerCase();
  const ty = String(type || "").toLowerCase();
  return (sel) => {
    for (const part of String(sel).split(",")) {
      const m = part.trim().match(/^([a-z]+)(?:\[type="([a-z]+)"\])?$/);
      if (!m) continue;
      if (m[1] !== T) continue;
      if (m[2] && m[2] !== ty) continue;
      return el;
    }
    return null;
  };
}
function mkField(tag, type) {
  const e = mkEl("lt-in");
  e.tagName = String(tag || "input").toUpperCase();
  if (type) e.type = type;
  e.closest = mkClosest(e, tag, type);
  return e;
}
/* 原生选区替身（ltSelInCol 只看 isCollapsed / rangeCount / anchorNode / focusNode） */
function mkSel(anchorNode, focusNode, collapsed) {
  return {
    isCollapsed: !!collapsed,
    rangeCount: anchorNode || focusNode ? 1 : 0,
    anchorNode: anchorNode || null,
    focusNode: focusNode || null,
  };
}
function mkDoc(active) {
  const doc = {
    activeElement: active || null,
    body: mkEl(""),
    documentElement: mkEl(""),
    listeners: [],
  };
  doc.body.tagName = "BODY";
  doc.documentElement.tagName = "HTML";
  doc.addEventListener = function (type, fn, capture) {
    this.listeners.push({ type, fn, capture: !!capture });
  };
  doc.removeEventListener = function (type, fn) {
    this.listeners = this.listeners.filter((l) => !(l.type === type && l.fn === fn));
  };
  doc.emit = function (type) {
    for (const l of this.listeners.slice()) if (l.type === type) l.fn({ type });
  };
  return doc;
}
/* 把 UI 源码里的判据函数搬进沙箱（共享同一份源码，不另抄一份逻辑）；
   函数引用的两个模块级量（文本框类型表 / 已挂监听标志）也照源码取一份补上。 */
function sandboxFor(names, extra) {
  const types = (LTU.match(/const LT_TEXT_INPUT_TYPES = (\[[^\]]*\]);/) || [])[1] || "[]";
  const sb = Object.assign(
    { console, Array, Object, String, Number, Date, Math, JSON, isFinite, parseFloat, parseInt },
    { LT_TEXT_INPUT_TYPES: JSON.parse(types), ltRenderWait: false },
    extra || {},
  );
  vm.createContext(sb);
  for (const n of names) vm.runInContext(fnBody(LTU, n), sb);
  return sb;
}

console.log("\n[1] 焦点保护判据就位（renderer/app-longtask-ui.js）");
{
  for (const n of ["ltEditHost", "ltFocusCol", "ltFocusInside", "ltColOf", "ltRenderWhenFocusLeaves"])
    ok(LTU.indexOf("\nfunction " + n + "(") > 0, "有 " + n);
  for (const n of ["ltSelInCol", "ltColHold", "ltHoldArm", "ltHoldRelease", "ltHoldBind", "ltColHoldNow", "ltRenderFlushDeferred"])
    ok(LTU.indexOf("\nfunction " + n + "(") > 0, "有框选 / 按住保护判据 " + n);
  ok(
    fnBody(LTU, "ltRenderMain").indexOf("ltFocusCol(oldRight)") > 0,
    "ltRenderMain 先判断「焦点在右栏输入里」——不再无条件重建右栏",
  );
  ok(
    fnBody(LTU, "ltRenderMain").indexOf("ltColHold(oldRight)") > 0 &&
      fnBody(LTU, "ltRenderMain").indexOf("ltColHold(oldLeft)") > 0,
    "ltRenderMain 还判断「这一栏正在框选 / 鼠标正按在栏里」（ltColHold）",
  );
  ok(
    /const LT_TEXT_INPUT_TYPES = \["", "text", "search", "url", "email", "password", "tel", "number"\];/.test(LTU),
    "拦重绘只认「文本输入」的控件类型表（下拉 / 复选框不算，见 ltEditHost 的取舍说明）",
  );
  ok(
    fnBody(LTU, "ltMount").indexOf("ltHoldBind()") > 0,
    "条带挂载时接上「鼠标按在哪一栏」的捕获监听（ltMount → ltHoldBind，只挂一次）",
  );
  const ctrlSel = (fnBody(LTU, "ltHoldCtrlEl").match(/el\.closest\(\s*'([^']+)'/) || [])[1] || "";
  ok(
    ctrlSel.indexOf("select") >= 0 && ctrlSel.indexOf("button") >= 0 && ctrlSel.indexOf('input[type="checkbox"]') >= 0,
    "「提交即生效」的控件才不记：原生 select / 按钮 / 勾选型 input",
  );
  ok(
    ctrlSel.indexOf("textarea") < 0 && ctrlSel.indexOf("[contenteditable]") < 0 && !/input(?!\[)/.test(ctrlSel.replace(/input\[[^\]]*\]/g, "")),
    "文本框 / 富文本仍吃这条保护：按下到松手之间也不重建（框选起手不被换掉）",
  );
  const watch = fnBody(LTU, "ltRenderWhenFocusLeaves");
  ok(
    watch.indexOf('addEventListener("selectionchange", onOut, true)') > 0 &&
      watch.indexOf('addEventListener("pointerup", onOut, true)') > 0 &&
      watch.indexOf('addEventListener("keyup", onOut, true)') > 0,
    "被推迟的重绘还听 selectionchange（选区折叠）/ pointerup（松手）/ keyup（Esc 收选区）",
  );
}

console.log("\n[2] 判据口径：谁拦重绘、谁不拦（vm 真跑）");
{
  const sb = sandboxFor(["ltEditHost", "ltFocusCol", "ltFocusInside"], { document: mkDoc(null) });
  const col = mkEl("lt-right");
  const ta = mkField("textarea");
  const inp = mkField("input");
  const search = mkField("input");
  search.type = "search";
  const sel = mkField("select");
  const cb = mkField("input");
  cb.type = "checkbox";
  const rich = mkEl("md-rich");
  rich.isContentEditable = true;
  const btn = mkEl("lt-btn");
  btn.tagName = "BUTTON";
  const outside = mkField("input");
  for (const e of [ta, inp, search, sel, cb, rich, btn]) col.appendChild(e);

  sb.__col = col;
  sb.__ta = ta;
  const focusCol = (el) => {
    sb.document.activeElement = el;
    return vm.runInContext("ltFocusCol(__col)", sb);
  };
  const focusInside = (el) => {
    sb.document.activeElement = el;
    return vm.runInContext("ltFocusInside(__col)", sb);
  };
  ok(focusCol(ta) === true, "焦点在右栏 textarea（审批理由框 / 环节目标）→ 拦重绘（这一栏不许被重建）");
  ok(focusCol(inp) === true, "焦点在右栏文本 input（环节参数 / 交付文件名）→ 拦重绘");
  ok(focusCol(search) === true, "焦点在右栏搜索框（可搜索下拉：正打过滤词）→ 拦重绘（下拉不能被换掉）");
  ok(focusCol(rich) === true, "焦点在右栏 contenteditable（富文本）→ 拦重绘");
  ok(focusCol(sel) === false, "焦点在右栏 select → **不拦**：选完就是一次提交，「人工任务类型」切成交付要当场长出交付清单");
  ok(focusCol(cb) === false, "焦点在右栏复选框 → 不拦：勾选就是提交（勾「允许读取画布」要当场把提示刷对）");
  ok(focusCol(btn) === false, "焦点在右栏按钮上 → 不拦（按钮不是「正在输入」，面板照常跟着运行态刷）");
  ok(focusCol(outside) === false, "焦点在栏外（左栏 / 别处）的输入框 → 不拦");
  ok(focusCol(sb.document.body) === false, "焦点在 body（失焦态）→ 不拦，重绘立刻照旧");
  ok(focusCol(null) === false, "没有活动元素 → 不报错、不误拦");
  ok(focusInside(btn) === true, "补重绘的判据 ltFocusInside：按钮上的焦点也算「还在这一栏」，先把 click 让完");
  ok(focusInside(outside) === false, "焦点离开了两栏 → 该补重绘了");
}

console.log("\n[2b] 选区判据 ltSelInCol：栏里有活的选区才拦（vm 真跑）");
{
  const doc = mkDoc(null);
  const sb = sandboxFor(["ltSelInCol"], { document: doc });
  const col = mkEl("lt-right");
  const textA = mkEl("");
  const textB = mkEl("");
  const outside = mkEl("");
  col.appendChild(textA);
  sb.__col = col;
  const runSel = (sel) => {
    doc.getSelection = sel ? () => sel : undefined;
    return vm.runInContext("ltSelInCol(__col)", sb);
  };
  ok(
    runSel(mkSel(textA, textB, false)) === true,
    "拖选右栏里的只读文字（选区锚点在栏内）→ 拦重绘：被选中的那段文字不会被整块重建冲掉",
  );
  ok(runSel(mkSel(textA, textB, false)) === true, "（再判一次仍拦得住：~90ms 一次的重绘每次都拦得住）");
  ok(runSel(mkSel(textA, null, false)) === true, "锚点 / 终点只落在一头也算（跨栏拖选时终点可能在栏外）");
  ok(runSel(mkSel(outside, outside, false)) === false, "选区在栏外 → 不拦（另一栏照常重绘）");
  ok(runSel(mkSel(textA, textB, true)) === false, "光标（折叠选区）不算框选 → 不拦");
  ok(runSel(null) === false, "没有选区对象 → 不拦、不报错");
  ok(runSel(mkSel(textA.parentNode, textB, false)) === true, "选区锚在**文本节点**上（真实拖选常见）→ 按父元素判定，照样拦得住");
  ok(runSel(undefined) === false, "document 没有 getSelection（迷你环境）→ 不拦、不报错");
}

console.log("\n[2c] 按住判据 ltHoldArm / ltColHold：控件按下不记（提交语义不变）");
{
  const doc = mkDoc(null);
  const main = mkEl("lt-main");
  const left = mkEl("lt-left");
  const right = mkEl("lt-right");
  main.appendChild(left);
  main.appendChild(right);
  const textEl = mkEl("lt-fh");
  const ta = mkField("textarea");
  const btnEl = mkEl("lt-btn");
  btnEl.tagName = "BUTTON";
  btnEl.closest = mkClosest(btnEl, "button");
  const cbEl = mkField("input", "checkbox");
  const selEl = mkField("select");
  const outsideEl = mkEl("");
  right.appendChild(textEl);
  right.appendChild(ta);
  right.appendChild(btnEl);
  right.appendChild(cbEl);
  right.appendChild(selEl);
  let flushes = 0;
  const sb = sandboxFor(
    ["ltEditHost", "ltFocusCol", "ltSelInCol", "ltColOf", "ltHoldCtrlEl", "ltHoldArm", "ltHoldRelease", "ltColHold"],
    { document: doc, LT_UI: { main }, ltRenderFlushDeferred: () => flushes++ },
  );
  const hold = () => vm.runInContext("ltHoldColEl", sb);
  const colHold = (col) => {
    sb.__col = col;
    return vm.runInContext("ltColHold(__col)", sb);
  };
  const arm = (el) => {
    sb.__el = el;
    return vm.runInContext("ltHoldArm(__el)", sb);
  };
  const release = () => vm.runInContext("ltHoldRelease()", sb);

  arm(textEl);
  ok(hold() === right, "鼠标按在右栏的普通文字上（要框选）→ 记下这一栏");
  ok(colHold(right) === true && colHold(left) === false, "这一栏从此不许重建，另一栏照常重绘");
  release();
  ok(hold() === null && flushes === 1, "松手即释放，并立刻兑现此前被推迟的那一次重绘");

  arm(ta);
  ok(hold() === right && colHold(right) === true, "按在文本框里（右栏的理由框 / 参数）→ 也记：框选起手那一下不能被换掉（提交走 change，不在这按下里）");
  release();
  arm(btnEl);
  ok(hold() === null, "按在按钮上 → 不记：按钮的 click 要立刻生效");
  arm(cbEl);
  ok(hold() === null, "按在勾选型 input 上 → 不记：change 就是一次提交（勾「允许读取画布」要当场刷提示）");
  arm(selEl);
  ok(hold() === null, "按在原生 select 上 → 不记：选完即 change，「人工任务类型」切成交付要当场长出交付清单");
  flushes = 0;
  release();
  ok(flushes === 0, "没有按住态时松手不做无谓重绘（不在 mouseup 上白刷一帧）");
  arm(outsideEl);
  ok(hold() === null, "按在两栏之外（画布 / 头部）→ 不记");
  /* 左栏（SVG 状态机图）不吃这条保护：点节点的选中高亮要靠 pointerdown 里那次重绘落到当下这一帧 */
  const leftText = mkEl("lt-graph");
  left.appendChild(leftText);
  arm(leftText);
  ok(hold() === null, "按在左栏的图上 → 不记：点一下节点的选中高亮要立刻出来（拖动手势另有 document 级监听兜底）");
  arm(textEl);
  release();
}

console.log("\n[3] 真跑 ltRenderMain：焦点在哪一栏，那一栏的 DOM 原样留下");
{
  const calls = { graph: 0, side: 0 };
  const doc = mkDoc(null);
  const main = mkEl("lt-main");
  const sb = sandboxFor(["ltEditHost", "ltFocusCol", "ltColOf", "ltRenderMain", "ltHoverHere"], {
    document: doc,
    LT_UI: { main },
    ltActiveTask: () => ({ uid: "t1", graph: { nodes: [], edges: [] }, ver: 1 }),
    ltEnabledTask: () => null,
    ltCurrentRun: () => null,
    ltEmptyState: () => mkEl("lt-empty"),
    ltEl: (tag, cls) => {
      const e = mkEl(cls || "");
      e.tagName = String(tag || "div").toUpperCase();
      return e;
    },
    ltRenderGraph: (left) => {
      calls.graph++;
      left.appendChild(mkEl("lt-graph"));
    },
    ltRenderSide: (right) => {
      calls.side++;
      right.appendChild(mkEl("lt-card"));
    },
    ltRenderWhenFocusLeaves: () => {},
    /* 按住保护 / 栏位登记（本次需求）：本档验的是「焦点保护」，按住态一律当「没按着」，
       栏位登记给一份空实现（真行为由 smoke-longtask-strip-hold.js 与 scroll 那档钉）。 */
    ltTrackCols: () => {},
    ltStripHoldNow: () => false,
  });
  const render = () => vm.runInContext("ltRenderMain({ id: 'wf1' })", sb);
  const colOf = (cls) => vm.runInContext("ltColOf(LT_UI.main, '" + cls + "')", sb);

  /* A. 焦点在右栏输入里：右栏原地留下，只重建左栏 */
  const leftA = mkEl("lt-left");
  const rightA = mkEl("lt-right");
  const taA = mkField("textarea");
  rightA.appendChild(taA);
  main.appendChild(leftA);
  main.appendChild(rightA);
  doc.activeElement = taA;
  calls.graph = 0;
  calls.side = 0;
  render();
  ok(colOf("lt-right") === rightA, "焦点在右栏输入里 → 右栏还是**同一个 DOM 节点**（没有重建、也没被摘出文档）");
  ok(rightA.contains(taA) && taA.parentNode === rightA, "那只理由框还在原位：焦点 / 选区 / 输入法组合态不被打断");
  ok(calls.side === 0, "右栏没有被重画（ltRenderSide 一次都没调）");
  ok(calls.graph === 1 && main.children.length === 2 && main.children[0].classList.contains("lt-left"), "左栏照常重建并排在右栏之前（运行态可视化不丢）");
  ok(main._cleared === 0, "这条路没有走 innerHTML = \"\"（整块重建）");

  /* B. 焦点在左栏输入里：这一栏同样留下，只重建右栏 */
  const rightB = mkEl("lt-right");
  const leftB = colOf("lt-left");
  const inpB = mkField("input");
  leftB.appendChild(inpB);
  doc.activeElement = inpB;
  calls.graph = 0;
  calls.side = 0;
  render();
  ok(colOf("lt-left") === leftB && leftB.contains(inpB), "焦点在左栏输入里 → 左栏原样留下（另一边：右栏照常跟着运行态重绘）");
  ok(calls.graph === 0 && calls.side === 1, "只重建了右栏");

  /* C. 没有可编辑焦点：维持原来的整块重建口径 */
  const oldRight = colOf("lt-right");
  doc.activeElement = doc.body;
  calls.graph = 0;
  calls.side = 0;
  render();
  ok(main._cleared === 1, "没有可编辑焦点 → 仍走 main.innerHTML = \"\" 整块重建（旧口径不变）");
  ok(colOf("lt-right") !== oldRight && calls.graph === 1 && calls.side === 1, "两栏都重建了");

  /* D. 条带里没有任务：仍是空态，不受影响 */
  const sb2 = sandboxFor(["ltEditHost", "ltFocusCol", "ltColOf", "ltRenderMain", "ltHoverHere"], {
    document: doc,
    LT_UI: { main: mkEl("lt-main") },
    ltActiveTask: () => null,
    ltEnabledTask: () => null,
    ltCurrentRun: () => null,
    ltEmptyState: () => mkEl("lt-empty"),
    ltEl: (tag, cls) => mkEl(cls || ""),
    ltRenderGraph: () => {},
    ltRenderSide: () => {},
    ltRenderWhenFocusLeaves: () => {},
    ltTrackCols: () => {},
    ltStripHoldNow: () => false,
  });
  vm.runInContext("ltRenderMain({ id: 'wf1' })", sb2);
  ok(sb2.LT_UI.main.children.length === 1 && sb2.LT_UI.main.children[0].classList.contains("lt-empty"), "没有长任务时照旧只画空态");

  /* E/F. 本次需求：焦点不在输入里，但「右栏里有一段框选出来的选区」/「鼠标正按在右栏文字上」，
         重绘也必须是「右栏原地留下、只重建左栏」—— 之前这两条路会走整块重建，被选中的
         节点整体被换掉，浏览器只能把选区收掉 = 「框选后立刻 defocus」。 */
  const calls3 = { graph: 0, side: 0 };
  const doc3 = mkDoc(null);
  const main3 = mkEl("lt-main");
  const sb3 = sandboxFor(["ltEditHost", "ltFocusCol", "ltSelInCol", "ltColHold", "ltColOf", "ltRenderMain", "ltHoverHere"], {
    document: doc3,
    LT_UI: { main: main3 },
    ltHoldColEl: null,
    ltActiveTask: () => ({ uid: "t1", graph: { nodes: [], edges: [] }, ver: 1 }),
    ltEnabledTask: () => null,
    ltCurrentRun: () => null,
    ltEmptyState: () => mkEl("lt-empty"),
    ltEl: (tag, cls) => {
      const e = mkEl(cls || "");
      e.tagName = String(tag || "div").toUpperCase();
      return e;
    },
    ltRenderGraph: (left) => {
      calls3.graph++;
      left.appendChild(mkEl("lt-graph"));
    },
    ltRenderSide: (right) => {
      calls3.side++;
      right.appendChild(mkEl("lt-card"));
    },
    ltRenderWhenFocusLeaves: () => {},
    ltTrackCols: () => {},
    ltStripHoldNow: () => false,
  });
  const render3 = () => vm.runInContext("ltRenderMain({ id: 'wf1' })", sb3);
  const colOf3 = (cls) => vm.runInContext("ltColOf(LT_UI.main, '" + cls + "')", sb3);
  const left3 = mkEl("lt-left");
  const right3 = mkEl("lt-right");
  const txt3 = mkEl("lt-fh"); /* 右栏里一段只读文字（检查器正文 / 待办卡提示） */
  right3.appendChild(txt3);
  main3.appendChild(left3);
  main3.appendChild(right3);

  doc3.activeElement = doc3.body;
  doc3.getSelection = () => mkSel(txt3, txt3, false);
  calls3.graph = 0;
  calls3.side = 0;
  render3();
  ok(colOf3("lt-right") === right3, "右栏里有活的选区（框选只读文字）→ 右栏还是**同一个 DOM 节点**：选区不会被冲掉");
  ok(right3.contains(txt3) && txt3.parentNode === right3, "被选中的那段文字原地留着（选区锚点没被摘出文档）");
  ok(main3._cleared === 0 && calls3.side === 0, "这条路没走整块重建、右栏一次都没重画");
  ok(calls3.graph === 1, "左栏照常重建（运行态可视化一条都不丢）");

  /* F. 鼠标正按在右栏文字上（框选刚起手、选区还没成形）：同样不许重建 */
  doc3.getSelection = () => mkSel(null, null, true);
  sb3.ltHoldColEl = right3;
  calls3.graph = 0;
  calls3.side = 0;
  render3();
  ok(colOf3("lt-right") === right3 && main3._cleared === 0, "鼠标正按在右栏文字上 → 右栏照旧原地留下（mousedown 的落点不会被换掉，拖拽选中的手势不作废）");
  ok(calls3.graph === 1 && calls3.side === 0, "只重建左栏");

  /* 松手 + 选区折叠（点别处 / Esc）→ 回到整块重建的老口径，界面不会长期冻结 */
  sb3.ltHoldColEl = null;
  calls3.graph = 0;
  calls3.side = 0;
  render3();
  ok(main3._cleared === 1 && colOf3("lt-right") !== right3 && calls3.graph === 1 && calls3.side === 1, "选区折叠 / 松手后 → 立刻回到整块重建的老口径（运行态更新不会被长期冻结）");
}

console.log("\n[4] 推迟的那一次重绘：打字 / 框选 / 按住都放开了才补，且只挂一轮监听");
{
  const doc = mkDoc(null);
  const main = mkEl("lt-main");
  const left = mkEl("lt-left");
  const right = mkEl("lt-right");
  const ta = mkField("textarea");
  const txt = mkEl("lt-fh"); /* 右栏里一段只读文字（框选它的场景） */
  right.appendChild(ta);
  right.appendChild(txt);
  main.appendChild(left);
  main.appendChild(right);
  const calls = { strip: 0 };
  const sb = sandboxFor(
    ["ltEditHost", "ltFocusCol", "ltSelInCol", "ltColHold", "ltColHoldNow", "ltRenderFlushDeferred", "ltFocusInside", "ltColOf", "ltRenderWhenFocusLeaves"],
    {
      document: doc,
      LT_UI: { main },
      ltRenderWait: false,
      ltRenderWaitOff: null,
      ltHoldColEl: null,
      ltRenderStrip: () => {
        calls.strip++;
      },
    },
  );
  const arm = () => vm.runInContext("ltRenderWhenFocusLeaves()", sb);
  const listeners = () => doc.listeners.map((l) => l.type).sort().join(",");
  const WATCH_TYPES = "focusout,keyup,pointerup,selectionchange";

  doc.activeElement = ta;
  arm();
  arm();
  ok(doc.listeners.filter((l) => l.type === "focusout").length === 1, "只挂一条 focusout 监听（反复重绘不会越挂越多）");
  ok(doc.listeners[0].capture === true, "挂在捕获阶段（早于各处自己的失焦处理）");
  ok(listeners() === WATCH_TYPES, "四类监听各一条（focusout / selectionchange / pointerup / keyup），不重复挂");
  doc.emit("focusout");
  ok(calls.strip === 0, "焦点还在右栏输入里 → 不补重绘（用户还在打字，绝不重建这一栏）");
  doc.activeElement = doc.body;
  doc.emit("focusout");
  ok(calls.strip === 1, "焦点离开两栏 → 补一次完整重绘（运行态更新一条都不丢）");
  ok(doc.listeners.length === 0, "补完自己摘掉监听（不留悬挂）");
  /* 点栏内按钮：焦点移到按钮上（还在栏内）→ 先不补，免得把按钮在 mouseup 之前拆掉 */
  doc.activeElement = ta;
  arm();
  const btn = mkEl("lt-btn");
  right.appendChild(btn);
  doc.activeElement = btn;
  doc.emit("focusout");
  ok(calls.strip === 1 && listeners() === WATCH_TYPES, "点栏内按钮（焦点移到同栏按钮）→ 先不补重绘，让这次 click 落得下去");
  doc.activeElement = doc.body;
  doc.emit("focusout");
  ok(calls.strip === 2, "点完离开这一栏 → 再补上（面板不会一直停在旧状态）");

  /* 本次需求：焦点不在栏里、但右栏里留着一段框选出来的选区 → 重绘继续等，
     选区折叠（点别处 / Esc，selectionchange）那一刻才兑现 —— 框选期间运行态更新不丢、选区也不丢 */
  doc.getSelection = () => mkSel(txt, txt, false);
  arm();
  doc.emit("selectionchange");
  ok(calls.strip === 2, "右栏里还有活的选区 → 不补重绘（框选的那段文字原地留着，不会被换掉）");
  doc.getSelection = () => mkSel(txt, txt, true);
  doc.emit("selectionchange");
  ok(calls.strip === 3, "选区一折叠（点别处 / Esc）→ 立刻兑现这次重绘，界面不长期冻结");
  ok(doc.listeners.length === 0, "兑现后监听摘干净");

  /* 鼠标还按在右栏文字上（框选刚起手）→ 也等；松手（pointerup）那一刻兑现 */
  sb.ltHoldColEl = right;
  arm();
  doc.emit("pointerup");
  ok(calls.strip === 3, "鼠标还按着（pointerup 之前）→ 不补重绘：mousedown 的落点与拖拽手势都不会被打断");
  sb.ltHoldColEl = null;
  doc.emit("pointerup");
  ok(calls.strip === 4, "松手 → 兑现重绘（ltHoldRelease 与这条监听任一路都能收口）");
}

console.log("\n[5] 症状对照（快捷键只是症状，不是起因）");
{
  ok(
    LTV.indexOf('if (type === "reasoning") st.think = 1;') > 0 &&
      LTV.indexOf("      ltRenderStripSoon();\n    },\n  };") > 0,
    "Agent 流式事件的 onEvent 逐帧叫重绘（app-longtask.js）——右栏被重建的密度来源",
  );
  ok(
    LTV.indexOf("function ltRenderStripSoon()") > 0 && LTV.indexOf("}, 90);") > 0,
    "这条重绘仍走 90ms 节流入口（依旧很密，所以只能靠「不许重建正在输入的那一栏」来治）",
  );
  ok(
    KEYS.indexOf("isEditableEl(ev.target) || isEditableEl(document.activeElement)") > 0,
    "顶栏快捷键只在「焦点还在可编辑元素里」时让位（app-keys.js）——失焦之后它才开始生效",
  );
  const mainBody = fnBody(LTU, "ltRenderMain");
  ok(
    mainBody.indexOf('main.innerHTML = ""') > 0 && mainBody.indexOf("ltRenderWhenFocusLeaves();") > 0,
    "整块重建那条路仍在，只是被推迟到焦点离开之后（两条口径并存，不是删掉重绘）",
  );
}

console.log(
  fails
    ? "\n " + fails + " / " + checks + " 项失败  (smoke-longtask-refocus)"
    : "\n✓ " + checks + " 项全部通过  (smoke-longtask-refocus)",
);
process.exit(fails ? 1 : 0);