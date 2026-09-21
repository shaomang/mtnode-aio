# MTNode 内置 Agent 技能索引

以下条目仅含摘要。**不要**一次性读取全部 SKILL.md。

调取方式（任选其一）：
1. `skill` 工具：`skill` 参数为下表 `name`（已注册到 DSH_HOME/skills：front matter 无 `menu` 的带 `.mtnode-internal` 标记，只在内置索引里对模型可见；写了 `menu: user` 的带 `.builtin` 标记，同时出现在用户技能清单与「/」菜单里，标「内置」只读）。
2. `read` 工具：路径 `$DSH_HOME/mtnode-agent-skills/<path>`。

## MTNode 产品与画布

- **mtnode-ai-facts** — AI 事实库：每张画布一份的极简条例库（工具 mtnode_facts，动作 list/query/get/write/delete/pin）：索引项目内容时先查它；建完项目架构 / 工作流、定下约定与路径后，把关键结论（模块划分、关键文件与路径、约定及其来源、端口与数据流、命令入口、已知坑）沉淀成极简条例。先 query 再 write，冲突以现文件与数据库为准。Use when indexing project content, or recording / recalling a project's architecture or workflow key points.
  - 文件：`mtnode/ai-facts/SKILL.md`
- **mtnode-canvas-batch-safety** — 画布批量与文生图防 N²：MTNode 画布 batchMode=batch 时每次运行只能处理单条输入，禁止把整批 N 条重复塞进每次运行；文生图 proc_image 每次只出 1 张。Use when designing batch workflows, proc_image, split nodes, or user reports duplicate API calls / token explosion.
  - 文件：`mtnode/canvas-batch-safety/SKILL.md`
- **mtnode-canvas-edit-rules** — 画布编辑硬规则：MTNode 画布建图 / 连线 / 批量的完整硬规则：kind 速查、task 三端、super 边界端子、tool/function 参数即端子、@引用三条件、save 与 wait_file、批次与文生图、数据库 / 开发节点 / 排版 / scope 细则。Use when creating, wiring, batching or laying out canvas nodes, or when a wire/tool receipt looks wrong. 这些规则不写在 mtnode_canvas_edit 描述里，按需加载本技能。
  - 文件：`mtnode/canvas-edit-rules/SKILL.md`
- **mtnode-canvas-layout-ux** — 画布排版与可操作区：MTNode 画布节点排版：可编辑/控制节点靠上（小 y），处理与保存靠下或右侧；createMarks 分区、control 一键重跑；禁止 agent 调用 layout action。Use when auto-layout, createMarks, control nodes, or improving canvas UX for the user.
  - 文件：`mtnode/canvas-layout-ux/SKILL.md`
- **mtnode-db-facts** — 数据库事实查询纪律：任务接入数据库副本节点（db_replica）时的强制事实纪律：一切事实走 mtnode_db 工具（list/query/get/calc）、断言必须带 [记录id · 标题] 引用、查不到就说「数据库中没有该信息」、数字走 calc、禁止用记忆补全。Use when the task is wired to a database replica or asks about stored facts.
  - 文件：`mtnode/db-facts/SKILL.md`
- **mtnode-dev-architect** — 开发节点架构师：用「开发节点」（super + dev:true 的项目功能块）在 MTNode 画布上搭建/分析软件项目架构。模式 A：扫描已有项目，生成覆盖全项目的开发节点架构图（不确定处询问用户）；模式 B：新项目先搭架构、用户明确「确认」后按画布逐块搭建项目。生成开发节点时同步在项目根产出 AGENTS.md 共识文件（目录约定 / 不要修改清单），所有建议 / 开发 / 细化会话先读并遵守，并在最外层建 agent.md 入口文件节点（应用内 Markdown 阅读器可查看 / 编辑 / 保存）。每个功能块可用 devModel / devPreset / devEffort 指定 Agent 模型、预设与思考强度（建议 / 开发 / 细化与问询会话都按这三项下达，三项各自就近向上继承、互不牵连，思考档只由设置决定 · 界面回显即实际下发），可用 devColor 自定义外框颜色，可用 devF
  - 文件：`mtnode/dev-architect/SKILL.md`
- **mtnode-grill-me** — 拷问我：需求拷问：把任务映射成决策树，按轮问完整个「前沿」（前置已定的全部问题）；每轮必须用 ask_user_question 工具跳出 MTNode 询问窗（一次带上整个前沿，禁止把问题当聊天正文罗列），每题选项把推荐项放第一位标「（推荐）」；环境事实自己查绝不问用户；直到前沿为空且用户在询问窗里确认达成共识才动手。共识若含审批 / 交付 / 驳回回跳 / 并行 / 子图，产出的是长周期任务图（DAG）JSON。Use when the user says 拷问我 / grill me / 先问清再动手 / 需求不明确, or a dev-node 开发 run turns on 先拷问需求.
  - 文件：`mtnode/grill-me/SKILL.md`
- **mtnode-media-gen-nodes** — 音乐/语音/视频生成节点：MTNode music_gen / tts_gen / video_gen 节点：MiniMax Music 3、SoVITS 语音、H3 后端、输出路径 outputPath、抽卡次数、种子 +1、全局仅 1 个音视频任务互斥、媒体输入端子走 file:/// URL。Use when wiring music_gen, tts_gen, video_gen, media output paths, gacha rolls, or VRAM-related concurrency errors.
  - 文件：`mtnode/media-gen-nodes/SKILL.md`

## 音乐生成（MiniMax Music）

- **minimax-music-lyrics** — MiniMax Music 歌词：【内置·随应用发版，不需从工坊安装】按 MiniMax Music 官方规范写可演唱的歌词正文：结构标签独占一行（Intro / Verse / Pre-Chorus / Chorus / Bridge / Hook / Solo / Outro）、为唱而写的行长、副歌钩子与主歌对比、括号只用于要发声的衬词，不把舞台指示写进会唱出来的正文。MTNode「Minimax Music 3 / YuE2」节点的歌词端口用它，曲风与人声表演交给 minimax-music-prompt。
  - 文件：`music/minimax-music-lyrics/SKILL.md`
- **minimax-music-prompt** — MiniMax Music 提示词：【内置·随应用发版，不需从工坊安装】把一句话想法写成 MiniMax Music 的风格提示词：一段英文散文，六句按 Style+Mood → Tempo/Groove → Instruments → Vocals → Structure → Production 排（写句子、不写逗号标签、不含唱词）。控制曲风、人声、乐器、段落对比与制作；含官方六步、最小改动迭代表与校验清单。MTNode「Minimax Music 3 / YuE2」节点的提示词端口用它。
  - 文件：`music/minimax-music-prompt/SKILL.md`

## 插件与后端

- **mtnode-plugin-dev** — MTNode 插件开发规范：MTNode 应用插件（catalog 窗口插件 / builtin / 本地后端插件）的开发规范：插件类型与边界、后端插件三层结构（主进程宿主 · 预加载桥 · 控制台 UI）、主进程与渲染层接线点、build.json 打包白名单、画布节点与 i18n / 指南 / 冒烟交付清单、报错总线与自我修复、数据目录纪律，含最小骨架与常见坑。新建或改造 MTNode 插件（顶栏「插件」对话框里那个东西）时按需加载。
  - 文件：`plugins/plugin-dev/SKILL.md`
