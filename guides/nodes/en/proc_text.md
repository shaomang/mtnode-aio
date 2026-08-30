# Text process

![diagram](img/proc_text.svg)

LLM processes upstream text from a prompt. Enable assistant mode for agent tools.

## Ports
- **In**: text (multi / @refs)
- **Out**: text

## While it runs
With the assistant on, **thinking and output are shown apart**: reasoning collapses into **“◉ Thinking · N chars”** blocks (N counts reasoning only), what the model says appears as normal body text, and **🔧 tool** calls sit inline where they happened. The output port still hands downstream the full text.
