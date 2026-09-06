# Workflows & workshop

## Local workflows

Toolbar **New / switch / rename / delete**. The default workflow id is `default`; a fresh empty one is only created when you delete **every** canvas — deleting another canvas never touches it. Edits auto-save within a few hundred ms; the last session restores on startup.

Additionally, every 5 minutes each workflow is snapshotted into a separate `save-backups/` folder in the app data directory (unchanged content is skipped; the latest 72 copies per workflow are kept). Settings → **Canvas backup** opens that folder to recover an older version.

## Switching tabs: you land where you left off

Switching canvas back and forth with the tab bar keeps **each canvas's own view**:

- **Whatever layer you were drilling into comes back**: working inside a super / tool node's sub-canvas, or inside a task's inner graph, then hopping to another canvas and switching back — you are still in that layer (the breadcrumb and *← Back* keep working). You are no longer thrown back to the root canvas to dig through the shell again. Brand-new or imported canvases always start at the root.
- **Pan and zoom are remembered per canvas too**: coming back, the camera sits where you left it instead of inheriting the other canvas's offsets.
- **This memory lives in the session only** — it is never written to disk, so after a restart you start at the root canvas. The camera changes every frame; persisting it would turn panning into disk I/O.
- **If that layer got deleted while you were away**, the app steps back layer by layer to the nearest parent that still exists, and only falls back to the root canvas when nothing is left — it never parks you on a vanished level showing a blank canvas.

## Deleting a canvas: this one only

Deleting a canvas affects **that canvas and nothing else** — other canvases, including the default one, stay untouched.

- **The target is locked the moment the dialog opens**: it shows the canvas **name, id and node count**, so check them before clicking *Confirm delete*. If you switch canvases while the dialog is open, or an agent is writing to a canvas in the background, the deletion is **blocked on the spot** and you have to start it again — it never silently becomes "delete whatever is open right now".
- **Where you land afterwards**: the tab that followed the deleted one in the tab bar; if no tab is left, the most recently touched canvas.
- **Soft delete into a trash folder, no physical delete**: the canvas JSON and its image assets are moved as a whole to `%APPDATA%\pipeline-console\trash\<timestamp>__<canvas id>\` (containing `<canvas id>.json` plus `assets\`). After an accidental delete, put that JSON back into the data directory's `save\` and its `assets\` back into `assets\<canvas id>\`, then restart the app to get it back — a one-click restore button is not part of this build.
- **Agent deletions need confirming too**: the confirmation dialog spells out name, id and node count. A restricted-scope session can only delete the canvas it is bound to; the global scope must name the canvas explicitly (it never defaults to "delete the current one"). The main process additionally re-checks id + name against the file on disk and **refuses outright** on any mismatch, showing you the reason verbatim.

> To reclaim disk space, empty the `trash\` folder yourself — the app never clears it on its own.

## Import / export

- **Export**: `.mtnodes` pack (nodes, wires, prompts, image assets) or Base64 (small text canvases).
- **Import**: from file or pasted Base64. Shared templates that reference missing providers prompt a batch replace.

## Creative Workshop

Browse / search public templates and download. Upload requires an account; you can manage title, preview, description, and tags.
