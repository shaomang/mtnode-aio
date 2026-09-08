"use strict";
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.I18n = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  var ZH_EXTRA = {"help.html":"\r\n  <div class=\"help-body\">\r\n\r\n  <h3>① 节点类型</h3>\r\n  <p>在画布<b>空白处右键</b>弹出菜单添加节点，位置自动吸附网格（默认 24px，可在设置中调整）。共有 4 类节点：</p>\r\n  <ul>\r\n    <li><b>输入节点</b>：文本 / 图像 / 音频 / 视频。内容就地编辑或拖入文件，实时保存；可自由缩放、点击标题重命名。音频 / 视频输入选一个本机文件后可<b>预览</b>，并输出该文件的 <code>file:///</code> URL（可连进 Minimax H3 的参考端子或保存节点）。</li>\r\n    <li><b>处理节点</b>：文本 LLM / 图像生成。连接输入后点击 ▶ 运行，结果在节点右侧展开。</li>\r\n    <li><b>保存节点</b>：将输出保存为 <code>.yaml</code> 文本或图像文件，支持自动保存。</li>\r\n    <li><b>任务节点</b>：把复杂需求拆成内部任务图。每个任务固定有起点、成功终点、失败终点；▶ 从起点沿控制流跑到终点决定成功或失败。可用判断节点（是/否）分流。父任务上以格子展示子任务。</li>\r\n  </ul>\r\n\r\n  <h3>② 连线与继承</h3>\r\n  <ul>\r\n    <li><b>连线</b>：从输出端子拖到输入端子；输入端子默认 1 个，连上一个后自动新增（垂直居中分布）。</li>\r\n    <li><b>输入继承</b>：输入节点一旦连线，内容变为<b>只读并自动继承输入内容</b>；断开连接即恢复可编辑。</li>\r\n    <li><b>自动递归执行</b>：输入包含未处理的上游节点时，运行会自动执行上游直至就绪，再处理当前节点。处理节点完成后会继续执行下游；若下游已有输出，会询问覆盖或不继续。</li>\r\n  </ul>\r\n\r\n  <h3>③ 批量处理</h3>\r\n  <ul>\r\n    <li><b>开启</b>：输入节点右上角「批量」按钮。文本节点通过 ＋ 添加条目 / 导入 / 粘贴 YAML（field=标题，内容=内容）；图像节点可多选或拖入多张。</li>\r\n    <li><b>模式切换</b>：处理节点头部「批量 / 聚合」——批量 = 逐条运行、输出批量结果；聚合 = 所有条目合并为一次运行、输出单个结果。</li>\r\n    <li><b>拆分 / 合并</b>：拆分节点从批次中实时抽取单项；合并节点多输入汇成批次，下游自动批量处理。</li>\r\n    <li><b>命名</b>：批量链上保存节点按 <code>{文件名}_{输入节点标题}</code> 自动命名输出。</li>\r\n  </ul>\r\n\r\n  <h3>④ @ 引用</h3>\r\n  <p>在提示词中输入 <code>@</code> 弹出<b>已连接节点</b>下拉菜单（↑↓ 选择、Enter 确认，未连接的节点不允许引用）。运行时所有输入内容放入 <code>【背景信息】</code>（每条以 <code>### 标题</code> 开头），提示词放入 <code>【内容】</code>；<code>@标题</code> 会去掉 @ 并指向对应背景条目。图像节点引用以<b>参考图像</b>方式传入。</p>\r\n\r\n  <h3>⑤ 运行与预览</h3>\r\n  <ul>\r\n    <li><b>运行</b>：点击节点上的 ▶，自动递归执行上游并处理当前节点；完成后自动执行下游（下游已有内容时询问覆盖或不继续）。</li>\r\n    <li><b>预览</b>：◈ 按钮在运行前查看将要发送的完整请求。</li>\r\n    <li><b>参数</b>：右上角「API」按钮展开服务商 / 模型 / 温度 / 尺寸选择；「多次尝试」可自动重试。</li>\r\n    <li><b>浏览</b>：输出面板头部「浏览」弹窗大窗显示完整输出（文本 / 图像 / 批量全部条目），可一键复制文本。</li>\r\n    <li><b>清空</b>：输出面板头部「清空」移除输出，回到未处理状态。</li>\r\n  </ul>\r\n\r\n  <h3>⑥ 保存与存档</h3>\r\n  <ul>\r\n    <li><b>自动保存</b>：任何编辑数百毫秒内自动写入本地磁盘，启动时自动恢复上次现场。</li>\r\n    <li><b>立即保存 / 存档位置</b>：顶栏「立即保存」手动写盘；「存档位置」直接打开画布保存文件夹（<code>save/</code>，每个工作流一个 JSON 文件）。</li>\r\n    <li><b>工作流管理</b>：顶栏可新建 / 切换 / 删除画布（默认画布 <code>default</code>，删除后自动重建）。</li>\r\n    <li><b>保存节点</b>：文本保存每个输入对应 YAML 一项（键为批量条目 field）；聚合模式全部条目合并为一个文件保存。</li>\r\n  </ul>\r\n\r\n  <h3>⑦ 服务商配置</h3>\r\n  <p>在「设置 · API/配置」中统一管理服务商：默认内置文本与图像两类服务商（可选用 DeepSeek 或 GPT Image 2），也可按「类型」下拉添加兼容接口的自定义服务商。填写后所有模型节点自动读取，API Key 仅保存在本机。</p>\r\n\r\n  <h3>⑧ 其他节点</h3>\r\n  <ul>\r\n    <li><b>会话模式（💬）</b>：智能任务节点头部点 <b>💬</b> 即变微信风格聊天气泡（AI 白左 · 用户绿右），多轮对话随节点保存；模型思考时灰色内容流式显示在「输入中」位置，回复完成后在回答前方出现「思考内容」按钮，点击可查看本条思考全文。原独立的<b>「文本对话」节点已移除</b>，旧画布上的对话节点打开时会自动迁移成这种节点。</li>\r\n    <li><b>文件参考</b>：文本节点右上角 📄 小按钮可导入 txt / md / json / yaml / csv / log 等文件内容（超过 500KB 拒绝导入），不占用节点空间。</li>\r\n    <li><b>控制节点</b>：头部小按钮切换「清空 / 执行」，把控制节点连到目标（或把目标连入控制节点），点击 ▶ 对所有已连接节点同时执行该操作。控制连线为金色，不作为数据输入。</li>\r\n  </ul>\r\n\r\n  <h3>⑨ 快捷键</h3>\r\n  <p><code>Ctrl+Z</code> 撤销 · <code>Ctrl+Y</code> / <code>Ctrl+Shift+Z</code> 重做 · <code>Ctrl+C</code> 复制选中节点 · <code>Delete</code> 删除选中节点 / 连线 / 组 · <code>G</code> 把选中节点组成组 / 解散选中组 · <code>Esc</code> 取消选择 · 点击节点标题就地重命名 · <code>⤢ 居中</code> 缩放定位全部节点。</p>\r\n\r\n  <h3>⑩ 框选与组</h3>\r\n  <ul>\r\n    <li><b>框选</b>：按住 <code>Ctrl + 左键</code> 拖拽画布空白处（或开启顶栏「▭ 框选」模式后直接左键拖拽），松开后框内节点全部选中，可整体移动 / 删除 / 复制。</li>\r\n    <li><b>组</b>：选中多个节点后按 <code>G</code> 或点「◫ 组」→ 输入标题创建组；组为虚线圆角边框，可整体拖动、边缘/角落把手<b>横竖分别缩放</b>（成员达到最小尺寸后整体停止缩放，内部比例不变）、✕ 或右键删除；再次点击「组」按钮 / 按 <code>G</code> 解散组（节点保留）。</li>\r\n    <li><b>边栏</b>：工具栏左侧「☰」打开节点树状列表，顶部输入框可按标题筛选，点击条目画布自动居中定位到该节点。</li>\r\n    <li><b>输出浏览</b>：处理节点输出面板头部「浏览」弹窗大窗显示完整输出（文本 / 图像 / 批量全部条目），可一键复制文本。</li>\r\n    <li><b>会话模式的思考</b>：智能任务的会话模式支持服务商 / 模型选择与请求预览；模型思考时灰色内容流式显示在「输入中」位置，回复完成后在回答前方出现「思考内容」按钮，点击可查看本条思考全文。</li>\r\n  </ul>\r\n\r\n  <h3>⑪ 智能能力（可读文件 / 联网 / 执行命令）</h3>\r\n  <p>接入 DeepSeek Harness 后，模型从「只会生成文字」升级为「会办事」：能<b>读取 / 写入电脑上的文件、联网搜索、执行命令</b>，多步完成后给出结果。运行环境随应用自带（与主程序同版本 Node），引擎随应用启动，<b>无需安装任何东西</b>。启用位置：设置 · API/配置 → <b>「智能能力（DeepSeek Harness / dsh）」</b>；需先配置好带 API Key 的<b>文本服务商</b>（DeepSeek 或其他兼容服务商均可，节点 / 会话上可切换供应商与模型）。</p>\r\n  <ul>\r\n    <li><b>原来只能聊天</b> → <b>智能任务</b>节点（或开了 <b>🐋 智能</b> 的文本节点）里直接说「把 E:\\\\素材 下的 txt 汇总成大纲存成文件」，它会自己去读、去写；工作目录点「浏览」用文件夹窗口选择。</li>\r\n    <li><b>原来只能处理粘贴进来的内容</b> → 文本处理节点点头部 <b>🐋 智能</b>按钮后，提示词成为任务（可写「联网查最新数据再总结」）。</li>\r\n    <li><b>新增「智能任务」节点</b>（右键画布 → 智能节点）：与文本处理节点功能对齐——支持 <b>@ 引用 / 多输入 / 批量 / 聚合 / 模型选择 / 输出浏览</b>，工作目录用文件夹窗口选择；仅移除「多次尝试」（智能任务多步执行，不做并行抽卡）。</li>\r\n    <li><b>让助手搭工作流</b>：在智能任务或智能会话里说「实现 xxx 的工作流」，模型会在当前画布上<b>创建节点、改标题、连线、写入 @引用</b>，并自动从左到右排版（不重叠）。例如「实现物品配置的工作流」会搭出「需求 → 生成配置 → 保存到配置表」管道，你可继续改提示词与保存路径后点 ▶ 运行。</li>\r\n  </ul>\r\n  <p><b>过程可见</b>：运行中显示「◉ 思考中」，点击可实时查看模型思考与<b>工具调用（🔧）</b>；智能节点的回复逐字流式显示。<b>降级保底</b>：关闭各节点智能开关（或设置中关闭总开关），全部回到原有行为。<b>注意</b>：智能模式按「任务完成」计费，一次任务可能多次调用模型；写文件前请确认工作目录正确。</p>\r\n  <p>设置 · 智能能力区块还提供：<b>Agent 预设</b>（通用助手 / 精简执行 / 代码专家 / Cordis 插件开发助手）、<b>对话发送行为</b>（Enter 发送或 Enter 换行）、<b>DSH 插件</b>（dsh 风格可搜索卡片清单，安装 / 启停 / 移除）、<b>技能 Skills</b>（创建即用，智能节点自动发现）、<b>MCP 服务器</b>（连接后智能节点自动获得其工具）。</p>\r\n\r\n  </div>"};
  var EN = {
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
    "锚点文字已变更，批注可能失效": "Anchor text changed — annotation may be stale",
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
    /* ── 复杂任务计划确认 ── */
    "计划确认": "Plan confirmation",
    "目标": "Goal",
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
    "跟随默认（不指定）": "Follow default (not specified)",
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
    "已完成 ": "Done ",
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
    "入参": "Args",
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
    "超节点": "Super",
    "超节点：将选中节点合并为展开的超级节点（覆盖选区范围）":
      "Super: wrap selection into an expanded super node (fits selection bounds)",
    "请先框选 / 选中要合并的节点": "Select nodes to wrap first",
    "请选择同一层级内的节点（不能跨超级节点边界）":
      "Select nodes at the same level (not across super-node boundaries)",
    "已合并为超节点：": "Wrapped into super node: ",
    " 步": " step",
    " 次": " times",
    " 条": " items",
    " 图": " Img",
    " 项": " items",
    " 字": " chars",
    "安装": "Install",
    "保存": "Save",
    "标准": "Standard",
    "参数": "Params",
    "插件": "Plugins",
    "拆分": "Split",
    "创建": "Create",
    "存图": "Save img",
    "存文": "Save txt",
    "当前": "Current",
    "导入": "Import",
    "动画": "Anim",
    "对话": "Chat",
    "返回": "Back",
    "分支": "Fork",
    "复制": "Copy",
    "工具": "Tools",
    "工坊": "Store",
    "关闭": "Close",
    "归档": "Archive",
    "改名": "Rename",
    "重命名该会话(便于管理)": "Rename this session",
    "合并": "Merge",
    "恢复": "Restore",
    "回答": "Reply",
    "会话": "Session",
    "会话 · ": "Session · ",
    "本轮 ": "this round ",
    "输出 ": "Output ",
    "推理 ": "Reasoning ",
    "工具 ": "tools ",
    "当前会话本轮 token 消耗（运行会话后显示）": "Current session round token usage (shown after a run)",
    "居中": "Fit",
    "技能": "Skills",
    "节点": "Node",
    "结果": "Result",
    "就绪": "Ready",
    "拒绝": "Deny",
    "聚合": "Aggregate",
    "类型": "Type",
    "浏览": "Browse",
    "轮第": " Step ",
    "名称": "Name",
    "模型": "Model",
    "内容": "Content",
    "内置": "Built-in",
    "批量": "Batch",
    "排版": "Layout",
    "隐藏线": "Hide wires",
    "启用": "Enable",
    "清除": "Clear",
    "清空": "Clear all",
    "取消": "Cancel",
    "确定": "OK",
    "删除": "Delete",
    "试听": "Preview",
    "输入": "Input",
    "添加": "Add",
    "条目": "Entry",
    "停用": "Disable",
    "讨论": "Forum",
    "图像": "Image",
    "位置": "Location",
    "文本": "Text",
    "卸载": "Uninstall",
    "移除": "Remove",
    "音频": "Audio",
    "执行": "Run",
    "重做": "Redo",
    "撤销": "Undo",
    "只读": "Read-only",
    "智能": "Agent",
    "逐条": "Per item",
    "助手": "Assistant",
    "最强": "Max",
    "作者": "Author",
    " 副本": " copy",
    " 连线": " wires",
    " 条线": " wires",
    " 项）": " items)",
    " 字符": " chars",
    "版本 ": "Version ",
    "不使用": "Don't use",
    "尝试 ": "Attempt ",
    "创建 ": "Created ",
    "创建组": "Create group",
    "错误:": "Error:",
    "未知错误": "Unknown error",
    "服务商": "Provider",
    "供应商": "Provider",
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
    "未挂载": "Not mounted",
    "未选择": "None selected",
    "文生图": "Text-to-image",
    "新会话": "New session",
    "已安装": "Installed",
    "已撤销": "Undone",
    "已复制": "Copied",
    "已挂载": "Mounted",
    "已排版": "Laid out",
    "已启用": "Enabled",
    "已取消": "Cancelled",
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
    " 个节点": " nodes",
    " 个节点到粘贴板（Ctrl+V 粘贴）": " node(s) to clipboard (Ctrl+V to paste)",
    "已粘贴 ": "Pasted ",
    "粘贴板为空，请先 Ctrl+C 复制节点": "Clipboard is empty — press Ctrl+C on nodes first",
    " 个文件": " files",
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
    "保存设置": "Save settings",
    "保存失败": "Save failed",
    "保存图像": "Save image",
    "保存文本": "Save text",
    "保存中…": "Saving…",
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
    "画布名称": "Canvas name",
    "缓存命中": "Cache hit",
    "历史会话": "Session history",
    "连线操作": "Wire actions",
    "另存为…": "Save as…",
    "没有改动": "No changes",
    "模型服务": "Model services",
    "模型列表": "Model list",
    "默认目录": "Default directory",
    "切割列数": "Grid columns",
    "切割行数": "Grid rows",
    "请求超时": "Request timed out",
    "全部文件": "All files",
    "确认删除": "Confirm delete",
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
    "图像生成": "Image generation",
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
    "已删除 ": "Deleted ",
    "已添加 ": "Added ",
    "已停用 ": "Disabled ",
    "已卸载 ": "Uninstalled ",
    "已移除 ": "Removed ",
    "已载入 ": "Loaded ",
    "允许一次": "Allow once",
    "暂无会话": "No sessions yet",
    "暂无节点": "No nodes yet",
    "暂无条目": "No entries yet",
    "展开分类": "Expand category",
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
    "安装失败：": "Install failed: ",
    "保存失败：": "Save failed: ",
    "操作失败：": "Operation failed: ",
    "处理失败：": "Process failed: ",
    "创建失败：": "Create failed: ",
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
    "请求已中止": "Request aborted",
    "删除该条目": "Delete this entry",
    "删除画布": "Delete canvas",
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
    " 个模型": " models",
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
    "<参考图: ": "<Ref image: ",
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
    "刚刚": "just now",
    " 分钟前": " min ago",
    " 小时前": " hr ago",
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
    "粘贴 Base64": "Paste Base64",
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
    "）· 重新打开设置重试": ") · Reopen Settings to retry",
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
    "工作目录最外层文件夹: ": "Working directory top folder: ",
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
    "。保存后自动生成模型列表。": ". Model list is generated automatically after saving.",
    "（等待上游输出…）内容只读": "(Waiting for upstream output…) content is read-only",
    "（等待上游输出中）内容只读": "(Waiting for upstream output) content is read-only",
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
    "⧉ 合并（多节点 → 批次）": "⧉ Merge (multiple nodes → batch)",
    "拆分出的只读节点（不可编辑）": "Split-out read-only node (not editable)",
    "复制选中节点（Ctrl+C）": "Copy selected nodes (Ctrl+C)",
    "画布包含无法序列化的数据：": "Canvas contains data that cannot be serialized: ",
    "留空 = 应用默认数据目录…": "Leave empty = app default data directory…",
    "停止回复（立即中止模型请求）": "Stop reply (abort the model request immediately)",
    "停止运行（立即中止模型请求）": "Stop run (abort the model request immediately)",
    "图像保存节点需要一个图像输入": "Image save node needs one image input",
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
    "清除统一目录,恢复各节点单独设置": "Clear shared directory, restore per-node settings",
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
    "MTNode AI编排器 发生错误": "MTNode AI Orchestrator encountered an error",
    "⧗ 动画（图像 → GIF 帧动画）": "⧗ Anim (image → GIF frame animation)",
    "保存输出到本地（YAML / 图像）": "Save output locally (YAML / image)",
    "导出失败：画布包含无法序列化的数据": "Export failed: canvas contains data that cannot be serialized",
    "服务商（自动读取全局 API 配置）": "Provider (reads global API config automatically)",
    "横向缩放（仅改变横向布局，纵向不变）": "Scale horizontally (layout width only; height unchanged)",
    "请先指定保存路径（可用「浏览」选择）": "Set a save path first (use \"Browse\" to choose)",

    "请先在节点设置中指定输出路径（可用「浏览」选择）":
      "Set an output path in node settings first (use \"Browse\" to choose)",
    "输出路径（必填）": "Output path (required)",
    "未设置输出路径时无法启动生成": "Generation cannot start until an output path is set",
    "未设置路径": "path not set",
    "文件不存在（生成后将显示于此）": "File not found (will appear here after generate)",
    "目标文件已存在，改为保存为：": "File exists — saving as: ",
    "已取消音乐生成": "Music generation cancelled",
    "已取消视频生成": "Video generation cancelled",
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
    "无人值守（工作区读写 · 不询问，默认）": "Unattended (workspace read/write · no prompts, default)",
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
    "」· 点击切换（无 / 低 / 中 / 高）": "\" · Click to cycle (Off / Low / Medium / High)",
    "本次智能运行的统计（与 dsh 客户端一致）": "Stats for this agent run (same as the dsh client)",
    "复制该会话为新会话(参考 dsh fork)": "Duplicate this session as a new one (like dsh fork)",
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
    "粘贴 .mtnodes 的 Base64 内容：": "Paste Base64 content of a .mtnodes file: ",
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
    "加载中…": "Loading…",
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
    "例如：将输入内容总结为三句话… 输入 @ 引用已连接节点": "e.g. Summarize the input in three sentences… type @ to reference connected nodes",
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
    "。可选:mtnode-unattended(无人值守) / workspace-write(读写·审批) / read-only(只读·审批) / danger-full-access(完全放行)。在 设置 → 智能能力 中切换。": ". Optional: mtnode-unattended (unattended) / workspace-write (read/write · approve) / read-only (read-only · approve) / danger-full-access (full access). Switch in Settings → Agent capability.",
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
    "help.html": "  <div class=\"help-body\">\n\n  <h3>1. Node types</h3>\n  <p>Right-click <b>empty canvas</b> to add a node. Positions snap to the grid (default 24px, adjustable in Settings). There are 4 families:</p>\n  <ul>\n    <li><b>Input nodes</b>: text / image / audio / video. Edit in place or drop files; saved live. Resize freely; click the title to rename. Audio and video inputs pick a local file to <b>preview</b> and output its <code>file:///</code> URL, which can feed a Minimax H3 reference slot or a save node.</li>\n    <li><b>Process nodes</b>: text LLM / image generation. Connect inputs, click ▶ to run; results expand on the right.</li>\n    <li><b>Save nodes</b>: write output as <code>.yaml</code> text or image files, with optional auto-save.</li>\n    <li><b>Task nodes</b>: a task graph with a pinned start and success/fail ends; ▶ fires start and status depends on which end is reached. A judge node branches yes/no. Sub-tasks show as a grid on the parent.</li>\n  </ul>\n\n  <h3>2. Wires and inheritance</h3>\n  <ul>\n    <li><b>Wires</b>: drag from an output port to an input port. Nodes start with 1 input; a new port appears after each connection (vertically centered).</li>\n    <li><b>Input inheritance</b>: once an input node is wired, its content becomes <b>read-only and inherits the upstream value</b>; disconnect to edit again.</li>\n    <li><b>Auto recursive run</b>: if inputs include unprocessed upstream nodes, run executes upstream until ready, then the current node. After a process node finishes, downstream runs automatically; if those nodes already have output, you can overwrite or stop.</li>\n  </ul>\n\n  <h3>3. Batch processing</h3>\n  <ul>\n    <li><b>Enable</b>: the “Batch” button on input nodes. Text nodes: ＋ add entries / import / paste YAML (field = title, body = content). Image nodes: multi-select or drop several files.</li>\n    <li><b>Mode</b>: process-node header “Batch / Aggregate” — Batch = one run per item; Aggregate = all items in one run, single output.</li>\n    <li><b>Split / Merge</b>: Split extracts one item from a batch in real time; Merge gathers inputs into a batch so downstream runs in batch.</li>\n    <li><b>Naming</b>: save nodes on a batch chain auto-name files as <code>{filename}_{input node title}</code>.</li>\n  </ul>\n\n  <h3>4. @ references</h3>\n  <p>Type <code>@</code> in a prompt to open a dropdown of <b>connected nodes</b> (↑↓ to select, Enter to confirm; unconnected nodes cannot be referenced). At run time all inputs go into <code>【背景信息】</code> (each block starts with <code>### title</code>) and the prompt goes into <code>【内容】</code>; <code>@title</code> drops the @ and points at that background block. Image-node refs are passed as <b>reference images</b>.</p>\n\n  <h3>5. Run and preview</h3>\n  <ul>\n    <li><b>Run</b>: click ▶ on a node to recursively run upstream and then the node; when it finishes, downstream runs automatically (if they already have output, choose overwrite or stop).</li>\n    <li><b>Preview</b>: the ◈ button shows the full request before sending.</li>\n    <li><b>Params</b>: the “API” button picks provider / model / temperature / size; “Attempts” can retry automatically.</li>\n    <li><b>Browse</b>: the output header “Browse” opens a large viewer (text / image / all batch items) with one-click copy.</li>\n    <li><b>Clear</b>: the output header “Clear” removes output and returns to the unprocessed state.</li>\n  </ul>\n\n  <h3>6. Save and archives</h3>\n  <ul>\n    <li><b>Auto-save</b>: edits are written to local disk within a few hundred milliseconds; the last session is restored on startup.</li>\n    <li><b>Save now / archive folder</b>: toolbar “Save now” writes immediately; “Archive folder” opens the workflow save directory (<code>save/</code>, one JSON per workflow).</li>\n    <li><b>Workflows</b>: the toolbar can create / switch / delete workflows (default id <code>default</code>, recreated after delete).</li>\n    <li><b>Save nodes</b>: text save writes one YAML field per input (key = batch field); aggregate mode merges all items into one file.</li>\n  </ul>\n\n  <h3>7. Providers</h3>\n  <p>Manage providers in “Settings · API/Config”. Built-in text and image providers (DeepSeek or GPT Image 2) plus custom compatible APIs via the Type dropdown. Model nodes read this config automatically; API keys stay on this machine only.</p>\n\n  <h3>8. Other nodes</h3>\n  <ul>\n    <li><b>Chat mode (💬)</b>: click 💬 in an <b>Agent task</b> node header for WeChat-style bubbles (AI white-left · user green-right); the multi-turn history is saved with the node. The old standalone <b>Chat node was removed</b> — chat nodes on older canvases migrate into an agent task in chat mode on open.</li>\n    <li><b>File reference</b>: the 📄 button on a text node imports txt / md / json / yaml / csv / log (rejected over 500KB) without using node space.</li>\n    <li><b>Control node</b>: header buttons switch Clear / Run; wire the control node to targets (or wire targets into it), then ▶ applies that action to all connected nodes at once. Control wires are gold and are not data inputs.</li>\n  </ul>\n\n  <h3>9. Shortcuts</h3>\n  <p><code>Ctrl+Z</code> undo · <code>Ctrl+Y</code> / <code>Ctrl+Shift+Z</code> redo · <code>Ctrl+C</code> duplicate selected nodes · <code>Delete</code> delete selected nodes / wires / groups · <code>G</code> group selected nodes / ungroup · <code>Esc</code> clear selection · click a node title to rename · <code>⤢ Fit</code> zoom to all nodes.</p>\n\n  <h3>10. Box-select and groups</h3>\n  <ul>\n    <li><b>Box-select</b>: hold <code>Ctrl + left click</code> and drag on empty canvas (or enable toolbar “▭ Box” and drag with left click). Nodes inside the box are selected for move / delete / duplicate.</li>\n    <li><b>Group</b>: select nodes, then <code>G</code> or “◫ Group”, enter a title. Dashed rounded frame; drag as a whole; edge/corner handles <b>scale X and Y independently</b> (stops when a member hits min size); ✕ or right-click to delete; click Group / press <code>G</code> again to ungroup (nodes remain).</li>\n    <li><b>Sidebar</b>: toolbar “☰” opens the node tree; filter by title; click an item to center it on the canvas.</li>\n    <li><b>Output browse</b>: process output header “Browse” opens a large viewer with copy.</li>\n    <li><b>Chat-mode thinking</b>: agent-task chat mode supports provider / model / request preview; thinking streams in gray at the “typing” slot; after the reply, a “Thinking” button shows that turn’s full reasoning.</li>\n  </ul>\n\n  <h3>11. Agent capability (read files / search / run commands)</h3>\n  <p>With DeepSeek Harness the model can <b>read / write files, search the web, and run commands</b>, then return a result. The runtime ships with the app (same Node version); the engine starts with the app — <b>nothing extra to install</b>. Enable it in Settings · API/Config → <b>“Agent (DeepSeek Harness / dsh)”</b>. Configure a <b>text provider</b> with an API key first (DeepSeek or any compatible provider; switch provider/model per node or session).</p>\n  <ul>\n    <li><b>From chat-only</b> → use an <b>Agent task</b> node (or 🐋 Agent on a text node) and say “summarize every txt under E:\\\\assets into an outline file”; it will read and write. Pick the workspace with “Browse”.</li>\n    <li><b>From pasted content only</b> → turn on <b>🐋 Agent</b> on a text-process node so the prompt becomes a task (e.g. “search the web for the latest data and summarize”).</li>\n    <li><b>Agent Task node</b> (right-click → Agent node): aligned with text-process — <b>@ refs / multi-input / batch / aggregate / model / browse</b>, folder picker for workspace; no “attempts” (multi-step agent runs, not parallel sampling).</li>\n    <li><b>Let the assistant build a workflow</b>: in an agent task or agent session, say “build a workflow for xxx”. The model <b>creates nodes, renames them, wires them, and writes @refs</b>, laid out left-to-right. Example: an item-config pipeline “requirements → generate config → save to table” that you can edit and ▶ run.</li>\n  </ul>\n  <p><b>Visible process</b>: running shows “◉ Thinking”; click to watch reasoning and <b>tool calls (🔧)</b>; agent replies stream live. <b>Fallback</b>: turn off per-node agent switches (or the global switch) to restore original behavior. <b>Note</b>: agent mode is billed per completed task and may call the model several times; confirm the workspace before writing files.</p>\n  <p>The Agent settings block also has: <b>Agent presets</b> (General / Concise / Code expert / Cordis plugin helper), <b>chat send keys</b> (Enter to send or Enter for newline), <b>DSH plugins</b> (searchable cards, install / enable / remove), <b>Skills</b> (create and use immediately), <b>MCP servers</b> (tools become available to agent nodes).</p>\n\n  </div>\n",
    "工作流编排": "Canvas",
    "画布": "Canvas",
    "智能会话": "Agent session",
    "↶ 撤销": "↶ Undo",
    "↷ 重做": "↷ Redo",
    "⧉ 复制节点": "⧉ Duplicate",
    "⤢ 居中": "⤢ Fit",
    "▭ 框选": "▭ Box",
    "◫ 组": "◫ Group",
    "设置 · API/配置": "Settings · API/Config",
    "新建": "New",
    "更改名称": "Rename",
    "导出": "Export",
    "预设": "Preset",
    "思考强度": "Thinking",
    "＋ 新会话": "+ New session",
    "全局助手": "Global assistant",
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
    "我能看到当前画布、节点与配置，也可参考其他画布列表。\n可以说「总结画布」或「搭一个 xxx 工作流」。\n改节点图或删除画布前会请你确认。":
      "I can see the canvas, nodes, and settings, and can list other canvases.\nTry \"summarize the canvas\" or \"build a xxx workflow\".\nGraph edits or deleting a canvas will ask for confirmation.",
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
    "控制": "Control",
    "控制节点": "Control Node",
    "控制节点（批量清空 / 执行）": "Control Node (batch clear / run)",
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
    "选择 SKILL.md": "Choose SKILL.md",
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
    "更新": "Update",
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
    " 个节点": " nodes",
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
    "立即重启": "Restart now",
    "稍后重启": "Later",
    "立即安装并重启": "Install & restart",
    "稍后": "Later",
    "更新已就绪": "Update ready",
    "更新包已下载完毕（v": "Update package downloaded (v",
    "）": ")",
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
    "已整理排版（含超级节点内部）": "Layout tidied (including super insides)",
    "已整理排版": "Layout tidied",
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
    "工作范围": "Work scope",
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
    "连续生成次数（1–10）；多次时输出命名为 _01、_02 …":
      "Sequential generations (1–10); multiple runs save as _01, _02 …",
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
    "节点指南": "Node guide",
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
    "目标与任务清单": "Goals & task list",
    "跨轮续跑目标 + Todo 清单": "Cross-run goals + Todo list",
    "后台命令与子代理的收流 / 终止": "Collect output from / kill background jobs & subagents",
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
    "工具：": "Tools: ",
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
    "若仍要创建节点，edit 必须传 layout:false，且禁止 group。":
      " To still create nodes, pass layout:false and do not use group.",
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
    "已开启：助手改画布不再弹确认": "On: assistant canvas edits skip confirm",
    "已关闭：助手改画布需确认": "Off: assistant canvas edits need confirm",
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
    "一键排版：按连线关系整理节点位置；可选同时排版超级节点内部（可撤销）":
      "Auto layout by wire flow; optionally include super insides (undoable)",
    "一键排版：交由全局助手执行紧凑排版（可撤销）":
      "Auto layout by wire flow (undoable)",
    "确定进行一键排版？\n\n将由全局助手基于 AI 分析并调整画布节点位置，可能需要等待一段时间，请耐心等候。操作可撤销。":
      "Run auto layout?\n\nNodes will be arranged by wire flow (undoable).",
    "批次拆分已完成。是否进行重新排版？\n\n将按连线关系整理节点位置。":
      "Batch split done. Run auto layout?\n\nNodes will be rearranged by wire flow.",
    "画布上没有节点": "No nodes on the canvas",
    "已整理排版": "Layout tidied",
    "已整理排版（含超级节点内部）": "Layout tidied (including super insides)",
    "已紧凑排版": "Compact layout applied",
    "排版失败：": "Layout failed: ",
    "隐藏线：临时把所有连线压到 95% 透明（几乎不可见），排版后看清布局；再次点击恢复":
      "Hide wires: fade every wire to 95% transparency (nearly invisible) so the layout reads clearly; click again to restore",
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
    "选择新的配置数据目录，保存后需重启":
      "Choose a new config data folder; restart required after saving",
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
    " 个节点": " downstream nodes",
    "；": "; ",
    " 个聚合节点将接入全部新节点": " aggregate node(s) will connect to all new nodes",
    "。原批次节点会被移除。是否继续？":
      ". The original batch node will be removed. Continue?",
    "已拆分批次：": "Batch split: ",
    " 条": " items",
    " · 下游 ": " · downstream ",
    "批次拆分已完成。是否进行 AI 重新排版？\n\n将由全局助手分析并调整节点位置，可能需要等待一段时间。":
      "Batch split done. Run AI re-layout?\n\nThe global assistant will analyze and adjust node positions; this may take a while.",
    "节点操作": "Node actions",
    "查找节点（标题 / 内容）…": "Find nodes (title / content)…",
    "替换为…": "Replace with…",
    "上一个（Shift+Enter）": "Previous (Shift+Enter)",
    "下一个（Enter）": "Next (Enter)",
    "替换": "Replace",
    "全部替换": "Replace all",
    "关闭（Esc）": "Close (Esc)",
    "未找到匹配的节点": "No matching nodes",
    "请输入要查找的文本": "Enter text to find",
    "已替换 ": "Replaced ",
    "智能节点不能读取或编辑画布、修改节点图或创建任务。请使用读写文件、联网、命令、技能与识图完成任务。":
      "Agent nodes cannot read or edit the canvas, change the node graph, or create tasks. Use file read/write, network, commands, skills, and vision instead.",
    "本次运行为智能节点：即使审批预设允许，也不可使用读取画布、节点与连线、控制类节点、绘图、排版与成组、应用操作、删除画布。":
      "This run is an agent node: even if the Approvals preset allows them, canvas read/edit, nodes and wires, control nodes, drawings, layout/groups, app operations, and deleting canvases are unavailable.",
    "工作范围": "Work scope",
    "限制助手可访问的画布范围": "Limit which canvases the assistant may access",
    "当前画布": "Current canvas",
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
    "插件：可选组件（桌宠等），按需下载安装":
      "Plugins: optional components (desktop pet, etc.), download on demand",
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
    "任务（规划 · 可进入分段解决）": "Task (plan · enter to solve in parts)",
    "超级节点": "Super node",
    "超级节点（收纳 · 展开子画布）": "Super node (pack · expand sub-canvas)",
    "说明：此超级节点收纳的内容与用途…":
      "Describe what this super node packs and why…",
    "内部 ": "Inside ",
    " 个节点": " nodes",
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
    "输入": "In",
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
    "失败": "Failed",
    "需干涉": "Needs attention",
    "＋ 任务": "+ Task",
    "在内部新增一个子任务（含起点与终点）": "Add an inner sub-task (with start and end)",
    "暂无子任务 · 添加任务或进入内部编排": "No sub-tasks yet · add a task or enter to build the graph",
    "任务目标 / 本任务要解决什么": "Goal / what this task should solve",
    "已添加子任务：": "Added sub-task: ",
    "起点": "Start",
    "成功终点": "Success end",
    "失败终点": "Fail end",
    "成功": "Success",
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
    "无效的超级节点：": "Invalid super node: ",
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
    "可以问「闸门为什么不放行」「如何配置 API Key」等。回答只依据左侧手册。":
      "Try “Why won’t the gate open?” or “How do I set an API Key?”. Answers use the left-hand manual only.",
    "讨论区": "Forum",
    "MTNode 讨论区": "MTNode Forum",
    "MTNode 讨论区：与创意工坊同一账户，登录后聊天并同步近 3 天消息":
      "MTNode Forum: same account as Creative Workshop; chat after sign-in and sync the last 3 days",
    "工作目录（必填）": "Working directory (required)",
    "请选择已存在的文件夹…": "Choose an existing folder…",
    "新建画布必须指定工作目录。智能节点与相对保存路径都相对该目录，缺少目录会导致读写失败。":
      "A new canvas must have a working directory. Agent nodes and relative save paths use it; missing it causes read/write failures.",
    "请选择工作目录": "Choose a working directory",
    "工作目录不存在或不是有效文件夹": "Working directory does not exist or is not a valid folder",
    "请先下载安装讨论区": "Install the forum plugin first",
    "打开讨论区": "Open forum",
    "已内置": "Built-in",
    "内置组件可直接打开；桌宠等可选组件按需下载，不随主程序安装包分发。":
      "Optional add-ons such as the forum and desktop pet are downloaded on demand and are not in the installer.",
    "小型聊天窗口，与创意工坊共用账户。综合区 / Bug 提交 / 功能改进；本地保存记录并同步近 3 天消息。":
      "A small chat window sharing the Creative Workshop account. General / Bugs / Ideas; history is kept locally and the last 3 days are synced.",
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
    "打开控制台": "Open console",
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
    "无法连接 GPT-SoVITS 后端（后端可能已退出，请重新执行本节点）":
      "Cannot reach the GPT-SoVITS backend (it may have exited — run this node again)",
    "提示词（Structured Caption）": "Prompt (Structured Caption)",
    "歌词（含 [Verse]/[Chorus] 等标签）": "Lyrics (with [Verse]/[Chorus] tags)",
    "请连接提示词输入（端子 P）": "Connect a prompt input (port P)",
    "请连接歌词输入（端子 L）；纯器乐可用 [instrumental]":
      "Connect lyrics input (port L); use [instrumental] for no vocals",
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
    "关闭": "Close",
    "输入": "Input",
    "提交": "Submit",
    "选择": "Select",
    "画布": "Canvas",
    "保存中…": "Saving…",
    "未保存": "Unsaved",
    "思考中": "Thinking",
    "就绪": "Ready",
    "中心": "Hub",
    "播放": "Play",
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
    "已删除 ": "Deleted ",
    " 个本轮新建文件": " file(s) created this round",
    "跳过 ": "Skipped ",
    " 项（": " item(s) (",
    "失败 ": "Failed ",
    " 项": " item(s)",
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
    "保存失败：": "Save failed: ",
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
    "文件": "File",
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
    "关系线上的文字（如：调用 / 依赖 / 实现 / 包含）":
      "Label on the relation line (e.g. calls / depends / implements / contains)",
    "编辑线上文字": "Edit Line Label",
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
    "（无）": "(none)",
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
    "（未设置）": "(not set)",
    "下层元素": "Lower elements",
    "（无 · 可点「细化」展开）": "(none · click Refine to expand)",
    "最近一次要求": "Last request",
    "个": "items",
    " 个": " item(s)",
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
    " 条": " item(s)",
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
    "建议：弹窗确认后由 AI 依据项目真实代码与开发进度评估下一步（给出 4 条方案 · 可多选 + 补充 · 选完可就地开发）":
      "Suggest: after a confirmation dialog the AI assesses the next step from the real project code and this module's dev progress (4 options · multi-select + supplement · develop right away)",
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
    "（继承自「": " (inherited from ",
    "」：": ": ",
    "」）": ")",
    "」）· 点击为本功能块单独选择":
      ") · click to give this block its own pick",
    " · 点击修改（未自行选择的子功能块会继承）":
      " · click to change (child blocks without their own pick inherit it)",
    "未选择：本功能块与子功能块的「建议 / 开发 / 细化」跟随默认模型。":
      "Not set: this block and its child blocks follow the default model for Suggest / Develop / Refine.",
    "当前继承自「": "Currently inherited from ",
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
    " 条 · ": " items · ",
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
    "⏳ AI 调研中 · 点「建议」看进度":
      "⏳ AI researching · click \"Suggest\" to see progress",
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
    /* ===== 开发节点：问询（AI 只读回答模块问题） ===== */
    "问询": "Ask",
    "问询：弹窗确认后由 AI 只读回答关于本模块的问题（不改文件、不改画布）":
      "Ask: after a confirmation dialog the AI answers questions about this module read-only (no file or canvas changes)",
    "💬 AI 回答中 · 点「问询」看进度":
      "💬 AI answering · click \"Ask\" to see progress",
    "💬 问询已就绪（未查看）": "💬 Ask answer ready (unviewed)",
    "点击查看 AI 给出的回答（问询只读 · 不改任何文件）":
      "Click to view the AI's answer (ask is read-only · no file changes)",
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
    "删除失败：": "Delete failed: ",
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
    /* ── 工具 / 函数节点（T1 渲染层）── 全文案随 T5 统一补，这里先落英文档 */
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
    "重命名失败：": "Rename failed: ",
    "已重命名为：": "Renamed to: ",
    "删除「{name}」": "Delete “{name}”",
    "该分类（含子分类）下还有 {n} 个素材：请先移走或删除其中的素材。":
      "This category (including subcategories) still holds {n} asset(s): move or delete them first.",
    "删除空分类「{name}」？\n\n文件夹会移进素材库根目录的 .trash（不会真的删掉），在资源管理器里可手工找回。":
      "Delete the empty category “{name}”?\n\nThe folder goes into <root>/.trash (nothing is really deleted) and can be restored by hand in the file manager.",
    "删除分类": "Delete category",
    "已删除分类（进回收站）：": "Category deleted (moved to trash): ",
    "在资源管理器中打开": "Open in file manager",
    "打不开该目录": "Cannot open that folder",
    /* 右栏 · 素材卡片 */
    "当前位置：": "Current location: ",
    "素材": "Asset",
    "素材 ": "Assets: ",
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
    "选择要上传为素材的文件夹": "Choose the folder to upload as an asset",
    "上传失败：": "Upload failed: ",
    "已上传为素材：{name}（内容 {n} 条）": "Uploaded as asset “{name}” ({n} item(s))",
    "已上传为素材：{name}（内容 {n} 条 · 跳过 {s} 个不支持的文件）":
      "Uploaded as asset “{name}” ({n} item(s), {s} unsupported file(s) skipped)",
    "删除素材（移进素材库回收站，不实删）":
      "Delete the asset (moved to the library trash, not really deleted)",
    "删除素材「{name}」？\n\n整个素材文件夹会移进素材库根目录的 .trash（不实删）。已插入画布的「素材」节点会显示为「素材失联」，节点本身保留。":
      "Delete the asset “{name}”?\n\nIts whole folder moves into <root>/.trash (nothing is really deleted). “Asset” nodes already on a canvas will show “asset unavailable”, but the nodes themselves stay.",
    "删除素材": "Delete asset",
    "已删除素材（进回收站）：": "Asset deleted (moved to trash): ",
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
    "重新命名（文件夹）": "Rename (folder)",
    "素材节点尚未就绪": "Asset nodes are not ready yet",
    "插入失败：无法创建素材节点": "Insert failed: cannot create the asset node",
    "已插入素材：": "Asset inserted: ",
    "删除的内容进根目录 .trash（不实删）":
      "Deleted content goes into <root>/.trash (nothing is really deleted)",
    /* ── 素材节点（kind asset）：内容条目即端子 · body 内容列表 ── */
    "视频": "Video",
    "无效的输入端子": "Invalid input port",
    "内容 ": "Item ",
    "内容端子 ": "Content port ",
    "内容端子「": "Content port “",
    "输出内容「": "Outputs content “",
    "更换": "Replace",
    "读取中…": "Loading…",
    "素材节点（绑定素材库 · 内容条目即端子）":
      "Asset node (binds the library · content items are the ports)",
    "）· 与同名输出端子一一对应 · 连入即同步到该条目":
      "” · pairs 1:1 with the output port of the same name · wiring in syncs into that item",
    "）· 文本给字符串 · 图像 / 音频 / 视频给 file:/// URL":
      "” · text yields a string · image / audio / video yield a file:/// URL",
    "左右两个端子同一条目：连入即写入素材库，输出即读出该条目的内容":
      "Both ports are the same item: wiring in writes into the library, the output reads that item back",
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
    "连入即写库（空则自动同步，已有内容则点端子上的 ⟳ 更换），输出即读出该条内容":
      "Wiring into it writes to the library (empty syncs automatically; otherwise press ⟳ on the port), reading out yields this item's content",
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
    "删除内容「{name}」？\n\n· 节点上这一对端子会消失，挂在它上面的连线一并断开（Ctrl+Z 可复原节点与连线）\n· 实体文件移进素材库根目录的 .trash（不会真的删掉）\n\n要恢复文件请从资源管理器里找回。":
      "Delete the content item “{name}”?\n\n· The pair of ports on the node disappears and any wire on them is cut (Ctrl+Z restores the node and the wires)\n· The file moves into the library root's .trash (nothing is really deleted)\n\nTo get the file back, restore it from the file explorer.",
    "删除内容": "Delete content",
    "删除内容失败：": "Failed to delete the content item: ",
    "已删除内容：{name}（端子与连线可撤销 · 文件进回收站）":
      "Content deleted: {name} (ports and wires undoable · file moved to the trash)",
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
    "1x（关）": "1x (off)",
    "2x（推荐）": "2x (recommended)",
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
    "4K 超分补帧（默认开，24G 建议关以提速）":
      "4K upscale & frame interpolation (on by default; turn off on 24G for speed)",
    "4K 超分补帧": "4K upscale & interpolation",
    "RIFE 补帧 + Real-ESRGAN x4 超分 → 4K（需安装后处理模型）":
      "RIFE interpolation + Real-ESRGAN x4 upscale → 4K (needs the post-processing models)",
    "补帧 RIFE": "Interpolate first (RIFE)",
    "低分辨率先补帧，再超分；时序更稳更省显存":
      "Interpolate at low resolution, then upscale — steadier in time, lighter on VRAM",
    "补帧倍数": "Interpolation multiplier",
    "超分批量": "Upscale batch size",
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
  });

  var locale = "zh";

  function t(key, vars) {
    if (key == null || key === "") return "";
    var s;
    if (locale === "en" && Object.prototype.hasOwnProperty.call(EN, key)) s = EN[key];
    else if (Object.prototype.hasOwnProperty.call(ZH_EXTRA, key)) s = ZH_EXTRA[key];
    else s = String(key);
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
      /* 顶栏纯 icon 按钮用 data-tip 做即时 hover 提示，避免原生 title 延迟 */
      if (el.classList && el.classList.contains("btn-ico")) {
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
    "已同步到素材库：": "Synced into the asset library: ",
    "（Ctrl+Z 可撤销）": " (Ctrl+Z to undo)",
    "同步失败：": "Sync failed: ",
    "素材库：{n} 条原本没有内容的条目已自动同步（Ctrl+Z 可撤销）":
      "Asset library: {n} empty content entry(s) were synced automatically (Ctrl+Z to undo)",
    "这个端子连入了新内容，与素材库里那份不同 · 点 ⟳ 才更换（Ctrl+Z 可撤销）":
      "This port carries new content that differs from the library copy — click ⟳ to replace it (Ctrl+Z to undo)",
    "同步：把本条目输入端子连入的内容写进素材库（端子无内容时运行到这一步会自动同步）":
      "Sync: write whatever is wired into this entry's input port into the asset library (empty entries sync automatically when the step runs)",
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
