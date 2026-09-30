/* 跨进程真续跑 · session/resume 桥（mtnode-session-resume · 跑在 dsh 运行时进程内）。

   背景（契约见 dsh/DESIGN.md「断点续跑契约」）：宿主在失败轮后带 resumeSession 点名
   续跑同一个 dsh 会话。续跑只有在「同一台 runtime 进程内命中 live 会话」时才成立
   （SDK server getOrCreateSession → 进程内 sessions 表命中 → 直接追加）；失败轮那台
   进程若已不在（LRU 换出 / 引擎重启 / 网关被杀后拉起），点名续跑会落在**新进程**上 ——
   上游 dsh-sdk-jsonrpc-server 的 createSession 只会 `agents.create`（空 seed 新建同名
   会话），dsh-session-persistence 在 session/created 时发现盘上旧日志与空 seed 不符 →
   `(id collision)` 硬错误 → 整轮重发白烧（已写上下文全丢）。

   运行时侧真续跑的原语本来就齐备：agent-loop 的 `agents.resume`（→ persistence.prepare
   → setupAndPublish，注释明言 "Load a persisted session and resume an agent on it"）。
   缺的只是 SDK server 的会话入口永远调 create、不调 resume 这一处接线。

   本插件把接线补上：给上游导出的 HarnessSdkJsonRpcServer 装一枚**可选** JSON-RPC 方法
   `session/resume`（原型级补丁，幂等，只改这一处）：
     - 网关在**续跑轮**真实 prompt 前调用它（gateway.mjs handleRun 的 resume 桥段）；
     - 会话已在本进程 live（同进程续跑，server.sessions 命中）→ 返回 {resumed:false}，
       零开销，随后的 session/prompt 照旧追加；
     - 不在 live 但盘上有日志 → `ctx.agents.resume` 恢复为 live（agentLoop resume 语义：
       persistence.prepare 整读旧日志 → 会话带完整 seed 发布）并登记进 server 的
       sessions 表 —— 随后的 session/prompt 命中同进程 live 会话，事件经 server 既有
       session/event 订阅自然回流，网关无需改任何通知路径；
     - 恢复失败（日志损坏 / 格式版本不符 / 会话属于别的 cwd）→ 原样抛错，网关把它
       转译成 RESUME_UNAVAILABLE 收场（宿主退回整轮重发，与不可续跑语义一致）。

   降级保底：全新会话的 run 从不调用该方法 → 上游 create 路径一字不改；老运行时没有
   该方法 = 网关按 unknown-method 回退旧行为（同进程续跑照常 / 跨进程回落既有的
   collision → RESUME_UNAVAILABLE 转译），行为与接入前一字不变。
   本文件 import @deepseek-ai/dsh-sdk-jsonrpc-server —— 与 canvas-plugin import
   @deepseek-ai/dsh-tools 同类的 dsh API 吸收点（dsh 升级的 API 变动只落在 dsh/ 内）。 */

import { HarnessSdkJsonRpcServer } from '@deepseek-ai/dsh-sdk-jsonrpc-server'

export const name = 'mtnode-session-resume'

const RESUME_METHOD = 'session/resume'
/* 只读自检方法：把本运行时的**生效装配**回给网关（仅 id 与 config）。0.2 把设置真源搬到
   profile 补丁层后，「宿主写了文件」不再等于「运行时读到了配置」——这枚方法让冒烟能对着
   真实运行时核对（见 test/smoke-settings-profile-patch.js 的 [6] 段）。 */
const PROBE_METHOD = 'config/probe'
const PROBE_IDS = ['llm-deepseek', 'llm-pi-ai', 'permission', 'system-prompt', 'mtnode-tool-visibility', 'agent-default-model']

/* 运行时原生设置写入（候选：0.2 把设置落在 profile 补丁层，由 dsh-settings 掌写）。
   params = { ns, values } / { ns, patch } → ctx.settings.update(ns, values)。 */
const SET_METHOD = 'session/settings'
async function applyRuntimeSetting(params) {
  const ns = String((params && params.ns) || '').trim()
  const values = (params && (params.values || params.patch)) || {}
  if (!ns) throw new Error('session/settings: missing ns')
  const settings = this.ctx && typeof this.ctx.get === 'function' ? this.ctx.get('settings') : undefined
  if (!settings || typeof settings.update !== 'function') {
    return { ok: false, reason: 'no_settings_service' }
  }
  try {
    await settings.update(ns, values)
    return { ok: true, ns }
  } catch (err) {
    return { ok: false, reason: String((err && err.message) || err).slice(0, 300) }
  }
}

let installed = false

/* 只序列化可 JSON 化的部分：config 里可能夹着函数 / 类实例（插件 config），
   探针只用于断言，遇到深层或不可序列化值就地降级，绝不抛。 */
function jsonSafe(value, depth = 0) {
  if (depth > 8) return '[deep]'
  if (value === null || typeof value !== 'object') return typeof value === 'function' ? '[function]' : value
  if (Array.isArray(value)) return value.slice(0, 200).map((v) => jsonSafe(v, depth + 1))
  const out = {}
  for (const [k, v] of Object.entries(value)) out[k] = jsonSafe(v, depth + 1)
  return out
}

/* 读取**生效行表**（id + 整份 config）——即「bundle 层 + MTNode 补丁层 + 用户补丁层」
   叠加后的最终装配。真源是配置编辑器（dsh-config-editor）：它的 configuration() 给出
   每行的 entry 复合配置（inherited 与 override 已合成），entries() 给出当前装配的行。
   （0.2 的 loader 服务上没有 entries()，别再往那儿找。） */
function probeConfiguration() {
  const ctx = this.ctx
  const editor = (() => {
    try { return ctx && typeof ctx.get === 'function' ? ctx.get('configEditor') : null } catch { return null }
  })()
  if (!editor || typeof editor.configuration !== 'function') {
    return { cwd: process.cwd(), dshHome: String(process.env.DSH_HOME || ''), entries: [], error: 'configEditor unavailable' }
  }
  let rows = []
  try { rows = editor.configuration() || [] } catch { rows = [] }
  const entries = []
  for (const row of rows) {
    const entry = (row && row.entry) || row || {}
    const options = (entry && entry.options) || {}
    if (!PROBE_IDS.includes(options.id)) continue
    /* 复合配置优先（configuration() 给的是合成后的 config），拿不到再回落到行上的原始 config */
    let config = row && row.config !== undefined ? row.config : options.config
    entries.push({ id: options.id, config: jsonSafe(config) })
  }
  return { cwd: process.cwd(), dshHome: String(process.env.DSH_HOME || ''), entryCount: rows.length, entries }
}

/* 把点名会话恢复成这台 runtime 的 live 会话并登记进 server 会话表。
   只有「真恢复失败」才抛错（网关据此 RESUME_UNAVAILABLE 收场）；已在 live 与无日志
   两种不归这里管（前者零开销返回，后者根本不会被调用 —— 网关先判过盘上文件）。 */
async function resumePersistedSession(params) {  const rawSid = params && params.sessionId != null ? String(params.sessionId).trim() : ''
  if (!rawSid) throw new Error('session/resume: missing sessionId')
  /* 已在 live：同进程续跑（失败轮那台 runtime 还活着）→ prompt 直接追加，无事可做 */
  if (this.sessions.has(rawSid)) return { sessionId: rawSid, resumed: false }
  const pending = this.sessionCreations.get(rawSid)
  if (pending) {
    try { await pending } catch { /* 落回下方重新判定 */ }
    if (this.sessions.has(rawSid)) return { sessionId: rawSid, resumed: false }
  }
  const agents = this.ctx && this.ctx.agents
  if (!agents || typeof agents.resume !== 'function') {
    throw new Error('session/resume: agent resume is unavailable in this runtime')
  }
  /* 会话 live 在本进程但不在 server 表里（别的入口已恢复）→ 拒绝，防 agents 重复注册 */
  if (agents.get(rawSid)) {
    throw new Error(`session "${rawSid}" is already live in this runtime but not tracked by the SDK server (id collision)`)
  }
  const handle = await agents.resume({
    resumeSessionId: rawSid,
    agentOptions: {
      provider: this.provider,
      model: this.model,
      ...(this.maxTokens === undefined ? {} : { maxTokens: this.maxTokens }),
    },
  })
  /* cwd 对齐守卫：恢复出来的会话属于别的 workspace → 拒绝（网关转 RESUME_UNAVAILABLE，
     宿主退回当前 workspace 整轮重发）。旧日志头里没记 cwd 的一律放行。 */
  const agent = handle && handle.agent
  const cwd = agent && agent.session && agent.session.header && agent.session.header.cwd
  const here = process.cwd()
  if (cwd && here && String(cwd).toLowerCase() !== String(here).toLowerCase()) {
    try { if (handle && typeof handle.dispose === 'function') await handle.dispose() } catch { /* 收尾尽力而为 */ }
    throw new Error(
      `session "${rawSid}" is persisted at a different cwd (persisted: ${cwd}, live: ${here}) (id collision)`,
    )
  }
  this.sessions.set(rawSid, { handle })
  return { sessionId: rawSid, resumed: true }
}

/* 原型级补丁：只加一枚方法，其余 handleRequest 原样委托。幂等安装（HMR / 重复挂载安全）。 */
function installPatch() {
  if (installed) return
  installed = true
  const proto = HarnessSdkJsonRpcServer && HarnessSdkJsonRpcServer.prototype
  if (!proto || typeof proto.handleRequest !== 'function') return
  const original = proto.handleRequest
  proto.handleRequest = async function handleRequest(method, params) {
    if (method === RESUME_METHOD) return resumePersistedSession.call(this, params || {})
    if (method === PROBE_METHOD) return probeConfiguration.call(this)
    if (method === SET_METHOD) return applyRuntimeSetting.call(this, params || {})
    return original.call(this, method, params)
  }
}

export function apply() {
  installPatch()
}
