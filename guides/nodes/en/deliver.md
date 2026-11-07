# Deliverable node (deliver)

The human landing spot that a **long-running task** leaves on the main canvas: the machine is done, but the next step needs a person to hand something in. Only an enabled long-running task creates it (with a fixed **uid** and a bound folder); the node list, context menu, wire drop targets and global search have no palette entry for it.

## Ports
- **In**: **every file still to be delivered is one input port**, labelled with that file's name (e.g. `storyboard.md`). Once a file is delivered its port disappears and the rest close the gap; existing wires follow their file item, never drifting onto a neighbour. Text / choice entries take no port.
- **Out**: none.

## Settings
- There is no ⚙ settings window — the checklist is edited on the node itself:
  - The body is a Markdown table (file name / what goes in it / required or optional / format or size / delivery status); **▤ Preview Markdown** above it opens the whole checklist in the in-app previewer.
  - **＋ Add file** adds entries and every port row can be deleted. After you edit, the canvas wins: the system only appends new entries and never overwrites your list with the graph's old one; changes are written back to the graph definition and `交付清单.md`.

## Usage
- Two ways to deliver, either is fine: wire an upstream node (file / image / video / audio / save) into the matching port (whatever really has a file is marked delivered automatically and copied into the delivery folder), or press **⬆ Upload** on a port and pick that file.
- When everything is in, press **Confirm delivery complete** on the strip card to continue — collected is not released.

## Notes
- A name mismatch or a format / size mismatch is only flagged in red, never blocked (use **Revoke** and re-upload); **Revoke** only clears the delivered mark and never deletes files in the delivery folder.
- You can release with required items missing: the confirmation window lists what is missing and offers a delivery note (may be empty, recorded as "（未填说明）"); the record lands in `manifest.json` → `releases` and the "未交付说明" section of `交付清单.md`, and later agent steps read it.
- The delivery folder is fixed at `<canvas workspace>\mtnode-deliverables\<uid>\` (`manifest.json` + `交付清单.md`); if the workspace is unavailable it falls back to `%APPDATA%\pipeline-console\longtask\deliver\<uid>\`. **Do not edit the uid** — downstream steps would stop finding the delivery.
- You may delete it (the next run of that step rebuilds it under the same uid and folder), but it **cannot be copied**; re-running a step is a new round with every port back. Deleting a task or run never deletes delivery folders.
