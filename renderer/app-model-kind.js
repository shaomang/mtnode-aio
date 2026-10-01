"use strict";
/* ═══════════════ 模型形态识别：文本模型 / 图像生成模型 ═══════════════
   问题背景：服务商配置（config.json 的 providers[]）里只有**服务商级**的 type
   （text_openai / image_openai / image_stability / image_mj）与一串模型 id；
   同一个 OpenAI 兼容端点常常同时挂文本模型与图像模型（如 api.apiyi.com 的
   gpt-image-2-vip 与 qwen3.7-plus），只配成 text_openai 时图像节点根本选不到那个
   图像模型，配错还会在运行期抛「未知服务商类型」。所以需要一层**模型级**的
   形态判定：

     · 自动识别 = 按模型 id 里的家族特征词打分（dall-e / gpt-image / flux /
       sd · stable-diffusion / midjourney / seedream / kolors / cogview /
       imagen / 通义万相 / qwen-image / hidream / hunyuan-image …），
       命中图像词 ⇒ image，否则 ⇒ text（image 优先，避免新家族被漏判）。
     · 手工覆盖 = 设置页模型行右侧的分类徽标可点，写进 config.modelKinds
       （{ "<providerId>": { "<modelId>": "text" | "image" } }），覆盖永远赢过识别。
     · 目录提示 = S.providerCatalog（pi-ai 目录 + DeepSeek 官方）里带 input 字段的
       模型（如 deepseek-flash = input ["text","image"]）只说明**能
       吃图**（视觉输入）≠ 出图，不参与形态判定，只作为视觉能力的补充判据。

   本模块是纯函数段（不碰 DOM / 不依赖 S），可被 test/ 直接切片真跑。
   取值口径统一走 modelKindOf / providerKinds / providerHasKind，
   渲染层各处（设置页模型徽标、节点设置的服务商 / 模型下拉、运行期兜底、
   导入导出解析）一律不自己写 id 前缀判断。

   同文件下半段还放**服务商模型策略**（同一批纯函数口径，见下面
   「服务商模型策略：白名单 / 黑名单 / 停用 / 三档超时」一节）：
   providerModelFilter（白名单先收窄 + 黑名单再剔除）、providerDisabled、
   providerSelectableModels（模型选择器统一取用）、providerTimeoutTiers、
   deepseekRouteSelectable。设置页服务商卡片读写这些字段，主进程按三档发请求。 */

/* ── 图像模型家族特征词（小写子串匹配） ──
   只放「几乎只可能是图像生成」的词；"vision" / "image" 之外的通用词不收，
   免得把 gpt-4o-image-understanding 之类文本模型误判进来。 */
const IMAGE_MODEL_MARKERS = [
  "dall-e",
  "dalle",
  "gpt-image",
  "gpt_image",
  "gptimage",
  "chatgpt-image",
  "images/",
  "image-gen",
  "text-to-image",
  "txt2img",
  "img2img",
  "stable-diffusion",
  "stable_diffusion",
  "stableimage",
  "sdxl",
  "sd3",
  "sd-3",
  "sd-turbo",
  "flux",
  "midjourney",
  "niji",
  "seedream",
  "seededit",
  "doubao-seedream",
  "kolors",
  "cogview",
  "imagen",
  "firefly",
  "ideogram",
  "recraft",
  "playground-v",
  "photon",
  "luma-photon",
  "wanx",
  "wan-2",
  "wan2",
  "qwen-image",
  "qwen_image",
  "通义万相",
  "万相",
  "doubao-image",
  "jimeng",
  "即梦",
  "hunyuan-image",
  "hunyuanimage",
  "混元图像",
  "janus-pro",
  "hidream",
  "ovis-image",
  "z-image",
  "zimage",
  "lucid-origin",
  "blip-diffusion",
  "kontext",
  "grok-2-image",
  "grok-image",
];

/* ── 明确的文本模型特征词：用来把「同一 id 里既像图像又像文本」的情况拉回文本 ──
   例如 kimi-k2.6 / deepseek-flash 这类明显是对话模型（含 flux 等词的极少见）。 */
const TEXT_MODEL_MARKERS = [
  "deepseek",
  "gpt-4",
  "gpt-3",
  "gpt-5",
  "gpt-oss",
  "o1-",
  "o3-",
  "o4-",
  "claude",
  "gemini",
  "qwen",
  "glm",
  "kimi",
  "moonshot",
  "mimo",
  "minimax",
  "grok",
  "llama",
  "gemma",
  "mistral",
  "mixtral",
  "phi-",
  "yi-",
  "ernie",
  "hunyuan-",
  "step-",
  "spark",
  "abab",
  "baichuan",
  "internlm",
  "chatglm",
  "nova-",
  "command-r",
  "sonar",
  "phi4",
  "phi3",
  "codex",
  "coder",
  "turbo-instruct",
];

const KIND_TEXT = "text";
const KIND_IMAGE = "image";

function lower(v) {
  return String(v == null ? "" : v).trim().toLowerCase();
}

/* 识别单个模型 id 的形态：命中图像特征词 ⇒ "image"，否则 "text"。
   识别不出的一律当文本（文本是绝大多数、且回退更安全：文本服务商路径
   /chat/completions 对未知 id 至少能报出服务端的明确错误）。 */
function inferModelKind(modelId) {
  const id = lower(modelId);
  if (!id) return KIND_TEXT;
  if (!IMAGE_MODEL_MARKERS.some((m) => id.includes(m))) return KIND_TEXT;
  /* 同时含明确文本家族词（如 deepseek 渠道里的 gpt-image 别名夹带文本词）——
     图像词更具体，仍然判图像；只有「图像词是泛词、文本词是明确家族」时才回文本。
     泛词名单：flux / kontext / photon / z-image 等短词可能出现在文本别名里。 */
  const strong = IMAGE_MODEL_MARKERS.some(
    (m) =>
      m.length > 3 &&
      id.includes(m) &&
      (m.includes("-") ||
        m.includes("_") ||
        m.includes("image") ||
        m.includes("diffusion") ||
        m.includes("万相") ||
        m.includes("即梦")),
  );
  if (strong) return KIND_IMAGE;
  return TEXT_MODEL_MARKERS.some((m) => id.includes(m)) ? KIND_TEXT : KIND_IMAGE;
}

/* 手工覆盖表读取：S.config.modelKinds = { [providerId]: { [modelId]: "text"|"image" } } */
function modelKindOverride(cfg, providerId, modelId) {
  const all = (cfg && cfg.modelKinds) || null;
  if (!all) return "";
  const per = all[String(providerId || "")];
  if (!per) return "";
  const v = lower(per[String(modelId || "")]);
  return v === KIND_TEXT || v === KIND_IMAGE ? v : "";
}

/* 单个模型形态的唯一入口：手工覆盖 > 自动识别 */
function modelKindOf(cfg, providerId, modelId) {
  return modelKindOverride(cfg, providerId, modelId) || inferModelKind(modelId);
}

/* 服务商「形态」：显式 image_* 类型 ⇒ image；显式 text_openai ⇒ text；
   其余（本地 TTS / 未设 type 的自定义服务商）按模型识别结果判定。 */
function providerKinds(cfg, prov) {
  const p = prov || {};
  const t = lower(p.type);
  if (t.startsWith("image_")) return [KIND_IMAGE];
  const models = Array.isArray(p.models) ? p.models : [];
  const kinds = new Set();
  for (const m of models) kinds.add(modelKindOf(cfg, p.id, m));
  if (t === "text_openai") {
    /* 配成文本、但里面有图像模型（用户最常见的错配）⇒ 两种形态都算，
       这样图像节点的服务商下拉能列出它、模型下拉再按形态过滤。 */
    return kinds.has(KIND_IMAGE) ? [KIND_TEXT, KIND_IMAGE] : [KIND_TEXT];
  }
  if (!kinds.size) return [KIND_TEXT];
  return [KIND_TEXT, KIND_IMAGE].filter((k) => kinds.has(k));
}

/* 服务商是否含指定形态的模型 */
function providerHasKind(cfg, prov, kind) {
  return providerKinds(cfg, prov).indexOf(kind) >= 0;
}

/* 该服务商里属于指定形态的模型列表（保持原顺序）。
   先过服务商白 / 黑名单（providerModelFilter）—— 节点设置的服务商 / 模型下拉、节点「无模型」
   闸门都取这一份，被策略剔除的模型因此既选不到、也用不了（白 / 黑名单说的是「这个模型不许用」）。
   注意**停用只影响可见性、不影响这里**：disabled 的服务商不进制选择器，但画布上早就绑着它的
   节点照旧能跑（停用是「把它收起来」，不是「把已有画布打断」）。 */
function modelsOfKind(cfg, prov, kind) {
  return providerModelFilter(prov, prov && prov.models).filter(
    (m) => modelKindOf(cfg, prov && prov.id, m) === kind,
  );
}

/* 服务商「默认形态」：用于「添加服务商」与错配兜底 ——
   有显式 type 就按 type；否则按第一个模型的识别结果。 */
function defaultKindOfProvider(cfg, prov) {
  const kinds = providerKinds(cfg, prov);
  if (kinds.length === 1) return kinds[0];
  const models = (prov && Array.isArray(prov.models) ? prov.models : []) || [];
  return models.length ? modelKindOf(cfg, prov.id, models[0]) : KIND_TEXT;
}

/* 目录提示（可选）：S.providerCatalog 里同一模型标注 input 是否含 image
   —— 只说明「能吃图」（视觉输入），不是出图。给设置页作视觉能力补充判据。 */
function catalogModelAcceptsImage(catalog, modelId) {
  const id = String(modelId || "");
  if (!id || !catalog) return false;
  const pools = [];
  if (Array.isArray(catalog.deepseek)) pools.push(catalog.deepseek);
  for (const p of catalog.piai || []) pools.push(p.models || []);
  for (const pool of pools) {
    for (const m of pool) {
      if (!m) continue;
      if (String(m.id) !== id) continue;
      return Array.isArray(m.input) && m.input.indexOf("image") >= 0;
    }
  }
  return false;
}

/* ═══════════ 服务商模型策略：白名单 / 黑名单 / 停用 / 三档超时 ═══════════
   对标 OpenCode 的 provider 配置，服务商记录多了四个**可选**字段（老配置不填 = 行为一字不变，
   缺省值必须与现状完全一致）：
     · modelAllow  字符串，逗号 / 空格分隔的模型名通配模式。**白名单先收窄**：非空时只保留命中的模型。
     · modelDeny   字符串，同格式。**黑名单再剔除**：在白名单结果上删掉命中的模型。
     · disabled    布尔，停用该服务商（配置与密钥保留，只是不进模型选择器、不参与智能路由）。
     · timeoutConnect / timeoutHeader / timeoutChunk  数字（毫秒）：建立连接 / 首个响应字节 /
       分块之间的空闲三档超时，缺省 300000（只影响主进程发请求，见 main.js 的四段看门狗）。
   通配语义照 OpenCode：`*` 匹配零个或多个字符、`?` 匹配一个字符，其余字符按字面量（正则元字符
   一律转义）；匹配对象是模型 id，大小写不敏感更友好。
   本段是纯函数段（不碰 DOM / 不依赖 S），test/smoke-provider-policy.js 直接 require 真跑。 */
const TIMEOUT_DEFAULT_MS = 300000;

/* 单个字面量字符的正则转义（通配符不在此列，由调用方单独拼接） */
function escapeRegExpLiteral(ch) {
  return String(ch == null ? "" : ch).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/* 通配模式 → 正则：* = 零或多个、? = 恰好一个，其余字面量；整体锚定 + 大小写不敏感。
   空模式返回 null（调用方跳过），避免空串变成「匹配一切」。 */
function modelGlobToRegExp(pattern) {
  const p = String(pattern == null ? "" : pattern).trim();
  if (!p) return null;
  let src = "";
  for (const ch of p) {
    if (ch === "*") src += ".*";
    else if (ch === "?") src += ".";
    else src += escapeRegExpLiteral(ch);
  }
  return new RegExp("^" + src + "$", "i");
}

/* 模式串 → 模式数组：逗号（中英）/ 分号 / 空白（含换行）分隔，去空、去重、保持书写顺序 */
function modelPatterns(text) {
  const out = [];
  const seen = new Set();
  for (const raw of String(text == null ? "" : text).split(/[,，;；\s]+/)) {
    const p = raw.trim();
    if (!p || seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

/* 模型 id 是否命中这批模式中的任意一个 */
function modelMatchesPatterns(modelId, patterns) {
  const id = String(modelId == null ? "" : modelId).trim();
  if (!id) return false;
  for (const p of patterns || []) {
    const re = modelGlobToRegExp(p);
    if (re && re.test(id)) return true;
  }
  return false;
}

/* 用户手动停用：只有显式 disabled === true 才算（缺省 / 老配置一律照旧可用）。
   与「不可用」分开：设置页那个「启用」勾选框读的是它，中转服务余额耗尽不能让勾选框自己掉了。 */
function providerManuallyOff(prov) {
  return !!(prov && prov.disabled === true);
}

/* MTNode 中转服务（source="mtnode-relay"，见 renderer/app-relay.js）余额耗尽：
   卡还在（有过充值就永久显示），但**不许被引用** —— 节点 / 会话的模型选择器一律列不到它。
   判据来自云端快照：relay.blocked（可用余额 ≤ 0 或服务端回空清单）。 */
function providerRelayBlocked(prov) {
  return !!(
    prov &&
    String(prov.source || "") === "mtnode-relay" &&
    prov.relay &&
    prov.relay.blocked === true
  );
}

/* 服务商是否不进任何「给用户选模型」的地方：手动停用，或中转服务余额耗尽 */
function providerDisabled(prov) {
  return providerManuallyOff(prov) || providerRelayBlocked(prov);
}

/* 选择器里的状态后缀（"" / 已停用 / 余额不足）：叫法分开，用户才分得清
   「我自己关掉的」和「钱花完了、充上就能用」。 */
function providerStateText(prov) {
  if (providerManuallyOff(prov)) return I18n.t("已停用");
  if (providerRelayBlocked(prov)) return I18n.t("余额不足");
  return "";
}

/* 单个模型 id 是否通过该服务商的白 / 黑名单（先白名单收窄、再黑名单剔除） */
function providerModelAllowed(prov, modelId) {
  if (!prov) return true;
  const allow = modelPatterns(prov.modelAllow);
  if (allow.length && !modelMatchesPatterns(modelId, allow)) return false;
  const deny = modelPatterns(prov.modelDeny);
  if (deny.length && modelMatchesPatterns(modelId, deny)) return false;
  return true;
}

/* 服务商「模型过滤」唯一入口：先白名单收窄、再黑名单剔除。
   allow / deny 都留空 ⇒ 原样返回（老配置行为一字不变）；models 省略时取 prov.models。
   幂等：对已经过滤过的清单再过滤一次结果不变（调用点可以放心叠加）。 */
function providerModelFilter(prov, models) {
  const src = Array.isArray(models)
    ? models
    : (prov && Array.isArray(prov.models) ? prov.models : []) || [];
  const list = src.map((m) => String(m));
  if (!prov) return list;
  const allowRe = modelPatterns(prov.modelAllow)
    .map(modelGlobToRegExp)
    .filter(Boolean);
  const denyRe = modelPatterns(prov.modelDeny)
    .map(modelGlobToRegExp)
    .filter(Boolean);
  if (!allowRe.length && !denyRe.length) return list;
  return list.filter((id) => {
    if (allowRe.length && !allowRe.some((re) => re.test(id))) return false;
    if (denyRe.some((re) => re.test(id))) return false;
    return true;
  });
}

/* 模型选择器取用的清单：停用的服务商一律返回空表 —— 它在设置里仍可见 / 可编辑 / 可恢复，
   只是不出现在任何「给用户选模型」的地方。 */
function providerSelectableModels(prov) {
  if (providerDisabled(prov)) return [];
  return providerModelFilter(prov, prov && prov.models);
}

/* 三档请求超时（毫秒）：连接 / 首字节 / 分块之间空闲，缺省 300000；
   非数字或 <= 0 一律按缺省（0 在这里不做「不设时限」解释 —— 那档只有生图路径有）。 */
function providerTimeoutTiers(prov) {
  const pick = (k) => {
    const n = Number(prov && prov[k]);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : TIMEOUT_DEFAULT_MS;
  };
  return {
    timeoutConnect: pick("timeoutConnect"),
    timeoutHeader: pick("timeoutHeader"),
    timeoutChunk: pick("timeoutChunk"),
  };
}

/* 随 spec 下发给主进程的三档超时字段（缺省 300000）：渲染层唯一出处。
   主进程 timeoutTiersOf(spec, spec.provider) 优先读这几个显式字段，再退到服务商对象。 */
function providerTimeoutSpec(prov) {
  const t = providerTimeoutTiers(prov);
  return {
    timeoutConnect: t.timeoutConnect,
    timeoutHeader: t.timeoutHeader,
    timeoutChunk: t.timeoutChunk,
  };
}

/* 「DeepSeek 官方」路由是否可选：配置里那家 DeepSeek 服务商被停用时，官方路由一并消失
   （一家 DeepSeek 都没配 ⇒ 目录兜底路由照旧可选，与停用功能上线前完全一致）。 */
function deepseekRouteSelectable(cfg) {
  const ds = [];
  for (const p of (cfg && cfg.providers) || []) {
    if (!p || p.type !== "text_openai" || !String(p.baseUrl || "").trim()) continue;
    let host = "";
    try {
      host = new URL(p.baseUrl).hostname.toLowerCase();
    } catch {}
    if (host.includes("deepseek")) ds.push(p);
  }
  if (!ds.length) return true;
  return ds.some((p) => !providerDisabled(p));
}

/* ── 与执行路径对接的小工具 ── */

/* 节点 kind → 需要的模型形态（proc_text / remotion 要文本；proc_image 要图像）。
   SenseNova 图像节点（sensenova_gen）不需要云端模型：出图由本机后端完成，参数里没有
   服务商 / 模型 —— 绝不能算成 KIND_IMAGE，那会把它路由进图像服务商选择器并在缺服务商时报错。 */
function modelKindForNode(node) {
  if (!node) return KIND_TEXT;
  return node.kind === "proc_image" ? KIND_IMAGE : KIND_TEXT;
}

/* 主进程 buildRequestSpec 的服务商类型名：形态 + 原类型族。
   OpenAI 兼容的图像请求（/images/generations · /images/edits）由 image_openai 承担，
   Stability / Midjourney 那些专用端点保持各自类型不动。 */
function providerTypeForKind(prevType, kind) {
  const t = lower(prevType);
  if (kind === KIND_IMAGE) {
    if (t.startsWith("image_")) return prevType;
    return "image_openai";
  }
  if (t.startsWith("image_")) return "text_openai";
  return prevType || "text_openai";
}

/* 运行期兜底：**本次要用的那个模型**的形态与服务商类型不符时，算出应有的类型。
   只按模型形态算，不按节点 kind —— 节点 kind 决定它该选哪类模型，真正下发请求的
   是所选模型；模型与节点形态也不符时由调用方另行拦下（本函数只管类型纠偏）。
   返回空串 = 无需改动。 */
function correctedTypeForModel(cfg, prov, modelId) {
  if (!prov) return "";
  const mid = String(modelId || "").trim();
  if (!mid) return "";
  const next = providerTypeForKind(prov.type, modelKindOf(cfg, prov && prov.id, mid));
  return next === prov.type ? "" : next;
}

/* 本次请求要用的服务商对象：类型与所选模型形态不符时返回**改过 type 的副本**，
   原对象一字不动；无需纠偏时原样返回同一个引用。
   为什么必须是副本：type 是用户配置里的**持久字段**，而一个 OpenAI 兼容端点常常同时挂
   文本与图像模型（最典型 = MTNode 中转服务卡，恒为 text_openai，形态靠 config.modelKinds
   逐模型给出）。运行期把这张卡的 type 改成另一形态，会让**这一家的另一类模型**从所有
   模型选择器里一起消失（会话模型列表只认 text_openai 的服务商），用户得去设置里刷新才
   能看见 —— 就是「用着用着模型突然不见了」那类报障。 */
function providerForRequest(cfg, prov, modelId) {
  if (!prov) return prov;
  const next = correctedTypeForModel(cfg, prov, modelId);
  return next ? Object.assign({}, prov, { type: next }) : prov;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    KIND_TEXT,
    KIND_IMAGE,
    IMAGE_MODEL_MARKERS,
    TEXT_MODEL_MARKERS,
    TIMEOUT_DEFAULT_MS,
    inferModelKind,
    modelKindOverride,
    modelKindOf,
    providerKinds,
    providerHasKind,
    modelsOfKind,
    defaultKindOfProvider,
    catalogModelAcceptsImage,
    modelKindForNode,
    providerTypeForKind,
    correctedTypeForModel,
    providerForRequest,
    /* 服务商模型策略：白名单 / 黑名单 / 停用 / 三档超时 */
    modelGlobToRegExp,
    modelPatterns,
    modelMatchesPatterns,
    providerDisabled,
    providerModelAllowed,
    providerModelFilter,
    providerSelectableModels,
    providerTimeoutTiers,
    providerTimeoutSpec,
    deepseekRouteSelectable,
  };
}
