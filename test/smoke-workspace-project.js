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
process.exit(fails ? 1 : 0);
