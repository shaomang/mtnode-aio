# Artifact node (ltart)

An **artifact drop point** the long-running task leaves on the canvas: one node per artifact.
You cannot add it by hand — only an enabled long-running task creates it, when **each step finishes
and the engine takes stock of what that run produced**, placing the **key files you should read or
keep** (title looks like `Artifact · Text · pilot.md`) inside **that step's super-node shell** (the
same layer as the output node; if the shell has been deleted it falls back to the main canvas layer).

## What it is for

A long task's results are scattered in the working folder (`output/shots/01.mp4`,
`assets/script/shotlist.md`, …) and digging through it is painful. Artifact nodes put **the key files
this step just produced onto the canvas one by one** — you see them as soon as the step ends, without
waiting for the whole task. Only the few that are worth reading or keeping take up canvas space (see
the next section); intermediates are not spread over it — the canvas is for results, not for process.
They sit to the right of that step's output node, laid out on a free-slot grid so they do not cover
existing nodes.

## How to use it

- **View**: images show a thumbnail (click for the lightbox, save-as included); text / Markdown /
  tables show a short excerpt; other types show the path plus an open action.
- **Edit & save**: text artifacts get one more button in the node head — **✎** — which opens the
  in-app editable reader (the Markdown reader for `.md`, the line view for other text); **saving
  writes straight back to the artifact file**, and the size and excerpt on the node refresh right
  after. Reading the full text happens in that same reader (it renders Markdown itself), so you can
  read and fix a few lines in one step.
- **Open**: the **⇢** button in the node head opens the artifact with the system default app; the
  bottom line is the full path (hover to see all of it).
- **Open its folder**: the **📁** button next to ⇢ reveals the artifact in the file manager (selecting
  the file) — no need to open the file first and then go one level up when you want to browse the rest
  of the artifacts in that folder.
- **Move / delete**: drag and rename freely, or delete it. The next time the task reaches the same
  step and the same artifact, it **reuses the same node** (identity = task + step + file path), so
  re-runs do not pile up duplicates. Delete one and it comes back on the next run of that step.
- **No wires**: it has no input or output ports — it is something to look at, not a pipeline stage.

## Which artifacts get placed

The collection scope is the files **this step wrote itself**, readable at the moment of publishing.
Collection tries three routes and takes whatever hits: paths recorded from this step's file-writing
tools (write / edit) — **including workspace-relative paths**, resolved against the canvas working
directory — paths extracted from the step's state, and, when both come up empty, files changed in the
working directory inside this step's time window. Inputs handed down from earlier steps are not placed
again, so each step does not replay its upstream's images.

After collection there is one more **pick** (the canvas only carries the key files you should read or keep):

- **Placed**: reports and documents (`.md` / `.pdf` / `.txt` / `.html` / `.docx` / `.pptx` /
  subtitles…), data tables (`.csv` / `.xlsx`…), finished images (`.png` / `.jpg` / `.webp`… —
  a thumbnail right on the node).
- **Not placed**: video and audio (nothing you "read" — they would only add a pile of players to the
  canvas), logs and config files, intermediates (shot JSON, extracted frames…), lock files, source /
  scripts / archives / databases / executables.
- Those files are **not lost**: they stay in the working folder and in the output node's file
  reference list, one entry each — look there when you need one.
- At most 32 per publish; deliverable items **you confirmed by hand** are still all placed (you have
  already picked those).

## No type entry for this node?

Correct — like the output and deliverable nodes, it is created only by the long-running task system:
the right-click menu, copy / paste, templates and agent graph building neither create nor copy this
type (it is in the `LT.LOCKED` list). To start using it, expand the thin bar above the canvas, create
and enable a long-running task, and it will appear inside that step's super-node shell once a step
produces artifacts.
