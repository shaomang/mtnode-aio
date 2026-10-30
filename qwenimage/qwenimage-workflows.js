"use strict";
/* ============ Qwen Image 2.1 的 ComfyUI 图（API 格式）============
 *
 * 节点类型与端口取自官方模板（Comfy-Org/workflow_templates ·
 * image_qwen_image_2_1_t2i.json / _turbo_t2i.json / _turbo_image_edit.json）：
 *   UNETLoader → QwenImage21Cache → KSampler（INT8：40 步 / cfg 1 / euler / simple）
 *                                 └→ SamplerCustomAdvanced（Turbo INT8：官方 8 步 sigma 表）
 *   CLIPLoader(type="qwen_image") → TextEncodeQwenImage21（参考图直接喂进编码器）
 *   VAELoader(qwen_image_2.1_vae) → VAEDecode → SaveImage
 *
 * 两个量化档共用同一份文本编码器与 VAE，只有扩散模型文件不同：
 *   int8  → qwen_image_2.1_int8_convrot.safetensors      （40 步，官方模板注释约 40-50 步 / euler）
 *   turbo → qwen_image_2.1_turbo_int8_convrot.safetensors（Turbo 蒸餾，官方 8 步 sigma 表）
 *
 * 这里只产图，不碰文件系统；上传参考图 / 取回产物由宿主 main-qwenimage.js 负责。
 */

const VARIANTS = {
  int8: {
    label: "INT8",
    unet: "qwen_image_2.1_int8_convrot.safetensors",
    steps: 40,
    cfg: 1,
  },
  turbo: {
    label: "Turbo INT8",
    unet: "qwen_image_2.1_turbo_int8_convrot.safetensors",
    steps: 8,
    cfg: 1,
  },
};

/* 两个量化档共用的一套编码器 / VAE（官方 repack 只有一份） */
const CLIP_NAME = "qwen3vl_8b_int8_convrot.safetensors";
const VAE_NAME = "qwen_image_2.1_vae_bf16.safetensors";
/* Turbo 官方 8 步调度（image_qwen_image_2_1_turbo_t2i.json · ManualSigmas） */
const TURBO_SIGMAS = "1.0, 0.978453, 0.95418, 0.926626, 0.89508, 0.845148, 0.704534, 0.414568, 0";

const MAX_REFS = 10;
/* TextEncodeQwenImage21 的 images 自动增长口最多 16 个（官方模板同口径） */
const MAX_ENCODER_REFS = 16;
/* 参考图送进编码器前统一缩到约 1024×1024（官方模板的 resolution 口径） */
const REF_RESOLUTION = 1024;

function variantOf(v) {
  return VARIANTS[v] ? v : "int8";
}

function unetName(v) {
  return VARIANTS[variantOf(v)].unet;
}

function clipName() {
  return CLIP_NAME;
}

function vaeName() {
  return VAE_NAME;
}

function defaultSteps(v) {
  return VARIANTS[variantOf(v)].steps;
}

/* 官方模板明确 prefer multiples of 32：宽高按 32 对齐，区间 256–3072。
   上限 3072 覆盖 2K 档最大长边（2752）与 2:3 的 2528，旧 2048 会把它们截断。 */
function align32(v) {
  const n = Math.max(256, Math.min(3072, Math.round(Number(v) || 1024)));
  return Math.max(256, Math.round(n / 32) * 32);
}

function loaderNodes(variant) {
  return {
    1: {
      class_type: "UNETLoader",
      inputs: { unet_name: unetName(variant), weight_dtype: "default" },
    },
    2: {
      class_type: "CLIPLoader",
      inputs: { clip_name: CLIP_NAME, type: "qwen_image", device: "default" },
    },
    3: { class_type: "VAELoader", inputs: { vae_name: VAE_NAME } },
  };
}

/**
 * 拼一张图。
 * @param {object} o
 *   prompt / negative / width / height / steps / cfg / seed / denoise
 *   variant: "int8" | "turbo"
 *   refs: string[]  —— ComfyUI input 目录里的文件名（已上传）
 *   mask: string    —— ComfyUI input 目录里的蒙版文件名（仅 inpaint 用；alpha 通道 = 可编辑区域）
 *   filenamePrefix: string
 * @returns {object} ComfyUI /prompt 的 prompt 字段
 */
function buildGraph(o) {
  const opt = o || {};
  const variant = variantOf(opt.variant);
  const width = align32(opt.width);
  const height = align32(opt.height);
  const steps = Math.max(1, Math.min(60, Math.round(Number(opt.steps) || defaultSteps(variant))));
  const cfg = Math.max(0, Math.min(10, Number(opt.cfg) || VARIANTS[variant].cfg));
  const seed = Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.round(Number(opt.seed) || 0)));
  const denoise = Math.max(0.05, Math.min(1, Number(opt.denoise) || 1));
  const refs = (Array.isArray(opt.refs) ? opt.refs : []).filter(Boolean).slice(0, MAX_REFS);
  const mask = String(opt.mask || "");
  const prefix = String(opt.filenamePrefix || "qwen_image_21");

  const g = Object.assign({}, loaderNodes(variant));

  /* 参考图：LoadImage 逐个接进 TextEncodeQwenImage21 的自动增长输入。
   * 键名用**点号**（images.image_1 属于 images 前缀，运行时按 autogrow 折回 dict）。 */
  const refInputs = {};
  refs.slice(0, MAX_ENCODER_REFS).forEach((name, i) => {
    const id = String(20 + i);
    g[id] = { class_type: "LoadImage", inputs: { image: name, upload: "image" } };
    refInputs["images.image_" + (i + 1)] = [id, 0];
  });

  g[4] = {
    class_type: "TextEncodeQwenImage21",
    inputs: Object.assign(
      {
        clip: ["2", 0],
        prompt: String(opt.prompt || ""),
        negative_prompt: String(opt.negative || ""),
        vae: ["3", 0],
        resolution: REF_RESOLUTION,
      },
      refInputs,
    ),
  };
  /* KV 前缀缓存：编辑时把参考图的前缀缓存下来，显存吃紧时自动降到内存 */
  g[5] = {
    class_type: "QwenImage21Cache",
    inputs: { model: ["1", 0], device: "auto", dtype: "default" },
  };

  let latentRef;
  if (mask && refs.length) {
    /* 蒙版局部重绘：底图 VAEEncode → SetLatentNoiseMask → 采样（只重绘蒙版内） */
    g[40] = { class_type: "LoadImage", inputs: { image: refs[0], upload: "image" } };
    g[41] = { class_type: "LoadImageMask", inputs: { image: mask, channel: "alpha" } };
    g[42] = { class_type: "VAEEncode", inputs: { pixels: ["40", 0], vae: ["3", 0] } };
    g[43] = { class_type: "SetLatentNoiseMask", inputs: { samples: ["42", 0], mask: ["41", 0] } };
    latentRef = ["43", 0];
  } else {
    g[6] = { class_type: "EmptyLatentImage", inputs: { width, height, batch_size: 1 } };
    latentRef = ["6", 0];
  }

  /* Turbo 档走官方 SamplerCustomAdvanced + 固定 8 步 sigma 表；
   * 蒙版重绘要 denoise 收着用，那种情况回落到 KSampler。 */
  const useCustom = variant === "turbo" && !(mask && refs.length);
  if (useCustom) {
    g[50] = {
      class_type: "RandomNoise",
      inputs: { noise_seed: seed, control_after_generate: "fixed" },
    };
    g[51] = {
      class_type: "CFGGuider",
      inputs: {
        model: ["5", 0],
        positive: ["4", 0],
        negative: ["4", 1],
        cfg,
      },
    };
    g[52] = { class_type: "KSamplerSelect", inputs: { sampler_name: "euler" } };
    g[53] = { class_type: "ManualSigmas", inputs: { sigmas: TURBO_SIGMAS } };
    g[54] = {
      class_type: "SamplerCustomAdvanced",
      inputs: {
        noise: ["50", 0],
        guider: ["51", 0],
        sampler: ["52", 0],
        sigmas: ["53", 0],
        latent_image: latentRef,
      },
    };
    g[8] = { class_type: "VAEDecode", inputs: { samples: ["54", 0], vae: ["3", 0] } };
  } else {
    g[7] = {
      class_type: "KSampler",
      inputs: {
        model: ["5", 0],
        seed,
        steps,
        cfg,
        sampler_name: "euler",
        scheduler: "simple",
        denoise,
        positive: ["4", 0],
        negative: ["4", 1],
        latent_image: latentRef,
      },
    };
    g[8] = { class_type: "VAEDecode", inputs: { samples: ["7", 0], vae: ["3", 0] } };
  }
  g[9] = { class_type: "SaveImage", inputs: { images: ["8", 0], filename_prefix: prefix } };
  return g;
}

module.exports = {
  VARIANTS,
  TURBO_SIGMAS,
  MAX_REFS,
  MAX_ENCODER_REFS,
  REF_RESOLUTION,
  variantOf,
  unetName,
  clipName,
  vaeName,
  defaultSteps,
  align32,
  buildGraph,
};
