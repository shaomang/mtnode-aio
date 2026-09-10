# Agent task & session

> One-sentence goal: put a node on the canvas that “works on its own”, and use the full-screen agent session or the right-hand global assistant to turn a one-line request into a re-runnable workflow.

![智能任务节点](img/mtnode-agent-02-ui.svg)
*Figure 1: an agent task node — the prompt is the task description, and the 💬 in its header switches it to chat mode*

## Goal

After this page you can create an agent task node and have it read and write real files, run commands, go online and read images; switch it to chat mode for multi-turn follow-ups; say clearly which canvas a session belongs to and when to turn off 与画布无关 (canvas-free); and finally get a session or the assistant to build a workflow on the canvas for you.

## Before you start

- A working provider and key configured in [Providers & API](#providers) — model calls go through it.
- A working directory chosen: pick one with the folder window on the node; when a dev node on the canvas sets a project root, that root wins (see [Dev nodes](#dev-nodes)).
- Know the top-right [Approvals](#approvals): an agent node's file reads, file writes, commands and network access are all bound by the four presets and the tool permissions.
- To use skills and MCP, install them first in [Plugins, skills, MCP](#plugins-skills).

## Steps

1. **Create the node**: right-click empty canvas → **智能节点 (Agent node)**. A text-process node with 🐋 Smart turned on (`proc_text` agent mode) has the same capabilities.
2. **Write the task**: state the goal and the acceptance criteria in the prompt box — **the prompt is the task description**, and within one run the model breaks it into steps by itself.
3. **Wire the input**: connect an upstream port when you need its content, or write `@节点标题` in the prompt to reference a node; type `/` to bring up skill candidates.
4. **Pick model and directory**: choose the provider / model on the node, and pick the working directory with the folder window.
5. **Hit ▶ run**: the node reasons in multiple steps by itself, and the thinking, body text and 🔧 tool calls in between are shown as segments in the order they happened.

> 💡 Tip: an agent node **has no “attempts”** — that is the gacha count of generation nodes. One run of an agent node already contains multiple steps; it is not parallel sampling.

### Batch and aggregate

- **batch**: one run per input item, and **each run sees only that item** — right for “N pieces of material, one article each”.
- **agg**: one run for the whole batch, seeing everything at once — right for “summarise these N items into one report”.
- For per-item batches prefer an ordinary process node and use an agent node only for aggregation; otherwise every run re-sends the whole batch and the number of calls grows quadratically.

### Chat mode (💬)

1. **Switch mode**: click **💬** in the node header and the node becomes a **chat-mode** node.
2. **Chat**: WeChat-style multi-turn bubbles (assistant on the left, you on the right); **history is saved with the node**, so follow-ups happen right in the node.
3. **Open an old node**: the standalone 文本对话 (Text chat) node has been removed — a chat node on an old canvas **migrates automatically** into an agent task node with chat mode when opened.
4. **Expand into a session**: when you need full screen and a longer context, **expand to agent session** in one click (node and session content stay in sync).
5. **Delete**: deleting the node asks whether to delete the linked session as well.

### What an agent node is allowed to do

An agent node finishes work in the workspace and **does not edit the canvas**. Specifically (still bound by the top-bar 审批 (Approvals) and the permission presets):

- multi-step reasoning to the task description and a result
- **read / write / edit** workspace files
- run commands in the workspace
- search the web and fetch pages
- use installed skills and connected MCP tools
- read images (`mtnode_vision`)
- use wired-in `@` references, batch / aggregate, and the selected model

An agent node **cannot**: read or edit the canvas, change workflows, create task graphs or nodes / wires, or rename or delete workflows. When you need a graph built, use an agent session or the global assistant.

## Agent session

The top-bar **会话 (Agent session)** view: many sessions, grouped by working directory, archive, fork and slash commands (type `/` for skills and `/new` `/compact` `/plan` `/help`). Besides files, network and commands, it can also view and edit **the canvas that session belongs to**.

### Which canvas a session belongs to

A session adopts a canvas **the moment it is created**: whichever one you are looking at then; and a session created from a dev node's 开发 / 细化 / 问询 (Develop / Refine / Ask) button belongs to the canvas that feature block lives on. Afterwards **you can freely switch to other canvases and keep working** — that session's graph reads and writes, its working directory and its database grounding all land precisely on its own canvas, **never on the one you are currently looking at**, and it will not wrongly change or delete the canvas you are editing. The ▣ under each session title in the sidebar, and its tooltip, say which canvas that session owns (a deleted canvas is marked as deleted).

A session **does not** read or write across canvases: to consult or switch to another canvas, use the **全局助手 (global assistant)** (✦) at the right of the canvas, with its work scope switched to 全局 (global).

![会话属于哪张画布](img/mtnode-agent-03-state.svg)
*Figure 2: a session adopts its canvas the moment it is created, and switching canvases later never crosses the wires*

![全局助手](img/mtnode-agent-04-ui.svg)
*Figure 3: the global assistant ✦ at the right of the canvas — its work scope can be 仅当前画布 (current canvas only) or 全局 (global), and it confirms with you before changing the canvas*

### The 与画布无关 (canvas-free) switch

The small **与画布无关 (canvas-free)** button under the session's input box (the assistant panel at the right of the canvas has one of the same name at its top, controlling the assistant itself) is a tier **you declare by hand**: once on, that turn **registers no canvas and no app tools** — `mtnode_canvas_get` / `mtnode_canvas_edit` / `mtnode_app` do not exist — and **the whole canvas snapshot is no longer injected** either; only file reads and writes, the web and commands remain (image reading is still open per tool permission). For canvas work that does not need it, it cuts a big slice off the prefix re-sent at every step, so **long sessions cost noticeably fewer tokens**. The price is that it genuinely **cannot see the canvas**: **to have it summarise or build a workflow, turn this switch off and run again**; while it is on, it will simply answer “turn it off if you need to change the canvas” rather than pretend it edited the graph. This switch is stored with the session and inherited by forks, and it is not the same tier as 纯净模式 (pure mode).

A **bound session** created by a dev node's 开发 / 细化 (Develop / Refine) is a different tier decided **by the host**: it **does not read the canvas** (`mtnode_canvas_get` and `mtnode_app` are not registered, and the canvas state is taken from the dev task brief), but `mtnode_canvas_edit` **is kept** — the brief carries **this node's id**, so at the end it writes back this node's overview / status / core file list by that id, **without reading the whole graph first just to get the id**. See [Dev nodes](#dev-nodes).

## While it runs: thinking and output are separate

A run is segmented **in the order things happen**: “◉ 思考 · N 字 (Thinking · N chars)” is the collapsed internal reasoning of the model (N counts reasoning characters only), normal-sized paragraphs are the **body text** the model says (what it says at intermediate steps counts as body text too), **🔧 工具 (tool)** calls sit inline where they happened, and errors appear as ⚠ attached to the body. Every tool call or new reasoning step starts a new segment.

An agent task node (chat mode included), an agent session and the right-hand global assistant follow the same rules; the big “Thinking” window on a node shows reasoning on the top half and output on the bottom half. The output port still hands downstream the complete body text, and older sessions archive and display as before. See [What agent mode is](#dsh).

## Let the assistant build a workflow

Say “build a workflow that does xxx” in an **agent session** or the global assistant and the model **creates nodes, changes titles, wires them and writes @ references** on **its own canvas**, with automatic layout (a session = the canvas it belongs to; the right-hand assistant = the one you are looking at). You then adjust prompts and save paths and hit ▶. An agent node on the canvas never changes the graph.

The global assistant (✦ at the right of the canvas) can also inspect state and build a graph, but it confirms before changing the canvas. **The docs Q&A assistant never edits the canvas.**

![让助手搭工作流](img/mtnode-flow-12-flow.svg)
*Figure 4: say one sentence of requirement → nodes appear one by one → they are wired and laid out into zones*

## Result

- The canvas has an agent node that can run a multi-step task on its own; switch it to 💬 chat mode and the follow-up history stays in the node.
- The top-bar 会话 (Agent session) view shows that session, with ▣ under its title marking the canvas it owns; switch to another canvas and back and it still only touches its own graph.
- After saying “build a workflow that does xxx”, fully formed nodes, wires and zones appear on the canvas — edit the prompts and hit ▶ to run it again.

## Common mistakes

| Symptom | Cause | Fix |
| --- | --- | --- |
| You ask it to change the canvas and it answers “turn off the switch first” | 与画布无关 (canvas-free) is on, so no canvas tools are registered | Turn the switch off and run again, or use an agent session / the global assistant |
| It read another canvas, or changed the wrong graph | You switched canvases but expected it to follow | A session is locked to the canvas it was created on; to work across canvases use the global assistant with its scope set to 全局 (global) |
| A file was written into the project root, not the top-bar directory | A dev node on the canvas sets `devPath`, so the agent workspace becomes the project root | That is by design; to write into the canvas directory, type the working directory by hand, or use an absolute path |
| A batch task's call volume exploded | An agent node was used for a per-item batch, re-sending the whole batch every run | Use an ordinary process node for per-item work and leave only aggregation to the agent node |
| The 文本对话 (Text chat) node on an old canvas is gone | That node was removed and migrates on open | Just open it — it becomes an agent task node with chat mode |

## Next

- [Approvals](#approvals)
- [Plugins, skills, MCP](#plugins-skills)
- [Dev nodes](#dev-nodes)
- [Nodes, wires, @ refs](#nodes-wires)
