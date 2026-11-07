# Remotion video (React motion)

Provided by the **remotion** plugin: in the **build phase** an agent turns your brief into a full Remotion (React) project; once **frozen**, the run phase only renders that project to `.mp4` and **never calls a model** — the same project yields the same video every time. Rendering happens locally, no cloud video service. Each run makes one video file, saved by a downstream Save node (the node itself sets no output path).

## Ports
- **In**: before freezing, undifferentiated dynamic ports (0, 1, 2… one more per wire); after freezing, fixed by the contract declared in the project, one port each plus a final control port
- **Out**: the video is saved by a downstream Save node

## Settings
Change these in the settings window opened by **⚙ Settings** in the node header:

- **Function note**: the same field as the node body; it only describes what the node does and the build agent does not read it.
- **Build / verify**: Build… / Test render / Validate source, plus status (build error, test-render error, freeze time, file and port counts).
- **Build agent model**: preset / provider / model / thinking effort; empty = follow the global default.
- **Source (frozen project)**: a multi-file editor to edit / add / delete files; **Save & validate** only runs static checks (import allowlist / `Main` export / contract parsing) and recomputes ports, dropping dead wires.
- **Render**: duration 1–60 s (default 5), frame rate 1–60 (default 30), resolution (default 1280x720).

## Usage
1. Click **Build** on the card (or Build… in the settings window) and describe the visuals, pacing, text and how assets are used. The brief cannot be empty; by default it iterates on the current source — tick **Ignore existing source, rebuild from scratch** to rewrite.
2. The build agent writes a multi-file project under `<working folder>/.mtnode/remotion/<node id>/build/src/` (entry is always `Composition.tsx`), declares the port contract, runs static checks and a ≤2 s test render; failures are fed back for up to 3 rounds, after which the last working source is kept.
3. On success it freezes: the whole source is stored in the node and ports follow the contract. ▶ then only renders.

## Notes
- The contract lives in the source: `export const inputs = [...]`, `kind` ∈ `image` / `audio` / `video` / `text` / `number` / `boolean` / `json`, and `key` is the prop name the component receives. `list: true` accepts many wires (value becomes an array); `required: true` is only a marker and an unwired one is named in the node log. Editing code edits ports; after a rebuild, wires on the same key survive.
- How assets arrive: image gets a `data:` URL; audio / video get a **bare file name** (already in the project's `public/`) — wrap it in `staticFile(...)`; text / number / boolean / json arrive directly. If an audio port is wired and its length is known, the video lasts exactly that long, otherwise the node setting applies; width, height and fps always come from the settings.
- Dependencies are only `react` + `remotion` plus relative project files — no third-party npm packages (the host never runs `npm install`). The entry must export `Main` with an `<AbsoluteFill>` root.
- Only **1 audio/video task** may run at a time (music and video exclude each other); the build-phase test render does not take that lock. The first render downloads Chrome Headless Shell (domestic mirror first, falling back to local Edge / Chrome). Install from the plugin card's **Install** (runs `npm install`, shown step by step in a separate install window); afterwards the main button reads **Reinstall**. There is no resident backend, so there is no start / stop.
- `inputRange must be strictly monotonically increasing` means duplicate or descending `interpolate` keyframes — fix the source (Save & validate → Test render) or rebuild from scratch.
