# Minimax Music 3 (music generation)

![diagram](img/music_gen.svg)

Right-click the canvas → **Process Node › Audio generation › Minimax Music 3**. Local MiniMax Music 3 backend (Gradio) that turns a prompt + lyrics into one song; **each run produces exactly one audio file** (`.wav`) at the node's output path.

## Ports
- **In**: port 0 = prompt · port 1 = lyrics (optional; unwired means pure instrumental `[instrumental]`) · port 2 = control input
- **Out**: port 0 = audio (preview / save downstream) · port 1 = control output

## Settings
- Change them in the **⚙ Settings** window opened from the node header.
- **Output path**: where the `.wav` goes (relative to the working directory / node-layer subfolder). Empty is fine once the data output feeds a downstream Save node — the file lands in the app-managed folder first and that Save node writes it. Without a Save node it is required, and ▶ warns “Generation cannot start until an output path is set”.
- **Duration (seconds)**: 10–150 (default 60)
- **Roll count**: sequential generations (1–10); multiple runs save as `#1`, `#2` …
- **Seed**: a fixed seed reproduces · **Reroll (seed +1 on every run)**: on by default
- **auto CPU offload (recommended on 24G)**: on by default

## Usage
- Wire the prompt to port 0 (lyrics to port 1) → set the output path or wire a Save node → press ▶.

## Notes
- Only **1 audio/video task** runs globally at a time (music / video are mutually exclusive); other tasks queue, and one backend instance is shared by every music node.
- Lyrics and style prompts use the **built-in skills** `minimax-music-lyrics` (port 1) / `minimax-music-prompt` (port 0) — **no Creative Workshop download** needed; type `/minimax-music-prompt your idea` in a session. A style prompt is always **one English paragraph of six sentences**: style + mood → tempo & groove → instruments → vocals → structure & contrast → production.
- **Plugin error dialog**: when the install or the running backend breaks, an error report appears with **🤖 Auto-repair**, which fixes it in this plugin's INSTALL_DIR following the `minimax-music3-install` skill's self-repair mode and restarts the backend; cancelled-by-you / installing / out of disk / no NVIDIA GPU get the report only.
