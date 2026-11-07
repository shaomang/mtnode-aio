# Minimax H3 (video generation)

![diagram](img/video_gen.svg)

Right-click the canvas → **Process Node › Video generation › Minimax H3**. Local MiniMax H3 backend (ComfyUI) that turns a prompt plus reference material into one video; **each run produces exactly one video file** (`.mp4`) at the node's output path.

## Ports
- **In**: port 0 = control input (pinned first; data wires are rejected) · port 1 = prompt · **FL2VA** mode: ports 2–3 = first frame F / last frame L · **R2V** mode: ports 2–10 = reference images I1–I9, ports 11–13 = reference videos V1–V3, ports 14–16 = reference audios A1–A3 (all three groups at once) · with **Chain from the previous clip** on, one more **↩ previous clip** port (FL2VA = port 4, R2V = port 17)
- **Out**: port 0 = video (preview downstream) · port 1 = control output

## Settings
- Change them in the **⚙ Settings** window opened from the node header.
- **Output path**: where the `.mp4` goes (relative to the working directory / node-layer subfolder). Empty is fine once a Save node is wired — that node writes it. Without one it is required, and ▶ warns “Generation cannot start until an output path is set”.
- **Mode**: `fl2va` first/last frame (default) / `r2v` multi-reference · **Aspect ratio**: 16:9 (default) / 9:16 / 1:1 / 4:3 / 3:4 / 21:9 · **Output resolution**: auto (default, proportional) / 480p / 720p / 1080p (auto-downscaled on low VRAM; the long side is clamped to ≤1280 on 24G)
- **Duration**: 4–15 s (default 5) · **Sampling steps** (default 20) · **sampler** `res_multistep` (default) · **scheduler** `simple` (default) · **denoise** (default 1) · **fps** (default 24) · **bit depth** 8bit (default) / 16bit · **container** auto / mp4 / webm · **codec** auto / h264 / vp9
- **Roll count** (1–10) · **Seed** + **Reroll (seed +1 on every run)**
- **24G optimisation (all on by default)** — EasyCache · Sage Attention · Low VRAM Attention · Chunk FeedForward · unload models before VAE
- **Segment chaining**: turn on **Chain from the previous clip** → **Guide frames** (1–60, default 22), **Repaint strength** (0–1, default 1; 0.3–0.6 = guide + repaint); `r2v` also has **Append the continuation note** (on by default)

## How chaining works
- H3 generates at most 15 s per run; for longer cuts generate segments: run segment 1 → from segment 2 on wire the previous output into the **↩** port → repeat to the target length → stitch in order in your editor.
- `fl2va`: the previous segment's last frame doubles as the first frame (a wired first frame wins). `r2v`: the last N frames take one reference-video slot; with all three wired it **replaces V3** and the status line names the slot used.

## Custom ComfyUI workflow
- Set **Workflow source** to **Custom ComfyUI workflow**. The library lives in `<data dir>/h3-workflows/` and is imported in the H3 manager window's custom workflow library (drop / paste JSON; API and UI formats both work); **Open** only edits a copy in the embedded editor and never overwrites the stored template.
- **Ports**: data terminal 1 = text · 2+ = media (image / video / audio), port 0 stays the control input; a wired port wins over the literal value typed in settings.
- With several `Save*` nodes, **Output node** picks the artifact (blank = last video); the seed is written into every `seed` / `noise_seed` field in the graph.
- In custom mode the built-in duration / resolution / sampler options no longer apply and no 24G clamping happens.

## Notes
- Only **1 audio/video task** runs globally at a time (music / video are mutually exclusive); 24G VRAM caps the resolution tiers.
- **This node outputs the native clip only**: upscale / interpolation are separate nodes (Process Node › Video generation › Video upscale / Video interpolation), chainable as **H3 → Video upscale → Video interpolation**.
- **Sage Attention is required**: `triton-windows` and a matching `sageattention` wheel must be installed as a pair; without it the backend refuses to start and nothing renders. Turning the Sage Attention switch off exempts this node (about 1.5–2× slower, with a warning in the status line).
- If a reference “does not take effect”, read the status line first: an unreadable asset is named (e.g. `I1（参考图）`) and left out of this request.
- **Plugin error dialog**: when the install or the running backend breaks, an error report offers **🤖 Auto-repair**, which fixes it in this plugin's INSTALL_DIR following the `minimax-h3-install` skill and restarts the backend; cancelled-by-you / installing / out of disk / no NVIDIA GPU get the report only.
