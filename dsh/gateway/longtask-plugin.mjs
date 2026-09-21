// MTNode long-task tool (runs INSIDE the dsh runtime process).
//
// One tool for a node that belongs to a 长周期任务 (long-running state machine):
//   lt_state  — read the graph's shared state (any key) / write ONLY the keys the
//               current node declared as its outputs. Topology edits are impossible.
//
// lt_memory is GONE: long-term memory recording now goes through mtnode_facts
// (the per-canvas AI fact library, see ai-facts-plugin.mjs) — this plugin no longer
// registers a memory tool, and the host no longer routes an lt memory bridge frame.
//
// lt_state is answered by the HOST over the same localhost bridge as db-plugin.mjs
// (port from MTNODE_BRIDGE_PORT). The plugin never invents state: the renderer owns
// the run, and it rejects calls from a run that is not a long-task run (fail closed).
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

export function apply(ctx) {
  /* 非长任务轮（普通会话 / 助手 / 普通智能节点）里这个工具必然被宿主拒绝 ——
     注册口直接不注册，省下每步重发的工具定义（与 db-plugin 同一裁剪思路）。 */
  if (isToolHidden('lt_state')) return
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
}
