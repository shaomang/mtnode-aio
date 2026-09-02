# Music, video, network and execute nodes

## Music generation (MiniMax Music 3)

Local Music 3 backend (Gradio). **Each run produces exactly one audio file** (`.wav`) written to the node’s own **output path** — no save node needed.

- Ports: 0 = prompt · 1 = lyrics · 2 = control input
- Options: output path, attempts (1–10), seed (bumped by +1 each roll)
- Note: only **1 audio/video task** globally at a time (music and video are mutually exclusive); others queue

## Video generation (MiniMax H3)

Local H3 backend (ComfyUI). **Each run produces exactly one video file** (`.mp4`) written to the node’s own **output path**.

- Ports: 0 = control input · 1+ = data slots (reference images / text)
- Modes: `fl2va` first/last frame (default) / `r2v` multiple references
- Options: duration 4–15 s, resolution (auto / 480p / 720p / 1080p, auto-downscale on low VRAM), 4K upscale + interpolation (disable on 24G), attempts

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

- Media nodes have their own output paths — do **not** add a save node after them.
- See the right-click **Node guide** of each kind for exact ports.
