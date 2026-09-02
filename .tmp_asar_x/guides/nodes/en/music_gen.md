# Music generation (MiniMax Music 3)

Local MiniMax Music 3 backend (Gradio). **Each run produces exactly one audio file** (`.wav`) written to the node’s own `outputPath` — no separate save node needed.

## Ports
- **Input**: port 0 = prompt · port 1 = lyrics · port 2 = control input
- **Output**: audio (play / save downstream) + control

## Options
- **Output path**: `.wav` destination (relative to workspace / super subfolder)
- **Attempts**: gacha rolls (1–10); keep one result
- **Seed**: fixed seed reproduces; each roll bumps the seed by +1

## Notes
- Only **1 audio/video task** is allowed globally at a time (music and video are mutually exclusive); other tasks queue.
- One backend instance per plugin; multiple music nodes share it.
