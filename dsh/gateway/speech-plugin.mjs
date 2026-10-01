// MTNode 语音输入面（runs INSIDE the dsh runtime process）—— 把 dsh 0.2 的实验语音转写
// 能力接到 MTNode 自己的录音界面（上游 @deepseek-ai/dsh-experimental-client-ui-voice-input
// 是 Web 前端的插件包，MTNode 渲染层是无框架 SVG，界面自研，服务照官方接）。
//
// 与 bridge-plugin.mjs 的区别（为什么另开一条通道）：
//   bridge-plugin 的帧要过网关的**轮次归属门控**（只有正在跑的这一轮发起的交互才放行），
//   而录音是用户在想说话的那一刻发起的、与任何一轮都无关。所以这里另起一条 TCP 侧通道：
//   spawn 时网关把端口经 MTNODE_SPEECH_PORT 注入，插件主动连过去，网关按 workspace 记这只
//   socket，随时可以点名让运行时做一件事。
//
// 依赖的服务（dsh 0.2，全部由 cordis.yml 的同名行提供）：
//   ctx.speechToText —— 服务定义/注册表（@deepseek-ai/dsh-experimental-speech-to-text）
//     · listProviders() / snapshot()  读提供者与准备状态
//     · prepare(id, {downloadSource})  首次使用下载权重（revision 钉死 + SHA256 校验）
//     · cancelPreparation(id)          取消下载
//     · resolve({audio, language}) → spec；transcribe(spec, signal) → { text, … }
//   音频契约：**16 kHz 单声道 PCM16 WAV**（官方 ./wave 的 validateWave 口径），
//   非该格式由原生侧直接拒绝，绝不猜格式。
//
// 协议（换行分隔 JSON；帧可含 base64 音频，体积可控——16kHz 单声道每秒 32KB）：
//   gateway → plugin: { t:'speech', id, action:'state'|'prepare'|'cancel'|'transcribe',
//                       providerId?, downloadSource?, language?, audio? (base64 WAV) }
//   plugin → gateway: { t:'speech-ok', id, result }
//                     { t:'speech-err', id, error }
//                     { t:'speech-state', state }        （准备状态变化，主动推）
//
// 端口缺席 / 服务缺席 / 老运行时 = 整体 no-op（apply 直接 return），行为与未接入时一字不变。

import { createConnection } from 'node:net'

export const name = 'mtnode-speech'
export const inject = ['speechToText']

/** 透传的准备状态里允许出现的字段（官方 SpeechPreparationState 的就地白名单） */
const PHASES = new Set([
  'unprepared',
  'ready',
  'standby',
  'cancelled',
  'downloading',
  'checking',
  'loading',
  'waking',
  'cancelling',
  'failed',
])

/**
 * 把官方 SpeechPreparationState 剪成可以过线的形状（去掉 undefined 与未知字段）。
 * @param {any} state - 官方状态值。
 * @returns {object} 可 JSON 序列化的状态。
 */
function slimState(state) {
  const s = state && typeof state === 'object' ? state : {}
  const out = { phase: PHASES.has(s.phase) ? s.phase : 'unprepared' }
  if (typeof s.resource === 'string') out.resource = s.resource
  if (Number.isFinite(s.completedBytes)) out.completedBytes = s.completedBytes
  if (Number.isFinite(s.totalBytes)) out.totalBytes = s.totalBytes
  if (Number.isFinite(s.startedAt)) out.startedAt = s.startedAt
  if (typeof s.message === 'string') out.message = s.message
  if (typeof s.step === 'string') out.step = s.step
  if (Array.isArray(s.steps)) {
    out.steps = s.steps.slice(0, 8).map((x) => ({
      kind: String((x && x.kind) || ''),
      status: String((x && x.status) || ''),
    }))
  }
  if (s.download && typeof s.download === 'object') {
    out.download = {
      resource: String(s.download.resource || ''),
      source: String(s.download.source || ''),
      reason: String(s.download.reason || 'unknown'),
      ...(s.download.code !== undefined ? { code: String(s.download.code) } : {}),
      ...(Number.isFinite(s.download.status) ? { status: s.download.status } : {}),
    }
  }
  return out
}

/**
 * 读一张可以过线的完整快照：提供者名单（含下载源与语言）+ 当前选中项。
 * @param {any} stt - ctx.speechToText
 * @returns {object} { providers, selection }
 */
function snapshotOf(stt) {
  let snap = { providers: [], selection: { providerId: '', language: '' } }
  try {
    snap = stt.snapshot() || snap
  } catch {
    /* 读不到就回空名单：界面据此显示「语音输入不可用」，而不是崩掉 */
  }
  const providers = Array.isArray(snap.providers) ? snap.providers : []
  return {
    providers: providers.map((p) => ({
      id: String((p && p.id) || ''),
      name: String((p && p.name) || ''),
      location: String((p && p.location) || ''),
      languages: Array.isArray(p && p.languages) ? p.languages.slice(0, 16) : [],
      downloadSources: Array.isArray(p && p.downloadSources) ? p.downloadSources.slice(0, 8) : [],
      preparation: slimState(p && p.preparation),
      ...(p && p.setupEstimate && typeof p.setupEstimate === 'object'
        ? {
            setupEstimate: {
              recommendedDiskBytes: Number(p.setupEstimate.recommendedDiskBytes || 0),
              expectedMemoryBytes: Number(p.setupEstimate.expectedMemoryBytes || 0),
              minimumMinutes: Number(p.setupEstimate.minimumMinutes || 0),
              maximumMinutes: Number(p.setupEstimate.maximumMinutes || 0),
            },
          }
        : {}),
    })),
    selection: {
      providerId: String((snap.selection && snap.selection.providerId) || ''),
      language: String((snap.selection && snap.selection.language) || ''),
    },
  }
}

/**
 * @param {any} ctx - 运行时的根上下文。
 */
export function apply(ctx) {
  const port = Number(process.env.MTNODE_SPEECH_PORT || 0)
  if (!Number.isInteger(port) || port <= 0) return

  let socket = null
  let buf = ''
  /** @type {Map<string, {resolve:(v:any)=>void, reject:(e:Error)=>void, ctrl:AbortController}>} */
  const pending = new Map()

  const send = (obj) => {
    if (!socket || socket.destroyed) return
    try {
      socket.write(JSON.stringify(obj) + '\n')
    } catch {
      /* 网关没了：在途请求由 onclose 统一收尾 */
    }
  }

  /** 自检留痕：网关把运行时的 stderr 逐行写进宿主的 dsh.log（与其它 MTNode 插件同口径）。 */
  const diag = (msg) => {
    try {
      console.error('[ix-speech] ' + String(msg))
    } catch {
      /* 没有 console / 写失败都不该影响通道 */
    }
  }

  const failAll = (err) => {
    for (const [id, p] of pending) {
      pending.delete(id)
      try {
        p.ctrl.abort()
      } catch {}
      p.reject(err)
    }
  }

  /* 准备状态变化主动推给网关（界面据此画进度条）。官方 follow() 要 AbortSignal 且是
     异步迭代器，这里只取「变了就推最新快照」，不保留历史。
     **必须等 hello 发出去之后才开**：网关按首帧认这条 socket（见 gateway.mjs），
     若首帧先到一帧 speech-state，这条连接就会被当成交互桥，语音通道永远「未就绪」。 */
  const ctrl = new AbortController()
  const startFollow = () => {
    void (async () => {
      try {
        for await (const _snap of ctx.speechToText.follow(ctrl.signal)) {
          send({ t: 'speech-state', state: snapshotOf(ctx.speechToText) })
        }
      } catch {
        /* follow 的取消/服务卸载都会走到这里，静默即可 */
      }
    })()
  }

  const b64ToBytes = (b64) => {
    const clean = String(b64 || '').replace(/\s+/g, '')
    if (!clean) throw new Error('录音内容为空')
    return new Uint8Array(Buffer.from(clean, 'base64'))
  }

  const onLine = async (line) => {
    let m
    try {
      m = JSON.parse(line)
    } catch {
      return
    }
    if (!m || m.t !== 'speech' || typeof m.id !== 'string') return
    const id = m.id
    try {
      const action = String(m.action || 'state')
      if (action === 'cancel') {
        /* 取消分两层：取消这次请求本身（abort），以及取消在跑的准备任务 */
        const p = pending.get(id)
        if (p) {
          pending.delete(id)
          p.ctrl.abort()
          p.resolve({ cancelled: true })
        }
        const pid = String(m.providerId || '') || snapshotOf(ctx.speechToText).selection.providerId
        const st = snapshotOf(ctx.speechToText).providers.find((x) => x.id === pid)
        if (st && /^(unprepared|failed|cancelled)$/.test(st.preparation.phase)) {
          send({ t: 'speech-ok', id, result: snapshotOf(ctx.speechToText) })
          return
        }
        try {
          await ctx.speechToText.cancelPreparation(pid)
        } catch {
          /* 没有在跑的准备任务：当作已取消 */
        }
        send({ t: 'speech-ok', id, result: snapshotOf(ctx.speechToText) })
        return
      }

      if (action === 'state') {
        send({ t: 'speech-ok', id, result: snapshotOf(ctx.speechToText) })
        return
      }

      if (action === 'prepare') {
        const pid = String(m.providerId || '') || snapshotOf(ctx.speechToText).selection.providerId
        /* prepare 是「开始或加入当前准备任务」，立即返回；进度经 speech-state 帧推。
           downloadSource 只在用户显式选了源时下发（单源 = 不探测、不回退）。 */
        const opts = m.downloadSource ? { downloadSource: String(m.downloadSource) } : undefined
        ctx.speechToText.prepare(pid, opts)
        send({ t: 'speech-ok', id, result: snapshotOf(ctx.speechToText) })
        return
      }

      if (action === 'transcribe') {
        const ctrlReq = new AbortController()
        pending.set(id, { resolve: () => {}, reject: () => {}, ctrl: ctrlReq })
        if (!socket || socket.destroyed) {
          pending.delete(id)
          throw new Error('语音通道未连接')
        }
        const audio = b64ToBytes(m.audio)
        /* resolve() 会按 composition 默认 provider / language 补全，并在选中的
           provider 不支持该语言时显式报错（不静默换一个识别器）。 */
        const spec = ctx.speechToText.resolve({
          audio,
          ...(m.providerId ? { providerId: String(m.providerId) } : {}),
          ...(m.language ? { language: String(m.language) } : {}),
        })
        const out = await ctx.speechToText.transcribe(spec, ctrlReq.signal)
        pending.delete(id)
        send({
          t: 'speech-ok',
          id,
          result: {
            text: String((out && out.text) || ''),
            audioSeconds: Number((out && out.audioSeconds) || 0),
            inferenceSeconds: Number((out && out.inferenceSeconds) || 0),
          },
        })
        return
      }

      send({ t: 'speech-err', id, error: `unknown speech action: ${action}` })
    } catch (err) {
      pending.delete(id)
      send({ t: 'speech-err', id, error: String((err && err.message) || err) })
    }
  }

  const connect = () => {
    const s = createConnection({ host: '127.0.0.1', port })
    socket = s
    s.on('data', (d) => {
      buf += d.toString()
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (line) void onLine(line)
      }
    })
    /* 通知服务器这只 socket 是语音通道（与交互桥共用同一台 TCP 服务，靠首行区分）。
       hello 必须**先于任何其它帧**到达网关；所以 follow() 也在这里才启动。 */
    s.on('connect', () => {
        try {
        s.write(JSON.stringify({ t: 'speech-hello', token: String(process.env.MTNODE_SPEECH_TOKEN || '') }) + '\n')
      } catch {}
      /* 自检留痕（宿主的 dsh.log 里能直接看出来「这台运行时到底有没有识别器」）：
         providers 为空 = 语音行没装配成功，界面只能显示「语音服务不可用」而看不出为什么。
         这里把提供者名单与 SenseVoice 权重是否就位写一行 stderr，排障不必再猜。 */
      try {
        const snap = snapshotOf(ctx.speechToText)
        const names = snap.providers.map((p) => p.id + '/' + (p.preparation && p.preparation.phase)).join(',')
        diag('speech providers=' + snap.providers.length + (names ? ' [' + names + ']' : ' []'))
      } catch (err) {
        diag('speech providers 读取失败: ' + String((err && err.message) || err))
      }
      startFollow()
    })
    s.on('error', () => {})
    s.on('close', () => {
      if (socket === s) socket = null
      buf = ''
      failAll(new Error('语音通道已断开'))
      setTimeout(connect, 2000)
    })
  }
  connect()

  /* 运行时卸载时收掉这条通道（与 follow 的 abort 一起） */
  ctx.effect(() => () => {
    ctrl.abort()
    try {
      socket?.destroy()
    } catch {}
  })
}
