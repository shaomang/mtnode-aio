"use strict";
/**
 * InfiniteTalk（Wan2.1 I2V 14B + InfiniteTalk patch）ComfyUI 工作流构造器。
 *
 * 真源：ComfyUI **原生** `WanInfiniteTalkToVideo`（comfy_extras/nodes_wan.py）与官方示例工作流
 * `video_wan2_1_infinitetalk`。本插件不装任何第三方自定义节点，只把参数拼成 API 格式的
 * prompt（节点 id → class_type → inputs），提交 /prompt 的活在主进程。
 *
 * 两条输入路径：
 *   · I2V —— 人物图当 start_image；续写段用上一段的末帧（start_image）+ 末 N 帧（previous_frames）。
 *   · V2V —— 源视频按时间窗切成小 mp4，LoadVideo→GetVideoComponents 拿到帧序列当 start_image，
 *     保留原镜头与身体动态。
 *
 * 输出：VAEDecode → CreateVideo(fps 25) → SaveVideo(mp4)。音频不在这里合，宿主最后把原音轨
 * 封回去（这样长音频分块拼接只需要一次封装）。
 */

const RESOLUTIONS = {
  /* 官方两档；宽高按 16 对齐（832x480 / 1280x768） */
  "480p": { width: 832, height: 480 },
  "720p": { width: 1280, height: 768 },
};
const RESOLUTION_KEYS = Object.keys(RESOLUTIONS);

const DEFAULT_STEPS = 4; /* lightx2v 4 步蒸馏 */
const DEFAULT_FPS = 25;
/** 单块帧数：官方示例的 81 帧（≈3.24s），必须满足 4n+1。 */
const DEFAULT_LENGTH = 81;
const MOTION_FRAME_COUNT = 9; /* previous_frames 取上一段末 9 帧（官方默认） */

const DEFAULT_PROMPT =
  "A person is talking naturally to the camera, accurate lip sync, natural facial expression and head motion, stable identity and background, cinematic lighting.";
const DEFAULT_NEGATIVE =
  "blurry, low quality, distorted face, deformed mouth, extra limbs, flicker, watermark, text, oversaturated.";

const WEIGHTS = {
  unet: "wan2.1-i2v-14b-480p-fp8_e4m3fn_scaled.safetensors",
  patch: "wan2.1_infiniteTalk_single_fp16.safetensors",
  clip: "umt5_xxl_fp8_e4m3fn_scaled.safetensors",
  vae: "Wan2_1_VAE_bf16.safetensors",
  audioEncoder: "wav2vec2-chinese-base_fp16.safetensors",
  lora: "lightx2v_I2V_14B_480p_cfg_step_distill_rank64_bf16.safetensors",
  clipVision: "clip_vision_h.safetensors",
};

function normLength(n) {
  const v = Math.max(9, Math.round(Number(n) || DEFAULT_LENGTH));
  /* Wan 的时序 VAE 要 4n+1 帧 */
  return 4 * Math.floor((v - 1) / 4) + 1;
}

/**
 * @param {object} o
 *  mode: "i2v" | "v2v"
 *  imageName: I2V 首帧 / 续写末帧（/upload 返回的文件名）
 *  videoName: V2V 窗口 mp4（/upload 返回的文件名）
 *  prevFramesName: 续写段上一段末 N 帧的小 mp4（可选）
 *  audioName, width, height, length, steps, seed, prompt, negative, prefix
 * @returns {{prompt:object,width:number,height:number,fps:number,length:number,steps:number,seed:number,prefix:string}}
 */
function buildPrompt(o) {
  const opt = o || {};
  const mode = opt.mode === "v2v" ? "v2v" : "i2v";
  const width = Number(opt.width) || RESOLUTIONS["480p"].width;
  const height = Number(opt.height) || RESOLUTIONS["480p"].height;
  const length = normLength(opt.length);
  const steps = Math.max(1, Math.min(40, Number(opt.steps) || DEFAULT_STEPS));
  const seed = Number(opt.seed) || 42;
  const prefix = String(opt.prefix || "infinitetalk/chunk");
  const positive = String(opt.prompt || "").trim() || DEFAULT_PROMPT;
  const negative = String(opt.negative || "").trim() || DEFAULT_NEGATIVE;

  const prompt = {
    "1": {
      class_type: "UNETLoader",
      inputs: { unet_name: WEIGHTS.unet, weight_dtype: "default" },
    },
    "2": {
      class_type: "LoraLoaderModelOnly",
      inputs: { model: ["1", 0], lora_name: WEIGHTS.lora, strength_model: 1.0 },
    },
    "3": {
      class_type: "ModelPatchLoader",
      inputs: { name: WEIGHTS.patch },
    },
    "4": {
      class_type: "CLIPLoader",
      inputs: { clip_name: WEIGHTS.clip, type: "wan" },
    },
    "5": {
      class_type: "CLIPTextEncode",
      inputs: { text: positive, clip: ["4", 0] },
    },
    "6": {
      class_type: "CLIPTextEncode",
      inputs: { text: negative, clip: ["4", 0] },
    },
    "7": {
      class_type: "VAELoader",
      inputs: { vae_name: WEIGHTS.vae },
    },
    "8": {
      class_type: "AudioEncoderLoader",
      inputs: { audio_encoder_name: WEIGHTS.audioEncoder },
    },
    "9": {
      class_type: "LoadAudio",
      inputs: { audio: opt.audioName },
    },
    "10": {
      class_type: "AudioEncoderEncode",
      inputs: { audio_encoder: ["8", 0], audio: ["9", 0] },
    },
    "11": {
      class_type: "WanInfiniteTalkToVideo",
      inputs: {
        mode: "single_speaker",
        model: ["2", 0],
        model_patch: ["3", 0],
        positive: ["5", 0],
        negative: ["6", 0],
        vae: ["7", 0],
        width,
        height,
        length,
        audio_encoder_output_1: ["10", 0],
        motion_frame_count: MOTION_FRAME_COUNT,
        audio_scale: 1.0,
      },
    },
    "12": {
      class_type: "KSampler",
      inputs: {
        model: ["11", 0],
        positive: ["11", 1],
        negative: ["11", 2],
        latent_image: ["11", 3],
        seed,
        steps,
        cfg: 1.0,
        sampler_name: "euler",
        scheduler: "simple",
        denoise: 1.0,
      },
    },
    "13": {
      class_type: "VAEDecode",
      inputs: { samples: ["12", 0], vae: ["7", 0] },
    },
    "14": {
      class_type: "CreateVideo",
      inputs: { images: ["13", 0], fps: DEFAULT_FPS },
    },
    "15": {
      class_type: "SaveVideo",
      inputs: {
        video: ["14", 0],
        filename_prefix: prefix,
        format: "mp4",
        codec: "auto",
      },
    },
  };

  if (mode === "v2v") {
    /* 源视频窗口 → 帧序列（保留原镜头 / 身体动态） */
    prompt["16"] = { class_type: "LoadVideo", inputs: { file: opt.videoName } };
    prompt["17"] = { class_type: "GetVideoComponents", inputs: { video: ["16", 0] } };
    prompt["11"].inputs.start_image = ["17", 0];
    prompt["11"].inputs.clip_vision_output = ["18", 0];
    prompt["18"] = {
      class_type: "CLIPVisionEncode",
      inputs: { clip_vision: ["19", 0], image: ["17", 0], crop: "none" },
    };
    prompt["19"] = { class_type: "CLIPVisionLoader", inputs: { clip_name: WEIGHTS.clipVision } };
  } else {
    prompt["16"] = { class_type: "LoadImage", inputs: { image: opt.imageName } };
    prompt["17"] = {
      class_type: "CLIPVisionEncode",
      inputs: { clip_vision: ["18", 0], image: ["16", 0], crop: "none" },
    };
    prompt["18"] = { class_type: "CLIPVisionLoader", inputs: { clip_name: WEIGHTS.clipVision } };
    prompt["11"].inputs.start_image = ["16", 0];
    prompt["11"].inputs.clip_vision_output = ["17", 0];
    /* 续写段：上一段末 N 帧当运动上下文（LoadVideo→frames）。
       节点会把这段运动帧重新放到输出开头（trim_image 就是重叠帧数），必须裁掉，
       否则每块都会多出 9 帧静止画面、音画逐块错位。 */
    if (opt.prevFramesName) {
      prompt["19"] = { class_type: "LoadVideo", inputs: { file: opt.prevFramesName } };
      prompt["20"] = { class_type: "GetVideoComponents", inputs: { video: ["19", 0] } };
      prompt["11"].inputs.previous_frames = ["20", 0];
      prompt["21"] = {
        class_type: "ImageFromBatch",
        inputs: { image: ["13", 0], batch_index: ["11", 4], length: 4096 },
      };
      prompt["14"].inputs.images = ["21", 0];
    }
  }

  return { prompt, mode, width, height, length, steps, seed, fps: DEFAULT_FPS, prefix };
}

module.exports = {
  RESOLUTIONS,
  RESOLUTION_KEYS,
  DEFAULT_STEPS,
  DEFAULT_FPS,
  DEFAULT_LENGTH,
  MOTION_FRAME_COUNT,
  DEFAULT_PROMPT,
  DEFAULT_NEGATIVE,
  WEIGHTS,
  normLength,
  buildPrompt,
};
