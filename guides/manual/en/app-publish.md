# Publish an app to the cloud (versions)

> In one sentence: pack an app you built on this computer and upload it to the cloud so other users can find it
> in the App Center, download it, use it, or build on it — and one app can hold many versions that users pick from.

## Where the entry is

Top bar “Apps” → left nav “Develop” → in the toolbar row, click **Publish** to the right of **Launch**.
Publishing is always called **Publish** — a first upload and an update are the same action: the first publish
creates a new cloud entry, and publishing an app that is already there **appends a version** to the same entry.
The button label never changes; whether this is a new entry or an extra version is decided by the cloud
(app id + author uid) and stated plainly in the result as “(new app)” or “(new version)”. Signing in with a
different account publishes a **different** app entry.
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

## Screenshots: captured only when you click

The publish dialog **does not** launch the app or take a picture when it opens. Clicking **“Capture the app window”**
does both: it launches the app (opening the window, or restoring a minimised one) and captures it — you no longer
have to go back to the Develop page and click **Launch** first.

You can also “Choose an image” from this computer: up to 8, reorderable, **the first one is the cover**.
Uploading with no screenshot at all asks once for confirmation, because the store card and the detail header
would then have **no cover** (with no icon picked, the icon comes from the first screenshot too).

## AI draft + human check

- Opening the dialog generates the metadata once (title / description / version / tags); “Generate again” redoes it.
- The AI only sees the app's `app.json` and the visible text of its entry page; the result is a **draft** — check and
  edit it before submitting.
- With no text provider configured you are told so and the fields stay empty for you to fill in — no invented metadata.
- **Version**: the first publish is `1.0.0`; publishing the same app again defaults to “previous minor + 1”
  (`1.2.0` → `1.2.1`) and you can edit it.
- **The app id is locked by default**: it is the identity of that app in the cloud and the **install folder name**
  on other people's computers. It is locked to this machine's app id — or, when an upload record exists, to the
  **cloud id used last time** (the local folder name is shown next to it). Editing the title never changes it.
  To really change it, click **“Change id”** next to the field: a confirmation first explains that
  **changing the id creates a new app in the cloud** (from then on it is a separate entry, no longer a new version);
  once confirmed the field becomes editable in this window, and setting it back re-locks it.
  The id is locked on a first publish too — it is no longer generated from the English title.

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
quota right away. The outcome **stays on screen** in the “⑤ Cloud versions” row (success: “Deleted vX, quota
freed”; failure: the server's own message plus a **Retry** button), and the list is re-read from the server, so a
deleted version never lingers. Ticking the **last remaining version** adds a line to the confirmation: once it is gone
the app itself is **deleted from the cloud entirely** (record and package removed — cannot be undone).

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

## Delete = removed from the cloud for good

**Delete = removed from the cloud for good, and it cannot be undone**: after you click Delete and type the app title,
that branch's record, every version package, the icon and the screenshots are all removed from the cloud, the catalog
stops listing it right away, and there is no “restore / publish again” way back.
**Deleting a single version is not deleting the app**: when you delete one version and the branch still has others,
the app stays online (the latest version points at the highest remaining one).

## Managing what you published: the “My apps” page

The second page of the App Center, **My apps**, manages the entries you published to the cloud (including ones you
forked from someone else). The search box filters by title / description / tags and “Load more” pages through the
rest (50 per page). Every card has two icons in its bottom-right corner — **Edit / Delete** (clicking the card
itself still opens the detail window, which carries the same two actions with labels).

- **Edit**: title, description, tags, cover icon and screenshots (up to 8 — remove one, or drag to reorder).
  Before saving you must tick the same declaration you ticked when publishing. Editing **does not create a new
  version** — the version number stays and everyone immediately sees the new text and images. After a successful
  save, the title / description / tags are written back into the local copies with the same id (download root and
  project root), so the Library card follows along; the icon is not written to local files (the Library cover already
  comes from the cloud entry).
- **Delete**: really deletes **your branch** (record, version packages, icon and screenshots — **removed from the
  cloud for good, cannot be undone**).
  You have to type the app title before Delete becomes clickable. Branches other authors forked from your app are
  **not touched at all**, and the confirmation says “another N author(s) have derived branches that will be kept”;
  copies downloaded on this computer are not deleted either (uninstall them from the Library page).
- Editing screenshots needs the **new cloud server**: an older server ignores that part of the request, and the client
  says so explicitly (“Screenshots did not take effect: the cloud server must be upgraded…”). Your other changes are
  still saved.
## When do others see it

The API side takes effect **immediately**, but clients read the **static catalog**
(`http://mt-agent.com/mtnode/apps/catalog.json`). The publisher must sync `apps/catalog.json` together with every
version's package — see “五、部署” and “七、上架与多版本” in `docs/apps-market.md`.

## Server switch (ops)

- Multi-version mode is **on by default** (since 2026-10; it used to be off, which is why the live server kept
  answering `409 APP_VERSIONS_DISABLED`). Set `MTNODE_APP_VERSIONS=0` (or `false` / `no` / `off`) in
  `/etc/mtnode-store.env` and restart the service to fall back to the old overwrite behaviour (one package per app).
- Version endpoints, quota error codes (`QUOTA_BYTES` / `QUOTA_APPS`) and the declaration fields are specified in
  `docs/apps-market.md` §7.
- Command line too: `python store-saas/upload-app.py --accept-declaration …` (see §4 and §7 of that document).

## Four things to check when an upload fails

1. **Not signed in** — sign in first.
2. **Declaration not ticked** — tick it and retry.
3. **Quota full** (the message carries current usage) — delete old versions in the publish dialog.
4. **Invalid package** — the app has no entry page (`index.html`) or is not on this computer; confirm it can “Launch”
   on the Develop page first.
