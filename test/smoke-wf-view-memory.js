"use strict";
/* 画布视图记忆（切 Tab 回到离开时的那一层）回归冒烟测试 —— 纯 Node，不依赖 Electron
 *   node test/smoke-wf-view-memory.js
 *
 * 背景（本轮修的 bug）：「在哪一层」与「相机看到哪」过去是全局一份：
 *   ① 切画布走 renderer/app.js 的 loadWorkflow → resetTaskFocus()，把任务子画布焦点
 *      （S.taskFocus）与超级节点 focus 子画布（S.superFocus）一把清零；
 *   ② 相机 S.cam 跨画布共享，切过去的画布顶着上一张的平移量。
 * 于是「钻在超级节点 / 任务的子画布里干活 → 切去看别的画布 → 切回来」每次都站在
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
${sliced}
  this.API = {
    setForegroundWf, rememberWfView, applyWfView, forgetWfView,
    setTaskFocus, setSuperFocus, resetTaskFocus, resetSuperFocus
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

console.log("\n[1] 超级节点 focus + 相机：切走再切回来仍在原位");
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
  eq(S.cam.x, 777, "B 没有记忆时相机沿用现值（不擅自居中 = 与老行为逐字一致）");
  eq(S.cam.z, 1.5, "缩放同理不被改写");
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
    /resetSuperFocus\(\)[\s\S]*setTaskFocus\(""\)/.test(body("renderTaskCrumb")),
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
     (b) 进任务时若壳内焦点（superFocus）还活着，作用域判定里超级节点优先，于是「进了
         子任务」画面仍是壳内部，而「← 返回」先退超级节点（看着像又往里进一层）。 */
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
    /setSuperFocus\("", \{ render: false \}\)/.test(et),
    "进任务先放开壳内焦点：「返回」退一层就是外层，不再先退壳（看着像又往里进）",
  );
  ok(
    et.indexOf('setSuperFocus("", { render: false })') < et.indexOf("setTaskFocus(node.id"),
    "放开壳内焦点发生在设任务焦点之前（同一帧内不留「两层都活着」的中间态）",
  );
}

console.log("\n结果：" + checks + " 项，失败 " + fails + " 项");
process.exit(fails ? 1 : 0);
