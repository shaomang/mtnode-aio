# 「开发」节点（Dev Node）设计文档

> 状态：v1 设计 · 2026-08
> 参考：[tt-a1i/archify](https://github.com/tt-a1i/archify)（Agent 扫描代码库产出可核验架构图的 Skill）。
> 与 archify 的本质区别：archify 一次性产出静态架构图；MTNode 的「开发」节点是**活的、可剥洋葱的项目架构画布**——先大颗粒、逐层细化，每个功能块的「开发 / 细化」都先弹对话框确认、再在新建会话中运行，最终可按画布反向搭建项目。
> 应用内手册：`guides/manual/dev-nodes.md`（英文 `guides/manual/en/dev-nodes.md`，目录见 `guides/manual/index.json`）。

---

## 1. 概念与命名

| 术语 | 含义 |
|---|---|
| **开发节点（Dev Node）** | 项目中的一个功能块/模块。形态上是带 `dev: true` 标志的超级节点（`kind: "super"`），可嵌套子开发节点。 |
| **概述（note）** | 开发节点的 `note` 字段：**两段式**说明该模块——`【功能】`（面向非技术的设计描述）+ `【实现】`（面向技术人员的实现梗概）。折叠卡直接可见功能段，完整两段 `mtnode_canvas_get` 天然返回，供 Agent 快速定位。书写规范见 §6。 |
| **关系线（rel）** | 元素之间的 UML 风格连线：**普通直线**走向、可双向/单向/无箭头、线上可带文字（点选节点时该节点的关系线高亮）（如「调用」「实现」）。**只表达关系，不承载数据、不参与执行**；开发节点架构图中优先使用它（数据流管线仍用普通连线）。 |
| **开发会话** | 每次点击「开发 / 细化」并在对话框确认后**新建**一个智能会话来运行：标题「开发 · <节点标题>」/「细化 · <节点标题>」，工作区 = 项目根目录，首条消息为该模块的开发任务书。节点通过 `agentSessionId`（最近一次）+ `devSessionIds`（历史）关联，可用「会话 N」按钮回到最近一次。**「建议 / 问询」不建会话**：它们是只读调研运行（后台作业，见 §4）。 |
| **剥洋葱（按深度）** | 搭建策略：先建顶层大块（如 前端/后端/数据层），确认后再向下细分子块。**「细化」的口径是深度，不是本层展开多少个子块**：默认「深度细化到无法再细」——拆出的每个子块继续判断能否再拆，一路下钻（模块 → 文件 → 类 / 接口 / 枚举），产物为**多层功能块树**；也可选「只展开本层」，之后到各子块上分别点「细化」。细化对话框里同时给出当前子树的深度统计行。 |

命名说明：需求原文为「功能块」。最终采用「开发节点」——与功能入口「开发」按钮一致，且避免与超级节点既有概念混淆；节点徽章显示「开发」。

## 2. 为什么复用 `super + dev:true`（而不是新增独立 kind）

先例：**数据库超级节点**就是 `kind: "super"` + `db: true`（`renderer/app.js` 面板、`app-canvas.js:1715` 头部按钮区、`app-nodes.js` 序列化/patch、`dsh/gateway/canvas-plugin.mjs` 工具 schema 全链路已有成熟模板）。

复用 `super` 意味着零成本获得：

- 容器嵌套（`parentSuperId`）→ 洋葱式层级；
- 就地展开子画布（`superOpen`）、边缘 I/O 端子；
- `superConnect` 跨层自动桥接（`app-nodes.js:4870`）；
- 分组、删除保护、拖拽等全部既有交互。

`dev:true` 仅叠加：元素类型徽章与配色、「开发 / 细化 / 建议 / 问询」动作按钮（**顺序固定：开发 → 细化 → 建议 → 问询**；开发 / 细化弹对话框确认后在新建会话中运行，建议 / 问询是只读调研运行）、文件节点的「打开」按钮、`devPath`、`devStatus`、会话关联（`agentSessionId` + `devSessionIds`）、可连关系线、运行中指示（头部徽标 + 边框呼吸灯）。

## 3. 数据模型

在超级节点基础上新增字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `dev` | boolean | 标记为开发节点（与 `db` 互斥：`db` 优先视为数据库节点） |
| `devPath` | string | 项目根目录（绝对路径）。顶层块必填；子块缺省时继承最近祖先块的 `devPath` |
| `devStatus` | `pending` \| `wip` \| `done` | 开发状态：待开发 / 进行中 / 完成（默认 pending） |
| `note` | string（既有） | **概述**：两段式，必填 —— `【功能】` ≤80 字（面向非技术）+ `【实现】` ≤120 字（面向技术），合计 ≤200 字；规范见 §6 |
| `agentSessionId` | string（既有） | 最近一次绑定的开发 / 细化会话 id |
| `devSessionIds` | string[] | 该功能块名下的历史会话 id（每次「开发 / 细化」新建一个，最新在前，上限 24） |
| `devKind` | `module` \| `file` \| `class` \| `interface` \| `enum` | 元素类型（外框配色：绿 / 蓝 / 橙 / 紫 / 粉） |
| `devColor` | string | 外框颜色（`#rrggbb`，小写存储；空串 = 按元素类型默认色；可经 `mtnode_canvas_edit` 补丁设置）。用户手选色与**功能色卡自动上色**都写这一个字段——自动上色只在创建时写一次，之后仍可被手选覆盖或清空（见 §6「功能色卡」） |
| `devPreset` | string | 该功能块的 **Agent 预设**档（`AGENT_PRESETS` id：极简（默认）/ 标准 / 思维精简 / PTC 模式 / 创造；空串 = 跟随默认）。本块的「建议 / 问询」只读调研与「开发 / 细化」绑定会话都按它下达；**未自行选择的子功能块就近向上继承**，子块自选则以子块为准（旧名 `sketch` 自动认成 思维精简） |
| `devModel` | string | 该功能块选定的 **Agent 模型 id**（空串 = 未选择，跟随默认）。与 `devPreset` / `devEffort` **三档各自就近向上继承、互不牵连**；子块自选则以子块为准 |
| `devEffort` | string | **思考强度**档（`low` / `medium` / `high` / `xhigh` / `max`；空串 = 跟随默认）。弹层露出四档：轻 / 标准（默认）/ 强 / 最强；**思考档只看设置**，预设不再改写它 |
| `devProvider` | string | `devModel` 对应的**智能路由**（`deepseek-official` / `mtnode_<id>` / 服务商名）。可由模型反查自动纠正，未选模型时无意义 |
| `devFiles` | string[] | **核心文件列表**：本功能块最关键的源码文件，**最多 10 条**，以 `/` 分隔、**相对本块项目根（`devPath`）**（落在项目根内的绝对路径会被折成相对路径，根外绝对路径原样保留）。空 / 未填 = 折叠卡按兜底规则自动收集；**最外层（项目）开发块不列举**（读恒为空、写被拒绝）。详见下文「核心文件列表」 |

`mtnode_canvas_get` 序列化与 `mtnode_canvas_edit` create/update schema 均透出以上字段（`superTree` 也带 `dev` 标记，便于全局导航；`devFiles` 同时出现在 `superTree` 与节点快照，列表仅来自自动兜底收集时节点快照另带 `devFilesAuto: true`）。

## 4. 「开发」「细化」「建议」「问询」按钮：对话框确认 → 只读调研 / 新会话运行

通用对话框：`mtDialogForm()`（`app.js`，复用 `#mtDialog` 深色对话框宿主）——信息区（键值行 / 概述块 / 子元素清单）+ 可选输入区 + 多按钮；`requireText` 时输入为空不关闭并内联提示；Esc 取消、Ctrl+Enter 提交。

- 渲染位置：节点头部菜单栏**只保留元素类型徽章 + 颜色 / Agent 设定小按钮**；「开发 / 细化 / 建议 / 问询 / 文件 N / 会话 N」等动作按钮全部放在折叠卡 body 下方按钮组（**顺序：开发 → 细化 → 建议 → 问询 → 打开（文件节点）→ 文件 N（核心文件列表）→ 会话 N**）。body **保持精简**：只含按钮组 +（展开时）核心文件列表 + 上次建议摘要 + 在途调研状态行——项目根目录、状态字样（「已完成」等）、生效模型行一律不再常驻 body（避免无用信息占用空间）：路径与状态在「开发 / 细化 / 建议 / 问询」四个确认对话框展示，生效的预设 / 模型 / 思考强度看头部 🧠 按钮（含悬浮提示）。右键菜单提供同动作。
- **文件节点「打开」** `openDevFileNode(node)`（`renderer/app-devnode.js`）：`devKind = file` 的节点在下方按钮组多一个「打开」按钮。路径约定——文件节点标题 = 相对项目根（`devPath`）的路径（如 `renderer/app.js`），也支持绝对路径；标题不像路径时退回打开项目根目录；文件不存在或未设 `devPath` 时 toast 提示。**Markdown / YAML 文件改走应用内阅读器**（查看 / 编辑 / 保存，见「阅读器」小节）；标题为 `agent.md` 时自动回退打开既有 `AGENTS.md`。
- **「建议」`suggestDevNode(node)`**（`renderer/app-devnode.js`）—— 让用户不必自己想「下一步做什么」：
  1. **先确认**：`mtDialogForm` 展示现状（元素类型 / 开发状态 / 项目根 / 下层元素数 / 历史会话数 / 上次建议时间）并说明接下来的动作；可选填**本轮关注点**；未设 `devPath` 时给黄条提醒。按钮：「取消」／（有缓存时）「查看上次建议」／**「确认生成建议」**；
  2. **只读调研**：`dshRunTask(devSuggestPrompt(node), { workspace: devPath, runKey: "devsuggest:<节点id>", preset: "standard", effort: "high", systemPrompt: devSuggestSystemPrompt() })`。系统提示沿用规划模式的禁令口径（禁 write / edit / 有副作用命令 / 画布修改 / todo / goal / subagent，只允许 read / glob / grep / 只读命令 + calc 式核算），并且**不传 `node`**（避免画布作用域锁与节点回写）。对话框在同一宿主内切成进度态：实时滚动 `🔧 工具名 + 目标路径`、耗时与只读调用次数；「停止生成」= `dshCancelActive(runKey)`；
  3. **方案清单**：模型按契约只输出一个 JSON（`summary` ≤80 字、`basis` 3~5 条真实文件证据、`options` 恰好 4 条 `{title, desc, priority}`）。`devSuggestParse()` 容忍代码块围栏与前后杂文，兜底可解析「1. 【优先】标题 —— 说明」式列表并按优先级重排；少于 2 条判为失败 → 失败态给「再试一次」；
  4. **多选 + 补充 + 就地开发**：4 行复选框（数字键 1-4 快速勾选，默认勾选优先级最高的一条）＋「补充说明」输入框，底部按钮 **「取消 / 换一批 / 开发」**。点「开发」= `devSuggestBriefText()` 把「已勾选 N/M + `[优先级]` + 本轮明确不做（未选项）+ 用户补充 + 实施要求」拼成任务正文，交给与「开发」按钮**完全同一条路径**的 `startDevSessionWithText(node, brief)`（新建绑定会话 → `devStatus` 转 `wip` → **后台运行不跳视图**）；
  5. **缓存**：结果写入节点 `node.devSuggest = { at, summary, basis, items, picked, supplement }`，随工作流 JSON 保存；再次点「建议」可直接「查看上次建议」（复原勾选、不重跑模型）或用「换一批」重新评估；折叠卡上显示上次建议的一句话摘要。
- **「问询」`askDevNode(node)`**（`renderer/app-devnode.js`）—— 让用户直接问「这个模块现在怎么样 / 为什么这么设计 / 下一步做什么」，而不是先想方案：
  1. **先确认**：`mtDialogForm` 展示现状（元素类型 / 开发状态 / Agent 模型 / 项目根 / 下层元素数 / 历史会话数）并要求填写问题（`requireText` 必填）；未设 `devPath` 时给黄条提醒。按钮：「取消」／**「开始问询」**；
  2. **三层强制只读**：① 只读系统提示 `devAskSystemPrompt()`——只允许 read / glob / grep / 只读命令 / `mtnode_canvas_get` / `mtnode_db` 查询 / web_search / 加载技能，禁止 write / edit / 有副作用命令 / 画布修改 / todo / goal / subagent；② `dshRunTask(devAskPrompt(node, question), { …, permissionPreset: "read-only" })`——`app-db.js` 的 `dshRunTask` 新增 `opts.permissionPreset` 单次覆盖，网关按 read-only 权限档执行，写操作由 DSH 沙箱直接拦截（不依赖模型自觉）；③ 运行态并入「sug」（与「建议」同一套琥珀呼吸灯 / 运行队列 / 逐条停止，见下）；
  3. **后台作业**：`devAskJobs` 注册表（key = 节点 id）与「建议」同构——进度视图（`🔧 工具名 + 目标路径`、耗时与只读调用次数）→ 完成后就地切到回答视图（`<pre>` 原文）；可「返回后台」继续跑（完成后折叠卡出现「💬 问询已就绪（未查看）」可点接回，看过即消失）、「停止生成」= `dshCancelActive("devask:<节点id>")`；失败态可「重试」同题；
  4. **零写入**：回答只进内存作业（不写 `node.devAsk`、不落盘、不建会话、不改画布）；用户想据此动手 → 点「开发」按钮正式开工。
- `developDevNode` 与「建议 → 开发」共用的收尾函数：`startDevSessionWithText(node, text)`。

  - **「开发」`developDevNode(node)`**：
  1. 对话框上方显示**标题 + 现状**：元素类型、开发状态、项目根目录、下层元素清单（前 6 个）、**最近一次要求**（取自该块最近会话的最后一条用户消息）与模块概述；
  2. 用户在输入区填写**本次希望开发 / 迭代的内容**（必填）；
  3. 「开始开发」→ `createDevSessionForNode(node,"dev")` **新建会话**（`title = "开发 · " + 节点标题`，`workspace = devPath` 解析后的项目根），首条消息为 `_src:"dev-node"` 的开发任务书（标题 / 类型 / 概述 / 项目根 / 上层模块 / 现有子元素 / 完工要求）——**本次开发需求并入这条任务书，会话首轮只发这一条消息**（`agentSessionSend("", { _devContract: true })`，不再第二条追加）；
  4. 节点 `devStatus` 自动转 `wip`，由 `agentSessionSend()` 在**该新会话**里后台运行这条单消息任务书（**不切换视图**：留在画布，节点出现「运行中」徽标，左下角运行队列 / 会话列表可看进度）；「取消」直接返回，不留痕迹。（收尾与「建议」共用 `startDevSessionWithText()`）
- **「细化」`refineDevNode(node)`**：
  1. 对话框显示元素类型 / Agent 模型 / 项目根 / 现有子元素与概述，并**确认是否继续细化**；可选填写细化范围；
  2. **深度单选（对话框新增项）**：`DEV_REFINE_DEPTHS` 两档——**「深度细化到无法再细」（默认选中）**＝拆出的每个子块都继续判断能否再细，一路下钻到无法进一步细化为止（一般到文件级，文件还可拆类 / 接口 / 枚举），产物为多层开发节点树；**「只展开本层」**＝仅在本块内创建 1 层子元素、不下钻，之后到各子块上分别点「细化」。点选项只改选中态、不关闭对话框；
  3. **统计行**：对话框信息区多一行「细化深度」= `devDepthSummaryText(node)`（由 `devDescendantStatsOf()` 递归整棵子树得出，如「当前已 3 层 · 5 个块未到文件级（如 A、B、C）」/「当前已 4 层 · 已细化到文件级」/「当前 0 层（尚未展开下层元素）」），让用户先看清现状再决定深度；「建议 / 问询」的只读调研上下文也带同一行（`devDepthLineOf()`）；
  4. 三个出口：「取消」／「无需细化」（仅提示跳过，不改动画布）／「确认细化」；
  5. **无需 / 无法细化会当场提示** `devRefineBlockedReason(node)`：`class` / `interface` / `enum` 已是最细粒度元素；`file` 的子元素已全是类 / 接口 / 枚举；整棵子树每片叶子都已到文件 / 类级（未到文件级的块为 0）→ 视为**已细化到无法再细**，弹窗只给「知道了」并说明可先改元素类型、或到具体文件块上单独点「细化」（此时不出输入区与深度单选）；缺 `devPath` → 提示无法依据真实代码判断；
  6. 确认后同样**新建会话**（标题「细化 · 模块名」）运行 `devRefinePrompt(node, 范围, depth)`：**任务书按「深度」而非单层程度**书写，首行即声明本次深度档位并带上「当前子树深度」统计行；契约步骤——**0 先按深度判断该不该细化（已无下层结构 / 项目内找不到真实内容就直接告知无需·无法细化，不建节点）→ 1 依真实代码规划本块之下的整棵结构（深度模式下每片叶子都要自问还能不能再拆）→ 2 输出多层规划树（每个拟建子块标注名称 · 类型 · 是否还需继续下钻 + 理由 · 两段式概述拟稿 · 将用颜色；证据不足中途停在模块块上就标「待续下钻」）→ 3 一次确认覆盖整棵树（不逐层反复追问，确认前禁改画布）→ 4 自顶向下逐层创建（每层一次 `mtnode_canvas_edit`，`parentSuperId` 指向直接父块，禁止把不同层级平铺到同一层）→ 5 护栏（单层 >12 分批、本次新建总数约 60 上限，触顶或证据不足即停下报告已建到第几层、还剩哪些分支并询问是否继续下钻）→ 6 回写本节点与各中间层块的【实现】段「子块：A / B / C」→ 7 结尾报告新增到第几层·共多少块·叶子类型分布·待续下钻清单 → 8 类型与功能色卡配色 → 9 关系线（rel）与文件节点路径标题 → 10 先读 AGENTS.md → 11 不调用 mtnode-dev-architect 技能**；选「只展开本层」时第 1~2 步只规划紧接下一层，并在梗概里说明每个子块还需不需要继续细化。
- 历史会话：`devSessionIds` 记录该块全部会话；「会话 N」按钮与右键「回到最近一次会话」→ `openBoundDevSession()`（不新建）。节点改名 → `syncDevSessionTitles()` 跟随其历史会话标题；删除节点 → 一并删除其名下会话（先确认）；删除会话 → 从 `agentSessionId` / `devSessionIds` 摘除。
- **运行中指示**（`devNodeRunningState(node, wfNodes?)`，`renderer/app-devnode.js`）：当开发节点**自身**正在运行（`node.running`，整块作为超级节点被执行）、**块内任意后代节点**（递归，含子开发节点）正在运行、或**绑定的开发 / 细化会话**正在运行、或在途**只读调研（建议 / 问询）**（`devSuggestJobBusy` / `devAskJobBusy`）时，画布给节点加 `dev-running` 类（细分 `self` / `desc` / `sess` / `sug`；`sug` 为只读调研专属，用琥珀色呼吸灯 `.dev-running-sug`）：头部出现「运行中」徽标（旋转圆环），边框按元素类型颜色做**呼吸灯**（`@keyframes devRunBreathe`，边框色 + 光晕 1.9s 呼吸；**选中时呼吸不停**：只切换 `animation-name` 到加强版 `@keyframes devRunBreatheSel`，波谷 `.35`→`.6`、波峰拉满、光晕 16px→26px，并把青色选择环一起写进 keyframes，使呼吸灯与选中高亮同时可见——动画的 `border-color`/`box-shadow` 优先级高于 `.wf-node.sel` 普通规则，选择器额外带 `.super` 抬高权重才压得住后面那条 1.5px 描边）。判定随 `renderCanvas()` 每次重渲染执行，无需额外轮询。
- **「运行中」的两条口径（展示 vs 交互）**：一条会话可能同时在跑两件事——① 它自己那一轮（`st.running` / 宿主智能节点在跑，即 `sessionIsRunning`）；② 它名下的一组**计划并行任务**（`st._planPar`，取消句柄是那些 `planpar:*` runKey）。并行组开跑时 ① **故意为 `false`**（保用户随时改口、不必等整组跑完），所以凡是「只是显示在不在跑」的地方一律走展示口径 `sessionBusyForUi(st) = sessionIsRunning(st) ∪ planParBusy(st)`（唯一真源在 `renderer/app-plan.js`）：会话列表条目（`renderAgentSessionSidebar` 的 `.side-sess.running` + 「运行中」转圈）、开发块 `sess` 态徽标与呼吸灯（`devNodeRunningState`）、队列开发块行的文案取数（`devRunningSessionOf`）、逐条停止（`stopNode` 开发分支的绑定会话循环 → `stopSessionRuns`，能真正取消那一组的 runKey）、`stopAllRuns` 全部终止、以及画布构建会话的占用判断（`runningWfBuildSession`）。**交互口径不变**，仍用 `sessionIsRunning`：能否立刻发下一条 / 要不要进发送队列 / 能否压缩与分支，说的是「会话自己有没有被占用」，并行组不该把这些一起锁死。并行组开跑与收尾统一走 `planParNotify()`（运行队列 + 会话列表 + `renderCanvas()` 三处一起翻），杜绝「左下角看得见、列表与功能块一路显示空闲」这种自相矛盾。
- **左下角运行队列**（与处理节点同款展示）：`devRunningNodes(wfNodes)` 返回当前画布「运行中」的开发节点列表（与呼吸灯/徽标同一判定，`db` 超级节点与普通节点不计入），`collectRunQueue()` 将其收进「处理中」（`nodeKindCls` → `kind-dev` 行样式、`nodeKindLabel` → 「开发」标签、tooltip 显示运行来源）；会话开始 / 结束由 `app-assist.js` 调 `updateRunQueuePanel()` 即时进出队列；队列行的「■」逐条停止走 `stopNode` 的开发分支：递归停掉块内运行的后代（含嵌套开发块及其会话）+ 本块绑定的运行会话；`sug` 态（只读调研）只取消建议 / 问询作业本身（`devSuggestJobAbort` / `devAskJobAbort` + 出栈），不牵连节点与会话，队列 tooltip 按「建议调研中 / 问询中」区分（状态文案附带实时耗时与只读调用次数）。**点击队列行**（`jumpRunQueueItem` 的开发分支）：有在途建议 / 问询作业时直接打开对应的进度窗口（`devSuggestShowJob` / `devAskShowJob`，悬浮提示「点击查看调研进度」），其余运行态照旧定位节点；「全部终止」（`stopAllRuns` ③b）同样取消在途建议 / 问询作业，避免终止后队列残留「调研中」行。

### 4.1 技能适用边界（mtnode-dev-architect 仅用于画布构建）

内置技能 `mtnode-dev-architect`（`mtnode-agent-skills/mtnode/dev-architect/SKILL.md`）**只在「MTNode 画布上构建 / 分析开发节点架构」时使用**：模式 A 扫描建图、模式 B 先架构后搭建、在画布上细化建子节点（这三类由全局助手 / 智能会话按用户明确要求驱动）。

**「开发 / 细化」绑定会话不得调用本技能**：它们是基于项目根真实代码的开发 / 细化工作，规则已全部内置在各自任务书（`devNodeContractText` / `devRefinePrompt`，`renderer/app.js`）中（两段式概述、色卡、AGENTS.md 共识、细化按深度的 0~11 步契约等）。任务书末尾明确要求：**不要调用 mtnode-dev-architect 技能**。判断口径：画布构建场景（建图 / 建子节点 / 上色 / 连线）→ 可用；绑定开发 / 细化会话 → 禁用。

**「开发」需求一次完整写入**：开发对话框确认后任务书一次性写入会话，不要在会话里分两次输入补充需求（会造成上下文割裂、重复开工）；有补充请在本次需求文本里写全。

## 5. 使用流程

### 模式 A：扫描已有项目 → 生成架构画布（Skill 驱动）

1. 用户在会话/全局助手中调用 `mtnode-dev-architect`，给出项目文件夹；
2. Agent 限额扫描（目录树、依赖清单 package.json 等、入口文件、配置；单文件读取设行数上限）；
3. 产出模块地图草案；**不确定项必须用 ask_user_question 询问**（如：某插件/示例目录/生成产物是否纳入架构）；
4. 建画布：顶层开发节点（devPath + 项目总概述）→ 向下逐层子块（按深度下钻：模块 → 文件 → 类 / 接口 / 枚举，产物为多层功能块树）→ 元素间关系线（rel + relLabel）→ 顶部放「项目总览」input_text 索引（标题 + 功能段清单）→ createMarks 分区；
5. 用户可继续在某块上点「细化 / 展开 XX 块」触发下钻：**细化按深度口径**——默认深度细化到无法再细（一般文件级），也可选「只展开本层」；对话框带「细化深度」统计行与深度单选，确认后在新建会话中运行（见 §4）。

### 模式 B：新项目先架构、确认后搭建（Skill 驱动）

1. 用户指定新项目文件夹；自己（或请助手协助）搭建开发节点架构；
2. 助手按画布内容审阅：覆盖完整性、依赖闭环、概述缺失 → 提出建议并迭代（模糊处问询）；
3. **仅当用户明确「确认」后**才动工：按依赖顺序（被依赖者优先）逐块实现；
4. 每块实现优先引导用户点击该块「开发」按钮：在对话框里填写本次需求，确认后在该块**新建的开发会话**中施工；完成后把 `devStatus` 更新为 done 并补充概述（关键文件/对外接口）；
5. 全部完成后做一次整体自检（构建/运行/测试），回报结果。

### 问答纪律（两种模式通用）

- 任何不确定的纳入/排除、技术选型、目录约定 → `ask_user_question`；
- 概述必须基于扫描事实，禁止臆造模块职责；
- 细化按深度：默认深度细化到无法再细（一般文件级），用户可选「只展开本层」；大块未确认前不下钻（一次确认覆盖整棵规划树）。

### AGENTS.md 共识文件（生成开发节点时同步产出）

生成 / 更新开发节点架构时，在**项目根目录（devPath）**维护一份 `AGENTS.md`，作为本项目所有开发 / 细化 / 建议会话共享的**核心共识文件**——新会话一进来就知道文件放哪里、哪些路径绝对不能动。

```markdown
# AGENTS.md
## 目录约定
- 页面放在 `src/app/`
- 组件放在 `src/components/`
- API 放在 `src/app/api/`

## 不要修改
- `prisma/migrations/`
- `.env.local`
- `dist/`
```

- **生成时机**：模式 A（扫描建图）在扫描取证后、建画布的同时写 / 更新；模式 B（先架构后搭建）在架构确认后、动工前写（与用户一起确认目录约定与保护清单）；已有 `AGENTS.md` 时先读再增量更新，不覆盖用户手写共识；
- **内容来源**：目录约定来自真实目录结构；「不要修改」清单收录生成产物 / 迁移 / 密钥 / 第三方 / `dist` 等，不确定的路径问用户；
- **消费**：应用侧 `devNodeContractText`（开发任务书）、`devRefinePrompt`（细化任务书）、`devSuggestSystemPrompt` / `devSuggestPrompt` / `devSuggestBriefText`（建议调研与开工正文）、`devAskSystemPrompt` / `devAskPrompt`（问询只读回答）均内置「先读 AGENTS.md 并遵守（目录约定 / 不要修改）」；「建议 / 问询」不得给出触碰保护路径的方案，新文件按约定放置；
- **维护**：模块新增目录、保护路径变化时随架构同步更新。
- **画布入口（`agent.md` 入口节点）**：建图时在最外层（顶层功能块下）新建一个 `file` 类型入口节点，标题统一 `agent.md`，代表项目根的 Agent 共识入口；用户点该节点「打开」用应用内 **Markdown 阅读器**查看 / 编辑 / 保存。应用打开该入口时：项目根有 `agent.md` 则开它，否则自动回退到既有 `AGENTS.md`（既有 AGENTS.md 项目无需另建 agent.md 文件，新项目共识文件统一落 `AGENTS.md`）。

### 阅读器（Markdown / YAML 查看 + 编辑保存）

- 应用内文本阅读器两个：**Markdown 阅读器**（`openMdViewer`，文档渲染 + 标题大纲）与 **YAML 阅读器**（`openYamlViewer`，行号 + 键值高亮 + 大纲），共用同一窗体（`yaml-viewer-*` CSS 类）与 IPC 通道（`yaml-viewer:open` / `md-viewer:open`，见 `main.js` 的 `shell:openInAppDialog` 与 `preload.js`）；
- 两个阅读器均支持 **编辑与保存**：点「编辑」进入全文可改 textarea（`.viewer-editor`），`Ctrl+S` 或「保存」经 `file:writeText` 写回文件，成功后自动回到预览；「取消编辑」放弃修改；
- 打开入口：保存节点「打开」按钮 / 预览区点击（`openTextViewer` 按扩展名分发 .md/.yaml）、开发文件节点「打开」按钮（`openDevFileNode`：.md/.yaml 走应用内阅读器，其余走系统默认）、`openContentRef` 文件链接、以及系统打开 .md/.yaml 文件时主进程的转发；
- 开发节点 **文件** 类型「打开」现已覆盖 `agent.md` 入口：标题为 `agent.md` 时自动回退到 `AGENTS.md`。

## 6. 概述书写规范（两段式 · 唯一措辞真源）

> 本节是 `note` 写法的**唯一定稿**。提示词与任务书（`dsh/gateway/canvas-plugin.mjs`、`dsh/gateway/gateway.mjs`、`renderer/app-assist.js`、`renderer/app.js` 的开发 / 细化任务书、`renderer/app-devnode.js` 的建议任务书）、内置技能 `mtnode-dev-architect`、中英文用户手册一律**逐字复用**本节措辞与示例，不得各写一套——措辞漂移会让模型产出的格式重新退化。

### 6.1 格式

`note` = **两段**，顺序固定、各占一行、行首带全角标记（标记后紧跟内容，不加空格、不换行）：

```
【功能】<≤80 字>
【实现】<≤120 字>
```

- 两段合计 ≤200 字；
- **不允许只写一段**、不允许调换顺序、不允许把两段合并成一行；
- 行首标记 `【功能】` / `【实现】` 是渲染层解析器（`devNoteParts()`）的**唯一识别锚点**：折叠卡与进度概览行只显功能段，技术梗概按需展开，靠的就是这两个前缀。

### 6.2 第一段：【功能】—— 面向非技术读者

只用**业务 / 用户语言**说清三件事：这个模块**做什么**、**给谁用**、**解决什么问题**。

- ≤80 字，一句或两句短话，像写给产品/项目负责人看的说明；
- **禁止出现文件名、函数名、类名、目录路径、框架与库名、数据结构名**（`app-canvas.js`、`devColor`、`Electron`、`SVG` 这类一律不许出现在这一段）；
- 不写实现方式，只写「用户能感知到的能力」；不要写成空话（「负责相关功能」「提供支撑」）。

### 6.3 第二段：【实现】—— 面向技术读者

给出**实现方案的梗概**，让工程师不必翻代码就知道去哪儿找、怎么接：

- ≤120 字，须覆盖：技术栈 / 语言、关键文件或目录、数据流向与对外接口、主要依赖与边界（本块**不**负责什么）；
- 写真实存在的路径与符号名（来自扫描取证，禁止臆造）；
- `done` 状态的块在本段补上**关键文件 / 对外接口**，便于后续维护与 Agent 定位；
- **顶层块（项目根块）**：技术栈与 `对应目录：xxx` 一律写进本段，`【功能】` 段则是整个项目的总述（是什么产品、给谁用）。

### 6.4 其他元素类型

`file` / `class` / `interface` / `enum` **同规范**（两段、同样的标记与字数）：

- `【功能】` = 该元素对应的**可见能力**（用户或上层模块用它做什么）；
- `【实现】` = 成员 / 签名 / 职责（如导出的函数与入参、类的关键字段与方法、接口契约、枚举取值域）。

### 6.5 与其他规则的关系

- 功能色卡推断仍读**整段 `note`**（含 `【实现】` 段），权重规则不变：`score = 标题命中数 × 2 + 概述命中数`（见下文「推断规则与关键词表」）——两段式只是书写约定，不拆段加权、不改动色卡；
- 旧画布里的单段概述**不报错、不清空**：解析时整段归入 `【功能】`、实现段为空，界面正常显示；下一次「细化 / 开发 / 建议」时按本节规范回写为两段；
- `note` 长度仍无硬校验（无 clamp），≤200 字是提示词层约定而非代码断言。

### 6.6 正例

**模块块（`devKind = module`）**

```
【功能】让用户像搭积木一样编排工作流：在画布上摆节点、连线、点运行就能看到每一步产出，出错时能一眼定位到具体是哪一步。
【实现】Electron 渲染层，对应目录：renderer/。app-canvas.js 负责节点与连线绘制，app-nodes.js 负责增删改与批量编辑，状态单向渲染；不直连网关。
```

**文件元素（`devKind = file`）**

```
【功能】让用户把资料存成一张可查可算的「事实库」，并在会话里直接提问得到有出处的回答，而不是让模型凭记忆瞎编。
【实现】renderer/app-db.js：FTS 增量索引与 query/list/get/calc，记录存为超级节点 subFolder 下的 JSON；对外经 mtnode_db 工具暴露，回写走 write/delete，不参与画布执行。
```

**顶层项目块（含目录映射）**

```
【功能】一款给非程序员用的可视化 AI 工作流桌面应用：在画布上把「输入 → 处理 → 输出」连起来，点一下就能批量跑图片、文本与音视频生成。
【实现】对应目录：pipeline-console/。Electron（main/preload/renderer）+ dsh 网关（Node），二者经 IPC 通信；渲染层管画布与交互，网关管智能会话与工具。
```

### 6.7 反例

```
❌ renderer/app-devnode.js，负责开发节点配色与模型继承
```
没有两段标记，非技术读者完全看不懂——功能段缺失。

```
❌ 【功能】用户点击 devColor 按钮触发 devColorSyncAll() 刷新 app-canvas.js 里的节点边框。
```
功能段塞满符号名与文件名；应写成「让用户一眼按功能区分模块，不必逐个手动调色」。

```
❌ 【实现】用前端技术实现，包含若干函数与组件，逻辑较为复杂。
```
实现段全是空话：没有路径、没有接口、没有边界，工程师无法定位。

```
❌ 【实现】画布渲染层。【功能】app-canvas.js + SVG。
```
顺序颠倒且挤在同一行，且两段内容互换——解析器认不出、界面只显功能段时会把代码名甩给非技术用户。

### 配套的执行节点（启动器）

`execute` 节点在创建菜单里**归入「开发节点（项目架构 · 功能块）」二级菜单**（模块 / 文件 / 类 / 接口 / 枚举 → 执行），因为它的用途就是给项目或某个功能块配一个一键启动器：

- 右键功能块 → 「在内部新建执行节点（启动器）」→ 直接在该块内部创建 `execute` 子节点（`parentSuperId` = 该块）并立刻弹出文件绑定对话框；
- 展开壳层内直接右键空白添加，或在顶层添加后拖入壳层，同样成为该块的子节点；
- 它仍是独立工具节点：无数据端子、不参与执行与批次，只承载「启动本地文件」这一动作，与架构节点之间**不连数据线**（要表达归属关系时放进块内即可）。
- **body 不重复显示标题**：标题只在节点头部显示；body 顶部仅保留自定义图标（居中），下面是两段式大播放键与路径行，避免「执行」节点小尺寸时标题叠行。
- **独立进程启动（不随 MTNode 退出）**：执行节点不走 `shell.openPath`（ShellExecute 会把目标挂进 MTNode 进程树、共用控制台，主程序一退出 console 就被带走——编译脚本会因此中断），而是走主进程新增的 `shell:openPathDetached` IPC（`main.js` + `main-exec-launch.js`，`preload.js` 暴露 `shellOpenPathDetached`，`renderer/app.js` `runExecuteNode` 优先调用并回退旧通道）：win32 用 `cmd.exe /d /c start "" <path>`（`detached:true + stdio:ignore + windowsHide:true + unref`），`start` 创建**全新进程组 + 新控制台窗口**、中间 cmd 立即退出，目标进程与 MTNode 进程树彻底脱离——编译脚本等 console 程序独立存活，主程序关闭不影响；文档类文件同样交给 `start` → 系统默认应用。非 win32 可执行扩展名走 `spawn(detached)`，普通文件回退 `shell.openPath`。纯逻辑集中在 `main-exec-launch.js`（`buildLaunchSpec` / `launchDetached`，无 Electron 依赖），冒烟测试见 `test/smoke-exec-detached.js`（36 项断言）。

### 开发节点自定义颜色（HSV 色板）

每个开发节点（`super + dev:true`）的节点头部菜单栏在元素类型徽章旁多了一个**颜色小按钮**（圆点 = 当前色），点击展开 **HSV 色板弹出层**（`#devColorPop`，fixed 定位跟随按钮；面板 persistent：**点外部不收起**，只走「完成」/ ✕ / Esc / 再点一次按钮，画布平移缩放后自动跟回按钮）：

- **选色**：`S × V` 方块（横向饱和度、纵向明度）＋ 色相条，拖动即时生效；也可直接输入 `#rrggbb`（回车应用）；
- **数据**：写节点 `devColor`（小写 hex，随工作流 JSON 保存；`mtnode_canvas_get` 序列化透出、`mtnode_canvas_edit` 支持补丁）；
- **渲染**（`renderer/app-canvas.js` `nodeElement` + `renderer/css/canvas.css`）：设了 `devColor` 的节点加 `.dev-custom-color` 并注入 `--dev-color`（外框色）与 `--dev-glow`（运行呼吸灯 RGB 三元组），覆盖元素类型的默认配色；清空（「恢复元素类型默认色」）即回到类型配色；
- **实现**（`renderer/app-devnode.js`）：`devColorOf` / `devShownColor` / `hexToRgbTriplet`（hex→`r, g, b`）与 HSV↔RGB/HEX 转换（`hsvToRgb` / `rgbToHsv` / `hsvToHex` / `hexToHsv`）；`devColorButtonEl` 造按钮、`devColorSyncAll` 在拖动中就地刷新节点 DOM 与按钮圆点（不整板重绘，色板不被打断）；色板与其余节点参数面板一律 persistent（`renderer/app.js` 的 `closeNodePopsExcept` 负责互斥、`nodePopAnchor` + `applyTransform → repositionNodePops` 负责跟画布与「宿主节点没了就收」，**没有**「点外部收起」那条路径）。
- **色板里另有一行「功能色卡」快捷色块**（见下一小节）：手选 HSV / Hex 与点功能色卡写的是同一个 `devColor`，两者等价、互相覆盖。

### 功能色卡（按功能分类给功能块上色）

需求：**创建开发节点时，按「功能分类 + 元素类型」两个维度自动给出不同的颜色边框**——预先设计一套色卡对应不同功能，用户不必手动一个个调色，架构图打开就按功能分区可读；两个维度分工明确：**功能色管模块层，元素类型色管文件 / 类 / 接口 / 枚举**。

实现全部集中在 `renderer/app-devnode.js` 的常量 `DEV_FUNC_COLORS`（`{ key, zh, en, hex, keywords }[]`，与元素类型默认色常量 `DEV_KIND_COLOR` 并列）。**唯一真源约定**：色板 UI、自动上色、Agent 透出、设计文档 / 用户手册色值表、冒烟测试一律复用这份常量的 `key / zh / en / hex / keywords`，**禁止在别处硬编码色值或另立分类名**。

#### 色卡表（8 个功能分类）

| key | 中文 | English | 外框 / 呼吸灯 | 归这类的内容 |
|---|---|---|---|---|
| `core` | 核心运行时 | Core runtime | `#6db4ff`（蓝） | 主进程、窗口与菜单外壳、启动引导、状态机、编辑器引擎、快捷键与撤销 |
| `canvas` | 画布与交互 | Canvas & interaction | `#45cfe6`（青） | 画布渲染、连线与排版、标注、面板弹层、缩放拖拽、主题与 CSS |
| `ai` | AI 与 Agent | AI & agents | `#c792ea`（紫） | 智能节点与会话、助手、网关、模型与提示词、推理与 token、MCP / DSH |
| `data` | 数据与存储 | Data & storage | `#4dd0c4`（青绿） | 数据库与建表、存储与持久化、缓存与配置、导入导出、副本与迁移、JSON/YAML/CSV |
| `media` | 媒体与本地后端 | Media & local backends | `#ff8fa3`（粉） | 文生图、音乐 / 视频 / 音频 / 语音、TTS / ASR、显存与 GPU、ComfyUI / ffmpeg 后端与权重 |
| `plugin` | 插件与生态 | Plugins & ecosystem | `#f0c14d`（黄） | 插件与扩展、技能、商店与市场、云端服务端、套件与目录 |
| `build` | 构建与诊断 | Build & diagnostics | `#ff9d5c`（暖橙） | 构建打包发布、脚本与 npm、更新升级、日志诊断与崩溃上报、部署 CI |
| `test` | 测试与质量 | Tests & quality | `#a8e05f`（黄绿） | 测试与冒烟、断言、覆盖率、用例与质检、回归、lint / mock / e2e |

色相刻意**与元素类型默认色同族**（`core` 蓝 = 文件蓝、`ai` 紫 = 接口紫、`media` 粉 = 枚举粉），因此父块按功能上色后，下层 `file / class / interface / enum` 元素的类型配色看起来仍然连贯；`canvas` / `data` / `plugin` / `build` / `test` 是色卡独有的 5 个色相。

#### 优先级规则

**用户手选 > 功能色 > 元素类型默认色**，三条都落到同一个字段 `devColor` 上：

1. **用户手选（最高）**：`devColorOf(node)` 非空即最终色——色板里拖 HSV、输入 Hex、点功能色卡色块，写的都是 `devColor`；自动上色**只填空值**，绝不覆盖调用方显式传入或用户已选过的颜色；
2. **功能色**：`devColor` 为空时，`devFuncColorOf(node)` 按标题 + 概述推断分类，取该分类 hex；**仅作用于 `devKind = module` 的功能块**，`file / class / interface / enum` 不参与（保持类型默认色，层级一眼可辨）；未归类（一个关键词都不命中）返回空串 = 不上色；
3. **元素类型默认色**：兜底 `DEV_KIND_COLOR[devKind]`（模块绿 `#6fe3a5` / 文件蓝 `#6db4ff` / 类橙 `#ffb454` / 接口紫 `#c792ea` / 枚举粉 `#ff8fa3`），即 `devShownColor()`。

「**恢复元素类型默认色**」= 把 `devColor` 清空：既退掉手选色，也退掉当初自动写入的功能色（功能色是**一次性落地**的持久值，不做每次渲染重算——否则用户想保留的分类色也会被冲掉）。数据库超级节点（`db:true`）与普通节点完全不参与本套配色。

#### 自动上色的两个入口

创建时调用 `devAutoColorNode(node)`，把推断出的功能色**写入** `node.devColor`（返回实际写入的 hex，未上色返回空串）：

- Agent 侧：`mtnode_canvas_edit` create → `applyCanvasEdit`（`renderer/app-nodes.js`），**必须在 `title` / `note` 定稿之后**调用（归类靠这两项推断）；
- 手工侧：右键「开发节点（项目架构 · 功能块）」等 `addNode` 入口（`renderer/app.js`），`extra` 里显式给了 `devColor` 时优先、不覆盖。

生效条件（全满足才上色）：是 `dev` 超级节点且非 `db` + `devKind = module` + `devColor` 为空。

#### 推断规则与关键词表

只看 `title` 与 `note` 两个字段，命中打分：**`score = 标题命中数 × 2 + 概述命中数`**（标题短而具体，更能定性）；最高分胜出，**同分按 `DEV_FUNC_COLORS` 声明顺序取先者**（`core → canvas → ai → data → media → plugin → build → test`）；全为 0 分则不上色。

匹配口径：中文关键词按**子串**匹配；纯 ASCII 关键词按**单词边界**正则匹配（`(^|[^a-z0-9])kw($|[^a-z0-9])`，忽略大小写；边界含 `-`，所以 `electron-builder` 算整词命中，而 `ai` 不会误命中 `chain` / `detail`），正则按关键词缓存（`_devFuncKwCache`）。

| 分类 | 中文关键词 | 英文关键词 |
|---|---|---|
| `core` | 主进程 · 外壳 · 启动 · 引导 · 状态机 · 运行时 · 内核 · 窗口 · 菜单 · 快捷键 · 撤销 · 编辑器 · 引擎 | `main` `main-process` `shell` `bootstrap` `startup` `runtime` `kernel` `electron` `window` `menu` `hotkey` `shortcut` `undo` `redo` `core` |
| `canvas` | 画布 · 连线 · 排版 · 标注 · 主题 · 交互 · 组件 · 弹层 · 面板 · 视图 · 缩放 · 拖拽 · 框选 | `canvas` `render` `renderer` `layout` `wire` `edge` `widget` `panel` `toolbar` `tooltip` `zoom` `drag` `theme` `marks` `ui` `ux` `css` |
| `ai` | 智能体 · 智能会话 · 智能节点 · 网关 · 会话 · 助手 · 提示词 · 大模型 · 模型 · 推理 · 对话 · 意图 | `agent` `agents` `ai` `llm` `model` `models` `gateway` `session` `chat` `assistant` `prompt` `prompts` `reasoning` `token` `mcp` `dsh` `harness` `deepseek` `minimax` |
| `data` | 数据库 · 存储 · 持久化 · 缓存 · 配置 · 设置 · 导入 · 导出 · 备份 · 副本 · 数据表 · 建表 · 记录 · 迁移 | `database` `db` `sqlite` `fts` `storage` `persist` `cache` `config` `settings` `import` `export` `backup` `replica` `schema` `migration` `json` `yaml` `csv` |
| `media` | 文生图 · 音乐 · 视频 · 图像 · 图片 · 音频 · 语音 · 显存 · 后端 · 权重 · 补帧 · 超分 | `music` `video` `audio` `image` `images` `tts` `asr` `vram` `gpu` `comfyui` `backend` `ffmpeg` `voice` `thumbnail` |
| `plugin` | 插件 · 技能 · 扩展 · 生态 · 商店 · 市场 · 云端 · 服务端 · 套件 | `plugin` `plugins` `extension` `extensions` `skill` `skills` `marketplace` `catalog` `store` `ecosystem` `server` `cloud` `registry` |
| `build` | 构建 · 打包 · 发布 · 脚本 · 更新 · 升级 · 日志 · 诊断 · 崩溃 · 监控 · 安装 | `build` `bundle` `package` `packaging` `release` `script` `scripts` `npm` `vite` `electron-builder` `updater` `update` `changelog` `log` `logs` `diagnostic` `diagnostics` `crash` `deploy` `ci` |
| `test` | 测试 · 冒烟 · 断言 · 覆盖率 · 用例 · 质检 · 回归 | `test` `tests` `testing` `smoke` `lint` `coverage` `assert` `assertion` `spec` `fixture` `mock` `e2e` `regression` `qa` |

#### 色板里的色卡行

HSV 色板弹出层（`#devColorPop`）内除方块 / 色相条 / Hex 外，还有**一行功能色卡**：8 个分类色块，鼠标悬浮显示分类名（中文界面取 `zh`，英文界面取 `en`）。

- **点某个色块** = 把该分类 `hex` 直接写入本块 `devColor`（等价于在 HSV 里选到同一个值）：先 `pushHistory()` 可撤销，再 `devColorSyncAll()` 就地刷新节点外框 / 呼吸灯与按钮圆点与 Hex 输入，并 `scheduleSave()`；
- **对下层元素**（`file / class / interface / enum`）色卡行同样可点——色卡只是快捷色，限制只在**自动上色**那一侧；
- 反选回到类型默认色仍是「恢复元素类型默认色」按钮（清空 `devColor`）。

#### Agent 侧口径

`devColor` 对 `mtnode_canvas_get` / `mtnode_canvas_edit` 一贯可读可写，因此助手可按用户要求「按功能色卡给这几块上色」直接补丁对应 hex。改色纪律不变：**先征询用户、勿擅自统一改色**；新增或调整分类、色值、关键词时，必须同一轮内改完 `DEV_FUNC_COLORS` + 色板 UI + 本小节 + 中英文手册色值表（三者数值必须与常量一致）。

### 开发节点 Agent 设定（🧠 按钮 · 预设 / 模型 / 思考强度 + 就近继承）

同一个菜单栏区域在颜色按钮旁再加一个 **Agent 设定小按钮**（`🧠` + 当前生效值摘要，三格全未指定 = 「自动」灰态，继承 = 虚线并点名来源功能块），点击展开 **Agent 设定弹出层**（`#devModelPop`，顶部**三格并列——预设 / 模型 / 思考强度**，与智能会话里的 Agent 菜单同一张档位表；fixed 跟随按钮；与色板同为 persistent 面板：再点按钮 / ✕ / Esc 收起，点外部不再收起）：

- **预设 `devPreset`**：`AGENT_PRESETS` 的档位——极简（默认）/ 标准 / 思维精简 / PTC 模式 / 创造；清单顺序即档位表顺序，悬停有说明（旧名 `sketch` 自动认成 思维精简）；
- **模型 `devModel`（+`devProvider`）**：按**智能路由分组**（`agentRouteOptions()` = DeepSeek 官方 + 已配置的其它服务商），组名取服务商显示名，组内列 `agentModelsForRoute(route)` 的模型；当前项打勾；一个模型都没有时提示先去「设置 · 模型服务」添加；
- **思考强度 `devEffort`**：`low`=轻 / `medium`=中 / `high`=标准（默认）/ `xhigh`=强 / `max`=最强；弹层露出**四档：轻 / 标准 / 强 / 最强**（`medium` 是合法词汇，但默认 DeepSeek 路由会把它夹到 `low`，故不在 UI 露出）。**思考档只看设置**，预设不再改写它（早先「思维精简」把标准压到 low 的口径已取消），路由能力不足时网关夹到同侧最近低档并回显「所选档 → 实际生效档」；
- **数据**：写节点 `devModel`（模型 id）+ `devProvider`（路由）+ `devPreset` + `devEffort`，随工作流 JSON 保存、`mtnode_canvas_get` 透出、`mtnode_canvas_edit` 可补丁（Agent 侧 schema 一并暴露 `devColor` / `devModel` / `devProvider` / `devPreset` / `devEffort`，因此助手能按用户要求改色、改模型与两项档位；未知预设 id 会被拒绝并回报，`devEffort` 集合外值一律丢弃并回报，传空串 = 清除回跟随默认）；
- **就近继承**：模型 / 预设 / 思考强度**三档各自**沿 `parentSuperId` 向上找**第一个已选该档的祖先块**（`inherited: true` + `source` 指向它），互不牵连——可以在顶层块一次统一整棵树的模型与预设，再单独给某个子块换思考档；任何子块单独选过即以子块为准。数据库超级节点（`db`）与普通节点不参与；
- **作用范围**：①「建议 / 问询」的只读调研把 `provider/model/preset/effort` 传给 `dshRunTask`（并在进度日志首行写明「本轮模型：服务商 · 模型（继承自「×」）」）；②「开发 / 细化」新建的绑定会话直接以所选三项开局（`createDevSessionForNode`）；③四个确认对话框（建议 / 开发 / 细化 / 问询）都多出「Agent 设定」一行（折叠卡 body 不再常驻生效模型行，生效值看头部 🧠 按钮）。三格各自的「跟随默认（不指定）」只退这一格，可撤销；
- **实现**（`renderer/app-devnode.js`）：`devAgentRoutes` / `devAgentRouteName` / `devAgentModelGroups` / `devModelFitsRoute` / `devRouteOfModel`（路由与模型互校，路由失效或不匹配时**以模型为准**反查路由）→ `devModelOwn` / `devAgentModelOf` / `devAgentModelText` / `devModelScopeText` / `devModelDialogText` → `devModelButtonEl` / `devModelButtonRefresh`（不整盘重绘也能就地刷新按钮）→ `devModelPopEl` / `renderDevModelPop` / `openDevModelPop` / `applyDevModelChoice` / `toggleDevModelPicker`；`applyDevModelChoice` 先 `pushHistory()`（可撤销）再 `scheduleSave(true)`，`S.uiDevModelNode` 只用来记住「哪块正在选」：面板 persistent（**不再**由 `app.js` 的全局 mousedown 点外部收起），互斥收起走 `closeNodePopsExcept`、跟画布走 `repositionNodePops`，全局 keydown 里 Esc 同时收起色板与 Agent 设定弹层（Hex 输入框聚焦时也生效）。

### 核心文件列表（`devFiles` · 「文件 N」按钮）

需求：让用户在功能块上**一眼看到、并一键跳到本模块最关键的几个源码文件**——不必先展开壳层、也不必去项目树里翻。

- **上限 10 条**：常量 `DEV_CORE_FILES_MAX = 10`（`renderer/app-devnode.js`）。裁剪、去重、路径归一**只在 `devCoreFilesNormalize(list, node, stats)` 一处**强制，UI 手工编辑、Agent `devFiles` 补丁、自动兜底收集**三个写入口全部经过它**（避免各处各写各的口径）；被裁掉的条数经 `stats.dropped` 回报，界面 toast 提示「核心文件最多 10 个，多余部分已忽略」，不静默丢弃。
- **顶层（项目）节点不列举**：祖先链上再无开发块的那一块 = 项目节点，它的「核心文件」等于整个项目，没有信息量。口径统一走 `app.js` 的共用真源 `devIsDevBlock(node)` / `devIsTopBlock(node)`（`devProjectRootOf()` 也复用同一对函数，判定永不分叉）：顶层块 **读恒为空、写被拒绝**（`devCoreFilesSet()` 返回 `null`；`applyNodePatch` 丢弃补丁并 `warnings.push` 点名原因），并且**连「文件」按钮都不渲染**（`devCoreFilesButtonVisible()`）。
- **三条来源合流**（优先级从高到低）：
  1. **会话回写**（长期有真实数据的关键）：开发 / 细化 / 建议任务书都明确要求——收尾除回写 `note` 与 `devStatus` 外，**同时用 `mtnode_canvas_edit` 的 `devFiles` 补丁回写本模块核心文件**；细化时每个新建模块块顺手带上，不留给以后补。网关 `create` / `update` 两处 schema 均声明该字段（`additionalProperties:false`，不声明 Agent 就传不进来）；
  2. **用户手工编辑**：展开面板头部「编辑」→ `mtDialogForm` textarea（**每行一个路径**，预填当前列表）+ 动作「自动收集 / 清空」（只改输入框、重开同一对话框回填，避免两套输入控件）+「确定」才写入；
  3. **自动兜底**（前两者都为空时，`devCoreFilesAutoOf()`）：本块自身是 `file` 级块则取其标题 → 本块概述 `【实现】` 段里出现的**路径 token**（`devCoreFileTokensOf()`，扩展名白名单 `DEV_CORE_FILE_EXTS`：宁可少收，不把 `renderer/`、`%APPDATA%`、`FTS5`、`v1.1.28` 当文件）→ 后代 `devKind = file` 块的标题（标题按约定就是相对项目根的路径）。来源经 `devCoreFilesSourceOf()` 回报 `manual` / `auto`，界面据此在面板头部标「自动收集 · 点『编辑』确认」或「已确认」，`mtnode_canvas_get` 也只在纯兜底时透出 `devFilesAuto: true`。
- **存储取向**：分隔符统一存 `/`；绝对路径若落在本块项目根内**折成相对路径**（与保存节点 `preferRelativeSavePath` 同一取向，便于展示与去重），根外绝对路径原样保留。单条清洗（`devCoreFileNormEntry`）剥引号 / 括号包裹与首尾标点、去掉 `./`、拒绝**越出项目根的 `../` 写法**（展示与定位都按 `devPathOf(node)` 解析，放它进来等于开了条逃出项目根的路）、拒绝通配符 / 目录（尾斜杠）/ 超过 `DEV_CORE_FILE_MAX_LEN = 240` 的脏数据。
- **UI**（`renderer/app-canvas.js`）：按钮 `文件 N`（N = 条数，0 条只显示「文件」）插在**「打开」之后、「会话 N」之前**，`onclick` 先 `stopPropagation`（不触发超级节点展开/选中）再 `toggleDevFilesPanel(node)`；展开态记 `S.uiDevFiles = node.id`（与 `S.uiDevModelNode` 同一做法，只存节点 id），画布重绘时由 `nodeElement()` 在按钮行之后复原面板。样式全部作用在折叠卡 `.n-dev-info` 内（`renderer/css/canvas.css`）：按钮 `.n-dev-files-btn`（`.on` = 已展开）、面板 `.n-dev-files` + 头部 `.n-dev-files-head`（来源提示 +「编辑」`.n-dev-files-edit` +「打开项目根」`.n-dev-files-root`）、列表 `.n-dev-files-list`（自身 `max-height` 滚动，避开 `.n-body` 裁剪）、行 `.n-dev-file`（`.f` 文件名 / `.p` 灰色相对路径 / `.miss` 不存在标记 / `.missing` 行态）、空态 `.n-dev-files-empty`；颜色一律取既有 CSS 变量，暗 / 亮主题都可读，`[hidden]` 显式兜底 `display:none`。新中文词条在 `renderer/i18n.js` 补齐英文镜像。
- **点一行 = 定位该文件**：`revealDevCoreFile(node, entry)` → `devCoreFileAbs()` 解析绝对路径 → **`window.api.shellShowItem(abs)`**（在资源管理器中选中该文件，即打开其所在文件夹；**复用既有 `shell:showItem` IPC，不新增主进程能力**）。解不出路径 / 未设 `devPath` / API 缺失一律 **toast 说明原因**，与 `openDevFileNode()` 同口径，绝不静默。每行显示 文件名（`devCoreFileLabel()`）+ 灰色相对路径，「不存在」标记由异步 `window.api.fileExists` 回填，结果缓存到模块级 `_devFileExistsCache`，只改 `.miss` 与 `.missing` 类、**不整盘重绘**。
- **写入与持久化**：`devCoreFilesSet()` = 归一化 → 与旧值比较（相同不动）→ `pushHistory()`（可撤销）→ `scheduleSave(true)`；字段挂在 `NODE_DEFAULTS.super.devFiles`，`persist()` 全量序列化工作流、`migrateWf` 对 super 无字段白名单，故与 `devSuggest` 同机制自动随工作流 JSON 保存。
- **测试口径**：`node test/smoke-dev-corefiles.js` 覆盖规范化（去重 / 裁剪到 10 / 绝对折相对 / 拒绝 `../`）、顶层块与非开发块**读写双向拒绝**、按钮渲染与「文件 N」计数、展开与再点收起、行点击调 `shellShowItem`、编辑对话框写回、兜底收集（后代 `file` 标题 + 概述 token）、`canvas_get` 快照与网关 schema 接线、CSS / i18n / 手册 / CHANGELOG / 技能索引接线；并须与既有 `node test/smoke-dev-suggest.js`、`node smoke.js` 一起保持通过（`devProjectRootOf` 相关回归 `test/smoke-workspace-project.js` 会把该段源码抠进沙箱独立跑，故 `devIsDevBlock` / `devIsTopBlock` 必须留在 `app.js` 同一节内）。

## 7. 关系线渲染与架构图排版

### 关系线为什么必须「整层一起规划」

早期实现是**一条线一次绘制**（`renderRelWire(w)`）：每条线只看自己两端，于是同一侧的多条线全部接在同一个角点上、同走廊的中段互相压线；更致命的是它和各壳层自己的连线重绘（`updateSuperInnerWires` 按 `swire-*` 白名单清理残留）抢同一个 `<svg>`，线芯刚画完就被当成残留删掉，只剩外圈和文字——**表现为「关系线不显示 / 没有箭头」**。

现在：

- `updateWires()` 走完所有普通连线之后，**最后**调用一次 `renderRelWiresPass(filter)`；
- 它用 `collectRelWireScopes()` 把本层可见的关系线**按所在壳层分组**，每组一次性跑 `relPlanScope()`：
  1. `relBorderAnchor()` 定两端出射边：把「中心 → 对端中心」的射线与方块边框求交，交点落在哪条边就从哪条边出（直线最自然）；
  2. 该侧只有一根线时直接用这个天然出射点；同一节点同一侧有多根线时改用 `relSpreadSide()` **扇形分散**到不同锚点（边不够长就对称撑开）。排序键由 `relPlanAnchors(items, refine)` 决定：第一趟用「对端方块中心」，之后最多两趟改用**对端上一趟算出的锚点**（真实来向）——只按中心排序时，两条线进出同一块方块的先后可能颠倒，留下一个 X 形交叉；
     收敛是**贪心且可回退**的：每趟后用 `relGeomScore()`（直线两两交叉对数，次级键 `relFanInversions()`）打分，只有严格变少才接受，否则恢复上一趟的锚点并停止（避免两端互相牵引产生抖动）；线数 > `REL_REFINE_MAX`（120）的层级跳过收敛趟；
  3. `relSeparateStraight()` 处理叠线：两条直线若有 3 个以上采样点互相距离 < `REL_SEP_TOL`，就把两端**沿各自的边同步滑开**（仍然贴边，只换进出点）；
  4. `relStraightPath()` 输出**一段直线**（两端各留 `REL_END_GAP` 空隙给箭头），文字落在中点法线一侧；
  5. 线上文字再与已放文字互相避让；
- 拖拽中 `filter` 只重绘涉及的线，但**规划始终基于全量**，所以锚点不会在拖拽时抖动；没被重画的线也会刷新高亮状态（`applyRelWireState`）；
- 高亮状态由 `relWireVisualState()` 统一决定：`sel`（点线本身，橙）/ `linked`（点它连的节点或宿主壳层，青色 + 光晕）/ `dim`（与本帧选中无关的线，淡出）。只有**选中节点确实连着至少一条关系线**时才淡出别的线，点一个孤立块不会让整张图消失；`refreshRelWireStates()` 让「只改选中态、不重排几何」的场合也即时亮起；
- 箭头是 `marker-start` / `marker-end` + `orient="auto-start-reverse"`，`markerUnits="userSpaceOnUse"`（不随线宽缩放），并且 **`<defs>` 按壳层隔离**（`relArrow` / `relArrow-<host>`），避免多个展开壳共用一份 marker 时箭头丢失；
- 关系线由自己那趟绘制，所以 `updateSuperInnerWires` 的残留清理会跳过 `rsw-*`；`cleanupStaleRelWires()` 统一回收消失的线（含 `-r` 外圈与文字）。

### 排版：关系线参与分层

`layoutFlowEx()` 过去第一行就把 `rel` 连线滤掉（"关系线不参与排版"），于是**纯关系线的架构图退化成 5 个一行的方块网格**，关系线全部横穿方块、叠成一团。现在：

- `layoutEdgeSets(nodes, wires)` 把边分成**硬边**（参与分层：数据连线永远算硬边，`relArrow:"backward"` 的关系线反向，`both`/`none` 只算软边）和**软边**（只影响顺序与对齐）；
- 逐条按位置确定性处理，遇到**成环**的关系线就降级为软边（硬边必须保持 DAG，否则分层出不来）；
- 分层仍是 Sugiyama 式：`assignLayoutLayers`（最长路径）→ `orderLayersByBarycenter`（重心排序 + 长边按距离加权减交叉）→ `resolveLayerOverlaps` → `alignLayerToParents`（父/邻居加权对齐）；
- 含关系线的图自动放大间距（列间 ≥196px、行间 ≥92px、分量间 ≥208/160px），让直线少穿无关方块；
- `applyCanvasEdit` 里 Agent 批量建节点时，按 `parentTaskId|parentSuperId` **分组在各自 scope 内排版**（壳层内用壳层坐标，不再用世界坐标把子块丢到舞台外），排完 `fitAllOpenSuperShells()` 让壳层按内容撑大；
- 开发节点右键新增**「按关系线整理内部排版（分层 · 可撤销）」**：`tidyDevArchitecture()` 递归整理该块及其子壳层（最深层优先），排版后按内容收紧壳层。

### 端子文字一律写在节点「外侧」

端子圆心只隔 `PORT_STEP = 12px`（孔径 8px），所以任何写在端子上方 / 下方的文字都必然盖住相邻端子——旧实现正是这样：`.port-badge`（音乐 `提示词` / `歌词` / `控制`、视频槽位号、闸门 / 互斥序号、任务 `控制` / `成功` / `失败`）用 `top:-10px` 悬在端子上方，`输入` / `输出` 两个插排小标题塞在 16px 宽的插排里、压在第一个孔上。

现在按「所在一侧」出板：

- `.port.in > .port-badge` → `right:100%; margin-right:8px`（文字在节点左外），`.port.out > .port-badge` → `left:100%`（右外）；`top:50%` + `translateY(-50%)` 与端子同一水平线，超节点内侧端子（桥在左 / 汇在右，类名与所在侧相反）另有对应规则；
- `输入` / `输出` 这一对插排小标题（`.n-port-label.n-pl-in/.n-pl-out`）**已整体删除**：左右谁进谁出，端子上的参数名徽标本身就说清了，那两行字只会占掉板外空间并与最上面一行的徽标打架。`nodeElement()` 不再创建它，`canvas.css` / `theme-light.css` 里相应规则一并移除（回归口径见 `test/smoke-rel-layout.js`）；
- 展开壳层的子画布 `.super-stage` 有 `overflow:hidden`，所以内侧端子的徽标一律**朝内侧出字**（`app-canvas.js` 的 stage 端子与 `app.js` 的全屏端子浮层同一口径）；
- 徽标正文一律写**完整名称**（`setPortBadgeName()`，不再 `clipStr(name,8)`）；裁切只在 CSS 一层做：`.port-badge .pb-name` 平时 `max-width:34px` + `text-overflow:ellipsis`（与 44px 通道匹配，绝不硬裁半个字），**节点高亮（`.wf-node.sel` / `:hover`）时 `max-width:340px` 且把 `overflow-clip-margin` 放开到 400px** → 完整端子名称可见、不被节点板裁掉。数组端子的槽位点（`.fn-arr-slots`）留在徽标本体里，不参与这层裁切；
- `.wf-node` 从 `overflow:hidden` 改为 `overflow:clip; overflow-clip-margin:44px`：仍保留圆角裁剪、`.n-body` 也各有 `overflow:hidden`，只给板外徽标留一条 44px 通道（除端子徽标外，节点内没有任何元素会超出外框；高亮时按上一条临时放宽）；
- 文字落在画布背景上，故加描边保证可读；浅色主题在 `theme-light.css` 里把黑影换成白晕，颜色改用 `var(--cyan2)` / `var(--green)`（随主题变）。

## 8. 会话内「计划」：归属绑定与失效（`renderer/app-plan.js`）

复杂任务先出计划 → 弹窗确认 → 按清单逐项执行。计划是**会话的数据**，不是全局状态，
所以它的生死必须只由「它所属的那条会话 + 用户的手」决定。

**弹窗头部只有一个信息块**：标题行 = 执行位置（归属：`功能块「…」` / `智能节点「…」` / `会话「…」`），
内容 = 一句话目标；归属为空时退化为「目标」标题。弹窗内**不再显示**「会话被删除或归档即作废」这条提示
（它是内部规则，不是用户当轮要做的决定），也**不再单列「明确不做」栏**——
`excludes` 仍照旧解析、钳制、落盘，并保留在「计划」面板目标悬浮提示里，需要回看时在那里看。

三条硬规矩：

1. **一份计划只属于发起它的那条会话。**
   - `st.plan.sessId` 在 `planStartExecution()` 里钉成 `st.id`，跟计划一起落盘；
   - 运行时游标 `st._planExec` 带 `sessionId` 与 `runId`（这一次执行的身份证号）；
   - 每一轮任务消息都显式带 `{ sessionId, planRunId }`：`agentSessionSend()` 拿不到 owner 会话就**直接停**，
     绝不回退到「当前活动会话」（那正是「计划串台」的根因）；
   - 出口处一律先验归属再动手：`planExecContinue()`（`planCursorOwned` + `planOwnedHere`）、
     `planRunParallel()`（runId 变了就丢结果）、`planHydrateSession()`（载回时 sessId 不是自己 → 作废）、
     `renderAgentPlanPanel()`（显示前再兜一道）；
   - 会话分支（`forkAgentSession`）**刻意不复制** `src.plan`。
2. **自动续跑只认「计划执行器自己那一轮」。**
   会话收尾（`agentSessionSend` 的 `finally`）只有在 `planExecMsg` 为真、游标归属正确、
   且 `st._planExec.runId === opts.planRunId` 时才续发下一项。
   用户亲口发的任意一轮（新消息 / 追问 / 手动运行）开跑时先 `delete st._planExec` 并作废排队弹窗，
   所以**不会出现「开头突然接着跑上一份计划」**；那份清单仍在面板上，要不要继续由用户点「▶ 继续执行」决定。
3. **终止 / 清除 = 永久消失（`planDrop`）。**
   一次清干净：`st.plan`、`st._planExec`、挂起弹窗标记、发送队列里属于该计划的任务消息、
   「▶ 执行计划」标记，并立刻落盘。触发点：点 ■ 终止、面板「清除」、会话被删除或归档、
   以及在计划弹窗还挂着的时候用户改口（`planStalePendingOffers` + `_planDrops` 计数：
   已弹出的那一份即使之后被点「确认执行」也会被拒绝并提示已过期）。
   对照：**普通中断**（跑完 / 报错停下）不删计划，那一项退回「待执行」，可以手动续跑。

规划模式的「▶ 执行计划」按钮（`st._planDelivered`）也按同一口径收紧：不再跨重启复活——
载回时只有「会话最后一条仍是那条计划」才点亮，隔天回来它不该还亮着。

## 9. 兼容性

- **旧版应用**（无 dev 字段）：Skill 降级为普通 `super` + `note` 建图，流程仍可用，仅无元素类型配色、「开发 / 细化」按钮与对话框、关系线；
- **新版应用**：识别 `dev` / `devKind` 字段后自动获得完整体验；
- 不涉及任务执行引擎改动；开发 / 细化会话即标准智能会话（每次动作新建一个）。

## 10. 交付与后续

- 交付：应用源码改动（见实现清单）+ 内置技能 `mtnode-dev-architect`（`mtnode-agent-skills/mtnode/dev-architect/SKILL.md`）；
- 生效：改的是渲染层与网关源码，必须重新构建才看得到。当前正在使用的实例是
  `dist/win-unpacked/MTNodeAIO.exe`（`npm run compile` 的产物，renderer 全在 `app.asar` 里），
  所以流程是：**完全退出 MTNode（含托盘）→ `node E:\dev\tools\deploy-devnode-suggest.ps1`**
  （脚本会检查有没有残留进程、跑 `npm run compile`、再解包校验 `renderer/app-devnode.js` 与
  `index.html` 的引入顺序）→ 重开应用。技能目录 `mtnode-agent-skills/` 一并随包更新，
  网关侧 `dsh/gateway/*.mjs` 是 loose 文件，构建时直接覆盖到 `resources/dsh/gateway/`。
- 后续可选增强：架构 diff（两次扫描对比）、按 devStatus 给整块着色、一键导出架构 Markdown 到项目、块级待办与进度汇总视图。

## 11. 自测

```
node test/smoke-dev-suggest.js     # 309 项：「建议 / 开发 / 细化」行为契约（含 AGENTS.md 共识文件接线）
node test/smoke-dev-corefiles.js   # 核心文件列表 devFiles：归一化与 10 条上限 / 顶层块读写拒绝 / 「文件 N」按钮与展开面板 / 行点击 reveal / 自动兜底收集 / 契约与文档接线
node test/smoke-rel-layout.js      #  51 项：关系线几何 + 架构图排版 + 端子文字
node test/smoke-plan-dialog.js     # 274 项：计划弹窗结构（头部单块：归属=标题 · 目标=内容 · 无「明确不做」栏）+ 归属绑定 / 弹窗过期 / 终止即永久消失
node test/smoke-db.js              #  20 项：db-store（FTS 增量 / 查询 / calc / 日志）
node test/smoke-exec-detached.js
```

`smoke-db.js` 里的 `dbQuery` / `dbList` / `dbGet` 已按 `mtnode_db` 工具的需要改成返回 `{ sql, rows }` / `{ sql, record }`（断言必须能追溯到实际访问语句），测试用 `rowsOf()` 统一取行。

`smoke-rel-layout.js` 是关系线与架构图排版的回归测试：同样纯 Node，用一个大括号/字符串感知的切片器把 `renderer/app.js` + `renderer/app-nodes.js` 里的真实函数抠进 `vm` 沙箱跑（不是复刻一份算法），并用 `renderer/css/canvas.css` 与本地存档 `save/*.json` 里**真实的开发节点架构图**当样本。51 项断言覆盖：硬边/软边与成环降级、分层结果（无反向边、列间走廊够宽、无重叠方块）、锚点贴边与扇形分散、全部是单段直线、叠线与完全重线为 0、汇聚线锚点收敛（对照组「只按中心排序」= 1 处交叉 → 实现 = 0 处）、文字不互相压、点选高亮状态机（`sel` / `linked` / `dim` 与箭头配色、孤立块不淡化整图）、直角走线旧实现无残留、端子文字出板的 CSS 与 DOM 接线。真实存档样本以「一行 5 个的朴素网格」为基线（存档坐标可能被用户手排得更干净，不能当基线），断言的是**不叠线、不重线、不穿过无关方块、确实分层**；交叉对数只作为信息输出与「不超过线数」的兜底。

309 项断言，纯 Node（`vm` + 一个几十行的迷你 DOM）直接加载 `renderer/app-devnode.js`，
不需要起 Electron。桩掉的是 `dshRunTask` / `mtDialogForm` / `startDevSessionWithText` / 画布与节点查询，
因此能真正断言行为契约而不只是文案：

- 解析：JSON 优先（含代码块围栏、键名带空格）、编号列表兜底、行首优先级标记剥离、4 条上限、<2 条判失败；
- 上下文：目标块的上层链路 / 下层元素 / 兄弟块 / 完成度统计 / 会话摘要都会进任务书，`* ` 标出本块；
- 纪律：确认对话框之前绝不调用模型；不传 `node`（只读调研不回写画布）；系统提示逐项断言禁了 write/edit/子代理/改画布；
- 全流程：进行中文案与 `🔧` 工具日志 → 4 行多选（最高优先级预选）→ 补充说明 → 「开发」把勾选项写成编号任务、
  未勾选项进「本轮明确不做」，并调用与「开发」按钮共用的 `startDevSessionWithText`；
- 缓存：取消也留着；「查看上次建议」不重跑模型；「换一批」重跑；勾选状态复原；
- 键盘：数字键多选、Ctrl+Enter 开工、Esc 中断调研（`dshCancelActive`）且不写坏缓存；
- 异常：模型报错 / 不按契约返回 / 非开发节点误调 / 没有 devPath；
- 接线：`index.html` 引入顺序、三处「建议」入口、样式规则、工具描述与技能索引、英文词条零缺失；
- 折叠卡 body 精简：只含按钮组 + 上次建议摘要，断言 `app-canvas.js` 与 `canvas.css` 中项目根目录行 / 状态字样行 / 生效模型行（`n-dev-path` / `n-dev-status` / `n-dev-model-info`）零残留；
- 运行状态：`devNodeRunningState` 判定（自身 / 直系 / 孙级递归 / 兄弟隔离 / `super_io` 端子排除 / 绑定会话启停），以及 `nodeElement` 加 `dev-running` 类、头部「运行中」徽标与呼吸灯 CSS 的接线；
- 运行队列：`devRunningNodes` 取数（自身 / 后代 / 会话、`db` 与普通节点排除、显式 `wfNodes`），`collectRunQueue` 收录进「处理中」，`nodeKindCls` / `nodeKindLabel` 区分 `kind-dev` 行，`stopNode` 开发分支逐条停止（递归后代 + 绑定会话），`app-assist` 会话启停各刷一次队列，`components.css` `kind-dev` 行样式，新增词条英文齐全；
- 节点颜色：`devColor` 校验与小写化、元素类型默认色、自定义色优先、`hexToRgbTriplet`、HSV↔RGB/HEX 往返（黑 / 红 / 绿三个锚点）、头部按钮与色板弹层接线、`.dev-custom-color` 外框样式，另断言**执行节点 body 不再重复标题**；
- Agent 模型：`devAgentModelOf` 就近继承（未选 → 祖先、自选 → 覆盖、兄弟块各自算、非开发节点返回 `null`）、路由与模型互校（失效路由 / 不匹配路由都按模型反查纠正）、按钮三态（auto / 实线自选 / 虚线继承 + 生效模型名）、弹层分组与条数、点选写 `devModel` + `devProvider` 并记撤销与存盘、「跟随默认（不指定）」清除后退回继承、「建议」只读调研与确认框真的带上所选模型与路由、绑定会话 / 序列化 / 网关 schema / CSS / 中英文手册 / 技能与索引的接线。

跑法：仓库没有聚合的 `npm test`（package.json 里没这条 script），需要逐个 `node test/xxx.js`。
