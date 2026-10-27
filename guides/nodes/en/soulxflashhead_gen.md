# SoulX real-time avatar (SoulX-FlashHead Lite 1.3B)

![diagram](img/soulxflashhead_gen.svg)

Right-click the canvas → **Process › Video generation › SoulX real-time avatar**. Local **real-time** avatar backend (its own Python service, default port **8198**).
Give it **one portrait image + one voice track** and it renders a **512×512 @25fps lip-synced mp4**; the whole track goes through in **one streaming pass** — no chunking, no seams.
**Each run produces exactly one video file**, written to the node's `outputPath`. The path may be left empty: wire the **data output** into a downstream **Save** node and that node owns the path (the file lands in the app-managed asset area first).

## Ports
- **Input**: port 0 = **portrait image** (image, required) · port 1 = **voice** (audio, required) · port 2 = **control input** (always last)
- **Output**: port 0 = **avatar video (mp4, original audio track muxed in)** · port 1 = control output

Wire an **Image input** node into port 0, or an **Audio input** node / **Breeze speech** output into port 1 — any sample rate or channel count is converted to **16 kHz mono wav** for you.

## Output (fixed, not adjustable)
- **512×512**, **25fps**: the real-time training setting of the official Model_Lite; the aspect ratio is fixed and the portrait is center-cropped.
- Video length **follows the whole voice track** — there is no “max N seconds” cap; the model keeps writing in 33-frame windows by itself.
- The mp4 muxes the **original audio track** (aac) — no second pass needed.

## Options
Click **⚙ Settings** in the node header; the card keeps showing a one-line summary (512×512 · steps).

- **Sampling steps**: default **4** (the official lite distilled tier). 8+ drops out of real-time; not recommended.
- **Seed / reroll (+1 per run)**: keeps the same face and mouth rhythm while streaming.
- **Output path**: where the `.mp4` goes (relative to the working folder / node-layer subfolder). Can stay empty when a Save node is wired.

## Proving real time
- The install tail runs one **real 2-block benchmark** (loads weights and streams for real) and writes **ms/block · FPS · RTF** into the console and the install log.
- The console's **test generate** and **real-time benchmark** buttons re-measure any time; the running node's status line also shows FPS / RTF.
- Acceptance: **one RTX 4090, one stream, ≥25FPS sustained**. Higher official peaks are recorded only, not promised.

## Optimizations (all on by default)
- **torch.compile**: the backend compiles the main model by default (`MT_FLASHHEAD_COMPILE=1`); if compilation fails it retries without it and says so in the log.
- **flash-attention**: **mandatory** — the install fails when it cannot be installed (no silent fallback to SDPA). It prefers a Windows prebuilt wheel matching the torch build and only compiles from source as a last resort.
- **SageAttention**: installed when possible (`--sage` uses it); failure is a warning only and never blocks generation.
- **fp16 + sliced VAE**: VRAM is released per block, so a 16G card works.

## Notes
- Only **one media job** runs at a time (mutually exclusive with music / video / InfiniteTalk nodes); when the lock is taken the status line says who holds it.
- Reserve **≥30GB** of disk. Without an NVIDIA GPU the install is refused outright (CPU cannot reach real time; no degraded mode).
- Install it first: the plugin card's **Install** or the console's **Install / Reinstall**; then use the console's **test generate** to prove the pipeline.
- Pressing ▶ with the backend down starts it automatically and it **stays up** afterwards (the next run reuses it; stop it from the console).
- Uninstalling the plugin **keeps** the mp4 files you already produced (clean them up yourself).
- It is a **separate** plugin from **InfiniteTalk avatar**: own service, own install folder, own VRAM — install just one if you like.
- Backend failures raise an error report (code, log tail, offending node) with an **auto-repair** entry; cancellations, in-progress installs and “no NVIDIA GPU” are reported without offering repair.
