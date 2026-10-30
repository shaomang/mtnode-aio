# MTNode 内置 Agent 技能索引

以下条目仅含摘要。**不要**一次性读取全部 SKILL.md。

调取方式（任选其一）：
1. `skill` 工具：`skill` 参数为下表 `name`（已注册到 DSH_HOME/skills：front matter 无 `menu` 的带 `.mtnode-internal` 标记，只在内置索引里对模型可见；写了 `menu: user` 的带 `.builtin` 标记，同时出现在用户技能清单与「/」菜单里，标「内置」只读）。
2. `read` 工具：路径 `$DSH_HOME/mtnode-agent-skills/<path>`。

## 应用开发

- **impeccable** — Impeccable（前端设计规范）：前端界面设计 / 改版 / 评审：视觉层级、排版、动效、可访问性与设计系统。
  - 文件：`app/impeccable/SKILL.md`
- **mtnode-app-dev** — MTNode 应用开发：开发 MTNode「应用」（应用中心 / 插件 kind=window）：静态页契约、两套宿主桥、能力位、数据落盘与常见坑。
  - 文件：`app/app-dev/SKILL.md`
- **mtnode-app-merge** — MTNode 应用版本合并：把云端「对方那一版」按用户逐项确认合进本机应用目录的合并会话流程（不改版本号、不自动上架）。
  - 文件：`app/app-merge/SKILL.md`

## 图像生成（Qwen Image）

- **qwen-image-prompt** — Qwen Image 2.1 提示词：【内置】把一句话需求写成 Qwen Image 2.1 能出图的提示词（文生图 / 多图编辑 / 文字密集图 / 分镜，含官方骨架与防错约束）。
  - 文件：`image/qwen-image-prompt/SKILL.md`

## MTNode 产品与画布

- **mtnode-ai-facts** — AI 事实库：画布 AI 事实库（mtnode_facts）：建架构 / 工作流前先查，定下约定与路径后写回关键结论。
  - 文件：`mtnode/ai-facts/SKILL.md`
- **mtnode-canvas-batch-safety** — 画布批量与文生图防 N²：画布 batchMode=batch 每次只处理单条、proc_image 每次只出 1 张（防 N² 调用）。
  - 文件：`mtnode/canvas-batch-safety/SKILL.md`
- **mtnode-canvas-edit-rules** — 画布编辑硬规则：建图 / 连线 / 批量的完整硬规则（kind、super 端子、@引用、save 与 wait_file、排版）；工具描述只留卡口。
  - 文件：`mtnode/canvas-edit-rules/SKILL.md`
- **mtnode-canvas-layout-ux** — 画布排版与可操作区：画布排版：控制与可编辑节点靠上、处理与保存靠下，createMarks 分区，禁止调 layout。
  - 文件：`mtnode/canvas-layout-ux/SKILL.md`
- **mtnode-db-facts** — 数据库事实查询纪律：接入数据库副本（db_replica）时的事实纪律：一切事实走 mtnode_db、断言带记录引用、查不到就说没有。
  - 文件：`mtnode/db-facts/SKILL.md`
- **mtnode-dev-architect** — 开发节点架构师：在画布上用开发节点（super + dev）搭建 / 分析项目架构（模式 A 扫描 / 模式 B 新建，含细化与总量护栏）；只在用户要求建架构时用。
  - 文件：`mtnode/dev-architect/SKILL.md`
- **mtnode-grill-me** — 拷问我：需求拷问：动手前用 ask_user_question 按轮问完整个决策前沿，用户确认共识再开工。
  - 文件：`mtnode/grill-me/SKILL.md`
- **mtnode-local-media** — 本地语音与视频分析：听音频 / 做字幕 / 看视频用本机 audio_subtitle、audio_transcribe、ffmpeg，别另装 ASR。
  - 文件：`mtnode/local-media/SKILL.md`
- **mtnode-mcp-server** — MTNode MCP 服务端（第三方接进来操作）：从 MTNode 外面经 MCP 操作本机 MTNode：14 个工具、先读图拿 contentHash、权限与审计。
  - 文件：`mtnode/mcp-server/SKILL.md`
- **mtnode-media-gen-nodes** — 音乐/语音/视频生成节点：music_gen / yue_gen / breeze_gen / video_gen：输出路径、抽卡、单任务互斥与媒体端子。
  - 文件：`mtnode/media-gen-nodes/SKILL.md`
- **mtnode-self-check** — 自检与交付纪律：自检与交付纪律：阶段自检、交付前全检、先自修再问人、硬断言带证据。
  - 文件：`mtnode/self-check/SKILL.md`
- **mtnode-verify-in-app** — 真机自验（改 MTNode 时怎么验）：改 MTNode 自身功能时起独立数据目录的开发态实例、用 MCP 驱动真实窗口截图自验。Use when developing MTNode itself (plugin / app window / renderer UI) and you must prove it really works. 做不到就如实写「未验证 + 原因」。
  - 文件：`mtnode/verify-in-app/SKILL.md`
- **mtnode-workflow-design** — 工作流设计：把一段流程搭成画布节点层（super）：外侧端子自洽、入口 → 处理 → 保存可一键重跑。
  - 文件：`mtnode/workflow-design/SKILL.md`

## 音乐生成（MiniMax Music）

- **breeze-script-format** — Breeze 台词规范：【内置】把台词规范成 Breeze TTS 2 能念的正文：语气走 instruction、发声事件内联、口播安全化。
  - 文件：`music/breeze-script-format/SKILL.md`
- **breeze-voice-design** — Breeze 音色设计：【内置】把一句话需求扩成 Breeze TTS 2 音色提示词（简洁 / 详细两档）。
  - 文件：`music/breeze-voice-design/SKILL.md`
- **minimax-music-lyrics** — MiniMax Music 歌词：【内置】按官方规范写可演唱的 MiniMax Music 歌词正文（结构标签、行长、副歌钩子）。
  - 文件：`music/minimax-music-lyrics/SKILL.md`
- **minimax-music-prompt** — MiniMax Music 提示词：【内置】把一句话想法写成 MiniMax Music 风格提示词（英文六句：风格→速度→乐器→人声→结构→制作）。
  - 文件：`music/minimax-music-prompt/SKILL.md`

## 插件与后端

- **mtnode-plugin-dev** — MTNode 插件开发规范：MTNode 应用插件（catalog 窗口 / builtin / 本地后端）的开发规范：三层结构、接线点、打包与交付清单。
  - 文件：`plugins/plugin-dev/SKILL.md`

## 视频生成（MiniMax H3）

- **h3-dynamic-still-prompt** — H3 动态静图（首尾帧）：把一张静图做成可无缝循环的微动背景：识图、归一化、搭 H3 首尾帧工作流、写中文提示词、PSNR 验缝。
  - 文件：`video/h3-dynamic-still-prompt/SKILL.md`

## 写作与润色

- **humanizer-zh** — 去 AI 味与写作润色：润色中文文稿：删空话与套路，保留事实与作者声音
  - 文件：`writing/humanizer-zh/SKILL.md`
