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
       模型（如 deepseek-v4-flash-vision-exp = input ["text","image"]）只说明**能
       吃图**（视觉输入）≠ 出图，不参与形态判定，只作为视觉能力的补充判据。

   本模块是纯函数段（不碰 DOM / 不依赖 S），可被 test/ 直接切片真跑。
   取值口径统一走 modelKindOf / providerKinds / providerHasKind，
   渲染层各处（设置页模型徽标、节点设置的服务商 / 模型下拉、运行期兜底、
   导入导出解析）一律不自己写 id 前缀判断。 */

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
   例如 kimi-k2.6 / deepseek-v4-flash 这类明显是对话模型（含 flux 等词的极少见）。 */
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

/* 该服务商里属于指定形态的模型列表（保持原顺序） */
function modelsOfKind(cfg, prov, kind) {
  const models = (prov && Array.isArray(prov.models) ? prov.models : []) || [];
  return models.filter((m) => modelKindOf(cfg, prov && prov.id, m) === kind);
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

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    KIND_TEXT,
    KIND_IMAGE,
    IMAGE_MODEL_MARKERS,
    TEXT_MODEL_MARKERS,
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
  };
}
