// DSH 自测：真实 deepseek-v4-flash 跑通 mtnode_db 工具闭环。
// 流程：本地 SQLite 事实库 → 起真实网关 → 宿主扮演 MTNode 回答 'db' 帧 →
// 断言最终回答带 grounding（金额、引用、查不到明说）。
import { spawn } from 'node:child_process'
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import os from 'node:os'

const require = createRequire(import.meta.url)
const store = require('../db-store.js')

const credFile = 'C:/Users/shaom/.dsh/.credentials.yaml'
function resolveDeepSeek() {
  /* 优先：MTNode 应用配置里的 DeepSeek 服务商（与 dshProvider 同源） */
  try {
    const cfgPath = path.join(process.env.APPDATA || '', 'pipeline-console', 'pipeline-console', 'config.json')
    if (existsSync(cfgPath)) {
      const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
      for (const p of cfg.providers || []) {
        if (p.type !== 'text_openai' || !String(p.apiKey || '').trim()) continue
        let host = ''
        try { host = new URL(p.baseUrl || '').hostname.toLowerCase() } catch { continue }
        if (host.includes('deepseek') && (p.models || []).includes('deepseek-v4-flash'))
          return { apiKey: p.apiKey, baseUrl: p.baseUrl }
      }
    }
  } catch {}
  /* 回退：DSH credentials 文件 */
  if (existsSync(credFile)) {
    const m = readFileSync(credFile, 'utf8').match(/^DEEPSEEK_API_KEY:\s*(.+)$/m)
    if (m) return { apiKey: m[1].trim(), baseUrl: 'https://api.deepseek.com' }
  }
  return null
}
const ds = resolveDeepSeek()
if (!ds) {
  console.log('SKIP: no DeepSeek provider with deepseek-v4-flash found (app config / credentials file)')
  process.exit(0)
}
const { apiKey, baseUrl } = ds

const home = mkdtempSync(path.join(os.tmpdir(), 'mtnode-db-dsh-home-'))
const workspace = mkdtempSync(path.join(os.tmpdir(), 'mtnode-db-dsh-ws-'))

/* 1. 建测试事实库（SQLite + FTS5） */
const db = store.openDb(store.dbFilePath(workspace))
store.compileRecords(db, [
  { id: 'rec_n1', source: 'node:n1', kind: 'fact', title: '客户甲', content: '客户甲 合同金额 1200 元 账期 30 天', hash: 'h1' },
  { id: 'rec_n2', source: 'node:n2', kind: 'fact', title: '客户乙', content: '客户乙 合同金额 800 元 账期 15 天', hash: 'h2' },
  { id: 'rec_f1', source: 'file:price.yaml', kind: 'file', title: '价格表', content: '单价 12 元 / 件 运费 8 元', file: 'price.yaml', hash: 'h3' },
])
db.close()

/* 2. 起真实网关 */
const gateway = path.resolve(import.meta.dirname, '..', 'dsh', 'gateway', 'gateway.mjs')
const child = spawn(process.execPath, [gateway], {
  cwd: path.dirname(gateway),
  env: { ...process.env, DSH_HOME: home },
  stdio: ['pipe', 'pipe', 'pipe'],
})
child.stderr.on('data', (d) => process.stdout.write('[gw] ' + d.toString().slice(0, 200)))

let buf = ''
let rid = 0
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
    if (m.event) { events.push(m.event); onEvent(m.event); continue }
    if (pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) }
  }
})
const req = (method, params, t = 300000) =>
  new Promise((res, rej) => {
    const id = ++rid
    pend.set(id, res)
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n')
    setTimeout(() => { if (pend.has(id)) { pend.delete(id); rej(new Error('timeout ' + method)) } }, t)
  })

/* 3. 宿主扮演：db 帧 → SQLite 查询 → interact 应答 */
function onEvent(ev) {
  if (!ev || ev.type !== 'db' || !ev.data || !ev.data.id) return
  const d = ev.data
  const p = d.params || {}
  let result
  try {
    const qdb = store.openDb(store.dbFilePath(workspace))
    try {
      const action = String(d.action || p.action || 'list')
      if (action === 'list') {
        const list = store.dbList(qdb)
        result = {
          ok: true,
          databases: [{ database: '测试库', folder: '', compiledAt: Date.now(), count: list.length,
            titles: list.map((x) => x.id + ' | ' + (x.title || '') + ' | ' + (x.kind || '') + (x.file ? ' | ' + x.file : '')) }],
          total: list.length,
        }
      } else if (action === 'get') {
        const r = store.dbGet(qdb, p.id)
        result = r ? { ok: true, database: '测试库', record: r } : { ok: false, error: '数据库中没有该记录：' + (p.id || '') }
      } else if (action === 'calc') {
        const v = store.dbCalcExpr(p.expr)
        result = v === null ? { ok: false, error: 'calc 仅支持数字与 + - * / % 括号，表达式非法' } : { ok: true, expr: String(p.expr || ''), value: v }
      } else {
        const hits = store.dbQuery(qdb, String(p.q || ''), 6)
        result = {
          ok: true, query: String(p.q || ''), found: hits.length, results: hits,
          ...(hits.length === 0 ? { none: '数据库中没有匹配该查询的记录' } : {}),
        }
      }
    } finally {
      qdb.close()
    }
  } catch (e) {
    result = { ok: false, error: String((e && e.message) || e) }
  }
  req('interact', { id: d.id, kind: 'db', result }).catch(() => {})
}

/* 4. 运行：模型必须只信工具 */
const sys = [
  '你是测试代理。事实必须通过 mtnode_db 工具查询（list/query/get/calc），每个断言注明 [记录id · 标题]，查不到就回答「数据库中没有该信息」，数字用 calc，禁止心算与猜测。',
].join('\n')
const input = '请依次完成并报告：1) 用 mtnode_db 查「客户甲」的合同金额；2) 用 mtnode_db calc 计算该金额打八折；3) 用 mtnode_db 查询「火星合同」并如实说明结果。'
const accepted = await req('run', {
  reqId: 'db-e2e-1',
  workspace,
  input,
  model: 'deepseek-v4-flash',
  maxTokens: 49152,
  apiKey,
  baseUrl,
  systemPrompt: sys,
  dshHome: home,
})
console.log('[run] accepted:', JSON.stringify(accepted).slice(0, 80))

const t0 = Date.now()
while (Date.now() - t0 < 420000) {
  if (events.some((e) => e.reqId === 'db-e2e-1' && e.type === 'done')) break
  await new Promise((r) => setTimeout(r, 1000))
}
const evs = events.filter((e) => e.reqId === 'db-e2e-1')
console.log('[events]', evs.map((e) => e.type).join(' → '))
const dbCalls = evs.filter((e) => e.type === 'db').length
console.log('[db tool calls]', dbCalls)
const done = evs.find((e) => e.type === 'done')
const final = String((done && done.data && done.data.finalResponse) || '')
console.log('[FINAL]', final.slice(0, 600))

/* 5. 断言 */
let fails = 0
const ok = (cond, msg) => {
  console.log((cond ? '  ok  ' : 'FAIL  ') + msg)
  if (!cond) fails++
}
ok(done != null, '任务完成（done 事件）')
ok(dbCalls >= 3, '至少调用 mtnode_db 三次（查/算/查）')
ok(/1200/.test(final), '回答包含查到的合同金额 1200')
ok(/960/.test(final), 'calc 八折 = 960（数字交给代码）')
ok(/rec_n1|客户甲/.test(final), '回答引用记录 [rec_n1 · 客户甲]')
ok(/没有该信息|数据库中?没有|无匹配|未找到|不存在/.test(final), '查不到时明说「数据库中没有该信息」')

await req('shutdown').catch(() => {})
child.stdin.end()
await new Promise((r) => setTimeout(r, 800))
const tryRm = (p) => {
  try { rmSync(p, { recursive: true, force: true }) } catch {}
}
tryRm(home)
tryRm(workspace)
console.log(fails ? '\nSMOKE-DB-DSH FAILED (' + fails + ')' : '\nSMOKE-DB-DSH OK')
process.exit(fails ? 1 : 0)
