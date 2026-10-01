# Text input

![diagram](img/input_text.svg)

Edit text on the node, or enable batch for multiple entries. Output is data for process / save nodes.

## Ports
- **In**: usually none (may inherit read-only)
- **Out**: text

## Common uses
- **Batch**: multiple texts; downstream can run per entry or aggregate them
- **Drop a file / import YAML** to fill entries quickly

## Markdown editor (the ✎ button in the node header)

The small button row in the node header carries a **✎** (next to 📄 file reference): it opens a
**near-full-screen writing window** so you can write the body much like you would in Word/WPS.
The plain text box on the node body stays as it is — small tweaks do not need the big window.

- **Only for text nodes you can write**: nodes whose content comes from an upstream wire
  (read-only inheritance), or read-only text nodes produced by **Split**, do not offer this button.
- **WYSIWYG + source view**: the body renders as typeset text (headings, lists, tables, formulas),
  and the **Source** tab switches to the raw Markdown; pasting always inserts plain text, so foreign
  HTML never sneaks into your body.
- **Square-icon toolbar**: H1 / H2 / H3, paragraph, bold, italic, strikethrough, quote, bullet /
  numbered lists, task list, horizontal rule, link, inline code, code block, image, table,
  inline / display formula, plus undo and redo. Tables and formulas open a small input dialog;
  images are covered below.
- **Window**: drag the bottom-right corner to resize (minimum width ≥ half the screen); the
  **⤢ / ⤡** button in the header expands to full screen / restores. Clicking outside never closes it,
  so a half-finished edit cannot be lost; finish with ✕, Esc or **Save**.
- **Saving**: **Save** (or Ctrl+S) writes the current version back to the node body, refreshes the
  canvas and clears downstream intermediate results — re-run downstream and it picks up your text.
  Closing with unsaved changes asks first; nothing is dropped silently.

### How images are stored

You can insert an image three ways: the toolbar's **🖼** (pick a local file or paste a screenshot from
the clipboard), **drag** an image file into the body, or copy an image and press **Ctrl+V**. The image is
**copied into `assets/` under the canvas working directory** and referenced from the text by a relative
path (`assets/<file>`), so the document keeps its images when the folder moves to another machine.

If the canvas has no working directory yet, inserting an image first opens the "set a working directory"
dialog — pick a folder and insert again (the editor never writes machine-absolute paths, which would break
as soon as the document moves).

### Annotations + "Ask AI to revise from annotations"

Besides writing, this window is a **revision workbench** (the same mechanism and the same record as the
**✎ AI Review** of text-processing nodes):

- **Full-text annotation**: use "+ Full-text annotation" in the toolbar or the right-hand column.
- **Local annotation**: turn on **Local annotation** in the toolbar, then **drag-select a passage** —
  a note card floats out on the right; write it and press **Attach**. Add as many as you like. After the
  text changes, anchors re-attach to the nearest match; if a passage is gone for good the note is marked
  "may be stale".
- **Ask AI to revise from annotations**: as soon as the first annotation exists, the highlighted
  **✨ Ask AI to revise from annotations (N)** button appears in the header. It sends **the current full
  text + every annotation so far** to the provider and model configured on that node, and produces a
  **new version**; the annotations are cleared and you can annotate the next round (earlier annotations
  still accumulate in later revisions). Provider / model resolution matches **✎ AI Review**: if the node
  has no provider selected, any usable text provider is used.
- **Every version is kept in full**: the version tabs along the top read 1, 2, 3… with the last one
  marked **Latest** (only the latest is editable). Click an older version to **review** it (with the
  annotations bound to it); to make it current again, click **↩ Roll back to this version** — that version
  becomes the current editable one and the later ones are **discarded but still viewable**, so no history
  is ever destroyed.
- **The record travels with the node**: annotations and the version chain live on the node
  (`node.review`) and are saved with the canvas; they are **shared with ✎ AI Review**, so both entry
  points always show one and the same history.
- On a given node, the **Markdown editor and ✎ AI Review can only be open one at a time**: if one is open,
  the other entry point asks you to close it first.
