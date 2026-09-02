# Video generation (MiniMax H3)

Local MiniMax H3 backend (ComfyUI). **Each run produces exactly one video file** (`.mp4`) written to the node’s own `outputPath` — no separate save node needed.

## Ports
- **Input**: port 0 = control input (fixed) · port 1+ = data slots (reference images / text)
- **Output**: video (preview downstream) + control

## Options
- **Output path**: `.mp4` destination (relative to workspace / super subfolder)
- **Mode**: `fl2va` = first/last frame (default); `r2v` = multiple reference images
- **Duration**: 4–15 s (default 5)
- **Resolution**: auto (proportional) / 480p / 720p / 1080p (auto-downscaled when VRAM is low)
- **Post**: 4K upscale + interpolation (on by default; disable on 24G for speed)
- **Attempts**: gacha rolls (1–10)

## Notes
- Only **1 audio/video task** is allowed globally at a time (music and video are mutually exclusive).
- 24G VRAM caps resolution and post-processing tiers.
