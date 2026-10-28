"use strict";
/* ============ FLUX 3 Image Klein 的 ComfyUI 图（API 格式）============
 *
 * 节点类型与端口取自官方模板（Comfy-Org/workflow_templates · image_flux3_klein_t2i.json
 * 与官方 repack 仓库 workflows/flux3_klein_int8_i2i.json）：
 *   UNETLoader → （编辑图再加 ModelSamplingFlux）→ KSampler → VAEDecode → SaveImage
 *   CLIPLoader(type="flux3") → CLIPTextEncode ×2
 *   VAELoader(flux2-vae) → ReferenceMultiLatent（参考图，最多 5 张/图批次）
 * 蒸馏版采样口径照官方：16 步 / CFG 1.0 / euler / simple / denoise 1。
 *
 * 这里只产图，不碰文件系统；上传参考图 / 取回产物由宿主 main-flux3klein.js 负责。
 */

const PRECISIONS = {
  int8: {
    label: "INT8",
    unet: "flux3-image-klein-int8-convrot.safetensors",
    clip: "qwen3vl_4b_int8_convrot.safetensors",
    vae: "flux2-vae.safetensors",
  },
  bf16: {
    label: "BF16",
    unet: "flux3-image-klein-bf16.safetensors",
    clip: "qwen3vl_4b_bf16.safetensors",
    vae: "flux2-vae.safetensors",
  },
};

const MAX_REFS = 10;
/* 参考图进 ReferenceMultiLatent 的图批次上限（官方模板同口径：一次最多 5 张） */
const REF_BATCH = 5;

function precisionOf(p) {
  return PRECISIONS[p] ? p : "int8";
}

function unetName(p) {
  return PRECISIONS[precisionOf(p)].unet;
}

function clipName(p) {
  return PRECISIONS[precisionOf(p)].clip;
}

function vaeName(p) {
  return PRECISIONS[precisionOf(p)].vae;
}

function loaderNodes(precision) {
  return {
    1: { class_type: "UNETLoader", inputs: { unet_name: unetName(precision), weight_dtype: "default" } },
    2: {
      class_type: "CLIPLoader",
      inputs: { clip_name: clipName(precision), type: "flux3", device: "default" },
    },
    3: { class_type: "VAELoader", inputs: { vae_name: vaeName(precision) } },
  };
}

/* 蒸馏版对分辨率很敏感：宽高按 16 对齐，长边上限由调用方收紧 */
function align16(v) {
  const n = Math.max(256, Math.min(2048, Math.round(Number(v) || 1024)));
  return Math.max(256, Math.round(n / 16) * 16);
}

/**
 * 拼一张图。
 * @param {object} o
 *   prompt / negative / width / height / steps / cfg / seed / denoise
 *   precision: "int8" | "bf16"
 *   refs: string[]  —— ComfyUI input 目录里的文件名（已上传）
 *   mask: string    —— ComfyUI input 目录里的蒙版文件名（仅 inpaint 用；alpha 通道 = 可编辑区域）
 *   filenamePrefix: string
 * @returns {object} ComfyUI /prompt 的 prompt 字段
 */
function buildGraph(o) {
  const opt = o || {};
  const width = align16(opt.width);
  const height = align16(opt.height);
  const steps = Math.max(1, Math.min(60, Math.round(Number(opt.steps) || 16)));
  const cfg = Math.max(0, Math.min(10, Number(opt.cfg) || 1));
  const seed = Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.round(Number(opt.seed) || 0)));
  const denoise = Math.max(0.05, Math.min(1, Number(opt.denoise) || 1));
  const refs = (Array.isArray(opt.refs) ? opt.refs : []).filter(Boolean).slice(0, MAX_REFS);
  const mask = String(opt.mask || "");
  const prefix = String(opt.filenamePrefix || "flux3_klein");

  const g = Object.assign({}, loaderNodes(opt.precision));

  g[4] = {
    class_type: "CLIPTextEncode",
    inputs: { clip: ["2", 0], text: String(opt.prompt || "") },
  };
  g[5] = {
    class_type: "CLIPTextEncode",
    inputs: { clip: ["2", 0], text: String(opt.negative || "") },
  };

  /* 参考图批次：LoadImage 逐个接进 ReferenceMultiLatent 的自动增长输入。
   * 键名用**点号**（imageN 属于 images 前缀，运行时按 dynamic_paths 折叠成 images={"image0":…}）；
   * 直接给 image0 会被当成未知关键字参数。 */
  const refInputs = {};
  refs.forEach((name, i) => {
    const id = String(20 + i);
    g[id] = { class_type: "LoadImage", inputs: { image: name, upload: "image" } };
    refInputs["images.image" + i] = [id, 0];
  });

  let posRef = ["4", 0];
  let negRef = ["5", 0];
  let latentRef;

  if (mask && refs.length) {
    /* 蒙版局部重绘：参考图（若有）+ VAEEncode 原图 → SetLatentNoiseMask → 采样 */
    g[40] = { class_type: "LoadImage", inputs: { image: refs[0], upload: "image" } };
    g[41] = { class_type: "LoadImageMask", inputs: { image: mask, channel: "alpha" } };
    g[42] = { class_type: "VAEEncode", inputs: { pixels: ["40", 0], vae: ["3", 0] } };
    g[43] = { class_type: "SetLatentNoiseMask", inputs: { samples: ["42", 0], mask: ["41", 0] } };
    latentRef = ["43", 0];
  } else if (refs.length) {
    /* 参考图编辑：ReferenceMultiLatent 只提供正负条件；latent 必须单独用目标宽高建。
     * 它的 empty_latent 是第一张参考图缩到 ~1MP 后乘 0（官方模板注释「output latent takes
     * its size」），直接拿来采样会让 16:9 跟着竖版参考图变成 9:16。 */
    g[30] = {
      class_type: "ReferenceMultiLatent",
      inputs: Object.assign(
        {
          positive: ["4", 0],
          negative: ["5", 0],
          vae: ["3", 0],
          /* resolution 是动态下拉（io.DynamicCombo）：值是选项 key，选中项自带的参数按
             「父键.子键」点号形式平铺成顶层输入（resolution.megapixels），运行时再折回 dict。 */
          resolution: "resize",
          "resolution.megapixels": Math.round(((width * height) / (1024 * 1024)) * 100) / 100,
        },
        refInputs,
      ),
    };
    posRef = ["30", 0];
    negRef = ["30", 1];
    g[31] = {
      class_type: "EmptyFlux2LatentImage",
      inputs: { width, height, batch_size: 1 },
    };
    latentRef = ["31", 0];
    /* 官方的 shift 口径：log(16) = 2.77259（编辑图用 ModelSamplingFlux 包一层） */
    g[32] = {
      class_type: "ModelSamplingFlux",
      inputs: {
        model: ["1", 0],
        max_shift: 2.77259,
        base_shift: 2.77259,
        width,
        height,
      },
    };
  } else {
    g[6] = {
      class_type: "EmptyFlux2LatentImage",
      inputs: { width, height, batch_size: 1 },
    };
    latentRef = ["6", 0];
  }

  g[7] = {
    class_type: "KSampler",
    inputs: {
      model: refs.length && !mask ? ["32", 0] : ["1", 0],
      seed,
      steps,
      cfg,
      sampler_name: "euler",
      scheduler: "simple",
      denoise,
      positive: posRef,
      negative: negRef,
      latent_image: latentRef,
    },
  };
  g[8] = { class_type: "VAEDecode", inputs: { samples: ["7", 0], vae: ["3", 0] } };
  g[9] = { class_type: "SaveImage", inputs: { images: ["8", 0], filename_prefix: prefix } };

  return g;
}

module.exports = {
  PRECISIONS,
  MAX_REFS,
  REF_BATCH,
  precisionOf,
  unetName,
  clipName,
  vaeName,
  align16,
  buildGraph,
};
