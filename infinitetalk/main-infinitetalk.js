"use strict";
/**
 * InfiniteTalk 数字人（MeiGen-AI/InfiniteTalk on Wan2.1）插件宿主。
 *
 * 形态与 h3 / sensenova 一致：**主进程宿主 + 预加载桥 + 控制台 UI**，
 * 画布节点 `infinitetalk_gen` 经 `infinitetalk:generate` 走这里；后端是**独立安装**的一份
 * ComfyUI（`<安装目录>/ComfyUI`），图用 ComfyUI **原生** `WanInfiniteTalkToVideo` 节点。
 *
 * 关键口径（与用户共识一致）：
 * - 输入：I2V = 一张人物图 + 音频；V2V = 一段源视频 + 音频（端口 2 接上视频即走 V2V）；
 * - 时长：不设上限，按音频全长出片；每块 81 帧（≈3.24s），下一块以**上一段末帧 + 末 9 帧**
 *   为条件续写；每块完成即落盘 → 支持断点续跑；
 * - 分辨率：480p 默认 / 720p 可选；
 * - 优化默认全开：fp8 扩散模型 + lightx2v 4 步蒸馏 + SageAttention（强制）+ 显存水位/分层卸载；
 * - 成品：分块按序 concat，再把**原始音轨**封回 mp4；V2V 按源视频时间窗取帧，保留原镜头；
 * - 排队：与 H3 / 音乐 / 语音共用全局媒体互斥锁（media-gen-global-lock.js）。
 *
 * 数据只写 `%APPDATA%\pipeline-console\infinitetalk-local\`，绝不写应用目录。
 */

const { BrowserWindow, ipcMain, app, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const http = require("http");
const { spawn, execFile } = require("child_process");
const crypto = require("crypto");

const lock = require("../media-gen-global-lock.js");
const pluginErrors = require("../plugin-error-repair.js");
const installHost = require("../plugins/main-install.js");
const stepReporter = require("../plugins/install-step-reporter.js");
const installKill = require("../plugins/install-cancel.js");
const selfcheck = require("../plugins/plugin-selfcheck.js");
const mirrors = require("../cn-mirrors.js");
const bp = require("../backend-python.js");
const it = require("./infinitetalk-workflows.js");

const PLUGIN_ID = "infinitetalk-local";
const NODE_KIND = "infinitetalk_gen";
const INSTALL_SKILL = "infinitetalk-local-install";
const PACK_ID = "infinitetalk-local";
const DEFAULT_PORT = 8199;
const DISK_HINT_GB = 55;
const MIN_VRAM_GB = 0; /* 不设门槛（共识）：只在控制台展示显存，不拦安装 / 节点 */
const CHUNK_FRAMES = it.DEFAULT_LENGTH; /* 81 帧 ≈ 3.24s */
const CHUNK_SEC = CHUNK_FRAMES / it.DEFAULT_FPS;
const BACKEND_READY_TIMEOUT_MS = 180 * 1000;
const GENERATE_TIMEOUT_MS = 4 * 60 * 60 * 1000;
const CONSOLE_MAX_BYTES = 512 * 1024;

let getDataDir = () => "";
let getMainWin = () => null;
let appRoot = path.join(__dirname, "..");
let assetDirFor = null;

let consoleWin = null;
let installing = false;
let installCancel = false;
let starting = null;
let activeJob = null; /* { nodeId, aborted, promptIds:Set } */
let gpuTimer = null;
let reserveVramSupport = null; /* null = 未探测；true/false = ComfyUI 是否认识 --reserve-vram */

/* ───────────────────────── 路径 / 配置 ───────────────────────── */

function root() {
  const d = typeof getDataDir === "function" ? String(getDataDir() || "") : "";
  return d ? path.join(d, PLUGIN_ID) : path.join(os.tmpdir(), PLUGIN_ID);
}
function mk(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {}
  return dir;
}
function cfgPath() {
  return path.join(root(), "config.json");
}
function readJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
}
function writeJson(p, v) {
  mk(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify(v, null, 2), "utf8");
}
function loadConfig() {
  const c = readJson(cfgPath(), {}) || {};
  return {
    installDir: String(c.installDir || ""),
    port: Number(c.port) || DEFAULT_PORT,
    resolution: it.RESOLUTION_KEYS.includes(c.resolution) ? c.resolution : "480p",
    steps: Number(c.steps) || it.DEFAULT_STEPS,
    seed: Number(c.seed) || 42,
    vramMode: ["auto", "low"].includes(c.vramMode) ? c.vramMode : "auto",
  };
}
function saveConfig(patch) {
  const next = Object.assign(loadConfig(), patch || {});
  writeJson(cfgPath(), next);
  return next;
}
function isSafeInstallDir(dir) {
  const raw = String(dir || "").trim();
  if (!raw) return { ok: false, error: "empty_dir" };
  const p = path.resolve(raw);
  if (!path.isAbsolute(p)) return { ok: false, error: "bad_dir" };
  if (path.parse(p).root === p) return { ok: false, error: "refuse_root" };
  const sys = [process.env.SystemRoot, process.env.ProgramFiles, process.env["ProgramFiles(x86)"]]
    .filter(Boolean)
    .map((x) => path.resolve(x).toLowerCase());
  if (sys.some((s) => p.toLowerCase() === s || p.toLowerCase().startsWith(s + path.sep)))
    return { ok: false, error: "refuse_system" };
  return { ok: true, path: p };
}
function bundledPackRoot() {
  if (app.isPackaged) {
    const fromRes = path.join(process.resourcesPath, "infinitetalk-pack");
    if (fs.existsSync(fromRes)) return fromRes;
  }
  return path.join(appRoot || path.join(__dirname, ".."), "infinitetalk-pack");
}
function comfyRoot(dir) {
  return path.join(String(dir || ""), "ComfyUI");
}
function venvPython(dir) {
  return path.join(comfyRoot(dir), "venv", "Scripts", "python.exe");
}
function projectSignals(dir) {
  const r = String(dir || "").trim();
  if (!r) return { exists: false, scaffold: false, venv: false, installed: false, ready: false, weights: false };
  const scaffold = fs.existsSync(path.join(comfyRoot(r), "main.py"));
  const venv = fs.existsSync(venvPython(r));
  const models = path.join(comfyRoot(r), "models");
  const weights = [
    path.join(models, "diffusion_models", it.WEIGHTS.unet),
    path.join(models, "model_patches", it.WEIGHTS.patch),
    path.join(models, "text_encoders", it.WEIGHTS.clip),
    path.join(models, "vae", it.WEIGHTS.vae),
    path.join(models, "audio_encoders", it.WEIGHTS.audioEncoder),
    path.join(models, "loras", it.WEIGHTS.lora),
    path.join(models, "clip_vision", it.WEIGHTS.clipVision),
  ].every((p) => fs.existsSync(p));
  return {
    exists: fs.existsSync(r),
    scaffold,
    venv,
    weights,
    installed: fs.existsSync(path.join(r, ".install-ok")),
    ready: scaffold && venv && weights,
  };
}

/* ───────────────────────── 控制台日志 ───────────────────────── */

function consolePath() {
  return path.join(root(), "console.log");
}
function appendConsole(line) {
  const text = String(line == null ? "" : line).replace(/\x1b\[[0-9;]*m/g, "");
  try {
    mk(root());
    fs.appendFileSync(consolePath(), "[" + new Date().toISOString() + "] " + text + "\n");
    const st = fs.statSync(consolePath());
    if (st.size > CONSOLE_MAX_BYTES) {
      const fd = fs.readFileSync(consolePath(), "utf8").slice(-Math.floor(CONSOLE_MAX_BYTES * 0.7));
      fs.writeFileSync(consolePath(), fd);
    }
  } catch {}
  send("infinitetalk:consoleChanged", { at: Date.now() });
}
function consoleTail(maxBytes) {
  const cap = Number(maxBytes) || 64 * 1024;
  let host = "";
  try {
    host = fs.readFileSync(consolePath(), "utf8");
  } catch {}
  /* 后端（ComfyUI）的 stdout/stderr 落在 backend.log：控制台日志必须带上它，
     否则生成失败时用户只看到「已提交」却看不到真正的报错。 */
  let back = "";
  try {
    back = fs.readFileSync(path.join(root(), "backend.log"), "utf8");
  } catch {}
  const tail = back ? host.slice(-Math.floor(cap * 0.55)) + "\n===== ComfyUI 后端 =====\n" + back.slice(-Math.floor(cap * 0.45)) : host;
  return tail.slice(-cap);
}
function send(channel, payload) {
  const w = typeof getMainWin === "function" ? getMainWin() : null;
  try {
    if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
  } catch {}
  try {
    if (consoleWin && !consoleWin.isDestroyed()) consoleWin.webContents.send(channel, payload);
  } catch {}
}
function emitProgress(patch) {
  send("infinitetalk:progress", Object.assign({ at: Date.now() }, patch || {}));
}
function reportErr(code, message, extra) {
  try {
    pluginErrors.reportPluginError(PLUGIN_ID, {
      code: "infinitetalk." + String(code || "error"),
      message: String(message || "").slice(0, 800),
      detail: extra || {},
    });
  } catch {}
}

/* ───────────────────────── GPU ───────────────────────── */

function gpuSnapshot() {
  return new Promise((resolve) => {
    const args = [
      "--query-gpu=name,memory.total,memory.used,utilization.gpu",
      "--format=csv,noheader,nounits",
    ];
    execFile("nvidia-smi", args, { windowsHide: true, timeout: 8000 }, (err, stdout) => {
      if (err) return resolve({ ok: false, hasNvidia: false, gpus: [] });
      const gpus = String(stdout || "")
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => {
          const [name, memMb, usedMb, util] = l.split(",").map((x) => x.trim());
          return {
            name,
            memMb: Number(memMb) || 0,
            usedMb: Number(usedMb) || 0,
            util: Number(util) || 0,
          };
        });
      resolve({ ok: gpus.length > 0, hasNvidia: gpus.length > 0, gpus });
    });
  });
}
async function queryGpu() {
  const snap = await gpuSnapshot();
  const maxVramGb = snap.gpus.length ? Math.max(...snap.gpus.map((g) => g.memMb / 1024)) : 0;
  return Object.assign({ maxVramGb }, snap);
}
function startGpuPolling() {
  if (gpuTimer) return;
  const tick = async () => {
    const g = await gpuSnapshot();
    send("infinitetalk:gpu", g);
  };
  tick();
  gpuTimer = setInterval(tick, 5000);
  if (gpuTimer.unref) gpuTimer.unref();
}
function stopGpuPolling() {
  if (gpuTimer) clearInterval(gpuTimer);
  gpuTimer = null;
}

/* ───────────────────────── HTTP / 上传 ───────────────────────── */

function httpJson(port, method, urlPath, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(JSON.stringify(body), "utf8");
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: urlPath,
        method,
        headers: payload
          ? { "Content-Type": "application/json", "Content-Length": payload.length }
          : {},
        timeout: timeoutMs || 30000,
      },
      (res) => {
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, json: buf ? JSON.parse(buf) : null, text: buf });
          } catch {
            resolve({ status: res.statusCode, json: null, text: buf });
          }
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy(new Error("timeout"));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

/** 把任意文件（图 / 音频 / mp4）丢进 ComfyUI 的 input 目录，返回它给的文件名。 */
function uploadFile(port, filePath) {
  return new Promise((resolve, reject) => {
    const name = Date.now() + "-" + crypto.randomBytes(4).toString("hex") + path.extname(filePath);
    const data = fs.readFileSync(filePath);
    const boundary = "----InfiniteTalk" + crypto.randomBytes(8).toString("hex");
    const preamble = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="${name}"\r\n` +
        `Content-Type: application/octet-stream\r\n\r\n`,
    );
    const tail = Buffer.from(
      `\r\n--${boundary}\r\nContent-Disposition: form-data; name="overwrite"\r\n\r\ntrue` +
        `\r\n--${boundary}\r\nContent-Disposition: form-data; name="type"\r\n\r\ninput\r\n` +
        `--${boundary}--\r\n`,
    );
    const body = Buffer.concat([preamble, data, tail]);
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
        timeout: 180000,
      },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          try {
            const j = JSON.parse(buf);
            resolve(j.name || j.filename || name);
          } catch {
            reject(new Error("upload_parse: " + buf.slice(0, 200)));
          }
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("upload_timeout")));
    req.write(body);
    req.end();
  });
}

/* ───────────────────────── ffmpeg ───────────────────────── */

let ffmpegCache = "";
function ffmpegPath() {
  if (ffmpegCache) return ffmpegCache;
  const exe = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  const tryFile = (p) => p && fs.existsSync(p) && fs.statSync(p).isFile();
  const cfg = loadConfig();
  const candidates = [
    /* ComfyUI venv 里的 imageio-ffmpeg（装 ComfyUI 依赖时一并装下，最稳） */
    path.join(comfyRoot(cfg.installDir), "venv", "Lib", "site-packages", "imageio_ffmpeg", "binaries", exe),
    path.join(comfyRoot(cfg.installDir), "venv", "Scripts", exe),
    /* Remotion 自带的 ffmpeg（应用里另一处便携 ffmpeg） */
    path.join(appRoot, "remotion", "node_modules", "@remotion", "compositor-win32-x64-msvc", exe),
    path.join(appRoot, "remotion", "ffmpeg", exe),
  ];
  for (const c of candidates) if (tryFile(c)) return (ffmpegCache = c);
  return (ffmpegCache = "ffmpeg"); /* 交给 PATH */
}
function runFfmpeg(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath(), args, { windowsHide: true });
    let err = "";
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
      reject(new Error("ffmpeg_timeout"));
    }, timeoutMs || 30 * 60 * 1000);
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(err);
      else reject(new Error("ffmpeg_exit_" + code + ": " + err.slice(-400)));
    });
  });
}
/** 任意媒体文件（音频 / 视频）的时长秒数：ffmpeg -i 的 Duration 行最便宜。 */
async function mediaDurationSec(file) {
  try {
    const out = await runFfmpeg(["-hide_banner", "-i", file], 30000).catch((e) => String(e.message));
    const m = String(out).match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
    if (!m) return 0;
    return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  } catch {
    return 0;
  }
}
async function audioDurationSec(file) {
  return mediaDurationSec(file);
}
/** 该文件里到底有没有音轨（拿去转 wav 之前先判一眼，避免「输入端接错了」却报 ffmpeg 错）。 */
async function hasAudioStream(file) {
  const out = await runFfmpeg(["-hide_banner", "-i", file], 30000).catch((e) => String((e && e.message) || e));
  return /Stream #\d+:\d+.*: (Audio|audio):/.test(String(out));
}
async function toWav16k(src, dest) {
  await runFfmpeg(["-y", "-i", src, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", dest]);
  return dest;
}
/** 切一段音频并补静音到定长（末段不足一块时保证长度与画面一致）。 */
async function sliceAudio(srcWav, startSec, durSec, dest) {
  await runFfmpeg([
    "-y",
    "-ss",
    String(Math.max(0, startSec)),
    "-t",
    String(Math.max(0.2, durSec)),
    "-i",
    srcWav,
    "-af",
    "apad",
    "-t",
    String(Math.max(0.2, durSec)),
    "-ac",
    "1",
    "-ar",
    "16000",
    "-c:a",
    "pcm_s16le",
    dest,
  ]);
  return dest;
}
/** 从源视频切一个时间窗（缩放到目标分辨率、25fps、无音轨）当 V2V 的条件帧。 */
async function sliceVideoWindow(srcVideo, startSec, durSec, width, height, dest) {
  await runFfmpeg([
    "-y",
    "-stream_loop",
    "-1",
    "-ss",
    String(Math.max(0, startSec)),
    "-t",
    String(Math.max(0.2, durSec)),
    "-i",
    srcVideo,
    "-an",
    "-vf",
    `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},fps=${it.DEFAULT_FPS}`,
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    dest,
  ]);
  return dest;
}
/** 取一段 mp4 的最后一帧。
 *  注意：-sseof -N 只是「跳到末尾前 N 秒」，再取第一帧拿到的不是末帧（以前就是这么偏的），
 *  必须先算时长、精确 seek 到最后一帧，续写段的 start_image 才不会比上一块倒退几帧。 */
async function lastFrame(mp4, dest) {
  const dur = await mediaDurationSec(mp4);
  const start = Math.max(0, dur - 1 / it.DEFAULT_FPS - 0.001);
  await runFfmpeg(["-y", "-ss", String(start), "-i", mp4, "-frames:v", "1", "-update", "1", dest]);
  return dest;
}
/** 数一段 mp4 里**能解码出来**的视频帧数。
 *  不能加 `-c copy`：那只数容器里的包数，时间戳不规整的短片会出现「9 个包、只能解出 8 帧」，
 *  ComfyUI 的 LoadVideo 按解码帧数喂 previous_frames，于是又抛
 *  `Not enough previous frames provided.`（以前就是这么被糊过去的）。 */
async function countVideoFrames(mp4) {
  let out = "";
  try {
    out = await runFfmpeg(
      ["-hide_banner", "-i", mp4, "-map", "0:v:0", "-f", "null", "-"],
      120000,
    );
  } catch (e) {
    out = String((e && e.message) || e);
  }
  let best = 0;
  const re = /frame=\s*(\d+)/g;
  let m;
  while ((m = re.exec(String(out)))) best = Math.max(best, Number(m[1]) || 0);
  return best;
}

/** 取一段 mp4 的末 N 帧（当 previous_frames 的运动上下文），转成小 mp4 供 LoadVideo 读。
 *  不能用 `-sseof -1` + `-frames:v N`：那取到的是「末尾前 1 秒起」的头 N 帧，动作会回跳。
 *  也不能按「时长 - N/fps」seek 后再过 fps 滤镜凑帧数：时间戳差一档就少一帧，产出 8 帧。
 *  select 挑完帧还必须**强制 CFR 输出**（`-r 25`）：`-fps_mode passthrough` / 默认 VFR 下
 *  这段只有 0.32s 的片子容器里 9 个包却只能解出 8 帧（末帧时间戳落在容器时长之外，demux 丢掉），
 *  ComfyUI 的 LoadVideo 按**解码帧数**喂 previous_frames，于是原生 WanInfiniteTalkToVideo 抛
 *  `Not enough previous frames provided.`（要求 >= motion_frame_count 帧），整块生成失败。 */
async function tailFrames(mp4, count, width, height, dest) {
  const n = Math.max(1, Math.round(Number(count) || it.MOTION_FRAME_COUNT));
  const total = await countVideoFrames(mp4);
  let startFrame = total > 0 ? Math.max(0, total - n) : 0;
  let got = 0;
  for (let attempt = 0; attempt < 4; attempt++) {
    const args = [
      "-y",
      "-i",
      mp4,
      "-an",
      "-vf",
      `scale=${width}:${height},select=gte(n\\,${startFrame}),setpts=PTS-STARTPTS`,
      /* 恒定 25fps 输出：帧数才算得准、ComfyUI 也才解得全 */
      "-r",
      String(it.DEFAULT_FPS),
      "-frames:v",
      String(n),
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      dest,
    ];
    await runFfmpeg(args);
    got = await countVideoFrames(dest);
    if (got >= n || startFrame === 0) break;
    startFrame = Math.max(0, startFrame - (n - got));
  }
  appendConsole(`[gen] previous frames ${path.basename(dest)}: ${got}/${n} (total ${total}, from #${startFrame})`);
  /* 片上真不够 N 帧（异常短片）：宁可不给运动上下文，也别让 ComfyUI 整块报错 */
  return got >= n ? dest : "";
}

function newestMp4(rootDir, sinceMs) {
  let best = null;
  const walk = (dir, depth) => {
    if (depth > 3) return;
    let items = [];
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const it2 of items) {
      const p = path.join(dir, it2.name);
      if (it2.isDirectory()) walk(p, depth + 1);
      else if (/\.(mp4|webm|mov)$/i.test(it2.name)) {
        try {
          const st = fs.statSync(p);
          if (st.mtimeMs >= sinceMs - 2000 && (!best || st.mtimeMs > best.mtimeMs))
            best = { path: p, mtimeMs: st.mtimeMs };
        } catch {}
      }
    }
  };
  walk(rootDir, 0);
  return best ? best.path : "";
}

/* ───────────────────────── 安装 ───────────────────────── */

function installArgs(installDir, opts) {
  const args = ["-InstallDir", installDir, "-DiskHintGb", String(DISK_HINT_GB)];
  if (opts && opts.forceHardware) args.push("-Force");
  if (opts && opts.skipWeights) args.push("-SkipWeights");
  if (opts && opts.skipSmoke) args.push("-SkipSmoke");
  return args;
}

function runPs(scriptPath, args, label) {
  return new Promise((resolve, reject) => {
    appendConsole("$ powershell -File " + scriptPath + " " + (args || []).join(" "));
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, ...(args || [])],
      {
        windowsHide: true,
        cwd: path.dirname(scriptPath),
        env: Object.assign({}, process.env, mirrors.installEnv({ PYTHONIOENCODING: "utf-8" })),
      },
    );
    installKill.track(PLUGIN_ID, child);
    const rep = stepReporter.attach({
      pluginId: PLUGIN_ID,
      child,
      onEvent: (ev) => installHost.reportPluginStep(ev),
    });
    let out = "";
    const onData = (d) => {
      const s = d.toString();
      out += s;
      for (const line of s.split(/\r?\n/)) {
        if (!line.trim()) continue;
        appendConsole(line);
        const pm = line.match(/progress:\s*(\d+(?:\.\d+)?)/i);
        if (pm)
          emitProgress({
            phase: "install",
            step: "script",
            stepLabel: label || "安装",
            message: line.trim().slice(0, 160),
            pct: Math.max(0, Math.min(100, Number(pm[1]) || 0)),
          });
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", (e) => {
      installKill.untrack(PLUGIN_ID);
      rep.finish({ ok: false, error: String((e && e.message) || e) });
      reject(e);
    });
    child.on("close", (code) => {
      installKill.untrack(PLUGIN_ID);
      const cancelled = !!installCancel;
      rep.finish(
        cancelled
          ? { ok: false, cancelled: true, error: "cancelled" }
          : { ok: code === 0, error: code === 0 ? "" : "exit " + code },
      );
      if (cancelled) return reject(new Error("cancelled"));
      if (code !== 0) reject(new Error("exit " + code + ": " + out.slice(-1200)));
      else resolve(out);
    });
  });
}

async function installProject(opts) {
  if (installing) return { ok: false, error: "busy", message: "已有安装在进行中" };
  const dir = String(opts.installDir || loadConfig().installDir || "").trim();
  const safe = isSafeInstallDir(dir);
  if (!safe.ok) return { ok: false, error: safe.error || "bad_dir" };
  const installDir = safe.path;
  mk(installDir);

  const gpu = await queryGpu();
  if (!gpu.hasNvidia && !opts.forceHardware) {
    emitProgress({ phase: "install", step: "gpu", message: "未检测到 NVIDIA 显卡", error: true });
    return {
      ok: false,
      error: "no_cuda",
      message: "没检测到 NVIDIA 显卡：InfiniteTalk 只支持 CUDA 推理；确认不了就勾上「强制继续」再装。",
    };
  }
  const need = DISK_HINT_GB * 1024 * 1024 * 1024;
  try {
    const st = fs.statfsSync ? fs.statfsSync(installDir) : null;
    if (st && st.bavail * st.bsize < need)
      appendConsole(
        "[install] warning: free disk " + Math.round((st.bavail * st.bsize) / 1e9) + "GB < hint " + DISK_HINT_GB + "GB",
      );
  } catch {}

  saveConfig({ installDir });
  installCancel = false;
  installing = true;
  try {
    const script = path.join(bundledPackRoot(), "scripts", "install.ps1");
    if (!fs.existsSync(script)) throw new Error("安装脚本缺失：" + script);
    await runPs(script, installArgs(installDir, opts), "InfiniteTalk 数字人");
    const sig = projectSignals(installDir);
    if (!sig.ready) throw new Error("安装脚本结束但项目不完整（ComfyUI / venv / 权重缺项）");
    writeJson(path.join(installDir, ".install-ok"), { ok: true, at: Date.now() });
    installHost.finishPluginInstall({ id: PLUGIN_ID, ok: true });
    emitProgress({ phase: "install", step: "done", message: "安装完成", pct: 100 });
    return { ok: true, installDir, project: sig };
  } catch (e) {
    const msg = String((e && e.message) || e);
    installing = false;
    emitProgress({
      phase: "install",
      step: "error",
      message: msg.slice(0, 300),
      error: true,
    });
    reportErr(msg.split(":")[0].slice(0, 60), "安装失败：" + msg.slice(0, 500), { phase: "install", installDir });
    installHost.finishPluginInstall({
      id: PLUGIN_ID,
      ok: false,
      error: msg === "cancelled" ? "安装已取消" : msg.slice(0, 500),
      hint: msg === "cancelled" ? "" : stepReporter.hintFor(msg),
    });
    return { ok: false, error: msg, via: "script" };
  } finally {
    installing = false;
  }
}

/* ───────────────────────── 后端启停 ───────────────────────── */

function pidMetaPath() {
  return path.join(root(), "backend.json");
}
function backendRunning() {
  try {
    const meta = readJson(pidMetaPath(), null);
    if (!meta || !meta.pid) return false;
    process.kill(Number(meta.pid), 0);
    return true;
  } catch {
    return false;
  }
}
async function probeBackend(port) {
  try {
    const r = await httpJson(port || loadConfig().port, "GET", "/system_stats", null, 4000);
    return !!(r && r.status === 200 && r.json);
  } catch {
    return false;
  }
}

/** ComfyUI 是否认识某个命令行开关（不同版本差异很大，别把不认识的参数丢给它）。 */
function comfySupportsFlag(installDir, flag) {
  return new Promise((resolve) => {
    const py = venvPython(installDir);
    if (!fs.existsSync(py)) return resolve(false);
    execFile(
      py,
      ["main.py", "--help"],
      { windowsHide: true, timeout: 30000, cwd: comfyRoot(installDir) },
      (err, stdout, stderr) => {
        const text = String(stdout || "") + String(stderr || "");
        resolve(text.includes(flag));
      },
    );
  });
}

async function startBackend() {
  if (starting) return starting;
  starting = (async () => {
    const cfg = loadConfig();
    const safe = isSafeInstallDir(cfg.installDir);
    if (!safe.ok)
      return {
        ok: false,
        error: safe.error || "bad_dir",
        message: "还没设置安装目录：请在「插件 · InfiniteTalk 数字人」里先安装。",
      };
    const sig = projectSignals(safe.path);
    if (!sig.scaffold || !sig.venv)
      return { ok: false, error: "not_installed", message: "后端未装好：缺少 ComfyUI 或 venv，请重跑安装。" };
    const port = cfg.port;
    if (await probeBackend(port)) {
      appendConsole("[start] backend already up on " + port);
      return { ok: true, port, reused: true };
    }
    appendConsole("[start] launching ComfyUI on " + port);
    /* 静默口径（真源 backend-python.js，与 h3 / music3 / llama 一致）：
       · 解释器先体检（venv 重定向器的基座被删时 pythonw 会弹系统消息框，拦在起进程之前）；
       · python.exe → pythonw.exe（GUI 子系统，宿主不给它分配控制台 ⇒ 不会多出一只终端窗口）；
       · pack 的 shims/sitecustomize.py 同步进安装目录并挂 PYTHONPATH，ComfyUI 起的每条外部命令
         都默认带 CREATE_NO_WINDOW；
       · 后端 stdout/stderr 落 backend.log（pythonw 无控制台时必须有有效句柄）。 */
    const pyExe = venvPython(safe.path);
    const health = bp.pythonHealth(pyExe);
    if (!health.ok) {
      reportErr(health.code || "python_unusable", health.message || "后端 Python 环境不可用", { phase: "start" });
      return { ok: false, error: health.code || "python_unusable", message: health.message || "" };
    }
    bp.syncShims(bundledPackRoot(), safe.path);
    const py = bp.quietPython(pyExe);
    appendConsole("[start] interpreter " + py);
    /* 默认优化：SageAttention（安装时强制装好）+ 显存水位；720p 或显存紧张时走 --lowvram 分层卸载 */
    const args = ["main.py", "--port", String(port), "--listen", "127.0.0.1", "--disable-auto-launch", "--use-sage-attention"];
    if (reserveVramSupport === null) reserveVramSupport = await comfySupportsFlag(safe.path, "--reserve-vram");
    if (reserveVramSupport) args.push("--reserve-vram", cfg.resolution === "720p" ? "0.8" : "1.2");
    if (cfg.vramMode === "low" || cfg.resolution === "720p") args.push("--lowvram");
    appendConsole("[start] flags " + args.slice(1).join(" "));
    const outFd = fs.openSync(path.join(mk(root()), "backend.log"), "a");
    let child;
    try {
      child = spawn(py, args, {
        cwd: comfyRoot(safe.path),
        windowsHide: true,
        detached: true,
        stdio: ["ignore", outFd, outFd],
        env: bp.silentEnv(safe.path, Object.assign({}, process.env, { PYTHONIOENCODING: "utf-8" })),
      });
    } finally {
      fs.closeSync(outFd);
    }
    child.on("error", (e) => {
      appendConsole("[start] spawn failed: " + String((e && e.message) || e));
      reportErr("backend_start_failed", "启动 ComfyUI 失败：" + String((e && e.message) || e).slice(0, 500), {
        phase: "start",
      });
    });
    child.unref();
    writeJson(pidMetaPath(), { pid: child.pid, port, at: Date.now() });
    startGpuPolling();
    const t0 = Date.now();
    while (Date.now() - t0 < BACKEND_READY_TIMEOUT_MS) {
      if (await probeBackend(port)) {
        appendConsole("[start] backend ready after " + Math.round((Date.now() - t0) / 1000) + "s");
        emitProgress({ phase: "backend", step: "ready", message: "后端已就绪" });
        return { ok: true, port };
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    reportErr("backend_start_timeout", "等待 ComfyUI 就绪超时", { port });
    return { ok: false, error: "backend_start_timeout", message: "等待 ComfyUI 就绪超时（3 分钟）" };
  })();
  try {
    return await starting;
  } catch (e) {
    reportErr("backend_start_failed", "启动 ComfyUI 失败：" + String((e && e.message) || e).slice(0, 500), {
      phase: "start",
    });
    throw e;
  } finally {
    starting = null;
  }
}

async function stopBackend() {
  const meta = readJson(pidMetaPath(), null);
  if (meta && meta.pid) {
    try {
      spawn("cmd.exe", ["/d", "/s", "/c", `taskkill /PID ${Number(meta.pid)} /T /F`], { windowsHide: true });
    } catch {}
  }
  try {
    fs.unlinkSync(pidMetaPath());
  } catch {}
  stopGpuPolling();
  appendConsole("[stop] backend stop requested");
  return { ok: true };
}

async function ensureReady() {
  const port = loadConfig().port;
  if (await probeBackend(port)) return { ok: true, port, reused: true };
  return startBackend();
}

/* ───────────────────────── 生成 ───────────────────────── */

function jobsDir() {
  return path.join(root(), "jobs");
}
function jobPath(nodeId) {
  return path.join(jobsDir(), String(nodeId || "node") + ".json");
}
function loadJob(nodeId) {
  return readJson(jobPath(nodeId), null);
}
function saveJob(nodeId, data) {
  writeJson(jobPath(nodeId), data);
}

function outputRootFor(params) {
  const wf = String((params && params.canvasWorkflowId) || "").trim();
  if (typeof assetDirFor === "function" && wf) {
    try {
      const d = assetDirFor(wf);
      if (d) return d;
    } catch {}
  }
  const explicit = String((params && params.outputDir) || "").trim();
  if (explicit) return explicit;
  return path.join(root(), "output");
}

function uniquePath(dir, base, ext) {
  mk(dir);
  let name = base + (ext || "");
  let p = path.join(dir, name);
  let i = 1;
  while (fs.existsSync(p)) {
    name = base + "_" + i + (ext || "");
    p = path.join(dir, name);
    i += 1;
  }
  return p;
}

/** 成片落点：
 *  · 调用方给了 outputPath（节点 ⚙ 里配的输出路径）→ 就写那里，撞名自动加序号 ——
 *    以前这个参数被整份忽略，产物只落托管目录，用户配了路径也「完成后没有文件」。
 *  · 没给（输出接保存节点 / 托管口径）→ 托管目录 + 时间戳命名。 */
function finalTargetPath(params, fallbackDir) {
  const explicit = String((params && params.outputPath) || "").trim();
  if (explicit) {
    const ext = path.extname(explicit) || ".mp4";
    const base = path.basename(explicit, ext) || "infinitetalk";
    return uniquePath(path.dirname(explicit), base, ext);
  }
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  return uniquePath(fallbackDir, "infinitetalk-" + stamp, ".mp4");
}

async function waitPrompt(port, promptId, signal) {
  const t0 = Date.now();
  while (Date.now() - t0 < GENERATE_TIMEOUT_MS) {
    if (signal && signal.aborted) throw new Error("cancelled");
    let r = null;
    try {
      r = await httpJson(port, "GET", "/history/" + encodeURIComponent(promptId), null, 15000);
    } catch {}
    if (r && r.json && r.json[promptId]) {
      const entry = r.json[promptId];
      const st = entry.status || {};
      if (st.status_str === "error") throw new Error("comfy_error: " + JSON.stringify(st.messages || {}).slice(0, 600));
      if (st.completed || st.status_str === "success") return entry;
    }
    await new Promise((res) => setTimeout(res, 2000));
  }
  throw new Error("generate_timeout");
}

/**
 * 生成一段（81 帧）。
 * @returns {Promise<string>} 该段 mp4 落盘路径
 */
async function generateChunk(port, o) {
  const signal = o.signal;
  const uploads = {};
  if (o.mode === "v2v") uploads.videoName = await uploadFile(port, o.videoPath);
  else uploads.imageName = await uploadFile(port, o.imagePath);
  uploads.audioName = await uploadFile(port, o.audioPath);
  if (o.prevFramesPath) uploads.prevFramesName = await uploadFile(port, o.prevFramesPath);

  const built = it.buildPrompt({
    mode: o.mode,
    width: o.width,
    height: o.height,
    length: CHUNK_FRAMES,
    steps: o.steps,
    seed: o.seed,
    prompt: o.prompt,
    negative: o.negative,
    prefix: o.prefix,
    imageName: uploads.imageName,
    videoName: uploads.videoName,
    prevFramesName: uploads.prevFramesName,
    audioName: uploads.audioName,
  });
  const posted = await httpJson(port, "POST", "/prompt", { prompt: built.prompt, client_id: "mtnode-infinitetalk" }, 60000);
  if (!posted || posted.status !== 200 || !posted.json || !posted.json.prompt_id) {
    const detail = posted && (posted.text || "").slice(0, 600);
    throw new Error("comfy_reject: " + detail);
  }
  const promptId = posted.json.prompt_id;
  if (activeJob && activeJob.promptIds) activeJob.promptIds.add(promptId);
  emitProgress({ phase: "generate", step: "submitted", promptId, message: "已提交 ComfyUI 任务" });
  const startedAt = Date.now();
  await waitPrompt(port, promptId, signal);
  /* 找产物：SaveVideo 按 prefix 写进 ComfyUI 的 output 目录 */
  const outDir = path.join(comfyRoot(loadConfig().installDir), "output", path.dirname(o.prefix));
  let hit = newestMp4(outDir, startedAt);
  for (let i = 0; i < 20 && !hit; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    hit = newestMp4(outDir, startedAt);
  }
  if (!hit) throw new Error("output_missing: ComfyUI 没有产出 mp4（检查 SaveVideo 节点是否接上）");
  mk(o.destDir);
  const dest = path.join(o.destDir, o.name);
  fs.copyFileSync(hit, dest);
  appendConsole("[gen] prompt " + promptId + " → " + dest);
  return dest;
}

async function concatMp4(list, dest) {
  const dir = path.dirname(dest);
  mk(dir);
  const listFile = path.join(dir, "concat-" + Date.now() + ".txt");
  fs.writeFileSync(listFile, list.map((p) => "file '" + p.replace(/'/g, "'\\''") + "'").join("\n"), "utf8");
  try {
    await runFfmpeg(["-y", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", dest]);
  } finally {
    try {
      fs.unlinkSync(listFile);
    } catch {}
  }
  return dest;
}

/** 把原音轨封回成片，并按音频真实时长截断（末段画面可能多出不到一块）。 */
async function muxAudio(video, audio, durSec, dest) {
  await runFfmpeg([
    "-y",
    "-i",
    video,
    "-i",
    audio,
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-t",
    String(Math.max(0.2, durSec)),
    "-movflags",
    "+faststart",
    dest,
  ]);
  return dest;
}

async function generate(params) {
  const p = params || {};
  const nodeId = String(p.nodeId || "").trim() || "node";
  if (activeJob) return { ok: false, error: "busy", message: "已有 InfiniteTalk 任务在跑（全局同一时刻只允许一个媒体任务）" };
  const imagePath = String(p.imagePath || "").trim();
  const videoPath = String(p.videoPath || "").trim();
  const audioPath = String(p.audioPath || "").trim();
  const mode = String(p.mode || "auto") === "v2v" || (!imagePath && videoPath) ? "v2v" : "i2v";
  const srcPath = mode === "v2v" ? videoPath : imagePath;
  if (!srcPath || !fs.existsSync(srcPath))
    return {
      ok: false,
      error: mode === "v2v" ? "video_missing" : "image_missing",
      message: (mode === "v2v" ? "源视频不存在：" : "参考图不存在：") + srcPath,
    };
  if (!audioPath || !fs.existsSync(audioPath))
    return { ok: false, error: "audio_missing", message: "音频不存在：" + audioPath };

  const cfg = loadConfig();
  const ready = await ensureReady();
  if (!ready.ok) {
    reportErr(ready.error || "backend_not_ready", "后端未就绪：" + String(ready.message || "").slice(0, 500), {
      phase: "generate",
      nodeId,
    });
    return { ok: false, error: ready.error || "backend", message: ready.message || "后端未就绪" };
  }
  /* SageAttention 是安装时的强制项：这里再确认一次，缺了直接说清楚，别跑到一半退化成 SDPA */
  const sage = await new Promise((resolve) => {
    execFile(venvPython(cfg.installDir), ["-c", "import sageattention;print('SAGE')"], { windowsHide: true, timeout: 30000 }, (err, out) =>
      resolve(!err && String(out).includes("SAGE")),
    );
  });
  if (!sage)
    return {
      ok: false,
      error: "sage_missing",
      message: "SageAttention 不在当前后端环境里（默认优化项）：请在插件控制台重跑安装，装好后再生成。",
    };

  const acq = lock.tryAcquireLock({ nodeId, workflowId: String(p.canvasWorkflowId || ""), kind: NODE_KIND, host: "infinitetalk" });
  if (!acq.ok) return { ok: false, error: "busy", message: lock.busyMessage(acq.lock) };

  activeJob = { nodeId, aborted: false, promptIds: new Set() };
  const signal = { get aborted() { return !activeJob || activeJob.aborted; } };
  const jobId = nodeId + "-" + Date.now();
  const jobDir = mk(path.join(jobsDir(), jobId));
  const workAudio = path.join(jobDir, "audio16k.wav");
  const outDir = outputRootFor(p);
  const resKey = it.RESOLUTION_KEYS.includes(p.resolution) ? p.resolution : cfg.resolution;
  const res = it.RESOLUTIONS[resKey];
  /* 上一份任务（断点续跑要比对时间轴口径：旧版本分块起点早 9 帧，混着拼会跳帧） */
  const prevRun = loadJob(nodeId) || null;
  const prevPlan = (prevRun && prevRun.plan) || null;
  const run = { nodeId, mode, resolution: resKey, startedAt: Date.now(), chunks: [], status: "running" };
  saveJob(nodeId, run);

  try {
    emitProgress({ nodeId, phase: "prep", message: "转换音频", pct: 2 });
    if (!(await hasAudioStream(audioPath)))
      throw new Error(
        "audio_no_stream: 音频输入里没有音轨（" +
          path.basename(audioPath) +
          "）—— 确认端口 1 接的是音频 / 视频文件，图片不算",
      );
    await toWav16k(audioPath, workAudio);
    const dur = await audioDurationSec(workAudio);
    if (!dur || dur < 0.4) throw new Error("audio_too_short");
    /* 续写步进按模式分开：I2V 每块开头 MOTION_FRAME_COUNT 帧是上一段的运动上下文
       （模型重新生成，宿主用 trim_image 裁掉），所以第 i 块（i>0）的音频 / 条件帧从
       i*stepFrames 帧开始 —— 与上一块裁剩的结尾严格接上。以前多减了一次
       MOTION_FRAME_COUNT，每块的音画都比画面早 9 帧，接缝处口型错位、动作回跳。
       V2V 没有运动上下文（start_image 直接是源视频窗口的帧序列），每块推进整块
       CHUNK_FRAMES 帧：块与块首尾相接，不重叠也不裁。 */
    const stepFrames = mode === "v2v" ? CHUNK_FRAMES : CHUNK_FRAMES - it.MOTION_FRAME_COUNT;
    const totalFrames = Math.max(CHUNK_FRAMES, Math.ceil(dur * it.DEFAULT_FPS));
    const count = 1 + Math.max(0, Math.ceil((totalFrames - CHUNK_FRAMES) / stepFrames));
    run.plan = {
      /* 分块时间轴版本：v2 = I2V 块起点 = i*72（裁掉 9 帧运动上下文），V2V 块起点 = i*81。
         v1（旧）I2V 块起点早 9 帧，两套不能混拼。 */
      layout: 2,
      durationSec: dur,
      chunkSec: CHUNK_SEC,
      frames: CHUNK_FRAMES,
      stepFrames,
      count,
    };
    saveJob(nodeId, run);

    const asked = Array.isArray(p.reuseChunks) ? p.reuseChunks : [];
    /* 时间轴口径不一致 / 模式变了 → 旧块不能复用（混拼就是接缝跳帧），整份重跑 */
    const reuse =
      prevPlan &&
      (Number(prevPlan.layout) !== 2 ||
        Number(prevPlan.stepFrames) !== stepFrames ||
        String((prevRun && prevRun.mode) || mode) !== mode)
        ? []
        : asked;
    for (let i = 0; i < count; i++) {
      if (signal.aborted) throw new Error("cancelled");
      /* 第 i 块从 i*stepFrames 帧开始取音频：I2V 的前 9 帧是新块的运动上下文，
         音画在这 9 帧上重叠，trim_image 裁掉后刚好接上上一块；V2V 无重叠。 */
      const startFrame = i * stepFrames;
      const start = startFrame / it.DEFAULT_FPS;
      const chunkName = `chunk_${String(i).padStart(3, "0")}.mp4`;
      const destChunk = path.join(jobDir, chunkName);
      const prev = reuse[i];
      if (prev && fs.existsSync(prev)) {
        fs.copyFileSync(prev, destChunk);
        run.chunks.push(destChunk);
        saveJob(nodeId, run);
        emitProgress({
          nodeId,
          phase: "generate",
          chunk: i + 1,
          chunks: count,
          pct: Math.round(5 + ((i + 1) / count) * 88),
          message: `复用第 ${i + 1}/${count} 段（断点续跑）`,
        });
        continue;
      }
      const chunkWav = path.join(jobDir, `a${i}.wav`);
      await sliceAudio(workAudio, start, CHUNK_SEC, chunkWav);
      const chunkInput = { mode, audioPath: chunkWav, signal, destDir: jobDir, name: chunkName };
      if (mode === "v2v") {
        chunkInput.videoPath = await sliceVideoWindow(
          srcPath,
          start,
          CHUNK_SEC,
          res.width,
          res.height,
          path.join(jobDir, `src_${i}.mp4`),
        );
      } else if (i === 0) {
        chunkInput.imagePath = srcPath;
      } else {
        const prevChunk = run.chunks[i - 1];
        chunkInput.imagePath = await lastFrame(prevChunk, path.join(jobDir, `last_${i}.png`));
        chunkInput.prevFramesPath = await tailFrames(
          prevChunk,
          it.MOTION_FRAME_COUNT,
          res.width,
          res.height,
          path.join(jobDir, `prev_${i}.mp4`),
        );
      }
      emitProgress({
        nodeId,
        phase: "generate",
        chunk: i + 1,
        chunks: count,
        pct: Math.round(5 + (i / count) * 88),
        message: `生成第 ${i + 1}/${count} 段（${resKey}）`,
      });
      const mp4 = await generateChunk(ready.port, Object.assign(chunkInput, {
        width: res.width,
        height: res.height,
        steps: Number(p.steps) || cfg.steps,
        seed: (Number(p.seed) || cfg.seed) + i,
        prompt: p.prompt,
        negative: p.negative,
        prefix: `infinitetalk/${jobId}/${String(i).padStart(3, "0")}`,
      }));
      run.chunks.push(mp4);
      saveJob(nodeId, run);
    }

    emitProgress({ nodeId, phase: "post", message: "合成成片", pct: 95 });
    const finalPath = finalTargetPath(p, outDir);
    const joined = path.join(jobDir, "joined.mp4");
    if (run.chunks.length === 1) fs.copyFileSync(run.chunks[0], joined);
    else await concatMp4(run.chunks, joined);
    await muxAudio(joined, workAudio, dur, finalPath);
    run.status = "ok";
    run.outputPath = finalPath;
    saveJob(nodeId, run);
    emitProgress({ nodeId, phase: "done", message: "生成完成", pct: 100, path: finalPath });
    return {
      ok: true,
      path: finalPath,
      mode,
      resolution: resKey,
      durationSec: Math.round(dur * 10) / 10,
      chunks: run.chunks.length,
      chunkPaths: run.chunks,
      jobId,
    };
  } catch (e) {
    const msg = String((e && e.message) || e);
    run.status = msg === "cancelled" ? "cancelled" : "failed";
    run.error = msg;
    saveJob(nodeId, run);
    if (msg !== "cancelled")
      reportErr("generate_failed", "生成失败：" + msg.slice(0, 500), { nodeId, error: msg });
    emitProgress({ nodeId, phase: "error", message: msg.slice(0, 300), error: true });
    return {
      ok: false,
      error: msg,
      message: msg,
      partial: run.chunks,
      resume: msg !== "cancelled",
    };
  } finally {
    lock.releaseLock(nodeId);
    activeJob = null;
  }
}

/**
 * 断点续跑：沿用同一 nodeId 上一次的分块产物，只补没跑完的段。
 */
async function resume(params) {
  const nodeId = String((params && params.nodeId) || "").trim();
  if (!nodeId) return { ok: false, error: "bad_node" };
  const run = loadJob(nodeId);
  if (!run || run.status === "ok") return { ok: false, error: "nothing_to_resume" };
  const done = (run.chunks || []).filter((p) => fs.existsSync(p));
  if (!done.length) return { ok: false, error: "no_partial" };
  return generate(Object.assign({}, params, { reuseChunks: done }));
}

function cancelGenerate(nodeId) {
  if (!activeJob) return { ok: true, idle: true };
  if (nodeId && String(activeJob.nodeId) !== String(nodeId)) {
    return { ok: false, error: "busy_other", message: "当前在跑的是另一个节点：" + activeJob.nodeId };
  }
  activeJob.aborted = true;
  for (const id of activeJob.promptIds) {
    httpJson(loadConfig().port, "POST", "/interrupt", { prompt_id: id }, 8000).catch(() => {});
  }
  appendConsole("[gen] cancel requested");
  return { ok: true };
}

/* ───────────────────────── 状态 / 控制台窗 ───────────────────────── */

function packVersion() {
  try {
    return String(readJson(path.join(bundledPackRoot(), "manifest.json"), {}).version || "");
  } catch {
    return "";
  }
}

async function statusForUi() {
  const cfg = loadConfig();
  const sig = projectSignals(cfg.installDir);
  const running = await probeBackend(cfg.port);
  const gpu = await queryGpu();
  return {
    ok: true,
    id: PLUGIN_ID,
    nodeKind: NODE_KIND,
    version: packVersion(),
    diskHintGb: DISK_HINT_GB,
    minVramGb: MIN_VRAM_GB,
    installDir: cfg.installDir,
    port: cfg.port,
    resolution: cfg.resolution,
    steps: cfg.steps,
    vramMode: cfg.vramMode,
    installed: sig.installed || sig.ready,
    ready: sig.ready,
    running,
    phase: !sig.ready ? "not_installed" : running ? "ready" : "idle",
    installing,
    busy: !!activeJob,
    gpu,
    lock: lock.refreshStaleLock(),
  };
}

function openConsoleWindow() {
  if (consoleWin && !consoleWin.isDestroyed()) {
    consoleWin.show();
    consoleWin.focus();
    return { ok: true, reused: true };
  }
  consoleWin = new BrowserWindow({
    width: 1080,
    height: 760,
    title: "InfiniteTalk 数字人",
    backgroundColor: "#0f1115",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload-infinitetalk.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  consoleWin.loadFile(path.join(__dirname, "ui", "index.html"));
  consoleWin.on("closed", () => {
    consoleWin = null;
    stopGpuPolling();
  });
  startGpuPolling();
  return { ok: true };
}
function closeConsoleWindow() {
  try {
    if (consoleWin && !consoleWin.isDestroyed()) consoleWin.close();
  } catch {}
  consoleWin = null;
  return { ok: true };
}

async function pickInstallDir() {
  const { dialog } = require("electron");
  const win = (typeof getMainWin === "function" && getMainWin()) || consoleWin || null;
  const r = await dialog.showOpenDialog(win || undefined, {
    title: "选择 InfiniteTalk 数字人安装目录",
    properties: ["openDirectory", "createDirectory"],
  });
  if (r.canceled || !r.filePaths || !r.filePaths[0]) return { ok: false, canceled: true };
  const safe = isSafeInstallDir(r.filePaths[0]);
  if (!safe.ok) return { ok: false, error: safe.error };
  saveConfig({ installDir: safe.path });
  return { ok: true, dir: safe.path };
}

/* ───────────────────────── 自检 ───────────────────────── */

async function selfcheckInfinitetalk(ctx) {
  const C = ctx || {};
  const steps = [];
  const step = (title, status, detail) => {
    const s = { title, status, detail: detail || "" };
    steps.push(s);
    try {
      C.step && C.step(s);
    } catch {}
  };
  const cfg = loadConfig();
  const sig = projectSignals(cfg.installDir);
  step("安装目录与 ComfyUI", sig.scaffold ? "ok" : "fail", sig.scaffold ? cfg.installDir : "缺少 ComfyUI/main.py");
  step("隔离 Python 环境", sig.venv ? "ok" : "fail", sig.venv ? venvPython(cfg.installDir) : "缺少 venv");
  step("fp8 权重与 patch", sig.weights ? "ok" : "fail", sig.weights ? "7 份齐全" : "权重缺项");
  const ready = await startBackend();
  step("后端可启动", ready.ok ? "ok" : "fail", ready.ok ? "端口 " + cfg.port : ready.message || ready.error);
  if (ready.ok) {
    try {
      const info = await httpJson(cfg.port, "GET", "/object_info/WanInfiniteTalkToVideo", null, 10000);
      const has = !!(info && info.status === 200 && info.json && info.json.WanInfiniteTalkToVideo);
      step("原生 InfiniteTalk 节点已注册", has ? "ok" : "fail", has ? "WanInfiniteTalkToVideo" : "object_info 里没有该节点");
    } catch (e) {
      step("原生 InfiniteTalk 节点已注册", "fail", String((e && e.message) || e));
    }
  }
  const ok = steps.every((s) => s.status === "ok");
  return { ok, steps, note: ok ? "后端与节点就绪（未跑真实出片，模型权重加载耗时较长）" : "存在未通过项" };
}

/* ───────────────────────── IPC 注册 ───────────────────────── */

function registerInfinitetalkIpc(opts) {
  opts = opts || {};
  getDataDir = opts.getDataDir || getDataDir;
  getMainWin = opts.getMainWin || getMainWin;
  appRoot = opts.appRoot || path.join(__dirname, "..");
  assetDirFor = typeof opts.assetDirFor === "function" ? opts.assetDirFor : null;
  mk(root());
  appendConsole("[boot] infinitetalk module registered (data=" + root() + " port=" + loadConfig().port + ")");

  pluginErrors.registerPluginHost({
    id: PLUGIN_ID,
    name: "InfiniteTalk 数字人",
    skillName: INSTALL_SKILL,
    getInstallDir: () => loadConfig().installDir || "",
    tailConsole: (n) => consoleTail(n),
    restart: async () => {
      await stopBackend();
      return startBackend();
    },
  });

  installHost.registerInstallTarget({
    id: PLUGIN_ID,
    key: "infinitetalk",
    name: "InfiniteTalk 数字人",
    skill: INSTALL_SKILL,
    kindLabel: "本地后端",
    packRoots: [bundledPackRoot()],
    getInstallDir: () => loadConfig().installDir || "",
    cancel: async () => {
      installCancel = true;
      installKill.cancelInstall(PLUGIN_ID);
      return { ok: true };
    },
  });

  selfcheck.registerPluginSelfcheck({
    id: PLUGIN_ID,
    key: "infinitetalk",
    label: "InfiniteTalk 数字人",
    kind: "video",
    check: (ctx) => selfcheckInfinitetalk(ctx),
  });

  lock.registerHostProbe("infinitetalk", {
    isBusy: () => (activeJob && activeJob.nodeId) || "",
    isAlive: () => backendRunning(),
  });

  ipcMain.handle("infinitetalk:getStatus", async () => statusForUi());
  ipcMain.handle("infinitetalk:pickInstallDir", async () => pickInstallDir());
  ipcMain.handle("infinitetalk:setInstallDir", async (e, dir) => {
    const safe = isSafeInstallDir(dir);
    if (!safe.ok) return { ok: false, error: safe.error };
    saveConfig({ installDir: safe.path });
    return { ok: true, dir: safe.path };
  });
  ipcMain.handle("infinitetalk:setConfig", async (e, patch) => {
    const p = patch || {};
    const next = {};
    if (it.RESOLUTION_KEYS.includes(p.resolution)) next.resolution = p.resolution;
    if (p.steps != null) next.steps = Math.max(1, Math.min(40, Number(p.steps) || it.DEFAULT_STEPS));
    if (p.seed != null) next.seed = Number(p.seed) || 42;
    if (["auto", "low"].includes(p.vramMode)) next.vramMode = p.vramMode;
    if (p.port != null) next.port = Math.max(1024, Math.min(65535, Number(p.port) || DEFAULT_PORT));
    saveConfig(next);
    return { ok: true, config: loadConfig() };
  });
  ipcMain.handle("infinitetalk:install", async (e, o) => {
    const opt = o || {};
    installHost.beginPluginInstall({
      id: PLUGIN_ID,
      action: opt.action === "update" ? "update" : "install",
      installDir: loadConfig().installDir || "",
    });
    return installProject(opt);
  });
  ipcMain.handle("infinitetalk:cancelInstall", async () => {
    installCancel = true;
    installKill.cancelInstall(PLUGIN_ID);
    return { ok: true };
  });
  ipcMain.handle("infinitetalk:start", async () => startBackend());
  ipcMain.handle("infinitetalk:stop", async () => stopBackend());
  ipcMain.handle("infinitetalk:ensureReady", async () => ensureReady());
  ipcMain.handle("infinitetalk:generate", async (e, p) => generate(p || {}));
  ipcMain.handle("infinitetalk:resume", async (e, p) => resume(p || {}));
  ipcMain.handle("infinitetalk:cancelGenerate", async (e, nodeId) => cancelGenerate(nodeId));
  ipcMain.handle("infinitetalk:getLock", async () => lock.refreshStaleLock());
  ipcMain.handle("infinitetalk:gpuProbe", async () => queryGpu());
  ipcMain.handle("infinitetalk:health", async () => ({ ok: await probeBackend(loadConfig().port), port: loadConfig().port }));
  ipcMain.handle("infinitetalk:consoleTail", async (e, n) => ({ ok: true, text: consoleTail(n) }));
  ipcMain.handle("infinitetalk:consoleClear", async () => {
    try {
      fs.writeFileSync(consolePath(), "");
    } catch {}
    send("infinitetalk:consoleChanged", { at: Date.now() });
    return { ok: true };
  });
  ipcMain.handle("infinitetalk:open", async () => openConsoleWindow());
  ipcMain.handle("infinitetalk:close", async () => closeConsoleWindow());
  ipcMain.handle("infinitetalk:openPath", async (e, p) => {
    const t = String(p || "").trim();
    if (!t) return { ok: false };
    try {
      if (fs.existsSync(t) && fs.statSync(t).isDirectory()) await shell.openPath(t);
      else await shell.showItemInFolder(t);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });
  ipcMain.handle("infinitetalk:removePluginMeta", async () => {
    try {
      fs.rmSync(root(), { recursive: true, force: true });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });
}

/* ───────────────────────── 显存释放钩子 ───────────────────────── */

function vramHooks() {
  return {
    isRunning: () => backendRunning(),
    isBusy: () => !!activeJob,
    soft: async () => {
      try {
        await httpJson(loadConfig().port, "POST", "/free", { unload_models: true, free_memory: true }, 15000);
      } catch {}
      return { ok: true };
    },
    hard: async () => stopBackend(),
  };
}

function shutdownInfinitetalkUiOnly() {
  closeConsoleWindow();
  stopGpuPolling();
}

module.exports = {
  registerInfinitetalkIpc,
  statusForUi,
  generate,
  resume,
  cancelGenerate,
  startBackend,
  stopBackend,
  ensureReady,
  selfcheckInfinitetalk,
  vramHooks,
  shutdownInfinitetalkUiOnly,
  PLUGIN_ID,
  NODE_KIND,
  INSTALL_SKILL,
  PACK_ID,
  DEFAULT_PORT,
  DISK_HINT_GB,
  MIN_VRAM_GB,
  CHUNK_FRAMES,
  CHUNK_SEC,
};
