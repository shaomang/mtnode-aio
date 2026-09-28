# 团队事实库（Fact Library）设计说明

> 面向维护者：改事实库（左侧「专家团」视图里的那一段）之前先读这份说明。
> 事实库是**每个画布锚点一份**的共享事实来源，库内**多篇互相独立的文档**，由专家在对话中建档维护，
> 落在磁盘上，画布配置只存绝对路径；它不上画布、不是画布节点，只服务「专家团」视图左侧专家列表，
> 供专家在回答事实性问题前优先查阅。
> 代码入口：`renderer/app-factlib.js`（路径解析 / 读写 / 文档 CRUD）、`renderer/app-review.js`（审阅 / 版本链 / 插图 / GC）、
> `renderer/app-team.js`（`fact()` / `factDocs()` getter、专家提示词索引、写根下发）、
> `renderer/app-teamview.js`（左侧分组与行内操作）、
> `main.js`（`fact:saveImage` / `fact:deleteImages` / `fact:renameLibrary` / `fact:removeLibrary` / `fact:relocateLibrary` / `app:dirs`）。
> 应用内手册：`guides/manual/one-person-company.md`（§专家团 · 团队事实库）与 `guides/manual/ai-facts.md`
> （英文 `guides/manual/en/ai-facts.md`，目录见 `guides/manual/index.json`）。
>
> **两套库**：本节讲的是「**一般事实库**」= 团队事实库（人读的 md 文档）；
> 「**AI 事实库**」（AI 读的极简条例库，`团队事实库\AI\ai-facts.json`）是另一套独立存储，
> 口径见 **§八**，两套互不读写、只共用同一个父目录。

## 一、数据落点

- **一个画布锚点一份事实库**，配置记录挂在 `S.config.team.canvases[].fact`，是**库记录**：
  `{ id, name, dir, assetsDir, providerId, model, temperature, docs[], createdAt, updatedAt }`，
  其中 `docs[]` 每项 `{ id, name, file, reviewFile, createdAt, updatedAt }`（`file` / `reviewFile` 为**绝对路径**）。
  库记录上还保留首篇文档的 `file` / `reviewFile` 镜像，供旧调用点读取。
- 旧配置里的单条 `file` 由 `normalizeFact` 自动折成 `docs[0]`（幂等、未知键保留）；旧调用 `updateFact({ file })` 会落到唯一文档。
- 库目录由 `app-factlib.js` 的 `resolvePaths(canvasId)` 在**首次建库**时算定并写死进配置：
  1. 画布文件夹非空 → `<画布文件夹>/团队事实库/`；「画布文件夹」= `app-team.js`
     `factWorkspace`（口径为「锚点手填 > 该画布的工作目录（顶栏「工作目录」`wf.workspace`）」，经
     `window.teamCanvasWorkspace` 交给事实库），**刻意不含「画布项目根（开发节点 devPath）」**——
     事实库是画布自己的资料，跟着 `devPath` 走会被拽进项目源码目录；该项目恰好是应用自身时
     库就落进应用文件夹（旧版 bug，见 §六 历史错位修复）；
  2. 画布还没有文件夹（顶栏工作目录为空）→ 弹目录选择让用户**为这张画布**选一个，选定结果
     写进库记录（`fact.dir`）——**不回写画布 / 会话工作区**（那会连带改掉专家会话的落盘目录）；
     用户取消 → `resolvePaths` 返回 `null`，建库失败。
     **旧的全局「项目文件夹根」`S.config.projectsRoot` 已不再作为事实库落点** —— 那个根常常
     就是正在开发的项目目录，库会被拽进去（用户报过的错，见 §六）。
  **不再回落到应用数据目录**（旧口径的 `facts/<canvasId>/` 已取消）。
- **落点硬守卫**（渲染层 `misplacedReason` 与主进程 `factLibDirOf` 同口径）：解析结果若位于
  **应用目录**内 —— `app.getAppPath()`（打包态 = `resources/app.asar`，开发态 = 项目根）或
  `path.dirname(app.getPath("exe"))`（安装目录）—— **或位于该画布的「开发节点项目根」**
  （`app-team.js` `factDevRoot` = `app.js` `devProjectRootOf`，经 `window.teamFactDevRoot`
  交给事实库）内，一律拒绝（返回 `null`）：前者会被升级 / 卸载带走或覆盖，后者就是
  「库被跟着 `devPath` 拽进开发项目目录」的入口。主进程经 `app:dirs` IPC 把应用目录交给渲染层。
- **建库后一律读配置里的绝对路径**（`pathsOf(lib)`），工作区变更不会让已建库漂移；
  只有「从未建过库 / 旧配置缺路径」时才重新 `resolvePaths`。
- 文档名 → 文件名经 `safeName()` 过滤路径分隔符与 Windows 非法字符，空名回落「事实库」。

## 二、多文档 · md / sidecar / 共享 assets 三件套

库目录下按文档成对落盘，`assets/` 由**整个库共享**：

| 件 | 路径 | 内容 |
|----|------|------|
| 正文（每篇文档一份） | `<dir>/<doc>.md` | 该文档当前稿，可手动编辑；首次建档写模板（已存在则原样保留，绝不覆盖） |
| 审阅 sidecar（每篇文档一份） | `<dir>/<doc>.review.json` | 该文档的版本链 `versions` / 批注 `notesLog` / 作废标记 `voided` |
| 资产（库级共享） | `<dir>/assets/` | 插图目录，各文档 md 里均用**相对路径** `assets/<file>` 引用 |

- 正文读写：`readDoc` / `writeDoc` / `ensureDoc`；sidecar 读写：`readReview` / `writeReview`。
- 文档 CRUD：`libOf` / `listDocs` / `docPathsOf` / `ensureDocByName`（按名幂等建档并落模板）/
  `renameDoc`（改磁盘 md + sidecar 后回写记录）/ `removeDoc`（把该文档移入系统回收站后删记录）/
  `removeLibrary`（整库目录移入系统回收站后摘掉库记录）。
  配置侧 getter / mutator 在 `app-team.js`：`factDocs` / `factDoc` / `ensureFactDoc` / `updateFactDoc` / `removeFactDoc` / `removeFact`。
- `statsOf(doc)` 现算**该篇文档的正文字符数与磁盘 mtime**（图片语法不计入）；左栏文档行展示**更新时间**
  （取配置 `updatedAt` 与磁盘 mtime 的较大者，专家直接写文件也能反映），不再统计图片数。
- **专家新建的文档自动登记进库**：专家在对话中新建文档走 `ensureDocByName`（渲染层入口 `factlibEnsureDoc`），
  幂等建记录 + 落模板，随即出现在左栏文档列表，无需手动新建。
- **删除（左栏入口：库行「✕ 删库」/ 文档行「✕ 删文档」）**：删除**一律进系统回收站**（`shell.trashItem`），
  不做物理删除，用户可在资源管理器里还原。渲染层 `app-teamview.js` 的 `teamViewRemoveFact` /
  `teamViewRemoveFactDoc` 先弹确认框（`confirmDialog` + `danger: true`，点名库名 / 文档名，样式与会话行删除同款），
  确认后调 `app-factlib.js` 的 `removeLibrary` / `removeDoc`，再由主进程 `fact:removeLibrary` 搬运：
  - `{ file }` 单篇：只搬该文档的 `<doc>.md` 与 `<doc>.review.json`；**仅当库内再无其它 `.md` / `.review.json`**
    时，把整个库目录（含共享 `assets/`）一起搬进回收站；
  - `{ dir }` 整库：整个「团队事实库」目录搬进回收站（正文 / 批注 / 插图一并进回收站）。
  成功后渲染层才摘记录（`removeFactDoc` / `removeFact`）；回收站不可用（网络盘 / 特殊卷）时主进程报错、
  渲染层如实提示并**保留记录**，绝不静默删除。
- **重命名（底层能力保留，左栏不提供入口）**：`renameDoc` 与主进程 `fact:renameLibrary` 只改该文档的
  `<doc>.md` 与 `<doc>.review.json`，库内其它文档与共享 `assets/` 完全不动
  （目标名已被库内其它 md 或 sidecar 占用则拒绝）。
- 路径守卫 `factLibDirGuard`（整库：直接校验目录）/ `factLibDirOf`（单篇：按 `.md` 取父目录再走前者）：
  只认绝对路径、非磁盘根，且目录必须「名为『团队事实库』或已登记进 `FACT_ASSET_DIRS`」，
  **且不在应用目录内**，防止越权动任意文件。
  旧口径里的「位于 `facts/<id>/`」已取消，不再算合法库目录。

## 三、图片插入与 GC 口径

- **插入**：剪贴板 / 截图粘贴、拖拽、本机选文件都支持。事实库目标下，图片经主进程
  `fact:saveImage` **复制进库级 `assets/`**（文件名安全化 + 唯一化，目录写进 `FACT_ASSET_DIRS` 白名单并持久化到
  userData 的 `fact-asset-dirs.json`）；渲染层用绝对 `file://` URL 显示，写回 md 的是相对引用
  `assets/<file>`。`node` 目标（文本处理节点）则直接引用本机绝对路径，不复制。
- **引用改写纪律**：专家提示词明确「引用图片按 md 里的相对路径，不要改写成本机绝对路径」。
- **GC（孤立图片回收）**：`app-review.js` 的 `rvGcOrphanImages` / `rvRunGc`，仅在 `fact` 目标下触发，
  插入图片与「采用当前版」后各跑一次（300ms 合并）。判定口径（**全库**，不是单篇）：
  - `rvCollectLibImgRefs` 收集**库内所有文档、全部留存版本**的图片引用——当前文档用内存版本链
    （比 sidecar 新，避免刚插入的图被误删），其它文档读各自 sidecar 的 versions，另计入每篇 md 正文；
    同时匹配相对路径、`assets/<rel>`、裸文件名三种形态；
  - 扫描共享 `assets/` 目录，凡**未被任何文档的任何留存版本引用**的文件列为孤儿，交主进程 `fact:deleteImages` 删除；
  - 口径要点：**任一文档的任一留存版本引用到的文件一律保留**，避免回看 / 回滚后断图、也避免跨文档误删。
- **删除边界**：`fact:deleteImages` 只删 `FACT_ASSET_DIRS` 白名单目录**直属**的文件（`path.dirname` 命中），
  目录外的路径一律进 `skipped` 不落手，防渲染层传任意路径越权删除。

## 四、回滚语义

事实库与文本处理节点**共用同一套编辑器 / 批注 / 回滚语义**（`app-review.js` 的文档目标适配层
`_rv.target = { type:'node'|'fact', ... }`），差别只在存储位置：`node` 目标读写 `node.output` + `node.review`
（随画布保存 / 回滚），`fact` 目标按**单篇文档**读写 `<doc>.md` + `<doc>.review.json`（文件落盘，不随画布保存）。
`openFactReview(doc)` 入参是单篇文档记录 `{ file, name, reviewFile, assetsDir, canvasId? }`。

- 每版全文按轮完整留存进该文档的版本链；历史各版只可**回看**。
- **回滚**把所选版本重新设为「当前可编辑版」，其后的版本**被删除且不可恢复**；仅当前（最后一）版允许修改。
- 事实库的「采用当前版」(`adoptLatestToFact`) 把当前可编辑版正文**写回该文档 `<doc>.md`**，并落 sidecar、跑一次全库 GC。
- 回滚 / 采用都会同步更新该文档 sidecar，保证版本链与正文一致；GC 与回滚配合，保证**任一留存版本引用的图片都不会被删**。

## 五、专家索引与查阅优先级

- 事实库**不进每轮系统提示正文**。`app-team.js` 的 `factLibNote(exp)` 只注入：
  1. 库内**每一篇文档**的「文档名 → 绝对路径」清单 + 事实库目录 + 共享 `assets/` 目录；
  2. 查阅优先级纪律：① 回答事实性问题前**先读最相关的事实库文档**、以库中记录为准；② 库中信息不足再查阅项目内容；
     ③ 仍不足则明说「事实库中没有该信息」并请用户补充 / 确认建档；④ 对话中发现稳定事实**同步维护事实库**——
     新主题新建独立文档（文档间内容不重叠、各司其职）、已有主题就地更新，正文写进文档而不是塞进提示词；
  3. 图片引用按 md 相对路径，不要改写为绝对路径；并交代事实库目录写权限（被沙箱拒绝后带
     `sandbox_permissions` + `justification` 原样重试一次）。
- 库还没建 / 无文档（锚点无 `fact` 记录或 `docs` 为空）时整段省略，免得模型去找不存在的文件。
- 写权限：`factWriteRoots(exp)` 把库目录、`assets/` 目录与**库内每篇文档所在目录**（绝对路径去重）
  随 `expertRunParams` 的 `writeRoots` 下发；有写根时把 `mtnode-unattended`（审批 never）抬到
  `workspace-write`，使专家在本轮能直接落盘建档 / 改档，不必每步弹确认。
  默认 `fs_write` 为 allow（专家开箱即可读写事实库；写根之外仍受 dsh 沙箱与升权审批管辖）。
- 宿主放行口径（`renderer/app-db.js autoApproveRunWrite`）：沙箱升权帧里抽出的路径**全部落在本轮写根内**
  才直接回 `allowed-once`；判据优先取**这次调用自己的目标路径**（`file_path` 等入参），
  入参拿不到路径时才退回升权理由文本 —— 理由里顺带提到的写根外路径不否决一次正当的库内写入。
  路径判定认正斜杠与反斜杠两种绝对路径写法（`E:/…` 与 `E:\…`），正斜杠写法不得被当成相对路径
  拼上工作区（拼错 = 判成写根外 = 专家拿不到自动放行、逐次弹卡）。
- 单聊与群聊都经 `runExpert → expertRunParams → expertSystemPrompt`，各自独立 run 均生效
  （写根与权限档两条链路完全同口径）。

## 六、路径回退规则（一览）

`resolvePaths(canvasId, { name })` 的完整回退链：

1. **画布文件夹优先**：`teamCanvasWorkspace(canvasId)`（= `app-team.js` `factWorkspace`，口径为
   「锚点手填 > 该画布的工作目录（顶栏）」）非空 → `<画布文件夹>/团队事实库/`；**不含开发节点项目根**；
2. **画布还没有文件夹**：弹目录选择让用户为这张画布选一个 → 选定结果写进库记录（`fact.dir`），
   此后直接命中第 1 档；**不回写画布 / 会话工作区**；用户取消 → 返回 `null`（建库失败）。
   **已废止**：旧的全局「项目文件夹根」`S.config.projectsRoot` 与「应用数据目录」两条回退；
3. **落点守卫**：算出的 `<root>/团队事实库` 若落在应用目录（`app.getAppPath()` / exe 目录）
   **或该画布的开发节点项目根**（`devProjectRootOf`）内 → 拒绝（返回 `null`）；
   口径与主进程 `factLibDirOf` 一致；
4. **建库后**：只认配置里的绝对路径（`pathsOf`）；`assetsDir` 缺失时回退 `<dir>/assets`，每篇文档的 `reviewFile` 由该文档正文文件名换 `.review.json` 推导（`docPathsOf`）。

**历史错位修复（`relocateLibrary`）**：旧版本的事实库跟着画布项目根走，可能已被建进应用文件夹
或**开发项目目录**（打包态下后者不在应用目录内，所以旧体检认不出来 —— 库就一直留在开发项目目录里）。
`pathsOf` 只读配置，`resolvePaths` 的守卫**拦不住已建库**，于是表现为「库还在开发项目目录里」。
`app-factlib.js` 的 `relocateLibrary(canvasId)` 做一次体检 + 显式迁移（入口：进团队面板
`renderTeamPane` 自动跑一次（节流：每画布本次会话只问一遍）/ 左栏点库行 `teamViewOpenFact` /
点文档行 `teamViewOpenFactDoc` / 新建文档 `teamViewFactNewDoc`）：
配置里的 `dir` 位于**应用目录内或该画布开发节点项目根内**（`misplacedReason` 分别给出
`"app"` / `"dev"`）→ 按当前口径重新解析画布文件夹（没有就先让用户为这张画布选一个）→
`confirmDialog` 问用户是否迁移（**绝不静默搬迁**）→ 同意后按磁盘实况三分支：
源目录在且目标不存在 → 调主进程 `fact:relocateLibrary`（`main.js`：整库 rename，跨卷 EXDEV
退化 copy + 指纹校验通过再删源；`from` 只认目录名「团队事实库」的绝对路径，`to` 必须同名、绝对、
不在应用目录内且不存在）；源目录已不在（被手删 / 只改了配置）→ 只重定位配置并在新目录补模板；
目标已有同名库 → 不搬、不合并，改用画布文件夹里已有的那份（`reconcile` 登记实际存在的 `.md`）——
最后把配置里的 `dir` / `assetsDir` / 每篇文档 `file` / `reviewFile` 一次改到位。
用户拒绝 / 解析不出新目录 / 搬迁失败都保持原样（返回 `false`，只 warn 不抛）。

## 七、相关代码索引

| 关注点 | 位置 |
|--------|------|
| 路径解析 / 回退 / 落点守卫（应用目录 + 开发节点项目根）/ 读写 / 文档 CRUD / 模板 / 历史错位修复 | `renderer/app-factlib.js`（`resolvePaths` / `pathsOf` / `docPathsOf` / `ensureLibrary` / `ensureDocByName` / `renameDoc` / `removeDoc` / `statsOf` / `misplacedReason` / `pickCanvasFolder` / `relocateLibrary`） |
| 审阅、版本链、回滚、插图、全库 GC | `renderer/app-review.js`（`openFactReview` / `rvSaveImage` / `rvCollectLibImgRefs` / `rvRunGc` / `adoptLatestToFact`） |
| 库记录 / 文档 getter · mutator、专家提示与写根、事实库工作区口径（`factWorkspace` = `window.teamCanvasWorkspace`）、开发节点项目根（`factDevRoot` = `window.teamFactDevRoot`） | `renderer/app-team.js`（`fact` / `factDocs` / `ensureFactDoc` / `updateFactDoc` / `removeFactDoc` / `factLibNote` / `factWriteRoots` / `factWorkspace` / `factDevRoot`） |
| 左侧分组与文档行（只增不删，不提供重命名 / 删除入口）；点库行 / 文档行 / 新建文档前先跑错位体检 | `renderer/app-teamview.js`（`teamViewOpenFact` / `teamViewOpenFactDoc` / `teamViewFactNewDoc`） |
| 主进程文件守卫 | `main.js`（`fact:saveImage` / `fact:deleteImages` / `fact:renameLibrary` / `fact:removeLibrary` / `fact:relocateLibrary` / `FACT_ASSET_DIRS`） |

## 八、AI 事实库（AI 读的极简条例库）

事实库分**两类**，落点同在画布文件夹的「团队事实库」父目录下、互不读写：

| 类 | 形态 | 谁读 | 落点 | 代码 |
|----|------|------|------|------|
| **一般事实库** = 团队事实库 | 多篇互相独立的 md 文档 + 审阅 sidecar + 共享 `assets/` | 人（专家也读） | `<画布文件夹>/团队事实库/<doc>.md` | `renderer/app-factlib.js`（§一–§七） |
| **AI 事实库** | 一件事一条的**极简条例**（一行到几行），JSON 单文件 | AI（紧凑索引，少读文件） | `<画布文件夹>/团队事实库/AI/ai-facts.json` | `renderer/app-ai-facts.js`（渲染层）/ `ai-facts-store.js`（主进程） |

用户查阅时也分类：专家团左栏是**一般事实库**的库行 / 文档行；其下另有一行**常显的「AI 事实库」入口行**
（`app-teamview.js`，带已确认条数徽标），点开是独立 dialogue（`openOverlay` persistent + 可最小化），
列表按「待确认（AI 提议）区 / 已确认条例 / 最近淘汰」三段竖直排。

### 8.1 数据格式与落点（固定路径）

- 单文件：`{ version:1, cap:100, entries:[…], log:[…] }`；条目字段见
  `renderer/app-ai-facts.js` 文件头（`id / title / text / tags / type / src / status / hit / hits /
  lastHit / protectionUntil / pinned / createdAt / updatedAt`）。**字段口径的唯一真源是该文件头**，
  主进程 `ai-facts-store.js` 只做结构归一（形状 / 类型 / **未知键保留**），不碰分数与淘汰语义。
- **固定路径不可改**：`<画布文件夹>\团队事实库\AI\ai-facts.json`。路径由渲染层解析
  （`S.config.aiFacts.canvases[canvasId].dir` → `teamCanvasWorkspace(canvasId)` → 弹目录选择），
  三段目录名 `团队事实库 / AI / ai-facts.json` 由主进程 `ai-facts-store.js` 自己拼 ——
  调用方给不出第二个落点，也就绕不过守卫。文件不存在 = 空库，**首次写入才创建**（只读查询 / 打开弹窗不落盘）。
- **与画布绑定 · 重建即可载入**：解析出的画布文件夹**登记进配置**（`S.config.aiFacts`，与团队事实库把
  `dir` 写进库记录同口径、但独立一份）；画布删除后在同一工作目录重建时，下一条路径解析直接命中配置里的
  绝对路径，**立刻载入旧库**，不弹任何确认框。
- **落点守卫的口径差异（重要）**：主进程 `ai-facts-store.js` 沿用 `main.js` `factLibDirOf` /
  `isInsideAppDir` 口径，拒绝绝对路径之外的形态（`reason`: `nodir` / `relative` / `root` / `app`），
  落在应用目录内一律拒绝、一个字节不落；而渲染层 `app-ai-facts.js` **豁免**应用目录检查
  （理由写在它的文件头：AI 库紧贴画布工作目录、随画布重建即可重写，本机画布文件夹就是源码目录时也要照建）。
  两者是「主进程守卫严、渲染层直写宽」的现状，改动落点时两边一起看。
- **坏档不丢数据**：JSON 解析失败 → 先**原样备份**成 `ai-facts.json.bak` 再当空库，主档保持不动，
  等下一次写入才重写（渲染层与主进程同口径）。
- 主进程 IPC：`aifact:pathOf` / `aifact:load` / `aifact:save`（`preload.js` 桥
  `api.aiFactsPathOf / aiFactsLoad / aiFactsSave`），写盘走 `config-providers.writeJson`（tmp + rename 原子写）。

### 8.2 计分（Hit 计数）与淘汰

- **命中计数**：只有 `query` / `get` 命中某条才 `hits+1`、`hit+1`、`lastHit=now`；
  `list`（列全部）与写入 / pin / 删除**都不计数** —— 计数只表示「这条被真正查阅过」。
  `query` 只给**真正返回给调用方**的那几条计数（`limit` 之外没被读到的条目不该涨分）。
- **写计数**：`write` 落库记 `hit+0.5`（更新与新建都记），`confirm` 确认一条 AI 提议同样记 `+0.5`。
- **分数**：`score = hit / (1 + 距上次命中天数)`（线性衰减，不设半衰期；`lastHit` 为 0 时依次退
  `updatedAt` → `createdAt` → 按 0 天算）。界面显示保留 1 位小数，排序与淘汰用同一个函数。
- **淘汰**：**已确认**条目数 > `cap`（默认 100，界面可调，硬闸 1–1000）时，先淘汰**未 pin 且过了保护期**的，
  按 `score` 升序、同分先淘汰 `lastHit` 更旧的（再相同看 `updatedAt`），削到 `cap`。
  - `pinned`（弹窗里的 ★）**永不淘汰**；「零命中的新条目」在 `protectionUntil`（创建 + 7 天）之前也不淘汰；
  - pinned + 保护期内的条目已占满上限时**不再淘汰**，只保留超额并在回执里说明（`overflow` / `protectedKept`）；
  - 淘汰结果写进文件的 `log`（最近 20 条，新的在前），弹窗底部「最近淘汰」可回看。
- **待确认（AI 提议）**：`propose` 出来的条例先落 `status:"pending"`，进弹窗顶部「待确认」区，
  **不参与查库、不占上限、不参与淘汰**；用户 `confirm` 后才落成 `active`（那一刻记写 +0.5 并给 7 天保护期），
  `reject` 直接删掉。软上限 50 条（超过只在回执里提示）。
- **upsert 语义**：带 `id` 且命中 → 更新那条；不带 `id` → 按**归一化标题**（trim + 折叠连续空白 + 小写）匹配，
  命中即更新同一条；都没命中才新建。更新保留 `hits / lastHit / pinned / createdAt`。

### 8.3 Agent 接入：工具 + 技能

- **工具 `mtnode_facts`**（`dsh/gateway/ai-facts-plugin.mjs`，随网关注册、对所有会话 / 专家 / 节点默认可用，不需接线）：
  动作 `list / query / get / write / delete / pin`；协议 `{t:'facts'}` ↔ `{t:'facts-result'}` 走 `MTNODE_BRIDGE_PORT` 桥。
  宿主侧路由在 `renderer/app-db.js`（`type === "facts"` → `handleAiFactsToolEvent` → `window.MTNodeAiFacts.op`），
  **真源仍是渲染层**：工具只透传，不发明数据；无绑定画布时回「当前没有绑定画布」（工具调用失败、会话继续）。
  工具不暴露 `propose / confirm / reject / export`（渲染层 `op` 已具备，界面用）。
- **技能 `mtnode-ai-facts`**（`mtnode-agent-skills/mtnode/ai-facts/SKILL.md`，索引由
  `tools/build-mtnode-agent-skill-index.js` 生成）：写清**索引优先级**（需要项目内容先查 AI 事实库 →
  未命中再读团队事实库 md → 最后读现文件 / 数据库；拿到条目仍回现文件核对）、
  极简条例写法（一条一件事 / 标题可辨 / ≤120 字 / 不写过程）、先 `query` 再 `write`、
  冲突口径（现文件 > 数据库 > AI 库）、以及**创建项目架构 / 工作流后必须把关键结论沉淀成条例**。
- **取代旧长期记忆**：`lt_memory` 已下线（`longtask-plugin.mjs` / `tool-visibility.mjs` 均已移除），
  长期记忆改走 `mtnode_facts`；旧 SQLite 记忆（`<数据目录>/longtask/memory.db` 的 `mem` 表）
  在**首次载入**本库时一次性迁移，见 8.4。

### 8.4 迁移（旧 SQLite 长期记忆 → AI 事实库）

- 触发点：主进程 `ai-facts-store.js` 的 `load()`（`migrate:false` 的只读探测不触发，如左栏条数）。
- 幂等：按「归一化标题 + 来源（`src`）」去重（批内 + 跨次都去重），`body→text`、
  `created / updated` 原样保留、`hits / lastHit` 初始化为 0（新库还没被查过）、`pinned` 保留。
- 删表：**写盘成功才** `longtask-store.dropMemTable()` 删 `mem` 表（`memory.db` 文件保留作备份，不删）；
  写盘失败或删表失败都不留半份数据，下次载入按去重规则重跑。

### 8.5 公开接口（渲染层 `window.MTNodeAiFacts` / `window.MTNodeAIFacts`，另有 `aiFacts*` 全局别名）

`pathOf / load / save / op / scoreOf / countOf / openDlg / canvasId`（既有）
+ `init(workdir) / read / add / update / remove / hit / propose / confirm / reject / export / pendingOf / evictLogOf`
（新增）。新口径这批都是 `op` 的薄封装 —— 读写永远只有一条路径，口径、计数、淘汰、守卫只有一份。
`op` 的动作面：`list / query / get / write / delete / pin / propose / confirm / reject / export`。

### 8.6 相关代码索引（AI 事实库）

| 关注点 | 位置 |
|--------|------|
| 渲染层真源：路径解析 / 配置登记 / 读写 / 归一化 / 计分 / 淘汰 / 待确认 / 弹窗 / 公开接口 | `renderer/app-ai-facts.js`（`pathOf` / `load` / `save` / `op` / `scoreOf` / `evict` / `openDlg` / `countOf` / `exportLib` / `MTNodeAIFacts`） |
| 专家团左栏入口行（`AI 事实库` + 条数徽标，常显） | `renderer/app-teamview.js`（`aiFacts*` 按 `typeof` 调用期取用） |
| 弹窗样式 | `renderer/css/ai-facts.css`（`.aif-*`） |
| 主进程固定文件读写 + 落盘守卫 + 迁移 | `ai-facts-store.js`（`fixedFileOf` / `load` / `save` / `migrateMemOnce` / `isInsideAppDir`） |
| 旧记忆导出口 / 删表 | `longtask-store.js`（`exportMemAll` / `dropMemTable`） |
| 桥帧路由（`facts` → 渲染层真源） | `renderer/app-db.js`（`handleAiFactsToolEvent`） |
| Agent 工具 / 技能 | `dsh/gateway/ai-facts-plugin.mjs`（`mtnode_facts`）、`mtnode-agent-skills/mtnode/ai-facts/SKILL.md` |
| 主进程装配 | `main.js`（require + 注册 `registerAiFactsIpc`）、`preload.js`（`aiFactsPathOf` / `aiFactsLoad` / `aiFactsSave`）、`build.json` → `files` 白名单 `ai-facts-store.js` |
| 冒烟 | `test/smoke-ai-facts.js`、`test/smoke-ai-facts-renderer.js` |
