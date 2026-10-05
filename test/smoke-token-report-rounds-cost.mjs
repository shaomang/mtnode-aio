/* Token 报告「明细」峰谷计价回归（本轮修复 · 用户报「细则部分未加入峰谷打折，总计里已加入」）
 * ============================================================================
 * 现场：同一份台账里
 *   · 「合计」行 = tokCostOf()（逐轮按各轮记账时刻计价）
 *   · 「按模型」明细行的费用过去 = tokCostOfBucket()（**累计桶 + 一个时刻**整体判峰谷）
 * 跨峰谷的会话里这两条路必然对不上：合计 ¥13.5（高峰轮 ¥9 + 空闲轮 ¥4.5），
 * 明细却按「桶最近一次入账时刻」把两轮都按半价算成 ¥4.5 —— 明细之和 ¥4.5 ≠ 合计 ¥13.5，
 * 看着就是「明细没加峰谷折扣」。
 *
 * 修复口径：明细与合计共用同一趟逐轮计价（app-agent.js 的 tokCostCurve）——
 *   1) 明细逐行之和 = 合计行（恒等式，唯一真源）
 *   2) 明细行的峰谷按各轮自己的记账时刻判（不再拿累计桶的一个时刻定整段会话的折扣档）
 *   3) 明细行 / 纯文本报告标出「峰谷 / 谷」，悬停有解释；纯高峰行不标（全价是默认口径）
 *   4) 老台账（没有 roundList）没有「逐轮」可依 → 回落单桶口径（桶 at → 台账 lastAt），
 *      与合计的尾段兜底同口径，不退化成「—」
 *
 * 运行：node test/smoke-token-report-rounds-cost.mjs
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = fs.readFileSync(path.join(ROOT, "renderer", "app-agent.js"), "utf8");
const COST_SRC = fs.readFileSync(path.join(ROOT, "renderer", "app-cost.js"), "utf8");

/* 最小 DOM 桩（与 smoke-token-report.mjs 同口径，够 tokBadgeEl / tokReportPlain 走完） */
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
    get textContent() {
      if (this._text != null) return this._text;
      let s = "";
      for (const c of this.children || []) s += c && c.textContent != null ? String(c.textContent) : "";
      return s;
    },
    set textContent(v) { this._text = String(v == null ? "" : v) },
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
const ctx = {
  console, setTimeout, clearTimeout, Date, Math, Number, Object, Array, String, JSON, Promise,
  I18n: { t: (x) => String(x) },
  $: () => null,
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
  fmtDur: (ms) => Math.round(Number(ms) || 0) / 1000 + "s",
  fmtTok: (n) => String(Number(n) || 0),
  fmtTime: () => "00:00:00",
  navigator: {},
  agentSessions: () => [],
};
vm.createContext(ctx);
vm.runInContext(COST_SRC, ctx, { filename: "app-cost.js" });
vm.runInContext(SRC, ctx, { filename: "app-agent.js" });

let fails = 0;
const ok = (cond, msg) => {
  console.log((cond ? "  ok   " : "  FAIL ") + msg);
  if (!cond) fails++;
};
const near = (a, b, msg) => ok(Math.abs((a || 0) - (b || 0)) < 1e-9, msg + " (" + a + " vs " + b + ")");
function eachEl(root, fn) {
  for (const c of (root && root.children) || []) {
    fn(c);
    eachEl(c, fn);
  }
}
function findAll(root, pred) {
  const out = [];
  eachEl(root, (c) => { if (pred(c)) out.push(c) });
  return out;
}
function findEl(root, pred) {
  let hit = null;
  eachEl(root, (c) => { if (!hit && pred(c)) hit = c });
  return hit;
}

/* ── 时间基准（北京时间）───────────────────────────────────────
 * 高峰：周一至周五 9:00-12:00 / 14:00-18:00；其余（含周末）空闲半价。 */
const T_PEAK = Date.UTC(2026, 0, 5, 2, 0, 0); /* 周一 10:00 北京 */
const T_OFF = Date.UTC(2026, 0, 5, 12, 0, 0); /* 周一 20:00 北京 */

const v4proRound = (t0, billed, out) => ({
  turns: 1, steps: 1, llmMs: 2000, toolMs: 0, wallMs: 2000,
  startedAt: t0, endedAt: t0,
  models: [
    {
      provider: "deepseek", model: "deepseek-v4-pro",
      inputTokens: billed, outputTokens: out, calls: 1,
      cacheReadTokens: 0, cacheWriteTokens: 0, llmMs: 2000, toolMs: 0,
    },
  ],
});

/* ── 1. 跨峰谷：明细行之和 = 合计行（本轮修复的恒等式）─────────── */
const owner = { id: "as-cross", title: "cross", messages: [] };
ctx.tokMergeRun(owner, v4proRound(T_PEAK, 1e6, 0), { runKey: "agent:as-cross", title: "高峰轮" });
ctx.tokMergeRun(owner, v4proRound(T_OFF, 1e6, 0), { runKey: "agent:as-cross", title: "空闲轮" });

const rounds = ctx.tokViewRounds(owner);
near(rounds.length, 2, "两轮都入账（高峰轮 + 空闲轮）");
const roundSum = rounds.reduce((s, rec) => {
  const c = ctx.tokRoundCost(owner, rec);
  return s + (c ? c.amount : 0);
}, 0);
near(roundSum, 13.5, "逐轮费用之和 = ¥9（高峰全价）+ ¥4.5（空闲半价）");

const total = ctx.tokCostOf(owner);
near(total.amount, 13.5, "合计 = 逐轮之和 ¥13.5（总计算了峰谷）");
ok(total.offPeak === true, "合计带 offPeak 标记（这一遍里确有被折扣的份量）");
ok(total.peak === true, "合计带 peak 标记（也有全价的份量）");

const models = ctx.tokViewModels(owner);
near(models.length, 1, "台账里只有一个模型桶");
const mc = ctx.tokModelCostOf(models[0], owner);
const legacyBucketCost = ctx.tokCostOfBucket(models[0], owner);
/* 旧写法（累计桶 + 桶上那一个时刻）的表现：整段会话只拿**一个时刻**定折扣档 ——
   本用例里它落回高峰档，于是空闲轮白丢了半价，明细只算 ¥9，而合计是 ¥13.5。
   这正是用户报的「细则（明细）没加峰谷折扣，总计里加了」：两处口径分裂。
   这里把旧口径钉住，免得哪天又有人把明细行接回单桶口径。 */
near(legacyBucketCost.amount, 9.0, "旧口径（累计桶 + 单时刻）只给 ¥9 —— 明细对不上合计的真实原因");
ok(legacyBucketCost.amount !== total.amount, "旧口径与合计必然不等（一个时刻给整段会话定折扣档）");
near(mc.amount, 13.5, "修复后：明细行 = ¥13.5（逐轮计价，明细之和 = 合计）");
ok(mc.peak === true && mc.offPeak === true, "明细行同时带峰、谷标记（跨了峰谷）");
near(mc.amount, total.amount, "明细行费用 = 合计费用（同一趟计价，恒等）");

/* ── 2. 全部高峰 / 全部空闲：折扣不串味 ──────────────────────── */
const peakOnly = { id: "as-peak", messages: [] };
ctx.tokMergeRun(peakOnly, v4proRound(T_PEAK, 1e6, 0), { runKey: "agent:as-peak", title: "只高峰" });
const pk = ctx.tokModelCostOf(ctx.tokViewModels(peakOnly)[0], peakOnly);
near(pk.amount, 9.0, "只跑高峰：明细全价 ¥9");
ok(pk.peak === true && pk.offPeak === false, "只跑高峰：只带峰标记，不误标谷");
ok(ctx.tokPeakMark(pk) === "", "纯高峰行不加「峰 / 谷」标记（全价是默认口径，不刷噪声）");

const offOnly = { id: "as-off", messages: [] };
ctx.tokMergeRun(offOnly, v4proRound(T_OFF, 1e6, 0), { runKey: "agent:as-off", title: "只空闲" });
const of = ctx.tokModelCostOf(ctx.tokViewModels(offOnly)[0], offOnly);
near(of.amount, 4.5, "只跑空闲：明细半价 ¥4.5");
ok(of.offPeak === true && of.peak === false, "只跑空闲：只带谷标记");
ok(/谷/.test(ctx.tokPeakMark(of)), "纯空闲行标「谷」：" + ctx.tokPeakMark(of));
ok(/空闲/.test(ctx.tokPeakTip(of)), "谷标记带悬停解释：" + ctx.tokPeakTip(of));

/* ── 3. 老台账（没有 roundList）：回落单桶口径，不退化成「—」──── */
const legacy = {
  id: "as-legacy",
  tokenReport: {
    rounds: 2,
    lastAt: T_OFF,
    llmMs: 4000,
    byModel: {
      "deepseek|deepseek-v4-pro": {
        provider: "deepseek", model: "deepseek-v4-pro",
        inputTokens: 1e6, outputTokens: 0, calls: 1, llmMs: 4000, at: T_OFF,
      },
    },
  },
};
const lg = ctx.tokModelCostOf(ctx.tokViewModels(legacy)[0], legacy);
ok(!!lg, "老台账的明细行仍算得出费用（不退化）");
near(lg.amount, 4.5, "老台账明细 = 单桶口径（桶 at 在空闲段 → ¥4.5）");
near(ctx.tokCostOf(legacy).amount, 4.5, "老台账合计与明细同源（都是 ¥4.5）");

/* ── 4. 非官方路由 / 未知单价：仍是「—」，也不误标峰谷 ────────── */
const foreign = {
  id: "as-foreign",
  messages: [],
};
ctx.tokMergeRun(foreign, {
  turns: 1, steps: 1, llmMs: 1000, toolMs: 0, wallMs: 1000, startedAt: T_OFF, endedAt: T_OFF,
  models: [
    { provider: "mtnode_openrouter", model: "vision-model", inputTokens: 900, outputTokens: 90, calls: 1, llmMs: 1000, toolMs: 0 },
  ],
}, { runKey: "agent:as-foreign", title: "别家模型" });
const fm = ctx.tokModelCostOf(ctx.tokViewModels(foreign)[0], foreign);
ok(fm === null, "非官方路由的明细行仍不计费（null → UI 显示 —）");
ok(ctx.tokPeakMark(fm) === "" && ctx.tokPeakTip(fm) === "", "不计费的行不带峰谷标记");

/* ── 5. UI：明细表与轮次表的费用单元带标记、title 有解释 ───────── */
/* 「按轮次」区由脚部开关控制（owner._tokRoundOpen）：先打开再渲染 —— 与用户点开
   「N 轮」看到的是同一条路径。 */
owner._tokRoundOpen = true;
const badge = ctx.tokBadgeEl(owner);
ok(!!badge, "跨峰谷台账能渲染 Token 报告 Badge");
const modelTable = findEl(badge, (c) => c.tag === "table" && /tok-badge-table/.test(c.className || "") && !/tok-round-table/.test(c.className || ""));
const modelRow = findEl(modelTable, (c) => c.tag === "tr" && c.className === "tok-model-row");
const modelCostTd = modelRow && modelRow.children[modelRow.children.length - 1];
ok(!!modelCostTd && /^¥13\.5/.test(modelCostTd.textContent || ""), "明细表模型行费用 = ¥13.5（带峰谷折扣）：" + (modelCostTd && modelCostTd.textContent));
ok(!!modelCostTd && /峰谷/.test(modelCostTd.textContent || ""), "明细行标出「峰谷」（用户能一眼看出打了折）");
ok(!!modelCostTd && /高峰/.test(modelCostTd.title || ""), "明细行 title 解释峰谷口径：" + (modelCostTd && modelCostTd.title));

const totalRow = findEl(modelTable, (c) => /tok-badge-total/.test(c.className || ""));
const totalCostTd = totalRow && totalRow.children[totalRow.children.length - 1];
ok(!!totalCostTd && /^¥13\.5/.test(totalCostTd.textContent || ""), "合计行费用 = ¥13.5");
ok(
  !!modelCostTd && !!totalCostTd &&
    (modelCostTd.textContent.match(/¥[\d.,]+/) || [""])[0] === (totalCostTd.textContent.match(/¥[\d.,]+/) || [""])[0],
  "明细行金额与合计行金额逐字相等（不再打架）",
);
const roundTable = findEl(badge, (c) => c.tag === "table" && /tok-round-table/.test(c.className || ""));
const roundCostCells = findAll(roundTable, (c) => c.tag === "td" && /tok-badge-cost/.test(c.className || ""));
ok(roundCostCells.length === 2, "轮次表两轮各一格费用（实得 " + roundCostCells.length + "）");
ok(roundCostCells.some((c) => /¥9\.00/.test(c.textContent || "")) && roundCostCells.some((c) => /¥4\.50/.test(c.textContent || "")), "轮次表逐轮费用 = ¥9.00 / ¥4.50（各按自己时刻）");

/* 纯文本报告（复制出去的那份）：费用行同样带标记 */
const plain = ctx.tokReportPlain(owner);
ok(/费用 ≈¥13\.50/.test(plain), "纯文本报告「按模型」费用行 = ≈¥13.50");
ok(/13\.50 峰谷|峰谷/.test(plain), "纯文本报告费用行带「峰谷」标记");
ok(/合计/.test(plain) && /按轮次/.test(plain), "纯文本报告结构未变（合计 / 按轮次仍在）");

/* ── 6. 口径自洽：多模型时逐行之和 = 合计 ─────────────────────── */
const multi = { id: "as-multi", messages: [] };
ctx.tokMergeRun(multi, {
  turns: 1, steps: 1, llmMs: 2000, toolMs: 0, wallMs: 2000, startedAt: T_PEAK, endedAt: T_PEAK,
  models: [
    { provider: "deepseek", model: "deepseek-v4-pro", inputTokens: 1e6, outputTokens: 0, calls: 1, llmMs: 1000, toolMs: 0 },
    { provider: "deepseek", model: "deepseek-v4-flash", inputTokens: 1e6, outputTokens: 0, calls: 1, llmMs: 1000, toolMs: 0 },
  ],
}, { runKey: "agent:as-multi", title: "高峰多模型" });
ctx.tokMergeRun(multi, {
  turns: 1, steps: 1, llmMs: 2000, toolMs: 0, wallMs: 2000, startedAt: T_OFF, endedAt: T_OFF,
  models: [
    { provider: "deepseek", model: "deepseek-v4-pro", inputTokens: 1e6, outputTokens: 0, calls: 1, llmMs: 1000, toolMs: 0 },
    { provider: "deepseek", model: "deepseek-v4-flash", inputTokens: 1e6, outputTokens: 0, calls: 1, llmMs: 1000, toolMs: 0 },
  ],
}, { runKey: "agent:as-multi", title: "空闲多模型" });
const multiSum = ctx.tokViewModels(multi).reduce((s, b) => {
  const c = ctx.tokModelCostOf(b, multi);
  return s + (c ? c.amount : 0);
}, 0);
const multiTotal = ctx.tokCostOf(multi);
near(multiTotal.amount, 9 + 2 + 4.5 + 1, "多模型两轮合计 = 高峰(9+2) + 空闲(4.5+1) = ¥16.5");
near(multiSum, multiTotal.amount, "多模型：明细逐行之和 = 合计（恒等式成立）");
const proBucket = ctx.tokViewModels(multi).find((b) => /v4-pro/.test(b.model));
const flashBucket = ctx.tokViewModels(multi).find((b) => /flash/.test(b.model));
near(ctx.tokModelCostOf(proBucket, multi).amount, 13.5, "v4-pro 明细 = 9 + 4.5 = ¥13.5");
near(ctx.tokModelCostOf(flashBucket, multi).amount, 3.0, "v4-flash 明细 = 2 + 1 = ¥3.0");

console.log(fails ? "\n✗ " + fails + " 项失败" : "\n✓ 全部通过");
process.exit(fails ? 1 : 0);
