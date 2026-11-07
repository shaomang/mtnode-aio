# Video interpolation (RIFE · standalone post-process)

![diagram](img/video_interp.svg)

Right-click the canvas → **Process Node › Video generation › Video interpolation**. Interpolates an **existing video** on its own: RIFE inserts frames by a multiplier and the frame rate is recomputed (2x / 4x); **each run produces exactly one video file** (`.mp4`) at the node's output path. It no longer runs with Minimax H3 generation — it is a **standalone post-process**.

## Ports
- **In**: port 0 = control input (fixed) · port 1 = source video · port 2+ = optional material (grows as needed)
- **Out**: port 0 = video (preview downstream) · port 1 = control output

## Settings
- Change them in the **⚙ Settings** window opened from the node header.
- **Interpolation multiplier**: `2x` (default, recommended) / `4x` / `1x` (re-encode only); a 24 fps source becomes 48 fps at 2x
- **Cache clear interval (frames)**: flush every N frames (default 2) · **Frame batch batch_size**: default 1 · **Scale factor scale_factor**: default 1.0 = source resolution
- **Low-VRAM safe profile**: on by default (low-precision fp16 + per-frame + a tiny cache interval)
- **Roll count**: 1–10; multiple runs save as `#1`, `#2` … · **Output path**: may stay empty once a Save node is wired

## Notes
- The default is a per-frame streaming chain (`h3-pack/post/stream_interp.py`): it holds only **two adjacent frames plus the model**, writes each frame as soon as it is done, and stays independent of clip length, resolution and multiplier — so **a 16 GB machine can do 2x / 4x interpolation on a 15-second video**.
- The audio track is carried over as is (only the picture frame rate changes); on the first OOM the backend drops one tier and retries once (precision to fp32).
- Only when the script / venv / RIFE weights are missing or the stream path fails for a non-OOM reason does it report **已回退图路径** (fell back to the graph path, with the reason); that path holds whole frame arrays in RAM.
- Only **1 audio/video task** runs globally at a time (music / speech / video / upscale / interpolation are mutually exclusive); upscale and interpolation are independent nodes, chainable as **H3 → Video upscale → Video interpolation**.
