<div align="center">

<img src="mtnode-icon-108.png" alt="MTNode AI工作站" width="84" height="84" />

# MTNode AI工作站

**基于 DeepSeek Harness 核心扩展而成的本机优先 AI 工作站**

会话 · 画布 · 应用 · 扩展 —— 同一个本机 Agent 内核，服务四类核心场景

[![Version](https://img.shields.io/badge/version-v1.7.12-ff8f2e?style=flat-square)](changelog/v1.7.12.md)
[![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11%20x64-38d6ff?style=flat-square)](https://www.mt-agent.com/mtnode/)
[![License](https://img.shields.io/badge/license-MIT-8dde71?style=flat-square)](LICENSE)
[![QQ Group](https://img.shields.io/badge/官方%20QQ%20群-971061784-a48bff?style=flat-square)](#交流与反馈)

[官网与交互演示](https://www.mt-agent.com/mtnode/) · [下载 Windows 安装包（v1.7.12）](https://www.mt-agent.com/mtnode/updates/MTNodeAIO-Setup-1.7.12.exe) · [更新日志](changelog/README.md) · [使用手册](guides/manual/) · [反馈讨论](https://github.com/shaomang/mtnode-aio/issues)

</div>

---

## 简介

**MTNode AI工作站（MTNode AI Orchestrator）** 是一款**永久免费开源（MIT）、本机优先**的 Windows AI 编排桌面应用。

它以 **DeepSeek Harness** 为核心引擎，将 **Agent 会话执行台、可视化多模态节点画布、轻量桌面应用工坊、本地模型与插件生态** 整合进同一套桌面体验——无需折腾零散命令行和插件配置，数据与密钥默认全部留在你的本机。

---

## 四条执行线，一个本机大脑

| 模块 | 面向人群 | 解决的痛点与核心能力 |
| --- | --- | --- |
| **01 · 会话（Session）** | `dsh` / Codex 使用者 | 开箱即用的 Agent 桌面执行台。支持工作区隔离、计划卡审批、逐工具调用轨迹与文件 diff、**运行中插话 / 暂停**、**白话简报模式**、「AI 工作中」进度台、输入补全、快捷会话（`F1`）与语音播报/听写。 |
| **02 · 画布（Canvas）** | AI 内容创造者 | 无限节点画布统一编排文本、图像、语音、音乐、视频、音频分析与脚本。支持 `@` 直接引用上游节点、**仅重跑修改分支**、节点层封装复用、素材库联动、审阅批注，以及一句话让画布助手搭出整条流程。 |
| **03 · 应用（Apps）** | 有具体工具需求的人 | 无需从零搭框架，在应用开发视图中用对话让 Agent 搭建专属小工具。内置实时热更新预览、diff 改动抽屉、**声明式能力注入**（顶栏、听写、图像生成、语音合成、画布读写、Agent 调用），可弹出独立窗口运行或嵌入画布。 |
| **04 · 扩展（Extensions）** | 想低成本聚合能力的人 | 内置插件控制台，支持硬件门槛探测与一键安装自检（如 `llama.cpp`、Qwen Image、FLUX 3 Klein、Breeze / MOSS-TTS、MOSS-Music、YuE2、Remotion、数字人、Blender 等）；画布流程可一键存为工具供会话直接调用；同时支持 **MCP 服务端** 与 **Paseo 手机端远程接管会话**。 |

此外，工作站还提供 **专家团（多角色协作与 AI 事实库）** 与 **研究视图（笔记 · 知识图谱 · 文献库 · 演示生成）**，界面完整支持**中 / 英文双语**与明暗主题切换。

---

## 快速安装

### Windows 安装包（推荐）

1. 前往 [官方下载页](https://www.mt-agent.com/mtnode/) 或直接下载最新版安装程序：
   - **[MTNodeAIO-Setup-1.7.12.exe](https://www.mt-agent.com/mtnode/updates/MTNodeAIO-Setup-1.7.12.exe)**（Windows 10 / 11 · x64）
2. 双击安装后直接启动，无需手动配置运行环境。
3. 首次启动后进入 **设置 → 服务商与 API** 填入 API Key（仅保存在本机）即可开始使用。

> 应用内置**后台差分更新**：检测到新版本后仅下载变更块，准备好后由你点击「重启并更新」即可切换至最新版（Microsoft Store 版由商店托管更新）。

### 从源码运行

需要安装 **Node.js**（推荐 LTS）与 **npm**：

```bash
git clone https://github.com/shaomang/mtnode-aio.git
cd mtnode-aio
npm install
npm start
```

运行测试套件：

```bash
npm test
```

---

## 核心特性速览

- **可控的 Agent 会话体验**：开跑前用一排开关对齐工作区、模型/思考强度、技能与工具权限；复杂任务先出计划再动手；执行中随时插话纠偏，并可在「原始 / 简报」视图间切换阅读进度。
- **多模态创作流水线**：在同一张画布里串联文生文、文生图、局部重绘、语音合成/识别、音乐生成、视频制作与批量处理，跑通后导出 `.mtnodes` 文件即可无损分享或上架创意工坊。
- **对外开放 MCP 服务端**：支持 HTTP / stdio 接入，对外暴露 **19 个 MCP 工具**（涵盖画布读写、节点执行、多模态生成、应用控制、会话驱动、素材与事实库操作等），可让 Claude Code、Cursor 或自研 Agent 直接操控本机 MTNode。详见 [`guides/manual/mcp-server.md`](guides/manual/mcp-server.md) 与 [`guides/mcp-tools.md`](guides/mcp-tools.md)。
- **手机端远程接管（Paseo）**：配对后可在手机端查看并接管本机 Agent 会话，出门在外也能插话、审批与继续推进长任务。详见 [`guides/manual/paseo-bridge.md`](guides/manual/paseo-bridge.md)。

---

## 使用手册与文档导航

应用右上角「文档」内置完整手册，节点右键可直达「节点指南」。仓库内源码索引如下：

| 我想…… | 文档入口 |
| --- | --- |
| 配置服务商与 API Key | [`guides/manual/providers.md`](guides/manual/providers.md) |
| 搭建「输入 → 处理 → 保存」流水线 | [`guides/manual/io-proc.md`](guides/manual/io-proc.md) |
| 生成音乐 / 语音 / 视频 | [`guides/manual/media-gen.md`](guides/manual/media-gen.md) · [`moss-music.md`](guides/manual/moss-music.md) |
| 图像编辑、局部重绘与 AI 文本审阅 | [`guides/manual/image-edit.md`](guides/manual/image-edit.md) · [`ai-review.md`](guides/manual/ai-review.md) |
| 节点连线、`@` 引用、分组排版与回滚 | [`guides/manual/nodes-wires.md`](guides/manual/nodes-wires.md) · [`marks-groups.md`](guides/manual/marks-groups.md) · [`rollback.md`](guides/manual/rollback.md) |
| 一句话让助手搭工作流 / 长周期任务 | [`guides/manual/quick-build.md`](guides/manual/quick-build.md) · [`longtask.md`](guides/manual/longtask.md) |
| 智能会话、浏览器能力、权限审批与输入补全 | [`guides/manual/dsh.md`](guides/manual/dsh.md) · [`agent-browser.md`](guides/manual/agent-browser.md) · [`approvals.md`](guides/manual/approvals.md) · [`fim.md`](guides/manual/fim.md) |
| 开发专属应用并上架 | [`guides/manual/app-dev.md`](guides/manual/app-dev.md) · [`app-publish.md`](guides/manual/app-publish.md) · [`dev-nodes.md`](guides/manual/dev-nodes.md) |
| 封装工具 / 函数节点与素材库管理 | [`guides/manual/tools-functions.md`](guides/manual/tools-functions.md) · [`asset-library.md`](guides/manual/asset-library.md) |
| 专家团多角色协作、AI 事实库与研究视图 | [`guides/manual/one-person-company.md`](guides/manual/one-person-company.md) · [`ai-facts.md`](guides/manual/ai-facts.md) · [`research.md`](guides/manual/research.md) |
| 接入第三方 MCP 客户端 / Paseo 手机接管 | [`guides/manual/mcp-server.md`](guides/manual/mcp-server.md) · [`paseo-bridge.md`](guides/manual/paseo-bridge.md) |
| 创意工坊、名词表、常见问题与节点指南 | [`guides/manual/community.md`](guides/manual/community.md) · [`glossary.md`](guides/manual/glossary.md) · [`faq.md`](guides/manual/faq.md) · [`guides/nodes/`](guides/nodes/) |

---

## 更新日志

最新版本：**v1.7.12（2026-11-26）** —— 插件支持一键清理产出物缓存，轻松释放磁盘空间。

- 完整版本索引见 [`changelog/README.md`](changelog/README.md)（已收录 67 个正式版本记录）
- 也可在 [官网更新日志页](https://www.mt-agent.com/mtnode/#changelog) 按分类筛选或搜索历史改动

---

## 构建与发布（开发者）

```bash
npm run compile        # 仅编译 dist/win-unpacked（本地调试，不打安装包）
npm run dist           # electron-builder 构建 NSIS 安装包
npm run release        # 发版主链：同时产出 NSIS 安装包 + Microsoft Store（MSIX）包并同步源码
npm run release:store  # 仅产出 Store（MSIX）包
npm run store:publish  # 自动上传 MSIX 包并提交 Microsoft Store 审核
```

- 版本号唯一真源为根目录 [`version`](version) 文件，升版请统一使用 `node version.js bump`（避免手改 `package.json`）。
- 打包、差分更新通道与发版流程详见 [`scripts/UPDATES.md`](scripts/UPDATES.md)。

---

## 数据与隐私

- **本机优先**：所有工作流、会话记录、配置与 API Key 均保存在本机（默认 `%APPDATA%\pipeline-console\` 或你指定的数据目录），不默认向任何第三方服务器上传你的数据。
- **按需外发**：仅在你主动运行节点或会话时，才将对应请求发往你自行配置的模型服务商；仅在你主动上传「创意工坊 / 应用中心」时，才将选定的模板、应用包与预览图发送至社区服务器（`mt-agent.com`）。

---

## 交流与反馈

- **官方 QQ 交流群**：`971061784`
- **问题反馈与功能建议**：[GitHub Issues](https://github.com/shaomang/mtnode-aio/issues)
- **官网与在线演示**：https://www.mt-agent.com/mtnode/

---

## 开源许可

本项目基于 [MIT License](LICENSE) 开源，永久免费使用。
