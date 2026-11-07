# Artifact node (ltart)

The **artifact drop point** a long-running task leaves on the canvas: one node per artifact. Only an enabled long-running task creates it — when each step finishes it takes stock of what that run produced, puts the key files you should read or keep on the canvas (title like `Artifact · Text · pilot.md`) and places them inside **that step's node-layer shell** (if the shell has been deleted it falls back to the main canvas layer).

## Ports
- **In**: none.
- **Out**: none. It is something to look at, not a pipeline stage.

## Settings
- There is no ⚙ settings window; the actions are the buttons in the node header:
  - **✎**: text artifacts open in the in-app editable reader — **Edit & save** writes straight back to the artifact file, and the size and excerpt refresh right after.
  - **⇢**: opens the artifact with the system default app.
  - **📁**: **Open its folder** — reveals and selects the artifact in the file manager.

## Usage
- Read it when the step ends: images show a thumbnail (click for the lightbox, save-as included), text / Markdown / tables show an excerpt, other types show the path plus an open action.
- Drag, rename or delete it freely; the next time the task reaches the same step and the same artifact it **reuses the same node** (identity = task + step + file path), so re-runs do not pile up duplicates.

## Notes
- Only key files are placed: reports and documents, data tables, finished images. Video and audio, logs and configs, intermediates, sources / scripts / archives / databases are not — those files stay in the working folder and in the output node's file list.
- At most 32 per publish; deliverable items you confirmed by hand are still all placed.
- Inputs handed down from earlier steps are never placed again.
- It cannot be copied or created manually (it is on the long-task locked list); delete one and the next run of that step brings it back.
