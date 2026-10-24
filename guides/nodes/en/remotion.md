# Remotion video (React motion composition)

The **Remotion video** node is provided by the **remotion** app plugin. In the **build phase** an agent writes a whole Remotion (React) project from your brief; once **frozen**, the runtime phase is pure script rendering — the project is rendered to `.mp4` **without ever calling a model**, so the same project always produces the same result. Rendering happens on this machine and does not depend on any cloud video service. Each run produces exactly one video file, handed to a downstream **Save** node (the node itself has no output path).

## Two states: not frozen / frozen

| | Not frozen | Frozen |
|---|---|---|
| Source | Only a description of what the node does (new nodes, old canvases) | Full project source + input contract stored on the node |
| ▶ | No live generation: pasted composition code / a bundled project is rendered; with nothing wired it asks you to build first | **Script render only** — no model at all |
| Ports | 无差别 dynamic ports (0, 1, 2…, one more per wire) | Fixed by the contract in the source (one per item + a trailing control port) |
| Advice | Click **Build** to freeze it | Click **Build** with a new brief (iterates on the existing source by default) |

> The node body is a **description** (what this node is for, read by humans only). The build brief lives in the build dialog and is stored as `remotionBuildNote`. Old briefs written in the node body are copied into it the first time you open the dialog (the body is left untouched). There is no live-generation path at run time any more.

## Build (freeze)

1. Click **Build** on the node card (or *Build…* in ⚙ settings) and write this build's brief in the dialog: what to show, pacing, on-screen text, how the media is used.
   - The dialog also has *Ignore existing source, rebuild from scratch* — unchecked by default, i.e. iterate on the existing source.
   - The brief cannot be empty (no build, and it never falls back to the node description or the previous brief).
2. The build agent will:
   - write a **multi-file** project under `<workspace>/.mtnode/remotion/<node id>/build/src/` (entry is always `Composition.tsx`; extra files such as `components/*.tsx` are allowed);
   - declare the input contract (below);
   - run a static check first (import whitelist / entry export / relative files / contract), then a **≤ 2 s test render**;
   - on failure, feed the error back and self-repair, **at most 3 rounds**; if all 3 fail, **the previous working source is kept** and only the error is shown on the node.
3. On success the project is **frozen**: the whole tree is stored on the node, ports are rebuilt from the contract, and the status line reads 「已固化：N files · M ports」.

The build agent has its own model settings (preset / provider / model / effort) in ⚙ settings; leave them empty to follow the global default.

## Input contract (declared in source)

`export const inputs = [...]` in the entry file — the host derives the node ports from it, so **editing the code edits the ports**, single source of truth:

```tsx
export const inputs = [
  { key: "hero",   kind: "image",  label: "Hero", required: true },
  { key: "voice",  kind: "audio",  label: "Voiceover" },
  { key: "poster", kind: "image",  label: "End card" },
  { key: "lines",  kind: "text",   label: "Lines", list: true },
  { key: "speed",  kind: "number", label: "Speed" },
];
```

- `kind` ∈ `image` / `audio` / `video` / `text` / `number` / `boolean` / `json`; `key` is the prop name the component receives.
- `list: true` — that port accepts several wires and the value becomes an array (several clips / several lines).
- `required: true` is only a marker: when nothing is wired the host names it in the node log; the project must still fall back to a default.
- Ports not in the contract do not exist. After a rebuild, **wires on surviving keys are kept**; wires on keys that disappeared are dropped and the count is reported on the status line.

## How media reaches the component (prop convention)

| Port | Component receives | How to use |
|---|---|---|
| image | a `data:` URL string | `<Img src={hero} />` |
| audio / video | the **bare file name** (already parked in the project's `public/`) | wrap with `staticFile(voice)` for `<Audio>` / `<OffthreadVideo>` |
| text | string (array of strings when `list`) | use directly |
| number / boolean / json | the scalar / parsed JSON | use directly |

**When an audio port is wired and its real duration is known, the output length = the audio length** (overriding the node's *Duration*); otherwise the node setting applies. Width / height / fps always come from the node settings — read them with `useVideoConfig()` rather than hard-coding.

## Project constraints

- Dependencies are `react` + `remotion` plus **relative files inside the project** (`./components/Title`) — no third-party npm package, since the host never runs `npm install` for you.
- The entry `Composition.tsx` must export `Main` (a React component) and wrap everything in `<AbsoluteFill>`; `index.tsx` is generated by the host.
- Do not add a `package.json` and do not start renders yourself; rendering is the host's job.

## Settings window

⚙ settings is split into sections:

- **Description (nothing to do with building)** — same field as the node body; describes what the node does, the build agent never reads it;
- **Build / verify** — Build… (opens the build dialog), Test render, Check source, plus status (build error, verify error, frozen timestamp, file and port counts);
- **Build agent model** — preset / provider / model / effort (empty = global default);
- **Source (frozen project)** — the multi-file editor (pick file / edit / add / delete). **Save & check only runs the static check** (import whitelist / entry `Main` / contract parsing; ports are recomputed and dead wires dropped). To actually render, use **Test render** (≤ 2 s, does not take the global audio/video lock, artifact discarded);
- **Render** — duration / fps / resolution;
- finally **intermediate artifacts**.

## Notes

- Only **one audio/video job** runs globally at a time (music and video are mutually exclusive). The build-time test render deliberately **does not take that lock** (it burns a couple of seconds and produces no deliverable).
- The first render downloads Chrome Headless Shell automatically (domestic mirror first, falling back to a local Edge / Chrome).
- `inputRange must be strictly monotonically increasing`: the project's `interpolate` keyframe array has duplicates / reversed entries — fix the source (Save & check → Test render) or click **Build** with *rebuild from scratch*.
- To start over: **Build** → tick *Ignore existing source, rebuild from scratch* (if it fails, the old source is kept).
- ▶ on a non-frozen node with nothing wired does nothing: runs never call a model any more — build first, or wire media / voice / lines.

## Intermediate artifacts (travel with the workflow)

When you save a workflow, the Remotion project travels as an intermediate artifact: `remotionFiles` (the whole tree), `remotionInputs` (the contract) and the entry `tsx` go with the node. Insert it on another machine or from the workshop and **the ports are already in place from the contract** — runtime only renders that source, no model and no rebuild needed (unless you want to change it).

## Session (💬)

- **Open the bound session**: click **💬** in the node header to jump to the agent session bound to this node (created on first click).
- **Run log**: every render appends one entry (success: output path / resolution / fps / elapsed / code; failure: error; cancel: cancelled), never stacked twice.
- **Iterate**: describe the change in the session, or edit the source in ⚙; then Save & check → Test render → press ▶ on the canvas.
- **Let the agent edit the project**: the session agent can write `remotionFiles` (the whole source tree, paths relative to `src/`) and `remotionInputs` (the port contract) through the canvas edit API. Source writes go through the same static check as **Save & check**: on success the ports are recomputed and same-key wires follow; on failure the source is still saved, the ports keep the previous version, and the reason comes back in the receipt. Reading returns the contract and file list at `standard`; the full source tree only at `detail:"full"`.

## Installation

The node ships with the **remotion** plugin: click **Install** on the plugin card (runs `npm install`, with every step shown in the separate install window) → afterwards the primary button becomes **Reinstall**. It has no resident backend, so there is no start / stop.
