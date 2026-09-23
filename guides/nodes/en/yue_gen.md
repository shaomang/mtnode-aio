# YuE2 music generation (lyrics → full song)

![diagram](img/yue_gen.svg)

Right-click the canvas → **Process › Audio generation › YuE2**. Local YuE2 backend (the “YuE2 Local Music” plugin, ported after the open-source [YuE](https://github.com/multimodal-art-projection/YuE) project). **Each run produces exactly one audio file** (`.wav`) written to the node's own `outputPath` — no separate save node needed.

YuE2 takes the “lyrics → full song” route: give it a **style prompt** and **lyrics** and it sings the whole song, optionally producing an **ABC score** as well; you can also hand-write the score and feed it in (port 2 / the node's own field).

## Ports
- **Input**: port 0 = style prompt · port 1 = lyrics · port 2 = ABC score (optional) · port 3 = control input
- **Output**: port 0 = audio (play / save downstream) · port 1 = control output

When ports 0 / 1 / 2 are not wired, the node reads the style prompt / lyrics / ABC score typed on the node itself.

## Options
Click **⚙ Settings** in the node header to open the settings window; changes apply immediately and the card itself keeps showing just a one-line summary.

- **Output path**: `.wav` destination (relative to workspace / super subfolder)
- **Chain-of-thought tier**: `full` (full CoT, best quality) · `melody` (melody guidance, faster) · `off` (no CoT, prompt only)
- **Attempts**: gacha rolls (1–10), one file per roll, named `#1`, `#2` …
- **Seed**: a fixed seed reproduces; with **reroll** on, each roll bumps the seed by +1
- **auto CPU offload (recommended on 24G)**: offloads part of the weights; keep it on for a 24G GPU

## Notes
- Only **1 audio/video task** is allowed globally at a time (music / speech / video are mutually exclusive); other tasks queue.
- One backend instance per plugin; multiple YuE2 nodes share it, and this node shares the same serial chain as Minimax Music 3.
- The backend is installed locally and wants a **24G-class NVIDIA GPU**; until it is installed the node shows a “plugin not installed” bar — install it in **Plugins › YuE2 Local Music**.
- For lyrics and style-prompt conventions you can follow the **built-in skills** `minimax-music-lyrics` / `minimax-music-prompt` (they ship with the app — no Creative Workshop download; their structure and tone apply to YuE2 as well, and a style prompt is always **one English paragraph of six sentences**: style + mood → tempo & groove → instruments → vocals → structure & contrast → production).
- **Backend errors pop a dialog**: when that install or the running backend breaks, the main window shows an **error report** (error code, error body, console log tail, the node that failed) and offers **🤖 Auto-repair** — a visible session that works in the `yue2-local-install` skill's self-repair mode inside this plugin's **INSTALL_DIR** and, on success, **restarts the YuE2 backend** and refreshes this node's status. Cancelled-by-you / busy / out of disk / no NVIDIA GPU / driver too old / invalid install directory get the report only, never an auto-repair (see “Plugin error dialogs and auto-repair” in the manual).
