/* ============================================================================
   browser-plugin.mjs — 会话自己的浏览器（工具面；跑在 dsh 运行时进程内）

   与 bridge / canvas / db / asset 插件同一条纪律：本文件只依赖 node 内置 +
   @deepseek-ai/dsh-tools 的 defineTool，dsh 的 API 变化全部消化在 dsh/ 目录里。

   帧协议（换行分隔 JSON，端口仍是 spawn 时的 MTNODE_BRIDGE_PORT）：
     plugin → gateway: {t:'browser', id, sessionId, op, params}
     plugin → gateway: {t:'drop', id, sessionId}          （本工具自己放弃了这一帧）
     gateway → plugin: {t:'browser-result', id, ok, result?, error?} | {t:'abort', id}

   归属与四种既有交互帧完全同源：sessionId = exec.agent.id（dsh 里 Agent.id 就是
   session 的 id）。网关按占用表门控，拿不到章 / 轮次对不上的一律 abort（fail closed）。

   注册口是唯一的裁剪点（用户已确认「仅会话可用」）：
     · MTNODE_PURE=1（纯净模式）→ 整个不注册；
     · MTNODE_NO_BROWSER=1（画布智能节点 / 长任务未授权的环节）→ 整个不注册；
     · MTNODE_HIDE_TOOLS 点名的工具 → 不注册（真源 tool-visibility.mjs）。
   这些标记都由网关在 spawn 时注入并进 runtime key：同一台运行时只可能有一种可见集，
   提示缓存不会因为「轮内改可见集」而整段失效。
   ========================================================================== */

import { createConnection } from 'node:net'
import { randomUUID } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { hiddenToolsFromEnv } from './tool-visibility.mjs'

export const name = 'mtnode-browser'
export const inject = ['tools']

/** 浏览器工具在「Agent 工具许可」里的隐藏名单名（tool-visibility.mjs 的白名单同名）。 */
export const BROWSER_TOOLS = [
  'browser_launch',
  'browser_snapshot',
  'browser_navigate',
  'browser_click',
  'browser_type',
  'browser_key',
  'browser_eval',
  'browser_wait',
  'browser_screenshot',
  'browser_tabs',
  'browser_network',
  'browser_help',
  'browser_release',
]

const LAUNCH_DESC = `Launch (or reconnect to) the session's OWN browser — a real Edge/Chrome behind its own persistent profile (logins survive across sessions). It always runs as the **in-app view**: the real window is moved off-screen and the page shows live in the session's right-hand "Browser activity" panel, so no separate window pops up on the user's desktop (they can open a real window themselves with the panel's "独立窗口" button — that is their explicit choice for this run).
Zero config: call it before the first browser action; every other browser_* tool auto-launches too.
Returns {exe, port, profileDir, status}. Use browser_snapshot right after to see what the page shows.`

const SNAPSHOT_DESC = `Read the CURRENT page as structure, not as a picture: title, url, visible text, and a numbered list of interactive elements (selector + label + type). That list is what you click by (pass index or selector). Also returns recent console errors and recent network requests.
DEFAULT textLimit = 4000 chars. Screenshots cost image tokens — take one only when you truly need to READ pixels (verify a layout, captcha, chart); browser_snapshot is enough for almost every step.`

const NAV_DESC = `Open a URL (or go back/forward in history) in the session browser. Pass url plus optional history:"back"|"forward". Blocked domains are refused by the host with an explicit error; risky-site domains may raise a one-time confirmation card in the app — read the returned error/receipt and continue.`

const CLICK_DESC = `Click an element by \`index\` (the number from browser_snapshot's element list) or by \`selector\` (CSS). Waits for the page to settle, then returns the receipt; take a fresh browser_snapshot afterwards when you need the new page state.
Dangerous clicks (submit / pay / delete / send / publish / buy …) may stop and ask the user for approval — that is deliberate, not an error.`

const TYPE_DESC = `Type text into the focused element, or into \`selector\` directly (focuses and clears it first). Set submit:true to press Enter afterwards.
NEVER type passwords, card numbers or payment secrets: those must be entered by the user. When you hit a login/payment form, call browser_help with kind:"login" — the user takes the wheel and types it themselves. Pass secret:true only to mark a non-credential field whose content must not be logged.`

const KEY_DESC = `Press one key in the page: Enter / Tab / Escape / Backspace / ArrowUp / ArrowDown / PageDown (or any single key name).`

const EVAL_DESC = `Run a JavaScript expression in the page and return its value (returnByValue). Use it for reading data the snapshot does not expose (structured extraction, scroll position, storage). Keep expressions side-effect free when you only need data; awaitPromise:true when the expression returns a promise.`

const WAIT_DESC = `Wait until a condition holds, up to timeoutMs (default 15000, max 60000): pass selector (element appears) or text (page text contains it); neither = wait for load complete. On timeout the tool fails with a clear message — snapshot the page next rather than waiting again blindly.`

const SHOT_DESC = `Save a PNG screenshot of the page to a local file and return its absolute path. Use it when you must READ the pixels (call mtnode_vision on the path), or to hand the user visual evidence. Prefer browser_snapshot for routine steps — every screenshot you read costs image tokens.`

const TABS_DESC = `Manage tabs in the session browser: action "list" (default) / "new" (optional url) / "select" (targetId) / "close" (targetId). One browser process, several tabs, but only ONE session drives it at a time — a busy browser is reported as an error, never queued.`

const NET_DESC = `Read the recent network activity of the current page: method, status and URL of the last requests (default 20, max 60). Use it to verify that a fetch/save actually reached the server, or to find the API endpoint behind a page.`

/* 求助这件事与 ask_user_question 的**询问模式**完全同一套（用户已确认的口径）：
   同一个询问窗、同一张卡的形状（题面 + 选项 + 自定义回答 + 「回答」键）、同一份
   questions[] 参数与 answers[] 回执，唯一多出来的是浏览器侧的上下文（kind 标题、
   当前 URL、页面截图）。所以参数表就是 ask_user_question 那份：
   一次可问多题（questions[]），每题可给选项（{label, description}）与是否多选。
   kind 只作语义与标题（并决定 login 类是否自动进入接管），不再是「卡型开关」。
   旧参数（message + options）仍收：会被折成一道题，老调用不会失败。 */
const HELP_DESC = `Ask the user for help with the SESSION'S BROWSER — the reason you exist as a coworker rather than a script.
SCOPE (hard rule, enforced by the gateway): use it ONLY when the ask is really about the browser / the page you are working on — a login wall, a captcha, a page result that needs the user's eyes, a page-level choice, a site that blocks you, a dangerous page action. When neither you nor this session has touched the browser in this round, the gateway REFUSES the call and tells you so. For everything else — plan/spec confirmations, code or scope choices, information only the user has, "may I go ahead" — use ask_user_question: that is the general asking entry, and it is the SAME card on screen (same question window, same questions[]/answers[] shape, plus a Markdown summary block).
Use it when you cannot safely continue alone:
- kind:"login" — a login wall / captcha / 2FA / anything that needs a human to interact with the page. The user drives (you are refused until this card is answered; it is auto-released when they answer); do NOT type credentials yourself.
- kind:"verify" — you produced a result and it must be confirmed by the user before you treat it as final or act on it.
- kind:"choice" — you need information or a decision only the user has (scope, target site, which of two results is right).
- kind:"blocked" — you are stuck and cannot proceed; explain exactly what you tried.
- kind:"danger" — an irreversible action needs an explicit go-ahead.

The card is the SAME question card as ask_user_question, so ask with \`questions\` exactly like that tool:
  questions: [{ id, question, header?, detail?, options?: [{label, description?}], multiSelect? }]
One question is often enough: put the headline in \`question\` (the first line becomes the card title line; leave a blank line and the rest is rendered as a Markdown summary block); give 2-4 \`options\` when you are asking the user to choose, and leave them out when the user must type something.
Also useful: \`message\` (short prose shown as the help body; also accepted on its own — it is folded into one question), \`screenshotPath\` (absolute path of a picture that helps them decide) and \`note\` (extra context for the activity log); the current page URL is attached automatically.
Returns {answers:[{id, selected:[...]}], takeover?:true} — takeover:true means the card was a login one and the user now drives; when there is nothing to choose the answers carry what the user typed (an empty selected means they just acknowledged the card). If the user defers/aborts this round the tool FAILS with an error (they did not answer) — do not treat that as consent; wait for their next message or ask again later. After a login the takeover is released automatically: call browser_snapshot again to see the page as it is now.`

const RELEASE_DESC = `Give the browser back when you are done with it: closes nothing, only releases the driving lock so another session (or the user) can use the browser. Logins and tabs stay as they are.`

/* browser_help 的 questions[]（与 ask_user_question 的题面同形：id / question / header /
   detail / options[{label, description}] / multiSelect）。网关侧还会做一次归一
   （补 id、裁长、上限 8 题），模型写歪了也不至于弹不出卡。 */
const QUESTIONS_SPEC = {
  type: 'array',
  description:
    'Same shape as ask_user_question: [{id, question, header?, detail?, options?:[{label, description?}], multiSelect?}]. The first line of `question` becomes the card title line; a blank line starts a Markdown summary block.',
  items: {
    type: 'object',
    additionalProperties: true,
    properties: {
      id: { type: 'string', description: 'Stable short id echoed back in answers (q1, q2 …).' },
      question: {
        type: 'string',
        description: 'The question itself. First line = one-sentence headline; blank line then Markdown = summary block.',
      },
      header: { type: 'string', description: 'Short heading shown before the headline (e.g. 确认 / 取舍).' },
      detail: { type: 'string', description: 'One extra line of context under the headline.' },
      options: {
        type: 'array',
        description: 'Short choices; put the recommended one first and append "（推荐）" to its label.',
        items: {
          type: 'object',
          additionalProperties: true,
          properties: {
            label: { type: 'string', description: 'Option label (one line; inline Markdown allowed).' },
            description: { type: 'string', description: 'One sentence under the label explaining the tradeoff.' },
          },
        },
      },
      multiSelect: { type: 'boolean', description: 'Allow picking several options instead of one.' },
    },
  },
}

export function apply(ctx) {
  const port = Number(process.env.MTNODE_BRIDGE_PORT || 0)
  if (!Number.isInteger(port) || port <= 0) return
  /* 纯净模式 / 画布节点 / 长任务未授权的环节：整个不注册（用户已确认「仅会话可用」）。 */
  const off = envFlagOn('MTNODE_PURE') || envFlagOn('MTNODE_NO_BROWSER')
  if (off) return

  let socket = null
  let buf = ''
  /** @type {Map<string, {resolve:(v:any)=>void, reject:(e:Error)=>void}>} */
  const pending = new Map()

  const send = (obj) => {
    if (socket && !socket.destroyed) {
      try { socket.write(JSON.stringify(obj) + '\n') } catch { /* gateway gone */ }
    }
  };

  const failAll = (err) => {
    for (const [id, p] of pending) {
      pending.delete(id)
      p.reject(err)
    }
  }

  const onLine = (line) => {
    let m
    try { m = JSON.parse(line) } catch { return }
    if (!m || typeof m.id !== 'string') return
    const p = pending.get(m.id)
    if (!p) return
    if (m.t === 'browser-result') {
      pending.delete(m.id)
      if (m.ok === false) p.reject(new Error(String(m.error || '浏览器操作失败')))
      else p.resolve(m.result == null ? { ok: true } : m.result)
    } else if (m.t === 'abort') {
      pending.delete(m.id)
      p.reject(new Error('浏览器操作被中止（本轮已结束，或发起轮不属于当前会话）'))
    }
  }

  const connect = () => {
    const s = createConnection({ host: '127.0.0.1', port })
    socket = s
    s.on('data', (d) => {
      buf += d.toString()
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (line) onLine(line)
      }
    })
    s.on('error', () => {})
    s.on('close', () => {
      if (socket === s) socket = null
      failAll(new Error('浏览器交互通道已断开'))
      setTimeout(connect, 2000)
    })
  }
  connect()

  const rpc = (op, params, exec) => {
    if (!socket || socket.destroyed) {
      return Promise.reject(new Error('浏览器通道不可用（只能在 MTNode 应用内使用）'))
    }
    const id = randomUUID()
    /* 发起轮盖章：agent.id 就是 session id，与 bridge-plugin 的提问帧同源；
       拿不到就发空串，由网关 fail closed（归属不明的浏览器动作绝不该落到别人会话）。 */
    const sessionId = exec && exec.agent ? String(exec.agent.id || '') : ''
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      send({ t: 'browser', id, sessionId, op, params: params || {} })
      const onAbort = () => {
        if (!pending.has(id)) return
        pending.delete(id)
        send({ t: 'drop', id, sessionId })
        reject(new Error('浏览器操作已取消'))
      }
      if (exec && exec.signal) exec.signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  const exec0 = (exec) => exec || {}
  /* defineTool 契约（@deepseek-ai/dsh-tools）：output 必填 —— 缺了它 defineTool 在
     `options.output.render` 上直接抛 TypeError，插件整只装载失败 → 运行时 plugin tree
     起不来 → 每一轮会话都回「cannot create effect on inactive context」。
     浏览器工具的回执是结构化对象（快照 / 截图路径 / 回执），统一按 JSON 文本回给模型；
     渲染成别的 block 类型会丢字段，也让「摘要为主、截图按需」的口径失效。 */
  const rpcOutput = () => ({
    schema: { type: 'object', additionalProperties: true },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
  })
  const register = (tool) => {
    if (hiddenToolsFromEnv().has(tool && tool.name)) return
    ctx.tools.register(tool)
  }

  register(defineTool({
    name: 'browser_launch',
    description: LAUNCH_DESC,
    parameters: {},
    output: rpcOutput(),
    async execute(_args, exec) { return rpc('launch', {}, exec0(exec)) },
  }))

  register(defineTool({
    name: 'browser_snapshot',
    description: SNAPSHOT_DESC,
    parameters: {
      textLimit: { type: 'number', description: 'Visible text budget in characters (default 4000, max 20000).' },
      netLimit: { type: 'number', description: 'How many recent network requests to include (default 20, max 60).' },
    },
    output: rpcOutput(),
    async execute(args, exec) { return rpc('snapshot', args || {}, exec0(exec)) },
  }))

  register(defineTool({
    name: 'browser_navigate',
    description: NAV_DESC,
    parameters: {
      url: { type: 'string', description: 'Absolute http(s) URL to open. Ignored when history is set.' },
      history: { type: 'string', enum: ['back', 'forward'], description: 'Go back / forward instead of opening a URL.' },
      waitMs: { type: 'number', description: 'Extra settle time after navigation (default 1200ms, max 10000).' },
    },
    output: rpcOutput(),
    async execute(args, exec) { return rpc('navigate', args || {}, exec0(exec)) },
  }))

  register(defineTool({
    name: 'browser_click',
    description: CLICK_DESC,
    parameters: {
      index: { type: 'number', description: 'Element number from browser_snapshot output.' },
      selector: { type: 'string', description: 'CSS selector (used when index is absent or misses).' },
      waitMs: { type: 'number', description: 'Settle time after the click (default 1200ms).' },
    },
    output: rpcOutput(),
    async execute(args, exec) { return rpc('click', args || {}, exec0(exec)) },
  }))

  register(defineTool({
    name: 'browser_type',
    description: TYPE_DESC,
    parameters: {
      text: { type: 'string', description: 'Text to type. Never credentials or payment secrets.' },
      selector: { type: 'string', description: 'CSS selector of the field (omit to type into whatever is focused).' },
      submit: { type: 'boolean', description: 'Press Enter after typing.' },
      secret: { type: 'boolean', description: 'Mark the field sensitive: the value is never written to the activity log.' },
      waitMs: { type: 'number', description: 'Settle time after typing (default 800ms).' },
    },
    output: rpcOutput(),
    async execute(args, exec) { return rpc('type', args || {}, exec0(exec)) },
  }))

  register(defineTool({
    name: 'browser_key',
    description: KEY_DESC,
    parameters: {
      key: { type: 'string', description: 'Key name: Enter / Tab / Escape / Backspace / ArrowUp / ArrowDown / PageDown / any single key.' },
      waitMs: { type: 'number', description: 'Settle time after the key (default 800ms).' },
    },
    output: rpcOutput(),
    async execute(args, exec) { return rpc('key', args || {}, exec0(exec)) },
  }))

  register(defineTool({
    name: 'browser_eval',
    description: EVAL_DESC,
    parameters: {
      expression: { type: 'string', description: 'JavaScript expression evaluated in the page.' },
      awaitPromise: { type: 'boolean', description: 'Await the result when the expression returns a promise.' },
      note: { type: 'string', description: 'Short human-readable reason, recorded in the activity log.' },
    },
    output: rpcOutput(),
    async execute(args, exec) { return rpc('eval', args || {}, exec0(exec)) },
  }))

  register(defineTool({
    name: 'browser_wait',
    description: WAIT_DESC,
    parameters: {
      selector: { type: 'string', description: 'Wait until this element exists.' },
      text: { type: 'string', description: 'Wait until the page text contains this string.' },
      timeoutMs: { type: 'number', description: 'Timeout in ms (default 15000, max 60000).' },
    },
    output: rpcOutput(),
    async execute(args, exec) { return rpc('wait', args || {}, exec0(exec)) },
  }))

  register(defineTool({
    name: 'browser_screenshot',
    description: SHOT_DESC,
    parameters: {
      fullPage: { type: 'boolean', description: 'Capture the whole page instead of the viewport.' },
      format: { type: 'string', enum: ['png', 'jpeg'], description: 'Image format (default png).' },
      label: { type: 'string', description: 'Short label recorded in the activity log.' },
    },
    output: rpcOutput(),
    async execute(args, exec) { return rpc('screenshot', args || {}, exec0(exec)) },
  }))

  register(defineTool({
    name: 'browser_tabs',
    description: TABS_DESC,
    parameters: {
      action: { type: 'string', enum: ['list', 'new', 'select', 'close'], description: 'Tab action (default list).' },
      url: { type: 'string', description: 'URL for action "new".' },
      targetId: { type: 'string', description: 'Tab id for "select" / "close".' },
    },
    output: rpcOutput(),
    async execute(args, exec) { return rpc('tabs', args || {}, exec0(exec)) },
  }))

  register(defineTool({
    name: 'browser_network',
    description: NET_DESC,
    parameters: {
      limit: { type: 'number', description: 'How many recent requests (default 20, max 60).' },
    },
    output: rpcOutput(),
    async execute(args, exec) { return rpc('network', args || {}, exec0(exec)) },
  }))

  register(defineTool({
    name: 'browser_help',
    description: HELP_DESC,
    parameters: {
      kind: { type: 'string', enum: ['login', 'verify', 'choice', 'blocked', 'danger'], description: 'Why you need the user (semantics + card title; "login" also takes the wheel for them).' },
      questions: QUESTIONS_SPEC,
      message: { type: 'string', description: 'Short prose shown as the help body, in the user\'s language. Optional when `questions` already says everything (folded into one question when used alone).' },
      options: { type: 'array', items: { type: 'string' }, description: 'Legacy short choices used together with `message` (folded into one question). Prefer options inside `questions`.', },
      screenshotPath: { type: 'string', description: 'Absolute path of a screenshot that helps the user decide.' },
      note: { type: 'string', description: 'Extra context recorded in the activity log.' },
    },
    output: rpcOutput(),
    async execute(args, exec) { return rpc('help', args || {}, exec0(exec)) },
  }))

  register(defineTool({
    name: 'browser_release',
    description: RELEASE_DESC,
    parameters: {},
    output: rpcOutput(),
    async execute(_args, exec) { return rpc('release', {}, exec0(exec)) },
  }))
}

/** env 真值口径：1 / on / true / yes（其余含缺席一律关）。 */
function envFlagOn(key) {
  let raw = ''
  try { raw = String(process.env[key] || '').trim().toLowerCase() } catch { return false }
  return raw === '1' || raw === 'on' || raw === 'true' || raw === 'yes'
}