# Asset node (binds the asset library · content items are the ports)

An **asset** is one folder in the **asset library** — a bundle of text / image / audio / video content kept on this machine, outside of any canvas. On the canvas, **one content item = one pair of ports**: wire into the left port to write that item, read the right port to get it.

Content lives in the library, the node only holds the *binding* — so **editing content edits the library copy** (every canvas referencing it follows), and **deleting the canvas or the node never loses the content**. Wiring a wire into a port **never writes the library by itself**: to write back, click **Overwrite** on the item and confirm the second prompt (below).

Create: right-click an empty canvas → **Input nodes** → **Asset node (binds the library · content items are the ports)**; or open the top-bar **Asset library** and click **Insert into canvas** on an asset card.

## Three states

| State | When | What the node offers |
|-------|------|----------------------|
| **Not bound** | a freshly created shell | “Bind…” reference an asset already in the library · “Upload…” take a local folder into the library and bind it · “Open asset library” |
| **Bound** | bound and found in the library | browse each item, edit in place, click **Overwrite** to write it back, ⚙ settings |
| **Asset out of reach** | the asset was deleted in the library, or the **library root folder changed** | ports and wires are **kept exactly as they were** (nothing cleared, no wire renumbering): “Rebind…”, “Rescan”, “Open asset library”. Restore the folder or switch the root back and it reconnects |

**The app never deletes your node on its own** — “out of reach” only pauses display and reads/writes.

## Ports: content items are the ports

- Item 1 = input port 1 = output port 1. **The port label is the item title**; renaming the item in the settings renames the port.
- The item **order** is the port order (⠿ drag handle / ▲▼ one step). Wires travel with the item — they never drift onto a different item.
- Each item’s input port holds **one** data wire, and the type must match: **a text port accepts text sources only, an image port image sources only** (same for audio / video). A wrong drop names the port, its content type and where to fix it.
- **No control port**: an asset node is a pure content source — it takes no ▶ control wire and does not take part in batch / split / merge. Point ▶ at nodes that actually run.
- While the library copy can’t be read (unbound / out of reach / file missing) the port behaves as “no input” instead of guessing a stale value.

### What each type outputs

| Content type | Output value | Plugs straight into |
|---|---|---|
| Text | a string | Text process, agent task, Save (text) |
| Image | the file’s `file:///` URL | Image generation (reference image), Save (image) |
| Audio | the file’s `file:///` URL | Music generation, SoVITS reference audio, Save (audio) |
| Video | the file’s `file:///` URL | Video generation reference, Save (video) |

A downstream node receives whatever is wired in as a **connected input** (the same mechanism an input node uses).

## Browsing and editing content

The body lists items **in order, one row each** (title + type chip + content view) and **scrolls** when there are more than fit:

- **Text**: edit in place — typing stays in memory, **the library is written when the field loses focus** (the library is shared app-wide, so it must not hit disk on every keystroke). Don’t want to type? “**Choose / Replace text**” below the field imports a local `.txt` / `.md` / `.json` … file — its body replaces this item (the previous copy goes to the versions folder).
- **Image**: thumbnail + size info, click for a large preview; “Choose / Replace image” picks a local file and **copies it into the library**.
- **Audio / video**: inline player (same as the input nodes); “Choose / Replace …” copies into the library too.
- A text item is **always stored as `.txt`** in the library: the source being `.md` / `.yaml` only supplies the body, the extension never drifts. One text file is capped at **16 MB** (undo moves the whole body in and out of memory).
- Every row has “Show in folder” to jump straight to the physical file.
- No items yet: the “Settings…” button in the body opens the dialog where you add some.

## Overwrite: wiring in never writes the library

Wire some node’s output into an item’s **input port** and all it does is tell the app *what content this port now carries*. Both cases are a **hint only** — nothing is written automatically:

1. The library item **has no content yet** → that item’s **Overwrite** button lights up (there is something that could be written here); **running the step does not write it**, the library item stays empty until you click **Overwrite** and confirm.
2. The item **already has content** that **differs** from what’s wired in → the **Overwrite** button lights up (byte-wise comparison in the main process).

Once lit, click **Overwrite** on the item → a second confirmation appears (naming the item, noting the previous copy goes to history and Ctrl+Z undoes it) → only then is the library written. **Cancelling changes nothing** — no write, no undo entry.

In other words: **a wire never touches the library copy**. Writing back has exactly two entry points — edit in place (committed on blur), or click **Overwrite** and confirm. One accidental run can’t wipe a picture you kept for weeks.

“Same or not” is decided **byte-wise in the main process**, never by path — the canvas copy and the library copy always have different paths.

## Undo rolls the library back too

The library is real files outside the canvas, so undo does not stop at the canvas:

- Before every overwrite, the previous copy is moved into that asset’s `.versions/` folder (only the **5 most recent** per item).
- `Ctrl+Z` restores the canvas **and pastes the previous file back into the library**; `Ctrl+Y` pastes the new version back. The toast says “asset library rolled back (n item(s))”.
- If an item can’t be rolled back (file locked, …) the toast says **the previous copy is still in that asset’s `.versions` folder**, so you can restore it by hand.
- Pure canvas actions (moving nodes, rewiring, edits that never wrote to the library) carry no library ledger and never touch the files.

## Settings (they are the library copy’s settings)

Click **⚙** in the node header (or right-click → Settings) to open **Asset settings**:

- **Display name / Description**: written on blur (the description is for humans only and never affects ports).
- **＋ Text**: two equal paths — **Upload local text files… (multi-select)** imports `.txt` / `.md` / `.json` … files straight into the library (one item per file), or **Write an empty body by hand…** opens the form (that form has its own **Upload file…** button: the body is read into the box and you can still edit it before confirming). **＋ Image / ＋ Audio / ＋ Video**: pick local files (multi-select) and they are **copied into `items/`**, one item per file.
- Each row: ⠿ drag handle (drop anywhere) · ▲▼ · **port name** · type chip · `⇄n` current port number · library file name (click to reveal; red when missing) · Edit text / **Upload file** / Replace file · ✕ delete.
- **✕ Deleting an item** removes that port pair and cuts the wires on it (**Ctrl+Z restores node and wires together**); the physical file goes to `<root>/.trash/`.
- When other canvases bind the same asset, edits land in the library and each canvas follows on its next refresh / rescan.

## How it relates to the library

- Top-bar **Asset library**: categories on the left (= folders; “＋ New folder”, right-click to rename / delete / open in Explorer), asset cards on the right (**Settings · Insert into canvas · Delete · right-click Move to category**), toolbar **New asset · Upload as new asset · Reload**, and the root folder shown in the header with **Change root…**.
- The first time you use it you must **pick the asset-library root (project folder)**. Changing it afterwards is not recommended: a new root **triggers a rescan**, assets missing from the new folder become “out of reach” nodes that need a manual rebind (nothing in the old folder is deleted — switch back and they are recognised again).
- Nothing is ever really deleted: categories, assets and content files move into `<root>/.trash/` and can be restored in Explorer. **A category deletes whether or not it is empty**: right-clicking it removes the whole folder (subcategories, assets and any files you dropped in go to the recycle bin together), and the confirmation first counts the assets, content items and subcategories inside — nodes referencing them become “asset out of reach”, with nodes and wires kept.
- An asset is simply a folder carrying the `.mtnode-asset.json` marker — you may tidy categories in Explorer directly (just keep the marker file, don’t rename it).

## Referencing asset content in a prompt

- Once a **content port is wired** into a processing node (text LLM / image generation / agent task), that content is written into the node's **background information** automatically, and the block title is the **content item title** — exactly the name shown on the port.
- The same asset node may feed several content items into the same processing node; **each one gets its own block** (you do not lose everything but the first).
- To name it explicitly: type `@` + the **asset node title** — that pulls in **every** content port the asset feeds into this node, and the `@` candidate list does list asset nodes.
- Image ports go in as **reference images** (an `@` renders as “reference image #N”); audio / video ports go in as their `file:///` address text.
- Precondition: the library item must be **readable** (unbound / out-of-reach asset / empty item → nothing to inject). `@Tag` and aggregate mode read asset content the same way.

## How it differs from other nodes

- Versus the **input nodes** (text / image / audio / video): an input node’s content belongs to **this canvas** (delete the canvas, it is gone); an asset node’s content belongs to the **library** (shared across canvases, it survives them).
- Versus **tool / function nodes**: there the ports come from a **parameter table**; here they come from **content items**. Same rule both ways — port name = entry name, port order = entry order.

## Not in this round

- Agent sessions **cannot read or write the library yet** and there is no asset-related gateway tool; assets are managed from the library dialog or an asset node. That lands next round.
- The library dialog has **no search box** and no cross-category dragging (use right-click → **Move to category…**).

## Troubleshooting

| Symptom | What to do |
|---|---|
| “The asset library has no save location yet” | Top bar **Asset library** → follow the prompt and pick a root folder |
| Node shows **asset out of reach** | The asset was deleted in the library or the root changed: restore the folder / switch back and hit **Rescan**, or **Rebind…** to another asset |
| **Overwrite never lights up** | What is wired in is byte-identical to the library copy, or that port has no wire right now. An empty library item does **not** auto-sync — as soon as the port carries content that differs from the library, **Overwrite** lights up |
| A connection is refused (“accepts only ×× sources”) | Port type ≠ source type: connect a source of the same kind, or swap in a matching content item in Settings |
| `@` in a processing node does not offer the asset | The `@` list only shows **connected** sources: wire a content port of that asset into the node first (or feed it into a global node with global references on) |
| The content is missing from 【背景信息】 | The library item is not readable yet: the node shows “asset out of reach”, the item is empty, or the text you are typing has not been committed (leave the field, or click **Overwrite** and confirm) |
| Undo did not restore the library file | That write could not park its previous copy in `.versions` (file locked, …); fetch it from that asset’s `.versions` folder by hand |

## Related reading

- Manual page: [Asset library & asset nodes](#asset-library)
- Design doc (on-disk format, IPC contract, invariants): `docs/asset-library.md`
