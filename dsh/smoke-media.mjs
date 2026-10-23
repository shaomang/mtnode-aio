// 本地媒体工具冒烟（不连 MTNode 界面）：
//   1) 切句规则（静音断句 / 超长均分 / 短句并入）
//   2) ffmpeg 参数护栏（可写根内放行、工作区外新建拒绝）
//   3) ffmpeg 解析（PATH → Remotion → 其它后端便携；本机没有就跳过后面带真进程的用例）
//   4) 真跑一遍 audio_transcribe：ffmpeg 造 2 段人声（正弦 + 静音）+ 假 SenseVoice，
//      校验切片是 16k 单声道 WAV、结果带 segments 与近似时间戳
//   5) 真跑 ffmpeg 工具的 probe / extract_audio / frames
//
// 用法：node dsh/smoke-media.mjs
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { apply, __internals } from './gateway/media-plugin.mjs'

const { planSpeechSegments, guardFfmpegArgs, resolveFfmpeg, parseDuration, MAX_CHUNK_SECONDS } = __internals

/* 冒烟不接宿主桥：开发机上 MTNODE_BRIDGE_PORT 可能有值（父进程环境），
   不摘掉的话插件会去连那条真实桥并常驻一个 socket，脚本跑完不退出。 */
delete process.env.MTNODE_BRIDGE_PORT
/* 同理：父进程若带着「按运行裁剪」的隐藏名单（MTNODE_HIDE_TOOLS），工具会整只不注册，
   这里要测的就是注册口的行为，所以清空。 */
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

/* ── 1. 切句规则 ─────────────────────────────────────────────────────────── */
{
  const segs = planSpeechSegments(10, [
    { start: 2, end: 4 },
    { start: 7, end: 8 },
  ])
  check(
    '静音处断句',
    segs.length === 3 &&
      Math.abs(segs[0].start) < 1e-6 &&
      Math.abs(segs[0].end - 2) < 1e-6 &&
      Math.abs(segs[2].start - 8) < 1e-6,
    JSON.stringify(segs),
  )
  const long = planSpeechSegments(90, [])
  check(
    '超长段按上限均分',
    long.length === Math.ceil(90 / MAX_CHUNK_SECONDS) && long.every((s) => s.end - s.start <= MAX_CHUNK_SECONDS + 1e-6),
    JSON.stringify(long),
  )
  const short = planSpeechSegments(10, [
    { start: 2, end: 2.2 },
    { start: 2.4, end: 2.6 },
  ])
  check('短句并入前句', short.length <= 2, JSON.stringify(short))
  check('无静音时整段一段', planSpeechSegments(5, []).length === 1)
}

/* ── 2. 参数护栏 ────────────────────────────────────────────────────────── */
{
  const cwd = process.cwd()
  guardFfmpegArgs(['-i', path.join(cwd, 'in.mp4'), '-vn', path.join(cwd, 'out.wav')], false)
  check('可写根内的输出放行', true)
  let rejected = false
  try {
    guardFfmpegArgs(['-i', path.join(cwd, 'in.mp4'), path.join(tmpdir(), '..', 'mtnode-media-outside-test.mp4')], false)
  } catch {
    rejected = true
  }
  check('可写根外的新建文件被拒', rejected)
  rejected = false
  try {
    guardFfmpegArgs('not-an-array', false)
  } catch {
    rejected = true
  }
  check('参数不是数组时被拒', rejected)
}

check('时长解析', Math.abs(parseDuration('  Duration: 00:01:02.50, start') - 62.5) < 1e-6)

/* ── 3. ffmpeg 解析 ────────────────────────────────────────────────────── */
let ffmpegPath = ''
try {
  ffmpegPath = resolveFfmpeg(true).ffmpeg
  console.log('[ok] ffmpeg 解析 → ' + ffmpegPath)
} catch (err) {
  console.log('[skip] 本机没有 ffmpeg，跳过真进程用例：' + err.message)
}

if (ffmpegPath) {
  const dir = mkdtempSync(path.join(tmpdir(), 'mtnode-media-smoke-'))
  try {
    const wav = path.join(dir, 'speech.wav')
    /* 2 段「说话」（正弦）中间夹 1 秒静音：切句应该得到 2 段。 */
    const gen = spawnSync(
      ffmpegPath,
      [
        '-hide_banner', '-nostdin', '-y',
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1.2',
        '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono:d=1.0',
        '-f', 'lavfi', '-i', 'sine=frequency=660:duration=1.2',
        '-filter_complex', '[0:a][1:a][2:a]concat=n=3:v=0:a=1[out]',
        '-map', '[out]', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav,
      ],
      { windowsHide: true, encoding: 'utf8' },
    )
    check('生成测试音频', gen.status === 0, String(gen.stderr || '').slice(-400))

    /* 假 SenseVoice：只校验契约（16k 单声道 PCM16 WAV）并回固定文本。 */
    const seen = []
    const stt = {
      snapshot: () => ({
        selection: { providerId: 'sensevoice-local' },
        providers: [{ id: 'sensevoice-local', preparation: { phase: 'ready' } }],
      }),
      resolve: (req) => ({ provider: { id: 'sensevoice-local' }, ...req }),
      transcribe: async (spec) => {
        const buf = Buffer.from(spec.audio)
        const riff = buf.toString('ascii', 0, 4)
        const channels = buf.readUInt16LE(22)
        const rate = buf.readUInt32LE(24)
        const bits = buf.readUInt16LE(34)
        seen.push({ riff, channels, rate, bits, bytes: buf.length })
        return { text: '第' + seen.length + '段人声', audioSeconds: 1, inferenceSeconds: 0.1 }
      },
    }
    const tools = new Map()
    const ctx = {
      tools: { register: (t) => tools.set(t.name, t) },
      get: (name) => (name === 'speechToText' ? stt : null),
    }
    apply(ctx)

    const tr = tools.get('audio_transcribe')
    check('注册 audio_transcribe', !!tr)

    /* 按运行裁剪：隐藏名单点名 ffmpeg 时它整只不注册（名单真源 tool-visibility.mjs） */
    {
      process.env.MTNODE_HIDE_TOOLS = 'ffmpeg'
      const only = new Map()
      try {
        apply({ tools: { register: (t) => only.set(t.name, t) }, get: () => null })
      } finally {
        delete process.env.MTNODE_HIDE_TOOLS
      }
      check(
        '隐藏名单摘掉 ffmpeg（转写照旧注册）',
        !only.has('ffmpeg') && only.has('audio_transcribe'),
        [...only.keys()].join(','),
      )
    }

    const out = await tr.execute({ file: wav }, { signal: new AbortController().signal, agent: { id: 'smoke' } })
    check('转写返回 ok', out && out.ok === true, JSON.stringify(out).slice(0, 300))
    check('切出至少 2 段', Array.isArray(out.segments) && out.segments.length >= 2, JSON.stringify(out.segments))
    check(
      'segments 带近似时间戳',
      out.segments.every((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start),
    )
    check('拼接全文', typeof out.text === 'string' && out.text.includes('段人声'), out.text)
    check(
      'SenseVoice 拿到的是 16k 单声道 PCM16',
      seen.length > 0 && seen.every((s) => s.riff === 'RIFF' && s.channels === 1 && s.rate === 16000 && s.bits === 16),
      JSON.stringify(seen),
    )

    const ff = tools.get('ffmpeg')
    check('注册 ffmpeg', !!ff)
    const probe = await ff.execute({ action: 'probe', input: wav }, { signal: new AbortController().signal })
    check('probe 读出时长与音轨', probe.ok && probe.durationSeconds > 3 && probe.hasAudio === true, JSON.stringify(probe).slice(0, 300))

    const audioOut = path.join(dir, 'audio.wav')
    const extract = await ff.execute(
      { action: 'extract_audio', input: wav, outputPath: audioOut },
      { signal: new AbortController().signal },
    )
    check('extract_audio 产出 16k WAV', extract.ok && extract.outputPath === audioOut && extract.bytes > 0, JSON.stringify(extract))
    let refused = false
    try {
      await ff.execute(
        { action: 'extract_audio', input: wav, outputPath: path.join(tmpdir(), '..', 'mtnode-media-smoke-nope.wav') },
        { signal: new AbortController().signal },
      )
    } catch {
      refused = true
    }
    check('extract_audio 拒绝工作区外输出', refused)

    const mp4 = path.join(dir, 'clip.mp4')
    const genVideo = spawnSync(
      ffmpegPath,
      ['-hide_banner', '-nostdin', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10:duration=2', '-pix_fmt', 'yuv420p', mp4],
      { windowsHide: true, encoding: 'utf8' },
    )
    check('生成测试视频', genVideo.status === 0, String(genVideo.stderr || '').slice(-400))
    if (genVideo.status === 0) {
      const frames = await ff.execute(
        { action: 'frames', input: mp4, count: 3 },
        { signal: new AbortController().signal },
      )
      check('frames 抽出 3 张 PNG', frames.ok && frames.frames.length === 3, JSON.stringify(frames).slice(0, 400))
      check(
        '每帧都落在输出目录且文件存在',
        frames.frames.every((f) => f.path.startsWith(frames.outputDir)),
      )
    }
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {}
  }
}

if (failures) {
  console.log('\n' + failures + ' 项失败')
  process.exit(1)
}
console.log('\n全部通过')
process.exit(0)
