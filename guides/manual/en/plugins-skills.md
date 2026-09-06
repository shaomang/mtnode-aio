# Plugins, skills, MCP

## App plugins (top-right **Plugins**)

The **plugin list is fetched from the cloud catalog** (`http://mt-agent.com/mtnode/plugins/catalog.json`), so new plugins can appear without an app upgrade. Offline, the last cache or the built-in list is used; when cloud entries are missing, bundled built-in plugins are merged back automatically.

- **Forum**: optional download; sign in with the Creative Workshop account to chat; run, uninstall, or update.
- **Desktop pet (BongoChat)**: optional download; transparent always-on-top window; run or uninstall.
- **Local TTS (GPT-SoVITS)**: local speech synthesis backend; training / trial / language policy live in the plugin panel — the canvas **SoVITS speech** node (Process › Audio generation) is wired to it.
- **Local LLM (Llama.cpp)**: local inference backend.
- **MiniMax Music 3 / MiniMax H3**: local music / video generation backends (the **Minimax Music 3** / **Minimax H3** nodes under the canvas “Audio generation / Video generation” submenus).
- **Window plugins**: new zip packages in the catalog can be downloaded and run without a new installer. Unknown plugin kinds prompt you to upgrade the app.

## DSH plugins / Skills / MCP

Manage under Settings · Agent (or Browse online):

- **DSH plugins**: extend the agent; installed under the config data directory (survive app updates); install restarts the engine.
- **Skills**: Markdown instructions. Type `/` in agent session / agent task / text node with 🐋 agent on to pick one; the skill body is attached at run time.
  - **Built-in skills** (shipped with the app, auto-synced into the skill library with an internal marker, so they **never show in your own skill list** and need no install; the AI loads them with the `skill` tool, and `/` also offers them in a session): `mtnode-dev-architect` (dev-node architecture), **`mtnode-grill-me` (interrogate the requirement: map it into a decision tree, ask the whole frontier round by round through MTNode's own question dialog (`ask_user_question`) with the recommended option first in each question, and only build once you confirm the shared understanding in that dialog — this is exactly what the 开发 dialog's “先拷问需求 / grill me” checkbox uses)**, `mtnode-canvas-batch-safety` (batch N² guard), `mtnode-canvas-layout-ux` (canvas layout), `mtnode-db-facts` (fact-database discipline), `mtnode-media-gen-nodes` (music / speech / video generation nodes).
- **MCP servers**: tools appear on agent nodes after connect (stdio or remote URL).

Official extension catalog: `http://mt-agent.com/mtnode/ext/catalog.json` (Browse online includes the **MTNode official** tab; you can also **+ Add source**). Local repo is `ext-repo/`; sync with `npm run ext:sync`.

Search, install, enable, or remove from Settings cards.
