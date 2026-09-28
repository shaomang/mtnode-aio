"use strict";
/* 工具节点 / 函数节点 + 工具库 + Agent 工具调用握手 —— 链路级冒烟测试（纯 Node）
 *   node test/smoke-tools.js
 * 被测代码都是「真实源码切片 / 真实模块」，不是抄一份逻辑：
 *   renderer/app.js         isToolNode / isFunctionNode / isFnToolNode / fnToolParamList /
 *                           normFnToolEntry / ensureFnToolNodeState / applyToolConfigName /
 *                           inputCount / outputCount（参数即端子 · 增删参数 = 增删端子）/
 *                           NODE_DEFAULTS function/tool 默认形状 / makeNode 深拷贝创建
 *   renderer/js-exec.js     函数节点执行器（异步契约：run→Promise · 代码交主进程独立线程
 *                           fn-runtime.js · 停止走 fnCancel · 渲染层不执行用户代码；
 *                           真执行 / worker 起停 / 进程回收在 test/smoke-fn-runtime.js 覆盖）
 *   renderer/app-nodes.js   引擎接线契约源码断言（playNode 分发 / runFunctionNode / runToolNode）
 *   tools-store.js          主进程工具库存储（假 electron 捕获 ipcMain，直测 tools:list/get/
 *                           save/delete/patch 全部 handler：保存 / 覆盖 / 开关 / 删除）
 *   renderer/app-tools.js   画布↔库描述子、Agent 入参对齐、tool-run 帧执行与回执（真函数）
 *   dsh/gateway/gateway.mjs normRunTools（描述子收口 → env.MTNODE_TOOLS_JSON 指纹契约）
 *   dsh/gateway/tools-plugin.mjs / gateway.mjs / preload.js 源码契约
 * 覆盖：
 *   [1] 工具 / 函数节点创建与参数增删（参数即端子）
 *   [2] 工具 / 函数节点入出参执行（函数节点真执行 + 引擎接线）
 *   [3] 工具库 保存 / 插入（保存后清单可见）/ 删除 / 开关（会话随时可调用）
 *   [4] Agent 工具调用握手（链路级 mock 网关 ↔ 工具节点）
 *   [4b] 会话 UI 不再显示「本画布 / 工具库」可调用工具清单（下发链不变）
 *   [5]  工具节点两项修复回归（双击进子画布 + 内侧端子不重合）
 *   [6]  端口类型链路：端子类型判定逐条钉住（出参 kind 归一 + 设置面板写回 /
 *        声明优先于实际值 / saveMediaKind 选型与 .png·.yaml / connectError 图像·文本
 *        放行与拒绝文案逐字 / 工具·函数入参端子类型不匹配点名 / 旧画布出参无 kind 口径不变）
 *   [7]  入口分工：顶栏＝「工具库」（程序图标 · 打开后只有已保存的包）；
 *        建节点＝画布右键「工具」一级菜单（旧顶栏一级菜单词条与函数全清）
 * 真实执行 canvasCreateMenuGroups 的菜单结构回归见 test/smoke-media-gen-menu.js [1b]。
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const vm = require("vm");
const Module = require("module");

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

/* 源码切片：从 startMark 起、到 endMark 止 */
function between(src, startMark, endMark, label) {
  const i = src.indexOf(startMark);
  const j = i < 0 ? -1 : src.indexOf(endMark, i + startMark.length);
  const good = i >= 0 && j > i;
  ok(good, "定位到源码段：" + label);
  return good ? src.slice(i, j) : "";
}

/* 轻量 I18n：只替换 {var} 占位 */
const I18N_STUB = {
  t: (k, vars) =>
    String(k).replace(/\{(\w+)\}/g, (_, n) =>
      vars && vars[n] != null ? String(vars[n]) : "",
    ),
};

/* ═══════════════════════ [1] 创建与参数增删（参数即端子） ═══════════════════════ */
console.log("\n[1] 工具 / 函数节点创建与参数增删（参数即端子）");
const APP = read("renderer/app.js");
const FN_CORE = between(
  APP,
  "function isToolNode(n) {",
  "function canUseGlobalRefs(node) {",
  "app.js isToolNode / ensureFnToolNodeState / applyToolConfigName",
);
const SRC_OUT = between(
  APP,
  "function outputCount(n) {",
  "function uniqueTitleInWf(wf, desired) {",
  "app.js outputCount",
);
const SRC_IN = between(
  APP,
  "function inputCount(node) {",
  "function videoGenMode(node) {",
  "app.js inputCount",
);
const ND_TEXT = between(
  APP,
  "const NODE_DEFAULTS = {",
  "};",
  "app.js NODE_DEFAULTS（全量记录）",
);
const SRC_MKN = between(
  APP,
  "function makeNode(kind, x, y) {",
  "function uniqueNodeTitle(desired, exceptId) {",
  "app.js makeNode",
);

const TOOLS = read("renderer/app-tools.js");
const SRC_TOOLS = between(
  TOOLS,
  "function agentToolAsciiName(name, key) {",
  "/* " + "═".repeat(11) + " 通用「试跑」台",
  "app-tools.js Agent 工具调用链路（描述子 / 入参对齐 / tool-run 回执）",
);
/* agentUserToolsSnapshot 的 always 过滤走 toolEntryKind（函数包不进 Agent 可调用清单），
   该函数在文件更早处，另起一段切片供同一 vm 上下文使用 */
const SRC_TOOLS_ENTRY = between(
  TOOLS,
  "function toolEntryKind(entry) {",
  "/* 名称写回（保存 / 改名共用",
  "app-tools.js toolEntryKind",
);

/* 单一 vm 上下文：真实源码函数 + 少量外围桩（桩是外围环境，不是被测逻辑） */
const PRELUDE = `
var ND = ({}), U = 0;
function uid(p) { U++; return (p || 'n') + U; }
function snap(v) { return Math.round(Number(v || 0) / 24) * 24; }
function assignDefaultProvider() {}
function currentTaskFocus() { return ''; }
function currentSuperFocus() { return ''; }
function nodeById() { return null; }
function findOpenSuperAtWorld() { return null; }
function findSuperAtWorld() { return null; }
function superHostAtWorld() { return null; }
var NODE_FORM_OF_KIND = { tool: "super" };
var DEFAULT_IMAGE_SIZE = "2048x1360";
var AGENT_PRESETS = [], AGENT_PRESET_DEFAULT = "minimal";
function uniqueNodeTitle(desired) { return String(desired); }
function toast() {}
function isSaveNode() { return false; }
function isExecEnd() { return false; }
function isExecStart() { return false; }
function allWiresTo() { return []; }
function isSuperIoNode(n) { return !!(n && n.kind === 'super_io'); }
function runToolNode() {}
var S = { wf: null };
var window = {};
`;
const SB = vm.createContext({ console, I18n: I18N_STUB });
vm.runInContext(
  PRELUDE +
    "\n" +
    ND_TEXT +
    "};\nNODE_DEFAULTS.tool = Object.assign({}, NODE_DEFAULTS.super, NODE_DEFAULTS.tool, { tool: true });",
  SB,
);
vm.runInContext(FN_CORE + "\n" + SRC_OUT + "\n" + SRC_IN + "\n" + SRC_MKN + "\n" + SRC_TOOLS + "\n" + SRC_TOOLS_ENTRY, SB);

function exec(ctx, code) {
  try {
    vm.runInContext(code, ctx);
    return null;
  } catch (e) {
    return String((e && e.message) || e);
  }
}
/* 同步表达式探针：true 才算过 */
function P(expr, msg) {
  let v;
  try {
    v = vm.runInContext("(" + expr + ")", SB);
  } catch (e) {
    v = "ERR:" + String((e && e.message) || e);
  }
  ok(v === true, msg);
}
/* 异步探针：body 为 async 函数体，返回结果值 */
async function A(body, msg, expect) {
  let v;
  try {
    v = await vm.runInContext("(async () => { " + body + " })()", SB);
  } catch (e) {
    v = "ERR:" + String((e && e.message) || e);
  }
  const pass = expect ? expect(v) : !!v;
  ok(pass, msg + (typeof v === "string" && v.indexOf("ERR:") === 0 ? "  [" + v + "]" : ""));
}

/* —— 默认形状 —— */
P('NODE_DEFAULTS.function && NODE_DEFAULTS.function.title === "函数" && Array.isArray(NODE_DEFAULTS.function.inputs) && Array.isArray(NODE_DEFAULTS.function.outputs) && NODE_DEFAULTS.function.jscode === "" && NODE_DEFAULTS.function.fnName === ""', "NODE_DEFAULTS.function：标题「函数」+ 空参数表/代码/函数名");
P('NODE_DEFAULTS.tool && NODE_DEFAULTS.tool.title === "工具" && NODE_DEFAULTS.tool.tool === true && !!NODE_DEFAULTS.tool.toolConfig && NODE_DEFAULTS.tool.toolConfig.name === "" && Array.isArray(NODE_DEFAULTS.tool.toolConfig.inputs) && Array.isArray(NODE_DEFAULTS.tool.toolConfig.outputs)', "NODE_DEFAULTS.tool：super 字段合成 + 标题「工具」+ 变体标记 tool:true + toolConfig 结构");
/* —— 创建（makeNode 深拷贝，不改默认值） —— */
P('makeNode("nope", 0, 0) === null', "未知 kind → makeNode 返回 null");
exec(SB, 'mt2 = makeNode("tool", 0, 0); mf1 = makeNode("function", 0, 0);');
P('mt2 && mt2.kind === "super" && mt2.tool === true && !!mt2.toolConfig && Array.isArray(mt2.toolConfig.inputs) && mt2.toolConfig.inputs.length === 0', "makeNode('tool') → super+tool:true 变体且参数表为空（NODE_FORM_OF_KIND 换算）");
P('mf1 && mf1.kind === "function" && Array.isArray(mf1.inputs) && Array.isArray(mf1.outputs)', "makeNode('function') 创建成功且参数表为空");
exec(SB, 'mt2.toolConfig.inputs.push({ name: "x", kind: "text" });');
P('NODE_DEFAULTS.tool.toolConfig.inputs.length === 0', "实例改参数不污染 NODE_DEFAULTS（深拷贝）");
exec(SB, 'mt3 = makeNode("tool", 0, 0);');
P('mt3.toolConfig.inputs.length === 0', "每次创建都是全新参数表（无共享引用）");
/* —— 判定单一真源：工具双形态 + 函数 —— */
P('isToolNode({ kind: "tool" }) && isToolNode({ kind: "super", tool: true }) && !isToolNode({ kind: "super" }) && !isToolNode({ kind: "super", tool: true, db: true }) && !isToolNode({ kind: "function" })', "isToolNode：kind tool 与 super+tool:true 都认，db 变体不认");
P('isFunctionNode({ kind: "function" }) && !isFunctionNode({ kind: "tool" })', "isFunctionNode 只认 kind function");
P('isFnToolNode({ kind: "tool" }) && isFnToolNode({ kind: "super", tool: true }) && isFnToolNode({ kind: "function" }) && !isFnToolNode({ kind: "super" }) && !isFnToolNode(null)', "isFnToolNode = 工具或函数");
/* —— 参数增删 = 端子增删（0 号控制入 / 末位控制出固定） —— */
exec(SB, `
ft = makeNode("tool", 0, 0);
ft.toolConfig.inputs.push({ name: "关键词", kind: "text" }, { name: "图", kind: "image" });
ft.toolConfig.outputs.push({ name: "结果", kind: "text" });
ensureFnToolNodeState(ft);
ff = makeNode("function", 0, 0);
ff.inputs.push({ name: "a", kind: "text" }, { name: "b", kind: "text" });
ff.outputs.push({ name: "sum", kind: "text" });
ensureFnToolNodeState(ff);
sv = { id: "sv1", kind: "super", tool: true, title: "工具变体" };
ensureFnToolNodeState(sv);
`);
P('ft.kind === "super" && ft.tool === true && fnToolParamList(ft, "in").length === 2 && fnToolParamList(ft, "out").length === 1', "工具节点：加 2 入参 1 出参后参数表正确");
P('inputCount(ft) === 3 && outputCount(ft) === 2', "工具节点端子 = 参数 + 固定控制口（3 入 / 2 出）");
P('inputCount(ff) === 3 && outputCount(ff) === 2', "函数节点同样参数即端子（3 入 / 2 出）");
P('inputCount(sv) === 1 && outputCount(sv) === 1 && !!sv.toolConfig && Array.isArray(sv.toolConfig.inputs) && sv.toolConfig.name === ""', "super+tool:true 变体结构归一并给出固定控制口（0 参 1/1）");
P('inputCount(mf1) === 1 && outputCount(mf1) === 1', "新建 0 参函数节点只有控制口（1/1）");
exec(SB, 'ft.toolConfig.inputs.splice(0, 1); ensureFnToolNodeState(ft);');
P('fnToolParamList(ft, "in").length === 1 && fnToolParamList(ft, "in")[0].kind === "image" && inputCount(ft) === 2', "删除一条入参 → 输入端子同步减一（参数即端子）");
P('outputCount(ft) === 2', "删入参不动出参端子（固定归属不重排）");
/* —— 结构归一（幂等）：缺名补「参数 N」/ kind 白名单 —— */
exec(SB, `
fu = makeNode("function", 0, 0);
fu.inputs = [{ name: "x", kind: "weird" }, { kind: "image" }, { name: "" }];
fu.outputs = [{ kind: "audio" }];
ensureFnToolNodeState(fu);
ftu = makeNode("tool", 0, 0);
ftu.toolConfig.inputs = [{ name: "" }, { name: "b", kind: "bad" }];
ensureFnToolNodeState(ftu);
`);
P('fu.inputs[0].name === "x" && fu.inputs[0].kind === "text" && fu.inputs[1].kind === "image" && fu.inputs[1].name === "参数 2" && fu.inputs[2].name === "参数 3"', "函数节点：kind 白名单 text/image + 缺名补「参数 N」");
P('fu.outputs[0].kind === "text" && fu.outputs[0].name === "参数 1"', "输出参数 kind 归一为 text，缺名补位");
P('ftu.toolConfig.inputs[0].name === "参数 1" && ftu.toolConfig.inputs[1].name === "b" && ftu.toolConfig.inputs[1].kind === "text"', "工具节点：同样归一规则落在 toolConfig.inputs");
/* —— 工具名 ↔ 标题联动 —— */
exec(SB, `
t1 = makeNode("tool", 0, 0);
t1.title = "工具";
applyToolConfigName(t1, "翻译助手");
t2 = makeNode("tool", 0, 0);
t2.title = "手动标题";
t2.toolConfig.name = "老名";
applyToolConfigName(t2, "新名");
t3 = makeNode("tool", 0, 0);
t3.title = "工具 3";
applyToolConfigName(t3, "汇总工具");
`);
P('t1.toolConfig.name === "翻译助手" && t1.title === "翻译助手"', "改工具名：标题仍为默认「工具」时自动同步");
P('t2.toolConfig.name === "新名" && t2.title === "手动标题"', "标题被手动改过 → 工具名独立不再跟随");
P('t3.toolConfig.name === "汇总工具" && t3.title === "汇总工具"', "默认标题带序号（工具 3）也视为默认并同步");

/* ═══════════════════════ [2] 入出参执行契约（js-exec 异步 + 引擎接线源码断言） ═══════════════════════ */
console.log("\n[2] 工具 / 函数节点执行契约（js-exec 异步 · 引擎接线源码断言 · 行为断言见 [2b]）");
const EXEC_SRC = read("renderer/js-exec.js");
const EX = vm.createContext({ console, window: {} });
vm.runInContext(EXEC_SRC, EX);
const jsx = EX.window.mtnodeJsExec;
ok(!!jsx && typeof jsx.run === "function" && typeof jsx.toOutput === "function", "js-exec.js 挂出 mtnodeJsExec.run / cancel / toOutput");

/* 行为断言已搬到下方 async 段 [2b]：run() 现在是 Promise —— 渲染层不再同步执行
   用户代码（真执行在 test/smoke-fn-runtime.js），这里只留 toOutput 纯函数（同步）。 */

const o1 = jsx.toOutput("文本");
ok(o1.kind === "text" && o1.text === "文本", "toOutput 字符串 → text");
ok(jsx.toOutput(12).text === "12" && jsx.toOutput(true).text === "true" && jsx.toOutput(9n).text === "9", "toOutput 数字/布尔/bigint → text");
ok(jsx.toOutput({ text: "T" }).kind === "text" && jsx.toOutput({ text: "T" }).text === "T", "toOutput 对象带 text → text");
const op1 = jsx.toOutput({ path: "C:/a/b.png" });
ok(op1.kind === "image" && op1.path === "C:/a/b.png" && op1.text === "C:/a/b.png", "toOutput 路径按扩展名判媒体（png → image）");
ok(jsx.toOutput({ path: "C:/a/b.wav" }).kind === "audio" && jsx.toOutput({ path: "C:/a/b.mp4" }).kind === "video" && jsx.toOutput({ path: "C:/a/b.xyz" }).kind === "path", "toOutput wav/mp4/其它扩展名归类");
ok(jsx.toOutput({ kind: "image", path: "i.png" }).kind === "image" && jsx.toOutput({ kind: "video", path: "v.mp4", text: "副标题" }).text === "副标题", "toOutput 显式 kind 透传");
ok(jsx.toOutput({ a: 1 }).kind === "text" && String(jsx.toOutput({ a: 1 }).text).indexOf('"a"') >= 0, "toOutput 纯对象 JSON 序列化为 text");
ok(jsx.toOutput(null).kind === "text" && jsx.toOutput(null).text === "" && jsx.toOutput(undefined).text === "", "toOutput null/undefined → 空文本");

const NODES = read("renderer/app-nodes.js");
ok(/if \(node\.kind === "function"\) \{\s*\n\s*return runFunctionNode\(node, quiet, opts\);/.test(NODES), "playNode 把 kind function 分发给 runFunctionNode");
ok(/if \(isToolNode\(node\)\) \{\s*\n\s*return runToolNode\(node, quiet, opts\);/.test(NODES), "playNode 把 tool 判定分发给 runToolNode（super+tool:true 变体 · 排在普通 super 前）");
ok(NODES.indexOf("function isComputeExecKind(n) {") >= 0 && /isFunctionNode\(n\) \|\| isToolNode\(n\)/.test(NODES), "isComputeExecKind 覆盖 function / tool（规范形态判定）");
ok(NODES.indexOf('window.mtnodeJsExec') >= 0 && NODES.indexOf("await engine.run(code, input, {") >= 0 && NODES.indexOf('runId: fnRunId(n, "run")') >= 0 && NODES.indexOf("onCancel: (cancelRun) => fnSetCancel(n, cancelRun)") >= 0, "runFunctionNode：await engine.run（异步提交主进程独立线程）· runId=fnRunId · onCancel 注册停止句柄");
ok(NODES.indexOf("n.portOutputs = m.ports;") >= 0 && NODES.indexOf("ports.__error = \"\";") >= 0 && NODES.indexOf("n.output = m.ports.$0") >= 0, "函数/计算执行写回 portOutputs（入出参执行输出端子 · m.ports.$0 主输出）");
ok(NODES.indexOf("工具节点内部没有可执行的节点") >= 0 && NODES.indexOf("superInternalOutFeedsAll(n)") >= 0 && NODES.indexOf("n.portOutputs = outs;") >= 0, "runToolNode：内部图运行 + 内侧汇流写回输出端子");
ok(NODES.indexOf("runControlRunnableQueue(null, runnable, seen") >= 0, "runToolNode 复用 runControlRunnableQueue 调度内部图");
/* —— 修复回归源码契约：异步执行 / 并发闸 / 停止链 fnCancel（函数节点不再锁死 MTNode） —— */
ok(/async function runFunctionNode\(node, quiet, opts\)/.test(NODES) && /async function runToolNode\(node, quiet, opts\)/.test(NODES) && /async function testFunctionNode\(node, args\)/.test(NODES), "runFunctionNode / runToolNode / testFunctionNode 全部 async（渲染层只 await，执行体在主进程线程）");
ok(NODES.indexOf("fnSetCancel(n, null)") >= 0, "runFunctionNode：finally 注销停止句柄（运行结束即无句柄可停）");
ok(NODES.indexOf("const COMPUTE_EXEC_CONCURRENCY = 4;") >= 0, "计算执行并发闸常量 COMPUTE_EXEC_CONCURRENCY = 4（槽满排队）");
ok(NODES.indexOf("async function computeExecAcquire(node)") >= 0 && NODES.indexOf("function computeExecRelease(node)") >= 0 && NODES.indexOf("function computeExecDropWait(node)") >= 0, "并发闸：Acquire / Release（幂等）/ DropWait（停止即退出「等待中」）");
ok(NODES.indexOf("const gate = await computeExecAcquire(node);") >= 0 && NODES.indexOf('gate.mode === "dropped"') >= 0, "runComputeExecNode：先进闸 —— 排队期间被终止整次作废，绝不起线程/进程");
ok(/finally \{\s*\n\s*computeExecRelease\(node\);/.test(NODES), "runComputeExecNode：finally 释放槽位（异常路径也不漏槽）");
ok(NODES.indexOf("function computeExecYieldPaint()") >= 0 && NODES.indexOf("waitCanvasPaint") >= 0, "running=true 后让出一帧刷「运行中」再进执行体（computeExecYieldPaint · rAF + 80ms 兜底）");
ok(NODES.indexOf("function fnRunId(node, tag)") >= 0 && NODES.indexOf('"#" + (tag || "run") + "#" + seq') >= 0, "runId = 节点id#run#<本次运行代号>（一次运行只允许一套线程 / 进程）");
ok(NODES.indexOf("const FN_CANCEL_HANDLES = new Map();") >= 0 && NODES.indexOf("function fnSetCancel(node, fn)") >= 0 && NODES.indexOf("async function fnCancelRunsOf(node)") >= 0 && NODES.indexOf("async function fnCancelRunsOfNodes(nodes)") >= 0, "停止链：句柄表 FN_CANCEL_HANDLES + fnCancelRunsOf 统一取消入口（工具壳连壳内）");
ok(NODES.indexOf("function fnRunInFlight(node)") >= 0 && NODES.indexOf("function fnRunQueued(node)") >= 0 && NODES.indexOf("function computeExecNodeActive(node)") >= 0, "活动口径：在途（句柄 / 持槽）∪ 排队（等待中）——切画布不甩幽灵运行");
const APP2 = read("renderer/app.js");
ok(APP2.indexOf("if (isComputeExecKind(node)) {") >= 0 && APP2.indexOf("await fnCancelRunsOf(node)") >= 0, "stopNode：函数 / 工具节点分支走 fnCancelRunsOf（terminate + 进程树回收）");
ok(APP2.indexOf('I18n.t("已取消该节点的排队运行")') >= 0 && APP2.indexOf('I18n.t("已停止并回收 ")') >= 0 && APP2.indexOf('I18n.t("已停止该节点的运行")') >= 0 && APP2.indexOf('I18n.t("已请求停止运行…")') >= 0, "stopNode toast 四档文案（排队取消 / 已停止并回收 N 个进程 / 已停止 / 已请求停止）");
ok(APP2.indexOf('I18n.t("回收 ")') >= 0 && APP2.indexOf('I18n.t(" 个进程")') >= 0 && APP2.indexOf('I18n.t("已回收 ")') >= 0, "全部终止 / 删除节点聚合 toast 带回收进程数（用户看得见「进程已经不在了」）");

/* ═══════════════════════ [3] 工具库 保存 / 插入 / 删除 / 开关 ═══════════════════════ */
console.log("\n[3] 工具库 保存 / 插入（清单）/ 删除 / 开关（会话随时可调用）");
/* 假 electron：只留 ipcMain.handle（照 smoke-workflow-delete.js 的做法） */
const handlers = new Map();
const electronStub = {
  ipcMain: { handle: (ch, fn) => handlers.set(ch, fn), on() {}, once() {}, off() {}, removeHandler() {}, removeAllListeners() {} },
  ipcRenderer: { sendSync: () => undefined, send() {}, on() {}, invoke: () => Promise.resolve(), removeListener() {} },
  app: {},
  dialog: {},
};
const origLoad = Module._load;
Module._load = function (request) {
  if (request === "electron") return electronStub;
  return origLoad.apply(this, arguments);
};
require(path.join(__dirname, "..", "tools-store.js"));
Module._load = origLoad;

const LIB_TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-tools-"));
const { registerToolsIpc } = require(path.join(__dirname, "..", "tools-store.js"));
registerToolsIpc({ getDataDir: () => LIB_TMP });
ok(handlers.has("tools:list") && handlers.has("tools:get") && handlers.has("tools:save") && handlers.has("tools:delete") && handlers.has("tools:patch"), "registerToolsIpc 注册 tools:list/get/save/delete/patch");
const call = (ch, arg) => Promise.resolve(handlers.get(ch)(null, arg));

(async () => {
  /* ═════════════ [2b] 渲染层执行器异步契约（回归 · 修复「函数节点一跑就锁死 MTNode」） ═════════════
   * 代码不再在渲染层执行：js-exec.run 只把 {runId, code, input, timeoutMs} 交给主进程
   * （window.api.fnRun → 主进程独立线程 fn-runtime.js），渲染层只 await、可随时 fnCancel。
   * 这里用假 fnRun / fnCancel 钉住渲染层这一半的契约；worker 真执行 / 超时 / 进程回收
   * 在 test/smoke-fn-runtime.js 覆盖（真加载 fn-runtime.js / main-proc-host.js）。 */
  console.log("\n[2b] 渲染层执行器异步契约（run→Promise · 停止走 fnCancel）");
  {
    const EXB = vm.createContext({ console, window: {} });
    vm.runInContext(EXEC_SRC, EXB);
    const jxb = EXB.window.mtnodeJsExec;
    const runCalls = [];
    const cancelCalls = [];
    let cancelFn = null;
    /* 先验「没有主进程桥」的路径：绝不退回渲染层自己执行（未接 api 也返回 Promise） */
    const pProbe = jxb.run("return 1", {}, { runId: "rid-0" });
    ok(typeof pProbe.then === "function", "run() 返回 Promise（渲染层不再同步执行用户 JS —— 事件循环不被占住）");
    const rcNoApi = await pProbe;
    ok(rcNoApi.ok === false && String(rcNoApi.error).indexOf("未就绪") >= 0, "无 window.api.fnRun → ok:false（不退回渲染层执行用户代码）");
    ok(typeof jxb.cancel === "function", "mtnodeJsExec.cancel 暴露（停止链入口）");
    EXB.window.api = {
      fnRun: async (p) => {
        runCalls.push(p);
        if (String(p.code).indexOf("__boom__") >= 0)
          return { ok: false, error: "boom-error", runId: p.runId, killedProcs: 0, killedPids: [], durationMs: 1 };
        if (String(p.code).indexOf("__winref__") >= 0)
          return { ok: false, error: "window is not defined", runId: p.runId, killedProcs: 0, killedPids: [], durationMs: 1 };
        if (String(p.code).indexOf("__cancel__") >= 0)
          return { ok: false, error: "已手动停止", cancelled: true, runId: p.runId, killedProcs: 3, killedPids: [11, 12, 13], durationMs: 2 };
        const out = p.input || {};
        return { ok: true, value: (Number(out.a) || 0) + (Number(out.b) || 0), runId: p.runId, killedProcs: 0, killedPids: [], durationMs: 3 };
      },
      fnCancel: async (id) => {
        cancelCalls.push(id);
        return { ok: true, cancelled: true, error: "已手动停止", runId: id, killedProcs: 2, killedPids: [7, 8], durationMs: 4 };
      },
    };
    const rc1 = await jxb.run("return input.a + input.b", { a: 2, b: 5 }, { runId: "rid-1", timeoutMs: 5000 });
    ok(rc1 && rc1.ok === true && rc1.value === 7 && rc1.error === "", "await run → ok:true，value 来自主进程回帧（渲染层不自己执行代码）");
    ok(rc1.runId === "rid-1" && rc1.durationMs === 3 && rc1.killedProcs === 0 && Array.isArray(rc1.killedPids), "结果归一带 runId / durationMs / killedProcs / killedPids");
    ok(runCalls.length === 1 && runCalls[0].runId === "rid-1" && runCalls[0].code === "return input.a + input.b" && runCalls[0].input.a === 2 && runCalls[0].input.b === 5 && runCalls[0].timeoutMs === 5000, "fn:run 载荷 = { runId, code, input, timeoutMs }（代码原样交主进程）");
    const rcEmpty = await jxb.run("   ", {}, { runId: "rid-2" });
    ok(rcEmpty.ok === false && rcEmpty.error === "代码为空" && runCalls.length === 1, "空代码本地短路（不发 IPC）");
    const rcErr = await jxb.run("__boom__", {}, { runId: "rid-3" });
    ok(rcErr.ok === false && rcErr.error === "boom-error", "主进程 ok:false → 归一 {ok:false,error}（异常不外抛，不炸执行器）");
    const rcWin = await jxb.run("__winref__", {}, { runId: "rid-4" });
    ok(rcWin.ok === false && String(rcWin.error).indexOf("独立线程运行") >= 0 && String(rcWin.error).indexOf("mtnode.exec") >= 0, "window 报错自动附迁移提示（点名 mtnode.exec / mtnode.spawn · 隐藏启动随运行回收）");
    const rcCan = await jxb.run("__cancel__", {}, { runId: "rid-5" });
    ok(rcCan.ok === false && rcCan.cancelled === true && rcCan.error === "已手动停止" && rcCan.killedProcs === 3, "被停止回帧 cancelled:true + killedProcs（「已停止并回收 N 个进程」toast 的数据源）");
    const rcOn = jxb.run("return 1", {}, { runId: "rid-6", onCancel: (cb) => { cancelFn = cb; } });
    ok(typeof cancelFn === "function" && rcOn.runId === "rid-6", "onCancel 句柄同步交回调用方（停止链登记）· runId 挂在 Promise 上");
    const cRes = await cancelFn();
    ok(cancelCalls.length === 1 && cancelCalls[0] === "rid-6" && cRes.ok === true && cRes.killedProcs === 2, "取消 → window.api.fnCancel(runId)（主进程 terminate 线程 + 回收进程树）");
    await rcOn;
    EXB.window.api = {
      fnRun: async () => { throw new Error("ipc-down"); },
      fnCancel: async () => ({ ok: true }),
    };
    const rcRej = await jxb.run("return 1", {}, { runId: "rid-7" });
    ok(rcRej.ok === false && String(rcRej.error).indexOf("ipc-down") >= 0, "fn:run IPC 异常 → 归成 {ok:false,error}（渲染层拿到 Promise 而非抛错）");
  }

  /* —— 保存：新 id / 校验 —— */
  let r = await call("tools:save", { name: "   ", inputs: [] });
  ok(r.ok === false, "空工具名拒绝保存");
  const pkgA = {
    name: "查库存",
    description: "查询仓库数量",
    inputs: [{ name: "仓库", kind: "text" }, { name: "图", kind: "image" }, { kind: "video" }],
    outputs: [{ name: "数量", kind: "text" }],
    always: true,
    graph: { rootId: "r1", nodes: [{ id: "r1", title: "查库存", toolConfig: { name: "查库存" } }, { id: "c1", kind: "function" }], wires: [] },
  };
  r = await call("tools:save", pkgA);
  ok(r.ok === true && /^[A-Za-z0-9_-]{4,80}$/.test(String(r.id)), "保存成功返回合法新 id（tools 目录落盘）");
  const idA = String(r.id);
  const libFile = path.join(LIB_TMP, "tools", idA + ".json");
  ok(fs.existsSync(libFile), "工具包落盘 <数据目录>/tools/<id>.json");
  let list = await call("tools:list");
  /* 清单里还有应用内置条目（builtin: 前缀 · 随包发版）：它们不是用户数据，
     本段的断言只针对用户保存的工具，所以一律先滤掉内置项 */
  const userTools = (l) => ((l && l.tools) || []).filter((t) => !t.builtin);
  ok(list.ok && userTools(list).length === 1, "保存后 tools:list 可见（供插入/开关/改名/删除）");
  const rowA = userTools(list)[0];
  ok(rowA.name === "查库存" && rowA.description === "查询仓库数量" && rowA.always === true && rowA.nodeCount === 2 && rowA.wireCount === 0, "清单行：名称/描述/开关/内部图节点与连线数");
  ok(rowA.inputs.length === 3 && rowA.inputs[0].name === "仓库" && rowA.inputs[0].kind === "text" && rowA.inputs[1].kind === "image" && rowA.inputs[2].kind === "text" && rowA.inputs[2].name === "参数 3", "入参归一：kind 白名单 + 缺名补「参数 N」（video → text）");
  ok(rowA.outputs[0].name === "数量" && rowA.outputs[0].kind === "text", "出参原样保留");
  /* —— 改名 #1（内部根标题仍为旧名）：同步 toolConfig.name 与标题 —— */
  r = await call("tools:patch", { id: idA, patch: { name: "库存查询" } });
  let g = await call("tools:get", idA);
  let root = g.tool.graph.nodes.find((n) => n.id === "r1");
  ok(r.ok === true && root.toolConfig.name === "库存查询" && root.title === "库存查询", "改名同步内部根 toolConfig.name 与标题（根标题仍为旧名时跟随）");
  /* —— 同名覆盖：保留原 id 与 createdAt（开关延续） —— */
  const pkgB = JSON.parse(JSON.stringify(pkgA));
  pkgB.id = idA;
  pkgB.name = "查库存·升级";
  r = await call("tools:save", pkgB);
  ok(r.ok === true && r.id === idA, "带已有 id 再次保存 = 覆盖同一份（id 不变）");
  list = await call("tools:list");
  ok(userTools(list).length === 1 && userTools(list)[0].name === "查库存·升级", "覆盖后名称更新");
  g = await call("tools:get", idA);
  ok(g.ok && g.tool.name === "查库存·升级" && g.tool.graph.rootId === "r1" && Array.isArray(g.tool.graph.nodes), "tools:get 取回完整工具包（含内部图快照）");
  ok((await call("tools:get", "nope_1234")).ok === false, "tools:get 不存在 id → 工具不存在");
  ok((await call("tools:get", "ab")).ok === false, "tools:get 非法 id → 拒绝");
  /* —— 开关（会话随时可调用） —— */
  r = await call("tools:patch", { id: idA, patch: { always: false } });
  ok(r.ok === true, "patch always=false 成功");
  list = await call("tools:list");
  ok(userTools(list)[0].always === false, "开关关闭后清单 always=false（Agent 不再随时可调用）");
  r = await call("tools:patch", { id: idA, patch: { always: true } });
  list = await call("tools:list");
  ok(userTools(list)[0].always === true, "开关重新打开 always=true");
  /* —— 改名 #2（包内根标题 ≠ 旧名）：只同步 toolConfig.name，标题保留 —— */
  r = await call("tools:patch", { id: idA, patch: { name: "库存查询·进阶" } });
  g = await call("tools:get", idA);
  root = g.tool.graph.nodes.find((n) => n.id === "r1");
  ok(r.ok === true && root.toolConfig.name === "库存查询·进阶" && root.title === "查库存", "根标题 ≠ 旧名 → 只同步 toolConfig.name，标题保留（口径同渲染层 applyToolConfigName）");
  /* —— 删除 —— */
  r = await call("tools:delete", idA);
  ok(r.ok === true && !fs.existsSync(libFile), "删除后文件消失");
  list = await call("tools:list");
  ok(list.ok && userTools(list).length === 0, "删除后清单为空（用户工具清空；内置条目仍在，见 smoke-desktop-capture.js）");
  ok((await call("tools:patch", { id: idA, patch: { always: true } })).ok === false, "删除后再 patch → 工具不存在");

  fs.rmSync(LIB_TMP, { recursive: true, force: true });
  console.log("\n[3b] 库桥契约（preload ↔ renderer）");
  const PRE = read("preload.js");
  ok(/toolsList: \(\) => ipcRenderer\.invoke\('tools:list'\)/.test(PRE) && /toolsSave: \(pkg\) => ipcRenderer\.invoke\('tools:save', pkg\)/.test(PRE), "preload 桥暴露 toolsList/toolsSave");
  ok(/toolsGet: \(id\) => ipcRenderer\.invoke\('tools:get', id\)/.test(PRE) && /toolsDelete: \(id\) => ipcRenderer\.invoke\('tools:delete', id\)/.test(PRE) && /toolsPatch: \(id, patch\) => ipcRenderer\.invoke\('tools:patch', \{ id, patch \}\)/.test(PRE), "preload 桥暴露 toolsGet/toolsDelete/toolsPatch");
  ok(TOOLS.indexOf("api.toolsList") >= 0 && TOOLS.indexOf("api.toolsSave") >= 0 && TOOLS.indexOf("api.toolsGet") >= 0 && TOOLS.indexOf("api.toolsDelete") >= 0 && TOOLS.indexOf("api.toolsPatch") >= 0, "app-tools.js 走 window.api.tools* 与主进程 store 握手");

  /* ═══════════════════════ [4] Agent 工具调用握手（链路级 mock 网关 ↔ 工具节点） ═══════════════════════ */
  console.log("\n[4] Agent 工具调用握手（链路级 mock 网关 ↔ 工具节点）");
  /* —— 描述子：画布工具节点 + 库中 always 工具 —— */
  P('agentToolAsciiName("查库存", "cn:n1") === agentToolAsciiName("查库存", "cn:n1")', "ASCII 注册名确定性（同 key 稳定，供指纹分池与 model 调用）");
  P('/^mtnode_tool_[a-z0-9_]{1,24}_[a-z0-9]{5}$/.test(agentToolAsciiName("查库存", "cn:n1"))', "ASCII 注册名格式 mtnode_tool_<净化名>_<key 哈希>");
  P('agentToolAsciiName("Calc", "k") !== agentToolAsciiName("Dict", "k")', "不同 ASCII 工具名注册名不同（模型按名调用不撞名）");
  exec(SB, `
toolN1 = { id: "cn1", kind: "tool", title: "工具A", toolConfig: { name: "查库存", description: "查仓库数量", inputs: [{ name: "仓库", kind: "text" }], outputs: [{ name: "数量", kind: "text" }] } };
wfA = { id: "w1", nodes: [toolN1, { id: "x2", kind: "input_text", title: "无关节点" }], wires: [] };
libAlways = { id: "tid1", name: "计算器", description: "四则", inputs: [{ name: "a", kind: "text" }], outputs: [{ name: "r", kind: "text" }], always: true };
libOff = { id: "tid2", name: "闲置工具", description: "", inputs: [], outputs: [], always: false };
`);
  await A("window.api = { toolsList: async () => ({ ok: true, tools: [libAlways, libOff] }) }; snap1 = await agentUserToolsSnapshot(wfA); return snap1.descs.length;", "工具描述子快照 = 画布工具节点 + always 库工具", (v) => v === 2);
  await A("return snap1.byKey['cn:cn1'] ? snap1.byKey['cn:cn1'].origin : '';", "画布描述子 key = cn:<nodeId>", (v) => v === "canvas");
  await A("return snap1.byKey['lib:tid1'] ? snap1.byKey['lib:tid1'].origin : '';", "库描述子 key = lib:<id>", (v) => v === "lib");
  await A("return !!snap1.byKey['lib:tid2'];", "always=false 的工具不进快照（会话不可调用）", (v) => v === false);
  await A("return snap1.descs[0].toolName;", "描述子带 ASCII toolName（模型发起 function call 用）", (v) => /^mtnode_tool_/.test(String(v)));
  exec(SB, 'wfDup = { id: "w2", nodes: [toolN1, toolN1], wires: [] };');
  await A("window.api = { toolsList: async () => ({ ok: true, tools: [] }) }; snapDup = await agentUserToolsSnapshot(wfDup); return snapDup.descs.length;", "同一节点重复出现只出一个描述子（byKey 去重）", (v) => v === 1);

  /* —— 入参对齐：Agent args → _agentCallArgs 注入端子（0=控制口不动）—— */
  exec(SB, `
__captured = null;
runToolNode = async (node, quiet, opts) => {
  __captured = (node._agentCallArgs || []).slice();
  node.output = null;
  node.portOutputs = {};
  for (let j = 0; j < 4; j++) {
    const v = node._agentCallArgs[j + 1];
    if (v) node.portOutputs['$' + j] = { kind: v.kind, text: 'OUT' + j + ':' + (v.text != null ? v.text : (v.path || '')) };
  }
  node.portOutputs.__error = '';
  node.ranAt = Date.now();
  return null;
};
`);
  const dCanvas = {
    key: "cn:cn1",
    toolName: "mtnode_tool_x",
    name: "查库存",
    description: "查仓库数量",
    inputs: [{ name: "仓库", kind: "text" }, { name: "图片", kind: "image" }],
    outputs: [{ name: "数量", kind: "text" }],
    origin: "canvas",
    nodeId: "cn1",
  };
  await A("window.api = { toolsList: async () => ({ ok: true, tools: [] }) }; r1 = await executeAgentToolCall(" + JSON.stringify(dCanvas) + ", { 仓库: '华东仓', 图片: 'C:/ref.png', 多余: '忽略' }, wfA); return r1.ok;", "画布工具节点被调用 → 执行成功回执 ok", (v) => v === true);
  await A("return JSON.stringify(__captured);", "Agent 入参按端子序号注入 _agentCallArgs（值形状按端子声明 kind 归一）", (v) => JSON.stringify(JSON.parse(v)) === JSON.stringify([null, { kind: "text", text: "华东仓" }, { kind: "image", path: "C:/ref.png", text: "C:/ref.png" }]));
  await A("return r1.outputs[0].name + ':' + r1.outputs[0].value.text;", "输出端子按出参名收集回执", (v) => v === "数量:OUT0:华东仓");
  await A("return r1.text;", "单文本输出同时给 text 快捷字段", (v) => v === "OUT0:华东仓");
  const dCanvasFallback = { key: "cn:cn9", toolName: "mtnode_tool_f", name: "兜底参", inputs: [{ name: "任意名", kind: "text" }], outputs: [{ name: "r", kind: "text" }], origin: "canvas", nodeId: "cn9" };
  exec(SB, 'toolN9 = { id: "cn9", kind: "tool", title: "工具F", toolConfig: { name: "兜底参", inputs: [{ name: "任意名", kind: "text" }], outputs: [{ name: "r", kind: "text" }] } }; wfA.nodes.push(toolN9);');
  await A("window.api = { toolsList: async () => ({ ok: true, tools: [] }) }; r2 = await executeAgentToolCall(" + JSON.stringify(dCanvasFallback) + ", { arg1: '甲' }, wfA); return r2.text;", "参数名缺省时回落 arg<N> 命名入参", (v) => v === "OUT0:甲");
  exec(SB, "wfA.nodes = wfA.nodes.filter(function (n) { return n.id !== 'cn9'; });");
  const rErr = await vm.runInContext('(async () => { try { await executeAgentToolCall(' + JSON.stringify(dCanvasFallback) + ", { arg1: '甲' }, wfA); return 'NO-ERR'; } catch (e) { return String(e.message || e); } })()", SB);
  ok(String(rErr).indexOf("不在当前画布") >= 0, "画布工具被删除后调用 → 抛「不在当前画布」错误文本");

  /* —— tool-run 帧处理：执行并回执（成功 / 失败 / 未知 key / 无 id） —— */
  exec(SB, "window.api = { toolsList: async () => ({ ok: true, tools: [libAlways] }), dshInteract: async (p) => { window.__answers.push(p); return { ok: true }; } }; window.__answers = [];");
  await A("snapRun = await agentUserToolsSnapshot(wfA); return handleToolRunEvent({ id: 'f1', tool: { key: 'cn:cn1', name: '查库存' }, args: { 仓库: '华东仓' } }, { runKey: 'rk', wf: wfA, toolDescs: snapRun.byKey }); return 'done';", "tool-run 帧（mock 网关下发）执行完成", (v) => true);
  await A("return window.__answers.length;", "执行后经 dshInteract 回执一次", (v) => v === 1);
  await A("return window.__answers[0].kind + '|' + window.__answers[0].id + '|' + window.__answers[0].result.ok + '|' + window.__answers[0].result.text;", "回执帧 = { kind:'tool', id, result:{ok,text} }", (v) => v === "tool|f1|true|OUT0:华东仓");
  exec(SB, "window.__answers = [];");
  await A("return handleToolRunEvent({ id: 'f2', tool: { key: 'no-such-key', name: '幽灵工具' }, args: {} }, { runKey: 'rk', wf: wfA, toolDescs: snapRun.byKey }); return 'x';", "未知 key 帧处理完成", (v) => true);
  await A("return window.__answers.length + '|' + String(window.__answers[0].result == null) + '|' + String(window.__answers[0].error);", "未知 key → 错误文本回执（会话不中断）", (v) => v === "1|true|工具「幽灵工具」不可用（不在本次运行的可用清单中）");
  exec(SB, "window.__answers = [];");
  await A("return handleToolRunEvent({ tool: { key: 'cn:cn1' }, args: {} }, { runKey: 'rk', wf: wfA, toolDescs: snapRun.byKey }); return 'x';", "无 id 帧不处理", (v) => true);
  await A("return window.__answers.length;", "无 id → 不回执（静默丢弃）", (v) => v === 0);
  exec(SB, "window.__answers = [];");
  await A("return handleToolRunEvent({ id: 'f3', tool: { key: 'cn:cn1' }, args: { 仓库: 'x' } }, { runKey: 'rk', wf: { id: 'w-empty', nodes: [], wires: [] }, toolDescs: snapRun.byKey }); return 'x';", "画布无该节点帧处理完成", (v) => true);
  await A("return window.__answers[0].result == null && String(window.__answers[0].error).indexOf('不在当前画布') >= 0;", "执行失败 → 错误文本回执（不中断会话）", (v) => v === true);

  /* —— 库 always 工具：画布无同源副本 → 临时物化失败也回执错误（不炸） —— */
  const libDesc = { key: "lib:tid1", toolName: "mtnode_tool_lib", name: "计算器", inputs: [{ name: "a", kind: "text" }], outputs: [{ name: "r", kind: "text" }], origin: "lib", libId: "tid1" };
  exec(SB, "window.api.toolsGet = async () => ({ ok: true, tool: { id: 'tid1', name: '计算器', graph: { rootId: 'r', nodes: [], wires: [] } } }); window.__answers = [];");
  await A("return handleToolRunEvent({ id: 'f4', tool: { key: 'lib:tid1', name: '计算器' }, args: { a: '1' } }, { runKey: 'rk', wf: { id: 'w3', nodes: [], wires: [] }, toolDescs: { 'lib:tid1': " + JSON.stringify(libDesc) + " } }); return 'x';", "库 always 无画布副本帧处理完成", (v) => true);
  await A("return window.__answers[0].result == null && String(window.__answers[0].error).indexOf('工具包不可用') >= 0;", "库包损坏/为空 → 错误文本回执（会话不中断）", (v) => v === true);

  /* —— 网关侧：normRunTools 收口 → env.MTNODE_TOOLS_JSON（指纹分池基础） —— */
  const GW = read("dsh/gateway/gateway.mjs");
  const SRC_NORM = between(GW, "const MAX_RUN_TOOLS = 24", "function stripYamlSection(text, key) {", "gateway.mjs normRunTools");
  const GW_CTX = vm.createContext({ console });
  vm.runInContext(SRC_NORM, GW_CTX);
  const normRunTools = GW_CTX.normRunTools;
  const gd = { key: "cn:n1", toolName: "mtnode_tool_calc_a1b2c", name: "查库存", description: "查仓库数量", inputs: [{ name: "仓库", kind: "text" }, { name: "图", kind: "image" }, { name: "坏", kind: "audio" }], outputs: [{ name: "数量", kind: "text" }] };
  let nr = normRunTools([gd]);
  ok(Array.isArray(nr) && nr.length === 1 && nr[0].key === "cn:n1" && nr[0].inputs.length === 3 && nr[0].inputs[0].kind === "text" && nr[0].inputs[1].kind === "image" && nr[0].inputs[2].kind === "text", "网关收口：合法描述子原样保留（kind 白名单 text/image）");
  ok(nr[0].name === "查库存" && nr[0].toolName === "mtnode_tool_calc_a1b2c", "网关收口：name/toolName 保留");
  const bads = [gd, { key: "cn:n1", toolName: "dup", name: "x" }, { key: "", toolName: "x1", name: "x" }, { key: "k2", toolName: "bad name!", name: "x" }, { key: "k3", toolName: "mtnode_tool_ok", name: "x" }, { key: "k4", toolName: "mtnode_tool_ok", name: "x" }];
  nr = normRunTools(bads);
  ok(nr.length === 2 && nr[0].key === "cn:n1" && nr[1].key === "k3", "网关收口：重复 key / 空 key / 非法 toolName / 重复 toolName 都剔除");
  const many = Array.from({ length: 30 }, (_, i) => ({ key: "cn:m" + i, toolName: "mtnode_tool_m" + i, name: "n" + i, inputs: [], outputs: [] }));
  ok(normRunTools(many).length === 24, "网关收口：工具上限 24（env 块总量约束）");
  const longName = JSON.parse(JSON.stringify(gd));
  longName.name = "长".repeat(80);
  longName.description = "d".repeat(999);
  nr = normRunTools([longName]);
  ok(nr[0].name.length === 60 && nr[0].description.length === 300, "网关收口：name 裁 60 / description 裁 300");
  const j1 = JSON.stringify(normRunTools([gd]));
  const j2 = JSON.stringify(normRunTools([gd]));
  const gd2 = JSON.parse(JSON.stringify(gd));
  gd2.inputs[0].name = "仓库改";
  const j3 = JSON.stringify(normRunTools([gd2]));
  ok(j1 === j2 && j1 !== j3, "归一 JSON 稳定（同集合同指纹）；参数变化 → JSON 变化 → 运行时按指纹分池冷起");
  ok(GW.indexOf("const tlHash = toolsJson\n    ? crypto.createHash('sha1').update(String(toolsJson)).digest('hex').slice(0, 12)") >= 0, "gateway.mjs：工具集 JSON sha1 指纹进 runtime key（工具变化冷起自己的运行时）");
  ok(GW.indexOf("env.MTNODE_TOOLS_JSON = toolsJson") >= 0 && GW.indexOf("delete env.MTNODE_TOOLS_JSON") >= 0, "gateway.mjs：toolsJson → 运行时 env.MTNODE_TOOLS_JSON（空则清除）");
  ok(GW.indexOf("const runTools = pureFlag ? [] : normRunTools(tools)") >= 0, "gateway.mjs：handleRun 先 normRunTools 再下发（pure 会话裁空）");
  ok(GW.indexOf("type: m.t === 'tool' ? 'tool-run' : m.t") >= 0 && GW.indexOf("data.tool = m.tool && typeof m.tool === 'object' ? m.tool : {}") >= 0 && GW.indexOf("data.args = m.args && typeof m.args === 'object' ? m.args : {}") >= 0, "gateway.mjs：运行时 t:'tool' 帧 → 宿主 tool-run 事件（tool=描述子定位 + args=模型入参）");
  const PLUG = read("dsh/gateway/tools-plugin.mjs");
  ok(PLUG.indexOf("process.env.MTNODE_TOOLS_JSON") >= 0 && PLUG.indexOf("JSON.parse(raw)") >= 0, "tools-plugin.mjs：spawn 时读 env.MTNODE_TOOLS_JSON 注册函数调用工具");
  ok(/\/\^\[A-Za-z0-9_\]\[A-Za-z0-9_\.-\]\{0,63\}\$\/\.test\(x\.toolName\)/.test(PLUG), "tools-plugin.mjs：只收合法 ASCII toolName 描述子");
  ok(PLUG.indexOf("t: 'tool'") >= 0 && PLUG.indexOf("'tool-result'") >= 0 && PLUG.indexOf("sessionId") >= 0, "tools-plugin.mjs：桥帧协议 t:'tool' → tool-result 回执（带 sessionId 归属）");

  /* ═══════════ [4b] 会话 UI 不再显示「当前画布 / 工具库可调用工具」清单 ═══════════
   * 展示整条链（chip + 助手行 + 防抖快照缓存 + 变化通知）已拆除；
   * 但下发链一字未动：每轮 run 仍现收集描述子交给网关，模型照常 func call。 */
  console.log("\n[4b] 会话不再显示可调用工具清单（下发链保持）");
  {
    const HTMLC = read("renderer/index.html");
    const ASSIST = read("renderer/app-assist.js");
    const BOOT = read("renderer/app-boot.js");
    const DB = read("renderer/app-db.js");
    const NODES = read("renderer/app-nodes.js");
    ["agentUserToolsTrigger", "agentUserToolsMenu", "assistUserToolsLine", "assistUserToolsVal"].forEach(
      (dead) => ok(HTMLC.indexOf(dead) < 0, "index.html 无清单 DOM 残留：" + dead),
    );
    [
      "refreshUserToolsUi",
      "paintAgentUserToolsChip",
      "buildAgentUserToolsMenu",
      "syncAssistUserTools",
      "currentUserToolsUi",
      "_userToolsUi",
    ].forEach((dead) => ok(ASSIST.indexOf(dead) < 0, "app-assist.js 展示代码已撤：" + dead));
    ok(
      BOOT.indexOf("agentUserToolsTrigger") < 0 && BOOT.indexOf("buildAgentUserToolsMenu") < 0,
      "app-boot.js 不再接线该 chip",
    );
    ok(
      TOOLS.indexOf("notifyUserToolsChanged") < 0 && NODES.indexOf("notifyUserToolsChanged") < 0,
      "画布 / 工具库变化不再通知可见列表（通知链整条拆除，不留空转调用）",
    );
    ok(
      DB.indexOf("await agentUserToolsSnapshot(boundWf)") >= 0,
      "app-db.js：每轮 run 仍现收集快照（单一真源不变 · 按本轮绑定画布 = 会话所属画布）",
    );
    ok(
      /tools:\s*agentTools\.descs/.test(DB),
      "app-db.js：runParams.tools 仍下发描述子给网关（模型照常 func call）",
    );
    ok(
      DB.indexOf("S._runToolDescs[runKey] = agentTools.byKey") >= 0,
      "app-db.js：本轮工具定位表仍在（tool-run 帧按 key 找回执行目标）",
    );
    const I18N2 = read("renderer/i18n.js");
    [
      "可调用工具（工具节点）",
      "本画布 / 工具库中 Agent 可直接调用的工具",
      "工具库 · 随时可调用",
    ].forEach((dead) =>
      ok(I18N2.indexOf(dead) < 0, "i18n 死词条已清：" + dead.slice(0, 14) + "…"),
    );
  }

  /* ═══════════ [5] 工具节点两项修复回归：双击进子画布 + 内侧端子不重合 ═══════════
   * bug① 收起态工具卡＝叶子外观，双击必须能进入内部画布（body.ondblclick → enterSuper）；
   * bug② 展开壳 / 全屏进入态的内侧端子（参数即端子 · 输入 0=控制固定）Y 排布不得重合。 */
  console.log("\n[5] 工具节点：双击进子画布 + 内侧端子不重合（回归）");
  {
    const CANVAS = read("renderer/app-canvas.js");
    const FN_BODY = between(
      CANVAS,
      "function buildFnToolBodyMain(node, body, isTool) {",
      "function buildBody(node, body) {",
      "app-canvas.js buildFnToolBodyMain",
    );
    ok(
      FN_BODY.indexOf("body.ondblclick = (ev) => {") >= 0,
      "收起态工具卡板身挂 dblclick（双击可进入内部画布）",
    );
    ok(
      /t\.closest\(\s*"button, input, textarea, select, a, \.port, \.fn-tool-settings"/.test(
        FN_BODY,
      ),
      "双击进入排除交互控件（按钮 / 输入 / 端子 / 设置面板内不触发）",
    );
    ok(
      FN_BODY.indexOf("enterSuper(node)") >= 0 &&
        FN_BODY.indexOf("ev.stopPropagation()") >= 0,
      "双击命中 → enterSuper 进入子画布并吞掉冒泡",
    );
    ok(
      FN_BODY.indexOf('I18n.t("双击进入子画布")') >= 0,
      "收起态工具卡带「双击进入子画布」提示（与折叠卡同口径）",
    );
    /* ── 设置面板 → 跳窗（本轮迁移的接线点口径）──
     * 面板本体（buildFnToolSettings）只允许被 NODE_SETTINGS_FORMS 的表单挂进跳窗：
     * 节点 body（收起卡片 / 展开态工具壳）里一律不再出现它，卡片只留只读摘要行。 */
    const cntAt = (s, sub) => s.split(sub).length - 1;
    ok(
      FN_BODY.indexOf("buildFnToolSettings") < 0,
      "函数 / 工具卡片 body 不再内联挂载设置面板",
    );
    ok(
      CANVAS.indexOf("buildFnToolSettings(node, true)") < 0,
      "展开态工具壳下方不再挂设置面板（舞台不再被挤动）",
    );
    ok(
      CANVAS.indexOf("S.uiOpenNode =") < 0 &&
        CANVAS.indexOf("S.uiOpenNode ===") < 0,
      "app-canvas.js 已无 S.uiOpenNode 读写（内联折叠机制对这两类节点彻底退场）",
    );
    ok(
      cntAt(FN_BODY, 'fnToolIoSummaryLine(node, "in")') === 2 &&
        cntAt(FN_BODY, 'fnToolIoSummaryLine(node, "out")') === 2,
      "两类节点 body 各留「入参 / 出参」只读摘要（工具与函数同一份 helper）",
    );
    {
      const REG = between(
        CANVAS,
        "/* ═══════════════ 已迁移的表单 · 函数 / 工具节点（参数即端子）",
        "function nodeElement(node) {",
        "app-canvas.js 函数 / 工具设置表单登记段",
      );
      ok(
        REG.indexOf('registerNodeSettingsForm("function"') >= 0 &&
          REG.indexOf('registerNodeSettingsForm("tool"') >= 0,
        "函数 / 工具各登记一张跳窗表单（键与 nodeSettingsFormKey 口径一致）",
      );
      ok(
        cntAt(REG, "build: nsFnToolBuild") === 2 &&
          REG.indexOf("buildFnToolSettings(ctx.node, isToolNode(ctx.node))") >= 0,
        "两张表单共用同一份面板 DOM（原样复用 · 不自建第二套参数编辑器）",
      );
      ok(
        cntAt(REG, "signature: nsFnToolSignature") === 2 &&
          REG.indexOf("function nsFnToolSignature(node) {") >= 0,
        "参数表进表单形状签名：增删 / 重排 / 改类型后跳窗跟着重建",
      );
      ok(
        cntAt(REG, "headerEntry: false") === 2,
        "两类节点保留头部原位「设置」按钮（统一 ⚙ 让位，不出现两个入口）",
      );
      ok(
        CANVAS.indexOf("if (sDef && sDef.headerEntry !== false)") >= 0,
        "统一 ⚙ 入口认 def.headerEntry：已就地挂入口的 kind 不再重复",
      );
      ok(
        CANVAS.indexOf("() => openNodeSettingsDialog(node)") >= 0,
        "右键菜单「设置（参数 / 名称 / 描述）」直接开窗",
      );
    }
    ok(
      APP.indexOf("function enterSuper(node, opts) {") >= 0 &&
        APP.indexOf('if (!node || node.kind !== "super") return;') >= 0 &&
        APP.indexOf("setSuperFocus(node.id") >= 0,
      "enterSuper 守住 super 形态（工具节点规范形态 kind=super 放行）并进入",
    );
    /* 内侧端子排布：portBandY + superInnerPortY 真实执行 —— 任意两端子 Y 不重合且递增 */
    const PORT_BAND = between(
      APP,
      "function portBandY(totalH, i, count, opts) {",
      "function inPortY(node, i, ic) {",
      "app.js portBandY",
    );
    const INNER_Y = between(
      APP,
      "function superInnerPortY(stageH, i, count) {",
      "/** 全屏进入态：内侧端子钉在",
      "app.js superInnerPortY",
    );
    ok(
      INNER_Y.indexOf("top: 24") >= 0 &&
        INNER_Y.indexOf("step: 22") >= 0 &&
        INNER_Y.indexOf("min: 24") >= 0,
      "superInnerPortY 起点由 top 给定 + 22px 呼吸间距（旧 top:0/min:24 压点口径已废）",
    );
    const SB5 = vm.createContext({ console, I18n: I18N_STUB });
    vm.runInContext("var PORT_STEP = 22;\n" + PORT_BAND + "\n" + INNER_Y, SB5);
    let collided = false;
    for (const h of [120, 200, 400, 800]) {
      for (const count of [1, 2, 3, 5, 8]) {
        const ys = [];
        for (let i = 0; i < count; i++) ys.push(vm.runInContext("superInnerPortY(" + h + ", " + i + ", " + count + ")", SB5));
        for (let j = 1; j < ys.length; j++) {
          if (!(ys[j] > ys[j - 1])) collided = true;
        }
      }
    }
    ok(!collided, "superInnerPortY：多组合（高 120–800 × 端子 1–8）内侧端子 Y 严格递增、互不重合");
    ok(
      APP.indexOf("function superBridgeLocalY(host, i) {") >= 0 &&
        APP.indexOf("function superSinkLocalY(host, i) {") >= 0 &&
        APP.indexOf("superInnerPortY(") >= 0,
      "连线锚点 superBridgeLocalY / superSinkLocalY 与端子渲染共用同一 superInnerPortY（线点不漂移）",
    );
  }

  /* ═══════════ [6] 端口类型链路：端子类型判定逐条钉住（回归） ═══════════
   * 钉住五件事，任何一处口径漂移都必须红：
   *   ① 出参 kind 归一（渲染层 normFnToolEntry / 主进程 normParams 白名单 text|image）+ 设置面板可写回；
   *   ② fnToolPortKind / wireSourceMediaType：工具 / 函数节点「声明优先于实际值」，
   *      控制端子与无声明端子回落「按节点 kind + 该端子实际值」的旧口径；
   *   ③ saveMediaKind 对图像出参 → image（扩展名 .png）、对文本出参 → text（.yaml）；
   *   ④ connectError 的图像 / 文本放行与拒绝文案逐字 + 工具 / 函数入参端子类型不匹配的点名文案；
   *   ⑤ 旧画布（出参无 kind）判定结果与改前一致（整节点仍按文本来源）。
   * 被测函数全部取真实源码切片；只桩外围（wf 容器、端子实际值探针、环检测、超级壳层统计）。 */
  console.log("\n[6] 端口类型链路：端子类型判定逐条钉住（出参 kind / 声明优先 / 保存选型 / 连线文案 / 旧画布）");
  {
    /* —— 真实源码切片 —— */
    const SRC_SAVEFN = between(APP, "function isSaveKind(kind) {", "const BOUND_SAVE_GAP", "app.js isSaveKind / isSaveNode");
    const SRC_EXT = between(APP, "const SAVE_EXT = {", "function stemOfFilename(name) {", "app.js SAVE_EXT / saveExtForMedia / forcePathExt");
    const SRC_MEDIA = between(APP, "function inferMediaFromSource(from, fromIndex) {", "function mediaGenOutputRaw(node) {", "app.js inferMediaFromSource / wireSourceMediaType / saveMediaKind / applySavePathExt");
    /* 素材节点端子族：wireSourceMediaType / isImageWireFrom 第一件事就是问它，定义在本节
       各切片之前 —— 不带上就整段抛 isAssetNode is not defined。取真实源码，不写桩。 */
    const SRC_ASSET = between(APP, "const ASSET_ITEM_TYPES = { text: 1, image: 1, audio: 1, video: 1 };", "function assetItemTypeLabel(type) {", "app.js isAssetNode / assetItems / assetPortKind");
    const SRC_WIREHELP = between(APP, "function isControlKind(n) {", "/* ── 工具节点 / 函数节点：单一真源判定与参数模型", "app.js isControlKind / wireFromIsControl / wiresTo / allWiresTo / hasOutput / isTextSource / isImageSource");
    const SRC_EXTIN = between(APP, "function superExternalInWiresAll(superNode, wf) {", "function superExternalInWires(superNode, wf) {", "app.js superExternalInWiresAll");
    const SRC_CONNECT = between(NODES, "function wireActsAsImage(from, fi) {", "/* 视频 / 音乐节点：找下一个空闲数据槽", "app-nodes.js wireActsAs* / wireParamKind / fnToolInPort* / connectError");

    const PRELUDE6 = `
var U = 0;
function uid(p) { U++; return (p || 'n') + U; }
function snap(v) { return Math.round(Number(v || 0) / 24) * 24; }
function assignDefaultProvider() {}
function currentTaskFocus() { return ''; }
function currentSuperFocus() { return ''; }
function findOpenSuperAtWorld() { return null; }
function findSuperAtWorld() { return null; }
function superHostAtWorld() { return null; }
function runToolNode() {}
var NODE_FORM_OF_KIND = { tool: "super" };
var DEFAULT_IMAGE_SIZE = "2048x1360";
var AGENT_PRESETS = [], AGENT_PRESET_DEFAULT = "minimal";
function uniqueNodeTitle(desired) { return String(desired); }
function toast() {}
var S = { wf: null };
var window = {};
/* ── 以下为外围桩（画布容器 / 壳层统计 / 环检测），不是被测逻辑 ── */
function nodeById(id) { return S.wf ? (S.wf.nodes || []).find(function (n) { return n.id === id; }) : null; }
function nodeByIdIn(id, wf) { wf = wf || S.wf; return wf ? (wf.nodes || []).find(function (n) { return n.id === id; }) : null; }
function nodeParentSuperId(n) { return (n && n.parentSuperId) || ''; }
function isSuperIoNode(n) { return !!(n && n.kind === 'super_io'); }
function isExecEnd() { return false; }
function isExecStart() { return false; }
function superInPortIsControl() { return false; }
function superOutPortIsControl() { return false; }
function superIsOpenShell() { return false; }
function superDynamicPortCount(maxIdx) { return Math.max(1, Number(maxIdx || 0) + 1); }
function superInternalOutFeedsAll() { return []; }
function superInternalBridgeWiresAll() { return []; }
function isMediaGenNode(n) { return !!(n && (n.kind === 'music_gen' || n.kind === 'video_gen' || n.kind === 'remotion')); }
/* 视频后处理（video_upscale / video_interp）判定：本节夹具不涉及，按非后处理节点回落 */
function isVideoPostKind() { return false; }
function isRefableSource(n) { return isTextSource(n) || isImageSource(n); }
function wouldCycle() { return false; }
function nextFreeMediaDataSlot() { return null; }
function videoGenInputCount() { return 1; }
function videoGenSlotMeta() { return { kind: 'text' }; }
function clipStr(s, n) { return String(s).slice(0, n); }
function extOf(p) { var m = /\\.[A-Za-z0-9]+$/.exec(String(p || '')); return m ? m[0] : ''; }
function applySuperRelToPath(node, p) { return p; }
function preferRelativeSavePath(p) { return p; }
/* 端子实际值探针：valueForInput 的取数真身与本节判定无关，按 <节点id>:<端子号> 直接喂值 */
var PORT_VALUES = {};
function setPV(id, i, v) { PORT_VALUES[id + ':' + Number(i || 0)] = v; }
function clearPV() { for (var k in PORT_VALUES) delete PORT_VALUES[k]; }
function valueForInput(src, idx) { if (!src) return null; var v = PORT_VALUES[src.id + ':' + Number(idx || 0)]; return v === undefined ? null : v; }
function wfWith(nodes, wires) { S.wf = { id: 'w6', nodes: nodes, wires: wires || [] }; return true; }
`;
    const SB6 = vm.createContext({ console, I18n: I18N_STUB });
    vm.runInContext(PRELUDE6 + "\n" + ND_TEXT + "};\n", SB6);
    vm.runInContext(
      SRC_SAVEFN + "\n" + SRC_EXT + "\n" + SRC_ASSET + "\n" + SRC_MEDIA + "\n" + SRC_WIREHELP + "\n" + SRC_EXTIN +
      "\n" + FN_CORE + "\n" + SRC_OUT + "\n" + SRC_IN + "\n" + SRC_CONNECT,
      SB6,
    );
    const E6 = (code) => { try { vm.runInContext(code, SB6); return null; } catch (e) { return "ERR:" + String((e && e.message) || e); } };
    const S6 = (expr) => { try { return vm.runInContext("(" + expr + ")", SB6); } catch (e) { return "ERR:" + String((e && e.message) || e); } };
    const EQ = (expr, want, msg) => {
      const v = S6(expr);
      ok(v === want, msg + (v === want ? "" : "  [实际=" + JSON.stringify(v) + " 期望=" + JSON.stringify(want) + "]"));
    };
    const P6 = (expr, msg) => EQ(expr, true, msg);

    /* —— 画布夹具：规范形态工具节点（super + tool:true）+ 函数节点 + 旧形态出参无 kind —— */
    SB6.T1 = { id: "t1", kind: "super", tool: true, title: "工具T", toolConfig: { name: "工具T", description: "", inputs: [{ name: "仓库", kind: "text" }, { name: "图", kind: "image" }], outputs: [{ name: "结果", kind: "text" }, { name: "海报", kind: "image" }] } };
    SB6.F1 = { id: "f1", kind: "function", title: "函数F", fnName: "", jscode: "", inputs: [{ name: "a", kind: "image" }], outputs: [{ name: "r", kind: "text" }] };
    SB6.OLD = { id: "told", kind: "super", tool: true, title: "旧工具", toolConfig: { name: "旧工具", description: "", inputs: [{ name: "关键词" }], outputs: [{ name: "结果" }] } };
    SB6.IMG = { id: "img1", kind: "input_image", title: "图源" };
    SB6.PT = { id: "pt1", kind: "proc_text", title: "文源" };
    SB6.CTL = { id: "ctl1", kind: "control", title: "控制" };
    P6(`wfWith([T1, F1, OLD, IMG, PT, CTL], [])`, "夹具画布就绪");

    /* ── ① 出参 kind 归一（渲染层）── */
    E6(`GN = { kind: 'function', inputs: [{ name: 'p', kind: 'image' }], outputs: [{ name: 'r' }, { name: '坏', kind: 'audio' }, { kind: 'image' }, null] }; ensureFnToolNodeState(GN);`);
    EQ(`GN.outputs.map(function (e) { return e.kind; }).join(",")`, "text,text,image,text", "出参 kind 归一：缺 kind → text，白名单外（audio）→ text，image 保留");
    EQ(`GN.outputs.map(function (e) { return e.name; }).join("|")`, "r|坏|参数 3|参数 4", "出参缺名补「参数 N」（与入参同一规则）");
    E6(`var before6 = JSON.stringify(GN.outputs); ensureFnToolNodeState(GN);`);
    EQ(`JSON.stringify(GN.outputs) === before6`, true, "出参归一幂等（重复归一不再改写条目）");
    EQ(`fnToolPortKind(GN, "out", 2)`, "image", "归一后的图像出参即端子声明类型（fnToolPortKind 与参数表同源）");

    /* ── ② 设置面板可写回（app-canvas.js buildFnToolSettings 真实源码契约）── */
    const CANVAS6 = read("renderer/app-canvas.js");
    const SET = between(CANVAS6, "function buildFnToolSettings(node, isTool) {", "function buildFnToolBodyMain(node, body, isTool) {", "app-canvas.js buildFnToolSettings");
    ok(SET.indexOf('renderParams("in",') >= 0 && SET.indexOf('renderParams("out",') >= 0, "设置面板：输入 / 输出参数两套列表都渲染（出参同样可编辑）");
    ok(/outputParams?|输出参数（端子 0\.\.n-1 · 末位 = 控制出）/.test(SET) && SET.indexOf('输出参数（端子 0..n-1 · 末位 = 控制出）') >= 0, "设置面板出参小节标题钉住端子契约（0..n-1 数据 · 末位控制出）");
    ok(SET.indexOf('["text", I18n.t("文本")]') >= 0 && SET.indexOf('["image", I18n.t("图像")]') >= 0, "类型下拉值域只有 文本 / 图像（与 normFnToolEntry 白名单同一口径）");
    ok(SET.indexOf('ks.value = list[i].kind === "image" ? "image" : "text";') >= 0, "下拉回显以参数声明的 kind 为准（端子色点同一真源）");
    ok(SET.indexOf('list[i].kind = ks.value;') >= 0, "改类型写回参数条目本身（工具落 toolConfig.outputs / 函数落 outputs · 同一 fnToolParamList 引用）");
    ok(/const commit = \(changedPorts\) => \{\s*\n\s*clearDownstream\(node\.id\);/.test(SET), "改类型即清下游缓存（端子类型变了，旧值不再可信）");
    /* 真函数级：模拟面板写回图像出参 → 判定链立刻跟着变 */
    E6(`clearPV(); T1.toolConfig.outputs[0].kind = "image"; ensureFnToolNodeState(T1);`);
    EQ(`fnToolPortKind(T1, "out", 0)`, "image", "面板把出参改成图像 → 端子声明同步为 image（写回落在同一份参数表上）");
    EQ(`wireSourceMediaType(T1, 0)`, "image", "面板写回后该出参端子流向下游即图像来源");
    E6(`T1.toolConfig.outputs[0].kind = "text";`);

    /* ── ③ fnToolPortKind：端子口径（0=控制入 / 末位=控制出 / 越界 / 非这两类节点）── */
    EQ(`fnToolPortKind(T1, "out", 0)`, "text", "出参端子 0（结果 · 声明 text）");
    EQ(`fnToolPortKind(T1, "out", 1)`, "image", "出参端子 1（海报 · 声明 image）");
    EQ(`fnToolPortKind(T1, "out", 2)`, null, "输出末位 = 控制出 → 无端子级声明（null）");
    EQ(`fnToolPortKind(T1, "in", 0)`, null, "输入端子 0 = 控制入 → 无端子级声明（null）");
    EQ(`fnToolPortKind(T1, "in", 1)`, "text", "输入端子 1 = 第 1 个参数（仓库 · text）");
    EQ(`fnToolPortKind(T1, "in", 2)`, "image", "输入端子 2 = 第 2 个参数（图 · image）");
    EQ(`fnToolPortKind(T1, "in", 3)`, null, "入参越界 → null（交回既有规则）");
    EQ(`fnToolPortKind(T1, "out", 9)`, null, "出参越界 → null");
    EQ(`fnToolPortKind(IMG, "out", 0)`, null, "普通节点不参与端子声明（回落节点 kind 判定）");
    EQ(`fnToolPortKind({ kind: "super", title: "普通超级" }, "out", 0)`, null, "普通超级节点同样 null（不误吞声明层）");
    EQ(`fnToolPortKind(F1, "in", 1)`, "image", "函数节点与工具节点同一判定（a · image）");

    /* ── ④ 声明优先于实际值 ── */
    E6(`clearPV(); setPV("t1", 0, { kind: "image", path: "E:/a.png" });`);
    EQ(`wireSourceMediaType(T1, 0)`, "text", "声明 text + 实际值是图像 → 仍以声明为准（text）");
    EQ(`wireActsAsText(T1, 0) === true && wireActsAsImage(T1, 0) === false`, true, "冲突时下游按文本线看待这条线（不混接媒体）");
    E6(`setPV("t1", 1, { kind: "text", text: "E:/poster.png" });`);
    EQ(`wireSourceMediaType(T1, 1)`, "image", "声明 image + 实际值是路径文本 → 仍以声明为准（image）");
    EQ(`wireParamKind(T1, 1)`, "image", "参数端子取数口径同样认声明（图像线进图像端子）");
    E6(`setPV("t1", 2, { kind: "image", path: "E:/c.png" });`);
    EQ(`wireSourceMediaType(T1, 2)`, "image", "控制出（无声明）→ 回落该端子实际值推断（②旧口径）");
    E6(`setPV("t1", 2, { kind: "audio", path: "E:/s.wav" });`);
    EQ(`wireSourceMediaType(T1, 2)`, "audio", "无声明时音频实际值不被压成文本（媒体不被吞）");
    E6(`clearPV(); setPV("t1", 2, null);`);
    EQ(`wireSourceMediaType(T1, 2)`, "text", "无声明且无实际值 → text（旧口径兜底）");
    E6(`clearPV(); setPV("pt1", 0, { kind: "image", path: "E:/x.png" });`);
    EQ(`wireSourceMediaType(PT, 0)`, "image", "普通 proc_text 无端子声明：仍按 0 号端子实际值判定（行为逐字不变）");
    E6(`clearPV();`);
    EQ(`wireSourceMediaType(PT, 0)`, "text", "普通 proc_text 无值 → text");
    EQ(`wireSourceMediaType(IMG, 0)`, "image", "input_image 按节点 kind 判定为图像（无需实际值）");

    /* ── ⑤ saveMediaKind 选型 + 扩展名写回 ── */
    E6(`SVA = { id: 'sva', kind: 'save', title: '保存A', savePath: 'out/a.yaml' }; SVI = { id: 'svi', kind: 'save', title: '保存I', savePath: 'out/i.png' }; SVT = { id: 'svt', kind: 'save', title: '保存T', savePath: 'out/t.png' }; wfWith([T1, F1, OLD, IMG, PT, CTL, SVA, SVI, SVT], [{ from: 't1', to: 'sva', fromIndex: 1, toIndex: 0 }]);`);
    EQ(`saveMediaKind(SVA)`, "image", "图像出参端子 → 保存节点自动选型 image");
    EQ(`saveExtForMedia(saveMediaKind(SVA))`, ".png", "图像选型对应扩展名 .png");
    E6(`applySavePathExt(SVA);`);
    EQ(`SVA.savePath`, "out/a.png", "路径随端子类型改写为 .png");
    E6(`wfWith([T1, SVA, SVT], [{ from: 't1', to: 'svt', fromIndex: 0, toIndex: 0 }]); applySavePathExt(SVT);`);
    EQ(`saveMediaKind(SVT)`, "text", "文本出参端子 → 保存节点选型 text");
    EQ(`SVT.savePath`, "out/t.md", "文本选型把 .png 路径改写回 .md（默认文本保存 .md）");
    EQ(`saveMediaKind({ id: 'svx', kind: 'save', savePath: 'p/q.png' })`, "image", "无来源连线时按保存路径扩展名定型（.png → image）");
    EQ(`saveMediaKind({ id: 'svy', kind: 'save', savePath: 'p/q.yaml' })`, "text", "无来源连线 · .yaml → text");
    EQ(`saveMediaKind({ id: 'svz', kind: 'save_image' })`, "image", "旧图像保存节点仍按 image（未新增端子声明层时行为不变）");

    /* ── ⑥ connectError：图像 / 文本放行与拒绝文案逐字 ── */
    E6(`clearPV(); wfWith([T1, F1, OLD, IMG, PT, CTL, SVA, SVI, SVT], []);`);
    EQ(`connectError("t1", "svi", 0, 1)`, null, "图像出参端子 → 图像保存：放行");
    EQ(`connectError("t1", "svi", 0, 0)`, "该保存节点按图像保存，只接受图像端子：请改接图像来源，或把保存路径改成 .yaml 用文本保存", "文本出参端子 → 图像保存：拒绝（点名改哪儿）");
    EQ(`connectError("t1", "sva", 0, 1)`, null, "图像出参端子 → 未定型保存节点：放行（随后自动改 .png）");
    E6(`wfWith([T1, F1, OLD, IMG, PT, CTL, SVA, SVI, SVT], [{ from: 'pt1', to: 'sva', fromIndex: 0, toIndex: 0 }]);`);
    EQ(`connectError("t1", "sva", 0, 1)`, "该保存节点当前按文本保存，不能混接媒体", "已按文本保存（已挂文本线）再混图像端子：拒绝");
    E6(`wfWith([T1, F1, OLD, IMG, PT, CTL, SVA, SVI, SVT], [{ from: 't1', to: 'svi', fromIndex: 1, toIndex: 0 }]);`);
    EQ(`connectError("img1", "svi", 1, 0)`, "图像 / 音频 / 视频保存仅接受 1 个输入", "图像保存已有一个输入再接第二条：拒绝");
    E6(`wfWith([T1, F1, OLD, IMG, PT, CTL, SVA, SVI, SVT], []); setPV("pt1", 0, { kind: "image", path: "E:/x.png" });`);
    EQ(`connectError("pt1", "svi", 0, 0)`, "图像保存需要图像来源", "普通节点实际值是图像但 kind 不是图像类：仍按旧口径拒绝");
    E6(`clearPV();`);
    EQ(`connectError("t1", "pt1", 0, 1)`, null, "图像出参端子 → 普通文本节点：放行（端子判定不拦普通目标）");

    /* —— 工具 / 函数入参端子：控制归属 + 类型匹配 —— */
    E6(`T2 = { id: 't2', kind: 'super', tool: true, title: '工具U', toolConfig: { name: '工具U', description: '', inputs: [{ name: '数量', kind: 'text' }, { name: '图', kind: 'image' }], outputs: [{ name: 'r', kind: 'text' }] } }; wfWith([T1, F1, OLD, IMG, PT, CTL, T2], []);`);
    EQ(`connectError("ctl1", "t2", 0, 0)`, null, "控制线 → 工具端口 0（控制入）：放行");
    EQ(`connectError("pt1", "t2", 0, 0)`, "端口 0 是控制输入端子（不接受数据连线）", "数据线 → 工具端口 0：拒绝");
    EQ(`connectError("ctl1", "t2", 1, 0)`, "控制信号只能连到控制输入端子（端口 0）", "控制线 → 参数端子：拒绝");
    EQ(`connectError("t1", "t2", 1, 0)`, null, "文本线 → 文本参数端子：放行");
    EQ(`connectError("t1", "t2", 2, 1)`, null, "图像线 → 图像参数端子：放行");
    EQ(`connectError("t1", "t2", 1, 1)`, "「数量」是文本参数，不接受图像来源：请在该工具节点的「设置」里把「数量」改成图像参数，或改接来源节点的文本输出端子", "图像线 → 文本参数端子：拒绝文案逐字（点名参数 + 去处）");
    EQ(`connectError("t1", "t2", 2, 0)`, "「图」是图像参数，只接受图像来源：请把来源节点的图像输出端子连到它，或在该工具节点的「设置」里把「图」改成文本参数", "文本线 → 图像参数端子：拒绝文案逐字（点名参数 + 去处）");
    EQ(`fnToolInPortIndex(T2, T1, 1, null, false)`, 2, "未指定端子：图像线自动挑空闲图像参数端子（校验与落点同一真源）");
    EQ(`fnToolInPortIndex(T2, T1, 0, null, false)`, 1, "未指定端子：文本线自动挑空闲文本参数端子");
    E6(`wfWith([T1, F1, OLD, IMG, PT, CTL, T2], [{ from: 'img1', to: 't2', fromIndex: 0, toIndex: 2 }]);`);
    EQ(`connectError("t1", "t2", null, 1)`, "「数量」是文本参数，不接受图像来源：请在该工具节点的「设置」里把「数量」改成图像参数，或改接来源节点的文本输出端子", "同类型端子已占用：不静默塞进文本端子，改为点名报错");
    E6(`wfWith([T1, F1, OLD, IMG, PT, CTL, T2, { id: 'it2', kind: 'input_text', title: '文本入' }], [{ from: 'img1', to: 't2', fromIndex: 0, toIndex: 1 }, { from: 'pt1', to: 't2', fromIndex: 0, toIndex: 2 }]);`);
    EQ(`connectError("it2", "t2", null, 0)`, "没有空闲的输入参数端子", "参数端子全占：拒绝文案");
    /* 函数节点共用同一套入参校验，文案点名「该函数节点的「设置」」 */
    E6(`wfWith([T1, F1, OLD, IMG, PT, CTL, T2], []);`);
    EQ(`connectError("t1", "f1", 1, 0)`, "「a」是图像参数，只接受图像来源：请把来源节点的图像输出端子连到它，或在该函数节点的「设置」里把「a」改成文本参数", "函数节点入参类型不匹配：拒绝文案逐字（去处＝该函数节点的「设置」）");
    EQ(`connectError("t1", "f1", null, 1)`, null, "函数节点：图像线自动落到图像参数端子 → 放行");

    /* ── ⑦ 旧画布（出参无 kind）判定结果与改前一致 ── */
    E6(`clearPV(); setPV("told", 0, { kind: "image", path: "E:/x.png" }); wfWith([T1, F1, OLD, IMG, PT, CTL, SVA, SVI, SVT], []);`);
    EQ(`fnToolPortKind(OLD, "out", 0)`, "text", "旧画布出参条目无 kind → 按 text 判定（与改前整节点判文本一致）");
    EQ(`wireSourceMediaType(OLD, 0)`, "text", "旧画布出参无 kind：即使实际值是图像，仍判 text（不因归一顺带改写旧存档）");
    EQ(`wireActsAsText(OLD, 0) === true && isTextSource(OLD) === true`, true, "旧画布工具节点仍是文本来源（下游文本节点照旧可用）");
    EQ(`connectError("told", "svi", 0, 0)`, "该保存节点按图像保存，只接受图像端子：请改接图像来源，或把保存路径改成 .yaml 用文本保存", "旧画布接图像保存：拒绝文案与新节点逐字相同");
    E6(`SVT.savePath = 'out/t.png'; wfWith([OLD, SVT], [{ from: 'told', to: 'svt', fromIndex: 0, toIndex: 0 }]); applySavePathExt(SVT);`);
    EQ(`saveMediaKind(SVT)`, "text", "旧画布文本出参 → 保存选型 text（与改前一致）");
    EQ(`SVT.savePath`, "out/t.md", "旧画布判定落盘扩展名 .md（默认文本保存 .md）");
    E6(`clearPV(); ensureFnToolNodeState(OLD);`);
    EQ(`OLD.toolConfig.outputs[0].kind`, "text", "旧画布载入后结构归一把出参 kind 显式补成 text");
    EQ(`fnToolPortKind(OLD, "out", 0)`, "text", "归一前后判定结果不变（幂等，不改口径）");
    EQ(`fnToolPortKind(OLD, "out", 1)`, null, "旧画布同样守住末位控制出无声明");

    /* ── ⑧ 出参 kind 归一（主进程库侧 normParams · 与渲染层同一 text|image 白名单）──
       缺 kind 的条目同样钉死：与渲染层 normFnToolEntry 一致落 "text"
       （曾有缺陷：白名单判定用默认值、返回却取原值 → 落盘成字符串 "undefined"，已修）。 */
    const LIB6 = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-tools6-"));
    registerToolsIpc({ getDataDir: () => LIB6 });
    r = await call("tools:save", {
      name: "出参归一",
      description: "",
      inputs: [{ name: "a", kind: "text" }],
      outputs: [{ name: "图", kind: "image" }, { name: "坏", kind: "audio" }, { name: "", kind: "text" }, { name: "缺" }],
      graph: { rootId: "r", nodes: [{ id: "r", kind: "super", tool: true, title: "出参归一" }], wires: [] },
    });
    ok(r.ok === true, "库侧保存含出参的工具包成功");
    list = await call("tools:list");
    ok(userTools(list)[0].outputs.map((e) => e.kind).join(",") === "image,text,text,text", "库侧出参 kind 归一：白名单 text|image（audio 落回 text），image 保留");
    ok(userTools(list)[0].outputs[2].name === "参数 3", "库侧出参缺名同样补「参数 3」");
    ok(userTools(list)[0].outputs[3].kind === "text", "库侧出参缺 kind → text（不是字符串 \"undefined\"）");
    fs.rmSync(LIB6, { recursive: true, force: true });

    /* ── ⑨ 参数重排（▲▼ / 拖动 insert）：改参数顺序 = 改端子顺序，
       fnToolMoveParam 移动参数位并让已连数据线跟着端子走（不漂到别的参数）── */
    E6(`TO = { id: 'to', kind: 'super', tool: true, title: '工具O', toolConfig: { name: '工具O', description: '', inputs: [{ name: 'a', kind: 'text' }, { name: 'b', kind: 'text' }], outputs: [{ name: 'x', kind: 'text' }, { name: 'y', kind: 'text' }] } }; wfWith([TO, { id: 'src', kind: 'input_text', title: '源' }, SVT], [{ from: 'src', to: 'to', fromIndex: 0, toIndex: 1 }, { from: 'to', to: 'svt', fromIndex: 1, toIndex: 0 }]);`);
    EQ(`fnToolParamList(TO, "in").map((p) => p.name).join(",")`, "a,b", "重排前输入参数顺序 a,b");
    EQ(`S.wf.wires.find((w) => w.to === 'to').toIndex`, 1, "重排前源线挂在端子 1（参数 a）");
    E6(`fnToolMoveParam(TO, "in", 0, 1);`);
    EQ(`fnToolParamList(TO, "in").map((p) => p.name).join(",")`, "b,a", "输入参数 0 下移一位 → 参数表顺序 b,a");
    EQ(`S.wf.wires.find((w) => w.to === 'to').toIndex`, 2, "源线仍指向参数 a（端子号随参数移到 2）");
    EQ(`fnToolParamList(TO, "out").map((p) => p.name).join(",")`, "x,y", "重排前输出参数顺序 x,y");
    EQ(`S.wf.wires.find((w) => w.from === 'to').fromIndex`, 1, "重排前出线挂在端子 1（参数 y）");
    E6(`fnToolMoveParam(TO, "out", 0, 1);`);
    EQ(`fnToolParamList(TO, "out").map((p) => p.name).join(",")`, "y,x", "输出参数 0 下移一位 → 参数表顺序 y,x");
    EQ(`S.wf.wires.find((w) => w.from === 'to').fromIndex`, 0, "出线仍指向参数 y（端子号随参数移到 0）");
    EQ(`fnToolMoveParam(TO, "in", 0, 0)`, null, "原地不动 → 不改表不改线（返回 null）");
    EQ(`fnToolMoveParam(TO, "in", 0, 99)`, null, "越界目标 → 拒绝（不把 99 钳到末尾造成意外移位）");

    /* 工具壳（super + tool:true）内侧桥接 / 汇流线也按同一端子口径随参数移位：
       子节点输出 → 宿主输出端子（内侧汇流，to = 宿主 · toIndex = 输出端子号）也要 remap */
    E6(`wfWith([TO, { id: 'kid', kind: 'proc_text', title: '内部子', parentSuperId: 'to' }, SVT], [{ from: 'kid', to: 'to', fromIndex: 0, toIndex: 1 }, { from: 'to', to: 'svt', fromIndex: 1, toIndex: 0 }]);`);
    EQ(`S.wf.wires.find((w) => w.from === 'kid').toIndex`, 1, "壳内子节点 → 宿主输出端子 1（参数 y）");
    E6(`fnToolMoveParam(TO, "out", 0, 1);`);
    EQ(`S.wf.wires.find((w) => w.from === 'kid').toIndex`, 0, "内侧汇流线的 toIndex 随参数 y 移到 0（壳内接线不丢）");
    E6(`wfWith([], []);`);

    /* ── ⑩ 工具节点「开发」= 绑定该工具的会话（toolDev* · 与函数同一机制镜像）── */
    [
      "function toolDevNameOf(node) {",
      "function toolDevSessionsOf(node) {",
      "function toolDevLastRequestOf(node) {",
      "function toolDevInnerGraphInfo(node) {",
      "function toolDevContractText(node, req) {",
      "function createToolDevSessionForNode(node, req) {",
      "async function developToolNode(node) {",
    ].forEach((sig) =>
      ok(TOOLS.indexOf(sig) >= 0, "app-tools.js 存在 " + sig.replace(/ ?\(.*$/, "")),
    );
    const TOOLDEV = TOOLS.slice(TOOLS.indexOf("function toolDevNameOf(node) {"));
    ok(TOOLDEV.indexOf("node.toolDevSessionIds.unshift(sess.id);") >= 0, "工具开发会话 id 追加到 node.toolDevSessionIds（与 fnDevSessionIds / devSessionIds 三套互不串）");
    ok(TOOLDEV.indexOf("while (node.toolDevSessionIds.length > 24)") >= 0, "工具绑定会话同样上限 24 条");
    ok(TOOLDEV.indexOf("fnDevSessionIds") < 0 || TOOLDEV.indexOf("fnDevSessionIds") > TOOLDEV.indexOf("toolDevSessionIds"), "工具开发不写函数字段（字段各自独立）");
    ok(TOOLDEV.indexOf("parentSuperId = 本工具 id") >= 0, "工具开发契约允许会话在本工具内部建子节点（parentSuperId = 本工具 id）");
    ok(TOOLDEV.indexOf("不得新建、删除或改动任何其它画布节点") >= 0, "契约边界：不改画布上其它节点");
    ok(TOOLDEV.indexOf("复核该节点的连线") >= 0, "契约边界：动参数表必须提醒复核连线（参数即端子）");
  }

  /* ═══════════ [7] 入口分工：顶栏「工具库」＋右键「工具」一级菜单 ═══════════
   * 需求：顶栏那一格叫「工具库」、用普通工具箱线性图标（不再是程序自己的位图图标），
   * 打开后只有已保存的工具 / 函数包；工具节点与函数节点的创建回到画布右键菜单，收在名为「工具」的一级菜单下。 */
  console.log("\n[7] 顶栏＝工具库（工具箱线性图标 · 只有已保存的包）· 建节点＝右键「工具」一级菜单");
  {
    const HTML = read("renderer/index.html");
    const BOOT = read("renderer/app-boot.js");
    const I18N3 = read("renderer/i18n.js");
    const CSS7 = read("renderer/css/layout.css");
    const BTN = between(HTML, '<button type="button" id="btnTools"', "</button>", "index.html #btnTools");
    ok(
      BTN.indexOf('data-i18n="工具库"') >= 0 && BTN.indexOf('aria-label="工具库"') >= 0,
      "顶栏按钮文案＝工具库（不再是含糊的「工具」）",
    );
    ok(
      BTN.indexOf("<svg") >= 0 && BTN.indexOf("currentColor") >= 0 && BTN.indexOf("viewBox=\"0 0 16 16\"") >= 0,
      "顶栏工具库按钮＝普通工具箱线性 SVG（16 viewBox · 描边 currentColor，与相邻入口同风格）",
    );
    ok(
      BTN.indexOf("app-icon") < 0 && BTN.indexOf("<img") < 0,
      "不再用程序自己的位图图标（一格一个图标，不叠图）",
    );
    ok(
      !fs.existsSync(path.join(__dirname, "..", "renderer", "app-icon.png")),
      "renderer/app-icon.png 已删（唯一引用就是这一格，不给包留死资产；打包图标另有 build/icon.png）",
    );
    ok(
      HTML.indexOf("btn-app-ico") < 0 && CSS7.indexOf("btn-app-ico") < 0,
      "旧的 .btn-app-ico 位图样式随图标一起清掉（不留死规则）",
    );
    ok(
      CSS7.indexOf(".topbar .btn-tools {") >= 0 &&
        CSS7.indexOf("#c792ea") >= 0 &&
        CSS7.indexOf("#d0a6ff") >= 0,
      "layout.css 给「工具库」配专属紫（常态 #c792ea · hover / on 升 #d0a6ff，与绿橙青蓝不撞）",
    );
    ok(
      BOOT.indexOf('$("#btnTools").onclick = () => openToolsLibrary();') >= 0,
      "app-boot.js：点顶栏按钮＝直达工具库对话框（不再弹一级菜单）",
    );
    ok(
      [APP, TOOLS, BOOT, HTML].every((s) => s.indexOf("showToolsTopMenu") < 0) &&
        TOOLS.indexOf("toolsTopMenuGroups") < 0 &&
        TOOLS.indexOf("toolsSpawnPoint") < 0,
      "顶栏一级菜单整条拆除（不留死函数 / 死引用）",
    );
    ok(
      TOOLS.indexOf("function openToolsLibrary()") >= 0 &&
        TOOLS.indexOf("toolsCanvasSel") >= 0 &&
        TOOLS.indexOf("renderToolsLibList") >= 0,
      "工具库对话框仍在：顶部保存 + 已保存条目清单（打开后只有已保存的工具 / 函数包）",
    );
    /* 建节点入口：右键菜单里的「工具」一级子菜单（真实执行在 smoke-media-gen-menu [1b]） */
    const MENU_SRC = between(
      APP,
      "function canvasCreateMenuGroups(pt) {",
      "function ctxKindItem(kind, label, run, extra) {",
      "app.js canvasCreateMenuGroups（右键新建节点菜单）",
    );
    ok(
      MENU_SRC.indexOf('ctxSubmenu(\n                I18n.t("工具"),') >= 0 ||
        /ctxSubmenu\(\s*I18n\.t\("工具"\)/.test(MENU_SRC),
      "右键菜单里有「工具」一级子菜单（工具 / 函数节点的创建入口）",
    );
    ok(
      /allowToolMenu\s*=\s*!sfHost \|\| inFlowShell/.test(MENU_SRC) &&
        MENU_SRC.indexOf("...(allowToolMenu") >= 0,
      "顶层画布与流程壳都列「工具」（旧的就地分组已换成一级子菜单）",
    );
    ok(
      MENU_SRC.indexOf('I18n.t("工具节点（参数即端子 · Agent 可调用 / JS 计算）")') < 0,
      "旧的「工具节点…」分组标题不再出现（菜单只留一层「工具」）",
    );
    /* 双语文案：新顶栏提示有英文，旧的顶栏一级菜单词条清干净 */
    const TIP_KEY =
      "工具库：打开本机已保存的工具 / 函数，插入到任意画布复用（新建这两类节点：画布空白处右键 → 工具）";
    const PAIRS3 = Object.create(null);
    const RE_PAIR3 = /"((?:[^"\\]|\\.)+)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
    let mm3;
    while ((mm3 = RE_PAIR3.exec(I18N3))) if (!(mm3[1] in PAIRS3)) PAIRS3[mm3[1]] = mm3[2];
    const en3 = PAIRS3[TIP_KEY];
    ok(
      typeof en3 === "string" && en3.length > 0 && !/[一-鿿]/.test(en3),
      "新顶栏提示挂了英文译文（英文界面不回落中文）",
    );
    [
      "工具：新建工具 / 函数节点，管理跨画布工具库",
      "新建工具节点（Agent 可调用 · 参数即端子）",
      "新建函数节点（JS 计算 · 自定义入出参）",
      "工具库…（跨画布保存 / 插入 / 管理）",
    ].forEach((dead) =>
      ok(I18N3.indexOf(dead) < 0, "顶栏一级菜单的死词条已清：" + dead.slice(0, 14) + "…"),
    );
    ok(
      /"工具（Agent 可调用 · 入参出参端子）":\s*"Tool/.test(I18N3) &&
        /"函数（JS 计算 · 自定义入参出参）":\s*"Function/.test(I18N3),
      "「工具」一级菜单两位成员的英文词条齐备",
    );
    /* 指南与文档跟着入口走 */
    const GT = read("guides/nodes/tool.md");
    const GF = read("guides/nodes/function.md");
    const GTE = read("guides/nodes/en/tool.md");
    ok(
      GT.indexOf("右键 → **工具** → **工具（Agent 可调用 · 入参出参端子）**") >= 0 &&
        GF.indexOf("右键 → **工具** → **函数（JS 计算 · 自定义入参出参）**") >= 0,
      "中英指南：创建路径写成画布右键 → 工具 →（不再是「工具节点」分组）",
    );
    ok(
      GT.indexOf("按钮用的就是程序自己的图标") >= 0 &&
        GT.indexOf("已保存的工具 / 函数包") >= 0 &&
        GT.indexOf("应用内置条目") >= 0 &&
        GT.indexOf("内置") >= 0,
      "指南：顶栏「工具库」写明「已保存的包 + 应用内置条目」（并说明用的是程序图标）",
    );
    ok(
      GTE.indexOf("right-click empty canvas → **Tools**") >= 0 &&
        GTE.indexOf("saved tool / function packages") >= 0 &&
        GTE.indexOf("built-in entries") >= 0,
      "英文指南同步：创建入口 + 工具库口径（已保存条目 + 内置条目）",
    );
    const DOC_LIB = read("docs/tool-library.md");
    const DOC_TF = read("docs/tool-function-nodes.md");
    ok(
      DOC_LIB.indexOf("顶栏「工具库」按钮") >= 0 &&
        DOC_LIB.indexOf("本机已保存的工具 / 函数包与**应用内置条目**") >= 0 &&
        DOC_LIB.indexOf("## 4b. 应用内置条目") >= 0,
      "docs/tool-library.md：顶栏入口口径已改（已保存的包 + 应用内置条目）",
    );
    ok(
      DOC_TF.indexOf("「工具」一级菜单") >= 0 &&
        DOC_TF.indexOf("创建入口") >= 0,
      "docs/tool-function-nodes.md：真源清单登记右键「工具」一级菜单为创建入口",
    );
  }

  /* ═══════ [8] 「描述自足」：内置工具硬判据 + 三个消费方（schema / 预检回执 / 旧副本刷新）═══════
     口径（本轮需求）：任何工具调用都必须仅凭工具自己给出的信息就能调对 —— 用途、
     每个入参 / 出参的含义、哪些参数可选（含「至少给一个」的组）、限制与失败情形、
     一份最小调用示例。判据是「字段非空 + 示例是合法 JSON 且键=入参名」，
     随包内置工具不达标即冒烟失败；用户自建工具只在画布节点上提示（不阻断保存）。 */
  console.log("\n[8] 描述自足（内置工具硬判据 / 给模型的 schema / 预检与失败回执 / 旧副本刷新）");
  {
    const PRESET = JSON.parse(read("renderer/preset-tools.json"));
    const tools = (PRESET.tools || []).filter((t) => t && t.kind !== "function");
    ok(tools.length >= 2, "内置清单里有可被 Agent 调用的工具条目（kind = tool）");
    for (const t of tools) {
      const tag = "内置「" + t.name + "」：";
      const desc = String(t.description || "").trim();
      const ins = Array.isArray(t.inputs) ? t.inputs : [];
      const outs = Array.isArray(t.outputs) ? t.outputs : [];
      const names = ins.map((p) => String(p.name || ""));
      const groups = Array.isArray(t.atLeastOne) ? t.atLeastOne : [];
      ok(desc.length >= 40, tag + "用途（description）写清");
      ok(
        ins.length > 0 && ins.every((p) => String(p.description || "").trim()),
        tag + "每个入参都有说明",
      );
      ok(
        outs.length > 0 && outs.every((p) => String(p.description || "").trim()),
        tag + "每个出参都有说明",
      );
      ok(
        ins.some((p) => p.optional === true) || groups.length > 0,
        tag + "可选性写清（标了 optional 或给出「至少给一个」组）",
      );
      ok(
        ins.every((p) => p.optional === undefined || p.optional === true),
        tag + "可选位只在明确可选时为 true",
      );
      ok(String(t.limits || "").trim().length >= 20, tag + "限制与失败情形写清");
      let exObj = null;
      try {
        exObj = JSON.parse(String(t.example || "").trim());
      } catch (_) {}
      ok(
        !!exObj && typeof exObj === "object" && !Array.isArray(exObj),
        tag + "调用示例是合法 JSON 对象",
      );
      const badKeys = exObj ? Object.keys(exObj).filter((k) => names.indexOf(k) < 0) : ["<无示例>"];
      ok(badKeys.length === 0, tag + "调用示例的键都是入参名");
      ok(
        groups.every(
          (g) =>
            Array.isArray(g) &&
            g.length >= 2 &&
            g.every((nm) => names.indexOf(String(nm)) >= 0),
        ),
        tag + "「至少给一个」组只引用存在的入参名",
      );
      ok(
        !groups.length ||
          (exObj &&
            groups.every((g) =>
              g.some((nm) => {
                const v = exObj[nm];
                return v != null && String(v).trim() !== "";
              }),
            )),
        tag + "调用示例满足「至少给一个」组",
      );
      /* 图内根 toolConfig 必须与顶层同步：插入画布用的是图内那一份（副本从此自成一体） */
      const g = t.graph || {};
      const root = (Array.isArray(g.nodes) ? g.nodes : []).find(
        (n) => n && String(n.id || "") === String(g.rootId || ""),
      );
      const c = root && root.toolConfig ? root.toolConfig : null;
      ok(!!c && String(c.description || "") === desc, tag + "图内根 toolConfig 描述与顶层一致");
      ok(
        !!c &&
          String(c.limits || "") === String(t.limits || "") &&
          String(c.example || "") === String(t.example || ""),
        tag + "图内根 toolConfig 同步 limits / example",
      );
      ok(
        !!c && JSON.stringify(c.atLeastOne || []) === JSON.stringify(groups),
        tag + "图内根 toolConfig 同步 atLeastOne",
      );
      const cIns = c && Array.isArray(c.inputs) ? c.inputs : [];
      ok(
        cIns.length === ins.length &&
          cIns.every(
            (p, i) =>
              String(p.description || "") === String(ins[i].description || "") &&
              (p.optional === true) === (ins[i].optional === true),
          ),
        tag + "图内根 toolConfig 的参数说明 / 可选位与顶层一致",
      );
    }
    /* —— 消费方 ①：给模型的 schema（dsh/gateway/tools-plugin.mjs）—— */
    const PLUG = read("dsh/gateway/tools-plugin.mjs");
    ok(
      PLUG.indexOf("if (!(p && p.optional === true)) base.required = true") >= 0,
      "tools-plugin：可选参数不进 required，未标注 = 必填（老工具包口径不变）",
    );
    ok(
      PLUG.indexOf("p.description") >= 0 &&
        PLUG.indexOf("限制与失败情形：") >= 0 &&
        PLUG.indexOf("最小调用示例（args 一份完整 JSON）：") >= 0 &&
        PLUG.indexOf("以下参数至少给一个：") >= 0,
      "tools-plugin：参数说明 / 至少给一个 / 限制 / 示例都拼进给模型的工具描述",
    );
    /* —— 消费方 ②：描述子与 {{outDir}} 展开（app-tools.js · 真函数）—— */
    P(
      'toolParamEntry({ name: "p", kind: "text", description: "含义", optional: true }).optional === true && toolParamEntry({ name: "p", kind: "text" }).description === undefined',
      "描述子参数条目：带说明与可选位，未标注不出现 optional",
    );
    A(
      'return toolDescExpand({ description: "写到 {{outDir}} 下", inputs: [{ name: "p", kind: "text", description: "落在 {{outDir}}" }] }, { outDir: "C:/o" }).description',
      "{{outDir}} 展开成宿主给的真实目录（描述 / 参数说明同口径）",
      (v) => v === "写到 C:/o 下",
    );
    A(
      'return toolDescExpand({ description: "x {{outDir}} y" }, {}).description',
      "取不到输出目录时不编造路径（退回一句说明）",
      (v) => v === "x 本机用户数据目录 y",
    );
    /* —— 消费方 ③：执行前预检 + 失败回执用法摘要 —— */
    A(
      'const d = { name: "T", inputs: [{ name: "a", kind: "text", description: "A" }, { name: "b", kind: "text", description: "B", optional: true }], outputs: [{ name: "o", kind: "text" }], limits: "L", example: "{\\"a\\":\\"1\\"}", atLeastOne: [["a","b"]] }; return agentToolPrecheck(d, {})',
      "预检：缺必填参数当场判出（不跑内部图）",
      (v) => v === "缺少必填参数：a",
    );
    A(
      'const d = { name: "T", atLeastOne: [["a","b"]], inputs: [{ name: "a", kind: "text", description: "A", optional: true }, { name: "b", kind: "text", description: "B", optional: true }] }; return agentToolPrecheck(d, { a: "", b: "" })',
      "预检：二选一参数组整组为空也当场判出",
      (v) => v === "以下参数至少要给一个：a / b",
    );
    A(
      'const d = { name: "T", atLeastOne: [["a","b"]], inputs: [{ name: "a", kind: "text", optional: true }, { name: "b", kind: "text", optional: true }] }; return agentToolPrecheck(d, { b: "给了" })',
      "预检：二选一给了一个即放行",
      (v) => v === "",
    );
    A(
      'const d = { name: "Markdown 转 PDF", description: "用途一段", inputs: [{ name: "a", kind: "text", description: "含义 A" }], outputs: [{ name: "o", kind: "text" }], limits: "限制一段", example: "{\\"a\\":\\"1\\"}" }; return toolUsageSummary(d)',
      "失败回执摘要：用途 / 入参含义 / 返回 / 限制 / 最小示例齐备",
      (v) =>
        typeof v === "string" &&
        v.indexOf("工具「Markdown 转 PDF」的合法用法：") === 0 &&
        v.indexOf("· 用途：用途一段") > 0 &&
        v.indexOf("含义 A") > 0 &&
        v.indexOf("· 返回：o") > 0 &&
        v.indexOf("· 限制与失败情形：限制一段") > 0 &&
        v.indexOf("· 最小调用示例（args 一份完整 JSON）：") > 0,
    );
    ok(
      TOOLS.indexOf("await answer(undefined, msg + \"\\n\\n\" + toolUsageSummary(desc));") >= 0,
      "handleToolRunEvent：失败回执一律附用法摘要（每次失败都附）",
    );
    ok(
      TOOLS.indexOf("const pre = agentToolPrecheck(desc, args);") >= 0 &&
        TOOLS.indexOf("if (pre) throw new Error(pre);") >= 0,
      "runCanvasToolNodeForAgent：执行前先预检（不合格不跑内部图）",
    );
    /* —— 消费方 ④：旧副本按内置最新刷新（参数结构永不动）—— */
    A(
      'const node = { id: "n1", kind: "super", tool: true, title: "T", toolConfig: { name: "T", description: "旧", inputs: [{ name: "a", kind: "text" }, { name: "keep", kind: "text", description: "用户自己写的" }], outputs: [{ name: "o", kind: "text" }] } };' +
        ' const pkg = { name: "T", graph: { rootId: "r", nodes: [{ id: "r", toolConfig: { name: "T", description: "新", example: "{\\"a\\":\\"1\\"}", limits: "L", atLeastOne: [["a","keep"]], inputs: [{ name: "a", kind: "text", description: "新说明", optional: true }, { name: "gone", kind: "text", description: "不在副本里" }], outputs: [{ name: "o", kind: "text", description: "出参说明" }] } }] } };' +
        ' const changed = copyBuiltinTextIntoNode(node, pkg);' +
        ' return [changed, node.toolConfig.description, node.toolConfig.inputs.length, node.toolConfig.inputs[0].description, node.toolConfig.inputs[0].optional === true, node.toolConfig.inputs[1].description, node.toolConfig.outputs[0].description, node.toolConfig.example, node.toolConfig.limits].join("|")',
      "旧副本刷新：文案覆盖（描述 / 参数说明 / 可选位 / 出参说明 / 示例 / 限制），参数个数与顺序不动、名字对不上的参数不碰",
      (v) =>
        v ===
        "true|新|2|新说明|true|用户自己写的|出参说明|{\"a\":\"1\"}|L",
    );
    ok(
      TOOLS.indexOf("async function refreshBuiltinToolCopies(wf)") >= 0 &&
        TOOLS.indexOf("/^builtin:/.test(String(n.toolLibId || \"\"))") >= 0,
      "refreshBuiltinToolCopies：只刷新来自内置条目（toolLibId = builtin:*）的副本",
    );
    ok(
      APP.indexOf("await refreshBuiltinToolCopies(S.wf)") >= 0,
      "打开画布（loadWorkflow）末尾执行内置副本文案刷新",
    );
    /* —— 自检真源：FN_CORE 段里的 toolSelfSuffMissing 与内置判据同一口径 —— */
    A(
      'return toolSelfSuffMissing({ kind: "super", tool: true, toolConfig: { description: "D", inputs: [{ name: "a", kind: "text", description: "A" }], outputs: [{ name: "o", kind: "text", description: "O" }], example: "{\\"a\\":\\"1\\"}", limits: "L" } }).length',
      "toolSelfSuffMissing：齐全的工具回空数组（画布节点不报缺项）",
      (v) => v === 0,
    );
    A(
      'return toolSelfSuffMissing({ kind: "super", tool: true, toolConfig: { description: "", inputs: [{ name: "a", kind: "text" }], outputs: [] } }).length',
      "toolSelfSuffMissing：缺项如实列出（含出参说明 / 示例 / 限制）",
      (v) => v === 5,
    );
    /* —— 界面接入：设置面板三格 + 卡片黄字提醒 + 测试台说明与一键填入 —— */
    const CANVAS = read("renderer/app-canvas.js");
    ok(
      CANVAS.indexOf("参数说明（这个参数该填什么 · 给 Agent 看）") >= 0 &&
        CANVAS.indexOf('ot.textContent = I18n.t("可选")') >= 0,
      "画布工具设置：参数行有「说明」输入与「可选」开关",
    );
    ok(
      CANVAS.indexOf("调用示例 example（一份完整的最小成功调用 · JSON 对象 · 键 = 参数名）") >= 0 &&
        CANVAS.indexOf("限制与失败情形 limits（什么情况下会失败 · 路径与格式规则等）") >= 0 &&
        CANVAS.indexOf("至少给一个 atLeastOne（一行一组，组内用 / 分隔；如：Markdown内容 / 源文件路径）") >= 0,
      "画布工具设置：调用示例 / 限制与失败情形 / 至少给一个三格齐备",
    );
    ok(
      CANVAS.indexOf("toolSelfSuffMissing(node)") >= 0 &&
        CANVAS.indexOf('I18n.t("描述不自足（缺 ")') >= 0,
      "画布工具节点（卡片 + 设置窗）列出缺哪几项（只提示不阻断）",
    );
    ok(
      TOOLS.indexOf('I18n.t("按调用示例填入")') >= 0 &&
        TOOLS.indexOf('I18n.t("还没有调用示例（在该节点「设置」里写一份，Agent 与你都会用到）")') >= 0,
      "工具测试台：参数说明随标签显示 + 调用示例一键填入",
    );
    /* —— i18n：新增词条都有英文（英文界面不回落中文）—— */
    const I18N8 = read("renderer/i18n.js");
    const PAIRS8 = Object.create(null);
    const RE_PAIR8 = /"((?:[^"\\]|\\.)+)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
    let m8;
    while ((m8 = RE_PAIR8.exec(I18N8))) if (!(m8[1] in PAIRS8)) PAIRS8[m8[1]] = m8[2];
    [
      "本机用户数据目录",
      "工具「{name}」的合法用法：",
      "缺少必填参数：",
      "以下参数至少要给一个：",
      "按调用示例填入",
      "用途（描述）",
      "最小调用示例",
      "限制与失败情形",
      "描述不自足（缺 ",
      "调用示例 example（一份完整的最小成功调用 · JSON 对象 · 键 = 参数名）",
    ].forEach((k) => {
      const en = PAIRS8[k];
      ok(
        typeof en === "string" && en.length > 0 && !/[一-鿿]/.test(en),
        "描述自足词条有英文：" + k.slice(0, 16),
      );
    });
  }

  console.log("\n" + (fails ? "FAILED " + fails + " / " + checks + " checks" : "ALL OK  " + checks + " checks"));
  process.exit(fails ? 1 : 0);
})();
