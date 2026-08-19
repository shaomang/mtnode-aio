// MTNode canvas tools (runs INSIDE the dsh runtime process).
//
// Registers mtnode_canvas_get / mtnode_canvas_edit / mtnode_app so the agent can
// create, title, connect, @-reference, and auto-layout nodes. Mutations travel
// over the same localhost TCP bridge as bridge-plugin.mjs (port from
// MTNODE_BRIDGE_PORT). This file may import @deepseek-ai/dsh-tools (defineTool);
// dsh API churn stays inside dsh/.
//
// Protocol (newline-delimited JSON, extra to the question/approval frames):
//   plugin → gateway: {t:'canvas', id, op:'get'|'edit'|'app'|'vision', params}
//   gateway → plugin: {t:'canvas-result', id, ok, result?, error?} | {t:'abort', id}

import { createConnection } from 'node:net'
import { randomUUID } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'mtnode-canvas'
export const inject = ['tools']

const KINDS = [
  'input_text', 'input_image', 'proc_text', 'proc_image', 'music_gen',
  'save_text', 'save_image', 'split', 'merge', 'global', 'wait_file', 'timer', 'agent_task', 'task', 'chat',
  'control', 'judge',
]

const NODE_LOCK =
  'CRITICAL — These canvas tools are ONLY for the global assistant (✦) and the agent-session view. When the run is a canvas AGENT NODE (kind agent_task, or proc_text/chat with agent:true), the host REJECTS mtnode_canvas_get / mtnode_canvas_edit / mtnode_app. Do not call them from a node; read and write workspace files instead.\n\n'

const GET_DESC =
  NODE_LOCK +
  'Read the CURRENT MTNode canvas PLUS app context: workflow name, every VISIBLE node in the current task scope (id, kind, title, position, prompt/text/task/goal/steps/parentTaskId/savePath/waitPath/waitIntervalSec, timerMode/timerAt/timerEverySec/timerCron/timerArmed/timerNextAt, providerId/provider/model, size for proc_image, ctrlAction/ctrlRole for control, judgeResult), taskFocus, taskTree (all task nodes even if nested), marks, wires, groups, camera, UI view, imageSizes, markColors, and workflows. When the run is locked to the current canvas (agent session / assistant "current" scope), workflows lists ONLY this canvas — you cannot see or open others. Call this before editing. Complex requirements: FIRST create kind "task" nodes as the plan; each task has a pinned start and success/fail ends — wire implementation inside via parentTaskId. Use kind "judge" (fromIndex 0=YES, 1=NO) to branch. Use kind "timer" for schedule/cron triggers that arm and fire outgoing targets. Prefer building human-editable layouts with createMarks (zone boxes + labels) and control nodes; put user-editable/operable nodes toward the top of the canvas. Node titles are how @references work — @Title resolves if that node is wired into the consumer OR into a kind "global" node (global has no output; sources wired into it are auto-attached to all proc_text / proc_image / agent_task / judge). To change a node model, update with model (+ providerId or provider). To set image size, use size from imageSizes.'

const APP_DESC = NODE_LOCK + `Control the MTNode desktop app beyond node graph edits (workflow status, rename, select nodes, undo/redo, delete with confirmation).

Available actions:
- status / list_workflows: inspect app + workflow catalog. When locked to the current canvas (agent_task nodes, agent session, assistant "current" scope), the catalog contains ONLY that canvas — other workflows are omitted.
- rename_workflow: rename the current (or specified) workflow — other canvases are rejected when locked
- select_nodes: select nodes by id/title (optional; empty clears selection). Selection highlight only.
- undo / redo: undo or redo the last canvas edit

Needs user confirmation (UI will prompt; may be rejected):
- delete_workflow: permanently delete a workflow and its local assets (other canvases rejected when locked)

For creating/editing/wiring/removing NODES or canvas drawings (marks) on the current canvas, use mtnode_canvas_edit instead (confirmed when called from the global assistant or the agent-session view; rejection stops the agent session).`

const EDIT_DESC = NODE_LOCK + `Create, update, connect, disconnect, remove, group, and auto-layout nodes on the CURRENT MTNode canvas — and createMarks / updateMarks / removeMarks for decorative drawings (text / box / arrow). Use this when the user asks you to build or rearrange a workflow. When invoked from the global assistant sidebar or the fullscreen agent-session view, each edit is confirmed by the user before applying; if the user rejects an agent-session edit, the run stops immediately.

Typical pattern for a COMPLEX requirement (planning first):
1. Optionally mtnode_canvas_get first (see taskTree + current-scope nodes).
2. One mtnode_canvas_edit that creates kind "task" nodes as the PLAN. Each task auto-has a pinned start + success end + fail end (do not delete). Put implementation INSIDE via parentTaskId.
3. Wire control flow: start → work/sub-tasks/judge → endSuccess or endFail. kind "judge" has TWO outputs: fromIndex 0 = YES (goal met), fromIndex 1 = NO. ▶ on a task fires start and walks the control graph; status is success/fail by which end is reached.
4. For a SMALL single-pass pipeline (few nodes), you may still create input/proc/save/control directly without a task wrapper.

Typical pattern for a small user-editable pipeline:
1. Optionally mtnode_canvas_get first.
2. One mtnode_canvas_edit that creates:
   - input / proc nodes for the real work (and save_* only after ordinary non-agent proc nodes — never after agent_task / agent:true)
   - control nodes (kind "control", ctrlAction "run" or "clear") wired to the processing nodes the user should re-run or clear in one click
   - createMarks: large box zones (+ label) separating areas such as 编辑区 / 说明 / 处理区 / 输出区; optional text marks for short workflow instructions
   then connect left-to-right, layout true (marks with around:[aliases] wrap nodes AFTER layout).
Prefer agent_task when a step must READ existing files and merge; prefer proc_text for single-pass generation or per-item batch; save_* writes outputs for re-runs of ordinary (non-agent) proc nodes.
CRITICAL — for anything more than a handful of nodes, START with task nodes (kind "task") as the plan. Implementation goes INSIDE (parentTaskId) and MUST be wired from the pinned start to a success/fail end. Use kind "judge" to branch YES/NO. Do not flatten a complex job into a messy mixed graph.
CRITICAL — do NOT create save_text / save_image after agent_task or proc_text with agent:true: those smart nodes can write files themselves; a save_* node would dump chat/task transcript junk to disk. Use save_* only after ordinary proc_text / proc_image (agent off).
CRITICAL — avoid wiring agent_task / proc_text(agent:true) as DATA inputs into other nodes: their outputs carry irrelevant session/transcript noise and often omit the key facts. Prefer file handoff: the smart node WRITES a document (md/yaml/json/…), then use wait_file (监视路径 / waitPath) as a CONTROL node wired OUT to downstream so they block until that file exists; wait_file has NO input ports and outputs NOTHING — later nodes READ the agreed path themselves. Do not wire anything into wait_file.
wait_file: control-kind blocker with output only; polls waitPath (relative to workspace or absolute) every waitIntervalSec seconds (default 2) until the file exists, then unblocks downstream. No inputs, no data/path output; do not @引用 wait_file.
kind "global": input-only rainbow node (no output ports). Wire text/image sources into it; every proc_text / proc_image / agent_task / judge then auto-receives those sources as background and can @Title them without extra wires. Do not wire control nodes into global.

Layout & drawings (recommended whenever you build a non-trivial workflow):
- CRITICAL UX: nodes the user must edit or operate (input_text / input_image, editable prompts, control run/clear buttons, split pickers) go toward the TOP of the canvas (smaller y). Put heavy processing / save / docs lower or further right so the first thing users see is what they can change and ▶ run.
- Prefer a top band for 编辑区 + control nodes; processing and output zones below or to the right.
- To RETIDY an existing canvas: mtnode_canvas_get first, inspect each node's and mark's x/y/w/h, then ONE mtnode_canvas_edit with layout:false and update/updateMarks setting explicit coordinates/sizes. Keep spacing comfortable and neat; re-wrap or move marks with their nodes.
- Use createMarks with kind "box" and around:["alias1","alias2"] (plus label:"编辑区") so zone frames hug the nodes after auto-layout. pad defaults to 36.
- Add kind "text" marks for titles / how-to notes the user can edit later (not wired; pure decoration).
- Separate regions: editable inputs, documentation, processing, outputs — different box colors from markColors help.
- Add at least one control node near the process zone: ctrlAction "run" connected to the main proc/save chain so the user can ▶ re-run without hunting nodes; optionally a second control with ctrlAction "clear".
- Do not rely only on groups for visibility — boxes + text remain useful — but DO put related nodes AND their zone marks into the same group so users can move/scale the whole section.

Image reference nodes:
- kind must be input_image (not "image").
- Set imagePath to an absolute path on THIS machine. The app copies into workflow assets — do NOT ask the user to drag-and-drop when you know the path.
- For several images on one node: batch:true and imagePaths:[...].

Separate text processing from image→text (multimodal):
- Keep vision/OCR on its own node; downstream pure-text nodes take that text, NOT raw images.

Batch pipelines — CRITICAL (avoid N² token blow-ups):
- batchMode "batch" = one run PER item. Each run must see ONLY that item's data — never the whole batch again.
- FORBIDDEN: wiring a batch of N images/texts into a per-item proc_image/proc_text such that every run also receives all N items as refs/@mentions/extra wires. That yields ~N×N image/API calls and huge token waste.
- FORBIDDEN: treating a batch source as if it were a single image while still leaving the node in batch mode (or listing every batch title inside one prompt and also running batch).
- SAFE patterns:
  1) One linear batch chain: input_batch → proc (batchMode batch) → save — each step aligned 1:1.
  2) Need one item only (or before a heavy 文生图): insert a split node, pick the item, then wire the single output into proc_image — split breaks batch so downstream is NOT multiplied.
  3) Need "see all items once": batchMode "agg" on that node only (single run), not batch+all-refs.
- Prefer split when unsure. Prefer ordinary proc_text/proc_image for per-item batch; avoid agent_task / agent:true on long batch chains.
- Aggregate mode (batchMode "agg"): smart/agent nodes are allowed (single run over all items).

Image generation (proc_image / 文生图) — CRITICAL:
- Each run produces EXACTLY ONE image. Never ask for multiple images in one prompt.
- Need many images? One batch item → one image (batchMode batch), OR multiple proc_image nodes, OR attempts N — never "generate N images in one prompt" and never N² via batch×all-refs.
- Set size from imageSizes (e.g. "2048x1360", "1280x1280", "auto").

Change node model / provider:
- API nodes: providerId + model. Agent nodes: provider + model.
- Call mtnode_canvas_get first when unsure. Do not change model on a running node.

Rules:
- Titles must be unique; @引用 needs the source wired into the consumer OR into a kind "global" node, plus @Title in prompt/task.
- One edit call should create the whole subgraph. layout defaults true when create is non-empty.
- Marks are created AFTER layout when around is used; absolute x/y also allowed (set layout false if you place everything yourself).
- Never remove or overlap the node that is currently running this task.
- After building, tell the user they can edit inputs / marks and use control ▶ to re-run.`

const MARK_SPEC = {
  type: 'object',
  additionalProperties: false,
  properties: {
    alias: {
      type: 'string',
      description: 'Local name for this mark in the SAME call (for updateMarks / removeMarks).',
    },
    kind: {
      type: 'string',
      enum: ['text', 'box', 'arrow'],
      description: 'Drawing type. box = zone frame; text = label/note; arrow = connector decoration.',
    },
    label: {
      type: 'string',
      description: 'When kind is box (or around implies box): also create a text title above the box.',
    },
    title: { type: 'string', description: 'Alias of label for box title text.' },
    text: { type: 'string', description: 'text mark body / note content.' },
    around: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Node ids/aliases/titles to wrap. After layout, box (default) is sized to cover them + pad. Prefer this over guessing x/y.',
    },
    nodes: {
      type: 'array',
      items: { type: 'string' },
      description: 'Same as around.',
    },
    pad: { type: 'number', description: 'Padding around wrapped nodes (default 36).' },
    x: { type: 'number' },
    y: { type: 'number' },
    w: { type: 'number' },
    h: { type: 'number' },
    x2: { type: 'number', description: 'arrow end x' },
    y2: { type: 'number', description: 'arrow end y' },
    color: {
      type: 'string',
      description: 'Hex color; prefer values from markColors in canvas_get.',
    },
    fontSize: { type: 'number', description: 'text mark font size 10-48.' },
    stroke: { type: 'number', description: 'box/arrow stroke width 1-8.' },
  },
}

const MARK_UPDATE_SPEC = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    alias: { type: 'string' },
    title: { type: 'string', description: 'Find text mark by exact text content (must be unique).' },
    text: { type: 'string' },
    around: { type: 'array', items: { type: 'string' } },
    nodes: { type: 'array', items: { type: 'string' } },
    pad: { type: 'number' },
    x: { type: 'number' },
    y: { type: 'number' },
    w: { type: 'number' },
    h: { type: 'number' },
    x2: { type: 'number' },
    y2: { type: 'number' },
    color: { type: 'string' },
    fontSize: { type: 'number' },
    stroke: { type: 'number' },
  },
}

const NODE_SPEC = {
  type: 'object',
  additionalProperties: false,
  properties: {
    alias: {
      type: 'string',
      required: true,
      description: 'Local name for this create item. Use it in connect/update/refs in the SAME call (not a canvas id).',
    },
    kind: {
      type: 'string',
      required: true,
      enum: KINDS,
      description: 'Node type. Use input_image for image reference nodes.',
    },
    title: { type: 'string', description: 'Unique display title. Used by @引用.' },
    text: { type: 'string', description: 'input_text body.' },
    prompt: {
      type: 'string',
      description:
        'proc_text / proc_image prompt (include @Title for wired or global-broadcast inputs; proc_image: ONE image only). Also judge criteria (optional; defaults to parent task goal).',
    },
    task: { type: 'string', description: 'agent_task task text. Include @Title for wired or global-broadcast inputs.' },
    goal: {
      type: 'string',
      description: 'task node: what this step should accomplish.',
    },
    steps: {
      type: 'array',
      items: { type: 'string' },
      description: 'task node: ordered sub-step titles. Can later be expanded into inner child tasks.',
    },
    parentTaskId: {
      type: 'string',
      description:
        'Put this node INSIDE a task (id, alias from this call, or unique title). Empty = current canvas scope. Create the parent task first in the same call.',
    },
    savePath: { type: 'string', description: 'save_text / save_image destination. Prefer relative path under the canvas working directory (e.g. items.yaml) so changing the workspace moves all saves; absolute paths still allowed.' },
    waitPath: {
      type: 'string',
      description:
        'wait_file: path to watch until the file exists (relative to workspace preferred, or absolute). No input ports; wire output to downstream only to block early runs; does not output content.',
    },
    waitIntervalSec: {
      type: 'number',
      description: 'wait_file: poll interval in seconds (1–60, default 2).',
    },
    timerMode: {
      type: 'string',
      enum: ['once', 'interval', 'cron'],
      description: 'timer: once at timerAt, interval every timerEverySec, or cron.',
    },
    timerAt: {
      type: 'string',
      description: 'timer once: local datetime "YYYY-MM-DDTHH:mm".',
    },
    timerEverySec: {
      type: 'number',
      description: 'timer interval seconds (1–604800, default 3600).',
    },
    timerCron: {
      type: 'string',
      description: 'timer cron: 5 fields "min hour dom mon dow" local time.',
    },
    timerArmed: {
      type: 'boolean',
      description: 'timer: start armed so the schedule fires and runs outgoing targets.',
    },
    imagePath: {
      type: 'string',
      description:
        'input_image: absolute file path on this machine. App copies it into workflow assets (single image). Prefer this over asking the user to drag-drop.',
    },
    imagePaths: {
      type: 'array',
      items: { type: 'string' },
      description:
        'input_image: multiple absolute image paths (enables batch entries). Each path is copied into workflow assets.',
    },
    agent: { type: 'boolean', description: 'proc_text: turn on 智能 mode (agent run).' },
    auto: { type: 'boolean', description: 'save_*: auto-save when upstream runs.' },
    batch: { type: 'boolean', description: 'input_*: batch entries mode.' },
    batchMode: {
      type: 'string',
      enum: ['batch', 'agg'],
      description:
        'proc_*/save_*/agent_task: "batch"=one run per item (each run must NOT also ingest the whole batch — use split to pick one item); "agg"=one run over all items. Wrong combo causes N² token cost.',
    },
    providerId: {
      type: 'string',
      description:
        'proc_text / proc_image / chat: API provider id or unique name from Settings.',
    },
    provider: {
      type: 'string',
      description:
        'agent_task / proc_text(agent): deepseek-official, mtnode_<id>, or provider display name.',
    },
    model: {
      type: 'string',
      description: 'Model id to use on this node (replaces the current model).',
    },
    size: {
      type: 'string',
      description:
        'proc_image only: output size, must be one of imageSizes from mtnode_canvas_get (e.g. "2048x1360", "1280x1280", "auto"). Choose by aspect ratio need; default "2048x1360".',
    },
    ctrlAction: {
      type: 'string',
      enum: ['run', 'clear'],
      description: 'control node: run or clear all connected nodes (not used on start/end).',
    },
    ctrlRole: {
      type: 'string',
      enum: ['start', 'endSuccess', 'endFail'],
      description:
        'control node role. Tasks auto-create pinned start / endSuccess / endFail; do not delete pinned ones. Extra ends may be created with these roles.',
    },
    refs: {
      type: 'array',
      items: { type: 'string' },
      description: 'Titles to insert as @Title in prompt/task if missing.',
    },
    x: { type: 'number', description: 'Optional canvas x; omit to let layout place it.' },
    y: { type: 'number', description: 'Optional canvas y; omit to let layout place it.' },
  },
}

const UPDATE_SPEC = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', description: 'Existing node id.' },
    alias: { type: 'string', description: 'Alias from create in this same call.' },
    title: { type: 'string', description: 'Find existing node by current title (must be unique).' },
    setTitle: { type: 'string', description: 'New title.' },
    text: { type: 'string' },
    prompt: { type: 'string' },
    task: { type: 'string' },
    goal: { type: 'string', description: 'task node goal.' },
    steps: {
      type: 'array',
      items: { type: 'string' },
      description: 'task node: replace step titles.',
    },
    parentTaskId: {
      type: 'string',
      description: 'Move node into a task (id/alias/title) or empty for top-level.',
    },
    savePath: { type: 'string' },
    waitPath: { type: 'string', description: 'wait_file: path to watch.' },
    waitIntervalSec: { type: 'number', description: 'wait_file: poll seconds 1–60.' },
    timerMode: {
      type: 'string',
      enum: ['once', 'interval', 'cron'],
      description: 'timer: once at timerAt, interval every timerEverySec, or cron expression.',
    },
    timerAt: {
      type: 'string',
      description: 'timer once: local datetime "YYYY-MM-DDTHH:mm".',
    },
    timerEverySec: {
      type: 'number',
      description: 'timer interval: seconds between fires (1–604800).',
    },
    timerCron: {
      type: 'string',
      description: 'timer cron: 5 fields "min hour dom mon dow" in local time.',
    },
    timerArmed: {
      type: 'boolean',
      description: 'timer: arm/disarm the schedule; when armed each fire runs outgoing targets.',
    },
    imagePath: {
      type: 'string',
      description: 'input_image: replace/set single image from absolute path.',
    },
    imagePaths: {
      type: 'array',
      items: { type: 'string' },
      description: 'input_image: append/replace batch images from absolute paths.',
    },
    agent: { type: 'boolean' },
    auto: { type: 'boolean' },
    batch: { type: 'boolean' },
    batchMode: { type: 'string', enum: ['batch', 'agg'] },
    providerId: {
      type: 'string',
      description:
        'proc_text / proc_image / chat: set API provider by id or unique name.',
    },
    provider: {
      type: 'string',
      description:
        'agent_task / proc_text(agent): set route provider (deepseek-official / mtnode_<id> / name).',
    },
    model: {
      type: 'string',
      description: 'Replace this node\'s model id.',
    },
    size: {
      type: 'string',
      description:
        'proc_image: set output size to a value from imageSizes (mtnode_canvas_get).',
    },
    refs: { type: 'array', items: { type: 'string' } },
    ctrlRole: {
      type: 'string',
      enum: ['start', 'endSuccess', 'endFail'],
    },
    x: { type: 'number' },
    y: { type: 'number' },
    w: { type: 'number' },
    h: { type: 'number' },
  },
}

const PAIR_SPEC = {
  type: 'object',
  additionalProperties: false,
  properties: {
    from: {
      type: 'string',
      required: true,
      description: 'Source node: id, create-alias, or unique title.',
    },
    to: {
      type: 'string',
      required: true,
      description: 'Target node: id, create-alias, or unique title.',
    },
    fromIndex: {
      type: 'number',
      description: 'Source output port. judge: 0 = YES, 1 = NO. Default 0.',
    },
  },
}

function jsonResult(value) {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

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
    if (m.t === 'canvas-result') {
      pending.delete(m.id)
      if (m.ok === false) p.reject(new Error(String(m.error || 'canvas op failed')))
      else p.resolve(m.result == null ? { ok: true } : m.result)
    } else if (m.t === 'abort') {
      pending.delete(m.id)
      p.reject(new Error('canvas op aborted (task ended)'))
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
      failAll(new Error('canvas channel closed'))
      setTimeout(connect, 2000)
    })
  }
  connect()

  const rpc = (op, params, exec) => {
    if (!socket || socket.destroyed) {
      return Promise.reject(new Error('canvas channel unavailable (only works inside the MTNode app)'))
    }
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      send({ t: 'canvas', id, op, params: params || {} })
      const onAbort = () => {
        if (!pending.has(id)) return
        pending.delete(id)
        send({ t: 'drop', id })
        reject(new Error('canvas op aborted'))
      }
      exec && exec.signal && exec.signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  ctx.tools.register(defineTool({
    name: 'mtnode_canvas_get',
    description: GET_DESC,
    parameters: {},
    timeoutMs: 15000,
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => jsonResult(value),
    },
    async execute(_args, exec) {
      return rpc('get', {}, exec)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'mtnode_app',
    description: APP_DESC,
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: [
          'status',
          'list_workflows',
          'rename_workflow',
          'delete_workflow',
          'select_nodes',
          'undo',
          'redo',
        ],
        description: 'App-level action to perform.',
      },
      node: {
        type: 'string',
        description: 'For select_nodes: node id or unique title.',
      },
      nodes: {
        type: 'array',
        items: { type: 'string' },
        description: 'For select_nodes: multiple ids or unique titles.',
      },
      workflow: {
        type: 'string',
        description: 'For rename/delete: workflow id or exact name.',
      },
      name: {
        type: 'string',
        description: 'For rename_workflow: display name.',
      },
    },
    timeoutMs: 30000,
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => jsonResult(value),
    },
    async execute(args, exec) {
      return rpc('app', args || {}, exec)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'mtnode_canvas_edit',
    description: EDIT_DESC,
    parameters: {
      create: {
        type: 'array',
        description: 'Nodes to add. alias is required and is used by connect in this same call.',
        items: NODE_SPEC,
      },
      update: {
        type: 'array',
        description: 'Patch existing or just-created nodes (id, alias, or unique title).',
        items: UPDATE_SPEC,
      },
      connect: {
        type: 'array',
        description: 'Wires from source to target. from/to = id, alias, or unique title.',
        items: PAIR_SPEC,
      },
      disconnect: {
        type: 'array',
        description: 'Remove wires matching from→to.',
        items: PAIR_SPEC,
      },
      remove: {
        type: 'array',
        items: { type: 'string' },
        description: 'Node ids, aliases, or unique titles to delete. Cannot delete a running node.',
      },
      group: {
        type: 'object',
        additionalProperties: false,
        description:
          'Wrap nodes and/or marks in a canvas group. Prefer including zone marks so the whole region moves/scales together.',
        properties: {
          title: { type: 'string', description: 'Group label, e.g. 处理区.' },
          nodes: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Node and/or mark ids/aliases/titles to include. Mark refs resolve after createMarks. Omit to group every node created in this call (and createMarks if marks omitted).',
          },
          marks: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Mark ids/aliases (or unique text). Omit with nodes omitted to include all createMarks from this call.',
          },
        },
      },
      createMarks: {
        type: 'array',
        description:
          'Canvas drawings (text / box / arrow). Prefer box+around+label to zone the layout for the user. Created after node layout.',
        items: MARK_SPEC,
      },
      marks: {
        type: 'array',
        description: 'Alias of createMarks.',
        items: MARK_SPEC,
      },
      updateMarks: {
        type: 'array',
        description: 'Patch existing marks by id, createMarks alias, or unique text content.',
        items: MARK_UPDATE_SPEC,
      },
      removeMarks: {
        type: 'array',
        items: { type: 'string' },
        description: 'Mark ids, aliases, or unique text labels to delete.',
      },
      layout: {
        type: 'boolean',
        description: 'Auto-layout so nodes do not overlap (layered left-to-right). Defaults true when create is non-empty; pass false only if you set x/y yourself. Marks with around wrap nodes after this layout.',
      },
      setWorkflowName: {
        type: 'string',
        description: 'Optional new name for the current workflow tab.',
      },
    },
    timeoutMs: 300000,
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => jsonResult(value),
    },
    async execute(args, exec) {
      return rpc('edit', args || {}, exec)
    },
  }))

  const VISION_DESC = `Vision subagent: inspect a local image with a multimodal (vision) model and return a text answer. Use when you need to READ pixels mid-task — e.g. game UI layout, screenshot OCR, icon/button recognition, verifying a generated image — without wiring a permanent vision node.

Requirements:
- imagePath must be an absolute path on THIS machine (workflow asset path, screenshot file, etc.).
- question: what to look for (Chinese OK). Be specific.
- FIRST CALL in this app requires user permission (host shows Allow once / Always allow / Deny), unless the user already set Always allow / full-access / session allow in the top-right Approvals button.
- The host picks a vision model by provider order then model order in Settings → Model services (DeepSeek Official cannot read images — put a vision-capable OpenAI-compatible provider first).
- Prefer this over attaching large image batches to the main agent prompt (saves tokens; avoids N² batch mistakes).
- Do not use for generating new images — only for understanding existing ones.`

  ctx.tools.register(defineTool({
    name: 'mtnode_vision',
    description: VISION_DESC,
    parameters: {
      imagePath: {
        type: 'string',
        required: true,
        description: 'Absolute path to a local image file to inspect.',
      },
      question: {
        type: 'string',
        required: true,
        description:
          'What to look for / ask about the image (e.g. describe the game HUD and list clickable buttons).',
      },
      model: {
        type: 'string',
        description: 'Optional vision model id; omit to use the host default vision route.',
      },
    },
    timeoutMs: 180000,
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => jsonResult(value),
    },
    async execute(args, exec) {
      return rpc('vision', args || {}, exec)
    },
  }))
}
