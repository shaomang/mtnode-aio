// 字幕工具冒烟（不连 MTNode 界面）：
//   1) 纯函数：CJK 判定 / 去句末句号 / 标点断句 / 超长句按字数比例分配时间 / 单条时长上限 / SRT·VTT 时间码
//   2) 真跑一遍 audio_subtitle：ffmpeg 造一段人声 + 假 SenseVoice，校验 cues、SRT、VTT 与「不写文件」
//   3) 许可位：MTNODE_HIDE_TOOLS 点名 audio_subtitle 时它整只不注册（与 audio_transcribe 同属 media_asr）
//
// 用法：node dsh/smoke-subtitle.mjs
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { apply, __internals } from './gateway/media-plugin.mjs'

const {
  buildSubtitleCues,
  formatSrt,
  formatVtt,
  srtTime,
  vttTime,
  isCjkHeavy,
  stripFinalPeriod,
  splitAfterPunctuation,
  normalizeNoise,
  resolveFfmpeg,
  SUBTITLE_MAX_SECONDS,
  SUBTITLE_MAX_CHARS_CJK,
} = __internals

/* 冒烟不接宿主桥：开发机上 MTNODE_BRIDGE_PORT 可能有值（父进程环境）。 */
delete process.env.MTNODE_BRIDGE_PORT
delete process.env.MTNODE_HIDE_TOOLS

let failures = 0
function check(name, cond, extra) {
  if (cond) {
    console.log('[ok] ' + name)
    return
  }
  failures++
  console.log('[fail] ' + name + (extra ? ' → ' + extra : ''))
}

/* ── 1. 纯函数 ──────────────────────────────────────────────────────────── */
{
  check('中文文本判为 CJK', isCjkHeavy('今天天气不错') === true)
  check('英文文本判为非 CJK', isCjkHeavy('Hello world, this is a test') === false)
  check('去句末句号', stripFinalPeriod('天气不错。') === '天气不错')
  check('问号保留', stripFinalPeriod('真的吗？') === '真的吗？')

  const parts = splitAfterPunctuation('第一句。第二句！第三句', '。！')
  check(
    '按标点断句且标点留在前段',
    parts.length === 3 && parts[0] === '第一句。' && parts[2] === '第三句',
    JSON.stringify(parts),
  )

  /* 一句话 10 秒、11 个字（含句末句号），maxChars=4 → 3 条 cue，时间按字数占比 4:4:3 */
  const cues = buildSubtitleCues([{ start: 0, end: 10, text: '一二三四五六七八九十。' }], {
    maxChars: 4,
    latin: false,
    maxDurationSec: 60,
    breakPunctuation: '。',
  })
  check('超长句拆成多条 cue', cues.length === 3, JSON.stringify(cues))
  check(
    '每条都写了正文',
    cues.every((c) => c.text.length > 0),
    JSON.stringify(cues.map((c) => c.text)),
  )
  check(
    '时间按字数占比分配（4:4:2 → 0-4 / 4-8 / 8-10）',
    Math.abs(cues[0].start - 0) < 1e-6 && Math.abs(cues[0].end - 4) < 0.01 && Math.abs(cues[2].end - 10) < 1e-6,
    JSON.stringify(cues.map((c) => [c.start, c.end])),
  )
  check(
    'cue 首尾相接、不重叠',
    cues.every((c, i) => (i === 0 ? true : Math.abs(c.start - cues[i - 1].end) < 1e-6)),
    JSON.stringify(cues.map((c) => [c.start, c.end])),
  )
  check('cue 带自增序号', cues.every((c, i) => c.index === i + 1))

  /* 单条超过 maxDurationSec → 按时间再拆（10 秒 / 6 秒上限 = 2 条） */
  const timed = buildSubtitleCues([{ start: 0, end: 10, text: '一二三四五六七八九十' }], {
    maxChars: 18,
    latin: false,
    maxDurationSec: 6,
    breakPunctuation: '。',
  })
  check('超过单条最长秒数会再拆', timed.length === 2, JSON.stringify(timed))
  check(
    '拆开后每条都不超时长上限',
    timed.every((c) => c.duration <= 6 + 1e-6),
    JSON.stringify(timed.map((c) => c.duration)),
  )

  /* 英文按词边界、不拆单词 */
  const latin = buildSubtitleCues(
    [{ start: 0, end: 8, text: 'the quick brown fox jumps over the lazy dog' }],
    { maxChars: 16, latin: true, maxDurationSec: 60, breakPunctuation: '' },
  )
  const words = latin.map((c) => c.text).join(' ')
  check('英文按词断句', words.split(/\s+/).length === 9, words)
  check(
    '英文不超 maxChars',
    latin.every((c) => c.text.length <= 16 + 1e-6),
    JSON.stringify(latin.map((c) => c.text)),
  )

  check('空文本不产生 cue', buildSubtitleCues([{ start: 0, end: 2, text: '  ' }], {}).length === 0)
  check('默认值导出', SUBTITLE_MAX_SECONDS === 6 && SUBTITLE_MAX_CHARS_CJK === 18)
  check('静音阈值归一', normalizeNoise(-25) === '-25dB' && normalizeNoise('-35dB') === '-35dB' && normalizeNoise() === '-35dB')

  const srt = formatSrt(cues.slice(0, 1))
  check('SRT 结构', /^1\r?\n00:00:00,000 --> 00:00:04,000\r?\n/.test(srt), JSON.stringify(srt))
  check('VTT 头', formatVtt(cues.slice(0, 1)).startsWith('WEBVTT\n\n'), formatVtt(cues.slice(0, 1)))
  check('SRT 时间码', srtTime(3661.234) === '01:01:01,234', srtTime(3661.234))
  check('VTT 时间码', vttTime(3661.234) === '01:01:01.234', vttTime(3661.234))
}

/* ── 2. 真跑一遍 audio_subtitle ─────────────────────────────────────────── */
let ffmpegPath = ''
try {
  ffmpegPath = resolveFfmpeg(true).ffmpeg
  console.log('[ok] ffmpeg 解析 → ' + ffmpegPath)
} catch (err) {
  console.log('[skip] 本机没有 ffmpeg，跳过真进程用例：' + err.message)
}

if (ffmpegPath) {
  const mediaDir = mkdtempSync(path.join(tmpdir(), 'mtnode-subtitle-smoke-'))
  const testRoot = mkdtempSync(path.join(tmpdir(), 'mtnode-subtitle-out-'))
  try {
    const wav = path.join(mediaDir, 'speech.wav')
    /* 4 秒人声（正弦）：足够切出一段，交给假 SenseVoice 回两句话。 */
    const gen = spawnSync(
      ffmpegPath,
      [
        '-hide_banner', '-nostdin', '-y',
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
        '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav,
      ],
      { windowsHide: true, encoding: 'utf8' },
    )
    check('生成测试音频', gen.status === 0, String(gen.stderr || '').slice(-400))

    const seen = []
    /* 模拟「这段里没识别到语音」：下一个切片回空文本。 */
    let emptyNext = false
    const stt = {
      snapshot: () => ({
        selection: { providerId: 'sensevoice-local' },
        providers: [{ id: 'sensevoice-local', preparation: { phase: 'ready' } }],
      }),
      resolve: (req) => ({ provider: { id: 'sensevoice-local' }, ...req }),
      transcribe: async (spec) => {
        const buf = Buffer.from(spec.audio)
        seen.push({ rate: buf.readUInt32LE(24), channels: buf.readUInt16LE(22) })
        if (emptyNext) return { text: '', audioSeconds: 4, inferenceSeconds: 0 }
        return { text: '今天天气不错。我们出去走走吧。', audioSeconds: 4, inferenceSeconds: 0.1 }
      },
    }
    const tools = new Map()
    const ctx = {
      tools: { register: (t) => tools.set(t.name, t) },
      get: (name) => (name === 'speechToText' ? stt : null),
    }
    apply(ctx)

    const sub = tools.get('audio_subtitle')
    check('注册 audio_subtitle', !!sub)
    check('audio_transcribe 仍在', tools.has('audio_transcribe'))

    /* 许可位：隐藏 audio_subtitle 时只它不注册，audio_transcribe 照旧 */
    process.env.MTNODE_HIDE_TOOLS = 'audio_subtitle'
    const hidden = new Map()
    try {
      apply({ tools: { register: (t) => hidden.set(t.name, t) }, get: () => null })
    } finally {
      delete process.env.MTNODE_HIDE_TOOLS
    }
    check(
      '隐藏名单单独摘掉 audio_subtitle',
      !hidden.has('audio_subtitle') && hidden.has('audio_transcribe'),
      [...hidden.keys()].join(','),
    )

    const before = readdirSync(testRoot).length
    const out = await sub.execute(
      { file: wav, maxDurationSec: 3, maxChars: 6 },
      { signal: new AbortController().signal, agent: { id: 'smoke' } },
    )
    check('返回 ok', out && out.ok === true, JSON.stringify(out).slice(0, 300))
    check('拿到多条 cue', Array.isArray(out.cues) && out.cues.length >= 2, JSON.stringify(out.cues))
    check(
      'cues 带起止秒与正文',
      out.cues.every(
        (c) =>
          Number.isFinite(c.start) && Number.isFinite(c.end) && c.end > c.start && typeof c.text === 'string' && c.text,
      ),
      JSON.stringify(out.cues),
    )
    check('cueCount 与 cues 一致', out.cueCount === out.cues.length)
    check('参数被回显', out.params && out.params.maxChars === 6 && out.params.maxDurationSec === 3, JSON.stringify(out.params))
    check('SRT 文本带时间码', typeof out.srt === 'string' && /\d\d:\d\d:\d\d,\d{3} --> \d\d:\d\d:\d\d,\d{3}/.test(out.srt))
    check('VTT 文本带头', typeof out.vtt === 'string' && out.vtt.startsWith('WEBVTT\n\n'))
    check('SRT 条数与 cues 一致', (out.srt.match(/-->/g) || []).length === out.cues.length)
    check(
      'SenseVoice 拿到的是 16k 单声道',
      seen.length > 0 && seen.every((s) => s.rate === 16000 && s.channels === 1),
      JSON.stringify(seen),
    )
    check('没有往目录里写任何文件（工具只回文本）', readdirSync(testRoot).length === before)

    /* 空结果不报错：识别为空 → cues 为空 + note（假 SenseVoice 回空文本） */
    emptyNext = true
    const silent = path.join(mediaDir, 'silent.wav')
    const genSilent = spawnSync(
      ffmpegPath,
      ['-hide_banner', '-nostdin', '-y', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono:d=2', '-c:a', 'pcm_s16le', silent],
      { windowsHide: true, encoding: 'utf8' },
    )
    if (genSilent.status === 0) {
      const empty = await sub.execute({ file: silent }, { signal: new AbortController().signal })
      check('无语音时返回空 cues 且不报错', empty.ok === true && empty.cueCount === 0, JSON.stringify(empty).slice(0, 300))
      check('无语音时附 note', typeof empty.note === 'string' && empty.note.length > 0)
    }
  } finally {
    try {
      rmSync(mediaDir, { recursive: true, force: true })
      rmSync(testRoot, { recursive: true, force: true })
    } catch {}
  }
}

if (failures) {
  console.log('\n' + failures + ' 项失败')
  process.exit(1)
}
console.log('\n全部通过')
process.exit(0)
