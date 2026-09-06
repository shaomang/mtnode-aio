# Input / process / save

![Flow](img/io-proc.svg)

## Input

- **Text**: edit in place; 📄 imports txt / md / json / yaml (rejected over 500KB).
- **Image**: click or drop a file.
- **Audio / video**: click or drop a local media file; the node previews it and outputs that file’s `file:///` URL (wireable into media reference slots, a save node, or `@`-referenced).
- **File node / Table** (inside a database super): batch import arbitrary files and agent-built tables, see [Database nodes](#database-nodes).
- **Asset**: the content does not live on this canvas but in the **asset library** (a local vault shared across canvases — deleting the canvas loses nothing); one content item = one pair of ports, see [Asset library & asset nodes](#asset-library).

## Process

- **Text**: prompt + inputs → LLM. **🐋 Agent** turns it into a task ([Agent task](#agent-nodes)).
- **Image generation**: text-to-image; reference images use edit APIs. Vision needs “Vision” enabled (DeepSeek Official has no vision). The **transparent toggle** in the title bar (click to toggle; when on it becomes a spinning rainbow edge) runs **two-pass difference matting**: pass 1 renders a **pure-black baseline** that becomes the matte's **sole reference**, pass 2 then receives exactly that baseline as its **only reference image** (sent at native size, never downscaled) and renders a **strict replica on pure white**, and the two are differenced per pixel against the measured background level into a real alpha channel — the output is a transparent PNG. It stays invisible to you, but every run generates twice (≈2× tokens); only providers that can take the baseline as a reference (OpenAI-compatible / Stability) get matted, the rest are **skipped explicitly with a notice** and deliver pass 1 (pure black) alone rather than painting a second image from scratch. Right-click the toggle for matte settings; see [Node guide](#node-guide).
- **Audio generation / Video generation** (two first-level submenus): **Minimax Music 3** for music, **SoVITS speech** for text-to-speech (GPT-SoVITS), **Minimax H3** and **Remotion video** for video — all local backends with their own output paths, see [Music, video, network and execute nodes](#media-net).
- **Anim**: slice an image on a grid into a GIF; chroma key optional.

**▶ run · ◈ preview · API** for provider / model / temperature / size. **Attempts** (1–10) run in parallel; square tabs pick which result downstream sees. When a process node finishes, downstream runs automatically; if they already have output, choose overwrite or stop.

Output **Browse / Copy / Clear** opens a large viewer or resets.

## Save

Set a path, then ▶ writes YAML or an image. Optional auto-save on input change. Relative paths need a workspace; see [Workspace](#workspace).
