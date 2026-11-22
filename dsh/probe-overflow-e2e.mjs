/* 端到端验证：DeepSeek 式「输入容量拒收」→ 本次会话内截断 + 摘要压缩 → 同轮重发 → 会话继续。

   真实现场复现不了（同机同 Key 34K–102K 输入全部通过，那个 32768 到底属于哪个入口至今
   没定位 —— 见 gateway.mjs 的 CAPACITY_REJECT 注释），所以用**假上游 + 真运行时**：
     · 本机起一个 OpenAI 兼容假上游，按请求体积判定超限，超了回逐字同构的 400：
         user input too long, N tokens exceeds max 32768 tokens (request id: …)
     · 第一问让模型调一次 `read` 去读工作区里一个 80K 字符的大文件：工具结果留在会话里，
       下一问的请求体积因此暴涨 —— 这正是用户会话里「跑了几轮工具、历史涨到 34K token」
       的形态；此时假上游的上限只比「工具 schema 底板」高一点 → 必然撞线，
       而截断 + 摘要之后必然回到线下。
     · 判据分两组，第二组是关键：证明救场的是**我们的插件**，不是别的东西。
         A 关闸（MTNODE_OVERFLOW_RECOVERY=0）→ 撞 400 后不该恢复：无 compaction，错误冒给用户
         B 开闸（默认 env=1）→ 撞 400 后压一次并同轮重发：错误不冒给用户、本轮出正文
   为什么不用 resumeSession：0.2 把会话日志写成 session.v4.jsonl.zstd，而网关的续跑判据只认
   session.jsonl[.zstd]（另一条线的问题），点名续跑会被判 RESUME_UNAVAILABLE。本用例全程在
   一次 run 内完成，不依赖续跑。
   用法：node dsh/smoke-overflow-e2e.mjs
*/
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/* 大文件行数 / 每行长度：工具结果体积 ≈ 80K 字符 */
const BIG_LINES = 2000
const BIG_LINE_LEN = 40
/* 假上游回的大段正文（也是可压的 assistant 消息） */
const REPLY_PAD = Number(process.env.FAKE_REPLY_PAD || 12000)
/* 撞线阈值 = 「只有工具 schema + system + 用户输入」时的体积 + 这么多字符 */
const LIMIT_OVER_FLOOR = 8000

let seq = 0
let limitChars = Number.MAX_SAFE_INTEGER
let mockedToolCall = false
const stats = { requests: [] }

const server = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    const idx = ++seq
    let j = {}
    try {
      j = JSON.parse(body)
    } catch {
      /* 非 JSON 按空对象处理 */
    }
    const messages = Array.isArray(j.messages) ? j.messages : []
    const chars = body.length
    const shape = messages.map((m) => {
      const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')
      const tc = Array.isArray(m.tool_calls) ? '+tc' : ''
      return `${m.role}${tc}:${c.length}`
    })
    const row = { idx, chars, messages: messages.length, shape, rejected: chars > limitChars, tool: false }
    stats.requests.push(row)
    if (row.rejected) {
      const est = Math.round(chars / 4)
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          error: {
            message:
              `user input too long, ${est} tokens exceeds max 32768 tokens ` +
              `(request id: fake-${idx}-${Math.random().toString(16).slice(2, 10)})`,
            type: 'invalid_request_error',
            param: null,
            code: 'invalid_request_error',
          },
        }),
      )
      return
    }
    const model = String(j.model || 'fake-model')
    const created = Math.floor(Date.now() / 1000)
    const text = `第 ${idx} 问答（历史 ${messages.length} 条）。` + '背景材料。'.repeat(Math.floor(REPLY_PAD / 5))
    /* 只让**第一次**请求调工具：读那个大文件，把大工具结果留在会话里 */
    const wantTool = !mockedToolCall
    if (wantTool) {
      mockedToolCall = true
      row.tool = true
      /* 这次回复之后，请求会带着工具结果暴涨 —— 把上限压到「当前底板 + 8K」 */
      limitChars = chars + LIMIT_OVER_FLOOR
    }
    const chunk = (delta, finish, usage) =>
      'data: ' +
      JSON.stringify({
        id: 'chatcmpl-' + idx,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta, finish_reason: finish }],
        ...(usage ? { usage } : {}),
      }) +
      '\n\n'
    if (j.stream) {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      res.write(chunk({ role: 'assistant', content: text }, null))
      if (wantTool) {
        res.write(
          chunk(
            {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_' + idx,
                  type: 'function',
                  function: {
                    name: 'read',
                    arguments: JSON.stringify({ file_path: bigFile, limit: BIG_LINES + 500 }),
                  },
                },
              ],
            },
            null,
          ),
        )
      }
      res.write(
        chunk({}, wantTool ? 'tool_calls' : 'stop', {
          prompt_tokens: 100,
          completion_tokens: 20,
          total_tokens: 120,
        }),
      )
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        id: 'chatcmpl-' + idx,
        object: 'chat.completion',
        created,
        model,
        choices: [
          {
            index: 0,
            message: wantTool
              ? {
                  role: 'assistant',
                  content: text,
                  tool_calls: [
                    {
                      id: 'call_' + idx,
                      type: 'function',
                      function: { name: 'read', arguments: JSON.stringify({ file_path: bigFile }) },
                    },
                  ],
                }
              : { role: 'assistant', content: text },
            finish_reason: wantTool ? 'tool_calls' : 'stop',
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      }),
    )
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port
const baseUrl = `http://127.0.0.1:${port}/v1`
console.log(`假上游已起：${baseUrl}`)

/* 工作区里那个「大文件」（read 会把它的内容整段塞进工具结果）。
   必须在**工作区里面**：dsh-tool-fs 的读路径按文件系统后端解析，工作区外的绝对路径会被拒
   （实测工具结果只有 47 字符的报错），那就造不出「大工具结果 = 大历史」这个现场。
   每个场景各自写一份（路径随 workspace 变）。 */
const bigLines = Array.from(
  { length: BIG_LINES },
  (_, i) => String(i + 1).padStart(4, '0') + '：'.padEnd(BIG_LINE_LEN, '材'),
).join('\n')
let bigFile = ''

const providers = [
  {
    route: 'fake',
    type: 'text_openai',
    baseUrl,
    apiKey: 'sk-fake-local',
    models: ['fake-model'],
    api: 'openai-completions',
  },
]

/** 跑一组场景：起一台网关（env 由 flag 控制）+ 一次 run，返回观测。 */
async function scenario(label, envFlag) {
  limitChars = Number.MAX_SAFE_INTEGER
  mockedToolCall = false
  const home = mkdtempSync(path.join(os.tmpdir(), 'mtnode-ovf-home-'))
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'mtnode-ovf-ws-'))
  bigFile = path.join(workspace, 'material.txt')
  writeFileSync(bigFile, bigLines + '\n', 'utf8')
  const child = spawn(process.execPath, [path.join(import.meta.dirname, 'gateway', 'gateway.mjs')], {
    cwd: import.meta.dirname,
    env: { ...process.env, DSH_HOME: home, MTNODE_OVERFLOW_RECOVERY: envFlag },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stderrAll = ''
  child.stderr.on('data', (d) => (stderrAll += d.toString()))
  const events = []
  let buf = ''
  let id = 0
  const pend = new Map()
  child.stdout.on('data', (d) => {
    buf += d.toString()
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const l = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (!l) continue
      let m
      try {
        m = JSON.parse(l)
      } catch {
        continue
      }
      if (m.event) {
        events.push(m.event)
        continue
      }
      if (pend.has(m.id)) {
        pend.get(m.id)(m)
        pend.delete(m.id)
      }
    }
  })
  const req = (method, params, t = 180000) =>
    new Promise((res, rej) => {
      const rid = ++id
      pend.set(rid, res)
      child.stdin.write(JSON.stringify({ id: rid, method, params }) + '\n')
      setTimeout(() => {
        if (pend.has(rid)) {
          pend.delete(rid)
          rej(new Error('timeout ' + method))
        }
      }, t)
    })
  const reqId = `${label}-1`
  const before = stats.requests.length
  await req('run', {
    reqId,
    workspace,
    input:
      '先用 read 工具读一下工作目录里那份 material.txt，读完再一句话总结它的主题。' +
      `（文件绝对路径：${bigFile}）`,
    model: 'fake-model',
    provider: 'mtnode_fake',
    apiKey: 'sk-fake-local',
    baseUrl,
    systemPrompt: '',
    dshHome: home,
    mtnodeProviders: providers,
    maxTokens: 2048,
    permissionPreset: 'mtnode-unattended',
  })
  const t = Date.now()
  while (Date.now() - t < 120000) {
    if (events.some((e) => e.reqId === reqId && (e.type === 'done' || e.type === 'error'))) break
    await new Promise((r) => setTimeout(r, 150))
  }
  const mine = events.filter((e) => e.reqId === reqId)
  const done = mine.filter((e) => e.type === 'done').pop()
  const errs = mine.filter((e) => e.type === 'error')
  const comps = mine.filter((e) => e.type === 'compaction')
  const sent = stats.requests.slice(before)
  const rejIdx = sent.findIndex((r) => r.rejected)
  const firstReject = rejIdx >= 0 ? sent[rejIdx] : null
  const after = rejIdx >= 0 ? sent.slice(rejIdx + 1).filter((r) => !r.rejected) : []
  const compacted = after.find((r) => firstReject && r.chars < firstReject.chars && r.messages <= firstReject.messages)
  child.kill()
  return {
    label,
    sent,
    rejected: !!firstReject,
    rejectChars: firstReject ? firstReject.chars : 0,
    compacted: compacted || null,
    compactionFrames: comps.length,
    errors: errs.length,
    errText: errs.length ? String((errs[0].data && errs[0].data.message) || '') : '',
    finalResponse: String((done && done.data && done.data.finalResponse) || ''),
    doneText: done ? JSON.stringify(done).slice(0, 500) : null,
    stderrAll,
    home,
  }
}

const t0 = Date.now()
const show = (x) => {
  console.log(`\n[${x.label}] 请求序列：`)
  for (const r of x.sent) {
    console.log(`  #${r.idx} ${r.chars} 字符 / ${r.messages} 条 [${r.shape.join(' ')}]` + (r.rejected ? '  ← 400 容量拒收' : ''))
  }
  console.log(
    `  compaction=${x.compactionFrames} error=${x.errors} 正文="${x.finalResponse.slice(0, 50)}"` +
      (x.errText ? `\n  error="${x.errText.slice(0, 200)}"` : ''),
  )
  if (x.doneText !== null) console.log(`  done 原文：${String(x.doneText).slice(0, 400)}`)
}

const A = await scenario('A', '0')
const B = await scenario('B', '')
show(A)
show(B)

/* ── 这份探针**不下结论**，只报观测 ─────────────────────────────────────────
   踩到的两件事（都是真的，都可以复核）：
     · 假 400 一撞，运行时下一问的请求体积确实变小了、本轮也真的出了正文
       —— 但把插件关掉（A 组）这套现场照样完成，所以**不能**把功劳算给插件；
     · 插件自己的诊断行拿不到（它跑在 runtime 子进程，stderr 被 sdk-client 收进
       stderrTail），所以「插件判了什么」只能靠 dsh/smoke-overflow-recovery.mjs
       那份假对象冒烟来钉（那里全绿）。
   归因没成立就不许写成功 —— 结论如实打印。 */
const observations = [
  ['A 关闸：400 发生', A.rejected],
  ['A 关闸：compaction 帧数', A.compactionFrames],
  ['A 关闸：error 事件数', A.errors],
  ['A 关闸：本轮有正文', A.finalResponse.trim().length > 0],
  ['B 开闸：400 发生', B.rejected],
  ['B 开闸：compaction 帧数', B.compactionFrames],
  ['B 开闸：拒绝后出现更小的请求', !!B.compacted],
  ['B 开闸：error 事件数', B.errors],
  ['B 开闸：本轮有正文', B.finalResponse.trim().length > 0],
]
console.log('\n观测（不是判据）：')
for (const [k, v] of observations) console.log(`  · ${k}：${v}`)
console.log(
  '\n归因：**未成立** —— A 组（插件关）也把本轮跑完了，说明这套假现场里还有别的路径在动；' +
    '\n      插件是否真的在救场，以 dsh/smoke-overflow-recovery.mjs（假 ctx 驱动真模块）为准，' +
    '\n      真机结论需要拿真实会话里的一次真实容量拒收来验。',
)
console.log(`\n耗时 ${Math.round((Date.now() - t0) / 1000)}s`)
server.close()
process.exit(0)
