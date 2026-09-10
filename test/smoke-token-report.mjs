/* Token 累计报告（会话末尾 Badge 的台账）冒烟测试
 * 加载 renderer/app-cost.js + renderer/app-agent.js 的纯函数，验证：
 *   1) 按模型分别累计（不同 provider|model 不串账）
 *   2) 运行中 usage 临时台账并入后不重复计
 *   3) 缓存命中率 = 缓存读 / 计费输入（未命中 + 读 + 写）
 *   4) 时间：LLM / 工具 / 墙钟 / 跨度 全部累计
 *   5) 旧结构（无 tokenReport）自动补全字段
 *   6) 费用：命中/未命中/输出分别计价、多模型汇总、未知单价不计费、摘要含 ¥
 *   7) 未知 DeepSeek 模型按 flash 兜底；峰谷：桶带时刻按北京时间判，空闲半价
 *   8) 逐模型性能字段（TTFT / 输出吞吐 / Prefill）：累计与回退并入、老台账补 0、
 *      tokPerfOf 实测 / 推算 / 无样本三种口径、模型行可点击 + 下钻弹窗
 *   9) 按会话轮次细分：轮次入账与倒序视图、同 rid 幂等、老台账空视图、
 *      标题三级回退、在途轮、Badge 轮次区与下钻弹窗
 * 运行：node test/smoke-token-report.mjs
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = fs.readFileSync(path.join(ROOT, "renderer", "app-agent.js"), "utf8");
const COST_SRC = fs.readFileSync(path.join(ROOT, "renderer", "app-cost.js"), "utf8");

/* 极简 DOM 桩：够 tokBadgeEl 走完一遍结构 */
function fakeEl(tag) {
  let cls = "";
  const el = {
    tag,
    children: [],
    dataset: {},
    style: {},
    attrs: {},
    listeners: {},
    classList: { contains: () => false, add() {}, remove() {} },
    set className(v) { cls = v },
    get className() { return cls },
    setAttribute(k, v) { this.attrs[k] = String(v) },
    getAttribute(k) { return this.attrs[k] },
    textContent: "",
    title: "",
    tabIndex: -1,
    open: false,
    hidden: false,
    appendChild(c) { this.children.push(c); return c },
    replaceChild(a, b) { const i = this.children.indexOf(b); if (i >= 0) this.children[i] = a; return b },
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn) },
    remove() {},
    querySelector() { return null },
    querySelectorAll() { return [] },
    closest() { return null },
  };
  return el;
}

/* 弹窗宿主桩：openModelPerfDialog 往 #ovBody / #ovFoot 里写内容 */
const ovBody = fakeEl("div");
const ovFoot = fakeEl("div");

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
  $: (sel) => (sel === "#ovBody" ? ovBody : sel === "#ovFoot" ? ovFoot : null),
  openOverlay: () => {},
  closeOverlay: () => {},
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
/* 费用 / 余额模块先加载：app-agent.js 里的 tokCost* / balanceChip 全是 typeof 可选调用 */
vm.runInContext(COST_SRC, ctx, { filename: "app-cost.js" });
vm.runInContext(SRC, ctx, { filename: "app-agent.js" });

let fails = 0;
const ok = (cond, msg) => {
  console.log((cond ? "  ok   " : "  FAIL ") + msg);
  if (!cond) fails++;
};
const near = (a, b, msg) => ok(Math.abs((a || 0) - (b || 0)) < 1e-6, msg + " (" + a + " vs " + b + ")");
/* 桩 DOM 结构查询：Badge 展开区里新增了「按模型 · 合计」小标题与「按轮次」区，
 * 明细表 / 时间行的下标不再稳定，故按类名查找（断言口径不变，只是不再依赖位置）。 */
function eachEl(root, fn) {
  for (const c of (root && root.children) || []) {
    fn(c);
    eachEl(c, fn);
  }
}
function findEl(root, pred) {
  let hit = null;
  eachEl(root, (c) => {
    if (!hit && pred(c)) hit = c;
  });
  return hit;
}
function findAll(root, pred) {
  const out = [];
  eachEl(root, (c) => {
    if (pred(c)) out.push(c);
  });
  return out;
}

/* ── 1. 两轮运行、三个模型，检查逐模型累计 ───────────────────── */
/* 时间戳整体平移到「北京时间周一上午 10 点」（高峰时段），让第 6 节的费用
 * 断言不受峰谷折扣影响（时段判定见第 7 节）。 */
const T0 = Date.UTC(2026, 0, 5, 2, 0, 0);
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
    startedAt: T0 + 1_000_000,
    endedAt: T0 + 1_060_000,
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
  { startedAt: T0 + 1_000_000 },
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
  { turns: 1, steps: 2, llmMs: 3000, toolMs: 100, wallMs: 5000, startedAt: T0 + 2_000_000, endedAt: T0 + 2_005_000 },
  { startedAt: T0 + 2_000_000 },
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
const table = findEl(body, (c) => c.tag === "table" && /tok-badge-table/.test(c.className || "") && !/tok-round-table/.test(c.className || ""));
const rows = table ? table.children.length : 0;
ok(rows === 1 + 3 + 1, "明细表 = 表头 + 3 个模型 + 合计（实得 " + rows + " 行）");
const metaRow = findEl(body, (c) => /tok-badge-meta/.test(c.className || ""));
ok(!!(metaRow && /墙钟/.test(metaRow.textContent || "")), "展开区含时间统计");
ok(
  badge && badge.children[0].children.some((c) => /Σ/.test(c.textContent || "")),
  "折叠态一行摘要含总量",
);
ok(badge && badge.dataset.tokOwner === "as1", "Badge 带宿主会话 id（局部刷新用）");
/* 5b. 展开区底部不再重复余额：余额只在折叠行右端 chip 显示一次 */
ok(
  !!body && body.children[body.children.length - 1] === metaRow &&
    findAll(body, (c) => /tok-badge-meta/.test(c.className || "")).length === 1,
  "展开区只有一处时间行且在末尾（不再追加余额行）",
);
ok(
  findAll(body, (c) => /余额/.test(String(c.textContent || ""))).length === 0,
  "展开区不含余额文本（余额只在折叠行 chip）",
);
const badgeSrc = SRC.slice(SRC.indexOf("function tokBadgeEl"), SRC.indexOf("function tokBadgeHost"));
ok(!/balanceLine\(\)/.test(badgeSrc), "tokBadgeEl 不再调用 balanceLine()（底部余额行已移除）");
ok(/balanceChip\(\)/.test(badgeSrc), "折叠行仍保留余额 chip（balanceChip）");

/* ── 6. 费用：单价、汇总、未知单价不计费、摘要含 ¥ ────────────── */
/* 6a. 命中 / 未命中 / 输出 分别计价（1M token 便于看单价） */
const bucketCost = (model, bucket, provider) =>
  ctx.costOfBucket(provider === undefined ? "deepseek" : provider, model, bucket);
near(bucketCost("deepseek-v4-pro", { cacheReadTokens: 1e6 }).amount, 0.3, "缓存命中 1M 按 v4-pro ¥0.3/1M");
near(bucketCost("deepseek-v4-pro", { inputTokens: 1e6 }).amount, 9.0, "未命中 1M 按 v4-pro ¥9/1M");
near(bucketCost("deepseek-v4-pro", { outputTokens: 1e6 }).amount, 27.0, "输出 1M 按 v4-pro ¥27/1M");
near(bucketCost("deepseek-v4-pro", { cacheWriteTokens: 1e6 }).amount, 9.0, "缓存写计入未命中单价");
near(bucketCost("deepseek-v4-flash", { inputTokens: 1e6 }).amount, 3.0, "v4-flash 未命中 1M = ¥3");
ok(bucketCost("gpt-4o", { inputTokens: 1e6 }) === null, "未知模型单价 → 不计费（null）");
ok(
  bucketCost("deepseek-v4-pro", { inputTokens: 1e6 }, "mtnode_openrouter") === null,
  "非官方路由 → 不计费（null）",
);
near(
  bucketCost("deepseek-v4-pro", { inputTokens: 1e6 }, { baseUrl: "https://api.deepseek.com/v1" }).amount,
  9.0,
  "baseUrl 含 deepseek 的对象也算官方路由",
);
ok(ctx.fmtMoney(0.227725) === "¥0.23", "fmtMoney 统一两位小数：" + ctx.fmtMoney(0.227725));

/* 6b. 多模型汇总：v4-pro 一笔 + v4-flash 一笔，非官方模型不计入 */
const totalCost = ctx.costOfOwner(st);
ok(!!totalCost, "官方路由台账能算出总费用");
near(totalCost.amount, 0.2259 + 0.001825, "总费用 = 两个官方模型各自计价之和");
ok(totalCost.currency === "CNY", "费用币种为 CNY");

/* 6c. 未知单价不计费：只含非官方模型的服务台账 → null */
const foreign = {
  tokenReport: {
    byModel: {
      "mtnode_openrouter|vision-model": { provider: "mtnode_openrouter", model: "vision-model", inputTokens: 900, outputTokens: 90 },
    },
  },
};
ok(ctx.costOfOwner(foreign) === null, "全是未知单价模型时总费用为 null（不猜价）");

/* 6d. 摘要 / 报告 / 明细表带费用 */
const sumCost = ctx.tokBadgeSummary(st.tokenReport, t, false, st);
ok(sumCost.includes("¥"), "摘要含 ¥ 费用：" + sumCost);
ok(ctx.tokBadgeSummary(st.tokenReport, t, false).indexOf("¥") < 0, "不传 owner 时摘要不追加费用（旧断言兼容）");
const plainCost = ctx.tokReportPlain(st);
ok(plainCost.includes("费用") && plainCost.includes("¥"), "纯文本报告含费用行");
const totalRow = findEl(table, (c) => /tok-badge-total/.test(c.className || ""));
ok(!!totalRow && /^¥/.test(totalRow.children[9].textContent || ""), "明细表合计行费用列 = " + (totalRow && totalRow.children[9].textContent));
ok(!!totalRow && totalRow.children[9].tag === "td", "合计行第 10 格是费用单元格（带 tok-badge-cost 类）");

/* ── 7. 未知 DeepSeek 模型按 flash 兜底 + 峰谷价（按北京时间）──────
 * 表内数值 = 高峰价；空闲（工作日 12:00-14:00 / 18:00-次日 9:00、周末）半价。
 * 桶带 at 才判峰谷——旧台账没时刻一律按高峰，不做无依据的折扣。 */
const T_PEAK = Date.UTC(2026, 0, 5, 2, 0, 0); /* 周一 10:00 北京 → 高峰 */
const T_OFF = Date.UTC(2026, 0, 5, 12, 0, 0); /* 周一 20:00 北京 → 空闲 */
const T_WEEKEND = Date.UTC(2026, 0, 10, 2, 0, 0); /* 周六 10:00 北京 → 空闲 */

/* 7a. 未知 DeepSeek 模型 → flash 价（estimated 标记），不再返回 null */
const unk = bucketCost("deepseek-v5", { inputTokens: 1e6 });
near(unk.amount, 3.0, "未知 deepseek 模型未命中 1M 按 flash ¥3 兜底");
ok(unk.estimated === true, "兜底价带 estimated 标记");
ok(unk.offPeak === false, "无时刻信息按高峰（estimated 兜底也是高峰价）");
near(bucketCost("deepseek-chat", { outputTokens: 1e6 }).amount, 9.0, "deepseek-chat 输出 1M 按 flash ¥9");
ok(bucketCost("gpt-4o", { inputTokens: 1e6 }) === null, "非 DeepSeek 未知模型仍不猜价（null）");

/* 7b. 峰谷：同样 token，高峰全价 / 空闲半价 */
near(bucketCost("deepseek-v4-pro", { inputTokens: 1e6, at: T_PEAK }).amount, 9.0, "高峰时段全价 ¥9");
const off = bucketCost("deepseek-v4-pro", { inputTokens: 1e6, at: T_OFF });
near(off.amount, 4.5, "空闲时段半价 ¥4.5");
ok(off.offPeak === true, "空闲桶带 offPeak 标记");
near(bucketCost("deepseek-v4-flash", { outputTokens: 1e6, at: T_OFF }).amount, 4.5, "flash 输出空闲半价");
near(bucketCost("deepseek-v4-pro", { cacheReadTokens: 1e6, at: T_WEEKEND }).amount, 0.15, "周末缓存命中半价");
near(
  ctx.costOfBucket({ baseUrl: "https://api.deepseek.com/v1" }, "deepseek-v4-pro", { inputTokens: 1e6 }, T_OFF).amount,
  4.5,
  "第 4 参 atFallback（台账 lastAt）也参与峰谷判定",
);

/* 7c. 老台账（桶无 at）用台账 lastAt 兜底判峰谷；新台账桶自带 at */
const offOwner = {
  tokenReport: {
    lastAt: T_OFF,
    byModel: {
      "deepseek|deepseek-v4-pro": { provider: "deepseek", model: "deepseek-v4-pro", inputTokens: 1e6, outputTokens: 0 },
    },
  },
};
near(ctx.costOfOwner(offOwner).amount, 4.5, "老台账按 lastAt 判空闲 → 半价");
const peakOwner = JSON.parse(JSON.stringify(offOwner));
peakOwner.tokenReport.lastAt = T_PEAK;
peakOwner.tokenReport.byModel["deepseek|deepseek-v4-pro"].at = T_PEAK;
near(ctx.costOfOwner(peakOwner).amount, 9.0, "桶自带高峰时刻 → 全价");
ok(
  ctx.costOfOwner(foreign) === null,
  "兜底只认 DeepSeek：全是非官方模型时仍为 null",
);

/* ── 8. 逐模型性能字段（TTFT / 输出吞吐 / Prefill）与下钻入口 ──────
 * 采集口径见 dsh/gateway/gateway.mjs 的 modelBucket()（ttftMs / ttftSamples /
 * prefillTokens / genMs，additive），本节点只验证渲染层台账与口径计算。 */

/* 8a. 逐模型字段随台账持久化：带 models 明细入账 + 回退临时台账入账 */
const pf = { id: "as3", title: "perf", messages: [] };
ctx.tokLiveAdd(pf, {
  provider: "deepseek",
  model: "deepseek-v4-pro",
  inputTokens: 100,
  outputTokens: 10,
  ttftMs: 400,
  ttftSamples: 1,
  prefillTokens: 1000,
  genMs: 600,
});
const liveB = pf._tokLive["deepseek|deepseek-v4-pro"];
ok(
  !!liveB && liveB.ttftMs === 400 && liveB.ttftSamples === 1 && liveB.prefillTokens === 1000 && liveB.genMs === 600,
  "在途临时台账累计 4 个性能字段",
);
ctx.tokMergeRun(
  pf,
  {
    turns: 1,
    steps: 2,
    llmMs: 2000,
    toolMs: 0,
    wallMs: 3000,
    startedAt: T0,
    endedAt: T0 + 3000,
    models: [
      {
        provider: "deepseek",
        model: "deepseek-v4-pro",
        inputTokens: 900,
        outputTokens: 90,
        cacheReadTokens: 100,
        cacheWriteTokens: 0,
        calls: 3,
        steps: 3,
        llmMs: 1600,
        toolMs: 0,
        ttftMs: 800,
        ttftSamples: 2,
        prefillTokens: 2000,
        genMs: 1200,
      },
    ],
  },
  { startedAt: T0 },
);
const P = pf.tokenReport.byModel["deepseek|deepseek-v4-pro"];
near(P.ttftMs, 800, "带明细入账：逐模型 TTFT 累计");
near(P.ttftSamples, 2, "带明细入账：TTFT 样本数");
near(P.prefillTokens, 2000, "带明细入账：Prefill 计数（计费输入）");
near(P.genMs, 1200, "带明细入账：纯生成时间");
ok(typeof P.genMs === "number" && typeof P.prefillTokens === "number", "性能字段随 tokenReport 持久化（进持久化对象本体）");
/* 第二轮没有 models 明细 → 退回临时台账并入，性能字段同样累加 */
ctx.tokLiveAdd(pf, {
  provider: "deepseek",
  model: "deepseek-v4-pro",
  outputTokens: 100,
  ttftMs: 600,
  ttftSamples: 1,
  prefillTokens: 500,
  genMs: 900,
});
ctx.tokMergeRun(
  pf,
  { turns: 1, steps: 1, llmMs: 1500, toolMs: 0, wallMs: 2000, startedAt: T0 + 1_000_000, endedAt: T0 + 1_002_000 },
  { startedAt: T0 + 1_000_000 },
);
near(P.ttftMs, 1400, "回退临时台账时 TTFT 并入累计");
near(P.ttftSamples, 3, "回退临时台账时样本数并入累计");
near(P.prefillTokens, 2500, "回退临时台账时 Prefill 并入累计");
near(P.genMs, 2100, "回退临时台账时纯生成时间并入累计");

/* 8b. 老台账（缺性能字段）经 tokViewModels 补 0，不产生 NaN */
const legacyPerf = {
  id: "as4",
  tokenReport: {
    byModel: {
      "deepseek|deepseek-v4-pro": { provider: "deepseek", model: "deepseek-v4-pro", inputTokens: 10, outputTokens: 5, llmMs: 1000, calls: 2 },
    },
  },
};
const lv = ctx.tokViewModels(legacyPerf)[0];
ok(
  lv.ttftMs === 0 && lv.ttftSamples === 0 && lv.prefillTokens === 0 && lv.genMs === 0,
  "老台账缺性能字段 → tokViewModels 补 0（不炸、不 NaN）",
);

/* 8c. tokPerfOf：实测 / 推算 / 无样本三种口径 + 除零守住 */
const pm = ctx.tokPerfOf({
  ttftMs: 600,
  ttftSamples: 3,
  genMs: 3000,
  outputTokens: 300,
  calls: 3,
  llmMs: 3600,
  inputTokens: 1000,
  cacheReadTokens: 100,
  cacheWriteTokens: 0,
});
near(pm.ttftAvgMs, 200, "TTFT 均值 = 累计 / 样本数");
ok(pm.ttftSource === "measured", "TTFT 有样本 → measured");
near(pm.outTokPerSec, 100, "输出吞吐 = 输出 token / 纯生成时间");
near(pm.tpotMs, 10, "TPOT = 纯生成时间 / 输出 token");
ok(pm.outSource === "measured", "有 genMs → 输出吞吐 measured");
near(pm.e2eAvgMs, 1200, "端到端单次均值 = LLM 用时 / 调用次数");
near(pm.e2eTotalMs, 3600, "端到端累计 = LLM 用时累计");
near(pm.prefillTokPerSec, 1100 / 0.6, "缺 prefillTokens → 用计费输入估算 Prefill");
ok(pm.prefillSource === "estimated", "估算 Prefill 标 estimated");

const pe = ctx.tokPerfOf({ llmMs: 3000, outputTokens: 300, calls: 3, ttftMs: 0, ttftSamples: 0 });
ok(pe.ttftAvgMs === null && pe.ttftSource === "none", "无 TTFT 样本 → 显示 —（none）");
ok(pe.outSource === "estimated", "缺 genMs → 输出吞吐用 llmMs 推算（estimated）");
near(pe.outTokPerSec, 100, "推算吞吐 = 300 token / 3s");
ok(pe.prefillTokPerSec === null && pe.prefillSource === "none", "无 TTFT → Prefill 无法推算（none）");

const pn = ctx.tokPerfOf({});
ok(
  pn.ttftAvgMs === null && pn.outTokPerSec === null && pn.tpotMs === null && pn.e2eAvgMs === null && pn.prefillTokPerSec === null,
  "空桶（老台账）全部指标显示 —",
);
const pz = ctx.tokPerfOf({ llmMs: 1000, calls: 0, outputTokens: 0 });
ok(pz.outTokPerSec === null && pz.tpotMs === null, "输出 token 为 0 → 吞吐 / TPOT 不除零（null）");
ok(pz.e2eAvgMs === null && pz.e2eTotalMs === 1000, "调用次数为 0 → 单次均值 null、累计仍在");
ok(
  [pm, pe, pn, pz].every((v) => Object.values(v).every((x) => x == null || typeof x !== "number" || Number.isFinite(x))),
  "四种口径都不产生 NaN / Infinity",
);

/* 8d. 性能摘要行：缺样本 —、推算值 ≈ */
const perfLine = ctx.tokPerfLine({ llmMs: 5000, outputTokens: 100, calls: 1 });
ok(/TTFT —/.test(perfLine), "老台账摘要 TTFT 显示 —：" + perfLine);
ok(perfLine.includes("≈"), "推算吞吐前加 ≈ 标记：" + perfLine);
ok(/TTFT/.test(plainCost) && /TPOT/.test(plainCost), "纯文本报告每模型行含性能摘要（TTFT / TPOT）");

/* 8e. 下钻入口：模型行可点击 + 弹窗函数存在 */
ok(typeof ctx.openModelPerfDialog === "function", "存在 openModelPerfDialog 下钻弹窗函数");
const modelRows = [];
(function walk(el) {
  for (const c of el.children || []) {
    if (c && c.tag === "tr" && c.className === "tok-model-row") modelRows.push(c);
    walk(c);
  }
})(badge);
ok(modelRows.length === 3, "每个模型明细行都挂 tok-model-row（实得 " + modelRows.length + " 行）");
const mr0 = modelRows[0];
ok(!!mr0 && mr0.attrs.role === "button", "模型行带 role=button（可点击语义）");
ok(!!mr0 && mr0.tabIndex === 0, "模型行可聚焦（键盘可达）");
ok(!!mr0 && (mr0.listeners.click || []).length === 1, "模型行绑定 click 打开下钻弹窗");
ok(!!mr0 && (mr0.listeners.keydown || []).length === 1, "模型行绑定 keydown（Enter / 空格）");
ok(!!mr0 && !!mr0.title, "模型行带「点击查看性能指标」提示");

/* 8f. 弹窗内容：逐项指标 + 推算标注 + 口径脚注 */
ovBody.children.length = 0;
ovFoot.children.length = 0;
ctx.openModelPerfDialog(pf, P);
const dlgTable = ovBody.children[0];
ok(!!dlgTable && /model-perf-table/.test(dlgTable.className), "弹窗渲染性能表（复用 tok-badge-table 体系）");
const kv = {};
for (const row of (dlgTable && dlgTable.children) || []) kv[row.children[0].textContent] = row.children[1].textContent;
ok(/ms$/.test(kv["首 Token 延迟 (TTFT)"] || ""), "弹窗列出首 Token 延迟(TTFT)：" + kv["首 Token 延迟 (TTFT)"] + "（1400ms/3 样本）");
ok(!!kv["输出吞吐"] && /tok\/s/.test(kv["输出吞吐"]), "弹窗列出输出吞吐：" + kv["输出吞吐"]);
ok(!!kv["每输出 Token 耗时 (TPOT)"], "弹窗列出 TPOT：" + kv["每输出 Token 耗时 (TPOT)"]);
ok(!!kv["端到端延迟 · 单次均值"] && !!kv["端到端延迟 · 累计"], "弹窗列出端到端（单次均值 / 累计）");
ok(!!kv["预处理吞吐 (Prefill)"], "弹窗列出预处理吞吐：" + kv["预处理吞吐 (Prefill)"]);
ok(kv["TTFT 样本数"] === "3" && kv["调用次数"] === "4", "弹窗列出样本数与调用次数");
ok(!!kv["费用"] && /¥/.test(kv["费用"]), "弹窗列出费用：" + kv["费用"]);
ok(
  !ovBody.children.some((c) => /model-perf-note/.test((c && c.className) || "")),
  "弹窗不再显示口径脚注（按需求移除）",
);
ok(ovFoot.children.length > 0, "弹窗带关闭按钮");

ovBody.children.length = 0;
ctx.openModelPerfDialog(null, { provider: "deepseek", model: "deepseek-v4-flash", llmMs: 2000, outputTokens: 100, calls: 1 });
const kv2 = {};
for (const row of (ovBody.children[0] && ovBody.children[0].children) || []) kv2[row.children[0].textContent] = row.children[1].textContent;
ok(kv2["首 Token 延迟 (TTFT)"] === "—", "无样本指标在弹窗显示 —");
ok(/\(推算\)/.test(kv2["输出吞吐"] || ""), "推算值在弹窗带「(推算)」标注：" + kv2["输出吞吐"]);
ok(!!kv2["费用"], "owner 为空的本次运行桶也能算费用（atFallback 口径）：" + kv2["费用"]);

/* ── 9. 按会话轮次的细分统计（轮次入账 / 标题回退 / 在途轮 / Badge 下钻）────
 * 一轮 = 一次运行的入账（tokRoundRec 记的一条，byModel 即该轮逐模型明细）；
 * 合计（tokViewTotals / tokViewModels）口径未动，本区只是 additive 的细分。 */

/* 9a. 两轮入账：roundList 长度、倒序视图、逐轮 byModel 之和 = 合计 */
const rd = { id: "as9", title: "rounds", messages: [] };
const roundMetrics = (model, billed, out, turns, steps, t0) => ({
  turns: turns,
  steps: steps,
  llmMs: 2000,
  toolMs: 100,
  wallMs: 3000,
  startedAt: t0,
  endedAt: t0 + 3000,
  models: [
    {
      provider: "deepseek",
      model: model,
      inputTokens: billed,
      outputTokens: out,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      calls: 1,
      steps: steps,
      llmMs: 2000,
      toolMs: 100,
      ttftMs: 400,
      ttftSamples: 1,
      genMs: 1600,
      prefillTokens: billed,
    },
  ],
});
ctx.tokMergeRun(rd, roundMetrics("deepseek-v4-pro", 100, 10, 1, 2, T0), {
  runKey: "agent:as9",
  title: "第一轮",
  titleFrom: "plan",
});
ctx.tokMergeRun(rd, roundMetrics("deepseek-v4-flash", 200, 20, 2, 4, T0 + 10_000), {
  runKey: "agent:as9",
  title: "第二轮",
  titleFrom: "input",
});
ok(
  Array.isArray(rd.tokenReport.roundList) && rd.tokenReport.roundList.length === 2,
  "两轮入账 → roundList 两条（实得 " + (rd.tokenReport.roundList || []).length + "）",
);
near(rd.tokenReport.roundSeq, 2, "roundSeq 与轮数同步");
const rv = ctx.tokViewRounds(rd);
near(rv.length, 2, "tokViewRounds 返回 2 轮");
ok(rv[0].title === "第二轮", "倒序视图：最新一轮在前（" + rv[0].title + "）");
ok(rv[1].title === "第一轮", "倒序视图：最早一轮在后（" + rv[1].title + "）");
ok(rv[0].live === false && rv[1].live === false, "已入账轮都标 live:false");
ok(rv[0].titleFrom === "input" && rv[1].titleFrom === "plan", "轮次保留标题来源标记");
ok(rv[0].rid !== rv[1].rid && /^agent:as9:/.test(rv[0].rid), "每轮 rid = runKey:endedAt 且互不相同");
const tt9 = ctx.tokViewTotals(rd);
let sumBilled9 = 0;
let sumOut9 = 0;
for (const rec of rv) {
  for (const k of Object.keys(rec.byModel)) {
    const b = rec.byModel[k];
    sumBilled9 += b.inputTokens + b.cacheReadTokens + b.cacheWriteTokens;
    sumOut9 += b.outputTokens;
  }
}
near(sumBilled9, tt9.billedInput, "逐轮 byModel 计费输入之和 = 合计计费输入");
near(sumOut9, tt9.outputTokens, "逐轮 byModel 输出之和 = 合计输出");
near(tt9.rounds, 2, "合计轮数口径不变（原有字段）");
near(tt9.totalTokens, tt9.billedInput + tt9.outputTokens, "合计总量口径不变");

/* 9b. 幂等：同 rid 重复收尾（429 重发 / 重复 done）不重复计轮 */
const rid1 = rd.tokenReport.roundList[0].rid;
ctx.tokMergeRun(rd, roundMetrics("deepseek-v4-pro", 100, 10, 1, 2, T0), {
  runKey: "agent:as9",
  title: "第一轮",
  titleFrom: "plan",
});
near(rd.tokenReport.roundList.length, 2, "同 rid 重复收尾 → roundList 不新增");
near(rd.tokenReport.roundSeq, 2, "同 rid 重复收尾 → roundSeq 不变");
ok(rd.tokenReport.roundList.some((x) => x.rid === rid1), "原轮次记录保留（幂等只跳过重复那条）");

/* 9c. 老台账（无 roundList）→ 轮次视图空数组，合计不受影响、不炸不 NaN */
const legacyRound = {
  id: "as10",
  tokenReport: {
    rounds: 4,
    llmMs: 5000,
    byModel: {
      "deepseek|deepseek-v4-pro": { provider: "deepseek", model: "deepseek-v4-pro", inputTokens: 700, outputTokens: 70, calls: 2, llmMs: 5000 },
    },
  },
};
const lrv = ctx.tokViewRounds(legacyRound);
ok(Array.isArray(lrv) && lrv.length === 0, "老台账无 roundList → 轮次视图为空数组（不炸）");
const ltt = ctx.tokViewTotals(legacyRound);
near(ltt.rounds, 4, "老台账合计轮数不受轮次视图影响");
near(ltt.billedInput, 700, "老台账合计 token 不受轮次视图影响");
ok(Number.isFinite(ltt.billedInput) && Number.isFinite(ltt.llmMs), "老台账轮次视图不产生 NaN");

/* 9d. 标题三级回退：计划标题 → 输入前 24 字 → 未命名轮次 */
const planT = ctx.tokRoundTitleOf("随便什么输入", { tokTitle: "实现登录接口" });
ok(planT.title === "实现登录接口" && planT.from === "plan", "有计划任务标题 → 优先取计划标题");
const inputT = ctx.tokRoundTitleOf("  帮我写一个   很长的需求说明用来验证标题会被截断到二十四个字符以内  ");
ok(inputT.from === "input" && inputT.title.length === 24, "无计划标题 → 取用户输入前 24 字：" + inputT.title);
ok(!/\n/.test(inputT.title) && !/\s{2}/.test(inputT.title), "标题内换行 / 连续空白已折叠为单空格");
ok(ctx.tokRoundTitle({ title: "" }) === "未命名轮次", "都没有 → 展示「未命名轮次」");
ok(
  ctx.tokRoundTitleFromLabel("plan") === "计划任务" &&
    ctx.tokRoundTitleFromLabel("input") === "用户输入" &&
    ctx.tokRoundTitleFromLabel("") === "",
  "标题来源标记：计划任务 / 用户输入 / 无",
);

/* 9e. tokRoundTitleOf 边界：空串 / 纯空白 / 超长 / 换行 / 块头噪声 / n 覆盖 */
const emptyT = ctx.tokRoundTitleOf("");
ok(emptyT.title === "" && emptyT.from === "", "空串 → 无标题无来源");
const blankT = ctx.tokRoundTitleOf("   \n\t  ");
ok(blankT.title === "" && blankT.from === "", "纯空白 → 无标题无来源");
const longT = ctx.tokRoundTitleOf("甲".repeat(100));
ok(longT.title.length === 24 && longT.title === "甲".repeat(24), "超长输入截断到 24 字");
const nlT = ctx.tokRoundTitleOf("第一行\n第二行\n第三行");
ok(nlT.title === "第一行 第二行 第三行", "换行折叠为空格：" + nlT.title);
const noiseT = ctx.tokRoundTitleOf("【系统设定】\n## 台账按轮次分桶\n细节");
ok(noiseT.title === "台账按轮次分桶 细节", "去掉【…】块头与 Markdown 标题符：" + noiseT.title);
const latestT = ctx.tokRoundTitleOf("历史对话……\n用户(最新)：把 Token 报告按轮次统计");
ok(latestT.title === "把 Token 报告按轮次统计", "会话拼串只取最后一段用户输入作标题");
const nT = ctx.tokRoundTitleOf("乙".repeat(50), { n: 30 });
ok(nT.title.length === 30, "n 参数可覆盖默认截断长度");
ok(ctx.tokRoundTitleOf(null).title === "" && ctx.tokRoundTitleOf(undefined).title === "", "null / undefined 输入不炸");
ok(ctx.tokRoundTitleOf("任务", { tokTitle: "   " }).from === "input", "计划标题只有空白 → 回退到用户输入");

/* 9f. 在途轮次：带 runKey 的 tokLiveAdd 进入轮次视图并标 live，收尾后被正式轮取代 */
const lvOwner = { id: "as11", title: "live", messages: [] };
ctx.tokLiveAdd(
  lvOwner,
  { provider: "deepseek", model: "deepseek-v4-flash", inputTokens: 50, outputTokens: 5 },
  { runKey: "node:n1", title: "进行中的轮次", titleFrom: "plan", startedAt: T0 + 50_000 },
);
const lvRounds = ctx.tokViewRounds(lvOwner);
near(lvRounds.length, 1, "在途轮出现在轮次视图");
ok(lvRounds[0].live === true, "在途轮标 live:true");
ok(lvRounds[0].title === "进行中的轮次" && lvRounds[0].titleFrom === "plan", "在途轮带标题与来源");
near(lvRounds[0].byModel["deepseek|deepseek-v4-flash"].inputTokens, 50, "在途轮含逐模型在途桶");
ctx.tokMergeRun(
  lvOwner,
  {
    turns: 1,
    steps: 1,
    llmMs: 900,
    toolMs: 0,
    wallMs: 1000,
    startedAt: T0 + 50_000,
    endedAt: T0 + 51_000,
    models: [
      { provider: "deepseek", model: "deepseek-v4-flash", inputTokens: 50, outputTokens: 5, calls: 1, steps: 1, llmMs: 900, toolMs: 0 },
    ],
  },
  { runKey: "node:n1", title: "进行中的轮次", titleFrom: "plan" },
);
const doneRounds = ctx.tokViewRounds(lvOwner);
near(doneRounds.length, 1, "收尾后在途轮被正式轮取代（不重复计一条）");
ok(doneRounds[0].live === false && /^node:n1:/.test(doneRounds[0].rid), "正式轮带 rid 且不再标 live");
ok(
  !lvOwner._tokLiveRound || !lvOwner._tokLiveRound["node:n1"],
  "收尾后清掉本轮在途条目（其余并行轮不受影响）",
);

/* 9g. Badge「按轮次」区：表格 + 可点击行 + 下钻函数 + 合计段保留 + 文本导出 */
const badge9 = ctx.tokBadgeEl(rd);
ok(!!badge9 && badge9.dataset.tokOwner === "as9", "带轮次台账仍能渲染 Badge");
const rtable9 = findEl(badge9, (c) => c.tag === "table" && /tok-round-table/.test(c.className || ""));
ok(!!rtable9, "Badge 含「按轮次」表（tok-round-table，沿用 tok-badge-table 体系）");
const roundRows9 = findAll(badge9, (c) => c.tag === "tr" && /tok-round-row/.test(c.className || ""));
ok(roundRows9.length === 2, "按轮次表逐轮一行（实得 " + roundRows9.length + " 行）");
const rr0 = roundRows9[0];
ok(!!rr0 && rr0.attrs.role === "button" && rr0.tabIndex === 0, "轮次行可点击（role=button + 键盘可达）");
ok(
  !!rr0 && (rr0.listeners.click || []).length === 1 && (rr0.listeners.keydown || []).length === 1,
  "轮次行绑定 click 与 keydown（Enter / 空格）",
);
ok(!!rr0 && !!rr0.title, "轮次行带「点击查看该轮性能」提示");
ok(typeof ctx.openRoundPerfDialog === "function", "存在 openRoundPerfDialog 轮次下钻弹窗");
const head9 = findEl(badge9, (c) => /tok-sec-head/.test(c.className || "") && /按轮次/.test(c.textContent || ""));
ok(!!head9, "轮次区带小标题（按轮次 · N 轮）");
ok(
  findAll(badge9, (c) => /tok-sec-head/.test(c.className || "")).some((c) => /按模型/.test(c.textContent || "") && /合计/.test(c.textContent || "")),
  "「按模型 · 合计」小标题仍在（原表未动）",
);
ok(!!findEl(badge9, (c) => /tok-badge-total/.test(c.className || "")), "合计行仍在（按轮次只是附加分区）");
const plain9 = ctx.tokReportPlain(rd);
ok(plain9.includes("按轮次") && plain9.includes("合计"), "纯文本报告含「按轮次」段与「合计」段");
ok(plain9.includes("第一轮") && plain9.includes("第二轮"), "纯文本报告含逐轮标题");
ok(plain9.includes("按模型"), "纯文本报告仍有「按模型」段");

/* 9h. 轮次下钻弹窗：概要 + 逐模型性能（可再下钻）+ 口径脚注 */
ovBody.children.length = 0;
ovFoot.children.length = 0;
ctx.openRoundPerfDialog(rd, rv[0]);
const kvr = {};
for (const row of (ovBody.children[0] && ovBody.children[0].children) || [])
  kvr[row.children[0].textContent] = row.children[1].textContent;
ok(/第二轮/.test(kvr["标题"] || ""), "轮次弹窗列出标题：" + kvr["标题"]);
ok(!!kvr["轮次 / 步"], "轮次弹窗列出轮 / 步：" + kvr["轮次 / 步"]);
ok(!!kvr["该轮性能"] && /TTFT/.test(kvr["该轮性能"]), "轮次弹窗列出该轮性能摘要：" + kvr["该轮性能"]);
ok(!!kvr["费用"], "轮次弹窗列出该轮费用：" + kvr["费用"]);
const rmt9 = findEl(ovBody, (c) => /tok-round-models/.test(c.className || ""));
ok(!!rmt9 && rmt9.children.length === 2, "轮次弹窗逐模型列出（表头 + 1 模型）");
const rmtRow = rmt9 && rmt9.children[1];
ok(!!rmtRow && /tok-model-row/.test(rmtRow.className || "") && (rmtRow.listeners.click || []).length === 1, "轮次弹窗的模型行仍可下钻");
ok(!!findEl(ovBody, (c) => /model-perf-note/.test(c.className || "")), "轮次弹窗带口径脚注（实测 / 推算 / —）");
ok(ovFoot.children.length > 0, "轮次弹窗带关闭按钮");

console.log(fails ? "\n✗ " + fails + " 项失败" : "\n✓ 全部通过");
process.exit(fails ? 1 : 0);
