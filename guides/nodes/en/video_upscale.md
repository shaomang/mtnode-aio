# Video upscale (Real-ESRGAN x4 / x2 · standalone post-process)

![diagram](img/video_upscale.svg)

Right-click the canvas → **Process › Video generation › Video upscale**. Upscales an **existing video** on its own: Real-ESRGAN enlarges each frame, then the result is scaled to the output long side. It **no longer runs together with Minimax H3 generation** — H3 only outputs the native clip, and upscaling runs separately when you ask for it. **Each run produces exactly one video file** (`.mp4`) written to the node's own `outputPath` — no separate save node needed.

## Ports
- **Input**: port 0 = control input (fixed) · port 1 = source video · port 2+ = optional material (grows as needed)
- **Output**: port 0 = video (preview downstream) · port 1 = control output

The source video can come from a **Minimax H3** output, a **video input** node, or any upstream node that produces video; this node only accepts video and refuses images.

## Options
Click **⚙ Settings** in the node header to open the settings window; changes apply immediately and the card itself keeps showing just a one-line summary.

- **Upscale ratio**: **x4** (default, best quality) or **x2** (output magnified 2× only, faster). The ratio caps the output: **output = min(target long side, source long side × ratio)** — with x2 a 720p source yields 2560 and a 1080p source yields 3840, never 4× just because the target says so.
- **Upscale model**: `RealESRGAN_x4plus.pth` (general x4) or `RealESRGAN_x2plus.pth` (native x2, optional weight) — the value sent to the upscaler must be the **file name including its extension**; a bare `RealESRGAN_x4plus` is rejected with `value_not_in_list` (the app appends the extension automatically). With the **x2 ratio** the app **automatically prefers a native x2 weight when one is installed** (one tier lighter on both VRAM and time); without one it still works — the x4 weight upscales and the tail is scaled back down to 2×.
- **Target long side (px)**: 1280–7680 (default 3840 = 4K) — a **cap** on the output long side; with per-frame tiled streaming it is **no longer limited by system RAM**, it only trades output size against time. With the x2 ratio it is additionally capped at source long side × 2, and no scaling is added when the source size is unknown (the weight's native size is kept)
- **Per-frame batch (per_batch)**: frames handed to the upscale model at a time (default 1); the **low-VRAM safe tier keeps it at 1** (the stream path is per-frame anyway; this only sets the batch size when falling back to the ComfyUI graph)
- **Tile (px)**: 0–1024 (default 512). The **tile size** of streaming upscale: VRAM depends only on it, and **512 suits a 16 GB machine**; 0 = backend default 512
- **Low-VRAM safe tier (force per-frame)**: on by default; on = **tiled fp16 keeps VRAM low — a 16 GB machine can handle a 15-second clip**, off = batch by `per_batch` / larger tiles (faster, hungrier)
- **Attempts**: repeated runs (1–10); multiple outputs are named `#1`, `#2` …
- **Output path**: `.mp4` destination (relative to workspace / super subfolder)

## RAM / VRAM guidance
- **By default this runs a per-frame tiled streaming chain** (`h3-pack/post/stream_upscale.py`): the source is decoded sequentially with PyAV, upscaled tile by tile according to `tile`, and **each frame is encoded to disk as soon as it is done**. Resident memory depends only on one tile plus one output frame — **independent of clip length, resolution and ratio** — so **a 16 GB machine can finish an x2 / x4 upscale of a 15-second clip**. (The old path piled the whole clip's frame tensors plus a float32 copy into RAM — peak ≈ frames × source pixels × ratio², which a 15-second clip can blow past even with 64 GB — and is no longer the default.)
- **VRAM depends only on the tile and the precision**: default tile 512 + fp16; on low-VRAM machines, or when the safe tier is off, the backend drops to fp32 and halves the tile when needed. Smaller tiles are lighter, larger ones faster; neither the target long side nor the clip length decides whether it fits.
- **The audio track is copied verbatim**: audio packets go straight from the source file into the output container, no re-encode.
- On the first OOM the backend **drops one tier and retries once** (tile halved + fp32, target long side / ratio untouched) and reports the result on the node's status line.
- **Only the fallback chain follows the old rules**: if the script / venv is missing, or the stream path fails for a non-OOM reason, the backend falls back to the ComfyUI graph (the console says “fell back to the graph path + why”, and the logs match the previous release). There the whole clip's frame tensors pile up in RAM — peak ≈ source pixels × ratio² × frames, so a bigger long side costs more RAM; `--cache-ram` caps retained caches and the long side / source may be pre-scaled.
- **Running many clips no longer gets tighter and tighter**: every streaming run is its own subprocess and its memory is reclaimed when it exits. Only the fallback graph chain still uses the resident ComfyUI backend (its memory rail measures system memory per run and recycles the backend in the background when over budget — see “24G startup optimizations” in the H3 console).

## Notes
- Only **1 audio/video task** is allowed globally at a time (music / speech / video / upscale / interpolation are mutually exclusive); other tasks queue.
- Upscale and interpolation are two **independent** nodes — use either alone, or chain them: **H3 → Video upscale → Video interpolation**.
- If the backend is down the node starts the H3 backend and waits for it to come online; failures are written on the node's status line as an actionable hint.
- It shares the backend and the media mutex with H3 generation; before submitting, post-processing frees the generation models so the two never stack in VRAM.
