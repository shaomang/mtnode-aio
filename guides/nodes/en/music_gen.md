# Minimax Music 3 (music generation)

![diagram](img/music_gen.svg)

Right-click the canvas → **Process › Audio generation › Minimax Music 3**. Local MiniMax Music 3 backend (Gradio). **Each run produces exactly one audio file** (`.wav`) written to the node's own `outputPath` — no separate save node needed.

## Ports
- **Input**: port 0 = prompt · port 1 = lyrics (optional — leave it unwired to generate pure instrumental `[instrumental]`) · port 2 = control input
- **Output**: port 0 = audio (play / save downstream) · port 1 = control output

## Options
Click **⚙ Settings** in the node header to open the settings window; changes apply immediately and the card itself keeps showing just a one-line summary.

- **Output path**: `.wav` destination (relative to workspace / super subfolder)
- **Attempts**: gacha rolls (1–10); keep one result
- **Seed**: fixed seed reproduces; each roll bumps the seed by +1

## Notes
- Only **1 audio/video task** is allowed globally at a time (music and video are mutually exclusive); other tasks queue.
- One backend instance per plugin; multiple music nodes share it.
- Lyrics and style-prompt conventions live in the **built-in skills** `minimax-music-lyrics` (port 1) / `minimax-music-prompt` (port 0) — both ship with the app, **no Creative Workshop download needed**; type `/minimax-music-prompt <your idea>` in a session to use them. A style prompt is delivered as **one English paragraph of six sentences**: style + mood → tempo & groove → instruments → vocals → structure & contrast → production.
- **Backend errors pop a dialog**: this node's backend is installed locally, so when that install or the running backend breaks, the main window shows an **error report** (error code, error body, console log tail, the node that failed) and offers **🤖 Auto-repair** — a visible session that works in the `minimax-music3-install` skill's self-repair mode inside this plugin's **INSTALL_DIR** and, on success, **restarts the Music 3 backend** and refreshes this node's status. Cancelled-by-you / busy / out of disk / no NVIDIA GPU / driver too old / invalid install directory get the report only, never an auto-repair (see "Plugin error dialogs and auto-repair" in the manual).
