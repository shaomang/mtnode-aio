import { hotAppendRows } from "./hot-store.mjs";
"use strict";
/**
 * MTNode 中转站（服务端 · 内部测试用）—— DeepSeek 文本/识图 + gpt-image-2.5 图像。
 *
 * 对外就是一套 OpenAI 兼容接口（客户端「提供商」的 Base URL 填
 * `https://www.mt-agent.com/mtnode/store-api/relay/v1`、Key 填账号 token 即可）：
 *   GET  /relay/v1/models                    → 白名单内的模型清单（客户端拉列表用）
 *   POST /relay/v1/chat/completions          → 文本 / 识图（支持 stream，SSE 原样转发）
 *   POST /relay/v1/images/generations        → 文生图（JSON）
 *   POST /relay/v1/images/edits              → 图生图 / 蒙版局部重绘（multipart，整包转发）
 *   GET  /relay/v1/usage                     → 本账号用量自查（余额 + 最近调用明细）
 *
 * 本轮共识（内部测试口径）：
 *   · **鉴权** = 账号登录 token（`Authorization: Bearer <token>`，与客户端同一套 30 天会话）。
 *     管理员用 `node relay-key.mjs --user <用户名>` 给测试账号发一张新票（明文只打印一次）。
 *   · **门禁** = 文本「可用余额 > 0」（不加额外账号名单）；**图像 = 可用余额（已扣掉在途预留）
 *     必须 ≥ 本次应付额（张数 × 元/张）**，不足即 402 且**不转上游**（见 handleImages 的
 *     reserveImageCharge）。修正前图像也只按「余额 > 0」放行、扣费再按可用额夹紧
 *     （chargeYuan 的 cap），于是余额 0.10 也能出一张 0.21 的图，扣完只归零、不会变负。
 *   · **计费单位 = 元**（不含「分」）：费用按元算到底（文本 = 元/百万 token × tokens，
 *     图像 = 元/张 × 张数），**元保留 8 位小数（= 1e-8 元）**，
 *     **换算成整数分只为写进钱包账本**（账户行的 balanceCents + relaySubCents 是钱包内部存储，
 *     见 wallet.mjs §亚分精度，界面与接口不出现它）。
 *     本模块对外（/relay/v1/usage、管理台的用量明细与配置）一律回 **元**：
 *     `costYuan` / `chargedYuan` / `shortfallYuan` / `balanceYuan` / `totalYuan` / `spentYuan`
 *     / `perImageYuan`，明细给足 8 位小数、余额与卡片按 4 位小数显示（客户端按
 *     `yuanPrecision` 自适应）。
 *     修正前是 4 位小数（1e-4 元），小额调用被四舍五入吃掉 —— 这就是「计费不准」的根因。
 *   · **上游 usage**：文本用上游 usage（中转给 DeepSeek 自动注入 `stream_options.include_usage`，
 *     无 usage 一律不扣只记日志）；**同时统计 output tokens / input cache hit tokens /
 *     input cache miss tokens 三项**（明细字段 outputTokens / cacheHitTokens / cacheMissTokens，
 *     另有 inputTokens = 命中 + 未命中 与 promptTokens 兼容旧口径）；
 *     图像按张 × 单价（上游不回 usage）。
 *     上游报错 / 超时 / 被拒一律不扣。
 *   · **上游凭据** = 只从服务器环境文件 `/etc/mtnode-store.env` 读（MTNODE_RELAY_DEEPSEEK_KEY /
 *     MTNODE_RELAY_IMAGE_KEY 等），代码里不出现任何 Key；缺 Key 时接口回 503，不静默假成功。
 *   · **限流** = 每账号 60 次/分、图像 10 次/分、单 IP 120 次/分（env 可调可关）。
 *   · 本模块不碰路由（server.mjs 只做一行转发）、不碰账户存储（写余额一律经 wallet），
 *     所以它可以被冒烟脚本拿一个 mock 上游直接验证。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import { subCentsOf, totalCentsOf, round8, yuanOfCents, centsOfYuan } from "./wallet.mjs";

/* ========================================================================== *
 * 一、默认口径（全部可被 MTNODE_RELAY_CONFIG 指向的 JSON 文件与 env 覆盖）
 * ========================================================================== */

/** 模型白名单：模型名默认原样透传（要换上游名时写 upstreamModel）。 */
const DEFAULT_MODELS = [
  { id: "deepseek-flash", upstream: "text", upstreamId: "deepseek" },
  { id: "deepseek-v4-pro", upstream: "text", upstreamId: "deepseek" },
  // 旧模型名（官方文档：deepseek-v4-flash / -vision-exp 仍可调用，按 Flash 计费）
  { id: "deepseek-v4-flash", upstream: "text", upstreamId: "deepseek", upstreamModel: "deepseek-flash" },
  { id: "gpt-image-2.5-vip", upstream: "image", upstreamId: "image" },
  { id: "gpt-image-2.5-sunburst-vip", upstream: "image", upstreamId: "image" },
  { id: "gpt-image-2.5-flare-vip", upstream: "image", upstreamId: "image" },
  { id: "gpt-image-2-vip", upstream: "image", upstreamId: "image" },
];

/**
 * 默认价表（**元 / 百万 tokens** 与 **元 / 张**）—— 数字取自官方价目页，改价不必改代码：
 *   · DeepSeek（https://api-docs.deepseek.com/zh-cn/quick_start/pricing）：
 *     deepseek-flash 缓存命中 0.02 / 未命中 1 / 输出 4；deepseek-v4-pro 0.15 / 4.5 / 13.5。
 *     高峰价为空闲价的 2 倍；高峰时段 = 北京时间周一至周五 9:00-12:00、14:00-18:00
 *     （中国法定节假日官方算空闲价，代码无法自行判断，用 MTNODE_RELAY_PEAK_OFF 列日期补上）。
 *   · gpt-image-2.5-vip 家族：上游报价 0.03 美元/张，按固定 1 美元 = 7 元折成 **0.21 元/张**
 *     （每次调用即计费，与尺寸无关）；界面与接口只出现元，不再出现美元与汇率。
 */
const LEGACY_USD_CNY = 7; // 只用于把旧配置里的 perImageUsd 读成元/张（一次性兼容），新配置不含美元
const DEFAULT_PRICES = {
  "deepseek-flash": { kind: "text", cacheHit: 0.02, cacheMiss: 1, output: 4, peakMultiplier: 2 },
  "deepseek-v4-pro": { kind: "text", cacheHit: 0.15, cacheMiss: 4.5, output: 13.5, peakMultiplier: 2 },
  "deepseek-v4-flash": { kind: "text", cacheHit: 0.02, cacheMiss: 1, output: 4, peakMultiplier: 2 },
  "gpt-image-2.5-vip": { kind: "image", perImageYuan: 0.21 },
  "gpt-image-2.5-sunburst-vip": { kind: "image", perImageYuan: 0.21 },
  "gpt-image-2.5-flare-vip": { kind: "image", perImageYuan: 0.21 },
  "gpt-image-2-vip": { kind: "image", perImageYuan: 0.21 },
};

/** 默认上游列表（管理台可增删改；env 只作首次缺省与 Key 兜底，见 loadConfig）。 */
const DEFAULT_UPSTREAM_LIST = [
  {
    id: "deepseek",
    name: "DeepSeek",
    kind: "text",
    base: "https://api.deepseek.com",
    key: "",
    keyEnv: "MTNODE_RELAY_DEEPSEEK_KEY",
    baseEnv: "MTNODE_RELAY_DEEPSEEK_BASE",
    timeoutMs: 300000,
  },
  {
    id: "image",
    /* 显示名只作管理台可读标签；这一路的上游是第三方图像聚合服务（地址与 Key 由部署侧
       用 MTNODE_RELAY_IMAGE_BASE / MTNODE_RELAY_IMAGE_KEY 给，见 relay.env.example）。 */
    name: "第三方图像聚合",
    kind: "image",
    base: "https://api.apiyi.com/v1",
    key: "",
    keyEnv: "MTNODE_RELAY_IMAGE_KEY",
    baseEnv: "MTNODE_RELAY_IMAGE_BASE",
    timeoutMs: 600000,
  },
];

/* 鲸圆币汇率（1 币 = ¥0.02）：客户端把中转费用按币显示靠它换算。
   它是**中转侧的计费单位口径**，所以由中转站随快照下发（唯一真源），
   客户端 renderer/app-whalecoin.js 里的同值只作模块缺席时的兜底。 */
const COIN_YUAN = 0.02;

/* 金额精度（对外元的小数位）：**8 位 = 1e-8 元**。
   修正前是 4 位（1e-4 元），低于 1e-4 元的费用会被 round 掉、且小请求计费偏差明显
   （deepseek-flash 缓存命中价 0.02 元/百万 token，一次小额调用本就算得出 1e-7 量级）。
   随 describeAdmin / 管理台配置一起下发，客户端据此决定按几位小数显示（旧服务端不给也无妨）。 */
const YUAN_PRECISION = 8;

const DEFAULT_QUOTA = { accountPerMin: 60, imagePerMin: 10, ipPerMin: 120 };
const USAGE_KEEP = 5000; // relayUsage 全局保留条数（明细只用于自查与排查，不参与对账）
const AUDIT_KEEP = 500; // relayAudit 保留条数（谁 / 何时 / 改了哪项）
const TEST_KEY_TTL_MS = 30 * 60 * 1000; // 管理台会话测试的临时 Key 有效期（30 分钟）
const TEST_KEY_PREFIX = "mtr_test_"; // 前缀便于日志里一眼认出是测试流量

function envName(v) {
  return String(process.env[v] == null ? "" : process.env[v]).trim();
}
function envInt(v, dflt) {
  const s = envName(v);
  if (!s) return dflt; // 未配置 ≠ 0：0 在这些键上是「关闭」的意思，不能靠 Number("") === 0 误判
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : dflt;
}
function stripSlash(s) {
  return String(s || "").trim().replace(/\/+$/, "");
}
// round8 来自 wallet.mjs：计费精度 = 8 位小数（1e-8 元），元与分共用同一套口径，不在这里再定义一份
function parseJsonLoose(raw, dflt) {
  const s = String(raw == null ? "" : raw).trim();
  if (!s) return dflt;
  try {
    return JSON.parse(s);
  } catch {
    return dflt;
  }
}
/** 上游 id / 模型 id 的公共形状（宽松，缺省补 slug）。 */
function slug(s, dflt) {
  const t = String(s == null ? "" : s).trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
  return t || dflt;
}
/** Key 只留后四位用于界面辨认（明文永不出库）。 */
function keyTail(key) {
  const s = String(key || "").trim();
  return s ? s.slice(-4) : "";
}

/** 模型条目归一：字符串 = 模型名（按家族特征词判文字 / 图像）。 */
function normModel(entry) {
  const o = typeof entry === "string" ? { id: entry } : entry && typeof entry === "object" ? entry : null;
  if (!o) return null;
  const id = String(o.id || o.model || "").trim();
  if (!id) return null;
  const upstream = o.upstream === "image" || o.upstream === "text"
    ? o.upstream
    : /gpt-image|dall-e|dalle|flux|seedream|qwen-image/i.test(id) ? "image" : "text";
  const out = {
    id,
    upstream,
    upstreamModel: String(o.upstreamModel || o.upstream_model || id).trim() || id,
    note: String(o.note || "").trim(),
    enabled: o.enabled === false || o.off === true ? false : true,
  };
  const uid = slug(o.upstreamId || o.upstream_id, "");
  if (uid) out.upstreamId = uid;
  return out;
}

/** 价表条目归一：文本价 元/百万 token，图像价 **元/张**（不再有美元与汇率）。 */
function normPrice(entry, kind) {
  const o = entry && typeof entry === "object" ? entry : {};
  const k = o.kind === "image" || o.kind === "text" ? o.kind : kind;
  const num = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : 0);
  if (k === "image") {
    /* 兼容旧配置：老字段 perImageUsd（美元/张）按 1 美元 = 7 元换算成元/张读入，
       之后一律只认 perImageYuan；界面与接口都不再出现美元。 */
    const legacy = o.perImageUsd != null ? o.perImageUsd : o.per_image_usd;
    const yuan = o.perImageYuan != null ? o.perImageYuan : (o.per_image_yuan != null ? o.per_image_yuan : null);
    return { kind: "image", perImageYuan: yuan != null ? num(yuan) : round8(num(legacy) * LEGACY_USD_CNY) };
  }
  return {
    kind: "text",
    cacheHit: num(o.cacheHit != null ? o.cacheHit : o.cache_hit),
    cacheMiss: num(o.cacheMiss != null ? o.cacheMiss : o.cache_miss),
    output: num(o.output),
    peakMultiplier: num(o.peakMultiplier != null ? o.peakMultiplier : o.peak_multiplier) || 1,
  };
}

/**
 * 上游归一。key 的来路三选一（优先级从低到高）：默认空 → env(keyEnv) → db 行上的 key。
 * env 的 Key 只读，**绝不写回 db.json、绝不回传界面**；界面只显示「已配 + 后四位」。
 */
function normUpstream(entry, cur) {
  const o = entry && typeof entry === "object" ? entry : {};
  const id = slug(o.id, "");
  if (!id) return null;
  const kind = o.kind === "image" || o.kind === "text" ? o.kind : cur && cur.kind === "image" ? "image" : "text";
  const keyEnv = String(o.keyEnv || (cur && cur.keyEnv) || "").trim();
  const baseEnv = String(o.baseEnv || (cur && cur.baseEnv) || "").trim();
  const dbKey = String(o.key != null ? o.key : (cur && cur.key) || "").trim();
  const envKey = keyEnv ? envName(keyEnv) : "";
  const key = dbKey || envKey;
  const baseEnvVal = baseEnv ? envName(baseEnv) : "";
  return {
    id,
    name: String(o.name || (cur && cur.name) || id).trim() || id,
    kind,
    base: stripSlash(String(o.base != null ? o.base : (cur && cur.base) || "").trim() || baseEnvVal),
    key,
    keyFrom: dbKey ? "db" : envKey ? "env" : "",
    keyTail: keyTail(key),
    keyEnv,
    baseEnv,
    timeoutMs: Math.max(1000, Math.floor(Number(o.timeoutMs != null ? o.timeoutMs : (cur && cur.timeoutMs)) || 300000)),
    enabled: o.enabled === false ? false : true,
  };
}

/** 组装最终配置：默认 → env（首次缺省 / Key 兜底）→ db.relayConfig（权威，热生效）。 */
function loadConfig(db) {
  const cfg = {
    upstreams: DEFAULT_UPSTREAM_LIST.map((u) => normUpstream(u, null)).filter(Boolean),
    models: DEFAULT_MODELS.map(normModel).filter(Boolean),
    prices: Object.assign({}, DEFAULT_PRICES),
    quota: Object.assign({}, DEFAULT_QUOTA),
    peaks: [],
    configFile: "",
    source: "default",
    /* 对外金额精度（元的小数位 = 8 = 1e-8 元）：配置层的只读常量，随 describeAdmin /
       /api/relay/me / /relay/v1/usage 下发给管理台与客户端。 */
    yuanPrecision: YUAN_PRECISION,
    coinYuan: COIN_YUAN,
  };

  // ── 旧版整包 JSON（MTNODE_RELAY_CONFIG）仍然兼容：只作缺省层。
  const file = envName("MTNODE_RELAY_CONFIG");
  if (file) {
    cfg.configFile = file;
    const j = parseJsonLoose(fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "", null);
    if (j && typeof j === "object") {
      applyConfigDoc(cfg, j, { keepKeys: true });
    } else {
      console.warn("[relay] MTNODE_RELAY_CONFIG 读不到或不是 JSON，已忽略：" + file);
    }
  }

  // ── env：上游地址 / Key / 超时
  //    base 与 timeout：env 是「缺省层」，永远生效（旧口径就是 env 覆盖默认地址）。
  //    key：env 只兜底（db 行上没填才用）；env 的 Key 绝不写回 db.json、绝不回传界面。
  for (const u of cfg.upstreams) {
    if (u.baseEnv) {
      const b = envName(u.baseEnv);
      if (b) u.base = stripSlash(b);
    }
    if (u.keyEnv && !u.key) {
      const k = envName(u.keyEnv);
      if (k) {
        u.key = k;
        u.keyFrom = "env";
        u.keyTail = keyTail(k);
      }
    }
    const to = envInt("MTNODE_RELAY_" + u.id.toUpperCase().replace(/[^A-Z0-9]+/g, "_") + "_TIMEOUT_MS", 0);
    if (to > 0) u.timeoutMs = to;
  }

  // ── env：模型白名单 / 价表 / 限流
  const modelsEnv = envName("MTNODE_RELAY_MODELS");
  if (modelsEnv) {
    const raw = modelsEnv.startsWith("[") ? parseJsonLoose(modelsEnv, null) : modelsEnv.split(/[,;\s]+/).filter(Boolean);
    const list = (Array.isArray(raw) ? raw : []).map(normModel).filter(Boolean);
    if (list.length) cfg.models = list;
    else console.warn("[relay] MTNODE_RELAY_MODELS 解析为空，沿用默认白名单");
  }
  const pricesEnv = parseJsonLoose(envName("MTNODE_RELAY_PRICES"), null);
  if (pricesEnv && typeof pricesEnv === "object") {
    for (const [id, p] of Object.entries(pricesEnv)) {
      const kind = (cfg.models.find((m) => m.id === id) || {}).upstream || (cfg.prices[id] || {}).kind || "text";
      cfg.prices[id] = normPrice(p, kind);
    }
  }
  const usd = Number(envName("MTNODE_RELAY_USD_CNY"));
  if (Number.isFinite(usd) && usd > 0) {
    console.warn("[relay] MTNODE_RELAY_USD_CNY 已废弃（图像价目改为直接填元/张，不再用汇率），该变量被忽略");
  }
  cfg.quota.accountPerMin = envInt("MTNODE_RELAY_ACCOUNT_PER_MIN", cfg.quota.accountPerMin);
  cfg.quota.imagePerMin = envInt("MTNODE_RELAY_IMAGE_PER_MIN", cfg.quota.imagePerMin);
  cfg.quota.ipPerMin = envInt("MTNODE_RELAY_IP_PER_MIN", cfg.quota.ipPerMin);
  const peaks = envName("MTNODE_RELAY_PEAK_OFF");
  if (peaks) cfg.peaks = cfg.peaks.concat(peaks.split(/[,;\s]+/).filter(Boolean));

  // ── db.relayConfig（管理台保存的那份）：权威层，覆盖上面所有缺省。
  const saved = db && db.relayConfig && typeof db.relayConfig === "object" ? db.relayConfig : null;
  if (saved) {
    cfg.source = "db";
    applyConfigDoc(cfg, saved, { keepKeys: false });
  }

  // 价目兜底：白名单里没有价目的模型补 0 价（能调、不扣费，只在日志里提示）
  for (const m of cfg.models) {
    if (!cfg.prices[m.id]) cfg.prices[m.id] = normPrice({}, m.upstream);
  }
  // 模型行绑定的上游 id 缺失（老配置 / 手写 JSON）→ 按通道挑第一个可用的
  for (const m of cfg.models) {
    if (!m.upstreamId) m.upstreamId = defaultUpstreamId(cfg, m.upstream);
  }
  // 上游 id 重名去重（手写配置 / 并发保存的兜底）
  const seen = new Set();
  cfg.upstreams = cfg.upstreams.filter((u) => (seen.has(u.id) ? false : (seen.add(u.id), true)));
  return cfg;
}

/** 挑该通道缺省上游：优先启用且配了 Key 的，其次第一个同通道的。 */
function defaultUpstreamId(cfg, kind) {
  const same = (cfg.upstreams || []).filter((u) => u.kind === kind);
  const pick = same.find((u) => u.enabled !== false && u.key) || same.find((u) => u.enabled !== false) || same[0];
  return pick ? pick.id : "";
}

/**
 * 把一份配置文档（旧版 JSON 或 db.relayConfig）合进 cfg。
 * keepKeys=true 时只填补空白（env / 文件作缺省层）；false 时整份替换（db 作权威层）。
 */
function applyConfigDoc(cfg, doc, opts) {
  const keepKeys = !!(opts && opts.keepKeys);
  // 权威层（db.relayConfig）：价目整份换成这一份的值，不留旧模型的陈价
  if (!keepKeys) cfg.prices = {};
  // 上游：数组形态（新）或 {text:…, image:…} 对象形态（旧）
  const incoming = [];
  if (Array.isArray(doc.upstreams)) {
    for (const u of doc.upstreams) incoming.push(u);
  } else if (doc.upstreams && typeof doc.upstreams === "object") {
    for (const [k, u] of Object.entries(doc.upstreams)) {
      if (u && typeof u === "object") incoming.push(Object.assign({ id: k, kind: k === "image" ? "image" : "text", name: u.label }, u));
    }
  }
  if (incoming.length) {
    if (!keepKeys) cfg.upstreams = [];
    const list = [];
    for (const raw of incoming) {
      const id = slug(raw && (raw.id || raw.name), "");
      if (!id) continue;
      const cur = cfg.upstreams.find((x) => x.id === id) || null;
      const next = normUpstream(raw, cur);
      if (!next) continue;
      // 缺省层：不覆盖已经由默认 / env 定好的地址与 Key
      if (keepKeys && cur) {
        if (!next.base) next.base = cur.base;
        if (!next.key) {
          next.key = cur.key;
          next.keyFrom = cur.keyFrom;
          next.keyTail = cur.keyTail;
        }
      }
      list.push(next);
    }
    if (list.length) {
      if (!keepKeys) cfg.upstreams = list;
      else {
        for (const u of list) {
          const i = cfg.upstreams.findIndex((x) => x.id === u.id);
          if (i >= 0) cfg.upstreams[i] = Object.assign(cfg.upstreams[i], u);
          else cfg.upstreams.push(u);
        }
      }
    }
  }
  if (Array.isArray(doc.models)) {
    const list = doc.models.map(normModel).filter(Boolean);
    if (list.length || !keepKeys) cfg.models = list;
  }
  if (doc.prices && typeof doc.prices === "object") {
    for (const [id, p] of Object.entries(doc.prices)) {
      const kind = (cfg.models.find((m) => m.id === id) || {}).upstream || (cfg.prices[id] || {}).kind || "text";
      cfg.prices[id] = normPrice(p, kind);
    }
  }
  // 价目也允许直接挂在模型行上（管理台保存的形态就是 models[].price）
  if (Array.isArray(doc.models) && !keepKeys) {
    for (const m of doc.models) {
      const o = m && typeof m === "object" ? m : {};
      const id = String(o.id || o.model || "").trim();
      if (!id || !o.price || typeof o.price !== "object") continue;
      const kind = o.upstream === "image" ? "image" : (cfg.models.find((x) => x.id === id) || {}).upstream || "text";
      cfg.prices[id] = normPrice(o.price, kind);
    }
  }
  if (doc.quota && typeof doc.quota === "object") {
    for (const k of ["accountPerMin", "imagePerMin", "ipPerMin"]) {
      if (Number.isFinite(Number(doc.quota[k])) && Number(doc.quota[k]) >= 0) cfg.quota[k] = Math.floor(Number(doc.quota[k]));
    }
  }
  if (Array.isArray(doc.peaks)) {
    const list = doc.peaks.map((s) => String(s).trim()).filter(Boolean);
    if (list.length || !keepKeys) cfg.peaks = list;
  }
}

/** 配置文档的即时校验（管理台保存前跑；返回 [] 表示可存）。 */
function validateConfigDoc(doc) {
  const errs = [];
  const list = Array.isArray(doc.upstreams) ? doc.upstreams : [];
  if (!list.length) errs.push("至少保留一个上游");
  const ids = new Set();
  list.forEach((u, i) => {
    const at = "上游 #" + (i + 1);
    const id = slug(u && (u.id || u.name), "");
    if (!id) errs.push(at + "：缺少 id / 名称");
    else if (ids.has(id)) errs.push(at + "：id 重复（" + id + "）");
    else ids.add(id);
    if (!stripSlash(u && u.base)) errs.push(at + "（" + (id || "?") + "）：Base URL 不能为空");
    if (!String((u && u.key) || "").trim() && !String((u && u.keyEnv) || "").trim()) {
      errs.push(at + "（" + (id || "?") + "）：既没有 Key，也没有可兜底的环境变量名");
    }
    if (u && u.kind !== "text" && u.kind !== "image") errs.push(at + "（" + (id || "?") + "）：通道只能是 text / image");
  });
  const models = Array.isArray(doc.models) ? doc.models : [];
  const mids = new Set();
  models.forEach((m, i) => {
    const at = "模型 #" + (i + 1);
    const id = String((m && (m.id || m.model)) || "").trim();
    if (!id) errs.push(at + "：缺少模型 id");
    else if (mids.has(id)) errs.push(at + "：模型 id 重复（" + id + "）");
    else mids.add(id);
    if (m && !String(m.upstreamModel || "").trim()) errs.push("模型 " + (id || "?") + "：缺少上游模型名");
    if (m && !slug(m.upstreamId, "")) errs.push("模型 " + (id || "?") + "：未绑定上游");
    else if (m && slug(m.upstreamId, "") && !ids.has(slug(m.upstreamId, ""))) {
      errs.push("模型 " + (id || "?") + "：绑定的上游 " + m.upstreamId + " 不存在");
    }
  });
  return errs;
}

/* ========================================================================== *
 * 二、高峰时段判定（只影响 DeepSeek 文本价）
 * ========================================================================== */

/** 北京时间周一至周五 9:00-12:00 / 14:00-18:00（可用 MTNODE_RELAY_PEAK_OFF 列节假日）。 */
function isPeak(atMs, peaks) {
  const bj = new Date(Number(atMs) + 8 * 3600 * 1000);
  const day = bj.getUTCDay(); // 0=周日
  if (day === 0 || day === 6) return false;
  const ymd = bj.toISOString().slice(0, 10);
  if ((peaks || []).indexOf(ymd) >= 0) return false;
  const h = bj.getUTCHours();
  return (h >= 9 && h < 12) || (h >= 14 && h < 18);
}

/* ========================================================================== *
 * 三、费用计算（按「元」算到底，**8 位小数 = 1e-8 元**；写账本时才换算成分）
 * ========================================================================== */

/**
 * 文本费用：上游 usage → 元。没有 usage 返回 null（= 不扣费）。
 *
 * **三项 token 口径**（需求 2）：输出 `outputTokens`、缓存命中 `cacheHitTokens`、
 * 缓存未命中 `cacheMissTokens`，并给出 `inputTokens = hit + miss`（= prompt 总量）。
 * 上游拆分字段的兼容（DeepSeek 官方 → 主流 OpenAI 兼容服务商）：
 *   · 命中：prompt_cache_hit_tokens / cache_hit_tokens / cache_read_input_tokens / prompt_cache_hit
 *   · 未命中：prompt_cache_miss_tokens / cache_miss_tokens / cache_creation_input_tokens / prompt_cache_miss
 *   · 总量：prompt_tokens / input_tokens
 * 只给了总量（没拆缓存）时未命中 = 总量（全部按未命中价，与修正前一致）；
 * 只给了命中时未命中 = 总量 − 命中（**不再把命中重复计一遍** —— 修正前缺总量兜底，
 * 会出现「miss=0、hit=全部」而漏扣未命中部分）。三者都是 0 且总量为 0 → 不扣费。
 */
function textCostYuan(cfg, model, usage, atMs) {
  if (!usage || typeof usage !== "object") return null;
  const price = cfg.prices[model] || normPrice({}, "text");
  const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0);
  const pick = (a, b, c, d) => {
    for (const k of [a, b, c, d]) if (usage[k] != null) return usage[k];
    return null;
  };
  const out = num(pick("completion_tokens", "output_tokens", null, null));
  const prompt = num(pick("prompt_tokens", "input_tokens", null, null));
  const hitRaw = pick("prompt_cache_hit_tokens", "cache_hit_tokens", "cache_read_input_tokens", "prompt_cache_hit");
  const missRaw = pick("prompt_cache_miss_tokens", "cache_miss_tokens", "cache_creation_input_tokens", "prompt_cache_miss");
  let hit = num(hitRaw);
  let miss = num(missRaw);
  if (!hitRaw && !missRaw) miss = prompt; // 上游不拆缓存：全部按未命中价
  else if (!missRaw) miss = prompt > hit ? prompt - hit : 0; // 只给了命中：未命中 = 总量 − 命中
  else if (!hitRaw) hit = prompt > miss ? prompt - miss : 0; // 只给了未命中：命中 = 总量 − 未命中
  if (!hit && !miss && !out) return null;
  const peak = isPeak(atMs, cfg.peaks) ? price.peakMultiplier || 1 : 1;
  const yuan = ((hit * price.cacheHit + miss * price.cacheMiss + out * price.output) / 1e6) * peak;
  return {
    yuan: round8(yuan),
    detail: {
      cacheHitTokens: hit,
      cacheMissTokens: miss,
      inputTokens: hit + miss,
      outputTokens: out,
      peak: peak > 1,
      yuan: round8(yuan),
    },
  };
}

/** 图像费用：上游不返 usage，按「张数 × 元/张」计（每次调用即计费，失败不算）。 */
function imageCostYuan(cfg, model, images) {
  const price = cfg.prices[model] || normPrice({}, "image");
  const n = Math.max(1, Math.floor(Number(images) || 1));
  const yuan = n * (price.perImageYuan || 0);
  return { yuan: round8(yuan), detail: { images: n, perImageYuan: round8(price.perImageYuan || 0) } };
}

/**
 * 这一次图像请求要出几张（**调用前估算用**，与出图后 imageCostYuan 的张数口径一致）：
 * 上游 OpenAI 兼容接口用 `n` 指定张数（缺省 1）；客户端也可能直接传 `count`。
 * multipart（images/edits）的 `n` 在表单字段里，按 name 取，找不到按 1 张。
 * 出图后仍以上游真实返回的 data.length 为准（见 handleImages）。
 */
function imageCountOf(raw, isEdit) {
  const one = (v) => {
    const n = Math.floor(Number(v) || 0);
    return n > 1 ? n : 1;
  };
  if (isEdit) {
    const m = /name="(?:n|count)"\r?\n\r?\n([^\r\n]+)/.exec(raw.toString("latin1"));
    return one(m ? m[1].trim() : 1);
  }
  try {
    const j = JSON.parse(raw.toString("utf8") || "{}") || {};
    return one(j.n != null ? j.n : j.count);
  } catch {
    return 1;
  }
}

/* ========================================================================== *
 * 四、中转站本体
 * ========================================================================== */

/**
 * @param {object} deps
 * @param {object} deps.db          server.mjs 的内存库（读写 relayConfig / relayUsage / relayAudit，落盘交给 saveDb）
 * @param {() => Promise<void>} deps.saveDb
 * @param {object} deps.wallet      createWallet 的实例（写余额 / 记 relay 流水唯一入口）
 * @param {(req) => Promise<Buffer>} deps.readBody  原样读请求体（multipart 也要）
 * @param {(user, opt) => Promise<{token,expiresAt}>} deps.issueSession 管理台测试 Key 的发放入口（server.mjs 注入）
 * @param {string} deps.publicBase  对外 Base URL（下发给客户端，如 https://www.mt-agent.com/mtnode/store-api）
 */
export function createRelay(deps) {
  const db = deps.db;
  const saveDb = typeof deps.saveDb === "function" ? deps.saveDb : async () => {};
  const wallet = deps.wallet;
  const readBody = typeof deps.readBody === "function" ? deps.readBody : null;
  if (!readBody) throw new Error("createRelay 需要注入 readBody");

  const cfg = loadConfig(db);
  const modelBy = new Map(cfg.models.map((m) => [m.id, m]));

  /** 重算配置并刷新模型索引（管理台保存后热生效，不重启服务）。 */
  function reload() {
    const next = loadConfig(db);
    for (const k of Object.keys(cfg)) delete cfg[k];
    Object.assign(cfg, next);
    modelBy.clear();
    for (const m of cfg.models) modelBy.set(m.id, m);
    return cfg;
  }

  /** 找模型绑定的上游（缺省按通道挑一个启用的；没有就报可执行的错）。 */
  function upstreamOf(m) {
    const list = cfg.upstreams || [];
    if (m && m.upstreamId) {
      const hit = list.find((u) => u.id === m.upstreamId);
      if (hit) return hit;
    }
    const same = list.filter((u) => u.kind === m.upstream);
    return same.find((u) => u.enabled !== false && u.key) || same.find((u) => u.enabled !== false) || same[0] || null;
  }
  const UID_RE = /^[a-z0-9][a-z0-9_.-]{0,39}$/;
  const OK_TIMEOUT = (n) => Math.max(1000, Math.min(3600000, Math.floor(Number(n) || 0)));

  /* ---------- 在途预留（图像调用的原子门禁） ----------
     图像费用在**调用前**就算得出来（张数 × 元/张），所以门禁必须按应付额拦，而不是
     只看「余额 > 0」：否则余额 0.10 也能出一张 0.21 的图，结算时只能按可用额夹紧，
     余额被扣到 0 就不再是「欠着」而是「白出一张」。
     并发也不能只靠「读一次余额」：两张图同时进来会各自看到同一个余额、双双通过。
     这里给每账号做**原子预留**（同一 tick 内 computeLiveCents → 写入 reserved 之间没有 await，
     所以 Node 单线程下不会穿插）：预留成功才转上游，结算时本次扣除上限 = 预留额，
     上游失败 / 报错立即释放。纯内存：预留只活在一次请求的几十秒内，进程重启即清空。 */
  const reserved = new Map(); // userId -> [{ id, cents, at }]
  const RESERVE_STALE_MS = 10 * 60 * 1000;

  /** 该账号已预留的在途费用（分）。顺带清掉过期的（进程被强杀时兜底）。 */
  function reservedCentsOf(userId, atMs) {
    const t = Number(atMs) || Date.now();
    const arr = reserved.get(userId) || [];
    let sum = 0;
    for (const r of arr) {
      if (t - (Number(r.at) || 0) > RESERVE_STALE_MS) continue; // 过期：视作已释放（下面顺手清）
      sum += Number(r.cents) || 0;
    }
    return round8(sum);
  }
  function sweepReserved(atMs) {
    const t = Number(atMs) || Date.now();
    for (const [uid, arr] of reserved) {
      const keep = arr.filter((r) => t - (Number(r.at) || 0) <= RESERVE_STALE_MS);
      if (keep.length) reserved.set(uid, keep);
      else reserved.delete(uid);
    }
  }

  /** **可用**余额（分）= 账上可用总额 − 在途预留。门禁与结算上限都读它。 */
  function liveCentsOf(user) {
    const u = (db.users || []).find((x) => x.id === (user && user.id)) || user;
    return round8(totalCentsOf(u) - reservedCentsOf(u && u.id));
  }

  /**
   * 原子预留一笔应付额（分）：成功回 { ok:true, id, cents }，不足回 { ok:false, ... }。
   * 调用方必须配 try/finally 调 releaseReserve（上游报错 / 客户端断开 / 结算异常都要释放）。
   */
  function reserveImageCharge(userId, cents) {
    sweepReserved();
    const uid = String(userId || "");
    const need = round8(cents);
    if (!uid || !(need > 0)) return { ok: true, id: "", cents: 0 };
    const avail = liveCentsOf((db.users || []).find((u) => u.id === uid) || { id: uid });
    if (avail < need) return { ok: false, id: "", cents: need, availCents: avail };
    const hold = { id: "rs" + Date.now().toString(36) + crypto.randomBytes(3).toString("hex"), cents: need, at: Date.now() };
    const arr = reserved.get(uid) || [];
    arr.push(hold);
    reserved.set(uid, arr);
    return { ok: true, id: hold.id, cents: need };
  }

  /** 释放预留（按 id 精确删，重复释放无副作用）。 */
  function releaseReserve(userId, reserveId) {
    const uid = String(userId || "");
    const id = String(reserveId || "");
    if (!uid || !id) return;
    const arr = reserved.get(uid);
    if (!arr) return;
    const keep = arr.filter((r) => r.id !== id);
    if (keep.length) reserved.set(uid, keep);
    else reserved.delete(uid);
  }

  /** 图像调用的应付额（元）：张数 × 元/张（缺省 1 张）。为 0（没配价目）时不拦。 */
  function imageReserveYuan(model, images) {
    const price = cfg.prices[model] || normPrice({}, "image");
    const n = Math.max(1, Math.floor(Number(images) || 1));
    return round8(n * (Number(price.perImageYuan) || 0));
  }

  /** 余额不足的统一文案（余额 / 应付额都按元给，用户一眼知道还差多少）。 */
  function imageShortMessage(user, needYuan) {
    return "账号余额不足（当前可用 " + yuanText(yuanOfCents(liveCentsOf(user)), 4) +
      " 元，本次需 " + yuanText(needYuan, 4) + " 元）：请充值后再试";
  }

  /** 管理台读配置：绝不含任何 Key 材料（只有 keyFrom / keyTail）。 */
  function describeAdmin() {
    return {
      upstreams: (cfg.upstreams || []).map((u) => ({
        id: u.id,
        name: u.name,
        kind: u.kind,
        base: u.base,
        timeoutMs: u.timeoutMs,
        enabled: u.enabled !== false,
        keyFrom: u.keyFrom,
        keyTail: u.keyTail,
        keyEnv: u.keyEnv,
        baseEnv: u.baseEnv,
        models: (cfg.models || []).filter((m) => m.upstreamId === u.id).map((m) => m.id),
      })),
      models: (cfg.models || []).map((m) => {
        const p = cfg.prices[m.id] || normPrice({}, m.upstream);
        return Object.assign({}, m, { price: p, priceDefault: priceEqualsDefault(m.id, p) });
      }),
      quota: Object.assign({}, cfg.quota),
      peaks: (cfg.peaks || []).slice(),
      source: cfg.source,
      configFile: cfg.configFile,
      modelsEndpoint: "/relay/v1/models",
      /* 对外金额精度（元的小数位 = 8）：管理台据此决定表格显示几位、
         且不把小于 1e-8 元的费用写成 3e-9 这种科学计数法。 */
      yuanPrecision: YUAN_PRECISION,
      coinYuan: COIN_YUAN,
    };
  }

  function priceEqualsDefault(id, p) {
    const d = DEFAULT_PRICES[id];
    if (!d) return false;
    return JSON.stringify(normPrice(d, p.kind)) === JSON.stringify(normPrice(p, p.kind));
  }

  function auditArr() {
    if (!Array.isArray(db.relayAudit)) db.relayAudit = [];
    return db.relayAudit;
  }

  /**
   * 管理台保存整份配置（先校验，再落 db.relayConfig 并热生效）。
   * @param {object} docRaw  {upstreams, models, prices, quota, peaks}
   * @param {object} who     {id, username, nickname}
   */
  async function adminSaveConfig(docRaw, who) {
    const doc = docRaw && typeof docRaw === "object" ? docRaw : {};
    const upstreams = (Array.isArray(doc.upstreams) ? doc.upstreams : []).map((u) => {
      const o = u && typeof u === "object" ? u : {};
      const cur = (cfg.upstreams || []).find((x) => x.id === slug(o.id, "")) || null;
      // 界面不回传明文：没给新 key 就沿用库里那份（绝不用 env 的 Key 去顶替）
      const dbKey = String(o.key || "").trim() || (cur ? cur.keyFrom === "db" ? cur.key : "" : "");
      return Object.assign({}, o, { id: slug(o.id, ""), key: dbKey, enabled: o.enabled !== false });
    });
    const models = (Array.isArray(doc.models) ? doc.models : []).map((m) => {
      const o = m && typeof m === "object" ? m : {};
      const kind = o.upstream === "image" ? "image" : "text";
      const price = normPrice(o.price, kind);
      return Object.assign({}, o, { id: String(o.id || "").trim(), upstream: kind, price: price, enabled: o.enabled !== false });
    });
    const clean = {
      upstreams: upstreams,
      models: models,
      quota: Object.assign({}, cfg.quota, doc.quota && typeof doc.quota === "object" ? doc.quota : {}),
      peaks: Array.isArray(doc.peaks) ? doc.peaks.map((s) => String(s).trim()).filter(Boolean) : cfg.peaks,
    };
    const errs = validateConfigDoc(clean);
    if (errs.length) return { ok: false, errs: errs };
    const before = JSON.stringify(summarizeConfig());
    db.relayConfig = clean;
    await saveDb();
    reload();
    const after = JSON.stringify(summarizeConfig());
    if (before !== after) await pushAudit(who, "保存中转配置", before, after);
    return { ok: true, changed: before !== after, config: describeAdmin() };
  }

  /** 只记「改了哪些项」的摘要（不落 Key 材料）。 */
  function summarizeConfig() {
    return {
      upstreams: (cfg.upstreams || []).map((u) => ({ id: u.id, name: u.name, kind: u.kind, base: u.base, enabled: u.enabled !== false, hasKey: !!u.key, keyFrom: u.keyFrom, timeoutMs: u.timeoutMs })),
      models: (cfg.models || []).map((m) => ({ id: m.id, upstreamId: m.upstreamId, upstream: m.upstream, upstreamModel: m.upstreamModel, enabled: m.enabled !== false, price: cfg.prices[m.id] })),
      quota: cfg.quota,
      peaks: cfg.peaks,
    };
  }

  function diffConfig(before, after) {
    const a = parseJsonLoose(before, {}) || {};
    const b = parseJsonLoose(after, {}) || {};
    const out = [];
    const pick = (x) => (Array.isArray(x) ? x : []);
    const upA = new Map(pick(a.upstreams).map((u) => [u.id, u]));
    const upB = new Map(pick(b.upstreams).map((u) => [u.id, u]));
    for (const [id, u] of upB) {
      const p = upA.get(id);
      if (!p) out.push("新增上游 " + id + "（" + u.name + "）");
      else if (JSON.stringify(p) !== JSON.stringify(u)) out.push("修改上游 " + id);
    }
    for (const [id, u] of upA) if (!upB.has(id)) out.push("删除上游 " + id);
    const mA = new Map(pick(a.models).map((m) => [m.id, m]));
    const mB = new Map(pick(b.models).map((m) => [m.id, m]));
    for (const [id, m] of mB) {
      const p = mA.get(id);
      if (!p) out.push("上架模型 " + id);
      else if (JSON.stringify(p) !== JSON.stringify(m)) out.push("修改模型 " + id);
    }
    for (const [id] of mA) if (!mB.has(id)) out.push("下架模型 " + id);
    if (JSON.stringify(a.quota) !== JSON.stringify(b.quota)) out.push("修改限流");
    if (JSON.stringify(a.peaks) !== JSON.stringify(b.peaks)) out.push("修改高峰节假日");
    return out;
  }

  async function pushAudit(who, action, before, after) {
    const arr = auditArr();
    const rec = {
      at: Date.now(),
      userId: (who && who.id) || "",
      username: (who && (who.username || who.nickname)) || "",
      action: action,
      changes: diffConfig(before, after),
    };
    arr.push(rec);
    if (arr.length > AUDIT_KEEP) db.relayAudit = arr.slice(-AUDIT_KEEP);
    await saveDb();
    return rec;
  }

  /** 用某个上游（或直填地址 / Key）拉上游 /models 候选，供管理台勾选导入。 */
  async function adminListUpstreamModels(opts) {
    const o = opts || {};
    const up = o.upstreamId ? (cfg.upstreams || []).find((u) => u.id === o.upstreamId) : null;
    const base = stripSlash(o.base || (up && up.base) || "");
    const key = String(o.key || "").trim() || (up && up.key) || "";
    if (!base) return { ok: false, error: "上游 Base URL 为空" };
    if (!key) return { ok: false, error: "该上游还没有 Key（先在界面里填一次）" };
    try {
      const r = await fetch(base + "/models", { headers: { Authorization: "Bearer " + key, Accept: "application/json" } });
      const text = await r.text();
      if (!r.ok) return { ok: false, error: "上游 /models 回 HTTP " + r.status + "：" + text.slice(0, 300) };
      const j = parseJsonLoose(text, null);
      const list = j && Array.isArray(j.data) ? j.data : j && Array.isArray(j.models) ? j.models : [];
      const ids = list.map((x) => String((x && (x.id || x.name)) || x || "").trim()).filter(Boolean);
      const mine = new Set((cfg.models || []).map((m) => m.id));
      return { ok: true, base: base, count: ids.length, items: ids.map((id) => ({ id: id, added: mine.has(id) })) };
    } catch (e) {
      return { ok: false, error: "拉取上游模型失败：" + ((e && e.message) || e) };
    }
  }

  /** 给管理台会话测试发一张短时 Key（只对该管理员有效，30 分钟过期）。 */
  async function issueTestKey(user) {
    const issue = deps && deps.issueSession;
    if (typeof issue !== "function") return { ok: false, error: "服务端未注入发 Key 入口" };
    const out = await issue(user, { ttlMs: TEST_KEY_TTL_MS, prefix: TEST_KEY_PREFIX, relayTest: true });
    return Object.assign({ ok: true, expiresInSec: Math.floor(TEST_KEY_TTL_MS / 1000) }, out || {});
  }

  /** 该用户当前可用的模型清单（余额 ≤ 0 时为空数组：与门禁口径一致）。
   *  kind = **通道形态** text / image（不是上游 id）：客户端「MTNode 中转服务」这一张
   *  只读服务商卡靠它把每个模型分到文本 / 图像节点，别再把上游 id 当形态用
   *  （生产配置里上游 id 是 deepseek / image，客户端判不出来）。
   *
   *  price = **这个模型真正会按它扣费的价目**（normPrice 归一后的那一份）：客户端
   *  本地计价（Token 统计里的「中转按币」）与这里同源 —— 后台改价 / 改高峰倍率，
   *  客户端跟着变，不必发版。字段见 normPrice：文本 cacheHit / cacheMiss / output
   *  （元每百万 token）+ peakMultiplier（高峰倍率），图像 perImageYuan（元/张）。 */
  function userModels(user) {
    const fresh = (db.users || []).find((u) => u.id === (user && user.id)) || user;
    const total = totalCentsOf(fresh);
    if (total <= 0) return [];
    return (cfg.models || [])
      .filter((m) => m.enabled !== false && upstreamOf(m) && upstreamOf(m).enabled !== false)
      .map((m) => {
        const up = upstreamOf(m) || {};
        return {
          id: m.id,
          kind: up.kind === "image" ? "image" : "text",
          upstream: m.upstream,
          price: Object.assign({}, cfg.prices[m.id] || normPrice({}, m.upstream)),
        };
      });
  }

  /** 该账号**一张图的最低门槛**（元）：可用余额 < 它 ⇒ 图像调用必然 402（文本不受影响）。
   *  客户端拿它做前置置灰（额度为正但不够一张图时，不再等云端 402 才知道）。
   *  没有可用的图像模型（没配 / 没上架 / 没绑上游）时回 0 = 不用拦。 */
  function minImageYuan() {
    let min = 0;
    for (const m of cfg.models || []) {
      if (m.enabled === false || m.upstream !== "image") continue;
      const up = upstreamOf(m);
      if (!up || up.enabled === false) continue;
      const per = Number((cfg.prices[m.id] || normPrice({}, "image")).perImageYuan) || 0;
      if (!(per > 0)) continue;
      if (!min || per < min) min = per;
    }
    return round8(min);
  }

  /* ---------- 限流（60 秒滑窗，与 server.mjs 的单 IP 小时桶同思路） ---------- */
  const win = new Map(); // key -> number[]
  function take(key, max) {
    if (!max || max <= 0) return { ok: true, key, arr: null };
    const t = Date.now();
    const arr = (win.get(key) || []).filter((x) => t - x < 60000);
    if (arr.length >= max) return { ok: false, retryAfter: Math.max(1, Math.ceil((arr[0] + 60000 - t) / 1000)) };
    return { ok: true, key, arr };
  }
  function commit(g) {
    if (!g || !g.ok || !g.arr) return;
    g.arr.push(Date.now());
    win.set(g.key, g.arr);
    if (win.size > 4000) {
      const t = Date.now();
      for (const [k, arr] of win) {
        const keep = arr.filter((x) => t - x < 60000);
        if (keep.length) win.set(k, keep);
        else win.delete(k);
      }
    }
  }

  /* ---------- 响应小工具（一律 OpenAI 兼容错误体） ---------- */
  function corsHeaders() {
    return {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    };
  }
  function sendJson(res, status, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(status, Object.assign({ "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body), "Cache-Control": "no-store" }, corsHeaders()));
    res.end(body);
  }
  function sendError(res, status, message, code, type) {
    sendJson(res, status, { error: { message, type: type || "invalid_request_error", code: code || "", param: null } });
  }

  /* ---------- 用量明细（自查接口与排查用） ---------- */
  function usageList() {
    if (!Array.isArray(db.relayUsage)) db.relayUsage = [];
    return db.relayUsage;
  }
  function pushUsage(rec) {
    const arr = usageList();
    arr.push(rec);
    if (arr.length > USAGE_KEEP) arr.splice(0, arr.length - USAGE_KEEP);
    /* 用量明细**当场追加落盘 + fsync**：不再靠 saveDb 把整份 db.json 重写一遍
       （见 store-saas/hot-store.mjs 顶部注释）。落盘失败只记日志，不影响这一次调用。 */
    try {
      const w = hotAppendRows("relayUsage", [rec]);
      if (w && typeof w.catch === "function") w.catch(() => {});
    } catch (e) {
      console.error("[relay] 用量落盘失败：" + ((e && e.message) || String(e)));
    }
  }

  /* ---------- 金额文案（对外一律元；余额与卡片 4 位、明细 8 位、小于最小位给下限文案） ---------- */

  /** 金额的文本形态（**给流水备注与管理台用的唯一入口**）：
   *   · 0（含极小浮点噪声）→ "0"
   *   · 小于最小位 1e-8 元 → "<0.00000001"（**绝不写成 3e-9 这种科学计数法**）
   *   · 其余 → 定长小数、去掉末尾多余的 0（8 位 → "0.00000001"、4 位 → "0.005"、"5"）。
   *  digits 只允许 4（余额与统计卡片）或 8（明细与备注）。 */
  function yuanText(yuan, digits) {
    const n = Number(yuan);
    if (!Number.isFinite(n) || n === 0) return "0";
    const d = digits === 4 ? 4 : YUAN_PRECISION;
    const abs = Math.abs(n);
    const floor = Math.pow(10, -d);
    if (abs < floor) return "<" + floor.toFixed(d);
    const neg = n < 0 ? "-" : "";
    return neg + abs.toFixed(d).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
  }

  /** 一笔文本调用的 token 文案：三项分开列（命中 / 未命中 / 输出）。 */
  function tokenText(detail) {
    const d = detail && typeof detail === "object" ? detail : {};
    const hit = Number(d.cacheHitTokens) || 0;
    const miss = Number(d.cacheMissTokens) || 0;
    const out = Number(d.outputTokens) || 0;
    return "命中 " + hit + " / 未命中 " + miss + " / 出 " + out + " tokens";
  }

  /**
   * 扣费：入参是**本次费用（元，8 位小数 = 1e-8 元）**，换算成「分（可含亚分零头）」交给钱包；
   * 整数分 / 零头的拆分由 wallet.chargeRelayUsage 负责（金额口径只在一处实现）。
   * 扣除上限：`capCents` 给了就用它（**图像调用传预留额**：门禁已按应付额拦过，
   * 在途的其它预留不该把这一次的钱挪走），没给才按当前可用总额夹紧 ——
   * 文本按 token 计费、调用前算不出应付额，只能事后按余额夹紧（差额记进 shortfall，
   * 见 usage 明细与流水备注：**不允许出现负余额 / 欠费**）。
   * @param {object} [opt] { capCents } 本次扣除上限（分，含亚分）
   * @returns {Promise<{ok:boolean, chargedYuan:number, shortfallYuan:number, balanceYuan:number}>}
   */
  async function chargeYuan(userId, costYuan, note, meta, opt) {
    const user = (db.users || []).find((u) => u.id === userId);
    if (!user) return { ok: false, chargedYuan: 0, shortfallYuan: 0, balanceYuan: 0, code: "USER_NOT_FOUND" };
    const capGiven = opt && opt.capCents != null && Number.isFinite(Number(opt.capCents));
    const availCents = capGiven ? round8(Math.max(0, Number(opt.capCents))) : totalCentsOf(user); // 内部账（分，含亚分零头）
    const chargeCents = Math.max(0, centsOfYuan(costYuan));
    const payCents = Math.min(chargeCents, availCents);
    const shortfallCents = round8(chargeCents - payCents);
    const out = await wallet.chargeRelayUsage({
      user,
      amountCents: payCents,
      note: shortfallCents > 0 ? note + "（余额不足，按本次上限扣减，欠 " + yuanText(yuanOfCents(shortfallCents)) + " 元未计）" : note,
      meta,
    });
    if (out && out.ok === false) {
      console.warn("[relay] 扣费失败 " + (out.code || "") + " " + (out.error || "") + " userId=" + userId);
      return { ok: false, chargedYuan: 0, shortfallYuan: yuanOfCents(shortfallCents), balanceYuan: yuanOfCents(totalCentsOf(user)), code: out.code || "CHARGE_FAILED" };
    }
    const afterCents = round8((Number(out.balanceCents) || 0) + (Number(out.subCents) || 0));
    return {
      ok: true,
      chargedYuan: yuanOfCents(payCents),
      shortfallYuan: yuanOfCents(shortfallCents),
      balanceYuan: yuanOfCents(afterCents),
      wholeYuan: yuanOfCents(Number(out.wholeCents) || 0),
    };
  }

  /**
   * 一笔用量记录的对外形态：内部记录是分，出接口一律换成元（兼容读旧记录，且不回内部字段）。
   * **三项 token 一定都给**：新记录直接带 cacheMissTokens；**旧记录没有该字段**时按
   * `promptTokens − cacheHitTokens` 推算（与当初「没拆分就全按未命中价」的计费口径一致），
   * 并补齐 inputTokens = 命中 + 未命中 —— 旧记录不重算、不打标，只在读的时候推一次。
   */
  function usagePublic(rec) {
    const o = rec && typeof rec === "object" ? rec : {};
    const out = {};
    for (const [k, v] of Object.entries(o)) {
      // 内部的分字段一律不出接口（对外只有元）：costCents / chargedCents / shortfallCents / balanceCents / subCents
      if (/Cents$/.test(k)) continue;
      out[k] = v;
    }
    const hit = Number(o.cacheHitTokens) || 0;
    const outTok = Number(o.outputTokens) || 0;
    const prompt = Number(o.promptTokens) || (hit + (Number(o.cacheMissTokens) || 0));
    const miss = o.cacheMissTokens != null ? Number(o.cacheMissTokens) || 0 : Math.max(0, prompt - hit);
    out.cacheHitTokens = hit;
    out.cacheMissTokens = miss;
    out.inputTokens = hit + miss;
    out.promptTokens = prompt || hit + miss;
    out.outputTokens = outTok;
    out.costYuan = yuanOfCents(o.costCents);
    out.chargedYuan = yuanOfCents(o.chargedCents);
    out.shortfallYuan = yuanOfCents(o.shortfallCents);
    out.balanceYuan = yuanOfCents((Number(o.balanceCents) || 0) + (Number(o.subCents) || 0));
    return out;
  }

  /** 计费 + 写用量明细（上游成功才算）。 */
  async function settle(ctx, info) {
    const user = ctx.user;
    const cost = info.cost; // 元
    const rec = {
      id: "ru" + Date.now().toString(36) + crypto.randomBytes(3).toString("hex"),
      at: Date.now(),
      userId: user.id,
      username: user.username || "",
      kind: info.kind,
      model: info.model,
      upstreamModel: info.upstreamModel,
      endpoint: info.endpoint,
      images: info.kind === "image" ? (info.detail.images || 1) : 0,
      /* 三项 token（需求 2）：输入命中 / 输入未命中 / 输出。
         promptTokens 与 inputTokens 是同一份总量的两个名字（promptTokens 供旧读法兼容）。 */
      cacheHitTokens: info.detail.cacheHitTokens || 0,
      cacheMissTokens: info.detail.cacheMissTokens || 0,
      inputTokens: (info.detail.cacheHitTokens || 0) + (info.detail.cacheMissTokens || 0),
      promptTokens: (info.detail.cacheHitTokens || 0) + (info.detail.cacheMissTokens || 0),
      outputTokens: info.detail.outputTokens || 0,
      peak: !!info.detail.peak,
      // 内部记录仍按「分」落库（口径不动），出接口由 usagePublic 换成元
      costCents: centsOfYuan(cost),
      chargedCents: 0,
      subCents: subCentsOf(user),
      balanceCents: Number(user.balanceCents) || 0,
      shortfallCents: 0,
      ms: info.ms,
      ip: ctx.clientIp || "",
    };
    try {
      const r = await chargeYuan(user.id, cost, info.note, {
        model: info.model,
        endpoint: info.endpoint,
        costYuan: round8(cost),
      }, info.capCents != null ? { capCents: info.capCents } : null);
      rec.chargedCents = centsOfYuan(r.chargedYuan);
      const afterCents = centsOfYuan(r.balanceYuan);
      rec.balanceCents = Math.floor(afterCents + 1e-9);
      rec.subCents = round8(afterCents - rec.balanceCents);
      rec.shortfallCents = centsOfYuan(r.shortfallYuan);
      /* 明细也留一句金额话（实扣 + 欠额）：管理台表格与客户端自查都能直接读，
         余额不足被夹紧时不会只看到一个「实扣 0」而不知欠了多少。 */
      const short = Number(r.shortfallYuan) || 0;
      rec.note = info.note + " · 实扣 " + yuanText(Number(r.chargedYuan) || 0) + " 元" + (short > 0 ? "（余额不足，欠 " + yuanText(short) + " 元未计）" : "");
      if (!r.ok) await saveDb();
    } catch (e) {
      // 扣费失败不改变「上游已成功」的事实：接口照常回，账留痕等人工核。
      console.error("[relay] 扣费异常：" + ((e && e.message) || e) + " userId=" + user.id);
      rec.chargeError = String((e && e.message) || e);
      await saveDb();
    }
    /* **扣完才落盘**：pushUsage 是「当场追加 + fsync」的（见上面的注释），
       先 push 再扣费会把 chargedCents / balanceCents / subCents 写成 0（盘上留一条
       「上游成功但实扣 0」的假记录，管理台与对账都会读错）。代价是「上游成功 + 进程
       在扣费前崩」的那一瞬不再有明细行 —— 钱包那两笔写库是原子的，真账不会错。 */
    pushUsage(rec);
    return rec;
  }

  /* ---------- 上游转发 ---------- */

  /** 上游请求：长超时 + 客户端断开不丢计费（图像上游「断了也计费」，所以继续等到上游回包）。 */
  async function callUpstream(ctx, up, path, init, timeoutMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error("upstream timeout")), timeoutMs || up.timeoutMs || 300000);
    let clientGone = false;
    // 挂在响应对象上（客户端中途断开时 res 的 close 才代表真断开；
    // req 的 close 在请求体读完/响应结束后也会发，拿来判「客户端跑了」会误伤流式输出）。
    const onClose = () => { clientGone = true; };
    ctx.res.on("close", onClose);
    try {
      const res = await fetch(stripSlash(up.base) + path, Object.assign({}, init, { signal: ctrl.signal }));
      return { res, clientGone: () => clientGone || ctx.res.destroyed };
    } finally {
      clearTimeout(timer);
      ctx.res.removeListener("close", onClose);
    }
  }

  /** 把上游响应（含状态码与主体）原样回给客户端。 */
  async function passthrough(ctx, up, res) {
    const buf = Buffer.from(await res.arrayBuffer());
    const ct = res.headers.get("content-type") || "application/json; charset=utf-8";
    const headers = Object.assign({ "Content-Type": ct, "Content-Length": buf.length, "Cache-Control": "no-store" }, corsHeaders());
    if (!ctx.res.headersSent && !ctx.res.destroyed) ctx.res.writeHead(res.status, headers);
    if (ctx.res.destroyed) return buf; // 客户端已断开：钱照扣（上游已计费），只是没人收结果
    ctx.res.end(buf);
    return buf;
  }

  /* ---------- 端点：模型清单 ---------- */
  function handleModels(res) {
    const created = 1700000000;
    return sendJson(res, 200, {
      object: "list",
      /* 价目随清单下发（客户端本地「中转按币」计价要用服务端真价，别再靠内置表猜）：
         文本 = cacheHit / cacheMiss / output（元每百万 token）+ peakMultiplier；
         图像 = perImageYuan（元/张）。yuanPrecision = 对外元的小数位（8 = 1e-8 元）。 */
      mtnode_yuan_precision: YUAN_PRECISION,
      mtnode_peaks: (cfg.peaks || []).slice(),
      mtnode_coin_yuan: COIN_YUAN,
      /* 一张图的最低门槛（元）：客户端拿它做「余额够不够出图」的前置判断，
         与 door 的判据同源（见 minImageYuan）。0 = 没有可用的图像模型，不用拦。 */
      mtnode_min_image_yuan: minImageYuan(),
      data: cfg.models
        .filter((m) => m.enabled !== false && upstreamOf(m) && upstreamOf(m).enabled !== false)
        .map((m) => ({
          id: m.id,
          object: "model",
          created,
          owned_by: "mtnode-relay",
          mtnode_kind: m.upstream,
          mtnode_price: Object.assign({}, cfg.prices[m.id] || normPrice({}, m.upstream)),
        })),
    });
  }

  /* ---------- 端点：本账号用量自查 ---------- */
  function handleUsage(res, user) {
    const mine = usageList().filter((r) => r.userId === user.id);
    const spent = yuanOfCents(mine.reduce((s, r) => s + (Number(r.chargedCents) || 0), 0));
    const recent = mine.slice(-50).reverse().map(usagePublic);
    const totalCents = totalCentsOf(user);
    return sendJson(res, 200, {
      ok: true,
      user: { id: user.id, username: user.username || "", nickname: user.nickname || "" },
      balanceYuan: yuanOfCents(totalCents),
      totalYuan: yuanOfCents(totalCents),
      /* 金额精度随自查接口一起给：客户端据此按 8 位小数显示（旧服务端不给就按 4 位兜底）。 */
      yuanPrecision: YUAN_PRECISION,
      coinYuan: COIN_YUAN,
      calls: mine.length,
      spentYuan: spent,
      recent,
    });
  }

  /* ---------- 端点：文本 / 识图 ---------- */
  async function handleChat(ctx) {
    const raw = await readBody(ctx.req);
    let body = null;
    try {
      body = raw.length ? JSON.parse(raw.toString("utf8")) : null;
    } catch {
      return sendError(ctx.res, 400, "请求体不是合法 JSON", "invalid_json");
    }
    if (!body || typeof body !== "object") return sendError(ctx.res, 400, "请求体为空", "invalid_request");

    const model = String(body.model || "").trim();
    const hit = pickModel(ctx, model, "text");
    if (hit.error) return hit.error;
    const up = hit.up;
    if (!up.key) return notConfigured(ctx.res, hit.m, up);

    // 计费要 usage：流式请求自动给 DeepSeek 注入 include_usage（客户端已自带则尊重原值）。
    const stream = body.stream === true;
    const outBody = Object.assign({}, body, { model: hit.m.upstreamModel });
    if (stream) {
      const so = outBody.stream_options && typeof outBody.stream_options === "object" ? outBody.stream_options : {};
      outBody.stream_options = Object.assign({}, so, { include_usage: true });
    }

    const started = Date.now();
    let upres;
    try {
      upres = await callUpstream(ctx, up, "/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + up.key, Accept: stream ? "text/event-stream" : "application/json" },
        body: Buffer.from(JSON.stringify(outBody), "utf8"),
      }, up.timeoutMs);
    } catch (e) {
      return sendError(ctx.res, 502, "上游请求失败：" + ((e && e.message) || e), "upstream_error", "api_error");
    }
    const { res: ur, clientGone } = upres;
    if (!ur.ok) return passthrough(ctx, up, ur); // 上游失败：原样透传，不计费

    if (!stream) {
      const buf = Buffer.from(await ur.arrayBuffer());
      let j = null;
      try {
        j = JSON.parse(buf.toString("utf8"));
      } catch { /* 非 JSON 就照原样回，不扣费 */ }
      if (j && j.usage) {
        const cost = textCostYuan(cfg, hit.m.id, j.usage, started);
        if (cost) {
          await settle(ctx, {
            kind: "text", model: hit.m.id, upstreamModel: hit.m.upstreamModel, endpoint: "chat/completions",
            cost: cost.yuan, detail: cost.detail, ms: Date.now() - started,
            note: "中转扣费 · " + hit.m.id + " · " + tokenText(cost.detail) + " · 计费 " + yuanText(cost.yuan) + " 元",
          });
        }
      }
      const headers = Object.assign({ "Content-Type": ur.headers.get("content-type") || "application/json; charset=utf-8", "Content-Length": buf.length, "Cache-Control": "no-store" }, corsHeaders());
      if (ctx.res.destroyed) return undefined;
      if (!ctx.res.headersSent) ctx.res.writeHead(ur.status, headers);
      return ctx.res.end(buf);
    }

    // 流式：逐事件转发，顺手把「只有 usage 没有 choices」的收尾事件拿掉（客户端看到的流与直连一致）。
    if (!ctx.res.headersSent) {
      ctx.res.writeHead(200, Object.assign({
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      }, corsHeaders()));
    }
    const reader = ur.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let usage = null;
    const eat = (evt) => {
      const m = /^data:\s*(\{[\s\S]*\})\s*$/m.exec(evt);
      if (m) {
        try {
          const j = JSON.parse(m[1]);
          if (j && j.usage && typeof j.usage === "object") usage = j.usage;
          if (j && j.usage && (!Array.isArray(j.choices) || j.choices.length === 0)) return ""; // 纯 usage 事件不下发
        } catch { /* 非 JSON 事件照发 */ }
      }
      return evt;
    };
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const evt = buf.slice(0, i + 2);
          buf = buf.slice(i + 2);
          const keep = eat(evt);
          if (keep && !clientGone()) ctx.res.write(keep);
        }
      }
      if (buf) {
        const keep = eat(buf);
        if (keep && !clientGone()) ctx.res.write(keep);
      }
    } catch (e) {
      if (!clientGone() && !ctx.res.writableEnded) ctx.res.write("data: " + JSON.stringify({ error: { message: "上游流中断：" + ((e && e.message) || e), type: "api_error" } }) + "\n\n");
    }
    if (!ctx.res.writableEnded) ctx.res.end();
    const cost = textCostYuan(cfg, hit.m.id, usage, started);
    if (cost) {
      await settle(ctx, {
        kind: "text", model: hit.m.id, upstreamModel: hit.m.upstreamModel, endpoint: "chat/completions",
        cost: cost.yuan, detail: cost.detail, ms: Date.now() - started,
        note: "中转扣费 · " + hit.m.id + " · " + tokenText(cost.detail) + " · 计费 " + yuanText(cost.yuan) + " 元",
      });
    } else {
      console.warn("[relay] 上游未回 usage，本次不扣费：model=" + hit.m.id + " user=" + (ctx.user.username || ctx.user.id));
    }
    return undefined;
  }

  /* ---------- 端点：图像（generations 走 JSON；edits 走 multipart 整包转发） ---------- */
  async function handleImages(ctx, kind) {
    const raw = await readBody(ctx.req);
    const isEdit = kind === "edits";
    let model = "";
    if (isEdit) {
      // multipart 里取 model 字段（只为白名单校验，正文不解析、原样转发）
      const m = /name="model"\r?\n\r?\n([^\r\n]+)/.exec(raw.toString("latin1"));
      model = m ? m[1].trim() : "";
    } else {
      try {
        model = String((JSON.parse(raw.toString("utf8") || "{}") || {}).model || "").trim();
      } catch {
        return sendError(ctx.res, 400, "请求体不是合法 JSON", "invalid_json");
      }
    }
    const hit = pickModel(ctx, model || (cfg.models.find((x) => x.upstream === "image" && x.enabled !== false) || {}).id || "", "image");
    if (hit.error) return hit.error;
    const up = hit.up;
    if (!up.key) return notConfigured(ctx.res, hit.m, up);

    /* 余额门禁（图像）：按**本次应付额**（张数 × 元/张）原子预留，不足即 402 且不转上游 ——
       修正前只看「余额 > 0」，余额 0.10 也能出一张 0.21 的图（结算时按可用额夹紧，只归零不变负）。 */
    const needYuan = imageReserveYuan(hit.m.id, imageCountOf(raw, isEdit));
    const hold = reserveImageCharge(ctx.user.id, centsOfYuan(needYuan));
    if (!hold.ok) {
      return sendError(
        ctx.res,
        402,
        imageShortMessage(ctx.user, needYuan),
        "insufficient_quota",
        "insufficient_quota",
      );
    }

    const started = Date.now();
    try {
      let upres;
      try {
        upres = await callUpstream(ctx, up, "/images/" + kind, {
          method: "POST",
          headers: {
            "Content-Type": ctx.req.headers["content-type"] || (isEdit ? "multipart/form-data" : "application/json"),
            Authorization: "Bearer " + up.key,
            Accept: "application/json",
          },
          body: raw,
        }, up.timeoutMs);
      } catch (e) {
        return sendError(ctx.res, 502, "上游请求失败：" + ((e && e.message) || e), "upstream_error", "api_error");
      }
      const { res: ur } = upres;
      const buf = Buffer.from(await ur.arrayBuffer());
      if (ur.ok) {
        let images = 1;
        try {
          const j = JSON.parse(buf.toString("utf8"));
          if (j && Array.isArray(j.data) && j.data.length) images = j.data.length;
        } catch { /* 非 JSON：按 1 张计 */ }
        const cost = imageCostYuan(cfg, hit.m.id, images);
        await settle(ctx, {
          kind: "image", model: hit.m.id, upstreamModel: hit.m.upstreamModel, endpoint: "images/" + kind,
          cost: cost.yuan, detail: cost.detail, ms: Date.now() - started,
          /* 本次扣除上限 = 预留额：在途的**其它**预留不该被这一次的结算吃掉。
             上游多出了几张（超出预留）或没配价目（预留 0）时差额按余额夹紧，
             差额记 shortfall，不把余额扣成负数。 */
          capCents: hold.cents > 0 ? hold.cents : null,
          note: "中转扣费 · " + hit.m.id + " · " + cost.detail.images + " 张 · 计费 " + yuanText(cost.yuan) + " 元",
        });
      }
      const headers = Object.assign({ "Content-Type": ur.headers.get("content-type") || "application/json; charset=utf-8", "Content-Length": buf.length, "Cache-Control": "no-store" }, corsHeaders());
      if (ctx.res.destroyed) return undefined;
      if (!ctx.res.headersSent) ctx.res.writeHead(ur.status, headers);
      return ctx.res.end(buf);
    } finally {
      /* 上游报错 / 非 2xx / 客户端断开 / 结算异常：一律释放预留（否则这笔钱会被永久占住） */
      releaseReserve(ctx.user.id, hold.id);
    }
  }

  /* ---------- 鉴权 / 门禁 / 白名单 ---------- */

  function pickModel(ctx, model, kind) {
    if (!model) return { error: sendError(ctx.res, 400, "缺少 model 参数", "invalid_request") };
    const m = modelBy.get(model);
    if (!m) return { error: sendError(ctx.res, 404, "中转站未开放该模型：" + model, "model_not_found") };
    if (m.enabled === false) return { error: sendError(ctx.res, 404, "中转站已下架该模型：" + model, "model_not_found") };
    if (kind && m.upstream !== kind) {
      return { error: sendError(ctx.res, 400, "模型 " + model + " 属于「" + m.upstream + "」通道，端点不匹配", "invalid_request") };
    }
    if (!m.upstreamModel) return { error: sendError(ctx.res, 400, "模型 " + model + " 未配置上游名", "invalid_request") };
    const up = upstreamOf(m);
    if (!up) return { error: sendError(ctx.res, 503, "模型 " + model + " 绑定的上游不存在：" + (m.upstreamId || "（未绑定）") + "：请在管理台「中转服务」里绑定一个上游", "relay_not_configured", "api_error") };
    if (up.enabled === false) return { error: sendError(ctx.res, 503, "模型 " + model + " 绑定的上游已停用：" + up.id, "relay_not_configured", "api_error") };
    return { m, up };
  }

  /** 上游缺 Key / 地址：给出可执行的处置（管理台「中转服务」页），不回显任何 Key 材料。 */
  function notConfigured(res, m, up) {
    const label = up ? up.name + "（" + up.id + "）" : "（未绑定上游）";
    const tail = up && up.keyEnv ? "，或用服务器环境变量 " + up.keyEnv + " 兜底" : "";
    return sendError(res, 503, "中转站上游未配置完整（" + label + "）：请在管理台「中转服务」里补齐 Base URL 与 Key" + tail, "relay_not_configured", "api_error");
  }

  /** 唯一入口：server.mjs 在路由最前面把 /relay/v1/* 交给它。 */
  async function handle(ctx) {
    const { res, p, method, user, clientIp } = ctx;
    if (method === "OPTIONS") {
      res.writeHead(204, corsHeaders());
      return res.end();
    }
    if (!user) {
      /* 两种情形分开说（旧文案把用户往「去提供商填 Key」推，而那张卡是只读的：
         客户端只会去「设置 · 提供商」里白找一圈，问题其实在登录态上）：
           · 请求里根本没带凭据 → 未登录；
           · 带了凭据但服务端不认（独立票过期 / 已换账号 / 老客户端拿登录 token 来打）
             → 凭据已失效，请重新登录一次领取新的中转 Key。
         前缀 MTNODE_RELAY_AUTH 是给客户端识别的标记（客户端据此清本机凭据并提示重登，
         见 main.js 的 relayAuthFailed / providerAuthKey）—— 客户端会把前缀从文案里去掉。 */
      const hasAuth = !!(ctx && ctx.req && ctx.req.headers && String(ctx.req.headers.authorization || "").trim());
      return sendError(
        res,
        401,
        hasAuth
          ? "MTNODE_RELAY_AUTH 中转 Key 已失效（有效期到了，或账号已更换）：请重新登录一次 MTNode 账号，客户端会自动领取新的中转 Key"
          : "MTNODE_RELAY_AUTH 未提供中转 Key：请先登录 MTNode 账号（客户端在「设置 · 提供商」里自动带凭据，无需手填）",
        "invalid_api_key",
        "authentication_error",
      );
    }

    const kind = p.startsWith("/relay/v1/images/") ? "image" : "account";

    /* 余额门禁（先于限流：钱不够的请求不该白占一次配额，也不该走到上游）。
       文本按 token 计费、调用前算不出应付额 → 维持「可用余额 > 0 才放行」；
       图像的费用调用前就知道 → 由 handleImages 按**本次应付额**原子预留后再转上游
       （这里的 > 0 只作粗筛，省掉一次注定 402 的解析）。
       「可用」一律扣掉在途预留（liveCentsOf）：并发时不会把已经许给别人的钱再许一次。 */
    const fresh = (db.users || []).find((u) => u.id === user.id) || user;
    const liveCents = liveCentsOf(fresh);
    if (liveCents <= 0) {
      return sendError(res, 402, "账号余额不足（当前 " + yuanText(yuanOfCents(totalCentsOf(fresh)), 4) + " 元）：中转站只对余额 > 0 的账号开放", "insufficient_quota", "insufficient_quota");
    }

    // 限流：账号级（图像单独一档）+ 单 IP（命中即 429，OpenAI 兼容错误体）
    const gates = [
      take("acct:" + user.id, cfg.quota.accountPerMin),
      kind === "image" ? take("img:" + user.id, cfg.quota.imagePerMin) : { ok: true },
      take("ip:" + String(clientIp || "-"), cfg.quota.ipPerMin),
    ];
    const blocked = gates.find((g) => !g.ok);
    if (blocked) {
      res.writeHead(429, Object.assign({ "Content-Type": "application/json; charset=utf-8", "Retry-After": String(blocked.retryAfter || 1), "Cache-Control": "no-store" }, corsHeaders()));
      return res.end(JSON.stringify({ error: { message: "请求过于频繁，请 " + (blocked.retryAfter || 1) + " 秒后重试", type: "rate_limit_error", code: "rate_limit_exceeded", param: null } }));
    }
    gates.forEach(commit);

    if (method === "GET" && p === "/relay/v1/models") return handleModels(res);
    if (method === "GET" && p === "/relay/v1/usage") return handleUsage(res, fresh);
    if (method === "POST" && p === "/relay/v1/chat/completions") return handleChat(ctx);
    if (method === "POST" && p === "/relay/v1/images/generations") return handleImages(ctx, "generations");
    if (method === "POST" && p === "/relay/v1/images/edits") return handleImages(ctx, "edits");
    return sendError(res, 404, "中转站没有这个端点：" + p, "not_found");
  }

  /** 启动日志用：一眼看出上游凭据是否就位（不含任何 Key 材料）。 */
  function describe() {
    return {
      endpoints: ["/relay/v1/models", "/relay/v1/usage", "/relay/v1/chat/completions", "/relay/v1/images/generations", "/relay/v1/images/edits"],
      upstreams: (cfg.upstreams || []).map((u) => ({
        id: u.id,
        label: u.name,
        kind: u.kind,
        base: u.base,
        configured: !!u.key,
        keyFrom: u.keyFrom,
        keyEnv: u.keyEnv,
        enabled: u.enabled !== false,
      })),
      models: cfg.models.filter((m) => m.enabled !== false).map((m) => m.id),
      quota: cfg.quota,
      configFile: cfg.configFile,
      configSource: cfg.source,
      auditRecords: auditArr().length,
      usageRecords: usageList().length,
    };
  }

  /* ---------- 管理台：调用流水的筛选与统计（**只读**：不碰计费 / 扣费 / 写入 / 保留策略） ----------
     为什么要在服务端聚合：relayUsage 全局只留最近 USAGE_KEEP 条、管理台一次最多取 USAGE_QUERY_MAX 条，
     前端按 500 条明细自己加出来的「今日 / 近 7 天」会在忙时偏小 —— 统计口径必须在全量记录上算。
     未计费口径：明细里**实扣为 0** 的那几次（余额不足被夹紧 / 零费用）。
     上游没回 usage 的调用**不写用量记录**（只进服务端日志），所以统计里没有它们，界面要写明这一点。
     时间窗口按**服务器本地时区**的自然日（与「换 Key 每日 5 次」同一口径）。 */

  const USAGE_QUERY_MAX = 1000;

  /** 一组用量记录 → 统计口径（内部字段是分，出接口一律换成元；
   *  token 三项分别合计：输入缓存命中 / 输入缓存未命中 / 输出，promptTokens 是前两项之和）。
   *  旧记录没有 cacheMissTokens 字段 → 按 `promptTokens − cacheHitTokens` 推算（不标旧记录）。 */
  function usageAgg(rows) {
    let promptTokens = 0;
    let cacheHitTokens = 0;
    let cacheMissTokens = 0;
    let outputTokens = 0;
    let images = 0;
    let chargedCents = 0;
    let costCents = 0;
    let shortfallCents = 0;
    let unbilled = 0;
    let textCalls = 0;
    let imageCalls = 0;
    for (const r of rows) {
      const hit = Number(r.cacheHitTokens) || 0;
      const prompt = Number(r.promptTokens) || 0;
      const miss = r.cacheMissTokens != null ? Number(r.cacheMissTokens) || 0 : Math.max(0, prompt - hit);
      cacheHitTokens += hit;
      cacheMissTokens += miss;
      promptTokens += prompt || hit + miss;
      outputTokens += Number(r.outputTokens) || 0;
      images += Number(r.images) || 0;
      chargedCents += Number(r.chargedCents) || 0;
      costCents += Number(r.costCents) || 0;
      shortfallCents += Number(r.shortfallCents) || 0;
      if (r.kind === "image") imageCalls += 1;
      else textCalls += 1;
      if (!(Number(r.chargedCents) > 0)) unbilled += 1;
    }
    return {
      calls: rows.length,
      textCalls,
      imageCalls,
      /* promptTokens = 命中 + 未命中（旧字段名保留，客户端与管理台老读法都能用） */
      promptTokens: promptTokens || cacheHitTokens + cacheMissTokens,
      inputTokens: cacheHitTokens + cacheMissTokens,
      cacheHitTokens,
      cacheMissTokens,
      outputTokens,
      images,
      unbilled,
      chargedYuan: yuanOfCents(chargedCents),
      costYuan: yuanOfCents(costCents),
      shortfallYuan: yuanOfCents(shortfallCents),
    };
  }

  /** 三档统计窗口（全站口径）：key → [标签, 往前几天]。 */
  const USAGE_WINDOWS = [["today", "今日", 0], ["7d", "近 7 天", 6], ["30d", "近 30 天", 29]];

  /** 某档窗口的起点（本地自然日 00:00，往前 N 天）。 */
  function windowFrom(key) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    const hit = USAGE_WINDOWS.find((w) => w[0] === key);
    return hit ? d.getTime() - hit[2] * 86400000 : 0;
  }

  /**
   * 管理台调用流水：筛选 + 明细 + 统计一次给全（只读）。
   * @param {{window?:string,from?:string|number,to?:string|number,model?:string,userId?:string,kind?:string,limit?:string|number}} q
   * @returns {{ok:true,window:string,from:number,to:number,limit:number,matched:number,
   *            scope:object,windows:object[],models:string[],items:object[]}}
   *   · items     = 命中记录里**最近 limit 条**（倒序，元口径）
   *   · scope     = 本次筛选口径的合计（列表上方那行「本次筛选合计」）
   *   · windows   = 今日 / 近 7 天 / 近 30 天的**全站**合计（卡片口径，不受筛选影响）
   *   · models    = 明细里出现过的模型 id（界面下拉的候选，与当前上架清单合并）
   */
  function usageQuery(q) {
    const src = usageList();
    const o = q && typeof q === "object" ? q : {};
    const from = Number(o.from) > 0 ? Number(o.from) : windowFrom(String(o.window || ""));
    const to = Number(o.to) > 0 ? Number(o.to) : Date.now();
    const model = String(o.model || "");
    const user = String(o.userId || "");
    const kind = String(o.kind || "");
    const limit = Math.max(1, Math.min(USAGE_QUERY_MAX, Math.floor(Number(o.limit) || 200)));
    const hit = src.filter((r) => {
      const at = Number(r.at) || 0;
      if (at < from || at > to) return false;
      if (model && r.model !== model) return false;
      if (kind && r.kind !== kind) return false;
      // 账号筛选用精确匹配：账号 ID 或用户名（不做子串匹配，避免同名账号串账）
      if (user && r.userId !== user && r.username !== user) return false;
      return true;
    });
    return {
      ok: true,
      window: String(o.window || ""),
      from,
      to,
      limit,
      /* 金额精度随查询一起给管理台：表格按它显示 8 位小数（旧服务端不给就按 8 位兜底）。 */
      yuanPrecision: YUAN_PRECISION,
      coinYuan: COIN_YUAN,
      matched: hit.length,
      scope: usageAgg(hit),
      windows: USAGE_WINDOWS.map(([key, label]) => {
        const wf = windowFrom(key);
        return Object.assign({ key, label, from: wf }, usageAgg(src.filter((r) => (Number(r.at) || 0) >= wf)));
      }),
      models: Array.from(new Set(src.map((r) => r.model).filter(Boolean))).sort(),
      items: hit.slice(-limit).reverse().map(usagePublic),
    };
  }

  /** 管理台挂进来的那组接口（server.mjs 的 /api/admin/relay/* 与 /api/relay/me 直调）。 */
  const adminApi = {
    describe: describeAdmin,
    save: adminSaveConfig,
    listUpstreamModels: adminListUpstreamModels,
    issueTestKey: issueTestKey,
    userModels: userModels,
    /* 峰谷判据的两半：客户端本地对账要用与云端**完全相同**的公式（见 textCostYuan），
       所以把「节假日豁免日期」与「鲸圆币汇率」也随快照一起给出去（只读、不含凭据）。
       yuanPrecision = 对外元的小数位（8 = 1e-8 元）：客户端按它决定显示精度，
       旧服务端不给这个字段时客户端按 4 位兜底（见 renderer/app-relay.js 的精度自适应）。 */
    peaks: () => (cfg.peaks || []).slice(),
    coinYuan: () => COIN_YUAN,
    yuanPrecision: () => YUAN_PRECISION,
    /* 一张图的最低门槛（元）：/api/relay/me 随快照下发给客户端做「余额够不够出图」的预判。 */
    minImageYuan: minImageYuan,
    audit: (limit) => auditArr().slice(-Math.max(1, Math.min(500, Math.floor(Number(limit) || 100)))).reverse(),
    usage: (limit) => usageList().slice(-Math.max(1, Math.min(500, Math.floor(Number(limit) || 100)))).reverse().map(usagePublic),
    /* 调用流水的筛选 + 统计（只读，见上面 usageQuery 的口径注释）。 */
    usageQuery: usageQuery,
    baseUrl: () => String((deps && deps.publicBase) || "").replace(/\/+$/, ""),
    reload: reload,
  };

  return { handle, describe, admin: adminApi, reload, config: cfg };
}

export default { createRelay };