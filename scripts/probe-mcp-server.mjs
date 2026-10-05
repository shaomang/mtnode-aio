/**
 * MTNode MCP 自检探针（可跑 · 只读现场）
 *
 * 干什么：不接任何外部 MCP 客户端，自己把整条链路走一遍 ——
 *   起主进程 MCP 服务端（临时数据目录 + **假渲染层**）→ 真发 HTTP →
 *   initialize / tools/list / resources/list / prompts/get / tools/call（含 baseHash 版本闸）
 *   → 打印每一步结论。用来验收「服务端与协议面自己就是通的」，也是改协议后最快的回归手段。
 *
 * 不干什么：不启动 Electron、不读真画布、不写用户数据目录（临时目录用完即删）。
 * 真链路（主进程 → 渲染层 → 既有执行器）由 test/smoke-mcp-server.js 与
 * 应用内「扩展能力管理 → MCP 服务端 → 自检」两处覆盖。
 *
 * 跑法：node scripts/probe-mcp-server.mjs [--keep]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const { createMcpHost } = require(path.join(ROOT, 'mcp-server.js'))

const keep = process.argv.includes('--keep')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mtnode-mcp-probe-'))
const results = []
const step = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log((ok ? '  [ok] ' : '  [FAIL] ') + name + (detail ? ' — ' + detail : ''))
}

/** 假渲染层：把主进程推来的帧按 op 编一个可辨识的回执（形状与真回执同构）。 */
function fakeRenderer(host, push) {
  const seen = []
  return {
    seen,
    handle(frame) {
      seen.push({ op: frame.op, params: frame.params, sessionId: frame.sessionId, write: !!frame.write })
      const done = (result, error) => host.settle({ id: frame.id, result, error })
      switch (frame.op) {
        case 'get':
          return done({
            ok: true,
            workflow: { id: frame.params.canvas || 'wf-current', name: '当前画布', nodes: 2 },
            nodes: [
              { title: '文本节点 1', kind: 'input_text', note: '示例输入' },
              { title: '保存节点 1', kind: 'save', note: '落盘' },
            ],
            contentHash: 'hash-' + (frame.params.canvas || 'current'),
          })
        case 'canvasList':
          return done([
            { id: 'wf-1', name: '示例画布', nodes: 3, active: true },
            { id: 'wf-2', name: '另一张画布', nodes: 1, active: false },
          ])
        case 'edit':
          if (frame.params.baseHash && frame.params.baseHash !== 'hash-' + (frame.params.canvas || 'current')) {
            return done({ ok: false, error: '画布已被改动（版本不一致），本次修改未执行' }, '画布已被改动（版本不一致），本次修改未执行')
          }
          return done({
            created: [{ title: 'proc_text-1', x: 0, y: 0, w: 240, h: 120 }],
            updated: [],
            connected: [],
            removed: [],
            warnings: [],
            workflow: { id: frame.params.canvas || 'wf-current' },
            contentHash: 'hash-after-edit',
          })
        case 'db':
          return done({ ok: true, action: frame.params.action || 'list', rows: 2 })
        case 'facts':
          return done({ ok: true, items: [{ id: 'f1', title: '约定', text: '示例' }] })
        case 'asset':
          return done({ ok: true, action: 'list', items: [] })
        case 'vision':
          return done({ ok: true, text: '这是一张示例图' })
        case 'skillList':
          return done({
            libraryPath: '/tmp/skills',
            count: 1,
            skills: [
              {
                name: 'mtnode-canvas-edit-rules',
                title: '画布编辑硬规则',
                description: '建图 / 连线 / 批量硬规则',
                category: 'mtnode',
                path: 'mtnode/canvas-edit-rules/SKILL.md',
              },
            ],
          })
        case 'skillBody':
          return done('# 画布编辑硬规则\n\n示例正文')
        case 'lt':
          return done({ ok: true, note: '示例', state: { pool_ok: true } })
        default:
          return done(null, '未知 op：' + frame.op)
      }
    },
  }
}

async function rpc(url, token, method, params, session) {
  const headers = { 'content-type': 'application/json', authorization: 'Bearer ' + token }
  if (session) headers['mcp-session-id'] = session
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: Math.floor(Math.random() * 1e6), method, params: params || {} }),
  })
  const sid = res.headers.get('mcp-session-id') || session || ''
  const text = await res.text()
  return { body: text ? JSON.parse(text) : null, session: sid, status: res.status }
}

async function main() {
  console.log('MTNode MCP 探针 · 临时数据目录 ' + tmp)
  const host = createMcpHost({
    dataDir: tmp,
    appRoot: ROOT,
    log: () => {},
    sendToRenderer: (frame) => fakeRendererRefs.handle(frame),
  })
  const fakeRendererRefs = fakeRenderer(host)
  await host.start()
  const st = host.status()
  step('服务端已监听', !!st.running && st.port > 0, st.url)
  step('随机端口 + 仅本机', st.host === '127.0.0.1', st.host + ':' + st.port)

  const url = st.url
  const token = st.token

  const bad = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  })
  step('无 token 被拒', bad.status === 401, 'HTTP ' + bad.status)

  const init = await rpc(url, token, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'probe', version: '1' },
  })
  step('initialize 握手', !!(init.body && init.body.result && init.body.result.serverInfo), JSON.stringify(init.body && init.body.result && init.body.result.serverInfo))
  step('会话 id 下发', !!init.session, init.session)
  const sid = init.session

  const caps = init.body.result.capabilities || {}
  step('能力位齐备', !!(caps.tools && caps.resources && caps.prompts), Object.keys(caps).join(','))

  const tools = await rpc(url, token, 'tools/list', {}, sid)
  const names = ((tools.body.result && tools.body.result.tools) || []).map((t) => t.name)
  step('tools/list', names.length === 8, names.join(', '))

  const res = await rpc(url, token, 'resources/list', {}, sid)
  const r = res.body.result || {}
  step('resources/list', (r.resources || []).length === 2 && (r.resourceTemplates || []).length === 3,
    (r.resources || []).length + ' 静态 / ' + (r.resourceTemplates || []).length + ' 模板')
  const prompts = await rpc(url, token, 'prompts/list', {}, sid)
  step('prompts/list', ((prompts.body.result && prompts.body.result.prompts) || []).length === 3)
  const one = await rpc(url, token, 'prompts/get', { name: 'takeover-canvas', arguments: { canvas: '示例画布' } }, sid)
  const ptext = one.body.result && one.body.result.messages && one.body.result.messages[0].content.text
  step('prompts/get 出正文', !!ptext && ptext.indexOf('mtnode_canvas_get') >= 0, (ptext || '').slice(0, 60) + '…')
  const get1 = await rpc(url, token, 'tools/call', { name: 'mtnode_canvas_get', arguments: { detail: 'minimal' } }, sid)
  const getOk = get1.body.result && !get1.body.result.isError
  step('tools/call mtnode_canvas_get', getOk, getOk ? '拿到画布快照' : JSON.stringify(get1.body))

  const resRead = await rpc(url, token, 'resources/read', { uri: 'mtnode://canvases' }, sid)
  step('resources/read 画布列表', !!(resRead.body.result && resRead.body.result.contents[0].text.indexOf('wf-1') >= 0))

  const skillRead = await rpc(url, token, 'resources/read', { uri: 'mtnode://skill/mtnode-canvas-edit-rules' }, sid)
  step('resources/read 技能正文', !!(skillRead.body.result && skillRead.body.result.contents[0].mimeType === 'text/markdown'))

  const badArgs = await rpc(url, token, 'tools/call', { name: 'mtnode_canvas_edit', arguments: { remove: 3 } }, sid)
  step('参数类型校验', !!(badArgs.body.result && badArgs.body.result.isError), badArgs.body.result && badArgs.body.result.content[0].text)

  const editOk = await rpc(url, token, 'tools/call', {
    name: 'mtnode_canvas_edit',
    arguments: { canvas: 'wf-1', baseHash: 'hash-wf-1', create: [{ alias: 'a', kind: 'proc_text' }] },
  }, sid)
  step('写调用带 baseHash 通过', !!(editOk.body.result && !editOk.body.result.isError))

  const editStale = await rpc(url, token, 'tools/call', {
    name: 'mtnode_canvas_edit',
    arguments: { canvas: 'wf-1', baseHash: 'obsolete', remove: ['x'] },
  }, sid)
  step('过期 baseHash 被拒', !!(editStale.body.result && editStale.body.result.isError), editStale.body.result && editStale.body.result.content[0].text)

  const unknown = await rpc(url, token, 'tools/call', { name: 'browser_click', arguments: {} }, sid)
  step('未导出的工具给出明确原因', !!(unknown.body.result && unknown.body.result.isError), unknown.body.result && unknown.body.result.content[0].text)

  const audit = host.readAudit(50)
  step('审计落盘', audit.length >= 4 && audit.every((e) => e.ts && e.method), audit.length + ' 条：' + audit.map((e) => e.tool || e.method).join(' '))
  step('审计含画布与工具名', audit.some((e) => e.tool === 'mtnode_canvas_edit' && e.canvas === 'wf-1'))

  const st2 = host.status()
  step('状态含 stdio 命令', !!(st2.stdioCommand && st2.stdioCommand.script && fs.existsSync(st2.stdioCommand.script)), st2.stdioCommand.display)

  const self = await host.selfTest()
  step('内置自检探针', self.ok, JSON.stringify(self.steps.map((s) => s.name + (s.ok ? '=ok' : '=FAIL'))))

  await host.stop()
  step('停止后不再监听', !host.status().running)

  const failed = results.filter((x) => !x.ok)
  console.log('\n' + (failed.length ? '✗ ' + failed.length + ' 项未通过：' + failed.map((f) => f.name).join('、') : '✓ 全部 ' + results.length + ' 项通过'))
  if (!keep) {
    try {
      fs.rmSync(tmp, { recursive: true, force: true })
    } catch {}
  } else {
    console.log('（--keep：临时目录保留在 ' + tmp + '）')
  }
  process.exit(failed.length ? 1 : 0)
}

main().catch((e) => {
  console.error('探针失败：' + ((e && e.stack) || e))
  process.exit(1)
})
