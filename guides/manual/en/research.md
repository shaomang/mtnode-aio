# Research: notes, graph & slides

When reading papers, writing a thesis, or digging into a complex topic, notes and PDFs quickly scatter everywhere. The **Research** view brings them together in one workspace where everything is saved as plain Markdown inside your project folder — easy to open externally, back up, or take with you.

![Research workflow from materials to graph and slides](img/mtnode-research-flow.svg)

## 1. Feed your topic materials

First make sure the current canvas has a **workspace folder** (Research stores everything neatly in `research/`).

Open **Research** on the top bar and click **Initialize research**:

1. **Topic & core question**: Enter a topic title (that's all you need to start; you can add materials anytime).
2. **Core files (left)**: Drop in drafts you're working on (Markdown, Word, LaTeX, PPT, or text) and mark one as the primary manuscript if you have several.
3. **References (right)**: Drop in PDFs, click **＋ Text / Link** to paste URLs, arXiv IDs, DOIs, or excerpts, or click **＋ Query** to have AI fetch the top 5 matching papers. Add an optional focus note on any item (e.g., "Focus on Section 4 experiments").

Click **Start processing** to copy files safely (originals stay untouched), convert them to clean Markdown, build reading variants, and extract first-layer terms. Later, when you add new material, click **Process additions** — already processed items are skipped so you never waste tokens re-running old files.

## 2. Read, annotate & write notes

- **Clean reading + split editing**: Notes open in crisp rendered view (with math and diagrams rendered live). Click **Edit** for side-by-side source and preview, then **Done** when finished.
- **3-Pass reading variants**: Right-click a paper (or click **＋ Variant**) to generate three side-by-side companions — **Skim** (contributions, evidence, limits), **Key concepts** (plain intuition), and **Technical details** (methods, equations, setup).
- **Layered folds & section detail**: Toggle references between Full text, Key quotes, and Themes, or adjust any individual section between One-liner, Paragraph, and Original.
- **Highlight to annotate or ask AI**: Select any sentence or equation to add a note, ask AI in place (and save the answer back into your note), or promote it to a tracked **Claim**.
- **On-demand term pages**: Hover or click a term/equation to see its definition and every note that mentions it. Click **Expand** on a term page only when you want AI to branch out deeper related terms.

## 3. Knowledge graph & literature library

- **Automatic graph**: Link notes with `[[Note Title]]`, cite papers with `[@citekey]`, and mark claims/questions/notes. Open **Graph** to explore force, layered, radial, or timeline layouts, filter by verification status, focus on neighborhoods, or `Ctrl + click` two nodes to trace the shortest path between them.
- **Literature library**: Open **Literature** on the top bar to import BibTeX, add by DOI, search by title, or extract full text from local PDFs. Clicking an un-downloaded citation lets you ask AI to fetch and ingest the full paper (it never downloads papers online without your confirmation).

## 4. Turn research into slides or video

Click **Slides** on the top bar to compile your topic, manuscript, 3-Pass readings, top terms, equations, and references into a presentation:

- Pick **Static deck**, **Video**, or **Both**, choose from 6 light/dark themes, and optionally note your audience or target length.
- Refine slide order, layout, footer elements, and theme in the 3-pane slide editor — or click the star icon to let AI tighten speaker phrasing (strictly grounded in your notes, never inventing facts) with full undo.
- Present full-screen, export a self-contained offline HTML deck (printable to PDF), or render an `.mp4` presentation video via the Remotion plugin.
