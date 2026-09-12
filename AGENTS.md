# AGENTS.md

MTNode AI编排器（mtnode-ai-orchestrator）v1.1.28 — Electron 39 桌面端 AI 工作流编排器。MIT 开源，用户数据全部留在本机 `%APPDATA%\pipeline-console`，**任何数据都不允许保存在应用文件夹**（`app.getAppPath()` / exe 同目录；升级 / 卸载会带走或覆盖）。本文件是所有开发 / 细化 / 建议会话共享的核心共识：**新文件按「目录约定」放置，「不要修改」清单内路径一律不改**。Agent 工作区 = 项目根目录。

## 目录约定

- **主进程入口与 IPC 总线**：根目录 `main.js`、`preload.js`（contextBridge 白名单桥）、`main-exec-launch.js`（执行节点独立进程）。
- **渲染层（无框架 SVG，不引入前端框架）**：`renderer/`。`app.js` 为画布主体（脚本加载顺序即模块分层）；执行/批处理引擎 `app-nodes.js`；画布/标注/超级节点/主题/i18n `app-canvas.js`；智能体验 `app-agent.js`、`app-assist.js`、`app-plan.js`；数据库 `app-db.js`；开发节点 `app-devnode.js`；配置 `app-settings.js`；生态 `app-plugins.js`、`app-store.js`。样式在 `renderer/css/`。
- **Agent 网关（DeepSeek Harness 集成）**：`dsh/`。`main-dsh.js` 只在 stdio 走 MTNode 自有的换行分隔 JSON；`dsh/gateway/gateway.mjs` 是**全仓唯一 import dsh 之处**（独立 Node ≥22.19，吸收 dsh 全部 API 变化）；网关工具插件 `dsh/gateway/*-plugin.mjs`；契约文档 `dsh/DESIGN.md`，改动网关前先读它。
- **主进程侧数据/持久化**：`db-store.js`（SQLite + FTS5 事实库）、`assets-store.js`（素材库）、`tools-store.js`、`rollback-store.js`、`config-providers.js`（多服务商与模型配置）、`media-gen-global-lock.js`（音视频全局互斥锁）。
- **打包白名单（必读）**：`build.json` 的 `files` 是 **显式白名单**（不是整仓拷贝）。根目录新增/拆出的主进程模块（如 `*-store.js`、`*-lib.js`）只要会被 `main.js` / 其它已打包文件 `require`，**必须同步写进 `build.json` → `files`**，否则解包运行会出现 `Cannot find module './xxx.js'`（源码目录有文件、打包后 asar 没有）。改 `main.js` 的 `require("./…")` 时顺手核对白名单。
- **本地后端宿主**：`music3/`、`h3/`、`tts/`、`llama/`、`pet/`；同名 `*-pack/` 为随包脚手架（Python 后端 / ComfyUI 工作流 / Live2D 托盘资源），打包由 `build.json` 的 extraResources 打进安装包。
- **云端服务**：`store-saas/`（创意工坊零依赖 Node HTTP 服务）、`ext-repo/`（插件/技能/MCP 扩展目录与构建）、`forum/`（讨论区）、`web/`（云端站点静态页源；`web/privacy/` 为隐私政策中英两版，部署到 `/var/www/mtnode/privacy/`）。
- **应用插件宿主**：`plugins/`（`main-app-plugins.js`、`runtime-feed.js`、`catalog.default.json`、`icons/`）。
- **技能**：`skills/`（本地后端安装类技能）；`mtnode-agent-skills/mtnode/`（画布/数据库/开发架构等内置技能，索引由 `tools/build-mtnode-agent-skill-index.js` 生成）；`ext-repo/skills/` 为云发版技能。
- **文档**：`docs/`（设计文档）；`guides/manual/`（应用内手册，`index.json` 为目录）；`guides/nodes/`（节点指南 Markdown）。
- **测试**：`test/`、`smoke.js`（require ./main.js）、`dsh/smoke-*.mjs`。
- **构建发布·更新·诊断**：`scripts/`、`build.json`、`installer.nsh`、`updater.js`、`crash-report.js`、`version.js`；Microsoft Store 的 MSIX 打包链在 `scripts/msix/`（`msix.config.json` 身份配置 + `make-msix.mjs` 主脚本 + `make-assets.mjs` 磁贴资产，手册 `docs/msix-store-publish.md`）。**一次发版用 `npm run release`（`scripts/release.mjs`）同时出 NSIS 安装包与 Store（MSIX）包，两包版本号必须一致**（`--dry-run` 可干跑校验版本与步骤）；只出 Store 包用 `npm run release:store`，单跑 MSIX 用 `npm run dist:msix`；MSIX 只能人工拖进 Partner Center 上传框，本链不做自动上传。
- **诊断脚本（只读 · 零依赖 · 手动跑）**：`scripts/audit-token-usage.mjs` 解本机 `<userData>\pipeline-console\dsh-home\sessions\*\<sid>\session.jsonl[.zstd]`，按会话给出固定前缀（system 与逐个工具的字符数）、每步 prompt 与其增量、各工具返回体积（次数/均值/最大）、思考文本量、缓存命中率与 top-N 排行；调工具负载 / 返回预算 / 思考回放类优化前后各跑一次即可量化收益（`--help` 读口径）。

## 不要修改

- 构建产物：`node_modules/`、`dist/`、`dist_check/`（含 `dist_check/win-unpacked/`）。
- dsh 集成探测与网关依赖：`.dsh-probe/`、`dsh/gateway/node_modules/`、`dsh/gateway/pnpm-lock.yaml`。
- 运行时数据与日志：`data/`、`*.log`（含 `rebuild.log`）。
- 冒烟测试现场：`dsh/smoke-home*`、`dsh/smoke-ws*`。
- `.commandcode/`。
- **版本号唯一真源**：根目录 `version` 文件（x.y.z）与 `package.json` 的 `version` 字段不要手改，统一用 `node version.js bump`。
- 密钥/凭据类文件只进本机 `%APPDATA%`，一律不入库、不提交。
- 各 `*-pack/` 的依赖锁文件、Python venv 产物与探针脚本（如 `tts-pack/_probe_*.py`）不要提交。

## 协作约定

- 改 Agent 网关（`dsh/`）先读 `dsh/DESIGN.md` 遵守三层契约（main.js ↔ main-dsh.js ↔ gateway.mjs ↔ cordis 运行时）。
- **根目录主进程新模块必须进 `build.json` `files`**：否则打包后 `Cannot find module './xxx.js'`（已发生过 `assets-store.js` 遗漏）。
- 新增渲染层能力按 `renderer/index.html` 的脚本加载顺序（= 模块分层）放置，样式进 `renderer/css/` 对应文件。
- **扩展能力（DSH 插件 / 技能 Skills / MCP）统一在 `app-plugins.js` 的「扩展能力管理」对话框（`EXT_UI` + `#extManagerDlg`）里维护**：`app-settings.js` 只放「扩展能力」汇总小节与「管理…」入口，不要再往设置里加内联清单或表单；新增分类请扩 `EXT_KINDS`（复用卡片/详情样式，CSS 前缀 `.dsh-plugin-* / .dsh-ext-*` 在 `css/dsh.css`）。
- **应用插件卡片（顶栏「插件」对话框）只有「开始 / 关闭」两态，不做「删除 / 卸载 / 移除入口」**：卡片动作 = play（打开控制台或运行）与 stop（关闭控制台或停止）互斥开关，必要时保留「下载安装 / 更新」「状态与设置」；插件启停与卸载类操作留在各自控制台窗内。卡片按钮图标一律取自 `renderer/app-plugins.js` 的 `PLUGIN_ACT_SVG`——新用到的 kind 必须先在该表补图标，否则按钮渲染成没有图标的空方块。封面图标放 `plugins/icons/<id>.png`（1:1，随 `scripts/stage-plugins.mjs` 发布）。
- 版本发布走 `scripts/` 的 stage/upload/patch-nginx 发布链，不要在别处自创发布流程；**一次发版必须同时出 NSIS 与 Store（MSIX）包，两包版本号必须一致**（入口 `npm run release`，只出 Store 包 `npm run release:store`，见 `docs/msix-store-publish.md`）。
- **数据不落应用文件夹**：数据目录、事实库、素材库、`save` / 日志等一切用户数据只写 `%APPDATA%`（默认 `%APPDATA%\pipeline-console`）或用户选定的项目文件夹；解析结果等于或位于 `app.getAppPath()` / exe 同目录之下一律拒绝。启动时 `main.js` 的 `auditAppDirData()` 做只读体检，命中即记日志并弹窗报警；开发态（未打包）打印一次结论。对应口径见 `docs/fact-library.md` §一 / §六。
- 应用内手册由 `guides/manual/` 维护，节点指南在 `guides/nodes/`；新增节点类型必须补指南。
- **对话框 / 参数面板一律 persistent（禁止「点外部 / 点蒙层自动关闭」）**：任何带输入或设置项的浮层都不得挂「点外部即关」的监听——用户点空白看一眼画布，就把改到一半的参数丢掉，是最伤的交互。适用面：`#overlay` 弹窗（节点设置窗、设置、扩展能力管理、素材库 / 素材设置 / 素材表单、模板商店二级浮层、YAML / Markdown 编辑器、手册窗）、节点头部的参数面板（`#bgRmPop` 抠图、`#ratioLockPop` 画幅锁定、`#devModelPop` Agent 设定、`#devColorPop` 外框色）、顶栏面板（如「审批与权限」`#approvalsPanel`）。关闭只允许走显式路径：窗内「取消 / 完成并关闭 / 确定」按钮、面板 ✕、Esc、以及再点一次触发它的那个开关。
  - 去掉点外部收起后必须自己补上两件事，否则会留下叠在一起或飘在别处的浮层：**互斥**（开新面板时收掉旧面板，节点级面板统一走 `app.js` 的 `closeNodePopsExcept(keep)`）、**跟随与回收**（`nodePopAnchor(el, 锚点选择器, 尺寸, 节点 id)` 登记归属，`applyTransform → repositionNodePops()` 在平移 / 缩放后把面板贴回它的按钮——锚点这一帧没挂载（嵌在展开的壳层里）就原地不动，宿主节点已从 `S.wf` 消失（删节点 / 切画布 / 撤销换对象）才收掉；`closeAllNodePops()` 挂在切画布与撤销路径上）。
  - **不算对话框、保留点外部即收的只有两类**：瞬时菜单（右键菜单 `#ctx`、`@` 引用与 `/` 斜杠候选、输入框下拉、素材库小右键菜单）与图片预览灯箱（`#imgLb`）——它们没有待保存的输入。新写浮层前先按「有没有未提交的输入 / 设置」归类。
  - 回归口径由 `test/smoke-dialog-persistence.js` 钉住：扫描 `renderer/*.js`，出现「对话框宿主上的 `ev.target === host` 式关闭」「对话框开着的 `document/window` 级 outside 关闭监听」即判失败。
  - **`#overlay` 弹窗可以最小化到状态栏**（`app.js` 的 `ovMinimizeActive` / `ovMinRestore` / `ovMinDropAll` + `index.html` 的 `#ovMinBar` / `#ovPark`）：最小化 = 把整只 `.overlay-box` 原样搬进 `#ovPark`、状态栏留一枚画布 tab 同款页签，点页签原样搬回来（DOM 与窗内状态都不重建，未提交的输入不丢）。新写弹窗**默认都能最小化**，不该给最小化的（一次性提示 / 阻塞式确认）传 `openOverlay(title, { min: false })`；**上下文整块换掉时必须跟一次 `ovMinDropAll()`**（切画布 / loadWorkflow 已有）。别在别处自己搬 `.overlay-box`：`openOverlay` 走 `ovShellEnsure` 补壳、`ovShellIds` 摘挂 `ovTitle/ovBody/ovFoot`。回归口径见 `test/smoke-dialog-minimize.js`。
- **提示词单一真源**（详见 `docs/prompt-source-of-truth.md`）：画布 / 数据库节点的**参数机制**只写在 `dsh/gateway/canvas-plugin.mjs`、`db-plugin.mjs` 的工具描述与参数表里；**完整操作规范**只写在 `mtnode-agent-skills/mtnode/*/SKILL.md`；渲染层 `app-assist.js` / `app-db.js` 的系统提示与 `gateway.mjs` 的 `PRESETS` 只留**行为纪律**（确认口径、只读范围、工作区、回执即事实），不再抄字段清单、色卡 hex、端子序号。加新规则先判归属那一层，只落一处，其它层最多一句指向。**工具描述只留「卡口」**：`mtnode_canvas_edit` 的 description 只放 kind 枚举 / 端子语义 / 5 条不变量 + 一句指向，完整硬规则（task 三端、super 边界、@引用三条件、save 与 wait_file、批次与文生图、数据库 / 开发 / 排版 / scope）唯一真源在按需技能 `mtnode-agent-skills/mtnode/canvas-edit-rules/SKILL.md`（工具描述每轮重发，长规则命中「建图 / 连线 / 批量 / 媒体」时才加载）。**助手每轮 app_state 只给计数 + 选中 / 焦点**（`assistAppSnapshot` 不再调 `canvasSnapshotFull`，永不带 nodes / wires / marks / cam 与 text / prompt / task / goal / jscode），节点列表与结构由模型按需 `mtnode_canvas_get`（缺省 `detail:"minimal"` = **纯节点索引**：每节点只给 标题 / 描述(note) / 类别(kind)，配置字段 / 正文 / 连线 / 绘制 / 分组 / 树一律不带；只查连线再 `sections:["nodes","wires"]`，要配置 / 建图参考表显式 `detail:"standard"`）现拉，节点正文用 `ids:[…] + detail:"full"`——快照里不放正文，也不在别处再抄一份字段清单。**edit 回执自足免回读**：`editSummary` 的 created / updated 每条带 x/y/w/h 与端口占用摘要，`detail:"diff"` 只回本次明细；接线前先看 `canvas_get` 的 `ports`，`connect` 失败回候选端子与接法建议，保存路径后缀在 create / update 阶段即校验，收尾由 `collectEditStaticWarnings` 把六类静态检查合并成一轮 warnings（回归见 `test/smoke-token-budget.js` [1][9][10]，量化见 `docs/codex-agent-benchmark.md`）。
