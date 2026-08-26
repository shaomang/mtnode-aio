// MTNode database tool (runs INSIDE the dsh runtime process).
//
// Registers mtnode_db so an agent wired to a 数据库副本 (database replica)
// can query the deterministic fact index of its database super node:
//   - list: schema + record titles (ids, kinds, files)
//   - query: deterministic keyword/field search over the index (top-k + snippets)
//   - get: full record by id
//   - calc: safe arithmetic (numbers + - * / % parentheses) — no model math
//
// Facts flow through the same localhost TCP bridge as canvas-plugin.mjs
// (port from MTNODE_BRIDGE_PORT). The HOST (MTNode renderer) answers queries
// from the compiled index of the databases wired into the RUNNING node; it
// rejects the call when the node is not wired to any database. The plugin
// never invents facts: every result is host-verified data.
//
// Protocol (newline-delimited JSON):
//   plugin → gateway: {t:'db', id, action:'list'|'query'|'get'|'calc', params}
//   gateway → plugin: {t:'db-result', id, ok, result?, error?} | {t:'abort', id}

import { createConnection } from 'node:net'
import { randomUUID } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'mtnode-db'
export const inject = ['tools']

const DB_DESC = `Grounded fact lookup for the database wired into the CURRENT task — OR any database referenced by writing !@数据库标题 in your prompt/task. Use it whenever the task needs facts — names, numbers, prices, paths, terms, statuses — instead of answering from memory. Facts NEVER come from your parameters: only this tool's returned records are truth.

Available actions (full CRUD over the referenced database(s)):
- list: schema + all record titles (id | title | kind | file). Use first to see what the database knows.
- get: full record by id (from list/query results). Returns provenance, sql, and data (the record).
- query: search records by keywords / question; supports field filters title:xxx file:xxx kind:fact|file|meta. Returns a structured object with provenance (record ids/titles/sources), sql (the actual access statement used), and data (the matched records as a JSON array; each record also carries its database + sql).
- write: insert or update records (增 / 改). Pass records: [ {id?, title, content, kind?, source?, file?} ]. If id is omitted it is auto-generated (inserts a NEW record); if id matches an existing record it overwrites that record (update). Returns per-database written counts.
- delete: remove records by id (删). Pass ids: [ ... ] (record ids from provenance). Returns per-database deleted counts.
- calc: evaluate arithmetic with numbers and + - * / % ( ) only. ALL number/date math must go through calc — never compute in your head.

When the run references more than one database (via !@ or wired replicas), pass database: "<title or folder>" to scope an action to a single database; otherwise the action applies to every referenced database.

Discipline (enforced by the host):
- Every key assertion in your answer MUST cite [记录id · 标题] from the provenance of a query/get result.
- If query/get finds nothing, say exactly "数据库中没有该信息" — do not guess, do not fill in from memory.
- If the host rejects the call (未接入数据库), the database is unavailable: say so, and do NOT answer from memory.
- Facts not in the database may only appear explicitly labelled as 推断, with "数据库未记载".
- Prefer query before write: confirm a record id does not already exist before writing a duplicate.`

export function apply(ctx) {
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
    if (m.t === 'db-result') {
      pending.delete(m.id)
      if (m.ok === false) p.reject(new Error(String(m.error || 'db op failed')))
      else p.resolve(m.result == null ? { ok: true } : m.result)
    } else if (m.t === 'abort') {
      pending.delete(m.id)
      p.reject(new Error('db op aborted (task ended)'))
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
      failAll(new Error('db channel closed'))
      setTimeout(connect, 2000)
    })
  }
  connect()

  const rpc = (action, params, exec, timeoutMs) => {
    if (!socket || socket.destroyed) {
      return Promise.reject(new Error('db channel unavailable (only works inside the MTNode app)'))
    }
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      send({ t: 'db', id, action, params: params || {} })
      const onAbort = () => {
        if (!pending.has(id)) return
        pending.delete(id)
        send({ t: 'drop', id })
        reject(new Error('db op aborted'))
      }
      exec && exec.signal && exec.signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  ctx.tools.register(defineTool({
    name: 'mtnode_db',
    description: DB_DESC,
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['list', 'query', 'get', 'calc', 'write', 'delete'],
        description: 'Which database action to run.',
      },
      q: {
        type: 'string',
        description:
          'query: keywords or a question; optional field filters title:xxx file:xxx kind:fact|file|meta.',
      },
      id: {
        type: 'string',
        description: 'get: record id from list/query results.',
      },
      expr: {
        type: 'string',
        description: 'calc: arithmetic expression, numbers and + - * / % ( ) only.',
      },
      record: {
        type: 'object',
        additionalProperties: true,
        description:
          'write: a single record to upsert (id, title, content, kind, source, file). Omit id to insert a new record (id auto-generated). Use records for an array.',
      },
      records: {
        type: 'array',
        items: { type: 'object', additionalProperties: true },
        description:
          'write: array of records to upsert. Each takes title, content, optional kind/source/file; include an existing id to update that record, or omit id to insert a new one (id auto-generated).',
      },
      ids: {
        type: 'array',
        items: { type: 'string' },
        description: 'delete: array of record ids to remove.',
      },
      database: {
        type: 'string',
        description:
          'Optional database title or folder to scope this action to (else it applies to all referenced databases).',
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
