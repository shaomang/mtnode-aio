# 长周期任务 · 四项需求对照审计（只读 · 未改任何代码）

审计对象：`renderer/app-longtask.js`、`renderer/app-longtask-ui.js`、`renderer/css/longtask.css`、
`longtask-store.js`、`renderer/app-db.js`、`renderer/app-nodes.js`、`renderer/app.js`、`renderer/app-factlib.js`、
`renderer/app-team.js`、`dsh/gateway/gateway.mjs`、`dsh/gateway/canvas-plugin.mjs`、`renderer/index.html`。
方法：源码逐处对照（无运行、无测试、无构建）。

结论速览：① 骨架齐全，2 个中低缺口；② 三处创建闸与 uid 到位，但**「按环节授权读画布」实际失效**（高）；
③ **记忆库与专家团事实库确实没接上，只走「选目录导入 / 导出」**（高，确认为最可能的缺口）；④ 四项均在，
仅文案口径与可发现性小缺口。

---

## ① DAG 图形编辑 / 子图 drill / 并行 fork-map / 人工任务类型

**已实现（核对通过）**
- 节点全集 10 种：`LT_NODE_KINDS = ["start","end_ok","end_fail","agent","human","join","fork","map","sub","output"]`（app-longtask.js:32），工具条逐个可加（app-longtask-ui.js:340-358）。
- 编辑交互：拖拽移动（app-longtask-ui.js:470-499）、端口拖出连线（460-469 + 500-511）、边检查器改 label / 条件（764-780）、删除节点或边（582-599）、面包屑 + 双击 sub/map 下钻（318-336、478-485）、检查器里「⤵ 下钻编辑子图」（756-760）；下钻层的新建节点落在当前子图（`ltCurGraph` 按 `ltDrill` 解析，300-313 + `ltAddNode(task, g, kind)` 555-578）。
- 条件边：受限 JS 谓词经 `window.mtnodeJsExec.run(code, {state,node,runId}, {timeoutMs})`（app-longtask.js:865-879；执行器 `renderer/js-exec.js:110/244`，契约匹配），抛错/超时一律转 `blocked` 需人工（无静默选路）。
- 并行：superstep 主循环按图级 `parallel` 分批 `Promise.all`（976-1005）；fork 逐边求值放行、无命中则不点火下游（894-921）；join all/any（825-830）；map 逐实例命名空间隔离 + 声明键回写数组（1324-1351）。
- 人工任务类型：`human` 的 `approve` / `deliver` 两类（143-150、1260-1285），条带卡片是唯一操作面（817-874）。

**缺口 A（中）· map 并行度不受图级 parallel 约束**
`ltExecMap` 对全部 N 个实例同时 `Promise.all(ltPumpInner(...))`（app-longtask.js:1334-1344），而每个实例内部又各自按 `run.opts.parallel || ltCfg().parallel` 批量执行（`ltPumpInner` 1354-1367）。
⇒ 并发上限实际是 **N × parallel**（默认 16 × 4 = 64 个 Agent 会话），与设置里「图级并行度：同时最多几个 Agent 环节在跑」的承诺（app-longtask-ui.js:1297）不符；map 嵌套后进一步放大。建议给实例级加一个共享信号量（或把 map 实例按剩余并行额度排队）。

**缺口 B（低-中）· 连线交互缺实时反馈与重定向**
`pointerdown` 只记 `{mode:"wire"}`，`pointermove` 只处理 `mode==="move"`（488-499），松手才落线且监听挂在 svg 上（500-511）⇒ 拖线无幽灵线预览，拖出 svg 松手直接丢线；已有连线的两端不能改（只能删了重建，775-779）。

**缺口 C（低-中）· 撤销栈与状态机运行态单向脱钩**
`ltCommit` / `ltAddNode` / `ltDeleteSel` 都不 `pushHistory`（644-653、574-576、595-597）⇒ 条带里的图编辑不可撤销。
反向关系更值得注意：`snapshotState()` 只快照 `nodes / wires / groups / marks / assetEdits`，**不含 `wf.longtask`**（app.js:5459-5474），而系统建交付节点走的就是 `addNode` → `pushHistory()`（app.js:19914）⇒ 用户在画布上按一次 Ctrl+Z 就能把系统刚建的交付节点撤掉，而 run 仍停在 `waiting_delivery`（slot / 清单还在 run 里）：画布上节点凭空消失、清单进度无处可看，只能靠点「继续」（`ltResume` → `ltRebindDeliverNodes`，app-longtask.js:1530、601-614）或重进那一环补回。建议交付节点的创建不进撤销栈（`S._skipCanvasHistory` 包一次），或撤销后立即按 uid 补建。

---

## ② 画布绑定 / 按环节授权读画布 / 交付节点三道闸与 uid / 两条交付路径

**已实现（核对通过）**
- 画布绑定与快照隔离：`ltEnable` 校验图 → `run.wfId = wf.id`、`task.activeRun`、图快照 `graphVersion`（1425-1453），运行中改图不影响当前 run（333-336 有版本提示）。
- 工具可见性两条通道：伪节点带 `_lt`（1091-1108）→ `ltGrounded` 放行 `lt_state / lt_memory`，否则点名藏掉（app-db.js:1884-1887、2508）；`noCanvasRead` 点名藏 `mtnode_canvas_get / mtnode_app`（app-db.js:1857、1888-1892）。`lt` 桥帧按伪节点反查 run/命名空间，越权写键由宿主拒（app-longtask.js:639-714；路由 app-db.js:2936-2943）。
- 交付节点三道创建闸：`addNode` 需 `extra.__ltSystem`（app.js:19879-19888）、复制 `cloneNodesDeep` 跳过（app.js:16056-16058）、`canvas_edit` 建图跳过（app-nodes.js:16419-16423）；`LT.LOCKED = ["deliver"]`（app-longtask.js:755）。
- uid：`ltDeliverUid` 生成 `lt<8位>-<短名>`（89-95），启用时 `ltFillUids` 补齐（1454-1459），缺 uid 时进环节懒生成（1263），节点按 `ltUid` 认领并可在用户删掉后按同一 uid 重建（567-614）。交付目录 `<画布工作目录>/mtnode-deliverables/<uid>/`，工作目录缺失或落在应用目录内才兜底到 `%APPDATA%\pipeline-console\longtask\deliver/<uid>/`（longtask-store.js:310-325、480 的 fallback 标记 + app-longtask.js:1270-1273 提示）。
- 两条交付路径都在 UI 上：端子连线「从画布连线取」+ 直接上传（清单里 `ltItemInput` 的「⬆ 上传文件」，app-longtask-ui.js:1056-1090；交付节点卡片上的「⬆ 上传交付物」，1467-1468 + `ltNodeUpload` 1481-1520）。

**缺口 E（高）· `cfg.canvasRead`「按环节授权读画布」实际拿不到任何画布工具**
链路：伪节点 `kind = "agent_task"`（app-longtask.js:1095）→ `isCanvasScopedAgentNode` 判定为真（app-nodes.js:11451-11457）→ `nodeLock = true`（app-db.js:2455）→ `noCanvasOn = (nodeLock || canvasFreeOn) && !pureOn`（app-db.js:2471）→ `runParams.noCanvas = true`（2657）→ 网关写 `MTNODE_NO_CANVAS=1`（gateway.mjs:1354）→ `canvas-plugin` 注册口直接不注册画布三件套（canvas-plugin.mjs:538 + 79-83）。
同时系统提示注入「智能节点」人设：**禁止**调用 `mtnode_canvas_get / mtnode_canvas_edit / mtnode_app`（app-db.js:2622 → app-nodes.js:11470-11474）。
`noReadOn` 的排除项只有 `canvasFreeOn`、没有 `nodeLock`（app-db.js:2479）⇒ 勾上 `canvasRead` 只是让 hideTools 不再重复点名那两个名字，工具本身仍不存在。
`ltAgentPrompt` 只在 `canvasRead=false` 时写「本环节不授权读写画布」（app-longtask.js:1144），勾上后提示词沉默 ⇒ **UI 说「勾选后本轮才拿得到 mtnode_canvas_get」（app-longtask-ui.js:691）、运行时没有、人设还禁止**，三方不一致。
最小改法：`nodeLock = isCanvasScopedAgentNode(node) && !(node._lt && node._lt.canvasRead)`（并在 `agentToolPolicySystemNote` / `agentNodeCapabilityNote` 里对 `_lt.canvasRead` 轮改口径）；或先撤掉该开关与文案，别给假授权。

**缺口 F（中）· 端子连线取件字段对不上，最常见上游取不到**
`ltWiredFiles`（app-longtask-ui.js:1120-1142）只读 `src.files[].path|fullPath|src` 与 `src.outPath || src.savePath || src.path`。真实字段是：
- save 族 → `savedPath` / `savedPaths`（app-nodes.js:7886-7887、7927-7928、8116-8117、8212-8236…）；
- 图像 / 音频 / 视频生成 → `output = {kind, path}`（app-nodes.js:4698、4117、5030、5705、6393）；
- 图像输入 → `imageAsset`（app.js:777、app-nodes.js:15906-15914）。
⇒「save / 生成节点 → 交付节点」连好线后点「从画布连线取」会回「上游没有连进来的文件」（app-longtask-ui.js:1094-1097）。另外那句兜底 `if (!out.length && typeof op === "string")` 只在整体为空时对第一个上游生效，命中率很低。

**缺口 G（中）· 交付节点直接上传不同步 manifest，且有未判空**
`ltNodeUpload` 只改 `st.items` / `node.ltFiles` + `ltSave`（app-longtask-ui.js:1503-1517），**不调 `ltDeliverWrite`**（对比清单编辑器 commit 路径 893-895 会写），⇒ 交付目录的 `manifest.json` / `交付清单.md` 与节点显示不一致。
另 `const items = ltArr(st.items.length ? st.items : (node.ltItems || []))`（1505）——`st.items` 缺失时先读 `.length` 会 TypeError（老 run / 手改 run 可能缺）。

**缺口 H（中）· 「manifest 双向」名不副实**
渲染层从不读 `manifest.json`（全仓 `renderer/` 内 `manifest` 命中仅注释与写入处：app-longtask.js:149、546、1616），而 `lt:deliverEnsure` 只要带 `items` 就整份覆盖 `manifest.items`（longtask-store.js:463-466）⇒ 用户离线手改的 `done/value` 不会被读回，下次进环节即被图定义覆盖（`ltNormCfg` 那句「便于用户离线手改 manifest」给了错误预期）。要么实现读回合并，要么改掉注释与文档口径。

---

## ③ 记忆库 ↔ 专家团事实库同步（重点核实项：**确认为缺口**）

**两套真源，确实没接上**
- 记忆库：主进程 `memory.db` → `mem` 表（id/scope/ws/wf/type/title/body/tags/src/pinned，FTS5 索引 + 触发器），作用域 `workflow > workspace > global` 分层召回（longtask-store.js:122-165、214-262）；渲染层只走 `ltMem*` IPC（preload.js:694-698；渲染侧 app-longtask.js:440-544 的 `ltMemRecall / ltMemAdd`）。
- 专家团事实库：`renderer/app-factlib.js` 的 `window.MTNodeFactLib` —— 每个画布一份库，落 `<画布文件夹>/团队事实库/<doc>.md` + `<doc>.review.json` + `assets/`，配置真源 `S.config.team.canvases[].fact.docs[]`（app-factlib.js:1-45、884-933），配置读写走 app-team.js 的 `ensureFact / updateFact / ensureFactDoc / updateFactDoc`（app-team.js:1053、1066、1111、1140）与 `window.teamFact`（2900）。

**现状：只有「选择目录导入 / 导出」，且完全绕开 `MTNodeFactLib`**
- 导入 `ltSyncFactLibToMemory(dir)`（app-longtask.js:489-527）+ 入口「从事实库目录导入」（app-longtask-ui.js:1325-1332）：`fileOpenDialog({directory:true})` 让用户手挑目录 → `api.fileReadDir` → **只认顶层 `*.md`**（不递归、不用 `libOf / listDocs / docPathsOf / readDoc`，读不到 review sidecar 的版本链与 notesLog）→ 按 `#{1,3}` 切最多 24 节、正文 < 8 字符丢弃 → `ltMemAdd(..., tags:"factlib", src:绝对路径)`。
- 导出 `ltSyncMemoryToFactLib(dir, items)`（app-longtask.js:529-544）+ 入口「导出到事实库」（app-longtask-ui.js:1373-1379）：再挑一次目录，写「长任务记忆-YYYY-MM-DD.md」。
- 全仓 grep：`ltSyncFactLibToMemory / ltSyncMemoryToFactLib` 只出现在这两个文件自身；`window.MTNodeFactLib` / `window.teamFact` / `factlib*` 在这两个文件里**零引用**。

**连带缺口 J**
1. 导出不登记进库：不调 `ensureDocByName / ensureLibrary`，不写 review sidecar ⇒ 左栏专家文档列表只能靠 `reconcile` 扫盘兜底出现，命名也不统一（app-factlib.js:39-42、app-teamview.js:2512-2518）。
2. 导出文件名按天定（app-longtask.js:531），同一天导出第二次直接覆盖；而注释写「不覆盖专家写的原文，只附在文末」——注释与实现相反（`fileWriteText(full, …)` 无读取合并）。
3. 导入无去重：`lt:memAdd` 只按 `id` 做 upsert（longtask-store.js:388-394），重复导入同一目录整批重复入库；`src` 存绝对路径，库被 `relocateLibrary` 搬家后全部失效。
4. 导出写盘走 `api.fileWriteText`，不触发 app-factlib.js 的 `factlib:saved` 广播（只在 `writeDoc` 里派发，app-factlib.js:741）⇒ 左栏不会即时刷新。
5. 建议最小改法：两个按钮改走 `window.MTNodeFactLib`（`libOf(canvasId)` 取本画布库目录 → `listDocs/readDoc` 逐篇读；导出固定一篇「长任务记忆沉淀」，走 `ensureDocByName` + `writeDoc`，按 `src/标题` 去重合并），把「手选目录」降级为「外部目录导入」的第二入口。

---

## ④ 细线 handler / tabs 下沉 / 呼吸灯与配色 / 未绑定时新建入口

**已实现（核对通过）**
- 细线 handler：`.lt-grip` 拖拽展开/收起（`< 8px` 不响应、`dy < -14 且高度 ≤190` 收起）、双击切换，松手才落盘 `S.config.longtask.open/h`（app-longtask-ui.js:101-149）；条带整体插入 `#wfWrap` 首子元素并 `order:-1`（32-52 + longtask.css:11-18）。
- tabs 下沉：`#wfTabs` 在 `.fn-toolbar` 内（index.html:195-199），`.wf-wrap` 是 flex column（canvas.css:2-9）⇒ 展开时工具栏（含 tabs）与画布整体下移。
- 呼吸灯 / 配色：9 态（含 `ready/skipped`）在 CSS 全有色（longtask.css:389-419），`LT_BREATH = {running, waiting_human, waiting_delivery, blocked}`（app-longtask.js:36）→ `.lt-breath` + `ltBreath/ltBreathSel` 关键帧（longtask.css:424-458），kind 主色与画布同源（362-388）。
- 未绑定时新建入口：条带 head 的「＋ 新建长任务」（`!task` 分支，app-longtask-ui.js:192-193）+ 空态面板「＋ 新建长任务 / 从 JSON 导入图」（239-241、252-274），`ltNewTask` 造 start→agent→end_ok 三节点骨架（275-297）。
- CSS 生效路径无误：`renderer/index.html:9` 只引 `style.css`，`renderer/style.css:35` 以 `@import url("./css/longtask.css")` 引入 ⇒ `lt-*` 样式确实加载。

**缺口 K（低）· 「4px 细线」文案与实际不符**
实际 `.lt-grip { height: 6px }`（longtask.css:22），而 app-longtask-ui.js:5、longtask.css:4 的注释与 `guides/manual/longtask.md` 都写「4px 细线」。取一个口径（建议改文案）。

**缺口 L（低-中）· 收起态没有任何菜单入口可展开**
默认 `open:false`（ltCfg，app-longtask.js:53），展开只能拖那根细线，或点主画布上交付节点的 ▶（app-nodes.js:6630-6636 调 `LT.ui.open(true)`）。首次使用者发现成本高；建议顶栏菜单或画布右键加一项「长周期任务…」直接 `LT.ui.open(true)`。

**缺口 M（极低）· 收起态不刷新 head 徽标**
`ltRenderStrip` 在 `body.hidden` 时直接 return（app-longtask-ui.js:153），收起期间 run 状态变化不更新 head 上的「等你处理 / 待确认记忆」徽标；展开时由 `ltApplyOpen` 里的 `ltRenderStrip` 兜底（96-99），仅在收起时不可见，无功能损失。

---

## 缺口清单（按优先级）

| # | 等级 | 需求 | 缺口 | 关键证据 |
|---|------|------|------|----------|
| E | 高 | ② | `cfg.canvasRead` 授权读画布实际无效（nodeLock 整档裁掉画布三件套 + 人设明文禁止），UI/提示词/运行时三方不一致 | app-nodes.js:11451 · app-db.js:2455,2471,2479,2657 · gateway.mjs:1354 · canvas-plugin.mjs:538 · app-longtask-ui.js:691 |
| I | 高 | ③ | 记忆库与专家团事实库没接上，只走「选目录导入/导出」，绕开 `MTNodeFactLib` | app-longtask.js:489-544 · app-longtask-ui.js:1325-1332,1373-1379 · app-factlib.js:884-933 |
| A | 中 | ① | map 并行度不受图级 parallel 约束（N × parallel 个会话） | app-longtask.js:1334-1344、1361 |
| F | 中 | ② | 「从画布连线取」字段名对不上（savedPath/output.path/imageAsset），常见上游取不到 | app-longtask-ui.js:1120-1142 · app-nodes.js:7886/4698 · app.js:777 |
| G | 中 | ② | 交付节点直接上传不写 manifest；`st.items.length` 未判空 | app-longtask-ui.js:1481-1520 |
| H | 中 | ② | manifest「双向」不成立（从不读回，带 items 即整份覆盖） | app-longtask.js:149 · longtask-store.js:463-466 |
| C | 低-中 | ①/② | 撤销栈与运行态单向脱钩：图编辑不可撤销；一次 Ctrl+Z 能撤掉系统建的交付节点（run 仍 waiting_delivery） | app-longtask-ui.js:644-653、574-576 · app.js:5459-5474、19914 |
| B | 低 | ① | 连线无幽灵线预览、拖出 svg 丢线、边不可重定向 | app-longtask-ui.js:488-511、775-779 |
| L | 低 | ④ | 收起态无菜单入口展开条带（只能拖细线 / 点交付节点 ▶） | app-longtask.js:53 · app-longtask-ui.js:101-149 · app-nodes.js:6634 |
| J | 低 | ③ | 导出不登记进库、同日覆盖、注释与实现相反、导入无去重/绝对路径易失效 | app-longtask.js:529-544 · longtask-store.js:388-394 |
| K | 低 | ④ | 「4px 细线」文案 vs 实际 6px | longtask.css:22 |
| M | 极低 | ④ | 收起态 head 徽标不刷新（展开时兜底） | app-longtask-ui.js:153 |
