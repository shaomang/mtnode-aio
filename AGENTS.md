# AGENTS.md
MTNode AI编排器 — Electron 桌面端 AI 工作流编排器。用户数据只写 `%APPDATA%\pipeline-console` 或用户选定项目文件夹，**任何数据都不允许保存在应用文件夹**（`app.getAppPath()` / exe 同目录）。本文件是开发 / 细化 / 建议会话共享的核心共识：新文件按「目录约定」放置，「不要修改」清单内路径一律不改。版本以根目录 `version` 文件为唯一真源。Agent 工作区 = 项目根目录。
## 目录约定
- **主进程**：`main.js`、`preload.js`（contextBridge 白名单桥）、`main-exec-launch.js`；持久化 `db-store.js`、`assets-store.js`、`tools-store.js`、`config-providers.js`、`media-gen-global-lock.js`。
- **打包白名单（必读）**：`build.json` 的 `files` 是**显式白名单**；根目录新增的主进程模块只要被 `require` 就必须写进 `files`，否则解包后 `Cannot find module './xxx.js'`。
- **渲染层（无框架 SVG）**：`renderer/`，`app.js` 为画布主体，**脚本加载顺序 = 模块分层**（新版能力按 `renderer/index.html` 顺序放，样式进 `renderer/css/`）。
- **Agent 网关**：`dsh/`。`dsh/gateway/gateway.mjs` 是**全仓唯一 import dsh 之处**，由 `dsh-node.js` 选定的**真 Node（≥22.19）**拉起 —— dsh 拒绝 Electron 自带 Node，**别把 `process.execPath` 写回网关 spawn**；改前先读 `dsh/DESIGN.md`。
- **本地后端**：`music3/`、`h3/`、`llama/`、`pet/`，同名 `*-pack/` 为随包脚手架（extraResources）。
- **云端与内容**：`store-saas/`、`ext-repo/`、`forum/`、`web/`；插件宿主 `plugins/`；技能 `skills/`、`mtnode-agent-skills/<类目>/`（类目 `mtnode` / `app` / `plugins` / `canvas` / `music` / `writing`，新类目要在 `mtnode-agent-skills-lib.js` 的 `CATEGORY_TITLES` 补标题；front matter 写 `menu: user` 的内置技能随包进入用户技能清单与「/」菜单，不写则只进内置索引）；文档 `docs/`、手册 `guides/manual/`、节点指南 `guides/nodes/`（新增节点类型必补）；更新日志 `changelog/`（格式见 `changelog/README.md`）；测试 `test/`、`smoke.js`、`dsh/smoke-*.mjs`；构建发布 `scripts/`、`build.json`、`updater.js`、`version.js`。
- **一次发版**：`npm run release`（NSIS 与 MSIX 同版本），只出 Store 包用 `npm run release:store`。
## 不要修改
- 构建产物与依赖：`node_modules/`、`dist/`、`dist_check/`、`.dsh-probe/`、`dsh/gateway/node_modules/`、`dsh/gateway/pnpm-lock.yaml`。
- 运行时现场：`data/`、`*.log`、`dsh/smoke-home*`、`dsh/smoke-ws*`、`.commandcode/`。
- 真源与凭据：根目录 `version` 与 `package.json` 的 `version` 不要手改；密钥只进 `%APPDATA%`，不入库不提交；各 `*-pack/` 的锁文件、venv 产物与探针脚本不提交。
## Agent 运行时约束
- **Agent 运行期间不得使用任何 git 命令**。
## 协作约定
- **数据不落应用文件夹**：数据目录、事实库、素材库、日志只写 `%APPDATA%` 或用户选定项目文件夹；启动由 `main.js` 的 `auditAppDirData()` 体检。
- **安装脚本纯 ASCII（无 BOM）**：`*-pack/scripts/*.ps1` 等脚本内不许出现中文（注释也算），中文文案只放 `steps.json` 或界面词条；改后必跑 `test/smoke-install-scripts.js`。
- **带输入或设置的浮层一律 persistent**：禁止「点外部 / 点蒙层自动关闭」，关闭只走窗内按钮 / ✕ / Esc / 再点一次开关；开新面板要互斥（`closeNodePopsExcept`），节点级面板要跟随与回收（`nodePopAnchor` + `repositionNodePops`）；瞬时菜单与图片灯箱不算。回归口径 `test/smoke-dialog-persistence.js`、`test/smoke-dialog-minimize.js`。
- **发版前必须补 `changelog/v<当前版本>.md`**（面向用户、条目最多两层、不含技术细节）并同步 `changelog/README.md` 索引；`scripts/release.mjs` 打包前硬校验。
- **扩展能力（DSH 插件 / 技能 / MCP）统一在 `app-plugins.js` 的「扩展能力管理」对话框维护**，`app-settings.js` 只留入口。
- **提示词单一真源**：节点参数机制写在 `dsh/gateway/canvas-plugin.mjs` / `db-plugin.mjs` 的工具描述里，完整硬规则只写在 `mtnode-agent-skills/mtnode/canvas-edit-rules/SKILL.md`；加规则先判归属层，只落一处。
