# Publish an app to the cloud (versions)

> In one sentence: pack an app you built on this computer and upload it to the cloud so other users can find it
> in the App Center, download it, use it, or build on it — and one app can hold many versions that users pick from.

## Where the entry is

Top bar “Apps” → left nav “Develop” → in the toolbar row, click **Publish** to the right of **Launch**.
It uses the same account allow-list as the Apps entry itself (see `APPS_USER_WHITELIST` in `renderer/app-apps.js`);
if you are not signed in you are asked to sign in first.

## Building on another app (fork)

When you build on someone else's app and publish it, pick the source in **“Builds on which app? (optional)”**:

- It is filled in automatically: a source already declared in your local `app.json`, otherwise “the cloud entry this
  copy was installed from”.
- You can switch it to any catalog entry, or choose “(Original: no source declared)” — **declaring nothing never blocks publishing**.
- The declaration is recorded on the cloud entry (source app id + original author uid) and is visible in the catalog; it is
  also written into the local `app.json` and travels with the package, so later uploads bring it back automatically.
- Effect: other users opening that app see a **“Switch branch”** menu and can install / launch your version or the source
  app's version. Each branch installs into its own id folder, so nothing overwrites anything.

App identity = **app id + author uid**: the same app forked by different authors becomes separate catalog entries (each with
its own id), grouped into “branches of one app” by that declaration.

## Launch the app once before publishing

The publish dialog wants a **screenshot of the app window** by default: “Capture the app window” grabs that app's
own window, so click **Launch** first. If the window is not open (or is minimized) you get a clear message —
nothing opens or captures your desktop behind your back.

You can also “Choose an image” from this computer: up to 8, reorderable, **the first one is the cover**.

## AI draft + human check

- Opening the dialog generates the metadata once (title / description / version / tags); “Generate again” redoes it.
- The AI only sees the app's `app.json` and the visible text of its entry page; the result is a **draft** — check and
  edit it before submitting.
- With no text provider configured you are told so and the fields stay empty for you to fill in — no invented metadata.
- **Version**: the first publish is `1.0.0`; publishing the same app again defaults to “previous minor + 1”
  (`1.2.0` → `1.2.1`) and you can edit it.
- **App id** is generated from the English title (lowercase, 2–64 chars of letters/digits/`._-`) and is editable.
  It is also the folder name on other people's computers, so keep it short.

## The declaration (you must tick it)

Before uploading you must tick:

> I guarantee this app complies with the laws and regulations of the People's Republic of China, contains no illegal
> or harmful content and infringes no one's intellectual property; all responsibility arising from this app is mine.

The server records every upload: **time · account · IP · app id · version**. Without the tick the upload is refused
server-side too — it is not just a front-end check.

## Limits

| Limit | Scope |
| --- | --- |
| At most **5 apps** per account | Adding a version to an existing app does not count |
| At most **50MB** of stored packages per account | Every version of every app you own, added up |

When you exceed a limit the dialog shows your current usage and lets you tick old versions for deletion inside the
publish dialog. Deleting a version removes **both its package and its version record** (no grey rows), and frees the
quota right away.

## How versions are grouped

Every version of the same app id lives under **one app**: a new version carries its `parentVersion`, and expanding
the app's details on the Apps page shows a **version tree**:

- Each row = version · time · size · uploader · release note, tagged “Latest” / “Installed here”.
- “Download this version” downloads **only that version** (payload is replaced if already installed; your data folder
  and that app's own canvas are untouched).
- If the author deletes a version, its children hang under a “Root version (deleted)” placeholder — **no version ever
  disappears from the tree**.
- The “Update” button always points at the latest version and **only appears for the same author** (other authors' forks
  go through “Switch branch”); an installed card shows **Launch** instead of **Download**; updating an app that is in
  development first warns you that it will overwrite `app.json` / the entry page / `assets`.

## Unpublish / publish again

Authors can **unpublish** their own entry on the Apps page: it disappears from the catalog while **the packages and
all versions stay in the cloud**; “Publish again” brings it back. While unpublished it is still visible to you
(marked “Unpublished (only you can see it)”), so you never lose track of it.

## When do others see it

The API side takes effect **immediately**, but clients read the **static catalog**
(`http://mt-agent.com/mtnode/apps/catalog.json`). The publisher must sync `apps/catalog.json` together with every
version's package — see “五、部署” and “七、上架与多版本” in `docs/apps-market.md`.

## Server switch (ops)

- `MTNODE_APP_VERSIONS=1` turns multi-version mode on. **Unset (default) keeps the old overwrite behaviour**
  (one package per app).
- Version endpoints, quota error codes (`QUOTA_BYTES` / `QUOTA_APPS`) and the declaration fields are specified in
  `docs/apps-market.md` §7.
- Command line too: `python store-saas/upload-app.py --accept-declaration …` (see §4 and §7 of that document).

## Four things to check when an upload fails

1. **Not signed in** — sign in first.
2. **Declaration not ticked** — tick it and retry.
3. **Quota full** (the message carries current usage) — delete old versions in the publish dialog.
4. **Invalid package** — the app has no entry page (`index.html`) or is not on this computer; confirm it can “Launch”
   on the Develop page first.
