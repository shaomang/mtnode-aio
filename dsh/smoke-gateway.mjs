// Gateway protocol smoke: speak main-dsh's exact local protocol to the real
// gateway, verifying status/pluginList/run(short-circuit)/shutdown end to end.
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)
const gateway = path.resolve(import.meta.dirname, 'gateway', 'gateway.mjs')
const home = path.resolve(import.meta.dirname, 'smoke-home')

const child = spawn(process.execPath, [gateway], {
  cwd: path.dirname(gateway),
  env: { ...process.env, DSH_HOME: home },
  stdio: ['pipe', 'pipe', 'pipe'],
})
child.stderr.on('data', (d) => process.stdout.write('[gw stderr] ' + d.toString().slice(0, 300)))

let buf = ''
const pending = new Map()
let id = 0
const events = []
child.stdout.on('data', (d) => {
  buf += d.toString()
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim()
    buf = buf.slice(i + 1)
    if (!line) continue
    let m
    try { m = JSON.parse(line) } catch { continue }
    if (m.event) { events.push(m.event); continue }
    if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
  }
})
function req(method, params, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const rid = ++id
    pending.set(rid, resolve)
    child.stdin.write(JSON.stringify({ id: rid, method, params }) + '\n')
    setTimeout(() => { if (pending.has(rid)) { pending.delete(rid); reject(new Error('timeout: ' + method)) } }, timeoutMs)
  })
}

const workspace = path.resolve(import.meta.dirname, 'smoke-ws')
const runReqId = 'smoke-run-1'

const st = await req('status')
console.log('[1] status →', JSON.stringify(st))

const pl = await req('pluginList')
console.log('[2] pluginList →', JSON.stringify(pl))
const pluginNames = ((pl.result && pl.result.plugins) || []).map((p) => p.name)
if (!pluginNames.includes('./canvas-plugin.mjs')) {
  console.log('[fail] shipped canvas plugin missing from pluginList')
  process.exit(1)
}
console.log('[2] canvas plugin present')

const accepted = await req('run', {
  reqId: runReqId, workspace, input: '测试任务', model: 'deepseek-v4-flash',
  maxTokens: 4096, apiKey: 'not-a-real-key', baseUrl: 'https://api.deepseek.com',
  systemPrompt: '', dshHome: home,
})
console.log('[3] run accepted →', JSON.stringify(accepted))

// Wait for done/error events (keyless with bogus key: runtime boot may succeed,
// model request fails → error event then done event).
const t0 = Date.now()
while (Date.now() - t0 < 90000) {
  const done = events.find((e) => e.reqId === runReqId && e.type === 'done')
  if (done) break
  await new Promise((r) => setTimeout(r, 500))
}
const runEvents = events.filter((e) => e.reqId === runReqId)
console.log('[4] run events (' + runEvents.length + '):',
  runEvents.map((e) => e.type + (e.type === 'error' ? '(' + (e.data && e.data.message || '').slice(0, 80) + ')' : '')).join(' → '))
const doneEv = runEvents.find((e) => e.type === 'done')
console.log('[4] done present:', !!doneEv)

const sh = await req('shutdown')
console.log('[5] shutdown →', JSON.stringify(sh))
child.stdin.end()
const exitCode = await new Promise((r) => child.once('exit', r))
console.log('[6] gateway exit code:', exitCode)
