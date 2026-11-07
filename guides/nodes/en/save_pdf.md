# PDF Export

Typesets the upstream **text / Markdown** into a PDF on disk: heading levels, lists, tables, code blocks and images are laid out, and formulas are drawn as real typeset math. Entry point: right-click the canvas → in the "Processing nodes" group **hover** **Text generation** to expand the submenu → **PDF Export**.

## Ports
- **In**: text; several text inputs may be wired at once (concatenated into one PDF with a horizontal rule between them). Images / audio / video are not accepted.
- **Out**: 1 data port = **the path of the PDF just written**; before the first run it falls back to the upstream input. It is only a receipt for the saved result — wiring it or not does not change "press ▶ to generate".

## Settings
- Edit them in the **settings window** opened by **⚙ Settings** in the node header:
  - **Save path**: relative to the workspace or absolute; the extension is forced to `.pdf` (auto-corrected). Leave it empty to name the file after the **input** node's title (upstream "Text node 2" → `Text node 2.pdf`). The card's **File name** box edits it too; clearing it restores that default naming.
  - **PDF layout**: **Page size** A4 (default) / A3 / A5 / Letter / Legal; **Landscape** (better for wide tables and formulas, off by default); **Page margin** none / narrow / normal (default) / wide; **Body font size** small / medium (default) / large; **Show page numbers** (centred "page / total" footer, on by default); **Document title** (empty adds nothing, otherwise a centred title line on top).

## Usage
- Wire a text source (text node / text processing (LLM) / agent task / asset text items / function output) → adjust the layout if needed → press ▶.
- The small **PDF icon button** in the node header opens the generated PDF with the system default reader; before generation it only reminds you to press ▶.

## Notes
- **Wiring it up does not generate anything** and there is no "auto save" switch: neither wiring nor upstream updates export anything, only ▶ (or a control node triggering it) does.
- Formulas support `$…$`, `$$…$$`, `\(…\)` and `\[…\]` with the same renderer as the canvas preview; dollar signs inside fenced code blocks and inline code stay literal.
- **Batch**: one PDF per item, named `file_itemTitle.pdf`; **Aggregate**: all items in one PDF with each item title as a sub-heading (`## Title`).
- The built-in **Markdown to PDF** tool shares the same layout engine but returns **file path + byte count** and always uses a fixed layout (A4 · normal margins · medium font · page numbers).
