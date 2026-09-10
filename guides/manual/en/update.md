# Updates

> In one sentence: when a new version appears, one click runs a delta download, a silent install and an automatic restart — no installer wizard anywhere in the path.

![Update](img/mtnode-app-03-ui.svg)
*Figure 1: once a new version is found, a highlighted **Update** button appears in the top bar and the other buttons shift left to make room.*

## Goal

MTNode has in-app updates built in (based on electron-updater plus NSIS blockmap **delta downloads**). When a new version is found, a highlighted **Update** button appears in the top-right corner of the top bar; clicking it runs the whole chain — **download → silent install → automatic restart** — with no need to run an installer by hand and no installer wizard popping up.

The version number is also shown in the top-bar subtitle and in the author popup, so you can check at any time which build you are running.

## Before you start

- Your network can reach the update source (by default `http://mt-agent.com/mtnode/updates`; the environment variable `MTNODE_UPDATE_URL` can override it).
- You are not on the **Microsoft Store (MSIX)** build — a store package's install directory is read-only, which shuts in-app self-update out entirely (the status reports `supported:false`). On the store build, update through the store.
- The app **does not quit** while downloading, so you can keep working; but the process does exit briefly during the install step, so save what you are doing first.

## Steps

### 1. Spot the highlighted **Update**

The app checks for updates in the background. When a new version is found, a highlighted **Update** button appears in the top bar; at that point the **Language** button stays at the far right, while **Approvals / Plugins / Docs** **shift left** to free up the space.

The tooltip on the **Update** button is exactly "Update available — click to download"（发现新版本，点击下载更新）.

### 2. Confirm and start the delta download

Click **Update** and a confirmation appears:

- The title is **Update available**（发现新版本）and the body reads "Update available: v… — download the update?"（发现新版本 v…，是否下载更新？）;
- The details explain what will happen: a **delta download of the update package (only the changed parts)**, and you can keep using the app while it downloads; when the download finishes it installs silently in the background and reopens the app automatically once done. The current version number is included;
- The buttons are **Download** (开始下载) / **Cancel** (取消).

"Delta" means **only the changed blocks are pulled**, so the package is usually far smaller than the full installer.

### 3. Let it download

The app stays usable while downloading, so you can carry on working on the canvas. **Do not** keep clicking **Update** during this time — repeated clicks do not speed anything up.

### 4. Choose "Install & restart" or "Later"

When the download completes, **Update ready** (更新已就绪) appears:

> The update package has been downloaded (v…). The install runs silently in the background (no installer wizard) and the app reopens automatically once it is done. If you choose "Later", it installs the next time you quit the app. Current version: v…

- **Install & restart** (立即安装并重启): the process exits briefly → silent NSIS install → the new version is launched automatically.
- **Later** (稍后): it installs the next time you quit the app.

> 💡 Tip: on Windows a running exe locks the install directory, so the process has to exit briefly before the install can overwrite it — from the user's point of view this looks like "silent install in the background, then it reopens by itself", so the screen flashing once mid-way is normal.

### 5. Retry when a download fails

If the download fails, check the network first and then **click Update once more** to go through step 2 again. The update state resets and you can start from zero.

### 6. (Developer note) Where the version number comes from

The **single source of truth** for the version number is the `version` file in the project root (`x.y.z`) together with the `version` field in `package.json`. **Do not edit either by hand**; always use:

```
node version.js              read the current version, sync it to package.json and print the version number
node version.js bump         add 1 to the last digit (e.g. 1.2.11 → 1.2.12), write it back to the version file, sync package.json and print the new version number
node version.js bump-major   add 1 to the middle digit and reset the last to 0 (e.g. 1.2.11 → 1.3.0) for a major release; same as npm run version:major
```

A real release is produced by a single `npm run release`, which emits both the NSIS installer and the Store (MSIX) package, and **the two packages must carry the same version number**.

## Result

- The app reopens automatically on the new version, and the version number in the top-bar subtitle has been updated.
- No installer wizard appeared during the update, and you were never asked to pick an install path.
- If you chose "Later", the update package is already in place and installs the next time you quit the app.

## Common mistakes

| Symptom | Cause | Fix |
| --- | --- | --- |
| No **Update** button in the top bar | You are already on the latest version, or you are on the Store (MSIX) build | On the store build, update through the store — in-app self-update does not apply to it |
| The button will not respond / the progress stalls | The network is unstable, or the update source is unreachable | Check the network and click Update again; if needed, confirm the update source address is reachable |
| The download fails | The connection dropped, a proxy blocked it, or the update source is temporarily unavailable | Switch networks / turn the proxy off and click Update once more |
| The app did not reopen after the install | The process did not exit completely, or the system blocked the automatic relaunch | Start the app manually; if the version number is the new one, the install succeeded |
| Approvals / Plugins / Docs moved | They shift left to make room once the Update button appears | Expected; they return to place once the update is done |
| Editing `version` or `package.json` by hand scrambled the version | The version number has a single source of truth, so a manual edit desynchronises the two | Re-sync with `node version.js`, and use `bump` to increment |
| You want to confirm the current version | The version number is visible in two places | Check the top-bar subtitle, or open the author popup |

## Next

- [Troubleshooting](#troubleshoot)
- [Settings](#settings)
- [Account & sign-in](#account)
- [FAQ](#faq)
