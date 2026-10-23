// MTNode 本地媒体能力（runs INSIDE the dsh runtime process）—— 给 Agent 两个直接可用的工具：
//
//   · audio_transcribe —— 把本地音频 / 视频里的说话内容转成文字（字幕制作的主力入口）
//   · ffmpeg           —— 本机 ffmpeg：任意参数的转码 / 探测 / 抽音轨 / 抽帧，外加 describe
//                         （抽帧 → 转调宿主 mtnode_vision → 一次返回画面描述）
//
// 为什么要有这一层（用户口径）：以前 Agent 需要语音转写时会去网上另找方案（装 whisper /
// Qwen-ASR / 在线 ASR），需要处理视频时会去下载 ffmpeg。MTNode 本来就已经有几件现成的：
//   · 官方本地 SenseVoice（cordis.yml 的 speech-to-text 四行，CPU 离线，权重按需下载）——
//     但它只服务于「录音听写」与画布输入节点的转写，Agent 侧一个工具都没有；
//   · Remotion 安装（npm install）会连带装下它自己的 ffmpeg（@remotion/compositor-*），
//     项目本身**不打包** ffmpeg。
// 所以这里把它们变成 Agent 能直接调的工具，并在工具描述 + 技能里写死「优先用本地能力」。
//
// 事实与边界（都是查证过的，改之前先复核）：
//   · 官方 SenseVoice 的音频契约是 **16 kHz 单声道 PCM16 WAV**，provider 的 transcribe() 只回
//     整段文本 + 时长（dsh-experimental-speech-to-text 的 Transcript：text / audioSeconds /
//     inferenceSeconds），**没有时间戳**；单次录音还有体积上限（默认 4MB ≈ 128 秒）。
//     所以字幕要时间轴只能自己切段：这里用 ffmpeg 的 silencedetect 按静音区间切句，
//     逐段转写，段边界即近似时间戳（切片级，不是逐字对齐）。
//   · 字幕专用工具 audio_subtitle 与 audio_transcribe 共用这条转写链，只在「切句之后」多一层
//     字幕排版：按标点 / 字符数 / 单条最长秒数把整句拆成 cue，时间按字数比例分配，
//     直接给出 cues + SRT + VTT 文本。**它不写文件**（用户口径：产物由调用方自己落盘），
//     也不改 audio_transcribe 的返回结构。
//   · ffmpeg 查找顺序（用户共识）：系统 PATH → Remotion 安装目录（compositor 自带）→
//     其它本地后端（Breeze / H3 等）的便携 ffmpeg → 都没有就报错并指引去插件里安装
//     Remotion。**不自动下载**。
//   · 任意 ffmpeg 参数的护栏（用户共识）：输出路径必须落在可写根（工作区 / MTNode 数据目录 /
//     系统临时目录）内；参数数组直传、不经 shell；不默认加 -y；带超时与串行上限。
//   · describe 复用宿主已有的识图入口（渲染层的 op "vision"，模型路由与「识图许可」都在那），
//     网关只负责抽帧 + 发帧，不另接视觉模型。
//
// 桥协议：与 canvas-plugin 同一条 localhost TCP 桥（MTNODE_BRIDGE_PORT）。
//   plugin → gateway: {t:'canvas', id, sessionId, op:'vision', params:{imagePath, question}}
//   gateway → plugin: {t:'canvas-result', id, ok, result?, error?} | {t:'abort', id}
// 语音转写不走网桥：它直接读运行时里的 ctx.speechToText 服务（可选获取，取不到 = 只回错误文本）。

import { spawn, spawnSync } from 'node:child_process'
import { createConnection } from 'node:net'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { isToolHidden } from './tool-visibility.mjs'

export const name = 'mtnode-media'
export const inject = ['tools']

/* ── 上限（用户共识：单文件 ≤ 2 小时 / ≤ 1GB，可用参数放宽）──────────────────── */
const MAX_MEDIA_BYTES = 1024 * 1024 * 1024
const MAX_MEDIA_SECONDS = 2 * 60 * 60
/* SenseVoice 单次音频上限 = 4MB / 16kHz 单声道 16bit ≈ 128 秒；切片留足余量（默认 25 秒）。 */
const MAX_CHUNK_SECONDS = 25
const MIN_CHUNK_SECONDS = 2.5
const MIN_SPEECH_SECONDS = 0.25
const SILENCE_NOISE = '-35dB'
const SILENCE_MIN_SECONDS = 0.4
/* describe：均匀抽 6–8 帧、上限 12 帧、单帧宽 ≤ 1280。 */
const DESCRIBE_DEFAULT_FRAMES = 7
const DESCRIBE_MAX_FRAMES = 12
const FRAME_MAX_WIDTH = 1280
/* ffmpeg 单次执行：默认 120 秒、上限 600 秒；并发 1（本机 CPU 别被同时几条转码打满）。 */
const FFMPEG_TIMEOUT_MS = 120000
const FFMPEG_TIMEOUT_MAX_MS = 600000
const FFMPEG_OUTPUT_TAIL = 4000

const LANGUAGE_ENUM = ['auto', 'zh', 'en', 'yue', 'ja', 'ko']

/* ── 字幕排版默认值（用户共识：6s / 中文 18 字·英文 42 字符 / -35dB / 0.4s）────── */
const SUBTITLE_MAX_SECONDS = 6
const SUBTITLE_MAX_CHARS_CJK = 18
const SUBTITLE_MAX_CHARS_LATIN = 42
const SUBTITLE_BREAK_PUNCT = '。！？!?；;…，,、'
const CJK_RE = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]/
/* 中文字幕按字断、英文字幕按词断：CJK 占比超过这条线就按中文字符口径算。 */
const CJK_RATIO_FOR_CJK = 0.2

/* ── 通用小工具 ────────────────────────────────────────────────────────────── */

function jsonResult(value) {
  let text
  try {
    text = JSON.stringify(value)
  } catch {
    text = String(value)
  }
  return [{ type: 'text', text: String(text).slice(0, 40000) }]
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function clip(s, n) {
  const x = String(s == null ? '' : s)
  return x.length > n ? x.slice(0, n) + '…' : x
}

/** 数值参数归一：非数字 / 越界回落到默认值（工具参数来自模型，不能直接信）。 */
function clampNum(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(n, min), max)
}

/** 静音阈值：收 -35 / '-35dB' 两种写法，规范成 silencedetect 要的 '-35dB'。 */
function normalizeNoise(value) {
  if (value == null || value === '') return SILENCE_NOISE
  const n = Number(String(value).replace(/db$/i, '').trim())
  if (!Number.isFinite(n)) return SILENCE_NOISE
  const db = Math.min(Math.max(n, -90), -5)
  return db + 'dB'
}

/** MTNode 数据目录 = DSH_HOME 的父目录（main-dsh.js 里 DSH_HOME = <dataDir>/dsh-home）。 */
function dataRoot() {
  const home = String(process.env.DSH_HOME || '').trim()
  return home ? dirname(home) : ''
}

function readJson(p) {
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

function isUnder(root, p) {
  if (!root) return false
  const a = resolve(root).toLowerCase().replace(/[\\/]+$/, '')
  const b = resolve(p).toLowerCase()
  return b === a || b.startsWith(a + '\\') || b.startsWith(a + '/')
}

/* ── ffmpeg 定位：PATH → Remotion → 其它后端便携 → 报错指引 ────────────────── */

const EXE = process.platform === 'win32' ? '.exe' : ''
const NOT_FOUND_HINT =
  '本机没有可用的 ffmpeg。语音转写与视频分析都依赖它：请到「插件」里安装 / 重装 Remotion 动效视频' +
  '（安装时会一并装下它自带的 ffmpeg），或把系统 ffmpeg 加进 PATH 后重试。' +
  '不要另外去下载别的转写 / 转码方案。'

let ffmpegCache = null

/** 从 PATH 找（Windows 用 where，其它平台用 which）。 */
function fromPath() {
  const cmd = process.platform === 'win32' ? 'where' : 'which'
  const r = spawnSync(cmd, ['ffmpeg'], { windowsHide: true, encoding: 'utf8' })
  if (r.status !== 0) return ''
  const line = String(r.stdout || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)[0]
  return line && existsSync(line) ? line : ''
}

/** 在给定根下按「浅层固定位置」找 ffmpeg（不递归整盘，避免拖慢工具调用）。 */
function fromKnownLayouts(root) {
  if (!root || !existsSync(root)) return ''
  const cands = [
    join(root, 'ffmpeg' + EXE),
    join(root, 'bin', 'ffmpeg' + EXE),
    join(root, 'tools', 'ffmpeg', 'ffmpeg' + EXE),
    join(root, 'tools', 'ffmpeg', 'bin', 'ffmpeg' + EXE),
  ]
  for (const c of cands) if (existsSync(c)) return c
  return ''
}

/** Remotion 的 ffmpeg 在 node_modules/@remotion/compositor-<平台>/ffmpeg.exe。 */
function fromRemotion(installDir) {
  const known = fromKnownLayouts(installDir)
  if (known) return known
  const base = join(installDir, 'node_modules', '@remotion')
  if (!existsSync(base)) return ''
  let entries = []
  try {
    entries = readdirSync(base, { withFileTypes: true })
  } catch {
    return ''
  }
  for (const ent of entries) {
    if (!ent.isDirectory() || !/^compositor-/i.test(ent.name)) continue
    const hit = join(base, ent.name, 'ffmpeg' + EXE)
    if (existsSync(hit)) return hit
  }
  return ''
}

/** 已安装的本地后端（各自 config.json 里的 installDir）里可能带便携 ffmpeg。 */
const BACKEND_DIRS = ['remotion', 'breeze', 'h3', 'music3', 'yue', 'sensenova', 'llama']

function fromBackends(root) {
  if (!root) return ''
  for (const id of BACKEND_DIRS) {
    const cfg = readJson(join(root, id, 'config.json'))
    const dir = cfg && typeof cfg.installDir === 'string' ? cfg.installDir.trim() : ''
    if (!dir || !existsSync(dir)) continue
    const hit = id === 'remotion' ? fromRemotion(dir) : fromKnownLayouts(dir)
    if (hit) return hit
  }
  return ''
}

/**
 * 解析本机 ffmpeg：PATH → Remotion 安装目录 → 其它后端便携目录。
 * @returns {{ffmpeg:string, ffprobe:string, source:string}}
 * @throws 找不到时抛出带安装指引的错误（用户共识：报错 + 指引去装 Remotion，不自动下载）
 */
function resolveFfmpeg(force) {
  const now = Date.now()
  if (!force && ffmpegCache && now - ffmpegCache.at < 60000 && existsSync(ffmpegCache.ffmpeg)) {
    return ffmpegCache
  }
  const root = dataRoot()
  const candidates = [
    ['PATH', fromPath()],
  ]
  const remotionCfg = root ? readJson(join(root, 'remotion', 'config.json')) : null
  const remotionDir =
    remotionCfg && typeof remotionCfg.installDir === 'string' ? remotionCfg.installDir.trim() : ''
  if (remotionDir) candidates.push(['Remotion 安装目录', fromRemotion(remotionDir)])
  candidates.push(['本机已装后端的便携 ffmpeg', fromBackends(root)])
  for (const [source, ffmpeg] of candidates) {
    if (!ffmpeg || !existsSync(ffmpeg)) continue
    const sibling = join(dirname(ffmpeg), 'ffprobe' + EXE)
    ffmpegCache = { ffmpeg, ffprobe: existsSync(sibling) ? sibling : '', source, at: now }
    return ffmpegCache
  }
  throw new Error(NOT_FOUND_HINT)
}

/* ── 外部进程执行 ──────────────────────────────────────────────────────────── */

let ffmpegGate = Promise.resolve()

/** 串行闸：ffmpeg 一律排队跑（本机 CPU 有限，别让一条会话把整机拖死）。 */
function withFfmpegLock(fn) {
  const run = ffmpegGate.then(fn, fn)
  ffmpegGate = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

/**
 * 跑一次 ffmpeg（参数数组直传，不经 shell）。
 * @param {string[]} args
 * @param {{timeoutMs?:number, cwd?:string}} [opts]
 * @returns {Promise<{code:number|null, stdout:string, stderr:string}>}
 */
function runFfmpeg(args, opts = {}) {
  return withFfmpegLock(
    () =>
      new Promise((resolvePromise) => {
        const { ffmpeg } = resolveFfmpeg()
        const timeoutMs = Math.min(
          Math.max(Number(opts.timeoutMs) || FFMPEG_TIMEOUT_MS, 1000),
          FFMPEG_TIMEOUT_MAX_MS,
        )
        let out = ''
        let err = ''
        const child = spawn(ffmpeg, args, {
          windowsHide: true,
          cwd: opts.cwd || process.cwd(),
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        const timer = setTimeout(() => {
          try {
            child.kill()
          } catch {}
        }, timeoutMs)
        child.stdout.on('data', (d) => {
          out += d.toString()
          if (out.length > 200000) out = out.slice(-200000)
        })
        child.stderr.on('data', (d) => {
          err += d.toString()
          if (err.length > 200000) err = err.slice(-200000)
        })
        child.on('error', (e) => {
          clearTimeout(timer)
          resolvePromise({ code: -1, stdout: out, stderr: String((e && e.message) || e) })
        })
        child.on('close', (code) => {
          clearTimeout(timer)
          resolvePromise({ code, stdout: out, stderr: err })
        })
      }),
  )
}

/* ── 探测与切段 ────────────────────────────────────────────────────────────── */

function parseDuration(text) {
  const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(String(text || ''))
  if (!m) return 0
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
}

/** 用 ffmpeg 自身解出时长与流信息（不依赖 ffprobe）。 */
async function probeMedia(file) {
  const r = await runFfmpeg(['-hide_banner', '-nostdin', '-i', file], { timeoutMs: 30000 })
  const text = r.stderr + r.stdout
  return {
    durationSeconds: parseDuration(text),
    hasAudio: /Stream #\d+:\d+.*: Audio:/.test(text),
    hasVideo: /Stream #\d+:\d+.*: Video:/.test(text),
    summary: clip(
      text
        .split(/\r?\n/)
        .filter((l) => /Duration:|Stream #|Input #/.test(l))
        .join('\n'),
      2000,
    ),
  }
}

/**
 * 用 silencedetect 找出说话区间，拼成「句」：静音处断开，太长的按上限均分，太短的并入前句。
 * @param {number} duration
 * @param {Array<{start:number,end:number}>} silences
 * @param {{maxChunkSeconds?:number}} [opts] 单段上限秒数（默认 25；audio_subtitle 按 1.5 倍 maxDurationSec 传）
 */
function planSpeechSegments(duration, silences, opts = {}) {
  const out = []
  if (!(duration > 0)) return out
  const maxChunk = clampNum(opts.maxChunkSeconds, MIN_CHUNK_SECONDS, MAX_CHUNK_SECONDS, MAX_CHUNK_SECONDS)
  const sorted = silences
    .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start)
    .sort((a, b) => a.start - b.start)
  let cursor = 0
  const push = (start, end) => {
    if (end - start < MIN_SPEECH_SECONDS) return
    out.push({ start, end })
  }
  for (const s of sorted) {
    const start = Math.max(cursor, 0)
    const end = Math.min(s.start, duration)
    if (end > start) push(start, end)
    cursor = Math.max(cursor, s.end)
  }
  if (duration > cursor) push(cursor, duration)
  if (!out.length) out.push({ start: 0, end: duration })

  /* 过长的段按 maxChunk 均分（SenseVoice 单次音频有体积上限）。 */
  const split = []
  for (const seg of out) {
    const len = seg.end - seg.start
    if (len <= maxChunk) {
      split.push(seg)
      continue
    }
    const parts = Math.ceil(len / maxChunk)
    const step = len / parts
    for (let i = 0; i < parts; i++) {
      split.push({ start: seg.start + step * i, end: seg.start + step * (i + 1) })
    }
  }
  /* 过短的段（语气词、单字）只在「几乎贴着上一句」时并进去，避免字幕碎成一行一个字；
     真有一段静音隔开的短句仍保留自己的时间戳（否则整段字幕的时间轴会被拉平）。 */
  const merged = []
  for (const seg of split) {
    const prev = merged[merged.length - 1]
    if (
      prev &&
      seg.end - seg.start < MIN_CHUNK_SECONDS &&
      seg.start - prev.end <= 0.6 &&
      seg.end - prev.start <= maxChunk
    ) {
      prev.end = seg.end
      continue
    }
    merged.push({ ...seg })
  }
  return merged.map((s) => ({
    start: Math.round(s.start * 1000) / 1000,
    end: Math.round(s.end * 1000) / 1000,
  }))
}

async function detectSilences(file, opts = {}) {
  const noise = normalizeNoise(opts.noiseDb)
  const minSilence = clampNum(opts.minSilenceSec, 0.1, 3, SILENCE_MIN_SECONDS)
  const r = await runFfmpeg(
    [
      '-hide_banner',
      '-nostdin',
      '-i',
      file,
      '-vn',
      '-af',
      `silencedetect=noise=${noise}:d=${minSilence}`,
      '-f',
      'null',
      '-',
    ],
    { timeoutMs: FFMPEG_TIMEOUT_MAX_MS },
  )
  const text = r.stderr + r.stdout
  const silences = []
  let open = null
  for (const line of text.split(/\r?\n/)) {
    const s = /silence_start:\s*(-?\d+(?:\.\d+)?)/.exec(line)
    if (s) {
      open = Number(s[1])
      continue
    }
    const e = /silence_end:\s*(-?\d+(?:\.\d+)?)/.exec(line)
    if (e && open !== null) {
      silences.push({ start: Math.max(open, 0), end: Number(e[1]) })
      open = null
    }
  }
  return silences
}

/** 断言媒体文件可用（存在、是文件、大小上限）。 */
function checkMediaFile(file, allowLarge) {
  const p = String(file || '').trim()
  if (!p) throw new Error('缺少媒体文件路径（要给本机绝对路径）')
  if (!isAbsolute(p)) throw new Error('媒体路径必须是本机绝对路径：' + p)
  if (!existsSync(p)) throw new Error('文件不存在：' + p)
  let st = null
  try {
    st = statSync(p)
  } catch {
    throw new Error('无法读取文件：' + p)
  }
  if (!st.isFile()) throw new Error('不是文件：' + p)
  const limit = allowLarge ? Infinity : MAX_MEDIA_BYTES
  if (st.size > limit) {
    throw new Error(
      `文件 ${(st.size / 1024 / 1024).toFixed(1)}MB 超过单次上限 ${Math.round(limit / 1024 / 1024)}MB（可用 allowLarge:true 放宽）`,
    )
  }
  return { path: p, bytes: st.size, ext: extname(p).toLowerCase() }
}

/* ── 语音转写（官方本地 SenseVoice，运行时内的 ctx.speechToText）───────────── */

/**
 * 拿本地识别服务并等它就绪。
 * 首次使用要下权重（int8 约 239MB），这里会触发 prepare 并等它完成；
 * 下载源与进度由宿主界面负责展示（与录音听写同一份权重、同一份状态）。
 */
async function ensureSpeechReady(ctx, deadlineMs) {
  const stt = typeof ctx.get === 'function' ? ctx.get('speechToText') : null
  if (!stt) {
    throw new Error(
      '本轮没有注册本地语音识别（SenseVoice）。纯净模式 / 桌宠隔离态下语音服务是关闭的；' +
        '普通会话或智能节点里请重试，不要改用其它转写方案。',
    )
  }
  const snapshot = () => (typeof stt.snapshot === 'function' ? stt.snapshot() : { providers: [], selection: {} })
  const pick = (snap) => {
    const selection = (snap && snap.selection) || {}
    const providers = Array.isArray(snap && snap.providers) ? snap.providers : []
    return (
      providers.find((p) => p && p.id === selection.providerId) ||
      providers.find((p) => p && /sensevoice/i.test(String(p.id))) ||
      providers[0] ||
      null
    )
  }
  let view = pick(snapshot())
  if (!view) {
    throw new Error(
      '本地语音识别（SenseVoice）没有可用的识别器：语音服务未就绪。请不要另装 ASR；' +
        '先确认本轮不是纯净模式 / 桌宠隔离态，再重试。',
    )
  }
  const phase = (p) => String((p && p.preparation && p.preparation.phase) || 'unprepared')
  let ph = phase(view)
  if (ph === 'ready' || ph === 'standby') return { stt, providerId: String(view.id || '') }

  if (ph === 'unprepared' || ph === 'failed' || ph === 'cancelled') {
    try {
      stt.prepare(String(view.id || ''))
    } catch (err) {
      /* 「已有准备任务」之类的拒绝不算失败：下面照样轮询状态。 */
      if (!/prepare/i.test(String((err && err.message) || err))) throw err
    }
  }
  const started = Date.now()
  while (Date.now() - started < deadlineMs) {
    await sleep(700)
    view = pick(snapshot())
    if (!view) continue
    ph = phase(view)
    if (ph === 'ready' || ph === 'standby') return { stt, providerId: String(view.id || '') }
    if (ph === 'failed') {
      const msg = (view.preparation && view.preparation.message) || ''
      throw new Error('SenseVoice 模型准备失败：' + msg)
    }
  }
  throw new Error('SenseVoice 模型准备超时（首次使用需下载约 239MB 权重）。请稍后重试。')
}

/** 单片转写：音频必须是 16k 单声道 PCM16 WAV（官方契约），由调用方先切好。 */
async function transcribeWav(stt, providerId, wavPath, language, signal) {
  const bytes = new Uint8Array(readFileSync(wavPath))
  const req = { audio: bytes, language }
  if (providerId) req.providerId = providerId
  const spec = stt.resolve(req)
  return await stt.transcribe(spec, signal)
}

/* ── 字幕排版（audio_subtitle）：整句 → cue（断句 + 限长）→ SRT / VTT ───────────
   全部是纯函数：不碰进程、不写盘，smoke 里可以直接断言（见 dsh/smoke-subtitle.mjs）。
   时间分配口径（用户共识）：一句话被拆成多条 cue 时，按各自字数占比切时间轴。 */

const round3 = (n) => Math.round(Number(n) * 1000) / 1000

/** 这段文本是否按中文字幕口径算（CJK 占比超过 20%）。 */
function isCjkHeavy(text) {
  const chars = Array.from(String(text || '')).filter((c) => !/\s/.test(c))
  if (!chars.length) return false
  const cjk = chars.filter((c) => CJK_RE.test(c)).length
  return cjk / chars.length >= CJK_RATIO_FOR_CJK
}

/** 只去掉句末句号（用户共识：问号 / 感叹号 / 句中标点全部保留）。 */
function stripFinalPeriod(text) {
  return String(text == null ? '' : text)
    .replace(/[。.．]+$/u, '')
    .trim()
}

/** 按标点在「字符之后」断开，标点留在前一段里 —— 拼回去就是原文。 */
function splitAfterPunctuation(text, marks) {
  const set = new Set(Array.from(String(marks || '')))
  if (!set.size) return [String(text || '').trim()].filter(Boolean)
  const out = []
  let buf = ''
  for (const ch of String(text || '')) {
    buf += ch
    if (set.has(ch)) {
      out.push(buf)
      buf = ''
    }
  }
  if (buf.trim()) out.push(buf)
  return out.map((s) => s.trim()).filter(Boolean)
}

const charWeight = (s) => Math.max(Array.from(String(s || '')).length, 1)

/** 英文按词断、不拆单词（单个单词本身超长时才按字符硬切）。 */
function splitLatinWords(text, maxChars) {
  const words = String(text || '').split(/\s+/).filter(Boolean)
  const out = []
  let cur = ''
  for (const w of words) {
    const chars = Array.from(w)
    if (chars.length > maxChars) {
      if (cur) {
        out.push(cur)
        cur = ''
      }
      for (let i = 0; i < chars.length; i += maxChars) out.push(chars.slice(i, i + maxChars).join(''))
      continue
    }
    const next = cur ? cur + ' ' + w : w
    if (Array.from(next).length <= maxChars) cur = next
    else {
      if (cur) out.push(cur)
      cur = w
    }
  }
  if (cur) out.push(cur)
  return out
}

/** 单段超长时的硬切（中文按字、英文按词）。 */
function hardSplit(text, maxChars, latin) {
  const s = String(text || '').trim()
  if (!s) return []
  if (Array.from(s).length <= maxChars) return [s]
  if (latin) return splitLatinWords(s, maxChars).filter(Boolean)
  const chars = Array.from(s)
  const out = []
  for (let i = 0; i < chars.length; i += maxChars) out.push(chars.slice(i, i + maxChars).join(''))
  return out.map((x) => x.trim()).filter(Boolean)
}

/** 把已断好的片段按不超过 maxChars 打包成 cue 的文本。 */
function packPieces(pieces, maxChars) {
  const out = []
  let cur = ''
  for (const p of pieces) {
    const next = cur ? cur + p : p
    if (Array.from(next).length <= maxChars) cur = next
    else {
      if (cur) out.push(cur)
      cur = p
    }
  }
  if (cur) out.push(cur)
  return out.filter(Boolean)
}

/** 把一段文本按字数占比切成 k 份（英文尽量切在空格上，不撕单词）。 */
function splitTextByCount(text, k, latin) {
  const s = String(text || '').trim()
  const chars = Array.from(s)
  const n = Math.min(Math.max(1, Math.floor(k)), chars.length)
  if (n <= 1) return [s].filter(Boolean)
  const out = []
  let idx = 0
  for (let i = 0; i < n; i++) {
    const take = Math.max(1, Math.ceil((chars.length - idx) / (n - i)))
    let piece = chars.slice(idx, idx + take).join('')
    idx += take
    if (latin && idx < chars.length) {
      /* 切点落在单词中间就往回找最近的空格，把整个词留给下一段。 */
      const sp = piece.lastIndexOf(' ')
      if (sp > 0) {
        idx -= Array.from(piece.slice(sp + 1)).length
        piece = piece.slice(0, sp)
      }
    }
    const t = piece.trim()
    if (t) out.push(t)
  }
  return out
}

/**
 * 整句 → 字幕 cue。
 * @param {Array<{start:number,end:number,text:string}>} sentences 静音切句 + 转写结果
 * @param {{maxChars:number, latin:boolean, maxDurationSec:number, breakPunctuation:string}} opts
 * @returns {Array<{index:number,start:number,end:number,duration:number,text:string}>}
 */
function buildSubtitleCues(sentences, opts = {}) {
  const maxChars = clampNum(opts.maxChars, 4, 200, SUBTITLE_MAX_CHARS_CJK)
  const maxDuration = clampNum(opts.maxDurationSec, 1, 60, SUBTITLE_MAX_SECONDS)
  const latin = opts.latin === true
  const marks = String(opts.breakPunctuation == null ? SUBTITLE_BREAK_PUNCT : opts.breakPunctuation)

  const raw = []
  const pushRaw = (start, end, text) => {
    const t = String(text || '').trim()
    if (!t) return
    const s = round3(start)
    const e = Math.max(round3(end), round3(s + 0.05))
    raw.push({ start: s, end: e, text: t })
  }

  for (const seg of Array.isArray(sentences) ? sentences : []) {
    const start = Number(seg && seg.start)
    const end = Number(seg && seg.end)
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue
    const text = stripFinalPeriod(seg.text)
    if (!text) continue

    /* 先按标点断成片段，再把每个超长片段硬切，最后按 maxChars 打包。 */
    const pieces = []
    for (const p of splitAfterPunctuation(text, marks)) {
      if (Array.from(p).length > maxChars) pieces.push(...hardSplit(p, maxChars, latin))
      else pieces.push(p)
    }
    const groups = packPieces(pieces, maxChars)
    if (!groups.length) continue

    const weights = groups.map(charWeight)
    const totalW = weights.reduce((a, b) => a + b, 0) || 1
    const span = end - start
    let acc = 0
    for (let i = 0; i < groups.length; i++) {
      const from = i === 0 ? start : start + (span * acc) / totalW
      acc += weights[i]
      const to = i === groups.length - 1 ? end : start + (span * acc) / totalW
      pushRaw(from, to, groups[i])
    }
  }

  /* 单条超过 maxDurationSec 的再按时间拆开（文本按字数占比同步拆）。 */
  const cues = []
  const addCue = (c) => {
    const t = String(c.text || '').trim()
    if (!t) return
    const s = round3(c.start)
    const e = Math.max(round3(c.end), round3(s + 0.05))
    cues.push({ index: cues.length + 1, start: s, end: e, duration: round3(e - s), text: t })
  }
  for (const c of raw) {
    const span = c.end - c.start
    if (span <= maxDuration + 1e-6) {
      addCue(c)
      continue
    }
    const parts = splitTextByCount(c.text, Math.ceil(span / maxDuration), latin)
    const n = parts.length || 1
    for (let i = 0; i < n; i++) {
      const from = i === 0 ? c.start : c.start + (span * i) / n
      const to = i === n - 1 ? c.end : c.start + (span * (i + 1)) / n
      addCue({ start: from, end: to, text: parts[i] })
    }
  }
  return cues
}

/** 秒 → SRT 时间码（00:00:01,234）。 */
function srtTime(seconds) {
  const ms = Math.max(0, Math.round(Number(seconds) * 1000))
  const h = Math.floor(ms / 3600000)
  const m = Math.floor((ms % 3600000) / 60000)
  const s = Math.floor((ms % 60000) / 1000)
  const milli = ms % 1000
  const pad = (n, w = 2) => String(n).padStart(w, '0')
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(milli, 3)}`
}

/** 秒 → VTT 时间码（00:00:01.234）。 */
function vttTime(seconds) {
  return srtTime(seconds).replace(',', '.')
}

function formatSrt(cues) {
  return (Array.isArray(cues) ? cues : [])
    .map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}`)
    .join('\n\n')
}

function formatVtt(cues) {
  const body = (Array.isArray(cues) ? cues : [])
    .map((c) => `${vttTime(c.start)} --> ${vttTime(c.end)}\n${c.text}`)
    .join('\n\n')
  return 'WEBVTT\n\n' + body + (body ? '\n' : '')
}

/* ── 宿主识图通道（describe 用）：与 canvas-plugin 同一条桥 ────────────────── */

function createBridge() {
  const port = Number(process.env.MTNODE_BRIDGE_PORT || 0)
  let socket = null
  let buf = ''
  const pending = new Map()

  const send = (obj) => {
    if (socket && !socket.destroyed) {
      try {
        socket.write(JSON.stringify(obj) + '\n')
      } catch {
        /* 网关没了：在途请求由 close 统一收尾 */
      }
    }
  }

  const failAll = (err) => {
    for (const [id, p] of pending) {
      pending.delete(id)
      p.reject(err)
    }
  }

  const onLine = (line) => {
    let m
    try {
      m = JSON.parse(line)
    } catch {
      return
    }
    if (!m || typeof m.id !== 'string') return
    const p = pending.get(m.id)
    if (!p) return
    if (m.t === 'canvas-result') {
      pending.delete(m.id)
      if (m.ok === false) p.reject(new Error(String(m.error || 'vision failed')))
      else p.resolve(m.result == null ? { ok: true } : m.result)
    } else if (m.t === 'abort') {
      pending.delete(m.id)
      p.reject(new Error('vision aborted (task ended)'))
    }
  }

  const connect = () => {
    if (!Number.isInteger(port) || port <= 0) return
    const s = createConnection({ host: '127.0.0.1', port })
    socket = s
    s.on('data', (d) => {
      buf += d.toString()
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (line) onLine(line)
      }
    })
    s.on('error', () => {})
    s.on('close', () => {
      if (socket === s) socket = null
      failAll(new Error('bridge channel closed'))
      setTimeout(connect, 2000)
    })
  }
  connect()

  return {
    get ready() {
      return !!(socket && !socket.destroyed)
    },
    rpc(op, params, exec) {
      if (!socket || socket.destroyed) {
        return Promise.reject(new Error('桥通道不可用（这些工具只在 MTNode 应用内运行）'))
      }
      const id = randomUUID()
      const sessionId = exec && exec.agent ? String(exec.agent.id || '') : ''
      return new Promise((resolveFn, rejectFn) => {
        pending.set(id, { resolve: resolveFn, reject: rejectFn })
        send({ t: 'canvas', id, sessionId, op, params: params || {} })
        const onAbort = () => {
          if (!pending.has(id)) return
          pending.delete(id)
          send({ t: 'drop', id, sessionId })
          rejectFn(new Error('vision aborted'))
        }
        exec && exec.signal && exec.signal.addEventListener('abort', onAbort, { once: true })
      })
    },
  }
}

/* ── 路径护栏（任意 ffmpeg 参数用）────────────────────────────────────────── */

/** 可写根：本轮工作区 / MTNode 数据目录 / 系统临时目录。 */
function writeRoots() {
  const roots = [process.cwd(), tmpdir()]
  const root = dataRoot()
  if (root) roots.push(root)
  return roots.filter(Boolean)
}

function pathLike(arg) {
  const s = String(arg || '')
  if (!s) return false
  if (isAbsolute(s)) return true
  if (/^[A-Za-z]:[\\/]/.test(s)) return true
  return s.startsWith('./') || s.startsWith('.\\') || s.startsWith('../') || s.startsWith('..\\')
}

/** 显式输出路径的护栏：必须在可写根内；覆盖已有文件要显式 overwrite。 */
function requireWritablePath(p, overwrite, what) {
  const abs = resolve(String(p || ''))
  if (!writeRoots().some((r) => isUnder(r, abs))) {
    throw new Error(
      (what || '输出路径') +
        ' 不在可写范围：' +
        abs +
        '\n可写范围 = 本轮工作区 / MTNode 数据目录 / 系统临时目录。',
    )
  }
  if (existsSync(abs) && !overwrite) {
    throw new Error((what || '输出路径') + ' 已存在：' + abs + '（要覆盖请传 overwrite:true）')
  }
  return abs
}

/**
 * 校验「任意 ffmpeg 参数」：输出必须落在可写根内；工作区外的既有文件只当输入读。
 * 判据（用户共识的落地）：参数里每个像路径的实参，
 *   · 落在可写根内 → 放行；
 *   · 不在可写根内且文件已存在、且没有 -y → 当作输入读，放行；
 *   · 其余（要新建 / 要覆盖）→ 拒绝，并说明可写根。
 */
function guardFfmpegArgs(args, overwrite) {
  if (!Array.isArray(args) || !args.length) {
    throw new Error('args 必须是 ffmpeg 参数数组（不含 ffmpeg 本身），例如 ["-i","in.mp4","-vn","out.wav"]')
  }
  if (args.some((a) => typeof a !== 'string')) throw new Error('args 里每一项都必须是字符串')
  const roots = writeRoots()
  const allowsOverwrite = overwrite === true
  for (const a of args) {
    if (a.includes('\u0000')) throw new Error('参数里不允许出现 NUL 字符')
    if (!pathLike(a)) continue
    const p = isAbsolute(a) ? a : resolve(process.cwd(), a)
    const inside = roots.some((r) => isUnder(r, p))
    if (inside) continue
    const exists = existsSync(p)
    if (exists && !allowsOverwrite) continue
    throw new Error(
      'ffmpeg 参数里的这个路径不在可写范围：' +
        p +
        '\n可写范围 = 本轮工作区 / MTNode 数据目录 / 系统临时目录。' +
        '要写别处请先让用户把它作为项目工作目录，或把产物写在工作区里。',
    )
  }
  return args
}

/* ── 工具描述 ──────────────────────────────────────────────────────────────── */

const TRANSCRIBE_DESC = `把本地音频 / 视频里的说话内容转成文字（字幕、逐字稿、会议记录用这一个工具就够了）。

引擎固定是本机官方语音识别 SenseVoice（CPU、离线、与麦克风听写同一份权重，权重由 MTNode 自己管理）——
**不要**再去安装 whisper / Qwen-ASR / 在线 ASR，也不要为此写 Python 脚本。

它做的事：
- 输入可以是音频（wav / mp3 / m4a / flac / aac …）或视频（mp4 / mkv / mov …；视频会自动抽音轨，不需要你另外转码）。
- 内部用 ffmpeg 按静音区间切句，逐句识别，再把句子拼成一条时间轴（段起点 / 终点 = 近似时间戳，切片级精度，不是逐字对齐）。
- 返回 JSON：{ text, durationSeconds, segments:[{start,end,text}], engine, chunks, ... }。
- 长音频会自动切片并拼接，调用方只给一个文件；单文件上限 2 小时 / 1GB（可用 allowLarge 放宽）。

要 SRT / VTT 就直接用 audio_subtitle（它给现成的字幕条与两份字幕文本）；只要逐字稿用本工具即可。

限制与失败情形：
- 依赖本机 ffmpeg（Remotion 安装时自带；缺失时工具会提示去插件里装 Remotion）。
- 首次使用要下载 SenseVoice 权重（约 239MB），这一次调用会等到就绪（可能几分钟）。
- 视频画面内容不在这里：要看画面请用 ffmpeg 工具的 describe 动作。`

const SUBTITLE_DESC = `把一段音频 / 视频转成「能直接做字幕」的结构化文本：每条字幕的起止时间 + 正文，外加整份 SRT 与 VTT 文本。

引擎与 audio_transcribe 同一台本机官方 SenseVoice（CPU、离线、同一份权重）——
**不要**另装 whisper / 在线 ASR，也不要为此写 Python 脚本。
差别只在切句之后：它按标点、每行字数与单条最长秒数把整句排版成字幕条（cue），时间按各条字数占比分配。
时间边界来自 ffmpeg 静音切句，是切片级近似（不是逐字对齐），用于字幕足够。

返回 JSON：{ ok, engine, file, durationSeconds, language, cueCount, cues:[{index,start,end,duration,text}], params, ... }。
srt / vtt 两份完整文本另以两段文本回（不塞进 JSON，避免超长被截断）。
**本工具不写任何文件**：要存成 .srt / .vtt，把返回的文本自己写进文件（写文件工具有护栏，别写系统目录）。
整段没有语音时返回空 cues 与空字幕文本，并在 note 里说明，不报错。

参数（都可省略，省略即下列默认值）：
- language：语言提示，默认 auto。
- maxDurationSec：单条字幕最长秒数，默认 6；超过就拆成多条。
- maxChars：单条字幕最大字数，默认按识别文本自动选（中文 18 / 英文 42）。
- noiseDb：静音阈值，默认 -35dB；嘈杂素材调高（如 -25），安静素材可调低。
- minSilenceSec：最小静音间隔，默认 0.4 秒；语速慢可调大。
- breakPunctuation：断句标点集合，默认 "。！？!?；;…，,、"；传空串 = 只按字数与时长拆。
- allowLarge：放宽 2 小时 / 1GB 上限。`

const FFMPEG_DESC = `本机 ffmpeg（直接调用，参数数组直传，不经 shell）。

优先级最高的两个日常用法先用固定动作，别自己拼参数：
- action:"probe"：看一个媒体文件的时长 / 有没有音轨视频轨 / 流信息。
- action:"extract_audio"：把音轨抽成 16 kHz 单声道 WAV（SenseVoice 与多数语音链路要的格式），返回输出路径。
- action:"frames"：按时间点抽帧成 PNG（默认宽 1280，最多 12 张），返回图片绝对路径 —— 需要「看懂画面」时用它。
- action:"describe"：抽帧 + 转调宿主识图通道（与 mtnode_vision 同一条视觉路由与许可），一次返回每个时间点的画面描述。这是「分析视频内容」的首选入口。
- action:"run"：任意 ffmpeg 参数（转码 / 裁切 / 拼接 / 变速 / 加字幕 / 压制等），args 是数组，例如 ["-i","in.mp4","-vf","scale=1280:-2","-c:v","libx264","out.mp4"]。

护栏（会被拒绝的情形）：
- 输出路径必须落在可写范围：本轮工作区 / MTNode 数据目录 / 系统临时目录。工作区外的既有文件只当输入读。
- 不默认加 -y：要覆盖已有文件须显式 overwrite:true。
- 单次执行默认 120 秒超时（timeoutSec 可放宽到 600），ffmpeg 串行排队执行。

ffmpeg 从哪来：系统 PATH → Remotion 安装目录（安装 Remotion 时会一并装下它自带的 ffmpeg）→
其它本地后端的便携 ffmpeg；都没有就报错并提示去插件里安装 Remotion，不要自己下载别的转码方案。`

/* ── 插件入口 ──────────────────────────────────────────────────────────────── */

export function apply(ctx) {
  const bridge = createBridge()
  let tempSeq = 0

  /* 临时工作目录（切片 / 抽帧）：放系统临时目录，调用结束就清掉切片音频。 */
  function tempDir(tag) {
    const base = join(tmpdir(), 'mtnode-media')
    const dir = join(base, `${tag}-${process.pid}-${Date.now()}-${tempSeq++}`)
    mkdirSync(dir, { recursive: true })
    return dir
  }

  /**
   * 一条媒体的完整转写链（audio_transcribe 与 audio_subtitle 共用）：
   * 校验 → 探测 → 静音切句 → 逐片转成 16k WAV → SenseVoice。
   * 返回的 segments 是「静音切句」级别的整句，字幕排版由 audio_subtitle 另做。
   * @returns {Promise<{media:object, probe:object, plan:Array, segments:Array, inferenceSeconds:number, language:string, ffmpegSource:string}>}
   */
  async function transcribeMedia(args, exec) {
    const a = args || {}
    const language = LANGUAGE_ENUM.includes(a.language) ? a.language : 'auto'
    const media = checkMediaFile(a.file, a.allowLarge === true)
    const { source: ffmpegSource } = resolveFfmpeg()

    const probe = await probeMedia(media.path)
    if (!probe.hasAudio) throw new Error('这个文件里没有音轨，无法转写：' + media.path)
    if (!(probe.durationSeconds > 0)) {
      throw new Error('读不到媒体时长（文件可能损坏或容器不受支持）：' + media.path)
    }
    if (!a.allowLarge && probe.durationSeconds > MAX_MEDIA_SECONDS) {
      throw new Error(
        `时长 ${Math.round(probe.durationSeconds)} 秒超过单次上限 ${MAX_MEDIA_SECONDS} 秒（约 2 小时）；` +
          '可先用 ffmpeg 工具的 run 动作截取区间，或传 allowLarge:true。',
      )
    }

    const { stt, providerId } = await ensureSpeechReady(ctx, 15 * 60 * 1000)
    const plan = planSpeechSegments(
      probe.durationSeconds,
      await detectSilences(media.path, { noiseDb: a.noiseDb, minSilenceSec: a.minSilenceSec }),
      { maxChunkSeconds: a.maxChunkSeconds },
    )
    if (!plan.length) throw new Error('没有识别到可切分的说话区间：' + media.path)

    const dir = tempDir('asr')
    const segments = []
    let inferenceSeconds = 0
    try {
      for (let i = 0; i < plan.length; i++) {
        const seg = plan[i]
        const wav = join(dir, `seg-${String(i).padStart(4, '0')}.wav`)
        const cut = await runFfmpeg(
          [
            '-hide_banner',
            '-nostdin',
            '-y',
            '-ss',
            String(seg.start),
            '-to',
            String(seg.end),
            '-i',
            media.path,
            '-vn',
            '-ac',
            '1',
            '-ar',
            '16000',
            '-c:a',
            'pcm_s16le',
            wav,
          ],
          { timeoutMs: FFMPEG_TIMEOUT_MS },
        )
        if (cut.code !== 0 || !existsSync(wav)) {
          throw new Error('切片失败（' + seg.start + 's–' + seg.end + 's）：' + clip(cut.stderr, 600))
        }
        let out = null
        try {
          out = await transcribeWav(stt, providerId, wav, language, exec && exec.signal)
        } finally {
          try {
            rmSync(wav, { force: true })
          } catch {}
        }
        const text = String((out && out.text) || '').trim()
        inferenceSeconds += Number((out && out.inferenceSeconds) || 0)
        if (!text) continue
        segments.push({ start: seg.start, end: seg.end, text })
      }
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {}
    }

    return { media, probe, plan, segments, inferenceSeconds, language, ffmpegSource }
  }

  /* 按运行裁剪：本轮被「音频转写」（media_asr）拒掉时整只不注册（名单真源
     tool-visibility.mjs，判据在渲染层 agentDeniedToolNames）。 */
  if (!isToolHidden('audio_transcribe'))
    ctx.tools.register(
    defineTool({
      name: 'audio_transcribe',
      description: TRANSCRIBE_DESC,
      parameters: {
        file: {
          type: 'string',
          required: true,
          description: '要转写的媒体文件绝对路径（音频或视频；视频会自动抽音轨）。',
        },
        language: {
          type: 'string',
          enum: LANGUAGE_ENUM,
          description: '语言提示，默认 auto（自动判断）。中文 / 英文 / 粤语 / 日语 / 韩语可选。',
        },
        allowLarge: {
          type: 'boolean',
          description: '放宽单文件上限（默认 2 小时 / 1GB，开启后不限）。长文件会更慢。',
        },
      },
      timeoutMs: 1800000,
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => jsonResult(value),
      },
      async execute(args, exec) {
        const r = await transcribeMedia(args, exec)
        const { media, probe, plan, segments, inferenceSeconds, language, ffmpegSource } = r

        return {
          ok: true,
          engine: 'sensevoice-local',
          ffmpegSource,
          file: media.path,
          durationSeconds: Math.round(probe.durationSeconds * 1000) / 1000,
          language,
          chunks: plan.length,
          inferenceSeconds: Math.round(inferenceSeconds * 1000) / 1000,
          text: segments.map((s) => s.text).join('\n'),
          segments,
          ...(segments.length
            ? {}
            : { note: '这一段里没有识别到语音（可能是纯音乐 / 静音，或语言不受支持）。' }),
          hint:
            '时间戳是切片级近似值。要做字幕（含 SRT / VTT 文本）请用 audio_subtitle；' +
            '要看画面用 ffmpeg 工具的 describe 动作。',
        }
      },
    }),
  )

  /* 字幕工具与 audio_transcribe 同属「音频转写」（media_asr）许可位，但各自独立判隐藏：
     裁剪名单可以只摘其中一个（见 tool-visibility.mjs）。 */
  if (!isToolHidden('audio_subtitle'))
    ctx.tools.register(
    defineTool({
      name: 'audio_subtitle',
      description: SUBTITLE_DESC,
      parameters: {
        file: {
          type: 'string',
          required: true,
          description: '要转写字幕的媒体文件绝对路径（音频或视频；视频会自动抽音轨）。',
        },
        language: {
          type: 'string',
          enum: LANGUAGE_ENUM,
          description: '语言提示，默认 auto（自动判断）。中文 / 英文 / 粤语 / 日语 / 韩语可选。',
        },
        maxDurationSec: {
          type: 'number',
          description: `单条字幕最长秒数，默认 ${SUBTITLE_MAX_SECONDS}（可 1–60）；超过就拆成多条。`,
        },
        maxChars: {
          type: 'number',
          description: `单条字幕最大字数，默认按识别文本自动选（中文 ${SUBTITLE_MAX_CHARS_CJK} / 英文 ${SUBTITLE_MAX_CHARS_LATIN}）；可 4–200。`,
        },
        noiseDb: {
          type: 'string',
          description: `静音判定阈值（dB），默认 ${SILENCE_NOISE}；收 -35 或 "-35dB" 两种写法。嘈杂素材调高（如 -25），安静素材可调低。`,
        },
        minSilenceSec: {
          type: 'number',
          description: `最小静音间隔秒数，默认 ${SILENCE_MIN_SECONDS}（可 0.1–3）；语速慢可调大。`,
        },
        breakPunctuation: {
          type: 'string',
          description: `断句标点集合，默认 "${SUBTITLE_BREAK_PUNCT}"；传空串 = 不按标点断，只按字数与时长拆。`,
        },
        allowLarge: {
          type: 'boolean',
          description: '放宽单文件上限（默认 2 小时 / 1GB，开启后不限）。长文件会更慢。',
        },
      },
      timeoutMs: 1800000,
      output: {
        schema: { type: 'object', additionalProperties: true },
        /* cues 与两份字幕文本分开回：整份 JSON 一次塞会撞上返回预算被截断，截断后就不再是合法 JSON。 */
        render: (_args, value) => {
          const v = value && typeof value === 'object' ? { ...value } : { value }
          const srt = String(v.srt || '')
          const vtt = String(v.vtt || '')
          delete v.srt
          delete v.vtt
          const parts = [{ type: 'text', text: clip(JSON.stringify(v), 20000) }]
          if (srt) parts.push({ type: 'text', text: '--- SRT ---\n' + clip(srt, 20000) })
          if (vtt) parts.push({ type: 'text', text: '--- VTT ---\n' + clip(vtt, 20000) })
          return parts
        },
      },
      async execute(args, exec) {
        const a = args || {}
        const r = await transcribeMedia(
          {
            file: a.file,
            language: a.language,
            allowLarge: a.allowLarge,
            noiseDb: a.noiseDb,
            minSilenceSec: a.minSilenceSec,
            /* 整句上限跟着单条字幕时长走，避免先被 25 秒切碎再排版。 */
            maxChunkSeconds: clampNum(a.maxDurationSec, 1, 60, SUBTITLE_MAX_SECONDS) * 1.5,
          },
          exec,
        )
        const { media, probe, segments, inferenceSeconds, language, ffmpegSource } = r
        const joined = segments.map((s) => s.text).join('')
        const latin = !isCjkHeavy(joined)
        const maxDurationSec = clampNum(a.maxDurationSec, 1, 60, SUBTITLE_MAX_SECONDS)
        const maxChars = clampNum(
          a.maxChars,
          4,
          200,
          latin ? SUBTITLE_MAX_CHARS_LATIN : SUBTITLE_MAX_CHARS_CJK,
        )
        const breakPunctuation =
          a.breakPunctuation == null ? SUBTITLE_BREAK_PUNCT : String(a.breakPunctuation)
        const cues = buildSubtitleCues(segments, { maxChars, latin, maxDurationSec, breakPunctuation })

        return {
          ok: true,
          engine: 'sensevoice-local',
          ffmpegSource,
          file: media.path,
          durationSeconds: Math.round(probe.durationSeconds * 1000) / 1000,
          language,
          cueCount: cues.length,
          cues,
          params: {
            maxDurationSec,
            maxChars,
            latin,
            noiseDb: normalizeNoise(a.noiseDb),
            minSilenceSec: clampNum(a.minSilenceSec, 0.1, 3, SILENCE_MIN_SECONDS),
            breakPunctuation,
          },
          srt: formatSrt(cues),
          vtt: formatVtt(cues),
          inferenceSeconds: Math.round(inferenceSeconds * 1000) / 1000,
          ...(cues.length
            ? {}
            : { note: '这一段里没有识别到语音（可能是纯音乐 / 静音，或语言不受支持），cues 与字幕文本都是空的。' }),
          hint:
            '时间边界是切片级近似值（静音切句 + 按字数占比分配），不是逐字对齐。' +
            '本工具不写文件：要 .srt / .vtt 就把 srt / vtt 文本自己写进文件。',
        }
      },
    }),
  )

  if (!isToolHidden('ffmpeg'))
    ctx.tools.register(
    defineTool({
      name: 'ffmpeg',
      description: FFMPEG_DESC,
      parameters: {
        action: {
          type: 'string',
          required: true,
          enum: ['run', 'probe', 'extract_audio', 'frames', 'describe'],
          description:
            'run = 任意参数；probe = 探测；extract_audio = 抽音轨为 16k WAV；frames = 抽帧 PNG；describe = 抽帧 + 识图并返回画面描述。',
        },
        args: {
          type: 'array',
          items: { type: 'string' },
          description: 'action:"run" 时必填：ffmpeg 参数数组（不含 ffmpeg 本身）。',
        },
        input: {
          type: 'string',
          description: 'probe / extract_audio / frames / describe 的输入媒体文件绝对路径。',
        },
        outputPath: {
          type: 'string',
          description:
            'extract_audio 的输出 .wav 路径（省略则写系统临时目录）；frames / describe 的输出目录（省略则写系统临时目录）。',
        },
        times: {
          type: 'array',
          items: { type: 'number' },
          description: 'frames / describe 的抽帧时间点（秒）。省略则按 count 均匀抽。',
        },
        count: {
          type: 'number',
          description: `describe 均匀抽帧数，默认 ${DESCRIBE_DEFAULT_FRAMES}，上限 ${DESCRIBE_MAX_FRAMES}。`,
        },
        question: {
          type: 'string',
          description: 'describe 时要问识图模型的问题（例如「画面里有哪些人、在做什么、字幕写了什么」）。',
        },
        width: {
          type: 'number',
          description: `frames / describe 的单帧宽度，默认 ${FRAME_MAX_WIDTH}（上限同值）。`,
        },
        timeoutSec: {
          type: 'number',
          description: 'action:"run" 的超时秒数，默认 120，上限 600。',
        },
        overwrite: {
          type: 'boolean',
          description: '允许覆盖已有文件（会加 -y）。默认 false。',
        },
        allowLarge: {
          type: 'boolean',
          description: 'extract_audio 时放宽单文件上限（默认 2 小时 / 1GB）。',
        },
      },
      timeoutMs: 1200000,
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => jsonResult(value),
      },
      async execute(args, exec) {
        const a = args || {}
        const action = String(a.action || 'run')
        const { ffmpeg, ffprobe, source } = resolveFfmpeg()

        if (action === 'run') {
          const list = guardFfmpegArgs(a.args, a.overwrite === true)
          const finalArgs = a.overwrite === true && !list.includes('-y') ? ['-y', ...list] : list
          const r = await runFfmpeg(finalArgs, {
            timeoutMs: Math.min(Math.max(Number(a.timeoutSec) || 120, 1), 600) * 1000,
          })
          const ok = r.code === 0
          return {
            ok,
            exitCode: r.code,
            ffmpeg,
            ffmpegSource: source,
            command: 'ffmpeg ' + finalArgs.join(' '),
            ...(ok ? {} : { error: 'ffmpeg 退出码 ' + r.code }),
            stdout: clip(r.stdout, FFMPEG_OUTPUT_TAIL),
            stderr: clip(r.stderr, FFMPEG_OUTPUT_TAIL),
          }
        }

        if (action === 'probe') {
          const media = checkMediaFile(a.input, true)
          const probe = await probeMedia(media.path)
          return {
            ok: true,
            file: media.path,
            bytes: media.bytes,
            ffmpeg,
            ffmpegSource: source,
            ffprobe: ffprobe || '',
            ...probe,
          }
        }

        if (action === 'extract_audio') {
          const media = checkMediaFile(a.input, a.allowLarge === true)
          const out = String(a.outputPath || '').trim()
            ? requireWritablePath(a.outputPath, a.overwrite === true, 'outputPath')
            : join(tempDir('audio'), 'audio.wav')
          mkdirSync(dirname(out), { recursive: true })
          const r = await runFfmpeg(
            [
              '-hide_banner',
              '-nostdin',
              '-y',
              '-i',
              media.path,
              '-vn',
              '-ac',
              '1',
              '-ar',
              '16000',
              '-c:a',
              'pcm_s16le',
              out,
            ],
            { timeoutMs: FFMPEG_TIMEOUT_MAX_MS },
          )
          if (r.code !== 0 || !existsSync(out)) {
            throw new Error('抽音轨失败：' + clip(r.stderr, 800))
          }
          const st = statSync(out)
          return {
            ok: true,
            file: media.path,
            outputPath: out,
            bytes: st.size,
            sampleRate: 16000,
            channels: 1,
            hint: '这是一个 16 kHz 单声道 WAV，可直接交给 audio_transcribe 或其它语音链路。',
          }
        }

        /* frames / describe 共用：抽帧。 */
        const media = checkMediaFile(a.input, true)
        const probe = await probeMedia(media.path)
        if (!probe.hasVideo) throw new Error('这个文件里没有视频轨，抽不了帧：' + media.path)
        const width = Math.min(Math.max(Math.round(Number(a.width) || FRAME_MAX_WIDTH), 128), FRAME_MAX_WIDTH)
        let times = Array.isArray(a.times)
          ? a.times.map((t) => Number(t)).filter((t) => Number.isFinite(t) && t >= 0)
          : []
        times = times.slice(0, DESCRIBE_MAX_FRAMES)
        if (!times.length) {
          const n = Math.min(
            Math.max(Math.round(Number(a.count) || DESCRIBE_DEFAULT_FRAMES), 1),
            DESCRIBE_MAX_FRAMES,
          )
          const dur = probe.durationSeconds || 0
          if (!dur) throw new Error('读不到视频时长，无法均匀抽帧；请改传 times。')
          for (let i = 0; i < n; i++) times.push(Math.min((dur * (i + 0.5)) / n, Math.max(dur - 0.05, 0)))
        }
        const dir = String(a.outputPath || '').trim()
          ? requireWritablePath(a.outputPath, true, 'outputPath')
          : tempDir('frames')
        mkdirSync(dir, { recursive: true })
        const frames = []
        for (let i = 0; i < times.length; i++) {
          const t = times[i]
          const path = join(dir, `frame-${String(i).padStart(2, '0')}-${t.toFixed(2)}s.png`)
          const r = await runFfmpeg(
            [
              '-hide_banner',
              '-nostdin',
              '-y',
              '-ss',
              String(t),
              '-i',
              media.path,
              '-frames:v',
              '1',
              '-vf',
              `scale='min(${width},iw)':-2`,
              path,
            ],
            { timeoutMs: FFMPEG_TIMEOUT_MS },
          )
          if (r.code !== 0 || !existsSync(path)) continue
          frames.push({ time: Math.round(t * 1000) / 1000, path })
        }
        if (!frames.length) throw new Error('抽帧失败：一个时间点都没取到图（文件可能损坏或无关键帧）')

        if (action === 'frames') {
          return {
            ok: true,
            file: media.path,
            durationSeconds: probe.durationSeconds,
            outputDir: dir,
            width,
            frames,
            hint: '需要看懂画面时，把这些 path 交给识图（或直接用 describe 动作一次拿到描述）。',
          }
        }

        /* describe：逐帧走宿主识图通道（与 mtnode_vision 同一份视觉路由与许可）。 */
        if (!bridge.ready) throw new Error('桥通道不可用（这些工具只在 MTNode 应用内运行）')
        const question =
          String(a.question || '').trim() ||
          '描述这一帧画面：有哪些主体、在做什么、场景与镜头景别、画面里可见的文字（字幕 / 标题 / UI）。只写看得到的内容。'
        const results = []
        const failures = []
        for (const f of frames) {
          try {
            const r = await bridge.rpc('vision', { imagePath: f.path, question }, exec)
            if (r && r.ok === false) {
              failures.push({ time: f.time, path: f.path, error: String(r.error || '识图失败') })
              continue
            }
            results.push({
              time: f.time,
              path: f.path,
              description: String((r && (r.answer || r.text)) || '').trim(),
            })
          } catch (err) {
            failures.push({ time: f.time, path: f.path, error: String((err && err.message) || err) })
          }
        }
        if (!results.length) {
          throw new Error(
            '识图全部失败：' +
              (failures.map((x) => x.time + 's → ' + x.error).join('；') || '未知原因') +
              '\n图片已抽好，可把 frames 里的路径交给 mtnode_vision 或让用户检查识图许可 / 视觉模型设置。',
          )
        }
        return {
          ok: true,
          file: media.path,
          durationSeconds: probe.durationSeconds,
          question,
          frames: results,
          ...(failures.length ? { failures } : {}),
          hint: '这些是抽帧级观察（时间点步长较大）。要更细的画面或某个具体时间点，传 times 再调一次。',
        }
      },
    }),
  )
}

/* 冒烟测试入口（dsh/smoke-media.mjs、dsh/smoke-subtitle.mjs）：只导出纯函数与解析器，不改变插件行为。 */
export const __internals = {
  planSpeechSegments,
  buildSubtitleCues,
  formatSrt,
  formatVtt,
  srtTime,
  vttTime,
  isCjkHeavy,
  stripFinalPeriod,
  splitAfterPunctuation,
  normalizeNoise,
  guardFfmpegArgs,
  resolveFfmpeg,
  parseDuration,
  writeRoots,
  MAX_CHUNK_SECONDS,
  DESCRIBE_MAX_FRAMES,
  SUBTITLE_MAX_SECONDS,
  SUBTITLE_MAX_CHARS_CJK,
  SUBTITLE_MAX_CHARS_LATIN,
}
