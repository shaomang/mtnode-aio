// MTNode agent gateway: the ONLY place in this codebase that imports dsh code.
//
// North side: a stable, mtnode-owned line-delimited JSON protocol on stdio
// (see ../DESIGN.md). South side: @deepseek-ai/dsh-sdk-client driving the
// published JSON-RPC runtime. When a dsh release breaks its SDK or wire
// format, only this file and cordis.yml change.
//
// Runs under a Node >= 22.19 executable chosen by the hosting app; it never
// runs under Electron's embedded Node.

import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'
import { getBuiltinProviders, getBuiltinModels } from '@earendil-works/pi-ai/providers/all'
import { createRequire } from 'node:module'
import { createInterface } from 'node:readline'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import path from 'node:path'
import crypto from 'node:crypto'

const require = createRequire(import.meta.url)
const RUNTIME_BIN = require.resolve('@deepseek-ai/dsh-sdk-jsonrpc-demo/bin')
const CORDIS_PATH = path.resolve(import.meta.dirname, 'cordis.yml')
const GATEWAY_DIR = import.meta.dirname
const GATEWAY_VERSION = '0.1.0'
const MAX_RUNTIMES = 3

/* Agent 预设(迁移自 dsh 的 agent-presets 概念):作为每次运行的角色前缀,
   由宿主应用在设置中选择,随 run 参数下发。 */
const PRESETS = {
  standard:
    'You are the agent engine inside MTNode, a visual AI-workflow desktop app. Help ordinary users finish concrete content and file tasks: read and write files, search the web, and run commands when needed. You can build the visual canvas with mtnode_canvas_get / mtnode_canvas_edit / mtnode_app: create nodes, unique titles, wires, @Title references, and auto-layout. Never switch workflows, never pan/zoom/fit/focus the camera, and never change the user's view — leave the viewport exactly as the user left it. Prefer user-editable layouts: use createMarks (box/text) to zone 编辑区 / 说明 / 处理区, and add control nodes (run/clear) wired to processing nodes so users can re-run easily. Place nodes the user must edit or operate (inputs, editable prompts, control ▶) toward the TOP of the canvas so they are easy to see and use; put heavy processing / save / docs lower or to the right. For image input nodes use kind input_image and set imagePath to an absolute file path so the app loads the image (do not ask the user to drag-drop when the path is known). Keep text processing and image→text (multimodal) isolated: use a dedicated vision/agent node to turn images into text, then wire that text into pure-text nodes so language steps can use a better text-only model — do not hang images on text-only reasoning nodes. Mid-task pixel reading (game UI, screenshot OCR, verify a generated image): call mtnode_vision with imagePath + question instead of stuffing large image batches into the main prompt; the host asks the user for permission the first time. CRITICAL batch safety: batchMode=batch runs once per item — each run must see only that item; never feed the whole batch of N into every run (that causes ~N² image/API calls and huge token waste). Prefer a split node to pick one item before heavy 文生图; use batchMode=agg only when one run should see all items. For per-item batch prefer ordinary proc_text/proc_image (not agent_task / agent mode). CRITICAL for image generation (proc_image): each run produces exactly ONE image — never write prompts that ask for multiple images in one generation; for many images use 1:1 batch items, multiple proc_image nodes, or attempts N. Set proc_image size from imageSizes returned by mtnode_canvas_get (e.g. 2048x1360 / 1280x1280 / auto) to match portrait/landscape/square needs. CRITICAL: never create save_text/save_image after agent_task or proc_text with agent:true — smart nodes write files themselves; a save node would dump irrelevant transcript text. Use save_* only after ordinary (non-agent) proc nodes. CRITICAL: avoid wiring agent_task / proc_text(agent) as DATA inputs into other nodes (session noise; weak key transfer). Prefer file handoff: smart node writes a document, then wait_file (waitPath) wires OUT as a control blocker until the file exists; wait_file has no input ports and outputs nothing — later nodes read the agreed path themselves. Never wire into wait_file. When asked to implement a workflow, create an editable pipeline the user can re-run. Work step by step, show the user what you are doing, and end with a clear, complete result.',
  minimal:
    'You are a direct executor. Finish the task with minimal steps and minimal talk; reply only with what matters, and end with the result itself.',
  code:
    'You are a software engineer. Inspect files before editing, write or modify code and run commands to finish the task, and report what you changed and how to verify it.',
  cordis:
    'You are a Cordis plugin developer for DeepSeek Harness. Follow Cordis conventions (Service classes, ctx.effect/ctx.on registrations, typed events) when writing plugins or composition files.',
}

/** @type {Map<string, {harness: Promise<DeepSeekHarness>, order: number}>} */
const runtimes = new Map()
let runtimeOrder = 0

/* ── interaction bridge (mtnode-bridge / mtnode-canvas ↔ renderer) ─────── */
/** @type {Map<string, {server: import('node:net').Server, sockets: Set<any>}>} */
const bridgeServers = new Map()
const socketToKey = new Map()
/** @type {Map<string, {socket: any, key: string, kind: string}>} */
const bridgePending = new Map()
const keyToReqId = new Map()

function abortBridgePending(key, socket) {
  for (const [id, p] of bridgePending) {
    if (p.key !== key) continue
    if (socket && p.socket !== socket) continue
    bridgePending.delete(id)
    try { p.socket.write(JSON.stringify({ t: 'abort', id }) + '\n') } catch {}
  }
}

function closeBridge(key) {
  const b = bridgeServers.get(key)
  if (!b) return
  bridgeServers.delete(key)
  keyToReqId.delete(key)
  abortBridgePending(key)
  if (b.sockets) {
    for (const s of b.sockets) {
      try { s.destroy() } catch {}
    }
  }
  try { if (b.socket) b.socket.destroy() } catch {}
  try { b.server.close() } catch {}
}

function out(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

/* 图像附件:按 dsh-attachment-local 的内容寻址布局,把图像写入
   DSH_HOME/attachments/v1/objects/<sha 前2位>/<sha256>,
   返回 harness 用户消息的 image 内容块(引用 attachmentId)。
   readImageFile 会用 sharp 校验 mediaType/bytes/宽高,故此处用同一
   sharp 探针取值,保证元数据一致。 */
const ATTACH_MIME = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
}
let sharpProbe = null
async function probeImageMeta(buf) {
  /* sharp 为可选依赖:加载失败只影响图像附件,不影响文本任务 */
  try {
    if (!sharpProbe) sharpProbe = (await import('sharp')).default
    return await sharpProbe(buf, { failOn: 'none' }).metadata()
  } catch {
    return null
  }
}
async function attachImages(home, paths) {
  const out = []
  const root = path.join(home || process.env.DSH_HOME || '', 'attachments', 'v1')
  for (const p of Array.isArray(paths) ? paths : []) {
    if (!p || typeof p !== 'string') continue
    try {
      const buf = readFileSync(p)
      const meta = await probeImageMeta(buf)
      if (!meta) continue
      const mediaType = ATTACH_MIME[meta.format]
      if (!mediaType || !(meta.width > 0) || !(meta.height > 0)) continue
      const sha = crypto.createHash('sha256').update(buf).digest('hex')
      const dir = path.join(root, 'objects', sha.slice(0, 2))
      mkdirSync(dir, { recursive: true })
      writeFileSync(path.join(dir, sha), buf)
      out.push({
        type: 'image',
        attachment: {
          attachmentId: 'sha256:' + sha,
          mediaType,
          bytes: buf.length,
          width: meta.width,
          height: meta.height,
        },
      })
    } catch {
      /* 单个图像读取/探测失败仅跳过,不阻断任务 */
    }
  }
  return out
}

/* SDK 握手预热:运行时组合的 settings 文档由 chokidar 异步载入,
   llm-pi-ai 的 mtnode/pi-ai 路由在启动约 0.5~1s 后才注册进适配器表。
   立即 initialize 会在首个请求报 "no adapter registered for provider ..."
   (deepseek-official 由 SDK 服务端自挂载,首试即成功)。失败仅重试该握手,
   运行时进程保持存活。 */
async function warmStartHarness(harness) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  harness.client.start()
  const params = {
    cwd: harness.cwd,
    provider: harness.provider,
    model: harness.model,
    ...(harness.maxTokens === undefined ? {} : { maxTokens: harness.maxTokens }),
  }
  let lastErr
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      await harness.client.initialize(params)
      return harness
    } catch (err) {
      lastErr = err
      if (!/no adapter registered/.test(String((err && err.message) || err))) throw err
      await sleep(400)
    }
  }
  throw lastErr
}

function runtimeKey(workspace, model, maxTokens, provider, apiKey, baseUrl, provHash, effort) {
  const secret = crypto.createHash('sha1').update(apiKey ?? '').digest('hex').slice(0, 12)
  const eff = String(effort || 'high').toLowerCase()
  return [workspace, model, maxTokens, provider, secret, baseUrl ?? '', provHash, eff].join('|')
}

async function getRuntime(workspace, model, maxTokens, provider, apiKey, baseUrl, dshHome, envPatch, effort) {
  const home = dshHome || process.env.DSH_HOME || ''
  const key = runtimeKey(
    workspace,
    model,
    maxTokens,
    provider,
    apiKey,
    baseUrl,
    envPatch ? JSON.stringify(envPatch) : '',
    effort,
  )
  const existing = runtimes.get(key)
  if (existing) {
    existing.order = ++runtimeOrder
    return { harness: existing.harness, key }
  }
  mkdirSync(workspace, { recursive: true })
  const env = { ...process.env }
  if (home) env.DSH_HOME = home
  else delete env.DSH_HOME
  if (apiKey) env.DEEPSEEK_API_KEY = apiKey
  else delete env.DEEPSEEK_API_KEY
  if (baseUrl) env.DEEPSEEK_BASE_URL = baseUrl
  else delete env.DEEPSEEK_BASE_URL
  delete env.DSH_PERMISSION_MODE
  if (envPatch) Object.assign(env, envPatch)

  /* 交互桥:每个运行时独占一个 localhost 端口。bridge + canvas 插件各连一条
     socket,按帧上的 id 把回答写回对应连接。 */
  const bridgeState = { server: null, sockets: new Set() }
  const bridgePort = await new Promise((resolve, reject) => {
    const server = createServer((s) => {
      bridgeState.sockets.add(s)
      socketToKey.set(s, key)
      let buf = ''
      s.on('data', (d) => {
        buf += d.toString()
        let i
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim()
          buf = buf.slice(i + 1)
          if (!line) continue
          let m
          try { m = JSON.parse(line) } catch { continue }
          onBridgeFrame(key, m, s)
        }
      })
      s.on('error', () => {})
      s.on('close', () => {
        bridgeState.sockets.delete(s)
        socketToKey.delete(s)
        abortBridgePending(key, s)
      })
    })
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      bridgeState.server = server
      resolve(server.address().port)
    })
  })
  env.MTNODE_BRIDGE_PORT = String(bridgePort)
  bridgeServers.set(key, bridgeState)

  const entry = { order: ++runtimeOrder }
  entry.harness = (async () => {
    const harness = new DeepSeekHarness({
      launch: {
        command: process.execPath,
        args: [RUNTIME_BIN, CORDIS_PATH],
        cwd: workspace,
        env,
      },
      provider,
      model,
      maxTokens,
    })
    await warmStartHarness(harness)
    return harness
  })().catch((err) => {
    runtimes.delete(key)
    throw err
  })
  runtimes.set(key, entry)

  while (runtimes.size > MAX_RUNTIMES) {
    let oldestKey = null
    let oldestOrder = Infinity
    for (const [k, v] of runtimes) {
      if (v.order < oldestOrder) {
        oldestOrder = v.order
        oldestKey = k
      }
    }
    if (oldestKey === key) break
    const evicted = runtimes.get(oldestKey)
    runtimes.delete(oldestKey)
    closeBridge(oldestKey)
    void evicted.harness.then((h) => h.close()).catch(() => {})
  }
  return { harness: entry.harness, key }
}

/* mtnode-bridge 帧路由:挂起 → 转发给对应 run 的渲染层事件 */
function onBridgeFrame(key, m, socket) {
  if (!m || typeof m.id !== 'string') return
  if (m.t === 'drop') {
    bridgePending.delete(m.id)
    return
  }
  if (m.t !== 'question' && m.t !== 'approval' && m.t !== 'canvas') return
  const reqId = keyToReqId.get(key)
  if (!reqId) {
    try { socket.write(JSON.stringify({ t: 'abort', id: m.id }) + '\n') } catch {}
    return
  }
  bridgePending.set(m.id, { socket, key, kind: m.t })
  const data = { id: m.id, sessionId: m.sessionId || '' }
  if (m.t === 'question') data.questions = Array.isArray(m.questions) ? m.questions : []
  else if (m.t === 'approval') {
    data.toolName = m.toolName || ''
    if (m.callId !== undefined) data.callId = m.callId
    if (m.reason !== undefined) data.reason = m.reason
  } else {
    data.op = typeof m.op === 'string' ? m.op : ''
    data.params = m.params && typeof m.params === 'object' ? m.params : {}
  }
  out({ event: { reqId, type: m.t, data } })
}

function mapNotification(n, emit) {
  if (n.method === 'session.event') {
    const ev = n.params.event
    if (!ev) return
    switch (ev.type) {
      case 'assistant/chunk': {
        const c = ev.data && ev.data.chunk
        if (!c) return
        if (c.type === 'reasoning-delta' && c.text) emit('reasoning', { text: c.text })
        else if (c.type === 'text-delta' && c.text) emit('text', { text: c.text })
        else if (c.type === 'usage') emit('usage', c.usage ?? {})
        return
      }
      case 'tool/call': {
        const d = ev.data
        if (d)
          emit('tool', {
            callId: d.callId ?? '',
            turn: d.turn ?? 0,
            step: d.step ?? 0,
            name: d.name ?? d.tool ?? '',
            args: d.arguments ?? null,
          })
        return
      }
      case 'tool/result': {
        const d = ev.data
        if (!d) return
        /* ToolResultMessage.content 是单个 tool-result 块:外层只带相关性,
           真正的结果内容块与 toolCallId 都在其内层。 */
        let callId = ''
        let blocks = []
        const m = d.message
        if (m && Array.isArray(m.content) && m.content.length) {
          const first = m.content[0]
          if (first && first.type === 'tool-result') {
            callId = first.toolCallId || ''
            blocks = Array.isArray(first.content) ? first.content : []
          } else {
            blocks = m.content
          }
        }
        /* 结果内容块(text/terminal/diff…),截断防超长终端输出撑爆事件流 */
        const content = blocks.map((b) => {
          const o = { type: b && b.type ? String(b.type) : 'text' }
          if (b && typeof b.text === 'string')
            o.text = b.text.length > 32768 ? b.text.slice(0, 32768) + '\n…（已截断）' : b.text
          return o
        })
        emit('tool-result', {
          callId,
          turn: d.turn ?? 0,
          step: d.step ?? 0,
          content,
          error: d.error ?? null,
        })
        return
      }
      case 'session/title':
        if (ev.data && ev.data.title) emit('title', { title: ev.data.title })
        return
      case 'turn/end':
        if (ev.data && ev.data.reason && ev.data.reason.kind === 'error') {
          const msg = ev.data.reason.error && ev.data.reason.error.message
          if (msg) emit('error', { message: String(msg).slice(0, 500) })
        }
        return
      default:
        /* 全量透传其余会话事件(permission/preset、approval/* 等) */
        emit('session-event', { type: ev.type, data: ev.data ?? {} })
        return
    }
  }
  if (n.method === 'session.status') {
    emit('status', { state: n.params.status ?? '' })
  }
}

async function handleRun(params) {
  const {
    reqId, workspace, input, model, maxTokens,
    apiKey, baseUrl, systemPrompt, preset, effort, provider, mtnodeProviders, dshHome,
    permissionPreset,
  } = params
  const emit = (type, data) => out({ event: { reqId, type, data } })
  let runKey = ''
  try {
    if (!input || typeof input !== 'string' || !input.trim()) {
      emit('error', { message: '任务内容为空' })
      emit('done', { finalResponse: '' })
      return
    }
    const settings = applySettings(dshHome, effort, mtnodeProviders, permissionPreset)
    const cordisChanged = applyCordisPreset(permissionPreset)
    /* 设置文档热重载窗口:变更后稍候,确保首请求读到新档位 */
    if (settings.changed || cordisChanged) await new Promise((r) => setTimeout(r, 450))
    /* 目录同源服务商(如 opencode-go)映射回目录路由名,与 settings 注册一致 */
    const route = routeOfProvider(provider, Array.isArray(mtnodeProviders) ? mtnodeProviders : [])
    const presetText = PRESETS[preset] || PRESETS.standard
    const sys = [presetText, systemPrompt]
      .filter((s) => s && String(s).trim())
      .join('\n\n')
    const prompt = sys
      ? `【系统设定】\n${sys}\n\n【内容】\n${input}`
      : input
    /* 携带图像:把图像写入附件对象库,任务消息 = 文本块 + image 内容块 */
    const blocks = [{ type: 'text', text: prompt }]
    if (params.images && params.images.length) {
      const imgBlocks = await attachImages(dshHome || process.env.DSH_HOME || '', params.images)
      blocks.push(...imgBlocks)
    }
    const rt = await getRuntime(
      workspace, model, maxTokens, route, apiKey, baseUrl, dshHome, settings.envPatch, effort,
    )
    runKey = rt.key
    keyToReqId.set(runKey, reqId)
    const harness = await rt.harness
    emit('status', { state: 'running' })
    /* 运行统计:与 dsh 客户端一致的信息表达(轮/步/时间/token/子代理/后台任务) */
    const stats = {
      turns: 0, steps: 0, llmMs: 0, toolMs: 0, firstTokenMs: [],
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0,
      subagents: 0, jobs: 0, tools: [], contextWindow: 0,
    }
    let stepStart = 0
    let firstSeen = false
    let toolStart = 0
    const result = await harness.run(blocks, {
      onNotification: (n) => {
        mapNotification(n, emit)
        if (n.method !== 'session.event' || !n.params || !n.params.event) return
        const ev = n.params.event
        const t = ev.time || Date.now()
        const d = ev.data
        switch (ev.type) {
          case 'turn/start':
            stats.turns++
            break
          case 'step/start':
            stats.steps++
            stepStart = t
            firstSeen = false
            break
          case 'assistant/chunk': {
            const c = d && d.chunk
            if (!c) break
            if (!firstSeen && (c.type === 'reasoning-delta' || c.type === 'text-delta') && stepStart) {
              stats.firstTokenMs.push(t - stepStart)
              firstSeen = true
            }
            if (c.type === 'usage' && c.usage) {
              stats.inputTokens += Number(c.usage.inputTokens) || 0
              stats.outputTokens += Number(c.usage.outputTokens) || 0
              stats.cacheReadTokens += Number(c.usage.cacheReadTokens) || 0
              stats.reasoningTokens += Number(c.usage.reasoningTokens) || 0
              if (stepStart) stats.llmMs += t - stepStart
              stepStart = 0
            }
            break
          }
          case 'tool/call': {
            const name = (d && (d.name || d.tool)) || ''
            stats.tools.push({ name, at: t })
            toolStart = t
            break
          }
          case 'tool/result': {
            if (toolStart) stats.toolMs += t - toolStart
            toolStart = 0
            break
          }
          case 'subagent.started':
            stats.subagents++
            break
          case 'request/context':
            if (d && d.contextWindow) stats.contextWindow = Number(d.contextWindow) || 0
            break
          default:
            if (ev.type.startsWith('job/') && ev.type.endsWith('started')) stats.jobs++
        }
      },
    })
    const ft = stats.firstTokenMs
    emit('done', {
      finalResponse: result.finalResponse,
      metrics: {
        turns: stats.turns,
        steps: stats.steps,
        llmMs: stats.llmMs,
        toolMs: stats.toolMs,
        firstTokenAvgMs: ft.length ? ft.reduce((a, b) => a + b, 0) / ft.length : 0,
        tokPerSec: stats.llmMs > 0 ? stats.outputTokens / (stats.llmMs / 1000) : 0,
        cacheHitPct:
          stats.cacheReadTokens + stats.inputTokens > 0
            ? (stats.cacheReadTokens / (stats.cacheReadTokens + stats.inputTokens)) * 100
            : 0,
        inputTokens: stats.inputTokens,
        outputTokens: stats.outputTokens,
        reasoningTokens: stats.reasoningTokens,
        subagents: stats.subagents,
        jobs: stats.jobs,
        tools: stats.tools,
        contextWindow: stats.contextWindow,
      },
    })
  } catch (err) {
    emit('error', { message: String((err && err.message) || err).slice(0, 800) })
    emit('done', { finalResponse: '' })
  } finally {
    if (runKey) {
      keyToReqId.delete(runKey)
      abortBridgePending(runKey)
    }
  }
}

async function closeAllRuntimes() {
  const jobs = []
  for (const [k, v] of runtimes) {
    runtimes.delete(k)
    closeBridge(k)
    jobs.push(v.harness.then((h) => h.close()).catch(() => {}))
  }
  await Promise.all(jobs)
}

/* 思考强度:写入运行时 settings 文档(llm-deepseek 段),每请求热重载 */
const EFFORTS = ['high', 'max']

/* 删除 settings.yaml 中的整段顶层键(含其全部缩进子行),保留其余内容 */
function stripYamlSection(text, key) {
  const out = []
  let skipping = false
  for (const line of text.split('\n')) {
    const head = /^(\s*)\S/.exec(line)
    if (!head) {
      out.push(line)
      continue
    }
    if (!head[1]) {
      skipping = line.split(':')[0].trim() === key
      if (!skipping) out.push(line)
      continue
    }
    if (!skipping) out.push(line)
  }
  return out.join('\n')
}

/* 统一写入 mtnode 管理的 settings 段(llm-deepseek / llm-pi-ai.providers /
   permission.defaultPreset),其余用户内容原样保留;envPatch 始终构建,
   保证同一配置复用同一运行时。 */
const PERMISSION_PRESETS = ['mtnode-unattended', 'read-only', 'workspace-write', 'danger-full-access']
let lastSettingsHome = ''
let lastSettingsHash = ''

/* 目录同源判定:沿用 dsh 的目录注册方案 —— 服务商的 baseURL 与全部模型
   都落在同一 pi-ai 内置目录服务商内时,返回该目录 id(引擎按目录路由名注册,
   llm-pi-ai 自动合并目录里的模型元数据:reasoning / compat(thinkingFormat、
   requiresReasoningContentOnAssistantMessages、thinkingLevelMap)/ 上下文 /
   输出上限 / 成本)。否则返回空串,走通用 mtnode 路由(保持原行为)。 */
function catalogIdOf(p) {
  const base = String(p.baseUrl || '').trim().toLowerCase().replace(/\/+$/, '')
  const ids = new Set((Array.isArray(p.models) ? p.models : []).map((m) => String(m)))
  if (!base || !ids.size) return ''
  let best = ''
  let bestCount = 0
  try {
    for (const prov of getBuiltinProviders()) {
      /* mtnode 的 DeepSeek 走 llm-deepseek 官方路由,目录里的 deepseek 不参与 */
      if (prov === 'deepseek') continue
      let hit = false
      let count = 0
      for (const m of getBuiltinModels(prov)) {
        if (m.api !== 'openai-completions') continue
        const mb = String(m.baseUrl || '').trim().toLowerCase().replace(/\/+$/, '')
        if (mb && mb === base) hit = true
        if (ids.has(m.id)) count++
      }
      /* 命中同一端点,且服务商模型全部是目录模型(模型集为目录子集) */
      if (!hit || count === 0 || count !== ids.size) continue
      if (count > bestCount) {
        best = prov
        bestCount = count
      }
    }
  } catch {
    /* 目录不可用时退回通用路由 */
  }
  return best
}

/* 渲染层下发的 provider 串 → 引擎路由:目录同源服务商映射回目录路由名
   (settings 与握手都按该名注册),其余保持 mtnode_<route> / deepseek-official。 */
function routeOfProvider(provider, list) {
  const raw = typeof provider === 'string' && provider ? provider : 'deepseek-official'
  if (raw === 'deepseek-official') return raw
  for (const p of list || []) {
    if ('mtnode_' + (p.route || 'p') !== raw) continue
    return catalogIdOf(p) || raw
  }
  return raw
}

function applySettings(dshHome, effort, mtnodeProviders, permissionPreset) {
  const home = dshHome || process.env.DSH_HOME || ''
  const list = Array.isArray(mtnodeProviders) ? mtnodeProviders : []
  const envPatch = {}
  list.forEach((p, i) => {
    if (!String(p.baseUrl || '').trim() || !(p.models || []).length) return
    envPatch['MTNODE_KEY_' + (i + 1)] = String(p.apiKey || '')
  })
  if (!home) return { envPatch, changed: false }
  /* Chat Completions 无「关思考」档；旧 none/off/无 → high */
  const raw = String(effort || 'high').toLowerCase()
  const eff = raw === 'none' || raw === '无' || raw === 'off'
    ? 'high'
    : EFFORTS.includes(raw) ? raw : 'high'
  /* 权限预设:dsh permission-presets 的 defaultPreset,热重载后对新会话生效 */
  const perm = PERMISSION_PRESETS.includes(permissionPreset) ? permissionPreset : 'mtnode-unattended'
  const hash = eff + '|' + perm + '|' + JSON.stringify(list)
  if (hash === lastSettingsHash && home === lastSettingsHome) return { envPatch, changed: false }
  try {
    const provLines = []
    list.forEach((p, i) => {
      if (!String(p.baseUrl || '').trim() || !(p.models || []).length) return
      const cat = catalogIdOf(p)
      const route = cat || 'mtnode_' + (p.route || 'p' + (i + 1))
      provLines.push('    ' + route + ':')
      provLines.push('      apiKeyEnv: MTNODE_KEY_' + (i + 1))
      /* baseURL 无凭据间接层:直接写 URL(非机密),密钥仅经 env 引用 */
      provLines.push('      baseURL: ' + String(p.baseUrl).trim())
      /* 目录同源路由不写 api:模型级 api 以目录元数据为准(多协议目录如
         opencode-go 同时含 openai-completions 与 anthropic-messages);
         通用路由保留 api 声明(默认 openai-completions) */
      if (!cat) provLines.push('      api: ' + String(p.api || 'openai-completions'))
      provLines.push('      models:')
      for (const m of p.models || []) provLines.push('        - id: ' + m)
    })
    mkdirSync(home, { recursive: true })
    const settingsPath = path.join(home, 'settings.yaml')
    let rest = existsSync(settingsPath) ? readFileSync(settingsPath, 'utf8') : ''
    rest = stripYamlSection(rest, 'llm-deepseek')
    rest = stripYamlSection(rest, 'llm-pi-ai')
    rest = stripYamlSection(rest, 'permission')
    const parts = ['llm-deepseek:\n  reasoningEffort: ' + eff]
    if (list.length) parts.push('llm-pi-ai:\n  providers:\n' + provLines.join('\n'))
    parts.push('permission:\n  defaultPreset: ' + perm)
    const txt = parts.join('\n') + (rest.trim() ? '\n' + rest.trim() : '') + '\n'
    writeFileSync(settingsPath, txt, 'utf8')
    lastSettingsHome = home
    lastSettingsHash = hash
    return { envPatch, changed: true }
  } catch {
    /* 尽力而为:写入失败不阻断任务,保留运行时默认档 */
    return { envPatch, changed: false }
  }
}

/* pi-ai 目录(dsh 同源):走 pi-ai 自带的注册表 API(providers/all),
   而非裸读 data/*.json(那是以 api 种类为顶层键的模型表,不是服务商表)。 */
function piAiCatalog() {
  const out = []
  try {
    for (const id of getBuiltinProviders()) {
      /* mtnode 的 DeepSeek 走 llm-deepseek 官方路由,目录里的 deepseek 不重复列出 */
      if (id === 'deepseek') continue
      try {
        const models = getBuiltinModels(id).map((m) => ({
          id: m.id,
          name: m.name || m.id,
          contextWindow: Number(m.contextWindow) || 0,
          maxTokens: Number(m.maxTokens) || 0,
          api: m.api || '',
          baseUrl: m.baseUrl || '',
          input: Array.isArray(m.input) ? m.input : [],
        }))
        if (models.length) out.push({ id, models })
      } catch { /* 动态/未知服务商跳过 */ }
    }
  } catch {
    return out
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : 1))
}

/* 权限预设的 cordis 基础层:rc.6 运行时的 settings 注入回调晚于首个会话创建,
   首个会话固定钉住 cordis 配置里的 defaultPreset;每次运行前把用户选择写进
   cordis.yml,新运行时首个会话即用所选预设(热切换由 settings 段覆盖)。 */
let lastCordisPreset = ''
function applyCordisPreset(preset) {
  const perm = PERMISSION_PRESETS.includes(preset) ? preset : 'mtnode-unattended'
  if (perm === lastCordisPreset) return false
  try {
    const text = readFileSync(CORDIS_PATH, 'utf8')
    const next = text.replace(/^(\s*)defaultPreset:.*$/m, '$1defaultPreset: ' + perm)
    if (next === text) return false
    writeFileSync(CORDIS_PATH, next, 'utf8')
    lastCordisPreset = perm
    return true
  } catch {
    return false
  }
}

/* 中断:关闭该 workspace 的全部运行时,在途 run 以错误收束(handleRun 发 error+done) */
async function cancelRuntime(workspace) {
  let closed = false
  for (const [k, v] of Array.from(runtimes)) {
    if (!k.startsWith(String(workspace || '') + '|')) continue
    runtimes.delete(k)
    closeBridge(k)
    try {
      await v.harness.then((h) => h.close())
    } catch {}
    closed = true
  }
  return closed
}

// ── plugin management ────────────────────────────────────────────────────────

function readRows() {
  // cordis.yml is a plain row list; the user-plugin section lives after the
  // marker comment. Rows before the marker belong to the shipped composition.
  const text = readFileSync(CORDIS_PATH, 'utf8')
  const marker = '# ── user plugins (managed from MTNode settings) ──'
  const idx = text.indexOf(marker)
  const shipped = idx === -1 ? text : text.slice(0, idx)
  const userPart = idx === -1 ? '\n' : text.slice(idx)
  return { shipped, userPart, marker }
}

/* 完整清单:运行时内置插件(组合中的全部行)+ 用户插件(含停用状态与详情) */
function listPlugins() {
  const { shipped, userPart } = readRows()
  const out = []
  for (const block of shipped.split(/\n\s*-\s+id:/).slice(1)) {
    const m = block.match(/^\s*name:\s*'([^']+)'/m)
    if (!m) continue
    const idm = block.match(/^([^\n]*)/)
    out.push({
      id: (idm && idm[1]) || '',
      name: m[1],
      kind: 'runtime',
      detail: block.trim().slice(0, 600),
    })
  }
  const userRows = userPart.split(/\n\s*-\s+id:/)
  for (const block of userRows.slice(1)) {
    const m = block.match(/^\s*name:\s*'([^']+)'/m)
    if (!m) continue
    const idm = block.match(/^([^\n]*)/)
    out.push({
      id: (idm && idm[1]) || '',
      name: m[1],
      kind: 'user',
      disabled: /^\s*disabled:\s*true\s*$/m.test(block),
      detail: block.trim().slice(0, 600),
    })
  }
  return out
}

/* 通用用户行启停:在匹配行所在行块增删 disabled 标记 */
function toggleUserRow(matchText, enabled) {
  const { shipped, userPart } = readRows()
  const lines = userPart.split('\n')
  const out = []
  let inTarget = false
  for (const line of lines) {
    if (/^\s*-\s+id:/.test(line)) inTarget = false
    if (line.includes(matchText)) inTarget = true
    if (/^\s*disabled:\s*true\s*$/.test(line) && inTarget && enabled) continue
    out.push(line)
    if (inTarget && line.includes(matchText) && !enabled) out.push('  disabled: true')
  }
  writeFileSync(CORDIS_PATH, shipped + out.join('\n'), 'utf8')
}

function setPluginEnabled(pkg, enabled) {
  toggleUserRow(`name: '${pkg}'`, enabled)
}

function addPluginRow(pkg) {
  const { shipped, userPart, marker } = readRows()
  const row = `\n- id: user-plugin-${Date.now().toString(36)}\n  name: '${pkg}'\n`
  writeFileSync(CORDIS_PATH, shipped + marker + userPart + row, 'utf8')
}

function removePluginRow(pkg) {
  const { shipped, userPart, marker } = readRows()
  const blocks = userPart.split(/\n- id: /)
  const kept = blocks
    .filter((block) => {
      if (!block.includes(`name: '${pkg}'`)) return true
      return false
    })
    .map((block, i) => (i === 0 ? block : '- id: ' + block))
  writeFileSync(CORDIS_PATH, shipped + marker + kept.join(''), 'utf8')
}

function runPackageManager(args) {
  return new Promise((resolve, reject) => {
    const tries = ['pnpm', 'npm']
    const attempt = (i) => {
      if (i >= tries.length) {
        reject(new Error('需要 pnpm 或 npm(随应用分发的 Node 22+ 环境)才能安装插件'))
        return
      }
      const cmd = tries[i]
      const child = spawn(cmd, args, {
        cwd: GATEWAY_DIR,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
      let errTail = ''
      child.stderr.on('data', (d) => { errTail = (errTail + d.toString()).slice(-800) })
      child.on('error', () => attempt(i + 1))
      child.on('exit', (code) => {
        if (code === 0) resolve()
        else {
          const err = new Error(`${cmd} 退出码 ${code}: ${errTail.slice(-300)}`)
          reject(err)
        }
      })
    }
    attempt(0)
  })
}

async function handlePluginAdd(pkg) {
  if (typeof pkg !== 'string' || !/^(@[a-z0-9-]+\/)?[a-z0-9-]+$/.test(pkg)) {
    return { ok: false, error: '插件名格式无效' }
  }
  await runPackageManager(['add', pkg, '--save-exact'])
  addPluginRow(pkg)
  await closeAllRuntimes()
  return { ok: true, restarted: true, plugins: listPlugins() }
}

async function handlePluginRemove(pkg) {
  await runPackageManager(['remove', pkg])
  removePluginRow(pkg)
  await closeAllRuntimes()
  return { ok: true, restarted: true, plugins: listPlugins() }
}

// ── MCP servers (one @deepseek-ai/dsh-mcp-client row per server) ───────────────

const MCP_PKG = '@deepseek-ai/dsh-mcp-client'

function yamlStr(s) {
  return "'" + String(s).replace(/'/g, "''") + "'"
}

function mcpList() {
  const { userPart } = readRows()
  const out = []
  for (const block of userPart.split(/\n\s*-\s+id:/).slice(1)) {
    if (!block.includes(MCP_PKG)) continue
    const g = (re) => {
      const m = block.match(re)
      return m ? m[1].trim().replace(/^['"]|['"]$/g, '') : ''
    }
    const argsMatch = block.match(/^\s*args:\s*(.+)$/m)
    out.push({
      serverName: g(/^\s*serverName:\s*(.+)$/m),
      transport: g(/^\s*transport:\s*(.+)$/m),
      command: g(/^\s*command:\s*(.+)$/m),
      url: g(/^\s*url:\s*(.+)$/m),
      args: argsMatch ? argsMatch[1].trim() : '',
      disabled: /^\s*disabled:\s*true\s*$/m.test(block),
    })
  }
  return out
}

function mcpAdd(cfg) {
  const { serverName, transport, command, args, url } = cfg
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(String(serverName || ''))) {
    throw new Error('serverName 需为 1-32 位字母/数字/下划线/短横线')
  }
  if (mcpList().some((s) => s.serverName === serverName)) {
    throw new Error('同名 MCP 服务器已存在')
  }
  const lines = [
    `\n- id: user-mcp-${Date.now().toString(36)}`,
    `  name: '${MCP_PKG}'`,
    '  config:',
    `    serverName: ${yamlStr(serverName)}`,
    `    transport: ${yamlStr(transport)}`,
  ]
  if (transport === 'stdio') {
    if (!String(command || '').trim()) throw new Error('stdio 传输需要 command')
    lines.push(`    command: ${yamlStr(command.trim())}`)
    const argList = (Array.isArray(args) ? args : String(args || '').split(/\s+/).filter(Boolean))
      .map(yamlStr)
      .join(', ')
    if (argList) lines.push(`    args: [${argList}]`)
  } else {
    if (!/^https?:\/\//.test(String(url || ''))) throw new Error('HTTP 传输需要 http(s) url')
    lines.push(`    url: ${yamlStr(url)}`)
  }
  const { shipped, userPart, marker } = readRows()
  writeFileSync(CORDIS_PATH, shipped + marker + userPart + lines.join('\n') + '\n', 'utf8')
}

function mcpRemove(serverName) {
  const { shipped, userPart, marker } = readRows()
  const blocks = userPart.split(/\n- id: /)
  const kept = blocks
    .filter((block) => {
      if (block.includes(MCP_PKG) && block.includes(`serverName: ${yamlStr(serverName)}`)) return false
      return true
    })
    .map((block, i) => (i === 0 ? block : '- id: ' + block))
  writeFileSync(CORDIS_PATH, shipped + marker + kept.join(''), 'utf8')
}

function mcpSetEnabled(serverName, enabled) {
  toggleUserRow(`serverName: ${yamlStr(serverName)}`, enabled)
}

// ── protocol loop ────────────────────────────────────────────────────────────

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })

rl.on('line', (line) => {
  const trimmed = line.trim()
  if (!trimmed) return
  let msg
  try { msg = JSON.parse(trimmed) } catch { return }
  if (msg.id === undefined || typeof msg.method !== 'string') return
  const reply = (result, error) => out({ id: msg.id, ok: !error, result, error })
  void (async () => {
    try {
      switch (msg.method) {
        case 'status':
          reply({
            gateway: GATEWAY_VERSION,
            node: process.version,
            runtimes: runtimes.size,
            runtimeBin: RUNTIME_BIN,
            configPath: CORDIS_PATH,
          })
          break
        case 'providerCatalog':
          reply({
            deepseek: [
              { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', contextWindow: 1000000, api: 'openai-completions', baseUrl: 'https://api.deepseek.com' },
              { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', contextWindow: 1000000, api: 'openai-completions', baseUrl: 'https://api.deepseek.com' },
            ],
            piai: piAiCatalog(),
          })
          break
        case 'run':
          reply({ accepted: true })
          await handleRun(msg.params ?? {})
          break
        case 'pluginList':
          reply({ plugins: listPlugins() })
          break
        case 'pluginAdd':
          reply(await handlePluginAdd((msg.params ?? {}).pkg))
          break
        case 'pluginRemove':
          reply(await handlePluginRemove((msg.params ?? {}).pkg))
          break
        case 'pluginEnable':
        case 'pluginDisable': {
          const pkg = (msg.params ?? {}).pkg
          if (typeof pkg !== 'string' || !pkg) {
            reply(undefined, '缺少插件名')
            break
          }
          setPluginEnabled(pkg, msg.method === 'pluginEnable')
          await closeAllRuntimes()
          reply({ ok: true, restarted: true, plugins: listPlugins() })
          break
        }
        case 'mcpList':
          reply({ servers: mcpList() })
          break
        case 'mcpAdd': {
          mcpAdd(msg.params ?? {})
          await closeAllRuntimes()
          reply({ ok: true, restarted: true, servers: mcpList() })
          break
        }
        case 'mcpRemove': {
          const serverName = (msg.params ?? {}).serverName
          if (typeof serverName !== 'string' || !serverName) {
            reply(undefined, '缺少 serverName')
            break
          }
          mcpRemove(serverName)
          await closeAllRuntimes()
          reply({ ok: true, restarted: true, servers: mcpList() })
          break
        }
        case 'mcpSetEnabled': {
          const serverName = (msg.params ?? {}).serverName
          if (typeof serverName !== 'string' || !serverName) {
            reply(undefined, '缺少 serverName')
            break
          }
          mcpSetEnabled(serverName, !!(msg.params ?? {}).enabled)
          await closeAllRuntimes()
          reply({ ok: true, restarted: true, servers: mcpList() })
          break
        }
        case 'cancel': {
          const p = msg.params ?? {}
          const closed = await cancelRuntime(p.workspace)
          reply({ ok: true, closed })
          break
        }
        case 'interact': {
          /* 渲染层回答提问 / 审批:按交互 id 路由回对应运行时的桥接连接 */
          const p = msg.params ?? {}
          const pending = bridgePending.get(p.id)
          if (!pending) {
            reply(undefined, '交互已失效(任务已结束或被取消)')
            break
          }
          bridgePending.delete(p.id)
          if (p.kind === 'question') {
            if (!Array.isArray(p.answers)) {
              reply(undefined, '缺少 answers')
              break
            }
            try { pending.socket.write(JSON.stringify({ t: 'answer', id: p.id, answers: p.answers }) + '\n') } catch {}
          } else if (p.kind === 'approval') {
            const ok = ['allowed-once', 'rejected'].includes(p.outcome)
            if (!ok) {
              reply(undefined, 'outcome 非法')
              break
            }
            try { pending.socket.write(JSON.stringify({ t: 'outcome', id: p.id, outcome: p.outcome }) + '\n') } catch {}
          } else if (p.kind === 'canvas') {
            const err = p.error != null ? String(p.error) : ''
            try {
              pending.socket.write(JSON.stringify({
                t: 'canvas-result',
                id: p.id,
                ok: !err,
                result: p.result == null ? null : p.result,
                ...(err ? { error: err } : {}),
              }) + '\n')
            } catch {}
          } else {
            reply(undefined, 'kind 非法')
            break
          }
          reply({ ok: true })
          break
        }
        case 'shutdown':
          reply({ ok: true })
          await closeAllRuntimes()
          setTimeout(() => process.exit(0), 100)
          break
        default:
          reply(undefined, `unknown method: ${msg.method}`)
      }
    } catch (err) {
      reply(undefined, String((err && err.message) || err))
    }
  })()
})

process.stdin.on('end', () => {
  void closeAllRuntimes().then(() => process.exit(0))
})
process.on('SIGTERM', () => {
  void closeAllRuntimes().then(() => process.exit(0))
})
