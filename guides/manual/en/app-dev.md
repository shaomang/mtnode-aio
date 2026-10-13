# Building an app

> One-liner: turn a small tool into an MTNode **app** — a static front-end bundle (HTML / JS / CSS) that opens as its own window from the **App Center**.

![App window and host capabilities](img/mtnode-app-01-ui.svg)
*App = static front-end + host capability bridge; models and tools stay in MTNode itself*

## What an app is

An MTNode "app" is plain **static** HTML / JS / CSS (plus icons and static data), with no Node dependency.
The host loads it in its own window and injects a **capability bridge**.

Two host flavours expose different bridge names (the scaffold detects both, so you never branch by hand):

| Host | Bridge | Installed where | Data written where |
| --- | --- | --- | --- |
| **App Center** (top bar "Apps"; self-built or downloaded) | `window.appHost` | App install root `<id>\` (changeable at the top of the Library / Development pages) | `<data dir>\apps-data\<id>\data.json` (changeable in the window) |
| Plugin window (`kind: "window"` card in the Plugins dialog) | `window.pluginApi` (= `window.forumApi`) | `<data dir>\app-plugins\<id>\runtime\` | `<data dir>\app-plugins\<id>\data.json` |

**Do not confuse this with local backend plugins**: music3 / H3 / TTS / llama cards are **local backend plugins** (they also ship a console window and canvas nodes) — a much bigger thing.

### Where it lives, where it runs

**You never have to pick the app root folder**: by default it sits under the **data folder your canvases
use** — downloaded apps in `<data dir>\apps`, apps you develop in `<data dir>\apps-dev`, app data in
`<data dir>\apps-data\<downloaded|dev>\<id>`. The first time a root is really needed (listing apps /
downloading / creating), MTNode writes those two default paths into `config.json`
(`apps.installDir` / `apps.projectDir`); to move them, use **"Folder settings"** behind the gear button (see below).

**Folder settings** (the gear button next to "Back to MTNode", shared by all four pages) gives the library root
and the dev root one row each with two buttons: **"Modify"** (pick a new folder; you are then asked whether to
move the apps in the old folder over — that moves only apps of that kind, skips same-named folders and touches
nothing else) and **"Open"** (show it in File Explorer). Apps that were moved get their canvas dev-node path,
canvas working folder and that app's dev-session workspaces realigned to the new location (paths you typed
yourself that still exist are left alone). **Folder settings covers the two roots**, plus a trailing
**"Preview"** section holding the "remember page state when reloading the preview" switch; everything belonging
to one app (app folder / data folder / capabilities / preview / delete app) lives in the
**⚙ App settings** window on the Development page's preview bar.

| Location | Contents |
| --- | --- |
| App install root `<id>\` | the app's static files (**update / uninstall replaces the whole folder — never write data here**) |
| `<data dir>\apps-data\<id>\data.json` | the app's own data (the **default data root**, written atomically through the bridge) |
| `<data dir>\apps-data\<id>\dataDir.json` | that app's data-folder pointer (only exists if the user changed it; changing it does not move data) |
| `<id>\installed.json` | host-recorded version / entry / source / source author |

## The Library and In-development pages

The App Center has four pages, in left-nav order: **Apps** (cloud catalog), **Library** (installed here, not in
development yet), **In development** (the apps in development on this machine, plus what I published to the cloud —
read `app-publish.md` for the lower block) and **Development** (the three-pane workbench).
**Which page an app shows up on depends only on which root folder it lives in** (not on a flag in `app.json`): apps
under the **download root** (`apps.installDir`) are listed in Library, apps under the **dev root** (`apps.projectDir`)
in In development. When the same id exists in both roots, each page lists its own copy (each with its own folder,
ledger and data folder); the Library card is not annotated and is not linked to the dev copy.

| State | How it is decided | Appears on | How to enter / leave |
| --- | --- | --- | --- |
| Downloaded (not in development) | folder is under the **download root** | Library | click **Copy to the dev folder (secondary development)** in that app's details |
| In development | folder is under the **dev root** | the **read-only list** on the In-development page (click a row to continue on the Development page); the Development page itself is the three-pane workbench (top-left = "＋ New app"; preview bar = 📂 app folder / Launch / Publish / Refresh / App settings / Canvas, folding into "More ▾" when narrow; left column bottom = "＋ New session") | "＋ New app" at the top left, or copy one over from the Library |

**Secondary development = copying a copy into the dev folder** (this round; the `dev` flag in `app.json` is no longer the
criterion, it is only a compatibility fallback):

- only the **app body** is copied (code / `assets` / `app.json` and similar app files): no `storage/` data, no
  `installed.json` ledger, no `<name>.mtnodes` canvas snapshot, no `<name>.zip` source package, no `merge.json`;
- **the copy in the Library folder stays where it is** and stays listed under Library; the two copies never affect each
  other — clicking "Update" in Library does not touch the dev copy;
- the dev copy's `app.json` keeps the **original author and source version** and gets an internal source record
  (`forkOf`): publishing uses it to know the branch point (the version/branch dialog shows "this local copy is based on v<x>");
- when the dev folder **already has the same id**, you are asked which way to go:
  - **Overwrite** = replace the dev copy with the Library copy; the old copy is backed up in full to
    `<data dir>\merge-backups\` first (there is no roll-back button in the UI — go to that folder to get it back);
  - **Merge with AI** = keep this local copy, fetch the other version into the merge staging folder and open a session
    where the Agent compares item by item and only writes after you confirm.
- canvas: if a canvas with the same name (id = app id) already exists it is **reused** — its working folder and the
  existing dev node's `devPath` / `subFolder` are pointed at the new dev folder (no new node); otherwise a new canvas of
  the same name plus a dev node are created;
- when the copy finishes you land on the **Development** page with that app selected.

- One-time backfill (compatibility fallback): apps with no `dev` flag in `app.json` and no `installed.json` ledger on
  this machine get `dev:true`; that only affects the local state flag and how data folders are sorted — which page an app
  appears on always follows the folder it lives in (see above).
- **Author** is shown on cards, in details, on Library rows and on the app rows in the Development page's left column:
  cloud entries use the publishing account, local apps use `app.json`'s `author` (falling back to the signed-in account;
  nothing is shown when signed out).
- **The Development page's left column is the app list**: one row per "in development" app (name / author / session count /
  expand arrow) with that app's own sessions folded underneath (archived sessions are not listed — see the Sessions view).
  Clicking a row enters that app: the preview and the session pane switch together, and coming back to the Development page
  re-selects the app you last opened. The search box matches both app names and session titles; "＋ New session" sits at the
  bottom of the left column (the top bar is gone — creating an app is the button at the top left). When you switch apps the
  preview is covered by a black curtain until the new page has loaded, so it no longer flashes white.
- **A new dev session is the "＋" at the right end of an app row**: one per row; clicking it switches to that app and returns
  to the first-round state — write what you need in the composer at the bottom and press Enter to create a new dev session
  **under that app** and start work (the same as clicking "Develop" on that app's dev node and submitting). One per row, so
  you never have to switch apps first to find the button. The "＋ New session" button at the bottom of the left column is the
  same exit for the current app; it is not shown when there is no app in development.
- **Checksums are tucked away**: long `sha256` strings are no longer spread across the UI — click the small "ⓘ checksum"
  button in the details to see the full value and copy it; app id / author uid / entry / download URL / window size live in a
  collapsed "Developer info ▾" block.
- The `dev` flag in the app folder is **local state**: it is stripped when exporting a zip (anyone installing that package
  gets a normal Library entry).

## Four hard rules

1. **Static only**: HTML / JS / CSS, resources referenced relatively (`./app.js`, `./assets/a.png`). There is no `window.api` in an app window (that is the main window's bridge).
2. **Runs without the host**: the bridge may be absent (opening `index.html` directly in a browser). The app must still start, degrade, and say "not saved" instead of going blank.
3. **Content must land on disk**: persist through the bridge (`appHost.dataWrite` / legacy `dataSet`) — do **not** use `localStorage` as storage and do **not** write into the app folder.
   Auto-save (dirty flag + debounce) plus a forced flush before the window closes is the default, courtesy of the scaffold's `store.js` + `close.js`.
4. **Only call what the host actually has**: probe first (`typeof host.dataWrite === "function"`), never fake success and never silently drop data.

## Minimal structure

```
my-app/
  index.html    entry (app.json's entry, default index.html)
  apphost.js    bridge detection and degradation (scaffold's AppHost)
  store.js      persistence: dirty flag + debounced auto-save + flush()
  close.js      shutdown hooks: AppClose.on(cb), run before the host closes the window
  app.js        your logic
  style.css     styles
  app.json      self-describing metadata (title / version / window size / entry)
  assets/…      icons and static files
```

`app.json` uses the same field names as the cloud catalog entry (`id` / `kind: "window"` / `entry` / `version` / `title` / `subtitle` / `icon` / `window`).
The window geometry and card info that actually apply come from the **cloud catalog entry**; `app.json` exists so a bundle describes itself for local development and pre-release checks.

## What the host gives an app (appHost)

Probe before calling: `typeof host.dataWrite === "function"`, otherwise take the degraded branch. The scaffold wraps this as `window.AppHost.cap`.

| Capability | App Center window (`appHost`) | Plugin window (`pluginApi`) |
| --- | --- | --- |
| Read / write all data | `dataRead()` / `dataWrite(data)` | `dataGet()` / `dataSet(data)` |
| Data folder | `dataDirGet()` / `dataDirPick()` / `dataDirOpen()` / `dataDirReset()` | — |
| Account summary | `account()` | `authGetState()` / `authMe()` / `onAuthChanged(cb)` |
| Store requests | — | `storeRequest({ method, path, json })` (credentials stay in the main process) |
| Image picking / caching | — | `pickImage()` / `compressImage()` / `cacheImage(id, base64)` / `readCachedImage(id)` |
| Text models | `textGenStream(opts, cb)` (text + image multimodal; thinking off by default) · `hostModels()` / `hostModel()` / `hostSetModel(id)` | — |
| **Image generation** | `imageGen(opts, cb?)` (text-to-image, one image per call; `cb` receives progress) · **`imageEdit(opts, cb?)`** (img2img; reference images required) · `imageGenCancel(reqId)` · `hostImageModels()` / `hostImageModel()` / `hostImageSetModel(id)` | — |
| Speech-to-text | `pickAudio()` / `transcribe()` / `transcribeWav(b64)` / `asrStatus()` / `asrPrepare()` / `onSpeechState(cb)` | — |
| Window lifecycle | `close()` / `quit()` / `onWillClose(cb)` | `close()` / `onShown(cb)` |

### Closing properly (every app needs this)

Wire your close button to `AppHost.close()`. The host does **not** destroy the window directly: it first sends `apps:willClose`,
waits for everything registered through `AppClose.on(...)` to finish (up to 1.5 seconds), and only then closes — and quitting MTNode
(`before-quit`) takes the same path. So put "flush pending writes + unsubscribe" inside `AppClose.on`.
`AppHost.quit()` quits MTNode itself and is only for apps that ship their own quit button.

### The data folder (every app needs this)

- Default location: `<data dir>\apps-data\<id>\` — it follows MTNode's data directory, never the app install folder.
- The user can change it **inside the app window** (or from the App Center Library row) to a folder of their own.
  The path can only come from a folder pick **the user performed in the system dialog** — an app cannot pass a path.
- Changing it does **not** move data: the new folder takes effect immediately and files in the old one stay put.
  "Back to default" only removes the pointer; it deletes nothing.
- The host only writes to "the default data root + the folder the user picked", with a fixed file name (`data.json`, legacy `store.json` accepted),
  always atomically (tmp + rename) and capped at 2MB per file.

## Models and images: inherited from MTNode

An app **never sees providers or API keys** (those stay in the main process), but it can pick from what MTNode already
has configured: text models via `hostModels()` / `hostSetModel(id)`, image backends via `hostImageModels()` /
`hostImageSetModel(id)`. Both are **persisted per app id**, and the UI needs a place to choose (the scaffold's Model
dropdown already has a Text models / Image backends split).

```js
// Draw: cloud image provider or the local SenseNova backend, whichever MTNode is configured for
var r = await AppHost.image("a cat wearing a hat", {
  model: M.imageModel(),                    // empty = follow the MTNode default (cloud first, then local)
  images: [refPath],                        // optional reference image (local path or dataURL) -> img2img / edit
  strength: 0.6,                            // optional reference strength 0-1 (local SenseNova only; the cloud warns and ignores it)
  onProgress: function (p) { bar(p.pct); }, // optional: the local backend takes tens of seconds to minutes
});
if (!r.ok) show(AppModel.imageErrorText(r)); else img.src = r.dataUrl;

// Explicit img2img / image edit (reference images required): without one it returns no_ref_image
// and does **not** silently downgrade to text-to-image.
var e = await AppHost.imageEdit("keep the subject, make the background snowy", { images: [refPath], strength: 0.8 });
```

- **img2img / image edit**: `opts.images` (array of local absolute paths or `data:image/…`) — every image is sent.
  A cloud OpenAI-compatible endpoint uses `/images/edits` (multiple images map to "image 1 / image 2…" in the prompt);
  the local SenseNova backend accepts 1-4.
- **Reference strength `strength` (0-1)**: 0 = the reference only acts as a prefix condition (the local backend's
  official default), 1 = strongest. **Only the local SenseNova backend honours it**; the cloud has no such parameter
  and says so in the reply's `warnings` instead of pretending.
- **Read the capability before drawing the UI**: each entry of `hostImageModels()` carries `refImages` /
  `maxRefImages` / `strength` — grey out backends that cannot take reference images and show the limit up front.
- One image per call (same contract as the canvas image node). The local backend **shares a global lock** with music /
  video: when busy it returns `busy_media` — tell the user to wait or retry.
- Cancel with `AppHost.cancelImage(r.reqId)` (`imageEdit` uses the same `reqId` mechanism); a user cancel returns
  `cancelled`, which is **not an error**.
- **No silent downgrade**: `no_provider` when nothing is configured, `bad_model` for an unknown id, `cuda_oom` when
  VRAM runs out, `no_ref_image` when `imageEdit` gets no reference image.
- Need a heavier local capability (own backend process, console window)? Upgrade to a **local backend plugin** (skill `mtnode-plugin-dev`).

## Capabilities (app.json `capabilities`)

`app.json` carries a capability declaration: `{ "textInput": true, "showDictate": true, "imageGen": true }` —
new apps start with **all three on** (you are no longer asked), and you change them in the Develop page's
preview bar → **⚙ App settings** → "App capabilities" (**a click takes effect immediately; that window has no
separate Save button**). It is a **static declaration, not a permission gate**
(the bridge interfaces are always callable):

| Flag | When true | When false / absent (default) |
| --- | --- | --- |
| `textInput` | The scaffold ships the local dictation module (SenseVoice) | The app carries **no** speech-to-text |
| `showDictate` | Shows the host-injected dictate bar (🎤 Dictate / 🎧 Audio → text) at the bottom of the app window — **visible by default**, with a “Hide” button at its end | The host does **not inject** that bar at all (the speech interfaces on the bridge stay callable) |

**Declared true = visible as soon as it is injected** (fixed 2026-02): previously the injected bar stayed
marked hidden, so only the app's own `apSpeechReveal()` could show it — users saw “I ticked show dictate bar
and nothing happened”. Now the “Hide” button / `apSpeechHide()` only hides it **for this window** (nothing is
written back to `app.json`), and the next app-window open shows it again per the declaration; `apSpeechHidden()`
asks for the current state and `apSpeechReveal()` brings it back — all three are idempotent.
| `imageGen` | Declares that this app draws images; templates may ship an image entry | Merely undeclared; interfaces still callable |

**Changing a capability never touches the entry page**: only the declaration in `app.json` is written
(toggling `textInput` also adds / removes `speech.js` / `speech.css` in the app folder), and `index.html`
is left byte-for-byte alone — whatever you (or a dev session) edited in it stays. The dictate bar is
injected by the host from `showDictate` (it applies the next time the app window opens), and the preview
reloads right away. Older versions inlined a dictate script into the entry page; opening "App settings"
now removes that block idempotently (only our own marker, nothing else on the page).

## Building one from scratch

1. Copy the bundled scaffold `templates/app-scaffold/` (`index.html` + `apphost.js` + `app-model.js` + `model.css` +
   `store.js` + `close.js` + `app.js` + `style.css` + `app.json`) into the app's source directory. Copy
   `speech.js` / `speech.css` **only when the app declares `capabilities.textInput`** (by default an app carries no
   speech-to-text).
2. Replace the placeholders: `app.json`'s `id` / `title` / `subtitle` / `icon` / `version` / `window`, plus the titles, copy and icon glyph in `index.html`.
3. Write the real logic in `app.js`; keep data in `Store` (which uses `AppHost.getData` / `setData`) — do **not** use `localStorage` as storage and do not write files into the app folder.
4. A `frame:false` window has no system title bar, so ship your own close button calling `close()` (the scaffold already does, and hangs the flush off the shutdown hook).
5. Publish: zip the app folder (the root is the app folder) → upload → add `zipUrl` + `sha256` + `entry` + `window` to the cloud catalog entry.
6. Verify: install / update → open the window → change something → close and reopen (the content is still there) → change the data folder
   (data follows, the old folder is still there) → opening `index.html` directly in a browser still works (the degraded notice shows) →
   data lands in `<data dir>\apps-data\<id>\data.json`.

## Common mistakes

| Symptom | Cause | Fix |
| --- | --- | --- |
| Blank or fully transparent window | absolute resource paths (`/app.js`), or no background painted (windows are transparent by default) | use relative paths; paint a background and rounded corners on the root container |
| Buttons do not react | the button sits inside the drag region (`-webkit-app-region: drag`) | add `no-drag` (`-webkit-app-region: no-drag`) |
| Window cannot be closed | `frame:false` without a close button | add one calling `AppHost.close()` (legacy `pluginApi.close()`) |
| Data disappears after restart | `localStorage` was used, or a fake success when the host was absent | store through `Store` / `dataWrite`; say "not saved" in the UI when the host is missing |
| The last edit is lost when the window closes | `close()` was called without flushing | register `store.flush()` in `AppClose.on(cb)` (the scaffold's `close.js` does it) |
| Host calls fail from an iframe | the bridge is injected into the top document only | call the host from the top document and `postMessage` the result into the iframe |
| Reading local files fails | an app window has no Node and no file access | upgrade to a local backend plugin when file/directory access is needed |
| 404 on another machine | a drive letter or `..` in a resource path | keep resources inside the app folder and reference them relatively |

## Next

- Want a plugin with a backend / console / canvas nodes: that is a **local backend plugin** (see the built-in skill `mtnode-plugin-dev`), not an app.
- Want AI to finish the app: pick the app in the left column of App Center → Develop and say a sentence in the session pane; or hand the requirement to the global assistant ✦ and say "follow the mtnode-app-dev contract and start from templates/app-scaffold".