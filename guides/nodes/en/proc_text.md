# Text process

![diagram](img/proc_text.svg)

LLM processes upstream text from a prompt. Enable assistant mode for agent tools.

## Ports
- **In**: text (multi / @refs)
- **Out**: text

## Settings
**Provider / model / temperature** are changed in the settings window opened by **⚙ Settings** in the node header (◈ previews the exact request that will be sent); the card itself shows a one-line summary. The prompt is content, so it stays in the node.

## While it runs
With the assistant on, **thinking and output are shown apart**: reasoning collapses into **“◉ Thinking · N chars”** blocks (N counts reasoning only), what the model says appears as normal body text, and **🔧 tool** calls sit inline where they happened. The output port still hands downstream the full text.
