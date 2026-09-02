# 自检报告：工作区新优先级两条链路对照（人工读码核对，不跑真机）

核对范围：`renderer/app.js`、`renderer/app-agent.js`、`renderer/app-assist.js`、`renderer/app-devnode.js`、`renderer/app-db.js`、`renderer/app-nodes.js`、`renderer/app-canvas.js`、`renderer/i18n.js`、`guides/manual/dev-nodes.md`。
**本任务未改动任何源码**，只产出本报告；画布功能块的 note 由父会话（绑定会话）用 `mtnode_canvas_edit` 落库，文本见 §5。

## 0. 结论速览

| 链路 | 判据（人工核对项） | 结论 |
| --- | --- | --- |
| ① 助手在项目画布建图 → 打印生效工作区 | 生效值解析含「画布项目根」档；运行用的值与界面显示的值同源；📂 打开的就是生效值 | **通过**，但有 2 个缺口（§4-A/B），不影响本判据成立 |
| ② 功能块「开发」绑定会话工作区仍为 devPath（不被新优先级改变） | 绑定会话 `st.workspace` = `devPathOf(node)`，且它落在解析链的**手填档**（优先级高于画布项目根）；运行与展示同一真源 | **通过**（2 条边界风险见 §4-C/D） |
| 两份 `dshWorkspaceOf` 副本是否逐字同步 | `app.js:3421-3433` 与 `app-agent.js:177-189` 逐字节比较 | **一致**（PowerShell `-ceq` = True；`app-agent.js` 后加载生效） |

## 1. 规则位置：「画布含 dev 节点即并入工作区」写在哪

- **单一真源（扫描规则）**：`renderer/app.js:21200-21283` → `devProjectRootOf()`
  只认 `kind==="super" && dev && !db` 的开发块（`app.js:21221`）；`devPath` 沿 `parentSuperId` 就近继承（`devPathOf`，`app.js:21185-21199`）；顶层块优先（`isTopDevBlock`，`app.js:21223-21231`），忽略空值与相对路径（`isAbsPath`）；多根时先归并**共同祖先目录**（`app.js:21251-21279`），归并不了才取文档序第一个并置 `S.devProjectRootAmbiguous = true`（`app.js:21281`）。歧义标记每次调用先重置（`app.js:21207`），所以 UI 必须**先调用再读标记**。
- **并入工作区优先级**：`renderer/app.js:3421-3433` `dshWorkspaceOf(node)`，与后加载生效的同名副本 `renderer/app-agent.js:177-189`（两份注释都写明「任何改动都要逐字同步」）。新优先级：
  **节点/会话手填 > 画布项目根（devPath） > 画布统一目录 `wf.workspace` > 应用默认数据目录**。
- **助手 / 智能会话侧复用同一真源**（不再各处自写兜底）：`renderer/app-assist.js:181-230` `canvasProjectRoot()`（优先直调 `devProjectRootOf()`，宿主未加载时退回本地最小扫描）、`app-assist.js:261-278` `assistWorkspaceInfo()/assistResolveWorkspace()`、`app-assist.js:286-305` `agentWorkspaceInfo()/agentRunWorkspace()/sessionWorkspaceShown()`。
- **消费点**：助手开轮锁定 `app-assist.js:785-786` → 传引擎 `app-assist.js:866`；会话运行 `app-assist.js:3947`、上文压缩 `app-assist.js:3325`；节点运行兜底 `app-db.js:1599-1608`（`dshRunTask` 内 `opts.workspace || dshWorkspaceOf(opts.node)`，目录不存在则校验后清空）；运行确认预览 `app-nodes.js:601-602`。
- **对外口径文档**：`guides/manual/dev-nodes.md:65-69/84`（与 `guides/manual/en/dev-nodes.md` 对应表）；Agent 规则文案 `app-assist.js:816` `devNodeRule`、`dsh/gateway/gateway.mjs` `PRESETS.standard`、`mtnode-agent-skills/mtnode/dev-architect/SKILL.md:174`。

## 2. 链路① 逐条判据（助手建图 → 打印生效工作区）

1. **解析**：`assistWorkspaceInfo()`（`app-assist.js:263-274`）= 手填（范围是「仅当前画布」时**故意忽略**，`app-assist.js:265`，输入框同步为只读）→ `canvasProjectRoot()`（即 `devProjectRootOf()`）→ `canvasWorkspaceDir()`（`wfWorkspace()`）→ `S.dshWorkspaceFallback`。⇒ 画布含 dev 块且顶层块有 `devPath` 时，项目根就是助手本轮目录。
2. **运行**：开轮一次性锁定 `S.assistRunWorkspace`（`app-assist.js:785-786`），整轮 `dshRunTask({workspace: S.assistRunWorkspace …})`（`app-assist.js:866`），引擎沙箱根按它建；中途切画布不改本轮值（`assistRunLocked()`，`app-assist.js:157-163`）。
3. **打印 / 显示与运行同源**（「打印生效工作区」的落点）：
   - `syncAssistWorkspaceChrome()`（`app-assist.js:318-349`）：输入框回填 `assistDisplayWorkspace()`（运行中 = 开轮锁定值，空闲 = 实时解析值），placeholder / title 均为新口径（「跟随当前画布：项目根优先，其次画布工作目录」/「留空 = 画布项目根 / 画布工作目录…」），并追加 `workspaceInfoNote()` 的**来源行**：`手填指定 / 画布项目根（开发节点 devPath）/ 画布工作目录 / 应用默认目录`；显示值 ≠ 实时值时改说「来源：本轮开轮时锁定」（`app-assist.js:324-329`）——宁可不说也不说错。
   - 会话侧芯片 `renderAgentComposer()`（`app-assist.js:1308-1327`）显示 `sessionWorkspaceShown(st)`（**不是** `st.workspace` 原值），tooltip 首行「生效工作目录：…」+ 来源说明；侧边栏分组按生效值归类（`app-assist.js:3109-3111`）；📂 打开的也是生效值（`app-assist.js:2881-2882`）。
   - 节点侧：智能任务运行确认摘要打印「工作目录：<dshWorkspaceOf(node)>」（`app-nodes.js:601-602`），已是含项目根档的生效值。
   ⇒ 判据成立：**看得见的那个目录，就是文件真正落的目录**。

## 3. 链路② 逐条判据（开发绑定会话仍钉在 devPath）

1. **建会话**：`createDevSessionForNode()`（`app.js:21409-21427`）里 `workspace: devPathOf(node) || dshWorkspaceOf(node)`（`app.js:21419`）——`devPath` 是第一手值，**新优先级只在 devPath 为空时**才作为兜底参与；子功能块靠 `devPathOf` 的祖先继承（`app.js:21190-21198`）同样拿到顶层块的项目根。⇒ 新优先级不覆盖、不改写 devPath。
2. **运行**：绑定会话每轮走 `agentRunWorkspace(st)`（`app-assist.js:3947`；压缩 `app-assist.js:3325`）→ `agentWorkspaceInfo(st)`（`app-assist.js:288-296`）把 `st.workspace` 当**手填档**，排在 `canvasProjectRoot()` 之前。⇒ 即使画布上有**多个**项目根、或助手正用另一根写文件，本模块绑定会话仍在自己的 devPath 里跑。判据成立。
3. **展示**：绑定会话的目录芯片 / 分组 / 📂 都用同一个 `agentRunWorkspace`，与运行零分叉（见 §2-3）。
4. **只读「建议 / 问询」**：不进绑定会话，直接按块取根 —— `app-devnode.js:1051`（建议）与 `app-devnode.js:1862`（问询）均为 `workspace: devPathOf(node) || ""`，空值时由 `dshRunTask` 退回 `dshWorkspaceOf(undefined)` = 画布项目根，与绑定会话同口径；作业日志同步打印「项目根：<devPath>」或「（未设置 · 用默认工作区）」（`app-devnode.js:1026-1030`、`app-devnode.js:1842`）。
5. **持久化不丢值**：`persistAgentSession()` 保留 `workspace: s.workspace || ""`（`app-assist.js:1118-1121`），重启后绑定会话仍带回本模块 devPath。

## 4. 核对中发现的 4 条不一致 / 风险（超出本任务范围，**未修改**，留给人工定夺）

- **A. 节点 body 的工作目录行仍是旧口径**（与手册表冲突）：`app-canvas.js:4041-4064`（`agent_task`）与 `app-canvas.js:5026-5058`（`proc_text` 智能模式）只认「`wf.workspace` 存在 → 只读回显 `wf.workspace`；否则回显手填值，placeholder 写「留空 = 应用数据目录」」，📂 也只开 `wfWs || 手填值`（`app-canvas.js:4063`、`app-canvas.js:5048`）。而实际运行经 `dshWorkspaceOf` 已把**画布项目根排在 `wf.workspace` 之前**：画布同时有统一工作目录和 dev 块时，那一栏显示画布目录、真实落盘却在项目根。手册里「运行确认预览显示的就是生效值」仍成立（`app-nodes.js:601`），坏的是节点那一栏。要补的话：两处改读 `dshWorkspaceOf(node)`，并把 `workspaceInfoNote()` 的来源行放进 tooltip。
- **B. 本轮新增的两条 i18n 键是孤儿**（聊天里没有开轮打印）：`i18n.js:2419`「项目根已并入工作区」、`i18n.js:2421`「画布上有多个项目根：本轮使用「{p}」，可在上方工作目录里指定其它项目根」——全仓检索无任何调用方。即：助手开轮**不会**在对话里告知生效工作区，`S.devProjectRootAmbiguous` 只出现在 tooltip 一行小字（`app-assist.js:246-251`）。若「建图 → 打印生效工作区」要按字面成立，需在 `assistSend` 开轮处（`app-assist.js:785` 附近）消费这两条键。
- **C. 首轮时序**：助手 / 会话的工作区是**开轮锁定**的（`app-assist.js:785-786`）。首轮现场把 `devPath` 写到新建顶层块**之后**，本轮引擎沙箱根仍是开轮时的旧目录 → 同一轮往项目根写 `AGENTS.md` 会被文件策略拒。`SKILL.md:174` 与 `devNodeRule` 的「建图首轮先把 devPath 写到顶层功能块，之后项目根内文件可直接读写」应理解为「**设好 devPath 的那一轮之后**」，否则文案被读成承诺首轮写入。
- **D. devPath 目录失效会静默解绑**：`wipeMatchingWorkspaces()`（`app.js:21955-21984`）清 `sess.workspace`（含开发绑定会话，`app.js:21977`），但**不清 `n.devPath`**；随后该会话退回画布项目根（同一失效路径）→ `dshRunTask` 校验目录不存在后置空 → 落 `S.dshWorkspaceFallback`（`app-db.js:1600-1606`，带 toast）。行为可用，但绑定会话从此不再钉在本模块根上，需用户重设。

## 5. 回写「本模块概述（note）」第二段（【实现】段）

### 5.1 精简版（实测 168 字，满足两段式 ≤200 字，建议直接贴）

```
【实现】真源 devProjectRootOf(app.js:21200)；并入 dshWorkspaceOf 优先级：手填>项目根>画布目录>默认（app.js:3421、app-agent.js:177 同步）。自检：助手开轮锁定=显示同源；开发绑定会话 workspace=devPathOf(21419) 未被改写。缺口见报告。
```

### 5.2 稍长版（实测 283 字，note 允许超限时用；含两处判据细节）

```
【实现】工作区真源 devProjectRootOf（app.js:21200）并入 dshWorkspaceOf 优先级：手填>项目根 devPath>画布目录>默认；app.js:3421 与 app-agent.js:177 两份逐字同步（已比对一致）。自检①：助手开轮锁定 assistRunWorkspace，显示与运行同源（app-assist:785/866/318）。自检②：开发绑定会话 st.workspace=devPathOf（app.js:21419、app-assist:288/3947），不被新优先级改写。遗留：节点目录行仍旧口径、开轮打印未接线。
```

### 5.3 完整版（留档正文，适合写进模块文档而不是 note）

- **改动点**：`devProjectRootOf()` 为新增单一真源（`app.js:21200-21283`），并把「画布项目根」插进 `dshWorkspaceOf()` 优先级（`app.js:3421-3433` + `app-agent.js:177-189` 同步副本）；助手与会话侧改由 `canvasProjectRoot()/assistWorkspaceInfo()/agentWorkspaceInfo()` 同源解析（`app-assist.js:181-305`），显示层（输入框、芯片、分组、📂、tooltip 来源行）全部改显生效值；手册 `guides/manual/{zh,en}/dev-nodes.md` 补工作区优先级表。
- **判据（不跑真机即可验）**：① 助手在项目画布开轮时，工作目录框的值 = 传给引擎的 `workspace`，tooltip 首行为「来源：画布项目根（开发节点 devPath）」；② 顶层块设 `devPath` 后点「开发」，新建绑定会话的目录 = 该 devPath，即使画布另有其它项目根也不串根。
- **结论**：两条链路均**通过**读码核对；缺口 A/B/C/D 见 §4（本次未修）。

## 6. 本任务做了什么 / 没做什么

- 做了：读码对照两条链路（判据逐条见 §2、§3）、逐字节校验两份 `dshWorkspaceOf` 副本一致、定位「画布含 dev 节点即并入工作区」规则的全部落点（§1）、产出本报告（含 §5 可直接贴用的 note 文本）。
- 没做（计划外）：未运行应用 / 真机冒烟、未跑测试与构建、未安装依赖、未修改任何源码或 i18n / 文档 / 技能文件、未直接改画布节点（子任务无画布权限，note 由父会话落库）。仓库中 `app.js / app-agent.js / app-assist.js / i18n.js / gateway.mjs / SKILL.md / dev-nodes.md` 的改动来自并行任务，非本任务产出。
- 落盘小记：同名报告在整份覆盖时报 `ReplaceFileW EIO (Win32 1175)`（策略性拒绝），故改以本文件名交付；如需统一命名，把本文件重命名为 `_report-workspace-priority-selfcheck.md` 即可。
