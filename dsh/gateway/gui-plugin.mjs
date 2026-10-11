// MTNode GUI tool — the *schema source* of mtnode_gui (one of the MCP server's exported tools).
//
// Registers mtnode_gui so an EXTERNAL MCP client (Claude Code / Cursor / a self-written
// agent) can actually DRIVE the MTNode desktop UI instead of only editing the canvas:
// recognise elements, click, focus + type, set form values, press keys, scroll, wait,
// dump the visible text, and shoot a still of any MTNode window.
//
// Why it exists: the desktop app is an Electron window — a browser-automation tool outside
// MTNode cannot reach it, and the canvas tools only touch the node graph. Installing a local
// backend plugin, starting it, pressing its "test generate" button are all *window* actions,
// so without this tool a headless run can prepare a canvas but never press a button.
//
// WHERE IT RUNS — the one place this tool differs from every other exported tool:
//   canvas / db / facts / longtask / assets are executed by the RENDERER (mcp-server.js pushes
//   a frame to the page and the page's own handlers do the work). GUI actions must be executed
//   by the MAIN process: only it holds the BrowserWindow objects, can run a self-contained
//   script inside any window (`webContents.executeJavaScript`) and can take a real screenshot
//   (`webContents.capturePage`). Implementation: **mcp-gui-agent.js** (root), wired in
//   mcp-server.js as family "gui" (TOOL_OPS → { op: "gui", family: "gui", local: true }).
//
//   Consequence, stated plainly: `apply()` below is never called by the dsh gateway runtime —
//   the gateway is MTNode used as an MCP *client*, and this tool is MTNode used as an MCP
//   *server*. This file exists so the parameter table has exactly one source: the contract
//   generator (scripts/build-mcp-contract.mjs) captures the defineTool spec from here into
//   mcp-tools.json / mcp-tool-schemas.js, exactly like the five renderer-family plugins.
//   That is also why the import / executor style matches those plugins.
//
// Boundaries (fail loudly instead of pretending):
//   - native menus, system file-picker dialogs and tray menus are NOT in the DOM: unreachable;
//   - a minimized / hidden window cannot be captured (capturePage comes back empty);
//   - credentials are never typed for the user by this tool.

import { createConnection } from 'node:net'
import { randomUUID } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { isToolHidden } from './tool-visibility.mjs'

export const name = 'mtnode-gui'
export const inject = ['tools']

const GUI_DESC = `Drive the MTNode desktop UI (the Electron app's windows) and shoot stills of them. Use it when the work is a *window* action rather than a canvas edit: opening the plugin dialog, pressing "开始安装" in the install window, starting a local backend, hitting its "test generate" button, reading an error dialog.

Windows: pass which = "main" (default, the main window) · "install" (the plugin install window) · "any" (focused window) · or any substring of a window title (e.g. "Minimax H3" — plugin console windows are titled after the plugin). Call action:"windows" first when you are unsure what is open.

Element targets (used by click / type / set / scroll / wait): an object with ONE of
- { css: "…" } — CSS selector;
- { text: "…", exact?: true, index?: 0 } — visible text; default substring match, deepest/shortest node wins, index picks among ties;
- { title: "…" } — substring of aria-label / title / data-tip / placeholder;
- { role: "button", name: "…" } — role-ish match on button / a / [role=button] / input plus a name substring;
- { ref: "r7" } — a ref returned by action:"outline" (stable until the page re-renders; re-run outline if it goes stale).
Add includeHidden:true to allow a hidden element (rarely useful — a user could not click it either).

Actions:
- windows: list every window (id / title / url / visible / minimized). Read-only.
- outline: compact structure snapshot — visible interactive elements with a ref each, plus the window's visible text lines (textMax, default 80, 0 = none). This is how you learn what to click. Read-only, capped at 120 items.
- text: visible text lines of the window (offset / limit). Read-only.
- click: click a target (a real DOM click inside the page, so the page's own handlers run). mode:"dblclick" for double click; force:true to click a disabled element anyway.
- type: focus a target (or the focused element) and type text; clear:true (default) empties it first; submit:true presses Enter afterwards. Works on input / textarea / contenteditable through the native value setter, so framework listeners fire. NEVER use it for passwords or any credential.
- set: assign a value to a form element: text input, textarea, select (by value or option text), checkbox / radio (true/false), contenteditable.
- key: press one key on the focused element (Enter / Escape / Tab / Backspace / arrows / PageDown / a single character).
- scroll: scroll the window, or a target container, by dx / dy.
- wait: wait until a target appears, until text appears (text:"…"), or until a target is gone (gone:true). timeoutMs default 15000, max 600000.
- eval: run a small READ-ONLY expression inside the window and return its value (diagnostics; use click / type / set for anything that changes state).
- screenshot: write a still PNG/JPG of a window to an absolute path (path is required). canvasOnly:true shoots just the canvas viewport, hideUI:true hides transient menus and the image lightbox first, delayMs waits before shooting. Fails when the window is minimized / hidden — bring it up first.

Discipline: every action returns {ok, window, element?: {tag,id,cls,text,label}} and, on failure, a readable error saying what was not found — read it and adjust instead of retrying blindly. After a click that changes the page, either rely on the automatic short settle or follow with action:"wait". Screenshots are written ONLY to the path you pass.`

export function apply(ctx) {
  /* 说明（为什么不在这里按运行裁剪）：本工具的可见性由 **MCP 服务端**那一侧决定 ——
     能调它的只有连上本机 MCP 服务端的外部客户端，而 MTNode 自身的会话 / 助手 / 智能节点
     这一轮**不注册** mtnode_gui（网关运行时不 import 本文件），所以这里没有按运行裁剪的
     依据，名单（tool-visibility.mjs 的 HIDEABLE_TOOLS）也就不收录它。
     调用的可见性另有出处：每一次 tools/call 都进 MCP 审计（mcp-audit/，含被拒的调用），
     面板「最近调用」能看到「谁在什么时候点了哪个按钮」。 */
  ctx.tools.register(
    defineTool({
      name: 'mtnode_gui',
      description: GUI_DESC,
      parameters: {
        action: {
          type: 'string',
          description: 'Which GUI action to run.',
          enum: [
            'windows',
            'outline',
            'text',
            'click',
            'type',
            'set',
            'key',
            'scroll',
            'wait',
            'eval',
            'screenshot',
          ],
          required: true,
        },
        which: {
          type: 'string',
          description:
            'Target window: "main" (default) · "install" (the plugin install window) · "any" (focused) · or a substring of the window title.',
        },
        target: {
          type: 'object',
          additionalProperties: true,
          description:
            'Element target: {css} or {text, exact?, index?} or {title} or {role, name?} or {ref} (from outline), plus optional includeHidden.',
        },
        text: {
          type: 'string',
          description: 'type: the text to type. wait: the text to wait for.',
        },
        value: {
          type: 'string',
          description: 'set: the value to assign (select takes the option value or its text; true/false for checkbox / radio).',
        },
        key: {
          type: 'string',
          description: 'key: the key to press on the focused element (Enter / Escape / Tab / Backspace / ArrowUp / PageDown / a single character).',
        },
        clear: {
          type: 'boolean',
          description: 'type: empty the field before typing (default true). Pass false to append.',
        },
        submit: {
          type: 'boolean',
          description: 'type: press Enter after typing (default false).',
        },
        mode: {
          type: 'string',
          description: 'click: "click" (default) or "dblclick".',
          enum: ['click', 'dblclick'],
        },
        force: {
          type: 'boolean',
          description: 'click: click even when the element is disabled / aria-disabled (default false).',
        },
        gone: {
          type: 'boolean',
          description: 'wait: wait until the target DISAPPEARS instead of appearing.',
        },
        timeoutMs: {
          type: 'number',
          description: 'wait: how long to wait (default 15000, max 600000).',
        },
        selector: {
          type: 'string',
          description: 'outline: override the element selector for the snapshot (default: buttons / links / inputs / cards / nodes).',
        },
        textMax: {
          type: 'number',
          description: 'outline: how many visible text lines to include alongside the element list (default 80, 0 = none).',
        },
        offset: {
          type: 'number',
          description: 'text: first visible line to return (0-based, default 0).',
        },
        limit: {
          type: 'number',
          description: 'text: how many lines to return (default 200).',
        },
        dx: {
          type: 'number',
          description: 'scroll: horizontal delta in pixels.',
        },
        dy: {
          type: 'number',
          description: 'scroll: vertical delta in pixels (positive scrolls down).',
        },
        expression: {
          type: 'string',
          description: 'eval: a read-only JavaScript expression to evaluate inside the window and return.',
        },
        path: {
          type: 'string',
          description: 'screenshot: absolute output path (.png or .jpg). Required for screenshot.',
        },
        canvasOnly: {
          type: 'boolean',
          description: 'screenshot: shoot only the canvas viewport instead of the whole window.',
        },
        hideUI: {
          type: 'boolean',
          description: 'screenshot: hide transient menus / the image lightbox before shooting, then restore them.',
        },
        delayMs: {
          type: 'number',
          description: 'screenshot: wait this long before capturing (default 400 ms).',
        },
        settleMs: {
          type: 'number',
          description: 'After an action, wait this long for the page to settle (default 400, 0 = do not wait).',
        },
      },
      output: {
        /* The receipt is the host's JSON verbatim (window / element / items / path …):
           every caller reads that JSON itself, so one text block is the documented shape
           and the cheapest render. */
        schema: { type: 'object', additionalProperties: true },
        render: (result) => [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      },
      async execute(args) {
        const a = (args && typeof args === 'object' ? args : {}) || {}
        const action = String(a.action || '')
        if (!action) {
          throw new Error(
            'mtnode_gui 需要 action（windows / outline / text / click / type / set / key / scroll / wait / eval / screenshot）',
          )
        }
        if (action === 'screenshot' && !a.path) {
          throw new Error('screenshot 需要 path（本机绝对路径，.png / .jpg）')
        }
        /* Frame shape = the same host bridge the other plugins use (newline-delimited JSON
           over MTNODE_BRIDGE_PORT). The host answers {t:'gui-result', id, ok, result|error}. */
        return await callHost({ t: 'gui', id: randomUUID(), action, params: a })
      },
    }),
  )
}

function callHost(frame) {
  return new Promise((resolve, reject) => {
    const port = Number(process.env.MTNODE_BRIDGE_PORT || 0)
    if (!port) {
      reject(new Error('MTNODE_BRIDGE_PORT 未设置：GUI 工具必须由 MTNode 宿主拉起（独立跑网关时不可用）'))
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
        else finish(new Error(String(m.error || 'GUI 动作失败')))
      }
    })
    sock.on('error', (e) => finish(e))
    sock.connect(port, '127.0.0.1', () => {
      sock.write(JSON.stringify(frame) + '\n')
    })
  })
}
