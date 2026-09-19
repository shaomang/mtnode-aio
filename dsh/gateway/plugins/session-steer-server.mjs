/* 轮内插话与暂停 · session/steer + session/pause 桥（mtnode-session-steer · 跑在 dsh 运行时进程内）。

   背景：宿主在一条提示已经跑起来之后，用户还想做两件事 —— ① 追加一句即时纠偏（不打断
   当前这一步）；② 按 ■ 停掉当前这一轮但**不丢**已排队的后续消息。运行时侧原语本来就齐备
   （dsh-agent 的 Agent 接口：`steer(message: UserMessage)` / `cancel(cause, { keepInbox })`），
   上游 dsh-sdk-jsonrpc-server 的 handleRequest 只认 initialize / session/prompt / shutdown
   三枚方法 —— 缺的只是这两枚方法没人接。

   本插件照 session-resume 桥的路子给上游 HarnessSdkJsonRpcServer 装两枚**可选** JSON-RPC 方法
   （原型级补丁，幂等，只加方法，其余 handleRequest 原样委托）：
     - `session/steer`  params `{sessionId, text}`：取这台 runtime 的 live agent，用与上游
       `server.prompt` **同源**的 createUserMessage（@deepseek-ai/dsh-llm，source.kind = 'user'）
       构造一条用户消息后 `agent.steer(msg)`，回 `{ok:true, messageId}`；
       会话不在 live（进程已换 / 会话未起）→ `{ok:false, reason:'no_live_agent'}`，
       网关据此降级为排队（走既有的 session/prompt followup 语义）。
     - `session/pause`  params `{sessionId}`：`agent.cancel({kind:'user'}, {keepInbox:true})`
       —— 当前这一轮中止，已排队与 steering 的 inbox 条目**保留**给后续轮，回 `{ok:true}`；
       会话不在 live → `{ok:false, reason:'no_live_agent'}`。

   两枚方法**一律不抛**：抛错会经 JSON-RPC 变成 error 响应，宿主那一轮按失败收场并整轮重发
   —— 而插话 / 暂停失败本该只是「没插进去」，绝不该把用户正在跑的轮次判死。参数缺失同样按
   `{ok:false, reason:'invalid_params'}` 回，不占错误通道。

   降级保底：网关不调用这两枚方法时行为与接入前一字不变；老运行时没有这两枚方法 = 网关按
   unknown-method 回退（插话降级为排队 / 暂停回落既有的整轮终止路径）。本文件 import
   @deepseek-ai/dsh-llm 与 @deepseek-ai/dsh-sdk-jsonrpc-server —— 与 session-resume-server.mjs
   同类的 dsh API 吸收点（dsh 升级的 API 变动只落在 dsh/ 内）。 */

import { HarnessSdkJsonRpcServer } from '@deepseek-ai/dsh-sdk-jsonrpc-server'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

export const name = 'mtnode-session-steer'

const STEER_METHOD = 'session/steer'
const PAUSE_METHOD = 'session/pause'

let installed = false

/* 取这台 runtime 里点名的 live agent；不在 live 一律回 null（调用方按 ok:false 收场）。
   与 session-resume 不同：这里**不**从盘上恢复会话 —— 插话 / 暂停只对正在跑的轮次有意义。 */
function liveAgent(sid) {
  const agents = this.ctx && this.ctx.agents
  if (!agents || typeof agents.get !== 'function') return null
  const agent = agents.get(sid)
  return agent || null
}

/* 轮内插话：构造一条 user 消息塞进当前轮的 steering 位（下一步可见，不重开轮）。 */
function steerSession(params) {
  const sid = params && params.sessionId != null ? String(params.sessionId).trim() : ''
  const text = params && typeof params.text === 'string' ? params.text : ''
  if (!sid || text === '') return { ok: false, reason: 'invalid_params' }
  const agent = liveAgent.call(this, sid)
  if (!agent) return { ok: false, reason: 'no_live_agent' }
  if (typeof agent.steer !== 'function') return { ok: false, reason: 'no_live_agent' }
  /* 与上游 server.prompt 同源：同一 createUserMessage + source.kind 'user'，
     这样插话在会话日志与宿主投影里和普通用户消息完全同形。 */
  const message = createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })
  agent.steer(message)
  return { ok: true, messageId: message.id }
}

/* 暂停本轮：中止当前活动，但保留已排队 / steering 的 inbox 条目给后续轮。 */
function pauseSession(params) {
  const sid = params && params.sessionId != null ? String(params.sessionId).trim() : ''
  if (!sid) return { ok: false, reason: 'invalid_params' }
  const agent = liveAgent.call(this, sid)
  if (!agent) return { ok: false, reason: 'no_live_agent' }
  if (typeof agent.cancel !== 'function') return { ok: false, reason: 'no_live_agent' }
  try {
    agent.cancel({ kind: 'user' }, { keepInbox: true })
  } catch {
    /* cancel 内部异常同样不占错误通道：宿主按「本轮自己跑完」继续，绝不因此判死这一轮 */
    return { ok: false, reason: 'no_live_agent' }
  }
  return { ok: true }
}

/* 原型级补丁：只加两枚方法，其余 handleRequest 原样委托。幂等安装（HMR / 重复挂载安全）。 */
function installPatch() {
  if (installed) return
  installed = true
  const proto = HarnessSdkJsonRpcServer && HarnessSdkJsonRpcServer.prototype
  if (!proto || typeof proto.handleRequest !== 'function') return
  const original = proto.handleRequest
  proto.handleRequest = async function handleRequest(method, params) {
    const p = params || {}
    if (method === STEER_METHOD) return steerSession.call(this, p)
    if (method === PAUSE_METHOD) return pauseSession.call(this, p)
    return original.call(this, method, params)
  }
}

export function apply() {
  installPatch()
}
