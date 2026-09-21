"use strict";
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.I18n = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  /* 帮助与说明的唯一真源在 guides/manual/：顶栏「文档」与设置里的「帮助」都走 openHelp →
     openAppDocs()，由主进程读 guides/manual/index.json 目录渲染页面。这里曾内嵌一整块
     ZH_EXTRA["help.html"] 帮助文（中英各一份、合计约 20 KB），应用内手册上线后再没有任何调用方
     读过它（全仓 grep 只命中定义本身），口径也早已过期（「共有 4 类节点」、旧服务商与尺寸清单）。
     新增说明只写进 guides/manual/，不要再抄回本文件。

     本文件结构：EN 的键 = 中文原文（zh 界面直接回显键本身，不报错也不缺字），值 = 英文译文。 */
  var EN = {
    /* ── 长周期任务（app-longtask.js / app-longtask-ui.js / 交付节点）──
       条带内部的长句一律走 I18n.t("中文")，未译即原样回退（不报错、不缺字）；
       这里只覆盖会出现在画布节点、右键菜单、设置项与条带头部的那批固定文案。 */
    "交付": "Deliver",
    "交付节点（长周期任务 · 人工交付清单）": "Deliverable node (long-running task · human delivery checklist)",
    "交付节点由长周期任务自动创建，不能手动添加": "Deliverable nodes are created by the long-running task system and cannot be added manually",
    /* 交付节点端子契约（本轮需求本体）：一个还没交的文件 = 一个仅输入端子，端子标签 = 文件名；
       节点板身那张 md 表逐行写明每个端子对应的文件要写什么，交掉后端子消失、可撤回。 */
    "待交付端子「": "Pending delivery terminal \"",
    "」": "\"",
    " · 内容：": " · Content: ",
    " · 要求：": " · Requirements: ",
    " · 选填": " · Optional",
    "（连入即视为已交 · 上传后该端子消失）":
      " (a wire counts as delivered · this terminal disappears after upload)",
    "| 文件名 | 内容说明 | 必填/选填 | 格式或大小要求 | 交付状态 |":
      "| File name | What goes in it | Required/Optional | Format or size | Delivery status |",
    "（还没有文件项：点下面「＋ 添加文件」）": "(no file items yet: click \"＋ Add file\" below)",
    "这张表就是每个输入端子对应的文件内容；点「▤ 预览 Markdown」在预览器里看全文":
      "This table is what each input terminal's file must contain; click \"▤ Preview Markdown\" to read the full text in the previewer",
    /* 板身那张 md 表渲染成真表格后，Markdown 正文由同排按钮开进应用内 Markdown 预览器
       —— 不用再把 Markdown 复制出去看；预览器自带「复制全文」，要取源码也在那个窗里。 */
    "▤ 预览 Markdown": "▤ Preview Markdown",
    "在 Markdown 预览器里打开这份交付清单（不必先复制 Markdown）":
      "Open this delivery checklist in the Markdown previewer (no need to copy the Markdown first)",
    "交付物清单 Markdown": "Deliverable checklist Markdown",
    "Markdown 预览器未就绪": "Markdown previewer is not ready",
    "待交付端子 · ": "Pending delivery terminals · ",
    " 个（连入即视为已交，上传后该端子消失）": " (a wire counts as delivered; the terminal disappears after upload)",
    "已交 · ": "Delivered · ",
    " 件（撤回可把端子放回来，文件不删）": " (revoke brings the terminal back; files are kept)",
    "上传": "Upload",
    "上传这个端子对应的文件（文件名要对得上）": "Upload the file for this terminal (the file name must match)",
    "删除": "Delete",
    "撤回": "Revoke",
    "把该端子放回来重新交（交付目录里的文件不删）":
      "Bring this terminal back to deliver again (files in the delivery folder are kept)",
    "（文件仍在交付目录里；要重新交就再点一次上传）":
      " (the file stays in the delivery folder; click upload again to re-deliver)",
    /* 与磁盘对账（「上传了仍然显示为 0」的修复）：完成状态只活在内存里，重开应用 / 切画布
       后要把交付目录与条目声明路径上的文件重新认成已交；来源标签与动作按钮同步到英文。 */
    "与磁盘对账": "Sync with disk",
    "按交付目录 / 条目声明路径重新核对哪些已经交过（重开应用或切画布后计数不对时点它）":
      "Re-check what is already delivered against the delivery folder / declared paths (use it when the count looks wrong after reopening or switching canvases)",
    "已按磁盘上的文件核对交付状态：更新 ": "Delivery status checked against files on disk: updated ",
    "已按磁盘上的文件核对交付状态：没有变化（": "Delivery status checked against files on disk: no change (",
    " 已交）": " delivered)",
    "交付目录": "Delivery folder",
    "添加文件": "Add file",
    "在清单里加一个待交付文件项（它同时多出一个输入端子）":
      "Add a pending file item to the list (it adds one input terminal)",
    "待交付端子都交齐了：在条带上点「确认交付完成」再往下跑":
      "All pending terminals are delivered: click \"Confirm delivery complete\" on the strip to continue",
    /* 交付连线自动收下（本次需求本体 · 只收线不放行）：文案真源在 app-longtask.js 的
       ltDeliverTakeWired / ltAutoCollectNow 与 app-longtask-ui.js 的人工卡。 */
    "必填项已交齐：点「确认交付完成」往下走（连线交齐的件已在画布上自动记为已交付，不必再去收线）。":
      "All required items are delivered: click \"Confirm delivery complete\" to carry on (files delivered over a wire were marked delivered on the canvas automatically — no need to collect them again).",
    " 件，不必再手动收线": " item(s); no need to collect from the wire by hand",
    "上游连线自动交付 ": "Auto-delivered from the upstream wire: ",
    "已从连线自动收下 ": "Collected automatically from the wires: ",
    " 件交付物：在条带右栏点「确认交付完成」往下走":
      " deliverable(s); click \"Confirm delivery complete\" in the strip's right panel to carry on",
    "还没有文件项：点下面「＋ 添加文件」": "No file items yet: click \"＋ Add file\" below",
    "曾有端子连入（本次交付由上传覆盖）": "A terminal was once wired in (this delivery overwrote it)",
    "添加待交付文件": "Add a pending delivery file",
    "文件名（端子标签就是它，上传时按它对齐）":
      "File name (this is the terminal label; uploads are matched against it)",
    "例：分镜表.md": "e.g. storyboard.md",
    "内容说明（这个文件要写什么）": "What goes in it (what this file must contain)",
    "例：每个镜头的景别 / 时长 / 台词 / 运镜":
      "e.g. shot size / duration / dialogue / camera move for each shot",
    "格式或大小要求": "Format or size requirement",
    "例：仅 .md · ≤ 2 MB（只提示不拦）": "e.g. .md only · ≤ 2 MB (a hint, never a block)",
    "必填（没交齐时点确认会先弹确认窗：说清原因就能继续）":
      "Required (if anything is missing, confirming opens a dialog first: explain why and you can continue)",
    /* 交付放行（本轮需求）：交付物没全交齐也能继续，提醒不阻止 —— 确认窗、放行后的 toast、
       板身横幅与清单标签的文案同步到英文（中文侧真源在 app-longtask-ui.js / longtask-store.js）。 */
    "确认交付完成": "Confirm delivery complete",
    "还有 ": "Still ",
    " 项必填没交齐：仍可继续，但这几项会被记成「未交付·已放行」":
      " required items are missing: you can still continue, but they will be recorded as “not delivered · released”",
    "必填项都交齐了：确认后任务继续往下跑": "All required items are delivered: confirming lets the task carry on",
    "没定下文件名（含后缀）": "no file name (extension included)",
    "没交": "not delivered",
    "（未命名）": "(unnamed)",
    "这一轮不交齐也放行：写清为什么没交、哪些需要额外交付 —— 下游 Agent 会读到这段说明（缺件影响后续时它该把本环节标为需人工）。说明可以留空，但空说明在交付目录里只会记成「（未填说明）」。":
      "This round is released even though not everything was delivered: write down why and what else must be delivered — the downstream agent reads this note (if the missing pieces affect it, it should mark its own step as needing a human). The note may be empty, but an empty note is recorded as “(no note given)” in the delivery folder.",
    "交付说明（为什么有些未交付 / 哪些需要额外交付）":
      "Delivery note (why some items were not delivered / what else must be delivered)",
    "例：第三份素材还没拿到原始文件，先用占位版推进；额外交付：成片的一版竖屏裁剪，下一轮补交":
      "e.g. the third asset has no source file yet, so a placeholder moves things along; extra delivery: a vertical crop of the final cut, to be handed in next round",
    "本环节已放行 ": "This step has been released ",
    " 轮（逐轮留痕，可在交付目录回看）": " time(s) (each round is logged; see the delivery folder)",
    "第 ": "Round ",
    "（未填说明）": "(no note given)",
    "返回补齐": "Back to fill in",
    "继续任务": "Continue task",
    "已返回：把没交的条目补齐后再点「确认交付完成」":
      "Back: fill in the missing items, then click “Confirm delivery complete” again",
    "已在未交齐的情况下放行：": "Released with items still missing: ",
    " 项必填未交，说明已记入交付目录并会带给下游":
      " required item(s) not delivered; the note is written to the delivery folder and passed downstream",
    " 项必填没交齐：仍可继续，但要先弹确认窗说清为什么、哪些需要额外交付（缺文件名的先补上文件名）":
      " required items are missing: you may continue, but a dialog asks why and what else must be delivered first (fill in file names for items that lack them)",
    "未交付·已放行": "not delivered · released",
    "未交齐放行：还有 ": "Released with items missing: still ",
    " 项必填未交，任务已继续": " required item(s) not delivered; the task has moved on",
    "放行时间：": "Released at: ",
    "（逐轮记录在交付目录的《交付清单.md》「未交付说明」段）":
      "(every round is logged in the “undelivered notes” section of 交付清单.md in the delivery folder)",
    "已在未交齐的情况下放行 ": "Released with items missing ",
    " 轮：最近一轮（第 ": " time(s); latest round (round ",
    " 轮）": ")",
    "（交付环节）": " (delivery step)",
    " 轮（": " (round ",
    "这些必填项是人工放行未交付的，不是交齐了：先评估缺件会不会影响本环节的产出 —— 会影响，就把本环节标为「需人工」并写清缺什么、要谁补，别硬跑；不影响，就照常做完并在正文里说明你是带着哪些缺件做的。":
      "These required items were released by a human, not delivered: first judge whether the missing pieces affect this step's output — if they do, mark this step as “needs a human” and state what is missing and who must supply it instead of running blind; if not, finish as usual and say in your reply which missing pieces you worked with.",
    "待交付端子都交齐了：在条带上点「确认交付完成」再往下跑（没交齐也能继续，只是会先弹确认窗要你说清原因）":
      "All pending terminals are delivered: click “Confirm delivery complete” on the ribbon to carry on (you may also continue with items missing — a dialog just asks you to explain why)",
    "取消": "Cancel",
    "添加": "Add",
    "文件名不能空：它就是这个端子的标签": "File name cannot be empty: it is this terminal's label",
    /* 交付以文件为单位（本轮需求本体）：条目名一旦不是「带后缀的文件名」就显式标「文件名待补」，
       交付必填判据也要挡住 —— 一句话类别描述不能冒充文件名。 */
    "文件名待补": "file name pending",
    "文件名必须带后缀（例：分镜表.md）：交付是一件一件文件":
      "The file name must carry an extension (e.g. storyboard.md): delivery is file by file",
    "文件名待补：交付以文件为单位，请在上面填一个带后缀的文件名（例：分镜表.md）":
      "File name pending: delivery is file by file — fill in a name with an extension above (e.g. storyboard.md)",
    "文件名待补：交付以文件为单位，请先在节点上给这一项定一个带后缀的文件名（例：分镜表.md）":
      "File name pending: delivery is file by file — give this item a name with an extension on the node first (e.g. storyboard.md)",
    /* 这几条都写成**整句**（不拼 "有 " / "还有 " 这类过泛的片段）：本表是同名键后写覆盖的
       扁平对象，「有 」/「还有 」在别处已有条目，拼片段会被那一条抢走译文。 */
    "待交付端子里有文件还没有文件名（含后缀）：交付是一件一件文件，请先在节点上给它们定下文件名":
      "Some pending terminals still have no file name (extension included): delivery is file by file — give them names on the node first",
    "必填文件还没定下文件名（含后缀），不能确认交付":
      "Required files still have no file name (extension included), so delivery cannot be confirmed",
    "必填文件没定下文件名（含后缀）：交付是一件一件文件，请先在清单里把文件名补齐":
      "Required files still have no file name (extension included): delivery is file by file — fill their names in the list first",
    "这一项还没定下文件名（含后缀）：已照样收下，请回节点补上文件名再确认交付":
      "This item has no file name (extension included) yet: it was accepted anyway — fill the name in on the node before confirming delivery",
    "已经有一个同名文件项了：端子标签要唯一，换一个名字":
      "A file item with this name already exists: terminal labels must be unique, pick another name",
    "已添加待交付文件：": "Added pending delivery file: ",
    "已交付：": "Delivered: ",
    "选择要交付的文件": "Choose the file to deliver",
    "文件后缀与要求（.": "File extension does not match the requirement (.",
    "）不符：": "): ",
    "文件体积超过要求：": "File is larger than required: ",
    "选的文件名和这个端子的文件名对不上（端子「":
      "The chosen file name does not match this terminal (terminal \"",
    "」← ": "\" ← ",
    "）：已照样收下，可撤回重传": "): it was accepted anyway, revoke and re-upload if needed",
    "已撤回：": "Revoked: ",
    "（文件仍在交付目录里）": " (the file stays in the delivery folder)",
    "已从清单删掉：": "Removed from the list: ",
    "（磁盘文件不动）": " (files on disk are untouched)",
    "待交付": "Pending",
    "已交付": "Delivered",
    "选填": "Optional",
    "必填": "Required",
    "必填·Agent 已产出": "Required · produced by agent",
    "文件": "File",
    /* 长任务「归属画布」（本轮需求：run 绑定的那张画布才是写入口，用户切画布不漂）：
       这一笔没写时的警告句 + 句尾那件东西的名字（交付节点 / 产出节点 / 长任务壳 …）。 */
    "归属画布已不在（或还没打开），这一笔没有写：": "The canvas this run belongs to is gone (or not open yet); nothing was written: ",
    "交付节点": "delivery node",
    "交付节点对齐": "delivery node alignment",
    "产出节点": "output node",
    "产出回流": "output write-back",
    "长任务壳": "long-task shell",
    /* 产出节点（kind ltout · 长任务执行中生成的信息 / 文件内容同步落到画布上的可编辑落点）：
       节点名 / 说明 / 正文占位 / 文件引用清单 / 内置 Markdown 编辑器入口 / 判不准时的确认词条。 */
    "产出": "Output",
    "产出节点（长周期任务 · 执行中产出 · 可直接编辑）":
      "Output node (long-running task · in-progress output · directly editable)",
    "产出节点：长周期任务跑出来的信息与文件内容都写在这里，你可以直接改，后续环节会用你改后的内容。":
      "Output node: information and file contents produced by the long-running task are written here; you can edit them directly, and later steps continue with your edits.",
    "长周期任务执行中生成的产出会写在这里 · 可直接编辑":
      "Output produced while the long-running task runs is written here · you can edit it directly",
    "产出文件（只读）": "Output files (read-only)",
    "用内置 Markdown 编辑器打开产出正文：保存即写回本节点，后续环节以你改后的内容为准":
      "Open the output text in the built-in Markdown editor: saving writes it back to this node, and later steps use your edited version",
    "编辑产出正文（内置 Markdown 编辑器）": "Edit output text (built-in Markdown editor)",
    "产出节点正文 · 保存即写回节点": "Output node text · saving writes it back to the node",
    /* 产物节点（kind ltart · 长任务每个环节完成时把清点出来的产物逐件摆上画布的落点）：
       节点名 / 说明 / 板身预览提示 / 头部打开入口 / 摆不上时的提示 /
       文本产物的「✎ 编辑保存」入口。 */
    "产物": "Artifact",
    "产物节点（长周期任务 · 每件产物一颗 · 板身预览 · ✎ 编辑保存 · ⇢ 打开）":
      "Artifact node (long-running task · one node per artifact · preview in the node · ✎ edit & save · ⇢ to open)",
    "用系统默认程序打开这件产物（路径见节点底部）":
      "Open this artifact with the system default app (the full path is shown at the bottom of the node)",
    "用系统默认程序打开产物": "Open the artifact with the system default app",
    "打开这件产物所在的文件夹（在文件管理器中显示）":
      "Open the folder that contains this artifact (shown in the file manager)",
    "打开产物所在文件夹": "Open the artifact's folder",
    "无法打开文件（当前环境不支持）": "Cannot open the file (not supported in this environment)",
    "这件产物没有文件路径（节点可能来自旧版）":
      "This artifact has no file path (the node may come from an older version)",
    "（空文件或读不出来，用系统程序打开看）":
      "(empty file or unreadable — open it with the system app)",
    "（读不出来，用系统程序打开看）": "(unreadable — open it with the system app)",
    "这类文件不在节点里预览 · 点上方 ⇢ 用系统程序打开":
      "This file type is not previewed in the node · click ⇢ above to open it with the system app",
    /* 文本产物的板身渲染与「👁 读全文」出口（app-canvas.js 的 ltart 文本分支）：
       头部预览按钮说明 / 读取中的占位 / 读不出来的提示 / 板身截断后的提示。 */
    "预览全文：在只读大窗里完整阅读这件文本产物（可复制，不改文件）":
      "Preview the full text: read this artifact's text in a read-only window (copyable, the file is not changed)",
    "预览产物全文（只读大窗）": "Preview the artifact text in full (read-only window)",
    "（空文件或读不出来）": "(empty file or unreadable)",
    "文本过长已在板身截断，点 👁 看全文":
      "Text is too long and was truncated in the node — click 👁 to read it in full",
    /* 文本产物的「✎ 编辑保存」入口（app-canvas.js 的 ltartEditButtonEl）：
       按钮 tooltip / aria-label / 两条通道缺失时的显式提示（都不静默、不阻断重绘）。 */
    "编辑这件文本产物并保存回文件（Markdown 阅读器 / 行视图，保存写回原文件）":
      "Edit this text artifact and save it back to the file (Markdown reader / line view; saving writes to the original file)",
    "编辑并保存文本产物": "Edit and save the text artifact",
    "文本阅读器不可用（当前环境未就绪）":
      "The text reader is not available (not ready in this environment)",
    "无法编辑这件产物（当前环境不支持读写本地文件）":
      "Cannot edit this artifact (this environment does not support reading/writing local files)",
    "编辑器未就绪": "The editor is not ready",
    /* 旧版回跳卡住现场的救援（app-longtask.js ltRearmSkipped 的日志） */
    "发现旧版回跳留下的卡住现场：已把 ": "Found a stuck checkpoint left by an older version's jump-back: re-queued ",
    " 个被跳过的环节": " skipped steps",
    /* 旧 checkpoint（早于「产物上画布」）的产物补摆（app-longtask.js ltArtRescueDone 的日志） */
    "旧版本留下的现场：已把 ": "Checkpoint from an older version: placed ",
    " 件产物补摆到画布上": " artifacts onto the canvas",
    "产出判不准，请确认": "The output could not be verified — please confirm",
    "产出内容判不准，请确认": "The output content could not be verified — please confirm",
    "已按你的修改续跑": "Continued with your edits",
    "长周期任务": "Long-running task",
    /* 绑定会话的归属标识（app-assist.js）：侧栏行徽标 / 输入区说明 / 输入框提示。
       「长任务」同时是会话标题前缀（app-longtask.js ltAgentSessionTitle），三处共用一条。 */
    "长任务": "Long task",
    "由长任务驱动 · 这条会话归长周期任务所有":
      "Driven by a long task · this session belongs to a long-running task",
    "由长任务驱动：这条会话归长周期任务的环节所有，过程与结果自动写入；你的消息会排队等本轮结束（不打断运行）":
      "Driven by a long task: this session belongs to one of its steps; progress and results are written here automatically, and your messages queue until the current round ends (without interrupting the run)",
    "过程与结果由长任务自动写入；运行中你发的消息会排在后面等本轮结束，不会打断它":
      "Progress and results are written here automatically by the long task; while it runs, your messages queue until the current round ends and do not interrupt it",
    "由长任务驱动：你发的消息会排队等本轮结束（不会插话打断）":
      "Driven by a long task: your message queues until the current round ends (it does not interrupt the run)",
    /* 环节绑定的会话标题与收尾正文（app-longtask.js ltAgentSessionTitle / ltReleaseAgentSession）：
       标题 = 「长任务 · 任务名 · 环节名」，收尾把正文或失败原因补成会话里的一条 assistant 消息。 */
    "环节": "Step",
    "（本环节没有正文输出）": "(this step produced no output text)",
    "环节未完成：": "Step did not finish: ",
    "未知原因": "unknown reason",
    /* 输出键没写回（app-longtask.js ltRecoverOutKeys / ltFixMissingOutKeys）：先自动纠错
       补问再判失败，条带日志与运行轨迹里要能看出「这是纠错，不是又跑了一遍」。 */
    "未写回声明的输出键：": "Declared output keys were not written back: ",
    "没写回输出键，判失败": "Output keys were not written back — step failed",
    "未写回输出键：": "Output keys were not written back: ",
    "自动纠错 ": "auto-repair ",
    "；自动补写回中 ": "; writing them back automatically ",
    "纠错轮出错：": "Repair round failed: ",
    "【自动纠错 · 补写回】": "[auto-repair · write-back]",
    /* 长任务 Agent 提示词的【当前状态】段（app-longtask.js ltStateBriefLine）：共享状态是整份可见的，
       但长文不整份灌进 prompt，只报字数并指向 lt_state。 */
    " = （长文 ": " = (long text, ",
    " 字符，用 lt_state 读全文）": " chars — read the full text with lt_state)",
    /* 落盘环节（app-longtask.js ltExecOutput / ltOutputHint / ltOutputAutoName）：键按整份共享状态
       找（取自平级环节时留痕）、路径留空自动兜底；两样都取不到才判失败，失败说明里带可见键清单。 */
    "output 需要 path 与已存在的状态键": "output needs a path and an existing state key",
    /* 续跑时的落盘环节自愈（app-longtask.js ltHealOutputNodes）：键现在取得到就重排，取不到不动 */
    "落盘环节的失败已自动修复（状态键现在取得到），重新排队 ": "Failed write-files steps were auto-repaired (their state key is readable now); re-queued ",
    " 个环节": " step(s)",
    " · 已自动修复：状态键「": " · auto-repaired: state key \"",
    "」取自 ": "\" taken from ",
    " · 已自动修复：没填落盘路径，写到 ": " · auto-repaired: no output path set, wrote to ",
    "取不到状态键「": "Cannot read state key \"",
    "」的值（它现在不存在，或上游还没写回）": "\" — it does not exist yet, or no upstream step has written it back",
    "本环节还没选要落盘的状态键": "This step has not picked a state key to save",
    "现在可见的状态键：": "State keys visible now: ",
    "把「取哪个状态键 / 写到哪个文件」填对后重跑本环节即可。":
      "Fix \"which state key\" / \"which file\" and re-run this step.",
    /* 启用前的图校验（app-longtask.js ltValidate）：落盘环节两件必填缺了先提醒 */
    "：还没选要落盘的状态键": ": no state key picked to save",
    "：还没填落盘路径（跑起来会兜底到工作目录）": ": no output path set (the run falls back to the workspace folder)",
    "启用并绑定": "Enable & bind",
    /* 长任务画布本轮三条（需求 1-3）：分割线按画布记 / 状态节点列子任务 / 滚轮缩放 */
    "滚轮缩放 · 点一下回到 100%": "Scroll to zoom · click to reset to 100%",
    "内容交付": "Content delivery",
    "人工审批": "Human approval",
    "（未命名条目）": "(unnamed item)",
    "（未填目标）": "(no goal yet)",
    "（未填路径）": "(no path yet)",
    "逐项：": "Per item: ",
    " 条…": " more…",
    " 个…": " more…",
    /* 状态节点卡片缩放（app-longtask-ui.js 右下角 .lt-nd-resize 手柄）：
       文字按卡片宽度截断不会探出卡片；拖右下手柄即可缩放，拉宽后重绘显示更多说明文字。 */
    "拖右下角可调整节点大小 · 拉宽可多看几行说明":
      "Drag the bottom-right corner to resize the node · widen it to see more lines",
    "拖拽调整节点大小": "Drag to resize the node",
    "节点文字超出了卡片，已按宽度截断（拉宽节点可看更多）":
      "Node text overflowed the card and was truncated to its width (widen the node to see more)",
    /* 删除长任务（条带右上角 🗑 / 设置窗同落点）：按钮 + 确认框整句 */
    "🗑 删除任务": "🗑 Delete task",
    "删除这张长任务（会先确认）": "Delete this long-running task (asks for confirmation first)",
    "删除长任务": "Delete long-running task",
    "删除选中的任务": "Delete selected task",
    "🗑 删除选中的任务": "🗑 Delete selected task",
    /* 长任务图：加节点 / 删除选中搬进图内右键菜单，删除另可按 Delete 键 */
    "删除选中": "Delete selection",
    "删除选中的节点 / 连线（也可以直接按 Delete 键）": "Delete the selected node / wire (or just press Delete)",
    "先点选一个节点或一条连线": "Select a node or a wire first",
    "在图里加一个": "Add a ",
    "节点": " node",
    "这张画布没有可删除的长任务": "This canvas has no long-running task to delete",
    "没有找到这张长任务（可能已被删除）": "That long-running task was not found (it may already be deleted)",
    "任务已删除": "Task deleted",
    "已删除长任务：": "Deleted long-running task: ",
    "将删除长任务「": "This will delete long-running task “",
    "」：在跑的 run 会被停止，它在主画布上的交付节点会被收走，历史 run 记录一并删除。交付目录里的文件不会被删。确定删除？":
      "”: a running run is stopped, its delivery nodes on the canvas are removed, and its run history is deleted. Files in the delivery folder are NOT deleted. Delete it?",
    "重新启用（新 run）": "Re-enable (new run)",
    /* 条带右端的「▶ 启用并绑定」提为常驻主按钮后，「⋯ 更多」里那颗同名重复项收敛成
       「按当前图重跑」——它是 run 还活着时唯一能开新 run 的入口，名字与主按钮区分开。 */
    "按当前图重跑": "Re-run with the current graph",
    "停用解绑": "Disable & unbind",
    "等你处理": "Waiting for you",
    "待确认记忆": "Memories to confirm",
    "图有问题": "Graph has problems",
    "检查器": "Inspector",
    "图说明": "Graph notes",
    "已交付": "Delivered",
    "从专家团事实库导入": "Import from the expert team's fact library",
    "从外部目录导入": "Import from an external folder",
    "导出到专家团事实库": "Export to the expert team's fact library",
    "导出到外部目录": "Export to an external folder",
    "长任务记忆沉淀": "Long-running task memory digest",
    "允许读取画布": "Allow reading the canvas",
    "长周期任务 · 设置": "Long-running task · Settings",
    "这张画布的长任务": "Long-running tasks on this canvas",
    "切到哪个任务": "Switch to task",
    /* 面包屑根条目（app-longtask-ui.js ltCrumbTaskBtn）：以前写死一个「主图」标签，
       现在回显**当前这张长任务的名字**，点它就是任务清单（换一张旧长任务 / 新建一张）。
       任务名本身由用户起，不进 i18n；这几条只是它周围的说明。 */
    "当前长任务：": "Current long task: ",
    " · 点这里切换到别的长任务": " · click to switch to another long task",
    "点这里新建 / 切换长任务（目前这张画布只有这一张）":
      "Click to create / switch long tasks (this canvas has only this one for now)",
    "这张画布还没有长任务": "This canvas has no long-running task yet",
    "（就是当前显示的这张）": " (the one currently shown)",
    " · 切到这张长任务": " · switch to this long task",
    /* 下钻（子图 / 逐项并行）后的回程（app-longtask-ui.js ltRenderGraph）：
       以前面包屑里只有任务切换 + 路径条目，进了子图回不到外层图，这条是补上的出路。 */
    "← 返回外层": "← Back to outer graph",
    "退回上一层子图；退到最外层图后这枚按钮收起":
      "Back up one subgraph level; the button hides once you are at the outermost graph",
    "新建一张长周期任务（手动模板或交给 Agent 建图）":
      "Create a long-running task (manual template or let an agent draft the graph)",
    "新建长周期任务": "New long-running task",
    "＋ 创建长任务": "＋ Create long task",
    "＋ 手动新建": "＋ Create manually",
    "用 Agent 生成状态机图；也可点右上角「手动新建」，从一份空白模板（起点 → Agent 任务 → 完成）开始。":
      "Let an agent draft the state machine, or click “Create manually” at the top right to start from a blank template (Start → Agent task → Done).",
    "长周期任务的新建流程在这里进行：交给 Agent 从目标直接生成状态机图，或用手动模板起步。":
      "Long-running tasks are created here: have an agent turn your goal straight into a state-machine graph, or start from the manual template.",
    "没有打开的画布": "No canvas is open",
    "长任务模块未就绪": "The long-running task module is not ready",
    /* 新建窗的两个出口与「创建时的 Agent 选型」一栏（app-longtask-create.js）：
       取消 = 只关窗，正文与选型都留在 localStorage，重新打开原样回填 */
    "关窗；已写的内容与 Agent 选型会保留，下次打开接着写":
      "Closes the window; what you typed and the agent picks are kept — reopen and continue.",
    "关窗：已写的内容与 Agent 选型会保留（下次打开接着写）；会话不接回，每次打开本窗都是全新会话":
      "Closes the window: what you typed and the agent picks are kept (reopen and continue); the session is not re-adopted — every time this window opens it is a brand-new session.",
    "Agent 选型：本次创建就用这套模型 / 预设 / 思考强度（可全部留空跟随默认；建成后仍可逐个节点改）。":
      "Agent picks: this creation uses these model / preset / thinking settings (leave all empty to follow the default; you can still change each node afterwards).",
    "模型清单还没就绪：建成后可在节点检查器里改":
      "The model list is not ready yet — you can change it in the node inspector after creation",
    "留空 = 跟随默认路由": "Empty = follow the default route",
    "留空 = 跟随默认模型": "Empty = follow the default model",
    "关窗（取消 / Esc）不会丢掉你写的正文与上面的 Agent 选型：下次打开本窗原样回来。":
      "Closing the window (Cancel / Esc) does not drop your text or the agent picks above — they come back as-is next time.",
    "长周期任务图校验未通过：": "Long-running task graph failed validation: ",
    "。请修正后重新调用 create_longtask。": ". Fix it and call create_longtask again.",
    "。请修正后重新调用 update_longtask。": ". Fix it and call update_longtask again.",
    "该任务正在跑（run ": "This task is running (run ",
    "）：当前 run 仍按启用那刻的旧版图在跑，改图不会影响它；要按新图跑需在条带上重新启用。":
      "): the current run still follows the graph snapshot from when it was enabled — editing the graph does not affect it; re-enable on the strip to run the new graph.",
    "缺少图定义 graph": "Missing graph definition",
    /* 新建窗里的 Agent 引导建图（app-longtask-guide.js）：按钮 / 状态 / 图摘要口径 */
    "中断本轮": "Stop this round",
    "在会话视图里打开": "Open in the session view",
    "看条带": "Show the strip",
    "图摘要": "Graph summary",
    "连线 ": "edges ",
    "人工环节：": "Human steps: ",
    "汇聚": "Join",
    "选路": "Fork",
    "逐项并行": "Map",
    "子图": "Subgraph",
    "人工": "Human",
    "还没有开始：写完目标点「发送」": "Not started yet: describe the goal and hit “Send”.",
    "Agent 正在等你作答：去「🐋 模型等待你的回应」卡片里点选 / 填空":
      "The agent is waiting for your answer: use the “🐋 Model is waiting for your reply” card.",
    "正在跑本轮…": "Running this round…",
    "本轮结束：图已在条带上显示（要开跑点 ▶ 启用并绑定）":
      "Round finished: the graph is already shown on the strip (hit ▶ Enable & bind to start it).",
    "本轮结束：可以继续补充 / 追问，或点「发送」接着说":
      "Round finished: add more context or hit “Send” to continue.",
    "本轮没有拿到长周期任务图：已让 Agent 按契约重出一份（不要普通会话计划）。":
      "No long-running-task graph this round: the agent was asked to deliver one per the contract (not a plain session plan).",
    "（更早的内容在会话视图里）": "(Earlier content is in the session view)",
    "还没有图：等 Agent 问清楚并落库后，这里会出现节点 / 连线摘要与「启用并绑定」。":
      "No graph yet: once the agent has finished asking and stored it, the node / edge summary and “Enable & bind” appear here.",
    "「稍后」只是关窗，会话不会丢：它就在左侧栏里，随时能自己点开看。想从空白模板起步，用右上角「＋ 手动新建」。":
      "“Later” only closes the window — the session stays in the left sidebar and you can open it any time. For a blank template use “＋ Create manually” at the top right.",
    "这条引导会话留在左侧栏只作历史；下次打开本窗是一条全新会话（不继承上下文）":
      "This guide session stays in the left sidebar as history only; reopening this window starts a brand-new session (no inherited context).",
    "来源：create_longtask 回执（已落库）":
      "Source: create_longtask receipt (stored)",
    "来源：助手回复里的图 JSON（尚未落库；点「启用并绑定」会按它新建一个任务）":
      "Source: graph JSON in the assistant reply (not stored yet; “Enable & bind” creates a task from it)",
    "来源：本画布的长任务列表（已落库；右栏这张就是条带上那张）":
      "Source: this canvas's long-running task list (already stored; the graph on the right is the one on the strip)",
    "先用一两句说清你想让长周期任务干什么": "First say in a sentence or two what the long-running task should do",
    "先写一句要补充的说明再发送": "Type a note to send first",
    "已中断本轮：会话留着，随时可以接着说": "Round stopped: the session stays, continue any time",
    "长周期任务模块还没就绪": "The long-running task module is not ready yet",
    "启用失败：": "Enable failed: ",
    "长周期任务已启用并绑定本画布": "Long-running task enabled and bound to this canvas",
    /* 创建即显示（本轮需求）：创建那一刻图就摊在条带上，不再要求先「启用并绑定」才看得见。
       手动模板的 toast 与「任务建在后台画布上」的 toast 各一条。 */
    "已新建长周期任务：图已在条带上显示（要开跑点 ▶ 启用并绑定）":
      "Long-running task created: the graph is already shown on the strip (hit ▶ Enable & bind to start it).",
    "长周期任务已建好：在它所属的画布上条带已展开（切过去就能看见），要开跑点 ▶ 启用并绑定":
      "Long-running task created: the strip is already expanded on the canvas it belongs to (switch there to see the graph); hit ▶ Enable & bind to start it.",
    /* 创建期预建画布落点（本轮需求）：壳 / 生成工作流 / 交付节点一次摆好、一律不跑。
       toast 按「到底建了什么」分段，量词跟着有值的那几类走（单复数各一条）。 */
    "已在画布上把这条长任务的落点建好（壳 / 生成工作流 / 交付节点）：生成一律不跑 · 超级节点壳 1 颗":
      "Landing points for this long-running task are on the canvas (shells / generation workflows / delivery nodes): nothing is run · 1 super-node shell",
    "已在画布上把这条长任务的落点建好（壳 / 生成工作流 / 交付节点）：生成一律不跑 · 超级节点壳 ":
      "Landing points for this long-running task are on the canvas (shells / generation workflows / delivery nodes): nothing is run · super-node shells: ",
    "生成工作流节点 1 个": "1 generation-workflow node",
    "生成工作流节点 ": "generation-workflow nodes: ",
    "交付节点 1 颗": "1 delivery node",
    "交付节点 ": "delivery nodes: ",
    " · 交付目录：": " · Delivery folder: ",
    /* 引导区剩余文案（占位 / 悬浮说明 / 图摘要来源与校验口径）：补齐 EN，避免中英混排 */
    "先一两句说清你想让长周期任务干什么（Ctrl+Enter 发送）；开始后这里可补充说明 / 直接作答，但关键作答请在「🐋 模型等待你的回应」卡片里点选。":
      "Say in a sentence or two what the long-running task should do (Ctrl+Enter to send); afterwards you can add notes or answer here, but give key answers in the “🐋 Model is waiting for your reply” card.",
    "切到智能会话视图看这条引导会话的完整历史":
      "Switch to the agent session view to see this guide session's full history",
    "停掉正在跑的这一轮（会话留着，随时可以接着说）":
      "Stop the running round (the session stays; continue any time)",
    "先关窗：这条引导会话留在左侧栏只作历史；下次打开本窗是一条全新会话":
      "Close for now: this guide session stays in the left sidebar as history only; reopening this window starts a brand-new session",
    "按住往下拖：把输入框拉高（双击回到默认高度）":
      "Drag down to make the input box taller (double-click to reset to the default height)",
    /* 本次需求：新建窗每次打开都是全新会话（清空会话，不接回上一条引导会话）。 */
    "每次打开本窗都是全新会话（不继承上次的上下文）：上一次那条引导会话留在左侧栏只作历史；你写的正文与上面的 Agent 选型会原样回来。":
      "Every time this window opens, it is a brand-new session (no context from last time): the previous guide session stays in the left sidebar as history only, while what you typed and the agent picks above come back as-is.",
    "把想法写进下面的输入框（越具体越好），点「发送」：Agent 会先用内置技能「拷问我」，每轮在「🐋 模型等待你的回应」卡片里一次问满，你在卡片里作答；共识后它把长周期任务图落库，右栏会给图摘要与「启用并绑定」。":
      "Describe the idea in the box below (the more specific the better) and hit “Send”: the agent first loads the built-in “Grill me” skill, then asks each round's whole frontier in the “🐋 Model is waiting for your reply” card and you answer there. Once you agree, it stores the long-running-task graph, and the right column shows the graph summary with “Enable & bind”.",
    "来源：create_longtask 回执（已落库 · 任务 uid ":
      "Source: create_longtask receipt (stored · task uid ",
    "图校验有问题：": "Graph validation problem: ",
    "启用这张图并与本对话框所属画布绑定，从起点开始跑":
      "Enable this graph, bind it to the canvas this dialog belongs to, and run from the start",
    "（本轮还在跑，图可能还会被它修订）": "(this round is still running; the agent may still revise the graph)",
    "长周期任务引导": "Long-running task guide",
    "Agent": "Agent",
    /* ── 任务链修改窗（app-longtask-edit.js 的 .lte-*）+ 头部「⋯ 更多」收纳
       （app-longtask-ui.js 的 ltMoreBtn）：整句进表，不在词表里放半截片段。 ── */
    "修改任务链": "Edit task chain",
    "用一句话说清要改什么，Agent 按当前任务状态图原地改 / 修复（有全部权限）":
      "Say in one sentence what to change; the agent edits / fixes the current task graph in place (full permissions)",
    "这张画布没有可修改的长任务：先创建一张":
      "No long-running task on this canvas to edit: create one first",
    "任务链修改": "Task chain edit",
    "任务链修改模块未就绪": "The task-chain edit module is not ready",
    "写清要改什么（Ctrl+Enter 发送）：例如「把审稿拆成两轮：先初审再终审」「卡住的环节后面补一条兜底分支」「这个环节的目标太笼统，改成按分镜表逐条核对」":
      "Describe what to change (Ctrl+Enter to send): e.g. “split review into two rounds: first pass, then final”, “add a fallback branch after the blocked step”, “this step's goal is too vague — check it item by item against the shot list”",
    "Agent 会先读当前任务图与运行态，再按你的要求原地改 / 修复这张图（有全部权限：能改图、能读写文件、能查画布）；改完给一段摘要。每点一次「发送」都重启一条全新会话，不继承前面的上下文。":
      "The agent first reads the current task graph and run state, then edits / fixes that graph in place as you asked (full permissions: edit the graph, read & write files, inspect the canvas) and summarises what changed. Every “Send” restarts a brand-new session that inherits no previous context.",
    "每次「发送」都开一条全新的修改会话（不继承前面的上下文，避免干扰）；上一次那条留在左侧栏只作历史":
      "Every “Send” opens a brand-new edit session (no inherited context, so earlier edits cannot interfere); the previous one stays in the left sidebar as history only",
    "收起本窗去看条带上的那张图（条带会随修改实时刷新）":
      "Close this window and look at the graph on the strip (it refreshes live as the edit lands)",
    "「稍后」只是关窗：写了一半的要求也会原样回来。每次「发送」都开一条全新的修改会话（不继承前面的上下文），上一次那条留在左侧栏只作历史，不会被本窗接回。":
      "“Later” only closes the window — a half-written request comes back as-is. Every “Send” opens a brand-new edit session (no inherited context); the previous one stays in the left sidebar as history only and is never re-adopted by this window.",
    "在上面写清你要改什么，点「发送」：Agent 会先读当前这张任务图与运行态，再按你的要求原地改图并写回，改完给一段摘要。每次「发送」都开一条全新会话，不继承前面的上下文。":
      "Write what you want changed above and hit “Send”: the agent reads the current task graph and run state, edits the graph and writes it back in place, then summarises. Every “Send” opens a brand-new session that inherits no previous context.",
    "还没有开始：写完修改要求点「发送」": "Not started yet: write your change request and hit “Send”.",
    "本轮结束：图已按你的要求写回": "Round finished: the graph was written back as you asked.",
    "本轮结束：可以再点「发送」提新的修改（会另起一条全新会话）":
      "Round finished: hit “Send” again for a new change (a brand-new session starts).",
    "读不到这张任务（可能已被删除）": "Cannot read this task (it may already be deleted)",
    "读不到这张任务（可能已被删除）。": "Cannot read this task (it may already be deleted).",
    "图版本 v": "Graph v",
    "运行中：": "Running: ",
    " 步": " steps",
    "没有在跑的 run": "No run in progress",
    "当前 run 仍按启用那刻的 v": "The current run still follows v",
    " 在跑：重新启用才用新图": " — re-enable to run the new graph",
    "任务链已更新到 v": "Task chain updated to v",
    "本轮没有把改好的图写回：已让 Agent 按契约重做一次。":
      "This round did not write the edited graph back: the agent was asked to redo it per the contract.",
    "当前任务图": "Current task graph",
    "本轮已按你的要求写回（当前 ": "Written back as you asked this round (now ",
    "回复里给了图但没能写回：": "The reply carried a graph but it could not be written back: ",
    "请让 Agent 用 update_longtask 再试一次": "ask the agent to retry with update_longtask",
    "先用一句话写清要改什么": "First write in one sentence what to change",
    "这条修改会话留在左侧栏只作历史；下次打开本窗是一条全新会话（不继承上下文）":
      "This edit session stays in the left sidebar as history only; reopening this window starts a brand-new session (no inherited context)",
    /* 头部按钮收纳：这些手动操作收进「⋯ 更多」下拉后仍要能中英对照 */
    "⋯ 更多": "⋯ More",
    "其余不常用的操作（启用 / 停用 / 记忆 / 删除任务 等）":
      "Other seldom-used actions (enable / disable / memory / delete task …)",
    "按当前图定义拍一张快照开一个 run（图改过就用新版跑）":
      "Snapshot the current graph and start a run (a changed graph runs the new version)",
    "按当前图定义从起点重跑（正在跑的 run 会被替换）":
      "Restart from the beginning with the current graph (replaces the running run)",
    "解绑本画布：图与历史记录都保留，随时可再启用":
      "Unbind this canvas: the graph and run history stay, re-enable any time",
    "长任务记忆沉淀：查 / 记 / 导出到事实库":
      "Long-task memory: search / add / export to the fact library",
    "看这张任务跑过的每一轮 run 与它们的图版本":
      "Every run this task has had, with the graph version each used",
    "扫交付目录：报告缺项 / 孤儿，只报告不删":
      "Scan the delivery folder: report missing items / orphans, never deletes",
    "按引擎规则校验当前这张图，列出 err / warn":
      "Validate the current graph with the engine rules and list err / warn",
    "长任务设置：任务切换 / 历史 run / 交付目录体检 / 图校验":
      "Long-task settings: task switch / run history / delivery check / graph validation",
    "收起长任务条带": "Collapse the long-task strip",
    /* 修改窗与引导区共用的两句出口说明（同义不同主语：这里是「修改会话」） */
    "切到智能会话视图看这条会话的完整历史":
      "Switch to the agent session view to see this session's full history",
    "先关窗：这条会话留在左侧栏只作历史；下次打开本窗是一条全新会话":
      "Close for now: this session stays in the left sidebar as history only; reopening this window starts a brand-new session",
    "关窗：写了一半的要求会原样回来；这条会话留在左侧栏只作历史":
      "Close the window: your half-written request comes back as is and this session stays in the left sidebar as history only",
    /* 图摘要里的节点类型（修改窗右栏与条带节点卡共用同一套叫法） */
    "Agent 任务": "Agent task",
    "人工任务": "Human task",
    /* 条带头部常驻按钮（这些标签原本只有中文，切英文时会中英混排） */
    "▶ 继续": "▶ Resume",
    "■ 停止": "■ Stop",
    "⚙": "⚙",
    "▶ 启用并绑定": "▶ Enable & bind",
    "停用解绑": "Disable & unbind",
    "记忆": "Memory",
    "历史 run": "Run history",
    "交付目录体检": "Delivery folder check",
    "任务图校验": "Graph validation",
    /* ── 长任务设置控件（app-longtask-ctl.js 的 .lt-sel-* + app-longtask-ui.js 的设置项）
       —— 非文字设置一律改可搜索下拉：输入框只用来搜索，值只能从清单里点出来。
       带变量的整句用 {name} / {route} / {model} / {n} / {title} 占位（I18n.t 第二参）。 ── */
    "跟随默认": "Follow default",
    "请选择": "Please choose",
    "没有候选项": "No options",
    "输入以搜索…": "Type to search…",
    "留空 = 全部": "Empty = all",
    "＋ 新建「{name}」": "＋ New “{name}”",
    "新建「{name}」": "New “{name}”",
    "默认模型": "default model",
    "{title} 声明": "declared by {title}",
    "运行态": "runtime state",
    "只能从图里已知的状态键里选；要新造键用「＋ 新建」项":
      "Choose only from state keys already known to the graph; to invent one, use the “＋ New” option",
    "图里还没有已知状态键：先给别的节点声明输出键，或上线跑一轮":
      "No known state key yet: declare output keys on other nodes first, or run the task once",
    "留空 = 自动看全部状态": "Empty = read all state automatically",
    "留空 = 全部状态": "Empty = all state",
    "输入状态键": "Input state keys",
    "输出状态键": "Output state keys",
    "跟随默认（当前 = {route} · {model}）": "Follow default (currently {route} · {model})",
    "跟随默认（当前 = {route} · {model} · {preset} · {effort}）":
      "Follow default (currently {route} · {model} · {preset} · {effort})",
    "默认预设": "default preset",
    "默认思考强度": "default effort",
    /* ── 当前选型的只读回显（app-longtask-ui.js：条带头 .lt-chip-model / 图内卡片摘要 /
       环节检查器 .lt-insp-model 那一行）—— 「本轮模型：路由 · 模型 · 预设 · 思考强度」，
       留空的字段后面跟「（跟随默认）」。 ── */
    "默认路由": "default route",
    "本轮模型：{route} · {model} · {preset} · {effort}":
      "Model this round: {route} · {model} · {preset} · {effort}",
    "（跟随默认）": " (follows default)",
    "没有可用的服务商": "No provider available",
    "没有可用的模型": "No model available",
    /* 模型格按「服务商 / 路由」收窄后，控件里那个不属于该服务商的历史值
       （老数据 / 刚换过服务商留下的裸 id）单独成组列出，说明它为什么不在本表里。 */
    "（不属于该服务商）": "(not from this provider)",
    /* 那个历史值原本属于哪一家：收窄后的模型格里就地说明归属（占位符 = 服务商名）。 */
    "（属于「{route}」）": "(belongs to \"{route}\")",
    "留空 = 用全局默认预设": "Empty = use the global default preset",
    "留空 = 用全局默认思考强度": "Empty = use the global default thinking effort",
    "模型选型继承自创建时的默认（{route} · {model}）；改动任意一项即不再继承":
      "Model choice inherited from the default captured at creation time ({route} · {model}); changing any field ends the inheritance",
    /* ── 条带头模型 chip 的选型面板（app-longtask-ui.js · ltAgentPanelOpen）──
       chip 从「只读回显」变成「选型入口」：点它开四格（服务商路由 / 模型 / 预设 /
       思考强度），改动即写回本任务**还留空**的那些 Agent 环节（含子图）。 */
    "这一轮跑哪只模型（共 {n} 个 Agent 环节）": "Which model this round runs (across {n} agent steps)",
    "改动即写回本任务全部 Agent 环节（含子图）里还留空的那几个；某一环单独指定过，就去检查器里改它":
      "A change is written back to the agent steps of this task (subgraphs included) that are still left empty; a step you already set individually is edited in its inspector",
    "　点这里改选型（改动即写回本任务全部 Agent 环节（含子图）里还留空的那几个）":
      "　Click to change the model choice (a change is written back to the agent steps of this task, subgraphs included, that are still left empty)",
    "已把 {field} 写进 {n} 个 Agent 环节（原来留空的那几个）":
      "Wrote {field} into {n} agent step(s) that were left empty",
    "{field}：本任务没有留空的环节（都各自指定过，去检查器里改）":
      "{field}: no empty agent step in this task (each was set individually — change it in its inspector)",
    "这只模型属于「{route}」：先把上面的服务商 / 路由改成它，再选模型":
      "That model belongs to “{route}”: set the provider / route above to it first, then pick the model",
    "模型选型控件未就绪": "The model picker control is not ready",
    "重试次数": "Retries",
    "{n} 次": "{n}×",
    "跟随全局默认 {n}": "Follow global default {n}",
    "留空 = 用全局默认 {n}": "Empty = use global default {n}",
    "驳回回跳到": "On reject, jump back to",
    "（不回跳）": "(no jump back)",
    "超过上限即转「失败」": "Exceeding the limit turns the step into “failed”",
    "图里没有可回跳的节点": "No node to jump back to",
    "回跳上限": "Jump-back limit",
    "不限": "Unlimited",
    " · 不限": " · unlimited",
    "{n} 轮": "{n} rounds",
    "跟随全局默认（{v}）": "Follow global default ({v})",
    "留空 = 全局默认 {n}；0 = 不限": "Empty = global default {n}; 0 = unlimited",
    "回跳次数已用完，这一环转「失败」": "Jump-back limit exhausted; this step turns into “failed”",
    "这一环没有可回跳的目标，已转「需人工」": "No jump-back target for this step; it turned into “needs a human”",
    "回跳已达上限（": "Jump-back limit reached (",
    " 轮），该环节转「失败」": " rounds); this step turns into “failed”",
    "留空 = 全局默认 {n}": "Empty = global default {n}",
    "取哪个状态键": "Which state key to take",
    "留空 = 不取值": "Empty = take no value",
    "展开哪个数组键": "Which array key to expand",
    "（未选）": "(unset)",
    "图里还没有数组型状态键：先让某个 map 节点声明回写键，或上线跑一轮":
      "No array-typed state key yet: have a map node declare a write-back key first, or run the task once",
    "回写父图的键": "Keys written back to the parent graph",
    "命名空间隔离：只这些键会提上去": "Namespace isolation: only these keys are lifted up",
    "图级并行度": "Graph-level parallelism",
    "同时最多几个 Agent 环节在跑；超出排队": "How many Agent steps may run at once; the rest queue",
    "Agent 失败重试": "Agent failure retries",
    "每个环节失败后原样重发的次数": "How many times a failed step is resent as-is",
    "驳回回跳上限": "Reject jump-back limit",
    "0 = 不限（默认）；超过上限即转「失败」": "0 = unlimited (default); exceeding the limit turns the step into “failed”",
    "记忆注入 TopK": "Memory injection TopK",
    "每个环节往提示词里塞几条记忆；0 = 不注入": "How many memory entries to inject into each step's prompt; 0 = none",
    /* ── 报错出路：无视报错直接进下一环（app-longtask.js ltManualResolve · app-longtask-ui.js
       ltErrEscapeBox）—— 两档出路同一套词：跳过这一环 / 判失败也继续，外加「跳到哪一环」。 ── */
    "无视这次报错，接着往下跑": "Ignore this error and keep going",
    "这一环照旧记为失败，但不再拦住流程：下游照常点火，缺的东西由下游自己说（判失败 ≠ 跳过）。":
      "This step still counts as failed, but no longer blocks the flow: downstream fires as usual and says what it is missing (failed ≠ skipped).",
    "这一环记为「已跳过」：它留下的东西下游照旧读得到，缺的东西下游自己会说。":
      "This step is marked “skipped”: whatever it left behind is still readable downstream, and missing pieces are reported downstream.",
    "跳到哪一环": "Jump to which step",
    "（不填 = 走它自己的下游）": "(empty = go to its own downstream)",
    "留空 = 走它自己的下游": "Empty = go to its own downstream",
    "图里没有别的环节可跳": "No other step in this graph to jump to",
    "只列同一张图里的环节；留空 = 走它自己的下游": "Lists only steps in the same graph; empty = go to its own downstream",
    "以后这一环报错都照此放行（写回图定义）": "Always let this step through on error (saved into the graph definition)",
    "无视报错并继续": "Ignore the error and continue",
    "无视报错：判失败并继续": "Ignore the error: mark failed and continue",
    "判失败也继续": "Mark failed and continue",
    "这一环记为失败，但照常点火下游（不再挂在这儿等人）":
      "This step is marked failed, but downstream still fires (no longer parked here waiting for a human)",
    "长任务引擎未就绪：先点「继续」再试": "Long-task engine not ready: click “Continue” and try again",
    "这一环当前没有报错，放行不了": "This step has no error right now, so it cannot be let through",
    "已放行：": "Let through: ",
    "图定义自动放行": "Auto let-through by graph definition",
    "无视报错，跳过这一环": "Ignoring the error; skipping this step",
    "无视报错，判失败但继续": "Ignoring the error; marking failed but continuing",
    "无视报错": "Ignore the error",
    "按图定义无视报错，继续往下走": " · ignoring the error per graph definition, continuing",
    "（下一环：": " (next step: ",
    "（走它自己的下游）": " (goes to its own downstream)",
    "已按图定义无视报错：": "Ignored the error per graph definition: ",
    "无视报错：跳过这一环": "Ignoring the error: skipping this step",
    "无视报错：判失败并继续往下跑": "Ignoring the error: marking failed and continuing",
    /* 放行入口的失败回执（app-longtask.js ltManualResolve）：说清为什么放行不了 */
    "没有这一环": "No such step",
    /* 引擎的失败回执是极短键；卡片上那句长一点的另有一条（两条都留着，别合并 ——
       合并会让引擎回执在英文界面变成一长句）。 */
    "这一环当前没有报错": "This step has no error",
    "要跳去的那一环得是图里另一个环节": "The jump target must be another step in the graph",
    "找不到该环节的图定义（图已改版？）": "This step's graph definition is missing (graph changed?)",
    /* ── 「强行进入下一状态」（本次需求 · app-longtask.js ltForceAdvance / app-longtask-ui.js
       ltForceAdvanceBtn）：条带头的 run 级出路。施加动作只在引擎里有一份，界面只报告结果。 ── */
    "⏭ 强行进入下一状态": "⏭ Force next state",
    "强行进入下一状态": "Force next state",
    "强行推进": "Force ahead",
    "把卡住的环节放行、把被停止的环节排回队列，让状态机按图继续往下走（下一次先试「▶ 继续」）":
      "Let blocked steps through and requeue stopped steps so the state machine keeps moving (try “▶ Continue” first next time)",
    "强行进入下一状态：把卡住的环节按「放行」处理（记为已跳过、照常点火下游，不假装它做成了）":
      "Force next state: blocked steps are “let through” (marked skipped, downstream still fires — never pretending they succeeded).",
    "被「停止」按下来的环节重新排回队列接着跑；正在等你确认的环节不动。确定继续？":
      "Steps stopped by “Stop” are requeued to run again; steps waiting on your confirmation are left alone. Continue?",
    "这一轮没有卡住的环节：已按「继续」恢复现场": "No blocked step in this run: restored the scene via “Continue”",
    "这一轮已经跑完了，没有要推进的状态": "This run already finished; there is no state to advance",
    "这一轮没有卡住的环节，也没有可推进的状态": "This run has no blocked step and no state to advance",
    "没有启用中的长任务": "No enabled long task",
    "已强行推进：放行 ": "Forced ahead: let through ",
    " 个环节、": " step(s), ",
    " 个环节重新排队": " step(s) requeued",
    "强行推进失败": "Force-advance failed",
    "放行失败": "Failed to let through",
    "用户手动强行进入下一状态": "User forced the next state manually",
    "强行进入下一状态：放行 ": "Force next state: let through ",
    " 个卡住的环节、": " blocked step(s), ",
    " 个被停止的环节重新排队": " stopped step(s) requeued",
    "整个任务": "Whole task",
    /* ── 结论性图问题就地补好（本次需求 · app-longtask.js ltAutoRepairGraph / ltEnable）──
       「缺起点 / 缺终点 / 空图」不是链条中间的状态，而是链条立不起来；先补，补不动才说。 ── */
    "补了一个起点（原来没有 start：任务根本没法开跑）": "Added a start node (there was no start, so the task could not begin at all)",
    "补了一个成功终点（原来没有 end_ok：跑完无处可去）": "Added a success end (there was no end_ok, so a finished run had nowhere to go)",
    "补了一个成功终点（原来只有失败终点：成功那条路无处可去）":
      "Added a success end (only a failure end existed, so the success path had nowhere to go)",
    "图里缺的那一头已就地补好：": "The missing end of the graph was patched in place: ",
    "还有这些要你自己改：": "These still need your own fix: ",
    "图定义不可用": "Graph definition is unusable",
    "图是空的：先加一个 Agent 任务或人工任务": "The graph is empty: add an Agent task or a human task first",
    /* ── 一人公司 / 专家团（app-team.js · app-teamview.js · app-team-recruit.js） ── */
    " · 运行中": " · running",
    " 位专家": " experts",
    " 类工具一律禁止": " tool categories are blocked",
    "DeepSeek 官方（默认）": "DeepSeek official (default)",
    "HR 正在写角色卡…": "HR is drafting the role card…",
    "↻ 重发": "↻ Resend",
    "① 身份与外观": "① Identity & appearance",
    "② 人设": "② Persona",
    "③ 提示词（四段式，合计 ≤470 字）": "③ Prompt (four sections, ≤470 chars total)",
    "④ 模型档位": "④ Model tier",
    "⑤ 权限": "⑤ Permissions",
    "」的身份，只就你专业那一摊给出意见，按以下小节输出：": "\", and speak only to your area of expertise, in the following sections:",
    "【你的任务】以「": "[Your task] As \"",
    "【你的任务】你是主持人，只做聚合与结构化，不新增任何观点。请输出一张「建议卡」，":
      "[Your task] You are the facilitator: only aggregate and structure, never add new opinions. Output one \"advice card\" ",
    "【你的任务】你是主持人，只决定本轮谁上桌发言：按与问题的相关性挑 2–6 位，**不要全员参与**。":
      "[Your task] You are the facilitator: decide only who takes the table this round — pick 2–6 experts by relevance to the question; **never invite everyone**.",
    "【可选专家】": "[Available experts]",
    "【本轮参与人】": "[Participants this round] ",
    "【本轮发言（只汇总这些，未参与者本轮没有发言，不得替他们编观点）】":
      "[Statements this round (summarize only these; non-participants did not speak — never invent views for them)]",
    "【历史发言（前几轮，供参照，不重复计入本轮结论）】":
      "[Earlier statements (previous rounds, for reference; not counted again in this round's conclusion)]",
    "不要自己作答，不要新增观点，也不要解释过程。":
      "Do not answer yourself, do not add new opinions, and do not explain your process.",
    "主持人按问题相关性选定本轮参与人。":
      "The facilitator selected this round's participants by relevance to the question.",
    "主持人选定": "Facilitator-picked",
    "候选不足 3 位：本轮全部参与。":
      "Fewer than 3 candidates — everyone participates this round.",
    "只输出一个 ```json 围栏，字段：participants（专家姓名数组，姓名必须与上面逐字一致，2–6 位，且不得等于全员）, reason（一句话选人理由）。":
      "Output exactly one ```json fenced block with fields: participants (array of expert names, spelled exactly as above, 2–6 of them, and never the full roster), reason (one-line rationale).",
    "按专家画像与问题的相关性选出本轮参与人（主持人选人不可用时的本地回退）。":
      "Participants chosen locally by expert profile vs. question relevance (fallback when facilitator selection is unavailable).",
    "按相关性选定": "Picked by relevance",
    "本轮参与": "Participated this round",
    "用户 @ 指定：只由被 @ 的专家参与本轮。":
      "User @ mention: only the @-mentioned expert takes part this round.",
    "被 @ 指定": "@-mentioned",
    "（暂无发言）": "(no statements yet)",
    "【已有发言（供你参考并回应，不要重复别人已说的）】":
      "[Earlier statements (reference and respond; don't repeat what others said)]",
    "【用户问题】": "[User question] ",
    "【讨论发言】": "[Discussion statements]",
    "【项目】": "[Project] ",
    "下一步": "Next steps",
    "不做什么、能力边界（≤150 字）": "What you don't do, capability boundaries (≤150 chars)",
    "专业背景": "Background",
    "专家只能在宿主审批档的交集内收窄，不能扩权":
      "Experts can only narrow within the host approval preset's intersection — never widen permissions",
    "专长：": "Expertise: ",
    "主持：": "Facilitator: ",
    "事实冲突以可核验来源为准；假设冲突不选边，改为「若 X 则 A，若 Y 则 B」；风险结论优先于收益结论；红线结论不可被推翻。":
      "Factual conflicts defer to verifiable sources; assumption conflicts pick no side — phrase as \"if X then A, if Y then B\"; risk conclusions outrank benefit conclusions; red-line conclusions cannot be overruled.",
    "人设合计": "Persona total",
    "仅存档": "Archive only",
    "你是「": "You are \"",
    "你的工具许可 —— ": "Your tool permissions — ",
    "例如：我要一个盯现金流的财务顾问，保守、爱唱反调，能测算盈亏平衡":
      "e.g. I want a cash-flow-focused financial advisor, conservative, likes to push back, can model break-even",
    "依据": "Evidence",
    "保存并录用": "Save & hire",
    "先在左侧选择一位专家": "Pick an expert on the left first",
    "先在左侧选择项目和专家": "Pick a project and expert on the left first",
    "先建一个项目": "Create a project first",
    "先说说你要招什么样的人": "First, describe who you want to hire",
    "发送（Enter 发送，Shift+Enter 换行）": "Send (Enter to send, Shift+Enter for newline)",
    "可点「重新生成」再试一次。": "Click \"Regenerate\" to try again.",
    "可直接调用：": "Can call directly: ",
    "四段合计": "Four sections total",
    "回答语言：": "Reply language: ",
    "圆桌": "Roundtable",
    "圆桌 ": "Roundtable ",
    "圆桌讨论": "Roundtable discussion",
    "在左侧选择一位专家开始对话。": "Pick an expert on the left to start chatting.",
    "实时预览 · 系统提示词（角色层）": "Live preview · system prompt (role layer)",
    "审批档": "Approval preset",
    "少数意见（原文保留）": "Minority opinions (kept verbatim)",
    "岗位": "Title",
    "岗位名，≤40 字": "Job title, ≤40 chars",
    "工具回执里没有的结果不要声称已完成。":
      "Never claim something is done unless a tool receipt confirms it.",
    "已存档": "Archived",
    "已录用 ": "Hired ",
    "，并录入模板库": " — also saved to the template library",
    "已采纳": "Adopted",
    "已采纳为决策记录": "Adopted as a decision record",
    "已采纳为待办": "Adopted as a to-do",
    "并且**只输出一个 ```json 围栏**，字段：title, question, conclusion, rationale, evidence（数组）, dissent（数组，每项 {role, point, reason}，被否决的反对意见原文保留）, unresolved（数组）, assumptions（数组）, nextActions（数组，每项 {action, owner, due}）, confidence（高 / 中 / 低）。":
      "and **output exactly one ```json fenced block**, with fields: title, question, conclusion, rationale, evidence (array), dissent (array, each {role, point, reason}, keeping rejected dissent verbatim), unresolved (array), assumptions (array), nextActions (array, each {action, owner, due}), confidence (high / medium / low).",
    "建议卡": "Advice card",
    "建议文件：": "Advice file: ",
    "开始和这位专家聊聊你的项目。": "Start chatting with this expert about your project.",
    "开始招聘": "Start hiring",
    "录用失败（配置未就绪）": "Hire failed (config not ready)",
    "彩色 Icon": "Colored icon",
    "待验证假设": "Assumptions to verify",
    "我是谁、服务谁、以什么口吻（≤120 字）":
      "Who you are, who you serve, in what voice (≤120 chars)",
    "手动招聘": "Manual hire",
    "招募专家": "Recruit expert",
    "招聘失败：": "Hiring failed: ",
    "擅长领域": "Expertise areas",
    "擅长领域，用「、」或逗号分隔，3–6 条":
      "Expertise areas, separated by commas, 3–6 items",
    "收敛出建议": "Converge into advice",
    "新专家": "New expert",
    "新对话": "New chat",
    "新项目": "New project",
    "显示名，≤24 字": "Display name, ≤24 chars",
    "智能运行入口未就绪": "Agent run entry not ready",
    "服务商 / 路由": "Provider / route",
    "未命名项目": "Untitled project",
    "未收敛分歧": "Unresolved disagreements",
    "未设模型": "No model set",
    "校验未通过，未写入专家团": "Validation failed — not written to the team",
    "校验清单": "Validation checklist",
    "校验通过，可以录用": "Validation passed — ready to hire",
    "模板库（预置角色）": "Template library (preset roles)",
    "没有依据的数字不要编造；查不到就写「数据库中没有该信息」。":
      "Never invent unsupported numbers; if you can't find it, write \"not in the database\".",
    "没有匹配到被 @ 的专家": "No expert matched the @ mention",
    "没有可发言的专家": "No expert available to speak",
    "没有可用的主持专家": "No facilitator expert available",
    "理由": "Reason",
    "用户": "User",
    "用户(最新)": "User (latest)",
    "目标 Goal": "Goal",
    "目标：": "Goal: ",
    "确认录用": "Confirm hire",
    "立场（支持 / 反对 / 中立 / 有条件的支持）、结论（一句话）、依据（逐条可核验）、风险、代价、置信度（高 / 中 / 低）、待验证假设。":
      "Stance (support / oppose / neutral / conditional support), conclusion (one line), evidence (each verifiable), risks, costs, confidence (high / medium / low), assumptions to verify.",
    "简介：": "Summary: ",
    "约束 Constraints": "Constraints",
    "约束：": "Constraints: ",
    "终止": "Stop",
    "终止当前运行": "Stop the current run",
    "结构、语言、落盘约定（≤100 字）": "Structure, language, file conventions (≤100 chars)",
    "结论": "Conclusion",
    "继承（默认）": "Inherit (default)",
    "缺少会话": "Missing chat",
    "缺少会话或专家": "Missing chat or expert",
    "置信度 ": "Confidence ",
    "职责一句话": "One-line mandate",
    "职责一句话，≤60 字": "One-line mandate, ≤60 chars",
    "背景：": "Background: ",
    "自动招聘": "Auto hire",
    "录用后自动录入模板库（下次可一键套用）":
      "Save the recruited role to the template library automatically (reusable next time)",
    "至少需要 2 位专家才能开圆桌": "At least 2 experts are needed for a roundtable",
    "表达风格": "Style",
    "表达风格：": "Style: ",
    "角色卡解析失败：": "Failed to parse role card: ",
    "让主持人汇总讨论，生成建议卡（不采纳、不执行）":
      "Let the facilitator summarize the discussion and produce an advice card (no adoption, no execution)",
    "该专家使用的服务商": "Provider used by this expert",
    "该专家使用的模型": "Model used by this expert",
    "该画布下还没有专家，点上方 ＋ 招聘。":
      "No experts on this canvas yet — click ＋ above to recruit one.",
    "还没有画布。": "No canvas yet.",
    "语气": "Tone",
    "语气：": "Tone: ",
    "说说你要招什么样的人": "Describe who you want to hire",
    "调用「HR 招聘」提示生成严格 JSON 角色卡；本地校验通过并确认后才写入专家团。":
      "Uses the \"HR recruiter\" prompt to generate a strict JSON role card; it's written to the team only after local validation passes and you confirm.",
    "身份 Identity": "Identity",
    "输出格式 Output": "Output",
    "输出要求：": "Output requirements: ",
    "运行失败": "Run failed",
    "还没有专家：点左栏「专家」旁的 ＋ 新建一位。":
      "No experts yet — click ＋ next to \"Experts\" in the left column to create one.",
    "还没有会话，点左栏角色右侧的「＋」开一段新对话。":
      "No chats yet — click \"＋\" on the right of a role in the left column to start a new chat.",
    "这是第 1 轮独立发言：请独立判断，不要假设别人会说什么，也不要替别人发言。":
      "This is round 1, independent statements: judge independently, don't assume what others will say, and don't speak for others.",
    "这类任务的默认成功标准（≤100 字）": "Default success criteria for such tasks (≤100 chars)",
    "采纳为决策记录": "Adopt as decision record",
    "采纳并生成待办": "Adopt and create to-dos",
    "重发上一条消息": "Resend the last message",
    "重新生成": "Regenerate",
    "长度预算": "Length budget",
    "需用户确认：": "Needs user approval: ",
    "项目没有可用工作区，无法写入建议文件":
      "The project has no usable workspace — cannot write the advice file",
    "项目没有可用工作区，无法采纳": "The project has no usable workspace — cannot adopt",
    "预设档": "Preset",
    "（填写后自动生成）": "(generated once filled in)",
    "（未接通文件写入，无法落盘建议）": "(file writing not wired — cannot save advice)",
    "（未接通文件写入，无法采纳）": "(file writing not wired — cannot adopt)",
    "（未接通智能引擎，无法回复）": "(agent engine not wired — cannot reply)",
    "（未接通群聊引擎）": "(group chat engine not wired)",
    /* ── 一人公司 / 专家团：顶栏视图按钮与团队面板（renderer/index.html） ── */
    "团队": "Team",
    "专家团": "Expert team",
    "专家团：按画布管理专家，与专家对话":
      "Expert team: manage experts per canvas and chat with them",
    "一人公司": "One-person company",
    "一人公司：按项目管理专家，与专家对话（专家团）":
      "One-person company: manage experts per project and chat with them",
    "为当前专家新建会话": "New chat with the current expert",
    "项目": "Projects",
    "新建专家": "New expert",
    "新建群聊（圆桌：多位专家依次发言）":
      "New group chat (roundtable: experts speak in turn)",
    "新建群聊（圆桌：主持人挑人、专家并行作答）":
      "New group chat (roundtable: facilitator picks participants, experts answer in parallel)",
    "给专家发消息…（Enter 发送，Shift+Enter 换行）":
      "Message the expert… (Enter to send, Shift+Enter for newline)",
    /* ── 一人公司：分类树 + 自定义模板（本轮新增） ── */
    "新建分类": "New category",
    "新分类名称（≤12 字）": "New category name (≤12 chars)",
    "例如：产品 / 技术 / 商业 / 增长":
      "e.g. Product / Tech / Business / Growth",
    "所属分类": "Category",
    "左侧栏按分类树状分组；可选「＋ 新建分类」":
      "The left sidebar groups experts by category; pick \"+ New category\" to add one",
    "未分类": "Uncategorized",
    "＋ 新建分类…": "+ New category…",
    "该专家所属分类": "Category this expert belongs to",
    "删除这个分类（专家回到未分类）":
      "Delete this category (experts move to Uncategorized)",
    "删除分类「": "Delete category \"",
    "」？该分类下的专家会回到「未分类」，不会被删除。":
      "\"? Experts in it move to \"Uncategorized\" and are not deleted.",
    "新建模板": "New template",
    "从空白表单新建一个自定义模板":
      "Start a custom template from a blank form",
    "删除这个自定义模板": "Delete this custom template",
    "删除模板": "Delete template",
    "删除模板「": "Delete template \"",
    "」？已录用的专家不受影响。": "\"? Hired experts are unaffected.",
    "存为模板": "Save as template",
    "把当前表单保存成自定义模板，下次可一键套用":
      "Save this form as a custom template for one-click reuse later",
    "校验未通过，未存为模板":
      "Validation failed — not saved as a template",
    "模板存储未就绪": "Template storage is not ready",
    "模板保存失败": "Failed to save the template",
    "已存为模板：": "Saved as template: ",
    /* ── 一人公司：画布锚点 / 图标目录与选择器 / 分类管理（本轮新增） ── */
    "【画布】": "[Canvas] ",
    "分类管理": "Category management",
    "管理分类": "Manage categories",
    "已有同名分类": "A category with this name already exists",
    "改名或删除已有分类（新建 / 删除都在这里）":
      "Rename or delete existing categories (create and delete both happen here)",
    "还没有分类，点左下「＋ 新建分类」建一个。":
      "No categories yet — click \"+ New category\" at the bottom left to add one.",
    "新的分类名称（≤12 字）": "New category name (≤12 chars)",
    /* 图标目录（app-team-icons.js）：分组名 + 图标标签 */
    "角色": "Role",
    "角色扮演": "Role-play",
    "研发": "Engineering",
    "数据": "Data",
    "运维": "Ops",
    "设计": "Design",
    "商业": "Business",
    "人物": "Person",
    "负责人": "Lead",
    "战略": "Strategy",
    "沟通": "Chat",
    "安全": "Security",
    "法务": "Legal",
    "商务": "Business",
    "猫娘": "Catgirl",
    "倾听": "Listener",
    "深夜": "Late night",
    "元气": "Cheerful",
    "代码": "Code",
    "调试": "Debug",
    "服务器": "Server",
    "云": "Cloud",
    "算力": "Compute",
    "移动端": "Mobile",
    "前端": "Frontend",
    "部署": "Deploy",
    "柱状图": "Bar chart",
    "趋势": "Trend",
    "表格": "Table",
    "筛选": "Filter",
    "统计": "Statistics",
    "分析": "Analysis",
    "配置": "Config",
    "监控": "Monitoring",
    "网络": "Network",
    "密钥": "Key",
    "时效": "Timing",
    "迭代": "Iteration",
    "告警": "Alerts",
    "写作": "Writing",
    "布局": "Layout",
    "视觉": "Visual",
    "字体": "Typography",
    "财务": "Finance",
    "预算": "Budget",
    "增长": "Growth",
    "本地化": "Localization",
    "排期": "Schedule",
    "检索": "Search",
    "创意": "Ideas",
    "邮件": "Email",
    "品牌": "Brand",
    /* 图标选择器 */
    "选择图标": "Choose icon",
    "展开图标": "Expand icons",
    "收起图标": "Collapse icons",
    "点击展开 / 收起图标网格": "Click to expand / collapse the icon grid",
    "按语义分组的图标网格": "Icon grid grouped by meaning",
    /* 建议落盘（画布工作区不可用时） */
    "画布没有可用工作区，无法写入建议文件":
      "The canvas has no usable workspace — cannot write the advice file",
    "画布没有可用工作区，无法采纳":
      "The canvas has no usable workspace — cannot adopt",
    /* ── AI团队：改名 / 画布锚点移除 / 模型控制区 / 结构化专家卡（本轮新增） ── */
    "AI团队": "AI team",
    "AI团队：按画布管理专家，与专家对话（专家团）":
      "AI team: manage experts per canvas and chat with them (expert team)",
    "移除团队": "Remove team",
    "移除该画布的团队（专家与会话一并删除）":
      "Remove this canvas's team (experts and chats are deleted too)",
    "移除画布「": "Remove the team for canvas \"",
    "」的团队？该画布下的专家与会话将一并删除。":
      "\"? Its experts and chats will be deleted too.",
    /* ── 团队：标题=当前画布 / 增量复制到其他画布（本轮新增） ── */
    "团队：按画布管理专家，与专家对话（专家团）":
      "Team: manage experts per canvas and chat with them (expert team)",
    "当前画布：": "Current canvas: ",
    "复制团队到其他画布": "Copy team to another canvas",
    "把当前画布的团队（专家、会话、招聘草稿）复制到另一张画布。仅增量复制：只追加，不删除、不覆盖目标画布已有内容；当前画布不受影响。":
      "Copy the current canvas's team (experts, chats, recruit drafts) to another canvas. Incremental only: it appends — nothing on the target canvas is deleted or overwritten, and the current canvas is untouched.",
    "正在读取画布列表…": "Reading the canvas list…",
    "没有其他画布可复制。先新建一张画布再来。":
      "No other canvas to copy to. Create a canvas first.",
    "当前画布还没有可复制的团队内容":
      "The current canvas has no team content to copy",
    /* 切画布时的团队加载屏（防串线） */
    "正在切换画布…": "Switching canvas…",
    "已复制到「": "Copied to \"",
    "：专家 ": ": experts ",
    " 位、会话 ": " experts, ",
    " 个会话": " chats",
    /* ── 团队：删除专家（保留会话）/ 删除会话 / 孤儿会话（本轮新增） ── */
    "删除该专家（保留其会话）": "Delete this expert (keep its chats)",
    "删除专家": "Delete expert",
    "删除专家「{name}」？其 {n} 个会话会保留（专家已删除，仅可回看），避免信息丢失。":
      "Delete the expert \"{name}\"? Its {n} chat(s) will be kept (marked deleted-expert, view-only) so nothing is lost.",
    "删除专家「{name}」？该操作不可恢复。":
      "Delete the expert \"{name}\"? This cannot be undone.",
    "已删除专家「{name}」，{n} 个会话已保留（仅可回看）":
      "Deleted expert \"{name}\"; {n} chat(s) kept (view-only)",
    "已删除专家「{name}」": "Deleted expert \"{name}\"",
    "删除该会话": "Delete this chat",
    "删除会话「{title}」？聊天记录会一并删除，且不可恢复。":
      "Delete the chat \"{title}\"? Its messages will be deleted permanently.",
    "已删除会话「{title}」": "Deleted chat \"{title}\"",
    "专家已删除": "Expert deleted",
    "原专家：": "Former expert: ",
    "原专家已删除": "The original expert was deleted",
    " · 仅可回看历史": " · history is view-only",
    "专家已删除 · 仅可回看历史，无法继续对话":
      "Expert deleted · history is view-only; this chat cannot continue",
    "该会话的专家已删除，只能回看历史":
      "This chat's expert was deleted — only its history can be viewed",
    "专家已删除，只能回看历史": "Expert deleted — only history can be viewed",
    "向圆桌提问：主持人为本轮挑选相关专家（不全员），被选中的专家并行独立作答，再由主持人 AI 汇总；也可以 @某位专家定向提问，或点「收敛出建议」。":
      "Ask the roundtable: the facilitator picks relevant experts for this round (never everyone), they answer independently in parallel, and the facilitator AI summarizes; you can also @ an expert for a targeted question, or click \"Converge into advice\".",
    "你只做文本工作：不读写文件、不操作画布。工具回执里没有的结果不要声称已完成。":
      "You only do text work: no reading or writing files, no canvas actions. Never claim something is done unless a tool receipt confirms it.",
    /* 专家卡（app-team-recruit.js renderExpertCard / app-teamview.js 折叠区） */
    "专家卡": "Expert card",
    "实时预览 · 专家卡": "Live preview · expert card",
    "✎ 可编辑设定与权限": "✎ Editable settings & permissions",
    "✎ 编辑": "✎ Edit",
    "编辑该专家的设定与权限": "Edit this expert's settings and permissions",
    "编辑入口未就绪": "Edit entry is not ready",
    "编辑专家": "Edit expert",
    "已保存专家设定": "Expert settings saved",
    "校验未通过，未保存修改": "Validation failed; changes were not saved",
    "专家存储未就绪": "Expert store is not ready",
    "保存失败（专家已不存在）": "Save failed (expert no longer exists)",
    "专家卡渲染失败。": "Failed to render the expert card.",
    "④ 权限": "④ Permissions",
    "（未填岗位）": "(no title)",
    "基本信息": "Basic info",
    "图标": "Icon",
    "人设": "Persona",
    "简介": "Summary",
    "背景": "Background",
    "专长": "Expertise",
    "提示词": "Prompt",
    "身份": "Identity",
    "约束": "Constraints",
    "温度": "Temperature",
    /* ── 一人公司：内置专家模板名与岗位（app-team-recruit.js） ── */
    "研究分析师": "Research analyst",
    "资料研究员": "Research specialist",
    "技术文档工程师": "Technical writer",
    "代码评审员": "Code reviewer",
    "产品经理": "Product manager",
    "数据分析师": "Data analyst",
    "系统架构师": "Systems architect",
    "测试工程师": "QA engineer",
    "QA / 测试工程师": "QA / test engineer",
    "交互设计师": "Interaction designer",
    "UX / 交互设计师": "UX / interaction designer",
    "文案撰写": "Copywriter",
    "内容 / 文案撰写": "Content / copywriting",
    "译者": "Translator",
    "本地化译者": "Localization translator",
    "提示词工程师": "Prompt engineer",
    "运维执行": "SRE / Ops",
    "运维 / SRE 工程师": "Ops / SRE engineer",
    "事实库管理员": "Knowledge base curator",
    "画布编排师": "Canvas orchestrator",
    "项目经理": "Project manager",
    "项目经理 / 交付": "Project manager / delivery",
    "前端工程师": "Frontend engineer",
    "后端工程师": "Backend engineer",
    "全栈工程师": "Full-stack engineer",
    "移动端工程师": "Mobile engineer",
    "UI 设计师": "UI designer",
    "视觉 / 品牌设计": "Visual / brand designer",
    "视觉 / 品牌设计师": "Visual / brand designer",
    "安全工程师": "Security engineer",
    "DBA": "Database administrator",
    "数据库管理员": "Database administrator",
    "数据工程师": "Data engineer",
    "算法 / AI 工程师": "Algorithm / AI engineer",
    "API 设计师": "API designer",
    "DevOps 工程师": "DevOps engineer",
    "DevOps / CI 工程师": "DevOps / CI engineer",
    "增长负责人": "Growth lead",
    "市场负责人": "Marketing lead",
    "运营负责人": "Operations lead",
    "法务顾问": "Legal counsel",
    "财务顾问": "Finance advisor",
    "HR / 招聘": "HR / Recruiting",
    "HR / 招聘负责人": "HR / recruiting lead",
    "客服 / 支持": "Customer support",
    "客服 / 技术支持": "Customer / technical support",
    "商业分析师": "Business analyst",
    "商业 / 竞品分析师": "Business / competitor analyst",
    /* ── 一人公司：角色扮演类（情绪价值 / 陪伴）模板名与岗位 ── */
    "猫娘小爪": "Catgirl Paw",
    "情绪陪伴（猫娘）": "Emotional companion (catgirl)",
    "树洞": "Tree Hollow",
    "情绪倾听者": "Emotional listener",
    "深夜电台": "Late-night radio",
    "深夜陪伴主播": "Late-night companion host",
    "元气搭子": "Cheer buddy",
    "打气搭子": "Cheerleader buddy",
    /* ── 审阅（富文本 Markdown 审阅 / 批注修订） ── */
    "审阅": "AI Review",
    "让 AI 依据批注修订": "Ask AI to revise from annotations",
    "采用当前版并写回节点": "Apply this version back to node",
    "回滚到此版": "Roll back to this version",
    "已回滚作废（仅可回看）": "Discarded by rollback (view only)",
    "作废版本 · 仅可回看": "Discarded version · view only",
    "已绑定局部批注": "Local annotation attached",
    "已生成修订版，可继续批注下一轮": "New revision generated — annotate the next round",
    "修订失败：": "Revision failed: ",
    "全文批注": "Full-text annotation",
    "局部": "Local",
    "局部批注": "Local annotation",
    "原文 / 全文批注": "Full",
    "输入批注内容…": "Type your annotation…",
    "批注内容": "Annotation content",
    "添加批注": "Add annotation",
    "对整个文档附加一条批注": "Attach a note to the whole document",
    "在正文中拖选文字可添加局部批注": "Drag to select text to attach a local note",
    "局部批注已开启，拖选正文即可添加": "Local annotation is on — drag to select text to attach",
    "插入链接": "Insert link",
    "回滚版本": "Roll back version",
    "绑定批注": "Attach",
    "历史全部批注": "All annotations across rounds",
    "当前全文": "Current full text",
    "已写回节点文本，请重新运行下游使其重算": "Written back to the node — re-run downstream to recompute",
    "字数：": "Chars: ",
    "字符（不含空白）": "Non-whitespace chars",
    "该编辑操作在当前浏览器不受支持": "This editing action is not supported in your browser",
    "请先等该节点运行完成再审阅": "Wait for the node to finish running before reviewing",
    "该节点还没有文本输出，请先运行一次再审阅": "No text output yet — run the node once first",
    /* ── 审阅：事实库目标（app-review.js · openFactReview） ── */
    "事实库": "Fact library",
    "事实库模块未就绪，无法打开审阅": "Fact library module is not ready — cannot open review",
    "该事实库还没有正文文件，请先在团队里建库":
      "This fact library has no body file yet — create it in Team first",
    "该事实库正文为空，请先写入内容再审阅":
      "This fact library body is empty — write something before reviewing",
    "（无可用文本服务商）": "(no text provider available)",
    "（自定义）": " (custom)",
    "锚点文字已变更，批注可能失效": "Anchor text changed — annotation may be stale",
    /* ── 团队事实库（app-factlib.js / app-team.js / app-teamview.js / app-review.js） ── */
    "团队事实库": "Team fact library",
    "> 本文件是团队共享的事实库，可手动编辑；团队成员在回答事实性问题前会先查阅这里。":
      "> This file is the team's shared fact library. You may edit it by hand; team members consult it before answering factual questions.",
    "事实": "Facts",
    "团队事实库（本团队共享的事实来源，用文件读取工具查阅）：":
      "Team fact library (this team's shared source of facts; consult it with the file-reading tool):",
    "事实库图片目录：": "Fact library image folder: ",
    "回答事实性问题前，先读取上述文件，以库中记录为准；库中没有的内容不得编造，应直说「事实库中没有该信息」或请用户补充。":
      "Before answering factual questions, read the file above and rely on what it records; never invent anything the library does not contain — say \"the fact library has no such information\" or ask the user to add it.",
    "团队事实库（本团队共享的事实来源；正文按需用文件读取工具查阅，不要凭空作答）：":
      "Team fact library (this team's shared source of facts; read the relevant file with the file-reading tool on demand — never answer from memory):",
    "事实库目录（新文档写这里）：": "Fact library folder (write new documents here): ",
    "共享图片目录（全部文档共用）：": "Shared image folder (used by every document): ",
    "查阅与建档纪律：": "Consultation and record-keeping rules:",
    "① 回答事实性问题前，先读上面最相关的那一篇文档，以库中记录为准；库中没有的内容不得编造。":
      "① Before answering a factual question, read the most relevant document above and rely on what it records; never invent content the library does not contain.",
    "② 库中信息不足时，再查阅项目内容（工作区文件）补充。":
      "② If the library is insufficient, consult the project content (workspace files) for more.",
    "③ 仍不足时，明确告知「事实库中没有该信息」，并请用户补充或确认建档 —— 不得凭记忆或推测作答。":
      "③ If it is still insufficient, state plainly \"the fact library has no such information\" and ask the user to add or confirm it — never answer from memory or guesswork.",
    "④ 对话中发现稳定事实要同步维护事实库：新主题新建独立文档（文档间内容不重叠、各司其职），已有主题就地更新对应文档；正文写进文档，不要塞进提示词。":
      "④ When a stable fact turns up in the conversation, maintain the library at once: create a separate document for a new topic (documents must not overlap; each has its own job) and update the existing document in place for a known topic. Put the body in the document, not in the prompt.",
    "事实库目录对你有写权限：新建 / 更新文档直接写入上述路径；若首次写入被沙箱拒绝，按工具提示用 sandbox_permissions + justification 原样重试一次即可（该目录已获授权，不会打扰用户）。":
      "You have write access to the fact library folder: create or update documents directly at the paths above. If the first write is denied by the sandbox, retry the same call once with sandbox_permissions + justification as the tool instructs (this folder is already authorized, so the user will not be interrupted).",
    "引用图片时按 md 里的相对路径引用，不要改写成本机绝对路径。":
      "When referencing images, use the relative paths written in the Markdown; never rewrite them as absolute local paths.",
    "事实库名称": "Fact library name",
    "重命名事实库": "Rename fact library",
    "例如：产品事实库": "e.g. Product fact library",
    "已重命名事实库": "Fact library renamed",
    "删除事实库": "Delete fact library",
    "删除事实库「{name}」？正文、批注与插图会一并移入系统回收站（可在资源管理器里还原）。":
      "Delete the fact library \"{name}\"? Its body, annotations and images will be moved to the system recycle bin (you can restore them from File Explorer).",
    "已删除事实库": "Fact library deleted",
    "已删除事实库「{name}」（进系统回收站）":
      "Fact library \"{name}\" deleted (moved to the system recycle bin)",
    "删除该事实库（移入系统回收站）": "Delete this fact library (move to the system recycle bin)",
    "事实库创建失败": "Failed to create the fact library",
    /* 事实库落点：画布文件夹（app-team.js factWorkspace）+ 应用目录 / 项目源码目录守卫（app-factlib.js / main.js） */
    "选择画布文件夹（团队事实库将建在此目录下的「团队事实库」文件夹里）":
      "Choose the canvas folder (the team fact library will be created in a \"团队事实库\" folder under it)",
    "画布文件夹": "Canvas folder",
    "事实库目录不能落在应用目录内": "The fact library folder cannot live inside the application directory",
    "事实库目录不能落在项目源码目录内（应放在画布文件夹）":
      "The fact library folder cannot live inside the project source folder — it belongs in the canvas folder",
    /* 历史错位修复：库落在应用文件夹 / 项目源码目录 → 用户确认后迁回画布文件夹（app-factlib.js relocateLibrary / main.js fact:relocateLibrary） */
    "事实库当前位于应用文件夹内，应用升级或卸载会丢失。":
      "The fact library currently sits inside the application folder and would be lost on upgrade or uninstall.",
    "事实库当前位于项目源码目录内（旧版跟着画布项目根走的落点）。":
      "The fact library currently sits inside the project source folder (an old location that followed the canvas project root).",
    "是否迁移到画布文件夹？": " Move it to the canvas folder?",
    "移动事实库": "Move fact library",
    "迁移": "Move",
    "保持不动": "Keep it where it is",
    "事实库迁移失败": "Failed to move the fact library",
    "事实库已迁移到画布工作目录": "Fact library moved to the canvas working directory",
    "事实库已改用画布文件夹中已有的库":
      "The fact library now uses the existing one in the canvas folder",
    "当前没有画布，无法创建事实库": "No canvas is open — cannot create a fact library",
    "审阅模块未就绪，无法打开事实库":
      "Review module is not ready — cannot open the fact library",
    "打开所在文件夹": "Show in folder",
    "未建库": "Not created",
    "{n} 篇": "{n} docs",
    "新建文档": "New document",
    "文档名称": "Document name",
    "重命名文档": "Rename document",
    "删除文档": "Delete document",
    "删除文档「{name}」？正文、批注与插图会移入系统回收站（可在资源管理器里还原）。":
      "Delete the document \"{name}\"? Its body, annotations and images will be moved to the system recycle bin (you can restore them from File Explorer).",
    "已新建文档「{name}」": "Document \"{name}\" created",
    "已重命名文档": "Document renamed",
    "已删除文档": "Document deleted",
    "已删除文档「{name}」（进系统回收站）":
      "Document \"{name}\" deleted (moved to the system recycle bin)",
    "删除该文档（移入系统回收站）": "Delete this document (move to the system recycle bin)",
    "新建文档失败": "Failed to create the document",
    "例如：产品规格": "e.g. Product spec",
    "由专家建档或手动新建": "Created by an expert or add one manually",
    "该文档还没有正文文件": "This document has no body file yet",
    "事实库未就绪": "Fact library is not ready",
    "文档不存在": "Document not found",
    "无法重命名": "Cannot rename",
    "无法删除": "Cannot delete",
    "事实库模块未就绪，无法新建文档":
      "Fact library module is not ready — cannot create a document",
    "事实库模块未就绪，无法重命名文档":
      "Fact library module is not ready — cannot rename the document",
    "事实库模块未就绪，无法删除文档":
      "Fact library module is not ready — cannot delete the document",
    /* ── AI 事实库（renderer/app-ai-facts.js）· 左栏入口 + 查阅弹窗 ──
       与团队事实库（人读 md）是两套独立存储：这里是「给 AI 读的极简条例」，
       落 <画布文件夹>/团队事实库/AI/ai-facts.json；口径见 docs/fact-library.md 与本模块文件头。 */
    "AI 事实库": "AI fact library",
    "{n} 条": "{n} items",
    "AI 事实库还不可用": "The AI fact library is not available yet",
    "先在左侧选中一张画布（AI 事实库一张画布一份），再来建库。":
      "Select a canvas on the left first (one AI fact library per canvas), then create the library.",
    "AI 事实库模块未就绪，无法打开":
      "AI fact library module is not ready — cannot open it",
    /* app-db.js handleAiFactsToolEvent 的两条：模块未装载时回给 AI 的错误文本。 */
    "AI 事实库模块未就绪（app-ai-facts.js）":
      "AI fact library module is not ready (app-ai-facts.js)",
    "AI 事实库写入失败": "Failed to write the AI fact library",
    "AI 事实库中没有该条例：": "No such entry in the AI fact library: ",
    "当前没有绑定画布": "No canvas is bound",
    "未知动作：": "Unknown action: ",
    "写入需要给出 records 或 record（标题或正文不能都为空）":
      "write needs records or record (title and body cannot both be empty)",
    "选择画布文件夹（AI 事实库将建在此目录下的「团队事实库/AI」里）":
      "Choose the canvas folder (the AI fact library is created in its \"团队事实库/AI\" subfolder)",
    "选择画布文件夹…": "Choose canvas folder…",
    "这张画布还没有画布文件夹（顶栏「工作目录」为空）。先选一个文件夹，AI 事实库就会建在它的「团队事实库/AI」里。":
      "This canvas has no folder yet (the top bar's \"Workspace\" is empty). Pick a folder first — the AI fact library is then created in its \"团队事实库/AI\" subfolder.",
    "条数 {n} / 上限 {cap}": "{n} entries / cap {cap}",
    "上限": "Cap",
    "上限（超出后先淘汰未固定 pin 的低分条例；固定（★）的永不淘汰）":
      "Cap (when exceeded, unpinned low-score entries are evicted first; pinned ★ entries are never evicted)",
    "上限必须是 1–1000 之间的整数": "The cap must be an integer between 1 and 1000",
    "上限已改为 {cap}": "Cap changed to {cap}",
    "上限已改为 {cap}，淘汰 {n} 条低分条例":
      "Cap changed to {cap}; evicted {n} low-score entries",
    "固定（pin）的条例已占满上限（{cap}），超额条目保留不再淘汰":
      "Pinned entries already fill the cap ({cap}); the extras are kept and nothing is evicted",
    "搜索条例（标题或正文）…": "Search entries (title or body)…",
    "＋ 新建条例": "＋ New entry",
    "标题（一行，便于检索）": "Title (one line, easy to search)",
    "正文（给 AI 读的极简条例，一行到几行）":
      "Body (a minimal entry for the AI to read — one to a few lines)",
    "标题或正文不能都为空": "Title and body cannot both be empty",
    "命中 {n}": "hits {n}",
    "分数 {n}": "score {n}",
    "固定这条（永不淘汰，也不受上限影响）":
      "Pin this entry (never evicted, not subject to the cap)",
    "取消固定（允许按分数淘汰）": "Unpin (allow eviction by score)",
    "删除条例": "Delete entry",
    "删除条例「{title}」？删除后不可恢复。":
      "Delete the entry \"{title}\"? This cannot be undone.",
    "已保存条例": "Entry saved",
    "已更新同名条例": "Updated the existing entry with the same title",
    "已删除条例": "Entry deleted",
    "还没有条例": "No entries yet",
    "没有匹配的条例": "No matching entries",
    "换个关键词，或清空搜索框看全部。":
      "Try another keyword, or clear the search box to see everything.",
    "Agent 在建架构 / 建工作流时会自动把关键结论沉淀成极简条例；也可以在这里手动新增。":
      "The agent distils key conclusions into minimal entries while building architecture or workflows; you can also add one here by hand.",
    /* ── AI 事实库（补充口径）：类型 / 标签 / 来源 · 待确认（AI propose + 用户 confirm）·
       零命中 7 天保护期 · 写 +0.5 权重 · 最近淘汰回看 · 导出 ── */
    "类型（架构 / 约定 / 命令 / 坑…）":
      "Type (architecture / convention / command / pitfall…)",
    "标签（逗号分隔，最多 8 个）": "Tags (comma-separated, up to 8)",
    "来源（哪份文件 / 哪次确认）": "Source (which file / which confirmation)",
    "权重 {n}": "weight {n}",
    "零命中保护期（剩 {n} 天）": "New-entry protection ({n} days left)",
    "另有 {n} 条处于零命中保护期（{days} 天内不淘汰）":
      "{n} more entries are inside the zero-hit protection window (kept for {days} days)",
    "正文超过约 {n} 字，建议精简成一句能传意的话":
      "The body is longer than ~{n} characters — consider trimming it to one meaningful sentence",
    "有 {n} 条条例正文超过约 200 字，建议精简成一句能传意的话（已照常保存）：":
      "{n} entries have a body longer than ~200 characters — consider trimming each to one meaningful sentence (saved as is): ",
    "待确认": "Pending",
    "待确认 {n} 条": "{n} pending",
    "待确认（{n} 条 AI 提议）": "Pending ({n} AI proposals)",
    "待确认的提议已超过 {cap} 条，请先确认或清掉一些":
      "More than {cap} proposals are pending — confirm or clear some first",
    "AI 提议": "AI proposal",
    "确认这条 AI 提议，收进库里": "Accept this AI proposal into the library",
    "驳回这条提议（直接删掉）": "Reject this proposal (it is deleted)",
    "驳回": "Reject",
    "全部确认": "Accept all",
    "把待确认区里的提议全部收进库": "Accept every proposal in the pending area",
    "全部驳回": "Reject all",
    "已确认该条例": "Entry accepted",
    "已确认 {n} 条提议": "Accepted {n} proposals",
    "已驳回该提议": "Proposal rejected",
    "已清空待确认区": "Pending area cleared",
    "最近淘汰（{n} 条）": "Recently evicted ({n})",
    "导出 AI 事实库": "Export the AI fact library",
    "导出…": "Export…",
    "把整库另存成一份 JSON（备份 / 迁移用）":
      "Save the whole library as a JSON file (for backup / migration)",
    "已导出到 {file}": "Exported to {file}",
    "导出失败": "Export failed",
    "库还是空的，没有可导出的条例": "The library is still empty — nothing to export",
    "请给出画布文件夹的绝对路径": "Give an absolute path for the canvas folder",
    "update 需要给出 id": "update needs an id",
    /* ── 审阅：插图 / 插表格（app-review.js 事实库与节点的共用工具栏） ── */
    "插入图片": "Insert image",
    "插入表格": "Insert table",
    "图片已插入": "Image inserted",
    "图片会复制到事实库的 assets 目录，正文以相对路径引用":
      "The image is copied into the fact library's assets folder and referenced by a relative path",
    "图片以本机绝对路径引用": "The image is referenced by its absolute local path",
    "选择图片文件…": "Choose an image file…",
    "从本机选择 png / jpg / webp / gif / bmp":
      "Pick a png / jpg / webp / gif / bmp from this computer",
    "选择图片": "Choose image",
    "从剪贴板粘贴（截图）": "Paste from clipboard (screenshot)",
    "复制图片或截图后点这里": "Copy an image or take a screenshot, then click here",
    "剪贴板里没有图片": "No image in the clipboard",
    "事实库模块未就绪，无法插入图片":
      "Fact library module is not ready — cannot insert images",
    "图片保存失败：": "Failed to save the image: ",
    "该目标不支持从剪贴板插入图片，请选择本机图片文件":
      "This target does not support pasting images from the clipboard — choose a local image file instead",
    "已从磁盘删除 ": "Deleted from disk ",
    " 个无引用图片": " unreferenced image(s)",
    "输入行数与列数（含表头行）":
      "Enter the number of rows and columns (header row included)",
    "行数": "Rows",
    "列数": "Columns",
    "列": "Column ",
    /* ── 审阅：公式录入（renderer/math-render.js · 工具栏 $ / $$ 与对话框） ── */
    "行内公式": "Inline formula",
    "显示公式": "Display formula",
    "插入行内公式": "Insert inline formula",
    "插入显示公式": "Insert display formula",
    "公式（LaTeX）": "Formula (LaTeX)",
    "输入 LaTeX 公式，支持上下标、分式、根号、希腊字母、矩阵与 \\text":
      "Enter a LaTeX formula — sub/superscripts, fractions, radicals, Greek letters, matrices and \\text are supported",
    "插入公式": "Insert formula",
    "公式已插入": "Formula inserted",
    /* ── 文件查看：工具条文件徽标 + 右侧只读预览面板（app-fileview.js） ── */
    "文件查看": "File viewer",
    "读": "Read",
    "改": "Write",
    "折行": "Wrap",
    "不换行": "No wrap",
    "复制内容": "Copy content",
    "复制路径": "Copy path",
    "在资源管理器中显示": "Show in Explorer",
    "重新加载": "Reload",
    "拖拽左边缘调整宽度": "Drag the left edge to resize",
    "已复制文件内容": "File content copied",
    "已复制文件路径": "File path copied",
    "没有可复制的内容": "Nothing to copy",
    "没有可预览的内容": "Nothing to preview",
    "无法定位该文件的完整路径，只给你看文件名":
      "Cannot resolve the full path of this file — showing the name only",
    "这个会话还没解析出工作目录，只给你看文件名":
      "No workspace resolved for this session — showing the name only",
    "找不到这个文件（不在当前工作目录里）":
      "File not found (it is not in the current working directory)",
    " 个文件，点击展开": " more files — click to expand",
    "当前环境读不到文件": "Files cannot be read in this environment",
    "文件是空的": "The file is empty",
    "文件过大（": "File too large (",
    "），预览上限 ": "), preview limit ",
    "；请用「在资源管理器中显示」交给外部编辑器":
      "; use \"Show in Explorer\" to hand it to an external editor",
    "只显示前 ": "Showing only the first ",
    "（共 ": " (of ",
    "文件较大，已关闭语法着色只出纯文本":
      "Large file — syntax coloring off, plain text only",
    "这看起来是个二进制文件，没有做预览": "This looks like a binary file — no preview",
    "文件不存在或读不到（可能已被删除 / 改名）":
      "File missing or unreadable (maybe deleted / renamed)",
    "这个文件现在还不存在（工具可能还没写完，或写的是别的路径）":
      "This file does not exist yet (the tool may not have written it, or wrote another path)",
    "图片显示不出来（格式不支持或文件读不到）":
      "Image cannot be shown (unsupported format or unreadable file)",
    "读目录失败：": "Failed to read the directory: ",
    "目录里没有文件（空目录，或只有被忽略的隐藏 / 重型目录）":
      "No files in this directory (empty, or only ignored hidden / heavy directories)",
    "个条目": " entries",
    "过滤条目…": "Filter entries…",
    "没有匹配的条目": "No matching entries",
    "还有 ": "Plus ",
    " 条没列出，继续输入可过滤": " more not listed — keep typing to filter",
    "递归列表：只列文件，已跳过隐藏项与 node_modules / .git":
      "Recursive listing: files only, hidden items and node_modules / .git skipped",
    /* 面板里的编辑态（app-fileview.js：进编辑 → 改 → 保存 / 撤销重做；未保存先问一句） */
    "未保存的修改": "Unsaved changes",
    "放弃改动": "Discard changes",
    "有未保存的修改，换文件会丢弃这些改动。":
      "This file has unsaved changes — switching files discards them.",
    "有未保存的修改，重新加载会丢弃这些改动。":
      "This file has unsaved changes — reloading discards them.",
    "有未保存的修改，关闭面板会丢弃这些改动。":
      "This file has unsaved changes — closing the panel discards them.",
    "有未保存的修改，退出编辑会丢弃这些改动。":
      "This file has unsaved changes — leaving edit mode discards them.",
    "文件已被修改": "File changed on disk",
    "这个文件在打开后被别的程序改过，保存会覆盖对方的改动。":
      "This file changed on disk after it was opened — saving overwrites those changes.",
    "仍然覆盖": "Overwrite anyway",
    "当前环境写不了文件": "Files cannot be written in this environment",
    /* ── 全部终止 / 媒体生成排队 ── */
    "已终止（排队中的生成任务已取消）": "Cancelled (queued generation dropped)",
    "已终止（后端生成任务已取消）": "Cancelled (backend generation stopped)",
    "后端生成中": "Backend generating",
    " 个生成任务": " generation jobs",
    " 个定时": " timers",
    "已开启：节点完成后自动执行下游":
      "On: finishing a node now auto-runs its downstream",
    "已关闭：节点完成后不再自动执行下游":
      "Off: finishing a node no longer auto-runs downstream nodes",
    /* ── 会话发送队列 ── */
    "发送队列": "Outbox",
    " 条（当前任务结束后依次发送）": " queued (sent after the current run)",
    "已加入发送队列，当前任务继续执行":
      "Queued — the running task was not interrupted",
    "移出队列": "Remove from queue",
    "加入发送队列（不打断当前任务）":
      "Add to send queue (does not interrupt the current run)",
    /* ── 轮内插话 / 暂停（会话运行中的 ⚡插话 · ⏸暂停 · ▶ 继续） ──
       「送不进去」分两种口径，文案也必须分开：
       · unsupported = 引擎本身没有这枚能力（老网关 / 老运行时）→ 键置灰但留在原地，
         按下去等于「加入发送队列」，tooltip 把原因说清楚；
       · 其它失败（这一轮刚好已经结束 / 超时没回音）= 只是这一枪没赶上，
         同样回落队列，一个字都不丢。 */
    "插话": "Steer",
    "⚡ 插话": "⚡ Steer",
    "⏸ 暂停": "⏸ Pause",
    "⏸ 正在暂停": "⏸ Pausing",
    "继续": "Continue",
    "已暂停": "Paused",
    " 已暂停": " paused",
    "插话：本轮下一步就听见（不打断当前这一步）":
      "Steer: the running turn hears it at its next step (without interrupting the current one)",
    "已插话 · 将在下一步生效": "Steered · applies at the next step",
    "已注入本轮": "Injected into this run",
    "运行时已把这句话拼进本轮的收件箱（下一步就读到）":
      "The runtime spliced it into this run's inbox — it gets read at the next step",
    "已递交给正在跑的这一轮，在下一步边界生效；送不进去时自动改走发送队列":
      "Handed to the run in progress, taking effect at its next step boundary; if it cannot be delivered, it goes to the send queue instead",
    "当前引擎不支持轮内插话（已改走发送队列）":
      "This engine can't steer mid-run (messages go through the send queue)",
    "当前引擎不支持轮内插话，已按排队发送":
      "This engine can't steer mid-run — sent as a queued message instead",
    "插话没赶上这一轮，已加入发送队列":
      "The run was already past its last step — the message went to the send queue",
    "暂停本轮（保留上下文，可继续）":
      "Pause this run (context kept, you can continue)",
    "当前引擎不支持暂停（可用 ■ 终止这一轮）":
      "This engine can't pause (use ■ to stop this run)",
    "当前版本不支持暂停，可用 ■ 终止这一轮":
      "This version can't pause — use ■ to stop this run",
    "这一轮已经结束了": "This run has already finished",
    "暂停没有下发成功，可用 ■ 终止这一轮":
      "The pause didn't go through — use ■ to stop this run",
    "正在暂停 · 本轮会停在当前这一步":
      "Pausing · the run stops at its current step",
    "已暂停 · 上下文与已写出的内容都保留":
      "Paused · context and everything already written are kept",
    "已暂停 · 点「继续」从中断处接着跑":
      "Paused · press “Continue” to pick up where it stopped",
    " · 发送队列还有 ": " · the send queue still holds ",
    " 条（暂停期间不自动发送）": " message(s) (not sent while paused)",
    "从中断处接着跑（沿用这条会话的上下文，不重发任务）":
      "Pick up where it stopped (reuses this session's context; the task is not resent)",
    "继续该会话（从中断处接着跑）":
      "Continue this session (pick up where it stopped)",
    /* ── 复杂任务计划确认 ── */
    "计划确认": "Plan confirmation",
    "明确不做": "Explicitly excluded",
    "任务清单（可编辑 · 增删 / 排序 / 逐项指定模型）": "Task list (editable · add / remove / reorder / per-task model)",
    "任务标题": "Task title",
    "详情 / 涉及文件 / 边界": "Detail / files / scope",
    "执行模型": "Model",
    "并行组": "Group",
    "同组名的任务并发执行（留空 = 按顺序单独跑）":
      "Same-name tasks run concurrently (blank = sequential)",
    "并行组名：填相同名字的若干任务会同时异步执行；留空则按清单顺序一项一项跑。":
      "Parallel group: tasks sharing a name run asynchronously together; leave blank to run one by one in list order.",
    "详情（做什么 / 涉及文件 / 要点与边界）": "Details (what / files / scope)",
    "建议模型": "Suggested model",
    "还原窗口大小": "Restore window size",
    "最大化窗口（也可拖右下角自由放大）":
      "Maximize (or drag the bottom-right corner to resize freely)",
    "拖拽放大 / 缩小窗口 · 双击还原默认大小":
      "Drag to resize the window · double-click to reset",
    "本任务的执行模型": "Model for this task",
    "模型：自动（跟随默认）· 点击为本任务单独选择":
      "Model: auto (follow default) · click to pick one for this task",
    "模型：": "Model: ",
    " · 点击修改（本任务单独用它执行）":
      " · click to change (this task runs with it)",
    "模型建议（未登记在模型服务）": "Suggested (not in model services)",
    "添加任务": "Add task",
    "上移": "Move up",
    "下移": "Move down",
    "删除该项": "Remove this item",
    "至少保留一个任务": "Keep at least one task",
    "确认执行": "Confirm & run",
    "按清单逐项执行（顺序 / 内容 / 模型以当前编辑结果为准）": "Run per the list (order / content / model as edited)",
    "拖右下角可放大窗口（双击还原 · ⤢ 最大化）· 清单过高时框内滚动浏览 · 标题与详情为多行输入，随内容长高 · 点「执行模型」按钮为该任务单独选模型 · 确认后按清单逐项执行（同组并行任务并发跑）· Ctrl+Enter 确认 · Esc 取消":
      "Drag the bottom-right corner to enlarge (double-click resets · ⤢ maximizes) · scroll inside the list when it gets long · title and detail are multi-line and grow with the text · click the Model button to pick a model for that task · after confirming, tasks run one by one (same-group tasks run concurrently) · Ctrl+Enter confirm · Esc cancel",
    "计划已全部执行完成": "Plan fully executed",
    "执行位置": "Runs in",
    "所属会话已关闭，计划未执行": "Its session was closed, so the plan was not executed",
    "这份计划已过期或所属会话已关闭，未执行":
      "This plan is stale or its session was closed — nothing was executed",
    "已终止：本会话的计划清单已清除":
      "Stopped: this session's plan list has been cleared",
    "这份计划不属于当前会话，已清除":
      "This plan does not belong to the current session — cleared",
    "所属会话已不存在，计划已停止":
      "The session this plan belongs to is gone — execution stopped",
    /* ── 会话内「计划」面板（st.plan 落盘 · 逐项状态 · 可续跑） ── */
    "展开 / 收起计划清单": "Expand / collapse the plan list",
    "向上拖拽加高计划清单 · 可拖到此刻放得下的最大值 · 双击回到默认最小高度":
      "Drag up to grow the plan list · it stops at the tallest height that actually fits right now · double-click to reset to its default minimum height",
    "当前最多": "max",
    "执行中…": "Running…",
    "执行中": "In progress",
    "待执行": "Pending",
    "已跳过": "Skipped",
    "继续执行": "Continue",
    "从第一条未完成的任务接着跑（剩余 ":
      "Resume from the first unfinished task (",
    " 项 · 仍在本会话内执行）":
      " left · still executed inside this session)",
    "清除本会话的计划清单（不会撤销已完成的改动）":
      "Clear this session's plan (completed changes are kept)",
    "清除本会话的计划清单？\n\n还有 ":
      "Clear this session's plan?\n\n",
    " 项未执行，清除后无法再接着跑（已经改好的内容不会被撤销）。":
      " task(s) are still pending — after clearing, it cannot be resumed (finished work is not reverted).",
    "清除计划": "Clear plan",
    "计划跑到这里：还有 ": "The plan stopped here: ",
    " 项未完成，可在「计划」面板继续执行":
      " task(s) left — press 继续执行 in the plan panel to resume",
    "该计划正在执行中": "This plan is already running",
    "该计划已全部完成": "This plan is already complete",
    "会话正在运行中": "This session is already running",
    "用户取消了该计划，未执行任何改动。": "The plan was cancelled; nothing was changed.",
    "（计划已取消，未执行任何改动）": "(Plan cancelled — no changes made)",
    "检测到计划未弹出，已自动要求重新生成一次":
      "Plan dialog didn't pop up — asked the model to regenerate it once",
    "计划仍未正确生成：请重新发送你的要求，或手动整理任务清单":
      "The plan still isn't valid: resend your request, or edit the task list manually",
    "【执行已确认计划 · 并行任务】": "[Execute confirmed plan · parallel task]",
    "【执行已确认计划 · 任务 ": "[Execute confirmed plan · task ",
    "】": "]",
    "【并行任务完成】": "[Parallel tasks finished]",
    " 项计划任务。": " planned tasks.",
    "最多 ": "At most ",
    " 项任务": " tasks",
    /* ── 计划面板：并行组实时轨迹（行内状态条 + 详情里的流式转写区） ── */
    "已用时": "Elapsed",
    "输出字数": "Output chars",
    "字": " chars",
    "最近": "last",
    "token": "tokens",
    "思考": "reasoning",
    "状态：执行中": "Status: running",
    "状态：出错": "Status: error",
    "状态：已取消": "Status: cancelled",
    "状态：已结束": "Status: finished",
    " 次更早调用": " earlier call(s)",
    "错误": "Error",
    "（暂无正文输出）": "(No output text yet)",
    /* ── 会话任务清单（Todo） ── */
    "任务清单": "Tasks",
    "展开 / 收起任务清单": "Expand / collapse task list",
    "完成 / 总数": "done / total",
    " 失败": " failed",
    "未确认": "Unconfirmed",
    "关闭并清除本清单（手动删除的条目不会再出现）":
      "Dismiss this list (removed items will not reappear)",
    "从清单移除": "Remove from list",
    "工具预设": "Tool preset",
    "停止运行": "Stop run",
    "只终止这一项": "Stop only this item",
    "DSH 插件": "DSH plugins",
    "节点完成后自动执行下游（默认关：连跑请用控制节点 ▶）":
      "Auto-run downstream when a node finishes (off by default: use a control node ▶)",
    "把当前预设里的全部工具设为「允许」":
      "Set every tool in the current preset to Allow",
    "已把全部工具设为允许": "All tools set to allow",
    "允许": "Allow",
    "切换为英文": "Switch to English",
    "切换为中文": "Switch to Chinese",
    "智能会话与节点的回复语言会跟随此设置":
      "Agent sessions and node replies follow this language too",
    "交流语言（Agent 口味）：": "Communication language (agent taste): ",
    " —— 智能会话、智能节点与全局助手都用该语言交流，并期望 agent 用该语言回答；顶栏「中 / EN」切换即生效。":
      " — agent sessions, smart nodes and the global assistant all converse in this language and expect answers in it; flip it anytime with the 中 / EN button in the top bar.",
    "？": "?",
    "步": "step",
    "低": "Low",
    "轻": "Light",
    "高": "High",
    "你": "You",
    "图": "Img",
    "无": "Off",
    "中": "Medium",
    "组": "Group",
    "超节点：将选中节点合并为展开的超级节点（覆盖选区范围）":
      "Super: wrap selection into an expanded super node (fits selection bounds)",
    "请先框选 / 选中要合并的节点": "Select nodes to wrap first",
    "请选择同一层级内的节点（不能跨超级节点边界）":
      "Select nodes at the same level (not across super-node boundaries)",
    "已合并为超节点：": "Wrapped into super node: ",
    " 步": " step",
    " 图": " Img",
    " 字": " chars",
    "安装": "Install",
    "标准": "Standard",
    "参数": "Params",
    "插件": "Plugins",
    "存图": "Save img",
    "存文": "Save txt",
    "当前": "Current",
    "导入": "Import",
    "动画": "Anim",
    "对话": "Chat",
    "复制": "Copy",
    "工坊": "Store",
    "改名": "Rename",
    "重命名该会话(便于管理)": "Rename this session",
    "合并": "Merge",
    "回答": "Reply",
    "会话": "Session",
    "会话 · ": "Session · ",
    "本轮 ": "this round ",
    "输出 ": "Output ",
    "推理 ": "Reasoning ",
    "工具 ": "tools ",
    "当前会话本轮 token 消耗（运行会话后显示）": "Current session round token usage (shown after a run)",
    "居中": "Fit",
    "结果": "Result",
    "拒绝": "Deny",
    "聚合": "Aggregate",
    "类型": "Type",
    "浏览": "Browse",
    "轮第": " Step ",
    "名称": "Name",
    "模型": "Model",
    "内容": "Content",
    "批量": "Batch",
    "排版": "Layout",
    "隐藏线": "Hide wires",
    "查找": "Find",
    "启用": "Enable",
    "清除": "Clear",
    "清空": "Clear all",
    "确定": "OK",
    "删除": "Delete",
    "试听": "Preview",
    "条目": "Entry",
    "停用": "Disable",
    "讨论": "Forum",
    "图像": "Image",
    "位置": "Location",
    "文本": "Text",
    "卸载": "Uninstall",
    "移除": "Remove",
    "音频": "Audio",
    "重做": "Redo",
    "撤销": "Undo",
    "只读": "Read-only",
    "智能": "Agent",
    "逐条": "Per item",
    "助手": "Assistant",
    "最强": "Max",
    "作者": "Author",
    " 副本": " copy",
    " 条线": " wires",
    " 项）": " items)",
    " 字符": " chars",
    "版本 ": "Version ",
    "不使用": "Don't use",
    "尝试 ": "Attempt ",
    "创建 ": "Created ",
    "创建组": "Create group",
    "错误:": "Error:",
    "服务商": "Provider",
    "供应商": "Provider",
    "模型提供商": "Model provider",
    "模型提供商：": "Model provider: ",
    "模型提供商 / 预设 / 模型 / 思考强度":
      "Model provider / preset / model / thinking effort",
    "未选择：本功能块与子功能块跟随默认模型提供商。":
      "Not set: this block and its sub-blocks follow the default model provider.",
    "未选择：本节点需要借助 AI 时跟随默认模型提供商。":
      "Not set: this node follows the default model provider when it needs AI.",
    "来源:": "Source:",
    "来源：": "Source: ",
    "连接 ": "Connected ",
    "另存为": "Save as",
    "筛选…": "Filter…",
    "删除 ": "Deleted ",
    "输入 ": "Input ",
    "替换…": "Replace…",
    "条目 ": "Entry ",
    "网格 ": "Grid ",
    "未选择": "None selected",
    "文生图": "Text-to-image",
    "新会话": "New session",
    "已安装": "Installed",
    "已撤销": "Undone",
    "已复制": "Copied",
    "已排版": "Laid out",
    "已启用": "Enabled",
    "已停用": "Disabled",
    "已重做": "Redone",
    "用户：": "User: ",
    "助手：": "Assistant: ",
    "子代理": "Sub-agent",
    "组 1": "Group 1",
    "组标题": "Group title",
    "组操作": "Group actions",
    "\n模型：": "\nModel: ",
    " · 第": " · Turn ",
    " 次成功": " succeeded",
    " 个节点到粘贴板（Ctrl+V 粘贴）": " node(s) to clipboard (Ctrl+V to paste)",
    "粘贴板为空，请先 Ctrl+C 复制节点": "Clipboard is empty — press Ctrl+C on nodes first",
    " 节点）": " nodes)",
    " 切割）": " grid)",
    " 条连线": " wires",
    " 项成功": " succeeded",
    " 张图像": " images",
    " 字符）": " chars)",
    "… 共 ": "… total ",
    "（错误：": "(Error: ",
    "（待定）": "(Pending)",
    "（默认）": "(Default)",
    "(失败)": "(failed)",
    "」的节点": "\"",
    "【用户】": "[User]",
    "【助手】": "[Assistant]",
    "■ 终止": "■ Stop",
    "◉ 思考": "◉ Thinking",
    "✕ 删除": "✕ Delete",
    "保存节点": "Save Node",
    "保存（按输入自判）": "Save (infer from input)",
    "绑定保存节点不能改接其他来源": "Bound save node cannot be rewired",
    "该连线已固定，无法删除": "This wire is pinned and cannot be deleted",
    "图像 / 音频 / 视频保存仅接受 1 个输入": "Image / audio / video save accepts only 1 input",
    "图像保存需要图像来源": "Image save needs an image source",
    "该保存节点当前按文本保存，不能混接媒体":
      "This save node currently stores text, so media inputs cannot be mixed in",
    "该保存节点按图像保存，只接受图像端子：请改接图像来源，或把保存路径改成 .yaml 用文本保存":
      "This save node stores images, so only an image port may feed it: connect an image source port, or change the save path to .yaml to save text",
    "已保存音频 → ": "Saved audio → ",
    "已保存视频 → ": "Saved video → ",
    "选择音频保存位置": "Choose audio save location",
    "选择视频保存位置": "Choose video save location",
    "保存图像": "Save image",
    "保存文本": "Save text",
    "查看说明": "View help",
    "处理节点": "Process Node",
    /* 拖线落点「新建并连入」菜单与右键新建菜单共用的一批分类 / 节点文案 */
    "批次节点": "Batch Node",
    "未知节点类型": "Unknown node type",
    "文本处理（LLM）": "Text processing (LLM)",
    "图像生成（文生图）": "Image generation (text-to-image)",
    "拆分（批次 → 单项只读节点）": "Split (batch → per-item read-only nodes)",
    "合并（多节点 → 批次）": "Merge (multiple nodes → batch)",
    "保存（按输入自判文本 / 图像 / 音频 / 视频）":
      "Save (auto-detect text / image / audio / video from input)",
    "Minimax H3（视频生成 · 文本 / 图像 / 音频 / 视频）":
      "Minimax H3 (video · text / image / audio / video)",
    "智能任务（读文件 / 联网 / 执行命令）":
      "Agent task (read files / network / run commands)",
    "网络 · 发送（把通道文本推送到远端）":
      "Network · Send (push channel text to a remote)",
    "待保存…": "Unsaved…",
    "导出画布": "Export canvas",
    "导出会话": "Export session",
    "导入画布": "Import canvas",
    "调用失败": "Call failed",
    "动画节点": "Anim Node",
    "服务商 ": "Providers ",
    "服务商：": "Provider: ",
    "复制请求": "Copy request",
    "复制失败": "Copy failed",
    "复制文本": "Copy text",
    "复制摘要": "Copy summary",
    "工具调用": "Tool calls",
    "工具节点": "Tool Node",
    "画布 ": "Canvas ",
    "画布：": "Canvas: ",
    "工作目录": "Working directory",
    "后台任务": "Background task",
    "缓存命中": "Cache hit",
    /* ── 会话统计 · 费用与余额（app-cost.js / app-agent.js / app.js） ── */
    "费用": "Cost",
    "本次费用": "This run's cost",
    "账户余额": "Account balance",
    "余额": "Balance",
    "DeepSeek 余额": "DeepSeek balance",
    "余额刷新": "Refresh balance",
    "刷新余额": "Refresh balance",
    "刷新中": "Refreshing",
    "余额查询失败": "Balance query failed",
    "未知单价": "Unknown price",
    "赠送": "Granted",
    "充值": "Topped up",
    "更新于": "Updated",
    "未查询": "Not queried",
    /* ── 会话统计 · 费用口径说明（「？」入口，app-cost.js / app-agent.js / app.js） ──
       每条都是真实存在的口径差，不是安慰话术：折扣 / 赠送抵扣未计入，以及兜底 flash 价
       与窗口口径（会话 / 轮次 vs 平台按小时按模型）不同，所以显示可能高于实际账单。
       峰谷本身按调用时刻计价，不再是偏差源，故不再作为口径说明的一行。 */
    "费用为什么高于实际消费？": "Why is the cost shown higher than what was actually spent?",
    "估算未计入官方活动折扣与赠送余额抵扣，显示值可能高于实际消费；峰谷按调用时刻计价，与官方账单口径一致。":
      "The estimate does not include official promos or granted-balance offsets, so the figure shown may exceed what you actually spend; peak/off-peak is priced by the actual call time, matching the official bill.",
    "价格表里没有的模型（如带日期后缀的内测模型）按 flash 价兜底，这类金额是估算值，已在行末用 * 标出。":
      "Models missing from the price table (e.g. preview models with a date suffix) fall back to flash pricing; such amounts are estimates and are marked with * at the end of the row.",
    "估算按「每一次模型请求」累加，包含重试、预热等已发出但平台可能不计费的请求；平台按小时 / 按模型分账，与会话 / 轮次窗口口径不同，两边对不上属正常。":
      "The estimate sums every model request, including retries and warm-up requests that were sent but may not be billed by the platform; the platform breaks usage down by hour and by model, which is not the same window as a session/round here — a mismatch between the two is expected.",
    "对账请以 DeepSeek 账单和余额变化为准。":
      "Token counts themselves are not double counted (they match the sum of per-request usage in the local session log — verify with scripts/audit-token-usage.mjs); for reconciliation, trust DeepSeek's official billing.",
    "口径：单价与峰谷按官方价格页，token 按上游逐请求返回的 usage 累加。":
      "Scope: unit prices and peak/off-peak follow the official pricing page; tokens are summed from the per-request usage the upstream returns.",
    /* ── 会话统计 · 逐模型性能下钻（app-agent.js / app.js） ── */
    "模型性能": "Model performance",
    "首 Token 延迟 (TTFT)": "Time to first token (TTFT)",
    "TTFT 样本数": "TTFT samples",
    "输出吞吐": "Output throughput",
    "出": "Out",
    "每输出 Token 耗时 (TPOT)": "Time per output token (TPOT)",
    "端到端延迟": "End-to-end latency",
    "端到端延迟 · 单次均值": "End-to-end latency · average per call",
    "端到端延迟 · 累计": "End-to-end latency · total",
    "端到端": "End-to-end",
    "单次均值": "Average per call",
    "预处理吞吐 (Prefill)": "Prefill throughput (Prefill)",
    "调用次数": "Calls",
    "样本数": "Samples",
    "推算值": "Estimated",
    "(推算)": "(estimated)",
    "点击查看性能指标": "Click to view performance metrics",
    "点击查看性能": "Click to view performance",
    /* ── 会话统计 · 按会话轮次的细分统计（app-agent.js） ── */
    "按轮次": "By session round",
    "轮次": "Round",
    "首轮": "First round",
    "合计": "Total",
    "按模型": "By model",
    "未命名轮次": "Untitled round",
    "计划任务": "Plan task",
    "时刻": "Time",
    "序号": "No.",
    "轮 / 步": "Rounds / steps",
    "性能": "Performance",
    "该轮性能": "This round's performance",
    "点击查看该轮性能": "Click to view this round's performance",
    "点击展开按轮次统计": "Click to expand round-by-round stats",
    "点击收起按轮次统计": "Click to collapse round-by-round stats",
    "口径：轮次 = 一次运行的入账（标题优先取计划任务标题，否则取用户输入前 24 字）；实测＝网关逐次采样的累计值直接得出；推算＝缺纯生成时间 / Prefill 计数时用 LLM 用时、计费输入近似（标「(推算)」）；—＝无样本（老台账或该轮未采到首 Token 延迟）。":
      "How to read: a round = one run's accounting entry (title prefers the plan task title, otherwise the first 24 characters of the user input); measured = derived directly from the cumulative per-call samples the gateway collects; estimated = approximated from LLM time / billed input when pure generation time or Prefill counts are missing (marked \"(estimated)\"); — = no samples (old ledger, or no TTFT captured for this round).",
    "历史会话": "Session history",
    "连线操作": "Wire actions",
    "另存为…": "Save as…",
    "没有改动": "No changes",
    "模型服务": "Model services",
    "提供商配置": "Providers",
    "（点击任一格配置该服务商；网格顺序即使用优先级，越靠前越优先）":
      "(Click a tile to configure that provider; grid order is the priority order — earlier wins)",
    "服务商配置": "Provider settings",
    "点击配置该服务商": "Click to configure this provider",
    "暂无服务商，点右上「＋ 添加服务商」新建":
      "No providers yet — use \"+ Add provider\" at the top right",
    "模型列表": "Model list",
    "默认目录": "Default directory",
    "切割列数": "Grid columns",
    "切割行数": "Grid rows",
    "请求超时": "Request timed out",
    "确认使用": "Use this",
    "色键颜色": "Chroma-key color",
    "上下文 ": "Context ",
    "尚未保存": "Not saved yet",
    "生成速度": "Generation speed",
    "手动配置": "Manual setup",
    "输出图像": "Output image",
    "输入节点": "Input Node",
    "输入图像": "Input image",
    "图像操作": "Image actions",
    "未知错误": "Unknown error",
    "文本处理": "Text processing",
    "文本文件": "Text files",
    "无匹配项": "No matches",
    "选择图像": "Choose image",
    "选择文件": "Choose file",
    "移除该源": "Remove this source",
    "已安装 ": "Installed ",
    "已保存 ": "Saved ",
    "已保存：": "Saved: ",
    "已处理 ": "Processed ",
    "已导入 ": "Imported ",
    "已启用 ": "Enabled ",
    "已添加 ": "Added ",
    "已停用 ": "Disabled ",
    "已卸载 ": "Uninstalled ",
    "已移除 ": "Removed ",
    "已载入 ": "Loaded ",
    "允许一次": "Allow once",
    "本会话后续都放行": "Allow for the rest of this session",
    "本会话后续同类沙箱放行已记住：": "Remembered for this session: ",
    "沙箱拒绝了这次访问，请确认是否放行。目标权限：": "The sandbox denied this access. Allow it? Requested permission: ",
    "「允许一次」仅这次的调用有效；「本会话后续都放行」记住后，本会话里同类沙箱放行不再询问；「拒绝」则阻止本次调用。":
      "\"Allow once\" applies to this call only; \"Allow for the rest of this session\" remembers the choice so the same kind of sandbox access is not asked again in this session; \"Deny\" blocks this call.",
    "暂无会话": "No sessions yet",
    "暂无节点": "No nodes yet",
    "暂无条目": "No entries yet",
    "展开分类": "Expand category",
    "收起分类": "Collapse category",
    "折叠分类": "Collapse category",
    "智能节点": "Agent Node",
    "智能任务": "Agent task",
    "主题色：": "Theme: ",
    "子代理 ": "Sub-agent ",
    "自定义源": "Custom source",
    "MTNode 官方": "MTNode official",
    "MTNode 官方源": "MTNode official source",
    "目录": "Catalog",
    " · 分支": " · Fork",
    " 个节点）": " nodes)",
    " 个模型）": " models)",
    " 轮 · ": " turns · ",
    " 项 · ": " items · ",
    " 帧 · ": " frames · ",
    "（请选择）": "(Select)",
    "（未命名）": "(Untitled)",
    "（无输出）": "(No output)",
    "（无图像）": "(No image)",
    "（图像输入）": "(Image input)",
    "（已停用）": "(Disabled)",
    "（已终止）": "(Stopped)",
    "已手动终止": "Stopped manually",
    "运行长时间无响应，已自动终止": "Run timed out (no response), auto-stopped",
    "交互等待超时，已自动终止": "Interaction wait timed out, auto-stopped",
    "本轮出错，": "Error this round — auto-retry in ",
    " 秒后从中断处继续（第 ": " s, continuing from where it stopped (attempt ",
    " 秒后整轮重发（第 ": " s, resending the whole round (attempt ",
    " 次）· 不跳到下一个任务 · ": ") · not skipping to the next task · ",
    " 次）· 已写内容不重烧 · ": ") · already-written content is not re-burned · ",
    " 次）· 运行配置已变化，无法从中断处续跑 · ":
      ") · run config changed, cannot resume from the break · ",
    "[图像] ": "[Image] ",
    "＋ 添加源": "+ Add source",
    "◉ 处理中": "◉ Processing",
    "◉ 思考中": "◉ Thinking",
    "✓ 批量 ": "✓ Batch ",
    "🐋 智能": "🐋 Agent",
    "操作失败：": "Operation failed: ",
    "处理失败：": "Process failed: ",
    "从文件导入": "Import from file",
    "打开画布": "Open canvas",
    "打开失败：": "Open failed: ",
    "导出失败:": "Export failed:",
    "导出失败：": "Export failed: ",
    "导出为文件": "Export as file",
    "导入失败：": "Import failed: ",
    "等待结果…": "Waiting for result…",
    "对话失败：": "Chat failed: ",
    "服务商名称": "Provider name",
    "复制失败：": "Copy failed: ",
    "画布名称": "Canvas name",
    "画布说明": "Canvas notes",
    "轨迹 · ": "Trace · ",
    "后台任务 ": "Background task ",
    "缓存命中 ": "Cache hit ",
    "回答失败：": "Reply failed: ",
    "剪贴板为空": "Clipboard is empty",
    "节点不存在": "Node not found",
    "没有匹配「": "No nodes matching \"",
    "默认画布": "Default canvas",
    "快速开始": "Quick Start",
    "请求已中止": "Request aborted",
    "删除该条目": "Delete this entry",
    "删除会话「": "Delete session \"",
    "上文已压缩": "Context compacted",
    "压缩": "Compact",
    "压缩上下文": "Compact context",
    "当前会话没有可压缩的消息": "No messages to compact in this session",
    "运行中不可压缩：请等待当前会话结束": "Cannot compact while running — wait for the current run to end",
    "会话视图不使用画布边栏：请在「画布」视图中查看节点列表":
      "The session view has no canvas sidebar — switch to the Canvas view to browse nodes",
    "上下文窗口": "Context window",
    "审批失败：": "Approval failed: ",
    "输入端子 ": "Input port ",
    /* 端子数不固定节点的读图规则（app-nodes.js snapshotDynamicPortRule）：只给 ports 会让
       模型误判「没有图像参考端子」，故随标准档快照补一条「端子怎么长」的说明 */
    "输入端子随连线增量：未连线的节点只列出端口 0；每多连一条数据线就多出一个「输入端子 N」——文本与图像引用都收（参考图连端口 1+，勿连端口 0）。":
      "Input ports grow with wires: an unconnected node lists port 0 only; each extra data wire adds an \"Input port N\" — both text and image references are accepted (connect reference images to port 1+, never port 0).",
    "端口 0 = 提示词 / 文本入口 · 端口 1+ = 数据槽（连一条多一个 · 文本 / 图像引用都收）":
      "Port 0 = prompt / text inlet · ports 1+ = data slots (one per wire · text and image references both accepted)",
    "端口 0 = 内容 · 末位 = 控制输出": "Port 0 = content · last port = control output",
    "ports 只列当前真实存在的端子；要接参考图直接连端口 1+ 即可，不必先试连一次看 warnings。":
      "ports lists only the ports that currently exist; to wire a reference image just connect port 1+ — no need to make a trial wire and read the warnings.",
    "添加服务商": "Add provider",
    "粘贴导入（一键解析）": "Paste import (auto-parse)",
    "读取剪贴板": "Read clipboard",
    "从系统剪贴板读取文字并解析": "Read text from the system clipboard and parse it",
    "解析并填入": "Parse & fill",
    "按行解析并填入下方表单，可再核对修改": "Parse line by line into the form below; review before adding",
    "把服务商配置文字粘贴到下方（支持「字段名: 值」逐行、JSON，或按 名称/接口地址/API Key/模型 顺序逐行），点「解析并填入」自动识别。":
      "Paste the provider config text below (supports \"field: value\" lines, JSON, or plain lines in the order name / base URL / API Key / models), then click \"Parse & fill\".",
    "粘贴内容为空": "Pasted content is empty",
    "JSON 解析失败：请确认内容为有效的 JSON 配置": "JSON parse failed: make sure the content is valid JSON",
    "未能识别配置：请使用「字段名: 值」逐行、JSON 或「名称/接口地址/API Key/模型」顺序粘贴":
      "Could not recognize the config: paste it as \"field: value\" lines, JSON, or plain lines in the order name / base URL / API Key / models",
    "剪贴板为空：请先复制配置文字再点此按钮": "Clipboard is empty: copy the config text first, then click this button",
    "名称 ": "Name ",
    "接口 ": "Base URL ",
    "API Key 已填入": "API Key filled",
    "已解析并填入（请核对后点「添加」）：": "Parsed and filled (review, then click Add): ",
    "请先粘贴配置文字并点「解析并填入」": "Paste the config text first, then click \"Parse & fill\"",
    "添加失败：": "Add failed: ",
    "添加在线源": "Add online source",
    "未命名节点": "Untitled node",
    "未知命令:": "Unknown command:",
    "文件不存在": "File not found",
    "无匹配插件": "No matching plugins",
    "线上目录 ": "Online catalog ",
    "卸载插件 ": "Uninstall plugin ",
    "卸载失败：": "Uninstall failed: ",
    "新建画布": "New canvas",
    "选择文件夹": "Choose folder",
    "渲染错误：": "Render error: ",
    "压缩失败：": "Compact failed: ",
    "移除插件 ": "Remove plugin ",
    "移除技能 ": "Remove skill ",
    "移除失败：": "Remove failed: ",
    "已创建组：": "Created group: ",
    "已复制请求": "Request copied",
    "已复制摘要": "Summary copied",
    "已手动停止": "Stopped manually",
    /* 「强行进入下一状态」认「被停止 / 中断按下来」的环节要用它（app-longtask.js ltForcedNode）：
       用户中途切过界面语言时，st.err 里那份文案是当时语言的，所以两种都要有词条。 */
    "已中断（应用重启或任务停止）": "Interrupted (app restarted or task stopped)",
    "已新建会话": "New session created",
    "引擎未连接": "Engine not connected",
    "预览失败：": "Preview failed: ",
    "\n工作目录：": "\nWorking directory: ",
    "\n批量模式：": "\nBatch mode: ",
    "\n输入节点：": "\nInput nodes: ",
    " · 尝试 ": " · Attempt ",
    " · 批量 ": " · Batch ",
    " 次工具调用": " tool calls",
    " 个服务商）": " providers)",
    " 节点 · ": " nodes · ",
    "（读取中…）": "(Reading…)",
    "（无批次项）": "(No batch items)",
    "【参考图像：": "[Reference image: ",
    "＋ 安装插件": "+ Install plugin",
    "＋ 创建技能": "+ Create skill",
    "＋ 添加条目": "+ Add entry",
    "＋ 添加图像": "+ Add image",
    "＋ 图像节点": "+ Image Node",
    "＋ 文本节点": "+ Text Node",
    "✓ 已合并 ": "✓ Merged ",
    "✓ 已连入 ": "✓ Wired in ",
    "✕ 删除连线": "✕ Delete wire",
    "⤓ 保存图像": "⤓ Save image",
    "插件已安装：": "Plugin installed: ",
    "打开存档位置": "Open archive folder",
    "打开使用说明": "Open user guide",
    "非法 URL": "Invalid URL",
    "复制到剪贴板": "Copy to clipboard",
    "复制输出文本": "Copy output text",
    "更改画布名称": "Rename canvas",
    "工具调用轨迹": "Tool-call trace",
    "画布不存在": "Canvas not found",
    "画布名称…": "Canvas name…",
    "画布已导出（": "Canvas exported (",
    "画布已导入：": "Canvas imported: ",
    "会话已删除：": "Session deleted: ",
    "结果（出错）": "Result (error)",
    "聚合(单次)": "Aggregate (once)",
    "开始对话吧…": "Start chatting…",
    "请先选中节点": "Select a node first",
    "删除该服务商": "Delete this provider",
    "设置已保存（": "Settings saved (",
    "输入批次共 ": "Input batch: ",
    "输入图像就绪": "Input image ready",
    "思考中 · ": "Thinking · ",
    "天青 Sky": "Sky",
    "图像生成完成": "Image generation complete",
    "拖拽调整尺寸": "Drag to resize",
    "网络请求失败": "Network request failed",
    "未处理异常：": "Unhandled exception: ",
    "未命名画布": "Untitled canvas",
    "未配置服务商": "No provider configured",
    "无法读取文件": "Cannot read file",
    "下载图像超时": "Image download timed out",
    "选择保存位置": "Choose save location",
    "选择拆出的项": "Choose items to split",
    "选择工作目录": "Choose working directory",
    "选择完成音效": "Choose completion sound",
    "移除在线源「": "Remove online source \"",
    "已归档 · ": "Archived · ",
    " 天前": " d ago",
    " 周前": " wk ago",
    " 个月前": " mo ago",
    " 年前": " yr ago",
    "最后对话：": "Last message: ",
    "\n所属画布: ": "\nOwning canvas: ",
    /* 会话侧栏行内元信息「▣ 所属画布」与两处悬浮说明（app-assist.js）：
       用户切去别的画布干活时，一眼看出这条会话改的是哪张图 */
    "所属画布：": "Owning canvas: ",
    "会话只读写它所属的这张画布；你切到别的画布干活不会串图":
      "This session only reads and writes the canvas it belongs to; switching to another canvas will not mix them up",
    "（已删除）": " (deleted)",
    "拖拽调整会话列表宽度": "Drag to resize the session list",
    "尚无对话": "No messages yet",
    "已添加节点：": "Added node: ",
    "已移除技能 ": "Removed skill ",
    "暂无思考内容": "No thinking content",
    "找不到节点：": "Node not found: ",
    "智能任务摘要": "Agent task summary",
    "GIF 图像": "GIF image",
    "LLM 用时": "LLM time",
    "PNG 图像": "PNG image",
    "\n\n【内容】\n": "\n\n[Content]\n",
    "\n工作目录: ": "\nWorking directory: ",
    " 帧动画 · ": " frame anim · ",
    "（无输出内容）": "(No output content)",
    "（无连入）": "(No wired-in sources)",
    "（空）": "(empty)",
    "点击空白处查看全部连入内容": "Click empty area to view all wired-in content",
    "全局参考 · ": "Global refs · ",
    "复制全部连入文本": "Copy all wired-in text",
    "复制当前连入文本": "Copy this source's text",
    "点击芯片查看内容": "Click a chip to view its content",
    "定位": "Locate",
    "【背景信息】\n": "[Background]\n",
    "**用户**：": "**User**: ",
    "＋ 添加服务器": "+ Add server",
    "＋ 添加服务商": "+ Add provider",
    "🌐 在线浏览": "🌐 Browse online",
    "不能连接成回路": "Cannot create a loop",
    "当前权限预设:": "Current permission preset:",
    "导入 YAML": "Import YAML",
    "多次尝试 · ": "Multi-attempt · ",
    "多次尝试完成：": "Multi-attempt complete: ",
    "服务商已添加：": "Provider added: ",
    "该节点暂无输出": "This node has no output yet",
    "画布已重命名：": "Canvas renamed: ",
    "会话已重命名:": "Session renamed:",
    "结果（进行中）": "Result (in progress)",
    "框选模式已关闭": "Marquee mode off",
    "轮数 / 步数": "Turns / Steps",
    "玫瑰 Rose": "Rose",
    "批量处理完成：": "Batch processing complete: ",
    "切换到画布：": "Switched to canvas: ",
    "青柠 Lime": "Lime",
    "请先选择服务商": "Select a provider first",
    "筛选节点标题…": "Filter node titles…",
    "删除当前画布": "Delete current canvas",
    "输出浏览 · ": "Output · ",
    "思考过程 · ": "Thinking · ",
    "思考内容 · ": "Thoughts · ",
    "思考强度 → ": "Thinking effort → ",
    "未知画布操作：": "Unknown canvas action: ",
    "未知节点类型：": "Unknown node type: ",
    "文本生成完成（": "Text generation complete (",
    "先填写任务描述": "Enter a task description first",
    "响应无图像数据": "Response has no image data",
    "响应无文本内容": "Response has no text",
    "已创建新画布": "New canvas created",
    "已打开画布：": "Opened canvas: ",
    "已分支新会话：": "Forked new session: ",
    "载入更早的 ": "Load earlier ",
    " 轮对话（共 ": " rounds (of ",
    " 轮）": " rounds)",
    "在列表最前端载入更早的对话": "Load earlier messages at the top of the list",
    "显示更早内容（已折叠 {n} 条）": "Show earlier content ({n} collapsed)",
    "每个会话最多同时渲染 200 条，点击展开更早的 200 条":
      "Each session renders at most 200 entries at a time; click to unfold 200 earlier ones",
    "已折叠更早的运行条目：{n}": "Earlier run entries collapsed: {n}",
    "已复制到剪贴板": "Copied to clipboard",
    "已复制思考内容": "Thinking content copied",
    "已恢复单次尝试": "Restored single attempt",
    "已切换到尝试 ": "Switched to attempt ",
    "已删除组（含 ": "Deleted group (incl. ",
    "已添加在线源：": "Added online source: ",
    "在浏览器中打开": "Open in browser",
    "粘贴 YAML": "Paste YAML",
    "这两节点已连接": "These two nodes are already connected",
    "不能连接同一节点": "Cannot connect a node to itself",
    "跨级汇入失败：": "Cross-level feed-in failed: ",
    "跨级桥接失败：": "Cross-level bridge failed: ",
    "超级节点连接失败：": "Super-node link failed: ",
    "跨超级节点连接 ": "Cross-super-node connect ",
    " 对节点": " node pair(s)",
    "正在压缩上文…": "Compacting context…",
    "只读 · 拆分": "Read-only · Split",
    "智能会话失败：": "Agent session failed: ",
    "智能任务完成（": "Agent task complete (",
    "智能运行无输出": "Agent run produced no output",
    "智能助手失败：": "Agent assistant failed: ",
    "JPEG 图像": "JPEG image",
    "KB），未导入": "KB), not imported",
    "MCP 服务器": "MCP servers",
    "WebP 图像": "WebP image",
    "\n\n任务内容：\n": "\n\nTask:\n",
    " · 工具调用 ": " · Tool calls ",
    "（读取目录中…）": "(Reading catalog…)",
    "（图像尚未生成）": "(Image not generated yet)",
    "（未选择服务商）": "(No provider selected)",
    "【对话记录】\n\n": "[Chat log]\n\n",
    "尝试次数未变化（": "Attempt count unchanged (",
    "打开画布（共 ": "Open canvas (",
    "当前选择的模型「": "The selected model \"",
    "点击就地编辑标题": "Click to edit title in place",
    "非法画布 id": "Invalid canvas id",
    "该节点不接受输入": "This node does not accept input",
    "全局节点仅接受文本或图像来源": "Global node accepts only text or image sources",
    "更改当前画布名称": "Rename current canvas",
    "琥珀 Amber": "Amber",
    "画布居中定位到：": "Canvas centered on: ",
    "技能列表不可用（": "Skill list unavailable (",
    "将选中的 <b>": "Group the selected <b>",
    "没有可撤销的操作": "Nothing to undo",
    "没有可重做的操作": "Nothing to redo",
    "模型（逗号分隔）": "Models (comma-separated)",
    "批量模式已开启（": "Batch mode on (",
    "请填写服务商名称": "Enter a provider name",
    "如「团队插件源」": "e.g. \"Team plugin source\"",
    "输出 token": "Output token",
    "输入 token": "Input token",
    "思考强度：当前「": "Thinking effort: currently \"",
    "推理 token": "Reasoning token",
    "拖拽调整上下高度": "Drag to adjust height",
    "未知服务商类型：": "Unknown provider type: ",
    "无法读取输入图像": "Cannot read input image",
    "选择图像保存位置": "Choose image save location",
    "已保存图像 → ": "Saved image → ",
    "已从剪贴板写入 ": "Wrote from clipboard ",
    "已导入文件内容（": "Imported file content (",
    "已连接图像输入：": "Connected image input: ",
    "已切断输出端子 ": "Disconnected output port ",
    "已切断输入端子 ": "Disconnected input port ",
    "在此输入文本内容": "Enter text here",
    "帧动画生成失败：": "Frame animation failed: ",
    "帧动画生成完成（": "Frame animation complete (",
    "智能能力启动失败": "Agent engine failed to start",
    "智能任务执行中…": "Agent task running…",
    "AI · 运行中": "AI · Running",
    "GIF 编码失败": "GIF encode failed",
    "pi-ai 目录": "pi-ai catalog",
    "\n\n用户(最新)：": "\n\nUser (latest): ",
    " 个图像文件 → ": " image files → ",
    " 条）· 点击关闭": " items) · Click to close",
    " 张图像到批量节点": " images to batch node",
    "？引擎将自动重启。": "? The engine will restart automatically.",
    "（等待批次输入…）": "(Waiting for batch input…)",
    "（等待图像输入…）": "(Waiting for image input…)",
    "（上文已压缩）\n\n": "(Context compacted)\n\n",
    "◉ 正在生成帧动画": "◉ Generating frame animation",
    "点击展开参数与结果": "Click to expand args and result",
    "读取线上目录中…（": "Reading online catalog… (",
    "对话节点发送行为：": "Chat node send behavior: ",
    "该节点没有输出端子": "This node has no output port",
    "该输出端子没有连线": "This output port has no wire",
    "该输入端子没有连线": "This input port has no wire",
    "该输入端子已被占用": "This input port is already taken",
    "解散组（保留节点）": "Ungroup (keep nodes)",
    "没有可断开的连线：": "No wires to disconnect: ",
    "名称（显示为标签）": "Name (shown as label)",
    "输入变化时自动保存": "Auto-save on input change",
    "输入节点（仅输出）": "Input Node (output only)",
    "添加图像（可多选）": "Add images (multi-select)",
    "透明色键（Hex）": "Chroma key (Hex)",
    "图像已载入输入节点": "Image loaded into input node",
    "拖拽调整该条目高度": "Drag to adjust this entry's height",
    "未解析的 @引用：": "Unresolved @refs: ",
    "无法打开存档位置：": "Cannot open archive folder: ",
    "无法读取该文件路径": "Cannot read this file path",
    "线上目录暂不可用（": "Online catalog unavailable (",
    "已设置多次尝试 ×": "Multi-attempt set to ×",
    "樱花 Sakura": "Sakura",
    "只读 · 逐项审批": "Read-only · Approve each",
    "重复 alias：": "Duplicate alias: ",
    "最近一次智能运行：": "Last agent run: ",
    "MTNode 画布": "MTNode Canvas",
    "\n\n详细信息已写入：": "\n\nDetails written to: ",
    " · API 类型 ": " · API type ",
    " 项 → 输出为批次": " items → output as batch",
    " tok · 输出 ": " tok · output ",
    "（应用默认数据目录）": "(App default data directory)",
    "🔐 权限审批 · ": "🔐 Permission approval · ",
    "🧱 沙箱放行 · ": "🧱 Sandbox access · ",
    "标题（输出文件后缀）": "Title (output filename suffix)",
    "不支持的画布包版本：": "Unsupported canvas pack version: ",
    "撤销（Ctrl+Z）": "Undo (Ctrl+Z)",
    "当前没有打开的画布": "No canvas is open",
    "当前没有已加载的画布": "No canvas is loaded",
    "翡翠 Emerald": "Emerald",
    "复制输出中的全部文本": "Copy all text in output",
    "复制为 Base64": "Copy as Base64",
    "将删除画布 <b>": "This will delete canvas <b>",
    "没有可保存的文本输入": "No text input to save",
    "请填写名称与 URL": "Enter a name and URL",
    "深红 Crimson": "Crimson",
    "首 token 平均": "Avg first token",
    "图像输入需要视觉模型": "Image input requires a vision model",
    /* ── 模型形态识别（文本模型 / 图像生成模型，见 renderer/app-model-kind.js）── */
    "文本 + 图像（同一端点混合，按模型区分）":
      "Text + image (mixed on one endpoint, split by model)",
    "图像生成": "Image generation",
    "按模型纠正类型": "Fix type from models",
    "服务商类型与模型形态不符：按模型列表把类型改为对应的文本 / 图像类型，改完图像或文本节点即可选到这些模型":
      "Provider type does not match its models: set the type to the matching text/image type so image or text nodes can pick these models",
    "自动识别模型类型": "Auto-detect model type",
    "按模型 id 识别每个模型是文本模型还是图像生成模型，结果决定它在文本 / 图像节点与保存对话框里是否可选":
      "Detect whether each model is a text model or an image generator from its id; this decides where it can be picked in text/image nodes",
    "已识别 ": "Detected ",
    " 个模型 · 图像 ": " models · image ",
    " · 文本 ": " · text ",
    "徽标 = 模型类型（点一下可改）；同一端点混挂文本与图像模型时会自动区分":
      "Badge = model type (click to change); mixed text/image endpoints are told apart automatically",
    "点击切回自动识别": "Click to go back to auto-detect",
    "点击改为另一种（并记住）": "Click to switch to the other type (remembered)",
    "已手工指定为": "Manually set to ",
    "自动识别为": "Auto-detected as ",
    "图像模型": "image model",
    "图像生成模型": "image generation model",
    "文本模型": "text model",
    "原服务商没有": "The previous provider has no ",
    "，已切到可选的服务商；可在设置 · 模型服务里为它补模型或改模型类型。":
      "; switched to an available provider. Add models to it or change its model type under Settings · Model services.",
    "图像服务商": "image provider",
    "文本服务商": "text provider",
    "按模型自动识别为": "Auto-detected from models: ",
    "，类型已相应设置（可在列表里逐模型调整）":
      ", provider type set accordingly (adjust per model in the list)",
    "模型（图像生成）": "Model (image generation)",
    "模型（文本）": "Model (text)",
    "（形态不符）": "(type mismatch)",
    "服务商类型与模型不符，已按模型纠正为":
      "Provider type did not match its models; corrected to ",
    "服务商类型与所选模型不符，已按模型纠正为":
      "Provider type did not match the selected model; corrected to ",
    "（设置 · 模型服务里可核对）":
      " (verify under Settings · Model services)",
    "（文本 + 图像混挂，保存时自动拆成两条服务商）":
      "(text + image mixed; saved as two providers)",
    "（图像模型）": "(image models)",
    "（文本模型）": "(text models)",
    " 个模型": " models",
    "文件不存在或无法预览": "File not found or cannot preview",
    "选择图像（输入节点）": "Choose image (input node)",
    "已解散组（节点保留）": "Ungrouped (nodes kept)",
    "已自动执行上游节点：": "Auto-ran upstream nodes: ",
    "已自动执行下游节点：": "Auto-ran downstream nodes: ",
    "本节点已完成；失控保护已关闭自动级联，下游 ":
      "Node finished. Runaway guard is on, so nothing auto-ran next — ",
    " 个节点需手动 ▶（或用控制节点执行）":
      " downstream node(s) need a manual ▶ (or use a control node).",
    "下游已有内容": "Downstream already has output",
    "下游节点已有输出。继续执行将覆盖这些内容，也可以到此为止、不继续执行下游。":
      "Some downstream nodes already have output. Continue to overwrite them, or stop here and leave them unchanged.",
    "执行并覆盖": "Run and overwrite",
    "不继续执行": "Don't continue",
    "下游执行失败：": "Downstream run failed: ",
    "暂无 API Key": "No API Key",
    "智能助手已更新画布：": "Agent assistant updated the canvas: ",
    "最近一次运行的输入 ": "Last run input ",
    "MCP 列表不可用（": "MCP list unavailable (",
    "\n\n【已连接图像输入】": "\n\n[Connected image inputs]",
    "（已完成，无文本输出）": "(Done, no text output)",
    "── 终端输出 ──\n": "── Terminal output ──\n",
    "▶ 图像生成（文生图）": "▶ Image generation (text-to-image)",
    "▶ 文本处理（LLM）": "▶ Text processing (LLM)",
    "打开画布保存的文件夹": "Open canvas save folder",
    "发送消息（Enter）": "Send message (Enter)",
    "画布网格间距（px）：": "Canvas grid spacing (px): ",
    "节点列表边栏（树状图）": "Node list sidebar (tree)",
    "请填写 API Key": "Enter an API Key",
    "首 token 平均 ": "Avg first token ",
    "移除 MCP 服务器 ": "Remove MCP server ",
    "已保存 YAML → ": "Saved YAML → ",
    "已关闭:下一轮直接执行": "Off: execute directly next round",
    "引用输入节点（@标题）": "Reference input nodes (@title)",
    " · 素材按内容条目标题引用": " · assets are referenced by entry title",
    "↑↓ 选择 · 回车确认 · Esc 取消":
      "↑↓ select · Enter confirm · Esc close",
    "全局来源需明文 @ 才注入（@标题）":
      "Global sources inject only when @-mentioned (@title)",
    "全局来源需明文 @ 才注入（@标题 / @标签 · 紫色）":
      "Global sources inject only when @-mentioned (@title / @tag · purple)",
    "预设（与智能会话一致）": "Preset (same as agent session)",
    "运行中的节点未改标题：": "Running nodes were not renamed: ",
    "紫晶 Amethyst": "Amethyst",
    "最近一次智能运行的统计": "Stats from the last agent run",
    "Base64 解码失败": "Base64 decode failed",
    "Base64 内容为空": "Base64 content is empty",
    "Base64 已生成（": "Base64 generated (",
    "DeepSeek 官方": "DeepSeek Official",
    "OUTPUT · 批量": "OUTPUT · Batch",
    "stdio（本地命令）": "stdio (local command)",
    " 个模型 · 接口地址 ": " models · endpoint ",
    "⤓ 保存文本（YAML）": "⤓ Save text (YAML)",
    "🐋 模型等待你的回应（": "🐋 Model is waiting for your reply (",
    "保存节点（接收最终输出）": "Save Node (receives final output)",
    "不能删除正在运行的节点：": "Cannot delete a running node: ",
    "从服务商目录选择（推荐）": "Pick from provider catalog (recommended)",
    "弹窗大窗显示输出 GIF": "Open output GIF in a large popup",
    "工作区读写 · 逐项审批": "Workspace read/write · Approve each",
    "画布包已损坏（清单越界）": "Canvas pack is corrupt (manifest out of range)",
    "默认模型（智能能力使用）": "Default model (for agent capability)",
    "批量输入的处理方式切换：": "Switch how batch input is processed: ",
    "其他（自定义回答，选填）": "Other (custom reply, optional)",
    "删除该组（连同内部节点）": "Delete this group (including inner nodes)",
    "删除节点（Delete）": "Delete node (Delete)",
    "图像保存节点需要图像来源": "Image save node needs an image source",
    "文本保存节点需要文本来源": "Text save node needs a text source",
    "下载图像失败 HTTP ": "Image download failed HTTP ",
    "选择 YAML 保存位置": "Choose YAML save location",
    "选择文本文件（文件参考）": "Choose text file (file reference)",
    "月光 Moonlight": "Moonlight",
    "在文件夹中显示已保存文件": "Show saved file in folder",
    "OUTPUT · 运行中": "OUTPUT · Running",
    " ────\n（文件不存在）": " ────\n(File not found)",
    " 个 YAML 文件 → ": " YAML files → ",
    "。添加后自动生成模型列表。": ". Model list is generated automatically once added.",
    "（等待上游输出…）内容只读": "(Waiting for upstream output…) content is read-only",
    "（等待上游输出中）内容只读": "(Waiting for upstream output) content is read-only",
    /* ── 节点浏览态 · 超长文本护栏 + 文本预览窗 👁（app-nodeview.js / app-canvas.js / app-textpreview.js） ── */
    "超大文本 · 轻量显示 · {n} 字符": "Very long text · lightweight view · {n} chars",
    " · 点上方 👁 看全文": " · click 👁 above for the full text",
    "超大输出 · 轻量显示 · {n} 字符 · 点上方 👁 预览全文":
      "Very long output · lightweight view · {n} chars · click 👁 above for the full text",
    "预览全文：在只读大窗里完整阅读本节点文本（可复制，不改内容）":
      "Preview full text: read this node's text in a read-only window (copyable, content unchanged)",
    "文本预览窗未就绪": "Text preview is not ready",
    "✕ 删除组（连同内部节点）": "✕ Delete group (including inner nodes)",
    "保存路径（*.md）…": "Save path (*.md)…",
    "标题不唯一，请改用 id：": "Title is not unique, use id instead: ",
    "拆分出的只读节点，不可修改": "Split-out read-only node, cannot be edited",
    "拆分节点仅接受 1 个输入": "Split node accepts only 1 input",
    "从服务商目录选择或手动配置": "Pick from provider catalog or configure manually",
    "弹出文件夹窗口选择工作目录": "Open a folder dialog to choose the working directory",
    "弹窗大窗显示本节点输出内容": "Show this node's output in a large popup",
    "该节点已继承输入，内容只读": "This node inherited input; content is read-only",
    "回车确认 · Esc 取消": "Enter to confirm · Esc to cancel",
    "接口地址 Base URL": "Endpoint Base URL",
    "目录暂不可用（引擎未连接）": "Catalog unavailable (engine not connected)",
    "取消归档,回到对应目录分组": "Unarchive, return to its folder group",
    "输出端子（输出本节点内容）": "Output port (outputs this node's content)",
    "拖动移动组 · 双击重命名": "Drag to move group · Double-click to rename",
    "文件太小，不是有效的画布包": "File too small; not a valid canvas pack",
    "已保存聚合 YAML → ": "Saved aggregate YAML → ",
    "引用聚合条目（@条目标题）": "Reference aggregate entries (@entry title)",
    "在浏览器中打开主页与下载页": "Open homepage and download page in browser",
    "暂无技能（在上方表单创建）": "No skills yet (create with the form above)",
    "粘贴 Base64 内容…": "Paste Base64 content…",
    "API Key（隐藏显示）": "API Key (hidden)",
    " 个，切换即加载并加入标签）": " total; switching loads it and adds a tab)",
    "（空闲，连接后自动新增一个）": "(Idle; a new one is added automatically after connecting)",
    "（空闲：这条端子还没接线，连上即注入该端子）": "(Idle: nothing wired to this port yet — connect into it to feed it)",
    "⧉ 合并（多节点 → 批次）": "⧉ Merge (multiple nodes → batch)",
    "拆分出的只读节点（不可编辑）": "Split-out read-only node (not editable)",
    "复制选中节点（Ctrl+C）": "Copy selected nodes (Ctrl+C)",
    "画布包含无法序列化的数据：": "Canvas contains data that cannot be serialized: ",
    "留空 = 应用默认数据目录…": "Leave empty = app default data directory…",
    "停止回复（立即中止模型请求）": "Stop reply (abort the model request immediately)",
    "停止运行（立即中止模型请求）": "Stop run (abort the model request immediately)",
    "图像保存节点需要一个图像输入": "Image save node needs one image input",
    /* ── 保存节点「图像输出」（renderer/app-imageout.js + css/components.css）──
       尺寸 / 裁剪 / 格式 / 质量那一整块，默认档＝原样复制 */
    "图像输出 · 尺寸 / 裁剪 / 格式 / 质量":
      "Image output · size / crop / format / quality",
    "图像输出：尺寸 / 裁剪 / 格式 / 质量": "Image output: size / crop / format / quality",
    "图像输出（尺寸 / 裁剪 / 格式 / 质量）": "Image output (size / crop / format / quality)",
    "图像输出设定…": "Image output settings…",
    "原样：不缩放，沿用输入图像的像素尺寸（默认）":
      "As-is: no scaling, keep the input pixel size (default)",
    "按比例缩放：等比例采样放大 / 缩小，长宽比不变":
      "Scale by ratio: resample up / down, aspect ratio kept",
    "自定义尺寸：直接指定输出像素宽高（可单独填一侧，另一侧按原比例）":
      "Custom size: set output pixel width / height (fill one side to keep the original ratio)",
    "缩放比例（% · 等比例采样）": "Scale (%) · proportional resample",
    "输出像素宽 × 高": "Output pixel width × height",
    "不裁剪：整幅输出（默认）": "No crop: keep the whole frame (default)",
    "从中间裁：按目标长宽比取源图中央最大的那一块":
      "Crop center: take the largest centered rect matching the target ratio",
    "自定义矩形：按源图像素指定 x / y / 宽 / 高":
      "Custom rect: x / y / width / height in source pixels",
    "裁剪矩形（源图像素 x / y / 宽 / 高）":
      "Crop rect (source pixels x / y / w / h)",
    "PNG · 无损，支持透明背景（默认）":
      "PNG · lossless, keeps transparency (default)",
    "JPG · 有损压缩，体积小；不支持透明（透明区自动填白）":
      "JPG · lossy, small; no transparency (transparent areas filled white)",
    "JPEG · 与 JPG 相同（后缀写 .jpg）": "JPEG · same as JPG (file suffix .jpg)",
    "WebP · 有损压缩，体积最小；不支持透明（透明区自动填白）":
      "WebP · lossy, smallest; no transparency (transparent areas filled white)",
    "BMP · 未压缩位图，体积大；不支持透明（透明区自动填白）":
      "BMP · uncompressed bitmap, large; no transparency (transparent areas filled white)",
    "质量（仅 JPG / WebP 有损压缩生效）":
      "Quality (applies to lossy JPG / WebP only)",
    "质量 ": "Quality ",
    "尺寸 ": "Size ",
    "缩放 ": "Scale ",
    "居中裁剪": "center crop",
    "裁剪 ": "Crop ",
    "裁剪自源图 ": "cropped from ",
    "格式 ": "format ",
    "图像输出：已改过设定（尺寸 / 裁剪 / 格式 / 质量）":
      "Image output: custom settings (size / crop / format / quality)",
    /* 头部按钮的两个 hover 提示：渲染层里的字面量换行转义要在键里照样保留（\n），
       否则 key 对不上，英文界面会退回中文真源 */
    "图像输出：默认（原样复制，后缀按保存路径）\n\n可改尺寸（等比例缩放 / 自定义像素）、从中间或指定矩形裁剪、换格式（png / jpg / webp / bmp）、有损格式还能调质量。\n单击打开参数面板。":
      "Image output: default (copy as-is, suffix follows the save path)\n\nYou can change size (proportional scale / custom pixels), crop (center / custom rect), format (png / jpg / webp / bmp) and — for lossy formats — quality.\nClick to open the settings panel.",
    "图像输出：已改过设定（尺寸 / 裁剪 / 格式 / 质量）\n\n保存时先按这套设定裁剪、缩放、重编码，再写到你指定的路径。\n右键（或单击）打开参数面板。":
      "Image output: custom settings (size / crop / format / quality)\n\nOn save the image is cropped → scaled → re-encoded by these settings before writing to your path.\nClick (or right-click) to open the settings panel.",
    "图像输出设定未能应用（已按原样复制）：":
      "Image output settings could not be applied (copied as-is): ",
    "实际落盘：": "Actually written: ",
    "尚未设置保存路径（后缀 ": "No save path yet (suffix ",
    "尺寸（等比例缩放 / 自定义像素）、裁剪（从中间裁 / 指定矩形）、格式（png / jpg / webp / bmp）、有损压缩质量":
      "Size (proportional scale / custom pixels), crop (center / custom rect), format (png / jpg / webp / bmp), lossy quality",
    "恢复为「原样 + PNG」：与改动前的保存行为一致":
      "Back to “as-is + PNG”: same save behavior as before this feature",
    "默认「原样 + PNG」与改动前的保存行为完全一致；改设定后每个保存文件都会套用。":
      "Default “as-is + PNG” behaves exactly as before; once changed, every saved file uses the new setting.",
    "已恢复默认：原样 + PNG。": "Reset to default: as-is + PNG.",
    "还没有可预览的源图：先把图像接进来并保存一次，或让上游生成一张图。":
      "No source image to preview yet: connect an image and save once, or generate one upstream.",
    "预览失败：无法读取临时图像": "Preview failed: cannot read the temporary image",
    "正在生成预览…": "Building preview…",
    "图像编码失败": "Image encoding failed",
    "图像编码失败（浏览器不支持该格式）":
      "Image encoding failed (this format is unsupported here)",
    "图像写入失败": "Writing the image failed",
    "源图读取失败：": "Cannot read the source image: ",
    "保存节点接到图像输入时，先按这里的设定裁剪 → 缩放 → 重编码，再写到你指定的路径；默认「原样 + PNG」与原行为完全一致。多图 / 批量保存时每个文件都套同一套设定；聚合模式仍只写第一条中的第一张图。":
      "When a save node receives an image, it crops → scales → re-encodes by these settings before writing to your path; the default “as-is + PNG” matches the old behavior exactly. Multi-image / batch saves apply the same settings to every file; aggregate mode still writes only the first image of the first entry.",
    "拖拽移动节点（按住手柄拖动）": "Drag to move node (hold the handle)",
    "无可复制的文本（输出为图像）": "No text to copy (output is an image)",
    "新建会话(沿用当前工作目录)": "New session (keep current working directory)",
    "用法:/rename 新标题": "Usage: /rename new-title",
    "Industrial（默认）": "Industrial (Default)",
    "（空）— 输入中不存在所选项目": "(empty) — selected item does not exist in the input",
    "（请结合任务要求参考这些图像）": "(Please refer to these images in light of the task)",
    "）· 请检查网络或源地址后重试": ") · Check the network or source URL and retry",
    "尝试次数（1-10，默认 1）": "Attempts (1-10, default 1)",
    "弹出文件夹窗口选择统一工作目录": "Open a folder dialog to choose a shared working directory",
    "点击展开 / 收起模型思考过程": "Click to expand / collapse model thinking",
    "点击展开": "Click to expand",
    " · 点击查看": " · click to view",
    "点击收起": "Click to collapse",
    "复制本条到剪贴板": "Copy this message to clipboard",
    /* 消息最下方「复制 / 保存」动作条（app-assist.js dshMsgActionBar） */
    "复制代码（围栏已去掉）到剪贴板": "Copy the code (fences removed) to clipboard",
    "复制本条正文原文（Markdown / 代码）到剪贴板":
      "Copy this message's raw text (Markdown / code) to clipboard",
    "把本条内容另存为文件": "Save this message's content to a file",
    "保存消息内容": "Save message content",
    "代码文件": "Code files",
    "Markdown 文件": "Markdown files",
    "AI 回复": "AI reply",
    "我的输入": "My message",
    "当前环境不支持文件保存": "File saving is unavailable in this environment",
    "复制 API Key 到剪贴板": "Copy API Key to clipboard",
    "工具节点（批次拆分 / 合并）": "Tool Node (batch split / merge)",
    "画布已删除，已重建默认画布": "Canvas deleted; default canvas recreated",
    "画布已删除": "Canvas deleted",
    "画布已删除：": "Canvas deleted: ",
    /* 会话「所属画布」被删后开轮的明确错误（app.js wfOfCanvasIdForRun）：
       绝不静默漂到用户此刻正开着的另一张画布上 */
    "本会话所属画布已被删除": "This session's own canvas has been deleted",
    "本会话所属画布已被删除：": "This session's own canvas has been deleted: ",
    /* 前台视图动作（选中 / 撤销 / 重做）在本会话所属画布不在前台时明确拒绝，
       绝不替用户改动他正看着的那张图（app-nodes.js applyAppOp） */
    "该操作只作用于屏幕上正显示的画布：本会话所属画布当前不在前台，为避免改到你正在编辑的另一张图，已拒绝执行。":
      "This action only applies to the canvas shown on screen: this session's own canvas is not in the foreground, so it was refused to keep the other canvas you are editing untouched.",
    "会话列表边栏（按工作目录归类）": "Session list sidebar (grouped by working directory)",
    "技能已创建，智能节点可立即使用": "Skill created; agent nodes can use it immediately",
    "聚合：保存为 {路径}.png": "Aggregate: save as {path}.png",
    "内容符合 YAML，已解析为 ": "Content is valid YAML, parsed as ",
    "尚未保存（指定路径后点击 ▶）": "Not saved yet (set a path, then click ▶)",
    "图像保存节点仅接受 1 个输入": "Image save node accepts only 1 input",
    "一键居中：缩放并定位到全部节点": "Fit all: zoom and center on all nodes",
    "已开启:下一轮先制定计划再执行": "On: plan first, then execute next round",
    "API Key 已复制到剪贴板": "API Key copied to clipboard",
    "\n\n会话记录不可恢复，确定删除？": "\n\nSession history cannot be recovered. Delete?",
    "\n（以下请求将忽略图像输入）\n\n": "\n(The following request will ignore image input)\n\n",
    "。输入 /help 查看可用命令": ". Type /help to see available commands",
    "部分输入节点尚无文本输出，已跳过": "Some input nodes have no text output yet and were skipped",
    "处理节点（提示词 + Play）": "Process Node (prompt + Play)",
    "点击选择图像\n或拖拽文件到此节点": "Click to choose an image\nor drag a file onto this node",
    "发送消息（Ctrl+Enter）": "Send message (Ctrl+Enter)",
    "归档该会话(收起到底部已归档区)": "Archive this session (collapse into the archived section at the bottom)",
    "聚合输出：全部条目合并为一个文件": "Aggregate output: merge all entries into one file",
    "框选模式已开启：左键拖拽框选节点": "Marquee mode on: drag with left button to select nodes",
    "批量模式：逐条运行，输出批量结果": "Batch mode: run item by item, output batch results",
    "清空本节点输出（回到未处理状态）": "Clear this node's output (back to unprocessed)",
    "上下文分布 · 最近一次智能运行": "Context breakdown · Last agent run",
    "设置 · APIs/Config": "Settings · APIs/Config",
    "完全放行（不限目录 · 不询问）": "Full access (no directory limit · no prompts)",
    "一次最多连接 80 条线，已截断": "At most 80 wires per operation; truncated",
    "已复制 Base64 到剪贴板（": "Copied Base64 to clipboard (",
    "已扩展为智能会话（内容完全同步）": "Expanded to an agent session (content fully synced)",
    "预览：查看运行时将发送的完整请求": "Preview: inspect the full request that will be sent at runtime",
    "暂无运行统计,先发送一条消息再试": "No run stats yet; send a message first, then try again",
    "AI 画布编排：画布式节点编排": "AI canvas orchestration: canvas-based node graph",
    "）· 重新打开设置重试</div>": ") · Reopen Settings to retry</div>",
    "⧉ 拆分（批次 → 单项只读节点）": "⧉ Split (batch → per-item read-only nodes)",
    "插件（npm search 接口）": "Plugins (npm search API)",
    "插件（npm search 或 MTNode catalog）": "Plugins (npm search or MTNode catalog)",
    "工具调用轨迹（点击展开参数与结果）": "Tool-call trace (click to expand args and result)",
    "技能（jsDelivr repo）": "Skills (jsDelivr repo)",
    "技能（jsDelivr 或 MTNode catalog）": "Skills (jsDelivr or MTNode catalog)",
    "MCP（jsDelivr 或 MTNode catalog）": "MCP (jsDelivr or MTNode catalog)",
    "MTNode 目录（插件+技能+MCP）": "MTNode catalog (plugins + skills + MCP)",
    "请将图像文件拖到「图像输入节点」上": "Drag image files onto an \"Image Input Node\"",
    "筛选插件（按包名 / 行 id）…": "Filter plugins (by package name / row id)…",
    "思考强度（标准 / 最强）": "Thinking effort (Standard / Max)",
    "未解析到条目（格式：标题: 内容）": "No entries parsed (format: title: content)",
    "文件过大（超过 500KB，实际 ": "File too large (over 500KB, actual ",
    "一次最多创建 40 个节点，已截断": "At most 40 nodes created per operation; truncated",
    "一次最多更新 80 个节点，已截断": "At most 80 nodes updated per operation; truncated",
    "一句话描述（模型据此判断何时使用）": "One-line description (the model uses this to decide when to use it)",
    "运行：基于提示词与输入内容生成图像": "Run: generate an image from the prompt and input",
    "支持视觉（图片输入转为多模态消息）": "Vision (image input becomes multimodal messages)",
    "尚未填写 DeepSeek API Key": "DeepSeek API key not set yet",
    "首次使用请先在下方「提供商配置」里填入 Key；还没有余额可先到官方充值通道充值。":
      "Fill in your key under Provider configuration below to get started; if you have no balance yet, top up via the official channel first.",
    "DeepSeek 官方充值通道": "DeepSeek official top-up",
    "还没有 API Key？官方充值通道：": "No API key yet? Official top-up channel: ",
    "（在浏览器中打开）": " (opens in your browser)",
    "MTNode AI编排器 发生错误": "MTNode AI Orchestrator encountered an error",
    "⧗ 动画（图像 → GIF 帧动画）": "⧗ Anim (image → GIF frame animation)",
    "保存输出到本地（YAML / 图像）": "Save output locally (YAML / image)",
    "导出失败：画布包含无法序列化的数据": "Export failed: canvas contains data that cannot be serialized",
    "服务商（自动读取全局 API 配置）": "Provider (reads global API config automatically)",
    "横向缩放（仅改变横向布局，纵向不变）": "Scale horizontally (layout width only; height unchanged)",
    "请先指定保存路径（可用「浏览」选择）": "Set a save path first (use \"Browse\" to choose)",

    "未设置路径": "path not set",
    "文件不存在（生成后将显示于此）": "File not found (will appear here after generate)",
    "目标文件已存在，改为保存为：": "File exists — saving as: ",
    "输出路径（必填）": "Output path (required)",
    "未设置输出路径时无法启动生成": "Generation cannot start until an output path is set",
    "请先在节点设置中指定输出路径（可用「浏览」选择）":
      "Set an output path in node settings first (use \"Browse\" to choose)",
    "输出路径（必须设置，": "Output path (required, ",
    "生成前必须设置输出文件路径；相对路径需先设置顶栏工作目录":
      "Output file path is required before generate; relative paths need the workspace bar set",
    "固定节点无法删除（起点 / 终点）": "Pinned nodes cannot be deleted (start / end)",
    "已跳过固定节点（起点 / 终点）": "Skipped pinned nodes (start / end)",
    "固定节点无法删除（起点 / 终点 / 绑定保存）": "Pinned nodes cannot be deleted (start / end / bound save)",
    "已跳过固定节点（起点 / 终点 / 绑定保存）": "Skipped pinned nodes (start / end / bound save)",
    "已安装插件（点击展开查看 / 管理）": "Installed plugins (click to expand / manage)",
    "已请求中断本次运行": "Stop requested for this run",
    "已请求中断本次运行…": "Stop requested for this run…",
    "终止本会话当前运行（只停这一路）": "Stop this session's run (only this one; other sessions keep going)",
    "已请求中断(引擎正在重启该工作目录)": "Interrupt requested (engine is restarting this working directory)",
    "直接删除该会话(提示确认,不可撤销)": "Delete this session (asks for confirmation; cannot be undone)",
    "终止当前任务(重启该工作目录的引擎)": "Stop current task (restart the engine for this working directory)",
    "纵向缩放（仅改变纵向布局，横向不变）": "Scale vertically (layout height only; width unchanged)",
    "MCP 服务器已添加，引擎重启后生效": "MCP server added; takes effect after engine restart",
    " 条批量 · 点击关闭，仅显示原始内容": " batch items · Click to close, show raw content only",
    "不是有效的 .mtnodes 画布文件": "Not a valid .mtnodes canvas file",
    "当前聚合 → 点击改为批量（逐条运行）": "Currently Aggregate → click to switch to Batch (run item by item)",
    "工作目录（可留空 = 应用数据目录）…": "Working directory (leave empty = app data directory)…",
    "请求预览 · 运行时将发送以下完整请求": "Request preview · the following full request will be sent at runtime",
    "删除节点将一并删除其关联的智能会话：\n": "Deleting the node will also delete its linked agent session:\n",
    "统一目录(留空 = 各节点单独设置)…": "Shared directory (leave empty = per-node settings)…",
    "未配置服务商（设置 · API/配置）": "No provider configured (Settings · API/Config)",
    "温度 Temperature（0-2）": "Temperature (0-2)",
    "系统提示词 System Prompt": "System Prompt",
    "需要图像输入（图像节点或图像生成节点）": "Requires image input (Image Node or image generation node)",
    "已请求中断,正在重启该工作目录的引擎…": "Interrupt requested; restarting the engine for this working directory…",
    "已请求终止,正在重启该工作目录的引擎…": "Stop requested; restarting the engine for this working directory…",
    "运行：基于提示词与输入内容调用文本模型": "Run: call a text model with the prompt and input",
    "暂无 MCP 服务器（在上方表单添加）": "No MCP servers yet (add with the form above)",
    "组已选中：再次点击解散该组（节点保留）": "Group selected: click again to ungroup (nodes kept)",
    "○ 未处理 · 点击 ▶ 描述任务并运行": "○ Idle · Click ▶ to describe the task and run",
    "保存路径（*.png / *.jpg）…": "Save path (*.png / *.jpg)…",
    "点击选择图像，或直接拖拽图像文件到节点上": "Click to choose an image, or drag image files onto the node",
    "画布已设置统一工作目录,本节点只读继承": "Canvas has a shared working directory; this node inherits it read-only",
    "关闭标签（仅从标签条移除，不删除画布）": "Close tab (remove from the tab bar only; does not delete the canvas)",
    "扩展为智能会话(节点与会话内容完全同步)": "Expand to agent session (node and session content stay fully synced)",
    "未配置接口地址（设置 · API/配置）": "No endpoint configured (Settings · API/Config)",
    "无人值守（工作区读写 · 沙箱拒绝时询问，默认）": "Unattended (workspace read/write · asks when the sandbox denies, default)",
    "在线浏览 · 插件 / 技能 / MCP": "Browse online · Plugins / Skills / MCP",
    "暂无插件（在上方输入 npm 包名安装）": "No plugins yet (enter an npm package name above to install)",
    "create 项缺少 alias，已跳过": "create item missing alias, skipped",
    "npm 包名，例如 @scope/pkg": "npm package name, e.g. @scope/pkg",
    "URL 需以 http(s):// 开头": "URL must start with http(s)://",
    "○ 等待输入（每个输入 = 批次中的一项）": "○ Waiting for input (each input = one item in the batch)",
    "标题（YAML 字段名 / 输出文件后缀）": "Title (YAML field name / output filename suffix)",
    "点击查看模型思考与工具调用过程（流式显示）": "Click to view model thinking and tool calls (streamed)",
    "服务器名（1-32 位字母/数字/_/-）": "Server name (1-32 letters/digits/_/-)",
    "尚无智能运行统计（运行智能任务后在此显示）": "No agent run stats yet (shown here after an agent task runs)",
    "输入 API Key（隐藏显示，仅存本机）": "Enter API Key (hidden; stored on this machine only)",
    "选择服务商后自动载入其模型列表与接口地址。": "Selecting a provider loads its model list and endpoint automatically.",
    "智能节点（读文件 / 联网 / 执行命令）": "Agent Node (read files / network / run commands)",
    "」· 点击切换（无 / 低 / 中 / 高 / 最强）": "\" · Click to cycle (Off / Low / Medium / High / Max)",
    "本次智能运行的统计（与 dsh 客户端一致）": "Stats for this agent run (same as the dsh client)",
    "复制该会话为新会话(参考 dsh fork)": "Duplicate this session as a new one (like dsh fork)",
    /* ── 会话行内删除（app-assist.js · 两下确认 + 悬停恢复） ── */
    "删除该会话（点两下确认，不可撤销）": "Delete this session (click twice to confirm; cannot be undone)",
    "再点一下即删除该会话，记录不可恢复": "Click once more to delete this session; the record cannot be recovered",
    "运行中的会话不能分支，请等待完成或先终止": "Cannot fork a running session; wait for it to finish or stop it first",
    "已有其他会话在运行，请等待其完成或先终止": "Another session is running; wait for it to finish or stop it first",
    "技能内容（Markdown，模型按此执行）…": "Skill content (Markdown; the model follows this)…",
    "聚合：全部条目合并保存为 {路径}.yaml": "Aggregate: merge all entries and save as {path}.yaml",
    "框选模式已开启：左键拖拽即可框选（再点关闭）": "Marquee mode on: drag with left button to select (click again to turn off)",
    "请先框选 / 选中节点（所选节点不能在组内）": "Marquee / select nodes first (selected nodes must not be inside a group)",
    "上下文用量(最近一次运行的输入 token)": "Context usage (input tokens of the last run)",
    "图像 · Midjourney（自定义接口）": "Image · Midjourney (custom API)",
    "暂无条目 · 添加图像或拖拽多张图像到节点上": "No entries yet · Add images or drag multiple images onto the node",
    "智能助手（可读文件 / 联网 / 执行命令）": "Agent assistant (can read files / network / run commands)",
    "子目录（可选，技能/MCP 的列表所在目录）": "Subdirectory (optional; folder that lists skills/MCP)",
    "Agent 预设（智能能力的角色与行为风格）": "Agent preset (role and behavior style for agent capability)",
    "MCP 服务器（jsDelivr repo）": "MCP servers (jsDelivr repo)",
    "【要求】先制定并展示分步计划,再开始执行。\n\n": "[Requirement] First make and show a step-by-step plan, then start executing.\n\n",
    "○ 未处理 · 点击 ▶ 基于提示词+输入处理": "○ Idle · Click ▶ to process from prompt + input",
    "⚠ 本画布包含图像等多媒体资产或体积较大（约 ": "⚠ This canvas contains media assets such as images, or is large (about ",
    "从文件导入条目（field=标题，内容=内容）": "Import entries from file (field=title, content=content)",
    "导入 YAML（field=标题，内容=内容）": "Import YAML (field=title, content=content)",
    "暂无条目 · 点击下方按钮添加或导入 YAML": "No entries yet · Click the button below to add or import YAML",
    "MCP 服务器（stdio，经 npx 运行）": "MCP servers (stdio, run via npx)",
    "streamable-http（远程 URL）": "streamable-http (remote URL)",
    "🐋 智能任务（读文件 / 联网 / 执行命令）": "🐋 Agent task (read files / network / run commands)",
    "合并节点：每个输入 = 批次中的一项，输出为批次": "Merge node: each input = one item in the batch; output is a batch",
    "技能（安装时从 CDN 拉取 SKILL.md）": "Skills (fetches SKILL.md from CDN on install)",
    "批量：保存为 {路径}_{输入节点标题}.png": "Batch: save as {path}_{input node title}.png",
    "批量输出：按 {文件名}_{输入节点标题} 命名": "Batch output: named {filename}_{input node title}",
    "Enter 换行 · Ctrl+Enter 发送": "Enter newline · Ctrl+Enter send",
    "」不支持识图。以下已保存的视觉模型可选，是否改用？": "\" does not support vision. Switch to one of the saved vision models below?",
    "插件（扩展 agent 能力；安装后自动重启引擎）": "Plugins (extend agent capability; engine restarts automatically after install)",
    "导入画布：从 .mtnodes 文件恢复完整画布": "Import canvas: restore a full canvas from a .mtnodes file",
    "该源不是 jsDelivr repo，无法安装技能": "This source is not a jsDelivr repo; cannot install skills",
    "该源无法安装技能（需要 jsDelivr 或 MTNode catalog）": "This source cannot install skills (needs jsDelivr or an MTNode catalog)",
    "命令（如 npx.cmd 或 node 完整路径）": "Command (e.g. npx.cmd or a full node path)",
    "批量：保存为 {路径}_{输入节点标题}.yaml": "Batch: save as {path}_{input node title}.yaml",
    "任务描述（@ 引用输入节点 · 输入内容自动附加）": "Task description (@ to reference input nodes · input is attached automatically)",
    "如 skills 或 src；留空 = 仓库根目录": "e.g. skills or src; leave empty = repo root",
    "重做（Ctrl+Y / Ctrl+Shift+Z）": "Redo (Ctrl+Y / Ctrl+Shift+Z)",
    "复制节点（Ctrl+D）：在选中节点下方复制一个同类节点，仅复制类型、不复制内容":
      "Duplicate node (Ctrl+D): create a same-type node below the selected one — type only, no content",
    "助手可读写此目录下的文件；留空使用应用默认数据目录": "The assistant can read/write files in this directory; leave empty to use the app default data directory",
    "Enter 发送 · Shift+Enter 换行": "Enter send · Shift+Enter newline",
    "技能 Skills（安装后智能节点可自动发现并使用）": "Skills (agent nodes can discover and use them after install)",
    "聚合模式：所有条目作为独立输入一次运行，输出单个结果": "Aggregate mode: all entries are independent inputs in one run, outputting a single result",
    "尚未保存（指定路径后点击 ▶，预览显示所保存的图像）": "Not saved yet (set a path, then click ▶; preview shows the saved image)",
    "输入任务后点击 ▶ 发送；历史对话将保留在此（只读）": "Enter a task and click ▶ to send; chat history stays here (read-only)",
    "：点击切换查看该次结果，后续节点引用当前选中的尝试内容": ": click to view that result; downstream nodes use the currently selected attempt",
    "当前聚合（合并为一个文件）→ 点击改为批量（逐项保存）": "Currently Aggregate (merge into one file) → click to switch to Batch (save per item)",
    "当前批量（逐项保存）→ 点击改为聚合（合并为一个文件）": "Currently Batch (save per item) → click to switch to Aggregate (merge into one file)",
    "拖拽左侧边缘调整输出面板宽度（← 拉宽 · → 收窄）": "Drag the left edge to resize the output panel (← wider · → narrower)",
    "以下为模型生成该条回复前的思考内容（随对话记录保存）。": "Thinking content generated before this reply (saved with the chat log).",
    "整体缩放（横竖可分别拉伸；成员达到最小尺寸后停止缩放）": "Scale overall (stretch axes independently; stops when a member hits minimum size)",
    "执行(Enter 发送,Shift+Enter 换行)": "Run (Enter send, Shift+Enter newline)",
    "智能能力可读写此目录下的文件；留空使用应用默认数据目录": "Agent capability can read/write files in this directory; leave empty to use the app default data directory",
    "MCP 服务器（连接后智能节点自动获得该服务器的工具）": "MCP servers (agent nodes get this server's tools after connecting)",
    "<a href=\"#\" title=\"已阻止不安全链接\"": "<a href=\"#\" title=\"Blocked unsafe link\"",
    "已阻止不安全链接": "Blocked unsafe link",
    "点击打开": "Click to open",
    "预览": "Preview",
    "YAML 阅读器": "YAML Reader",
    "Markdown 阅读器": "Markdown Reader",
    "编辑模式：Ctrl+S 保存": "Editing — press Ctrl+S to save",
    /* Markdown 阅读器 · 所见即所得直接编辑（renderer/app.js buildMdViewerRichEditor /
       mdViewerRichAct / applyMdViewerChrome）：切档按钮、底栏状态与编辑工具栏。 */
    "所见即所得": "WYSIWYG",
    "查看 / 编辑 Markdown 源码": "View / edit the Markdown source",
    "回到所见即所得直接编辑": "Back to WYSIWYG direct editing",
    "源码模式 · Ctrl+S 保存": "Source mode · press Ctrl+S to save",
    "编辑模式：所见即所得 · Ctrl+S 保存":
      "Editing — WYSIWYG, press Ctrl+S to save",
    "链接地址（https://…）": "Link URL (https://…)",
    "链接": "Link",
    "一级标题": "Heading 1",
    "二级标题": "Heading 2",
    "三级标题": "Heading 3",
    "正文段落": "Paragraph",
    "加粗": "Bold",
    "斜体": "Italic",
    "删除线": "Strikethrough",
    "引用": "Quote",
    "无序列表": "Bullet list",
    "有序列表": "Numbered list",
    "行内代码": "Inline code",
    "代码块": "Code block",
    "水平线": "Horizontal rule",
    "编辑并保存此文件（Ctrl+S 保存）": "Edit and save this file (Ctrl+S to save)",
    "写回文件（Ctrl+S）": "Write back to file (Ctrl+S)",
    "放弃修改，回到预览": "Discard changes and return to preview",
    " 个标题": " headings",
    "用阅读器打开（Markdown / YAML · 可编辑保存）": "Open in reader (Markdown / YAML · editable)",
    "点击用阅读器打开（Markdown / YAML · 可编辑保存）": "Click to open in reader (Markdown / YAML · editable)",
    "打开该文件节点对应的文件（Markdown / YAML 用应用内阅读器 · 可编辑保存；其余用系统默认方式打开）": "Open this file node's file (Markdown / YAML open in the in-app reader · editable; others open with the system default)",
    "大纲": "Outline",
    "隐藏大纲": "Hide outline",
    "显示大纲": "Show outline",
    "换行": "Wrap",
    "取消自动换行": "Disable wrap",
    "自动换行": "Wrap lines",
    "刷新": "Reload",
    "重新加载文件": "Reload file",
    "复制全文": "Copy all",
    "在文件夹中显示": "Show in folder",
    "拖拽调整大小": "Drag to resize",
    "用 YAML 阅读器打开": "Open in YAML reader",
    "点击用 YAML 阅读器打开": "Click to open in YAML reader",
    "无大纲条目": "No outline entries",
    " 个键": " keys",
    " 行": " lines",
    "行号": "Line",
    "打开": "Open",
    "无法打开链接：": "Cannot open link: ",
    "无法打开路径": "Cannot open path",
    "无法打开路径：": "Cannot open path: ",
    "点击切换查看对应尝试结果，下游节点引用当前选中的尝试内容": "Click to view that attempt's result; downstream nodes use the currently selected attempt",
    "该服务商未填写 API Key（设置 · API/配置）": "This provider has no API Key (Settings · API/Config)",
    "未找到可用文本服务商（请在设置 · API/配置中配置并填写 API Key）":
      "No text provider available (configure one with an API Key in Settings · API/Config)",
    "未找到可用模型（请在设置中选择该服务商的模型）":
      "No model available (pick a model for this provider in Settings)",
    "未找到可用模型（请在节点设置中选择该服务商的模型）":
      "No model available (pick a model for this provider in the node settings)",
    "例如：将输入内容总结为三句话… 输入 @ 引用已连接节点": "e.g. Summarize the input in three sentences… type @ to reference connected nodes",
    "例如：将输入内容总结为三句话… 输入 @ 引用已连接节点 · 输入 / 或 、 呼出技能":
      "e.g. Summarize the input in three sentences… type @ to reference connected nodes · type / or 、 for skills",
    "运行智能任务：模型可读文件 / 联网 / 执行命令后完成": "Run agent task: the model can read files / network / run commands, then finish",
    "智能能力（DeepSeek Harness / dsh）": "Agent capability (DeepSeek Harness / dsh)",
    "当前批量 → 点击改为聚合（所有条目作为独立输入一次运行）": "Currently Batch → click to switch to Aggregate (all entries as independent inputs in one run)",
    "技能名（kebab-case，如 pdf-summary）": "Skill name (kebab-case, e.g. pdf-summary)",
    "例如：赛博朋克城市夜景… 输入 @ 引用已连接节点/参考图": "e.g. Cyberpunk city at night… type @ to reference connected nodes/reference images",
    "描述任务…（Enter 换行，Ctrl+Enter 发送）": "Describe the task… (Enter newline, Ctrl+Enter send)",
    "任务完成音效（仅当智能任务运行超过 5 分钟后完成时触发）": "Task completion sound (only when an agent task finishes after running more than 5 minutes)",
    /* 设置 · 智能能力：精简工具负载（工具可见集裁剪，见 docs/codex-agent-benchmark.md） */
    "精简工具负载（不注册「应用操作 / 识图子代理」等可选工具，每步少发约 4.7K 字符；下一轮运行生效）": "Lean tool payload (do not register optional tools such as app control / vision subagent; about 4.7K fewer characters per step; takes effect on the next run)",
    "输入消息…（Enter 换行，Ctrl+Enter 发送）": "Enter a message… (Enter newline, Ctrl+Enter send)",
    "以下为模型运行时的思考内容（仅保留在内存中，不写入存档）。": "Thinking content during the model run (kept in memory only; not written to the archive).",
    "由拆分节点生成的只读节点：标题为原批次项名，内容为该项内容": "Read-only node created by a Split node: title is the original batch item name, content is that item",
    "智能会话：全屏 agent 会话画布（等于常驻的智能任务）": "Agent session: full-screen agent session canvas (a persistent agent task)",
    "npm 镜像 registry.npmmirror.com": "npm mirror registry.npmmirror.com",
    "开启批量模式：以多个「标题+内容」条目运行，下游自动批量处理": "Enable batch mode: run with multiple \"title+content\" entries; downstream processes as a batch automatically",
    "描述任务…（Enter 发送，Shift+Enter 换行）": "Describe the task… (Enter send, Shift+Enter newline)",
    "描述任务…（Enter 发送，Shift+Enter 换行；输入 / 呼出技能）":
      "Describe the task… (Enter send, Shift+Enter newline; type / for skills)",
    "描述任务…（Enter 换行，Ctrl+Enter 发送；输入 / 呼出技能）":
      "Describe the task… (Enter newline, Ctrl+Enter send; type / for skills)",
    "描述任务…（输入 / 呼出技能，@ 引用已连接节点）":
      "Describe the task… (type / for skills, @ to reference connected nodes)",
    "任务（输入 / 呼出技能 · @ 引用输入节点）":
      "Task (type / for skills · @ to reference inputs)",
    "输入消息…（Enter 发送，Shift+Enter 换行）": "Enter a message… (Enter send, Shift+Enter newline)",
    "图像 · Stability AI（v2beta core）": "Image · Stability AI (v2beta core)",
    "YAML 解析已关闭：仅显示原始内容 · 点击恢复为批量条目": "YAML parsing is off: showing raw content only · Click to restore as batch entries",
    "模型列表，逗号分隔，如 gpt-4o-mini, gpt-4o": "Model list, comma-separated, e.g. gpt-4o-mini, gpt-4o",
    "提示词 Prompt（@ 引用输入节点 · 输入内容自动附加）": "Prompt (@ to reference input nodes · input is attached automatically)",
    "提示词 Prompt（@ 引用输入节点 · 输入 / 呼出技能）": "Prompt (@ to reference input nodes · type / for skills)",
    "未配置 API Key（请在「设置 · API/配置」中填写）": "No API Key configured (fill it in \"Settings · API/Config\")",
    "在线浏览:线上目录(插件 / 技能 / MCP),可安装与卸载": "Browse online: online catalog (Plugins / Skills / MCP), install and uninstall",
    "组：把选中的节点组成一个组（快捷键 G）；选中组后再次点击解散": "Group: group selected nodes (shortcut G); click again when a group is selected to ungroup",
    "从剪贴板读取 YAML（field=标题，内容=内容）并写入条目": "Read YAML from clipboard (field=title, content=content) and write as entries",
    "文本 · OpenAI 兼容（chat/completions）": "Text · OpenAI-compatible (chat/completions)",
    "</b> 及其全部本地数据文件（含节点图像资产）。此操作不可恢复。": "</b> and all of its local data files (including node image assets). This cannot be undone.",
    "模型正在思考，内容流式显示中…（模型支持思考时自动出现此弹窗入口）": "The model is thinking; content is streaming… (this popup entry appears automatically when the model supports thinking)",
    "输入下一条指令…（Enter 发送，Shift+Enter 换行）": "Enter the next instruction… (Enter send, Shift+Enter newline)",
    "文件参考：导入文本文件内容到本节点": "File reference: import a text file into this node",
    "），Base64 会明显膨胀，建议改用「导出为文件」以保证完整可靠。": "), Base64 will expand significantly; use \"Export as file\" instead for a complete, reliable copy.",
    "运行：把输入图像按网格（行×列）切割成 GIF 帧动画，支持透明色键": "Run: slice the input image on a grid (rows×cols) into a GIF frame animation; chroma key supported",
    "主页 · 下载 http://mt-agent.com/mtnode": "Home · Download http://mt-agent.com/mtnode",
    "框选模式：开启后左键拖拽框选节点（也可随时按住 Ctrl+左键 框选）": "Marquee mode: when on, drag with left button to select nodes (or hold Ctrl+left-click anytime)",
    "选择导入方式：从 .mtnodes 文件，或粘贴 Base64 内容。": "Choose import method: from a .mtnodes file, or paste Base64 content.",
    "自定义音效文件（mp3 / wav / ogg，留空 = 内置提示音）": "Custom sound file (mp3 / wav / ogg; leave empty = built-in chime)",
    "点击 ▶ 将输入图像按网格均匀切割为 GIF 帧动画（依次行、从左到右）": "Click ▶ to slice the input image evenly on a grid into a GIF frame animation (row by row, left to right)",
    "运行智能任务：提示词成为任务，模型可读文件 / 联网 / 执行命令后完成": "Run agent task: the prompt becomes the task; the model can read files / network / run commands, then finish",
    "点击切换查看对应尝试的结果，<b>下游节点引用当前选中的尝试内容</b>。": "Click to view that attempt's result; <b>downstream nodes use the currently selected attempt</b>.",
    "该节点已连接输入：内容只读，自动继承输入内容（符合 YAML 则转为批量）": "This node has connected input: content is read-only and inherited automatically (valid YAML becomes a batch)",
    "输出文件路径（批量模式下自动生成 {文件名}_{输入节点标题} 系列文件）": "Output file path (in batch mode, generates {filename}_{input node title} series files automatically)",
    "MTNode AI编排器 · MTNode AI Orchestrator": "MTNode AI Orchestrator",
    "<div class=\"dsh-plugin-empty\">插件列表不可用（": "<div class=\"dsh-plugin-empty\">Plugin list unavailable (",
    "尺寸 Size（gpt-image-2-vip · auto 或 30 档）": "Size (gpt-image-2-vip · auto or 30 presets)",
    "描述任务…（Enter 换行，Ctrl+Enter 发送；/ 开头输入命令）": "Describe the task… (Enter newline, Ctrl+Enter send; / to start a command)",
    "添加自定义在线源(插件搜索接口 / jsDelivr repo),以标签切换": "Add a custom online source (plugin search API / jsDelivr repo), switch with tabs",
    "添加自定义在线源（MTNode catalog.json / npm search / jsDelivr），以标签切换": "Add a custom online source (MTNode catalog.json / npm search / jsDelivr), switch with tabs",
    "描述任务…（Enter 发送，Shift+Enter 换行；/ 开头输入命令）": "Describe the task… (Enter send, Shift+Enter newline; / to start a command)",
    "权限预设（沙箱模式 + 审批策略；“逐项审批”档位会在任务需要越权时弹窗询问）": "Permission preset (sandbox mode + approval policy; \"Approve each\" prompts when a task needs extra permission)",
    "输入变化时自动保存（批量 = 每条目一个文件，YAML 项 = 输入节点标题）": "Auto-save on input change (batch = one file per entry; YAML item = input node title)",
    "未配置带 API Key 的文本服务商（设置 · API/配置 → 模型服务）": "No text provider with an API Key configured (Settings · API/Config → Model services)",
    " · 右键画布添加节点 · 拖线连接节点 · Ctrl+拖拽框选 · 滚轮缩放画布": " · Right-click the canvas to add a node · Drag wires to connect nodes · Ctrl+drag to marquee-select · Scroll to zoom the canvas",
    "【压缩任务】把以下对话压缩为一段简明摘要,保留任务目标、关键结论与未完成事项:\n\n": "[Compact task] Compress the following conversation into a concise summary, keeping the goal, key conclusions, and unfinished items:\n\n",
    "响应无图像数据（请检查自定义接口返回格式：{image: url|base64}）": "Response has no image data (check the custom API return format: {image: url|base64})",
    "APIs/Config 全局配置：API Key 与接口地址，所有模型节点自动读取": "APIs/Config global settings: API Key and endpoint; all model nodes read them automatically",
    "例如：读取 E:\\素材 下的全部 txt 并汇总成大纲，保存为 summary.md": "e.g. Read all txt files under E:\\assets and summarize into an outline, save as summary.md",
    "图像 · OpenAI 兼容（images/generations / edits）": "Image · OpenAI-compatible (images/generations / edits)",
    "」？\n\n该操作不可撤销，会话记录将全部丢失。关联的智能任务节点会保留（断开会话关联）。": "\"?\n\nThis cannot be undone; all session history will be lost. Linked agent-task nodes are kept (session link is broken).",
    "导出画布：把当前画布（含图像等资产）打包为 .mtnodes 文件，可迁移到其他电脑": "Export canvas: pack the current canvas (including image assets) into a .mtnodes file, which you can move to another computer",
    "多次尝试：并行运行 N 次（1-10）。N>1 时输出面板出现 1..N 方块 Tab，": "Multi-attempt: run N times in parallel (1-10). When N>1, 1..N square tabs appear on the output panel,",
    "多次尝试：并行运行 N 次（1-10）。N>1 时输出下方出现 1..N 方块 Tab，": "Multi-attempt: run N times in parallel (1-10). When N>1, 1..N square tabs appear below the output,",
    "未添加多模态模型（请在设置中为该文本服务商勾选「支持视觉」，并选择支持识图的多模态模型）": "No multimodal model added (in Settings, enable \"Vision\" for this text provider and choose a multimodal model that supports images)",
    "设置后,本画布创建的所有智能节点都固定使用该工作目录(节点内只读);留空则每个节点单独设置": "Once set, all agent nodes created on this canvas use this working directory (read-only inside the node); leave empty to set each node separately",
    "智能模式：提示词成为任务，模型可读文件 / 联网 / 执行命令后完成（需配置文本服务商，见帮助）": "Agent mode: the prompt becomes the task; the model can read files / network / run commands, then finish (requires a text provider; see Help)",
    "</b> 个节点组成一个组（快捷键 G）。组标题仅用于显示；点击组框可整体移动 / 缩放 / 删除。": "</b> nodes into a group (shortcut G). The group title is display-only; click the group box to move / scale / delete it as a whole.",
    "文件方式适合含图像或体积较大的画布；Base64 适合纯文本小画布，可复制到剪贴板后粘贴到另一台客户端。": "File export is better for canvases with images or large size; Base64 is better for small text-only canvases—copy to the clipboard and paste into another client.",
    "参数（空格分隔，如 -y @modelcontextprotocol/server-filesystem）": "Args (space-separated, e.g. -y @modelcontextprotocol/server-filesystem)",
    "确认后将一直使用该供应商 / 模型处理本节点的图像任务（在节点 API 面板更换供应商或模型后重新询问）。": "After confirming, this provider / model will always be used for this node's image tasks (you will be asked again if you change the provider or model in the node's API panel).",
    "<div class=\"dsh-plugin-empty\">安装中（需要联网，可能需要几分钟）…</div>": "<div class=\"dsh-plugin-empty\">Installing (needs network; may take a few minutes)…</div>",
    "这是<b>智能会话</b>画布:可读文件 / 联网 / 执行命令，也可修改当前画布（会弹窗确认，拒绝即停止）。画布上的智能节点不能改图。直接描述你要完成的任务即可。":
      "This is an <b>agent session</b> canvas: the model can read files / network / run commands, and can edit the current canvas (asks for confirm; reject stops the run). Canvas agent nodes cannot edit the graph. Just describe the task you want done.",
    "检测到图像输入，但已保存的服务商都没有视觉模型；请在「模型服务」添加支持图像的服务商（如 opencode 等）并选择其视觉模型": "Image input detected, but none of the saved providers have a vision model; in \"Model services\" add a provider that supports images (e.g. opencode) and select its vision model",
    "\n在任务描述中用 @标题 引用图像；运行时会自动使用视觉模型（DeepSeek 官方不支持图像，需支持视觉的服务商，如 opencode 等）": "\nIn the task description, use @title to reference images; a vision model is used automatically at runtime (DeepSeek Official does not support images; you need a vision-capable provider such as opencode)",
    "并行运行 <b>N</b> 次该节点（N 为 1-10 的整数）。N &gt; 1 时：运行后输出面板（Output 下一行）出现 <b>1..N 方块 Tab</b>，": "Run this node <b>N</b> times in parallel (N is an integer from 1-10). When N &gt; 1: after running, the output panel (the row below Output) shows <b>1..N square tabs</b>,",
    "命令:/new 新会话 · /compact 压缩上文 · /plan 规划模式 · /rename 标题 · /export 导出会话 · /permissions 查看权限预设": "Commands: /new new session · /compact compact context · /plan plan mode · /rename title · /export export session · /permissions view permission preset",
    "纯净模式": "Pure mode",
    "纯净": "Pure",
    "纯净模式：移除全部 system prompt 与运行时上下文，仅保留联网搜索；该会话不再读写文件 / 改画布，省 token": "Pure mode: drops every system prompt section and the runtime context, keeping only web search — this session no longer reads/writes files or edits the canvas; saves tokens",
    "纯净模式：开启中，点击关闭": "Pure mode: ON — click to turn off",
    "与画布无关": "Canvas-free",
    "与画布无关：该会话不注册任何画布与应用工具（读图 / 改图 / 应用操作都不发），省 token；需要改画布时先关掉它": "Canvas-free: this session registers no canvas or app tools (no canvas read / graph edit / app actions), saving tokens; turn it off first when you do need canvas edits",
    "与画布无关：开启中，点击关闭（本会话不注册任何画布与应用工具）": "Canvas-free: ON — click to turn off (this session registers no canvas or app tools)",
    "与画布无关：助手本轮不注册任何画布与应用工具，也不再注入整张画布快照，省 token；需要改画布时先关掉它": "Canvas-free: the assistant registers no canvas or app tools and no longer injects the full canvas snapshot, saving tokens; turn it off first when you do need canvas edits",
    "与画布无关：开启中，点击关闭（助手本轮不注册任何画布与应用工具）": "Canvas-free: ON — click to turn off (the assistant registers no canvas or app tools)",
    "本助手已声明「与画布无关」：本轮不注册任何画布工具，也不读画布，只读写文件 / 联网 / 执行命令。\n要总结或搭建工作流，请先关掉「与画布无关」。": "This assistant is declared canvas-free: no canvas tools are registered and the canvas is not read — it only reads/writes files, searches the web and runs commands.\nTurn \"Canvas-free\" off first if you want a canvas summary or a workflow built.",
    "插件:https://registry.npmmirror.com/-/v1/search?text=xxx\n技能/MCP:https://data.jsdelivr.com/v1/package/gh/用户/仓库@main": "Plugins: https://registry.npmmirror.com/-/v1/search?text=xxx\nSkills/MCP: https://data.jsdelivr.com/v1/package/gh/user/repo@main",
    "MTNode 目录：http://mt-agent.com/mtnode/ext/catalog.json": "MTNode catalog: http://mt-agent.com/mtnode/ext/catalog.json",
    "插件源返回 npm search 格式；技能源每个子目录含 SKILL.md；MCP 源子目录作为服务器(经 npx @modelcontextprotocol/server-<名> 安装)。": "Plugin sources return npm search format; each skill-source subdirectory contains SKILL.md; MCP source subdirectories are servers (installed via npx @modelcontextprotocol/server-<name>).",
    "MTNode 目录填 catalog.json 即可（官方源已预置）。也可填 npm search 或 jsDelivr repo；技能子目录含 SKILL.md。": "Paste a catalog.json URL for an MTNode catalog (the official source is already built in). npm search and jsDelivr repos still work; skill folders contain SKILL.md.",
    "。可选:mtnode-unattended(无人值守:工作区读写,沙箱拒绝时询问) / workspace-write(读写·逐项审批) / read-only(只读·逐项审批) / danger-full-access(完全放行,不询问)。在 设置 → 智能能力 中切换。": ". Optional: mtnode-unattended (unattended: workspace read/write, asks when the sandbox denies) / workspace-write (read/write · approve each) / read-only (read-only · approve each) / danger-full-access (full access, no prompts). Switch in Settings → Agent capability.",
    "已将 ": "Added ",
    " 个节点移出组": " node(s) removed from the group",
    "已选中组 + ": "Group selected + ",
    " 个节点加入组「": " node(s) added to group \"",
    "所选节点已在该组中": "Selected nodes are already in this group",
    " 个节点：点击把节点加入该组": " node(s): click to add them to this group",
    "请先框选 / 选中节点，或选中一个组": "Box-select / select nodes, or select a group first",
    "所选节点在组内：点击将节点移出该组（脱离）": "Selected nodes are in a group: click to detach them",
    "所选节点分属多个组，请先单独选择一个组内的节点": "Selected nodes belong to different groups; select nodes from one group first",
    "文本节点": "Text Node",
    "图像节点": "Image Node",
    "文本处理节点": "Text Processing Node",
    "图像生成节点": "Image Generation Node",
    "保存文本节点": "Save Text Node",
    "保存图像节点": "Save Image Node",
    "拆分节点": "Split Node",
    "合并节点": "Merge Node",
    "全局节点": "Global Node",
    "全局节点（仅连入 · 广播给所有处理节点）":
      "Global Node (inputs only · broadcasts to processing nodes that opt in)",
    "全局节点（仅连入 · 点左上角彩虹图标引用）":
      "Global Node (inputs only · click the top-left rainbow icon on a node to subscribe)",
    "○ 等待连入（广播给所有处理节点）":
      "○ Waiting for inputs (broadcast to subscribed processing nodes)",
    " 个来源 · 所有处理节点可引用":
      " sources · available to subscribed processing nodes",
    "已引用全局节点": "Now referencing global nodes",
    "已关闭全局节点引用": "Stopped referencing global nodes",
    "已引用全局节点（彩虹）· 提示词需 @ 标题才注入 · 点击关闭 · 拖动移动":
      "Referencing global nodes (rainbow) · content injects only when @-mentioned in the prompt · click to turn off · drag to move",
    "点击开启全局引用（提示词需 @ 标题才注入）· 拖动移动":
      "Click to reference global nodes (@-mention in the prompt to inject) · drag to move",
    "已开启全局引用，但提示词未 @ 引用任何全局来源，本次未注入内容":
      "Global references are on, but the prompt @-mentions none of the global sources — nothing was injected this run",
    "全局参考": "Global reference",
    "全局 Tag · ": "Global tags · ",
    "Tag 筛选已开 · 点击管理标签": "Tag filter on · click to manage tags",
    "管理 Tag：勾选筛选连入显示，并为连入节点打标":
      "Manage tags: check to filter wired-in chips and stamp tags onto them",
    "勾选 Tag：仅显示带该标的连入节点，并为当前连入节点打上该标。可添加 / 删除 Tag。":
      "Check a tag to show only matching wired-in nodes and stamp it onto them. Add or delete tags here.",
    "暂无 Tag · 点击下方添加": "No tags yet · add one below",
    "删除此 Tag（所有节点上的该标一并移除）":
      "Delete this tag (also removes it from all nodes)",
    "删除 Tag「{tag}」？已打在节点上的该标也会移除。":
      "Delete tag \"{tag}\"? It will also be removed from stamped nodes.",
    "删除 Tag": "Delete tag",
    "＋ 添加 Tag": "+ Add tag",
    "添加 Tag": "Add tag",
    "新 Tag 名称": "New tag name",
    "Tag 名称不能为空": "Tag name cannot be empty",
    "无匹配该 Tag 的连入节点": "No wired-in nodes match the selected tags",
    "智能任务节点": "Agent Task Node",
    "MTNode AI编排器": "MTNode AI Orchestrator",
    "语言": "Language",
    "未加载画布": "No canvas loaded",
    "— 节点 · — 连线": "— nodes · — wires",
    "服务商 0": "Providers 0",
    "网格 24px": "Grid 24px",
    "设置": "Settings",
    "命令:/new 新会话 · /compact 压缩上文 · /plan 规划 · /rename 改名 · /export 导出 · /permissions 权限预设 · /help": "Commands: /new new session · /compact compact · /plan plan · /rename rename · /export export · /permissions permissions · /help",
    " · 第{turn}轮第{step}步": " · turn {turn} step {step}",
    "移除在线源「{name}」？": "Remove online source \"{name}\"?",
    "工作流编排": "Canvas",
    "↶ 撤销": "↶ Undo",
    "↷ 重做": "↷ Redo",
    "⧉ 复制节点": "⧉ Duplicate",
    "⤢ 居中": "⤢ Fit",
    "▭ 框选": "▭ Box",
    "◫ 组": "◫ Group",
    "设置 · API/配置": "Settings · API/Config",
    "更改名称": "Rename",
    "导出": "Export",
    "预设": "Preset",
    "思考强度": "Thinking",
    "＋ 新会话": "+ New session",
    "可见全局状态 · 修改需确认": "Sees app state · edits need confirm",
    "显示 / 隐藏 Live2D 占位区": "Show / hide Live2D placeholder",
    "清空助手对话": "Clear assistant chat",
    "关闭右侧助手栏": "Close right assistant panel",
    "预留位 · 可接入角色模型": "Reserved · plug in a character model",
    "可询问当前画布状态，或让助手修改画布（每次修改会弹窗确认）": "Ask about the canvas, or have the assistant edit it (each edit asks for confirm)",
    "问助手…（Enter 发送，Shift+Enter 换行）": "Ask the assistant… (Enter send, Shift+Enter newline)",
    "发送": "Send",
    "全局 AI 助手（右侧栏）": "Global AI assistant (right panel)",
    "用户拒绝了此次画布修改": "User rejected this canvas edit",
    "更新 ": "Updated ",
    "断开 ": "Disconnected ",
    "重命名画布 → ": "Rename canvas → ",
    "自动排版": "Auto layout",
    "修改画布": "Edit canvas",
    "涉及：": "Involves: ",
    "确认画布修改": "Confirm canvas edit",
    "全局助手请求修改当前画布：": "Global assistant requests canvas changes: ",
    "拒绝后本次修改不会生效；可让助手改方案后再试。": "If rejected, this edit will not apply; ask the assistant for another plan.",
    "确认修改": "Confirm edit",
    "我能看到当前画布、节点、连线与配置。\n可以说「总结画布」或「搭一个 xxx 工作流」。\n修改画布前会请你确认。": "I can see the current canvas, nodes, wires, and settings.\nTry \"summarize the canvas\" or \"build a xxx workflow\".\nCanvas edits will ask for your confirmation.",
    "思考中…": "Thinking…",
    "请先终止当前运行": "Stop the current run first",
    "助手失败：": "Assistant failed: ",
    "全局助手失败：": "Global assistant failed: ",
    "可见全局状态 · 危险操作需确认": "Sees app state · risky ops need confirm",
    "可查看全部画布列表；改节点图或删除画布会弹窗确认":
      "Can list all canvases; graph edits or deleting a canvas ask for confirm",
    "画布名称不唯一，请改用 id：": "Canvas name is not unique, use id: ",
    "找不到画布：": "Canvas not found: ",
    "缺少 action": "Missing action",
    "未知应用操作：": "Unknown app action: ",
    "确认操作": "Confirm action",
    "确认危险操作": "Confirm risky action",
    "全局助手请求：": "Global assistant requests: ",
    "应用操作：": "App action: ",
    "用户拒绝了此次操作": "User rejected this action",
    "已删除画布：": "Deleted canvas: ",
    "将删除该画布及其全部本地数据文件（含节点图像资产）。此操作不可恢复。": "This will delete the canvas and all of its local data files (including node image assets). This cannot be undone.",
    "清空本节点输出与会话（历史 / 工具日志一并重置）": "Clear this node's output and session (history / tool logs reset)",
    "助手会话已清空": "Assistant chat cleared",
    "留空 = 当前画布 / 应用默认目录…": "Leave empty = current canvas / app default directory…",
    "排队等待中…": "Queued…",
    "拖动边框中部调整助手栏宽度": "Drag the mid-border to resize the assistant",
    "仅图像输入节点可设置 imagePath：": "Only image input nodes accept imagePath: ",
    "载入图像失败：": "Failed to load image: ",
    "⏻ 控制（批量清空 / 执行）": "⏻ Control (batch clear / run)",
    "设为清空：点击 ▶ 清空所有已连接节点的输出": "Set to Clear: click ▶ to clear output of all connected nodes",
    "设为执行：点击 ▶ 运行已连接节点（有依赖先上游，并行同时跑）": "Set to Run: click ▶ to run connected nodes (upstream first if depended on; parallel otherwise)",
    "运行：清空所有已连接节点的输出": "Run: clear output of all connected nodes",
    "运行：执行已连接节点（有依赖先上游，并行同时跑）": "Run: execute connected nodes (upstream first if depended on; parallel otherwise)",
    "未连接任何节点": "No nodes connected",
    "已连接 ": "Connected ",
    "所连接节点无法执行": "Connected nodes cannot be run",
    "从本节点连出，或把其他节点连入：点击 ▶ 对全部已连接节点执行所选操作": "Wire out from this node, or wire other nodes in: click ▶ to apply the selected action to all connected nodes",
    "输出端子（连接到要控制的节点）": "Output port (connect to nodes to control)",
    "已清空 ": "Cleared ",
    "已自动切换至视觉模型：": "Auto-switched to vision model: ",
    "智能节点已匹配服务商与模型：": "Agent node matched provider and model: ",
    "运行中的节点未改模型：": "Running nodes were not re-modeled: ",
    "找不到服务商：": "Provider not found: ",
    "服务商名称不唯一，请改用 id：": "Provider name is not unique, use id instead: ",
    "⧉ 复制绘制": "⧉ Duplicate drawing",
    "已复制绘制：": "Duplicated drawing: ",
    "请先选中节点或绘制": "Select a node or drawing first",
    "箭头": "Arrow",
    "框体": "Box",
    "拖动箭头终点": "Drag arrow end",
    "拖动箭头起点": "Drag arrow start",
    "拖动调整大小": "Drag to resize",
    "✕ 删除绘制": "✕ Delete drawing",
    "删除绘制": "Delete drawing",
    "选取颜色": "Pick color",
    "加粗线条": "Thicker stroke",
    "减细线条": "Thinner stroke",
    "放大字号": "Larger text",
    "缩小字号": "Smaller text",
    "切换颜色": "Cycle color",
    "仅用于展示的绘制标注（可改颜色 / 大小）": "Display-only canvas annotation (color / size editable)",
    "已添加绘制：": "Added drawing: ",
    "说明文字": "Note",
    "➔ 箭头": "➔ Arrow",
    "▢ 框体": "▢ Box",
    "Ｔ 文本": "Ｔ Text",
    "绘制": "Draw",
    "其他节点（网络 · 批次拆分 / 合并）": "Other Nodes (network · batch split / merge)",
    "网络 · 接收（监听通道 · 异步转发文本）": "Network · Receive (listen on channel · forward text async)",
    "网络 · 发送（推送到通道 · TCP / UDP）": "Network · Send (push to channel · TCP / UDP)",
    "设置后,本画布智能节点与保存节点的相对路径都相对该目录;改目录即可统一切换落盘位置;留空则各节点单独设置": "Once set, agent nodes and relative save paths use this directory; change it to redirect all saves; leave empty for per-node settings",
    "有工作目录时可用相对路径（如 output.yaml）；改顶栏工作目录后统一落盘到新目录。也可填绝对路径。": "With a working directory set, use a relative path (e.g. output.yaml); changing the toolbar workspace redirects all saves. Absolute paths are also allowed.",
    "相对工作目录或绝对路径（*.png / *.jpg）…": "Relative to working directory or absolute path (*.png / *.jpg)…",
    "相对工作目录或绝对路径（*.md）…": "Relative to working directory or absolute path (*.md)…",
    "相对路径需要先设置工作目录（顶栏），或改用绝对路径": "Relative paths need a working directory (toolbar), or use an absolute path"
  };
  /* ── 本地语音转写（Qwen3-ASR）：renderer/app-asr.js + app-plugins.js 卡片 ── */
  Object.assign(EN, {
    "音频转写": "Audio transcript",
    "本地语音转写（Qwen3-ASR）": "Local Speech-to-Text (Qwen3-ASR)",
    "本地语音后端尚未安装：请点节点上的「一键安装」或到「插件」里安装「本地语音转写」":
      "The local speech backend is not installed yet: use “Install” on the node or install “Local Speech-to-Text” from Plugins.",
    "未检测到可用的 NVIDIA 显卡，本地语音转写不可用（可在插件里选「仍装 CPU 版（很慢）」）":
      "No usable NVIDIA GPU detected, so local speech-to-text is unavailable (you may still install the CPU build from Plugins — very slow).",
    "语音后端缺少 Python 环境，请在插件卡片里点「自我修复」":
      "The speech backend has no Python environment; click “Repair” on the plugin card.",
    "音频文件不存在或已被移动": "The audio file is missing or was moved.",
    "已有音视频任务进行中，请稍后再试":
      "Another audio/video job is running (global limit: 1); please retry later.",
    "语音后端起不来（已退出），请查看控制台日志或点「自我修复」":
      "The speech backend exited on startup; check the console log or click “Repair”.",
    "语音后端启动超时（首次要加载模型，请稍后重试）":
      "The speech backend timed out on startup (first run loads the model); please retry later.",
    "音频解码失败（后端缺少 ffmpeg？请在插件里点「自我修复」）":
      "Audio decoding failed (ffmpeg missing? click “Repair” in Plugins).",
    "后端缺少 ffmpeg，无法解码该音频格式（请在插件里点「自我修复」）":
      "The backend has no ffmpeg and cannot decode this format (click “Repair” in Plugins).",
    "模型加载失败，请查看控制台日志或点「自我修复」":
      "Model loading failed; check the console log or click “Repair”.",
    "转写失败": "Transcription failed",
    "本地语音模块不可用": "The local speech module is unavailable",
    "已重新转写": "Re-transcribed",
    "缺语音后端": "Backend missing",
    "无可用显卡": "No usable GPU",
    "已转写": "Transcribed",
    "待转写": "Not transcribed yet",
    "一键安装": "Install now",
    "（点 ▶ 运行时自动转写；也可在此直接改错字）":
      "(Press ▶ to transcribe automatically; you may also fix typos right here)",
    "重新转写": "Re-transcribe",
    "术语 / 热词": "Terms / hotwords",
    "人名、产品名、专业术语，用逗号分隔（提高识别准确率）":
      "Names, product terms, jargon — comma separated (improves accuracy)",
    "把音频（音频输入节点 / 素材音频条目 / 语音或音乐产物）接到文字处理节点后，运行时会自动把音频转成文字并注入提示词。模型与后端不随安装包分发，首次使用需下载安装。":
      "Wire audio (audio input node / asset audio item / speech or music output) into a text node and it is transcribed into the prompt at run time. The model and backend are not bundled: the first use downloads and installs them.",
    "模型来源": "Model source",
    "分段模型": "Chunking model",
    "预计占用": "Estimated size",
    "模型约 1.9GB + Python 依赖约 3-4GB（CUDA）+ ffmpeg 约 100MB，建议预留 {n}GB 磁盘":
      "≈1.9GB model + ≈3-4GB Python deps (CUDA) + ≈100MB ffmpeg; reserve about {n}GB of disk.",
    "本机显卡": "Local GPU",
    "未检测到 NVIDIA 显卡": "No NVIDIA GPU detected",
    "安装目录": "Install dir",
    "尚未选择": "Not chosen yet",
    "运行状态": "Runtime",
    "运行中（静默）": "Running (silent)",
    "已安装 · 未运行": "Installed · not running",
    "未检测到可用的 NVIDIA 显卡：本功能只装 CUDA 版后端，默认不可用。确有需要可在下方勾选「仍装 CPU 版（很慢）」。":
      "No usable NVIDIA GPU detected: this feature installs the CUDA backend only and is unavailable by default. Tick “Install the CPU build (very slow)” below if you really need it.",
    "空闲释放（分钟，0 = 不释放）": "Release when idle (minutes; 0 = never)",
    "全局默认热词（逗号分隔）": "Global default hotwords (comma separated)",
    "仍装 CPU 版（很慢，仅在无 N 卡时兜底）":
      "Install the CPU build (very slow; fallback for machines without an NVIDIA GPU)",
    "已保存语音转写设置": "Speech-to-text settings saved",
    "选择安装目录": "Choose install dir",
    "选择已有模型目录": "Choose existing model dir",
    "查看安装日志": "View install log",
    "下载并安装（脚本）": "Download & install (script)",
    "（暂无日志）": "(no log yet)",
    "开始安装…": "Installing…",
    "安装失败：": "Install failed: ",
    "交给 AI 安装 / 自我修复": "Install / repair with AI",
    "Agent 正在安装…（可关闭此窗，进度在插件卡片上）":
      "The agent is installing… (you may close this dialog; progress shows on the plugin card)",
    "安装完成，正在静默启动语音后端…":
      "Install finished; starting the speech backend silently…",
    "保存设置": "Save settings",
    "该目录不可用：": "That directory is not usable: ",
    "本机无 N 卡 · 查看": "No NVIDIA GPU · details",
    "安装…": "Install…",
    "状态与设置": "Status & settings",
    "停止后端": "Stop backend"
  });
  Object.assign(EN, {
    "创意工坊": "Creative Workshop",
    "创意工坊：浏览 / 下载公开模板与 Skill，登录后可上传与管理自己的条目":
      "Creative Workshop: browse / download public templates & skills; sign in to upload and manage yours",
    "创意工坊：浏览 / 下载公开模板，登录后可上传与管理自己的模板":
      "Creative Workshop: browse / download public templates & skills; sign in to upload and manage yours",
    "模板": "Templates",
    "技能": "Skills",
    "个技能": " skills",
    " 个技能": " skills",
    "搜索技能、标签或 skillName…": "Search skills, tags, or skillName…",
    "暂无技能": "No skills yet",
    "没有匹配的技能": "No matching skills",
    "官方优先": "Official first",
    "官方": "Official",
    "官方 Skill": "Official skill",
    "技能标题…": "Skill title…",
    "介绍这个技能能做什么…": "Describe what this skill does…",
    "版本": "Version",
    "技能名（不可改）：": "Skill name (immutable): ",
    "标记为官方 Skill（ms2308）": "Mark as official skill (ms2308)",
    "选择 SKILL.md / 附件…": "Choose SKILL.md / extras…",
    "选择 SKILL.md 与附加文件": "Choose SKILL.md and attachments",
    "拖入 SKILL.md 与附加文件": "Drop SKILL.md and attachments here",
    "支持多选文件，或拖入整个技能文件夹；将自动填写标题、描述、版本":
      "Multi-select files, or drop a skill folder; title, description, and version fill automatically",
    "拖入或选择 SKILL.md 与附件（可多选/整夹）；自动填写标题与描述；需含 frontmatter name（kebab-case）":
      "Drop or choose SKILL.md plus extras (multi-select / folder); auto-fills title & description; requires frontmatter name (kebab-case)",
    "已载入技能包": "Loaded skill bundle",
    "请包含 SKILL.md": "Include a SKILL.md",
    "只能包含一个 SKILL.md": "Only one SKILL.md is allowed",
    "未检测到可上传的文件": "No uploadable files detected",
    "已添加附件（未含 SKILL.md，表单字段未改）":
      "Attachments added (no SKILL.md; form fields unchanged)",
    "粘贴 Markdown": "Paste Markdown",
    "粘贴完整 SKILL.md…": "Paste full SKILL.md…",
    "内容为空": "Content is empty",
    "已粘贴 Markdown": "Markdown pasted",
    "最大 1MB": "max 1MB",
    "需含 frontmatter name（kebab-case）": "Requires frontmatter name (kebab-case)",
    "编辑时可只改标题/标签/版本；重选文件会覆盖工坊正文（需填新版本）":
      "When editing you may change title/tags/version only; re-selecting overwrites the workshop body (new version required)",
    "发布技能": "Publish skill",
    "请先选择或粘贴 SKILL.md": "Choose or paste a SKILL.md first",
    "请先选择、粘贴或编写 SKILL.md": "Choose, paste, or write a SKILL.md first",
    "使用本机技能": "Use local skill",
    "选择本机技能": "Choose a local skill",
    "本机暂无可载入的技能": "No local skills to load",
    "载入": "Load",
    "载入后可编辑并发布到工坊（仅上传者可更新已有条目）":
      "After loading, edit and publish to the workshop (only the uploader can update an existing entry)",
    "已载入本机技能": "Loaded local skill",
    "本机技能名与工坊条目不一致，不能覆盖该条目":
      "Local skill name does not match this workshop entry",
    "正在加载工坊正文…": "Loading workshop body…",
    "已加载工坊正文": "Loaded workshop body",
    "已编辑正文": "Body edited",
    "技能正文（可在此直接修改）": "Skill body (edit here)",
    "SKILL.md 全文…": "Full SKILL.md…",
    "可直接改下方正文并保存到工坊（需新版本）；也可从本机技能载入。本机副本不会自动跟着变。":
      "Edit the body below and save to the workshop (new version required); or load a local skill. Local copies do not auto-update.",
    "不可更改 skill name（当前为 ": "Cannot change skill name (current: ",
    "保存本机修改": "Save local changes",
    "已载入本机技能，修改后点「保存本机修改」":
      "Local skill loaded; click “Save local changes” after editing",
    "本机技能已保存（未自动同步工坊）":
      "Local skill saved (not synced to the workshop)",
    "请填写版本号": "Enter a version",
    "确认覆盖工坊中的技能正文？修改立即生效；本机已下载副本需手动更新。":
      "Overwrite the published skill body? Changes apply immediately; local copies stay until you update manually.",
    "覆盖技能": "Overwrite skill",
    "已删除技能": "Skill deleted",
    "下载技能": "Download skill",
    "更新技能": "Update skill",
    "下载技能到本机后，智能节点可通过 / 使用。确定下载？":
      "Download this skill locally so agent nodes can use it via /. Continue?",
    "将用工坊版本覆盖本机技能「{name}」。确定更新？":
      "Overwrite local skill \"{name}\" with the workshop version. Continue?",
    "技能名无效": "Invalid skill name",
    "技能内容解码失败": "Failed to decode skill content",
    "已更新技能 ": "Updated skill ",
    "已下载技能 ": "Downloaded skill ",
    "技能预览": "Skill preview",
    "加载技能中…": "Loading skill…",
    "本机已安装": "Installed locally",
    "工坊有新版本，需手动更新": "Newer workshop version available — update manually",
    "只读预览 · 下载后才会写入本机": "Read-only preview · downloads write to this machine",
    "更新到本机": "Update locally",
    "下载到本机": "Download locally",
    "有更新": "Update available",
    "已更新 ": "Updated ",
    "线上目录已换新版，点此覆盖本机技能":
      "The online catalog has a newer version — click to overwrite the local skill",
    "重新下载并覆盖本机技能": "Download again and overwrite the local skill",
    "将用线上目录版本覆盖本机技能「{name}」。确定更新？":
      "The online catalog version will overwrite the local skill “{name}”. Update?",
    "已安装（可再更新）": "Installed (can update again)",
    "选择 SKILL.md": "Choose SKILL.md",
    "每个文件不能超过 200KB": "Each file must be ≤ 200KB",
    "每个文件不能超过 200KB（当前 ": "Each file must be ≤ 200KB (now ",
    "每个文件 ≤200KB": "≤200KB per file",
    "附加文件（可选，如 schemas.md；每个 ≤200KB）":
      "Extra files (optional, e.g. schemas.md; ≤200KB each)",
    "添加附件…": "Add attachments…",
    "清除附件": "Clear attachments",
    "未选择附件": "No attachments",
    "已选 ": "Selected ",
    " 个附件": " attachment(s)",
    "附加文件不能超过 32 个": "At most 32 extra files",
    "附加文件不要使用 SKILL.md": "Do not use SKILL.md as an attachment",
    "文件名不合法：": "Invalid file name: ",
    "选择技能附加文件": "Choose skill attachments",
    "技能附件": "Skill attachments",
    "技能文件不能超过 1MB": "Skill file must be ≤ 1MB",
    "技能不能超过 1MB（当前 ": "Skill must be ≤ 1MB (now ",
    "文件为空": "File is empty",
    "上传": "Upload",
    "我的": "Mine",
    "登录": "Sign in",
    "注册": "Register",
    "修改密码": "Change password",
    "旧密码": "Current password",
    "新密码（6-72 位）": "New password (6-72 characters)",
    "再次输入新密码": "Confirm new password",
    "两次输入的新密码不一致": "New passwords do not match",
    "新密码不能与旧密码相同": "New password must differ from the current one",
    "密码已修改": "Password updated",
    "退出": "Sign out",
    "用户名": "Username",
    "密码": "Password",
    "昵称": "Nickname",
    "用户名（3-24 位字母、数字或下划线）": "Username (3-24 letters, digits, or _)",
    "密码（6-72 位）": "Password (6-72 characters)",
    "昵称（1-32 位）": "Nickname (1-32 characters)",
    "修改昵称": "Change nickname",
    "昵称已更新": "Nickname updated",
    "请输入昵称": "Enter a nickname",
    "昵称会显示在账户菜单与论坛等处":
      "Your nickname shows in the account menu, forum, and elsewhere",
    "获赞 ": "Likes ",
    "被下载 ": "Downloads ",
    "下载量": "Downloads",
    "点赞量": "Likes",
    "最新": "Newest",
    "搜索模板或标签…": "Search templates or tags…",
    "全部": "All",
    "暂无模板": "No templates yet",
    "没有匹配的模板": "No matching templates",
    "工坊加载中…": "Loading workshop…",
    "加载失败：": "Failed to load: ",
    "创意工坊不可用：": "Creative Workshop unavailable: ",
    "网格视图": "Grid view",
    "列表视图": "List view",
    "知道了": "Got it",
    "工作目录无效": "Invalid working directory",
    "以下工作目录不存在或不是有效文件夹，已自动清空。请重新选择有效目录，以免影响全局助手、智能任务与相对路径保存。":
      "These working directories do not exist or are not valid folders and were cleared. Choose a valid directory so the global assistant, agent tasks, and relative save paths keep working.",
    "该路径不存在或不是有效文件夹，已自动清空。请重新选择有效的工作目录。":
      "This path does not exist or is not a valid folder and was cleared. Please choose a valid working directory.",
    "画布工作目录": "Canvas working directory",
    "全局助手工作目录": "Global assistant working directory",
    "智能会话": "Agent session",
    "无效服务商 / 模型": "Invalid provider / model",
    "检测到无效模型配置": "Invalid model configuration detected",
    "当前画布含有本机不存在的服务商或模型（常见于他人模板）。接下来将按每个无效服务商分别询问，批量替换为你自己的服务商。":
      "This canvas references providers or models that are not on this machine (common with shared templates). You will be asked for each invalid provider so you can batch-replace them with your own.",
    "检测到无效服务商 / 模型「": "Invalid provider / model \"",
    "」，影响节点：": "\" affects nodes: ",
    " …共 ": " …total ",
    "。请选择要批量替换成的本地服务商与模型。":
      ". Choose a local provider and model to batch-replace them.",
    "替换为服务商": "Replace with provider",
    "跳过此服务商": "Skip this provider",
    "批量替换": "Batch replace",
    "（无可用模型）": "(No models available)",
    "（请先在设置中添加服务商）": "(Add a provider in Settings first)",
    "请先在设置中添加可用的服务商": "Add an available provider in Settings first",
    "请选择模型": "Choose a model",
    "工作目录无效，已改用默认目录": "Working directory was invalid; using the default directory",
    "下载": "Download",
    "点赞": "Like",
    "已点赞": "Liked",
    "编辑": "Edit",
    "源码": "Source",
    "确认删除": "Confirm delete",
    "标题": "Title",
    "功能描述": "Description",
    "标签": "Tags",
    "预览图像（可选，最长边 640）": "Preview image (optional, max side 640)",
    "选择预览图像": "Choose preview image",
    "清除预览": "Clear preview",
    "已清除预览": "Preview cleared",
    "使用当前画布": "Use current canvas",
    "选择 .mtnodes 文件": "Choose .mtnodes file",
    "选择 .mtnodes 模板文件": "Choose .mtnodes template file",
    "粘贴 Base64": "Paste Base64",
    "已选择当前画布": "Using current canvas",
    "已选择文件：": "File selected: ",
    "已粘贴 Base64": "Base64 pasted",
    "请先选择或粘贴模板文件": "Choose or paste a template file first",
    "请填写标题": "Enter a title",
    "上传成功": "Uploaded",
    "已保存修改": "Changes saved",
    "确认覆盖工坊中的模板画布？本地预览/下载缓存将同步更新。":
      "Overwrite the published template canvas in the workshop? Local preview/download cache will be updated.",
    "编辑时可不重新选文件（仅改标题等）；选择新画布将覆盖工坊模板":
      "You can skip the file to edit title/tags only; choosing a new canvas overwrites the workshop template",
    "已删除模板": "Template deleted",
    "导入将打开为新画布，当前画布会保留。确定下载？": "This will open as a new canvas; the current one is kept. Download?",
    "点赞需要登录": "Sign in to like",
    "上传需要登录": "Sign in to upload",
    "请先登录后再上传": "Sign in before uploading",
    "点击选择已有标签，或输入后回车添加": "Click an existing tag, or type and press Enter to add",
    "添加标签…": "Add a tag…",
    "最多 8 个标签": "Up to 8 tags",
    "无预览": "No preview",
    "共 ": "Total ",
    " 个模板": " templates",
    "已登录": "Signed in",
    "未登录": "Not signed in",
    "取消编辑": "Cancel edit",
    "保存修改": "Save changes",
    "发布模板": "Publish",
    "登录成功": "Signed in",
    "注册成功": "Registered",
    "已退出": "Signed out",
    "上一页": "Prev",
    "下一页": "Next",
    "第 ": "Page ",
    " 页": "",
    "将打开为新画布": "Will open as a new canvas",
    "粘贴 .mtnodes 的 Base64 内容：": "Paste Base64 of a .mtnodes file:",
    "模板标题…": "Template title…",
    "介绍这个模板能做什么…": "What this template does…",
    "获赞": "Likes received",
    "被下载": "Downloads received",
    "图像尺寸与文件大小（用于评估视觉输入 token）":
      "Image size and file size (for estimating vision input tokens)",
    "文件名 · 尺寸 · 大小（用于评估视觉输入 token）":
      "Filename · dimensions · size (for estimating vision input tokens)",
    "文件名：": "Filename: ",
    "（无法读取）": "(unavailable)",
    "批量模式：各条目并行运行，输出批量结果":
      "Batch mode: run all items in parallel, output batch results",
    "当前聚合 → 点击改为批量（各条目并行）":
      "Currently Aggregate → click to switch to Batch (all items in parallel)",
    "运行队列": "Run queue",
    " 处理中": " running",
    " 等待": " waiting",
    /* 运行队列汇总计数后缀（同 " running" / " waiting" 的用法：数量 + 后缀） */
    " 会话": " sessions",
    " 后端生成中": " backend generating",
    "处理中": "Running",
    "等待中": "Waiting",
    "点击定位到节点": "Click to focus node",
    "节点不在当前画布": "Node is not on this canvas",
    /* ===== 运行队列 = 全应用运行总览：跨画布定位 / 逐条终止 / 后端生成状态 ===== */
    "跨画布定位": "Click to switch canvas and focus node",
    "点击查看调研进度": "Click to view research progress",
    "点击打开该会话": "Click to open this session",
    "停止该会话": "Stop this session",
    /* 运行队列里的「并行任务」行：计划并行组（看得见 · 停得掉） */
    "并行任务": "Parallel tasks",
    " 并行任务": " parallel tasks",
    "并行": "Parallel",
    "未命名并行组": "Unnamed group",
    "停止该并行任务组": "Stop this parallel task group",
    "停止该会话与并行任务组": "Stop this session and its parallel task group",
    /* 会话列表条目：并行组在跑时条目同样显示「运行中」，悬浮说明它为什么在转圈 */
    "计划并行任务运行中（不打断你继续发消息）":
      "Parallel plan tasks are running (this doesn't block you from sending a new message)",
    "停止全局助手": "Stop global assistant",
    "会话已不存在": "Session no longer exists",
    "节点已不存在": "Node no longer exists",
    "排队生成": "Queued generation",
    "在途生成": "Generation in flight",
    "节点预览": "Node preview",
    "点击查看大图": "Click to view full image",
    /* 图像预览灯箱：默认整图适应窗口高度，滚轮缩放 / 点击放大 / 拖动平移 */
    "缩小": "Zoom out",
    "放大": "Zoom in",
    "适应窗口": "Fit",
    "整图适应窗口": "Fit the whole image to the window",
    "原始大小": "Actual size (1:1)",
    "滚轮缩放 · 点击放大 · 放大后可拖动平移":
      "Wheel to zoom · click to zoom in (Shift+click out) · drag to pan once zoomed",
    "加载中…": "Loading…",
    "加载模板中…": "Loading template…",
    "已从本地缓存导入": "Imported from local cache",
    "只读预览 · 已缓存，下载时无需重复拉取":
      "Read-only preview · cached; download will not re-fetch",
    "只读预览 · 已写入本地缓存，下载时将直接导入":
      "Read-only preview · cached locally; download will import directly",
    "大小 ": "Size ",
    "模板不能超过 10MB（当前 ": "Template must be ≤ 10MB (now ",
    "上游输出更新时自动保存到指定路径":
      "Auto-save to the path when upstream output updates",
    "管理员": "Admin",
    "最大 10MB": "max 10MB",
    "审批": "Approvals",
    "更新": "Update",
    "下载中": "Downloading",
    "重启更新": "Restart",
    "安装更新": "Install update",
    "发现新版本": "Update available",
    "发现新版本 v": "Update available: v",
    "，是否下载并安装？": " — download and install?",
    "，是否下载更新？": " — download the update?",
    "，点击下载并安装": " — click to download & install",
    "，点击下载更新": " — click to download",
    "开始下载并更新": "Download & update",
    "开始下载": "Download",
    "稍后重启": "Later",
    "立即安装并重启": "Install & restart",
    "稍后": "Later",
    "更新已就绪": "Update ready",
    "更新包已下载完毕（v": "Update package downloaded (v",
    "将自动差分下载更新包（仅变更部分），下载完成后静默安装并重启（不弹出安装向导）。当前版本：v":
      "Will differentially download only changed blocks, then silently install and restart (no installer wizard). Current: v",
    "将差分下载更新包（仅变更部分），下载期间可继续使用。下载完成后请重启以完成静默安装。当前版本：v":
      "Will differentially download only changed blocks. You can keep working while it downloads. Restart afterward to finish the silent install. Current: v",
    "将差分下载更新包（仅变更部分），下载期间可继续使用。下载完成后会后台静默安装，安装完毕后自动重新打开应用。当前版本：v":
      "Will differentially download only changed blocks. You can keep working while it downloads. After download, it installs silently in the background and the app reopens automatically. Current: v",
    "安装需要替换正在运行的程序文件，请重启以完成静默安装。选择「稍后重启」后，下次退出应用时也会自动安装。当前版本：v":
      "Installing needs to replace running program files. Restart to finish the silent install. If you choose Later, it will also install the next time you quit. Current: v",
    "安装会在后台静默进行（不弹出安装向导），安装完毕后会自动重新打开应用。选择「稍后」则下次退出应用时再安装。当前版本：v":
      "Installation runs silently in the background (no installer wizard). When it finishes, the app reopens automatically. Choose Later to install the next time you quit. Current: v",
    "正在下载更新…": "Downloading update…",
    "开始下载更新（差分包）…": "Downloading update (differential)…",
    "更新已下载，即将静默安装并重启…": "Update downloaded — silently installing and restarting…",
    "更新已下载完毕，请重启以完成安装": "Update downloaded — restart to finish installing",
    "更新已下载完毕：将后台静默安装，完成后自动重新打开应用":
      "Update downloaded — silent background install, then the app reopens automatically",
    "更新已就绪，点击重启以完成安装": "Update ready — click to restart and finish installing",
    "更新已就绪：点击后将后台静默安装，完成后自动重新打开":
      "Update ready — click to install silently in the background; the app will reopen automatically",
    "已选择稍后重启；退出应用时将自动完成安装":
      "Will install when you quit the app",
    "已选择稍后；退出应用时将后台静默安装并自动重新打开":
      "Will silently install and reopen when you quit the app",
    "更新失败：": "Update failed: ",
    /* 设置最底部的「手动更新（同版本号重装）」：不比对版本号，直接重装更新源里那份包 */
    "手动更新（同版本号重装）": "Manual update (reinstall same version)",
    "普通更新只在线上版本号更高时才可用。这里不比对版本号：直接用更新源里那份安装包重装一遍，适合极小更新与测试。下载与静默安装过程与正常更新完全一致，安装时应用会短暂重启。":
      "Regular updates only work when the online version number is higher. This one skips the version comparison and reinstalls the package already on the update server — handy for tiny patches and testing. Download and silent install behave exactly like a normal update; the app restarts briefly while installing.",
    "立即手动更新（重装更新源那份包）": "Manual update (reinstall the package on the server)",
    "不比对版本号，直接用更新源里那份包重装一次（极小更新与测试用）":
      "Skip the version comparison and reinstall the package on the update server (for tiny patches and testing)",
    "确定手动更新？": "Start a manual update?",
    "将不比对版本号，直接用更新源里那份安装包重装一次（可能是同一个版本号 v":
      "The version number will not be compared; the installer on the update server reinstalls directly (it may well be the same version v",
    "）。下载完成后会在后台静默安装并自动重新打开应用；期间请先保存当前工作。":
      "). After downloading it installs silently in the background and the app reopens automatically — save your work first.",
    "手动更新": "Manual update",
    "开始更新": "Start update",
    "正在检查并下载…": "Checking and downloading…",
    "已开始手动更新，将后台静默安装":
      "Manual update started — it will install silently in the background",
    "当前版本不支持手动更新": "This build does not support manual updates",
    "Microsoft Store（MSIX）版不支持应用内更新，请在 Microsoft Store 中获取更新":
      "The Microsoft Store (MSIX) build does not support in-app updates — get updates from the Microsoft Store",
    "发现新版本，点击下载并安装": "New version available — click to download & install",
    "发现新版本，点击下载更新": "New version available — click to download",
    "立即重启安装": "Restart & install now",
    "更新已下载完成，将重启并安装 v": "Update downloaded — will restart and install v",
    "安装过程使用差分块更新，仅下载变更部分。请保存当前工作后继续。":
      "Uses differential blocks (only changes). Save your work before continuing.",
    "审批与权限": "Approvals & permissions",
    "新建工具预设": "New tool preset",
    "一键排版": "Auto layout",
    "同时排版内部": "Include insides",
    "仅排版画布": "Canvas only",
    "是否同时排版超级节点内部？\n\n「同时排版内部」会整理各超级节点内的子节点；「仅排版画布」只调整顶层节点。":
      "Also layout inside super nodes?\n\n“Include insides” tidies children inside each super node; “Canvas only” adjusts top-level nodes only.",
    "确定进行一键排版？\n\n将按连线与关系线整理节点位置（可撤销）。":
      "Run auto layout?\n\nNodes will be arranged by wires and relation lines (undoable).",
    "确定进行一键排版？\n\n将按连线与关系线整理当前超级节点层级「{title}」内部的节点位置（可撤销）。":
      "Run auto layout?\n\nNodes inside the current super-node level “{title}” will be arranged by wires and relation lines (undoable).",
    "排版范围：默认只整理当前这一层（这颗超级节点内部）；也可改为排版整个画布（顶层节点，连各壳内部一起整理）。":
      "Layout scope: by default only this level (inside this super node); you may switch to the whole canvas (top-level nodes, including every shell's inside).",
    "排版整个画布": "Layout whole canvas",
    "仅排版当前层级": "Current level only",
    "已整理排版（当前超级节点层级）": "Layout tidied (current super-node level)",
    "这颗超级节点里还没有可排版的节点":
      "No nodes to layout inside this super node yet",
    "开始排版": "Start layout",
    "请选择排版方式：": "Choose a layout mode:",
    "简单排版": "Simple layout",
    "按连线关系快速整理节点位置（可撤销）":
      "Arrange nodes by wire flow (undoable)",
    "AI排版": "AI layout",
    "由全局助手分析并调整节点与绘制（可撤销，可能需等待）":
      "Global assistant analyzes and adjusts nodes and marks (undoable; may take a while)",
    "确定进行简单排版？\n\n将按连线关系整理节点位置（可撤销）。":
      "Run simple layout?\n\nNodes will be arranged by wire flow (undoable).",
    "确定进行 AI 排版？\n\n将由全局助手读取画布并调整节点与绘制位置，可能需要等待一段时间。每次画布改动可撤销。":
      "Run AI layout?\n\nThe global assistant will read the canvas and adjust node/mark positions; this may take a while. Each canvas edit is undoable.",
    "开始 AI 排版": "Start AI layout",
    "批次拆分已完成。是否进行重新排版？\n\n可选择简单排版或 AI 排版。":
      "Batch split done. Re-layout?\n\nChoose simple or AI layout.",
    "选择排版方式": "Choose layout",
    "一键排版：简单排版（按连线整理）或 AI 排版（全局助手分析调整，可撤销）":
      "Layout: simple (by wires) or AI (global assistant, undoable)",
    "下载模板": "Download template",
    "覆盖模板": "Overwrite template",
    "覆盖": "Overwrite",
    "卸载桌宠": "Uninstall desktop pet",
    "更改数据目录": "Change data directory",
    "迁移配置": "Migrate config",
    "不复制": "Don't copy",
    "重启应用": "Restart app",
    "立即重启": "Restart now",
    "恢复默认目录": "Restore default directory",
    "移除插件": "Remove plugin",
    "移除 MCP": "Remove MCP",
    "卸载插件": "Uninstall plugin",
    "删除会话": "Delete session",
    "确认": "Confirm",
    "审批与权限：权限预设 / 识图许可，可随时调整":
      "Approvals & permissions: preset / vision allow — adjust anytime",
    "审批与权限：权限预设 / 工具许可 / 识图许可，可随时调整":
      "Approvals & permissions: sandbox preset / agent tools / vision — adjust anytime",
    "权限预设已切换：": "Permission preset: ",
    "权限预设（沙箱 + 工具越权审批；下一轮智能任务起生效）":
      "Permission preset (sandbox + tool approval; applies from next agent run)",
    "Agent 工具许可（按类别；默认预设 = 当前产品能力。下一轮任务起写入系统提示，画布/应用/识图为硬拦截）":
      "Agent tool allowlist (by category; Default = current product capabilities. Next run gets a system note; canvas/app/vision are hard-blocked)",
    "Agent 工具许可（按类别：批准 / 询问 / 拒绝；默认全批准。下一轮任务起写入系统提示）":
      "Agent tools by category: Allow / Ask / Deny (all Allow by default). Applied from the next run via system note",
    "画布（MTNode）": "Canvas (MTNode)",
    "读取画布": "Read canvas",
    "节点与连线": "Nodes & wires",
    "创建 / 修改 / 删除普通节点，连接与断开":
      "Create / update / remove ordinary nodes; connect & disconnect",
    "控制类节点": "Control-flow nodes",
    "执行、清空、需求等待、判断、定时、成功/失败终点":
      "Run, clear, wait-for-file, judge, timer, success/fail ends",
    "执行、清空、需求等待、判断、定时、延时、序列、成功/失败终点":
      "Run, clear, wait-for-file, judge, timer, delay, sequence, success/fail ends",
    "每隔（天 / 时 / 分）": "Every (day / hour / min)",
    "当前间隔：": "Interval: ",
    " 天": "d",
    " 时": "h",
    " 分": "m",
    " 秒": "s",
    "抽卡次数": "Roll count",
    "连续生成次数（1–10）；多次时输出命名为 #1、#2 …":
      "Sequential generations (1–10); multiple runs save as #1, #2 …",
    "在文件夹中显示已生成文件": "Show generated file in folder",
    "用系统默认应用打开": "Open with default app",
    /* ── H3 自建 ComfyUI 工作流（video_gen 节点面板 · 库/扫描/注入真源在主进程）── */
    "内置 H3 链（首末帧 / 多参考）": "Built-in H3 chain (first/last frame · multi-ref)",
    "自建 ComfyUI 工作流": "Custom ComfyUI workflow",
    "自建": "Custom",
    "工作流来源": "Workflow source",
    "自建工作流库为空 · 请先在 H3 管理窗口导入":
      "The custom workflow library is empty — import one in the H3 manager first",
    "视频生成后端未就绪，无法读取自建工作流库": "Video backend not ready — cannot read the custom workflow library",
    "（库为空）": "(library empty)",
    "（库中已无此工作流）": "(no longer in the library)",
    "重新读取工作流（与库内最新图同步参数表）":
      "Re-read the workflow (sync the parameter table with the stored graph)",
    "管理": "Manage",
    "打开 H3 管理窗口 · 导入 / 删除自建工作流": "Open the H3 manager · import / delete custom workflows",
    "正在读取工作流参数…": "Reading workflow parameters…",
    "API 格式": "API format",
    "校验按后端 /object_info 比对节点包（后端未运行时跳过，不阻断生成）":
      "Validation diffs node classes against the backend /object_info (skipped while the backend is down; never blocks generation)",
    "校验节点包": "Validate nodes",
    "正在按后端 /object_info 校验…": "Validating against the backend /object_info…",
    "校验失败：": "Validation failed: ",
    "校验通过": "Validated",
    "缺节点包": "Missing node packs",
    "跳过校验（后端未运行）": "Skipped (backend not running)",
    "未校验": "Not validated",
    "自动（最后一个视频产物）": "Auto (last video artifact)",
    "多个输出节点时指定取哪一个作为本节点的视频产物":
      "When the graph has several output nodes, choose which artifact this node returns",
    "该工作流没有 Save* 输出节点，生成可能拿不到产物":
      "This workflow has no Save* output node — the run may return no artifact",
    "输出节点": "Output node",
    "提升为节点参数": "Promoted to node inputs",
    "每项在节点上占一个端子（端口 1 = 文本 · 端口 2+ = 素材）；未提升的字段沿用工作流里的默认值。":
      "Each entry takes one input port (port 1 = text · port 2+ = media); fields you do not promote keep the values baked into the workflow.",
    "当前没有提升任何参数：全部沿用工作流默认值（可只跑固定图）。":
      "Nothing promoted yet: every field keeps the workflow default (fine for a fixed graph).",
    "（选择要提升的参数…）": "(pick a parameter to promote…)",
    "提升": "Promote",
    "恢复建议映射": "Restore suggested mapping",
    "丢掉本节点上的改动，按工作流扫描结果重建参数表": "Discard local edits and rebuild the table from the workflow scan",
    "读取工作流失败：": "Failed to read the workflow: ",
    "读取工作流失败": "Failed to read the workflow",
    "刷新工作流失败：": "Failed to refresh the workflow: ",
    " 个参数落点已失效（图里改了）": " parameter target(s) vanished (the graph changed)",
    "已同步：新增 ": "Synced: added ",
    " 个建议参数": " suggested parameter(s)",
    "工作流已是最新": "Workflow is up to date",
    "参数类型决定它在节点上占用哪种端子": "The type decides which kind of input port it takes",
    "端子与面板上显示的名称": "Name shown on the port badge and in this panel",
    "端子 ": "Port ",
    "直填": "manual",
    "该参数由节点第 ": "Fed by node port ",
    " 号数据端子注入（端子优先于直填）": " (a wired port overrides the manual value)",
    "超出端子数（图 / 视频 / 音频上限 9 / 3 / 3）：只能用下方直填值":
      "Beyond the port budget (image / video / audio caps are 9 / 3 / 3): use the manual value below",
    "上移（调整端子顺序）": "Move up (reorder ports)",
    "下移（调整端子顺序）": "Move down (reorder ports)",
    "取消提升此参数": "Un-promote this parameter",
    "节点 ": "node ",
    "落点已失效": "target vanished",
    "当前工作流图里已找不到这个落点（图被改过）：点 ↻ 刷新或移除该参数":
      "This target no longer exists in the stored graph (it was edited): hit ↻ to refresh, or remove the parameter",
    "注入位置：该节点的该字段": "Injected into this field of that node",
    "种子由上方「种子 / 摇数」统一下发": "the seed is driven by the Seed / Reroll control above",
    "留空 = 用工作流默认值 ": "Blank = workflow default ",
    "留空 = 用工作流默认值": "Blank = workflow default",
    "端口没接数据时用这里的值": "Used when no wire feeds this port",
    "选择素材文件": "Choose media file",
    "素材文件": "Media file",
    "（生成时自动上传到 ComfyUI）": "(uploaded to ComfyUI when the node runs)",
    "自建工作流：时长 / 分辨率 / 后处理由工作流图自身决定":
      "Custom workflow: duration / resolution / post-processing come from the graph itself",
    "自建 ComfyUI 工作流：点 ⚙ 在设置窗口里换工作流 / 改参数映射":
      "Custom ComfyUI workflow: click ⚙ to switch workflows or edit the parameter mapping in the settings window",
    "尺寸比例": "Aspect ratio",
    "自动（按比例默认）": "Auto (by aspect ratio)",
    "输出分辨率": "Output resolution",
    "采样步数": "Sampling steps",
    "24G 优化（默认开，可关）": "24G optimisations (on by default, can turn off)",
    "天": "d",
    "时": "h",
    "分": "m",
    "智能填写": "Smart fill",
    "用自然语言描述计划，由 AI 生成 Cron 表达式":
      "Describe the schedule in natural language; AI fills the cron",
    "智能填写 Cron": "Smart-fill cron",
    "用自然语言描述…": "Describe in plain language…",
    "描述你的定时计划（例如：每个工作日上午 9 点；每小时的第 0 分；每周日 22:30）":
      "Describe your schedule (e.g. weekdays at 9:00; every hour at :00; Sundays 22:30)",
    "请填写计划需求": "Enter a schedule description",
    "正在生成 Cron…": "Generating cron…",
    "生成失败": "Generation failed",
    "生成失败：": "Generation failed: ",
    "无法解析模型返回的 Cron：": "Could not parse cron from model: ",
    "已填写 Cron：": "Cron filled: ",
    "间隔无效（至少 1 分钟）": "Invalid interval (min 1 minute)",
    "延时器": "Delayer",
    "延时器（等待后继续）": "Delayer (wait then continue)",
    "延时": "Delay",
    "延时（天 / 时 / 分）": "Delay (day / hour / min)",
    "控制脉冲到达后等待指定时长再继续":
      "After a control pulse, wait then continue",
    "取消延时": "Cancel delay",
    "立即延时并启用输出端目标": "Delay now and enable output targets",
    "已请求取消延时…": "Canceling delay…",
    "延时中… ": "Delaying… ",
    "已取消": "Canceled",
    "已延时 ": "Delayed ",
    "延时已取消": "Delay canceled",
    "延时结束：": "Delay done: ",
    "等待控制脉冲 · 延时 ": "Waiting for pulse · delay ",
    "有输入端子。控制流到达后等待指定时长，再沿输出继续。也可点 ▶ 立即延时并启用已连接目标。":
      "Has an input. After a control pulse, waits then continues. ▶ delays immediately and enables connected targets.",
    "序列器": "Sequencer",
    "序列器（按序多路）": "Sequencer (ordered outputs)",
    "序列": "Seq",
    "输出路数": "Output lanes",
    "步间间隔（天 / 时 / 分，可全 0）":
      "Gap between steps (d/h/m; all 0 = none)",
    "步间间隔：": "Step gap: ",
    "步间间隔：无（立即接续）": "Step gap: none (immediate)",
    "按序点燃 ": "Fire in order ",
    " 路输出": " outputs",
    "按顺序逐个点燃多路输出": "Fire multiple outputs in order",
    "取消序列": "Cancel sequence",
    "按序触发各输出端连接的目标": "Fire each output's targets in order",
    "已请求取消序列…": "Canceling sequence…",
    "序列 ": "Step ",
    "序列完成": "Sequence done",
    "序列完成：": "Sequence done: ",
    "序列已取消：": "Sequence canceled: ",
    "序列失败：": "Sequence failed: ",
    "序列输出 ": "Sequence out ",
    "有输入端子与多路输出（1…N）。控制流到达后按顺序逐路点燃；可设步间间隔。点 ▶ 可单独试跑序列。":
      "Has an input and outputs 1…N. After a pulse, fires each lane in order; optional gap. ▶ runs the sequence alone.",
    "闸门": "Gate",
    "闸门（全部到达才放行）": "Gate (AND — all inputs)",
    "全部输入到达后才放行": "Release only after all inputs arrive",
    "强制放行（清除到达状态并启用目标）":
      "Force release (clear arrivals and enable targets)",
    "输入路数": "Input lanes",
    "清除到达": "Clear arrivals",
    "清除各输入到达标记，重新等待": "Clear arrival flags and wait again",
    "已清除到达标记": "Arrival flags cleared",
    "未连接输入 · 连接后等待全部到达":
      "No inputs · connect wires, then wait for all",
    "已到 ": "Arrived ",
    " · 全部到达后放行": " · release when all arrive",
    "未连接输入": "No inputs connected",
    "闸门已放行": "Gate released",
    "强制放行": "Force release",
    "闸门放行：": "Gate released: ",
    "闸门失败：": "Gate failed: ",
    "多路输入 AND：已连接的输入端子全部收到控制脉冲后，才沿输出放行一次并清零。▶ 可强制放行。":
      "AND join: after every connected input gets a pulse, fires once and resets. ▶ force-releases.",
    "多路输入 AND：按配置的输入路数，每一路都收到控制脉冲后才放行一次并清零（未接线的口也会挡住放行）。▶ 可强制放行。":
      "AND join by configured lanes: every input port must receive a pulse (unwired ports also block). ▶ force-releases.",
    " · 尚有 ": " · ",
    " 路未接线": " lane(s) unwired",
    "脉冲未落在配置输入口内": "Pulse not on a configured input port",
    "分发": "Splitter",
    "分发（并行多路）": "Splitter (parallel fan-out)",
    "一路入同时点亮多路出": "One in, fire all outs together",
    "取消分发": "Cancel split",
    "并行触发各输出端连接的目标": "Fire all output targets in parallel",
    "已请求取消分发…": "Canceling splitter…",
    "并行点燃 ": "Parallel fire ",
    "并行分发 ": "Parallel split ",
    "分发完成": "Split done",
    "分发完成：": "Split done: ",
    "分发已取消：": "Split canceled: ",
    "分发失败：": "Split failed: ",
    "分发输出 ": "Split out ",
    "一路入、多路出：控制脉冲到达后同时点亮全部输出（序列器的并行版）。▶ 可单独试跑。":
      "One in, many outs: after a pulse, fires all lanes together (parallel sequencer). ▶ solo run.",
    "计数": "Counter",
    "计数（每 N 次放行）": "Counter (every N pulses)",
    "每经过 N 次脉冲放行一次": "Release once every N pulses",
    "计入一次并在达到阈值时放行": "Count once; release when threshold hit",
    "每 N 次放行": "Every N",
    "清零计数": "Reset count",
    "计数已清零": "Count reset",
    "当前 ": "Now ",
    "计数放行": "Counter release",
    "计数 ": "Count ",
    "计数放行：": "Counter released: ",
    "计数失败：": "Counter failed: ",
    "每收到 N 次控制脉冲才放行一次并清零计数。▶ 计入一次。":
      "Releases once every N control pulses, then resets. ▶ counts once.",
    "互斥": "Mutex",
    "互斥（多入选一）": "Mutex (pick one of many)",
    "多路输入择一路放行": "Pick one of many inputs to release",
    "按模式从已连接输入择一路放行":
      "Pick one connected input by mode and release",
    "选择模式": "Select mode",
    "先到优先": "First wins",
    "端口优先（小号优先）": "Port priority (lowest first)",
    "随机一路": "Random lane",
    "多入选一 · ": "Pick one · ",
    "选中输入 ": "Chose input ",
    "请先连接互斥输入": "Connect mutex inputs first",
    "互斥放行：": "Mutex released: ",
    " · 输入 ": " · input ",
    "互斥失败：": "Mutex failed: ",
    "找不到该节点指南": "No guide for this node",
    "指南文件：": "Guide file: ",
    "载入中…": "Loading…",
    "载入失败：": "Failed to load: ",
    "待监视的文件路径": "File path to watch",
    "开始监视文件": "Start watching the file",
    "多路输入 OR：任一输入脉冲即沿输出放行（先到即触发）。▶ 试跑时按模式在已连接输入中择一路标记。":
      "OR join: any input pulse releases the output. ▶ marks one connected input by mode.",
    "闸门输入 ": "Gate in ",
    "（需全部到达）": " (all required)",
    "互斥输入 ": "Mutex in ",
    "绘图": "Drawing",
    "创建 / 修改 / 删除绘制标记": "Create / update / remove marks",
    "排版与成组": "Layout & groups",
    "自动排版、创建组": "Auto-layout and create groups",
    "应用": "App",
    "应用操作": "App operations",
    "状态、列表、重命名、选中、撤销重做":
      "Status, list, rename, select, undo/redo",
    "状态、列表、重命名、选中、撤销重做、长任务图读取与原地修改":
      "Status, list, rename, select, undo/redo, and reading / editing an existing long-task graph in place",
    "删除画布": "Delete canvas",
    "基础能力（引擎）": "Core capabilities (engine)",
    "读文件": "Read files",
    "浏览与读取工作区文件": "Browse and read workspace files",
    "写文件": "Write files",
    "创建、修改、删除工作区文件": "Create, edit, delete workspace files",
    "终端命令": "Shell",
    "在工作区执行命令": "Run commands in the workspace",
    "联网": "Web",
    "搜索与抓取网页": "Search and fetch web pages",
    "子代理任务": "Subagent tasks",
    "派生子任务": "Spawn sub-tasks",
    "目标与任务清单": "Goals & task lists",
    "跨轮续跑目标 + Todo 清单": "Cross-run goals + Todo list",
    "后台命令与子代理的收流 / 终止": "Collect output from / kill background jobs & subagents",
    "向用户提问": "Ask the user",
    "ask 交互": "ask interaction",
    "识图": "Vision",
    "识图子代理": "Vision subagent",
    "默认（当前能力）": "Default (current capabilities)",
    "自定义预设": "Custom preset",
    "自定义": "Custom",
    "新预设名称": "New preset name",
    "重命名预设": "Rename preset",
    "＋ 新建": "+ New",
    "重命名": "Rename",
    "已新建工具预设：": "Created tool preset: ",
    "预设已重命名：": "Preset renamed: ",
    "工具预设已切换：": "Tool preset: ",
    "内置默认预设不能重命名": "Built-in default preset cannot be renamed",
    "内置默认预设不能删除": "Built-in default preset cannot be deleted",
    "删除工具预设「": "Delete tool preset “",
    "」？": "”?",
    "已删除工具预设": "Tool preset deleted",
    "询问 ": "Ask ",
    "拒绝 ": "Deny ",
    " · 已关闭 ": " · off ",
    " 个类别": " categories",
    "当前工具预设不允许：": "Current tool preset does not allow: ",
    "。请在右上角「审批」中调整 Agent 工具许可。":
      ". Adjust Agent tool allowlist in Approvals (top-right).",
    "【Agent 工具许可】当前预设「": "[Agent tools] Active preset “",
    "」。": "”. ",
    "当前预设允许全部已列出的工具类别（与产品默认能力一致）。":
      "This preset allows all listed tool categories (same as the product default).",
    "禁止：": "Denied: ",
    "拒绝：": "Denied: ",
    "询问：": "Ask: ",
    "（调用前会请用户确认）。": " (will ask before use).",
    "批准": "Allow",
    "询问": "Ask",
    "工具许可 · ": "Tool access · ",
    "切换工具预设": "Switch tool preset",
    "全部允许": "Allow all",
    "将当前预设的所有工具设为「批准」": "Set every tool of the current preset to Allow",
    "已全部设为允许": "All tools set to Allow",
    "Agent 请求使用工具：": "Agent requests tool: ",
    "工具许可询问": "Tool permission",
    "用户拒绝": "User denied",
    "禁止项对应的工具不可调用；画布 / 应用 / 识图类调用会被系统直接拒绝。":
      "Do not call denied tools; canvas / app / vision calls are rejected by the app.",
    "拒绝项对应的工具不可调用；画布 / 应用 / 识图类调用会被系统直接拒绝。":
      "Do not call denied tools; canvas / app / vision calls are rejected by the app.",
    "基础能力的禁止项请遵守，不要调用读/写文件、终端、联网、子代理或向用户提问中被关掉的能力。":
      " Honor denied core capabilities: do not read/write files, run a shell, use the web, spawn subagents, or ask the user if that category is off.",
    "与上方「权限预设」独立：那边管沙箱与越权是否询问，这边管 Agent 允许调用哪些能力。可勾选修改当前预设，或「＋ 新建」另存一份。画布/应用/识图会直接拒绝未授权调用；读文件/终端/联网等基础能力写入系统提示约束。":
      "Independent of the sandbox preset above (that one covers sandbox + overreach prompts). This allowlist is which capabilities the agent may use. Edit the current preset or + New to clone. Canvas/app/vision are hard-blocked; file/shell/web are constrained via the system prompt.",
    "与上方「权限预设」独立：那边管沙箱与越权是否询问，这边管 Agent 允许调用哪些能力。批准=直接可用，询问=调用前确认，拒绝=硬拦截。可切换当前预设，或「＋ 新建」另存一份。":
      "Independent of the sandbox preset above. Allow = use freely, Ask = confirm before use, Deny = hard block. Switch the current preset or + New to clone.",
    "识图子代理 mtnode_vision（查看本地图片前的许可）":
      "Vision tool mtnode_vision (permission before reading local images)",
    "识图：始终允许": "Vision: always allow",
    "识图：本会话已允许": "Vision: allowed this session",
    "识图：本会话已拒绝（不再提示）": "Vision: denied this session (no more prompts)",
    "识图：每次询问": "Vision: ask every time",
    "本会话允许": "Allow this session",
    "每次询问": "Ask every time",
    "本会话拒绝": "Deny this session",
    "若智能任务报 mtnode_vision 失败 / 审批被禁用：点「始终允许」或「本会话允许」即可恢复识图。无人值守预设不会弹工具审批；需要逐项确认时请改用「工作区读写 · 逐项审批」。":
      "If mtnode_vision fails or approvals seem disabled: click Always allow or Allow this session. Unattended preset never prompts for tools; switch to Workspace write · approve each when you want prompts.",
    "全局助手改画布": "Global assistant canvas edits",
    "自动批准画布修改（不弹确认）": "Auto-approve canvas edits (no confirm)",
    "画布修改确认": "Canvas edit confirmation",
    "批准=不弹窗；询问=每次确认": "Allow = no prompt; Ask = confirm each time",
    "已开启：全局助手改画布不再弹确认": "On: assistant canvas edits skip confirm",
    "已关闭：全局助手改画布需确认": "Off: assistant canvas edits require confirm",
    "识图已被本会话拒绝；请点右上角「审批」改为允许":
      "Vision denied for this session; click Approvals (top-right) to allow",
    "「始终允许」会记住选择；「允许一次」仅本次会话有效。图片会发给已配置的视觉模型。也可随时点右上角「审批」调整。":
      "Always allow is remembered; Allow once lasts this session. Images go to your configured vision model. Adjust anytime via Approvals (top-right).",
    "模型列表（从上到下为使用优先级）": "Models (top = highest priority)",
    "当前优先使用": "Preferred now",
    "拖动或点击箭头调整优先级": "Drag the row, or use the arrows, to change priority",
    "提高优先级": "Higher priority",
    "降低优先级": "Lower priority",
    "移除该模型": "Remove model",
    "暂无模型，请在下方添加": "No models yet — add below",
    "添加模型 id，如 gpt-4o-mini": "Add model id, e.g. gpt-4o-mini",
    "模型已存在": "Model already listed",
    "添加": "Add",
    "提高供应商优先级": "Higher provider priority",
    "降低供应商优先级": "Lower provider priority",
    "供应商使用优先级（越小越优先）": "Provider priority (lower # = higher)",
    "（供应商与模型均可排序，越靠前优先级越高）":
      "(Reorder providers and models — higher in the list = higher priority)",
    "会话模式：开 · 保留多轮对话历史（再点关闭）":
      "Chat mode: on · keep multi-turn history (click again to turn off)",
    "会话模式：关 · 每次 ▶ 都是新对话，输入框内容保留（点击开启）":
      "Chat mode: off · each ▶ is a fresh chat; prompt text is kept (click to enable)",
    "已开启会话模式：多轮对话": "Chat mode on: multi-turn conversation",
    "已关闭会话模式：每次执行为新对话，提示词保留":
      "Chat mode off: each run is a new chat; prompt is kept",
    "描述任务…（每次 ▶ 为新对话，输入保留；点 💬 开会话模式）":
      "Describe the task… (each ▶ is a fresh chat; text is kept; click 💬 for chat mode)",
    "描述任务…（每次 ▶ 为新对话，输入保留；点 💬 开会话模式；输入 / 呼出技能）":
      "Describe the task… (each ▶ is a fresh chat; text is kept; click 💬 for chat mode; type / for skills)",
    "识图：完全放行（随权限预设）": "Vision: full access (via permission preset)",
    "已尝试：": "Tried:",
    "没有可用的视觉模型；请在「模型服务」把支持识图的服务商排到前面，勾选「支持视觉」，并把视觉模型排到该服务商列表最前（DeepSeek 官方不支持识图）":
      "No vision model available; in Model services put a vision-capable provider first, enable Vision, and put a vision model at the top of that provider (DeepSeek Official cannot read images)",
    "下载到画布": "Download to canvas",
    "（空画布）": "(Empty canvas)",
    "缩略图 ": "Thumb ",
    "标题：": "Title: ",
    "源文件名：": "Source name: ",
    "资产文件：": "Asset file: ",
    "标题（角色名 / 输出文件后缀）": "Title (character name / output suffix)",
    "空白处或「选择图像」更换文件；点击图像可预览大图":
      "Click empty area or “Choose image” to replace; click the image to preview",
    "预览图像": "Preview image",
    "去背": "Cutout",
    /* ── 图像生成 · 透明背景（双通道差分抠图 Two-Pass Difference Matting）── */
    "透明背景": "Transparent background",
    "透明背景 · 双通道差分抠图": "Transparent bg · two-pass difference matting",
    "背景移除": "Background remove",
    "启用（自动生成黑底基准 + 白底复刻两张图后差分抠图，2 倍 Token）":
      "Enable (auto-generate the pure-black baseline pass + the white replica pass, then difference-matte them; 2× tokens)",
    "自动对齐修正（按前景包围盒与边缘吻合度对齐第 2 通道）":
      "Auto alignment fix (match pass 2 to pass 1 by foreground box and edge agreement)",
    "噪点地板（越低越保留半透明，越高越敢判为全透明，0-128）":
      "Noise floor (lower keeps more semi-transparency, higher punches to fully clear, 0–128)",
    "边缘羽化（只平滑 Alpha 通道，0-128）":
      "Edge feather (smooths the alpha channel only, 0–128)",
    "第 1 通道（基准）注入纯黑背景要求；第 2 通道把第 1 张原图当唯一参考图下发，注入完全一致的纯白背景要求，两图按 α=(bgRange-白+黑)/bgRange 逐像素求出 Alpha —— bgRange 是两张图实际测到的背景色差（模型交的常常是 250 / 8 这种伪黑白，按理想 255 / 0 硬算就会给整幅画蒙上一层薄雾）。只有能把基准图下发的服务商（OpenAI 兼容 / Stability 生图）才会抠图，其余自动跳过并提示。提示词正文由你正常书写，注入段不会显示在你的输入里。":
      "Pass 1 (the baseline) injects a pure-black background request; pass 2 receives that exact image as its only reference and injects the identical request with a pure-white background. Alpha is solved per pixel as α=(bgRange−white+black)/bgRange, where bgRange is the background level actually measured on the two images (models usually deliver a fake 250/8 rather than a perfect 255/0 — hard-coding the ideal value fogs the whole picture). Only providers that can send the baseline image as a reference (OpenAI-compatible / Stability) get matted — the rest are skipped with a notice. Your own prompt stays untouched; the injected block is appended separately.",
    "用已存的两通道重算抠图": "Re-matte from the stored two passes",
    "请先开启透明背景": "Turn on transparent background first",
    "没有可复用的两通道记录：请点 ▶ 重新生成一次":
      "No stored pass pair to reuse: press ▶ to generate once more",
    "重算失败：": "Re-matte failed: ",
    "已按新参数重算 ": "Re-matted ",
    " 张透明背景图像": " transparent image(s) with the new settings",
    "透明背景写入失败": "Failed to write matted image",
    "第 2 通道（纯白背景）调用失败": "Pass 2 (pure white background) call failed",
    "第 2 通道响应无图像数据": "Pass 2 response has no image data",
    "第 2 通道写入失败": "Failed to write pass 2 image",
    "缺少第 1 通道基准图，无法生成第 2 通道": "Missing the pass-1 baseline image, cannot generate pass 2",
    "本服务商无法严格锚定第 2 通道（接口收不到第 1 通道原图）":
      "This provider cannot strictly anchor pass 2 (its API receives no image from pass 1)",
    "透明背景已跳过：": "Transparent background skipped: ",
    "，本次只交付第 1 通道（纯黑背景）原图。可改用 OpenAI 兼容 / Stability 生图，或关掉透明背景。":
      " — delivering only pass 1 (pure black background) this time. Switch to an OpenAI-compatible / Stability image provider, or turn transparent background off.",
    "透明背景完成（双通道差分抠图，耗时 ": "Transparent background done (two-pass matting, ",
    " 秒）": " s)",
    "透明背景抠图未完成，已交付第 1 通道（纯黑背景）原图：":
      "Transparent matting incomplete; delivering the pass-1 (pure black background) image: ",
    "透明背景已开启：每次生成会出 2 张图（纯黑基准 + 严格对齐的纯白复刻），Token 与耗时约 2 倍":
      "Transparent background on: every run now generates 2 images (pure-black baseline + strictly aligned white replica), about 2× tokens and time",
    "透明背景已关闭": "Transparent background off",
    "透明背景（双通道差分抠图）已开启：以下是第 1 通道（纯黑背景 · 唯一基准）请求。运行时会把那张原图当唯一参考图，自动补发第 2 通道（严格复刻、只换纯白背景）并差分出 Alpha —— 共 2 次生成，约 2 倍 Token。\n\n":
      "Transparent background (two-pass difference matting) is on: below is pass 1 (pure black · the sole baseline). At run time that exact image is sent as the only reference, so pass 2 (an identical replica on pure white) is auto-generated and differenced into alpha — 2 generations, about 2× tokens.\n\n",
    "透明背景（双通道差分抠图）已开启，但本服务商无法严格锚定第 2 通道（接口收不到第 1 通道原图）：运行时将跳过抠图，只交付第 1 通道（纯黑背景）这一张，不会另画一张凑数。\n\n":
      "Transparent background (two-pass difference matting) is on, but this provider cannot strictly anchor pass 2 (its API receives no image from pass 1): matting will be skipped at run time and only pass 1 (pure black background) is delivered — no second image will be painted from scratch.\n\n",
    "【透明背景 · 双通道差分抠图｜第 1 通道（基准）：纯黑背景】请把画面中除主体以外的全部背景区域（含天空、地面、投影、环境细节）绘制成完全均匀的纯黑 #000000：无渐变、无纹理、无阴影、无反射、无暗角、无地面投影。主体保持完整清晰，边缘锐利干净，构图居中稳定、四周留出一圈空白边距，主体不得触碰或超出画面边缘。这一张是本次抠图的唯一基准：随后会严格复刻它、只替换背景色来求 Alpha，因此请按最终成品的标准画好主体。":
      "[Transparent background · two-pass difference matting | Pass 1 (baseline): pure black] Paint every area outside the subject (sky, ground, shadows, environment) as perfectly uniform pure black #000000: no gradient, texture, shading, reflection, vignette or cast shadow. Keep the subject complete and crisp with clean edges, centred and stable, with empty margin on all sides and nothing touching the frame edge. This image is the sole baseline for the matte — a second pass will replicate it pixel-for-pixel and only swap the background colour, so draw the subject to final quality.",
    "【透明背景 · 双通道差分抠图｜第 2 通道：纯白背景】请把参考图的背景整体替换为完全均匀的纯白 #FFFFFF：无渐变、无纹理、无光晕、无投影。参考图是本次任务的唯一基准，除背景颜色以外，画面的一切内容必须与它逐像素完全一致——主体的位置、大小、比例、朝向、姿态、轮廓、颜色、纹理、细节、光照、构图与画幅都不得有任何变化；不要重绘主体，不要移动，不要缩放，不要裁切，不要加边框。":
      "[Transparent background · two-pass difference matting | Pass 2: pure white] Replace the reference image's background entirely with perfectly uniform pure white #FFFFFF: no gradient, texture, glow or cast shadow. The reference is the sole baseline for this job: apart from the background colour, every pixel must match it exactly — subject position, size, scale, orientation, pose, silhouette, colours, texture, detail, lighting, composition and canvas bounds must not change at all. Do not repaint, move, scale, crop or add a border.",
    "透明背景 · 双通道差分抠图：已开启\n\n开启后本节点生成的图像会自动变为透明背景（带 Alpha 的 PNG）。\n算法：第 1 次生成纯黑背景，作为整套抠图的唯一基准；随后自动补生成一张以它为唯一参考图、严格对齐的纯白背景图，两图逐像素差分出真实 Alpha（半透明边缘也能保留）。\n\n⚠ 整个过程在内部完成，你只需正常写提示词；但每次出图实际要生成 2 张，Token 与耗时约为 2 倍，请慎用。\n⚠ 只有能把基准图当参考图下发的服务商（OpenAI 兼容 / Stability 生图）才会抠图；其余自动跳过并提示，不会退化成另画一张（两张独立生成的图必然错位，结果就是满屏虚影）。\n\n单击 = 关闭 · 右键 = 调整抠图参数":
      "Transparent background · two-pass difference matting: ON\n\nGenerated images automatically come out with a transparent background (PNG with alpha).\nHow: pass 1 renders on pure black and becomes the sole baseline; pass 2 then receives exactly that image as its only reference and renders an identical, strictly aligned pure-white version, and the two are differenced into real alpha per pixel (semi-transparent edges survive).\n\n⚠ This all happens internally — just write your prompt as usual; but every output costs 2 generations, so tokens and wait are roughly 2×. Use with care.\n⚠ Only providers that can receive the baseline as a reference (OpenAI-compatible / Stability) get matted; the rest are skipped with a notice instead of falling back to a second fresh render (two independent images never line up — that is what produced the ghosting).\n\nClick = off · right-click = matte settings",
    "透明背景 · 双通道差分抠图：已关闭（单击开启）\n\n开启后生成的图像会变为透明背景：先出纯黑背景作为基准，再自动出以它为唯一参考图、严格对齐的纯白背景，两图差分抠出 Alpha。\n\n⚠ 需要生成 2 次图像，因此耗费 2 倍 Token，请慎用。\n⚠ 需要服务商能把基准图当参考图下发（OpenAI 兼容 / Stability 生图），否则自动跳过抠图。\n\n右键 = 调整抠图参数":
      "Transparent background · two-pass difference matting: OFF (click to turn on)\n\nWhen on, output comes with a transparent background: pass 1 renders on pure black as the baseline, then pass 2 renders a strictly aligned pure-white replica that receives exactly that baseline as its only reference, and the two are differenced into an alpha matte.\n\n⚠ It generates the image twice, so it costs 2× tokens — use with care.\n⚠ Requires a provider that can take the baseline as a reference image (OpenAI-compatible / Stability); otherwise matting is skipped.\n\nRight-click = matte settings",
    /* ── 图像生成 · quality / background / 蒙版局部重绘（app.js · app-mask.js ·
          app-canvas.js · app-nodes.js）── */
    "服务商 / 模型 / 尺寸 / 质量 / 背景": "Provider / model / size / quality / background",
    "质量 Quality（low/medium/high/xhigh/max/auto）":
      "Quality (low/medium/high/xhigh/max/auto)",
    "背景 Background": "Background",
    "默认（不传 · 服务商按 auto）": "Default (not sent · provider uses auto)",
    "不透明 opaque": "Opaque",
    "透明 transparent（直出 Alpha PNG）": "Transparent (direct alpha PNG)",
    "蒙版重绘": "Mask inpaint",
    "背景选「透明」时，运行会在提示词末尾自动补上「背景必须为真透明通道」的要求，并禁用头部的差分透明算法按钮（接口已直出 Alpha，双通道抠图纯属多花 2 倍 Token）。注意编辑接口的透明是「重绘去背」，不是精确抠像。":
      "With background = transparent, the run appends a “the background must be a real alpha channel” requirement to the prompt and disables the two-pass difference matting button (the API already returns alpha, so diff matting would just cost 2× tokens for nothing). Note: the edit endpoint’s transparency is “repaint and cut out”, not precise matting.",
    "蒙版局部重绘：节点头部的蒙版小按钮，单击开 / 关（首次开启会打开蒙版编辑器），右键随时重新编辑。编辑器里用透明绿涂抹要重绘的区域，程序把它转成「透明=可编辑」的 Alpha 蒙版，与原图、提示词一起发给 gpt-image-2。":
      "Masked inpainting: the mask button in the node header. Click to toggle on/off (the first time it opens the mask editor); right-click re-opens the editor. Paint the region to repaint in transparent green; the app turns it into an alpha mask where “transparent = editable” and sends it with the image and prompt to gpt-image-2.",
    "【透明背景 · 直出 Alpha】请把主体以外的全部背景生成为真正的透明通道（PNG Alpha）：不要任何底色、不要棋盘格、不要白边或黑边、不要地面投影与光晕；主体边缘干净利落、不留背景残渣。不要把「透明」画成灰色或白色背景，也不要用纯色填充去模拟透明。":
      "[Transparent background · direct alpha] Render everything outside the subject as a real transparent channel (PNG alpha): no base color, no checkerboard, no white or black fringes, no ground shadow, no glow; the subject edges must be clean with no background residue. Do not paint “transparency” as a grey or white background, and do not simulate it with a flat fill.",
    "【蒙版局部重绘 · 只编辑蒙版透明区域】本次请求带有蒙版（mask），蒙版的透明区域就是唯一允许编辑的区域，不透明区域不在本次编辑范围内。\n1）编辑任务：只把蒙版透明区域内的内容按下面的用户要求修改（把透明区域内的对象改为 / 替换为 / 生成为用户提示词所描述的内容），透明区域之外一律不动。\n2）必须保持：蒙版不透明区域内的构图、相机视角与透视、物体位置与大小、轮廓与边缘、光线方向与色温、景深与虚化、整体色调、材质细节与真实摄影质感完全不变；不裁切、不缩放、不旋转、不平移、不加边框、不重新排版画面。\n3）融合要求：新内容自然位于原来的位置，其阴影、反射、遮挡与接触关系必须符合现场光照与透视，边缘过渡干净自然，不新增任何其他物体，不出现蒙版边界痕迹、色块或接缝。\n除蒙版透明区域内的上述修改外，输出图像必须与输入图像逐像素一致。":
      "[Masked inpainting · edit only the mask's transparent area] This request carries a mask; the mask's transparent area is the only editable region, and the opaque area is out of scope for this edit.\n1) Edit task: change only the content inside the mask's transparent area according to the user request below (turn / replace / generate the objects inside the transparent area into what the user prompt describes); leave everything outside the transparent area untouched.\n2) Must stay unchanged: within the mask's opaque area, the composition, camera angle and perspective, object position and size, silhouette and edges, light direction and colour temperature, depth of field and blur, overall tonality, material detail and true photographic quality must remain exactly the same; no cropping, scaling, rotation, shifting, border or re-layout of the frame.\n3) Blending: the new content sits naturally in its original place, its shadows, reflections, occlusion and contact relationships must match the scene's lighting and perspective, edges transition cleanly, no extra objects are added, and no mask boundary lines, patches or seams appear.\nApart from the changes inside the mask's transparent area described above, the output image must be pixel-for-pixel identical to the input image.",
    "差分透明算法已禁用：背景已设为「透明」，接口会直出带 Alpha 的 PNG，不必再花 2 倍 Token 做双通道差分。\n如需差分抠图，请把「背景」改回「默认」或「不透明」。":
      "Difference matting is disabled: background is set to “transparent”, so the API returns an alpha PNG directly — no need to spend 2× tokens on two-pass diffing.\nTo use diff matting, set Background back to “default” or “opaque”.",
    "蒙版局部重绘只支持 OpenAI 兼容的图像服务商（gpt-image-2 的 /images/edits）：当前服务商类型为 ":
      "Masked inpainting only supports OpenAI-compatible image providers (gpt-image-2 /images/edits): the current provider type is ",
    "蒙版局部重绘需要至少一张图像输入：请把要重绘的底图接到本节点（首张图即蒙版背景，蒙版按它的原尺寸绘制）":
      "Masked inpainting needs at least one image input: connect the image to be repainted to this node (the first image is the mask background, and the mask is painted at its full size).",
    "本次以蒙版局部重绘为准：画幅锁定已跳过（补边会改写第 1 张参考图，蒙版就与原图错位了）。如需补边请先关掉蒙版。":
      "Masked inpainting takes precedence this run: aspect-ratio lock was skipped (padding rewrites the first reference image and the mask would no longer line up). Turn the mask off first if you need padding.",
    "蒙版局部重绘": "Masked inpainting",
    "在首张参考图上涂抹要重绘的区域": "Paint the region to repaint on the first reference image",
    "画笔": "Brush",
    "方形": "Rectangle",
    "圆形": "Ellipse",
    "画笔尺寸": "Brush size",
    "羽化半径": "Feather radius",
    "确定并启用": "Apply and enable",
    "这个节点还没有可用的图像输入：请先连入一张图像（首张图会作为蒙版背景），再打开本编辑器。":
      "This node has no usable image input yet: connect an image first (the first image becomes the mask background), then open this editor.",
    "怎么操作：左键涂抹 = 标记「要重绘」的区域；按住右键涂抹 = 擦除标记。画笔尺寸与羽化半径在左侧工具栏调；方形 / 圆形可按住左键拖出一块区域（按住右键拖 = 从标记里减去）。\n它如何影响图像：确定后，程序把「原图 + 蒙版 + 提示词」一起发给 gpt-image-2——涂抹过（透明绿）的区域才会被重绘，没涂到的区域尽量保留原图。提示词只写「要改成什么」即可：程序会自动追加内置的蒙版要求段（只编辑蒙版透明区域 / 编辑任务 / 必须保持：构图·视角·透视·蒙版外物体·光线方向与色温·摄影质感 / 融合要求：阴影·反射·接触关系符合现场光、不新增物体）。\n注意：这是引导式编辑，不是逐像素的硬限制——蒙版边缘附近仍可能有细微变化；把标记比目标物体稍微放大一圈（覆盖边缘 / 阴影）效果更稳。":
      "How to use: left-drag to paint the region to repaint; right-drag to erase the paint. Brush size and feather radius are in the left toolbar; rectangle/ellipse let you drag out an area with the left button (right-drag subtracts from the mask).\nHow it affects the image: the app sends image + mask + prompt to gpt-image-2 — only the painted (transparent green) region is repainted, while the rest is kept as close to the original as possible. Just write what should change: the app automatically appends the built-in mask requirement block (edit only the mask's transparent area / edit task / must stay unchanged: composition, camera angle, perspective, everything outside the mask, light direction and colour temperature, photographic quality / blending: shadows, reflections and contact relationships matching the scene light, no extra objects).\nNote: this is guided editing, not a hard per-pixel limit — pixels near the mask edge may still shift slightly; painting a little beyond the target (covering edges and shadows) gives steadier results.",
    "请先在图上涂抹要重绘的区域，再点「确定并启用」":
      "Paint the region to repaint first, then click “Apply and enable”.",
    "蒙版保存失败：": "Failed to save the mask: ",
    "蒙版已保存并启用：运行时只重绘涂抹过的区域（未涂抹处尽量保持原图）":
      "Mask saved and enabled: only the painted region will be repainted (everything else stays as close to the original as possible).",
    "蒙版局部重绘：已开启\n\n上传原图 + 蒙版 + 提示词，只重绘蒙版里涂抹过的区域：\n· 涂抹过（透明绿）的区域 = 交给模型重绘；\n· 没涂到的区域 = 尽量保持原图不变。\n· 出图画幅 = 首张参考图的像素尺寸（节点自己选的 size 不生效，否则服务端重排输入图会让蒙版错位）。\n\n单击 = 开 / 关 · 右键 = 打开蒙版编辑器":
      "Masked inpainting: on\n\nImage + mask + prompt are sent together, and only the painted region is repainted:\n· painted (transparent green) area = handed to the model for repainting;\n· unpainted area = kept as close to the original as possible.\n· Output canvas = the first reference image's pixel size (the node's own size setting is ignored, otherwise the service would re-lay the input image and the mask would no longer line up).\n\nClick = on/off · right-click = open the mask editor",
    "蒙版局部重绘：已关闭（单击开启）\n\n开启后可在首张参考图上涂抹要改的区域，运行时把「原图 + 蒙版 + 提示词」一起发给 gpt-image-2，只重绘涂抹过的区域；未涂抹处尽量保持不变。\n\n⚠ 需要有至少一张图像输入（首张图作为蒙版背景），且服务商为 OpenAI 兼容图像服务商。\n\n右键 = 打开蒙版编辑器":
      "Masked inpainting: off (click to enable)\n\nOnce enabled you can paint the region to change on the first reference image; at run time image + mask + prompt are sent to gpt-image-2 and only the painted region is repainted.\n\n⚠ Requires at least one image input (the first becomes the mask background) and an OpenAI-compatible image provider.\n\nRight-click = open the mask editor",
    "蒙版需要有背景图：请先把一张图像输入连进本节点（首张图会作为蒙版背景）":
      "A mask needs a background image: connect an image input to this node first (the first image becomes the mask background).",
    "蒙版背景读取失败：": "Failed to read the mask background: ",
    "蒙版局部重绘已关闭": "Masked inpainting disabled",
    "蒙版局部重绘已开启：只重绘涂抹过的区域": "Masked inpainting enabled: only the painted region is repainted",
    "蒙版尚未创建：请先在节点头部打开蒙版编辑器涂抹要重绘的区域":
      "No mask yet: open the mask editor from the node header and paint the region to repaint.",
    "无效的 quality（须为 low/medium/high/xhigh/max/auto 或空）：":
      "Invalid quality (must be low/medium/high/xhigh/max/auto or empty): ",
    "无效的 background（须为 transparent/opaque/auto 或空）：":
      "Invalid background (must be transparent/opaque/auto or empty): ",
    "背景已设为「透明」：请求带 background=transparent（强制 output_format=png），接口直出带 Alpha 通道的 PNG。提示词末尾已自动追加「背景必须是真透明通道」的要求，差分透明算法按钮已禁用（接口已经给透明了，不必再花 2 倍 Token）。注意这是「重绘去背」，不是精确抠像；要像素级抠图请把背景改回默认再用差分抠图。\n\n":
      "Background is set to “transparent”: the request carries background=transparent (forcing output_format=png) and the API returns an alpha-channel PNG. A “background must be a real transparent channel” requirement is appended to the prompt, and the difference-matting button is disabled (the API already gives transparency; no need to spend 2× tokens). Note this is “repaint and cut out”, not precise matting — for pixel-level cut-outs set Background back to default and use difference matting.\n\n",
    "蒙版局部重绘已开启：请求里带 mask（透明区域 = 允许模型重绘，不透明区域 = 尽量保留原图），只对第 1 张 image 生效；蒙版与原图同尺寸原样下发。提示词末尾已自动追加内置的蒙版要求段（只编辑蒙版透明区域 / 编辑任务 / 必须保持 / 融合要求），节点正文只需写「要改成什么」。\n":
      "Masked inpainting is enabled: the request carries a mask (transparent area = the model may repaint it; opaque area = keep as close to the original as possible), applied to the first image only; the mask is sent at the image’s native size. The built-in mask requirement block (edit only the mask's transparent area / edit task / must stay unchanged / blending) is automatically appended to the prompt, so the node body only needs to say what should change.\n",
    "本次以蒙版为准：画幅锁定已跳过（补边会改写第 1 张参考图，蒙版就与原图错位了）。\n":
      "The mask takes precedence: aspect-ratio lock was skipped (padding rewrites the first reference image and the mask would no longer line up).\n",
    "本次请求的 size 跟着首张参考图的像素尺寸走（节点自己选的尺寸不生效）：服务端按 size 出图，size 一旦与蒙版像素不一致就会先重排输入图，蒙版立刻错位、整张主体被重绘。预览里的 image / mask 就是实际下发的路径本身，没有包装。\n":
      "This request's size follows the first reference image's pixel size (the node's own size setting is ignored): the service renders at size, and any mismatch with the mask's pixels makes it re-lay the input image first, which instantly misaligns the mask and repaints the whole subject. The image / mask entries shown in the preview are the actual paths being sent, unwrapped.\n",
    /* ── 请求预览 · multipart：列的是真正下发的表单字段（不再回显内部 __multipart 伪 JSON）── */
    "Body（multipart/form-data · 下面就是真正下发的表单字段 · boundary 由传输层自动生成）：":
      "Body (multipart/form-data · the fields below are exactly what gets sent · the boundary is generated by the transport layer):",
    "像素": "px",
    /* ── 图像生成 · 画幅锁定（与首参考图保持一致长宽比：补边生图 → 出图裁回）── */
    "与首参考图保持一致长宽比": "Match the first reference's aspect ratio",
    "与首参考图保持一致长宽比 · 补边参数":
      "Match first reference's ratio · padding settings",
    "画幅锁定已关闭": "Aspect lock off",
    "画幅锁定已开启：发图前先补边、出图后按同一矩形裁回，输出长宽比 = 首参考图":
      "Aspect lock on: the reference is padded before the request and the result is cropped back to the same rectangle — output ratio = first reference",
    "启用（补边生图 → 出图裁回，不多花一次出图）":
      "Enable (pad → generate → crop back; no extra generation)",
    "输出还原为参考图的原始像素尺寸（默认保留生图分辨率，只保证长宽比一致）":
      "Resize the output back to the reference's exact pixel size (by default the generation resolution is kept and only the aspect ratio matches)",
    "目标画幅（补边补到哪一档）": "Target canvas (which size to pad into)",
    "自动：挑最贴近参考图比例的档位（补边最少 · 推荐）":
      "Auto: pick the size closest to the reference's ratio (least padding · recommended)",
    "跟随节点「尺寸」所选的长宽比": "Follow the ratio chosen in the node's Size field",
    "补边填充方式": "Padding fill",
    "边缘延展（最外一圈像素拉出去，通用）":
      "Edge extend (stretch the outermost pixel row/column; general purpose)",
    "镜像翻转（纹理 / 渐变更自然）": "Mirror (smoother for textures and gradients)",
    "纯白 #FFFFFF": "Pure white #FFFFFF",
    "纯黑 #000000": "Pure black #000000",
    "自定义颜色": "Custom colour",
    "自定义补边颜色（#RRGGBB）": "Custom padding colour (#RRGGBB)",
    "补边只发生在发给模型的那份副本上：你的参考图文件本身不会被改写。出图后程序按同一矩形裁回，因此四周的补边区不会出现在成果里 —— 提示词照常写「换背景 / 改材质」等内容即可。":
      "Padding only happens on the copy sent to the model — your reference file is never rewritten. The program crops the same rectangle back out of the result, so the fill never shows up in the output. Just write your normal prompt (change the background, repaint a region, …).",
    "补边参考图写入失败": "Failed to write the padded reference image",
    "裁回图像写入失败": "Failed to write the cropped-back image",
    "画幅锁定需要至少一张参考图：本次按原设置生成":
      "Aspect lock needs at least one reference image: generating with the original settings this time",
    "画幅锁定跳过：读不到首参考图（":
      "Aspect lock skipped: cannot read the first reference image (",
    "按参考图比例裁回未完成，已交付整幅原图：":
      "Crop-back to the reference ratio failed; delivering the full image: ",
    "已按首参考图裁回画幅：输出 ": "Cropped back to the first reference's frame: output ",
    "（长宽比 ": " (aspect ratio ",
    "【画幅锁定 · 补边生成】第 1 张参考图已被复制并补边到 {genW}×{genH} 画幅：真实内容只在居中矩形 x={x} y={y} 宽 {w} 高 {h} 之内，四周那一圈是程序补出来的填充区，不属于原图。请把填充区当作可自由延展的缓冲区，用与画面一致的风格、透视与光照自然填满，不要在里面留下边框、色带、渐变条、水印或第二个主体。除填充区外，主体的位置、大小、比例与构图必须与参考图保持一致：不得移动、缩放、裁切或重绘主体。出图后程序会按上面这个矩形自动裁回，最终长宽比为 {refW}:{refH}（与首参考图完全一致），所以主体不得超出或贴住该矩形的边缘。":
      "[Aspect lock · padded generation] Reference image #1 has been copied and padded into a {genW}×{genH} canvas: the real content lies only inside the centred rectangle x={x} y={y} width {w} height {h}; the ring around it is program-made fill, not part of the original. Treat that fill as a free extension buffer — continue the image's own style, perspective and lighting, and leave no border, colour band, gradient strip, watermark or second subject inside it. Apart from the fill, the subject's position, size, scale and composition must match the reference exactly: do not move, scale, crop or repaint it. After generation the program crops back to that rectangle, so the final aspect ratio is {refW}:{refH} — identical to the first reference — and the subject must not cross or touch the rectangle's edge.",
    "与首参考图保持一致长宽比：已开启\n\n开启后每次生成自动做三件事（你照常写提示词即可）：\n① 复制第 1 张参考图，等比缩放居中贴进目标画幅，四周补边（默认边缘延展）；\n② 用补边后的副本发请求，补边圈交给模型自然延展；\n③ 出图后按同一矩形把补边裁掉 —— 输出的长宽比与首参考图完全一致。\n\n适合换背景 / 局部重绘 / 保持原构图：主体不会被拉伸或重新构图。\n⚠ 必须连入至少一张参考图，纯文生图时无效。\n\n单击 = 关闭 · 右键 = 补边参数":
      "Match the first reference's aspect ratio: ON\n\nEvery generation then does three things automatically (just write your prompt as usual):\n① copy reference image #1, scale it to fit, centre it in the target canvas and pad the four sides (edge-extend by default);\n② send the padded copy so the model sees a complete canvas and freely extends the padding;\n③ crop the result back with the same rectangle — the output's aspect ratio matches reference #1 exactly.\n\nMade for background swaps, local repaints and keeping the original framing: the subject is never stretched or recomposed.\n⚠ Requires at least one reference image; useless for pure text-to-image.\n\nClick = off · right-click = padding settings",
    "与首参考图保持一致长宽比：已关闭（单击开启）\n\n开启后：先把第 1 张参考图补边到目标画幅再去生图，出图后再按补边量裁回，输出长宽比 = 首参考图长宽比。\n\n适合换背景等「要和原图对得齐」的活儿。\n⚠ 需要连入参考图；不额外增加出图次数。\n\n右键 = 补边参数":
      "Match the first reference's aspect ratio: OFF (click to turn on)\n\nWhen on: reference image #1 is padded into the target canvas before the request, and the result is cropped back by that same padding — output ratio = the first reference's ratio.\n\nHandy for background swaps and any job that has to line up with the original.\n⚠ Needs a connected reference image; costs no extra generation.\n\nRight-click = padding settings",
    "画幅锁定（与首参考图保持一致长宽比）已开启：首参考图 ":
      "Aspect lock (match the first reference's aspect ratio) is on: the first reference ",
    " 会被复制并补边到 ": " will be copied and padded into a ",
    " 画幅（主体落在居中矩形 ": " canvas (the subject lands inside the centred rectangle ",
    "）后再发请求，出图按该矩形裁回 → 最终长宽比 = 参考图长宽比。下方 image 里列的仍是原始参考图路径，运行时会换成补边副本。\n\n":
      ") before the request goes out, and the result is cropped back to that rectangle → final ratio = the reference's ratio. The image path listed below is still the original file; at run time the padded copy is uploaded instead.\n\n",
    "画幅锁定（与首参考图保持一致长宽比）已开启，但本次没有可补边的首参考图（未连入图像输入）：运行时按原尺寸直接生成，不做补边与裁回。\n\n":
      "Aspect lock (match the first reference's aspect ratio) is on, but there is no first reference to pad this time (no image input connected): the run generates at the original size, with no padding and no crop-back.\n\n",
    "无法读取图像": "Cannot read image",
    "文生图每次只生成 1 张：请改写 prompt 为单张描述；多图请用批量条目 / 多个节点 / attempts×N":
      "Image gen produces 1 image per run: rewrite the prompt for a single image; for many images use batch items / multiple nodes / attempts×N",
    "保存节点不能接智能处理节点（智能节点自己会写文件，其后接 save 会把会话内容落盘）":
      "A save node cannot take input from an Agent node (agent_task, or proc_text with agent on): Agent nodes write files themselves — a downstream save would persist session noise",
    "保存路径后缀与输入类型不符": "Save path extension does not match the input type",
    "无效的图像尺寸（须为可选列表之一）：":
      "Invalid image size (must be one of the allowed list): ",
    " · 可用：": " · available: ",
    "未知绘制类型（可用 text / box / arrow）：":
      "Unknown mark kind (use text / box / arrow): ",
    "绘制类型不可更改：": "Mark kind cannot be changed: ",
    "绘制文本不唯一，请改用 id：": "Mark text is not unique; use id: ",
    "找不到绘制：": "Mark not found: ",
    "重复绘制 alias：": "Duplicate mark alias: ",
    "一次最多创建 40 个绘制，已截断":
      "At most 40 marks per edit; extras truncated",
    "绘制 {n} 个": "Drew {n} mark(s)",
    "所选内容已在该组中": "Selection is already in that group",
    "{n} 个节点": "{n} node(s)",
    "{n} 个绘制": "{n} mark(s)",
    "已将 {parts} 加入组「{title}」": "Added {parts} to group “{title}”",
    "请先框选 / 选中节点或绘制，或选中一个组":
      "Select nodes or marks first, or select a group",
    "已将 {n} 项移出组": "Removed {n} item(s) from group",
    "所选内容分属多个组，请先单独选择同一组内的成员":
      "Selection spans multiple groups; pick members from one group",
    "</b> 个成员（节点 / 绘制）组成一个组（快捷键 G）。组标题仅用于显示；点击组框可整体移动 / 缩放 / 删除。":
      "</b> members (nodes / marks) into a group (shortcut G). Title is display-only; drag the frame to move / scale / delete.",
    "已解散组（节点与绘制保留）": "Group disbanded (nodes & marks kept)",
    "删除该组（连同内部节点与绘制）": "Delete group (and its nodes & marks)",
    "✕ 删除组（连同内部节点与绘制）": "✕ Delete group (with nodes & marks)",
    "解散组（保留节点与绘制）": "Disband group (keep nodes & marks)",
    "组内找不到成员：": "Group member not found: ",
    "已删除组（含 {n} 个节点{marks}）":
      "Deleted group ({n} node(s){marks})",
    "、{m} 个绘制": ", {m} mark(s)",
    " 项绘制": " mark(s)",
    "在资源管理器中打开该文件夹": "Open this folder in Explorer",
    "尚未设置工作目录": "No working directory set",
    "无法打开文件夹": "Cannot open folder",
    "无法打开文件夹：": "Cannot open folder: ",
    "框选模式：开启后左键拖拽框选节点与绘制（也可随时按住 Ctrl+左键 框选）":
      "Box-select mode: drag to select nodes and drawings (or hold Ctrl+left-click anytime)",
    "框选模式已开启：左键拖拽框选节点与绘制":
      "Box-select on: drag to select nodes and drawings",
    "组：把选中的节点或绘制组成一个组（快捷键 G）；选中组后再次点击可加入或解散":
      "Group: make a group from selected nodes/marks (G); with a group selected, click again to add or disband",
    "将选中的节点/绘制加入当前组": "Add selected nodes/marks to the current group",
    "解散当前组（保留内部节点与绘制）":
      "Disband current group (keep nodes & marks inside)",
    "⚠ 批量防 N²：节点「{title}」为逐条批量且接入了多路/整批图像，可能导致约 {n}×{n} 次调用。请改用「拆分」选出单项，或改为单线 1:1 批量链，或对该节点使用聚合(agg)。":
      "⚠ Batch N² guard: node “{title}” is per-item batch but has multiple/full-batch image wires — may cause ~{n}×{n} calls. Use a Split node for one item, a 1:1 batch chain, or batchMode=agg.",
    "⚠ 批量防 N²：节点「{title}」的提示词似乎枚举了整批条目，同时又是 batch 逐条运行——请改为只描述当前项，或用拆分/聚合。":
      "⚠ Batch N² guard: node “{title}” prompt lists many batch titles while still in per-item batch — describe only the current item, or use Split / Aggregate.",
    "▦ 排版": "▦ Layout",
    "一键排版：交由全局助手执行整洁排版（可撤销）":
      "Auto layout by wire flow; optionally include super insides (undoable)",
    "一键排版：按连线关系整理节点位置；停在超级节点里时默认整理当前这一层；可选同时排版超级节点内部（可撤销）":
      "Auto layout by wire flow; inside a super node it tidies the current level by default; optionally include super insides (undoable)",
    "一键排版：交由全局助手执行紧凑排版（可撤销）":
      "Auto layout by wire flow (undoable)",
    "确定进行一键排版？\n\n将由全局助手基于 AI 分析并调整画布节点位置，可能需要等待一段时间，请耐心等候。操作可撤销。":
      "Run auto layout?\n\nNodes will be arranged by wire flow (undoable).",
    "批次拆分已完成。是否进行重新排版？\n\n将按连线关系整理节点位置。":
      "Batch split done. Run auto layout?\n\nNodes will be rearranged by wire flow.",
    "画布上没有节点": "No nodes on the canvas",
    "已整理排版": "Layout tidied",
    "已整理排版（含超级节点内部）": "Layout tidied (including super insides)",
    "排版提示：「{label}」这层仍是长条（宽 {w} × 高 {h}），已尽量收窄；可删减节点或手动微调后再排。":
      "Layout note: level “{label}” is still a long strip ({w} × {h}); it has been narrowed as much as possible — remove nodes or adjust manually and lay out again.",
    "已紧凑排版": "Compact layout applied",
    "排版失败：": "Layout failed: ",
    "隐藏线：临时把所有连线压到 95% 透明（几乎不可见），排版后看清布局；再次点击恢复":
      "Hide wires: fade every wire to 95% transparency (nearly invisible) so the layout reads clearly; click again to restore",
    "查找（Ctrl+F）：全局搜索画布 / 会话 / 专家团 / 素材库 / 工具库 / 技能 / 模板 / 手册文档":
      "Find (Ctrl+F): search across canvases / sessions / teams / assets / tools / skills / templates / manual docs",
    "显示线：恢复所有连线的正常显示":
      "Show wires: restore normal visibility for all wires",
    "已临时隐藏连线（透明度 95%）": "Wires temporarily hidden (95% transparent)",
    "已恢复显示连线": "Wires restored",
    "请整理当前画布排版：先 mtnode_canvas_get 查看每个节点与绘制的 x/y/w/h，再根据现状自行判断，用一次 mtnode_canvas_edit（layout:false）通过 update / updateMarks 校准位置与尺寸。要求美观整洁、间距舒适、图像节点便于观察、面向用户可编辑/操作的节点靠上；框体/文字/箭头等绘制要跟着节点一起调整。不要增删节点、不要改连线，不要调用任何 layout action。完成后用一句话确认。":
      "Tidy the canvas layout: first mtnode_canvas_get to read each node/mark x/y/w/h, then judge yourself and calibrate with one mtnode_canvas_edit (layout:false) via update / updateMarks. Keep it neat with comfortable spacing, image nodes easy to view, user-editable nodes toward the top; move drawings with their nodes. Do not add/remove nodes, change wires, or call any layout action. Confirm in one short sentence when done.",
    "请整理当前画布排版：立刻调用 mtnode_app，action 为 tidy_layout。要求美观整洁、面向用户可编辑/操作的节点靠上；不要增删节点、不要改连线；完成后用一句话确认。":
      "Tidy the canvas layout via mtnode_canvas_edit (not a layout action).",
    "请对当前画布执行紧凑排版：立刻调用 mtnode_app，action 为 compact_layout。不要增删节点、不要改连线；排版完成后用一句话确认。":
      "Tidy the canvas layout via mtnode_canvas_edit (not a layout action).",
    "全局助手正在运行，请稍候或先终止":
      "Global assistant is running; wait or stop it first",
    "助手执行中": "Assistant running",
    "收起为左下角条状按钮": "Collapse to bottom-left bar button",
    "（点击展开 / 收起运行队列）": " (click to expand/collapse run queue)",
    "全局助手": "Global assistant",
    "全局助手执行中": "Global assistant running",
    "点击打开全局助手": "Click to open global assistant",
    "全部终止": "Stop all",
    "一键终止队列中全部运行与等待任务（含全局助手）":
      "Stop all running and queued tasks in one click (including the global assistant)",
    "当前没有运行中的任务": "No tasks are running",
    "已全部终止": "All stopped",
    " 个运行": " running",
    " 个等待": " queued",
    "需要识图时调用 mtnode_vision，imagePath：\n":
      "When you need to read the image, call mtnode_vision with imagePath:\n",
    "\n需要识图时调用 mtnode_vision，imagePath：\n":
      "\nWhen you need to read the image, call mtnode_vision with imagePath:\n",
    "允许识图子代理？": "Allow vision subagent?",
    "智能助手请求调用识图模型查看本地图片（例如游戏 UI / 截图 OCR）。首次需要你的许可。":
      "The agent wants a vision model to inspect a local image (e.g. game UI / screenshot OCR). Permission is required the first time.",
    "图片：": "Image: ",
    "问题：": "Question: ",
    "「始终允许」会记住选择；「允许一次」仅本次会话有效。图片会发给已配置的视觉模型。":
      "“Always allow” is remembered; “Allow once” lasts this session only. The image is sent to a configured vision model.",
    "始终允许": "Always allow",
    "用户拒绝了识图子代理": "User denied the vision subagent",
    "缺少 imagePath": "Missing imagePath",
    "缺少 question": "Missing question",
    "imagePath 必须是本机绝对路径": "imagePath must be an absolute path on this machine",
    "无法检查文件：": "Cannot check file: ",
    "没有可用的视觉模型；请在「模型服务」添加支持识图的文本服务商并勾选「支持视觉」":
      "No vision model available; in “Model services” add a text provider that supports images and enable “Vision”",
    "你是识图子代理。根据用户问题仔细查看图片并作答；只输出与问题相关的观察与结论，不要编造看不到的内容。\n\n问题：":
      "You are a vision subagent. Inspect the image for the user's question; answer with relevant observations only — do not invent what you cannot see.\n\nQuestion: ",
    "识图调用失败": "Vision call failed",
    "等待": "Wait",
    "需求等待": "Wait for file",
    "轮询间隔（秒）": "Poll interval (sec)",
    "监视文件路径：未生成则按间隔轮询，生成后放行下游":
      "Watch a file path: poll until it exists, then unblock downstream",
    "监视文件：未生成则阻塞后续节点，就绪后放行（不输出内容）":
      "Watch file: block until it exists, then unblock (no content output)",
    "停止等待": "Stop waiting",
    "文件已就绪": "File ready",
    "文件已就绪（已放行）": "File ready (unblocked)",
    "尚未检测到文件": "File not detected yet",
    "等待文件生成…": "Waiting for file…",
    "需求文件已生成：": "Required file ready: ",
    "已停止等待": "Stopped waiting",
    "已请求停止等待…": "Stop waiting requested…",
    "相对工作目录或绝对路径（待生成的文件）…":
      "Relative to workspace or absolute path (file to wait for)…",
    "监视路径（绝对路径，或先设工作目录后用相对路径）…":
      "Watch path (absolute, or relative after setting a workspace)…",
    "选择要监视的文件路径": "Choose the file path to watch",
    "选择已有文件路径（只读选取，不会创建、修改或覆盖任何文件）":
      "Pick an existing file path (read-only; never creates, modifies, or overwrites)",
    "在文件夹中显示已就绪文件": "Show ready file in folder",
    "在文件夹中显示监视路径（若文件尚不存在可能无法定位）":
      "Show watch path in folder (may fail if the file does not exist yet)",
    "文件未生成时每隔多少秒检查一次（1–60）":
      "Seconds between checks while the file is missing (1–60)",
    "上游可接智能节点仅作执行顺序；本节点输出为文件路径，供后续节点 @引用或读取。":
      "Upstream agent nodes may wire in for order only; this node outputs the file path for @refs or reading.",
    "控制节点：连到后续节点仅作阻塞；本节点不输出内容。下游请自行读取约定路径的文件。":
      "Control node: wire to later nodes only to block; no content output. Downstream nodes should read the agreed file path themselves.",
    "本节点无输入端子：仅监视文件，用输出端连到下游以防提前运行；不输出内容，下游自行读约定路径。":
      "No input ports: only watches a file and wires out to block early runs; no content output — downstream reads the agreed path.",
    "⏳ 需求等待（监视文件生成）": "⏳ Wait for file (watch until generated)",
    "⏳ 需求等待（监视文件 · 仅阻塞）": "⏳ Wait for file (watch · block only)",
    "⏳ 需求等待（监视文件 · 无输入 · 仅阻塞）":
      "⏳ Wait for file (watch · no input · block only)",
    "控制节点（批量清空 / 执行）": "Control (batch clear / run)",
    "控制节点（清空 / 执行 / 需求等待）": "Control (clear / run / wait for file)",
    "检查中：": "Checking: ",
    "等待中（第 ": "Waiting (check #",
    " 次）· 每 ": ") · every ",
    " 秒检查 · ": "s · ",
    "监视该文件：未生成时阻塞输出；已生成则输出路径文本供下游 @引用。勿把智能节点会话当作下游输入，改用文件交接。":
      "Watch this file: block until it exists; then output the path for @refs. Do not pipe agent session text as I/O — hand off via files.",
    "监视该文件：未生成时阻塞后续节点；就绪后放行，本节点不输出任何内容。勿把智能节点会话当作下游输入，改用文件交接。":
      "Watch this file: block later nodes until it exists; then unblock with no content output. Do not pipe agent session text as I/O — hand off via files.",
    "监视该文件：未生成时阻塞后续节点；就绪后放行。本节点无输入、不输出内容，仅用输出端连到下游以防提前运行。":
      "Watch this file: block later nodes until it exists; then unblock. No inputs and no content output — wire out only to prevent early runs.",
    "补": "Fill",
    "补缺": "Fill gaps",
    "补缺：开 · 仅执行尚无输出的节点（再点关闭）":
      "Fill gaps: ON · only run nodes with no output (click again to turn off)",
    "补缺：关 · 点击开启后仅执行尚无输出的节点，避免重复跑已有结果":
      "Fill gaps: OFF · click to run only nodes with no output, skip ones that already have results",
    "运行：仅补跑尚无输出的已连接节点":
      "Run: only fill connected nodes that have no output yet",
    "补缺模式：点击 ▶ 只跑尚无输出的已连接节点，已有结果的跳过":
      "Fill-gap mode: ▶ runs only connected nodes without output; skips ones with results",
    "补缺：已连接节点均已有输出，无需执行":
      "Fill gaps: all connected nodes already have output — nothing to run",
    "补缺完成：执行 ": "Fill gaps done: ran ",
    " 个 · 跳过 ": " · skipped ",
    " 个已有输出": " with existing output",
    "来自": "From",
    "连向": "To",
    "点击定位到该节点": "Click to focus this node",
    "项目目录: ": "Project folder: ",
    "工作目录最外层文件夹: ": "Project folder: ",
    "配置数据目录": "Config data directory",
    "存放 config.json（API Key 等）、画布存档与本地资产。更改后需重启应用生效。":
      "Stores config.json (API keys, etc.), canvas archives, and local assets. Restart required after changing.",
    "当前路径：": "Current path: ",
    "更改目录…": "Change folder…",
    "选择新的配置数据目录；改完需重启应用生效":
      "Choose a new config data folder; a restart is needed for it to take effect",
    "恢复默认": "Reset to default",
    "清除自定义路径，回到应用默认数据目录":
      "Clear custom path and return to the app default data directory",
    "打开目录": "Open folder",
    "在资源管理器中打开当前配置数据目录":
      "Open the current config data folder in the file manager",
    "错误与崩溃日志": "Error & crash logs",
    "应用内部错误与崩溃会自动写入本地诊断日志（不含 API Key）。导出后可发给开发者协助排查。":
      "Internal errors and crashes are saved to local diagnostic logs (API keys excluded). Export and send them to the developer for troubleshooting.",
    "正在读取日志状态…": "Reading log status…",
    "导出诊断日志…": "Export diagnostic log…",
    "打包环境信息与近期错误日志为 .txt，便于提交":
      "Bundle environment info and recent error logs into a .txt file for submission",
    "打开日志文件夹": "Open logs folder",
    "在资源管理器中打开自动保存的日志目录":
      "Open the auto-saved logs folder in the file manager",
    "日志目录：": "Logs folder: ",
    "error.log：": "error.log: ",
    "尚无 error.log": "No error.log yet",
    "最近崩溃报告：": "Latest crash report: ",
    "尚无崩溃报告": "No crash reports yet",
    "已保存报告数：": "Saved reports: ",
    "诊断日志已导出，请将该文件发送给开发者":
      "Diagnostic log exported — please send this file to the developer",
    "诊断日志已自动保存：": "Diagnostic log auto-saved:\n",
    "应用内部出现错误。可将诊断日志提交给开发者以便排查。":
      "An internal error occurred. You can submit the diagnostic log to the developer.",
    "渲染进程异常退出：": "Renderer process exited abnormally: ",
    "导出诊断日志": "Export diagnostic log",
    "当前由环境变量 MTNODE_DATA_DIR 指定数据目录，无法在设置中更改":
      "Data directory is set by MTNODE_DATA_DIR; cannot change it in Settings",
    "正在重启应用…": "Restarting app…",
    "重启失败：": "Restart failed: ",
    "更改配置数据目录后需要重启应用才能生效。是否继续选择新目录？":
      "Changing the config data directory requires a restart. Continue and choose a new folder?",
    "选择配置数据目录": "Choose config data directory",
    "是否将现有配置（API Key、画布等）复制到新目录？":
      "Copy existing config (API keys, canvases, etc.) to the new folder?",
    "若新目录已有 config.json，则不会覆盖。":
      "If the new folder already has config.json, it will not be overwritten.",
    "更改失败：": "Change failed: ",
    "目录未变化": "Directory unchanged",
    "配置数据目录已更新。需要立即重启应用才能生效，是否现在重启？":
      "Config data directory updated. Restart now for it to take effect?",
    "已保存新路径，请手动重启应用后生效":
      "New path saved; restart the app manually for it to take effect",
    "恢复默认配置数据目录后需要重启应用才能生效。是否继续？":
      "Resetting to the default config data directory requires a restart. Continue?",
    "已恢复默认目录。需要立即重启应用才能生效，是否现在重启？":
      "Default directory restored. Restart now for it to take effect?",
    "已恢复默认路径，请手动重启应用后生效":
      "Default path restored; restart the app manually for it to take effect",
    "无法打开目录：": "Cannot open folder: ",
    "画布备份": "Canvas backup",
    "每 5 分钟自动把各工作流的最新状态另存一份快照，放在与自动保存分开的 save-backups 文件夹（内容无变化不重复存），每条工作流保留最近 72 份；误删或改坏时可从备份文件夹找回。":
      "Every 5 minutes each workflow is snapshotted into the save-backups folder, separate from auto-save (unchanged content is skipped). The latest 72 copies per workflow are kept; restore manually from there after an accidental delete or bad edit.",
    "正在读取备份状态…": "Reading backup status…",
    "打开备份文件夹": "Open backup folder",
    "在资源管理器中打开工作流备份目录":
      "Open the workflow backup folder in the file manager",
    "无法读取：": "Cannot read: ",
    "份": " copies",
    "最近更新：": "Latest: ",
    "请选择绝对路径": "Choose an absolute path",
    "目录不可写": "Directory is not writable",
    "复制现有配置失败：": "Failed to copy existing config: ",
    "验证": "Verify",
    "验证中…": "Verifying…",
    "向服务商发起无 Token 消耗的校验请求":
      "Send a token-free validation request to the provider",
    "API Key 验证成功（无 Token 消耗）":
      "API Key verified (no token usage)",
    "API Key 验证失败": "API Key validation failed",
    "助手改画布（全局助手 / 智能会话）":
      "Canvas edits (global assistant / agent session)",
    "已开启：助手改画布不再弹确认":
      "On: assistant canvas edits skip confirm",
    "已关闭：助手改画布需确认": "Off: assistant canvas edits need confirm",
    "智能会话请求修改当前画布：": "Agent session requests canvas changes: ",
    "智能会话请求：": "Agent session requests: ",
    "拒绝后本次修改不会生效，并立即停止智能会话继续工作。":
      "If rejected, this edit will not apply and the agent session will stop immediately.",
    "已拒绝画布修改，智能会话已停止":
      "Canvas edit rejected; agent session stopped",
    "设置项目目的地文件夹": "Set project destination folder",
    "拆分批次": "Split batch",
    "拆": "S",
    "拆分": "Split",
    "将批次拆成单一节点，并级联拆分下游（聚合节点改为接入全部）":
      "Split the batch into single nodes and cascade-split downstream (aggregate nodes receive all)",
    "该节点不是可拆分的批次（至少 2 条）":
      "This node is not a splittable batch (need at least 2 items)",
    "将批次拆分为 ": "Split batch into ",
    " 个单一节点": " single nodes",
    "，并级联拆分下游 ": ", and cascade-split ",
    "；": "; ",
    " 个聚合节点将接入全部新节点": " aggregate node(s) will connect to all new nodes",
    "。原批次节点会被移除。是否继续？":
      ". The original batch node will be removed. Continue?",
    "已拆分批次：": "Batch split: ",
    " · 下游 ": " · downstream ",
    "批次拆分已完成。是否进行 AI 重新排版？\n\n将由全局助手分析并调整节点位置，可能需要等待一段时间。":
      "Batch split done. Run AI re-layout?\n\nThe global assistant will analyze and adjust node positions; this may take a while.",
    "节点操作": "Node actions",
    "关闭（Esc）": "Close (Esc)",
    /* ── 全局搜索浮层（Ctrl+F · renderer/app-search.js） ── */
    "搜索画布、会话、专家团、素材、工具、技能与文档…":
      "Search canvases, sessions, expert team, assets, tools, skills, and docs…",
    "全局搜索": "Global search",
    "至少输入 2 个字符开始搜索": "Type at least 2 characters to search",
    "没有匹配的内容": "No matches",
    "正在搜索…": "Searching…",
    "正在搜索文件内容…": "Searching file contents…",
    "显示更多": "Show more",
    "点开结果后自动关闭": "the panel closes after you open a result",
    "↑↓ 选择 · Enter 打开 · Esc 关闭": "↑↓ select · Enter open · Esc close",
    /* ─ 输入框内查找条（Ctrl+F 焦点在输入框里 · renderer/app-find.js） ── */
    "在本输入框内查找": "Find in this field",
    "查找（Ctrl+F）：焦点在输入框里时，在框内高亮并定位文字":
      "Find (Ctrl+F): with focus inside an input, highlight and jump to text within that field",
    "上一个命中": "Previous match",
    "下一个命中": "Next match",
    "上一个（Shift+Enter / ↑）": "Previous (Shift+Enter / ↑)",
    "下一个（Enter / ↓）": "Next (Enter / ↓)",
    "关闭查找框": "Close the find bar",
    "无匹配": "No match",
    "Enter 下一个 · Shift+Enter 上一个 · Esc 关闭":
      "Enter next · Shift+Enter previous · Esc close",
    "画布（跨画布）": "Canvases (all canvases)",
    "会话记录": "Sessions",
    "素材库与本机文件": "Asset library & local files",
    "模板商店": "Template store",
    "手册文档": "Manual & docs",
    "画布名": "Canvas name",
    "标注 / 便签": "Drawings / notes",
    "节点指南": "Node guide",
    "运行结果": "Run output",
    "步骤": "Steps",
    "批次条目": "Batch items",
    "系统提示": "System prompt",
    "监视路径": "Watch path",
    "程序路径": "Program path",
    "函数 JS": "Function JS",
    "（未命名节点）": "(untitled node)",
    "素材条目": "Asset item",
    "本机文件": "Local file",
    "文件正文": "File contents",
    "会话标题": "Session title",
    "专家": "Expert",
    "专家会话": "Expert chat",
    "群聊发言": "Group message",
    "定位失败：": "Could not jump to the target: ",
    "找不到该技能正文": "Skill body not found",
    "模板商店当前离线，未参与搜索": "The template store is offline and was skipped",
    "智能节点不能读取或编辑画布、修改节点图或创建任务。请使用读写文件、联网、命令、技能与识图完成任务。":
      "Agent nodes cannot read or edit the canvas, change the node graph, or create tasks. Use file read/write, network, commands, skills, and vision instead.",
    "本次运行为智能节点：即使审批预设允许，也不可使用读取画布、节点与连线、控制类节点、绘图、排版与成组、应用操作、删除画布。":
      "This run is an agent node: even if the Approvals preset allows them, canvas read/edit, nodes and wires, control nodes, drawings, layout/groups, app operations, and deleting canvases are unavailable.",
    "工作范围": "Work scope",
    "限制助手可访问的画布范围": "Limit which canvases the assistant may access",
    "全局": "Global",
    "仅当前画布": "Current canvas only",
    "仅操作当前画布；改节点图或删除本画布会弹窗确认":
      "Current canvas only; graph edits or deleting this canvas ask for confirm",
    "该操作允许助手参考其他画布内容，当画布较多时可能导致速度较慢。确定切换为「全局」？":
      "This allows the assistant to reference other canvases; many canvases may slow it down. Switch to Global?",
    "助手的工作范围是「仅当前画布」：本轮只能操作它绑定的那张画布，无法访问其他画布。请将工作范围改为「全局」后再试。":
      "Assistant scope is Current canvas: this turn may only touch the canvas it is bound to. Switch scope to Global and try again.",
    "本会话只能访问它所属的画布，无法读取或操作其他画布。":
      "This session can only access the canvas it belongs to; other canvases are blocked.",
    "工作范围=本会话所属画布：不得读取或操作其他画布内容。":
      "Work scope = the canvas this session belongs to: do not read or modify other canvases.",
    /* ── 局部画布（scope）：只看 / 只改某一颗超级 · 开发节点内部 ── */
    "无效的 scope（要给超级 / 开发节点的 id 或唯一标题）：":
      "Invalid scope (pass a super / dev node id or unique title): ",
    "scope 界外已跳过：": "Skipped (outside scope): ",
    "（本次只改 ": " (this call only touches ",
    "）": ")",
    "本次编辑被限定在这一颗壳内部：界外节点未改动。":
      "This edit was confined to one shell: nodes outside it were left untouched.",
    "当前可见 = 用户正停在的这颗壳内部。":
      "Visible content = the inside of the shell the user is currently in.",
    "范围 = 这一颗壳内部：界外节点未返回。":
      "Scope = the inside of this one shell: nodes outside it are not returned.",
    "用户当前正停在这颗壳里：{title}（id {id}）。只看 / 只改它内部请传 scope 用这颗壳的标题或 id，配 scopeDepth 决定一层还是整棵 —— 避免整图灌进来浪费 token。":
      "The user is currently inside this shell: {title} (id {id}). To read or edit only its inside, pass scope with this shell's title or id, plus scopeDepth to choose one level or the whole subtree — this avoids pouring the whole graph into context.",
    "当前工作范围是本画布。我能查看并修改当前画布节点与配置。\n可以说「总结画布」或「搭一个 xxx 工作流」。\n改节点图前会请你确认；要参考其他画布请把工作范围改为「全局」。":
      "Scope is this canvas. I can view/edit the current canvas nodes and settings.\nTry \"summarize the canvas\" or \"build a xxx workflow\".\nGraph edits ask for confirm; switch work scope to Global to reference other canvases.",
    "跟随当前画布工作目录": "Follows this canvas working directory",
    "跟随当前画布工作目录（只读）": "Follows this canvas working directory (read-only)",
    "运行中已锁定工作目录，切换画布也不会更改":
      "Working directory is locked for this run; switching canvases will not change it",
    /* ── 工作区真源（运行与显示同一口径）：手填 > 画布项目根 > 画布目录 / 默认 ── */
    "手填指定": "set by hand",
    "画布项目根（开发节点 devPath）": "canvas project root (dev node devPath)",
    "应用默认目录": "app default directory",
    "未指定": "not set",
    "本画布有多个项目根，已用第一个；要换另一个请在顶层功能块设置 devPath，或直接手填工作目录。":
      "This canvas declares several project roots — using the first one. To pick another, set devPath on the top-level module block or type a working directory by hand.",
    "本画布有开发节点但尚未设置项目根：在顶层功能块设 devPath 后，工作目录会优先用它。":
      "This canvas has dev nodes but no project root yet: set devPath on the top-level module block and the working directory will prefer it.",
    "跟随当前画布：项目根优先，其次画布工作目录":
      "Follows this canvas: project root first, then the canvas working directory",
    "跟随当前画布（项目根优先，只读）":
      "Follows this canvas (project root first, read-only)",
    "留空 = 画布项目根 / 画布工作目录…":
      "Leave empty = canvas project root / canvas working directory…",
    "助手可读写此目录下的文件；留空则用画布项目根 / 画布工作目录":
      "The assistant reads/writes files in this directory; leave empty to use the canvas project root / canvas working directory",
    "生效工作目录：": "Effective working directory: ",
    "来源：本轮开轮时锁定": "Source: locked at the start of this run",
    "点击可改选其它目录（手填优先于画布项目根）":
      "Click to choose another directory (a manual pick outranks the canvas project root)",
    "选择工作区": "Choose a workspace",
    "项目根已并入工作区":
      "Project root merged into the workspace — the agent writes files there",
    "画布上有多个项目根：本轮使用「{p}」，可在上方工作目录里指定其它项目根":
      "This canvas declares several project roots; this run uses “{p}”. Pick another one in the working-directory field above.",
    "我能看到当前画布、节点与配置，也可参考其他画布列表。\n可以说「总结画布」或「搭一个 xxx 工作流」。\n改节点图或删除画布前会请你确认。":
      "I can see the canvas, nodes, and settings, and can list other canvases.\nTry \"summarize the canvas\" or \"build a xxx workflow\".\nGraph edits or deleting a canvas will ask for confirmation.",
    "第{n}张参考图": "reference image {n}",
    "内置": "Built-in",
    "内置技能": "Built-in skill",
    "不可卸载": "Locked",
    "内置技能不可卸载": "Built-in skills cannot be uninstalled",
    "内置技能名不可占用": "Built-in skill names are reserved",
    "输入 / 或 、 呼出技能；会话内还可 /compact 压缩上文、/plan 规划模式。":
      "Type / or 、 for skills; in sessions also /compact and /plan.",
    "。输入 / 或 、 呼出技能列表": ". Type / or 、 to open the skill list",
    "可选组件按需下载，不随主程序安装包分发。":
      "Optional components are downloaded on demand and are not bundled in the installer.",
    "桌宠（Live2D）": "Desktop Pet (Live2D)",
    "BongoChat": "BongoChat",
    "可以聊天的BongoCat！": "BongoCat that can chat!",
    "透明置顶桌宠窗口。默认安装包不包含；下载后可运行与卸载。后续版本支持自定义形象与角色 AI 对话。":
      "Transparent always-on-top pet window. Not included in the default installer; download to run or uninstall. Custom skins and character AI chat come in later versions.",
    "独立桌宠应用：读取 MTNode 配置，随主程序退出而关闭。键鼠联动、窗口穿透、托盘菜单、自定义形象。默认安装包不包含本组件。":
      "Standalone desktop pet: reads MTNode config, quits with the main app. Key/mouse sync, click-through, tray menu, custom skins. Not in the default installer.",
    "未安装": "Not installed",
    "运行中": "Running",
    "下载安装": "Download & install",
    "运行": "Run",
    "停止": "Stop",
    "准备下载…": "Preparing download…",
    "读取清单…": "Reading manifest…",
    "下载中…": "Downloading…",
    "解压安装中…": "Extracting…",
    "完成": "Done",
    "失败：": "Failed: ",
    "桌宠已安装": "Desktop pet installed",
    "（本地包）": " (local pack)",
    "桌宠安装失败：": "Desktop pet install failed: ",
    "启动桌宠失败：": "Failed to start desktop pet: ",
    "卸载桌宠？将删除已下载的运行时文件。":
      "Uninstall the desktop pet? This deletes the downloaded runtime files.",
    "桌宠已卸载": "Desktop pet uninstalled",
    "DSH 插件（扩展 agent 能力；安装后自动重启引擎）":
      "DSH plugins (extend agent capability; engine restarts after install)",
    "DSH 插件（扩展 agent 能力；安装到配置目录，升级后保留；安装后自动重启引擎）":
      "DSH plugins (extend agent capability; installed in the config directory and kept across updates; engine restarts after install)",
    "列出 / 安装 / 移除 / 挂载 DSH 插件":
      "List / install / remove / mount DSH plugins",
    "配置目录": "Config folder",
    "应用内置": "Built-in",
    "DSH 插件接口不可用": "DSH plugin API unavailable",
    "缺少插件名 pkg": "Missing plugin name (pkg)",
    "安装 DSH 插件": "Install DSH plugin",
    "移除 DSH 插件": "Remove DSH plugin",
    "挂载 DSH 插件": "Mount DSH plugin",
    "取消挂载 DSH 插件": "Unmount DSH plugin",
    "将下载并安装到配置目录（应用升级后保留），安装后智能引擎会重启。":
      "Will download into the config directory (kept across app updates); the agent engine restarts after install.",
    "将从配置目录卸载该插件，引擎会重启。":
      "Will uninstall from the config directory; the engine will restart.",
    "更改插件挂载状态后引擎会重启。":
      "Changing mount state restarts the engine.",
    "＋ 安装 DSH 插件": "+ Install DSH plugin",
    "已安装 DSH 插件（点击展开查看 / 管理）":
      "Installed DSH plugins (click to expand / manage)",
    "筛选 DSH 插件（按包名 / 行 id）…":
      "Filter DSH plugins (by package name / row id)…",
    "筛选 DSH 插件（按包名 / 行 id / 描述）…":
      "Filter DSH plugins (by package, row id, or description)…",
    "描述": "Description",
    "用途": "Purpose",
    "选择左侧插件查看说明": "Select a plugin on the left to see its description",
    "暂无描述": "No description",
    "配置片段": "Config snippet",
    "未挂载": "Unmounted",
    "已挂载": "Mounted",
    "管理已装插件…": "Manage installed plugins…",
    "管理 DSH 插件": "Manage DSH plugins",
    "已安装 {n} 个插件（已挂载 {m}）": "Installed {n} plugins ({m} mounted)",
    "用于扩展 Agent 运行时能力（{id}）。":
      "Extends the agent runtime ({id}).",
    "安装中（需要联网，可能需要几分钟）…":
      "Installing (needs network; may take a few minutes)…",
    "DSH 插件列表不可用（": "DSH plugin list unavailable (",
    "无匹配 DSH 插件": "No matching DSH plugins",
    "暂无 DSH 插件（在上方输入 npm 包名安装）":
      "No DSH plugins yet (enter an npm package name above to install)",
    "npm 包名或 GitHub 地址，例如 @scope/pkg":
      "npm package or GitHub URL, e.g. @scope/pkg",
    "核心": "Core",
    "挂载": "Mount",
    "取消挂载": "Unmount",
    "已挂载 ": "Mounted ",
    "已取消挂载 ": "Unmounted ",
    "移除 DSH 插件 ": "Remove DSH plugin ",
    "DSH 插件已安装：": "DSH plugin installed: ",
    /* ── 扩展能力整合界面（设置 · 扩展能力 + 统一管理对话框）── */
    "扩展能力（DSH 插件 · 技能 Skills · MCP 服务器）":
      "Extensions (DSH plugins · Skills · MCP servers)",
    "管理…": "Manage…",
    "扩展能力管理": "Manage extensions",
    "技能 Skills": "Skills",
    "筛选技能（按技能名 / 描述）…":
      "Filter skills (by name / description)…",
    "筛选 MCP 服务器（按名称 / 命令 / URL）…":
      "Filter MCP servers (by name / command / URL)…",
    "本机": "Local",
    "来自工坊": "From workshop",
    "本地创建": "Created locally",
    "技能内容 SKILL.md": "SKILL.md",
    "附带文件": "Bundled files",
    "查看": "View",
    "编辑技能": "Edit skill",
    "创建技能": "Create skill",
    /* 技能正文：添加 / 编辑技能一律走内置 Markdown 阅读 / 编辑器（app-plugins.js） */
    "阅读": "Read",
    "新技能": "New skill",
    "Markdown 编辑器": "Markdown Editor",
    "✎ 用内置 Markdown 编辑器": "✎ Use the built-in Markdown editor",
    "点击用内置 Markdown 编辑器打开":
      "Click to open in the built-in Markdown editor",
    "已写 {n} 字符 · 点击用内置 Markdown 编辑器查看 / 修改":
      "{n} characters written · click to view / edit in the built-in Markdown editor",
    "还没有正文 · 点击用内置 Markdown 编辑器编写":
      "No body yet · click to write it in the built-in Markdown editor",
    "内置 Markdown 编辑器不可用": "Built-in Markdown editor unavailable",
    "技能正文 SKILL.md · 内置 Markdown 编辑器":
      "Skill body SKILL.md · built-in Markdown editor",
    " · 只读": " · read-only",
    "技能名": "Skill name",
    "传输方式": "Transport",
    "命令": "Command",
    "命令 / 参数": "Command / args",
    "添加 MCP 服务器": "Add MCP server",
    "（已挂载 ": " (mounted ",
    "（部分列表不可用：": " (some lists unavailable: ",
    "内置技能只读，不可修改": "Built-in skills are read-only",
    "选择左侧条目查看说明与管理操作":
      "Select an item on the left to view details and manage it",
    "无匹配 ": "No match for ",
    "暂无 DSH 插件（点上方「＋ 安装插件」）":
      "No DSH plugins yet (click “+ Install plugin” above)",
    "暂无技能（点上方「＋ 创建技能」）":
      "No skills yet (click “+ Create skill” above)",
    "暂无 MCP 服务器（点上方「＋ 添加服务器」）":
      "No MCP servers yet (click “+ Add server” above)",
    "DSH 插件 ": "DSH plugins ",
    "技能 ": "Skills ",
    "MCP ": "MCP ",
    "）· 重新打开设置重试": ") · reopen settings to retry",
    '<div class="dsh-plugin-empty">DSH 插件列表不可用（':
      '<div class="dsh-plugin-empty">DSH plugin list unavailable (',
    "透明置顶桌宠：键鼠联动、窗口穿透、托盘菜单、自定义形象导入。默认安装包不包含本组件。":
      "Transparent always-on-top pet: keyboard/mouse sync, click-through, tray menu, custom skin import. Not bundled in the default installer.",
    "窗口穿透": "Click-through",
    "始终置顶": "Always on top",
    "镜像": "Mirror",
    "悬停隐藏": "Hide on hover",
    "缩放": "Scale",
    "透明度": "Opacity",
    "形象": "Skin",
    "导入形象…": "Import skin…",
    "已导入形象：": "Imported skin: ",
    "全局键鼠钩子未就绪（仍可使用窗口与形象功能）":
      "Global input hook unavailable (window and skins still work)",
    "更新运行时": "Update runtime",
    "任务节点": "Task Node",
    "任务": "Task",
    "任务节点（规划 / 控制流执行）": "Task Node (plan / run control flow)",
    "超级节点": "Super node",
    "超级节点（收纳 · 展开子画布）": "Super node (pack · expand sub-canvas)",
    "说明：此超级节点收纳的内容与用途…":
      "Describe what this super node packs and why…",
    "展开": "Expand",
    "收起": "Collapse",
    "进入内部画布": "Enter inner canvas",
    "展开后可将节点移入；或进入内部画布编辑":
      "After expand, move nodes in — or enter the inner canvas to edit",
    "将节点拖入此处": "Drag nodes here",
    "拖入节点以收纳；拖出以移出":
      "Drag nodes in to pack; drag out to unpack",
    "超级节点子文件夹": "Super node subfolder",
    "超级节点描述": "Super node description",
    "编辑超级节点描述": "Edit super node description",
    "描述内容": "Description",
    "描述此超级节点收纳的内容与用途…": "Describe what this super node packs…",
    "描述会以小字显示在超级节点「文件夹」标题下方；文字过多时自动截断，鼠标悬停可查看全文。留空则不显示。":
      "The description shows as small text under the folder title; long text is truncated and revealed on hover. Leave empty to hide.",
    "填写描述：以小字显示在文件夹标题下方":
      "Add a description: shown as small text under the folder title",
    "当前描述：": "Current description: ",
    "点击编辑": "Click to edit",
    "描述已更新": "Description updated",
    "已清除描述": "Description cleared",
    "收纳的节点数 · 子文件夹": "Packed node count · subfolder",
    "设置后，此超级节点内部节点的默认相对路径会落在「工作目录 / 子文件夹」下。已有路径不会自动改写。":
      "After setting, default relative paths for inner nodes go under workspace/subfolder. Existing paths are not rewritten.",
    "设置后，此超级节点内部节点的相对路径会落在「工作目录 / 子文件夹」下；内部已有相对路径会自动补上该前缀。":
      "Once set, relative paths inside this super resolve under workspace / subfolder; existing relative paths get that prefix automatically.",
    "子文件夹（相对工作目录）": "Subfolder (relative to workspace)",
    "子文件夹已设为：": "Subfolder set to: ",
    "已清除子文件夹": "Subfolder cleared",
    "子文件夹：": "Subfolder: ",
    "设置子文件夹（内部节点默认相对路径）":
      "Set subfolder (default relative paths for inner nodes)",
    "设置子文件夹…": "Set subfolder…",
    "收起内部画布": "Collapse inner canvas",
    "展开内部画布": "Expand inner canvas",
    "左上角展开 · 拖入节点收纳": "Expand at top-left · drag nodes in to pack",
    "中键或空白处拖动以平移内部画布":
      "Middle-drag or drag empty area to pan the inner canvas",
    "（拖到内部节点）": " (drag to inner nodes)",
    "（从内部节点拖入）": " (drag from inner nodes)",
    "已展开超级节点：": "Expanded super node: ",
    "已进入超级节点：": "Entered super node: ",
    "进入超级节点：": "Enter super node: ",
    "进入超级节点：在完整画布中编辑内部节点":
      "Enter super node: edit its children on the full canvas",
    "展开超级节点：": "Expand super node: ",
    "展开 / 进入内部画布": "Expand / enter inner canvas",
    "将选中节点移入此超级节点": "Move selection into this super node",
    "移出超级节点": "Move out of super node",
    "已移入 ": "Moved in ",
    "已移出 ": "Moved out ",
    " 节点": " nodes",
    "空": "Empty",
    "内部收纳的节点数量（不含端口）": "Inner node count (ports excluded)",
    "输入端": "Input",
    "输出端": "Output",
    "输出": "Out",
    "把内部节点连到此端口 → 外部输出":
      "Wire inner nodes here → external output",
    "外部输入经此端口 → 内部节点":
      "External input passes here → inner nodes",
    "创建超级节点、将节点收纳进子画布（建议审批）":
      "Create super nodes / pack nodes into a sub-canvas (approve recommended)",
    "☑ 任务（规划步骤 · 可进入分段解决）": "☑ Task (plan steps · enter to solve in parts)",
    "任务目标 / 本步要解决什么": "Goal / what this step should solve",
    "暂无步骤 · 先拆解再执行或进入内部实现": "No steps yet · split first, then run or enter to implement",
    "＋ 步骤": "+ Step",
    "展开到内部": "Expand inside",
    "把步骤变成内部子任务节点，进入后可分段解决": "Turn steps into inner task nodes; enter to solve them one by one",
    "展开为同层链": "Expand as sibling chain",
    "把步骤变成同层兄弟任务并按序连线，▶ 可链式执行": "Turn steps into same-scope sibling tasks wired in order; ▶ runs the chain",
    "助手拆解": "Assist split",
    "让全局助手根据目标自动拆成任务计划": "Ask the global assistant to split the goal into a task plan",
    "已展开为同层任务链 ": "Expanded sibling task chain: ",
    " 步，可 ▶ 按连线顺序执行": " steps; ▶ runs them in wire order",
    "步骤已对应同层任务": "Steps already have sibling tasks",
    "已展开 ": "Expanded ",
    " 个子任务，点击 ↪ 进入": " sub-tasks, click ↪ to enter",
    "步骤已对应内部子任务": "Steps already have inner sub-tasks",
    "先添加步骤再展开": "Add steps before expanding",
    "进入任务：在内部画布分段编排实现": "Enter task: implement this step on its inner canvas",
    "按序执行：先跑内部子任务，再跑内部处理节点": "Run in order: inner sub-tasks first, then inner process nodes",
    "按序执行：内部子任务/处理节点；同层有连线时继续跑后续任务": "Run in order: inner work first; then continue along same-scope wired tasks",
    "已进入任务：": "Entered task: ",
    "返回顶层画布": "Back to top-level canvas",
    "返回上一层": "Back one level",
    "← 返回": "← Back",
    "进入任务：": "Enter task: ",
    "当前任务内部暂无节点": "No nodes inside this task yet",
    "当前任务内部暂无节点或绘图": "No nodes or drawings inside this task yet",
    "暂无节点或绘图": "No nodes or drawings yet",
    "没有匹配「{q}」的节点或绘图": "No nodes or drawings matching \"{q}\"",
    "筛选节点或绘图…": "Filter nodes or drawings…",
    "筛选节点、绘图或超级节点…": "Filter nodes, drawings, or super nodes…",
    "节点与绘图列表边栏": "Node and drawing list sidebar",
    "当前画布": "Current canvas",
    "展开当前画布列表": "Expand current canvas list",
    "折叠当前画布列表": "Collapse current canvas list",
    "展开超级节点树": "Expand super node tree",
    "折叠超级节点树": "Collapse super node tree",
    "进入超级节点画布并定位：": "Enter super canvas and locate: ",
    "内部节点数：": "Inner nodes: ",
    "当前超级节点内部暂无节点或绘图": "No nodes or drawings inside this super node yet",
    "超节点": "Super",
    "可从右键菜单添加，或返回上层": "Add via right-click, or go back up",
    "任务状态": "Task status",
    "待办": "Pending",
    "进行中": "In progress",
    "需干涉": "Needs attention",
    "＋ 任务": "+ Task",
    "在内部新增一个子任务（含起点与终点）": "Add an inner sub-task (with start and end)",
    "暂无子任务 · 添加任务或进入内部编排": "No sub-tasks yet · add a task or enter to build the graph",
    "任务目标 / 本任务要解决什么": "Goal / what this task should solve",
    "已添加子任务：": "Added sub-task: ",
    "起点": "Start",
    "成功终点": "Success end",
    "失败终点": "Fail end",
    "固定节点，无法删除": "Pinned node, cannot delete",
    "终点：控制流到达此处决定任务状态": "End: reaching here decides the task status",
    "任务 ▶ 时从此点燃，控制沿连线向后传递": "Task ▶ fires here; control flows downstream",
    "控制流到达此处 → 任务成功": "Control reaching here → task succeeds",
    "控制流到达此处 → 任务失败": "Control reaching here → task fails",
    "额外终点，可删除": "Extra end, can be deleted",
    "起点 / 终点为固定节点，无法删除": "Start / end are pinned and cannot be deleted",
    "已跳过固定的起点 / 终点": "Skipped pinned start / end",
    "起点 / 终点为固定节点，无法复制": "Pinned start / end cannot be duplicated",
    "判断": "Judge",
    "判断节点": "Judge Node",
    "判断（是 / 否）": "Judge (yes / no)",
    "判断标准（可选，默认用所属任务的目标）": "Criteria (optional; defaults to the parent task goal)",
    "判断中…": "Judging…",
    "裁决：是（达成）": "Verdict: yes (met)",
    "裁决：否（未达成）": "Verdict: no (not met)",
    "等待裁决 · 右上 是 / 下 否": "Awaiting verdict · top-right YES / lower NO",
    "是（达成）": "Yes (met)",
    "否（未达成）": "No (not met)",
    "用模型判断目标是否达成，是/否走不同控制路径": "The model judges if the goal was met; yes/no take different paths",
    "运行判断：由模型裁决是 / 否": "Run judge: the model decides yes / no",
    "模型根据任务目标与已有结果判断是否达成；是/否沿不同端子向后传递控制。":
      "The model judges the goal against existing results; yes/no pass control on different ports.",
    "请先填写任务目标或判断标准": "Fill in the task goal or judge criteria first",
    "无法从模型回复中解析是/否": "Could not parse yes/no from the model reply",
    "判断调用失败": "Judge call failed",
    "判断：": "Judge: ",
    "是": "Yes",
    "否": "No",
    "已请求停止判断…": "Stop requested for judge…",
    "缺少起点": "Missing start",
    "需要干涉后才能继续": "Needs attention before it can continue",
    "任务需要干涉：": "Task needs attention: ",
    "任务失败：": "Task failed: ",
    "到达失败终点": "Reached fail end",
    "到达成功终点": "Reached success end",
    "控制流未到达终点": "Control flow did not reach an end",
    "按序执行：从起点沿控制流跑到成功/失败终点":
      "Run in order: fire start and follow control flow to a success/fail end",
    "控制流执行：输入激活起点 · 成功/失败输出控制信号":
      "Control-flow run: input activates start · success/fail emit control signals",
    "控制输入（激活内部起点）": "Control in (activate inner start)",
    "成功（到达成功终点）": "Success (reached success end)",
    "失败（到达失败终点）": "Fail (reached fail end)",
    "成功": "OK",
    "失败": "Fail",
    "控制": "Ctrl",
    "任务节点仅接受控制信号（不接内容连线）":
      "Task nodes only accept control signals (no content wires)",
    "任务控制输入端子已被占用": "Task control input is already occupied",
    "任务节点仅有成功 / 失败控制输出":
      "Task nodes only have success / fail control outputs",
    "让全局助手根据目标自动拆成内部任务图":
      "Ask the global assistant to split the goal into an inner task graph",
    " 个任务": " tasks",
    "控制节点": "Control nodes",
    "定时触发器": "Timer",
    "定时触发器节点": "Timer Node",
    "定时触发器（计划 / Cron）": "Timer (schedule / cron)",
    "定时": "Timer",
    "武装": "Armed",
    "模式": "Mode",
    "一次（计划时间）": "Once (scheduled time)",
    "间隔重复": "Interval repeat",
    "Cron 表达式": "Cron expression",
    "每隔（秒）": "Every (sec)",
    "系统本地时间，到点触发一次后自动解除武装":
      "Local system time; fires once then disarms",
    "五段 Cron：分 时 日 月 周（本地时间；周 0/7=周日）":
      "Five-field cron: min hour dom mon dow (local; 0/7=Sun)",
    "立即触发": "Fire now",
    "立刻启用输出端连接的目标（不改变武装状态的下次计划）":
      "Run outgoing targets now (does not change the next armed schedule)",
    "目标 ": "Targets ",
    "无输入端子。▶ 武装后按计划触发；每次触发沿输出端启用目标。也可接在控制流中，脉冲到达时等待下一次计划点再继续。":
      "No inputs. ▶ arms the schedule; each fire runs outgoing targets. In a control-flow pulse it waits for the next schedule point then continues.",
    "请填写计划时间（系统本地时间）": "Enter a scheduled local datetime",
    "Cron 需为 5 段：分 时 日 月 周": "Cron needs 5 fields: min hour dom mon dow",
    "无法解析 Cron 表达式": "Could not parse cron expression",
    "间隔秒数无效": "Invalid interval seconds",
    "未连接任何目标节点": "No target nodes connected",
    "已停止定时触发器：": "Timer stopped: ",
    "定时触发器已武装：": "Timer armed: ",
    "定时触发：": "Timer fired: ",
    " · 已启用 ": " · enabled ",
    " 个目标": " target(s)",
    "已武装 · 下次 ": "Armed · next ",
    "上次 ": "Last ",
    " 次": " times",
    "未武装": "Not armed",
    "控制流等待触发 · ": "Control-flow waiting · ",
    "无法计算下次触发时间": "Could not compute next fire time",
    "按系统时间计划触发，启用输出端连接的目标节点":
      "Fires on a system-time schedule and enables outgoing targets",
    "停止定时触发器": "Stop timer",
    "武装定时触发器：到点后启用已连接目标":
      "Arm timer: when due, enable connected targets",
    "你是任务裁决器。根据「目标」和「已有结果」判断目标是否已经达成。只输出一行：YES 或 NO，不要解释。":
      "You are a task judge. Based on the Goal and existing results, decide if the goal is already met. Output one line only: YES or NO, no explanation.",
    "执行 / 清空": "Run / Clear",
    "需求等待（监视文件）": "Wait for file (watch file)",
    "任务（规划 · 可进入分段解决）": "Task (plan · enter to solve in parts)",
    "步骤：": "Steps:",
    "子任务：": "Sub-tasks:",
    "已执行：": "Ran: ",
    "任务完成：": "Task complete: ",
    "任务执行失败：": "Task failed: ",
    "已请求停止任务…": "Stop requested for task…",
    "标记完成": "Mark done",
    "步骤说明": "Step description",
    "删除该步骤": "Delete this step",
    "无效的父任务：": "Invalid parent task: ",
    " · 内部 ": " · inner ",
    " 个节点": " nodes",
    " 个子任务": " sub-tasks",
    "○ ": "○ ",
    " · 点击 ▶ 按序执行": " · Click ▶ to run in order",
    "◉ 进行中": "◉ In progress",
    "文档": "Docs",
    "使用手册": "User manual",
    "使用手册：界面说明与常见问题":
      "User manual: interface help and FAQ",
    "答疑": "Ask",
    "文档答疑": "Docs Q&A",
    "文档答疑：仅根据本手册回答，不会操作画布":
      "Docs Q&A: answers from this manual only; never edits the canvas",
    "仅根据内置手册作答，不会改画布":
      "Answers from the built-in manual only; does not edit the canvas",
    "筛选目录…": "Filter topics…",
    "问手册…（Enter 发送，Shift+Enter 换行）":
      "Ask the manual… (Enter send, Shift+Enter newline)",
    "生成当前画布的高清总览图": "Export a high-resolution overview of this canvas",
    "生成高清总览图": "High-res canvas overview",
    "将导出当前画布全部节点、连线与标注的高清总览图。生成时画面会短暂移动，完成后恢复你的视角。是否继续？":
      "Export a high-resolution overview of every node, wire, and mark on this canvas. The view will pan briefly and then restore. Continue?",
    "正在生成高清总览图…": "Generating high-res overview…",
    "正在生成高清总览图 {cur}/{total}…": "Generating high-res overview {cur}/{total}…",
    "已保存总览图：": "Overview saved: ",
    "生成总览图失败：": "Failed to generate overview: ",
    "当前没有可导出的画布内容": "Nothing on the canvas to export",
    "请先切换到画布": "Switch to the canvas first",
    "正在生成总览图，请稍后重试。":
      "An overview is being generated right now — try again in a moment.",
    "当前环境不支持画布拍照": "This environment cannot capture the canvas",
    "生成总览图失败：主进程没取到画面（MTNode 窗口最小化或不可见）。请先把窗口显示出来再拍。":
      "Failed to generate the overview: the main process got no picture (the MTNode window is minimized or invisible). Show the window first, then capture again.",
    "画布拍照是截屏：只能拍屏幕上正显示的那张画布。本会话所属画布当前不在前台，请先切换到它再拍。":
      "The canvas snapshot is a screen capture: it can only capture the canvas on screen. This session's canvas is in the background — switch to it first.",
    "path 必须是本机绝对路径：": "path must be an absolute local path: ",
    "画布总览图只能保存为 .png：": "A canvas overview can only be saved as .png: ",
    "已拍下整张画布（节点 + 连线 + 标注）。要真的看懂图里内容，把 path 交给 mtnode_vision 识图；拍图期间画面会短暂移动，已自动恢复。":
      "Captured the whole canvas (nodes + wires + marks). To actually read what is in it, hand path to mtnode_vision; the view panned briefly during the capture and has been restored.",
    "可以问「闸门为什么不放行」「如何配置 API Key」等。回答只依据左侧手册。":
      "Try “Why won’t the gate open?” or “How do I set an API Key?”. Answers use the left-hand manual only.",
    "讨论区": "Forum",
    "MTNode 讨论区": "MTNode Forum",
    "MTNode 讨论区：免登录浏览话题与回复；与创意工坊同一账户，登录后可发话题、回帖并改状态":
      "MTNode Forum: browse topics and replies without signing in; same account as Creative Workshop — sign in to post topics, reply and set status",
    "工作目录（必填）": "Working directory (required)",
    "请选择已存在的文件夹…": "Choose an existing folder…",
    "新建画布必须指定工作目录。智能节点与相对保存路径都相对该目录，缺少目录会导致读写失败。":
      "A new canvas must have a working directory. Agent nodes and relative save paths use it; missing it causes read/write failures.",
    "请选择工作目录": "Choose a working directory",
    "工作目录不存在或不是有效文件夹": "Working directory does not exist or is not a valid folder",
    "打开讨论区": "Open forum",
    "已内置": "Built-in",
    "内置组件可直接打开；桌宠等可选组件按需下载，不随主程序安装包分发。":
      "Optional add-ons such as the forum and desktop pet are downloaded on demand and are not in the installer.",
    "讨论区窗口，与创意工坊共用账户。免登录即可浏览话题与回复；登录后可发话题、回帖并改状态，话题长期保留。":
      "A forum window sharing the Creative Workshop account. Topics and replies are browsable without signing in; sign in to post a topic, reply and set status. Topics are kept long-term.",
    "插件：可选组件（桌宠等），按需下载安装": "Plugins: optional components (desktop pet, etc.), download on demand",
    "插件：讨论区等内置组件，以及可下载的桌宠":
      "Plugins: downloadable forum, desktop pet, and other add-ons",
    "插件：云端目录更新，讨论区等内置组件与可下载插件":
      "Plugins: cloud catalog; download the forum, desktop pet, and other add-ons",
    "插件：云端目录更新，桌宠等按需下载":
      "Plugins: cloud catalog; download the desktop pet and other add-ons on demand",
    "图片过大": "Image is too large",
    "正在拉取云端插件目录…": "Fetching the cloud plugin catalog…",
    "插件列表来自云端，可不升级主程序获取新插件。":
      "Plugin list is loaded from the cloud; new plugins can be added without upgrading the app.",
    "云端目录暂不可用，已显示上次缓存。": "Cloud catalog unavailable; showing the last cached list.",
    "云端目录暂不可用，已显示内置列表。": "Cloud catalog unavailable; showing the built-in list.",
    "刷新目录": "Refresh catalog",
    "请先升级主程序": "Upgrade the app first",
    "安装包校验失败": "Package checksum failed",
    "此插件需升级主程序后才能安装": "Upgrade the app before installing this plugin",
    "下载地址无效": "Download URL is invalid",
    "安装包缺少入口页": "Package is missing its entry page",
    "尚未安装": "Not installed yet",
    "安装包过大": "Package is too large",
    "下载超时": "Download timed out",
    "正在安装…": "Installing…",
    "需升级应用": "App update required",
    "请更新应用以使用此插件": "Update the app to use this plugin",
    "插件已安装": "Plugin installed",
    "插件已更新": "Plugin updated",
    "插件已卸载": "Plugin uninstalled",
    " · 已下架": " · retired",
    "卸载该插件？将删除已下载的运行时文件。":
      "Uninstall this plugin? Downloaded runtime files will be deleted.",
    "暂无插件": "No plugins",
    "斜杠命令与技能": "Slash commands and skills",
    "暂无匹配的命令或技能": "No matching command or skill",
    "已安装技能": "Installed skill",
    "请使用技能": "Use skill",
    "未另写说明，请按技能默认流程执行。": "No extra instructions; follow the skill’s default flow.",
    "—— 技能说明书（必须遵循）——": "—— Skill instructions (must follow) ——",
    "。输入 / 可呼出技能列表。": " Type / to open the skill list.",
    "。输入 / 呼出技能，或 /help 查看命令": ". Type / to open skills, or /help for commands",
    "描述任务…（Enter 发送，Shift+Enter 换行；输入 / 呼出技能与命令）":
      "Describe a task… (Enter to send, Shift+Enter for a new line; / for skills and commands)",
    "描述任务…（Enter 换行，Ctrl+Enter 发送；输入 / 呼出技能与命令）":
      "Describe a task… (Enter for a new line, Ctrl+Enter to send; / for skills and commands)",
    "命令:输入 / 呼出技能与命令 · /new 新会话 · /compact 压缩上文 · /plan 规划 · /rename 改名 · /export 导出 · /permissions 权限预设 · /help":
      "Type / for skills and commands · /new session · /compact · /plan · /rename · /export · /permissions · /help",
    "问助手…（Enter 发送，Shift+Enter 换行；输入 / 呼出技能）":
      "Ask the assistant… (Enter to send, Shift+Enter for a new line; / for skills)",
    "启用服务": "Start service",
    "关闭服务": "Stop service",
    "移除入口": "Remove entry",
    "仅移除插件入口与控制台缓存，不会删除你设置的安装目录中的项目与模型。":
      "Only removes the plugin entry and console cache. Your install directory (project and models) is kept.",
    "移除插件入口": "Remove plugin entry",
    "已移除入口；安装目录项目已保留": "Entry removed; install directory kept",
    "音乐生成": "Music generation",
    "工作流生成": "Workflow generation",
    "提示词生成": "Prompt generation",
    "其他": "Other",
    "通用": "General",
    "画布搭建": "Canvas building",
    "画布规范": "Canvas rules",
    "开发架构": "Dev architecture",
    "小说写作": "Novel writing",
    "文本生成": "Text generation",
    "视频生成": "Video generation",
    "音频生成": "Audio generation",
    /* 一级子菜单「视频生成 / 音频生成」成员名与新建节点默认标题（后端名） */
    "Minimax H3": "Minimax H3",
    "Minimax Music 3": "Minimax Music 3",
    "Minimax H3 节点": "Minimax H3 Node",
    "Minimax Music 3 节点": "Minimax Music 3 Node",
    "Minimax Music 3（音乐生成 · 提示词 + 歌词）":
      "Minimax Music 3 (music · prompt + lyrics)",
    /* 一级子菜单「音频生成」成员：SoVITS 语音生成（GPT-SoVITS 本机后端） */
    "SoVITS 语音": "SoVITS voice",
    "SoVITS 语音生成（文本转语音 · GPT-SoVITS）":
      "SoVITS speech (text-to-speech · GPT-SoVITS)",
    /* tts_gen 类型骨架：侧栏标注、新建默认标题与端子口径 */
    "SoVITS 语音节点": "SoVITS Voice Node",
    "语音": "Voice",
    "待合成文本（语音内容）": "Text to synthesize (speech content)",
    "语音生成节点需要文本来源（待合成文本）":
      "Speech generation node needs a text source (text to synthesize)",
    "语音生成节点控制输入端子为端口 1":
      "Speech generation node's control input is port 1",
    /* tts_gen 节点体 UI（音色 / 语速 / 格式 / 路径 / 试听 / 状态） */
    "SoVITS 语音 · GPT-SoVITS 本机后端 · 文本转语音":
      "SoVITS voice · GPT-SoVITS local backend · text-to-speech",
    "调用 GPT-SoVITS 后端合成语音":
      "Synthesize speech with the GPT-SoVITS backend",
    "打开 GPT-SoVITS 控制台": "Open GPT-SoVITS console",
    "打开 H3 控制台日志": "Open H3 console log",
    "打开 Music 3 控制台日志": "Open Music 3 console log",
    "⚠ GPT-SoVITS 插件未安装：请在「插件 · GPT-SoVITS 语音合成」中安装后使用本节点":
      "⚠ GPT-SoVITS plugin not installed: install it in Plugins · GPT-SoVITS Speech Synthesis before using this node",
    "插件 · GPT-SoVITS 语音合成：设置安装目录 → 安装":
      "Plugins · GPT-SoVITS Speech Synthesis: set install folder → Install",
    "待合成文本走端子 T（连接上游文本节点）":
      "Text to synthesize comes in on port T (connect an upstream text node)",
    "音色": "Voice",
    "音色名（后端未就绪时可手填）":
      "Voice id (type it manually when the backend is down)",
    "刷新音色列表": "Refresh voice list",
    "语速": "Speed",
    "语速倍率（0.5–2.0）": "Speed rate (0.5–2.0)",
    "输出格式": "Output format",
    /* SoVITS 语音生成 · 执行链（GPT-SoVITS 插件） */
    "语音合成插件未就绪": "Speech synthesis plugin not ready",
    "请连接文本来源（待合成文本 · 端子 T）":
      "Connect a text source (text to synthesize · port T)",
    "启动后端并合成…": "Starting backend and synthesizing…",
    "语音合成中…": "Synthesizing speech…",
    "语音已生成：": "Speech saved: ",
    "已取消语音合成": "Speech synthesis cancelled",
    "待合成文本为空": "Text to synthesize is empty",
    "未设置输出路径": "No output path set",
    "合成失败": "Synthesis failed",
    "GPT-SoVITS 服务密钥缺失（请先在「插件 · GPT-SoVITS 语音合成」启动一次后端）":
      "GPT-SoVITS service key missing (start the backend once in Plugins · GPT-SoVITS Speech Synthesis)",
    "后端返回空音频（请检查该音色的参考音频）":
      "Backend returned empty audio (check this voice's reference clip)",
    "GPT-SoVITS 后端尚未安装（请在「插件 · GPT-SoVITS 语音合成」中安装）":
      "GPT-SoVITS backend is not installed (install it in Plugins · GPT-SoVITS Speech Synthesis)",
    "GPT-SoVITS 后端缺少 Python 环境（请在「插件 · GPT-SoVITS 语音合成」中重新安装）":
      "GPT-SoVITS backend has no Python environment (reinstall it in Plugins · GPT-SoVITS Speech Synthesis)",
    "GPT-SoVITS 后端安装目录未设置或不合法（请在「插件」中重新选择目录）":
      "GPT-SoVITS backend install folder is unset or invalid (choose it again in Plugins)",
    "GPT-SoVITS 后端未能在规定时间内就绪（可打开插件控制台查看启动日志）":
      "GPT-SoVITS backend did not come up in time (open the plugin console for the startup log)",
    "后端没有可用音色（请先在插件里添加参考音频音色）":
      "No voice available on the backend (add a reference-audio voice in Plugins first)",
    "音色不存在（请重新选择音色）": "Voice not found (pick the voice again)",
    "语种被后端策略拒绝（请在插件里调整语种策略或换文本）":
      "Language rejected by the backend policy (adjust the language policy in Plugins or change the text)",
    "音频写盘失败（请检查输出路径是否可写）":
      "Failed to write the audio file (check whether the output path is writable)",
    "后端不支持该输出格式（请打开插件控制台更新语音后端）":
      "The backend does not support this output format (open the plugin console and update the speech backend)",
    "本机缺少 ffmpeg，无法把音频转成 mp3 / flac（请改用 wav 输出，或重新安装语音后端）":
      "ffmpeg is missing, so the audio cannot be converted to mp3 / flac (switch the output to wav or reinstall the speech backend)",
    "音频转码失败（请改用 wav 输出，或重新安装语音后端）":
      "Audio transcoding failed (switch the output to wav or reinstall the speech backend)",
    "音色缺少参考音频（请在插件里重新添加该音色的参考音频）":
      "The voice has no reference clip (re-add this voice's reference audio in Plugins)",
    "后端语种参数无效（请在插件里调整语种策略）":
      "Invalid language parameter for the backend (adjust the language policy in Plugins)",
    "后端参考文本语种无效（请在插件里重新添加该音色）":
      "Invalid reference-text language for the backend (re-add this voice in Plugins)",
    "后端不接受该文本切分方式（请更新语音后端）":
      "The backend rejects this text-splitting method (update the speech backend)",
    "后端返回 HTTP 错误：": "Backend returned an HTTP error: ",
    "（请打开插件控制台查看日志；若为 400，多为输出格式不被后端支持）":
      " (open the plugin console for logs; a 400 usually means the output format is unsupported)",
    "无法连接 GPT-SoVITS 后端（后端可能已退出，请重新执行本节点）":
      "Cannot reach the GPT-SoVITS backend (it may have exited — run this node again)",
    "提示词（Structured Caption）": "Prompt (Structured Caption)",
    "歌词（可选：不接则按纯器乐 [instrumental] 生成）":
      "Lyrics (optional: leave unwired for pure instrumental [instrumental])",
    "请连接提示词输入（端子 P）": "Connect a prompt input (port P)",
    "P/L 可能接反：P 像歌词而 L 像提示词，请检查端子":
      "P/L may be swapped: P looks like lyrics and L like a caption — check ports",
    "请先在「插件 · Minimax Music 3」中启用后端服务":
      "Start the backend in Plugins · Minimax Music 3 first",
    "已有音乐生成任务进行中，已中断本节点（禁止并行）":
      "Another music job is running; this node was aborted (no parallel runs)",
    "已有音乐生成任务进行中（禁止并行）：":
      "Another music job is running (no parallel runs): ",
    "已有音视频生成任务进行中（全局仅 1 个，禁止并行）：":
      "Another audio/video job is running (global limit: 1): ",
    "已有音视频生成任务进行中，已中断本节点（全局仅 1 个，禁止并行）":
      "Another audio/video job is running; this node was aborted (global limit: 1)",
    "时长（秒，≤150）": "Duration (sec, ≤150)",
    "时长（秒，4–15）": "Duration (sec, 4–15)",
    "时长": "Duration",
    "种子": "Seed",
    "摇数": "Reroll",
    "每次执行种子 +1（默认开启）":
      "Increment seed by +1 on every run (on by default)",
    "输出目录": "Output folder",
    "文件名（可选）": "Filename (optional)",
    "随机种子": "Randomize seed",
    "auto CPU offload（24G 推荐）": "auto CPU offload (recommended on 24G)",
    "提示词 · 歌词 · 节点内改时长/种子/输出路径":
      "Prompt · Lyrics · edit duration/seed/output on the node",
    "P=提示词 · L=歌词 · 点击「设置」改时长/种子/输出路径":
      "Prompt · Lyrics · edit duration/seed/output on the node",
    "MiniMax Music 3 · 端子：提示词 / 歌词 · 执行时自动启停后端":
      "MiniMax Music 3 · ports: prompt / lyrics · backend auto start/stop",
    "MiniMax Music 3 · 端子 P=提示词 · L=歌词 · 执行时自动启停后端":
      "MiniMax Music 3 · ports: prompt / lyrics · backend auto start/stop",
    "需启用 Minimax Music 3 后端 · 全局单例互斥":
      "Requires Minimax Music 3 backend · global singleton lock",
    "音乐已生成：": "Music saved: ",
    "已取消音乐生成": "Music generation cancelled",
    /* ── YuE2 音乐生成（yue_gen · 本机 YuE2 后端 · 插件 yue2-local） ── */
    /* 节点名 / 菜单项 / 新建默认标题 */
    "YuE2": "YuE2",
    "YuE2 音乐节点": "YuE2 Music Node",
    "YuE2（歌词→整曲 · 可编辑谱面）": "YuE2 (lyrics → full song · editable score)",
    "YuE2（音乐生成 · 风格提示词 + 歌词 → 整曲 · 可编辑 ABC 谱面）":
      "YuE2 (music · style prompt + lyrics → full song · editable ABC score)",
    "音乐": "Music",
    /* yue_gen 端子：P=风格提示词 · L=歌词 · ABC=谱面（可选）· 控制 */
    "风格": "Style",
    "歌词": "Lyrics",
    "ABC": "ABC",
    "ABC 谱": "ABC score",
    "风格提示词（曲风 / 人声 / 乐器 / 情绪）":
      "Style prompt (genre / vocals / instruments / mood)",
    "歌词（含 [Verse]/[Chorus] 等结构标签）":
      "Lyrics (with [Verse]/[Chorus] structure tags)",
    "ABC 谱（可选：手工谱面，留空则由模型生成）":
      "ABC score (optional hand-written score; leave empty and the model writes it)",
    /* yue_gen 设置：思维链档位 / 抽卡 / 种子 / 输出路径 / offload */
    "思维链": "Chain of thought",
    "思维链档位": "Chain-of-thought tier",
    "思维链 / 抽卡 / 种子 / 输出路径 / offload":
      "CoT / rolls / seed / output path / offload",
    "full（完整思维链）": "full (full chain of thought)",
    "melody（旋律引导）": "melody (melody guidance)",
    "off（关思维链）": "off (no chain of thought)",
    "YuE2 的思维链（CoT）档位：full 质量最好、melody 更快、off 仅按提示词":
      "YuE2's chain-of-thought (CoT) tier: full has the best quality, melody is faster, off follows the prompt only",
    "思维链 ": "CoT ",
    /* yue_gen 节点体 / 执行链状态与报错（未装 / 未就绪 / 缺输入 / 生成中 / 取消 / 失败） */
    "调用 YuE2 本地后端生成音乐": "Generate music with the local YuE2 backend",
    "打开 YuE2 控制台日志": "Open the YuE2 console log",
    "YuE2 · 端子 P=风格提示词 · L=歌词 · ABC=谱面（可选）· 执行时自动启停后端":
      "YuE2 · ports: P=style prompt · L=lyrics · ABC=score (optional) · backend auto start/stop",
    "⚠ YuE2 插件未安装：请在「插件 · YuE2 本地音乐」中安装后使用本节点":
      "⚠ YuE2 plugin not installed: install it in Plugins · YuE2 Local Music before using this node",
    "待生成（端子 P=风格提示词 · L=歌词 · ABC=谱面可选）":
      "Waiting (ports: P=style prompt · L=lyrics · optional ABC score)",
    "请连接风格提示词输入（端子 P），或直接在节点上填写风格提示词":
      "Connect a style-prompt input (port P) or type the style prompt on the node",
    "请连接歌词输入（端子 L），或直接在节点上填写歌词":
      "Connect a lyrics input (port L) or type the lyrics on the node",
    "YuE2 音乐插件未就绪": "YuE2 music plugin is not ready",
    "启动后端并生成…": "Starting backend and generating…",
    "生成中…": "Generating…",
    /* yue 缺依赖定向修复（main-yue.js 报错码 missing_dep:<name> / 控制台文案） */
    "缺依赖 ": "Missing dependency ",
    "（点「一键修复」或手动 pip install）": " (click “One-click repair” or run pip install manually)",
    "一键修复": "One-click repair",
    "已自动补装 ": "Auto-installed ",
    /* yue 注意力档位定向修复（main-yue.js 报错码 attention_backend_unsupported / 控制台文案） */
    "注意力档位用了 flash（Windows 轮子没编 flash kernel）：已改用 ":
      "Attention backend was flash (the Windows wheel ships no flash kernel): switched to ",
    "，点「一键修复」重试": ", click “One-click repair” to retry",
    "注意力档位不可用（flash 在 Windows 轮子里没编 kernel）":
      "Attention backend unavailable (the Windows wheel ships no flash kernel)",
    "注意力档位：": "Attention backend: ",
    "未探到可用注意力档位，已回落 sdpa": "No usable attention backend found; fell back to sdpa",
    /* yue_gen 连线规则报错（connectError：数据端口只吃文本来源 · 控制线固定端口 3） */
    "YuE2 音乐节点需要文本来源（风格提示词 / 歌词 / ABC 谱）":
      "YuE2 music node needs a text source (style prompt / lyrics / ABC score)",
    "YuE2 音乐节点控制输入端子为端口 3":
      "YuE2 music node control input is port 3",
    /* ── SenseNova 本地图像生成（sensenova_gen · 插件 sensenova-local）──
       输出 0 = 图像端子，与云端文生图（proc_image）同语义，共用「图像」说法。 */
    "SenseNova": "SenseNova",
    "SenseNova 图像节点": "SenseNova Image Node",
    "文生图（云端服务商 · 图像生成）": "Text to image (cloud provider · image generation)",
    "SenseNova（本地图像生成 · SenseNova-U1.5-8B-MoT）":
      "SenseNova (local image generation · SenseNova-U1.5-8B-MoT)",
    "SenseNova（本地图像生成 · SenseNova-U1.5-8B-MoT · 官方 11 个分辨率桶 · 需 24G 显存）":
      "SenseNova (local image generation · SenseNova-U1.5-8B-MoT · 11 official resolution buckets · needs 24G VRAM)",
    "SenseNova-U1.5-8B-MoT（本机出图）· 端子 P=提示词 · 分辨率只能取官方 11 个训练桶 · 执行时自动启停后端":
      "SenseNova-U1.5-8B-MoT (local image generation) · port P = prompt · only the 11 official training buckets · the backend starts and stops on its own",
    "调用 SenseNova 本地后端生成图像": "Generate an image with the local SenseNova backend",
    "打开 SenseNova 控制台日志": "Open SenseNova console log",
    "SenseNova 图像插件未就绪": "SenseNova image plugin is not ready",
    "未安装 SenseNova 本地图像生成插件：在顶栏「插件」里安装后才能出图":
      "SenseNova local image plugin not installed: install it under Plugins in the top bar before generating",
    "⚠ SenseNova 插件未安装：请在「插件 · SenseNova 本地图像生成」中安装后使用本节点":
      "⚠ SenseNova plugin not installed: install it under Plugins · SenseNova Local Image Generation before using this node",
    "插件 · SenseNova 本地图像生成：设置安装目录 → 安装":
      "Plugins · SenseNova Local Image Generation: set an install directory → Install",
    "提示词 Prompt（@ 引用输入节点 · 不接线时用它出图）":
      "Prompt (@-reference input nodes · used when nothing is wired in)",
    "例如：清晨薄雾里的雪山湖泊，写实风光摄影，柔和逆光… 输入 @ 引用已连接节点":
      "E.g. snow mountains and a lake in morning mist, realistic landscape photography, soft backlight… type @ to reference connected nodes",
    "图像不存在（生成后将显示于此）": "No image yet (it appears here once generated)",
    "图像已生成：": "Image saved: ",
    "已取消图像生成": "Image generation cancelled",
    "提示词（要画成什么 · 可接文本节点，也可接参考图）":
      "Prompt (what to draw · accepts text nodes or reference images)",
    "（数据槽：可接文本 / 图像）": " (data slot: accepts text / image)",
    "输出端子（本节点生成的图像 · 可直接连图像保存 / 预览）":
      "Output port (the image this node generated · wire it straight into save-image / preview)",
    "参考图已生效：本次按图像编辑生成（{n} 张参考图参与条件）":
      "Reference image(s) applied: generated in image-editing mode ({n} reference image(s) conditioned the result)",
    "参考图条件强度": "Reference image strength",
    "图像编辑模式（连了参考图）才生效：图像 CFG 权重，1.0 = 关闭（官方默认）；调到 1.5~2.0 会更贴参考图；没有参考图时该值不下发。":
      "Only applies in image-editing mode (a reference image is wired): image CFG weight, 1.0 = off (official default); raise to 1.5–2.0 to follow the reference image more closely; the value is not sent when there is no reference image.",
    "分辨率桶（官方训练尺寸）": "Resolution bucket (official training size)",
    "分辨率桶 / 步数 / CFG / 抽卡 / 种子 / 显存档位 / 精度 / think / 参考图强度":
      "Resolution bucket / steps / CFG / rolls / seed / VRAM tier / dtype / think / reference strength",
    "官方只有这 11 个训练分辨率桶，不是任意宽高；最小那桶也有 2048×2048（≈400 万像素），所以换小尺寸省不了显存 —— 省显存请改下面的「显存档位」或减小采样步数。":
      "There are only 11 official training buckets, not arbitrary width×height; even the smallest is 2048×2048 (≈4M pixels), so a smaller size saves no VRAM — to save VRAM lower the VRAM tier below or reduce the step count.",
    "步数": "Steps",
    "CFG Scale": "CFG Scale",
    "CFG Norm": "CFG Norm",
    "none（默认）": "none (default)",
    "Timestep Shift": "Timestep Shift",
    "1–200；默认 50。试机 / 省时间可以降到 20 以内，画质会糙。":
      "1–200; default 50. Drop it under 20 to smoke-test faster, at some quality cost.",
    "提示词贴合度（官方默认 4.0）；越大越贴提示词、越容易过饱和。":
      "Prompt adherence (official default 4.0); higher sticks closer to the prompt and oversaturates sooner.",
    "噪声调度平移（官方默认 3.0）": "Timestep shift (official default 3.0)",
    "显存与精度": "VRAM & precision",
    "显存档位": "VRAM tier",
    "fast（官方 24G 卡档 · 默认）": "fast (official 24G tier · default)",
    "balanced（更省显存，更慢）": "balanced (less VRAM, slower)",
    "low（最省显存 · 需大内存）": "low (least VRAM · needs lots of RAM)",
    "full（不卸载 · ≥48G 显存）": "full (no offload · ≥48G VRAM)",
    "权重 bf16 约 32.66GB，比一张 24G 卡还大，所以默认必须分层卸载（offload 到内存）。出图报显存不足时后端会自动降一档并在结果里写明；24G 卡请勿选 full。":
      "The bf16 weights are ~32.66GB — bigger than a 24G card — so layered offloading to RAM is on by default. On an out-of-memory error the backend auto-downgrades one tier and says so in the result; do not pick full on a 24G card.",
    "权重精度": "Weight dtype",
    "思考模式": "Thinking mode",
    "think（先推理再出图 · 另存 .think.txt）":
      "think (reason first, then draw · also saved as .think.txt)",
    "开启后模型会先输出一段推理文本，再据此生成图像；更稳但更慢。":
      "When on, the model writes out its reasoning first and draws from it — steadier but slower.",
    "尺寸": "Size",
    "步数 ": "steps ",
    "显存 ": "VRAM ",
    "think 开": "think on",
    "think 关": "think off",
    "权重在位": "Weights loaded",
    "权重未载": "Weights not loaded",
    /* SenseNova 后端 / 环境类报错（唯一真源 = app-nodes.js 的 sensenovaGenErrorText） */
    "SenseNova 未安装：请在「插件 · SenseNova 本地图像生成」里安装后再试":
      "SenseNova is not installed: install it under Plugins · SenseNova Local Image Generation first",
    "SenseNova 依赖未装好（缺 Python 环境）：请在插件控制台重跑安装":
      "SenseNova dependencies are missing (no Python environment): re-run the install from the plugin console",
    "本机没有可用的 NVIDIA 显卡：SenseNova 本地出图需要一张 N 卡":
      "No usable NVIDIA GPU on this machine: local SenseNova generation needs an NVIDIA card",
    "显存不足：请把节点「显存档位」降到 balanced / low，或减小采样步数（降分辨率省不了显存）":
      "Out of VRAM: lower this node's VRAM tier to balanced / low, or reduce the step count (a smaller resolution saves no VRAM)",
    "显存不够：SenseNova-U1.5-8B-MoT 需要一张 ≥24GB 显存的 NVIDIA 卡（权重 bf16 约 32.66GB，靠分层卸载跑在 24G 卡上）":
      "Not enough VRAM: SenseNova-U1.5-8B-MoT needs an NVIDIA card with ≥24GB VRAM (the bf16 weights are ~32.66GB and run on a 24G card only thanks to layered offload)",
    "内存不够：分层卸载要把权重放在内存，请确认物理内存满足要求后在插件里勾「强制继续」":
      "Not enough RAM: layered offload keeps the weights in memory first — make sure physical RAM is enough, then tick Force continue in the plugin",
    "磁盘空间不足：权重约 32.66GB，请在插件里换一个剩余空间够的安装目录":
      "Not enough disk space: the weights are ~32.66GB — pick an install directory with room in the plugin",
    "当前 Python 环境装的是 CPU 版 torch：请在插件控制台自修复 / 重装修 CUDA 版 torch":
      "This Python environment has the CPU build of torch: self-repair / reinstall the CUDA build from the plugin console",
    "SenseNova 随包脚手架缺失或不完整：请重装应用或重跑安装技能":
      "The bundled SenseNova scaffold is missing or incomplete: reinstall the app or re-run the install skill",
    "后端启动超时（权重约 32.66GB，首次加载要几分钟）：请稍后重试 ▶":
      "Backend start timed out (the weights are ~32.66GB; the first load takes a few minutes): please press ▶ again shortly",
    "后端启动失败：请打开 SenseNova 控制台日志查看具体原因":
      "Backend failed to start: open the SenseNova console log to see why",
    "连不上本地后端（127.0.0.1:8774）：请在插件里关闭后重新开启":
      "Cannot reach the local backend (127.0.0.1:8774): switch it off and back on in the plugin",
    "生成超时：采样步数过大或显存频繁换入换出，请降低步数 / 显存档位后重试":
      "Generation timed out: too many steps or heavy VRAM swapping — lower the step count / VRAM tier and retry",
    "后端正忙（同时只跑一张图），请等待当前任务结束":
      "The backend is busy (only one image at a time); wait for the current job to finish",
    "本宿主同时只跑一张图，请等待当前任务结束":
      "This host runs one image at a time; wait for the current job to finish",
    "提示词为空：请接入文本输入（端子 P）或在节点里填写提示词":
      "Empty prompt: wire a text input into port P, or type a prompt on the node",
    "模型加载失败：请在插件控制台检查权重是否完整（8 片 safetensors）":
      "Model load failed: check in the plugin console whether the weights are complete (8 safetensors shards)",
    "SenseNova 宿主内部错误：请看插件控制台日志（console.log）并反馈给开发者":
      "SenseNova host internal error: check the plugin console log (console.log) and report it to the developer",
    "图像生成失败": "Image generation failed",
    "图像写盘失败：请检查输出路径是否可写":
      "Could not write the image: check that the output path is writable",
    "缺少节点标识（内部错误）：请重试点 ▶":
      "Missing node id (internal error): press ▶ again",
    "SenseNova 自动安装超时（权重约 32.66GB，下载要看网速）：请稍后重试 ▶":
      "SenseNova auto-install timed out (the weights are ~32.66GB — download speed decides): please press ▶ again shortly",
    "已取消视频生成": "Video generation cancelled",
    "若仍要创建节点，edit 必须传 layout:false，且禁止 group。":
      "If you still create nodes, edit must pass layout:false and must not use group.",
    "禁止创建或收纳超级节点（canvas_super）。":
      "Creating or packing super nodes is forbidden (canvas_super).",
    "创建/收纳超级节点需用户审批（canvas_super）。":
      "Creating or packing super nodes requires user approval (canvas_super).",
    "无效的超级节点：": "Invalid super node: ",
    "超级": "Super",
    "超级权限 · 外部路径策略": "Super permission · outside-path policy",
    "已开启超级权限：Agent 可访问本机任意位置（用于辅助编程等高级任务）。首次请选择访问工作区以外路径时的策略：":
      "Super permission is on: the agent may access any path on this machine (for advanced coding tasks). Choose how to handle paths outside the workspace:",
    "「是否允许访问」：每次触及未授权的外部路径时弹窗确认（可拒绝 / 允许一次 / 始终允许该路径及子路径）。「直接访问」：不再询问。":
      "“Ask”: prompt each time an unauthorized outside path is touched (Deny / Once / Always for that path and children). “Direct”: no prompts.",
    "是否允许访问": "Ask before access",
    "直接访问": "Direct access",
    "已切换为画布权限（工作区沙箱）": "Switched to canvas permission (workspace sandbox)",
    "已开启超级权限（外部路径将询问）": "Super permission on (will ask for outside paths)",
    "已开启超级权限（外部路径直接访问）": "Super permission on (direct outside access)",
    "超级权限：可访问全主机": "Super permission: full host access",
    " · 外部路径询问": " · ask for outside paths",
    " · 外部路径直接访问": " · direct outside access",
    "（点击切回画布权限）": " (click to return to canvas permission)",
    "画布权限：工作区沙箱（点击开启超级权限）":
      "Canvas permission: workspace sandbox (click to enable super permission)",
    "允许访问外部路径？": "Allow outside path?",
    "超级权限节点请求访问工作区以外的路径。请选择是否允许该路径及其子路径。":
      "This super-permission node wants a path outside the workspace. Allow this path and its children?",
    "路径：": "Path: ",
    "工具：": "Tool: ",
    "说明：": "Detail: ",
    "「始终允许」写入本节点；「允许一次」仅本次运行有效；「拒绝」则阻止本次调用。":
      "“Always” is saved on this node; “Once” lasts for this run; “Deny” blocks this call.",
    "未能解析具体路径，请根据工具与说明判断是否放行。":
      "Could not parse a concrete path; decide from the tool name and details.",
    /* ===== 通用短词（多处界面共用）===== */
    "返回": "Back",
    "探索": "Explore",
    "已保存": "Saved",
    "存档": "Archives",
    "新建": "New",
    "计划": "Plan",
    "取消": "Cancel",
    "输入": "Input",
    "提交": "Submit",
    "选择": "Select",
    "画布": "Canvas",
    "保存中…": "Saving…",
    "未保存": "Unsaved",
    "思考中": "Thinking",
    "就绪": "Ready",
    "中心": "Hub",
    /* 音频波形预览器（renderer/app-audioview.js）：方角播放条 + 点波形试听 */
    "暂停": "Pause",
    "播放 / 暂停": "Play / Pause",
    "音频预览": "Audio preview",
    "总时长": "Total duration",
    "正在读取波形…": "Reading waveform…",
    "点波形试听": "Click the waveform to preview",
    "点击或拖动波形任意位置，从该处试听":
      "Click or drag anywhere on the waveform to play from there",
    "文件较大，未生成波形（仍可点击或拖动进度试听）":
      "File is large, so no waveform was generated (you can still click or drag to preview)",
    "无法解析该音频的波形（仍可点击或拖动进度试听）":
      "Could not decode this audio's waveform (you can still click or drag to preview)",
    "无法播放该音频（本机播放器不支持该格式）":
      "Cannot play this audio (the local player does not support this format)",
    "点击选择": "Click to select",
    "已处理": "Done",
    "候选": "Option",
    "回滚": "Rollback",
    "↶ 回滚": "↶ Rollback",
    "撤销上一轮的全部更改": "Undo all changes of the previous round",
    "确认回滚": "Confirm rollback",
    "回滚将撤销此轮次的所有更改，且不可撤销。确认继续？":
      "Rollback will undo ALL changes of this round, and it cannot be undone. Continue?",
    "本次更改的内容": "Changes in this round",
    "（本轮无可自动列举的具体条目）": "(no concrete items to list)",
    "画布改动：": "Canvas changes: ",
    "（需人工处理）": " (manual handling needed)",
    "计划清单变更（需人工处理）": "Plan changed (manual handling needed)",
    "事实库改动 ": "DB changes: ",
    " 条（需人工处理）": " record(s) (manual handling needed)",
    "该轮仍在运行中，结束后才能回滚": "This round is still running; roll back after it finishes",
    "该轮没有可回滚的账本": "No rollback ledger for this round",
    "该轮已回滚过，不能重复回滚": "This round was already rolled back",
    "已还原 ": "Restored ",
    " 个文件": " file(s)",
    " 个本轮新建文件": " file(s) created this round",
    "跳过 ": "Skipped ",
    " 项（": " item(s) (",
    "失败 ": "Failed ",
    "需人工处理：": "Needs manual handling: ",
    "本轮没有可回退的文件改动": "No file changes to roll back in this round",
    "已回滚该轮：": "Rolled back this round: ",
    "条消息已移出上下文": " message(s) removed from context",
    "回滚未完全完成：": "Rollback incomplete: ",
    "回滚失败：": "Rollback failed: ",
    "（未记录）": "(not recorded)",
    "（未逐条记录）": "(not recorded per-item)",
    "有 ": "There ",
    " 次命令调用可能改了文件，账本无法覆盖，请自查":
      " shell command(s) may have changed files beyond the ledger; please check",
    "事实库改动超过逐条记账上限，无法逐条回退":
      "DB changes exceed the per-record cap; cannot roll back individually",
    "该轮记录不完整，还原可能不完整": "This round's ledger is incomplete; rollback may be partial",
    "时间": "Time",
    "工作区": "Workspace",
    "修改": "Modify",
    "新增": "Add",
    "连线": "Wire",
    "标注": "Mark",
    "分组": "Group",
    "节点": "Node",
    "创建": "Create",
    "创建失败：": "Create failed: ",
    "恢复": "Restore",
    "任务进度": "Progress",
    "计划已生成": "Plan generated",
    "重新编译": "Recompile",
    "新画布": "new canvas",
    "技能不存在": "Skill not found",
    /* ===== 数据库超级节点（事实收纳 → 副本 → mtnode_db） ===== */
    "数据库": "Database",
    "数据库副本": "Database replica",
    "数据库（事实收纳 · 编译副本供智能节点查询）":
      "Database (fact storage · compile replica for agent queries)",
    "网络节点": "Network Node",
    "执行节点": "Execute Node",
    "超级/开发节点": "Super / Dev Nodes",
    /* ===== 开发节点（功能块 · 项目架构 · 绑定开发会话） ===== */
    "开发": "Dev",
    "开发节点": "Dev node",
    "开发节点（项目架构 · 功能块）":
      "Dev Nodes (project architecture · module blocks)",
    "功能块": "Module block",
    "功能块（模块 · 可细化 · 绑定开发会话）":
      "Module Block (refinable · bound dev session)",
    "文件（细化产物 · 指向源码文件）": "File (refinement · maps to source file)",
    "类": "Class",
    "类（类图元素）": "Class (class-diagram element)",
    "接口": "Interface",
    "接口（类图元素）": "Interface (class-diagram element)",
    "枚举": "Enum",
    "枚举（类图元素）": "Enum (class-diagram element)",
    "在内部新建执行节点（启动器）":
      "New Execute Node Inside (launcher)",
    "按关系线整理内部排版（分层 · 可撤销）":
      "Tidy Inside by Relations (layered · undoable)",
    "已按关系线整理内部排版（{n} 个元素）":
      "Inner layout tidied by relation lines ({n} elements)",
    "该功能块内部还没有子元素，无需整理":
      "This module block has no children to tidy yet",
    "请先选中一个开发节点": "Select a dev node first",
    "模块": "Module",
    "细化": "Refine",
    "细化 · ": "Refine · ",
    "细化（选择深度：只展开本层 / 下钻到无法再细…）":
      "Refine (choose a depth: expand this layer only / drill down until nothing more can split…)",
    "细化：弹窗先选「细化深度」——只展开本层，或深度细化到无法再细（一般到文件级）；确认后在新会话中自顶向下逐层建块（Agent 先给多层梗概 · 经你确认才建节点）；无需或无法细化时也会提示":
      "Refine: the dialog first asks for the refinement DEPTH — expand this layer only, or refine all the way down until nothing can be split further (usually to file level); after you confirm, a new session creates the blocks top-down one layer at a time (the agent shows a multi-layer outline first and only creates nodes with your approval); it also tells you when refining is unnecessary or impossible",
    "确认细化": "Confirm refine",
    "无需细化": "No refinement needed",
    "已跳过细化：该功能块保持现状": "Refinement skipped: this module block stays as it is",
    /* —— 细化「深度」：现状统计 + 对话框单选档位 —— */
    "细化深度": "Refinement depth",
    "细化深度（单选）": "Refinement depth (pick one)",
    "细化深度现状（细化＝深度，非本层展开数量）：":
      "Refinement-depth status (refine means DEPTH, not how many children this layer has): ",
    "当前 0 层（尚未展开下层元素）": "Currently 0 layers deep (no lower elements expanded yet)",
    "当前已 {n} 层 · 已细化到文件级": "Currently {n} layer(s) deep · already refined down to file level",
    "当前已 {n} 层 · {m} 个块未到文件级":
      "Currently {n} layer(s) deep · {m} block(s) not yet at file level",
    "（如 {eg}）": " (e.g. {eg})",
    "深度细化到无法再细": "Deep refine — drill down until nothing more can split",
    "默认：拆出的每个子块都继续判断能否再细，一路下钻到无法进一步细化为止（一般到文件级；文件还可拆类 / 接口 / 枚举），产物为多层开发节点树。":
      "Default: every child block is re-checked for further splitting and the drill-down continues until nothing can be refined any more (usually to file level; a file can still split into class / interface / enum), producing a multi-layer dev-node tree.",
    "只展开本层": "Expand this layer only",
    "仅在本块内创建 1 层子元素，不下钻；之后可在各子块上分别点「细化」。":
      "Create exactly one layer of children inside this block and stop; you can click Refine on each child block later.",
    "如果确实要在这里继续展开，请先通过节点右键菜单把「元素类型」改为文件 / 模块；或到具体的下层文件块上分别点「细化」。":
      "If you really want to expand further here, first switch this node's element type to File / Module via its right-click menu — or click Refine on the individual lower file blocks one by one.",
    "类 / 接口 / 枚举已是架构的最细粒度元素，无需继续细化。":
      "Class / interface / enum are already the finest-grained architecture elements — no further refinement needed.",
    "该文件已展开为类 / 接口 / 枚举，已细化到无法再细。":
      "This file is already expanded into class / interface / enum elements — it cannot be refined any further.",
    "本功能块已细化到无法再细：子树 {n} 层，每片叶子都已到文件 / 类级（未到文件级的块为 0）。":
      "This module block is already refined to the bottom: a {n}-layer subtree whose every leaf reaches file / class level (0 blocks left short of file level).",
    "若还想把某个文件继续拆成类 / 接口 / 枚举，请在该文件块上单独点「细化」。":
      "To split a particular file into class / interface / enum elements, click Refine on that file block itself.",
    "只展开本层（1 层）细化该功能块": "Refine this module block one layer only (a single layer)",
    "深度细化该功能块：逐层下钻到无法再细（一般文件级）":
      "Deep-refine this module block: drill down layer by layer until nothing more can split (usually file level)",
    "确认后将新建一个细化会话：Agent 依据项目真实代码分析本模块的下层元素，先给出内容梗概清单，经你确认后才在该功能块内补充内容。若分析后认为无需或无法继续细化，它会直接告知你原因。":
      "Confirming opens a new refinement session: the agent analyzes this module's lower-level elements against the real code, first shows an outline list, and only adds content inside the module block after you approve. If it finds nothing to refine, it tells you why.",
    "细化范围（可选）": "Refinement scope (optional)",
    "例如：只展开 renderer 目录下的文件；或仅细化某个子模块。留空 = 由 Agent 自行判断。":
      "e.g. only expand files under the renderer folder; or refine just one sub-module. Leave empty = the agent decides.",
    "确认 = 新会话后台运行（工作区 = 项目根目录 · 标题「细化 · 模块名」· 不离开画布）· 取消 / 跳出不清空：再次打开本框接着上次写 · Esc 取消":
      "Confirm = runs in the background in a new session (workspace = project root · titled Refine · module name · you stay on the canvas) · cancelling or stepping away keeps this text — reopen the box and continue where you left off · Esc cancels",
    "用户指定的细化范围：": "User-specified refinement scope: ",
    "细化该功能块": "Refine this module block",
    /* —— 细化任务书抬头（深度口径） —— */
    "本次细化深度：": "Refinement depth this round: ",
    "深度细化（逐层下钻到无法再细，一般到文件级）":
      "Deep refine — drill down layer by layer until nothing more can split (usually file level)",
    "只展开本层（1 层 · 不下钻）": "Expand this layer only (a single layer · no drill-down)",
    "当前子树深度：": "Current subtree depth: ",
    "元素类型": "Element type",
    "元素类型（右键节点可切换）": "Element type (switch via node right-click)",
    "未知元素类型：": "Unknown element type: ",
    "【细化任务】": "[Refine task]",
    "未命名": "Untitled",
    "（暂无概述）": "(no overview yet)",
    "当前概述": "Current overview",
    "现有子元素": "Existing children",
    "现有子元素：": "Existing children: ",
    "本模块已有子元素：": "This module already contains:",
    /* —— 细化任务书步骤：细化＝深度（多层规划树 · 一次确认 · 自顶向下逐层创建） —— */
    "请按以下步骤细化（「细化」指的是**深度**：拆出的子块是否继续下钻，而不是本层展开多少个）：":
      "Refine step by step (「细化」 means DEPTH — whether the blocks you split out keep getting refined, not how many children one layer has):",
    "· 本次为深度细化：规划与创建都必须覆盖多层，一路下钻到无法进一步细化为止（一般 devKind=file；文件还可继续拆类 / 接口 / 枚举，拆不动就停），不得只规划一层就收工。":
      "· This round is a deep refinement: both the plan and the creation must span several layers, drilling down until nothing more can be split (usually devKind=file; a file can still split into class / interface / enum — stop when it cannot), never just one planned layer.",
    "· 本次为只展开本层：仅在本块内创建 1 层子块，不做下钻；每个子块各自还需不需要继续细化，请在梗概里说明，之后由用户到该子块上分别点「细化」。":
      "· This round expands this layer only: create one single layer of child blocks inside this block and do not drill down; state in the outline whether each child still needs refining, so the user can click Refine on it later.",
    "0. 先按深度判断该不该细化：本块是否还能继续下钻、已经下钻到哪一层（见上方「当前子树深度」）。若本元素已无下层结构、或项目根目录内找不到可对应的真实内容，请直接告诉用户「无需 / 无法继续细化」并说明原因（如已细化到无法再细、无对应真实代码），不要创建任何节点。":
      "0. First judge by DEPTH whether refining makes sense: can this block still drill down, and how deep has it already gone (see “Current subtree depth” above). If the element has no lower structure, or the project root holds nothing matching it, tell the user directly that refining is unnecessary / impossible and explain why (already refined to the bottom, no matching real code) — create no nodes.",
    "1. 基于项目根目录内的真实代码/文件，规划本块之下的**整棵结构**：元素层级为 模块 → 文件 → 类 / 接口 / 枚举。深度细化时每一片叶子都要自问「还能不能再拆」：模块拆到真实文件、文件拆到类 / 接口 / 枚举，确实拆不动了才算到底；只展开本层时只需规划紧接下一层。":
      "1. From the real code/files under the project root, plan the WHOLE structure below this block; the element hierarchy is Module → File → Class / Interface / Enum. In deep mode every leaf must ask itself “can it still be split?”: modules down to real files, files down to class / interface / enum — only when nothing can split is it finished. When expanding this layer only, plan just the next layer.",
    "2. 先输出**多层规划树**（缩进表示层级，同层按创建顺序排列）：每个拟建子块标注【名称 · 类型（模块 / 文件 / 类 / 接口 / 枚举）· 是否还需继续下钻（是 / 否 + 一句理由）· 【功能】拟稿（≤80字，面向非技术的说明）· 【实现】拟稿（≤120字，工程实现梗概）· 将用颜色】，供用户审阅；深度模式下叶子应全部落在文件 / 类级，若因证据不足中途停在某个模块块上，请在该节点标注「待续下钻」并在结尾说明。":
      "2. First output a MULTI-LAYER PLAN TREE (indent = level, siblings in creation order): annotate every planned child with [name · type (module / file / class / interface / enum) · still needs drill-down (yes / no + one reason) · 【功能】 draft (≤80 chars, non-technical) · 【实现】 draft (≤120 chars, implementation outline) · planned colour] for the user to review; in deep mode all leaves should land at file / class level — if evidence runs out and you stop at some module block, mark it “drill-down pending” and say so at the end.",
    "3. 一次确认覆盖整棵规划树：明确询问用户是否按这棵树创建（不是逐层反复追问）；在用户确认之前，禁止修改画布。":
      "3. ONE confirmation covers the entire plan tree: ask explicitly whether to create it as planned (do not re-ask layer by layer); never modify the canvas before the user confirms.",
    "4. 用户确认后，自顶向下**逐层创建**：每层各一次 mtnode_canvas_edit —— 该层子块的 kind=super、dev=true、devKind=module|file|class|interface|enum、parentSuperId 指向它的直接父块（第一层的父块 = 本节点，更深层的父块 = 上一层刚创建的块，可用同一批 create 里的 alias 引用），note 必须按两段式规范书写（【功能】非技术说明 + 【实现】工程梗概，与该子块拟稿一致，禁止只写一段）；每个新建的模块块都要顺手带上 devFiles（本模块的核心文件 · 最多 10 条 · 每项是相对项目根 devPath 的路径，如 renderer/app-devnode.js；文件 / 类 / 接口 / 枚举块可留空，最外层项目节点一律不填），别留给以后补。禁止把不同层级一次性平铺到同一层。":
      "4. After confirmation, create TOP-DOWN ONE LAYER AT A TIME: one mtnode_canvas_edit per layer — each child of that layer uses kind=super, dev=true, devKind=module|file|class|interface|enum and a parentSuperId pointing at its DIRECT parent (layer 1's parent = this node, deeper layers' parent = the block just created above, referenced by the alias from the same create batch); its note must follow the two-section spec (【功能】 non-technical description + 【实现】 implementation outline, matching that child's draft — never a single section). Every module block you create must also carry its devFiles right away (that module's core files · up to 10 · each a path relative to the project root devPath, e.g. renderer/app-devnode.js; file / class / interface / enum blocks may leave it empty, and the outermost project block never carries it) — do not defer it to later. Never flatten several levels into one layer.",
    "5. 护栏：单层子块过多（约 >12 个）时分批创建，并在规划树里标出本批未建的部分；本次新建节点总数以约 60 个为上限，触顶或项目内证据不足时立即停下，报告已建到哪一层、还剩哪些分支未展开，并询问用户是否继续下钻（也可让用户在剩余分支的块上各自点「细化」）。":
      "5. Guard rails: if one layer has too many children (roughly more than 12), create them in batches and mark what this batch skipped in the plan tree; cap this round at about 60 new nodes — when you hit the cap or the project evidence runs out, stop immediately, report how deep you got and which branches remain, and ask the user whether to keep drilling down (they can also click Refine on the remaining branches).",
    "6. 落定后回写各父块概述：本节点与本次新建的每个中间层块，都要在 note 第二段「【实现】工程梗概」末尾补一行「子块：A / B / C」（列直接子块名，保持两段式规范，别把整棵子树塞进去）；第一段【功能】仅在职责变化时调整。":
      "6. Afterwards rewrite each parent block's overview: this node and every middle-layer block you created must append a “子块：A / B / C” line at the end of the second 【实现】 section (direct children only, keep the two-section shape — never dump the whole subtree); adjust the first 【功能】 section only if responsibilities changed.",
    "7. 结尾报告最终结果：本次新增到第几层、共多少块、叶子元素类型分布（如：新增 3 层 · 18 块，叶子 = 14 文件 + 4 类），以及还有哪些块标注了「待续下钻」。":
      "7. Close with the final result: how many new layers deep, how many blocks in total, the leaf element-type mix (e.g. +3 layers · 18 blocks, leaves = 14 files + 4 classes), and which blocks are still marked “drill-down pending”.",
    "8. 元素类型与配色请保持准确：模块按功能色卡归类（core 核心运行时 #6db4ff · canvas 画布与交互 #45cfe6 · ai AI 与 Agent #c792ea · data 数据与存储 #4dd0c4 · media 媒体与本地后端 #ff8fa3 · plugin 插件与生态 #f0c14d · build 构建与诊断 #ff9d5c · test 测试与质量 #a8e05f；新建 module 块系统会自动套用，归类不对时再补丁纠正，禁止自创色值），文件 / 类 / 接口 / 枚举 不传 devColor（保留类型默认色 蓝 / 橙 / 紫 / 粉）。":
      "8. Keep element types and colours accurate: colour modules by the function palette (core 核心运行时 #6db4ff · canvas 画布与交互 #45cfe6 · ai AI 与 Agent #c792ea · data 数据与存储 #4dd0c4 · media 媒体与本地后端 #ff8fa3 · plugin 插件与生态 #f0c14d · build 构建与诊断 #ff9d5c · test 测试与质量 #a8e05f; new module blocks get it automatically — patch only when the category is wrong, never invent hex values), and pass no devColor for file / class / interface / enum (they keep their element-type defaults: blue / orange / purple / pink).",
    "9. 元素之间的关系用关系线表达（connect 项加 rel:true，可带 relLabel 文字与 relArrow 箭头，关系线不传数据）；文件节点的标题用相对项目根的路径（如 renderer/app.js，便于「打开」按钮定位源码）。":
      "9. Express relations between elements with relationship wires (connect entries with rel:true, optional relLabel text and relArrow arrows; relation lines carry no data); title file nodes with a path relative to the project root (e.g. renderer/app.js, so the Open button can locate the source).",
    "开发 · ": "Dev · ",
    "【开发任务书】": "[Dev brief]",
    "未命名模块": "Untitled module",
    "模块概述：": "Module overview: ",
    "模块功能（面向非技术）：": "Module role (non-technical): ",
    "实现要点（面向技术）：": "Implementation notes (technical): ",
    "本次开发需求：": "This round's requirements: ",
    "（暂无）": "(none)",
    "（暂无 · 请先说明该模块在业务上做什么、给谁用）":
      "(none yet · state in plain business terms what this module does and who it serves)",
    "（暂无 · 细化或开发时按两段式规范补全）":
      "(none yet · fill it in per the two-section spec during refine or development)",
    "（暂无 · 该块在业务上做什么、给谁用还没写清楚）":
      "(none yet · what this block does and who it serves is not stated)",
    "（暂无 · 实现方案梗概待补）": "(none yet · implementation outline pending)",
    "对照该块概述的【实现】段判断真实完成度：哪些职责已落地、哪些缺失或是半成品（TODO / 空实现 / 未接线的调用 / 缺错误处理 / 无测试）；再用【功能】段核对职责是否偏离。":
      "Check the 【实现】 section to judge real completion: which responsibilities landed, which are missing or half-done (TODO / empty implementations / unwired calls / missing error handling / no tests); then use the 【功能】 section to verify responsibilities have not drifted.",
    "（暂无概述 · 请先补充该模块在项目中的作用）":
      "(no overview yet · describe this module's role in the project first)",
    "项目根目录：": "Project root: ",
    "所属上层模块：": "Parent module: ",
    "请在本项目内实现/完善该模块；完成后请更新画布上该开发节点的概述与状态（devStatus）。":
      "Implement/refine this module within the project; when done, update this dev node's overview and status (devStatus) on the canvas.",
    "本会话由该功能块的「开发 / 细化」对话框新建，只负责该模块；请以项目根目录内的真实代码为准，不要臆测。":
      "This session was created by the module block's Dev / Refine dialog and covers only this module; rely on the real code under the project root — never guess.",
    "项目根目录若有 AGENTS.md（Agent 共识文件），请先读并遵守其中的「目录约定」与「不要修改」清单；新文件按约定放置，清单内路径一律不要改动。":
      "If an AGENTS.md (agent consensus file) exists at the project root, read it first and follow its directory conventions and do-not-modify list; place new files per the conventions and never touch listed paths.",
    "10. 若项目根目录存在 AGENTS.md（Agent 共识文件），先读并遵守：文件节点的路径与新建内容都要符合「目录约定」，不要触碰「不要修改」清单里的路径。":
      "10. If an AGENTS.md (agent consensus file) exists at the project root, read it first and follow it: file-node paths and any new content must match the directory conventions; never touch paths on the do-not-modify list.",
    "11. 本会话按本任务书的步骤执行即可：不要调用 mtnode-dev-architect 技能（该技能仅用于在 MTNode 画布上从零构建开发节点架构，细化任务书已内置全部规则）。":
      "11. Just follow the steps of this brief: do not invoke the mtnode-dev-architect skill (it only builds dev-node architectures from scratch on the MTNode canvas — this refinement brief already contains every rule).",
    "完成后请更新画布上该开发节点的概述（note）与状态（devStatus），并用一句话向用户汇报改了什么。":
      "When done, update this dev node's overview (note) and status (devStatus) on the canvas, and report in one sentence what changed.",
    /* ===== 开发 / 细化对话框 ===== */
    "概述": "Overview",
    "说明": "Notes",
    "请先填写内容": "Please fill in the content first",
    "开发状态": "Dev status",
    "项目根目录": "Project root",
    "下层元素": "Lower elements",
    "（无 · 可点「细化」展开）": "(none · click Refine to expand)",
    "最近一次要求": "Last request",
    "个": "items",
    "请说明本次要开发或迭代的内容；确认后将新建一个绑定该模块的开发会话并在其中运行。":
      "Describe what to build or iterate this round; confirming opens a new dev session bound to this module and runs it there.",
    "尚未设置项目根目录（devPath）：会话工作区将退回默认目录，建议在顶层功能块上先设置项目路径。":
      "No project root (devPath) set yet: the session workspace falls back to the default folder — set the project path on the top-level module block first.",
    "尚未设置项目根目录（devPath）：Agent 无法依据项目真实代码判断可展开的下层内容，建议先在顶层功能块上设置。":
      "No project root (devPath) set yet: the agent cannot judge expandable content from the real code — set it on the top-level module block first.",
    "本次希望开发 / 迭代的内容": "What to develop / iterate this round",
    "例如：补该模块的错误处理与日志；按现有风格新增 XX 接口；重构某文件但不改变对外 API…":
      "e.g. add error handling and logging to this module; add an XX API in the existing style; refactor a file without changing its public API…",
    "请填写本次希望开发或迭代的内容": "Please describe what to develop or iterate this round",
    "开发前需求确认（可选）": "Pre-development requirement check (optional)",
    "先拷问需求（grill-me）": "Grill me on the requirements first (grill-me)",
    "确认 = 新会话后台运行（工作区 = 项目根目录 · 标题「开发 · 模块名」· 状态转为进行中 · 不离开画布）· 取消 / 跳出不清空：再次打开本框接着上次写 · 下方「先拷问需求」开关留在该功能块上（下次打开仍在）· Ctrl+Enter 提交 · Esc 取消":
      "Confirm = runs in the background in a new session (workspace = project root · titled Dev · module name · status becomes in progress · you stay on the canvas) · cancelling or stepping away keeps this text — reopen the box and continue where you left off · the “grill me first” switch below stays on this module block (still there next time you open it) · Ctrl+Enter submits · Esc cancels",
    "开启 = 本次开发会话先用内置技能 mtnode-grill-me 按轮问清需求，达成共识并经你确认后才动手。":
      "On = this dev session first uses the built-in skill mtnode-grill-me to interrogate the requirements round by round, and only starts work once you confirm the shared understanding.",
    "【拷问模式·本轮先问不做】该功能块已开启「先拷问需求」：请先用 skill 工具加载内置技能 mtnode-grill-me 并严格照它执行——把本次需求映射成决策树，每轮用 ask_user_question 工具跳出 MTNode 询问窗，一次把整个前沿的全部问题问完（题面写进 question、候选写进 options、推荐项放第一位并在 label 末尾标「（推荐）」、理由写 description）；禁止把问题编号列在回复正文里、让用户在输入框作答；需要事实就自己用只读工具去查、不要拿环境问题问用户；本轮不得修改任何文件、不得改画布、不得回写 note / devStatus / devFiles、不得出实施计划、不得开工，答案回来后据此重算前沿继续下一轮，直到前沿为空、并用最后一次询问窗得到用户明确「确认无歧义」后才开始实施，实施收尾再按本任务书回写概述（note）、状态（devStatus）与本模块核心文件列表（devFiles）。":
      "【Grill mode · ask this round, build nothing】This module block has “grill me first” switched on: load the built-in skill mtnode-grill-me with the skill tool and follow it strictly — map this request into a decision tree, and each round call the ask_user_question tool so MTNode pops its question dialog, putting that round's whole frontier in a single call (question text in question, candidates in options, your recommended option first with “（推荐）/ (recommended)” appended to its label, the reason in description); never list numbered questions in the reply body and make the user type answers into the input box. Look facts up yourself with read-only tools instead of asking the user about the environment. This round you must not modify any file, touch the canvas, write back note / devStatus / devFiles, produce an implementation plan or start work; recompute the frontier from each answer and continue round by round until it is empty, then use one final question dialog to get the user's explicit “no ambiguity — go ahead” before implementing, and at the end write back the overview (note), status (devStatus) and this module's core file list (devFiles) as this task brief requires.",
    "开始开发": "Start developing",
    /* 对话框草稿：取消 / 跳出后再次打开，上次没提交的内容仍在（node.devDraft） */
    "已恢复上次未提交的内容": "Your unsent text from last time was restored",
    "清空草稿": "Clear draft",
    "丢弃上次未提交的内容，重新填写": "Discard the unsent text and start fresh",
    "开发会话启动失败：": "Failed to start the dev session: ",
    "细化会话启动失败：": "Failed to start the refinement session: ",
    "已创建开发会话「": "Dev session created: ",
    "已创建细化会话「": "Refine session created: ",
    "」并在后台运行（留在画布 · 左下角队列 / 会话列表可看进度）":
      " — running in the background (you stay on the canvas · watch progress in the bottom-left queue / session list)",
    "点击填写本次开发内容（弹窗确认后在新会话中运行 · 工作区 = 项目根目录）":
      "Click to describe this round's work (a dialog confirms, then it runs in a new session · workspace = project root)",
    "开发（填写本次开发内容…）": "Develop (describe this round's work…)",
    "回到该模块最近一次的开发 / 细化会话（不新建会话）":
      "Return to this module's most recent dev / refinement session (no new session)",
    "回到最近一次会话（共 ": "Return to the last session (",
    " 个）": " total)",
    "该功能块还没有开发会话": "This module block has no dev session yet",
    " 个）：": "): ",
    "待开发 ": "pending ",
    "进行中 ": "in progress ",
    "已完成 ": "done ",
    "模块概述": "Module overview",
    "智能能力不可用": "The agent capability is unavailable",
    "请按以下步骤工作：": "Work through these steps:",
    "现在开始只读调研；完成后只输出那个 JSON 对象。":
      "Start the read-only investigation now; when finished output only that JSON object.",
    "【建议任务】请依据项目真实代码与该模块的开发进度，评估这个功能块下一步应该实现哪些内容。":
      "[Suggestion task] Based on the real project code and this module's development progress, assess what this module block should implement next.",
    "摸清现状：目录结构、依赖清单、入口与构建 / 测试脚本，以及与本模块职责直接相关的源码文件（用 glob / grep 定向取证，不要全量读源码）。":
      "1. Get the lay of the land: folder structure, dependency manifests, entry points and build/test scripts, plus the source files directly tied to this module's role (use glob / grep for targeted evidence — never read the whole codebase).",
    "对照「模块概述」判断真实完成度：哪些职责已落地、哪些缺失或是半成品（TODO / 空实现 / 未接线的调用 / 缺错误处理 / 无测试）。":
      "2. Judge the real completion level against the module overview: which responsibilities already exist, which are missing or half-done (TODO / empty stubs / unwired calls / no error handling / untested).",
    "给出恰好 4 条下一步方案：具体到能直接开工（写明要改 / 新增的文件与接口），彼此独立可组合，并尽量覆盖不同层面（功能补全 / 健壮性与测试 / 与相邻模块接线 / 重构与文档）。":
      "3. Give exactly 4 next-step options: concrete enough to start immediately (name the files and APIs to touch), independent and combinable, and spread across layers (feature completion / robustness and tests / wiring with neighbouring modules / refactoring and docs).",
    "若本模块其实已经完备，不要硬凑新功能：改为给出「下一步该做什么」（如按深度继续细化——把子块逐层下钻到文件 / 类级、集成验证、性能与边界、补概述与文档），并在 summary 里说明现状。":
      "4. If the module is actually complete, do not invent features: say what should happen next instead (deepen the refinement — drill the child blocks down layer by layer to file / class level, integration checks, performance and edge cases, overview and docs) and explain the current state in summary.",
    "若用户指定了关注点，优先围绕它给方案；但发现更要紧的问题也要占一条，并在 desc 里说明理由。":
      "5. When the user set a focus, centre the options on it; but if you find something more urgent, still spend one option on it and explain why in desc.",
    "若项目根目录存在 AGENTS.md（Agent 共识文件），先读并遵守：新文件按「目录约定」放置；「不要修改」清单内的路径一律不得建议改动。":
      "6. If an AGENTS.md (agent consensus file) exists at the project root, read it first and obey it: place new files per the directory conventions; never propose touching paths on the do-not-modify list.",
    "共识：若项目根目录有 AGENTS.md，先读并遵守（目录约定 / 不要修改清单），新文件按约定放置。":
      "Consensus: if an AGENTS.md exists at the project root, read it first and follow it (directory conventions / do-not-modify list); place new files accordingly.",
    "给出恰好 ": "give exactly ",
    " 条下一步方案：具体到能直接开工（写明要改 / 新增的文件与接口），彼此独立可组合，并尽量覆盖不同层面（功能补全 / 健壮性与测试 / 与相邻模块接线 / 重构与文档）。":
      " next-step options: concrete enough to start immediately (name the files and APIs to touch), independent and combinable, spread across layers (features / robustness and tests / wiring / docs).",
    "（无）": "(none)",
    /* ===== 开发节点「建议」（AI 评估下一步 → 多选 → 就地开发） ===== */
    "建议": "Suggest",
    "这是上一次生成的方案（未重新调用模型）。想听新的评估：取消后点「建议」→「确认生成建议」，或用下面的「换一批」。数字键勾选 · Ctrl+Enter 开发 · Esc 取消":
      "These are the previous suggestions (no model call). For a fresh assessment press Another batch below, or cancel and confirm again. Number keys toggle · Ctrl+Enter develops · Esc cancels",
    "生成建议": "Generating suggestions",
    "建议生成失败": "Suggestion run failed",
    "建议（上次结果）": "Suggestions (last run)",
    "查看上次建议": "Show last suggestions",
    "确认生成建议": "Confirm · generate suggestions",
    "【AI 建议评估】": "[AI suggestion assessment]",
    "【本轮采纳】": "[Adopted this round]",
    "节点颜色：点击展开 HSV 色板，手动修改外框与呼吸灯颜色":
      "Node color: open the HSV picker to change the frame and glow color",
    "节点颜色": "Node color",
    "恢复元素类型默认色": "Restore element-type default color",
    "无效的 Hex 颜色（示例：#6FE3A5）": "Invalid hex color (e.g. #6FE3A5)",
    /* ===== 开发节点色板「功能色卡」快捷行（分类英文名须与 DEV_FUNC_COLORS.en 一致） ===== */
    "功能色卡": "Function palette",
    "按功能上色": "by function",
    "核心运行时": "Core runtime",
    "画布与交互": "Canvas & interaction",
    "AI 与 Agent": "AI & agents",
    "数据与存储": "Data & storage",
    "媒体与本地后端": "Media & local backends",
    "插件与生态": "Plugins & ecosystem",
    "构建与诊断": "Build & diagnostics",
    "测试与质量": "Tests & quality",
    /* ===== 开发节点 Agent 模型（本功能块 + 未自行选择的子功能块共用） ===== */
    "Agent 模型": "Agent model",
    "Agent 模型：": "Agent model: ",
    "自动": "Auto",
    "自动（跟随默认）": "Auto (follow default)",
    "本轮：": "This round: ",
    "」）": ")",
    "」）· 点击为本功能块单独选择":
      ") · click to give this block its own pick",
    " · 点击修改（未自行选择的子功能块会继承）":
      " · click to change (child blocks without their own pick inherit it)",
    "未选择：本功能块与子功能块的「建议 / 开发 / 细化」跟随默认模型。":
      "Not set: this block and its child blocks follow the default model for Suggest / Develop / Refine.",
    "；在此单独选择后，本功能块及其子树改用它。":
      "; pick one here to switch this block and its whole subtree to it.",
    "本功能块已选择：": "This block uses: ",
    "；其下未自行选择的子功能块一并使用它。":
      "; every child block without its own pick uses it too.",
    "Agent 模型：自动（跟随默认）· 点击选择；选定后本功能块与未自行选择的子功能块都会用它":
      "Agent model: auto (follows the default) · click to choose; this block and every child block without its own pick will use it",
    "跟随默认（不指定）": "Follow default (unset)",
    "暂无可用模型：请先在 设置 → 模型服务 中添加服务商与模型。":
      "No models available yet: add a provider and its models in Settings → Model services first.",
    "换一批": "Another batch",
    "再试一次": "Try again",
    "停止生成": "Stop generating",
    "上次建议": "Last suggestions",
    "本轮关注点": "This round's focus",
    "进度": "Progress",
    "优先": "Priority",
    "常规": "Normal",
    "可延后": "Can wait",
    "刚刚": "just now",
    " 分钟前": " min ago",
    " 小时前": " h ago",
    " 次只读工具调用": " read-only tool calls",
    "（未设置 · 用默认工作区）": "(not set · default workspace)",
    "下一步方案（可多选 · 数字键 1-": "Next-step options (multi-select · keys 1-",
    " 快速勾选）": " toggle)",
    "补充说明（可选 · 会一起交给开发会话）": "Supplement (optional · sent along to the dev session)",
    "AI 评估": "AI assessment",
    "依据（AI 真实读到的代码）": "Evidence (real code the AI read)",
    " 条建议 · ": " suggestions · ",
    " 条方案，本轮要实现：": " options to build this round:",
    "用户已勾选 ": "The user picked ",
    "用户未采纳 AI 提议的方案，按下述补充要求开发：":
      "The user did not adopt the AI options — develop per the supplement below:",
    "本轮明确不做：": "Explicitly out of scope this round: ",
    "（除非实施中发现它是所选项的必要前提，此时先说明理由）":
      "(unless implementing shows it is a prerequisite of a picked option — then explain first)",
    "用户补充：": "User supplement: ",
    "AI 评估：": "AI assessment: ",
    "【按「建议」确认的方案开发】": "[Develop the confirmed suggestions]",
    "目标功能块：": "Target module block: ",
    "（暂无概述 · 该块职责还没写清楚）": "(no overview · this block's role is not written down yet)",
    "（未设置 · 请以会话工作区为项目根）": "(not set · treat the session workspace as the project root)",
    "所属上层链路：": "Ancestor chain:",
    "同层兄弟块（共 ": "Sibling blocks (",
    " 个，本块不在内）：": " total, this one excluded): ",
    "本块已有下层元素（共 ": "Lower elements in this block (",
    "（无 · 尚未细化到文件 / 类）": "(none · not refined into files / classes yet)",
    "画布上的开发进度总览（* 为本块）：": "Dev progress on canvas (* = this block):",
    "本块的历史开发会话：": "Dev sessions of this block:",
    " 个功能块：已完成 ": " module blocks: done ",
    " · 进行中 ": " · in progress ",
    " · 待开发 ": " · pending ",
    "顶层功能块：": "Module tree (* = this block):",
    "其余 ": "the rest ",
    " 个功能块未列出": " module blocks not listed",
    "最近一次会话": "Latest session",
    "更早会话": "Earlier session",
    "要求：": "Asked: ",
    "汇报：": "Reported: ",
    "（另有 ": "(plus ",
    " 个更早会话未列出）": " older sessions not listed)",
    "（该功能块还没有开发 / 细化会话 · 说明还没真正动过手）":
      "(this block has no dev / refine session yet · it has never really been worked on)",
    "上一次 AI 建议（请依据最新现状重评，不要照抄）：":
      "Previous AI suggestions (re-assess against the latest state, do not copy):",
    "用户本轮指定的关注点：": "Focus the user asked for this round: ",
    "已采纳 ": "adopted ",
    " 个": " items",
    "确认后：AI 先只读调研项目里的真实代码与该模块的开发进度（不改文件、不动画布），再给出 4 条「下一步实现什么」的方案。你可以在同一个对话框里多选、补充，然后点该对话框里的「开发」直接开工。":
      "After you confirm: the AI first reads the real code and this module's progress read-only (no file or canvas changes), then returns 4 next-step options. You can multi-select, add your own notes, and press Develop in the same dialog to start work.",
    "尚未设置项目根目录（devPath）：AI 只能在默认工作区里找代码，建议先在顶层功能块上设置项目路径。":
      "No project root (devPath) set: the AI can only search the default workspace — set the project path on the top-level block first.",
    "本轮关注点（可选 · 留空由 AI 自行判断）": "Focus for this round (optional · leave empty to let the AI judge)",
    "例如：这轮只看健壮性和测试；优先把与「网络层」的接线补上；不要引入新依赖…":
      "e.g. this round only robustness and tests; wire up the network layer first; no new dependencies…",
    "确认 = 只读评估（工作区 = 项目根目录）· 生成后可多选 / 换一批 · 取消 / 跳出不清空：再次打开本框接着上次写 · Ctrl+Enter 确认 · Esc 取消":
      "Confirm = read-only assessment (workspace = project root) · afterwards you can multi-select or take another batch · cancelling or stepping away keeps this text — reopen the box and continue where you left off · Ctrl+Enter confirms · Esc cancels",
    "建议：弹窗确认后由 AI 只读调研项目代码与该模块进度，给出 4 条下一步方案（可多选 + 补充，选完点同一对话框里的「开发」即开工）":
      "Suggest: after a confirmation dialog the AI reads the project code and this module's progress (read-only) and returns 4 next-step options — multi-select, add notes, then press Develop in the same dialog to start.",
    "已有上次建议，可直接查看": "Last suggestions available — you can just review them",
    "AI 正在阅读项目代码，评估这个功能块下一步该实现什么。整个过程只读，期间你可以照常操作其它节点。":
      "The AI is reading the project code to decide what this block should implement next. The whole run is read-only — keep working on other nodes meanwhile.",
    "开始只读调研（不改文件、不改画布）· 项目根：":
      "Starting read-only investigation (no file / canvas changes) · project root: ",
    "至少勾选一个方案，或在「补充说明」里写下你要做什么。":
      "Pick at least one option, or write what you want in the supplement box.",
    "模型没有按契约返回方案。可以再试一次，或关掉本框改用「开发」按钮自己填写内容。":
      "The model did not return options in the agreed format. Try again, or close this dialog and fill in the Develop box yourself.",
    "点「开发」= 用当前勾选的方案 + 补充说明，新建该模块的开发会话并直接开工（与「开发」按钮同一条路径，只是内容已替你写好）· 数字键勾选 · Ctrl+Enter 开发 · Esc 取消":
      "Develop = start a new dev session for this module with the picked options plus your supplement (same path as the Develop button, only the content is already written) · number keys toggle · Ctrl+Enter develops · Esc cancels",
    "这是上一次生成的方案（未重新调用模型）。想听新的评估：点「换一批」重新让 AI 判断，或取消后在确认框里选「确认生成建议」。数字键勾选 · Ctrl+Enter 开发 · Esc 取消":
      "These are the previous suggestions (no model call). For a fresh assessment press Another batch, or cancel and choose Confirm · generate suggestions. Number keys toggle · Ctrl+Enter develops · Esc cancels",
    "例如：第 2 条顺便把超时改成可配置；先做最小可运行版本；不要改对外 API…":
      "e.g. option 2 should also make the timeout configurable; ship a minimal runnable version first; do not change the public API…",
    "重新让 AI 评估一轮（覆盖当前方案）": "Let the AI re-assess (replaces the current options)",
    "用当前勾选的方案与补充内容开始开发": "Start developing with the picked options and your supplement",
    "建议（让 AI 评估下一步该实现什么…）": "Suggest (let the AI decide what to build next…)",
    "实施要求：以项目根目录内的真实代码为准；上述方案若与现状冲突，先说清取舍再动手；每完成一项做一次可验证检查（构建 / 运行 / 测试 / 只读命令）。":
      "Implementation rules: follow the real code under the project root; if an option conflicts with reality, explain the trade-off before editing; verify each finished item (build / run / test / read-only command).",
    "完成后更新画布上该开发节点的概述（note）与状态（devStatus），并用一句话汇报改了什么。":
      "When done, update this dev node's overview (note) and status (devStatus) on the canvas and report in one sentence what changed.",
    "本会话是「开发」绑定会话（不读也不改画布）：执行期间与收尾都不得修改画布上任何内容 —— 不改该功能块节点的 title / note / devStatus / devFiles，也不动其它节点或连线；任务完成后在会话里用一句话汇报改了什么。":
      "This session is a dev-bound session (it neither reads nor edits the canvas): during execution or when finishing it must not modify anything on the canvas — it does not change this module block node's title / note / devStatus / devFiles, nor any other node or wire; when done, report in the session in one sentence what you changed.",
    "完成后按两段式规范（【功能】非技术说明 + 【实现】工程梗概）回写该开发节点的概述（note），并更新状态（devStatus），同时用 mtnode_canvas_edit 的 devFiles 补丁回写本模块的核心文件列表（最多 10 条 · 每项是相对项目根的文件路径 · 最外层项目节点不填），用一句话向用户汇报改了什么。":
      "When done, rewrite this dev node's overview (note) in the two-section spec (【功能】 non-technical description + 【实现】 implementation outline), update its status (devStatus), and also patch this module's core file list back through mtnode_canvas_edit's devFiles (up to 10 entries · each a path relative to the project root · the outermost project block stays empty), then report in one sentence what changed.",
    "本会话执行期间与收尾都不得修改画布上的任何节点：不改本功能块的 title / note，不动 devStatus / devFiles，也不改其它节点或画布内容，画布一律原样保留。唯一允许更新的是本会话自身在左侧栏的标题（随首轮主题自动命名）。任务完成后，用一句话向用户汇报改了什么。":
      "This session must NOT modify any node on the canvas during execution or when finishing: do not change this module block's title / note, do not touch its devStatus / devFiles, and do not alter any other node or canvas content — the canvas stays exactly as it is. The only thing allowed to update is this session's own title in the left sidebar (auto-named from the first-round topic). When done, report in one sentence what you changed.",
    /* ===== 建议调研：可离开 + 完成跳窗（后台作业 devSuggestJobs / sug 运行态） ===== */
    "「": "\"",
    "」的调研已完成，但该功能块已不在当前画布，结果未写入。":
      "\" — the research finished, but this block is no longer on the current canvas; the result was not saved.",
    "」的建议已就绪。检测到你在填写其它窗口，未自动弹出；点该块的「建议」即可查看。":
      "\" — suggestions are ready, but you were filling in another window, so it did not pop up automatically; click this block's \"Suggest\" to view them.",
    "AI 继续后台调研，完成后自动弹出。":
      "AI keeps researching in the background and will pop up when done.",
    "调研中·已转入后台，可点该块的「建议」查看进度。":
      "Research moved to the background — click this block's \"Suggest\" to view progress.",
    "关掉本框，调研继续在后台运行，完成后自动弹出":
      "Close this dialog; research continues in the background and will pop up when done",
    "显式取消这一轮调研（不再有结果；Esc 不会触发本操作）":
      "Explicitly cancel this research round (no result will be produced; Esc does not trigger this)",
    "已接回本轮调研：它仍在进行，未重复发起。":
      "Rejoined this research round: it is still running, not restarted.",
    "调研进度": "Research progress",
    "AI 只读调研进行中 · ": "AI read-only research in progress · ",
    "查看调研进度": "View research progress",
    "这个功能块已经有一轮只读调研在跑（同一块不会重复发起，以免两轮结果互相覆盖）。你可以直接离开去画布上继续操作，或点「查看调研进度」接回去看它读到哪一步；「本轮关注点」要改动得等这轮结束后再生成一轮。":
      "This module block already has a read-only research round running (the same block is never started twice, so two rounds cannot overwrite each other). You can leave and keep working on the canvas, or click \"View research progress\" to see how far it has read; changing \"This round's focus\" has to wait until this round finishes, then start a new round.",
    "⏳ AI 调研中 · 点此看进度":
      "⏳ AI researching · click here for progress",
    "💡 建议已就绪（未查看）": "💡 Suggestions ready (unviewed)",
    "点击打开调研进度：可「返回」继续后台跑，或「停止生成」":
      "Click to open research progress: \"Back\" keeps it running in the background, or \"Stop generating\"",
    "点击查看 AI 给出的方案清单（可多选 + 补充 + 就地开发）":
      "Click to view the AI's option list (multi-select + supplement + develop right away)",
    "状态": "Status",
    /* ===== 开发节点：文件节点「打开」 ===== */
    "打开该文件节点对应的源码文件（标题为相对项目根的路径 · 也支持绝对路径）":
      "Open the source file this file node maps to (title = path relative to the project root; absolute paths also work)",
    "无法定位文件：请先在顶层功能块设置项目根目录（devPath），并把文件节点标题改为相对路径（如 renderer/app.js）":
      "Cannot locate the file: set the project root (devPath) on a top-level block first, and give the file node a relative-path title (e.g. renderer/app.js)",
    "已打开：": "Opened: ",
    /* ===== 开发节点：核心文件列表（devFiles · 最多 10 个 · 项目节点不列举） ===== */
    "核心文件列表 devFiles 仅适用于开发节点":
      "devFiles (core file list) only applies to a dev node",
    "最外层（项目）开发节点不列举核心文件，已忽略 devFiles":
      "The outermost (project) dev node lists no core files — devFiles ignored",
    "devFiles 需是路径数组（每项一条相对项目根的路径）":
      "devFiles must be an array of paths (each one a path relative to the project root)",
    "devFiles 里没有可用的文件路径（已置空）":
      "No usable file path found in devFiles (the list was cleared)",
    "核心文件最多 {n} 个，多余部分已忽略":
      "A block lists at most {n} core files — the extra ones were dropped",
    /* ===== 开发节点：核心文件列表 UI（折叠卡「文件 N」按钮 + 展开面板） ===== */
    "核心文件": "Core files",
    "不存在": "missing",
    "已确认": "confirmed",
    "当前来源": "Current source",
    "自动收集": "Auto-collect",
    "手动 / 会话回写": "Manual / written back by a session",
    "自动收集（尚未确认）": "Auto-collected (not confirmed yet)",
    "自动收集 · 点「编辑」确认": "auto-collected · click “Edit” to confirm",
    "打开项目根": "Open project root",
    "编辑核心文件列表": "Edit core file list",
    "已保存核心文件列表：": "Core file list saved: ",
    "无法定位该文件": "Cannot locate this file",
    "核心文件列表：本功能块最关键的源码文件（点开成列表 · 点任意一行在资源管理器中定位该文件）":
      "Core file list: the source files this module block depends on most (click to expand · click a row to reveal the file in the file manager)",
    "核心文件（每行一个路径）": "Core files (one path per line)",
    "最多 {n} 个 · 相对项目根或绝对路径都可":
      "Up to {n} entries · relative to the project root, or absolute paths",
    "「自动收集 / 清空」只改输入框，点「确定」才写入":
      "“Auto-collect / Clear all” only edits the box above — the list is written when you click “OK”",
    "未设置项目根目录：列表仍可保存，但要设置 devPath 才能定位文件":
      "No project root set: the list can still be saved, but you need a devPath to locate the files",
    "本功能块最关键的源码文件（最多 {n} 个 · 相对项目根 · 由开发 / 细化会话回写或手工编辑，为空时自动收集）":
      "The source files this module block depends on most (up to {n} · paths relative to the project root · written back by a dev / refine session or edited by hand; auto-collected when empty)",
    "编辑本功能块的核心文件（每行一个路径 · 可自动收集 / 清空 · 确认后写入节点）":
      "Edit this block's core files (one path per line · auto-collect / clear available · written to the node after you confirm)",
    "用系统默认方式打开本功能块所属项目的根目录（devPath）":
      "Open this block's project root folder (devPath) with the system default handler",
    "暂无核心文件：点「编辑」逐行填写，或在开发 / 细化会话里回写 devFiles":
      "No core files yet: click “Edit” and enter one path per line, or let a dev / refine session write back devFiles",
    "无法定位该文件：请先在顶层功能块设置项目根目录（devPath），核心文件才能解析成绝对路径":
      "Cannot locate this file: set the project root (devPath) on the top-level block first, so core files resolve to absolute paths",
    "尚未设置项目根目录（devPath）：请先在顶层功能块设置项目路径":
      "No project root (devPath) yet: set the project path on the top-level block first",
    "最外层（项目）开发节点不列举核心文件":
      "The outermost (project) dev node lists no core files",
    /* ===== 开发节点：最外层块的「设置项目文件夹」（devPath）===== */
    "设置项目文件夹": "Set project folder",
    "设置项目文件夹…": "Set project folder…",
    "设置项目文件夹（本功能块的项目根 devPath）":
      "Set the project folder (this block's project root, devPath)",
    "项目文件夹（绝对路径）": "Project folder (absolute path)",
    "选择项目文件夹": "Choose project folder",
    "选择文件夹…": "Choose folder…",
    "弹出系统文件夹窗口，选中后填入":
      "Open the system folder picker and fill in the chosen path",
    "项目文件夹 = 本功能块的项目根（devPath）：开发 / 细化会话的代码搜索、核心文件列表与文件节点都相对它解析，内部子块就近继承，不必重复设置。":
      "The project folder is this block's project root (devPath): dev / refine sessions search code, core-file lists and file nodes relative to it. Nested blocks inherit it from the nearest ancestor — no need to set it again.",
    "项目文件夹只能设在最外层开发节点上":
      "The project folder can only be set on the outermost dev node",
    "项目文件夹已设为：": "Project folder set to: ",
    "已清除项目文件夹": "Project folder cleared",
    "项目文件夹：": "Project folder: ",
    /* ===== 开发节点：运行中徽标 / 呼吸灯边框 ===== */
    "本功能块正在运行（作为超级节点被执行）":
      "This module is running (executed as a super node)",
    "功能块内有节点正在运行（含子开发节点）":
      "A node inside this module is running (including nested dev nodes)",
    "绑定的开发 / 细化会话正在运行":
      "A bound dev / refine session is running",
    /* ===== 开发节点：左下角运行队列（处理节点同款展示） ===== */
    "自身运行中": "This block itself is running",
    "子节点运行中": "Child nodes are running",
    "绑定会话运行中": "A bound dev / refine session is running",
    "用户输入": "User input",
    "已停止该功能块的运行任务": "Stopped this module block's running tasks",
    "该功能块已无运行任务": "This module block has no running tasks",
    "建议调研中": "Suggest research running",
    " 次只读调用": " read-only calls",
    "已停止该功能块的建议调研": "Stopped this module block's suggestion research",
    "该功能块已无建议调研": "This module block has no suggestion research running",
    /* ===== 开发节点：问询（AI 只读回答模块问题 · 卡片按钮已移除，对话框保留） ===== */
    "问询": "Ask",
    "问询中": "Ask running",
    "已停止该功能块的调研（建议 / 问询）":
      "Stopped this module block's research (suggest / ask)",
    "该功能块已无建议或问询调研":
      "This module block has no suggest or ask research running",
    "AI 正在只读调研项目代码，回答这个功能块的问题。整个过程只读，期间你可以照常操作其它节点。":
      "The AI is reading the project code to answer your question about this module. The whole run is read-only — keep working on other nodes meanwhile.",
    "（空回答）": "(empty answer)",
    "本次问询只读完成：未改动任何文件与画布。回答已记录到会话「":
      "This ask finished read-only: no files or canvas were changed. The answer is saved to the session “",
    "」，可随时在会话列表查看。想接着实现 / 修改？点该功能块的「开发」按钮正式开工。":
      "” — revisit it anytime in the session list. To implement or modify next, click this module's \"Dev\" button to start work.",
    "问询失败": "Ask failed",
    "可以重试同一问题，或改一改再问。":
      "You can retry the same question, or rephrase it.",
    "返回后台": "Back to background",
    "只隐藏对话框，问询继续在后台跑，完成后自动弹出":
      "Only hides the dialog; the ask keeps running in the background and pops up when done",
    "取消本轮问询": "Cancel this ask round",
    "重试": "Retry",
    "【问询任务】请依据项目真实代码与该模块的开发进度，只读地回答下面的问题。":
      "[Ask task] Answer the following question read-only, based on the real project code and this module's progress.",
    "用户的问题：": "User's question: ",
    "请只读调研后直接给出回答；不要执行任何写入动作。":
      "Investigate read-only and then answer directly; do not perform any write actions.",
    "确认后：AI 先只读调研项目里的真实代码与该模块的开发进度（不改文件、不动画布），然后直接回答你的问题。你可以随时离开去画布上继续操作，回答完成后自动弹出。":
      "After you confirm: the AI first reads the real code and this module's progress read-only (no file or canvas changes), then answers your question directly. You can leave and keep working on the canvas; the answer pops up when ready.",
    "你要问的问题": "Your question",
    "例如：这个模块现在的真实完成度如何？入口在哪？关键文件是哪些？下一步该做什么？为什么这么设计？…":
      "e.g. How complete is this module now? Where is the entry? Which files are key? What's next? Why is it designed this way?…",
    "请填写要问的问题": "Please enter your question",
    "确认 = 只读回答（工作区 = 项目根目录 · 强制只读：不改文件、不改画布）· 取消 / 跳出不清空：再次打开本框接着上次写 · Ctrl+Enter 提交 · Esc 取消":
      "Confirm = read-only answer (workspace = project root · forced read-only: no file or canvas changes) · cancelling or stepping away keeps this text — reopen the box and continue where you left off · Ctrl+Enter submits · Esc cancels",
    "开始问询": "Start ask",
    /* ===== 开发节点：问询会话化（问答留在只读会话里，可回看可追问） ===== */
    "工作方式：用户每提出一个问题，先只读调研项目里的真实代码与该模块的开发进度，再直接给出回答。":
      "How it works: for every question, the AI first reads the real project code and this module's progress read-only, then answers directly.",
    "本会话不做任何修改：不改文件、不改画布、不回写节点概述与开发状态；要动手请让用户点该功能块的「开发」按钮。":
      "This session changes nothing: no files, no canvas, no rewriting the block's summary or dev status — to implement something, have the user click this module's \"Dev\" button.",
    "会话里的每一个问题都要回答；与本模块无关的请求，礼貌说明本会话只负责该模块的问询。":
      "Answer every question in the session; for requests unrelated to this module, politely explain that this session only covers asking about this module.",
    "【只读问询任务书】": "[Read-only ask brief]",
    "问询会话": "Ask session",
    "沿用该功能块已有的只读会话 · 追问接在同一上下文里":
      "Reuses this module's existing read-only session — follow-ups continue in the same context",
    "确认后：AI 先只读调研项目里的真实代码与该模块的开发进度（不改文件、不动画布），然后直接回答你的问题。回答留在该模块的只读会话里，随时可回看、可接着追问。":
      "After you confirm: the AI first reads the real code and this module's progress read-only (no file or canvas changes), then answers directly. The answer stays in this module's read-only session — revisit it and keep asking anytime.",
    "确认 = 新建 / 接入该模块的只读问询会话（工作区 = 项目根目录 · 不改文件、不改画布）· 取消 / 跳出不清空：再次打开本框接着上次写 · Ctrl+Enter 提交 · Esc 取消":
      "Confirm = open or join this module's read-only ask session (workspace = project root · no file or canvas changes) · cancelling or stepping away keeps this text — reopen the box and continue where you left off · Ctrl+Enter submits · Esc cancels",
    /* ===== 执行节点（绑定可执行文件 · 一键启动） ===== */
    "执行节点（绑定可执行文件 · 一键启动）":
      "Execute node (bind an executable · one-click launch)",
    "执行（绑定 .exe / .bat / 任意文件 · 双击运行）":
      "Execute (bind .exe / .bat / any file · double-click to run)",
    "执行": "Run",
    "绑定可执行文件…": "Bind executable…",
    "更换图标…": "Change icon…",
    "更换颜色…": "Change body color…",
    "选择要绑定的可执行文件（.exe / .bat / .cmd / .lnk 或任意系统可打开的文件）":
      "Choose the executable to bind (.exe / .bat / .cmd / .lnk or any system-openable file)",
    "可执行文件": "Executables",
    "全部文件": "All files",
    "已绑定：": "Bound: ",
    "尚未绑定可执行文件：请先右键节点「绑定可执行文件」":
      "No executable bound yet: right-click the node → Bind executable first",
    "尚未绑定可执行文件（点「绑定…」或右键）":
      "No executable bound (click Bind… or right-click)",
    "文件不存在：": "File not found: ",
    "正在启动…": "Launching…",
    "已启动：": "Launched: ",
    "启动失败：": "Launch failed: ",
    "启动失败": "Launch failed",
    "选择图标 · ": "Pick an icon · ",
    "选择颜色 · ": "Pick a color · ",
    "点击图标立即应用到该执行节点（便于快速定位）":
      "Click an icon to apply it to this execute node instantly (easier to spot)",
    "点击颜色立即应用到该执行节点的 body（便于快速定位）":
      "Click a color to apply it to this execute node's body instantly (easier to spot)",
    "默认": "Default",
    "火箭": "Rocket",
    "齿轮": "Gear",
    "终端": "Terminal",
    "播放": "Play",
    "闪电": "Bolt",
    "扳手": "Wrench",
    "文件夹": "Folder",
    "文件": "File",
    "电源": "Power",
    "青绿": "Teal",
    "蓝": "Blue",
    "紫": "Purple",
    "橙": "Orange",
    "红": "Red",
    "粉": "Pink",
    "绿": "Green",
    "棕": "Brown",
    "灰蓝": "Slate",
    "点击预备执行（播放键变为绿色背景 · 金色高亮），再次点击执行该文件；或直接双击执行":
      "Click to arm (play button turns green with a gold highlight), click again to run the file; or double-click to run directly",
    "再次点击执行该文件（或双击直接执行）":
      "Click again to run the file (or double-click to run directly)",
    "点击播放执行 · 双击直接执行": "Click play to run · double-click to run directly",
    "先绑定可执行文件": "Bind an executable first",
    "打开所在位置": "Show in folder",
    "右键节点可更换图标": "Right-click the node to change the icon",
    /* ===== 关系线（UML 风格 · 直线 · 双向箭头 · 线上文字 · 点选节点高亮） ===== */
    "关系线 · 从此节点出发": "Relationship wire · start from this node",
    "关系线：点击目标节点完成连接 · Esc 取消":
      "Relationship wire: click the target node to connect · Esc cancels",
    "已取消关系线": "Relationship wire cancelled",
    "关系线上的文字（如：调用 / 依赖 / 实现 / 包含）":
      "Text on the relationship wire (e.g. calls / depends on / implements / contains)",
    "关系线上的文字（可留空，之后双击线可编辑）":
      "Text on the relationship wire (may be empty; double-click the wire to edit later)",
    "编辑线上文字": "Edit wire label",
    "线上文字": "Wire label",
    "关系线操作": "Relationship wire actions",
    "✎ 编辑线上文字…": "✎ Edit wire label…",
    "箭头方向": "Arrow direction",
    "←→ 双向": "←→ Both ways",
    "→ 正向（起点 → 终点）": "→ Forward (source → target)",
    "← 反向（终点 → 起点）": "← Backward (target → source)",
    "— 无箭头": "— No arrows",
    "✕ 删除关系线": "✕ Delete relationship wire",
    "不能把关系线连到自身": "Cannot connect a relationship wire to itself",
    "关系线仅支持同一层级或直属父子的元素之间":
      "Relationship wires only connect elements on the same level or direct parent/child",
    "这两元素之间已有关系线": "These two elements already have a relationship wire",
    "✓ 已完成": "✓ Done",
    "已完成": "Done",
    "待开发": "Pending",
    "点击进入该模块的开发会话（标题与模块对应 · 工作区 = 项目根目录）":
      "Open this module's bound dev session (titled after the module · workspace = project root)",
    "打开该模块绑定的开发会话（标题与模块对应 · 工作区 = 项目根目录）":
      "Open this module's bound dev session (titled after the module · workspace = project root)",
    " · 状态：已完成": " · status: done",
    " · 状态：进行中": " · status: in progress",
    " · 状态：待开发": " · status: pending",
    "数据库已编译：": "Database compiled: ",
    " 条记录": " records",
    "数据库未编译：点头部 ⚙ 生成副本节点":
      "Not compiled yet: click ⚙ in the header to build the replica",
    "编译数据库：索引子文件夹文件与内部信息节点，并生成/刷新数据库副本节点":
      "Compile database: index subfolder files and inner info nodes, then create/refresh the replica node",
    "已编译 ": "Compiled ",
    " 条 · ": " items · ",
    "未编译 · 点头部 ⚙ 生成数据库副本": "Not compiled · click ⚙ to build the replica",
    "源数据库已删除：副本失效，可删除本节点":
      "Source database deleted: this replica is stale, you can delete it",
    "数据库尚未编译：请展开数据库节点，点头部 ⚙ 编译":
      "Not compiled yet: expand the database node and click ⚙",
    "还有 {n} 条（经 mtnode_db 工具查询）":
      "{n} more (query via the mtnode_db tool)",
    "数据库编译失败：": "Database compile failed: ",
    "当前任务未接入数据库副本：请先在数据库节点上「编译」，再把数据库副本节点连到本节点的输入端":
      "This task is not wired to a database replica: compile the database node first, then connect its replica node to this node's input",
    "数据库中没有该记录：": "No such record in the database: ",
    "calc 仅支持数字与 + - * / % 括号，表达式非法":
      "calc accepts numbers and + - * / % ( ) only; invalid expression",
    "query 需要 q 参数": "query requires the q parameter",
    "数据库中没有匹配该查询的记录": "No records in the database match this query",
    "本任务已接入数据库：": "This task is wired to the database(s): ",
    "1. 一切事实（名称 / 数字 / 价格 / 条款 / 路径）必须通过 mtnode_db 工具查询，回答只陈述工具返回的内容。":
      "1. Every fact (names/numbers/prices/terms/paths) must come from the mtnode_db tool; state only what the tool returns.",
    "2. 每个关键断言都要注明引用来源：[记录id · 标题]。":
      "2. Cite every key assertion as [record-id · title].",
    "3. mtnode_db 查不到的事实，必须明确回答「数据库中没有该信息」，禁止猜测、禁止用自身记忆补全。":
      '3. For facts mtnode_db cannot find, answer exactly "the database has no such information" — never guess or fill in from memory.',
    "4. 数字与日期计算必须用 mtnode_db 的 calc 动作，禁止心算。":
      "4. All numeric/date math must use mtnode_db calc — never mental arithmetic.",
    "5. 数据库未记载但任务需要的推断，必须明确标注「此为推断，数据库未记载」。":
      '5. Inferences not covered by the database must be labelled "inference — not in the database".',
    /* 动作与字段口径的真源是 mtnode_db 的工具描述（dsh/gateway/db-plugin.mjs），
       注记里不再抄一份 write / delete / 返回结构的说明。 */
    "6. 各动作与记录字段的口径以 mtnode_db 工具说明为准（list / get / query / write / delete / calc）；写 / 删之前先 query 确认，避免重复记录。":
      "6. Actions and record fields follow the mtnode_db tool description (list / get / query / write / delete / calc); query first before writing or deleting, so no duplicate records.",
    /* ===== 数据库节点（SQLite/FTS5 · 增量 · 调试控制台） ===== */
    "切换数据库形态：内嵌查询 / calc / 检查更新等调试工具":
      "Switch to database console: query / calc / dirty-check debugging tools",
    "当前：数据库形态（查询 / 调试控制台）· 点击切回超级节点形态":
      "Database console mode (query / debug) · click to return to super-node form",
    "编译数据库（仅手动触发 · 增量）：索引子文件夹文件与内部信息节点，并生成/刷新数据库副本节点":
      "Compile database (manual only · incremental): index subfolder files and inner info nodes, then create/refresh the replica node",
    "未设置工作目录或子文件夹：文件记录无法入库（仅内部信息节点可编译）":
      "No workspace or subfolder set: file records cannot be indexed (only inner info nodes can compile)",
    "SQLite 编译失败": "SQLite compile failed",
    "增量编译完成：+{a} 新增 · ~{u} 更新 · −{r} 移除 · 共 {t} 条":
      "Incremental compile done: +{a} added · ~{u} updated · −{r} removed · {t} total",
    "查询（支持 title: / file: / kind: 过滤）…":
      "Query (supports title: / file: / kind: filters)…",
    "查询": "Query",
    "输入查询内容": "Type a query first",
    "未设置工作目录/子文件夹，无法查询": "No workspace/subfolder set — cannot query",
    "查询失败": "Query failed",
    "无匹配记录": "No matching records",
    "calc：数字 + - * / % ( )": "calc: numbers + - * / % ( )",
    "表达式非法": "Invalid expression",
    "检查更新": "Check changes",
    "编译（增量）": "Compile (incremental)",
    "打开子文件夹": "Open subfolder",
    "未设置工作目录/子文件夹": "No workspace/subfolder set",
    "待入库：+{a} 新增 · ~{c} 变更 · −{r} 移除（点击「编译（增量）」生效）":
      "Pending: +{a} added · ~{c} changed · −{r} removed (run “Compile (incremental)” to apply)",
    "上次增量 +{a}/~{u}/−{r}": "Last increment +{a}/~{u}/−{r}",
    "先设置工作目录与数据库子文件夹，再拖入文件":
      "Set the workspace and database subfolder first, then drop files",
    "已放入 {n} 个文件到数据库子文件夹 · 点击 ⚙ 编译（增量）入库":
      "Copied {n} file(s) into the database subfolder · click ⚙ to compile (incremental)",
    "数据库子文件夹不存在：": "Database subfolder does not exist: ",
    "calc 失败": "calc failed",
    "分支会话「": "Fork session ",
    "」？\n\n将复制该会话的全部消息与设置到新会话，原会话保持不变。": "? This copies all messages and settings to a new session; the original session stays unchanged.",
    "分支会话": "Fork Session",
    "分支": "Fork",
    "归档会话「": "Archive session ",
    "」？\n\n会话将收起到底部「已归档」区，可随时恢复。": "? The session will be collapsed into the Archived section at the bottom; you can restore it anytime.",
    "归档会话": "Archive Session",
    "归档": "Archive",
    "构建工作流": "Build Workflow",
    "构建工作流（选择生成技能 · 填写要求）":
      "Build Workflow (pick a generation skill · fill in requirements)",
    "选择要使用的工具（工作流生成类技能），并填写要求。确认后将新建一个绑定当前画布的独立会话在其中执行（不使用全局助手）。":
      "Pick the tool (a workflow-generation skill) and describe what you need. On confirm, a new standalone session bound to this canvas will run it (the global assistant stays untouched).",
    "工具（工作流生成技能）": "Tool (workflow-generation skill)",
    "构建要求": "Requirements",
    "开始构建": "Build",
    "目标画布": "Target canvas",
    "仅显示工作流生成类技能": "Only workflow-generation skills",
    " 个可选工具": " tools available",
    "暂无可用技能": "No skills available",
    "请先填写构建要求": "Please fill in the requirements first",
    "构建 · ": "Build · ",
    "已创建构建会话「": "Build session created: ",
    "技能正文读取失败，未发起构建：": "Could not read the skill body, build not started: ",
    "构建会话启动失败：": "Failed to start the build session: ",
    "该画布的构建会话正在执行中：请等待完成或先终止，再发起构建":
      "This canvas already has a build session running — wait for it to finish or stop it before building again",
    "未找到可用的工作流生成技能：请先在 设置 → 技能 安装 generate-workflow / generate-task":
      "No workflow-generation skill found: install generate-workflow / generate-task in Settings → Skills first",
    "例如：读取「素材清单」里的条目，逐条生成商品文案与主图提示词，输出 YAML 并保存；输入节点放上方，再给一个控制节点一键重跑……":
      "e.g. read items from “Asset list”, generate copy + a main-image prompt per item, save as YAML; put inputs on top and add a control node for one-click re-run…",
    "Ctrl+Enter 开始构建 · Esc 取消 · 要求写得越具体（输入来源 / 处理步骤 / 输出格式），生成结果越接近预期":
      "Ctrl+Enter to build · Esc to cancel · the more concrete the requirements (inputs / steps / output format), the closer the result",
    /* 构建工作流 · Agent 设定（与开发节点同一套：模型 / 模式 / 思考强度） */
    "Agent 设定（模型 / 模式 / 思考强度）":
      "Agent settings (model / mode / thinking effort)",
  });

  /* 同功能块新绑定会话沿用上次计划：弹窗预填 / 已完成参考 */
  Object.assign(EN, {
    "沿用上次计划": "Carried from previous plan",
    "上一次确认的清单里还有 ": "The previously confirmed list still has ",
    " 项未完成，已原样预填在下方（可就地增删改）":
      " unfinished item(s), prefilled below (edit / add / remove in place)",
    "；已完成的 ": "; the ",
    " 项保留作记录，不会再跑一遍":
      " finished item(s) are kept for reference and won’t run again",
    "已完成参考（上一次计划 · 不会自动续跑）":
      "Finished reference (previous plan · not auto-resumed)",
    "已完成（沿用 · 不重跑）": "Done (carried · won’t re-run)",
    "已跳过（沿用）": "Skipped (carried)",
  });

  /* 分段渲染（段 = seg）：思考段 / 正文输出段 / 工具段的段头与提示文案。
     只增键，不删改上方既有键；段标签一律带尾随空格与「· 」分隔，便于后接字数。 */
  Object.assign(EN, {
    "◉ 思考 · ": "◉ Thinking · ",
    "◉ 思考中 · ": "◉ Thinking · ",
    "思考 · ": "Thinking · ",
    "输出 · ": "Output · ",
    "工具 · ": "Tool · ",
    "🔧 工具 · ": "🔧 Tool · ",
    "本段思考": "This block's thinking",
    "本段输出": "This block's output",
    "思考段": "Thinking block",
    "输出段": "Output block",
    "工具段": "Tool block",
    "分开显示思考与输出": "Show thinking and output separately",
    "思考与输出已分开显示": "Thinking and output are now shown in separate blocks",
    "点击展开 / 收起本段思考": "Click to expand / collapse this thinking block",
    "点击查看本段思考": "Click to view this thinking block",
    "本段思考（模型内部推理，非回复）": "This block is the model's internal reasoning, not the reply",
  });

  /* 「思考」翻译（右侧小按钮）：默认模型（优先 flash · 无思考）逐段翻译思考内容。
     只增键，不删改上方既有键。 */
  Object.assign(EN, {
    "翻译": "Translate",
    "翻译中…": "Translating…",
    "重试翻译": "Retry translate",
    "译文": "Translation",
    "⚠ 翻译失败": "⚠ Translation failed",
    "翻译失败": "Translation failed",
    "未返回译文": "The model returned no translation",
    "模型未返回译文": "The model returned no translation",
    "复制译文到剪贴板": "Copy the translation to the clipboard",
    "用默认模型（优先 flash · 无思考）翻译这段思考":
      "Translate this thinking with the default model (flash preferred · no thinking)",
    "翻译质量校验未通过（模型仍在输出原文）":
      "Translation check failed (the model is still echoing the source)",
  });

  /* ── Remotion 动效视频（应用插件 remotion） ── */
  Object.assign(EN, {
    "Remotion": "Remotion",
    "Remotion 视频": "Remotion video",
    "Remotion 视频（React 动效合成）": "Remotion video (React motion)",
    "Remotion 视频（React 动效合成 · 本地渲染 mp4）":
      "Remotion video (React motion · rendered locally as mp4)",
    "React 动效合成 · 本地渲染 mp4": "React motion · rendered locally as mp4",
    "服务商 / 模型 / 温度": "Provider / model / temperature",
    "生成动效代码并本地渲染视频": "Generate motion code and render video locally",
    "打开 Remotion 控制台（状态 / 安装 / 日志）":
      "Open Remotion console (status / install / logs)",
    "打开控制台安装": "Open console & install",
    "在控制台窗中设置安装目录并安装（npm install，需联网）":
      "Pick an install directory in the console window, then install (npm install, needs network)",
    "⚠ Remotion 插件未安装：请在「插件」中安装后使用本节点":
      "⚠ Remotion plugin is not installed: install it in Plugins first",
    "插件 · Remotion 动效视频：设置安装目录 → 安装（npm install）":
      "Plugins · Remotion video: pick install dir → install (npm install)",
    "描述文本（视频内容描述）": "Description text (video content)",
    "请接入文本节点": "Connect a text node first",
    "视频输出由下游「保存」节点保存（渲染产物在插件安装目录 out/）":
      "Video output is saved by a downstream Save node (render lands in the plugin install dir out/)",
    "时长（秒，1–60）": "Duration (sec, 1–60)",
    "帧率（fps，1–60）": "Frame rate (fps, 1–60)",
    "分辨率": "Resolution",
    "渲染中 ": "Rendering ",
    "处理中…": "Processing…",
    "描述文本 → LLM 动效合成 → 本地渲染 mp4":
      "Description → LLM motion composition → local mp4 render",
    "LLM 生成动效代码…": "LLM writing motion code…",
    "LLM 未返回动效代码": "LLM returned no motion code",
    "渲染视频…": "Rendering video…",
    "渲染失败": "Render failed",
    "渲染完成但未返回输出路径": "Render finished but no output path returned",
    "已取消 Remotion 渲染": "Remotion render cancelled",
    /* ── Remotion 节点 ↔ 智能会话：会话按钮 / toast / 过程记录 ── */
    "查看生成过程 / 编辑迭代（打开绑定会话）":
      "View the generation process / edit iterations (open the bound session)",
    "已打开会话：可查看过程与编辑迭代":
      "Session opened: view the process and edit iterations here",
    "上次生成完成：视频已输出到 ":
      "Last generation done: video saved to ",
    "上次生成失败：": "Last generation failed: ",
    "上次生成已取消": "Last generation cancelled",
    "生成的动效代码（TSX，可在会话中编辑迭代）：":
      "Generated motion code (TSX — editable & iterable in the session): ",
    "Remotion 描述文本输入端子为端口 1": "Remotion description port is port 1",
    "Remotion 描述端子需要文本来源": "Remotion description port needs a text source",
    "Remotion 控制输入端子为端口 0": "Remotion control port is port 0",
    "Remotion 插件未就绪（请先在插件中安装）":
      "Remotion plugin not ready (install it in Plugins first)",
    "Remotion 插件尚未安装或未就绪（请先在「插件 · Remotion 动效视频」中安装）":
      "Remotion plugin is not installed or not ready (install it in Plugins · Remotion video first)",
    "请为下面这段视频描述编写一个完整的 Remotion Composition.tsx 文件（React 动效合成）。\n":
      "Write a complete Remotion Composition.tsx file (React motion composition) for the video description below.\n",
    "视频描述：": "Video description: ",
    "输出要求（必须全部满足）：": "Requirements (all must be met):",
    "只输出一个完整的 TypeScript 源文件，不要解释、不要 Markdown 代码围栏，文件内容从 import 开始到文件末尾。":
      "Output only one complete TypeScript source file: no explanations, no Markdown fences; the file starts at the import and ends at the last line.",
    "仅允许从 \"remotion\" 和 \"react\" 导入（例如 react 的 useState/useMemo，remotion 的 AbsoluteFill/useCurrentFrame/useVideoConfig/interpolate/spring/Sequence/Img/Audio/Easing 等）；禁止导入任何其它 npm 包。":
      "Import only from \"remotion\" and \"react\" (e.g. useState/useMemo from react; AbsoluteFill/useCurrentFrame/useVideoConfig/interpolate/spring/Sequence/Img/Audio/Easing from remotion); no other npm packages.",
    "导出组件名必须是 Main（export const Main: React.FC = ...），并使用 AbsoluteFill 作为根容器。":
      "The exported component must be named Main (export const Main: React.FC = ...) with AbsoluteFill as the root container.",
    "必须使用 useVideoConfig() 读取 width/height/fps/durationInFrames，不要硬编码视频尺寸与总帧数。":
      "Read width/height/fps/durationInFrames via useVideoConfig(); never hard-code dimensions or total frames.",
    "时长按 ": "Timing: ",
    " 秒 × ": " seconds × ",
    " fps 设计动画节奏；动效要连贯自然（淡入淡出 / 位移 / 缩放 / 颜色过渡至少两种），内容贴合描述，文字用中文。":
      " fps; animate with at least two smooth effects (fade, translate, scale, color transitions), content should match the description, text in Chinese.",
    "所有样式用内联 style 对象（style={{...}}），不要 CSS 文件、不要 class 选择器；颜色用十六进制。":
      "Use inline style objects (style={{...}}) only — no CSS files, no class selectors; colors in hex.",
    "代码必须可被 TypeScript 直接编译（宽松配置下），不要使用未定义变量，不要在顶层执行副作用。":
      "The code must compile under loose TypeScript config: no undefined variables, no top-level side effects.",
    "interpolate 的 inputRange 关键帧数组必须严格递增且元素不重复（从小到大，如 [0,20,60]）；在 map / 循环里按 i 计算关键帧时，后一个帧号必须严格大于前一个（可用 Math.max 兜底），否则渲染会直接失败。":
      "The interpolate() inputRange keyframe array must be strictly increasing with no duplicate frames (e.g. [0,20,60]); when keyframes are computed from i inside map/loops, each later frame must be strictly greater than the previous one (use Math.max as a floor) — otherwise rendering fails.",
    "Remotion API 速查：": "Remotion API cheat sheet:",
    "当前帧号": "current frame number",
    "数值插值（inputRange 必须严格递增、元素不重复）":
      "numeric interpolation (inputRange must be strictly increasing, no duplicate frames)",
    "弹性动画 0→1": "spring animation 0→1",
    "子序列延迟": "delayed sub-sequence",
    "图像 / 音频（本任务不提供外部资源，可不使用）":
      "image / audio (no external assets in this task; optional)",
    "画面尺寸 ": "Canvas size ",
    "参考它设计字号与元素布局（可用百分比 / 相对计算）。":
      "Use it to size fonts and layout elements (percentages / relative math are fine).",
  });

  /* ── 交互卡片（提问 / 审批）的来源标注 + 「稍后」出口 ── */
  Object.assign(EN, {
    "来自：": "From: ",
    "智能节点「{n}」· {w}": "Agent node “{n}” · {w}",
    "智能节点「{n}」": "Agent node “{n}”",
    "开发/细化会话「{n}」": "Dev / refine session “{n}”",
    "功能块「{n}」的建议": "Suggestion for module “{n}”",
    "功能块「{n}」的问询": "Inquiry to module “{n}”",
    "稍后（终止本轮）": "Later (stop this run)",
    "先不回答：终止发起这张卡片的这一轮运行":
      "Answer later: stops the run that raised this card",
    "已稍后处理：本轮已终止": "Deferred — this run was stopped",
    "该询问已失效（发起轮已结束）":
      "This prompt is no longer live (the run that asked has ended)",
    /* 宿主确认框（画布修改 / 危险操作）绑定发起轮次后的自动撤框文案 */
    "发起轮已结束，未执行": "The run that asked has ended — nothing was executed",
    "画布操作已失效（发起轮已结束），未执行":
      "Canvas action is no longer live (the run that asked has ended) — nothing was executed",
    "画布修改询问已自动关闭（发起轮已结束），未执行":
      "Canvas edit prompt auto-dismissed (the run that asked has ended) — nothing was executed",
    "发起该请求的运行结束后，此确认框会自动消失。":
      "This dialog closes on its own once the run that requested it has ended.",
  });

  /* ── 交互卡片的「中断任务」出口（卡片按钮 + 面板头部全部中断） ── */
  Object.assign(EN, {
    "中断任务": "Interrupt task",
    "中断：撤掉本轮全部询问并终止这一轮，模型侧收到「已中断」失败回执（不同于「稍后」）":
      "Interrupt: clears every prompt from this run and stops it — the model gets an explicit “interrupted” failure instead of an answer (unlike “Later”)",
    "已中断该询问": "Prompt interrupted",
    "已中断任务：本轮已终止": "Task interrupted — this run was stopped",
    "全部中断": "Interrupt all",
    "中断所有在途运行并撤掉它们的全部询问卡片":
      "Interrupt every in-flight run and dismiss all of their prompts",
    "已中断全部在途任务（{n} 轮）": "Interrupted all in-flight runs ({n})",
    /* 询问窗可拖：头部是拖拽手柄，拖到窗口底部 = 收进底栏那一条 */
    "按住头部拖动这只窗（拖到底部 = 收进底栏）；双击回到默认位置":
      "Drag this window by its header (drag to the bottom = dock into the status bar); double-click the header to reset its position",
    "已收进底栏：点一下展开，拖回画布上方即恢复":
      "Docked in the status bar — click to expand, or drag it back up over the canvas",
  });

  /* ── 删除画布安全（锁定目标 · 后台写入互斥 · 回收站软删）───────────────
     删除任何画布都只影响打开弹窗时锁定的那一张，其余画布不会被牵连。 */
  Object.assign(EN, {
    /* 前台画布锁：后台换画布写入期间禁止删除 */
    "智能体正在后台写入画布，请稍候":
      "An agent is writing to a canvas in the background — please wait a moment",
    "当前画布已切换，本框只删除打开时锁定的画布，请重新发起删除":
      "The current canvas has switched. This dialog only deletes the canvas that was locked when it opened — start the deletion again.",
    "读取画布列表失败：": "Failed to read the canvas list: ",
    "画布已不存在，可能已被删除：":
      "Canvas no longer exists — it may already have been deleted: ",
    /* 删除确认弹窗正文（分段拼接：名称 + id + 节点数） */
    "</b>（id <code>": "</b> (id <code>",
    "</code> · 节点 <b>": "</code> · nodes <b>",
    "</b> 个）及其全部本地数据文件（含节点图像资产）。此操作不可恢复。":
      "</b>), together with all of its local data files (including node image assets). This cannot be undone.",
    "请先核对上面的 id 与节点数，确认要删的就是它。":
      "Check the id and node count above first — make sure that is the canvas you mean.",
    /* 删除结果与落点 */
    "删除被拒绝：": "Delete rejected: ",
    "主进程未返回删除结果": "the main process returned no deletion result",
    "画布已删除，已切换到：": "Canvas deleted; switched to: ",
    /* 智能体侧删除入口（受限范围 / 必须显式指定） */
    "当前会话没有绑定画布，无法删除":
      "This session has no bound canvas, so nothing can be deleted",
    "缺少 workflow：请显式指定要删除的画布（id 或名称）。为避免误删，全局范围不会默认删除「当前画布」。":
      "Missing workflow: specify the canvas to delete (id or name). To prevent mis-deletion, the global scope never deletes “the current canvas” by default.",
    "缺少 workflow：请显式指定要删除的画布（id 或名称）。":
      "Missing workflow: specify the canvas to delete (id or name).",
    "删除目标与锁定的画布不一致，已中止：":
      "The delete target differs from the locked canvas — aborted: ",
    "删除目标与确认框里的画布不一致，已中止，请重新发起删除。":
      "The delete target differs from the canvas in the confirmation dialog — aborted. Start the deletion again.",
    "画布名称在确认期间已变化，已中止，请重新确认后删除。":
      "The canvas name changed while you were confirming — aborted. Confirm again, then delete.",
    /* 危险操作确认框摘要（名称 + id + 节点数 + 回收站说明） */
    "未指定画布": "no canvas specified",
    "将删除画布": "Will delete canvas ",
    "（id ": " (id ",
    " · 节点 ": " · nodes ",
    " 个），仅影响这一个画布。":
      "), and it affects this canvas only.",
    "无法定位要删除的画布：": "Cannot locate the canvas to delete: ",
    "画布文件与其图像资产会移入本机回收站目录（%APPDATA%\\pipeline-console\\trash），不会静默物理删除。":
      "The canvas file and its image assets are moved into the local trash folder (%APPDATA%\\pipeline-console\\trash) — nothing is deleted outright.",
    /* 主进程 workflow:delete 的校验与回收站文案（错误原样回传给界面与模型） */
    "非法工作流 id": "Invalid workflow id",
    "删除目标不在画布数据目录内，已拒绝":
      "The delete target lies outside the canvas data folder — rejected",
    "画布文件无法读取，已拒绝删除（请手动检查 save 目录）":
      "The canvas file cannot be read — deletion rejected (check the save folder manually)",
    "画布文件内容异常，已拒绝删除（请手动检查 save 目录）":
      "The canvas file looks malformed — deletion rejected (check the save folder manually)",
    "画布校验不一致，已拒绝删除：磁盘上是":
      "Canvas check failed — deletion rejected. On disk it is",
    "，请求要删的是": " · requested for deletion:",
    "回收站目标路径越界，已拒绝":
      "The trash destination path escapes the data folder — rejected",
    "无法创建回收站目录，画布未删除：":
      "Cannot create the trash folder, canvas not deleted: ",
    "回收站复制校验不一致，画布未删除":
      "Copy verification against the trash folder failed, canvas not deleted",
    "画布已复制到回收站，但源文件被占用无法移除；请关闭占用后重试：":
      "The canvas was copied to the trash folder, but the source is locked and could not be removed — close whatever holds it and retry: ",
    "移入回收站失败，画布未删除：":
      "Moving to the trash folder failed, canvas not deleted: ",
  });

  /* ── 泛用「文件节点」（上传任意文件 → 自动转为对应输入节点） · 文本导入的两道警告 ── */
  Object.assign(EN, {
    "文件节点（上传任意文件 · 自动转为对应节点）":
      "File node (upload any file · auto-converts to the matching node)",
    "上传文件（任意类型 · 自动转为对应节点）":
      "Upload a file (any type · auto-converts to the matching node)",
    音频节点: "Audio Node",
    视频节点: "Video Node",
    "转换为输入节点": "Convert to input node",
    "手动更改类型：点击直接转换成对应的输入节点":
      "Change type manually: click to convert straight into the matching input node",
    "转换为": "Convert to ",
    "从本机选一个任意类型的文件 · 按文件类型自动转为文本 / 图像 / 音频 / 视频节点":
      "Pick any file from this machine · its type decides whether this becomes a text / image / audio / video node",
    "右键本节点 · 可先手动指定要转成哪种输入节点":
      "Right-click this node to pick the target node type first",
    "也可点上方按钮或右键本节点 · 手动指定要转成哪种输入节点":
      "Or click the mini buttons on the header bar / right-click this node to pick the target input node type",
    "文件节点逻辑未就绪（app.js）": "File node logic not loaded (app.js)",
    "无法识别「{name}」的类型，未做转换":
      "Cannot recognize the type of “{name}” · nothing was converted",
    /* 解析不出来 → 仅保留路径（节点不转换，下游引用到的就是这段路径） */
    "「{name}」解析不出文本，只保留文件路径（下游可引用该路径触发工具）":
      "No text could be parsed from “{name}” — only the file path is kept (downstream can reference that path to trigger a tool)",
    "解析不出文本 · 仅保留文件路径，下游引用到的就是这段路径":
      "Not parseable as text · only the file path is kept — that path is exactly what downstream references",
    重新选择文件: "Choose another file",
    "已转为「{t}」：{name}": "Converted to “{t}”: {name}",
    "已转为「{t}」": "Converted to “{t}”",
    上传文件: "Upload a file",
    "文件节点：先上传一个文件，应用会按文件类型自动把它变成对应的输入节点。":
      "File node: upload a file first, and the app turns it into the matching input node by file type.",
    上传: "Upload",
    "文件大于 1 MB": "File larger than 1 MB",
    仍要导入: "Import anyway",
    "无法解析该文件": "This file cannot be parsed",
    "「{name}」有 {size}，超过建议的 {limit}：文本节点正文太长会拖慢画布与预览，也很可能一口超出下游模型的上下文。仍要整个导入吗？":
      "“{name}” is {size}, above the recommended {limit}: a very long text body slows down the canvas and preview, and will likely blow past the downstream model's context. Import it in full anyway?",
    "「{name}」解析不出文本内容：它看起来是二进制文件（压缩包 / Office / 可执行程序…），或编码不是 UTF-8。导进文本节点只会得到一串乱码 —— 图片 / 音频 / 视频请改用对应的输入节点，其它格式先另存为文本。仍要导入吗？":
      "No readable text could be parsed from “{name}”: it looks like a binary file (archive / Office / executable…), or it isn't UTF-8. Importing it into a text node only yields mojibake — use the matching image / audio / video node instead, or save other formats as text first. Import anyway?",
  });

  /* ── 音频 / 视频输入节点（选择文件 · 输出该文件的 URL） ── */
  Object.assign(EN, {
    视频: "Video",
    "音频节点（选择文件 · 输出 URL）": "Audio node (pick a file · outputs its URL)",
    "视频节点（选择文件 · 输出 URL）": "Video node (pick a file · outputs its URL)",
    "音频输入（输出该文件的 URL）": "Audio input (outputs the file's URL)",
    "视频输入（输出该文件的 URL）": "Video input (outputs the file's URL)",
    "选择音频（输入节点）": "Choose audio (input node)",
    "选择视频（输入节点）": "Choose video (input node)",
    选择音频: "Choose audio",
    选择视频: "Choose video",
    未选择音频: "No audio selected",
    未选择视频: "No video selected",
    "点击此处选择，或直接把媒体文件拖到本节点":
      "Click here to choose, or drop a media file onto this node",
    "未绑定音频文件": "no audio file bound",
    "未绑定视频文件": "no video file bound",
    点击在文件夹中显示: "click to reveal in folder",
    "文件不存在或本机播放器无法解码该格式":
      "File is missing, or the local player cannot decode this format",
    "点击此处可更换文件；也可直接把媒体文件拖到本节点":
      "Click here to change the file; you can also drop a media file onto this node",
    "输出 URL": "outputs a URL",
    "输出该文件的 URL": "outputs this file's URL",
    "音频输入 · 输出该文件的 URL": "Audio input · outputs the file's URL",
    "视频输入 · 输出该文件的 URL": "Video input · outputs the file's URL",
    "输出该文件的 URL（file:///… · 可连进媒体参考端子）":
      "Outputs this file's URL (file:///… · wire it into a media reference slot)",
    "选择并预览本机音视频文件：输出端子给出该文件的 file:/// URL，可连进媒体生成节点的参考端子":
      "Chooses and previews a local audio/video file: its output port gives the file's file:/// URL, wire it into a media-generation reference slot",
    "音频已载入输入节点": "Audio loaded into the input node",
    "视频已载入输入节点": "Video loaded into the input node",
    "此节点只接收音频文件（mp3 / wav / ogg…）":
      "This node only accepts audio files (mp3 / wav / ogg…)",
    "此节点只接收视频文件（mp4 / mov / webm…）":
      "This node only accepts video files (mp4 / mov / webm…)",
    "已载入：": "Loaded: ",
  });

  /* 拖外部文件进画布自动建节点（app.js createNodesFromDroppedFiles 与分类 helper） */
  Object.assign(EN, {
    "【功能】外部拖入画布的文件资源：{name}，仅作引用与快速打开，不参与工作流数据流。\n【实现】绝对路径：{path}":
      "【功能】External file dropped onto the canvas: {name}. Reference and quick-open only — it takes no part in the workflow data flow.\n【实现】Absolute path: {path}",
    "（文件过大，未读入内容 {size}）完整文件见：\n{path}":
      "(File too large to load — {size} skipped.) Full file at:\n{path}",
    "…（正文超过 {size}，已截断，完整内容见原文件：\n{path}）":
      "… (text exceeds {size} and was truncated; the full content is in the original file:\n{path})",
    "已创建 {n} 个节点：": "Created {n} node(s): ",
    "{n} 个文件过大，正文已截断": "{n} file(s) were too large — text truncated",
    "{n} 个文件读不出内容，改为文件块":
      "{n} file(s) could not be read — kept as file blocks",
    "{n} 个文件取不到本机路径，已跳过":
      "{n} file(s) had no local path — skipped",
    创建节点失败: "Failed to create node",
  });
  /* ── 思维精简预设（内部 id 由 sketch 改名为 lean）──────────────────────────
     思考档不再由预设压制：网关已取消按预设压档（旧的 PRESET_EFFORT_CAPS），界面只有
     「标准 / 最强」两档，选什么就按什么跑，所以当年那套「生效档位」文案（chip 后缀 /
     cell tooltip / 弹层标注）连同词条一并删掉，不留死 key。
     档位名与 hint 的唯一真源是 app.js 的 AGENT_PRESETS 表，这里只负责翻译。 */
  Object.assign(EN, {
    "预设 / 模型 / 思考强度": "Preset / Model / Thinking effort",
    /* 旧四档（标准 / PTC / 极简 / 创造）的档位名与说明此前一直没有英文词条——预设菜单与
       设置页都直接 t() 这些串，缺词条时英文界面会漏出中文，本轮一并补齐。 */
    "标准模式": "Standard mode",
    "标准模式（通用档：画布 / 文件 / 内容任务）":
      "Standard mode (general: canvas / file / content tasks)",
    "通用档：画布编排、文件与内容任务兼顾":
      "General preset: canvas orchestration plus file and content tasks, with fuller explanations",
    "PTC 模式": "PTC mode",
    "PTC 模式（写代码 / 改文件 / 跑命令）": "PTC mode (write code / edit files / run commands)",
    "工程档：先读文件再改，改完说明改动与验证方式":
      "Engineering preset: read before editing, then report what changed and how it was verified",
    "极简模式": "Minimal mode",
    "极简模式（默认 · 直奔结果，少解释）":
      "Minimal mode (default — straight to the result, less explaining)",
    "省事档：最少步骤、最少废话，直接给结果":
      "Effort-saving preset: the fewest steps, no filler, just the result",
    "创造模式": "Creative mode",
    "创造模式（自定义 Preset）": "Creative mode (custom preset)",
    "Cordis 插件开发档：遵循 Service / ctx.effect / 类型化事件约定":
      "Cordis plugin-development preset: follows the Service / ctx.effect / typed-event conventions",
    "思维精简": "Lean Thinking",
    "思维精简（思考压成符号骨架：先骨架后干活，最省 token）":
      "Lean Thinking (thinking compressed into a symbolic skeleton: sketch it first, then work — the cheapest on tokens)",
    "思维精简档：思考压成 GOAL / APPROACH / EDGE 符号骨架；思考强度仍按你的设置走":
      "Lean Thinking preset: thinking is compressed into a GOAL / APPROACH / EDGE symbolic skeleton; the thinking level still follows your own setting",
  });
  /* ── 开发节点「Agent 设定」三格弹层（预设 / 模型 / 思考强度 + 就近继承回显）──── */
  Object.assign(EN, {
    "Agent 设定": "Agent settings",
    "Agent 预设": "Agent preset",
    "Agent 预设：": "Agent preset: ",
    "思考强度：": "Thinking effort: ",
    "未选择：本功能块与子功能块的「建议 / 开发 / 细化」跟随默认预设。":
      "Not set: this block and its child blocks follow the default preset for Suggest / Develop / Refine.",
    "未选择：跟随默认思考档（标准）。":
      "Not set: follows the default thinking effort (Standard).",
    "不指定：本功能块与未自行选择的子功能块跟随默认预设。":
      "Unset: this block and child blocks without their own pick follow the default preset.",
    "（继承）": " (inherited)",
    "最强：推理预算最高（更慢、更费 token），不受任何预设影响":
      "Max: the highest reasoning budget (slower, more tokens) — unaffected by any preset",
    "清除本功能块「": "Clear this block's ",
    "」这一格的选择，退回跟随默认（或继承上层）。":
      " pick and fall back to the default (or inherit from the parent block).",
    "标": "Std",
    /* 「强」是共享思考档词汇（AGENT_EFFORT_LABELS）里 xhigh 档的短名（会话 / 助手思考
       强度菜单的「强」档），不再只指开发节点 max 的旧短标：英文按词汇表译为 X-High。 */
    "强": "X-High",
  });
  /* ── 「AI 调用」设定（工具 / 函数节点 · 与开发节点 Agent 设定同一套三格）── */
  Object.assign(EN, {
    "AI 调用": "AI call",
    "AI 调用模型：": "AI call model: ",
    "AI 调用预设：": "AI call preset: ",
    "AI 调用：自动（跟随默认）· 点击选择模型 / 预设 / 思考强度":
      "AI call: Auto (follow default) · click to pick model / preset / thinking effort",
    "AI 调用：": "AI call: ",
    " · 点击修改": " · click to change",
    "（继承自「": " (inherited from \"",
    "」）· 点击为本节点单独选择": "\") · click to pick one for this node",
    "生效范围：": "Scope: ",
    "本工具节点需要借助 AI 时": "whenever this tool node needs AI, it ",
    "本函数节点需要借助 AI 时": "whenever this function node needs AI, it ",
    "本功能块的「建议 / 开发 / 细化」":
      "this block's Suggest / Develop / Refine ",
    "一律按这里的设定调用模型，改动立即生效。":
      "always calls models with the settings below; changes take effect immediately.",
    "未选择：本节点与未自行选择的内部节点跟随默认预设。":
      "Not set: this node and its inner nodes without their own pick follow the default preset.",
    "未选择：本节点需要借助 AI 时跟随默认模型。":
      "Not set: this node follows the default model when it needs AI.",
    "不指定：本节点与未自行选择的内部节点跟随默认预设。":
      "Unset: this node and its inner nodes without their own pick follow the default preset.",
    "本节点已选择：": "This node has picked: ",
    "；其下未自行选择的内部节点一并使用它。":
      " ; its inner nodes without their own pick use it too.",
    "当前继承自「": "Currently inherited from \"",
    "」：": "\": ",
    "；在此单独选择后，本节点改用它。":
      " ; pick one here to make this node use that instead.",
    "已按本工具节点的「AI 调用」设定运行内部 ":
      "Ran inner AI nodes with this tool node's AI-call settings: ",
    " 个 AI 节点": " node(s)",
  });
  /* ── 工具 / 函数节点（T1 渲染层）── 全文案随 T5 统一补，这里先落英文档 */
  Object.assign(EN, {
    "函数": "Function",
    "函数节点（JS 计算 · 参数即端子）": "Function node (JS compute · params as ports)",
    "函数名 fnName（可选）": "Function name fnName (optional)",
    "工具": "Tool",
    "工具节点（参数即端子 · 可展开子画布 · Agent 可调用）":
      "Tool node (params as ports · expandable sub-canvas · agent-callable)",
    "工具名 name（标题默认 = 工具名 · 手动改名后独立）":
      "Tool name (title defaults to the tool name · stays independent after you rename the title)",
    "描述 description（给 Agent / 给人看的用途说明）":
      "Description (what it does / when to use, for the agent and humans)",
    "输入参数（端子 1..n · 端子 0 = 控制入）":
      "Input params (ports 1..n · port 0 = control in)",
    "输出参数（端子 0..n-1 · 末位 = 控制出）":
      "Output params (ports 0..n-1 · last = control out)",
    "添加输入参数": "Add input param",
    "添加输出参数": "Add output param",
    "删除该参数（对应端子一并消失）": "Delete this param (its port disappears too)",
    "（图像）": " (image)",
    "（文本）": " (text)",
    "该端子的数据类型（文本 / 图像）· 改类型即改端子视觉与下游取数口径":
      "Data type of this port (text / image) · changing it restyles the port and resets downstream",
    /* 数组（批量）入参：一个端子可挂多条数据线 · JS 里该参数拿到数组
       （app-canvas.js 设置面板勾选 / 端子徽标 · app-tools.js 测试台多行输入） */
    "数组 · 可接多条线": "Array · accepts several wires",
    "数组端子：可接多条数据线 · JS 里该参数拿到数组（没挂线时是空数组）":
      "Array port: it may take several data wires · in JS this param is an array (empty array when nothing is wired)",
    " · 数组端子：JS 里拿到数组 · 当前挂 {n} 条线（可接多条）":
      " · array port: you get an array in JS · {n} wire(s) attached (several allowed)",
    " · 数组端子（JS 里拿到数组 · 一行一条）":
      " · array port (an array in JS · one value per row)",
    "图像文件路径（一行一条 · 留空的行不注入）":
      "Image file path (one per row · blank rows are not injected)",
    "数组元素（一行一条 · 留空的行不注入）":
      "Array item (one per row · blank rows are not injected)",
    "删除这一条（数组元素的行）": "Remove this row (one array item)",
    "添加一条": "Add a row",
    "当前注入 ": "Injecting ",
    " 条（数组端子 · JS 里拿到数组）":
      " item(s) now (array port · you get an array in JS)",
    "运行工具中…": "Running tool…",
    "运行工具（引擎按 tool 契约执行）": "Run tool (engine executes per the tool contract)",
    "运行函数：执行 JS 代码": "Run function: execute the JS code",
    "待运行 · 点头部 ▶ · 「设置」编辑参数": "Ready · ▶ to run · edit params in Settings",
    "待运行 · 编辑 JS · 点头部 ▶ 执行": "Ready · edit JS · ▶ to run",
    "入参": "Inputs",
    "出参": "Outputs",
    "（未命名工具）": "(unnamed tool)",
    "设置（参数 / 名称 / 描述）": "Settings (params / name / description)",
    "设置（名称 / 描述 / 增删输入输出参数）":
      "Settings (name / description / add or remove input-output params)",
    "已同步标题：": "Title synced: ",
    "控制输入（触发生成 / 运行）": "Control in (trigger run)",
    "输入参数 ": "Input param ",
    "输出参数 ": "Output param ",
    "控制输出（运行完成后触发下游控制目标）":
      "Control out (fires downstream control targets after run)",
    "工具节点：Agent 可调用 · toolConfig 参数即端子（输入 0=控制 · 输出末位=控制）":
      "Tool node: agent-callable · toolConfig params are the ports (input 0 = control · output last = control)",
    "函数节点：JS 计算 · 入参对象 input → 返回值（输入 0=控制 · 输出末位=控制）":
      "Function node: JS compute · input object → return value (input 0 = control · output last = control)",
    "// 纯 JS 计算：入参对象 input = { 参数名: 值 }，return 即输出\n// 文本参数值为字符串 · 图像参数值为 { kind:\"image\", path }":
      "// Pure JS compute: input = { paramName: value }, return the result\n// Text params are strings · image params are { kind:\"image\", path }",
    /* ── 顶栏「工具库」工具库（app-tools.js · tools-store.js）── */
    "工具库": "Tool library",
    "从当前画布保存：": "Save from the current canvas:",
    "保存到工具库": "Save to library",
    "工具库不可用（本机存储接口未就绪）": "Tool library unavailable (local storage API not ready)",
    "当前画布没有工具节点": "No tool nodes on the current canvas",
    "当前画布没有可保存的工具节点": "No tool node to save on the current canvas",
    "已保存到工具库：": "Saved to tool library: ",
    "工具名（将用作标题与 Agent 调用名）：": "Tool name (used as title and agent call name):",
    "保存工具到工具库": "Save tool to library",
    "保存": "Save",
    "无法生成工具包（节点结构异常）": "Cannot build the tool package (bad node structure)",
    "工具库中已有同名工具「{name}」：覆盖保存？":
      "A tool named \"{name}\" already exists — overwrite it?",
    "覆盖工具": "Overwrite tool",
    "覆盖保存": "Overwrite & save",
    "保存失败：": "Save failed: ",
    "保存失败": "Save failed",
    "请先打开一个画布": "Open a canvas first",
    "工具包为空，无法插入": "Tool package is empty — cannot insert",
    "已插入工具：": "Inserted tool: ",
    "入 ": "In: ",
    "出 ": "Out: ",
    "内部 ": "inner ",
    " 节点 / ": " nodes / ",
    " 连线": " wires",
    "工具库为空：把画布中的工具节点保存到这里（上方下拉选择），即可在任意画布插入复用。":
      "The library is empty: save a tool node from the canvas (pick it in the dropdown above) and insert it into any canvas later.",
    "会话随时可调用": "Callable by sessions anytime",
    "内置": "Built-in",
    "随应用发版的内置工具：可直接插入 / 试跑，不能改名或删除":
      "Built-in tool shipped with the app: insert and test-run freely, but it cannot be renamed or deleted",
    "内置工具不可删除（它随应用发版，不是本机数据）":
      "A built-in tool cannot be deleted (it ships with the app, it is not local data)",
    "内置工具只能切换「会话随时可调用」，不能改名 / 改描述":
      "A built-in tool only supports the \"callable by sessions anytime\" switch — renaming / editing the description is not allowed",
    "函数条目不支持「会话随时可调用」（该链路跑的是工具节点的内部图）":
      "Function entries do not support \"callable by sessions anytime\" (that path runs a tool node's inner graph)",
    "开：Agent 会话随时可调用该工具；关：仅插入画布后运行（默认关）":
      "On: agent sessions may call this tool anytime; off: it runs only after being inserted into a canvas (default off)",
    "已开启随时可调用：": "Always-callable ON: ",
    "已关闭随时可调用：": "Always-callable OFF: ",
    "插入": "Insert",
    "把该工具插入当前画布（可重复插入）":
      "Insert this tool into the current canvas (may insert repeatedly)",
    "新工具名：": "New tool name:",
    "改名工具": "Rename tool",
    "已改名：": "Renamed: ",
    "改名失败：": "Rename failed: ",
    "改名失败": "Rename failed",
    "从工具库删除「{name}」？（不影响已插入画布的副本）":
      "Delete \"{name}\" from the library? (copies already inserted in canvases are not affected)",
    "删除工具": "Delete tool",
    "已删除工具：": "Deleted tool: ",
    "删除失败：": "Delete failed: ",
    "删除失败": "Delete failed",
    /* ── 工具库开放函数节点（保存 / 插入 / 清单两类徽标 · app-tools.js）── */
    "把选中的工具 / 函数节点保存到工具库":
      "Save the selected tool / function node to the library",
    "可保存：工具节点（带内部子图）/ 函数节点（单节点 JS 计算）":
      "Savable: tool nodes (with their inner graph) / function nodes (single-node JS compute)",
    "函数名（保存进工具库用 · 清单靠它辨认）：":
      "Function name (used when saving into the library · the list shows it):",
    "保存函数到工具库": "Save function to library",
    "当前画布没有工具 / 函数节点": "No tool / function nodes on the current canvas",
    "当前画布没有可保存的工具 / 函数节点":
      "No tool / function node to save on the current canvas",
    "【工具】": "[Tool] ",
    "【函数】": "[Function] ",
    "（未命名函数）": "(unnamed function)",
    "工具库中已有同名条目「{name}」：覆盖保存？":
      "A library entry named \"{name}\" already exists — overwrite it?",
    "函数节点包（JS 计算 · 单节点）":
      "Function node package (JS compute · single node)",
    "工具节点包（超级节点变体 · 带内部子图）":
      "Tool node package (super-node variant · with its inner graph)",
    "单节点（JS 计算）": "single node (JS compute)",
    "已插入函数：": "Inserted function: ",
    "新函数名：": "New function name:",
    "改名函数": "Rename function",
    "工具库为空：把画布中的工具节点 / 函数节点保存到这里（上方下拉选择），即可在任意画布插入复用。":
      "The library is empty: save a tool / function node from the canvas (pick it in the dropdown above) and insert it into any canvas later.",
    /* Agent 改画布时对工具 / 函数节点字段的校验回报（app-nodes.js applyNodePatch） */
    "需是参数数组（每项 {name, kind, list}）：":
      "must be a param array (each {name, kind, list}): ",
    "toolConfig 仅适用于工具节点": "toolConfig only applies to tool nodes",
    "toolConfig 需是对象：{ name, description, inputs, outputs }":
      "toolConfig must be an object: { name, description, inputs, outputs }",
    "jscode 仅适用于函数节点": "jscode only applies to function nodes",
    "toolConfig / fnName / jscode 仅适用于工具 / 函数节点":
      "toolConfig / fnName / jscode only apply to tool / function nodes",
  });
  /* ── 工具 / 函数节点 + 工具库 + func call 链路 —— 双语文案补全 ──
     菜单 / 设置面板 / 工具库对话框 / 随时可调用开关 /
     运行桥与主进程 tools-store.js 校验文案（T1 已在上面落了英文档占位，
     这里补齐运行期真正用到的其余词条）。 */
  Object.assign(EN, {
    /* 顶栏「工具库」按钮与工具库对话框（app-tools.js · app-boot.js btnTools 接线）
       —— 只管本机已保存的工具包 / 函数包；两类节点的创建入口在画布右键菜单「工具」下 */
    "工具库：打开本机已保存的工具 / 函数，插入到任意画布复用（新建这两类节点：画布空白处右键 → 工具）":
      "Tool library: open the tool / function packages saved on this machine and insert them into any canvas (to create these two node types: right-click the canvas → Tools)",
    /* 新建节点菜单（app.js canvasCreateMenuGroups · 「工具」一级菜单） */
    "工具（Agent 可调用 · 入参出参端子）":
      "Tool (agent-callable · input/output param ports)",
    "函数（JS 计算 · 自定义入参出参）":
      "Function (JS compute · custom input/output params)",
    /* 参数 / 来源标注 / 兜底名（app.js · app-canvas.js · tools-store.js） */
    "参数 ": "Param ",
    "未命名工具": "Unnamed tool",
    /* func call 运行桥（app-tools.js · app-nodes.js） */
    "工具节点不存在或已移除": "Tool node no longer exists or was removed",
    "工具「{name}」正在运行，请稍后再调用":
      "Tool \"{name}\" is running — try again shortly",
    "工具节点执行引擎未就绪": "Tool-node execution engine is not ready",
    "工具执行失败：": "Tool run failed: ",
    "工具包不可用或已删除：": "Tool package unavailable or deleted: ",
    "工具包不可用（无法实例化）：": "Tool package cannot be instantiated: ",
    "工具节点不在当前画布（可能已被删除），无法调用：":
      "Tool node is not on the current canvas (it may have been deleted) — cannot call: ",
    "工具「{name}」不可用（不在本次运行的可用清单中）":
      "Tool \"{name}\" is unavailable (not in this run's callable list)",
    "工具节点内部没有可执行的节点":
      "This tool node has no runnable inner nodes",
    "函数节点执行器未加载（js-exec.js）":
      "Function-node executor not loaded (js-exec.js)",
    "函数节点：请先填写 JS 代码": "Function node: write the JS code first",
    "函数节点执行失败：": "Function run failed: ",
    "函数节点完成": "Function run finished",
    /* 主进程 tools-store.js 校验 / 状态文案 */
    "工具库存储未初始化（缺少数据目录）":
      "Tool library storage is not initialized (no data directory)",
    "非法工具 id": "Invalid tool id",
    "工具不存在": "Tool does not exist",
    "工具包格式错误": "Malformed tool package",
    "工具名不能为空": "Tool name cannot be empty",
    /* 工具节点＝超级变体的端子契约（app.js · app-nodes.js · app-canvas.js）
       —— 参数即端子：输入 0=控制 · 1..N=入参；输出 0..M-1=出参 · 末位=控制 */
    " · 参数：": " · param: ",
    "拖入节点，或在此右键新建（左＝参数入 · 右＝参数出）":
      "Drag nodes in, or right-click here to create (left = param inputs · right = param outputs)",
    "没有空闲的输入参数端子": "No free input parameter port",
    "没有空闲的输入参数端子（请在工具设置里增加入参）":
      "No free input parameter port (add an input param in the tool settings)",
    "没有空闲的输出参数端子（请在工具设置里增加出参）":
      "No free output parameter port (add an output param in the tool settings)",
    "控制信号只能连到控制输入端子（端口 0）":
      "Control signals may only connect to the control input port (port 0)",
    "端口 0 是控制输入端子（不接受数据连线）":
      "Port 0 is the control input — data wires are not accepted",
    /* 控制端子只与控制端子相连（app-nodes.js · connectError 的端子归类闸） */
    "该端子是数据端子，不接受控制连线（控制线只能连到控制输入端子）":
      "This port is a data port — control wires are not accepted (a control wire may only connect to a control input port)",
    "该端子是控制输入端子，只接受控制连线（数据线请连数据端子）":
      "This port is the control input — only control wires are accepted (data wires go to data ports)",
    "控制输入端子已被数据线占用":
      "The control input already carries a data wire",
    /* 连线校验 · 端子类型匹配（app-nodes.js · connectError）：参数 kind 就是端子的准入类型 */
    "该工具节点的「设置」": "this tool node's Settings",
    "该函数节点的「设置」": "this function node's Settings",
    "「{p}」是图像参数，只接受图像来源：请把来源节点的图像输出端子连到它，或在{n}里把「{p}」改成文本参数":
      "“{p}” is an image parameter — only image wires may connect to it: run the source node's image output port into it, or change “{p}” to a text param in {n}",
    "「{p}」是文本参数，不接受图像来源：请在{n}里把「{p}」改成图像参数，或改接来源节点的文本输出端子":
      "“{p}” is a text parameter — image wires are not accepted: change “{p}” to an image param in {n}, or run the source node's text output port instead",
    /* 引擎按端子声明类型归一值（app.js normPortValueByKind · 节点摘要提示） */
    "「{p}」是文本端子，收到的图像已按其路径取文本":
      "“{p}” is a text port — the image it received was kept as its path text",
    /* 通用「试跑」台（app-tools.js · 工具节点复用函数节点的测试台） */
    "「测试」仅用于工具 / 函数节点": "“Test” is only for tool / function nodes",
    "工具节点试跑 · ": "Tool node trial run · ",
    "仅测试用，不参与画布运行：测试入参只注入本次执行，工具自身的输出与下游节点保持不变（不进撤销历史）。":
      "Test only — it does not take part in canvas runs: the test inputs are injected just for this execution, the tool's own outputs and its downstream nodes stay untouched (nothing enters the undo history).",
    "试跑会真实执行内部子图（{n} 个内部节点 · 可能产生真实 API 调用），只把结果读回这里，不改工具自身输出。":
      "A trial run really executes the inner graph ({n} inner nodes · may make real API calls); the results are only read back here, the tool's own outputs stay untouched.",
    "该工具内部还没有节点：先展开 / 进入子画布将参数接成处理图，再回来试跑。":
      "This tool has no inner nodes yet: expand or enter its sub-canvas, wire the params into a processing graph, then come back for a trial run.",
    "（内侧无节点汇入该输出端子）": "(no inner node feeds this output port)",
    "（无输出参数 · 在「设置」里添加）": "(no output params · add them in Settings)",
    "▶ 试跑工具": "▶ Trial-run tool",
    "试跑中…": "Trial running…",
    "工具试跑执行器未就绪（app-tools.js）": "Tool trial-run executor is not ready (app-tools.js)",
    "测试不改画布：工具自身的输出与下游取值仍是上次画布 ▶ 的结果。":
      "Testing leaves the canvas alone: the tool's own output and what downstream reads are still from the last ▶ on the canvas.",
    "测试（用自定义入参试跑内部子图 · 仅测试用，不参与画布运行）":
      "Test (trial-run the inner graph with custom inputs · test only, not part of canvas runs)",
  });
  /* ── 函数节点：JS 代码编辑器 / 脚手架 /「测试」台 /「开发」对话框 / 会话契约 —— 双语文案补全
     （app-canvas.js 节点卡片与设置面板 · app-tools.js 测试台与开发弹窗 · app-nodes.js 运行摘要 ·
      app.js 绑定会话注入的契约句子）。中文为真源，英文为译文。 */
  Object.assign(EN, {
    /* JS 代码编辑器工具条（app-canvas.js 节点卡片 · app-tools.js 测试台 · 同一 createJsCodeEditor） */
    "格式化": "Format",
    "按 2 空格缩进就地重排（不改动任何一行的内容）":
      "Re-indent in place with 2-space indents (never touching any line's content)",
    "已格式化": "Formatted",
    "代码已是格式化后的样子": "The code is already formatted",
    "代码为空 · 无需格式化": "Empty code — nothing to format",
    "行": "Ln",
    "JS 代码": "JS code",
    "与节点卡片同一编辑器 · 改动即时写回 node.jscode":
      "The same editor as on the node card · edits write straight back to node.jscode",
    /* 函数 / 工具卡片状态行与按钮 title（app-canvas.js） */
    "运行中…": "Running…",
    "已运行 ": "Ran ",
    "测试": "Test",
    "测试（自定义输入跑一次 JS · 仅测试用，不参与画布运行）":
      "Test (run the JS once with custom inputs · test only, not part of canvas runs)",
    "双击进入子画布": "Double-click to enter the sub-canvas",
    /* JS 脚手架（app-canvas.js 函数节点「设置」面板） */
    "生成脚手架": "Generate scaffold",
    "脚手架：按上面的入参 / 出参名生成 JS 模板（只在点击此按钮时写入，不随参数增删自动改写代码）":
      "Scaffold: build a JS template from the input / output param names above (written only when you click this button — adding or removing params never rewrites your code)",
    "以 input 取入参、末尾 return { 出参名: … }；代码为空直接写入，非空先确认覆盖":
      "Takes inputs through input and ends with return { outputName: … }; empty code is written straight in, non-empty code asks for confirmation first",
    "当前已有 JS 代码。用脚手架覆盖原有代码？（取消＝保留手写代码）":
      "There is already JS code here. Overwrite it with the scaffold? (Cancel = keep your own code)",
    "已生成函数脚手架": "Function scaffold generated",
    /* 函数节点「测试」台（app-tools.js openNodeTestDialog · 与工具节点试跑共用同一对话框骨架） */
    "函数节点测试 · ": "Function node test · ",
    "仅测试用，不参与画布运行：测试入参只注入本次执行，不写节点输出、不级联下游、不进撤销历史。":
      "Test only — it does not take part in canvas runs: the test inputs are injected just for this execution, the node's outputs are not written, nothing cascades downstream and nothing enters the undo history.",
    "JS 代码（return 的键 = 输出参数名 → 分发到各输出端子）":
      "JS code (the keys you return = output param names → dispatched to each output port)",
    "// 在此编写函数体：input = { 参数名: 值 }，return { 输出参数名: 值 }":
      "// Write the function body here: input = { paramName: value }, return { outputParamName: value }",
    "（无输入参数 · 在「设置」里添加）": "(no input params · add them in Settings)",
    "图像文件路径（留空 = 不注入该参数）": "Image file path (blank = this param is not injected)",
    "测试文本（留空 = 不注入该参数）": "Test text (blank = this param is not injected)",
    "输出端子": "Output ports",
    "（尚未运行测试）": "(no test run yet)",
    "错误：": "Error: ",
    "主输出（无出参）": "Main output (no output params)",
    "（return 未含该键 · 未分发）": "(this key is not in the return · not dispatched)",
    "▶ 运行测试": "▶ Run test",
    "测试不改画布：节点输出与下游取值仍是上次画布 ▶ 的结果。":
      "Testing leaves the canvas alone: this node's output and what downstream reads are still from the last ▶ on the canvas.",
    "测试执行器未就绪（app-nodes.js）": "Test executor is not ready (app-nodes.js)",
    "测试完成": "Test finished",
    "测试失败：": "Test failed: ",
    "工具正在运行，请稍后再试": "The tool is running — try again shortly",
    /* 函数节点运行摘要（app-nodes.js） */
    "函数节点完成 · 分发 ": "Function run finished · dispatched to ",
    " 个输出端子": " output ports",
    /* 函数节点「开发」对话框（app-tools.js developFunctionNode · 与开发节点「开发」同一套弹窗） */
    "未命名函数": "Untitled function",
    "函数名": "Function name",
    "节点标题": "Node title",
    "入参端子": "Input ports",
    "端子 0 = 控制入": "port 0 = control in",
    "出参端子": "Output ports",
    "末位 = 控制出": "the last one = control out",
    "会话工作区": "Session workspace",
    "请说明本次要修改或扩展这个函数的哪些行为；确认后将新建一个绑定该函数的会话并在其中运行。":
      "Describe which behaviour of this function to change or extend this round; confirming opens a new session bound to this function and runs it there.",
    "该函数还没有 JS 代码：会话会按现有入出参从零写出函数体。":
      "This function has no JS code yet: the session will write the body from scratch from the current input / output params.",
    "本次希望修改 / 扩展的内容": "What to change / extend this round",
    "例如：入参 text 去掉首尾空白再按标点分句；新增一个 image 入参并把路径原样透传到出参；出错时不要抛异常，改为 return { error }…":
      "e.g. trim the text input then split it on punctuation; add an image input and pass its path straight through to an output; on error don't throw — return { error } instead…",
    "请填写本次希望修改或扩展的内容":
      "Please describe what to change or extend this round",
    "确认 = 新会话后台运行（工作区 = 画布目录 · 标题「开发 · 函数名」· 只改这一个函数节点 · 不离开画布）· 取消 / 跳出不清空：再次打开本框接着上次写 · Ctrl+Enter 提交 · Esc 取消":
      "Confirm = runs in the background in a new session (workspace = the canvas folder · titled Dev · function name · it touches this one function node only · you stay on the canvas) · cancelling or stepping away keeps this text — reopen this box and continue where you left off · Ctrl+Enter submits · Esc cancels",
    "已创建函数开发会话「": "Function dev session created: ",
    /* 函数节点卡片「开发」按钮（app-canvas.js · 与开发节点按钮同款样式） */
    "弹窗填写本次要改 / 扩展的内容，确认后新建绑定该函数的会话在其中运行（只改这一个函数节点）":
      "A dialog collects what to change / extend this round; after you confirm, a new session bound to this function runs it (touching this one function node only)",
    " · 已绑定 ": " · bound: ",
    " 个开发会话": " dev sessions",
    "用会话改造 / 扩展本函数": "Rework / extend this function in a session",
    "函数开发会话未就绪（app-tools.js）":
      "Function dev session is not ready (app-tools.js)",
    /* 函数开发任务书 = 绑定会话契约（app-tools.js fnDevContractText · 每轮随系统提示注入） */
    "【函数开发任务书】": "[Function dev brief]",
    "函数节点": "Function node",
    " · 标题：": " · title: ",
    "节点描述：": "Node description: ",
    "入参端子（端子 0 = 控制入，1..N = 各入参，标注 ×N = 列表端子）：":
      "Input ports (port 0 = control in, 1..N = the input params; ×N marks an array port): ",
    "入参端子（端子 0 = 控制入，1..N = 各入参）：":
      "Input ports (port 0 = control in, 1..N = the input params): ",
    "出参端子（0..M-1 = 各出参，末位 = 控制出）：":
      "Output ports (0..M-1 = the output params, the last one = control out): ",
    "JS 代码：共 ": "JS code: ",
    " 行（真实内容以 mtnode_canvas_get 读到的为准）":
      " lines (the real content is whatever mtnode_canvas_get reads)",
    "本会话由该函数节点的「开发」按钮新建，只负责这一个函数；请以画布上该节点的真实配置为准，不要臆测，也不要顺手扩展无关功能。":
      "This session was created by this function node's Dev button and covers this one function only; rely on the node's real configuration on the canvas — never guess, and do not opportunistically extend anything unrelated.",
    "改动边界（必须严格遵守）：① 先用 mtnode_canvas_get 读该节点现状（detail:\"full\"、ids:[本节点标题]），再只用 mtnode_canvas_edit 的 update 补丁本节点的 jscode / inputs / outputs / description（必要时 setTitle 同步函数名）；② 不得新建、删除或改动画布上的任何其它节点，也不得增删连线；③「参数即端子」——改 inputs / outputs 参数表就是改端子，端子数一变已连的线就可能改指别的端子，因此只要动了参数表，就必须在回复里明确提醒用户回画布复核该节点的连线。":
      "Change boundary (strictly required): ① first read this node's current state with mtnode_canvas_get (detail:\"full\", ids:[this node's title]), then only patch this node's jscode / inputs / outputs / description through mtnode_canvas_edit's update (with setTitle as well when the function name needs syncing); ② never create, delete or move any other node on the canvas, and never add or remove wires; ③ params are ports — editing the inputs / outputs table edits the ports, and once the port count changes an existing wire may point at a different param, so whenever you touch the param table you must explicitly remind the user to re-check this node's wires on the canvas.",
    "本节点标题（mtnode_canvas_get 的 ids 与 update 的定位就用它）：":
      "This node's title (use it to target ids and update in mtnode_canvas_get): ",
    "执行契约：jscode 里 input = { 参数名: 值 }（文本参数值为字符串 · 图像参数值为 { kind:\"image\", path } · 标 ×N 的列表端子值恒为数组，即使只连了一条线也是数组，用 for / map 逐项处理，别当单值用），return { 输出参数名: 值 } 按参数名分发到各输出端子（输出端子一律单值，要返回多个值请返回数组给下游标 ×N 的列表入参端子）；保持 2 空格缩进的整洁排版（画布上的代码编辑器带高亮与格式化）。":
      "Execution contract: in jscode, input = { paramName: value } (a text param's value is a string · an image param's value is { kind:\"image\", path } · an ×N array port's value is always an array — even with a single wire in, so loop / map over it instead of treating it as one value), and return { outputParamName: value } is dispatched to each output port by name (output ports are strictly single-valued — to hand several values downstream, return an array aimed at a downstream ×N array input port); keep tidy 2-space indentation (the code editor on the canvas has highlighting and formatting).",
    "需求不明确时先问用户再动手；改完用一句话汇报改了什么（是否动了参数表）。":
      "If the requirement is unclear, ask the user before touching anything; when done, report in one sentence what changed (and whether you touched the param table).",
    "本次开发需求已在任务书中一次性完整给出：请按此执行，不要分两次会话输入重复提交（重复输入会造成上下文割裂与重复开工）。":
      "This round's requirements are already given in full inside the brief: execute them as stated and do not re-submit them through a second session message (duplicate input splits the context and restarts work).",
    "本会话是代码开发工作：不要调用 mtnode-dev-architect 技能（该技能仅用于在 MTNode 画布上构建开发节点架构，开发 / 细化绑定会话不需要它）。":
      "This session is code development work: do not invoke the mtnode-dev-architect skill (that skill only builds dev-node architecture on the MTNode canvas; dev / refinement bound sessions do not need it).",
    /* ===== Gate A：开发绑定会话不读画布（本节点 id 锚点 + 无读画布口径） ===== */
    "本节点 id：": "This node's id: ",
    "（本节点 id 仅供回复 / 文档中指认本模块；本会话不得用它修改画布上任何节点）":
      "(this node id is only for naming this module in replies / documents; this session must not use it to modify any node on the canvas)",
    "本会话不读取画布：mtnode_canvas_get 与 mtnode_app 本轮未注册，画布现状一律以本任务书为准；本会话执行期间与收尾都不得修改画布上的任何节点。":
      "This session does not read the canvas: mtnode_canvas_get and mtnode_app are not registered this round, so canvas state always comes from this brief; this session must not modify any node on the canvas during execution or when finishing.",
    "本轮不注册读画布与应用工具（mtnode_canvas_get / mtnode_app 调用即失败）：画布现状以宿主给的契约为准；本会话不改画布 —— 执行与收尾都不回写本节点的 title / note / devStatus / devFiles，也不改其它任何节点、连线或画布内容。":
      "The canvas-reading and app tools are not registered this round (a call to mtnode_canvas_get / mtnode_app fails outright): canvas state comes from the contract the host gave you; this session does not edit the canvas — during execution or when finishing, it never writes back this node's title / note / devStatus / devFiles, and it changes no other node, wire, or canvas content.",
    /* 工具节点「开发」= 绑定该工具的会话（app-tools.js toolDev* · 与函数节点同一机制，
       作用域 = 本工具节点 + 内部子图；可改 toolConfig 参数 / 描述 / 重建内部子图） */
    "工具开发会话未就绪（app-tools.js）": "Tool dev session is not ready (app-tools.js)",
    "弹窗填写本次要改 / 扩展的内容，确认后新建绑定该工具的会话在其中运行（只改这一个工具节点与它的内部子图）":
      "A dialog collects what to change / extend this round; after you confirm, a new session bound to this tool runs it (touching this one tool node and its inner sub-graph only)",
    "用会话改造 / 扩展本工具": "Rework / extend this tool in a session",
    "【工具开发任务书】": "[Tool dev brief]",
    "工具描述（toolConfig.description · 给 Agent 看的用途说明）：":
      "Tool description (toolConfig.description · the purpose note shown to agents): ",
    "内部子图：": "Inner sub-graph: ",
    "内部子图": "Inner sub-graph",
    "（工具的行为 = 它的内部子图：点 ▶ 或 Agent 调用时按拓扑执行）":
      "(a tool's behavior IS its inner sub-graph: ▶ or an agent call executes it topologically)",
    "（尚无内部节点：会话会按入出参从零搭建内部子图）":
      "(no inner nodes yet: the session will build the inner sub-graph from scratch against the in/out params)",
    " 个内部节点 / ": " inner node(s) / ",
    " 条内部连线": " inner wire(s)",
    "工具名": "Tool name",
    "本会话由该工具节点的「开发」按钮新建，只负责这一个工具节点（含其内部子图）；请以画布上该节点与内部子图的真实配置为准，不要臆测，也不要顺手扩展无关功能。":
      "This session was created by this tool node's Dev button and covers this one tool node (including its inner sub-graph) only; rely on the node's and the sub-graph's real configuration on the canvas — never guess, and do not opportunistically extend anything unrelated.",
    "改动边界（必须严格遵守）：① 先用 mtnode_canvas_get 读该工具节点现状（detail:\"full\"、ids:[本节点标题]；内部子图节点会随画布快照返回），再动手；② 对工具定义用 mtnode_canvas_edit 的 update 补丁本工具节点的 toolConfig（name / description / inputs / outputs，必要时 setTitle 同步工具名）；调整工具行为则在**本工具内部**新建 / 删除 / 改动节点并连线（这些子节点 parentSuperId = 本工具 id，本会话创建的子节点也必须挂在它下面）；③ 不得新建、删除或改动任何其它画布节点，也不得增删本工具内外部之外的连线；④「参数即端子」——改 toolConfig 的 inputs / outputs 参数表就是改端子，端子数一变已连的线就可能改指别的端子，因此只要动了参数表，就必须在回复里明确提醒用户回画布复核该节点的连线。":
      "Change boundary (strictly required): ① first read this tool node's current state with mtnode_canvas_get (detail:\"full\", ids:[this node's title]; the inner sub-graph nodes come back with the canvas snapshot), then start editing; ② for the tool definition, patch this tool node's toolConfig (name / description / inputs / outputs) with mtnode_canvas_edit's update (add setTitle to sync the tool name when needed); to change behavior, create / delete / modify nodes and wires **inside this tool** (those child nodes have parentSuperId = this tool's id, and any node you create must also hang under it); ③ never create, delete or modify any other canvas node, and never add/remove wires outside this tool; ④ params are ports — editing the toolConfig inputs / outputs table edits the ports, and once the port count changes an existing wire may point at a different param, so whenever you touch the param table you must explicitly remind the user to re-check this node's wires on the canvas.",
    "运行语义：工具节点 = super + tool:true 变体，Agent 调用 / 画布 ▶ 执行的都是它的内部子图（先补跑上游，再按拓扑执行内部节点），内部没有可执行节点会报「工具节点内部没有可执行的节点」。内部子图里想放什么就放什么（文本处理 / 智能任务 / 函数 / 保存等），输出要接回本工具的外侧输出端子（内侧汇流），入参由外侧输入端子（参数即端子）注入。":
      "Runtime semantics: a tool node is a super + tool:true variant — both agent calls and canvas ▶ execute its inner sub-graph (upstream first, then inner nodes topologically); with no runnable inner node it errors with “the tool node has no runnable node inside”. Put whatever you like inside (text processing / agent task / function / save…); feed outputs back to the tool's outer output ports (inner confluence) — inputs come from the outer input ports (params are ports).",
    "请说明本次要修改或扩展这个工具的哪些行为；确认后将新建一个绑定该工具的会话并在其中运行（可改 toolConfig 参数 / 描述，也可重建内部子图）。":
      "Describe what behavior to change or extend on this tool; on confirm, a new session bound to this tool runs it (you may change toolConfig params / description, or rebuild the inner sub-graph).",
    "该工具的行为 = 它的内部子图：会话可以按现有入出参从零搭建内部子图，也可以只调参数 / 描述不改内部图。":
      "A tool's behavior is its inner sub-graph: the session can build one from scratch against the current in/out params, or you can just adjust params / description without touching the inner graph.",
    "例如：把内部子图换成先提取关键词再查库的两段流程；新增一个 image 入参并透传到内部函数节点；出错时返回错误文本而不是抛异常…":
      "e.g. rebuild the inner sub-graph into a two-stage flow (extract keywords, then query); add an image input and pass it through to an inner function node; return an error text instead of throwing…",
    "确认 = 新会话后台运行（工作区 = 画布目录 · 标题「开发 · 工具名」· 只改这一个工具节点与它的内部子图 · 不离开画布）· 取消 / 跳出不清空：再次打开本框接着上次写 · Ctrl+Enter 提交 · Esc 取消":
      "Confirm = a new session runs in the background (workspace = canvas folder · title “Dev · tool name” · only this tool node and its inner sub-graph · stay on the canvas) · Cancel / escape keeps your draft for next time · Ctrl+Enter submits · Esc cancels",
    "已创建工具开发会话「": "Created tool dev session “",
    "已调整参数顺序：端子与已连数据线随参数移位":
      "Param order updated: ports and connected wires moved with the param",
    "拖动把手调整参数顺序（端子与已连数据线随参数移位 · ▲▼ 可逐格移动）":
      "Drag the handle to reorder params (ports and wired data follow the param · ▲▼ move one step)",
    "第 {n} 条输入": "input {n}",
    " · 来源：": " · source: ",
    "（右键断开这一条）": " (right-click to disconnect this one)",
    "空槽：再拖一条数据线进本端子（可无限接）":
      "Empty slot: drag another data wire into this port (no limit)",
    "已断开该槽位对应的数据线": "Disconnected the wire of that slot",
    "该槽位没有连线": "That slot has no wire",
    /* ── 函数 / 工具节点修复：独立线程执行 + 运行队列 + 停止即回收 —— 新文案英文档
       （app.js stopNode / stopAllRuns / 删除节点回收 toast · app-nodes.js 收尾与并发闸 ·
        renderer/js-exec.js 异步执行器错误兜底。中文为真源，英文为译文。） */
    "已取消该节点的排队运行": "Cancelled this node's queued run",
    "已停止并回收 ": "Stopped and reclaimed ",
    " 个进程": " process(es)",
    "已停止该节点的运行": "Stopped this node's run",
    "已请求停止运行…": "Stop requested…",
    "已回收 ": "Reclaimed ",
    "回收 ": "reclaimed ",
    " · 回收 ": " · reclaimed ",
    "执行失败": "Execution failed",
    "函数运行没有返回结果（主进程 fn:run）":
      "Function run returned no result (main-process fn:run)",
    "函数运行时未就绪（主进程未暴露 fn:run）——请重启 MTNode 后再试":
      "Function runtime not ready (fn:run not exposed by the main process) — restart MTNode and try again",
    "函数运行时未就绪（主进程未暴露 fn:cancel）":
      "Function runtime not ready (fn:cancel not exposed by the main process)",
    "缺少 runId": "runId is missing",
    "代码为空": "The code is empty",
  });
  /* ── 素材库（顶栏按钮 · renderer/app-assets.js 左右栏对话框 · assets-store.js 主进程）──
     中文为真源，以下为英文档译文。 */
  Object.assign(EN, {
    /* 顶栏入口 */
    "素材库": "Asset library",
    "素材库：跨画布的本机素材仓库，按分类打包文本 / 图像 / 音频 / 视频；素材节点引用库内容，删掉画布素材仍在":
      "Asset library: a cross-canvas content vault on this machine — pack text / image / audio / video into categories; asset nodes reference the library, so content survives deleting the canvas",
    "素材库不可用（本机存储接口未就绪）":
      "Asset library unavailable (local storage bridge not ready)",
    /* 首次引导 · 根目录 */
    "读取素材库位置失败：": "Failed to read the asset-library location: ",
    "素材库还没有指定保存位置。\n\n下一步请选择一个文件夹作为素材库根目录（项目目录）。根目录之后不建议改动：更换后内容会重新扫描，已绑定的素材节点需要手动重新绑定。":
      "The asset library has no save location yet.\n\nIn the next step, pick a folder to serve as the library root (project folder). Changing it later is not recommended: a new root triggers a rescan and bound asset nodes must be rebound by hand.",
    "指定素材库根目录": "Set the asset-library root",
    "暂不设置": "Not now",
    "选择素材库根目录（项目目录）": "Choose the asset-library root (project folder)",
    "未选择文件夹，素材库暂不打开": "No folder chosen — the asset library stays closed",
    "设置素材库根目录失败：": "Failed to set the asset-library root: ",
    "素材库根目录：": "Asset-library root: ",
    "更换素材库根目录会导致内容重新扫描：\n\n· 新目录里没有的素材，其节点会变成「素材失联」（节点保留，可手动重新绑定）\n· 旧目录里的文件不会被删除，改回原目录即可再次识别\n\n确定更换？":
      "Changing the asset-library root rescans everything:\n\n· assets missing from the new folder turn into “asset unavailable” nodes (nodes are kept and can be rebound by hand)\n· nothing in the old folder is deleted — switch back and it is recognised again\n\nChange it?",
    "更换素材库根目录": "Change the asset-library root",
    "选择新目录": "Choose a new folder",
    "选择新的素材库根目录": "Choose the new asset-library root",
    "已更换素材库根目录并重新扫描：": "Asset-library root changed and rescanned: ",
    "扫描素材库失败：": "Failed to scan the asset library: ",
    "素材库根目录（在资源管理器里也可直接整理）":
      "Asset-library root (you may also tidy it directly in the file manager)",
    "更改根目录…": "Change root…",
    "更换后内容会重新扫描，失联的素材节点需手动重新绑定":
      "Changing it rescans the library; unavailable asset nodes need a manual rebind",
    "重新扫描素材库目录": "Rescan the asset-library folder",
    /* 左栏 · 分类 */
    "分类": "Categories",
    "分类 ": "Categories: ",
    "新建文件夹": "New folder",
    "在当前选中的分类下新建文件夹（右键分类可重命名 / 删除）":
      "Create a folder under the selected category (right-click a category to rename / delete)",
    "全部素材（根目录）": "All assets (root)",
    "根目录": "Root",
    "还没有分类：点上方「＋ 新建文件夹」，或直接在资源管理器里建目录。":
      "No categories yet: click “＋ New folder” above, or create folders directly in the file manager.",
    "在此新建子文件夹": "New subfolder here",
    "新建文件夹（分类）名称：": "Name of the new folder (category):",
    "新建分类 · {where}": "New category · {where}",
    "新建文件夹失败：": "Failed to create the folder: ",
    "已新建分类：": "Category created: ",
    "新的文件夹名称：": "New folder name:",
    "重命名分类": "Rename category",
    "重命名「{name}」…": "Rename “{name}”…",
    "已重命名为：": "Renamed to: ",
    "删除「{name}」": "Delete “{name}”",
    /* 删除分类：空 / 非空都能删（整只文件夹进回收站）。有内容时确认框把里面的东西数清 ——
       不再是「非空不许删」，所以这里给的是「会一起没掉什么」，不是「请先移走」。 */
    "删除分类「{name}」？\n\n里面还有 {n} 个素材（共 {m} 条内容）和 {k} 个子分类，会一起删进系统回收站（可在资源管理器里还原）。\n· 引用这些素材的「素材」节点会变成「素材失联」（节点与连线保留，可手动重新绑定）\n· 文件夹里手工放进去的其它文件也一并进回收站\n\n确定删除？":
      "Delete the category “{name}”?\n\nIt still holds {n} asset(s) ({m} content item(s)) and {k} subcategor(ies) — all of them go into the system recycle bin together (you can restore them in the file manager).\n· “Asset” nodes referencing them will show “asset unavailable” (nodes and wires stay; you can rebind by hand)\n· Any other files you dropped into that folder go to the recycle bin as well\n\nDelete it?",
    "删除分类「{name}」？\n\n文件夹会删进系统回收站（可在资源管理器里还原）。":
      "Delete the category “{name}”?\n\nThe folder is deleted into the system recycle bin (you can restore it in the file manager).",
    "删除分类": "Delete category",
    "已删除分类（含 {n} 个素材，进系统回收站）：":
      "Category deleted with {n} asset(s) (moved to the system recycle bin): ",
    "已删除分类（进系统回收站）：":
      "Category deleted (moved to the system recycle bin): ",
    "在资源管理器中打开": "Open in file manager",
    "打不开该目录": "Cannot open that folder",
    /* 右栏 · 素材卡片 */
    "当前位置：": "Current location: ",
    "素材": "Asset",
    "新建素材": "New asset",
    "在当前分类下新建一个素材": "Create an asset in the current category",
    "上传为新素材": "Upload as new asset",
    "选择一个本机文件夹 → 按文件类型自动变成当前分类下的新素材（内容复制入库）":
      "Pick a local folder → it becomes a new asset in the current category, files mapped by type (contents copied into the library)",
    "显示名称": "Display name",
    "例如：主角人设 / 片头音乐": "e.g. Protagonist profile / Opening music",
    "新建素材 · {where}": "New asset · {where}",
    "请填写显示名称": "Please fill in a display name",
    "新建素材失败：": "Failed to create the asset: ",
    "已新建素材：": "Asset created: ",
    "（暂无内容）": "(no content yet)",
    /* 素材包类型徽标（左树素材行 · 卡片 · 详情头）：单一类型复用「文本 / 图像 / 音频 / 视频」词条 */
    "混合": "Mixed",
    "内容类型：": "Content types: ",
    "选择要上传为素材的文件夹": "Choose the folder to upload as an asset",
    "上传失败：": "Upload failed: ",
    "已上传为素材：{name}（内容 {n} 条）": "Uploaded as asset “{name}” ({n} item(s))",
    "已上传为素材：{name}（内容 {n} 条 · 跳过 {s} 个不支持的文件）":
      "Uploaded as asset “{name}” ({n} item(s), {s} unsupported file(s) skipped)",
    "删除素材（删进系统回收站，可在资源管理器里还原）":
      "Delete the asset (deleted into the system recycle bin, restorable in the file manager)",
    "删除素材「{name}」？\n\n素材文件夹会删进系统回收站（可在资源管理器里还原）。已插入画布的「素材」节点会显示为「素材失联」，节点本身保留。":
      "Delete the asset “{name}”?\n\nIts whole folder is deleted into the system recycle bin (you can restore it in the file manager). “Asset” nodes already on a canvas will show “asset unavailable”, but the nodes themselves stay.",
    "删除素材": "Delete asset",
    "已删除素材（进系统回收站）：":
      "Asset deleted (moved to the system recycle bin): ",
    "素材文件夹名（资源管理器里看到的名字）：":
      "Asset folder name (what the file manager shows):",
    "重命名素材文件夹": "Rename asset folder",
    "已重命名文件夹：": "Folder renamed: ",
    "移动素材到分类": "Move asset to category",
    "移动到分类…": "Move to category…",
    "移动": "Move",
    "目标分类": "Target category",
    "移动失败：": "Move failed: ",
    "已移动到：": "Moved to: ",
    "该分类下还没有素材：可先在素材库里「新建素材」或「上传为新素材」，再回来绑定。":
      "No assets in this category yet: use “New asset” or “Upload as new asset” first, then come back to bind one.",
    "这里还是空的。点上方「新建素材」建一个空素材，或「上传为新素材」把本机一个文件夹整体收进库里。":
      "Nothing here yet. Click “New asset” above for an empty one, or “Upload as new asset” to bring a whole local folder into the library.",
    "该分类本身没有素材，内容在子分类里（左侧选择子分类查看）。":
      "This category holds no assets of its own — its content lives in subcategories (pick one on the left).",
    "文件夹：": "Folder: ",
    /* 卡片动作 · 绑定 · 插入（「设置」「删除」「取消」等通用词已有译文，不再重复） */
    "绑定素材库内容": "Bind library content",
    "绑定这个素材": "Bind this asset",
    "用该素材绑定当前节点": "Bind the current node to this asset",
    "设置…": "Settings…",
    "改显示名称 / 描述，管理内容条目（每条＝节点的一对端子）":
      "Edit display name / description and manage content items (each item = one port pair on the node)",
    "素材设置界面尚未就绪": "Asset settings are not ready yet",
    "插入到画布": "Insert into canvas",
    "在当前画布创建一个绑定该素材的「素材」节点（库内容不变）":
      "Create an “Asset” node bound to this asset on the current canvas (library content untouched)",
    "复制到画布": "Copy to canvas",
    "打开文件夹": "Open folder",
    "在文件资源管理器中打开这个素材的文件夹":
      "Open this asset's folder in the file manager",
    "素材内容": "Asset content",
    "点击查看内容（可编辑 / 更换）": "Click to view the content (editable / replaceable)",
    "重新命名（文件夹）": "Rename (folder)",
    "素材节点尚未就绪": "Asset nodes are not ready yet",
    "插入失败：无法创建素材节点": "Insert failed: cannot create the asset node",
    "已插入素材：": "Asset inserted: ",
    /* ── 素材节点（kind asset）：内容条目即端子 · body 内容列表 ── */
    "视频": "Video",
    "无效的输入端子": "Invalid input port",
    "内容 ": "Item ",
    "内容端子 ": "Content port ",
    "内容端子「": "Content port “",
    "输出内容「": "Outputs content “",
    "更换": "Replace",
    "素材节点（绑定素材库 · 内容条目即端子）":
      "Asset node (binds the library · content items are the ports)",
    "）· 与同名输出端子一一对应 · 连入即同步到该条目":
      "” · pairs 1:1 with the output port of the same name · wiring in syncs into that item",
    "）· 文本给字符串 · 图像 / 音频 / 视频给 file:/// URL":
      "” · text yields a string · image / audio / video yield a file:/// URL",
    "左右两个端子同一条目：输出即读出该条目的内容，连入只做检查，点「覆盖」才写入素材库":
      "Both ports are the same item: the output reads that item back, wiring in only checks — click “Overwrite” to write it into the library",
    "覆盖素材内容": "Overwrite asset content",
    "覆盖素材内容？": "Overwrite asset content?",
    "把该端子连入的内容覆盖进素材库（写前会再确认一次，可 Ctrl+Z 撤销）":
      "Overwrite the library item with what this port carries (you will be asked to confirm first · Ctrl+Z to undo)",
    "该端子连入的内容与素材库一致，无需覆盖":
      "This port already matches the library item — nothing to overwrite",
    "用该端子连入的内容覆盖素材库条目「{title}」？原有内容会进历史版本，可 Ctrl+Z 撤销。":
      "Overwrite the library item “{title}” with what this port carries? The previous content goes into version history · Ctrl+Z to undo.",
    "内容文件缺失（素材库里的实体文件不在了）":
      "Content file is missing (the physical file is gone from the asset library)",
    "在此输入文本内容（直接写进素材库该条目）":
      "Type text here (written straight into this library item)",
    "（无图像）点击下方按钮选择": "No image — pick one with the button below",
    "（无内容）点击下方按钮选择": "No content — pick a file with the button below",
    "从本机选一个文件复制进素材库该条目（旧内容先进版本目录，可撤销）":
      "Pick a local file and copy it into this library item (the old one goes to the versions folder first · undoable)",
    "该素材还没有内容：点上方「设置」添加文本 / 图像 / 音频 / 视频":
      "This asset has no content yet: open Settings above to add text / image / audio / video items",
    "写入素材库失败：": "Failed to write into the asset library: ",
    "已保存到素材库：": "Saved to the library: ",
    "已更换内容：": "Content replaced: ",
    "素材节点是内容来源，不接受控制连线（▶ 请连真正要执行的节点）":
      "An asset node is a content source and takes no control wire (point ▶ at nodes that actually run)",
    "该素材还没有内容条目：请先在素材库为它添加内容":
      "This asset has no content items yet: add some in the asset library first",
    "没有与这条线类型匹配的空闲内容端子":
      "No free content port matches this wire’s type",
    "该内容端子已被占用": "That content port is already taken",
    "「{t}」端子是{w}内容，只接受{w}来源（当前是 {g}）：请改接同类来源，或在素材设置里换一个端子":
      "The “{t}” port holds {w} content and only accepts a {w} source (this one is {g}): rewire a matching source, or pick another port in the asset settings",
  });
  /* ── 素材库 · 素材节点的绑定 / 上传 / 失联（renderer/app-assets.js · app-canvas.js）── */
  Object.assign(EN, {
    /* 节点 body：未绑定 / 失联两块引导 */
    "未绑定素材": "Not bound to an asset",
    "绑定＝引用素材库里已有的素材；上传＝把本机一个文件夹整体收进素材库并绑定。内容永远存在素材库里，删掉画布也不会丢。":
      "Bind references an asset already in the library; Upload takes a local folder into the library and binds it. Content lives in the library — deleting the canvas never loses it.",
    "素材失联": "Asset out of reach",
    "素材库里找不到这个素材了（可能已被删除，或素材库根目录换过）。端子与标题保持原样，重新指定根目录或重新绑定即可接上。":
      "The library no longer has this asset (deleted, or the root folder changed). Ports and titles stay exactly as they were — set the root back or rebind to reconnect.",
    "素材库根目录还没有指定：指定后这里会自动接上。":
      "No asset-library root set yet — once you do, this reconnects by itself.",
    "重新绑定…": "Rebind…",
    "绑定…": "Bind…",
    "上传…": "Upload…",
    "重新扫描": "Rescan",
    "打开素材库": "Open asset library",
    "打开素材库，选一个已有素材绑定到本节点（端子按标题保号）":
      "Open the library and pick an existing asset to bind (ports keep their numbers by title)",
    "选本机一个文件夹 → 整体收进素材库成为新素材 → 自动绑定本节点":
      "Pick a local folder → it becomes a new asset in the library → this node binds to it",
    "在资源管理器里找回素材夹 / 换回原根目录后，点这里重新识别":
      "After you restore the asset folder in Explorer (or switch the root back), rescan here",
    "打开素材库对话框（左分类 · 右素材 · 可更改根目录）":
      "Open the asset-library dialog (categories left · assets right · root changeable)",
    "改显示名称 / 描述，并添加内容条目（每条＝一对端子）":
      "Edit display name / description and add content items (each item = one pair of ports)",
    "内容暂不可读：素材失联，重新绑定或找回素材夹后自动恢复":
      "Content unavailable while the asset is out of reach — it comes back after rebinding or restoring the folder",
    /* 浏览态（未 focus）轻量摘要：只列条目标题 + 类型，不读库、不渲染内容本体 */
    "绑定后未选中只显示内容标题；点选本节点才逐条展开内容本体。":
      "Once bound, an unselected node shows item titles only; select it to expand each item’s content.",
    "素材失联：点选本节点后看详情 / 重新绑定":
      "Asset out of reach: select this node to see details / rebind",
    "该素材还没有内容：点选本节点后逐条查看 / 添加":
      "This asset has no content yet: select this node to review / add items",
    "点选本节点后查看 / 编辑内容本体":
      "Select this node to view / edit the content itself",
    /* 头部徽标与 ⚙ */
    "失联": "Lost",
    "还没有绑定素材：在下方点「绑定…」或「上传…」":
      "No asset bound yet: use “Bind…” or “Upload…” below",
    "素材失联：素材库里找不到它了（端子与连线仍按原样保留）":
      "Asset out of reach: the library can’t find it (ports and wires kept as they were)",
    "素材：": "Asset: ",
    "库内路径：": "Library path: ",
    "内容条目：": "Content items: ",
    "设置（显示名称 / 描述 / 内容条目 · 改的就是素材库里那一份）":
      "Settings (display name / description / content items — edits the copy in the library)",
    /* 右键菜单 */
    "重新绑定素材库…（选一个素材接上 · 连线按标题保留）":
      "Rebind library asset… (pick an asset · wires follow titles)",
    "绑定素材库…（引用库里已有素材）": "Bind library asset… (reference something already in the library)",
    "上传…（选本机一个文件夹收进素材库并绑定）":
      "Upload… (take a local folder into the library and bind it)",
    "设置（名称 / 描述 / 内容）": "Settings (name / description / content)",
    "换绑到别的素材…（端子按标题保号）":
      "Rebind to another asset… (ports keep their numbers by title)",
    /* 绑定 / 上传动作回执 */
    "已绑定素材：": "Asset bound: ",
    "已绑定素材：{name}（还没有内容，点节点上的「设置」添加）":
      "Asset bound: {name} (no content yet — open “Settings” on the node to add some)",
    "已重新绑定：{name} · {n} 条对不上标题的连线已断开（Ctrl+Z 可撤销）":
      "Rebound: {name} · {n} wires whose titles no longer match were cut (Ctrl+Z undoes it)",
    "素材库里的内容条目变了：{n} 条对不上标题的连线已断开（可撤销）":
      "The asset’s content items changed in the library: {n} wires with no matching title were cut (undoable)",
    "选择要上传的文件夹（其中的文本 / 图像 / 音频 / 视频会成为素材内容）":
      "Choose the folder to upload (its text / image / audio / video files become the asset’s content)",
    "未选择文件夹，取消上传": "No folder chosen — upload cancelled",
    "已上传到素材库，但绑定节点失败": "Uploaded into the library, but binding the node failed",
    "其中 {n} 个文件类型素材库不收，已跳过": "{n} file(s) of unsupported types were skipped",
    "素材库根目录还没指定：先指定位置，或重新绑定到别处的素材":
      "No asset-library root yet: set one first, or rebind to an asset elsewhere",
    "该素材在素材库里找不到了：选一个素材重新绑定（连线按标题保留）":
      "This asset is no longer in the library: pick one to rebind (wires follow titles)",
    "还没有绑定素材，没有可打开的文件夹": "Nothing is bound yet — there is no folder to open",
    "素材已失联：在素材库里找不到对应文件夹":
      "Asset out of reach: no matching folder found in the library",
    "先绑定素材库内容，再设置它": "Bind the asset first, then edit its settings",
    "素材已失联，先重新绑定才能设置":
      "The asset is out of reach — rebind it before changing settings",
    "素材库界面未就绪（app-assets.js）": "Asset library UI not ready (app-assets.js)",
    "已重新扫描素材库": "Asset library rescanned",
    "重新扫描素材库失败": "Failed to rescan the asset library",
  });

  /* ── 素材库 · 素材设置对话框（renderer/app-assets.js · openAssetSettings）──
     条目 CRUD 与「条目即端子」的文案；中文为真源，以下为英文译文。 */
  Object.assign(EN, {
    "读取失败": "read failed",
    "素材设置": "Asset settings",
    "正在读取素材库…": "Reading the asset library…",
    "该素材已不在素材库里（可能被删除或换了根目录），素材设置已关闭":
      "This asset is no longer in the library (deleted, or the root folder changed) — asset settings closed",
    "素材设置（绑定选择中）": "Asset settings (while binding)",
    "素材文件夹（资源管理器里也能直接整理）":
      "Asset folder (you can also tidy it up in the file explorer)",
    "打开这个素材在素材库里的文件夹": "Open this asset's folder in the library",
    "重新扫描素材库，取库里此刻的内容":
      "Rescan the library and pick up what is on disk right now",
    "这个素材装的是什么（只给人看，不影响端子）":
      "What this asset holds (for humans only; does not affect ports)",
    "内容条目＝节点上的一对端子：这里的标题就是端子名，这里的顺序就是端子顺序。改动直接写进素材库，画布上所有绑定该素材的节点一起跟着变。":
      "A content item IS a pair of ports on the node: its title here is the port label, its order here is the port order. Edits go straight into the library, and every node bound to this asset follows.",
    "＋ 文本": "＋ Text",
    "＋ 图像": "＋ Image",
    "＋ 音频": "＋ Audio",
    "＋ 视频": "＋ Video",
    "从本机选图像文件复制入库（可多选）":
      "Pick image files on this machine and copy them into the library (multi-select)",
    "从本机选音频文件复制入库（可多选）":
      "Pick audio files on this machine and copy them into the library (multi-select)",
    "从本机选视频文件复制入库（可多选）":
      "Pick video files on this machine and copy them into the library (multi-select)",
    "还没有内容：点上方「＋ 文本」上传本机文本文件（或手写一条空正文），或「＋ 图像 / 音频 / 视频」从本机选文件入库。":
      "No content yet: press ＋ Text above to upload local text files (or start an empty body), or ＋ Image / Audio / Video to import those.",
    "拖动把手调整内容顺序（端子与已连数据线随内容移位 · ▲▼ 可逐格移动）":
      "Drag the handle to reorder items (ports and their wires move with them · ▲▼ move one step)",
    "上移一条内容（端子序号一并跟着走）":
      "Move this item up (its port index moves with it)",
    "下移一条内容（端子序号一并跟着走）":
      "Move this item down (its port index moves with it)",
    "端子名（会显示在节点左右两端的端子上）":
      "Port label (shown on both sides of the node)",
    "类型在建立时定下（要换类型请新建一条并删掉这条）":
      "The type is fixed at creation (to change it, add a new item and delete this one)",
    "第 {n} 个输入端子 ↔ 第 {n} 个输出端子": "Input port {n} ↔ output port {n}",
    "连入只做检查，点端子上的「覆盖」并确认才写入素材库，输出即读出该条内容":
      "Wiring in only checks; press “Overwrite” on the port and confirm to write it into the library — reading out yields this item's content",
    "（还没有内容）": "(no content yet)",
    "库里的实体文件不在了：换一份内容即可恢复":
      "The file is gone from the library: pick new content to restore it",
    "编辑文本": "Edit text",
    "更换文件": "Replace file",
    "打开正文编辑框（写进素材库该条目的 .txt）":
      "Open the body editor (written into this item's .txt in the library)",
    "从本机选一个文件复制进来顶掉旧内容（旧内容进版本目录）":
      "Pick a local file to copy in over the old one (the old one goes to the versions folder)",
    "删除这条内容（端子一并消失 · 实体文件进回收站）":
      "Delete this item (its ports disappear · the file goes to the trash)",
    "保存素材资料失败：": "Failed to save the asset details: ",
    "已保存素材资料": "Asset details saved",
    "改内容标题失败：": "Failed to rename the content item: ",
    "已改端子名：{old} → {now}": "Port renamed: {old} → {now}",
    "调整内容顺序失败：": "Failed to reorder content: ",
    "已调整内容顺序：端子与已连数据线随内容移位":
      "Content reordered: ports and their wires moved with the items",
    "删除内容「{name}」？\n\n· 节点上这一对端子会消失，挂在它上面的连线一并断开（Ctrl+Z 可复原节点与连线）\n· 实体文件删进系统回收站（可在资源管理器里还原）":
      "Delete the content item “{name}”?\n\n· The pair of ports on the node disappears and any wire on them is cut (Ctrl+Z restores the node and the wires)\n· The file is deleted into the system recycle bin (you can restore it in the file manager)",
    "删除内容": "Delete content",
    "删除内容失败：": "Failed to delete the content item: ",
    "已删除内容：{name}（端子与连线可撤销 · 文件进系统回收站）":
      "Content deleted: {name} (ports and wires undoable · file moved to the system recycle bin)",
    "添加文本内容": "Add text content",
    "标题（＝端子名）": "Title (= port label)",
    "正文": "Body",
    "添加内容失败：": "Failed to add content: ",
    "已添加内容：{name}（末尾多出一对端子）":
      "Content added: {name} (a new pair of ports at the end)",
    "选择要添加的": "Pick the ",
    "文件（可多选）": " files to add (multi-select)",
    "已添加 {n} 条内容": "Added {n} content item(s)",
    "已添加 {n} 条内容（{s} 个文件类型素材库不收，已跳过）":
      "Added {n} content item(s) ({s} file type(s) the library does not accept were skipped)",
    "编辑文本内容 · {name}": "Edit text content · {name}",
    "保存到素材库": "Save to library",
    "写进素材库该条目的 .txt（旧内容先进版本目录 · 可撤销）":
      "Written into this item's .txt in the library (the old one goes to the versions folder first · undoable)",
    /* ── 文本条目也能「上传文件」：＋文本 的两条路 / 表单里的上传 / 条目行上传 ── */
    "新建文本内容：可从本机上传文本文件（可多选），也可手写一条空的正文":
      "New text content: upload text files from this machine (multi-select), or start an empty body and type it",
    "上传本机文本文件…（可多选）": "Upload local text files… (multi-select)",
    "选一个 / 多个文本文件复制进素材库，每个文件一条内容":
      "Pick one or more text files to copy into the library — each file becomes one content item",
    "手写一条空正文…": "Write an empty body by hand…",
    "新建一条空白的文本内容（库内落一个 .txt），在表单里写或再上传文件":
      "Create a blank text item (a .txt inside the library); type in the form or upload a file there",
    "正文（可留空，用下方「上传文件…」从本机导入）":
      "Body (can stay empty — use “Upload file…” below to import from this machine)",
    "上传文件…": "Upload file…",
    "上传文件": "Upload file",
    "从本机选一个文本文件（.txt / .md / .json …）把正文读进来，不用手打":
      "Pick a local text file (.txt / .md / .json …) and read its body in — no need to type it",
    "选择要上传的文本文件": "Choose the text file to upload",
    "读不到这个文件的文本内容：请改选 .txt / .md 这类纯文本文件":
      "Could not read this file as text: please pick a plain-text file such as .txt / .md",
    "已载入本机文本：{name}（可继续编辑，点确定才写进素材库）":
      "Loaded local text: {name} (keep editing if you like — it reaches the library only when you confirm)",
    "从本机选一个文本文件（.txt / .md / .json …）顶掉这条正文（旧内容进版本目录）":
      "Pick a local text file (.txt / .md / .json …) to replace this body (the old one goes to the versions folder)",
    "从本机选一个文本文件（.txt / .md / .json …）导入这条正文（旧内容先进版本目录，可撤销）":
      "Pick a local text file (.txt / .md / .json …) to import into this body (the old one goes to the versions folder first · undoable)",
    "文本文件过大（素材库的文本条目上限 16MB）":
      "the text file is too large (the asset library caps a text item at 16 MB)",
    /* ── 拖放落点反馈（素材库左树 / 右栏卡片区 / 素材设置框条目区共用）── */
    "松开即可添加": "Release to add",
    "拖入本机文件 / 文件夹即可添加":
      "Drag a local file / folder here to add it",
    "将新建素材": "Will create a new asset",
    "已添加 {n} 条内容到「{name}」":
      "Added {n} content item(s) to “{name}”",
    /* 拖入内容被拒 / 落点说清「这一处只收什么」（与上面同一族提示） */
    "拖入的内容素材库不收：这里只收文本 / 图像 / 音频 / 视频文件或文件夹":
      "This drop is not accepted here: the asset library only takes text / image / audio / video files or folders",
    "拖入的内容素材库不收：这里只收文本 / 图像 / 音频 / 视频文件":
      "This drop is not accepted here: the asset library only takes text / image / audio / video files",
    "文件夹请拖到素材库空白处（会新建一个素材）":
      "Drop a folder on the empty area of the asset library (it becomes a new asset)",
    "没有可添加的文件：素材库只收文本 / 图像 / 音频 / 视频":
      "No file can be added: the asset library only takes text / image / audio / video",
    /* 条目只读预览（灯箱）与读不到实体文件时的提示 */
    "预览这条图像内容（框内看图 · 只读，换图走「更换文件」）":
      "Preview this image item (view it in a box · read-only; use “Replace file” to swap it)",
    "只读预览这条正文（要看全 / 临时看一眼用，改内容走「编辑文本」）":
      "Read-only preview of this body (for a full or quick look; use “Edit text” to change it)",
    "预览图像内容 · {name}": "Preview image · {name}",
    "预览文本内容 · {name}": "Preview text · {name}",
    "这条内容还没有实体文件": "This content item has no file on disk yet",
    "读取失败：": "Read failed: ",
  });

  /* ── 节点「设置」统一跳窗（NODE_SETTINGS_FORMS · 摘要行 · 节拍 / 网络 / 媒体参数）──
     设置从节点 body 搬进 ⚙ 跳窗后新出现的文案；中文为真源，以下为英文译文。 */
  Object.assign(EN, {
    /* 窗口骨架：标题 / 收尾 / 兜底提示 */
    "设置 · ": "Settings · ",
    "完成并关闭": "Done & close",
    "该节点无可设置项": "This node has nothing to configure",
    "该节点无可设置项。": "This node has nothing to configure.",
    "（无设置项）": "(nothing to configure)",
    "设置表单渲染失败：": "Failed to render the settings form: ",
    "该节点已不在当前画布，设置窗口已关闭":
      "This node is no longer on the current canvas — the settings window was closed",
    "当前设置：": "Current settings: ",
    "点 ⚙ 在设置窗口中修改": "click ⚙ to change it in the settings window",
    "（当前值）": "(current value)",

    /* ⚙ 入口 tooltip（原「API / 设置」折叠按钮 → 一律开窗） */
    "点击打开设置窗口": "click to open the settings window",
    "设置（点击打开设置窗口修改参数）":
      "Settings (click to open the settings window and edit parameters)",

    /* 摘要行：各 kind「窗里能改什么」的一句话 */
    "服务商 / 模型 / 尺寸": "Provider / model / size",
    "服务商 / 模型 / 温度 · 分辨率 / fps / 时长":
      "Provider / model / temperature · resolution / fps / duration",
    "预设 / 供应商 / 模型 / 思考强度": "Preset / provider / model / thinking effort",
    "时长 / 抽卡 / 种子 / 输出路径 / offload":
      "Duration / rolls / seed / output path / offload",
    "模式 / 尺寸 / 采样步数 / 显存优化": "Mode / size / sampling steps / VRAM options",
    "函数名 / 描述 / 增删输入输出参数（参数即端子）":
      "Function name / description / add & remove input and output params (a param is a port)",
    "工具名 / 描述 / 增删输入输出参数（参数即端子）":
      "Tool name / description / add & remove input and output params (a param is a port)",
    "保存路径 / 自动保存": "Save path / auto-save",
    "监视路径 / 轮询间隔": "Watched path / poll interval",
    "模式 / 计划时间 / 间隔 / Cron": "Mode / scheduled time / interval / Cron",
    "输出路数 / 步间间隔": "Output count / gap between steps",
    "输入路数 / 选择模式": "Input count / pick mode",
    "监听端口 / 通道 / 协议": "Listen port / channel / protocol",
    "目标地址 / 端口 / 通道 / 协议": "Target address / port / channel / protocol",
    "动作 / 补缺 / 固定": "Action / fill gaps / pinned",
    "音色 / 语速 / 输出格式 / 输出路径": "Voice / speed / output format / output path",

    /* 生成类窗内小节与选项（含从内联 .n-api-panel 搬进来的档位） */
    "渲染": "Render",
    "生成": "Generate",
    "生成参数": "Generation parameters",
    "高级参数": "Advanced parameters",
    "自建工作流": "Custom workflow",
    "（未选择）": "(none selected)",
    "显存": "VRAM",
    "offload：关": "offload: off",
    "offload：开": "offload: on",
    "R2V 多参考": "R2V · multiple references",
    "FL2VA 首末帧": "FL2VA · first / last frame",
    "480p（0.4MP 抽卡）": "480p (0.4MP — gacha rolls)",
    "1080p（~2MP，24G 慎用）": "1080p (~2MP — heavy on 24G)",
    "帧率 fps（1–60）": "Frame rate fps (1–60)",
    "帧率 fps": "Frame rate fps",
    "match（缩放匹配分辨率）": "match (scale to the output resolution)",
    "max（2048 短边 · 还原度更高更慢）":
      "max (2048 short edge — closer to source, slower)",
    "原生步跳过缓存 · 约 1.4–2×": "Skips native steps via cache · about 1.4–2×",
    "需 triton-windows + sageattention；缺包自动跳过（H3 插件窗可一键补装）":
      "Needs triton-windows + sageattention; skipped automatically when missing (one-click install in the H3 plugin window)",
    "按 head 分块降峰值显存": "Chunks per head to lower peak VRAM",
    "FFN 分块降峰值显存": "Chunks the FFN to lower peak VRAM",
    "采样后 unload，避免双 VAE 解码 OOM":
      "Unloads after sampling so two VAE decodes don't OOM",
    "VAE 前卸模型": "Unload the model before VAE",
    "补帧倍数": "Interpolation multiplier",
    "采样 / 质量 / 输出": "Sampling / quality / output",
    "采样器": "Sampler",
    "调度器": "Scheduler",
    "去噪 denoise": "Denoise strength",
    "视频位移 shift": "Video shift",
    "音频位移 shift": "Audio shift",
    "参考图尺寸": "Reference image size",
    "位深": "Bit depth",
    "封装格式": "Container format",
    "编解码": "Codec",
    "EasyCache 缓存区间": "EasyCache step range",
    "Sage 编译（需 Sage 且更慢更占显存）":
      "Sage compile (needs Sage; slower and uses more VRAM)",
    "取消生成请求": "Cancel the generation request",
    "停止运行（立即中止）": "Stop the run (abort immediately)",
    "待运行 · 点头部 ▶ · 头部「设置」窗口里改参数":
      "Queued · press ▶ in the header · edit parameters in the “Settings” window",
    "（数组·多条线）": "(array · one wire per item)",

    /* 视频后处理节点（video_upscale / video_interp · 超分 / 补帧独立于 H3 生成） */
    "视频超分": "Video upscale",
    "视频补帧": "Video interpolation",
    "视频超分节点": "Video Upscale Node",
    "视频补帧节点": "Video Interpolation Node",
    "视频超分（Real-ESRGAN x4 / x2 超分 · 独立后处理）":
      "Video upscale (Real-ESRGAN x4 / x2 · standalone post-process)",
    "视频补帧（RIFE 补帧 · 独立后处理）":
      "Video interpolation (RIFE · standalone post-process)",
    "超分模型 / 倍率 / 目标长边 / 分块流式":
      "Upscale model / ratio / target long side / tiled streaming",
    "超分倍率": "Upscale ratio",
    "x4 倍率（Real-ESRGAN x4plus · 画质最好）":
      "x4 ratio (Real-ESRGAN x4plus · best quality)",
    "x2 倍率（输出只放大 2 倍 · 更快更省显存）":
      "x2 ratio (output magnified 2× only · faster, lighter on VRAM)",
    "输出相对源视频放大的倍数：x2 = 长宽各翻一倍（更快更省显存）；x4 = Real-ESRGAN 原生倍率；逐帧分块流式下倍率不再受内存限制":
      "How much the source is magnified: x2 doubles width and height (faster, lighter on VRAM); x4 is the Real-ESRGAN native ratio; with per-frame tiled streaming the ratio is no longer limited by system RAM",
    "输出长边像素上限（1280–7680）；逐帧分块流式下不再受内存限制；x2 倍率时还会被「源长边 × 2」封顶，源分辨率未知时不缩放":
      "Output long-side cap in pixels (1280–7680); per-frame tiled streaming no longer limits it by system RAM; with the x2 ratio it is additionally capped at source long side × 2, and no scaling is added when the source size is unknown",
    "补帧倍率 / 精度 / 逐帧流式":
      "Interpolation multiplier / precision / per-frame streaming",
    "超分": "Upscale",
    "补帧": "Interpolate",
    "长边": "Long side",
    "超分参数": "Upscale parameters",
    "补帧参数": "Interpolation parameters",
    "超分模型": "Upscale model",
    "目标长边（像素）": "Target long side (px)",
    "逐帧批量 per_batch": "Frame batch per_batch",
    "每次交给超分模型的帧数；低显存安全档保持 1（流式档逐帧处理，此项只影响图兜底链）":
      "Frames handed to the upscale model per call; keep 1 on the low-VRAM safe profile (the stream path is per-frame anyway; this only affects the graph fallback)",
    "24G 安全档": "24G safe profile",
    "低显存安全档（强制逐帧）": "Low-VRAM safe profile (force one frame at a time)",
    "分块 fp16 省显存，16G 机器也能跑 15 秒片；关闭后按 per_batch 批量，更快但更吃显存":
      "Tiled fp16 keeps VRAM low — a 16 GB machine can handle a 15-second clip; turning it off batches by per_batch (faster, hungrier)",
    "分块 tile（像素）": "Tile (px)",
    "流式超分的分块大小（像素）；显存只跟它有关，512 适合 16G 机器，0 = 后端默认 512":
      "Tile size for streaming upscale in pixels; VRAM depends only on it. 512 suits a 16 GB machine, 0 = backend default 512",
    "逐帧分块流式超分：常驻内存只与一个分块有关，与视频时长无关，16G 机器也能跑 15 秒级视频；4K（长边 3840）输出不再受内存限制。":
      "Per-frame tiled streaming upscale: resident memory depends only on one tile, not on clip length, so a 16 GB machine can handle a 15-second video; 4K (long side 3840) output is no longer limited by RAM.",
    "连续处理次数（1–10）；多次时输出命名为 #1、#2 …":
      "Number of passes (1–10); multiple passes are named #1, #2 …",
    "补帧倍率": "Interpolation multiplier",
    "2x（推荐 · 更快更省显存）": "2x (recommended · faster, lighter on VRAM)",
    "4x（更流畅 · 耗时更长）": "4x (smoother · takes longer)",
    "输出帧率相对源视频的倍数：逐帧流式下倍率不再受内存限制，只影响输出帧数与耗时":
      "How much the output frame rate is multiplied; with per-frame streaming the multiplier is no longer limited by RAM — it only affects the frame count and the time it takes",
    "清缓存间隔（帧）": "Cache clear interval (frames)",
    "每 N 帧清一次缓存；流式档每帧算完即写盘，此项只影响图兜底链":
      "Flush the cache every N frames; the stream path writes each frame as soon as it is done, so this only affects the graph fallback",
    "逐帧批量 batch_size": "Frame batch batch_size",
    "每次交给 RIFE 的帧数；流式档逐帧处理，此项只影响图兜底链":
      "Frames handed to RIFE per call; the stream path is per-frame, so this only affects the graph fallback",
    "缩放系数 scale_factor": "Scale factor scale_factor",
    "RIFE 内部缩放系数（1.0=原分辨率）；流式档同样生效，不改变输出分辨率":
      "RIFE internal scale factor (1.0 = native resolution); it applies to the stream path too and never changes the output resolution",
    "低显存安全档": "Low-VRAM safe profile",
    "低精度 fp16 省显存，16G 机器也能跑 15 秒片；关闭后按更高精度跑，更快但更吃显存":
      "Low-precision fp16 keeps VRAM low — a 16 GB machine can handle a 15-second clip; turning it off runs at higher precision (faster, hungrier on VRAM)",
    "逐帧流式补帧：常驻内存只与相邻两帧有关，与视频时长无关，16G 机器也能跑 15 秒级视频；4x 倍率同样不再受内存限制，只是耗时更长。":
      "Per-frame streaming interpolation: resident memory depends only on two adjacent frames, not on clip length, so a 16 GB machine can handle a 15-second video; 4x is likewise no longer limited by RAM, it just takes longer.",
    "1x（仅重编码）": "1x (re-encode only)",
    "控制输入（触发后处理）": "Control input (trigger post-process)",
    "源视频（待处理的视频）": "Source video (to process)",
    "源视频": "Source",
    "可选素材 ": "Optional asset ",
    "素材 ": "Asset ",
    "后处理节点控制输入端子为端口 0":
      "Post-process control input is port 0",
    "源视频端子需要视频文件路径或文本来源":
      "The source-video port needs a video path or a text source",
    "素材端子需要文本或媒体文件路径":
      "The asset port needs text or a media file path",
    /* 视频后处理节点运行态（执行体 / 头部动作 / 状态行） */
    "请连接源视频输入（端子 V）": "Connect a source video (port V)",
    "启动后端并处理…": "Starting the backend and processing…",
    "独立后处理 · 执行时自动启停 H3 后端":
      "Standalone post-process · starts/stops the H3 backend automatically",
    "运行视频超分后处理": "Run the video upscale post-process",
    "运行视频补帧后处理": "Run the video interpolation post-process",
    "取消后处理请求": "Cancel the post-process request",
    "源视频 → Real-ESRGAN 超分（x2 / x4）→ 缩放到输出长边":
      "Source video → Real-ESRGAN upscale (x2 / x4) → scale to the output long side",
    "源视频 → 逐帧流式 RIFE 补帧（fps 按倍数重算）":
      "Source video → per-frame streaming RIFE interpolation (fps rescaled by the multiplier)",
    "已取消视频后处理": "Video post-process cancelled",
    " 完成：": " done: ",

    /* save */
    "尚未设置路径。": "No path set yet.",
    "实际指向：": "Actually resolves to: ",
    "暂时无法解析（相对路径需要先在顶栏设工作目录）：":
      "Cannot resolve yet (a relative path needs a workspace folder in the top bar first): ",
    "聚合：全部条目合并保存": "Aggregate: all items saved together",
    "批量：按输入节点标题另存": "Batch: saved per input-node title",
    "（未设置保存路径）": "(no save path set)",
    "自动保存：开": "Auto-save: on",
    "自动保存：关": "Auto-save: off",
    "保存路径": "Save path",
    "文件名": "File name",
    "后缀待定": "suffix pending",
    "直接在这里改输出文件名，不必打开 ⚙；文件名默认不带后缀，输入类型确定后自动补 .md / .png / .wav / .mp4。":
      "Rename the output file right here — no need to open ⚙. The name carries no extension by default; once the input type is known, .md / .png / .wav / .mp4 is appended.",
    "输入类型已确定，落盘时补此后缀": "Input type is known; this extension is appended on save",
    "还没连上输入，内容类型未定，暂不决定后缀":
      "No input wired yet, so the content type — and the extension — is still undecided",
    "还没连上输入，内容类型未定：先写文件名（可不带后缀），落盘时按输入类型补 ":
      "No input wired yet, so the content type is undecided: write the file name (extension optional) and the right one is appended on save: ",
    "后缀由连进来的数据类型固定为 ": "The extension is fixed by the wired data type to ",
    "，写错会自动纠正。": " — wrong spellings are corrected automatically.",
    "聚合：全部条目合并保存为 {路径}": "Aggregate: save every item together as {path}",
    "批量：保存为 {路径}_{输入节点标题}": "Batch: save as {path}_{input node title}",
    "相对工作目录或绝对路径（": "Relative to the workspace folder or absolute (",
    "保存路径（": "Save path (",
    "）…": ")…",
    "有工作目录时可用相对路径；改顶栏工作目录后统一落盘到新目录。也可填绝对路径。后缀由输入类型固定。":
      "With a workspace folder you may use a relative path; changing that folder moves everything into the new one. Absolute paths work too. The extension is fixed by the input type.",
    "输出文件路径（图像 .png / 音频 .wav / 视频 .mp4 / 文本 .md）":
      "Output file path (image .png / audio .wav / video .mp4 / text .md)",

    /* wait_file */
    "（未设置监视路径）": "(no watched path set)",
    "监视路径（待生成的文件）": "Watched path (the file to wait for)",
    "轮询 ": "Polling every ",

    /* 节拍族 */
    " 路": " channel(s)",
    " 路 AND": "-channel AND",
    "多中选一 · ": "One of many · ",
    "间隔 ": "gap ",
    "无间隔": "no gap",
    "（未填）": "(empty)",
    "每隔 ": "every ",
    "下次 ": "next ",
    "计划时间（系统本地时间）": "Scheduled time (system local time)",
    "Cron 表达式（分 时 日 月 周）": "Cron expression (minute hour day month weekday)",
    " 个节点 · 头部 ▶ 武装，body 的「立即触发」不等到点直接跑一次":
      " node(s) · arm it with ▶ in the header; “Trigger now” in the body fires once without waiting",
    "延时时长": "Delay length",
    "延时 ": "Delays ",
    "输出路数（2–8）": "Output count (2–8)",
    "输入路数（2–8）": "Input count (2–8)",
    "每 ": "Every ",
    " 次放行 · 当前 ": " hit(s) before passing · now ",
    "每 N 次放行（2–99）": "Pass every N hits (2–99)",

    /* control */
    "动作": "Action",
    "补缺：只执行尚无输出的节点": "Fill gaps: only run nodes that have no output yet",
    "开启后点 ▶ 只跑还没有结果的已连接节点，避免重复跑已有输出":
      "When on, ▶ runs only the connected nodes that still have no result, so existing output isn't repeated",
    "固定节点（不可删除）": "Pinned node (cannot be deleted)",
    " 个节点：": " node(s): ",
    "尚未连接任何目标节点：从右侧端子拉线到要一键运行的节点。":
      "No target node wired yet: drag from the right-hand port to the node ▶ should run.",
    "（连线在画布上改，不在这里）": "(wires are changed on the canvas, not here)",

    /* 网络族 */
    "目标地址": "Target address",
    "对端地址：本机默认 127.0.0.1，可填远程 IP":
      "Peer address: 127.0.0.1 by default on this machine, remote IPs allowed",
    "监听端口": "Listen port",
    "目标端口": "Target port",
    "（0 = 用全局端口 ": " (0 = use the global port ",
    "节点端口；0=用全局设置端口（当前 ":
      "Node port; 0 = the port from global settings (currently ",
    "通道号（16bit）": "Channel number (16-bit)",
    "通道号（16bit 整数，0–65535）": "Channel number (16-bit integer, 0–65535)",
    "协议": "Protocol",
    "未监听 · 点击「开始监听」": "Not listening · press “Start listening”",
    "▶ 开始监听": "▶ Start listening",
    "■ 停止监听": "■ Stop listening",
    "已停止监听": "Stopped listening",
    "用 netdebug 调试本通道（预填协议/端口/通道，以客户端发送测试帧）":
      "Debug this channel in netdebug (protocol / port / channel prefilled, it sends a test frame as a client)",
    "启动时自动监听": "Listen automatically at startup",
    "勾选后，打开 MTNode 或切换到本画布时自动进入监听状态":
      "When checked, opening MTNode or switching to this canvas starts listening on its own",
    "端口": "Port",
    "全局 ": "global ",
    "通道": "Channel",
    "自动监听": "Auto-listen",
    "开": "on",
    "关": "off",

    /* 媒体生成（tts / music / video / remotion）参数与摘要 */
    "音色 ": "Voice ",
    "语速 ": "Speed ",
    "语速（0.5–2.0）": "Speed (0.5–2.0)",
    "时长（秒）": "Duration (seconds)",
    "时长 ": "Duration ",
    "摇数（每次执行种子 +1）": "Reroll (seed +1 on every run)",
    "抽卡": "Rolls",
    "抽卡 ": "Rolls ",
    "种子 ": "Seed ",
    "格式": "Format",
    "工作流": "Workflow",
    "输出路径": "Output path",
    "输出文件路径；相对路径需先设顶栏工作目录。后缀由输出类型固定（语音跟随所选输出格式）。":
      "Output file path; a relative path needs a workspace folder in the top bar first. The extension is fixed by the output type (audio follows the chosen format).",
    /* H3 分段衔接（长视频）：video_gen 设置窗「生成」段（app-canvas.js 的 section / nsCheck / nsNumber） */
    "分段衔接（长视频无缝衔接）": "Clip chaining (seamless long video)",
    "衔接上一段视频": "Chain from the previous clip",
    "开启后节点多一个「↩ 上一段视频」输入端子：接上一段的成片，逐段生成即可拼成长视频。内置 FL2VA / R2V 都生效。":
      "Adds one more input port, “↩ previous clip”: feed it the finished previous segment and generate piece by piece to stitch a long video. Works in both built-in modes (FL2VA / R2V).",
    "引导帧数": "Guide frames",
    "重绘幅度": "Repaint strength",
    "重绘幅度 0.3–0.6 = 引导加重绘（推荐）：锚定构图并对引导区域重绘，重置画面状态、降低长视频劣化；填 0 = 纯引导。":
      "Repaint strength 0.3–0.6 = guidance plus repaint (recommended): the composition stays anchored while the guided region is repainted, resetting frame state and limiting degradation in long videos; 0 = guidance only.",
    "R2V（多参考）：衔接会占用一路参考视频（上限 3 路，连满时顶掉最后一路 V3），提示词按 <Video N> 引用这一路。":
      "R2V (multi-reference): chaining takes one reference-video slot (3 at most; when all three are wired, the last one — V3 — is replaced), so the prompt refers to it as <Video N>.",
    "自动补写续写声明": "Append the continuation note",
    "运行时在提示词末尾自动补一句官方口径的续写声明（Continue seamlessly from <Video N> …），告诉模型这一路参考视频就是上一段的续写起点。自己已经写过类似要求时可以关掉。":
      "At run time a continuation note in the official wording (“Continue seamlessly from <Video N> …”) is appended to the prompt, telling the model this reference video is where the previous clip continues from. Turn it off if you already wrote such a request yourself.",
    "占用参考视频": "takes reference video",
  });

  /* ── 弹窗最小化到状态栏（renderer/app.js 的 ovMin* 一套）+ 本地语音后端后台安装 ── */
  Object.assign(EN, {
    "最小化到状态栏": "Minimize to status bar",
    "点击恢复到对话窗": "Click to restore the dialog",
    "窗口": "Window",
    "后台继续安装": "Continue in background",
    "安装中…（可点「后台继续安装」关闭此窗，进度在插件卡片上）":
      "Installing… (click \"Continue in background\" to close this window; progress stays on the plugin card)",
    "安装已在后台继续，可在「插件」卡片查看进度":
      "Installation continues in the background; see the plugin card for progress",
    "本地语音后端安装完成，可以开始转写了": "Local speech backend installed — transcription is ready",
    "本地语音后端安装失败：": "Local speech backend installation failed: ",
    "安装完成。": "Installation complete.",
  });

  /* ── 本地语音转写插件控制台 + 便携 ffmpeg 补装（asr/ui、renderer/app-asr.js） ── */
  Object.assign(EN, {
    "重新安装 / 补充安装": "Reinstall / complete install",
    "补装 ffmpeg": "Install ffmpeg",
    "打开控制台": "Open console",
    "关闭控制台": "Close console",
    "ffmpeg（音频解码）": "ffmpeg (audio decoding)",
    "系统 PATH": "System PATH",
    "便携版（安装目录内）": "Portable build (inside install dir)",
    "缺失：无 ffmpeg 时任何音频都无法解码，请点「补装 ffmpeg」":
      "Missing: without ffmpeg no audio can be decoded — click “Install ffmpeg”",
    "正在补装便携 ffmpeg…": "Installing portable ffmpeg…",
    "ffmpeg 已就位。": "ffmpeg is ready.",
    "便携 ffmpeg 已就位，音频解码恢复可用": "Portable ffmpeg is ready — audio decoding works again",
    "ffmpeg 补装失败：": "ffmpeg install failed: ",
    "ffmpeg 已就位": "ffmpeg is ready",
    "ffmpeg 补装失败，请在控制台重试": "ffmpeg install failed; retry from the console",
  });

  /* ── SenseNova 本地图像生成：插件卡片与控制台入口（renderer/app-plugins.js · sensenova/ui） ──
     节点本体（sensenova_gen）的端子 / 状态 / 报错词条在任务 4 一并补，这里只登记卡片与安装提示文案。 */
  Object.assign(EN, {
    "安装中…": "Installing…",
    "补装权重": "Download weights",
    "安装（国内镜像）": "Install (CN mirrors)",
    "开始安装：权重约 32.66GB，请留意控制台进度…":
      "Starting install — the weights are ~32.66GB, watch the console for progress…",
    "正在安装 SenseNova 本地图像生成后端…": "Installing the SenseNova local image backend…",
    "SenseNova 后端安装完成，可在画布放置「SenseNova 图像生成」节点":
      "SenseNova backend installed — add a “SenseNova image” node on the canvas",
    "SenseNova 后端安装失败：": "SenseNova backend install failed: ",
    "SenseNova 本地图像生成": "SenseNova Local Image Generation",
    "SenseNova 图像生成": "SenseNova Image Generation",
  });

  /* ── 顶栏入口快捷键（renderer/app-keys.js）：按钮 hover 提示里追加「 · 快捷键 X」 ──
     快捷键本体与动作在 app-keys.js，键位写在 index.html 的 data-shortcut 上；
     这里只负责把键位并进 data-i18n-title 生成的提示文案，切语言时自动跟着换。 */
  Object.assign(EN, {
    "快捷键 {k}": "shortcut {k}",
  });

  /* ── 专家团：统一编辑所有专家的权限（renderer/app-team-recruit.js ·
        renderer/app-teamview.js · renderer/index.html 的 #teamPermAllBtn） ── */
  Object.assign(EN, {
    "权限": "Permissions",
    "统一编辑权限": "Edit permissions for all",
    "统一编辑所有专家的权限": "Edit permissions for all experts",
    "统一编辑入口未就绪": "The bulk permission editor isn't ready",
    "把所选范围内全部专家的权限统一设为下面选定的值；选「保持不变」的项维持各专家原样。":
      "Set every expert in the chosen scope to the values below; items left as “Keep unchanged” stay as they are.",
    "适用范围": "Scope",
    "工具许可": "Tool permissions",
    "工具许可表不可用": "The tool permission table is unavailable",
    "全部画布": "All canvases",
    "共 {n} 位专家": "{n} experts",
    "保持不变": "Keep unchanged",
    "应用更改": "Apply changes",
    "没有需要应用的改动": "Nothing to apply",
    "所选范围内还没有专家": "No experts in the chosen scope",
    "已统一设置 {n} 位专家的权限": "Updated permissions for {n} experts",
    "沙箱与越权审批档；专家只能在此档内收窄，不能扩权":
      "Sandbox and escalation approval preset; experts can only narrow within it, never widen it",
  });

  /* ── 设置窗「改动即时生效」改版（renderer/app-settings.js）：本页取消「保存并关闭」，
        每项改动当场写盘，底部状态行是唯一的落盘回执 ── */
  Object.assign(EN, {
    "改动即时生效": "Changes apply instantly",
    "正在保存…": "Saving…",
    "已即时生效 · ": "Applied · ",
    "保存失败：改动只在当前会话内生效": "Save failed: changes apply to this session only",
    "改动已即时生效，关窗前自动补一次写盘":
      "Changes already take effect; one final write runs when you close this",
    "这张卡的改动已即时生效，点「完成」收窗":
      "This card's changes take effect already; hit Done just to close it",
  });

  /* ── 会话工具条里的 grep 检索摘要（renderer/app-assist.js 的 dshGrepArgLabel ·
        app-plan.js 的计划面板同源）：入参名转成词条，include → 包括 / exclude → 排除 … ──
     这些标签都是「一个词」的通用串，别的功能以后可能也想用同一个键，所以只补表里还没有的：
     已存在的键一概不动（后写的 Object.assign 会悄悄覆盖前一条译文，是最难查的一类回归）。 */
  (function () {
    var grepLabels = {
      "匹配": "Match",
      "路径": "Path",
      "包括": "Include",
      "排除": "Exclude",
      "通配": "Glob",
      "输出模式": "Output mode",
      "多行": "Multiline",
      "忽略大小写": "Ignore case",
      "条数上限": "Max results",
      "偏移": "Offset",
      "上下文": "Context",
    };
    var add = {};
    for (var gk in grepLabels)
      if (!Object.prototype.hasOwnProperty.call(EN, gk)) add[gk] = grepLabels[gk];
    Object.assign(EN, add);
  })();

  var locale = "zh";

  function t(key, vars) {
    if (key == null || key === "") return "";
    var s;
    if (locale === "en" && Object.prototype.hasOwnProperty.call(EN, key)) s = EN[key];
    else s = String(key); /* 键就是中文原文：zh 界面原样回显 */
    if (vars && typeof vars === "object") {
      s = s.replace(/\{(\w+)\}/g, function (_, k) {
        return vars[k] == null ? "" : String(vars[k]);
      });
    }
    return s;
  }

  function setLocale(l) {
    locale = l === "en" ? "en" : "zh";
    return locale;
  }

  function getLocale() {
    return locale;
  }

  /* ── Agent 语言口味（交流语言偏好）──────────────────────────────
     界面语言（中 / EN）决定 agent 用什么语言与人交流，并期望它自己与
     它派生的每个 agent 都用该语言回答。真源只在这里，各注入点不得自写一份。
     纯 locale 派生、无 DOM 依赖，渲染层与主进程（require 本文件）共用。 */
  var AGENT_LANG_LABEL = { zh: "中文（简体）", en: "English" };

  function agentLangCode() {
    return locale === "en" ? "en" : "zh";
  }

  function agentLangLabel() {
    return AGENT_LANG_LABEL[agentLangCode()];
  }

  /* 每次 agent 运行注入系统提示的语言段（两种语言各写一份，模型不会漏读） */
  function agentLangTaste() {
    if (agentLangCode() === "en") {
      return [
        "【Language Taste · 交流语言】The MTNode UI language is English (en) — 请用英文与用户交流。",
        "1. Communicate in English throughout: your questions, plans, progress notes, tool-purpose lines, summaries and final answers must all be written in English.",
        "2. Expect the user to write in English, and expect every agent you spawn (subagent, bound dev session, smart node run) to answer in English as well.",
        "3. Keep code, file paths, commands, identifiers and API field names verbatim; quoted source material may stay in its original language with an English explanation.",
        "4. This taste governs communication only — do NOT translate the user's own material: fact-database records, table cells and file bodies you write keep the language of the source.",
        "5. Other sections of this prompt may be written in Chinese — those only describe your duties, they never change the language you answer in.",
        "6. If the user explicitly asks for another language in this conversation, follow the user and keep that choice for the rest of the conversation.",
      ].join("\n");
    }
    return [
      "【语言口味 · 交流语言】当前 MTNode 界面语言为中文（简体）。",
      "1. 全程用中文交流：你的提问、计划、进度说明、工具用途、摘要与最终回答一律用中文书写。",
      "2. 期望用户以中文书写，也期望你派生的每个 agent（子任务、功能块绑定会话、智能节点运行）都用中文回答。",
      "3. 代码、文件路径、命令、标识符与 API 字段名保持原文；引用的外部资料可保留原语言并补一句中文说明。",
      "4. 这条口味只管「交流」，不要翻译用户资料：事实库记录、表格单元格与写回文件的正文都沿用资料原本的语言。",
      "5. 本提示的其它段落可能以英文书写——那些只描述你的职责，不改变你的回答语言。",
      "6. 用户在本会话里明确指定其他语言时，以用户为准，并在该会话中沿用。",
    ].join("\n");
  }

  function applyDom(root) {
    if (typeof document === "undefined") return;
    var doc = root || document;
    var skipLive = {
      ovTitle: 1,
      statWf: 1,
      statCounts: 1,
      statProviders: 1,
      statGrid: 1,
      saveState: 1,
      agentSend: 1,
      assistSend: 1,
      agentCtx: 1,
      logoSub: 1,
    };
    doc.querySelectorAll("[data-i18n]").forEach(function (el) {
      if (skipLive[el.id]) return;
      var key = el.getAttribute("data-i18n");
      if (key) el.textContent = t(key);
    });
    doc.querySelectorAll("[data-i18n-title]").forEach(function (el) {
      var key = el.getAttribute("data-i18n-title");
      if (!key) return;
      var val = t(key);
      /* data-shortcut（顶栏入口的全局快捷键，见 renderer/app-keys.js）：
         hover 提示里同时给出键位，切语言后由这里重算，不会丢。 */
      var sc = el.getAttribute("data-shortcut");
      if (sc) val = val + " · " + t("快捷键 {k}", { k: sc });
      /* 顶栏入口用 data-tip 做即时 hover 提示（原生 title 有延迟）：
         .btn-ico = 图标按钮，.tb-view = 画布 / 会话 / 专家团三颗视图按钮。 */
      if (
        el.classList &&
        (el.classList.contains("btn-ico") || el.classList.contains("tb-view"))
      ) {
        el.setAttribute("data-tip", val);
        el.removeAttribute("title");
      } else {
        el.title = val;
      }
    });
    doc.querySelectorAll("[data-i18n-placeholder]").forEach(function (el) {
      var key = el.getAttribute("data-i18n-placeholder");
      if (key) el.placeholder = t(key);
    });
    doc.querySelectorAll("[data-i18n-html]").forEach(function (el) {
      var key = el.getAttribute("data-i18n-html");
      if (key) el.innerHTML = t(key);
    });
  }

  /* ── 素材库 T6：端子连入同步 ＋ 库内容随撤销回滚（中英成对） ── */
  Object.assign(EN, {
    "素材库不可用": "asset library is not available",
    "素材或条目不存在": "asset or content entry not found",
    "素材库正在回滚，请稍等一下再撤销 / 重做":
      "The asset library is still rolling back — please wait a moment before undoing / redoing",
    " · 素材库内容已回滚（{n} 项）":
      " · asset library rolled back ({n} item(s))",
    " · 素材库有 {n} 项没能回滚":
      " · {n} asset library item(s) could not be rolled back",
    "（旧内容仍在该素材的 .versions 目录里）":
      " (the previous copy is still in that asset's .versions folder)",
    "这个端子目前没有连入内容": "this port has nothing wired into it right now",
    "已覆盖到素材库：": "Overwritten into the asset library: ",
    "（Ctrl+Z 可撤销）": " (Ctrl+Z to undo)",
    "覆盖失败：": "Overwrite failed: ",
  });

  /* ── 素材库 T7：主进程侧（assets-store.js）错误串 ──
     这些串由 registerAssetsIpc 收到的 t() 翻译后回传，渲染层原样进 toast（例如
     「删除失败：…」），所以英文界面必须有译文 —— 与 tools-store.js 同一惯例。 */
  Object.assign(EN, {
    "素材库存储未初始化（缺少数据目录）":
      "asset storage is not initialized (no data directory)",
    "尚未指定素材库根目录": "no asset library root folder has been chosen yet",
    "请选择素材库根目录": "choose the asset library root folder",
    "素材库根目录必须是绝对路径": "the asset library root must be an absolute path",
    "该路径不是文件夹": "that path is not a folder",
    "请选择一个存在的文件夹": "choose a folder that exists",
    "非法路径": "illegal path",
    "路径不存在": "that path does not exist",
    "同名文件已存在": "a file with the same name already exists",
    "复制校验不一致，事实库未迁移": "copy verification failed — the fact library was not moved",
    "非法路径（越出素材库根目录）": "illegal path (escapes the asset library root)",
    "缺少路径": "missing path",
    "名称不能为空": "the name cannot be empty",
    "文件夹名称不能为空": "the folder name cannot be empty",
    "目录不存在": "that folder does not exist",
    "素材不存在": "asset not found",
    "内容条目不存在": "content entry not found",
    "内容文件缺失": "the content file is missing",
    "历史版本不存在": "that history version does not exist",
    "源文件不存在": "the source file does not exist",
    "没有内容可写入": "there is nothing to write",
    "写入失败": "write failed",
    /* 回收站两条路都走完东西还在原地（占用）：报失败，绝不糊一个「已删除」的假成功 */
    "删除失败：里面还有文件正被别的程序占用，请关掉它再重试":
      "delete failed: a file inside is still in use by another program — close it and try again",
  });

  /* ── 智能体侧的素材库 / 窗口截图（工具 mtnode_assets · renderer/app-assets.js
     的 assetAgent* / app-db.js 的 handleAssetToolEvent）──
     准备素材类运行（交付 · 素材交付、分镜参考图、界面静帧截图）靠这只工具拿到
     「人物三视图」这类库内素材的本机路径，并把 MTNode 窗口当下拍成静帧 PNG。 */
  Object.assign(EN, {
    "素材库里没有匹配的素材": "no asset in the library matches",
    "素材库里没有这个素材：": "no such asset in the library: ",
    "该素材里没有匹配的内容条目": "that asset has no matching content entry",
    "没有取到内容条目": "no content entry was returned",
    "条目 index = 绑定该素材的素材节点上的端子序号；read 可用 id / rel / itemId / index 取具体一条。":
      "An item index equals the port number of an 素材节点 bound to that asset; read takes a concrete one via id / rel / itemId / index.",
    "把 items[].path 交给 mtnode_vision 看图，或直接作为交付端子对应的文件路径。":
      "Hand items[].path to mtnode_vision to actually look at the picture, or use it as the file path of the matching delivery terminal.",
    "素材库还没有指定保存位置（顶栏「素材库」→ 指定根目录）":
      "the asset library has no root folder yet (top bar 「素材库」→ choose a root folder)",
    "当前环境不支持窗口截图": "this environment cannot take window screenshots",
    "截图只能保存为 .png / .jpg / .webp：": "a screenshot can only be saved as .png / .jpg / .webp: ",
    "截图失败：": "screenshot failed: ",
    "截图失败：主进程没取到画面（MTNode 窗口最小化或不可见）。请先把窗口显示出来再拍。":
      "screenshot failed: the main process got no picture (the MTNode window is minimized or hidden). Show the window first, then retry.",
    "已是宿主写好的静态 PNG（不是录屏）。要核对图里内容，把 path 交给 mtnode_vision；要真的更大更清楚，先让用户把 MTNode 窗口拉大（或传 maximize:true）。":
      "This is a static PNG already written by the host (not a recording). To check what is in it, hand path to mtnode_vision; for a genuinely bigger, clearer still, have the user enlarge the MTNode window (or pass maximize:true).",
    "未知素材操作：": "unknown asset action: ",
    /* 工具许可面板：新增的「素材库与截图」一档 */
    "素材库与截图": "Asset library & screenshots",
    "读素材库 / 窗口截图": "Read library / window screenshot",
    "列出素材库、取内容条目的本机路径、把 MTNode 窗口拍成静帧 PNG":
      "List the library, resolve a content entry's local path, and shoot the MTNode window as a still PNG",
    /* ── 桌面 / 窗口截图（desktop-capture.js · 内置工具「屏幕 / 窗口截图」）── */
    "桌面截图未初始化（缺少输出目录）": "desktop capture is not initialised (no output folder)",
    "桌面截图目前在 Windows 上实现（PowerShell + GDI）：本机是 ":
      "desktop capture is currently implemented on Windows (PowerShell + GDI): this machine runs ",
    "。拍 MTNode 自己的窗口 / 画布请用画布拍照类能力。":
      ". To shoot MTNode's own window / canvas, use the canvas snapshot capability.",
    "截图脚本执行失败": "the capture script failed to run",
    "截图脚本没有返回结果": "the capture script returned no result",
    "截图脚本超时（": "the capture script timed out (",
    " 秒）": " s)",
    "截图脚本退出码 ": "the capture script exited with code ",
    "找不到 PowerShell（桌面截图不可用）":
      "PowerShell was not found (desktop capture is unavailable)",
    "未知截图模式：": "unknown capture mode: ",
    "没找到匹配的窗口（关键字 / hwnd / pid 都对不上）：":
      "no matching window (the keyword / hwnd / pid did not match any window): ",
    "没有匹配的屏幕（屏幕 id / 名称 / 序号都对不上）：":
      "no matching screen (the screen id / device name / index did not match any screen): ",
    "这个窗口当前最小化了（最小化的窗口拍出来只会是黑图）：先把它显示出来再拍 —— ":
      "this window is minimised right now (a minimised window only yields a black picture): show the window first, then shoot — ",
    "取窗口位置失败（窗口可能正在创建 / 关闭）":
      "could not read the window rectangle (the window may be opening or closing)",
    "被拍对象当前没有可见区域（最小化了？）：先把它显示出来再拍":
      "the target currently has no visible area (minimised?): show it first, then shoot",
    "截图区域为空（偏移 / 尺寸超出被拍对象范围？）":
      "the capture region is empty (offset / size outside the target?)",
    "这个窗口当前不在屏幕上（最小化 / 已隐藏），拍出来只会是一张黑图：":
      "this window is not on screen right now (minimised / hidden); the shot would only be a black picture: ",
    "桌面截图后端未接线（主进程未注入 fnRuntime.screenCapture）：mtnode.screenShot 暂不可用":
      "the desktop capture backend is not wired (main.js did not inject fnRuntime.screenCapture): mtnode.screenShot is unavailable",
    "未知的桌面截图动作：": "unknown desktop capture action: ",
    "PDF 解析后端未接线（主进程未注入 fnRuntime.pdfConvert）：mtnode.readPdf 暂不可用":
      "the PDF parsing backend is not wired (main.js did not inject fnRuntime.pdfConvert): mtnode.readPdf is unavailable",
    "未知的 PDF 解析动作：": "unknown PDF parsing action: ",
    "PDF 写出后端未接线（主进程未注入 fnRuntime.pdfWrite）：mtnode.writePdf 暂不可用":
      "the PDF writing backend is not wired (main.js did not inject fnRuntime.pdfWrite): mtnode.writePdf is unavailable",
    /* 函数运行桥（fn-runtime.js）的兜底报错两类：①「桥没接线」（主进程没注入对应
       后端）②「未知动作」。fn-runtime 跑在 worker 线程、不 require 本文件，文案在
       主进程 / 渲染层两个界面语言下都得有译文；未知动作的后缀 「(空)」半角括号也
       一并给词条（桌面截图那条 unknown action 同样用它兜底）。 */
    "mtnode 桥未接线（缺少 call）": "the mtnode bridge is not wired (missing call)",
    "mtnode.ai：函数节点的 AI 调用后端未接线（主进程未注入 fnRuntime.aiCall）":
      "mtnode.ai: the function node's AI call backend is not wired (main.js did not inject fnRuntime.aiCall)",
    "未知的 mtnode 桥调用：": "unknown mtnode bridge call: ",
    "(空)": "(empty)",
  });

  /* ── Puzzle 益智小游戏（app-puzzle.js 框架与顶栏入口共用 UI 词条）── */
  Object.assign(EN, {
    "游戏": "Game",
    "益智小游戏：等待 AI 工作时玩几款小游戏打发时间":
      "Puzzle games: play a few quick minigames while you wait for the AI",
    "益智小游戏": "Puzzle Games",
    "选择一款小游戏打发时间": "Pick a minigame to pass the time",
    "难度": "Level",
    "目标": "Goal",
    "已答": "Done",
    "得分": "Score",
    "连击": "Combo",
    "计时": "Time",
    "结束": "End",
    "关闭": "Close",
    "返回列表": "All games",
    "A · 计算 / 逻辑": "A · Arithmetic / Logic",
    "B · 记忆 / 注意": "B · Memory / Attention",
    "C · 知觉 / 空间": "C · Perception / Space",
    "难度 {l} / 5": "Level {l} / 5",
    "未实现 · 玩法将在后续接入": "Not implemented yet · coming soon",
    "已全部接入玩法": "All games wired up",
    "开始": "Play",
    "没有可玩的小游戏": "Nothing to play yet",
    "本轮结束": "Round over",
    "再来一局": "Play again",
  });

  /* ── 统一账户与登录（renderer/app-auth.js / app-store.js / main.js 账户 IPC 共用）──
     来源键即中文原文（locale=zh 时 t() 原样返回），这里只补英文译文；
     新增账户相关文案时同步在此追加，回归由 test/smoke-auth.js 钉住。 */
  Object.assign(EN, {
    /* 顶栏入口 / 账户菜单 */
    "账户": "Account",
    "账户：登录 / 绑定 / 退出": "Account: sign in / bind / sign out",
    "登录 / 注册": "Sign in / Sign up",
    "登录 MTNode 账户": "Sign in to your MTNode account",
    "退出登录": "Sign out",
    "确定要退出登录吗？": "Sign out now?",
    "已退出登录": "Signed out",
    "未绑定手机": "No phone bound",
    "账户服务未就绪": "Account service is not ready",
    "登录方式暂未开放": "No sign-in method is available yet",
    "登录后账号数据随设备同步": "Your account data syncs across devices once signed in",
    "绑定手机": "Bind phone",
    "绑定手机号": "Bind phone number",
    "绑定微信": "Bind WeChat",
    "已绑定微信": "WeChat linked",
    "已绑定手机": "Phone linked",
    "手机号绑定成功": "Phone number bound",
    "微信绑定成功": "WeChat bound",
    "已把微信绑定到当前账号（原临时微信账号已合并）":
      "WeChat linked to your current account (the temporary WeChat account was merged)",
    /* 该微信已绑定其它账号：让用户选「改用该微信登录 / 取消」的选择对话框 */
    "微信已绑定其它账号": "WeChat already bound to another account",
    "该微信已绑定到以下账号，请选择改用该微信登录（切换到该账号）或取消。":
      "This WeChat is already bound to the account below — sign in with this WeChat to switch to that account, or cancel.",
    "改用该微信登录（切换到该账号）": "Sign in with this WeChat (switch to that account)",
    "该账号": "That account",
    "已设置密码": "Password set",
    "未设置密码": "No password set",
    /* 登录对话框 · 通用 */
    "微信扫码": "WeChat scan",
    "手机验证码": "SMS code",
    "账号密码": "Account password",
    "账号密码（二次验证）": "Account password (two-factor verification)",
    "请输入当前密码": "Enter your current password",
    "请输入要绑定的手机号": "Enter the phone number to bind",
    "请输入账号密码完成二次验证": "Enter your account password to complete two-factor verification",
    "手机号": "Phone number",
    "请输入 11 位手机号": "Enter an 11-digit phone number",
    "请输入正确的 11 位手机号": "Enter a valid 11-digit phone number",
    "验证码": "Verification code",
    "6 位验证码": "6-digit code",
    "获取验证码": "Get code",
    "发送中…": "Sending…",
    " 秒后重发": " s to resend",
    "验证码已发送": "Verification code sent",
    "请输入收到的验证码": "Enter the code you received",
    "请输入用户名": "Enter your username",
    "请输入密码": "Enter your password",
    "操作失败，请稍后重试": "Operation failed — please try again later",
    "与主进程通信失败": "Failed to communicate with the main process",
    "登录服务未就绪": "Sign-in service is not ready",
    "登录服务未就绪（主进程账户模块尚未接入）":
      "Sign-in service is not ready (the main-process account module is not wired up yet)",
    "登录服务未就绪：主进程账户模块尚未接入":
      "Sign-in service is not ready: the main-process account module is not wired up yet",
    /* 微信扫码：唯一通道＝系统默认浏览器 */
    "用默认浏览器打开微信登录": "Open WeChat sign-in in the default browser",
    "重新打开微信登录": "Reopen WeChat sign-in",
    "已用默认浏览器打开微信登录，请在浏览器完成扫码或在微信中确认":
      "Opened WeChat sign-in in your default browser — scan the QR code or confirm in WeChat",
    "微信快捷登录": "WeChat quick sign-in",
    "正在打开微信快捷登录…": "Opening WeChat sign-in…",
    "微信登录已超时，请重新点击「用默认浏览器打开微信登录」":
      "WeChat sign-in timed out — click “Open WeChat sign-in in the default browser” again",
    "微信授权成功但绑定未生效，请重试；若持续失败请升级并重新部署账户服务":
      "WeChat authorized successfully but the binding did not take effect — please retry; if it keeps failing, upgrade and redeploy the account service",
    "登录服务暂时不可用，请稍后重试":
      "The sign-in service is temporarily unavailable — please try again later",
    /* 手机验证码 */
    "未注册的手机号将自动创建账号；验证码 5 分钟内有效":
      "An unregistered phone number creates an account automatically; the code is valid for 5 minutes",
    "验证码会发送到该号码，验证通过后手机号即成为登录方式":
      "A code will be sent to this number; once verified the phone number becomes a sign-in method",
    "老用户可用用户名密码登录；登录后可在账户菜单绑定手机 / 微信，再解绑旧密码":
      "Existing users can sign in with username and password; afterwards bind a phone / WeChat from the account menu and then unbind the old password",
    /* 服务端错误码文案（app-auth.js CODE_TEXT / main.js IPC 兜底） */
    "用户名或密码错误": "Incorrect username or password",
    "手机号格式不正确": "Invalid phone number format",
    "密码长度需 6-72 位": "Password must be 6-72 characters",
    "昵称长度需 1-32 位": "Nickname must be 1-32 characters",
    "请求格式不正确": "Invalid request format",
    "验证码错误": "Incorrect verification code",
    "验证码已过期，请重新获取": "The verification code has expired — request a new one",
    "操作太频繁，请稍后再试": "Too many attempts — please try again later",
    "短信服务暂不可用，请稍后再试": "SMS service is temporarily unavailable — please try again later",
    "微信登录暂不可用": "WeChat sign-in is temporarily unavailable",
    "用户名密码注册已停用，请用手机验证码或微信登录":
      "Username/password registration is disabled — use an SMS code or WeChat to sign in",
    "该手机号已被其它账号绑定": "This phone number is already bound to another account",
    "当前账号已绑定其它手机号": "This account already has another phone number bound",
    "该微信已被其它账号绑定": "This WeChat is already bound to another account",
    "该微信已绑定其它账号，请选择改用该微信登录或取消":
      "This WeChat is already bound to another account — choose to sign in with it or cancel",
    "当前账号已绑定微信": "This account already has WeChat bound",
    "请先完成二次验证": "Complete two-factor verification first",
    "二次验证失败": "Two-factor verification failed",
    "登录已失效，请重新登录": "Your session has expired — please sign in again",
    "该登录方式尚未绑定": "That sign-in method is not bound yet",
    "至少保留一种登录方式": "Keep at least one sign-in method",
    "当前账号已设置密码": "This account already has a password",
    "不支持的绑定类型": "Unsupported bind type",
    "不支持的解绑类型": "Unsupported unbind type",
    "登录失败": "Sign-in failed",
    "登录响应缺少凭据": "The sign-in response is missing credentials",
    "修改密码失败": "Failed to change the password",
    "修改昵称失败": "Failed to change the nickname",
    "验证码发送失败": "Failed to send the verification code",
    "微信登录不可用": "WeChat sign-in is unavailable",
    "微信登录失败": "WeChat sign-in failed",
    "获取账号信息失败": "Failed to fetch account information",
    "绑定失败": "Binding failed",
    "解绑失败": "Unbinding failed",
    /* ── 画布左栏「文件」页（renderer/app-sidebar-files.js） ── */
    "粘贴": "Paste",
    "剪切": "Cut",
    "搜索文件…": "Search files…",
    "文件页显示的目录（按画布记忆）": "Folder shown in the Files tab (remembered per canvas)",
    "按类型筛选": "Filter by type",
    "媒体": "Media",
    "刷新文件树": "Refresh the file tree",
    "把剪贴板里的文件粘贴到当前选中文件夹":
      "Paste the clipboard files into the selected folder",
    "（未设置）": "(not set)",
    "项目根：": "Project root: ",
    "自定义：": "Custom: ",
    "浏览…": "Browse…",
    "尚未设置工作目录：请在上方选择画布工作目录、项目根，或「浏览…」选一个文件夹":
      "No working directory yet: pick the canvas working directory or a project root above, or choose a folder via “Browse…”",
    "在右侧文件面板中预览": "Preview in the file panel on the right",
    "搜索：": "Search: ",
    "没有匹配的文件": "No matching files",
    "结果过多，只显示前 ": "Too many results — showing the first ",
    " 条": " items",
    "读取中…": "Loading…",
    "目录不存在或不可读：": "Folder missing or unreadable: ",
    "这个目录是空的": "This folder is empty",
    "复制完整路径": "Copy full path",
    "已复制路径": "Path copied",
    "已复制 ": "Copied ",
    "已剪切 ": "Cut ",
    " 项": " item(s)",
    "重命名失败：": "Rename failed: ",
    "已重命名：": "Renamed: ",
    "目标文件夹不存在：": "The target folder does not exist: ",
    "粘贴失败：": "Paste failed: ",
    "已粘贴 ": "Pasted ",
    "确定删除「{name}」？它会移入系统回收站。":
      "Delete “{name}”? It will be moved to the system recycle bin.",
    "确定删除选中的 {n} 项？它们会移入系统回收站。":
      "Delete the {n} selected item(s)? They will be moved to the system recycle bin.",
    "删除失败（未删除，可能该位置不支持回收站）：":
      "Delete failed (nothing was deleted — this location may not support the recycle bin): ",
    "已删除 ": "Deleted ",
    " 项（在系统回收站）": " item(s) (in the system recycle bin)",
    "这里没有可建节点的文件": "There are no files here to turn into nodes",
    "拖入画布": "Drop onto the canvas",
    "创建节点": "Create nodes",
    "无法预览该文件": "Cannot preview this file",
    "将创建 {n} 个节点：": "Will create {n} node(s): ",
    "；另有 {d} 个文件夹，只取第一层共 {n} 个文件（不递归）":
      "; {d} folder(s) detected — only their top-level {n} file(s) are used (no recursion)",
    "{summary}？创建后可 Ctrl+Z 一次撤销。":
      "{summary}? You can undo the whole batch with Ctrl+Z.",
    "文件名不能为空": "The file name cannot be empty",
    "文件名不能包含路径分隔符": "The file name cannot contain a path separator",
    "不能改动应用目录本身": "The application folder itself cannot be modified",
  });

  /* ── 节点「?」说明按钮与说明小窗（renderer/app-nodehelp.js + app-settings.js） ──
     面向非技术用户的最简语言：每条都是「这个节点是干什么的」一句话。 */
  Object.assign(EN, {
    "写文字的地方：在这里打字或粘贴，内容会顺着连线交给后面的节点。":
      "Where you write text: type or paste here, and it flows along the wire to the next node.",
    "放图片的地方：选一张本机图片或拖进来，后面的节点就能拿它当参考图。":
      "Where you put an image: pick one from this computer or drag it in, so later nodes can use it as a reference.",
    "放音频的地方：选一个本机音频文件，节点会给出它的文件地址，可接给做声音的节点。":
      "Where you put audio: pick an audio file, and the node hands out its file path for nodes that make sound.",
    "放视频的地方：选一个本机视频文件，节点会给出它的文件地址，可接给做视频的节点。":
      "Where you put video: pick a video file, and the node hands out its file path for nodes that make video.",
    "文件节点：一次导入多个本机文件，当成一批内容交给后面的节点。":
      "File node: import several files at once and pass them on as one batch.",
    "素材节点：把素材库里存好的内容取出来用，每条内容就是一个接口。":
      "Asset node: pull saved content out of the asset library; each entry becomes one port.",
    "数据表：读一个表格文件，或者让智能体帮你建一张表。":
      "Data table: read a spreadsheet file, or let the agent build one for you.",
    "让 AI 处理文字：把要求写进提示词，点 ▶ 就得到结果。":
      "Let AI work on text: write what you want in the prompt, click ▶ and get the result.",
    "让 AI 画图：把想要的画面写成提示词，点 ▶ 生成一张图片。":
      "Let AI draw: describe the picture in the prompt, click ▶ to generate one image.",
    "生成音乐：写一段风格提示词（可加歌词），点 ▶ 得到一段音乐。":
      "Make music: write a style prompt (lyrics optional), click ▶ to get a track.",
    "生成视频：用文字或图片描述画面，点 ▶ 得到一段视频。":
      "Make video: describe the shot with text or an image, click ▶ to get a clip.",
    "文字转语音：把文字读出来，点 ▶ 得到一段配音。":
      "Text to speech: have the text read aloud — click ▶ to get a voice track.",
    "动效视频：用代码模板渲染出一段 mp4 视频。":
      "Motion video: render an mp4 from a code template.",
    "收网络消息：守在一个通道上，收到文字就往后传。":
      "Receive over the network: watch a channel and pass on any text that arrives.",
    "发网络消息：把收到的文字发到这个通道的另一端。":
      "Send over the network: push text to the other end of this channel.",
    "启动程序：点一下，就打开这个节点绑定的那个程序。":
      "Launch a program: one click opens the program this node is bound to.",
    "小计算器：写一小段 JS 代码做计算，输入进去、结果出来。":
      "Little calculator: a small piece of JS does the math — values in, result out.",
    "保存结果：把上一步的内容存成文件（文字存成 .md，图片 / 声音 / 视频存成对应格式）。":
      "Save the result: write the previous step to a file (text as .md; images / audio / video in their own formats).",
    "保存结果：把上一步的内容存成文件（文字存成 .md）。":
      "Save the result: write the previous step to a file (text as .md).",
    "保存图片：把上一步生成的图片存成图片文件。":
      "Save the image: write the generated image to an image file.",
    "取出其中一项：把一整批内容挑出单独一条，方便一条一条处理。":
      "Take one item out: pull a single item out of a batch so you can handle them one by one.",
    "合成一批：把多个节点的结果合成一整批，后面按批处理。":
      "Combine into a batch: gather several nodes' results into one batch for batch handling downstream.",
    "让 AI 自己干活：它能读文件、上网、执行命令，独立把这件事做完。":
      "Let AI work on its own: it can read files, search the web and run commands to finish the job by itself.",
    "让 AI 自己干活：不只是写文字，还能读文件、上网、执行命令，把这件事做完。":
      "Let AI work on its own: not just text — it can read files, search the web and run commands to get this done.",
    "任务：把一件复杂的事拆成小步骤，按顺序做完，成功或失败都有终点。":
      "Task: break a complex job into small steps, run them in order, with a success and a failure ending.",
    "收纳盒：把一堆节点装进一个壳里，展开能看里面，收起能让画布清爽。":
      "Storage box: put a group of nodes inside one shell — expand to look inside, collapse to keep the canvas tidy.",
    "等文件：等到指定文件出现，才继续往下走。":
      "Wait for a file: hold here until the given file appears, then continue.",
    "定时器：到点或每隔一段时间，自动触发一次。":
      "Timer: fire once at a set time or every so often.",
    "等一会儿：先等上几秒，再继续往下走。":
      "Wait a moment: pause a few seconds, then continue.",
    "按顺序：把一次触发放成好几路，一个接一个依次发出。":
      "In order: split one trigger into several outputs and release them one after another.",
    "凑齐才走：所有上一环都到了，才放行往下走。":
      "Wait until all arrive: let the flow through only after every upstream branch is done.",
    "分发：把一次触发同时发给好几路。":
      "Fan out: send one trigger to several branches at the same time.",
    "数数：每来 N 次，才放行一次。": "Count: let one pass through every N triggers.",
    "排队：多路同时进来时只放一路过去，避免几件事撞在一起。":
      "Take turns: when several branches arrive at once, let only one through so they don't collide.",
    "判断：按条件选「是」或「否」两条路走。":
      "Decide: pick the “yes” or the “no” branch by a condition.",
    "全局节点：把内容广播给所有需要它的节点，用 @ 标题 引用。":
      "Global node: broadcast its content to every node that needs it — reference it with @Title.",
    "控制按钮：点一下就跑这一串流程（分起点、成功、失败三种）。":
      "Control button: one click runs this flow (start, success and failure roles).",
    "数据库副本：里面是这台机器上存好的真实资料，智能体能查它。":
      "Database copy: real records stored on this machine, which the agent can look up.",
    "数据库副本：里面是这台机器上存好的真实资料，可以查、可以算，智能体也用得上。":
      "Database copy: real records stored on this machine that can be searched and computed, and the agent can use it too.",
    "工具节点：像一个能重复使用的小工具，参数就是它的接口，智能体也能随时调用它。":
      "Tool node: a reusable little tool whose parameters are its ports; the agent can call it any time.",
    "开发节点：代表项目里的一个功能块，展开能看到它里面的结构和代码文件。":
      "Dev node: stands for one feature block of the project — expand it to see the structure and code files inside.",
    "开始按钮 ▶：点它就从这里往下跑整条流程。":
      "Start button ▶: click it to run the whole flow from here.",
    "成功终点：流程顺利走到这里，就算成功结束。":
      "Success end: the flow reached here — it finished successfully.",
    "失败终点：流程走不通时会到这里，算失败结束。":
      "Failure end: the flow could not go through, so it ends as a failure.",
    "画布上的一个节点：把上游的内容按它的规则处理后交给下游。":
      "A node on the canvas: it handles what comes in from upstream by its own rule and passes it on.",
    "鼠标移开 1 秒后自动关闭":
      "Closes automatically 1 second after the mouse leaves",
    "节点说明：点击查看这个节点是干什么的":
      "Node help: click to see what this node does",
    "节点说明": "Node help",
    "节点「?」说明按钮（点击查看该节点是做什么的；取消勾选则隐藏，默认打开）":
      "Node “?” help button (click to see what the node does; uncheck to hide — on by default)",

    /* ── PDF 生成节点（「文本生成」菜单 · renderer/app-nodes.js savePdfOnce ·
       renderer/app-canvas.js 设置表单 · 主进程 pdf-write.js） ── */
    "PDF生成（文本排版成 PDF · 支持公式）":
      "PDF export (typesets text into a PDF · formulas supported)",
    "PDF": "PDF",
    "选择 PDF 保存位置": "Choose where to save the PDF",
    "用系统默认 PDF 阅读器打开": "Open with the system default PDF reader",
    "保存路径 / PDF 版面": "Save path / PDF layout",
    "PDF 版面": "PDF layout",
    "边距": "Margin",
    "字号": "Font size",
    "页码": "Page numbers",
    "横向": "Landscape",
    "纵向": "Portrait",
    "文档标题": "Document title",
    "可留空；填了就在正文顶部加一行居中大标题（PDF 属性里的标题也用节点标题）":
      "Leave empty for none; if filled, a centred title line is added on top (the node title is used as the PDF title property)",
    "当前版面：": "Current layout: ",
    "接进来的文本按 Markdown 排版成 PDF：标题 / 列表 / 表格 / 代码块 / 图片都渲染，$…$ 与 $$…$$ 公式排成排版结果（与画布预览同一套公式渲染器）。":
      "The incoming text is laid out as Markdown into a PDF: headings, lists, tables, code blocks and images are rendered, and $…$ / $$…$$ formulas are typeset (same formula renderer as the canvas preview).",
    "聚合：全部条目合并为一个 PDF（{路径}.pdf）":
      "Aggregate: all items merged into one PDF ({路径}.pdf)",
    "批量：保存为 {路径}_{输入节点标题}.pdf":
      "Batch: saved as {路径}_{input node title}.pdf",
    "相对工作目录或绝对路径（*.pdf）…":
      "Relative to the workspace or an absolute path (*.pdf)…",
    "保存路径（*.pdf）…": "Save path (*.pdf)…",
    "输出 PDF 路径。有工作目录时可用相对路径；后缀固定 .pdf，写错会自动纠正。":
      "Output PDF path. With a workspace set you may use a relative path; the extension is always .pdf and is corrected automatically.",
    "上游输出更新时自动生成 PDF 到指定路径":
      "Regenerate the PDF at the given path whenever the upstream output changes",
    "PDF 只在点节点上的 ▶（或控制节点指挥）时生成，接线与上游更新不会自动落盘。":
      "A PDF is generated only when you click ▶ on the node (or a control node triggers it); wiring and upstream updates never auto-export.",
    "留空 = 用输入节点标题（相对工作目录或绝对路径 *.pdf）…":
      "Empty = input node title (relative to the workspace or an absolute *.pdf path)…",
    "留空 = 用输入节点标题（*.pdf）…": "Empty = input node title (*.pdf)…",
    "输出 PDF 路径。留空则默认用输入节点的标题命名；有工作目录时可用相对路径；后缀固定 .pdf，写错会自动纠正。":
      "Output PDF path. Leave empty to name it after the input node's title; with a workspace set a relative path is allowed. The extension is always .pdf and is corrected automatically.",
    "尚未生成（点击 ▶ 生成 PDF）": "Not generated yet (click ▶ to create the PDF)",
    "打开 PDF：用系统默认阅读器打开已生成的 PDF":
      "Open PDF: open the generated PDF in the system default reader",
    "打开 PDF": "Open PDF",
    "尚未生成 PDF：点节点上的 ▶ 生成":
      "No PDF yet — click ▶ on the node to generate it",
    "点击用系统默认应用打开：": "Click to open with the system default app: ",
    "还没有生成 PDF——点节点上的 ▶ 生成":
      "No PDF yet — click ▶ on the node to generate one",
    "直接在这里改输出文件名，不必打开 ⚙；留空则默认用输入节点的标题命名，落盘时自动补 .pdf。":
      "Rename the output file right here instead of opening ⚙; leave it empty to use the input node's title and get .pdf appended automatically.",
    "页面尺寸": "Page size",
    "页边距": "Page margin",
    "正文字号": "Body font size",
    "显示页码": "Show page numbers",
    "横向纸张（宽表格 / 宽公式更合适）":
      "Landscape paper (better for wide tables / wide formulas)",
    "页脚居中显示「当前页 / 总页数」": "Centred “page / total pages” footer",
    "尚未生成（指定路径后点击 ▶）":
      "Not generated yet (set a path, then click ▶)",
    "当前版本没有 PDF 生成通道（缺少 pdf:writeText）":
      "This build has no PDF generation channel (pdf:writeText missing)",
    "没有可生成 PDF 的文本输入": "No text input available to generate a PDF",
    "PDF 生成失败：": "PDF generation failed: ",
    "已生成 PDF → ": "PDF created → ",
    " 个 PDF → ": " PDF files → ",
    "已生成 ": "Created ",
    "生成 PDF：把上一步的文字排成一份像样的 PDF 文件（标题、表格、列表都会排版，公式会画成真正的数学式子）。":
      "PDF export: typesets the previous step's text into a presentable PDF file (headings, tables and lists are laid out; formulas are drawn as real math).",
    "PDF 生成：": "PDF export: ",
  });

  /* 插件报错 → 自动修复与修复后重启（renderer/app-repair.js）：报告窗 / 修复结果窗 / 收敛提示 */
  Object.assign(EN, {
    "错误码": "Error code",
    "错误码：": "Error code: ",
    "打开该插件自己的控制台（完整日志在那里）":
      "Open this plugin's own console (the full log lives there)",
    "修复完成（该插件没有登记的服务重启入口，请在插件卡片里手动启动）":
      "repaired (this plugin has no registered service-restart entry — start it manually on the plugin card)",
    "这次自动修复没跑完（会话被终止），后端服务未重启。本条错误的自动修复额度已用完：不会再自动重试，也不会反复弹窗，请对照下面的结论自己处理。":
      "This auto-repair did not finish (the session was terminated), so the backend service was not restarted. The auto-repair quota for this error is spent: it will not retry on its own nor keep popping up — handle it per the verdict below.",
    "自动修复会话结束了，但没拿到成功结论（缺 repair_ok=1 / 结果文件写了 ok=false），后端服务未重启。本条错误的自动修复额度已用完：不会再自动重试，也不会反复弹窗，请对照下面的结论与 reason 处理。":
      "The auto-repair session ended without a success verdict (no repair_ok=1 / the result file says ok=false), so the backend service was not restarted. The auto-repair quota for this error is spent: it will not retry on its own nor keep popping up — handle it per the verdict and reason below.",
    "原错误码": "Original error code",
    "所属画布": "Canvas",
    "出问题的节点": "Failing node",
    "出问题的节点：": "Failing node: ",
    "（未知标题）": "(untitled)",
    "（无标题）": "(no title)",
    "错误正文": "Error text",
    "错误正文：": "Error text: ",
    "插件：": "Plugin: ",
    "插件出错": "Plugin error",
    "插件报错详情已排队（关掉当前窗口后显示）":
      "Plugin error details are queued (shown once the current dialog closes)",
    "插件运行期报错。可以交给「自动修复」：会新建一条看得见的会话（工作区 = 该插件的安装目录）按 skill 的【自我修复】模式分析日志并动手修；也可以先看日志自己处理，或直接忽略。":
      "The plugin failed at runtime. Auto-repair opens a visible session (workspace = that plugin's INSTALL_DIR) that follows the skill's self-repair mode: it reads the log, diagnoses and fixes it. You may also inspect the log yourself or just ignore this.",
    "该插件没有上报安装目录，无法确定可写工作区：自动修复不可用，请打开控制台看日志后手动处理。":
      "This plugin reported no install dir, so a writable workspace cannot be determined: auto-repair is unavailable — open the console and fix it manually.",
    "主进程判定这条错误无法自动修复（让 Agent 再跑一遍也不会变好），请按上面的日志手动处理。":
      "The app judged this error not auto-repairable (another agent pass would not change anything) — handle it per the log above.",
    "新建一条左侧栏会话，把日志与上下文交给它修复（工作区 = INSTALL_DIR）":
      "Create a session in the left sidebar and hand it the log plus context (workspace = INSTALL_DIR)",
    "这条错误已经交给自动修复会话": "This error has already been handed to an auto-repair session",
    "自动修复": "Auto-repair",
    "本条错误的自动修复已经用过一次，请对照修复结果与日志手动处理":
      "Auto-repair for this error has already been used once — check the result and the log, then fix it manually",
    "打开控制台看日志": "Open console & log",
    "打开控制台失败：": "Failed to open the console: ",
    "该插件没有可打开的控制台窗口，请看上面的日志尾部":
      "This plugin has no console window to open; see the log tail above",
    "忽略": "Ignore",
    "关掉本窗，不做任何修复动作": "Close this dialog without doing anything",
    "会话能力尚未就绪，请稍后再试": "Sessions are not ready yet — please try again shortly",
    "请使用 skill「": "Use skill ",
    "」的【自我修复】模式。": " in self-repair mode.",
    "本插件没有配套的内置 skill：请按日志证据自行判断根因并修复，不要套用不匹配的旧故障剧本。":
      "This plugin has no bundled skill: diagnose and fix from the log evidence itself, do not force an old failure script onto it.",
    "当前工作区（可写）= INSTALL_DIR=": "Current workspace (writable) = INSTALL_DIR=",
    "（仅参考，不要当作已安装，也不要改这个目录）":
      " (reference only — not an installed copy, and do not modify this directory)",
    "=== 最近失败焦点（以它为准，更早的 Traceback 可能已过时）===":
      "=== Recent failure focus (trust this one; earlier tracebacks may be stale) ===",
    "=== console 最近尾部（更多上下文）===": "=== Recent console tail (more context) ===",
    "展开：console 最近失败焦点": "Show: recent console failure focus",
    "展开：console 日志尾部": "Show: console log tail",
    "展开：console 日志尾部（共": "Show: console log tail (",
    "行）": " lines)",
    "展开：修复会话末条回复": "Show: last reply of the repair session",
    "修复结果": "Repair result",
    "修复结论": "Repair verdict",
    "未成功 · 服务未重启": "Not fixed · service not restarted",
    "（会话未给出 reason）": "(the session gave no reason)",
    "判定依据": "Verdict source",
    "结果文件": "Result file",
    "查看修复会话": "Open the repair session",
    "切到那条会话，看它到底改了什么、卡在哪一步":
      "Switch to that session to see what it changed and where it stopped",
    "该修复会话已不存在": "That repair session no longer exists",
    "修复会话被终止，没有给出结论": "The repair session was terminated without a verdict",
    "修复会话没有给出结论（正文缺 repair_ok=1 / ok=true）":
      "The repair session gave no verdict (reply lacks repair_ok=1 / ok=true)",
    "自动修复未成功，结论见该修复会话": "Auto-repair did not succeed — see the verdict in that session",
    "自动修复未成功（结论窗没能插进去显示，请看该修复会话）":
      "Auto-repair did not succeed (the verdict dialog could not be shown — see that repair session)",
    "服务已重启": "service restarted",
    "修复完成（该插件无常驻服务，已重跑该节点）":
      "repaired (this plugin has no resident service; the node was re-run)",
    "修复完成，可直接重试（该插件无常驻服务）":
      "repaired — just retry (this plugin has no resident service)",
    "修复完成，但服务重启失败：": "repaired, but restarting the service failed: ",
    "完成后：在 INSTALL_DIR 根下创建标记文件 ":
      "When done: create the marker file ",
    "，并写入结果文件 ":
      " at the INSTALL_DIR root, write the result file ",
    "（首行 ok=true，可附 reason= 已修复的简要根因），然后在本会话回复里给出 repair_ok=1 与简要根因。":
      " (first line ok=true, optionally reason=<root cause>) and then reply repair_ok=1 plus a brief root cause in this session.",
    "修不动：": "If it cannot be fixed: ",
    " 写 ok=false 与 reason=<哪一条没交付 + 具体报错>，并在回复里说清还需要用户做什么。":
      " write ok=false with reason=<which deliverable is missing + the exact error>, and spell out what the user still has to do.",
    "纪律（一律遵守）：只允许修改 INSTALL_DIR 内的文件（工作区之外一律不碰）；不要启动后端服务 / ComfyUI / 模型进程；不要删除用户产物目录（output/ 等）；模型与权重已就绪则勿重复下载，只补缺项；skill 里的「已知故障」章节仅当日志证据确实匹配时才参考。优先修依赖 / 脚本 / 配置，再考虑重装。":
      "Discipline (always obey): only modify files inside INSTALL_DIR (never touch anything outside it); do not start the backend / ComfyUI / model processes; do not delete user output directories (output/ etc.); if models and weights are already in place do not re-download them, only fill the gaps; consult the skill's known-failures section only when the log evidence actually matches. Fix dependencies / scripts / config first, reinstall last.",
  });

  /* 「自动修复」置灰时窗内显示的指路文案（payload.why）：中文原文的真源是主进程
     plugin-error-repair.js 的 NOT_REPAIRABLE / judgeRepairability —— 这里只补译文，
     别再在渲染层抄一份判定清单；改那边文案时同步这里的键。 */
  Object.assign(EN, {
    "安装 / 生成是你主动取消的，不是故障。要再来一次，直接点节点或控制台上的「安装 / 启用」。":
      "You cancelled the install / generation yourself — that is not a failure. To try again, click \"Install / Enable\" on the node or in the console.",
    "后端是你手动停掉的，不是故障。到插件控制台点「启用」即可。":
      "You stopped the backend by hand — that is not a failure. Click \"Enable\" in the plugin console.",
    "为了让别的音视频任务用显存，后端被强制结束了，不是故障。下次执行节点会自动重启它。":
      "The backend was force-stopped to free VRAM for another audio/video task — not a failure. The next node run restarts it automatically.",
    "已经有安装 / 修复任务在跑，等它结束再看。":
      "An install / repair task is already running — wait for it to finish.",
    "全局音视频锁被另一个节点占着（同一时刻只允许 1 个音乐 / 视频任务）。等它跑完或先取消它。":
      "The global audio/video lock is held by another node (only 1 music / video task may run at a time). Wait for it, or cancel it first.",
    "全局音视频锁被另一个任务占着，等它结束再试。":
      "The global audio/video lock is held by another task — try again once it finishes.",
    "磁盘剩余空间不够，重装只会再失败一次。请清理磁盘，或在插件控制台换一个剩余空间足够的安装目录。":
      "Not enough free disk space — reinstalling would just fail again. Free up space, or pick an install directory with enough room in the plugin console.",
    "这些后端需要 NVIDIA 显卡，本机没检测到 —— 自动修复装不上 CUDA 版依赖。":
      "These backends need an NVIDIA GPU, which this machine does not have — auto-repair cannot install the CUDA dependencies.",
    "未检测到可用的 NVIDIA 显卡。换机器 / 插卡，或在插件里显式选「仍装 CPU 版（很慢）」后重新安装。":
      "No usable NVIDIA GPU detected. Use another machine / add a card, or explicitly choose \"Install the CPU version anyway (very slow)\" in the plugin and reinstall.",
    "NVIDIA 驱动太旧（跑不了目标 CUDA 算子）。请把驱动升到支持该 CUDA 的版本再重装 —— 自我修复不会替你更新驱动。":
      "The NVIDIA driver is too old (it cannot run the target CUDA kernels). Update the driver to a version supporting that CUDA, then reinstall — self-repair will not update your driver for you.",
    "安装目录不合法（盘根 / 系统目录 / 应用目录一律拒绝）。请在插件控制台重选一个普通用户目录。":
      "The install directory is not allowed (drive roots / system dirs / the app folder are all refused). Pick a normal user directory in the plugin console.",
    "安装目录不能是盘根目录。请在插件控制台重选一个子目录。":
      "The install directory cannot be a drive root. Pick a subfolder in the plugin console.",
    "安装目录不能在系统目录下。请在插件控制台重选一个普通用户目录。":
      "The install directory cannot live under a system folder. Pick a normal user directory in the plugin console.",
    "配置里的安装目录与实际目录不一致。请在插件控制台重新指定安装目录。":
      "The configured install directory does not match the actual one. Re-select it in the plugin console.",
    "节点缺少 id（画布数据异常）。重新添加一个该类型节点再跑。":
      "The node has no id (corrupt canvas data). Add a fresh node of that type and run it.",
    "Agent 网关不可用，自我修复需要它。请重启 MTNode 后再试。":
      "The agent gateway is unavailable, and self-repair needs it. Restart MTNode and try again.",
    "控制台日志为空，没有可供 Agent 分析的现场。先跑一次安装或生成再点修复。":
      "The console log is empty — there is nothing for the agent to analyse. Run an install or a generation first, then click repair.",
    "该插件没在报错总线注册，只能人工看日志处理。":
      "This plugin is not registered on the error bus — it can only be handled manually from its log.",
    "该插件既报不出安装目录（INSTALL_DIR = 修复会话的可写工作区），也取不到现场日志：Agent 没有可干的活。请打开它的控制台看完整日志后手动处理。":
      "This plugin reports neither an install dir (INSTALL_DIR = the repair session's writable workspace) nor a live log: the agent has nothing to work with. Open its console, read the full log, and fix it manually.",
  });

  /* ── 工具构建（renderer/app-toolbuild.js 全链 + app-canvas.js 的入口与对话框）──
     汇总本功能全部中文文案的英文词条；已被别处翻译过的键不覆盖（守卫合并）。 */
  Object.assign(
    EN,
    (function () {
      var add = {
        /* 入口 · 状态 */
        "工具构建": "Tool build",
        "构建中": "Building",
        "构建中…": "Building…",
        "就绪": "Ready",
        "构建失败": "Build failed",
        "工具构建进行中：可点头部 🔧 查看进度":
          "Tool build in progress: click the 🔧 in the node header to see progress",
        "工具构建绿灯：已实测通过并入库":
          "Tool build green: verified with the real file and saved to the library",
        "工具构建失败：点头部 🔧 查看日志":
          "Tool build failed: click the 🔧 in the node header to see the log",
        "工具构建进行中：点击查看方案与进度":
          "Tool build in progress: click to view the plan and progress",
        "工具构建已就绪：点击重开方案对话框 / 查看日志 / 重跑实测":
          "Tool build ready: click to reopen the plan dialog / view the log / re-run the test",
        "工具构建失败：点击查看日志并重试":
          "Tool build failed: click to view the log and retry",
        "该处理节点不支持入线文件，可让 AI 搭一个转换工具":
          "This processing node cannot consume the inbound file — the AI can build a converter tool",
        "入线文件：": "Inbound files: ",
        "正在构建工具…": "Building the tool…",
        "构建失败，详见日志": "Build failed — see the log",
        "已启用工具：": "Tool enabled: ",
        /* 对话框骨架 */
        "AI 先读一遍这个文件，给出能力缺口与转换方案；确认后才在画布上搭建工具节点并实测。":
          "The AI reads this file first and reports the capability gap and a conversion plan; the tool node is built and tested only after you confirm.",
        "处理节点：": "Processing node: ",
        "文件类型：": "File type: ",
        "文件：": "File: ",
        "（无）": " (none)",
        "未知类型": "Unknown type",
        "方案": "Plan",
        "进度": "Progress",
        "尚未生成方案": "No plan yet",
        "（无日志）": " (no log)",
        "（方案为空）": " (plan is empty)",
        /* 按钮 */
        "生成方案": "Generate plan",
        "重新生成方案": "Regenerate plan",
        "让 AI 读这个文件并给出转换方案":
          "Have the AI read this file and propose a conversion plan",
        "让 AI 重新读这个文件并给出方案":
          "Have the AI read this file again and propose a plan",
        "确认开发": "Confirm & build",
        "按此方案搭建工具节点并实测": "Build the tool node to this plan and test it",
        "查看日志": "View log",
        "查看工具构建日志": "View the tool-build log",
        "重跑实测": "Re-run test",
        "用该文件重新试跑当前工具节点":
          "Test-run the current tool node again with this file",
        "管理工具": "Manage tool",
        "打开工具库": "Open tool library",
        "工具库不可用": "Tool library unavailable",
        /* 进度文案 */
        "正在生成方案…": "Generating plan…",
        "方案已生成": "Plan generated",
        "方案生成失败：": "Plan generation failed: ",
        "开始构建：": "Build started: ",
        "构建完成": "Build finished",
        "构建未通过": "Build did not pass",
        "正在用该文件重跑实测…": "Re-running the on-file test…",
        "构建链未就绪（app-toolbuild.js）": "Build chain not ready (app-toolbuild.js)",
        "缺少文件路径": "Missing file path",
        "智能运行入口未就绪": "Agent run entry not ready",
        "试跑入口未就绪（app-tools.js）": "Test-run entry not ready (app-tools.js)",
        /* 中段 · 连线拦截与方案确认 */
        "该处理节点不支持 {ext} 文件":
          "This processing node does not support {ext} files",
        "文件：{path}": "File: {path}",
        "处理节点：{node}": "Processing node: {node}",
        "该文件无法被当前处理节点直接消费。可以启用「工具构建」：由 AI 先给出转换方案，确认后再在画布上搭建一个工具节点，把这种文件转换成处理节点能消费的内容。":
          "This file cannot be consumed directly by the processing node. You can enable \"Tool build\": the AI first proposes a conversion plan, and after you confirm, a tool node is built on the canvas to convert this kind of file into what the node can consume.",
        "是否启用工具构建？": "Enable tool build?",
        /* 连线拦截（app-nodes.js · connectError）与文件来源的文本出口（app.js · allTextItems） */
        "该节点不支持 {ext} 文件：是否进行「工具构建」？":
          "This node does not support {ext} files — run \"Tool build\"?",
        "调用已注册工具「{name}」：入参 {p} = {path}":
          "Call the registered tool \"{name}\": input {p} = {path}",
        "「{n}」接入的文件还没有可用的构建工具：请在该处理节点上启用「工具构建」；工具绿灯后该文件才能被 @ 引用":
          "\"{n}\" has inbound files without a usable build tool yet: enable \"Tool build\" on that processing node — the file can be @-referenced once the tool is green",
        "启用工具构建": "Enable tool build",
        "暂不": "Not now",
        "确认": "Confirm",
        "确认按此方案开发？": "Build to this plan?",
        "确认后将按此方案在画布上搭建工具节点并接入当前连线；未确认前不会改动画布。":
          "Once confirmed, a tool node is built on the canvas per this plan and wired into the current connection; nothing on the canvas changes before you confirm.",
        "文件类型": "File type",
        "拟建工具名": "Proposed tool name",
        "能力缺口说明": "Capability gap",
        "方案要点": "Approach",
        "输入参数表": "Input parameters",
        "输出参数表": "Output parameters",
        "实测用例": "Test case",
        "失败风险": "Risks",
        "工具构建方案": "Tool build plan",
        /* 下半 · 构建链用户可见文案 */
        "工具构建缺少处理节点": "Tool build is missing the processing node",
        "工具构建缺少文件路径": "Tool build is missing the file path",
        "缺少处理节点": "Missing processing node",
        "画布能力未就绪": "Canvas capability not ready",
        "画布能力未就绪，无法搭建工具节点":
          "Canvas capability not ready — cannot build the tool node",
        "工具节点创建失败": "Failed to create the tool node",
        "开发会话创建失败": "Failed to create the development session",
        "会话发送入口未就绪": "Session send entry not ready",
        "工具库保存入口未就绪": "Tool library save entry not ready",
        "工具库 id：": "Tool library id: ",
        "工具名：": "Tool name: ",
        "构建时间：": "Built at: ",
        "实测文件：": "Test file: ",
        "试跑入参 · ": "Test input · ",
        "▶ 用该文件试跑": "▶ Test-run with this file",
        "试跑中…": "Testing…",
        "请先填写要试跑的文件路径": "Enter the file path to test first",
        "试跑没有返回结果": "Test run returned no result",
        "手动试跑（管理窗）：": "Manual test run (manage dialog): ",
        "该工具已保存进工具库（绿灯）。可在下方用实测文件重新试跑，或进「工具库」改名 / 删除 / 随时可调用。":
          "This tool is saved in the tool library (green). Re-run the on-file test below, or rename / delete / toggle always-callable in the tool library.",
        "该工具节点已不在当前画布（可能被删或被切到别的画布）；可在「工具库」里查看已保存的条目。":
          "That tool node is no longer on this canvas (deleted, or on another canvas); see the saved entry in the tool library.",
        "工具构建绿灯：": "Tool build green: ",
        " · 实测文件：": " · test file: ",
        " · 点击打开工具试跑 / 管理": " · click to open the tool test-run / manage dialog",
        "工具构建未绿灯（实测 ": "Tool build not green (test ",
        " 轮未通过）：已记入节点日志": " rounds failed) — recorded in the node log",
        "本文件实测 ": "The on-file test ",
        " 轮未通过：": " rounds failed: ",
        "实测未通过": "Test failed",
        "通过": "Passed",
        "未通过": "Failed",
        "输出：": "Output: ",
        "错误：": "Error: ",
        "（空）": " (empty)",
        "（错误信息为空）": " (empty error message)",
        "已建工具节点「": "Created tool node \"",
        "」（落点 ": "\" (placed at ",
        "已创建开发会话「": "Created development session \"",
        "开发会话本轮结束": "Development session turn finished",
        " · 结论：": " · verdict: ",
        "（会话无正文结论）": " (session gave no text verdict)",
        "（异常：": " (error: ",
        "第 ": "Round ",
        " 轮实测：": " round test: ",
        "已把实测错误回灌开发会话（第 ":
          "Fed the test error back to the development session (round ",
        " 轮）": " round)",
        "绿灯：": "Green: ",
        " · 工具库 id=": " · tool library id=",
        "（未入库）": " (not in library)",
        "未保存进工具库（用户取消或保存失败）":
          "Not saved to the tool library (cancelled or save failed)",
        "（已用 ": " (verified with ",
        " 实测通过）": " and it passed)",
        "（未命名工具）": " (unnamed tool)",
        "未命名工具": "Unnamed tool",
        "参数 ": "Param ",
        "工具": "Tool",
        "文件": "File",
        "解析 ": "Parse ",
        "开发 · ": "Dev · ",
        "本次开发需求：": "This build's requirement: ",
        "给定文件": "given file",
        "按工具构建任务书：用 ": "Per the tool-build brief: use ",
        " 实测通过这个工具": " to verify this tool with the file",
        " 文件（工具构建自动生成 · 输入 file = 文件绝对路径）":
          " file (auto-generated by tool build · input file = absolute file path)",
        "输入文件的绝对路径": "Absolute path of the input file",
        "目标文件：": "Target file: ",
        "（未给出）": " (not given)",
        "（类型：": " (type: ",
        "能力缺口：": "Capability gap: ",
        "方案要点：": "Approach: ",
        "实测用例（方案里给的）：": "Test case (from the plan): ",
        "失败风险：": "Risks: ",
        "【本次工具构建：本文件实测要求】":
          "[This tool build: on-file test requirements]",
        "【工具构建 · 本文件实测未通过，请修复后本轮内收尾】":
          "[Tool build · the on-file test failed — fix it and wrap up this turn]",
        "【工具开发任务书】": "[Tool development brief]",
        "硬要求：① 工具节点的 toolConfig.inputs 第一个参数必须名为 file（kind 为 text，值为输入文件的绝对路径），且 Inputs / outputs 一律按「参数即端子」维护；② 内部子图负责解析该类型文件（读取该路径的文件、按类型抽取成文本 / 生成图像），把结果汇流到工具的输出端子；③ **必须用上面这个真实文件路径实测通过**：开发完成后会自动用该文件试跑这个工具节点，试跑报错就会把错误回灌到本会话继续修，直到通过为止；④ 不要新建 / 删除 / 改动本工具节点与内部子图之外的任何画布节点或连线。":
          "Hard requirements: (1) the tool node's toolConfig.inputs first parameter must be named file (kind text, value = the input file's absolute path), and inputs / outputs are always maintained as \"parameters are ports\"; (2) the internal graph must parse this file type (read the file at that path, extract text / generate images by type) and route the result to the tool's output ports; (3) **you must pass the on-file test with this real path**: when development finishes the tool node is test-run with this file automatically, and failures are fed back into this session until it passes; (4) do not create / delete / modify any canvas node or wire outside this tool node and its internal graph.",
        "实测的运行现场：工具节点由画布引擎执行，内部子图可用文本处理 / 智能任务 / 函数 / 保存等节点；解析文件若需要读本地文件，走函数节点的 mtnode.readText / mtnode.exec（主进程侧、无 window）. 试跑只读口径：不改工具输出、不级联下游。":
          "Where the test runs: the tool node is executed by the canvas engine; the internal graph may use text processing / agent task / function / save nodes. To read local files, use a function node's mtnode.readText / mtnode.exec (main-process side, no window). The test is read-only: it does not change the tool's output or cascade downstream.",
        "请按此错误定位内部子图 / 参数表的问题并修好它；仍然只准改这一个工具节点与它的内部子图，不要动别的节点与连线。修完用一句话说明改了什么，宿主会自动重新实测。":
          "Use this error to locate and fix the internal graph / parameter table; still only change this one tool node and its internal graph — never other nodes or wires. When done, say in one sentence what you changed; the host re-tests automatically.",
        "试跑错误（工具节点「": "Test error (tool node \"",
        "」）：": "\"): ",
        "（": " (",
        "）": ")",
        "关闭": "Close",
        "取消": "Cancel",
        /* ── 长周期任务的超级节点壳与生成工作流预置（renderer/app-longtask-shell.js +
              app-canvas.js 的壳头部徽标）──
           口径：一环节一颗子壳、产出 / 产物落子壳、生成工作流「建好但一律不跑」、
           壳被删不再静默重建。 */
        "长任务": "Long task",
        "环节壳": "Step shell",
        "长周期任务的产出壳": "Output shell of a long-running task",
        "长周期任务的产出壳：": "Output shell of the long-running task: ",
        "长周期任务的产出壳：每个环节一颗子壳，壳内产出 / 产物由任务自动落位；生成工作流由你自己点 ▶ 执行。":
          "Output shell of a long-running task: one step shell per step, with outputs and artifacts placed automatically; you run the generation workflow yourself with ▶.",
        "长任务 · ": "Long task · ",
        "未命名任务": "Untitled task",
        "环节": "Step",
        "【本环节】": "[This step] ",
        "（提示词由长任务按环节自动生成，你可以直接改；改完点本节点的 ▶ 开始生成 —— 生成会消耗额度 / 产生费用）":
          " (this prompt is generated from the step automatically — edit it freely, then press this node's ▶ to generate; generation consumes quota and may cost money)",
        "待你执行": "waiting for you",
        "▶ 由我执行生成": "▶ I run the generation",
        "控制": "Control",
        "图像生成": "Image generation",
        "视频生成": "Video generation",
        "音乐生成": "Music generation",
        "语音合成": "Speech synthesis",
        "已在画布上建立本任务的超级节点：": "Created this task's super node on the canvas: ",
        "已把产出节点收进对应环节的超级节点":
          "Moved the output node into its step's super node",
        "超级节点壳已被删除：不再自动重建（点提示里的「重建」可恢复）":
          "The super-node shell was deleted: it will not be recreated automatically (use \"Rebuild shell\" to restore it)",
        "长任务的超级节点壳已被删除：产出暂留在主画布层。需要壳的话在条带里点「重建壳」":
          "The long task's super-node shell was deleted: outputs stay on the main canvas for now. Use \"Rebuild shell\" in the strip if you want it back",
        "已重建超级节点壳：后续产出会落进对应环节子壳":
          "Rebuilt the super-node shell: later outputs will land in their step shells",
        "重建壳": "Rebuild shell",
        "触发": "Trigger",
        "重建": "Rebuild",
        "超级节点壳被删过：点这里重建父壳（后续产出照常落进对应环节子壳）":
          "The super-node shell was deleted: rebuild the parent shell here (later outputs still land in their step shells)",
        "重建壳失败：长任务壳模块未就绪":
          "Failed to rebuild the shell: the long-task shell module is not ready",
        /* 环节配置（条带检查器）：这一环节要不要生成内容 + 用哪几种生成 */
        "需要生成内容": "Needs generated content",
        "需要生成内容（生成工作流）": "Needs generated content (generation workflow)",
        "勾选后本环节跑到时，会在它的超级节点子壳里预置生成节点与控制节点；一律不自动运行，由你点 ▶ 执行":
          "When checked, this step's super-node shell gets generation and control nodes preset; nothing runs automatically — you press ▶",
        "生成类型": "Generation types",
        "要预置哪几种生成节点（平行摆在同一颗子壳里，各自带提示词与参数）":
          "Which generation nodes to preset (placed side by side in the same step shell, each with its own prompt and settings)",
        /* ── 工具节点「描述自足」（Agent 只凭工具给的信息就能正确调用）──
           数据字段：参数说明 / 可选位 / 调用示例 / 限制与失败情形 /「至少给一个」；
           消费方：app-tools.js 的描述子与失败回执、app-canvas.js 的设置面板与卡片提醒、
           app.js 的 toolSelfSuffMissing 自检、dsh/gateway/tools-plugin.mjs 的 schema。 */
        "本机用户数据目录": "this machine's user-data folder",
        "工具「{name}」的合法用法：": "Valid usage of tool \"{name}\":",
        "· 用途：": "· Purpose: ",
        "· 无入参": "· No inputs",
        "· 以下参数至少给一个：": "· Provide at least one of: ",
        "· 返回：": "· Returns: ",
        "· 限制与失败情形：": "· Limits and failure cases: ",
        "· 最小调用示例（args 一份完整 JSON）：":
          "· Minimal call example (args, a complete JSON object): ",
        "（图像 · 本机绝对路径）": " (image · absolute local path)",
        "（文本）": " (text)",
        " · 可选": " · optional",
        " · 必填": " · required",
        "缺少必填参数：": "Missing required parameter(s): ",
        "以下参数至少要给一个：": "Provide at least one of: ",
        "按调用示例填入": "Fill from call example",
        "调用示例：": "Call example: ",
        "还没有调用示例（在该节点「设置」里写一份，Agent 与你都会用到）":
          "No call example yet (write one in this node's Settings — both you and the agent use it)",
        "用途（描述）": "purpose (description)",
        "每个入参的说明": "description of every input",
        "每个出参的说明": "description of every output",
        "最小调用示例": "minimal call example",
        "调用示例（不是合法 JSON 对象）":
          "call example (not a valid JSON object)",
        "调用示例（键不是入参名：": "call example (keys are not input names: ",
        "限制与失败情形": "limits and failure cases",
        "「至少给一个」的参数组（引用了不存在的入参名）":
          "at-least-one parameter group (references an input that does not exist)",
        "参数说明（这个参数该填什么 · 给 Agent 看）":
          "Parameter description (what goes here · shown to the agent)",
        "参数说明：拼进给模型的参数描述与失败回执（描述自足判据的一项）":
          "Parameter description: goes into the model-facing parameter schema and failure receipts (one of the self-sufficient-description criteria)",
        "（函数节点不参与 Agent 调用）":
          " (function nodes are not callable by the agent)",
        "可选参数：给模型看的必填列表不含它（不勾 = 必填）":
          "Optional parameter: the model-facing required list excludes it (unchecked = required)",
        "可选": "Optional",
        "调用示例 example（一份完整的最小成功调用 · JSON 对象 · 键 = 参数名）":
          "Call example (one complete minimal successful call · JSON object · keys = input names)",
        "会随失败回执一起发给 Agent：接到错误后它照这份示例改参数就能调对":
          "Sent with failure receipts: on error the agent can fix its arguments from this example",
        "限制与失败情形 limits（什么情况下会失败 · 路径与格式规则等）":
          "Limits and failure cases (when it fails · path and format rules, etc.)",
        "例：输出路径必须是绝对路径；落在应用安装目录内会被拒绝；文件不存在会报错":
          "e.g. the output path must be absolute; a path inside the app install folder is refused; a missing file errors out",
        "至少给一个 atLeastOne（一行一组，组内用 / 分隔；如：Markdown内容 / 源文件路径）":
          "At least one of (one group per line, names separated by /; e.g. Markdown内容 / 源文件路径)",
        "这一组参数至少要给一个（Agent 调用前的预检按它判，不用跑一轮内部图才发现）":
          "At least one of this group must be given (the pre-call check uses it, so you do not burn a run to find out)",
        "描述还不自足（Agent 只凭这些信息可能调不对），缺：":
          "Description is not self-sufficient yet (the agent may call it wrong with only this), missing: ",
        "。补齐后 Agent 才能一次调对。":
          ". Fill these in so the agent gets it right the first time.",
        "描述自足检查通过：用途 / 参数含义 / 可选性 / 输出说明 / 调用示例 / 限制与失败情形齐全。":
          "Self-sufficient description check passed: purpose / parameter meanings / optionality / output meanings / call example / limits are all present.",
        "描述不自足（缺 ": "Description not self-sufficient (missing ",
        "）：头部「设置」里补齐，Agent 才能一次调对":
          "): fill it in via the header Settings so the agent gets it right the first time",
        "点头部「设置」补描述 / 参数说明 / 调用示例 / 限制与失败情形":
          "Open header Settings to add the description / parameter descriptions / call example / limits",
      };
      var out = {};
      for (var k in add)
        if (!Object.prototype.hasOwnProperty.call(EN, k)) out[k] = add[k];
      return out;
    })(),
  );

  function listJoin(arr) {
    return (arr || []).join(locale === "en" ? ", " : "、");
  }

  return {
    t: t,
    setLocale: setLocale,
    getLocale: getLocale,
    applyDom: applyDom,
    listJoin: listJoin,
    agentLangCode: agentLangCode,
    agentLangLabel: agentLangLabel,
    agentLangTaste: agentLangTaste,
  };
});
