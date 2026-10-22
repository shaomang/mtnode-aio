# Remotion video (React motion composition)

The **Remotion video** node is provided by the **remotion** app plugin: write the video description inside the node (or wire in footage / voice / dialogue directly), have an LLM generate React motion-composition code, then render it to `.mp4` with the local Remotion (React renderer) — rendering happens on this machine and does not depend on any cloud video service. **Each run produces exactly one video file**, and the video is handed to a downstream **Save** node (the node itself has no output path).

## Installation

The node ships with the **remotion** plugin; when the plugin is not installed (or is uninstalled), neither the menu entry nor the canvas node is shown.

1. Open **Plugins · Remotion Motion Video** and click **Open console & install**;
2. Pick an install folder (≥ 8 GB free disk required) → **Install** (runs `npm install` for you, a domestic mirror is available) → wait until the console's status badge reads **就绪 (Ready)**.

> **Skills are an optional enhancement**: installation never downloads any agent skill, and **generation and rendering work fine without one**. If you want the LLM to write more idiomatic motion code, search **Creative Workshop → Skills** for **Remotion Motion Video** and download it yourself (it lands in `dsh-home/skills` on this machine and serves the global assistant / agent sessions / smart nodes); if you want Remotion's official skill bundle, run `npx -y skills add https://github.com/remotion-dev/skills --skill remotion-best-practices` yourself.

## How you use it

```
footage (H3 dynamic layer / video / image) ┐
voice   (Breeze TTS)                      ├─▶ Remotion video node ──▶ save node (outputs .mp4)
dialogue (text node)                      ┘        description lives in the node
```

1. **Description**: type it into the node's own text box (same box as the text-processing node: it supports `@node title` / `@tag` references to wired upstream content and `/` to summon skills). **It may be empty** — with an empty description the node renders the built-in "character motion + dialogue card" layout straight from the wired inputs;
2. **Wiring**: connect footage, voice and dialogue to the input ports (ports 0, 1, 2… — one more per wire, no port picking needed);
3. **Run**: with a description the LLM writes the motion code and the local renderer renders it; with an empty description (or a description containing `{{hero}}` / `{{narration}}` / `{{voice}}` / `{{bg}}` placeholders / dialogue-card wording) the built-in template is used and materials are injected from the wires. If the generated code imports anything besides `react` / `remotion`, or exports no registrable component, the node fails outright and says why (it never silently swaps in a built-in title card);
4. **Save node**: wire Remotion's control output into a save node to trigger the save, set its output path (`.mp4`) there, and the rendered file is copied to that path.

## Ports

- **Input**: **uniform dynamic ports** — ports 0, 1, 2… grow one per wire; data lines and control lines **share the same ports**, first come first served (a control node's wire colours its port as control automatically). There is **no "description" port** — the description is a field of the node itself.
  - What you wire in is mapped by source type: **video / image → hero (main material)**, **audio → voice**, **text → narration (the longest one when several)**; wiring an extra "dialogue beat sheet" makes the render reveal lines beat by beat.
- **Output**: video (downstream can preview / save it) + control

> Existing canvases are migrated when loaded: an old "port 1 = description text" wire becomes the node's description (written as `@upstream title`, so it follows upstream edits) and the remaining port numbers shift down by one.

## Settings

Description / duration / frame rate / resolution and the provider + model are edited in the window opened by **⚙ Settings** in the node header (the description can also be edited directly in the node body), and take effect immediately; the node card shows only one line with the current summary.

## Parameters

- **Duration**: 1–60 seconds (default 5)
- **Frame rate**: 1–60 fps (default 30)
- **Resolution**: 1280x720 / 1920x1080 / 1080x1080 and others (default 1280x720)
- **Provider / model**: used to generate the motion-composition code (an LLM text model; its API Key is configured under "Settings · API / config")

> The video output path is configured on the **downstream Save node**; the generated composition code,
> `render.json` and the rendered video all land in the **canvas working directory** under
> `.mtnode\remotion\<node id>\` (the install folder only holds dependencies, never your code).
> Without a working directory the node stops and asks you to set one first.

## Session (💬)

The Remotion node is wired up to agent sessions, so you can watch the generation and iterate on the code:

- **Open the bound session**: click the **💬** button in the node header to jump straight to the agent session bound to this node (the first click creates the binding). You can click it while a run is in progress too; live progress stays on the node's status bar and the **▤** console.
- **Process record**: when a generation ends, the session appends one process record — on **success** it carries the output path, resolution, duration, frame rate, elapsed time and the generated motion code (a TSX code block); on **failure** the error; on **cancel** it is logged as "cancelled". Clicking 💬 repeatedly does not stack duplicates.
- **View / copy / edit the TSX**: the ```tsx code blocks in session messages can be read and copied directly; feed the motion code back to the agent in the session to keep revising it.
- **Change parameters in the session, then re-run**: just send a message asking the agent to adjust the node ("make the title animation a 3D flip", "duration 8s, resolution 1920x1080", "change the description to …") and it updates the node's parameters; back on the canvas press **▶** to re-run and the new result is written to the session again — closing the loop "watch the process → edit and iterate → re-run".

## Notes

- Only **1 audio/video task** may run globally at a time (music and video are mutually exclusive).
- Generation happens in two stages: the LLM writes the motion code (network API) → the local Remotion renderer renders it (the Chrome Headless Shell is downloaded automatically on first use).
- **Rendering fails with `inputRange must be strictly monotonically increasing`**: the LLM's motion code has a duplicate or descending keyframe array in `interpolate(frame, inputRange, ...)` (e.g. `[220,280,280]`, typically inside a `map` / loop that derives frame numbers from `i`, where a larger `i` collides with a fixed frame). The node shows the fix directly: remove the duplicated frame numbers, or use `Math.max(...)` inside the loop so each frame number is strictly greater than the previous one; you can also paste the error into the node's 💬 session and let the agent fix it, or re-run the node to regenerate the motion code.
