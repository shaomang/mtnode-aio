// 交互桥「归属门控」冒烟测试。
//
// 不起真实模型、不联网、不起真实运行时进程。本文件把网关(dsh/gateway/gateway.mjs)
// 装进自己的进程里跑,只伪造它接触外界的四条道:
//   · stdin / stdout / stderr —— 本地协议(主进程 ↔ 网关)的换行分隔 JSON,以及
//                                网关写在 stderr 上的 [ix-gate] 诊断
//   · child_process.spawn     —— 「运行时子进程」换成一个只会讲 JSON-RPC 的桩
//                                (initialize / session/prompt / shutdown),既不烧 token,
//                                也不会被真实模型时延拖成 flake
//   · net.Server.listen       —— 交互桥端口由网关自己挑(listen(0)),在这里抄下来直连
// 于是测试桩同时扮演两端:上游 = MTNode 主进程(发 run / interact / cancel),
// 下游 = 运行时里的 mtnode-bridge / mtnode-canvas / mtnode-db 插件(连上桥端口喂假帧)。
//
// 断言(对应「开发任务跑一小会儿突然多出一个询问窗、回答后执行无效」这条 bug 的修复面):
//  [1] 空 input 直接 error('任务内容为空') + done,不 spawn 运行时、不建桥
//  [2] 本轮 session 的 question / approval / canvas / db 帧能以【正确 reqId】投递,
//      并能经 interact 原路回到插件 —— 回归护栏:onBridgeFrame 末行曾引用已被改名的
//      reqId 变量,ESM 严格模式 ReferenceError,网关一投交互帧就整体退出(门控形同虚设)
//  [3] 预热轮 session(warm)、会话树之外(foreign)、以及 canvas / db 没盖章(no-sid,
//      fail closed)的帧一律 abort,且一个事件都不外泄给渲染层
//  [4] 处理器内部抛异常只作废那一帧,网关进程继续活着
//  [5] run 正常收尾与 closeBridge 时,仍挂起的 canvas / db 帧同样被撤帧(abort + ix-drop);
//      上一轮遗留的迟到帧分类为 stale 并被拒
//
// 跑法:node dsh/smoke-interaction-gate.mjs   (MTNODE_SMOKE_VERBOSE=1 可看网关 stderr 原行)
import net from 'node:net'
import path from 'node:path'
import { createRequire } from 'node:module'
import { PassThrough } from 'node:stream'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const GATEWAY = path.resolve(import.meta.dirname, 'gateway', 'gateway.mjs')
/* 冒烟现场:与 smoke-gateway.mjs 的 smoke-home / smoke-ws 分开,互不污染(均已 gitignore) */
const HOME = path.resolve(import.meta.dirname, 'smoke-home-gate')
const WS = path.resolve(import.meta.dirname, 'smoke-ws-gate')
/* 预热轮的提示词就是这条 'ok'(见 handleRun 的 fresh 分支),据此把两轮区分开 */
const WARM_TEXT = 'ok'

const realOut = process.stdout.write.bind(process.stdout)
const realErr = process.stderr.write.bind(process.stderr)
/* 真 stdin 是只读的 ReadStream,写不进请求:换成可控流(必须在 import 网关之前换,
   网关顶层的 createInterface({input: process.stdin}) 抓的就是这一刻的对象) */
const hostIn = new PassThrough()
Object.defineProperty(process, 'stdin', { value: hostIn, configurable: true, writable: true })
const say = (s) => realOut(s + '\n')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let passed = 0
function fail(msg) {
  say('[fail] ' + msg)
  process.exit(1)
}
function ok(cond, msg) {
  if (!cond) fail(msg)
  passed++
  say('  ✓ ' + msg)
}
async function waitFor(fn, what, budgetMs = 20000) {
  const t0 = Date.now()
  for (;;) {
    if (fn()) return
    if (Date.now() - t0 > budgetMs) fail('等不到:' + what)
    await sleep(20)
  }
}
setTimeout(() => fail('总超时:冒烟未在 120s 内跑完'), 120000)
process.on('uncaughtException', (err) => fail('uncaught: ' + String((err && err.stack) || err)))

/* ── 钩子 1:stdout(网关的协议信道)与 stderr([ix-gate] 诊断) ───────────── */
const events = []          // 网关推出的本地协议事件 {reqId, type, data}
const eventWaiters = []
const pending = new Map()  // 本地协议请求 id → resolve
const diagLines = []       // 网关 stderr 行(门控判词的出处)
let reqSeq = 0
/* 命中该正则的那次 stdout 写入抛异常:精确模拟「网关处理这一帧时自己炸了」 */
let crashPattern = null

let outBuf = ''
let draining = false
process.stdout.write = function (chunk, enc, cb) {
  const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
  if (crashPattern && crashPattern.test(text)) {
    crashPattern = null
    throw new Error('smoke: 模拟网关在处理交互帧时自身抛错')
  }
  outBuf += text
  if (draining) return true
  draining = true
  try {
    let i
    while ((i = outBuf.indexOf('\n')) >= 0) {
      const line = outBuf.slice(0, i).trim()
      outBuf = outBuf.slice(i + 1)
      if (!line) continue
      let m
      try { m = JSON.parse(line) } catch { continue }
      if (!m || typeof m !== 'object') continue
      if (m.event) {
        events.push(m.event)
        for (const w of eventWaiters.slice()) {
          if (w.pred(m.event)) {
            const k = eventWaiters.indexOf(w)
            if (k >= 0) eventWaiters.splice(k, 1)
            w.resolve(m.event)
          }
        }
        continue
      }
      if (pending.has(m.id)) {
        const r = pending.get(m.id)
        pending.delete(m.id)
        r(m)
      }
    }
  } finally {
    draining = false
  }
  if (typeof enc === 'function') enc()
  else if (typeof cb === 'function') cb()
  return true
}

let errBuf = ''
process.stderr.write = function (chunk, enc, cb) {
  errBuf += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
  let i
  while ((i = errBuf.indexOf('\n')) >= 0) {
    const line = errBuf.slice(0, i).trim()
    errBuf = errBuf.slice(i + 1)
    if (!line) continue
    diagLines.push(line)
    if (process.env.MTNODE_SMOKE_VERBOSE) realErr('[gw] ' + line + '\n')
  }
  if (typeof enc === 'function') enc()
  else if (typeof cb === 'function') cb()
  return true
}

/* ── 钩子 2:交互桥端口(网关 listen(0) 自选端口,测试抄下来直连) ─────────── */
const bridgePorts = []
const origListen = net.Server.prototype.listen
net.Server.prototype.listen = function (...a) {
  const r = origListen.apply(this, a)
  this.once('listening', () => {
    const ad = this.address()
    if (ad && ad.port) bridgePorts.push(ad.port)
  })
  return r
}

/* ── 钩子 3:假运行时子进程(只讲 SDK 那套换行 JSON-RPC) ─────────────────── */
const spawned = []
function fakeRuntime(command, args, options) {
  const stdin = new PassThrough()    // 网关 → 运行时(transport.output)
  const stdout = new PassThrough()   // 运行时 → 网关(transport.input)
  const stderr = new PassThrough()
  const child = Object.assign(new PassThrough(), {
    pid: 424242,
    stdin,
    stdout,
    stderr,
    exitCode: null,
    signalCode: null,
    connected: true,
    kill: () => (die(), true),
    unref: () => {},
    ref: () => {},
  })
  let dead = false
  function die() {
    if (dead) return
    dead = true
    stdout.end()
    stderr.end()
    child.exitCode = 0
    child.emit('exit', 0)
    child.emit('close')
  }
  const notify = (method, params) => stdout.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
  const reply = (id, result) => stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
  /* 每次 session/prompt 记一条:预热轮与真实轮的 sessionId、提示词都不同 */
  const prompts = []
  const goIdle = (p) => {
    /* SDK 只认「本轮的入箱回执」之后的通知,收束条件是 session.status = idle */
    notify('session.event', {
      sessionId: p.sessionId,
      event: { type: 'agent/inbox/spliced', time: Date.now(), data: { inserted: [{ id: p.messageId }] } },
    })
    notify('session.status', { sessionId: p.sessionId, status: 'idle' })
  }
  let buf = ''
  stdin.on('data', (d) => {
    buf += d.toString()
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (!line) continue
      let m
      try { m = JSON.parse(line) } catch { continue }
      if (!m || typeof m.method !== 'string') continue
      if (m.method === 'initialize') {
        reply(m.id, { serverInfo: { name: 'smoke-fake-runtime', version: '0.0.0' } })
      } else if (m.method === 'session/prompt') {
        const first = (m.params.contentBlocks || [])[0] || {}
        const p = {
          sessionId: String(m.params.sessionId || ''),
          messageId: 'msg-' + (prompts.length + 1),
          text: String(first.text || ''),
        }
        prompts.push(p)
        reply(m.id, { messageId: p.messageId })
        /* 预热轮立刻收束(否则要白等网关 15s 预热超时);真实轮挂在途,把窗口留给断言 */
        if (p.text === WARM_TEXT) goIdle(p)
      } else if (m.method === 'shutdown') {
        reply(m.id, {})
        die()
      } else if (m.id !== undefined) {
        reply(m.id, {})
      }
    }
  })
  stdin.on('end', () => die())
  let realSettled = 0
  child.__smoke = {
    prompts,
    /* 放掉真实轮:让它走正常收尾(→ done 事件 → releaseClaim → abortBridgePending) */
    finishRealRun: () => {
      const real = prompts.filter((p) => p.text !== WARM_TEXT)
      if (realSettled >= real.length) return false
      goIdle(real[realSettled++])
      return true
    },
    launch: { command, args, cwd: options && options.cwd },
  }
  return child
}
const cp = require('node:child_process')
cp.spawn = function (command, args, options) {
  const c = fakeRuntime(command, args, options)
  spawned.push(c)
  return c
}

/* ── 本地协议客户端(扮演 MTNode 主进程) ─────────────────────────────────── */
function req(method, params, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const id = ++reqSeq
    pending.set(id, resolve)
    hostIn.write(JSON.stringify({ id, method, params }) + '\n')
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id)
        reject(new Error('超时,没有回包: ' + method))
      }
    }, timeoutMs)
  })
}
function nextEvent(pred, ms, what) {
  const hit = events.find(pred)
  if (hit) return Promise.resolve(hit)
  return new Promise((resolve, reject) => {
    const w = { pred, resolve }
    eventWaiters.push(w)
    setTimeout(() => {
      const i = eventWaiters.indexOf(w)
      if (i >= 0) eventWaiters.splice(i, 1)
      reject(new Error('等不到事件: ' + what))
    }, ms)
  })
}
const evById = (t, id) => (e) => e.type === t && !!e.data && e.data.id === id
const anyById = (id) => (e) => !!e.data && e.data.id === id
const diagHit = (re) => diagLines.some((l) => re.test(l))

/* ── 桥连接客户端(扮演运行时里的 mtnode-bridge / canvas / db 插件) ───────── */
function connectBridge(port) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: '127.0.0.1', port })
    sock.once('error', reject)
    sock.once('connect', () => {
      sock.removeListener('error', reject)
      resolve(wrapBridge(sock))
    })
  })
}
function wrapBridge(sock) {
  const frames = []
  const waiters = []
  let buf = ''
  sock.on('error', () => {})
  sock.on('data', (d) => {
    buf += d.toString()
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (!line) continue
      let m
      try { m = JSON.parse(line) } catch { continue }
      frames.push(m)
      for (const w of waiters.slice()) {
        if (w.pred(m)) {
          const k = waiters.indexOf(w)
          if (k >= 0) waiters.splice(k, 1)
          w.resolve(m)
        }
      }
    }
  })
  return {
    frames,
    send: (o) => sock.write(JSON.stringify(o) + '\n'),
    next(pred, ms, what) {
      const hit = frames.find(pred)
      if (hit) return Promise.resolve(hit)
      return new Promise((resolve, reject) => {
        const w = { pred, resolve }
        waiters.push(w)
        setTimeout(() => {
          const i = waiters.indexOf(w)
          if (i >= 0) waiters.splice(i, 1)
          reject(new Error('收不到桥帧: ' + what))
        }, ms)
      })
    },
    hasAbort: (id) => frames.some((f) => f.t === 'abort' && f.id === id),
    close: () => sock.destroy(),
  }
}

/* 一条越权帧应有的下场:桥侧收到 abort(插件据此 reject,工具以失败收场),
   渲染层一个事件都收不到 —— 收不到才是对的,弹出去就是个答案送不回任何人的死框 */
async function expectRejected(b, id, label) {
  await b.next((f) => f.t === 'abort' && f.id === id, 3000, 'abort ' + id)
  await sleep(100)
  if (events.some(anyById(id))) fail(label + ' 被拒了却还是推给了渲染层')
  ok(true, label + ' → abort,不外泄事件')
}
/* 一条本轮帧应有的下场:以正确 reqId 推给渲染层,且桥侧不被 abort */
async function expectDelivered(b, id, type, reqId, label) {
  const e = await nextEvent(evById(type, id), 3000, type + ' ' + id)
  if (e.reqId !== reqId) fail(label + ' 的 reqId 错了:' + String(e.reqId) + ' ≠ ' + reqId)
  await sleep(100)
  if (b.hasAbort(id)) fail(label + ' 既被投递又被 abort,语义矛盾')
  ok(true, label + ' → 事件 ' + type + '(reqId=' + e.reqId + ')')
  return e
}

/* ── 开跑:把网关装进本进程(钩子已全部就位,此刻才 import) ──────────────── */
process.env.DSH_HOME = HOME
await import(pathToFileURL(GATEWAY).href)
say('== 交互桥归属门控冒烟(网关进程内 + 假运行时,无模型 / 无网络)==')

const st = await req('status')
if (!(st && st.ok && st.result && st.result.gateway)) fail('本地协议没通:status → ' + JSON.stringify(st))
ok(true, '本地协议可用:status → gateway ' + st.result.gateway)

/* [1] 空 input:护栏在,不 spawn 运行时、不建桥 */
await req('run', { reqId: 'smoke-empty', workspace: WS, input: '   ', model: 'deepseek-v4-flash' })
const emptyErr = await nextEvent((e) => e.reqId === 'smoke-empty' && e.type === 'error', 5000, 'error(空任务)')
if (!/任务内容为空/.test(String(emptyErr.data && emptyErr.data.message))) {
  fail('空 input 报的不是「任务内容为空」:' + JSON.stringify(emptyErr.data))
}
await nextEvent((e) => e.reqId === 'smoke-empty' && e.type === 'done', 5000, 'done(空任务)')
await sleep(150)
ok(spawned.length === 0 && bridgePorts.length === 0, '[1] 空 input 直接报错,不 spawn 运行时、不建交互桥')

/* [2] 起一轮在途的真实运行(假运行时挂在途不放行 → 归属窗口稳定) */
const RUN1 = 'smoke-run-1'
const TAG1 = 'smoke-gate-1'
await req('run', {
  reqId: RUN1, workspace: WS, input: '门控冒烟:这一轮不该收到别人的询问窗',
  model: 'deepseek-v4-flash', maxTokens: 4096, apiKey: 'smoke-not-a-real-key',
  baseUrl: 'http://127.0.0.1:9', systemPrompt: '', dshHome: HOME,
  permissionPreset: 'mtnode-unattended', cancelTag: TAG1,
})
await waitFor(() => bridgePorts.length > 0, '交互桥端口')
const rt = spawned[0]
if (!rt) fail('桥端口起来了,运行时却没 spawn')
const prompts = rt.__smoke.prompts
/* 预热轮先起先收,真实轮的 prompt 紧随其后;两个 session 必须不同 */
await waitFor(() => prompts.length >= 2, '预热轮 + 真实轮两次 session/prompt')
const warmSession = prompts[0].sessionId
const runSession = prompts[1].sessionId
ok(!!warmSession && !!runSession && warmSession !== runSession,
  '[2] 预热轮与真实轮分属两个 session(warm=' + warmSession.slice(0, 14) + '… run=' + runSession.slice(0, 14) + '…)')

const b = await connectBridge(bridgePorts[0])
/* 注:sessionId 传 undefined = 帧上根本不带这个字段(模拟没盖章的老插件) */
const frame = (t, id, sessionId, extra) =>
  b.send(Object.assign({ t, id }, sessionId === undefined ? {} : { sessionId }, extra || {}))

frame('question', 'q-mine', runSession, {
  questions: [{ id: 'q1', question: '本轮提问', options: [{ label: 'A' }] }],
})
await expectDelivered(b, 'q-mine', 'question', RUN1, '[2] 本轮 question 帧')
await req('interact', { kind: 'question', id: 'q-mine', answers: ['A'] })
await b.next((f) => f.t === 'answer' && f.id === 'q-mine' && Array.isArray(f.answers), 3000, 'answer q-mine')
ok(true, '[2] question 的回答经 interact 原路回到插件')

frame('approval', 'a-mine', runSession, { toolName: 'pwsh', callId: 'tc_1', reason: '越权' })
await expectDelivered(b, 'a-mine', 'approval', RUN1, '[2] 本轮 approval 帧')
await req('interact', { kind: 'approval', id: 'a-mine', outcome: 'allowed-once' })
await b.next((f) => f.t === 'outcome' && f.id === 'a-mine' && f.outcome === 'allowed-once', 3000, 'outcome a-mine')
ok(true, '[2] approval 的结果经 interact 原路回到插件')

frame('canvas', 'c-mine', runSession, { op: 'edit', params: { create: [{ alias: 'n1', kind: 'input_text' }] } })
const cEv = await expectDelivered(b, 'c-mine', 'canvas', RUN1, '[2] 本轮 canvas 帧(任务 2 的盖章契约)')
ok(cEv.data.op === 'edit' && !!(cEv.data.params && cEv.data.params.create), '[2] canvas 的 op / params 原样送达渲染层')
await req('interact', { kind: 'canvas', id: 'c-mine', result: { applied: true } })
const cRes = await b.next((f) => f.t === 'canvas-result' && f.id === 'c-mine', 3000, 'canvas-result c-mine')
ok(cRes.ok === true && !!(cRes.result && cRes.result.applied), '[2] canvas 结果经 interact 回到插件(canvas-result ok:true)')

frame('db', 'd-mine', runSession, { action: 'list', params: {} })
const dEv = await expectDelivered(b, 'd-mine', 'db', RUN1, '[2] 本轮 db 帧')
ok(dEv.data.action === 'list', '[2] db 的 action 原样送达渲染层')
await req('interact', { kind: 'db', id: 'd-mine', result: { records: [] } })
await b.next((f) => f.t === 'db-result' && f.id === 'd-mine', 3000, 'db-result d-mine')
ok(true, '[2] db 结果经 interact 回到插件(db-result)')

/* [3] 越权帧:预热轮 session / 会话树之外 session / canvas·db 没盖章 */
frame('question', 'q-warm', warmSession, { questions: [] })
await expectRejected(b, 'q-warm', '[3] 预热轮 question')
frame('approval', 'a-warm', warmSession, { toolName: 'pwsh' })
await expectRejected(b, 'a-warm', '[3] 预热轮 approval')
frame('canvas', 'c-warm', warmSession, { op: 'app', params: { action: 'status' } })
await expectRejected(b, 'c-warm', '[3] 预热轮 canvas')
frame('db', 'd-warm', warmSession, { action: 'query', params: {} })
await expectRejected(b, 'd-warm', '[3] 预热轮 db')
frame('question', 'q-fx', 'session-foreigndeadbeef', { questions: [] })
await expectRejected(b, 'q-fx', '[3] 外来 session question')
frame('approval', 'a-fx', 'session-foreigndeadbeef', { toolName: 'pwsh' })
await expectRejected(b, 'a-fx', '[3] 外来 session approval')
frame('canvas', 'c-fx', 'session-foreigndeadbeef', { op: 'edit', params: {} })
await expectRejected(b, 'c-fx', '[3] 外来 session canvas')
frame('db', 'd-fx', 'session-foreigndeadbeef', { action: 'list', params: {} })
await expectRejected(b, 'd-fx', '[3] 外来 session db')
frame('canvas', 'c-nosid', undefined, { op: 'edit', params: {} })
await expectRejected(b, 'c-nosid', '[3] 没盖章的 canvas 帧(fail closed)')
frame('db', 'd-nosid', undefined, { action: 'list', params: {} })
await expectRejected(b, 'd-nosid', '[3] 没盖章的 db 帧(fail closed)')
ok(diagHit(/reject question origin=warm/) && diagHit(/reject approval origin=warm/),
  '[3] 预热轮越权在诊断里分类为 origin=warm')
ok(diagHit(/reject canvas origin=warm/) && diagHit(/reject db origin=warm/),
  '[3] canvas / db 与提问走同一道门:warm 同样被拒')
ok(diagHit(/reject (canvas|db) origin=foreign/), '[3] 会话树之外的帧分类为 origin=foreign')
ok(diagHit(/reject canvas origin=no-sid/) && diagHit(/reject db origin=no-sid/),
  '[3] 没盖章的帧分类为 origin=no-sid 并按越权处理')
ok(diagHit(/origin=\S+ runKey=\S+ reqId=\S+ frameSid=\S+ runSid=session-\w+ tree=\d+/),
  '[3] 诊断一行打全 origin / runKey / reqId / frameSid / runSid / tree(可据日志定位)')

/* [4] 处理器内部抛异常:只废这一帧,进程继续服务 */
frame('question', 'q-crash', runSession, { questions: [] })
crashPattern = /"type":"question"[^\n]*q-crash|q-crash[^\n]*"type":"question"/
await expectRejected(b, 'q-crash', '[4] 处理器抛错的那一帧')
crashPattern = null
ok(diagHit(/frame-error t=question id=q-crash/), '[4] 抛错留下 [ix-gate] frame-error 痕迹')
const alive = await req('status')
ok(!!(alive && alive.ok), '[4] 单帧异常没有掀翻网关(仍能响应 status)')

/* [5a] run 正常收尾:仍挂起的 canvas / db 也要被撤帧(渲染层据此自动关框) */
frame('canvas', 'c-late', runSession, { op: 'edit', params: {} })
await nextEvent(evById('canvas', 'c-late'), 3000, 'canvas c-late')
frame('db', 'd-late', runSession, { action: 'write', params: {} })
await nextEvent(evById('db', 'd-late'), 3000, 'db d-late')
if (!rt.__smoke.finishRealRun()) fail('真实轮没能收束(假运行时状态不符预期)')
await nextEvent((e) => e.reqId === RUN1 && e.type === 'done', 8000, 'done ' + RUN1)
const dropC = await nextEvent(evById('ix-drop', 'c-late'), 3000, 'ix-drop c-late')
ok(dropC.reqId === RUN1 && dropC.data.kind === 'canvas' && dropC.data.reason === 'aborted',
  '[5] run 收尾的 canvas 撤帧带对轮次与 kind:' + JSON.stringify(dropC.data))
const dropD = await nextEvent(evById('ix-drop', 'd-late'), 3000, 'ix-drop d-late')
ok(dropD.reqId === RUN1 && dropD.data.kind === 'db', '[5] run 收尾同样撤掉挂起的 db 帧')
await b.next((f) => f.t === 'abort' && f.id === 'c-late', 3000, 'abort c-late')
await b.next((f) => f.t === 'abort' && f.id === 'd-late', 3000, 'abort d-late')
ok(true, '[5] 收尾时插件侧也各收到一条 abort(工具以失败收场,不会永远挂着)')

/* [5b] 新一轮:复用同一台 runtime 与同一座桥;上一轮的章在这一轮不认 */
const RUN2 = 'smoke-run-2'
const TAG2 = 'smoke-gate-2'
const portsBefore = bridgePorts.length
await req('run', {
  reqId: RUN2, workspace: WS, input: '门控冒烟:第二轮', model: 'deepseek-v4-flash',
  maxTokens: 4096, apiKey: 'smoke-not-a-real-key', baseUrl: 'http://127.0.0.1:9',
  systemPrompt: '', dshHome: HOME, permissionPreset: 'mtnode-unattended', cancelTag: TAG2,
})
await waitFor(() => prompts.length >= 3, '第二轮的 session/prompt')
ok(bridgePorts.length === portsBefore && spawned.length === 1, '[5] 复用同一台 runtime 与同一座桥(没重复建桥)')
const run2Session = prompts[2].sessionId
ok(run2Session !== runSession, '[5] 新一轮是新 session(每轮各自一枚章)')
frame('canvas', 'c-r2', run2Session, { op: 'edit', params: {} })
await nextEvent(evById('canvas', 'c-r2'), 3000, 'canvas c-r2')
ok(true, '[5] 第二轮的 canvas 帧以第二轮的章投递(归属跟着轮次走)')
frame('question', 'q-r1-stale', runSession, { questions: [] })
await expectRejected(b, 'q-r1-stale', '[5] 上一轮遗留的提问')
ok(diagHit(/reject question origin=stale/), '[5] 上一轮迟到的帧分类为 origin=stale')

/* closeBridge:按标签取消第二轮 → 挂起项一起清账 */
await req('cancel', { workspace: WS, cancelTag: TAG2 })
const drop2 = await nextEvent(evById('ix-drop', 'c-r2'), 5000, 'ix-drop c-r2')
ok(drop2.reqId === RUN2 && drop2.data.kind === 'canvas',
  '[5] closeBridge 也撤挂起的 canvas 帧,且 reqId 归属被取消那一轮')
/* abort 帧尽力送达即:closeBridge 在同一条Tick 里 destroy 套接字,缓冲里的写可能已随进程一起没了
   (生产环境那一刻运行时进程也正要被回收,所以只验渲染层侧的权威撤帧) */
await b.next((f) => f.t === 'abort' && f.id === 'c-r2', 1500, 'abort c-r2').catch(() => {})
await nextEvent((e) => e.reqId === RUN2 && e.type === 'done', 8000, 'done ' + RUN2)
ok(diagHit(/reject .*origin=stale/), '[5] 收尾后仍有分类判据(上一轮的 session 已进 priorRunSessions)')

b.close()
say('== PASS:' + passed + ' 项断言全部通过 ==')
process.exit(0)
