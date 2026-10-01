"use strict";
/* 会话「思考 / 逐字输出」增量帧的来源修复 —— 冒烟测试（纯 Node + vm 切片求值，无 Electron）
 *   node test/smoke-gateway-stream-replay.js
 *
 * 事故（2026-09-30 现场取证，根因不在渲染层）：
 *   dsh 0.2 的运行时**不再发 `assistant/chunk` 增量帧**（连发 60 个会话日志里
 *   `assistant/chunk` 出现 0 次；每个 step 只有一条完整的 `assistant/message`），
 *   而网关 mapNotification 的 `assistant/chunk` 分支正是 reasoning / text /
 *   tool-preparing 三类帧的唯一出口 —— 于是模型明明思考了（message.content 里
 *   reasoning 块有真文本），宿主与渲染层一个字的思考增量都收不到：
 *   会话里既没有思考块，正文也不逐字出现（前两轮都在改渲染层，因此怎么改都不好）。
 *   0.2 把流式数据挪进了完整消息的 `stream` 字段（逐块 text + 每块之间的 dt 毫秒），
 *   本次修复在 `assistant/message` 分支把它还原成与 assistant/chunk **同形**的帧。
 *
 * 真源（项目根）：
 *   dsh/gateway/gateway.mjs  synthesizeChunksFromStream / streamReplayDelay /
 *                            chunkSeenKey / mapNotification 的 assistant/message 分支
 *   renderer/app-db.js       attachTraceSegments（拼不回正文时不再整份丢 segments）
 *   renderer/app-assist.js   dshMsgSegsViewable / dshMsgBlock（认 _segNoBody）
 *
 * 覆盖：
 *   [1] 还原出的帧序列与 assistant/chunk 同形（reasoning / text / say-end / tool-preparing）
 *   [2] 帧的 turn/step/index 元数据正确、say-end 只对正文块发
 *   [3] 边界：没有 stream / 开关关闭 / 已收到原生 chunk → 一帧都不发（不双发）
 *   [4] 接线口径：assistant/message 分支存在且用 break（不吞掉末尾的原始事件透传帧）
 *   [5] 段快照：拼不回正文时保留含思考的段（不再整份 delete msg.segments）
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
const abs = (rel) => path.join(__dirname, "..", ...rel.split("/"));
const read = (rel) => fs.readFileSync(abs(rel), "utf8");
function fnBody(src, name) {
  const pats = [
    new RegExp("\\n(?:async\\s+)?function " + name + "\\s*\\(", "m"),
    new RegExp("\\nconst " + name + "\\s*=", "m"),
    new RegExp("\\nvar " + name + "\\s*=", "m"),
  ];
  let at = -1;
  for (const p of pats) {
    const m = src.match(p);
    if (m) { at = m.index + 1; break; }
  }
  if (at < 0) throw new Error("找不到函数/常量：" + name);
  const i = src.indexOf("{", at);
  if (i < 0) throw new Error("找不到函数体：" + name);
  let depth = 0;
  let inStr = null;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    const p = src[j - 1];
    if (inStr) { if (c === inStr && p !== "\\") inStr = null; continue; }
    if (c === "/" && src[j + 1] === "/") { j = src.indexOf("\n", j) - 1; continue; }
    if (c === "/" && src[j + 1] === "*") { j = src.indexOf("*/", j) + 1; continue; }
    if (c === '"' || c === "'" || c === "`") { inStr = c; continue; }
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (!depth) return src.slice(at, j + 1); }
  }
  throw new Error("括号不配平：" + name);
}
function constLine(src, name) {
  const re = new RegExp("\\n[ \\t]*(?:const|let|var) " + name + "\\s*=[^\\r\\n]*", "m");
  const m = src.match(re);
  if (!m) throw new Error("找不到单行常量：" + name);
  return m[0].replace(/^\n/, "") + "\n";
}

const gwSrc = read("dsh/gateway/gateway.mjs");

/* ── 把网关里的真实现抽进 vm（emit / diag / 累计器一律给桩） ── */
const logs = [];
const sandbox = {
  console,
  Date,
  Number,
  String,
  Array,
  Object,
  Set,
  Math,
  JSON,
  SharedArrayBuffer,
  Int32Array,
  Atomics,
  process: { env: {} },
  toolPrepAcc: new Map(),
  TOOL_PREP_MIN_GAP_MS: 120,
  TOOL_PREP_MAX_CALLS: 64,
  diag: (s) => logs.push(String(s)),
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(
  constLine(gwSrc, "STREAM_REPLAY_MAX_MS") +
    constLine(gwSrc, "STREAM_REPLAY_BUDGET_MS") +
    constLine(gwSrc, "TOOL_PREP_MIN_GAP_MS") +
    constLine(gwSrc, "TOOL_PREP_MAX_CALLS") +
    ["streamReplayDelay", "streamReplaySleep", "synthesizeChunksFromStream", "chunkSeenKey"]
      .map((n) => fnBody(gwSrc, n))
      .join("\n") +
    "\n;globalThis.__syn = synthesizeChunksFromStream; globalThis.__key = chunkSeenKey; globalThis.__delay = streamReplayDelay;",
  sandbox,
  { filename: "gateway#stream-replay" },
);
const syn = sandbox.__syn;
const keyOf = sandbox.__key;
const delayOf = sandbox.__delay;

console.log("[1] assistant/message 的 stream → 与 assistant/chunk 同形的帧");
const payload = {
  turn: 2,
  step: 5,
  message: {
    role: "assistant",
    content: [
      { type: "reasoning", text: "abc" },
      { type: "text", text: "结论" },
    ],
  },
  usage: { inputTokens: 1, outputTokens: 2 },
  stream: [
    { type: "chunk", time: 1, chunk: { type: "block-start", index: 0, blockType: "reasoning" } },
    { type: "reasoning-chunks", index: 0, time0: 2, texts: ["a", "b", "c"], dt: [5, 7, 9] },
    { type: "chunk", time: 3, chunk: { type: "block-end", index: 0 } },
    { type: "chunk", time: 4, chunk: { type: "block-start", index: 1, blockType: "text" } },
    { type: "text-chunks", index: 1, time0: 5, texts: ["结", "论"], dt: [3, 4] },
    { type: "chunk", time: 6, chunk: { type: "block-end", index: 1 } },
    { type: "chunk", time: 7, chunk: { type: "usage", usage: { outputTokens: 2 } } },
    { type: "chunk", time: 8, chunk: { type: "finish", reason: "stop" } },
  ],
};
const frames = [];
const seen = new Set();
const n1 = syn(payload, (type, data) => frames.push({ type, data }), seen);
const kinds = frames.map((f) => f.type);
ok(n1 === 6, "还原出 6 条帧（得到 " + n1 + "）");
ok(
  kinds.join(",") === "reasoning,reasoning,reasoning,text,text,say-end",
  "帧序列 = reasoning×3 → text×2 → say-end（得到 " + kinds.join(",") + "）",
);

console.log("\n[2] 元数据与 say-end 判据");
const r0 = frames[0].data;
ok(r0.turn === 2 && r0.step === 5 && r0.index === 0, "reasoning 帧带 turn/step/index（" + JSON.stringify({ turn: r0.turn, step: r0.step, index: r0.index }) + "）");
ok(frames.filter((f) => f.type === "reasoning").map((f) => f.data.text).join("") === "abc", "reasoning 逐块文本原样相接（不插空格）");
ok(frames.filter((f) => f.type === "text").map((f) => f.data.text).join("") === "结论", "text 逐块文本原样相接");
const sayEnds = frames.filter((f) => f.type === "say-end");
ok(sayEnds.length === 1 && sayEnds[0].data.index === 1, "say-end 只对正文块发一次，index=1");
ok(
  frames.filter((f) => f.type === "reasoning").every((f) => f.data.index === 0),
  "思考帧的 index 是思考块序号（0），不会串到正文块",
);

console.log("\n[3] 边界：不双发 / 同一步多条消息 / 开关 / 缺 stream");
const frames2 = [];
const seen2 = new Set([keyOf(payload)]);
const n2 = syn(payload, (t, d) => frames2.push({ type: t }), seen2);
ok(!n2 && frames2.length === 0, "同一条消息重复到达 → 一帧都不合成（幂等）");
ok(keyOf({ turn: 3, step: 1 }) === "3:1:0:0:0", "幂等键含内容指纹（得到 " + keyOf({ turn: 3, step: 1 }) + "）");
/* 工具调用轮次的真实现场：同一个 (turn,step) 先后两条 assistant/message —— 第一条
   reasoning + tool-call（无正文），第二条 reasoning + 正文。只按 (turn,step) 记键会让
   第二条整段不发，正是「思考不显示」的复发形态。 */
const stepN = { turn: 7, step: 3 };
const msgA = Object.assign({}, stepN, {
  message: { content: [{ type: "reasoning", text: "先看工具" }, { type: "tool-call", id: "c1" }] },
  stream: [
    { type: "chunk", chunk: { type: "block-start", index: 0, blockType: "reasoning" } },
    { type: "reasoning-chunks", index: 0, texts: ["先看工具"], dt: [1] },
    { type: "chunk", chunk: { type: "block-start", index: 1, blockType: "tool-call" } },
    { type: "chunk", chunk: { type: "tool-call-delta", index: 1, id: "c1", name: "read", argumentsDelta: '{"p":1}' } },
    { type: "chunk", chunk: { type: "block-end", index: 1 } },
  ],
});
const msgB = Object.assign({}, stepN, {
  message: { content: [{ type: "reasoning", text: "看到结果了" }, { type: "text", text: "答案是 42" }] },
  stream: [
    { type: "chunk", chunk: { type: "block-start", index: 0, blockType: "reasoning" } },
    { type: "reasoning-chunks", index: 0, texts: ["看到结果了"], dt: [1] },
    { type: "chunk", chunk: { type: "block-start", index: 1, blockType: "text" } },
    { type: "text-chunks", index: 1, texts: ["答案是 42"], dt: [1] },
    { type: "chunk", chunk: { type: "block-end", index: 1 } },
  ],
});
ok(keyOf(msgA) !== keyOf(msgB), "同一步的两条不同消息 → 幂等键不同（" + keyOf(msgA) + " vs " + keyOf(msgB) + "）");
const seenStep = new Set();
const fa = [];
const fb = [];
const na = syn(msgA, (t, d) => fa.push({ type: t, data: d }), seenStep);
seenStep.add(keyOf(msgA));
const nb = syn(msgB, (t, d) => fb.push({ type: t, data: d }), seenStep);
ok(na > 0 && fa.some((f) => f.type === "reasoning"), "第一条（reasoning + tool-call）照常合成思考帧");
ok(
  nb > 0 && fb.some((f) => f.type === "reasoning") && fb.some((f) => f.type === "text") && fb.some((f) => f.type === "say-end"),
  "第二条（同 turn/step、reasoning + 正文）也合成完整帧（不再被第一条吃掉）",
);
ok(
  fa.some((f) => f.type === "tool-preparing"),
  "tool-call-delta → tool-preparing（与原生分支同一个限频器）",
);
const frames3 = [];
const n3 = syn({ turn: 1, step: 1, message: { content: [{ type: "text", text: "x" }] } }, (t) => frames3.push(t), new Set());
ok(!n3 && frames3.length === 0, "没有 stream 字段 → 不发增量（老网关行为不变）");
ok(delayOf() === 0, "默认 instant（0 延时），不在生成完之后再假装逐字");
sandbox.process.env.MTNODE_STREAM_REPLAY = "paced";
ok(delayOf() > 0, "paced 档给出正延时（得到 " + delayOf() + "）");
sandbox.process.env.MTNODE_STREAM_REPLAY = "off";
const frames4 = [];
const n4 = syn(payload, (t) => frames4.push(t), new Set());
ok(!n4 && frames4.length === 0, "MTNODE_STREAM_REPLAY=off → 整关（一帧不发）");
delete sandbox.process.env.MTNODE_STREAM_REPLAY;

console.log("\n[4] 接线口径（静态）");
ok(gwSrc.indexOf("case 'assistant/message'") >= 0, "mapNotification 有 assistant/message 分支");
const atMsg = gwSrc.indexOf("case 'assistant/message'");
const branch = gwSrc.slice(atMsg, atMsg + 900);
ok(branch.indexOf("synthesizeChunksFromStream(ev.data, emit, chunkSeen)") >= 0, "分支里调用了合成函数");
ok(/\bbreak\b/.test(branch), "分支用 break 收尾（用 return 会吞掉末尾的原始事件透传帧）");
ok(
  gwSrc.indexOf("chunkSeen.add(chunkSeenKey(ev.data))") >= 0,
  "原生 assistant/chunk 分支会登记 (turn,step)（跨版本不双发）",
);
ok(
  gwSrc.indexOf("emit('session-event', { type: ev.type, data: ev.data") >= 0,
  "原始事件透传帧仍在（session-event）",
);

console.log("\n[5] 段快照：不再整份丢思考段");
const dbSrc = read("renderer/app-db.js");
const atAttach = dbSrc.indexOf("function attachTraceSegments");
const attachBody = dbSrc.slice(atAttach, atAttach + 1200);
ok(attachBody.indexOf("_segNoBody") >= 0, "attachTraceSegments 打 _segNoBody 标（保留段快照）");
ok(
  /const hasThink[\s\S]{0,160}if \(!hasThink\) delete msg\.segments/.test(attachBody),
  "只有「段里没有思考」时才 delete msg.segments",
);
const asSrc = read("renderer/app-assist.js");
const atView = asSrc.indexOf("function dshMsgSegsViewable");
const viewBody = asSrc.slice(atView, atView + 500);
ok(viewBody.indexOf("m._segNoBody") >= 0, "dshMsgSegsViewable 认 _segNoBody（正文走 content）");
const atBlock = asSrc.indexOf("function dshMsgBlock");
const blockBody = asSrc.slice(atBlock, atBlock + 12000);
ok(
  /!segsView\s*\|\|\s*m\._segNoBody/.test(blockBody),
  "dshMsgBlock 对 _segNoBody 仍渲染整段思考块（不再什么都不显示）",
);

console.log("\n" + (fails ? "✗ " + fails + " 项失败" : "✓ " + checks + " 项全部通过") + "  (smoke-gateway-stream-replay)");
process.exit(fails ? 1 : 0);
