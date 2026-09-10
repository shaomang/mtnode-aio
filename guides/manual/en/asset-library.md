# Asset library

> In one sentence: file the text / images / audio / video you use often into one asset library shared across canvases, then feed it to any canvas with an asset node.

![Asset library](img/mtnode-share-01-ui.svg)
*Figure 1: the library's two panes (left = categories, right = asset cards), plus an asset node on the canvas bound to that asset.*

## Goal

The **asset library** is a **content vault on this machine that is shared across canvases**: pack the text, images, audio and video you reuse into **assets** filed under **categories**, and reference them on a canvas with an **asset node**.

The content lives under the asset library root and **belongs to no canvas** — delete a canvas or delete a node and the assets are still there; conversely, edit content in the library and every canvas referencing it follows on the next read.

Entry point: **Asset library (素材库)** in the top bar (the layered-tray icon next to the tool library). To sort out how asset nodes divide work with input nodes, start with [Input / process / save](#io-proc).

## Before you start

- MTNode is installed and running (see [Your first flow](#first-run)).
- Have a **project folder** ready to hold the asset library; the library lands under it and is maintained by the app from then on.
- A canvas does **not** need a workspace to use an asset node — the library root and the workspace are two different things (see [Workspace & archives](#workspace)).

## Steps

### 1. Set the asset library root

The first time you click **Asset library** it asks you to **pick a folder as the asset library root (project folder)**. Until a root is set the library does not open, and the node says "no location set yet"; once you pick one it reconnects automatically.

This folder **should not be changed afterwards**: switching the root **triggers a rescan**, and assets that are missing from the new folder show up on canvas as "asset out of reach" (素材失联). You can still change it — the dialog header has **Change root… (更改根目录…)** (it asks for confirmation and spells out the consequences) — and **nothing in the old folder is deleted**; switch back and everything is recognised again.

### 2. Manage categories and assets in the two panes

| Where | What it holds |
|---|---|
| **Left = folders** | The folder levels under the library root — **names and asset counts only**. **＋ New folder** creates a category where you are; right-click a category for **New subfolder / Rename / Delete / Open in file manager**. Categories nest without limit |
| **Right = assets** | Cards for the current category: **display name · item count · type summary (e.g. "text 2 · image 1") · description**, then **Settings / Insert into canvas / Delete**; right-click a card for **Move to category…** and **Rename** |
| **Toolbar** | **New asset** (creates an empty one) · **Upload as new asset** (pick a local folder; files become content items by type) · **Reload** (rescans the folder) |

The right pane is **empty by default** — assets are things you create or upload by hand; a scan only recognises **folders that carry the marker file** (`.mtnode-asset.json`).

You can also **tidy this library straight from your file manager**: move asset folders between categories, rename categories — that is all fine (just don't delete or change the marker file) — then hit **Reload** back in the app.

### 3. Drop an asset node on the canvas

Three ways to create one:

1. Click **Insert into canvas** on a library card (it arrives already bound);
2. right-click empty canvas → **Input nodes** → **Asset node (binds the library · content items are the ports)** (this creates an unbound shell);
3. drag a wire from another node's output port into empty canvas space and pick **Asset node** in the drop menu, then bind it.

An unbound node has two entry points, and these are the **two routes for uploading local files**:

- **Bind… (绑定…)**: opens the library (the same two-pane UI, switched to picker mode) so you can attach an asset that is **already in the library** — the library is right there, no need to upload it again.
- **Upload… (上传…)**: pick a local folder → the whole thing is taken into the library as a **new asset** → bound automatically. File types the library does not accept are skipped, and it tells you how many were skipped.

### 4. Wire by "one content item = one pair of ports"

**Every content item maps to one pair of ports** (same title, same number): the left port wired in writes that item back, the right port outputs it. Types must match — a text port takes text sources only, an image port image sources only, an audio / video port media sources only.

What an output value is depends on the content type:

- **Text → string**: downstream gets the body itself, ready to concatenate, rewrite and feed to a model.
- **Image → local absolute path**: when it becomes a reference image it is counted as "image N" in dispatch order.
- **Audio / video → `file:///` URL**: it can go into a media reference port and can also be picked up by `@`.

Once an output port is wired into a downstream processing node, that content automatically joins that node's **background information** (the block title is the content item's title, the same name as the port); typing `@Asset node title` in a prompt pulls this asset into **every** content item of that node. When several content items from the same asset node are wired separately, each is injected on its own — they never displace one another.

### 5. Keep the write-back step safe and controllable

- The library item **is still empty** → running up to this step **writes it into the library automatically** (a toast reports how many were synced, and it is undoable).
- The item **already has content** → **⟳ lights up** only when what is wired in **differs** from the library copy, and **one click** replaces it. Running a workflow never silently overwrites material you have collected.
- **Ctrl+Z rolls the library back too**: before every overwrite, the copy being replaced goes into that asset's `.versions` folder (the 5 most recent per item); **undo** pastes the old content back, redo pastes the new one again.

### 6. Rename, reorder and delete

Click **⚙** on the node header (or **Settings** on a library card) to open **Asset settings**: edit the **display name** and **description**; add content items with **＋ Text / ＋ Image / ＋ Audio / ＋ Video** — **text can be uploaded too** (in ＋ Text choose **Upload local text files… (multi-select)**, one file per content item; to touch one up choose **Write an empty body by hand…**, and the **Upload file…** button in that form reads the file into the box).

Each row lets you change the **port name** (= port title), reorder with the **⠿ drag handle** or **▲▼** (= port order), **Edit text / Upload file / Replace file**, and **✕ delete the item**.

Renaming and reordering **never drop your wires** (a wire follows its content item); deleting an item removes that port pair and disconnects the wires attached to it — **Ctrl+Z restores it**.

Deleting an asset / a category / a content item puts the actual files into **`<root>/.trash/<timestamp>__<name>`** — **nothing is really deleted**; recover them by hand in your file manager when you need them. **A non-empty category cannot be deleted directly** (assets inside subcategories count too): move the assets to another category first.

## Result

- The library holds asset folders with marker files, the asset node on the canvas is bound, and ports appear in pairs — one pair per content item.
- Library content is decoupled from canvases: **deleting a canvas loses no assets**, and changing library content takes effect for every referencing canvas on its next read.
- Exporting `.mtnodes` **does not include the asset library**: the canvas bundle carries only the canvas's own assets such as images; the library is independent of the canvas and always stays in its local root folder. To move to another machine, take the library root folder with you, or **rebind** on the new machine.

## Common mistakes

| What you see | Why | What to do |
| --- | --- | --- |
| The node says the asset is **out of reach (失联)** | The library root moved, or the asset folder was deleted / renamed, so the library can no longer find it | Put the asset folder back under the root and click **Reload**; or use **Rebind library… (重新绑定素材库…)** on the node and pick another asset (wires are kept by title) |
| The library will not open | No root folder has been chosen yet | Pick a folder as the asset library root the first time it opens |
| Upload reports "skipped N files" | The library does not accept that file type | Keep only the supported text / image / audio / video in the folder you upload, and store the rest elsewhere |
| A port will not accept the wire | The content type does not match the port type (for example an image wired into a text port) | Wire it to the port with the same name and type, or change that content item to the matching type in settings |
| The library copy did not change after a run | A library item that already has content is never silently overwritten | Click the **⟳** that lights up on the item to replace it by hand; or delete that library item first |
| A category will not delete | A non-empty category cannot be deleted directly | Move its subcategories / assets to another category first, then delete it |
| "The asset library is rolling back, please wait before undoing / redoing" | The previous undo is still writing back to the library | Wait until the message disappears, then press `Ctrl+Z` / `Ctrl+Y` |
| Library content was overwritten and you want it back | The replaced copy went into `.versions/` | Press **Ctrl+Z** to roll the library back with everything else; beyond the 5 most recent copies, recover it by hand in your file manager |

## Next

- [Input / process / save](#io-proc)
- [Node guide index](#node-guide)
- [Nodes, wires, @ refs](#nodes-wires)
- [Workspace & archives](#workspace)
- [Undo & rollback](#rollback)
