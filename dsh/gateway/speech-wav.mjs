/* ============================================================================
 * 语音契约 · WAV 归一（speech-wav.mjs）—— 唯一真源
 * ----------------------------------------------------------------------------
 * 为什么需要它（用户现场）：画布上的「音频转字幕」工具一跑就报「invalid speech wav」。
 * 根因不在识别器，而在**切片文件的头**：
 *   官方 SenseVoice 的入口 `validateWave()`（@deepseek-ai/dsh-experimental-speech-to-text
 *   的 lib/types/wave.js）只认**标准 44 字节头**的 16 kHz 单声道 PCM16 WAV —— 它按固定
 *   偏移硬判（第 36–40 字节必须是 'data'、第 40 字节起的长度必须等于 总长-44）。
 *   而我们每句是用 ffmpeg 切出来的：ffmpeg 的 wav muxer 默认会在 fmt 之后写一个
 *   `LIST … INFO ISFT LavfXX` 元数据块（实测 61.7.100 也照写），于是第 36–40 字节是
 *   'LIST' 而不是 'data' → 直接被判为「不是合法的语音 WAV」。
 * 录音听写那条链之所以没事：渲染层自己 encodeWav16kMono() 编的头本来就是标准的。
 *
 * 这里做的事：把任意合规 WAV（可以带 LIST / fact / bext / 多个 data 块 / 奇数字节填充）
 * 拆成「fmt + data 载荷」，再重写成**正好 44 字节头**的标准 PCM16 WAV。
 * 已经是标准头的一律原样返回（零拷贝快路径，保证录音那条路不被无谓改写）。
 *
 * 单一真源：主进程 media-subtitle.js（画布工具 mtnode.subtitle）与网关
 * media-plugin.mjs（Agent 工具 audio_transcribe / audio_subtitle）都 import 这一份。
 * ==========================================================================*/

/** 44 字节标准头：RIFF/WAVE/fmt(16)/PCM/1ch/16000/…/data */
const CANONICAL_HEADER = 44

/**
 * 判断是否已经是官方要求的「标准 44 字节头」WAV（与 validateWave 的静态判据同口径）。
 * @param {Buffer} d
 * @returns {boolean}
 */
function isCanonical(d) {
  if (!Buffer.isBuffer(d) || d.length < CANONICAL_HEADER) return false
  return (
    d.toString('ascii', 0, 4) === 'RIFF' &&
    d.toString('ascii', 8, 12) === 'WAVE' &&
    d.toString('ascii', 12, 16) === 'fmt ' &&
    d.readUInt32LE(16) === 16 &&
    d.readUInt16LE(20) === 1 &&
    d.readUInt16LE(22) === 1 &&
    d.readUInt32LE(24) === 16000 &&
    d.readUInt32LE(28) === 32000 &&
    d.readUInt16LE(32) === 2 &&
    d.readUInt16LE(34) === 16 &&
    d.toString('ascii', 36, 40) === 'data' &&
    d.readUInt32LE(4) === d.length - 8 &&
    d.readUInt32LE(40) === d.length - 44 &&
    (d.length - 44) % 2 === 0
  )
}

/**
 * 把 WAV 归一成官方语音契约要的标准 44 字节头（16 kHz / 单声道 / PCM16）。
 * @param {Buffer|Uint8Array} input - 任意合规 WAV 字节。
 * @returns {Buffer} 标准头 WAV（已是标准头时原样返回同一份 Buffer）。
 */
export function canonicalPcmWav16k(input) {
  const d = Buffer.isBuffer(input)
    ? input
    : input instanceof Uint8Array
      ? Buffer.from(input.buffer, input.byteOffset, input.byteLength)
      : Buffer.from(input || [])
  if (d.length < 12 || d.toString('ascii', 0, 4) !== 'RIFF' || d.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('不是 WAV（缺 RIFF/WAVE 头）：' + d.length + ' 字节')
  }
  if (isCanonical(d)) return d

  /* 逐块走：ffmpeg 会在 fmt 之后插 LIST(INFO ISFT=…)；个别工具还会插 fact / bext，
     data 也可能被拆成多块。这里只认 fmt 与 data，其余一律丢掉。 */
  let fmt = null
  const datas = []
  let off = 12
  while (off + 8 <= d.length) {
    const id = d.toString('ascii', off, off + 4)
    const size = d.readUInt32LE(off + 4)
    const body = off + 8
    const avail = Math.max(0, Math.min(size, d.length - body))
    if (id === 'fmt ' && !fmt) fmt = Buffer.from(d.subarray(body, body + Math.min(avail, 16)))
    else if (id === 'data') datas.push(Buffer.from(d.subarray(body, body + avail)))
    if (size > d.length - body) break /* 头里的长度比文件还长：坏文件，按已有块收尾 */
    off = body + size + (size % 2) /* RIFF 块按偶数字节对齐 */
  }
  if (!fmt || fmt.length < 16) {
    throw new Error('WAV 缺少 fmt 块（文件可能损坏）：' + d.length + ' 字节')
  }
  const audioFormat = fmt.readUInt16LE(0)
  const channels = fmt.readUInt16LE(2)
  const sampleRate = fmt.readUInt32LE(4)
  const bits = fmt.readUInt16LE(14)
  if (audioFormat !== 1 || channels !== 1 || sampleRate !== 16000 || bits !== 16) {
    throw new Error(
      '音频必须是 16 kHz 单声道 PCM16 的 WAV（实际 ' +
        sampleRate + ' Hz / ' + channels + ' 声道 / ' + bits + ' bit / 格式 ' + audioFormat + '）',
    )
  }
  if (!datas.length) throw new Error('WAV 里没有 data 块（文件可能损坏）：' + d.length + ' 字节')

  let payload = datas.length === 1 ? datas[0] : Buffer.concat(datas)
  if (payload.length % 2 === 1) payload = payload.subarray(0, payload.length - 1)

  const out = Buffer.alloc(CANONICAL_HEADER + payload.length)
  out.write('RIFF', 0, 'ascii')
  out.writeUInt32LE(36 + payload.length, 4)
  out.write('WAVE', 8, 'ascii')
  out.write('fmt ', 12, 'ascii')
  out.writeUInt32LE(16, 16)
  out.writeUInt16LE(1, 20) /* PCM */
  out.writeUInt16LE(1, 22) /* 单声道 */
  out.writeUInt32LE(16000, 24)
  out.writeUInt32LE(32000, 28) /* 字节率 */
  out.writeUInt16LE(2, 32) /* 块对齐 */
  out.writeUInt16LE(16, 34) /* 位深 */
  out.write('data', 36, 'ascii')
  out.writeUInt32LE(payload.length, 40)
  payload.copy(out, CANONICAL_HEADER)
  return out
}

export { isCanonical as isCanonicalSpeechWav }
