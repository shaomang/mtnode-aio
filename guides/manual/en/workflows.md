# Save, import/export, workshop

> In one sentence: workflows save themselves, come back when you switch, delete safely, export out, and you can also grab templates from the Creative Workshop.

![Saving and restoring](img/mtnode-start-04-state.svg)
*Figure 1: where a canvas lands on disk and how it is restored at startup.*

## Goal

After this page you can manage several local workflows, understand the fallback of auto-save and snapshots, delete a canvas without worry, export a canvas to a file or migrate it between machines, and take templates from the Creative Workshop.

## Before you start

- A canvas that already runs — see [Input / process / save](#io-proc).
- Uploading a template needs you to be signed in — see [Account & sign-in](#account).
- To find older backup versions you need to know Settings → "Canvas backup".

## Steps

### 1. Manage local workflows

1. **Four actions in the top bar**: **New / switch / rename / delete**.
2. **Know the default canvas**: the default workflow id is `default`; a fresh empty default canvas is created only when you **delete every** canvas, and deleting any other canvas never touches it.
3. **No manual saving**: edits **auto-save within a few hundred milliseconds**, and the next startup **restores the last state**.
4. **Snapshots as a fallback**: every 5 minutes each workflow's current state is snapshotted automatically into a separate `save-backups/` folder in the data directory (unchanged content is not stored again), and **the most recent 72 copies per workflow are kept**; Settings → "Canvas backup" opens that folder directly so you can recover an older version.

### 2. Switching tabs: back to the piece you were working on

When you switch canvas from the top bar's tab strip (or the canvas dropdown), **each canvas remembers where it was**:

- **Whatever layer you drilled into comes back**: if you were working inside a super node's / tool node's sub-canvas, or inside some task's inner graph, hopping away and back still leaves you in that layer (the breadcrumb and "← Back" keep working), instead of being thrown back to the root canvas to drill in again. A brand-new or imported canvas always starts at the root canvas.
- **Pan and zoom are stored per canvas too**: coming back to a canvas, the camera sits at the position and zoom it had when you left, and is not dragged off by another canvas.
- **This memory lives only for the current run** (it is not written to disk): after restarting the app you start at the root canvas.
- **If that layer was deleted by an agent while you were away**, the app automatically **steps back layer by layer to a parent that still exists**, and only falls back to the root canvas when nothing is left — it never parks you on a level that no longer exists.

### 3. Deleting a canvas: only this one

1. **The target is locked the moment the dialog opens**: the confirmation box shows this canvas's **name, id and node count**, so check them before clicking "Confirm delete".
2. **Anything unusual is caught on the spot**: if you switched canvas while the dialog was open, or an agent is writing to a canvas in the background, this deletion is blocked and you have to start it again — it will never quietly turn into deleting "whichever canvas happens to be open right now".
3. **Where you land after deleting**: the app switches automatically to the tab that followed it in the tab strip; if there is no usable tab, it goes to the most recently touched canvas.
4. **Soft delete into the recycle folder, not a physical delete**: the canvas JSON and its image assets are moved as a whole into `%APPDATA%\pipeline-console\trash\<timestamp>__<canvas id>\` (containing `<canvas id>.json` and `assets\`).
5. **How to recover an accidental delete**: put `<canvas id>.json` back into the data directory's `save\` and `assets\` back into `assets\<canvas id>\`, then restart the app; this build does **not yet offer a one-click restore** button.
6. **An agent asking to delete needs the same confirmation**: the box spells out name, id and node count; a restricted-scope session can only delete the canvas it is bound to, while the global scope must name explicitly which canvas to delete.

> ⚠️ Danger: to reclaim disk space you have to empty the `trash\` folder **yourself** — the app never deletes what is in it, and once cleared those canvases are gone for good.

### 4. Import / export and moving between machines

1. **Export**: package as `.mtnodes` (containing nodes, wires, prompts and **image assets**), or copy Base64 (handy for small text-only canvases).
2. **Import**: restore from a file or by pasting Base64; if someone else's template references providers you do not have, you are guided through a **batch replace**.
3. **Moving between machines**: within the same app, `.mtnodes` is the easiest way to move a single canvas; to move a whole machine, just move the `%APPDATA%\pipeline-console` data directory.

![Import and export](img/mtnode-share-02-flow.svg)
*Figure 2: export .mtnodes → import it elsewhere → nodes and wires are restored.*

![Export and import, animated](img/mtnode-share-02-demo.svg)
*Figure 3: export .mtnodes → import on a new canvas → nodes and wires are restored (a 3–8 s looping animation; on a slow network or in a degraded mode it falls back to the static image `img/mtnode-share-02-demo-static.svg`).*

### 5. Take a template from the Creative Workshop

1. **Open it**: "Creative Workshop" in the top bar.
2. **Browse / search / download** public templates; after downloading they land on this machine through the import flow.
3. **Uploading requires an account**; once signed in you can manage the title, preview image, description and tags.

![Creative Workshop](img/mtnode-share-03-ui.svg)
*Figure 4: browsing, downloading and upload management in the Creative Workshop.*

## Result

- Close the app and open it again and you are back on the canvas you were on, at the layer you had drilled into.
- There is a snapshot you can trace back to every 5 minutes, keeping at most 72 copies.
- An accidentally deleted canvas can be recovered by hand from `trash\`; an exported file can be handed to someone else or moved to another machine.

## Common mistakes

| Symptom | Cause | Fix |
| --- | --- | --- |
| Switching back does not land on the layer you were on | The view memory only lasts for the current run, so a restart starts at the root canvas | Drill back in by hand after a restart; if that layer was deleted the app steps back to a parent that still exists |
| You clicked "Confirm delete" but nothing was deleted | The canvas was switched, or something was writing in the background, so this attempt was blocked | Go back to the target canvas and start the deletion again |
| The canvas you just deleted cannot be found | It was soft-deleted into `trash\` | Put `<canvas id>.json` back into `save\` and `assets\` back into `assets\<canvas id>\`, then restart the app |
| After importing a template many nodes report an invalid provider | The template references a provider / model that does not exist on this machine | Replace them in bulk with your own providers, following the prompts |
| The backup folder cannot be found | The entry point is not obvious | Settings → "Canvas backup" opens `save-backups/` directly |
| Many canvases were deleted but the disk did not shrink | Deletion is only a soft delete inside the app; `trash\` must be emptied by hand | Empty the `trash\` folder yourself (once cleared it cannot be recovered) |

## Next

- [Workspace & archives](#workspace)
- [Asset library](#asset-library)
- [Undo & rollback](#rollback)
- [Settings](#settings)
- [How this manual is built](#manual-notes)
