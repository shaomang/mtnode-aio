# Node guide index

> One-sentence goal: know which file holds the dedicated notes for each node type, and how to open it in one step from the canvas.

![Node map](img/mtnode-canvas-06-ui.svg)
*Figure 1: 39 registered node types, each with its own illustrated Markdown guide.*

## Goal

A **node guide** is the manual for **one kind of node**: how its **ports are wired, what its buttons do, and when it fails**. This manual is about **how to use the app as a whole** — the two have clear roles and do not repeat each other.

Node guides are Markdown files kept in `guides/nodes/`, and `guides/nodes/index.json` registers **39 ids**, one set each in Chinese and English (falling back to Chinese when an English translation is missing). This page is the English index for that list.

## Before you start

- There is already a node on the canvas (created any way you like, see [Nodes, wires, @ refs](#nodes-wires)).
- To read the English version, switch the top bar language to EN first — guides follow the UI language.

## Steps

### 1. Open it straight from a node

**Right-click any node** on the canvas → the first item on the menu is **Node guide**; click it to open.

The dialog title is "**Node guide · <node title>**"; the body is that kind's illustrated Markdown, and you close it with **Close** in the bottom-right (or ✕ / `Esc`).

### 2. How the "guide id" is decided

Which guide file opens is decided by the node type, and the rule is simple:

- Ordinary nodes → their kind is used directly as the id (such as `proc_text`, `gate`);
- **Save nodes** → always go through `save`;
- **Control nodes** → split by role: the start goes to `ctrl-start`, the success end to `ctrl-end-ok`, the fail end to `ctrl-end-fail`, and everything else goes to `control`.

### 3. Look up the index table below by type

| id | Guide file | Notes |
| --- | --- | --- |
| `input_text` | `guides/nodes/input_text.md` | Text input |
| `input_image` | `guides/nodes/input_image.md` | Image input |
| `input_audio` | `guides/nodes/input_audio.md` | Audio input |
| `input_video` | `guides/nodes/input_video.md` | Video input |
| `input_file` | `guides/nodes/input_file.md` | File input |
| `asset` | `guides/nodes/asset.md` | Asset node (bound to the asset library · its content entries are the ports) |
| `proc_text` | `guides/nodes/proc_text.md` | Text processing |
| `proc_image` | `guides/nodes/proc_image.md` | Image generation / processing |
| `save` | `guides/nodes/save.md` | Save (the single entry point for save nodes) |
| `save_text` | `guides/nodes/save_text.md` | Save · text |
| `save_image` | `guides/nodes/save_image.md` | Save · image |
| `split` | `guides/nodes/split.md` | Split a batch |
| `merge` | `guides/nodes/merge.md` | Merge |
| `global` | `guides/nodes/global.md` | Global node (a broadcast source with inputs only) |
| `task` | `guides/nodes/task.md` | Task node |
| `super` | `guides/nodes/super.md` | Super node |
| `agent_task` | `guides/nodes/agent_task.md` | Agent task node |
| `execute` | `guides/nodes/execute.md` | Execute node (launches a local program) |
| `control` | `guides/nodes/control.md` | Control node |
| `ctrl-start` | `guides/nodes/ctrl-start.md` | Task start |
| `ctrl-end-ok` | `guides/nodes/ctrl-end-ok.md` | Success end |
| `ctrl-end-fail` | `guides/nodes/ctrl-end-fail.md` | Fail end |
| `judge` | `guides/nodes/judge.md` | Judge (two outputs, YES / NO) |
| `wait_file` | `guides/nodes/wait_file.md` | Wait file (only lets through once the file exists) |
| `timer` | `guides/nodes/timer.md` | Timer |
| `delayer` | `guides/nodes/delayer.md` | Delay |
| `sequencer` | `guides/nodes/sequencer.md` | Sequencer |
| `gate` | `guides/nodes/gate.md` | Gate |
| `splitter` | `guides/nodes/splitter.md` | Splitter |
| `counter` | `guides/nodes/counter.md` | Counter |
| `mutex` | `guides/nodes/mutex.md` | Mutex |
| `net_recv` | `guides/nodes/net_recv.md` | Network receive |
| `net_send` | `guides/nodes/net_send.md` | Network send |
| `music_gen` | `guides/nodes/music_gen.md` | Music generation (Minimax Music 3) |
| `tts_gen` | `guides/nodes/tts_gen.md` | Speech generation (SoVITS) |
| `video_gen` | `guides/nodes/video_gen.md` | Video generation (Minimax H3) |
| `remotion` | `guides/nodes/remotion.md` | Remotion video |
| `db_table` | `guides/nodes/db_table.md` | Table node |
| `db_replica` | `guides/nodes/db_replica.md` | Database replica |

The same folder also holds `function.md` and `tool.md` (function node / tool node) plus a `README.md` for maintainers; the `ids` array in `index.json` registers the 39 above. Tool nodes and function nodes describe their own ports through their parameter table, see [Tool & function nodes](#tools-functions).

> 💡 Tip: node guides are indexed by **node type** — with two nodes of the same type on the canvas, both open the same guide; they differ only in their own parameters and prompts.

### 4. Control nodes: read the guide first, then come back to the manual

The "button semantics" of the timer, delay, sequencer, gate, splitter, counter, mutex, judge and wait-file nodes are easy to misread from their names — especially **the timer's ▶ arms the alarm** rather than running immediately. Read the node guide first to pin down a single node's ports and buttons, then come back to this manual's [Control flow & judges](#control-flow) section to chain them together.

### 5. When no guide exists

If a node type **has no guide file**, the dialog says so directly (naming that id in the body) and **does not affect the canvas** — the node can still be dragged, wired and run as usual. If you hit this, report the id to the developer.

## Result

- You can open any node's own manual in one step, without leafing through the whole manual.
- Questions about port numbers, button semantics and failure causes are all answered in the node guide.
- When you need to chain nodes together, go back to the matching section of this manual (control flow, batch, media, and so on) and keep reading.

## Common mistakes

| Symptom | Cause | Fix |
| --- | --- | --- |
| No "Node guide" on the right-click menu, or it opens and says not found | You clicked empty canvas, or that type has no guide file yet | Make sure you clicked on the node body itself; when a guide really is missing the node still works, so report the id shown in the dialog to the developer |
| The guide is in Chinese and you want English | Guides follow the UI language | Switch to EN with the globe button in the top bar; falling back to Chinese when the English translation is missing is normal |
| A save node's guide id is not `save_text` | The guide id for save nodes is always `save` | To read the per-type notes, look at the `save_text.md` / `save_image.md` files |
| The guide a control node opens is not what you expected | Control nodes split ids by **role** | The start reads `ctrl-start`, the success / fail ends read `ctrl-end-ok` / `ctrl-end-fail`, and everything else reads `control` |
| Using this manual to look up port numbers | The manual covers global usage | Port numbers follow that node's own node guide |
| The buttons in the guide do not match the UI | Version difference | Trust the UI, and report the difference to the author |
| You want "how to use the whole app" | Node guides only cover that one kind of node | Open this manual with **Docs** in the top bar (see [Where things are](#ui-tour)) |

## Next

- [Control flow & judges](#control-flow)
- [Nodes, wires, @ refs](#nodes-wires)
- [Input / process / save](#io-proc)
- [Network & launch](#media-net)
- [Glossary](#glossary)
