# 工具节点 / 函数节点 —— 统一数据模型契约（T1 渲染层定义 · 供 T2 引擎直接消费）

> 并行任务口径：T1 = 节点类型与数据模型 + 渲染 UI；T2 = 引擎/运行时执行；
> T5 = 双语文案统一。本文是两类节点的**唯一数据契约**，渲染层（app.js / app-canvas.js）
> 与引擎（app-nodes.js）都按它实现，避免各写一套。渲染层已按本契约落代码。
> 应用内手册：`guides/manual/tools-functions.md`（英文 `guides/manual/en/tools-functions.md`，目录见 `guides/manual/index.json`）。

## 0. 一句话

- **工具节点**：画布上「参数即端子」的 Agent 可调用工具定义。
  规范形态 = kind `super` 新变体 `tool:true`（沿用 `db:` / `dev:` 变体模式）；
  引擎运行时以普通 kind `"tool"` 分发（app-nodes.js 现有分发/可控制判定已按
  `kind === "tool"` 编写）。渲染层 `isToolNode(n)` 是唯一判定源，两种形态都认
  （`super && tool:true` 或 `kind === "tool"`），存储一律走 `toolConfig`。
- **函数节点**：新普通 kind `"function"`（非 super）。纯 JS 计算节点，
  执行 = 渲染层 `mtnodeJsExec.run`（js-exec.js · 异步 Promise）把代码交给主进程
  **独立线程**（根目录 `fn-runtime.js`）执行，引擎 `await` 结果写 `node.output`、
  异常写 `node.error`（+ `portOutputs.__error`）。执行契约见 §3。

## 1. 数据模型

### 1.1 工具节点

```
kind: "super", tool: true            // 规范（画布/API 变体形态）
// 或 kind: "tool"                    // 引擎运行时/兼容形态（渲染层同样支持）
toolConfig: {
  name:        string   // 工具名（唯一真源）；默认空
  description: string   // 给 Agent/人的用途说明（「描述自足」第 1 项）
  example:     string   // 一份完整的最小成功调用（JSON 文本，键 = 入参名）；缺省 ""
  limits:      string   // 限制与会失败的情形（路径规则 / 必须存在的目录 / 输入形式…）；缺省 ""
  atLeastOne:  string[][] // 参数组「至少给一个」：[[参数名, 参数名], …]；缺省 []（每组 ≥ 2 个名字）
  inputs:      Param[]  // 输入参数 → 输入数据端子
  outputs:     Param[]  // 输出参数 → 输出数据端子
}
output / batchOutputs / error / ranAt / running   // 运行期字段（与 proc 系一致）
```

变体互操作：`isToolNode(n)` = `(n.kind === "super" && n.tool && !n.db) || n.kind === "tool"`。
`toolConfig` 缺省归一见 `ensureFnToolNodeState()`（新字段一律补空值，**读老包不报错**）。

### 1.2 函数节点

```
kind: "function"          // 普通 kind（非 super）
fnName:      string       // 函数名（可空）
description: string       // 用途说明
jscode:      string       // JS 函数体（见 §3 执行契约）
inputs:      Param[]      // 输入参数 → 输入数据端子
outputs:     Param[]      // 输出参数 → 输出数据端子
fnTestInputs: string[]    // 「测试」台输入快照（按输入参数序号；仅测试用 · 不参与画布运行）
fnDevSessionIds: string[] // 「开发」绑定会话 id（新→旧 · 上限 24；口径见 §8.4）
output / batchOutputs / error / ranAt / running
```

### 1.3 参数条目 Param（两类节点共用同一份模型）

```
{ name: string, kind: "text" | "image", list?: boolean }
// 本轮扩展（「描述自足」新增两位，缺省即不出现）：
{ name: string, kind: "text" | "image", list?: boolean, description?: string, optional?: boolean }
// kind 缺省 "text"，list 缺省 false，description 缺省 ""（未写即不出现），optional 缺省 false
```

- 参数名即端子名；`name` 可空，渲染/归一时代之以「参数 N」。
- **`description` = 参数说明**（入出参都可写）：给 Agent 看的「这个参数该填什么」，会拼进
  给模型的参数 schema 与失败回执（见 §1.5「描述自足」）。函数节点的参数同样能写（它不进
  Agent 可调用清单，说明纯给人看）。
- **`optional` = 可选位**（只在输入侧有意义，`dir === "out"` 一律清掉）：给模型看的
  `required` 列表不含它。**未标注 = 必填** —— 与历史口径一致，老工具包升级后行为不变；
  真正「二选一」的语义用工具级 `atLeastOne` 表达（预检与描述都由它拼）。
- **输入参数与输出参数都带 `kind`**，`normFnToolEntry` 对两个方向同一口径；
  只认 `text`（字符串值）与 `image`（`{kind:"image", path}` 路径对象），其余值归一为 `text`。
  参数类型域只有这两类：音频 / 视频值不在其中，归一时**原样放行**（不把媒体压成文本）。
- **`list` = 列表（数组）端子**：该端子吃的是一组值，于是同一个输入端子可挂**多条数据线**
  （图生图想多接几张参考图就多点几条线，口径与 `video_gen` 的参考图槽一致），运行时
  该端子的值恒为**数组**（一条线也没挂 = `[]`）。口径钉死三条：
  - **只有函数节点的输入参数有这层语义**：`normFnToolEntry(e, i, dir)` 只在 `dir === "in"`
    时保留 `list`，输出侧（`dir === "out"`）一律清掉 —— 「参数即端子」在输出方向必须
    一端子一值，留着它会让输出端子被曲解成可展开的多值端子；工具节点（super 变体）的
    外侧输入仍是一号一值，所以「设置」跳窗**不给工具节点显示这个勾选**，其**已挂线**的数组
    端子也不参与多线落点（见 §2）。
  - 判定唯一真源两条，各管一头：**按端子**问 → `fnToolPortIsList(node, dir, idx)`
    （与 `fnToolPortKind` 同一数端子口径，控制端子 / 越界 / 非这两类节点 → `false`，
    输出方向恒 `false`）；**按参数条目**问 → `fnBrowseParamIsArray(p)`
    （`array / arr / list / batch / repeat` 任一为真，或 `kind` 含 `array|list` ——
    兼容旧画布把数组语义写进 kind 的条目）。连线校验、端子徽标、只读摘要、测试台
    全部复用这两条，不再各写一套。
  - 数组标记**只影响形状、不影响类型准入**：图像数组端子仍只收图像线（§2 的
    `fnToolInPortTypeError` 一字不改地生效），错类型照样点名「哪个端子是什么类型、去哪儿改」。
- `kind` 是**端子级类型的唯一真源**，读取入口 `fnToolPortKind(node, dir, idx)`
  （`dir = "in" / "out"`，`idx` = 按 §2 契约数出来的端子序号）。三处下游行为都按它判定，
  不再「整节点一刀切」：
  - **连线校验**：`wireActsAsImage / wireActsAsText / wireParamKind`（源端子侧）、
    `fnToolInPortTypeError`（目标参数端子侧）；
  - **保存选型**：`wireSourceMediaType` → `saveMediaKind` → `applySavePathExt`
    （从**图像输出端子**拖到保存节点 = 自动按图像保存，扩展名 `.png`）；
  - **着色**：图像端子 `.img`（app-canvas.js `nodeElement`）、连线色 `isImageWireFrom /
    isAudioWireFrom / isVideoWireFrom`。
- 控制端子（输入 0、输出末位）**无端子级类型声明** → `fnToolPortKind` 返回 `null`；
  调用方必须回落到「按节点 kind + 该端子实际值推断」的旧口径（`inferMediaFromSource`），
  普通节点行为逐字不变。
- 参数**增删 = 端子增删**：编辑器里增删一条即对应增删一个数据端子（§2 端子排布）；
  **改 kind = 改端子类型**、**改 list = 改端子是否收一组值**（「设置」跳窗改完都重画端子并清下游）。
  `description`（参数说明）与 `optional`（可选位）**不参与端子计算**，改它们不动端子、
  不清下游、不进「设置」签名 —— 只改给模型看的文案。

### 1.5「描述自足」——工具自己就能把调用方式说清（本轮新增契约）

**口径**：任何工具调用都必须**仅凭工具自己给出的信息**（描述子 + 给模型的 schema）就能调对，
不允许依赖「模型本来就知道这个工具」这种外部信息。判据六项，逐项可机检：

| # | 判据 | 数据字段 | 消费方 |
|---|---|---|---|
| 1 | 用途 | `toolConfig.description` | 工具描述 / 失败回执 |
| 2 | 每个**入参**的含义 | `inputs[i].description` | 参数 schema / 回执 |
| 3 | 每个**出参**的含义 | `outputs[i].description` | 工具描述「返回：」段 |
| 4 | 哪些可选 / 至少给一个 | `inputs[i].optional`、`toolConfig.atLeastOne` | schema `required`、「至少给一个」段、执行前预检 |
| 5 | 一个最小调用示例 | `toolConfig.example`（JSON 文本，键 = 入参名） | 工具描述 / 失败回执 / 测试台一键填入 |
| 6 | 会失败的情形与限制 | `toolConfig.limits` | 工具描述 / 失败回执 |

- **谁检查**：随包内置条目（`renderer/preset-tools.json`，kind `tool`）不达标即
  `test/smoke-tools.js` [8] 硬失败；用户自建工具**只提示、不阻断** —— 画布工具节点卡片
  与「设置」窗里由 `toolSelfSuffMissing(node)` 列出缺哪几项（判定真源在 `renderer/app.js`）。
- **缺省兼容**：老工具包没有这些字段 → 一律按空值读，不报错、不迁移；**未写 `optional` = 必填**。
- **`{{outDir}}` 占位**：作者可在描述 / 示例 / 参数说明里写 `{{outDir}}`，宿主拼描述子时展开成
  **本机真实可写的用户输出目录**（数据目录下 `exports/`，主进程 `tools:env` 提供并确保存在）——
  模型无外部信息时最缺的就是「我能写到哪」；取不到该目录时退回一句说明，绝不编造路径。
  注入值是**本机固定**的，不放画布工作目录等易变值，避免网关运行时指纹（`tlHash`）抖动。
- **旧副本刷新**：画布上的工具节点是插入时的深拷贝，Agent 调用时**画布副本优先**于库里那一份；
  打开画布（`loadWorkflow`）时由 `refreshBuiltinToolCopies(wf)` 把来自内置条目
  （`toolLibId = builtin:*`）的副本按内置最新刷一遍**文案类字段**（1~6 项 + 参数说明 / 可选位），
  **参数个数与顺序永不动**（参数即端子，改结构会让已连的线错位）；参数按名字对齐，对不上的不碰。

## 2. 端子排布（渲染层已实现，引擎连线/补跑按此判定）

- **输入端子**：`index 0` = 控制入（固定，样式 .ctrl），`index 1..N` = 各输入参数
  （参数 i 对应端子 i+1）。总输入数 = `inputs.length + 1`（`inputCount`）。
- **输出端子**：`index 0..M-1` = 各输出参数（数据），`index M` = 控制出（固定，样式 .ctrl）。
  总输出数 = `outputs.length + 1`（`outputCount`）。
- 端子归属固定（两类都进 `hasFixedInPorts`）：断开连线不重排其它端子、不自动新增端子。
  **唯一的弹性在数组端子**：函数节点上标了 `list` 的那个输入端子可以挂**多条数据线**
  （号不变、不新增端子），取数时汇成数组（§3.1）；其余端子仍是一号一值。
- **端子类型**：数据端子的类型 = 该参数的 `kind`（唯一读取入口 `fnToolPortKind`，
  条目缺 `kind` 按 `text`，与旧画布口径一致）；控制端子（输入 0 / 输出末位）无类型声明。
  类型在渲染层的落点：图像端子单独着色 `.img`、端子 tooltip 标「（图像）/（文本）」、
  壳层内侧桥接 / 汇流端子同一口径（`superInnerPortInfo`）、「设置」跳窗每行左侧类型点。
  数组端子另渲染成**槽位组**（渐进槽位端子组）：徽标 = 参数名 + 每个已连线一个亮槽点
  （`参考图[1] [2] …`）+ 末尾一个空槽（可再接新线）；计数真源 `fnToolInPortWireCount`
  （壳层只数外侧入线、排除关系线与控制源线），按槽位取 / 断某条线走 `fnToolInPortWireAt` /
  `fnToolInPortWireRemoveAt`（槽序 = 挂线顺序，右键某个槽只断开那一条）。tooltip 追加
  「数组端子：JS 里拿到数组」。
- **数据线落点按类型匹配**（`fnToolInPortIndex`）：未指定端子序号时（拖到节点身上 /
  跨级连接 / agent connect）用 `fnToolFreePortForMedia` **两遍**挑端子——第一遍挑
  「类型匹配且空闲」的普通端子（先让一号一值的普通端子归位），第一遍挑不到再落到
  「类型匹配」的**数组端子**（数组端子已挂线也算可用；工具节点的外侧输入仍是一号一值，
  其**已挂线**的数组端子不参与第二遍）；两遍都挑不到才退回任意空闲端子。类型不符由
  `fnToolInPortTypeError` 点名「哪个端子是什么类型、去哪儿改」，不静默塞进错的端子。
  音视频线在参数端子眼里算 `text`（`wireParamKind`：文件路径口径）。
- **连线占用校验**（`connectError`）：函数节点走**独立分支**，绝不落到文末那条
  「按 `allWiresTo().length` 顺延」的通用判定（那条对固定端子节点本就失真：内侧汇流、
  数组端子同号多条线都会算错）。分支内：控制线直接放行（端口 0 不占参数端子）；
  数据线按上面两遍口径定端子，`ti == null` → 「没有空闲的输入参数端子」，`ti === 0` →
  「端口 0 是控制输入端子（不接受数据连线）」，越界 → 「无效的输入端子」，
  **已占用且非数组端子** → 「该输入端子已被占用」，数组端子已挂线 → 放行；
  最后统一过 `fnToolInPortTypeError` 再 `return null`。
- **端子值 ↔ 声明类型归一**（唯一真源 `normPortValueByKind`，包装口 `normFnToolPortValue`）：
  声明 `image` 拿到路径文本 → 补成 `{kind:"image",path,text}`（连线取值查图像扩展名，
  注入点 `opts.loose = true` 按定义直收）；声明 `text` 拿到图像 → 取路径作文本，
  并 `notePortKindFix` 记一笔（transient `_portKindFix`，节点摘要 ⚠ 显示）；
  空值 / 无声明 / 音视频值原样返回。**归一只换形状，不吞数据。**
- **下游自动选型**：保存节点不看源节点 kind，看「真正接出来的那个端子」的声明类型
  （`wireSourceMediaType`）→ 图像端子 ⇒ 自动 `.png` 图像保存，文本端子 ⇒ `.yaml` 文本保存；
  已按图像定型却没有图像来源时给出去哪儿改的错误，不把扩展名悄悄改回 `.yaml`。
- 控制线判定（`wireFromIsControl`）：函数/工具节点输出端子 `fromIndex >= outputs.length`
  一律视为控制线（金线）；`isControlKind` 源连入其 0 号输入端子即控制入。
- 端子 tooltip/徽标 = 参数名（长名裁 8 字符）；0 号输入与末位输出显示「控制」；
  **函数节点的数组入参端子**把挂线条数渲染成槽位组（见 §2 数组端子徽标说明）；
  只读摘要 / 脚手架注释仍用 `×N` 文案（展示层措辞，非端子模型）。
- 引擎接线约束（connectError 的图像→参数端子放行、控制口占用等）属 T2 范围，
  按本排布规则实现即可；渲染层新增判定都用同一批谓词（§5），不会另起炉灶。

## 3. 函数节点执行契约（异步 · 主进程独立线程 · 进程随运行回收）

- 入参对象：`input = { <输入参数名>: value, $<端子序号>: value, values: [..], items: [..] }`
  （文本参数为字符串；图像参数为 `{kind:"image", path}` 路径对象 —— 见 js-exec.js 头注释；
  **标了 `list` 的数组入参端子为值数组**，见下条）。
- **按「端子」聚合，不按「连线」**（`functionInputObject`，app-nodes.js）：参数 i ↔
  外侧输入端子 `i+1`（端子 0 = 控制入），所以 `input.$1` 恒等于参数端子 1 的值，
  **与连线挂载顺序无关**；键名取**本节点参数名**（不是来源端子标题）。
  - **数组端子（`list: true`）**：同一端子上的多条数据线**按连线顺序**逐条取数、逐元素按
    该端子声明的 kind 归一 → `input[参数名]` / `input.$端子号` / `values[i]` = **值数组**；
    一条线也没挂时是**空数组 `[]`**。形状恒定（哪怕只连了一条线也是数组），函数体可以
    无条件 `.map` / `.length`，不必再 `Array.isArray` 兜形 —— 图生图想多来几张参考图，
    往同一个端子多连几条线即可，不用加参数、也不用改代码里的取参方式。
  - **普通端子**：一号一值（同一号多挂的旧脏线只取最先挂上的那条，其余忽略），
    没挂线 = `null`。
- **数组端子的注入形状同样恒定**（`_agentCallArgs` → 数组端子）：给数组 → 逐元素 loose
  归一；给单个值 → 按**一元素数组**收；缺项 / `null` → `[]`。给普通参数仍是单值（缺项 = `null`）。
  函数开发任务书（`fnDevContractText`）与「测试」台都按这个口径写文案：数组端子在参数表里
  标 `,×N`，测试台对该参数渲染**可 ＋/－ 的多行输入**（一行一条 · 空行不注入 · 全空 = `[]`），
  旧存档里该位是字符串时按行拆开（`fnTestRowsOfStore`），取消数组勾选后并回一格（`fnTestSingleOfStore`）。

- **执行 = 异步提交**：`await mtnodeJsExec.run(node.jscode, input, opts)` → Promise。
  渲染层（js-exec.js）**不再执行用户代码**。旧实现 `new Function` 在渲染主线程同步跑，
  代码里任何等待 / 循环都不归还事件循环，整窗被钉住（画不刷、点不动、「运行中」也刷不出来）
  —— 这正是「函数节点一跑 MTNode 就锁死」的根因。现在 `run()` 把
  `{runId, code, input, timeoutMs}` 经 preload（`window.api.fnRun`）交给主进程，
  主进程在 **worker_threads 独立线程**里跑用户 JS（根目录 `fn-runtime.js` worker 半），
  结果 / 异常 / 超时都以 Promise 回帧 —— 渲染层全程只 `await`，永不阻塞，也能随时硬停。
- **一次运行 = 一个 runId + 一个 worker 线程**。函数体要落地的外部程序统一由隐藏进程宿主
  （根目录 `main-proc-host.js`）按 runId 记账：一律 `windowsHide:true + detached:false +
  管道 stdio`（绝不弹控制台窗口、也绝不共享 MTNode 的 console）。运行结束 / 被停止 / 超时
  （默认 10 分钟，1s–2h 可调）→ 主进程**先 terminate 线程、再按 runId 整棵回收进程树**
  （win32 `taskkill /PID /T /F`，其它平台进程组 SIGKILL）——函数节点只要不在运行态，
  它绑定的线程与进程就不存在；主窗销毁与应用退出另有 `killAll()` 兜底，不允许有脱离
  运行的残留进程。
- 结果形状：`{ ok, value, error, runId, killedProcs, killedPids, durationMs, cancelled?, timedOut? }`
  （`killedProcs` 让界面能报「已停止并回收 N 个进程」）。异常 / 超时 / 被停止都在主进程侧
  捕获，渲染层只拿到已完成的 Promise（不外抛）；`res.ok === false` 时引擎仍按现契约写
  `node.error` + `portOutputs.__error`（被停止统一写「已手动停止」，不当代码错误刷屏）。
- **代码兼容与 `mtnode` 桥**：函数体按 async 编译（可直接 `await mtnode.exec(...)`）；
  函数体 / 箭头 / 具名函数旧口径保留（返回值是函数时自动以 input 再调一次）。线程内注入：
  `exec / spawn / wait / kill / killRun`（隐藏启动 · 绑本次 runId · 运行一结束即整棵回收）、
  `sleep / now / log / progress`（log / progress 走事件帧回界面，不弹窗）、本地
  `fileExists / readText / writeText / join / abs / cwd / platform`。
  `process.exit / abort / kill / die / uncaughtExceptionMonitor` 等能带走 MTNode 本体或
  别的线程的入口在函数线程里被拦成抛错（提示改用 mtnode.exec / mtnode.spawn）。
- **函数体不在渲染进程**：没有 `window / document / window.api.*`；旧
  `window.api.shellOpenPathDetached` 起程序的写法运行时报 `window is not defined`，
  报错文案自动点名迁移（改用 mtnode.exec / mtnode.spawn，隐藏启动、随运行回收；指南给示例）。
  入参 / 返回值必须**可结构化克隆**（函数 / DOM 节点 / Socket 等活对象给明确报错，不跨线程）。
- **主动停止**：`mtnodeJsExec.cancel(runId)`（`window.api.fnCancel`）→ 主进程 terminate +
  killRun；停止节点 / 全部终止 / 删除节点 / 切画布 / 工具节点内部图作废都走这条回收链
  （渲染层停止句柄与补刀标记见 app-nodes.js `FN_CANCEL_HANDLES` / `FN_CANCEL_PENDING` /
  `fnCancelRunsOf`，消费点在 app.js `stopNode` / `stopAllRuns` / `deleteNodes`）。
- **引擎侧**（app-nodes.js `runFunctionNode`）：先进**计算执行并发闸**
  （`COMPUTE_EXEC_CONCURRENCY = 4`，仿 runMediaGenSerial 的「可作废」队列）：槽满排队期间
  登记「等待中」（左下角运行队列看得见、可逐条停 / 全部终止），出队前被终止则整次作废、
  绝不起线程；工具节点内部图 / Agent func call 的嵌套运行免排队（祖先已持槽即放行，
  防「N 个工具各占 1 槽 + 内部函数等槽」互相锁死）；`running=true` 后先让出一帧
  （`computeExecYieldPaint`：rAF + 80ms 兜底）刷出「运行中」再进执行体。
  结果仍走 `functionPortsFromReturn` 多输出分发（每个端子值再按端子声明 kind 归一，§2 不变）。
- **「测试」台**（app-nodes.js `testFunctionNode`）：同一条异步执行路径、同一份
  `functionPortsFromReturn` 映射，只读不写节点字段（不写 `node.output` / `portOutputs`、
  不级联、不进撤销历史），试跑期间界面同样不卡。
- **多输出分发**（`functionPortsFromReturn`，app-nodes.js · 纯函数，不写节点字段）：
  `return` 为普通对象且键命中输出参数名时，按键名写 `portOutputs.$<输出端子序号>`
  （参数 i → 端子 i），只写命中的端子；每个端子值都按**该端子声明的 kind** 单独归一
  （图像端子拿到路径 → 补成图像值，文本端子拿到图像 → 取路径作文本），返回
  `fixes = [{index,name,fix}]` 供调用方决定是否提示；标量 / 字符串 / 数组 / 一个键都没命中
  → 兼容旧口径单输出，只写 `$0`；返回值本身已是归一化媒体值（`{kind非text, path}`）时也走
  单输出。`node.output` = `$0`（首个输出端子），下游取数（app.js `valueForInput` 的
  `kind === "function"` 分支）按端子读 `portOutputs.$<idx>`，该端子不存在时回落 `node.output`。
- **入参注入优先级**：`node._agentCallArgs` 存在时（数组，索引 0 = 控制入、参数 i 在 i+1，
  与工具节点 func call 同一契约）完全取代画布连线取数 —— `functionInputObject` 优先读它。
  函数节点头部「测试」按钮（app-tools.js `openFnTestDialog`）就是走这条只读注入点跑
  `testFunctionNode`：不写 `node.output` / `portOutputs`、不级联下游、不进撤销历史；
  测试输入存 `node.fnTestInputs`（按输入参数序号的字符串数组，参与落盘 · 仅测试用）。
- 输出归一：`mtnodeJsExec.toOutput(value)` → `{kind:"text"|"image"|"audio"|"video"|"path",
  text?, path?}` **纯函数不变**；随后仍按输出端子声明的 kind 再归一一次
  （`normPortValueByKind`，§2）——端子类型判定、保存选型、连线校验全部不受执行方式改造影响。
- **工具节点执行契约由 T2 定义**（runToolNode：按其 toolConfig 语义运行内部图/桥接，
  引擎在 app-nodes.js `playNode` 已有 `kind === "tool"` 分发位；`runToolNode` 与函数节点
  共用 `runComputeExecNode` 生命周期与并发闸）。渲染层只负责数据面。

## 4. 标题默认规则（已实现）

- 新建工具/函数节点标题 = `NODE_DEFAULTS` 的默认标题（「工具」/「函数」，重复自动加序号）。
- 工具名（`toolConfig.name`）在「设置」里修改时，只要标题仍等于旧名（或尚未命名时的
  默认「工具[N]」），标题自动同步成新工具名；一旦标题被手动改过，name 独立不再跟随
  （`applyToolConfigName`）。函数名不自动改标题。

## 5. 渲染层已落地的接线点（T2 可直接复用同一批全局函数）

| 入口 | 位置 | 说明 |
| --- | --- | --- |
| `isToolNode / isFunctionNode / isFnToolNode` | app.js | 单一真源判定（两种工具形态都认） |
| `fnToolParamList(node, dir)` | app.js | 读工具/函数参数的统一视图（dir: "in"/"out"） |
| `normFnToolEntry / ensureFnToolNodeState` | app.js | 条目/结构归一（幂等；加载与渲染兜底） |
| `applyToolConfigName` | app.js | 工具名 ↔ 标题联动 |
| `inputCount / outputCount` | app.js | §2 端子数（参数+1） |
| `hasFixedInPorts / wireFromIsControl` | app.js | 固定端子 + 末位控制出判定 |
| `fnToolPortKind(node, dir, idx)` | app.js | **端子数据类型唯一真源**（数据端子 → `text`/`image`；控制端子 / 越界 / 非这两类节点 → `null` = 无声明，调用方回落旧口径） |
| `fnToolPortIsList(node, dir, idx)` | app.js | **端子是否列表端子**的唯一真源（与 `fnToolPortKind` 同一数端子口径：输入 0 = 控制入 → `false`、`1..N` 查参数 `list`；输出方向恒 `false` = 双保险挡掉旧数据残留的 `list`） |
| `fnBrowseParamIsArray(p)` | app-canvas.js | **按参数条目**问数组语义的真源（`array / arr / list / batch / repeat` 任一为真，或 `kind` 含 `array\|list`）：连线放行、端子徽标 `×N`、只读入参摘要、脚手架注释、「测试」台多行输入五处共用这一份判定 |
| `fnToolInPortIsArray(host, idx)` | app-nodes.js | 引擎侧按端子号问数组语义（内部走 `fnBrowseParamIsArray`），供 `fnToolFreePortForMedia` 两遍落点、`connectError` 多线放行、`functionInputObject` 聚合取数使用 |
| `fnToolInPortWireCount(node, idx)` | app-canvas.js | 某输入端子当前挂了几条**数据线**（数组端子槽位组的计数真源；壳层只数外侧入线，排除关系线与控制源线） |
| `fnToolInPortWireAt(node, idx, k)` | app-canvas.js | 数组端子第 k 条数据线（k 从 0 起 · 槽序 = 挂线顺序，与 `fnToolInPortWireCount` 同一口径）：槽位组每个亮槽 = 一条线，悬停 / 右键可精确定位这条 |
| `fnToolInPortWireRemoveAt(node, idx, k)` | app-canvas.js | 只断开数组端子第 k 条数据线（槽位组右键断开单槽用；其余线原样保留） |
| `fnToolMoveParam(node, dir, from, to)` | app.js | 参数重排：把输入 / 输出参数 from 移到 to（▲▼ / 拖动 insert 共用），返回 perm（oldIdx → newIdx）；S.wf 存在时顺带重映射该节点数据线端子号 |
| `fnToolRemapParamWires(node, dir, n, perm)` | app.js | 按 perm 重映射参数即端子的数据线：输入线（外侧入 + 工具壳内侧桥接）toIndex、输出线（外侧出 + 内侧汇流）fromIndex 随参数移位；控制端子、关系线、无关线不动 |
| `normPortValueByKind(value, kind, opts)` / `normFnToolPortValue(node, dir, idx, value, opts)` | app.js | 端子值 ↔ 声明类型归一（`{value, fix}`；`opts.loose` = 注入点不查扩展名；无声明原样返回） |
| `notePortKindFix` + transient `_portKindFix` | app.js / app-nodes.js / app-canvas.js | 图像值降级成路径文本时记一笔，节点摘要 `fnToolOutSummaryEl` 显示 ⚠（不落盘） |
| `wireSourceMediaType(node, fromIndex)` | app.js | 某输出端子流向下游的媒体类型（端子声明优先 → 其次 `inferMediaFromSource`）：保存选型 / 连线校验 / 连线着色 / 拖线建节点候选的共同真源 |
| `inferMediaFromSource(from, fromIndex)` | app.js | 无端子声明那一层的兜底推断（节点 kind + 该端子实际值；工具 / 函数按实际端子取值，其余只看 0 号端子） |
| `saveMediaKind / applySavePathExt` | app.js | 保存节点媒体选型（逐来源走 `wireSourceMediaType`）与扩展名落地：图像端子 → `.png` |
| `wireActsAsImage / wireActsAsText / wireParamKind` | app-nodes.js | 连线校验用的端子级媒体判定（工具 / 函数按端子，其余节点仍按 kind）；`wireParamKind` = 参数端子眼里的线类型（音视频路径算 text） |
| `fnToolFreePortForMedia(host, want)` | app-nodes.js | 按线类型**两遍**挑输入参数端子：先「类型匹配且空闲」的普通端子，再「类型匹配」的数组端子（函数节点上已挂线也算可用）；都挑不到返回 null（不静默占错端子） |
| `fnToolInPortIndex(host, from, fi, toIndex, fromCtrl)` | app-nodes.js | 一条数据线实际落到哪个输入端子（校验与落点的唯一真源） |
| `fnToolInPortTypeError(host, idx, from, fi)` | app-nodes.js | 输入参数端子的类型准入校验（返回 null = 放行；错误文案点名参数与去处） |
| `fnToolInPortIsControl / fnToolOutPortIsControl` | app.js | 端子契约里的控制性判定（输入 0 / 输出末位） |
| `fnToolInPortOccupied / fnToolOutPortOccupied / fnToolFreePortIndex` | app.js | 外侧输入 / 内侧汇流的端子占用与空闲端子分配（wantCtrl 区分控制与数据） |
| `superInnerPortInfo(host, dir, i)` | app.js | 壳层内侧桥接 / 汇流端子的徽标与类型提示（工具显示参数名 + 文本/图像，普通超级节点仍「端子 N」） |
| `isImageWireFrom / isAudioWireFrom / isVideoWireFrom` | app.js | 连线着色（工具 / 函数节点按真正接出来的那个端子判定） |
| `migrateToolNodeToSuperForm(n)` | app.js | 旧 `kind:"tool"` 一次性原地转 `super + tool:true` 变体（id / 标题 / 坐标 / toolConfig / 父子与连线全不动，幂等） |
| `valueForSuperOutput`（`normFnToolPortValue(..., "out", ...)`） | app.js | 工具壳层外侧输出端子的取数出口：按该端子声明类型归一后再给下游（普通超级节点无声明 → 原样） |
| `NODE_DEFAULTS.super.tool/toolConfig` 与 `NODE_DEFAULTS.function`、`NODE_DEFAULTS.tool` | app.js | 新建默认值（makeNode/addNode 深拷贝） |
| 右键「新建节点」菜单 | app.js `canvasCreateMenuGroups` | 「工具」一级菜单（二级：工具 / 函数）＝这两类节点的**创建入口**；开发 / 数据库壳层内不列 |
| 侧栏分类/标签、用途提示 | app.js `SIDE_CATS/KIND_TAGS/nodeKindPurposeKey` | 「工具节点」类 |
| 旧画布归一 | app.js `migrateWf` | 对每个节点跑 `ensureFnToolNodeState` |
| 图标 | app.js `KIND_ICON_SVG`（function/tool） | 标题栏/菜单/侧栏共用 |
| 节点体渲染 | app-canvas.js `buildFnToolBodyMain` | 状态行 + 工具摘要/JS 编辑器 + 输出摘要 |
| 「设置」跳窗里的参数面板 | app-canvas.js `buildFnToolSettings`（DOM 不变）＋ `NODE_SETTINGS_FORMS` 的 `function` / `tool` 登记（挂载点） | 名称/描述/增删入参出参（参数=端子）+ 每条参数的类型下拉（文本 / 图像，入参与出参同一口径）与行左类型点；改类型 = 重画端子 + 清下游。**面板不再进 body / 展开态工具壳，只在跳窗里出现** |
| 头部按钮 | app-canvas.js `nodeElement` | 徽标 + 「设置」（`nodeSettingsGearButton`，点开跳窗）+ 「测试」（仅函数节点）+ ▶/停止 |
| 测试台对话框 | app-tools.js `openFnTestDialog` | 独立于「设置」：JS 大块 + 每输入参数一字段（text 多行 / image 路径 + `fileOpenDialog`）+ 逐输出端子展示与错误；输入存 `node.fnTestInputs`；只读跑 `testFunctionNode` |
| 端子渲染 | app-canvas.js `nodeElement` | 控制口 .ctrl + 图像端子 .img + 参数徽标/tooltip（带「（图像）/（文本）」） |
| 右键节点菜单 | app-canvas.js `nodeElement` | 「设置（参数/名称/描述）」→ `openNodeSettingsDialog(node)` |

### 5.1 「设置」统一跳窗（所有节点共用一套）

设置**不再嵌在节点 body 里**（卡片宽度塞不下一排参数行，改一次要来回滚）：头部一颗 **⚙ 设置**
（`nodeSettingsGearButton`，与 ▶/✕ 同一排，浏览态照样可点）→ `openNodeSettingsDialog(node)`
开 `#overlay` 宽窗，body 只留一行只读摘要（`appendNodeSettingsSummary`）。

- 登记表 `NODE_SETTINGS_FORMS`（键的判定 = `nodeSettingsFormKey`：`super+tool` → `tool`、
  `save_text/save_image` → `save`、`super`（开发 / 数据库 / 工具壳）不接管）。一条 `def` =
  `summary(node)` / `signature(node)` / `build(ctx)` / `gearTitle` / `headerEntry`。
- 控件一律走 `makeNodeSettingsCtx`：`section / hint / field / sub / append / commit`，
  即时写回 `node` 字段并 `scheduleSave()`；只有会改端子或摘要形状的才 `renderCanvas()`。
- `signature(node)` 变了才重建表单（`syncNodeSettingsDialogShape`，挂在 `renderCanvas` 的
  重入闸之后）——用户正在敲的框绝不被重绘打断。
- 运行期回填走共用通道 `syncNodeSettingsValue(node, base, text, ctlText)`：body 摘要里那个
  `#<base>-<nodeId>` 只读文本与窗里同号控件一起刷新（`mgpath` / `mgseed` / `mgrolls` /
  `mgdur` / `ttsfmt` / `svpre` 等，窗没开时只刷摘要）。
- 关窗收口：撤销（`applySnap`）、切画布（`ensureWorkflow` / `loadWorkflow`）、删节点
  （`deleteNodes` 与 agent 侧 `applyCanvasEdit`）都过 `closeNodeSettingsDialogIfStale`；
  判据是**对象身份**（撤销恢复的是深拷贝新对象），只有 id 也不在画布上才 toast。

## 6. 运行期字段与旧画布

- 两类节点都带 `output / batchOutputs / error / ranAt / running`；引擎按 proc 系习惯读写。
- 旧画布（无 kind/字段）加载：`migrateWf` 逐节点 `ensureFnToolNodeState`；
  任何时刻渲染前也会再跑一次（幂等）。
- 两类节点**整体上**仍是文本源（`isTextSource` 已含 function/tool），可被下游 @引用 /
  全局广播按现有体系注入；但**流向下游的媒体类型按端子判定**（`wireSourceMediaType`：
  该输出端子的声明 kind 优先，无声明才回落节点 kind + 实际值），所以图像端子连保存节点
  会按图像落盘，不会被「节点是文本源」这一条一刀切掉。「接入规则按现有体系扩展」
  = 只扩判定谓词，不新造一套。

## 7. 集成状态（收尾更新：原「待集成」项均已落地）

- **引擎执行**（`app-nodes.js`）：`runFunctionNode` / `runToolNode` 已实现，
  `playNode` 按 `kind === "function" / "tool"` 分发（共用 `runComputeExecNode`
  生命周期：并发闸 → 上游补跑 → 执行体 → 结果落盘 / 错误回写 / 级联）；`canControlRun`
  已含两类；`connectError` 参数端子接线约束生效。函数节点执行契约 = `renderer/js-exec.js`
  （异步 `mtnodeJsExec.run / cancel / toOutput`）→ 主进程 `fn-runtime.js`
  （worker 线程执行 + 超时 / 取消 / 事件帧 + 隐藏进程宿主按 runId 记账与树杀回收），
  实现细节与停止链见 §3 及本次 bugfix 会话纪要（独立线程 / 并发闸 / 停止即回收）。
- **双语文案**：`renderer/i18n.js` 已补全「设置」跳窗 / 新建菜单 / 工具库对话框 /
  func call 运行桥与主进程 `tools-store.js` 的 zh→en 词条（zh key 天然可用，
  en 全量补齐，见文件尾部「工具 / 函数节点 + 工具库 + func call 链路」段）。
- **节点指南**：`guides/nodes/tool.md`、`guides/nodes/function.md`（含 `en/` 英文版）——
  AGENTS.md 约定「新增节点类型必须补指南」已满足。
- **回归网（本模块的冒烟脚本，改这块必跑）**：`test/smoke-tools.js`（数据模型 / 端子 /
  func call 链路）、`test/smoke-ai-call.js`（「AI 调用」设定：模型 / 就近继承 / 内部下发 /
  按钮与弹层接线）、`test/smoke-fn-array-param.js`（数组输入端子：list 归一、多线连线、
  按端子聚合取数、注入形状、测试台数组字段）、`test/smoke-codeedit.js`（JS 编辑器纯函数层
  + 组件层 + **CSS 样式存在性**）、`test/smoke-node-browse-view.js`（浏览态渲染，含函数节点）。

- **工具库与调用链路设计**：见 [docs/tool-library.md](./tool-library.md)（跨画布复用 /
  `always` 开关 / `tools-store.js` IPC）与 [docs/func-call-chain.md](./func-call-chain.md)
  （描述子快照 → 网关注入 → tool-run 帧 → 宿主执行 → 回执）。

## 8.「AI 调用」设定（模型 · 预设 · 思考强度）

工具 / 函数 / 开发节点共用一组节点字段（`renderer/app-aicall.js` 是唯一实现）：

- **字段**：`aiModel`（模型 id，空 = 跟随默认）、`aiProvider`（智能路由 id，由模型推断）、
  `aiPreset`（`AGENT_PRESETS` 档位 id）、`aiEffort`（`AGENT_EFFORT_ORDER` 词汇表内值）。
  开发节点的 `devModel / devProvider / devPreset / devEffort` 是同一套语义的历史键：
  **读**时后者优先、前者兜底，**写**时同步写过去（老代码按 `devModel` 读的地方不受影响）。
- **生效值** `aiResolvedOf(node)`：四项各自沿 `parentSuperId` 就近向上找第一个已选值
  （工具 / 函数 / 开发节点三类才「算自己选过」；`proc_text / proc_image / agent_task` 上的
  `effort / preset` 是它们自己的运行参数，不参与「AI 调用」继承）。`*Chosen` 标记
  「这个生效值是不是本节点自己选的」，工具运行下发时只下发自己选的格。
- **新建补种** `aiCallSeedDefaults`：工具 / 函数节点按当前默认路由 + 默认模型 + 默认预设
  补一份可见选择；开发节点不补种（空 = 跟随默认，保持既有语义）。
- **工具节点运行**（`app-nodes.js` 的 `runToolNode`）：`aiApplyToSelf` 落定自身选择 +
  `aiApplyToToolRun` 把 `providerId / provider / model / 预设 / 思考强度` 下发到内部子图的
  AI 节点；**内部节点自己选过模型 / 服务商的一律不动**（就近优先）。
- **函数节点运行**（`runFunctionNode` / `testFunctionNode`）：`functionAiSpec(node)` 把
  `{ providerRoute, providerName, provider(含 baseUrl/apiKey), model, preset, effort }`
  随 `fn:run` 传进主进程 → `fn-runtime.js` 的 `st.ai` → worker 的 `mtnode.ai(...)` 经
  `dispatchProc` 的 `ai` 动作交给 `main.js` 的 `fnAiCall` 走 `apiCall`（文本 chat 通路，
  不落盘、不级联）。思考档在这里按 `off/low/medium/high` 收口（`xhigh/max → high`）。
- **未选模型的函数节点**：`mtnode.ai` 返回 `{ ok:false, error:"…还没选定「AI 调用」模型…" }`，
  不静默空跑。
- **回归网**：`test/smoke-ai-call.js`（本设定的模型 / 继承 / 下发 / 按钮与弹层 / 各层接线）
  与 `test/smoke-fn-runtime.js` [9]（`mtnode.ai` 真经桥调用）。

## 9. JS 代码编辑器组件契约（`renderer/app-codeedit.js`）与函数「开发」会话字段

函数节点的代码编辑（高亮 / 行号 / 缩进 / 格式化）自研在 `renderer/app-codeedit.js`，
样式在 `css/canvas.css`（`.js-edit` / `.js-edit-gutter` / `.js-edit-hl` / `.js-edit-input` /
`.jsl-*`）。脚本顶层函数声明即全局，节点卡片（app-canvas.js）与「测试」台（app-tools.js）
**共用同一份实现、同一个 `node.jscode`**，两边代码口径完全一致。

### 8.1 为什么不引 Monaco / CodeMirror / highlight.js

函数节点的代码量级只有几十行，自研换来的是：零包体、零额外 CSP 放通、样式完全跟随画布
明暗主题、不会把节点卡片的拖拽 / 缩放几何搅乱（第三方编辑器自带滚动与尺寸管理，与卡片
板身冲突）。自动补全 / 跳转 / Lint / 代码折叠等重功能**一律不做**——不在契约范围内，
后续也不要顺手加。除 `createJsCodeEditor` 外本文件不碰 DOM，可被 `test/` 下的冒烟脚本
直接切片跑。

### 8.2 纯函数层（无 DOM）

```
jsTokenize(src)         → [{t:"word"|"str"|"com"|"num"|"punc"|"ws", s, e}]
   词法扫描：注释 / 字符串 / 模板串（含 ${} 嵌套）/ 正则字面量（靠前置关键字集合
   JSL_REGEX_WORDS 区分除号）/ 数字 / 标识符 / 标点。高亮与格式化**同源复用**这一份。

jsHighlightHtml(src)    → html string（空输入返回 ""）
   token → <span class="jsl-*">…</span>，逐段 escapeHtml，转义口径与 app.js 的
   escapePromptHl / highlightYamlLine 一致（只放 & < >，镜像层不会出现标签注入）。
   类名：jsl-com / jsl-str / jsl-num / jsl-punc / jsl-kw（关键字）/ jsl-bool（字面值）/
   jsl-con（契约词 input、values 与 $<n> 端子键）/ jsl-fn（调用名）/ jsl-prop（属性名、
   对象键）。同类相邻 token 合并成一个 span。

formatJsCode(src, opts) → string        // opts.indent 默认 "  "（2 空格）
   逐行重排行首缩进：只调缩进，**不合并 / 不拆分任何一行、不改行内内容**；
   括号净增量只数 punc token（字符串 / 注释 / 模板内的括号天然排除）；
   switch 的 case / default 体额外一层；落在模板串或未闭合块注释内部的行原样保留；
   连续空行折到 1 行、去行尾空格、末尾不留空行 ⇒ **二次格式化幂等**。
   新建模板与「生成脚手架」写入 `node.jscode` 前也过它（app-canvas.js），
   保证卡片里第一眼就是排好的。
```

### 8.3 组件层

```
createJsCodeEditor({ value, placeholder, rows = 8(下限 3), indent = "  ",
                     onChange(value), onCommit(value) })
  → { el, ta, getValue(), setValue(v), focus(), format() → changed:boolean,
      getStats() → { lines, caretLine(1-based) } }
```

- 结构 = **行号槽 + 高亮镜像层 + 透明文字 textarea**，镜像同步沿用 `.n-text-layered` /
  `.n-prompt-hl` 那份已验证方案（含恒定追加的行尾占位 `JSL_HL_TAIL`，让两层行位一一对应、
  滚动位置可直接照搬）。字体度量必须在 CSS 里逐条钉死相同，否则两层错位。
- 键位：`Tab` 插一层缩进；选区跨行或 `Shift+Tab` 整块加 / 减一层；`Enter` 继承上一行缩进、
  行尾开括号补一层、空括号对撑开一块并把光标停在内层；输入法组字期间（`isComposing` /
  keyCode 229）绝不接管 `Enter`。写入选 `document.execCommand("insertText")` 以保住原生
  撤销栈，失败再退 `setRangeText`。
- 回调分工：`onChange` 每次输入都回调（宿主只写内存字段），`onCommit` 失焦 / `change` /
  格式化提交时回调（宿主才落盘）。`format()` 返回**是否真的改动**，值没变时不回调、
  不产生撤销点，调用方据此决定要不要压历史。
- 撤销快照口径（app-canvas.js `buildFnToolBodyMain`）：只能在**首次改动写进 `node.jscode`
  之前**取 `snapshotState()`，`onCommit` 时新值已在节点上，那时再 `pushHistory()` 会把
  编辑后的状态当成撤销点，undo 就废了。
- 两个接入点：节点卡片（rows 10 · 工具条 `.fn-code-bar` = 「格式化」按钮 + 行提示）、
  「测试」台（app-tools.js `openFnTestDialog` · rows 18 · 同一 `node.jscode`）。
  工具节点无代码区（试跑跑的是它的内部子图）。
- **CSS 落点（本轮 Bug 的根因，改编辑器时一并看）**：整套样式在 `renderer/css/canvas.css`
  末尾的 `.js-edit` 一节，由 `renderer/style.css` 的 `@import` 装进 `index.html` ——
  容器 `.js-edit` 是 `position:relative` 的参照系；`.js-edit-gutter` 绝对贴左缘
  （宽 = `--js-gw`，不接事件）；`.js-edit-hl`（镜像层）与 `.js-edit-input`（textarea）
  **共用同一条声明块**逐条钉死字体度量（inset / padding / font-size / line-height /
  tab-size / `white-space:pre` / `scrollbar-gutter`），镜像层 `pointer-events:none`、
  textarea `z-index:1` + 字透明只留 `caret-color`；九个 `.jsl-*` token 各有配色，
  `theme-light.css` 只换颜色、不碰度量。**这套样式整块缺失时三层按文档流竖排**：
  用户看到的是不可点的行号 + 镜像文字（「显示代码行」），真正可编辑的 textarea 被挤出板身
  （「点击没反应」）—— 回归由 `test/smoke-codeedit.js` [5] 逐条钉住（组件吐出的每个 class
  都必须在 canvas.css 里真有规则 · 叠放与度量口径逐条命中）。
- **函数节点参与「未选中 = 浏览态」**：`NODE_BROWSE_KINDS` 含 `function`，渲染器
  `NODE_BROWSE_BODY.function`（app-canvas.js）。浏览态只放只读内容（函数名 / 描述 /
  入出参摘要（数组参数标 `×N`）/ 等宽无行号的代码正文 / 状态行 / 输出摘要），
  **一个交互构件都不挂、正文一律不得用 `.n-text` 类**（那在节点根 mousedown 的放行名单里，
  命中就既不拖节点也不选中）；点板身 → `startNodeDrag` 记 `wasBrowse` →
  `markFormFocusAfterRender` → 切编辑态后 `applyFocusFormAfterRender` 把光标送进代码
  textarea（其 class `n-text js-edit-input` 正是 `nodeMainInputEl` 的选择器），
  于是「外部只显示内容、点进去才出可编辑代码块」成立。工具节点是 super 变体
  （`superIsOpenShell` 另有形态），不参与浏览态。

### 8.4 `fnDevSessionIds` 字段口径（函数节点「开发」= 绑定该函数的会话）

- 类型 `string[]`：该函数节点名下的开发会话 id，**新→旧**排列，`createFnDevSessionForNode`
  每次 `unshift` 一个，长度上限 24（超出从尾部 `pop`）。与开发节点的 `devSessionIds`
  **各走各的**：函数节点不是 `super + dev:true` 变体，混用会让功能块的「最近一次要求」
  回显与运行队列判定串台。
- 读取入口 `fnDevSessionsOf(node)`：按 `agentSessions()` 里**还活着的**会话过滤，再按
  `updatedAt` 倒序——所以节点上残留的失效 id 不会把按钮 title 里「已绑定 N 个开发会话」
  顶虚高。`fnDevLastRequestOf(node)` 取首个会话最后一条真实用户消息（截 160 字符）用于
  对话框回显。
- 会话契约 `fnDevContractText(node, req)` 写进 `sess._devContract`，每轮随系统提示注入，
  **不占用户消息位**（会话里只显示用户填的关键输入）。契约钉死改动边界：先用
  `mtnode_canvas_get`（`detail:"full"` + `ids:[本节点标题]`）读现状，再只用
  `mtnode_canvas_edit` 的 `update` 补丁本节点的 `jscode` / `inputs` / `outputs` /
  `description`（必要时 `setTitle` 同步函数名）；不得新建 / 删除 / 改动画布上任何其它节点，
  也不得增删连线。
- **参数即端子**（§1.3 / §2）在这条链路上的直接后果：会话动了 `inputs` / `outputs`
  参数表就是动了端子，端子数一变已连的线可能改指别的端子，因此契约要求只要动了参数表
  就必须在回复里明确提醒用户回画布复核该节点连线。
- 每次「开发」都新建会话运行（上下文干净）：标题「开发 · 函数名」、工作区 =
  `dshWorkspaceOf(node)`（节点所属画布目录）、preset / provider / model / effort 跟随用户
  当前活动会话的默认（**不硬编模型**），无活动会话时回落引擎默认；后台运行、人不跳会话
  视图。对话框草稿按节点键 `fnDev` 暂存（`devDraftTextareaOpts` / `devDraftSet`），
  取消 / Esc 不丢，提交成功后清掉。
- **工具节点同样支持「开发」**（卡片收起态 body 下方按钮 · `isToolNode` 时点击
  `developToolNode`）：镜像同一套机制，差别在两点 —— ① 字段走 `toolDevSessionIds`
  （与 `fnDevSessionIds` / 开发节点 `devSessionIds` 三套各走各的，工具节点虽是 super 变体
  但不是 `dev:true`，混用会让功能块判定串台）；② 作用域 = **这一个工具节点 + 它的内部子图**：
  契约 `toolDevContractText`（app-tools.js）允许 `update` 本工具 `toolConfig`
  （`name` / `description` / `inputs` / `outputs`），也允许在**本工具内部**
  （`parentSuperId = 本工具 id`）新建 / 删除 / 改动节点并连线来重建行为（工具的行为 =
  内部子图），但不得触碰任何其它画布节点 / 连线；动参数表同样必须提醒复核连线。
  按钮 / 会话数 / 弹窗草稿键 `toolDev` 与函数节点同构（app-canvas.js
  `buildFnToolBodyMain`）。对话框草稿键 `toolDev`。
- **参数重排（需求：工具 / 函数节点可调整输入输出参数顺序）**：「设置」跳窗的参数行支持
  ▲▼ 逐格移动与 ⠿ 把手拖动 insert。排序即参数表移位，落在 `fnToolMoveParam(node, dir,
  from, to)`（app.js，返回 perm）→ `fnToolRemapParamWires(node, dir, n, perm)` 按
  perm（oldIdx → newIdx）把该节点数据线端子号一并重映射（输入 1..N / 输出 0..M-1，
  控制端子、关系线、无关线不动；工具壳的内侧桥接 / 汇流线也按同一端子口径），
  「参数跟着端子走」不漂到别的参数。冒烟 `test/smoke-tools.js` [1] 段真跑钉住。

