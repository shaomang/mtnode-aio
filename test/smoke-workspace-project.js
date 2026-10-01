"use strict";
/* 画布项目根 → Agent 工作区真源 —— 冒烟测试（纯 Node：把 renderer 的真实函数源码切进 vm 沙箱，配假 S / 假 nodes，不依赖 Electron）
 *   node test/smoke-workspace-project.js
 * 被测函数（都是按标记从源码里切出来真跑的，不是抄一份逻辑）：
 *   renderer/app.js        wfWorkspace / isAbsPath / devPathOf / devProjectRootOf / dshWorkspaceOf
 *   renderer/app-agent.js  dshWorkspaceOf（与 app.js 逐字同步的第二份）
 *   renderer/app-assist.js 工作区真源层（canvasProjectRoot / agentRunWorkspace / assistWorkspaceInfo / workspaceInfoNote）
 * 覆盖：
 *   [1] 顶层开发块的 devPath 生效 = 画布项目根单一真源
 *   [2] 子块就近继承（自身留空取最近开发祖先；子块自选优先；多层链路都能继承）
 *   [3] 手填目录优先于项目根（节点 agentWorkspace / workspace · 会话 st.workspace · 助手 S.assistWorkspace）
 *   [4] 无开发节点时仍退回画布统一目录（再退回应用默认目录；两者都没有就返回空，不编造）
 *   [5] 多根取共同祖先（正斜杠 / 反斜杠 / POSIX / 大小写 / 重复去重）；归并不了才标歧义并取文档序第一个
 *   [6] 空 / 相对 devPath 被忽略（既不当项目根，也不误标歧义）；循环祖先链有 guard 不死循环
 *   [7] 接线契约：两份 dshWorkspaceOf 逐字同步 · devProjectRootOf 单一真源 · 脚本加载顺序 */
const fs = require("fs"), path = require("path"), vm = require("vm"), os = require("os"), childProcess = require("child_process");
const SHARED = { fs, path, vm, os, spawn: childProcess.spawn };
const TEST_DIR = __dirname;
let MERGED_FAILED = false;

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
  fs.readFileSync(path.join(__dirname, "..", rel.split("/").join(path.sep)), "utf8");

/* ==================== 真实源码切片 ==================== */
const APP = read("renderer/app.js");
const AGENT = read("renderer/app-agent.js");
const ASSIST = read("renderer/app-assist.js");

function between(src, aMark, bMark, label) {
  const i = src.indexOf(aMark);
  const j = i < 0 ? -1 : src.indexOf(bMark, i + aMark.length);
  const good = i > 0 && j > i;
  ok(good, "定位到源码段：" + label);
  return good ? src.slice(i, j) : "";
}
const SRC_PATH = between(APP, "function wfWorkspace() {", "function joinPath(", "app.js wfWorkspace / isAbsPath");
const SRC_ROOT = between(APP, "function devPathOf(node) {", "/* 开发任务书：节点概述", "app.js devPathOf / devProjectRootOf");
const SRC_WS = between(APP, "function dshWorkspaceOf(node) {", "/* ── 图像输入与视觉模型", "app.js dshWorkspaceOf");
const SRC_WS_AGENT = between(AGENT, "function dshWorkspaceOf(node) {", "/* ── 图像输入与视觉模型", "app-agent.js dshWorkspaceOf");
const SRC_ASSIST = between(ASSIST, "/* ══════════ 工作区真源", "function syncAssistWorkspaceChrome", "app-assist.js 工作区真源层");

/* ==================== 假 S / 假 nodes 沙箱 ==================== */
const CANVAS_DIR = "E:/canvas/dir";
const DEFAULT_DIR = "C:/Users/me/AppData/Roaming/pipeline-console";

function makeSandbox(nodes, opts) {
  const o = opts || {};
  const byId = (id) => (nodes || []).filter((n) => n && n.id === id)[0] || null;
  const sb = {
    console,
    /* isAbsPath 走 window.api.pathIsAbsolute（preload = Node path.isAbsolute）；
       这里显式锁 win32 语义，保证同一份用例在 Linux 上跑结论一致 */
    window: { api: { pathIsAbsolute: (p) => path.win32.isAbsolute(String(p || "")) } },
    nodeById: byId,
    I18n: {
      t: (k, vars) =>
        String(k).replace(/\{(\w+)\}/g, (_, n) => (vars && vars[n] != null ? String(vars[n]) : "")),
    },
    S: {
      wf: { nodes, workspace: o.canvasWorkspace === undefined ? CANVAS_DIR : o.canvasWorkspace },
      dshWorkspaceFallback: o.fallback === undefined ? DEFAULT_DIR : o.fallback,
      assistWorkspace: o.assistWorkspace || "",
      assistRunWorkspace: o.assistRunWorkspace,
    },
    /* app-assist 真源层要问的两个前置条件 */
    assistScopeIsCurrent: () => !!o.scopeCurrent,
    assistRunLocked: () => !!o.runLocked,
  };
  const ctx = vm.createContext(sb);
  vm.runInContext(SRC_PATH, ctx, { filename: "app.js#path" });
  vm.runInContext(SRC_ROOT, ctx, { filename: "app.js#dev-root" });
  vm.runInContext(SRC_WS, ctx, { filename: "app.js#workspace" });
  vm.runInContext(SRC_ASSIST, ctx, { filename: "app-assist.js#workspace-root" });
  return sb;
}
const ex = (sb, expr) => vm.runInContext(expr, sb);
const rootOf = (sb) => ex(sb, "devProjectRootOf()");
/* 歧义标记随 devProjectRootOf() 刷新：必须先调用再读（与 UI 读取纪律一致） */
const ambOf = (sb) => ex(sb, "(function(){ devProjectRootOf(); return !!S.devProjectRootAmbiguous; })()");
const pathOf = (sb, id) => ex(sb, "devPathOf(nodeById(" + JSON.stringify(id) + "))");
const wsOf = (sb, node) => ex(sb, "dshWorkspaceOf(" + JSON.stringify(node === undefined ? null : node) + ")");
const json = (sb, expr) => JSON.parse(ex(sb, "JSON.stringify(" + expr + ")"));

/* 常用夹具：一个顶层功能块设了项目根，下面挂子块 / 孙块 / 自选根的子块 */
const PROJ = "E:/dev/tools/pipeline-console";
const PROJ_BS = "E:\\dev\\tools\\pipeline-console";
const nestedNodes = () => [
  { id: "top", kind: "super", dev: true, devKind: "module", title: "MTNode 编排器", devPath: PROJ },
  { id: "c1", kind: "super", dev: true, devKind: "module", title: "渲染层", parentSuperId: "top" },
  { id: "g1", kind: "super", dev: true, devKind: "file", title: "app-canvas.js", parentSuperId: "c1" },
  { id: "c2", kind: "super", dev: true, devKind: "module", title: "子项目自选根", parentSuperId: "top", devPath: "E:/dev/other/child" },
  { id: "c3", kind: "super", dev: true, devKind: "module", title: "留白的子块", parentSuperId: "top", devPath: "   " },
  { id: "plain", kind: "proc_text", title: "普通节点" },
];

/* ==================== [1] 顶层 devPath 生效 ==================== */
console.log("\n[1] 顶层开发块的 devPath = 画布项目根（单一真源）");
{
  const sb = makeSandbox(nestedNodes());
  ok(rootOf(sb) === PROJ, "顶层块设了 devPath → 画布项目根就是它");
  ok(ambOf(sb) === false, "只有一个根 → 不标歧义");
  const sb2 = makeSandbox(nestedNodes(), { canvasWorkspace: CANVAS_DIR });
  ok(rootOf(sb2) === PROJ, "画布统一目录存在时，项目根仍取顶层 devPath");
  /* 顶层块被包在普通超级节点里，仍算顶层功能块（父级非 dev 不降级） */
  const sb3 = makeSandbox([
    { id: "wrap", kind: "super", title: "普通超级节点" },
    { id: "top", kind: "super", dev: true, parentSuperId: "wrap", devPath: PROJ },
    { id: "kid", kind: "super", dev: true, parentSuperId: "top", title: "子块" },
  ]);
  ok(rootOf(sb3) === PROJ, "开发块套在普通超级节点里仍算顶层块（项目根照常生效）");
}

/* ==================== [2] 子块就近继承 ==================== */
console.log("\n[2] 子块就近继承 devPath");
{
  const sb = makeSandbox(nestedNodes());
  ok(pathOf(sb, "top") === PROJ, "顶层块读自身 devPath");
  ok(pathOf(sb, "c1") === PROJ, "子块留空 → 取父块（就近第一层）");
  ok(pathOf(sb, "g1") === PROJ, "孙块留空 → 顺着链路继承到顶层（跨多层）");
  ok(pathOf(sb, "c2") === "E:/dev/other/child", "子块自己填了 devPath → 自选优先于继承");
  ok(pathOf(sb, "c3") === PROJ, "devPath 只有空白字符 = 视为留空 → 继续向上继承");
  ok(rootOf(sb) === PROJ, "子块自选的第二个根不抢画布根（顶层块已解析出根时只看顶层）");
  /* 顶层没设根、只有子块设了 → 退回扫描全部开发块，仍能拿到根 */
  const sb2 = makeSandbox([
    { id: "top", kind: "super", dev: true, title: "顶层没设根" },
    { id: "kid", kind: "super", dev: true, parentSuperId: "top", devPath: "E:/only/child/proj" },
  ]);
  ok(pathOf(sb2, "top") === "", "顶层没设 → devPathOf 为空（不编造）");
  ok(rootOf(sb2) === "E:/only/child/proj", "顶层都没设根时，兜底扫全部开发块仍能拿到");
  ok(ambOf(sb2) === false, "兜底解析出的单个根不算歧义");
}

/* ==================== [3] 手填目录优先于项目根 ==================== */
console.log("\n[3] 手填目录优先于项目根");
{
  const sb = makeSandbox(nestedNodes());
  ok(wsOf(sb, { agentWorkspace: "D:/hand/pick" }) === "D:/hand/pick", "节点手填 agentWorkspace > 画布项目根");
  ok(wsOf(sb, { workspace: "D:/hand/ws" }) === "D:/hand/ws", "节点手填 workspace > 画布项目根");
  ok(wsOf(sb, { agentWorkspace: "D:/a", workspace: "D:/b" }) === "D:/a", "两个手填字段并存时取 agentWorkspace");
  ok(wsOf(sb, { agentWorkspace: "", workspace: "" }) === PROJ, "手填留空不算手填 → 回到项目根");
  ok(wsOf(sb, {}) === PROJ, "节点没手填 → 用画布项目根");
  ok(wsOf(sb) === PROJ, "连节点都没有（全局助手）→ 也用画布项目根");
  ok(
    wsOf(sb, {}) !== CANVAS_DIR,
    "关键回归：有项目根时不再优先落在画布统一目录（旧版会，Agent 就把项目文件写进画布目录）",
  );
  /* 会话层（app-assist 真源）：st.workspace 手填优先，留空跟项目根 */
  ok(json(sb, "agentWorkspaceInfo({ workspace: \"D:/sess/pick\" })").source === "manual", "会话手填 → 来源标 manual");
  ok(ex(sb, "agentRunWorkspace({ workspace: \"D:/sess/pick\" })") === "D:/sess/pick", "会话手填 > 项目根");
  ok(ex(sb, "agentRunWorkspace({})") === PROJ, "会话没手填 → 运行工作区 = 画布项目根");
  ok(json(sb, "agentWorkspaceInfo({})").source === "project", "会话跟随项目根时来源标 project");
  ok(
    ex(sb, "sessionWorkspaceShown({})") === ex(sb, "agentRunWorkspace({})"),
    "界面显示的工作区与运行用的是同一个真源（看得见文件落在哪）",
  );
  /* 助手层：手填优先；「仅当前画布」范围下手填无效，仍跟随画布项目根 */
  const sA = makeSandbox(nestedNodes(), { assistWorkspace: "D:/assist/hand" });
  ok(json(sA, "assistWorkspaceInfo()").path === "D:/assist/hand", "助手手填 > 画布项目根");
  ok(json(sA, "assistWorkspaceInfo()").source === "manual", "助手手填来源标 manual");
  const sB = makeSandbox(nestedNodes(), { assistWorkspace: "D:/assist/hand", scopeCurrent: true });
  ok(json(sB, "assistWorkspaceInfo()").path === PROJ, "「仅当前画布」范围下手填无效 → 仍走项目根");
  ok(json(sB, "assistWorkspaceInfo()").source === "project", "该范围下来源如实标 project");
}

/* ==================== [4] 无开发节点时仍退回画布统一目录 ==================== */
console.log("\n[4] 无开发节点 / 没设根：退回画布统一目录，再退应用默认目录");
{
  const plain = [
    { id: "p1", kind: "proc_text", title: "普通节点" },
    { id: "sup", kind: "super", title: "普通超级节点", devPath: "E:/not-a-dev-block" },
    { id: "db", kind: "super", dev: true, db: true, title: "数据库超级节点", devPath: "E:/db-root" },
  ];
  const sb = makeSandbox(plain);
  ok(rootOf(sb) === "", "画布上没有开发块 → 没有项目根");
  ok(ambOf(sb) === false, "没有项目根时歧义标记复位为 false");
  ok(wsOf(sb, {}) === CANVAS_DIR, "无开发节点 → 退回画布统一目录（本条不能破）");
  ok(wsOf(sb, { agentWorkspace: "D:/hand" }) === "D:/hand", "无开发节点时手填仍然优先");
  const cr = json(sb, "canvasProjectRoot()");
  ok(cr.hasDevNodes === false, "助手层如实报告这张画布没有开发块");
  ok(cr.path === "" && cr.roots.length === 0 && cr.ambiguous === false, "没有开发块 → 项目根与根清单都为空");
  ok(ex(sb, "assistResolveWorkspace()") === CANVAS_DIR, "助手无项目根 → 退画布统一目录");
  ok(json(sb, "assistWorkspaceInfo()").source === "canvas", "来源标 canvas");
  ok(ex(sb, "agentRunWorkspace({})") === DEFAULT_DIR, "会话无项目根 → 退应用默认目录");
  /* 只有 db 超级节点 / 只有普通超级节点：都不算开发块 */
  const sb2 = makeSandbox([{ id: "db", kind: "super", dev: true, db: true, devPath: PROJ }]);
  ok(rootOf(sb2) === "", "db:true 的超级节点不算功能块（不冒领项目根）");
  /* 有开发块但一个根都没设 */
  const sb3 = makeSandbox([
    { id: "t", kind: "super", dev: true, title: "没设根的功能块" },
    { id: "k", kind: "super", dev: true, parentSuperId: "t", title: "子块" },
  ]);
  ok(rootOf(sb3) === "", "有开发块但都没设 devPath → 没有项目根");
  ok(wsOf(sb3, {}) === CANVAS_DIR, "这种情况仍退回画布统一目录（不报错、不写空）");
  ok(
    json(sb3, "workspaceInfoNote(assistWorkspaceInfo())").indexOf("本画布有开发节点但尚未设置项目根") >= 0,
    "提示条告诉用户去顶层功能块补 devPath",
  );
  /* 画布目录和默认目录都没有 → 返回空，由网关按自身默认处理 */
  const sb4 = makeSandbox(plain, { canvasWorkspace: "", fallback: "" });
  ok(wsOf(sb4, {}) === "", "无项目根 · 无画布目录 · 无默认目录 → 空串（不编造目录）");
  ok(ex(sb4, "assistResolveWorkspace()") === "", "助手同口径返回空");
}

/* ==================== [5] 多根取共同祖先 ==================== */
console.log("\n[5] 多个项目根：取共同祖先，归并不了才标歧义");
{
  const twoRoots = (a, b) => [
    { id: "t1", kind: "super", dev: true, devPath: a },
    { id: "t2", kind: "super", dev: true, devPath: b },
  ];
  const sb = makeSandbox(twoRoots("E:/work/alpha", "E:/work/beta"));
  ok(rootOf(sb) === "E:/work", "同盘共同祖先 → 取祖先目录（一个根覆盖两块）");
  ok(ambOf(sb) === false, "能归并就不标歧义");
  const sbW = makeSandbox(twoRoots("E:\\work\\alpha", "E:\\work\\beta"));
  ok(rootOf(sbW) === "E:\\work", "反斜杠路径照样归并，并保留反斜杠写法");
  const sbP = makeSandbox(twoRoots("/data/proj/alpha", "/data/proj/beta"));
  ok(rootOf(sbP) === "/data/proj", "POSIX 路径归并到共同祖先");
  const sbC = makeSandbox(twoRoots("E:/Work/Alpha", "e:/work/beta"));
  ok(rootOf(sbC) === "E:/Work", "Windows 盘符与段名忽略大小写比对，结果沿用第一个根的写法");
  ok(ambOf(sbC) === false, "大小写差异不误判成两个根");
  const sbD = makeSandbox(twoRoots("E:/work/alpha", "E:/work/alpha/"));
  ok(rootOf(sbD) === "E:/work/alpha", "尾斜杠归一：同一个根不重复计数");
  const sbR = makeSandbox(twoRoots("E:/work/alpha", "E:/work/alpha"));
  ok(rootOf(sbR) === "E:/work/alpha", "完全重复的 devPath 去重成一个根");
  const sb3 = makeSandbox([
    { id: "t1", kind: "super", dev: true, devPath: "E:/work/alpha" },
    { id: "t2", kind: "super", dev: true, devPath: "E:/work/beta" },
    { id: "t3", kind: "super", dev: true, devPath: "E:/work/sub/gamma" },
  ]);
  ok(rootOf(sb3) === "E:/work", "三个根取到真正的最深公共祖先（不被最短段截断）");
  /* 归并不了 → 标歧义并取文档序第一个 */
  const sbX = makeSandbox(twoRoots("E:/work/alpha", "D:/work/beta"));
  ok(rootOf(sbX) === "E:/work/alpha", "跨盘无共同祖先 → 取文档序第一个根");
  ok(ambOf(sbX) === true, "跨盘归并不了 → 标歧义供 UI 提示");
  ok(
    json(sbX, "canvasProjectRoot()").ambiguous === true,
    "助手层读同一份项目根（roots / ambiguous 口径一致）",
  );
  ok(
    json(sbX, "workspaceInfoNote(agentWorkspaceInfo({}))").indexOf("本画布有多个项目根") >= 0,
    "歧义时提示条给出换根办法",
  );
  const sbY = makeSandbox(twoRoots("E:/alpha", "E:/beta"));
  ok(rootOf(sbY) === "E:/alpha", "共同祖先只剩盘符本身 → 不算有意义的根，退回文档序第一个");
  ok(ambOf(sbY) === true, "只剩盘符时标歧义（不能把整个盘当工作区）");
  const sbZ = makeSandbox(twoRoots("/alpha", "/beta"));
  ok(ambOf(sbZ) === true && rootOf(sbZ) === "/alpha", "POSIX 同理：根目录不算共同祖先");
  /* 顶层优先：子块自选的另一个根不参与多根归并 */
  const sbMix = makeSandbox([
    { id: "t1", kind: "super", dev: true, devPath: "E:/work/alpha" },
    { id: "kid", kind: "super", dev: true, parentSuperId: "t1", devPath: "D:/only/child" },
    { id: "t2", kind: "super", dev: true, devPath: "E:/work/beta" },
  ]);
  ok(rootOf(sbMix) === "E:/work", "多根归并只看顶层块（子块自选的 D: 根不参与）");
  ok(ambOf(sbMix) === false, "子块自选根不会被误判成画布有多根");
  /* 歧义标记每次调用都刷新 */
  const sbRefresh = makeSandbox(twoRoots("E:/work/a", "D:/work/b"));
  ok(ambOf(sbRefresh) === true, "先制造歧义");
  ex(sbRefresh, "S.wf.nodes.push({ id:\"t3\", kind:\"super\", dev:true, devPath:\"E:/work/a\" })");
  rootOf(sbRefresh);
  ok(ambOf(sbRefresh) === true, "加了第三个仍冲突的根 → 依旧歧义");
  ex(sbRefresh, "nodeById(\"t2\").devPath = \"E:/work/a\"");
  ok(rootOf(sbRefresh) === "E:/work/a", "把冲突根改成同一个 → 归并成一个根");
  ok(ambOf(sbRefresh) === false, "同一轮内歧义标记随调用刷新（不留脏标记）");
}

/* ==================== [6] 空 / 相对 devPath 被忽略 ==================== */
console.log("\n[6] 空 / 相对 devPath 被忽略 · 循环祖先不死循环");
{
  const rel = [
    { id: "t1", kind: "super", dev: true, devPath: "" },
    { id: "t2", kind: "super", dev: true, devPath: "   " },
    { id: "t3", kind: "super", dev: true, devPath: "src/renderer" },
    { id: "t4", kind: "super", dev: true, devPath: "./local/proj" },
    { id: "t5", kind: "super", dev: true, devPath: "E:\\dev\\tools\\pipeline-console" },
  ];
  const sb = makeSandbox(rel.slice(0, 4));
  ok(rootOf(sb) === "", "空串 / 空白 / 相对路径全被忽略 → 没有项目根");
  ok(ambOf(sb) === false, "被忽略的相对路径不产生第二个根（不误标歧义）");
  ok(wsOf(sb, {}) === CANVAS_DIR, "忽略后正常退回画布统一目录");
  ok(pathOf(sb, "t3") === "src/renderer", "devPathOf 本身只管就近取原值，绝对性交给 devProjectRootOf 判");
  const sbMix = makeSandbox(rel);
  ok(rootOf(sbMix) === PROJ_BS, "绝对值（反斜杠写法）被采纳并原样返回，相对值忽略后只剩一个根");
  ok(rootOf(sbMix).indexOf("\\") > 0, "没设统一正斜杠：保留用户写的路径原貌");
  ok(ambOf(sbMix) === false, "混合场景不误标歧义");
  const sbRel = makeSandbox([
    { id: "t1", kind: "super", dev: true, devPath: PROJ },
    { id: "kid", kind: "super", dev: true, parentSuperId: "t1", devPath: "src/relative" },
  ]);
  ok(pathOf(sbRel, "kid") === "src/relative", "子块相对 devPath 原样可读（写任务书时仍如实带出）");
  ok(rootOf(sbRel) === PROJ, "画布根仍只认顶层的绝对路径");
  /* 循环祖先：自环 + 互环（没有 guard 就整个测试挂死） */
  const cyc = makeSandbox([
    { id: "selfy", kind: "super", dev: true, parentSuperId: "selfy" },
    { id: "ca", kind: "super", dev: true, parentSuperId: "cb", devPath: "E:/cycle/ok" },
    { id: "cb", kind: "super", dev: true, parentSuperId: "ca" },
  ]);
  ok(pathOf(cyc, "selfy") === "", "自环块取不到根（guard 内跑完，不死循环）");
  ok(pathOf(cyc, "cb") === "E:/cycle/ok", "互环也能就近解析到对方设的根");
  ok(rootOf(cyc) === "E:/cycle/ok", "循环祖先链下项目根仍可解析（去重后单根）");
  ok(ambOf(cyc) === false, "自环不额外冒出一个根，故不标歧义");
  /* 十层深链：继承跨得够深 */
  const deep = [{ id: "d0", kind: "super", dev: true, devPath: "E:/deep/proj" }];
  for (let i = 1; i <= 10; i++)
    deep.push({ id: "d" + i, kind: "super", dev: true, parentSuperId: "d" + (i - 1) });
  const sbD = makeSandbox(deep);
  ok(pathOf(sbD, "d10") === "E:/deep/proj", "十层深的子块仍就近继承顶层项目根");
  ok(rootOf(sbD) === "E:/deep/proj", "深嵌套画布的项目根只有一个");
}

/* ==================== [7] 接线契约 ==================== */
console.log("\n[7] 接线契约：两份实现逐字同步 · 单一真源 · 加载顺序");
{
  ok(SRC_WS.length > 120 && SRC_WS_AGENT.length > 120, "两处 dshWorkspaceOf 都截到了源码");
  ok(SRC_WS === SRC_WS_AGENT, "app.js 与 app-agent.js 的 dshWorkspaceOf 逐字一致（后加载生效的那份没跑偏）");
  ok(
    SRC_WS.indexOf("const manual = node && (node.agentWorkspace || node.workspace);") > 0 &&
      SRC_WS.indexOf("const projRoot = devProjectRootOf();") > 0 &&
      SRC_WS.indexOf("if (S.wf && S.wf.workspace) return S.wf.workspace;") > 0,
    "优先级顺序就是：手填 > 项目根 > 画布统一目录 > 默认目录",
  );
  ok(
    (APP.match(/function devProjectRootOf\(/g) || []).length === 1 &&
      AGENT.indexOf("function devProjectRootOf(") < 0,
    "devProjectRootOf 全仓只定义一处（app.js），app-agent 只调用不另写一份",
  );
  ok(
    ASSIST.indexOf("typeof devProjectRootOf === \"function\"") > 0 &&
      (ASSIST.match(/function canvasProjectRoot\(/g) || []).length === 1,
    "app-assist 复用同一个真源（canvasProjectRoot 只定义一处）",
  );
  const html = read("renderer/index.html");
  const at = (f) => html.indexOf('<script src="' + f + '"></script>');
  ok(
    at("app.js") > 0 && at("app.js") < at("app-agent.js") && at("app-agent.js") < at("app-assist.js"),
    "index.html 加载顺序：app.js → app-agent.js → app-assist.js（真源层最后覆盖生效）",
  );
  ok(APP.indexOf("节点默认工作目录，优先级：节点/会话手填目录") > 0, "app.js 注释写明新的优先级口径");
  ok(
    ASSIST.indexOf("手填（助手 S.assistWorkspace / 会话 st.workspace）") > 0,
    "app-assist 注释与实现同口径（运行与显示同一真源）",
  );
}

console.log(
  "\n" +
    (fails ? "✗ " + fails + " / " + checks + " 项失败" : "✓ " + checks + " 项全部通过") +
    "  (smoke-workspace-project)",
);

/* ==================== 已并入：test/smoke-workspace-gate.js ==================== */
(function () {
  const __dirname = TEST_DIR;
  const __filename = TEST_DIR + "/" + "smoke-workspace-gate.js";
  const { fs, path, vm, os, spawn } = SHARED;
  const section = (name) => console.log("\n" + name);
  let fails = 0, checks = 0;
  const ok = (cond, msg) => { checks++; if (cond) console.log("  ok  " + msg); else { fails++; MERGED_FAILED = true; console.log("FAIL  " + msg); } };
  try {

  const fs = require("fs");
  const os = require("os");
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
  const HAS = (src, needle, msg) =>
    ok(src.indexOf(needle) >= 0, msg + (src.indexOf(needle) >= 0 ? "" : "\n        缺：" + needle));

  /* 大括号配对切出完整函数（含 async 前缀）；找不到返回 "" */
  function fnBody(src, name) {
    const m = new RegExp("(?:async\\s+)?function\\s+" + name + "\\s*\\(").exec(src);
    if (!m) return "";
    let k = src.indexOf("{", m.index);
    let d = 0;
    for (; k < src.length; k++) {
      if (src[k] === "{") d++;
      else if (src[k] === "}") {
        d--;
        if (!d) return src.slice(m.index, k + 1);
      }
    }
    return "";
  }

  const MAIN = read("main.js");
  const PRELOAD = read("preload.js");
  const APP = read("renderer/app.js");
  const NODES = read("renderer/app-nodes.js");
  const CANVAS = read("renderer/app-canvas.js");

  /* 每个测试节是一个 async 函数：整个文件保持 CommonJS（不能用顶层 await，
     否则 Node 会按 ESM 解析本文件 → require 直接报错）。 */
  const SECTIONS = [];
  const SECTION = (name, fn) => SECTIONS.push([name, fn]);

  /* ══════════════ [1] 主进程：建文件夹能力 ══════════════ */
  SECTION("file:mkdir", () => {
    /* 把 handler 从 main.js 里切出来真跑（require 换成桩，不动 Electron） */
    const i = MAIN.indexOf('ipcMain.handle("file:mkdir"');
    const j = MAIN.indexOf('ipcMain.handle("file:stat"', i);
    ok(i > 0 && j > i, "定位到 file:mkdir handler");
    const src = i > 0 ? MAIN.slice(i, j) : "";
    const handlers = {};
    const sb = {
      ipcMain: {
        handle: (name, fn) => {
          handlers[name] = fn;
        },
      },
      fs,
      I18n: { t: (k) => String(k) },
    };
    vm.runInContext(src, vm.createContext(sb), { filename: "main.js#mkdir" });
    const mkdir = handlers["file:mkdir"];
    ok(typeof mkdir === "function", "file:mkdir 注册成功");

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-wsg-"));
    const deep = path.join(tmp, "a", "b", "c");
    const r1 = mkdir(null, deep);
    ok(r1.ok === true && r1.existed === false, "不存在的深层路径 → 新建成功（recursive 补齐父级）");
    ok(fs.existsSync(deep) && fs.statSync(deep).isDirectory(), "落盘确认：整条路径都建出来了");
    const r2 = mkdir(null, deep);
    ok(r2.ok === true && r2.existed === true, "已存在且是目录 → 幂等成功（existed:true）");
    const fileAt = path.join(tmp, "afile");
    fs.writeFileSync(fileAt, "x");
    const r3 = mkdir(null, fileAt);
    ok(r3.ok === false && !!r3.error, "命中同名文件 → 失败（绝不覆盖）");
    const r4 = mkdir(null, "   ");
    ok(r4.ok === false, "空路径 → 失败（不猜目录）");
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  /* ══════════════ [2] 文件夹选择界面允许新建 ══════════════ */
  SECTION("文件选择对话框", () => {
    const i = MAIN.indexOf('ipcMain.handle("file:openDialog"');
    const j = MAIN.indexOf('ipcMain.handle("shell:showItem"', i);
    const src = i > 0 && j > i ? MAIN.slice(i, j) : "";
    ok(src.length > 0, "定位到 file:openDialog handler");
    HAS(src, '"openDirectory", "createDirectory"', "directory 单选带 createDirectory（macOS 等价「新建文件夹」）");
    HAS(src, '"openDirectory", "multiSelections", "createDirectory"', "directory 多选同样带 createDirectory");
    HAS(PRELOAD, "fileMkdir: (p) => ipcRenderer.invoke('file:mkdir', p)", "preload 暴露 window.api.fileMkdir（渲染层建目录的唯一入口）");
    HAS(APP, "directory: true", "app.js 选目录走 fileOpenDialog directory 分支");
    HAS(APP, "await window.api.fileOpenDialog", "闸门窗的「浏览…」走同一个系统对话框（在里面可新建）");
  });

  /* ══════════════ [3] 弹窗：填 / 建 / 选 ══════════════ */
  SECTION("弹窗源码口径", () => {
    HAS(APP, "function createFolderPath(", "createFolderPath（建目录）存在");
    HAS(APP, "function pickFolderDialogPath(", "pickFolderDialogPath（系统选目录）存在");
    HAS(APP, "function chooseWorkspaceFolderDialog(", "chooseWorkspaceFolderDialog 存在");
    const DLG = fnBody(APP, "chooseWorkspaceFolderDialog");
    HAS(DLG, "openOverlay(", "用 #overlay 弹窗承载");
    HAS(DLG, "{ persistent: true, min: false }", "带输入的浮层 persistent（禁止点外部即关）+ 不做最小化");
    HAS(DLG, "await confirmDialog(", "路径不存在时先弹确认（询问是否新建）");
    HAS(DLG, "await createFolderPath(v)", "确认后才真建");
    HAS(DLG, "await pathIsExistingDir(v)", "确定时按现场判定：有效目录直接用");
    HAS(DLG, "await window.api.fileExists(v)", "命中同名文件 → 窗内报错（不覆盖、不关窗）");
    HAS(DLG, 'I18n.t("新建文件夹")', "确认框标题写明是在新建文件夹");
    HAS(DLG, "浏览…", "窗里有「浏览…」（系统窗口里可新建）");
    HAS(DLG, "const guard = setInterval(", "✕ / Esc 关窗也能让等待方结算（不留悬挂 Promise）");
    const CP = fnBody(APP, "createFolderPath");
    HAS(CP, "window.api.fileMkdir", "建目录走主进程 file:mkdir");
    HAS(CP, 'joinPath(s, ".mtnode-ws")', "老宿主兜底：写哨兵文件连带建目录");
    HAS(APP, "workspaceBrowseButton(wsInp)", "新建画布弹窗的目录行用同一个选择器");
  });

  /* ══════════════ [4] 渲染层闸门真跑（源码切片进 vm） ══════════════ */
  const PICK = { mode: "cancel", value: "" };
  let DIALOGS = 0;
  const TOASTS = [];
  const SAVES = { n: 0 };
  const RENDER = { n: 0 };
  let DIRS = {};
  const D1 = "D:/proj/ok";
  const D2 = "D:/proj/missing";

  const GATE_SRC = [
    NODES.slice(
      NODES.indexOf("const WS_GATE_LABEL = {"),
      NODES.indexOf("async function playNode(node, quiet, opts) {"),
    ),
    fnBody(NODES, "playUserNode"),
  ].join("\n");

  function makeGateSandbox(opts) {
    const o = opts || {};
    const wf = { nodes: [], workspace: o.canvasWorkspace === undefined ? "" : o.canvasWorkspace };
    const sb = {
      console,
      Promise,
      S: { wf },
      I18n: {
        t: (k, vars) =>
          String(k).replace(/\{(\w+)\}/g, (_, n) => (vars && vars[n] != null ? String(vars[n]) : "")),
      },
      /* 目录有效性：沙箱里用一张清单模拟磁盘（不碰真磁盘） */
      pathIsExistingDir: (p) => Promise.resolve(!!DIRS[String(p || "").trim()]),
      wfWorkspace: () => String(wf.workspace || ""),
      dshWsOf: (n) => (n && (n.agentWorkspace || n.workspace)) || "",
      setDshWs: (n, v) => {
        if (n) n.agentWorkspace = v;
      },
      scheduleSave: () => {
        SAVES.n++;
      },
      renderCanvas: () => {
        RENDER.n++;
      },
      toast: (m) => TOASTS.push(m),
      chooseWorkspaceFolderDialog: () => {
        DIALOGS++;
        return Promise.resolve(PICK.mode === "pick" ? PICK.value : "");
      },
      isSaveNode: (n) => !!(n && String(n.kind || "").startsWith("save")),
      saveNodeAction: (n, o2) => {
        sb.SAVED.push({ id: n.id, opts: o2 || null });
        return Promise.resolve("saved");
      },
      playNode: (n, quiet, o2) => {
        sb.PLAYED.push({ id: n.id, quiet, opts: o2 || null });
        return Promise.resolve("played");
      },
      PLAYED: [],
      SAVED: [],
    };
    vm.runInContext(GATE_SRC, vm.createContext(sb), { filename: "app-nodes.js#ws-gate" });
    return sb;
  }
  const ex = (sb, expr) => vm.runInContext(expr, sb);

  SECTION("闸门真跑", async () => {
    /* ---- [4.1] 目录有效 → 不弹窗、直接放行 ---- */
    DIRS = { [D1]: true };
    DIALOGS = 0;
    let sb = makeGateSandbox({ canvasWorkspace: D1 });
    let dir = await ex(sb, "ensureRunWorkspace(null)");
    ok(dir === D1, "目录有效 → 返回该目录");
    ok(DIALOGS === 0, "目录有效 → 一个弹窗都不弹");
    let issue = await ex(sb, "workspaceIssueOf()");
    ok(issue.ok === true && issue.none === false, "现场标记 ok（非 none / 非 missing）");

    /* ---- [4.2] 目录空 → 弹窗要求填写 ---- */
    DIRS = {};
    DIALOGS = 0;
    sb = makeGateSandbox({ canvasWorkspace: "" });
    issue = await ex(sb, "workspaceIssueOf()");
    ok(issue.none === true && issue.ok === false, "未填写 → 现场标 none");
    PICK.mode = "pick";
    PICK.value = D1;
    dir = await ex(sb, "ensureRunWorkspace(null)");
    ok(DIALOGS === 1, "未填写 → 弹一次「请填写工作目录」");
    ok(dir === D1, "用户填/选了有效目录 → 闸门放行并回该目录");

    /* ---- [4.3] 用户放弃 → 空串（调用方据此不起跑） ---- */
    DIRS = {};
    DIALOGS = 0;
    sb = makeGateSandbox({ canvasWorkspace: "" });
    PICK.mode = "cancel";
    dir = await ex(sb, "ensureRunWorkspace(null)");
    ok(dir === "", "用户取消 → 回空串（放行失败）");
    ok(DIALOGS === 1, "只弹一次，不反复骚扰");

    /* ---- [4.4] 目录填错（被删 / 打错）→ 一样弹窗，预填错的那条 ---- */
    DIRS = { [D1]: true };
    DIALOGS = 0;
    sb = makeGateSandbox({ canvasWorkspace: D2 });
    issue = await ex(sb, "workspaceIssueOf()");
    ok(issue.missing === true && issue.raw === D2, "填了但不存在 → 现场标 missing 并带原值");
    PICK.mode = "pick";
    PICK.value = D1;
    dir = await ex(sb, "ensureRunWorkspace(null)");
    ok(dir === D1, "改填成有效目录后放行");

    /* ---- [4.5] 节点自带目录优先；没有手填才回画布口径；写回落在正确那一层 ---- */
    DIRS = { [D1]: true };
    DIALOGS = 0;
    sb = makeGateSandbox({ canvasWorkspace: "" });
    const n1 = { id: "n1", kind: "proc_text", agentWorkspace: D1 };
    issue = await ex(sb, "workspaceIssueOfNode(" + JSON.stringify(n1) + ")");
    ok(issue.ok === true && issue.label === "节点工作目录", "节点手填了有效目录 → 节点口径、标记 ok");
    dir = await ex(sb, "ensureRunWorkspace(" + JSON.stringify(n1) + ")");
    ok(dir === D1 && DIALOGS === 0, "画布目录空但节点自己有 → 不弹窗（不无谓打断）");
    const n2 = { id: "n2", kind: "proc_text" };
    const issue2 = await ex(sb, "workspaceIssueOfNode(" + JSON.stringify(n2) + ")");
    ok(issue2.none === true && issue2.label === "画布工作目录", "节点没手填 → 回落画布口径（统一问）");

    /* 画布本来没有统一目录：用户填的目录落在**画布**这一层（后面别的节点不用再逐个问） */
    PICK.mode = "pick";
    PICK.value = "D:/hand/pick";
    DIRS["D:/hand/pick"] = true;
    const n3 = { id: "n3", kind: "proc_text" };
    const before = SAVES.n + RENDER.n;
    const dir3 = await ex(sb, "ensureRunWorkspace(" + JSON.stringify(n3) + ")");
    ok(dir3 === "D:/hand/pick", "闸门回用户填的目录");
    ok(sb.S.wf.workspace === "D:/hand/pick", "画布本来没目录 → 写回画布统一目录");
    ok(n3.agentWorkspace === undefined, "不往节点字段多存一份（画布统一目录是单一真源）");
    ok(SAVES.n + RENDER.n > before, "写回后落盘 + 重绘（用户马上能看到）");

    /* 画布已有有效目录、只是这个节点手填的那条失效了：只改这个节点，不动画布设置 */
    DIRS = { [D1]: true };
    DIALOGS = 0;
    sb = makeGateSandbox({ canvasWorkspace: D1 });
    const n4 = { id: "n4", kind: "proc_text", agentWorkspace: D2 };
    /* 把节点放进沙箱上下文里按引用用：JSON 字面量会被 vm 克隆，写回就看不见了 */
    sb.NODE = n4;
    const issue4 = await ex(sb, "workspaceIssueOfNode(NODE)");
    ok(issue4.missing === true && issue4.label === "节点工作目录", "节点手填的目录失效 → 节点现场标 missing");
    PICK.mode = "pick";
    PICK.value = "D:/node/ok";
    DIRS["D:/node/ok"] = true;
    dir = await ex(sb, "ensureRunWorkspace(NODE)");
    ok(n4.agentWorkspace === "D:/node/ok", "节点现场选的目录写回节点（agentWorkspace）");
    ok(sb.S.wf.workspace === D1, "画布那层没被改掉（节点问题只改节点）");
    ok(dir === "D:/node/ok", "闸门回节点的新目录");

    /* ---- [4.6] 并发去重：一批 N 个下游只问一次 ---- */
    DIRS = { [D1]: true };
    DIALOGS = 0;
    sb = makeGateSandbox({ canvasWorkspace: "" });
    PICK.mode = "pick";
    PICK.value = D1;
    const p1 = ex(sb, "ensureRunWorkspace(null)");
    const p2 = ex(sb, "ensureRunWorkspace(null)");
    ok(p1 === p2, "同一轮重入拿到同一个 Promise（不叠弹窗、不各问一次）");
    const both = await Promise.all([p1, p2]);
    ok(both[0] === D1 && both[1] === D1, "并发调用都拿到同一个目录");
    ok(DIALOGS === 1, "一批 N 个下游只弹一次");
    ok(ex(sb, "S._wsGate") === null, "结算后清掉在途句柄（下一批能重新问）");

    /* ---- [4.7] playUserNode：放弃不起跑；保存节点走保存；普通节点走 playNode ---- */
    DIRS = { [D1]: true };
    DIALOGS = 0;
    sb = makeGateSandbox({ canvasWorkspace: D1 });
    await ex(sb, "playUserNode({ id: 'p1', kind: 'proc_text' })");
    ok(sb.PLAYED.length === 1 && sb.PLAYED[0].quiet === false, "普通节点：过闸后以 quiet=false 起跑");
    await ex(sb, "playUserNode({ id: 's1', kind: 'save_text' })");
    ok(
      sb.SAVED.length === 1 && sb.SAVED[0].opts.skipWsGate === true,
      "保存节点：走 saveNodeAction（带 skipWsGate，不重复问）",
    );
    ok(sb.PLAYED.length === 1, "保存节点不再落进 playNode（避免双跑）");

    DIRS = {};
    DIALOGS = 0;
    sb = makeGateSandbox({ canvasWorkspace: "" });
    TOASTS.length = 0;
    PICK.mode = "cancel";
    await ex(sb, "playUserNode({ id: 'p2', kind: 'proc_text' })");
    ok(sb.PLAYED.length === 0, "用户放弃 → 节点不起跑");
    ok(
      TOASTS.some((m) => String(m).indexOf("已取消") >= 0),
      "放弃时给一句 toast 说明（不是静默无事发生）",
    );
  });

  /* ══════════════ [5] 接线契约：画布入口 / 控制节点 / 保存节点 ══════════════ */
  SECTION("接线契约", async () => {
    const users = (CANVAS.match(/playUserNode\(node\);/g) || []).length;
    ok(users >= 10, "画布 ▶ 入口全部改走 playUserNode（找到 " + users + " 处）");
    ok(CANVAS.indexOf("playNode(node);") < 0, "画布上不再有裸 playNode(node) 漏网");
    ok(CANVAS.indexOf("saveNodeAction(node);") < 0, "保存节点的 ▶ 也过闸（不再直接调 saveNodeAction）");
    ok(CANVAS.indexOf("playGateNode(node, false);") < 0, "闸门 ▶ 过闸（不再直接放行）");
    HAS(CANVAS, "playControlNode(node);", "控制节点 ▶ 保留 playControlNode（闸门在它内部，避免双问）");
    const PCN = fnBody(NODES, "playControlNode");
    HAS(PCN, "if (!seen) {", "控制节点：只有用户直接点（无 seen）才过闸");
    HAS(PCN, "await ensureRunWorkspace(node)", "控制节点起跑前调闸门");
    const SNA = fnBody(NODES, "saveNodeAction");
    HAS(SNA, "if (!opts.skipWsGate) {", "保存节点：用户点过闸，内部叫起跳过");
    HAS(fnBody(NODES, "playUserNode"), "ensureRunWorkspace(node)", "playUserNode 起跑前调闸门");
    HAS(fnBody(NODES, "ensureRunWorkspace"), "S._wsGate", "并发去重句柄挂在 S 上（可复核）");

    HAS(APP, 'I18n.t("请填写工作目录")', "闸门弹窗标题有词条");
    HAS(APP, 'I18n.t("要新建它吗？")', "新建确认语有词条");
    HAS(APP, 'I18n.t("已新建工作目录：")', "新建成功有提示");
    HAS(APP, 'I18n.t("新建文件夹失败：")', "新建失败如实报错（含原因）");
  });

  (async () => {
    console.log("\n[1] 主进程 file:mkdir：幂等 · 拒绝同名文件 · recursive 建整条路径");
    console.log("\n[2] 文件夹选择对话框：三平台都能新建文件夹");
    console.log("\n[3] 「请填写工作目录」弹窗：不存在先问、确认才建、失败不关窗");
    console.log("\n[4] 闸门真跑：空 / 错 / 对 三种现场 · 并发去重 · 放弃不起跑");
    console.log("\n[5] 接线契约：用户入口都过闸，内部驱动不被拦");
    for (const [name, fn] of SECTIONS) {
      await fn(name);
    }
    console.log(
      "\n" +
        (fails ? "✗ " + fails + " / " + checks + " 项失败" : "✓ " + checks + " 项全部通过") +
        "  (smoke-workspace-gate)",
    );
  })().catch((e) => {
    console.log("FAIL  测试异常：" + ((e && e.stack) || e));
  });
  } catch (e) {
    MERGED_FAILED = true;
    console.log("FAIL  [合并块异常] smoke-workspace-gate.js：" + (e && e.stack ? e.stack : e));
  }
  if (fails) console.log("  ── 已并入块 smoke-workspace-gate.js：" + fails + " / " + checks + " 项失败");
})();

/* ==================== 已并入：test/smoke-workspace-readonly.js ==================== */
(function () {
  const __dirname = TEST_DIR;
  const __filename = TEST_DIR + "/" + "smoke-workspace-readonly.js";
  const { fs, path, vm, os, spawn } = SHARED;
  const section = (name) => console.log("\n" + name);
  let fails = 0, checks = 0;
  const ok = (cond, msg) => { checks++; if (cond) console.log("  ok  " + msg); else { fails++; MERGED_FAILED = true; console.log("FAIL  " + msg); } };
  try {

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
  const ROOT = path.join(__dirname, "..");
  const read = (rel) =>
    fs.readFileSync(path.join(ROOT, rel.split("/").join(path.sep)), "utf8").replace(/\r\n?/g, "\n");
  const HAS = (src, needle, msg) =>
    ok(src.indexOf(needle) >= 0, msg + (src.indexOf(needle) >= 0 ? "" : "\n        缺：" + needle));

  /* 大括号配对切出完整函数（含 async 前缀）；找不到返回 "" */
  function fnBody(src, name) {
    const m = new RegExp("(?:async\\s+)?function\\s+" + name + "\\s*\\(").exec(src);
    if (!m) return "";
    let k = src.indexOf("{", m.index);
    let d = 0;
    for (; k < src.length; k++) {
      if (src[k] === "{") d++;
      else if (src[k] === "}") {
        d--;
        if (!d) return src.slice(m.index, k + 1);
      }
    }
    return "";
  }

  const DB = read("renderer/app-db.js");
  const APP = read("renderer/app.js");
  const CANVAS = read("renderer/app-canvas.js");
  const ASSIST = read("renderer/app-assist.js");
  const HTML = read("renderer/index.html");
  const CSS = read("renderer/css/canvas.css");
  const I18n = require("../renderer/i18n.js");

  /* ==================== 极简假 DOM ====================
     只要守卫真正用到的那几件：addEventListener / 属性 / value / 事件派发。 */
  class FakeEl {
    constructor(tag, className) {
      this.tagName = String(tag || "").toUpperCase();
      this.className = className || "";
      this.listeners = {};
      this.attrs = {};
      this.value = "";
      this.title = "";
      this.readOnly = false;
      this.disabled = false;
      this.hidden = false;
      this.spellcheck = true;
      this.type = "";
      this.parentNode = null;
      this.clicks = 0;
      this.focused = 0;
    }
    addEventListener(kind, fn) {
      (this.listeners[kind] = this.listeners[kind] || []).push(fn);
    }
    removeEventListener(kind, fn) {
      const arr = this.listeners[kind] || [];
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    }
    setAttribute(k, v) {
      this.attrs[k] = String(v);
    }
    getAttribute(k) {
      return this.attrs[k];
    }
    click() {
      this.clicks++;
      return this.onclick ? this.onclick({ stopPropagation() {} }) : undefined;
    }
    dispatchEvent(ev) {
      const kind = ev && ev.type ? String(ev.type) : "";
      for (const fn of (this.listeners[kind] || []).slice()) fn(ev);
      return true;
    }
    focus() {
      this.focused++;
    }
    /* 事件对象只造守卫真正读到的字段；preventDefault 记数便于断言「拦住了」 */
    emit(kind, ev) {
      const e = Object.assign(
        {
          defaultPrevented: false,
          preventDefault() {
            this.defaultPrevented = true;
          },
          stopPropagation() {},
        },
        ev || {},
      );
      for (const fn of (this.listeners[kind] || []).slice()) fn(e);
      return e;
    }
  }

  const TOASTS = [];
  function makeSandbox() {
    const sb = {
      console,
      Event: class {
        constructor(type) {
          this.type = type;
        }
      },
      /* 选择器只认守卫自己发出的这一条 */
      document: {
        querySelector: (sel) => (sel === "button.ws-browse" ? sb.__browse || null : null),
      },
      I18n: {
        t: (k) => String(k),
      },
      toast: (m, kind) => TOASTS.push({ m, kind }),
      __browse: null,
    };
    vm.runInContext(fnBody(DB, "workspaceReadOnlyGuard"), vm.createContext(sb), {
      filename: "app-db.js#ws-readonly",
    });
    return sb;
  }
  const ex = (sb, expr) => vm.runInContext(expr, sb);
  const makeInput = () => new FakeEl("input");

  /* ==================== [1] 守卫：拦键入（且没有恢复可编辑的入口） ==================== */
  console.log("\n[1] 只读守卫：字符键入被拦，且不给任何「变回可编辑」的口子");
  {
    const sb = makeSandbox();
    const inp = makeInput();
    const guard = ex(sb, "workspaceReadOnlyGuard")(inp);
    ok(!!guard && typeof guard.lockKeys === "function", "守卫装配成功（回 lockKeys / browse / hint）");
    ok(typeof guard.unlock !== "function" && typeof guard.locked !== "function",
      "没有 unlock / locked 入口（只读是常驻态，外部无法把框改成可编辑）");
    ok(inp.readOnly === true, "装配即只读（默认就是「只读」状态）");
    ok(!!inp.title && inp.title.indexOf("只读") >= 0, "title 直接说明这一格只读");

    TOASTS.length = 0;
    let ev = inp.emit("keydown", { key: "C" });
    ok(ev.defaultPrevented === true, "字母键 keydown 被拦（preventDefault）");
    ev = inp.emit("keydown", { key: "Spacebar" });
    ok(ev.defaultPrevented === true, "空格被拦（路径里混空格是常见错）");
    ev = inp.emit("keydown", { key: "Backspace" });
    ok(ev.defaultPrevented === true, "Backspace 被拦（敲掉一个字符同样是错路径）");
    ev = inp.emit("keydown", { key: "Delete" });
    ok(ev.defaultPrevented === true, "Delete 被拦");

    ev = inp.emit("keydown", { key: "Escape" });
    ok(ev.defaultPrevented === false, "Esc 放行（关弹窗 / 取消不受影响）");
    ev = inp.emit("keydown", { key: "Enter" });
    ok(ev.defaultPrevented === false, "Enter 放行（回车确认照旧）");
    ev = inp.emit("keydown", { key: "ArrowLeft" });
    ok(ev.defaultPrevented === false, "方向键放行（无字符按键不拦）");
    ok(TOASTS.length > 0 && TOASTS.every((t) => t.kind === "warn"), "第一次拦下时给一句 warn 提示");
    ok(TOASTS.length <= 2, "提示不刷屏（同一句只说一次）");

    ev = inp.emit("beforeinput", { inputType: "insertCompositionText" });
    ok(ev.defaultPrevented === true, "输入法逐字提交（beforeinput）同样被拦");
    ev = inp.emit("drop", {});
    ok(ev.defaultPrevented === true, "拖入文本被拦");

    /* lockKeys：占死「粘贴 / 双击」两条路（助手「仅当前画布」必须跟随画布口径） */
    let browsed = 0;
    guard.browse(() => browsed++);
    guard.lockKeys(true);
    ok(inp.readOnly === true, "lockKeys(true) 下仍是只读");
    ev = inp.emit("keydown", { key: "C" });
    ok(ev.defaultPrevented === true, "该状态下键入仍被拦");
    inp.emit("dblclick", {});
    ok(browsed === 0, "该状态下双击不弹选择器（跟随画布口径，改了也不算数）");
    guard.lockKeys(false);
    ok(inp.readOnly === true, "lockKeys(false) 也不放开展开键入（仍然是只读框）");
    inp.emit("dblclick", {});
    ok(browsed === 1, "lockKeys(false) 后双击恢复直选文件夹");
  }

  /* ==================== [2] 守卫：双击选目录 + 粘贴一次 ==================== */
  console.log("\n[2] 只读不等于没路走：双击直选文件夹 · Ctrl+V 粘贴路径");
  {
    const sb = makeSandbox();
    const inp = makeInput();
    const guard = ex(sb, "workspaceReadOnlyGuard")(inp);
    ok(inp.readOnly === true, "先确认只读");

    /* 双击：登记的 browse 被调用 */
    const calls = [];
    guard.browse(() => calls.push("browse"));
    inp.emit("dblclick", {});
    ok(calls.length === 1, "双击 → 直接弹系统文件夹选择器");

    /* 粘贴：值落框 + 派发 change；框始终只读，粘贴不经过原生插入 */
    const changes = [];
    inp.addEventListener("change", () => changes.push(inp.value));
    let ev = inp.emit("paste", { clipboardData: { getData: () => "  E:/dev/tools/pipeline-console  " } });
    ok(ev.defaultPrevented === true, "粘贴由守卫接管（不走原生插入）");
    ok(inp.value === "E:/dev/tools/pipeline-console", "粘贴的路径落进框，并去掉首尾空白");
    ok(changes.length === 1, "派发一次 change → 原有校验 / 落盘逻辑照常执行");
    ok(inp.readOnly === true, "粘贴期间 / 之后框始终只读（不给接着打错字的机会）");
    ev = inp.emit("paste", { clipboardData: { getData: () => "   " } });
    ok(inp.value === "E:/dev/tools/pipeline-console", "粘到空白 → 不改值");

    /* browse 未登记时双击只给提示，不抛错 */
    const sb2 = makeSandbox();
    const inp2 = makeInput();
    const g2 = ex(sb2, "workspaceReadOnlyGuard")(inp2);
    TOASTS.length = 0;
    ok(g2 && inp2.emit("dblclick", {}) && TOASTS.length >= 1, "没登记 browse 时双击退化成提示（不静默）");
  }

  /* ==================== [3] 选择器按钮：点击与双击都触发 ==================== */
  console.log("\n[3] 文件夹选择器：单击 / 双击都触发（按钮双击不落空）");
  {
    const src = fnBody(DB, "workspaceBrowseButton");
    ok(src.length > 0, "定位到 workspaceBrowseButton");
    HAS(src, "b.onclick = run;", "单击触发");
    HAS(src, "b.ondblclick = run;", "双击触发（只读框双击选目录，手感一致）");
    HAS(src, "pickFolder(inp, onPicked)", "回填仍走 pickFolder（系统窗口里可直接新建）");
    HAS(src, "mini btn-sq ws-browse", "样式类名沿用 .ws-browse（图标与样式不变）");
  }

  /* ==================== [4] 接线：四处外层工作目录输入都装配守卫 ==================== */
  console.log("\n[4] 接线契约：顶栏画布目录 / 新建画布 / 助手工作区 / 功能块项目文件夹");
  {
    const WF = fnBody(APP, "renderWfWorkspace");
    ok(WF.length > 0, "定位到 renderWfWorkspace（顶栏统一工作目录）");
    HAS(WF, "workspaceReadOnlyGuard(inp)", "顶栏画布项目目录装配只读守卫");
    HAS(WF, "inp.placeholder = I18n.t(\"统一目录(留空 = 各节点单独设置)…\")", "顶栏提示语不变（留空 = 各节点单独设置）");
    HAS(WF, "workspaceBrowseButton(inp", "顶栏保留选择器按钮");
    HAS(WF, "wsGuard.browse(", "顶栏双击 = 直选文件夹");
    ok(WF.indexOf("inp.addEventListener(\"change\"") >= 0 || WF.indexOf("inp.addEventListener('change'") >= 0,
      "change 校验 / 落盘逻辑保留（只读不改变语义）");
    ok(
      WF.indexOf("该路径不存在或不是有效文件夹，已自动清空。请重新选择有效的工作目录。") >= 0,
      "无效路径仍当场清空并提示（粘贴错路径也不会留在画布里）",
    );

    const NEW = APP.slice(
      APP.indexOf('const wsInp = document.createElement("input");'),
    );
    const seg = NEW.slice(0, NEW.indexOf('const foot = $("#ovFoot")'));
    HAS(seg, "workspaceReadOnlyGuard(wsInp)", "新建画布的工作目录装配只读守卫");
    HAS(seg, "workspaceBrowseButton(wsInp)", "新建画布保留选择器");
    HAS(seg, "wsGuard.browse(", "新建画布双击直选");
    ok(
      seg.indexOf("wsInp.placeholder = I18n.t(\"请选择已存在的文件夹…\")") >= 0,
      "新建画布的占位文案仍是「请选择已存在的文件夹…」",
    );

    const SYNC = fnBody(ASSIST, "syncAssistWorkspaceChrome");
    ok(SYNC.length > 0, "定位到 syncAssistWorkspaceChrome（助手工作区）");
    HAS(SYNC, "assistWsGuard = workspaceReadOnlyGuard(ws)", "助手工作区装配只读守卫（句柄只建一次）");
    HAS(SYNC, "assistWsGuard.lockKeys(locked || assistScopeIsCurrent())",
      "运行中锁定 / 「仅当前画布」都连粘贴也不给（跟随画布口径），其余情况仍是只读框");
    ok(!/assistWsGuard\.locked\(/.test(SYNC),
      "助手侧不再有「把框解回可编辑」的调用（locked(false) 曾让这条外层目录重新可手打）");
    HAS(SYNC, "assistWsGuard.browse(", "助手双击直选文件夹");
    HAS(ASSIST, "let assistWsGuard = null;", "守卫句柄声明为模块级 assistWsGuard");
    /* 声明 / 使用同名（app-assist.js 是 "use strict"）：这里曾经把句柄写成未声明的 wsGuard，
       严格模式下 syncAssistWorkspaceChrome 一进来就 ReferenceError（助手面板整只挂掉），
       而当时的断言也钉了同一个错名 —— 所以既钉正确名，也反查「不许出现裸 wsGuard」。 */
    ok(
      !/(?<![A-Za-z0-9_$.])wsGuard\s*[.(=]/.test(ASSIST),
      "app-assist.js 内不出现未声明的 wsGuard（严格模式下会抛 ReferenceError）",
    );
    /* 泛化一层：本文件里用到的每个 *Guard 标识符，都必须在 app-assist.js 或 app-db.js 有声明 */
    const guardIds = new Set();
    for (const m of ASSIST.matchAll(/(?<![A-Za-z0-9_$.])([A-Za-z_$][A-Za-z0-9_$]*Guard)\b/g)) guardIds.add(m[1]);
    const declared = (id, src) =>
      new RegExp("(?:function|let|var|const)\\s+" + id + "\\b").test(src) ||
      new RegExp("\\b" + id + "\\s*=\\s*(?:async\\s*)?(?:function|\\()").test(src);
    const undeclared = [...guardIds].filter((id) => !declared(id, ASSIST) && !declared(id, DB));
    ok(
      undeclared.length === 0,
      "app-assist.js 用到的 *Guard 标识符都有声明（ASSIST / app-db.js）" +
        (undeclared.length ? " → 未声明: " + undeclared.join(", ") : ""),
    );

    const DEV = fnBody(CANVAS, "promptDevProjectFolder");
    ok(DEV.length > 0, "定位到 promptDevProjectFolder（功能块项目文件夹 devPath）");
    HAS(DEV, "workspaceReadOnlyGuard(inp)", "项目文件夹装配只读守卫");
    HAS(DEV, "devGuard.browse(pickDevFolder)", "双击直选（与「选择文件夹…」同一个实现）");
    HAS(DEV, "browse.onclick = pickDevFolder;", "按钮单击仍触发系统选择器");
    ok(
      DEV.split("node.devPath").length - 1 === 1,
      "devPath 仍只写一处（只读改造没动写入路径）",
    );
    HAS(DEV, "const clear = document.createElement(\"button\");", "「清除」按钮保留（清空 devPath 仍可用）");
  }

  /* ==================== [5] 样式与词条 ==================== */
  console.log("\n[5] 只读的视觉与词条：虚线边框 + 中英词条齐备");
  {
    ok(
      /\.wf-ws-box input\[readonly\]\s*\{[^}]*border-style:\s*dashed/.test(CSS),
      "顶栏只读目录用虚线边框（与助手侧同一视觉口径）",
    );
    const ASSIST_CSS = read("renderer/css/assist.css");
    ok(
      /\.assist-ws-line input\[readonly\]\s*\{[^}]*border-style:\s*dashed/.test(ASSIST_CSS),
      "助手侧原有 readonly 样式未动",
    );
    const keys = ["工作目录只读：点右侧「选择文件夹」按钮选目录", "双击直选文件夹，Ctrl+V 粘贴路径"];
    I18n.setLocale("en");
    for (const k of keys) {
      const v = I18n.t(k);
      ok(v !== k && /[A-Za-z]{2,}/.test(v), "英文词条：「" + k + "」→「" + v + "」");
    }
    I18n.setLocale("zh");
    for (const k of keys) ok(I18n.t(k) === k, "中文界面原样显示：" + k);
    HAS(DB, "workspaceReadOnlyGuard", "守卫与选择器同在 app-db.js（渲染层公用件集中一处）");
    const at = (f) => HTML.indexOf('<script src="' + f + '"></script>');
    ok(at("app-db.js") > 0 && at("app-db.js") < at("app-canvas.js"), "app-db.js 先于 app-canvas.js 加载（app-canvas 可直接用守卫）");
  }

  console.log(
    "\n" +
      (fails ? "✗ " + fails + " / " + checks + " 项失败" : "✓ " + checks + " 项全部通过") +
      "  (smoke-workspace-readonly)",
  );
  if (fails ? 1 : 0) MERGED_FAILED = true;

  } catch (e) {
    MERGED_FAILED = true;
    console.log("FAIL  [合并块异常] smoke-workspace-readonly.js：" + (e && e.stack ? e.stack : e));
  }
  if (fails) console.log("  ── 已并入块 smoke-workspace-readonly.js：" + fails + " / " + checks + " 项失败");
})();

/* 收尾：正文与并入块任一失败都算这只红；退出码只在全部跑完之后才定 */
if (MERGED_FAILED) console.log("\n✗ 本文件有失败项（含已并入块）\n");
process.exit(MERGED_FAILED ? 1 : 0);
