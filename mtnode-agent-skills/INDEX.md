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
- **story2video-workflow** — story2video 工作流搭建：给 story2video 应用的八步（创意 / 剧本 / 分镜 / 素材图 / 分镜图 / 视频 / 成片 / 导出）在画布上建节点层与链：层与标题口径、场景图零参考图、参考图怎么接（@ + 节点名）、画布提示词一律英文、产物写哪、回执按什么契约回。真源是应用仓库的 AGENTS.md。
  - 文件：`app/story2video-workflow/SKILL.md`

## AI 影视创作

### 角色与场景资产

- **film-asset-character** — 角色资产与一致性锚点：把剧本里的一个人做成可复用的角色资产：填满设定卡字段、出三视图与表情板、建 10–20 张参考图集、绑定 Soul ID／参考图权重／种子等一致性锚点，并用 10/10 压力测试过关。建角色、定装、跨镜头保脸保人设时用。
  - 文件：`film/asset/film-asset-character/SKILL.md`
- **film-asset-qc** — 资产与角色一致性质检：用资产护照、压力测试矩阵与角色动画 QA 检查点给资产判生死：角色 10/10 才锁，角色/地点/道具逐项打勾，miss 不许平均，返修按 P0–P3 排队。开拍前验收、跨镜头漂移排查、交付前终检时用。
  - 文件：`film/asset/film-asset-qc/SKILL.md`
- **film-asset-scene-prop** — 场景与道具资产：把剧本里的空间与物件做成可复用资产：场景出四向视图与反打、写平面布局与光照基调，道具出多视角细节板并建「道具—使用镜头」对照表。要搭景、定空间、锁道具形制，或同一空间多机位时用。
  - 文件：`film/asset/film-asset-scene-prop/SKILL.md`
- **film-asset-style-bible** — 美术风格圣经：用一页纸锁死全片美术语言：把 noir／cyberpunk／epic／fantasy／horror／romance／war 拆成色彩、材质、光线、构图、镜头、声音六维参数，定主锚点与禁止清单，并给冲突裁决顺序。开拍前定调与跨部门对齐时用。
  - 文件：`film/asset/film-asset-style-bible/SKILL.md`
### 声音与字幕

- **film-audio-loudness** — 响度与母版：LUFS·真峰值·交付：按交付平台定响度目标，用 ffmpeg loudnorm 两遍法做线性归一，必要时先上真峰值限幅，编码后再复测真峰值与时长。成片混音收尾、平台退片、声音忽大忽小时用。
  - 文件：`film/audio/film-audio-loudness/SKILL.md`
- **film-audio-sound-design** — 音效与配乐：选材·卡点·混音：把分镜翻成可检索的声音需求，按动作、材质、时长与许可选音效，用节拍网格把切点钉到拍上，再按层级铺 BGM 与 SFX 并做闪避。需要配乐选型、找音效、卡点剪辑、混音层级或交付双版本时用。
  - 文件：`film/audio/film-audio-sound-design/SKILL.md`
- **film-audio-voiceover** — 配音与旁白：选型·表演·对位：把旁白稿做成可剪辑的配音音轨：按语言、情绪与预算选 TTS 引擎，写可执行的表演指令，逐句核算时间窗并做有上限的语速补偿，最后校验音画与口型同步。需要配音、旁白、角色台词、换声重配时用。
  - 文件：`film/audio/film-audio-voiceover/SKILL.md`
### 剪辑与成片交付

- **film-deliver-platform** — 平台交付规格与多版本导出：按抖音、视频号、小红书、B站、YouTube 的画幅、时长、码率、封面与字幕策略出片，给一份母版导出多版本的完整参数表与命令。成片要投平台、或被二压糊掉、封面被裁时用。
  - 文件：`film/post/film-deliver-platform/SKILL.md`
- **film-edit-ffmpeg** — ffmpeg 剪辑命令工具链：用本机 ffmpeg 完成裁切、拼接、变速、抽帧、转码、加字幕、加音轨与响度归一，给出可直接照抄的完整参数与 CRF／preset／硬件编码取舍。拿到素材要落地成片，或命令跑出黑帧、花屏、音画不同步时用。
  - 文件：`film/post/film-edit-ffmpeg/SKILL.md`
- **film-edit-narrative** — 解说与节奏剪辑：把长素材做成有钩子的成片：用词级转写驱动粗剪、删停顿与口误，按信息密度排节奏，按镜头功能选转场，写与画面对位的解说。素材很多不知从哪剪、粗剪发拖、转场乱用时用。
  - 文件：`film/post/film-edit-narrative/SKILL.md`
- **film-post-jianying** — 剪映草稿交接：把成片工程导成剪映专业版可继续编辑的草稿：目录结构、draft_content.json 的轨道与片段字段、字幕素材与时间单位，以及交付后人工接手要注意的坑。需要客户或同事在剪映里改字幕、换镜头、调音时用。
  - 文件：`film/post/film-post-jianying/SKILL.md`
- **film-post-qc** — 成片质检与自动检测：成片交付前的可勾选体检：黑帧、静帧、爆音削波、字幕错位、响度、尺寸时长、首帧钩子，逐项给自动检测命令与通过阈值，附问题到修法的映射。导出后、上传前用。
  - 文件：`film/post/film-post-qc/SKILL.md`
### 分镜与镜头设计

- **film-previs-blockout** — 白模预演：分镜到 3D layout：把分镜编译成可播放的三维白模预演：定坐标与时间、写相机关键帧、选普通/关节后端、渲染 MP4 并用解码器核对时长帧率。需要验证机位与走位、排查空间说不清的镜头、给生成模型三维参照时用。
  - 文件：`film/storyboard/film-previs-blockout/SKILL.md`
### 生成提示词工程

- **film-prompt-cinematography** — 摄影词表与提示词用法：把「压迫感、孤独、温柔」这类中文意图翻译成模型认得的英文摄影片段：机位、运镜、焦段、光位、光质、色温、构图、材质、天气九类词表，并给意图对照表与摄影机层写法。
  - 文件：`film/prompt/film-prompt-cinematography/SKILL.md`
- **film-prompt-consistency** — 跨镜头一致性提示词：让角色、场景、风格在多个镜头与多段续写里不漂：三类锁定策略、omni-reference 与多图参考的角色映射、continuation 续写写法，并给可逐条打勾的一致性检查清单。
  - 文件：`film/prompt/film-prompt-consistency/SKILL.md`
- **film-prompt-keyframe-image** — 关键帧与首帧图像提示词：写「下一步要拿去做视频」的静态图提示词：分清图像与视频各自管什么、按资产类型选图像模型、排角色卡与首帧构图、留出运动空间，并给出可延伸性检查与交接写法。
  - 文件：`film/prompt/film-prompt-keyframe-image/SKILL.md`
- **film-prompt-qc** — 出片质检与返修：片子已经出来但不对时用：把畸变、多指、穿模、身份漂移、口型不符、动作截断等症状归到具体层（素材/首帧、提示词、参数、后期），按最小改动原则返修，并给诊断表与重试停损规则。
  - 文件：`film/prompt/film-prompt-qc/SKILL.md`
- **film-prompt-video-models** — 视频模型提示词骨架：按 Seedance 2.0/2.5、Kling 3.0、Veo 3.1、Sora、MiniMax H3 等模型的字段结构写可直接粘贴的视频提示词：定规格、选骨架、排时间轴、锁参考、写声音，并给出跨模型差异表与参数上限。
  - 文件：`film/prompt/film-prompt-video-models/SKILL.md`
### 剧本与创意开发

- **film-script-scene-dialogue** — 场景与对白：冲突·潜台词：把一场戏写到能演：定场景目标与价值转折，用动名词节拍表把谈话变成行动，写出有潜台词的对白，给对手一把刀，让道具与细节做功。修「什么都没发生」的场、对白太直太解释、人物扁平、冲突停滞或跳跃时用。
  - 文件：`film/script/film-script-scene-dialogue/SKILL.md`
- **film-script-series-bible** — 剧集圣经与长线一致性：为长剧与漫剧建一份可维护的剧集圣经：人物弧账本、伏笔表、故事线网格、知情边界与跨集连续性台账，并用引擎句与季弧检查一致性。写 bible、管长线连载、处理人设崩塌与伏笔失准时用。
  - 文件：`film/script/film-script-series-bible/SKILL.md`
- **film-script-short-drama** — 竖屏短剧与漫剧结构：按竖屏短剧的节奏搭结构：3 秒入画钩子、单集九拍、每 3–5 集一个回合、反转密度、集尾卡点与付费点，以及 60 集全剧骨架与知情边界表。写短剧或漫剧集纲、改钩子、诊断完播率时用。
  - 文件：`film/script/film-script-short-drama/SKILL.md`
- **film-script-story-architecture** — 故事结构：前提·类型·引擎：把模糊想法做成可检验的故事结构：用前提与主控思想定主题，用类型节拍表查漏，用三幕页表排布，用剧集引擎判断能否撑成长线。写梗概、logline、分集骨架，或诊断「事件很多却没有故事」时用。
  - 文件：`film/script/film-script-story-architecture/SKILL.md`
- **film-script-style-adaptation** — 风格化写作与跨文化改编：按导演与国别传统选剧作法：小津式画外叙事、日式起承转合、韩式类型承诺、法式情绪优先，以及戏曲板腔体与曲牌体的唱词规矩、电影与日式剧本格式、小说改编取舍。定风格、写跨文化改编、转剧本格式时用。
  - 文件：`film/script/film-script-style-adaptation/SKILL.md`
### 分镜与镜头设计

- **film-shot-director-styles** — 导演风格叠加：10 种可执行参数：把「像某某导演」拆成能写进提示词的参数差：机位高度、焦段倾向、运动预算、平均镜长、明暗比与色彩，每种风格给 3–5 条硬特征与适用/慎用场景。要定视觉基调、做风格提案、判断某个镜头「不像」时用。
  - 文件：`film/storyboard/film-shot-director-styles/SKILL.md`
- **film-shot-language** — 镜头语言：景别·机位·轴线：把剧本意图翻译成可执行的镜头：先定功能再定景别，用机位高度与角度管权力关系，用焦段管空间压缩，排构图与运镜，守住 180 度轴线、30 度规则与屏幕方向。设计分镜、诊断「镜头为什么不对」、检查跨镜连续性时用。
  - 文件：`film/storyboard/film-shot-language/SKILL.md`
- **film-shot-list-breakdown** — 分镜拆解：剧本→场景表→分镜表：把剧本或一句话创意拆成可执行的场景表与分镜表：先写节拍表再定覆盖，用三泳道 22 字段锁死每镜的身份、导演与摄影信息，按模型时长切 clip、剥离画内文字、给风险分档。要出分镜表、算镜头数、查漏字段时用。
  - 文件：`film/storyboard/film-shot-list-breakdown/SKILL.md`
- **film-storyboard-prompt** — 分镜图提示词：九槽位与负面清单：把分镜行写成能直接出图的关键帧提示词：按九槽位固定顺序排构图与光位，用身份锚点锁角色一致性，分层写负面清单，并给中英对照的完整示例。要做分镜图、首尾帧、角色设定图，或图老是换脸、长乱字时用。
  - 文件：`film/storyboard/film-storyboard-prompt/SKILL.md`
### 声音与字幕

- **film-subtitle-production** — 字幕生产：转写·断句·双语·烧录：把音轨做成可交付字幕：ASR 转写取词级时间戳，按语义与每行字数断句，翻译后做 CPS 与最短显示时长校对，再按平台安全区烧录或封装软字幕。做字幕、双语字幕、译制或修时间轴时用。
  - 文件：`film/audio/film-subtitle-production/SKILL.md`

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
- **mtnode-mcp-server** — MTNode MCP 服务端（第三方接进来操作）：从 MTNode 外面经 MCP 操作本机 MTNode：15 个工具、先读图拿 contentHash、权限与审计。
  - 文件：`mtnode/mcp-server/SKILL.md`
- **mtnode-media-gen-nodes** — 音乐/语音/视频生成节点：music_gen / yue_gen / breeze_gen / video_gen：输出路径、抽卡、单任务互斥与媒体端子。
  - 文件：`mtnode/media-gen-nodes/SKILL.md`
- **mtnode-research** — 研究画布（知识图谱 + 文献层）：在研究视图里以课题为核心建知识图谱：Markdown 笔记规范（frontmatter / callout / wikilink / 引用 / 公式）、图谱查询与文献检索脚本、验证状态与溯源口径。改研究笔记或做文献调研前读它。
  - 文件：`mtnode/research/SKILL.md`
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

## Remotion 视频制作

### 动画与时序

- **remotion-animation-timing** — Remotion 动画与时序：用 interpolate / spring / Easing 排动画手感：参数含义、进入退出编排、错峰节奏、帧率换算与逐帧性能。写镜头动效、觉得动作"很廉价"或某段卡顿时读它。
  - 文件：`remotion/animation/remotion-animation-timing/SKILL.md`
### 音频与字幕

- **remotion-audio-captions** — 音频、字幕与卡点：在 Remotion 里铺音频与字幕：Audio/staticFile、音量包络与旁白闪避、逐词字幕数据格式、卡点对齐与带字幕导出。做口播、讲解、带 BGM 的片子时读它。
  - 文件：`remotion/audio-subtitle/remotion-audio-captions/SKILL.md`
### 参数化与数据

- **remotion-data-params** — 参数化与数据驱动：让一支片子能被参数与外部数据驱动：props 加 zod schema、calculateMetadata 动态时长、JSON/CSV 驱动画面、一张表批量出 N 条视频。做模板化、批量生产、多语言或多 SKU 版本时读它。
  - 文件：`remotion/data-params/remotion-data-params/SKILL.md`
### 工程与组件

- **remotion-project-basics** — Remotion 工程与合成基础：搭 Remotion 工程骨架与合成：项目结构、Composition/Still、useCurrentFrame、Sequence 与 Series 取舍、staticFile 与常用配置。新建工程或首帧跑不起来时读它。
  - 文件：`remotion/components/remotion-project-basics/SKILL.md`
### 渲染与发布

- **remotion-render-encoding** — 渲染、编码与发布：把 Remotion 工程渲成文件：bundle/selectComposition/renderMedia/renderStill、并发与内存、codec 与 crf 取舍、Serverless 与 CI 部署、报错定位。要出成片时读它。
  - 文件：`remotion/render-deploy/remotion-render-encoding/SKILL.md`
### 动画与时序

- **remotion-shot-recipes** — 镜头配方与电影感动效：把镜头卡抽象成可复用动效模式：推拉、快切与变速、字形动效、群体入场、数据可视化、纸张拼贴、转场与光效。每种给适用场景、具体参数与实现要点。排分镜、挑镜头、觉得片子"很平"时读它。
  - 文件：`remotion/animation/remotion-shot-recipes/SKILL.md`

## 视频生成（MiniMax H3）

- **h3-dynamic-still-prompt** — H3 动态静图（首尾帧）：把一张静图做成可无缝循环的微动背景：识图、归一化、搭 H3 首尾帧工作流、写中文提示词、PSNR 验缝。
  - 文件：`video/h3-dynamic-still-prompt/SKILL.md`

## 写作与润色

- **humanizer-zh** — 去 AI 味与写作润色：润色中文文稿：删空话与套路，保留事实与作者声音
  - 文件：`writing/humanizer-zh/SKILL.md`
