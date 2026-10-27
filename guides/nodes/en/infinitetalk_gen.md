# InfiniteTalk avatar (Wan2.1 I2V 14B)

![diagram](img/infinitetalk_gen.svg)

Right-click the canvas → **Process › Video generation › InfiniteTalk avatar**. Local talking-avatar backend (its **own** ComfyUI install, default port **8199**).
Give it **one portrait image (or one source video) + one voice track** and it renders a **lip-synced mp4**; **long audio is chunked and continued automatically** until the whole track is covered.
**Each run produces exactly one video file**, written to the node's `outputPath`. The path may be left empty: wire the **data output** into a downstream **Save** node and that node owns the path (the file lands in the app-managed asset area first).

## Ports
- **Input**: port 0 = **portrait image** (image, used by I2V) · port 1 = **voice** (audio, required) · port 2 = **source video** (video, optional; wired = V2V) · port 3 = **prompt** (text, optional) · port 4 = **control input** (always last)
- **Output**: port 0 = **avatar video (mp4, original audio track muxed in)** · port 1 = control output

Two modes:
- **I2V** (port 2 empty): uses the portrait from port 0, **center-cropped** to the selected bucket.
- **V2V** (a source video on port 2): composition, motion and camera follow the source video, scaled to the bucket; the portrait may be wired as well for reference.

Wire an **Image input** node into port 0, or an **Audio input** node / **Breeze speech** output into port 1 — any sample rate or channel count is converted to **16 kHz mono wav** for you.

## Options
Click **⚙ Settings** in the node header; the card keeps showing a one-line summary (bucket · steps).

- **Bucket**: `480p` = 832×480 (default) / `720p` = 1280×768 (slower, more VRAM).
- **Sampling steps**: default **4** (lightx2v distilled tier, cfg 1.0 / euler / simple). 8+ is noticeably slower with little gain.
- **Seed / reroll (+1 per run)**: chunks of one run increment the seed per chunk.
- **Prompt**: only used when port 3 has no text; empty = built-in default (the person speaks naturally).
- **Negative prompt**: empty = host default (blurry / distorted / extra hands…).
- **Output path**: where the `.mp4` goes (relative to the working folder / node-layer subfolder). Can stay empty when a Save node is wired.

## Long audio
- Video length **follows the whole voice track** — there is no “max N seconds” cap.
- The host slices the voice every **81 frames (25 fps ≈ 3.24 s)**: chunk 1 uses your image / source video, and each following chunk uses the **previous chunk's last frame** as its reference image plus the **last 9 frames** as `previous_frames`, so subject, framing, camera and lip sync stay continuous.
- Every finished chunk is written immediately to `<data dir>/infinitetalk-local/jobs/<job id>/`; after a cancel or a backend crash, pressing ▶ again **resumes from the breakpoint** (finished chunks are not re-rendered) and finally concatenates the chunks into one mp4 with the **original audio track** muxed back in.
- Known trade-off: this is **host-side, window-level continuation**, not one long sequence inside the model, so chunk boundaries may show a slight seam.

## Optimizations (all on by default)
- **fp8 diffusion model** + **lightx2v 4-step distillation**: faster start and lower VRAM at 480p.
- **SageAttention**: the backend starts with `--use-sage-attention`; if SageAttention cannot be installed, the **install fails** (it never silently falls back to SDPA).
- **VRAM headroom**: `--reserve-vram 1.0`; 720p or the console's “low VRAM” mode adds `--lowvram`.

## Notes
- Only **1 audio/video task** is allowed globally at a time (mutually exclusive with the music / video nodes); the status line names whoever holds the lock.
- Allow **≥55 GB free disk** for the install. This plugin sets **no VRAM threshold**: try it if it fits, and read the console log when it does not.
- Install the backend first: the plugin card's **Install**, or the console's **Install / Reinstall**; the console's **Test generate** is the quickest end-to-end check.
- Pressing ▶ with the backend down starts it automatically and **leaves it running** afterwards (the next run reuses it; stop it from the console).
- Uninstalling the plugin **keeps** the chunk artifacts inside the install folder and the mp4 files you already produced (clean them up yourself).
- Backend failures pop an **error report** (error code, log tail, the failing node) with an **Auto-repair** entry point; user cancel / installing / no NVIDIA GPU are reported only and never auto-repaired.
