# Chat

![diagram](img/chat.svg)

Multi-turn chat. Assistant mode uses an agent session stored on this node.

## Ports
- **In**: none
- **Out**: chat text

## While it runs
With the assistant on, **thinking and output are shown apart**: above each bubble the run renders in chronological segments — **“◉ Thinking · N chars”** collapses reasoning, body text (including what the model says mid-run) shows in normal size, and **🔧 tool** calls sit inline as chips.
