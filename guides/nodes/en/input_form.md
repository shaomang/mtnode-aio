# Form node

Right-click an empty spot on the canvas → "Input nodes" → "Form node". A structured JSON: define the fields first, then fill them in or drop media in.

## Ports
- **In**: fixed 1, titled "Quote" — upstream content is copied into the form and the wire is removed right away (a one-time quote; if upstream has no value yet the wire stays until it does)
- **Out**: fixed 1 = the whole JSON text (structure + values + media paths / descriptions / tags / annotations), ready for a text port or the "params" port

## Settings
- No ⚙ settings window: field definitions, templates, per-row editing and JSON live in the full panel (double-click an empty spot on the board, or click the expand icon in the header); the panel stays open — only ✕ / Esc closes it.

## Usage
- The board is a wall of cards: click a card to edit in place; empty fields still get a placeholder card. A missing required value shows a red dot but never blocks a run.
- Field types: single-line / multi-line text, number, select, multi-select, switch, image, video, audio, any file, date-time, and list (one card per row, plus "+ Add row" at the end).
- Media cards are drop zones: images are copied into workflow assets, while video / audio / any file keep their absolute path; dropping appends and never de-duplicates.
- Every media item can carry a description and tags; images take boxed **annotations** (coordinates normalized to 0–1), videos take time-point / range notes; only the describe button calls the vision model, never a background run.
- With 9 or more visible fields a "search fields / file names" box appears; the three header icons are collapse all / expand (full canvas) / reload.
- 5 built-in templates: material list / character sheet / shot list / product gallery / general parameter table; "Save as my template" stores the structure only.

## Notes
- The first time it opens, only the first 3 groups are expanded (folded once; afterwards your state is kept). Folding only changes display, never values.
- An incoming quote is copied once: after the wire is gone, later upstream changes do not touch the copy — wire it again for a fresh copy.
- Data lands in `<working directory>/mtnode-forms/<form name>-<last 4 chars of node id>.json` on every edit; after editing that file by hand, click reload and the newer copy wins; an invalid structure is rejected whole.
- An `@` reference gives a compact summary plus the absolute path of that `.json`, so long forms do not blow up the context.
