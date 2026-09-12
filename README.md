# MTNode AI编排器

把复杂 AI 工作流收束到一张可视化画布上的 Windows 桌面工具：文本 / 图像输入、LLM 文本处理与图像生成、音乐 / 视频生成、批量处理、任务控制流、AI Agent 会话，都以节点自由编排。

**永久免费开源**（MIT License）：无收费、无订阅，随版本提供源码包；工作流可导出为 `.mtnodes` 包无损分享。当前版本 **1.2.9**。

- **下载页面**：[http://mt-agent.com/mtnode](http://mt-agent.com/mtnode)（Windows 安装包与源码包）
- **应用内手册**（右上角「文档」，源码在 [`guides/manual/`](guides/manual/)，目录见 [`index.json`](guides/manual/index.json)）
- **节点指南**（节点右键「节点指南」，源码在 [`guides/nodes/`](guides/nodes/)）
- **变更记录**：[`CHANGELOG-v1.1.md`](CHANGELOG-v1.1.md)

## Quick start

应用内置一张「快速开始」画布，按十个分区把从配置到出片的流程依次摆开：**准备工** · **内容生成** · **全局助手与工作流** · **开发节点** · **会话** · **工具 / 函数节点** · **素材库** · **专家团** · **社区** · **其他**。每个分区只需要改输入、点该区的 ▶ 一键重跑。

| 我想…… | 去哪里 |
| --- | --- |
| 拿到 API Key 并填进 MTNode | [`providers.md`](guides/manual/providers.md)（Key 只存本机） |
| 搭一条「输入 → 处理 → 保存」的流水线 | [`io-proc.md`](guides/manual/io-proc.md) |
| 出音乐 / 语音 / 视频 | [`media-gen.md`](guides/manual/media-gen.md) |
| 让 AI 审阅、批注并修订文本 | [`ai-review.md`](guides/manual/ai-review.md) |
| 改图与蒙版局部重绘 | [`image-edit.md`](guides/manual/image-edit.md) |
| 一句话让助手搭一条工作流 | [`quick-build.md`](guides/manual/quick-build.md) |
| 看画布里的五条示例链、一键重跑 | [`workflows.md`](guides/manual/workflows.md) |
| 加节点、连线与 @ 引用 | [`nodes-wires.md`](guides/manual/nodes-wires.md) |
| 框选、分组、分区与排版 | [`marks-groups.md`](guides/manual/marks-groups.md) |
| 撤销、重做与回滚 | [`rollback.md`](guides/manual/rollback.md) |
| 把逻辑固化成工具节点 / 函数节点 | [`tools-functions.md`](guides/manual/tools-functions.md) |
| 管理素材库 | [`asset-library.md`](guides/manual/asset-library.md) |
| 让 Agent 干活：智能任务与智能会话 | [`agent-nodes.md`](guides/manual/agent-nodes.md) · [`dsh.md`](guides/manual/dsh.md) |
| 管权限与审批 | [`approvals.md`](guides/manual/approvals.md) |
| 按模块搭建软件项目（开发节点） | [`dev-nodes.md`](guides/manual/dev-nodes.md) |
| 让多个 AI 角色协作（专家团） | [`one-person-company.md`](guides/manual/one-person-company.md) |
| 逛创意工坊、去讨论区提问 | [`community.md`](guides/manual/community.md) |
| 查英文原词 / 遇到问题 | [`glossary.md`](guides/manual/glossary.md) · [`faq.md`](guides/manual/faq.md) |
| 所有节点的逐项说明 | [`guides/nodes/`](guides/nodes/)（右键节点「节点指南」） |

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
