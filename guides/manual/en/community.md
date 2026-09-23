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
   - **Template** = a canvas you can import; during import, a provider or model your machine does not have is asked about one by one and batch-replaced with your own.
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
   - When the canvas references a provider / model your machine does not have, it asks one by one and batch-replaces them with your own.
3. A node missing a plugin or a backend will not run — read the node notes before pressing ▶.

### Upgrading and uninstalling

- Plugins and assets live under the app's config data directory, so an app upgrade keeps them.
- Installing / uninstalling a plugin asks for confirmation first; uninstall affects only that plugin, core capabilities are untouched, and a user plugin can be mounted again.

## Community safety and etiquette

- Dry-run a canvas in an empty folder first instead of opening it straight on your main project.
- Ask about an error with a minimal reproduction rather than a whole pasted log.
- Credit other people's work; do not publish it as your own original.
- Do not upload material involving other people's privacy, likeness or copyright without permission.
