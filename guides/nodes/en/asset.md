# Asset node (binds the asset library · content items are the ports)

The canvas door to the **asset library**: it binds one asset and turns each of its content items into a pair of ports — wire into the left port to offer content for write-back, read the right port to get that content. The node stores only the binding, never the content, so editing edits the library copy and deleting the node or canvas never loses library files.

## Ports
- **In**: one input port per content item (input *i* ↔ output *i*); the port label is the item title, each input port holds one wire, and the type must match (a text port takes text sources only). Wiring in **never writes the library**.
- **Out**: the same number of output ports — text gives a string, image / audio / video give that file's `file:///` URL.
- No control port: it takes no ▶ control wire and joins no batch / aggregate. While a library item cannot be read the port behaves as "no input" instead of guessing a stale value.

## Settings
- Edit them in the **Asset settings** dialog opened by **⚙ Settings** in the node header (or **Settings** on a library card); **Display name / Description**: affects this library asset only.
- **＋ Text / ＋ Image / ＋ Audio / ＋ Video**: pick local files (multi-select) and copy them into the library, one item per file.
- Each row: ⠿ drag to reorder · ▲▼ one step · port name · type · `⇄n` port number · library file name · replace file · ✕ delete (that port pair disappears, its wires are cut, Ctrl+Z restores it, the file goes to `<root>/.trash`).
- A text item is always stored as `.txt` (an `.md` / `.yaml` source only supplies the body); one text file is capped at **16 MB**.

## Usage
- Right-click an empty canvas → **Input nodes → Asset node**; or top-bar **Asset library** → **Insert into canvas** on a card.
- A freshly created, unbound node offers three entry points: **Bind…** (pick an asset already in the library), **Upload…** (take a local folder into the library and bind it), **Open asset library**.
- Editing text: **the library is written when the field loses focus**.
- To write wired-in content back: click **Overwrite** on that item and confirm the second prompt — running the step never writes it for you.

## Notes
- Write-back has exactly two entry points: edit in place (committed on blur) and **Overwrite** + confirm. Before each write the previous copy goes to that asset's `.versions` (5 most recent per item), and **Ctrl+Z** rolls the library file back too.
- Missing in the library (deleted, or the root folder changed) = **asset out of reach**: ports and wires stay as they were — use **Rebind…**, or restore the folder and hit **Rescan**. The app never deletes the node on its own.
- `@` + the **content item title** pulls in **that one item**; the asset node title itself is not an `@` candidate and unwired items cannot be referenced. Wired items are written into the **background information** under that item title.
- Agent sessions cannot read or write the library yet; the library dialog has no search box and no cross-category dragging (use right-click **Move to category…**).
