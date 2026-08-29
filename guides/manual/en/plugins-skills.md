# Plugins, skills, MCP

## App plugins (top-right **Plugins**)

The **plugin list is fetched from the cloud catalog** (`http://mt-agent.com/mtnode/plugins/catalog.json`), so new plugins can appear without an app upgrade. Offline, the last cache or the built-in list is used; when cloud entries are missing, bundled built-in plugins are merged back automatically.

- **Forum**: optional download; sign in with the Creative Workshop account to chat; run, uninstall, or update.
- **Desktop pet (BongoChat)**: optional download; transparent always-on-top window; run or uninstall.
- **Local TTS (GPT-SoVITS)**: local speech synthesis backend; training / trial / language policy live in the plugin panel.
- **Local LLM (Llama.cpp)**: local inference backend.
- **MiniMax Music 3 / MiniMax H3**: local music / video generation backends (the canvas Music / Video generation nodes).
- **Window plugins**: new zip packages in the catalog can be downloaded and run without a new installer. Unknown plugin kinds prompt you to upgrade the app.

## DSH plugins / Skills / MCP

Manage under Settings · Agent (or Browse online):

- **DSH plugins**: extend the agent; installed under the config data directory (survive app updates); install restarts the engine.
- **Skills**: Markdown instructions. Type `/` in agent session / agent task / agent text / agent chat to pick one; the skill body is attached at run time.
- **MCP servers**: tools appear on agent nodes after connect (stdio or remote URL).

Official extension catalog: `http://mt-agent.com/mtnode/ext/catalog.json` (Browse online includes the **MTNode official** tab; you can also **+ Add source**). Local repo is `ext-repo/`; sync with `npm run ext:sync`.

Search, install, enable, or remove from Settings cards.
