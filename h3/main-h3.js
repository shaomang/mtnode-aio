"use strict";
/**
 * Minimax H3（24G）插件主进程：
 * - 安装目录 / 脚手架 / dsh 安装编排
 * - ComfyUI 后端单例（detached，不随 MTNode 退出）
 * - 全局生成锁、GPU 监视、控制台窗、视频生成
 */
const {
  BrowserWindow,
  ipcMain,
  dialog,
  screen,
  app,
  shell,
} = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const http = require("http");
const { spawn, execFile } = require("child_process");
const crypto = require("crypto");
const { resolveDshRunAuth } = require("../dsh/mtnode-llm-creds.js");
const {
  verGt,
  verMax,
  fetchBuffer,
  fetchRemoteManifest,
  downloadRuntimeTo,
} = require("../plugins/runtime-feed.js");
const {
  refreshStaleLock,
  tryAcquireLock,
  clearLock,
  releaseLock,
  busyMessage,
} = require("../media-gen-global-lock.js");
const h3wf = require("./h3-workflows.js");
/* 插件报错总线：失败出口统一上报主窗口（跨窗可见 + 一键自我修复），见 plugin-error-repair.js */
const pluginErrors = require("../plugin-error-repair.js");

const PLUGIN_ID = "minimax-h3";
const H3_FEED = process.env.MTNODE_H3_URL || "http://mt-agent.com/mtnode/h3";
const DEFAULT_PORT = 8188;
const DISK_HINT_GB = 70;
const GENERATE_MAX_MS = 60 * 60 * 1000;

/* 管理窗 Console 停靠面板：宽 360（与 h3/ui/index.html 的 .console-pane 成对）。
   窗口原本 420 宽，撑开后 780；收回去时主列必须回到原位，所以最小宽度钉 420。 */
const CONSOLE_PANE_W = 360;
const CONSOLE_PANE_MAX_W = 900;
const CONSOLE_WIN_MIN_W = 420;

/* EasyCache 在 MiniMax H3 上的质量安全档（4090 24G 实测口径，勿按官方默认随手改）。
 *
 * ComfyUI 原生 EasyCache 节点自带默认 0.2 / 0.15 / 0.95，那套是按「几十步的图像模型」
 * 调的；H3 的生成链只有 20 步（官方 template 靠 turbo LoRA 压到 4–8 步、根本不用
 * EasyCache），起点 0.15 会让缓存从第 3 步就生效，reuse 累计额度 0.2 又够大 ——
 * 结果第 3 步起大段步骤直接复用上一版输出，实测（864×480 / 20 步 / 同种子）：
 *   官方默认 0.2/0.15/0.95 → 与关缓存逐帧差异 mean 0.0385、max 0.1323，
 *                             相邻帧抖动 mean 0.0119（关缓存 0.0092），画面明显跳变/漂移；
 *   本档     0.08/0.30/0.90 → 差异 mean 0.004、抖动与关缓存基本一致（0.0092），
 *                             且仍能实打实跳步（有加速收益）。
 * 所以「开了 EasyCache 画质大幅下降」不是节点开关的问题，是这套复用阈值对 H3 的
 * 20 步 schedule 太激进。默认值按本档下发；用户在「高级参数」里的自定义值仍尊重，
 * 但夹到质量安全区间，避免再退回官方默认那种一开就废的档位。 */
const EASY_SAFE = {
  /* 三个都是「越小/越晚 = 画质越保真、越不加速」：reuse 小=更少跳步，start 大=更晚
   * 进缓存，end 小=更早退出。默认值是实测下与关缓存几乎一致、又能跳步的那一档。 */
  reuse: { min: 0.01, max: 0.2, value: 0.08 },
  start: { min: 0.15, max: 0.6, value: 0.3 },
  end: { min: 0.6, max: 1.0, value: 0.9 },
};

/** 夹取到 [min,max]；非有限数回落到 fallback。 */
function clampNum(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

const MODELS = {
  fl2va: "minimax_h3_fl2va_pruned_int8_convrot.safetensors",
  ref2va: "minimax_h3_ref2va_pruned_int8_convrot.safetensors",
  clip: "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
  vaeVideo: "minimax_h3_video_vae_fp16.safetensors",
  vaeAudio: "minimax_h3_audio_vae_fp32.safetensors",
};

const RATIOS = {
  "16:9": [1280, 704], /* 24G 安全上限（4090 实测：1344×768 必卡死，1280×704 安全） */
  "9:16": [704, 1280],
  "1:1": [768, 768],
  "4:3": [1024, 768],
  "3:4": [768, 1024],
  "21:9": [1280, 544],
};

/* 24G 显存安全上限（长边像素）；超限自动钳制到安全档，避免卡死 */
const VRAM_SAFE_MAX_DIM = 1280;
const VRAM_SAFE_MAX_MP = 0.98; /* ≈1280×768 */

/* 独立后处理（超分 / 补帧）模型：两者已从 MiniMax H3 生成链拆出，各自单独成图。
 *  Real-ESRGAN（x4plus 通用 / x2plus 原生 x2）走 ComfyUI 原生 UpscaleModelLoader +
 *  KJNodes 分块上采样；RIFE 由 ComfyUI-Frame-Interpolation 提供。
 *  x2plus 是可选权重：本机没有也能用 x2 倍率（走 x4 模型 + 输出端缩到 2 倍），
 *  只是中间张量仍按 x4 算 —— 见 pickNativeX2Model / upscaleFactorOfModel。 */
const POST_MODELS = {
  upscale: "RealESRGAN_x4plus.pth",
  upscaleX2: "RealESRGAN_x2plus.pth",
  rife: "rife47.pth",
};
/* 超分倍率（对外可选项）：2 = 输出相对源放大 2 倍，4 = Real-ESRGAN x4 原生倍率。 */
const POST_UPSCALE_SCALES = [2, 4];

/* 后处理 24G 安全档默认值（4090 24G 口径）：超分逐帧（per_batch=1）、RIFE 低显存
 * （batch_size=1 + 极小 clear_cache）。tile / lowVram 不直接进图（ComfyUI 的
 * UpscaleModelLoader / ImageUpscaleWithModelBatched 没有这两个输入），
 * 只在这里换算成 per_batch：lowVram 强制 1。 */
const POST_SAFE_DEFAULTS = {
  upscale: { model: POST_MODELS.upscale, scale: 4, targetLongSide: 3840, perBatch: 1, tile: 0, lowVram: true },
  interp: { multiplier: 2, clearCacheEvery: 2, batchSize: 1, scaleFactor: 1.0 },
};
const POST_TARGET_LONG_SIDE_MIN = 1280;
/* ComfyUI 的 UpscaleModelLoader.model_name 是 combo：候选值 = upscale_models 目录下的
 * 「文件名（含扩展名）」。画布上老的 video_upscale 节点存的是不带扩展名的
 * "RealESRGAN_x4plus"，直接下发会被判 value_not_in_list 拒图。 */
const POST_MODEL_EXTS = [".pth", ".pt", ".safetensors", ".bin", ".onnx"];

/* ── 系统内存（RAM）闸：超分把 64G 内存跑满、显存反而空着 ──────────────────
 * 成因两层，都在 ComfyUI 侧，节点只是触发器：
 *  ① 启动参数没给 ComfyUI 的**系统内存缓存**任何上限 → 默认活跃阈值 10% 内存（2–10G）、
 *     非活跃阈值 100%（最高 128G）：节点产物（整段视频的帧张量，float32 一份就是几十 G）
 *     会被尽可能久地留在 RAM 里，机器 64G 直接见顶（见 comfy_execution/caching.py
 *     RAMPressureCache.ram_release 与 execution.py 的 ram_headroom）。
 *  ② 超分链的峰值本来就是「RAM 里同时躺着帧张量 + 张量 float32 副本」，与显存无关：
 *     KJNodes 的 ImageUpscaleWithModelBatched 是逐批过 GPU、结果 .cpu() 攒在 RAM，
 *     最后 torch.cat + .float() 再复制一份 —— 显存空着是正常的，瓶颈在 CPU 侧内存。
 * 所以这里做两件事：给后端加系统内存保留下限（--cache-ram，可在管理窗关掉），
 * 以及提交前按「源分辨率 + 帧数」估一次峰值内存，超预算就自动降目标长边（见
 * resolveUpscaleRamPlan / probeMp4Meta），而不是等机器被跑满。 */
const POST_CACHE_RAM_ACTIVE_GB = 8;
/** 系统内存保留比例：峰值预算 = min(可用内存, 总内存的一半) - POST_RAM_RESERVE_GB */
const POST_RAM_RESERVE_GB = 6;

/* ── 系统内存「持续攀升」护栏（后端进程本身不回收 → 每一单都比上一单更紧） ─────
 * 上面那套内存闸（估峰值 + --cache-ram + 预缩放）管的是**单次**峰值；实测还有第二层问题：
 *   ① ComfyUI 是常驻服务（stopBackend 只在用户点「停止」时才杀），`POST /free`
 *      只卸模型、不清 glibc 的 arena，一个跑了 N 单 4K 超分 / RIFE 的 Python 进程
 *      RSS 会一路上涨、**永不回落**（Windows 上尤其明显：malloc 不把大块还给系统）；
 *   ② 于是第 N+1 单的可用内存比第 2 单少得多，内存闸再准也只是「在一台越来越小的机器上收敛」。
 * 所以护栏要放在**任务之间**：每单收尾时量一次这台机器还剩多少内存、服务占了多少，
 * 「守住的量 > 一半内存」或「本机已不足 POST_MEM_RAIL_MIN_FREE_GB」就把后端重启回收
 * （不阻塞本次回执：后台等空闲再重启，下次任务自己拉起）。
 * 度量取 /system_stats 的 system.ram_free（后端自己报的事实）而不是宿主 os.freemem()：
 * 同一时刻同口径，算「守住的内存 = 这次量到的空闲 - 任务开始时看到的空闲」时不会被别的程序干扰。 */
const POST_MEM_RAIL_MIN_FREE_GB = 6;
/** 服务在两次采样之间「守住」的比例超过它 → 认为进程不回收（默认 0.5 = 一半内存） */
const POST_MEM_RAIL_KEEP_RATIO = 0.5;
/** 硬闸：启动任务前空闲内存低于总内存这个比例 → 先回收（哪怕还有余量也别在悬崖边跑） */
const POST_MEM_RAIL_GUARD_RATIO = 0.35;
/** /system_stats 内存采样的复用窗口：状态轮询每 4 秒一次，不许每次都打后端 */
const COMFY_RAM_STATS_TTL_MS = 60000;
/** 单个 float32 像素占 4 字节；图像张量一律 float32（ComfyUI IMAGE 口径） */
const BYTES_PER_F32_PX = 4;
/* OOM 判据：ComfyUI 把 torch 的显存报错放进 execution_error 的 messages，最终落在 err.detail。
 * 刻意只认「显存不足」这一族（含 Windows 的 "CUDA error: out of memory"），
 * 别的 CUDA 报错不降档重试，免得掩盖真问题。 */
const POST_OOM_RE =
  /out of memory|OutOfMemory|insufficient memory|allocation on device|CUBLAS_STATUS_ALLOC_FAILED|CUDNN_STATUS_ALLOC_FAILED/i;

/* ── 超分引擎选路：逐帧流式（默认）vs ComfyUI 图（兜底） ──────────────────────
 * 旧图链（LoadVideo → ImageUpscaleWithModelBatched → CreateVideo）把**整段视频的帧张量 +
 * float32 副本**全攒在系统内存里，峰值 ∝ 时长：15s@720p 走 x4 中间张量就 ~21GB，
 * 所以 64G 会见顶、16G 根本跑不动（成因见上面 RAM 闸注释与 h3-pack/post/stream_upscale.py 头注释）。
 * 新链逐帧 decode → 按 tile 分块过模型 → 立刻编码写盘，常驻内存只与「一个 tile + 一帧」有关，
 * 与时长无关 —— 16G 机器也能跑 15 秒级 x2/x4 超分。
 * 这里只做选路：能跑流式就走流式；缺脚本 / 缺 venv / 用户显式要图时原样回退旧图（控制台写明原因）。 */
const POST_STREAM_SCRIPT = "stream_upscale.py";
/* 流式补帧（RIFE）：脚本与超分同目录随包（h3-pack/post/），权重按 ComfyUI-Frame-Interpolation
 * 的既有落点探测 —— 顺序与 stream_interp.py 的 RIFE_WEIGHT_PREFERENCE 一字对齐，
 * 缺权重时选路直接回退图（见 resolvePostEngine 的 interp_weights_missing）。 */
const POST_STREAM_INTERP_SCRIPT = "stream_interp.py";
const POST_RIFE_WEIGHT_PREFERENCE = ["rife49.pth", "rife47.pth", "rife417.pth", "rife426.pth"];
const POST_STREAM_DEFAULT_TILE = 512;
const POST_STREAM_DEFAULT_OVERLAP = 16;
const POST_STREAM_DEFAULT_CRF = 17;
const POST_STREAM_DEFAULT_PRESET = "medium";
/** fp16 前向的显存下限（GB）：小于它落 fp32（宿主量不到显存时按 lowVram 档算，见 resolvePostOptions） */
const POST_STREAM_MIN_FP16_VRAM_GB = 6;

/** 源分辨率 → 目标长边像素（按比例，取偶） */
function postDimsForLongSide(width, height, longSide) {
  const w = Math.max(1, Math.round(Number(width) || 1));
  const h = Math.max(1, Math.round(Number(height) || 1));
  const long = Math.max(w, h);
  const target = Math.max(1, Math.round(Number(longSide) || long));
  const scale = target / long;
  let tw = Math.max(2, Math.round((w * scale) / 2) * 2);
  let th = Math.max(2, Math.round((h * scale) / 2) * 2);
  return [tw, th];
}

/* ── 超分倍率（x2 / x4） ───────────────────────────────────────────────────
 * 倍率决定两件事，二者必须分开看：
 *  ① 输出尺寸 = min(目标长边, 源长边 × 倍率) —— 「x2」= 画面只放大一倍；
 *  ② 模型固有倍数（权重名里的 x2 / x4）决定**中间张量**多大 —— 峰值内存的主项。
 * 本机只有 x4plus 时选 x2 也成立（输出端 ImageScale 从 x4 缩到 2 倍），
 * 但中间张量仍是 x4 口径，内存估算按模型算而不是按倍率算（见 upscaleFactorOfModel）。 */
function normalizeUpscaleScale(raw) {
  const n = Math.round(Number(raw) || 0);
  return POST_UPSCALE_SCALES.indexOf(n) >= 0 ? n : POST_SAFE_DEFAULTS.upscale.scale;
}

/** 权重文件名 → 模型固有放大倍数：带 x2 / 2x 的按 2，其余按 x4（Real-ESRGAN 家族口径）。 */
function upscaleFactorOfModel(name) {
  return /x2|2x/i.test(String(name == null ? "" : name)) ? 2 : 4;
}

/** 从本机 upscale_models 清单里挑一个原生 x2 权重（没有就返回空串，走 x4 模型兜底）。 */
function pickNativeX2Model(available) {
  if (!Array.isArray(available) || !available.length) return "";
  const x2 = available.filter((f) => upscaleFactorOfModel(f) === 2);
  if (!x2.length) return "";
  const key = (s) => String(s).toLowerCase();
  for (const f of x2) if (key(f) === key(POST_MODELS.upscaleX2)) return f;
  return x2[0];
}

/** 超分输出长边：倍率是上限（x2 不会被目标长边拉到 4 倍），目标长边仍是画质上限。 */
function upscaleOutputLongSide(targetLongSide, sourceLong, scale) {
  const k = normalizeUpscaleScale(scale);
  const cap = Math.max(0, Math.round(Number(sourceLong) || 0)) * k;
  const want = Math.round(Number(targetLongSide) || 0);
  if (cap <= 0) return want;
  if (want <= 0) return cap;
  return Math.min(want, cap);
}

/* ─────────────── MP4 元数据（估内存用，不解码视频） ───────────────
 * 只为「这一单要多少内存」服务：从 moov 里读 mvhd 的时长/时间基、视频轨的 tkhd 宽高与
 * stts 采样数（= 帧数）。全是容器级字段，不用 ffmpeg / 不用解码，毫秒级。
 * 读不到（fragmented mp4 / 异常文件）一律返回 null —— 估不出来的路径不阻断任务。 */

/** 会套子 box 的容器（递归只往这些里钻；别的 box 直接跳过，免得白扫几十 MB 的 mdat） */
const CONTAINER_BOXES = ["moov", "trak", "mdia", "minf", "stbl", "edts", "udta", "meta"];

/** 在 [start,end) 里**递归**找第一个 `type` box（moov 是嵌套的：trak → mdia → minf → stbl →
 *  stts，hdlr 也藏在 mdia 里，只看某一层会全部漏掉）。返回 { start, end } 或 null。 */
function findBoxDeep(buf, start, end, type) {
  let at = start;
  while (at + 8 <= end) {
    let size = buf.readUInt32BE(at);
    const t = buf.toString("latin1", at + 4, at + 8);
    let head = 8;
    if (size === 1) {
      if (at + 16 > end) return null;
      size = Number(buf.readBigUInt64BE(at + 8));
      head = 16;
    } else if (size === 0) {
      size = end - at;
    }
    if (size < head || at + size > end) return null;
    if (t === type) return { start: at + head, end: at + size };
    /* 容器：只往会套东西的 box 里钻，别的（mdat / 采样表叶子）不钻，免得白扫几十 MB */
    if (CONTAINER_BOXES.indexOf(t) >= 0) {
      const hit = findBoxDeep(buf, at + head, at + size, type);
      if (hit) return hit;
    }
    at += size;
  }
  return null;
}

/** 读一个 moov buffer：时长（秒）/ 视频轨帧数 / 视频轨宽高（按旋转矩阵换算成显示方向） */
function readMoovMeta(moov) {
  let duration = 0;
  let frames = 0;
  let width = 0;
  let height = 0;
  const mvhd = findBoxDeep(moov, 0, moov.length, "mvhd");
  if (mvhd) {
    const version = moov[mvhd.start];
    /* mvhd：ver/flags(4) + ctime + mtime + timescale(4) + duration(4/8)（ISO/IEC 14496-12）。
     * version 0 的 ctime/mtime 各 4 字节 → timescale 在 +12、duration 在 +16；
     * version 1 各 8 字节 → +20 / +24。别想当然：实测真实文件（ComfyUI 导出的 mp4）里
     * 把 ctime 当成 8 字节去读会拿到 timescale=0，读不出时长。 */
    const tsOff = mvhd.start + (version === 1 ? 20 : 12);
    const durOff = mvhd.start + (version === 1 ? 24 : 16);
    const timescale = tsOff + 4 <= mvhd.end ? moov.readUInt32BE(tsOff) : 0;
    const raw =
      durOff + 8 <= mvhd.end
        ? version === 1
          ? Number(moov.readBigUInt64BE(durOff))
          : moov.readUInt32BE(durOff)
        : 0;
    if (timescale > 0 && raw > 0) duration = raw / timescale;
  }
  /* 轨道要从 moov 里逐个 trak 走（hdlr / tkhd / stts 都藏在 trak → mdia → minf → stbl 下），
   * 只认第一条 hdlr.handler_type == 'vide' 的轨（音轨 tkhd 宽高为 0，认错了估出来是 0）。 */
  let at = 0;
  while (at + 8 <= moov.length) {
    let size = moov.readUInt32BE(at);
    const t = moov.toString("latin1", at + 4, at + 8);
    let head = 8;
    if (size === 1) {
      if (at + 16 > moov.length) break;
      size = Number(moov.readBigUInt64BE(at + 8));
      head = 16;
    } else if (size === 0) {
      size = moov.length - at;
    }
    if (size < head || at + size > moov.length) break;
    if (t === "trak") {
      const trakStart = at + head;
      const trakEnd = at + size;
      const hdlr = findBoxDeep(moov, trakStart, trakEnd, "hdlr");
      /* hdlr：version/flags(4) + pre_defined(4) + handler_type(4) */
      if (hdlr && moov.toString("latin1", hdlr.start + 8, hdlr.start + 12) === "vide") {
        const tkhd = findBoxDeep(moov, trakStart, trakEnd, "tkhd");
        if (tkhd) {
          const version = moov[tkhd.start];
          /* version 0：(ver/flags 4)(ctime 4)(mtime 4)(track_id 4)(reserved 4)(duration 4)
           *             (reserved 8)(layer 2)(alt 2)(volume 2)(reserved 2)(matrix 36)
           *             → w/h 各 16.16 定长点在 +76 / +80；version 1 表头多 12 字节 → +88 / +92。
           * （实测 ComfyUI 导出的 mp4 就是 +76 / +80，别把矩阵想成 8 字节对齐。） */
          const whOff = tkhd.start + (version === 1 ? 88 : 76);
          if (whOff + 8 <= tkhd.end) {
            const w = moov.readUInt32BE(whOff) / 65536;
            const h = moov.readUInt32BE(whOff + 4) / 65536;
            if (w > 0 && h > 0) {
              width = Math.round(w);
              height = Math.round(h);
            }
          }
          /* 旋转矩阵（36 字节 = 9 个 16.16 定长点，a 与 c 是第 1 / 第 5 个）：
           * a=c=0 或矩阵全零 → 画幅转了 90/270 度（或没写矩阵），显示宽高要对调；
           * 正常横片是 a=d=1、b=c=0（单位矩阵），绝不能当旋转把宽高换掉。 */
          const matOff = tkhd.start + (version === 1 ? 52 : 40);
          if (matOff + 20 <= tkhd.end) {
            const a = moov.readInt32BE(matOff) / 65536;
            const c = moov.readInt32BE(matOff + 16) / 65536;
            const d = moov.readInt32BE(matOff + 20) / 65536;
            const identity = Math.abs(a - 1) < 0.01 && Math.abs(d - 1) < 0.01 && !c;
            if (!identity && !a && !c && width && height) {
              const swap = width;
              width = height;
              height = swap;
            }
          }
        }
        const stts = findBoxDeep(moov, trakStart, trakEnd, "stts");
        if (stts) {
          /* stts：ver/flags(4) + entry_count(4) + [sample_count(4) + sample_delta(4)]×N
           * 帧数 = 各条 sample_count 之和（容器级，不解码）。
           * 注意 sample_count 在记录首字段 → 偏移是 +8 / +16…，别读成 sample_delta。 */
          const count = stts.start + 8 <= stts.end ? moov.readUInt32BE(stts.start + 4) : 0;
          let total = 0;
          for (let i = 0; i < count; i++) {
            const off = stts.start + 8 + i * 8;
            if (off + 8 > stts.end) break;
            total += moov.readUInt32BE(off);
          }
          if (total > 0) frames = total;
        }
        break; /* 只认第一条视频轨 */
      }
    }
    at += size;
  }
  return { duration, frames, width, height };
}

/** 读源视频容器元数据（只读头尾两个窗口，不整文件进内存） */
function probeMp4Meta(filePath) {
  let fd = null;
  try {
    const size = fs.statSync(filePath).size;
    if (!size || size < 16) return null;
    fd = fs.openSync(filePath, "r");
    /* moov 可能在前也可能在后（未 faststart 的导出在尾部），先扫头部；扫不到再扫尾部 24MB */
    const scan = (offset, len) => {
      const buf = Buffer.alloc(len);
      const n = fs.readSync(fd, buf, 0, len, offset);
      const view = n === len ? buf : buf.subarray(0, n);
      const found = findBoxDeep(view, 0, view.length, "moov");
      return found ? view.subarray(found.start, found.end) : null;
    };
    const head = scan(0, Math.min(size, 8 * 1024 * 1024));
    const moov =
      head ||
      (size > 8 * 1024 * 1024
        ? scan(Math.max(0, size - 24 * 1024 * 1024), Math.min(size, 24 * 1024 * 1024))
        : null);
    if (!moov) return null;
    const meta = readMoovMeta(moov);
    return meta.frames > 0 ? meta : null;
  } catch {
    return null;
  } finally {
    if (fd != null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

/** 系统内存：总 / 可用（GB）。取不到（null）就按「不设预算」处理，绝不误降档。 */
function systemRamGb() {
  try {
    const total = Number(os.totalmem()) / 1024 ** 3;
    const free = Number(os.freemem()) / 1024 ** 3;
    return {
      total: Number.isFinite(total) && total > 0 ? total : null,
      free: Number.isFinite(free) && free >= 0 ? free : null,
    };
  } catch {
    return { total: null, free: null };
  }
}

/** 取 >0 的有限数，否则 null（缺字段 / 0 / NaN 一律当「没量到」） */
function posNumOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** GB 数值（保留 1 位），给控制台 / 状态回显用 */
function gb1(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : null;
}

/* ComfyUI 的 /system_stats 里 system.ram_free / ram_total 是字节；
 * 不同版本可能改用 free_memory（MB）等别名，所以按候选键依次认。
 * probeComfy 只判状态码，这里顺手把它已经取过的那次响应缓存 60 秒给内存口径复用，
 * 免得状态轮询每 4 秒各打一次 /system_stats。 */
let comfyRamStatsCache = { at: 0, port: 0, origin: "", ram: null };

/**
 * 读一次后端的系统内存事实（空闲 / 总量，GB）。取不到返回 {free:null,total:null}
 * —— 量不到时所有护栏一律放行，绝不误杀任务。
 * @param {number} port
 * @param {{reuse?: boolean}} [opts] reuse=true（默认）时 60 秒内的同端口结果直接复用
 */
async function probeComfyRamStats(port, opts) {
  const p = Number(port) || DEFAULT_PORT;
  const reuse = !opts || opts.reuse !== false;
  const now = Date.now();
  if (reuse && comfyRamStatsCache.ram && comfyRamStatsCache.port === p && now - comfyRamStatsCache.at < COMFY_RAM_STATS_TTL_MS) {
    return comfyRamStatsCache.ram;
  }
  const empty = { free: null, total: null };
  let json = null;
  try {
    const r = await httpJson("GET", `http://127.0.0.1:${p}/system_stats`, null, 2500);
    json = (r && r.json) || null;
  } catch {
    json = null;
  }
  const sys = (json && json.system) || {};
  const bytes = (raw) => {
    const n = posNumOrNull(raw);
    return n == null ? null : (n > 1024 * 1024 ? n : n * 1024 * 1024) / 1024 ** 3;
  };
  const memPick = (bKeys, mbKeys) => {
    for (const k of bKeys) {
      const v = bytes(sys[k]);
      if (v != null) return v;
    }
    for (const k of mbKeys) {
      const n = posNumOrNull(sys[k]);
      if (n != null) return n / 1024;
    }
    return null;
  };
  const ram = {
    free: memPick(["ram_free"], ["free_memory", "ram_free_mb"]),
    total: memPick(["ram_total"], ["total_memory", "ram_total_mb"]),
  };
  comfyRamStatsCache = { at: now, port: p, origin: "comfy", ram };
  return ram;
}

/** 把这次任务前后两次采样的可用内存换算成「服务守住 / 本机紧张」判决。
 *  usedFrom 为 null（第一单量不到起点）时只能靠绝对水位判，判不出就返回 null = 放行。 */
function ramRailVerdict(beforeFreeGb, afterFreeGb, totalGb) {
  const before = posNumOrNull(beforeFreeGb);
  const after = posNumOrNull(afterFreeGb);
  const total = posNumOrNull(totalGb);
  const minFree = total ? total * (1 - POST_MEM_RAIL_GUARD_RATIO) : null;
  const keptGb = before != null && after != null && before - after > 0 ? before - after : 0;
  const keptRatio = total ? keptGb / total : null;
  const tightNow = after != null && (after <= POST_MEM_RAIL_MIN_FREE_GB || (minFree != null && after < minFree));
  const keepTooMuch = before != null && after != null && keptRatio != null && keptRatio > POST_MEM_RAIL_KEEP_RATIO;
  return {
    beforeGb: gb1(before),
    afterGb: gb1(after),
    totalGb: gb1(total),
    keptGb: gb1(keptGb),
    keptPct: keptRatio == null ? null : Math.round(keptRatio * 100),
    tightNow,
    keepTooMuch,
    recycle: !!(before != null && after != null && (tightNow || keepTooMuch)),
  };
}

/**
 * 等后端空闲（没有别的任务占着媒体锁 / 没有在跑的生成）最多 waitMs。
 * 回收是「任务之间」的动作：绝不能把另一个正在跑的任务的后端杀掉。
 */
async function waitBackendIdle(waitMs) {
  const deadline = Date.now() + Math.max(0, Number(waitMs) || 0);
  for (;;) {
    const lock = refreshStaleLock();
    if (!lock && !activeGenerate) return true;
    if (Date.now() >= deadline) return false;
    await sleep(2000);
  }
}

/**
 * 系统内存水位监视：每 2 秒采一次可用内存，记下最低值。
 * 只服务一件事 —— 把「跑满的是系统内存、显存反而空着」变成控制台里的实测数字，
 * 用户不必猜是不是显存不够（超分链本来就是逐帧过 GPU、帧张量攒在 RAM）。
 */
function startRamWatch() {
  const start = systemRamGb();
  const w = {
    minFree: start.free,
    total: start.total,
    stop() {
      if (w.timer) clearInterval(w.timer);
      w.timer = null;
      return w;
    },
  };
  try {
    w.timer = setInterval(() => {
      const now = systemRamGb();
      if (now.free != null && (w.minFree == null || now.free < w.minFree)) w.minFree = now.free;
    }, 2000);
    if (w.timer.unref) w.timer.unref();
  } catch {}
  return w;
}

/** 收尾：把这一单实测到的系统内存水位写进控制台（有压力才提醒，正常时只留一行事实）。 */
function appendPostRamReport(watch, ok) {
  if (!watch) return;
  const w = watch.stop();
  if (w.total == null || w.minFree == null) return;
  const used = Math.max(0, Math.round(w.total - w.minFree));
  appendConsole(
    "[post] " +
      (ok ? "完成" : "结束") +
      " · 系统内存最低剩 " +
      Math.round(w.minFree) +
      "G / 共 " +
      Math.round(w.total) +
      "G（峰值占用约 " +
      used +
      "G，均含系统与其它程序）",
  );
  if (w.minFree <= 2) {
    appendConsole(
      "[post] [warn] 本机系统内存已被跑满：这是超分链的固有峰值（整段视频的帧张量 + float32 副本都在 RAM，" +
        "逐帧过 GPU，所以显存反而是空的）。已启用 --cache-ram 在内存吃紧时释放 ComfyUI 的产物缓存；" +
        "仍吃紧请降目标长边 / 缩短时长 / 降帧率，或换内存更大的机器。",
    );
  }
}

/**
 * 超分单的峰值系统内存估算（GB）。
 * 峰值 ≈ max(源帧张量, 超分中间张量, 输出尺寸帧张量) + 一份同量级的拼接/float32 暂存 + 固定开销。
 * 依据 KJNodes ImageUpscaleWithModelBatched 的真实实现（逐批过 GPU → .cpu() 攒着 →
 * torch.cat → .float() 再复制一份），所以「显存空着、内存见顶」是这条链的常态。
 * 两个倍数分开算，别混：
 *  · 中间张量按**模型固有倍数**（权重名 x2 → 4 倍像素，x4 → 16 倍像素）——它是峰值主项，
 *    且只由源分辨率决定，与目标长边无关（所以只降目标长边对「进超分模型前的那些帧」没用，
 *    见 resolveUpscaleRamPlan 的预缩放）；
 *  · 输出张量按**用户选的倍率**（x2 时输出 = 源 × 2，输出端的 ImageScale 把 x4 模型的产物缩回来）。
 * upscaleOpts 省略时按 x4 模型 + x4 倍率（历史口径）。
 */
function estimateUpscaleRamGb(sourceW, sourceH, targetLongSide, frames, upscaleOpts) {
  const f = Math.max(0, Math.round(Number(frames) || 0));
  const sw = Math.max(0, Math.round(Number(sourceW) || 0));
  const sh = Math.max(0, Math.round(Number(sourceH) || 0));
  if (!f || !sw || !sh) return null;
  const gb = (px) => (px * f * BYTES_PER_F32_PX) / 1024 ** 3;
  const opts = upscaleOpts && typeof upscaleOpts === "object" ? upscaleOpts : {};
  const modelFactor = upscaleFactorOfModel(opts.model || POST_MODELS.upscale);
  const outScale = normalizeUpscaleScale(opts.scale);
  const sourceGb = gb(Math.floor(sw / 2) * 2 * (Math.floor(sh / 2) * 2));
  const mid = gb(Math.floor(sw / 2) * 2 * modelFactor * (Math.floor(sh / 2) * 2 * modelFactor));
  let target = 0;
  const long = Math.max(sw, sh);
  if (Number(targetLongSide) > 0 && long > 0) {
    const outLong = upscaleOutputLongSide(
      Math.max(POST_TARGET_LONG_SIDE_MIN, Math.round(Number(targetLongSide))),
      long,
      outScale,
    );
    const [tw, th] = postDimsForLongSide(sw, sh, Math.max(POST_TARGET_LONG_SIDE_MIN, outLong));
    target = gb(tw * th);
  }
  const peak = Math.max(sourceGb, mid, target);
  return Math.round((peak + peak * 0.6 + 1.5) * 10) / 10;
}

/** 按候选的超分参数估峰值（把「预缩放过的源尺寸」也算进去） */
function estimatePostPeakRamGb(srcW, srcH, upscaleOpts, frames) {
  const scale = Number(upscaleOpts && upscaleOpts.preScale);
  const k = Number.isFinite(scale) && scale > 0 && scale < 1 ? scale : 1;
  const long = Math.max(Number(srcW) || 0, Number(srcH) || 0);
  const preLong = k < 1 && long > 0 ? Math.max(1, Math.round(long * k)) : 0;
  const [w, h] = preLong > 0 ? postDimsForLongSide(srcW, srcH, preLong) : [srcW, srcH];
  return estimateUpscaleRamGb(
    w,
    h,
    (upscaleOpts && upscaleOpts.targetLongSide) || 0,
    frames,
    upscaleOpts,
  );
}

function planGbText(gb) {
  return gb == null ? "" : Math.round(Number(gb) * 10) / 10 + "G";
}

/**
 * 超分提交前的内存闸。峰值主项是「帧张量 × 模型倍数²（x4 权重 → ×16）」且只由源像素决定，
 * 所以依次做两件事：
 *  ① 目标长边二分（区间 [最低档, 请求值]）：目标越小 → 交回 RAM 的帧张量越小；
 *  ② 到最低档仍超预算 → **进超分前先把源帧整体缩到某个比例**（preScale / preDims）：
 *     源少 k² 倍，中间张量就少 k² 倍，这是唯一能真正压住峰值的杠杆（代价：最终画面是
 *     「缩了再放大」，不如直接从源放大细腻，但总比把整机内存跑满强）。
 * 预算 = min(当前可用内存, 总内存一半) - POST_RAM_RESERVE_GB；取不到元数据 / 系统内存则不调整。
 * 返回 { opts(含 preScale/preDims), meta, frames, budgetGb, beforeGb, afterGb, downgraded, overBudget }。
 */
function resolveUpscaleRamPlan(opts, sourceW, sourceH) {
  const plan = {
    meta: null,
    frames: 0,
    budgetGb: null,
    beforeGb: null,
    afterGb: null,
    downgraded: false,
    overBudget: false,
    stream: false,
  };
  let next = Object.assign({}, opts);
  const src = String(opts && opts.sourcePath ? opts.sourcePath : "");
  const meta = src ? probeMp4Meta(src) : null;
  if (!meta) return Object.assign(plan, { opts: next });
  plan.meta = {
    duration: Math.round((meta.duration || 0) * 100) / 100,
    width: meta.width,
    height: meta.height,
  };
  plan.frames = meta.frames;
  const w = Number(sourceW) || meta.width || 0;
  const h = Number(sourceH) || meta.height || 0;
  const ram = systemRamGb();
  if (ram.total) {
    const half = ram.total / 2;
    const usable = Math.min(ram.free != null ? ram.free : half, half);
    plan.budgetGb = Math.max(2, Math.round((usable - POST_RAM_RESERVE_GB) * 10) / 10);
  }
  plan.beforeGb = estimateUpscaleRamGb(w, h, next.targetLongSide, meta.frames, next);
  /* 流式档（超分 / 补帧共用这条判定）：超分新链逐帧 decode → 分块 → 立刻编码，
   * 补帧新链逐对插值 → 立刻编码，两者常驻内存都只与「当前那一帧 / tile + 模型」有关、
   * 与时长无关（见 h3-pack/post/stream_upscale.py 与 stream_interp.py 头注释），
   * 所以这里**不做任何降档**：不二分目标长边、也不做 preScale 预缩放、更不降倍率
   * —— 源越清晰成片越好，内存不再是约束。
   * 上面的 beforeGb 只是旧图链口径的对照数字，照样打进控制台。图档行为一字未变。 */
  if (String(next.engine || "") === "stream") {
    plan.stream = true;
    plan.afterGb = plan.beforeGb;
    return Object.assign(plan, { opts: next });
  }
  if (plan.beforeGb == null || plan.budgetGb == null || plan.beforeGb <= plan.budgetGb) {
    plan.afterGb = plan.beforeGb;
    return Object.assign(plan, { opts: next });
  }

  /* ① 目标长边二分：找「刚好放得进预算」的最大目标（画质损失最小的一档） */
  const reqTarget = Math.max(
    POST_TARGET_LONG_SIDE_MIN,
    Math.round(Number(next.targetLongSide) || POST_TARGET_LONG_SIDE_MIN),
  );
  let lo = POST_TARGET_LONG_SIDE_MIN;
  let hi = reqTarget;
  let best = null;
  for (let i = 0; i < 8 && lo <= hi; i++) {
    const mid = Math.floor((lo + hi) / 2);
    const probe = Object.assign({}, next, { targetLongSide: mid });
    const gb = estimatePostPeakRamGb(w, h, probe, meta.frames);
    if (gb != null && gb <= plan.budgetGb) {
      best = probe;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (best) {
    next = best;
    plan.downgraded = true;
    plan.afterGb = estimatePostPeakRamGb(w, h, next, meta.frames);
    return Object.assign(plan, { opts: next });
  }

  /* ② 目标已到最低档仍超预算（源本身太大）：进超分前预缩放源帧。
   *    步长 0.1 从大到小试，取「放得进预算且缩得最少」的那一档。 */
  const long = Math.max(Number(w) || 0, Number(h) || 0);
  let chosen = null;
  for (let step = 9; step >= 1; step--) {
    const k = step / 10;
    const preLong = Math.max(2, Math.round(long * k));
    const [pw, ph] = postDimsForLongSide(w, h, preLong);
    const cand = Object.assign({}, next, { preScale: k, preDims: [pw, ph], targetLongSide: preLong });
    const gb = estimatePostPeakRamGb(w, h, cand, meta.frames);
    if (gb != null && gb <= plan.budgetGb) {
      chosen = { opts: cand, gb };
      break;
    }
  }
  if (!chosen) {
    /* 连 0.1 倍都放不进预算：用最小档下发并标 overBudget，让控制台把代价说清楚 */
    const k = 0.1;
    const preLong = Math.max(2, Math.round(long * k));
    const [pw, ph] = postDimsForLongSide(w, h, preLong);
    const cand = Object.assign({}, next, { preScale: k, preDims: [pw, ph], targetLongSide: preLong });
    chosen = { opts: cand, gb: estimatePostPeakRamGb(w, h, cand, meta.frames) };
    plan.overBudget = true;
  }
  next = chosen.opts;
  plan.downgraded = true;
  plan.afterGb = chosen.gb;
  return Object.assign(plan, { opts: next });
}

/* ── 流式超分的运行件定位 ─────────────────────────────────────────────────
 * 解释器取 ComfyUI 隔离 venv（torch / av / kornia 都装在那里，与安装流程同一路径口径）；
 * 脚本取 h3-pack 整目录随包（build.json extraResources）——打包态从 process.resourcesPath
 * 拿（同 bundledPackRoot() 口径），再兜运行时更新包 packRoot()。 */

/** 流式超分用的解释器路径：<ComfyUI 目录>/venv/Scripts/python.exe（不判存在，缺件时供日志指认；
 *  注意与 installDir 口径的 comfyVenvPython() 区分——这里吃的是 comfyDir() 的结果） */
function streamVenvPython(comfy) {
  const c = String(comfy || "");
  if (!c) return "";
  return join(c, "venv", "Scripts", "python.exe");
}

/** 流式超分脚本路径（不保证存在；取不到时返回首选候选，供控制台把缺件说清楚） */
function streamUpscaleScriptPath() {
  const cands = [];
  const push = (p) => {
    if (p && cands.indexOf(p) < 0) cands.push(p);
  };
  push(join(bundledPackRoot(), "post", POST_STREAM_SCRIPT));
  try {
    push(join(runtimePackRoot(), "post", POST_STREAM_SCRIPT));
  } catch {}
  for (const p of cands) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {}
  }
  return cands[0] || "";
}

/** 流式补帧脚本路径（口径与 streamUpscaleScriptPath 一致：打包态 → 运行时更新包；不保证存在） */
function streamInterpScriptPath() {
  const cands = [];
  const push = (p) => {
    if (p && cands.indexOf(p) < 0) cands.push(p);
  };
  push(join(bundledPackRoot(), "post", POST_STREAM_INTERP_SCRIPT));
  try {
    push(join(runtimePackRoot(), "post", POST_STREAM_INTERP_SCRIPT));
  } catch {}
  for (const p of cands) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {}
  }
  return cands[0] || "";
}

/* RIFE 权重探测结果的进程内缓存：一个 ComfyUI 目录只 stat 一遍
 * （流式补帧每单都要选路，权重不会在两次任务之间变，没必要反复读目录） */
let streamInterpWeightsCache = null; /* { comfy, path } */

/**
 * 探测本机已装的 RIFE 权重路径（口径与 stream_interp.py 的 _rife_dirs / discover_weights 一致：
 * custom_nodes/ComfyUI-Frame-Interpolation/ckpts/rife → ckpts/rife，先按官方文件名优先，
 * 再退目录内 rife*.pth 排序）。探测结果按 ComfyUI 目录缓存一次；找不到返回 ""（选路据此回退图）。
 */
function streamInterpWeightsPath(comfy) {
  const root = String(comfy || "");
  if (!root) return "";
  if (streamInterpWeightsCache && streamInterpWeightsCache.comfy === root) {
    return streamInterpWeightsCache.path;
  }
  const dirs = [
    join(root, "custom_nodes", "ComfyUI-Frame-Interpolation", "ckpts", "rife"),
    join(root, "ckpts", "rife"),
  ];
  let found = "";
  const isFile = (p) => {
    try {
      return fs.existsSync(p) && fs.statSync(p).isFile();
    } catch {
      return false;
    }
  };
  for (const d of dirs) {
    for (const name of POST_RIFE_WEIGHT_PREFERENCE) {
      if (isFile(join(d, name))) {
        found = join(d, name);
        break;
      }
    }
    if (found) break;
  }
  if (!found) {
    for (const d of dirs) {
      let names = [];
      try {
        names = fs
          .readdirSync(d)
          .filter((n) => /^rife.*\.pth$/i.test(n))
          .sort((a, b) => a.localeCompare(b));
      } catch {
        names = [];
      }
      if (names.length) {
        found = join(d, names[0]);
        break;
      }
    }
  }
  streamInterpWeightsCache = { comfy: root, path: found };
  return found;
}

/**
 * 超分引擎选路（纯函数，只吃事实、不碰文件系统）：给定环境事实决定走「逐帧流式」还是「图」。
 *  · upscale：默认流式（内存与时长无关）；显式 engine='graph' 或环境缺件时回退图；
 *  · interp（RIFE 补帧）：同样默认流式（常驻内存只与相邻两帧有关、与时长无关，
 *    见 h3-pack/post/stream_interp.py 头注释）；缺脚本 / 缺 venv / 缺 RIFE 权重时回退图；
 *  · 其它 kind → 图（原口径）。
 * ramInfo: { scriptExists, venvExists, weightsExists, forceGraph }
 * 返回 { engine:'stream'|'graph', reason }。
 */
function resolvePostEngine(kind, opts, ramInfo) {
  const info = ramInfo && typeof ramInfo === "object" ? ramInfo : {};
  if (kind === "interp") {
    const want = String((opts && opts.engine) || "stream").toLowerCase();
    if (want === "graph" || want === "comfy" || want === "legacy") {
      return { engine: "graph", reason: "requested_graph" };
    }
    const forced = String(info.forceGraph || "");
    if (forced) return { engine: "graph", reason: forced };
    if (!info.scriptExists) return { engine: "graph", reason: "interp_script_missing" };
    if (!info.venvExists) return { engine: "graph", reason: "interp_venv_missing" };
    if (!info.weightsExists) return { engine: "graph", reason: "interp_weights_missing" };
    return { engine: "stream", reason: "interp_default_stream" };
  }
  if (kind !== "upscale") return { engine: "graph", reason: "kind_not_upscale" };
  const want = String((opts && opts.engine) || "stream").toLowerCase();
  if (want === "graph" || want === "comfy" || want === "legacy") {
    return { engine: "graph", reason: "requested_graph" };
  }
  const forced = String(info.forceGraph || "");
  if (forced) return { engine: "graph", reason: forced };
  if (!info.scriptExists) return { engine: "graph", reason: "script_missing" };
  if (!info.venvExists) return { engine: "graph", reason: "venv_missing" };
  return { engine: "stream", reason: "default_stream" };
}

/** 补上视频扩展名（与 copyOutputToDir 的落名口径一致） */
function ensureVideoExt(name) {
  const n = String(name || "").trim() || "out.mp4";
  if (JOB_VIDEO_EXT_RE.test(n)) return n;
  return n + (path.extname(n) || ".mp4");
}

/**
 * 逐帧分块流式超分：spawn ComfyUI venv python 跑 h3-pack/post/stream_upscale.py。
 * 内存与视频时长无关（见脚本头注释），所以 16G 机器也能跑 15 秒级 x2/x4 超分。
 * 入参：{ py, script, nodeId, sourcePath, outPath, modelPath, scale, targetLongSide,
 *         tile, overlap, precision, crf, preset, fps }
 * 进度：脚本 stdout 每帧一行 JSON（meta / progress / done / error）→ emitProgress。
 * 取消：activeGenerate.abort（用户停止 / 释放显存）→ 向子进程 stdin 写 cancel 后杀掉；
 *      脚本自己会删半成品（退出码 4）。
 * 成功 resolve { path, bytes, frames, seconds, peakRamMb, peakVramMb }；
 * 失败 reject（err.oom = true 表示显存/内存不足，供上层降档重试）。
 */
function runStreamUpscaleJob(job) {
  const j = job || {};
  const nodeId = String(j.nodeId || "");
  return new Promise((resolve, reject) => {
    const args = [
      String(j.script),
      "--input",
      String(j.sourcePath),
      "--output",
      String(j.outPath),
      "--model",
      String(j.modelPath || ""),
      "--scale",
      String(Math.round(Number(j.scale) || 4)),
      "--target-long-side",
      String(Math.max(0, Math.round(Number(j.targetLongSide) || 0))),
      "--tile",
      String(Math.max(64, Math.round(Number(j.tile) || POST_STREAM_DEFAULT_TILE))),
      "--overlap",
      String(Math.max(0, Math.round(Number(j.overlap) || 0))),
      "--precision",
      String(j.precision || "fp16"),
      "--crf",
      String(Math.max(0, Math.round(Number(j.crf) || POST_STREAM_DEFAULT_CRF))),
      "--preset",
      String(j.preset || POST_STREAM_DEFAULT_PRESET),
      "--progress-every",
      "1",
    ];
    if (Number(j.fps) > 0) args.push("--fps", String(Number(j.fps)));
    appendConsole("[post] $ " + [String(j.py), ...args].join(" "));

    const env = Object.assign({}, process.env, {
      PYTHONIOENCODING: "utf-8",
      PYTHONUNBUFFERED: "1",
      MALLOC_ARENA_MAX: process.env.MALLOC_ARENA_MAX || "1",
    });
    let child;
    try {
      child = spawn(String(j.py), args, {
        cwd: path.dirname(String(j.script)) || undefined,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        env,
      });
    } catch (e) {
      reject(e);
      return;
    }

    let stdoutBuf = "";
    let stderrTail = "";
    let last = null; /* 最后一条 done / error 回执 */
    let killed = false;
    const killChild = (why) => {
      if (killed) return;
      killed = true;
      appendConsole("[post] 流式超分收到停止信号（" + String(why || "cancel") + "）→ 终止子进程");
      try {
        child.stdin.write("cancel\n");
      } catch {}
      try {
        child.kill();
      } catch {}
    };
    if (activeGenerate && activeGenerate.nodeId === nodeId) activeGenerate.streamKill = killChild;
    const poll = setInterval(() => {
      if (activeGenerate && activeGenerate.abort) killChild("activeGenerate.abort");
    }, 300);

    const onLine = (line) => {
      const t = String(line || "").trim();
      if (!t) return;
      let ev = null;
      try {
        ev = JSON.parse(t);
      } catch {
        appendConsole("[post][stream] " + t);
        return;
      }
      if (!ev || typeof ev !== "object") return;
      if (ev.type === "meta") {
        appendConsole(
          "[post] 流式超分启动：" +
            ev.sourceWidth +
            "x" +
            ev.sourceHeight +
            " → " +
            ev.outWidth +
            "x" +
            ev.outHeight +
            " · " +
            String(ev.device || "") +
            " / " +
            String(ev.precision || "") +
            " · tile " +
            ev.tile +
            " · 音轨 " +
            (ev.audio ? "直拷" : "无"),
        );
        emitProgress({
          phase: "post",
          nodeId,
          message:
            "流式超分：" +
            ev.sourceWidth +
            "x" +
            ev.sourceHeight +
            " → " +
            ev.outWidth +
            "x" +
            ev.outHeight +
            " · " +
            String(ev.device || "") +
            " · tile " +
            ev.tile,
          pct: 2,
        });
      } else if (ev.type === "progress") {
        const frames = Number(ev.frames) || 0;
        const frame = Number(ev.frame) || 0;
        emitProgress({
          phase: "post",
          nodeId,
          message:
            "流式超分 " +
            frame +
            "/" +
            frames +
            " 帧 · 峰值内存 " +
            gb1((Number(ev.peakRamMb) || 0) / 1024) +
            "G" +
            (Number(ev.peakVramMb)
              ? " · 显存 " + gb1((Number(ev.peakVramMb) || 0) / 1024) + "G"
              : ""),
          pct: Math.max(2, Math.min(99, Math.round(Number(ev.pct) || 0))),
        });
      } else if (ev.type === "done" || ev.type === "error") {
        last = ev;
      } else {
        appendConsole("[post][stream] " + t);
      }
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (c) => {
      stdoutBuf += c;
      let i;
      while ((i = stdoutBuf.indexOf("\n")) >= 0) {
        const line = stdoutBuf.slice(0, i);
        stdoutBuf = stdoutBuf.slice(i + 1);
        onLine(line);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c) => {
      stderrTail = (stderrTail + c).slice(-4000);
      for (const ln of String(c).split(/\r?\n/)) {
        if (ln.trim()) appendConsole("[post][stream] " + ln.trim());
      }
    });
    child.on("error", (e) => {
      clearInterval(poll);
      if (activeGenerate && activeGenerate.nodeId === nodeId) activeGenerate.streamKill = null;
      reject(e);
    });
    child.on("close", (code) => {
      clearInterval(poll);
      if (activeGenerate && activeGenerate.nodeId === nodeId) activeGenerate.streamKill = null;
      if (stdoutBuf.trim()) onLine(stdoutBuf);
      const streamCancelled =
        killed ||
        code === 4 ||
        (last && last.error === "cancelled") ||
        (activeGenerate && activeGenerate.abort);
      if (streamCancelled) {
        const err = new Error("cancelled");
        err.streamCancelled = true;
        reject(err);
        return;
      }
      const outPath = String((last && last.output) || j.outPath || "");
      if (code === 0 && last && last.type === "done" && last.ok && outPath && fs.existsSync(outPath)) {
        let bytes = 0;
        try {
          bytes = fs.statSync(outPath).size || 0;
        } catch {}
        resolve({
          path: outPath,
          bytes,
          frames: Number(last.frames) || 0,
          seconds: Number(last.seconds) || 0,
          peakRamMb: Number(last.peakRamMb) || 0,
          peakVramMb: Number(last.peakVramMb) || 0,
        });
        return;
      }
      /* 没出成片：不留半成品（取消 / OOM / 失败都清掉；脚本自身也会尽力删一遍），
       * 交回上层决定是降档重试还是回退图路径。 */
      if (outPath) {
        try {
          if (fs.existsSync(outPath)) fs.rmSync(outPath, { force: true });
        } catch {}
      }
      const msg =
        (last && last.message) || stderrTail.trim() || "stream_upscale.py 退出码 " + code;
      const err = new Error("stream_upscale_failed: " + String(msg).slice(0, 800));
      err.code = code;
      err.detail = String(msg).slice(0, 800);
      err.oom = code === 3 || !!(last && last.error === "oom") || isPostOomError(msg);
      reject(err);
    });
  });
}

/**
 * 逐帧流式补帧：spawn ComfyUI venv python 跑 h3-pack/post/stream_interp.py。
 * 常驻内存只与「相邻两帧 + 模型」有关、与时长/总帧数无关（见脚本头注释），
 * 所以 16G 机器也能对 15 秒级视频做 2x / 4x 补帧（旧图链要把整段帧张量攒在 RAM 里）。
 * 入参：{ py, script, nodeId, sourcePath, outPath, modelPath, comfyRoot, multiplier,
 *         maxLongSide, scaleFactor, precision, clearCacheEvery, crf, preset, fps }
 * 进度：脚本 stdout 每帧一行 JSON（meta / progress / done / error）→ emitProgress。
 * 取消：activeGenerate.abort（用户停止 / 释放显存）→ 向子进程 stdin 写 cancel 后杀掉；
 *      脚本自己会删半成品（退出码 4）。
 * 成功 resolve { path, bytes, frames, seconds, peakRamMb, peakVramMb }；
 * 失败 reject（err.oom = true 表示显存/内存不足，供上层降档重试）。
 */
function runStreamInterpJob(job) {
  const j = job || {};
  const nodeId = String(j.nodeId || "");
  return new Promise((resolve, reject) => {
    const args = [
      String(j.script),
      "--input",
      String(j.sourcePath),
      "--output",
      String(j.outPath),
      "--multiplier",
      String(Math.max(1, Math.round(Number(j.multiplier) || 2))),
      "--max-long-side",
      String(Math.max(0, Math.round(Number(j.maxLongSide) || 0))),
      "--scale-factor",
      String(Number(j.scaleFactor) || 1.0),
      "--precision",
      String(j.precision || "fp16"),
      "--clear-cache-every",
      String(Math.max(1, Math.round(Number(j.clearCacheEvery) || 1))),
      "--crf",
      String(Math.max(0, Math.round(Number(j.crf) || POST_STREAM_DEFAULT_CRF))),
      "--preset",
      String(j.preset || POST_STREAM_DEFAULT_PRESET),
      "--progress-every",
      "1",
    ];
    /* 权重：宿主已探到就显式给（免脚本再 stat 一遍）；同时兜 --comfy-root 让脚本自己也能找 */
    if (j.modelPath) args.push("--model", String(j.modelPath));
    if (j.comfyRoot) args.push("--comfy-root", String(j.comfyRoot));
    if (Number(j.fps) > 0) args.push("--fps", String(Number(j.fps)));
    appendConsole("[post] $ " + [String(j.py), ...args].join(" "));

    const env = Object.assign({}, process.env, {
      PYTHONIOENCODING: "utf-8",
      PYTHONUNBUFFERED: "1",
      MALLOC_ARENA_MAX: process.env.MALLOC_ARENA_MAX || "1",
    });
    if (j.comfyRoot) env.MTNODE_COMFY_ROOT = String(j.comfyRoot);
    let child;
    try {
      child = spawn(String(j.py), args, {
        cwd: path.dirname(String(j.script)) || undefined,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        env,
      });
    } catch (e) {
      reject(e);
      return;
    }

    let stdoutBuf = "";
    let stderrTail = "";
    let last = null; /* 最后一条 done / error 回执 */
    let killed = false;
    const killChild = (why) => {
      if (killed) return;
      killed = true;
      appendConsole("[post] 流式补帧收到停止信号（" + String(why || "cancel") + "）→ 终止子进程");
      try {
        child.stdin.write("cancel\n");
      } catch {}
      try {
        child.kill();
      } catch {}
    };
    if (activeGenerate && activeGenerate.nodeId === nodeId) activeGenerate.streamKill = killChild;
    const poll = setInterval(() => {
      if (activeGenerate && activeGenerate.abort) killChild("activeGenerate.abort");
    }, 300);

    const onLine = (line) => {
      const t = String(line || "").trim();
      if (!t) return;
      let ev = null;
      try {
        ev = JSON.parse(t);
      } catch {
        appendConsole("[post][stream] " + t);
        return;
      }
      if (!ev || typeof ev !== "object") return;
      if (ev.type === "meta") {
        appendConsole(
          "[post] 流式补帧启动：" +
            ev.sourceWidth +
            "x" +
            ev.sourceHeight +
            " · " +
            ev.multiplier +
            "x · RIFE " +
            String(ev.arch || "") +
            " · " +
            String(ev.device || "") +
            " / " +
            String(ev.precision || "") +
            " · 音轨 " +
            (ev.audio ? "直拷" : "无"),
        );
        emitProgress({
          phase: "post",
          nodeId,
          message:
            "流式补帧：" +
            ev.sourceWidth +
            "x" +
            ev.sourceHeight +
            " · " +
            ev.multiplier +
            "x · RIFE " +
            String(ev.arch || "") +
            " · " +
            String(ev.device || ""),
          pct: 2,
        });
      } else if (ev.type === "progress") {
        const frames = Number(ev.frames) || 0;
        const frame = Number(ev.frame) || 0;
        emitProgress({
          phase: "post",
          nodeId,
          message:
            "流式补帧 " +
            frame +
            "/" +
            frames +
            " 帧 · 已出 " +
            (Number(ev.outFrames) || 0) +
            " 帧 · 峰值内存 " +
            gb1((Number(ev.peakRamMb) || 0) / 1024) +
            "G" +
            (Number(ev.peakVramMb)
              ? " · 显存 " + gb1((Number(ev.peakVramMb) || 0) / 1024) + "G"
              : ""),
          pct: Math.max(2, Math.min(99, Math.round(Number(ev.pct) || 0))),
        });
      } else if (ev.type === "done" || ev.type === "error") {
        last = ev;
      } else {
        appendConsole("[post][stream] " + t);
      }
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (c) => {
      stdoutBuf += c;
      let i;
      while ((i = stdoutBuf.indexOf("\n")) >= 0) {
        const line = stdoutBuf.slice(0, i);
        stdoutBuf = stdoutBuf.slice(i + 1);
        onLine(line);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c) => {
      stderrTail = (stderrTail + c).slice(-4000);
      for (const ln of String(c).split(/\r?\n/)) {
        if (ln.trim()) appendConsole("[post][stream] " + ln.trim());
      }
    });
    child.on("error", (e) => {
      clearInterval(poll);
      if (activeGenerate && activeGenerate.nodeId === nodeId) activeGenerate.streamKill = null;
      reject(e);
    });
    child.on("close", (code) => {
      clearInterval(poll);
      if (activeGenerate && activeGenerate.nodeId === nodeId) activeGenerate.streamKill = null;
      if (stdoutBuf.trim()) onLine(stdoutBuf);
      const streamCancelled =
        killed ||
        code === 4 ||
        (last && last.error === "cancelled") ||
        (activeGenerate && activeGenerate.abort);
      if (streamCancelled) {
        const err = new Error("cancelled");
        err.streamCancelled = true;
        reject(err);
        return;
      }
      const outPath = String((last && last.output) || j.outPath || "");
      if (code === 0 && last && last.type === "done" && last.ok && outPath && fs.existsSync(outPath)) {
        let bytes = 0;
        try {
          bytes = fs.statSync(outPath).size || 0;
        } catch {}
        resolve({
          path: outPath,
          bytes,
          frames: Number(last.frames) || 0,
          seconds: Number(last.seconds) || 0,
          peakRamMb: Number(last.peakRamMb) || 0,
          peakVramMb: Number(last.peakVramMb) || 0,
        });
        return;
      }
      /* 没出成片：不留半成品（取消 / OOM / 失败都清掉；脚本自身也会尽力删一遍），
       * 交回上层决定是降档重试还是回退图路径。 */
      if (outPath) {
        try {
          if (fs.existsSync(outPath)) fs.rmSync(outPath, { force: true });
        } catch {}
      }
      const msg =
        (last && last.message) || stderrTail.trim() || "stream_interp.py 退出码 " + code;
      const err = new Error("stream_interp_failed: " + String(msg).slice(0, 800));
      err.code = code;
      err.detail = String(msg).slice(0, 800);
      err.oom = code === 3 || !!(last && last.error === "oom") || isPostOomError(msg);
      reject(err);
    });
  });
}

let getDataDir = null;
let getMainWin = null;
let appRoot = null;
let getDsh = null;
let consoleWin = null;
let loadedUiStamp = ""; /* 管理窗当前已加载的 UI 指纹，变了就该 reload 而不是继续显示旧页面 */
/** Console 停靠面板：consolePaneW = 页面报来的面板宽度（0 = 收起），
 *  consolePaneApplied = 宿主真的往左撑开了多少像素（可能被屏幕边缘钳小）。
 *  收起时按 applied 还回去，窗口才不会走偏。 */
let consolePaneW = 0;
let consolePaneApplied = 0;
let installing = false;
let installCancel = false;
let gpuTimer = null;
/** @type {import('child_process').ChildProcess|null} */
let backendProc = null;
/** @type {{ nodeId: string, abort?: boolean, promptId?: string, req?: import('http').ClientRequest|null }|null} */
let activeGenerate = null;
/** 本次进程内是否已为「带 --cpu-vae 启动失败」记过那条指回技能的提示（关闭 CPU VAE 后重新武装）。 */
let cpuVaeFailHinted = false;

/** dsh.run 鉴权：复用 MTNode 设置里的模型 API Key（非环境变量 / 非强制 deepseek-official）。 */
function h3DshAuthOrError() {
  const auth = resolveDshRunAuth(getDataDir());
  if (!auth.ok) return auth;
  return {
    ok: true,
    runFields: {
      model: auth.model,
      maxTokens: auth.maxTokens,
      apiKey: auth.apiKey,
      baseUrl: auth.baseUrl,
      webSearchApiKey: auth.webSearchApiKey,
      provider: auth.provider,
      mtnodeProviders: auth.mtnodeProviders,
    },
  };
}

function join(...a) {
  return path.join(...a);
}
function mk(p) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}
function h3Root() {
  return mk(join(getDataDir(), "h3"));
}
function configPath() {
  return join(h3Root(), "config.json");
}
function installedMetaPath() {
  return join(h3Root(), "installed.json");
}
function pidPath() {
  return join(h3Root(), "backend-pid.json");
}
function consoleLogPath() {
  return join(h3Root(), "console.log");
}
function bundledPackRoot() {
  if (app.isPackaged) {
    const fromRes = join(process.resourcesPath, "h3-pack");
    if (fs.existsSync(fromRes)) return fromRes;
  }
  return join(appRoot || path.join(__dirname, ".."), "h3-pack");
}
function runtimePackRoot() {
  return join(h3Root(), "runtime");
}
function packVersionAt(dir) {
  try {
    const man = readJson(join(dir, "manifest.json"), null);
    return String((man && man.version) || "") || "";
  } catch {
    return "";
  }
}
function packRoot() {
  const bundled = bundledPackRoot();
  const runtime = runtimePackRoot();
  const rtVer = fs.existsSync(join(runtime, "manifest.json")) ? packVersionAt(runtime) : "";
  const bdVer = fs.existsSync(join(bundled, "manifest.json")) ? packVersionAt(bundled) : "";
  if (rtVer && bdVer && verGt(bdVer, rtVer)) return bundled;
  if (rtVer) return runtime;
  return bundled;
}
function uiEntry() {
  const packed = join(h3Root(), "ui", "index.html");
  if (fs.existsSync(packed)) return packed;
  return join(__dirname, "ui", "index.html");
}

function readJson(p, fb) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fb;
  }
}
function writeJson(p, v) {
  mk(path.dirname(p));
  const tmp = p + ".tmp" + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(v, null, 2), "utf8");
  fs.renameSync(tmp, p);
}

function defaultConfig() {
  return {
    installDir: "",
    port: DEFAULT_PORT,
    cudaPython: "",
    wantRunning: false,
    /* 24G 启动优化：默认开，可在插件控制台关闭 */
    /** CPU VAE 默认关：开启会让 VideoVAE 解码 dtype 崩（float != c10::Half），南风 H3 链不可用。
     *  真源见技能 skills/minimax-h3-install/SKILL.md「启动参数」。老用户 config.json 里显式存过的
     *  true 由 loadConfig 的合并保持原值，升级不静默翻转。 */
    cpuVae: false,
    optDisablePinnedMemory: true,
    optFp16Intermediates: true,
    optExpandableSegments: true,
    optReserveVramGb: 4,
    /* 后端 BLAS / OpenMP 线程上限：0 = 不改环境变量（留给想自己调的机器）。
     * 默认 8：线程池每个线程都有自己的 malloc arena 与缓冲，超分链的大块张量被摊在
     * 多份缓存里就再也回不到系统 —— 这是「内存持续攀升」的第二个来源。 */
    optArenaThreads: 8,
    /* ComfyUI 系统内存（RAM）缓存保留下限，单位 GB；0 = 不加 --cache-ram（退回归服务默认）。
     * 默认 8：超分链要在 RAM 里攒整段视频的帧张量，不给上限时 ComfyUI 会把中间产物留到
     * 128G 才放，64G 机器必被跑满（而显存空着）。见 POST_CACHE_RAM_ACTIVE_GB 注释。 */
    optCacheRamGb: POST_CACHE_RAM_ACTIVE_GB,
    /* 内存护栏：任务之间发现「服务守住的内存 > 一半内存」或本机已低于硬闸 → 重启后端回收。
     * 默认开：常驻的 Python 进程跑几单 4K 超分 / 补帧后 RSS 只涨不落，不回收就会一单比一单紧。
     * 关掉 = 只靠 --cache-ram 与提交前内存闸（单次峰值照旧压，进程本身不再重启）。 */
    optRebuildOnRamHigh: true,
  };
}
function loadConfig() {
  return Object.assign(defaultConfig(), readJson(configPath(), {}) || {});
}
function saveConfig(partial) {
  const next = Object.assign(loadConfig(), partial || {});
  writeJson(configPath(), next);
  return next;
}

function readManifest() {
  try {
    return readJson(join(packRoot(), "manifest.json"), {}) || {};
  } catch {
    return {};
  }
}

function syncScaffoldToInstall(installDir) {
  const root = String(installDir || "").trim();
  if (!root || !fs.existsSync(root)) return { ok: false, error: "no_install_dir" };
  const pack = packRoot();
  try {
    const srcApp = join(pack, "app");
    if (fs.existsSync(srcApp)) {
      const destApp = join(root, "app");
      mk(destApp);
      for (const name of fs.readdirSync(srcApp)) {
        if (!name.endsWith(".py")) continue;
        const s = join(srcApp, name);
        if (!fs.statSync(s).isFile()) continue;
        fs.copyFileSync(s, join(destApp, name));
      }
      try {
        const pyc = join(destApp, "__pycache__");
        if (fs.existsSync(pyc)) fs.rmSync(pyc, { recursive: true, force: true });
      } catch {}
    }
    const scriptsSrc = join(pack, "scripts");
    if (fs.existsSync(scriptsSrc)) {
      const dest = join(root, "scripts");
      mk(dest);
      for (const name of fs.readdirSync(scriptsSrc)) {
        const s = join(scriptsSrc, name);
        if (!fs.statSync(s).isFile()) continue;
        fs.copyFileSync(s, join(dest, name));
      }
    }
    for (const name of ["requirements.txt", "start_backend.cmd", "README.md"]) {
      const s = join(pack, name);
      if (fs.existsSync(s) && fs.statSync(s).isFile()) fs.copyFileSync(s, join(root, name));
    }
    appendConsole("[sync] scaffold → " + root);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

let remoteManCache = { at: 0, man: null };
let remoteManPending = null;
let runtimeUpdating = false;

function catalogCachedPluginVersion() {
  try {
    const p = join(getDataDir(), "app-plugins", "catalog.json");
    const doc = readJson(p, null);
    const list = (doc && doc.plugins) || [];
    const hit = list.find(
      (x) => x && (x.id === PLUGIN_ID || x.handler === "h3" || x.kind === "h3"),
    );
    return String((hit && hit.version) || "") || "";
  } catch {
    return "";
  }
}

async function latestRemoteVersion() {
  if (remoteManPending) return remoteManPending;
  remoteManPending = (async () => {
    try {
      const man = await fetchRemoteManifest(H3_FEED, 8000);
      if (man && typeof man === "object") {
        remoteManCache = { at: Date.now(), man };
        return String(man.version || "");
      }
    } catch {}
    return String((remoteManCache.man && remoteManCache.man.version) || "");
  })();
  try {
    return await remoteManPending;
  } finally {
    remoteManPending = null;
  }
}

async function updatePluginRuntime() {
  if (runtimeUpdating) return { ok: false, error: "busy" };
  runtimeUpdating = true;
  try {
    const dest = runtimePackRoot();
    const r = await downloadRuntimeTo({
      feedBase: H3_FEED,
      destDir: dest,
      onProgress: (ev) => {
        emitProgress({
          phase: "update",
          step: ev.phase || "update",
          stepLabel:
            ev.phase === "download"
              ? "下载脚手架"
              : ev.phase === "extract"
                ? "解压安装"
                : ev.phase === "manifest"
                  ? "读取清单"
                  : "更新插件",
          message: ev.version ? "v" + ev.version : "",
          pct: Number(ev.pct) || 0,
        });
      },
    });
    const cfg = loadConfig();
    if (cfg.installDir) syncScaffoldToInstall(cfg.installDir);
    try {
      syncH3InstallSkill();
    } catch {}
    const man = readManifest();
    writeJson(installedMetaPath(), {
      ok: true,
      version: (r && r.version) || (man && man.version) || "0.0.0",
      installDir: cfg.installDir || "",
      updatedAt: new Date().toISOString(),
      source: (r && r.source) || H3_FEED,
    });
    appendConsole("[update] runtime v" + ((r && r.version) || "") + " → " + dest);
    emitProgress({ phase: "update", step: "done", stepLabel: "完成", pct: 100 });
    return { ok: true, version: (r && r.version) || "" };
  } catch (e) {
    const msg = String((e && e.message) || e);
    appendConsole("[update] failed: " + msg);
    emitProgress({ phase: "update", step: "error", message: msg, pct: 0, error: true });
    reportErr("runtime_update_failed", "插件运行时更新失败：" + msg, { phase: "update" });
    return { ok: false, error: msg };
  } finally {
    runtimeUpdating = false;
  }
}

function appendConsole(line) {
  try {
    const p = consoleLogPath();
    mk(path.dirname(p));
    fs.appendFileSync(p, String(line).replace(/\r?\n$/, "") + "\n", "utf8");
    const st = fs.statSync(p);
    if (st.size > 2 * 1024 * 1024) {
      const raw = fs.readFileSync(p, "utf8");
      fs.writeFileSync(p, raw.slice(-1024 * 1024), "utf8");
    }
  } catch {}
  broadcast("h3:console", { line: String(line) });
}

function broadcast(channel, payload) {
  for (const w of BrowserWindow.getAllWindows()) {
    try {
      if (!w.isDestroyed()) w.webContents.send(channel, payload);
    } catch {}
  }
}

function emitProgress(ev) {
  broadcast("h3:progress", Object.assign({ id: PLUGIN_ID, ts: Date.now() }, ev || {}));
}

/**
 * 失败上报：控制台窗内的 toast 只有开着那只窗的人看得到，节点状态也只有一行字。
 * 这里把同一次失败送到报错总线，让主窗口出一份带日志尾部的报告（总线内部吞异常）。
 * extra 里可带 phase / nodeId / workflowId（= 画布 id），报告靠它归因到出问题的节点。
 */
function reportErr(code, message, extra) {
  try {
    pluginErrors.reportPluginError(
      PLUGIN_ID,
      Object.assign({ code, message: String(message || "") }, extra || {}),
    );
  } catch {}
}

function isAlivePid(pid) {
  const n = Number(pid);
  if (!n || !isFinite(n)) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch {
    return false;
  }
}

function comfyDir(installDir) {
  const root = String(installDir || "").trim();
  if (!root) return "";
  const nested = join(root, "ComfyUI");
  if (fs.existsSync(join(nested, "main.py"))) return nested;
  if (fs.existsSync(join(root, "main.py"))) return root;
  return nested;
}

function modelExists(comfy, relParts) {
  const p = join(comfy, ...relParts);
  try {
    return fs.existsSync(p) && fs.statSync(p).size > 1e6;
  } catch {
    return false;
  }
}

/* ===== 交付要件清单（安装 / 保底修复 / 自我修复三支共用同一份）=====
 * Agent 按提示词逐项交付，缺项就是交付缺项：提示词与收尾判定必须同源，否则提示词形同虚设。 */
/** 随包本地节点包（由 setup_env.ps1 的 Deploy-LocalCustomNode 部署到 ComfyUI\custom_nodes 下） */
const NANFENG_NODE_PKG = "nanfeng_prompt_nodes_v10";
/** 4K 超分补帧推荐链必须存在的 custom_nodes 目录 */
const REQUIRED_CUSTOM_NODE_DIRS = ["ComfyUI-KJNodes", "ComfyUI-Frame-Interpolation"];
/** TeaCache 已从推荐链移除（只保留 EasyCache 步缓存）：装不装都不算交付缺项 */
const OPTIONAL_CUSTOM_NODE_DIRS = ["ComfyUI-MiniMaxH3-TeaCache"];

function dirExists(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** 目录内普通文件数（不递归）；目录不存在记 0。 */
function countDirFiles(dir) {
  try {
    let n = 0;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.isFile()) n += 1;
    }
    return n;
  } catch {
    return 0;
  }
}

/** 随包本地节点包是否「完整部署」：包目录在 + web/ 在 + 至少一个 *.api.py。
 *  南风包 __init__.py 的 WEB_DIRECTORY="./web" 指向 web/，*.api.py 注册 /nanfeng/* 等后端路由，
 *  缺任一项 ComfyUI 启动即报插件注册 / 前端加载错误，所以不能只看包目录存在。 */
function localCustomNodeOk(comfy, name) {
  const dir = join(String(comfy || ""), "custom_nodes", String(name || ""));
  if (!dirExists(dir)) return false;
  if (!dirExists(join(dir, "web"))) return false;
  try {
    return fs.readdirSync(dir).some((f) => /\.api\.py$/i.test(f));
  } catch {
    return false;
  }
}

function projectSignals(dir) {
  const root = String(dir || "").trim();
  if (!root) {
    return {
      exists: false,
      scaffold: false,
      venv: false,
      models: false,
      hasPost: false,
      nanfeng: false,
      latentFiles: 0,
      customNodes: false,
      ready: false,
      installComplete: false,
    };
  }
  const scaffold =
    fs.existsSync(join(root, "app", "pipeline.py")) ||
    fs.existsSync(join(root, "scripts", "setup_env.ps1")) ||
    fs.existsSync(join(root, "ComfyUI", "main.py")) ||
    fs.existsSync(join(root, "main.py"));
  const comfy = comfyDir(root);
  const venv = !!(comfy && fs.existsSync(join(comfy, "venv", "Scripts", "python.exe")));
  const models =
    !!comfy &&
    modelExists(comfy, ["models", "diffusion_models", MODELS.fl2va]) &&
    modelExists(comfy, ["models", "text_encoders", MODELS.clip]) &&
    modelExists(comfy, ["models", "vae", MODELS.vaeVideo]);
  const hasRef = !!comfy && modelExists(comfy, ["models", "diffusion_models", MODELS.ref2va]);
  /* 4K 超分补帧后处理就绪：Real-ESRGAN + RIFE 模型都在 */
  const hasPost =
    !!comfy &&
    modelExists(comfy, ["models", "upscale_models", POST_MODELS.upscale]) &&
    modelExists(comfy, [
      "custom_nodes",
      "ComfyUI-Frame-Interpolation",
      "ckpts",
      "rife",
      POST_MODELS.rife,
    ]);
  /* 随包本地节点包：必须完整部署（web/ + *.api.py），否则南风工作流整条链起不来 */
  const nanfeng = localCustomNodeOk(comfy, NANFENG_NODE_PKG);
  /* 南风节点把 latent_upscale_models 的 combo 声明为 required：目录空 = /prompt 直接被拒，
   * 占位文件即可（幂等，真实模型在也算命中） */
  const latentFiles = comfy ? countDirFiles(join(comfy, "models", "latent_upscale_models")) : 0;
  /* 4K 超分补帧推荐链的 custom_nodes 清单（KJNodes 分块上采样 + Frame-Interpolation RIFE） */
  const customNodes =
    !!comfy && REQUIRED_CUSTOM_NODE_DIRS.every((n) => dirExists(join(comfy, "custom_nodes", n)));
  return {
    exists: fs.existsSync(root),
    scaffold,
    venv,
    models,
    hasRef2va: hasRef,
    hasPost,
    nanfeng,
    latentFiles,
    customNodes,
    ready: scaffold && venv && models,
    /* 交付要件是否齐（不含 torch 版本 / comfy_kitchen / soundfile 这类要跑 python 的硬校验，
     * 那些由 healthCheckInstall 的 `python -m app` 收尾判定兜） */
    installComplete: scaffold && venv && models && hasPost && nanfeng && latentFiles >= 1 && customNodes,
    comfyDir: comfy || "",
  };
}

/** 交付缺项（中文条目，用于收尾失败时的 reason / console / 进度文案）。空数组 = 文件层面要件齐。 */
function installDeliverableGaps(sig) {
  const s = sig || {};
  const gaps = [];
  if (!s.scaffold) gaps.push("脚手架缺失（app/scripts/ComfyUI 都没有）");
  if (!s.venv) gaps.push("ComfyUI\\venv 不存在（隔离 venv 未建）");
  if (!s.models) gaps.push("主模型权重不全（diffusion_models/" + MODELS.fl2va + "、text_encoders、vae）");
  if (!s.nanfeng) {
    gaps.push(
      "custom_nodes/" + NANFENG_NODE_PKG + " 未完整部署（需包目录 + web/ + *.api.py，Deploy-LocalCustomNode）",
    );
  }
  if (!(Number(s.latentFiles || 0) >= 1)) gaps.push("models/latent_upscale_models 为空（南风节点必填 combo，占位文件即可）");
  if (!s.customNodes) gaps.push("custom_nodes 缺 " + REQUIRED_CUSTOM_NODE_DIRS.join(" + "));
  if (!s.hasPost) {
    gaps.push(
      "后处理权重不全（models/upscale_models/" + POST_MODELS.upscale + "、ComfyUI-Frame-Interpolation/ckpts/rife/" + POST_MODELS.rife + "）",
    );
  }
  return gaps;
}

function isSafeInstallDir(dir) {
  const raw = String(dir || "").trim();
  if (!raw) return { ok: false, error: "empty_dir" };
  const resolved = path.resolve(raw);
  const norm = resolved.replace(/[/\\]+$/, "");
  const rootMatch = /^[a-zA-Z]:\\?$/.test(norm) || norm === "/" || /^\\\\[^\\]+\\[^\\]+$/.test(norm);
  if (rootMatch) return { ok: false, error: "refuse_root" };
  const banned = [
    path.resolve("C:\\Windows"),
    path.resolve("C:\\Program Files"),
    path.resolve("C:\\Program Files (x86)"),
    path.resolve(process.env.SystemRoot || "C:\\Windows"),
  ];
  for (const b of banned) {
    if (norm.toLowerCase() === b.toLowerCase() || norm.toLowerCase().startsWith(b.toLowerCase() + path.sep)) {
      return { ok: false, error: "refuse_system" };
    }
  }
  return { ok: true, path: norm };
}

function freeDiskGb(dir) {
  return new Promise((resolve) => {
    try {
      if (process.platform !== "win32") return resolve(null);
      const drive = path.parse(path.resolve(dir)).root.replace(/\\/g, "");
      execFile(
        "powershell.exe",
        ["-NoProfile", "-Command", `(Get-PSDrive -Name '${drive.replace(":", "")}').Free / 1GB`],
        { windowsHide: true, timeout: 8000 },
        (err, stdout) => {
          if (err) return resolve(null);
          const n = parseFloat(String(stdout || "").trim());
          resolve(isFinite(n) ? Math.round(n * 10) / 10 : null);
        },
      );
    } catch {
      resolve(null);
    }
  });
}

function copyDirRecursive(src, dest, skipNames) {
  const skip = new Set(skipNames || [".venv", "ComfyUI", "models", "output", "__pycache__", ".git"]);
  mk(dest);
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    if (skip.has(ent.name)) continue;
    const s = join(src, ent.name);
    const d = join(dest, ent.name);
    if (ent.isDirectory()) copyDirRecursive(s, d, skip);
    else {
      mk(path.dirname(d));
      fs.copyFileSync(s, d);
    }
  }
}

/** 递归列出目录里的文件相对路径（统一用 "/" 分隔，便于比较）。 */
function listRelFiles(dir) {
  const out = [];
  let ents = [];
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of ents) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) {
      for (const r of listRelFiles(p)) out.push(ent.name + "/" + r);
    } else out.push(ent.name);
  }
  return out.sort();
}

/** 运行时 UI 副本的内容指纹（文件名 + 大小 + mtime）。 */
function uiRuntimeStamp(dir) {
  try {
    const parts = listRelFiles(dir).map((rel) => {
      let size = 0;
      let mt = 0;
      try {
        const s = fs.statSync(join(dir, ...rel.split("/")));
        size = s.size;
        mt = Math.round(s.mtimeMs);
      } catch {}
      return rel + "|" + size + "|" + mt;
    });
    return crypto.createHash("sha1").update(parts.join("\n")).digest("hex").slice(0, 12);
  } catch {
    return "";
  }
}

/**
 * 把随包的 h3/ui 同步到可写数据目录（管理窗实际从这里加载）。
 * 只在内容真的不同时写盘，并返回 { changed }：openConsoleWindow 靠它决定要不要
 * reload 一个已经开着的窗口。不刷新就会出现「改了 UI 但界面照旧」——旧页面里弹窗
 * 样式已坏时，那个卸载确认框就永远关不掉。
 */
function ensureUiRuntime() {
  const srcUi = join(__dirname, "ui");
  const destUi = join(h3Root(), "ui");
  if (!fs.existsSync(srcUi)) return { changed: false, files: 0 };
  let changed = false;
  const rels = listRelFiles(srcUi);
  for (const rel of rels) {
    const s = join(srcUi, ...rel.split("/"));
    const d = join(destUi, ...rel.split("/"));
    let a = null;
    let b = null;
    try {
      a = fs.readFileSync(s);
    } catch {
      continue;
    }
    try {
      b = fs.readFileSync(d);
    } catch {}
    if (!b || !a.equals(b)) {
      mk(path.dirname(d));
      try {
        fs.copyFileSync(s, d);
        changed = true;
      } catch {}
    }
  }
  /* 源码里已经删掉的旧文件也要从副本里清掉，否则残留一份永远加载不到的死页面 */
  for (const rel of listRelFiles(destUi)) {
    if (rels.indexOf(rel) >= 0) continue;
    try {
      fs.rmSync(join(destUi, ...rel.split("/")), { force: true });
      changed = true;
    } catch {}
  }
  return { changed, files: rels.length };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function sleepAbortable(ms) {
  const step = 200;
  return new Promise((resolve, reject) => {
    let left = Math.max(0, Number(ms) || 0);
    const tick = () => {
      if (activeGenerate && activeGenerate.abort) {
        reject(new Error("cancelled"));
        return;
      }
      if (left <= 0) {
        resolve();
        return;
      }
      const wait = Math.min(step, left);
      left -= wait;
      setTimeout(tick, wait);
    };
    tick();
  });
}

/** ComfyUI WS 真实进度（采样步 / 当前节点）；不可用则返回 null。 */
function openComfyProgressWs(port, clientId, nodeId) {
  const WS = typeof WebSocket !== "undefined" ? WebSocket : null;
  if (!WS) {
    appendConsole("[progress] WebSocket unavailable — history poll only");
    return null;
  }
  let ws = null;
  let lastPct = 15;
  try {
    ws = new WS(`ws://127.0.0.1:${Number(port)}/ws?clientId=${encodeURIComponent(clientId)}`);
  } catch (e) {
    appendConsole("[progress] ws open failed: " + String((e && e.message) || e));
    return null;
  }
  ws.onmessage = (ev) => {
    let msg = null;
    try {
      msg = JSON.parse(String(ev.data || ""));
    } catch {
      return;
    }
    if (!msg || !msg.type) return;
    if (msg.type === "progress" && msg.data) {
      const v = Number(msg.data.value) || 0;
      const max = Math.max(1, Number(msg.data.max) || 1);
      lastPct = Math.min(92, 15 + Math.floor((v / max) * 75));
      emitProgress({
        phase: "generate",
        nodeId,
        message: "采样 " + v + "/" + max,
        pct: lastPct,
        progress: { value: v, max },
      });
    } else if (msg.type === "executing") {
      const n = msg.data && msg.data.node;
      emitProgress({
        phase: "generate",
        nodeId,
        message: n ? "执行节点 " + n : "排队中…",
        pct: lastPct,
      });
    }
  };
  ws.onerror = () => {};
  return {
    close() {
      try {
        ws.close();
      } catch {}
    },
  };
}

function attachAbortableReq(req) {
  if (!activeGenerate) return;
  activeGenerate.req = req;
  const clear = () => {
    if (activeGenerate && activeGenerate.req === req) activeGenerate.req = null;
  };
  req.on("close", clear);
  req.on("error", clear);
}

function destroyActiveGenerateReq() {
  if (!activeGenerate || !activeGenerate.req) return;
  try {
    activeGenerate.req.destroy(new Error("cancelled"));
  } catch {}
  activeGenerate.req = null;
}

function httpJson(method, url, body, timeoutMs, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = body != null ? JSON.stringify(body) : null;
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        headers: data
          ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) }
          : {},
        timeout: timeoutMs || 30000,
      },
      (res) => {
        let buf = "";
        let settled = false;
        const finish = (fn) => {
          if (settled) return;
          settled = true;
          fn();
        };
        res.on("data", (c) => {
          buf += c;
          if (opts.track !== false && activeGenerate && activeGenerate.abort) {
            try {
              req.destroy();
            } catch {}
            finish(() => reject(new Error("cancelled")));
          }
        });
        res.on("end", () => {
          finish(() => {
            try {
              resolve({ status: res.statusCode, json: JSON.parse(buf), raw: buf });
            } catch {
              resolve({ status: res.statusCode, json: null, raw: buf });
            }
          });
        });
      },
    );
    if (opts.track !== false) attachAbortableReq(req);
    req.on("error", (e) => {
      if (opts.track !== false && activeGenerate && activeGenerate.abort)
        reject(new Error("cancelled"));
      else reject(e);
    });
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
    if (data) req.write(data);
    req.end();
  });
}

async function interruptComfy(port, promptId) {
  const p = Number(port) || DEFAULT_PORT;
  const base = `http://127.0.0.1:${p}`;
  appendConsole("[cancel] comfy interrupt" + (promptId ? " prompt=" + promptId : ""));
  try {
    await httpJson("POST", `${base}/interrupt`, {}, 8000, { track: false });
  } catch {}
  const pid = String(promptId || "").trim();
  if (pid) {
    try {
      await httpJson(
        "POST",
        `${base}/queue`,
        { delete: [pid] },
        8000,
        { track: false },
      );
    } catch {}
  }
  try {
    await httpJson("POST", `${base}/queue`, { clear: true }, 8000, { track: false });
  } catch {}
}

async function probeComfy(port) {
  const p = Number(port) || DEFAULT_PORT;
  try {
    const r = await httpJson("GET", `http://127.0.0.1:${p}/system_stats`, null, 2500);
    return !!(r && r.status >= 200 && r.status < 500);
  } catch {
    return false;
  }
}

function loadPidMeta() {
  return readJson(pidPath(), null);
}
function savePidMeta(meta) {
  writeJson(pidPath(), meta);
}
function clearPidMeta() {
  try {
    if (fs.existsSync(pidPath())) fs.unlinkSync(pidPath());
  } catch {}
}

function backendRunning() {
  const meta = loadPidMeta();
  if (meta && isAlivePid(meta.pid)) return true;
  if (backendProc && backendProc.pid && !backendProc.killed) return true;
  return false;
}

function queryGpu() {
  return new Promise((resolve) => {
    execFile(
      "nvidia-smi",
      ["--query-gpu=name,memory.used,memory.total,utilization.gpu", "--format=csv,noheader,nounits"],
      { windowsHide: true, timeout: 4000 },
      (err, stdout) => {
        if (err) return resolve(null);
        const lines = String(stdout || "")
          .trim()
          .split(/\r?\n/)
          .filter((l) => l.trim() && !/no devices were found/i.test(l));
        if (!lines.length) return resolve(null);
        const num = (s) => {
          const n = Number(String(s == null ? "" : s).trim());
          return Number.isFinite(n) ? n : null;
        };
        const cards = [];
        for (const line of lines) {
          const parts = line.split(",").map((s) => s.trim());
          if (parts.length < 4) continue;
          const memUsed = num(parts[1]);
          const memTotal = num(parts[2]);
          const util = num(parts[3]);
          /* 显存/利用率取不到（[N/A]、ERR!）时按 null 处理，绝不把 NaN 发给界面 */
          if (memUsed == null && memTotal == null && util == null) continue;
          cards.push({
            index: cards.length,
            name: parts[0] || "",
            memUsed,
            memTotal,
            util,
            memPct:
              memTotal != null && memTotal > 0 && memUsed != null
                ? Math.round((memUsed / memTotal) * 1000) / 10
                : null,
          });
        }
        if (!cards.length) return resolve(null);
        /* 多卡时取占用最高的一张（生成实际发生在那张卡上），并标出是第几号卡 */
        cards.sort((a, b) => (b.memUsed || 0) - (a.memUsed || 0));
        const g = cards[0];
        if (cards.length > 1 && g.name) g.name = g.name + " · GPU" + g.index;
        resolve(g);
      },
    );
  });
}

function startGpuPolling() {
  if (gpuTimer) return;
  gpuTimer = setInterval(async () => {
    const gpu = await queryGpu();
    if (gpu) broadcast("h3:gpu", gpu);
  }, 2000);
  if (gpuTimer.unref) gpuTimer.unref();
}
function stopGpuPolling() {
  if (gpuTimer) {
    clearInterval(gpuTimer);
    gpuTimer = null;
  }
}

async function statusForUi() {
  const cfg = loadConfig();
  const man = readManifest();
  const sig = projectSignals(cfg.installDir);
  const installedMeta = readJson(installedMetaPath(), null);
  const port = Number(cfg.port) || DEFAULT_PORT;
  const comfyUp = await probeComfy(port);
  const lock = refreshStaleLock();
  let gpu = null;
  try {
    gpu = await queryGpu();
  } catch {
    gpu = null;
  }
  const version = (man && man.version) || (installedMeta && installedMeta.version) || "1.0.0";
  const feedVer = await latestRemoteVersion();
  const catVer = catalogCachedPluginVersion();
  const latestVersion = verMax(feedVer, catVer) || feedVer || catVer || "";
  const updateAvailable = !!(feedVer && verGt(feedVer, version));
  return {
    ok: true,
    id: PLUGIN_ID,
    version,
    latestVersion,
    feedVersion: feedVer || "",
    catalogVersion: catVer || "",
    updateAvailable,
    updating: runtimeUpdating,
    diskHintGb: DISK_HINT_GB,
    installDir: cfg.installDir || "",
    project: sig,
    /* Sage 加速自检结果（读缓存；过期只后台补探，不堵状态刷新）：管理窗据此提示点「Sage 加速」 */
    sage: readSageProbe(cfg.installDir),
    installed: !!(installedMeta && installedMeta.ok) || sig.ready,
    installing,
    running: backendRunning() || comfyUp,
    comfyUp,
    consoleOpen: !!(consoleWin && !consoleWin.isDestroyed()),
    port,
    comfyUrl: comfyUiUrl(port),
    lock,
    gpu,
    wantRunning: !!cfg.wantRunning,
    /* 与 defaultConfig 同口径：默认关，只回显显式配置值（老用户存过 true 仍是 true） */
    cpuVae: !!cfg.cpuVae,
    optDisablePinnedMemory: cfg.optDisablePinnedMemory !== false,
    optFp16Intermediates: cfg.optFp16Intermediates !== false,
    optExpandableSegments: cfg.optExpandableSegments !== false,
    optReserveVramGb: Number(cfg.optReserveVramGb) > 0 ? Number(cfg.optReserveVramGb) : 4,
    optCacheRamGb: Number(cfg.optCacheRamGb) > 0 ? Math.round(Number(cfg.optCacheRamGb)) : 0,
    /* 内存护栏开关 + 最近一次回收时间：管理窗据此显示「服务进程已经回收过没有」 */
    optRebuildOnRamHigh: cfg.optRebuildOnRamHigh !== false,
    optArenaThreads: Number(cfg.optArenaThreads) > 0 ? Math.round(Number(cfg.optArenaThreads)) : 0,
    lastRecycleAt: Number(cfg.lastRecycleAt) > 0 ? Number(cfg.lastRecycleAt) : 0,
    memRail: comfyRamStatsCache.ram || null,
    consolePath: consoleLogPath(),
  };
}

function runPs(scriptPath, args, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    const psArgs = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, ...(args || [])];
    appendConsole(`$ powershell ${psArgs.join(" ")}`);
    const child = spawn("powershell.exe", psArgs, {
      cwd: opts.cwd || path.dirname(scriptPath),
      windowsHide: true,
      env: Object.assign({}, process.env, opts.env || {}),
    });
    let out = "";
    child.stdout.on("data", (d) => {
      const s = d.toString();
      out += s;
      for (const line of s.split(/\r?\n/)) {
        if (line.trim()) appendConsole(line);
      }
      if (opts.onLine) opts.onLine(s);
      const m = s.match(/(\d+(?:\.\d+)?)\s*%/);
      if (m && opts.onPct) opts.onPct(Number(m[1]));
    });
    child.stderr.on("data", (d) => {
      const s = d.toString();
      out += s;
      for (const line of s.split(/\r?\n/)) {
        if (line.trim()) appendConsole("[err] " + line);
      }
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (installCancel) return reject(new Error("cancelled"));
      if (code !== 0) reject(new Error(`exit ${code}: ${out.slice(-800)}`));
      else resolve(out);
    });
  });
}

async function installProject(opts) {
  opts = opts || {};
  if (installing) {
    reportErr("busy", "H3 已有安装 / 修复任务在跑，本次安装被拒", { phase: "install" });
    return { ok: false, error: "busy" };
  }
  const cfg = loadConfig();
  const safe = isSafeInstallDir(cfg.installDir);
  if (!safe.ok) return { ok: false, error: safe.error || "bad_dir" };
  const installDir = safe.path;
  mk(installDir);

  installing = true;
  installCancel = false;
  try {
    emitProgress({
      phase: "install",
      step: "disk",
      stepLabel: "检查磁盘空间",
      message: `建议预留 ≥${DISK_HINT_GB}GB`,
      pct: 3,
    });
    const free = await freeDiskGb(installDir);
    if (free != null && free < DISK_HINT_GB && !opts.force) {
      installing = false;
      reportErr("low_disk", `磁盘剩余约 ${free}GB，建议预留 ≥${DISK_HINT_GB}GB（模型约 42–65GB）`, {
        phase: "install",
      });
      return {
        ok: false,
        error: "low_disk",
        freeGb: free,
        needGb: DISK_HINT_GB,
        message: `磁盘剩余约 ${free}GB，建议预留 ≥${DISK_HINT_GB}GB（模型约 42–65GB）`,
        agentRecoverable: false,
      };
    }
    appendConsole(`disk free≈${free}GB (hint ≥${DISK_HINT_GB}GB)`);
    appendConsole("[install] primary path = Agent（脚手架仅作参考）");
    installing = false;
    return await agentInstallByAgent({ mode: "install" });
  } catch (e) {
    installing = false;
    const msg = String((e && e.message) || e);
    appendConsole("install failed: " + msg);
    emitProgress({ phase: "install", step: "error", message: msg, pct: 0, error: true });
    reportErr(msg, msg, { phase: "install" });
    return { ok: false, error: msg, agentRecoverable: msg !== "cancelled" && msg !== "busy" };
  }
}

function writeScaffoldRef(installDir) {
  const pack = packRoot();
  const refFile = join(installDir, ".scaffold-ref");
  try {
    fs.writeFileSync(refFile, pack + "\n", "utf8");
  } catch (e) {
    appendConsole("[scaffold-ref] warn: " + String((e && e.message) || e));
  }
  return pack;
}

function syncH3InstallSkill() {
  try {
    if (getDsh) {
      const dsh = getDsh();
      if (dsh && typeof dsh.syncInstallSkills === "function") dsh.syncInstallSkills();
    }
  } catch {}
  try {
    const skillSrc = join(
      appRoot || path.join(__dirname, ".."),
      "skills",
      "minimax-h3-install",
      "SKILL.md",
    );
    const dshHome = join(getDataDir(), "dsh-home", "skills", "minimax-h3-install");
    if (fs.existsSync(skillSrc)) {
      mk(dshHome);
      fs.copyFileSync(skillSrc, join(dshHome, "SKILL.md"));
      fs.writeFileSync(join(dshHome, ".install-only"), "1\n");
    }
  } catch {}
}

/**
 * Agent 主导安装 / 修复。脚手架包路径仅写入 .scaffold-ref 供 Agent 参考，不强制复制。
 */
async function agentInstallByAgent(opts) {
  opts = opts || {};
  const mode = opts.mode === "recover" ? "recover" : "install";
  if (installing) return { ok: false, error: "busy" };
  const cfg = loadConfig();
  const safe = isSafeInstallDir(cfg.installDir);
  if (!safe.ok) return { ok: false, error: safe.error || "bad_dir" };
  const installDir = safe.path;
  mk(installDir);

  if (!getDsh) return { ok: false, error: "no_dsh" };
  let dsh;
  try {
    dsh = getDsh();
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
  if (!dsh || typeof dsh.run !== "function") return { ok: false, error: "no_dsh" };

  const auth = h3DshAuthOrError();
  if (!auth.ok) {
    appendConsole("[agent-install] " + auth.error);
    return { ok: false, error: auth.error };
  }

  installing = true;
  installCancel = false;
  const failReason = String(opts.error || opts.reason || "");
  const marker = join(installDir, ".install-ok");
  try {
    if (fs.existsSync(marker)) fs.unlinkSync(marker);
  } catch {}

  const pack = writeScaffoldRef(installDir);
  syncH3InstallSkill();

  const stepLabel = mode === "recover" ? "Agent 保底修复" : "Agent 安装";
  emitProgress({
    phase: "install",
    step: mode === "recover" ? "agent_recover" : "agent_install",
    stepLabel,
    message: mode === "recover" ? "Agent 正在诊断并完成安装…" : "Agent 正在安装（脚手架仅作参考）…",
    pct: 12,
  });
  appendConsole(`[agent-install] mode=${mode}` + (failReason ? " reason=" + failReason : ""));
  appendConsole("[agent-install] llm route: " + auth.runFields.provider);
  appendConsole("[agent-install] SCAFFOLD_REF=" + pack + "（仅参考，勿当作已安装）");

  const workspace = mk(installDir);
  const reqId = "h3-" + mode + "-" + Date.now();
  const resultMarker = join(installDir, ".h3-agent-result");
  try {
    if (fs.existsSync(resultMarker)) fs.unlinkSync(resultMarker);
  } catch {}

  /* 三支（install / recover / selfRepair）共用同一份交付要件清单：Agent 按提示词逐项交付，
   * 提示词缺项 = 交付缺项，所以这里每一条都对应收尾判定（installDeliverableGaps / healthCheckInstall）。 */
  const venvPyRel = "ComfyUI\\venv\\Scripts\\python.exe";
  const requirements = [
    `1) 探测本机可用 CUDA Python，写入 ${join(installDir, ".cuda-python")}（单行绝对路径）。`,
    `2) 建立【隔离】ComfyUI venv（禁止 --system-site-packages），在 venv 内装 CUDA torch 与依赖（参考 SCAFFOLD_REF\\scripts\\setup_env.ps1 / repair_torch_kitchen.ps1 / patch_comfy_kitchen_typing.py）。`,
    `3) torch 版本硬校验：venv 内 torch.__version__ 必须 ≥ 2.9.1 且带 cu130（2.9.1+cu130 或更高的 cu130 构建）。` +
      `2.6.0+cu124 / cu126 一律不合格——ComfyUI 能启动但 comfy_kitchen 的 cuda backend 会被 disabled，首个 denoise forward 永久卡死。` +
      `自检（必须打印 ok）：${venvPyRel} -c "import torch;assert torch.cuda.is_available();assert 'cu130' in torch.__version__;import comfy_kitchen;print('ok',torch.__version__,torch.__file__)"；` +
      `并确认 torch.__file__ 落在 ComfyUI\\venv 内、comfy_kitchen 未被 disabled。`,
    `4) 自检 venv 内 import soundfile 成功（南风节点音频链依赖，已列在 SCAFFOLD_REF\\requirements.txt）：` +
      `${venvPyRel} -c "import soundfile;print(soundfile.__version__)"。装不上就是交付缺项，要补到成功为止。`,
    `5) 下载/就绪模型权重（参考 SCAFFOLD_REF\\scripts\\download_models.ps1）：` +
      `models\\diffusion_models\\${MODELS.fl2va}、models\\text_encoders\\${MODELS.clip}、models\\vae\\${MODELS.vaeVideo}。`,
    `6) ComfyUI\\models\\latent_upscale_models 必须 ≥1 个文件（南风节点把它声明成 required combo，空目录会让整单 /prompt 被 value_not_in_list 拒）。` +
      `缺就补一个合法的空 safetensors 占位（口径见 setup_env.ps1 的 Ensure-LatentUpscalePlaceholder：8 字节长度头 + "{}"），幂等；` +
      `目录里已有文件（含用户自己的真实放大模型）一律不删不改。`,
    `7) 后处理权重各就各位（4K 超分 + 补帧）：${POST_MODELS.upscale} → ComfyUI\\models\\upscale_models\\；` +
      `${POST_MODELS.rife} → ComfyUI\\custom_nodes\\ComfyUI-Frame-Interpolation\\ckpts\\rife\\。`,
    `8) ComfyUI\\custom_nodes 清单必须含 ${REQUIRED_CUSTOM_NODE_DIRS.join(" + ")}` +
      `（前者供分块上采样，后者供 RIFE 补帧）；${OPTIONAL_CUSTOM_NODE_DIRS.join(" + ")} 标注为备用（推荐链已移除 TeaCache，只保留 EasyCache 步缓存），没装不算失败。`,
    `9) 部署随包本地节点包 ${NANFENG_NODE_PKG}：按 setup_env.ps1 的 Deploy-LocalCustomNode 口径，` +
      `从 INSTALL_DIR\\custom_nodes\\${NANFENG_NODE_PKG} 复制进 ComfyUI\\custom_nodes\\${NANFENG_NODE_PKG}，` +
      `**必须保留 web\\ 目录与所有 *.api.py**（__init__.py 的 WEB_DIRECTORY="./web" 指向 web\\，*.api.py 注册 /nanfeng/* 后端路由；缺任一项启动即报插件注册 / 前端加载错）。` +
      `幂等：只补该包，不清空 custom_nodes 下其它节点。`,
    `10) 冒烟：venv python 下 import comfy_kitchen 与 torch.cuda 可用（即第 3 条那条命令），不要为此启动 ComfyUI 服务。`,
    `11) 注意力加速（「安装」流程要覆盖这一项）：给 venv 补装 triton-windows + 与本 venv 配套的 sageattention 预编译 wheel —— ` +
      `口径见 skill「可选依赖」一节（PyPI 上只有老的 sageattention 1.0.6，2.x 走 woct0rdho/SageAttention 的 release wheel，` +
      `文件名里的 cuNNN / torchX 必须对上本机 CUDA 大版本与 torch 版本）。装完用 venv python 跑 import triton + import sageattention 自检。`,
    `12) 收尾前自己先跑一次健康检查并在回复里带上退出码：在 INSTALL_DIR 下执行 ${venvPyRel} -m app ` +
      `（它打印 venv / 模型 / postModels / cuda 的 JSON 报告），退出码 0 才算完成。` +
      `插件收尾还会再跑一次同样的检查，缺项迟早被判失败，别为了交差先写 ok=true。`,
  ].join("\n");
  const disciplines =
    `纪律（四条，一律遵守）：不要启动 ComfyUI；不要删除用户 output/；模型已齐则勿重下（只补缺的）；` +
    `Sage 加速（第 11 条）装不上不算失败——跳过即可，画布生成会自动退回非 Sage 链（只是慢 1.5-2×），已探测到可用则勿重复装。\n`;
  const handoff =
    `成功后：创建空文件 ${marker}，写入 ${resultMarker}（首行 ok=true，可附 reason= 摘要），回复 install_ok=1 与 cuda_python=<path> torch_file=<path> health_exit=0。\n` +
    `失败则 ${resultMarker} 写 ok=false 与 reason=<上面哪一条没交付 + 具体报错>`;

  const prompt = opts.selfRepair
    ? `请使用 skill「minimax-h3-install」的【自我修复】模式。\n` +
      `当前工作区（可写）= INSTALL_DIR=${installDir}\n` +
      `SCAFFOLD_REF=${pack}（仅参考）\n` +
      `任务：阅读下方 CONSOLE 日志，由你自行分析判断根因并完成修复。每人环境不同，不要套用不匹配的固定剧本。\n` +
      `skill 中「已知故障」仅当日志证据确实匹配时参考。优先修依赖/脚本/配置。\n` +
      (failReason ? `\n先前失败原因 / CONSOLE：\n${failReason}\n` : "") +
      `修复完成后，下面这份交付要件必须【逐条】成立（缺一条就是没修好），已满足的直接跳过：\n` +
      requirements +
      `\n` +
      disciplines +
      `成功后：创建空文件 ${marker}，写入 ${resultMarker}（首行 ok=true，可附 reason=已修复…），回复 repair_ok=1 与简要根因。\n` +
      `失败则 ${resultMarker} 写 ok=false 与 reason=<上面哪一条没交付 + 具体报错>`
    : `请使用 skill「minimax-h3-install」${
        mode === "recover" ? "完成或修复安装（保底修复；用户已确认）" : "端到端完成安装（主安装路径）"
      }。\n` +
      `当前工作区（可写）= INSTALL_DIR=${installDir}\n` +
      `SCAFFOLD_REF=${pack}\n` +
      `重要：内置脚手架/脚本仅作参考实现。请以 skill 目标为准自行准备 INSTALL_DIR（可按需从 SCAFFOLD_REF 复制或改写 app/scripts/requirements，也可等价实现）。不要假设插件已替你复制好脚手架。\n` +
      (failReason ? `先前失败原因 / CONSOLE：\n${failReason}\n` : "") +
      `要求（逐条交付，收尾会按这些判定）：\n` +
      requirements +
      `\n` +
      disciplines +
      handoff;

  try {
    appendConsole("[agent-install] workspace=" + workspace + " permission=danger-full-access");
    await dsh.run({
      reqId,
      workspace,
      input: prompt,
      preset: "standard",
      permissionPreset: "danger-full-access",
      ...auth.runFields,
    });
  } catch (e) {
    installing = false;
    const msg = String((e && e.message) || e);
    appendConsole("[agent-install] dsh.run failed: " + msg);
    emitProgress({ phase: "install", step: "error", message: msg, pct: 0, error: true });
    reportErr(msg, msg, { phase: "install" });
    return { ok: false, error: msg };
  }

  const deadline = Date.now() + 45 * 60 * 1000;
  let lastPct = 15;
  while (Date.now() < deadline) {
    if (installCancel) {
      try {
        dsh.cancel({ reqId });
      } catch {}
      installing = false;
      emitProgress({ phase: "install", step: "error", message: "cancelled", pct: 0, error: true });
      reportErr("cancelled", "安装已取消", { phase: "install" });
      return { ok: false, error: "cancelled" };
    }
    const sig = projectSignals(installDir);
    let marked = false;
    let agentSaidFail = null;
    try {
      marked = fs.existsSync(marker);
    } catch {}
    try {
      if (fs.existsSync(resultMarker)) {
        const raw = fs.readFileSync(resultMarker, "utf8");
        if (/^ok\s*=\s*false/im.test(raw)) {
          agentSaidFail = ((raw.match(/reason\s*=\s*(.+)/i) || [])[1] || "agent_reported_failure").trim();
        }
      }
    } catch {}
    if (agentSaidFail) {
      installing = false;
      emitProgress({ phase: "install", step: "error", message: agentSaidFail, pct: 0, error: true });
      reportErr(agentSaidFail, agentSaidFail, { phase: "install" });
      return { ok: false, error: agentSaidFail };
    }
    /* 收尾失败一律把 reason= 回写 .h3-agent-result（UI 与事后排查看同一份）。 */
    const failWith = (reason, extra) => {
      try {
        fs.writeFileSync(resultMarker, "ok=false\nreason=" + reason + "\n", "utf8");
      } catch {}
      try {
        dsh.cancel({ reqId });
      } catch {}
      installing = false;
      appendConsole("[agent-install] " + reason);
      emitProgress({ phase: "install", step: "error", message: reason, pct: 0, error: true });
      reportErr(reason, reason, { phase: "install" });
      return Object.assign({ ok: false, error: reason }, extra || {});
    };
    const gaps = installDeliverableGaps(sig);
    lastPct = Math.min(92, lastPct + 1);
    emitProgress({
      phase: "install",
      step: mode === "recover" ? "agent_recover" : "agent_install",
      stepLabel,
      message:
        marked || sig.installComplete
          ? gaps.length
            ? "收尾校验：交付还缺「" + gaps[0] + "」…"
            : "收尾校验：跑 python -m app 健康检查…"
          : sig.models
            ? "模型已就绪，等待收尾…"
            : sig.venv
              ? "环境已就绪，下载/校验模型中…"
              : mode === "recover"
                ? "Agent 正在修复安装…"
                : "Agent 正在安装…",
      pct: lastPct,
      subPct: sig.installComplete ? 100 : sig.models ? 80 : sig.venv ? 45 : 20,
    });
    /* 成功判定不再只看 .install-ok：先按交付要件清单核文件，再在 INSTALL_DIR 内跑一次
     * python -m app 健康检查，退出码 0 才算 ready（超时 / 非 0 一律按 reason= 判失败）。 */
    let hcOk = false;
    if (sig.installComplete || marked) {
      if (gaps.length) {
        if (marked) return failWith("deliverable_missing: " + gaps.join("；"), { missingDeliverables: gaps });
      } else {
        const hc = await healthCheckInstall(installDir);
        if (!hc.ok) {
          return failWith(
            "health_check_failed: " +
              (hc.reason || "exit_not_zero") +
              (hc.out ? " | " + hc.out.replace(/\s+/g, " ").trim().slice(-400) : ""),
          );
        }
        hcOk = true;
        appendConsole("[agent-install] health check ok（python -m app 退出码 0）");
      }
    }
    if (hcOk) {
      let cudaPython = cfg.cudaPython || "";
      try {
        const cp = join(installDir, ".cuda-python");
        if (fs.existsSync(cp)) cudaPython = fs.readFileSync(cp, "utf8").trim().split(/\r?\n/)[0] || cudaPython;
      } catch {}
      if (cudaPython) saveConfig({ cudaPython });
      const man = readManifest();
      writeJson(installedMetaPath(), {
        ok: true,
        version: (man && man.version) || "1.0.0",
        installDir,
        installedAt: new Date().toISOString(),
        installedByAgent: true,
        recoveredByAgent: mode === "recover",
      });
      try {
        dsh.cancel({ reqId });
      } catch {}
      installing = false;
      emitProgress({
        phase: "install",
        step: "done",
        message: mode === "recover" ? "Agent 保底安装完成" : "Agent 安装完成",
        pct: 100,
      });
      appendConsole("[agent-install] success");
      invalidateSageProbe();
      ensureSageProbe(installDir);
      return {
        ok: true,
        installDir,
        installedByAgent: true,
        recoveredByAgent: mode === "recover",
        version: (man && man.version) || "1.0.0",
      };
    }
    await sleep(3000);
  }

  try {
    dsh.cancel({ reqId });
  } catch {}
  installing = false;
  const msg = "agent_install_timeout";
  appendConsole("[agent-install] " + msg);
  emitProgress({ phase: "install", step: "error", message: msg, pct: 0, error: true });
  reportErr(msg, "Agent 安装超时（45 分钟未交付）：" + msg, { phase: "install" });
  return { ok: false, error: msg };
}

/** IPC 兼容：失败后的 Agent 再试 */
async function agentRecoverInstall(opts) {
  return agentInstallByAgent(Object.assign({}, opts || {}, { mode: "recover" }));
}

/**
 * 从 console 提取「最近失败焦点」+ 尾部上下文，供 dsh 自行分析（不做本地定论）。
 */
function extractConsoleForAgent(logText) {
  const raw = String(logText || "");
  const lines = raw.split(/\r?\n/);
  const markers = [];
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    if (
      /!!! Exception during processing !!!/i.test(L) ||
      /ModuleNotFoundError:/i.test(L) ||
      /ImportError:/i.test(L) ||
      /ValueError:/i.test(L) ||
      /\[job\] error:/i.test(L) ||
      /\[job\] backend start failed/i.test(L) ||
      /backend_exited/i.test(L) ||
      /^Traceback \(most recent call last\):/i.test(L)
    ) {
      markers.push(i);
    }
  }
  const start = markers.length ? markers[markers.length - 1] : Math.max(0, lines.length - 80);
  const focus = lines.slice(Math.max(0, start - 5), Math.min(lines.length, start + 50)).join("\n");
  const recentTail = lines.slice(-120).join("\n");
  return { focus, recentTail, markerLine: start };
}

function comfyVenvPython(installDir) {
  const py = join(String(installDir || ""), "ComfyUI", "venv", "Scripts", "python.exe");
  return fs.existsSync(py) ? py : "";
}

function runVenvPy(py, code) {
  return new Promise((resolve) => {
    const child = spawn(py, ["-c", code], { windowsHide: true });
    let out = "";
    child.stdout.on("data", (d) => {
      out += d.toString();
    });
    child.stderr.on("data", (d) => {
      out += d.toString();
    });
    child.on("close", (c) => resolve({ code: c || 0, out }));
    child.on("error", (e) => resolve({ code: 1, out: String((e && e.message) || e) }));
  });
}

/**
 * 收尾健康检查：在 INSTALL_DIR 内再跑一次 python -m app（脚手架 app/__main__.py 打印
 * venv / 模型 / postModels / cuda 的 JSON 报告，退出码 0 = 可信）。
 * 光认 .install-ok 会被 Agent 的一面之词放过，所以 ready 必须以这里为准。
 * 解释器优先 ComfyUI venv python，退回 .cuda-python 记录的解释器，再退回系统 python。
 * 返回 { ok, reason, out }；超时按失败处理。
 */
function healthCheckInstall(installDir, timeoutMs) {
  return new Promise((resolve) => {
    const root = String(installDir || "").trim();
    if (!root) return resolve({ ok: false, reason: "health_check_no_dir", out: "" });
    let py = comfyVenvPython(root);
    if (!py) {
      try {
        const cp = join(root, ".cuda-python");
        if (fs.existsSync(cp)) py = fs.readFileSync(cp, "utf8").trim().split(/\r?\n/)[0] || "";
      } catch {}
    }
    if (!py) py = "python";
    const ms = Math.max(30000, Number(timeoutMs) || 300000);
    let out = "";
    let settled = false;
    let child;
    try {
      child = spawn(py, ["-m", "app"], { cwd: root, windowsHide: true });
    } catch (e) {
      return resolve({ ok: false, reason: "health_check_spawn_failed: " + String((e && e.message) || e), out: "" });
    }
    const finish = (ok, reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok, reason, out: out.slice(-2000) });
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
      finish(false, "health_check_timeout_" + Math.round(ms / 1000) + "s");
    }, ms);
    if (timer.unref) timer.unref();
    child.stdout.on("data", (d) => {
      out += d.toString();
    });
    child.stderr.on("data", (d) => {
      out += d.toString();
    });
    child.on("error", (e) => finish(false, "health_check_error: " + String((e && e.message) || e)));
    child.on("close", (c) => finish(c === 0, c === 0 ? "" : "health_check_exit_" + c));
  });
}

/**
 * 自我修复：把 console 日志交给 dsh Agent 自行分析并修复（每人环境不同，不做本地定论短路）。
 */
async function selfRepairFromConsole(opts) {
  opts = opts || {};
  const cfg = loadConfig();
  const safe = isSafeInstallDir(cfg.installDir);
  if (!safe.ok) return { ok: false, error: safe.error || "bad_dir" };

  const tail = consoleTail(Number(opts.maxBytes) || 96 * 1024);
  const logText = String((tail && tail.text) || "").trim();
  if (!logText) {
    return {
      ok: false,
      error: "empty_console",
      message: "console 日志为空，请先运行一次生成或安装以产生日志",
    };
  }

  appendConsole("[self-repair] begin · console bytes≈" + logText.length + " → dsh");
  try {
    await stopBackend();
  } catch (e) {
    appendConsole("[self-repair] stop warn: " + String((e && e.message) || e));
  }

  const extracted = extractConsoleForAgent(logText);
  appendConsole("[self-repair] focus @line=" + extracted.markerLine);
  appendConsole("[self-repair] focus preview:\n" + String(extracted.focus || "").slice(0, 800));

  const hint =
    "【自我修复任务 · 由你（dsh）分析日志并修复】\n" +
    "每人环境与报错可能不同：请根据日志自行判断根因并动手修复，不要套用不匹配的旧故障剧本。\n" +
    "以「最近失败焦点」为准；更早的 Traceback 可能已过时，仅作参考。\n" +
    "skill「minimax-h3-install」中的已知故障章节仅当日志证据匹配时才可参考。\n" +
    "不要盲目重装已就绪的模型；不要启动 ComfyUI；不要删除 output/。\n\n" +
    "=== 最近失败焦点 ===\n```\n" +
    String(extracted.focus || "").slice(0, 10000) +
    "\n```\n\n" +
    "=== console 最近尾部（更多上下文） ===\n```\n" +
    String(extracted.recentTail || "").slice(0, 12000) +
    "\n```\n";

  const r = await agentInstallByAgent({
    mode: "recover",
    error: hint,
    selfRepair: true,
  });
  appendConsole("[self-repair] dsh done ok=" + !!(r && r.ok) + " err=" + ((r && r.error) || ""));
  return Object.assign({}, r || {}, {
    selfRepair: true,
    via: "dsh",
    consoleBytes: logText.length,
  });
}

function lastConsoleErrorSnippet(maxChars) {
  const n = Math.max(800, Number(maxChars) || 2400);
  try {
    const t = consoleTail(64 * 1024);
    const raw = String((t && t.text) || "");
    if (!raw.trim()) return "";
    const lines = raw.split(/\r?\n/);
    const errIdx = [...lines.keys()].reverse().find((i) =>
      /Traceback|Error:|ValueError|ModuleNotFoundError|ImportError|CUDA|backend_exited/i.test(
        lines[i],
      ),
    );
    if (errIdx == null) return raw.slice(-Math.min(n, raw.length));
    const slice = lines.slice(Math.max(0, errIdx - 8), Math.min(lines.length, errIdx + 40)).join("\n");
    return slice.length > n ? slice.slice(-n) : slice;
  } catch {
    return "";
  }
}

function killPidTree(pid) {
  return new Promise((resolve) => {
    if (!pid) return resolve();
    if (process.platform === "win32") {
      execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => resolve());
    } else {
      try {
        process.kill(pid, "SIGTERM");
      } catch {}
      resolve();
    }
  });
}

async function stopBackend() {
  const meta = loadPidMeta();
  const pid = (meta && meta.pid) || (backendProc && backendProc.pid);
  appendConsole("stopping backend pid=" + pid);
  if (backendProc) {
    try {
      backendProc.kill();
    } catch {}
    backendProc = null;
  }
  await killPidTree(pid);
  clearPidMeta();
  saveConfig({ wantRunning: false });
  clearLock();
  activeGenerate = null;
  return { ok: true };
}

/**
 * 回收后端进程（内存护栏的动手那一步）：
 *   · 与 stopBackend 的区别是**不改 wantRunning / 不等用户点启动** —— 它只在服务本该继续
 *     待命时做一次「重启」：先把 pid 记下来、存好 wantRunning，停掉，再在后台重新拉起，
 *     重拉失败就报一条可读日志交给下次任务自己启动（不阻塞调用方、不影响任务回执）。
 *   · 只允许在任务之间调用；waitBackendIdle + 二次确认（锁与 activeGenerate 都空）之内
 *     才会真的杀进程，绝不打断别的任务。
 * 调用方拿到的是「有没有动手」的布尔值，回执已经发完，所以这里 await 的只是「空闲」。
 */
async function recycleBackendForRam(reason) {
  const cfg = loadConfig();
  const port = Number(cfg.port) || DEFAULT_PORT;
  if (!backendRunning() && !(await probeComfy(port))) return false;
  if (!(await waitBackendIdle(30000))) {
    appendConsole("[mem] 内存护栏：连 30 秒都没等到空闲，本次不回收（下个任务之间再试）");
    return false;
  }
  if (refreshStaleLock() || activeGenerate) return false; /* 二次确认：刚又有任务进来了 */
  appendConsole("[mem] 内存护栏：回收后端进程" + (reason ? " —— " + reason : ""));
  await stopBackend();
  saveConfig({ wantRunning: !!cfg.wantRunning, lastRecycleAt: Date.now() });
  if (!cfg.wantRunning) return true;
  setTimeout(() => {
    startBackend()
      .then((r) => {
        appendConsole(
          r && r.ok
            ? "[mem] 后端已重启待命 :" + (Number(r.port) || port) + "（内存已回收，下次任务直接复用）"
            : "[mem] 后端重启失败：" + String((r && r.error) || "unknown") + "（下次任务会自行拉起）",
        );
      })
      .catch((e) => appendConsole("[mem] 后端重启异常：" + String((e && e.message) || e)));
  }, 300);
  return true;
}

/** 任务用：确保 ComfyUI 可用 */
async function ensureBackendReadyForJob() {
  /* ① 先用后端自己报的内存事实看一眼：跑过多轮 4K 超分 / 补帧的服务进程 RSS 只涨不落，
   *    第 N 单比第 2 单的可用内存少得多（见 POST_MEM_RAIL_* 注释）。
   *    空闲内存已经低于硬闸、又确实是「量到的水位偏低」时，先回收再干活 —— 与其在
   *    一台被自己撑小的机器上再挤一单，不如花一次重载把内存要回来。 */
  const cfg0 = loadConfig();
  const port0 = Number(cfg0.port) || DEFAULT_PORT;
  const active0 = refreshStaleLock() || !!activeGenerate; /* 有任务在跑就绝不动后端 */
  if (backendRunning() && !active0 && cfg0.optRebuildOnRamHigh !== false) {
    const ram = await probeComfyRamStats(port0);
    if (ram.free != null && ram.total != null) {
      const verdict = ramRailVerdict(ram.free, ram.free, ram.total);
      if (verdict.tightNow) {
        await recycleBackendForRam(
          "启动任务前本机只剩 " +
            verdict.afterGb +
            "G / 共 " +
            verdict.totalGb +
            "G（低于硬闸），先回收服务进程再跑",
        );
      }
    }
  }
  const started = await startBackend();
  if (!started || !started.ok) {
    const err = (started && started.error) || "backend_start_failed";
    const detail = String((started && started.message) || "");
    reportErr(err, detail || err, { phase: "job" });
    return {
      ok: false,
      error: err,
      message: detail,
    };
  }
  const port = Number(started.port) || Number(loadConfig().port) || DEFAULT_PORT;
  if (await probeComfy(port)) return { ok: true, port, reused: !!started.reused };
  const deadline = Date.now() + 300000;
  appendConsole("[job] waiting for comfy on :" + port);
  while (Date.now() < deadline) {
    if (await probeComfy(port)) {
      appendConsole("[job] comfy ready :" + port);
      return { ok: true, port };
    }
    await sleep(2000);
    const meta = loadPidMeta();
    if (meta && meta.pid && !isAlivePid(meta.pid) && !meta.external) {
      const snip = lastConsoleErrorSnippet(1800);
      reportErr("backend_exited", "ComfyUI 进程退出" + (snip ? "：\n" + snip : ""), { phase: "job" });
      return {
        ok: false,
        error: "backend_exited",
        message:
          "ComfyUI 进程退出" +
          (snip ? "：\n" + snip.replace(/\x1b\[[0-9;]*m/g, "") : ""),
      };
    }
  }
  const snip = lastConsoleErrorSnippet(1200);
  reportErr("backend_start_timeout", "等待 ComfyUI 就绪超时" + (snip ? "；最近日志：\n" + snip : ""), {
    phase: "job",
  });
  return {
    ok: false,
    error: "backend_start_timeout",
    message:
      "等待 ComfyUI 就绪超时" +
      (snip ? "；最近日志：\n" + snip.replace(/\x1b\[[0-9;]*m/g, "") : ""),
  };
}

/** 带 --cpu-vae 启动失败：在 console 记一条指回技能的提示（同一次进程只记一次，
 *  关掉 CPU VAE 后重新武装）。默认已关，会走到这里说明是老配置显式开了它。 */
function noteCpuVaeLaunchFailure(why) {
  if (cpuVaeFailHinted) return;
  cpuVaeFailHinted = true;
  appendConsole(
    "[warn] 本次后端启动带了 --cpu-vae 且未能就绪" +
      (why ? "（" + why + "）" : "") +
      "。CPU VAE 开启会让 VideoVAE 解码 dtype 崩（expected m1 and m2 to have the same dtype, " +
      "but got: float != struct c10::Half），南风 H3 链（nanfeng_prompt_nodes_v10）直接不可用。" +
      "请在控制台「24G 启动优化」区取消勾选 CPU VAE 再重启后端；口径见技能 minimax-h3-install「启动参数」。"
  );
}

async function startBackend() {
  const cfg = loadConfig();
  const safe = isSafeInstallDir(cfg.installDir);
  if (!safe.ok) return { ok: false, error: safe.error || "bad_dir" };
  const installDir = safe.path;
  const sig = projectSignals(installDir);
  if (!sig.scaffold) {
    reportErr("not_installed", "H3 后端尚未安装：找不到 ComfyUI 脚手架", { phase: "start" });
    return { ok: false, error: "not_installed" };
  }
  if (!sig.venv) {
    reportErr("no_venv", "H3 后端缺少 Python 环境（ComfyUI\\venv）", { phase: "start" });
    return { ok: false, error: "no_venv" };
  }

  const port = Number(cfg.port) || DEFAULT_PORT;
  if (await probeComfy(port)) {
    const meta = loadPidMeta();
    if (!meta || !isAlivePid(meta.pid)) {
      savePidMeta({ pid: 0, port, external: true, startedAt: Date.now() });
    }
    saveConfig({ wantRunning: true });
    appendConsole("comfy already up on :" + port);
    return { ok: true, reused: true, port };
  }

  const meta = loadPidMeta();
  if (meta && isAlivePid(meta.pid)) {
    saveConfig({ wantRunning: true });
    const waitUntil = Date.now() + 300000;
    appendConsole("backend pid alive, waiting for comfy :" + port);
    while (Date.now() < waitUntil) {
      if (await probeComfy(port)) {
        appendConsole("comfy ready (reused pid) :" + port);
        return { ok: true, reused: true, port, pid: meta.pid };
      }
      await sleep(2000);
      if (!isAlivePid(meta.pid)) {
        appendConsole("backend pid died while waiting for comfy");
        clearPidMeta();
        break;
      }
    }
    if (await probeComfy(port)) {
      return { ok: true, reused: true, port, pid: meta.pid };
    }
    appendConsole("comfy not up with live pid — killing stale process and respawning");
    await killPidTree(meta.pid);
    clearPidMeta();
    backendProc = null;
  }

  const comfy = comfyDir(installDir);
  const py = join(comfy, "venv", "Scripts", "python.exe");
  if (!fs.existsSync(py)) {
    reportErr("no_venv", "H3 后端缺少 Python 环境（" + py + "）", { phase: "start" });
    return { ok: false, error: "no_venv" };
  }

  mk(path.dirname(consoleLogPath()));
  appendConsole("starting ComfyUI…");
  const outFd = fs.openSync(consoleLogPath(), "a");
  const args = ["main.py", "--listen", "127.0.0.1", "--port", String(port)];
  const launchCpuVae = !!cfg.cpuVae;
  if (launchCpuVae) args.push("--cpu-vae");
  if (cfg.optDisablePinnedMemory !== false) args.push("--disable-pinned-memory");
  if (cfg.optFp16Intermediates !== false) args.push("--fp16-intermediates");
  const reserveGb = Number(cfg.optReserveVramGb);
  if (Number.isFinite(reserveGb) && reserveGb > 0) {
    args.push("--reserve-vram", String(reserveGb));
  }
  /* 系统内存缓存保留下限：ComfyUI 默认非活跃阈值 = 100% 内存（最高 128G），
   * 会把超分链的整段视频帧张量一直留在 RAM 里 → 64G 机器被跑满。
   * 给两个阈值（活跃 headroom / 非活跃 headroom）后，内存吃紧时它才开始释放缓存产物。
   * 0 / 非法值 = 不加这个参数，退回服务默认（留给想自己调的机器）。 */
  const cacheRamGb = Math.round(Number(cfg.optCacheRamGb));
  if (Number.isFinite(cacheRamGb) && cacheRamGb > 0) {
    const inactiveGb = Math.max(1, Math.floor(cacheRamGb / 2));
    args.push("--cache-ram", String(cacheRamGb), String(inactiveGb));
  }
  const env = Object.assign({}, process.env);
  if (cfg.optExpandableSegments !== false) {
    const prev = String(env.PYTORCH_CUDA_ALLOC_CONF || "").trim();
    if (!/expandable_segments/i.test(prev)) {
      env.PYTORCH_CUDA_ALLOC_CONF = prev
        ? prev + ",expandable_segments:True"
        : "expandable_segments:True";
    }
  }
  /* 多线程 arena：默认按核数开一堆 malloc arena，超分链的「整段帧张量」全是大块，
   * 分散在多个 arena 里时谁都不肯把内存还给系统 → RSS 只涨不落（就是这次要治的「持续攀升」）。
   * 单 arena + 限线程能把这类碎片压掉一大截（顶多多线程分配串行一点，超分本来也不是 CPU 密集）。 */
  if (!String(env.MALLOC_ARENA_MAX || "").trim()) env.MALLOC_ARENA_MAX = "1";
  const arenaThreads = Math.round(Number(cfg.optArenaThreads));
  if (Number.isFinite(arenaThreads) && arenaThreads > 0) {
    const n = String(arenaThreads);
    if (!String(env.OMP_NUM_THREADS || "").trim()) env.OMP_NUM_THREADS = n;
    if (!String(env.MKL_NUM_THREADS || "").trim()) env.MKL_NUM_THREADS = n;
  }
  appendConsole(
    "[launch] flags=" +
      args.slice(1).join(" ") +
      (env.PYTORCH_CUDA_ALLOC_CONF ? " PYTORCH_CUDA_ALLOC_CONF=" + env.PYTORCH_CUDA_ALLOC_CONF : "")
  );
  const child = spawn(py, args, {
    cwd: comfy,
    detached: true,
    windowsHide: true,
    stdio: ["ignore", outFd, outFd],
    env,
  });
  fs.closeSync(outFd);
  child.unref();
  backendProc = child;
  savePidMeta({ pid: child.pid, port, startedAt: Date.now(), installDir });
  saveConfig({ wantRunning: true });
  appendConsole("backend spawned pid=" + child.pid);

  const deadline = Date.now() + 300000;
  while (Date.now() < deadline) {
    if (await probeComfy(port)) {
      appendConsole("comfy ready :" + port);
      return { ok: true, pid: child.pid, port };
    }
    await sleep(2000);
    if (!isAlivePid(child.pid)) {
      clearPidMeta();
      const snip = lastConsoleErrorSnippet(1800);
      appendConsole("[start] backend exited early");
      if (launchCpuVae) noteCpuVaeLaunchFailure("ComfyUI 进程启动后退出");
      reportErr("backend_exited", "ComfyUI 进程启动后退出" + (snip ? "：\n" + snip : ""), { phase: "start" });
      return {
        ok: false,
        error: "backend_exited",
        message:
          "ComfyUI 进程启动后退出" +
          (snip ? "：\n" + snip.replace(/\x1b\[[0-9;]*m/g, "") : ""),
      };
    }
  }
  const snip = lastConsoleErrorSnippet(1200);
  if (launchCpuVae) noteCpuVaeLaunchFailure("等待就绪超时");
  reportErr("backend_start_timeout", "等待 ComfyUI 就绪超时" + (snip ? "；最近日志：\n" + snip : ""), {
    phase: "start",
  });
  return {
    ok: false,
    error: "backend_start_timeout",
    pid: child.pid,
    port,
    starting: true,
    message:
      "等待 ComfyUI 就绪超时" +
      (snip ? "；最近日志：\n" + snip.replace(/\x1b\[[0-9;]*m/g, "") : ""),
  };
}

function uninstallPreview() {
  const cfg = loadConfig();
  const safe = isSafeInstallDir(cfg.installDir);
  if (!safe.ok) return { ok: false, error: safe.error || "bad_dir" };
  const root = safe.path;
  if (path.resolve(String(cfg.installDir || "")) !== path.resolve(root)) {
    return { ok: false, error: "dir_mismatch" };
  }
  const targets = [];
  const add = (rel, note) => {
    const p = join(root, rel);
    if (fs.existsSync(p)) targets.push({ path: p, rel, note: note || rel });
  };
  // Prefer deleting nested ComfyUI; if installDir IS ComfyUI, delete known subdirs carefully
  const comfy = comfyDir(root);
  if (comfy && path.resolve(comfy) !== path.resolve(root)) {
    add("ComfyUI", "ComfyUI 运行时与模型（体积很大）");
  } else if (comfy) {
    add("venv", "Python 虚拟环境");
    add("models", "模型权重");
    add("custom_nodes", "自定义节点");
  }
  add("app", "应用脚手架");
  add("scripts", "安装脚本");
  add("requirements.txt", "依赖清单");
  add("README.md", "说明");
  add("start_backend.cmd", "启动脚本");
  add("manifest.json", "清单");
  add(".gitignore", "gitignore");
  add(".cuda-python", "探测到的 CUDA Python 路径");
  return {
    ok: true,
    installDir: root,
    targets,
    keepOutput: true,
    note: "默认保留 output/ 与 ComfyUI/output/，不会删除。",
  };
}

async function uninstallProject(opts) {
  opts = opts || {};
  const prev = uninstallPreview();
  if (!prev.ok) return prev;
  if (!opts.confirm) return { ok: false, error: "need_confirm", preview: prev };

  await stopBackend();

  const cfg = loadConfig();
  const root = prev.installDir;
  if (path.resolve(cfg.installDir || "") !== path.resolve(root)) {
    return { ok: false, error: "dir_mismatch" };
  }
  const safe = isSafeInstallDir(root);
  if (!safe.ok) return { ok: false, error: safe.error };

  const deleted = [];
  const errors = [];
  for (const t of prev.targets) {
    try {
      fs.rmSync(t.path, { recursive: true, force: true });
      deleted.push(t.path);
      appendConsole("deleted " + t.path);
    } catch (e) {
      errors.push({ path: t.path, error: String((e && e.message) || e) });
    }
  }
  if (opts.deleteOutput) {
    for (const rel of ["output", join("ComfyUI", "output")]) {
      const out = join(root, rel);
      try {
        if (fs.existsSync(out)) {
          fs.rmSync(out, { recursive: true, force: true });
          deleted.push(out);
        }
      } catch (e) {
        errors.push({ path: out, error: String((e && e.message) || e) });
      }
    }
  }

  try {
    if (fs.existsSync(installedMetaPath())) fs.unlinkSync(installedMetaPath());
  } catch {}
  appendConsole("uninstall done; installDir retained: " + root);
  /* venv 已经没了：Sage 自检缓存必须一起作废，否则管理窗还会挂着「已装」十秒到十分钟 */
  invalidateSageProbe();
  return { ok: true, deleted, errors, installDir: root };
}

function calcLength(seconds) {
  const a = Math.max(5, Math.round(Number(seconds) * 24));
  return a + ((5 - (a % 17)) % 17);
}

/* 后端 MiniMaxH3ReferenceToVideo 的参考视频硬上限：ref_video_0..2（R2V 模式，与 h3-pack/README.md
 * 「视频 ≤3」同口径）。分段衔接在 R2V 下要占掉其中一路，所以封顶规则只有这一个真源。 */
const H3_REF_VIDEO_MAX = 3;

/** 内置图构建。
 *  notes：可选出参对象，本函数只往里写「需要让用户看见的图层面决策」（目前只有 R2V 分段衔接占用第几路
 *  参考视频），调用方（generateVideo）负责落日志；不传则不记，图本体不受影响。 */
function buildH3Workflow(params, uploaded, notes) {
  const nodes = {};
  let id = 1;
  const w = (cls, inputs) => ({ class_type: cls, inputs });
  const link = (nodeId, output) => [String(nodeId), output];
  const mode = params.mode === "r2v" ? "r2v" : "fl2va";
  const useRef = mode === "r2v";
  const dit = useRef && params.hasRef2va !== false ? MODELS.ref2va : MODELS.fl2va;

  const imageNodes = [];
  if (mode === "fl2va") {
    if (uploaded.first) {
      const nid = String(id++);
      nodes[nid] = w("LoadImage", { image: uploaded.first });
      imageNodes.push({ role: "first", nid });
    }
    if (uploaded.last) {
      const nid = String(id++);
      nodes[nid] = w("LoadImage", { image: uploaded.last });
      imageNodes.push({ role: "last", nid });
    }
  } else {
    (uploaded.refs || []).forEach((name) => {
      const nid = String(id++);
      nodes[nid] = w("LoadImage", { image: name });
      imageNodes.push({ role: "ref", nid });
    });
  }

  const videoLinks = [];
  const videoAudioLinks = [];
  const videoNodePairs = [];
  (uploaded.videos || []).forEach((file) => {
    const vn = String(id++);
    nodes[vn] = w("LoadVideo", { file });
    const gn = String(id++);
    nodes[gn] = w("GetVideoComponents", { video: link(vn, 0) });
    videoLinks.push(link(gn, 0));
    videoAudioLinks.push(link(gn, 1));
    /* 记一下这条参考视频占的节点，分段衔接顶替它时要把两个空节点一起摘掉，别留在图里 */
    videoNodePairs.push([vn, gn]);
  });

  const audioLinks = [];
  (uploaded.audios || []).forEach((file) => {
    const an = String(id++);
    nodes[an] = w("LoadAudio", { audio: file });
    audioLinks.push(link(an, 0));
  });

  /* 分段衔接子图（内置 FL2VA / R2V 都生效；自建 ComfyUI 工作流不走这里）：
   *   上一段成片 → 末尾 chainFrames 帧 = 段间引导窗口（构图 / 角色 / 场景连续性的来源）。
   * FL2VA：再取该窗口最后一帧（=「帧数-1」）充当锚定构图的首帧；用户自备首帧时尊重用户首帧，
   *        衔接帧只作兜底（不覆盖）。
   * R2V ：MiniMaxH3ReferenceToVideo 没有 first_frame，锚只能是「一路参考视频」——该窗口的画面帧
   *        直接作为 ref_video_k（官方 <Video N> 语义含 video continuation / 续写起点）。
   *        ref_video_k 收 IMAGE 帧序列（与既有 GetVideoComponents 输出同口径，不必 CreateVideo 回灌
   *        成 VIDEO 再拆），且只喂画面不喂音轨：窗口只有 N 帧，配整段音轨会音画长度不匹配。
   * chainDenoise ∈ (0,1) 时落到 BasicScheduler.denoise = 引导加重绘（对引导区域重绘以重置画质，
   * 抑制长片逐段劣化）；0 / 1 = 纯引导（沿用全局 denoise）。 */
  const chainFrames = Math.max(1, Math.min(60, Math.round(Number(params.chainFrames) || 22)));
  let chainAnchor = null;
  let chainRefVideo = null;
  let chainVideoNote = "";
  if (uploaded.chain) {
    const chainLoadV = String(id++);
    nodes[chainLoadV] = w("LoadVideo", { file: uploaded.chain });
    const chainGetV = String(id++);
    nodes[chainGetV] = w("GetVideoComponents", { video: link(chainLoadV, 0) });
    /* batch_index 取负数 = 从末尾倒着数：窗口即上一段末尾 chainFrames 帧 */
    const chainWin = String(id++);
    nodes[chainWin] = w("ImageFromBatch", {
      image: link(chainGetV, 0),
      batch_index: -chainFrames,
      length: chainFrames,
    });
    if (mode === "fl2va") {
      /* 锚定帧 = 引导窗口最后一帧（等价「帧数-1」；用 -1 使上一段短于窗口时也不越界） */
      chainAnchor = String(id++);
      nodes[chainAnchor] = w("ImageFromBatch", {
        image: link(chainWin, 0),
        batch_index: -1,
        length: 1,
      });
    } else {
      /* R2V：末 N 帧窗口就是一路衔接参考视频（ref_video_* 收 IMAGE 帧序列，与既有 V1–V3 同口径，
       * 不必 CreateVideo 回灌成 VIDEO 再拆）；该路音轨留空。后端只收 3 路（H3_REF_VIDEO_MAX）：
       * 用户连满时顶掉最后一条 V3，并把话留给上层日志 —— 绝不静默丢。 */
      const chainImg = link(chainWin, 0);
      const refsFull = videoLinks.length >= H3_REF_VIDEO_MAX;
      if (refsFull) {
        /* 顶掉最后一条 V3：原来那两节点（LoadVideo + GetVideoComponents）一并摘掉，别在图里留孤儿 */
        const dropped = videoNodePairs[H3_REF_VIDEO_MAX - 1];
        if (dropped) dropped.forEach((nid) => delete nodes[nid]);
        videoLinks[H3_REF_VIDEO_MAX - 1] = chainImg;
        videoAudioLinks[H3_REF_VIDEO_MAX - 1] = null;
      } else {
        videoLinks.push(chainImg);
        videoAudioLinks.push(null);
      }
      chainRefVideo = chainImg;
      chainVideoNote =
        "分段衔接：上一段末尾 " + chainFrames + " 帧占用 V" + (refsFull ? H3_REF_VIDEO_MAX : videoLinks.length) +
        (refsFull ? "（该路原有参考视频本段未接入）" : "（续写引导）");
    }
  }
  /* 衔接是否真的进了图（两种模式任一命中即算）：引导加重绘的判据用它，与模式无关 */
  const chainActive = !!chainAnchor || !!chainRefVideo;
  /* 衔接占了哪一路参考视频 → 交给调用方落日志（图本体不受影响） */
  if (notes && chainVideoNote) notes.chainVideo = chainVideoNote;

  const vaeVideoNode = String(id++);
  const vaeAudioNode = String(id++);
  const unetNode = String(id++);
  const clipNode = String(id++);
  const h3Node = String(id++);
  let modelOut = unetNode;

  nodes[vaeVideoNode] = w("VAELoader", { vae_name: MODELS.vaeVideo });
  nodes[vaeAudioNode] = w("VAELoader", { vae_name: MODELS.vaeAudio });
  nodes[unetNode] = w("UNETLoader", { unet_name: dit, weight_dtype: "default" });
  nodes[clipNode] = w("CLIPLoader", { clip_name: MODELS.clip, type: "minimax", device: "default" });

  if (mode === "r2v") {
    const h3Inputs = {
      clip: link(clipNode, 0),
      vae: link(vaeVideoNode, 0),
      audio_vae: link(vaeAudioNode, 0),
      prompt: params.prompt,
      width: params.width,
      height: params.height,
      length: params.length,
      ref_image_size: params.refImageSize || "match",
    };
    imageNodes.forEach((item, i) => {
      h3Inputs[`ref_image_${i}`] = link(item.nid, 0);
    });
    videoLinks.forEach((lk, i) => {
      h3Inputs[`ref_video_${i}`] = lk;
      if (videoAudioLinks[i]) h3Inputs[`ref_video_audio_${i}`] = videoAudioLinks[i];
    });
    audioLinks.forEach((lk, i) => {
      h3Inputs[`ref_audio_${i}`] = lk;
    });
    nodes[h3Node] = w("MiniMaxH3ReferenceToVideo", h3Inputs);
  } else {
    const h3Inputs = {
      clip: link(clipNode, 0),
      vae: link(vaeVideoNode, 0),
      prompt: params.prompt,
      width: params.width,
      height: params.height,
      length: params.length,
    };
    const first = imageNodes.find((x) => x.role === "first");
    const last = imageNodes.find((x) => x.role === "last");
    /* 有用户首帧则尊重用户首帧；否则用上一段成片的末帧充当锚定构图的首帧（分段衔接） */
    if (first) h3Inputs.first_frame = link(first.nid, 0);
    else if (chainAnchor) h3Inputs.first_frame = link(chainAnchor, 0);
    if (last) h3Inputs.last_frame = link(last.nid, 0);
    nodes[h3Node] = w("MiniMaxH3ImageToVideo", h3Inputs);
  }

  /* 24G 优化链（均可关，默认开）：Easy → Shift → LowVRAM → ChunkFFN → Sage
   * TeaCache 已移除（仅保留 EasyCache 步缓存） */
  if (params.optEasyCache !== false) {
    const easyNode = String(id++);
    nodes[easyNode] = w("EasyCache", {
      model: link(modelOut, 0),
      reuse_threshold: clampNum(params.easyReuse, EASY_SAFE.reuse.min, EASY_SAFE.reuse.max, EASY_SAFE.reuse.value),
      start_percent: clampNum(params.easyStart, EASY_SAFE.start.min, EASY_SAFE.start.max, EASY_SAFE.start.value),
      end_percent: clampNum(params.easyEnd, EASY_SAFE.end.min, EASY_SAFE.end.max, EASY_SAFE.end.value),
      verbose: !!params.easyVerbose,
    });
    modelOut = easyNode;
  }

  const shiftNode = String(id++);
  nodes[shiftNode] = w("MiniMaxH3SigmaShift", {
    model: link(modelOut, 0),
    shift_video: Number(params.shiftVideo) || 12,
    shift_audio: Number(params.shiftAudio) || 3,
  });
  modelOut = shiftNode;

  if (params.optLowVramAttn !== false) {
    const lowNode = String(id++);
    nodes[lowNode] = w("MiniMaxLowVRAMAttention", {
      model: link(modelOut, 0),
      head_chunks: Math.max(1, Number(params.lowVramHeadChunks) || 4),
    });
    modelOut = lowNode;
  }

  if (params.optChunkFfn !== false) {
    const chunkNode = String(id++);
    nodes[chunkNode] = w("MiniMaxChunkFeedForward", {
      model: link(modelOut, 0),
      chunks: Math.max(1, Number(params.chunkFfnChunks) || 2),
      seq_threshold: Math.max(256, Number(params.chunkFfnSeqThreshold) || 4096),
    });
    modelOut = chunkNode;
  }

  const sageMode = String(params.sageMode || "disabled").trim() || "disabled";
  const useSage =
    params.optSageAttn !== false && !/^(disabled|off|none|false|0)$/i.test(sageMode);
  let modelForGuider = modelOut;
  if (useSage) {
    const sageNode = String(id++);
    nodes[sageNode] = w("PathchSageAttentionKJ", {
      model: link(modelOut, 0),
      sage_attention: sageMode === "disabled" ? "auto" : sageMode,
      allow_compile: !!params.sageCompile,
    });
    modelForGuider = sageNode;
  }

  const noiseNode = String(id++);
  const schedNode = String(id++);
  const samplerNode = String(id++);
  const guiderNode = String(id++);
  const customNode = String(id++);
  const decodeNode = String(id++);
  const decodeAudioNode = String(id++);
  const createVideoNode = String(id++);
  const saveVideoNode = String(id++);

  nodes[noiseNode] = w("RandomNoise", { noise_seed: Number(params.seed) || 0 });
  /* 引导加重绘：分段衔接生效且重绘幅度 ∈ (0,1) 时，用它压低 denoise（对引导区域重绘、重置画面状态）；
   * 幅度 0 / 1 = 不加引导重绘（纯引导，沿用全局 denoise）。FL2VA / R2V 同口径（该节点与模式无关）。 */
  const chainRedraw = Number(params.chainDenoise);
  const useChainRedraw =
    !!chainActive && Number.isFinite(chainRedraw) && chainRedraw > 0 && chainRedraw < 1;
  nodes[schedNode] = w("BasicScheduler", {
    model: link(shiftNode, 0),
    scheduler: params.scheduler || "simple",
    steps: Number(params.steps) || 20,
    denoise: useChainRedraw ? chainRedraw : Number(params.denoise) || 1,
  });
  nodes[samplerNode] = w("KSamplerSelect", { sampler_name: params.sampler || "res_multistep" });
  nodes[guiderNode] = w("BasicGuider", { model: link(modelForGuider, 0), conditioning: link(h3Node, 0) });
  nodes[customNode] = w("SamplerCustomAdvanced", {
    noise: link(noiseNode, 0),
    guider: link(guiderNode, 0),
    sampler: link(samplerNode, 0),
    sigmas: link(schedNode, 0),
    latent_image: link(h3Node, 1),
  });

  let latentForDecode = customNode;
  if (params.optVramBarrier !== false) {
    const vramNode = String(id++);
    nodes[vramNode] = w("VRAM_Debug", {
      empty_cache: true,
      gc_collect: true,
      unload_all_models: true,
      any_input: link(customNode, 0),
    });
    latentForDecode = vramNode;
  }

  nodes[decodeNode] = w("VAEDecode", {
    samples: link(latentForDecode, 0),
    vae: link(vaeVideoNode, 0),
  });
  nodes[decodeAudioNode] = w("VAEDecodeAudio", {
    samples: link(latentForDecode, 0),
    vae: link(vaeAudioNode, 0),
  });
  let videoImagesLink = link(decodeNode, 0);
  let videoFps = Number(params.fps) || 24;
  /* 注：4K 超分补帧已拆为独立后处理阶段（phase=post），生成阶段不再内嵌，
   * 避免采样模型 + 补帧/超分模型同时占显存。 */
  nodes[createVideoNode] = w("CreateVideo", {
    images: videoImagesLink,
    audio: link(decodeAudioNode, 0),
    fps: videoFps,
    bit_depth: Number(params.bitDepth) || 8,
  });
  nodes[saveVideoNode] = w("SaveVideo", {
    video: link(createVideoNode, 0),
    filename_prefix: params.filenamePrefix || "video/MiniMax_H3",
    format: params.videoFormat || "auto",
    codec: params.videoCodec || "auto",
  });

  return nodes;
}

/* ───────────── 独立后处理（超分 / 补帧，已从生成链拆出） ───────────── */

/** 超分模型名归一：只取文件名，并确保带扩展名（缺省按随包的 .pth 补）。
 *  兼容三种来源：老节点存的 "RealESRGAN_x4plus"、用户手填的完整路径、已带扩展名的正确值。 */
function normalizeUpscaleModelName(raw) {
  let name = String(raw == null ? "" : raw).trim().replace(/[\\/]+$/, "");
  if (!name) return POST_MODELS.upscale;
  name = name.split(/[\\/]/).pop();
  const lower = name.toLowerCase();
  for (const ext of POST_MODEL_EXTS) if (lower.endsWith(ext)) return name;
  const defExt = (POST_MODELS.upscale.match(/\.[a-z0-9]+$/i) || [".pth"])[0];
  return name + defExt;
}

/** 按 ComfyUI 真实 upscale_models 目录再校一次：
 *  ① 忽略大小写精确命中 → 用它；② 扩展名不同但文件名唯一（.pt / .safetensors）→ 用它；
 *  ③ 目录读不到（后端没装 / 路径不对）→ 返回归一化名 + available:null，不阻断，交给 ComfyUI 校验。
 *  返回 { model, available|null }；available 是该目录实际可用的文件名清单。 */
function resolveUpscaleModelForComfy(comfy, raw) {
  const wanted = normalizeUpscaleModelName(raw);
  const dir = comfy ? join(comfy, "models", "upscale_models") : "";
  let files = [];
  try {
    /* 只看带模型扩展名的文件：目录里的占位说明（put_models_here 之类）ComfyUI 也不会列进 combo */
    files = fs
      .readdirSync(dir)
      .filter((f) => {
        if (!POST_MODEL_EXTS.some((e) => String(f).toLowerCase().endsWith(e))) return false;
        try {
          return fs.statSync(join(dir, f)).isFile();
        } catch {
          return false;
        }
      });
  } catch {
    files = [];
  }
  if (!files.length) return { model: wanted, available: null };
  const key = (s) => String(s).toLowerCase();
  for (const f of files) if (key(f) === key(wanted)) return { model: f, available: files };
  const stem = key(wanted).replace(/\.[a-z0-9]+$/, "");
  const sameStem = files.filter((f) => key(f).replace(/\.[a-z0-9]+$/, "") === stem);
  if (sameStem.length === 1) return { model: sameStem[0], available: files };
  return { model: wanted, available: files };
}

/** 归一化后处理参数：24G 安全档默认（超分逐帧、RIFE 低显存）。 */
function resolvePostOptions(kind, raw) {
  const o = raw && typeof raw === "object" ? raw : {};
  if (kind === "interp") {
    const d = POST_SAFE_DEFAULTS.interp;
    /* 流式补帧档参数（图档不使用 engine / precision / maxLongSide，写进去也不影响旧链）：
     * precision：默认 fp16；lowVram 档或宿主报来显存偏小（< POST_STREAM_MIN_FP16_VRAM_GB）时落 fp32。
     * maxLongSide：沿用节点已有值，0 = 不预缩放（补帧不改分辨率；显式给出时才先缩，省显存）。 */
    const lowVram = o.lowVram !== false; /* 默认开 */
    const vramGb = Number(o.vramGb) > 0 ? Number(o.vramGb) : null;
    const smallVram = vramGb != null && vramGb < POST_STREAM_MIN_FP16_VRAM_GB;
    const precReq = String(o.precision || "").toLowerCase();
    const precision =
      precReq === "fp16" || precReq === "fp32" ? precReq : lowVram || smallVram ? "fp32" : "fp16";
    return {
      multiplier: Math.max(1, Math.min(4, Math.round(Number(o.multiplier) || d.multiplier))),
      clearCacheEvery: Math.max(
        1,
        Math.min(64, Math.round(Number(o.clearCacheEvery) || d.clearCacheEvery)),
      ),
      batchSize: 1, /* 24G 安全档：RIFE 逐帧，忽略更大的请求值 */
      scaleFactor: Number(o.scaleFactor) || d.scaleFactor,
      maxLongSide: Math.max(0, Math.round(Number(o.maxLongSide) || 0)),
      precision: precision,
      /* 引擎意向：'stream'（默认，内存与时长无关）/ 'graph'（显式要旧链）。
       * 环境缺件（脚本 / venv / RIFE 权重）时由 resolvePostEngine 决定实际走哪条。 */
      engine: String(o.engine || "").toLowerCase() === "graph" ? "graph" : "stream",
      lowVram,
    };
  }
  const d = POST_SAFE_DEFAULTS.upscale;
  const lowVram = o.lowVram !== false; /* 默认开 */
  const perBatchReq = Math.max(1, Math.round(Number(o.perBatch) || d.perBatch));
  /* ── 流式档参数（图档不使用 tile / overlap / precision，写进去也不影响旧链） ──
   * tile：沿用节点已有 node.tile；未指定（0）时用默认 512 —— 新链的内存只跟 tile 有关。
   * precision：默认 fp16；lowVram 档或宿主报来显存偏小（< POST_STREAM_MIN_FP16_VRAM_GB）时
   *   落 fp32，并把「未显式指定」的 tile 减半 —— 显存紧的机器优先跑得起来，而不是跑得快。 */
  const tileReq = Math.max(0, Math.round(Number(o.tile) || 0));
  const vramGb = Number(o.vramGb) > 0 ? Number(o.vramGb) : null;
  const smallVram = vramGb != null && vramGb < POST_STREAM_MIN_FP16_VRAM_GB;
  const wantFp32 = lowVram || smallVram;
  const precReq = String(o.precision || "").toLowerCase();
  const precision =
    precReq === "fp16" || precReq === "fp32" ? precReq : wantFp32 ? "fp32" : "fp16";
  const streamTile = tileReq > 0 ? tileReq : POST_STREAM_DEFAULT_TILE;
  const tile =
    tileReq > 0 ? tileReq : wantFp32 ? Math.max(64, Math.round(streamTile / 2)) : streamTile;
  return {
    model: normalizeUpscaleModelName(o.model || d.model),
    /* 倍率：2 = 输出只放大 2 倍（更省内存；有原生 x2 权重就顺手用），4 = x4 原生 */
    scale: normalizeUpscaleScale(o.scale != null ? o.scale : d.scale),
    targetLongSide: Math.max(
      POST_TARGET_LONG_SIDE_MIN,
      Math.round(Number(o.targetLongSide) || d.targetLongSide),
    ),
    perBatch: lowVram ? 1 : perBatchReq,
    tile: tile,
    overlap: Math.max(0, Math.round(Number(o.overlap) || POST_STREAM_DEFAULT_OVERLAP)),
    precision: precision,
    /* 引擎意向：'stream'（默认，内存与时长无关）/ 'graph'（显式要旧链）。
     * 环境缺件时由 resolvePostEngine 决定实际走哪条，并把结论写回这里。 */
    engine: String(o.engine || "").toLowerCase() === "graph" ? "graph" : "stream",
    lowVram,
  };
}

/** OOM 自动降一档：流式 = tile 减半 + 精度 fp32（超分）/ 精度 fp32（补帧，倍率不动）；图 = 压低目标长边并强制逐帧；补帧退回 2x + 最小缓存。 */
function downgradePostOptions(kind, opts) {
  if (kind === "interp") {
    /* 流式补帧档：常驻内存只与相邻两帧 + 模型有关，与时长无关 —— 降档只落 fp32
     * （精度减半 = 激活/权重占用减半），显式给过 maxLongSide 再顺手降一档，
     * multiplier 不动（用户要的倍率不该被内存策略白降）。图档保持原口径一字未改。 */
    if (String(opts.engine || "") === "stream") {
      const cur = Math.max(0, Math.round(Number(opts.maxLongSide) || 0));
      const nextLong =
        cur > 0 ? Math.max(640, Math.round((cur * 0.75) / 2) * 2) : 0;
      return Object.assign({}, opts, {
        engine: "stream",
        precision: "fp32",
        maxLongSide: nextLong,
      });
    }
    return {
      multiplier: Math.min(2, opts.multiplier),
      clearCacheEvery: 1,
      batchSize: 1,
      scaleFactor: opts.scaleFactor,
    };
  }
  /* 流式档：内存 / 显存都只跟 tile 与精度有关，与目标长边无关（时长也不影响），
   * 所以降档只做「tile 减半 + fp32」，不再动 targetLongSide / scale —— 画质不被白降。 */
  if (String(opts.engine || "") === "stream") {
    return Object.assign({}, opts, {
      engine: "stream",
      tile: Math.max(64, Math.round((Number(opts.tile) || POST_STREAM_DEFAULT_TILE) / 2)),
      precision: "fp32",
    });
  }
  return {
    model: opts.model,
    scale: normalizeUpscaleScale(opts.scale),
    targetLongSide: Math.max(
      POST_TARGET_LONG_SIDE_MIN,
      Math.round(opts.targetLongSide / 2),
    ),
    perBatch: 1,
    tile: 0,
    engine: "graph",
    precision: opts.precision || "fp16",
    overlap: opts.overlap,
    lowVram: true,
  };
}

function isPostOomError(e) {
  const txt = String((e && (e.detail || e.message)) || e || "");
  return POST_OOM_RE.test(txt);
}

/**
 * 独立后处理工作流（与 MiniMax H3 生成彻底解耦）。
 *   kind='upscale' → Real-ESRGAN 超分（x4 / x2 权重）→ ImageScale 到输出长边；
 *   kind='interp'  → RIFE VFI 补帧（逐帧、低显存），fps 按倍数重算。
 * 两者都从源视频取帧与音轨，回 CreateVideo（音轨原样带回）+ SaveVideo。
 * 参数由 postProcessVideo 归一化后传入（见 resolvePostOptions）。
 * 输出长边 = min(目标长边, 源长边 × 倍率)：倍率 x2 时不会被目标长边拉成 4 倍；
 * 源分辨率（params.width / height）缺失时不追加缩放，保留权重原生尺寸。
 */
function buildPostWorkflow(params) {
  const p = params || {};
  const kind = p.kind === "interp" ? "interp" : "upscale";
  if (!p.videoPath) throw new Error("post_video_missing");
  const nodes = {};
  let id = 1;
  const w = (cls, inputs) => ({ class_type: cls, inputs });
  const link = (nodeId, output) => [String(nodeId), output];

  const loadV = String(id++);
  nodes[loadV] = w("LoadVideo", { file: p.videoPath });
  const getV = String(id++);
  nodes[getV] = w("GetVideoComponents", { video: link(loadV, 0) });

  let framesLink = link(getV, 0);
  let fps = Math.max(1, Number(p.fps) || 24);
  let tag = "upscaleX4";

  if (kind === "interp") {
    const it = p.interp || POST_SAFE_DEFAULTS.interp;
    const mult = Math.max(1, Math.min(8, Math.round(Number(it.multiplier) || 2)));
    const interpNode = String(id++);
    nodes[interpNode] = w("RIFE VFI", {
      ckpt_name: POST_MODELS.rife,
      frames: framesLink,
      clear_cache_after_n_frames: Math.max(1, Math.round(Number(it.clearCacheEvery) || 2)),
      multiplier: mult,
      fast_mode: false,
      ensemble: true,
      scale_factor: Number(it.scaleFactor) || 1.0,
      dtype: "float32",
      torch_compile: false,
      batch_size: Math.max(1, Math.round(Number(it.batchSize) || 1)),
    });
    framesLink = link(interpNode, 0);
    fps = Math.max(1, Math.round(fps * mult));
    tag = "interp" + mult + "x";
  } else {
    const up = p.upscale || POST_SAFE_DEFAULTS.upscale;
    /* 内存闸要求「进超分前先把源帧缩小」时，先插一层 ImageScale：
     * 源少 k² 倍，x4 中间张量就少 k² 倍 —— 这是唯一能压住峰值内存的杠杆（目标长边只管
     * 超分完成后交回 RAM 的那些帧）。见 resolveUpscaleRamPlan 的 preScale。 */
    const pre = Array.isArray(p.preDims) ? p.preDims : null;
    if (pre && Number(pre[0]) > 1 && Number(pre[1]) > 1) {
      const preNode = String(id++);
      nodes[preNode] = w("ImageScale", {
        image: framesLink,
        upscale_method: "lanczos",
        width: Math.max(2, Math.round(Number(pre[0]))),
        height: Math.max(2, Math.round(Number(pre[1]))),
        crop: "disabled",
      });
      framesLink = link(preNode, 0);
    }
    const upModelNode = String(id++);
    nodes[upModelNode] = w("UpscaleModelLoader", {
      model_name: normalizeUpscaleModelName(up.model || POST_MODELS.upscale),
    });
    const upNode = String(id++);
    nodes[upNode] = w("ImageUpscaleWithModelBatched", {
      upscale_model: link(upModelNode, 0),
      images: framesLink,
      per_batch: Math.max(1, Math.round(Number(up.perBatch) || 1)),
    });
    framesLink = link(upNode, 0);
    const longSide = Math.round(Number(up.targetLongSide) || 0);
    if (longSide > 0 && Number(p.width) > 0 && Number(p.height) > 0) {
      /* 倍率是输出上限：x2 时把 x4 权重的产物缩回源 ×2（有原生 x2 权重时这里基本是原位）。
         tag 带上倍率，产物文件名自己说明这一单是几倍。 */
      const out = upscaleOutputLongSide(
        longSide,
        Math.max(Number(p.width), Number(p.height)),
        up.scale,
      );
      const [tw, th] = postDimsForLongSide(p.width, p.height, out);
      const scaleNode = String(id++);
      nodes[scaleNode] = w("ImageScale", {
        image: framesLink,
        upscale_method: "lanczos",
        width: tw,
        height: th,
        crop: "disabled",
      });
      framesLink = link(scaleNode, 0);
      tag = "upscale" + (normalizeUpscaleScale(up.scale) === 2 ? "X2_" : "") + out;
    }
  }

  const createVideoNode = String(id++);
  nodes[createVideoNode] = w("CreateVideo", {
    images: framesLink,
    audio: link(getV, 1),
    fps,
    bit_depth: Number(p.bitDepth) || 8,
  });
  const saveVideoNode = String(id++);
  nodes[saveVideoNode] = w("SaveVideo", {
    video: link(createVideoNode, 0),
    filename_prefix: p.filenamePrefix || "video/MiniMax_H3_post_" + tag,
    format: p.videoFormat || "auto",
    codec: p.videoCodec || "auto",
  });
  return nodes;
}

/**
 * h3:postProcess —— 超分 / 补帧独立后处理任务。
 * 入参：{ nodeId, kind:'upscale'|'interp', sourcePath, fps, bitDepth, videoFormat,
 *         videoCodec, outputDir, filename, sourceWidth, sourceHeight,
 *         upscale:{model,scale,targetLongSide,perBatch,tile,lowVram,engine,precision,overlap},
 *         interp:{multiplier,clearCacheEvery,batchSize,scaleFactor,maxLongSide,lowVram,engine,precision} }
 * 复用全局媒体互斥锁、activeGenerate 取消、ComfyUI /free；提交前后各释放一次生成模型，
 * 首次 OOM 自动降一档重试一次。超分 / 补帧都走同一套引擎选路（见 resolvePostEngine）：
 *  · 'stream'（默认）：逐帧流式（超分 h3-pack/post/stream_upscale.py 分块 / 补帧
 *    h3-pack/post/stream_interp.py 逐对，都是 venv python 子进程）——
 *    超分常驻内存只与一个 tile 有关、补帧只与相邻两帧 + 模型有关，都与时长无关
 *    → 16G 机器也能跑 15 秒级视频；
 *  · 'graph'（兜底）：原 ComfyUI 图链（缺脚本 / 缺 venv / 缺权重 / 流式失败时自动回退）。
 */
async function postProcessVideo(params) {
  const req = params && typeof params === "object" ? params : {};
  const nodeId = String(req.nodeId || "");
  if (!nodeId) return { ok: false, error: "missing_node_id" };
  const kind = req.kind === "interp" ? "interp" : "upscale";
  const label = kind === "interp" ? "补帧" : "超分";
  const sourcePath = String(req.sourcePath || "").trim();
  if (!sourcePath) {
    return { ok: false, error: "missing_source", message: "缺少输入视频（" + label + "）" };
  }
  if (!fs.existsSync(sourcePath)) {
    return { ok: false, error: "source_missing", message: "输入视频不存在：" + sourcePath };
  }

  const acq = tryAcquireLock({
    nodeId,
    workflowId: String(req.canvasWorkflowId || "").trim(),
    kind: "video_gen",
  });
  if (!acq.ok) {
    if (acq.error === "missing_node_id") return { ok: false, error: "missing_node_id" };
    const lock = acq.lock;
    const msg = busyMessage(lock);
    appendConsole("[post] busy_other_node: " + ((lock && lock.nodeId) || ""));
    return { ok: false, error: "busy_other_node", lock, message: msg };
  }

  /** 系统内存水位监视：记下限，收尾时打印实测峰值（跑满的是内存、不是显存） */
  let memWatch = null;
  /* 内存护栏的「这一单开始前，这台机器还剩多少」：任务之间量一次，收尾再量一次，
   * 差值就是服务进程这一单守住没还的那部分（见 ramRailVerdict）。 */
  let ramBeforeFreeGb = null;
  let ramAfterFreeGb = null;
  let ramTotalGb = null;
  try {
    appendConsole("[post] start kind=" + kind + " source=" + sourcePath);
    emitProgress({ phase: "post", nodeId, message: "正在启动后端…", pct: 2 });
    memWatch = startRamWatch();
    const ready = await ensureBackendReadyForJob();
    if (!ready.ok) {
      const err = ready.error || "backend_start_failed";
      const detail = String(ready.message || "").trim();
      clearLock();
      appendConsole("[post] backend start failed: " + err);
      if (detail) appendConsole(detail.slice(0, 2000));
      emitProgress({
        phase: "post",
        nodeId,
        message: detail ? detail.slice(0, 400) : err,
        error: true,
        pct: 0,
      });
      reportErr(err, detail || err, {
        phase: "post",
        nodeId,
        workflowId: String(req.canvasWorkflowId || ""),
        nodeKind: "video_upscale/video_interp",
      });
      return {
        ok: false,
        error: err,
        message: detail ? "启动后端失败：" + err + "\n" + detail.slice(0, 1200) : "启动后端失败：" + err,
      };
    }

    const cfg = loadConfig();
    const port = Number(ready.port) || Number(cfg.port) || DEFAULT_PORT;
    const comfy = comfyDir(cfg.installDir);

    activeGenerate = { nodeId, abort: false, promptId: "", req: null };
    /* 系统内存水位（只为把「跑满的是内存、不是显存」变成控制台里的实测数字） */
    memWatch = startRamWatch();
    /* 内存护栏的起点：这一单开工前，后端自己报的可用 / 总内存（量不到就保持 null，收尾不判） */
    try {
      const ram0 = await probeComfyRamStats(port, { reuse: false });
      ramBeforeFreeGb = ram0.free;
      ramTotalGb = ram0.total;
      if (ram0.free != null) {
        appendConsole(
          "[mem] 开工前可用内存 " +
            gb1(ram0.free) +
            "G" +
            (ram0.total != null ? " / 共 " + gb1(ram0.total) + "G" : ""),
        );
      }
    } catch {}

    /* 提交前释放生成模型（H3 DiT / VAE），后处理只留超分 / 补帧模型，压低显存峰值 */
    await comfyFreeModels(port);
    if (activeGenerate && activeGenerate.abort) throw new Error("cancelled");

    const sourceWidth = Number(req.sourceWidth) || Number(req.width) || 0;
    const sourceHeight = Number(req.sourceHeight) || Number(req.height) || 0;
    let ramFrames = 0; /* 容器里读到的真实帧数（读取失败保持 0） */
    let opts = resolvePostOptions(kind, kind === "interp" ? req.interp : req.upscale);
    if (kind === "upscale") {
      /* 引擎选路：默认逐帧流式（内存与时长无关，16G 也能跑 15 秒片）；缺脚本 / 缺 venv /
       * 显式要旧链时回退 ComfyUI 图（见 resolvePostEngine）。流式路径 PyAV 直接读源文件，
       * 不需要把源视频上传进 ComfyUI/input；图路径才需要（原逻辑挪到下面的图分支）。 */
      const venvPy = streamVenvPython(comfy);
      const streamScript = streamUpscaleScriptPath();
      const pick = resolvePostEngine(kind, opts, {
        scriptExists: !!streamScript && fs.existsSync(streamScript),
        venvExists: !!venvPy && fs.existsSync(venvPy),
      });
      opts = Object.assign({}, opts, { engine: pick.engine });
      appendConsole(
        "[post] 超分引擎 = " +
          (pick.engine === "stream" ? "逐帧流式（stream_upscale.py）" : "ComfyUI 图（兜底）") +
          " · 依据=" +
          pick.reason,
      );
      if (pick.engine === "graph") {
        appendConsole(
          "[post] 已回退图路径 · 原因=" +
            pick.reason +
            (pick.reason === "script_missing"
              ? "（缺流式脚本 " + streamScript + "）"
              : pick.reason === "venv_missing"
                ? "（缺 ComfyUI venv 解释器 " + venvPy + "）"
                : ""),
        );
      }
      /* 老节点里可能存着不带扩展名的 "RealESRGAN_x4plus"：model_name 是 combo，
       * 候选 = upscale_models 目录下的文件名，值不对 ComfyUI 直接判 value_not_in_list 拒图。
       * 这里按真实目录校正（忽略大小写 / 扩展名），仍然对不上就带着可用清单报错，别让用户猜。 */
      const m = resolveUpscaleModelForComfy(comfy, opts.model);
      const avail = Array.isArray(m.available) ? m.available : null;
      const gone = !!(avail && avail.length && !avail.includes(m.model));
      if (opts.scale === 2 && !gone && upscaleFactorOfModel(m.model) !== 2) {
        /* 选了 x2 倍率：本机有原生 x2 权重就顺手用（中间张量只有 x4 的 1/4，峰值内存直接降一档）；
         * 没有也能跑 —— 继续用 x4 权重，靠输出端的 ImageScale 缩到 2 倍，只是内存口径仍按 x4 估。 */
        const native = pickNativeX2Model(avail);
        if (native) {
          appendConsole("[post] 倍率 x2：改用原生 x2 权重 " + native + "（中间张量只有 x4 的 1/4，峰值内存最低）");
          opts = Object.assign({}, opts, { model: native });
        } else {
          appendConsole(
            "[post] 倍率 x2：本机没找到 x2 权重（" +
              POST_MODELS.upscaleX2 +
              "），用 " +
              m.model +
              " 超分后缩到 2 倍；中间张量仍按 x4 算，" +
              "想更省内存可把该权重放进 models/upscale_models 目录",
          );
          if (m.model !== opts.model) opts = Object.assign({}, opts, { model: m.model });
        }
      } else if (gone) {
        const list = avail.slice(0, 12).join("、") + (avail.length > 12 ? " …" : "");
        if (opts.scale === 2 && upscaleFactorOfModel(m.model) === 2) {
          /* 显式点名 x2 权重但本机没有：倍率本身仍然成立（x4 权重 + 输出端缩到 2 倍），
           * 不因为缺一个可选权重把整单拒掉，降级并写清楚。 */
          const fallback = resolveUpscaleModelForComfy(comfy, POST_MODELS.upscale);
          if (avail.includes(fallback.model)) {
            appendConsole(
              "[post] 倍率 x2：x2 权重 " + m.model + " 不存在（该目录可用：" + list + "），" +
                "改用 " + fallback.model + " 并在输出端缩到 2 倍",
            );
            opts = Object.assign({}, opts, { model: fallback.model });
          } else {
            throw new Error(
              "超分模型不存在：ComfyUI/models/upscale_models 里既没有 " +
                m.model +
                " 也没有 " +
                fallback.model +
                "（该目录可用：" +
                list +
                "）",
            );
          }
        } else {
          throw new Error(
            "超分模型不存在：ComfyUI/models/upscale_models 里没有 " + m.model + "（该目录可用：" + list + "）",
          );
        }
      } else if (m.model !== opts.model) {
        appendConsole("[post] upscale model 校正：" + opts.model + " → " + m.model);
        opts = Object.assign({}, opts, { model: m.model });
      }
      /* 内存闸：超分链的峰值是「整段视频的帧张量 + float32 副本」，全在系统内存里，
       * 显存反而是空的。提交前按源分辨率 + 容器里的帧数估一次：先二分目标长边，
       * 仍放不进预算就进超分前预缩放源帧（preScale），别等 64G 被跑满
       * （估不出帧数 / 读不到系统内存时原样放行，不误伤）。 */
      const ramPlan = resolveUpscaleRamPlan(
        Object.assign({}, opts, { sourcePath }),
        sourceWidth,
        sourceHeight,
      );
      if (ramPlan.meta) {
        ramFrames = ramPlan.frames || 0;
        appendConsole(
          "[post] 源视频 " +
            ramPlan.meta.width +
            "x" +
            ramPlan.meta.height +
            " · " +
            ramPlan.frames +
            " 帧 · " +
            ramPlan.meta.duration +
            "s → 预计峰值系统内存 " +
            (planGbText(ramPlan.beforeGb) || "?") +
            (ramPlan.budgetGb != null ? "（本机预算 " + ramPlan.budgetGb + "G）" : ""),
        );
      }
      if (ramPlan.stream) {
        appendConsole(
          "[post] 流式档：常驻内存只与一个 tile 有关、与时长无关（上面的估算只是旧图链口径的对照）" +
            " → 不做目标长边降档、不做 preScale · tile=" +
            opts.tile +
            " · " +
            opts.precision,
        );
      }
      if (ramPlan.downgraded) {
        const pre = Array.isArray(ramPlan.opts.preDims) ? ramPlan.opts.preDims : null;        const msg =
          "超分内存闸：按当前设置预计要 " +
          planGbText(ramPlan.beforeGb) +
          " 系统内存（源 " +
          ramPlan.meta.width +
          "x" +
          ramPlan.meta.height +
          " · " +
          ramPlan.frames +
          " 帧），" +
          (pre
            ? "已先把源帧缩到 " +
              pre[0] +
              "x" +
              pre[1] +
              "（" +
              Math.round(Number(ramPlan.opts.preScale) * 100) +
              "%）再进超分，目标长边 " +
              ramPlan.opts.targetLongSide +
              "px"
            : "已把目标长边降到 " + ramPlan.opts.targetLongSide + "px") +
          "（预计 " +
          planGbText(ramPlan.afterGb) +
          "）。峰值主项是「源像素 × 中间张量倍数²（x4 权重 = ×16 / x2 权重 = ×4）+ float32 副本」，" +
          "只跟帧数 / 源尺寸 / 超分倍率有关，所以显存空着是正常的：" +
          "超分是把帧张量攒在系统内存里、逐帧过 GPU。" +
          "想省内存可把倍率降到 x2（画面放大 2 倍，中间张量少 4 倍），" +
          "或减少帧数（缩短时长 / 降帧率）、换内存更大的机器。" +
          (ramPlan.overBudget ? "（连最小档都超出预算，本单仍有跑满内存的风险。）" : "");
        appendConsole("[post] " + msg);
        emitProgress({ phase: "post", nodeId, message: msg, pct: 4 });
        opts = ramPlan.opts;
      }
    }
    if (kind === "interp") {
      /* 引擎选路：默认逐帧流式（常驻内存只与相邻两帧 + 模型有关、与时长无关，16G 也能跑 15 秒片）；
       * 缺脚本 / 缺 venv / 缺 RIFE 权重 / 显式要旧链时回退 ComfyUI 图（见 resolvePostEngine）。
       * 流式路径 PyAV 直接读源文件，不需要先把源视频上传进 ComfyUI/input（图分支才需要）。 */
      const venvPy = streamVenvPython(comfy);
      const streamScript = streamInterpScriptPath();
      const weightsPath = streamInterpWeightsPath(comfy);
      const pick = resolvePostEngine(kind, opts, {
        scriptExists: !!streamScript && fs.existsSync(streamScript),
        venvExists: !!venvPy && fs.existsSync(venvPy),
        weightsExists: !!weightsPath,
      });
      opts = Object.assign({}, opts, { engine: pick.engine });
      appendConsole(
        "[post] 补帧引擎 = " +
          (pick.engine === "stream" ? "逐帧流式（stream_interp.py）" : "ComfyUI 图（兜底）") +
          " · 依据=" +
          pick.reason,
      );
      if (pick.engine === "graph") {
        appendConsole(
          "[post] 已回退图路径 · 原因=" +
            pick.reason +
            (pick.reason === "interp_script_missing"
              ? "（缺流式脚本 " + streamScript + "）"
              : pick.reason === "interp_venv_missing"
                ? "（缺 ComfyUI venv 解释器 " + venvPy + "）"
                : pick.reason === "interp_weights_missing"
                  ? "（缺 RIFE 权重，已搜 " +
                    join(comfy, "custom_nodes", "ComfyUI-Frame-Interpolation", "ckpts", "rife") +
                    " 与 " +
                    join(comfy, "ckpts", "rife") +
                    "）"
                  : ""),
        );
      }
      if (pick.engine === "stream") {
        /* 流式判定复用同一条纯函数（resolveUpscaleRamPlan）：它会置 plan.stream=true 后直接返回
         * ——不做 preScale、不二分目标长边、不降 multiplier。这里只取容器元数据打日志对照。 */
        const ramPlan = resolveUpscaleRamPlan(
          Object.assign({}, opts, { sourcePath }),
          sourceWidth,
          sourceHeight,
        );
        ramFrames = ramPlan.frames || 0;
        appendConsole(
          "[post] 流式补帧档：常驻内存只与相邻两帧 + 模型有关、与时长无关 → 不做预缩放 / 不降倍率" +
            " · 倍率 " +
            opts.multiplier +
            "x · " +
            opts.precision +
            (opts.maxLongSide > 0 ? " · 预缩放长边 " + opts.maxLongSide : "") +
            (ramPlan.meta
              ? " · 源 " +
                ramPlan.meta.width +
                "x" +
                ramPlan.meta.height +
                " · " +
                ramPlan.frames +
                " 帧 · " +
                ramPlan.meta.duration +
                "s"
              : ""),
        );
      }
    }
    appendConsole(
      "[post] " + (opts.engine === "stream" ? "流式档" : "24G 安全档") + " opts=" + JSON.stringify(opts),
    );

    let outPath = "";
    let meta = null;
    let lastErr = null;

    /* ── 流式超分：不吃 ComfyUI 图，直接由 venv python 逐帧出片（内存与时长无关） ── */
    if (kind === "upscale" && opts.engine === "stream") {
      const streamPy = streamVenvPython(comfy);
      const streamScript = streamUpscaleScriptPath();
      const exportDirEarly = String(req.outputDir || "").trim();
      const preferredEarly = ensureVideoExt(
        String(req.filename || "").trim() || "post_" + kind + "_" + Date.now(),
      );
      const dst = exportDirEarly
        ? uniqueFileInDir(exportDirEarly, preferredEarly, ".mp4").path
        : uniqueFileInDir(join(comfy, "output", "post"), preferredEarly, ".mp4").path;
      const streamModelPath = join(comfy, "models", "upscale_models", opts.model);
      const runOnce = () =>
        runStreamUpscaleJob({
          py: streamPy,
          script: streamScript,
          nodeId,
          sourcePath,
          outPath: dst,
          modelPath: streamModelPath,
          scale: opts.scale,
          targetLongSide: opts.targetLongSide,
          tile: opts.tile,
          overlap: opts.overlap,
          precision: opts.precision,
          crf: POST_STREAM_DEFAULT_CRF,
          preset: POST_STREAM_DEFAULT_PRESET,
          fps: Number(req.fps) || 0,
        });
      let fallbackWhy = "";
      if (!fs.existsSync(streamModelPath)) {
        /* 权重文件不在（resolveUpscaleModelForComfy 拿不到清单时会原样透传）：不白起子进程 */
        fallbackWhy = "超分权重文件不存在：" + streamModelPath;
      }
      for (let attempt = 0; attempt < 2 && !outPath && !fallbackWhy; attempt++) {
        try {
          const r = await runOnce();
          outPath = r.path;
          appendConsole(
            "[post] 流式超分完成 " +
              r.path +
              " · " +
              r.frames +
              " 帧 · 耗时 " +
              r.seconds +
              "s · 峰值内存 " +
              gb1((r.peakRamMb || 0) / 1024) +
              "G" +
              (r.peakVramMb ? " · 峰值显存 " + gb1(r.peakVramMb / 1024) + "G" : ""),
          );
        } catch (e) {
          if (
            (e && e.streamCancelled) ||
            String((e && e.message) || "") === "cancelled" ||
            (activeGenerate && activeGenerate.abort)
          ) {
            throw e;
          }
          lastErr = e;
          if (attempt === 0 && e && e.oom) {
            /* OOM 降档：流式档 = tile 减半 + 精度 fp32（不动目标长边 / 倍率），重试一次 */
            appendConsole(
              "[post] 流式超分 OOM → 降一档重试（tile 减半 + fp32）：" +
                String(e.detail || e.message).slice(0, 300),
            );
            opts = downgradePostOptions(kind, opts);
            appendConsole("[post] 降档 opts=" + JSON.stringify(opts));
            continue;
          }
          fallbackWhy = String(e.detail || e.message).slice(0, 400);
        }
      }
      if (!outPath) {
        /* 非 OOM 的流式失败（异常 / 非 0 退出）：按原样回退旧图链，并写明原因 */
        opts = Object.assign({}, opts, { engine: "graph" });
        appendConsole(
          "[post] 流式超分未出片（" +
            (fallbackWhy || String((lastErr && (lastErr.detail || lastErr.message)) || "unknown").slice(0, 400)) +
            "）→ 已回退图路径",
        );
        try {
          if (fs.existsSync(dst)) fs.rmSync(dst, { force: true });
        } catch {}
      }
    }

    /* ── 流式补帧：不吃 ComfyUI 图，直接由 venv python 逐对插帧出片（内存与时长无关） ── */
    if (kind === "interp" && opts.engine === "stream") {
      const streamPy = streamVenvPython(comfy);
      const streamScript = streamInterpScriptPath();
      const weightsPath = streamInterpWeightsPath(comfy);
      const exportDirEarly = String(req.outputDir || "").trim();
      const preferredEarly = ensureVideoExt(
        String(req.filename || "").trim() || "post_" + kind + "_" + Date.now(),
      );
      const dst = exportDirEarly
        ? uniqueFileInDir(exportDirEarly, preferredEarly, ".mp4").path
        : uniqueFileInDir(join(comfy, "output", "post"), preferredEarly, ".mp4").path;
      /* 输出帧率：与旧图链口径一致 = 源帧率 × 倍数（时长与播放速度不变，只是更顺滑）；
       * 源帧率拿不到时省略，交脚本按「容器帧率 × 倍数」自己算。 */
      const srcFps = Number(req.fps) || 0;
      const runOnce = () =>
        runStreamInterpJob({
          py: streamPy,
          script: streamScript,
          nodeId,
          sourcePath,
          outPath: dst,
          modelPath: weightsPath,
          comfyRoot: comfy,
          multiplier: opts.multiplier,
          maxLongSide: opts.maxLongSide,
          scaleFactor: opts.scaleFactor,
          precision: opts.precision,
          clearCacheEvery: opts.clearCacheEvery,
          crf: POST_STREAM_DEFAULT_CRF,
          preset: POST_STREAM_DEFAULT_PRESET,
          fps: srcFps > 0 ? srcFps * opts.multiplier : 0,
        });
      let fallbackWhy = "";
      for (let attempt = 0; attempt < 2 && !outPath && !fallbackWhy; attempt++) {
        try {
          const r = await runOnce();
          outPath = r.path;
          appendConsole(
            "[post] 流式补帧完成 " +
              r.path +
              " · " +
              r.frames +
              " 帧 · 耗时 " +
              r.seconds +
              "s · 峰值内存 " +
              gb1((r.peakRamMb || 0) / 1024) +
              "G" +
              (r.peakVramMb ? " · 峰值显存 " + gb1(r.peakVramMb / 1024) + "G" : ""),
          );
        } catch (e) {
          if (
            (e && e.streamCancelled) ||
            String((e && e.message) || "") === "cancelled" ||
            (activeGenerate && activeGenerate.abort)
          ) {
            throw e;
          }
          lastErr = e;
          if (attempt === 0 && e && e.oom) {
            /* OOM 降档：流式补帧档 = 精度落 fp32（显式给过 maxLongSide 再降一档），倍率不动，重试一次 */
            appendConsole(
              "[post] 流式补帧 OOM → 降一档重试（精度 fp32）：" +
                String(e.detail || e.message).slice(0, 300),
            );
            opts = downgradePostOptions(kind, opts);
            appendConsole("[post] 降档 opts=" + JSON.stringify(opts));
            continue;
          }
          fallbackWhy = String(e.detail || e.message).slice(0, 400);
        }
      }
      if (!outPath) {
        /* 非 OOM 的流式失败（异常 / 非 0 退出）：按原样回退旧图链，并写明原因 */
        opts = Object.assign({}, opts, { engine: "graph" });
        appendConsole(
          "[post] 流式补帧未出片（" +
            (fallbackWhy || String((lastErr && (lastErr.detail || lastErr.message)) || "unknown").slice(0, 400)) +
            "）→ 已回退图路径",
        );
        try {
          if (fs.existsSync(dst)) fs.rmSync(dst, { force: true });
        } catch {}
      }
    }
    /* ── ComfyUI 图路径（补帧 / 流式缺件 / 流式失败后的兜底）：原链一字未改 ── */
    if (!outPath) {
      /* LoadVideo 只解析 ComfyUI/input 目录内的文件名：源视频先登记进 input */
      const videoPath = await uploadFileToComfy(port, sourcePath, "video");
      appendConsole("[post] source → input/" + videoPath);
      for (let attempt = 0; attempt < 2; attempt++) {
        const graph = buildPostWorkflow({
          kind,
          videoPath,
          fps: Number(req.fps) || 24,
          bitDepth: Number(req.bitDepth) || 8,
          videoFormat: req.videoFormat || "auto",
          videoCodec: req.videoCodec || "auto",
          filenamePrefix: String(req.filenamePrefix || "").trim(),
          width: sourceWidth,
          height: sourceHeight,
          upscale: kind === "upscale" ? opts : undefined,
          interp: kind === "interp" ? opts : undefined,
        });
        try {
          meta = await submitAndWaitComfy(port, crypto.randomUUID(), graph, nodeId, "post", {
            phase: "post",
            /* 产物节点 = 图里的 SaveVideo：history 里优先认它（见 pickJobVideoMeta） */
            preferredNodeId: findVideoOutputNodeId(graph),
          });
          lastErr = null;
          break;
        } catch (e) {
          if (String((e && e.message) || "") === "cancelled" || (activeGenerate && activeGenerate.abort)) {
            throw e;
          }
          lastErr = e;
          if (attempt === 0 && isPostOomError(e)) {
            appendConsole(
              "[post] OOM → 降一档重试：" +
                String((e && (e.detail || e.message)) || e).slice(0, 300),
            );
            opts = downgradePostOptions(kind, opts);
            appendConsole("[post] 降档 opts=" + JSON.stringify(opts));
            await comfyFreeModels(port);
            continue;
          }
          throw e;
        }
      }
      if (!meta) throw lastErr || new Error("post_failed");

      outPath = comfyOutputPath(comfy, meta.filename, meta.subfolder || "");
      const exportDir = String(req.outputDir || "").trim();
      if (exportDir) {
        const preferred = String(req.filename || "").trim() || meta.filename;
        outPath = await copyOutputToDir(
          comfy,
          meta.filename,
          meta.subfolder || "",
          exportDir,
          preferred,
        );
      }
    }

    if (activeGenerate && activeGenerate.abort) throw new Error("cancelled");
    if (!outPath || !fs.existsSync(outPath)) {
      throw new Error("output_file_missing: " + (outPath || ""));
    }
    let sz = 0;
    try {
      sz = fs.statSync(outPath).size || 0;
    } catch {}
    if (sz < 64) throw new Error("output_file_empty_or_too_small: " + outPath);

    clearLock();
    activeGenerate = null;
    emitProgress({ phase: "post", nodeId, message: label + "完成", pct: 100, done: true });
    appendConsole("[post] ok kind=" + kind + " path=" + outPath + " bytes=" + sz);
    appendConsole(
      "[post] " +
        (kind === "upscale"
          ? "倍率 x" +
            normalizeUpscaleScale(opts.scale) +
            " · 模型 " +
            opts.model +
            " · 输出长边=" +
            (sourceWidth > 0 && sourceHeight > 0
              ? upscaleOutputLongSide(
                  opts.targetLongSide,
                  Math.max(sourceWidth, sourceHeight),
                  opts.scale,
                )
              : opts.targetLongSide)
          : "倍率 " + opts.multiplier + "x") +
        (Array.isArray(opts.preDims) ? " · 超分前源帧 " + opts.preDims.join("x") : "") +
        (ramFrames > 0
          ? " · " +
            ramFrames +
            " 帧" +
            (opts.engine === "stream"
              ? kind === "interp"
                ? "（流式：常驻内存只与相邻两帧有关，与时长无关）"
                : "（流式：常驻内存只与一个 tile 有关，与时长无关）"
              : " · 峰值内存估算 " +
                planGbText(estimatePostPeakRamGb(sourceWidth, sourceHeight, opts, ramFrames)))
          : "") +
        (opts.engine === "stream"
          ? kind === "interp"
            ? " · 逐帧流式补帧 · " +
              opts.precision +
              (opts.maxLongSide > 0 ? " · 预缩放长边 " + opts.maxLongSide : "")
            : " · 逐帧流式 tile=" + opts.tile + " · " + opts.precision
          : "（超分链逐帧过 GPU，占用在 RAM 不在显存）"),
    );
    appendPostRamReport(memWatch, true);
    memWatch = null;
    return { ok: true, path: outPath, message: "Saved: " + outPath, bytes: sz };
  } catch (e) {
    const err = String((e && (e.detail || e.message)) || e);
    appendConsole("[post] error: " + err);
    clearLock();
    activeGenerate = null;
    emitProgress({ phase: "post", nodeId, message: err, error: true, pct: 0 });
    reportErr(err, err, {
      phase: "post",
      nodeId,
      workflowId: String(req.canvasWorkflowId || ""),
      nodeKind: "video_upscale/video_interp",
    });
    appendPostRamReport(memWatch, false);
    memWatch = null;
    return { ok: false, error: err, message: err };
  } finally {
    if (memWatch) appendPostRamReport(memWatch, false);
    /* 服务常驻：不重启后端，只释放模型显存，避免下次重新加载慢 */
    try {
      const cfg = loadConfig();
      const freePort = Number(cfg.port) || DEFAULT_PORT;
      await comfyFreeModels(freePort);
      appendConsole("[post] vram released");
      /* 内存护栏：/free 只卸模型、不清 glibc arena —— 刚这一单积下的帧张量缓存未必还回系统。
       * 这里量一次「任务之后还剩多少」，与任务开始时那次比较：
       * 服务守住超过一半内存 / 本机已低于硬闸 → 把后端回收掉（后台等空闲再重启，不阻塞本次回执）。
       * 判据只认后端自己报的 fact（同口径），量不到就一条都不动。 */
      ramAfterFreeGb = (await probeComfyRamStats(freePort, { reuse: false })).free;
      if (cfg.optRebuildOnRamHigh !== false && ramAfterFreeGb != null && ramBeforeFreeGb != null) {
        const v = ramRailVerdict(ramBeforeFreeGb, ramAfterFreeGb, ramTotalGb);
        appendConsole(
          "[mem] 这一单结束后：可用 " +
            (v.afterGb == null ? "?" : v.afterGb + "G") +
            " / 共 " +
            (v.totalGb == null ? "?" : v.totalGb + "G") +
            " · 服务这一单守住约 " +
            (v.keptGb == null ? "?" : v.keptGb + "G") +
            (v.keptPct == null ? "" : "（" + v.keptPct + "% 内存）") +
            (v.recycle ? " → 触发回收" : " → 未触发回收"),
        );
        if (v.recycle) {
          await recycleBackendForRam(
            "超分 / 补帧后服务守住 " +
              (v.keptGb == null ? "?" : v.keptGb + "G") +
              "（可用只剩 " +
              (v.afterGb == null ? "?" : v.afterGb + "G") +
              "），重启后端把内存还给系统",
          );
        }
      }
    } catch (e) {
      appendConsole("[post] free warn: " + String((e && e.message) || e));
    }
  }
}

function uploadFileToComfy(port, filePath, kind) {
  return new Promise((resolve, reject) => {
    const name = path.basename(filePath);
    const data = fs.readFileSync(filePath);
    const boundary = "----H3Boundary" + crypto.randomBytes(8).toString("hex");
    const fieldName = kind === "audio" ? "image" : "image"; // Comfy upload endpoint uses image field
    const preamble = Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="${fieldName}"; filename="${name}"\r\n` +
        `Content-Type: application/octet-stream\r\n\r\n`,
    );
    const mid = Buffer.from(
      `\r\n--${boundary}\r\nContent-Disposition: form-data; name="overwrite"\r\n\r\ntrue` +
        `\r\n--${boundary}\r\nContent-Disposition: form-data; name="type"\r\n\r\ninput\r\n` +
        `--${boundary}--\r\n`,
    );
    const body = Buffer.concat([preamble, data, mid]);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/upload/image",
        method: "POST",
        headers: {
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": body.length,
        },
        timeout: 120000,
      },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          try {
            const j = JSON.parse(buf);
            resolve(j.name || j.filename || name);
          } catch (e) {
            reject(new Error("upload_parse: " + buf.slice(0, 200)));
          }
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("upload_timeout"));
    });
    req.write(body);
    req.end();
  });
}

async function copyOutputToDir(comfy, filename, subfolder, exportDir, preferredName) {
  mk(exportDir);
  /* 后端回报的 subfolder 与实际落点可能不一致（自建工作流的 filename_prefix 层级最常见），
   *  先按实际位置找，别一上来就 output_missing。 */
  const src = comfyOutputPath(comfy, filename, subfolder);
  if (!fs.existsSync(src))
    throw new Error(
      "output_missing: " +
        src +
        "（后端回报的产物是 output/" +
        (subfolder ? subfolder + "/" : "") +
        filename +
        "，但该文件不存在——请到 ComfyUI 输出目录确认产物是否真的生成）",
    );
  let destName = preferredName || path.basename(filename);
  if (!JOB_VIDEO_EXT_RE.test(destName)) {
    const srcExt = path.extname(filename) || ".mp4";
    destName += srcExt;
  }
  const uniq = uniqueFileInDir(exportDir, destName, path.extname(destName) || ".mp4");
  fs.copyFileSync(src, uniq.path);
  if (uniq.renamed) {
    appendConsole("[job] target existed → saved as " + uniq.filename);
  }
  return uniq.path;
}

/* ── 产物 take 编号：目标文件已存在时固定用 #1、#2 … 标「第几个 take」 ──
 *  旧版本固定贴 _1，且渲染层把改名后的路径写回节点，于是同一路径反复跑会叠成 foo_1_1_1。
 *  这里统一：先剥掉末尾的 take 标记（#N 认号，_N / _0N 当旧标记剥掉），
 *  再从「上一个号 + 1」起找第一个空号 —— 号只增不减，绝不叠加后缀。 */
function takeStemParts(stem) {
  let base = String(stem || "");
  let from = 0;
  for (let k = 0; k < 8; k++) {
    const hash = base.match(/#(\d+)$/);
    if (hash) {
      const n = Number(hash[1]);
      if (!from && n > 0) from = n;
      base = base.slice(0, -hash[0].length);
      continue;
    }
    const legacy = base.match(/_0*[1-9]\d{0,2}$/);
    if (legacy) {
      base = base.slice(0, -legacy[0].length);
      continue;
    }
    break;
  }
  return { base: base || String(stem || ""), from };
}

function uniqueFileInDir(dir, preferredName, defaultExt) {
  mk(dir);
  let name = String(preferredName || "").trim() || "out" + (defaultExt || "");
  const extMatch = name.match(/(\.[a-z0-9]+)$/i);
  const ext = (extMatch && extMatch[1]) || defaultExt || "";
  const stem = ext ? name.slice(0, -ext.length) : name;
  const baseStem = stem || "out";
  if (!extMatch && ext) name = baseStem + ext;
  let dest = join(dir, name);
  if (!fs.existsSync(dest)) return { path: dest, filename: name, renamed: false };
  const tk = takeStemParts(baseStem);
  const head = tk.base || baseStem;
  for (let i = tk.from + 1; i < tk.from + 10000; i++) {
    const fn = head + "#" + i + ext;
    dest = join(dir, fn);
    if (!fs.existsSync(dest)) return { path: dest, filename: fn, renamed: true };
  }
  throw new Error("unique_filename_exhausted");
}

function isSageDisabledMode(mode) {
  return /^(disabled|off|none|false|0)?$/i.test(String(mode == null ? "disabled" : mode).trim());
}

/* ── Sage Attention（注意力加速）自检与补装 ────────────────────────────────
 * 为什么判据不是 `import sageattention` 一条就够（原来只判这一条）：
 *   · sageattention 的 core 在 **import 期**就 `from .triton.… import …` 拉 Triton kernel；
 *     Windows 上 PyPI 没有 `triton`（Linux-only），只装 sageattention 不装 triton-windows
 *     一样 import 失败 —— 两个包必须成对。
 *   · sm89（4090）走的是预编译 CUDA 内核 `_qattn_sm89`；架构不在内核白名单里等于没加速。
 *   · 判错的代价很大：工作流里挂了 PathchSageAttentionKJ 而包实际不可用时，ComfyUI 在
 *     /prompt 校验阶段就炸（invalid prompt: prompt_outputs_failed_validation），整次生成白跑。
 * 所以一次 python 探测同时报出 py / torch / cuda / sm / triton / sage 六项事实，
 * 结果缓存 10 分钟（import torch 要几秒，状态刷新每 4 秒一次，绝不能每次都探）。 */
const SAGE_PROBE_TTL_MS = 10 * 60 * 1000;
const SAGE_SUPPORTED_SM = ["sm75", "sm80", "sm86", "sm87", "sm89", "sm90", "sm100", "sm120", "sm121"];
const SAGE_RELEASE_API = "https://api.github.com/repos/woct0rdho/SageAttention/releases?per_page=30";
const SAGE_RELEASE_PAGE = "https://github.com/woct0rdho/SageAttention/releases";
/** 文件名事实：sageattention-2.2.0+cu130torch2.9.1.post6-cp310-abi3-win_amd64.whl
 *  （cuNNN = CUDA 13 与 12 不通用；abi3 = Python 稳定 ABI，cpX-abi3 支持 python >= X） */
const SAGE_WHEEL_RE =
  /^sageattention-(\d+\.\d+(?:\.\d+)?)\+cu(\d+)torch(\d+)\.(\d+)(?:\.(\d+))?(andhigher)?(?:\.post(\d+))?-(cp\d+)-(abi3|cp\d+)-win_amd64\.whl$/;
/** triton 与 torch 的配套（torch 自带哪个 triton，Windows 就得装对应大版本的 triton-windows） */
const TORCH_TRITON = { "2.5": "3.1", "2.6": "3.2", "2.7": "3.3", "2.8": "3.4", "2.9": "3.5", "2.10": "3.6" };

const SAGE_PROBE_PY = [
  "import json, sys",
  "o = {'py': '%d.%d' % sys.version_info[:2], 'torch': '', 'cuda': '', 'sm': '', 'triton': '', 'sage': '', 'why': ''}",
  "ws = []",
  "try:",
  "    import torch",
  "    o['torch'] = str(torch.__version__)",
  "    o['cuda'] = str(torch.version.cuda or '')",
  "    if torch.cuda.is_available():",
  "        o['sm'] = 'sm%d%d' % torch.cuda.get_device_capability(0)",
  "except Exception as e:",
  "    ws.append('torch:' + type(e).__name__)",
  "try:",
  "    import triton",
  "    o['triton'] = str(getattr(triton, '__version__', '') or 'yes')",
  "except Exception as e:",
  "    ws.append('triton:' + type(e).__name__)",
  "try:",
  "    import sageattention",
  "    o['sage'] = str(getattr(sageattention, '__version__', ''))",
  "    if not o['sage'] or o['sage'] == 'unknown':",
  "        from importlib.metadata import version as _v",
  "        o['sage'] = str(_v('sageattention'))",
  "except Exception as e:",
  "    ws.append('sage:' + type(e).__name__)",
  "o['archOk'] = (not o['sm']) or (o['sm'] in " + JSON.stringify(SAGE_SUPPORTED_SM) + ")",
  "if not o['archOk']:",
  "    ws.append('arch:' + o['sm'])",
  "o['why'] = ','.join(ws)",
  "o['ok'] = bool(o['triton'] and o['sage'] and o['archOk'])",
  "print(json.dumps(o))",
].join("\n");

/** 小尺寸真跑一次 kernel：能 import 不等于能算（缺对应架构的 .pyd 时是调用期才炸）。 */
const SAGE_SMOKE_PY = [
  "import json",
  "r = {'ok': False, 'why': ''}",
  "try:",
  "    import torch",
  "    from sageattention import sageattn",
  "    if not torch.cuda.is_available():",
  "        r = {'ok': False, 'why': 'no_gpu'}",
  "    else:",
  "        q = torch.randn(1, 2, 128, 64, device='cuda', dtype=torch.float16)",
  "        o = sageattn(q, q, q, tensor_layout='NHD')",
  "        torch.cuda.synchronize()",
  "        r = {'ok': bool(torch.isfinite(o.float()).all().item()), 'why': '' if bool(torch.isfinite(o.float()).all().item()) else 'nonfinite'}",
  "except Exception as e:",
  "    r = {'ok': False, 'why': type(e).__name__ + ': ' + str(e)[:180]}",
  "print(json.dumps(r))",
].join("\n");

function vparts(s) {
  const m = String(s || "").match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] || 0)] : [];
}
function vcmp(a, b) {
  a = a || [];
  b = b || [];
  for (let i = 0; i < 3; i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** 从 GitHub release 资产里挑「与本 venv 配套」的那枚 wheel：
 *  CUDA 大版本必须一致，Python 走 abi3 下限 / 精确 tag，torch 精确同 minor 优先于 andhigher。 */
function pickSageWheel(releases, want) {
  const w = want || {};
  const wt = w.torch && w.torch.length ? w.torch : [];
  const out = [];
  for (const rel of Array.isArray(releases) ? releases : []) {
    for (const a of (rel && Array.isArray(rel.assets) ? rel.assets : [])) {
      const file = String((a && a.name) || "");
      const m = SAGE_WHEEL_RE.exec(file);
      if (!m) continue;
      const abi3 = m[9] === "abi3";
      /* "cp310" → minor 10，"cp39" → minor 9：Python 版本 tag 是 cp + 去点的版本号 */
      const cpMinor = Number(String(m[8]).slice(3));
      if (abi3 ? cpMinor > w.pyMinor : cpMinor !== w.pyMinor) continue;
      const cu = Number(m[2]);
      /* 轮子名里是三位数 CUDA（cu128 / cu130）→ 大版本 = 去掉末位 minor：130 → 13、128 → 12 */
      if (w.cudaMajor && Math.floor(cu / 10) !== w.cudaMajor) continue;
      const base = [Number(m[3]), Number(m[4]), Number(m[5] || 0)];
      const andHigher = !!m[6];
      let score;
      if (andHigher) {
        if (wt.length && vcmp(wt, base) < 0) continue;
        score = 1;
      } else {
        if (wt.length && (wt[0] !== base[0] || wt[1] !== base[1])) continue;
        score = 2;
      }
      out.push({
        file,
        url: String(a.browser_download_url || ""),
        pkgVer: m[1],
        cu: "cu" + cu,
        torchRaw: m[3] + "." + m[4] + (m[5] ? "." + m[5] : "") + (andHigher ? "andhigher" : ""),
        post: Number(m[7] || 0),
        abi3,
        score,
        release: String((rel && rel.tag_name) || ""),
      });
    }
  }
  out.sort((x, y) =>
    vcmp(vparts(y.pkgVer), vparts(x.pkgVer)) ||
    y.score - x.score ||
    y.post - x.post ||
    String(y.release).localeCompare(String(x.release)),
  );
  return out[0] || null;
}

function tritonWindowsSpec(torchParts) {
  const key = (torchParts && torchParts.length ? torchParts[0] + "." + torchParts[1] : "") || "";
  const t = TORCH_TRITON[key];
  return t ? "triton-windows==" + t + ".*" : "triton-windows";
}

let _sageProbe = null;
let _sageProbeRun = null;
let _sageProbeDir = "";

function invalidateSageProbe() {
  _sageProbe = null;
}
/** 缓存必须绑定安装目录：换目录 = 换 venv，旧目录「已装齐」的结论对新目录一律不成立。 */
function sageProbeFresh(dir) {
  return !!(_sageProbe && _sageProbeDir === String(dir || "") && Date.now() - _sageProbe.at < SAGE_PROBE_TTL_MS);
}
function parseSageProbe(out, code) {
  const lines = String(out || "").split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const L = lines[i].trim();
    if (!L.startsWith("{")) continue;
    try {
      const j = JSON.parse(L);
      return Object.assign({ probed: true, ok: false, why: "" }, j);
    } catch {}
  }
  return {
    probed: true,
    ok: false,
    why: "probe_failed(" + (code == null ? "?" : code) + "): " + String(out || "").slice(-160).replace(/\r?\n/g, " "),
  };
}
/** 跑一次真探测并写缓存（探完广播，管理窗自己刷新）。 */
async function runSageProbe(installDir) {
  const py = comfyVenvPython(installDir);
  let value;
  if (!py) value = { probed: true, ok: false, why: "no_venv" };
  else {
    const r = await runVenvPy(py, SAGE_PROBE_PY);
    value = parseSageProbe(r.out, r.code);
  }
  _sageProbe = { at: Date.now(), value };
  _sageProbeDir = String(installDir || "");
  broadcast("h3:sageChanged", value);
  return value;
}
/** 状态读的是缓存；过期就后台补一次，绝不把 4 秒一次的状态刷新堵在 python import 上。 */
function ensureSageProbe(installDir) {
  if (sageProbeFresh(installDir)) return Promise.resolve(_sageProbe.value);
  if (_sageProbeRun) return _sageProbeRun;
  _sageProbeRun = runSageProbe(installDir).finally(() => {
    _sageProbeRun = null;
  });
  return _sageProbeRun;
}
function readSageProbe(installDir) {
  if (!sageProbeFresh(installDir)) ensureSageProbe(installDir);
  return _sageProbe ? _sageProbe.value : { probed: false, ok: false, why: "checking" };
}

/** 缺包时给用户的口径：既说清后果（自动跳过 Sage，不是报错），也给出点哪儿能修好。
 *  why 由探测脚本按 torch / triton / sage / arch 逐项拼出来 —— 报准那一项，用户才知道补什么。 */
function sageMissingHint(probe) {
  const why = probe && probe.why ? String(probe.why) : "";
  if (/^arch:/.test(why)) return "（本机 GPU " + why.slice(5) + " 不在 Sage 支持列表，这一档优化跳过）";
  if (/no_venv/.test(why)) return "（venv 还没装好：先点「安装」）";
  if (/^probe_failed/.test(why)) return "（自检没跑通：" + why.slice(0, 120) + "）";
  let need = "加速包";
  const miss = [];
  if (/triton/.test(why)) miss.push("triton-windows");
  if (/sage/.test(why)) miss.push("sageattention");
  if (miss.length) need = miss.join(" + ");
  else if (/torch/.test(why)) need = "torch 环境";
  return (
    "（缺 " +
    need +
    "）Windows 上需 triton-windows + 匹配本机 torch/CUDA 的 sageattention 预编译 wheel，" +
    "在 H3 插件窗点「Sage 加速」可一键补装"
  );
}

/** 缺 sageattention 时强制 disabled，避免 PathchSageAttentionKJ 必炸。 */
async function resolveSageModeForGenerate(requested, installDir, optSageAttn) {
  if (optSageAttn === false) return "disabled";
  const mode =
    String(requested == null || requested === "" ? "auto" : requested).trim() || "auto";
  if (isSageDisabledMode(mode)) return "disabled";
  const py = comfyVenvPython(installDir);
  if (!py) {
    appendConsole("[generate] no venv → sageMode=disabled");
    return "disabled";
  }
  const probe = await ensureSageProbe(installDir);
  if (!probe || !probe.ok) {
    appendConsole(
      "[generate] sageattention missing → sageMode=disabled (was " +
        mode +
        ")。" +
        sageMissingHint(probe) +
        "，装好可提速约 1.5-2×",
    );
    return "disabled";
  }
  return mode === "disabled" ? "auto" : mode;
}

function runVenvPip(py, args, opts) {
  opts = opts || {};
  return new Promise((resolve) => {
    const env = Object.assign({}, process.env, { PIP_DISABLE_PIP_VERSION_CHECK: "1" });
    if (process.env.MT_H3_PIP_INDEX) env.PIP_INDEX_URL = process.env.MT_H3_PIP_INDEX;
    else if (!env.PIP_INDEX_URL) env.PIP_INDEX_URL = "https://pypi.tuna.tsinghua.edu.cn/simple";
    const full = ["-m", "pip", "install", "--isolated", ...args];
    appendConsole("$ venv pip install --isolated " + args.join(" "));
    const child = spawn(py, full, { windowsHide: true, env });
    let out = "";
    const onData = (d) => {
      const s = d.toString();
      out += s;
      for (const line of s.split(/\r?\n/)) {
        const t = line.trim();
        if (t) appendConsole("[pip] " + t);
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", (e) => resolve({ code: 1, out: out + "\n" + String((e && e.message) || e) }));
    child.on("close", (c) => resolve({ code: c || 0, out }));
  });
}

function pipFailTail(out) {
  const lines = String(out || "").split(/\r?\n/).filter((l) => l.trim());
  return lines.slice(-4).join(" / ").slice(-400);
}

/** 一键补装注意力加速：triton-windows + 与本 venv 配套的 sageattention 预编译 wheel，
 *  装完立刻按生成期的同一口径自检。走的是 pip 直装（几秒），不占 Agent 轮次；
 *  失败时把原因与「自我修复」这条兜底路一起回给界面。 */
async function installSageAttention(opts) {
  opts = opts || {};
  if (installing) return { ok: false, error: "busy", message: "已有安装 / 修复任务在跑，先等它结束。" };
  const cfg = loadConfig();
  const safe = isSafeInstallDir(cfg.installDir);
  if (!safe.ok) return { ok: false, error: safe.error || "bad_dir" };
  const installDir = safe.path;
  const py = comfyVenvPython(installDir);
  if (!py) {
    return { ok: false, error: "no_venv", message: "还没有 ComfyUI venv：请先点「安装」装好后端，再补加速包。" };
  }
  if (backendRunning()) {
    return {
      ok: false,
      error: "backend_running",
      message: "后端正在运行，往用着的 venv 里写包不安全：请先点「手动停止」再补装。",
    };
  }
  const say = (message, pct) =>
    emitProgress({ phase: "install", step: "sage", stepLabel: "补装 Sage 加速", message, pct });
  const bump = () => {
    if (installCancel) throw new Error("cancelled");
  };
  installing = true;
  installCancel = false;
  try {
    say("读取 venv 里的 torch / CUDA / Python…", 6);
    invalidateSageProbe();
    const before = await ensureSageProbe(installDir);
    if (before && before.ok && !opts.force) {
      return {
        ok: true,
        already: true,
        sage: before,
        message: "Sage 加速已就绪（sageattention " + before.sage + " · triton " + before.triton + " · " + (before.sm || "?") + "），无需补装。",
      };
    }
    bump();
    const want = {
      pyMinor: Number(String((before && before.py) || "").split(".")[1]) || 10,
      torch: vparts(before && before.torch),
      cudaMajor: Number(String((before && before.cuda) || "").split(".")[0]) || 0,
    };
    if (want.torch.length < 2) {
      throw new Error(
        "venv 里 import torch 失败（" + ((before && before.why) || "unknown") + "）：请先点「自我修复」修好环境再补加速包。",
      );
    }
    /* 1) triton：sageattention 的量化 kernel 是 Triton 写的，Windows 上没有它 import 就失败 */
    if (before && before.triton) {
      say("triton " + before.triton + " 已在，跳过", 26);
    } else {
      const spec = tritonWindowsSpec(want.torch);
      say("pip install " + spec + " …", 26);
      let r = await runVenvPip(py, [spec]);
      if (r.code !== 0 && spec !== "triton-windows") {
        appendConsole("[sage] pinned triton-windows failed → retry latest");
        r = await runVenvPip(py, ["triton-windows"]);
      }
      if (r.code !== 0) throw new Error("triton-windows 安装失败：" + pipFailTail(r.out));
    }
    bump();
    /* 2) sageattention：PyPI 上只有老的 1.0.6（v1 且要现编译），2.x 走预编译 wheel */
    say("查 " + SAGE_RELEASE_PAGE + " 上匹配的 wheel…", 40);
    let picked = null;
    try {
      const rel = JSON.parse((await fetchBuffer(SAGE_RELEASE_API, null, 25000)).toString("utf8"));
      picked = pickSageWheel(rel, want);
    } catch (e) {
      appendConsole("[sage] release lookup failed: " + String((e && e.message) || e));
    }
    if (!picked) {
      throw new Error(
        "没找到匹配 Python 3." + want.pyMinor + " / torch " + want.torch.join(".") + " / CUDA " +
          (want.cudaMajor || "?") + " 的 sageattention 预编译 wheel（GitHub 不通或本机版本组合没出轮子）。" +
          "可点「自我修复」让 Agent 代装，或手动下载 " + SAGE_RELEASE_PAGE,
      );
    }
    say("下载 " + picked.file + " …", 48);
    const buf = await fetchBuffer(
      picked.url,
      (p) => {
        if (!p || !p.total) return;
        emitProgress({
          phase: "install",
          step: "sage",
          stepLabel: "补装 Sage 加速",
          message: "下载 " + picked.file,
          pct: 48 + Math.min(28, Math.round((p.got / p.total) * 28)),
        });
      },
      600000,
    );
    bump();
    const tmpDir = join(app.getPath("temp"), "mtnode-h3-sage");
    mk(tmpDir);
    const wheelPath = join(tmpDir, picked.file);
    fs.writeFileSync(wheelPath, buf);
    say("pip 安装 sageattention " + picked.pkgVer + "（" + picked.cu + " · torch" + picked.torchRaw + "）…", 80);
    const r2 = await runVenvPip(py, ["--no-deps", "--force-reinstall", wheelPath]);
    if (r2.code !== 0) throw new Error("sageattention 安装失败：" + pipFailTail(r2.out));
    /* 3) 自检：先按生成期同一口径探一遍，再真跑一次小 kernel（能 import ≠ 能算） */
    say("自检：import + 小尺寸 kernel 试跑…", 92);
    invalidateSageProbe();
    const after = await ensureSageProbe(installDir);
    if (!after || !after.ok) {
      throw new Error("装完自检仍不可用：" + ((after && after.why) || "probe_failed"));
    }
    const sm = await runVenvPy(py, SAGE_SMOKE_PY);
    const smoke = parseSageProbe(sm.out, sm.code);
    if (!smoke.ok) appendConsole("[sage] kernel smoke warn: " + smoke.why + "（import 正常；生成时若报错请点「自我修复」）");
    appendConsole(
      "[sage] ready: sageattention " + after.sage + " + triton " + after.triton + " @ " + (after.sm || "?"),
    );
    emitProgress({
      phase: "install",
      step: "done",
      stepLabel: "补装 Sage 加速",
      message: "Sage 加速已就绪" + (smoke.ok ? "（kernel 试跑通过）" : "（kernel 试跑有警告，见 Console）"),
      pct: 100,
    });
    return {
      ok: true,
      sage: after,
      kernelOk: !!smoke.ok,
      wheel: picked.file,
      message:
        "Sage 加速已装好：sageattention " + after.sage + " · triton " + after.triton + " · " + (after.sm || "?") +
        (smoke.ok ? " · kernel 试跑通过" : ""),
    };
  } catch (e) {
    const msg = String((e && e.message) || e);
    appendConsole("[sage] install failed: " + msg);
    emitProgress({ phase: "install", step: "error", stepLabel: "补装 Sage 加速", message: msg, pct: 0, error: true });
    reportErr("sage_install_failed", "补装 Sage 加速失败：" + msg, { phase: "install" });
    return { ok: false, error: msg === "cancelled" ? "cancelled" : "sage_install_failed", message: msg };
  } finally {
    installing = false;
    invalidateSageProbe();
    ensureSageProbe(installDir);
  }
}

/** 视频产物扩展名：ComfyUI 把「输入文件预览」与「保存下来的成片」塞在同一个 images 数组里，
 *  只能靠扩展名 + type 分辨（type = input / temp 的是预览，output 的才是产物）。 */
const JOB_VIDEO_EXT_RE = /\.(mp4|webm|mkv|mov)$/i;

/** 本次执行该认的产物节点 = 图里最后一个视频类 Save* 节点（多 Save 时末段即最终成片）。
 *  在 history outputs 里优先认它，避免抓成输入预览。 */
function findVideoOutputNodeId(graph) {
  let last = "";
  for (const [nid, n] of Object.entries(h3wf.isPlainObject(graph) ? graph : {})) {
    if (h3wf.isVideoOutputClass(n && n.class_type)) last = String(nid);
  }
  return last;
}

/** history 条目是否「输入 / 临时预览」（LoadVideo、LoadImage 这类带 ui 预览的输入节点也会进 history）。 */
function isInputPreviewEntry(it) {
  const t = String((it && it.type) || "").toLowerCase();
  return t === "input" || t === "temp";
}

/** 内置图（生成 / 超分 / 补帧）的产物判定：从一次执行的 history outputs 里挑「真正保存下来的视频」。
 *  为什么不能照旧「按节点顺序取第一个带 .mp4 的条目」：
 *  新版 ComfyUI 里 SaveVideo 与 LoadVideo 的 ui 都是 PreviewVideo，as_dict() 一律写成
 *  { images:[{filename,subfolder,type}], animated:[true] }（没有 videos 键，老代码那条判据恒空），
 *  而非产物节点只要返回过 ui 就会进 history。补帧 / 超分图第一步就是 LoadVideo（源视频先 upload
 *  进 ComfyUI/input，它回报的文件名就是那个上传名），节点编号又最小 → 「第一个 mp4」命中的是
 *  输入预览（type:"input"、subfolder:""），于是拿 input 里的源文件名去 output 根目录找 →
 *  output_missing: …\ComfyUI\output\1_1_1_1.mp4（真实成片其实在 …\ComfyUI\output\video\…）。
 *  r2v 带参考视频时同样走 LoadVideo，所以生成链也走这里。
 *  规则：① 只认视频扩展名；② 丢掉 input / temp 预览（宁可报「没有产物」，也不把源视频当产物拷出去）；
 *  ③ preferredNodeId（Save* 节点）命中即用；④ 否则取最后一个。 */
function pickJobVideoMeta(outputs, preferredNodeId) {
  const src = h3wf.isPlainObject(outputs) ? outputs : {};
  const found = [];
  for (const [nid, o] of Object.entries(src)) {
    if (!h3wf.isPlainObject(o)) continue;
    for (const key of ["videos", "gifs", "images"]) {
      const arr = o[key];
      if (!Array.isArray(arr)) continue;
      for (const it of arr) {
        if (!h3wf.isPlainObject(it)) continue;
        const fn = String(it.filename || "");
        if (!JOB_VIDEO_EXT_RE.test(fn) || isInputPreviewEntry(it)) continue;
        found.push({ nodeId: String(nid), filename: fn, subfolder: String(it.subfolder || ""), type: String(it.type || "") });
      }
    }
  }
  if (!found.length) return null;
  const pref = String(preferredNodeId || "");
  if (pref) {
    const hit = found.filter((f) => f.nodeId === pref);
    if (hit.length) return hit[hit.length - 1];
  }
  return found[found.length - 1];
}

/** 在 dir 下按文件名找实际落点（有限深度 / 有限条目，命中多个取最近修改的）。找不到返回 ""。 */
function findFileUnder(dir, name, maxDepth, budget) {
  const want = String(name || "").toLowerCase();
  if (!dir || !want) return "";
  let left = Number(budget) || 4000;
  const limit = Number(maxDepth) || 3;
  const stack = [{ d: dir, depth: 0 }];
  let hit = "";
  let hitM = -1;
  while (stack.length && left-- > 0) {
    const cur = stack.pop();
    if (cur.depth > limit) continue;
    let items = [];
    try {
      items = fs.readdirSync(cur.d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const it of items) {
      if (left-- <= 0) break;
      const p = join(cur.d, it.name);
      if (it.isDirectory()) {
        stack.push({ d: p, depth: cur.depth + 1 });
        continue;
      }
      if (String(it.name).toLowerCase() !== want) continue;
      let m = 0;
      try {
        m = fs.statSync(p).mtimeMs || 0;
      } catch {}
      if (!hit || m >= hitM) {
        hit = p;
        hitM = m;
      }
    }
  }
  return hit;
}

/** ComfyUI 产物的真实路径：先按后端回报的 subfolder/filename 原样拼；对不上就在 output 下
 *  按文件名找一次（自建工作流的 filename_prefix 层级、或后端另配了 output 子目录都会导致
 *  回报路径与拼接路径不一致）。都找不到时仍返回原拼法，让调用方报出「后端说它在哪」。 */
function comfyOutputPath(comfy, filename, subfolder) {
  const exact = join(comfy, "output", subfolder || "", String(filename || ""));
  if (filename && fs.existsSync(exact)) return exact;
  const hit = findFileUnder(join(comfy, "output"), filename, 3, 4000);
  if (hit) {
    appendConsole(
      "[out] 后端回报的产物位置 output/" + (subfolder ? subfolder + "/" : "") + filename + " 不存在，改用实际落点 " + hit,
    );
    return hit;
  }
  return exact;
}

/** 收集一次执行的全部产物（自定义工作流用）：按节点/类别归集，默认取最后一个视频类产物。
 *  @returns {{meta:Object|null, collected:Array<{nodeId,kind,filename,subfolder,type}>}} */
function collectJobOutputs(outputs, preferredNodeId) {
  const found = [];
  for (const [nid, o] of Object.entries(h3wf.isPlainObject(outputs) ? outputs : {})) {
    const push = (kind, arr) => {
      if (!Array.isArray(arr)) return;
      for (const it of arr) {
        if (it && typeof it === "object" && !isInputPreviewEntry(it)) found.push({ nodeId: String(nid), kind, filename: String(it.filename || ""), subfolder: String(it.subfolder || ""), type: String(it.type || "") });
      }
    };
    push("video", o && o.videos);
    push("gif", o && o.gifs);
    push("audio", o && o.audio);
    const imgs = Array.isArray(o && o.images) ? o.images : [];
    for (const im of imgs) {
      if (!im || typeof im !== "object") continue;
      if (isInputPreviewEntry(im)) continue;
      const fn = String(im.filename || "");
      let kind = "image";
      if (/\.(gif)$/i.test(fn)) kind = "gif";
      else if (/\.(webp)$/i.test(fn)) kind = "webp";
      else if (JOB_VIDEO_EXT_RE.test(fn)) kind = "video";
      found.push({ nodeId: String(nid), kind, filename: fn, subfolder: String(im.subfolder || ""), type: String(im.type || "") });
    }
  }
  if (!found.length) return { meta: null, collected: found };
  const byId = (kinds) => found.filter((f) => String(f.nodeId) === preferredNodeId && kinds.includes(f.kind));
  if (preferredNodeId) {
    const hit = byId(["video"]).length ? byId(["video"]) : byId(["gif", "webp"]).length ? byId(["gif", "webp"]) : byId(["audio", "image"]);
    if (hit.length) return { meta: hit[0], collected: found };
  }
  const videos = found.filter((f) => f.kind === "video");
  if (videos.length) return { meta: videos[videos.length - 1], collected: found };
  const gifs = found.filter((f) => f.kind === "gif" || f.kind === "webp");
  if (gifs.length) return { meta: gifs[gifs.length - 1], collected: found };
  return { meta: found[found.length - 1], collected: found };
}

/** 把 /prompt 拒绝响应解析成节点/字段级可读错误。
 *  ComfyUI 的 message 常常只有一句「Value not in list」，真正有用的信息在
 *  errors[].details（收到了什么值、可选值有哪些）与 errors[].extra_info.input_name（是哪个字段）。
 *  一条 errors 出一行，不再只留第一条。 */
function parsePromptRejection(postedJson) {
  const j = h3wf.isPlainObject(postedJson) ? postedJson : {};
  const out = [];
  const ne = h3wf.isPlainObject(j.node_errors) ? j.node_errors : {};
  for (const [nid, rawErr] of Object.entries(ne)) {
    const e = h3wf.isPlainObject(rawErr) ? rawErr : {};
    const errs = Array.isArray(e.errors) ? e.errors : null;
    if (!errs || !errs.length) {
      out.push({
        nodeId: String(nid),
        classType: String(e.class_type || ""),
        input: String(e.input || ""),
        type: String(e.error_type || ""),
        message: errs ? String(JSON.stringify(errs)).slice(0, 300) : "",
        details: "",
      });
      continue;
    }
    for (const raw of errs) {
      const one = h3wf.isPlainObject(raw)
        ? raw
        : { message: typeof raw === "string" ? raw : String(JSON.stringify(raw)) };
      const extra = h3wf.isPlainObject(one.extra_info) ? one.extra_info : {};
      out.push({
        nodeId: String(nid),
        classType: String(e.class_type || ""),
        input: String(extra.input_name || e.input || ""),
        type: String(one.type || e.error_type || ""),
        message: String(one.message || ""),
        details: String(one.details || ""),
      });
    }
  }
  if (!out.length) {
    const em = j.error && typeof j.error === "object" ? String(j.error.message || "") : "";
    out.push({ nodeId: "", classType: "", input: "", type: "", message: em || String(j.error || "") || "未知错误", details: "" });
  }
  return out;
}

function formatPromptRejection(postedJson, workflowTitle) {
  const list = parsePromptRejection(postedJson);
  const head = "ComfyUI 拒绝了工作流" + (workflowTitle ? "（" + workflowTitle + "）" : "") + "：";
  if (!list.length) return head + "无详细信息";
  const lines = list.map((x) => {
    const where = [x.nodeId && "节点 " + x.nodeId, x.classType && ("(" + x.classType + ")"), x.input && ("字段 " + x.input), x.type && ("[" + x.type + "]")].filter(Boolean).join(" ");
    let msg = x.message || "未知错误";
    const details = String(x.details || "").trim();
    if (details && !msg.includes(details)) {
      msg += "：" + (details.length > 300 ? details.slice(0, 300) + "…" : details);
    }
    return (where ? where + "：" : "") + msg;
  });
  return head + "\n" + lines.join("\n");
}

/** 已知 ComfyUI 报错签名 → 中文可执行提示（只在 detail 末尾追加，不替换原文）。 */
const COMFY_SIGNATURE_HINTS = Object.freeze([
  {
    re: /No audio stream found in the file\.?/i,
    hint: "音频素材无音轨：该文件里没有可读的音频轨道，请改接到 视频N 端子，或换一个含音轨的文件",
  },
  {
    re: /expected m1 and m2 to have the same dtype/i,
    hint: "建议关闭 CPU VAE（后端设置里的 --cpu-vae），或改回内置模板的 VAE 组合",
  },
  {
    re: /value_not_in_list|Value not in list/i,
    hint: "该字段是下拉候选，取值必须是后端本机目录里真实存在的文件名（含扩展名，如 RealESRGAN_x4plus.pth）：把模型文件放进对应目录，或改回括号里列出的名字",
  },
]);

function humanizeComfySignature(text) {
  const s = String(text || "");
  if (!s) return "";
  const out = [];
  for (const it of COMFY_SIGNATURE_HINTS) {
    if (it.re.test(s)) out.push(it.hint);
  }
  return out.join("；");
}

/** 取 traceback 末行（execution_error 里 exception_message 偶尔为空时的兜底）。 */
function lastTracebackLine(traceback) {
  const tb = Array.isArray(traceback) ? traceback : [];
  for (let i = tb.length - 1; i >= 0; i--) {
    const line = String(tb[i] == null ? "" : tb[i]).trim();
    if (line) return line;
  }
  return "";
}

/** 把 history.status.messages 里的 execution_error 摘成可读原因行。
 *  status_str 只有一句 'error'，真正有用的 node_id / node_type / exception_type /
 *  exception_message（必要时 traceback 末行兜底）都在 execution_error 条目里。 */
function parseExecutionErrorMessages(st) {
  const msgs = (st && Array.isArray(st.messages) && st.messages) || [];
  const out = [];
  for (const m of msgs) {
    if (!m || m[0] !== "execution_error") continue;
    const d = h3wf.isPlainObject(m[1]) ? m[1] : {};
    const where = [
      d.node_id != null && d.node_id !== "" ? "节点 " + d.node_id : "",
      d.node_type ? "（" + d.node_type + "）" : "",
    ]
      .filter(Boolean)
      .join(" ");
    const etype = String(d.exception_type || "").trim();
    let msg = String(d.exception_message || "").trim();
    if (!msg) msg = lastTracebackLine(d.traceback);
    let text = (where ? where + "：" : "") + ([etype, msg].filter(Boolean).join(": ") || "未知错误");
    const hint = humanizeComfySignature(etype + " " + msg);
    if (hint) text += "｜" + hint;
    out.push(text);
  }
  return out;
}

/** MP4 家族容器的音轨嗅探（只读盒结构，不解码）。
 *  返回 { isMp4:true, hasAudio:boolean }；非 MP4 家族 / moov 缺失 / 读失败一律返回 null（不拦截）。 */
function sniffMp4AudioTrack(filePath) {
  let fd = null;
  try {
    fd = fs.openSync(filePath, "r");
    const size = fs.fstatSync(fd).size;
    if (!size || size < 16) return null;
    /* 头部 64KB 认首个盒子；尾部 1MB 兜底（非 faststart 的 moov 常挂在文件尾） */
    const headLen = Math.min(65536, size);
    const head = Buffer.alloc(headLen);
    fs.readSync(fd, head, 0, headLen, 0);
    const firstType = head.length >= 8 ? head.toString("latin1", 4, 8) : "";
    if (!["ftyp", "moov", "free", "skip", "wide"].includes(firstType)) return null;
    let tail = Buffer.alloc(0);
    let tailStart = 0;
    if (size > headLen) {
      const tailLen = Math.min(1 << 20, size - headLen);
      tail = Buffer.alloc(tailLen);
      fs.readSync(fd, tail, 0, tailLen, size - tailLen);
      tailStart = size - tailLen;
    }
    const findMoov = (buf, base) => {
      const s = buf.toString("latin1");
      for (let i = 0; i + 8 <= s.length; i++) {
        if (s.slice(i + 4, i + 8) === "moov") return base + i;
      }
      return -1;
    };
    let moovAbs = findMoov(head, 0);
    if (moovAbs < 0 && tail.length) moovAbs = findMoov(tail, tailStart);
    if (moovAbs < 0) return null;
    const hdrLen = Math.min(16, size - moovAbs);
    const hdr = Buffer.alloc(hdrLen);
    const got = fs.readSync(fd, hdr, 0, hdrLen, moovAbs);
    const parsed = readMp4BoxHeader(hdr.subarray(0, got), 0);
    if (!parsed || parsed.type !== "moov") return null;
    const moovLen = Math.min(parsed.size, 64 * 1024 * 1024, size - moovAbs);
    if (moovLen < parsed.header) return null;
    const moov = Buffer.alloc(moovLen);
    fs.readSync(fd, moov, 0, moovLen, moovAbs);
    let hasSoun = false;
    eachMp4Box(moov, parsed.header, moovLen, (t, ps, pe) => {
      if (t !== "trak") return;
      eachMp4Box(moov, ps, pe, (t2, ps2, pe2) => {
        if (t2 !== "mdia") return;
        eachMp4Box(moov, ps2, pe2, (t3, ps3, pe3) => {
          /* hdlr 载荷：version+flags(4) predefined(4) handler_type(4) */
          if (t3 === "hdlr" && ps3 + 12 <= pe3 && moov.toString("latin1", ps3 + 8, ps3 + 12) === "soun") {
            hasSoun = true;
          }
        });
      });
    });
    return { isMp4: true, hasAudio: hasSoun };
  } catch {
    return null;
  } finally {
    if (fd != null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

/** MP4 盒头：返回 { type, size, header }；size==1 走 64 位，size==0 到结尾。 */
function readMp4BoxHeader(buf, pos) {
  if (!buf || pos + 8 > buf.length) return null;
  let size = buf.readUInt32BE(pos);
  const type = buf.toString("latin1", pos + 4, pos + 8);
  let header = 8;
  if (size === 1) {
    if (pos + 16 > buf.length) return null;
    size = buf.readUInt32BE(pos + 8) * 4294967296 + buf.readUInt32BE(pos + 12);
    header = 16;
  } else if (size === 0) {
    size = buf.length - pos;
  }
  if (size < header) return null;
  return { type, size, header };
}

/** 顺序遍历 [start,end) 内的同级盒，回调 (type, payloadStart, boxEnd)。 */
function eachMp4Box(buf, start, end, fn) {
  let pos = start;
  while (pos + 8 <= end) {
    const h = readMp4BoxHeader(buf, pos);
    if (!h) return;
    const payloadStart = pos + h.header;
    const boxEnd = Math.min(end, pos + h.size);
    if (boxEnd <= pos) return;
    fn(h.type, payloadStart, boxEnd);
    pos = boxEnd;
  }
}

/** 提交 ComfyUI workflow 并轮询等待完成，返回输出视频 meta（filename/subfolder）。
 *  stage 用于日志与进度文案（"gen" | "post" | "custom"）。
 *  opts: { collect:boolean, preferredNodeId:string, workflowTitle:string } —— collect 时返回
 *  { videoMeta, collected }（收集任意 Save* 产物）；否则保持原行为只返回 videoMeta。 */
async function submitAndWaitComfy(port, clientId, promptGraph, nodeId, stage, opts) {
  const options = opts && typeof opts === "object" ? opts : {};
  const label = stage === "post" ? "后处理" : stage === "custom" ? "自建工作流" : "生成";
  /* 进度相位：独立后处理任务走 phase='post'（节点自己的进度条），其余一律 'generate' */
  const progPhase = options.phase === "post" ? "post" : "generate";
  emitProgress({ phase: progPhase, nodeId, message: "提交 " + label + "…", pct: 12 });
  appendConsole("comfy prompt submit (" + stage + ")");
  const posted = await httpJson(
    "POST",
    `http://127.0.0.1:${port}/prompt`,
    { prompt: promptGraph, client_id: clientId },
    60000,
  );
  if (!posted.json || posted.json.error) {
    const err = new Error("comfy_prompt_rejected");
    err.detail = formatPromptRejection(posted.json, options.workflowTitle);
    throw err;
  }
  const promptId = posted.json.prompt_id;
  activeGenerate.promptId = promptId;
  appendConsole("prompt_id=" + promptId);

  const collect = !!options.collect;
  const preferredNodeId = String(options.preferredNodeId || "");
  const wsWatch = openComfyProgressWs(port, clientId, nodeId);
  const deadline = Date.now() + GENERATE_MAX_MS;
  let videoMeta = null;
  let collected = null;
  try {
    while (Date.now() < deadline) {
      if (activeGenerate && activeGenerate.abort) {
        try {
          await interruptComfy(port, promptId);
        } catch {}
        throw new Error("cancelled");
      }
      let hist;
      try {
        hist = await httpJson(
          "GET",
          `http://127.0.0.1:${port}/history/${encodeURIComponent(promptId)}`,
          null,
          20000,
        );
      } catch (e) {
        const msg = String((e && e.message) || e);
        if (msg === "cancelled" || (activeGenerate && activeGenerate.abort))
          throw new Error("cancelled");
        throw e;
      }
      const item = hist.json && hist.json[promptId];
      if (item) {
        const st = item.status || {};
        if (
          st.status_str === "error" ||
          (st.messages || []).some((m) => m && m[0] === "execution_error")
        ) {
          const err = new Error(stage === "post" ? "post_execution_error" : "comfy_execution_error");
          /* 节点上直接显示真实原因：节点/类型/异常/消息（traceback 末行兜底），不再只给裸状态码 */
          const reasons = parseExecutionErrorMessages(st);
          const head = "ComfyUI 执行出错" + (options.workflowTitle ? "（" + options.workflowTitle + "）" : "") + "：";
          err.detail = reasons.length ? head + "\n" + reasons.join("\n") : head + "后端未给出具体原因";
          throw err;
        }
        if (st.completed || item.outputs) {
          const outputs = item.outputs || {};
          if (collect) {
            const r = collectJobOutputs(outputs, preferredNodeId);
            if (r.meta) {
              videoMeta = r.meta;
              collected = r.collected;
              break;
            }
            if (st.completed) throw new Error("no_workflow_output");
          } else {
            /* 产物判定见 pickJobVideoMeta：「取第一个 mp4」会抓成 LoadVideo 的输入预览 */
            videoMeta = pickJobVideoMeta(outputs, preferredNodeId);
            if (videoMeta) break;
            if (st.completed) throw new Error(stage === "post" ? "no_post_output" : "no_video_output");
          }
        }
        /* history 中的真实 progress（若有） */
        const msgs = st.messages || [];
        for (let i = msgs.length - 1; i >= 0; i--) {
          const m = msgs[i];
          if (m && m[0] === "progress" && m[1]) {
            const v = Number(m[1].value) || 0;
            const max = Math.max(1, Number(m[1].max) || 1);
            const pct = Math.min(92, 15 + Math.floor((v / max) * 75));
            emitProgress({
              phase: progPhase,
              nodeId,
              message: (stage === "post" ? "后处理 " : stage === "custom" ? "执行 " : "采样 ") + v + "/" + max,
              pct,
            });
            break;
          }
        }
      }
      await sleepAbortable(2500);
    }
  } finally {
    if (wsWatch) wsWatch.close();
  }
  if (!videoMeta) throw new Error("generate_timeout");
  return collect ? { videoMeta, collected } : videoMeta;
}

/** 释放 ComfyUI 全部模型（阶段间调用，确保前一步的 H3/VAE 完全卸载）。 */
async function comfyFreeModels(port) {
  appendConsole("[post] freeing all models (POST /free)…");
  try {
    await httpJson("POST", `http://127.0.0.1:${port}/free`, { unload_models: true, free_memory: true }, 30000);
    appendConsole("[post] models freed");
  } catch (e) {
    appendConsole("[post] /free warn: " + String((e && e.message) || e));
  }
  await sleep(1500);
}

/** h3:generate 的路由判定 —— 「这个任务走不走自建工作流分支」的唯一真源。
 *  自建 = params.customWorkflowId（H3 工作流库 id，由 video_gen 节点选择）；
 *  内置 FL2VA / R2V 链下发时带的是 **画布** id（params.canvasWorkflowId），
 *  它跟库 id 曾经挤在同一个 workflowId 键上，见非空即分叉 → 内置任务必报
 *  「工作流不存在（id=wf_…）」。现在只认 customWorkflowId；
 *  兜底：老载荷只带 workflowId 时，必须它在本机库里真存在才算自建（画布 id 不可能命中）。 */
function resolveCustomWorkflowId(params) {
  const o = params && typeof params === "object" ? params : {};
  const direct = String(o.customWorkflowId || "").trim();
  if (direct) return direct;
  const legacy = String(o.workflowId || "").trim();
  if (!legacy) return "";
  try {
    return workflowStore().get(legacy) ? legacy : "";
  } catch {
    return "";
  }
}

/** 库里查不到该 id 时的人话报错：区分「没选 / 选了但库里已经没有了」，并给出现有可选项。 */
function customWorkflowMissingMessage(wfId) {
  const id = String(wfId || "").trim();
  if (!id) return "未选择自建工作流（id 为空），请在 video_gen 节点设置窗里重新选择。";
  let titles = [];
  try {
    titles = workflowStore()
      .list()
      .map((it) => String((it && it.title) || ""))
      .filter(Boolean);
  } catch {}
  return (
    "自建工作流不存在（id=" +
    id +
    "）：该条目不在本机 H3 工作流库里（可能已在管理窗口删除，或换了机器）。" +
    "请在 video_gen 节点设置窗的「自建 ComfyUI 工作流」里重新选择" +
    (titles.length
      ? "（库内现有：" + titles.slice(0, 6).join("、") + (titles.length > 6 ? " …" : "") + "）"
      : "，或先到 H3 管理窗口的「自建工作流」导入。")
  );
}

async function generateVideo(params) {
  params = params || {};
  const nodeId = String(params.nodeId || "");
  if (!nodeId) return { ok: false, error: "missing_node_id" };

  /* 自建库 id 与画布 id 各走各的键（见 resolveCustomWorkflowId 注释） */
  const customWfId = resolveCustomWorkflowId(params);

  /* 自建 id 在库里已经不存在 → 就地拒绝：不白等 ComfyUI 启动（分钟级），也不白占全局媒体锁 */
  if (customWfId) {
    let known = true;
    try {
      known = !!workflowStore().get(customWfId);
    } catch {
      known = true; /* 库读取出错交给执行分支报真实原因，别在这里误判 */
    }
    if (!known) {
      const msg = customWorkflowMissingMessage(customWfId);
      appendConsole("[job] reject: " + msg);
      emitProgress({ phase: "generate", nodeId, message: msg, error: true, pct: 0 });
      reportErr("custom_workflow_missing", msg, {
        phase: "generate",
        nodeId,
        workflowId: String(params.canvasWorkflowId || ""),
        nodeKind: "video_gen",
      });
      return { ok: false, error: "custom_workflow_missing", message: msg };
    }
  }

  const acq = tryAcquireLock({
    nodeId,
    workflowId: String(params.canvasWorkflowId || "").trim() || customWfId,
    kind: "video_gen",
  });
  if (!acq.ok) {
    if (acq.error === "missing_node_id") return { ok: false, error: "missing_node_id" };
    const lock = acq.lock;
    const msg = busyMessage(lock);
    appendConsole("[job] busy_other_node: " + (lock && lock.nodeId ? lock.nodeId : ""));
    return {
      ok: false,
      error: "busy_other_node",
      lock,
      message: msg,
    };
  }

  try {
    appendConsole("[job] start → generate → verify → stop");
    emitProgress({
      phase: "generate",
      nodeId,
      message: "正在启动后端…",
      pct: 2,
    });
    const ready = await ensureBackendReadyForJob();
    if (!ready.ok) {
      const err = ready.error || "backend_start_failed";
      const detail = String(ready.message || "").trim();
      clearLock();
      appendConsole("[job] backend start failed: " + err);
      if (detail) appendConsole(detail.slice(0, 2000));
      emitProgress({
        phase: "generate",
        nodeId,
        message: detail ? detail.slice(0, 400) : err,
        error: true,
        pct: 0,
      });
      reportErr(err, detail || err, {
        phase: "generate",
        nodeId,
        workflowId: String(params.canvasWorkflowId || ""),
        nodeKind: "video_gen",
      });
      return {
        ok: false,
        error: err,
        message: detail
          ? "启动后端失败：" + err + "\n" + detail.slice(0, 1200)
          : "启动后端失败：" + err,
      };
    }

    const cfg = loadConfig();
    const port = Number(ready.port) || Number(cfg.port) || DEFAULT_PORT;

    activeGenerate = { nodeId, abort: false, promptId: "", req: null };
    emitProgress({ phase: "generate", nodeId, message: "准备工作流…", pct: 5 });

    const installDir = cfg.installDir;
    const comfy = comfyDir(installDir);

    /* 自建工作流：customWorkflowId（H3 库 id）非空 → 走独立执行分支 runCustomWorkflow。
     * 内置 FL2VA / R2V 生成链一字不动（超分 / 补帧已拆到 h3:postProcess，两分支都不再串跑）。 */
    if (customWfId) {
      return await runCustomWorkflow({ params, port, installDir, comfy, wfId: customWfId });
    }

    const sig = projectSignals(installDir);
    const ratio = params.ratio || "16:9";
    let wh = RATIOS[ratio] || RATIOS["16:9"];
    /* 输出分辨率档位：480p / 720p / 1080p（按比例缩放，短边对齐目标） */
    const outRes = String(params.outputRes || "auto").trim().toLowerCase();
    if (outRes !== "auto" && outRes !== "") {
      const targetShort = outRes === "480p" ? 480 : outRes === "720p" ? 720 : outRes === "1080p" ? 1080 : 0;
      if (targetShort > 0) {
        const [bw, bh] = wh;
        const short = Math.min(bw, bh);
        const scale = targetShort / short;
        let tw = Math.round((bw * scale) / 32) * 32;
        let th = Math.round((bh * scale) / 32) * 32;
        if (tw % 2) tw += 1;
        if (th % 2) th += 1;
        appendConsole(
          "[generate] outputRes=" + outRes + " → " + tw + "x" + th + "（原 " + bw + "x" + bh + "）",
        );
        wh = [tw, th];
      }
    }
    /* 24G 红线保护：长边或面积超限时钳制到安全档（避免 1344×768 类卡死）。
     * 先限长边，再等比缩到面积 ≤ 安全值，保证任何比例都不超显存。 */
    let [rw, rh] = wh;
    const clamp32 = (v) => {
      let x = Math.round(v / 32) * 32;
      if (x % 2) x += 1;
      return x;
    };
    if (Math.max(rw, rh) > VRAM_SAFE_MAX_DIM || (rw * rh) / 1e6 > VRAM_SAFE_MAX_MP) {
      const scale = Math.min(VRAM_SAFE_MAX_DIM / Math.max(rw, rh), Math.sqrt(VRAM_SAFE_MAX_MP * 1e6 / (rw * rh)));
      rw = clamp32(rw * scale);
      rh = clamp32(rh * scale);
      appendConsole(
        "[generate] 分辨率超 24G 安全上限，钳制为 " + rw + "x" + rh,
      );
      wh = [rw, rh];
    }
    const duration = Math.max(4, Math.min(15, Number(params.duration) || 5));
    const length = calcLength(duration);
    const mode = params.mode === "fl2va" ? "fl2va" : "r2v";

    const uploaded = { refs: [], videos: [], audios: [] };
    if (mode === "fl2va") {
      if (params.firstImage && fs.existsSync(params.firstImage)) {
        uploaded.first = await uploadFileToComfy(port, params.firstImage, "image");
      }
      if (params.lastImage && fs.existsSync(params.lastImage)) {
        uploaded.last = await uploadFileToComfy(port, params.lastImage, "image");
      }
    } else {
      for (const p of params.refImages || []) {
        if (p && fs.existsSync(p)) uploaded.refs.push(await uploadFileToComfy(port, p, "image"));
      }
      for (const p of params.refVideos || []) {
        if (p && fs.existsSync(p)) uploaded.videos.push(await uploadFileToComfy(port, p, "video"));
      }
      for (const p of params.refAudios || []) {
        if (p && fs.existsSync(p)) uploaded.audios.push(await uploadFileToComfy(port, p, "audio"));
      }
    }
    /* 分段衔接（FL2VA / R2V 通用，两种模式的用法见 buildH3Workflow 里的衔接子图注释）：
     * 上一段成片登记进 ComfyUI input —— LoadVideo 只认 input 目录里的文件名。
     * 文件不存在只记一行日志并跳过引导，不报错、不影响本段正常生成。 */
    const chainPath = String(params.chainVideoPath || "").trim();
    if (chainPath) {
      if (fs.existsSync(chainPath)) {
        uploaded.chain = await uploadFileToComfy(port, chainPath, "video");
        appendConsole("[generate] chain source → input/" + uploaded.chain);
      } else {
        appendConsole("[generate] 衔接视频不存在，已跳过段间引导：" + chainPath);
      }
    }

    if (activeGenerate && activeGenerate.abort) throw new Error("cancelled");

    const optSageAttn = params.optSageAttn !== false;
    const sageMode = await resolveSageModeForGenerate(params.sageMode, installDir, optSageAttn);

    const wfParams = {
      mode,
      prompt: String(params.prompt || ""),
      width: Number(params.width) || wh[0],
      height: Number(params.height) || wh[1],
      length,
      seed: Number(params.seed) || 0,
      steps: Number(params.steps) || 20,
      sampler: params.sampler || "res_multistep",
      scheduler: params.scheduler || "simple",
      denoise: params.denoise != null ? Number(params.denoise) : 1,
      shiftVideo: params.shiftVideo != null ? Number(params.shiftVideo) : 12,
      shiftAudio: params.shiftAudio != null ? Number(params.shiftAudio) : 3,
      optEasyCache: params.optEasyCache !== false,
      easyReuse: clampNum(params.easyReuse, EASY_SAFE.reuse.min, EASY_SAFE.reuse.max, EASY_SAFE.reuse.value),
      easyStart: clampNum(params.easyStart, EASY_SAFE.start.min, EASY_SAFE.start.max, EASY_SAFE.start.value),
      easyEnd: clampNum(params.easyEnd, EASY_SAFE.end.min, EASY_SAFE.end.max, EASY_SAFE.end.value),
      optLowVramAttn: params.optLowVramAttn !== false,
      lowVramHeadChunks: params.lowVramHeadChunks != null ? Number(params.lowVramHeadChunks) : 4,
      optChunkFfn: params.optChunkFfn !== false,
      chunkFfnChunks: params.chunkFfnChunks != null ? Number(params.chunkFfnChunks) : 2,
      chunkFfnSeqThreshold:
        params.chunkFfnSeqThreshold != null ? Number(params.chunkFfnSeqThreshold) : 4096,
      optVramBarrier: params.optVramBarrier !== false,
      optSageAttn,
      sageMode,
      sageCompile: !!params.sageCompile,
      fps: Number(params.fps) || 24,
      bitDepth: Number(params.bitDepth) || 8,
      videoFormat: params.videoFormat || "auto",
      videoCodec: params.videoCodec || "auto",
      filenamePrefix: params.filenamePrefix || "video/MiniMax_H3",
      refImageSize: params.refImageSize || "match",
      hasRef2va: sig.hasRef2va,
      /* 分段衔接（长视频无缝衔接）：成片走 uploaded.chain，这里只带两个数值参数 */
      chainFrames: params.chainFrames != null ? Number(params.chainFrames) : 22,
      chainDenoise: params.chainDenoise != null ? Number(params.chainDenoise) : 1,
    };

    const clientId = crypto.randomUUID();
    /* 生成只出原生分辨率视频：超分 / 补帧已拆成独立后处理任务
     * （h3:postProcess → video_upscale / video_interp 节点），此处不再串跑后处理。
     * 老画布残留的 postEnabled / postInterp* 字段一律忽略，不报错。 */
    const graphNotes = {};
    const promptGraph = buildH3Workflow(wfParams, uploaded, graphNotes);
    /* 分段衔接在 R2V 下占了第几路参考视频（连满时会顶替 V3）→ 落控制台，绝不静默丢 */
    if (graphNotes.chainVideo) appendConsole("[generate] " + graphNotes.chainVideo);
    const finalVideoMeta = await submitAndWaitComfy(port, clientId, promptGraph, nodeId, "gen", {
      /* r2v 的参考视频同样走 LoadVideo → 优先认图里的 Save* 节点，别抓成输入预览 */
      preferredNodeId: findVideoOutputNodeId(promptGraph),
    });

    let outPath = comfyOutputPath(comfy, finalVideoMeta.filename, finalVideoMeta.subfolder || "");
    const exportDir = String(params.outputDir || "").trim();
    if (exportDir) {
      const preferred = String(params.filename || "").trim() || finalVideoMeta.filename;
      outPath = await copyOutputToDir(
        comfy,
        finalVideoMeta.filename,
        finalVideoMeta.subfolder || "",
        exportDir,
        preferred,
      );
    }

    if (activeGenerate && activeGenerate.abort) throw new Error("cancelled");
    if (!outPath || !fs.existsSync(outPath)) {
      throw new Error("output_file_missing: " + (outPath || ""));
    }
    let sz = 0;
    try {
      sz = fs.statSync(outPath).size || 0;
    } catch {}
    if (sz < 64) throw new Error("output_file_empty_or_too_small: " + outPath);

    clearLock();
    activeGenerate = null;
    emitProgress({ phase: "generate", nodeId, message: "完成", pct: 100, done: true });
    appendConsole("[job] ok path=" + outPath + " bytes=" + sz);
    return { ok: true, path: outPath, message: "Saved: " + outPath, bytes: sz };
  } catch (e) {
    const err = String((e && (e.detail || e.message)) || e);
    appendConsole("[job] error: " + err);
    clearLock();
    activeGenerate = null;
    emitProgress({ phase: "generate", nodeId, message: err, error: true, pct: 0 });
    reportErr(err, err, {
      phase: "generate",
      nodeId,
      workflowId: String(params.canvasWorkflowId || ""),
      nodeKind: "video_gen",
    });
    return { ok: false, error: err, message: err };
  } finally {
    /* 服务常驻：不重启后端；生成结束后释放全部模型显存（H3 DiT / VAE），
     * 避免下次生成重新加载慢 + 显存碎片导致卡死。 */
    appendConsole("[job] backend kept alive, freeing models…");
    try {
      const cfg = loadConfig();
      const freePort = Number(cfg.port) || DEFAULT_PORT;
      await comfyFreeModels(freePort);
      appendConsole("[job] vram released");
    } catch (e) {
      appendConsole("[job] free warn: " + String((e && e.message) || e));
    }
  }
}

/* ───────────── 自建 ComfyUI 工作流（任务 2–4） ───────────── */

/** 库实例：应用内注入 dataDir（与 main.js userData 一致） */
function workflowStore() {
  return h3wf.sharedStore(getDataDir());
}

let _objectInfoCache = { port: 0, data: null, at: 0 };
/** 拉取 ComfyUI /object_info（2 分钟缓存；后端未启动返回 null 而非失败） */
async function fetchObjectInfo(port) {
  const p = Number(port) || DEFAULT_PORT;
  if (_objectInfoCache.port === p && _objectInfoCache.data && Date.now() - _objectInfoCache.at < 120000) {
    return _objectInfoCache.data;
  }
  let data = null;
  try {
    const r = await httpJson("GET", `http://127.0.0.1:${p}/object_info`, null, 30000, { track: false });
    data = r.json && typeof r.json === "object" && !Array.isArray(r.json) ? r.json : null;
  } catch (e) {
    appendConsole("[wf] object_info unavailable: " + String((e && e.message) || e));
    data = null;
  }
  _objectInfoCache = { port: p, data, at: Date.now() };
  return data;
}

/** combo（下拉）字段的落点目录提示：命中就给「请往 ComfyUI/models/<目录> 放文件」的可执行文案。
 *  只覆盖 H3 / 南风常用的几类；没命中的字段退回通用文案，不猜目录。 */
const COMBO_FOLDER_HINTS = [
  { re: /潜空间放大模型|latent_upscale/i, dir: "latent_upscale_models", note: "南风节点要求必填，占位文件即可" },
  { re: /文本编码器|text_encoder|clip/i, dir: "text_encoders" },
  { re: /lora/i, dir: "loras" },
  { re: /vae/i, dir: "vae" },
  { re: /放大|upscale|esrgan/i, dir: "upscale_models" },
  { re: /模型|unet|diffusion|checkpoint/i, dir: "diffusion_models" },
];

function comboFolderTip(field) {
  const f = String(field || "");
  for (const h of COMBO_FOLDER_HINTS) {
    if (h.re.test(f)) {
      return (
        "请往 ComfyUI/models/" + h.dir + " 放入至少一个文件" + (h.note ? "（" + h.note + "）" : "") + "，然后刷新"
      );
    }
  }
  return "该字段是必填下拉，请把对应的模型文件放进 ComfyUI 的模型目录（或在 ComfyUI 里刷新）后重试";
}

/** 从 /object_info 的一条输入定义里认出 combo：老式 ["a","b"] 与新式 ["COMBO",{options:[…]}] 都认。
 *  非 combo（"STRING" / "INT" 等）返回 null。 */
function comboOptionsOf(spec) {
  if (!Array.isArray(spec) || !spec.length) return null;
  const meta = h3wf.isPlainObject(spec[1]) ? spec[1] : {};
  const head = spec[0];
  if (Array.isArray(head)) return { options: head.map(String), meta };
  if (typeof head === "string" && head.toUpperCase() === "COMBO") {
    const list = Array.isArray(meta.options) ? meta.options : [];
    return { options: list.map(String), meta };
  }
  return null;
}

/** 必填 combo 空值运行时自愈。
 *  已入列的旧库记录里会残留空串下拉值（面板保存时的默认空值），ComfyUI 会以
 *  「Value not in list」直接拒单；随包 JSON 的修改不会回滚这些已入列记录，所以运行时补一次。
 *  刻意只处理「值 === ""」：非空但不存在的值（模型名拼写错误等）照旧让 ComfyUI 报错，不掩盖真实问题。
 *  返回 { graph, fixed }；某 combo 一个选项都没有时抛可执行的中文错误。 */
function healEmptyComboInputs(graph, objectInfo) {
  const fixed = [];
  if (!objectInfo || !h3wf.isPlainObject(graph)) return { graph, fixed };
  for (const [nid, node] of Object.entries(graph)) {
    const nodeObj = h3wf.isPlainObject(node) ? node : null;
    const cls = nodeObj ? String(nodeObj.class_type || "") : "";
    const inputs = nodeObj && h3wf.isPlainObject(nodeObj.inputs) ? nodeObj.inputs : null;
    const info = cls && h3wf.isPlainObject(objectInfo[cls]) ? objectInfo[cls] : null;
    const infoInput = info && h3wf.isPlainObject(info.input) ? info.input : null;
    if (!inputs || !infoInput) continue;
    const schema = {
      ...(h3wf.isPlainObject(infoInput.required) ? infoInput.required : {}),
      ...(h3wf.isPlainObject(infoInput.optional) ? infoInput.optional : {}),
    };
    for (const [field, raw] of Object.entries(inputs)) {
      if (raw !== "") continue;
      const combo = comboOptionsOf(schema[field]);
      if (!combo) continue;
      /* 空串本身就是合法选项（可选下拉）时不动它 */
      if (combo.options.some((o) => String(o).trim() === "")) continue;
      const options = combo.options.filter((o) => String(o).trim() !== "");
      if (!options.length) {
        throw new Error(
          field + " 没有可选模型：" + comboFolderTip(field) + "（节点 " + nid + " · " + cls + "）",
        );
      }
      const def = combo.meta && combo.meta.default != null ? String(combo.meta.default) : "";
      const next = def && options.includes(def) ? def : options[0];
      inputs[field] = next;
      fixed.push({ nodeId: String(nid), classType: cls, field, to: next });
      appendConsole("[wf] 必填下拉空值自愈：" + nid + "." + field + " \"\" → " + next);
    }
  }
  return { graph, fixed };
}

/** /object_info 节点包校验：缺自定义节点 → 警告但不阻断（写入库条目 validation） */
async function validateWorkflowRecord(id) {
  const store = workflowStore();
  const rec = store.get(String(id || ""));
  if (!rec) return { ok: false, error: "工作流不存在：" + String(id || "") };
  const cfg = loadConfig();
  const port = Number(cfg.port) || DEFAULT_PORT;
  const info = await fetchObjectInfo(port);
  const checkedAt = new Date().toISOString();
  if (!info) {
    store.setValidation(rec.id, { status: "skipped", checkedAt, error: "后端未运行，跳过校验" });
    return { ok: true, status: "skipped", message: "后端未运行，跳过校验（警告不阻断）" };
  }
  const graph = rec.graph || {};
  const missingMap = new Map();
  for (const [nid, node] of Object.entries(graph)) {
    const cls = node && node.class_type;
    if (!cls) continue;
    if (!info[cls]) {
      if (!missingMap.has(cls)) missingMap.set(cls, []);
      missingMap.get(cls).push(String(nid));
    }
  }
  const missing = [...missingMap.entries()].map(([class_type, nodeIds]) => ({ class_type, nodeIds }));
  const status = missing.length ? "missing_nodes" : "ok";
  store.setValidation(rec.id, { status, checkedAt, missing });
  return {
    ok: true,
    status,
    missing,
    message: missing.length
      ? "缺 " + missing.length + " 个节点包：" + missing.map((m) => m.class_type).join("、")
      : "校验通过：全部节点均可识别",
  };
}

/** 内置模板的素材落点键名：ref_image_N / ref_video_N / ref_audio_N（N 从 0 起）。 */
const H3_REF_ALIAS_RE = /^ref_(image|video|audio)_(\d+)$/;

/**
 * 素材落点改写（南风中文控件）：参数表里可能还留着内置模板的英文落点
 * （ref_image_N / ref_video_N / ref_audio_N），而目标 H3 节点是
 * NanFengH3MultiReferenceGeneratorV10 —— 它的控件是中文键「图片N / 视频N / 音频N」
 * （N 从 1 起，键名真源在 h3-workflows.js 的 nanfengMaterialField）。
 * 只有「英文键不在该节点 inputs 里、且对应中文键在」时才改写，内置两条模板
 * （MiniMaxH3ImageToVideo / MiniMaxH3ReferenceToVideo）的英文键原样保留、行为不变。
 * 必须在 h3wf.normalizeParams 之前调用：后者会把图中不存在的字段判为错误。
 */
function remapNanFengRefFields(graph, params) {
  const list = Array.isArray(params) ? params : [];
  return list.map((p) => {
    const src = (p && p.source) || {};
    const node = graph && graph[String(src.nodeId || "")];
    const field = String(src.field || "");
    const m = H3_REF_ALIAS_RE.exec(field);
    if (!m || !h3wf.isPlainObject(node && node.inputs) || field in node.inputs) return p;
    const cn = h3wf.nanfengMaterialField(m[1], Number(m[2]));
    if (!cn || !(cn in node.inputs)) return p;
    appendConsole("[wf] 素材落点 " + src.nodeId + "." + field + " → " + cn);
    return { ...p, source: { nodeId: String(src.nodeId), field: cn } };
  });
}

/** 自建工作流执行分支（generateVideo 分叉入口）。
 *  单阶段：不追加 4K 超分补帧、不做 24G 钳制、不读 duration/outputRes/post/postEnabled。
 *  抽卡（attempts）/ 进度 / 取消沿用现有链路（activeGenerate + emitProgress + interruptComfy）。 */
async function runCustomWorkflow(ctx) {
  const { params, port, installDir, comfy } = ctx;
  const nodeId = String(params.nodeId || "");
  const store = workflowStore();
  const wfId = String(ctx.wfId || resolveCustomWorkflowId(params) || "").trim();
  const rec = store.get(wfId);
  if (!rec) throw new Error(customWorkflowMissingMessage(wfId));
  const graph = rec.graph || {};
  const scan = h3wf.scanGraph(graph);
  const wfTitle = rec.title || wfId;

  emitProgress({ phase: "generate", nodeId, message: "加载自建工作流「" + wfTitle + "」…", pct: 6 });

  /* 输出节点：默认取最后一个视频产物；用户可在映射里指定 customOutputNodeId */
  const outPick = h3wf.pickOutputNode(scan, String(params.customOutputNodeId || ""));

  /* 参数映射：节点面板存的自定义表优先；为空时回落智能建议映射 */
  let list = [];
  if (Array.isArray(params.wfParams) && params.wfParams.length) {
    const n = h3wf.normalizeParams(remapNanFengRefFields(graph, params.wfParams), graph);
    if (n.errors.length) throw new Error("工作流参数表无效：" + n.errors[0]);
    list = n.params;
  } else {
    list = scan.suggested;
  }

  /* 运行时值：面板填写 / 端口注入的 wfParamValues（text/number 直接下发，素材为绝对路径） */
  const values = h3wf.isPlainObject(params.wfParamValues) ? params.wfParamValues : {};
  const seed =
    params.seed != null && Number.isFinite(Number(params.seed)) ? Number(params.seed) : null;

  /* 素材上传：本机绝对路径 → ComfyUI input 目录文件名 */
  const uploads = h3wf.collectUploads(values, list);
  const uploaded = {};
  for (const u of uploads) {
    if (!fs.existsSync(u.path)) {
      throw new Error("素材文件不存在：" + u.path + "（参数 " + u.key + "）");
    }
    /* 音频参数防呆：MP4 家族容器但没有 soun 轨 → 提交前拦下（ComfyUI 侧只会回
       "No audio stream found in the file." 且不带参数名）。非 MP4 / 无法判定不拦截。 */
    if (u.type === "audio") {
      const sniff = sniffMp4AudioTrack(u.path);
      if (sniff && sniff.isMp4 && !sniff.hasAudio) {
        const hit = list.find((p) => p && p.key === u.key);
        const label = (hit && hit.label) || u.key;
        throw new Error(
          "音频参数「" + label + "」（" + u.key + "）的素材没有音轨：" + u.path +
            "\n该文件是 MP4 家族容器但没有音频轨，后端读不到声音。改接到 视频N 端子，或换含音轨的文件。",
        );
      }
    }
    uploaded[u.key] = await uploadFileToComfy(port, u.path, u.type);
    appendConsole("[wf] uploaded " + u.key + " (" + u.type + ") → " + uploaded[u.key]);
  }

  /* 注入：克隆图不改库内原图；种子统一下发到全部被标 seed 字段（含未提升为参数的） */
  const applied = h3wf.applyMapping(graph, values, list, seed, {
    uploaded,
    seedFields: scan.seedFields,
  });
  if (applied.errors.length) {
    throw new Error(
      "工作流参数注入失败：" +
        applied.errors
          .map((e) => (e.key ? "[" + e.key + "]" : "[?]") + " " + e.error)
          .slice(0, 5)
          .join("；"),
    );
  }

  /* 必填下拉空值自愈：旧库记录里残留的空串 combo 会被 ComfyUI 以「Value not in list」拒单，
     随包 JSON 的修不回滚已入列记录，只能在这里按真实 /object_info 补一次。
     后端未起时 fetchObjectInfo 返回 null → 跳过，保持原有报错路径。 */
  const objectInfo = await fetchObjectInfo(port);
  if (objectInfo) {
    const healed = healEmptyComboInputs(applied.graph, objectInfo);
    if (healed.fixed.length) {
      appendConsole("[wf] 空值下拉已按后端 schema 自愈 " + healed.fixed.length + " 处");
    }
  } else {
    appendConsole("[wf] 后端未起，跳过硬填下拉空值自愈");
  }

  if (activeGenerate && activeGenerate.abort) throw new Error("cancelled");
  const clientId = crypto.randomUUID();
  const res = await submitAndWaitComfy(port, clientId, applied.graph, nodeId, "custom", {
    collect: true,
    preferredNodeId: outPick.nodeId || "",
    workflowTitle: wfTitle,
  });
  const meta = res && res.videoMeta;
  if (!meta) {
    const counts = {};
    for (const f of (res && res.collected) || []) counts[f.kind] = (counts[f.kind] || 0) + 1;
    throw new Error(
      "工作流跑了但没有拿到产物" +
        (Object.keys(counts).length
          ? "（收到 " +
            Object.keys(counts)
              .map((k) => k + "×" + counts[k])
              .join("，") +
            "，但都不是可保存的视频/动图；可直接在 ComfyUI 输出目录找回）"
          : "（图中没有 Save* 输出节点）"),
    );
  }

  /* 产物拷贝：真实扩展名（.mp4/.webp/.gif…），取不到回退 .mp4；重名自动序号 */
  let outPath = comfyOutputPath(comfy, meta.filename, meta.subfolder || "");
  const exportDir = String(params.outputDir || "").trim();
  if (exportDir) {
    const preferred = String(params.filename || "").trim() || meta.filename;
    outPath = await copyOutputToDir(comfy, meta.filename, meta.subfolder || "", exportDir, preferred);
  }
  if (!outPath || !fs.existsSync(outPath)) throw new Error("output_file_missing: " + (outPath || ""));
  let sz = 0;
  try {
    sz = fs.statSync(outPath).size || 0;
  } catch {}
  if (sz < 64) throw new Error("output_file_empty_or_too_small: " + outPath);

  emitProgress({ phase: "generate", nodeId, message: "完成", pct: 100, done: true });
  appendConsole("[job] custom ok path=" + outPath + " bytes=" + sz);
  return { ok: true, path: outPath, message: "Saved: " + outPath, bytes: sz };
}

/** 「内置图另存为自定义工作流」：用 buildH3Workflow 生成内置 fl2va / r2v 的 API 图，入库存为模板。 */
function builtinTemplateGraph(mode) {
  const m = mode === "r2v" ? "r2v" : "fl2va";
  const params = {
    mode: m,
    prompt: "",
    width: 1280,
    height: 704,
    length: calcLength(5),
    seed: 0,
    steps: 20,
    sampler: "res_multistep",
    scheduler: "simple",
    denoise: 1,
  };
  return buildH3Workflow(params, {});
}

/* 随包工作流（h3-pack/workflows/*.json，API 格式）：与「内置 FL2VA / R2V」两条模板并列，
 * 是自建工作流库里的第三条。首次启动自动入列（ensureBundledWorkflows），入列后不再覆盖 ——
 * 用户改名 / 删除都不会被回滚。真源文件随 h3-pack 打包（build.json extraResources 的 workflows/**）。 */
const BUNDLED_WORKFLOWS = Object.freeze([
  {
    file: "nanfeng-h3-v10-multiref.json",
    title: "南风H3 V10 多参（模板）",
    source: "bundled:nanfeng-h3-v10-multiref",
    notes:
      "南风H3 V10 一体化 Ref2VA：NanFengH3MultiReferenceGeneratorV10 → CreateVideo → SaveVideo。" +
      "需要 ComfyUI/custom_nodes/nanfeng_prompt_nodes_v10（随包脚手架 setup_env.ps1 自动部署）。",
  },
]);

function bundledWorkflowsDir() {
  return join(packRoot(), "workflows");
}

/** 随包工作流「已入列」标记：落在数据目录（h3/bundled-workflows.json），保证用户删掉后不再被塞回来。 */
function bundledSeedMarkerPath() {
  return join(h3Root(), "bundled-workflows.json");
}

/** 读一条随包工作流的 API 图（仅供入列 / 另存模板复用，不缓存文件内容）。 */
function readBundledWorkflowGraph(file) {
  const p = join(bundledWorkflowsDir(), String(file || ""));
  const parsed = h3wf.parseImportText(fs.readFileSync(p, "utf8"));
  return h3wf.normalizeGraph(parsed);
}

/**
 * 把随包工作流并入自建工作流库（幂等、不回滚）。
 * 只对「从未入列过」的条目建记录；标记落 h3/bundled-workflows.json。
 * 首次入列后顺手跑一次 /object_info 校验（后端没起就记 skipped，与手动导入同口径）。
 */
async function ensureBundledWorkflows() {
  const marker = readJson(bundledSeedMarkerPath(), {}) || {};
  const seeded = h3wf.isPlainObject(marker.seeded) ? marker.seeded : {};
  const added = [];
  for (const spec of BUNDLED_WORKFLOWS) {
    if (seeded[spec.file]) continue;
    let norm;
    try {
      norm = readBundledWorkflowGraph(spec.file);
    } catch (e) {
      appendConsole("[wf-seed] 读取随包工作流失败 " + spec.file + "：" + String((e && e.message) || e));
      continue;
    }
    let rec;
    try {
      rec = workflowStore().createFromGraph({
        title: spec.title,
        graph: norm.graph,
        format: norm.format,
        sourceName: spec.source,
        template: true,
        overwrite: false,
        notes: spec.notes || "",
      });
    } catch (e) {
      appendConsole("[wf-seed] 随包工作流入库失败 " + spec.file + "：" + String((e && e.message) || e));
      continue;
    }
    if (!rec || !rec.ok || !rec.record) continue;
    seeded[spec.file] = rec.record.id;
    writeJson(bundledSeedMarkerPath(), { version: 1, updatedAt: new Date().toISOString(), seeded });
    added.push(rec.record.title);
    appendConsole("[wf-seed] 随包工作流入列：" + rec.record.title + " (id=" + rec.record.id + ")");
    /* 后台跑一次 /object_info 校验（不 await：后端没起时这里连不上，别让 wfList 卡住） */
    validateWorkflowRecord(rec.record.id).catch(() => {});
  }
  return { ok: true, added };
}

async function templateToWorkflow(mode) {
  const raw = String(mode || "").trim().toLowerCase();
  /* 第三条（南风H3 V10 多参）没有运行时拼装的图：真源就是随包 workflows/*.json 里的那条，
   * 与内置 FL2VA / R2V 并列，可从库里删除后用「内置图另存」再取回。 */
  if (raw === "nanfeng" || raw === "nanfeng-h3-v10-multiref") {
    const spec = BUNDLED_WORKFLOWS[0];
    const norm = readBundledWorkflowGraph(spec.file);
    return workflowStore().createFromGraph({
      title: spec.title,
      graph: norm.graph,
      format: norm.format,
      sourceName: spec.source,
      template: true,
      overwrite: true,
      notes: spec.notes || "",
    });
  }
  const m = raw === "r2v" ? "r2v" : "fl2va";
  const title = "内置 " + (m === "r2v" ? "R2V" : "FL2VA") + "（模板）";
  const graph = builtinTemplateGraph(m);
  return workflowStore().createFromGraph({
    title,
    graph,
    format: "api",
    sourceName: "builtin:" + m,
    template: true,
    overwrite: true,
  });
}

async function forceKillBackend(reason) {
  const why = String(reason || "release_gpu");
  appendConsole("[force-kill] " + why + " — 结束后端进程以释放显存");
  if (activeGenerate) activeGenerate.abort = true;
  destroyActiveGenerateReq();
  clearLock();
  activeGenerate = null;
  try {
    await stopBackend();
  } catch (e) {
    appendConsole("[force-kill] stop warn: " + String((e && e.message) || e));
  }
  emitProgress({
    phase: "generate",
    nodeId: "",
    message: "已强制结束后端以释放显存（下次执行节点会重新启动）",
    error: true,
    forceKilled: true,
  });
  return { ok: true, killed: true, reason: why };
}

function cancelGenerate(nodeId) {
  const cfg = loadConfig();
  const port = Number(cfg.port) || DEFAULT_PORT;
  let promptId = "";
  let nid = String(nodeId || "");
  if (activeGenerate && (!nodeId || activeGenerate.nodeId === nodeId)) {
    activeGenerate.abort = true;
    promptId = activeGenerate.promptId || "";
    nid = nid || activeGenerate.nodeId || "";
    interruptComfy(port, promptId).catch(() => {});
    destroyActiveGenerateReq();
  } else {
    interruptComfy(port, "").catch(() => {});
  }
  releaseLock(nodeId);
  setTimeout(() => {
    forceKillBackend("user_cancel").catch(() => {});
  }, 400);
  emitProgress({
    phase: "generate",
    nodeId: nid,
    message: "已取消（正在结束后端）",
    error: true,
    cancelled: true,
  });
  reportErr("cancelled", "生成已取消（用户主动停止）", { phase: "generate", nodeId: nid });
  appendConsole("[cancel] generate cancelled node=" + (nid || "?") + " → stop backend");
  return { ok: true, forceKillScheduled: true };
}

/** Console 停靠面板开合时的窗口边界（纯函数，可单测）。
 *  delta > 0 = 往左撑开 delta 像素（右边缘不动 → 主列看着一点没挪）；delta < 0 = 收回。
 *  左边贴到屏幕边缘时改往右长（还是放不下才让主列变窄），总宽永不低于 minW。 */
function paneShiftBounds(b, wa, delta, minW) {
  const floor = Math.max(1, Number(minW) || 1);
  let x = b.x - delta;
  let width = b.width + delta;
  if (width < floor) {
    x -= floor - width;
    width = floor;
  }
  const minX = wa.x;
  const maxRight = wa.x + wa.width;
  if (x < minX) {
    /* 左边放不下：x 锁到工作区左缘，能往右长多少就往右长（主列才不会被吃掉） */
    x = minX;
    width = Math.min(Math.max(floor, b.width + delta), Math.max(floor, maxRight - minX));
  }
  if (x + width > maxRight) width = Math.max(floor, maxRight - x);
  return {
    x: Math.round(x),
    y: Math.round(b.y),
    width: Math.round(width),
    height: Math.round(b.height),
  };
}

/** h3:setConsolePane：页面左侧那块 Console 面板开 / 关时，宿主把窗口按同宽度往左挪，
 *  于是面板看着「钉」在窗口左边、与窗口等高，而右侧主列一格都没动。
 *  记两个数：want（面板要的宽度）与 applied（真撑开了多少，可能被屏幕边缘钳小）；
 *  收起时按 applied 还回去 → 往返恒等，且同状态重复下发零位移（界面会因 reload 重报）。 */
function setConsolePane(opts) {
  const o = opts && typeof opts === "object" ? opts : {};
  const win = consoleWin && !consoleWin.isDestroyed() ? consoleWin : null;
  if (!win) return { ok: false, error: "no_window" };
  const width = Math.max(
    CONSOLE_PANE_W,
    Math.min(CONSOLE_PANE_MAX_W, Number(o.width) || CONSOLE_PANE_W),
  );
  const open = !!o.open;
  const want = open ? width : 0;
  if (want === consolePaneW) {
    return {
      ok: true,
      open,
      paneWidth: consolePaneW,
      applied: consolePaneApplied,
      width: win.getBounds().width,
    };
  }
  const b0 = win.getBounds();
  const delta = want > consolePaneW ? want - consolePaneW : -consolePaneApplied;
  let b = b0;
  try {
    if (win.isMaximized()) {
      win.unmaximize();
      b = win.getBounds();
    }
  } catch {}
  const wa = screen.getDisplayMatching(b).workArea;
  const next = paneShiftBounds(b, wa, delta, CONSOLE_WIN_MIN_W);
  try {
    win.setBounds(next);
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
  consolePaneW = want;
  consolePaneApplied = Math.max(0, next.width - b.width);
  return { ok: true, open, paneWidth: consolePaneW, applied: consolePaneApplied, bounds: next };
}

/** ComfyUI 编辑界面地址（后端只监听 127.0.0.1，同机浏览器直接打开即可）。 */
function comfyUiUrl(port) {
  return `http://127.0.0.1:${Number(port) || DEFAULT_PORT}/`;
}

/** 一键在浏览器打开 ComfyUI 编辑界面。
 *  默认只探活不启动（用户可能只是想看一眼图）；opts.start = true 才拉起后端再打开。
 *  startBackend 自身已等 HTTP 就绪，所以这里不再补轮询。 */
async function openComfyUiInBrowser(opts) {
  const o = opts && typeof opts === "object" ? opts : {};
  const cfg = loadConfig();
  const port = Number(cfg.port) || DEFAULT_PORT;
  let p = port;
  if (o.start) {
    const r = await startBackend();
    if (!r || !r.ok) {
      const err = String((r && (r.error || r.message)) || "backend_start_failed");
      appendConsole("[comfy-ui] start failed: " + err);
      return { ok: false, error: "start_failed", message: err, url: comfyUiUrl(port) };
    }
    p = Number(r.port) || port;
  } else if (!(await probeComfy(port))) {
    return { ok: false, error: "backend_not_running", url: comfyUiUrl(port) };
  }
  const url = comfyUiUrl(p);
  try {
    await shell.openExternal(url);
    appendConsole("[comfy-ui] opened " + url);
    return { ok: true, url, started: !!o.start };
  } catch (e) {
    const err = String((e && e.message) || e);
    appendConsole("[comfy-ui] openExternal failed: " + err);
    return { ok: false, error: err, url };
  }
}

/* ───────────── 「打开该模板进 ComfyUI 编辑」：管理窗内嵌编辑器视图（宿主侧） ───────────── */

/* 编辑器视图的最小可用尺寸：ComfyUI 画布比插件面板吃面积，420 宽的窗看着就是块砖。 */
const WF_EDITOR_MIN_W = 1120;
const WF_EDITOR_MIN_H = 760;

/* 进入编辑器视图前的窗口边界（null = 当前不在编辑器视图）；关闭时原样还回去。 */
let wfEditorSnapshot = null;
/* 编辑器视图状态：真源只在宿主。渲染层那块 persistent 浮层（内嵌 iframe）只是这份状态的容器，
   只能由用户点浮层上的「✕ / 关闭」显式关掉 —— 一律不做「点外部即关」。 */
let wfEditorView = { open: false, url: "", id: "", title: "", file: "", loaded: false, error: "", hint: "" };

/** ComfyUI 的用户工作流目录（<ComfyUI>/user/default/workflows）；没装 / 没设目录返回 ""。
 *  先看后端 pid 记的 installDir（可能是复用的外部实例），再回落到配置里的安装目录。 */
function comfyUserWorkflowsDir() {
  const cfg = loadConfig();
  const meta = loadPidMeta();
  for (const raw of [meta && meta.installDir, cfg.installDir]) {
    const comfy = comfyDir(String(raw || "").trim());
    if (comfy && fs.existsSync(comfy)) return join(comfy, "user", "default", "workflows");
  }
  return "";
}

/** 编辑器视图展开后的窗口边界（纯函数，可单测）：已够大就一点不动，不够才长。
 *  右边缘当锚点往左长、顶边不动往下长，并钳进工作区 —— 绝不越屏，也不吃掉主列的位置。 */
function wfEditorGrowBounds(b, wa, minW, minH) {
  const wantW = Math.max(b.width, Math.min(Number(minW) || 0, Math.max(1, wa.width)));
  const wantH = Math.max(b.height, Math.min(Number(minH) || 0, Math.max(1, wa.height)));
  const maxRight = wa.x + wa.width;
  /* 以右边缘为锚点往左长（看着就是「往左吃掉主列」，主列一点没动）；
     左边贴着屏幕放不下时，就贴着左缘往右长 —— 原窗口那块可见区域一定保住。 */
  let x = b.x + b.width - wantW;
  if (x < wa.x) x = wa.x;
  let width = Math.min(b.x + b.width, maxRight) - x;
  if (width < wantW) width = Math.min(wantW, maxRight - x);
  width = Math.max(1, width);
  const height = Math.max(1, Math.min(wantH, wa.y + wa.height - b.y));
  return {
    x: Math.round(x),
    y: Math.round(b.y),
    width: Math.round(width),
    height: Math.round(height),
  };
}

function pushWfEditorView() {
  if (!(consoleWin && !consoleWin.isDestroyed())) return;
  try {
    consoleWin.webContents.send("h3:wfEditorViewChanged", Object.assign({}, wfEditorView));
  } catch {}
}

function setWfEditorView(patch) {
  wfEditorView = Object.assign({}, wfEditorView, patch || {});
  pushWfEditorView();
  return Object.assign({}, wfEditorView);
}

/** 管理窗切进「工作流编辑器」视图：先把窗口撑到能看画布的尺寸（快照旧边界），再把状态推给页面。 */
function enterWfEditorView(url, info) {
  if (!(consoleWin && !consoleWin.isDestroyed())) openConsoleWindow();
  if (!(consoleWin && !consoleWin.isDestroyed())) return { ok: false, error: "no_window" };
  const win = consoleWin;
  if (!wfEditorSnapshot) {
    try {
      wfEditorSnapshot = win.getBounds();
    } catch {
      wfEditorSnapshot = null;
    }
  }
  if (wfEditorSnapshot) {
    const b = win.getBounds();
    const wa = screen.getDisplayMatching(b).workArea;
    const next = wfEditorGrowBounds(b, wa, WF_EDITOR_MIN_W, WF_EDITOR_MIN_H);
    if (next.width !== b.width || next.height !== b.height) {
      try {
        if (win.isMaximized()) win.unmaximize();
      } catch {}
      try {
        win.setBounds(next);
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e) };
      }
    }
  }
  setWfEditorView(
    Object.assign(
      { open: true, url: String(url || ""), loaded: false, error: "", hint: "" },
      info || {},
    ),
  );
  return { ok: true, open: true };
}

/** 退出编辑器视图：状态先收（页面撤浮层），再把窗口边界还回进入前的样子。 */
function exitWfEditorView() {
  const snap = wfEditorSnapshot;
  wfEditorSnapshot = null;
  setWfEditorView({
    open: false,
    url: "",
    id: "",
    title: "",
    file: "",
    loaded: false,
    error: "",
    hint: "",
  });
  if (snap && consoleWin && !consoleWin.isDestroyed()) {
    try {
      consoleWin.setBounds(snap);
    } catch {}
  }
  return { ok: true, open: false };
}

/** 在内嵌的 ComfyUI frame 里执行脚本。跨源 iframe 页面自己碰不到，只有主进程能按 frame 打；
 *  刚挂上的 iframe url 还是 about:blank，所以这里轮询到「命中 ComfyUI 源且脚本没抛异常」。 */
async function runInComfyFrame(port, script, opts) {
  const o = opts && typeof opts === "object" ? opts : {};
  if (!(consoleWin && !consoleWin.isDestroyed())) return { ok: false, error: "no_window" };
  const origin = "http://127.0.0.1:" + (Number(port) || DEFAULT_PORT);
  const deadline = Date.now() + (Number(o.timeoutMs) || 20000);
  let lastErr = "frame_not_found";
  while (Date.now() < deadline) {
    let frame = null;
    try {
      const list = (consoleWin.webContents.mainFrame && consoleWin.webContents.mainFrame.framesInSubtree) || [];
      for (const f of list) {
        try {
          if (f && !f.isDestroyed() && String(f.url || "").indexOf(origin) === 0) {
            frame = f;
            break;
          }
        } catch {}
      }
    } catch {
      lastErr = "frame_scan_failed";
    }
    if (frame) {
      try {
        const r = await frame.executeJavaScript(script, true);
        return r && typeof r === "object" ? r : { ok: !!r };
      } catch (e) {
        lastErr = String((e && e.message) || e);
      }
    }
    await sleep(400);
  }
  return { ok: false, error: "frame_timeout", message: lastErr };
}

/** 生成「把一条 UI 工作流载入 ComfyUI 编辑器」的页面内脚本。
 *  只调前端自己的 window.app.loadGraphData（前端自己加载模板用的同一个入口），
 *  不碰 ComfyUI 安装目录里的任何产物，也不写回 h3-workflows 库。
 *  JSON 文本以字符串字面量下发、页面内再 JSON.parse，避免把内容当代码执行。 */
function comfyLoadScript(uiText, waitMs) {
  const lit = JSON.stringify(String(uiText || ""));
  const budget = Math.max(5000, Number(waitMs) || 90000);
  return (
    "(async () => {" +
    "let doc = null;" +
    "try { doc = JSON.parse(" +
    lit +
    "); } catch (e) { return { ok:false, error:'bad_payload', message:String((e&&e.message)||e) }; }" +
    "const until = Date.now() + " +
    budget +
    ";" +
    "const nap = (ms) => new Promise((r) => setTimeout(r, ms));" +
    "while (Date.now() < until) {" +
    "const app = window.app;" +
    "if (app && typeof app.loadGraphData === 'function') {" +
    "try { await app.loadGraphData(doc, true, true, null, {}); return { ok:true, nodes:(doc.nodes||[]).length };" +
    "} catch (e) { return { ok:false, error:'load_failed', message:String((e&&e.message)||e) }; }" +
    "}" +
    "await nap(250);" +
    "}" +
    "return { ok:false, error:'frontend_not_ready' };" +
    "})()"
  );
}

/** 「打开」这条模板进 ComfyUI 编辑：确保后端在跑 → 库里的模板落成 UI 工作流文件 →
 *  管理窗切到内嵌编辑器视图 → 驱动前端载入这一条。
 *  全程单向（库 → ComfyUI 现场）：任何一步都不把 ComfyUI 里的编辑结果写回库，
 *  收回来的唯一入口仍是既有的「导入 JSON」。 */
async function openWorkflowInComfyEditor(opts) {
  const o = opts && typeof opts === "object" ? opts : {};
  const cfg = loadConfig();
  const port = Number(cfg.port) || DEFAULT_PORT;
  const store = workflowStore();
  const rec = store.get(String(o.id || ""));
  if (!rec) return { ok: false, error: "工作流不存在：" + String(o.id || ""), url: comfyUiUrl(port) };

  const ui = h3wf.recordToUiWorkflowText(rec);
  if (!ui || !ui.ok) return { ok: false, error: (ui && ui.error) || "模板转换失败", url: comfyUiUrl(port) };

  let p = port;
  if (o.start) {
    const r = await startBackend();
    if (!r || !r.ok) {
      const err = String((r && (r.error || r.message)) || "backend_start_failed");
      appendConsole("[wf-editor] start failed: " + err);
      return { ok: false, error: "start_failed", message: err, url: comfyUiUrl(port) };
    }
    p = Number(r.port) || port;
  } else if (!(await probeComfy(port))) {
    return { ok: false, error: "backend_not_running", url: comfyUiUrl(port) };
  }
  const editorUrl = comfyUiUrl(p);

  /* 1) 先把这条模板写成 ComfyUI 用户工作流目录里的 UI 文件：前端「Workflow › Open」能列出来，
        注入失败时用户也能手动选它。写不进（没装 / 目录不可写）不阻断下面的注入。 */
  let file = "";
  const dir = comfyUserWorkflowsDir();
  if (dir) {
    const ex = store.exportComfyUiFile(rec.id, dir);
    if (ex && ex.ok) file = String(ex.filename || "");
    else appendConsole("[wf-editor] export warn: " + ((ex && ex.error) || "unknown"));
  } else {
    appendConsole("[wf-editor] export skip: 找不到 ComfyUI 用户工作流目录");
  }

  /* 2) 管理窗切进编辑器视图（浮层 persistent：只有显式关闭才收，宿主任何路径都不替用户关它） */
  const enter = enterWfEditorView(editorUrl, { id: rec.id, title: rec.title || "", file: file });
  if (!enter.ok) return { ok: false, error: enter.error, url: editorUrl };

  /* 3) 驱动内嵌前端载入这一条模板；打不开就退回「自己在工作流列表里选这个文件」 */
  const inj = await runInComfyFrame(p, comfyLoadScript(ui.text, 90000), { timeoutMs: 20000 });
  const loaded = !!(inj && inj.ok);
  const hint = loaded
    ? ""
    : "ComfyUI 编辑器已打开，但这条模板没能自动载入。请在 ComfyUI 里点 Workflow › Open" +
      (file ? "，选「" + file + "」" : "（工作流目录里对应的同名文件）") +
      "。编辑结果不会写回插件库，收回库里的唯一入口仍是「导入 JSON」。";
  setWfEditorView({
    loaded,
    hint,
    error: loaded ? "" : String((inj && (inj.message || inj.error)) || ""),
  });
  appendConsole(
    "[wf-editor] " + rec.title + " → " + editorUrl + (loaded ? " loaded✓" : " load✗ " + hint)
  );
  return {
    ok: true,
    url: editorUrl,
    id: rec.id,
    title: rec.title || "",
    file,
    loaded,
    hint,
    error: loaded ? "" : String((inj && (inj.error || inj.message)) || "load_failed"),
  };
}

function openConsoleWindow() {
  const ui = ensureUiRuntime();
  const stamp = uiRuntimeStamp(join(h3Root(), "ui"));
  if (consoleWin && !consoleWin.isDestroyed()) {
    /* 窗口还开着，但磁盘上的界面已经更新过 → 必须 reload 页面。
       否则用户一直看着旧 HTML/CSS（旧版弹窗样式被删过一次，那个「确认卸载」框就常驻不走了），
       表现是「改了 UI 没生效」+「弹窗关不掉」。 */
    let reloaded = false;
    if (ui.changed || (stamp && loadedUiStamp && stamp !== loadedUiStamp)) {
      try {
        consoleWin.webContents.reload();
        reloaded = true;
      } catch {}
    }
    loadedUiStamp = stamp;
    consoleWin.show();
    consoleWin.focus();
    notifyConsoleChanged(true);
    return { ok: true, open: true, reloaded };
  }
  const entry = uiEntry();
  if (!fs.existsSync(entry)) return { ok: false, error: "ui_missing" };

  const wa = screen.getPrimaryDisplay().workArea;
  consoleWin = new BrowserWindow({
    width: 420,
    height: 640,
    x: Math.min(wa.x + wa.width - 440, wa.x + wa.width - 100),
    y: wa.y + 40,
    minWidth: CONSOLE_WIN_MIN_W,
    frame: true,
    show: true,
    title: "Minimax H3 · 插件测试中",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload: join(__dirname, "preload-h3.js"),
      /* 本页是 file://，而「工作流编辑器」视图要内嵌本机 http://127.0.0.1:<port>（ComfyUI）。
         file 页面拉不安全子帧属于 mixed content，Chromium 默认会拦 —— 这里显式放行。
         只影响这个本机插件小窗，可加载来源固定是回环地址上的 ComfyUI，不外扩。 */
      allowRunningInsecureContent: true,
    },
  });
  loadedUiStamp = stamp;
  consolePaneW = 0; /* 新窗口 = 面板收起，位移记账必须跟着归零 */
  consolePaneApplied = 0;
  consoleWin.loadFile(entry);
  /* 页面（含界面更新导致的 reload）一装载完就把编辑器视图状态补推一次：
     浮层的真源在宿主，页面重建后必须能原地恢复成「编辑器还开着」。 */
  consoleWin.webContents.on("did-finish-load", () => pushWfEditorView());
  consoleWin.on("closed", () => {
    consoleWin = null;
    loadedUiStamp = "";
    consolePaneW = 0;
    consolePaneApplied = 0;
    /* 窗口没了 = 编辑器视图随之消失；边界快照与状态一起清掉，下次开窗不会还挂着旧快照 */
    wfEditorSnapshot = null;
    wfEditorView = { open: false, url: "", id: "", title: "", file: "", loaded: false, error: "", hint: "" };
    notifyConsoleChanged(false);
  });
  startGpuPolling();
  notifyConsoleChanged(true);
  return { ok: true, open: true, reloaded: false };
}

function closeConsoleWindow() {
  try {
    if (consoleWin && !consoleWin.isDestroyed()) consoleWin.close();
  } catch {}
  consoleWin = null;
  consolePaneW = 0;
  notifyConsoleChanged(false);
  return { ok: true, open: false };
}

function notifyConsoleChanged(open) {
  try {
    const w = getMainWin && getMainWin();
    if (w && !w.isDestroyed()) {
      w.webContents.send("h3:consoleChanged", { open: !!open });
    }
  } catch {}
}

function pickInstallDir() {
  const cfg = loadConfig();
  const r = dialog.showOpenDialogSync({
    title: "选择 Minimax H3 安装目录",
    properties: ["openDirectory", "createDirectory"],
    defaultPath: cfg.installDir || undefined,
  });
  if (!r || !r[0]) return { ok: false, cancelled: true };
  const safe = isSafeInstallDir(r[0]);
  if (!safe.ok) return { ok: false, error: safe.error };
  saveConfig({ installDir: safe.path });
  const sig = projectSignals(safe.path);
  if (sig.ready) {
    const man = readManifest();
    writeJson(installedMetaPath(), {
      ok: true,
      version: (man && man.version) || "1.0.0",
      installDir: safe.path,
      discovered: true,
      installedAt: new Date().toISOString(),
    });
  }
  return { ok: true, installDir: safe.path, project: sig };
}

function consoleTail(maxBytes) {
  try {
    const p = consoleLogPath();
    if (!fs.existsSync(p)) return { ok: true, text: "" };
    const st = fs.statSync(p);
    const n = Math.min(st.size, Number(maxBytes) || 64 * 1024);
    const fd = fs.openSync(p, "r");
    const buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, Math.max(0, st.size - n));
    fs.closeSync(fd);
    return { ok: true, text: buf.toString("utf8") };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

function removePluginMetaOnly() {
  try {
    if (consoleWin && !consoleWin.isDestroyed()) consoleWin.close();
  } catch {}
  const ui = join(h3Root(), "ui");
  try {
    if (fs.existsSync(ui)) fs.rmSync(ui, { recursive: true, force: true });
  } catch {}
  return { ok: true, keptInstallDir: loadConfig().installDir || "" };
}

function registerH3Ipc(opts) {
  getDataDir = opts.getDataDir;
  getMainWin = opts.getMainWin;
  appRoot = opts.appRoot || path.join(__dirname, "..");
  getDsh = opts.getDsh || null;

  /* 报错总线：注册宿主（安装目录 / 日志尾部 / 自我修复 / 重启四个能力入口），
     之后各失败出口的 reportErr 才有归属与上下文。 */
  pluginErrors.registerPluginHost({
    id: PLUGIN_ID,
    name: "Minimax H3",
    skillName: "minimax-h3-install",
    getInstallDir: () => loadConfig().installDir || "",
    tailConsole: (n) => consoleTail(n),
    selfRepair: (o) => selfRepairFromConsole(o || {}),
    restart: async () => {
      await stopBackend();
      return startBackend();
    },
  });

  ensureUiRuntime();
  refreshStaleLock();
  startGpuPolling();

  (async () => {
    const cfg = loadConfig();
    const port = Number(cfg.port) || DEFAULT_PORT;
    if (await probeComfy(port)) {
      appendConsole("discovered running ComfyUI on :" + port);
    }
  })();

  ipcMain.handle("h3:getStatus", async () => statusForUi());
  ipcMain.handle("h3:updateRuntime", async () => updatePluginRuntime());
  ipcMain.handle("h3:pickInstallDir", async () => pickInstallDir());
  ipcMain.handle("h3:setInstallDir", async (e, dir) => {
    const safe = isSafeInstallDir(dir);
    if (!safe.ok) return { ok: false, error: safe.error };
    saveConfig({ installDir: safe.path });
    const sig = projectSignals(safe.path);
    if (sig.ready) {
      const man = readManifest();
      writeJson(installedMetaPath(), {
        ok: true,
        version: (man && man.version) || "1.0.0",
        installDir: safe.path,
        discovered: true,
        installedAt: new Date().toISOString(),
      });
    }
    return { ok: true, installDir: safe.path, project: sig };
  });
  ipcMain.handle("h3:install", async (e, opts) => installProject(opts || {}));
  ipcMain.handle("h3:agentRecoverInstall", async (e, opts) => agentRecoverInstall(opts || {}));
  ipcMain.handle("h3:selfRepair", async (e, opts) => selfRepairFromConsole(opts || {}));
  /* 补装注意力加速（triton-windows + 匹配的 sageattention 预编译 wheel），装完按生成期同一口径自检 */
  ipcMain.handle("h3:installSage", async (e, opts) => installSageAttention(opts || {}));
  ipcMain.handle("h3:cancelInstall", async () => {
    installCancel = true;
    return { ok: true };
  });
  ipcMain.handle("h3:start", async () => startBackend());
  ipcMain.handle("h3:stop", async () => stopBackend());
  ipcMain.handle("h3:uninstallPreview", async () => uninstallPreview());
  ipcMain.handle("h3:uninstall", async (e, opts) => uninstallProject(opts || {}));
  ipcMain.handle("h3:generate", async (e, params) => generateVideo(params || {}));
  /* 独立后处理：超分 / 补帧各自一条，与生成解耦（video_upscale / video_interp 节点） */
  ipcMain.handle("h3:postProcess", async (e, params) => postProcessVideo(params || {}));
  ipcMain.handle("h3:cancelGenerate", async (e, nodeId) => cancelGenerate(nodeId));
  /* 自建工作流库（h3/ui 管理 + 主窗口 video_gen 面板共用） */
  ipcMain.handle("h3:wfList", async () => {
    try {
      /* 随包工作流（第三条，与内置 FL2VA / R2V 并列）首次访问时入列，幂等且不回滚 */
      await ensureBundledWorkflows();
      return { ok: true, items: workflowStore().listDetailed(), stats: workflowStore().stats() };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });
  ipcMain.handle("h3:wfImport", async (e, input) => {
    try {
      return workflowStore().importWorkflow(input || {});
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });
  ipcMain.handle("h3:wfDelete", async (e, id) => {
    try {
      return workflowStore().remove(String(id || ""));
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });
  ipcMain.handle("h3:wfRename", async (e, opts) => {
    try {
      const o = opts || {};
      return workflowStore().rename(String(o.id || ""), String(o.title || ""));
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });
  ipcMain.handle("h3:wfExport", async (e, id) => {
    try {
      return workflowStore().exportText(String(id || ""));
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });
  ipcMain.handle("h3:wfValidate", async (e, id) => {
    try {
      return await validateWorkflowRecord(String(id || ""));
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });
  ipcMain.handle("h3:wfGet", async (e, id) => {
    try {
      const store = workflowStore();
      const rec = store.get(String(id || ""));
      if (!rec) return { ok: false, error: "工作流不存在：" + String(id || "") };
      const s = store.scan(rec.id);
      return {
        ok: true,
        record: {
          id: rec.id,
          title: rec.title,
          format: rec.format,
          validation: rec.validation || { status: "unchecked", checkedAt: "" },
          notes: rec.notes || "",
          source: rec.source || {},
        },
        scan: s ? s.scan : null,
        suggestedParams: s ? s.suggestedParams : [],
      };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });
  /* 画布 video_gen 节点面板用：把节点上已存的「提升为节点参数」表与该图最新扫描合并
     （保留用户改过的 key / label / type；图上已消失的落点标 stale 不直接删；
     新扫出的建议参数按落点去重追加）。合并逻辑真源只在 h3-workflows.js，渲染层不复制一份。 */
  ipcMain.handle("h3:wfSyncParams", async (e, opts) => {
    try {
      const o = h3wf.isPlainObject(opts) ? opts : {};
      const store = workflowStore();
      const rec = store.get(String(o.id || ""));
      if (!rec) return { ok: false, error: "工作流不存在：" + String(o.id || "") };
      const graph = rec.graph || {};
      const scan = h3wf.scanGraph(graph);
      const merged = h3wf.syncParamsWithScan(
        Array.isArray(o.params) ? o.params : [],
        graph,
        scan,
      );
      return {
        ok: true,
        title: rec.title || String(o.id || ""),
        params: merged.params,
        added: merged.added,
        stale: merged.stale,
        outputs: scan.outputs,
        seedFields: scan.seedFields,
        candidates: scan.candidates,
        validation: rec.validation || { status: "unchecked", checkedAt: "" },
      };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });
  ipcMain.handle("h3:wfTemplateExport", async (e, mode) => {
    try {
      return await templateToWorkflow(String(mode || "fl2va"));
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });
  /* 「打开该模板进 ComfyUI 编辑」：管理窗内嵌编辑器视图 + 把这一条模板载入进去。
     只出不进 —— 编辑结果一律不写回库，收回库里唯一入口仍是「导入 JSON」。 */
  ipcMain.handle("h3:wfOpenInEditor", async (e, opts) => {
    try {
      return await openWorkflowInComfyEditor(opts || {});
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });
  /* 编辑器视图当前状态（页面 reload 后自己恢复浮层用；状态变化另有 h3:wfEditorViewChanged 推送） */
  ipcMain.handle("h3:wfEditorGetView", async () => ({ ok: true, view: Object.assign({}, wfEditorView) }));
  /* 显式关闭编辑器视图（浮层上的 ✕）：宿主不做「点外部即关」 */
  ipcMain.handle("h3:wfEditorClose", async () => exitWfEditorView());
  ipcMain.handle("h3:forceKillBackend", async () => forceKillBackend("manual"));
  ipcMain.handle("h3:getLock", async () => ({ ok: true, lock: refreshStaleLock() }));
  ipcMain.handle("h3:consoleTail", async (e, n) => consoleTail(n));
  /* 管理窗左侧 Console 停靠面板：页面报来开合与宽度，宿主把窗口往左撑 / 收 */
  ipcMain.handle("h3:setConsolePane", async (e, opts) => setConsolePane(opts || {}));
  /* 右上角「ComfyUI」：一键在浏览器打开工作流编辑界面（start=true 时先拉起后端） */
  ipcMain.handle("h3:openComfyUI", async (e, opts) => openComfyUiInBrowser(opts || {}));
  ipcMain.handle("h3:open", async () => openConsoleWindow());
  ipcMain.handle("h3:close", async () => closeConsoleWindow());
  ipcMain.handle("h3:removePluginMeta", async () => removePluginMetaOnly());
  ipcMain.handle("h3:setCpuVae", async (e, v) => {
    saveConfig({ cpuVae: !!v });
    /* 关掉 CPU VAE 后重新武装启动失败提示 */
    if (!v) cpuVaeFailHinted = false;
    return { ok: true, cpuVae: !!loadConfig().cpuVae };
  });
  ipcMain.handle("h3:setLaunchOpts", async (e, opts) => {
    opts = opts || {};
    const patch = {};
    if (opts.cpuVae != null) {
      patch.cpuVae = !!opts.cpuVae;
      if (!patch.cpuVae) cpuVaeFailHinted = false;
    }
    if (opts.optDisablePinnedMemory != null) {
      patch.optDisablePinnedMemory = !!opts.optDisablePinnedMemory;
    }
    if (opts.optFp16Intermediates != null) {
      patch.optFp16Intermediates = !!opts.optFp16Intermediates;
    }
    if (opts.optExpandableSegments != null) {
      patch.optExpandableSegments = !!opts.optExpandableSegments;
    }
    if (opts.optReserveVramGb != null) {
      const n = Number(opts.optReserveVramGb);
      if (Number.isFinite(n) && n >= 0) patch.optReserveVramGb = n;
    }
    /* 系统内存缓存保留下限（GB）；0 = 不加 --cache-ram，退回 ComfyUI 默认 */
    if (opts.optCacheRamGb != null) {
      const n = Math.round(Number(opts.optCacheRamGb));
      if (Number.isFinite(n) && n >= 0) patch.optCacheRamGb = n;
    }
    /* 内存护栏：任务之间回收后端进程（治「跑几单之后内存持续攀升」） */
    if (opts.optRebuildOnRamHigh != null) {
      patch.optRebuildOnRamHigh = !!opts.optRebuildOnRamHigh;
    }
    /* 后端 BLAS / OpenMP 线程上限（也是 arena 碎片的一个杠杆）；0 = 不改环境变量 */
    if (opts.optArenaThreads != null) {
      const n = Math.round(Number(opts.optArenaThreads));
      if (Number.isFinite(n) && n >= 0 && n <= 64) patch.optArenaThreads = n;
    }
    saveConfig(patch);
    const cfg = loadConfig();
    return {
      ok: true,
      cpuVae: !!cfg.cpuVae,
      optDisablePinnedMemory: cfg.optDisablePinnedMemory !== false,
      optFp16Intermediates: cfg.optFp16Intermediates !== false,
      optExpandableSegments: cfg.optExpandableSegments !== false,
      optReserveVramGb: Number(cfg.optReserveVramGb) > 0 ? Number(cfg.optReserveVramGb) : 4,
      optCacheRamGb: Number(cfg.optCacheRamGb) > 0 ? Math.round(Number(cfg.optCacheRamGb)) : 0,
      optRebuildOnRamHigh: cfg.optRebuildOnRamHigh !== false,
      optArenaThreads: Number(cfg.optArenaThreads) > 0 ? Math.round(Number(cfg.optArenaThreads)) : 0,
      note: "下次启动后端时生效",
    };
  });
  ipcMain.handle("h3:freeDisk", async () => {
    const cfg = loadConfig();
    const dir = cfg.installDir || app.getPath("home");
    const freeGb = await freeDiskGb(dir);
    return { ok: true, freeGb, needGb: DISK_HINT_GB };
  });
}

/** Do NOT stop ComfyUI on app quit — intentional singleton independent of MTNode. */
function shutdownH3UiOnly() {
  try {
    if (consoleWin && !consoleWin.isDestroyed()) consoleWin.close();
  } catch {}
  consoleWin = null;
  stopGpuPolling();
}

module.exports = {
  registerH3Ipc,
  shutdownH3UiOnly,
  statusForUi,
  PLUGIN_ID,
  DISK_HINT_GB,
};
