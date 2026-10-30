// MTNode project manifest tool (runs INSIDE the dsh runtime process).
//
// Registers mtnode_manifest so an agent working in a project folder can keep the
// project's asset registry (manifest.json) honest:
//   - init / get                 register the project file, read it back
//   - asset_set / asset_del      assets with auto-incrementing rev (content-hash based)
//   - shot_set / shot_del        shots referencing assets as "<id>@<rev>"
//   - edge_add / edge_del        explicit dependencies (manual edges, no stale spread)
//   - stale_plan                 incremental rebuild plan: which shots went stale + why
//   - validate / validate_refs   reference + file checks (missing asset, stale rev)
//   - rebuild_done               clear stale after the affected shots were rebuilt
//
// The file itself lives at <project root>/manifest.json and is written by the HOST
// (MTNode main process, manifest-store.js). The root is resolved on the host side:
// explicit root param > the current canvas working folder; neither → hard error.
// The plugin never invents state: every result is host-verified disk data.
//
// Protocol (newline-delimited JSON), same bridge as db-plugin.mjs:
//   plugin → gateway: {t:'manifest', id, sessionId, action, params}
//   plugin → gateway: {t:'drop', id, sessionId}
//   gateway → plugin: {t:'manifest-result', id, ok, result?, error?} | {t:'abort', id}
//
// sessionId = the id of the agent session that issued the call (exec.agent.id), the same
// stamp canvas-plugin.mjs / db-plugin.mjs carry; the gateway gates frames on it (fail closed).

import { createConnection } from 'node:net'
import { randomUUID } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'mtnode-manifest'
export const inject = ['tools']

const MANIFEST_DESC = `Project asset registry + dependency graph + incremental rebuild for the CURRENT project (the canvas working folder, or an explicit root). The file is <root>/manifest.json.

Why use it: consistency stops depending on prompts. Register every character / scene / prop as an ASSET (with its files), register every SHOT as a consumer of specific asset versions (assets: ["char_lin@3"]), and the host can then tell you exactly which shots must be rebuilt after an asset changes.

Actions:
- init: create manifest.json (refuses nothing else — every other action errors if the project is not initialized).
- get: read the whole registry (project / rev / assets / shots / edges / needsReview). Always get before writing.
- asset_set: upsert one asset: {id, kind: character|scene|prop|style|voice|audio|lut|other, files:{slot:"relative/path.png"}, anchor:{model,seed,lora,ref}, deps:[], label}. rev auto-increments ONLY when the content changed (file bytes + anchor + fields); re-registering the same bytes keeps the rev. Every files path must be project-relative and already exist. Pass stage:"art" — writes from any other stage are stored but flagged needsReview.
- asset_del: remove an asset by id (reports which shots still reference it).
- shot_set: upsert one shot: {id, assets:["char_lin@3"], deps:["file:audio/timeline.json"], specRef, final, candidates, qa, gen}. A shot whose assets reference a missing asset or a stale @rev is REJECTED — register/fix the asset first.
- shot_del: remove a shot by id.
- edge_add / edge_del: manual dependency edge {from:"shot:A@2", to:"shot:B@2"} — goes into the graph but does NOT spread stale.
- stale_plan: incremental rebuild plan — stale shots, their revs and the reasons (e.g. asset char_lin 3→4). Rebuild those, then call rebuild_done.
- validate: full check (missing files, missing assets, stale refs). ok:false lists every problem with a path.
- validate_refs: check a list of "id@rev" refs only — use it before generating a shot that must be anchored to assets (requireAsset).
- rebuild_done: {shots:[ids]} clears stale after you actually rebuilt those shots.

Discipline (enforced by the host):
- Never invent asset ids, revs or file paths: read get first, and quote the asset rev the host returned.
- Change an asset only in the art stage; anywhere else the write comes back with needsReview:true — tell the user and wait for confirmation instead of treating it as settled.
- After stale_plan says a shot is stale, that shot's old final/qa files are OUT OF DATE — do not present them as current.
- Stale spreads to DIRECT downstream shots only (not transitively).`

export function apply(ctx) {
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
    if (m.t === 'manifest-result') {
      pending.delete(m.id)
      if (m.ok === false) p.reject(new Error(String(m.error || 'manifest op failed')))
      else p.resolve(m.result == null ? { ok: true } : m.result)
    } else if (m.t === 'abort') {
      pending.delete(m.id)
      p.reject(new Error('manifest op aborted (task ended)'))
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
      failAll(new Error('manifest channel closed'))
      setTimeout(connect, 2000)
    })
  }
  connect()

  const rpc = (action, params, exec, timeoutMs) => {
    if (!socket || socket.destroyed) {
      return Promise.reject(
        new Error('manifest channel unavailable (only works inside the MTNode app)'),
      )
    }
    const id = randomUUID()
    const sessionId = exec && exec.agent ? String(exec.agent.id || '') : ''
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      send({ t: 'manifest', id, sessionId, action, params: params || {} })
      const timer = setTimeout(() => {
        if (!pending.has(id)) return
        pending.delete(id)
        reject(new Error('manifest op timed out'))
      }, Number(timeoutMs) > 0 ? Number(timeoutMs) : 20000)
      if (timer.unref) timer.unref()
      const onAbort = () => {
        if (!pending.has(id)) return
        pending.delete(id)
        send({ t: 'drop', id, sessionId })
        reject(new Error('manifest op aborted'))
      }
      exec && exec.signal && exec.signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  ctx.tools.register(defineTool({
    name: 'mtnode_manifest',
    description: MANIFEST_DESC,
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: [
          'init',
          'get',
          'asset_set',
          'asset_del',
          'shot_set',
          'shot_del',
          'edge_add',
          'edge_del',
          'stale_plan',
          'validate',
          'validate_refs',
          'rebuild_done',
        ],
        description: 'Which manifest action to run.',
      },
      root: {
        type: 'string',
        description:
          'Project root (folder containing manifest.json). Omit to use the current canvas working folder.',
      },
      stage: {
        type: 'string',
        description:
          'Writing stage (art / script / storyboard / audio / shot / qa). Only "art" writes skip the needsReview flag.',
      },
      expectRev: {
        type: 'number',
        description:
          'Optimistic lock: the manifest rev you last read. A mismatch rejects the write and returns the current rev.',
      },
      id: {
        type: 'string',
        description: 'asset_del / shot_del: the id to remove.',
      },
      asset: {
        type: 'object',
        additionalProperties: true,
        description:
          'asset_set: {id, kind, label?, files:{slot:"rel/path"}, anchor?, deps?}. files paths must be project-relative and already exist.',
      },
      shot: {
        type: 'object',
        additionalProperties: true,
        description:
          'shot_set: {id, assets:["id@rev"], deps?["file:rel/path"], specRef?, final?, candidates?, qa?, gen?}.',
      },
      from: { type: 'string', description: 'edge_add / edge_del: source node key, e.g. shot:S03_005@2.' },
      to: { type: 'string', description: 'edge_add / edge_del: target node key, e.g. shot:S03_006@1.' },
      refs: {
        type: 'array',
        items: { type: 'string' },
        description:
          'validate_refs: asset references to check, each "id@rev" (use before generating an asset-anchored shot).',
      },
      shots: {
        type: 'array',
        items: { type: 'string' },
        description: 'rebuild_done: shot ids you actually rebuilt; their stale flag is cleared.',
      },
      ids: {
        type: 'array',
        items: { type: 'string' },
        description: 'get: only return these asset / shot ids.',
      },
      project: { type: 'string', description: 'init: project name written into manifest.json.' },
    },
    timeoutMs: 20000,
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const action = String((args && args.action) || 'get')
      return rpc(action, args || {}, exec, 20000)
    },
  }))
}
