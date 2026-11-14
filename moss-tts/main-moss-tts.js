"use strict";
/**
 * MOSS-TTS-Nano 内置语音后端（主进程宿主）
 *
 * 与 Breeze / MOSS-Music 那些「插件卡片」不同：这是**随应用内置**的后端，没有插件卡、
 * 也没有安装窗 —— 用户第一次点状态栏那枚 TTS 按钮时，才在这里按需做四件事：
 *
 *   ① 同步随包脚手架（moss-tts-pack/app → <数据目录>/moss-tts/app）
 *   ② 建 venv 并装依赖（numpy / onnxruntime / sentencepiece / soundfile，**不装 torch**）
 *   ③ 从 hf-mirror 下 ONNX 权重（两个仓库，约 500MB，带百分比进度）
 *   ④ 拉起常驻工作进程 app/serve.py（模型在第一次合成时才真正加载）
 *
 * 为什么是「内置 + 首次下载」而不是插件：需求是「启用后持续开着 TTS」，用户不该先去找
 * 插件卡装一遍；而权重又不可能随包（NSIS 体积），所以只能首次下载。
 *
 * 数据一律落 %APPDATA%\pipeline-console\...\moss-tts（见 AGENTS.md「数据不落应用文件夹」）：
 *   config.json   启用开关 / 当前音色（内置 / 自定义 / Breeze 指针）
 *   models/       两个 ONNX 仓库（MOSS-TTS-Nano-100M-ONNX、MOSS-Audio-Tokenizer-Nano-ONNX）
 *   voices/       用户上传的参考音频（原样拷贝，播放时再交给 worker）
 *   合成产物不落盘：worker 把每句 wav 编成 base64 直接经 stdout 给宿主，宿主转给渲染层
 *   用 Blob 播（临时 wav 文件已取消，见 chunk.data）。
 *   cache/        固定文字的语音缓存：同一段话 + 同一音色 + 同一套采样参数只合成一次，
 *                 落成 <sha1>.wav，之后同一把钥匙直接读盘回放（不进 worker、不占显存）。
 *                 见下方「固定文字语音缓存」。容量有上限，超了按最久没用的先删。
 *   console.log   worker stderr / 安装链日志
 *
 * 流式：worker 每合成完一句就吐一条 {type:"chunk", data}（wav base64），宿主立刻转发给
 * 渲染层去播，所以「首个字」只等第一句（十几字）而不是整段。
 */

const { app, ipcMain, dialog, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const https = require("https");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { quietPython, silentEnv } = require("../backend-python.js");
const mirrors = require("../cn-mirrors.js");
const gpuDetect = require("./gpu-detect.js");

const HF_ENDPOINT = "https://hf-mirror.com";
const REPOS = [
  { dir: "MOSS-TTS-Nano-100M-ONNX", repo: "OpenMOSS-Team/MOSS-TTS-Nano-100M-ONNX" },
  { dir: "MOSS-Audio-Tokenizer-Nano-ONNX", repo: "OpenMOSS-Team/MOSS-Audio-Tokenizer-Nano-ONNX" },
];
/* 权重文件白名单：README / .gitattributes 之类不占空间也不参与推理，不下。 */
const KEEP_RE = /\.(onnx|data|json|model)$/i;

/* ── onnxruntime 两版二选一 ───────────────────────────────────────────────
 * CPU 版与 GPU 版都落在同一个 onnxruntime 命名空间（同名目录 + 同名 DLL），
 * 同时存在必然互相覆盖，所以「先清干净另一只，再装选定的一只」。
 * GPU 版锁在 1.2x：这一段才是 CUDA 12 + cuDNN 9 的构建，与本机 Breeze 后端那颗
 * cu128 torch 用同一套 CUDA 运行时；再往上的 1.23+ 跟着 CUDA 13 走，会找不到 DLL。 */
const ORT_GPU_SPEC = "onnxruntime-gpu>=1.20.0,<1.23.0";
const ORT_CPU_SPEC = "onnxruntime>=1.20.0";
/* CUDA 12 / cuDNN 9 运行时（pip 轮子）：onnxruntime-gpu 自己**不带**这些 DLL，
 * 缺了它 CUDAExecutionProvider 就只会在建 session 时静默退回 CPU（实测报
 * "Error loading onnxruntime_providers_cuda.dll ... depends on cublasLt64_12.dll"）。
 * 装进 venv 的 site-packages/nvidia/<pkg>/bin，由 ort.preload_dlls() 加载。 */
const ORT_CUDA_RUNTIME_SPECS = [
  "nvidia-cublas-cu12",
  /* cuDNN 锁 9.1.x：1.22 这颗 onnxruntime 内置的 cudnn_frontend 是 1.7.0，
     装到 9.6+ 的 cuDNN 上卷积节点会报 "Failed to initialize CUDNN Frontend"
     并逐个回落到 CPU（实测 9.28 就是这样，白装 1GB 还更慢）。 */
  "nvidia-cudnn-cu12>=9.1,<9.2",
  "nvidia-cuda-runtime-cu12",
  "nvidia-cufft-cu12",
];
/* 基础依赖（不含 onnxruntime）兜底清单：requirements.txt 读不到时用它。 */
const BASE_SPECS = ["numpy>=1.24", "sentencepiece>=0.1.99", "soundfile>=0.12.1"];
/* 自检脚本：能不能 import、版本、暴露了哪些 EP，以及**真的把 CUDA 后端拉起来**
 * （只问 get_available_providers() 不够：那份构建永远报 CUDA EP 在，
 *  缺 cublas/cuDNN 的 DLL 时建 session 会静默落成 CPU）。 */
const ORT_PROBE_PY = `
import json, os, sys, ctypes
import onnxruntime as ort
out = {"version": getattr(ort, "__version__", ""), "providers": list(ort.get_available_providers()),
       "cuda": False, "dll": ""}
if "CUDAExecutionProvider" in out["providers"]:
    preload = getattr(ort, "preload_dlls", None)
    if callable(preload):
        import io, contextlib
        buf = io.StringIO()
        try:
            with contextlib.redirect_stdout(buf):
                preload()
        except Exception as exc:
            out["preload"] = str(exc)[:300]
        for line in buf.getvalue().splitlines():
            if line.strip():
                print(line, file=sys.stderr)
    capi = os.path.join(os.path.dirname(os.path.abspath(ort.__file__)), "capi")
    dll = os.path.join(capi, "onnxruntime_providers_cuda.dll")
    try:
        loader = ctypes.WinDLL if os.name == "nt" else ctypes.CDLL
        loader(dll)
        out["cuda"] = True
        out["dll"] = "ok"
    except Exception as exc:
        out["dll"] = str(exc)[:400]
print(json.dumps(out))
`;

let getDataDir = () => "";
let getMainWin = () => null;
let appRoot = path.join(__dirname, "..");

let worker = null; /* { proc, buf, ready } */
let installing = null; /* Promise：同一时刻只跑一条安装链 */
let progress = { phase: "idle", pct: 0, label: "", error: "" };
let lastSpeakAt = 0;
/* 设备探测结果：**只在启用 / 安装时探一次**（不做轮询，不在合成路径上量显卡）。 */
let lastProbe = null; /* { mode, code, reason, gpu, at } */
/* worker 上报的实际设备（device 事件），本进程内保留，重启 worker 时清空。 */
let workerDevice = null; /* { provider, requested, reason, at } */

/* ── 路径 ─────────────────────────────────────────────────────────────── */
function root() {
  const base = (typeof getDataDir === "function" && getDataDir()) || app.getPath("userData");
  return ensureDir(path.join(base, "moss-tts"));
}
function ensureDir(p) {
  try {
    fs.mkdirSync(p, { recursive: true });
  } catch {}
  return p;
}
function paths() {
  const r = root();
  return {
    root: r,
    app: path.join(r, "app"),
    venv: path.join(r, "venv"),
    python: path.join(r, "venv", "Scripts", "pythonw.exe"),
    pythonReal: path.join(r, "venv", "Scripts", "python.exe"),
    models: path.join(r, "models"),
    voices: path.join(r, "voices"),
    cache: path.join(r, "cache"),
    out: path.join(r, "out"),
    config: path.join(r, "config.json"),
    log: path.join(r, "console.log"),
  };
}
/** 随包脚手架目录：开发态在仓库里，打包态在 resources/moss-tts-pack。 */
function packDir() {
  if (app.isPackaged) {
    const packed = path.join(process.resourcesPath, "moss-tts-pack", "app");
    if (fs.existsSync(packed)) return packed;
  }
  return path.join(appRoot, "moss-tts-pack", "app");
}

/* ── 日志 ─────────────────────────────────────────────────────────────── */
function logLine(s) {
  const line = "[" + new Date().toISOString() + "] " + String(s || "");
  try {
    fs.appendFileSync(paths().log, line + "\n");
  } catch {}
}
function consoleTail(n) {
  try {
    const txt = fs.readFileSync(paths().log, "utf8");
    return txt.split(/\r?\n/).slice(-Math.max(20, Number(n) || 200)).join("\n");
  } catch {
    return "";
  }
}

/* ── 采样参数（温度 / top-k / top-p / 重复惩罚）────────────────────────────
 * 用户可微调的那几项直接映射 worker manifest 的 generation_defaults（见
 * moss-tts-pack/app/serve.py 的 GENERATION_PARAM_SPECS，两处范围同口径，两边都钳）。
 * 只影响「怎么采样」，不动音色 / 参考音频；改完立刻对下一次合成生效，不重启 worker。 */
const PARAM_SPECS = {
  /* 采样种子：固定住它，同一段文字 + 同一参考音频 ⇒ 同一段音频。
     以前 rng 是 worker 里的全局序列、且每次播报不重置，所以「同样的话每次音色都不一样」；
     现在每次合成前都按这颗种子重置（见 moss-tts-pack/app/serve.py 的 _request_seed）。 */
  seed: { min: 0, max: 999999, def: 1, int: true },
  audioTemperature: { min: 0.1, max: 2, def: 0.8, int: false },
  audioTopK: { min: 0, max: 200, def: 25, int: true },
  audioTopP: { min: 0.05, max: 1, def: 0.95, int: false },
  audioRepetitionPenalty: { min: 1, max: 2, def: 1.2, int: false },
  textTemperature: { min: 0.1, max: 2, def: 1, int: false },
  textTopK: { min: 0, max: 200, def: 50, int: true },
  textTopP: { min: 0.05, max: 1, def: 1, int: false },
};
function defaultParams() {
  const out = {};
  for (const key of Object.keys(PARAM_SPECS)) out[key] = PARAM_SPECS[key].def;
  return out;
}
/** 任意输入 → 一份合法参数（缺项补默认、超界钳住、乱值丢掉）。 */
function normalizeParams(raw) {
  const out = defaultParams();
  const src = raw && typeof raw === "object" ? raw : {};
  for (const [key, spec] of Object.entries(PARAM_SPECS)) {
    const v = Number(src[key]);
    if (!Number.isFinite(v)) continue;
    const clamped = Math.min(spec.max, Math.max(spec.min, v));
    out[key] = spec.int ? Math.round(clamped) : Math.round(clamped * 1000) / 1000;
  }
  return out;
}

/* ── 配置（启用开关 + 音色） ──────────────────────────────────────────── */
function readConfig() {
  const p = paths().config;
  let j = null;
  try {
    j = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {}
  const cfg = j && typeof j === "object" ? j : {};
  /* 老配置里的 seed 42 是旧默认（当时写死 42）；现在默认统一成 1。
     只在没有迁移标记时改一次 —— 之后用户自己填 42 也照旧生效。 */
  const params = normalizeParams(cfg.params);
  let seedDefaultMigrated = cfg.seedDefaultMigrated === true;
  if (!seedDefaultMigrated) {
    if (cfg.params && Number(cfg.params.seed) === 42) params.seed = 1;
    seedDefaultMigrated = true;
  }
  return {
    enabled: !!cfg.enabled,
    voice: cfg.voice && typeof cfg.voice === "object" ? cfg.voice : { kind: "builtin" },
    maxChars: Number(cfg.maxChars) || 42,
    /* 语音微调：温度 / top-k / top-p / 重复惩罚（缺项按默认补） */
    params,
    /* 旧默认种子已迁移成 1 的标记（写盘后不再改用户自己填的值） */
    seedDefaultMigrated,
    /* 推理设备偏好：auto = 按探测 + 实际初始化结果走；cpu = 强制 CPU（不试 CUDA） */
    provider: cfg.provider === "cpu" ? "cpu" : "auto",
    /* 上一次 worker 上报的设备决策，**仅展示用**（真源仍是 worker 事件） */
    lastDevice: cfg.lastDevice && typeof cfg.lastDevice === "object" ? cfg.lastDevice : null,
    /* CUDA 后端自检通过时的缓存键（onnxruntime 版本 + 运行时包形态）：
       装上了 ≠ 真能用，缺 CUDA / cuDNN DLL 时只在建 session 时静默退 CPU */
    cudaVerified: String(cfg.cudaVerified || ""),
  };
}
function writeConfig(patch) {
  const next = Object.assign(readConfig(), patch || {});
  try {
    fs.writeFileSync(paths().config, JSON.stringify(next, null, 2), "utf8");
  } catch {}
  return next;
}

/* ── 音色：内置 / 自定义 / Breeze 指针 ────────────────────────────────── */
function builtinVoice() {
  const dir = path.join(packDir(), "seed");
  const wav = path.join(dir, "deepseek.wav");
  let meta = {};
  try {
    meta = JSON.parse(fs.readFileSync(path.join(dir, "deepseek.json"), "utf8"));
  } catch {}
  return {
    kind: "builtin",
    id: "builtin-deepseek",
    name: meta.name || "Deepseek",
    audioPath: fs.existsSync(wav) ? wav : "",
    refText: meta.refText || "",
  };
}
/** Breeze 预设索引（只读）。Breeze 未安装 / 没角色时返回空数组，调用方回落内置音色。 */
function breezePresets() {
  const idx = path.join(
    (typeof getDataDir === "function" && getDataDir()) || app.getPath("userData"),
    "breeze-tts",
    "presets",
    "index.json"
  );
  let j = null;
  try {
    j = JSON.parse(fs.readFileSync(idx, "utf8"));
  } catch {
    return [];
  }
  const audioDir = path.join(path.dirname(idx), "audio");
  const out = [];
  for (const p of Array.isArray(j && j.presets) ? j.presets : []) {
    const groups = [];
    for (const g of Array.isArray(p && p.groups) ? p.groups : []) {
      const file = String((g && g.audioFile) || "");
      const audioPath = file ? path.join(audioDir, file) : "";
      if (!audioPath || !fs.existsSync(audioPath)) continue;
      groups.push({
        id: String(g.id || ""),
        name: String(g.name || ""),
        kind: g.kind === "alt" ? "alt" : "base",
        audioPath,
      });
    }
    if (groups.length) out.push({ id: String(p.id || ""), name: String(p.name || ""), groups });
  }
  return out;
}
/** 当前音色解析成 { audioPath, name, kind }：Breeze 指针现读，找不到就回落内置默认。 */
function resolveVoice(cfg) {
  const v = (cfg && cfg.voice) || { kind: "builtin" };
  if (v.kind === "custom") {
    const p = String(v.audioPath || "");
    if (p && fs.existsSync(p)) return { kind: "custom", name: v.name || path.basename(p), audioPath: p };
    return Object.assign({ fallback: true }, builtinVoice());
  }
  if (v.kind === "breeze") {
    const preset = breezePresets().find((x) => x.id === v.presetId);
    const group = preset && (preset.groups.find((g) => g.id === v.groupId) || preset.groups[0]);
    if (preset && group) {
      const groupLabel = group.name ? " · " + group.name : "";
      return {
        kind: "breeze",
        name: preset.name + groupLabel,
        audioPath: group.audioPath,
        presetId: preset.id,
        groupId: group.id,
      };
    }
    return Object.assign({ fallback: true }, builtinVoice());
  }
  return builtinVoice();
}

/* ── 固定文字语音缓存（同一段话只合成一次）────────────────────────────────
 * 播报里有一批**文字固定**的话（「有新的询问等你回应」「画布运行完成」「出错了：…」、
 * 右键试听那句样例、同一轮摘要的重播…）。合成参数里的 seed 是固定的（见 PARAM_SPECS.seed），
 * 所以「同一段文字 + 同一音色 + 同一套参数」出来的音频是确定的 —— 第一次合成完就把整段
 * wav 存进 cache/<key>.wav，之后同一把钥匙（key）直接读盘回放：不拉 worker、不加载模型、
 * 不占显存，几乎零延迟。换音色 / 改参数 / 换参考音频 / 改文字都是另一把钥匙。
 * 容量有上限（文件数 + 总字节），超了先删最久没用过的（读盘时会刷新 mtime）。 */
const CACHE_MAX_FILES = 300;
const CACHE_MAX_BYTES = 256 * 1024 * 1024;
const synthCache = new Map(); /* id → { key, parts: [Buffer] }：正在合成、等 done 落盘的那一份 */

/** 一把钥匙 = 文字 + 音色（含参考音频的路径 / 大小 / 修改时间）+ 采样参数 + 分段字数。 */
function cacheKey(text, voice, params, maxChars) {
  let stamp = "";
  try {
    const ap = (voice && voice.audioPath) || "";
    if (ap) {
      const s = fs.statSync(ap);
      stamp = path.resolve(ap) + "|" + s.size + "|" + Math.round(s.mtimeMs);
    }
  } catch {}
  const h = crypto.createHash("sha1");
  h.update(
    JSON.stringify({
      v: 1,
      text: String(text || ""),
      voice: ((voice && voice.kind) || "") + "|" + stamp,
      params: params || {},
      maxChars: Number(maxChars) || 0,
    })
  );
  return h.digest("hex");
}
function cacheFile(key) {
  return path.join(ensureDir(paths().cache), key + ".wav");
}
/** 命中就返回 { file, data }（Buffer）；顺手刷 mtime，LRU 淘汰时它就不是「最久没用」的。 */
function cacheLookup(key) {
  const file = cacheFile(key);
  try {
    const data = fs.readFileSync(file);
    if (data.length <= 44) return null;
    const now = new Date();
    try {
      fs.utimesSync(file, now, now);
    } catch {}
    return { file, data };
  } catch {
    return null;
  }
}
/** 原子落盘（先写 .tmp 再改名）：中途退出不会留半截 wav 被下次当成命中。 */
function cacheStore(key, buf) {
  if (!buf || buf.length <= 44) return "";
  const file = cacheFile(key);
  const tmp = file + "." + process.pid + ".tmp";
  try {
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, file);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {}
    logLine("语音缓存写入失败：" + ((e && e.message) || e));
    return "";
  }
  cachePrune();
  return file;
}
function cachePrune() {
  const dir = paths().cache;
  let list = [];
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!/\.wav$/i.test(f)) continue;
      const p = path.join(dir, f);
      try {
        const s = fs.statSync(p);
        list.push({ p, size: s.size, at: s.mtimeMs });
      } catch {}
    }
  } catch {
    return;
  }
  let total = list.reduce((a, x) => a + x.size, 0);
  let count = list.length;
  if (count <= CACHE_MAX_FILES && total <= CACHE_MAX_BYTES) return;
  list.sort((a, b) => a.at - b.at);
  for (const x of list) {
    if (count <= CACHE_MAX_FILES && total <= CACHE_MAX_BYTES) break;
    try {
      fs.unlinkSync(x.p);
      count -= 1;
      total -= x.size;
    } catch {}
  }
}

/** 拆一份 wav：返回 { fmt: Buffer, pcm: Buffer }（不是合法 RIFF 就 null）。 */
function wavPieces(buf) {
  if (!buf || buf.length < 44) return null;
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") return null;
  let off = 12;
  let fmt = null;
  let pcm = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === "fmt ") fmt = buf.subarray(body, body + size);
    else if (id === "data") {
      pcm = buf.subarray(body, Math.min(body + size, buf.length));
      break;
    }
    off = body + size + (size % 2);
  }
  if (!fmt || !pcm) return null;
  return { fmt, pcm };
}
/** 把 worker 逐句吐的 wav（每句一个完整 RIFF）拼成一份连续 wav，落盘缓存用。 */
function wavMerge(buffers) {
  const parts = [];
  let fmt = null;
  for (const b of buffers || []) {
    const p = wavPieces(b);
    if (!p) continue;
    if (!fmt) fmt = p.fmt;
    if (p.pcm.length) parts.push(p.pcm);
  }
  if (!fmt || !parts.length) return null;
  const dataLen = parts.reduce((a, x) => a + x.length, 0);
  const head = Buffer.alloc(20 + fmt.length + 8);
  head.write("RIFF", 0, "ascii");
  head.writeUInt32LE(head.length - 8 + dataLen, 4);
  head.write("WAVE", 8, "ascii");
  head.write("fmt ", 12, "ascii");
  head.writeUInt32LE(fmt.length, 16);
  fmt.copy(head, 20);
  const off = 20 + fmt.length;
  head.write("data", off, "ascii");
  head.writeUInt32LE(dataLen, off + 4);
  return Buffer.concat([head, ...parts]);
}

/* ── 安装：脚手架 / venv / 依赖 / 权重 ───────────────────────────────── */
function emitProgress(patch) {
  progress = Object.assign({}, progress, patch || {});
  try {
    const win = getMainWin && getMainWin();
    if (win && !win.isDestroyed()) win.webContents.send("mosstts:progress", progress);
  } catch {}
}
function copyDir(src, dst, skip) {
  const skipSet = new Set(skip || []);
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    if (skipSet.has(ent.name)) continue;
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    if (ent.isDirectory()) copyDir(s, d, skip);
    else {
      try {
        fs.copyFileSync(s, d);
      } catch {}
    }
  }
}
function syncScaffold() {
  const src = packDir();
  if (!fs.existsSync(path.join(src, "serve.py"))) {
    throw new Error("随包脚手架缺失：找不到 moss-tts-pack/app/serve.py");
  }
  copyDir(src, paths().app, ["__pycache__", "out", "generated_audio"]);
}
function basePython() {
  /* 优先用户机器上的 python（3.10+）；没有就报一条人看得懂的错。 */
  const cands = ["python", "python3", "py"];
  for (const c of cands) {
    try {
      require("child_process").execFileSync(c, ["--version"], { windowsHide: true, stdio: "ignore" });
      return c;
    } catch {}
  }
  return "";
}
function run(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, Object.assign({ windowsHide: true, stdio: "ignore" }, opts || {}));
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(cmd + " 退出码 " + code))));
  });
}
async function ensureVenv() {
  const p = paths();
  if (fs.existsSync(p.pythonReal)) return;
  const py = basePython();
  if (!py) throw new Error("本机没有可用的 Python（需要 3.10+）。装好 Python 后再点启用。");
  emitProgress({ phase: "venv", pct: 6, label: "创建 Python 虚拟环境" });
  await run(py, ["-m", "venv", p.venv], { env: silentEnv() });
  if (!fs.existsSync(p.pythonReal)) throw new Error("venv 创建失败：" + p.pythonReal);
}
async function pipInstall(device) {
  const p = paths();
  const req = path.join(p.app, "requirements.txt");
  const env = mirrors.installEnv();
  const py = p.pythonReal;
  emitProgress({ phase: "pip", pct: 12, label: "安装依赖（numpy / sentencepiece / soundfile）" });
  await installBaseDeps(py, env);
  if (!fs.existsSync(req)) logLine("warning: requirements.txt 未同步到 app 目录");

  const wantGpu = !!(device && device.mode === "cuda");
  if (!wantGpu) {
    const r = await installOrt(py, env, "cpu");
    if (!r.ok) throw new Error("onnxruntime 安装失败：" + r.error);
    logLine("onnxruntime " + (r.version || "") + " 就绪（CPU 版）");
    emitProgress({ pct: 26, label: "已装 CPU 版 onnxruntime" });
    return { mode: "cpu", version: r.version };
  }

  emitProgress({ pct: 16, label: "安装 onnxruntime-gpu（CUDA 12 / cuDNN 9）" });
  const gpu = await installOrt(py, env, "gpu");
  if (gpu.ok) {
    logLine("onnxruntime-gpu " + (gpu.version || "") + " 就绪（CUDAExecutionProvider 可用）");
    emitProgress({ pct: 26, label: "已装 onnxruntime-gpu " + (gpu.version || "") });
    return { mode: "cuda", version: gpu.version };
  }

  /* GPU 版装不上 / 装上但导入自检拿不到 CUDAExecutionProvider：回退 CPU 版，不判安装失败 */
  const why = shortWhy(gpu.error || "unavailable");
  logLine("onnxruntime-gpu 安装或导入自检失败，回退 CPU 版：" + (gpu.error || ""));
  emitProgress({ pct: 18, label: "GPU 版不可用（" + why + "），改装 CPU 版" });
  const cpu = await installOrt(py, env, "cpu");
  if (!cpu.ok) throw new Error("onnxruntime CPU 版回退也失败：" + cpu.error + "（GPU 版原因：" + (gpu.error || "") + "）");
  logLine("已回退 onnxruntime " + (cpu.version || "") + "（CPU 版）；GPU 版原因：" + (gpu.error || ""));
  emitProgress({ pct: 26, label: "已回退 CPU 版 onnxruntime（GPU 版不可用）" });
  return { mode: "cpu", version: cpu.version, fallback: "gpu_failed", error: gpu.error || "" };
}
/** requirements.txt 里除 onnxruntime 之外的依赖：onnxruntime 哪一版由设备探测决定，必须单独装。 */
function baseSpecs() {
  let lines = null;
  try {
    lines = fs.readFileSync(path.join(paths().app, "requirements.txt"), "utf8").split(/\r?\n/);
  } catch {
    return BASE_SPECS.slice();
  }
  const specs = [];
  for (const raw of lines) {
    const line = String(raw || "").split("#")[0].trim();
    if (!line) continue;
    if (/^onnxruntime/i.test(line)) continue;
    specs.push(line);
  }
  return specs.length ? specs : BASE_SPECS.slice();
}
async function installBaseDeps(py, env) {
  const specs = baseSpecs();
  try {
    await run(py, ["-m", "pip", "install", "--disable-pip-version-check", "--no-input", ...specs], { env });
  } catch (e) {
    /* 有些机器的 pip 对多包一次性解析敏感，退回逐包安装 */
    logLine("pip 装基础依赖失败，逐包重试：" + (e && e.message));
    for (const spec of specs) {
      await run(py, ["-m", "pip", "install", "--disable-pip-version-check", "--no-input", spec], { env });
    }
  }
}
function sitePackages() {
  return path.join(paths().venv, "Lib", "site-packages");
}
/** site-packages 里的 onnxruntime 落盘形态：{ any, gpu }。
 *  两版同名目录，只能靠发行元数据（onnxruntime_gpu-*.dist-info / *.libs）
 *  或 CUDA 后端 DLL 认出 GPU 版。 */
function ortInstalled() {
  const dir = sitePackages();
  let entries = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return { any: false, gpu: false };
  }
  const any = entries.some((n) => /^~?onnxruntime/i.test(n));
  const gpu =
    entries.some((n) => /^onnxruntime[_-]gpu[-._]/i.test(n)) ||
    fs.existsSync(path.join(dir, "onnxruntime", "capi", "onnxruntime_providers_cuda.dll"));
  return { any, gpu };
}
/** 把两种 onnxruntime 彻底清掉再装：残留的同名目录 / DLL 会让新装的版本被旧文件盖住。 */
async function purgeOrt(py, env) {
  if (ortInstalled().any) {
    for (const pkg of ["onnxruntime", "onnxruntime-gpu"]) {
      try {
        await run(py, ["-m", "pip", "uninstall", "-y", pkg], { env });
      } catch {}
    }
  }
  /* pip uninstall 偶尔留 dist-info / .libs / capi DLL，逐个删干净 */
  const dir = sitePackages();
  let entries = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!/^~?onnxruntime/i.test(name)) continue;
    try {
      fs.rmSync(path.join(dir, name), { recursive: true, force: true });
    } catch (e) {
      logLine("清理 onnxruntime 残留失败：" + name + " " + ((e && e.message) || e));
    }
  }
}
/** 装 CUDA 12 / cuDNN 9 运行时轮子（onnxruntime-gpu 不带这些 DLL）。
 *  一次运行里只试一次：装不上（网络 / 轮子不匹配）就本轮老实走 CPU，
 *  别让用户每点一次开关都重下这 ~1GB。 */
let cudaRuntimeTried = false;
async function installCudaRuntime(py, env) {
  if (cudaRuntimeTried) return { ok: false, error: "本次运行已尝试过 CUDA 运行时安装，未重复下载" };
  cudaRuntimeTried = true;
  emitProgress({ pct: 22, label: "补齐 CUDA 12 / cuDNN 9 运行时（约 1GB）" });
  try {
    await run(py, ["-m", "pip", "install", "--disable-pip-version-check", "--no-input", ...ORT_CUDA_RUNTIME_SPECS], {
      env,
    });
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
  logLine("CUDA 12 / cuDNN 9 运行时已就绪（" + ORT_CUDA_RUNTIME_SPECS.join(" / ") + "）");
  return { ok: true };
}
/** 装一只 onnxruntime 并做导入自检。kind = "gpu" | "cpu"。 */
async function installOrt(py, env, kind) {
  await purgeOrt(py, env);
  const spec = kind === "gpu" ? ORT_GPU_SPEC : ORT_CPU_SPEC;
  try {
    await run(py, ["-m", "pip", "install", "--disable-pip-version-check", "--no-input", spec], { env });
  } catch (e) {
    return { ok: false, error: spec + " 安装失败：" + ((e && e.message) || e) };
  }
  /* 自检要能正常加载 C 扩展：继承本进程环境（PATH / SystemRoot），再叠镜像变量 */
  const chkEnv = Object.assign({}, process.env, env);
  let chk = await ortSelfCheck(py, chkEnv);
  if (!chk.ok) return { ok: false, error: spec + " 导入自检失败：" + chk.error };
  if (kind === "gpu" && !chk.cuda) {
    /* 构建暴露了 CUDA EP，但 CUDA 后端 DLL 拉不起来（缺 cublas / cuDNN）：
       补装 pip 版 CUDA 12 / cuDNN 9 运行时，再自检一次。 */
    logLine("onnxruntime-gpu 的 CUDA 后端加载失败（" + (chk.dll || "unknown") + "），补装 CUDA 12 / cuDNN 9 运行时");
    emitProgress({ pct: 20, label: "补装 CUDA 12 / cuDNN 9 运行时" });
    const rt = await installCudaRuntime(py, env);
    if (rt.ok) {
      chk = await ortSelfCheck(py, chkEnv);
      if (!chk.ok) return { ok: false, error: spec + " 补装运行时后导入自检失败：" + chk.error };
    }
    if (!chk.cuda) {
      return {
        ok: false,
        error:
          spec +
          " 装上但 CUDA 后端加载不了" +
          (chk.dll && chk.dll !== "ok" ? "（" + chk.dll + "）" : "") +
          (rt.ok ? "" : "，且 CUDA 运行时补装失败：" + rt.error) +
          "；可改用 CPU 推理",
      };
    }
  }
  return { ok: true, version: chk.version };
}
/** 导入自检：只 import + 读 EP，不加载模型。 */
async function ortSelfCheck(py, env) {
  const r = await runCapture(py, ["-c", ORT_PROBE_PY], { env, timeoutMs: 120000 });
  if (r.code !== 0) return { ok: false, error: tailOf(r.stderr) || tailOf(r.stdout) || "退出码 " + r.code };
  let j = null;
  try {
    j = JSON.parse(String(r.stdout || "").trim().split(/\r?\n/).pop());
  } catch {}
  if (!j) return { ok: false, error: "自检输出无法解析：" + tailOf(r.stdout) };
  const providers = (Array.isArray(j.providers) ? j.providers : []).map((x) => String(x));
  return {
    ok: true,
    version: String(j.version || ""),
    providers,
    /* 真把 CUDA 后端 DLL 拉起来过 = true；只有构建声明不算 */
    cuda: !!j.cuda && providers.includes("CUDAExecutionProvider"),
    dll: String(j.dll || ""),
  };
}
/** 跑一条命令并收 stdout / stderr（短命令自检用；绝不抛）。 */
function runCapture(cmd, args, opts) {
  const o = opts || {};
  return new Promise((resolve) => {
    let child = null;
    let done = false;
    let out = "";
    let err = "";
    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, stdout: out, stderr: err });
    };
    const timer = setTimeout(() => {
      try {
        if (child) child.kill();
      } catch {}
      err += "\ntimeout";
      finish(-1);
    }, Number(o.timeoutMs) > 0 ? Number(o.timeoutMs) : 60000);
    if (timer.unref) timer.unref();
    try {
      child = spawn(cmd, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: o.env || process.env });
    } catch (e) {
      err = String((e && e.message) || e);
      finish(-1);
      return;
    }
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      err += " " + String((e && e.message) || e);
      finish(-1);
    });
    child.on("exit", (code) => finish(code));
  });
}
/** 日志里的原因：取最后一行非空、掐到 200 字（traceback 最后一行通常就够）。 */
function tailOf(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  const last = lines.length ? lines[lines.length - 1] : "";
  return last.slice(0, 200);
}
/** 进度 label 里的短原因：压成单行、掐到 60 字。 */
function shortWhy(text) {
  const s = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  return s.length > 60 ? s.slice(0, 57) + "…" : s || "unavailable";
}
/* 把重定向 Location 补成绝对地址。
 * hf-mirror 对小文件（manifest / meta 之类）回的是**相对** Location，
 * 形如 /api/resolve-cache/models/…，直接喂 https.get 会在 new URL 里抛
 * 「TypeError: Invalid URL」；抛点又在响应回调里，没人接得住，主进程直接崩。
 * 坏地址一律回 null，由调用方 reject —— 这里永远不抛。 */
function resolveHop(location, base) {
  try {
    return new URL(String(location || ""), base).href;
  } catch {
    return null;
  }
}
function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { "User-Agent": "MTNode/1.0" } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          const next = resolveHop(res.headers.location, url);
          if (!next) {
            reject(new Error("重定向地址无效：" + shortWhy(res.headers.location)));
            return;
          }
          httpGetJson(next).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error("HTTP " + res.statusCode + " " + url));
          return;
        }
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", (d) => (buf += d));
        res.on("end", () => {
          try {
            resolve(JSON.parse(buf));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on("error", reject);
  });
}
function downloadFile(url, dest, onBytes) {
  return new Promise((resolve, reject) => {
    const tmp = dest + ".part";
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const out = fs.createWriteStream(tmp);
    const get = (u, hops) => {
      let req;
      try {
        req = https.get(u, { headers: { "User-Agent": "MTNode/1.0" } }, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops > 0) {
            res.resume();
            /* 同 httpGetJson：hf-mirror 会回相对 Location，先补成绝对再跳 */
            const next = resolveHop(res.headers.location, u);
            if (!next) {
              out.close();
              try {
                fs.unlinkSync(tmp);
              } catch {}
              reject(new Error("重定向地址无效：" + shortWhy(res.headers.location)));
              return;
            }
            get(next, hops - 1);
            return;
          }
          if (res.statusCode !== 200) {
            res.resume();
            out.close();
            try {
              fs.unlinkSync(tmp);
            } catch {}
            reject(new Error("HTTP " + res.statusCode + " " + u));
            return;
          }
          res.on("data", (d) => onBytes && onBytes(d.length));
          res.pipe(out);
          out.on("finish", () => {
            out.close(() => {
              try {
                fs.renameSync(tmp, dest);
              } catch (e) {
                reject(e);
                return;
              }
              resolve(dest);
            });
          });
        });
      } catch (e) {
        /* 坏 URL / 非法请求同步抛出：转成 reject，不冒到主进程 */
        try {
          out.close();
        } catch {}
        reject(e);
        return;
      }
      req.on("error", (e) => {
        try {
          out.close();
        } catch {}
        reject(e);
      });
    };
    get(url, 4);
  });
}
async function ensureWeights() {
  const p = paths();
  /* 先算总清单（含体积），再逐个下，进度才有意义 */
  const plan = [];
  for (const r of REPOS) {
    const info = await httpGetJson(HF_ENDPOINT + "/api/models/" + r.repo);
    for (const s of (info && info.siblings) || []) {
      const name = String(s.rfilename || "");
      if (!name || !KEEP_RE.test(name)) continue;
      plan.push({
        url: HF_ENDPOINT + "/" + r.repo + "/resolve/main/" + name,
        dest: path.join(p.models, r.dir, name),
      });
    }
  }
  if (!plan.length) throw new Error("拿不到权重清单（hf-mirror 返回空）");
  const todo = plan.filter((x) => !fs.existsSync(x.dest) || fs.statSync(x.dest).size < 1024);
  let done = 0;
  emitProgress({
    phase: "weights",
    pct: 30,
    label: todo.length ? "下载 ONNX 权重（首次约 500MB）" : "权重已就绪",
    files: plan.length,
    filesDone: plan.length - todo.length,
  });
  for (const item of todo) {
    await downloadFile(item.url, item.dest);
    done += 1;
    emitProgress({
      pct: Math.min(92, 30 + Math.round((done / Math.max(1, todo.length)) * 60)),
      label: "下载 ONNX 权重（" + done + "/" + todo.length + "）",
      filesDone: plan.length - todo.length + done,
    });
  }
  /* 自检：推理真正要的三个文件在不在 */
  const must = [
    path.join(p.models, "MOSS-TTS-Nano-100M-ONNX", "browser_poc_manifest.json"),
    path.join(p.models, "MOSS-Audio-Tokenizer-Nano-ONNX", "codec_browser_onnx_meta.json"),
  ];
  for (const m of must) if (!fs.existsSync(m)) throw new Error("权重文件缺失：" + m);
}

/* ── 推理设备：探测（一次性）与展示口径 ──────────────────────────────── */
/** 探一次显卡（永不 reject）。force=false 时有缓存就直接用 —— 启用 / 安装才探，合成不探。 */
function probeDevice(force) {
  if (lastProbe && !force) return Promise.resolve(lastProbe);
  return gpuDetect.detect().then((probe) => {
    lastProbe = {
      mode: probe.mode === "cuda" ? "cuda" : "cpu",
      code: String(probe.code || ""),
      reason: String(probe.reason || ""),
      gpu: probe.gpu || null,
      at: Date.now(),
    };
    return lastProbe;
  });
}
/** 拼 worker 的 --provider：config 优先，auto 再看探测结果与已装的 onnxruntime 形态。 */function providerForWorker(cfg) {
  if (cfg.provider === "cpu") return "cpu";
  if (!lastProbe) return "auto"; /* 这次进程还没探过（比如只开了状态没启用）：交给 worker 自己探 */
  if (lastProbe.mode !== "cuda") return "cpu"; /* 探测判 CPU：别让 worker 再白试一遍 CUDA */
  /* 探测判 CUDA，但装的是 CPU 版 onnxruntime：交给 worker 试，失败原因原样报回来 */
  return ortInstalled().gpu ? "cuda" : "auto";
}
/** 展示用决策：{ requested, gpu, mode, code, reason, probedAt, gpuInfo }。 */
function decisionOf(cfg) {
  const probe = lastProbe;
  return {
    requested: cfg.provider,
    gpu: !!(probe && probe.mode === "cuda"),
    mode: probe ? probe.mode : "",
    code: probe ? probe.code : "not_probed",
    reason: probe ? probe.reason : "尚未探测（启用或安装时探一次）",
    probedAt: probe ? probe.at : 0,
    gpuInfo: probe ? probe.gpu : null,
  };
}
/** 展示用实际设备：优先本进程 worker 上报，其次 config 里的上次结果。 */
function deviceOf(cfg, decision) {
  const src = workerDevice || (cfg.lastDevice && cfg.lastDevice.provider ? cfg.lastDevice : null);
  const provider = src ? String(src.provider || "") : "";
  /* 偏好是 cpu 时 requested 就是 cpu：这是用户的选择，不算回落（旧 lastDevice 可能还是 auto） */
  const requested = cfg.provider === "cpu" ? "cpu" : src ? String(src.requested || cfg.provider) : cfg.provider;
  return {
    provider,
    requested,
    reason: src ? String(src.reason || "") : "",
    from: workerDevice ? "worker" : src ? "last_run" : "",
    at: src ? Number(src.at) || 0 : 0,
    /* 想要 GPU 却落在 CPU 上 = 回落 */
    fallback: provider === "cpu" && cfg.provider !== "cpu" && (requested === "cuda" || decision.gpu),
  };
}

/** 已装的 onnxruntime-gpu 缓存键：换了版本 / 补了运行时轮子就该重新自检。 */
function cudaProbeKey() {
  const dir = sitePackages();
  let names = [];
  try {
    names = fs
      .readdirSync(dir)
      .filter((n) => /^onnxruntime[_-]gpu[-._]/i.test(n) || /^nvidia$/i.test(n) || /^nvidia[_-]/i.test(n))
      .sort();
  } catch {}
  return names.join("|");
}
/** CUDA 后端到底能不能起来（真的 dlopen 一次 onnxruntime_providers_cuda.dll）。
 *  通了就按版本缓存，没通每次重验 —— 失败才是要修的那一头。 */
async function cudaUsable() {
  if (!ortInstalled().gpu) return false;
  const key = cudaProbeKey();
  const cfg = readConfig();
  if (key && cfg.cudaVerified && cfg.cudaVerified === key) return true;
  const chk = await ortSelfCheck(paths().pythonReal, Object.assign({}, process.env, mirrors.installEnv()));
  if (!chk.ok || !chk.cuda) {
    logLine("CUDA 后端自检未通过：" + (chk.error || chk.dll || "unknown"));
    return false;
  }
  writeConfig({ cudaVerified: key });
  return true;
}

/** 安装链（幂等）：已装好的环节直接跳过。返回 { ok, error, mode }。 */
function ensureInstalled() {
  if (installing) return installing;
  installing = (async () => {
    let ortResult = null;
    try {
      /* 设备探测先做：装 CPU 版还是 GPU 版由它定；探测永不 reject（量不到就是 cpu） */
      const probe = await probeDevice();
      const wantGpu = probe.mode === "cuda";
      const before = ortInstalled();
      /* 已装 CPU 版但本机有 N 卡 → 重装为 GPU 版（否则永远是 CPU 推理） */
      const upgrade = wantGpu && before.any && !before.gpu;
      /* GPU 版装上了但 CUDA 后端拉不起来（缺 cublas / cuDNN）→ 同样要重装补齐 */
      const brokenGpu = wantGpu && before.gpu && !(await cudaUsable());
      logLine(
        "推理设备探测：" +
          probe.mode +
          " —— " +
          probe.reason +
          (wantGpu ? " · 目标 onnxruntime-gpu" : " · 目标 onnxruntime（CPU）")
      );
      /* 快速通道：设备已满足就别再打一遍网络（点开关是高频操作）。
         但脚手架（serve.py / *.py）每次都要同步：修复是改在随包那份上的，
         已装用户不同步就永远跑旧代码（GPU / CPU 的 bug 都吃过这一口）。 */
      if (!upgrade && !brokenGpu && state().installed && !progress.error) {
        try {
          syncScaffold();
        } catch (e) {
          logLine("脚手架同步失败（继续用已装版本）：" + ((e && e.message) || e));
        }
        return { ok: true, mode: probe.mode };
      }

      emitProgress({
        phase: "scaffold",
        pct: 2,
        label: upgrade ? "已装 CPU 版，改装 GPU 版 onnxruntime" : "同步推理脚手架",
        error: "",
      });
      syncScaffold();
      await ensureVenv();
      const ort = ortInstalled();
      if (!ort.any || (wantGpu && (!ort.gpu || brokenGpu))) {
        if (upgrade) logLine("升级 onnxruntime：site-packages 里是 CPU 版，按探测结果重装为 GPU 版");
        if (brokenGpu) logLine("onnxruntime-gpu 已在，但 CUDA 后端不可用：重装并补齐 CUDA 12 / cuDNN 9 运行时");
        ortResult = await pipInstall(probe);
      }
      await ensureWeights();
      const mode = ortResult ? ortResult.mode : ort.gpu ? "cuda" : "cpu";
      /* 刚装好并自检通过：把缓存键落下，下次点开关不必再跑一遍 python 自检 */
      if (ortResult && ortResult.mode === "cuda") writeConfig({ cudaVerified: cudaProbeKey() });
      const note = ortResult && ortResult.fallback ? "GPU 版不可用，用 CPU 推理" : "";
      emitProgress({ phase: "ready", pct: 100, label: note ? "已就绪 · " + note : "已就绪", error: "" });
      return { ok: true, mode };
    } catch (e) {
      const msg = (e && e.message) || String(e);
      logLine("install failed: " + msg);
      emitProgress({ phase: "error", pct: 0, label: "安装失败", error: msg });
      return { ok: false, error: msg };
    } finally {
      installing = null;
    }
  })();
  return installing;
}

/* ── 工作进程 ─────────────────────────────────────────────────────────── */
function workerRunning() {
  return !!(worker && worker.proc && !worker.proc.killed);
}
function startWorker() {
  if (workerRunning()) return true;
  const p = paths();
  const script = path.join(p.app, "serve.py");
  if (!fs.existsSync(script)) {
    logLine("serve.py 不存在：" + script);
    return false;
  }
  if (!fs.existsSync(p.python) && !fs.existsSync(p.pythonReal)) {
    logLine("venv 未就绪，不能拉起 worker");
    return false;
  }
  const py = quietPython(fs.existsSync(p.python) ? p.python : p.pythonReal);
  const provider = providerForWorker(readConfig());
  const proc = spawn(py, [script, "--model-dir", p.models, "--cpu-threads", "4", "--provider", provider], {
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: silentEnv(),
  });
  worker = { proc, buf: "", ready: false };
  /* 每只进程的收发都以自己这份引用为准：切设备 / 关开关会立刻把模块级 worker 置空，
     旧进程残留的 stdout 若还去写 worker.buf 就是 null 解引用（主进程直接抛 TypeError）。 */
  const w = worker;
  workerDevice = null; /* 新进程：等它自己上报设备 */
  logLine("worker started pid=" + proc.pid + " provider=" + provider);
  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", (chunk) => {
    if (worker !== w) return;
    w.buf += chunk;
    let i;
    while ((i = w.buf.indexOf("\n")) >= 0) {
      const line = w.buf.slice(0, i).trim();
      w.buf = w.buf.slice(i + 1);
      if (!line) continue;
      let msg = null;
      try {
        msg = JSON.parse(line);
      } catch {
        logLine("worker 非 JSON 行：" + line.slice(0, 300));
        continue;
      }
      onWorkerMessage(msg);
    }
  });
  proc.stderr.setEncoding("utf8");
  proc.stderr.on("data", (d) => logLine("worker: " + String(d).trim().slice(0, 2000)));
  proc.on("exit", (code) => {
    logLine("worker exit code=" + code);
    if (worker === w) {
      worker = null;
      workerDevice = null;
      synthCache.clear(); /* 这只进程手里的合成再也不会回 done：别留半截待落盘记录 */
    }
  });
  return true;
}
/* 预热：开关一打开（或启动时本来就是开着的）就先把 worker 拉起来。
   serve.py 在开读线程之前就把模型加载好、并合成一小段预热，所以第一次播报不用
   再等那 1~3 秒。纯后台动作：不阻塞 IPC 返回，失败只记日志（下次 speak 仍会拉起）。 */
function warmupWorker(reason) {
  if (!readConfig().enabled) return false;
  /* 没装好 / 权重被删了就别白拉一只 python（它只会加载失败再退出） */
  if (!state().installed) return false;
  if (workerRunning()) return true;
  const ok = startWorker();
  logLine(ok ? "预热 worker（" + (reason || "启动") + "）" : "预热失败：worker 拉不起来（" + (reason || "启动") + "）");
  return ok;
}
function onWorkerMessage(msg) { /* 设备决策：先落日志与 config（窗口没开也要留痕），再转给渲染层 */
  if (msg && msg.type === "device") {
    const dev = {
      provider: msg.provider === "cuda" ? "cuda" : "cpu",
      requested: String(msg.requested || ""),
      reason: String(msg.reason || ""),
      at: Date.now(),
    };
    workerDevice = dev;
    logLine(
      "worker device: provider=" + dev.provider + " requested=" + dev.requested + " reason=" + (dev.reason || "-")
    );
    writeConfig({ lastDevice: dev });
    const w = getMainWin && getMainWin();
    if (w && !w.isDestroyed()) w.webContents.send("mosstts:event", msg);
    return;
  }
  /* 合成回执先记账：窗口关着（或不在这只窗口上）也要把这次说完的话落盘缓存，
     下次同一段文字直接读盘播，见「固定文字语音缓存」。 */
  if (
    msg &&
    msg.id &&
    (msg.type === "chunk" || msg.type === "done" || msg.type === "error" || msg.type === "cancelled")
  ) {
    const id = String(msg.id);
    const rec = synthCache.get(id);
    if (rec) {
      if (msg.type === "chunk" && msg.data) {
        try {
          rec.parts.push(Buffer.from(String(msg.data), "base64"));
        } catch {}
      } else if (msg.type === "done") {
        synthCache.delete(id);
        /* 整段给完了才落盘：半截音频下次播出来就是话说一半 */
        try {
          const merged = wavMerge(rec.parts);
          if (merged) cacheStore(rec.key, merged);
        } catch (e) {
          logLine("语音缓存合并失败：" + ((e && e.message) || e));
        }
      } else {
        synthCache.delete(id);
      }
    }
  }
  const win = getMainWin && getMainWin();
  if (!win || win.isDestroyed()) return;
  if (msg.type === "ready") {
    if (worker) worker.ready = true;
    return;
  }
  if (msg.type === "chunk" || msg.type === "done" || msg.type === "error" || msg.type === "cancelled") {
    if (msg.type === "error") logLine("synth error: " + msg.code + " " + msg.message);
    win.webContents.send("mosstts:event", msg);
  }
}
function stopWorker() {
  /* 还没等到 done 的那几段再也不会说完：别让它们在 synthCache 里悬着 */
  synthCache.clear();
  const w = worker;
  if (!w || !w.proc || w.proc.killed) {
    worker = null;
    return;
  }
  /* 先把模块级引用摘掉：这只进程之后的 stdout / exit 事件一律按「旧进程」处理 */
  worker = null;
  workerDevice = null;
  try {
    w.proc.stdin.write(JSON.stringify({ cmd: "shutdown" }) + "\n");
  } catch {}
  const proc = w.proc;
  setTimeout(() => {
    try {
      if (!proc.killed) proc.kill();
    } catch {}
  }, 400);
}

/* ── 对外状态 ─────────────────────────────────────────────────────────── */
function state() {
  const cfg = readConfig();
  const p = paths();
  const voice = resolveVoice(cfg);
  /* onnxruntime 两种落盘形态都认：CPU 版是 onnxruntime，GPU 版是 onnxruntime_gpu-*.dist-info + 同名目录 */
  const ort = ortInstalled();
  const installed = !!(
    fs.existsSync(path.join(p.models, "MOSS-TTS-Nano-100M-ONNX", "browser_poc_manifest.json")) && ort.any
  );
  const decision = decisionOf(cfg);
  const device = deviceOf(cfg, decision);
  return {
    ok: true,
    enabled: cfg.enabled,
    installed,
    running: workerRunning(),
    progress,
    /* 设备：偏好 → 探测决策 → 实际设备（含回落原因） */
    provider: cfg.provider,
    decision,
    device,
    fallbackReason: device.fallback ? device.reason : "",
    voice,
    maxChars: cfg.maxChars,
    params: cfg.params,
    paramSpecs: PARAM_SPECS,
    paths: { root: p.root, models: p.models, log: p.log },
    breeze: breezePresets().map((x) => ({ id: x.id, name: x.name, groups: x.groups.map((g) => ({ id: g.id, name: g.name, kind: g.kind })) })),
    builtin: builtinVoice(),
  };
}

/* ── IPC ─────────────────────────────────────────────────────────────── */
function registerMossTtsIpc(opts) {
  if (registerMossTtsIpc._done) return { ok: true, already: true };
  registerMossTtsIpc._done = true;
  const o = opts || {};
  getDataDir = typeof o.getDataDir === "function" ? o.getDataDir : () => "";
  getMainWin = typeof o.getMainWin === "function" ? o.getMainWin : () => null;
  appRoot = o.appRoot || path.join(__dirname, "..");

  /* 启动即同步一次脚手架：热修（文本清洗 / 参考音频预处理）是改在随包那份上的，
     已启用的用户不点开关、不重装，也要在下次启动拿到新代码。 */
  try {
    if (readConfig().enabled) syncScaffold();
  } catch (e) {
    logLine("启动同步脚手架失败（继续用已装版本）：" + ((e && e.message) || e));
  }
  /* 上次退出时开关是开着的：启动就先把 worker 拉起来预热（等窗口起来再拉，
     别跟启动时的画布 / 素材扫描抢 CPU；模型加载本身在子进程里）。 */
  if (readConfig().enabled) {
    const t = setTimeout(() => {
      try {
        warmupWorker("启动");
      } catch (e) {
        logLine("启动预热失败（继续用惰性加载）：" + ((e && e.message) || e));
      }
    }, 2500);
    if (t && typeof t.unref === "function") t.unref();
  }

  ipcMain.handle("mosstts:getState", async () => state());

  /* 打开开关：先确保装好（首次会下载），装好才算真的开 */
  ipcMain.handle("mosstts:enable", async () => {
    if (!breezePresets().length) logLine("Breeze 未安装或没有角色：内置默认音色照常可用");
    const r = await ensureInstalled();
    if (!r.ok) return { ok: false, error: r.error, state: state() };
    writeConfig({ enabled: true });
    /* 装好就立刻预热：模型加载 + 一小段合成都在后台跑，第一次播报不必再等 */
    warmupWorker("启用");
    return { ok: true, state: state() };
  });
  ipcMain.handle("mosstts:disable", async () => {
    writeConfig({ enabled: false });
    stopWorker();
    return { ok: true, state: state() };
  });
  ipcMain.handle("mosstts:install", async () => {
    const r = await ensureInstalled();
    return { ok: r.ok, error: r.error || "", state: state() };
  });

  /* 合成：渲染层每次播报一个 reqId，宿主按句转发 chunk。
     先查固定文字缓存：命中就直接把那份 wav 当一条 chunk 回给渲染层（不进 worker）。 */
  ipcMain.handle("mosstts:speak", async (e, payload) => {
    const o2 = payload || {};
    const text = String(o2.text || "").trim();
    const id = String(o2.id || "tts_" + Date.now().toString(36));
    if (!text) return { ok: false, error: "empty" };
    const cfg = readConfig();
    if (!cfg.enabled) return { ok: false, error: "disabled" };
    const voice = resolveVoice(cfg);
    if (!voice.audioPath) return { ok: false, error: "voice_missing" };
    const maxChars = Number(o2.maxChars) || cfg.maxChars || 42;
    const key = cacheKey(text, voice, cfg.params, maxChars);
    const hit = cacheLookup(key);
    if (hit) {
      lastSpeakAt = Date.now();
      const win = getMainWin && getMainWin();
      if (win && !win.isDestroyed()) {
        /* 形状与 worker 的 chunk / done 一致：渲染层不必知道这段是合成的还是读盘的 */
        win.webContents.send("mosstts:event", {
          type: "chunk",
          id,
          index: 0,
          data: hit.data.toString("base64"),
          text,
          ms: 0,
          cached: true,
        });
        win.webContents.send("mosstts:event", { type: "done", id, chunks: 1, ms: 0, cached: true });
      }
      return { ok: true, id, voice: voice.name, cached: true };
    }
    if (!startWorker()) return { ok: false, error: "worker_unavailable" };
    const w = worker;
    if (!w || !w.proc) return { ok: false, error: "worker_unavailable" };
    lastSpeakAt = Date.now();
    /* 这次说完（worker 回 done）就把整段 wav 落进缓存，下次同一段话直接读盘 */
    synthCache.set(id, { key, parts: [] });
    try {
      w.proc.stdin.write(
        JSON.stringify({
          cmd: "speak",
          id,
          text,
          promptAudio: voice.audioPath,
          maxChars,
          params: cfg.params,
        }) + "\n"
      );
    } catch (err) {
      synthCache.delete(id);
      return { ok: false, error: (err && err.message) || "write_failed" };
    }
    return { ok: true, id, voice: voice.name };
  });
  ipcMain.handle("mosstts:cancel", async (e, reqId) => {
    if (!workerRunning()) return { ok: true };
    try {
      worker.proc.stdin.write(JSON.stringify({ cmd: "cancel", id: String(reqId || "") }) + "\n");
    } catch {}
    /* 立刻静音：worker 只会在下一句边界停下，已经吐出来的 wav 由渲染层丢弃 */
    return { ok: true };
  });
  /* 推理设备偏好：auto | cpu。改完停掉 worker，下次合成按新偏好重拼 --provider。
     这里**不探测**：探测只在启用 / 安装时做一次，不做轮询。 */
  ipcMain.handle("mosstts:setProvider", async (e, provider) => {
    const next = String(provider || "").trim().toLowerCase() === "cpu" ? "cpu" : "auto";
    writeConfig({ provider: next });
    logLine("推理设备偏好改为 " + next + "，停掉 worker 并按新偏好重新预热");
    stopWorker();
    warmupWorker("切设备");
    return { ok: true, state: state() };
  });
  /* 换音色：内置 / 自定义（上传音频）/ Breeze 指针 */
  ipcMain.handle("mosstts:setVoice", async (e, voice) => {
    const v = voice && typeof voice === "object" ? voice : { kind: "builtin" };
    const next =
      v.kind === "breeze"
        ? { kind: "breeze", presetId: String(v.presetId || ""), groupId: String(v.groupId || "") }
        : v.kind === "custom"
        ? { kind: "custom", audioPath: String(v.audioPath || ""), name: String(v.name || "") }
        : { kind: "builtin" };
    if (next.kind === "custom" && !fs.existsSync(next.audioPath)) return { ok: false, error: "audio_missing", state: state() };
    writeConfig({ voice: next });
    return { ok: true, state: state() };
  });
  /* 上传 prompt 音频：选文件 → 拷进数据目录 voices/（原文件不动） */
  ipcMain.handle("mosstts:pickAudio", async () => {
    const win = getMainWin && getMainWin();
    const picked = await dialog.showOpenDialog(win || undefined, {
      title: "选择参考音频（prompt 音频）",
      properties: ["openFile"],
      filters: [{ name: "音频", extensions: ["wav", "mp3", "m4a", "flac", "ogg", "aac"] }],
    });
    if (picked.canceled || !picked.filePaths || !picked.filePaths[0]) return { ok: false, canceled: true };
    const src = picked.filePaths[0];
    const ext = path.extname(src) || ".wav";
    const dest = path.join(ensureDir(paths().voices), "voice_" + Date.now().toString(36) + ext);
    try {
      fs.copyFileSync(src, dest);
    } catch (err) {
      return { ok: false, error: (err && err.message) || "copy_failed" };
    }
    return { ok: true, audioPath: dest, name: path.basename(src) };
  });
  ipcMain.handle("mosstts:listBreeze", async () => ({ ok: true, presets: breezePresets() }));
  /* 语音微调参数：只写 config，下一次 speak 起生效（不用重启 worker / 重载模型） */
  ipcMain.handle("mosstts:setParams", async (e, params) => {
    const next = normalizeParams(params);
    writeConfig({ params: next });
    logLine(
      "采样参数更新：" +
        Object.keys(next)
          .map((k) => k + "=" + next[k])
          .join(" ")
    );
    return { ok: true, state: state() };
  });
  ipcMain.handle("mosstts:openRoot", async () => {
    try {
      await shell.openPath(paths().root);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e && e.message) || "open_failed" };
    }
  });
  ipcMain.handle("mosstts:log", async (e, n) => ({ ok: true, text: consoleTail(n) }));
  ipcMain.handle("mosstts:clearOut", async () => {
    const dir = paths().out;
    try {
      for (const f of fs.readdirSync(dir)) {
        if (/\.wav$/i.test(f)) fs.unlinkSync(path.join(dir, f));
      }
    } catch {}
    return { ok: true };
  });

  /* 启动时把上一轮的临时 wav 清掉（out 只放本轮合成产物） */
  try {
    const dir = paths().out;
    if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir)) if (/\.wav$/i.test(f)) fs.unlinkSync(path.join(dir, f));
  } catch {}

  app.on("before-quit", () => {
    stopWorker();
  });
  return { ok: true };
}

function shutdownMossTts() {
  stopWorker();
}

module.exports = { registerMossTtsIpc, shutdownMossTts, state };
