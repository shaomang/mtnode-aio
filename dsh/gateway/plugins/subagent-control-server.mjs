/* 单只子代理中断桥 · session/interrupt-subagent（mtnode-subagent-control · 跑在 dsh 运行时进程内）。

   背景（本次需求）：引擎的 `subagent` 工具天生异步 —— 调用立刻回 `started subagent <id>`，
   子任务在后台跑完再发结算通知。用户在看板上看到「子代理运行中」之后想停掉它，
   而 SDK 自带的四枚 JSON-RPC 方法（prompt / resume / wait / working-directory）里
   **没有**任何中断子代理的入口：`ctx.subagents.interrupt()` 只暴露给进程内工具
   （interrupt_agent）。宿主侧因此无从下手 —— 唯一能精确停掉单只子代理的现成原语就在这里。

   本插件照 session-steer-server.mjs 的路子，给上游 HarnessSdkJsonRpcServer 装一枚**可选**
   JSON-RPC 方法（原型级补丁，幂等，只加方法，其余 handleRequest 原样委托）：

     - `session/interrupt-subagent` params `{parentSessionId, childSessionId}`：
       以**人类父级**身份（authority `{kind:'user', parentSessionId}`，见 dsh-subagent 的
       interrupt 授权口径）中断那只子代理的 activation。回：
         · `{ok:true}`                       —— 已下发中断（子代理不存在 / 已收尾也算，幂等）；
         · `{ok:false, reason:'invalid_params'}` —— 缺参数；
         · `{ok:false, reason:'no_subagents'}`   —— 这台运行时没有 subagents 服务（委派关掉了）。

   **一律不抛**：抛错会经 JSON-RPC 变成 error 响应，宿主那一步会被判成失败；而「停不下来」
   本该只是一句提示，不该把别的活一起判死。网关拿 `ok:false` 就提示用户，不改变任何状态。
   老运行时不加载本行 = 网关按 unknown-method 回退，行为与接入前一字不变。 */

import { HarnessSdkJsonRpcServer } from '@deepseek-ai/dsh-sdk-jsonrpc-server'

export const name = 'mtnode-subagent-control'

const INTERRUPT_METHOD = 'session/interrupt-subagent'

let installed = false

/* 取这台运行时的 subagents 服务（没有 = 委派整档关掉了，按 no_subagents 回）。 */
function subagentsOf(ctx) {
  const s = ctx && ctx.subagents
  if (!s || typeof s.interrupt !== 'function') return null
  return s
}

function interruptSubagent(params) {
  const parentSessionId = params && params.parentSessionId != null
    ? String(params.parentSessionId).trim()
    : ''
  const childSessionId = params && params.childSessionId != null
    ? String(params.childSessionId).trim()
    : ''
  if (!parentSessionId || !childSessionId) return { ok: false, reason: 'invalid_params' }
  const subs = subagentsOf(this.ctx)
  if (!subs) return { ok: false, reason: 'no_subagents' }
  try {
    /* authority.kind 'user'：只校验「这只子代理确实属于这个父会话」，
       不需要父 agent 此刻还 live —— 子代理往往比父那一轮活得久。 */
    subs.interrupt(childSessionId, { kind: 'user', parentSessionId })
  } catch (err) {
    /* 授权不符 / 已回收：同样不占错误通道，交一句原因给宿主 */
    return {
      ok: false,
      reason: 'rejected',
      error: String((err && err.message) || err).slice(0, 200),
    }
  }
  return { ok: true }
}

/* 原型级补丁：只加一枚方法，其余 handleRequest 原样委托。幂等安装（HMR / 重复挂载安全）。 */
function installPatch() {
  if (installed) return
  installed = true
  const proto = HarnessSdkJsonRpcServer && HarnessSdkJsonRpcServer.prototype
  if (!proto || typeof proto.handleRequest !== 'function') return
  const original = proto.handleRequest
  proto.handleRequest = async function handleRequest(method, params) {
    if (method === INTERRUPT_METHOD) return interruptSubagent.call(this, params || {})
    return original.call(this, method, params)
  }
}

export function apply() {
  installPatch()
}
