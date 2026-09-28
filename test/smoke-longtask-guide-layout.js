"use strict";
/* 新建长周期任务窗「引导建图」布局回归 —— 发送框在下方 + 可往下拖高 + 开窗清空会话
 *   node test/smoke-longtask-guide-layout.js
 *
 * 用户报障（本次需求）：新建长周期任务窗里，会话消息的**发送**要放在下方（左栏最后一格），
 *   而不是溜到窗口右边去（用户原话：发送在右侧、出界）——同时会话仍是每次清空。
 *
 * 口径（本文件就是它的回归口径，真源 = renderer/app-longtask-guide.js + css/longtask.css）：
 *   [1] 布局顺序：DOM 里 conv → split → row（消息流在上、分隔条压在发送框上沿、发送行最后一格），
 *       .ltg-left 是 flex 列 —— 发送整行待在左栏里，绝不压到右栏上
 *   [2] 出界根因（用户报障的那一条）：发送行的输入框必须是**可收缩**的
 *       （inline flex:1 1 auto，不是 flex:none）；CSS 里 .ltg-left 兜一道 overflow-x ——
 *       两条一起钉住「按钮永远不越出左栏」（用 clip，不是 hidden：见 [7]）
 *   [3] 拖高：分隔条真接线（vm 真跑 ltgSplitBind）—— 往下拖变高、往上拖变矮、
 *       上下限夹住、双击回默认；拖动中整窗光标 / 禁选
 *   [4] 清空会话：开窗 LTG.sid 置空且 ltgMount 不再认领旧引导会话；契约写明「全新会话」
 *   [5] 样式：输入框高度只由 inline 表达（CSS 里不再有 max-height / resize:vertical 打架）；
 *       宽度铺满左栏（inline + CSS 同写 100%）
 *   [6] 上一轮修复：会话区（.ltg-conv）与右栏（.ltg-right）滚动条槽恒定预留 ——
 *       空窗没有滚动条、发出第一条消息那一刻才第一次冒出来的「点击瞬间一条滚动条」
 *   [7] 本次修复（[6] 之后仍在的那一条）：鼠标**按下**发送键那一帧出的滚动条 ——
 *       .ltg-left 的 overflow-x:hidden 被规范把另一轴抬成 auto（隐式纵向滚动容器），
 *       全局 button:active 的 1px 按下位移就够它溢出 1px 冒滚动条；改 overflow-x:clip 后不再出
 * 只读断言 + 迷你 DOM，不起 Electron、不改任何文件。
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

const LTG = read("renderer/app-longtask-guide.js");
const CSS = read("renderer/css/longtask.css");
/* 结构断言要用「去过注释」的那份：规则里的说明文字常常自带 { }（例如 CSS 注释里举例写
   button:active { transform: translateY(1px) }），用 [^}]* 取规则体会在注释里那个 } 处截断，
   「这条规则到底写了什么」就量错了；注释类断言继续用带注释的 CSS。 */
const CSSR = CSS.replace(/\/\*[\s\S]*?\*\//g, "");
const ruleOf = (sel) =>
  (CSSR.match(
    new RegExp("(^|\\n)" + sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{[^}]*\\}"),
  ) || [""])[0];

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
/* 迷你 DOM：够这只回归用（style / classList / 事件 / 尺寸量测 / setPointerCapture） */
function mkEl(tag, cls) {
  const classes = new Set(String(cls || "").split(/\s+/).filter(Boolean));
  const el = {
    nodeType: 1,
    tagName: String(tag || "div").toUpperCase(),
    className: cls || "",
    style: {},
    children: [],
    dataset: {},
    attrs: {},
    handlers: {},
    offsetHeight: 0,
    classList: {
      add: (c) => classes.add(String(c)),
      remove: (c) => classes.delete(String(c)),
      contains: (c) => classes.has(String(c)),
      toggle: (c, on) => (on ? classes.add(String(c)) : classes.delete(String(c))),
    },
    addEventListener(type, fn) {
      (this.handlers[type] = this.handlers[type] || []).push(fn);
    },
    removeEventListener() {},
    setAttribute(k, v) {
      this.attrs[k] = String(v);
    },
    getAttribute(k) {
      return this.attrs[k] == null ? null : this.attrs[k];
    },
    setPointerCapture() {},
    releasePointerCapture() {},
    appendChild(c) {
      this.children.push(c);
      return c;
    },
    emit(type, ev) {
      for (const fn of (this.handlers[type] || []).slice()) fn(ev || {});
    },
  };
  /* 迷你元素也要「量得到自己当下的高度」：真下载入用 offsetHeight 换高时，
     inline height 一改，量出来的值立刻跟着变（本例就是拖拽以当下高度为基准那份逻辑）。 */
  let _h = 0;
  Object.defineProperty(el, "offsetHeight", {
    get() {
      const n = parseInt(String(el.style.height || ""), 10);
      return n > 0 ? n : _h;
    },
    set(v) {
      _h = Number(v) || 0;
    },
  });
  return el;
}
function sandboxFor(names, extra) {
  /* 常量与那个模块级高度变量（let 不会成为沙箱对象的属性，读高度走 getH） */
  const consts = LTG.slice(
    LTG.indexOf("const LTG_TA_MIN"),
    LTG.indexOf("function ltgInputApply"),
  );
  const body = { console, Math, Number, String, Object, JSON, isFinite };
  vm.createContext(body);
  vm.runInContext(consts, body);
  const sb = Object.assign(body, {
    document: { body: mkEl("body") },
    /* 窗口高度给一个足够大的值（上限 = min(520, 半屏)，这样固定上限 520 才生效） */
    window: { innerHeight: 2000 },
    isFinite,
    console,
    Math,
    Number,
    String,
    Object,
    JSON,
  });
  vm.createContext(sb);
  for (const n of names) vm.runInContext(fnBody(LTG, n), sb);
  return sb;
}
/* 读高度（沙箱里的 let 不挂在对象上，走 runInContext 求值） */
function getH(sb) {
  return vm.runInContext("LTG_INPUT_H", sb);
}

console.log("\n[1] 布局顺序：会话消息的发送框在下方（左栏最后一格）");
{
  ok(
    /\.ltg-left\s*\{[^}]*flex-direction:\s*column;/.test(CSS),
    ".ltg-left 是 flex 列（DOM 顺序即上下顺序）",
  );
  const mount = LTG.slice(LTG.indexOf("function ltgMount(wf) {"), LTG.indexOf("function ltgHookRepaint()"));
  const iRow = mount.indexOf("left.appendChild(row)");
  const iSplit = mount.indexOf("left.appendChild(split)");
  const iConv = mount.indexOf("left.appendChild(conv)");
  ok(iConv > 0 && iSplit > iConv, "对话区（conv）先挂，分隔条紧跟其后（消息流在上）");
  ok(iRow > iSplit, "输入行（row）挂在分隔条之后 —— 发送框在下方，不是顶部");
  ok(mount.indexOf("box.appendChild(left)") > iRow, "三者都挂在左栏里（不是别处）");
  ok(/\.ltg-split\s*\{[^}]*cursor:\s*ns-resize;/.test(CSS), "分隔条光标是上下拖（ns-resize）");
  ok(
    /\.ltg-conv\s*\{[^}]*overflow:\s*auto;/.test(CSS) && /\.ltg-conv\s*\{[^}]*min-height:\s*0;/.test(CSS),
    "对话区自己滚 + min-height:0（空间不够时让位给发送框，绝不把发送框顶出窗口）",
  );
  ok(mount.indexOf("box.appendChild(right)") > iRow, "右栏（状态 / 图摘要 / 出口）仍在左栏之后 —— 发送行不占它的位置");
}

console.log("\n[2] 出界根因：发送行不许越出左栏压在右栏上（用户报障那一条）");
{
  /* 真根因（无头浏览器实测过）：inline 写 flex:none 时，textarea 以**默认内在宽（约 20 列）**
     为 flex 基准而压不下去 —— 框独占整行、发送按钮被挤出左栏，正好落在右侧那栏上
     （左栏 100..1130，按钮被算到 1138..1184，而右栏是 1140..1470）。
     两条一起钉：① inline 的 flex 必须可收缩；② 左栏自己兜 horizontal overflow。 */
  ok(
    /function ltgInputApply[\s\S]{0,400}?style\.flex = "1 1 auto"/.test(LTG),
    "ltgInputApply 写 inline flex:1 1 auto（可收缩 —— flex:none 会把发送按钮挤出左栏）",
  );
  ok(
    !/style\.flex = "none"/.test(LTG),
    "全模块没有 style.flex = \"none\" 的回潮（那正是出界根因）",
  );
  const leftRule2 = ruleOf(".ltg-left");
  ok(
    leftRule2.indexOf("overflow-x: clip") >= 0,
    ".ltg-left 兜 overflow-x:clip（横向任何情况都不越出左栏；clip 不是滚动容器，纵轴仍归 flex）",
  );
  ok(
    leftRule2.indexOf("overflow-x: hidden") < 0,
    ".ltg-left 不再用 overflow-x:hidden（hidden 会把另一轴抬成 auto = 隐形纵向滚动容器，见 [7]）",
  );
  const taCss = (CSS.match(/(^|\n)\.ltg-ta\s*\{[^}]*\}/) || [""])[0];
  ok(taCss.indexOf("flex: 1 1 auto") >= 0, "CSS 那份 .ltg-ta 也是 flex:1 1 auto（与 inline 同口径，不反压）");
  const rowCss = (CSS.match(/(^|\n)\.ltg-row\s*\{[^}]*\}/) || [""])[0];
  ok(
    rowCss.indexOf("width: 100%") >= 0 && rowCss.indexOf("min-width: 0") >= 0,
    ".ltg-row 整行占满左栏（width:100% + min-width:0，不被长内容撑破）",
  );
}

console.log("\n[3] 拖高：往下拖变高、上下限夹住、双击回默认（vm 真跑）");
{
  const sb = sandboxFor(["ltgInputClamp", "ltgInputApply", "ltgSplitBind"]);
  const ta = mkEl("textarea", "ltg-ta");
  ta.offsetHeight = 108;
  const split = mkEl("div", "ltg-split");
  vm.runInContext("ltgSplitBind", sb)(split, ta);
  ok(getH(sb) === 108, "默认高度 108px（比旧版 54px 高，第一眼就够写）");
  ok(!split._ltgSplitBound === false && split.handlers.pointermove.length > 0, "分隔条已接线（pointerdown / move / up）");
  /* 按下（起点 y=400，此刻高度 108px），再往下拖 200px：输入框变高。
     方向口径：分隔条挂在输入框的**下沿**，往下拖 = 输入框变高，所以高度增量是
     「按下点到当下点的位移取反」—— 起点 y=400 拖到 y=200 就是变高 200px。 */
  split.emit("pointerdown", { button: 0, clientY: 400, pointerId: 1, preventDefault() {}, stopPropagation() {} });
  ok(split.classList.contains("dragging"), "按下即进拖动态（视觉 + 整窗光标）");
  ok(sb.document.body.classList.contains("ltg-split-drag"), "拖动中 body 带 ltg-split-drag（光标锁 ns-resize、禁选）");
  split.emit("pointermove", { clientY: 200, preventDefault() {} });
  ok(getH(sb) === 308, "往下拖 200px → 108 + 200 = 308px（拖多少长多少）");
  ok(ta.style.height === "308px" && ta.style.flex === "1 1 auto", "高度写在 inline style 上（flex:1 1 auto + px），CSS 不打架");
  ok(ta.style.width === "100%", "宽度也写在 inline style 上（可收缩的 flex 基准就是这份 100%，框铺满除「发送」外的全部宽度）");
  /* 继续往下拖：上限夹住 */
  split.emit("pointermove", { clientY: -4000, preventDefault() {} });
  ok(getH(sb) === 520, "拖过头 → 夹在上限 520px（不把消息流挤没）");
  /* 第二次按下（起点 y=600，此刻高度 = 520px，量自 inline 高度）：往上拖 80px 变矮。
     以「当下实际高度」为基准，不跳回旧值 —— 这就是拖手的那份逻辑。 */
  split.emit("pointerdown", { button: 0, clientY: 600, pointerId: 3, preventDefault() {}, stopPropagation() {} });
  split.emit("pointermove", { clientY: 680, preventDefault() {} });
  ok(getH(sb) === 440, "往上拖 80px → 520 − 80 = 440px（以当下高度为基准，不跳回旧值）");
  split.emit("pointermove", { clientY: 1000, preventDefault() {} });
  ok(getH(sb) === 120, "再往上拖 400px → 520 − 400 = 120px（这一段还没到下限）");
  split.emit("pointermove", { clientY: 1200, preventDefault() {} });
  ok(getH(sb) === 72, "继续往上拖 200px → 算出来低于下限 → 夹在 72px（绝不把框压没）");
  split.emit("pointermove", { clientY: 1800, preventDefault() {} });
  ok(getH(sb) === 72, "下限之下再往上拖仍是 72px（不抖、不归零）");
  /* 松手：退出拖动态 */
  split.emit("pointerup", { pointerId: 3 });
  ok(!split.classList.contains("dragging") && !sb.document.body.classList.contains("ltg-split-drag"), "松手退出拖动态（光标 / 禁选还原）");
  split.emit("pointermove", { clientY: 100, preventDefault() {} });
  ok(getH(sb) === 72, "松手后再移动指针不再改高度（不误触）");
  /* 双击回默认 */
  split.emit("dblclick", { preventDefault() {} });
  ok(getH(sb) === 108, "双击分隔条回到默认高度 108px");
  ok(ta.style.height === "108px", "回默认也落到 inline style 上");
  /* 右键 / 非主键不进入拖动 */
  split.emit("pointerdown", { button: 2, clientY: 100, pointerId: 9 });
  ok(!split.classList.contains("dragging"), "右键按下不进拖动态（只认主键）");
}

console.log("\n[4] 清空会话：开窗一律全新会话（不接回上一条引导会话）");
{
  const mount = LTG.slice(LTG.indexOf("function ltgMount(wf) {"), LTG.indexOf("function ltgHookRepaint()"));
  ok(mount.indexOf("ltgFindSession(") < 0, "ltgMount 不再调用 ltgFindSession（不认领旧会话）");
  ok(mount.indexOf('sid: "",') > 0, "LTG.sid 起始为空 = 空对话开窗");
  ok(mount.indexOf("ltgPaint(null)") > 0, "开窗按「没有会话」重绘（消息流为空态，不是上一条的尾巴）");
  ok(mount.indexOf("ltgCreateAgentSet") < 0, "不再用旧会话的选型回填（选型只认「Agent 选型」那一栏）");
  ok(LTG.indexOf("function ltgFindSession(wf)") > 0, "判据函数本身还在（契约标记认领仍可复用，只是本窗不再调用）");
  ok(
    LTG.indexOf("本窗每次打开都是一条全新会话（不继承上一条引导会话的上下文）") > 0,
    "契约写明「全新会话」（模型不会自称接着上次聊）",
  );
  ok(LTG.indexOf("const LTG_FRESH_NOTE") > 0 && LTG.indexOf("LTG_FRESH_NOTE +") > 0, "契约正文引用了这条说明（单一真源）");
  ok(LTG.indexOf("每次打开本窗都是全新会话") > 0, "右侧说明向用户讲清：本窗不接回、旧会话留左侧栏作历史");
  ok(LTG.indexOf("这条引导会话留在左侧栏只作历史") > 0, "「稍后」出口的文案同步（不再说「下次打开接着聊」）");
}

console.log("\n[5] 样式：输入框高度只由 inline 表达（CSS 不设死 height / max-height）");
{
  const ta = (CSS.match(/(^|\n)\.ltg-ta\s*\{[^}]*\}/) || [""])[0];
  ok(ta.indexOf("min-height") >= 0, ".ltg-ta 兜一个下限（inline 高度还没落上的那一帧不被压没）");
  ok(ta.indexOf("max-height") < 0, ".ltg-ta 不写 max-height（拖高的结果由 inline 说了算，不会被 CSS 反压回去）");
  ok(ta.indexOf("resize: none") >= 0, "resize:none —— 上面那条 .ltg-split 是唯一拖高入口");
  ok(CSS.indexOf(".ltg-ta") === CSS.lastIndexOf(".ltg-ta") || CSS.split(".ltg-ta {").length === 2, "旧的一份 .ltg-ta 规则已删净（不留后一份反压）");
  /* 宽度：输入框要铺满左栏（用户报障「输入框未占满宽度」）—— inline 与 CSS 各兜一份同值 */
  ok(ta.indexOf("width: 100%") >= 0, ".ltg-ta 写 width:100%（inline 缺席的那一帧仍有宽度）");
  ok(/function ltgInputApply[\s\S]{0,400}?style\.width = "100%"/.test(LTG), "ltgInputApply 同时写宽度 100%（与高度同一处，拖高 / 开窗都走它）");
}

console.log("\n[6] 本次修复：会话区滚动条槽恒定预留（点发送瞬间不再冒出一条滚动条）");
{
  /* 用户报障：长任务新建窗里，消息框点「发送」的那一瞬间，右侧会冒出一条滚动条。
     实测根因（真跑应用 + 逐帧量 offsetWidth-clientWidth）：空窗时消息流装得下、
     一条滚动条都没有；发出第一条消息后内容一高，.ltg-conv 的 12px 竖直滚动条**第一次**
     出现 —— 正好压在那只发送按钮的右侧，同时还把消息挤窄 10px（内容宽度抖动）。
     口径：滚动条槽恒定预留（与 .n-prompt / .fp-scroll 同款）；不隐藏滚动条本身。 */
  const conv = (CSS.match(/(^|\n)\.ltg-conv\s*\{[^}]*\}/) || [""])[0];
  ok(conv.indexOf("scrollbar-gutter: stable") >= 0, ".ltg-conv 恒定预留滚动条槽（出不出滚动条内容宽度都一样）");
  ok(conv.indexOf("overflow: auto") >= 0, "滚动条本身不隐藏：消息多了照样能滚（只是不再突变出现）");
  const right = (CSS.match(/(^|\n)\.ltg-right\s*\{[^}]*\}/) || [""])[0];
  ok(right.indexOf("scrollbar-gutter: stable") >= 0, ".ltg-right 同一口径（图摘要 / 提示长出来时宽度不抖）");
  ok(
    /点发送/.test(CSS.slice(CSS.indexOf(".ltg-conv {"), CSS.indexOf(".ltg-conv {") + 700)),
    "CSS 注释写明这条是为「点发送瞬间冒滚动条」修的（后来人不会当噪音删掉）",
  );
}

console.log("\n[7] 本次修复：按下发送键的那一帧不再冒出滚动条（左栏不是隐式滚动容器）");
{
  /* 用户报障（[6] 修完仍在，即本条）：鼠标**按下**发送键的一瞬间，右侧出现一条滚动条。
     真跑应用 + CDP 在 mousePressed 那一帧量到（修复前）：
       .ltg-left clientWidth 1028 → 1018（多出 10px 竖直滚动条）、scrollHeight 507 → 508；
       .ltg-row scrollHeight 108 → 109；按下按钮 computed transform = translateY(1px)。
     根因链 = 全局 button:active 的 1px 按下位移 × 左栏被 CSS 规范抬成纵向滚动容器：
       ① 全局 `button:active { transform: translateY(1px) }`（css/layout.css）让发送按钮
          ——左栏最后一格——的下沿在按下那一帧多出 1px；
       ② `.ltg-left` 原先写 overflow-x:hidden，而「一轴 hidden ⇒ 另一轴的 visible 变 auto」
          让它成了纵向滚动容器 → 那 1px 就够它出滚动条（10px 宽，紧贴发送按钮右缘）。
     口径：左栏写成 overflow-x:clip（不是滚动容器）+ 留 1px 下内边距（按下位移落进这一格，
     按钮下沿不再被裁）。修复后同一探针：按下那一帧 .ltg-left 1028/1028、sh=ch=507、
     按钮下沿正好落在余量里（越出 0），窗内无任何元素新增滚动条。
     滚动条本身没有被隐藏：消息多时仍由 .ltg-conv 自己滚（[6] 的滚动条槽照旧）。 */
  const left = ruleOf(".ltg-left");
  ok(left.indexOf("overflow-x: clip") >= 0, ".ltg-left overflow-x:clip —— 横轴裁住但不成为滚动容器");
  ok(left.indexOf("overflow-y") < 0, ".ltg-left 不写 overflow-y（纵轴保持 visible，任何 1px 生长都不出滚动条）");
  ok(
    left.indexOf("padding-bottom: 1px") >= 0,
    "左栏留 1px 下内边距 —— 按下那 1px 落进这一格（不越界、也不被 clip 裁掉按钮下沿）",
  );
  /* 注释里的根因（带注释的那份 CSS） */
  const leftDoc = CSS.slice(CSS.indexOf(".ltg-left {"), CSS.indexOf(".ltg-left {") + 1200);
  ok(
    /button:active/.test(leftDoc) && /translateY\(1px\)/.test(leftDoc),
    "CSS 注释写明按下位移这条真根因（后来人不会把它当噪音删掉）",
  );
  ok(leftDoc.indexOf("鼠标按下瞬间") >= 0, "CSS 注释写明这条是为「点发送、鼠标按下瞬间冒滚动条」修的");
  /* 1px 生长源确实还在全局样式里：这条修复不是为一条已经消失的规则留的 */
  const LAYOUT = read("renderer/css/layout.css");
  ok(
    /button:active\s*\{[^}]*transform:\s*translateY\(1px\)/.test(LAYOUT),
    "全局 button:active 的 translateY(1px) 仍在（css/layout.css）—— 左栏必须自己扛住这 1px",
  );
  /* 别用「删掉按下位移」绕开：发送键的按下反馈要保留 */
  ok(
    !/\.ltg[\s\S]{0,200}?:active\s*\{[^}]*transform:\s*none/.test(CSS),
    "没有用「删掉按下位移」绕（发送键的按下反馈保留）",
  );
  const conv = (CSS.match(/(^|\n)\.ltg-conv\s*\{[^}]*\}/) || [""])[0];
  ok(conv.indexOf("scrollbar-gutter: stable") >= 0, "[6] 的会话区滚动条槽没被这次修复撤掉（消息多了照样能滚）");
}

console.log(
  fails
    ? "\n " + fails + " / " + checks + " 项失败  (smoke-longtask-guide-layout)"
    : "\n✓ " + checks + " 项全部通过  (smoke-longtask-guide-layout)",
);
process.exit(fails ? 1 : 0);