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
  splitScriptSentences,
  alignScriptToAsr,
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

  /* 原台词（切分模式）与保留标点：纯函数这一层 */
  const kept = buildSubtitleCues([{ start: 0, end: 2, text: '你好。' }], { keepPunctuation: true })
  check('keepPunctuation:true 保留句末句号', kept[0] && kept[0].text === '你好。', JSON.stringify(kept))
  const sents = splitScriptSentences('第一句。第二句。\n第三句。', '。')
  check(
    '台词按标点 + 换行断句（换行是强制断句点）',
    sents.length === 3 && sents[2] === '第三句。',
    JSON.stringify(sents),
  )
  const aligned = alignScriptToAsr(
    ['第一句。', '第二句。'],
    [
      { start: 0, end: 1, text: '第一句' },
      { start: 1, end: 2, text: '第二句' },
    ],
  )
  check(
    '台词与识别段单调对齐（正文取台词、时间取语音段）',
    aligned.pairs.length === 2 && aligned.pairs[0].text === '第一句。' && aligned.pairs[1].start === 1,
    JSON.stringify(aligned),
  )
  check(
    '没念到的台词进 unmatchedScript（跳过不报错）',
    alignScriptToAsr(['第一句。', '没念到的一句。'], [{ start: 0, end: 1, text: '第一句' }]).unmatchedScript
      .length === 1,
  )
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
        /* 用户现场「Invalid speech WAV」的回归门：ffmpeg 切出来的 WAV 带 LIST(INFO ISFT) 块，
           官方 validateWave 只认标准 44 字节头 —— 送进识别器前必须已归一。 */
        check(
          '送进识别器的是标准 44 字节头 WAV（LIST 元数据块已剥掉）',
          buf.toString('ascii', 36, 40) === 'data' &&
            buf.readUInt32LE(40) === buf.length - 44 &&
            buf.readUInt32LE(4) === buf.length - 8,
          JSON.stringify({ hdr36: buf.toString('ascii', 36, 40), len: buf.length }),
        )
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

    /* 原台词切分模式（真 ffmpeg 切句 + 假 SenseVoice）：正文必须取自台词，不吃识别错字 */
    const script = '今天天气真不错。我们出去走走吧。\n这句没念到。'
    const scripted = await sub.execute(
      { file: wav, script, keepPunctuation: true },
      { signal: new AbortController().signal, agent: { id: 'smoke' } },
    )
    check('切分模式生效（mode=script）', scripted && scripted.ok === true && scripted.mode === 'script', JSON.stringify(scripted).slice(0, 300))
    check(
      '每条 cue 的正文都是原台词里的片段（识别错字不进字幕）',
      !!(scripted && scripted.cues && scripted.cues.length) &&
        scripted.cues.every((c) => script.indexOf(String(c.text)) >= 0),
      JSON.stringify(scripted && scripted.cues),
    )
    check(
      'cue 标记 source=script',
      !!(scripted && scripted.cues) && scripted.cues.every((c) => c.source === 'script'),
      JSON.stringify(scripted && scripted.cues),
    )
    check(
      '保留标点 = true 时最后一条 cue 仍带 。',
      !!(scripted && scripted.cues && scripted.cues.length) && /。$/.test(scripted.cues[scripted.cues.length - 1].text),
      JSON.stringify(scripted && scripted.cues),
    )
    check(
      '没念到的台词进 unmatchedScript',
      !!(scripted && Array.isArray(scripted.unmatchedScript)) && scripted.unmatchedScript.indexOf('这句没念到。') >= 0,
      JSON.stringify(scripted && scripted.unmatchedScript),
    )
    check(
      '识别原文写进 asrText（供对照）',
      !!(scripted && typeof scripted.asrText === 'string') && scripted.asrText.indexOf('今天天气不错') >= 0,
      JSON.stringify(scripted && scripted.asrText),
    )

    /* 自动启用：语音运行时刚被拉起时识别器还没注册（providers 为空）——工具应自己等它出现，
       不许报「请先启用 / 确认语音输入可用」这类要用户动手的文案。 */
    let lazyStates = 0
    const lazyStt = {
      snapshot: () => {
        lazyStates++
        if (lazyStates <= 1) return { selection: {}, providers: [] }
        return {
          selection: { providerId: 'sensevoice-local' },
          providers: [{ id: 'sensevoice-local', preparation: { phase: 'ready' } }],
        }
      },
      resolve: (req) => ({ provider: { id: 'sensevoice-local' }, ...req }),
      transcribe: async () => ({ text: '自动就绪的一句。', audioSeconds: 4, inferenceSeconds: 0.1 }),
    }
    const autoTools = new Map()
    apply({
      tools: { register: (t) => autoTools.set(t.name, t) },
      get: (n) => (n === 'speechToText' ? lazyStt : null),
    })
    const autoSub = autoTools.get('audio_subtitle')
    const auto = autoSub
      ? await autoSub.execute({ file: wav }, { signal: new AbortController().signal })
      : { ok: false, error: 'audio_subtitle 未注册' }
    check(
      '识别器晚注册 → 自动等到就绪再转写（无需手动启用）',
      auto && auto.ok === true && lazyStates >= 2,
      JSON.stringify(auto).slice(0, 300),
    )

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
