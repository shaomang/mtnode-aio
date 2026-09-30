// MTNode interaction bridge plugin (runs INSIDE the dsh runtime process).
//
// Registers the two human-interaction channels the stdio JSON-RPC runtime
// does not carry on the wire:
//   - `user-questions/request` answerer: the model's ask_user_question tool
//     pauses here until the hosting app answers. dsh 0.2 renamed this seam:
//     `ctx.userQuestions` lost `registerProvider` (the service now dispatches
//     the Agent-scoped `user-questions/request` waterfall and rejects with
//     NO_PROVIDER — "no user-questions answerer accepted the request" — when
//     nobody claims it). So the answerer is a plain Cordis waterfall listener,
//     exactly like the approval one below.
//   - approval/request answerer: under an "ask" permission preset, tool
//     escalations pause here until the user allows once or rejects.
//
// Frames travel over a localhost TCP channel owned by gateway.mjs; the port
// arrives via MTNODE_BRIDGE_PORT at spawn. Without the port the plugin is a
// no-op and asks fail closed (unattended fallback). This file imports only
// node builtins: the dsh plugin API arrives through the injected context.
//
// Protocol (newline-delimited JSON):
//   plugin → gateway: {t:'question'|'approval'|'drop', id, ...payload}
//   gateway → plugin: {t:'answer'|'outcome'|'abort', id, ...payload}

import { createConnection } from 'node:net'
import { randomUUID } from 'node:crypto'

export const name = 'mtnode-bridge'
export const inject = ['userQuestions']

const OUTCOMES = ['allowed-once', 'rejected', 'cancelled', 'unavailable']

export function apply(ctx) {
  const port = Number(process.env.MTNODE_BRIDGE_PORT || 0)
  if (!Number.isInteger(port) || port <= 0) return

  let socket = null
  let buf = ''
  /** @type {Map<string, {kind:'question'|'approval', resolve:(v:any)=>void, reject:(e:Error)=>void}>} */
  const pending = new Map()

  const send = (obj) => {
    if (socket && !socket.destroyed) {
      try { socket.write(JSON.stringify(obj) + '\n') } catch { /* gateway gone; fail paths settle below */ }
    }
  }

  const failAll = (err) => {
    for (const [id, p] of pending) {
      pending.delete(id)
      if (p.kind === 'question') {
        /* 别让提问卡片留在界面上:补发 drop 让网关同步撤卡。
           本 socket 已断时 send 静默 no-op(网关侧 closeBridge 自会收尾);
           重连后旧 socket 才关闭的情况下,这条 drop 仍能送达。 */
        send({ t: 'drop', id })
        p.reject(err)
      } else p.resolve('unavailable')
    }
  }

  const onLine = (line) => {
    let m
    try { m = JSON.parse(line) } catch { return }
    if (!m || typeof m.id !== 'string') return
    const p = pending.get(m.id)
    if (!p) return
    if (m.t === 'answer' && p.kind === 'question') {
      pending.delete(m.id)
      p.resolve({ answers: Array.isArray(m.answers) ? m.answers : [] })
    } else if (m.t === 'outcome' && p.kind === 'approval') {
      pending.delete(m.id)
      p.resolve(OUTCOMES.includes(m.outcome) ? m.outcome : 'unavailable')
    } else if (m.t === 'abort') {
      pending.delete(m.id)
      if (p.kind === 'question') p.reject(new Error('ask_user_question was aborted before the user answered'))
      else p.resolve('cancelled')
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
        if (line) onLine(line)
      }
    })
    s.on('error', () => {})
    s.on('close', () => {
      if (socket === s) socket = null
      failAll(new Error('interaction channel closed'))
      setTimeout(connect, 2000)
    })
  }
  connect()

  // ── ask_user (模型提问) ────────────────────────────────────────────────
  // 契约（dsh 0.2 · @deepseek-ai/dsh-user-questions 的 ctx.userQuestions）：
  // 提问走 Agent 作用域的 `user-questions/request` 瀑布，回答者用普通 Cordis
  // 监听注册（与下方审批同形状），返回值即 `ask()` 的结果（`{ answers: [...] }`）；
  // 无人认领时服务回 NO_PROVIDER，工具以失败收场。**没有** registerProvider ——
  // 0.1 的那套写法在这里会抛错且被插件装载吞掉，于是提问永远无人应答。
  // 拿不到桥（无端口 / socket 未连上）时 `return next()`：把机会让给别的回答者
  // （与审批的 next() 同口径），而不是自己造一个失败的答案。
  ctx.on('user-questions/request', (request, next) => {
    if (!socket || socket.destroyed) return next()
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      pending.set(id, { kind: 'question', resolve, reject })
      send({
        t: 'question',
        id,
        sessionId: request.agent ? String(request.agent.id) : '',
        questions: (request.questions || []).map((q) => ({
          id: q.id,
          question: q.question,
          ...(q.header !== undefined ? { header: q.header } : {}),
          ...(q.detail !== undefined ? { detail: q.detail } : {}),
          ...(q.options !== undefined ? { options: q.options } : {}),
          ...(q.multiSelect !== undefined ? { multiSelect: q.multiSelect } : {}),
        })),
      })
      request.signal?.addEventListener('abort', () => {
        if (!pending.has(id)) return
        pending.delete(id)
        send({ t: 'drop', id })
        reject(new Error('ask_user_question was aborted before the user answered'))
      }, { once: true })
    })
  })

  // ── approval (权限审批) ────────────────────────────────────────────────
  ctx.on('approval/request', (req, next) => {
    if (req.signal?.aborted === true) return Promise.resolve('cancelled')
    if (!socket || socket.destroyed) return next()
    const id = randomUUID()
    return new Promise((resolve) => {
      pending.set(id, { kind: 'approval', resolve, reject: () => resolve('unavailable') })
      send({
        t: 'approval',
        id,
        sessionId: req.agent ? String(req.agent.session.id) : '',
        toolName: String(req.toolName || ''),
        ...(req.callId !== undefined ? { callId: String(req.callId) } : {}),
        ...(req.reason !== undefined ? { reason: String(req.reason) } : {}),
      })
      req.signal?.addEventListener('abort', () => {
        if (!pending.has(id)) return
        pending.delete(id)
        send({ t: 'drop', id })
        resolve('cancelled')
      }, { once: true })
    })
  })
}
