// MTNode AI fact library tool (runs INSIDE the dsh runtime process).
//
// Registers mtnode_facts so ANY agent session / expert / node can index and
// recall the per-canvas AI fact library — a minimal, machine-readable 条例库
// (one canvas = one library), independent from the database replica tool:
//   - list: every entry (id | title | pinned)
//   - query: keyword search over the entries (top-k, hit counter +1 per hit)
//   - get: one entry by id
//   - write: upsert minimal clauses ({id?, title, text} / records array)
//   - delete: remove entries by id
//   - pin: protect / unprotect entries (pinned entries are never evicted)
//
// Facts flow through the same localhost TCP bridge as canvas-plugin.mjs and
// db-plugin.mjs (port from MTNODE_BRIDGE_PORT). The HOST (MTNode renderer)
// owns the library: it reads / writes <canvas folder>\团队事实库\AI\ai-facts.json
// for the canvas bound to the running turn, keeps the hit counters and evicts
// low-score entries — the plugin only forwards the call and never invents data.
// With no bound canvas the host answers with the error text 当前没有绑定画布:
// the tool call fails, the session keeps running.
//
// Protocol (newline-delimited JSON):
//   plugin → gateway: {t:'facts', id, sessionId, action:'list'|'query'|'get'|'write'|'delete'|'pin', params}
//   plugin → gateway: {t:'drop', id, sessionId}  (we gave up on a frame we just sent)
//   gateway → plugin: {t:'facts-result', id, ok, result?, error?} | {t:'abort', id}
//
// sessionId = the id of the agent session that issued the call (exec.agent.id), the same
// stamp canvas-plugin.mjs carries. The gateway gates interaction frames on it, so a result
// can never be routed to a run that did not ask for it; an unstamped frame is aborted
// (fail closed) rather than shown.

import { createConnection } from 'node:net'
import { randomUUID } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { isToolHidden } from './tool-visibility.mjs'

export const name = 'mtnode-ai-facts'
export const inject = ['tools']

const FACTS_DESC = `AI 事实库（mtnode_facts）：本画布自己的极简条例库 —— 给 AI 读的紧凑索引。要知道「这个项目有哪些模块、关键文件与路径、定了哪些约定、工作流的端口与数据流、命令入口、已知坑」时，先查这里，再去看现文件与数据库。
动作：
- list：全部条目（id | 标题 | 是否保护）。
- query：按关键词检索（q，可选 limit），返回最相关的少量条目；写之前先 query，避免重复。
- get：按 id 取一条全文。
- write：写入极简条例 —— record: {id?, title, text} 或 records: [...]；同标题即更新同一条，省略 id 即新增。
- delete：按 ids 删除条目。
- pin：按 ids 设 on:true（保护，不会被淘汰）/ on:false（取消保护）。
条目纪律：一条一件事、标题可辨、正文只求信息传达，不写过程与废话 —— 命中计数只看被索引的频率，废话只会被淘汰；完整规范见技能 mtnode-ai-facts。
冲突口径：与现文件、数据库记录冲突时，以现文件、数据库为准，并在回答里说明分歧；本库没有或查不到就如实说，不得凭记忆编造。
没有绑定画布时返回「当前没有绑定画布」（工具调用失败，会话继续）。
Use when indexing project content, or recording / recalling the key conclusions of a project's architecture or workflow (modules, file paths, conventions, ports, commands, known pitfalls).`

export function apply(ctx) {
  /* 可见性：mtnode_facts 对所有 Agent 会话 / 专家 / 节点默认可用 —— 不接线、不新增许可开关。
     它的名字在 tool-visibility.mjs 的 HIDEABLE_TOOLS（可裁白名单）里，属于「将来可以按运行裁」
     的许可；宿主当前不把它写进任何 hideTools 名单，所以本档运行永远注册。守卫是为与
     db-plugin.mjs / canvas-plugin.mjs 同形：真要按运行裁它时这里会自然生效。 */
  if (isToolHidden('mtnode_facts')) return
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

  const failAll = (err) => {
    for (const [id, p] of pending) {
      pending.delete(id)
      p.reject(err)
    }
  }

  const onLine = (line) => {
    let m
    try { m = JSON.parse(line) } catch { return }
    if (!m || typeof m.id !== 'string') return
    const p = pending.get(m.id)
    if (!p) return
    if (m.t === 'facts-result') {
      pending.delete(m.id)
      if (m.ok === false) p.reject(new Error(String(m.error || 'facts op failed')))
      else p.resolve(m.result == null ? { ok: true } : m.result)
    } else if (m.t === 'abort') {
      pending.delete(m.id)
      p.reject(new Error('facts op aborted (task ended)'))
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
      failAll(new Error('facts channel closed'))
      setTimeout(connect, 2000)
    })
  }
  connect()

  const rpc = (action, params, exec, timeoutMs) => {
    if (!socket || socket.destroyed) {
      return Promise.reject(new Error('facts channel unavailable (only works inside the MTNode app)'))
    }
    const id = randomUUID()
    /* 发起轮盖章:agent.id 就是该 agent 所在 session 的 id(与 canvas-plugin / db-plugin 同一契约),
       网关据此判归属;取不到 agent 发空串,由网关 fail closed 直接 abort。 */
    const sessionId = exec && exec.agent ? String(exec.agent.id || '') : ''
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      send({ t: 'facts', id, sessionId, action, params: params || {} })
      const onAbort = () => {
        if (!pending.has(id)) return
        pending.delete(id)
        send({ t: 'drop', id, sessionId })
        reject(new Error('facts op aborted'))
      }
      exec && exec.signal && exec.signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  ctx.tools.register(defineTool({
    name: 'mtnode_facts',
    description: FACTS_DESC,
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['list', 'query', 'get', 'write', 'delete', 'pin'],
        description: 'Which AI fact library action to run.',
      },
      q: {
        type: 'string',
        description: 'query: keywords to search the library with (tags, titles, module names, paths).',
      },
      id: {
        type: 'string',
        description: 'get: entry id from a list/query result.',
      },
      ids: {
        type: 'array',
        items: { type: 'string' },
        description: 'delete / pin: array of entry ids.',
      },
      record: {
        type: 'object',
        additionalProperties: true,
        description:
          'write: a single minimal clause {id?, title, text}. Omit id to insert a new entry (same title updates that entry). Use records for an array.',
      },
      records: {
        type: 'array',
        items: { type: 'object', additionalProperties: true },
        description:
          'write: array of minimal clauses {id?, title, text}; same title = update the existing entry, omit id = insert a new one.',
      },
      on: {
        type: 'boolean',
        description: 'pin: true = protect the entry from eviction, false = unprotect it.',
      },
      limit: {
        type: 'number',
        description: 'query: max entries to return (1–20, default 8).',
      },
    },
    timeoutMs: 20000,
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const action = String((args && args.action) || 'list')
      return rpc(action, args || {}, exec, 20000)
    },
  }))
}