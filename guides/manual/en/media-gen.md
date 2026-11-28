# Music, speech, video & local plugins

Beyond text and images, MTNode can compose songs, synthesize voiceovers, animate images into video or talking avatars, and assemble polished `.mp4` videos with Remotion. Most local engines install on demand from the top bar **Plugins** window and run on your own GPU.

![Music, speech, video and Remotion pipeline](img/mtnode-flow-02-flow.svg)

## Music & audio

- **MiniMax Music 3**: Combine a style prompt (genre, mood, instruments) with structured lyrics (`[Verse]`, `[Chorus]`) to generate a full track — or leave lyrics blank for instrumental BGM. Roll 1–10 takes and pick the best.
- **YuE2 Local Music**: Turns lyrics into full vocal + instrumental songs, with optional score planning and zero-shot covers.
- **MOSS-Music**: Understands existing songs or videos — extracts timestamped lyrics, mood, structure, and chords, or answers questions about the track.
- **Audio Spectrum Analysis**: Lightweight, no GPU needed. Detects beats, BPM, bars, and onset curves with a heatmap spectrogram so you can sync edits and Remotion clips cleanly to the beat.

## Speech synthesis & transcription

Choose between free local processing or zero-install cloud nodes:

- **Breeze TTS 2 (local plugin)**: Clone any voice from a reference clip or steer delivery with natural-language instructions ("upbeat, slightly faster"). For crisp audio without artifacts, use clean reference clips (32 kHz+ recommended).
- **DeepSeek TTS & ASR nodes (no plugin needed)**: Use your official DeepSeek account directly for cloud text-to-speech and audio/video-to-text transcription with zero local GPU usage.

## Video, talking avatars & local image models

- **MiniMax H3 Video**: Generate clips from first/last frames or multiple character references, or load your own **Custom ComfyUI workflow** under node **⚙ Settings → Workflow source**.
- **Video Upscale & Video Interpolate**: Standalone post-processing nodes to upscale clips toward 4K or smooth frame rates (2x / 4x).
- **InfiniteTalk & SoulX Avatars**: Turn a portrait (or source video) plus a voice track into a lip-synced talking video.
- **FLUX 3 Image Klein & Qwen Image 2.1**: High-quality local image generation with multi-reference editing, mask inpainting, and transparent backgrounds.

## Remotion motion video

Bring your script, voiceover, images, and clips together in a **Remotion** node to render crisp captioned videos, title cards, and data animations. Wire a **Save** node (`.mp4`) after Remotion to write the final file.

> **GPU queue**: Heavy local audio/video tasks share a single queue so your GPU never runs out of memory by trying to render two clips at once. If VRAM is tight, lower resolution/duration or toggle **Lean** on the top bar to pause canvas thumbnails.

## Using plugin cards (install, run & clean cache)

Open **Plugins** from the top bar. Every local plugin card works the same way:

1. **Install / Reinstall**: Click **Install** to open the guided install window, pick a folder, and let MTNode handle the steps (closing the window keeps installation running in the background). Already downloaded big model weights? Use **Locate weights…** inside the install window to move them in without re-downloading.
2. **Enable / Disable**: Click **Enable** to start the backend quietly in the background with no pop-up terminal windows; click **Disable** when you want your GPU memory back.
3. **Console**: Open the plugin's console window for test generation, voice libraries, or custom ComfyUI workflows. Closing the console does not stop the background service.
4. **Logs & one-click cache cleanup**: Click the **ⓘ** badge at the top-right of any plugin card to view live status, GPU usage, logs, and **Output cache** — clean up old temporary renders (choose **Keep last 7 days** or **Clean all**) without touching model weights or environments.
5. **Uninstall**: Open the install window and click **Uninstall** at the bottom. You'll see exactly what is removed and what is kept before confirming.

## Plugin error dialogs and auto-repair

If a local plugin fails to start or hits a dependency error, MTNode shows a clear error report with three actions: **Auto-repair**, **Open console**, or **Ignore**.

Clicking **Auto-repair** opens a dedicated repair session scoped to that plugin's install folder (`INSTALL_DIR`), investigates the logs, fixes the environment without deleting your models or outputs, and automatically **restarts** the service when done (or re-runs the node for Remotion). Each error offers auto-repair once; for hardware limits like an older driver or low disk space, the report tells you directly what to update.
