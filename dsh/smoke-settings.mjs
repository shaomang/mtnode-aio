// Protocol smoke for the settings-migration features:
// pluginList (inventory shape), pluginEnable/Disable roundtrip, preset-carrying run.
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const home = path.resolve(import.meta.dirname, 'smoke-home3')
const workspace = path.resolve(import.meta.dirname, 'smoke-ws3')
const key = readFileSync('C:/Users/shaom/.dsh/.credentials.yaml', 'utf8')
  .match(/^DEEPSEEK_API_KEY:\s*(.+)$/m)[1].trim()

const child = spawn(process.execPath, [path.join(import.meta.dirname, 'gateway', 'gateway.mjs')], {
  cwd: import.meta.dirname,
  env: { ...process.env, DSH_HOME: home, ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE },
  stdio: ['pipe', 'pipe', 'pipe'],
})
child.stderr.on('data', (d) => process.stdout.write('[gw] ' + d.toString().slice(0, 200)))
let buf = '', id = 0
const pend = new Map(), events = []
child.stdout.on('data', (d) => {
  buf += d.toString()
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1)
    if (!l) continue
    let m; try { m = JSON.parse(l) } catch { continue }
    if (m.event) { events.push(m.event); continue }
    if (pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) }
  }
})
const req = (method, params, t = 120000) =>
  new Promise((res, rej) => {
    const rid = ++id; pend.set(rid, res)
    child.stdin.write(JSON.stringify({ id: rid, method, params }) + '\n')
    setTimeout(() => { if (pend.has(rid)) { pend.delete(rid); rej(new Error('timeout ' + method)) } }, t)
  })

const pl = await req('pluginList')
const runtime = (pl.result.plugins || []).filter((p) => p.kind === 'runtime').length
const user = (pl.result.plugins || []).filter((p) => p.kind === 'user')
console.log(`[1] pluginList: runtime=${runtime} user=${user.length}`)
console.log('    sample runtime:', (pl.result.plugins || []).slice(0, 3).map((p) => p.name).join(', '))

// Enable/disable roundtrip on a scratch user plugin row
const pkgName = 'user-plugin-smoke'
const cordis = path.join(import.meta.dirname, 'gateway', 'cordis.yml')
const orig = readFileSync(cordis, 'utf8')
const marker = '# ── user plugins (managed from MTNode settings) ──'
const idx = orig.indexOf(marker)
writeFileSync(cordis, orig.slice(0, idx) + marker + `\n- id: user-plugin-smoketest\n  name: '${pkgName}'\n`, 'utf8')
try {
  const d1 = await req('pluginDisable', { pkg: pkgName })
  const st1 = (d1.result.plugins || []).find((p) => p.name === pkgName)
  console.log(`[2] disable → disabled=${st1 && st1.disabled}`)
  const e1 = await req('pluginEnable', { pkg: pkgName })
  const st2 = (e1.result.plugins || []).find((p) => p.name === pkgName)
  console.log(`[3] enable → disabled=${st2 && st2.disabled}`)
} finally {
  writeFileSync(cordis, orig, 'utf8')
}

// Real run carrying preset=minimal
const accepted = await req('run', {
  reqId: 'preset-1', workspace, input: '回复一句话确认你已就位,不要解释。', model: 'deepseek-v4-flash',
  maxTokens: 4096, apiKey: key, baseUrl: 'https://api.deepseek.com', systemPrompt: '', preset: 'minimal', dshHome: home,
})
console.log('[4] run accepted:', JSON.stringify(accepted).slice(0, 60))
const t0 = Date.now()
while (Date.now() - t0 < 240000) {
  if (events.some((e) => e.reqId === 'preset-1' && e.type === 'done')) break
  await new Promise((r) => setTimeout(r, 1000))
}
const done = events.find((e) => e.reqId === 'preset-1' && e.type === 'done')
console.log('[4] preset run FINAL:', String(done && done.data && done.data.finalResponse || '').slice(0, 200))

await req('shutdown')
child.stdin.end()
process.exit(0)
