#!/usr/bin/env node
/**
 * audit-token-usage.mjs —— MTNode 会话 Token 开销审计（诊断脚本，只读）
 *
 * 用途：量化「一次会话的 token 到底花在哪」，用于验证降开销改动的效果（工具负载瘦身、
 * 按运行裁剪工具、返回预算收紧、历史思考回放裁剪）。数据源是本机 dsh 运行时落盘的会话日志：
 *   <userData>/dsh-home/sessions/<projectKey>/<sessionId>/session.jsonl[.zstd]
 * 布局与压缩口径见 dsh/gateway/gateway.mjs 的 resumeSessionExists 注释与 dsh/DESIGN.md。
 *
 * 读法（口径）：
 *   - 固定前缀 = request/header（每会话 1~2 条，reason=initial|change）的 system + tools；
 *     tools 逐个给字符数，定位「最贵的那本说明书」。
 *   - 每步 prompt = assistant/message.usage 的 inputTokens + cacheReadTokens (+ cacheWriteTokens)，
 *     即真实计费面；步间差分 = 这一步往历史里新塞了多少。
 *   - 工具返回 = tool/result 文本块字符数（按 tool/call 的 callId→name 归属）；思考量 =
 *     assistant/message 里 reasoning 块字符数 + usage.reasoningTokens。
 *   - 缓存命中率 = ΣcacheRead / Σ(cacheRead + input)。
 *
 * 用法：
 *   node scripts/audit-token-usage.mjs                      最近 14 天、最多 40 个会话
 *   node scripts/audit-token-usage.mjs --project pipeline-console --since 7
 *   node scripts/audit-token-usage.mjs --all --top 15        全量 + top15 排行
 *   node scripts/audit-token-usage.mjs --json                机器可读（供回归脚本 diff）
 *   node scripts/audit-token-usage.mjs --tools               额外打印工具负载明细
 *   node scripts/audit-token-usage.mjs --home <dsh-home 路径>
 *
 * 零依赖（只用 node 内置 fs/path/zlib）；zstd 需要 Node ≥ 23.8（本项目网关要求 ≥22.19，
 * 开发机与打包环境用 Node 24）。不写任何文件、不改任何会话。
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import zlib from 'node:zlib'

/* ------------------------------------------------------------------ 参数 */

function parseArgs(argv) {
  const out = {
    home: '', project: '', sinceDays: 14, limit: 40, top: 10,
    json: false, tools: false, all: false, quiet: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => argv[++i]
    if (a === '--home') out.home = next() || ''
    else if (a === '--sessions') out.home = path.join(next() || '', '..') /* 直接给 sessions 目录也认 */
    else if (a === '--project') out.project = next() || ''
    else if (a === '--since') out.sinceDays = Number(next()) || 14
    else if (a === '--limit') out.limit = Number(next()) || 0
    else if (a === '--top') out.top = Number(next()) || 10
    else if (a === '--json') out.json = true
    else if (a === '--tools') out.tools = true
    else if (a === '--all') { out.all = true; out.limit = 0; out.sinceDays = 0 }
    else if (a === '--quiet') out.quiet = true
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0) }
    else { console.error(`未知参数: ${a}（--help 看用法）`); process.exit(2) }
  }
  return out
}

function printHelp() {
  const src = readFileSync(new URL(import.meta.url), 'utf8')
  const m = src.match(/\/\*\*([\s\S]*?)\n \*\//)
  console.log((m ? m[1] : '').replace(/^ \*?/gm, '').trim())
}

/* ------------------------------------------------------- dsh-home 定位 */

function defaultHomeCandidates() {
  const c = []
  if (process.env.MTNODE_DSH_HOME) c.push(process.env.MTNODE_DSH_HOME)
  if (process.env.DSH_HOME) c.push(process.env.DSH_HOME)
  const appData = process.env.APPDATA || (os.platform() === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support')
    : path.join(os.homedir(), '.config'))
  /* Electron userData = %APPDATA%\pipeline-console，网关再落 pipeline-console/dsh-home */
  c.push(path.join(appData, 'pipeline-console', 'pipeline-console', 'dsh-home'))
  c.push(path.join(appData, 'pipeline-console', 'dsh-home'))
  return c
}

function resolveSessionsRoot(opts) {
  /* 显式给了 --home 就不再兜底：路径写错要报错，不能悄悄回落默认目录（读数会张冠李戴） */
  if (opts.home) {
    const r = path.basename(opts.home) === 'sessions' ? opts.home : path.join(opts.home, 'sessions')
    if (!existsSync(r)) throw new Error(`--home 指向的目录不存在：${r}`)
    return r
  }
  const roots = defaultHomeCandidates().map((h) => path.join(h, 'sessions'))
  for (const r of roots) { try { if (statSync(r).isDirectory()) return r } catch { /* 试下一个 */ } }
  throw new Error(`找不到 dsh 会话目录，试过:\n  ${roots.join('\n  ')}\n用 --home <dsh-home> 指定。`)
}

/* --------------------------------------------------------- zstd 会话日志 */

const ZSTD_MAGIC = 4247762216 /* 28 B5 2F FD */
const FLUSH = zlib.constants.ZSTD_e_flush

/** 只靠帧头/块头定位完整帧（不解压），尾部撕裂帧单独交给解码器兜底。 */
function scanZstdFrames(buf) {
  const frames = []
  let o = 0
  let torn = 0
  while (o + 4 <= buf.length) {
    const start = o
    if (buf.readUInt32LE(o) !== ZSTD_MAGIC) { torn = buf.length; break }
    o += 4
    const d = buf.readUInt8(o); o += 1
    if ((d & 24) !== 0) { torn = buf.length; break } /* reserved bits */
    const single = (d & 32) !== 0
    const checksum = (d & 4) !== 0
    const dictFlag = d & 3
    const sizeFlag = d >>> 6
    const dictBytes = dictFlag === 3 ? 4 : dictFlag
    const contentBytes = sizeFlag === 0 ? (single ? 1 : 0) : 1 << sizeFlag
    o += (single ? 0 : 1) + dictBytes + contentBytes
    let complete = o <= buf.length
    while (complete) {
      if (buf.length - o < 3) { complete = false; break }
      const bh = buf.readUIntLE(o, 3); o += 3
      const last = (bh & 1) !== 0
      const type = (bh >>> 1) & 3
      const size = bh >>> 3
      if (type === 3) { complete = false; o = buf.length; break }
      o += type === 1 ? 1 : size
      if (buf.length - o < 0) { complete = false; break }
      if (last) break
    }
    if (!complete) { torn = start; break }
    if (checksum) {
      if (buf.length - o < 4) { torn = start; break }
      o += 4
    }
    frames.push({ start, end: o })
  }
  return { frames, torn }
}

function decodeFrame(bytes) {
  try { return zlib.zstdDecompressSync(bytes).toString('utf8') } catch {
    /* 最后一帧可能只写了一半：用 flush 模式把已到的部分吐出来 */
    try { return zlib.zstdDecompressSync(bytes, { finishFlush: FLUSH }).toString('utf8') } catch { return '' }
  }
}

/** 一个会话文件 → 逐行 JSON 记录（解析失败的行静默跳过）。 */
function readSessionRecords(file) {
  const buf = readFileSync(file)
  const plain = path.basename(file) === 'session.jsonl'
  const chunks = []
  let torn = 0
  if (plain) chunks.push(buf.toString('utf8'))
  else {
    if (typeof zlib.zstdDecompressSync !== 'function') {
      throw new Error('当前 Node 无 zlib.zstdDecompressSync：请用 Node ≥ 23.8 运行本脚本（或只看 session.jsonl 明文会话）')
    }
    const { frames, torn: t } = scanZstdFrames(buf)
    torn = t
    for (const f of frames) chunks.push(decodeFrame(buf.subarray(f.start, f.end)))
  }
  const recs = []
  for (const c of chunks) {
    for (const line of c.split('\n')) {
      if (!line) continue
      try { recs.push(JSON.parse(line)) } catch { /* 半行 */ }
    }
  }
  recs.tornBytes = torn ? 1 : 0
  return recs
}

/* ------------------------------------------------------------ 度量辅助 */

/** 消息块的文本字符数（image 记占位，不计体积）。 */
function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let s = ''
  for (const b of content) {
    if (!b || typeof b !== 'object') continue
    if (b.type === 'text' || b.type === 'reasoning') s += String(b.text || '')
    else if (b.type === 'tool-result') s += textOf(b.content)
    else if (b.type === 'image') s += '[image]'
    else if (b.type === 'tool-call') s += String(b.arguments || '')
  }
  return s
}

function promptTokens(u) {
  return (u.inputTokens || 0) + (u.cacheReadTokens || 0) + (u.cacheWriteTokens || 0)
}

const num = (n) => (Number.isFinite(n) ? n : 0)
const kfmt = (n) => {
  const v = num(n)
  if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(2) + 'M'
  if (Math.abs(v) >= 1e3) return (v / 1e3).toFixed(1) + 'K'
  return String(v)
}
/* 中英混排的经验密度：用于把「固定前缀字符数」折成可比较的量级（真实 token 以 usage 为准）。 */
const CHARS_PER_TOKEN = 2.8
const pad = (s, w) => {
  const str = String(s)
  let wide = 0
  for (const ch of str) wide += ch.codePointAt(0) > 0x2e80 ? 2 : 1
  return str + ' '.repeat(Math.max(1, w - wide))
}

/* ------------------------------------------------------------ 单会话 */

function analyzeSession(file, projectKey, sessionId) {
  const recs = readSessionRecords(file)
  const st = statSync(file)
  const s = {
    project: projectKey, id: sessionId, file, mtimeMs: st.mtimeMs, bytes: st.size,
    cwd: '', model: '', provider: '', turns: 0, steps: 0,
    systemChars: 0, toolsChars: 0, toolCount: 0, toolPayload: new Map(), headerChanges: 0,
    promptTokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    reasoningTokens: 0, firstPromptTokens: 0, lastPromptTokens: 0, maxStepDelta: 0, maxStepDeltaAt: 0,
    stepSeries: [],
    resultChars: 0, resultCount: 0, resultByTool: new Map(), argChars: 0,
    thinkingChars: 0, thinkingCount: 0,
    pruneCount: 0, prunedTokens: 0, compactionCount: 0, retryCount: 0, userMsgChars: 0,
    torn: recs.tornBytes,
  }
  const callName = new Map()
  let prevPrompt = 0

  for (const r of recs) {
    const d = r.data || {}
    switch (r.type) {
      case 'session':
        s.cwd = String(d.cwd || '')
        break
      case 'request/header': {
        const h = d.header || {}
        s.headerChanges++
        s.systemChars = String(h.system || '').length
        const tools = Array.isArray(h.tools) ? h.tools : []
        s.toolCount = tools.length
        let total = 0
        for (const t of tools) {
          const chars = JSON.stringify(t).length
          total += chars
          const name = String(t.name || '(anon)')
          const desc = String(t.description || '').length
          const params = JSON.stringify(t.parameters || {}).length
          /* 多条 header 时按名字取最大值（变化后的那份才是真源，保守取上限） */
          const prev = s.toolPayload.get(name)
          const cur = { chars, desc, params }
          if (!prev || cur.chars > prev.chars) s.toolPayload.set(name, cur)
        }
        s.toolsChars = Math.max(s.toolsChars, total)
        break
      }
      case 'request/context':
        s.provider = String(d.provider || s.provider)
        s.model = String(d.model || s.model)
        break
      case 'turn/start': s.turns++; break
      case 'step/start': s.steps++; break
      case 'user/message':
        s.userMsgChars += textOf(d.content).length
        break
      case 'tool/call': {
        const name = String(d.name || '(unknown)')
        if (d.callId) callName.set(d.callId, name)
        s.argChars += String(d.arguments || '').length
        break
      }
      case 'tool-call-chunks': {
        if (d.id && !callName.has(d.id)) callName.set(d.id, String(d.name || '(unknown)'))
        break
      }
      case 'tool/result': {
        const name = callName.get(d.message?.source?.callId) || '(unmapped)'
        const chars = textOf(d.message?.content).length
        s.resultCount++
        s.resultChars += chars
        const e = s.resultByTool.get(name) || { count: 0, chars: 0, max: 0 }
        e.count++; e.chars += chars; e.max = Math.max(e.max, chars)
        s.resultByTool.set(name, e)
        break
      }
      case 'assistant/message': {
        const msg = d.message || {}
        let th = 0
        for (const b of Array.isArray(msg.content) ? msg.content : []) {
          if (b && b.type === 'reasoning') th += String(b.text || '').length
        }
        if (th) { s.thinkingChars += th; s.thinkingCount++ }
        const u = d.usage || {}
        const p = promptTokens(u)
        s.promptTokens += p
        s.inputTokens += num(u.inputTokens)
        s.outputTokens += num(u.outputTokens)
        s.cacheReadTokens += num(u.cacheReadTokens)
        s.cacheWriteTokens += num(u.cacheWriteTokens)
        s.reasoningTokens += num(u.reasoningTokens)
        if (!s.firstPromptTokens) s.firstPromptTokens = p
        s.lastPromptTokens = p
        const delta = prevPrompt ? p - prevPrompt : 0
        if (delta > s.maxStepDelta) { s.maxStepDelta = delta; s.maxStepDeltaAt = d.step }
        prevPrompt = p
        s.stepSeries.push({ turn: d.turn, step: d.step, prompt: p, delta, thinking: th })
        break
      }
      case 'compaction/prune': s.pruneCount++; s.prunedTokens += num(d.shadowedTokenCount); break
      case 'compaction/start': s.compactionCount++; break
      case 'llm/retry': case 'llm/retry-started': s.retryCount++; break
      default: break
    }
  }
  s.cacheHitRate = (s.cacheReadTokens + s.inputTokens) ? s.cacheReadTokens / (s.cacheReadTokens + s.inputTokens) : 0
  s.prefixChars = s.systemChars + s.toolsChars
  s.prefixTokenEstimate = Math.round(s.prefixChars / CHARS_PER_TOKEN)
  s.avgPrompt = s.steps ? Math.round(s.promptTokens / s.steps) : 0
  s.wastedPrefixTokens = s.firstPromptTokens ? (s.promptTokens - s.firstPromptTokens) : 0
  return s
}

/* ------------------------------------------------------- 会话清单 */

function collectSessions(root, opts) {
  const list = []
  const cutoff = opts.sinceDays > 0 ? Date.now() - opts.sinceDays * 86400e3 : 0
  for (const proj of readdirSync(root)) {
    if (opts.project && !proj.toLowerCase().includes(opts.project.toLowerCase())) continue
    const pd = path.join(root, proj)
    let dirs = []
    try { dirs = readdirSync(pd, { withFileTypes: true }) } catch { continue }
    for (const ent of dirs) {
      if (!ent.isDirectory()) continue
      let file = ''
      for (const name of ['session.jsonl.zstd', 'session.jsonl']) {
        const f = path.join(pd, ent.name, name)
        try { if (statSync(f).isFile()) { file = f; break } } catch { /* 下一个 */ }
      }
      if (!file) continue
      const st = statSync(file)
      if (cutoff && st.mtimeMs < cutoff) continue
      list.push({ project: proj, id: ent.name, file, mtimeMs: st.mtimeMs, bytes: st.size })
    }
  }
  list.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return opts.limit > 0 ? list.slice(0, opts.limit) : list
}

/* ------------------------------------------------------------ 汇总 */

function aggregate(rows) {
  const a = {
    sessions: rows.length, steps: 0, turns: 0,
    promptTokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    reasoningTokens: 0, thinkingChars: 0, resultChars: 0, resultCount: 0, argChars: 0,
    userMsgChars: 0, pruneCount: 0, prunedTokens: 0, compactionCount: 0, retryCount: 0,
    firstPromptSum: 0, firstPromptMax: 0, prefixSum: 0, prefixMax: 0, toolCountMax: 0,
    toolsCharsSum: 0, toolsCharsMax: 0, systemCharsMax: 0,
    byToolResult: new Map(), byToolPayload: new Map(), byStepDelta: [], byModel: new Map(),
  }
  for (const s of rows) {
    a.steps += s.steps; a.turns += s.turns
    a.promptTokens += s.promptTokens; a.inputTokens += s.inputTokens
    a.outputTokens += s.outputTokens; a.cacheReadTokens += s.cacheReadTokens
    a.cacheWriteTokens += s.cacheWriteTokens; a.reasoningTokens += s.reasoningTokens
    a.thinkingChars += s.thinkingChars; a.resultChars += s.resultChars
    a.resultCount += s.resultCount; a.argChars += s.argChars; a.userMsgChars += s.userMsgChars
    a.pruneCount += s.pruneCount; a.prunedTokens += s.prunedTokens
    a.compactionCount += s.compactionCount; a.retryCount += s.retryCount
    if (s.firstPromptTokens) { a.firstPromptSum += s.firstPromptTokens; a.firstPromptMax = Math.max(a.firstPromptMax, s.firstPromptTokens) }
    a.prefixSum += s.prefixChars; a.prefixMax = Math.max(a.prefixMax, s.prefixChars)
    a.toolsCharsSum += s.toolsChars; a.toolsCharsMax = Math.max(a.toolsCharsMax, s.toolsChars)
    a.systemCharsMax = Math.max(a.systemCharsMax, s.systemChars)
    a.toolCountMax = Math.max(a.toolCountMax, s.toolCount)
    for (const [k, v] of s.resultByTool) {
      const e = a.byToolResult.get(k) || { count: 0, chars: 0, max: 0 }
      e.count += v.count; e.chars += v.chars; e.max = Math.max(e.max, v.max)
      a.byToolResult.set(k, e)
    }
    for (const [k, v] of s.toolPayload) {
      const e = a.byToolPayload.get(k) || { occurrences: 0, chars: 0, desc: 0, params: 0 }
      e.occurrences++; e.chars = Math.max(e.chars, v.chars)
      e.desc = Math.max(e.desc, v.desc); e.params = Math.max(e.params, v.params)
      a.byToolPayload.set(k, e)
    }
    for (const p of s.stepSeries) if (p.delta > 0) a.byStepDelta.push({ session: s.id, turn: p.turn, step: p.step, delta: p.delta, thinking: p.thinking })
    const m = a.byModel.get(s.model || '(unknown)') || { sessions: 0, steps: 0, promptTokens: 0, thinkingChars: 0 }
    m.sessions++; m.steps += s.steps; m.promptTokens += s.promptTokens; m.thinkingChars += s.thinkingChars
    a.byModel.set(s.model || '(unknown)', m)
  }
  a.cacheHitRate = (a.cacheReadTokens + a.inputTokens) ? a.cacheReadTokens / (a.cacheReadTokens + a.inputTokens) : 0
  a.avgFirstPrompt = rows.length ? Math.round(a.firstPromptSum / Math.max(1, rows.filter((r) => r.firstPromptTokens).length)) : 0
  a.avgPrefixChars = rows.length ? Math.round(a.prefixSum / rows.length) : 0
  return a
}

/* ------------------------------------------------------------ 打印 */

function table(title, header, rows, opts = {}) {
  if (!rows.length) return
  console.log('\n' + title)
  const widths = header.map((h, i) => Math.max(String(h).length, ...rows.map((r) => String(r[i] ?? '').length)))
  const line = (cells, dash) => console.log(cells.map((c, i) => (dash ? '-'.repeat(widths[i] + 2) : pad(c, widths[i] + 2))).join(''))
  line(header)
  line(widths.map((w) => '-'.repeat(w)))
  for (const r of rows) line(r)
  if (opts.note) console.log(opts.note)
}

function printReport(rows, agg, opts, root) {
  if (opts.json) {
    const ser = (v) => (v instanceof Map ? Object.fromEntries(v) : v)
    console.log(JSON.stringify({
      sessionsRoot: root,
      charsPerTokenAssumption: CHARS_PER_TOKEN,
      aggregate: { ...Object.fromEntries(Object.entries(agg).filter(([, v]) => !(v instanceof Map))),
        byToolResult: Object.fromEntries(agg.byToolResult), byToolPayload: Object.fromEntries(agg.byToolPayload), byModel: Object.fromEntries(agg.byModel) },
      sessions: rows.map((s) => ({ ...s, stepSeries: undefined, thinkingByStep: undefined, resultByTool: ser(s.resultByTool), toolPayload: ser(s.toolPayload), stepSeriesLen: s.stepSeries.length })),
      worstSteps: agg.byStepDelta.sort((a, b) => b.delta - a.delta).slice(0, opts.top),
    }, null, 2))
    return
  }

  console.log(`会话日志: ${root}`)
  console.log(`纳入会话: ${rows.length}（--since ${opts.all ? 'all' : opts.sinceDays + ' 天'} / --limit ${opts.all ? 'all' : opts.limit}${opts.project ? ' / project~' + opts.project : ''}）`)

  /* 1. 固定前缀：每步都重付的「说明书」 */
  console.log('\n■ 固定前缀（system + tools，每一步都要重发一次）')
  console.log(`  工具数最多 ${agg.toolCountMax} 个 · system 最大 ${kfmt(agg.systemCharsMax)} 字符 · tools 最大 ${kfmt(agg.toolsCharsMax)} 字符`)
  console.log(`  前缀平均 ${kfmt(agg.avgPrefixChars)} 字符 ≈ ${kfmt(Math.round(agg.avgPrefixChars / CHARS_PER_TOKEN))} token/步（按 ${CHARS_PER_TOKEN} 字符/token 估算）`)
  console.log(`  实测第一步 prompt：平均 ${kfmt(agg.avgFirstPrompt)} · 最大 ${kfmt(agg.firstPromptMax)} token`)

  /* 2. 计费面总览 */
  console.log('\n■ 计费面总览（Σ 全部会话全部步）')
  console.log(`  prompt 总量 ${kfmt(agg.promptTokens)} token = 非缓存输入 ${kfmt(agg.inputTokens)} + 缓存读 ${kfmt(agg.cacheReadTokens)}（+ 缓存写 ${kfmt(agg.cacheWriteTokens)}）`)
  console.log(`  缓存命中率 ${(agg.cacheHitRate * 100).toFixed(1)}% · 输出 ${kfmt(agg.outputTokens)}（其中思考 ${kfmt(agg.reasoningTokens)}）`)
  console.log(`  步数 ${agg.steps} · 轮数 ${agg.turns} · 平均每步 prompt ${kfmt(agg.promptTokens / Math.max(1, agg.steps))} token`)
  console.log(`  历史增长的累计重放量 Σ(每步 prompt − 首步) = ${kfmt(rows.reduce((n, s) => n + s.wastedPrefixTokens, 0))} token（步数越多、历史越长，这项越肥）`)
  console.log(`  工具返回 ${agg.resultCount} 次共 ${kfmt(agg.resultChars)} 字符（均值 ${kfmt(Math.round(agg.resultChars / Math.max(1, agg.resultCount)))}）· 工具入参 ${kfmt(agg.argChars)} 字符 · 用户消息 ${kfmt(agg.userMsgChars)} 字符`)
  console.log(`  思考原文 ${kfmt(agg.thinkingChars)} 字符 · prune ${agg.pruneCount} 次（省 ${kfmt(agg.prunedTokens)} token）· 压缩 ${agg.compactionCount} 次 · 限流重试 ${agg.retryCount} 次`)

  /* 3. 最贵的说明书 */
  const payload = [...agg.byToolPayload.entries()]
    .sort((a, b) => b[1].chars - a[1].chars)
    .slice(0, opts.top)
  table('\n■ Top 工具负载（单会话内 JSON 字符数取最大值；× 出现于几个会话）',
    ['工具', '字符', '描述', '参数表', '占tools', '会话数'],
    payload.map(([name, v]) => [name, kfmt(v.chars), kfmt(v.desc), kfmt(v.params),
      ((v.chars / Math.max(1, agg.toolsCharsMax)) * 100).toFixed(1) + '%', v.occurrences]))

  /* 4. 历史堆积主力 */
  table('\n■ Top 工具返回体积（所有会话合计）',
    ['工具', '次数', '总字符', '均值', '单次最大'],
    [...agg.byToolResult.entries()].sort((a, b) => b[1].chars - a[1].chars).slice(0, opts.top)
      .map(([name, v]) => [name, v.count, kfmt(v.chars), kfmt(Math.round(v.chars / v.count)), kfmt(v.max)]))

  /* 5. 单步暴涨 */
  table('\n■ Top 单步 prompt 增量（这一步新进入历史的量）',
    ['会话', 'turn:step', 'Δtoken', '该步思考字符'],
    agg.byStepDelta.sort((a, b) => b.delta - a.delta).slice(0, opts.top)
      .map((x) => [x.session.replace(/^session-/, '').slice(0, 10), `${x.turn}:${x.step}`, kfmt(x.delta), kfmt(x.thinking)]))

  /* 6. 会话排行 */
  table('\n■ Top 会话（按 prompt 总量）',
    ['会话', 'project', '步', 'prompt', '命中率', '首步', '均/步', '最大Δ步', '思考字符', '返回字符', 'prune'],
    [...rows].sort((a, b) => b.promptTokens - a.promptTokens).slice(0, opts.top).map((s) => [
      s.id.replace(/^session-/, '').slice(0, 10), s.project.replace(/^--|--$/g, '').slice(0, 24),
      s.steps, kfmt(s.promptTokens), (s.cacheHitRate * 100).toFixed(0) + '%', kfmt(s.firstPromptTokens),
      kfmt(s.avgPrompt), kfmt(s.maxStepDelta), kfmt(s.thinkingChars), kfmt(s.resultChars), s.pruneCount,
    ]))

  /* 7. 按模型 */
  table('\n■ 按模型',
    ['模型', '会话', '步', 'prompt 总量', '每步均值', '思考字符'],
    [...agg.byModel.entries()].sort((a, b) => b[1].promptTokens - a[1].promptTokens)
      .map(([m, v]) => [m, v.sessions, v.steps, kfmt(v.promptTokens), kfmt(Math.round(v.promptTokens / Math.max(1, v.steps))), kfmt(v.thinkingChars)]))

  if (opts.tools) {
    for (const s of [...rows].sort((a, b) => b.promptTokens - a.promptTokens).slice(0, Math.min(3, opts.top))) {
      table(`\n■ 会话 ${s.id} 的工具负载明细（system ${s.systemChars} 字符 · ${s.toolCount} 个工具 ${s.toolsChars} 字符）`,
        ['工具', '字符', '描述', '参数表'],
        [...s.toolPayload.entries()].sort((a, b) => b[1].chars - a[1].chars).map(([n, v]) => [n, v.chars, v.desc, v.params]))
    }
  }

  console.log('\n说明：字符数是「重发负载」的直接代理量（CJK 更贵），真实 token 以 usage 为准；')
  console.log('      固定前缀与工具返回随每一步重发，是优化主目标。估算密度按 ' + CHARS_PER_TOKEN + ' 字符/token。')
}

/* ------------------------------------------------------------- 入口 */

function main() {
  const opts = parseArgs(process.argv.slice(2))
  let root = ''
  try { root = resolveSessionsRoot(opts) } catch (e) { console.error(e.message); process.exit(2) }
  const found = collectSessions(root, opts)
  if (!found.length) { console.error(`在 ${root} 下没有匹配的会话日志`); process.exit(1) }
  const rows = []
  const failed = []
  for (const f of found) {
    try { rows.push(analyzeSession(f.file, f.project, f.id)) } catch (e) { failed.push(`${f.id}: ${e.message}`) }
  }
  if (!opts.quiet && failed.length) console.error(`跳过 ${failed.length} 个读不动的会话：\n  ${failed.slice(0, 5).join('\n  ')}`)
  const agg = aggregate(rows)
  printReport(rows, agg, opts, root)
  if (!rows.length) process.exit(1)
}

main()
