/* 探针（手动跑 · 只读出网）：token 统计的真跑复核。
 *
 * 为什么需要它：0.2 的用量只挂在完整 `assistant/message` 的 `data.usage` 上（不再发
 * `assistant/chunk`），所以「统计生效」这件事只能在**真运行时**上验：起真网关、发一句
 * 极短请求，看 usage 帧与 done.metrics 里的数字。断言口径见 `test/smoke-usage-accounting.js`
 * 的 [2]（那里只查源码接线，不出网）。
 *
 * 跑法：node test/_probe-gateway-usage.mjs
 * 需要本机 config.json 里有可用的 DeepSeek 服务商密钥（与手工跑一致，不出网则跳过）。
 * 预期输出：USAGE FRAMES ≥ 1 且 done.metrics.inputTokens > 0、contextWindow > 0。
 */
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const cfgPath = path.join(process.env.APPDATA || '', 'pipeline-console', 'pipeline-console', 'config.json')
let key = ''
try {
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
  const prov = (cfg.providers || []).find((p) => p.id === 'deepseek')
  key = String((prov && prov.apiKey) || '').trim()
} catch { /* 读不到就当没有 */ }
if (!key) {
  console.log('跳过：本机 config.json 里没有 deepseek 的 apiKey（本探针要真连一次官方 API）')
  process.exit(0)
}

const home = path.resolve(ROOT, 'dsh', '.probe-usage-home')
const workspace = path.resolve(ROOT, 'dsh', '.probe-usage-ws')
const child = spawn(process.execPath, [path.join(ROOT, 'dsh', 'gateway', 'gateway.mjs')], {
  cwd: path.join(ROOT, 'dsh', 'gateway'),
  env: { ...process.env, DSH_HOME: home },
  stdio: ['pipe', 'pipe', 'pipe'],
})
child.stderr.on('data', (d) => process.stdout.write('[gw] ' + d.toString().slice(0, 200)))

let buf = ''
let id = 0
const pend = new Map()
const events = []
child.stdout.on('data', (d) => {
  buf += d.toString()
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const l = buf.slice(0, i).trim()
    buf = buf.slice(i + 1)
    if (!l) continue
    let m
    try { m = JSON.parse(l) } catch { continue }
    if (m.event) { events.push(m.event); continue }
    if (pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) }
  }
})
const req = (method, params, t = 240000) =>
  new Promise((res, rej) => {
    const rid = ++id
    pend.set(rid, res)
    child.stdin.write(JSON.stringify({ id: rid, method, params }) + '\n')
    setTimeout(() => { if (pend.has(rid)) { pend.delete(rid); rej(new Error('timeout ' + method)) } }, t)
  })

await req('run', {
  reqId: 'usage-probe',
  workspace,
  input: '只回复两个字：收到。不要调用任何工具。',
  model: 'deepseek-flash',
  maxTokens: 4096,
  apiKey: key,
  baseUrl: 'https://api.deepseek.com',
  systemPrompt: '',
  dshHome: home,
})
const t0 = Date.now()
while (Date.now() - t0 < 240000) {
  if (events.some((e) => e.reqId === 'usage-probe' && e.type === 'done')) break
  await new Promise((r) => setTimeout(r, 1000))
}
const evs = events.filter((e) => e.reqId === 'usage-probe')
const usage = evs.filter((e) => e.type === 'usage')
const done = evs.find((e) => e.type === 'done')
const met = (done && done.data && done.data.metrics) || null
console.log('EVENT TYPES:', evs.map((e) => e.type).join(' → '))
console.log('ERRORS:', JSON.stringify(evs.filter((e) => e.type === 'error').map((e) => e.data)))
console.log('USAGE FRAMES:', usage.length)
for (const u of usage) console.log('  usage:', JSON.stringify(u.data))
console.log('METRICS:', JSON.stringify(met && {
  inputTokens: met.inputTokens,
  outputTokens: met.outputTokens,
  cacheReadTokens: met.cacheReadTokens,
  contextWindow: met.contextWindow,
  llmMs: met.llmMs,
  turns: met.turns,
  steps: met.steps,
}))
console.log('MODELS:', JSON.stringify(met && (met.models || []).map((m) => ({
  provider: m.provider, model: m.model, calls: m.calls,
  in: m.inputTokens, out: m.outputTokens, cacheRead: m.cacheReadTokens, llmMs: m.llmMs,
}))))
const pass = usage.length > 0 && !!met && met.inputTokens > 0 && met.contextWindow > 0
console.log(pass ? 'RESULT: PASS（token 统计生效）' : 'RESULT: FAIL（没统计到 token）')
await req('shutdown').catch(() => {})
child.stdin.end()
process.exit(pass ? 0 : 1)
