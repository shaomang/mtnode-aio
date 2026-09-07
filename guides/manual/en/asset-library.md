# Asset library & asset nodes

The **asset library** is a content vault on your machine that is **shared across canvases**: pack the text, images, audio and video you keep reusing into **assets**, filed under **categories**, and reference them from an **asset node** on the canvas. The content lives in the library folder — it **belongs to no canvas**: delete a canvas or a node and the assets stay. Conversely, change an item in the library and every canvas referencing it follows on the next read.

Entry point: the **Asset library** button in the top bar (the layered-tray icon next to the tool library).

## First run: choose the root folder

The first time you open it, you are asked to **pick a folder as the library root (project folder)**.

- Changing it afterwards is **not recommended**: a new root **triggers a rescan**, and assets missing from the new folder show up on canvas as “asset out of reach”.
- You still can: the dialog header has **Change root…** (with a confirmation that spells out the consequences). **Nothing in the old folder is deleted** — switch back and everything is recognised again.
- Until a root is set the library does not open; nodes say so and reconnect automatically once you pick one.

## Two panes

| Area | What it holds |
|---|---|
| **Left = folders** | The category tree under the root — **names and asset counts only, no icons**. **＋ New folder** creates a category where you are; right-click a category for **New subfolder / Rename / Delete / Open in file manager**. Categories nest arbitrarily deep |
| **Right = assets** | Cards for the selected category: **display name · item count · type summary (e.g. “text 2 · image 1”) · description**, then **Settings / Insert into canvas / Delete**; right-click a card for **Move to category…** and **Rename (folder)** |
| **Toolbar** | **New asset** (an empty one) · **Upload as new asset** (pick a local folder; files become content items by type) · **Reload** (rescan the folders) |

The right pane is **empty by default** — assets are things you create or upload; a scan only recognises folders that carry the marker file.

You may also **tidy the vault in your file manager**: move asset folders between categories, rename categories — just keep `.mtnode-asset.json` (don’t delete or rename it) and hit **Reload** back in the app.

## The asset node: one content item = one pair of ports

Three ways to get one:

1. **Insert into canvas** on an asset card (arrives already bound);
2. right-click an empty canvas → **Input nodes** → **Asset node (binds the library · content items are the ports)** (an unbound shell);
3. drag a wire from another node’s output port into empty canvas space and pick the asset node in the drop menu, then bind it.

An unbound node offers:

- **Bind…** — opens the library (same two-pane UI in picker mode) so you can attach an asset that is **already in the library**.
- **Upload…** — pick a local folder → it is taken into the library as a **new asset** → bound automatically. Unsupported file types are skipped and reported.

Every content item maps to **one pair of ports** (same title, same number): wiring into the left port writes that item, the right port outputs it. Types must match — a text port accepts text sources, an image port image sources. Port details, rejection messages and troubleshooting are in the **Asset node** entry under [Node guides](#node-guide).

Once an output port is wired into a downstream processing node, that content automatically joins the node's **background information** (the block title is the content item title — the same name as the port). Typing `@<asset node title>` in a prompt pulls in **every** content item that asset feeds into the node: image ports arrive as reference images, audio / video ports as their `file:///` address. Several items wired separately from the same asset node each get injected on their own — they never overwrite one another.

## Sync and undo: writing to the library is safe

- The library item **is still empty** → running this step **writes it into the library automatically** (a toast reports how many, and it is undoable).
- The item **already has content** → **⟳ lights up** only when what is wired in **differs** from the library copy, and **one click** replaces it. Running a workflow never silently overwrites material you kept.
- **Ctrl+Z rolls the library back too**: before every overwrite the previous copy is parked in that asset’s `.versions` folder (5 most recent per item); undo pastes it back, redo restores the new one.

## Settings: you are editing the library copy

Click **⚙** on the node (or **Settings** on a card) to open **Asset settings**: edit the **display name** and **description**; add items with **＋ Text / ＋ Image / ＋ Audio / ＋ Video** — **text takes uploads too**: in ＋ Text pick **Upload local text files… (multi-select)** and each file becomes one content item, or **Write an empty body by hand…** to open the form (its **Upload file…** button reads a local file into the body box). Per row change the **port name** (= port label), reorder with the **⠿ drag handle** or **▲▼** (= port order), **Edit text / Upload file / Replace file**, or **✕ delete the item**.

Renaming and reordering **never cut your wires** — they travel with the item. Deleting an item removes that port pair and drops the wires attached to it; **Ctrl+Z restores node and wires together**.

## Deletion and recovery

- Deleting an asset, a category or a content item moves the real files into **`<root>/.trash/<timestamp>__<name>`** — **nothing is physically deleted**; recover them by hand in your file manager.
- A **category that still holds assets cannot be deleted** (subcategories counted too): move them out first.
- After an asset is deleted, nodes on canvas do not vanish — they become “asset out of reach” and come back when you restore the folder or **rebind**.

## Related

- Ports and buttons per node kind: [Node guides](#node-guide) → Asset node
- How this differs from plain input nodes (canvas-owned vs library-owned content): [Input / process / save](#io-proc)
- Wiring and type checks: [Nodes and wires](#nodes-wires)
- On-disk format and internal contract (for developers): `docs/asset-library.md`
