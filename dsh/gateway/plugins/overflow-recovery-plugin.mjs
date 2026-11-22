/* 上下文溢出自动恢复（mtnode-overflow-recovery · 跑在 dsh 运行时进程内）。

   为什么要它：dsh 自带的「溢出 → 压缩 → 同轮重发」恢复到 0.2 仍然是好的，
   实现在 @deepseek-ai/dsh-compaction-basic 的 `agent/request-error` 监听里 ——
   命中 `failure.code === 'CONTEXT_WINDOW_EXCEEDED'` 就 `compactIfNeeded(agent,
   'context-overflow')`（先工具结果截断、再把较早区间摘要成一条 checkpoint，
   保留系统提示 + 最近尾部），`session.surface.replaceGeneration` 有增长才
   `return {kind:'retry'}` 在**原 step** 重发。

   它没跑的唯一原因是**分类器按 code 判定**：DeepSeek 官方的输入容量拒收是
       user input too long, 34238 tokens exceeds max 32768 tokens
       Input token exceed the limit
   两种措辞都不在 @deepseek-ai/dsh-llm 的 isContextWindowExceededError 五个正则里，
   裸 400 因此被归一成 INVALID_REQUEST，compaction-basic 的溢出分支直接 next()。
   本插件就是把这两种措辞**翻译成 dsh 认得的溢出语义**，复用引擎现成的
   截断 / 摘要 / 重试，不 patch 任何 @deepseek-ai 包（重装即丢）。

   注入点契约（`agent/request-error` 是 waterfall，监听器签名 = (payload, next)）：
   - payload = { agent, turn, step, provider, failure, retryPolicy, signal }，
     `agent` 由 dsh-agent 的 agentEvents 注入（fused(payload)），不需要 inject；
   - failure 是 LlmFailure = { message, code, status?, providerRetryAfterMs?,
     requestId?, offloadImages? }，本插件只读 message / code。
   判定顺序（缺一步都可能压错或压了不落地）：
     ① `failure.code === 'CONTEXT_WINDOW_EXCEEDED'` → 直接 next()。那是 dsh 自己
        认得的溢出，compaction-basic 已经在处理（它的监听先注册、站在本插件外侧），
        再压一次就是重复压缩；
     ② 用容量拒收正则认「服务端按输入容量拒收」；不命中 → next()；
     ③ 取压缩引擎 `ctx.get('compaction')`（**不** inject: ['compaction']：压缩行被
        卸载时 inject 会让本插件永久等待、连无关请求都卡住）；
     ④ 压缩 + 落地判据复刻 compaction-basic 的 overflow 分支：`compactIfNeeded`
        返回后若 signal 已取消、或 replaceGeneration 没增长 → next() 保留原始错误
        （压了没落地还重发，只会在同一堵墙上再撞一次）。
   配额：自持 WeakMap 按 agent 计数，默认 1 次（对齐 compaction-basic 的默认
   maxOverflowRetries）；`agent/status` idle 与 `session/event` 的
   assistant/message 时清零（同一会话继续产出正文 = 恢复正常，配额还回去）。
   耗尽后 next()，把错误原样交回 dsh 的分类器。

   降级保底：env `MTNODE_OVERFLOW_RECOVERY` 缺席 / 0 / off / 非法 = 本插件不注册
   任何监听器，行为与接入前一字不变；恢复过程中任何异常（含取引擎、读代次、
   压缩本身）一律 next()，绝不因「恢复失败」改变原始错误的分类与文案。
   本文件只 import node 内置（无 import）。 */

export const name = 'mtnode-overflow-recovery'

/** 不注入任何服务：压缩引擎经 ctx.get 动态取（见文件头 ③）。 */
export const inject = []

/** 开关 + 配额：值 = 允许的自动恢复次数（1/on/true = 用默认配额）。 */
const ENV_KEY = 'MTNODE_OVERFLOW_RECOVERY'
const DEFAULT_MAX_RETRIES = 1
/** 配额硬上限：env 写大了也不许多压，压缩要花一次摘要模型的钱。 */
const MAX_RETRIES_CAP = 5

/** dsh 自己的溢出码：这条由 compaction-basic 处理，本插件不碰。 */
const CONTEXT_WINDOW_EXCEEDED = 'CONTEXT_WINDOW_EXCEEDED'

/* 「本次输入 N tokens / 服务端上限 M tokens」——与 gateway.mjs 的 CAPACITY_REJECT_RE
   词表保持一致，但独立实现（插件不 import 网关文件：网关是父进程，这里不同进程）。
   改词表要两边一起改，否则「网关认得出、运行时恢复不了」或反之。 */
const CAPACITY_REJECT_RE =
  /(?:user\s+input|input\s+tokens?|prompt\s+tokens?)[^,]{0,32}?too\s+(?:long|large)\s*,?\s*([\d,]+)\s*tokens?\s+(?:exceeds?|is\s+larger\s+than)\s+(?:the\s+)?(?:max|maximum)\s*([\d,]+)\s*tokens?/i
/* DeepSeek 线上另一种同义措辞（不带数字，只能判定「是容量拒收」）：
   {"message":"Input token exceed the limit (request id: …)","type":"api_error"} */
const CAPACITY_REJECT_TIGHT_RE = /input\s+tokens?\s+exceed\s+the\s+limit/i

/**
 * 解析开关：返回生效的自动恢复次数，undefined = 整链 no-op。
 * @returns 允许的重试次数，或 undefined（禁用）。
 */
function retryBudget() {
  let raw
  try {
    raw = String(process.env[ENV_KEY] ?? '').trim().toLowerCase()
  } catch {
    return undefined
  }
  if (!raw) return undefined
  if (raw === '0' || raw === 'off' || raw === 'false' || raw === 'no') return undefined
  if (raw === '1' || raw === 'on' || raw === 'true' || raw === 'yes') return DEFAULT_MAX_RETRIES
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1) return undefined
  return Math.min(n, MAX_RETRIES_CAP)
}

/**
 * 从 provider 报文里取出「本次输入 / 服务端上限」两个数。
 * @param message - failure.message。
 * @returns { used, max }（取不到数字时为 0），或 undefined = 不是容量拒收。
 */
function capacityRejectOf(message) {
  let text
  try {
    text = String(message ?? '')
  } catch {
    return undefined
  }
  if (!text) return undefined
  const matched = text.match(CAPACITY_REJECT_RE)
  if (matched) {
    return {
      used: Number(String(matched[1]).replace(/,/g, '')) || 0,
      max: Number(String(matched[2]).replace(/,/g, '')) || 0,
    }
  }
  return CAPACITY_REJECT_TIGHT_RE.test(text) ? { used: 0, max: 0 } : undefined
}

/**
 * 取压缩引擎（`ctx.compaction`）。动态取而不是 inject：压缩行被卸载时，
 * inject 会让本插件永远停在等待状态，连无关的请求错误都过不去。
 * @param ctx - 插件上下文。
 * @returns 具备 compactIfNeeded 的引擎，或 undefined（未装 / 未激活）。
 */
function compactionEngineOf(ctx) {
  try {
    if (!ctx || typeof ctx.get !== 'function') return undefined
    const engine = ctx.get('compaction')
    return engine && typeof engine.compactIfNeeded === 'function' ? engine : undefined
  } catch {
    return undefined
  }
}

/** 留痕：一行说明这次容量拒收要不要恢复、为什么。诊断写 stderr（stdout 留给 JSON-RPC 帧）。 */
function announce(provider, hit, retries, recovered) {
  try {
    const route = provider ? String(provider) : '(未知)'
    process.stderr.write(
      `[overflow-recovery] route=${route} used=${hit.used} max=${hit.max} ` +
        `recovered=${recovered ? 'true' : 'false'} retries=${retries}\n`,
    )
  } catch {
    /* 诊断失败不影响恢复判定 */
  }
}

/**
 * 判定是否该走自动恢复。抛错一律由调用方当作「不恢复」。
 * @param ctx - 插件上下文。
 * @param payload - `agent/request-error` 的 waterfall 载荷。
 * @param book - { max, retries, agentsBySession } 自持账本。
 * @returns true = 已在原 step 落地压缩、调用方应回 {kind:'retry'}。
 */
async function shouldRecover(ctx, payload, book) {
  const { agent, failure, signal, provider } = payload || {}
  if (!agent || !failure || typeof failure !== 'object') return false
  /* ① dsh 认得的溢出交给 compaction-basic，绝不重复压。 */
  if (failure.code === CONTEXT_WINDOW_EXCEEDED) return false
  if (signal && signal.aborted) return false
  /* ② 容量拒收识别。 */
  const hit = capacityRejectOf(failure.message)
  if (hit === undefined) return false
  /* ③ 引擎与用量面。 */
  const session = agent.session
  const surface = session ? session.surface : undefined
  if (!surface) return false
  const engine = compactionEngineOf(ctx)
  if (!engine) return false
  const used = book.retries.get(agent) ?? 0
  if (used >= book.max) {
    announce(provider, hit, used, false)
    return false
  }
  /* session/event 里拿不到 agent，靠这张表从 session 找回它来清零配额。 */
  book.agentsBySession.set(session, agent)
  const generation = surface.replaceGeneration
  try {
    await engine.compactIfNeeded(agent, 'context-overflow', signal)
  } catch {
    /* 压缩本身失败不立刻放弃：复刻 compaction-basic 的判据，落地过就照样重发。 */
  }
  /* ④ 落地判据：没取消、且 surface 代次确实增长。 */
  const aborted = !!(signal && signal.aborted)
  const landed = !aborted && surface.replaceGeneration > generation
  if (!landed) {
    announce(provider, hit, used, false)
    return false
  }
  book.retries.set(agent, used + 1)
  announce(provider, hit, used + 1, true)
  return true
}

export function apply(ctx) {
  const max = retryBudget()
  if (max === undefined) return
  const book = {
    max,
    retries: new WeakMap(),
    agentsBySession: new WeakMap(),
  }
  const reset = (agent) => {
    try {
      if (agent !== undefined) book.retries.delete(agent)
    } catch {
      /* 清零失败最坏是多留一次配额，不影响正确性 */
    }
  }
  try {
    /* 会话回到 idle / 又产出了一条 assistant 消息 = 恢复正常，配额还回去。 */
    ctx.on('agent/status', (payload) => {
      const { agent, status } = payload || {}
      if (status === 'idle') reset(agent)
    })
    ctx.on('session/event', (session, event) => {
      try {
        if (!event || event.type !== 'assistant/message') return
        reset(book.agentsBySession.get(session))
      } catch {
        /* 观察类监听：任何异常都不许冒到会话提交路径上 */
      }
    })
    /* 默认（非 prepend）注册 = 站在 compaction-basic 内侧：它认得的溢出它先处理，
       它 next() 放行的（含 INVALID_REQUEST 化的容量拒收）才轮到本插件。 */
    ctx.on('agent/request-error', async (payload, next) => {
      let recover = false
      try {
        recover = await shouldRecover(ctx, payload, book)
      } catch {
        recover = false
      }
      /* next() 只调用一次，且永远在 try 之外：恢复失败必须原样交回下游分类。 */
      return recover ? { kind: 'retry' } : next()
    })
  } catch {
    /* 注册失败 = 整链 no-op，行为与接入前一字不变 */
  }
}
