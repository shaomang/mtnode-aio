// MTNode 运行时改动捕获插件(跑在 dsh runtime 进程内)。
//
// 作用:在工具执行的 pre / post 观察点采样「改前正文」与「改后指纹」,经同一条
// 交互桥 TCP **单向**发出 begin / pre / post / end 四种相位的 journal 帧,由主进程
// 落盘成内容寻址对象库 + 轮次账本(契约见 dsh/DESIGN.md「回滚账本与 journal 帧(契约)」)。
// 本插件**自己不写盘、不等回答、不重试**:桥断开就丢帧并计数;任何异常都不得阻断
// 工具执行(DESIGN 的降级保底 —— 这个插件缺席时,产品行为与接入前一字不差)。
//
// 与其它桥插件一样只 import node 内置模块;dsh 插件 API 经注入的 ctx 到达。
//
// 帧协议(换行分隔 JSON,与 question / approval / canvas / db 同一条通道,端口经
// MTNODE_BRIDGE_PORT 在 spawn 时注入)。**一律走 `t:'journal'` 一种 t**,用 `phase`
// 区分 begin / pre / post / 末帧 end —— gateway 只把 journal 帧原样转成本地协议事件
// `journal`(未知 t 会被当噪声丢掉),而事件侧的 data.phase 本来就要覆盖这四种相位。
// 全程单向 fire-and-forget:不登记 bridgePending、不等 answer/outcome/abort、不重试。
//
//   plugin → gateway
//     {t:'journal', id, sessionId, roundId, phase:'begin', workspace, at}
//     {t:'journal', id, sessionId, roundId, phase:'pre'|'post', kind, callId, tool, …}
//     {t:'journal', id, sessionId, roundId, phase:'end', at, dropped}
//   gateway → plugin(每轮 run 开合时向该 runtime 的全部桥连接广播)
//     {t:'begin', sessionId, roundId, dir} / {t:'end', sessionId, roundId}
//
// journal 帧的 kind 与字段:
//   'file'   → path, existed, hash, size, mtimeMs[, content, encoding, unsupported]
//   'canvas' → 宿主侧记账占位(hostRecorded:true):整工作流快照由渲染层做
//   'db'     → 同上占位:事实库改动的 before/after 由宿主侧账本给
//   'shell'  → cmd(截断 512B), cwd:只汇总进 untracked.shellCalls,不承诺可回滚
//
// 归属:一个 runtime 同时只有一个在途 run(gateway 的 keyToReqId 保证),所以「进程级
// 当前轮」是安全的。**没收到 begin 就不捕获** —— 迟到帧靠章不靠时刻,无章时静默远比
// 把动静记到别人的轮次上安全。
//
// 不捕获:pwsh / bash / execute 改的文件(只计数)、回滚目录与账本自身的写入(自指,
// 靠 MTNODE_ROLLBACK_DIR + begin.dir 排除)、超阈值或二进制正文(标 unsupported)。

import { createConnection } from 'node:net'
import { randomUUID, createHash } from 'node:crypto'
import { statSync, readFileSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'

export const name = 'mtnode-rollback'
export const inject = ['tools']

/* 改前正文入帧的上限:超过只记指纹并标 unsupported:'too-large'(宁可标记不可静默)。
   gateway 侧单帧 > 2MB 整帧丢弃,这里给 JSON 转义留足余量。 */
const MAX_CAPTURE_BYTES = 768 * 1024
/* post 只要指纹不要正文(回滚用不到改后内容,入库等于体积翻倍),可以哈希大文件。 */
const MAX_HASH_BYTES = 16 * 1024 * 1024
/* 单帧硬上限:超了退化成「只带指纹不带正文」的一条,而不是整帧丢掉。 */
const MAX_FRAME_BYTES = 1_800_000
/* 命令行只用于「本轮有 N 次命令可能改了文件」的提示,截断即可。 */
const SHELL_CMD_BYTES = 512

/* 会改工作区文件的工具。str_replace_editor 只在 create / str_replace / insert 下
   真的落盘(view 等只读命令不进账)。 */
const FILE_TOOLS = new Set(['write', 'edit', 'str_replace_editor'])
const FILE_PATH_KEYS = ['file_path', 'path']
const STR_REPLACE_MUTATING = new Set(['create', 'str_replace', 'insert'])
/* 画布 / 应用 / 数据库:真正的快照在宿主侧(渲染层持有画布与事实库),插件只登记一条
   占位,让账本能显式说出「这一轮动过画布/数据库」。只读调用连占位都不发。 */
const CANVAS_TOOLS = new Set(['mtnode_canvas_edit', 'mtnode_app'])
const APP_READ_ONLY_ACTIONS = new Set(['', 'status', 'list_workflows', 'select_nodes', 'list_dsh_plugins', 'undo', 'redo'])
const DB_TOOL = 'mtnode_db'
const DB_READ_ONLY_ACTIONS = new Set(['', 'list', 'query', 'get', 'calc'])
/* 命令类工具:文件改动不可捕获,只累计次数。 */
const SHELL_TOOLS = new Set(['pwsh', 'bash', 'shell', 'execute'])

const isWin = process.platform === 'win32'

/** 目录前缀比较用的规范化形式(win32 大小写不敏感)。 */
function dirPrefix(p) {
  let s = String(p || '').trim()
  if (!s) return ''
  try { s = resolve(s) } catch { return '' }
  if (isWin) s = s.toLowerCase()
  return s.endsWith(sep) ? s : s + sep
}

/** 裸 sha256 小写十六进制 —— 契约里对象 id 就是它。 */
function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

/** 文本返回解码结果,二进制返回 null(二进制不入对象库)。 */
function asText(buf) {
  const probe = buf.subarray(0, Math.min(buf.length, 8192))
  for (let i = 0; i < probe.length; i++) if (probe[i] === 0) return null
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf)
  } catch {
    return null
  }
}

/** 一次工具调用可能涉及的绝对路径列表。 */
function pathsOf(args) {
  const out = []
  if (!args || typeof args !== 'object') return out
  const push = (v) => {
    /* 只认真实字符串路径:空串与含 NUL 的畸形路径不发帧(发了会被误记成
       「本轮新建 → 回滚时删除」,那才是真危险)。 */
    if (typeof v !== 'string') return
    const s = v.trim()
    if (!s || s.indexOf('\u0000') >= 0) return
    try { out.push(resolve(s)) } catch { /* 非法路径跳过 */ }
  }
  for (const key of FILE_PATH_KEYS) {
    const v = args[key]
    if (Array.isArray(v)) for (const one of v) push(one)
    else push(v)
  }
  return out
}

/** 工作区内记相对路径(账本以 workspace 为基准),区外保留绝对路径并置 outside。 */
function displayPath(abs) {
  let rel = ''
  try { rel = relative(process.cwd(), abs) } catch { rel = '' }
  if (rel && !rel.startsWith('..') && !isAbsolute(rel)) {
    return { path: rel.split(sep).join('/'), outside: false }
  }
  return { path: abs, outside: true }
}

/** 参数里的字符串字段(可截断),用于 shell / db 帧的补充信息。 */
function argText(args, key, maxBytes) {
  const v = args && args[key]
  if (typeof v !== 'string') return ''
  if (!maxBytes || Buffer.byteLength(v, 'utf8') <= maxBytes) return v
  try {
    return new TextDecoder().decode(Buffer.from(v, 'utf8').subarray(0, maxBytes))
  } catch {
    return v.slice(0, maxBytes)
  }
}

export function apply(ctx) {
  const port = Number(process.env.MTNODE_BRIDGE_PORT || 0)
  const envDir = String(process.env.MTNODE_ROLLBACK_DIR || '').trim()
  /* 缺任一环境变量 = 宿主没启用回滚能力:整体 no-op,行为与未接入时一致。 */
  if (!Number.isInteger(port) || port <= 0 || !envDir) return

  let socket = null
  let buf = ''
  /** @type {{sessionId:string, roundId:string}|null} 本轮的章(gateway begin 给的) */
  let round = null
  /* 自指排除:账本与对象库自身的写入不进捕获。env 是建桥那次传入的目录,begin 帧的
     dir 才是本轮权威,两个都排;集合有界,防长跑进程里无界增长。 */
  const excluded = new Set([dirPrefix(envDir)])
  /* 插件侧静默丢帧数:随 end 帧上报,主进程据此把账本降级为 partial。 */
  let dropped = 0

  const send = (frame) => {
    if (!socket || socket.destroyed) { dropped++; return }
    let line = ''
    try { line = JSON.stringify(frame) } catch { dropped++; return }
    if (Buffer.byteLength(line, 'utf8') + 1 > MAX_FRAME_BYTES) {
      try {
        delete frame.content
        if (!frame.unsupported) frame.unsupported = 'too-large'
        line = JSON.stringify(frame)
      } catch { dropped++; return }
    }
    try { socket.write(line + '\n') } catch { dropped++ }
  }

  /** 带本轮盖章的一帧(没有章就不发)。 */
  const stamp = (frame) => {
    if (!round) return
    send({ id: randomUUID(), sessionId: round.sessionId, roundId: round.roundId, at: Date.now(), ...frame })
  }

  /**
   * 采样一个路径。
   * pre  = 改前指纹 + 改前正文(文本且未超阈值才带 content);unsupported 只由 pre 决定
   *        (语义是「改前内容不可得」,回滚据此跳过该条并如实报告)。
   * post = 当前指纹,只服务还原前的守卫校验(afterHash),不带正文。
   */
  const sampleFile = (abs, phase, exec) => {
    const here = dirPrefix(abs)
    for (const root of excluded) if (root && here.startsWith(root)) return
    const shown = displayPath(abs)
    const rec = {
      t: 'journal',
      phase,
      kind: 'file',
      callId: String(exec.callId ?? ''),
      tool: String(exec.name || ''),
      path: shown.path,
      outside: shown.outside,
      existed: false,
      hash: '',
      size: 0,
      mtimeMs: 0,
    }
    let st = null
    try { st = statSync(abs) } catch { st = null }
    if (!st || !st.isFile()) {
      /* pre 看不到文件 = 本轮新建(回滚时该删掉它);post 看不到 = 本轮删了它。 */
      if (phase === 'post') rec.existsNow = false
      stamp(rec)
      return
    }
    rec.existed = true
    rec.size = Number(st.size) || 0
    rec.mtimeMs = Number(st.mtimeMs) || 0
    const cap = phase === 'pre' ? MAX_CAPTURE_BYTES : MAX_HASH_BYTES
    if (rec.size > cap) {
      if (phase === 'pre') rec.unsupported = 'too-large'
      else rec.hashSkipped = true
      stamp(rec)
      return
    }
    let bytes = null
    try {
      bytes = readFileSync(abs)
      rec.hash = sha256(bytes)
      rec.size = bytes.length
    } catch {
      if (phase === 'pre') rec.unsupported = 'denied'
      stamp(rec)
      return
    }
    if (phase === 'pre') {
      const text = asText(bytes)
      if (text === null) rec.unsupported = 'binary'
      else {
        rec.content = text
        rec.encoding = 'utf8'
      }
    }
    stamp(rec)
  }

  const sampleFiles = (exec, phase) => {
    if (exec.name === 'str_replace_editor') {
      const cmd = String((exec.arguments && exec.arguments.command) || '')
      if (!STR_REPLACE_MUTATING.has(cmd)) return
    }
    for (const abs of pathsOf(exec.arguments)) sampleFile(abs, phase, exec)
  }

  /** 宿主侧记账的占位帧:插件不采内容,只说明「这轮动过它,细账在宿主」。 */
  const sampleHost = (exec, kind) => {
    const args = exec.arguments && typeof exec.arguments === 'object' ? exec.arguments : {}
    const action = argText(args, 'action', 64)
    if (exec.name === 'mtnode_app' && APP_READ_ONLY_ACTIONS.has(action)) return
    if (kind === 'db' && DB_READ_ONLY_ACTIONS.has(action)) return
    stamp({
      t: 'journal',
      phase: 'pre',
      kind,
      callId: String(exec.callId ?? ''),
      tool: String(exec.name || ''),
      hostRecorded: true,
      snapshot: null,
      ...(action ? { action } : {}),
    })
  }

  const sampleShell = (exec) => {
    const args = exec.arguments && typeof exec.arguments === 'object' ? exec.arguments : {}
    stamp({
      t: 'journal',
      phase: 'pre',
      kind: 'shell',
      callId: String(exec.callId ?? ''),
      tool: String(exec.name || ''),
      cmd: argText(args, 'command', SHELL_CMD_BYTES),
      cwd: process.cwd(),
    })
  }

  const observe = (exec, phase) => {
    const toolName = String((exec && exec.name) || '')
    if (!toolName) return
    if (FILE_TOOLS.has(toolName)) {
      sampleFiles(exec, phase)
      return
    }
    if (phase !== 'pre') return /* 宿主占位与 shell 计数一次调用只记一回 */
    if (CANVAS_TOOLS.has(toolName)) sampleHost(exec, 'canvas')
    else if (toolName === DB_TOOL) sampleHost(exec, 'db')
    else if (SHELL_TOOLS.has(toolName)) sampleShell(exec)
  }

  /* ── 桥连接:只发帧;顺带收 gateway 广播的回合开合来盖章 ────────────────── */
  const onLine = (line) => {
    let m
    try { m = JSON.parse(line) } catch { return }
    if (!m || typeof m !== 'object') return
    if (m.t === 'begin') {
      const rid = String(m.roundId ?? '')
      if (!rid) return
      const sid = String(m.sessionId || '')
      /* 同一轮重复 begin(多连接广播 / 热重载)不重开账。 */
      if (round && round.roundId === rid && round.sessionId === sid) return
      const dir = dirPrefix(m.dir || envDir)
      if (excluded.size > 64) {
        const keep = [dirPrefix(envDir), dir].filter(Boolean)
        excluded.clear()
        for (const k of keep) excluded.add(k)
      } else if (dir) excluded.add(dir)
      round = { sessionId: sid, roundId: rid }
      dropped = 0
      stamp({ t: 'journal', phase: 'begin', workspace: process.cwd() })
    } else if (m.t === 'end') {
      if (!round) return
      const rid = m.roundId === undefined || m.roundId === null ? '' : String(m.roundId)
      if (rid && rid !== round.roundId) return
      stamp({ t: 'journal', phase: 'end', dropped })
      round = null
      dropped = 0
    }
  }

  const connect = () => {
    const s = createConnection({ host: '127.0.0.1', port })
    socket = s
    s.on('data', (d) => {
      buf += d.toString()
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (!line) continue
        try { onLine(line) } catch { /* 收帧异常绝不外泄 */ }
      }
    })
    s.on('error', () => {})
    s.on('close', () => {
      if (socket === s) socket = null
      /* 桥断了本轮的章就作废:剩余改动静默不记,主进程据 dropped / 缺帧按 partial 处理。 */
      round = null
      setTimeout(connect, 2000)
    })
  }
  connect()

  /* ── 工具执行观察点:决定权必定交回 next(),插件永不改结果 ───────────────── */
  ctx.on('tools/pre-execute', (exec, next) => {
    try {
      if (round) observe(exec, 'pre')
    } catch { /* 降级:捕获失败不影响这轮任务 */ }
    return next()
  })

  ctx.on('tools/post-execute', (exec, result, next) => {
    try {
      if (round) observe(exec, 'post')
    } catch { /* 降级 */ }
    return next()
  })
}
