# Text process

![diagram](img/proc_text.svg)

An LLM processes upstream text from a prompt. Turn on assistant mode when it needs to read files or use the web; it then runs as an agent.

## Ports
- **In**: text (multiple wires / `@node` references to other nodes)
- **Out**: the processed text
- **Group** (only with assistant mode on; the hollow box at the end of the left column): wire the **□** on a canvas group frame or a node layer's **group output** port to receive a list (title + type + description + node id). A node-layer source is listed with its inner nodes indented by level. One group port takes several sources; a group wire does not run the source, the agent reads it by id when it needs the text. Priority: group input → canvas → project files → outside knowledge, and whatever the prompt says explicitly always comes first.

## Settings
Change these in the settings window opened by **⚙ Settings** in the node header; the card only shows a one-line summary:

- **Provider / model**: any provider configured on this machine.
- **Temperature**: 0–2, default 0.7.

The prompt is content and stays in the node; the header **◈** is a preview of the exact request that will be sent.

## Notes
- Thinking and output are shown apart: reasoning collapses into **“◉ Thinking · N chars”** (N counts reasoning only) and **🔧 tool** calls sit inline where they happened; the output port still hands downstream the full text.
- With assistant mode off it neither reads files nor uses the web — it answers from text alone.
