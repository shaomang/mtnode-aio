# SoVITS speech (GPT-SoVITS)

![diagram](img/tts_gen.svg)

Right-click the canvas → **Process › Audio generation › SoVITS speech**. Turns text into **speech**: the backend is the local OpenAI-compatible service started by the “GPT-SoVITS speech” plugin. **Each run produces exactly one audio file** (`.wav` / `.mp3`) written to the node's own `outputPath`. **The output path may be left empty too**: wire its **data output** into a downstream **Save** node and the path becomes that node's job — the file lands in the **app-managed folder** (the canvas-asset / temp area under the app data directory) first, and that Save node then writes it to the save path you set.

## Ports
- **Input**: port 0 = text to speak · port 1 = control input
- **Output**: port 0 = speech audio (play / save downstream) · port 1 = control output

## Options
Click **⚙ Settings** in the node header to open the settings window; changes apply immediately and the card itself keeps showing just a one-line summary.

- **Output path**: audio destination (relative to workspace / super subfolder). **Empty is fine once a Save node is wired** — the path then belongs to that Save node: the file lands in the app-managed folder first and the Save node writes it (see the Save node guide). Without a Save node it is required, and ▶ warns “Generation cannot start until an output path is set”.
- **Voice**: a name from the GPT-SoVITS voice library; empty = whatever the backend defaults to
- **Speed**: 0.5 – 2.0 (default 1.0)
- **Format**: `.wav` / `.mp3`
- **Attempts**: gacha rolls (1–10); keep one result

## Notes
- If the backend is missing or stopped the node starts it and waits for it to come online (up to 3 minutes); failures are written on the node's status line as an actionable hint. Installing the backend and preparing voices happens in **Plugins › GPT-SoVITS speech**.
- **Backend errors pop a dialog**: speech also installs locally, so when that install or the running backend breaks, the main window shows an **error report** (error code, error body, console log tail, the node that failed) and offers **🤖 Auto-repair** — a visible session that works in the `tts-local-install` skill's self-repair mode inside this plugin's **INSTALL_DIR** and, on success, **restarts the speech backend** and refreshes this node's status. Cancelled-by-you / busy / out of disk / driver too old / invalid install directory get the report only, never an auto-repair (see "Plugin error dialogs and auto-repair" in the manual).
- Speech runs on the same **serial chain** as music / video (one generation task at a time), but SoVITS is a separate process and does **not** hold the app's audio/video global lock — its VRAM is its own budget.
- One text is enough: feed port 0 from a text input / text process node, or with an `@` reference.
