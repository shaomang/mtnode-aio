# Agent task & session

## Agent task node

Right-click → Agent node. The prompt is the task. Supports `@`, type `/` for skills, multi-input, batch / aggregate, model picker, browse. Pick the workspace with a folder dialog. No “attempts” (multi-step, not parallel sampling). Text nodes with 🐋 Agent on have the same capabilities.

The **💬** button in the header switches the node to **chat mode**: WeChat-style multi-turn bubbles (assistant left, user right) with history saved on the node. The standalone Chat node was removed — older canvases migrate their chat nodes into an agent task in chat mode on open.

**Expand to agent session** keeps node and session in sync. Deleting the node can delete the linked session (you are asked).

### What an agent node may do

Finish work in the workspace; it does **not** edit the canvas. Allowed (still gated by Approvals / the permission preset):

- Multi-step reasoning to complete the prompt
- **Read / write / edit** workspace files
- Run commands in the workspace
- Web search and fetch
- Installed skills and connected MCP tools
- Vision (`mtnode_vision`)
- Wired `@` refs, batch / aggregate, the selected model

An agent node **cannot** read or edit the canvas, change workflows, or create task graphs / nodes / wires. Use Agent session or the global assistant to build a graph.

## Agent session

Top bar **Agent session**: many sessions, grouped by workspace, archive, fork, slash commands (type `/` for skills and `/new` `/compact` `/plan` `/help`). Besides files / network / commands, it can inspect and edit **the canvas the session belongs to**.

### Which canvas does a session belong to?

A session adopts its canvas **the moment it is created**: whichever canvas you are looking at then, and for sessions started from a dev node's 开发 / 细化 / 问询 button, the canvas that feature block lives on. From then on **you are free to switch to other canvases and keep working** — that session's graph reads/writes, working directory and database grounding all land precisely on **its own** canvas, never on the one now on your screen, so it can't overwrite or delete what you are editing. The ▣ under each session title (and its tooltip) shows which canvas it owns (marked as deleted if that canvas is gone).

Sessions do **not** reach across canvases: to look at or switch between several, use the **global assistant** (✦) right of the canvas with its **work scope set to global**.

### The “Canvas-free” switch

The **Canvas-free** chip under the session's input box (the ✦ assistant panel has its own copy of the same switch, for the assistant) is a tier **you declare by hand**: while it's on, that run registers **no canvas and no app tools** — `mtnode_canvas_get` / `mtnode_canvas_edit` / `mtnode_app` do not exist — and **the full canvas snapshot is no longer injected**, leaving only files / web / commands (vision still follows the tool permission). When a conversation has nothing to do with the graph, that strips a large slice off the prefix every step re-sends, so **long sessions cost noticeably fewer tokens**. The price is that it is genuinely **blind to the canvas**: **to get a workflow summarised or built, turn the switch off and run again** — while it's on the assistant just tells you to turn it off rather than pretending to edit the graph. The setting is stored with the session, a fork inherits it, and it is not the same tier as 纯净模式 (pure mode).

Sessions started from a dev node's 开发 / 细化 (Develop / Refine) button are a **host-decided** tier instead: they **don't read the canvas** (`mtnode_canvas_get` and `mtnode_app` are not registered — the canvas state is whatever the dev task brief says), but `mtnode_canvas_edit` **stays available**, because the brief carries **this node's id**: the session writes back this one node's overview / status / core file list by that id, **without pulling the whole graph just to find its own id**. See [Dev nodes](#dev-nodes).

## While it runs: thinking and output are separate

A run renders in **chronological segments**: **“◉ Thinking · N chars”** is the model's collapsed private reasoning (N counts reasoning only), normal-sized paragraphs are what the model **says** (text produced mid-run counts as text too), **🔧 tool** calls sit inline where they happened, and errors append to the body as ⚠. Every tool call or new reasoning step starts a fresh segment.

Agent task nodes (chat mode included), agent sessions and the global assistant all render the same way; the node's Thinking overlay shows reasoning on top and output (the tool trace) below. The output port still hands downstream the full text, and sessions archived earlier render as before. See [What agent mode is](#dsh).

## Let the assistant build a workflow

In **Agent session** or the global assistant, say “build a workflow for xxx”. The model **creates nodes, titles, wires, @refs** and lays them out **on its own canvas** (a session: the canvas it belongs to; the ✦ assistant: the one you are looking at). Then you edit prompts/paths and ▶. Canvas agent nodes will not change the graph.

The global assistant (✦) can inspect and edit the graph with confirmation. **The docs Q&A assistant never edits the canvas.**
