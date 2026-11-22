// MTNode session-recall tool (runs INSIDE the dsh runtime process).
//
// Registers mtnode_recall so an agent can look BACK into the verbatim text of the
// current conversation after the model stopped seeing it. Three different things
// push early turns out of the context window, and none of them deletes anything on
// disk — which is exactly why a recall tool is possible:
//   · manual compaction: the host stamps messages with _fold (app-db.js
//     agentHistoryEntries is the only filter point) — the text stays in
//     agent-sessions/<id>.json;
//   · runtime auto compaction: the gateway turns compaction events into
//     st.compacts[] entries with kind:'auto' (summary + masked count) — messages
//     are still stored;
//   · no compaction at all: the history段 is trimmed from the oldest end once it
//     passes AGENT_HIST_MAX_CHARS (agentHistTrimTail) — same story.
//
// Actions (the HOST does all the reading; the plugin never invents text):
//   - outline: one line per turn (user message) — index / time / first 60 chars /
//     tool count / char count / whether it already left the context
//   - search:  keyword scan over message bodies (space = AND, /…/ = regex);
//     scope:'all' also scans reasoning + tool calls/results
//   - read:    verbatim text by msgIndex, or a from/to range, truncated to maxChars
//   - context: which indices are still inside this turn's history段, plus the
//     compacted sections (manual / auto) recorded on the session
//
// Facts flow through the same localhost TCP bridge as ai-facts-plugin.mjs /
// canvas-plugin.mjs (port from MTNODE_BRIDGE_PORT). The HOST (MTNode renderer)
// owns the conversation store and answers; with no bound session it answers with
// the error text 该会话尚未加载 / 不存在 — the tool call fails, the session keeps
// running.
//
// Protocol (newline-delimited JSON):
//   plugin → gateway: {t:'recall', id, sessionId, action:'outline'|'search'|'read'|'context', params}
//   plugin → gateway: {t:'drop', id, sessionId}  (we gave up on a frame we just sent)
//   gateway → plugin: {t:'recall-result', id, ok, result?, error?} | {t:'abort', id}
//
// sessionId = the id of the agent session that issued the call (exec.agent.id), the same
// stamp canvas-plugin.mjs / ai-facts-plugin.mjs carry. The gateway gates interaction frames
// on it, so a result can never be routed to a run that did not ask for it; an unstamped
// frame is aborted (fail closed) rather than shown.

import { createConnection } from 'node:net'
import { randomUUID } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'mtnode-session-recall'
export const inject = ['tools']

/* 描述纪律：每一步都随工具前缀重发，所以这里只留「参数含义 + 四个动作 + 数量上限 +
   查不到就说查不到」，控制在 ~800 字符内（成本口径见 tool-visibility.mjs 头部）。
   这块功能对所有会话都该常驻可用 —— 所以 mtnode_recall **不进** HIDEABLE_TOOLS，
   也不读 MTNODE_HIDE_TOOLS：它没有「本轮用不上」的档位（被压缩的历史随时可能需要反查）。 */
const RECALL_DESC = `反查本会话早期原文（mtnode_recall）：对话被手动压缩、被运行时自动压缩、或历史段按字符上限截断之后，需要早先的原话 / 数字 / 文件名 / 决定时，用它取回逐字原文 —— 不得凭记忆编造。
动作：
- outline：按轮列出 user 消息（索引、时间、首 60 字、该轮工具数、字符数、是否已出上下文），最多 80 行。先 outline 定位再 read。
- search：q 关键词扫正文；空格分隔 = AND，/…/ 视为正则；scope:"all" 连带 reasoning 与工具调用名 / 结果。返回 msgIndex + 角色 + ±120 字片段（单条 ≤300 字），limit 默认 8 / 上限 30，总回包 ≤8000 字。
- read：按 index 或 from/to 区间取原文，maxChars 默认 4000 / 上限 20000；超出即截断并标注「已截断，本条共 N 字」。
- context：报告哪些索引仍在本轮历史段里，以及已被压缩的区段（manual / auto 摘要）。
with：read / search 时一并返回 reasoning / tools / both（默认只正文）。sessionId：反查另一个会话（默认本会话）。
全程只读、可重复调用；查不到就如实说查不到。`

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
    if (m.t === 'recall-result') {
      pending.delete(m.id)
      if (m.ok === false) p.reject(new Error(String(m.error || 'recall op failed')))
      else p.resolve(m.result == null ? { ok: true } : m.result)
    } else if (m.t === 'abort') {
      pending.delete(m.id)
      p.reject(new Error('recall op aborted (task ended)'))
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
      failAll(new Error('recall channel closed'))
      setTimeout(connect, 2000)
    })
  }
  connect()

  const rpc = (action, params, exec, timeoutMs) => {
    if (!socket || socket.destroyed) {
      return Promise.reject(new Error('recall channel unavailable (only works inside the MTNode app)'))
    }
    const id = randomUUID()
    /* 发起轮盖章:agent.id 就是该 agent 所在 session 的 id(与 canvas-plugin / db-plugin /
       ai-facts-plugin 同一契约),网关据此判归属;取不到 agent 发空串,由网关 fail closed 直接 abort。 */
    const sessionId = exec && exec.agent ? String(exec.agent.id || '') : ''
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      send({ t: 'recall', id, sessionId, action, params: params || {} })
      /* 超时上限与 mtnode_facts 一致（20s）：反查是纯读 + 截断，宿主不该比它更慢；
         真超时就只让这一条调用失败，会话继续。 */
      const timer = setTimeout(() => {
        if (!pending.has(id)) return
        pending.delete(id)
        reject(new Error('recall op timed out'))
      }, Number(timeoutMs) > 0 ? Number(timeoutMs) : 20000)
      if (timer.unref) timer.unref()
      const onAbort = () => {
        if (!pending.has(id)) return
        pending.delete(id)
        send({ t: 'drop', id, sessionId })
        reject(new Error('recall op aborted'))
      }
      exec && exec.signal && exec.signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  ctx.tools.register(defineTool({
    name: 'mtnode_recall',
    description: RECALL_DESC,
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['outline', 'search', 'read', 'context'],
        description: 'Which recall action to run.',
      },
      q: {
        type: 'string',
        description:
          'search: keywords over the message bodies (space separated = AND; wrap in /…/ for a regex).',
      },
      index: {
        type: 'number',
        description: 'read: the msgIndex of one message (see outline / search results).',
      },
      from: {
        type: 'number',
        description: 'read: first msgIndex of a range (use together with to).',
      },
      to: {
        type: 'number',
        description: 'read: last msgIndex of a range (use together with from).',
      },
      scope: {
        type: 'string',
        enum: ['user', 'all'],
        description:
          'search: "user" (default) = message bodies only; "all" = also reasoning + tool calls/results.',
      },
      limit: {
        type: 'number',
        description: 'search: max hits to return (1–30, default 8).',
      },
      with: {
        type: 'string',
        enum: ['reasoning', 'tools', 'both'],
        description: 'read / search: also return reasoning and/or tool calls+results (default: body only).',
      },
      maxChars: {
        type: 'number',
        description: 'read: max characters of text returned (default 4000, hard cap 20000).',
      },
      sessionId: {
        type: 'string',
        description: 'Recall another session by id (default: the session that issued this call).',
      },
    },
    timeoutMs: 20000,
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const action = String((args && args.action) || 'outline')
      return rpc(action, args || {}, exec, 20000)
    },
  }))
}
