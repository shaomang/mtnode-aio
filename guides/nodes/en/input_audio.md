# Audio input

![diagram](img/input_audio.svg)

Hold a local audio file as material: click **Choose audio**, drop a file onto the node, or **Record** a clip with the microphone.

## Ports
- **In**: 1 data port + one control port at the end; when wired, the content becomes the upstream audio (read-only — unwire to get your own file back)
- **Out**: fixed 2 data ports
  - **Audio output** — the file's `file:///…` URL (CJK and spaces percent-encoded)
  - **Transcript output** — the text produced by **Transcribe** on this node; empty text before anything is transcribed

## Settings
- No ⚙ settings window: the file, recording and transcription live in the node's action row.

## Usage
- Click **Choose audio** (mp3 / wav / ogg / flac / m4a / aac …), or drop the file onto the node.
- Click **Transcribe** to get text with the local SenseVoice model; edit the result or transcribe again.
- Wire **Audio output** into a Minimax H3 reference-audio slot, or into a **Save** node; an `@` reference also injects this URL (the transcript once one exists).

## Notes
- Only the original absolute path is stored — nothing is copied into workflow assets. Move the file and you must pick it again.
- Recording uses the system default microphone and writes `<working directory>/recordings/record_{yyyymmddhhmmss}.mp3` (128 kbps · 44.1 kHz · mono); a same-second take gets `_2`, `_3`. With no working directory it asks you to set one first.
- Recording replaces the current file and clears its old transcript; click **Transcribe** again for text.
- The preview is a waveform: click anywhere on it to listen from that point. Dropping the wrong media type only shows a hint and leaves the node unchanged.
