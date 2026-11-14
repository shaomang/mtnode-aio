/* 联网搜索 / 阅读链接的**运行时挂载点**（mtnode-web-tools · 跑在 dsh 运行时进程内）。
 * 同一处补丁还承载「会话附件」的请求侧还原（见文件末尾 installFetchPatch 的说明）。
 *
 * 为什么需要这一层：服务端工具不是 MTNode 自己抓网页，而是 DeepSeek 上游执行的工具 ——
 * 客户端只在请求体 `tools` 里声明两条，搜索/抓取的结果从同一条 SSE 里**旁路**回来
 * （协议与逐帧样本见 docs/deepseek-web-tools-probe.md，纯函数真源是 deepseek-web-tools.mjs）。
 * 但两条适配器都不给外部注入 HTTP 层的机会：
 *   · `llm-pi-ai`（中转 / 自定义 OpenAI 兼容卡）在 lib/index.js:1934 自己拼 streamSimple 的
 *     options，没有 fetch 透传口；
 *   · `llm-deepseek`（官方 Messages 面）直接用全局 fetch。
 * 所以本插件在**运行时进程内**替换 `globalThis.fetch`，只对这两个端点生效：
 *   · `…/chat/completions` → wrapFetchWithServerTools（旁路 server_tool_event / server_tool_calls /
 *     annotations 三个扩展键）；
 *   · `…/messages`（Messages 面）→ wrapMessagesFetchWithServerTools（把 server_tool_use /
 *     web_search_tool_result / web_fetch_tool_result 三类块整块摘掉再往下交 —— 官方适配器
 *     对它们没有分支，留着会 UNSUPPORTED_CONTENT 整轮失败）。
 * 其余任何请求一律原样放行：不读、不改、不重发。
 *
 * 会话归属：网关的交互帧门控要求每帧自带本轮 session id（见 gateway.mjs 的归属校验）。
 * fetch 本身不带会话信息，所以这里在 `llm/stream` 瀑布上把 `options.sessionId` 记进
 * AsyncLocalStorage，并把返回的流逐次 `next()` 都放在那个作用域里执行 —— 适配器内部的
 * fetch 调用因此能拿到「这是哪个会话在发请求」。没有作用域（辅助调用：标题 / 压缩）时
 * 既不注入声明也不发帧。
 *
 * 失败面（与其它插件同一纪律）：env 缺席 / 解析失败 / 非文本事件流 / 桥没连上 —— 一律
 * 原样放行，行为与接入本能力前一字不差；注入或改写过程抛错也只退化成「照常发原始请求」，
 * 绝不因为联网搜索把会话跑挂。
 *
 * 本文件只 import node 内置、deepseek-web-tools.mjs 与 llm-attachments.mjs（都是纯函数），
 * 不碰 node_modules。
 *
 * 同一处补丁还负责**会话附件**（PDF / Word / 文本 / 表格）：消息里那份 `[[mtnode-attach:…]]`
 * 标记在这里被还原成服务商原生的附件部分（OpenAI 面 `{type:'file',file_id}`；Messages 面
 * `{type:'document',source:{type:'file',file_id}}` + `anthropic-beta: files-api-2025-04-14`）。
 * 它与联网开关无关（附件是每轮数据，不是运行期开关），标记格式与自我保护都在
 * llm-attachments.mjs 里（单一真源，网关写、这里读）。
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { createConnection } from 'node:net'
import { randomUUID } from 'node:crypto'
import {
  wrapFetchWithServerTools,
  wrapMessagesFetchWithServerTools,
} from './deepseek-web-tools.mjs'
import { rewriteAttachMarkers } from './llm-attachments.mjs'

export const name = 'mtnode-web-tools'

export const inject = ['llm']

/** 全局 fetch 只包一次（插件重载 / 多次 apply 都不会套娃） */
const PATCH_KEY = Symbol.for('mtnode.webToolsFetchPatch')

/** 端点 → 协议面（只有这两个面能承载服务端工具；别的端点一个字都不改） */
const FACE_BY_PATH = [
  { match: /\/chat\/completions\/?$/i, face: 'openai' },
  { match: /\/messages\/?$/i, face: 'messages' },
]

/** 读 spawn env 里的本轮计划（gateway.mjs 的 MTNODE_WEB_TOOLS）。解析不了就整体关掉。 */
function planOf() {
  let raw = ''
  try {
    raw = String(process.env.MTNODE_WEB_TOOLS || '').trim()
  } catch {
    return null
  }
  if (!raw) return null
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  if (parsed.enabled !== true) return null
  const tools = Array.isArray(parsed.tools) ? parsed.tools.filter((t) => typeof t === 'string') : []
  if (!tools.length) return null
  return {
    enabled: true,
    webSearch: parsed.webSearch !== false,
    readUrl: parsed.readUrl !== false,
    provider: parsed.provider && typeof parsed.provider === 'object' ? parsed.provider : null,
    baseUrl: typeof parsed.baseUrl === 'string' ? parsed.baseUrl : '',
    tools,
  }
}

/** 请求 URL 落在哪个协议面（不是这两个端点 → 空串，调用方原样放行）。 */
function faceOf(url) {
  const s = String(url == null ? '' : url)
  if (!s) return ''
  for (const row of FACE_BY_PATH) if (row.match.test(s)) return row.face
  return ''
}

/** 端点主机是不是本轮这家服务商（host 不一致一律不碰：同进程里还有别的服务在跑）。 */
function hostMatches(url, plan) {
  let host = ''
  try {
    host = new URL(String(url)).hostname.toLowerCase()
  } catch {
    return false
  }
  if (!host) return false
  const base = String(plan.baseUrl || '').trim()
  if (base) {
    try {
      const want = new URL(base).hostname.toLowerCase()
      if (want && want === host) return true
    } catch {
      /* baseUrl 不合法就退回下面那条 deepseek 判据 */
    }
  }
  return host.includes('deepseek')
}

/** 把 LLM 流包一层作用域：每次 next() 都在「这条流属于谁」的上下文里跑。 */
function scopeStream(stream, als, store) {
  if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') return stream
  const inner = stream[Symbol.asyncIterator]()
  return {
    [Symbol.asyncIterator]() {
      return this
    },
    next(...args) {
      return als.run(store, () => inner.next(...args))
    },
    return(value) {
      if (typeof inner.return !== 'function') return Promise.resolve({ done: true, value })
      return als.run(store, () => inner.return(value))
    },
    throw(error) {
      if (typeof inner.throw !== 'function') return Promise.reject(error)
      return als.run(store, () => inner.throw(error))
    },
  }
}

export function apply(ctx) {
  /* 计划可能为空（联网关着）：补丁照样装 —— 会话附件的还原与联网开关无关。 */
  const plan = planOf()
  const port = Number(process.env.MTNODE_BRIDGE_PORT || 0)
  const scope = new AsyncLocalStorage()
  /** 兜底归属：流还没进入作用域就发帧时（理论上不会）用最近一条会话 id */
  let lastSessionId = ''

  /* ── 桥（与 bridge-plugin 同一条 localhost TCP 通道，这里只写不读） ── */
  let socket = null
  let buf = ''
  const connect = () => {
    if (!Number.isInteger(port) || port <= 0) return
    const s = createConnection({ host: '127.0.0.1', port })
    socket = s
    /* 网关只会往回发 answer/outcome/abort（那是交互帧的），本插件不接受任何指令：
       收到就丢，但必须把数据读掉，否则 socket 缓冲会积压。 */
    s.on('data', (d) => {
      buf += d.toString()
      let i
      while ((i = buf.indexOf('\n')) >= 0) buf = buf.slice(i + 1)
      if (buf.length > 65536) buf = ''
    })
    s.on('error', () => {})
    s.on('close', () => {
      if (socket === s) socket = null
      setTimeout(connect, 2000)
    })
  }
  connect()

  /** 扩展块 → 网关帧（{t:'web-tool', id, sessionId, ext}，见 gateway.mjs 的 web-tool 分支） */
  const sendExtension = (ext) => {
    if (!ext || typeof ext !== 'object') return
    const store = scope.getStore()
    const sessionId = (store && store.sessionId) || lastSessionId
    if (!sessionId) return
    const s = socket
    if (!s || s.destroyed) return
    try {
      s.write(JSON.stringify({ t: 'web-tool', id: randomUUID(), sessionId, ext }) + '\n')
    } catch {
      /* 桥断了：这一轮的卡片会缺，但模型流不受影响 */
    }
  }

  /* 会话作用域：llm 瀑布每步一次，options.sessionId 就是网关认的那枚 id。
     purpose 不为空 = 辅助调用（压缩 / 标题这类），既不注入声明也不发帧。 */
  try {
    ctx.on('llm/stream', (options, next) => {
      const sid = options && options.sessionId != null ? String(options.sessionId) : ''
      const purpose = options && options.purpose != null ? String(options.purpose) : ''
      if (!sid || purpose) return next()
      lastSessionId = sid
      return scopeStream(next(), scope, { sessionId: sid })
    })
  } catch {
    /* 注册失败 = 联网那一半整链 no-op（不注入、不发帧）；附件的还原也拿不到会话作用域，
       于是同样原样放行 —— 其余行为一字不变 */
  }

  installFetchPatch(plan, scope, sendExtension)
}

/** 装全局 fetch 补丁（只装一次；计划按 switch 更新，见下）。 */
function installFetchPatch(plan, scope, sendExtension) {
  const existing = globalThis[PATCH_KEY]
  if (existing) {
    existing.plan = plan
    return
  }
  const base = globalThis.fetch
  if (typeof base !== 'function') return
  const state = { plan }

  const patched = async function mtnodeWebToolsFetch(input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || ''
    const face = faceOf(url)
    const store = scope.getStore()
    if (!face) return base(input, init)
    /* ── ① 会话附件：与本轮联网开关无关 ──
       标记自带服务商主机名与过期时刻（见 llm-attachments.mjs），所以这里只要求
       「这条请求属于某个会话」；标题 / 压缩这类辅助调用没有作用域，原样放行。
       Messages 面的 document 块缺 beta 头会整轮 400，所以头在这里补上（已有则合并）。 */
    let next = init
    const body = init && typeof init.body === 'string' ? init.body : ''
    if (body && store && store.sessionId) {
      try {
        const r = rewriteAttachMarkers(body, { face, url })
        if (r.changed) {
          const headers = new Headers((init && init.headers) || undefined)
          headers.delete('content-length')
          if (r.beta) {
            const prev = String(headers.get('anthropic-beta') || '').trim()
            const list = prev ? prev.split(',').map((x) => x.trim()).filter(Boolean) : []
            if (!list.includes(r.beta)) list.push(r.beta)
            headers.set('anthropic-beta', list.join(','))
          }
          next = { ...init, body: r.body, headers }
        }
      } catch {
        /* 附件还原失败 = 这一轮没有附件，正文与其它一切照旧 */
        next = init
      }
    }
    const send = (i2) => base(input, i2)
    /* ── ② 服务端工具：三条硬闸（认得的端点、本轮这家服务商、有会话作用域）── */
    if (!store || !store.sessionId || !state.plan || state.plan.enabled !== true) return send(next)
    if (!hostMatches(url, state.plan)) return send(next)
    const callPlan = {
      provider: state.plan.provider || 'deepseek-official',
      enabled: true,
      webSearch: state.plan.webSearch,
      readUrl: state.plan.readUrl,
      onExtension: sendExtension,
    }
    try {
      const wrap = face === 'messages' ? wrapMessagesFetchWithServerTools : wrapFetchWithServerTools
      return await wrap(base, callPlan)(input, next)
    } catch {
      /* 注入/改写失败：退回原始请求，绝不因为「联网搜索接线」把这一轮跑挂 */
      return send(next)
    }
  }

  try {
    globalThis.fetch = patched
    globalThis[PATCH_KEY] = { plan, base }
  } catch {
    /* 冻结的全局（理论上不会有）→ 保持未接入状态 */
  }
}
