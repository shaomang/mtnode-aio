# Music / speech / video

> In one sentence: the ③ music, ④ speech, ⑤ video and ⑥ Remotion compositing generation groups — each with a node description and ways to use it, and a wiring and parameter reference for music / speech / Remotion.

![Text / images → music / speech / video / Remotion → on disk](img/mtnode-flow-02-flow.svg)

*Figure: material in, finished piece out — music, speech, video and Remotion compositing all share one line.*

## Music generation · node description

### What music generation is

Calls MiniMax Music 3 to produce a whole song or pure instrumental music, one audio file per run.

The same **Audio generation** menu also lists a **YuE2** node (local YuE2 backend, **lyrics → full song**, plus an optional hand-written **ABC score**): use it when you want the lyrics sung into a complete song or want to edit the score yourself — it likewise wants a 24G-VRAM-class NVIDIA GPU. See the `yue_gen` node guide for usage and backend installation.

### Prerequisites

Install and start the MiniMax Music 3 backend on this machine first (a 24G-VRAM-class GPU is recommended); if the backend is not up the node errors out immediately. You can open it for installation and configuration from the plugins entry in the menu bar above.

### Key parameters

- **Prompt**: write only style / mood / instruments / arrangement / vocal character, and do not put lyrics in it.
- **Lyrics**: fill in the lyrics field on its own; leaving it empty = pure instrumental music.
- **Output path**: the node writes the audio straight to this file, so no "Save" node is needed.
- **Attempts**: 1–10; roll several and keep the best one, with the seed +1 each roll.
- Duration and section structure are decided by the model from the lyrics and the prompt.

## Music generation · ways to use it

- **Use 1 · a complete song**: write the lyrics with structure tags: [Intro] [Verse] [Pre-Chorus] [Chorus] [Bridge] [Outro]; keep each line 12–20 characters and rhyming, repeat one hook in the chorus; the prompt carries only the style (for example: city pop, clear female vocal, retro synths, mid tempo).
- **Use 2 · pure music / BGM**: leave the lyrics empty and prompt "light piano and strings, no vocals, good as video background music, warm mood".
- **Use 3 · roll and pick**: set attempts to 3–5, compare the outputs and keep the best one.
- **Use 4 · a batch series**: list several "style + lyrics" pairs in one text node, turn on batch mode and generate item by item, each with its own output path.
- **Use 5 · score plus narration**: generate the background music first, synthesize the narration next, then line them up in a video compositing node.

**Note**: only one audio/video task runs globally at any moment — music generation, speech synthesis and video generation share one and the same mutex.

**Time reference**: on a 4090, 74 seconds of audio took 8 minutes 30 seconds.

## Music generation · wiring and parameter reference

### Wiring

```
text (lyrics) ─┐
text (style)  ─┴→ music node → audio file (the node's own "output path")
```

No "Save" node is needed: the audio is written straight out through the node's own output path.

### Parameter reference

- **Output path**: `…/assets/music/track-name.mp3` (`.mp3` / `.wav`)
- **Attempts**: 1–10, 3–5 rolls recommended
- **Empty lyrics field** = pure instrumental music
- **Backend**: MiniMax Music 3 (local, 24G VRAM; install and start it first)

## Speech synthesis · node description

### What speech synthesis is

Speech synthesis turns text into speech with the local GPT-SoVITS backend, outputting `.wav` audio.

### Key parameters

- **Voice**: a voice name already in the local voice library; prepare / train it in advance.
- **Speed**: 0.5–2.0, where 1.0 is the original speed.
- **Output path**: the node can write the file directly.
- **Attempts**: roll the same passage a few times and keep the most natural one.

### Prerequisites

Install and start the GPT-SoVITS backend first; the voice has to be prepared in the voice library ahead of time (you can train it from the audio you provide).

### Suggestion

For everyday work it is usually worth using a free tool such as Bilibili's Bijian for speech synthesis. Local synthesis, however, lets you train your own model on any audio and use it to stream narration for text inside the app.

## Speech synthesis · ways to use it

- **Use 1 · short-video narration**: wire a script written in a text node upstream into speech synthesis.
- **Use 2 · multi-voice dialogue**: split the script by character and feed separate speech nodes with different voices to get a question-and-answer audio track.
- **Use 3 · fine-tuning the speed**: 1.1–1.2 is livelier for explainers and marketing; 0.9 is easier on the ear for lyrical narration.
- **Use 4 · rewrite before voicing**: have a text node rewrite the words into short, read-aloud-friendly sentences first — the phrasing comes out far more natural.

**Note 1**: it shares the same mutex with music / video generation, so only one runs at a time.

**Note 2**: the first run takes longer because the model has to be loaded, but afterwards it should be very fast.

**Note 3**: electronic artefacts usually come from a source audio sample rate that is too low — 32k is recommended.

## Speech synthesis · wiring and parameter reference

### Wiring

text (lines) → speech synthesis → audio file (the node's own "output path")

### Parameter reference

- **Voice**: a voice name already in the local voice library (empty = default)
- **Speed**: 0.5–2.0 (1.0–1.2 for narration, 0.9 for lyrical passages)
- **Output**: `…/assets/tts/segment-01.wav` (`.wav` / `.mp3`)
- **Backend**: local GPT-SoVITS TTS — install it and prepare voices first

### Troubleshooting

- Thin or broken sound → change voice or lower the speed
- A long text stalls → split it and synthesize piece by piece
- Backend not started → start the TTS backend in settings first

## Video generation · node description

### What the Minimax H3 video generation node is

Video generation uses MiniMax H3 (a ComfyUI backend) to generate video clips, outputting `.mp4`.

### Two modes

- **FL2VA first/last frame**: give a first frame and an optional last frame; the model fills in the motion between them, pinning the start and the end of the shot.
- **R2V multiple references**: give several reference images to control the character's look and the scene, for character consistency.
- Enable it in the plugin panel.

### Custom ComfyUI workflow (including "NanFeng H3 V10 multi-reference")

Besides the two built-in chains, the video generation node can also run **a ComfyUI graph you built yourself**:
open the node's **⚙ Settings → Workflow source** and pick "Custom ComfyUI workflow", then import the graph in the
H3 manager's **custom workflow library** (drag a JSON file or paste JSON; both API and UI formats are recognized).
The third template in the library, "**NanFeng H3 V10 multi-reference (template)**", comes from the third-party node
pack `nanfeng_prompt_nodes_v10`: a single node is the whole multi-reference pipeline (up to 9 images + 3 videos +
3 audio references). It ships with the app and is deployed automatically when you install H3.

- Parameters: every field "promoted to a node parameter" becomes a port — **port 1 = text · port 2+ = material**; the NanFeng node's Chinese controls (prompt / image N / video N / audio N / duration in seconds) are recognized correctly.
- **Limitation**: MTNode only sends `/prompt` to ComfyUI and does **not** load this pack's UI or server routes. Its asset cards, **audio drive, smart storyboard, audio lock and second-pass upscale** are therefore **not available** on the MTNode side yet and need extra bridging.
- Install prerequisites: `ComfyUI/models/latent_upscale_models/` must contain **at least one file** (that field is a required combo; an empty list makes ComfyUI reject the prompt), and **do not enable "CPU VAE"** — NanFeng H3's VAE decode raises a dtype error under CPU VAE.

### Key parameters

- **Duration**: 4–15 seconds.
- **Resolution**: auto / 480p / 720p; 480p is recommended.
- **Frame rate**: 24 / 30 / 60.
- The generation chain **outputs the native clip only** and no longer runs upscale / interpolation inline — post-processing is two standalone nodes now (see below).

### Upscale / interpolation (standalone nodes)

After generating, process the clip with two independent nodes as needed. They are not bound to each other and can be used alone or chained: **Minimax H3 → Video upscale → Video interpolation**.

- **Video upscale** (Process › Video generation › Video upscale): Real-ESRGAN x4 enlarges each frame, then the result is scaled to the target long side (default 3840 = 4K).
- **Video interpolation** (Process › Video generation › Video interpolation): RIFE inserts frames by a multiplier and the frame rate is recomputed (2x / 4x).
- **24G VRAM guidance**: keep the **low-VRAM safe tier** (per-frame `per_batch=1`) + long side 3840 for upscaling; for interpolation use **2x + the safe tier**, and for 4x interpolate to 2x first and chain a second interpolation node. The peak is driven by one decoded frame plus the model, not by the clip length; if a tier really exceeds the budget the backend **automatically drops one tier and retries once** and reports the result on the node's status line.
- Both nodes carry their own output path (`.mp4`) and produce one file per run, sharing the same audio/video mutex as music / speech / video.

### Prerequisites

Install and start the H3 backend first, on a 24G-VRAM-class GPU. If generation fails, lower the resolution and shorten the duration.

## Video generation · ways to use it

- **Use 1 · first/last frame transition**: one image for the first frame and one for the last; the model fills the motion — good for costume changes, scene transitions, camera pushes and seasonal changes.
- **Use 2 · multiple references for character consistency**: a character sheet plus a scene image as references (`r2v`) keeps the same character looking consistent across shots.
- **Use 3 · stitching a long piece**: split one long shot into several 4–8 s clips, generate them separately, then edit them into a finished piece.
- **Use 4 · short material shots**: one starting image plus a text description (`fl2va` with only the first frame filled).
- **Use 5 · aligning picture to sound**: synthesize the speech first and set each shot's duration from the audio length so picture and sound line up; this model does not accept audio input.

**Note**: VRAM mutex: it cannot run at the same time as music / speech generation and queues up automatically.

### Wiring

`fl` first/last frame (usually better quality, but no audio support): image (first frame) + image (last frame) → mp4 video

`r2v` multiple references: image / audio → mp4 video

### Troubleshooting

- Out of VRAM: lower the resolution, shorten the duration, or run upscale / interpolation separately; only one audio/video task runs at a time.
- Poor results: roll twice more, though a local model simply does not match a cloud one.

## Remotion compositing · node description

### What it is

The Remotion node composes video in code: subtitles, image-and-text cards, data animations, intro / outro templates. It is faster and steadier than frame-by-frame AI generation and gives you exact control over every frame.

### Key parameters

- **Resolution**: `1920x1080` (landscape), `1080x1920` (portrait), `1080x1080` (square).
- **Frame rate**: 24 / 30 / 60.
- **Duration**: 1–60 seconds.

### How it lands on disk

It has no output path of its own: hand the mp4 to a downstream "Save" node, with a path ending in `.mp4`.

### Where it fits

It assembles the scattered pieces AI generated (copy, images, voice-over) into the finished piece — the closing stage of the whole content pipeline.

## Remotion compositing · ways to use it

- **Use 1 · subtitled video**: wire the speech audio plus sentence-by-sentence subtitles in and compose a captioned talking-head video.
- **Use 2 · image-and-text cards / slides**: feed the split copy in item by item with background images and transitions to build a knowledge-card video.
- **Use 3 · data animation**: turn a table or a statistical result into a bar chart or a counting-number animation.
- **Use 4 · intro / outro templates**: a fixed template plus variable title text, batch-producing a series of intros.
- **Use 5 · material assembly**: stitch several AI video clips in order, add transitions and an outro, and output the finished piece.

**Note**: it takes "a script plus material" — the material itself must be prepared first with the image / speech / video nodes.

## Remotion compositing · wiring and parameter reference

### Wiring

copy / images / audio → Remotion compositing → save (.mp4)

### Parameter reference

- **Resolution**: `1920x1080` / `1080x1920` / `1080x1080`
- **Frame rate**: 24 / 30 / 60
- **Duration**: 1–60 seconds
- It has no output path of its own, so a downstream "Save" node must write it, with a path ending in `.mp4`

### Where it applies

Subtitled video, image-and-text cards, data animation, intro / outro templates — faster and steadier than frame-by-frame generation.

## Plugin error dialogs and auto-repair

All these backends install something on your machine (Python / models / dependencies), and errors raised during that install or while running used to land only as a one-line toast inside the plugin's own console window — **invisible whenever that window was closed**. Now any such plugin error pops an **error report** in the main window:

- The report shows **which plugin**, the **error code**, the **error body**, a collapsible **console log tail and the latest failure focus**, plus **the node that failed and the canvas it lives on**.
- Three buttons: **🤖 Auto-repair** / **Open the console** / **Ignore**. The dialog is persistent — clicking the backdrop or outside never closes it — and it can be **minimized to the status bar** so you can look at the canvas and come back.
- Several errors at once: they **queue**, they never replace a dialog you are halfway through editing (there is only one overlay).

What happens when you press **Auto-repair**:

1. A **visible session** appears in the left sidebar, titled "Auto-repair · <plugin>", with its workspace set to that plugin's **install directory (INSTALL_DIR)**; the log and context are handed to it.
2. That session works in the plugin install skill's **self-repair** mode: it only touches files inside INSTALL_DIR, **does not start the service**, never deletes your `output/`, and does not re-download weights that are already in place. You can watch what it edits, stop it, or ask it questions at any time.
3. When it succeeds (it replies with something like `repair_ok=1`) the app **automatically restarts that plugin's service** — stop the old process first, then start it — reports "<plugin> service is restarted", and refreshes both the plugin card and the failed node's status. **Remotion has no resident service**, so instead the node that failed is simply re-run.
4. If it did not fix it (or was terminated), a second "Repair result" report opens with the verdict and `reason=` — and it deliberately contains **no auto-repair button**: one error gets exactly one auto-repair, so it cannot spiral into endless popups.

**These only get a report, never auto-repair** (a self-repair pass would not make them better): you cancelled or stopped it yourself, an install is already running, disk space is too low, no NVIDIA GPU detected, **the driver is too old**, or the install directory is invalid (drive root / system / app folder). The report spells out the next step to take.

> Want to do it yourself: take the **error code** and the log tail from the report and check them against the **known failures** section of that plugin's install skill (e.g. `minimax-h3-install`) — much faster than letting the Agent guess. The single source of truth for skill text is `skills/<skill-name>/SKILL.md` in the repo (or in the installed package).
