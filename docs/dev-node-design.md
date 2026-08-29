# 「开发」节点（Dev Node）设计文档

> 状态：v1 设计 · 2026-08
> 参考：[tt-a1i/archify](https://github.com/tt-a1i/archify)（Agent 扫描代码库产出可核验架构图的 Skill）。
> 与 archify 的本质区别：archify 一次性产出静态架构图；MTNode 的「开发」节点是**活的、可剥洋葱的项目架构画布**——先大颗粒、逐层细化，每个功能块的「开发 / 细化」都先弹对话框确认、再在新建会话中运行，最终可按画布反向搭建项目。

---

## 1. 概念与命名

| 术语 | 含义 |
|---|---|
| **开发节点（Dev Node）** | 项目中的一个功能块/模块。形态上是带 `dev: true` 标志的超级节点（`kind: "super"`），可嵌套子开发节点。 |
| **概述（note）** | 开发节点的 `note` 字段：一段话说明该模块在项目中的作用。折叠卡直接可见，`mtnode_canvas_get` 天然返回，供 Agent 快速定位。 |
| **关系线（rel）** | 元素之间的 UML 风格连线：**普通直线**走向、可双向/单向/无箭头、线上可带文字（点选节点时该节点的关系线高亮）（如「调用」「实现」）。**只表达关系，不承载数据、不参与执行**；开发节点架构图中优先使用它（数据流管线仍用普通连线）。 |
| **开发会话** | 每次点击「开发 / 细化」并在对话框确认后**新建**一个 Agent 会话来运行：标题「开发 · <节点标题>」/「细化 · <节点标题>」，工作区 = 项目根目录，首条消息为该模块的开发任务书。节点通过 `agentSessionId`（最近一次）+ `devSessionIds`（历史）关联，可用「会话 N」按钮回到最近一次。 |
| **剥洋葱** | 搭建策略：先建顶层大块（如 前端/后端/数据层），确认后再逐层向下细分子块；每次只剥一层，避免一次铺满全图。 |

命名说明：需求原文为「功能块」。最终采用「开发节点」——与功能入口「开发」按钮一致，且避免与超级节点既有概念混淆；节点徽章显示「开发」。

## 2. 为什么复用 `super + dev:true`（而不是新增独立 kind）

先例：**数据库超级节点**就是 `kind: "super"` + `db: true`（`renderer/app.js` 面板、`app-canvas.js:1715` 头部按钮区、`app-nodes.js` 序列化/patch、`dsh/gateway/canvas-plugin.mjs` 工具 schema 全链路已有成熟模板）。

复用 `super` 意味着零成本获得：

- 容器嵌套（`parentSuperId`）→ 洋葱式层级；
- 就地展开子画布（`superOpen`）、边缘 I/O 端子；
- `superConnect` 跨层自动桥接（`app-nodes.js:4870`）；
- 分组、删除保护、拖拽等全部既有交互。

`dev:true` 仅叠加：元素类型徽章与配色、「细化 / 开发」按钮（点击弹对话框，确认后在新建会话中运行）、`devPath`、`devStatus`、会话关联（`agentSessionId` + `devSessionIds`）、可连关系线。

## 3. 数据模型

在超级节点基础上新增字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `dev` | boolean | 标记为开发节点（与 `db` 互斥：`db` 优先视为数据库节点） |
| `devPath` | string | 项目根目录（绝对路径）。顶层块必填；子块缺省时继承最近祖先块的 `devPath` |
| `devStatus` | `pending` \| `wip` \| `done` | 开发状态：待开发 / 进行中 / 完成（默认 pending） |
| `note` | string（既有） | **概述**：该模块在项目中的作用，≤200 字，必填 |
| `agentSessionId` | string（既有） | 最近一次绑定的开发 / 细化会话 id |
| `devSessionIds` | string[] | 该功能块名下的历史会话 id（每次「开发 / 细化」新建一个，最新在前，上限 24） |
| `devKind` | `module` \| `file` \| `class` \| `interface` \| `enum` | 元素类型（外框配色：绿 / 蓝 / 橙 / 紫 / 粉） |

`mtnode_canvas_get` 序列化与 `mtnode_canvas_edit` create/update schema 均透出以上字段（`superTree` 也带 `dev` 标记，便于全局导航）。

## 4. 「建议」「开发」「细化」按钮：对话框确认 → 新会话运行

通用对话框：`mtDialogForm()`（`app.js`，复用 `#mtDialog` 深色对话框宿主）——信息区（键值行 / 概述块 / 子元素清单）+ 可选输入区 + 多按钮；`requireText` 时输入为空不关闭并内联提示；Esc 取消、Ctrl+Enter 提交。

- 渲染位置：节点头部（元素类型徽章 + 「细化」+ 「建议」+ 状态徽章「开发」）与折叠卡 body（项目路径 + 状态 + 「细化 / 建议 / 开发 / 会话 N」按钮 + 上次建议摘要）；右键菜单提供同动作。
- **「建议」`suggestDevNode(node)`**（`renderer/app-devnode.js`）—— 让用户不必自己想「下一步做什么」：
  1. **先确认**：`mtDialogForm` 展示现状（元素类型 / 开发状态 / 项目根 / 下层元素数 / 历史会话数 / 上次建议时间）并说明接下来的动作；可选填**本轮关注点**；未设 `devPath` 时给黄条提醒。按钮：「取消」／（有缓存时）「查看上次建议」／**「确认生成建议」**；
  2. **只读调研**：`dshRunTask(devSuggestPrompt(node), { workspace: devPath, runKey: "devsuggest:<节点id>", preset: "standard", effort: "high", systemPrompt: devSuggestSystemPrompt() })`。系统提示沿用规划模式的禁令口径（禁 write / edit / 有副作用命令 / 画布修改 / todo / goal / subagent，只允许 read / glob / grep / 只读命令 + calc 式核算），并且**不传 `node`**（避免画布作用域锁与节点回写）。对话框在同一宿主内切成进度态：实时滚动 `🔧 工具名 + 目标路径`、耗时与只读调用次数；「停止生成」= `dshCancelActive(runKey)`；
  3. **方案清单**：模型按契约只输出一个 JSON（`summary` ≤80 字、`basis` 3~5 条真实文件证据、`options` 恰好 4 条 `{title, desc, priority}`）。`devSuggestParse()` 容忍代码块围栏与前后杂文，兜底可解析「1. 【优先】标题 —— 说明」式列表并按优先级重排；少于 2 条判为失败 → 失败态给「再试一次」；
  4. **多选 + 补充 + 就地开发**：4 行复选框（数字键 1-4 快速勾选，默认勾选优先级最高的一条）＋「补充说明」输入框，底部按钮 **「取消 / 换一批 / 开发」**。点「开发」= `devSuggestBriefText()` 把「已勾选 N/M + `[优先级]` + 本轮明确不做（未选项）+ 用户补充 + 实施要求」拼成任务正文，交给与「开发」按钮**完全同一条路径**的 `startDevSessionWithText(node, brief)`（新建绑定会话 → `devStatus` 转 `wip` → 切会话视图运行）；
  5. **缓存**：结果写入节点 `node.devSuggest = { at, summary, basis, items, picked, supplement }`，随工作流 JSON 保存；再次点「建议」可直接「查看上次建议」（复原勾选、不重跑模型）或用「换一批」重新评估；折叠卡上显示上次建议的一句话摘要。
- `developDevNode` 与「建议 → 开发」共用的收尾函数：`startDevSessionWithText(node, text)`。

  - **「开发」`developDevNode(node)`**：
  1. 对话框上方显示**标题 + 现状**：元素类型、开发状态、项目根目录、下层元素清单（前 6 个）、**最近一次要求**（取自该块最近会话的最后一条用户消息）与模块概述；
  2. 用户在输入区填写**本次希望开发 / 迭代的内容**（必填）；
  3. 「开始开发」→ `createDevSessionForNode(node,"dev")` **新建会话**（`title = "开发 · " + 节点标题`，`workspace = devPath` 解析后的项目根），首条消息为 `_src:"dev-node"` 的开发任务书（标题 / 类型 / 概述 / 项目根 / 上层模块 / 现有子元素 / 完工要求）；
  4. 节点 `devStatus` 自动转 `wip`，`setView("agent")` 后由 `agentSessionSend()` 在**该新会话**里运行本次要求；「取消」直接返回，不留痕迹。（收尾与「建议」共用 `startDevSessionWithText()`）
- **「细化」`refineDevNode(node)`**：
  1. 对话框显示元素类型 / 项目根 / 现有子元素与概述，并**确认是否继续细化**；可选填写细化范围；
  2. 三个出口：「取消」／「无需细化」（仅提示跳过，不改动画布）／「确认细化」；
  3. **无法细化会当场提示**：`class` / `interface` / `enum` 已是最细粒度元素 → 弹窗只给「知道了」并说明可先改元素类型；缺 `devPath` → 提示无法依据真实代码判断；
  4. 确认后同样**新建会话**（标题「细化 · 模块名」）运行 `devRefinePrompt()`：内含 0~5 步契约——**先判断该不该细化（无需/无法就直接告知、不建节点）→ 真实代码分析 → 先出内容梗概清单 → 经用户确认才建子节点与关系线 → 保持类型配色**。
- 历史会话：`devSessionIds` 记录该块全部会话；「会话 N」按钮与右键「回到最近一次会话」→ `openBoundDevSession()`（不新建）。节点改名 → `syncDevSessionTitles()` 跟随其历史会话标题；删除节点 → 一并删除其名下会话（先确认）；删除会话 → 从 `agentSessionId` / `devSessionIds` 摘除。

## 5. 使用流程

### 模式 A：扫描已有项目 → 生成架构画布（Skill 驱动）

1. 用户在会话/全局助手中调用 `mtnode-dev-architect`，给出项目文件夹；
2. Agent 限额扫描（目录树、依赖清单 package.json 等、入口文件、配置；单文件读取设行数上限）；
3. 产出模块地图草案；**不确定项必须用 ask_user_question 询问**（如：某插件/示例目录/生成产物是否纳入架构）；
4. 建画布：顶层开发节点（devPath + 项目总概述）→ 一层子块 → 元素间关系线（rel + relLabel）→ 顶部放「项目总览」input_text 索引（标题 + 一句话概述清单）→ createMarks 分区；
5. 用户可继续「展开 XX 块」触发下一层剥洋葱；每次只剥一层（细化在按钮弹窗确认后于新会话中运行）。

### 模式 B：新项目先架构、确认后搭建（Skill 驱动）

1. 用户指定新项目文件夹；自己（或请助手协助）搭建开发节点架构；
2. 助手按画布内容审阅：覆盖完整性、依赖闭环、概述缺失 → 提出建议并迭代（模糊处问询）；
3. **仅当用户明确「确认」后**才动工：按依赖顺序（被依赖者优先）逐块实现；
4. 每块实现优先引导用户点击该块「开发」按钮：在对话框里填写本次需求，确认后在该块**新建的开发会话**中施工；完成后把 `devStatus` 更新为 done 并补充概述（关键文件/对外接口）；
5. 全部完成后做一次整体自检（构建/运行/测试），回报结果。

### 问答纪律（两种模式通用）

- 任何不确定的纳入/排除、技术选型、目录约定 → `ask_user_question`；
- 概述必须基于扫描事实，禁止臆造模块职责；
- 每次剥一层；大块未确认前不下钻。

## 6. 概述书写规范

- ≤200 字；一段话；说明「做什么 + 在项目中的位置 + 关键依赖」；
- 顶层块附技术栈与目录映射（如 `对应目录：src/renderer`）；
- done 状态的块补「关键文件 / 对外接口」一行，便于后续维护与 Agent 定位。

### 配套的执行节点（启动器）

`execute` 节点在创建菜单里**归入「开发节点」二级菜单**（模块 / 文件 / 类 / 接口 / 枚举 → 执行），因为它的用途就是给项目或某个功能块配一个一键启动器：

- 右键功能块 → 「在内部新建执行节点（启动器）」→ 直接在该块内部创建 `execute` 子节点（`parentSuperId` = 该块）并立刻弹出文件绑定对话框；
- 展开壳层内直接右键空白添加，或在顶层添加后拖入壳层，同样成为该块的子节点；
- 它仍是独立工具节点：无数据端子、不参与执行与批次，只承载「启动本地文件」这一动作，与架构节点之间**不连数据线**（要表达归属关系时放进块内即可）。

## 7. 关系线渲染与架构图排版

### 关系线为什么必须「整层一起规划」

早期实现是**一条线一次绘制**（`renderRelWire(w)`）：每条线只看自己两端，于是同一侧的多条线全部接在同一个角点上、同走廊的中段互相压线；更致命的是它和各壳层自己的连线重绘（`updateSuperInnerWires` 按 `swire-*` 白名单清理残留）抢同一个 `<svg>`，线芯刚画完就被当成残留删掉，只剩外圈和文字——**表现为「关系线不显示 / 没有箭头」**。

现在：

- `updateWires()` 走完所有普通连线之后，**最后**调用一次 `renderRelWiresPass(filter)`；
- 它用 `collectRelWireScopes()` 把本层可见的关系线**按所在壳层分组**，每组一次性跑 `relPlanScope()`：
  1. `relBorderAnchor()` 定两端出射边：把「中心 → 对端中心」的射线与方块边框求交，交点落在哪条边就从哪条边出（直线最自然）；
  2. 该侧只有一根线时直接用这个天然出射点；同一节点同一侧有多根线时改用 `relSpreadSide()` 按对端位置**扇形分散**到不同锚点（边不够长就对称撑开）；
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

## 8. 兼容性

- **旧版应用**（无 dev 字段）：Skill 降级为普通 `super` + `note` 建图，流程仍可用，仅无元素类型配色、「开发 / 细化」按钮与对话框、关系线；
- **新版应用**：识别 `dev` / `devKind` 字段后自动获得完整体验；
- 不涉及任务执行引擎改动；开发 / 细化会话即标准 Agent 会话（每次动作新建一个）。

## 9. 交付与后续

- 交付：应用源码改动（见实现清单）+ 内置技能 `mtnode-dev-architect`（`mtnode-agent-skills/mtnode/dev-architect/SKILL.md`）；
- 生效：改的是渲染层与网关源码，必须重新构建才看得到。当前正在使用的实例是
  `dist/win-unpacked/MTNodeAIO.exe`（`npm run compile` 的产物，renderer 全在 `app.asar` 里），
  所以流程是：**完全退出 MTNode（含托盘）→ `node E:\dev\tools\deploy-devnode-suggest.ps1`**
  （脚本会检查有没有残留进程、跑 `npm run compile`、再解包校验 `renderer/app-devnode.js` 与
  `index.html` 的引入顺序）→ 重开应用。技能目录 `mtnode-agent-skills/` 一并随包更新，
  网关侧 `dsh/gateway/*.mjs` 是 loose 文件，构建时直接覆盖到 `resources/dsh/gateway/`。
- 后续可选增强：架构 diff（两次扫描对比）、按 devStatus 给整块着色、一键导出架构 Markdown 到项目、块级待办与进度汇总视图。

## 10. 自测

```
node test/smoke-dev-suggest.js
node test/smoke-rel-layout.js
```

`smoke-rel-layout.js` 是关系线与架构图排版的回归测试：同样纯 Node，用一个大括号/字符串感知的切片器把 `renderer/app.js` + `renderer/app-nodes.js` 里的真实函数抠进 `vm` 沙箱跑（不是复刻一份算法），并用 `renderer/css/canvas.css` 与本地存档 `save/*.json` 里**真实的开发节点架构图**当样本。29 项断言覆盖：硬边/软边与成环降级、分层结果（无反向边、列间走廊 ≥192px、无重叠方块）、锚点贴边与扇形分散、车道错开、不穿方块内部、文字不互相压、渲染接线与样式、真实样本「排版前 → 排版后」叠线数。

142 项断言，纯 Node（`vm` + 一个几十行的迷你 DOM）直接加载 `renderer/app-devnode.js`，
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
- 接线：`index.html` 引入顺序、三处「建议」入口、样式规则、工具描述与技能索引、英文词条零缺失。

跑法：仓库没有聚合的 `npm test`（package.json 里没这条 script），需要逐个 `node test/xxx.js`。
