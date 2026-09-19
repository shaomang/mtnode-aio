// MTNode asset-library + screenshot tool (runs INSIDE the dsh runtime process).
//
// Registers mtnode_assets so a run that has to PREPARE MATERIALS (交付 · 素材交付,
// 分镜参考图, 界面静帧截图 …) can:
//   - list: walk the MTNode asset library (素材库) — categories, assets, content items;
//   - read: take one content item out of the library (title / type / absolute file path /
//           text body) so it can be handed to mtnode_vision or used as a deliverable;
//   - screenshot: capture a still PNG of the MTNode window RIGHT NOW (whole window by
//           default, canvas-only on request) and write it to an absolute path.
//
// Why it must live here and not in the shell: the library root (%APPDATA%\…\config.json
// assetRoot) and the delivery directory both sit OUTSIDE the run's workspace, so a
// sandboxed read/write tool is refused. The HOST (MTNode renderer) owns both — it answers
// every call over the same localhost TCP bridge as canvas-plugin.mjs, and it is also the
// only place that can take a real screenshot (webContents.capturePage).
//
// Protocol (newline-delimited JSON):
//   plugin → gateway: {t:'asset', id, sessionId, action:'list'|'read'|'screenshot', params}
//   plugin → gateway: {t:'drop', id, sessionId}  (we gave up on a frame we just sent)
//   gateway → plugin: {t:'asset-result', id, ok, result?, error?} | {t:'abort', id}
//
// sessionId = the id of the agent session that issued the call (exec.agent.id), the same
// stamp canvas-plugin.mjs / db-plugin.mjs carry: the gateway gates interaction frames on
// it, so a result can never be routed into a run that did not ask for it (fail closed).

import { createConnection } from 'node:net'
import { randomUUID } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { isToolHidden } from './tool-visibility.mjs'

export const name = 'mtnode-assets'
export const inject = ['tools']

const ASSETS_DESC = `The MTNode asset library (素材库) and full-window still screenshots — for runs that must PREPARE MATERIALS (交付 · 素材交付, 分镜参考图, 界面静帧截图 …). Both live OUTSIDE your workspace, so read_file / shell cannot reach them: every path this tool returns is already host-verified.

Available actions:
- list: the library tree. Returns categories, then assets: [{id, rel, displayName, desc, items:[{index, id, title, type}]}] and root. Pass filter (substring over category path / asset name / description) to narrow it (character turnarounds 三视图 are usually named 「…三视图」), or type:"image" to keep only assets that have an image item. Content items are numbered: item index = the port number of an 素材节点 bound to that asset.
- read: one content item. Pass id (asset id, e.g. "as…") or rel (library-relative folder, e.g. "DS Adventure/Characters/AI娘原人设Q版三视图") or path (an absolute file path you already have), plus itemId (or index, 0-based) to pick the item; type:"image" + limit picks the first N image items. Returns {asset, item, file:{path, bytes}} — text items also come back as text (binary never does). The absolute path is what mtnode_vision eats, and what you hand to a deliver terminal / a save node.
- screenshot: take a still PNG of the MTNode window as it is right now and write it to an absolute path. Defaults: whole window, hidden menus/lightboxes removed, saved next to the current output into the canvas asset folder when path is omitted. Pass canvasOnly:true to shoot only the canvas viewport (the 起始态/丰富态 UI stills of a delivery list), width/height to force the output pixel size (e.g. 1920x1080 — capture is scaled to fit; it never resizes the user's window), hideUI:false to keep transient UI, maximize:true to enlarge the window first (only when the user is not using it: the window really does resize). FAILS when the window is minimized or hidden — ask the user to show the MTNode window, then retry.

Discipline: never guess that a file exists — call read and quote the path it returns. The library is a MIRROR of the user's own folders: this tool reads it, it never writes into it. Screenshots are the only thing that writes, and only to the path you are given.`

export function apply(ctx) {
  /* 按运行裁剪可见工具集：这一轮被「素材库与截图」（assets_read）许可拒掉时，宿主把
     mtnode_assets 写进 spawn env MTNODE_HIDE_TOOLS 的隐藏名单（名单真源
     tool-visibility.mjs，判据在渲染层 agentDeniedToolNames）。整个工具不注册 ——
     它的定义本来每一步都要随固定前缀重发一遍，而调用必然被宿主拒。 */
  if (isToolHidden('mtnode_assets')) return
  const port = Number(process.env.MTNODE_BRIDGE_PORT || 0)
  let socket = null
  let buf = ''
  /** @type {Map<string, {resolve:(v:any)=>void, reject:(e:Error)=>void}>} */
  const pending = new Map()

  const send = (obj) => {
    if (socket && !socket.destroyed) {
      try { socket.write(JSON.stringify(obj) + '\n') } catch { /* gateway gone */ }
    }
  }

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
    if (m.t === 'asset-result') {
      pending.delete(m.id)
      if (m.ok === false) p.reject(new Error(String(m.error || 'asset op failed')))
      else p.resolve(m.result == null ? { ok: true } : m.result)
    } else if (m.t === 'abort') {
      pending.delete(m.id)
      p.reject(new Error('asset op aborted (task ended)'))
    }
  }

  const connect = () => {
    if (!Number.isInteger(port) || port <= 0) return
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
      failAll(new Error('asset channel closed'))
      setTimeout(connect, 2000)
    })
  }
  connect()

  const rpc = (action, params, exec) => {
    if (!socket || socket.destroyed) {
      return Promise.reject(new Error('asset channel unavailable (only works inside the MTNode app)'))
    }
    const id = randomUUID()
    /* 发起轮盖章:agent.id 就是该 agent 所在 session 的 id(与 canvas / db 插件同一契约),
       网关据此判归属;取不到 agent 发空串,由网关 fail closed 直接 abort。 */
    const sessionId = exec && exec.agent ? String(exec.agent.id || '') : ''
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      send({ t: 'asset', id, sessionId, action, params: params || {} })
      const onAbort = () => {
        if (!pending.has(id)) return
        pending.delete(id)
        send({ t: 'drop', id, sessionId })
        reject(new Error('asset op aborted'))
      }
      exec && exec.signal && exec.signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  ctx.tools.register(defineTool({
    name: 'mtnode_assets',
    description: ASSETS_DESC,
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['list', 'read', 'screenshot'],
        description: 'Which asset action to run.',
      },
      filter: {
        type: 'string',
        description:
          'list: substring over category path / asset display name / description (e.g. "三视图", "AI娘"). Omit to walk the whole library.',
      },
      type: {
        type: 'string',
        enum: ['text', 'image', 'audio', 'video'],
        description:
          'list: keep only assets that hold an item of this type. read: pick an item of this type (with limit) instead of an explicit itemId/index.',
      },
      limit: {
        type: 'number',
        description: 'list: max assets to return (default 60). read: max items to return (default 3, max 20).',
      },
      id: {
        type: 'string',
        description: 'read: asset id from list (looks like "as…").',
      },
      rel: {
        type: 'string',
        description:
          'read: library-relative asset folder from list (e.g. "DS Adventure/Characters/AI娘原人设Q版三视图").',
      },
      path: {
        type: 'string',
        description:
          'read: an absolute file path already in hand (or under the library) instead of id/rel. screenshot: absolute .png destination; omit to write into the current canvas asset folder.',
      },
      itemId: {
        type: 'string',
        description: 'read: content item id from list (looks like "it…").',
      },
      index: {
        type: 'number',
        description: 'read: 0-based content item index — the same ordinal as an 素材节点 port number.',
      },
      asText: {
        type: 'boolean',
        description: 'read: for text items include the body (default true). Set false to skip it.',
      },
      canvasOnly: {
        type: 'boolean',
        description:
          'screenshot: shoot only the canvas viewport instead of the whole MTNode window (default false = whole window, the 界面静帧口径).',
      },
      width: {
        type: 'number',
        description:
          'screenshot: force the output pixel width (with height); the capture is scaled to fit, the window is NOT resized unless maximize:true. Omit = native capture size.',
      },
      height: {
        type: 'number',
        description: 'screenshot: force the output pixel height. See width.',
      },
      maximize: {
        type: 'boolean',
        description:
          'screenshot: enlarge the MTNode window before shooting (the user sees the window resize; default false). Use only when a bigger still is really needed.',
      },
      hideUI: {
        type: 'boolean',
        description:
          'screenshot: remove transient UI (open menus, hints, lightbox) before shooting (default true) so a delivery still has no残余 popups.',
      },
    },
    timeoutMs: 60000,
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const action = String((args && args.action) || 'list')
      return rpc(action, args || {}, exec)
    },
  }))
}