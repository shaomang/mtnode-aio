# AGENTS.md

**MTNode AI工作站**（MTNode AI Orchestrator）— Electron 桌面端 AI 工作流编排与智能体工作站。
根目录 `version` 是版本号唯一真源；所有用户数据只能写入 `%APPDATA%\pipeline-console` 或用户选定的项目目录，**严禁写入应用安装目录**（启动由 `main.js` 的 `auditAppDirData()` 自检）。

## 运行时硬约束

- **禁止执行任何 `git` 命令**。
- **不要修改以下路径**：
  - 依赖与产物：`node_modules/`、`dist/`、`dist_check/`、`.dsh-probe/`、`dsh/gateway/node_modules/`、`dsh/gateway/pnpm-lock.yaml`
  - 运行时现场：`data/`、`*.log`、`dsh/smoke-home*`、`dsh/smoke-ws*`、`.commandcode/`
  - 版本与密钥：`version` 与 `package.json` 的 `version` 不手改（走 `node version.js`）；密钥只存 `%APPDATA%` 不入库；各 `*-pack/` 的 venv / 锁文件不提交。

## 目录结构

| 区域 | 路径与约定 |
| --- | --- |
| 主进程 | `main.js`、`preload.js`（contextBridge 白名单桥）、持久化 `*-store.js`、配置与运行支撑模块 |
| 渲染层 | `renderer/`（无前端框架、无构建器）；`app.js` 为主体，按 `renderer/index.html` 的 `<script>` 顺序分层，样式进 `renderer/css/` |
| 画布读侧内核 | `canvas-doc/`（渲染层 `<script>` 与主进程/MCP 共用同一份 `canvas-doc-core.js`，不复制；改 `main.js` 锚点需同步 `docs/canvas-doc-migration.md` 并过 `test/smoke-canvas-doc-parity.js`） |
| Agent 网关 | `dsh/`；`dsh/gateway/gateway.mjs` 是唯一 import dsh 入口，由 `dsh-node.js` 选定的外部 Node（≥22.19）拉起，禁止传 Electron `process.execPath`（改前读 `dsh/DESIGN.md`） |
| 本地后端插件 | `<id>/` 宿主 + `<id>-pack/` 随包脚手架（`music3` / `yue` / `h3` / `llama` / `breeze` / `moss-music` / `infinitetalk` / `soulxflashhead` / `flux3klein` / `qwenimage` / `remotion` / `blender` / `paseo` / `pet` / `audio`） |
| 应用自带后端 | 应用目录 `backend/backend.json` + 源码由 `app-backend-pack.js` 同步到 `<数据目录>/backends/<id>/`；拉起用 `process.execPath` + `ELECTRON_RUN_AS_NODE=1`，禁止写死本机 node 路径 |
| 文档与技能 | 工程文档 `docs/`；应用内手册 `guides/manual/`（中英双语 + SVG 图示）；节点指南 `guides/nodes/`（新增节点必补）；技能 `skills/` 与 `mtnode-agent-skills/<类目>/`（front matter 含 `menu: user` 进用户「/」菜单，新类目补 `mtnode-agent-skills-lib.js`）；更新日志 `changelog/` |
| 测试与发版 | `npm test`（`test/run-all.mjs`，默认跑纯 Node 冒烟，重活走 `npm run test:heavy`）；发版 `npm run release`（仅 Store 用 `npm run release:store`） |

## 必须遵守的开发纪律

1. **打包白名单（`build.json`）**：`files` 为显式白名单。根目录新增的 `*.js`（含主进程模块与 `preload*.js`）只要被 `require` 就必须加入 `files`，否则打包后直接报错缺模块；`renderer/**`、`canvas-doc/**`、`guides/**` 已通配涵盖。
2. **发版日志**：发版前补 `changelog/v<版本>.md`（面向用户、简洁明了、无技术黑话）并同步 `changelog/README.md`，`scripts/release.mjs` 会硬校验。
3. **带输入或设置的浮层一律 persistent**：禁止「点外部 / 点蒙层自动关闭」，只能通过窗内按钮 / `✕` / `Esc` / 开关本身关闭；节点浮层走 `closeNodePopsExcept` 与 `repositionNodePops`（瞬时菜单与图片灯箱不算；回归 `test/smoke-dialog-persistence.js`）。
4. **安装脚本纯 ASCII（无 BOM）**：`*-pack/scripts/*.ps1` 内禁止出现中文（含注释），中文文案放 `steps.json` 或 i18n；改后跑 `test/smoke-install-scripts.js`。
5. **插件图标与安装自检**：`plugins/icons/<id>.png` 必须使用官方透明底 PNG（1:1、≥256×256）；走安装窗的插件必须在 `registerInstallTarget` 同处注册 `registerPluginSelfcheck`（回归 `test/smoke-install-window.js`）。
6. **提示词单一真源与可配置登记**：节点参数说明只写在 `dsh/gateway/canvas-plugin.mjs` / `db-plugin.mjs`，画布编辑硬规则只写在 `mtnode-agent-skills/mtnode/canvas-edit-rules/SKILL.md`；凡注入给模型的固定提示词一律用 `PS("<id>", 默认文本)` 并登记进 `agent-prompts/index.json`（回归 `test/smoke-agent-prompts.js`）。
7. **应用能力位唯一真源**：缺省开关只在 `apps-capabilities.js` 的 `APP_CAPABILITIES` 定义（`defaultOn: true` 即缺省开启，如 `windowChrome`、`showComplete`），不要逐个应用补丁式硬写。
8. **扩展能力统一入口**：DSH 插件、技能与 MCP（含内置 MCP 服务端）统一在 `app-plugins.js` 的「扩展能力管理」维护，`app-settings.js` 只放入口。
9. **进程隔离开关**：`canvases.docService`（`off|read|write`）与 `assist.isolation`（`off|on|window`）默认皆为 `off`，关闭即完整回退内嵌路径；改动前先读 `docs/canvas-doc-migration.md` 与 `docs/assist-isolation.md`。
10. **GUI 驱动分工**：`mtnode_gui`（`mcp-gui-agent.js`）操作用户当前窗口；`mtnode_dev`（`dev-agent.js`）仅操作隔离调试实例（严禁指向默认数据目录 `%APPDATA%\pipeline-console`）。

## 输入补全（FIM）维护要点

- **单一实现**：`renderer/app-fim.js` 与 `renderer/css/fim.css` 被主窗口、开发页 iframe 与独立应用窗口共用，不按宿主分叉。
- **渲染边界**：单行补全走内联半透明（光标后有字时才走 `mask()` 接管）；多行补全（以及文字色透明的自定义高亮控件）走光标行下方的**实色不透明卡片**（`rgb(10,16,22)`，不调回半透明以免透字）；入场动画只动 `transform` 不动 `opacity`。回归跑 `node test/smoke-fim.js`。
