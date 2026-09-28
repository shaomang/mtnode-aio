# 长周期任务 · 运行时端到端验收报告

- 验收对象：长周期任务（条带 / 状态机 run / `lt_state`·`lt_memory` / 人工任务卡 / 交付）
- 验收方式：Electron 39.8.10 起真实窗口（`require("./main.js")` ＋ 渲染层真驱动），DOM 事件与 IPC 全程真跑
- 探针：`.tmp-lt-accept.js`（临时文件，跑法见下；如需入库可改名进 `test/`）
- 原始证据：`%TEMP%\mtnode_lt_accept\result.json`、`%TEMP%\mtnode_lt_accept\shots\*.png`
- 数据隔离：`MTNODE_DATA_DIR=%TEMP%\mtnode_lt_accept\data`（未读未写用户 `%APPDATA%` 与任何凭据；数据未落应用目录，`underAppDir=false`）

```powershell
Remove-Item env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue   # 本机 shell 默认置了 1，必须清掉
& .\node_modules\electron\dist\electron.exe .tmp-lt-accept.js
```

## 一、结论

6 项验收里 **3 项通过、2 项带缺陷通过、1 项失败**；另发现 1 项文档不一致与 1 项 API 注意事项。
控制台 **无 error / 无 fatal**（仅 1 条 Electron CSP 开发态警告），DOM 扫描无异常。

| # | 验收项 | 结果 |
| --- | --- | --- |
| 1 | 条带挂载与拖拽开合 | ✅ 通过 |
| 2 | 新建 → 启用绑定 → run 落盘 | ⚠️ 条带头入口失效（F4），空态入口全通；run 落盘通过 |
| 3 | agent 环节经 dsh 网关跑通 `lt_state`/`lt_memory` 往返 | ❌ **失败（F1：归属映射缺失，工具必被拒）**；网关侧与渲染层应答侧分别真跑通过 |
| 4 | 审批卡与内容交付卡出现并可操作 | ⚠️ 审批卡全通；交付卡在**中文交付 uid** 下必失败（F2），ASCII uid 下全通 |
| 5 | 上传交付物勾掉清单 | ✅ 通过（上传真复制进交付目录 + 清单落盘） |
| 6 | tabs 下沉与状态呼吸灯 | ✅ 通过 |

## 二、缺陷（按严重度）

### F1 · 高 · 长任务 Agent 环节的 `lt_state` / `lt_memory` 必然被宿主拒绝
`ltExecAgent` 只登记了 `run.agentNode[path] = pn.id`（`renderer/app-longtask.js:1171-1172`），
而归属反查 `ltCtxOfNode()` 读的是 `run.paths`（同文件 `:628-638`），全仓没有任何地方给 `run.paths` 赋值
（`ltRunNew` 也没有该字段）。结果：工具每次调用都回「当前任务不属于任何启用中的长任务」。

证据（主进程侧截获的真实回帧，`result.json.ixFrames`）：
- 真实伪节点 id `ltr_rmu22nhpmsisbw8_na1`、`run.agentNode={"n_a1":"ltr_rmu22nhpmsisbw8_na1"}`、`run.paths === undefined`
- `e2e-read-before` → `{"kind":"lt","id":"e2e-read-before","error":"当前任务不属于任何启用中的长任务：lt_state / lt_memory 只在长任务的 Agent 节点里可用"}`
- 仅补一行 `run.paths = { n_a1: <伪节点 id> }` 后重放同样的帧：
  - `stateRead` → `{ok:true,state:{},allowedWrite:["result"],node:{path:"n_a1",...}}`
  - `stateWrite {result}` → `{ok:true,written:["result"]}`，且已落盘 checkpoint `ns.n_a1.result="验收写回-rmu22nhpmsisbw8"`
  - 越权写 → `{"error":"越权写入被拒绝：只有本节点声明的输出键可写（你声明的：result）；被拒的键：not_declared"}`
  - `lt_memory propose` → `{ok:true,proposed:1,...}`；非长任务节点 → 同一句拒绝错误；未知动作 → 「未知的 lt 动作：nope」

修复建议：`ltExecAgent` 里同步 `run.paths = run.paths || {}; run.paths[path] = pn.id;`，或把 `ltCtxOfNode` 改成反查 `run.agentNode`。

### F2 · 高 · 中文标题的交付节点永远建不出交付目录
- 渲染层 `ltDeliverUid(title)` 生成的 uid 保留中文短名（`\u4e00-\u9fa5`，`renderer/app-longtask.js:89-95`），中文界面下的节点名（「交稿」「交付」）必然带汉字。
- 主进程 `longtask-store.js` 的 `safeId()` 只收 `ID_RE = /^[A-Za-z0-9_.\-]{1,120}$/`（`:30`）→ `lt:deliverEnsure` 直接回「缺少 uid」。

证据：
- 同一入口两次直调：`{uid:"ltabcd1234-交稿"}` → `{"ok":false,"error":"lt:deliverEnsure 缺少 uid"}`；`{uid:"ltabcd1234-jiaogao"}` → `{"ok":true,"dir":"...\\longtask\\deliver\\ltabcd1234-jiaogao",...,"manifest":{...}}`
- 默认路径下的真跑：审批通过后 `b_h2` 直接 `failed`，日志「交付目录创建失败」，画布无交付节点、条带无交付卡、`确认交付完成` 不可达（`canvasDeliverNodes: []`）。
- 把该节点 uid 显式改成 ASCII（`lte2e-jiaogao`）后同一张图全通：交付卡 4 条清单、画布交付节点 `nmu22nsybc5i`、进度牌 0/3 → 3/3、终点 done。

修复建议：两侧口径对齐——uid 生成改 ASCII slug（标题只做展示），或 store 侧改成「安全化」而不是「拒绝」（如 `safeId` 对 uid 走 sanitize）。

### F3 · 中 · 长期记忆检索对中文关键词失效
`longtask-store.js` 建 FTS5 虚表未指定 tokenizer（`:147-149`，即默认 unicode61），连续汉字整段成一个 token；
只有 FTS 建不出来时才退化为 LIKE（`:115`），**FTS 可用但零命中时没有兜底**。

证据（直连 `memory.db`，库内确有 2 条含「验收」正文／标题的记录，`fts:true`）：
- `MATCH '验收'` → 0 行；`MATCH '长任务验收'` → 2 行；`MATCH '长任务验收*'` → 2 行
- 条带记忆对话框检索「验收」→ 列表空；`lt_memory recall`（Agent 侧）同样受影响

修复建议：`tokenize='trigram'`（中文子串可命中）或零命中时回落 LIKE，并对 `q` 做分词。

### F4 · 中 · 条带头上的「＋ 新建长任务」点了不刷新条带
`ltRenderHead` 里头部按钮的 handler 只 `ltNewTask(wf)`，没有 `ltRenderStrip()`（`renderer/app-longtask-ui.js:193`）；
空态里的同名按钮是两个语句 `await ltNewTask(wf); ltRenderStrip();`（`:266-269`），所以只有它会重绘。

证据：点头部按钮后 `tasks=1 / activeIsNew=true`，但 `headBtns=["⛓ 长周期任务▾","＋ 新建长任务"]`、
`.lt-empty` 仍在、`graphNodes=0`、没有「▶ 启用并绑定」——用户会重复建任务，且无从启用。
对照：改点空态里的「＋ 新建长任务」→ 头部立刻变成「⛓ 长周期任务 2▾ / ▶ 启用并绑定 / 记忆 / ⚙ / ✕」，图编辑器出现。

### F5 · 低 · 细线厚度文档与实现不一致
`guides/manual/longtask.md` §一 与 `renderer/css/longtask.css` 头注释都写「4px 细线」，
实测 `.lt-grip { height: 6px }`（发丝为 `::after` 2px）→ `gripH=6, gripHairline="2px"`。二者取一改。

### F6 · 低 · `ltEnsure()` 每次重建 task 对象（注意事项）
`ltEnsure` 每次调用都把 `wf.longtask.tasks` 换成新对象（`renderer/app-longtask.js:281-298`）。
应用内调用方都在 `ltEnsure` 之后重新取引用，未致错；但任何外部缓存 task 引用的新代码都会读到过期的
`enabled / activeRun`（本探针第一版即因此连续两阶段失败）。

## 三、逐项通过证据

**1. 条带挂载**
`#ltStrip/#ltGrip/#ltBody` 齐备、`#ltStrip` 数量 1、`#wfWrap.firstChild === #ltStrip`、紧邻 `.fn-toolbar`、
挂载即收起（`hidden=true`）、`cursor:ns-resize`、全局配置 `{open:false,h:320,parallel:4,retry:2,maxRound:3,topk:8}`、
呼吸态 `running,waiting_human,waiting_delivery,blocked`。

**1b. 拖拽开合 + tabs 下沉**
`pointerdown` → `.dragging`；下拖 8px 即展开（阈值不误触）；拖到 +200px → `body.style.height=240px`、`.open`；
松手写回 `{open:true,h:240}`；**tabs 与画布同时下沉 244px**、`tabsBelowStrip=true`（无叠压）；
双击收起 → `{open:false,h:240}`、tabs 回弹 244px；再双击恢复 `{open:true}`。

**2. 新建 → 启用 → run 落盘（空态入口）**
新建后头部出现「▶ 启用并绑定」；**空目标直接启用被图校验拦下**：toast「启用失败：第一个 Agent 任务：Agent 任务没写目标」、`enabled=false`；
点图上 Agent 节点 → 检查器 9 项（标题/目标说明/输入键/输出键/模型/服务商/预设/重试次数/允许读取画布）→ 填目标后 `cfg.goal` 落盘、`task.ver 1→2`；
启用成功（`enabled=true`,`activeRun=rmu22nhpmsisbw8`,toast「已启用并绑定本画布」），run 快照 `graph.ver=3`；
Agent 环节在隔离数据目录里按预期快速失败（`未配置带 API Key 的文本服务商`，无凭据、未消耗 token），`n_start:done / n_a1:failed / n_end:skipped`；
**落盘证据** `%TEMP%\mtnode_lt_accept\data\pipeline-console\longtask\runs\default\rmu22nhpmsisbw8.json`
（status=cancelled、节点态、`ns.n_a1.result="验收写回-…"`、`agentNode`），第二个 run `rmu22nr0caeakhf.json` status=done、4 节点全 done。

**3. 网关侧（真网关进程）**
`ELECTRON_RUN_AS_NODE=1` 起 `dsh/gateway/gateway.mjs`（与 `dsh/main-dsh.js` 同一路径同一启动方式）：
`status={"gateway":"0.1.0","node":"v22.22.1","runtimes":0,"configPath":"…/dsh/gateway/cordis.yml"}`、`pluginList` 88 个插件含
`./longtask-plugin.mjs`（`longtaskPlugin=true`）、stderr 无输出。
渲染层应答侧（见 F1 证据）：六类帧（读/写/越权写/提议/越权节点/未知动作）回帧正确，且写回落盘，`lt_memory propose` 进「待确认记忆 ×1」。

**4. 审批卡（全通）**
run `waiting`、`waits=["approve:b_h1@审稿"]`、头部 `waiting · 2 步`；
卡片 `tag=审批 / title=审稿 / 按钮 ✓通过 ✗驳回 / 有理由框`；
**驳回不写理由被拦**（toast「驳回请写理由，否则上游不知道怎么改」，仍 `waiting_human`）；
写理由通过 → `b_h1:done`、`approved` 文本入状态、`b_h2:waiting_delivery`、`waits=["deliver:b_h2"]`。

**4b. 内容交付卡（ASCII uid 后）**
卡片 `tag=内容交付`，4 条清单（文件/文本/选项/选填）、确认按钮计数 `确认交付完成（0/3）`；
画布上系统自建交付节点 `nmu22nsybc5i`（`kind=deliver`,`ltUid=lte2e-jiaogao`,`ltDir=…\deliver\lte2e-jiaogao`），
节点正文进度牌「已交付 0/3（选填 0/1）」＋「⬆ 上传交付物」「到条带上处理这个人工任务」两颗按钮。

**5. 上传交付物勾清单**
（探针把原生文件选择框换成固定文件，上传链路本身真跑）点「⬆ 上传文件」→
文件被**复制进交付目录** `…\deliver\lte2e-jiaogao\交付物-验收.txt`（37B）、`t_file.done=true`、`deliveredVia=上传`、
DOM `.lt-item.done` 计数 1；文本项真输入 → `via=手填`；选项勾选 → `via=勾选,choice=["确认"]`；
进度 `need=3 done=3 ready=true`，按钮变 `确认交付完成（3/3）`；
点确认 → `b_h2:done / b_e:done / runStatus=done`、`deliveredAt` 写入、交付节点进度牌 `已交付 3/3（选填 0/1）`；
磁盘：`manifest.json(1687) + 交付清单.md(529) + 交付物-验收.txt(37)`，checkpoint 记 `t_file:true:上传 / t_text:true:手填 / t_opt:true:勾选`。

**6. 状态呼吸灯**
等待态图节点 class `lt-nd … lt-s-waiting_human lt-breath`，`rect` 的 `animationName=ltBreath`、`--lt-glow=255, 209, 102`；
头部呼吸 chip「等你处理 ×1」。停止控制：`■ 停止` → `run.status=cancelled`、`aborted=true`、
右侧「卡住的环节」卡（文案＋「重跑这一环」）。

**7. 控制台与 DOM**
控制台 1 条：Electron `Insecure Content-Security-Policy` 开发态警告（打包后不再出现），**无 error / fatal**、
无 `render-process-gone` / `did-fail-load` / `preload-error`。
DOM 扫描：重复 id 0、`#ltStrip` 内 `undefined|NaN|[object Object]` 0 处、0 尺寸按钮 0、无横向溢出、
条带 1466×250、tabs 仍在条带下方、图 4 节点正常渲染。
截图：`shots\01-strip-closed.png` / `02-strip-open.png` / `03-task-a-enabled.png` / `04-human-deliver-card.png` / `05-delivered-done.png` / `06-final.png`。

## 四、未覆盖 / 说明

- Agent 环节的**真实模型调用**未跑（隔离数据目录无凭据，且不消耗用户 token）；因此 F1 是用「真实伪节点 id ＋ 真实 IPC 回帧」定性的，
  模型侧工具调用本身由既有 `dsh` 网关冒烟覆盖。
- 子图下钻、`map` 逐项并行、fork/join、checkpoint 续跑（`▶ 继续`）、驳回回跳、记忆导入事实库等未在本轮范围内。

## 五、修复记录（报告之后落的代码，未重跑端到端）

本报告的 F1–F6 已在源码里改掉，下表是「哪条缺陷 → 落在哪个文件的哪一处」。验证口径：静态复核（逐处对照报告证据）＋ `node --check` 三份改动文件通过；**未重跑 `.tmp-lt-accept.js` 全流程**，故下表的证据是「修复点可核对」，不等于端到端复验通过。

| 缺陷 | 改动位置 | 改法 |
| --- | --- | --- |
| F1 归属映射缺失 | `renderer/app-longtask.js:1343-1344` | `ltExecAgent` 里同步写 `run.paths[path] = pn.id`；`ltCtxOfNode`（`:747-760`）改成 `run.paths` / `run.agentNode` 两处都查，读老 checkpoint 冷启动也能对上 |
| F2 中文交付 uid 被拒 | `longtask-store.js:33-56` | 新增 `UID_RE = /^[A-Za-z0-9_.\-\u4e00-\u9fa5]{1,120}$/` 与 `safeUid()`，交付路径改走它（`safeId` 仍管 wfId / runId / 记忆 id）；`..` 与路径分隔符照旧拒绝。渲染层 `ltDeliverUid` 不动，目录名保留汉字短名 |
| F3 中文关键词检索失效 | `longtask-store.js:238-246,273` | 检索词命中 `CJK_RE`（`:273`）时跳过 FTS 直接走 LIKE 子串；纯 ASCII 词仍走 FTS（bm25 排序），零命中兜底保留 |
| F4 条带头「＋ 新建长任务」不刷新 | `renderer/app-longtask-ui.js:193-196` | handler 补 `ltRenderStrip()`，与空态入口（`:270-271`）一致 |
| F5 细线厚度文档不一致 | `guides/manual/longtask.md:12` | 文档改成「6px 的细线（发丝是中间那条 2px）」，与 `.lt-grip { height:6px }` / `::after { height:2px }` 对齐 |
| F6 `ltEnsure()` 重建 task 对象 | 未改 | 现网调用方都在 `ltEnsure` 之后重取引用，属「注意事项」不属缺陷；改动面大、收益低，留作后续 |

## 六、待办 / 用户手动入口

- 探针 `.tmp-lt-accept.js`、`.tmp-lt-geom.js` 仍是临时文件（未入库）：要留证据就把 `.tmp-lt-accept.js` 改名进 `test/`，否则可删。
- `longtask-store.js`、`renderer/app-longtask.js`、`renderer/app-longtask-ui.js`、`renderer/css/longtask.css`、`guides/manual/longtask.md` 为**新增未跟踪文件**，提交前确认一并入库；`longtask-store.js` 已在 `build.json` 的 `files` 白名单（`main.js:80` require）。
- 用户在应用里的手动入口：菜单条与画布之间那根 6px 细线**往下拖**展开条带（**双击**收起），条带左端菜单管「启用并绑定 / 任务列表 / 记忆」；节点头部 ▶ 重跑该节点，等待态节点会呼吸高亮。
- 复验建议：重跑一次 `.tmp-lt-accept.js`（清掉 `ELECTRON_RUN_AS_NODE` 后 `electron.exe .tmp-lt-accept.js`），重点看 F1 的 `lt_state` 回帧、F2 的中文 uid 交付目录、F3 的中文记忆检索，再决定 F2 是否要把渲染层 uid 也改成 ASCII slug。
