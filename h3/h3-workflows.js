"use strict";
/**
 * H3「自建 ComfyUI 工作流」库 —— 纯 Node 模块（不 require electron，可被 test/smoke-*.js 直接 require）。
 *
 * 职责（本模块是库 / 节点面板 / 执行三方唯一共享的真源）：
 *  ① 全局库读写：<dataDir>/h3-workflows/（registry index.json + 每条 <id>/workflow.json）
 *  ② 工作流格式判定与转换：ComfyUI API 格式直接用；UI 格式（{nodes:[],links:[]}）转成 API 格式
 *  ③ 参数候选扫描：按 class_type / 字段名智能预填映射建议，并列出输出（Save*）节点
 *  ④「提升为节点参数」的 schema 定义与校验
 *  ⑤ applyMapping：把参数值注入 API graph；节点级单一种子统一下发到全部被标 seed 的字段
 *
 * 设计边界：本模块不碰网络、不读 electron、不做任何 IPC —— 校验 /p 提交等由 main-h3.js 负责。
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

/* ───────────────────────── 常量 ───────────────────────── */

const WORKFLOWS_DIRNAME = "h3-workflows";
const REGISTRY_FILE = "index.json";
const WORKFLOW_FILE = "workflow.json";
const REGISTRY_VERSION = 1;
/** 单个工作流 JSON 上限（ComfyUI 图再大也远小于此；防误传整包备份） */
const MAX_IMPORT_BYTES = 8 * 1024 * 1024;

/** 「提升为节点参数」支持的参数类型（真源，节点面板与执行分支共用） */
const PARAM_TYPES = Object.freeze(["text", "number", "image", "video", "audio", "seed"]);
const PARAM_TYPE_SET = new Set(PARAM_TYPES);

/** seed 类字段名（节点级单一种子统一下发的判定） */
const SEED_FIELD_RE = /^(seed|noise_seed|random_seed|video_seed|audio_seed|generator_seed|seed_value)$/i;

/** UI 格式里存在、但 API graph 不存在的纯前端控件值（转换时必须丢弃） */
const UI_ONLY_WIDGETS = new Set([
  "control_after_generate",
  "upload",
  "callback",
  "sound",
  "toggle",
]);

/** 纯前端节点（无后端 class_type，进 /prompt 必炸）：转换时直接丢弃 */
const UI_ONLY_CLASSES = new Set(["note", "markdownnote", "group", "comfy.group"]);

/** 透传节点：API 图里没有对应类，转换时把它的输入源直接接到下游 */
const PASSTHROUGH_CLASSES = new Set(["reroute"]);

/** 常量原语节点（widget 模板）：转换时把值内联进下游字段 */
const CONSTANT_CLASSES = /^(primitive(node|int|float|number|string|stringmultiline|boolean)|constant)$/i;

/** 输出（产物落盘）节点识别 —— 执行分支据此从 /history 找产物 */
const OUTPUT_CLASS_RE = /^(save|write|store|encode)/i;
const OUTPUT_CLASS_HINT_RE = /(SaveVideo|SaveAnimated|SaveImage|SaveAudio|SaveWebM|SaveGIF|Save3D|VideoCombine|SaveTensor|SaveLatent|StoreVideo)/i;

/** widgets_values 顺序未知时，按 class_type 兜底的字段名表（老版本导出的 UI 工作流）。
 *  注意：这里写的是 **UI 里真实控件顺序**（含 control_after_generate 等 UI 专属控件），
 *  赋值时再按 UI_ONLY_WIDGETS 跳过，才能与 widgets_values 数量对齐。 */
const LEGACY_WIDGET_ORDER = {
  CheckpointLoaderSimple: ["ckpt_name"],
  CheckpointLoader: ["config_name", "ckpt_name"],
  UNetLoader: ["unet_name", "weight_dtype"],
  UnetLoaderGGUF: ["unet_name"],
  UnetLoader: ["unet_name", "weight_dtype"],
  VAELoader: ["vae_name"],
  CLIPLoader: ["clip_name", "type", "device"],
  DualCLIPLoader: ["clip_name1", "clip_name2", "type", "device"],
  TripleCLIPLoader: ["clip_name1", "clip_name2", "clip_name3", "type", "device"],
  QuadrupleCLIPLoader: ["clip_name1", "clip_name2", "clip_name3", "clip_name4", "type"],
  CLIPSetLastLayer: ["stop_at_clip_layer"],
  CLIPTextEncode: ["text"],
  CLIPTextEncodeSDXL: ["text_g", "text_l", "crop_w", "crop_h"],
  CLIPTextEncodeSD3: ["text_g", "text_l", "tshift"],
  CLIPTextEncodeFlux: ["clip", "guidance"],
  TextEncodeQwenImageEdit: ["prompt"],
  "String Literal": ["string"],
  "CR Text": ["text"],
  LoraLoader: ["lora_name", "strength_model", "strength_clip"],
  LoraLoaderModelOnly: ["lora_name", "strength_model"],
  KSampler: ["seed", "control_after_generate", "steps", "cfg", "sampler_name", "scheduler", "denoise"],
  KSamplerAdvanced: [
    "add_noise",
    "noise_seed",
    "control_after_generate",
    "steps",
    "cfg",
    "sampler_name",
    "scheduler",
    "start_at_step",
    "end_at_step",
    "return_with_leftover_noise",
  ],
  "KSampler (Advanced)": [
    "add_noise",
    "noise_seed",
    "control_after_generate",
    "steps",
    "cfg",
    "sampler_name",
    "scheduler",
    "start_at_step",
    "end_at_step",
    "return_with_leftover_noise",
  ],
  RandomNoise: ["noise_seed"],
  BasicScheduler: ["scheduler", "steps", "denoise"],
  KSamplerSelect: ["sampler_name"],
  EmptyLatentImage: ["width", "height", "batch_size"],
  EmptySD3LatentImage: ["width", "height", "batch_size"],
  EmptyHunyuanLatentVideo: ["width", "height", "length", "batch_size"],
  EmptyWanLatentVideo: ["width", "height", "length", "batch_size"],
  LoadImage: ["image", "upload"],
  LoadImageMask: ["image", "channel"],
  LoadVideo: ["file", "audio"],
  LoadAudio: ["audio", "start_time", "duration"],
  CreateVideo: ["fps", "bit_depth"],
  SaveVideo: ["filename_prefix", "format", "codec"],
  SaveImage: ["filename_prefix"],
  SaveAnimatedWEBP: ["filename_prefix", "fps", "lossless", "quality", "method"],
  VHS_VideoCombine: ["frame_rate", "loop_count", "filename_prefix", "format", "pingpong", "save_output"],
  ImageScale: ["upscale_method", "width", "height", "crop"],
  ImageScaleBy: ["upscale_method", "scale_by"],
  UpscaleModelLoader: ["model_name"],
  "RIFE VFI": ["ckpt_name", "clear_cache_after_n_frames", "multiplier", "fast_mode", "ensemble", "scale_factor", "dtype", "torch_compile", "batch_size"],
  MiniMaxH3ImageToVideo: ["prompt", "width", "height", "length"],
  MiniMaxH3ReferenceToVideo: ["prompt", "width", "height", "length", "ref_image_size"],
  MiniMaxH3SigmaShift: ["shift_video", "shift_audio"],
  EasyCache: ["reuse_threshold", "start_percent", "end_percent", "verbose"],
  "MiniMaxLowVRAMAttention": ["head_chunks"],
  "MiniMaxChunkFeedForward": ["chunks", "seq_threshold"],
};

/** 参数候选扫描规则：按顺序命中第一条（classRe 与 fieldRe 都需匹配；valueKind 可选约束现值类型） */
const SCAN_RULES = Object.freeze([
  {
    id: "h3_prompt",
    classRe: /MiniMaxH3/i,
    fieldRe: /^prompt$/i,
    type: "text",
    label: "画面提示词",
    role: "prompt",
    suggested: true,
    valueKind: "string",
  },
  {
    id: "clip_text",
    classRe: /(CLIPTextEncode|TextEncode|Conditioning|CR Text|Prompt|StringLiteral|Text .*(Node|Literal))/i,
    fieldRe: /^(text|string|value|prompt|negative|positive|caption|description|sampler_prefix)$/i,
    type: "text",
    label: "文本提示词",
    role: "prompt",
    suggested: true,
    valueKind: "string",
  },
  {
    id: "load_image",
    classRe: /(LoadImage|Load.*Image$|ImageLoad|LoadImageMask)/i,
    fieldRe: /^(image|img|input_image|mask|reference_image)$/i,
    type: "image",
    label: "图像素材",
    role: "image",
    suggested: true,
    valueKind: "string",
  },
  {
    id: "load_video",
    classRe: /(LoadVideo|VHS_LoadVideo|Video.*Load.*File)/i,
    fieldRe: /^(file|video|video_path|input_video|filename)$/i,
    type: "video",
    label: "视频素材",
    role: "video",
    suggested: true,
    valueKind: "string",
  },
  {
    id: "load_audio",
    classRe: /(LoadAudio|VHS_LoadAudio|Audio.*Load)/i,
    fieldRe: /^(audio|audio_file|file|filename|input_audio)$/i,
    type: "audio",
    label: "音频素材",
    role: "audio",
    suggested: true,
    valueKind: "string",
  },
  { id: "seed", fieldRe: SEED_FIELD_RE, type: "seed", label: "随机种子", role: "seed", suggested: true, valueKind: "number" },
  {
    id: "steps",
    classRe: /(Sampler|Scheduler|SamplerCustom|KSampler)/i,
    fieldRe: /^steps$/i,
    type: "number",
    label: "采样步数",
    role: "steps",
    suggested: false,
    valueKind: "number",
  },
  { id: "cfg", fieldRe: /^(cfg|cfg_scale|scale|guider_speed)$/i, type: "number", label: "CFG 强度", role: "cfg", suggested: false, valueKind: "number" },
  { id: "denoise", fieldRe: /^denoise$/i, type: "number", label: "重绘幅度", role: "denoise", suggested: false, valueKind: "number" },
  {
    id: "size",
    classRe: /(Empty.*Latent|Latent|ImageScale|CreateVideo|MiniMaxH3|VideoScale|Upscale)/i,
    fieldRe: /^(width|height)$/i,
    type: "number",
    label: "分辨率",
    role: "size",
    suggested: false,
    valueKind: "number",
  },
  {
    id: "length",
    classRe: /(Empty.*Video|MiniMaxH3|Hunyuan|Wan|LatentVideo|CreateVideo)/i,
    fieldRe: /^(length|frames|num_frames|video_length|frame_count|duration)$/i,
    type: "number",
    label: "视频长度",
    role: "length",
    suggested: false,
    valueKind: "number",
  },
  { id: "fps", fieldRe: /^(fps|frame_rate)$/i, type: "number", label: "帧率", role: "fps", suggested: false, valueKind: "number" },
  {
    id: "sampler_pick",
    fieldRe: /^(sampler_name|scheduler)$/i,
    type: "text",
    label: "采样器 / 调度器",
    role: "enum",
    suggested: false,
    valueKind: "string",
  },
  {
    id: "model_pick",
    fieldRe: /^(ckpt_name|unet_name|clip_name|vae_name|lora_name|model_name|model|upscale_model|diffusion_model)$/i,
    type: "text",
    label: "模型选择",
    role: "model",
    suggested: false,
    valueKind: "string",
  },
  {
    id: "prefix",
    fieldRe: /^filename_prefix$/i,
    type: "text",
    label: "输出文件名前缀",
    role: "prefix",
    suggested: false,
    valueKind: "string",
  },
  {
    id: "any_string",
    fieldRe: /^(prompt|text|string|value|caption)$/i,
    type: "text",
    label: "文本参数",
    role: "text",
    suggested: true,
    valueKind: "string",
  },
]);

/* ───────────────────── 通用小工具 ───────────────────── */

function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function isLink(v) {
  return (
    Array.isArray(v) &&
    v.length === 2 &&
    (typeof v[0] === "string" || typeof v[0] === "number") &&
    typeof v[1] === "number"
  );
}

function cloneGraph(graph) {
  return JSON.parse(JSON.stringify(graph || {}));
}

function stableHash(text, n) {
  return crypto.createHash("sha1").update(String(text)).digest("hex").slice(0, n || 8);
}

function normalizeTitle(t) {
  return String(t == null ? "" : t).replace(/\s+/g, " ").trim();
}

function titleKey(t) {
  return normalizeTitle(t).toLowerCase();
}

function sanitizeForFs(text, fallback) {
  const s = String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9_\-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return s || String(fallback || "wf");
}

function assertSafeId(id) {
  const s = String(id || "");
  if (!/^[A-Za-z0-9._\-]{1,80}$/.test(s) || s === "." || s === ".." || s.includes("..")) {
    const err = new Error("工作流 id 非法：" + s);
    err.code = "bad_id";
    throw err;
  }
  return s;
}

/** 不抛异常的版本：供 IPC 面向用户的入口返回 {ok:false,error} */
function assertSafeIdSafeArg(id) {
  try {
    return { ok: true, id: assertSafeId(id) };
  } catch (e) {
    return { ok: false, id: "", error: readableError(e) };
  }
}

function readJsonSafe(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + ".tmp-" + process.pid + "-" + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
  try {
    if (fs.existsSync(p)) fs.rmSync(p, { force: true });
  } catch {}
  fs.renameSync(tmp, p);
}

function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return v + " B";
  if (v < 1024 * 1024) return (v / 1024).toFixed(1) + " KB";
  return (v / 1024 / 1024).toFixed(2) + " MB";
}

/* ───────────── ② 格式判定与 UI → API 转换 ───────────── */

/** 是否 ComfyUI API（/prompt 的 prompt 字段）格式：{ "1": {class_type, inputs}, ... } */
function looksLikeApiGraph(obj) {
  if (!isPlainObject(obj)) return false;
  const keys = Object.keys(obj);
  if (!keys.length) return false;
  for (const k of keys) {
    const node = obj[k];
    if (!isPlainObject(node)) return false;
    if (typeof node.class_type !== "string" || !node.class_type.trim()) return false;
    if (!isPlainObject(node.inputs)) return false;
  }
  return true;
}

/** 是否 ComfyUI 前端 UI 格式：{ nodes:[], links:[] } */
function looksLikeUiGraph(obj) {
  if (!isPlainObject(obj)) return false;
  if (!Array.isArray(obj.nodes) || !obj.nodes.length) return false;
  if (!obj.nodes.every((n) => isPlainObject(n) && (n.type || n.class_type))) return false;
  return Array.isArray(obj.links) || obj.links === null || obj.links === undefined;
}

/**
 * 判定导入内容属于哪种格式。
 * @returns {{format:"api"|"ui"|"unknown", graph:Object|null, reason:string}}
 */
function detectFormat(parsed) {
  if (!isPlainObject(parsed)) {
    return { format: "unknown", graph: null, reason: "JSON 顶层必须是对象（工作流图），实际不是。" };
  }
  if (looksLikeApiGraph(parsed)) return { format: "api", graph: parsed, reason: "API 格式（{节点id:{class_type,inputs}}）" };
  /* 少数导出会把图包一层：{prompt:{...}} / {workflow:{...}} / {nodes:{...}} */
  for (const key of ["prompt", "workflow", "payload"]) {
    const inner = parsed[key];
    if (looksLikeApiGraph(inner)) {
      return { format: "api", graph: inner, reason: "API 格式（外层包了 " + key + "，已自动剥开）" };
    }
  }
  if (isPlainObject(parsed.nodes) && !Array.isArray(parsed.nodes)) {
    if (looksLikeApiGraph(parsed.nodes)) {
      return { format: "api", graph: parsed.nodes, reason: "API 格式（外层包了 nodes 对象，已自动剥开）" };
    }
  }
  if (looksLikeUiGraph(parsed)) return { format: "ui", graph: parsed, reason: "ComfyUI 前端 UI 格式（{nodes:[],links:[]}）" };
  if (Array.isArray(parsed.nodes)) {
    return {
      format: "unknown",
      graph: null,
      reason: "看起来是 UI 格式，但 nodes 里缺少 type 字段或为空，无法识别节点类型。",
    };
  }
  return {
    format: "unknown",
    graph: null,
    reason:
      "既不是 ComfyUI API 格式（{节点id:{class_type,inputs}}），也不是 UI 格式（{nodes:[],links:[]}）。" +
      "请在 ComfyUI 菜单里用「工作流 → 导出（API 格式）」重新导出。",
  };
}

function isUiOnlyClass(cls) {
  return UI_ONLY_CLASSES.has(String(cls || "").toLowerCase());
}

function isPassthroughClass(cls) {
  return PASSTHROUGH_CLASSES.has(String(cls || "").toLowerCase());
}

function constantValueOf(node) {
  const wv = Array.isArray(node.widgets_values) ? node.widgets_values : [];
  for (const v of wv) {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "boolean") return v;
    if (typeof v === "string" && v.trim() && !UI_ONLY_WIDGETS.has(v)) return v;
  }
  return undefined;
}

/**
 * UI 格式（前端保存的 workflow.json）→ API 格式（/prompt 用的 graph）。
 * 丢弃纯前端字段（pos/size/flags/order/mode/properties/serialize 等）与 UI 专属控件值。
 * @throws {Error} 带中文可读信息
 */
function uiToApiGraph(doc) {
  if (!isPlainObject(doc) || !Array.isArray(doc.nodes) || !doc.nodes.length) {
    throw new Error("UI 工作流里没有任何节点（nodes 为空）。");
  }
  const warnings = [];
  const nodes = doc.nodes;
  const byId = new Map();
  for (const n of nodes) {
    const id = String(n && n.id != null ? n.id : "").trim();
    if (!id) throw new Error("UI 工作流中存在没有 id 的节点，无法转换。");
    if (byId.has(id)) throw new Error("UI 工作流中存在重复节点 id：" + id);
    byId.set(id, n);
  }
  /** links: [link_id, origin_id, origin_slot, target_id, target_slot, type] */
  const linkById = new Map();
  for (const l of Array.isArray(doc.links) ? doc.links : []) {
    if (!Array.isArray(l) || l.length < 5) continue;
    linkById.set(Number(l[0]), {
      from: String(l[1]),
      fromSlot: Number(l[2]) || 0,
      to: String(l[3]),
      toSlot: Number(l[4]) || 0,
    });
  }

  const resolveOrigin = (fromId, slot, depth) => {
    let cur = byId.get(String(fromId));
    let curId = String(fromId);
    let curSlot = slot;
    let hops = depth || 0;
    while (cur && isPassthroughClass(cur.type || cur.class_type)) {
      if (hops++ > 32) throw new Error("透传节点（Reroute）链路过长或成环，无法转换。");
      const ins = Array.isArray(cur.inputs) ? cur.inputs : [];
      const linked = ins.find((i) => i && i.link != null && linkById.has(Number(i.link)));
      if (!linked) return null; // 悬空透传：下游视为未连接
      const lk = linkById.get(Number(linked.link));
      curId = lk.from;
      cur = byId.get(curId);
      curSlot = lk.fromSlot;
    }
    if (!cur) return null;
    return { nodeId: curId, slot: curSlot, classType: String(cur.type || cur.class_type || "") };
  };

  const constantIds = new Set();
  for (const n of nodes) {
    if (CONSTANT_CLASSES.test(String(n.type || n.class_type || ""))) constantIds.add(String(n.id));
  }
  const constantValues = new Map();
  for (const id of constantIds) {
    const n = byId.get(id);
    const v = constantValueOf(n);
    if (v === undefined) {
      warnings.push("常量节点 " + id + "（" + (n.type || "") + "）没有可读到的值，已忽略。");
      constantValues.set(id, null);
    } else {
      constantValues.set(id, v);
    }
  }

  const graph = {};
  let droppedUiOnly = 0;
  for (const n of nodes) {
    const id = String(n.id);
    const cls = String(n.type || n.class_type || "").trim();
    if (!cls) throw new Error("节点 " + id + " 缺少 type（class_type），无法转换。");
    if (isUiOnlyClass(cls)) {
      droppedUiOnly++;
      continue;
    }
    if (isPassthroughClass(cls)) {
      /* 透传节点（Reroute）在 API 图里没有对应类：它的输入源已解到下游，这里直接丢弃 */
      droppedUiOnly++;
      continue;
    }
    if (Number(n.mode) === 2) warnings.push("节点 " + id + "（" + cls + "）在 ComfyUI 里是「静音」状态，导入后仍会参与执行。");
    if (Number(n.mode) === 4) warnings.push("节点 " + id + "（" + cls + "）在 ComfyUI 里是「旁路(bypass)」状态，API 提交不支持旁路，请按直连结果检查该节点。");
    if (constantIds.has(id)) continue; // 值已内联进下游

    const inputs = {};
    const slotDefs = Array.isArray(n.inputs) ? n.inputs : [];

    /* 1) 连线输入 */
    for (const slot of slotDefs) {
      if (!slot || slot.link == null) continue;
      const lk = linkById.get(Number(slot.link));
      if (!lk) {
        warnings.push("节点 " + id + " 的输入「" + slot.name + "」指向不存在的连线 " + slot.link + "，已忽略。");
        continue;
      }
      const originNode = byId.get(lk.from);
      if (!originNode) {
        warnings.push("节点 " + id + " 的输入「" + slot.name + "」指向不存在的节点 " + lk.from + "，已忽略。");
        continue;
      }
      if (constantIds.has(lk.from)) {
        const v = constantValues.get(lk.from);
        if (v !== undefined && v !== null) inputs[String(slot.name)] = v;
        continue;
      }
      const resolved = resolveOrigin(lk.from, lk.fromSlot, 0);
      if (!resolved) {
        warnings.push("节点 " + id + " 的输入「" + slot.name + "」经透传节点回溯后无有效来源，已忽略。");
        continue;
      }
      inputs[String(slot.name)] = [resolved.nodeId, Number(resolved.slot) || 0];
    }

    /* 2) widget 值：优先用 inputs[].widget 给出的真实字段名（新版导出），
     *    否则按 class_type 的已知控件顺序兜底（老版导出），再退到「未连线的标量槽名」。 */
    const wv = Array.isArray(n.widgets_values) ? n.widgets_values : [];
    if (wv.length) {
      const widgetNames = slotDefs.filter((s) => s && s.widget && s.widget.name).map((s) => String(s.widget.name));
      const legacyKey = String(n.type || n.class_type || "");
      const legacy = LEGACY_WIDGET_ORDER[legacyKey] || LEGACY_WIDGET_ORDER[legacyKey.replace(/\s+/g, " ")] || [];
      const unlinkedScalar = slotDefs
        .filter((s) => s && s.link == null && !s.widget)
        .map((s) => String(s.name || ""));
      const canUse = (list) => list.length === wv.length && list.every((x) => !!x);
      let names = [];
      let aligned = true;
      if (canUse(widgetNames)) names = widgetNames;
      else if (canUse(legacy)) names = legacy.slice();
      else if (canUse(unlinkedScalar)) names = unlinkedScalar;
      else {
        /* 数量对不上（存在隐藏 widget / 未收录的节点类型）：能对上多少算多少，并明确告警 */
        aligned = false;
        names = widgetNames.length ? widgetNames : legacy.length ? legacy.slice() : unlinkedScalar;
      }
      if (!names.length) {
        warnings.push("节点 " + id + "（" + cls + "）有 " + wv.length + " 个控件值但无法对应字段名，已跳过其参数（连线仍保留）。");
      } else {
        const take = Math.min(names.length, wv.length);
        for (let i = 0; i < take; i++) {
          const name = names[i];
          if (!name || UI_ONLY_WIDGETS.has(name)) continue;
          if (name.startsWith("_")) continue;
          const v = wv[i];
          if (v === undefined || v === "") continue;
          if (v === "None" || v === "null") continue;
          if (inputs[name] !== undefined) continue; // 已有连线占位，不覆盖
          inputs[name] = v;
        }
        if (!aligned) {
          warnings.push(
            "节点 " + id + "（" + cls + "）控件数量与字段名未能完全对齐，只导入了前 " + take + " 个值；" +
              "若参数不对，请在 ComfyUI 里用「导出（API 格式）」重新导出该工作流。",
          );
        }
      }
    }

    const entry = { class_type: cls, inputs };
    const title = normalizeTitle(n.title);
    if (title) entry._meta = { title };
    graph[id] = entry;
  }

  const shape = validateApiGraphShape(graph);
  if (!shape.ok) {
    throw new Error("UI 转 API 后校验未通过：" + shape.errors.slice(0, 3).join("；"));
  }
  return { graph, format: "ui", warnings, droppedUiOnly };
}

/** API graph 结构自检（不查 class_type 是否存在于后端，那由 /object_info 校验负责） */
function validateApiGraphShape(graph) {
  const errors = [];
  if (!isPlainObject(graph)) return { ok: false, errors: ["图不是对象结构"] };
  const ids = new Set(Object.keys(graph));
  if (!ids.size) errors.push("图里没有任何节点。");
  for (const [id, node] of Object.entries(graph)) {
    if (!isPlainObject(node)) {
      errors.push("节点 " + id + " 不是对象。");
      continue;
    }
    if (typeof node.class_type !== "string" || !node.class_type.trim()) {
      errors.push("节点 " + id + " 缺少 class_type。");
    }
    if (!isPlainObject(node.inputs)) {
      errors.push("节点 " + id + "（" + node.class_type + "）缺少 inputs 对象。");
      continue;
    }
    for (const [field, v] of Object.entries(node.inputs)) {
      if (isLink(v)) {
        if (!ids.has(String(v[0]))) {
          errors.push("节点 " + id + "." + field + " 连向不存在的节点 " + v[0] + "。");
        }
      } else if (Array.isArray(v)) {
        /* 部分自定义节点吃数组常量（如列表），允许 */
      } else if (v !== null && typeof v !== "object") {
        /* string / number / boolean 常量，允许 */
      } else if (v === null) {
        /* 允许 null（部分节点用它表示「无」） */
      } else {
        errors.push("节点 " + id + "." + field + " 的值类型无法提交给 ComfyUI。");
      }
    }
  }
  return { ok: !errors.length, errors };
}

/**
 * 归一化任意导入内容 → API graph。
 * @param {object} parsed 已 JSON.parse 的内容
 * @returns {{graph:Object, format:"api"|"ui", warnings:string[]}}
 */
function normalizeGraph(parsed) {
  const det = detectFormat(parsed);
  if (det.format === "api") {
    const shape = validateApiGraphShape(det.graph);
    if (!shape.ok) throw new Error("API 工作流校验未通过：" + shape.errors.slice(0, 3).join("；"));
    return { graph: det.graph, format: "api", warnings: [] };
  }
  if (det.format === "ui") {
    const conv = uiToApiGraph(det.graph);
    return { graph: conv.graph, format: "ui", warnings: conv.warnings };
  }
  throw new Error(det.reason);
}

/** 解析导入文本（含体积与 JSON 合法性检查） */
function parseImportText(text) {
  const raw = String(text == null ? "" : text);
  if (!raw.trim()) throw new Error("内容为空：请粘贴 ComfyUI 导出的工作流 JSON。");
  if (Buffer.byteLength(raw, "utf8") > MAX_IMPORT_BYTES) {
    throw new Error("工作流文件过大（" + fmtBytes(Buffer.byteLength(raw, "utf8")) + "），上限 " + fmtBytes(MAX_IMPORT_BYTES) + "。");
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error("JSON 解析失败：" + String((e && e.message) || e));
  }
}

/* ───────────── ③ 参数候选扫描 ───────────── */

function valueKindOf(v) {
  if (typeof v === "number") return "number";
  if (typeof v === "string") return "string";
  if (typeof v === "boolean") return "boolean";
  if (Array.isArray(v)) return "link";
  if (v === null) return "null";
  return "object";
}

function ruleMatches(rule, classType, field, value) {
  if (rule.classRe && !rule.classRe.test(classType)) return false;
  if (rule.fieldRe && !rule.fieldRe.test(field)) return false;
  if (rule.valueKind) {
    const kind = valueKindOf(value);
    if (rule.valueKind === "string" && kind !== "string") return false;
    if (rule.valueKind === "number" && kind !== "number") return false;
  }
  return true;
}

/** 是否产物（Save*）节点 */
function isOutputClass(classType) {
  const cls = String(classType || "");
  return OUTPUT_CLASS_RE.test(cls) || OUTPUT_CLASS_HINT_RE.test(cls);
}

/** 是否视频类产物节点（默认输出优先） */
function isVideoOutputClass(classType) {
  return /(SaveVideo|SaveWebM|SaveMP4|VideoCombine|SaveAnimated|VHS_VideoCombine|SaveVideoFFmpeg|StoreVideo)/i.test(
    String(classType || ""),
  );
}

/**
 * 扫描 API graph，产出参数候选 + 建议映射 + 输出节点清单。
 * @returns {{nodeCount:number, classTypes:string[], candidates:Array, suggested:Array, seedFields:Array, outputs:Array}}
 */
function scanGraph(graph) {
  const g = isPlainObject(graph) ? graph : {};
  const ids = Object.keys(g).sort((a, b) => (Number(a) - Number(b)) || String(a).localeCompare(String(b)));
  const candidates = [];
  const outputs = [];
  const seedFields = [];
  const classTypeSet = new Set();

  for (const id of ids) {
    const node = g[id] || {};
    const cls = String(node.class_type || "");
    classTypeSet.add(cls);
    const title = normalizeTitle(node._meta && node._meta.title);
    const inputs = isPlainObject(node.inputs) ? node.inputs : {};
    for (const [field, value] of Object.entries(inputs)) {
      const kind = valueKindOf(value);
      if (SEED_FIELD_RE.test(field) && kind === "number") {
        seedFields.push({ nodeId: id, field, classType: cls });
      }
      if (kind !== "string" && kind !== "number" && kind !== "boolean") continue; // 连线 / 对象不可能是参数
      let rule = null;
      for (const r of SCAN_RULES) {
        if (ruleMatches(r, cls, field, value)) {
          rule = r;
          break;
        }
      }
      if (!rule) continue;
      candidates.push({
        nodeId: id,
        field,
        classType: cls,
        nodeTitle: title,
        type: rule.type,
        role: rule.role || "",
        label: rule.label || field,
        ruleId: rule.id,
        suggested: !!rule.suggested,
        currentValue: value,
        valueKind: kind,
      });
    }
    if (isOutputClass(cls)) {
      outputs.push({
        nodeId: id,
        classType: cls,
        nodeTitle: title,
        isVideo: isVideoOutputClass(cls),
        filenamePrefix: typeof inputs.filename_prefix === "string" ? inputs.filename_prefix : "",
      });
    }
  }

  const suggested = buildSuggestedParams(candidates);
  return {
    nodeCount: ids.length,
    classTypes: [...classTypeSet].sort(),
    candidates,
    suggested,
    seedFields,
    outputs,
  };
}

function paramKeyFor(c) {
  const base = (c.type + "_" + c.nodeId + "_" + c.field).replace(/[^A-Za-z0-9_.\-]/g, "_");
  return base;
}

function paramLabelFor(c, all) {
  const same = all.filter((x) => x.role === c.role && x.type === c.type);
  const label = c.nodeTitle ? c.nodeTitle : c.label;
  if (same.length > 1) return label + "（节点 " + c.nodeId + "）";
  return label;
}

/** 建议映射：只取 suggested 候选，key 唯一，defaultValue 取 JSON 现值 */
function buildSuggestedParams(candidates) {
  const used = new Set();
  const params = [];
  const seenRoleAtNode = new Set();
  for (const c of candidates) {
    if (!c.suggested) continue;
    /* 同一节点同一 role 只留一条（如多个 text 字段），避免面板塞满 */
    const roleTag = c.nodeId + "|" + c.role;
    if (c.role !== "prompt" && c.role !== "text" && seenRoleAtNode.has(roleTag)) continue;
    seenRoleAtNode.add(roleTag);
    let key = paramKeyFor(c);
    if (used.has(key)) key = key + "_" + stableHash(c.field, 4);
    used.add(key);
    params.push({
      key,
      label: paramLabelFor(c, candidates),
      type: c.type,
      role: c.role,
      source: { nodeId: String(c.nodeId), field: c.field },
      defaultValue: c.currentValue,
    });
  }
  return params;
}

/* ───────────── ④ 参数 schema 校验 ───────────── */

function coerceParamValue(type, value) {
  if (type === "number" || type === "seed") {
    const n = Number(value);
    if (!Number.isFinite(n)) return { ok: false, error: "不是有效数字" };
    return { ok: true, value: type === "seed" ? Math.round(n) : n };
  }
  if (type === "text") {
    if (value == null) return { ok: true, value: "" };
    if (typeof value === "object") return { ok: false, error: "文本参数不能是对象" };
    return { ok: true, value: String(value) };
  }
  if (type === "image" || type === "video" || type === "audio") {
    if (value && typeof value === "object") {
      const p = String(value.path || value.localPath || value.comfyName || value.name || "");
      if (!p) return { ok: false, error: "素材参数缺少路径" };
      return { ok: true, value: p };
    }
    return { ok: true, value: String(value == null ? "" : value) };
  }
  return { ok: false, error: "未知参数类型：" + type };
}

/**
 * 校验 / 归一化「提升为节点参数」表。
 * @param {Array} list 参数表 [{key,label,type,source:{nodeId,field},defaultValue}]
 * @param {Object} [graph] 给了就连节点与字段一起查（更严格）
 * @returns {{ok:boolean, params:Array, errors:string[]}}
 */
function normalizeParams(list, graph) {
  const errors = [];
  const params = [];
  const used = new Set();
  const arr = Array.isArray(list) ? list : [];
  if (!arr.length) return { ok: true, params: [], errors: [] };

  for (let i = 0; i < arr.length; i++) {
    const raw = arr[i];
    const at = "第 " + (i + 1) + " 条参数";
    if (!isPlainObject(raw)) {
      errors.push(at + "：不是对象。");
      continue;
    }
    const key = String(raw.key || "").trim();
    if (!key) errors.push(at + "：缺少 key。");
    else if (!/^[A-Za-z0-9_.\-]{1,64}$/.test(key)) errors.push(at + "：key 只能含字母数字与 _ . -（" + key + "）");
    else if (used.has(key)) errors.push(at + "：key 重复（" + key + "）");
    if (key) used.add(key);

    const type = String(raw.type || "").trim();
    if (!PARAM_TYPE_SET.has(type)) errors.push(at + "：type 必须是 " + PARAM_TYPES.join(" / ") + "（当前：" + (type || "空") + "）");

    const src = isPlainObject(raw.source) ? raw.source : {};
    const nodeId = String(src.nodeId || "").trim();
    const field = String(src.field || "").trim();
    if (!nodeId || !field) {
      errors.push(at + "：source 需要 {nodeId, field}。");
    } else if (graph) {
      const node = graph[nodeId];
      if (!node) errors.push(at + "：图里不存在节点 " + nodeId + "。");
      else if (!isPlainObject(node.inputs) || !(field in node.inputs)) {
        errors.push(at + "：节点 " + nodeId + " 没有字段 " + field + "。");
      }
    }

    const label = normalizeTitle(raw.label) || (nodeId && field ? nodeId + "." + field : key);
    let defaultValue = raw.defaultValue;
    if (graph && nodeId && field && graph[nodeId] && isPlainObject(graph[nodeId].inputs) && field in graph[nodeId].inputs) {
      const cur = graph[nodeId].inputs[field];
      if (!isLink(cur)) defaultValue = cur; // 现值优先（图就是默认值的真源）
    }
    if (type && PARAM_TYPE_SET.has(type) && defaultValue != null && defaultValue !== "") {
      const co = coerceParamValue(type, defaultValue);
      if (co.ok) defaultValue = co.value;
      else errors.push(at + "：默认值" + co.error);
    }
    const role = String(raw.role || "").trim();
    params.push({
      key: key || "p_" + i,
      label,
      type: type || "text",
      role,
      source: { nodeId, field },
      defaultValue: defaultValue == null ? "" : defaultValue,
    });
  }
  return { ok: !errors.length, params, errors };
}

/** 「提升为节点参数」表中某一项在当前图里的落点是否仍然有效 */
function paramSourceExists(graph, param) {
  const src = (param && param.source) || {};
  const node = graph && graph[String(src.nodeId || "")];
  return !!(node && isPlainObject(node.inputs) && String(src.field || "") in node.inputs);
}

/** 两条参数是否指向同一个落点（key 可能被用户改过，落点才是身份） */
function sameParamSource(a, b) {
  return (
    !!a && !!b && String(a.source && a.source.nodeId) === String(b.source && b.source.nodeId) && String(a.source && a.source.field) === String(b.source && b.source.field)
  );
}

/**
 * 把「用户已存的参数表」与「当前图的扫描结果」合并（节点面板打开时用）：
 *  · 保留用户改过的 label / type / key（并补 defaultValue = 图内现值）
 *  · 图上已消失的落点标 stale=true（界面提示，不直接删，避免误伤）
 *  · 新扫出的建议参数按落点去重后追加
 * @returns {{params:Array, added:number, stale:number}}
 */
function syncParamsWithScan(params, graph, scan) {
  const s = scan || scanGraph(graph);
  const kept = [];
  const seenSource = new Set();
  for (const p of normalizeParams(Array.isArray(params) ? params : [], null).params) {
    const q = { ...p };
    if (!paramSourceExists(graph, q)) q.stale = true;
    else {
      const cur = graph[String(q.source.nodeId)].inputs[q.source.field];
      if (!isLink(cur)) q.defaultValue = cur;
    }
    seenSource.add(String(q.source.nodeId) + "|" + String(q.source.field));
    kept.push(q);
  }
  let added = 0;
  for (const cand of s.candidates) {
    if (!cand.suggested) continue;
    const src = String(cand.nodeId) + "|" + String(cand.field);
    if (seenSource.has(src)) continue;
    seenSource.add(src);
    let key = paramKeyFor(cand);
    if (kept.some((k) => k.key === key)) key = key + "_" + stableHash(cand.field, 4);
    kept.push({
      key,
      label: paramLabelFor(cand, s.candidates),
      type: cand.type,
      role: cand.role,
      source: { nodeId: String(cand.nodeId), field: cand.field },
      defaultValue: cand.currentValue,
    });
    added++;
  }
  return { params: kept, added, stale: kept.filter((k) => k.stale).length };
}

/* ───────────── ⑤ 注入映射 applyMapping ───────────── */
function setGraphInput(graph, nodeId, field, value) {
  const node = graph[String(nodeId)];
  if (!node) return { ok: false, error: "节点不存在：" + nodeId };
  if (!isPlainObject(node.inputs)) node.inputs = {};
  node.inputs[field] = value;
  return { ok: true };
}

/** 文件类参数值 → 上传后的 ComfyUI 文件名（未上传则报错，避免把本地路径塞进图里） */
function resolveFileNameValue(param, value, uploaded) {
  const up = uploaded && isPlainObject(uploaded) ? uploaded[param.key] : null;
  if (typeof up === "string" && up.trim()) return { ok: true, value: up.trim() };
  if (value && typeof value === "object") {
    const comfy = String(value.comfyName || value.uploadedName || value.fileName || "");
    if (comfy) return { ok: true, value: comfy };
  }
  const s = String(value == null ? "" : value).trim();
  if (!s) return { ok: false, error: "未提供素材文件" };
  /* 已是 ComfyUI 侧文件名（无路径分隔符、无盘符）时直接沿用 */
  if (!/[\\/]/.test(s) && !/^[A-Za-z]:/.test(s)) return { ok: true, value: s };
  return { ok: false, error: "素材尚未上传到 ComfyUI：" + s };
}

/**
 * 把参数值注入 API graph（返回新图，不改原图）。
 * @param {Object} graph API 格式图
 * @param {Object} values 运行时值 { [param.key]: value }；缺省回落 param.defaultValue
 * @param {Array}  params 映射表（normalizeParams / scanGraph.suggested 的产物）
 * @param {number|null} [seed] 节点级单一种子：下发到所有 type=seed 的参数与图内被标 seed 的字段
 * @param {Object} [opts] { uploaded:{key:comfyName}, seedFields:[{nodeId,field}], clone:true }
 * @returns {{graph:Object, applied:Array, skipped:Array, errors:Array}}
 */
function applyMapping(graph, values, params, seed, opts) {
  const options = isPlainObject(opts) ? opts : {};
  const out = options.clone === false ? graph : cloneGraph(graph);
  const vals = isPlainObject(values) ? values : {};
  const list = Array.isArray(params) ? params : [];
  const applied = [];
  const skipped = [];
  const errors = [];

  for (const p of list) {
    if (!isPlainObject(p)) continue;
    const nodeId = String((p.source && p.source.nodeId) || "");
    const field = String((p.source && p.source.field) || "");
    if (!nodeId || !field) {
      errors.push({ key: String(p.key || ""), error: "映射缺少 source.nodeId / source.field" });
      continue;
    }
    if (!out[nodeId]) {
      errors.push({ key: p.key, nodeId, field, error: "节点不存在" });
      continue;
    }
    const has = Object.prototype.hasOwnProperty.call(vals, p.key);
    let raw = has ? vals[p.key] : p.defaultValue;
    const empty = raw == null || raw === "" || (typeof raw === "number" && !Number.isFinite(raw));
    /* 未给值 → 保留图里的原值（seed 例外：由下面的统一下发处理） */
    if (!has && empty) {
      skipped.push({ key: p.key, nodeId, field, reason: "no_value" });
      continue;
    }
    /* 素材类：明确给了空串 = 跳过（否则会把「无文件」当错误抛给用户） */
    if (has && empty && (p.type === "image" || p.type === "video" || p.type === "audio")) {
      skipped.push({ key: p.key, nodeId, field, reason: "empty_file" });
      continue;
    }
    if (p.type === "seed" && seed == null && empty) {
      skipped.push({ key: p.key, nodeId, field, reason: "no_value" });
      continue;
    }
    if (p.type === "seed" && seed != null) raw = seed;

    let value;
    if (p.type === "image" || p.type === "video" || p.type === "audio") {
      const r = resolveFileNameValue(p, raw, options.uploaded);
      if (!r.ok) {
        errors.push({ key: p.key, nodeId, field, error: r.error });
        continue;
      }
      value = r.value;
    } else {
      const co = coerceParamValue(p.type || "text", raw);
      if (!co.ok) {
        errors.push({ key: p.key, nodeId, field, error: co.error });
        continue;
      }
      value = co.value;
    }
    const cur = (out[nodeId].inputs || {})[field];
    if (isLink(cur)) {
      errors.push({ key: p.key, nodeId, field, error: "该字段是连线（上游节点的输出），不能当参数写值" });
      continue;
    }
    const set = setGraphInput(out, nodeId, field, value);
    if (!set.ok) errors.push({ key: p.key, nodeId, field, error: set.error });
    else applied.push({ key: p.key, nodeId, field, type: p.type, value });
  }

  /* 种子统一下发：所有被标 seed 的字段（含未被提升为参数的） */
  if (seed != null && Number.isFinite(Number(seed))) {
    const s = Math.round(Number(seed));
    const targets = Array.isArray(options.seedFields) && options.seedFields.length ? options.seedFields : collectSeedFields(out);
    for (const t of targets) {
      const node = out[String(t.nodeId)];
      if (!node || !isPlainObject(node.inputs)) continue;
      if (!(t.field in node.inputs)) continue;
      if (isLink(node.inputs[t.field])) continue;
      if (typeof node.inputs[t.field] !== "number") continue;
      node.inputs[t.field] = s;
      applied.push({ key: "#seed", nodeId: String(t.nodeId), field: t.field, type: "seed", value: s });
    }
  }

  return { graph: out, applied, skipped, errors };
}

/** 图内所有被标 seed 的数值字段（供 applyMapping 统一下发） */
function collectSeedFields(graph) {
  const out = [];
  for (const [id, node] of Object.entries(isPlainObject(graph) ? graph : {})) {
    const inputs = isPlainObject(node && node.inputs) ? node.inputs : {};
    for (const [field, v] of Object.entries(inputs)) {
      if (SEED_FIELD_RE.test(field) && typeof v === "number") out.push({ nodeId: String(id), field });
    }
  }
  return out;
}

/** 从映射表里挑出需要上传的素材参数（值是本机绝对路径的） */
function collectUploads(values, params) {
  const vals = isPlainObject(values) ? values : {};
  const list = Array.isArray(params) ? params : [];
  const out = [];
  for (const p of list) {
    if (!p || (p.type !== "image" && p.type !== "video" && p.type !== "audio")) continue;
    const raw = Object.prototype.hasOwnProperty.call(vals, p.key) ? vals[p.key] : p.defaultValue;
    if (raw == null || raw === "") continue;
    const s = typeof raw === "object" ? String(raw.path || raw.localPath || "") : String(raw);
    if (!s) continue;
    if (/[\\/]/.test(s) || /^[A-Za-z]:/.test(s)) out.push({ key: p.key, type: p.type, path: s });
  }
  return out;
}

/** 执行分支用：按映射挑出「输出节点」指定（若有）与默认候选。
 *  指定的节点若已不在图里（用户改过图），回落到默认选择并标 matched。 */
function pickOutputNode(scan, preferredNodeId) {
  const outputs = (scan && Array.isArray(scan.outputs) && scan.outputs) || [];
  const fallback = () => {
    const videos = outputs.filter((o) => o.isVideo);
    const pick = (videos.length ? videos : outputs).slice(-1)[0];
    return pick
      ? { nodeId: String(pick.nodeId), classType: pick.classType, matched: videos.length ? "last_video" : "last_output" }
      : { nodeId: "", classType: "", matched: "none" };
  };
  const pref = String(preferredNodeId || "").trim();
  if (pref) {
    const hit = outputs.find((o) => String(o.nodeId) === pref);
    if (hit) return { nodeId: hit.nodeId, classType: hit.classType, matched: "preferred" };
    const fb = fallback();
    return { ...fb, matched: outputs.length ? "preferred_missing" : "none" };
  }
  return fallback();
}

/* ───────────── ① 全局库读写 ───────────── */

function workflowsRootOf(dataDir) {
  const base = String(dataDir || "").trim();
  if (!base) return "";
  return path.join(base, WORKFLOWS_DIRNAME);
}

/** 纯 Node 环境（冒烟测试）下的数据目录回落；应用内由 main-h3.js 注入 dataDir */
function defaultDataDir() {
  if (process.env.MTNODE_DATA_DIR) return path.resolve(process.env.MTNODE_DATA_DIR);
  const home = process.env.USERPROFILE || process.env.HOME || require("os").homedir();
  const appData =
    process.platform === "win32"
      ? process.env.APPDATA || path.join(home, "AppData", "Roaming")
      : process.platform === "darwin"
        ? path.join(home, "Library", "Application Support")
        : path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"));
  return path.join(appData, "pipeline-console", "pipeline-console");
}

class H3WorkflowStore {
  /** @param {{dataDir?:string, root?:string}} [opts] */
  constructor(opts) {
    const o = isPlainObject(opts) ? opts : {};
    this.root = String(o.root || "").trim() || workflowsRootOf(o.dataDir || defaultDataDir());
    this.dirs = {
      index: path.join(this.root, REGISTRY_FILE),
      item: (id) => path.join(this.root, assertSafeId(id), WORKFLOW_FILE),
      itemDir: (id) => path.join(this.root, assertSafeId(id)),
    };
  }

  ensureRoot() {
    fs.mkdirSync(this.root, { recursive: true });
    return this.root;
  }

  /* —— registry —— */

  /** 读 registry；缺失或损坏时从目录树重建（自愈，不让库变砖） */
  readRegistry(options) {
    const opts = isPlainObject(options) ? options : {};
    const raw = readJsonSafe(this.dirs.index, null);
    const items = Array.isArray(raw && raw.items) ? raw.items.filter(isPlainObject) : null;
    if (raw && items) return { version: Number(raw.version) || REGISTRY_VERSION, items };
    if (opts.rebuild === false) return { version: REGISTRY_VERSION, items: [] };
    return this.rebuildRegistry();
  }

  writeRegistry(reg) {
    this.ensureRoot();
    writeJsonAtomic(this.dirs.index, {
      version: REGISTRY_VERSION,
      updatedAt: new Date().toISOString(),
      items: Array.isArray(reg && reg.items) ? reg.items : [],
    });
    return reg;
  }

  /** 扫描 <root>/<id>/workflow.json 重建 index.json */
  rebuildRegistry() {
    const items = [];
    let entries = [];
    try {
      entries = fs.readdirSync(this.root, { withFileTypes: true });
    } catch {
      entries = [];
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const rec = readJsonSafe(path.join(this.root, ent.name, WORKFLOW_FILE), null);
      if (!isPlainObject(rec) || !isPlainObject(rec.graph)) continue;
      items.push(summarizeRecord(rec));
    }
    items.sort((a, b) => String(a.title).localeCompare(String(b.title)));
    return { version: REGISTRY_VERSION, items };
  }

  list() {
    return this.readRegistry().items.map((it) => ({ ...it }));
  }

  /** 完整记录（含 API graph）。找不到 / id 非法返回 null（不抛异常，供 IPC 直接透出） */
  get(id) {
    let safe;
    try {
      safe = assertSafeId(id);
    } catch {
      return null;
    }
    const rec = readJsonSafe(this.dirs.item(safe), null);
    if (!isPlainObject(rec) || !isPlainObject(rec.graph)) return null;
    return rec;
  }

  /** 列表项 + 轻量扫描（节点数 / 输出节点），给 h3/ui 库卡片与节点面板下拉用 */
  listDetailed() {
    return this.list().map((it) => {
      const rec = this.get(it.id);
      if (!rec) return { ...it, missing: true };
      const outputs = collectOutputs(rec.graph);
      return { ...it, nodeCount: Object.keys(rec.graph || {}).length, outputs, missing: false };
    });
  }

  /** 扫描某条工作流（节点面板拿候选 + 建议映射用） */
  scan(id) {
    const rec = this.get(id);
    if (!rec) return null;
    const s = scanGraph(rec.graph);
    return {
      id: rec.id,
      title: rec.title,
      format: rec.format,
      validation: rec.validation || { status: "unchecked" },
      scan: s,
      suggestedParams: normalizeParams(s.suggested, rec.graph).params,
    };
  }

  /** 供「内置图另存为自定义工作流」：直接喂 API graph */
  createFromGraph(input) {
    return this._writeRecord(input);
  }

  /**
   * 导入工作流。
   * @param {{text?:string, filePath?:string, title?:string, overwrite?:boolean}} input
   * @returns {{ok:true, replaced:boolean, record:Object, summary:Object, scan:Object, warnings:string[]}
   *          | {ok:false, error:string}}
   */
  importWorkflow(input) {
    const o = isPlainObject(input) ? input : {};
    try {
      let rawText = typeof o.text === "string" ? o.text : "";
      let sourceName = normalizeTitle(o.sourceName || "");
      if (!rawText.trim() && o.filePath) {
        const fp = path.resolve(String(o.filePath));
        if (!fs.existsSync(fp)) throw new Error("文件不存在：" + fp);
        rawText = fs.readFileSync(fp, "utf8");
        sourceName = path.basename(fp);
      }
      const parsed = parseImportText(rawText);
      const norm = normalizeGraph(parsed);
      const title = normalizeTitle(o.title) || stripExt(sourceName) || "未命名工作流";
      const written = this._writeRecord({
        title,
        graph: norm.graph,
        format: norm.format,
        sourceName,
        overwrite: o.overwrite !== false,
        source: o.filePath ? "file" : "paste",
      });
      return { ...written, warnings: norm.warnings || [] };
    } catch (e) {
      return { ok: false, error: readableError(e) };
    }
  }

  /** @private 写盘（同名覆盖并提示；overwrite:false 时自动改名另存） */
  _writeRecord(input) {
    const o = isPlainObject(input) ? input : {};
    if (!isPlainObject(o.graph)) throw new Error("graph 必须是 API 格式对象。");
    const shape = validateApiGraphShape(o.graph);
    if (!shape.ok) throw new Error("工作流校验未通过：" + shape.errors.slice(0, 3).join("；"));
    const reg = this.readRegistry();
    const overwrite = o.overwrite !== false;
    let title = normalizeTitle(o.title) || "未命名工作流";
    const existing = reg.items.find((it) => titleKey(it.title) === titleKey(title));
    let id;
    if (existing && overwrite) {
      id = assertSafeId(existing.id);
    } else {
      if (existing) title = uniqueTitle(title, reg.items);
      id = newIdFor(title, reg.items);
    }
    const now = new Date().toISOString();
    const prev = this.get(id);
    /* 图变了 → 旧的 /object_info 校验结果作废（未校验），避免界面上挂着过期的「通过」徽标 */
    const graphChanged = !prev || JSON.stringify(prev.graph) !== JSON.stringify(o.graph);
    const scan = scanGraph(o.graph);
    const record = {
      id,
      title,
      format: o.format || "api",
      source: {
        kind: o.source || (o.filePath ? "file" : "api"),
        name: normalizeTitle(o.sourceName) || "",
        template: !!o.template,
        importedAt: prev && prev.source && prev.source.importedAt ? prev.source.importedAt : now,
        updatedAt: now,
      },
      createdAt: (prev && prev.createdAt) || (existing && existing.createdAt) || now,
      updatedAt: now,
      validation: graphChanged || !isPlainObject(prev && prev.validation)
        ? { status: "unchecked", checkedAt: "" }
        : prev.validation,
      graph: o.graph,
      notes: normalizeTitle(o.notes) || (prev && prev.notes) || "",
    };
    this.ensureRoot();
    writeJsonAtomic(this.dirs.item(id), record);
    const summary = summarizeRecord(record);
    const items = reg.items.filter((it) => String(it.id) !== id).concat([summary]);
    items.sort((a, b) => String(a.title).localeCompare(String(b.title), "zh-Hans-CN"));
    this.writeRegistry({ items });
    return {
      ok: true,
      replaced: !!existing && overwrite,
      record,
      summary,
      scan,
      suggestedParams: normalizeParams(scan.suggested, o.graph).params,
    };
  }

  remove(id) {
    let safe;
    try {
      safe = assertSafeId(id);
    } catch (e) {
      return { ok: false, error: readableError(e) };
    }
    const reg = this.readRegistry();
    const hit = reg.items.find((it) => String(it.id) === safe);
    const title = hit ? hit.title : "";
    try {
      fs.rmSync(this.dirs.itemDir(safe), { recursive: true, force: true });
    } catch (e) {
      return { ok: false, error: readableError(e) };
    }
    this.writeRegistry({ items: reg.items.filter((it) => String(it.id) !== safe) });
    return { ok: true, id: safe, title };
  }

  rename(id, nextTitle) {
    const safe = assertSafeIdSafeArg(id);
    if (!safe.ok) return { ok: false, error: safe.error };
    const rec = this.get(safe.id);
    if (!rec) return { ok: false, error: "工作流不存在：" + safe.id };
    const title = normalizeTitle(nextTitle);
    if (!title) return { ok: false, error: "名称不能为空。" };
    const reg = this.readRegistry();
    const clash = reg.items.find((it) => String(it.id) !== safe.id && titleKey(it.title) === titleKey(title));
    if (clash) return { ok: false, error: "已存在同名工作流：" + clash.title };
    rec.title = title;
    rec.updatedAt = new Date().toISOString();
    writeJsonAtomic(this.dirs.item(safe.id), rec);
    const items = reg.items.map((it) => (String(it.id) === safe.id ? summarizeRecord(rec) : it));
    items.sort((a, b) => String(a.title).localeCompare(String(b.title), "zh-Hans-CN"));
    this.writeRegistry({ items });
    return { ok: true, id: safe.id, title, record: rec };
  }

  /** 写回 /object_info 校验结果（警告不阻断，由调用方决定文案） */
  setValidation(id, validation) {
    const safeArg = assertSafeIdSafeArg(id);
    if (!safeArg.ok) return { ok: false, error: safeArg.error };
    const safe = safeArg.id;
    const rec = this.get(safe);
    if (!rec) return { ok: false, error: "工作流不存在：" + safe };
    const v = isPlainObject(validation) ? validation : {};
    rec.validation = {
      status: v.status === "ok" || v.status === "missing_nodes" || v.status === "skipped" || v.status === "error" ? v.status : "unchecked",
      checkedAt: v.checkedAt || (v.status ? new Date().toISOString() : ""),
      missing: Array.isArray(v.missing) ? v.missing.filter(isPlainObject) : [],
      unknownClasses: Array.isArray(v.unknownClasses) ? v.unknownClasses.map(String) : [],
      nodeCount: Number(v.nodeCount) || Object.keys(rec.graph || {}).length,
      error: normalizeTitle(v.error),
    };
    rec.updatedAt = new Date().toISOString();
    writeJsonAtomic(this.dirs.item(safe), rec);
    const reg = this.readRegistry();
    this.writeRegistry({ items: reg.items.map((it) => (String(it.id) === safe ? summarizeRecord(rec) : it)) });
    return { ok: true, validation: rec.validation };
  }

  /** 导出为 JSON 文本（UI 可直接 Blob 下载；也可写盘） */
  exportText(id) {
    const safeArg = assertSafeIdSafeArg(id);
    if (!safeArg.ok) return { ok: false, error: safeArg.error };
    const rec = this.get(safeArg.id);
    if (!rec) return { ok: false, error: "工作流不存在：" + safeArg.id };
    return { ok: true, filename: sanitizeForFs(rec.title, rec.id) + ".json", text: JSON.stringify(rec.graph, null, 2) };
  }

  exportTo(id, destPath) {
    const r = this.exportText(id);
    if (!r.ok) return r;
    if (!normalizeTitle(destPath)) return { ok: false, error: "导出路径为空。" };
    try {
      const dest = path.resolve(String(destPath));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, r.text, "utf8");
      return { ok: true, path: dest, filename: path.basename(dest) };
    } catch (e) {
      return { ok: false, error: readableError(e) };
    }
  }

  /** 克隆一条（「从内置模板另存为」用） */
  duplicate(id, nextTitle) {
    const safeArg = assertSafeIdSafeArg(id);
    if (!safeArg.ok) return { ok: false, error: safeArg.error };
    const rec = this.get(safeArg.id);
    if (!rec) return { ok: false, error: "工作流不存在：" + safeArg.id };
    const title = normalizeTitle(nextTitle) || rec.title + " 副本";
    try {
      const r = this._writeRecord({
        title,
        graph: rec.graph,
        format: rec.format,
        sourceName: rec.source && rec.source.name,
        source: "duplicate",
        overwrite: false,
      });
      return { ...r, warnings: [] };
    } catch (e) {
      return { ok: false, error: readableError(e) };
    }
  }

  /** 库统计（h3/ui 卡片头用） */
  stats() {
    const items = this.list();
    const validated = items.filter((i) => i.validation && i.validation.status === "ok").length;
    const warn = items.filter((i) => i.validation && i.validation.status === "missing_nodes").length;
    return { root: this.root, count: items.length, validated, warn, unchecked: items.length - validated - warn };
  }
}

function uniqueTitle(title, items) {
  const base = normalizeTitle(title) || "未命名工作流";
  const taken = new Set((items || []).map((i) => titleKey(i.title)));
  if (!taken.has(titleKey(base))) return base;
  for (let i = 2; i < 999; i++) {
    const cand = base + " (" + i + ")";
    if (!taken.has(titleKey(cand))) return cand;
  }
  return base + " " + stableHash(String(Date.now()), 6);
}

function newIdFor(title, items) {
  const base = sanitizeForFs(title, "wf") + "-" + stableHash(titleKey(title), 6);
  const taken = new Set((items || []).map((i) => String(i.id)));
  if (!taken.has(base)) return base;
  for (let i = 2; i < 999; i++) {
    const cand = base + "-" + i;
    if (!taken.has(cand)) return cand;
  }
  return base + "-" + Date.now();
}

function stripExt(name) {
  return normalizeTitle(name).replace(/\.json$/i, "");
}

function collectOutputs(graph) {
  return scanGraph(graph).outputs;
}

/** registry 里的轻量条目（不含 graph） */
function summarizeRecord(rec) {
  const g = isPlainObject(rec.graph) ? rec.graph : {};
  const ids = Object.keys(g);
  const classTypes = new Set(ids.map((k) => String(g[k] && g[k].class_type)));
  const outputs = ids
    .filter((k) => isOutputClass(g[k] && g[k].class_type))
    .map((k) => ({ nodeId: String(k), classType: String(g[k].class_type) }));
  return {
    id: String(rec.id),
    title: normalizeTitle(rec.title),
    format: rec.format || "api",
    nodeCount: ids.length,
    classCount: classTypes.size,
    outputs,
    validation: isPlainObject(rec.validation) ? rec.validation : { status: "unchecked", checkedAt: "" },
    source: isPlainObject(rec.source) ? rec.source : {},
    createdAt: rec.createdAt || "",
    updatedAt: rec.updatedAt || "",
  };
}

function readableError(e) {
  const msg = String((e && e.message) || e || "unknown_error");
  return msg;
}

let _sharedStore = null;
/** 应用内共享实例（main-h3.js 注入 dataDir 后使用） */
function sharedStore(dataDir) {
  if (dataDir) _sharedStore = new H3WorkflowStore({ dataDir });
  if (!_sharedStore) _sharedStore = new H3WorkflowStore({});
  return _sharedStore;
}

module.exports = {
  /* 常量 */
  WORKFLOWS_DIRNAME,
  REGISTRY_FILE,
  WORKFLOW_FILE,
  PARAM_TYPES,
  SEED_FIELD_RE,
  OUTPUT_CLASS_RE,
  UI_ONLY_WIDGETS,
  MAX_IMPORT_BYTES,
  /* 路径 */
  workflowsRootOf,
  defaultDataDir,
  sharedStore,
  H3WorkflowStore,
  /* 格式判定与转换 */
  looksLikeApiGraph,
  looksLikeUiGraph,
  detectFormat,
  uiToApiGraph,
  normalizeGraph,
  validateApiGraphShape,
  parseImportText,
  /* 扫描与 schema */
  scanGraph,
  buildSuggestedParams,
  normalizeParams,
  syncParamsWithScan,
  paramSourceExists,
  sameParamSource,
  coerceParamValue,
  collectSeedFields,
  collectUploads,
  collectOutputs,
  isOutputClass,
  isVideoOutputClass,
  /* 注入 */
  applyMapping,
  pickOutputNode,
  /* 表与规则（供 UI / 测试引用） */
  SCAN_RULES,
  LEGACY_WIDGET_ORDER,
  CONSTANT_CLASSES,
  /* 杂项 */
  isLink,
  isPlainObject,
  normalizeTitle,
  summarizeRecord,
  fmtBytes,
  sanitizeForFs,
  stableHash,
};
