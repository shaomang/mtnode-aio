# Minimax H3 (video generation)

![diagram](img/video_gen.svg)

Right-click the canvas → **Process › Video generation › Minimax H3**. Local MiniMax H3 backend (ComfyUI). **Each run produces exactly one video file** (`.mp4`) written to the node's own `outputPath` — no separate save node needed.

## Ports
- **Input**: port 0 = control input (fixed) · port 1+ = data slots (reference images / text / reference audio / reference video)
- **Output**: port 0 = video (preview downstream) · port 1 = control output

## Options
- **Output path**: `.mp4` destination (relative to workspace / super subfolder)
- **Mode**: `fl2va` = first/last frame (default); `r2v` = multiple reference images
- **Duration**: 4–15 s (default 5)
- **Resolution**: auto (proportional) / 480p / 720p / 1080p (auto-downscaled when VRAM is low)
- **Post**: 4K upscale + interpolation (on by default; disable on 24G for speed)
- **Attempts**: gacha rolls (1–10)

## Custom ComfyUI workflow (optional)

By default the node runs the built-in H3 chain. To run **a graph you built yourself**: open the node settings panel → set **Workflow source** to **Custom ComfyUI workflow**.

- **Library**: workflows live in a machine-wide library (`<data dir>/h3-workflows/`), imported in the **H3 manager window · custom workflow library** (drop a JSON file / paste JSON). Both the ComfyUI **API format** and the **UI format** are detected (UI graphs are converted, front-end-only nodes such as Reroute / Note / primitives are dropped). The **Manage** button opens that window.
- **Ports**: every field you promote to a node parameter takes one input port — **port 1 = text · port 2+ = media (image / video / audio)** — in parameter-table order (▲▼ reorders). The initial table comes from the graph scan (prompt / LoadImage / seed…) and is fully editable.
- **Manual values**: each parameter also accepts a literal value in the panel; **a wired port wins over the manual value**, and if neither is given the value stored in the workflow JSON is kept. Media values are absolute local paths, uploaded to ComfyUI at run time.
- **Output node**: when the graph has several `Save*` nodes, pick which artifact this node returns (blank = last video output).
- **Refresh & validation**: ↻ re-syncs the parameter table with the stored graph (targets that vanished are flagged, never silently deleted); **Validate nodes** diffs node classes against the backend `/object_info` (skipped while the backend is down — it never blocks generation).
- The node's **Seed / Reroll** control drives seeding: one run writes that seed into **every** `seed` / `noise_seed`-style field in the graph.
- In custom mode the built-in **duration / resolution / sampler / 4K post** options no longer apply (the graph decides them) and no 24G clamping happens; rolls, progress, cancel, output path and the global media lock stay as they are.

## Notes
- Only **1 audio/video task** is allowed globally at a time (music and video are mutually exclusive).
- 24G VRAM caps resolution and post-processing tiers.
- Reference images / audio / video can come straight from an **image / audio / video input** node: media ports carry a `file:///…` URL and this node normalizes it back to a local path.
