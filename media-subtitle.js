"use strict";
/* ============================================================================
 * 音频 / 视频 → 字幕（带每条字幕的起止时间）· 主进程内核（media-subtitle.js）
 * ----------------------------------------------------------------------------
 * 为什么需要它（用户现场）：Agent 会话里已经有 audio_subtitle 工具，但**画布上**没有
 * 能出时间轴的节点 —— 用户想「把一段音频丢进画布、直接拿到每条字幕的起止秒」做不到。
 * 本轮把它做成**内置工具**（工具库里的「音频转字幕」）：函数节点 jscode 里
 *   const r = await mtnode.subtitle({ file, language, maxDurationSec, maxChars })
 * 走 fn-runtime 的 host bridge 到本文件（worker 线程没有 Electron / 也没有语音运行时）。
 *
 * 链路（与 dsh 里 Agent 工具 audio_subtitle 同一套口径）：
 *   校验文件 → ffmpeg 探时长 → silencedetect 找静音区间 → 拼成「整句」
 *   → 每句 ffmpeg 切成 16k 单声道 PCM16 WAV → 官方本地 SenseVoice 逐句识别
 *   →（给了原台词时）台词句 ↔ 识别段单调对齐，正文改从台词里截取
 *   → 字幕排版（断句 / 限长 / 按字数占比分配时间）→ cues + SRT + VTT 文本。
 *
 * 原台词（切分模式）：识别总会错字，用户手上有原台词时希望字幕正文照台词。
 * 但时间边界只能来自静音切句，所以「台词第 n 句 ↔ 语音第几段」要自己对齐：
 *   · 台词按标点断句（换行也是强制断句点）；
 *   · 与识别段做单调（不交叉）相似度对齐，两侧都可跳过、可合并相邻段；
 *   · 对不上的跳过不报错，清单写进 unmatchedScript / unmatchedAsr；
 *   · 对齐与断句都只有一份实现：dsh/gateway/subtitle-cues.mjs。
 *
 * 事实与边界（查证过，改之前先复核）：
 *   · 官方 SenseVoice 的 transcribe() 只回 { text, audioSeconds, inferenceSeconds }，
 *     **没有任何时间戳**（dsh-experimental-speech-to-text 的 Transcript）。
 *     所以时间边界只能来自「静音切句」的切片边界 —— 切片级近似，不是逐字对齐。
 *   · 识别服务只有一份：dsh 运行时的语音通道（与录音听写、画布输入节点的转录同一份
 *     权重 / 同一台运行时）。这里经 dsh().speech({action:'transcribe'}) 调它，
 *     **不另装 ASR、不另起模型**。
 *   · SenseVoice **自动启用**（不需要用户先去「启用 / 下载」）：语音运行时由网关按需拉起，
 *     权重首次使用自动下载，识别器还没注册好会自动等、「还没就绪」类失败自动重试一次。
 *     这套判定只写一份：dsh/gateway/speech-ready.mjs（网关侧的 audio_subtitle 用同一份）。
 *   · ffmpeg 查找顺序与 dsh 侧一致：系统 PATH → Remotion 安装目录 → 其它后端便携目录；
 *     都没有就给「去插件里装 Remotion」的指引，不自动下载。
 *   · 字幕排版（断句 / 时间分配 / SRT·VTT 时间码）**不在这里写第二份**：
 *     直接 import dsh/gateway/subtitle-cues.mjs（与 Agent 工具同一个文件）。
 *   · 不写任何产物文件：只回文本（cues / srt / vtt），要落盘交给下游 save 节点。
 *
 * 本文件不 require electron，也不自己 spawn 网关：speech 与 ffmpeg 都从参数注入，
 * 所以 test/smoke-subtitle-tool.js 能用假 ffmpeg + 假语音把整条链跑一遍。
 * ==========================================================================*/
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL, fileURLToPath } = require("node:url");

const EXE = process.platform === "win32" ? ".exe" : "";
const MAX_MEDIA_BYTES = 1024 * 1024 * 1024;
const MAX_MEDIA_SECONDS = 2 * 60 * 60;
const MAX_CHUNK_SECONDS = 25;
const MIN_CHUNK_SECONDS = 2.5;
const MIN_SPEECH_SECONDS = 0.25;
const SILENCE_NOISE = "-35dB";
const SILENCE_MIN_SECONDS = 0.4;
const FFMPEG_TIMEOUT_MS = 120000;
const FFMPEG_TIMEOUT_MAX_MS = 600000;
const LANGUAGE_ENUM = ["auto", "zh", "en", "yue", "ja", "ko"];
const NOT_FOUND_HINT =
  "本机没有可用的 ffmpeg。「音频转字幕」要靠它按静音切句：请到「插件」里安装 / 重装 Remotion 动效视频" +
  "（安装时会一并带下它自带的 ffmpeg），或把系统 ffmpeg 加进 PATH 后重试。" +
  "不需要另外去下载别的转写 / 转码方案。";

/* ── 字幕排版：与 dsh 侧同一个文件（单一真源）─────────────────────────────── */

let cuesModPromise = null;
/**
 * 载入共享的字幕排版模块（dsh/gateway/subtitle-cues.mjs）。
 * 打包后 gateway 在「随包归档解到数据目录」的那棵树里（见 dsh-node.js 的 ensureGatewayRoot），
 * dev 在仓库树里 —— 两种布局都由 dsh/main-dsh.js 的 gatewayPath() 给出，这里只借它的目录，
 * 不另写路径知识。
 * @param {string} [gatewayPath] 网关入口路径（测试可注入）
 */
function loadCueModule(gatewayPath) {
  if (cuesModPromise) return cuesModPromise;
  const entry = String(gatewayPath || "").trim();
  const file = entry
    ? path.join(path.dirname(entry), "subtitle-cues.mjs")
    : path.join(__dirname, "dsh", "gateway", "subtitle-cues.mjs");
  /* 缓存口令 = 该文件的 mtime + 大小：内核被更新（改断句 / 对齐规则）后，下一次转写
     就会加载新实现，不用重启应用。ESM 的 import() 结果按 URL 缓存，所以只加口令、
     不清缓存表；文件读不到时退回不带口令（行为与以前一致，错误交给下面的 catch）。 */
  let stamp = "";
  try {
    const st = fs.statSync(file);
    stamp = "?v=" + st.mtimeMs + "-" + st.size;
  } catch {
    stamp = "";
  }
  cuesModPromise = import(pathToFileURL(file).href + stamp).catch((err) => {
    cuesModPromise = null;
    throw new Error(
      "字幕排版模块缺失（" + file + "）：" + ((err && err.message) || String(err)),
    );
  });
  return cuesModPromise;
}

let wavModPromise = null;
/**
 * 载入共享的 WAV 归一模块（dsh/gateway/speech-wav.mjs）。
 * 为什么需要：官方 SenseVoice 的 validateWave() 只认**标准 44 字节头**的 16k 单声道
 * PCM16 WAV，而 ffmpeg 切出来的 WAV 在 fmt 之后带一个 `LIST … INFO ISFT LavfXX`
 * 元数据块（第 36 字节不是 'data'）→ 会被判成「invalid speech wav」。
 * 归一逻辑与网关侧的 audio_subtitle 共用同一个文件，不写第二份。
 * @param {string} [gatewayPath] 网关入口路径（测试可注入）
 */
function loadWavModule(gatewayPath) {
  if (wavModPromise) return wavModPromise;
  const entry = String(gatewayPath || "").trim();
  const file = entry
    ? path.join(path.dirname(entry), "speech-wav.mjs")
    : path.join(__dirname, "dsh", "gateway", "speech-wav.mjs");
  wavModPromise = import(pathToFileURL(file).href).catch((err) => {
    wavModPromise = null;
    throw new Error("WAV 归一模块缺失（" + file + "）：" + ((err && err.message) || String(err)));
  });
  return wavModPromise;
}

/* ── ffmpeg 定位（与 dsh/gateway/media-plugin.mjs 同一套顺序）──────────────── */

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function fromPath() {
  const cmd = process.platform === "win32" ? "where" : "which";
  const r = spawnSync(cmd, ["ffmpeg"], { windowsHide: true, encoding: "utf8" });
  if (r.status !== 0) return "";
  const line = String(r.stdout || "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)[0];
  return line && fs.existsSync(line) ? line : "";
}

function fromKnownLayouts(root) {
  if (!root || !fs.existsSync(root)) return "";
  const cands = [
    path.join(root, "ffmpeg" + EXE),
    path.join(root, "bin", "ffmpeg" + EXE),
    path.join(root, "tools", "ffmpeg", "ffmpeg" + EXE),
    path.join(root, "tools", "ffmpeg", "bin", "ffmpeg" + EXE),
  ];
  for (const c of cands) if (fs.existsSync(c)) return c;
  return "";
}

/** Remotion 的 ffmpeg 在 node_modules/@remotion/compositor-<平台>/ffmpeg.exe。 */
function fromRemotion(installDir) {
  const known = fromKnownLayouts(installDir);
  if (known) return known;
  const base = path.join(installDir, "node_modules", "@remotion");
  if (!fs.existsSync(base)) return "";
  let entries = [];
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return "";
  }
  for (const ent of entries) {
    if (!ent.isDirectory() || !/^compositor-/i.test(ent.name)) continue;
    const hit = path.join(base, ent.name, "ffmpeg" + EXE);
    if (fs.existsSync(hit)) return hit;
  }
  return "";
}

const BACKEND_DIRS = ["remotion", "breeze", "h3", "music3", "yue", "llama"];

function fromBackends(root) {
  if (!root) return "";
  for (const id of BACKEND_DIRS) {
    const cfg = readJson(path.join(root, id, "config.json"));
    const dir = cfg && typeof cfg.installDir === "string" ? cfg.installDir.trim() : "";
    if (!dir || !fs.existsSync(dir)) continue;
    const hit = id === "remotion" ? fromRemotion(dir) : fromKnownLayouts(dir);
    if (hit) return hit;
  }
  return "";
}

/**
 * 解析本机 ffmpeg：PATH → Remotion 安装目录 → 其它后端便携目录。
 * @param {string} dataDir MTNode 数据目录（各后端 config.json 在它下面）
 * @returns {{ffmpeg:string, ffprobe:string, source:string}}
 * @throws 找不到时抛出带安装指引的错误
 */
function resolveFfmpeg(dataDir) {
  const root = String(dataDir || "").trim();
  const candidates = [["PATH", fromPath()]];
  const remotionCfg = root ? readJson(path.join(root, "remotion", "config.json")) : null;
  const remotionDir =
    remotionCfg && typeof remotionCfg.installDir === "string" ? remotionCfg.installDir.trim() : "";
  if (remotionDir) candidates.push(["Remotion 安装目录", fromRemotion(remotionDir)]);
  candidates.push(["本机已装后端的便携 ffmpeg", fromBackends(root)]);
  for (const [source, ffmpeg] of candidates) {
    if (!ffmpeg || !fs.existsSync(ffmpeg)) continue;
    const sibling = path.join(path.dirname(ffmpeg), "ffprobe" + EXE);
    return { ffmpeg, ffprobe: fs.existsSync(sibling) ? sibling : "", source };
  }
  throw new Error(NOT_FOUND_HINT);
}

/* ── ffmpeg 执行（参数数组直传、不经 shell；串行闸避免几路转码打满 CPU）──────── */

let ffmpegGate = Promise.resolve();

function runFfmpeg(ffmpeg, args, opts = {}) {
  const run = () =>
    new Promise((resolve) => {
      let child = null;
      try {
        child = spawn(ffmpeg, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      } catch (err) {
        resolve({ code: -1, stdout: "", stderr: String((err && err.message) || err) });
        return;
      }
      let stdout = "";
      let stderr = "";
      let done = false;
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {}
      }, Math.min(Math.max(Number(opts.timeoutMs) || FFMPEG_TIMEOUT_MS, 1000), FFMPEG_TIMEOUT_MAX_MS));
      const finish = (code) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      };
      child.stdout.on("data", (d) => {
        stdout += d.toString();
        if (stdout.length > 200000) stdout = stdout.slice(-100000);
      });
      child.stderr.on("data", (d) => {
        stderr += d.toString();
        if (stderr.length > 200000) stderr = stderr.slice(-100000);
      });
      child.on("error", (err) => {
        stderr += String((err && err.message) || err);
        finish(-1);
      });
      child.on("close", (code) => finish(code == null ? -1 : code));
    });
  const next = ffmpegGate.then(run, run);
  ffmpegGate = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

/* ── 切句 / 探测（与 dsh 侧同一口径：静音断开、太长均分、零碎并回前句）──────── */

const clampNum = (value, min, max, fallback) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
};

function normalizeNoise(value) {
  if (value == null || value === "") return SILENCE_NOISE;
  const n = Number(String(value).replace(/db$/i, "").trim());
  if (!Number.isFinite(n)) return SILENCE_NOISE;
  const db = Math.min(Math.max(n, -90), -5);
  return db + "dB";
}

/** 从 ffmpeg 的 -i 输出里取时长（不依赖 ffprobe）。 */
function parseDuration(text) {
  const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(String(text || ""));
  if (!m) return 0;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

async function probeMedia(run, file) {
  const r = await run(["-hide_banner", "-nostdin", "-i", file], { timeoutMs: 30000 });
  const text = r.stderr + r.stdout;
  return {
    durationSeconds: parseDuration(text),
    hasAudio: /Stream #\d+:\d+.*: Audio:/.test(text),
  };
}

/**
 * 用 silencedetect 找出说话区间，拼成「句」。
 * @param {number} duration
 * @param {Array<{start:number,end:number}>} silences
 * @param {{maxChunkSeconds?:number}} [opts]
 */
function planSpeechSegments(duration, silences, opts = {}) {
  const out = [];
  if (!(duration > 0)) return out;
  const maxChunk = clampNum(opts.maxChunkSeconds, MIN_CHUNK_SECONDS, MAX_CHUNK_SECONDS, MAX_CHUNK_SECONDS);
  const sorted = (Array.isArray(silences) ? silences : [])
    .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start)
    .sort((a, b) => a.start - b.start);
  let cursor = 0;
  const push = (start, end) => {
    if (end - start < MIN_SPEECH_SECONDS) return;
    out.push({ start, end });
  };
  for (const s of sorted) {
    const start = Math.max(cursor, 0);
    const end = Math.min(s.start, duration);
    if (end > start) push(start, end);
    cursor = Math.max(cursor, s.end);
  }
  if (duration > cursor) push(cursor, duration);
  if (!out.length) out.push({ start: 0, end: duration });

  const split = [];
  for (const seg of out) {
    const len = seg.end - seg.start;
    if (len <= maxChunk) {
      split.push(seg);
      continue;
    }
    const parts = Math.ceil(len / maxChunk);
    const step = len / parts;
    for (let i = 0; i < parts; i++) {
      split.push({ start: seg.start + step * i, end: seg.start + step * (i + 1) });
    }
  }
  const merged = [];
  for (const seg of split) {
    const prev = merged[merged.length - 1];
    if (
      prev &&
      seg.end - seg.start < MIN_CHUNK_SECONDS &&
      seg.start - prev.end <= 0.6 &&
      seg.end - prev.start <= maxChunk
    ) {
      prev.end = seg.end;
      continue;
    }
    merged.push({ start: seg.start, end: seg.end });
  }
  return merged.map((s) => ({
    start: Math.round(s.start * 1000) / 1000,
    end: Math.round(s.end * 1000) / 1000,
  }));
}

async function detectSilences(run, file, opts = {}) {
  const noise = normalizeNoise(opts.noiseDb);
  const minSilence = clampNum(opts.minSilenceSec, 0.1, 3, SILENCE_MIN_SECONDS);
  const r = await run(
    ["-hide_banner", "-nostdin", "-i", file, "-vn", "-af", `silencedetect=noise=${noise}:d=${minSilence}`, "-f", "null", "-"],
    { timeoutMs: FFMPEG_TIMEOUT_MAX_MS },
  );
  const text = r.stderr + r.stdout;
  const silences = [];
  let open = null;
  for (const line of text.split(/\r?\n/)) {
    const s = /silence_start:\s*(-?\d+(?:\.\d+)?)/.exec(line);
    if (s) {
      open = Number(s[1]);
      continue;
    }
    const e = /silence_end:\s*(-?\d+(?:\.\d+)?)/.exec(line);
    if (e && open !== null) {
      silences.push({ start: Math.max(open, 0), end: Number(e[1]) });
      open = null;
    }
  }
  return silences;
}

/** 媒体文件校验：存在、是文件、大小上限。认本机绝对路径，也认 file:/// URL。 */
function checkMediaFile(file, allowLarge) {
  let p = String(file || "").trim();
  if (!p) throw new Error("缺少媒体文件路径（要给本机绝对路径，或 file:/// URL）");
  if (/^file:\/\//i.test(p)) {
    try {
      p = fileURLToPath(p);
    } catch {
      throw new Error("不是有效的 file:/// URL：" + p);
    }
  }
  if (!path.isAbsolute(p)) throw new Error("媒体路径必须是本机绝对路径：" + p);
  if (!fs.existsSync(p)) throw new Error("文件不存在：" + p);
  let st = null;
  try {
    st = fs.statSync(p);
  } catch {
    throw new Error("无法读取文件：" + p);
  }
  if (!st.isFile()) throw new Error("不是文件：" + p);
  const limit = allowLarge ? Infinity : MAX_MEDIA_BYTES;
  if (st.size > limit) {
    throw new Error(
      "文件 " + (st.size / 1024 / 1024).toFixed(1) + "MB 超过单次上限 " +
        Math.round(limit / 1024 / 1024) + "MB（可传 allowLarge:true 放宽）",
    );
  }
  return { path: p, bytes: st.size };
}

/* ── 语音：走 dsh 运行时的语音通道（与录音听写 / 画布节点转录同一份权重）──────── */

let speechReadyModPromise = null;
/**
 * 载入共享的「SenseVoice 自动就绪」策略（dsh/gateway/speech-ready.mjs）。
 * 与字幕排版模块同一个目录、同一套路径知识：网关目录由调用方给（打包 / dev 两种布局）。
 * @param {string} [gatewayPath] 网关入口路径（测试可注入）
 */
function loadSpeechReadyModule(gatewayPath) {
  if (speechReadyModPromise) return speechReadyModPromise;
  const entry = String(gatewayPath || "").trim();
  const file = entry
    ? path.join(path.dirname(entry), "speech-ready.mjs")
    : path.join(__dirname, "dsh", "gateway", "speech-ready.mjs");
  speechReadyModPromise = import(pathToFileURL(file).href).catch((err) => {
    speechReadyModPromise = null;
    throw new Error(
      "语音就绪策略模块缺失（" + file + "）：" + ((err && err.message) || String(err)),
    );
  });
  return speechReadyModPromise;
}

/**
 * 等识别器就绪 —— **自动**的：运行时按需拉起、权重按需下载，用户不用手动启用任何东西。
 * 判定与重试口径全在同目录 speech-ready.mjs（网关侧 media-plugin.mjs 用的是同一份）。
 *
 * @param {(p:object)=>Promise<object>} speech dsh 语音通道调用（{action, workspace, …}）
 * @param {string} workspace 工作区（语音运行时按它记账）
 * @param {number} deadlineMs 触发准备后最长等待
 * @param {object} [mod] speech-ready.mjs 模块（测试可注入，免去真实等待）
 * @param {object} [timing] { waitProviderMs, pollMs, sleep } 时序覆盖（测试用）
 */
async function ensureSpeechReady(speech, workspace, deadlineMs, mod, timing) {
  const m = mod || (await loadSpeechReadyModule(timing && timing.gatewayPath));
  const t = timing && typeof timing === "object" ? timing : {};
  const r = await m.ensureSpeechProvider(
    {
      snapshot: () => speech({ action: "state", workspace }),
      prepare: (providerId) => speech({ action: "prepare", workspace, providerId }),
    },
    {
      deadlineMs,
      waitProviderMs: t.waitProviderMs,
      pollMs: t.pollMs,
      sleep: t.sleep,
    },
  );
  return String((r && r.providerId) || "");
}

/** 识别失败是不是「语音服务还没就绪」这一类 —— 判定在 speech-ready.mjs（与网关同一份）。 */
function isSpeechNotReadyError(mod, message) {
  return typeof mod.isSpeechNotReadyError === "function"
    ? mod.isSpeechNotReadyError(message)
    : /prepare|not\s*ready|unavailable|unprepared|就绪|准备|下载/i.test(String(message || ""));
}

/* ── 主链路 ──────────────────────────────────────────────────────────────── */

/**
 * 一段媒体 → 字幕（cues + SRT + VTT）。
 *
 * @param {object} params
 *   file / language / allowLarge / maxDurationSec / maxChars / noiseDb / minSilenceSec /
 *   breakPunctuation / script（原台词，可选：给了就走切分模式）/ keepPunctuation（默认 false）
 *   —— 与 Agent 工具 audio_subtitle 同名同义；参数都是可选的
 * @param {object} deps
 *   dataDir    MTNode 数据目录（找后端便携 ffmpeg 用）
 *   speech     (p) => Promise<{ok, …}>：dsh 语音通道（main.js 注入 dsh().speech）
 *   workspace  语音运行时的工作区（缺省用 dataDir）
 *   gatewayPath 网关入口路径（缺省按本仓库布局找 subtitle-cues.mjs / speech-ready.mjs；测试可注入）
 *   speechTiming / speechReady / ensureSpeech 只给测试注入（时序 / 策略模块 / 直接给就绪函数）：
 *   正常链路全自动 —— 语音运行时按需拉起、权重按需下载、未就绪自动重试，不需要用户启用任何东西。
 * @returns {Promise<object>} 成功 { ok:true, cues, srt, vtt, … }；失败 { ok:false, error }
 */
async function subtitleFromMedia(params, deps) {
  const a = params && typeof params === "object" ? params : {};
  const d = deps && typeof deps === "object" ? deps : {};
  try {
    const speech = d.speech;
    if (typeof speech !== "function") {
      return { ok: false, error: "语音通道未接线（主进程没有注入 dsh().speech）" };
    }
    const cuesMod = await loadCueModule(d.gatewayPath);
    const { buildSubtitleCues, formatSrt, formatVtt, isCjkHeavy } = cuesMod;
    const { canonicalPcmWav16k } = await loadWavModule(d.gatewayPath);

    const language = LANGUAGE_ENUM.indexOf(String(a.language || "auto")) >= 0 ? String(a.language || "auto") : "auto";
    const media = checkMediaFile(a.file, a.allowLarge === true);
    /* ffmpeg 的定位与执行都能注入（测试用假 ffmpeg 校切句 / 时间码，不依赖本机装没装）。 */
    const resolved =
      typeof d.resolveFfmpeg === "function"
        ? d.resolveFfmpeg()
        : resolveFfmpeg(d.dataDir || d.workspace || "");
    const { ffmpeg, source: ffmpegSource } = resolved || {};
    const runFf =
      typeof d.runFfmpeg === "function"
        ? (args, o) => d.runFfmpeg(args, o)
        : (args, o) => runFfmpeg(ffmpeg, args, o);

    const probe = await probeMedia(runFf, media.path);
    if (!probe.hasAudio) throw new Error("这个文件里没有音轨，无法转写：" + media.path);
    if (!(probe.durationSeconds > 0)) {
      throw new Error("读不到媒体时长（文件可能损坏或容器不受支持）：" + media.path);
    }
    if (a.allowLarge !== true && probe.durationSeconds > MAX_MEDIA_SECONDS) {
      throw new Error(
        "时长 " + Math.round(probe.durationSeconds) + " 秒超过单次上限 " + MAX_MEDIA_SECONDS +
          " 秒（约 2 小时）；可先用 ffmpeg 截取区间，或传 allowLarge:true。",
      );
    }

    const workspace = String(d.workspace || d.dataDir || "").trim();
    if (!workspace) throw new Error("缺少 workspace：语音运行时按工作区记账");
    /* 整句上限跟着单条字幕时长走（避免先被 25 秒切碎再排版），与 Agent 工具一致。 */
    const maxDurationSec = clampNum(a.maxDurationSec, 1, 60, cuesMod.SUBTITLE_MAX_SECONDS);
    const plan = planSpeechSegments(
      probe.durationSeconds,
      await detectSilences(runFf, media.path, { noiseDb: a.noiseDb, minSilenceSec: a.minSilenceSec }),
      { maxChunkSeconds: maxDurationSec * 1.5 },
    );
    if (!plan.length) throw new Error("没有识别到可切分的说话区间：" + media.path);

    /* 语音就绪：运行时按需拉起 + 权重按需下载，全自动（不需要用户启用任何东西）。
       d.ensureSpeech / d.speechReady / d.speechTiming 只给测试注入，正常链路不用给。 */
    const speechReadyMod = d.speechReady || (await loadSpeechReadyModule(d.gatewayPath));
    const ensureReady =
      typeof d.ensureSpeech === "function"
        ? d.ensureSpeech
        : () => ensureSpeechReady(speech, workspace, 10 * 60 * 1000, speechReadyMod, d.speechTiming);
    let providerId = await ensureReady();

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-subtitle-"));
    const segments = [];
    let inferenceSeconds = 0;
    try {
      for (let i = 0; i < plan.length; i++) {
        const seg = plan[i];
        const wav = path.join(dir, "seg-" + String(i).padStart(4, "0") + ".wav");
        const cut = await runFf(
          ["-hide_banner", "-nostdin", "-y", "-ss", String(seg.start), "-t", String(seg.end - seg.start), "-i", media.path,
            "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav],
          { timeoutMs: FFMPEG_TIMEOUT_MS },
        );
        if (cut.code !== 0 || !fs.existsSync(wav)) {
          throw new Error(
            "切片失败（" + seg.start + "s–" + seg.end + "s）：" + String(cut.stderr || "").slice(-600),
          );
        }
        let out = null;
        /* ffmpeg 的 WAV 头带 LIST/INFO 块，官方 validateWave 只认标准 44 字节头：
           这里归一后再送（否则就是用户看到的「invalid speech wav」）。 */
        const audio = canonicalPcmWav16k(fs.readFileSync(wav)).toString("base64");
        try {
          for (let attempt = 1; ; attempt++) {
            out = await speech({
              action: "transcribe",
              workspace,
              audio,
              language,
              providerId,
            });
            if (out && out.ok !== false) break;
            /* 「还没就绪」类失败（运行时刚起 / 权重刚下完还没 loaded）：自动重新就绪一次
               （必要时会再触发下载）后重试这一句 —— 用户不用去点任何「启用 / 下载」。
               只补一次，真失败就照常报错。 */
            if (attempt >= 2 || !isSpeechNotReadyError(speechReadyMod, out && out.error)) break;
            providerId = await ensureReady();
          }
        } finally {
          try {
            fs.rmSync(wav, { force: true });
          } catch {}
        }
        if (!out || out.ok === false) {
          throw new Error("识别失败（" + seg.start + "s–" + seg.end + "s）：" + String((out && out.error) || "未知错误"));
        }
        const text = String(out.text || "").trim();
        inferenceSeconds += Number(out.inferenceSeconds) || 0;
        if (!text) continue;
        segments.push({ start: seg.start, end: seg.end, text });
      }
    } finally {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {}
    }

    const scriptText = String(a.script == null ? "" : a.script).trim();
    const mode = scriptText ? "script" : "asr";
    const keepPunctuation = a.keepPunctuation === true;
    const breakPunctuation =
      a.breakPunctuation == null ? cuesMod.SUBTITLE_BREAK_PUNCT : String(a.breakPunctuation);

    /* 切分模式：台词按标点断句 → 与识别段做单调对齐，正文从台词里截取、时间取语音段。
       对不上的两边都跳过，清单原样回给用户核对（不报错、不硬塞）。 */
    const asrText = segments.map((s) => s.text).join("\n");
    let sentenceInput = segments.map((s) => ({ start: s.start, end: s.end, text: s.text, source: "asr" }));
    let unmatchedScript = [];
    let unmatchedAsr = [];
    let aligned = 0;
    if (mode === "script") {
      const scriptSentences = cuesMod.splitScriptSentences(scriptText, breakPunctuation);
      const al = cuesMod.alignScriptToAsr(scriptSentences, segments);
      aligned = al.pairs.length;
      unmatchedScript = al.unmatchedScript;
      unmatchedAsr = al.unmatchedAsr.map((s) => ({
        start: s.start,
        end: s.end,
        text: s.text,
      }));
      sentenceInput = al.pairs.map((p) => ({
        start: p.start,
        end: p.end,
        text: p.text,
        source: "script",
        similarity: p.similarity,
        asrText: p.asrText,
      }));
    }

    const joined = sentenceInput.map((s) => s.text).join("");
    const latin = !isCjkHeavy(joined);
    const maxChars = clampNum(
      a.maxChars,
      4,
      200,
      latin ? cuesMod.SUBTITLE_MAX_CHARS_LATIN : cuesMod.SUBTITLE_MAX_CHARS_CJK,
    );
    const cues = buildSubtitleCues(sentenceInput, {
      maxChars,
      latin,
      maxDurationSec,
      breakPunctuation,
      keepPunctuation,
    });

    return {
      ok: true,
      engine: "sensevoice-local",
      ffmpegSource,
      file: media.path,
      durationSeconds: Math.round(probe.durationSeconds * 1000) / 1000,
      language,
      mode,
      cueCount: cues.length,
      cues,
      /* 切分模式：识别原文 + 两侧没对上的清单（供人工核对错字 / 漏念）。 */
      ...(mode === "script"
        ? { asrText, alignedCount: aligned, unmatchedScript, unmatchedAsr }
        : {}),
      params: {
        mode,
        maxDurationSec,
        maxChars,
        latin,
        keepPunctuation,
        noiseDb: normalizeNoise(a.noiseDb),
        minSilenceSec: clampNum(a.minSilenceSec, 0.1, 3, SILENCE_MIN_SECONDS),
        breakPunctuation,
      },
      srt: formatSrt(cues),
      vtt: formatVtt(cues),
      inferenceSeconds: Math.round(inferenceSeconds * 1000) / 1000,
      ...(cues.length
        ? {}
        : {
            note:
              mode === "script"
                ? "原台词与这段语音一句都没对上（可能是台词给错了，或这段没有语音）；cues 与字幕文本都是空的，看 unmatchedScript / unmatchedAsr 两份清单。"
                : "这一段里没有识别到语音（可能是纯音乐 / 静音，或语言不受支持），cues 与字幕文本都是空的。",
          }),
      hint: "时间边界是切片级近似值（静音切句 + 按字数占比分配），不是逐字对齐；本工具不写文件。",
    };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

module.exports = {
  subtitleFromMedia,
  resolveFfmpeg,
  planSpeechSegments,
  parseDuration,
  normalizeNoise,
  checkMediaFile,
  loadCueModule,
};
