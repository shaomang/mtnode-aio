// Real-key gateway e2e: run an agent task that must WRITE a file in the
// workspace, then verify the file exists on disk.
import { spawn } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'

const key = readFileSync('C:/Users/shaom/.dsh/.credentials.yaml', 'utf8')
  .match(/^DEEPSEEK_API_KEY:\s*(.+)$/m)[1].trim()

const home = path.resolve(import.meta.dirname, 'smoke-home2')
const workspace = path.resolve(import.meta.dirname, 'smoke-ws2')

const child = spawn(process.execPath, [path.join(import.meta.dirname, 'gateway', 'gateway.mjs')], {
  cwd: import.meta.dirname,
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
const req = (method, params, t = 300000) =>
  new Promise((res, rej) => {
    const rid = ++id
    pend.set(rid, res)
    child.stdin.write(JSON.stringify({ id: rid, method, params }) + '\n')
    setTimeout(() => { if (pend.has(rid)) { pend.delete(rid); rej(new Error('timeout ' + method)) } }, t)
  })

const accepted = await req('run', {
  reqId: 'real-1',
  workspace,
  input: '在1分钟内做一件小事：在工作目录里写一个文件 hello.txt，内容是「智能能力已接通」，然后回复我确认。',
  model: 'deepseek-v4-flash',
  maxTokens: 49152,
  apiKey: key,
  baseUrl: 'https://api.deepseek.com',
  systemPrompt: '',
  dshHome: home,
})
console.log('accepted:', JSON.stringify(accepted).slice(0, 80))

const t0 = Date.now()
while (Date.now() - t0 < 420000) {
  if (events.some((e) => e.reqId === 'real-1' && e.type === 'done')) break
  await new Promise((r) => setTimeout(r, 1000))
}
const evs = events.filter((e) => e.reqId === 'real-1')
console.log('events:', evs.map((e) => e.type).join(' → '))
const tools = evs.filter((e) => e.type === 'tool').map((e) => e.data && e.data.name)
console.log('tools used:', tools.length ? tools.join(', ') : '(none)')
const done = evs.find((e) => e.type === 'done')
console.log('FINAL:', String((done && done.data && done.data.finalResponse) || '').slice(0, 300))
const hello = path.join(workspace, 'hello.txt')
console.log('hello.txt exists:', existsSync(hello))
if (existsSync(hello)) console.log('content:', JSON.stringify(readFileSync(hello, 'utf8')))

await req('shutdown')
child.stdin.end()
process.exit(0)
