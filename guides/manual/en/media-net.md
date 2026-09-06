# Music, video, network and execute nodes

Right-click the canvas → **Process** holds two first-level submenus: **Video generation** (Minimax H3, Remotion video) and **Audio generation** (Minimax Music 3, SoVITS speech).

## Audio generation › Minimax Music 3 (music)

Local MiniMax Music 3 backend (Gradio). **Each run produces exactly one audio file** (`.wav`) written to the node’s own **output path** — no save node needed.

- Ports: 0 = prompt · 1 = lyrics · 2 = control input
- Options: output path, attempts (1–10), seed (bumped by +1 each roll)
- Note: only **1 audio/video task** globally at a time (music and video are mutually exclusive); others queue

## Audio generation › SoVITS speech (text to speech)

Local GPT-SoVITS backend started by the “GPT-SoVITS speech” plugin (an OpenAI-compatible service). **Each run produces exactly one audio file** (`.wav` / `.mp3`), again written to the node’s own **output path**.

- Ports: in 0 = text to speak · in 1 = control input; out 0 = audio · out 1 = control
- Options: output path, voice (empty = the backend default), speed (0.5–2.0), format (wav / mp3), attempts
- When the backend is missing or stopped the node starts it before synthesizing; installing it and preparing voices happens in the **Plugins** panel
- Speech shares the same **serial chain** as music / video (one generation task at a time), but SoVITS is a separate process and does **not** hold the app’s audio/video global lock

## Video generation › Minimax H3 (video)

Local MiniMax H3 backend (ComfyUI). **Each run produces exactly one video file** (`.mp4`) written to the node’s own **output path**.

- Ports: 0 = control input · 1+ = data slots (reference images / text / reference audio / reference video)
- Modes: `fl2va` first/last frame (default) / `r2v` multiple references
- Options: duration 4–15 s, resolution (auto / 480p / 720p / 1080p, auto-downscale on low VRAM), 4K upscale + interpolation (disable on 24G), attempts

### Custom ComfyUI workflow

Click **⚙ Settings** in the node header → set **Workflow source** to **Custom ComfyUI workflow** to run a graph you built in ComfyUI yourself (not just the two built-in chains):

- Workflows are imported in the **H3 manager window · custom workflow library** (drop a file or paste JSON; both API and UI formats are accepted) and stored machine-wide, shared by every canvas
- Fields **promoted to node parameters** become node ports (port 1 = text · port 2+ = media); you can also type values in the settings window — a wired port beats the manual value, and with neither the workflow's stored value is kept
- With several `Save*` outputs you pick which artifact the node returns; ↻ re-syncs the parameter table with the stored graph; **Validate nodes** checks custom node packs against the backend `/object_info` (skipped when the backend is down — never blocks a run)
- In custom mode the built-in duration / resolution / sampler / upscale options no longer apply (the graph decides); rolls, seed, progress, cancel and the global media lock keep working

## Video generation › Remotion video (motion graphics)

React motion graphics rendered locally to mp4. This one has **no** output path of its own — a downstream **Save** node writes the file. The entry is hidden from the menu while the Remotion plugin is not installed.

## Audio / video input nodes (output a file URL)

The **Audio node** and **Video node** under input nodes each have a single data output port whose value is a `file:///…` URL of the local file you picked: wire it straight into a Minimax H3 reference-audio / reference-video slot, into a **Save** node, or `@`-reference it. Receiving ports normalize the URL back to a local absolute path for you.

## Network · receive / send (net_recv / net_send)

Cross-canvas / cross-machine text channels, TCP / UDP:

- **Receive**: listens on a `host:port` channel and asynchronously forwards received text (port 0 = data, port 1 = control); auto-listen by default.
- **Send**: pushes the data input text to a target `host:port` (port 0 = data, port 1 = control trigger); terminal node.
- **Channel**: multiplexed per channel id (0–65535) on one port; send and receive on the same channel talk to each other.
- Default ports in **Settings · Network** (receive 40999 / send 41000), overridable per node.

## Execute node (one-click launch)

Bind `.exe` / `.bat` / `.cmd` / `.lnk` or any system-openable file; **double-click the node** (or click the play button twice) to launch via the OS default handler. Optional icon and theme color for quick spotting. No data ports.

Create: right-click empty canvas → **Dev node (project architecture · feature block)** → **Execute** — keep a project's launcher next to its architecture.

## Tips

- Music / speech / video nodes carry their own output paths — do **not** add a save node after them; Remotion is the opposite, its file lands via a downstream save node.
- See the right-click **Node guide** of each kind for exact ports.
