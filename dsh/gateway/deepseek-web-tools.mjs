// DeepSeek 服务端工具（联网搜索 / 阅读链接）：请求声明注入 + SSE 扩展块旁路。
//
// 协议唯一依据是 docs/deepseek-web-tools-probe.md（本机真 key 实测，2026-11-14）。两条面都实测过：
//
//   A. OpenAI 兼容面 `/chat/completions`（pi-ai 的 openai-completions 路由 = MTNode 中转 /
//      自定义卡）：扩展块是 `choices[].server_tool_event` / `delta.server_tool_calls` /
//      `delta.annotations` 三个**旁路键**，`content` 是纯字符串 → `createSseExtensionSplitter()`。
//   B. Messages 面 `/anthropic/v1/messages`（官方 `llm-deepseek` 适配器）：声明**同样形状**、
//      同样 200 真执行（§2.5 实测），但回来的不是旁路键，而是 Anthropic 原生内容块
//      `server_tool_use` / `web_search_tool_result` / `web_fetch_tool_result`，行内引用走
//      `content_block_delta.delta.type === 'citations_delta'`（带 `cited_text`，**没有**
//      start/end index）→ `createMessagesSseRewriter()`。
//      官方适配器对这三类块**没有任何分支**（`startBlock()` 的 default 分支直接
//      `UNSUPPORTED_CONTENT`），所以这一面必须把块整块摘掉再往下交，否则一开联网就整轮失败。
//   · 声明：`tools` 里放 `{"type":"deepseek_web_search","name":"deepseek_web_search"}` /
//     `{"type":"deepseek_read_url","name":"deepseek_read_url"}`；写成 `{"type":"web_search"}`
//     会被上游 422。服务端工具与 `function` 工具**可以共存**（同一 `tools` 数组）。
//   · 扩展块（pi-ai 的 openai-completions 解析器不认识、也不该进模型上下文的旁路数据）：
//       ① `choices[].server_tool_event` —— 进度（`delta` 为空对象）
//       ② 收尾 `delta.server_tool_calls` —— 工具账本（`deepseek_read_url` 的 `signature` 在这里，
//          多轮回放必须带回，否则抓取正文静默消失）
//       ③ 收尾 `delta.annotations` —— `url_citation` 行内引用区间
//     `content` 自始至终是**纯字符串**（不是 Anthropic 那套块数组，`server_tool_use` 只存在于
//     `usage` 里的计数器）。
//
// 落地方式（本文件只提供纯函数，不自己起连接、不自己打日志）：
//   首选 = `wrapFetchWithServerTools()` / `wrapMessagesFetchWithServerTools()` 包一层 fetch：
//   请求体加服务端工具声明，响应流只把标准 delta 交给适配器，扩展块走 `onExtension` 旁路。
//   ⚠️ pi-ai 与 llm-deepseek 都不透传 fetch（llm-pi-ai lib/index.js:1934 自己拼 options；
//   llm-deepseek 用的是全局 fetch），所以真正的挂载点在运行时插件
//   `dsh/gateway/web-tools-plugin.mjs`：它在运行时进程里替换 `globalThis.fetch`（只认这两个
//   端点、只在本轮带会话作用域时生效），把本文件的 wrappers 挂上去。
//   **不改 node_modules**，也不注册自定义适配器（那会丢掉 replayState / 图像投影等保真）。
//   判定函数 `isDeepSeekWebToolsProvider()` 同时覆盖官方路由（`id==='deepseek'` /
//   `deepseek-official` / 主机名含 deepseek）与中转（`source==='mtnode-relay'`，实测中转
//   原样透传服务端工具）。

/** 上游接受的两件服务端工具（名字即协议，写成别的值会 422，见探针文档 2.1） */
export const DEEPSEEK_SERVER_TOOLS = Object.freeze({
  webSearch: Object.freeze({ type: 'deepseek_web_search', name: 'deepseek_web_search' }),
  readUrl: Object.freeze({ type: 'deepseek_read_url', name: 'deepseek_read_url' }),
})

/** 服务端工具的 type 白名单（只用于识别「已有的服务端工具声明」，不当上游校验用） */
const SERVER_TOOL_TYPES = new Set(Object.values(DEEPSEEK_SERVER_TOOLS).map((t) => t.type))

/** 网关官方路由名（routeOfProvider 的返回值，与配置里的 id=deepseek 指同一件事） */
const OFFICIAL_IDS = new Set(['deepseek', 'deepseek-official'])

/** 中转卡（renderer/app-relay.js 写入的 source 常量，与 main.js 的 RELAY_PROVIDER_SOURCE 同值） */
const RELAY_SOURCE = 'mtnode-relay'

/**
 * 判定一个服务商是否该注入 DeepSeek 服务端工具（纯函数，不联网）。
 *
 * 命中任一即 true：
 *   · `id === 'deepseek'`（或网关官方路由名 `deepseek-official`）
 *   · `baseUrl` 的主机名含 `deepseek`（大小写不敏感；URL 解析失败时退回整串匹配）
 *   · `source === 'mtnode-relay'`（MTNode 中转：实测原样透传服务端工具）
 *
 * @param {object|string|null|undefined} provider 服务商配置对象，或直接给一个 id / 路由名
 * @returns {boolean}
 */
export function isDeepSeekWebToolsProvider(provider) {
  if (provider == null) return false
  if (typeof provider === 'string') return OFFICIAL_IDS.has(provider.trim().toLowerCase())
  if (typeof provider !== 'object') return false
  const id = String(provider.id == null ? '' : provider.id).trim().toLowerCase()
  if (OFFICIAL_IDS.has(id)) return true
  if (String(provider.source == null ? '' : provider.source).trim() === RELAY_SOURCE) return true
  return hostnameHasDeepSeek(provider.baseUrl)
}

/**
 * baseUrl 的主机名是否含 `deepseek`（纯函数；不合法 URL 退回整串匹配，绝不猜端点）。
 * @param {unknown} raw
 * @returns {boolean}
 */
export function hostnameHasDeepSeek(raw) {
  const s = String(raw == null ? '' : raw).trim()
  if (!s) return false
  try {
    const u = new URL(s)
    return u.hostname.toLowerCase().includes('deepseek')
  } catch {
    return s.toLowerCase().includes('deepseek')
  }
}

/**
 * 按开关构造要并入请求 `tools` 的服务端工具声明（纯函数）。
 *
 * 开关口径（缺省全部保守）：
 *   · `enabled`   —— 总开关，**缺省 false**：没人在设置里打开就一条声明都不加；
 *   · `webSearch` —— 联网搜索，缺省 true（总开关打开时）；
 *   · `readUrl`   —— 阅读链接，缺省 true（总开关打开时）。它每次调用会带约 1904 字符
 *     signature、下一轮 prompt 多约 270 token（探针文档 5.4），调用方可用它单独关掉。
 *
 * 非 DeepSeek 系服务商恒回空数组（第三方走自己的协议，声明这两条会被上游拒）。
 *
 * @param {object|string|null} provider 服务商配置（同 isDeepSeekWebToolsProvider）
 * @param {{enabled?: boolean, webSearch?: boolean, readUrl?: boolean}} [options]
 * @returns {Array<{type: string, name: string}>}
 */
export function buildServerTools(provider, options = {}) {
  if (!isDeepSeekWebToolsProvider(provider)) return []
  if (options == null || !options.enabled) return []
  const out = []
  if (options.webSearch !== false) out.push({ ...DEEPSEEK_SERVER_TOOLS.webSearch })
  if (options.readUrl !== false) out.push({ ...DEEPSEEK_SERVER_TOOLS.readUrl })
  return out
}

/**
 * 把服务端工具声明并进一份**已解析**的请求体（纯函数：不改入参，返回新对象）。
 *
 * 规则：服务端工具排在前面（与探针文档「服务端工具 + function 工具共存」的样本同形），
 * 已有的同 type 声明先摘掉（重复声明没必要，且开关关掉后不该留残余），其余工具原样保序。
 * `body.tools` 不是数组时按「没有工具」处理。
 *
 * @param {object|null} body
 * @param {object|string|null} provider
 * @param {object} [options] 同 buildServerTools
 * @returns {object|null} 入参不是对象时原样返回
 */
export function applyServerTools(body, provider, options) {
  if (body == null || typeof body !== 'object' || Array.isArray(body)) return body
  const extra = buildServerTools(provider, options)
  if (!extra.length) return body
  const existing = Array.isArray(body.tools) ? body.tools : []
  const kept = existing.filter((tool) => !isServerTool(tool))
  return { ...body, tools: [...extra, ...kept] }
}

/**
 * 同上，但作用于 JSON 文本（纯函数）：不是 JSON 对象的文本原样返回（绝不猜内容）。
 * @param {string} text
 * @param {object|string|null} provider
 * @param {object} [options]
 * @returns {string}
 */
export function applyServerToolsJson(text, provider, options) {
  const raw = String(text == null ? '' : text)
  if (!raw.trim()) return raw
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return raw
  }
  const next = applyServerTools(parsed, provider, options)
  return next === parsed ? raw : JSON.stringify(next)
}

/** 一条工具声明是不是 DeepSeek 服务端工具（只看 type，不当上游白名单用）。 */
function isServerTool(tool) {
  return !!tool && typeof tool === 'object' && SERVER_TOOL_TYPES.has(String(tool.type || ''))
}

/* ── SSE 扩展块解析 ─────────────────────────────────────────────────────────── */

/** 扩展块种类（事件名口径，渲染层按它分流渲染） */
export const EXTENSION_KINDS = Object.freeze({
  progress: 'server-tool-progress',   // choices[].server_tool_event
  calls: 'server-tool-calls',         // delta.server_tool_calls（含 signature）
  citations: 'annotations',           // delta.annotations（url_citation）
})

/**
 * 创建一个 SSE 分片改写器（纯函数式：进字符串、出字符串，扩展块走回调旁路）。
 *
 * 用法：`const s = createSseExtensionSplitter({ onExtension }); res.write(s.push(chunk)); … res.end(s.flush())`
 *
 * 语义：
 *   · 进来的字节按 SSE 事件（空行分隔）切；只有**含扩展块**的事件会被重写成「去掉扩展键」
 *     的版本 —— 其余字节逐字原样透传（`event:` / `id:` / 注释行 / `[DONE]` 都不动）；
 *   · 扩展键被摘掉、其余字段保留（`finish_reason` / `usage` 常常与扩展块同帧到达，
 *     丢掉它们 pi-ai 就收不到收尾信号）；
 *   · 半截事件留在缓冲里等下一片，`flush()` 交出尾巴（流结束时的兜底）。
 *
 * @param {{onExtension?: (ext: {kind: string, choiceIndex: number|undefined, data: any}) => void}} [options]
 * @returns {{push: (chunk: unknown) => string, flush: () => string, extensions: Array<object>}}
 */
export function createSseExtensionSplitter(options = {}) {
  const onExtension = typeof options.onExtension === 'function' ? options.onExtension : null
  /** 旁路出去的扩展块（诊断与冒烟可直接读；正常路径走 onExtension） */
  const extensions = []
  let buffer = ''

  const emit = (ext) => {
    extensions.push(ext)
    if (onExtension) {
      try {
        onExtension(ext)
      } catch {
        /* 渲染层/日志侧抛错不该掐断模型流：旁路是尽力而为 */
      }
    }
  }

  const rewriteBlock = (block, trailing) => {
    const rewritten = rewriteSseBlock(block, emit)
    return rewritten + trailing
  }

  return {
    push(chunk) {
      buffer += String(chunk == null ? '' : chunk)
      let out = ''
      for (;;) {
        const cut = findSseBoundary(buffer)
        if (!cut) break
        out += rewriteBlock(buffer.slice(0, cut.index), cut.separator)
        buffer = buffer.slice(cut.index + cut.separator.length)
      }
      return out
    },
    flush() {
      if (!buffer) return ''
      const tail = rewriteBlock(buffer, '')
      buffer = ''
      return tail
    },
    get extensions() {
      return extensions
    },
  }
}

/** 找到第一个 SSE 事件边界（空行）；返回切点与分隔符本身。 */
function findSseBoundary(text) {
  const lf = text.indexOf('\n\n')
  const crlf = text.indexOf('\r\n\r\n')
  if (lf < 0 && crlf < 0) return null
  if (crlf >= 0 && (lf < 0 || crlf < lf)) return { index: crlf, separator: '\r\n\r\n' }
  return { index: lf, separator: '\n\n' }
}

/**
 * 改写一个 SSE 事件块（不含结尾空行）。返回要透传的文本：
 * 没有扩展块时**原样**返回入参（字节级不变），有扩展块时返回摘掉扩展键的重建块。
 */
function rewriteSseBlock(block, emit) {
  if (!block) return block
  const lines = block.split(/\r?\n/)
  const dataIndexes = []
  const dataLines = []
  lines.forEach((line, i) => {
    if (!line || line.startsWith(':')) return
    const colon = line.indexOf(':')
    const field = colon < 0 ? line : line.slice(0, colon)
    let value = colon < 0 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'data') {
      dataIndexes.push(i)
      dataLines.push(value)
    }
  })
  if (!dataLines.length) return block
  const payload = dataLines.join('\n')
  if (payload === '[DONE]') return block
  let json
  try {
    json = JSON.parse(payload)
  } catch {
    /* 非 JSON 数据（上游偶发的心跳/错误文本）原样透传，解析不了就不猜 */
    return block
  }
  if (json == null || typeof json !== 'object') return block
  const found = takeExtensions(json, emit)
  if (!found) return block
  /* 重建：非 data 行保序，第一个 data 位置放一条（已摘掉扩展键的）JSON */
  const out = []
  let placed = false
  lines.forEach((line, i) => {
    if (dataIndexes.includes(i)) {
      if (!placed) {
        out.push('data: ' + JSON.stringify(json))
        placed = true
      }
      return
    }
    out.push(line)
  })
  return out.join('\n')
}

/**
 * 从一帧 JSON 里摘掉三处扩展块（原地删键 —— 调用方拿的是刚 parse 出来的新对象）。
 * 返回是否摘到东西。
 */
function takeExtensions(json, emit) {
  let found = false
  const choices = Array.isArray(json.choices) ? json.choices : []
  for (const choice of choices) {
    if (!choice || typeof choice !== 'object') continue
    const choiceIndex = Number.isInteger(choice.index) ? choice.index : undefined
    if (choice.server_tool_event !== undefined) {
      emit({ kind: EXTENSION_KINDS.progress, choiceIndex, data: choice.server_tool_event })
      delete choice.server_tool_event
      found = true
    }
    const targets = [choice.delta, choice.message]
    for (const target of targets) {
      if (!target || typeof target !== 'object') continue
      if (target.server_tool_calls !== undefined) {
        emit({ kind: EXTENSION_KINDS.calls, choiceIndex, data: target.server_tool_calls })
        delete target.server_tool_calls
        found = true
      }
      if (target.annotations !== undefined) {
        emit({ kind: EXTENSION_KINDS.citations, choiceIndex, data: target.annotations })
        delete target.annotations
        found = true
      }
    }
  }
  return found
}

/**
 * 把一条扩展块翻成网关发给渲染层的帧（纯函数，与 gateway.mjs 的 out() 同形）。
 * @param {string} reqId 本轮 run 的 reqId（走全局通道时给空串）
 * @param {object} ext createSseExtensionSplitter 交出来的扩展块
 * @param {string} [type] 帧类型，缺省 `deepseek-web-tool`
 * @returns {{event: {reqId: string, type: string, data: object}}}
 */
export function extensionFrame(reqId, ext, type = 'deepseek-web-tool') {
  return { event: { reqId: String(reqId == null ? '' : reqId), type, data: ext } }
}

/* ── fetch 包装（首选落地方式） ─────────────────────────────────────────────── */

/**
 * 包一层 fetch：请求体注入服务端工具声明，响应 SSE 只把标准 delta 往下交。
 *
 * 之所以包 fetch 而不是包 provider：pi-ai 在 `createClient()` 里把它交给 OpenAI 客户端
 *（openai-completions.js:186/564），所以这一层对 pi-ai 完全透明 —— 它只看见「正常的」
 * chunk 流。网关侧把它作为 `options.fetch` 传给 pi-ai 即可（自定义适配器路线），或在
 * 有 fetch 透传口的运行时里直接塞进 stream options。
 *
 * 行为：
 *   · `plan.enabled === false`（或缺省）时不改请求、不碰响应，原样返回底层 fetch 的结果；
 *   · 请求体只改 JSON（`string` body 或 Request 的 JSON body），不是 JSON 就原样放过；
 *   · 响应只在 `content-type: text/event-stream` 时做 transform，扩展块经
 *     `plan.onExtension` 旁路，其余响应（非流式 JSON / 报错）原样返回。
 *
 * @param {(input: any, init?: any) => Promise<Response>} fetchImpl 底层 fetch（可 $0 绑定）
 * @param {{
 *   provider?: object|string|null, enabled?: boolean, webSearch?: boolean, readUrl?: boolean,
 *   onExtension?: (ext: object) => void,
 * }} [plan]
 * @returns {(input: any, init?: any) => Promise<Response>}
 */
export function wrapFetchWithServerTools(fetchImpl, plan = {}) {
  const base = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch
  const provider = plan.provider
  const options = {
    enabled: plan.enabled === true,
    webSearch: plan.webSearch,
    readUrl: plan.readUrl,
  }
  const active = options.enabled && isDeepSeekWebToolsProvider(provider)
  return async function deepseekWebToolsFetch(input, init) {
    if (!active) return base(input, init)
    const next = await withServerTools(input, init, provider, options)
    const response = await base(next.input, next.init)
    const type = String((response && response.headers && response.headers.get('content-type')) || '')
    if (!response || !response.body || !/text\/event-stream/i.test(type)) return response
    const splitter = createSseExtensionSplitter({ onExtension: plan.onExtension })
    const decoder = new TextDecoder()
    const encoder = new TextEncoder()
    const body = response.body.pipeThrough(new TransformStream({
      transform(chunk, controller) {
        const text = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })
        const pass = splitter.push(text)
        if (pass) controller.enqueue(encoder.encode(pass))
      },
      flush(controller) {
        const tail = splitter.push(decoder.decode()) + splitter.flush()
        if (tail) controller.enqueue(encoder.encode(tail))
      },
    }))
    /* 头照抄，但长度/编码类必须摘掉：body 已被逐帧改写（长度变了），且解压已由底层做过 */
    const headers = new Headers(response.headers)
    headers.delete('content-length')
    headers.delete('content-encoding')
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    })
  }
}

/** 把请求体（init.body 或 Request 自带的 JSON body）换成注入后的版本。 */
async function withServerTools(input, init, provider, options) {
  const direct = init && typeof init.body === 'string' ? init.body : null
  if (direct != null) {
    const body = applyServerToolsJson(direct, provider, options)
    return body === direct ? { input, init } : { input, init: { ...init, body } }
  }
  const isRequest = typeof Request !== 'undefined' && input instanceof Request
  if (!isRequest) return { input, init }
  let text = ''
  try {
    text = await input.clone().text()
  } catch {
    return { input, init }
  }
  const body = applyServerToolsJson(text, provider, options)
  if (body === text) return { input, init }
  const headers = new Headers(init && init.headers ? init.headers : input.headers)
  headers.set('content-length', String(Buffer.byteLength(body)))
  return {
    input,
    init: { ...(init || {}), method: (init && init.method) || input.method, headers, body },
  }
}

/* ── Messages 面（Anthropic 协议）改写 ────────────────────────────────────────
   与上面的分片器**同一套输出契约**（`EXTENSION_KINDS` 三档 + `{kind, choiceIndex, data}`），
   所以渲染层不需要为「官方 vs 中转」写第二条路径；区别只在「怎么从字节里挖出来」：

     上游（Messages 面，探针 §2.5 实测）                      →  交出去的扩展块
     content_block_start.type = server_tool_use                →  progress: call_started
     content_block_start.type = web_search_tool_result         →  progress: call_completed + sources
     content_block_start.type = web_fetch_tool_result          →  progress: call_completed + page
     content_block_delta.delta.type = citations_delta          →  收尾一次 annotations
     收尾（message_stop / 流结束）                              →  calls 账本（无 signature 形状）

   两类事件**必须整块丢掉**（不是摘键）：
     · 三类工具块：官方适配器 `startBlock()` 的 default 分支对它们抛 UNSUPPORTED_CONTENT，
       留着等于一开联网就整轮失败；而且它们的 wire index 一旦缺席，紧随其后的
       delta / stop 会被判成「delta/stop without an open block」—— 所以按 wire index 记账，
       start / delta / stop 三件一起丢。
     · citations_delta：它们挂在一个**从未 start 过的 index** 上（实测 index 9..13 直接来
       delta），留下同样触发上面那条 malformed。

   行内引用区间的来源差异：OpenAI 面给的是 start_index/end_index，Messages 面只给
   `cited_text`（被引用的那段正文原文）。这里在收尾时把 cited_text 在**本轮答案正文**里
   定位成区间 —— 定位不到就整条跳过（绝不凭印象编一个区间）。 */

/** Messages 面服务端工具块的 type（三个都要摘） */
const MESSAGES_TOOL_BLOCKS = new Set([
  'server_tool_use',
  'web_search_tool_result',
  'web_fetch_tool_result',
])

/** Messages 面 `message_delta.delta.stop_reason` 里官方适配器认得的四个取值 */
const MESSAGES_STOP_REASONS = new Set(['end_turn', 'stop_sequence', 'tool_use', 'max_tokens'])

/**
 * 创建一个 Messages 面（Anthropic SSE）改写器：进字符串、出字符串，工具块走回调旁路。
 *
 * 用法与 `createSseExtensionSplitter` 完全一致：
 * `const r = createMessagesSseRewriter({ onExtension }); res.write(r.push(chunk)); res.end(r.flush())`
 *
 * 语义：
 *   · 没有工具块的事件**逐字原样透传**（`event:` 行、`ping`、`message_start` 都不动）；
 *   · 有工具块 / 引用增量的事件整块丢掉（连结尾空行一起），见上面那段注释；
 *   · `flush()` 收尾时才发 citations（需要全部正文到齐才能定位区间）与 calls 账本，幂等。
 *
 * @param {{onExtension?: (ext: {kind: string, choiceIndex: number|undefined, data: any}) => void}} [options]
 * @returns {{push: (chunk: unknown) => string, flush: () => string, extensions: Array<object>}}
 */
export function createMessagesSseRewriter(options = {}) {
  const onExtension = typeof options.onExtension === 'function' ? options.onExtension : null
  /** 旁路出去的扩展块（诊断与冒烟可直接读；正常路径走 onExtension） */
  const extensions = []
  /** 被整块摘掉的 wire index（start / delta / stop 一起丢） */
  const dropped = new Set()
  /** 调用账本：id → 渲染层认的形状（与 OpenAI 面 `calls[]` 同字段） */
  const calls = new Map()
  /** 调用出现顺序（收尾账本按它排，不按 Map 的插入序猜） */
  const order = []
  /** text 块：wire index → 累计正文（算引用区间用，顺序即块顺序） */
  const textBlocks = new Map()
  /** 待定位的行内引用：{url, title, cited_text} */
  const citations = []
  /** 已经收过尾（flush 幂等） */
  let settled = false
  let buffer = ''

  const emit = (ext) => {
    extensions.push(ext)
    if (onExtension) {
      try {
        onExtension(ext)
      } catch {
        /* 渲染侧抛错不该掐断模型流：旁路是尽力而为 */
      }
    }
  }

  const putCall = (id, call) => {
    if (!id) return
    if (!calls.has(id)) order.push(id)
    calls.set(id, call)
  }

  /** `server_tool_use` → 渲染层的 call（type/kind/action/status 与 OpenAI 面同口径） */
  const callOfUse = (block) => {
    const id = String(block.id == null ? '' : block.id)
    if (!id) return null
    const input = block.input && typeof block.input === 'object' ? block.input : {}
    const action = String(input.action == null ? '' : input.action)
    /* 官方这一面两种动作共用同一个 name（deepseek_web_search）：靠 action 分「搜」与「读页」，
       否则「搜索里顺带打开的页面」会被渲染成第二张搜索卡。 */
    const type =
      action === 'open_page' && input.url
        ? DEEPSEEK_SERVER_TOOLS.readUrl.type
        : String(block.name || DEEPSEEK_SERVER_TOOLS.webSearch.type)
    return {
      id,
      type,
      kind: String(block.kind == null ? '' : block.kind),
      action: input,
      status: 'in_progress',
    }
  }

  /** `web_search_tool_result` / `web_fetch_tool_result` → 把结果补进对应 call */
  const completeOf = (call, block) => {
    const base = { ...call, status: 'completed' }
    const content = block.content
    if (String(block.type) === 'web_search_tool_result') {
      const list = Array.isArray(content) ? content : []
      base.type = DEEPSEEK_SERVER_TOOLS.webSearch.type
      base.sources = list
        .filter((s) => s && typeof s === 'object' && s.url)
        .map((s) => ({ url: String(s.url), title: String(s.title || '') }))
      return base
    }
    const page = content && typeof content === 'object' ? content : {}
    const doc = page.content && typeof page.content === 'object' ? page.content : {}
    base.type = DEEPSEEK_SERVER_TOOLS.readUrl.type
    base.action = { ...(call.action || {}), url: String(page.url || (call.action && call.action.url) || '') }
    base.page = {
      url: String(page.url || ''),
      title: String(doc.title || ''),
      published_at: page.published_at == null ? null : page.published_at,
    }
    return base
  }

  const takeCitation = (raw) => {
    if (!raw || typeof raw !== 'object') return
    const url = String(raw.url == null ? '' : raw.url)
    const cited = String(raw.cited_text == null ? '' : raw.cited_text)
    if (!url || !cited) return
    citations.push({ url, title: String(raw.title || ''), cited_text: cited })
  }

  /** 收尾：citations 定位区间 + calls 账本（各只发一次） */
  const settle = () => {
    if (settled) return
    settled = true
    if (citations.length) {
      const answer = [...textBlocks.values()].join('')
      const seen = new Map()
      const list = []
      for (const c of citations) {
        let at = answer.indexOf(c.cited_text)
        if (at < 0) at = answer.indexOf(c.cited_text.trim())
        if (at < 0) continue
        const start = at
        const end = at + c.cited_text.length
        const hit = seen.get(c.url)
        if (hit) {
          if (start < hit.start_index) hit.start_index = start
          if (end > hit.end_index) hit.end_index = end
          if (!hit.title && c.title) hit.title = c.title
          continue
        }
        const item = { type: 'url_citation', url_citation: { url: c.url, title: c.title, start_index: start, end_index: end } }
        seen.set(c.url, item.url_citation)
        list.push(item)
      }
      if (list.length) {
        /* 区间按起点排一遍：渲染层按到达顺序编号，上游给的是乱序 delta */
        list.sort((a, b) => a.url_citation.start_index - b.url_citation.start_index)
        emit({ kind: EXTENSION_KINDS.citations, choiceIndex: 0, data: list })
      }
    }
    if (order.length) {
      const list = order.map((id, i) => ({ ...calls.get(id), index: i }))
      emit({ kind: EXTENSION_KINDS.calls, choiceIndex: 0, data: [{ index: 0, calls: list }] })
    }
  }

  /** 单个事件块 → { drop } | { drop, json }（后者要按改过的 JSON 重建 data 行） */
  const handle = (eventName, json) => {
    const type = String(json.type || eventName || '')
    if (type === 'content_block_start') {
      const index = Number(json.index)
      const block = json.content_block && typeof json.content_block === 'object' ? json.content_block : {}
      const blockType = String(block.type || '')
      if (blockType === 'server_tool_use') {
        const call = callOfUse(block)
        if (call) {
          putCall(call.id, call)
          emit({
            kind: EXTENSION_KINDS.progress,
            choiceIndex: 0,
            data: { type: 'call_started', step: index, call: { ...call } },
          })
        }
        dropped.add(index)
        return { drop: true }
      }
      if (MESSAGES_TOOL_BLOCKS.has(blockType)) {
        const id = String(block.tool_use_id == null ? '' : block.tool_use_id)
        const call = calls.get(id)
        if (call) {
          const next = completeOf(call, block)
          putCall(id, next)
          emit({
            kind: EXTENSION_KINDS.progress,
            choiceIndex: 0,
            data: { type: 'call_completed', step: index, call: { ...next } },
          })
        }
        dropped.add(index)
        return { drop: true }
      }
      if (blockType === 'text') textBlocks.set(index, String(block.text == null ? '' : block.text))
      return { drop: false }
    }
    if (type === 'content_block_delta') {
      const index = Number(json.index)
      if (dropped.has(index)) return { drop: true }
      const delta = json.delta && typeof json.delta === 'object' ? json.delta : {}
      const deltaType = String(delta.type || '')
      if (deltaType === 'citations_delta') {
        takeCitation(delta.citation)
        return { drop: true }
      }
      if (deltaType === 'text_delta' && textBlocks.has(index)) {
        textBlocks.set(index, textBlocks.get(index) + String(delta.text == null ? '' : delta.text))
      }
      return { drop: false }
    }
    if (type === 'content_block_stop') return { drop: dropped.has(Number(json.index)) }
    if (type === 'message_delta') {
      const delta = json.delta && typeof json.delta === 'object' ? json.delta : null
      const raw = delta && delta.stop_reason != null ? String(delta.stop_reason) : ''
      if (raw && !MESSAGES_STOP_REASONS.has(raw)) {
        /* 官方适配器的 stopReason() 对未知取值直接抛（malformed）；服务端工具轮次里
           `pause_turn` 这类 Anthropic 取值对上层等价于「本轮结束」，映射成 end_turn。
           这里**不发帧**：它不是一次服务端工具调用，发出去会凭空多一张空卡。 */
        delta.stop_reason = 'end_turn'
        return { drop: false, json }
      }
      return { drop: false }
    }
    return { drop: false }
  }

  /** 改写一个事件块（不含结尾空行）：返回要透传的文本（丢块 = 空串） */
  const rewrite = (block) => {
    if (!block) return block
    const lines = block.split(/\r?\n/)
    const dataIndexes = []
    const dataLines = []
    let eventName = ''
    lines.forEach((line, i) => {
      if (!line || line.startsWith(':')) return
      const colon = line.indexOf(':')
      const field = colon < 0 ? line : line.slice(0, colon)
      let value = colon < 0 ? '' : line.slice(colon + 1)
      if (value.startsWith(' ')) value = value.slice(1)
      if (field === 'event') eventName = value
      if (field === 'data') {
        dataIndexes.push(i)
        dataLines.push(value)
      }
    })
    if (!dataLines.length) return block
    const payload = dataLines.join('\n')
    if (!payload.trim() || payload === '[DONE]') return block
    let json
    try {
      json = JSON.parse(payload)
    } catch {
      /* 非 JSON（上游偶发的心跳 / 错误文本）原样透传，解析不了就不猜 */
      return block
    }
    if (json == null || typeof json !== 'object' || Array.isArray(json)) return block
    const verdict = handle(eventName, json)
    if (verdict.drop) return ''
    if (!verdict.json) return block
    const out = []
    let placed = false
    lines.forEach((line, i) => {
      if (dataIndexes.includes(i)) {
        if (!placed) {
          out.push('data: ' + JSON.stringify(verdict.json))
          placed = true
        }
        return
      }
      out.push(line)
    })
    return out.join('\n')
  }

  const take = (text, separator) => {
    const body = rewrite(text)
    return body ? body + separator : ''
  }

  return {
    push(chunk) {
      buffer += String(chunk == null ? '' : chunk)
      let out = ''
      for (;;) {
        const cut = findSseBoundary(buffer)
        if (!cut) break
        out += take(buffer.slice(0, cut.index), cut.separator)
        buffer = buffer.slice(cut.index + cut.separator.length)
      }
      return out
    },
    flush() {
      let out = ''
      if (buffer) {
        out = rewrite(buffer)
        buffer = ''
      }
      settle()
      return out
    },
    get extensions() {
      return extensions
    },
  }
}

/**
 * 包一层 fetch（Messages 面）：请求体注入服务端工具声明，响应 SSE 摘掉工具块、旁路成扩展块。
 *
 * 与 `wrapFetchWithServerTools` 同一份契约与失败面（不启用 / 非 SSE / 非 JSON 一律原样返回）。
 * 声明形状两边**完全相同**（同一 `tools` 数组里放 `{type,name}`），所以这里复用
 * `withServerTools()`；差别只在响应侧的改写器。
 *
 * @param {(input: any, init?: any) => Promise<Response>} fetchImpl
 * @param {{provider?: object|string|null, enabled?: boolean, webSearch?: boolean, readUrl?: boolean,
 *   onExtension?: (ext: object) => void}} [plan]
 * @returns {(input: any, init?: any) => Promise<Response>}
 */
export function wrapMessagesFetchWithServerTools(fetchImpl, plan = {}) {
  const base = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch
  const provider = plan.provider
  const options = {
    enabled: plan.enabled === true,
    webSearch: plan.webSearch,
    readUrl: plan.readUrl,
  }
  const active = options.enabled && isDeepSeekWebToolsProvider(provider)
  return async function deepseekMessagesWebToolsFetch(input, init) {
    if (!active) return base(input, init)
    const next = await withServerTools(input, init, provider, options)
    const response = await base(next.input, next.init)
    const type = String((response && response.headers && response.headers.get('content-type')) || '')
    if (!response || !response.body || !/text\/event-stream/i.test(type)) return response
    const rewriter = createMessagesSseRewriter({ onExtension: plan.onExtension })
    const decoder = new TextDecoder()
    const encoder = new TextEncoder()
    const body = response.body.pipeThrough(new TransformStream({
      transform(chunk, controller) {
        const text = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })
        const pass = rewriter.push(text)
        if (pass) controller.enqueue(encoder.encode(pass))
      },
      flush(controller) {
        const tail = rewriter.push(decoder.decode()) + rewriter.flush()
        if (tail) controller.enqueue(encoder.encode(tail))
      },
    }))
    const headers = new Headers(response.headers)
    headers.delete('content-length')
    headers.delete('content-encoding')
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    })
  }
}

