// 压缩帧（compaction）冒烟 · 任务 7/8
//   node dsh/smoke-compaction-frame.mjs
//
// 口径：网关把上游的 compaction/start · summary · end 三条通知转成专用帧
// compaction（见 gateway.mjs 的 mapNotification），渲染层只认这一种帧。
// 本冒烟不拉真运行时（那需要 key 且跑一次压缩），而是把 gateway.mjs 里**真实源码**
// 的 mapNotification 与它用到的关联表函数抠进 vm，按上游事件形状逐条喂进去，
// 断言帧字段：
//   · start / end 只带阶段（失败帧带 error，500 字截断）；
//   · summary 带摘要正文、被遮蔽条数 / token、provider/model、usage（数字清洗）、
//     以及按 shadowedSeqs 关联出来的工具清单（名称 + 结果）；
//   · 工具清单最多 20 条、每条结果 500 字截断（与落盘口径一致，防止帧撑爆桥）。
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";

let checks = 0;
let fails = 0;
function ok(cond, msg) {
  checks++;
  if (cond) console.log("  ok    " + msg);
  else {
    fails++;
    console.log("FAIL  " + msg);
  }
}
function eq(got, want, msg) {
  ok(
    JSON.stringify(got) === JSON.stringify(want),
    msg + " · 实测 " + JSON.stringify(got) + " / 期望 " + JSON.stringify(want),
  );
}

const GW = path.join(import.meta.dirname, "gateway", "gateway.mjs");
const SRC = readFileSync(GW, "utf8").replace(/\r\n/g, "\n");

/* 函数源码抽取（括号配对）：把真实函数搬进 vm，而不是照抄一份实现 */
function grabFn(src, name) {
  const re = new RegExp("^function\\s+" + name + "\\s*\\(", "m");
  const m = re.exec(src);
  if (!m) throw new Error("gateway.mjs 里找不到函数 " + name);
  let i = m.index + m[0].length;
  while (i < src.length && src[i] !== "{") i++;
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(m.index, i + 1);
    }
  }
  throw new Error("函数 " + name + " 括号不配对");
}
/* 模块级常量（单行）：从源码读，避免测试里另写一份数字 */
function declOf(src, name) {
  const re = new RegExp("^(?:const|let|var)\\s+" + name + "\\s*=\\s*([^;\\n]+?)\\s*;?\\s*$", "m");
  const m = re.exec(src);
  if (!m) throw new Error("gateway.mjs 里找不到常量 " + name);
  return m[1].trim();
}

console.log("\n[1] 常量口径（与落盘一致：20 条 / 每条 500 字）");
const TOOLS_MAX = Number(declOf(SRC, "COMPACTION_TOOLS_MAX"));
const TOOL_TEXT_MAX = Number(declOf(SRC, "COMPACTION_TOOL_TEXT_MAX"));
eq(TOOLS_MAX, 20, "工具清单上限 = 20 条");
eq(TOOL_TEXT_MAX, 500, "每条结果上限 = 500 字");

console.log("\n[2] 真跑 mapNotification（真实源码 + 假 emit）");
const ctx = {
  toolSeqIndex: new Map(),
  TOOL_SEQ_INDEX_MAX: Number(declOf(SRC, "TOOL_SEQ_INDEX_MAX")),
  COMPACTION_TOOLS_MAX: TOOLS_MAX,
  COMPACTION_TOOL_TEXT_MAX: TOOL_TEXT_MAX,
  console,
};
vm.createContext(ctx);
vm.runInContext(
  "var toolSeqIndex = new Map();" +
    "var TOOL_SEQ_INDEX_MAX = " + ctx.TOOL_SEQ_INDEX_MAX + ";" +
    "var COMPACTION_TOOLS_MAX = " + TOOLS_MAX + ";" +
    "var COMPACTION_TOOL_TEXT_MAX = " + TOOL_TEXT_MAX + ";",
  ctx,
);
for (const fn of [
  "contentBlocksText",
  "toolResultText",
  "compactionToolsOf",
  "toolSeqKey",
  "toolCallKey",
  "indexSetTool",
  "mapNotification",
])
  vm.runInContext(grabFn(SRC, fn), ctx);

const SID = "smoke-compact-s1";
const note = (event) => ({ method: "session.event", params: { sessionId: SID, event } });
function feed(list) {
  const body = list
    .map((n) => "mapNotification(" + JSON.stringify(n) + ", emit, { host: \"smoke\" });")
    .join("\n");
  return JSON.parse(
    vm.runInContext(
      "(function(){ var out = []; var emit = function(t, d){ out.push({ type: t, data: d }); };\n" +
        body +
        "\nreturn JSON.stringify(out); })()",
      ctx,
    ),
  );
}

/* ── 25 次工具调用：登记 seq → 名称，结果按 callId 补上 ─────────────────────── */
const calls = [note({ type: "compaction/start", data: {} })];
const names = [];
const longBody = "x".repeat(600);
for (let i = 1; i <= 25; i++) {
  const name = "tool_" + i;
  names.push(name);
  calls.push(note({ type: "tool/call", seq: i, data: { callId: "c" + i, name, arguments: { i } } }));
  calls.push(
    note({
      type: "tool/result",
      seq: i,
      data: {
        message: {
          content: [
            {
              type: "tool-result",
              toolCallId: "c" + i,
              content: [{ type: "text", text: "R" + i + ":" + longBody }],
            },
          ],
        },
      },
    }),
  );
}
const frames = feed(calls);
const startFrame = frames[0];
eq(startFrame.type, "compaction", "start 转成 compaction 帧（不是 session-event 透传）");
eq(
  Object.keys(startFrame.data).sort(),
  ["phase"],
  "start 帧只带阶段（不带统计）",
);
eq(startFrame.data.phase, "start", "start 帧 phase = start");

/* ── summary：摘要正文 + 统计 + usage + 关联清单 ───────────────────────────── */
const summaryNote = note({
  type: "compaction/summary",
  data: {
    summary: [{ type: "text", text: "摘要正文" }, { type: "text", text: "第二段" }],
    shadowedSeqs: names.map((_, i) => i + 1),
    shadowedTokenCount: 4321,
    provider: "deepseek",
    model: "deepseek-flash",
    usage: {
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: -5,
      reasoningTokens: "7",
    },
  },
});
const sum = feed([summaryNote])[0];
eq(sum.type, "compaction", "summary 转成 compaction 帧");
eq(sum.data.phase, "summary", "summary 帧 phase = summary");
eq(sum.data.text, "摘要正文\n第二段", "摘要正文按 content 块拼接（换行分隔）");
eq(sum.data.shadowedCount, 25, "被遮蔽条数 = shadowedSeqs 长度");
eq(sum.data.shadowedTokenCount, 4321, "被遮蔽 token 数透传");
eq([sum.data.provider, sum.data.model], ["deepseek", "deepseek-flash"], "provider / model 透传");
eq(
  sum.data.usage,
  { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, reasoningTokens: 7 },
  "usage 四格清洗：负数 / 数字串都归一成非负数字",
);
eq(sum.data.tools.length, 20, "关联工具清单最多 20 条（25 次调用只取前 20）");
eq(sum.data.tools[0].name, "tool_1", "清单按 shadowedSeqs 顺序命中（第一条）");
eq(sum.data.tools[19].name, "tool_20", "清单第 20 条是 tool_20");
ok(
  !sum.data.tools.some((t) => t.name === "tool_21"),
  "第 21 条起被上限截掉（不会撑大帧）",
);
eq(sum.data.tools[0].result.length, 500, "每条结果截到 500 字");
ok(
  sum.data.tools[0].result.startsWith("R1:xxx") && sum.data.tools[0].result.endsWith("xxx"),
  "结果内容是这条调用自己的（不是别条错位）",
);
eq(
  sum.data.tools[1].result,
  ("R2:" + longBody).slice(0, 500),
  "结果正文与 tool/result 原样对应（空白折叠后截断）",
);

/* 没登记过的 seq / 空 shadowedSeqs：清单为空、条数照实报 */
const emptySum = feed([
  note({
    type: "compaction/summary",
    data: { summary: [{ type: "text", text: "只有正文" }], shadowedSeqs: [999] },
  }),
])[0];
eq([emptySum.data.tools, emptySum.data.shadowedCount], [[], 1], "未登记过的 seq 不出清单，条数照实报");
eq(
  emptySum.data.usage,
  { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0 },
  "没有 usage 时给四格 0（帧形状稳定）",
);

/* ── 失败结果：失败前缀 + 错误文本，仍受 500 字上限 ─────────────────────────── */
const errFrames = feed([
  note({ type: "tool/call", seq: 30, data: { callId: "c30", name: "fail_tool" } }),
  note({
    type: "tool/result",
    seq: 30,
    data: {
      error: { reason: "boom" },
      message: {
        content: [
          { type: "tool-result", toolCallId: "c30", content: [{ type: "text", text: "detail" }] },
        ],
      },
    },
  }),
  note({ type: "compaction/summary", data: { summary: [{ type: "text", text: "s" }], shadowedSeqs: [30] } }),
]);
const errSum = errFrames.find((f) => f.data && f.data.phase === "summary");
eq(errSum.data.tools[0].name, "fail_tool", "失败调用同样进清单");
ok(errSum.data.tools[0].result.startsWith("失败：boom · detail"), "失败结果带「失败：原因」前缀");
ok(errSum.data.tools[0].result.length <= 500, "失败结果同样受 500 字上限");

/* 失败结果超长时截到 500（连同前缀一起） */
const longErr = feed([
  note({ type: "tool/call", seq: 31, data: { callId: "c31", name: "long_err" } }),
  note({
    type: "tool/result",
    seq: 31,
    data: { error: { reason: "e".repeat(520) }, message: { content: [] } },
  }),
  note({ type: "compaction/summary", data: { summary: [{ type: "text", text: "s" }], shadowedSeqs: [31] } }),
]).find((f) => f.data && f.data.phase === "summary");
eq(longErr.data.tools[0].result.length, 500, "失败文本也截到 500 字");

/* ── end：成功只收口；失败带 500 字内的错误 ─────────────────────────────────── */
const endOk = feed([note({ type: "compaction/end", data: {} })])[0];
eq(endOk, { type: "compaction", data: { phase: "end" } }, "成功的 end 只带 phase（不写 error 键）");
const endErr = feed([note({ type: "compaction/end", data: { error: "E".repeat(600) } })])[0];
eq(endErr.data.phase, "end", "失败的 end 仍是 end 阶段");
eq(endErr.data.error.length, 500, "错误文本截到 500 字");

console.log(
  "\n" + (fails ? "✗ " + fails + " / " + checks + " 项失败" : "✓ " + checks + " 项全部通过") +
    "  (smoke-compaction-frame)",
);
process.exit(fails ? 1 : 0);
