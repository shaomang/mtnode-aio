# What agent mode is

![Agent](img/dsh.svg)

With DeepSeek Harness (dsh) the model can **read/write the workspace, search the web, run commands, and spawn sub-agents**. The runtime ships with the app—**no extra Node install**.

Configure a **text provider** with an API Key first. Agent task, agent session, chat “Agent”, and text-process **🐋 Agent** all use this engine.

## Visible process

Runs show **◉ Thinking** with expandable thoughts and **🔧 tool calls**. Billing is per completed task and may call the model several times.

Confirm the [workspace](#workspace) before writes. See [Approvals](#approvals) for permission presets.

## Segmented thinking and output

A run renders as **chronological segments**, each with its own look:

- **◉ Thinking · N chars** — the model's private reasoning, collapsed by default; N counts **reasoning only**, not tools or prose.
- **Body text** — what the model actually says, normal size, rendered as Markdown, one block per paragraph. Text produced mid-run shows up as text instead of being buried in the thinking block.
- **🔧 Tools** — call chips inline where they happened (click for args and result); errors appear in the body as **⚠**.

A new segment starts on every tool call and on every reasoning step (turn / step). Agent task nodes, agent sessions, the global assistant and chat nodes all share this rendering; the node's Thinking overlay keeps reasoning on top and output (the tool trace) below.

**Downstream data is unchanged**: the output port and save nodes still receive the full text. Sessions archived before this change render exactly as before.

## Communication language (agent taste)

Whichever language you pick with the top-bar **中 / EN** button ships with every agent run as a *taste*: converse in that language and expect the agent to answer in it — questions, plans, progress notes and final answers, and the same for every sub-agent or bound dev session it spawns. Settings → agent capabilities shows which language is active.

The taste covers **conversation only**. Code, paths, commands and API fields stay verbatim, and fact records, table cells and file bodies keep the language of the source material — switching the UI language never translates them. An explicit language request from the user wins for that conversation.
