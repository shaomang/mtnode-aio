# InfiniteTalk avatar (Wan2.1 I2V 14B)

![diagram](img/infinitetalk_gen.svg)

Right-click the canvas → **Process Node › Video generation › InfiniteTalk avatar**. Local talking-avatar backend (its own ComfyUI, default port 8199): one portrait image (or one source video) + one voice track → a lip-synced mp4, with long audio chunked and continued automatically. **Each run produces exactly one video file** at the node's output path.

## Ports
- **In**: port 0 = portrait image (used by I2V) · port 1 = voice (required) · port 2 = source video (optional; wired = V2V) · port 3 = prompt (optional) · port 4 = control input (always last)
- **Out**: port 0 = avatar video (mp4 with the original audio track muxed in) · port 1 = control output

## Settings
- Change them in the **⚙ Settings** window opened from the node header.
- **Bucket**: `480p` = 832×480 (default) / `720p` = 1280×768 (slower, more VRAM)
- **Sampling steps**: 1–40, default 4 (lightx2v distilled tier); 8+ is only slower
- **Seed** (default 42) + **Reroll (seed +1 on every run)**: chunks of one run increment the seed per chunk
- **Prompt**: used only when port 3 is empty; empty = built-in default (the person speaks naturally) · **Negative prompt**: empty = host default
- **Output path**: where the `.mp4` goes (relative to the working directory); may stay empty when a Save node is wired

## Usage
- Wire the portrait to port 0 and the voice to port 1 (add port 2 to follow a source video, i.e. V2V) → set the output path → press ▶.

## Notes
- Video length follows the whole voice track with no cap; the host slices it every **81 frames (25 fps ≈ 3.24 s)** and continues each chunk from the previous chunk's last frame plus its **last 9 frames**, so chunk boundaries may show a slight seam.
- Every finished chunk is written at once to `<data dir>/infinitetalk-local/jobs/<job id>/`; after a cancel or a crash, pressing ▶ again resumes from the breakpoint and finally concatenates one mp4 with the original audio track.
- Any sample rate / channel count is converted to **16 kHz mono wav** first; allow **≥55 GB** free disk for the install.
- Only **1 audio/video task** runs globally at a time (mutually exclusive with the music / video nodes); pressing ▶ with the backend down starts it and **leaves it running** afterwards.
- Run the console's **Test generate** first after installing; backend failures raise an error report with an **Auto-repair** entry (user cancel / installing / no NVIDIA GPU are reported only).
