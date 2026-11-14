/* 会话附件（PDF / Word / 文本 / 表格）：把「这一轮用户带了哪些文件」从宿主一路送到
   服务商请求体里 —— 标记的**唯一真源**在这里（网关写、运行时读，两侧 import 同一份）。

   **口径（2026-11-14 修正）**：照 DeepSeek 文档的「文件输入」走 —— 上传 Files API 拿
   file_id，正文里写标记，运行时还原成服务商原生附件部分。附件**只在创建它的那条通道上
   有效**：上传走中转、对话走官方（或反过来）时，file_id 在对面查不到，标记必须丢掉并
   改成本机路径，否则模型会「以为有文件、实际什么都没有」（见 attachPromptSuffix 的三档）。

   标记通道的历史理由：
   · env（像 MTNODE_WEB_TOOLS 那样）是**运行期开关**，写进去就等于改 runtime key ——
     每一轮带不带附件都会冷起一次运行时；附件是每轮数据，不该有这个代价。
   · 内容块（`{type:'file', attachment:{…}}`）是 dsh 自己的附件语义，它最后被投影成
     「一段文本 + 一个只读绝对路径」交给模型（dsh-llm 的 projectFilesToText），
     PDF / docx 这类二进制文件模型用读文件工具读不出来 —— 只有上传到服务商 Files API、
     把 `file_id` 放进请求，服务端才会真的把文档解析成正文。

   所以通道 = **用户消息里的一个标记**：网关按本轮的 `params.files` 往消息正文末尾追加
   一行标记，运行时在 fetch 层（web-tools-plugin.mjs 同一处补丁）把标记还原成服务商原生
   的附件部分，并把标记文本从正文里摘掉：

     · OpenAI 兼容面（中转 / 自建卡）：`{"type":"file","file_id":"…"}`（实测 200）
     · Messages 面（官方 deepseek-official）：`{"type":"document","source":{"type":"file","file_id":"…"}}`
       —— 需要 `anthropic-beta: files-api-2025-04-14`，缺了回 400（实测）

   标记随消息走的好处：历史消息里那份标记在**后续轮次**照样能还原，追问不用重传文件；
   代价是文件正文每一步都会被服务端解析一次（与「把文档贴进上下文」同一个量级）。

   「优先用上传件、不本地解析」（用户口径 2026-11-15）：附件上传成功时，模型手里已经有
   服务端解析出的正文，不该再调本地 PDF 解析（mtnode_tool_pdf_markdown / pdf:parse）把同一份
   文件读一遍 —— 白花一轮，且本地文本层与服务端版面解析对不上时会拿本地那份去否认附件。
   这句话写进 attachPromptSuffix 的标记支；没拿到 file_id 的那一支仍按本机路径交给模型，
   允许本地工具兜底（上传失败不等于禁止本地读）。

   两条自我保护（标记里带 h / x 两个字段）：
   · `h` = 上传时那家服务商的主机名。换了服务商（官方 ↔ 中转）就别再塞旧 file_id，
     否则整轮 400；对不上就**静默丢弃这个附件**（正文照发）。
   · `x` = 过期时刻（上传时间 + 6 天，Files API 实测 7 天过期）。过期的标记同样丢弃。
   两条都只影响附件，绝不让整轮请求失败。 */

/** 标记前缀 / 形状：`[[mtnode-attach:<base64url(JSON)>]]`（base64 保证正文里不会出现 `]]`） */
export const ATTACH_MARKER_PREFIX = '[[mtnode-attach:'
const MARKER_RE = /\[\[mtnode-attach:([A-Za-z0-9_\-+/=]+)\]\]/g
/** 附件标记的有效期（Days）。Files API 实测 7 天过期，留一天余量。 */
const MARKER_TTL_DAYS = 6
/** 标记被摘掉、正文正好空了时的占位（两面协议都要求 content 里至少留着一段文本） */
const STALE_PLACEHOLDER = '（本轮附件已失效，未随这条消息提供）'

/** 一条附件 → 标记里的载荷（字段名压到 1 个字母：它们会随消息进模型上下文之外的原始文本） */
function payloadOf(file) {
  const f = file && typeof file === 'object' ? file : {}
  const id = String(f.fileId || '').trim()
  if (!id) return null
  const at = Number(f.at) || Date.now()
  return {
    id,
    n: String(f.name || ''),
    k: String(f.kind || ''),
    /* files-upload.js 记的是 URL 的 host（可能带端口），这里统一剥掉端口 —— 运行时
       比对用的是 hostname（见 hostOfUrl），两边必须同一口径 */
    h: String(f.host || '').toLowerCase().replace(/:\d+$/, ''),
    x: at + MARKER_TTL_DAYS * 24 * 3600 * 1000,
  }
}

/** 一条附件的标记文本（网关用） */
export function attachMarkerOf(file) {
  const payload = payloadOf(file)
  if (!payload) return ''
  return ATTACH_MARKER_PREFIX + Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url') + ']]'
}

/** 标记里那份载荷（运行时用；坏标记一律 null，绝不抛） */
export function attachPayloadOf(token) {
  try {
    const doc = JSON.parse(Buffer.from(String(token || ''), 'base64url').toString('utf8'))
    if (!doc || typeof doc !== 'object') return null
    const id = String(doc.id || '').trim()
    if (!id) return null
    return {
      fileId: id,
      name: String(doc.n || ''),
      kind: String(doc.k || ''),
      host: String(doc.h || '').toLowerCase(),
      expiresAt: Number(doc.x) || 0,
    }
  } catch {
    return null
  }
}

/**
 * 网关侧：本轮附件在用户消息末尾该追加的那一段文本（没有附件 → 空串）。
 *
 * 三档，判据只有一条 —— **这份 file_id 是不是在当前这条请求的通道上创建的**：
 *  ① `fileId` 且 host 与本轮通道一致 → 写标记（运行时还原成服务商原生附件部分，实测可用），
 *     并明说「直接读正文、不要再用本地 PDF 解析通道解析同一份文件」（见 markers 那一段）；
 *  ② `fileId` 但 host 对不上（用户传完文件又换了服务商 / 老会话换了通道）→ **不写标记**，
 *     因为那个 id 只在原通道上有效，写进去等于告诉模型「有文件」而它手里什么都没有
 *     （2026-11-14 实测：test.pdf 传到中转、对话走官方，模型拿到的正文里只剩一句
 *     「内容已由服务商解析」，于是它反复找文件、那一轮 56 秒无输出）→ 改成本机路径 +
 *     一句实话，模型自己读得出来；
 *  ③ 没有 `fileId`（上传失败 / 该家不支持 Files API）→ 本机路径，允许本地工具读。
 *
 * @param {Array<{fileId?: string, name?: string, kind?: string, size?: number, host?: string,
 *   at?: number, path?: string}>} files
 * @param {{host?: string}} [opts] host = 本轮真正要发请求的那条通道（hostname）
 * @returns {string}
 */
export function attachPromptSuffix(files, opts = {}) {
  const list = Array.isArray(files) ? files.filter((f) => f && typeof f === 'object') : []
  if (!list.length) return ''
  const hostNow = String((opts && opts.host) || '')
    .trim()
    .toLowerCase()
    .replace(/:\d+$/, '')
  const lines = []
  const names = []
  const markers = []
  for (const f of list) {
    const name = String(f.name || f.path || '').trim()
    const local = String(f.path || '').trim()
    const id = String(f.fileId || '').trim()
    const hostAt = String(f.host || '')
      .trim()
      .toLowerCase()
      .replace(/:\d+$/, '')
    /* 通道未知（老调用方 / 拿不到 baseUrl）时按老口径发标记，绝不因为少一个参数就丢附件 */
    const sameChannel = !hostNow || !hostAt || hostAt === hostNow
    if (id && sameChannel) {
      const marker = attachMarkerOf(f)
      if (marker) {
        markers.push(marker)
        names.push(name || id)
        continue
      }
    }
    if (local) {
      lines.push(
        id
          ? `· ${name || local}（本机路径：${local}；这份文件当初传到了另一条服务商通道，当前通道取不到它的内容，请直接按本机路径读取）`
          : `· ${name || local}（本机路径：${local}）`,
      )
    }
  }
  if (!names.length && !lines.length) return ''
  const bits = []
  if (markers.length) {
    /* 正文尾巴里必须写死这条规矩（用户口径 2026-11-15）：附件已经走 Files API 上传、
       服务端把文档解析成了正文随消息下发，模型手上就有全文 —— 它若顺手再调本地 PDF
       解析（mtnode_tool_pdf_markdown / pdf:parse）把同一份文件读一遍，等于白花一轮时间，
       而且两份正文（本地文本层 vs 服务端版面解析）对不上时它还会拿本地那份去否认附件。
       工具本身不摘（上传失败 / 本机路径那条支路仍要用），只约束「已经上传成功」这一支。 */
    bits.push(
      `已上传并由服务商解析、随这条消息提供的 ${markers.length} 个：${names.join('、')}。` +
        '这些文件的正文已经由服务商解析并随消息下发，直接读正文回答即可；' +
        '**不要**再用本地 PDF 解析通道（mtnode_tool_pdf_markdown / pdf:parse）把同一份文件解析一遍。',
    )
  }
  if (lines.length) {
    bits.push(
      `另外 ${lines.length} 个文件只在用户本机（下面给绝对路径，可能在工作区之外）：` +
        '请用本地读文件工具按路径把内容读出来再回答，不要凭文件名猜内容，也不要声称看不到文件。',
    )
  }
  return '\n\n【本轮附件】' + bits.join('') + (lines.length ? '\n' + lines.join('\n') : '') +
    (markers.length ? '\n' + markers.join('\n') : '')
}

/** 一个请求体里有没有附件标记（插件用它做便宜的前置判断） */
export function hasAttachMarker(text) {
  return typeof text === 'string' && text.indexOf(ATTACH_MARKER_PREFIX) >= 0
}

/** 当前请求打到的主机名（对不上标记里的 h 就丢弃，避免跨服务商复用旧 file_id） */
function hostOfUrl(url) {
  try {
    return new URL(String(url || '')).hostname.toLowerCase()
  } catch {
    return ''
  }
}

/** 标记该不该在这一条请求上还原 */
function markerUsable(payload, hostNow) {
  if (!payload) return false
  if (payload.expiresAt && Date.now() > payload.expiresAt) return false
  const want = String(payload.host || '').replace(/:\d+$/, '')
  if (want && hostNow && want !== hostNow) return false
  return true
}

/** 把一段正文里的标记摘出来：返回去掉标记的文本 + 可用的附件载荷 */
function splitMarkers(text, hostNow) {
  const found = []
  const cleaned = String(text || '').replace(MARKER_RE, (all, token) => {
    const payload = attachPayloadOf(token)
    if (markerUsable(payload, hostNow)) found.push(payload)
    return ''
  })
  return { text: cleaned, found }
}

/** 服务商原生的附件部分（两面写法不同，都实测过） */
function filePartOf(face, payload) {
  if (face === 'messages') {
    return { type: 'document', source: { type: 'file', file_id: payload.fileId } }
  }
  return { type: 'file', file_id: payload.fileId }
}

/**
 * 运行时侧：把请求体里的附件标记还原成服务商原生的附件部分。
 *
 * 只认两种 content 形状：`string`（纯文本消息）与 `[{type:'text', text}]`（分段消息）。
 * 其余消息（assistant 的工具调用、tool 结果）原样不动 —— 标记只会出现在用户消息里。
 * 任何异常都返回 `changed:false`（插件据此原样放行），绝不因为附件把会话跑挂。
 *
 * 标记被摘掉之后一定还留一个 text 部分：正文正好只剩标记时用一句实话占位
 * （两面协议里「content 只有一个附件块」都是没验过的形状，不赌）。
 *
 * @param {string} bodyText 请求体原文（JSON 字符串）
 * @param {{face?: 'openai'|'messages', url?: string}} [opts]
 * @returns {{changed: boolean, body: string, beta: string, injected: number}}
 */
export function rewriteAttachMarkers(bodyText, opts = {}) {
  const out = { changed: false, body: bodyText, beta: '', injected: 0 }
  if (!hasAttachMarker(bodyText)) return out
  const face = opts.face === 'messages' ? 'messages' : 'openai'
  const hostNow = hostOfUrl(opts.url)
  let doc = null
  try {
    doc = JSON.parse(bodyText)
  } catch {
    return out
  }
  const messages = doc && Array.isArray(doc.messages) ? doc.messages : null
  if (!messages) return out
  let injected = 0
  let stripped = 0
  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue
    if (msg.role !== 'user') continue
    if (typeof msg.content === 'string') {
      const { text, found } = splitMarkers(msg.content, hostNow)
      if (text === msg.content) continue
      stripped++
      msg.content = [
        { type: 'text', text: text.trim() ? text : STALE_PLACEHOLDER },
        ...found.map((p) => filePartOf(face, p)),
      ]
      injected += found.length
      continue
    }
    if (!Array.isArray(msg.content)) continue
    const next = []
    for (const part of msg.content) {
      if (!part || part.type !== 'text' || typeof part.text !== 'string' || !hasAttachMarker(part.text)) {
        next.push(part)
        continue
      }
      const { text, found } = splitMarkers(part.text, hostNow)
      if (text === part.text) {
        next.push(part)
        continue
      }
      stripped++
      next.push({ type: 'text', text: text.trim() ? text : STALE_PLACEHOLDER })
      for (const p of found) next.push(filePartOf(face, p))
      injected += found.length
    }
    msg.content = next
  }
  if (!stripped) return out
  return {
    changed: true,
    body: JSON.stringify(doc),
    /* Messages 面的 document 块必须带这枚 beta 头，缺了回 400「Missing or invalid anthropic-beta header」 */
    beta: injected && face === 'messages' ? 'files-api-2025-04-14' : '',
    injected,
  }
}
