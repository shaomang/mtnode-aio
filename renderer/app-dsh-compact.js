"use strict";
/* app-dsh-compact.js — 「上下文压缩」策略在渲染层的**共享小单元**（单一真源）
 * ============================================================================
 * 为什么单独成文件：这份策略有三个入口（设置面板 / 右侧助手栏 / 会话 ⚙「模型」菜单），
 * 分别住在两个各自独立的加载单元里（renderer/app-settings.js 与 renderer/app-assist.js）。
 * 归一规则、档位清单与触发线边界**只能有一份**，否则「面板显示中档、组合里是省钱档」
 * 这类错配迟早出现。主进程侧的真源是根目录 dsh-compact-policy.js（config → cordis.yml），
 * 这里是与它同口径的**读取 / 归一**那一半，供两个 UI 单元共用。
 *
 * 与 dsh-compact-policy.js 同口径的三件事：
 *   · 档位 id 集合与出厂档（mid）；
 *   · 已下线的早档旧值 "early" 一律归一到 mid（老配置不会读出脏档）；
 *   · 自定义触发线 100,000 – 500,000，越界回落 100,000（界面侧不接受脏值）。
 * 写回（applyAssistCompactChoice / applyAssistCompactTrigger）仍留在 app-assist.js：
 * 它要落盘、要提示、要同步侧控件，属于助手那一侧的职责。
 * ============================================================================
 */

/* 档位清单：值 + 词条键（两个 UI 单元按同一顺序渲染，切语言时按词条重建）。
   文案口径：只留「档位名 · 上下文阈值」两截，不写解释性长句（界面不冗余）——
   固定档的阈值写死在词条里，自定义档的阈值是活的，由 compactCustomSuffix 拼上。 */
const ASSIST_COMPACT_OPTIONS = [
  ["off", "关闭"], /* 词条复用已有「关闭 / Close」，不另立一条 */
  ["frugal", "省钱 · 100k"],
  ["mid", "中 · 300k"],
  ["late", "晚 · 450k"],
  ["custom", "自定义"],
];
/* 固定档（不含 off / custom）：判「这是不是一个档位」时用它 */
const COMPACT_FIXED_TIERS = ["frugal", "mid", "late"];
/* 自定义档触发线的边界——与 dsh-compact-policy.js 的 CUSTOM_TRIGGER_MIN / MAX 同值 */
const COMPACT_CUSTOM_MIN = 100000;
const COMPACT_CUSTOM_MAX = 500000;

/* ── 「压缩后的大小」两个可调量（本次需求）────────────────────────────────────
   压缩后留在上下文里的体积 = **保留的最近原文**（retainTokens）+ **摘要本身**
   （摘要那一次请求的输出上限 maxTokens）。这两个值以前写死在档位里，用户只能选
   「多早压」；现在可以单独覆盖，留空 = 跟随档位默认（切档位即清空，见
   app-assist.js 的 applyAssistCompactChoice）。
   边界与档位默认值都与主进程真源 dsh-compact-policy.js 同值（那边是写入 cordis.yml
   的那一半，这里是界面读 / 归一这一半，两边只能有一份数）。 */
const COMPACT_RETAIN_MIN = 4096;
const COMPACT_RETAIN_MAX = 131072;
const COMPACT_SUMMARY_MIN = 4096;
const COMPACT_SUMMARY_MAX = 256000;
const COMPACT_TIER_SIZE_DEFAULTS = {
  frugal: { retainTokens: 16384, summaryMaxTokens: 256000 },
  mid: { retainTokens: 32768, summaryMaxTokens: 256000 },
  late: { retainTokens: 65536, summaryMaxTokens: 256000 },
  custom: { retainTokens: 16384, summaryMaxTokens: 256000 },
};
/* 手动压缩（输入区 chip / /compact）按字符数算体量：1 token ≈ 2 字符（宁可多留
   一点原文），与自动链的 token 口径换算的唯一一处。 */
const COMPACT_CHARS_PER_TOKEN = 2;

/** 读回归一后的压缩策略：缺省 / 非法值一律回落「开 · 中档」（与 dsh-compact-policy.js 同源口径）。 */
function compactPolicyOf(cfg) {
  const c = (cfg && cfg.dsh && cfg.dsh.compact) || {};
  const tier = ["frugal", "mid", "late", "custom"].indexOf(String(c.tier)) >= 0 ? String(c.tier) : "mid";
  const n = Number(c.customTriggerTokens);
  const customTriggerTokens =
    Number.isFinite(n) && n >= COMPACT_CUSTOM_MIN && n <= COMPACT_CUSTOM_MAX
      ? Math.round(n)
      : COMPACT_CUSTOM_MIN;
  return {
    enabled: c.enabled !== false,
    tier,
    customTriggerTokens,
    /* null = 跟随档位默认（不覆盖） */
    retainTokens: compactLimitOf(c.retainTokens, COMPACT_RETAIN_MIN, COMPACT_RETAIN_MAX),
    summaryMaxTokens: compactLimitOf(c.summaryMaxTokens, COMPACT_SUMMARY_MIN, COMPACT_SUMMARY_MAX),
  };
}

/** 单个可调量的归一：空 / 非数字 / 越界一律当「没填」（= 跟随档位），绝不写脏值。 */
function compactLimitOf(raw, min, max) {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return n;
}

/** 某档的默认体积值（切档位或没填时生效的那一组） */
function compactTierSizeDefault(tier) {
  return COMPACT_TIER_SIZE_DEFAULTS[String(tier)] || COMPACT_TIER_SIZE_DEFAULTS.mid;
}

/** 保留原文的生效值：{ tokens, custom }，custom=false 表示跟随档位。
 *  两个覆盖值**只在「自定义」档生效**（本次共识：非自定义档一律按档位默认 ——
 *  界面上那两个数字框也只在自定义档露出，不能出现「界面看不见、压缩却在用」的暗值）。
 *  配置里的旧值不删：切回自定义档时仍会原样回填。 */
function compactRetainEffectiveOf(cfg) {
  const cp = compactPolicyOf(cfg);
  if (cp.tier === "custom" && cp.retainTokens !== null) return { tokens: cp.retainTokens, custom: true };
  return { tokens: compactTierSizeDefault(cp.tier).retainTokens, custom: false };
}

/** 摘要上限的生效值：{ tokens, custom }（判据与保留原文同一条：只有自定义档认覆盖值） */
function compactSummaryEffectiveOf(cfg) {
  const cp = compactPolicyOf(cfg);
  if (cp.tier === "custom" && cp.summaryMaxTokens !== null) return { tokens: cp.summaryMaxTokens, custom: true };
  return { tokens: compactTierSizeDefault(cp.tier).summaryMaxTokens, custom: false };
}

/** 档位 → 档位词条键（「关闭」那一档的键另算：它同时是「关掉压缩」的语义）。
 *  会话菜单那一格与助手栏下拉共用它，档位清单常量仍是唯一真源。 */
function assistCompactOptionLabel(v) {
  const hit = ASSIST_COMPACT_OPTIONS.filter((p) => p[0] === String(v))[0];
  return hit ? hit[1] : ASSIST_COMPACT_OPTIONS[2][1];
}

/** 「自定义」那一档的行尾阈值标注：档名本身不带数，触发线是多少就显示多少 */
function compactCustomSuffix(triggerTokens) {
  const n = Number(triggerTokens);
  return Number.isFinite(n) && n > 0 ? " · " + Math.round(n / 1000) + "K" : "";
}
