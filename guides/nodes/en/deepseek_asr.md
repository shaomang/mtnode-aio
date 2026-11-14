# DeepSeek speech recognition (cloud · official API)

![diagram](img/deepseek_asr.svg)

Right-click the canvas → **Process Node › Audio generation › DeepSeek speech recognition** (kind `deepseek_asr`). Audio (or the soundtrack of a video) goes to the **official DeepSeek** `POST /v1/tools/asr` and comes back as text.

The provider is **not selectable**: the node always uses the **official DeepSeek** entry in Settings › Model services. Without a key it stops locally and tells you where to fix it; it never silently switches providers.

## Ports
- **In**: port 0 = audio / video (audio input node, speech-synthesis node, save node…) · port 1 = control input
- **Out**: port 0 = transcript text · port 1 = control output

## Running it
- The **▶** in the node header runs this node (a control node can drive it too). With nothing wired to port 0 it says “no audio input” first instead of complaining about the key — wiring is what you can fix in this very step. Afterwards the card reads “Transcribed: N sentences / M s”.

## The card
- The top line shows the incoming audio file name; below it is a preview of the transcript (truncated for long text — the full text is on port 0 and under 「复制」).

## Settings (the ⚙ Settings window from the node header)
- **Sentence pause**: `follow global` (default; the same value as Settings › Speech input) / 200 / 300 / 500 / 900 / 1200 ms — a longer silence cuts a sentence, and **each sentence is one request**; the result is line-per-sentence text
- **Also write the transcript to .txt**: empty = text output only; a path writes the full text there as well
- **Timeout**: 120 s by default (5–600)

## Parameter port (port 9001)
Overridable keys: `pauseMs` (0 = follow global) · `outTxtPath` · `timeoutSec`.

Write a JSON object on a text node and wire it to the parameter port; a JSON with an unknown key is rejected as a whole and the node does not run.

## Notes
- **Documented limits**: one upload is **≤ 8 MiB / ≤ 120 s**, and only 16-bit PCM WAV or Ogg Opus is accepted. Longer audio is split at sentence pauses and uploaded **sentence by sentence**, then joined back with one line per sentence (splits are continued, never dropped).
- **Billing** follows the documented per-audio-duration rule; the number of segments is shown in the node status (“transcribed: N sentences / M seconds”).
- **No local backend, no VRAM, no local model to install** — offline simply fails.
- **Failure text is explicit**: no key / invalid key / no audio / too long or too large / upload timeout / busy / rate limited / content risk / txt write failure.
- Want it **offline and free**? Use the built-in dictation (the microphone at the bottom left, local SenseVoice by default) or a local ASR backend instead of this node.
