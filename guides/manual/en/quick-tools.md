# Quick tools, voice & hotkeys

The bottom status bar gives you one-key access to everyday helpers — whether you are on the canvas, in a session, or inside a standalone app window.

![Bottom status bar shortcuts](img/mtnode-quick-tools-ui.svg)

## Status bar tools from left to right

### 1. Inline completion (`Ctrl + Tab`)

The leftmost icon toggles AI typing predictions in any text box. Pause briefly while typing and press `Tab` to accept. See [Inline completion (FIM)](#fim).

### 2. Quick chat window (`F1`)

Need to fire off a quick instruction without leaving what you're doing? Press `F1` to summon a compact always-on-top window next to your cursor:

- **Clean results only**: Shows just your latest prompt and the AI's final reply — no noisy tool logs or scrolling walls.
- **Switch or expand**: Click **☰** to switch sessions, **＋** to start a new one, or **↗** to open the full session in the main window.
- **Drafts are kept**: Closing the window never clears unsent text.

### 3. DeepSeek drawer (`F2`)

Press `F2` to slide out the official DeepSeek web chat on the right side of the window. Great for quick lookups without using API credits; press `F2` or `Esc` to tuck it away while keeping your login and history.

### 4. Voice readout (`F3`)

Press `F3` (or click the speaker icon) to have MTNode read AI replies aloud.

- **Offline by default**: First use downloads a local voice model (~500 MB) and runs completely offline.
- **Right-click for voices & cloud**: Clone a custom voice from a reference clip, reuse a Breeze voice, or switch to **DeepSeek Cloud** TTS for natural streaming audio.
- **Live caption bar**: The center of the status bar shows the current spoken line (or latest agent reply); click it to expand the full text.

### 5. Global voice input (`F4`)

Speak directly into **whichever text box currently has focus** — chat input, node prompts, research notes, or search bars.

Click the mic button to cycle through three modes:

| Mode | Icon | How it works |
| --- | --- | --- |
| Off (default) | Gray 🎤 | Microphone stays idle |
| Continuous | Cyan ● | Listens continuously; pause briefly after each sentence to insert text |
| Push-to-talk | Amber F4 | Listens only while you **hold `F4`**, inserts when you release |

- **Local or cloud**: Runs offline on your CPU by default (~239 MB first-time download, audio stays on your machine). Right-click the mic to switch to **DeepSeek Cloud** recognition if preferred.
- **AI polish (✨ next to the mic)**: When enabled, raw transcription lands immediately, then your default text model quietly fixes typos, punctuation, and filler words without changing your meaning or overwriting manual edits.
- **No lost sentences**: If no text box is focused while you speak, MTNode holds the text and inserts it as soon as you click into any input field.
- **Right-click menu**: Pick language (auto-detects Chinese, English, Cantonese, Japanese, Korean), adjust pause length, or open full voice settings.

### 6. High-res canvas snapshot (camera icon)

Export the entire canvas — every node, wire, and annotation — as a crisp `.png` overview image.

### 7. "AI working" live progress bar

Whenever an AI task is running, a status chip appears on the bottom bar. Click it to see step-by-step progress, jump straight to a waiting approval, or stop the task.

## Essential hotkeys

| Shortcut | Action |
| --- | --- |
| `Ctrl + Tab` | Toggle inline completion (FIM) |
| `F1` | Open / focus Quick chat window |
| `F2` | Open / close DeepSeek drawer |
| `F3` | Toggle voice readout |
| `F4` | Toggle voice input (or hold to talk in push-to-talk mode) |
| `Ctrl + F` | Global search (nodes, sessions, files, manual) |
| `Space` | Fit the whole canvas in view |
| `D` | Hide / show canvas wires |
| `J` / `K` / `L` | Open Plugins / Tool library / Asset library |
| `Ctrl + Z` / `Ctrl + Y` | Undo / Redo |
| `Ctrl + D` | Duplicate selected nodes in place |
| `Ctrl + Scroll` (in session) | Zoom session font size (10 steps, saved automatically) |
| `Esc` | Close the active dialog or cancel |
