# MTNode AI编排器

把复杂 AI 工作流收束到一张可视化画布上的 Windows 桌面工具：文本 / 图像输入、LLM 文本处理与图像生成、音乐 / 视频生成、批量处理、任务控制流、AI Agent 会话，都以节点自由编排。

**永久免费开源**（MIT License）：无收费、无订阅，随版本提供源码包；工作流可导出为 `.mtnodes` 包无损分享。当前版本 **1.2.9**。

- **下载页面**：[http://mt-agent.com/mtnode](http://mt-agent.com/mtnode)（Windows 安装包与源码包）
- **应用内手册**（右上角「文档」，源码在 [`guides/manual/`](guides/manual/)，目录见 [`index.json`](guides/manual/index.json)）
- **节点指南**（节点右键「节点指南」，源码在 [`guides/nodes/`](guides/nodes/)）
- **变更记录**：[`CHANGELOG-v1.1.md`](CHANGELOG-v1.1.md)

## Quick start

| 我想…… | 去哪里 |
| --- | --- |
| 装好并跑起来 | 从[下载页面](http://mt-agent.com/mtnode)取安装包；首启向导见 [`first-run.md`](guides/manual/first-run.md) · [`overview.md`](guides/manual/overview.md) |
| 看懂界面与快捷键 | [`ui-tour.md`](guides/manual/ui-tour.md) · [`shortcuts.md`](guides/manual/shortcuts.md) |
| 配服务商与 API Key | [`providers.md`](guides/manual/providers.md)（Key 只存本机） |
| 用节点和连线搭一条流水线 | [`nodes-wires.md`](guides/manual/nodes-wires.md) · [`io-proc.md`](guides/manual/io-proc.md) |
| 调参数、运行与排查一次运行 | [`params-runs.md`](guides/manual/params-runs.md) |
| 批量生产、拆分合并、批量落盘 | [`batch.md`](guides/manual/batch.md) |
| 理清执行顺序：任务、判断、定时与路由 | [`control-flow.md`](guides/manual/control-flow.md) |
| 找节点、总览画布、框选与排版 | [`canvas-tools.md`](guides/manual/canvas-tools.md) · [`marks-groups.md`](guides/manual/marks-groups.md) |
| 收纳复杂子图 | [`super-nodes.md`](guides/manual/super-nodes.md) |
| 复用工具、跑纯计算函数 | [`tools-functions.md`](guides/manual/tools-functions.md) |
| 让多个节点共享同一份输入 | [`global-broadcast.md`](guides/manual/global-broadcast.md) |
| 生成音乐 / 视频 / 语音 | [`media-gen.md`](guides/manual/media-gen.md)（本地后端安装见 [`plugins-skills.md`](guides/manual/plugins-skills.md)） |
| 接网络端口、拉起本机程序 | [`media-net.md`](guides/manual/media-net.md) |
| 保存、导入导出、上架创意工坊 | [`workflows.md`](guides/manual/workflows.md) |
| 让 AI 帮我搭 / 改工作流，或用 Agent 干活 | [`agent-nodes.md`](guides/manual/agent-nodes.md) · [`dsh.md`](guides/manual/dsh.md) |
| 管权限与审批 | [`approvals.md`](guides/manual/approvals.md) |
| 装插件、技能与 MCP | [`plugins-skills.md`](guides/manual/plugins-skills.md) |
| 按模块搭建软件项目架构（开发节点） | [`dev-nodes.md`](guides/manual/dev-nodes.md) |
| 让回答有据可查（数据库节点） | [`database-nodes.md`](guides/manual/database-nodes.md) · [`fact-library.md`](guides/manual/fact-library.md) |
| 让多个 AI 角色协作 | [`one-person-company.md`](guides/manual/one-person-company.md) |
| 管理素材 | [`asset-library.md`](guides/manual/asset-library.md) |
| 编辑 Markdown / 代码，写批注让 AI 修订 | [`editors.md`](guides/manual/editors.md) · [`ai-review.md`](guides/manual/ai-review.md) |
| 管工作目录与存档 / 撤销回滚 | [`workspace.md`](guides/manual/workspace.md) · [`rollback.md`](guides/manual/rollback.md) |
| 改设置、登录账号、更新与排错 | [`settings.md`](guides/manual/settings.md) · [`account.md`](guides/manual/account.md) · [`update.md`](guides/manual/update.md) · [`troubleshoot.md`](guides/manual/troubleshoot.md) |
| 遇到问题 / 查英文原词 | [`faq.md`](guides/manual/faq.md) · [`glossary.md`](guides/manual/glossary.md) |
| 所有节点的逐项说明 | [`node-guide.md`](guides/manual/node-guide.md) · [`guides/nodes/`](guides/nodes/)（右键节点「节点指南」） |

## 安装

从[下载页面](http://mt-agent.com/mtnode)获取 Windows 安装包，一键安装后启动。应用自带更新：有新版本时右上角出现「更新」，确认后差分下载、静默安装并自动重启。

首次启动后到「设置 · API/配置」填写服务商与 API Key 即可开始编排。

## 从源码运行

需要 Node.js 与 npm，然后：

```bash
npm install
npm start
```

## 构建与发布

```bash
npm run compile       # 只编译 dist/win-unpacked（不打安装包）
npm run dist          # electron-builder 构建 NSIS 安装包（需要 node_modules 完整依赖）
npm run release       # 发版主链：一次同时出 NSIS 安装包 + Microsoft Store（MSIX）包
npm run release:store # 只出 Store 包（跳过 NSIS 打包与 stage-updates）
```

- **发版必须同时出两包，且两包版本号必须一致**：`npm run release`（[`scripts/release.mjs`](scripts/release.mjs)）先校验根 `version` 文件与 `package.json` / `dist/latest.yml` 版本一致（不一致直接报错退出），再依次跑 `npm run dist`、`make-msix.mjs --skip-build`（复用同一份 `win-unpacked`）、`stage-updates.mjs`，最后把 `.msix` 另存到 `dist\msix-publish\` 并打印 Partner Center 上传指引；MSIX 只能人工拖进上传框。
- 单跑 MSIX 用 `npm run dist:msix`；Store 链细节见 [`docs/msix-store-publish.md`](docs/msix-store-publish.md)。
- 版本号唯一真源是根目录 `version` 文件（格式 `x.y.z`），统一用 `node version.js bump` 递增，不要手改 `version` / `package.json`。
- 构建、发布与更新器细节见 [`scripts/UPDATES.md`](scripts/UPDATES.md)。

## 数据与隐私

所有工作流数据保存在本机（`%APPDATA%\pipeline-console\pipeline-console\save\`），不默认上传任何服务器；仅在你主动运行节点时，才把提示词与输入内容发送至你配置的服务商 API。使用「创意工坊」上传时，会将你选择的 `.mtnodes` 模板与预览图发至工坊服务器（`mt-agent.com`），下载为公开拉取。

- **隐私政策（线上）**：[简体中文](http://mt-agent.com/mtnode/privacy/) · [English](http://mt-agent.com/mtnode/privacy/en/)
- 政策正文源文件在 [`web/privacy/`](web/privacy/)，事实依据是 [`docs/privacy-data-inventory.md`](docs/privacy-data-inventory.md)；线上 URL 的唯一真源写法登记在 [`docs/msix-store-publish.md`](docs/msix-store-publish.md) §3。
- 联系渠道为 [GitHub Issues](https://github.com/shaomang/mtnode-aio/issues)（本项目不发布邮箱）。

## 版本更新

完整变更记录见 [`CHANGELOG-v1.1.md`](CHANGELOG-v1.1.md)；应用内「设置 · 版本更新」页（[`guides/manual/update.md`](guides/manual/update.md)）说明更新流程。

## 许可证

[MIT License](LICENSE)
