# Agent task & session

## Agent task node

Right-click → Agent node. The prompt is the task. Supports `@`, multi-input, batch / aggregate, model picker, browse. Pick the workspace with a folder dialog. No “attempts” (multi-step, not parallel sampling).

**Expand to agent session** keeps node and session in sync. Deleting the node can delete the linked session (you are asked).

## Agent session

Top bar **Agent session**: many sessions, grouped by workspace, archive, fork, slash commands (`/new` `/compact` `/plan` `/help`). Same capabilities as an agent task.

## Let the assistant build a workflow

Say “build a workflow for xxx”. The model **creates nodes, titles, wires, @refs** and lays them out. Then you edit prompts/paths and ▶.

The global assistant (✦) can inspect and edit the graph with confirmation. **The docs Q&A assistant never edits the canvas.**
