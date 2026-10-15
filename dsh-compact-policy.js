/* dsh-compact-policy.js — 「上下文压缩」策略落到 dsh 组合里的唯一写入点
 * ============================================================================
 * 需求：长任务里历史越长越贵（本机 14 天账单最长会话 335 步、每步均 218K token、
 * 历史累计重放 260.96M token），而 dsh 自带的压缩从来没触发过 —— 审计脚本里
 * 「压缩 0 次」。原因不是没挂插件，而是**触发线永远到不了**：
 *   dsh 默认触发线 = 适配器声明的 contextWindow × thresholdRatio(0.8)，
 *   而 MTNode 网关给 deepseek-v4 系列声明的是 contextWindow = 1,000,000
 *   → 要跑到 80 万 token 才压，本机所有会话都差得远。
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
 *   1M 窗口上「留 16%」= 留 16 万 token 原文，压缩几乎白压；而窗口较小（12.8 万）
 *   的模型上「触发 30%」= 3.8 万 token 就压，太早。所以：
 *     · 全局 `thresholdRatio` 给成「有效窗口 / 声明窗口」的比例（声明 1M、取 0.3）；
 *     · 全局 `retainRatio` 是给未列名模型的比例兜底（0.04 = 1M 上约 4 万）；
 *     · 已知主力模型在 `modelPolicies` 里用 `retainTokens` 钉死**绝对**保留尾部。
 *
 * 语义（写成纯函数，便于 test/smoke-token-budget.js 直接钉住）：
 *   policy = { enabled, tier }
 *     enabled=false → auto: false（停自动压缩；provider 确认的溢出恢复仍留着）
 *     tier ∈ {early, mid, late} = 早 / 中 / 晚三档（只差保留尾部与触发比例）
 *   归一：非法 / 缺省一律回落「开 · 中档」。
 *
 * 幂等：重复应用同一 policy 不产生字节变化（`changed` 为 false 时调用方一次磁盘都不碰）。
 * ============================================================================
 */
"use strict";

/* dsh 默认值（真源：@deepseek-ai/dsh-compaction-basic 的 resolveConfig）：
   headroomTokens 65536 / maxTokens 65536 / compactionRetries 1 / maxOverflowRetries 1。
   我们只覆盖 thresholdRatio / retainRatio / modelPolicies / auto —— 其余沿用 dsh 默认，
   不在这里抄一遍（抄了就成了第二个真源）。 */

/* 三档：档位只影响「多早触发」与「留多少原文」，不接原始百分比给用户。
   ratio 的"有效窗口"口径 = 声明窗口 × ratio（主力模型声明 1,000,000）：
     早 0.16 → 约 160K    中 0.30 → 约 300K    晚 0.45 → 约 450K
   保留尾部（retainTokens，绝对值）：早 16K / 中 32K / 晚 64K。
   未列名模型走全局 retainRatio 兜底（0.04 × 声明窗口，1M 上约 4 万）。 */
const TIERS = ["early", "mid", "late"];
const DEFAULT_TIER = "mid";
const TIER_SPECS = Object.freeze({
  early: Object.freeze({ ratio: 0.16, retainTokens: 16384 }),
  mid: Object.freeze({ ratio: 0.3, retainTokens: 32768 }),
  late: Object.freeze({ ratio: 0.45, retainTokens: 65536 }),
});
/* 全局兜底保留比例：必须 < 最小档 ratio（0.16），否则早期档在插件加载期就会被拒。 */
const FALLBACK_RETAIN_RATIO = 0.04;

/* 已知主力路由（provider/model 必须与运行时真正走的那条路由逐字一致，否则覆盖不生效）：
   只点名 `deepseek-official/deepseek-flash` —— 本机实测（audit-token-usage 的会话台账）
   这个工作区的会话全部走这条路，而它的窗口是 MTNode 网关自己声明的 1,000,000，
   纯比例算出来的保留尾部会大到「留 16 万 token」，所以要给绝对量。
   自配服务商走 llm-pi-ai，provider 是 `mtnode_<route>`（route 由用户配置决定、
   模型名也是用户填的，没有固定组合可点名），一律走全局 retainRatio 兜底：
   窗口越小留得越少（1M → 约 3.7 万；12.8 万 → 约 4.6 千），不会出现「留得比触发线还多」。 */
const KNOWN_TARGETS = Object.freeze([
  Object.freeze({ provider: "deepseek-official", model: "deepseek-flash" }),
]);

const DEFAULT_POLICY = Object.freeze({ enabled: true, tier: DEFAULT_TIER });

/** 把任意外来值归一成一份合法 policy（非法值一律回落默认，绝不抛）。 */
function normalizeCompactPolicy(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const tier = TIERS.indexOf(String(r.tier)) >= 0 ? String(r.tier) : DEFAULT_TIER;
  return { enabled: r.enabled !== false, tier };
}

/** 从 MTNode 的整份 config 对象里取压缩策略。
 *  真源是 `config.dsh.compact`（与默认模型 / Agent 预设 / 子代理策略同一节，
 *  设置界面写的就是它）；`config.compact` 作为兼容读取。 */
function compactPolicyFromConfig(cfg) {
  const c = cfg && typeof cfg === "object" ? cfg : {};
  const raw = (c.dsh && c.dsh.compact) || c.compact;
  return normalizeCompactPolicy(raw);
}

/** 各档的 modelPolicies 行（绝对保留尾部 + 已知路由点名）。 */
function modelPoliciesOf(tier) {
  const spec = TIER_SPECS[tier] || TIER_SPECS[DEFAULT_TIER];
  return KNOWN_TARGETS.map((t) => ({
    provider: t.provider,
    model: t.model,
    retainTokens: spec.retainTokens,
  }));
}

/** policy → compaction-basic 行的 config 块（整份替换语义：三个键写全）。 */
function compactConfigOf(rawPolicy) {
  const policy = normalizeCompactPolicy(rawPolicy);
  const spec = TIER_SPECS[policy.tier] || TIER_SPECS[DEFAULT_TIER];
  return {
    thresholdRatio: spec.ratio,
    retainRatio: FALLBACK_RETAIN_RATIO,
    modelPolicies: modelPoliciesOf(policy.tier),
    auto: policy.enabled,
  };
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
    lines.push("      - provider: " + p.provider);
    lines.push("        model: " + p.model);
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
  };
}

module.exports = {
  TIERS,
  DEFAULT_TIER,
  TIER_SPECS,
  FALLBACK_RETAIN_RATIO,
  KNOWN_TARGETS,
  DEFAULT_POLICY,
  normalizeCompactPolicy,
  compactPolicyFromConfig,
  compactConfigOf,
  modelPoliciesOf,
  applyCompactPolicy,
  compactStateInCordis,
};
