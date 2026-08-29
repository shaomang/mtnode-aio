# Input / process / save

![Flow](img/io-proc.svg)

## Input

- **Text**: edit in place; 📄 imports txt / md / json / yaml (rejected over 500KB).
- **Image**: click or drop a file.
- **File node / Table** (inside a database super): batch import arbitrary files and agent-built tables, see [Database nodes](#database-nodes).

## Process

- **Text**: prompt + inputs → LLM. **🐋 Agent** turns it into a task ([Agent task](#agent-nodes)).
- **Image generation**: text-to-image; reference images use edit APIs. Vision needs “Vision” enabled (DeepSeek Official has no vision).
- **Music / video generation**: MiniMax Music 3 / H3 local backends with their own output paths, see [Music, video, network and execute nodes](#media-net).
- **Anim**: slice an image on a grid into a GIF; chroma key optional.

**▶ run · ◈ preview · API** for provider / model / temperature / size. **Attempts** (1–10) run in parallel; square tabs pick which result downstream sees. When a process node finishes, downstream runs automatically; if they already have output, choose overwrite or stop.

Output **Browse / Copy / Clear** opens a large viewer or resets.

## Save

Set a path, then ▶ writes YAML or an image. Optional auto-save on input change. Relative paths need a workspace; see [Workspace](#workspace).
