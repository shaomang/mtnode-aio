# Plugins, skills, MCP

> One-sentence goal: give agent nodes new local backends and external tools — app plugins, DSH plugins, skills and MCP servers, each of the four kinds of extension in its own place.

![扩展能力](img/mtnode-agent-07-ui.svg)
*Figure 1: Settings · agent capabilities → 扩展能力 (Extensions) → 管理 (Manage…), where all three kinds of extension share one dialog*

## Goal

After this page you can use the top-right 插件 (Plugins) to install local backends (speech, LLM, music, video); use 设置 · 智能能力 → 扩展能力 → 管理… (Settings · agent capabilities → Extensions → Manage…) to install DSH plugins, write your own skills and connect MCP servers; and call a skill up with `/` in an agent session.

## Before you start

- You need a network. Offline, the plugin list falls back to the last cache or the list bundled with the app, and new plugins cannot be installed.
- To install a local-backend plugin (GPT-SoVITS / Llama.cpp / MiniMax Music 3 / MiniMax H3), prepare disk space and VRAM first, and install dependencies following the guidance in the plugin panel.
- Connecting MCP needs an executable stdio command, or a remote URL.
- Installing a DSH plugin **restarts the engine**, so save whatever you are editing first.

## Steps

1. **Open the app plugins**: click **插件 (Plugins)** at the top right. The list **updates from the cloud catalog** (`http://mt-agent.com/mtnode/plugins/catalog.json`), so you can see new plugins without upgrading the main program; offline it uses the last cache or the built-in list, and when the cloud catalog is missing entries the bundled built-in plugins are merged back automatically.
2. **Download and run**: click run / uninstall / update on a card. A new plugin may be a **window plugin** — a zip package newly added to the catalog can be downloaded, installed and run directly, with no new installer release; if the current version does not recognise the plugin kind, you are prompted to upgrade the app first.
3. **Open extension management**: go to **设置 · 智能能力 → 扩展能力 (Settings · agent capabilities → Extensions)**; this shows only a one-line summary (how many of each), and clicking **管理… (Manage…)** opens the unified 扩展能力管理 (Extension management) dialog.
4. **Switch tabs**: the dialog has three tabs across the top — `DSH / Skill / MCP` — with the card list on the left and details and actions on the right; all three share one style.
5. **Search and act**: every category has a search box at the top; in the detail pane on the right you can **mount / disable / remove** each entry. Detailed cards can also be searched, installed, started, stopped and removed directly in Settings.
6. **Install a DSH plugin**: in the DSH tab, fill in the **npm package name / GitHub address** and install directly. Plugins install into the **config directory** (kept across upgrades), and the engine restarts after installation — the tool menu has it from the next run on.
7. **Create a skill**: in the Skill tab click **＋ 创建技能 (Create skill)** and write the **name, description and body** (a Markdown manual) on the right.
8. **Use a skill**: type **`/`** in an agent session / agent task / a text node with 🐋 Smart on to pick that skill; at run time **the whole skill text is attached**.
9. **Add an MCP server**: in the MCP tab click **＋ 添加服务器 (Add server)** and fill in a name and a **stdio command or remote URL**; once connected, agent nodes gain the tools that server provides.
10. **Look in the online catalog**: click **🌐 在线浏览 (Browse online)** to install from the online catalog; the official extension catalog is `http://mt-agent.com/mtnode/ext/catalog.json`, browsing online comes with an “MTNode 官方 (MTNode official)” tab by default, and you can also **＋ 添加源 (Add source)** to add your own source.

### Local backends among the app plugins

- **讨论区 (Forum)**: an on-demand download chat window; sign in with the same Creative Workshop account to chat; can be run, uninstalled and updated.
- **桌宠 BongoChat (Desktop pet BongoChat)**: an on-demand download transparent always-on-top window; can be run and uninstalled.
- **本地 TTS（GPT-SoVITS）(Local TTS, GPT-SoVITS)**: a local speech synthesis backend; training / trial listening / language policy all live in the plugin panel. The canvas **SoVITS 语音 (SoVITS speech)** node (process nodes › audio generation) is what connects to it.
- **本地大模型（Llama.cpp）(Local LLM, Llama.cpp)**: a local inference backend.
- **MiniMax Music 3 / MiniMax H3**: local music / video generation backends (the **Minimax Music 3** / **Minimax H3** nodes under the canvas 音频生成 / 视频生成 (Audio generation / Video generation) submenus).

### Built-in skills

Built-in skills ship with the app, are synced into the skill library automatically by the engine and carry an internal marker, so they **do not appear in your own skill list** and need no installation; on the AI side they are loaded by name with the `skill` tool, and `/` also offers them in an ordinary session:

- `mtnode-dev-architect` — scanning and building a dev-node architecture.
- `mtnode-grill-me` — grill me: map the requirement into a decision tree and, round by round, ask the whole frontier at once through MTNode's question dialog (`ask_user_question`), with the recommended option first in every question; work only starts once there is a shared understanding and you have confirmed it in the dialog. This is what the 先拷问需求 (grill me) switch in a dev node's 开发 (Develop) dialog uses.
- `mtnode-canvas-batch-safety` — batch N² guard.
- `mtnode-canvas-layout-ux` — canvas layout.
- `mtnode-db-facts` — fact-library discipline.
- `mtnode-media-gen-nodes` — music / speech / video generation nodes.

### Official catalog and local repo

- Official extension catalog: `http://mt-agent.com/mtnode/ext/catalog.json` (browsing online comes with an “MTNode 官方 (MTNode official)” tab by default).
- The local repo is under `ext-repo/`; sync it to the cloud with `npm run ext:sync`.

## Result

- The top-right 插件 (Plugins) can start installed backends directly, and the matching generation nodes appear on the canvas.
- In the 扩展能力 → 管理… (Extensions → Manage…) dialog each of the three kinds has its own tab: DSH plugins show as enabled, skills show up in the `/` candidates, and MCP servers show their connection status.
- After a DSH plugin is installed and the engine restart finishes, agent nodes have the new tools.
- Browsing online shows the skills / plugins / MCP entries under the official tab, and clicking install puts them in the local list.

## Common mistakes

| Symptom | Cause | Fix |
| --- | --- | --- |
| The plugin list is empty or very old | You are offline and the cache / built-in list is being used | Go online and reopen the plugin panel to refresh the cloud catalog |
| A plugin is installed but the canvas has no matching node | The node lives under the 音频生成 / 视频生成 (Audio / Video generation) submenu, or the backend is not running | Look in the generation submenu of a process node; confirm the backend is running in the plugin panel |
| You clicked install and it says the plugin kind is unknown | That plugin needs a newer app version | Upgrade the app first, then install |
| The skill you just wrote is not in `/` | The skill was not saved, or the node is not an agent node | Confirm the skill is saved in the extension dialog; an ordinary node needs 🐋 Smart on to offer `/` candidates |
| An MCP server was added but its tools do not appear | The stdio command is not executable, or the URL is unreachable | Use an executable command / a reachable URL, and check the connection status in the detail pane |
| The UI is briefly unusable after installing a DSH plugin | The engine is restarting | Wait for the restart to finish before continuing |

## Next

- [What agent mode is](#dsh)
- [Agent task & session](#agent-nodes)
- [Approvals](#approvals)
- [Settings](#settings)
