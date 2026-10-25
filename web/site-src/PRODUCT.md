# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

**未定 —— 本轮**明确**未向用户询问，不要由后续环节自行假定。**

现状事实（供决策）：

- `site-src\` 目前**没有站点代码**，只有 Impeccable 技能文件（`.claude` / `.agents` / `.cursor` / `.dsh` / `.opencode` / `.codex` / `.impeccable` / `node_modules`）与四份文档产物。
- 现行线上页面是**单文件内联**：`E:\dev\tools\pipeline-console\web\index.html`（621 行，纯文字、样式内联在 `<style>`，中英双语靠内联 `data-i18n` 字典，改版本只改 `VAR VER`）。
- 部署目标已定、且**约束技术选择**：静态托管在阿里云 OSS（bucket `mtnode-download`，`oss-cn-beijing`），key 为 `index.html` 与 `downloads/<file>`，线上入口 `http://mt-agent.com/mtnode/`。**没有服务端渲染能力**（`web/README.md` 的发布流程只有上传静态文件这一步）。
- 因此可选路径只有：① 继续单文件静态 HTML/CSS；② 引入模板生成器（构建时产出静态 `index.html`）；③ 其他静态方案。**这是用户决策，不是设计决策。**

记录方式遵循 Impeccable init 的口径：**「受约束的部署目标」已查清并在上方写明；「用什么构建」留给用户**。下一环节若仍未获答复，应再次提供选项，**不要默认落回单文件**。

## Users

**主要受众（2026-09 本轮确认）：独自做内容与软件的个人创作者。**

他们的处境与在做的事：

- 一个人同时扮演内容生产与软件开发两种角色，没有团队分工，没有专职设计师 / 剪辑 / 配音。
- 手上是零散的 AI 能力（聊天窗口、文生图、TTS、视频模型各一个网页），每换一件事就要换一个工具、重新描述一遍上下文。
- 要交付的东西是**串起来的**：一条选题 → 文案 → 配图 → 配音 → 成片，或者一个想法 → 架构 → 代码 → 验证，而单一 AI 工具只能完成其中一段。
- 机器条件是**单机 Windows**（有独立显卡的创作机 / 开发机），不是集群。

**他们在官网上的首要动作（本轮确认）：下载 Windows 桌面版安装包。**

不是留线索、不是看方案、不是读源码。判据：`web/downloads/` 里现成躺着可交付的双件（`MTNodeAIO-Setup-1.3.3.exe` 138039479 字节、`MTNodeAIO-src-1.3.3.zip` 8290467 字节），现行 `web/index.html` 的第一个内容区就是下载区（`#ctaSetup` → `downloads/MTNodeAIO-Setup-1.3.3.exe`）。

**次要受众（未确认，不写进页面主张）**：想二次开发 / 自行打包的人（源码包对他们有意义）；团队采购者（本仓库**没有任何**支撑他们的证据——无客户案例、无授权口径文档）。

## Product Purpose

MTNode（MTNode AI工作站 / MTNode AI Orchestrator）是一个 **Windows 桌面端 AI 工作流节点编排器**：把文本、图像、音乐、语音、视频生成与代码开发这些分散的 AI 能力，收束到**一张可视化画布**上，用节点与连线把它们串成一条能反复重跑的工作流。

它存在的理由：个人创作者缺的不是 AI 能力，而是**把多段能力接起来并反复执行**的地方。

**成功的定义**：用户装完之后，能把一件本来要在 4–5 个网站之间搬运的活，做成一张存下来就能一键重跑的画布；并且当这件事本身很长（要审批、要补素材、要并行、要驳回重做）时，画布还能**停在该停的地方等人**，而不是假装一次跑完。

## Positioning

**可对外主张的机制差异（由仓库文件直接支撑）：**

> **同一个 Agent 引擎，既在画布里当节点跑，又在会话里当助手用；而且画布里的子图还能被反向注册成这个 Agent 可以直接调用的工具。**

它不是「一个带 AI 功能的画布工具」，也不是「一个能画图的 Agent」——它是**同一套引擎的三种用法**：

1. **当助手**：一次 AI 协作就是一个会话，有状态、可开关，能读写文件、也能上网搜索（`guides/manual/dsh.md`）。
2. **当节点**：`agent_task`（智能任务）按任务描述读文件、联网、执行命令，结果回填输出；`proc_text` 可开「智能助手」进入 agent 模式（`guides/nodes/agent_task.md`、`guides/nodes/proc_text.md`）。
3. **被反过来调用**：`tool` 节点把画布子图注册成 Agent 可直接调用的工具，配置存在 `toolConfig`（`name` / `description` / `inputs` / `outputs`）（`guides/nodes/tool.md`）。

**同时，另外两条邻居难以照抄的机制：**

- **长周期任务 · 状态机 + 人在环**：把整件事画成一张状态机图，由应用按图推进，**该停的地方停下等你**（审批 / 交付两类人工环节，驳回必须写理由并退回你指定的环节重做）——`guides/manual/longtask.md`。
- **本机音视频/图像生成后端**：音乐、语音、视频、超分、补帧、本机图像生成各有一个**本地后端**节点，产物直接写进节点自带的 `outputPath`，不需要再挂保存节点——`guides/manual/media-gen.md`、`guides/nodes/*.md`。

**机制上的诚实边界**：上述「本机后端」需要用户自己的显卡（部分后端建议 24G 显存级别）；`tts_gen` 走独立进程、不占音视频全局锁，而音视频生成共享一把全局互斥锁（同一时刻只跑 1 个任务）。**不主张「什么机器都能跑」。**

## Operating Context

**运行环境（实测）**

| 项 | 口径 | 依据 |
| --- | --- | --- |
| 形态 | Electron 桌面应用（Windows） | `pipeline-console/package.json`、`build.json`、`main.js` |
| 安装形态 | NSIS 一键安装包 | `pipeline-console/installer.nsh`、`release-msix.cmd`、产物 `MTNodeAIO-Setup-*.exe` |
| 目标平台 | Windows 10 / 11 x64 | 现行 `web/index.html` 文案（`pill.win`）；本轮未在 guides 中另找依据 |
| 分发 | 阿里云 OSS，bucket `mtnode-download`，地域 `oss-cn-beijing` | `web/README.md` |
| 线上入口 | `http://mt-agent.com/mtnode/` | `web/index.html` 首行注释 |
| 官网产物 | 单页静态站点 + `downloads/` + `screenshot.png` | `web/index.html`（621 行）、`web/index.html.template`、`web/assets/`（仅 favicon.ico、icon.png 存档） |
| 现行页面形态 | **中文 / 英文双语内联**（`VER` 常量 + 大 `data-i18n` 字典；改版本只改 `VER`） | `web/index.html:387`、`web/index.html:400-562` |

**用户使用产品时的真实场景（由手册口径推出，非猜测）**

- 工作区是**本机文件夹**：节点写文件、跑命令都落在用户指定的画布工作目录。
- 用到一部分能力时要先**装后端**：音乐 / 视频 / 语音 / 图像生成各自有本地后端（含权重下载与显存要求），首次使用才拉起。
- 数据目录默认 `%APPDATA%\pipeline-console`；`guides/manual/longtask.md` 明写「一切用户数据都只在工作目录与 `%APPDATA%\pipeline-console\longtask\` 下，**不会写进应用安装目录**」。

**官网的写作纪律（现行页面的原文要求，本轮沿用）**

> `说明文字口径与仓库 README.md 与 guides/manual/ 手册保持一致` —— `web/index.html:9`

## Capabilities and Constraints

### 五项能力（本轮为官网提炼的对外口径，每条都有出处，详见 `content-facts.md`）

1. **内置 Agent 引擎** —— 同一个会话引擎同时驱动助手、智能节点与开发节点；四组开关：模型 · 预设档 · 思考强度 · 工具许可（`guides/manual/agent-nodes.md`）。
2. **长周期任务 · 状态机 + 人在环** —— 状态机图 + 两类人工环节（审批 / 交付），驳回必须写理由并回跳（`guides/manual/longtask.md`）。
3. **开发节点** —— 不是独立 kind，而是 `kind: "super"` + `dev: true` 的功能块，按画布反向搭建软件项目；核心文件字段 `devFiles` 上限 10 条（`docs/dev-node-design.md`）。
4. **音视频生成节点** —— `music_gen` / `yue_gen` / `tts_gen` / `video_gen` / `video_upscale` / `video_interp` / `remotion` / `sensenova_gen`，产物落节点自带 `outputPath`，音视频任务全局互斥（`guides/manual/media-gen.md`、`guides/nodes/index.json`）。
5. **其他节点能力** —— 超级节点（子图 + 边界端子）、工具 / 函数节点（`toolConfig` / `jscode`）、审批权限、多供应商路由（服务商可自建、按 run 下发 `providerId / provider / model`）、批量（`batchMode`：batch 逐条 / 聚合一次看全部）、创意工坊（模板画布 + `SKILL.md` 技能）（`guides/manual/*.md`、`guides/nodes/*.md`）。

### 版本与文件名口径（本轮确认）

`web/downloads/` 里**实际存在**的两个文件名，就是页面要用的口径：

- `MTNodeAIO-Setup-1.3.3.exe` —— 138039479 字节
- `MTNodeAIO-src-1.3.3.zip` —— 8290467 字节

现行 `web/index.html:387` 的 `var VER = "1.3.3";` 与之一致。

### 明确未决 / 有意不写（不得由后续环节自行补全）

1. **「永久免费 / MIT 开源」这类主张本轮从官网移出。**
   - **证据是存在的**：`pipeline-console/LICENSE` 是 MIT License（`Copyright (c) 2026 M.S`）。
   - **但用户本轮明确选择**：官网只写「代码 / 文档里能验证的能力与路径」，**不写价格、授权、开源、免费**主张。
   - **由此产生一处与现行页面的显式冲突**：现行 `web/index.html` 有 `pill.free`「永久免费 · MIT」、`oss.h`「永久免费开源」整节（`index.html:340-342`、`471-472`）。**这是有意移除，不是遗漏**；是否彻底下线该节需产品确认。
2. **「数据不出本机」不能整体照写。** 用户允许写「本地优先」，但 `docs/privacy-data-inventory.md` 记录存在出网面：① 用户自配的 AI 服务商 API；② `mt-agent.com`（更新 / 插件目录 / 创意工坊 / 讨论区 / 桌宠 / 本地后端下载）。**因此官网只能写「工作区文件、画布、长期记忆与交付物留在本机数据目录」这一精确表述**，不得写「数据不出本机」。可用的正面证据：`docs/privacy-data-inventory.md:133`（所有 `*.html` 外链资源零匹配、CSP `connect-src 'self'`）、`crash-report.js` 无 `http` / `fetch` 且导出内容显式声明不含 API Key。
3. **Stack 未决**：`site-src/` 目前只有 Impeccable 技能与 `node_modules`，**没有站点代码**。构建方式（沿用现行单文件内联 `index.html` / 改为模板生成 / 其他）由用户在下一环节决定。
4. **受众只确认了主受众。** 团队采购者、二次开发者是否需要专属内容，未确认。
5. **现行页面的既有不一致（待修，不要在官网继承）**：`verTag` 显示 `v1.3.3`（`index.html:188`）而同一页 `pill.ver` 写「v1.1 大版本」（`index.html:204`）；`meta description` 也停留在「MTNode AI工作站 v1.1」（`index.html:16`）。

## Brand Commitments

| 项 | 口径 | 依据 |
| --- | --- | --- |
| 中文名 | **MTNode AI工作站** | `web/index.html` `<title>`、`web/README.md` |
| 英文名 | **MTNode AI Orchestrator** | `web/index.html.template:6` |
| 简称 | MTNode | 全仓库通用 |
| 术语统一 | **「思考强度」（英文 thinking effort）**——这是明确下达的统一口径 | `guides/manual/README.md:34` |
| 语气来源 | 与 `pipeline-console/README.md` 及 `guides/manual/` 手册保持一致 | `web/index.html:9` 原文要求 |
| 署名 | 现行页 footer 署名 `ms2308`；LICENSE 署名 `Copyright (c) 2026 M.S` —— 两处不一致，**本轮不动，标为待确认** | `web/README.md`、`pipeline-console/LICENSE` |
| 视觉约束 | 官网与桌面应用**同一套视觉语言**，真源 = `renderer/css/base.css`（本轮确认；详见 `design-tokens.md` 与 `DESIGN.md`） | 本轮用户决策 |

## Evidence on Hand

**可上官网的真实材料（路径均实测存在）**

| 材料 | 路径 | 说明 |
| --- | --- | --- |
| 应用内手册（中文，21 页 / 10 章） | `E:\dev\tools\pipeline-console\guides\manual\*.md` | 官网文案的**唯一事实源**；含 `en/` 英文版 |
| 节点文档 | `E:\dev\tools\pipeline-console\guides\nodes\*.md` | 每个节点 kind 的端子 / 参数口径 |
| 内部设计文档 | `E:\dev\tools\pipeline-console\docs\*.md` | 开发节点设计、长周期任务审计、隐私清单、模型路由设计等 |
| 安装包 / 源码包 | `E:\dev\tools\pipeline-console\web\downloads\MTNodeAIO-Setup-1.3.3.exe`、`MTNodeAIO-src-1.3.3.zip` | 官网下载区的**真实目标文件** |
| 应用截图 | `E:\dev\tools\pipeline-console\web\screenshot.png` | 现行 OG image |
| 图标 | `E:\dev\tools\pipeline-console\web\assets\icon.png`、`favicon.ico` | 仅这两个 |
| 许可证 | `E:\dev\tools\pipeline-console\LICENSE` | MIT License（**本轮不对外主张**，见上） |
| 现行页面（可当改版基线） | `E:\dev\tools\pipeline-console\web\index.html`（621 行，含完整中英 i18n 字典）、`index.html.template` | 改版时的文案资产 |
| 事实提炼中间产物 | `site-src\content-facts.md` | 五项能力逐条带出处，供页面直接用 |
| 令牌实测台账 | `site-src\design-tokens.md` | 官网配色 / 字体 / 圆角的数值依据 |

**不得编造的缺失项（本仓库里没有任何依据）**

- ❌ 客户案例、使用方名称、访谈引语
- ❌ 用户数、下载量、增长数据、性能基准数字（如「快 10 倍」）
- ❌ 第三方媒体 / 评测 / 获奖
- ❌ 定价、订阅层级、SLA、企业授权条款
- ❌ 与竞品的对比结论

## Product Principles

1. **口径跟着仓库走，不跟着文采走。** 页面上每一句可验证的话都必须能在 `guides/` 或 `docs/` 里指出出处；查不到的**不写**，而不是写得好听一点。（`web/index.html:9` 已经把这条定为现行纪律。）
2. **先讲能接起来，再讲单点能力。** 用户的痛点是「能力散在几个网站之间」，所以官网的主叙事是**一张画布把多段能力接起来并反复重跑**，不是罗列模型清单。
3. **诚实标注前提，不承诺机器无关。** 本机后端有显存与磁盘门槛、音视频任务全局互斥、部分后端要单独安装——这些前提要写在能力旁边，而不是藏在 FAQ 里。做不到的宁可不说。
4. **同一个动作只有一个入口。** 首要动作是「下载安装包」，它必须在首屏可见且文案统一（现行页面已把下载区放在第一个内容区，这条继续）。
5. **未决就标未决。** 授权口径、Stack、次要受众目前都没定——页面上留白或标注，**不允许用通用文案填满**。

## Accessibility & Inclusion

本轮未确立任何产品专属的无障碍要求。**留空，不编造标准声明**（不写「符合 WCAG 2.1 AA」这类无依据的合规主张）。

已实测到的、可沿用的技术事实（不是合规声明，只是实现现状）：`base.css` 顶层写 `html { color-scheme: dark }`，并保留 `body.theme-light` 亮色主题；`renderer/css/theme-light.css` 缺少对 `.app-docs` 的覆盖（`guides/manual/README.md:89-92` 记录了 3 处硬编码深色值）。官网若做亮色支持，**不能照抄这三处硬编码**。