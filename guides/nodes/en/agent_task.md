# Agent task

![diagram](img/agent_task.svg)

Agent run: files, web, shell. Output is filled from the run. Tool allowlist is the Approvals preset.

## Settings
**Preset / provider / model / thinking effort** are changed in the settings window opened by **⚙ Settings** in the node header (the preset list is the same one the agent chat uses); the card itself shows a one-line summary. The task text is content, so it stays in the node.

## Chat mode (💬)
The **💬** button in the node header switches to chat mode: WeChat-style bubbles (assistant left, user right), history saved with the node, follow-ups right on the canvas. The old standalone “Chat” node was removed — opening an older canvas migrates it into an agent task in chat mode.

## While it runs
**Thinking and output are shown apart.** The run renders in chronological segments: **“◉ Thinking · N chars”** collapses the model's private reasoning (N counts reasoning only), text the model says mid-run shows as **normal body text**, **🔧 tool** calls sit inline where they happened, errors append as ⚠. Every tool call or new reasoning step starts a fresh segment; the node header's **「◉ Thinking」** button opens the big view (reasoning on top, output below). The output port still hands downstream the full text.
