# PDF Export

Typesets the upstream **text / Markdown** into a PDF file on disk. Entry point: right-click the canvas → in the "Processing nodes" group **hover** **Text generation** to expand the submenu → **PDF Export** (same hover-expanded submenu as "Text processing (LLM)", opened the same way as "Video generation / Audio generation"). Its colour matches the **Save** node (same save family).

It is not a "save as txt": the text is laid out as Markdown (heading levels, justified paragraphs, lists, quotes, tables with repeating headers across pages, wrapped code blocks, auto-fitted images), and formulas are drawn as **typeset math** by the same in-app renderer (`renderer/math-render.js`, offline-bundled KaTeX with a built-in subset fallback) — what you see in the canvas preview is what the PDF shows.

## Accepted input
- **Wire a text source**: text node / text processing (LLM) / agent task / asset text items / function output — anything that outputs text.
- Several text inputs may be wired at once: they are concatenated into one PDF with a horizontal rule between them.
- Images / audio / video are not accepted (only the plain "Save" node infers media type from its input).

## Formulas
`$…$`, `$$…$$`, `\(…\)` and `\[…\]` all render; fractions, roots, sub/superscripts, Greek letters, big operators, matrices, cases/aligned, accents (`\hat \bar \vec \overline`), `\substack`, `\xrightarrow` are supported. Dollar signs inside fenced code blocks and inline code stay literal.

## When it runs
**Wiring it up does not generate anything — you must click ▶ on the node.** (A control node triggering it counts as an explicit run too.) Neither wiring nor upstream updates auto-export: that is what sets PDF export apart from the other save nodes (it has no "auto save" switch).

## Settings (node header ⚙)
- **Save path**: relative to the workspace or absolute; the extension is forced to `.pdf`. **Leave it empty to name the file after the *input* node's title** (e.g. upstream "Text node 2" → `Text node 2.pdf`). The **file name** box on the card edits it too; clearing it restores that default naming.
- **PDF layout**
  - **Page size**: A4 (default) / A3 / A5 / Letter / Legal
  - **Landscape**: better for wide tables and wide formulas
  - **Margins**: none / narrow / normal (default) / wide
  - **Body font size**: small / medium (default) / large
  - **Page numbers**: centred "page / total" footer
  - **Document title**: empty adds nothing; otherwise a centred title line is placed on top
- The summary line shows "resolved path · layout"; the **Browse / Reveal / Open** buttons work as usual — **Open** hands the file to the system default PDF reader.
- A small **PDF icon button sits in the node header (above the card)** (a sheet with a folded corner and the letters "PDF", no "Open" text): it opens the generated PDF with the system default reader; before generation it only reminds you to press ▶.
- **Unselected (preview / browse form) shows no preview image at all**: the preview area lists just one line with the file name (a hint line before generation), and the open action is that header button.
- **Selected (edit form)** the card body is a PDF icon button filling the area (file name underneath); clicking it opens the file with the system default app.

## Batch
- **Batch**: one PDF per item, named like the save node (`file_itemTitle.pdf`).
- **Aggregate**: all items merged into one PDF, each item title as a sub-heading (`## Title`).

## Ports
- **Input**: text (multiple allowed); images / audio / video are not accepted.
- **Output**: one data port = **the path of the PDF just written to disk** (like the plain **Save** node, which now also has a content output port: a text save yields the saved body, an image / audio / video save yields the last written file, PDF export yields the path). Wire it to downstream nodes, or reference it with `@Title` in a prompt; before the first run it falls back to the upstream input.
  - It is only a receipt for the saved result, not a control port: wiring it or not does not change "press ▶ to generate".
  - How it differs from the built-in **Markdown to PDF** tool (top-bar tool library, `markdown-to-pdf`, which the Agent can call directly): both turn upstream text into a PDF on disk; the node outputs a single **save path** and its layout is adjustable under ⚙, while the tool outputs **file path + byte count** and always uses a fixed layout (A4 · normal margins · medium font · page numbers).

## Implementation
Layout lives in the main process (`pdf-write.js`: hidden window + `printToPDF`), page template `renderer/pdf-print.html` + `renderer/css/pdf-print.css`, formulas reuse `renderer/math-render.js` (same source as review/preview); the renderer-side run path is `savePdfOnce` in `renderer/app-nodes.js`. Data never lands in the app folder.
