// MTNode interaction bridge plugin (runs INSIDE the dsh runtime process).
//
// Registers the two human-interaction channels the stdio JSON-RPC runtime
// does not carry on the wire:
//   - ctx.userQuestions provider: the model's ask_user_question tool pauses
//     here until the hosting app answers.
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
      if (p.kind === 'question') p.reject(err)
      else p.resolve('unavailable')
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
  ctx.userQuestions.registerProvider({
    ask(request) {
      if (!socket || socket.destroyed) {
        return Promise.reject(new Error('no interaction channel available'))
      }
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
    },
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
