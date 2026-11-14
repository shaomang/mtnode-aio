# DeepSeek speech synthesis (cloud · official API)

![diagram](img/deepseek_tts.svg)

Right-click the canvas → **Process Node › Audio generation › DeepSeek speech synthesis** (kind `deepseek_tts`). The text goes to the **official DeepSeek** `POST /v1/tools/tts` (the streaming mode uses `WSS /v1/tools/tts`) and comes back as **one `.wav` file per run**.

The provider is **not selectable**: the node always uses the **official DeepSeek** entry in Settings › Model services (`id = deepseek`, `https://api.deepseek.com`). Without a key — or with a third-party relay filled in — the node stops locally and tells you where to fix it; it never silently switches providers.

## Ports
- **In**: port 0 = text to synthesise · port 1 = control input
- **Out**: port 0 = speech audio (`.wav`; play, save, or feed a speech-recognition node) · port 1 = control output

## Running it
- The **▶** in the node header runs this node (no working folder required — the wav defaults to the system temp folder); a control node can drive it too. While it runs the ▶ turns into **…** and the card then reads “Synthesized: voice · mode · seconds”.

## Editing on the card
- The textarea on the card is the text to synthesise. When port 0 has a value it turns **read-only** and mirrors that value; it is editable only while empty.
- After a run an audio player appears on the card so you can listen to the result.

## Settings (the ⚙ Settings window from the node header)
- **Voice `voice_id`**: `stella` (default, female) / `tide` (male)
- **Format `format`**: `wav` (default, the whole clip in one response) / `pcm` (raw 24 kHz 16-bit mono; the node still wraps it into a `.wav` on disk)
- **Filter Markdown `filter_markdown`**: **on** by default (the documented default is `true`) — strips `#`, `*` and friends so they are not read out loud
- **Mode**: **whole** (default, one request returns the complete wav) / **stream** (PCM as it is produced: earlier first audio, steadier on long text)
- **Output path**: empty = the system temp folder `…\Temp\mtnode-ds-tts\`; leave it empty when a save node downstream takes the artifact
- **Timeout**: 120 s by default (5–600)

## Parameter port (port 9001)
Every setting can be overridden through the **parameter** port. Keys:

`voiceId` · `ttsFormat` (`wav` / `pcm`) · `filterMarkdown` (boolean) · `streamMode` (boolean, true = stream) · `outputPath` · `timeoutSec`

Write a JSON object on a text node (only the keys you want to change) and wire it to the parameter port. A JSON with an unknown key is rejected as a whole and the node does not run.

## Notes
- **Billing** follows the documented per-character rule; a single request is capped at **10000 billed characters** (anything beyond 4× is refused), and longer text is **split automatically** into consecutive requests whose audio is joined into one wav.
- **No local backend, no VRAM, no media serial queue** — it is pure cloud; offline simply fails (there is no silent fallback to the local engine).
- **Failure text is explicit**: no key / invalid key / empty text / content risk (`Content Exists Risk`) / rate limited / busy / timeout / write failure.
- Artifacts land in your user or project folders — never inside the application install directory.
