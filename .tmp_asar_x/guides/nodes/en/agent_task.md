# Agent task

![diagram](img/agent_task.svg)

Agent run: files, web, shell. Output is filled from the run. Tool allowlist is the Approvals preset.

## While it runs
**Thinking and output are shown apart.** The run renders in chronological segments: **“◉ Thinking · N chars”** collapses the model's private reasoning (N counts reasoning only), text the model says mid-run shows as **normal body text**, **🔧 tool** calls sit inline where they happened, errors append as ⚠. Every tool call or new reasoning step starts a fresh segment; the node header's **「◉ Thinking」** button opens the big view (reasoning on top, output below). The output port still hands downstream the full text.
