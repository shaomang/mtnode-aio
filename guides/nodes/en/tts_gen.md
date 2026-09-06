# SoVITS speech (GPT-SoVITS)

![diagram](img/tts_gen.svg)

Right-click the canvas → **Process › Audio generation › SoVITS speech**. Turns text into **speech**: the backend is the local OpenAI-compatible service started by the “GPT-SoVITS speech” plugin. **Each run produces exactly one audio file** (`.wav` / `.mp3`) written to the node's own `outputPath` — no separate save node needed.

## Ports
- **Input**: port 0 = text to speak · port 1 = control input
- **Output**: port 0 = speech audio (play / save downstream) · port 1 = control output

## Options
- **Output path**: audio destination (relative to workspace / super subfolder)
- **Voice**: a name from the GPT-SoVITS voice library; empty = whatever the backend defaults to
- **Speed**: 0.5 – 2.0 (default 1.0)
- **Format**: `.wav` / `.mp3`
- **Attempts**: gacha rolls (1–10); keep one result

## Notes
- If the backend is missing or stopped the node starts it and waits for it to come online (up to 3 minutes); failures are written on the node's status line as an actionable hint. Installing the backend and preparing voices happens in **Plugins › GPT-SoVITS speech**.
- Speech runs on the same **serial chain** as music / video (one generation task at a time), but SoVITS is a separate process and does **not** hold the app's audio/video global lock — its VRAM is its own budget.
- One text is enough: feed port 0 from a text input / text process node, or with an `@` reference.
