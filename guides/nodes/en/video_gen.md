# Minimax H3 (video generation)

![diagram](img/video_gen.svg)

Right-click the canvas → **Process › Video generation › Minimax H3**. Local MiniMax H3 backend (ComfyUI). **Each run produces exactly one video file** (`.mp4`) written to the node's own `outputPath` — no separate save node needed.

## Ports
- **Input**: port 0 = control input (fixed) · port 1 = prompt · **R2V** mode: ports 2–10 = reference images I1–I9, ports 11–13 = reference videos V1–V3, ports 14–16 = reference audios A1–A3 (all three groups exposed at once; port numbers match the backend's `ref_image_0..8` / `ref_video_0..2` / `ref_audio_0..2`) · **FL2VA** mode: ports 2–3 = first frame F / last frame L
- **Output**: port 0 = video (preview downstream) · port 1 = control output

## Options
Click **⚙ Settings** in the node header to open the settings window; changes apply immediately and the card itself keeps showing just a one-line summary.

- **Output path**: `.mp4` destination (relative to workspace / super subfolder)
- **Mode**: `fl2va` = first/last frame (default); `r2v` = multiple references (images / videos / audio)
- **Duration**: 4–15 s (default 5)
- **Resolution**: auto (proportional) / 480p / 720p / 1080p (auto-downscaled when VRAM is low)
- **Post**: 4K upscale + interpolation (on by default; disable on 24G for speed)
- **Attempts**: gacha rolls (1–10)

## Custom ComfyUI workflow (optional)

By default the node runs the built-in H3 chain (first/last frame or multi-reference). To run **a graph you built yourself**: click **⚙ Settings** in the node header → set **Workflow source** to **Custom ComfyUI workflow**.

- **Library**: workflows live in a machine-wide library (`<data dir>/h3-workflows/`), imported in the **H3 manager window · custom workflow library** (drop a JSON file / paste JSON). Both the ComfyUI **API format** and the **UI format** are detected (UI graphs are converted, front-end-only nodes such as Reroute / Note / primitives are dropped). The **Manage** button opens that window.
- **Open**: every library entry carries an **Open** action — it edits *that one workflow* inside an **embedded ComfyUI editor** (if the backend is down it asks before starting it). This only hands the graph out for editing and **never overwrites the library entry** — getting your edits back into the library (and onto the canvas) still has exactly one route: ComfyUI's **Export (API)** → **Import JSON** in the manager window.
- **Ports**: every field you promote to a node parameter takes one input port — **port 1 = text · port 2+ = media (image / video / audio)** — in parameter-table order (▲▼ reorders), all listed in the settings window. The initial table comes from the graph scan (prompt / LoadImage / seed…) and is fully editable.
- **Manual values**: each parameter also accepts a literal value in the settings window; **a wired port wins over the manual value**, and if neither is given the value stored in the workflow JSON is kept. Media values are absolute local paths, uploaded to ComfyUI at run time.
- **Output node**: when the graph has several `Save*` nodes, pick which artifact this node returns (blank = last video output).
- **Refresh & validation**: ↻ re-syncs the parameter table with the stored graph (targets that vanished are flagged, never silently deleted); **Validate nodes** diffs node classes against the backend `/object_info` (skipped while the backend is down — it never blocks generation).
- The node's **Seed / Reroll** control drives seeding: one run writes that seed into **every** `seed` / `noise_seed`-style field in the graph.
- In custom mode the built-in **duration / resolution / sampler / 4K post** options no longer apply — the graph decides them and the settings window stops showing them; no 24G clamping happens either. Rolls, progress, cancel, output path and the global media lock stay as they are.

## Notes
- Only **1 audio/video task** is allowed globally at a time (music and video are mutually exclusive).
- 24G VRAM caps resolution and post-processing tiers.
- Reference images / audio / video can come straight from an **image / audio / video input** node: media ports carry a `file:///…` URL and this node normalizes it back to a local path.
- **Sage Attention** (optional speed tier, about 1.5–2×) needs `triton-windows` *and* a prebuilt `sageattention` wheel matching this venv — one without the other counts as missing. **Nothing breaks when they are absent**: the plugin probes the venv before every run and simply leaves the Sage node out (just slower). Probe and install are one click in the **H3 plugin window → the `Sage 加速` button** (it picks the wheel for your Python / torch / CUDA and re-verifies right after).
