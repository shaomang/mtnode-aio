# Input / process / save

> In one sentence: wire the smallest chain — input node → process node → save node — and produce your first file on disk.

![Data flow](img/mtnode-flow-01-flow.svg)
*Figure 1: the input → process → save data flow; data ports carry content, control wires only trigger.*

## Goal

After this page you can lay out all three steps on the canvas — text / image / audio-video in, an LLM or an image generation out, written into a file — and you know each input kind's real capacity limits plus the save node's rules for writing to disk. How to tune parameters and how to preview a request is the next page.

## Before you start

- At least one **text provider** with an API key (text processing) and / or an **image provider** (image generation) — see [Providers & API](#providers).
- If you want the save node to use a relative path, give this canvas a **workspace** first — see [Workspace & archives](#workspace).
- Know that **right-clicking empty canvas** is the way to add nodes — see [Nodes, wires, @ refs](#nodes-wires).

## Steps

### 1. Add an input node and put the content in

1. **Right-click empty canvas** → **Input node** → text / image / audio / video; pick one.
2. **Fill it in place**: a text node takes typing straight in the card; click **📄** to import `txt` / `md` / `json` / `yaml`. An image node takes a click to choose, or drop a file onto it.
3. **Remember the real capacity limits**: a single text item over **2 MB** is **truncated, keeping the head**; over **32 MB** it is **not read in** and only the file path stays on the node. Dropping a file and importing via 📄 share the same rule (the old claim of "rejected over 500KB" was wrong).
4. **Audio / video**: pick one local media file and the node previews it in place; its output value is that file's `file:///` URL, which can go straight into a reference port, into a save node, and can be picked up by `@Title`. The receiving side normalizes the URL back to a local absolute path for you — no manual conversion.
5. **To reuse content across canvases**, don't copy-paste: use an asset node instead (deleting a canvas never loses the asset library) — see [Asset library](#asset-library).

### 2. Add a process node and wire it up

1. **Right-click** → **Process node** → **Text processing** or **Image generation**.
2. **Feed it the input**: drag a wire from the input node's output port to the process node's input port. Text processing eats text; image generation eats a prompt, and if you want a reference image add a second image wire — that is **image-to-image**.
3. **Write the prompt**: state what you want inside the node; `@Title` pulls in an upstream node's content.
4. **Text processing can switch on 🐋 Agent**: the prompt then becomes a task, and the model can read files / go online / run commands before delivering — see [Agent task & session](#agent-nodes).
5. **Click ▶ Run**: when processing finishes the downstream nodes run automatically; if a downstream node already has content, you are asked whether to **overwrite** or **not continue**.

### 3. Add a save node to write to disk

1. **Right-click** → **Save node**, wired to the process node's data output. Do **not** put a save node after an agent node, or after text processing with 🐋 Agent switched on — those write files themselves.
2. **Fill in the save path**: a relative path works when the canvas has a workspace, otherwise give an absolute path.
3. **Check the extension**: the save node is typed by **the port the wire actually comes out of** — text → `.md` by default (YAML content also lands as `.md`), image → `.png`, audio → `.wav`, video → `.mp4`; a wire dragged out of an image port flips the save node to image saving automatically.
4. **Tick "auto-save on input change" if you want it**: once on, every upstream change writes once; on a batch chain that is one file per item, with the name appended as `{filename}_{input node title}` — see [Batch, split, merge](#batch).
5. **Click ▶ to write out**; the artifact lands at the path you gave.

## Result

- The canvas holds a chain you can re-run as often as you like: change the input → ▶ → a new result → written into the file automatically or by hand.
- The save node remembers the path of its most recent write, and the saved file is visible on the node.
- Every later page builds on this three-step chain: tuning parameters is [Parameters & runs](#params-runs), running many items is [Batch, split, merge](#batch), and audio/video output is [Music / speech / video](#media-gen).

## Common mistakes

| Symptom | Cause | Fix |
| --- | --- | --- |
| ▶ says no provider configured / no model available | No provider with an API key | Add one in Settings → Model services and fill in the key — see [Providers & API](#providers) |
| The imported text stops after the opening | The single item is over 2 MB and was truncated, keeping the head | Split it into several items / go through batch, or read it from the file instead |
| After importing, the node holds only a path and no text | The file is over 32 MB, so it is not read in | Shrink the file, or process it in a way that can read from a path |
| Save reports "path cannot be resolved" | A relative path, but the canvas has no workspace | Give the canvas a workspace, or switch to an absolute path |
| The save lands as `.md`, not `.yaml` | `.md` simply is the default extension for a text save | Check the source port type; if you need YAML, let the `.md` file carry YAML content |
| Text processing says it cannot read images | An image wired into a text provider with no vision | Tick "Vision" on that provider, or switch to a multimodal model |

## Next

- [Parameters & runs](#params-runs)
- [Batch, split, merge](#batch)
- [Music / speech / video](#media-gen)
- [Global node](#global-broadcast)
- [Save, import/export, workshop](#workflows)
