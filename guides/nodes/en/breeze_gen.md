# Breeze speech (Breeze TTS 2)

![diagram](img/breeze_gen.svg)

Right-click the canvas → **Process Node › Audio generation › Breeze speech**. Turns text into speech: the “Breeze TTS 2 Local TTS” plugin starts a local management service (default `127.0.0.1:8772`) plus the official `breeze_infer.api` engine (`127.0.0.1:8773`, on demand). **Each run produces exactly one audio file** (`.wav` / `.flac` / `.mp3`).

## Ports
- **In**: port 0 = text to speak · port 1 = reference audio (audio file URL) · port 2 = reference transcript (text, or an audio / video input node) · port 3 = instruction · port 4 = control input
- **Out**: port 0 = speech audio (preview / save downstream) · port 1 = control output

## The two text boxes (editable on the card)
- **First box = the text to speak** (port 0): **read-only** while port 0 has input, editable only when that port is empty (stored as `srcText`).
- **Second box = the reference transcript** (port 2): same rule; wired to an audio / video input node it shows that node's port-1 transcript, while an audio file stays empty here (that line is taken as the reference audio) — a `file:///…` path is never shown as reference text.
- The boxes carry no title row and no state labels: **hover** a box to see what it is. This node **does no transcription** — type the reference text yourself or wire the audio node's transcript output into port 2.

## Characters (voice presets)
- A character = one base voice + N alternative voices; each group = a reference clip + its verbatim line + one instruction (plus an optional scene tag). Create one with the 👤 button in the header: **voice design** (AI-written voice) or **reference audio** → generate 3–6 candidates → confirm one as the base voice.
- The 👤 button opens the character dialog: pick a character on the left; each group on the right has a **waveform player** plus its line and instruction — click **Use this group** to apply it (the dialog closes and the choice is stored on the node).
- Once a character is selected ports 1 / 2 are hidden and **take no part in synthesis**; only the text box remains on the card.
- **Instruction**: a non-empty instruction on port 3 or in settings **overrides** the group's own one; leave it empty to use that group's line.

## Settings
- Change them in the **⚙ Settings** window opened from the node header.
- **Voice (voice library)**: `voices/<id>/{ref.wav, ref.txt}` under the install folder; empty = use the reference audio from the ports · **Capabilities**: auto / voice clone / voice design / voice direction (both rows vanish when a character is selected)
- **Instruction** / **cfg_scale** (0.1–10, default 4; fixed at 1.0 in clone mode) / **Seed** (default 42) + **Reroll (seed +1 on every run)**
- **Output format**: wav / flac / mp3 (mp3 needs ffmpeg) · **Roll count** (1–10) · **Output path**: may stay empty once a Save node is wired

## Notes
- License: the inference code is Apache-2.0, but the weights and self-hosted output fall under the **BreezeBlue** Research and Non-Commercial License — research and **non-commercial** use only; unauthorized cloning and impersonation are forbidden.
- A reference audio must always come with its reference text (the official API requires the pair — fill the box or wire the audio node's transcript output), otherwise the node stops locally with a pointer.
- mp3 needs **ffmpeg** (`tools/ffmpeg/` in the install folder); wav / flac are the safer choice.
- Runs on the same serial chain as music / video and holds the **app-wide audio/video mutex** (about 7.7 GB VRAM eagerly); an NVIDIA GPU with 12 GB is required.
- **Plugin error dialog**: the `breeze-tts-local-install` skill repairs it inside this plugin's INSTALL_DIR and restarts the backend; cancelled-by-you / installing / out of disk / no NVIDIA GPU get the report only.
