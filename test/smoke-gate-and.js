"use strict";
/* ============================================================
 * 闸门「多路 AND」防提前放闸回归冒烟测试 —— 纯 Node，不依赖 Electron
 *   node test/smoke-gate-and.js
 *
 * 本轮修的 bug：闸门放行节点有误 —— 上游控制线只来了第一路信号，闸门就自动放闸。
 * 根因：闸门有两套到达语义，只有「任务内脉冲」（pulseGate）实现了 AND；
 * 「控制线」那套调度（runControlledNode：控制节点 ▶ / 序列器 / 分发器 / 媒体节点
 * 控制输出 / 定时器 / 接收节点）把闸门当普通目标直接 playGateNode = 强制放行，
 * 于是任意一路到达就把闸门打开，其余上游还在路上。
 * 修法：控制线驱动改走 pulseGateByControl —— 每次到达只记在**落点输入口**上，
 * 所有输入口都到齐才放行；▶ 才是「强制放行」（guides/nodes/gate.md 的口径）。
 *
 * 被测代码取自 renderer 真实源码（不抄一份逻辑）：
 *   renderer/app.js       normalizeGateNode / gateConnectedKeys / controlGateArrivalKeysFor /
 *                         pulseGateByControl / pulseGate / mergePulseResults
 *   renderer/app-nodes.js runControlledNode / runControlRunnableQueue / fireControlOutgoing
 * 覆盖：
 *   [1] 控制线路由：闸门不再是「跑一次」的目标（playGateNode 只剩 ▶ 两个入口）
 *   [2] 落点端口一路传到底：控制线三处调用都带 toIndex；队列默认 exec 会按线推落点
 *   [3] 行为 · 控制线到达：第 1/2 路不放行，第 3 路才放行一次并清零到达
 *   [4] 行为 · 边界：未接线口照样挡路 · 同口重复到达不重复计数 · 越界口不记账 ·
 *       一个上游连两个口 = 两路到达 · 无端口信息时按上游连线推落点 · 放行中不重入
 *   [5] 行为 · 任务内脉冲 pulseGate 仍是同一套 AND 口径
 *   [6] 文档口径：guides/nodes/gate.md 的「每一口」与「▶ 强制放行」未变
 * ============================================================ */
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
    .readFileSync(
      path.join(__dirname, "..", rel.split("/").join(path.sep)),
      "utf8",
    )
    .replace(/\r\n?/g, "\n");
const HAS = (src, needle, msg) =>
  ok(
    src.indexOf(needle) >= 0,
    msg + (src.indexOf(needle) >= 0 ? "" : "\n        缺：" + needle),
  );
const NO = (src, needle, msg) =>
  ok(src.indexOf(needle) < 0, msg + (src.indexOf(needle) < 0 ? "" : "\n        多：" + needle));
/* 大括号配对切出完整函数（含 async / 函数名与参数表）；找不到返回 "" */
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
/* 轻量 I18n 桩：zh 口径原样返回（与 i18n.js 的 zh 分支一致），只替换 {var} */
const I18N_STUB = {
  t: (k, vars) =>
    String(k).replace(/\{(\w+)\}/g, (_, n) =>
      vars && vars[n] != null ? String(vars[n]) : "",
    ),
};

const APP = read("renderer/app.js");
const NODES = read("renderer/app-nodes.js");
const CANVAS = read("renderer/app-canvas.js");
const GUIDE = read("guides/nodes/gate.md");

/* ══════════════ [1] 控制线路由（谁在放闸） ══════════════ */
console.log("\n[1] 控制线路由：闸门不是「跑一次」，是「多路 AND 到达」");
const RC = fnBody(NODES, "runControlledNode");
ok(RC.length > 0, "切出真实 runControlledNode");
HAS(
  RC,
  'if (n.kind === "gate") return pulseGateByControl(n, seen, viaIndexes, sourceId);',
  "runControlledNode：闸门分支走 pulseGateByControl（按口记到达）",
);
NO(RC, "playGateNode", "runControlledNode 内不再出现强制放闸 playGateNode");
const PGB = fnBody(APP, "pulseGateByControl");
ok(PGB.length > 0, "切出真实 pulseGateByControl");
HAS(
  PGB,
  'if (!needed.every((k) => node.gateArrived[k])) return "open";',
  "pulseGateByControl：未全部到齐就停在闸门前（提前 return）",
);
HAS(PGB, "await runTimerTargets(node, true);", "放行后走控制线下游调度 runTimerTargets");
HAS(APP, "function controlGateArrivalKeysFor(", "落点端口推导 helper 存在");
/* ▶（用户点闸门本体 / 画布按钮）= 强制放行，必须原样保留 */
HAS(fnBody(APP, "playGateNode"), "runTimerTargets(node, !!quiet)", "▶ playGateNode 仍是强制放行");
HAS(fnBody(NODES, "playNodeBody"), "return playGateNode(node, quiet);", "节点 ▶ 派发仍走 playGateNode");
HAS(CANVAS, "playUserNode(node);", "画布闸门 ▶ 按钮走 playUserNode（先过工作目录闸门）");
HAS(
  fnBody(NODES, "playUserNode"),
  "await playNode(node, false, opts || {})",
  "playUserNode 仍把闸门节点交回 playNode → playGateNode（强制放行语义没变）",
);
NO(CANVAS, "playGateNode(node, false);", "画布上不再直接放行（漏过工作目录闸门）");

/* ══════════════ [2] 落点端口一路传到底 ══════════════ */
console.log("\n[2] 控制线三处调用都把落点端口带下去");
HAS(
  fnBody(NODES, "fireControlOutgoing"),
  "runControlledNode(next, s2, Number(w.toIndex || 0), node.id)",
  "fireControlOutgoing（媒体 / 接收 / 判断控制输出）带 toIndex",
);
HAS(
  fnBody(APP, "fireTaskControlOutputs"),
  "runControlledNode(next, seen, Number(w.toIndex || 0), node.id)",
  "fireTaskControlOutputs（任务控制输出）带 toIndex",
);
const QUEUE = fnBody(NODES, "runControlRunnableQueue");
HAS(QUEUE, "const viaOf = (n) => {", "队列默认 exec 自带落点推导 viaOf");
HAS(
  QUEUE,
  "((n) => runControlledNode(n, seen, viaOf(n), controlNode && controlNode.id))",
  "队列默认 exec 把落点端口 / 上游来源一起传下去",
);
HAS(QUEUE, "w.from !== controlNode.id || w.to !== n.id", "viaOf 按「上游→本目标」的连线取 toIndex");

/* ══════════════ 真实源码切片进沙箱 ══════════════ */
const PRELUDE = `
var WF = { nodes: [], wires: [] };
function allWiresTo(id) {
  return WF.wires
    .filter(function (w) { return w.to === id && !w.rel; })
    .sort(function (a, b) { return Number(a.toIndex || 0) - Number(b.toIndex || 0); });
}
var RENDER = 0;
function renderCanvas() { RENDER++; }
var SAVES = 0;
function scheduleSave() { SAVES++; }
var RELEASES = [];
async function runTimerTargets(n) { RELEASES.push(n.id); return 1; }
var PULSED = [];
async function pulseExecOutgoing(n, i) { PULSED.push(n.id); return ['open']; }
async function arrived(via, src) { return pulseGateByControl(G, null, via, src); }
async function pulsed() { return pulseGate(G, { _aborted: false }, new Set(), arguments[0]); }
`;
const SB = vm.createContext({ console, I18n: I18N_STUB, Set });
vm.runInContext(PRELUDE, SB);
vm.runInContext(
  [
    fnBody(APP, "normalizeGateNode"),
    fnBody(APP, "gateConnectedKeys"),
    fnBody(APP, "controlGateArrivalKeysFor"),
    fnBody(APP, "pulseGateByControl"),
    fnBody(APP, "pulseGate"),
    fnBody(APP, "mergePulseResults"),
  ].join("\n"),
  SB,
);
const E = (code) => {
  try {
    vm.runInContext(code, SB);
    return null;
  } catch (e) {
    return "ERR:" + String((e && e.message) || e);
  }
};
const V = (expr) => {
  try {
    return vm.runInContext("(" + expr + ")", SB);
  } catch (e) {
    return "ERR:" + String((e && e.message) || e);
  }
};
const AV = async (expr) => {
  const p = V(expr);
  if (p && typeof p.then === "function") return await p;
  return p;
};
const J = (x) => {
  try {
    return JSON.stringify(x);
  } catch (e) {
    return String(x);
  }
};
const EQ = (expr, want, msg) => {
  const v = V(expr);
  ok(
    J(v) === J(want),
    msg + (J(v) === J(want) ? "" : "\n        实际=" + J(v) + "\n        期望=" + J(want)),
  );
};

/* 3 口闸门 + 三路上游（a→口0 / b→口1 / c→口2） */
function fixture(ports, wires) {
  E(
    [
      "WF.nodes = []; WF.wires = []; RELEASES = []; PULSED = []; RENDER = 0;",
      "var G = { id: 'g', kind: 'gate', title: '闸门', gateInputs: " + ports + ", gateArrived: {}, gateStatus: '' };",
      "WF.nodes.push(G);",
    ]
      .concat(
        (wires || []).map(
          (w, i) =>
            "WF.wires.push({ id: 'w" + i + "', from: '" + w[0] + "', to: 'g', toIndex: " + w[1] + ", fromIndex: 0 });",
        ),
      )
      .join("\n"),
  );
}

/* ══════════════ [3] 行为 · 控制线到达（主 bug） ══════════════ */
console.log("\n[3] 控制线到达：第 1 / 2 路绝不放闸，第 3 路才放行一次");
fixture(3, [["a", 0], ["b", 1], ["c", 2]]);
(async () => {
  await AV("arrived(0, 'a')");
  EQ("RELEASES.length", 0, "只到第 1 路：闸门不放行");
  EQ("G.gateArrived['0'] === true && !G.gateArrived['1'] && !G.gateArrived['2']", true, "到达只记在口 0");
  EQ("G.gateStatus", I18N_STUB.t("已到 ") + "1/3", "状态行显示 1/3");
  await AV("arrived(1, 'b')");
  EQ("RELEASES.length", 0, "到第 2 路：仍不放行（这就是修前的 bug 点）");
  EQ("G.gateStatus", I18N_STUB.t("已到 ") + "2/3", "状态行显示 2/3");
  await AV("arrived(2, 'c')");
  EQ("RELEASES.length", 1, "三路到齐：放行一次");
  EQ("RELEASES[0]", "g", "放行的就是本闸门");
  EQ("JSON.stringify(G.gateArrived)", "{}", "放行后到达标记清零（下一轮重新计）");
  EQ("G.gateStatus", I18N_STUB.t("闸门已放行"), "状态行=闸门已放行");
  EQ("G.running", false, "放行结束不残留运行态");
  EQ("G._gateFiring", false, "放行锁回收");

  /* ══════════════ [4] 行为 · 边界 ══════════════ */
  console.log("\n[4] 边界：未接线口挡路 / 重复到达 / 越界口 / 一对多 / 上游推落点 / 重入");
  /* 配置 3 口但只接 2 路：两口都到也不放行（文档：未接线的口也会挡住放行） */
  fixture(3, [["a", 0], ["b", 1]]);
  await AV("arrived(0, 'a')");
  await AV("arrived(1, 'b')");
  EQ("RELEASES.length", 0, "未接线口照样挡住放行");
  HAS(V("G.gateStatus"), I18N_STUB.t(" 路未接线"), "状态行提示未接线路数");

  /* 同一个口重复到达：到达次数按口算，不堆成「到齐」 */
  fixture(3, [["a", 0], ["b", 1], ["c", 2]]);
  await AV("arrived(0, 'a')");
  await AV("arrived(0, 'a')");
  EQ("RELEASES.length", 0, "同一口重复到达 → 不放行");
  EQ("G.gateStatus", I18N_STUB.t("已到 ") + "1/3", "重复到达不重复计数");

  /* 越界端口（线落在配置口之外）：不记账、不误判为到达 */
  fixture(2, [["a", 0], ["b", 1]]);
  await AV("arrived(5, 'a')");
  EQ("JSON.stringify(G.gateArrived)", "{}", "越界端口不记到达");
  EQ("G.gateStatus", I18N_STUB.t("脉冲未落在配置输入口内"), "越界端口给出明确状态");
  EQ("RELEASES.length", 0, "越界端口绝不放行");

  /* 一个上游连到闸门两个口（viaOf 给出两个落点）= 两路到达 */
  fixture(2, [["a", 0], ["a", 1]]);
  await AV("arrived([0, 1], 'a')");
  EQ("RELEASES.length", 1, "一个上游连两口：一次到达算两路 → 放行");

  /* 没有端口信息时按「上游 → 本闸门」的连线推落点 */
  fixture(2, [["a", 0], ["b", 1]]);
  await AV("arrived(null, 'b')");
  EQ("G.gateArrived['1'] === true", true, "无端口信息时按上游连线推到口 1");
  EQ("RELEASES.length", 0, "推到口 1 后仍未到齐 → 不放行");
  await AV("arrived(null, 'a')");
  EQ("RELEASES.length", 1, "两路到齐才放行");

  /* 放行中重入（_gateFiring）不重复放行 */
  fixture(2, [["a", 0], ["b", 1]]);
  await AV("arrived(0, 'a')");
  E("G._gateFiring = true;");
  await AV("arrived(1, 'b')");
  EQ("RELEASES.length", 0, "放行进行中（_gateFiring）不重入");
  E("G._gateFiring = false;");

  /* ══════════════ [5] 任务内脉冲同口径 ══════════════ */
  console.log("\n[5] 任务内脉冲 pulseGate：同一套 AND");
  fixture(2, [["a", 0], ["b", 1]]);
  await AV("pulsed(0)");
  EQ("PULSED.length", 0, "任务内只到第 1 路：不放行");
  await AV("pulsed(1)");
  EQ("PULSED.length", 1, "任务内两路到齐：放行一次");

  /* ══════════════ [6] 文档口径 ══════════════ */
  console.log("\n[6] 文档口径未变");
  HAS(GUIDE, "每一口", "指南：每一口都要收到脉冲才放行");
  HAS(GUIDE, "未接线的口也会挡住放行", "指南：未接线口阻挡");
  HAS(GUIDE, "强制放行", "指南：▶ 强制放行（忽略到达状态）");

  console.log(
    "\n" + (fails ? "FAIL " + fails + " 项 / " : "") + checks + " 项检查" + (fails ? "" : " 全绿"),
  );
  process.exit(fails ? 1 : 0);
})();
