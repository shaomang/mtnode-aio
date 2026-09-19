// MTNode long-task tool (runs INSIDE the dsh runtime process).
//
// Two tools for a node that belongs to a 长周期任务 (long-running state machine):
//   lt_state  — read the graph's shared state (any key) / write ONLY the keys the
//               current node declared as its outputs. Topology edits are impossible.
//   lt_memory — long-term memory: tiered recall (workflow > workspace > global),
//               manual write, and `propose` (candidate facts the HOST shows the user
//               for confirmation — nothing lands in the store unapproved).
//
// Both are answered by the HOST over the same localhost bridge as db-plugin.mjs
// (port from MTNODE_BRIDGE_PORT). The plugin never invents state or facts: the
// renderer owns the run, the memory DB, and the confirmation flow, and it rejects
// calls from a run that is not a long-task run (fail closed).
//
// Protocol (newline-delimited JSON):
//   plugin  → gateway: {t:'lt', id, sessionId, action, params}
//   plugin  → gateway: {t:'drop', id, sessionId}
//   gateway → plugin:  {t:'lt-result', id, ok, result?, error?} | {t:'abort', id}

import { createConnection } from 'node:net'
import { randomUUID } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { isToolHidden } from './tool-visibility.mjs'

export const name = 'mtnode-longtask'
export const inject = ['tools']

const STATE_DESC = `Read / write the shared state of the LONG-RUNNING TASK this node belongs to.

- read (default): returns the whole state object of the current run plus your own node's declared input values. Use it whenever the task needs upstream results — do NOT guess what an earlier step produced.
- write: pass patch = { "<key>": <value> }. You may ONLY write the output keys your own node declared in its task brief (they are listed in the read result as allowedWrite). Writing anything else is rejected by the host — that is deliberate: it keeps one run reproducible.

Values are JSON. Keep big payloads in files and write the PATH into state instead of the whole text.`

const MEM_DESC = `Long-term memory of this project / workflow (SQLite + FTS5, scoped global > workspace > workflow).

- recall: pass q (keywords). Returns top matches with [id · 标题] provenance, ordered 当前工作流 > 项目 > 全局.
- list: recent entries (no q needed).
- write: pass items = [{title, body, type?, scope?}] to add a fact you were TOLD by the user or verified yourself. type ∈ fact|decision|preference|glossary|note; scope defaults to the current workflow.
- propose: pass items = [...] for facts extracted from your own work. These do NOT land automatically — the user confirms each one in the MTNode strip. Prefer propose over write unless the fact came straight from the user.

Discipline: memory is a hint, not ground truth. If it conflicts with the 事实库 documents or with the current files, say so; do not silently overwrite what the user wrote. Record as you go, not only when the task ends: a fact the user stated directly or you verified yourself goes in with write right away, anything you merely inferred goes through propose for the user to confirm.`

export function apply(ctx) {
  /* 非长任务轮（普通会话 / 助手 / 普通智能节点）里这两个工具必然被宿主拒绝 ——
     注册口直接不注册，省下每步重发的工具定义（与 db-plugin 同一裁剪思路）。 */
  if (isToolHidden('lt_state') || isToolHidden('lt_memory')) {
    if (isToolHidden('lt_state') && isToolHidden('lt_memory')) return
  }
  const port = Number(process.env.MTNODE_BRIDGE_PORT || 0)
  let socket = null
  let buf = ''
  /** @type {Map<string, {resolve:(v:any)=>void, reject:(e:Error)=>void}>} */
  const pending = new Map()

  const send = (obj) => {
    if (socket && !socket.destroyed) {
      try { socket.write(JSON.stringify(obj) + '\n') } catch { /* gateway gone */ }
    }
  }
  const failAll = (err) => { for (const [id, p] of pending) { pending.delete(id); p.reject(err) } }
  const onLine = (line) => {
    let m
    try { m = JSON.parse(line) } catch { return }
    if (!m || typeof m.id !== 'string') return
    const p = pending.get(m.id)
    if (!p) return
    if (m.t === 'lt-result') {
      pending.delete(m.id)
      if (m.ok === false) p.reject(new Error(String(m.error || 'lt op failed')))
      else p.resolve(m.result == null ? { ok: true } : m.result)
    } else if (m.t === 'abort') {
      pending.delete(m.id)
      p.reject(new Error('lt op aborted (task ended)'))
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
      failAll(new Error('lt channel closed'))
      setTimeout(connect, 2000)
    })
  }
  connect()

  const rpc = (action, params, exec) => {
    if (!socket || socket.destroyed) {
      return Promise.reject(new Error('lt channel unavailable (only works inside the MTNode app)'))
    }
    const id = randomUUID()
    const sessionId = exec && exec.agent ? String(exec.agent.id || '') : ''
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      send({ t: 'lt', id, sessionId, action, params: params || {} })
      const onAbort = () => {
        if (!pending.has(id)) return
        pending.delete(id)
        send({ t: 'drop', id, sessionId })
        reject(new Error('lt op aborted'))
      }
      exec && exec.signal && exec.signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  if (!isToolHidden('lt_state')) {
    ctx.tools.register(defineTool({
      name: 'lt_state',
      description: STATE_DESC,
      parameters: {
        write: { type: 'boolean', description: 'true = write patch into state; default false = read.' },
        key: { type: 'string', description: 'read: optional single key to fetch instead of the whole state.' },
        patch: { type: 'object', additionalProperties: true, description: 'write: { key: value } — only your own declared output keys.' },
      },
      timeoutMs: 20000,
      output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
      async execute(args, exec) {
        const a = args && typeof args === 'object' ? args : {}
        return rpc(a.write ? 'stateWrite' : 'stateRead', a, exec)
      },
    }))
  }
  if (!isToolHidden('lt_memory')) {
    ctx.tools.register(defineTool({
      name: 'lt_memory',
      description: MEM_DESC,
      parameters: {
        action: { type: 'string', enum: ['recall', 'list', 'write', 'propose'], required: true, description: 'Which memory action to run.' },
        q: { type: 'string', description: 'recall: keywords.' },
        items: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'write / propose: [{title, body, type?, scope?, tags?}].' },
        limit: { type: 'number', description: 'recall / list: max entries (1–64, default 8).' },
      },
      timeoutMs: 20000,
      output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
      async execute(args, exec) {
        const a = args && typeof args === 'object' ? args : {}
        return rpc(String(a.action || 'recall'), a, exec)
      },
    }))
  }
}
