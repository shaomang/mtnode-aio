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
- **mtnode-dev-architect** — 开发节点架构师：用「开发节点」（super + dev:true 的项目功能块）搭建/分析软件项目架构画布。模式 A：扫描已有项目文件夹，生成覆盖全项目的开发节点架构图（不确定处询问用户）；模式 B：新项目先搭架构、用户明确「确认」后按画布逐块搭建项目。剥洋葱式一次只细化一层；「建议 / 开发 / 细化」按钮均先弹对话框确认（建议 = AI 只读评估项目代码与进度后给 4 条下一步方案，可多选 + 补充，同一对话框里的「开发」即按所选开工；开发 = 填写本次需求；细化 = 确认是否继续展开），确认后在新建的绑定会话中运行；细化先报内容梗概、经用户确认才建节点，无需或无法细化时明确告知原因；元素层级 模块→文件→类/接口/枚举（不同外框颜色）；元素间关系用关系线（rel，普通直线、可双向箭头、可带文字，点选节点时相关线高亮）。Use when the user wants to analyze a proj
  - 文件：`mtnode/dev-architect/SKILL.md`
- **mtnode-media-gen-nodes** — 音乐/视频生成节点：MTNode music_gen 与 video_gen 节点：MiniMax Music 3 / H3 后端、输出路径、抽卡次数、种子 +1、全局仅 1 个音视频任务互斥。Use when wiring music_gen, video_gen, media output paths, gacha rolls, or VRAM-related concurrency errors.
  - 文件：`mtnode/media-gen-nodes/SKILL.md`

## 禅模式

- **zen-bootstrap** — 禅引导：Zen Mode 首问技能：把模糊想法收敛为领域方向（开发/写文章/做视频/做游戏/其他），并派发到 zen-domain-* 追问树。用户开启全新话题时也回到本技能重新引导。
  - 文件：`zen/zen-bootstrap/SKILL.md`
- **zen-canvas-compile** — 禅画布构建：Zen Mode 画布编译技能：把已确认的计划映射为 MTNode 可执行工作流（任务/控制/判断/分区、agent_task、wait_file 文件交接），输出任务节点与计划条目的映射表。
  - 文件：`zen/zen-canvas-compile/SKILL.md`
- **zen-domain-game** — 禅领域·游戏：Zen Mode 领域追问树（游戏制作）：澄清游戏类型平台、核心玩法、美术音效风格、技术方案与交付物（设计文档/原型/素材）。信息足够时 planReady=true 转计划编译。
  - 文件：`zen/zen-domain-game/SKILL.md`
- **zen-domain-software** — 禅领域·软件开发：Zen Mode 领域追问树（软件开发/工具）：澄清目标用户、核心功能、技术栈、运行环境与交付形态。信息足够时 planReady=true 转计划编译。
  - 文件：`zen/zen-domain-software/SKILL.md`
- **zen-domain-video** — 禅领域·视频：Zen Mode 领域追问树（视频制作）：澄清主题受众、时长平台、风格参考、素材现状与交付物（脚本/分镜/提示词/成片）。信息足够时 planReady=true 转计划编译。
  - 文件：`zen/zen-domain-video/SKILL.md`
- **zen-domain-writing** — 禅领域·写作：Zen Mode 领域追问树（写作/文案/文档）：澄清主题目的、目标读者、体裁篇幅、素材参考与交付格式。信息足够时 planReady=true 转计划编译。
  - 文件：`zen/zen-domain-writing/SKILL.md`
- **zen-plan-compile** — 禅计划编纂：Zen Mode 计划编译技能：把澄清完毕的决策图谱整理为结构化 Markdown 计划（章节+清单+节点锚点注释），供计划面板编辑与画布构建使用。
  - 文件：`zen/zen-plan-compile/SKILL.md`
