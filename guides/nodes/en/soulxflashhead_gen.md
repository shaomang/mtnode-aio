# SoulX real-time avatar (SoulX-FlashHead Lite 1.3B)

![diagram](img/soulxflashhead_gen.svg)

Right-click the canvas → **Process Node › Video generation › SoulX real-time avatar**. Local **real-time** avatar backend (its own Python service, default port 8198): one portrait image + one voice track → a **512×512 @25fps** lip-synced mp4, streamed in one pass with no chunking and no seams.

## Ports
- **In**: port 0 = portrait image (required) · port 1 = voice (required) · port 2 = control input (always last)
- **Out**: port 0 = avatar video (mp4 with the original audio track muxed in) · port 1 = control output

## Settings
- Change them in the **⚙ Settings** window opened from the node header.
- **Sampling steps**: 1–40, default 4 (the official lite distilled tier); raising it drops out of real time
- **Seed** (default 42) + **Reroll (seed +1 on every run)**
- **Output path**: where the `.mp4` goes (relative to the working directory); may stay empty when a Save node is wired

## Usage
- Wire the portrait to port 0 and the voice to port 1 → set the output path → press ▶; after installing, run **Test generate** in the console once.

## Notes
- The output is fixed and not adjustable: **512×512, 25fps**, portrait center-cropped; length follows the whole voice track and the model keeps writing in 33-frame windows.
- Any sample rate / channel count is converted to **16 kHz mono wav** first; allow **≥30 GB** free disk — without an NVIDIA GPU the install is refused outright.
- Only **1 audio/video task** runs globally at a time (mutually exclusive with the music / video / InfiniteTalk nodes); pressing ▶ with the backend down starts it and **leaves it running**.
- It is a **separate** plugin from InfiniteTalk avatar: own service, install folder and VRAM — install just one if you like.
- Backend failures raise an error report with an **Auto-repair** entry (user cancel / installing / no NVIDIA GPU are reported only).
