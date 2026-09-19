"use strict";
/* ============================================================
 * 费用估算（DeepSeek 单价） + DeepSeek 余额查询 / 展示
 * 渲染层 · 纯自研，零第三方依赖。
 * ------------------------------------------------------------
 * 前段（DS_PRICE / costIsDeepseekOfficial / costOfBucket / costOfOwner /
 * fmtMoney）完全不碰 DOM，只吃 token 台账、只吐数字，所以 test/ 下的
 * 冒烟脚本能直接切片喂给 vm 真跑：
 *   · DS_PRICE                    官方单价表（¥ / 百万 token）
 *   · costIsDeepseekOfficial(p)   p 是否走 DeepSeek 官方路由
 *   · costOfBucket(prov, model, bucket, atFallback)  单桶费用 → { currency, amount, offPeak, estimated } | null
 *   · costOfOwner(owner)          按 tokViewModels(owner) 汇总费用 → 同上 | null
 *     （渲染层会话合计走 app-agent.js 的 tokCostReduce：逐轮之和 + 未覆盖尾段，
 *      保证与「按轮次」逐轮费用一致；本函数是它算不出时的兜底）
 *   · fmtMoney(n, currency)       统一两位小数
 *
 * 后段才是 DOM：balanceGet(force) 取余额（模块级 60s 缓存 + 失败退避），
 * balanceChip() / balanceLine() 生成「金额 + 刷新按钮 + 取数时间」。
 * 无 API Key 或非官方路由时这两个函数返回 null（不显示）。
 *
 * 单价真源：DeepSeek 官方「模型 & 价格」页
 *   https://api-docs.deepseek.com/zh-cn/quick_start/pricing
 * 官方为峰谷计价：高峰时段（北京时间周一至周五 9:00-12:00、14:00-18:00）
 * 即下表数值，空闲时段为其一半。本表取高峰（列表价）作为基准；要按其它
 * 口径估算，用 S.config.deepseekPricing[modelId] 覆盖即可。
 *
 * 两条兜底口径（会话统计计费）：
 *   · 未知 DeepSeek 模型（表里没有、配置也没覆盖）→ 按 flash 价计，结果带
 *     estimated:true（宁可给个偏低估算，也不显示「—」）；非 DeepSeek 模型
 *     仍返回 null（不猜价）。
 *   · 峰谷：桶里带时刻（合并台账时写入 at）就按该时刻判峰谷——高峰 = 全价、
 *     空闲 = ×DS_OFFPEAK_RATIO（0.5）；没有时刻信息一律按高峰表内价。
 *     折扣比例可用 S.config.deepseekOffPeakRatio 覆盖。
 *
 * 「显示比实际消费高」的口径核对结论（2026-09-11 排查，不改计价公式）：
 *   · 台账 token 侧不存在重复计：会话 Badge 的 计费输入 / 缓存读 / 输出 与本机
 *     dsh 会话日志 session.jsonl(.zstd) 里逐请求 usage 之和逐位相等
 *     （scripts/audit-token-usage.mjs 可复核；日志里 assistant/chunk 与
 *     assistant/message 两处 usage 数值相同，网关只累计 chunk 一次，故不是 2×）。
 *   · 上游适配器已把 prompt_tokens 里的缓存命中减掉（命中/未命中互斥），
 *     所以「未命中 + 缓存读 + 缓存写」= 真实 prompt 量，也没有把缓存读算两遍。
 *   · 剩下的偏差来自单价侧：估算未计入官方活动折扣与赠送余额抵扣；价格表里
 *     没有的模型按 flash 价兜底（estimated:true）；估算按「每一次模型请求」
 *     累加，含重试 / 预热等已发出而平台可能不计费的请求。UI 侧的解释入口见
 *     本文件 costHelpEl()。峰谷本身不构成偏差：桶带时刻就按峰谷计价（谷时
 *     半价），与官方按实际调用时刻计费的口径一致。
 * ============================================================ */

/* ============================================================
 * 一、单价与费用（纯函数，不碰 DOM）
 * ============================================================ */

/* DeepSeek 官方单价：¥ / 百万 token（高峰时段） */
const DS_PRICE = {
  "deepseek-v4-flash": { cacheHit: 0.1, cacheMiss: 3.0, output: 9.0 },
  "deepseek-v4-pro": { cacheHit: 0.3, cacheMiss: 9.0, output: 27.0 },
  "deepseek-v4-flash-vision-exp": { cacheHit: 0.1, cacheMiss: 3.0, output: 9.0 },
};

/* 未知 DeepSeek 模型的兜底档（按 flash 价） */
const DS_FLASH_ID = "deepseek-v4-flash";

/* 峰谷：空闲时段单价 = 高峰 × 该比例（官方为空闲半价） */
const DS_OFFPEAK_RATIO = 0.5;
const DS_BJ_OFFSET = 8 * 3600000; /* 北京时间 = UTC+8，用 UTC getter 读 */

/* 官方路由的两个约定 id */
const DS_OFFICIAL_IDS = ["deepseek", "deepseek-official"];

function costNum(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function costProviders() {
  try {
    if (typeof S !== "undefined" && S && S.config && Array.isArray(S.config.providers))
      return S.config.providers;
  } catch {}
  return [];
}

function costBaseUrl(p) {
  return String((p && (p.baseUrl || p.base_url)) || "").trim();
}

/* 是否走 DeepSeek 官方：provider 为 deepseek / deepseek-official，或 baseUrl 含 deepseek。
 * provider 允许传服务商对象、配置里的 id / 名称 / 路由字符串。 */
function costIsDeepseekOfficial(provider) {
  if (provider == null) return false;
  if (typeof provider === "string") {
    const s = provider.trim();
    if (!s) return false;
    const low = s.toLowerCase();
    if (DS_OFFICIAL_IDS.indexOf(low) >= 0) return true;
    if (/deepseek/i.test(s)) return true; /* baseUrl 形式的字符串 */
    const hit = costProviders().find(
      (p) =>
        p &&
        (String(p.id || "") === s ||
          String(p.name || "") === s ||
          String(p.route || "") === s),
    );
    return hit ? costIsDeepseekOfficial(hit) : false;
  }
  for (const f of [provider.id, provider.name, provider.provider, provider.route]) {
    const v = String(f || "").trim().toLowerCase();
    if (DS_OFFICIAL_IDS.indexOf(v) >= 0) return true;
  }
  if (/deepseek/i.test(costBaseUrl(provider))) return true;
  /* mtnode_<id> 路由 → 回查配置里的服务商 */
  const route = String(provider.route || "").trim();
  if (route.indexOf("mtnode_") === 0) {
    const id = route.slice("mtnode_".length);
    const hit = costProviders().find((p) => p && String(p.id || "") === id);
    if (hit) return costIsDeepseekOfficial(hit);
  }
  return false;
}

/* 模型 id 归一：容忍 "deepseek/deepseek-v4-pro" 这类带前缀写法 */
function costModelId(model) {
  let id = String(model || "").trim().toLowerCase();
  if (!id) return "";
  if (DS_PRICE[id]) return id;
  const cut = id.lastIndexOf("/");
  if (cut >= 0 && DS_PRICE[id.slice(cut + 1)]) return id.slice(cut + 1);
  /* 带版本后缀（deepseek-v4-pro-0813）→ 取最长匹配前缀 */
  let best = "";
  for (const k of Object.keys(DS_PRICE)) if (id.indexOf(k) === 0 && k.length > best.length) best = k;
  return best || id;
}

/* 这个模型 id 是不是 DeepSeek 家的（决定未知时能否按 flash 兜底）。
 * 认 "deepseek" 字样，也认纯版本号写法（v4-pro / v4-flash-0813）；gpt-4o 这类不认。 */
function costLooksDeepseek(model) {
  const id = costModelId(model);
  if (!id) return false;
  return /deepseek/i.test(id) || /^v\d/.test(id);
}

/* 单价（¥ / 百万 token）：官方表 + S.config.deepseekPricing[modelId] 覆盖。
 * 未知的 DeepSeek 模型 → 按 flash 兜底（price.estimated = true）；非 DeepSeek 未知 → null */
function costPriceOf(model) {
  const id = costModelId(model);
  if (!id) return null;
  let base = DS_PRICE[id] || null;
  let estimated = false;
  let ov = null;
  try {
    const map = (typeof S !== "undefined" && S && S.config && S.config.deepseekPricing) || null;
    if (map && typeof map === "object") ov = map[id] || map[model] || null;
  } catch {}
  if (!base && !ov && costLooksDeepseek(id)) {
    base = DS_PRICE[DS_FLASH_ID];
    estimated = true;
  }
  if (!base && !ov) return null;
  const price = {
    cacheHit: base ? base.cacheHit : 0,
    cacheMiss: base ? base.cacheMiss : 0,
    output: base ? base.output : 0,
  };
  if (ov && typeof ov === "object")
    for (const k of ["cacheHit", "cacheMiss", "output"])
      if (Number.isFinite(Number(ov[k]))) price[k] = Number(ov[k]);
  price.estimated = estimated;
  return price;
}

/* 桶的记账时刻：合并台账时写入的 at（老台账可能没有，返回 0 = 未知） */
function costBucketAt(bucket) {
  if (!bucket) return 0;
  for (const f of ["at", "ts", "time", "endedAt", "lastAt", "startedAt"]) {
    const v = Number(bucket[f]);
    if (Number.isFinite(v) && v > 0) return v;
  }
  return 0;
}

/* 是否高峰（北京时间周一至周五 9:00-12:00、14:00-18:00）。
 * 无时刻信息 → 按高峰：表内数值就是高峰价，不给无依据的折扣。 */
function costIsPeakAt(ts) {
  const t = Number(ts);
  if (!Number.isFinite(t) || t <= 0) return true;
  const d = new Date(t + DS_BJ_OFFSET);
  const wd = d.getUTCDay();
  if (wd === 0 || wd === 6) return false;
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  return (mins >= 540 && mins < 720) || (mins >= 840 && mins < 1080);
}

/* 空闲折扣比例：S.config.deepseekOffPeakRatio 可覆盖（默认 0.5） */
function costOffPeakRatio() {
  try {
    const r = Number(S && S.config && S.config.deepseekOffPeakRatio);
    if (Number.isFinite(r) && r >= 0 && r <= 1) return r;
  } catch {}
  return DS_OFFPEAK_RATIO;
}

/* 单个 token 桶的费用：
 *   缓存命中 = cacheReadTokens，未命中 = inputTokens + cacheWriteTokens，输出 = outputTokens。
 * 峰谷：桶自带时刻（或第 4 参 atFallback，如台账 lastAt）落在空闲时段 → ×半价。
 * 非官方路由 / 未知单价（且不是 DeepSeek） → null（不猜价）。 */
function costOfBucket(provider, model, bucket, atFallback) {
  if (!bucket) return null;
  if (!costIsDeepseekOfficial(provider)) return null;
  const price = costPriceOf(model);
  if (!price) return null;
  const hit = costNum(bucket.cacheReadTokens);
  const miss = costNum(bucket.inputTokens) + costNum(bucket.cacheWriteTokens);
  const out = costNum(bucket.outputTokens);
  const fb = Number(atFallback);
  const at = costBucketAt(bucket) || (Number.isFinite(fb) && fb > 0 ? fb : 0);
  const offPeak = !!at && !costIsPeakAt(at);
  const ratio = offPeak ? costOffPeakRatio() : 1;
  const amount =
    ((hit * price.cacheHit + miss * price.cacheMiss + out * price.output) / 1e6) * ratio;
  return { currency: "CNY", amount, offPeak, estimated: !!price.estimated };
}

/* 台账取数：优先 app-agent.js 的 tokViewModels；单独切片跑时退回等价实现
 * （累计 byModel + 在途 _tokLive 逐字段相加），口径与它保持一致。 */
function costViewModels(owner) {
  if (typeof tokViewModels === "function") {
    const arr = tokViewModels(owner);
    if (Array.isArray(arr)) return arr;
  }
  const out = {};
  const rep = (owner && owner.tokenReport) || null;
  if (rep && rep.byModel)
    for (const k of Object.keys(rep.byModel))
      out[k] = Object.assign({}, rep.byModel[k]);
  const live = owner && owner._tokLive;
  if (live)
    for (const k of Object.keys(live)) {
      const m = live[k] || {};
      const b = out[k] || (out[k] = { provider: m.provider || "", model: m.model || "" });
      for (const f of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"])
        b[f] = costNum(b[f]) + costNum(m[f]);
    }
  return Object.keys(out).map((k) => out[k]);
}

/* 按会话 / 节点台账汇总费用（口径与 tokViewModels 一致）；一笔都算不出 → null。
 * 老台账（合并时还没记 at）用台账 lastAt 兜底判峰谷，避免默认按高峰多估。 */
function costOfOwner(owner) {
  if (!owner) return null;
  const models = costViewModels(owner);
  if (!Array.isArray(models) || !models.length) return null;
  const rep = owner.tokenReport || null;
  const fallbackAt = (rep && Number(rep.lastAt)) || 0;
  let amount = 0;
  let any = false;
  for (const b of models) {
    if (!b) continue;
    const c = costOfBucket(b.provider, b.model, b, fallbackAt);
    if (!c) continue;
    amount += c.amount;
    any = true;
  }
  return any ? { currency: "CNY", amount } : null;
}

const COST_SYMBOL = { CNY: "¥", RMB: "¥", USD: "$" };

/* 金额统一两位小数（负数、千分位都照顾到）；空值 / 非数字给 "—" */
function fmtMoney(n, currency) {
  if (n === null || n === undefined || n === "") return "—";
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  const cur = String(currency || "CNY").toUpperCase();
  const sym = COST_SYMBOL[cur] || (cur ? cur + " " : "");
  const body = Math.abs(v)
    .toFixed(2)
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return (v < 0 ? "-" : "") + sym + body;
}

/* ============================================================
 * 二、DeepSeek 余额（官方路由 + 本机 API Key）
 * ============================================================ */

const DS_BAL_TTL = 60000; /* 成功结果缓存 60s */
const DS_BAL_BACKOFF_BASE = 5000; /* 失败退避基数 */
const DS_BAL_BACKOFF_MAX = 5 * 60 * 1000; /* 退避上限 5min */

let _dsBal = { at: 0, data: null, err: "", failAt: 0, failCount: 0, inflight: null };

/* 当前可用于查余额的官方路由；没有 key / 非官方 → null */
function balanceHost() {
  const dp = typeof dshProvider === "function" ? dshProvider() : null;
  if (!dp) return null;
  const baseUrl = costBaseUrl(dp);
  const apiKey = String(dp.apiKey || "").trim();
  if (!baseUrl || !apiKey) return null;
  if (!costIsDeepseekOfficial(dp)) return null;
  return { baseUrl: baseUrl, apiKey: apiKey, provider: dp };
}

/* 余额是否值得展示 */
function balanceVisible() {
  return !!balanceHost();
}

/* 官方返回归一：兼容三种包装
 *   · 官方原始：{ is_available, balance_infos:[{ total_balance, … }] }
 *   · 包装：    { ok, data:{ … } }
 *   · 主进程归一：{ ok, isAvailable, balances:[{ totalBalance, … }] }
 * 主进程 api:deepseekBalance 一度只回第三种（camelCase），渲染层只认前两种，
 * 结果每次都被判成「余额返回为空」→ 界面永远显示查询失败。这里 snake_case /
 * camelCase 都收，哪一侧先改都不会再断。 */
function balanceNorm(res) {
  if (!res) return null;
  if (res.ok === false) return null;
  let d = res;
  if (res.data && typeof res.data === "object" && !Array.isArray(res.data)) d = res.data;
  const pick = (b, snake, camel) => (b && (b[snake] != null ? b[snake] : b[camel]));
  const arr = (x) => (Array.isArray(x) ? x : null);
  const raw =
    arr(d.balance_infos) || arr(res.balance_infos) || arr(d.balances) || arr(res.balances) || [];
  const list = raw.map((b) => ({
    currency: String((b && b.currency) || "CNY").toUpperCase(),
    total: Number(pick(b, "total_balance", "totalBalance")) || 0,
    granted: Number(pick(b, "granted_balance", "grantedBalance")) || 0,
    toppedUp: Number(pick(b, "topped_up_balance", "toppedUpBalance")) || 0,
  }));
  const totalRaw =
    d.total_balance != null
      ? d.total_balance
      : res.total_balance != null
        ? res.total_balance
        : d.totalBalance != null
          ? d.totalBalance
          : res.totalBalance;
  if (!list.length && totalRaw == null) return null;
  if (!list.length)
    list.push({
      currency: "CNY",
      total: Number(totalRaw) || 0,
      granted: Number(d.granted_balance != null ? d.granted_balance : d.grantedBalance) || 0,
      toppedUp: Number(d.topped_up_balance != null ? d.topped_up_balance : d.toppedUpBalance) || 0,
    });
  const main = list.find((x) => x.currency === "CNY") || list[0];
  const availRaw =
    res.isAvailable !== undefined
      ? res.isAvailable
      : d.is_available !== undefined
        ? d.is_available
        : res.is_available;
  return { available: availRaw !== false, list: list, main: main, at: Date.now() };
}

/* 取余额：force=true 跳过缓存；60s 内直接复用；失败按 5s→10s→…→5min 退避 */
function balanceGet(force) {
  const host = balanceHost();
  if (!host) return Promise.resolve(null);
  const api = (typeof window !== "undefined" && window && window.api) || null;
  if (!api || typeof api.apiDeepseekBalance !== "function") return Promise.resolve(null);
  const now = Date.now();
  if (!force && _dsBal.data && now - _dsBal.at < DS_BAL_TTL)
    return Promise.resolve(_dsBal.data);
  if (_dsBal.inflight) return _dsBal.inflight;
  if (!force && _dsBal.failCount) {
    const wait = Math.min(
      DS_BAL_BACKOFF_MAX,
      DS_BAL_BACKOFF_BASE * Math.pow(2, _dsBal.failCount - 1),
    );
    if (now - _dsBal.failAt < wait) return Promise.resolve(_dsBal.data || null);
  }
  const p = Promise.resolve()
    .then(() => api.apiDeepseekBalance({ baseUrl: host.baseUrl, apiKey: host.apiKey }))
    .then((res) => {
      const data = balanceNorm(res);
      if (!data) throw new Error("余额返回为空");
      _dsBal = { at: Date.now(), data: data, err: "", failAt: 0, failCount: 0, inflight: null };
      return data;
    })
    .catch((e) => {
      const cur = _dsBal || {};
      cur.inflight = null;
      cur.err = String((e && e.message) || e || "查询失败");
      cur.failAt = Date.now();
      cur.failCount = (costNum(cur.failCount) || 0) + 1;
      _dsBal = cur;
      return cur.data || null;
    });
  _dsBal.inflight = p;
  return p;
}

/* ============================================================
 * 三、DOM：余额 chip / line（无官方路由或没 key 时不显示）
 * ============================================================ */

function costI18n(s) {
  try {
    if (typeof I18n !== "undefined" && I18n && typeof I18n.t === "function") return I18n.t(s);
  } catch {}
  return s;
}

function balanceTimeText(ts) {
  const d = new Date(Number(ts) || Date.now());
  const p = (n) => (n < 10 ? "0" : "") + n;
  return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
}

/* 把当前缓存状态画进 el（mode: 'chip' 紧凑 / 'line' 带赠送·充值明细） */
function renderBalance(el, mode) {
  if (!el || typeof document === "undefined") return;
  const b = _dsBal.data;
  const err = _dsBal.err;
  el.textContent = "";
  el.classList.toggle("err", !!err && !b);
  el.classList.toggle("loading", !b && !err);

  const label = document.createElement("span");
  label.className = "ds-bal-label";
  label.textContent = mode === "line" ? costI18n("DeepSeek 余额") : costI18n("余额");
  el.appendChild(label);

  const amt = document.createElement("span");
  amt.className = "ds-bal-amount";
  if (b && b.main) amt.textContent = fmtMoney(b.main.total, b.main.currency);
  else if (err) amt.textContent = "—";
  else amt.textContent = "…";
  if (err && !b) amt.title = err;
  el.appendChild(amt);

  if (mode === "line" && b && b.main) {
    const sub = document.createElement("span");
    sub.className = "ds-bal-sub";
    sub.textContent =
      costI18n("赠送") +
      " " +
      fmtMoney(b.main.granted, b.main.currency) +
      " · " +
      costI18n("充值") +
      " " +
      fmtMoney(b.main.toppedUp, b.main.currency);
    el.appendChild(sub);
  }

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "ds-bal-refresh";
  btn.title = costI18n("刷新余额");
  btn.textContent = "⟳";
  btn.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    amt.textContent = "…";
    balanceGet(true).then(
      () => renderBalance(el, mode),
      () => renderBalance(el, mode),
    );
  });
  el.appendChild(btn);

  const time = document.createElement("span");
  time.className = "ds-bal-time";
  if (b && b.at) time.textContent = costI18n("更新于") + " " + balanceTimeText(b.at);
  else if (err) time.textContent = costI18n("查询失败");
  else time.textContent = costI18n("未查询");
  el.appendChild(time);
}

/* 紧凑 chip：金额 + 刷新 + 取数时间 */
function balanceChip() {
  if (typeof document === "undefined" || !balanceHost()) return null;
  const el = document.createElement("span");
  el.className = "ds-bal-chip";
  renderBalance(el, "chip");
  balanceGet(false).then(
    () => renderBalance(el, "chip"),
    () => renderBalance(el, "chip"),
  );
  return el;
}

/* 整行：金额 + 赠送/充值明细 + 刷新 + 取数时间 */
function balanceLine() {
  if (typeof document === "undefined" || !balanceHost()) return null;
  const el = document.createElement("div");
  el.className = "ds-bal-line";
  renderBalance(el, "line");
  balanceGet(false).then(
    () => renderBalance(el, "line"),
    () => renderBalance(el, "line"),
  );
  return el;
}

/* ============================================================
 * 四、费用口径说明（「？」入口：为什么显示会高于实际消费）
 * ------------------------------------------------------------
 * 用户在「token 统计 · 合计计费」旁最常问的就是「为什么比平台账单高」。
 * 这里的每一行都对应一条真实存在的口径差（见文件头「显示比实际消费高」
 * 一节），不是安慰话术：
 *   · 估算未计入官方活动折扣 / 赠送余额抵扣（峰谷已按调用时刻计价，不再是偏差源）
 *   · 价格表没有的模型按 flash 价兜底（estimated:true，UI 用 * 标出）
 *   · 估算按每一次模型请求累加（含重试 / 预热等平台可能不计费的请求）
 *   · 平台按小时 / 按模型分账，与会话 / 轮次窗口不是同一口径
 * 文案走 I18n（键就是中文原文），英文界面自动取词条；缺词条时回落中文。
 * ============================================================ */

const COST_WHY_TITLE = "费用为什么高于实际消费？";

/* 口径说明正文：一行一句（i18n 逐条词条，便于英文界面独立翻译） */
function costWhyLines() {
  return [
    costI18n(
      "估算未计入官方活动折扣与赠送余额抵扣，显示值可能高于实际消费；峰谷按调用时刻计价，与官方账单口径一致。",
    ),
    costI18n(
      "价格表里没有的模型（如带日期后缀的内测模型）按 flash 价兜底，这类金额是估算值，已在行末用 * 标出。",
    ),
    costI18n(
      "估算按「每一次模型请求」累加，包含重试、预热等已发出但平台可能不计费的请求；平台按小时 / 按模型分账，与会话 / 轮次窗口口径不同，两边对不上属正常。",
    ),
    costI18n(
      "对账请以 DeepSeek 账单和余额变化为准。",
    ),
  ];
}

/* 纯文本口径说明（tooltip / 复制报告共用；换行分隔） */
function costWhyText() {
  return [costI18n(COST_WHY_TITLE)].concat(costWhyLines()).join("\n");
}

/* 「？」弹窗：与节点弹窗同一宿主（#overlay / #ovBody / #ovFoot），显式关闭按钮；
 * 不做「点外部即收」（口径见 AGENTS.md 对话框持久化约定）。 */
function costWhyDialog() {
  if (typeof openOverlay !== "function" || typeof document === "undefined") return false;
  openOverlay(costI18n(COST_WHY_TITLE), { persistent: true });
  const body = typeof $ === "function" ? $("#ovBody") : null;
  if (!body) return false;
  const p = document.createElement("div");
  p.className = "tok-cost-why";
  const rows = costWhyLines();
  for (let i = 0; i < rows.length; i++) {
    const line = document.createElement("p");
    line.className = "tok-cost-why-line";
    line.textContent = (i + 1) + ". " + rows[i];
    p.appendChild(line);
  }
  const foot = document.createElement("p");
  foot.className = "tok-cost-why-line tok-cost-why-foot";
  foot.textContent = costI18n(
    "口径：单价与峰谷按官方价格页，token 按上游逐请求返回的 usage 累加。",
  );
  p.appendChild(foot);
  body.appendChild(p);
  const oFoot = typeof $ === "function" ? $("#ovFoot") : null;
  if (oFoot) {
    const okBtn = document.createElement("button");
    okBtn.className = "mini primary";
    okBtn.textContent = costI18n("知道了");
    okBtn.addEventListener("click", (ev) => {
      ev.preventDefault();
      if (typeof closeOverlay === "function") closeOverlay();
    });
    oFoot.appendChild(okBtn);
  }
  return true;
}

/* 「？」图标：挂在「token 统计 · 合计计费」旁。hover 看 tooltip，
 * 点击开完整口径弹窗；无可展示环境（无 document / 非官方路由）返回 null。 */
function costHelpEl() {
  if (typeof document === "undefined") return null;
  const b = document.createElement("button");
  b.type = "button";
  b.className = "tok-cost-help";
  b.textContent = "?";
  b.title = costWhyText();
  b.setAttribute("aria-label", costI18n(COST_WHY_TITLE));
  b.addEventListener("mousedown", (ev) => ev.stopPropagation());
  b.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    costWhyDialog();
  });
  return b;
}
