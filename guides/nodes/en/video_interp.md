# Video interpolation (RIFE · standalone post-process)

![diagram](img/video_interp.svg)

Right-click the canvas → **Process › Video generation › Video interpolation**. Interpolates an **existing video** on its own: RIFE inserts frames by a multiplier and the frame rate is recomputed from it (2x / 4x). It **no longer runs together with Minimax H3 generation** — H3 only outputs the native clip, and interpolation runs separately when you ask for it. **Each run produces exactly one video file** (`.mp4`) written to the node's own `outputPath` — no separate save node needed.

## Ports
- **Input**: port 0 = control input (fixed) · port 1 = source video · port 2+ = optional material (grows as needed)
- **Output**: port 0 = video (preview downstream) · port 1 = control output

The source video can come from a **Minimax H3** output, a **video input** node, or any upstream node that produces video; this node only accepts video and refuses images.

## Options
Click **⚙ Settings** in the node header to open the settings window; changes apply immediately and the card itself keeps showing just a one-line summary.

- **Multiplier**: `2x` (recommended) / `4x` / `1x` (re-encode only); the frame rate is recomputed (24 fps source → 48 fps at 2x). With per-frame streaming the multiplier is no longer limited by RAM — it only affects the frame count and the time it takes
- **Clear-cache interval (frames)**: flush the cache every N frames (default 2); the stream path writes each frame as soon as it is done, so this only affects the ComfyUI graph fallback
- **Per-frame batch (batch_size)**: frames handed to RIFE at a time (default 1); the stream path is per-frame, so this only affects the ComfyUI graph fallback
- **Scale factor**: RIFE's internal scale (default 1.0 = source resolution); it applies to the stream path too and never changes the output resolution
- **Low-VRAM safe tier**: on by default; on = low-precision fp16 plus per-frame handling and a tiny cache interval for the lowest peak
- **Attempts**: repeated runs (1–10); multiple outputs are named `#1`, `#2` …
- **Output path**: `.mp4` destination (relative to workspace / super subfolder)

## Memory / VRAM guidance
- **The per-frame streaming path is the default** (`h3-pack/post/stream_interp.py`): the source is decoded sequentially with PyAV and only **two adjacent frames plus one intermediate frame** are held at a time,
  and **every frame is encoded to disk as soon as it is done**. Resident memory depends only on "two adjacent frames + the model" — **not on clip length, resolution or multiplier**,
  so **a 16 GB machine can do 2x / 4x interpolation on a 15-second video**. (The old path decoded the whole clip and collected every interpolated frame in a single array — about 11 GB for 15 s of 1080p30, ~45 GB after 4x — so even 64 GB was not enough; that path is no longer used by default.)
- **VRAM depends only on precision and the scale factor**: fp16 by default; the backend drops to fp32 when VRAM is small or the safe tier is off. A larger multiplier is slower but does not decide whether it runs.
- **The audio track is copied as is**: the output container copies audio packets straight from the source, no re-encode.
- On the first OOM the backend **automatically drops one tier and retries once** (precision to fp32, plus one step down in pre-scaled long side if needed; the multiplier is untouched) and reports the result on the node's status line.
- **Only the fallback path returns to the old behaviour**: when the script / venv / RIFE weights are missing or the stream path fails for a non-OOM reason, the backend falls back to the ComfyUI graph (the console states
  "已回退图路径" plus the reason, with the same logging as before). That path holds whole frame arrays in RAM, so a larger long side costs more memory and may force the long side down / pre-scaling of source frames.
- **Running many clips does not get tighter over time**: each streaming run is its own subprocess and everything is reclaimed when it exits, so there is no accumulated resident memory; only the graph fallback still uses the resident
  ComfyUI backend (its memory guard measures system RAM after each run and restarts in the background only when over budget — see the H3 console's "24G startup optimisation").

## Notes
- **The audio track is carried over as is**: the source audio goes into the result; interpolation only changes the picture frame rate.
- Only **1 audio/video task** is allowed globally at a time (music / speech / video / upscale / interpolation are mutually exclusive); other tasks queue.
- Upscale and interpolation are two **independent** nodes — use either alone, or chain them: **H3 → Video upscale → Video interpolation**.
- If the backend is down the node starts the H3 backend and waits for it to come online; failures are written on the node's status line as an actionable hint.
