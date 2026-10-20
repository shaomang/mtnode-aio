"use strict";
/* 画布视图记忆（切 Tab 回到离开时的那一层）回归冒烟测试 —— 纯 Node，不依赖 Electron
 *   node test/smoke-wf-view-memory.js
 *
 * 背景（本轮修的 bug）：「在哪一层」与「相机看到哪」过去是全局一份：
 *   ① 切画布走 renderer/app.js 的 loadWorkflow → resetTaskFocus()，把任务子画布焦点
 *      （S.taskFocus）与节点层 focus 子画布（S.superFocus）一把清零；
 *   ② 相机 S.cam 跨画布共享，切过去的画布顶着上一张的平移量。
 * 于是「钻在节点层 / 任务的子画布里干活 → 切去看别的画布 → 切回来」每次都站在
 * 根画布的陌生位置，得重新钻一遍壳。
 * 现在按画布 id 各记一份（S.wfViews，只存内存不落盘），交接点唯一 = setForegroundWf：
 * 离开谁存谁的、成为前台套用自己的；记录的层已被删掉时按返回栈由深到浅逐层退，
 * 全没了才回根画布（绝不把不存在的 id 当 focus —— 那会让可见集整个空掉 = 白屏）。
 *
 * 覆盖：
 *   [1] 真实源码切片跑视图交接：壳 focus + 相机 → 切走 → 切回来原位还在
 *   [2] 任务子画布 focus 同样保留；两种 focus 同时在场各自回位；切换不触发重绘
 *   [3] 层被删：由深到浅退到还活着的父壳；全没了回根画布（不白屏）；kind 变了不认
 *   [4] 没有记忆 = 本会话第一次打开：停在根画布、相机不动（不擅自居中）
 *   [5] 新建 / 导入画布不再继承上一张的 focus（老漏洞：整张画布空白）
 *   [6] 删除画布连带丢记忆；已删画布不留记忆（同名重建不吃旧位置）
 *   [7] 源码口径静态核对：交接点唯一、切画布路径不再有 resetTaskFocus、
 *       只存内存（不进画布 JSON 也不进 config）、后台换画布编辑不经这里 */
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
const eq = (a, b, msg) =>
  ok(
    a === b,
    msg + "（得到 " + JSON.stringify(a) + "，期望 " + JSON.stringify(b) + "）",
  );
const read = (rel) =>
  fs
    .readFileSync(path.join(__dirname, "..", rel.split("/").join(path.sep)), "utf8")
    .replace(/\r\n?/g, "\n");

/* ---------- 从源码里按名字抠出顶层函数（不改动源文件） ---------- */
function fnBody(src, name) {
  const p = new RegExp("\\n(?:async\\s+)?function " + name + "\\s*\\(", "m");
  const m = src.match(p);
  if (!m) throw new Error("找不到函数：" + name);
  const at = m.index + 1;
  const i = src.indexOf("{", at);
  if (i < 0) throw new Error("找不到函数体：" + name);
  let depth = 0;
  let inStr = null;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    const p2 = src[j - 1];
    if (inStr) {
      if (c === inStr && p2 !== "\\") inStr = null;
      continue;
    }
    if (c === "/" && src[j + 1] === "/") {
      j = src.indexOf("\n", j) - 1;
      continue;
    }
    if (c === "/" && src[j + 1] === "*") {
      j = src.indexOf("*/", j) + 1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      inStr = c;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (!depth) return src.slice(at, j + 1);
    }
  }
  throw new Error("函数体不完整：" + name);
}

const appSrc = read("renderer/app.js");
/* 注释里会写到被废掉的旧调用（「这里过去是一句 resetTaskFocus()」），
   静态核对「这条路径上不再出现该调用」时必须先把注释剥掉，否则是自证清白。 */
const codeOnly = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
const NAMES = [
  "nodeByIdIn",
  "taskAncestorChain",
  "setTaskFocus",
  "setSuperFocus",
  "resetSuperFocus",
  "resetTaskFocus",
  "levelViewKeyOf",
  "levelViewStore",
  "levelViewOf",
  "rememberLevelView",
  "centerLayerView",
  "restoreLevelView",
  "rememberWfView",
  "aliveWfFocus",
  "applyWfView",
  "forgetWfView",
  "setForegroundWf",
];
const sliced = NAMES.map((n) => fnBody(appSrc, n)).join("\n");

const ctx = {
  S: null,
  renderCount: 0,
  crumbCount: 0,
  transformCount: 0,
  fitCount: 0,
  toast: () => {},
  I18n: { t: (s) => s },
  console,
};
const BOOT = `
  function nodeById(id) { return nodeByIdIn(id, S.wf); }
  function renderTaskCrumb() { crumbCount++; }
  function renderCanvas() { renderCount++; }
  function renderStatus() {}
  function wfWriteBlocked(wf) { return !!(wf && S.deadIds[String(wf.id)]); }
  function $(sel) { return S.viewport || { clientWidth: 1000, clientHeight: 700 }; }
  function applyTransform() { transformCount++; }
  function updateWires() {}
  function canvasWorldBounds() { return S.bounds || null; }
  /* 「一键居中」的口径不在这里验（另有冒烟），只记一笔并把相机摆成一个可辨认的值 */
  function fitCanvas() { fitCount++; S.cam.x = -1; S.cam.y = -2; S.cam.z = 0.5; }
${sliced}
  this.API = {
    setForegroundWf, rememberWfView, applyWfView, forgetWfView,
    setTaskFocus, setSuperFocus, resetTaskFocus, resetSuperFocus,
    levelViewKeyOf, levelViewOf, rememberLevelView, centerLayerView, restoreLevelView
  };
`;

function mkState(wf) {
  return {
    cam: { x: 90, y: 80, z: 1 },
    sel: "stale",
    selSet: new Set(["stale"]),
    selWire: "stale",
    selGroup: "stale",
    taskFocus: "",
    taskStack: [],
    superFocus: "",
    superStack: [],
    wfViews: {},
    levelViews: {},
    _pendingLayerCenter: false,
    _noLevelViewSave: false,
    _capturingCanvas: false,
    wf,
    _fgWf: wf,
    deadIds: {},
  };
}
/* 每个用例一套干净状态：重建 vm 上下文，切到的真函数闭包读到的就是这份 S */
function fresh(wf) {
  ctx.S = mkState(wf);
  ctx.renderCount = 0;
  ctx.crumbCount = 0;
  ctx.transformCount = 0;
  ctx.fitCount = 0;
  vm.createContext(ctx);
  vm.runInContext(BOOT, ctx);
  return ctx.S;
}
/* 造一张画布：壳 s1 → 深壳 s1a（内有 kid1a）；任务 t1 → 子任务 t1a；外加游离节点 */
function mkWf(id) {
  const n = (nid, kind, parent) => ({
    id: nid,
    kind,
    title: nid,
    parentSuperId: (parent && parent.s) || "",
    parentTaskId: (parent && parent.t) || "",
    superOpen: false,
  });
  return {
    id,
    name: id,
    nodes: [
      n("root1", "proc_text", {}),
      n("s1", "super", {}),
      n("s1a", "super", { s: "s1" }),
      n("kid1a", "proc_text", { s: "s1a" }),
      n("t1", "task", {}),
      n("t1a", "task", { t: "t1" }),
    ],
    wires: [],
    groups: [],
    marks: [],
  };
}
const dropNode = (wf, id) => {
  wf.nodes = wf.nodes.filter((x) => x.id !== id);
};

console.log("\n[1] 节点层 focus + 相机：切走再切回来仍在原位");
{
  const A = mkWf("A");
  const B = mkWf("B");
  const S = fresh(A);
  /* 用户钻进 A 的深层壳，并平移缩放到自己的位置（返回栈由 setSuperFocus 现算） */
  ctx.API.setSuperFocus("s1a");
  eq(S.superStack.join(">"), "s1>s1a", "钻进深壳后返回栈是「浅 → 深」");
  S.cam.x = -1234;
  S.cam.y = -567;
  S.cam.z = 0.62;
  /* 切去 B：A 的视图被记下；B 没记忆 → 根画布 */
  ctx.API.setForegroundWf(B);
  eq(S.superFocus, "", "切到没有记忆的 B → 停在根画布");
  eq(S.taskFocus, "", "B 也没有任务 focus");
  /* 切回 A：层与相机都回到离开时那一刻 */
  ctx.API.setForegroundWf(A);
  eq(S.superFocus, "s1a", "切回 A 仍在离开时的那颗壳里");
  eq(S.superStack.join(">"), "s1>s1a", "返回栈按父链现算回来，面包屑能一层层退");
  eq(S.cam.x, -1234, "相机 x 原样回来");
  eq(S.cam.y, -567, "相机 y 原样回来");
  eq(S.cam.z, 0.62, "缩放原样回来");
  eq(Object.keys(S.wfViews).sort().join(","), "A,B", "记忆袋按画布 id 各存一份");
  /* 来回切不把记忆磨掉：还能再回同一层 */
  ctx.API.setForegroundWf(B);
  ctx.API.setForegroundWf(A);
  eq(S.superFocus, "s1a", "来回好几趟，A 那一层仍然认得");
}

console.log("\n[2] 任务子画布 focus 同样保留；两种 focus 各自回位");
{
  const A = mkWf("A");
  const B = mkWf("B");
  const S = fresh(A);
  ctx.API.setTaskFocus("t1a");
  eq(S.taskStack.join(">"), "t1>t1a", "任务返回栈现算");
  S.cam.x = 40;
  S.cam.y = 50;
  ctx.API.setForegroundWf(B);
  ctx.API.setForegroundWf(A);
  eq(S.taskFocus, "t1a", "切回 A 仍在离开时的那个任务里");
  eq(S.taskStack.join(">"), "t1>t1a", "任务返回栈一起回来");
  eq(S.cam.x, 40, "任务层的相机也原样回来");
  /* 壳 focus 与任务 focus 同时在场：两份都按记录套回，互不吞 */
  const C = mkWf("C");
  ctx.API.setForegroundWf(C);
  ctx.API.setTaskFocus("t1");
  ctx.API.setSuperFocus("s1");
  ctx.API.setForegroundWf(A);
  ctx.API.setForegroundWf(C);
  eq(S.taskFocus, "t1", "C 的任务 focus 回来");
  eq(S.superFocus, "s1", "C 的壳 focus 同时回来");
  /* 恢复路径自己不做重绘 / 居中：那是调用方 renderAll 的活 */
  const before = ctx.renderCount;
  ctx.API.setForegroundWf(A);
  ctx.API.setForegroundWf(C);
  eq(ctx.renderCount, before, "视图交接不触发 renderCanvas（不闪、不重排）");
  ok(ctx.crumbCount > 0, "面包屑跟着交接刷新过");
}

console.log("\n[3] 记录的那一层被删：由深到浅逐层退，全没了才回根画布");
{
  const A = mkWf("A");
  const B = mkWf("B");
  const S = fresh(A);
  ctx.API.setSuperFocus("s1a");
  ctx.API.setTaskFocus("t1a");
  ctx.API.setForegroundWf(B);
  /* 会话在 A 上删掉了最深的壳：应退到还在的父壳，而不是白屏 */
  dropNode(A, "s1a");
  ctx.API.setForegroundWf(A);
  eq(S.superFocus, "s1", "深壳没了 → 退到还活着的父壳");
  eq(S.taskFocus, "t1a", "没被动过的任务层照常回来");
  eq(S.superStack.join(">"), "s1", "退层后返回栈只剩活着的那一层");
  /* 连父壳也没了 → 回根画布（可见集不为空，这是白屏防线） */
  ctx.API.setForegroundWf(B);
  dropNode(A, "s1");
  ctx.API.setForegroundWf(A);
  eq(S.superFocus, "", "所有记录层都被删 → 回根画布");
  eq(S.superStack.length, 0, "返回栈跟着清空");
  ok(S.nodes === undefined && !!ctx.S.wf, "状态仍指向 A（回根画布不是掉到别处）");
  /* 任务层全没了同理 */
  ctx.API.setForegroundWf(B);
  dropNode(A, "t1a");
  dropNode(A, "t1");
  ctx.API.setForegroundWf(A);
  eq(S.taskFocus, "", "任务层全没了 → 回根画布");
  /* id 还在但 kind 已换（壳被改成普通节点）→ 不拿它当 focus */
  const D = mkWf("D");
  ctx.API.setForegroundWf(D);
  ctx.API.setTaskFocus("t1");
  ctx.API.setForegroundWf(B);
  D.nodes.find((x) => x.id === "t1").kind = "proc_text";
  ctx.API.setForegroundWf(D);
  eq(S.taskFocus, "", "kind 不再是 task → 不认这个 focus");
}

console.log("\n[4] 没有记忆（本会话第一次打开）：停在根画布、相机不动");
{
  const A = mkWf("A");
  const B = mkWf("B");
  const S = fresh(A);
  ctx.API.setSuperFocus("s1a");
  S.cam.x = 777;
  S.cam.y = 888;
  S.cam.z = 1.5;
  const before = ctx.renderCount;
  ctx.API.setForegroundWf(B);
  eq(S.superFocus, "", "B 第一次打开 → 根画布");
  eq(S.cam.x, 777, "B 没有记忆时相机沿用现值（居中推迟到画布真画出来的那一拍）");
  eq(S.cam.z, 1.5, "缩放同理不被改写");
  eq(S._pendingLayerCenter, true, "并记下一次「待居中」：等 renderCanvas 把节点摆好再取景");
  eq(ctx.renderCount, before, "交接不自己重绘");
}

console.log("\n[5] 新建 / 导入画布不继承上一张的 focus（老漏洞：整张画布空白）");
{
  const A = mkWf("A");
  const S = fresh(A);
  ctx.API.setSuperFocus("s1a");
  ctx.API.setTaskFocus("t1");
  /* createWorkflowNamed / newWorkflowDialog / adoptImportedWorkflow 的切换口径 */
  const NEW = { id: "NEW", name: "新画布", nodes: [], wires: [], groups: [], marks: [] };
  ctx.API.setForegroundWf(NEW);
  eq(S.superFocus, "", "新画布不带旧壳 focus（不带上一张的层级）");
  eq(S.taskFocus, "", "新画布不带旧任务 focus");
  eq(S._fgWf.id, "NEW", "前台真源落定在新画布");
  eq(S.sel, null, "切画布顺手收掉选择集（旧选择属于走掉那一张）");
  /* 去新画布走一趟，回来 A 还记得自己在哪 */
  ctx.API.setForegroundWf(A);
  eq(S.superFocus, "s1a", "新画布来回一趟，A 那一层没被冲掉");
  eq(S.taskFocus, "t1", "A 的任务层也没被冲掉");
}

console.log("\n[6] 删除画布连带丢记忆；已删画布不再被记进袋");
{
  const A = mkWf("A");
  const B = mkWf("B");
  const S = fresh(A);
  ctx.API.setSuperFocus("s1a");
  ctx.API.setForegroundWf(B);
  ok(!!S.wfViews.A, "A 离开时留下了视图记忆");
  ctx.API.forgetWfView("A");
  eq(S.wfViews.A, undefined, "forgetWfView 把被删画布的记忆摘掉");
  /* 同名重建：从根画布开始，不吃旧位置 */
  ctx.API.setForegroundWf(A);
  eq(S.superFocus, "", "同名重建的画布从根画布开始");
  /* 已删画布：切走时不该再留一份 */
  const C = mkWf("C");
  ctx.API.setForegroundWf(C);
  S.deadIds.C = true;
  ctx.API.setSuperFocus("s1");
  ctx.API.setForegroundWf(B);
  eq(S.wfViews.C, undefined, "已判死的画布不留记忆（它再也回不来）");
}

console.log("\n[7] 源码口径静态核对");
{
  const body = (name) => fnBody(appSrc, name);
  ok(/wfViews:\s*\{\}/.test(appSrc), "S 里登记了画布视图记忆袋 wfViews");
  const sfw = body("setForegroundWf");
  ok(
    /rememberWfView\(S\._fgWf\)/.test(sfw) && /applyWfView\(wf\)/.test(sfw),
    "交接点唯一：setForegroundWf 先存走掉那张、再套用新前台那份",
  );
  ok(
    sfw.indexOf("rememberWfView") < sfw.indexOf("S.wf = wf"),
    "记旧视图发生在换 S.wf 之前（否则存进去的是新画布的焦点）",
  );
  ok(
    !/resetTaskFocus\(\)/.test(codeOnly(body("loadWorkflow"))),
    "loadWorkflow 不再一把 resetTaskFocus()（切画布不再弹回根画布）",
  );
  ok(
    !/resetTaskFocus\(\)/.test(codeOnly(body("ensureWorkflow"))),
    "开机路径同样交给视图交接，不重复清零",
  );
  ok(/forgetWfView\(key\)/.test(body("forgetDeletedWf")), "删除画布收口时连带丢视图记忆");
  const mem = body("rememberWfView") + body("applyWfView") + body("forgetWfView");
  ok(
    !/wfSave|configSave|scheduleSave|S\.config\./.test(mem),
    "记忆只存内存：不写画布 JSON、不写 config（相机每帧都在变，落盘 = 把交互变磁盘 I/O）",
  );
  ok(!/fitCanvas|fitNodes/.test(body("applyWfView")), "恢复视图不擅自居中、不重排节点");
  ok(
    !/setForegroundWf|rememberWfView|applyWfView/.test(body("runAgainstWfInner")),
    "runAgainstWf 直改 S.wf，不经前台交接（后台编辑不串用户视图）",
  );
  ok(
    /n && n\.kind === kind/.test(body("aliveWfFocus")),
    "恢复只认「还在这张画布、kind 也对」的层（不存在的 id 绝不当 focus）",
  );
  ok(
    /resetSuperFocus\(\)[\s\S]*setTaskFocus\(""/.test(body("renderTaskCrumb")),
    "面包屑「画布」按钮仍是回根画布的显式出口（用户想出来还得能出来）",
  );
  ok(
    /superFocus: currentSuperFocus\(\)/.test(read("renderer/app-nodes.js")),
    "canvasSnapshot 的 superFocus / cam 真源未改（agent 仍读到实时所在层）",
  );
  const guide = read("guides/manual/workflows.md");
  const guideEn = read("guides/manual/en/workflows.md");
  ok(/标签条切换|标签条切回来|切标签页/.test(guide), "中文手册写了切 Tab 保留位置");
  ok(/tab bar keeps/i.test(guideEn), "英文手册同步");
}

console.log("\n[8] 往返外层：进了子任务必须回得来（本次修复）");
{
  /* 两个「回不去」的口子一起钉住：
     (a) 主画布面包屑 .task-crumb 是定宽（min(38%,380px)）+ overflow:hidden 的一行，
         路径条目一律 flex:none —— 层级一多 / 标题一长，最后那枚「← 返回」被整颗裁掉；
     (b) 进任务时若壳内焦点（superFocus）还活着，作用域判定里节点层优先，于是「进了
         子任务」画面仍是壳内部，而「← 返回」先退节点层（看着像又往里进一层）。 */
  const crumb = fnBody(appSrc, "renderTaskCrumb");
  ok(
    /path\.className = "task-crumb-path"/.test(crumb) && /el\.appendChild\(path\)/.test(crumb),
    "中间那段路径整体包进 .task-crumb-path（整行里唯一可压缩的一段）",
  );
  eq(
    (crumb.match(/path\.appendChild\(/g) || []).length,
    4,
    "任务链与壳链的「/ + 条目」四行都落进路径区（不再直接挂到定宽那一行上）",
  );
  ok(
    crumb.indexOf("const back") > crumb.lastIndexOf("path.appendChild(b)") &&
      /el\.appendChild\(back\)/.test(crumb),
    "「← 返回」挂在路径区之外：路径再窄也裁不到它（以前层级一多它就被裁没了）",
  );
  const css = read("renderer/css/canvas.css");
  ok(
    /\.task-crumb-path\s*\{[\s\S]{0,220}flex:\s*0 1 auto/.test(css),
    "路径区只收不放（内容短时不白占 38%，超宽时才压自己）",
  );
  ok(
    /\.task-crumb-item\s*\{[\s\S]{0,320}flex:\s*0 1 auto[\s\S]{0,80}min-width:/.test(css),
    "路径条目自身可压缩（配省略号收窄），而不是把返回钮挤出这一行",
  );
  const et = fnBody(appSrc, "enterTask");
  ok(
    /setSuperFocus\("", \{ render: false, noViewSave: true \}\)/.test(et),
    "进任务先放开壳内焦点：「返回」退一层就是外层，不再先退壳（看着像又往里进）",
  );
  ok(
    et.indexOf('setSuperFocus("", { render: false, noViewSave: true })') <
      et.indexOf("setTaskFocus(node.id"),
    "放开壳内焦点发生在设任务焦点之前（同一帧内不留「两层都活着」的中间态）",
  );
}

console.log("\n[9] 顶栏副标题 / 右下角版本号 / 面包屑搬进画布（本轮需求）");
{
  /* 三件事一起钉住：
     (a) 顶栏 Logo 副标题删掉版本号与四条操作提示，只留 🐋 DeepSeek Harness Empowered；
     (b) 状态栏右下角由作者名改成版本号（点进去仍是作者详情窗，内容不变）；
     (c) 画布面包屑从 tabs 工具条搬进画布，挂成左上角悬浮层。 */
  const html = read("renderer/index.html");
  const bootSrc = read("renderer/app-boot.js");
  const css = read("renderer/css/canvas.css");
  const tool = html.slice(html.indexOf('<div class="fn-toolbar">'), html.indexOf('<div id="canvas"'));
  ok(tool.indexOf('id="taskCrumb"') < 0, "面包屑不再挂在 tabs 工具条（.fn-toolbar）里");
  const canvasBlock = html.slice(html.indexOf('<div id="canvas"'), html.indexOf('id="stage"'));
  ok(canvasBlock.indexOf('id="taskCrumb"') >= 0, "面包屑改挂到 #canvas 内（画布内容区）");
  ok(
    /\.task-crumb\s*\{[\s\S]{0,400}position:\s*absolute[\s\S]{0,200}z-index:\s*80/.test(css) &&
      !/\.task-crumb\s*\{[\s\S]{0,400}max-width:\s*min\(\s*38%/.test(css) &&
      /\.task-crumb\s*\{[\s\S]{0,600}pointer-events:\s*none/.test(css) &&
      /\.task-crumb-item\s*\{[\s\S]{0,400}pointer-events:\s*auto/.test(css),
    "悬浮层：绝对定位 + z-index 80 + 去掉 380px 宽度上限 + 条身不接指针、条目自己接",
  );
  ok(
    /\.task-crumb\s*\{[\s\S]{0,600}background:\s*rgba\(/.test(css),
    "悬浮层带半透明深色底（节点拖到下面也看得清）",
  );
  const crumbCss = (css.match(/\.task-crumb\s*\{[\s\S]*?\}/) || [""])[0];
  const crumbLeft = Number((crumbCss.match(/left:\s*(\d+)px/) || [])[1] || 0);
  ok(
    crumbLeft >= 40 && /max-width:\s*calc\(100% - 54px\)/.test(crumbCss),
    "面包屑右移让出左上角端子列（left ≥ 40px，宽度上限同步让出这段）",
  );
  const logoBody = fnBody(bootSrc, "applyLogoSub");
  ok(
    logoBody.indexOf("DeepSeek Harness Empowered") >= 0 &&
      !/appVersion|S\.appVersion/.test(logoBody) &&
      logoBody.indexOf("右键画布添加节点") < 0,
    "Logo 副标题只留 🐋 DeepSeek Harness Empowered（版本号与操作提示都删了）",
  );
  const verBody = fnBody(bootSrc, "applyAuthorVersion");
  ok(
    /S\.appVersion/.test(verBody) && /"v"\s*\+/.test(verBody),
    "右下角版本号现算（v + S.appVersion），不在源码里写死版本",
  );
  const authorTag = (html.match(/<span id="authorLink"[\s\S]{0,300}?<\/span>/) || [""])[0];
  ok(
    /data-i18n-title="应用详情"/.test(authorTag) && authorTag.indexOf("@ms2308") < 0,
    "状态栏右下角不再写死 @ms2308，悬停提示改成「应用详情」",
  );
}

console.log("\n[10] 分层视角：每一层（根 / 每颗壳 / 每个任务）各存一份镜头");
{
  const A = mkWf("A");
  const S = fresh(A);
  /* 层键 = 画布 id + 层路径；壳优先于任务，与 nodeInCurrentScope 的判定顺序逐字一致 */
  eq(ctx.API.levelViewKeyOf(A), "A\u0000root", "根层的键 = 画布 id + root");
  ctx.API.setSuperFocus("s1a");
  eq(ctx.API.levelViewKeyOf(A), "A\u0000s:s1a", "壳内部的键认最深的壳");
  ctx.API.setTaskFocus("t1a");
  eq(
    ctx.API.levelViewKeyOf(A),
    "A\u0000s:s1a",
    "壳与任务同时在场时壳优先（同 nodeInCurrentScope：那一屏就是壳内部）",
  );
  ctx.API.setSuperFocus("");
  eq(ctx.API.levelViewKeyOf(A), "A\u0000t:t1a", "放开壳之后落到任务层");
  ctx.API.setTaskFocus("");
  eq(ctx.API.levelViewKeyOf(A), "A\u0000root", "都放开就是根层");
  eq(S.levelViews && Object.keys(S.levelViews).length > 0, true, "换层时把走过的层都记下来了");

  /* 真跑一遍：进深壳摆镜头 → 退父壳（没来过 → 居中）→ 再进深壳（回到自己那一眼） */
  const S2 = fresh(A);
  ctx.API.setSuperFocus("s1a");
  S2.cam.x = -1234;
  S2.cam.y = -567;
  S2.cam.z = 0.62;
  eq(ctx.API.rememberLevelView(S2.wf), true, "平移 / 缩放结束就写回当前层");
  ctx.API.restoreLevelView(S2.wf);
  eq(S2.cam.x, -1234, "同一层再恢复：缓存原样套回（不自动纠偏）");
  ctx.API.setSuperFocus("s1"); /* 换层：先把深壳那一份存好 */
  const fitBefore = ctx.fitCount;
  ctx.API.restoreLevelView(S2.wf); /* s1 没来过 → 居中 */
  eq(S2.cam.x, 500, "这一层是空的（没有内容可框）→ 相机居中到层原点，缩放不变");
  eq(S2.cam.z, 0.62, "空层兜底不动缩放");
  /* 有内容时：居中＝与「一键居中」同一口径（fitCanvas） */
  delete S2.levelViews[ctx.API.levelViewKeyOf(S2.wf)]; /* 当作这一层还没缓存 */
  S2.bounds = { minX: 0, minY: 0, maxX: 400, maxY: 300, w: 400, h: 300 };
  ctx.API.restoreLevelView(S2.wf);
  eq(ctx.fitCount, fitBefore + 1, "居中确实交给 fitCanvas（不另算一套）");
  eq(S2.cam.x, -1, "取到的就是「一键居中」那一套结果");
  S2.bounds = null;

  ctx.API.setSuperFocus("s1a");
  ctx.API.restoreLevelView(S2.wf);
  eq(S2.cam.x, -1234, "退回再进来：回到自己在深壳里看到的那一眼（视角不再被重置）");
  eq(S2.cam.z, 0.62, "缩放一起回来");
  ok(
    Object.keys(S2.levelViews).filter((k) => k.indexOf("A\u0000") === 0).length >= 3,
    "同一张画布的根 / 壳 / 任务各占一条（不是共用一份）",
  );

  /* 空层兜底：层里没有内容 → 缩放不变，相机居中到这一层的原点 */
  const S3 = fresh(A);
  S3.bounds = null;
  S3.cam.z = 0.75;
  ctx.API.centerLayerView();
  eq(S3.cam.x, 500, "空层居中：相机 x = 视口宽 / 2");
  eq(S3.cam.y, 350, "空层居中：相机 y = 视口高 / 2");
  eq(S3.cam.z, 0.75, "空层兜底不动缩放");

  /* 交接期间禁写 / 显式 restore 可强制写 */
  const S4 = fresh(A);
  S4._noLevelViewSave = true;
  eq(ctx.API.rememberLevelView(S4.wf), false, "交接期间不写层记忆（S.wf 已换、焦点没换完 = 会串味）");
  eq(ctx.API.rememberLevelView(S4.wf, true), true, "显式 restore 的写回可以越过这条闸（它就是这一层的取景）");

  /* 删除画布：这张图的每一条层记忆一起作废 */
  const B = mkWf("B");
  const S5 = fresh(A);
  ctx.API.setSuperFocus("s1a");
  ctx.API.setForegroundWf(B);
  ok(
    Object.keys(S5.levelViews).some((k) => k.indexOf("A\u0000") === 0),
    "离开 A 时它每一层都留了记忆",
  );
  ctx.API.forgetWfView("A");
  eq(
    Object.keys(S5.levelViews).filter((k) => k.indexOf("A\u0000") === 0).length,
    0,
    "forgetWfView 连分层记忆一起摘掉（同名重建不吃旧镜头）",
  );
}

console.log("\n[11] 源码口径：换层都取「该层自己的镜头」，写回点齐全");
{
  const body = (n) => fnBody(appSrc, n);
  ok(
    /restoreLevelView\(S\.wf\)/.test(body("enterSuper")),
    "进壳：取这一层自己的镜头（不再无条件 fitNodes）",
  );
  ok(
    !/fitNodes\(kids\)|fitCanvas\(\)/.test(codeOnly(body("enterSuper"))),
    "进壳不再每次重设镜头（这正是「返回就丢视角」的直接原因）",
  );
  ok(/restoreLevelView\(S\.wf\)/.test(body("leaveSuper")), "退壳：回到外层缓存过的镜头");
  ok(/restoreLevelView\(S\.wf\)/.test(body("enterTask")), "进任务：取该任务层自己的镜头");
  ok(/restoreLevelView\(S\.wf\)/.test(body("leaveTask")), "退任务：回到外层缓存过的镜头");
  ok(
    /rememberLevelView/.test(body("setTaskFocus")) && /rememberLevelView/.test(body("setSuperFocus")),
    "换层之前先把「现在这一层」存好（切走的那一眼不丢）",
  );
  ok(
    /noViewSave/.test(body("setTaskFocus")) && /noViewSave/.test(body("setSuperFocus")),
    "「借道」换层可以不写（定位 / 画布交接这类过渡画面不算用户视角）",
  );
  ok(
    /rememberLevelView\(S\.wf\)/.test(body("fitCanvas")) &&
      /rememberLevelView\(S\.wf\)/.test(body("fitNodes")),
    "「一键居中 / 全部节点」本身就是一次视角决定 → 也写回当前层",
  );
  ok(
    /"wheel"[\s\S]{0,1600}?rememberLevelView\(S\.wf\)/.test(appSrc),
    "滚轮缩放结束写回当前层",
  );
  const panUp = appSrc.slice(
    appSrc.indexOf('window.addEventListener("mouseup"'),
    appSrc.indexOf('canvas.addEventListener("contextmenu"'),
  );
  ok(/rememberLevelView\(S\.wf\)/.test(panUp), "平移结束（mouseup 的 pan 分支）写回当前层");
  ok(
    /restoreLevelView\(S\.wf\)/.test(body("renderTaskCrumb")),
    "面包屑「画布」按钮回根层也取根层自己的镜头",
  );
  const rc = fnBody(read("renderer/app-canvas.js"), "renderCanvas");
  ok(
    /_pendingLayerCenter/.test(rc) && /restoreLevelView/.test(rc),
    "首次打开画布：居中推迟到 renderCanvas 真画完那一拍（此刻才量得到尺寸）",
  );
  ok(
    rc.lastIndexOf("_pendingLayerCenter") > rc.lastIndexOf("} finally {"),
    "补居中在 finally 里（复用旧 DOM 与整幅重建两条路径都走得到）",
  );
  ok(
    /_pendingLayerCenter = true/.test(body("applyWfView")),
    "没有缓存 → 只排一次「待居中」，applyWfView 自己仍不碰 fitCanvas / fitNodes",
  );
}

console.log("\n结果：" + checks + " 项，失败 " + fails + " 项");
process.exit(fails ? 1 : 0);
