# Workshop & forum

> In one sentence: make good use of the community's two lines — browse and download (and, once signed in, upload and manage) other people's public template canvases and skills in the Creative Workshop, and browse the forum without signing in, post topics and reply once signed in — and know the scrubbing and safety etiquette that come before sharing.

## Community overview

### Community overview

MTNode's community has two parts, both reached from the top bar:

- **创意工坊 (Creative Workshop)** (top bar): browse / download other people's public template canvases and skills (Skill); once signed in you can upload and manage your own entries.
- **讨论区 (Forum)** (top right): topics and replies; browsing needs no sign-in, and once signed in you can post a topic, reply and change its status.

Both share the same MTNode account (WeChat QR sign-in; an old account can sign in with a password and link it up afterwards). The account entry is **账户 (Account)** at the top right.

This section: ① Workshop · what it is → ① Forum · what it is → ① Sharing flow.

## Workshop · what it is

### What the Creative Workshop is

A public catalog: template canvases (whole workflows) and skills (Skill, a SKILL.md package) uploaded by others, which you can search, preview and download to your machine.

### Track one: I want other people's things

1. **创意工坊 (Creative Workshop)** in the top bar; switch between the **模板 (Templates) / 技能 (Skills)** panes, and sort by tags, popularity (downloads / likes) or newest, with search as well.
2. Preview read-only first, then **下载到本机 / 下载 (Download to this machine / Download)**.
   - **Template** = a canvas you can import; if it references a provider or model your machine does not have, nothing pops up — those nodes silently become **No model**, and only when you press ▶ do you get a prompt to pick a provider and model again in the node settings.
   - **Skill** = once downloaded to this machine, agent nodes can call it with `/`; when the workshop has a newer version you update it by hand, because the local copy does not follow automatically.

### Track two: I want to share my own things

1. Sign in first (uploading requires a sign-in).
2. Upload a template = pick a local canvas; upload a skill = pick / paste a SKILL.md (use **使用本机技能 (Use a local skill)** to load an existing one; it needs a frontmatter `name` in kebab-case).
3. Fill in the title, description, tags and version; manage your own entries under **我的 (Mine)** and check downloads and likes.

- Uploading a template automatically strips the canvas's local-workspace information, so your local paths never travel with it.
- Only the uploader can update a skill of that name; re-picking a file overwrites the workshop body (a new version is required).

## Forum · what it is

### What the forum is

MTNode's official forum, for asking questions, getting help with errors, sharing work and suggesting features.

Entry: **讨论区 (Forum)** at the top right. It is an on-demand component, not part of the installer, so the first click offers to download it.

### How to use it

- Topics and replies are browsable without signing in.
- It shares the same account as the Creative Workshop; once signed in you can post a topic, reply and set topic status.
- Topics are kept long-term, so the same pitfall can be found later.

### Question template

1. What I want (the goal in one sentence).
2. What I did (node titles / which branch of the canvas, which parameters changed).
3. What actually happened (the error text, not half a screenshot).
4. What I already tried (which possibilities are ruled out).

Bringing a minimal reproduction is far more useful than pasting a whole log.

## Tipping and comments

### Tipping (support an author with W coins)

- You can tip: workshop templates and skills, **published** apps in the App Center, and forum topics and replies (all four share the same entry: a **W-coin icon** button on the card and another one inside the detail view).
- The money comes out of **your own W-coin balance** and goes straight to the author. There is no "top up first" step: when the balance is too low the button says "not enough W coins — top up" and opens the top-up window in one click.
- Three fixed tiers: **100 / 500 / 1000 W coins** — you cannot type your own amount. The tip window shows **W coins only** (never a yuan equivalent); what a coin is worth is shown in the top-up window.
- Amounts are shown as **a number followed by the W-coin icon** (the official DeepSeek logo inside a gold ring) — in the Chinese UI the word "币" is gone; hover the icon to see "鲸圆币". The wallet, the relay balance in Settings, cost read-outs and the tip window all use this one icon.
- Two limits: **at most 1000 W coins per tip**, and **at most 1000 W coins per account per calendar month** (reset at 00:00 Beijing time on the 1st); the **same target can be tipped only once a day**; you cannot tip yourself.
- The tip window **does not show a monthly remaining quota** (the UI exposes no quota figure): if you really hit the monthly cap, the tip is rejected and says the monthly tip quota is used up (it resets on the 1st of each month).
- When the balance cannot be read the window says which case it is: **your sign-in has expired** (click the sentence to sign in again — the balance refreshes in place) or **the balance is unavailable right now** (network / server trouble — try again later).
- Tips are **not refundable**: there is no revoke at all (the back office has no such entry either; records revoked in the past stay on file read-only).
- What the author receives goes into their balance, **can be spent on calling MTNode relay models**, and **cannot be withdrawn**.
- Tips are counted **per whole app** (rooted at the original author's branch): however many people have forked it and whichever version you look at, the total amount and count are **one and the same** number.
- Everyone can see the **total amount and number of tips** on an entry / topic, but **the names of tippers are visible only to the author of that entry** (for an app with several authors, every author in that family counts as "the author"). If you are the author, the window lists everyone (for reconciliation); if you are not, it lists **only the tips you sent yourself** ("You tipped N · M times" plus the icon) — no other name is ever shown. If you never tipped it, you just see the public **accumulated tips** line.
- The tip window has **no ✕ in its corner**: close it with the **Close** button at the bottom or with Esc. The **Tip** button is **orange-outlined with a transparent centre** and sits at the **bottom** of the window (not in the top-left).
- **Multi-author apps split the tip proportionally**: when the same app family (including branches forked from it) is kept by several authors, the tip window lists **one row per author, each with a coin input** (the unit is the W-coin icon) — the **sum may not exceed the tier you picked** (anything above it is clamped), and the **last author's box always fills in the remainder** (change any other box and it follows). If you are in that group yourself, your share is fixed at **0** (you cannot tip yourself). The server still receives one total and credits each author's share separately.
- The workshop sort now has a **Tip popularity** option: sorted by total tipped, so the best-supported entries come first (ties broken by number of tips).

### Comments (ratings and discussion)

- Comments live in four places: a workshop entry's detail window (**Comments** tab), an app's detail (**Comments** tab), a forum topic's detail (**Comments** tab), and each reply's own comment window.
- **Anyone can read comments; posting one requires a sign-in**; you can **reply to a comment** (parent-child quote), the same shape as forum replies.
- **Only item comments (template / skill / app) carry a five-star rating**, and it is **optional** — skip it and it is left out of the average. Comments on forum topics and replies have no stars. For one item you only keep your latest star.
- Cards and detail views show the **average star (one decimal) + comment count** and the accumulated tips; when nobody has rated, no fake score is shown.
- Deleting: a comment's author can delete their own, an entry / topic author can delete comments under their own item, and an admin can delete anywhere. **Deleting a comment also drops its star**, and the average is recalculated right away.
- Comments are plain text, at most 2000 characters, **no images**; rate limits apply (1 per minute, 50 per day).

## Sharing and installing

### Sharing a canvas (1-2-3)

1. First remove anything private from the canvas: no API keys, private paths or client data.
2. **创意工坊 (Creative Workshop)** in the top bar → **上传 (Upload)** → pick this canvas → fill in the title / description / tags / version → **发布 (Publish)** (sign-in required).
3. Uploading strips the local-workspace information automatically; afterwards **我的 (Mine)** shows downloads and likes, and to change something you re-pick the file and fill in a new version.

### Installing someone else's things (1-2-3)

1. Preview and confirm in the workshop, then click **下载到本机 / 下载 (Download to this machine / Download)**.
   - **Template** → imported as a new canvas; **skill** → written into your local skills directory and called by agent nodes with `/`.
   - Components such as plugins and the forum are **downloaded on demand**, not in the installer; installing one restarts the engine, so let any running task finish first.
2. After importing someone else's canvas, check item by item: providers and models, save paths, and whether any node needs a local backend (H3 / Music 3 / TTS / llama).
   - When the canvas references a provider / model your machine does not have, nothing pops up: those nodes silently become **No model** (the node header names the missing one), and pressing ▶ is what prompts you to pick a provider and model again.
3. A node missing a plugin or a backend will not run — read the node notes before pressing ▶.

### Upgrading and uninstalling

- Plugins and assets live under the app's config data directory, so an app upgrade keeps them.
- Installing / uninstalling a plugin asks for confirmation first; uninstall affects only that plugin, core capabilities are untouched, and a user plugin can be mounted again.

## Community safety and etiquette

- Dry-run a canvas in an empty folder first instead of opening it straight on your main project.
- Ask about an error with a minimal reproduction rather than a whole pasted log.
- Credit other people's work; do not publish it as your own original.
- Do not upload material involving other people's privacy, likeness or copyright without permission.
