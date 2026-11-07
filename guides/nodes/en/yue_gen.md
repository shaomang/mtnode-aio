# YuE2 music generation (lyrics to full song)

![diagram](img/yue_gen.svg)

Right-click the canvas → **Process Node › Audio generation › YuE2**. Local YuE2 backend: give it a style prompt plus lyrics and it sings the whole song (optionally producing an ABC score too); **each run produces exactly one audio file** (`.wav`).

## Ports
- **In**: port 0 = style prompt (required) · port 1 = lyrics (optional; unwired / empty = pure instrumental `[instrumental]`) · port 2 = ABC score (optional) · port 3 = control input
- **Out**: port 0 = audio (preview / save downstream) · port 1 = control output

## Settings
- Change them in the **⚙ Settings** window opened from the node header.
- **Output path**: where the `.wav` goes (relative to the working directory / node-layer subfolder). Empty is fine once a Save node is wired — that node writes the file. Without one it is required, and ▶ warns “Generation cannot start until an output path is set”.
- **Chain-of-thought tier**: `full` (full CoT, best quality, default) · `melody` (melody guidance, faster) · `off` (no CoT, prompt only)
- **Roll count**: sequential generations (1–10); multiple runs save as `#1`, `#2` … · **Seed** + **Reroll (seed +1 on every run, on by default)**
- **auto CPU offload (recommended on 24G)**: on by default

## Usage
- Wire the style prompt to port 0 (lyrics to port 1; leave it empty for instrumental) → set the output path → press ▶.

## Notes
- Only **1 audio/video task** runs globally at a time (music / speech / video are mutually exclusive); one backend instance serves every node, and this node shares one serial chain with Minimax Music 3.
- A **24G-class NVIDIA GPU** is recommended. Until it is installed the node shows “plugin not installed” — install it from the **Plugins › YuE2 Local Music** card; the backend log is in the read-only console behind the ⓘ on the cover.
- Lyrics and style prompts can follow the **built-in skills** `minimax-music-lyrics` / `minimax-music-prompt` (they ship with the app — no Creative Workshop download); a style prompt is always **one English paragraph of six sentences**.
- **Plugin error dialog**: the `yue2-local-install` skill repairs it inside this plugin's INSTALL_DIR and restarts the backend; cancelled-by-you / installing / out of disk / no NVIDIA GPU get the report only.
