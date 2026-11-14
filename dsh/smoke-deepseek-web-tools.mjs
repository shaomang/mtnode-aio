// 网关冒烟：DeepSeek 服务端工具（联网搜索 / 阅读链接）声明注入 + SSE 扩展块旁路。
//
// 三件事一次跑完，**全程离线**（本地假上游，不需要真 key）：
//   [0] 纯函数层：服务商判定 / 开关构造 tools / 已有声明去重 / function 工具保序；
//   [1] SSE 分片器：扩展块被摘出来走旁路，标准 delta、finish_reason 与 [DONE] 逐字透传
//       （分片故意切在事件中间，验证半截缓冲）；
//   [2] 真链路：pi-ai 的 openai-completions 流 + 本模块的 options.fetch 包装 ——
//       请求体带上了服务端工具声明、扩展块事件三种都被拿到、pi-ai 的正文与收尾正常。
//       这一步同时是「网关有权注入 options.fetch」这条落地方式的可执行证据
//       （pi-ai 接受 options.fetch；dsh 的 llm-pi-ai 不透传 fetch，见模块头注释）。
//
// 跑法：node dsh/smoke-deepseek-web-tools.mjs   （成功 exit 0，失败 exit 1）
import { createServer } from 'node:http'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  EXTENSION_KINDS,
  applyServerToolsJson,
  buildServerTools,
  createSseExtensionSplitter,
  extensionFrame,
  isDeepSeekWebToolsProvider,
  wrapFetchWithServerTools,
} from './gateway/deepseek-web-tools.mjs'

/* pi-ai 装在 dsh/gateway/node_modules 里（网关进程的解析根），本脚本在 dsh/ 下，
   直接按网关目录取文件（exports 里 `./api/*` 只声明了 types/import 条件，
   require.resolve 解析不了子路径，也无法从 dsh/ 走裸标识符解析）。 */
const piAiDir = path.join(import.meta.dirname, 'gateway', 'node_modules', '@earendil-works', 'pi-ai')
const piAi = await import(pathToFileURL(path.join(piAiDir, 'dist', 'api', 'openai-completions.js')).href)
/* normalizeContext：把 tools / systemPrompt 折进首条 system 消息 —— 直接调 api 层的
   stream() 时必须先做这一步（Models 层平时替我们做了），否则 function 工具不会进请求体。 */
const { normalizeContext } = await import(pathToFileURL(path.join(piAiDir, 'dist', 'utils', 'transcript.js')).href)

let failures = 0
function check(ok, label, detail) {
  if (ok) {
    console.log('  ok   ' + label)
    return true
  }
  failures += 1
  console.log('  FAIL ' + label + (detail === undefined ? '' : ' → ' + JSON.stringify(detail).slice(0, 400)))
  return false
}

/* ── [0] 纯函数：判定 / 开关 / 请求体合并 ───────────────────────────────────── */
console.log('[0] 服务商判定与工具声明')
const deepseekOfficial = { id: 'deepseek', baseUrl: 'https://api.deepseek.com', models: ['deepseek-flash'] }
const deepseekByHost = { id: 'p1', baseUrl: 'https://api.DeepSeek.com/anthropic' }
const relayCard = { id: 'mtnode-relay', source: 'mtnode-relay', baseUrl: 'https://www.mt-agent.com/mtnode/store-api/relay/v1' }
const thirdParty = { id: 'openai', baseUrl: 'https://api.openai.com', models: ['gpt-5'] }
check(isDeepSeekWebToolsProvider(deepseekOfficial) === true, 'id=deepseek 命中')
check(isDeepSeekWebToolsProvider('deepseek-official') === true, '官方路由名 deepseek-official 命中')
check(isDeepSeekWebToolsProvider(deepseekByHost) === true, '主机名含 deepseek 命中（大小写不敏感）')
check(isDeepSeekWebToolsProvider(relayCard) === true, 'source=mtnode-relay 命中')
check(isDeepSeekWebToolsProvider(thirdParty) === false, '第三方服务商不命中')
check(isDeepSeekWebToolsProvider(null) === false && isDeepSeekWebToolsProvider({}) === false, '空值不命中')

check(buildServerTools(deepseekOfficial, {}).length === 0, '总开关缺省关：一条声明都不加')
const bothTools = buildServerTools(deepseekOfficial, { enabled: true })
check(
  bothTools.length === 2 && bothTools[0].type === 'deepseek_web_search' && bothTools[1].type === 'deepseek_read_url'
    && bothTools.every((t) => t.name === t.type),
  '总开关打开：按实测协议声明两件工具（name 与 type 同名）',
  bothTools,
)
const searchOnly = buildServerTools(deepseekOfficial, { enabled: true, readUrl: false })
check(searchOnly.length === 1 && searchOnly[0].type === 'deepseek_web_search', 'readUrl 关掉后只剩联网搜索')
check(buildServerTools(thirdParty, { enabled: true }).length === 0, '第三方服务商即便开开关也不声明')

const mergedBody = applyServerToolsJson(
  JSON.stringify({
    model: 'deepseek-flash',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [
      { type: 'deepseek_web_search', name: 'deepseek_web_search' },
      { type: 'function', function: { name: 'get_probe_value', parameters: { type: 'object', properties: {} } } },
    ],
  }),
  deepseekOfficial,
  { enabled: true, readUrl: false },
)
const merged = JSON.parse(mergedBody)
const mergedTypes = merged.tools.map((t) => t.type || t.function?.name)
check(
  mergedTypes.join(',') === 'deepseek_web_search,function',
  '服务端工具排前、已有同 type 去重、function 工具原样保序',
  mergedTypes,
)
check(applyServerToolsJson('not json', deepseekOfficial, { enabled: true }) === 'not json', '非 JSON 请求体原样放过')

/* ── [1] SSE 分片器：扩展块旁路 + 标准 delta 透传 ───────────────────────────── */
console.log('[1] SSE 分片器（扩展块从流里剥出来）')
const fixtureFrames = [
  'data: {"choices":[{"index":0,"delta":{"content":"搜索"},"finish_reason":null}]}\n\n',
  'data: {"choices":[{"index":0,"delta":{},"server_tool_event":{"type":"call_started","step":0,' +
    '"call":{"index":0,"id":"srvtoolu_ds_00_probe","type":"deepseek_web_search","kind":"deep_search",' +
    '"action":{"type":"search","queries":["DeepSeek 最新模型"]}}}}]}\n\n',
  'data: {"choices":[{"index":0,"delta":{"content":"完成。"},"finish_reason":null}]}\n\n',
  'data: {"choices":[{"index":0,"delta":{"content":"","server_tool_calls":[{"index":0,"calls":[{"index":0,' +
    '"id":"srvtoolu_rl_00_probe","type":"deepseek_read_url","kind":"read_link","status":"completed",' +
    '"page":{"url":"https://example.com","title":"Example Domain"},"signature":"0G8maPdaVyn+PROBE"}]}],' +
    '"annotations":[{"type":"url_citation","url_citation":{"url":"https://example.com","start_index":0,' +
    '"end_index":3}}]},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2,' +
    '"server_tool_use":{"tool_search":1,"tool_fetch":1}}}\n\n',
  'data: [DONE]\n\n',
]
const fixture = fixtureFrames.join('')
const splitter = createSseExtensionSplitter()
/* 故意把每一片切在事件中间：半截事件必须留在缓冲里，不能漏也不能提前吐出 */
let passthrough = ''
for (let i = 0; i < fixture.length; i += 37) passthrough += splitter.push(fixture.slice(i, i + 37))
passthrough += splitter.flush()
const ext = splitter.extensions
check(ext.length === 3, '三种扩展块各旁路一次（progress / calls / citations）', ext.map((e) => e.kind))
check(ext[0]?.kind === EXTENSION_KINDS.progress && ext[0]?.data?.type === 'call_started', '进度块 kept 原文（call_started）')
check(
  ext[1]?.kind === EXTENSION_KINDS.calls && ext[1]?.data?.[0]?.calls?.[0]?.signature === '0G8maPdaVyn+PROBE',
  '工具账本含 signature（多轮回放要靠它，不能丢）',
)
check(ext[2]?.kind === EXTENSION_KINDS.citations && ext[2]?.data?.[0]?.type === 'url_citation', '引用块（url_citation）')
check(!/server_tool_event|server_tool_calls|annotations/.test(passthrough), '透传文本里不再有扩展键', passthrough.slice(0, 200))
check(passthrough.includes('"finish_reason":"stop"') && passthrough.includes('data: [DONE]'), '收尾帧与 [DONE] 逐字保留')
check((passthrough.match(/"content":"搜索"/) || []).length === 1, '标准 content delta 原样透传')
check(passthrough.includes('"usage"'), '与扩展块同帧的 usage 不被一起丢掉')
const onExtensionSeen = []
const frameOut = extensionFrame('run-42', ext[0])
check(
  frameOut.event.reqId === 'run-42' && frameOut.event.type === 'deepseek-web-tool' && !!frameOut.event.data,
  '扩展块可以按网关帧格式（{event:{reqId,type,data}}）发给渲染层',
  frameOut,
)
check(onExtensionSeen.length === 0, '旁路回调只在真的配了的时候才跑（这里是空数组）')

/* ── [2] 真链路：pi-ai 流 + options.fetch 包装 + 本地假上游 ─────────────────── */
console.log('[2] pi-ai 流 + options.fetch 包装（本地假上游）')
const upstreamFrames = fixtureFrames
let capturedBody = null
const server = createServer((req, res) => {
  let raw = ''
  req.setEncoding('utf8')
  req.on('data', (d) => { raw += d })
  req.on('end', () => {
    capturedBody = raw
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' })
    for (const frame of upstreamFrames) res.write(frame)
    res.end()
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port

const outgoing = []
const wrappedFetch = wrapFetchWithServerTools(globalThis.fetch, {
  provider: relayCard,
  enabled: true,
  onExtension: (e) => outgoing.push(e),
})
const model = {
  id: 'deepseek-flash',
  name: 'deepseek-flash',
  api: 'openai-completions',
  provider: 'deepseek',
  baseUrl: 'http://127.0.0.1:' + port,
  input: ['text'],
  output: ['text'],
  contextWindow: 128000,
  maxTokens: 8192,
  /* 收尾算钱要 model.cost（pi-ai 的 calculateCost 会读 cost.tiers），缺了它整轮会被判成 error */
  cost: { input: 0.28, output: 0.42, cacheRead: 0.028, cacheWrite: 0.28 },
}
const context = normalizeContext({
  messages: [{ role: 'user', content: '请联网搜索：DeepSeek 最近发布了哪些模型？', timestamp: Date.now() }],
  tools: [{
    name: 'get_probe_value',
    description: '返回探针常量',
    parameters: { type: 'object', properties: { k: { type: 'string' } }, required: ['k'] },
  }],
})
let result = null
let streamError = null
try {
  const stream = piAi.stream(model, context, { apiKey: 'sk-smoke-not-real', fetch: wrappedFetch, maxTokens: 256 })
  result = await stream.result()
} catch (error) {
  streamError = error
}
server.close()

check(streamError === null, 'pi-ai 流没有抛错', streamError ? String(streamError && streamError.message) : undefined)
const requestBody = capturedBody ? JSON.parse(capturedBody) : {}
const sentTypes = Array.isArray(requestBody.tools) ? requestBody.tools.map((t) => t.type || 'function') : []
check(
  sentTypes.includes('deepseek_web_search') && sentTypes.includes('deepseek_read_url') && sentTypes.includes('function'),
  '请求体：服务端工具两条 + pi-ai 自己的 function 工具并存',
  sentTypes,
)
check(outgoing.length === 3, '旁路拿到三种扩展块（progress / calls / citations）', outgoing.map((e) => e.kind))
const resultText = (result && Array.isArray(result.content) ? result.content : [])
  .filter((b) => b && b.type === 'text')
  .map((b) => b.text)
  .join('')
check(resultText === '搜索完成。', 'pi-ai 收到的正文与假上游标准 delta 一致', resultText)
check(result && result.stopReason === 'stop', 'pi-ai 正常收尾（finish_reason 没被剥掉）', result && result.stopReason)

console.log(failures === 0 ? '[ok] deepseek-web-tools smoke passed' : '[fail] ' + failures + ' 项未通过')
process.exit(failures === 0 ? 0 : 1)
