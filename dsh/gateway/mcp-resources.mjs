/**
 * MTNode MCP 资源面（网关进程内）—— 只读的「这台 MCP 服务器有哪些资源、内容长什么样」。
 *
 * 为什么这条链路自己实现而不是复用运行时里的 @deepseek-ai/dsh-mcp-resources：
 *   那个包把资源能力做成**模型可见的三个工具**（供 Agent 在任务里用），它没有对外的
 *   查询接口（McpResourceRuntime.request 是私有的）。而「扩展能力管理」对话框要的是
 *   宿主侧的只读面板：列出资源、点开看一眼、把 URI 抄进对话当上下文。
 *   所以这里在网关进程里直接用官方 SDK（@modelcontextprotocol/client，随 dsh-mcp-client
 *   一起装在本仓 dsh/gateway/node_modules 里）连一次服务器，读它暴露的资源。
 *
 * 边界（刻意保守）：
 *   · 只发 resources/list 与 resources/read 两类**只读**请求，绝不调用工具；
 *   · stdio 服务器要**临时起一个进程**：多数 MCP 服务器允许并存，但本机若已有一份在跑，
 *     可能出现文件锁 / 端口占用 —— 所以这条只在用户点开某台服务器时触发，不是后台轮询；
 *   · 连接按 <serverName> 缓存 60 秒空闲（避免每次点开都冷起进程），到期自动 close；
 *   · 任何失败都回 { ok:false, error }，绝不把异常抛进 stdio 主循环。
 *
 * 契约（gateway 本地协议方法 `mcpResources`）：
 *   { action:'list', serverName } → { ok, resources:[{uri,name,title?,description?,mimeType?,size?}],
 *                                     templates:[{uriTemplate,name,title?,description?,mimeType?}] }
 *   { action:'read', serverName, uri } → { ok, contents:[{uri,mimeType?,text?|blobBytes?}] }
 */
import path from 'node:path'

/** 空闲多久回收连接（毫秒）：够用户连点几台服务器，又不会长期占着 MCP 子进程 */
const IDLE_MS = 60_000
/** 单次请求上限（毫秒）：stdio 冷起 + 网络往返都算在内 */
const CALL_TIMEOUT_MS = 20_000

/** @type {Map<string, {client:any, transport:any, timer:any}>} */
const conns = new Map()

/** 动态 import 官方客户端（与本文件同处 dsh/gateway/node_modules） */
async function loadSdk() {
  const mod = await import('@modelcontextprotocol/client')
  return mod
}

function dropConn(serverName) {
  const cur = conns.get(serverName)
  if (!cur) return
  conns.delete(serverName)
  if (cur.timer) clearTimeout(cur.timer)
  Promise.resolve()
    .then(() => cur.client && cur.client.close && cur.client.close())
    .catch(() => {})
    .finally(() => {
      try {
        cur.transport && cur.transport.close && cur.transport.close()
      } catch {}
    })
}

/** 空闲计时：每次用过之后重置；到期回收 */
function touchConn(serverName) {
  const cur = conns.get(serverName)
  if (!cur) return
  if (cur.timer) clearTimeout(cur.timer)
  cur.timer = setTimeout(() => dropConn(serverName), IDLE_MS)
  if (cur.timer && typeof cur.timer.unref === 'function') cur.timer.unref()
}

/**
 * 取（或建）一台 MCP 服务器的连接。
 * @param {{serverName:string, transport:string, command?:string, args?:string, url?:string}} cfg
 * @returns {Promise<any>} 已连接的 SDK Client
 */
async function connOf(cfg) {
  const name = String(cfg.serverName || '')
  const cur = conns.get(name)
  if (cur) {
    touchConn(name)
    return cur.client
  }
  const sdk = await loadSdk()
  let transport
  if (String(cfg.transport) === 'stdio') {
    const command = String(cfg.command || '').trim()
    if (!command) throw new Error('这台服务器没有配置 command')
    /* args 在本仓里存成一行字符串（见 app-plugins.js 的表单口径）：按 shell 词法切分，
       带引号的参数保留整体 —— 与用户在手填时的直觉一致。 */
    const argv = splitArgs(String(cfg.args || ''))
    transport = new sdk.StdioClientTransport({ command, args: argv })
  } else {
    const url = String(cfg.url || '').trim()
    if (!url) throw new Error('这台服务器没有配置 URL')
    transport = new sdk.StreamableHTTPClientTransport(new URL(url))
  }
  const client = new sdk.Client({ name: 'mtnode', version: '1.0.0' }, { capabilities: {} })
  await client.connect(transport)
  conns.set(name, { client, transport, timer: null })
  touchConn(name)
  return client
}

/** 极简 shell 词法切分（支持单 / 双引号），命令行参数用 */
function splitArgs(s) {
  const out = []
  let cur = ''
  let quote = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (quote) {
      if (c === quote) quote = ''
      else cur += c
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      continue
    }
    if (/\s/.test(c)) {
      if (cur) {
        out.push(cur)
        cur = ''
      }
      continue
    }
    cur += c
  }
  if (cur) out.push(cur)
  return out
}

/** 给单次调用套超时（MCP 服务器卡住时别把整个请求挂死） */
function withTimeout(promise, ms, what) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} 超时（${Math.round(ms / 1000)}s）`)), ms)
    if (timer && typeof timer.unref === 'function') timer.unref()
    promise.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      }
    )
  })
}

/** 资源条目归一：只留界面要显示的字段（大字段一律不带上） */
function slimResource(r) {
  const o = r && typeof r === 'object' ? r : {}
  return {
    uri: String(o.uri || ''),
    name: String(o.name || ''),
    ...(o.title !== undefined ? { title: String(o.title) } : {}),
    ...(o.description !== undefined ? { description: String(o.description) } : {}),
    ...(o.mimeType !== undefined ? { mimeType: String(o.mimeType) } : {}),
    ...(Number.isFinite(o.size) ? { size: Number(o.size) } : {}),
  }
}

function slimTemplate(t) {
  const o = t && typeof t === 'object' ? t : {}
  return {
    uriTemplate: String(o.uriTemplate || ''),
    name: String(o.name || ''),
    ...(o.title !== undefined ? { title: String(o.title) } : {}),
    ...(o.description !== undefined ? { description: String(o.description) } : {}),
    ...(o.mimeType !== undefined ? { mimeType: String(o.mimeType) } : {}),
  }
}

/** 单条内容归一：文本直出；二进制只回体积（界面不该把一张图糊进详情里） */
function slimContent(c) {
  const o = c && typeof c === 'object' ? c : {}
  const out = { uri: String(o.uri || '') }
  if (o.mimeType !== undefined) out.mimeType = String(o.mimeType)
  if (typeof o.text === 'string') out.text = o.text
  if (typeof o.blob === 'string') out.blobBytes = Math.floor((o.blob.length * 3) / 4)
  return out
}

/**
 * 本地协议方法 `mcpResources` 的实现。
 * @param {object} params - { action, serverName, uri?, servers? }
 * @returns {Promise<object>} 一律回 { ok, … } 或 { ok:false, error }（不抛）
 */
export async function handleMcpResources(params) {
  const p = params && typeof params === 'object' ? params : {}
  const action = String(p.action || 'list')
  const serverName = String(p.serverName || '').trim()
  if (!serverName) return { ok: false, error: '缺少 serverName' }
  const list = Array.isArray(p.servers) ? p.servers : []
  const cfg = list.find((s) => String((s && s.serverName) || '') === serverName)
  if (!cfg) return { ok: false, error: '这台服务器不在配置里（可能已被移除）' }
  if (cfg.disabled) return { ok: false, error: '这台服务器已停用，先启用再读资源' }
  try {
    const client = await withTimeout(connOf(cfg), CALL_TIMEOUT_MS, '连接 MCP 服务器')
    if (action === 'read') {
      const uri = String(p.uri || '').trim()
      if (!uri) return { ok: false, error: '缺少 uri' }
      const res = await withTimeout(client.readResource({ uri }), CALL_TIMEOUT_MS, '读取资源')
      const contents = Array.isArray(res && res.contents) ? res.contents : []
      return { ok: true, contents: contents.slice(0, 20).map(slimContent) }
    }
    if (action === 'list') {
      const resources = []
      const templates = []
      try {
        const r = await withTimeout(client.listResources(), CALL_TIMEOUT_MS, '列出资源')
        for (const x of (r && r.resources) || []) resources.push(slimResource(x))
      } catch (err) {
        /* 服务器没有资源能力时会直接报方法不存在：这不是故障，回空清单即可 */
        if (!/method not found|-32601|not supported|capabilit/i.test(String((err && err.message) || err))) {
          throw err
        }
      }
      try {
        const t = await withTimeout(client.listResourceTemplates(), CALL_TIMEOUT_MS, '列出资源模板')
        for (const x of (t && t.resourceTemplates) || []) templates.push(slimTemplate(x))
      } catch {
        /* 模板是可选能力：没有就当空 */
      }
      return { ok: true, resources: resources.slice(0, 200), templates: templates.slice(0, 100) }
    }
    return { ok: false, error: `未知动作：${action}` }
  } catch (err) {
    /* 连接失败就别留着半死连接，否则下一次点开还是同一个错 */
    dropConn(serverName)
    const msg = String((err && err.message) || err)
    const hint = /ENOENT/i.test(msg)
      ? '（找不到命令：确认可执行文件在 PATH 里，或把 command 写成绝对路径）'
      : /timeout|超时/i.test(msg)
        ? '（服务器没有在限时内回应）'
        : ''
    return { ok: false, error: msg.slice(0, 400) + hint }
  }
}

/** 进程退出 / 网关关闭时收掉全部连接 */
export function closeMcpResources() {
  for (const name of [...conns.keys()]) dropConn(name)
}
