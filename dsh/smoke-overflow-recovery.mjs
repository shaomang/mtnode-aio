/* 上下文溢出自动恢复（mtnode-overflow-recovery）的契约冒烟 —— 纯假对象，秒级。
 * ============================================================================
 * 为什么要有它：插件跑在 dsh 运行时进程里，它的 stderr 被 @deepseek-ai/dsh-sdk-client 收进
 * stderrTail（只用于进程死亡诊断），网关进程内拿不到 —— 所以「它到底判了什么」只能在这里
 * 用假 ctx / 假 compression 引擎把真模块跑一遍来钉（插件自己零 import，可直接 import）。
 *
 * 钉住的是「让本次会话继续」那条链的每一道闸：
 *   [1] 报文里的两种容量拒收措辞都认（含用户报的那条原文）
 *   [2] CONTEXT_WINDOW_EXCEEDED 直接放行 —— 那是 compaction-basic 的活，绝不重复压
 *   [3] 命中 + 压缩落地（replaceGeneration 增长）→ 回 {kind:'retry'}（原 step 重发）
 *   [4] 压缩没落地（代次不变）→ 放行，保留原始错误（压了没落地还重发只会在同一堵墙上再撞）
 *   [5] 压缩抛错但代次已增长 → 仍然 retry（复刻 compaction-basic 的判据）
 *   [6] 配额耗尽（默认 1 次）→ 放行
 *   [7] 无关 400（不是容量拒收）→ 放行
 *   [8] env MTNODE_OVERFLOW_RECOVERY=0/off/非法 → 一个监听器都不注册（行为与接入前一字不变）
 *   [9] assistant 消息产出后配额清零（会话恢复正常就把额度还回去）
 * 用法：node dsh/smoke-overflow-recovery.mjs
 */
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const PLUGIN = path.join(import.meta.dirname, 'gateway', 'plugins', 'overflow-recovery-plugin.mjs')
const mod = await import(pathToFileURL(PLUGIN).href)

let failed = 0
const ok = (cond, name) => {
  if (!cond) failed++
  console.log(`  ${cond ? '✓' : '✗'} ${name}`)
}

const RAW_400 =
  'user input too long, 34238 tokens exceeds max 32768 tokens ' +
  '(request id: 166e0829-8a51-4995-bfcc-aa6d33a5b9f2)'
const RAW_TIGHT = 'Input token exceed the limit (request id: abc-123)'

/** 假上下文：收集监听器；compaction 服务按需给出。 */
function fakeCtx(opts = {}) {
  const handlers = Object.create(null)
  const calls = []
  const ctx = {
    on(name, fn) {
      calls.push(name)
      ;(handlers[name] || (handlers[name] = [])).push(fn)
    },
    get(name) {
      return name === 'compaction' ? opts.engine : undefined
    },
    __handlers: handlers,
    __calls: calls,
  }
  return ctx
}

/** 假 agent：只有插件真正读的那两样 —— session.surface（含 replaceGeneration）与身份。 */
function fakeAgent(generation = 1) {
  let gen = generation
  const surface = {
    nodes: [{ seq: 0 }, { seq: 1 }],
    get replaceGeneration() {
      return gen
    },
    __bump() {
      gen += 1
    },
  }
  return { session: { surface } }
}

/** 假压缩引擎：记录调用，按 want 决定是否让 surface 代次增长。 */
function fakeEngine(agent, behavior = 'landed') {
  const calls = []
  return {
    calls,
    async compactIfNeeded(a, trigger, signal) {
      calls.push({ agent: a, trigger, signal })
      if (behavior === 'landed') a.session.surface.__bump()
      if (behavior === 'throw-landed') {
        a.session.surface.__bump()
        throw new Error('summarization failed')
      }
      if (behavior === 'throw') throw new Error('summarization failed')
      return null
    },
  }
}

const nextSentinel = { kind: 'next' }
const next = () => nextSentinel

/** 驱动一次 request-error 瀑布：与 cordis 同口径 —— 监听器收 (payload, next)。 */
async function fire(ctx, payload) {
  const list = ctx.__handlers['agent/request-error'] || []
  if (!list.length) return { kind: 'no-listener' }
  return list[0](payload, next)
}

const setEnv = (v) => {
  if (v === undefined) delete process.env.MTNODE_OVERFLOW_RECOVERY
  else process.env.MTNODE_OVERFLOW_RECOVERY = v
}

console.log('overflow-recovery 契约冒烟（假 ctx / 假引擎，真插件模块）\n')

/* ── [1] 两种措辞都认 + [3] 落地则 retry ─────────────────────────────────── */
{
  setEnv('1')
  for (const [label, msg] of [
    ['用户报的原文', RAW_400],
    ['DeepSeek 紧凑措辞', RAW_TIGHT],
  ]) {
    const agent = fakeAgent()
    const engine = fakeEngine(agent, 'landed')
    const ctx = fakeCtx({ engine })
    mod.apply(ctx)
    const r = await fire(ctx, { agent, failure: { message: msg, code: 'INVALID_REQUEST' }, provider: 'deepseek-official' })
    ok(r && r.kind === 'retry', `[1] ${label} → 回 {kind:'retry'}`)
    ok(engine.calls.length === 1 && engine.calls[0].trigger === 'context-overflow', `[3] ${label} → 用 context-overflow 触发压缩（截断 + 摘要）`)
  }
}

/* ── [2] dsh 认得的溢出不重复压 ─────────────────────────────────────────── */
{
  setEnv('1')
  const agent = fakeAgent()
  const engine = fakeEngine(agent, 'landed')
  const ctx = fakeCtx({ engine })
  mod.apply(ctx)
  const r = await fire(ctx, {
    agent,
    failure: { message: RAW_400, code: 'CONTEXT_WINDOW_EXCEEDED' },
    provider: 'deepseek-official',
  })
  ok(r === nextSentinel, '[2] CONTEXT_WINDOW_EXCEEDED → 直接放行（交给 compaction-basic）')
  ok(engine.calls.length === 0, '[2] 且一次压缩都没调（不重复压）')
}

/* ── [4] 压了没落地 → 放行并保留原错 ─────────────────────────────────────── */
{
  setEnv('1')
  const agent = fakeAgent()
  const engine = fakeEngine(agent, 'none')
  const ctx = fakeCtx({ engine })
  mod.apply(ctx)
  const r = await fire(ctx, { agent, failure: { message: RAW_400, code: 'INVALID_REQUEST' }, provider: 'x' })
  ok(engine.calls.length === 1, '[4] 确实尝试过压缩')
  ok(r === nextSentinel, '[4] 代次没增长 → 放行（错误原样交回，不重发）')
}

/* ── [5] 压缩抛错但代次已增长 → 仍 retry ────────────────────────────────── */
{
  setEnv('1')
  const agent = fakeAgent()
  const engine = fakeEngine(agent, 'throw-landed')
  const ctx = fakeCtx({ engine })
  mod.apply(ctx)
  const r = await fire(ctx, { agent, failure: { message: RAW_400, code: 'INVALID_REQUEST' }, provider: 'x' })
  ok(r && r.kind === 'retry', '[5] 摘要抛错但 surface 已替换 → 照样 retry（复刻 compaction-basic 判据）')
}

/* ── [6] 配额：默认 1 次，用完放行 ──────────────────────────────────────── */
{
  setEnv('1')
  const agent = fakeAgent()
  const engine = fakeEngine(agent, 'landed')
  const ctx = fakeCtx({ engine })
  mod.apply(ctx)
  const r1 = await fire(ctx, { agent, failure: { message: RAW_400, code: 'INVALID_REQUEST' }, provider: 'x' })
  const r2 = await fire(ctx, { agent, failure: { message: RAW_400, code: 'INVALID_REQUEST' }, provider: 'x' })
  ok(r1 && r1.kind === 'retry', '[6] 第一次撞墙 → 恢复')
  ok(r2 === nextSentinel, '[6] 第二次撞墙 → 放行（配额默认 1）')
  ok(engine.calls.length === 1, '[6] 只压了一次')
}

/* ── [9] 产出 assistant 消息后配额清零 ─────────────────────────────────── */
{
  setEnv('1')
  const agent = fakeAgent()
  const engine = fakeEngine(agent, 'landed')
  const ctx = fakeCtx({ engine })
  mod.apply(ctx)
  await fire(ctx, { agent, failure: { message: RAW_400, code: 'INVALID_REQUEST' }, provider: 'x' })
  /* 会话恢复正常：session/event 里来一条 assistant/message → 配额还回去 */
  for (const fn of ctx.__handlers['session/event'] || []) fn(agent.session, { type: 'assistant/message' })
  const r = await fire(ctx, { agent, failure: { message: RAW_400, code: 'INVALID_REQUEST' }, provider: 'x' })
  ok(r && r.kind === 'retry', '[9] 会话产出正文后配额清零 → 下次撞墙仍能救一次')
}

/* ── [7] 无关 400 不受影响 ─────────────────────────────────────────────── */
{
  setEnv('1')
  const agent = fakeAgent()
  const engine = fakeEngine(agent, 'landed')
  const ctx = fakeCtx({ engine })
  mod.apply(ctx)
  for (const msg of [
    '400: {"message":"Invalid API key","type":"invalid_request_error"}',
    'context length exceeded, model deepseek-v9',
    'user input too long',
  ]) {
    const r = await fire(ctx, { agent, failure: { message: msg, code: 'INVALID_REQUEST' }, provider: 'x' })
    ok(r === nextSentinel, `[7] 非容量拒收放行：${msg.slice(0, 46)}`)
  }
  ok(engine.calls.length === 0, '[7] 一次压缩都没调')
}

/* ── [8] env 闸：关掉就一个监听器都不注册 ───────────────────────────────── */
{
  for (const v of ['0', 'off', 'no', 'false', 'abc', undefined]) {
    const ctx = fakeCtx({ engine: fakeEngine(fakeAgent(), 'landed') })
    setEnv(v)
    mod.apply(ctx)
    ok(ctx.__calls.length === 0, `[8] env=${v === undefined ? '(缺席)' : v} → 不注册任何监听器`)
  }
  const ctx2 = fakeCtx({ engine: fakeEngine(fakeAgent(), 'landed') })
  setEnv('2')
  mod.apply(ctx2)
  ok((ctx2.__calls || []).length === 3, '[8] env=2 → 注册 3 个监听器（request-error + idle + session/event）')
  setEnv(undefined)
}

/* ── [10] 压缩引擎缺席（压缩行被卸载）→ 放行，不抛 ───────────────────────── */
{
  setEnv('1')
  const agent = fakeAgent()
  const ctx = fakeCtx({ engine: undefined })
  mod.apply(ctx)
  const r = await fire(ctx, { agent, failure: { message: RAW_400, code: 'INVALID_REQUEST' }, provider: 'x' })
  ok(r === nextSentinel, '[10] 取不到 compaction 引擎 → 放行（绝不因恢复失败改变原始错误）')
}

console.log(`\n${failed === 0 ? '全部通过' : failed + ' 条未通过'}`)
process.exit(failed === 0 ? 0 : 1)
