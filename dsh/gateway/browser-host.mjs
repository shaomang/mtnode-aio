/* ============================================================================
   browser-host.mjs — MTNode 会话自己的浏览器（网关侧唯一持有进程与 CDP 的地方）

   哲学（参考 CopilotKit/OpenBot 的 “a computer per Bot”）：
     会话＝一个同事，它有一台自己的电脑：一份常驻浏览器（自己的登录态、自己的
     用户数据目录），所有动作都经这一处、都能被看见（活动流）、危险动作都要过闸。
     本文件只负责「进程 + CDP + 页面读取」，不做工具注册（那是
     browser-plugin.mjs 的事），也不做安全裁决（网关按帧问答）。

   底座（用户已确认）：系统 Edge/Chrome + CDP 直驱 + 独立用户数据目录。
     · 零新依赖：CDP 走 Node ≥22 内置的全局 WebSocket（Electron 39 内置 Node 22.22
       与独立 Node 24 都有），不引 playwright / puppeteer，也不随包发浏览器内核。
     · 用户数据目录固定落在应用数据目录下（%APPDATA%\pipeline-console\browser-profile），
       全局一份、跨会话保持登录态（用户已确认的口径）。
     · 浏览器崩溃 / 配置被锁 / 端口失效 → 自动重启一次（本文件自己恢复，不打扰模型）。

   本文件 import 只允许 node 内置（与 bridge/canvas 插件同一纪律），isolated。
   ========================================================================== */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'

/* ── 候选浏览器：Windows 优先 Edge（本机实测只有 Edge），macOS / Linux 给对应候选 ──
   用户已确认「写通用探测链，但只在 Windows 上验收」：找不到任何候选 → 明确报错
   （由调用方折算成工具错误文本 + 一句安装指引），绝不静默假装成功。 */
export function browserCandidates() {
  const env = process.env
  const win = [
    env['ProgramFiles(x86)'] && join(env['ProgramFiles(x86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    env.ProgramFiles && join(env.ProgramFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    env.ProgramFiles && join(env.ProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    env['ProgramFiles(x86)'] && join(env['ProgramFiles(x86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
    env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ]
  const mac = [
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ]
  const linux = [
    '/usr/bin/microsoft-edge',
    '/usr/bin/microsoft-edge-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ]
  return (process.platform === 'darwin' ? mac : process.platform === 'linux' ? linux : win).filter(Boolean)
}

/** 本机可用的浏览器可执行文件绝对路径（找不到回空串）。 */
export function detectBrowser() {
  for (const p of browserCandidates()) {
    try { if (p && existsSync(p)) return p } catch { /* 权限不足等：换下一个 */ }
  }
  return ''
}

/* ── 危险动作判据（域名名单 + 危险动作，用户已确认「固定几类可控项」）──
   名单本身落在数据目录下的 JSON（活动流面板可编辑），这里只做纯函数判定，
   免得把策略散到调用方。 */
const DANGEROUS_WORDS = [
  '提交', '确认提交', '下单', '支付', '购买', '结算', '删除', '移除', '注销',
  '发送', '发布', '确认支付', '立即购买', 'submit', 'buy', 'purchase', 'pay', 'delete',
  'remove', 'send', 'publish', 'confirm order', 'checkout',
]

/** 一次点击/按键是否属于「危险动作」（回 {danger:true, why}，否则 {danger:false}）。 */
export function dangerOfClick(text, selector) {
  const t = (String(text || '') + ' ' + String(selector || '')).toLowerCase()
  for (const w of DANGEROUS_WORDS) {
    if (t.includes(w.toLowerCase())) return { danger: true, why: `命中危险动作关键词「${w}」` }
  }
  if (/type=["']?submit|form\s+action|javascript:void\(0\)[^>]*onclick/i.test(String(selector || '')))
    return { danger: true, why: '命中表单提交类元素' }
  return { danger: false, why: '' }
}

/** 默认名单（首次启动时写盘，之后以盘上的为准）。 */
export const DEFAULT_POLICY = Object.freeze({
  /* 黑名单：一律拒绝导航（硬拦截，不问用户）。默认为空 —— 不替用户封网站，
     要封的在这里加（面板里可编辑）。注意判据是「域名或它的子域」精确匹配，
     绝不拿子串去套（`bank` 这种词会把 bankofamerica.com 一起误伤）。 */
  blocked: [],
  /* 风险站点：首次访问弹一次确认卡（用户确认后本会话放行）。
     只列「误点进去代价高」的几类：邮箱 / 社交 / 支付 / 网银。 */
  confirm: [
    'mail.google.com', 'outlook.office.com', 'web.whatsapp.com',
    'x.com', 'twitter.com', 'facebook.com', 'linkedin.com',
    'paypal.com', 'alipay.com', 'stripe.com',
    'chase.com', 'bankofamerica.com', 'wellsfargo.com', 'icbc.com.cn', 'ccb.com',
  ],
  /* 危险动作是否必须过审批卡（默认开；关掉＝危险动作直接执行，不建议） */
  approveDangerous: true,
})

export function hostOf(url) {
  try { return new URL(String(url)).host.toLowerCase() } catch { return '' }
}

/** 域名判定：返回 {blocked:bool, confirm:bool, why}。 */
export function domainVerdict(url, policy) {
  const p = policy && typeof policy === 'object' ? policy : DEFAULT_POLICY
  const h = hostOf(url)
  if (!h) return { blocked: false, confirm: false, why: '' }
  /* 判据 = 「域名本身」或「它的子域」：`mail.google.com` 命中 `google.com`，
     但 `bankofamerica.com` 绝不被 `bank` 命中 —— 名单是按域写的，不是按关键词。 */
  const hit = (list) => (Array.isArray(list) ? list : []).some((d) => d && (h === d || h.endsWith('.' + d)))
  if (hit(p.blocked)) return { blocked: true, confirm: false, why: `域名 ${h} 在拦截名单里` }
  if (hit(p.confirm)) return { blocked: false, confirm: true, why: `域名 ${h} 属风险站点，首次访问需你确认` }
  return { blocked: false, confirm: false, why: '' }
}

export function normalizePolicy(raw) {
  const r = raw && typeof raw === 'object' ? raw : {}
  const list = (v) => (Array.isArray(v) ? v.map((x) => String(x || '').trim().toLowerCase()).filter(Boolean) : [])
  const blocked = list(r.blocked)
  const confirm = list(r.confirm)
  return {
    blocked,
    confirm: confirm.length ? confirm : DEFAULT_POLICY.confirm.slice(),
    approveDangerous: r.approveDangerous !== false,
  }
}

/* ── CDP 客户端（极简：一页一连接，按 id 配平响应，事件按需订阅）───────────── */
class Cdp {
  constructor(wsUrl) {
    this.wsUrl = wsUrl
    this.ws = null
    this.seq = 0
    this.pending = new Map()
    this.handlers = new Set()
    this.closed = false
  }
  async open() {
    if (typeof WebSocket !== 'function') throw new Error('本运行时没有内置 WebSocket，无法驱动浏览器（需要 Node ≥22）')
    const ws = new WebSocket(this.wsUrl)
    this.ws = ws
    await new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error('连接浏览器调试端口超时')), 15000)
      ws.addEventListener('open', () => { clearTimeout(to); resolve() }, { once: true })
      ws.addEventListener('error', (e) => { clearTimeout(to); reject(new Error('浏览器调试端口连接失败：' + String((e && e.message) || e))) }, { once: true })
    })
    ws.addEventListener('message', (ev) => {
      let m
      try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)) } catch { return }
      if (m && m.id != null && this.pending.has(m.id)) {
        const p = this.pending.get(m.id)
        this.pending.delete(m.id)
        if (m.error) p.reject(new Error(String((m.error && m.error.message) || 'CDP 错误')))
        else p.resolve(m.result == null ? {} : m.result)
        return
      }
      if (m && m.method) {
        for (const h of this.handlers) {
          try { h(m) } catch { /* 单个订阅者出错不影响其余 */ }
        }
      }
    })
    ws.addEventListener('close', () => {
      this.closed = true
      for (const [, p] of this.pending) p.reject(new Error('浏览器连接已断开'))
      this.pending.clear()
    })
    return this
  }
  on(fn) { this.handlers.add(fn); return () => this.handlers.delete(fn) }
  send(method, params, timeoutMs) {
    if (!this.ws || this.closed) return Promise.reject(new Error('浏览器连接已断开'))
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      const to = setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('浏览器指令超时：' + method)) }
      }, Number(timeoutMs) > 0 ? Number(timeoutMs) : 30000)
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(to); resolve(v) },
        reject: (e) => { clearTimeout(to); reject(e) },
      })
      try { this.ws.send(JSON.stringify({ id, method, params: params || {} })) } catch (e) {
        clearTimeout(to); this.pending.delete(id); reject(e)
      }
    })
  }
  close() {
    try { if (this.ws && !this.closed) this.ws.close() } catch { /* 已断 */ }
    this.closed = true
  }
}

/* ── 单例状态 ──────────────────────────────────────────────────────────────
   一个浏览器进程、多标签、驱动串行化（用户已确认的口径）：
     · 进程与 profile 是全局一份（登录态跨会话保持）；
     · `driver` = 此刻正在驱动的那条会话（串行锁）；别人来驱动时得到明确错误文本，
       而不是两个会话同时戳同一个页面。 */
const state = {
  proc: null,
  exe: '',
  port: 0,
  profileDir: '',
  cdp: null,
  targetId: '',
  driver: '',            // 当前持有驱动的 sessionId（'' = 空闲）
  lastActivityAt: 0,
  logs: [],              // 页内动作 / 命令留痕（网关转成活动流事件）
  logSeq: 0,
  pageErrors: [],        // 页内控制台错误（活动流里能看到页面报了什么错）
  net: [],               // 最近网络请求（方法 / 状态 / URL）
  takeover: { on: false, at: 0, sessionId: '' },
  /* 实况视图（会话右边栏的「实况」区，见本文件末「实况流」一节）：
     帧只走内存回调，**绝不落库、绝不进模型上下文**。 */
  view: { sink: null, on: false, seq: 0, at: 0, w: 0, h: 0, dpr: 1, lastFrameAt: 0, lastAckAt: 0, shots: 0, fallback: false, reason: '' },
  /* docked = 面板实况（真实窗口移出可视区）；detached = 独立窗口。
     「独立窗口」只是**本次浏览器运行内的例外**（用户在面板上亲手点的）：进程一起来
     一律 docked（见 parkSessionWindow / ensureBrowser），重启浏览器就回到默认内部界面 —— 
     界面侧不再把它写进 localStorage 当跨重启的记忆（那会让一个历史选择推翻默认口径）。 */
  viewMode: 'docked',
  viewBounds: null,          // docked 前的真实窗口位置（detached 时还原）
  /* 这一只浏览器是不是**无窗口（headless）**起的（见 launchArgs 的 headless 一节）：
     会话自动拉起一律无窗口 —— 屏幕上不弹真窗口、不占任务栏，画面只走右栏实况；
     只有用户亲手点「打开浏览器」那一次才是带窗口的一只。
     view.status 会把 headlessMode 回给渲染层，面板据此说明「这只没有窗口可摆」。 */
  headless: false,
  /* 真实窗口「是不是已经被搬出可视区」——与 viewMode 是两件事：
     viewMode 只是「想要的形态」（默认就是 docked），而新起的浏览器窗口就摆在屏幕上。
     不分开记：开流那一步会以为「已经是 docked 了，不必搬」，窗口就一直戳在用户眼前
     （用户报的「面板里有画面、屏幕上还多一只 Edge」就是这个）。 */
  viewParked: false,
}

export function profileDirOf(dshHome) {
  const home = String(dshHome || '').trim()
  const base = home ? join(home, '..') : join(tmpdir(), 'mtnode-dsh')
  return join(base, 'browser-profile')
}

export function _state() { return state }

/* 动作留痕（网关读走并转成活动流；只留摘要，完整输出由工具回执自己带） */

/** 活动流投递钩子（网关注册；未注册时留痕只堆在内存里，行为与接入前一致）。 */
let activitySink = null
export function registerActivitySink(fn) { activitySink = typeof fn === 'function' ? fn : null }

function note(kind, text, extra) {
  const item = { seq: ++state.logSeq, at: Date.now(), kind, text: String(text || '').slice(0, 400), ...(extra || {}) }
  state.logs.push(item)
  if (state.logs.length > 200) state.logs.splice(0, state.logs.length - 200)
  if (activitySink) {
    try { activitySink(item) } catch { /* 活动流投递失败绝不影响浏览器动作 */ }
  }
  return item
}

/** 取走动作留痕（活动流面板 + 落库共用；取后即清，避免重复上报）。 */
export function drainLogs() {
  const out = state.logs.slice()
  state.logs.length = 0
  return out
}

/* ── 进程管理 ────────────────────────────────────────────────────────────
   窗口模式（headless，用户口径）：
     · 会话自动拉起（browser_launch / 按需自动拉起）**一律无窗口** —— 开发 / 会话过程中
       屏幕上不弹真实窗口、也不占任务栏，画面只走右栏实况（Page.startScreencast 在
       headless=new 下照常出帧，本机实测 2 帧 / 截图与导航全通）。
       历史 bug：以前起的是带窗口的 Edge，靠 parkSessionWindow 把窗口搬到 -2400,-2400；
       该机器上离屏窗口不出帧时，1.5s 看门狗又会把窗口搬回屏幕（left:40,top:40）——
       用户看到的就是「开发过程中又开出一只 Edge」（而不是在中栏预览里看开发过程）。
     · 只有**用户亲手点「打开浏览器」**那一次才带窗口（visible:true）：
       真正看见一只 Edge 是用户自己的显式选择，那时右栏的「独立窗口」才有意义。 */
function launchArgs(exe, profileDir, port, headless) {
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    /* 实况流（docked / headless）把窗口移出可视区后，Chromium 默认会把被遮挡的窗口降级、
       直接停掉渲染 —— 右下栏就永远等不到帧。这一组特性关掉让它照常出帧。 */
    '--disable-features=Translate,OptimizationHints,CalculateNativeWinOcclusion',
    '--disable-backgrounding-occluded-windows',
    '--disable-sync',
    '--password-store=basic',
    'about:blank',
  ]
  /* 无窗口模式：没有真窗口可弹、没有可摆的位姿，画面与截图全走 CDP（本机实测通过）。 */
  if (headless) args.unshift('--headless=new')
  /* 非 Windows 上从 root 跑 Chrome 需要 --no-sandbox；Windows 不加（会降安全） */
  if (process.platform === 'linux' && typeof process.getuid === 'function' && process.getuid() === 0) args.unshift('--no-sandbox')
  return args
}

async function fetchJson(url, timeoutMs) {
  const ctl = new AbortController()
  const to = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const r = await fetch(url, { signal: ctl.signal })
    if (!r.ok) throw new Error('HTTP ' + r.status)
    return await r.json()
  } finally { clearTimeout(to) }
}

/** 等调试端点起来（进程刚起时要几百毫秒；最多 ~12s）。 */
async function waitDebugPort(port, deadlineMs) {
  const end = Date.now() + (deadlineMs || 12000)
  let last = ''
  while (Date.now() < end) {
    try {
      const v = await fetchJson(`http://127.0.0.1:${port}/json/version`, 1500)
      if (v && v.webSocketDebuggerUrl) return v
      last = '调试端点无 webSocketDebuggerUrl'
    } catch (e) { last = String((e && e.message) || e) }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error('浏览器调试端口没起来（' + last + '）')
}

async function pickFreePort() {
  /* 不用 0：CDP 的 --remote-debugging-port 需要具体端口。在 9222–9399 里挑一个没人听的。 */
  const net = await import('node:net')
  for (let p = 9222; p < 9400; p++) {
    const free = await new Promise((resolve) => {
      const srv = net.createServer()
      srv.once('error', () => resolve(false))
      srv.once('listening', () => srv.close(() => resolve(true)))
      try { srv.listen(p, '127.0.0.1') } catch { resolve(false) }
    })
    if (free) return p
  }
  return 9222
}

/** 确保浏览器在跑并拿到一条 CDP 页面连接。
 *
 *  窗口模式由 opts.visible 决定（缺省 = 无窗口，见 launchArgs 顶部那一节）：
 *   · 缺省 / visible:false → **无窗口**起（会话自动拉起的那条路）；
 *   · visible:true → 带窗口起（只有用户在面板上亲手点「打开浏览器」才走）。
 *  已经在跑的那只若不匹配请求的模式：无窗口的请求照旧复用（随后 parkSessionWindow
 *  会把带窗口那只移出可视区），带窗口的请求则**重起一只**——用户点「打开浏览器」
 *  就是想亲眼看见它，复用一只看不见的无窗口进程等于这个按钮点不动。 */
export async function ensureBrowser(opts) {
  const o = opts && typeof opts === 'object' ? opts : {}
  const exe = detectBrowser()
  if (!exe) {
    throw new Error(
      '没有找到可驱动的浏览器：请先安装 Microsoft Edge 或 Google Chrome（Windows 上 Edge 通常已随系统安装），装好后重试。',
    )
  }
  const profileDir = String(o.profileDir || state.profileDir || profileDirOf(o.dshHome))
  try { mkdirSync(profileDir, { recursive: true }) } catch { /* 已存在或权限问题：起进程时再报 */ }
  state.profileDir = profileDir
  state.exe = exe
  const wantVisible = !!o.visible

  if (state.proc && !state.proc.killed && state.port && state.cdp && !state.cdp.closed) {
    /* 要带窗口、在跑的却是无窗口那只 → 重起（用户亲手点的「打开浏览器」说了算） */
    if (wantVisible && state.headless) await stopBrowser({ silent: true })
    else return { exe, port: state.port, profileDir, reused: true, headless: !!state.headless }
  }
  /* 上一次进程死了 / 没起过：清干净再起（崩溃恢复＝自动重启，不打扰模型） */
  await stopBrowser({ silent: true })

  const headless = !wantVisible
  const port = await pickFreePort()
  const proc = spawn(exe, launchArgs(exe, profileDir, port, headless), {
    stdio: 'ignore',
    detached: false,
    /* 无窗口那只绝不该闪出任何窗体；带窗口那只的真窗体是 Edge 自己的，不受这项影响。 */
    windowsHide: true,
  })
  state.proc = proc
  state.port = port
  state.headless = headless
  /* 新起的窗口（带窗口那只）一定在屏幕上（默认位置）：形态想要的还是 docked，
     但「已经搬走」这件事必须从头算起 —— 否则开流时不会补搬（见 viewParked 注释）。
     形态一并归零到 docked：「独立窗口」是用户上一次浏览器运行里的例外，
     进程重启/换端口就是新的一只（调用方若要立刻停靠，紧接着走 parkSessionWindow）。 */
  state.viewParked = headless
  state.viewMode = 'docked'
  proc.on('exit', () => { if (state.proc === proc) { state.proc = null; state.cdp = null; state.targetId = ''; state.driver = ''; state.viewParked = false; state.viewMode = 'docked'; state.headless = false } })
  proc.on('error', () => { if (state.proc === proc) { state.proc = null; state.cdp = null; state.viewParked = false; state.viewMode = 'docked'; state.headless = false } })

  const ver = await waitDebugPort(port, o.timeoutMs)
  const page = await ensurePageTarget(ver.webSocketDebuggerUrl).catch(() => null)
  if (!page || !page.wsUrl) throw new Error('浏览器起来了，但没有可用页面（可用标签页为空）')
  const cdp = await new Cdp(page.wsUrl).open()
  state.cdp = cdp
  state.targetId = page.targetId || ''
  attachConsole(cdp)
  note('browser', '浏览器已启动（' + (exe.includes('msedge') ? 'Edge' : exe.includes('chrome') ? 'Chrome' : exe) + (headless ? ' · 无窗口' : ' · 带窗口') + '）')
  return { exe, port, profileDir, reused: false, headless }
}

/** 找一条普通页面 target 并连上它（没有就开一条）。 */
async function ensurePageTarget(browserWsUrl) {
  const bws = await new Cdp(browserWsUrl).open()
  try {
    const { targetInfos } = await bws.send('Target.getTargets', {}, 8000)
    const pages = (targetInfos || []).filter((t) => t && t.type === 'page' && !String(t.url || '').startsWith('devtools://'))
    let target = pages.find((t) => /^https?:/.test(String(t.url || ''))) || pages[0]
    if (!target) {
      const c = await bws.send('Target.createTarget', { url: 'about:blank' }, 8000)
      target = { targetId: c.targetId }
    }
    state.targetId = target.targetId
    const { targetInfo } = await bws.send('Target.getTargetInfo', { targetId: target.targetId }, 8000)
    /* 取该页自己的 webSocketDebuggerUrl：/json/list 里有，Target 事件里没有，直接打一次 HTTP
       （同一浏览器端点，稳定且不引额外依赖）。 */
    const list = await fetchJson(`http://127.0.0.1:${state.port}/json/list`, 4000).catch(() => [])
    const hit = (Array.isArray(list) ? list : []).find((t) => t && t.id === target.targetId)
    if (hit && hit.webSocketDebuggerUrl) return { targetId: target.targetId, wsUrl: hit.webSocketDebuggerUrl }
    const wsUrl = targetInfo && targetInfo.webSocketDebuggerUrl
    if (wsUrl) return { targetId: target.targetId, wsUrl }
    throw new Error('拿不到页面调试地址')
  } finally { bws.close() }
}

/** 换一条页面 target（新开标签页 / 切标签）：把 CDP 连接挪过去。 */
export async function useTarget(targetId) {
  if (!state.proc || !state.port) throw new Error('浏览器还没启动')
  const list = await fetchJson(`http://127.0.0.1:${state.port}/json/list`, 4000)
  const hit = (Array.isArray(list) ? list : []).find((t) => t && t.id === targetId)
  if (!hit || !hit.webSocketDebuggerUrl) throw new Error('找不到该标签页：' + String(targetId || ''))
  if (state.cdp) state.cdp.close()
  state.cdp = await new Cdp(hit.webSocketDebuggerUrl).open()
  state.targetId = targetId
  attachConsole(state.cdp)
  note('browser', '切到标签页 ' + (hit.title || hit.url || targetId))
  return hit
}

/** 页内控制台错误留痕（活动流里能看到它报了什么错）。 */
function attachConsole(cdp) {
  state.pageErrors = []
  try {
    cdp.send('Runtime.enable', {}, 5000).catch(() => {})
    cdp.send('Log.enable', {}, 5000).catch(() => {})
    cdp.send('Network.enable', { maxTotalBufferSize: 2 * 1024 * 1024 }, 5000).catch(() => {})
  } catch { /* 老内核没有这些域：不影响主链路 */ }
  cdp.on((m) => {
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params && m.params.exceptionDetails
      const txt = d && (d.exception && d.exception.description || d.text || '')
      if (txt) state.pageErrors.push({ at: Date.now(), text: String(txt).slice(0, 300) })
    } else if (m.method === 'Log.entryAdded') {
      const e = m.params && m.params.entry
      if (e && e.level === 'error' && e.text) state.pageErrors.push({ at: Date.now(), text: String(e.text).slice(0, 300) })
    } else if (m.method === 'Network.requestWillBeSent') {
      const r = m.params && m.params.request
      if (r && r.url) {
        state.net.push({ at: Date.now(), url: String(r.url).slice(0, 300), method: r.method || 'GET', status: 0, type: m.params.type || '' })
        if (state.net.length > 120) state.net.splice(0, state.net.length - 120)
      }
    } else if (m.method === 'Network.responseReceived') {
      const resp = m.params && m.params.response
      if (resp && resp.url) {
        for (let i = state.net.length - 1; i >= 0; i--) {
          if (state.net[i].url === resp.url) { state.net[i].status = resp.status; break }
        }
      }
    }
  })
  if (!state.net) state.net = []
}

/* ── 把浏览器窗口拿到前台（**只在用户亲手点「独立窗口」时用**）───────────────
   用户口径（本轮已确认）：默认形态是**内部界面**，真实窗口一律让位；只有面板上那句
   「独立窗口」是例外（见 detachWindow）。窗口可能被别的窗压住 —— 走 CDP 的
   Browser.getWindowForTarget + setWindowBounds(state:'normal') + Page.bringToFront
   把它抬上来。抬不动不算失败（个别系统不抢焦点），所以只回 {ok}。
   历史上登录求助卡也在这里抬窗口，本轮已撤（那是「又开出一个窗口」的第二条来源，
   接管 / 登录都在右栏实况里做）。 */
export async function bringToFront() {
  const proc = state.proc
  if (!proc || !state.port) return { ok: false, reason: '浏览器还没启动' }
  try {
    /* 浏览器级端点要先问 /json/version（端口上的 ws 路径带 uuid，不能自己拼） */
    const ver = await fetchJson(`http://127.0.0.1:${state.port}/json/version`, 4000)
    const wsUrl = ver && ver.webSocketDebuggerUrl
    if (!wsUrl) return { ok: false }
    const bws = await new Cdp(wsUrl).open()
    try {
      /* ① 窗口若是最小化的先还原成正常态（否则「抬到前台」等于什么都没做） */
      if (state.targetId) {
        try {
          const { windowId } = await bws.send('Browser.getWindowForTarget', { targetId: state.targetId }, 4000)
          if (windowId) await bws.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } }, 4000)
        } catch { /* 老版本没有这个方法：跳过还原，只抬前台 */ }
      }
      /* ② 把这一页抬到前台（同一浏览器的其它标签都压下去） */
      if (state.cdp && !state.cdp.closed) {
        try { await state.cdp.send('Page.bringToFront', {}, 4000) } catch { /* 个别平台不抢焦点 */ }
      }
      return { ok: true }
    } finally { bws.close() }
  } catch { return { ok: false } }
}

/* ── 实况流（会话右边栏的「实况」区）────────────────────────────────────────
   用户口径：浏览器默认 dock 在会话主内容右边栏（实况可交互），可「提出来」变回
   独立窗口、「收回」再 dock；**没被调用或浏览器没启动时整条不显示**。

   三条纪律（实现全在本文件，网关只做转发）：
     · 帧只走内存回调（registerViewSink），**绝不落库、绝不进模型上下文**；
     · 流控靠 Page.screencastFrameAck：慢客户端不 ack 的帧不会堆积，stdio 不会被灌爆；
       同时按最小帧间隔丢中间帧（末帧必达）；
     · 窗口形态：docked 把真实窗口移出可视区、靠 screencast 出帧（该机器上离屏不出帧时
       由看门狗回落成「窗口停在屏幕上 + 面板照常出帧」，状态里标 fallback）；
       detached 让真实窗口可见并置前，面板只显示「已在独立窗口」。

   输入转发：调用方（渲染层画布）给 CSS 像素 + 画布显示尺寸，这里按真实视口换算后
   派发 mouse / wheel / key / insertText —— 面板里点得动、滚得动、打得进字。 */

/** 帧输出钩子（网关注册）。帧是内存对象 {seq,w,h,dpr,frame}，不经活动流、不落库。 */
export function registerViewSink(fn) { state.view.sink = typeof fn === 'function' ? fn : null }

const VIEW_JPEG_QUALITY = 72
const VIEW_MAX_WIDTH = 1280
const VIEW_MAX_HEIGHT = 800
/* 最小帧间隔（≈12fps 上限）：比这更密的帧直接丢（仍 ack），末帧必达 */
const VIEW_MIN_INTERVAL_MS = 80

/* 离屏窗口不出帧时的回落角；纯 CDP 拿不到屏幕尺寸，用保守值。 */
const VIEW_FALLBACK_BOUNDS = { left: 40, top: 40, width: 1100, height: 760 }
const VIEW_OFFSCREEN_BOUNDS = { left: -2400, top: -2400, width: 1280, height: 860 }

async function withBrowserCdp(fn) {
  if (!state.port) return null
  const ver = await fetchJson(`http://127.0.0.1:${state.port}/json/version`, 4000)
  const wsUrl = ver && ver.webSocketDebuggerUrl
  if (!wsUrl) return null
  const bws = await new Cdp(wsUrl).open()
  try { return await fn(bws) } finally { bws.close() }
}

/** 把真实窗口摆到 bounds（拿不到 windowId / 老内核不支持时回 false，不算失败）。 */
async function setRealWindowBounds(bounds) {
  try {
    return await withBrowserCdp(async (bws) => {
      if (!state.targetId) return false
      const { windowId } = await bws.send('Browser.getWindowForTarget', { targetId: state.targetId }, 4000)
      if (!windowId) return false
      try {
        await bws.send('Browser.setWindowBounds', { windowId, bounds: { ...bounds, windowState: 'normal' } }, 4000)
        return true
      } catch {
        /* 个别平台不接受负坐标：退回 normal 态，靠 bringToFront 兜底 */
        try { await bws.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } }, 4000) } catch {}
        return false
      }
    })
  } catch { return false }
}

/* 导出给冒烟用：真机断言「窗口到底有没有离开可视区」，不看返回值自己说。 */
export async function readRealWindowBounds() {
  try {
    return await withBrowserCdp(async (bws) => {
      if (!state.targetId) return null
      const { windowId } = await bws.send('Browser.getWindowForTarget', { targetId: state.targetId }, 4000)
      if (!windowId) return null
      const r = await bws.send('Browser.getWindowBounds', { windowId }, 4000)
      return (r && r.bounds) || null
    })
  } catch { return null }
}

/** 会话启用浏览器时的**默认形态**：内部界面（真实窗口一律移出可视区，画面只走实况流）。
 *
 *  用户口径（已确认）：启用浏览器不该「另开一个新窗口」—— 浏览器进程照常起（profile 与
 *  登录态不变），但真实窗口立刻让位，人只在会话右边栏的实况区里看与操作。少了这一步，
 *  网关 spawn 出来的窗口就戳在屏幕上（只有「实况流真连上」那条路才会搬运它，而那条路
 *  依赖渲染层面板恰好开着 → 用户看到的就是「又开出一只 Edge」）。
 *
 *  · 已经在跑（复用）且不在落点时也搬一次：**幂等**，调用方可每次 launch 都放心调；
 *  · 搬不动（老内核 / 平台不接受负坐标）→ `{ok:false, reason}`，并把实况的 fallback 标出来：
 *    真实窗口可能还在屏幕上，但画面照常出（与 startViewStream 的看门狗同一口径）；
 *  · 用户亲手点过「独立窗口」的这一轮不会被它顶掉：调用方（网关）只在「不是 detached」
 *    时才把它当默认形态，见 BrowserCtl.viewStart / handle 的 launch 分支。 */
export async function parkSessionWindow() {
  if (!state.proc || !state.port) return { ok: false, reason: '浏览器还没启动' }
  /* 无窗口那只（会话自动拉起的默认）：没有真窗口可搬，直接算「已经让位」——
     绝不能在这里读窗口位姿（headless 下 Browser.getWindowForTarget 拿不到 windowId），
     否则会把 fallback 标上、面板上白写一句「真实窗口可能仍在屏幕上」。 */
  if (state.headless) {
    state.viewMode = 'docked'
    state.viewParked = true
    state.view.fallback = false
    state.view.reason = ''
    emitView({ event: 'mode' })
    return { ok: true, parked: true, headless: true, reason: '', ...viewStatus() }
  }
  const before = await readRealWindowBounds()
  if (before && Number.isFinite(before.left) && Number.isFinite(before.top) && !isAtParkingSpot(before)) {
    state.viewBounds = { left: before.left, top: before.top, width: before.width, height: before.height }
  }
  const okOff = await setRealWindowBounds(VIEW_OFFSCREEN_BOUNDS)
  state.viewMode = 'docked'
  state.viewParked = !!okOff
  if (!okOff) {
    state.view.fallback = true
    state.view.reason = state.view.reason || '这台机器不接受把窗口移出可视区；真实窗口可能仍在屏幕上（画面以右栏实况为准）。'
  }
  emitView({ event: 'mode' })
  return {
    ok: !!okOff,
    parked: !!okOff,
    reason: okOff ? '' : '这台机器不接受把窗口移出可视区；真实窗口可能仍在屏幕上。',
    ...viewStatus(),
  }
}

/** 把真实窗口恢复成一只**今天能用的**独立窗口（面板上那句「点一下去独立窗口」的义）。
 *  与 setViewMode('detached') 分开的原因：这里可以不落 viewMode（由调用方决定），
 *  并且**必须**兜住「窗口在 -2400,-2400 看不见」这件事 —— 位姿没还原成功就不算成功，
 *  调用方据此把面板文案落到实处（「窗口没恢复成功，请再点一次或改用右栏」）。 */
export async function detachWindow(bounds) {
  if (!state.proc || !state.port) return { ok: false, reason: '浏览器还没启动' }
  /* 无窗口那只没有真窗口可摆：要说清楚怎么拿到一只看得见的（用户口径：只有他亲手
     点「打开浏览器」那一次才是带窗口的），绝不留一个点了没反应的按钮。 */
  if (state.headless) {
    const reason = '这只是无窗口（后台）浏览器，没有可显示的窗口；想看真窗口请在面板上点「打开浏览器」。'
    state.viewMode = 'docked'
    state.viewParked = true
    state.view.reason = reason
    emitView({ event: 'mode' })
    return { ok: false, reason, headless: true, parked: true }
  }
  const want = bounds && typeof bounds === 'object' ? bounds : null
  const back = want || state.viewBounds || VIEW_FALLBACK_BOUNDS
  const okWin = await setRealWindowBounds({
    left: Number.isFinite(back.left) ? back.left : VIEW_FALLBACK_BOUNDS.left,
    top: Number.isFinite(back.top) ? back.top : VIEW_FALLBACK_BOUNDS.top,
    width: Number.isFinite(back.width) ? back.width : VIEW_FALLBACK_BOUNDS.width,
    height: Number.isFinite(back.height) ? back.height : VIEW_FALLBACK_BOUNDS.height,
  })
  await bringToFront().catch(() => {})
  const after = await readRealWindowBounds()
  const hidden = !after || isAtParkingSpot(after)
  const ok = !!okWin && !hidden
  state.viewParked = hidden
  if (!ok) {
    state.view.reason = '真实窗口没能恢复到可见位置；可以再点一次「独立窗口」，或留在右栏实况里操作。'
    emitView({ event: 'mode' })
  }
  return {
    ok,
    parked: hidden,
    reason: ok ? '' : state.view.reason,
    bounds: after || null,
  }
}

/** 状态里给渲染层的那一份（帧本体不在这里，也不落库）。 */
export function viewStatus() {
  const v = state.view
  return {
    on: !!v.on,
    mode: state.viewMode,
    seq: v.seq,
    w: v.w,
    h: v.h,
    dpr: v.dpr,
    /* 兜底模式：真实窗口没被成功移出可视区（离屏不出帧），面板照常出帧但状态里说明 */
    fallback: !!v.fallback,
    reason: String(v.reason || ''),
    /* docked 形态下真实窗口是否**已经**让位（与 mode 区分：mode 只是想要的形态） */
    parked: !!state.viewParked,
    /* 这一只起的是无窗口（headless）浏览器：没有真窗口可摆，渲染层据此说明「独立窗口」不可用 */
    headless: !!state.headless,
    lastFrameAt: v.lastFrameAt,
    running: !!(state.proc && !state.proc.killed && state.cdp && !state.cdp.closed),
  }
}

function emitView(extra) {
  if (!state.view.sink) return
  try { state.view.sink({ ...viewStatus(), ...(extra || {}) }) } catch { /* 帧投递失败绝不影响浏览器动作 */ }
}

/** 真实窗口此刻是不是就停在「移出可视区」的那个落点上（避免把它当用户位置记下来）。 */
function isAtParkingSpot(b) {
  return !!b && Number.isFinite(b.left) && Number.isFinite(b.top)
    && Math.abs(b.left - VIEW_OFFSCREEN_BOUNDS.left) <= 4
    && Math.abs(b.top - VIEW_OFFSCREEN_BOUNDS.top) <= 4
}

/** 真实窗口形态：'docked'（面板实况）/ 'detached'（独立窗口）。
 *  detached 是**用户亲手点的例外**，所以这里只负责「真的把窗口摆到他看得见的地方」：
 *  位姿没恢复成功（窗口仍停在落点上）就回落成 docked + 一句原因，绝不把「看不见的真窗口」
 *  留成当前形态（否则他点什么都没反应，只能停浏览器）。 */
export async function setViewMode(mode) {
  const want = String(mode || '').toLowerCase() === 'detached' ? 'detached' : 'docked'
  if (!state.proc || !state.port) {
    /* 浏览器都没起：形态一律归零到默认（内部界面），别把「独立的窗口」这个想要的形态留在
       状态里 —— 下一次进程起起来时 viewMode 又要是 docked（见 ensureBrowser 的归零）。 */
    state.viewMode = 'docked'
    state.viewParked = false
    return { ok: false, reason: '浏览器还没启动', ...viewStatus() }
  }
  if (want === 'detached') {
    const r = await detachWindow()
    if (r.ok) {
      state.viewMode = 'detached'
      state.view.fallback = false
      state.view.reason = ''
    } else if (r.headless) {
      /* 无窗口那只：本来就没有窗口可摆、也没有「它戳在屏幕上」这回事 ——
         保持 docked，但**不标 fallback**（那是给「离屏不出帧」的兜底文案，
         标上去会白白告诉用户「真实窗口可能仍在屏幕上」）。 */
      state.viewMode = 'docked'
      state.viewParked = true
      state.view.fallback = false
      state.view.reason = r.reason || ''
    } else {
      /* 没摆出来就不算切过去了：保持 docked，面板上把原因说清楚 */
      state.viewMode = 'docked'
      /* 位姿没还原、窗口可能还在屏幕上：别让 startViewStream 以为「已在落点」而漏搬 */
      state.viewParked = false
      state.view.fallback = true
      state.view.reason = r.reason || '真实窗口没能恢复到可见位置。'
    }
    emitView({ event: 'mode' })
    return { ok: r.ok, reason: state.view.reason, ...viewStatus() }
  }
  /* 无窗口那只的「docked」就是这么回事：没有窗口要搬，也不该去读位姿。 */
  if (state.headless) {
    state.viewMode = 'docked'
    state.viewParked = true
    state.view.fallback = false
    state.view.reason = ''
    emitView({ event: 'mode' })
    return { ok: true, headless: true, ...viewStatus() }
  }
  /* docked：先记住用户可能挪过的真实位置，再把窗口移出可视区。
     已经在落点上的窗口不算「用户的位置」（重复 dock 不该把 -2400,-2400 记成他的窗口位置，
     否则下次「提出来」会把窗口还原到看不见的地方）。 */
  const before = await readRealWindowBounds()
  if (before && Number.isFinite(before.left) && Number.isFinite(before.top) && !isAtParkingSpot(before)) {
    state.viewBounds = { left: before.left, top: before.top, width: before.width, height: before.height }
  }
  const okOff = await setRealWindowBounds(VIEW_OFFSCREEN_BOUNDS)
  state.viewMode = 'docked'
  state.viewParked = !!okOff
  /* 移屏只可能让「出帧」变难：真出不来帧时由 startViewStream 的看门狗回落。
     这里先把「没移成功」标出来。 */
  state.view.fallback = !okOff
  state.view.reason = okOff ? '' : '这台机器不接受把窗口移出可视区；真实窗口可能仍在屏幕上。'
  emitView({ event: 'mode' })
  return { ok: true, ...viewStatus() }
}

/** 开实况流：Page.startScreencast + ack 流控。重复调用不重复订阅（不出现双份帧）。 */
export async function startViewStream(params) {
  const p = params && typeof params === 'object' ? params : {}
  const cdp = state.cdp
  if (!cdp || cdp.closed) throw new Error('浏览器还没启动或已关闭，先调用 browser_launch')
  const v = state.view
  if (v.on) return { ok: true, ...viewStatus() }
  v.on = true
  v.lastAckAt = Date.now()
  const off = cdp.on((m) => {
    if (!m || m.method !== 'Page.screencastFrame') return
    /* 停流之后到达的帧（stopScreencast 生效前已在飞）一律丢掉：
       渲染层不该在「已经停流」之后还收到画面 */
    if (!v.on) return
    const d = m.params || {}
    const meta = d.metadata || {}
    const now = Date.now()
    const tooSoon = v.at && now - v.at < VIEW_MIN_INTERVAL_MS
    const keep = !tooSoon || v.seq === 0
    if (keep) {
      v.seq += 1
      v.at = now
      v.w = Number(meta.deviceWidth) || v.w
      v.h = Number(meta.deviceHeight) || v.h
      v.dpr = Number(meta.pageScaleFactor) || v.dpr || 1
      v.lastFrameAt = now
      /* 先投帧（界面立刻看到），再 ack 要下一帧 —— 顺序反了会让慢客户端积压 */
      emitView({ seq: v.seq, at: now, w: v.w, h: v.h, dpr: v.dpr, frame: String(d.data || '') })
    }
    try { cdp.send('Page.screencastFrameAck', { sessionId: d.sessionId }, 4000).catch(() => {}) } catch {}
    v.lastAckAt = Date.now()
  })
  v.off = off
  try {
    await cdp.send('Page.startScreencast', {
      format: 'jpeg',
      quality: Number(p.quality) > 0 ? Math.min(90, Number(p.quality)) : VIEW_JPEG_QUALITY,
      maxWidth: Number(p.maxWidth) > 0 ? Number(p.maxWidth) : VIEW_MAX_WIDTH,
      maxHeight: Number(p.maxHeight) > 0 ? Number(p.maxHeight) : VIEW_MAX_HEIGHT,
      everyNthFrame: 1,
    }, 8000)
  } catch (e) {
    v.on = false
    if (off) { try { off() } catch {} }
    v.off = null
    throw new Error('这台浏览器无法开启实况画面：' + String((e && e.message) || e))
  }
  /* docked 形态的定义就是「真实窗口让位」：新起的窗口（viewParked=false）还没被搬过，
     开流时补搬一次 —— 少了这一步，面板有画面、屏幕上却仍戳着那只 Edge。
     搬不动时 parkSessionWindow 自己标 fallback + 原因（与下面看门狗同一口径）。
     无窗口那只（headless）没有窗口可搬：parkSessionWindow 直接算已让位，不走位姿那一路。 */
  if (state.viewMode === 'docked' && !state.viewParked) {
    try { await parkSessionWindow() } catch { /* 搬不动：下面按 fallback 走 */ }
  }
  /* 看门狗：docked 下 1.5s 还没帧 → 离屏窗口不出帧，回落成「窗口停在屏幕上」。
     只回落一次（fallback 置位后不再搬窗，避免反复搬动用户眼前的窗口）。
     **无窗口那只不进这条**：它没有窗口可摆回屏幕，硬搬只会是空动作、还会白写一句
     「真实窗口可能仍在屏幕上」（那正是本 bug 的观感来源）。 */
  if (v.watch) { try { clearTimeout(v.watch) } catch {} }
  v.watch = setTimeout(() => {
    v.watch = null
    if (!v.on || v.lastFrameAt) return
    if (state.headless) {
      v.reason = '后台浏览器没有画面输出（可能被系统挂起），点「重试」或重新打开一次。'
      emitView({ event: 'stalled' })
      return
    }
    if (state.viewMode !== 'docked' || v.fallback) {
      v.reason = v.reason || '浏览器没有画面输出（窗口可能被系统挂起）。'
      emitView({ event: 'stalled' })
      return
    }
    v.fallback = true
    v.reason = '离屏窗口不出帧，已回落为「窗口停在屏幕上 + 面板实况」。'
    emitView({ event: 'fallback' })
    void setRealWindowBounds(VIEW_FALLBACK_BOUNDS)
  }, 1500)
  emitView({ event: 'start' })
  return { ok: true, ...viewStatus() }
}

/** 关实况流（收起面板 / 离开会话视图时调）。 */
export async function stopViewStream() {
  const v = state.view
  if (v.watch) { try { clearTimeout(v.watch) } catch {} v.watch = null }
  if (v.off) { try { v.off() } catch {} v.off = null }
  if (v.on && state.cdp && !state.cdp.closed) {
    try { await state.cdp.send('Page.stopScreencast', {}, 4000) } catch { /* 老内核 / 已断 */ }
  }
  v.on = false
  emitView({ event: 'stop' })
  return { ok: true, ...viewStatus() }
}

/** 面板里的鼠标 / 滚轮 / 键盘 → 页面（调用方给 CSS 像素 + 画布显示尺寸）。 */
export async function viewInput(params) {
  const p = params && typeof params === 'object' ? params : {}
  const cdp = state.cdp
  if (!cdp || cdp.closed) throw new Error('浏览器还没启动或已关闭')
  /* 换算：面板画布给的是 CSS 像素，按真实视口尺寸缩放后再派发 */
  const meta = await cdp.send('Runtime.evaluate', {
    expression: '(()=>({w:window.innerWidth||document.documentElement.clientWidth||0,h:window.innerHeight||document.documentElement.clientHeight||0}))()',
    returnByValue: true,
  }, 5000).then((r) => (r && r.result && r.result.value) || null).catch(() => null)
  const vw = Number(meta && meta.w) || Number(state.view.w) || 1280
  const vh = Number(meta && meta.h) || Number(state.view.h) || 800
  const dw = Math.max(1, Number(p.w) || vw)
  const dh = Math.max(1, Number(p.h) || vh)
  const X = Math.round((Number(p.x) || 0) * (vw / dw))
  const Y = Math.round((Number(p.y) || 0) * (vh / dh))
  const kind = String(p.kind || '')

  if (kind === 'mouse') {
    const type = String(p.type || 'mouseMoved')
    const base = {
      type,
      x: X,
      y: Y,
      button: String(p.button || 'none'),
      buttons: Number(p.buttons) || 0,
      clickCount: Number(p.clickCount) || 0,
      modifiers: Number(p.modifiers) || 0,
    }
    if (type === 'mouseWheel') {
      await cdp.send('Input.dispatchMouseEvent', { ...base, deltaX: Number(p.deltaX) || 0, deltaY: Number(p.deltaY) || 0 }, 5000)
    } else {
      await cdp.send('Input.dispatchMouseEvent', base, 5000)
    }
    return { ok: true, x: X, y: Y }
  }
  if (kind === 'key') {
    const raw = String(p.type || 'keyDown')
    const type = raw === 'keyUp' ? 'keyUp' : raw === 'rawKeyDown' ? 'rawKeyDown' : 'keyDown'
    await cdp.send('Input.dispatchKeyEvent', {
      type,
      key: String(p.key || ''),
      code: String(p.code || ''),
      windowsVirtualKeyCode: Number(p.keyCode) || 0,
      nativeVirtualKeyCode: Number(p.keyCode) || 0,
      modifiers: Number(p.modifiers) || 0,
      text: String(p.text || ''),
    }, 5000)
    return { ok: true }
  }
  if (kind === 'text') {
    await cdp.send('Input.insertText', { text: String(p.text || '') }, 5000)
    return { ok: true }
  }
  throw new Error('未知的实况输入类型：' + kind)
}

export async function stopBrowser(opts) {
  const o = opts && typeof opts === 'object' ? opts : {}
  /* 浏览器都没了，实况流自然也没了：帧订阅与看门狗一并收掉 */
  const v = state.view
  if (v.watch) { try { clearTimeout(v.watch) } catch {} v.watch = null }
  if (v.off) { try { v.off() } catch {} v.off = null }
  v.on = false
  try { if (state.cdp) state.cdp.close() } catch { /* 已断 */ }
  state.cdp = null
  state.targetId = ''
  state.driver = ''
  state.viewParked = false
  /* 停掉 = 形态回到默认内部界面（「独立窗口」只是那次浏览器运行里的例外） */
  state.viewMode = 'docked'
  const proc = state.proc
  state.proc = null
  if (proc && !proc.killed) {
    try { proc.kill() } catch { /* 已退出 */ }
  }
  if (!o.silent) note('browser', '浏览器已关闭')
  return { ok: true }
}

/* ── 页面读取 ────────────────────────────────────────────────────────────── */

/** 页面快照：标题 / URL / 可交互元素 / 可见文本 / 控制台错误 / 最近网络。 */
export async function snapshot(params) {
  const p = params && typeof params === 'object' ? params : {}
  const cdp = state.cdp
  if (!cdp || cdp.closed) throw new Error('浏览器还没启动或已关闭，先调用 browser_launch')
  const evaluate = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, 15000)
    if (r && r.exceptionDetails) throw new Error(String((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text || '页面脚本执行失败'))
    return r && r.result ? r.result.value : undefined
  }
  const meta = await evaluate(`(() => {
    const t = document.title || '';
    const u = location.href;
    const text = (document.body ? document.body.innerText : '') || '';
    return { title: t, url: u, text, textAll: text.length, lang: document.documentElement.getAttribute('lang') || '' };
  })()`)
  /* 可交互元素：给模型「能点什么」的清单（selector 用稳定的 CSS 路径，便于下一步直接点） */
  const els = await evaluate(`(() => {
    const out = [];
    const sel = 'a[href],button,input,select,textarea,[role=button],[role=link],[contenteditable=true],[type=submit]';
    const nodes = Array.from(document.querySelectorAll(sel));
    const pathOf = (el) => {
      if (el.id) return '#' + CSS.escape(el.id);
      const parts = [];
      let cur = el;
      for (let depth = 0; cur && cur.nodeType === 1 && depth < 4; depth++) {
        let part = cur.tagName.toLowerCase();
        const cls = (cur.className && typeof cur.className === 'string') ? cur.className.trim().split(/\\s+/)[0] : '';
        if (cls) part += '.' + CSS.escape(cls);
        const parent = cur.parentElement;
        if (parent) {
          const same = Array.from(parent.children).filter((x) => x.tagName === cur.tagName);
          if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(cur) + 1) + ')';
        }
        parts.unshift(part);
        cur = parent;
      }
      return parts.join(' > ');
    };
    for (const el of nodes) {
      const r = el.getBoundingClientRect();
      const visible = !!(r.width && r.height) && getComputedStyle(el).visibility !== 'hidden' && el.offsetParent !== null;
      if (!visible) continue;
      const label = (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') || el.name || '').trim().replace(/\\s+/g, ' ').slice(0, 80);
      out.push({ i: out.length, tag: el.tagName.toLowerCase(), type: el.getAttribute('type') || '', label, disabled: !!el.disabled, selector: pathOf(el) });
      if (out.length >= 60) break;
    }
    return out;
  })()`)
  const textLimit = Number(p.textLimit) > 0 ? Math.min(20000, Number(p.textLimit)) : 4000
  const text = String((meta && meta.text) || '')
  const out = {
    title: String((meta && meta.title) || ''),
    url: String((meta && meta.url) || ''),
    lang: String((meta && meta.lang) || ''),
    textLen: text.length,
    text: text.slice(0, textLimit),
    textTruncated: text.length > textLimit,
    elements: Array.isArray(els) ? els : [],
    consoleErrors: (state.pageErrors || []).slice(-8).map((x) => x.text),
    network: (state.net || []).slice(-(Number(p.netLimit) > 0 ? Math.min(60, Number(p.netLimit)) : 20)).map((x) => `${x.method} ${x.status || '-'} ${x.url}`),
    targetId: state.targetId,
    exe: state.exe,
  }
  note('snapshot', (out.title || '(无标题)') + ' · ' + out.url)
  return out
}

/** 截图（png 落盘）。默认落浏览器产物目录（调用方给 path）。 */
export async function screenshot(params) {
  const p = params && typeof params === 'object' ? params : {}
  const cdp = state.cdp
  if (!cdp || cdp.closed) throw new Error('浏览器还没启动或已关闭，先调用 browser_launch')
  const fmt = String(p.format || 'png').toLowerCase() === 'jpeg' ? 'jpeg' : 'png'
  const r = await cdp.send('Page.captureScreenshot', {
    format: fmt,
    quality: fmt === 'jpeg' ? 80 : undefined,
    captureBeyondViewport: !!p.fullPage,
  }, 30000)
  const data = String((r && r.data) || '')
  if (!data) throw new Error('截图失败（页面没有返回图像数据）')
  const fs = await import('node:fs')
  const dir = String(p.dir || join(tmpdir(), 'mtnode-browser-shots'))
  try { fs.mkdirSync(dir, { recursive: true }) } catch { /* 目录已存在 */ }
  const file = join(dir, 'browser-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6) + '.' + fmt)
  fs.writeFileSync(file, Buffer.from(data, 'base64'))
  note('screenshot', '截图 · ' + (p.label || '') + ' → ' + file, { path: file })
  return { path: file, bytes: Buffer.byteLength(data, 'base64'), format: fmt, targetId: state.targetId }
}

/** 定位元素的公共 JS 片段（selector / 命中可交互元素序号 i 两种方式）。 */
function locatorJs(selector, index) {
  return `(() => {
    const sel = ${JSON.stringify(String(selector || ''))};
    const idx = ${Number.isInteger(index) ? index : -1};
    let el = null;
    if (sel) { try { el = document.querySelector(sel); } catch (e) { el = null; } }
    if (!el && idx >= 0) {
      const all = Array.from(document.querySelectorAll('a[href],button,input,select,textarea,[role=button],[role=link],[contenteditable=true],[type=submit]'));
      el = all[idx] || null;
    }
    if (!el) return null;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    return el;
  })()`
}

export async function click(params) {
  const p = params && typeof params === 'object' ? params : {}
  const cdp = state.cdp
  if (!cdp || cdp.closed) throw new Error('浏览器还没启动或已关闭，先调用 browser_launch')
  const selector = String(p.selector || '')
  const index = Number.isInteger(p.index) ? p.index : -1
  const found = await cdp.send('Runtime.evaluate', {
    expression: `(() => { const el = ${locatorJs(selector, index)}; if (!el) return null; const r = el.getBoundingClientRect(); return { label: (el.innerText||el.value||el.getAttribute('aria-label')||'').trim().slice(0,80), tag: el.tagName.toLowerCase(), x: r.left + r.width/2, y: r.top + r.height/2, w: r.width, h: r.height }; })()`,
    returnByValue: true,
  }, 12000)
  const val = found && found.result ? found.result.value : null
  if (!val) throw new Error(`没找到要点击的元素（selector=${selector || '(空)'} index=${index}）`)
  if (!val.w || !val.h) note('click', `元素不可见仍尝试点击：${val.label}`)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: val.x, y: val.y, button: 'left', clickCount: 1 }, 12000)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: val.x, y: val.y, button: 'left', clickCount: 1 }, 12000)
  note('click', `点击 ${val.tag}「${val.label}」`)
  await settle(cdp, p)
  return { ok: true, clicked: val.label, tag: val.tag }
}

/** 点击后的稳定等待：DOM 抖动停下来的那一下再取快照（最长 waitMs）。 */
async function settle(cdp, p) {
  const waitMs = Number(p && p.waitMs) >= 0 ? Math.min(10000, Number(p.waitMs)) : 1200
  const end = Date.now() + waitMs
  while (Date.now() < end) {
    await new Promise((r) => setTimeout(r, 200))
    try {
      const s = await cdp.send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true }, 4000)
      const rs = s && s.result ? s.result.value : ''
      if (rs === 'complete' && Date.now() > end - waitMs / 2) break
    } catch { break }
  }
}

export async function typeText(params) {
  const p = params && typeof params === 'object' ? params : {}
  const cdp = state.cdp
  if (!cdp || cdp.closed) throw new Error('浏览器还没启动或已关闭，先调用 browser_launch')
  const selector = String(p.selector || '')
  if (selector) {
    const focused = await cdp.send('Runtime.evaluate', {
      expression: `(() => { const el = ${locatorJs(selector, -1)}; if (!el) return false; el.focus(); if ('value' in el) el.value = ''; return true; })()`,
      returnByValue: true,
    }, 12000)
    if (!(focused && focused.result && focused.result.value)) throw new Error('没找到要输入的元素：' + selector)
  }
  const text = String(p.text == null ? '' : p.text)
  /* 逐字符 insertText：对企业级 React/Vue 富文本比直接赋 value 更可靠（会触发 input 事件） */
  const CHUNK = 200
  for (let i = 0; i < text.length; i += CHUNK) {
    await cdp.send('Input.insertText', { text: text.slice(i, i + CHUNK) }, 20000)
  }
  if (p.submit) {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 13, key: 'Enter', code: 'Enter' }, 12000)
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 13, key: 'Enter', code: 'Enter' }, 12000)
  }
  /* 留痕只记长度，不记内容（凭据纪律：密码 / 支付信息由用户亲自输入，不进对话与活动流正文） */
  note('type', `输入 ${text.length} 个字符${p.secret ? '（敏感字段：内容未记录）' : ''}${p.submit ? ' 并回车' : ''}${selector ? ' → ' + selector : ''}`)
  await settle(cdp, p)
  return { ok: true, chars: text.length }
}

export async function pressKey(params) {
  const p = params && typeof params === 'object' ? params : {}
  const cdp = state.cdp
  if (!cdp || cdp.closed) throw new Error('浏览器还没启动或已关闭，先调用 browser_launch')
  const key = String(p.key || 'Enter')
  const map = {
    Enter: { windowsVirtualKeyCode: 13, code: 'Enter', key: 'Enter' },
    Tab: { windowsVirtualKeyCode: 9, code: 'Tab', key: 'Tab' },
    Escape: { windowsVirtualKeyCode: 27, code: 'Escape', key: 'Escape' },
    Backspace: { windowsVirtualKeyCode: 8, code: 'Backspace', key: 'Backspace' },
    ArrowDown: { windowsVirtualKeyCode: 40, code: 'ArrowDown', key: 'ArrowDown' },
    ArrowUp: { windowsVirtualKeyCode: 38, code: 'ArrowUp', key: 'ArrowUp' },
    PageDown: { windowsVirtualKeyCode: 34, code: 'PageDown', key: 'PageDown' },
  }
  const k = map[key] || { key, code: key, windowsVirtualKeyCode: 0 }
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...k }, 12000)
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...k }, 12000)
  note('key', '按键 ' + key)
  await settle(cdp, p)
  return { ok: true, key }
}

export async function evaluateJs(params) {
  const p = params && typeof params === 'object' ? params : {}
  const cdp = state.cdp
  if (!cdp || cdp.closed) throw new Error('浏览器还没启动或已关闭，先调用 browser_launch')
  const expr = String(p.expression || '').slice(0, 20000)
  if (!expr) throw new Error('缺少 expression')
  const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: !!p.awaitPromise }, 30000)
  if (r && r.exceptionDetails) throw new Error(String((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text || '页面脚本执行失败'))
  const v = r && r.result ? r.result.value : undefined
  note('evaluate', '执行页面脚本' + (p.note ? '：' + p.note : ''))
  return { ok: true, value: typeof v === 'string' ? v.slice(0, 8000) : v }
}

export async function waitFor(params) {
  const p = params && typeof params === 'object' ? params : {}
  const cdp = state.cdp
  if (!cdp || cdp.closed) throw new Error('浏览器还没启动或已关闭，先调用 browser_launch')
  const timeout = Math.min(60000, Math.max(200, Number(p.timeoutMs) || 15000))
  const end = Date.now() + timeout
  const sel = String(p.selector || '')
  const text = String(p.text || '')
  const expr = sel
    ? `(() => { try { return !!document.querySelector(${JSON.stringify(sel)}); } catch (e) { return false; } })()`
    : text
      ? `(() => ((document.body ? document.body.innerText : '') || '').includes(${JSON.stringify(text)}))()`
      : '(() => document.readyState === "complete")()'
  let lastErr = ''
  while (Date.now() < end) {
    try {
      const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true }, 8000)
      if (r && r.result && r.result.value) {
        note('wait', '等待条件已满足：' + (sel || text || '页面加载完成'))
        return { ok: true, waitedMs: timeout - (end - Date.now()) }
      }
    } catch (e) { lastErr = String((e && e.message) || e) }
    await new Promise((r) => setTimeout(r, 400))
  }
  throw new Error('等待超时（' + timeout + 'ms）' + (sel ? '：' + sel : text ? '：含文本「' + text + '」' : '') + (lastErr ? ' · ' + lastErr : ''))
}

/** 最近网络请求（模型侧 browser_network 用的就是它；快照里也带一小段）。 */
export async function network(params) {
  const p = params && typeof params === 'object' ? params : {}
  const limit = Number(p.limit) > 0 ? Math.min(60, Math.round(Number(p.limit))) : 20
  const rows = (state.net || []).slice(-limit).map((x) => ({
    method: x.method,
    status: x.status || 0,
    url: x.url,
    type: x.type || '',
    at: x.at,
  }))
  return {
    ok: true,
    count: rows.length,
    requests: rows,
    hint: rows.length ? '状态 0 = 请求已发出但还没拿到响应（仍在进行 / 被取消）' : '本页还没有网络记录（刚打开或页面不发请求）',
  }
}

/* ── 标签页 ─────────────────────────────────────────────────────────────── */
export async function tabs(params) {
  const p = params && typeof params === 'object' ? params : {}
  const action = String(p.action || 'list')
  if (!state.port) throw new Error('浏览器还没启动，先调用 browser_launch')
  const list = await fetchJson(`http://127.0.0.1:${state.port}/json/list`, 5000).catch(() => [])
  const pages = (Array.isArray(list) ? list : []).filter((t) => t && t.type === 'page' && !String(t.url || '').startsWith('devtools://'))
  if (action === 'list') {
    return {
      ok: true,
      current: state.targetId,
      tabs: pages.map((t) => ({ id: t.id, title: String(t.title || '').slice(0, 80), url: String(t.url || '').slice(0, 200), current: t.id === state.targetId })),
    }
  }
  if (action === 'new') {
    const bws = await new Cdp((await fetchJson(`http://127.0.0.1:${state.port}/json/version`, 5000)).webSocketDebuggerUrl).open()
    let id = ''
    try {
      const c = await bws.send('Target.createTarget', { url: String(p.url || 'about:blank') }, 8000)
      id = c.targetId
    } finally { bws.close() }
    await new Promise((r) => setTimeout(r, 400))
    await useTarget(id)
    return { ok: true, id, url: String(p.url || 'about:blank') }
  }
  if (action === 'close') {
    const id = String(p.targetId || state.targetId || '')
    if (!id) throw new Error('缺少要关闭的标签页 id')
    const ver = await fetchJson(`http://127.0.0.1:${state.port}/json/version`, 5000)
    const bws = await new Cdp(ver.webSocketDebuggerUrl).open()
    try { await bws.send('Target.closeTarget', { targetId: id }, 8000) } finally { bws.close() }
    state.cdp && state.cdp.close()
    state.cdp = null
    state.targetId = ''
    return { ok: true, closed: id }
  }
  if (action === 'select') {
    const hit = await useTarget(String(p.targetId || ''))
    return { ok: true, id: hit.id, title: hit.title, url: hit.url }
  }
  throw new Error('未知的标签页动作：' + action)
}

export async function navigate(params) {
  const p = params && typeof params === 'object' ? params : {}
  const cdp = state.cdp
  if (!cdp || cdp.closed) throw new Error('浏览器还没启动或已关闭，先调用 browser_launch')
  const url = String(p.url || '').trim()
  if (!url) throw new Error('缺少 url')
  const before = await cdp.send('Runtime.evaluate', { expression: 'location.href', returnByValue: true }, 8000).catch(() => null)
  const from = before && before.result ? String(before.result.value || '') : ''
  if (p.history === 'back' || p.history === 'forward') {
    await cdp.send('Runtime.evaluate', { expression: p.history === 'back' ? 'history.back()' : 'history.forward()', returnByValue: true }, 8000)
    await settle(cdp, p)
    const now = await cdp.send('Runtime.evaluate', { expression: 'location.href', returnByValue: true }, 8000).catch(() => null)
    const to = now && now.result ? String(now.result.value || '') : ''
    note('navigate', `历史${p.history === 'back' ? '后退' : '前进'}：${from} → ${to}`)
    return { ok: true, history: p.history, url: to }
  }
  await cdp.send('Page.navigate', { url }, 30000)
  await settle(cdp, p)
  const after = await cdp.send('Runtime.evaluate', { expression: 'location.href + "\\u0000" + (document.title||"")', returnByValue: true }, 8000).catch(() => null)
  const raw = after && after.result ? String(after.result.value || '') : ''
  const [to, title] = raw.split('\u0000')
  note('navigate', `打开 ${url}` + (from ? `（来自 ${from}）` : ''))
  return { ok: true, url: to || url, title: title || '' }
}

/** 下载目录（用户的下载都在浏览器产物目录里，活动流给路径）。 */
export function downloadDirOf(dshHome) {
  const home = String(dshHome || '').trim()
  const base = home ? join(home, '..') : join(tmpdir(), 'mtnode-dsh')
  return join(base, 'browser-downloads')
}

export function shotsDirOf(dshHome) {
  const home = String(dshHome || '').trim()
  const base = home ? join(home, '..') : join(tmpdir(), 'mtnode-dsh')
  return join(base, 'browser-shots')
}

/** 让浏览器把下载落到我们的目录（CDP 的 Browser.setDownloadBehavior）。 */
export async function setDownloadDir(dir) {
  if (!state.port) return { ok: false }
  try {
    const ver = await fetchJson(`http://127.0.0.1:${state.port}/json/version`, 5000)
    const bws = await new Cdp(ver.webSocketDebuggerUrl).open()
    try {
      await bws.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: String(dir), eventsEnabled: true }, 8000)
    } finally { bws.close() }
    return { ok: true, dir: String(dir) }
  } catch { return { ok: false } }
}

/** 浏览器当前状态（活动流面板 / 手动打开 / 排障共用）。 */
/* ── DevTools 前端（CDP 面板）─────────────────────────────────────────────────
   需求「网关内置浏览器视图开 DevTools 前端（Console / Network / Cordis 树）」的落地口径：
   **不自己写 Console/Network 面板** —— 直接开这台浏览器自带的 DevTools 前端。Chromium
   的调试端点本身就 serve 一份 `/devtools/` 前端（`devtoolsFrontendUrl`），它是同源页面，
   能直接连本机 CDP；这样 Console / Network / Sources / Performance 全套与用户熟悉的一模一样，
   我们零依赖、零重复实现。
   返回 { ok, url, targetId, port } —— url 缺失时渲染层给一句「先打开浏览器」。 */
export async function devtoolsUrl() {
  if (!state.proc || !state.port || !state.cdp || state.cdp.closed) {
    return { ok: false, reason: '浏览器还没启动' }
  }
  let list = []
  try {
    list = await fetchJson(`http://127.0.0.1:${state.port}/json/list`, 4000)
  } catch (err) {
    return { ok: false, reason: '调试端点没响应：' + String((err && err.message) || err).slice(0, 120) }
  }
  const pages = (Array.isArray(list) ? list : []).filter((t) => t && t.type === 'page' && t.devtoolsFrontendUrl)
  /* 优先当前会话正在驱动的那一页；没有就取第一页（用户点开面板时想看的通常就是它） */
  const target = pages.find((t) => t.id === state.targetId) || pages[0] || null
  if (!target) return { ok: false, reason: '还没有可检查的页面（先导航一个网址）' }
  const url = new URL(target.devtoolsFrontendUrl, `http://127.0.0.1:${state.port}`).href
  return { ok: true, url, targetId: target.id || '', port: state.port }
}

export function statusOf() {
  return {
    running: !!(state.proc && !state.proc.killed && state.cdp && !state.cdp.closed),
    exe: state.exe,
    port: state.port,
    profileDir: state.profileDir,
    targetId: state.targetId,
    driver: state.driver,
    pid: state.proc && !state.proc.killed ? state.proc.pid : 0,
    /* 形态也带在只读快照里（渲染层每次 status 都能把面板对齐到网关的真形态：
       默认内部界面 docked；「独立窗口」detached 是用户本次运行里亲手点的例外）。
       parked = docked 下真实窗口**是否已经**让位（判据是「真搬走了没有」，见 viewStatus）。 */
    mode: state.viewMode,
    parked: !!state.viewParked,
  }
}

/* ── 驱动串行锁（用户已确认：共用一个进程多标签，同一时刻只让一条会话驱动）── */
export function claimDriver(sessionId) {
  const sid = String(sessionId || '')
  if (state.driver && sid && state.driver !== sid) {
    return { ok: false, reason: `浏览器此刻由另一条会话驱动（${state.driver.slice(0, 12)}…），请稍后重试；同一时刻只允许一条会话驱动，避免两个会话抢同一个页面。` }
  }
  if (sid) state.driver = sid
  state.lastActivityAt = Date.now()
  return { ok: true }
}
export function releaseDriver(sessionId) {
  const sid = String(sessionId || '')
  if (!sid || state.driver === sid) state.driver = ''
}

/** 人工接管：接管期间 Agent 的动作一律拒绝（用户已确认的口径：拒绝而不是排队）。 */
export function setTakeover(on, sessionId) {
  state.takeover = { on: !!on, at: Date.now(), sessionId: String(sessionId || '') }
  note('takeover', on ? '用户接管浏览器（Agent 动作暂停）' : '用户交还控制权（Agent 可继续）')
  return { ok: true, takeover: state.takeover }
}
export function takeoverOf() { return state.takeover || { on: false, at: 0, sessionId: '' } }
export function isTakeover() { return !!(state.takeover && state.takeover.on) }

/** 把一条工具动作落进活动流（工具层调用，与应用/文件同表）。 */
export function noteAction(kind, text, extra) { return note(kind, text, extra) }