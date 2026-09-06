/* 历史思考原文回放裁剪（mtnode-reasoning-replay-trim · 跑在 dsh 运行时进程内）。

   为什么要裁：模型每产出一段思考，harness 就把它作为 `reasoning` 块存进那条
   assistant 消息的**耐久正文**里；随后每一步请求都把整段历史原样重发，适配器再把它
   写回协议字段（llm-deepseek 的 serializeAssistant → `reasoning_content`；pi-ai 的
   openai-completions convertMessages → `assistantMsg[thinkingSignature]`，实测签名
   即 `reasoning_content`）。于是「上一步在想什么」每一步都重付一遍 token：实测单个
   会话的思考文本最高 309KB，重思考的步每步白带 10–15K token，而这些原文对模型继续
   干活几乎没有增益（结论已在正文 / 工具结果里）。

   本插件在 `llm/stream` 瀑布上把**除最后一条 assistant 消息外**所有 assistant 消息里
   够长的 `reasoning` 块换成一枚极短的占位块：
   - 最后一条 assistant 不动：那一步的思考是「正在续写的上半句」，删了才是真掉能力
     （且思考模式下工具调用轮次要回传 reasoning_content，见 dsh-llm-deepseek README
     「推理回传规则」）。
   - **占位替换，绝不删块**：块数与块类型必须与 `source.replayState.blocks` 保持位置
     对齐（pi-ai 适配器 replayedAssistant 按 `blocks.length !== content.length` 判
     失配，整条消息降级为 foreignAssistant，连带丢 textSignature / thoughtSignature
     等保真元数据）。占位块同为 `type:'reasoning'`，对齐不破；同时保证工具调用轮次
     的 reasoning_content 字段仍然存在且非空（DeepSeek 思考模式对该字段有要求）。
   - 只改**这一次请求的对象副本**：会话日志（session.jsonl）、UI 回显、`deriveMessages`
     的耐久推导、回滚账本一概不碰 —— 裁的是发出去的请求，不是存下来的历史。

   注入点契约（详见 dsh/DESIGN.md「历史思考回放裁剪契约」）：cordis 的 waterfall 不做
   载荷替换 —— 同一个 args 数组被 spread 给链上每个监听器，而最内层的默认处理器
   `() => this.adapterStream(options, prepared)` 闭包捕获的是**原始 options**；loop 造的
   请求又是 deepFreeze 过的，改不动。所以想改请求只能「不叫 next()，自己带新对象重进
   一次 `ctx.llm.stream()`」，并用 WeakSet 认出自己重建的那次（第二遍必须直接 next()
   放行，否则无限递归）。重进的副本刻意不打 agent-loop 标记（那是进程内 WeakSet 按对象
   记的），于是 dsh-agent-loop 的「请求必须等于耐久推导」不变式把它当 hand-built 调用
   跳过 —— 该不变式仍会在**原始请求**上先跑一遍（它是 prepend = 最外层），耐久推导
   依旧被校验，我们只在它内侧改发出去的字节。

   降级保底：env `MTNODE_TRIM_REASONING` 缺席 / 为 0 / 值非法 = 本插件不注册任何监听器，
   行为与接入前一字不变；裁剪或重进过程中任何异常一律回落 `next()`（原始请求照发），
   绝不让一次模型调用因为「省 token 失败」而失败。本文件只 import node 内置（无 import）。 */

export const name = 'mtnode-reasoning-replay-trim'

export const inject = ['llm']

/** 开关 + 阈值的 env 名：值 = 生效的最小思考字数；1/on = 用默认阈值。 */
const ENV_KEY = 'MTNODE_TRIM_REASONING'
const DEFAULT_MIN_CHARS = 200
const ELIDED_MARK = '[earlier thinking elided]'
/** 所有被裁的块都指向同一枚冻结块：零分配，且占位文本对模型可读。 */
const ELIDED_BLOCK = Object.freeze({ type: 'reasoning', text: ELIDED_MARK })
/** 本插件重建出来的请求：再进瀑布时直接放行，防止递归。 */
const rebuilt = new WeakSet()
/** 诊断去重（按 sessionId 一条只报一次），有界以免长跑涨内存。 */
const announced = new Set()
const ANNOUNCE_CAP = 64

/** 解析开关：返回生效阈值（字符数），undefined = 整链 no-op。 */
function thresholdChars() {
  let raw
  try {
    raw = String(process.env[ENV_KEY] || '').trim().toLowerCase()
  } catch {
    return undefined
  }
  if (!raw) return undefined
  if (raw === '0' || raw === 'off' || raw === 'false' || raw === 'no') return undefined
  if (raw === '1' || raw === 'on' || raw === 'true' || raw === 'yes') return DEFAULT_MIN_CHARS
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1) return undefined
  return n
}

/** 该块是否够长到值得裁。 */
function elidable(block, minChars) {
  return (
    !!block &&
    block.type === 'reasoning' &&
    typeof block.text === 'string' &&
    block.text.length >= minChars
  )
}

/**
 * 裁一条**非末条** assistant 消息：够长的 reasoning 块换成占位块。
 * @returns 新的冻结消息副本，或 undefined（无可裁内容 → 原对象照用，保持引用相等）。
 */
function elideAssistant(message, minChars, stats) {
  if (!message || message.role !== 'assistant') return undefined
  const content = message.content
  if (!Array.isArray(content) || content.length === 0) return undefined
  let patched
  for (let i = 0; i < content.length; i++) {
    const block = content[i]
    if (!elidable(block, minChars)) continue
    if (!patched) patched = content.slice()
    patched[i] = ELIDED_BLOCK
    stats.turns += 1
    stats.chars += block.text.length
  }
  if (!patched) return undefined
  /* id / role / source（含 replayState）原样带走：只有正文块文本变短。 */
  return Object.freeze({ ...message, content: Object.freeze(patched) })
}

/**
 * 造一次裁剪后的请求副本。
 * @returns 新请求对象，或 undefined = 无可裁（调用方照走 next()）。
 */
function trimRequest(options, minChars, stats) {
  if (!options || typeof options !== 'object') return undefined
  const messages = options.messages
  if (!Array.isArray(messages) || messages.length < 2) return undefined
  /* 最后一条 assistant = 正在续写的那一步，原样保留。 */
  let lastAssistant = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m && m.role === 'assistant') {
      lastAssistant = i
      break
    }
  }
  if (lastAssistant <= 0) return undefined
  let patched
  for (let i = 0; i < lastAssistant; i++) {
    const elided = elideAssistant(messages[i], minChars, stats)
    if (!elided) continue
    if (!patched) patched = messages.slice()
    patched[i] = elided
  }
  if (!patched) return undefined
  /* 浅冻结：signal 仍是同一个活的 AbortSignal（冻结它会打断取消通道）。 */
  return Object.freeze({ ...options, messages: Object.freeze(patched) })
}

function announce(options, stats) {
  try {
    if (announced.size > ANNOUNCE_CAP) announced.clear()
    const key = options && options.sessionId ? String(options.sessionId) : '(no-session)'
    if (announced.has(key)) return
    announced.add(key)
    process.stderr.write(
      `[rr-trim] session=${key} turns=${stats.turns} elided=${stats.chars}chars\n`,
    )
  } catch {
    /* 诊断失败不影响请求 */
  }
}

export function apply(ctx) {
  const minChars = thresholdChars()
  if (minChars === undefined) return
  let llm
  try {
    llm = ctx && ctx.llm
  } catch {
    return
  }
  if (!llm || typeof llm.stream !== 'function') return
  /* 默认（非 prepend）注册 = 站到链内侧：先让 dsh-llm / agent-loop 的不变式与
     session-title、checkpoint-policy 这些外层监听器在**原始请求**上跑完，
     本插件才把改过的副本发下去。 */
  try {
    ctx.on('llm/stream', (options, next) => {
      if (rebuilt.has(options)) return next()
      const stats = { turns: 0, chars: 0 }
      let fresh
      try {
        fresh = trimRequest(options, minChars, stats)
      } catch {
        return next()
      }
      if (!fresh || stats.turns === 0) return next()
      try {
        rebuilt.add(fresh)
        const stream = llm.stream(fresh)
        if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') return next()
        announce(options, stats)
        return stream
      } catch {
        return next()
      }
    })
  } catch {
    /* 注册失败 = 整链 no-op，其余行为一字不变 */
  }
}
