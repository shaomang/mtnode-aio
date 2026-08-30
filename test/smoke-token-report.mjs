/* Token 累计报告（会话末尾 Badge 的台账）冒烟测试
 * 只加载 renderer/app-agent.js 的纯记账函数，验证：
 *   1) 按模型分别累计（不同 provider|model 不串账）
 *   2) 运行中 usage 临时台账并入后不重复计
 *   3) 缓存命中率 = 缓存读 / 计费输入（未命中 + 读 + 写）
 *   4) 时间：LLM / 工具 / 墙钟 / 跨度 全部累计
 *   5) 旧结构（无 tokenReport）自动补全字段
 * 运行：node test/smoke-token-report.mjs
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = fs.readFileSync(path.join(ROOT, "renderer", "app-agent.js"), "utf8");

/* 极简 DOM 桩：够 tokBadgeEl 走完一遍结构 */
function fakeEl(tag) {
  const el = {
    tag,
    children: [],
    dataset: {},
    style: {},
    classList: { contains: () => false, add() {}, remove() {} },
    set className(v) {},
    get className() { return "" },
    textContent: "",
    title: "",
    open: false,
    hidden: false,
    appendChild(c) { this.children.push(c); return c },
    replaceChild(a, b) { const i = this.children.indexOf(b); if (i >= 0) this.children[i] = a; return b },
    addEventListener() {},
    remove() {},
    querySelector() { return null },
    querySelectorAll() { return [] },
    closest() { return null },
  };
  return el;
}

const ctx = {
  console,
  setTimeout,
  clearTimeout,
  Date,
  Math,
  Number,
  Object,
  Array,
  String,
  JSON,
  I18n: { t: (x) => String(x) },
  $: () => null,
  S: {},
  window: { api: null },
  document: {
    createElement: fakeEl,
    createTextNode: (s) => ({ textContent: s }),
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById: () => null,
  },
  toast: () => {},
  fmtDur: (ms) => Math.round((Number(ms) || 0) / 1000) + "s",
  fmtTok: (n) => String(Number(n) || 0),
  fmtTime: () => "00:00:00",
  navigator: {},
  agentSessions: () => [],
};
vm.createContext(ctx);
vm.runInContext(SRC, ctx, { filename: "app-agent.js" });

let fails = 0;
const ok = (cond, msg) => {
  console.log((cond ? "  ok   " : "  FAIL ") + msg);
  if (!cond) fails++;
};
const near = (a, b, msg) => ok(Math.abs((a || 0) - (b || 0)) < 1e-6, msg + " (" + a + " vs " + b + ")");

/* ── 1. 两轮运行、三个模型，检查逐模型累计 ───────────────────── */
const st = { id: "as1", title: "t", messages: [] };

/* 运行中先有一条 usage 实时事件（模型 A） */
ctx.tokLiveAdd(st, {
  provider: "deepseek",
  model: "deepseek-v4-pro",
  inputTokens: 1000,
  outputTokens: 50,
  cacheReadTokens: 8000,
  cacheWriteTokens: 0,
  reasoningTokens: 10,
});
ok(st._tokLive && st._tokLive["deepseek|deepseek-v4-pro"], "usage 事件进入按模型的临时台账");

ctx.tokMergeRun(
  st,
  {
    turns: 3,
    steps: 12,
    llmMs: 40000,
    toolMs: 6000,
    wallMs: 60000,
    startedAt: 1_000_000,
    endedAt: 1_060_000,
    contextWindow: 200000,
    inputTokens: 20000,
    outputTokens: 900,
    cacheReadTokens: 160000,
    cacheWriteTokens: 0,
    reasoningTokens: 200,
    models: [
      {
        provider: "deepseek",
        model: "deepseek-v4-pro",
        inputTokens: 18000,
        outputTokens: 700,
        cacheReadTokens: 150000,
        cacheWriteTokens: 0,
        reasoningTokens: 200,
        calls: 6,
        steps: 8,
        llmMs: 32000,
        toolMs: 5000,
      },
      {
        provider: "mtnode_openrouter",
        model: "vision-model",
        inputTokens: 2000,
        outputTokens: 200,
        cacheReadTokens: 10000,
        cacheWriteTokens: 500,
        reasoningTokens: 0,
        calls: 2,
        steps: 4,
        llmMs: 8000,
        toolMs: 1000,
      },
    ],
  },
  { startedAt: 1_000_000 },
);

let t = ctx.tokViewTotals(st);
const A = st.tokenReport.byModel["deepseek|deepseek-v4-pro"];
const B = st.tokenReport.byModel["mtnode_openrouter|vision-model"];
ok(!!A && !!B, "两个模型各自成账，未互相吞并");
near(A.inputTokens, 18000, "模型 A 未命中输入");
near(A.cacheReadTokens, 150000, "模型 A 缓存读");
near(B.cacheWriteTokens, 500, "模型 B 缓存写");
ok(st._tokLive === null, "运行结束后临时台账清空（不重复计）");
near(t.models, 2, "合计覆盖 2 个模型");
near(t.rounds, 1, "累计 1 轮运行");
near(t.wallMs, 60000, "墙钟累计 60s");
near(t.llmMs, 40000, "LLM 时间累计 40s");
near(t.toolMs, 6000, "工具时间累计 6s");
near(t.billedInput, 20000 + 160000 + 500, "计费输入 = 未命中 + 缓存读 + 缓存写");
near(t.cacheHitPct, ((160000 + 0) / (20000 + 160000 + 500)) * 100, "缓存命中率按累计口径");

/* ── 2. 第二轮（无 models 明细，退回临时台账）───────────────── */
ctx.tokLiveAdd(st, {
  provider: "deepseek",
  model: "deepseek-v4-flash",
  inputTokens: 500,
  outputTokens: 25,
  cacheReadTokens: 1000,
});
ctx.tokMergeRun(
  st,
  { turns: 1, steps: 2, llmMs: 3000, toolMs: 100, wallMs: 5000, startedAt: 2_000_000, endedAt: 2_005_000 },
  { startedAt: 2_000_000 },
);
t = ctx.tokViewTotals(st);
const C = st.tokenReport.byModel["deepseek|deepseek-v4-flash"];
ok(!!C, "缺 models 明细时用临时台账入账（旧网关兼容）");
near(C.inputTokens, 500, "回退台账输入 token");
near(t.rounds, 2, "累计 2 轮运行");
near(t.wallMs, 65000, "墙钟累计 65s");
near(st.tokenReport.lastAt - st.tokenReport.startedAt, 1_005_000, "跨度 = 最近 - 起始");
ok(t.totalTokens === t.billedInput + t.outputTokens, "总量 = 计费输入 + 输出");

/* ── 3. 摘要文本 / 报告文本可用 ───────────────────────────── */
const sum = ctx.tokBadgeSummary(st.tokenReport, t, false);
ok(/Σ/.test(sum) && /缓存命中/.test(sum) && /模型/.test(sum), "摘要含总量 / 命中率 / 模型数：" + sum);
const plain = ctx.tokReportPlain(st);
ok(plain.includes("deepseek-v4-pro") && plain.includes("vision-model"), "纯文本报告含全部模型");

/* ── 4. 旧结构补字段 ─────────────────────────────────────── */
const legacy = { id: "as2", tokenReport: { rounds: 4 } };
const r2 = ctx.tokReportEnsure(legacy);
ok(r2.byModel && r2.v === 1 && r2.rounds === 4, "缺字段的旧台账自动补全且不丢已有值");

/* ── 5. Badge 结构：表头 + 每个模型一行 + 合计行；折叠行含摘要 ── */
const badge = ctx.tokBadgeEl(st);
ok(!!badge && badge.tag === "details", "Badge 是可点击展开的 details");
const body = badge && badge.children[1];
const table = body && body.children[0];
const rows = table ? table.children.length : 0;
ok(rows === 1 + 3 + 1, "明细表 = 表头 + 3 个模型 + 合计（实得 " + rows + " 行）");
ok(
  !!(body && body.children[1] && /墙钟/.test(body.children[1].textContent || "")),
  "展开区含时间统计",
);
ok(
  badge && badge.children[0].children.some((c) => /Σ/.test(c.textContent || "")),
  "折叠态一行摘要含总量",
);
ok(badge && badge.dataset.tokOwner === "as1", "Badge 带宿主会话 id（局部刷新用）");

console.log(fails ? "\n✗ " + fails + " 项失败" : "\n✓ 全部通过");
process.exit(fails ? 1 : 0);
