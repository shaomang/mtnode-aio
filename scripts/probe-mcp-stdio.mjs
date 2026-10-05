/**
 * stdio 桥端到端测试（临时数据目录，用完即删）
 * 起主进程 MCP 服务端（假渲染层）→ 写 mcp-server.json → 用真子进程拉起 mcp-stdio.js →
 * 走它的 stdin/stdout 发 MCP 帧，验证「stdio ↔ HTTP ↔ 执行链路」整条通。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { createMcpHost } = require(path.join(ROOT, 'mcp-server.js'))

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mtnode-mcp-bridge-'))
const results = []
const step = (n, ok, d) => {
  results.push({ n, ok })
  console.log((ok ? '  [ok] ' : '  [FAIL] ') + n + (d ? ' — ' + d : ''))
}

const host = createMcpHost({
  dataDir: tmp,
  appRoot: ROOT,
  log: () => {},
  sendToRenderer: (frame) =>
    host.settle({
      id: frame.id,
      result:
        frame.op === 'get'
          ? { ok: true, workflow: { id: 'wf-bridge', name: '桥测试画布' }, nodes: [], contentHash: 'h1' }
          : { ok: true, op: frame.op },
    }),
})

await host.start()
const st = host.status()
fs.writeFileSync(
  path.join(tmp, 'mcp-server.json'),
  JSON.stringify({ enabled: true, port: st.port, token: st.token }, null, 2),
  'utf8',
)
console.log('临时数据目录 ' + tmp + ' · 服务端 ' + st.url)

const child = spawn(process.execPath, [path.join(ROOT, 'mcp-stdio.js')], {
  env: Object.assign({}, process.env, { MTNODE_DATA_DIR: tmp, MTNODE_MCP_CLIENT: 'bridge-test' }),
  stdio: ['pipe', 'pipe', 'pipe'],
})
let out = ''
child.stdout.on('data', (d) => (out += d.toString()))
child.stderr.on('data', (d) => process.stderr.write('[bridge] ' + d.toString()))

function send(obj) {
  child.stdin.write(JSON.stringify(obj) + '\n')
}
const waitFor = (pred, ms = 8000) =>
  new Promise((resolve, reject) => {
    const t0 = Date.now()
    const tick = () => {
      if (pred(out)) return resolve(true)
      if (Date.now() - t0 > ms) return reject(new Error('等待超时，已收到：' + out.slice(-300)))
      setTimeout(tick, 60)
    }
    tick()
  })
const lines = () => out.split('\n').filter(Boolean).map((l) => JSON.parse(l))

send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'bridge-test', version: '1' } } })
await waitFor(() => lines().some((l) => l.id === 1))
const init = lines().find((l) => l.id === 1)
step('stdio initialize', !!(init.result && init.result.serverInfo), JSON.stringify(init.result && init.result.serverInfo))

send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })
send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
await waitFor(() => lines().some((l) => l.id === 2))
const tools = lines().find((l) => l.id === 2)
step('stdio tools/list', ((tools.result && tools.result.tools) || []).length === 8)

send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'mtnode_canvas_get', arguments: { detail: 'minimal' } } })
await waitFor(() => lines().some((l) => l.id === 3))
const call = lines().find((l) => l.id === 3)
step('stdio tools/call 真执行', !!(call.result && !call.result.isError), (call.result && call.result.content[0].text || '').slice(0, 60))

send({ jsonrpc: '2.0', id: 4, method: 'resources/read', params: { uri: 'mtnode://canvases' } })
await waitFor(() => lines().some((l) => l.id === 4))
step('stdio resources/read', !!lines().find((l) => l.id === 4).result)

/* 服务端停掉后：桥必须给明确错误（而不是静默卡住） */
await host.stop()
send({ jsonrpc: '2.0', id: 5, method: 'tools/list', params: {} })
await waitFor(() => lines().some((l) => l.id === 5))
const dead = lines().find((l) => l.id === 5)
step('服务端关闭后给出明确错误', !!(dead.error && /失败|转发/.test(dead.error.message)), dead.error && dead.error.message)

child.stdin.end()
await new Promise((r) => child.on('exit', r))
step('桥进程正常退出', true)

const failed = results.filter((r) => !r.ok)
console.log('\n' + (failed.length ? '✗ ' + failed.length + ' 项未通过：' + failed.map((f) => f.n).join('、') : '✓ 全部 ' + results.length + ' 项通过'))
try {
  fs.rmSync(tmp, { recursive: true, force: true })
} catch {}
process.exit(failed.length ? 1 : 0)
