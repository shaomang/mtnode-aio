# Agent task

A general-purpose agent: it reads files, uses the web and runs commands from the task text, then fills the output. The task text is the node body.

## Ports
- **In**: text / references
- **Out**: the task's result text (full body)
- **Group** (hollow box at the end of the left column): wire the **□** on a canvas group frame or a node layer's **group output** port to receive a list (title + type + description + node id); a node-layer source lists its inner nodes indented by level. One group port takes several sources; a group wire does not run the source, the agent reads it by id. Priority: group input → canvas → project files → outside knowledge, and whatever the task says explicitly always comes first.

## Settings
Change these in the settings window opened by **⚙ Settings** in the node header; the card only shows a one-line summary:

- **Preset / provider / model / thinking effort**: the preset list is the same one the agent chat uses.
- **Working folder**: where this agent's files and commands live.
- **Intermediate artifacts**: artifacts carried with the workflow — reuse, regenerate or drop them.

## Usage
- Press ▶: upstream runs first, the agent calls tools as needed, and the body is written to the output port and passed downstream.
- Click **💬** in the header to switch to chat mode: WeChat-style bubbles (assistant left, user right), history saved with the node, follow-ups asked right here.

## Notes
- The run renders in chronological segments: **“◉ Thinking · N chars”** collapses the model's private reasoning (N counts reasoning only), mid-run text shows as normal body text, **🔧 tool** calls sit inline where they happened, and errors append as ⚠. The header's **「◉ Thinking」** button opens the big view (reasoning on top, output below).
- Tool capability follows the top-bar **Approvals** preset, which controls the sandbox and tool-overreach approval.
- The old standalone “Chat” node was removed; opening an older canvas migrates it into an agent task in chat mode.
