# Workspace & archives

> In one sentence: get straight what a relative path is relative to, where canvases are stored, and why user data is never written inside the application folder.

![Workspace](img/mtnode-edit-03-state.svg)
*Figure 1: the workspace field in the top bar decides where every relative path on this canvas lands; archives, backups and logs all land in the local data directory.*

## Goal

This page answers three concrete questions:

1. **Relative to what** — the **workspace** the top bar assigns to the current canvas.
2. **Where things live** — `save/` and `save-backups/` under the local data directory (on Windows, by default `%APPDATA%\pipeline-console\`).
3. **Why it cannot live in the application folder** — an upgrade or uninstall takes it away or overwrites it, so the app blocks it outright and runs a startup audit.

The workspace is also the default root that agent nodes read and write files under, so it is closely tied to [Agent tasks & sessions](#agent-nodes) and [Save, import/export, workshop](#workflows).

## Before you start

- Have an **existing** folder ready to serve as the workspace (creating a canvas insists on one, and the path must really exist).
- If you intend to change the data directory, stop any running agent task first — the change needs an app restart.
- No administrator rights are needed; the workspace can be any folder your user can write to.

## Steps

### 1. Set a workspace for the current canvas

The top bar has a **Workspace** field with a browse button next to it. Just enter a folder path.

Once it takes effect:

- The **relative paths of agent nodes and save nodes** on this canvas all resolve against that folder;
- **Changing the folder relocates every write at once** — if a save node uses a relative path, switching workspace moves the whole set with it;
- If you **leave it empty**, each node uses its own setting, or the app's default data directory.

> 💡 Tip: the rule for save paths is "an absolute path is used as-is; a relative path resolves against the top-bar workspace". With a workspace set, new save nodes default to a relative path, which makes a later switch easy. An absolute path that happens to fall inside the workspace is stored as a relative path automatically, so it follows the workspace too.

**An invalid path is cleared automatically, with a notice**, so the assistant never writes to the wrong place: "Invalid workspace — that path does not exist or is not a valid folder, so it has been cleared. Please choose a valid workspace again."

### 2. Set it while creating a canvas

The **New canvas** dialog has a **Workspace (required)** field, with the note: "A new canvas must have a workspace. Agent nodes and relative save paths resolve against it, and a missing folder makes reads and writes fail."

Leaving it empty is blocked outright ("Please choose a workspace"), and a path that does not exist or is not a folder is rejected too ("The workspace does not exist or is not a valid folder").

### 3. A super node's subfolder is spliced into the middle

A super node can set a **subfolder** (relative to the workspace). The relative paths of the nodes inside it land under:

```
<workspace> / <subfolder> / …
```

Nested super nodes **concatenate the subfolders along the ancestor chain**. When you pack existing nodes into a super node, or change the subfolder, existing relative paths get the **prefix added**; **absolute paths stay unchanged**. See [Super nodes](#super-nodes).

### 4. Find where the archive lives

Workflow JSON lives under `save/` in the local data directory — on Windows usually:

```
%APPDATA%\pipeline-console\save\
```

The settings dialog has **Open archive location**, which opens it in File Explorer with one click.

### 5. Recover an older version from canvas backups

Canvases also get an automatic backup **every 5 minutes**: each workflow's latest state is **copied read-only** into a sibling `save-backups/` folder. Unchanged content is not stored again, and **each workflow keeps its 72 most recent copies** (about 6 hours).

Settings → **Canvas backup** has **Open backup folder**. If you delete something by accident or break a canvas, you can recover it by hand from there; the details and the undo route are in [Undo & rollback](#rollback).

### 6. Remember the red line: "no data in the application folder"

The data directory, the fact library, the asset library, `save` and logs — all user data — may only be written into `%APPDATA%` (by default `%APPDATA%\pipeline-console`, changeable in settings) or into **a project folder you picked**.

If a resolved path is **equal to or inside** `app.getAppPath()` / the folder next to the exe, it is **rejected** outright — because an upgrade or uninstall takes the application folder away or overwrites it. At startup, `auditAppDirData()` in `main.js` runs a **read-only** audit:

- On a hit it writes a log and pops up a warning listing "which data landed inside the application directory", and tells you to move those into a project folder and restart;
- In development mode (unpackaged) it only prints the conclusion once, with no dialog.

> ⚠️ Danger: do not point the fact library or asset library root inside MTNode's installation directory just to keep things "tidy". After an upgrade that data disappears along with the app.

### 7. Privacy stance

**No workflow is uploaded by default.** Prompts and inputs go to **the provider you configured yourself** only while you run a node; a workshop upload is a template you explicitly choose. Credentials such as API keys live only in the local data directory.

## Result

- The workspace field in the top bar is the root of every relative path on the current canvas, and each node's output lands where you expect it.
- Archives are in `save/`, backups in `save-backups/`, and settings opens either one with a single click.
- The startup audit reports no warnings, which means no user data sits inside the application folder.

## Common mistakes

| Symptom | Cause | Fix |
| --- | --- | --- |
| "A relative path needs a workspace (top bar) first, or use an absolute path" | A save node uses a relative path but the canvas has no workspace | Enter an existing folder in the top bar, or switch that node to an absolute path |
| The workspace was cleared automatically | The path does not exist or is not a valid folder | Pick a folder that really exists (creating a canvas validates this too) |
| Save paths inside a super node ended up at the canvas root | The super node has no **subfolder** set | Give the super node a subfolder; the relative paths inside then hang off that prefix |
| I changed the workspace but old outputs did not move | That node writes an absolute path, or the files are already on disk | Absolute paths do not follow the workspace; move them by hand, or switch to a relative path and re-run |
| A dialog at startup says "Data is stored inside the application folder" | Some data (fact library / asset library / save, and so on) points under the app directory | Move each path the dialog lists into a project folder, then restart the app |
| I changed "Configure data directory" in settings but nothing happened | That change needs a restart | Restart the app as prompted; if the data directory is set by the `MTNODE_DATA_DIR` environment variable, it cannot be changed in settings |
| The backup folder is empty | Five minutes have not passed yet, or the content never changed | Wait for one automatic backup; skipping unchanged content is normal |
| Cannot find an older archive | Backups keep only the 72 most recent copies | Look in `save-backups/` by timestamp; older versions cannot be recovered |

## Next

- [Undo & rollback](#rollback)
- [Save, import/export, workshop](#workflows)
- [Super nodes](#super-nodes)
- [Settings](#settings)
- [Troubleshooting & diagnostics](#troubleshoot)
