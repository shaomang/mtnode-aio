"use strict";
/* 媒体串行队列的排队项回归（超分 / 补帧 / 生成族共用同一条链）
 *   node test/smoke-media-queue.js
 *
 * 报障原话：「多个超分、补帧节点排队时，一段时间后任务被删除」。
 *
 * 根因（两处，都在排队这条链上）：
 *   [A] clearPendingRun 是「等待中」标记的唯一出口，被多个批次域共用（控制批次 / 级联批次 /
 *       补跑 / 任务）。控制节点那批目标里「已经进媒体串行链、还没轮到自己起跑」的节点此刻
 *       node.running 仍是 false，批次收尾时拿整批 id 一清，就把这些仍在排队的任务的等待态
 *       一起删了 —— 运行队列里那一行凭空消失（用户看到的就是「排队中的任务被删了」），
 *       期间既看不见、点不到、『全部终止』也数不到它。
 *   [B] runMediaGenSerial 出队判定把「派生量」_stopTick !== _runTick 当独立判据：任何入口
 *       只要碰过 _stopTick 而没置 _aborted，排队项就在出队瞬间被静默判死（写一条
 *       「已终止（排队中的生成任务已取消）」），用户从没停过它。停止的可靠判据是 _aborted
 *       （全仓唯一停止入口 bumpNodeStop 必定同时置它），排队项作废另有两条独立证据：
 *       显式停止（_aborted + 从 mediaGenWaiters 摘掉）与全局终止（seq）。
 *
 * 覆盖（全部跑 renderer/app-nodes.js 的真实函数，只有节点表 / 渲染 / 桥用替身）：
 *   [1] 排队项在链上时，别的批次清等待态不得把它的「等待中」删掉（[A] 的修复口径）
 *   [2] 显式停止 / 摘出排队表：等待态必须能被清掉（别把修复做成清不掉）
 *   [3] 串行链：N 个排队项依次起跑、一个都不丢、顺序不乱（[B] 的修复口径）
 *   [4] 真·终止：被停止的排队项不得起跑，并把「已终止（排队中的生成任务已取消）」写在节点上
 *   [5] mediaRunStopped 只认 _aborted（派生量不再有独立否决权）
 *   [6] 排队证据是 mediaGenWaiters：排队中「看得见、停得掉」（hasAnyMediaGenActivity / 摘除即作废）
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
const show = (v) => JSON.stringify(v);
const eqArr = (a, b, msg) => ok(show(a) === show(b), msg + "（得到 " + show(a) + "）");
const read = (rel) =>
  fs.readFileSync(path.join(__dirname, "..", rel.split("/").join(path.sep)), "utf8");

/* ---------- 从源码里按名字抠出顶层函数（不改动源文件，口径同 smoke-media-gen-menu.js） ---------- */
function fnBody(src, name) {
  const pats = [
    new RegExp("\\n(?:async\\s+)?function " + name + "\\s*\\(", "m"),
    new RegExp("\\nconst " + name + "\\s*=", "m"),
    new RegExp("\\nvar " + name + "\\s*=", "m"),
    new RegExp("\\nlet " + name + "\\s*=", "m"),
  ];
  let at = -1;
  for (const p of pats) {
    const m = src.match(p);
    if (m) {
      at = m.index + 1;
      break;
    }
  }
  if (at < 0) throw new Error("找不到函数/常量：" + name);
  const isFn = /^(async\s+)?function/.test(src.slice(at, at + 14));
  if (isFn) {
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
  const iBrace = src.indexOf("{", at);
  const iBracket = src.indexOf("[", at);
  const start =
    iBrace < 0 ? iBracket : iBracket < 0 || iBrace < iBracket ? iBrace : iBracket;
  if (start < 0) throw new Error("找不到常量体：" + name);
  let depth2 = 0;
  for (let j = start; j < src.length; j++) {
    const c = src[j];
    if (c === "{" || c === "[") depth2++;
    else if (c === "}" || c === "]") {
      depth2--;
      if (!depth2) return src.slice(at, j + 1) + ";";
    }
  }
  throw new Error("常量体不完整：" + name);
}
const extract = (src, names) => names.map((n) => fnBody(src, n)).join("\n");

/* ---------- 沙箱：只有与判定无关的部分（渲染 / 桥 / 状态回写）用替身 ---------- */
const rendered = { canvas: 0, panel: 0 };
const sandbox = {
  console,
  Math,
  JSON,
  Set,
  Map,
  Promise,
  Date,
  Number,
  String,
  Object,
  Array,
  Boolean,
  RegExp,
  Error,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  S: { wf: { id: "wf1", nodes: [] }, wfBag: {}, pendingRun: new Set() },
  I18n: { t: (s) => String(s) },
  renderCanvas: () => {
    rendered.canvas++;
  },
  updateRunQueuePanel: () => {
    rendered.panel++;
  },
  toast: () => {},
  scheduleSave: () => {},
  nodeById: (id) => sandbox.S.wf.nodes.find((n) => n.id === id) || null,
  isMediaGenNode: (n) => !!n && /_gen$|video_(upscale|interp)/.test(String(n.kind)),
  isVideoPostKind: (n) => !!n && (n.kind === "video_upscale" || n.kind === "video_interp"),
  ensureBackendUiState: (n) => (n._ui = n._ui || {}),
  computeExecDropWait: () => {},
  stopMediaBackendRunWatcher: (id) => sandbox.mediaBackendRunWatchers.delete(id),
  stopMediaGenRestoreWatch: (id) => {
    const t = sandbox.mediaGenRestoreTimers.get(id);
    if (t) clearInterval(t);
    sandbox.mediaGenRestoreTimers.delete(id);
  },
  stopAllMediaGenRestoreWatch: () => {},
  stopAllMediaBackendRunWatchers: () => {},
  mediaBackendRunWatchers: new Map(),
  mediaGenRestoreTimers: new Map(),
  window: { api: {} },
};
vm.createContext(sandbox);
const G = (name) =>
  vm.runInContext("(typeof " + name + " === 'undefined' ? null : " + name + ")", sandbox);

const nodesSrc = read("renderer/app-nodes.js");
const NODES_FNS = [
  "globalStopSeq",
  "markGlobalStop",
  "beginNodeRun",
  "bumpNodeStop",
  "runBatchStopped",
  "mediaRunStopped",
  "mediaGenQueuedIds",
  "mediaGenQueueHolds",
  "addPendingRun",
  "clearPendingRun",
  "findMediaGenNodeById",
  "mediaGenMarkDropped",
  "runMediaGenSerial",
  "hasAnyMediaGenActivity",
  "stopAllMediaGen",
];
const NODES_VARS = ["mediaGenWaiters", "mediaGenRestoreTimers", "mediaBackendRunWatchers"];
vm.runInContext(
  "let _mediaGenChain = Promise.resolve();\n" +
    "let GLOBAL_STOP_SEQ = 0;\n" +
    extract(nodesSrc, NODES_VARS) +
    extract(nodesSrc, NODES_FNS) +
    "\nglobalThis.__st = { runMediaGenSerial, clearPendingRun, addPendingRun, bumpNodeStop, beginNodeRun," +
    " mediaRunStopped, mediaGenWaiters, mediaGenQueuedIds, mediaGenQueueHolds, hasAnyMediaGenActivity," +
    " stopAllMediaGen, markGlobalStop, globalStopSeq };",
  sandbox,
  { filename: "media-queue-extract.js" },
);
const T = sandbox.__st;

/* ---------- 小工具 ---------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function mkNode(id, kind) {
  return { id, kind, title: id, running: false, _aborted: false };
}
function resetScene(ids) {
  sandbox.S.wf.nodes = (ids || ["up1", "itp1", "up2"]).map((id) =>
    mkNode(id, id.indexOf("itp") === 0 ? "video_interp" : "video_upscale"),
  );
  sandbox.S.wfBag = {};
  sandbox.S.pendingRun = new Set();
  T.mediaGenWaiters.clear();
  rendered.canvas = 0;
  rendered.panel = 0;
}
/* 起跑替身：真实 playVideoPostNode 要后端，这里只记「谁按顺序起跑了」+ 走完 running 生命周期。
   gate：可选的闸门——第一个起跑的任务停在这里，让「后面几个真在排队」的窗口稳定可控
   （否则第一个可能已经跑完出队，断言就落在竞态上）。 */
function makeRunner(ran, gate) {
  return (n) =>
    T.runMediaGenSerial(n, async () => {
      ran.push(n.id);
      T.beginNodeRun(n);
      n.running = true;
      if (gate && ran.length === 1) await gate;
      else await sleep(12);
      n.running = false;
      n.ranAt = Date.now();
      return "ok";
    });
}
function deferred() {
  let release = () => {};
  const p = new Promise((r) => {
    release = r;
  });
  return { p, release };
}

(async function main() {
  console.log("\n[0] 源码抽取自检");
  eqArr(
    NODES_FNS.filter((n) => typeof G(n) !== "function"),
    [],
    "app-nodes.js 目标函数全部抽到真实实现",
  );

  console.log("\n[1] 排队中：别的批次清「等待中」不得把仍在链上排队的任务删掉");
  {
    resetScene();
    const ran = [];
    const gate = deferred();
    const run = makeRunner(ran, gate.p);
    const ps = sandbox.S.wf.nodes.map((n) => run(n));
    await sleep(2); /* 第一个已起跑并被闸门挡着，后两个稳定停在排队窗口里 */
    eqArr(
      [...T.mediaGenQueuedIds()].sort(),
      ["itp1", "up2"],
      "后两个节点正停在媒体串行链上排队（第一个已在跑）",
    );
    ok(
      [...sandbox.S.pendingRun].sort().join(",") === "itp1,up1,up2",
      "三个都在「等待中」名单里（正在跑的那个也在自己的名下单）",
    );
    /* 控制节点批次收尾：拿整批目标 id 清等待态（真源码 playControlNode 的 finally 写法） */
    T.clearPendingRun(["up1", "itp1", "up2"]);
    eqArr(
      [...sandbox.S.pendingRun].sort(),
      ["itp1", "up2"],
      "清等待态后：仍在串行链上排队的两个等待态**保留**（不再凭空消失），已起跑的那个正常清掉",
    );
    ok(T.hasAnyMediaGenActivity(), "「全部终止」仍能看见队列里还有排队任务");
    gate.release();
    await Promise.all(ps);
    eqArr(ran, ["up1", "itp1", "up2"], "三个排队项依次真的起跑（一个都没丢）");
  }

  console.log("\n[2] 显式停止 / 摘出排队表：等待态必须清得掉（别把修复做成清不掉）");
  {
    resetScene();
    const ran = [];
    const run = makeRunner(ran);
    const ps = sandbox.S.wf.nodes.map((n) => run(n));
    await sleep(2);
    /* stopNode 的媒体分支：先从排队表摘掉，再 force 清等待态（app.js:20746 的真写法） */
    T.mediaGenWaiters.delete("itp1");
    T.clearPendingRun(["itp1"], { force: true });
    ok(!sandbox.S.pendingRun.has("itp1"), "显式停止的排队项：等待态立刻清掉");
    await Promise.all(ps);
    eqArr(ran, ["up1", "up2"], "被显式停止的排队项不再起跑");
    eqArr(
      [sandbox.S.wf.nodes[1].videoStatus || ""],
      ["已终止（排队中的生成任务已取消）"],
      "被停止的排队项在节点上写明「已终止（排队中的生成任务已取消）」",
    );
  }

  console.log("\n[3] 串行链：N 个排队项一个都不丢、顺序不乱（派生量不再有否决权）");
  {
    resetScene(["up1", "itp1", "up2", "itp2"]);
    const ran = [];
    const run = makeRunner(ran);
    /* 旧写法会在这里被判死：出队前 _stopTick 与 _runTick 派生量对不上（未置 _aborted） */
    for (const n of sandbox.S.wf.nodes) n._stopTick = 3, (n._runTick = 0);
    const ps = sandbox.S.wf.nodes.map((n) => run(n));
    await Promise.all(ps);
    eqArr(ran, ["up1", "itp1", "up2", "itp2"], "四个排队项全部起跑，顺序与入队一致");
    eqArr(
      sandbox.S.wf.nodes.map((n) => n.videoStatus || ""),
      ["", "", "", ""],
      "没有一个被误写成「已终止（排队中的生成任务已取消）」",
    );
    eqArr([...T.mediaGenWaiters.keys()], [], "跑完排队表清空");
  }

  console.log("\n[4] 真·终止：停止过的排队项绝不起跑");
  {
    resetScene();
    const ran = [];
    const run = makeRunner(ran);
    const ps = sandbox.S.wf.nodes.map((n) => run(n));
    await sleep(2);
    T.bumpNodeStop(sandbox.S.wf.nodes[1]); /* 单独停止 itp1（真源码 bumpNodeStop） */
    T.mediaGenWaiters.delete("itp1");
    await Promise.all(ps);
    eqArr(ran, ["up1", "up2"], "被 bumpNodeStop 的排队项没有起跑");
    ok(T.mediaRunStopped(sandbox.S.wf.nodes[1]), "mediaRunStopped 认这个停止标记");
  }

  console.log("\n[5] mediaRunStopped 只认 _aborted（派生量不再独立否决）");
  {
    resetScene();
    const n = sandbox.S.wf.nodes[0];
    n._stopTick = 5;
    n._runTick = 2;
    n._aborted = false;
    ok(!T.mediaRunStopped(n), "_stopTick/_runTick 不一致但没 _aborted → 不算已停止（排队项不会被误删）");
    n._aborted = true;
    ok(T.mediaRunStopped(n), "_aborted → 算已停止");
  }

  console.log("\n[6] 排队证据来自 mediaGenWaiters：起作用的是「在链上」而不是某个批次留下的标记");
  {
    resetScene(["up1", "up2"]);
    const ran = [];
    const gate = deferred();
    const run = makeRunner(ran, gate.p);
    const ps = sandbox.S.wf.nodes.map((n) => run(n));
    await sleep(2);
    ok(T.mediaGenQueueHolds("up2"), "mediaGenQueueHolds 认得正排队的节点（up2）");
    ok(!T.mediaGenQueueHolds("up1"), "已在跑的那个不算排队");
    ok(!T.mediaGenQueueHolds("nope"), "没排队的节点不认");
    gate.release();
    await Promise.all(ps);
    ok(!T.mediaGenQueueHolds("up2"), "出队后不再持有排队项");
  }

  console.log("\n" + (fails ? "FAIL " + fails + " / " + checks : "全部通过 " + checks + " 项"));
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});