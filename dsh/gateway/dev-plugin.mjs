// MTNode dev-debug tool — the *schema source* of mtnode_dev (also exported through the MCP server).
//
// 干什么：让 agent **自己起一只 MTNode 客户端、用 CDP 驱动它、改完代码再复验**。
// 与 mtnode_gui 的分工（用户已确认，两边描述里都写明）：
//   · mtnode_gui  管「用户正在用的这只实例」——主进程自己的 BrowserWindow 注入脚本点界面；
//   · mtnode_dev  只管「我自己 spawn 的那只调试实例」——真起一个 `electron .` 子进程，
//                 CDP 连它的渲染层（主窗口 / 插件应用窗口）：控制台、异常、网络、截图、
//                 点与输入、DOM 快照、reload / restart。
//
// 为什么需要它（本仓库的现状口径）：Electron 主进程没有任何 --remote-debugging-port 入口，
// browser_* 又只驱动系统 Edge/Chrome 且不接受任意 CDP 端口 —— 所以「开新客户端 + 自调试」
// 只能自己起、自己连。真正的实现全在主进程（根目录 dev-agent.js）：起进程要用 electron 二进制，
// 只有主进程拿得到 app.getAppPath() 与 app.isPackaged。
//
// 三个硬红线（代码层校验，不是文档纪律）：
//   ① 调试实例的数据目录命中默认数据目录（%APPDATA%\pipeline-console）→ 拒绝，绝不碰用户那只；
//   ② 只支持开发态（app.isPackaged === false）——验的必须是仓库源码；
//   ③ 同时只允许一只；只接管账本里登记过的那一只（端口填错也连不上别人的实例）。
//
// 注册口（唯一裁剪判定点）：只有「开发调试」总开关打开的那一轮才有 MTNODE_DEV_DEBUG=1
// （见 gateway.mjs 的 getRuntime / devDebugFlag），其余运行 / 节点 / 纯净轮整只不注册。
// 契约生成器（scripts/build-mcp-contract.mjs）会把这份 defineTool 规格抽成 mcp-tools.json ——
// 它对外的工具面与「某台运行时此刻注册了什么」无关，故生成期间会临时打上那个标记。
//
// 边界（如实写在这里，免得调用方白试）：
//   · 只连渲染层：主进程没有 --inspect，主进程代码改了只能 restart 让它生效，不能断点；
//   · 原生菜单 / 系统文件选择框 / 托盘菜单不在 DOM 里，点不到；
//   · 窗口最小化时 Page.captureScreenshot 可能拿不到帧（先让它显示出来）。

import { createConnection } from 'node:net'
import { randomUUID } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'mtnode-dev'
export const inject = ['tools']

const DEV_DESC = `Start a second MTNode client (dev mode, isolated data directory), drive it over CDP, then verify your fix on it. Use this when you are changing MTNode's own code and must SEE the result: launch → screenshot / snapshot → click / type → edit files → reload (renderer only) or restart (main process) → verify again.

Boundaries you must respect: this tool only ever touches the instance it started itself (ledger file), never the instance the user is working in; it refuses the default data directory; only one debug instance at a time; dev mode only (app.isPackaged === false).

Different from mtnode_gui: mtnode_gui drives the windows of the instance the user is using (main-process DOM injection). mtnode_dev drives the instance YOU started over CDP, and can read console / exceptions / network, which mtnode_gui cannot.

Actions:
- launch: spawn \`electron .\` with --remote-debugging-port and an isolated MTNODE_DATA_DIR (default <temp>/mtnode-dev/<timestamp>), wait until CDP answers, attach to the main window. Returns {ok, pid, port, dataDir, appDataDir, targetUrl}. Refuses when another debug instance is alive — stop or restart it instead.
- attach: re-attach the instance recorded in the ledger (e.g. after a gateway/runtime restart). A port different from the ledger one is refused on purpose.
- status: ledger + pid + port + dataDir + current target. Read-only.
- stop: close the instance (CDP Browser.close → wait → kill the process tree) and clear the ledger. The data directory is kept for the evidence you collected.
- reload: make new code take effect. Pass changedFiles (paths you just edited): renderer/… only → Page.reload; anything else (main.js, preload.js, root modules, dsh/, build.json) → full restart on the same data directory. how:"reload"|"restart" forces one.
- restart: stop + launch again on the same data directory.
- screenshot: write a PNG/JPG of the target window to an absolute path (path is required). delayMs waits before the shot.
- snapshot: target window's title / url / viewport / visible text + up to 120 interactive elements with coordinates. This is how you learn what to click.
- click: click an element target (see below) or an absolute {x,y}; mode:"dblclick" for double click.
- type: focus an element target (or the focused element) and insert text; clear:true empties the field first, submit:true presses Enter afterwards. Never for credentials.
- key: press one key (Enter / Escape / Tab / Backspace / arrows / PageDown / a single character).
- scroll: wheel by dx / dy (optionally at x / y).
- wait: wait until a target appears (or disappears with gone:true), timeoutMs default 15000 / max 600000.
- eval: evaluate a JavaScript expression in the target window and return its value (diagnostics; prefer click / type for anything that changes state).
- console: recent console + log entries (limit default 50).
- exceptions: recent uncaught exceptions and log errors.
- net: recent network requests / responses (method, url, status).

Windows (which): "main" (default, the main window renderer) · any substring of a window url or title (an app window is usually found by its app id or its title, e.g. "我的应用 (开发目录 v1.0.0)").

Element targets (click / type / wait): { css: "…" } · { text: "…", exact?: true } · { x, y } for an absolute point.

Failures are reported, never retried silently: an instance that will not start returns the error plus the last lines of its stdout/stderr — read them instead of retrying blindly.`

export function apply(ctx) {
  /* 注册口（唯一的裁剪判定点）：只有「开发调试」总开关打开的那一轮才注册。工具定义不小
     （一整套动作参数），其余会话 / 画布节点 / 长任务环节不该每一步都为它付提示成本。 */
  if (String(process.env.MTNODE_DEV_DEBUG || '') !== '1') return
  ctx.tools.register(
    defineTool({
      name: 'mtnode_dev',
      description: DEV_DESC,
      parameters: {
        action: {
          type: 'string',
          description: 'Which debug action to run.',
          enum: [
            'launch',
            'attach',
            'status',
            'stop',
            'reload',
            'restart',
            'eval',
            'screenshot',
            'console',
            'exceptions',
            'net',
            'snapshot',
            'click',
            'type',
            'key',
            'scroll',
            'wait',
          ],
          required: true,
        },
        which: {
          type: 'string',
          description:
            'Target window: "main" (default, the main window renderer) or a substring of a window url / title (app windows: their app id or title).',
        },
        target: {
          type: 'object',
          additionalProperties: true,
          description: 'Element target: {css} or {text, exact?} or {x, y} for an absolute point.',
        },
        text: {
          type: 'string',
          description: 'type: the text to insert. wait: the text to wait for.',
        },
        key: {
          type: 'string',
          description: 'key: the key to press (Enter / Escape / Tab / Backspace / ArrowDown / PageDown / a single character).',
        },
        expression: {
          type: 'string',
          description: 'eval: JavaScript expression evaluated in the target window (returned by value).',
        },
        path: {
          type: 'string',
          description: 'screenshot: absolute output path (.png or .jpg). Required for screenshot.',
        },
        changedFiles: {
          type: 'array',
          items: { type: 'string' },
          description:
            'reload: the files you just edited (absolute or repo-relative). renderer/… only → Page.reload; anything else → full restart. Required for reload unless how is given.',
        },
        how: {
          type: 'string',
          description: 'reload: force the strategy instead of deriving it from changedFiles.',
          enum: ['reload', 'restart'],
        },
        dataDir: {
          type: 'string',
          description:
            'launch / restart: MTNODE_DATA_DIR for the debug instance (default <temp>/mtnode-dev/<timestamp>). The default data directory is refused.',
        },
        mode: {
          type: 'string',
          description: 'click: "click" (default) or "dblclick".',
          enum: ['click', 'dblclick'],
        },
        clear: {
          type: 'boolean',
          description: 'type: empty the field before typing (default true).',
        },
        submit: {
          type: 'boolean',
          description: 'type: press Enter after typing (default false).',
        },
        gone: {
          type: 'boolean',
          description: 'wait: wait until the target disappears instead of appearing.',
        },
        timeoutMs: {
          type: 'number',
          description: 'wait: how long to wait (default 15000, max 600000). launch: how long to wait for CDP (default 90000).',
        },
        delayMs: {
          type: 'number',
          description: 'screenshot: wait this long before capturing (default 0).',
        },
        settleMs: {
          type: 'number',
          description: 'After click / type / key / scroll, wait this long for the page to settle (default 400).',
        },
        waitMs: {
          type: 'number',
          description: 'reload: settle time after the reload (default 1200).',
        },
        dx: { type: 'number', description: 'scroll: horizontal delta in pixels.' },
        dy: { type: 'number', description: 'scroll: vertical delta in pixels (positive scrolls down).' },
        x: { type: 'number', description: 'scroll: viewport x to wheel at (default 600).' },
        y: { type: 'number', description: 'scroll: viewport y to wheel at (default 400).' },
        limit: {
          type: 'number',
          description: 'console / exceptions / net: how many recent entries to return (default 50 / 50 / 60).',
        },
        awaitPromise: {
          type: 'boolean',
          description: 'eval: await the result when the expression returns a promise (default true).',
        },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (result) => [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      },
      async execute(args, exec) {
        const a = (args && typeof args === 'object' ? args : {}) || {}
        const action = String(a.action || '')
        if (!action) {
          throw new Error(
            'mtnode_dev 需要 action（launch / attach / status / stop / reload / restart / eval / screenshot / console / exceptions / net / snapshot / click / type / key / scroll / wait）',
          )
        }
        if (action === 'screenshot' && !a.path) {
          throw new Error('screenshot 需要 path（本机绝对路径，.png / .jpg）')
        }
        if (action === 'eval' && !String(a.expression || '').trim()) {
          throw new Error('eval 需要 expression')
        }
        /* sessionId = 发起这次调用那条会话的 id：网关据此判「这帧属不属于此刻在跑的这一轮」，
           不带的一律按越权 abort（与 canvas / gui 同一口径）。 */
        const sessionId = exec && exec.agent ? String(exec.agent.id || '') : ''
        return await callHost({ t: 'dev', id: randomUUID(), sessionId, action, params: a })
      },
    }),
  )
}

function callHost(frame) {
  return new Promise((resolve, reject) => {
    const port = Number(process.env.MTNODE_BRIDGE_PORT || 0)
    if (!port) {
      reject(new Error('MTNODE_BRIDGE_PORT 未设置：开发调试工具必须由 MTNode 宿主拉起（独立跑网关时不可用）'))
      return
    }
    const sock = createConnection()
    let buf = ''
    let done = false
    const finish = (err, val) => {
      if (done) return
      done = true
      try { sock.end() } catch { /* already closed */ }
      if (err) reject(err)
      else resolve(val)
    }
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8')
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        if (!line.trim()) continue
        let m
        try { m = JSON.parse(line) } catch { continue }
        if (!m || m.id !== frame.id) continue
        if (m.t === 'abort') return finish(new Error('调用被宿主取消'))
        if (m.ok) finish(null, m.result)
        else finish(new Error(String(m.error || '调试动作失败')))
      }
    })
    sock.on('error', (e) => finish(e))
    sock.connect(port, '127.0.0.1', () => {
      sock.write(JSON.stringify(frame) + '\n')
    })
  })
}
