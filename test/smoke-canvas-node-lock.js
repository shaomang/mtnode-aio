"use strict";
/* 画布智能节点的「画布锁」按轮归属回归冒烟测试 —— 纯 Node，不启动 Electron
 *   node test/smoke-canvas-node-lock.js
 *
 * 保住的行为（本次修复）：智能任务节点（画布智能节点）运行期间的画布锁**只作用于
 *   发起这一轮的那个节点**，不再是一把全局锁。
 *
 *   修复前的现场：闸门看的是全局计数 S._canvasNodeAgentDepth（>0 即拒），于是只要有一个
 *   智能任务节点在跑，屏幕上**任何来源**的画布 / 应用帧都被拒 —— 包括第三方 MCP 客户端
 *   （Claude Code / 手机接管）经 renderer/mcp-bridge.js → handleCanvasEvent 发来的读写帧，
 *   它既不是那个节点、也不属于那一轮。外部编辑器常驻连接时表现就是「画布动不动就说不能改」。
 *
 *   现在：dshRunTask 起这一轮时按 runKey 登记（lockCanvasForAgentNodeRun），收尾注销，
 *   画布闸（applyCanvasOp / handleCanvasEvent）只拦被登记的那些轮。
 *
 * 覆盖：
 *   [1] 锁登记表真跑：按轮登记 / 计数 / 注销；空 runKey 不登记也不命中
 *   [2] 全局计数语义没变（restrictOtherCanvases 仍按它判「此刻有没有智能节点在跑」）
 *   [3] 宿主两道画布闸都换成了按轮判据（不再是 isCanvasNodeAgentRun）
 *   [4] 起停登记接线：dshRunTask 在 scopeLock 分支登记 / 收尾注销（成对）
 *   [5] 画布事件路由把这一轮是不是画布智能节点透传进来（nodeLock）
 *   [6] MCP 帧仍走同一道闸（第三方客户端的读写帧同样受按轮判据约束）
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
const section = (t) => console.log("\n[" + t + "]");
const read = (rel) =>
  fs
    .readFileSync(path.join(__dirname, "..", rel.split("/").join(path.sep)), "utf8")
    .replace(/\r\n?/g, "\n");

const NODES = read("renderer/app-nodes.js");
const DB = read("renderer/app-db.js");
const BRIDGE = read("renderer/mcp-bridge.js");

/* ── 从源码里抠出整个函数体（跳过字符串 / 注释做括号配对）── */
function sliceBraces(src, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      i++;
      while (i < src.length) {
        if (src[i] === "\\") {
          i += 2;
          continue;
        }
        if (src[i] === q) break;
        i++;
      }
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i);
      i = nl < 0 ? src.length : nl - 1;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end < 0 ? src.length : end + 1;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return src.slice(openIdx, i + 1);
    }
  }
  return "";
}
function funcBody(src, header) {
  const at = src.indexOf(header);
  if (at < 0) throw new Error("切不出源码：" + header);
  const head = header.replace(/\s*\{\s*$/, "");
  const open = src.indexOf("{", at + head.length);
  const body = sliceBraces(src, open);
  if (!body || body.length < 20) throw new Error("切出的函数体异常：" + header);
  return src.slice(at, open) + body;
}
/* 源码块（按起止锚点切片，用于「就在这一条路径里」的断言） */
function blockBetween(src, from, to) {
  const a = src.indexOf(from);
  if (a < 0) return "";
  const b = to ? src.indexOf(to, a + from.length) : -1;
  return src.slice(a, b > a ? b : src.length);
}

/* ── [1][2] 锁登记表：真跑（vm 里跑渲染层真函数） ── */
section("1 锁登记表（真跑 app-nodes.js 里的三个 helper）");
const sandbox = { S: {}, I18n: { t: (k) => k }, console };
vm.createContext(sandbox);
for (const header of [
  "function canvasNodeRunLocked(",
  "function lockCanvasForAgentNodeRun(",
  "function unlockCanvasForAgentNodeRun(",
  "function isCanvasNodeAgentRun(",
]) {
  vm.runInContext(funcBody(NODES, header), sandbox);
}
const hasLocked = vm.runInContext("typeof canvasNodeRunLocked", sandbox);
ok(hasLocked === "function", "三个 helper 都能从 app-nodes.js 里切出来并求值");

vm.runInContext("lockCanvasForAgentNodeRun('run:A')", sandbox);
ok(
  vm.runInContext("canvasNodeRunLocked('run:A') === true", sandbox),
  "登记的轮命中：run:A 在跑时它自己的画布帧被拦",
);
ok(
  vm.runInContext("canvasNodeRunLocked('run:B') === false", sandbox),
  "别的轮不命中：run:B（会话 / 第三方 MCP 连接）照旧可以读写画布",
);
ok(
  vm.runInContext("canvasNodeRunLocked('') === false", sandbox),
  "空 runKey 不命中（渲染层本地直调 / 老调用保持原行为）",
);
vm.runInContext("lockCanvasForAgentNodeRun('run:A')", sandbox);
ok(
  vm.runInContext("S._canvasNodeRunLocks['run:A'] === 2", sandbox),
  "同一轮重入登记按计数累加（不会一次注销就把锁摘掉）",
);
vm.runInContext("unlockCanvasForAgentNodeRun('run:A')", sandbox);
ok(
  vm.runInContext("canvasNodeRunLocked('run:A') === true", sandbox),
  "注销一次仍锁着（计数 2 → 1）",
);
vm.runInContext("unlockCanvasForAgentNodeRun('run:A')", sandbox);
ok(
  vm.runInContext("canvasNodeRunLocked('run:A') === false", sandbox),
  "注销干净后不再命中（收尾 / 终止 / 看门狗兜底都走这一条）",
);
ok(
  vm.runInContext("Object.keys(S._canvasNodeRunLocks).length === 0", sandbox),
  "计数归零即从表里删掉（按 id 无限增长的口子不留）",
);
vm.runInContext("unlockCanvasForAgentNodeRun('never-locked')", sandbox);
ok(
  vm.runInContext("Object.keys(S._canvasNodeRunLocks).length === 0", sandbox),
  "没登记过的 runKey 注销是空操作（不抛错）",
);

section("2 全局计数语义没变（别的判据还按它问「此刻有没有智能节点在跑」）");
vm.runInContext("S._canvasNodeAgentDepth = 2", sandbox);
ok(
  vm.runInContext("isCanvasNodeAgentRun() === true", sandbox),
  "isCanvasNodeAgentRun 仍按全局计数（restrictOtherCanvases / 跨画布锁定用它）",
);
ok(
  vm.runInContext("canvasNodeRunLocked('run:B') === false", sandbox),
  "但计数 >0 不再等于「锁死所有轮」：按轮判据只看登记表",
);
const restrict = funcBody(NODES, "function restrictOtherCanvases(");
ok(
  /S\._canvasNodeAgentDepth/.test(restrict),
  "restrictOtherCanvases 继续用全局计数（跨画布锁定口径未动）",
);

/* ── [3] 宿主两道画布闸换判据 ── */
section("3 宿主画布闸：按轮判据（applyCanvasOp / handleCanvasEvent）");
const applyOp = funcBody(NODES, "async function applyCanvasOp(");
const handleEv = funcBody(NODES, "function handleCanvasEvent(");
ok(
  /canvasNodeRunLocked\(runKey\)/.test(applyOp),
  "applyCanvasOp 用 canvasNodeRunLocked(runKey) 判自己这一轮",
);
ok(
  /canvasNodeRunLocked\(frameOwner\.runKey\)/.test(handleEv),
  "handleCanvasEvent 用 canvasNodeRunLocked(frameOwner.runKey) 判这一帧归属的轮",
);
ok(
  !/isCanvasNodeAgentRun\(\)/.test(applyOp) && !/isCanvasNodeAgentRun\(\)/.test(handleEv),
  "两道闸里都不再出现全局 isCanvasNodeAgentRun()（这正是「别人一起被锁死」的根因）",
);
ok(
  /locked: canvasNodeRunLocked\(runCtx\.runKey\)/.test(handleEv),
  "handleCanvasEvent 把这一帧的锁状态算进 frameOwner（一处判定，别处复用）",
);
ok(
  /\(op === "get" \|\| op === "edit" \|\| op === "app"\)/.test(applyOp) &&
    /\(opEarly === "get" \|\| opEarly === "edit" \|\| opEarly === "app"\)/.test(handleEv),
  "被拦的仍是画布三件套 get / edit / app（与修复前同一口径）",
);
ok(
  /S\._ltCanvasReadDepth \|\| 0\) > 0 && \(op === "edit" \|\| op === "app"\)/.test(applyOp),
  "长任务「只读画布」档那条独立闸（edit / app 仍旧拒）原样保留",
);

/* ── [4] 起停登记接线 ── */
section("4 dshRunTask 起停成对登记（app-db.js）");
const startBlock = blockBetween(
  DB,
  "const scopeLock = nodeLock;",
  "/* 长任务「只读画布」档也要锁本画布",
);
ok(
  /lockCanvasForAgentNodeRun\(runKey\)/.test(startBlock),
  "开跑：scopeLock 分支里 lockCanvasForAgentNodeRun(runKey)（与深度计数同一分支）",
);
ok(
  /S\._canvasNodeAgentDepth = \(S\._canvasNodeAgentDepth \|\| 0\) \+ 1/.test(startBlock),
  "开跑：全局计数照旧累加（restrictOtherCanvases 那一档没动）",
);
/* 收尾那一处：按「深度计数递减」这个锚点定位（起跑那一处是 +1，不会撞上） */
const endAt = DB.indexOf("(S._canvasNodeAgentDepth || 1) - 1");
const endBlock =
  endAt > 0 ? DB.slice(Math.max(0, endAt - 420), endAt + 260) : "";
ok(
  /unlockCanvasForAgentNodeRun\(runKey\)/.test(endBlock),
  "收尾：unlockCanvasForAgentNodeRun(runKey)（成功 / 失败 / 终止 / 看门狗都走 finish）",
);
ok(
  /S\._canvasNodeAgentDepth = Math\.max\(/.test(endBlock),
  "收尾：全局计数照旧递减",
);
/* 只数真调用：该行 trim 后以名字开头、并以 `(runKey);` 收尾（定义行与 typeof 守卫不算） */
const callCount = (src, name) =>
  src
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      return t.startsWith(name + "(") && t.endsWith("(runKey);");
    }).length;
const lockCalls = callCount(DB, "lockCanvasForAgentNodeRun");
const unlockCalls = callCount(DB, "unlockCanvasForAgentNodeRun");
ok(
  lockCalls === 1 && unlockCalls === 1,
  "登记 / 注销各只有一处（成对，实测 " + lockCalls + " / " + unlockCalls + "）",
);

/* ── [5] 运行上下文透传 ── */
section("5 画布事件路由透传「这一轮是不是画布智能节点」");
ok(
  /nodeLock,/.test(blockBetween(DB, "handleCanvasEvent(msg.data || {}, {", "});")),
  "app-db.js 的 canvas 帧路由把 nodeLock 透传进 runCtx",
);
ok(
  /const nodeLock = nodeScoped && !ltCanvasRead;/.test(DB),
  "nodeLock 仍是「画布智能节点且非长任务只读档」的同一判据",
);

/* ── [6] MCP 帧走同一道闸 ── */
section("6 第三方 MCP 帧仍走 handleCanvasEvent（同一道按轮闸）");
ok(
  /handleCanvasEvent\(/.test(BRIDGE),
  "mcp-bridge.js 的画布族复用 handleCanvasEvent（不另写执行器）",
);
ok(
  /无本轮 planMode \/ nodeLock：MCP 连接不是画布智能节点/.test(BRIDGE),
  "MCP 帧的 runCtx 不带 nodeLock —— 它本来就不该被画布节点那档闸拦住",
);

console.log(
  (fails ? "✗ " + fails + " / " + checks + " 项失败" : "✓ " + checks + " 项全部通过") +
    "  (smoke-canvas-node-lock)",
);
process.exit(fails ? 1 : 0);
