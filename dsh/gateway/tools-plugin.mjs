// MTNode user tool nodes (runs INSIDE the dsh runtime process).
//
// Makes user-defined 工具节点 (fixed in/out graph containers on the canvas) and
// library tools (会话随时可调用 always) callable by the agent as function-call
// tools. The descriptor list arrives at runtime spawn via MTNODE_TOOLS_JSON
// (gateway.mjs hashes a fingerprint of it into the runtime key, so a changed
// tool set cold-starts its own runtime — same pattern as MTNODE_PURE / persona).
//
// Each descriptor:
//   { key, toolName, name, description, inputs:[{name,kind}], outputs:[{name,kind}] }
//     key      = stable host-side id ("cn:<nodeId>" canvas | "lib:<id>" library)
//     toolName = ASCII-safe registration name the model calls (host precomputes)
//     name     = human tool name (shown in the description)
// Execution travels over the same localhost TCP bridge as canvas-plugin.mjs:
// the HOST renderer runs the tool node's inner graph with the model's args and
// returns the output values; this plugin only relays and formats.
//
// Protocol (newline-delimited JSON):
//   plugin → gateway: {t:'tool', id, sessionId, tool:{key,toolName,name}, args}
//   plugin → gateway: {t:'drop', id, sessionId}  (we gave up on a frame)
//   gateway → plugin: {t:'tool-result', id, ok, result?, error?} | {t:'abort', id}
//
// sessionId = the id of the agent session that issued the call (exec.agent.id);
// the gateway gates the frame on it like canvas/db/question frames, so a stale
// warm-up turn or leftover background job is aborted instead of executed.

import { createConnection } from 'node:net'
import { randomUUID } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'mtnode-tools'
export const inject = ['tools']

const MAX_DESC = 700

function jsonResult(value) {
  let text
  try {
    text = JSON.stringify(value)
  } catch {
    text = String(value)
  }
  return [{ type: 'text', text: String(text).slice(0, 40000) }]
}

/** 参数 kind ∈ text|image → JSON schema 属性类型（image 传本地绝对路径字符串） */
function paramSchema(p, i) {
  const kind = p && p.kind === 'image' ? 'image' : 'text'
  const base =
    kind === 'image'
      ? { type: 'string', description: '图片参数：本地图片文件的绝对路径（应用内资产路径或磁盘绝对路径）' }
      : { type: 'string', description: '文本参数' }
  if (p && p.name) base.description = p.name + '：' + base.description
  base.required = true
  return base
}

export function apply(ctx) {
  const raw = String(process.env.MTNODE_TOOLS_JSON || '').trim()
  if (!raw) return
  let tools = []
  try {
    tools = JSON.parse(raw)
  } catch {
    return
  }
  if (!Array.isArray(tools) || !tools.length) return
  /* 防呆：只收合法描述子；toolName 由宿主预生成（ASCII 标识），这里不再清洗 */
  tools = tools.filter(
    (x) =>
      x &&
      typeof x === 'object' &&
      typeof x.key === 'string' &&
      x.key &&
      typeof x.toolName === 'string' &&
      /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/.test(x.toolName),
  )
  if (!tools.length) return

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
    for (const [, p] of pending) {
      p.reject(err)
    }
    pending.clear()
  }

  const onLine = (line) => {
    let m
    try { m = JSON.parse(line) } catch { return }
    if (!m || typeof m.id !== 'string') return
    const p = pending.get(m.id)
    if (!p) return
    if (m.t === 'tool-result') {
      pending.delete(m.id)
      if (m.ok === false) p.reject(new Error(String(m.error || 'tool run failed')))
      else p.resolve(m.result == null ? { ok: true } : m.result)
    } else if (m.t === 'abort') {
      pending.delete(m.id)
      p.reject(new Error('tool call aborted (task ended)'))
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
      failAll(new Error('tool channel closed'))
      setTimeout(connect, 2000)
    })
  }
  connect()

  for (const tool of tools) {
    const inputs = Array.isArray(tool.inputs) ? tool.inputs : []
    const parameters = {}
    const inputKeys = []
    for (let i = 0; i < inputs.length; i++) {
      const p = inputs[i] || {}
      const key = String(p.name || 'arg' + (i + 1))
      if (parameters[key] !== undefined) continue
      parameters[key] = paramSchema(p, i)
      inputKeys.push(key)
    }
    const outputDesc = (Array.isArray(tool.outputs) ? tool.outputs : [])
      .map((o) => (o && o.name) || '')
      .filter(Boolean)
      .join('、')

    const nameHuman = String(tool.name || tool.toolName || '')
    const descText =
      `用户工具节点「${nameHuman}」：${String(tool.description || '').slice(0, MAX_DESC)}` +
      (inputKeys.length
        ? `\n入参：${inputKeys.join('、')}`
        : '\n无入参') +
      (outputDesc ? `\n返回：${outputDesc}` : '\n无返回值（执行副作用）') +
      '\n调用本工具会在 MTNode 画布/工具库上运行该工具节点（固定入出参的容器图），返回各输出端子的值。'

    const toolKey = tool.key
    ctx.tools.register(defineTool({
      name: tool.toolName,
      description: descText,
      parameters,
      timeoutMs: 900000,
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => jsonResult(value),
      },
      async execute(args, exec) {
        if (!socket || socket.destroyed) {
          return Promise.reject(new Error('tool channel unavailable (only works inside the MTNode app)'))
        }
        const id = randomUUID()
        const sessionId = exec && exec.agent ? String(exec.agent.id || '') : ''
        return new Promise((resolve, reject) => {
          pending.set(id, { resolve, reject })
          send({ t: 'tool', id, sessionId, tool: { key: toolKey, toolName: tool.toolName, name: nameHuman }, args: args || {} })
          const onAbort = () => {
            if (!pending.has(id)) return
            pending.delete(id)
            send({ t: 'drop', id, sessionId })
            reject(new Error('tool call aborted'))
          }
          exec && exec.signal && exec.signal.addEventListener('abort', onAbort, { once: true })
        })
      },
    }))
  }
}
