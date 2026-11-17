#!/usr/bin/env node
/**
 * verify-sync.mjs —— 成片音画同步 QA（纯 node + ffmpeg / ffprobe，不装任何依赖）
 *
 * 为什么要有这个脚本：「合片后音画对不对得上」不能靠肉眼看，也不能只信 ffprobe 报的
 * start_time —— 容器里的 start_time 是**声明**，观众听到的偏移还取决于 edit list
 * 有没有真的把 AAC 的编码器 priming 补掉（Typical 1024 样本 ≈ 21.3 ms：mux 时丢了 elst
 * 就是整条音轨晚 21 ms，而 ffprobe 的 start_time 依旧是 0.000）。
 *
 * 所以这里用**两路独立测量**去核对：
 *   ① 画面：按原生帧时间戳逐帧抽亮度（ffmpeg → rawvideo gray 走管道，showinfo 给 pts_time），
 *      找「闪拍帧」的上升沿；上升沿在相邻两帧之间做线性插值，得到亚帧精度（误差 < 半帧）。
 *   ② 声音：把音轨解成一份 **canonical WAV**，然后**只读这份 WAV** 找点击的起跳样本
 *      （起跳点同样在相邻两样本之间插值，精度约 0.02 ms）。
 *   两路各自独立，谁都不能「借」对方的时间，配对后的差值才是真偏差。
 *
 * 判定口径：容差 = 半帧 + 10 ms（30 fps → 16.67 + 10 = 26.67 ms）。
 *   半帧 = 闪拍上升沿插值的理论不确定度；10 ms 是给人耳/人眼留的余量。
 *   任何一对的 |偏差| 超过容差 → FAIL（非零退出）。
 *
 * canonical WAV 是硬约束的一部分：**分析用的 PCM 与合片用的必须是同一份文件**。
 *   脚本先把音轨解成 48 kHz / 立体声 / pcm_s16le（+bitexact，同输入必得同字节），
 *   点击检测读的就是这个文件；文件名固定 `<成片名>.canonical.wav`，旁边写一份
 *   `<....wav>.json` 记 sha256 / 源文件 size+mtime / ffmpeg 版本 —— mux 侧把这份 WAV
 *   当唯一音源、复测时比对 sha256，就能证明「分析的是它、合进去的也是它」。
 *
 * 用法：
 *   node scripts/verify-sync.mjs <成片.mp4>
 *   node scripts/verify-sync.mjs out.mp4 --wav=D:\proj\qa\out.canonical.wav --json=report.json
 *   node scripts/verify-sync.mjs out.mp4 --fps=30 --match-window=400 --expect=8
 *   node scripts/verify-sync.mjs out.mp4 -v
 *
 * 选项：
 *   --wav=<path>            canonical WAV 落盘位置（默认与成片同目录、同名 .canonical.wav）
 *   --json=<path>           报告 JSON（默认与成片同目录、同名 .verify-sync.json）
 *   --fps=<n>               覆盖帧率（默认读 ffprobe 的 avg_frame_rate / r_frame_rate）
 *   --click-threshold=<0..1> 点击门限（相对全局峰值，默认 0.25）
 *   --click-separation=<ms> 两个点击的最小间隔，默认 30 ms
 *   --flash-threshold=<0..1> 闪拍门限在「基线→最亮」之间的位置，默认 0.5
 *   --flash-min-contrast=<0..1> 基线到最亮的覆盖率差小于它视为「没有闪拍」，默认 0.15
 *   --match-window=<ms>     闪拍与点击配对的最大间隔，默认 400 ms
 *   --expect=<n>            期望的同步点个数，配对数少于它判失败
 *   --timeout=<sec>         单次 ffmpeg / ffprobe 超时，默认 900
 *   --no-overwrite          已存在 canonical WAV 时拒绝覆盖
 *   -v / --verbose          打印 ffmpeg / ffprobe 的原始输出与每帧覆盖率
 *
 * 退出码：0 = PASS · 1 = FAIL（超出容差 / 找不到同步点）· 2 = ERROR（参数、缺文件、缺 ffmpeg）
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'

const argv = process.argv.slice(2)
const getOpt = (name, dflt = '') => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : dflt
}
const hasFlag = (name) => argv.includes(`--${name}`)
const num = (v, dflt) => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : dflt
}

const INPUT = argv.find((a) => !a.startsWith('-')) || ''
const OPT = {
  wav: getOpt('wav'),
  json: getOpt('json'),
  fps: num(getOpt('fps'), 0),
  clickThreshold: Math.min(1, Math.max(0.001, num(getOpt('click-threshold'), 0.25))),
  clickSeparationMs: num(getOpt('click-separation'), 30),
  flashThreshold: Math.min(1, Math.max(0.05, num(getOpt('flash-threshold'), 0.5))),
  flashMinContrast: Math.min(1, Math.max(0.01, num(getOpt('flash-min-contrast'), 0.15))),
  matchWindowMs: num(getOpt('match-window'), 400),
  expect: num(getOpt('expect'), 0),
  timeoutSec: Math.max(30, num(getOpt('timeout'), 900)),
  frameSize: 64,
  verbose: hasFlag('verbose') || hasFlag('v'),
  overwrite: !hasFlag('no-overwrite'),
}

/* 亮度抽帧用的固定尺寸：只要平均亮度与「接近全白」的占比，64×64 够用且与画面比例无关 */
const FRAME_SIZE = OPT.frameSize
const FRAME_BYTES = FRAME_SIZE * FRAME_SIZE
const BRIGHT_LUMA = 235            // 视为「闪白」的亮度下限
const WAV_RATE = 48000
const WAV_CHANNELS = 2
const WAV_CODEC = 'pcm_s16le'
const AAC_PRIMING_SAMPLES = [1024, 2048]

function usage() {
  const txt = fs.readFileSync(new URL(import.meta.url), 'utf8')
  const m = /\*\*\n([\s\S]*?)\n \*\//.exec(txt)
  const body = m ? m[1].replace(/^ \* ?/gm, '') : 'verify-sync：成片音画同步 QA'
  process.stdout.write(body + '\n')
}

/* ── 小工具 ──────────────────────────────────────────────────────────────── */

const isFile = (p) => {
  try {
    return !!p && fs.statSync(p).isFile()
  } catch (_) {
    return false
  }
}
const isDir = (p) => {
  try {
    return !!p && fs.statSync(p).isDirectory()
  } catch (_) {
    return false
  }
}
const readJson = (p) => {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch (_) {
    return null
  }
}
const fix = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '—')
const dbOf = (v) => (Number.isFinite(v) && v > 0 ? (20 * Math.log10(v)).toFixed(1) : '—')
const tail = (s, n = 6) => String(s || '').trim().split(/\r?\n/).filter(Boolean).slice(-n).join(' | ')

function sha256File(file) {
  const h = crypto.createHash('sha256')
  const fd = fs.openSync(file, 'r')
  try {
    const buf = Buffer.allocUnsafe(1 << 20)
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null)
      if (!n) break
      h.update(buf.subarray(0, n))
    }
  } finally {
    fs.closeSync(fd)
  }
  return h.digest('hex')
}

/* ── ffmpeg / ffprobe 查找：与应用内同一条顺序（PATH → Remotion → 已装后端） ── */

const EXE = process.platform === 'win32' ? '.exe' : ''

function dataRoot() {
  if (process.env.MTNODE_DATA_DIR) return process.env.MTNODE_DATA_DIR
  if (process.platform === 'win32' && process.env.APPDATA) {
    return path.join(process.env.APPDATA, 'pipeline-console')
  }
  if (process.platform === 'darwin') {
    return path.join(process.env.HOME || '', 'Library', 'Application Support', 'pipeline-console')
  }
  return path.join(process.env.HOME || '', '.config', 'pipeline-console')
}

function fromPath(name) {
  const cmd = process.platform === 'win32' ? 'where' : 'which'
  const r = spawnSync(cmd, [name], { windowsHide: true, encoding: 'utf8' })
  if (r.status !== 0) return ''
  const line = String(r.stdout || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)[0]
  return isFile(line) ? line : ''
}

function fromLayout(dir) {
  const cands = [
    path.join(dir, 'ffmpeg' + EXE),
    path.join(dir, 'bin', 'ffmpeg' + EXE),
    path.join(dir, 'tools', 'ffmpeg', 'ffmpeg' + EXE),
    path.join(dir, 'tools', 'ffmpeg', 'bin', 'ffmpeg' + EXE),
  ]
  for (const c of cands) if (isFile(c)) return c
  return ''
}

function fromRemotion(dir) {
  const known = fromLayout(dir)
  if (known) return known
  const base = path.join(dir, 'node_modules', '@remotion')
  if (!isDir(base)) return ''
  let entries = []
  try {
    entries = fs.readdirSync(base, { withFileTypes: true })
  } catch (_) {
    return ''
  }
  for (const ent of entries) {
    if (!ent.isDirectory() || !/^compositor-/i.test(ent.name)) continue
    const hit = path.join(base, ent.name, 'ffmpeg' + EXE)
    if (isFile(hit)) return hit
  }
  return ''
}

function backendDirs() {
  const root = dataRoot()
  const out = []
  for (const id of ['remotion', 'breeze', 'h3', 'music3', 'yue', 'llama']) {
    const cfg = readJson(path.join(root, id, 'config.json'))
    const dir = cfg && typeof cfg.installDir === 'string' ? cfg.installDir.trim() : ''
    if (dir && isDir(dir)) out.push({ id, dir })
  }
  return out
}

function resolveTools() {
  const envFfmpeg = process.env.MTNODE_FFMPEG || ''
  const envFfprobe = process.env.MTNODE_FFPROBE || ''
  if (isFile(envFfmpeg) && isFile(envFfprobe)) {
    return { ffmpeg: envFfmpeg, ffprobe: envFfprobe, source: 'MTNODE_FFMPEG' }
  }
  const fromPathHit = fromPath('ffmpeg' + EXE)
  if (fromPathHit) {
    const sibling = path.join(path.dirname(fromPathHit), 'ffprobe' + EXE)
    const probe = isFile(sibling) ? sibling : fromPath('ffprobe' + EXE)
    if (probe) return { ffmpeg: fromPathHit, ffprobe: probe, source: 'PATH' }
  }
  for (const { id, dir } of backendDirs()) {
    const hit = id === 'remotion' ? fromRemotion(dir) : fromLayout(dir)
    if (!hit) continue
    const probe = path.join(path.dirname(hit), 'ffprobe' + EXE)
    if (isFile(probe)) return { ffmpeg: hit, ffprobe: probe, source: `${id} 安装目录` }
  }
  throw new Error(
    '没有找到本机 ffmpeg/ffprobe：请装 Remotion 插件（自带 ffmpeg），或把 ffmpeg / ffprobe 放进 PATH，' +
      '或用环境变量 MTNODE_FFMPEG / MTNODE_FFPROBE 指定。'
  )
}

/* ── 外部进程 ─────────────────────────────────────────────────────────────── */

function run(bin, args, timeoutMs = OPT.timeoutSec * 1000) {
  return new Promise((resolve) => {
    let child
    const out = []
    const err = []
    try {
      child = spawn(bin, args, { windowsHide: true })
    } catch (e) {
      resolve({ ok: false, code: -1, stdout: Buffer.alloc(0), stderr: String((e && e.message) || e) })
      return
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch (_) {}
    }, timeoutMs)
    child.stdout.on('data', (b) => out.push(b))
    child.stderr.on('data', (b) => err.push(b))
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ ok: false, code: -1, stdout: Buffer.concat(out), stderr: String((e && e.message) || e) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ ok: code === 0, code, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString('utf8') })
    })
  })
}

/* ── ffprobe：流与容器 ───────────────────────────────────────────────────── */

async function probe(ffprobe, input) {
  const r = await run(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', input])
  if (!r.ok) throw new Error('ffprobe 失败：' + tail(r.stderr))
  let data
  try {
    data = JSON.parse(r.stdout.toString('utf8'))
  } catch (e) {
    throw new Error('ffprobe 输出不是 JSON：' + String(e.message || e))
  }
  const streams = Array.isArray(data.streams) ? data.streams : []
  const video = streams.find((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic))
  const audio = streams.find((s) => s.codec_type === 'audio')
  return { format: data.format || {}, streams, video, audio }
}

function parseRate(text) {
  if (!text || typeof text !== 'string') return 0
  const m = /^(-?\d+)\s*\/\s*(-?\d+)$/.exec(text.trim())
  if (m) {
    const n = Number(m[1])
    const d = Number(m[2])
    return d > 0 ? n / d : 0
  }
  const f = Number(text)
  return Number.isFinite(f) && f > 0 ? f : 0
}

/* ── MP4 edit list（elst）：AAC priming 补偿的真凭据 ──────────────────────
 * ffprobe 只报 start_time（已经算过 elst），看不出「primer 有没有被补掉」。
 * 这里直接走一遍 box 树：moov → trak → { tkhd / mdia(mdhd, hdlr) / edts(elst) }。
 * elst 的 mediaTime > 0 表示「跳过这前面的 N 个媒体样本」—— AAC 的编码器延迟就是它。
 */

const MP4_LIKE = /\.(mp4|m4v|m4a|mov|3gp)$/i

function readBoxHeader(fd, offset, limit) {
  if (offset + 8 > limit) return null
  const head = Buffer.alloc(16)
  const n = fs.readSync(fd, head, 0, Math.min(16, limit - offset), offset)
  if (n < 8) return null
  let size = head.readUInt32BE(0)
  const type = head.toString('latin1', 4, 8)
  let headerSize = 8
  if (size === 1) {
    if (n < 16) return null
    size = Number(head.readBigUInt64BE(8))
    headerSize = 16
  } else if (size === 0) {
    size = limit - offset
  }
  if (!Number.isFinite(size) || size < headerSize) return null
  return { type, offset, size, headerSize, payload: offset + headerSize, end: Math.min(offset + size, limit) }
}

function* childBoxes(fd, start, end) {
  let off = start
  let guard = 0
  while (off + 8 <= end && guard++ < 100000) {
    const box = readBoxHeader(fd, off, end)
    if (!box) return
    yield box
    if (box.end <= off) return
    off = box.end
  }
}

function readElst(fd, box) {
  const want = Math.min(box.end - box.payload, 4096)
  if (want < 8) return []
  const buf = Buffer.alloc(want)
  fs.readSync(fd, buf, 0, want, box.payload)
  const version = buf[0]
  const count = buf.readUInt32BE(4)
  const entries = []
  let p = 8
  for (let i = 0; i < count; i++) {
    if (version === 1) {
      if (p + 20 > buf.length) break
      entries.push({
        segmentDuration: Number(buf.readBigUInt64BE(p)),
        mediaTime: Number(buf.readBigInt64BE(p + 8)),
        rate: buf.readInt16BE(p + 16) + buf.readInt16BE(p + 18) / 65536,
      })
      p += 20
    } else {
      if (p + 12 > buf.length) break
      entries.push({
        segmentDuration: buf.readUInt32BE(p),
        mediaTime: buf.readInt32BE(p + 4),
        rate: buf.readInt16BE(p + 8) + buf.readInt16BE(p + 10) / 65536,
      })
      p += 12
    }
  }
  return entries
}

/** mvhd / mdhd 的 timescale：v0 在 12，v1 在 20（前面是 8 字节的 creation/modification） */
function readTimescale(fd, box) {
  const buf = Buffer.alloc(24)
  const n = fs.readSync(fd, buf, 0, 24, box.payload)
  const version = n >= 1 ? buf[0] : 0
  if (version === 1) return n >= 24 ? buf.readUInt32BE(20) : 0
  return n >= 20 ? buf.readUInt32BE(12) : 0
}

function readMp4Edits(file) {
  const fd = fs.openSync(file, 'r')
  try {
    const size = fs.fstatSync(fd).size
    let moov = null
    for (const box of childBoxes(fd, 0, size)) {
      if (box.type === 'moov') {
        moov = box
        break
      }
    }
    if (!moov) return null
    let movieTimescale = 0
    for (const box of childBoxes(fd, moov.payload, moov.end)) {
      if (box.type === 'mvhd') movieTimescale = readTimescale(fd, box) || 0
    }
    const tracks = []
    for (const box of childBoxes(fd, moov.payload, moov.end)) {
      if (box.type !== 'trak') continue
      const track = { handler: '', handlerName: '', mediaTimescale: 0, edits: [], emptyLeadMs: 0 }
      for (const c of childBoxes(fd, box.payload, box.end)) {
        if (c.type === 'mdia') {
          for (const m of childBoxes(fd, c.payload, c.end)) {
            if (m.type === 'mdhd') track.mediaTimescale = readTimescale(fd, m) || 0
            if (m.type === 'hdlr') {
              const buf = Buffer.alloc(12)
              if (fs.readSync(fd, buf, 0, 12, m.payload) >= 12) {
                track.handler = buf.toString('latin1', 8, 12)
                track.handlerName = buf.toString('latin1', 8, 12).replace(/\0/g, '')
              }
            }
          }
        } else if (c.type === 'edts') {
          for (const e of childBoxes(fd, c.payload, c.end)) {
            if (e.type === 'elst') track.edits = readElst(fd, e)
          }
        }
      }
      // 首个非空 edit 的 mediaTime = 要跳过的媒体样本数（AAC priming）
      let primingSamples = 0
      let emptyLead = 0
      let seenReal = false
      for (const e of track.edits) {
        if (e.mediaTime < 0) {
          if (!seenReal && movieTimescale > 0) emptyLead += e.segmentDuration / movieTimescale
          continue
        }
        if (!seenReal) primingSamples = e.mediaTime
        seenReal = true
      }
      track.primingSamples = primingSamples
      track.primingMs = track.mediaTimescale > 0 ? (primingSamples / track.mediaTimescale) * 1000 : 0
      track.emptyLeadMs = emptyLead * 1000
      tracks.push(track)
    }
    return { movieTimescale, tracks }
  } catch (_) {
    return null
  } finally {
    fs.closeSync(fd)
  }
}

/* ── canonical WAV：分析用的就是它，合片也只能用它 ───────────────────────── */

async function makeCanonicalWav({ ffmpeg, input, wavPath }) {
  if (isFile(wavPath) && !OPT.overwrite) {
    throw new Error('canonical WAV 已存在且指定了 --no-overwrite：' + wavPath)
  }
  const args = [
    '-hide_banner',
    '-nostdin',
    '-nostats',
    '-loglevel',
    'error',
    OPT.overwrite ? '-y' : '-n',
    '-i',
    input,
    '-map',
    '0:a:0',
    '-vn',
    '-sn',
    '-dn',
    '-ac',
    String(WAV_CHANNELS),
    '-ar',
    String(WAV_RATE),
    '-c:a',
    WAV_CODEC,
    '-fflags',
    '+bitexact',
    '-flags:a',
    '+bitexact',
    wavPath,
  ]
  if (OPT.verbose) process.stdout.write('$ ' + [ffmpeg, ...args].join(' ') + '\n')
  const r = await run(ffmpeg, args)
  if (!r.ok || !isFile(wavPath)) {
    throw new Error('抽取 canonical WAV 失败：' + (tail(r.stderr) || `退出码 ${r.code}`))
  }
  const st = fs.statSync(wavPath)
  if (st.size <= 44) throw new Error('canonical WAV 是空的（成片里没有可用音轨？）')
  return { path: wavPath, bytes: st.size, sha256: sha256File(wavPath) }
}

/* ── WAV 读取（只读自己产出的那份 PCM） ─────────────────────────────────── */

function openWav(file) {
  const fd = fs.openSync(file, 'r')
  let ok = false
  try {
    const fileSize = fs.fstatSync(fd).size
    const head = Buffer.alloc(Math.min(1 << 16, fileSize))
    const n = fs.readSync(fd, head, 0, head.length, 0)
    if (n < 44 || head.toString('ascii', 0, 4) !== 'RIFF' || head.toString('ascii', 8, 12) !== 'WAVE') {
      throw new Error('不是合法的 WAV（RIFF/WAVE 头不匹配）：' + file)
    }
    let fmt = null
    let data = null
    let off = 12
    while (off + 8 <= n) {
      const id = head.toString('ascii', off, off + 4)
      const size = head.readUInt32LE(off + 4)
      if (id === 'fmt ' && off + 8 + 16 <= n) {
        let tag = head.readUInt16LE(off + 8)
        const channels = head.readUInt16LE(off + 10)
        const rate = head.readUInt32LE(off + 12)
        const blockAlign = head.readUInt16LE(off + 20)
        const bits = head.readUInt16LE(off + 22)
        if (tag === 0xfffe && off + 8 + 26 <= n) tag = head.readUInt16LE(off + 8 + 24)
        fmt = { tag, channels, rate, bits, blockAlign }
      } else if (id === 'data') {
        const size0 = size === 0xffffffff || size === 0 ? fileSize - (off + 8) : size
        data = { offset: off + 8, bytes: Math.min(size0, fileSize - (off + 8)) }
      }
      off += 8 + size + (size & 1)
      if (fmt && data) break
      if (size === 0xffffffff || size === 0) break
    }
    if (!fmt || !data) throw new Error('WAV 缺少 fmt / data 块：' + file)
    const bitsPerSample = fmt.bits
    const bytesPerSample = Math.max(1, Math.floor(bitsPerSample / 8))
    const frameBytes = bytesPerSample * fmt.channels
    const totalFrames = Math.floor(data.bytes / frameBytes)
    ok = true
    return {
      fd,
      file,
      size: fileSize,
      channels: fmt.channels,
      rate: fmt.rate,
      bits: bitsPerSample,
      tag: fmt.tag,
      floating: fmt.tag === 3,
      dataOffset: data.offset,
      dataBytes: data.bytes,
      frameBytes,
      totalFrames,
      durationSec: totalFrames / fmt.rate,
    }
  } finally {
    if (!ok) fs.closeSync(fd)
  }
}

function makeReader(wav) {
  const CHUNK = 1 << 15
  const { fd, channels, bits, rate, dataOffset, frameBytes, totalFrames } = wav
  const floating = wav.floating
  const bytesPerSample = Math.max(1, bits >> 3)
  let cacheStart = -1
  let cache = new Float32Array(0)

  function decode(buf, frames) {
    const out = new Float32Array(frames)
    const inv = 1 / channels
    for (let i = 0; i < frames; i++) {
      let acc = 0
      let p = i * frameBytes
      for (let c = 0; c < channels; c++) {
        let v = 0
        if (floating) {
          v = buf.readFloatLE(p)
        } else if (bits === 8) {
          v = (buf.readUInt8(p) - 128) / 128
        } else if (bits === 16) {
          v = buf.readInt16LE(p) / 32768
        } else if (bits === 24) {
          let x = buf.readUIntLE(p, 3)
          if (x & 0x800000) x -= 0x1000000
          v = x / 8388608
        } else if (bits === 32) {
          v = buf.readInt32LE(p) / 2147483648
        } else {
          v = 0
        }
        acc += v
        p += bytesPerSample
      }
      out[i] = acc * inv
    }
    return out
  }

  function load(start) {
    const want = Math.max(1, Math.min(CHUNK, totalFrames - start))
    const buf = Buffer.allocUnsafe(want * frameBytes)
    const got = fs.readSync(fd, buf, 0, want * frameBytes, dataOffset + start * frameBytes)
    cacheStart = start
    cache = decode(buf, Math.floor(got / frameBytes))
  }

  return {
    rate,
    totalFrames,
    read(start, count) {
      const s = Math.max(0, Math.min(start, totalFrames))
      const c = Math.max(0, Math.min(count, totalFrames - s))
      const out = new Float32Array(c)
      let done = 0
      while (done < c) {
        const at = s + done
        if (!(at >= cacheStart && at < cacheStart + cache.length)) load(at)
        const off = at - cacheStart
        const n = Math.min(c - done, cache.length - off)
        out.set(cache.subarray(off, off + n), done)
        done += n
      }
      return out
    },
  }
}

/* ── 点击检测：起跳样本之间做线性插值，精度约 0.02 ms ───────────────────── */

function detectClicks(wav) {
  const reader = makeReader(wav)
  const rate = wav.rate
  const total = wav.totalFrames
  if (!total) return { events: [], globalPeak: 0, threshold: 0 }

  // ① 全局峰值：点击是瞬时冲击，门限按全局峰值的比例取（不受整条音轨响度影响）
  let globalPeak = 0
  for (let s = 0; s < total; s += rate) {
    const mono = reader.read(s, Math.min(rate, total - s))
    for (let i = 0; i < mono.length; i++) {
      const a = Math.abs(mono[i])
      if (a > globalPeak) globalPeak = a
    }
  }
  if (!(globalPeak > 0)) return { events: [], globalPeak: 0, threshold: 0 }

  const threshold = Math.max(OPT.clickThreshold * globalPeak, 1e-4)
  const sepSamples = Math.max(1, Math.round((rate * OPT.clickSeparationMs) / 1000))
  const events = []
  let lastOnset = -Infinity
  let prevAbs = 0

  // ② 逐样本找向上穿门限的起点（连续冲击合并为一个事件）
  for (let s = 0; s < total; s += rate) {
    const mono = reader.read(s, Math.min(rate, total - s))
    for (let i = 0; i < mono.length; i++) {
      const sample = s + i
      const a = Math.abs(mono[i])
      const rising = a >= threshold && prevAbs < threshold
      if (rising && sample - lastOnset >= sepSamples) {
        const frac = a > prevAbs ? (threshold - prevAbs) / (a - prevAbs) : 1
        const onsetSample = sample - 1 + Math.min(Math.max(frac, 0), 1)
        const winStart = Math.max(0, sample - 1)
        const win = reader.read(winStart, Math.min(Math.round(rate * 0.03), total - winStart))
        let peak = 0
        for (let k = 0; k < win.length; k++) {
          const v = Math.abs(win[k])
          if (v > peak) peak = v
        }
        events.push({
          t: Math.max(0, onsetSample) / rate,
          sample: Math.max(0, onsetSample),
          peak,
          peakDb: peak > 0 ? 20 * Math.log10(peak) : -Infinity,
        })
        lastOnset = sample
      }
      prevAbs = a
    }
  }
  return { events, globalPeak, threshold, rate, durationSec: total / rate }
}

/* ── 视频：逐帧亮度 → 闪拍上升沿（亚帧插值） ─────────────────────────────── */

const SHOWINFO_RE = /n:\s*(\d+)\s+pts:\s*\S+\s+pts_time:\s*(\S+)/

function frameStats(buf, off, len) {
  let sum = 0
  let bright = 0
  for (let i = 0; i < len; i++) {
    const v = buf[off + i]
    sum += v
    if (v >= BRIGHT_LUMA) bright++
  }
  return { mean: sum / len, cover: bright / len }
}

/**
 * 把视频帧解成 64×64 灰度原始字节流：只留每帧的均值与「接近全白」占比。
 * 时间戳取 showinfo 的 pts_time（配合 -copyts，与容器时间轴一致）。
 */
function scanFrames(ffmpeg, input, timeoutMs = OPT.timeoutSec * 1000) {
  const args = [
    '-hide_banner',
    '-nostdin',
    '-nostats',
    '-copyts',
    '-loglevel',
    'info',
    '-i',
    input,
    '-map',
    '0:v:0',
    '-an',
    '-sn',
    '-dn',
    '-vf',
    `scale=${FRAME_SIZE}:${FRAME_SIZE}:flags=area,format=gray,showinfo`,
    '-f',
    'rawvideo',
    '-pix_fmt',
    'gray',
    '-',
  ]
  if (OPT.verbose) process.stdout.write('$ ' + [ffmpeg, ...args].join(' ') + '\n')

  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(ffmpeg, args, { windowsHide: true })
    } catch (e) {
      reject(new Error('无法启动 ffmpeg：' + String((e && e.message) || e)))
      return
    }
    const stats = []
    const times = new Map()
    let pending = Buffer.alloc(0)
    let errBuf = ''
    let errTail = ''
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch (_) {}
    }, timeoutMs)

    child.stdout.on('data', (chunk) => {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk
      let off = 0
      while (pending.length - off >= FRAME_BYTES) {
        stats.push(frameStats(pending, off, FRAME_BYTES))
        off += FRAME_BYTES
      }
      pending = off ? pending.subarray(off) : pending
    })
    child.stderr.on('data', (chunk) => {
      errBuf += chunk.toString('utf8')
      let idx
      while ((idx = errBuf.indexOf('\n')) >= 0) {
        const line = errBuf.slice(0, idx).replace(/\r$/, '')
        errBuf = errBuf.slice(idx + 1)
        if (!line) continue
        errTail = line
        const m = SHOWINFO_RE.exec(line)
        if (m) {
          const n = Number(m[1])
          const tv = m[2]
          if (tv !== 'NOPTS' && Number.isFinite(Number(tv))) times.set(n, Number(tv))
        }
      }
      if (errBuf.length > (1 << 22)) errBuf = ''
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(new Error('ffmpeg 抽帧失败：' + String((e && e.message) || e)))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (!stats.length) {
        reject(new Error('一帧都没抽出来（退出码 ' + code + '）：' + tail(errTail)))
        return
      }
      resolve({ stats, times, code, stderr: errTail })
    })
  })
}

function detectFlashes(stats, times, fps, t0 = 0) {
  const n = stats.length
  if (!n) return { events: [], base: 0, peak: 0, threshold: 0, contrast: 0 }
  const coverSorted = Float64Array.from(stats.map((s) => s.cover)).sort()
  const base = coverSorted[Math.floor(n * 0.5)]
  const peak = coverSorted[n - 1]
  const contrast = peak - base
  // 没有 showinfo 时间戳时按 start_time + 帧号/帧率 退算（-copyts 下是容器时间轴）
  const tFor = (i) => (times.has(i) ? times.get(i) : t0 + i / fps)
  if (contrast < OPT.flashMinContrast) return { events: [], base, peak, threshold: 0, contrast }
  const threshold = base + contrast * OPT.flashThreshold
  const events = []
  for (let i = 0; i < n; i++) {
    const c = stats[i].cover
    if (c < threshold) continue
    if (i > 0 && stats[i - 1].cover >= threshold) continue // 连续亮帧合并为一个事件
    const cPrev = i > 0 ? stats[i - 1].cover : base
    const tPrev = i > 0 ? tFor(i - 1) : tFor(0) - 1 / fps
    const frac = c > cPrev ? (threshold - cPrev) / (c - cPrev) : 1
    const t = tPrev + Math.min(Math.max(frac, 0), 1) * (tFor(i) - tPrev)
    let k = i
    while (k < n && stats[k].cover >= threshold) k++
    events.push({ t, frame: i, frames: k - i, cover: c, mean: stats[i].mean })
  }
  return { events, base, peak, threshold, contrast }
}

/* ── 配对与判定 ──────────────────────────────────────────────────────────── */

function pairEvents(videoTimes, audioTimes, windowSec) {
  const used = new Set()
  const pairs = []
  for (const at of audioTimes) {
    let best = -1
    let bestD = Infinity
    for (let k = 0; k < videoTimes.length; k++) {
      if (used.has(k)) continue
      const d = Math.abs(videoTimes[k] - at)
      if (d <= windowSec && d < bestD) {
        best = k
        bestD = d
      }
    }
    if (best >= 0) {
      used.add(best)
      pairs.push({ video: videoTimes[best], audio: at })
    }
  }
  pairs.sort((a, b) => a.video - b.video)
  return pairs
}

function statsOf(values) {
  if (!values.length) return { count: 0, mean: 0, meanAbs: 0, maxAbs: 0, rms: 0, maxSigned: 0 }
  let sum = 0
  let sumAbs = 0
  let maxAbs = 0
  let sq = 0
  for (const v of values) {
    sum += v
    sumAbs += Math.abs(v)
    sq += v * v
    if (Math.abs(v) > maxAbs) maxAbs = Math.abs(v)
  }
  return {
    count: values.length,
    mean: sum / values.length,
    meanAbs: sumAbs / values.length,
    maxAbs,
    rms: Math.sqrt(sq / values.length),
    maxSigned: values.reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a), 0),
  }
}

/* ── 主流程 ─────────────────────────────────────────────────────────────── */

async function main() {
  if (hasFlag('help') || hasFlag('h')) {
    usage()
    return 0
  }
  if (!INPUT) {
    usage()
    return 2
  }
  const input = path.resolve(INPUT)
  if (!isFile(input)) throw new Error('找不到成片：' + input)

  const tools = resolveTools()
  const base = path.basename(input, path.extname(input))
  const outDir = path.dirname(input)
  const wavPath = OPT.wav ? path.resolve(OPT.wav) : path.join(outDir, base + '.canonical.wav')
  const jsonPath = OPT.json ? path.resolve(OPT.json) : path.join(outDir, base + '.verify-sync.json')

  const issues = []
  const info = await probe(tools.ffprobe, input)
  if (!info.video) throw new Error('成片里没有视频轨，无法做音画同步检测：' + input)
  if (!info.audio) throw new Error('成片里没有音频轨，无法做音画同步检测：' + input)

  const fps = OPT.fps || parseRate(info.video.avg_frame_rate) || parseRate(info.video.r_frame_rate) || 25
  const halfFrameMs = 500 / fps
  const toleranceMs = halfFrameMs + 10
  const vStart = Number(info.video.start_time) || 0
  const aStart = Number(info.audio.start_time) || 0
  const fmtStart = Number((info.format || {}).start_time) || 0

  /* ① canonical WAV —— 之后所有音频结论都只来自这份 PCM */
  const pcm = await makeCanonicalWav({ ffmpeg: tools.ffmpeg, input, wavPath })
  const pcmStamp = {
    tool: 'scripts/verify-sync.mjs',
    createdAt: new Date().toISOString(),
    source: { path: input, bytes: fs.statSync(input).size, mtimeMs: Math.round(fs.statSync(input).mtimeMs) },
    wav: { path: pcm.path, bytes: pcm.bytes, sha256: pcm.sha256, rate: WAV_RATE, channels: WAV_CHANNELS, codec: WAV_CODEC },
    note: '分析用的就是这份 PCM；合片（mux）必须用它，复测前比对 sha256。',
  }
  try {
    fs.writeFileSync(pcm.path + '.json', JSON.stringify(pcmStamp, null, 2) + '\n', 'utf8')
  } catch (_) {}

  /* ② 音频：点击起点（时间 = 音轨 start_time + 文件内位置） */
  const wav = openWav(pcm.path)
  let clicks
  try {
    clicks = detectClicks(wav)
  } finally {
    fs.closeSync(wav.fd)
  }
  const audioTimes = clicks.events.map((e) => aStart + e.t)

  /* ③ 视频：闪拍上升沿（-copyts，已经是容器时间） */
  const frames = await scanFrames(tools.ffmpeg, input)
  const flash = detectFlashes(frames.stats, frames.times, fps, vStart)
  const videoTimes = flash.events.map((e) => e.t)

  /* ④ 配对与偏差 */
  const pairs = pairEvents(videoTimes, audioTimes, OPT.matchWindowMs / 1000)
  const deltasMs = pairs.map((p) => (p.audio - p.video) * 1000)
  const st = statsOf(deltasMs)

  if (!videoTimes.length) issues.push({ level: 'fail', code: 'no-flash', message: '未检出闪拍帧：画面里没有可用的同步点（或以白场为主、闪拍不可辨）' })
  if (!audioTimes.length) issues.push({ level: 'fail', code: 'no-click', message: '未检出点击：音轨里没有可用的同步点' })
  if (videoTimes.length && audioTimes.length && !pairs.length) {
    issues.push({ level: 'fail', code: 'no-pair', message: `闪拍与点击都检出了，但 ${OPT.matchWindowMs} ms 内没有能配成对的（检查素材 / 提高 --match-window）` })
  }
  if (OPT.expect > 0 && pairs.length < OPT.expect) {
    issues.push({ level: 'fail', code: 'too-few-pairs', message: `期望 ${OPT.expect} 个同步点，实际配成 ${pairs.length} 对` })
  }
  if (videoTimes.length !== audioTimes.length && videoTimes.length && audioTimes.length) {
    issues.push({ level: 'warn', code: 'count-mismatch', message: `闪拍 ${videoTimes.length} 个、点击 ${audioTimes.length} 个，数量不一致（多出来的那个影像点或缺声音点就是问题）` })
  }
  if (st.count && st.maxAbs > toleranceMs) {
    issues.push({
      level: 'fail',
      code: 'sync-out-of-tolerance',
      message: `最大偏差 ${fix(st.maxAbs)} ms 超过容差 ${fix(toleranceMs)} ms（半帧 ${fix(halfFrameMs)} + 10 ms）`,
    })
  }

  /* ⑤ ffprobe start_time / edit list（AAC priming 补偿） */
  const edits = MP4_LIKE.test(input) ? readMp4Edits(input) : null
  const startGapMs = (aStart - vStart) * 1000
  if (Math.abs(startGapMs) > toleranceMs) {
    issues.push({
      level: 'fail',
      code: 'start-time-gap',
      message: `音视频 start_time 相差 ${fix(startGapMs)} ms（视频 ${fix(vStart * 1000)} ms / 音频 ${fix(aStart * 1000)} ms），超过容差 ${fix(toleranceMs)} ms`,
    })
  }
  let audioTrackEdit = null
  if (edits) {
    audioTrackEdit = edits.tracks.find((t) => t.handler === 'soun') || null
    const videoTrackEdit = edits.tracks.find((t) => t.handler === 'vide') || null
    if (audioTrackEdit) {
      const isAac = /aac/i.test(String(info.audio.codec_name || ''))
      if (isAac && !(audioTrackEdit.primingSamples > 0)) {
        issues.push({
          level: 'warn',
          code: 'aac-priming-elst-missing',
          message: 'AAC 音轨没有 edit list 的 priming 补偿（缺 elst 或 media_time=0）：典型 1024/2048 样本 ≈ 21.3/42.7 ms 会被听成整条音轨偏晚',
        })
      }
      if (audioTrackEdit.primingSamples > 0 && isAac) {
        const plausible = AAC_PRIMING_SAMPLES.some((n) => Math.abs(audioTrackEdit.primingSamples - n) <= 1)
        if (!plausible) {
          issues.push({
            level: 'warn',
            code: 'aac-priming-implausible',
            message: `AAC priming = ${audioTrackEdit.primingSamples} 样本（不是常见的 1024 / 2048），检查 mux 时是否把整帧对齐参数写进了 elst`,
          })
        }
      }
      // 偏差方向与 priming 数值一致 → 十有八九是「合片时没补偿 priming」
      if (st.count && audioTrackEdit.primingMs > 5 && Math.abs(Math.abs(st.mean) - audioTrackEdit.primingMs) <= 3) {
        issues.push({
          level: 'warn',
          code: 'priming-not-compensated',
          message: `实测平均偏差 ${fix(Math.abs(st.mean))} ms ≈ elst 的 priming ${fix(audioTrackEdit.primingMs)} ms：合片时没有按 edit list 补偿编码器延迟`,
        })
      }
    }
    if (videoTrackEdit && Math.abs(vStart * 1000) > 1) {
      issues.push({ level: 'warn', code: 'video-start-shifted', message: `视频轨 start_time = ${fix(vStart * 1000)} ms（容器把画面整体后移了，判偏差时已按此基准扣除）` })
    }
  }

  const failed = issues.some((i) => i.level === 'fail')
  const verdict = failed ? 'FAIL' : 'PASS'

  /* ⑥ 落盘 JSON + 打印 */
  const report = {
    tool: 'scripts/verify-sync.mjs',
    createdAt: new Date().toISOString(),
    input,
    verdict,
    exitCode: failed ? 1 : 0,
    toleranceMs,
    halfFrameMs,
    fps,
    pcm,
    probe: {
      format: {
        formatName: (info.format || {}).format_name || '',
        startTime: fmtStart,
        duration: Number((info.format || {}).duration) || 0,
        bitRate: Number((info.format || {}).bit_rate) || 0,
      },
      video: {
        codec: info.video.codec_name || '',
        width: info.video.width || 0,
        height: info.video.height || 0,
        fps: parseRate(info.video.avg_frame_rate) || 0,
        rFps: parseRate(info.video.r_frame_rate) || 0,
        startTime: vStart,
        duration: Number(info.video.duration) || 0,
        timeBase: info.video.time_base || '',
        nbFrames: Number(info.video.nb_frames) || 0,
      },
      audio: {
        codec: info.audio.codec_name || '',
        sampleRate: Number(info.audio.sample_rate) || 0,
        channels: Number(info.audio.channels) || 0,
        startTime: aStart,
        duration: Number(info.audio.duration) || 0,
        timeBase: info.audio.time_base || '',
      },
      startGapMs,
    },
    edits: edits
      ? {
          movieTimescale: edits.movieTimescale,
          tracks: edits.tracks.map((t) => ({
            handler: t.handler,
            mediaTimescale: t.mediaTimescale,
            primingSamples: t.primingSamples,
            primingMs: t.primingMs,
            emptyLeadMs: t.emptyLeadMs,
            entries: t.edits,
          })),
        }
      : null,
    flashes: flash.events.map((e) => ({ t: e.t, frame: e.frame, frames: e.frames, cover: e.cover, mean: e.mean })),
    clicks: clicks.events.map((e) => ({ t: e.t, abs: aStart + e.t, peakDb: e.peakDb })),
    detection: {
      flashBase: flash.base,
      flashPeak: flash.peak,
      flashThreshold: flash.threshold,
      flashContrast: flash.contrast,
      clickGlobalPeak: clicks.globalPeak,
      clickThreshold: clicks.threshold,
      clickRate: clicks.rate || wav.rate,
      framesScanned: frames.stats.length,
    },
    pairs: pairs.map((p, i) => ({ index: i + 1, videoSec: p.video, audioSec: p.audio, deltaMs: (p.audio - p.video) * 1000 })),
    stats: st,
    issues,
  }
  try {
    fs.mkdirSync(path.dirname(jsonPath), { recursive: true })
    fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2) + '\n', 'utf8')
  } catch (e) {
    issues.push({ level: 'warn', code: 'json-write-failed', message: '报告 JSON 没写成：' + String(e.message || e) })
  }

  /* ── 文本报告 ── */
  const L = []
  const put = (s = '') => L.push(s)
  put('音画同步 QA · verify-sync')
  put('')
  put(`输入        ${input}`)
  put(`canonical   ${pcm.path}`)
  put(`            ${WAV_RATE} Hz / ${WAV_CHANNELS}ch / ${WAV_CODEC} / ${(pcm.bytes / 1048576).toFixed(2)} MB / sha256 ${pcm.sha256.slice(0, 16)}…`)
  put('            分析用的就是这份 PCM：合片与复测必须用它（旁证在 <wav>.json）')
  put('')
  put('流信息')
  put(`  视频  ${info.video.codec_name || '?'}  ${info.video.width || '?'}×${info.video.height || '?'}  ${fix(fps)} fps  start_time ${fix(vStart)} s  duration ${fix(Number(info.video.duration) || 0, 3)} s`)
  put(`  音频  ${info.audio.codec_name || '?'}  ${info.audio.sample_rate || '?'} Hz / ${info.audio.channels || '?'}ch  start_time ${fix(aStart)} s  duration ${fix(Number(info.audio.duration) || 0, 3)} s`)
  put(`  容器  ${(info.format || {}).format_name || '?'}  start_time ${fix(fmtStart)} s  duration ${fix(Number((info.format || {}).duration) || 0, 3)} s`)
  put('')
  put('edit list（MP4 elst · AAC priming 补偿）')
  if (!edits) {
    put('  非 MP4 容器，跳过 elst 检查（start_time 仍已核对）')
  } else if (!edits.tracks.length) {
    put('  moov 里没有 trak，读不到 track 信息')
  } else {
    for (const t of edits.tracks) {
      const kind = t.handler === 'soun' ? '音频轨' : t.handler === 'vide' ? '视频轨' : `轨道(${t.handler || '?'})`
      if (!t.edits.length) {
        put(`  ${kind}  media_timescale ${t.mediaTimescale}  → 无 edit list`)
      } else {
        put(`  ${kind}  media_timescale ${t.mediaTimescale}  → media_time ${t.primingSamples} 样本 = ${fix(t.primingMs)} ms${t.emptyLeadMs > 0 ? `（前面还有 ${fix(t.emptyLeadMs)} ms 空 edit）` : ''}`)
      }
    }
  }
  put('')
  put('同步检测')
  put(`  闪拍 ${flash.events.length} 个（画面覆盖率基线 ${fix(flash.base, 3)} → 峰值 ${fix(flash.peak, 3)}，门限 ${fix(flash.threshold, 3)}）`)
  put(`  点击 ${audioTimes.length} 个（门限 ${dbOf(clicks.threshold)} dBFS，全局峰值 ${dbOf(clicks.globalPeak)} dBFS）`)
  put(`  配成 ${pairs.length} 对（窗口 ${OPT.matchWindowMs} ms）`)
  if (pairs.length) {
    put('')
    put('   #   视频(s)     音频(s)     偏差(ms)')
    const show = pairs.slice(0, 40)
    show.forEach((p, i) => {
      const d = (p.audio - p.video) * 1000
      put(`  ${String(i + 1).padStart(2)}  ${fix(p.video, 4).padStart(10)}  ${fix(p.audio, 4).padStart(10)}  ${(d >= 0 ? '+' : '') + fix(d, 2)}`)
    })
    if (pairs.length > show.length) put(`  … 省略 ${pairs.length - show.length} 对`)
  }
  put('')
  if (st.count) {
    put(`  平均偏差（带符号） ${(st.mean >= 0 ? '+' : '') + fix(st.mean)} ms  ${st.mean > 0 ? '（音频偏晚）' : st.mean < 0 ? '（音频偏早）' : ''}`)
    put(`  平均绝对偏差       ${fix(st.meanAbs)} ms     RMS ${fix(st.rms)} ms`)
    const worst = pairs.findIndex((p) => Math.abs((p.audio - p.video) * 1000) === st.maxAbs) + 1
    put(`  最大绝对偏差       ${fix(st.maxAbs)} ms${worst > 0 ? `（第 ${worst} 对）` : ''}`)
  } else {
    put('  没有任何可用的同步点，无法判定')
  }
  put(`  容差               半帧 ${fix(halfFrameMs)} + 10 = ${fix(toleranceMs)} ms（${fix(fps)} fps）`)
  if (issues.length) {
    put('')
    put('问题')
    for (const it of issues) put(`  ${it.level === 'fail' ? '✗' : '!'} [${it.code}] ${it.message}`)
  }
  put('')
  put(`判定  ${verdict}`)
  put(`报告  ${jsonPath}`)
  process.stdout.write(L.join('\n') + '\n')

  return failed ? 1 : 0
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((e) => {
    process.stderr.write('verify-sync 失败：' + String((e && e.message) || e) + '\n')
    process.exitCode = 2
  })
