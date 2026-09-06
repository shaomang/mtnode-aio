# MTNode 内置 Agent 技能索引

以下条目仅含摘要。**不要**一次性读取全部 SKILL.md。

调取方式（任选其一）：
1. `skill` 工具：`skill` 参数为下表 `name`（已注册到 DSH_HOME/skills，带 `.mtnode-internal` 标记）。
2. `read` 工具：路径 `$DSH_HOME/mtnode-agent-skills/<path>`。

## MTNode 产品与画布

- **mtnode-canvas-batch-safety** — 画布批量与文生图防 N²：MTNode 画布 batchMode=batch 时每次运行只能处理单条输入，禁止把整批 N 条重复塞进每次运行；文生图 proc_image 每次只出 1 张。Use when designing batch workflows, proc_image, split nodes, or user reports duplicate API calls / token explosion.
  - 文件：`mtnode/canvas-batch-safety/SKILL.md`
- **mtnode-canvas-layout-ux** — 画布排版与可操作区：MTNode 画布节点排版：可编辑/控制节点靠上（小 y），处理与保存靠下或右侧；createMarks 分区、control 一键重跑；禁止 agent 调用 layout action。Use when auto-layout, createMarks, control nodes, or improving canvas UX for the user.
  - 文件：`mtnode/canvas-layout-ux/SKILL.md`
- **mtnode-db-facts** — 数据库事实查询纪律：任务接入数据库副本节点（db_replica）时的强制事实纪律：一切事实走 mtnode_db 工具（list/query/get/calc）、断言必须带 [记录id · 标题] 引用、查不到就说「数据库中没有该信息」、数字走 calc、禁止用记忆补全。Use when the task is wired to a database replica or asks about stored facts.
  - 文件：`mtnode/db-facts/SKILL.md`
- **mtnode-dev-architect** — 开发节点架构师：用「开发节点」（super + dev:true 的项目功能块）在 MTNode 画布上搭建/分析软件项目架构。模式 A：扫描已有项目，生成覆盖全项目的开发节点架构图（不确定处询问用户）；模式 B：新项目先搭架构、用户明确「确认」后按画布逐块搭建项目。生成开发节点时同步在项目根产出 AGENTS.md 共识文件（目录约定 / 不要修改清单），所有建议 / 开发 / 细化会话先读并遵守，并在最外层建 agent.md 入口文件节点（应用内 Markdown 阅读器可查看 / 编辑 / 保存）。每个功能块可用 devModel / devPreset / devEffort 指定 Agent 模型、预设与思考强度（建议 / 开发 / 细化与问询会话都按这三项下达，三项各自就近向上继承、互不牵连，思考档只由设置决定 · 界面回显即实际下发），可用 devColor 自定义外框颜色，可用 devF
  - 文件：`mtnode/dev-architect/SKILL.md`
- **mtnode-grill-me** — 拷问我：需求拷问：把任务映射成决策树，按轮问完整个「前沿」（前置已定的全部问题）；每轮必须用 ask_user_question 工具跳出 MTNode 询问窗（一次带上整个前沿，禁止把问题当聊天正文罗列），每题选项把推荐项放第一位标「（推荐）」；环境事实自己查绝不问用户；直到前沿为空且用户在询问窗里确认达成共识才动手。Use when the user says 拷问我 / grill me / 先问清再动手 / 需求不明确, or a dev-node 开发 run turns on 先拷问需求.
  - 文件：`mtnode/grill-me/SKILL.md`
- **mtnode-media-gen-nodes** — 音乐/语音/视频生成节点：MTNode music_gen / tts_gen / video_gen 节点：MiniMax Music 3、SoVITS 语音、H3 后端、输出路径 outputPath、抽卡次数、种子 +1、全局仅 1 个音视频任务互斥、媒体输入端子走 file:/// URL。Use when wiring music_gen, tts_gen, video_gen, media output paths, gacha rolls, or VRAM-related concurrency errors.
  - 文件：`mtnode/media-gen-nodes/SKILL.md`
