/* dsh-compact-policy.js — 「上下文压缩」策略落到 dsh 组合里的唯一写入点
 * ============================================================================
 * 需求：长任务里历史越长越贵（本机 14 天账单最长会话 335 步、每步均 218K token、
 * 历史累计重放 260.96M token），而 dsh 自带的压缩从来没触发过 —— 审计脚本里
 * 「压缩 0 次」。原因不是没挂插件，而是**触发线永远到不了**：
 *   dsh 默认触发线 = 适配器声明的 contextWindow × thresholdRatio(0.8)，
 *   而 MTNode 网关给 deepseek-v4 系列声明的是 contextWindow = 1,000,000
 *   → 要跑到 800k token 才压，本机所有会话都差得远。
 *
 * 为什么是「改写 cordis.yml 组合行」而不是加一个网关接口：
 *   · `@deepseek-ai/dsh-compaction-basic` 是 dsh base 里的顶层行，补丁层按 id
 *     整份替换它的 config 即可（与 spill-policy / tool-result-pruner 同一手法）。
 *   · 同仓已有同源先例：`dsh-agent-policy.js` 就是「用户设置 → cordis.yml 行」的
 *     唯一写入点，由宿主 main.js 在启动时与每次保存配置后调用。本模块保持同一口径
 *     （同一套原子改写、同一句生效时机：下一个新会话用新值，正在跑的会话沿用原值）。
 *   · 不新增 dsh 契约：三层契约（main.js ↔ main-dsh.js ↔ gateway.mjs ↔ 运行时）
 *     一字未动，只改组合文件里的**配置值**。
 *
 * 为什么用「绝对阈值 + 绝对保留尾部」而不是纯百分比：
 *   1M 窗口上「留 16%」= 留 160k token 原文，压缩几乎白压；而窗口较小（128k）
 *   的模型上「触发 30%」= 38k token 就压，太早。所以：
 *     · 全局 `thresholdRatio` 给成「有效窗口 / 声明窗口」的比例（声明 1M、取 0.3）；
 *     · 全局 `retainRatio` 是给未列名模型的比例兜底（0.04 = 1M 上约 40k）；
 *     · 已知主力模型在 `modelPolicies` 里用 `retainTokens` 钉死**绝对**保留尾部。
 *
 * 语义（写成纯函数，便于 test/smoke-token-budget.js 直接钉住）：
 *   policy = { enabled, tier, customTriggerTokens, retainTokens, summaryMaxTokens, officialModels, selfTargets }
 *     enabled=false → auto: false（停自动压缩；provider 确认的溢出恢复仍留着）
 *     retainTokens / summaryMaxTokens = **压缩后的大小**两个可调量（null = 跟随档位默认）：
 *       保留的最近原文 token 数 / 写摘要那次请求的输出上限 token 数；见下面 RETAIN_TOKENS_* 段。
 *     selfTargets = 自配服务商（mtnode_<route>）的 provider/model 清单（从 config.providers 现算），
 *       这两个量对它们也生效，但按 128K 窗口保守夹取。
 *     tier ∈ {frugal, mid, late, custom} = 省钱 / 中 / 晚 / 自定义
 *       · 省钱（frugal）：需求「绝对 100k 触发」的落地点 —— 见下面「为什么用固定 headroom 常量」；
 *       · 自定义（custom）：触发线由用户在 100k–500k 之间自填（customTriggerTokens），
 *         换算成这一档的 headroomTokens（保留尾部与省钱档一致 16K）；
 *       · 旧值 "early"（早档已下线）一律归一到「中」。
 *     officialModels = 要逐条点名的官方路由模型 id（见文件头「为什么点名一族」；
 *       缺省 / 空 = 兜底那一族，绝不落成空表）。
 *   归一：非法 / 缺省一律回落「开 · 中档」；自定义触发线越界回落 100k。
 *
 * 为什么用固定 headroom 常量（而不是固定 thresholdRatio）：
 *   插件的实际触发线 = min(窗口 × thresholdRatio, 窗口 − 预留输出 − headroomTokens)
 *   （真源：@deepseek-ai/dsh-compaction-basic/lib/index.js:132）。官方路由（点名的那一族，
 *   见文件末尾「为什么点名一族模型 id」）声明窗口都是 1,000,000，想让它在**绝对 100k**
 *   触发，就得让第二个分支成为约束（且刚好等于 100k）：
 *     headroomTokens = 1,000,000 − 预留输出(256,000) − 100,000 = 643,872
 *   预留输出为什么是 256,000：主力路由走 dsh 自带的 deepseek 适配器，它的
 *   DEFAULT_MAX_TOKENS = 256e3（真源 dsh-llm-deepseek/lib/index.js:21）；自配服务商走
 *   llm-pi-ai，那边是 32768（真源 dsh-llm-pi-ai/lib/index.js:929）—— 同一个常量常量口径下，
 *   两条路由的实际触发线会有这点差异，这是固定 headroom 方案的既定代价（用户已确认）。
 *   声明窗口越小的路由触发线越低（数学上 = 窗口 − 预留输出 − headroom），这是该口径的另一项
 *   既定代价（窗口不够大的自配路由算不出合法值，插件会在真正跑那条路由时报错；
 *   本轮明确不动这些路由，见用户共识）。
 *
 * 为什么点名的是「一族模型 id」而不是一个名字（本机实测的 bug）：
 *   「绝对 100k」只能落在**逐路由**的 `modelPolicies` 上（插件按 provider + model
 *   逐字精确匹配，见 dsh-compaction-basic/lib/index.js:95），而 deepseek-official 这条
 *   路由跑的模型 id 是**用户服务商清单里那一个**，不是一个固定名字：本机实测会话头部是
 *   `provider=deepseek-official / model=deepseek-v4-flash`（配置里那家 DeepSeek 服务商
 *   只列了这一个），而本模块原先只点名 `deepseek-flash` → 整条 modelPolicies 落空 →
 *   headroomTokens 与 retainTokens 一起落空 → 触发线悄悄退回 dsh 默认
 *   min(1M × 0.9, 1M − 256K − 64K) ≈ 678K：用户在「省钱 · 100k」档位上也永远等不到
 *   自动压缩（审计脚本里依旧是「压缩 0 次」）。
 *   所以点名清单 = 配置里官方服务商（baseUrl 主机名含 deepseek —— 判据与
 *   renderer/app-agent.js 的 dshProvider() 同一句）的 models，∪ 兜底的已知官方 id
 *   （= 网关 OFFICIAL_MODEL_KNOWN / 别名组那一族，含已下线的别名：老会话可能还钉着它）。
 *   这些 id 在网关侧一律声明 1,000,000 窗口（dsh-llm-deepseek 的 DEFAULT_CONTEXT_WINDOW），
 *   所以固定 headroom 的算式对它们逐条成立；点名表以外的路由行为一字未变。
 *
 * 幂等：重复应用同一 policy 不产生字节变化（`changed` 为 false 时调用方一次磁盘都不碰）。
 * ============================================================================
 */
"use strict";

/* dsh 默认值（真源：@deepseek-ai/dsh-compaction-basic 的 resolveConfig）：
   headroomTokens 65536 / maxTokens 65536 / compactionRetries 1 / maxOverflowRetries 1。
   我们只覆盖 thresholdRatio / retainRatio / modelPolicies / auto —— 其余沿用 dsh 默认，
   不在这里抄一遍（抄了就成了第二个真源）。 */

/* 四档：档位只影响「多早触发」与「留多少原文」，不接原始百分比给用户。
   ratio 的"有效窗口"口径 = 声明窗口 × ratio（主力模型声明 1,000,000）：
     中 0.30 → 约 300K    晚 0.45 → 约 450K
   省钱 / 自定义两档不给 ratio 当触发线，改用**固定 headroomTokens 常量**把实际触发线
   钉在绝对值上（见文件头「为什么用固定 headroom 常量」）：
     省钱 = 100K（headroom 643,872 = 1M − 预留输出 256K − 100K）
     自定义 = 用户填 100K–500K（换算成 headroomTokens：headroom = 744,000 − 触发线，
              744,000 = 1M − 预留输出 256K）
   保留尾部（retainTokens，绝对值）：省钱 / 自定义 16K、中 32K、晚 64K。
   未列名模型走全局 retainRatio 兜底（0.04 × 声明窗口，1M 上约 40k）。 */
const TIERS = ["frugal", "mid", "late", "custom"];
const DEFAULT_TIER = "mid";
/* 主力路由（deepseek 适配器）一次请求预留的输出量：真源 = dsh-llm-deepseek 的
   DEFAULT_MAX_TOKENS 256e3。它是「窗口 − 预留输出 − headroom」里的那一项，
   算 100K 触发线时必须减掉（不减就会差 256k）。 */
const MAIN_ROUTE_RESERVED_OUTPUT = 256000;
const MAIN_ROUTE_WINDOW = 1000000;
/* 省钱档的固定 headroom（常量口径，用户已定 643,872）：
   thresholdTokens = min(1e6 × 0.9, 1e6 − 256,000 − 643,872) = 100,128 ≈ 100k。 */
const FRUGAL_HEADROOM_TOKENS = 643872;
const FRUGAL_RETAIN_TOKENS = 16384;
/* 自定义档：触发线取值范围（越界拒绝，用户已定）与缺省值（不填 = 与省钱档同值） */
const CUSTOM_TRIGGER_MIN = 100000;
const CUSTOM_TRIGGER_MAX = 500000;
const CUSTOM_TRIGGER_DEFAULT = CUSTOM_TRIGGER_MIN;
/* 自定义档触发线的硬上界：超过「窗口 − 预留输出」的触发线不可能压得出来（headroom 会变负） */
const CUSTOM_TRIGGER_CEILING = MAIN_ROUTE_WINDOW - MAIN_ROUTE_RESERVED_OUTPUT;

/* ── 「压缩后的大小」两个可调量（本次需求）──────────────────────────────────
 * 压缩后留在上下文里的体积 = 保留的最近原文（retainTokens）+ 摘要本身（写摘要那次请求的
 * 输出上限 maxTokens）。原先两者都写死在档位里，用户只能选「多早压」；现在可以在
 * config.dsh.compact 里单独覆盖（留空 = 跟随档位默认）。
 * 边界（界面侧 renderer/app-dsh-compact.js 同值，越界拒绝并提示）：
 *   retainTokens     4K – 128K  ：低于 4K 会把「最近这段原文」压没，高于 128K 在小窗口
 *                                 路由上没有意义（128k 窗口的可用原文预算本来就不到它）。
 *   summaryMaxTokens 4K – 256K  ：上界 = 主力路由单次输出上限（再大也没用）。
 * 档位默认值与 TIER_SPECS 的 retainTokens 同源（省钱 / 自定义 16K、中 32K、晚 64K），
 * 摘要上限各档都是 256K（= 主力路由的单次输出上限，见 modelPoliciesOf 的注释）。
 */
const RETAIN_TOKENS_MIN = 4096;
const RETAIN_TOKENS_MAX = 131072;
const SUMMARY_MAX_TOKENS_MIN = 4096;
const SUMMARY_MAX_TOKENS_MAX = 256000;
/* 自配服务商（网关注册名 = mtnode_<route>）的保守假设：窗口 128K、单次输出 32,768
 * （真源 dsh-llm-pi-ai/lib/index.js:929 的 DEFAULT_MAX_TOKENS）。配置里没有窗口字段，
 * 只能按最常见的小窗口保守算 —— 夹取只保证「不越过插件合法性」，不猜真实窗口。 */
const SELF_ROUTE_WINDOW = 128000;
const SELF_ROUTE_RESERVED_OUTPUT = 32768;
/* 自配路由上允许给到「消息预算」的这一成：再大就会逼近触发线（插件要求 retain < threshold） */
const SELF_ROUTE_RETAIN_FRACTION = 0.2;
/* 插件 resolveConfig 的 headroomTokens 默认值（真源 dsh-compaction-basic/lib/index.js:63）：
   自配路由没有单独写这一键，夹取触发线时必须按它算压力预算。 */
const PLUGIN_DEFAULT_HEADROOM_TOKENS = 65536;

const TIER_SPECS = Object.freeze({
  /* ratio 0.9 只是保证第二分支（headroom）成为约束：1e6 × 0.9 = 900,000 永远大于
     实际压力预算（744,000 − headroom），所以真正生效的是 headroom 那一支。 */
  frugal: Object.freeze({ ratio: 0.9, headroomTokens: FRUGAL_HEADROOM_TOKENS, retainTokens: FRUGAL_RETAIN_TOKENS }),
  mid: Object.freeze({ ratio: 0.3, retainTokens: 32768 }),
  late: Object.freeze({ ratio: 0.45, retainTokens: 65536 }),
  custom: Object.freeze({ ratio: 0.9, retainTokens: FRUGAL_RETAIN_TOKENS }),
});
/* 自定义档：触发线（绝对 token）→ headroomTokens。主力路由上
   thresholdTokens = 1,000,000 − 256,000 − headroom，所以 headroom = 744,000 − 触发线
   （触发线上界 500,000 处 headroom = 244,000，仍为正）。 */
function customHeadroomOf(triggerTokens) {
  return Math.max(0, CUSTOM_TRIGGER_CEILING - normalizeCustomTrigger(triggerTokens));
}
/* 全局兜底保留比例：必须 < 最小档 ratio（0.3），否则插件加载期就会拒（retainRatio ≥ thresholdRatio） */
const FALLBACK_RETAIN_RATIO = 0.04;

/* 已知主力路由所在的 provider（网关对官方适配器注册的路由名，逐字一致才能匹配上）。 */
const OFFICIAL_PROVIDER = "deepseek-official";
/* 点名的兜底模型 id = 网关认得的那一族官方模型（gateway.mjs 的 OFFICIAL_MODEL_KNOWN 与
   OFFICIAL_MODEL_ALIAS_GROUPS），含已下线的别名：老会话 / 老配置可能还钉着
   `deepseek-v4-flash` 这类 id（本机就是这么踩到的）。顺序即出货 cordis.yml 里的顺序：
   配置里读到的官方模型不在这一族时追加在后面，保证「配置没变 → 组合字节不变」。 */
const OFFICIAL_MODELS_FALLBACK = Object.freeze([
  "deepseek-flash",
  "deepseek-v4-flash",
  "deepseek-v4-flash-vision-exp",
  "deepseek-v4-pro",
]);

/* 「哪家服务商算 DeepSeek 官方路由」的判据与渲染层同一句：renderer/app-agent.js 的
   dshProvider()（text_openai 且 baseUrl 主机名含 deepseek 的那一家）。
   照抄这一句是有意的 —— 它是「这条路由上的模型 id 长什么样」的唯一判据，
   换判据就会重新出现「点名点不到真正在跑的那个 id」这个 bug。 */
function isOfficialDeepseekProvider(p) {
  if (!p || typeof p !== "object") return false;
  if (String(p.type || "") !== "text_openai") return false;
  try {
    return new URL(String(p.baseUrl || "")).hostname.toLowerCase().includes("deepseek");
  } catch {
    return false;
  }
}

/** 本机官方路由可能跑到的模型 id：兜底那一族在前，配置里多出来的追加在后（去重保序）。 */
function officialModelIdsOf(cfg) {
  const c = cfg && typeof cfg === "object" ? cfg : {};
  const out = [];
  const push = (v) => {
    const s = String(v == null ? "" : v).trim();
    if (s && out.indexOf(s) < 0) out.push(s);
  };
  for (const id of OFFICIAL_MODELS_FALLBACK) push(id);
  for (const p of Array.isArray(c.providers) ? c.providers : []) {
    if (!isOfficialDeepseekProvider(p)) continue;
    for (const m of Array.isArray(p.models) ? p.models : []) push(m);
  }
  return out;
}

/** 点名清单归一：非数组 / 空表一律回落兜底那一族（绝不产出空 modelPolicies）。 */
function normalizeOfficialModels(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const v of list) {
    const s = String(v == null ? "" : v).trim();
    if (s && out.indexOf(s) < 0) out.push(s);
  }
  return out.length ? out : OFFICIAL_MODELS_FALLBACK.slice();
}

/** 「压缩后的大小」两个可调量的归一：空 / 非数字 / 越界一律当「没填」（返回 null =
 *  跟随档位默认）。界面上越界是**拒绝并提示**（写回前自己校验），这里只兜底不抛。 */
function normalizeLimitTokens(raw, min, max) {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return n;
}

/** 某档的体积默认值（没填时生效的那一组）：保留尾部 = TIER_SPECS，摘要上限 = 主力路由
 *  的单次输出上限（见 modelPoliciesOf 的注释：写摘要那一次请求的信封）。 */
function tierSizeDefaultOf(tier) {
  const spec = TIER_SPECS[tier] || TIER_SPECS[DEFAULT_TIER];
  return { retainTokens: spec.retainTokens, summaryMaxTokens: MAIN_ROUTE_RESERVED_OUTPUT };
}

/** 生效的保留原文量（token）：用户填了用用户的，没填跟随档位 */
function effectiveRetainTokensOf(policy) {
  if (policy && policy.retainTokens !== null && policy.retainTokens !== undefined) return policy.retainTokens;
  return tierSizeDefaultOf(policy && policy.tier).retainTokens;
}

/** 生效的摘要输出上限（token） */
function effectiveSummaryMaxTokensOf(policy) {
  if (policy && policy.summaryMaxTokens !== null && policy.summaryMaxTokens !== undefined)
    return policy.summaryMaxTokens;
  return tierSizeDefaultOf(policy && policy.tier).summaryMaxTokens;
}

/** 自配服务商（网关按 `mtnode_<route>` 注册）上的目标清单：配置里每一家的每一只模型。
 *  与官方那条的区别：这里没有窗口信息，也没有可点名的固定模型族 —— 见 SELF_ROUTE_* 的注释。 */
function selfTargetsOf(cfg) {
  const out = [];
  const providers = Array.isArray(cfg && cfg.providers) ? cfg.providers : [];
  providers.forEach((p, i) => {
    if (!p || typeof p !== "object") return;
    if (String(p.type || "") !== "text_openai") return;
    if (isOfficialDeepseekProvider(p)) return; /* 官方那条已逐条点名，不重复 */
    /* 停用的服务商跑不到：判据与渲染层同一句（renderer/app-model-kind.js 的
       providerManuallyOff / providerRelayBlocked）—— 不写进组合，少一堆死配置。 */
    if (p.disabled === true) return;
    if (String(p.source || "") === "mtnode-relay" && p.relay && p.relay.blocked === true) return;
    const route = String(p.route || "").trim() || "p" + (i + 1);
    for (const m of Array.isArray(p.models) ? p.models : []) {
      const id = String(m == null ? "" : m).trim();
      if (id) out.push({ provider: "mtnode_" + route, model: id });
    }
  });
  return out;
}

/** 自配目标清单归一（去重保序，只留 provider / model 两个字符串）。 */
function normalizeSelfTargets(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  const seen = Object.create(null);
  for (const t of list) {
    if (!t || typeof t !== "object") continue;
    const provider = String(t.provider || "").trim();
    const model = String(t.model || "").trim();
    if (!provider || !model) continue;
    const key = provider + "\u0000" + model;
    if (seen[key]) continue;
    seen[key] = 1;
    out.push({ provider, model });
  }
  return out;
}

/* 静态点名表（兜底那一族 · 出货 cordis.yml 里就是它的落地值）：保留这个导出，
   回归脚本拿它核对「组合里的政策条数 = 点名条数」与出货默认值。 */
const KNOWN_TARGETS = Object.freeze(
  OFFICIAL_MODELS_FALLBACK.map((model) => Object.freeze({ provider: OFFICIAL_PROVIDER, model })),
);

const DEFAULT_POLICY = Object.freeze({ enabled: true, tier: DEFAULT_TIER, officialModels: OFFICIAL_MODELS_FALLBACK });

/** 把任意外来值归一成一份合法 policy（非法值一律回落默认，绝不抛）。
 *  `early` 是已下线的早档（省钱档顶替了它）：老配置里存着的旧值一律归一到「中」。
 *  「压缩后的大小」两个可调量**只有自定义档才认**（本次共识）：其它档位一律按档位默认，
 *  否则会出现「界面不显示这两个数、压缩却在用旧值」的暗值。配置里的旧值不在这里删，
 *  切回自定义档时照旧回填。 */
function normalizeCompactPolicy(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const tier = TIERS.indexOf(String(r.tier)) >= 0 ? String(r.tier) : DEFAULT_TIER;
  const customTriggerTokens = normalizeCustomTrigger(r.customTriggerTokens);
  const customTier = tier === "custom";
  return {
    enabled: r.enabled !== false,
    tier,
    customTriggerTokens,
    /* 压缩后大小的两个可调量：null = 跟随档位默认（非自定义档恒为 null） */
    retainTokens: customTier
      ? normalizeLimitTokens(r.retainTokens, RETAIN_TOKENS_MIN, RETAIN_TOKENS_MAX)
      : null,
    summaryMaxTokens: customTier
      ? normalizeLimitTokens(r.summaryMaxTokens, SUMMARY_MAX_TOKENS_MIN, SUMMARY_MAX_TOKENS_MAX)
      : null,
    officialModels: normalizeOfficialModels(r.officialModels),
    selfTargets: normalizeSelfTargets(r.selfTargets),
  };
}

/** 自定义档触发线归一：非数字 / 越界一律回落缺省（100k），上界按「窗口 − 预留输出」硬夹。
 *  界面上越界是**拒绝并提示**（设置面板自己校验），这里只是兜底不抛。 */
function normalizeCustomTrigger(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return CUSTOM_TRIGGER_DEFAULT;
  const v = Math.round(n);
  if (v < CUSTOM_TRIGGER_MIN || v > CUSTOM_TRIGGER_MAX) return CUSTOM_TRIGGER_DEFAULT;
  return Math.min(v, CUSTOM_TRIGGER_CEILING);
}

/** 从 MTNode 的整份 config 对象里取压缩策略。
 *  真源是 `config.dsh.compact`（与默认模型 / Agent 预设 / 子代理策略同一节，
 *  设置界面写的就是它）；`config.compact` 作为兼容读取。
 *  点名清单另外从**同一份 config 的 providers** 里取（用户那家 DeepSeek 官方服务商列了
 *  哪些模型，这条路由上就可能跑哪些 id —— 见文件头「为什么点名一族模型 id」）。 */
function compactPolicyFromConfig(cfg) {
  const c = cfg && typeof cfg === "object" ? cfg : {};
  const raw = (c.dsh && c.dsh.compact) || c.compact;
  const policy = normalizeCompactPolicy(raw);
  policy.officialModels = officialModelIdsOf(c);
  /* 自配服务商也吃同一份「压缩后大小」：目标清单从 providers 现算（网关按 mtnode_<route>
     注册，配置里没有窗口字段，故在 modelPoliciesOf 里按 SELF_ROUTE_WINDOW 保守夹取）。 */
  policy.selfTargets = selfTargetsOf(c);
  return policy;
}

/** 各档的 modelPolicies 行（绝对保留尾部 + 省钱 / 自定义两档的固定 headroom + 官方路由逐条点名）。
 *  为什么 headroom 要点名在路由上而不是写全局：全局 headroom 是「所有路由共用」的兜底，
 *  128k 这类小窗口路由在固定 headroom 下算不出合法值（插件运行到那条路由才报错），
 *  所以省钱 / 自定义两档只把 headroom 钉在官方大窗口路由上，其余路由走原比例。
 *  为什么每条都要显式 `maxTokens`：插件的 resolveConfig 有一条兜底 —— 路由 policy 只写了
 *  headroomTokens 时，policy.maxTokens 会被**填成 headroomTokens**（真源
 *  dsh-compaction-basic/lib/index.js:71），而 maxTokens 是**写摘要那一次请求**的输出上限
 *  （summarizeWithLlm 的 options.maxTokens）。省钱档 643,872 这样发出去就是向模型要 64 万
 *  输出 token —— 主力路由真正在用的单次输出上限是 256,000（本机会话头部 maxTokens 实测），
 *  所以这里把它钉成同一个数：摘要请求的信封与主请求一字不差。 */
function modelPoliciesOf(tier, policy) {
  const spec = TIER_SPECS[tier] || TIER_SPECS[DEFAULT_TIER];
  /* 传入的 policy 可能是「只有 officialModels 的局部对象」（旧调用方 / 验证脚本），
     先归一再取生效值：没填的两个量各自跟随档位默认。 */
  const p = normalizeCompactPolicy(Object.assign({ tier }, policy || {}));
  const headroom =
    tier === "frugal"
      ? FRUGAL_HEADROOM_TOKENS
      : tier === "custom"
        ? customHeadroomOf(p.customTriggerTokens)
        : null;
  const retainTokens = p.retainTokens === null ? spec.retainTokens : p.retainTokens;
  const summaryMaxTokens =
    p.summaryMaxTokens === null ? MAIN_ROUTE_RESERVED_OUTPUT : p.summaryMaxTokens;
  /* 主力路由的触发线（与插件同一条算式：min(窗口 × ratio, 窗口 − 预留输出 − headroom)），
     用户填的保留量必须**小于**它（插件硬校验 retainTokens < thresholdTokens）：省钱档
     触发线本来就只有 100K，填 128K 的保留量会直接把插件配置搞成非法。 */
  const officialHeadroom =
    headroom === null ? PLUGIN_DEFAULT_HEADROOM_TOKENS : headroom;
  const officialThreshold = Math.floor(
    Math.min(MAIN_ROUTE_WINDOW * spec.ratio, MAIN_ROUTE_WINDOW - MAIN_ROUTE_RESERVED_OUTPUT - officialHeadroom),
  );
  const officialRetain = Math.max(1, Math.min(retainTokens, officialThreshold - 1));
  const official = normalizeOfficialModels(p.officialModels).map((model) =>
    Object.assign(
      { provider: OFFICIAL_PROVIDER, model },
      headroom === null ? {} : { headroomTokens: headroom },
      { maxTokens: summaryMaxTokens, retainTokens: officialRetain },
    ),
  );
  /* 自配服务商路由（mtnode_<route>）：也钉绝对量，但**按路由夹取** —— 这些路由的窗口
     未知（配置里没有这一项），而插件要求 retainTokens < 触发线，写大了会在真跑到那条
     路由时报错。假设 128K 窗口 / 32,768 预留输出（SELF_ROUTE_* 的注释），保留量取
     「消息预算的 20%」与用户值的小者，摘要上限取「该路由单次输出上限」与用户值的小者。 */
  const self = normalizeSelfTargets(p.selfTargets).map((t) => {
    const messageBudget = SELF_ROUTE_WINDOW - SELF_ROUTE_RESERVED_OUTPUT;
    const ratio = spec.ratio;
    const pressure = messageBudget - PLUGIN_DEFAULT_HEADROOM_TOKENS;
    const threshold = Math.floor(Math.min(SELF_ROUTE_WINDOW * ratio, pressure));
    const cap = Math.floor(messageBudget * SELF_ROUTE_RETAIN_FRACTION);
    const retain = Math.max(1, Math.min(retainTokens, cap, threshold - 1));
    const summary = Math.max(1, Math.min(summaryMaxTokens, SELF_ROUTE_RESERVED_OUTPUT));
    return { provider: t.provider, model: t.model, maxTokens: summary, retainTokens: retain };
  });
  return official.concat(self);
}

/** policy → compaction-basic 行的 config 块（整份替换语义：键写全）。 */
function compactConfigOf(rawPolicy) {
  const policy = normalizeCompactPolicy(rawPolicy);
  const spec = TIER_SPECS[policy.tier] || TIER_SPECS[DEFAULT_TIER];
  /* 省钱 / 自定义两档的触发线靠路由级 headroom 钉绝对值，全局 ratio 只用来保证
     「第二分支胜出」（ratio 0.9 × 1M = 900k > 实际压力预算）；
     中 / 晚两档仍走原比例，全局 ratio 就是它们的触发比例。 */
  return {
    thresholdRatio: spec.ratio,
    retainRatio: FALLBACK_RETAIN_RATIO,
    modelPolicies: modelPoliciesOf(policy.tier, policy),
    auto: policy.enabled,
  };
}

/** YAML 标量的写法：普通 id 裸写（与出货组合逐字一致，往返无损），
 *  会被 YAML 解析成别的类型（number / boolean / null）或含特殊字符的值一律加双引号。
 *  为什么必须加：provider / model 是**字符串**，裸写 `model: 123` 会被解析成 number，
 *  compaction-basic 的 resolveConfig 立刻报
 *  `$.modelPolicies[7].model expected string but got 123` → 整份 modelPolicies 落空、
 *  插件整条不装载（真机 stderr 实测），压缩策略就此静默失效。
 *  点名表里出现「长得像数字」的模型 id（中转服务商自报的 id 可能就是这样）时，
 *  这条就是唯一的兜底。 */
function yamlScalarOf(v) {
  const s = String(v == null ? "" : v);
  const plainSafe = /^[A-Za-z0-9_][A-Za-z0-9_.\-/]*$/.test(s);
  const looksTyped =
    /^(?:[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?|0[xX][0-9a-fA-F]+|0[oO][0-7]+|true|false|yes|no|on|off|null|~)$/i.test(
      s,
    );
  if (plainSafe && !looksTyped) return s;
  return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

/** 把 config 对象渲染成 YAML 行（基准：`config:` 之下缩进 2，列表项再缩 2）。
 *  这些行**不带行尾**：行尾由调用方按「紧邻那一行的行尾」补（混行文件才不会被打乱）。 */
function renderConfigLines(cfg) {
  const lines = [];
  lines.push("    thresholdRatio: " + cfg.thresholdRatio);
  lines.push("    retainRatio: " + cfg.retainRatio);
  lines.push("    auto: " + (cfg.auto ? "true" : "false"));
  lines.push("    modelPolicies:");
  for (const p of cfg.modelPolicies) {
    lines.push("      - provider: " + yamlScalarOf(p.provider));
    lines.push("        model: " + yamlScalarOf(p.model));
    if (p.headroomTokens !== undefined) lines.push("        headroomTokens: " + p.headroomTokens);
    if (p.maxTokens !== undefined) lines.push("        maxTokens: " + p.maxTokens);
    lines.push("        retainTokens: " + p.retainTokens);
  }
  return lines;
}

/** 把一块里 config 段的内容整份换成我们的取值。
 *  实现口径：**按行处理**（块本身已在下一个 `- id: ` 之前切开，内含结尾换行与注释）。
 *   - `config:` 行 → 它后面所有缩进比它深（或空行）的行，就是这个 config 段的内容；
 *     遇到同级或更浅的非空行就停（块尾的注释与空行原样保留）。
 *   - 缩进相对本行的 `config:` 算：顶层行缩进 0、insert 段里的行缩进 4，两种都照抄原缩进，
 *     否则 YAML 层级就变了。
 *   - 整块没有 `config:` 行 → 把 config 段插在 `- id:` 行之后。
 *  不用正则做整段替换：块尾的 PTC 注释里有一行被注掉的 `#   config:`，以 `^[ \t]*config:`
 *  去找会先撞上它（把真 config 留下、又在注释处插一份）；而 `[\s\S]*$` 那种整段消费的写法
 *  又会在 CRLF / 混行文件上把行尾吃错位（本仓 cordis.yml 的顶层行 CRLF、末尾却带一个 LF）。 */
function setConfigBlock(block, cfg) {
  /* 逐行切但保留行尾：换行符混行时也能逐字还原本块。 */
  const lines = block.match(/[^\r\n]*(?:\r?\n|$)/g) || [];
  const indentOf = (l) => (l.match(/^[ \t]*/) || [""])[0].length;
  const ci = lines.findIndex((l) => /^[ \t]*config:[ \t]*(?:\r?\n)?$/.test(l));
  /* 生成行：基准缩进 = config: 行缩进（没有 config 行时 = id 行缩进 + 2），
     行尾一律照抄紧邻的那一行，保证混行文件不被我们改写行尾风格。 */
  /* 生成行：基准缩进 = config: 行缩进（没有 config 行时 = id 行缩进 + 2），
     行尾一律照抄紧邻的那一行，保证混行文件不被我们改写行尾风格。
     末尾**必须带一个行尾**：config 段之后还有块自己的空行与注释，少一个换行就会把
     注释行粘到最后一个取值上（YAML 里那条注释会被当成值的一部分）。 */
  const build = (baseCols, tailEol) =>
    renderConfigLines(cfg)
      .map((l) => " ".repeat(baseCols) + l.slice(2) + tailEol)
      .join("");
  if (ci >= 0) {
    const baseCols = indentOf(lines[ci]);
    const le = (lines[ci].match(/(\r?\n)$/) || [, "\n"])[1];
    /* config 段 = 紧随其后、缩进**比 config: 更深**的那些行。空行（缩进 0）到此为止：
       本块 config 之后就是一个空行 + 一段同级注释，把空行吞进 config 段会把那个空行
       连同后面的注释一起改写掉（幂等就没了）。 */
    let end = ci + 1;
    while (end < lines.length && indentOf(lines[end]) > baseCols) end++;
    return lines.slice(0, ci + 1).join("") + build(baseCols, le) + lines.slice(end).join("");
  }
  const idi = lines.findIndex((l) => /^[ \t]*- id:/.test(l));
  if (idi < 0) return block;
  const baseCols = indentOf(lines[idi]) + 2;
  const le = (lines[idi].match(/(\r?\n)$/) || [, "\n"])[1];
  const head = lines.slice(0, idi + 1).join("");
  const tail = lines.slice(idi + 1).join("");
  return head + " ".repeat(baseCols) + "config:" + le + build(baseCols, le) + tail;
}

/**
 * 把策略写进一份 cordis.yml 文本。
 * @param {string} text 现 cordis.yml 全文
 * @param {object} rawPolicy 任意形状的策略（内部归一）
 * @returns {{text: string, changed: boolean}} 新全文与「是否真的改了字节」
 */
function applyCompactPolicy(text, rawPolicy) {
  const src = String(text == null ? "" : text);
  const policy = normalizeCompactPolicy(rawPolicy);
  /* 切块：每块 = 一个 `- id:` 行 + 它后面到下一个 `- id:` 之前的全部内容（含空行与注释）。
     顶层行缩进 0、insert 段里的行缩进 4，两种都要认。块本身自带结尾换行，
     所以拼回去直接 join("")，不会丢空行也不会把两行粘成一行。 */
  const parts = src.split(/^(?=[ \t]*- id: )/m);
  let changed = false;
  const out = parts.map((part) => {
    const idm = part.match(/^[ \t]*- id:\s*(\S+)/);
    if (!idm || idm[1] !== "compaction-basic") return part;
    const next = setConfigBlock(part, compactConfigOf(policy));
    if (next !== part) changed = true;
    return next;
  });
  /* 组合里没有这一行 = 插件根本没挂，策略无从生效（不自己插行：挂载由组合决定，
     本模块只改配置值，与 dsh-agent-policy.js「只改配置值与 disabled 取值」同一纪律）。 */
  if (!changed) return { text: src, changed: false };
  return { text: out.join(""), changed: true };
}

/** 取组合里 compaction-basic 那一块（下一个 `- id:` 之前），缺席 = null。 */
function compactBlockOf(text) {
  const parts = String(text == null ? "" : text).split(/^(?=[ \t]*- id: )/m);
  for (const part of parts) {
    const idm = part.match(/^[ \t]*- id:\s*(\S+)/);
    if (idm && idm[1] === "compaction-basic") return part;
  }
  return null;
}

/** 供设置界面 / 排障用：当前组合里这一行的关键取值（缺席 = null）。
 *  取值一律在**非注释行**上找（本行的上方注释里就写着 `thresholdRatio 0.3`
 *  这类示例文字，拿注释当取值会读出「关不掉」的假象）。 */
function compactStateInCordis(text) {
  const block = compactBlockOf(text);
  if (!block) return null;
  const live = block
    .split(/\r?\n/)
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");
  const num = (k) => {
    const m = live.match(new RegExp("^[ \\t]*" + k + ":\\s*([0-9.]+)", "m"));
    return m ? Number(m[1]) : null;
  };
  const autoM = live.match(/^[ \t]*auto:\s*(true|false)/m);
  return {
    thresholdRatio: num("thresholdRatio"),
    retainRatio: num("retainRatio"),
    auto: autoM ? autoM[1] === "true" : null,
    hasModelPolicies: /^[ \t]*modelPolicies:/m.test(live),
    retainTokens: Array.from(live.matchAll(/^[ \t]*retainTokens:\s*(\d+)/gm)).map((m) => Number(m[1])),
    /* 省钱 / 自定义档的固定 headroom（中 / 晚两档不写这一键，故可能为空数组） */
    headroomTokens: Array.from(live.matchAll(/^[ \t]*headroomTokens:\s*(\d+)/gm)).map((m) => Number(m[1])),
    /* 写摘要那一次请求的输出上限（每条 policy 都有；见 modelPoliciesOf 的注释） */
    maxTokens: Array.from(live.matchAll(/^[ \t]*maxTokens:\s*(\d+)/gm)).map((m) => Number(m[1])),
  };
}

module.exports = {
  TIERS,
  DEFAULT_TIER,
  TIER_SPECS,
  FALLBACK_RETAIN_RATIO,
  OFFICIAL_PROVIDER,
  OFFICIAL_MODELS_FALLBACK,
  KNOWN_TARGETS,
  DEFAULT_POLICY,
  FRUGAL_HEADROOM_TOKENS,
  FRUGAL_RETAIN_TOKENS,
  MAIN_ROUTE_WINDOW,
  MAIN_ROUTE_RESERVED_OUTPUT,
  CUSTOM_TRIGGER_MIN,
  CUSTOM_TRIGGER_MAX,
  CUSTOM_TRIGGER_DEFAULT,
  CUSTOM_TRIGGER_CEILING,
  RETAIN_TOKENS_MIN,
  RETAIN_TOKENS_MAX,
  SUMMARY_MAX_TOKENS_MIN,
  SUMMARY_MAX_TOKENS_MAX,
  SELF_ROUTE_WINDOW,
  SELF_ROUTE_RESERVED_OUTPUT,
  PLUGIN_DEFAULT_HEADROOM_TOKENS,
  tierSizeDefaultOf,
  effectiveRetainTokensOf,
  effectiveSummaryMaxTokensOf,
  normalizeLimitTokens,
  selfTargetsOf,
  normalizeSelfTargets,
  customHeadroomOf,
  isOfficialDeepseekProvider,
  officialModelIdsOf,
  normalizeOfficialModels,
  normalizeCustomTrigger,
  normalizeCompactPolicy,
  compactPolicyFromConfig,
  compactConfigOf,
  modelPoliciesOf,
  applyCompactPolicy,
  compactStateInCordis,
};
