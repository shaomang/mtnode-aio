# MTNode 官网 · 内容事实源（content-facts）

> **唯一事实源**：`E:\dev\tools\pipeline-console\guides\manual\*.md`、`guides\nodes\*.md`、`docs\*.md`
> **规则**：每条都注明出处文件；**查不到的宁缺不编**。凡标 ⚠️ 的条目是文件之间的口径冲突或非原文用语，**上网页前必须先定稿**。

---

## 一、缩略语与命名口径（先定，再写字）

| 项 | 口径 | 依据 |
| --- | --- | --- |
| 中文名 | MTNode AI编排器 | `web/index.html` `<title>`、`web/README.md` |
| 英文名 | MTNode AI Orchestrator | `web/index.html.template:6` |
| 术语统一 | **「思考强度」（thinking effort）** | `guides/manual/README.md:34` |
| 写作纪律 | 「说明文字口径与仓库 README.md 与 guides/manual/ 手册保持一致」 | `web/index.html:9` 原文 |
| ⚠️ 引擎对外称呼 | `guides/manual/` 正文里**不出现「dsh」这个词**；只有站点页 id `dsh`（中文页标题「智能能力是什么」，英文页 "What agent mode is"）。「dsh」作为引擎名的证据在 `dsh/` 目录与 `docs/` 内部文档里 | `guides/manual/index.json`、`guides/manual/en/dsh.md` |

---

## 二、五项能力（各一句上网页短句 + 一条硬事实）

### 1. 内置 Agent 引擎

**短句（上网页）**

> **一次 AI 协作就是一个会话：有状态、可开关，能读写文件、也能上网搜索。**

支撑原文：`guides/manual/dsh.md`「一次 AI 协作就是一个会话……有状态、可开关」。

**硬事实（节点名）**

> **节点 kind `agent_task`（智能任务）**：按任务描述读文件、联网、执行命令，结果回填输出。

- 出处：`guides/nodes/agent_task.md`（并登记于 `guides/nodes/index.json` 的 `ids`）
- 原文：「通用 agent：按任务描述读文件、联网、执行命令，结果回填输出。服务商走 DeepSeek 路由。」

**备选硬事实（可替换/补充）**

- **同一个引擎的三种用法**：`proc_text` 可开「智能助手」进入 agent 模式（`guides/nodes/proc_text.md`：「用大模型按提示词处理上游文本。可开「智能助手」走 agent（读文件 / 联网）」）；`tool` 节点把画布子图注册成 Agent 可直接调用的工具（`guides/nodes/tool.md`）。
- **四组开关**：模型 · 预设档 · 思考强度 · 工具许可 —— 出处：`guides/manual/agent-nodes.md:9`（原文即「## 四组开关（模型 · 预设档 · 思考强度 · 工具许可）」）。
- **函数节点独立线程**：JS 代码不在画布进程里跑，每次运行由主进程单起一条执行线程（`fn-runtime.js`），超时默认 10 分钟并回收进程树 —— 出处：`guides/nodes/function.md`。

**⚠️ 必须先定稿的冲突**

- 思考强度档位两处不一致：`guides/manual/agent-nodes.md:13` 写 **off / low / high / max（四档）**；`guides/manual/glossary.md:14` 写**五档「无 / 轻 / 标准 / 强 / 最强」**。**未定稿前不要写档位数。**
- 来自 `docs/` 的条目（`dsh-home/sessions/`、`dsh-home/settings.yaml`、`npm run deps:check`、`dsh/gateway/cordis.yml`、`@deepseek-ai/dsh-*` 包名等）属**内部路径与包名**，是否对外披露需产品/安全确认。**默认不写进官网。**

---

### 2. 长周期任务 · 状态机 + 人在环

**短句（上网页）**

> **长周期任务把整件事画成一张状态机图，由应用替你按图推进，该停的地方停下等你。**

支撑原文：`guides/manual/longtask.md`「它把整件事画成一张**状态机图**，由应用替你按图推进，该停的地方停下等你，你处理完它接着跑。」

**硬事实（节点名）**

> **状态机节点全集 10 种 kind**：`start` / `end_ok` / `end_fail` / `agent` / `human` / `join` / `fork` / `map` / `sub` / `output`。

- 出处：`docs/audit-longtask-requirements.md`（转引 `renderer/app-longtask.js:32`）
- 原文：「节点全集 10 种：`LT_NODE_KINDS = ["start","end_ok","end_fail","agent","human","join","fork","map","sub","output"]`」

**备选硬事实**

- **人在环的确认点**：环节类型 `human` 分 `approve`（通过 / 驳回）与 `deliver`（按清单交东西）两类，**条带卡片是唯一操作面**；驳回必须写理由，理由写进共享状态、上游 Agent 下一轮读得到 —— 出处：`docs/audit-longtask-requirements.md`、`guides/manual/longtask.md`。
- **放行口径**：「放行只有一条路：你在卡片上点「确认交付完成」……**收齐不等于放行**」—— 出处：`guides/manual/longtask.md`。
- **回跳口径**：驳回会退回你指定的环节重做；回跳**默认不限制次数**，设了上限则超限转「失败」，绝不无限循环 —— 出处：`guides/manual/longtask.md`。
- **运行态落盘路径**：`<数据目录>\longtask\runs\<wfId>\<runId>.json`（一次运行 = 一个文件，checkpoint）；图定义随工作流 JSON 存 `wf.longtask`，**不走 JSON 文件** —— 出处：`longtask-store.js`（头注释与 L63-68）、`guides/manual/longtask.md`。
- **交付目录**：`<画布工作目录>\mtnode-deliverables\<uid>\`，人读口径 `manifest.json`（清单真源）+ `交付清单.md`（给用户看的镜像）；工作目录不可用时退回应用数据目录 —— 出处：`guides/manual/longtask.md`、`longtask-store.js`。
- **长期记忆库**：`<数据目录>\longtask\memory.db`（SQLite + FTS5），三层作用域 `global` / `workspace` / `workflow` —— 出处：`longtask-store.js`。
- **内置默认阈值**：图级并行度默认 4 / Agent 失败重试默认 2 / 驳回回跳上限默认 0（= 不限）/ 记忆注入 TopK 默认 8 —— 出处：`guides/manual/longtask.md:242-243`。

**⚠️ 必须先定稿的冲突**

1. **「勾选允许读取画布就能读画布」——不要写。** `guides/manual/longtask.md` 说勾了就能拿画布内容（只读）；但 `docs/audit-longtask-requirements.md` 判定该开关**运行时拿不到任何画布工具**（`MTNODE_NO_CANVAS=1`），并列为高等级缺口「UI 说……运行时没有、人设还禁止，三方不一致」。**除非另做一次运行复验，官网不得把它写成能力。**
2. **「清单双向」——不要写满。** 手册称双向；审计判为名不副实；当前 `longtask-store.js` 确实有 `merge` 实现（`if (arg.merge) items = mergeItemRuntime(...)`），但**渲染层在哪些路径带 `merge` 标记，允许的文件无法证实**。只能写「应用写清单、也读得回来」这一层，不能断言「完全双向」。
3. **状态名不要补全。** 审计只说 CSS 里共 **9 态**、未逐一枚举；能从文件里拿到名字的只有 `idle` / `ready` / `skipped` / `running` / `waiting_human` / `waiting_delivery` / `blocked`。**缺的 2 个不许猜。** 手册侧只给颜色口径：「运行中橙、等你处理黄、卡住或失败红，这三种走呼吸灯；跑完绿，常亮不闪」（`guides/manual/longtask.md:21-22`）。

---

### 3. 开发节点

**短句（上网页）**

> **把软件项目拆成画布上的一颗颗功能块，逐块让 AI 建目录、写文件、跑验证。**

支撑原文：`guides/manual/dev-nodes.md`「把软件项目拆成画布上的一颗颗功能块」「**开发** = 按你选定的方案真正动手建目录、写文件、跑验证。」

**硬事实（节点名）**

> **开发节点不是独立 kind，而是 `kind: "super"` + `dev: true` 的超级节点**，可嵌套子开发节点。

- 出处：`docs/dev-node-design.md`
- 原文：「形态上是带 `dev: true` 标志的超级节点（`kind: "super"`），可嵌套子开发节点。」

**备选硬事实**

- **核心文件字段有硬上限**：`devFiles` **最多 10 条**（常量 `DEV_CORE_FILES_MAX = 10`，`renderer/app-devnode.js`），`/` 分隔、相对本块项目根 `devPath`；越出项目根的 `../`、通配符、尾斜杠目录被拒绝；**最外层（项目）开发块不填**（读恒为空、写被拒绝）—— 出处：`docs/dev-node-design.md`。
- **共识文件**：在项目根（`devPath`）维护一份 **`AGENTS.md`**，作为本项目所有开发 / 细化 / 建议会话共享的核心共识文件；并在最外层建标题为 `agent.md` 的 `file` 入口节点 —— 出处：`docs/dev-node-design.md`。
- **模型三件套按块指定**：`devModel` / `devPreset` / `devEffort`（三项各自就近向上继承、互不牵连）—— 出处：`docs/dev-node-design.md`、`dsh/gateway/canvas-plugin.mjs`。
- **层级链**：`devKind` = `module` → `file` → `class` / `interface` / `enum`，五档各有默认外框色；`devColor` 为 `#rrggbb` —— 出处：`docs/dev-node-design.md`。

**⚠️ 必须先定稿的冲突**

- `docs/dev-node-design.md` 写 `【功能】` ≤80 字、`【实现】` ≤120 字、合计 ≤200 字；而 `mtnode-agent-skills/mtnode/dev-architect/SKILL.md` 写第一段 **≤60 字**。**上网页前以设计文档为口径或先修一处。**

---

### 4. 音视频生成节点

**短句（上网页）**

> **本机后端驱动的音乐、语音、视频生成，成片写进节点自带的输出路径，不需要再挂保存节点。**

支撑原文：`guides/nodes/music_gen.md`「每次运行只生成一个音频文件（`.wav`），写入节点自带的 `outputPath`，不需要再挂保存节点」。

**硬事实（节点名）**

> **节点 kind 八个**：`music_gen` / `yue_gen` / `tts_gen` / `video_gen` / `video_upscale` / `video_interp` / `remotion` / `sensenova_gen`。

- 出处：`guides/nodes/index.json`（ids 列表）与 `guides/manual/media-gen.md`
- 每个节点的产物都落节点自带 **`outputPath`**（设置入口是节点头部 **⚙ 设置**），**不需要再挂保存节点**。

**备选硬事实**

- **音视频全局互斥（强烈建议上网页，属真实约束）**：全局同一时刻只允许 **1 个音视频任务**（音乐 / 语音 / 视频 / 超分 / 补帧互斥），其它任务排队等待 —— 出处：`guides/nodes/video_upscale.md`、`guides/nodes/video_interp.md`、`guides/nodes/remotion.md`。
- **抽卡 / 种子口径**：抽卡次数 **1–10**，多轮输出命名 `#1`、`#2`…；种子固定可复现，**「摇数」开启时每次抽卡种子 +1** —— 出处：`guides/nodes/yue_gen.md`、`guides/nodes/music_gen.md`。
- **媒体输入端子是 `file:///…` URL**（中文与空格自动百分号编码），接收端自动归一回本机绝对路径 —— 出处：`guides/nodes/video_gen.md`。
- **本机后端与端口**：SenseNova 本机后端端口 **8774**，手动入口在插件的 `start_backend.cmd`（`guides/manual/media-gen.md`）——这是**文档里唯一写明端口**的媒体后端。其余后端（MiniMax Music 3 / YuE2 / GPT-SoVITS / H3-ComfyUI）文档中**均无端口数字**。
- **显存门槛（真实前提）**：Music3 / YuE2 / H3 建议 **24G 显存**级别；SenseNova 权重 bf16 约 **32.66GB**、内存建议 ≥40GB、磁盘 ≥60GB —— 出处：`guides/manual/media-gen.md`、`guides/nodes/sensenova_gen.md`。
- **超分 / 补帧是独立后处理节点**，不随 H3 生成一起跑；默认走逐帧流式脚本 `h3-pack/post/stream_upscale.py` / `stream_interp.py`，失败才回退 ComfyUI 图链 —— 出处：`guides/nodes/video_upscale.md`、`guides/nodes/video_interp.md`。

**⚠️ 必须先定稿的冲突（同一批文档内自相矛盾，选一条写）**

1. **TTS 是否占全局锁**：`guides/manual/media-gen.md` 说「音乐生成 / 语音合成 / 视频生成共享同一把互斥锁」；`guides/nodes/tts_gen.md` 说「SoVITS 是独立进程、**不占主进程的音视频全局锁**，显存另算」。
2. **`music_gen` 输出格式**：`guides/nodes/music_gen.md` 只写 `.wav`；`guides/manual/media-gen.md` 写 `.mp3` / `.wav`。
3. **`video_gen` 分辨率档**：`guides/nodes/video_gen.md` = auto / 480p / 720p / **1080p**；`guides/manual/media-gen.md` = auto / 480p / 720p（无 1080p），同文件另写「分辨率被钳到长边 ≤1280」。
4. **`remotion` 参数档**：`guides/manual/media-gen.md` = `1920x1080`/`1080x1920`/`1080x1080`、帧率 24/30/60；`guides/nodes/remotion.md` = `1280x720`/`1920x1080`/`1080x1080`（默认 `1280x720`）、帧率 **1–60 fps**（默认 30）。
5. **文件里确实没有的信息**：H3 / ComfyUI 监听端口、Gradio 端口、GPT-SoVITS 端口、YuE2 端口——**均无数字，禁止补全**。

---

### 5. 其他节点能力

**短句（上网页，一条覆盖该组）**

> **超级节点把一组节点打包成子图；工具与函数节点把画布变成 Agent 能调用的工具；批量逐条跑，创意工坊里拿别人的模板与技能。**

支撑原文：`guides/nodes/super.md`「把相关节点收纳成子图……外侧 / 内侧边端子隧穿数据」；`guides/nodes/tool.md`「工具节点 = 类超级节点的容器形态」；`guides/manual/glossary.md`「批量项：一次运行只处理一条的批量输入」；`guides/manual/community.md`「浏览 / 下载别人公开的模板画布与技能（Skill）」。

**硬事实（节点名，一条）**

> **超级节点 = `kind: "super"`**，把一组节点打包成子图、用边界端子隧穿数据；其三种特殊形态是**开发节点**（`dev` + `devPath`）、**数据库节点**（头部 ⚙ 编译生成「数据库副本」）、**长任务壳**（长周期任务跑到有产出的环节时自动建）。

- 出处：`guides/nodes/super.md`、`guides/manual/glossary.md`、`guides/nodes/index.json`

#### 分项备选硬事实（给页面分区用）

| 分项 | 一句短句 | 硬事实 | 出处 |
| --- | --- | --- | --- |
| **超级节点** | 把一组节点打包成子图，用边界端子隧穿数据 | `kind` = `super`；可展开在壳内编辑或 ↪ 进入完整内部画布；可选**子文件夹**让内部相对路径落在工作目录下 | `guides/nodes/super.md`、`guides/nodes/index.json` |
| **工具节点** | 把画布子图注册成 Agent 可直接调用的工具 | 配置统一存在 **`toolConfig`**（`name` / `description` / `inputs` / `outputs`）；输入端子 0 = 控制入、输出**末位 = 控制出** | `guides/nodes/tool.md`、`guides/manual/tools-functions.md` |
| **函数节点** | 在画布上写纯 JS，自定义入参出参 | 函数名 **`fnName`**、代码 **`jscode`**；**代码不在画布进程里跑**，每次运行由主进程单起一条执行线程（`fn-runtime.js`） | `guides/nodes/function.md` |
| **审批权限** | 工具许可决定可用哪些工具；改画布、删画布、装插件单独弹窗审批 | 工具许可五类：**读写文件 / 联网搜索 / 画布编辑 / 提问 / 识图**；写工作区文件、联网搜索按当前预设放行 | `guides/manual/approvals.md` |
| **多供应商路由** ⚠️ | 服务商可自建，每个节点各自选服务商与模型，按运行下发 | 按 run 下发 **`providerId` / `provider` / `model`**，且**就近优先**（内部节点自己选过的以内部为准）；函数节点里 `mtnode.ai` 返回 `{ ok, text, error, provider, model }` | `guides/nodes/tool.md`、`guides/nodes/function.md` |
| **批量** | 批量模式每次运行只处理一条；聚合模式一次输入全部内容 | 确切字段名 **`batchMode`**；`batch` 模式每次运行只处理单条输入 | `guides/nodes/tool.md`、`guides/manual/glossary.md` |
| **创意工坊 / 讨论区** | 创意工坊浏览下载模板画布与技能，讨论区免登录即可浏览 | 模板 = 一张可导入的画布；技能 = **`SKILL.md` 包**（需含 frontmatter `name`，**kebab-case**），下载后智能节点即可调用 | `guides/manual/community.md` |

#### 批量能力的成本红线（建议保留，属真实约束）

- 「每次运行只出 1 张图。要 10 张就准备 10 条输入（批量 1:1）、或放多个图像生成节点、或用「抽卡次数」多抽几次；**绝不要在提示词里写「生成多张」**」—— 出处：`guides/manual/io-proc.md`。
- 「批量任务特别贵：检查是不是把整批 N 条又塞进了每次运行（**≈N² 次调用**）；要一次看全部才用「聚合模式」」—— 出处：`guides/manual/faq.md`。

**⚠️ 「多供应商路由」不是原文用语。** `guides/` 全目录里中文「路由」只出现在三处：`guides/nodes/agent_task.md`（「服务商走 DeepSeek 路由」）、`guides/manual/dev-nodes.md`（「模型 + 路由」）、`guides/manual/media-gen.md`（ComfyUI「不加载该包的界面与后端路由」）。**官网上用这个词属于概括**，请产品确认是否改用「多服务商 / 自建服务商」。

---

## 三、版本与文件名口径（本轮确认）

`web/downloads/` 里**实际存在**的文件，就是页面要用的文件名：

| 文件 | 实测字节 | 用途 |
| --- | --- | --- |
| `MTNodeAIO-Setup-1.3.3.exe` | 138039479 | Windows 安装包（首要动作的落地文件） |
| `MTNodeAIO-src-1.3.3.zip` | 8290467 | 源码包（**不含 `node_modules`**，见 `web/index.html:232`） |

- 现行页面版本常量：`web/index.html:387` — `var VER = "1.3.3";`（**改版本只改这一处**，`web/index.html:8` 原文要求）。
- 下载链接实际形式：`downloads/MTNodeAIO-Setup-1.3.3.exe`、`downloads/MTNodeAIO-src-1.3.3.zip`（`web/index.html:212` / `231`）。
- 分发：阿里云 OSS bucket `mtnode-download`，地域 `oss-cn-beijing`；线上入口 `http://mt-agent.com/mtnode/`（`web/README.md`、`web/index.html:3`）。
- ⚠️ 现行页面版本号自相矛盾（待修，**不要在官网继承**）：`verTag` = `v1.3.3`（`index.html:188`），但同页 `pill.ver` = 「v1.1 大版本」（`index.html:204`），`meta description` 也停在 v1.1（`index.html:16`）。
- 🔁 **版本口径更新（第 2 轮实测）**：应用版本真源（仓库根 `version` 文件）= **`1.4.0`**，但 **1.4.0 尚未发版**——`git log` 最后一条发布提交仍是 `cd25819 发布 v1.3.3`（2026-09-13），`web/downloads/` 与 OSS `downloads/` 下最新可下的仍是 `1.3.3`（本轮逐条实测 OSS）。
  **两条口径同时成立、别互相覆盖**：页面**版本号文案**取应用真源 `1.4.0`；**下载链接与文件名**取实际存在的 `1.3.3`。
  1.4.0 出包后，只需改 `preview/index.html` 里两处 `href` 与同名 `meta`（已就地标注）。

---

---

## 三·补 · 1.4.0 能力面（2026-09 第 2 轮补录 · 逐条带出处）

> 本节由 1.4.0 事实提炼补入（口径：`E:\dev\tools\pipeline-console` 只读核对）。
> **版本事实**：仓库根 `version` = `1.4.0`、`package.json:4` 同值；`git log` 最后一条发布提交 = `cd25819 发布 v1.3.3`（2026-09-13）
> → **1.4.0 尚未发版**，`web/downloads/` 与 OSS `downloads/` 里最新可下的仍是 `1.3.3`（本轮实测 OSS 确认）。

### 节点类型总数（两个口径，别混用）

- `guides\nodes\index.json` 的 `ids` 共 **50 项** = **节点指南条目数**。
- 画布实际 kind 数为 **48 种** —— `docs\reports\quality-audit-1.4.0.md:62` 原文「画布实际 48 种 kind」。
- ⚠️ **不要把两者写成同一个数**（如「50 种节点」）。要用总数就写明是哪一个口径。

### 各组能力的硬事实（补录）

| 能力 | 一句话 | 硬事实 | 出处 |
| --- | --- | --- | --- |
| 素材库 | 画布之外的仓库，跨项目跨画布复用 | 一条内容 = 一对端子；改内容＝改库、删画布不丢；独立根目录（`config.json` 的 `assetRoot`） | `guides\nodes\asset.md:3`、`docs\asset-library.md:9-26` |
| 专家团 | 一张画布配一队多角色专家 | 顶栏视图（**不是节点**）；单聊与 2–6 人圆桌；建议卡采纳落盘 `<工作区>/advice/TODO.md`、`<工作区>/decisions/DEC-YYYYMMDD-NN.md` | `guides\manual\one-person-company.md:13,59,85-87` |
| 插件系统 | 后端/窗口插件按需下载，装完引擎重启 | 卸载只影响该插件；插件装在应用配置数据目录，升级后保留 | `guides\manual\community.md:75,82,83` |
| 插件报错自修复 | 后端出错弹报告，可让 AI 就地修好并重启 | 三只按钮：自动修复 / 打开控制台看日志 / 忽略；在本插件的 `INSTALL_DIR` 里修 | `guides\manual\media-gen.md:272-282` |
| 多服务商 | 服务商可自建，每个节点各自选 | 按 run 下发 `providerId` / `provider` / `model`，就近优先 | `content-facts.md:167`（转引 `guides\nodes\tool.md`、`function.md`） |
| PDF 落盘 | 文本 / Markdown 排版成 PDF | `save_pdf`；页面尺寸 A4/A3/A5/Letter/Legal、页边距、正文字号、页码 | `guides\nodes\save_pdf.md:2,21-27` |
| 导出与分享 | 工作流可导出为 `.mtnodes` 包无损分享 | 上传模板会自动去掉画布与本机工作目录信息 | `README.md:5`、`guides\manual\community.md:37` |

### 1.4.0 周期新增（未发版，证据：v1.3.3 提交内 0 命中）

长周期任务全链（含 `deliver` / `ltout` / `ltart` / 人在环状态机）、`sensenova_gen`、`yue_gen`、`video_upscale`、`video_interp`、`input_any`；
另 `tool` / `function` 节点指南登记从 48 → 50（`docs\reports\quality-audit-1.4.0.md:77`）。
**不确定项**：SenseNova / YuE2 / 超分 / 补帧 / `input_any` 的首次发布版本——发版提交是部分同步（v1.3.3 只改 7 个文件），不能断言。

### 新增「不能写」（本轮实测无证据）

- ❌ **不要写节点清单里的 `llama` / `asr`**：两者都**不是画布节点**——llama.cpp 是插件 + OpenAI 兼容 API（`plugins\catalog.default.json:101-104`）；ASR 明确「不新增节点类型、不补节点指南」（`docs\asr-local-backend.md:34`）。语音识别只能写成「音频输入接文字节点即自动转写并注入提示词」。
- ❌ **不要写「数据库节点需在设置里开『测试版本』」**：`guides\nodes\super.md:22` 有此句，但 `renderer\**` 全量 grep「测试版本」**0 命中**，存疑未定稿。
- ❌ **不要写手册里有「数据库节点」页**：`db_table.md` / `db_replica.md` 都指向 `#database-nodes`，但手册 21 页里没有该页（死链）。

---

## 四、可以写 / 不能写（本轮用户口径）

**可以写**

- ✅ 代码与文档里能验证的**能力、节点名、路径、命令、参数、限制**（上面第二、三节全部）。
- ✅ 「**工作区文件、画布、长期记忆与交付物都落在你本机的数据目录与工作目录，不写进应用安装目录**」——依据：`guides/manual/longtask.md`、`longtask-store.js`、`docs/privacy-data-inventory.md`。

**不能写**

- ❌ **「数据不出本机」整体主张** —— `docs/privacy-data-inventory.md` 记录的出网面至少两处：① 用户自配的 AI 服务商 API；② `mt-agent.com`（更新 / 插件目录 / 扩展目录 / 创意工坊 / 讨论区 / 桌宠 / 本地后端下载）。
- ❌ 价格、订阅、授权、开源、免费主张（**用户本轮明确选择不写**）。
- ❌ 客户案例、试用方名称、用户数、下载量、性能倍数、第三方评测、获奖。
- ❌ 企业版 / SLA / 商用授权条款（**本仓库里没有任何依据**）。
- ❌ 竞品对比结论。
- ❌ WCAG / 无障碍合规声明（本轮未确立任何产品专属无障碍要求）。
- ❌ 来自 `docs/` 内部文档的**内部路径与包名**（`dsh-home/*`、`resources/dsh/gateway`、`@deepseek-ai/dsh-*`、`npm run deps:check` 等）——**默认不对外**，除产品/安全确认。

**⚠️ 与现行页面的显式冲突（有意移除，不是遗漏）**

- 现行 `web/index.html` 有 `pill.free`「永久免费 · MIT」（`index.html:205`）、整节 `oss.h`「永久免费开源」（`index.html:340-342`）、`nav.oss`「开源」导航（`index.html:185`）。
- 证据本身存在：`pipeline-console/LICENSE` = MIT License，`Copyright (c) 2026 M.S`。
- **但用户本轮口径是「不写授权 / 开源 / 免费主张」**，所以 `site-src` 版官网应移除这些内容。**是否彻底下线该节需产品确认。**

---

## 五、缺口清单（要用户补，不要自己编）

1. **思考强度档位数**（四档 vs 五档）—— 定稿后才能写。
2. **长周期任务「允许读取画布」开关**是否真的可用 —— 需一次运行复验，否则不写。
3. **音视频节点四组参数口径**（TTS 全局锁 / music_gen 格式 / video_gen 分辨率档 / remotion 参数档）—— 每组选一条。
4. **开发节点 note 字数口径**（60 字 vs 80 字）—— 选一条。
5. **「多供应商路由」这个词是否可用** —— 或改「多服务商」。
6. **Stack（官网怎么建）** —— 沿用现行单文件内联 `index.html`，还是改为模板生成。
7. **署名口径**：footer `ms2308`（`web/README.md`）vs LICENSE `M.S` —— 两处不一致。
8. **次要受众**（二次开发者 / 团队采购者）是否需要专属内容。
9. **中性色真源二选一**：`base.css` 的 `:root`（`#151517`）还是现行页面在用的 `theme-industrial`（`#0d1016`）—— 见 `design-tokens.md` §2.1 与 `DESIGN.md` 末尾待决条目。