# Video upscale (Real-ESRGAN x4 / x2 · standalone post-process)

![diagram](img/video_upscale.svg)

Right-click the canvas → **Process Node › Video generation › Video upscale**. Upscales an **existing video** on its own: Real-ESRGAN enlarges each frame, then the result is scaled to the output long side; **each run produces exactly one video file** (`.mp4`) at the node's output path. It no longer runs with Minimax H3 generation — it is a **standalone post-process**.

## Ports
- **In**: port 0 = control input (fixed) · port 1 = source video · port 2+ = optional material (grows as needed)
- **Out**: port 0 = video (preview downstream) · port 1 = control output

## Settings
- Change them in the **⚙ Settings** window opened from the node header.
- **Upscale ratio**: x4 (default) / x2 (faster); the ratio caps the output: output = min(target long side, source long side × ratio)
- **Upscale model**: `RealESRGAN_x4plus.pth` (default) / `RealESRGAN_x2plus.pth`; with the x2 ratio a native x2 weight is preferred when installed
- **Target long side (px)**: 1280–7680 (default 3840 = 4K), a cap on the output long side
- **Tile (px)**: 0–1024 (default 512), 0 = backend default 512; VRAM depends only on it, and 512 suits a 16 GB machine
- **Frame batch per_batch**: default 1 · **Low-VRAM safe profile (force one frame at a time)**: on by default (tiled fp16)
- **Roll count**: 1–10; multiple runs save as `#1`, `#2` … · **Output path**: may stay empty once a Save node is wired

## Notes
- The default is a per-frame tiled streaming chain (`h3-pack/post/stream_upscale.py`): each frame is encoded to disk as soon as it is done, so resident memory is **independent of clip length, resolution and ratio** — **a 16 GB machine can finish an x2 / x4 upscale of a 15-second clip**.
- The audio track is copied verbatim; on the first OOM the backend drops one tier and retries once (halved tile + fp32).
- Only when the script / venv is missing or the stream path fails for a non-OOM reason does it report **已回退图路径** (fell back to the graph path, with the reason); that path piles whole clips of frames in RAM and is hungrier.
- Only **1 audio/video task** runs globally at a time (music / speech / video / upscale / interpolation are mutually exclusive); upscale and interpolation are independent nodes, chainable as **H3 → Video upscale → Video interpolation**.
