# Agent task & session

## Agent task node

Right-click → Agent node. The prompt is the task. Supports `@`, type `/` for skills, multi-input, batch / aggregate, model picker, browse. Pick the workspace with a folder dialog. No “attempts” (multi-step, not parallel sampling). Text / chat nodes with Agent on have the same capabilities.

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

Top bar **Agent session**: many sessions, grouped by workspace, archive, fork, slash commands (type `/` for skills and `/new` `/compact` `/plan` `/help`). Besides files / network / commands, it can inspect and edit the current canvas.

## While it runs: thinking and output are separate

A run renders in **chronological segments**: **“◉ Thinking · N chars”** is the model's collapsed private reasoning (N counts reasoning only), normal-sized paragraphs are what the model **says** (text produced mid-run counts as text too), **🔧 tool** calls sit inline where they happened, and errors append to the body as ⚠. Every tool call or new reasoning step starts a fresh segment.

Agent task nodes, agent sessions, chat nodes and the global assistant all render the same way; the node's Thinking overlay shows reasoning on top and output (the tool trace) below. The output port still hands downstream the full text, and sessions archived earlier render as before. See [What agent mode is](#dsh).

## Let the assistant build a workflow

In **Agent session** or the global assistant, say “build a workflow for xxx”. The model **creates nodes, titles, wires, @refs** and lays them out. Then you edit prompts/paths and ▶. Canvas agent nodes will not change the graph.

The global assistant (✦) can inspect and edit the graph with confirmation. **The docs Q&A assistant never edits the canvas.**
