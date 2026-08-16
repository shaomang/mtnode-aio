"use strict";
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.I18n = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  var ZH_EXTRA = {"help.html":"\r\n  <div class=\"help-body\">\r\n\r\n  <h3>① 节点类型</h3>\r\n  <p>在画布<b>空白处右键</b>弹出菜单添加节点，位置自动吸附网格（默认 24px，可在设置中调整）。共有 4 类节点：</p>\r\n  <ul>\r\n    <li><b>输入节点</b>：文本 / 图像。内容就地编辑或拖入文件，实时保存；可自由缩放、点击标题重命名。</li>\r\n    <li><b>处理节点</b>：文本 LLM / 图像生成。连接输入后点击 ▶ 运行，结果在节点右侧展开。</li>\r\n    <li><b>保存节点</b>：将输出保存为 <code>.yaml</code> 文本或图像文件，支持自动保存。</li>\r\n    <li><b>动画节点</b>：将图像按 <code>列×行</code> 切割为帧序列，编码为 GIF 动画。</li>\r\n  </ul>\r\n\r\n  <h3>② 连线与继承</h3>\r\n  <ul>\r\n    <li><b>连线</b>：从输出端子拖到输入端子；输入端子默认 1 个，连上一个后自动新增（垂直居中分布）。</li>\r\n    <li><b>输入继承</b>：输入节点一旦连线，内容变为<b>只读并自动继承输入内容</b>；断开连接即恢复可编辑。</li>\r\n    <li><b>自动递归执行</b>：输入包含未处理的上游节点时，运行会自动执行上游直至就绪，再处理当前节点。</li>\r\n  </ul>\r\n\r\n  <h3>③ 批量处理</h3>\r\n  <ul>\r\n    <li><b>开启</b>：输入节点右上角「批量」按钮。文本节点通过 ＋ 添加条目 / 导入 / 粘贴 YAML（field=标题，内容=内容）；图像节点可多选或拖入多张。</li>\r\n    <li><b>模式切换</b>：处理节点头部「批量 / 聚合」——批量 = 逐条运行、输出批量结果；聚合 = 所有条目合并为一次运行、输出单个结果。</li>\r\n    <li><b>拆分 / 合并</b>：拆分节点从批次中实时抽取单项；合并节点多输入汇成批次，下游自动批量处理。</li>\r\n    <li><b>命名</b>：批量链上保存节点按 <code>{文件名}_{输入节点标题}</code> 自动命名输出。</li>\r\n  </ul>\r\n\r\n  <h3>④ @ 引用</h3>\r\n  <p>在提示词中输入 <code>@</code> 弹出<b>已连接节点</b>下拉菜单（↑↓ 选择、Enter 确认，未连接的节点不允许引用）。运行时所有输入内容放入 <code>【背景信息】</code>（每条以 <code>### 标题</code> 开头），提示词放入 <code>【内容】</code>；<code>@标题</code> 会去掉 @ 并指向对应背景条目。图像节点引用以<b>参考图像</b>方式传入。</p>\r\n\r\n  <h3>⑤ 运行与预览</h3>\r\n  <ul>\r\n    <li><b>运行</b>：点击节点上的 ▶，自动递归执行上游并处理当前节点。</li>\r\n    <li><b>预览</b>：◈ 按钮在运行前查看将要发送的完整请求。</li>\r\n    <li><b>参数</b>：右上角「API」按钮展开服务商 / 模型 / 温度 / 尺寸选择；「多次尝试」可自动重试。</li>\r\n    <li><b>浏览</b>：输出面板头部「浏览」弹窗大窗显示完整输出（文本 / 图像 / 批量全部条目），可一键复制文本。</li>\r\n    <li><b>清空</b>：输出面板头部「清空」移除输出，回到未处理状态。</li>\r\n  </ul>\r\n\r\n  <h3>⑥ 保存与存档</h3>\r\n  <ul>\r\n    <li><b>自动保存</b>：任何编辑数百毫秒内自动写入本地磁盘，启动时自动恢复上次现场。</li>\r\n    <li><b>立即保存 / 存档位置</b>：顶栏「立即保存」手动写盘；「存档位置」直接打开工作流保存文件夹（<code>save/</code>，每个工作流一个 JSON 文件）。</li>\r\n    <li><b>工作流管理</b>：顶栏可新建 / 切换 / 删除工作流（默认工作流 <code>default</code>，删除后自动重建）。</li>\r\n    <li><b>保存节点</b>：文本保存每个输入对应 YAML 一项（键为批量条目 field）；聚合模式全部条目合并为一个文件保存。</li>\r\n  </ul>\r\n\r\n  <h3>⑦ 服务商配置</h3>\r\n  <p>在「设置 · API/配置」中统一管理服务商：默认内置文本与图像两类服务商（可选用 DeepSeek 或 GPT Image 2），也可按「类型」下拉添加兼容接口的自定义服务商。填写后所有模型节点自动读取，API Key 仅保存在本机。</p>\r\n\r\n  <h3>⑧ 其他节点</h3>\r\n  <ul>\r\n    <li><b>对话节点</b>：微信风格聊天气泡（AI 白左 · 用户绿右），支持系统提示词，对话记录随工作流保存，输出端子输出整个对话记录。</li>\r\n    <li><b>文件参考</b>：文本节点右上角 📄 小按钮可导入 txt / md / json / yaml / csv / log 等文件内容（超过 500KB 拒绝导入），不占用节点空间。</li>\r\n    <li><b>控制节点</b>：头部小按钮切换「清空 / 执行」，把控制节点连到目标（或把目标连入控制节点），点击 ▶ 对所有已连接节点同时执行该操作。控制连线为金色，不作为数据输入。</li>\r\n  </ul>\r\n\r\n  <h3>⑨ 快捷键</h3>\r\n  <p><code>Ctrl+Z</code> 撤销 · <code>Ctrl+Y</code> / <code>Ctrl+Shift+Z</code> 重做 · <code>Ctrl+C</code> 复制选中节点 · <code>Delete</code> 删除选中节点 / 连线 / 组 · <code>G</code> 把选中节点组成组 / 解散选中组 · <code>Esc</code> 取消选择 · 点击节点标题就地重命名 · <code>⤢ 居中</code> 缩放定位全部节点。</p>\r\n\r\n  <h3>⑩ 框选与组</h3>\r\n  <ul>\r\n    <li><b>框选</b>：按住 <code>Ctrl + 左键</code> 拖拽画布空白处（或开启顶栏「▭ 框选」模式后直接左键拖拽），松开后框内节点全部选中，可整体移动 / 删除 / 复制。</li>\r\n    <li><b>组</b>：选中多个节点后按 <code>G</code> 或点「◫ 组」→ 输入标题创建组；组为虚线圆角边框，可整体拖动、边缘/角落把手<b>横竖分别缩放</b>（成员达到最小尺寸后整体停止缩放，内部比例不变）、✕ 或右键删除；再次点击「组」按钮 / 按 <code>G</code> 解散组（节点保留）。</li>\r\n    <li><b>边栏</b>：工具栏左侧「☰」打开节点树状列表，顶部输入框可按标题筛选，点击条目画布自动居中定位到该节点。</li>\r\n    <li><b>输出浏览</b>：处理节点 / 动画节点输出面板头部「浏览」弹窗大窗显示完整输出（文本 / 图像 / 批量全部条目），可一键复制文本。</li>\r\n    <li><b>对话思考</b>：对话节点支持服务商 / 模型选择与请求预览；模型思考时灰色内容流式显示在「输入中」位置，回复完成后在回答前方出现「思考内容」按钮，点击可查看本条思考全文。</li>\r\n  </ul>\r\n\r\n  <h3>⑪ 智能能力（可读文件 / 联网 / 执行命令）</h3>\r\n  <p>接入 DeepSeek Harness 后，模型从「只会生成文字」升级为「会办事」：能<b>读取 / 写入电脑上的文件、联网搜索、执行命令</b>，多步完成后给出结果。运行环境随应用自带（与主程序同版本 Node），引擎随应用启动，<b>无需安装任何东西</b>。启用位置：设置 · API/配置 → <b>「智能能力（DeepSeek Harness / dsh）」</b>；需先配置好带 API Key 的<b>文本服务商</b>（DeepSeek 或其他兼容服务商均可，节点 / 会话上可切换供应商与模型）。</p>\r\n  <ul>\r\n    <li><b>原来只能聊天</b> → 对话节点勾选<b>「智能助手」</b>后，直接说「把 E:\\\\素材 下的 txt 汇总成大纲存成文件」，它会自己去读、去写；工作目录点「浏览」用文件夹窗口选择。</li>\r\n    <li><b>原来只能处理粘贴进来的内容</b> → 文本处理节点点头部 <b>🐋 智能</b>按钮后，提示词成为任务（可写「联网查最新数据再总结」）。</li>\r\n    <li><b>新增「智能任务」节点</b>（右键画布 → 智能节点）：与文本处理节点功能对齐——支持 <b>@ 引用 / 多输入 / 批量 / 聚合 / 模型选择 / 输出浏览</b>，工作目录用文件夹窗口选择；仅移除「多次尝试」（智能任务多步执行，不做并行抽卡）。</li>\r\n    <li><b>让助手搭工作流</b>：在智能任务或智能会话里说「实现 xxx 的工作流」，模型会在当前画布上<b>创建节点、改标题、连线、写入 @引用</b>，并自动从左到右排版（不重叠）。例如「实现物品配置的工作流」会搭出「需求 → 生成配置 → 保存到配置表」管道，你可继续改提示词与保存路径后点 ▶ 运行。</li>\r\n  </ul>\r\n  <p><b>过程可见</b>：运行中显示「◉ 思考中」，点击可实时查看模型思考与<b>工具调用（🔧）</b>；对话节点的智能回复逐字流式显示。<b>降级保底</b>：关闭各节点智能开关（或设置中关闭总开关），全部回到原有行为。<b>注意</b>：智能模式按「任务完成」计费，一次任务可能多次调用模型；写文件前请确认工作目录正确。</p>\r\n  <p>设置 · 智能能力区块还提供：<b>Agent 预设</b>（通用助手 / 精简执行 / 代码专家 / Cordis 插件开发助手）、<b>对话发送行为</b>（Enter 发送或 Enter 换行）、<b>插件</b>（dsh 风格可搜索卡片清单，安装 / 启停 / 移除）、<b>技能 Skills</b>（创建即用，智能节点自动发现）、<b>MCP 服务器</b>（连接后智能节点自动获得其工具）。</p>\r\n\r\n  </div>"};
  var EN = {"切换为英文":"Switch to English","切换为中文":"Switch to Chinese","？":"?","步":"step","低":"Low","高":"High","你":"You","图":"Img","无":"Off","中":"Medium","组":"Group"," 步":" step"," 次":" times"," 条":" items"," 图":" Img"," 项":" items"," 字":" chars","安装":"Install","保存":"Save","标准":"Standard","参数":"Params","插件":"Plugins","拆分":"Split","创建":"Create","存图":"Save img","存文":"Save txt","当前":"Current","导入":"Import","动画":"Anim","对话":"Chat","返回":"Back","分支":"Fork","复制":"Copy","工具":"Tools","关闭":"Close","归档":"Archive","合并":"Merge","恢复":"Restore","回答":"Reply","会话":"Session","技能":"Skills","节点":"Node","结果":"Result","就绪":"Ready","拒绝":"Deny","聚合":"Aggregate","类型":"Type","浏览":"Browse","轮第":" Step ","名称":"Name","模型":"Model","内容":"Content","内置":"Built-in","批量":"Batch","启用":"Enable","清除":"Clear","清空":"Clear all","取消":"Cancel","确定":"OK","删除":"Delete","试听":"Preview","输入":"Input","添加":"Add","条目":"Entry","停用":"Disable","图像":"Image","位置":"Location","文本":"Text","卸载":"Uninstall","移除":"Remove","音频":"Audio","执行":"Run","只读":"Read-only","智能":"Agent","逐条":"Per item","助手":"Assistant","最强":"Max","作者":"Author"," 副本":" copy"," 连线":" wires"," 条线":" wires"," 项）":" items)"," 字符":" chars","版本 ":"Version ","不使用":"Don't use","尝试 ":"Attempt ","创建 ":"Created ","创建组":"Create group","错误:":"Error:","服务商":"Provider","供应商":"Provider","来源:":"Source:","来源：":"Source: ","连接 ":"Connected ","另存为":"Save as","筛选…":"Filter…","删除 ":"Deleted ","输入 ":"Input ","替换…":"Replace…","条目 ":"Entry ","网格 ":"Grid ","未挂载":"Not mounted","未选择":"None selected","文生图":"Text-to-image","新会话":"New session","已安装":"Installed","已撤销":"Undone","已复制":"Copied","已挂载":"Mounted","已排版":"Laid out","已启用":"Enabled","已取消":"Cancelled","已停用":"Disabled","已重做":"Redone","用户：":"User: ","助手：":"Assistant: ","子代理":"Sub-agent","组 1":"Group 1","组标题":"Group title","组操作":"Group actions","\n模型：":"\nModel: "," · 第":" · Turn "," 次成功":" succeeded"," 个节点":" nodes"," 个文件":" files"," 节点）":" nodes)"," 切割）":" grid)"," 条连线":" wires"," 项成功":" succeeded"," 张图像":" images"," 字符）":" chars)","… 共 ":"… total ","（错误：":"(Error: ","（待定）":"(Pending)","（默认）":"(Default)","(失败)":"(failed)","」的节点":"\"","【用户】":"[User]","【助手】":"[Assistant]","■ 终止":"■ Stop","◉ 思考":"◉ Thinking","✕ 删除":"✕ Delete","保存节点":"Save Node","保存设置":"Save settings","保存失败":"Save failed","保存图像":"Save image","保存文本":"Save text","保存中…":"Saving…","查看说明":"View help","处理节点":"Process Node","代码专家":"Code expert","待保存…":"Unsaved…","导出画布":"Export canvas","导出会话":"Export session","导入画布":"Import canvas","调用失败":"Call failed","动画节点":"Anim Node","对话节点":"Chat Node","服务商 ":"Providers ","服务商：":"Provider: ","复制请求":"Copy request","复制失败":"Copy failed","复制文本":"Copy text","复制摘要":"Copy summary","工具调用":"Tool calls","工具节点":"Tool Node","工作流 ":"Workflows ","工作流：":"Workflow: ","工作目录":"Working directory","后台任务":"Background task","画布名称":"Canvas name","缓存命中":"Cache hit","精简执行":"Concise","历史会话":"Session history","连线操作":"Wire actions","另存为…":"Save as…","没有改动":"No changes","模型服务":"Model services","模型列表":"Model list","默认目录":"Default directory","切割列数":"Grid columns","切割行数":"Grid rows","请求超时":"Request timed out","全部文件":"All files","确认删除":"Confirm delete","确认使用":"Use this","色键颜色":"Chroma-key color","上下文 ":"Context ","尚未保存":"Not saved yet","生成速度":"Generation speed","手动配置":"Manual setup","输出图像":"Output image","输入节点":"Input Node","输入图像":"Input image","通用助手":"General assistant","图像操作":"Image actions","图像生成":"Image generation","未知错误":"Unknown error","文本处理":"Text processing","文本文件":"Text files","无匹配项":"No matches","选择图像":"Choose image","选择文件":"Choose file","移除该源":"Remove this source","已安装 ":"Installed ","已保存 ":"Saved ","已保存：":"Saved: ","已处理 ":"Processed ","已导入 ":"Imported ","已启用 ":"Enabled ","已删除 ":"Deleted ","已添加 ":"Added ","已停用 ":"Disabled ","已卸载 ":"Uninstalled ","已移除 ":"Removed ","已载入 ":"Loaded ","允许一次":"Allow once","暂无会话":"No sessions yet","暂无节点":"No nodes yet","暂无条目":"No entries yet","展开分类":"Expand category","折叠分类":"Collapse category","智能节点":"Agent Node","智能任务":"Agent task","主题色：":"Theme: ","子代理 ":"Sub-agent ","自定义源":"Custom source"," · 分支":" · Fork"," 个节点）":" nodes)"," 个模型）":" models)"," 轮 · ":" turns · "," 项 · ":" items · "," 帧 · ":" frames · ","（请选择）":"(Select)","（未命名）":"(Untitled)","（无输出）":"(No output)","（无图像）":"(No image)","（已停用）":"(Disabled)","（已终止）":"(Stopped)","[图像] ":"[Image] ","＋ 添加源":"+ Add source","◉ 处理中":"◉ Processing","◉ 思考中":"◉ Thinking","✓ 批量 ":"✓ Batch ","🐋 智能":"🐋 Agent","安装失败：":"Install failed: ","保存失败：":"Save failed: ","操作失败：":"Operation failed: ","处理失败：":"Process failed: ","创建失败：":"Create failed: ","从文件导入":"Import from file","打开工作流":"Open workflow","打开失败：":"Open failed: ","导出失败:":"Export failed:","导出失败：":"Export failed: ","导出为文件":"Export as file","导入失败：":"Import failed: ","等待结果…":"Waiting for result…","对话失败：":"Chat failed: ","服务商名称":"Provider name","复制失败：":"Copy failed: ","工作流名称":"Workflow name","工作流说明":"Workflow notes","轨迹 · ":"Trace · ","后台任务 ":"Background task ","缓存命中 ":"Cache hit ","回答失败：":"Reply failed: ","剪贴板为空":"Clipboard is empty","节点不存在":"Node not found","没有匹配「":"No nodes matching \"","默认工作流":"Default workflow","请求已中止":"Request aborted","删除该条目":"Delete this entry","删除工作流":"Delete workflow","删除会话「":"Delete session \"","上文已压缩":"Context compacted","上下文窗口":"Context window","审批失败：":"Approval failed: ","输入端子 ":"Input port ","添加服务商":"Add provider","添加失败：":"Add failed: ","添加在线源":"Add online source","未命名节点":"Untitled node","未知命令:":"Unknown command:","文件不存在":"File not found","无匹配插件":"No matching plugins","线上目录 ":"Online catalog ","卸载插件 ":"Uninstall plugin ","卸载失败：":"Uninstall failed: ","新建工作流":"New workflow","选择文件夹":"Choose folder","渲染错误：":"Render error: ","压缩失败：":"Compact failed: ","移除插件 ":"Remove plugin ","移除技能 ":"Remove skill ","移除失败：":"Remove failed: ","已创建组：":"Created group: ","已复制请求":"Request copied","已复制摘要":"Summary copied","已手动停止":"Stopped manually","已新建会话":"New session created","引擎未连接":"Engine not connected","预览失败：":"Preview failed: ","\n工作目录：":"\nWorking directory: ","\n批量模式：":"\nBatch mode: ","\n输入节点：":"\nInput nodes: "," · 尝试 ":" · Attempt "," · 批量 ":" · Batch "," 次工具调用":" tool calls"," 个服务商）":" providers)"," 节点 · ":" nodes · ","（读取中…）":"(Reading…)","（无批次项）":"(No batch items)","【参考图像：":"[Reference image: ","＋ 安装插件":"+ Install plugin","＋ 创建技能":"+ Create skill","＋ 添加条目":"+ Add entry","＋ 添加图像":"+ Add image","＋ 图像节点":"+ Image Node","＋ 文本节点":"+ Text Node","<参考图: ":"<Ref image: ","✓ 已合并 ":"✓ Merged ","✕ 删除连线":"✕ Delete wire","⤓ 保存图像":"⤓ Save image","插件已安装：":"Plugin installed: ","打开存档位置":"Open archive folder","打开使用说明":"Open user guide","非法 URL":"Invalid URL","复制到剪贴板":"Copy to clipboard","复制输出文本":"Copy output text","更改画布名称":"Rename canvas","工具调用轨迹":"Tool-call trace","工作流不存在":"Workflow not found","工作流名称…":"Workflow name…","画布已导出（":"Canvas exported (","画布已导入：":"Canvas imported: ","会话已删除：":"Session deleted: ","结果（出错）":"Result (error)","聚合(单次)":"Aggregate (once)","开始对话吧…":"Start chatting…","请先选中节点":"Select a node first","删除该服务商":"Delete this provider","设置已保存（":"Settings saved (","输入批次共 ":"Input batch: ","输入图像就绪":"Input image ready","思考中 · ":"Thinking · ","天青 Sky":"Sky","图像生成完成":"Image generation complete","拖拽调整尺寸":"Drag to resize","网络请求失败":"Network request failed","未处理异常：":"Unhandled exception: ","未命名工作流":"Untitled workflow","未配置服务商":"No provider configured","无法读取文件":"Cannot read file","下载图像超时":"Image download timed out","选择保存位置":"Choose save location","选择拆出的项":"Choose items to split","选择工作目录":"Choose working directory","选择完成音效":"Choose completion sound","移除在线源「":"Remove online source \"","已归档 · ":"Archived · ","已添加节点：":"Added node: ","已移除技能 ":"Removed skill ","暂无思考内容":"No thinking content","找不到节点：":"Node not found: ","智能任务摘要":"Agent task summary","GIF 图像":"GIF image","LLM 用时":"LLM time","PNG 图像":"PNG image","\n\n【内容】\n":"\n\n[Content]\n","\n工作目录: ":"\nWorking directory: "," 帧动画 · ":" frame anim · ","（无输出内容）":"(No output content)","【背景信息】\n":"[Background]\n","**用户**：":"**User**: ","＋ 添加服务器":"+ Add server","＋ 添加服务商":"+ Add provider","🌐 在线浏览":"🌐 Browse online","不能连接成回路":"Cannot create a loop","当前权限预设:":"Current permission preset:","导入 YAML":"Import YAML","多次尝试 · ":"Multi-attempt · ","多次尝试完成：":"Multi-attempt complete: ","服务商已添加：":"Provider added: ","该节点暂无输出":"This node has no output yet","画布已重命名：":"Canvas renamed: ","会话已重命名:":"Session renamed:","结果（进行中）":"Result (in progress)","框选模式已关闭":"Marquee mode off","轮数 / 步数":"Turns / Steps","玫瑰 Rose":"Rose","批量处理完成：":"Batch processing complete: ","切换到工作流：":"Switched to workflow: ","青柠 Lime":"Lime","请先选择服务商":"Select a provider first","筛选节点标题…":"Filter node titles…","删除当前工作流":"Delete current workflow","输出浏览 · ":"Output · ","思考过程 · ":"Thinking · ","思考内容 · ":"Thoughts · ","思考强度 → ":"Thinking effort → ","未知画布操作：":"Unknown canvas action: ","未知节点类型：":"Unknown node type: ","文本生成完成（":"Text generation complete (","先填写任务描述":"Enter a task description first","响应无图像数据":"Response has no image data","响应无文本内容":"Response has no text","已创建新工作流":"New workflow created","已打开工作流：":"Opened workflow: ","已分支新会话：":"Forked new session: ","已复制到剪贴板":"Copied to clipboard","已复制思考内容":"Thinking content copied","已恢复单次尝试":"Restored single attempt","已切换到尝试 ":"Switched to attempt ","已删除组（含 ":"Deleted group (incl. ","已添加在线源：":"Added online source: ","在浏览器中打开":"Open in browser","粘贴 YAML":"Paste YAML","这两节点已连接":"These two nodes are already connected","正在压缩上文…":"Compacting context…","只读 · 拆分":"Read-only · Split","智能会话失败：":"Agent session failed: ","智能任务完成（":"Agent task complete (","智能运行无输出":"Agent run produced no output","智能助手失败：":"Agent assistant failed: ","JPEG 图像":"JPEG image","KB），未导入":"KB), not imported","MCP 服务器":"MCP servers","WebP 图像":"WebP image","\n\n任务内容：\n":"\n\nTask:\n"," · 工具调用 ":" · Tool calls ","（读取目录中…）":"(Reading catalog…)","（图像尚未生成）":"(Image not generated yet)","（未选择服务商）":"(No provider selected)","【对话记录】\n\n":"[Chat log]\n\n","尝试次数未变化（":"Attempt count unchanged (","打开工作流（共 ":"Open workflow (","当前选择的模型「":"The selected model \"","点击就地编辑标题":"Click to edit title in place","非法工作流 id":"Invalid workflow id","该节点不接受输入":"This node does not accept input","更改当前画布名称":"Rename current canvas","琥珀 Amber":"Amber","画布居中定位到：":"Canvas centered on: ","技能列表不可用（":"Skill list unavailable (","将选中的 <b>":"Group the selected <b>","没有可撤销的操作":"Nothing to undo","没有可重做的操作":"Nothing to redo","模型（逗号分隔）":"Models (comma-separated)","批量模式已开启（":"Batch mode on (","请填写服务商名称":"Enter a provider name","如「团队插件源」":"e.g. \"Team plugin source\"","输出 token":"Output token","输入 token":"Input token","思考强度：当前「":"Thinking effort: currently \"","通用助手（默认）":"General assistant (Default)","推理 token":"Reasoning token","拖拽调整上下高度":"Drag to adjust height","未知服务商类型：":"Unknown provider type: ","无法读取输入图像":"Cannot read input image","选择图像保存位置":"Choose image save location","已保存图像 → ":"Saved image → ","已从剪贴板写入 ":"Wrote from clipboard ","已导入文件内容（":"Imported file content (","已连接图像输入：":"Connected image input: ","已切断输出端子 ":"Disconnected output port ","已切断输入端子 ":"Disconnected input port ","在此输入文本内容":"Enter text here","帧动画生成失败：":"Frame animation failed: ","帧动画生成完成（":"Frame animation complete (","智能能力启动失败":"Agent engine failed to start","智能任务执行中…":"Agent task running…","AI · 运行中":"AI · Running","GIF 编码失败":"GIF encode failed","pi-ai 目录":"pi-ai catalog","\n\n用户(最新)：":"\n\nUser (latest): "," 个图像文件 → ":" image files → "," 条）· 点击关闭":" items) · Click to close"," 张图像到批量节点":" images to batch node","？引擎将自动重启。":"? The engine will restart automatically.","（等待批次输入…）":"(Waiting for batch input…)","（等待图像输入…）":"(Waiting for image input…)","（上文已压缩）\n\n":"(Context compacted)\n\n","◉ 正在生成帧动画":"◉ Generating frame animation","点击展开参数与结果":"Click to expand args and result","读取线上目录中…（":"Reading online catalog… (","对话节点发送行为：":"Chat node send behavior: ","该节点没有输出端子":"This node has no output port","该输出端子没有连线":"This output port has no wire","该输入端子没有连线":"This input port has no wire","该输入端子已被占用":"This input port is already taken","解散组（保留节点）":"Ungroup (keep nodes)","没有可断开的连线：":"No wires to disconnect: ","名称（显示为标签）":"Name (shown as label)","输入变化时自动保存":"Auto-save on input change","输入节点（仅输出）":"Input Node (output only)","添加图像（可多选）":"Add images (multi-select)","透明色键（Hex）":"Chroma key (Hex)","图像已载入输入节点":"Image loaded into input node","拖拽调整该条目高度":"Drag to adjust this entry's height","未解析的 @引用：":"Unresolved @refs: ","无法打开存档位置：":"Cannot open archive folder: ","无法读取该文件路径":"Cannot read this file path","线上目录暂不可用（":"Online catalog unavailable (","已设置多次尝试 ×":"Multi-attempt set to ×","樱花 Sakura":"Sakura","粘贴 Base64":"Paste Base64","只读 · 逐项审批":"Read-only · Approve each","重复 alias：":"Duplicate alias: ","最近一次智能运行：":"Last agent run: ","MTNode 画布":"MTNode Canvas","\n\n详细信息已写入：":"\n\nDetails written to: "," · API 类型 ":" · API type "," 项 → 输出为批次":" items → output as batch"," tok · 输出 ":" tok · output ","（应用默认数据目录）":"(App default data directory)","🔐 权限审批 · ":"🔐 Permission approval · ","标题（输出文件后缀）":"Title (output filename suffix)","不支持的画布包版本：":"Unsupported canvas pack version: ","撤销（Ctrl+Z）":"Undo (Ctrl+Z)","当前没有打开的工作流":"No workflow is open","当前没有已加载的画布":"No canvas is loaded","翡翠 Emerald":"Emerald","复制输出中的全部文本":"Copy all text in output","复制为 Base64":"Copy as Base64","将删除工作流 <b>":"This will delete workflow <b>","没有可保存的文本输入":"No text input to save","请填写名称与 URL":"Enter a name and URL","深红 Crimson":"Crimson","首 token 平均":"Avg first token","图像输入需要视觉模型":"Image input requires a vision model","文件不存在或无法预览":"File not found or cannot preview","选择图像（输入节点）":"Choose image (input node)","已解散组（节点保留）":"Ungrouped (nodes kept)","已自动执行上游节点：":"Auto-ran upstream nodes: ","暂无 API Key":"No API Key","智能助手已更新画布：":"Agent assistant updated the canvas: ","最近一次运行的输入 ":"Last run input ","MCP 列表不可用（":"MCP list unavailable (","\n\n【已连接图像输入】":"\n\n[Connected image inputs]","（已完成，无文本输出）":"(Done, no text output)","）· 重新打开设置重试":") · Reopen Settings to retry","── 终端输出 ──\n":"── Terminal output ──\n","▶ 图像生成（文生图）":"▶ Image generation (text-to-image)","▶ 文本处理（LLM）":"▶ Text processing (LLM)","打开工作流保存的文件夹":"Open workflow save folder","发送消息（Enter）":"Send message (Enter)","画布网格间距（px）：":"Canvas grid spacing (px): ","节点列表边栏（树状图）":"Node list sidebar (tree)","请填写 API Key":"Enter an API Key","首 token 平均 ":"Avg first token ","移除 MCP 服务器 ":"Remove MCP server ","已保存 YAML → ":"Saved YAML → ","已关闭:下一轮直接执行":"Off: execute directly next round","引用输入节点（@标题）":"Reference input nodes (@title)","预设（与智能会话一致）":"Preset (same as agent session)","运行中的节点未改标题：":"Running nodes were not renamed: ","紫晶 Amethyst":"Amethyst","最近一次智能运行的统计":"Stats from the last agent run","Base64 解码失败":"Base64 decode failed","Base64 内容为空":"Base64 content is empty","Base64 已生成（":"Base64 generated (","Cordis 插件开发":"Cordis plugin development","DeepSeek 官方":"DeepSeek Official","OUTPUT · 批量":"OUTPUT · Batch","stdio（本地命令）":"stdio (local command)"," 个模型 · 接口地址 ":" models · endpoint ","⤓ 保存文本（YAML）":"⤓ Save text (YAML)","🐋 模型等待你的回应（":"🐋 Model is waiting for your reply (","保存节点（接收最终输出）":"Save Node (receives final output)","不能删除正在运行的节点：":"Cannot delete a running node: ","从服务商目录选择（推荐）":"Pick from provider catalog (recommended)","弹窗大窗显示输出 GIF":"Open output GIF in a large popup","工作目录最外层文件夹: ":"Working directory top folder: ","工作区读写 · 逐项审批":"Workspace read/write · Approve each","画布包已损坏（清单越界）":"Canvas pack is corrupt (manifest out of range)","默认模型（智能能力使用）":"Default model (for agent capability)","批量输入的处理方式切换：":"Switch how batch input is processed: ","其他（自定义回答，选填）":"Other (custom reply, optional)","删除该组（连同内部节点）":"Delete this group (including inner nodes)","删除节点（Delete）":"Delete node (Delete)","图像保存节点需要图像来源":"Image save node needs an image source","文本保存节点需要文本来源":"Text save node needs a text source","下载图像失败 HTTP ":"Image download failed HTTP ","选择 YAML 保存位置":"Choose YAML save location","选择文本文件（文件参考）":"Choose text file (file reference)","月光 Moonlight":"Moonlight","在文件夹中显示已保存文件":"Show saved file in folder","OUTPUT · 运行中":"OUTPUT · Running"," ────\n（文件不存在）":" ────\n(File not found)"," 个 YAML 文件 → ":" YAML files → ","。保存后自动生成模型列表。":". Model list is generated automatically after saving.","（等待上游输出…）内容只读":"(Waiting for upstream output…) content is read-only","（等待上游输出中）内容只读":"(Waiting for upstream output) content is read-only","✕ 删除组（连同内部节点）":"✕ Delete group (including inner nodes)","💬 文本对话（Chat）":"💬 Text chat (Chat)","保存路径（*.yaml）…":"Save path (*.yaml)…","标题不唯一，请改用 id：":"Title is not unique, use id instead: ","拆分出的只读节点，不可修改":"Split-out read-only node, cannot be edited","拆分节点仅接受 1 个输入":"Split node accepts only 1 input","从服务商目录选择或手动配置":"Pick from provider catalog or configure manually","弹出文件夹窗口选择工作目录":"Open a folder dialog to choose the working directory","弹窗大窗显示本节点输出内容":"Show this node's output in a large popup","该节点已继承输入，内容只读":"This node inherited input; content is read-only","回车确认 · Esc 取消":"Enter to confirm · Esc to cancel","接口地址 Base URL":"Endpoint Base URL","目录暂不可用（引擎未连接）":"Catalog unavailable (engine not connected)","取消归档,回到对应目录分组":"Unarchive, return to its folder group","输出端子（输出本节点内容）":"Output port (outputs this node's content)","拖动移动组 · 双击重命名":"Drag to move group · Double-click to rename","文件太小，不是有效的画布包":"File too small; not a valid canvas pack","已保存聚合 YAML → ":"Saved aggregate YAML → ","引用聚合条目（@条目标题）":"Reference aggregate entries (@entry title)","在浏览器中打开主页与下载页":"Open homepage and download page in browser","暂无技能（在上方表单创建）":"No skills yet (create with the form above)","粘贴 Base64 内容…":"Paste Base64 content…","API Key（隐藏显示）":"API Key (hidden)","Cordis 插件开发助手":"Cordis plugin development assistant"," 个，切换即加载并加入标签）":" total; switching loads it and adds a tab)","（空闲，连接后自动新增一个）":"(Idle; a new one is added automatically after connecting)","⧉ 合并（多节点 → 批次）":"⧉ Merge (multiple nodes → batch)","拆分出的只读节点（不可编辑）":"Split-out read-only node (not editable)","复制选中节点（Ctrl+C）":"Copy selected nodes (Ctrl+C)","工作流包含无法序列化的数据：":"Workflow contains data that cannot be serialized: ","精简执行（直奔结果，少解释）":"Concise (go straight to the result, less explanation)","留空 = 应用默认数据目录…":"Leave empty = app default data directory…","停止回复（立即中止模型请求）":"Stop reply (abort the model request immediately)","停止运行（立即中止模型请求）":"Stop run (abort the model request immediately)","图像保存节点需要一个图像输入":"Image save node needs one image input","拖拽移动节点（按住手柄拖动）":"Drag to move node (hold the handle)","无可复制的文本（输出为图像）":"No text to copy (output is an image)","新建会话(沿用当前工作目录)":"New session (keep current working directory)","用法:/rename 新标题":"Usage: /rename new-title","Industrial（默认）":"Industrial (Default)","（空）— 输入中不存在所选项目":"(empty) — selected item does not exist in the input","（请结合任务要求参考这些图像）":"(Please refer to these images in light of the task)","）· 请检查网络或源地址后重试":") · Check the network or source URL and retry","尝试次数（1-10，默认 1）":"Attempts (1-10, default 1)","弹出文件夹窗口选择统一工作目录":"Open a folder dialog to choose a shared working directory","点击展开 / 收起模型思考过程":"Click to expand / collapse model thinking","复制 API Key 到剪贴板":"Copy API Key to clipboard","工具节点（批次拆分 / 合并）":"Tool Node (batch split / merge)","工作流已删除，已重建默认工作流":"Workflow deleted; default workflow recreated","会话列表边栏（按工作目录归类）":"Session list sidebar (grouped by working directory)","技能已创建，智能节点可立即使用":"Skill created; agent nodes can use it immediately","聚合：保存为 {路径}.png":"Aggregate: save as {path}.png","内容符合 YAML，已解析为 ":"Content is valid YAML, parsed as ","尚未保存（指定路径后点击 ▶）":"Not saved yet (set a path, then click ▶)","图像保存节点仅接受 1 个输入":"Image save node accepts only 1 input","一键居中：缩放并定位到全部节点":"Fit all: zoom and center on all nodes","已开启:下一轮先制定计划再执行":"On: plan first, then execute next round","API Key 已复制到剪贴板":"API Key copied to clipboard","\n\n会话记录不可恢复，确定删除？":"\n\nSession history cannot be recovered. Delete?","\n（以下请求将忽略图像输入）\n\n":"\n(The following request will ignore image input)\n\n","。输入 /help 查看可用命令":". Type /help to see available commands","部分输入节点尚无文本输出，已跳过":"Some input nodes have no text output yet and were skipped","处理节点（提示词 + Play）":"Process Node (prompt + Play)","点击选择图像\n或拖拽文件到此节点":"Click to choose an image\nor drag a file onto this node","发送消息（Ctrl+Enter）":"Send message (Ctrl+Enter)","服务商 / 模型（点击展开选择）":"Provider / Model (click to expand)","归档该会话(收起到底部已归档区)":"Archive this session (collapse into the archived section at the bottom)","聚合输出：全部条目合并为一个文件":"Aggregate output: merge all entries into one file","框选模式已开启：左键拖拽框选节点":"Marquee mode on: drag with left button to select nodes","批量模式：逐条运行，输出批量结果":"Batch mode: run item by item, output batch results","清除统一目录,恢复各节点单独设置":"Clear shared directory, restore per-node settings","清空本节点输出（回到未处理状态）":"Clear this node's output (back to unprocessed)","上下文分布 · 最近一次智能运行":"Context breakdown · Last agent run","设置 · APIs/Config":"Settings · APIs/Config","完全放行（不限目录 · 不询问）":"Full access (no directory limit · no prompts)","一次最多连接 80 条线，已截断":"At most 80 wires per operation; truncated","已复制 Base64 到剪贴板（":"Copied Base64 to clipboard (","已扩展为智能会话（内容完全同步）":"Expanded to an agent session (content fully synced)","预览：查看运行时将发送的完整请求":"Preview: inspect the full request that will be sent at runtime","暂无运行统计,先发送一条消息再试":"No run stats yet; send a message first, then try again","AI 工作流编排：画布式节点编排":"AI workflow orchestration: canvas-based node graph","）· 重新打开设置重试</div>":") · Reopen Settings to retry</div>","⧉ 拆分（批次 → 单项只读节点）":"⧉ Split (batch → per-item read-only nodes)","插件（npm search 接口）":"Plugins (npm search API)","工具调用轨迹（点击展开参数与结果）":"Tool-call trace (click to expand args and result)","技能（jsDelivr repo）":"Skills (jsDelivr repo)","请将图像文件拖到「图像输入节点」上":"Drag image files onto an \"Image Input Node\"","筛选插件（按包名 / 行 id）…":"Filter plugins (by package name / row id)…","思考强度（无 / 标准 / 最强）":"Thinking effort (Off / Standard / Max)","未解析到条目（格式：标题: 内容）":"No entries parsed (format: title: content)","文件过大（超过 500KB，实际 ":"File too large (over 500KB, actual ","一次最多创建 40 个节点，已截断":"At most 40 nodes created per operation; truncated","一次最多更新 80 个节点，已截断":"At most 80 nodes updated per operation; truncated","一句话描述（模型据此判断何时使用）":"One-line description (the model uses this to decide when to use it)","运行：基于提示词与输入内容生成图像":"Run: generate an image from the prompt and input","支持视觉（图片输入转为多模态消息）":"Vision (image input becomes multimodal messages)","MTNode AI编排器 发生错误":"MTNode AI Orchestrator encountered an error","⧗ 动画（图像 → GIF 帧动画）":"⧗ Anim (image → GIF frame animation)","保存输出到本地（YAML / 图像）":"Save output locally (YAML / image)","导出失败：工作流包含无法序列化的数据":"Export failed: workflow contains data that cannot be serialized","服务商（自动读取全局 API 配置）":"Provider (reads global API config automatically)","横向缩放（仅改变横向布局，纵向不变）":"Scale horizontally (layout width only; height unchanged)","请先指定保存路径（可用「浏览」选择）":"Set a save path first (use \"Browse\" to choose)","已安装插件（点击展开查看 / 管理）":"Installed plugins (click to expand / manage)","已请求中断(引擎正在重启该工作目录)":"Interrupt requested (engine is restarting this working directory)","直接删除该会话(提示确认,不可撤销)":"Delete this session (asks for confirmation; cannot be undone)","终止当前任务(重启该工作目录的引擎)":"Stop current task (restart the engine for this working directory)","纵向缩放（仅改变纵向布局，横向不变）":"Scale vertically (layout height only; width unchanged)","MCP 服务器已添加，引擎重启后生效":"MCP server added; takes effect after engine restart"," 条批量 · 点击关闭，仅显示原始内容":" batch items · Click to close, show raw content only","不是有效的 .mtnodes 画布文件":"Not a valid .mtnodes canvas file","当前聚合 → 点击改为批量（逐条运行）":"Currently Aggregate → click to switch to Batch (run item by item)","工作目录（可留空 = 应用数据目录）…":"Working directory (leave empty = app data directory)…","请求预览 · 运行时将发送以下完整请求":"Request preview · the following full request will be sent at runtime","删除节点将一并删除其关联的智能会话：\n":"Deleting the node will also delete its linked agent session:\n","统一目录(留空 = 各节点单独设置)…":"Shared directory (leave empty = per-node settings)…","未配置服务商（设置 · API/配置）":"No provider configured (Settings · API/Config)","温度 Temperature（0-2）":"Temperature (0-2)","系统提示词 System Prompt":"System Prompt","需要图像输入（图像节点或图像生成节点）":"Requires image input (Image Node or image generation node)","已请求中断,正在重启该工作目录的引擎…":"Interrupt requested; restarting the engine for this working directory…","已请求终止,正在重启该工作目录的引擎…":"Stop requested; restarting the engine for this working directory…","运行：基于提示词与输入内容调用文本模型":"Run: call a text model with the prompt and input","暂无 MCP 服务器（在上方表单添加）":"No MCP servers yet (add with the form above)","组已选中：再次点击解散该组（节点保留）":"Group selected: click again to ungroup (nodes kept)","○ 未处理 · 点击 ▶ 描述任务并运行":"○ Idle · Click ▶ to describe the task and run","保存路径（*.png / *.jpg）…":"Save path (*.png / *.jpg)…","点击选择图像，或直接拖拽图像文件到节点上":"Click to choose an image, or drag image files onto the node","工作流已设置统一工作目录,本节点只读继承":"Workflow has a shared working directory; this node inherits it read-only","关闭标签（仅从标签条移除，不删除工作流）":"Close tab (remove from the tab bar only; does not delete the workflow)","扩展为智能会话(节点与会话内容完全同步)":"Expand to agent session (node and session content stay fully synced)","未配置接口地址（设置 · API/配置）":"No endpoint configured (Settings · API/Config)","无人值守（工作区读写 · 不询问，默认）":"Unattended (workspace read/write · no prompts, default)","在线浏览 · 插件 / 技能 / MCP":"Browse online · Plugins / Skills / MCP","暂无插件（在上方输入 npm 包名安装）":"No plugins yet (enter an npm package name above to install)","create 项缺少 alias，已跳过":"create item missing alias, skipped","npm 包名，例如 @scope/pkg":"npm package name, e.g. @scope/pkg","URL 需以 http(s):// 开头":"URL must start with http(s)://","○ 等待输入（每个输入 = 批次中的一项）":"○ Waiting for input (each input = one item in the batch)","标题（YAML 字段名 / 输出文件后缀）":"Title (YAML field name / output filename suffix)","代码专家（写代码 / 改文件 / 跑命令）":"Code expert (write code / edit files / run commands)","点击查看模型思考与工具调用过程（流式显示）":"Click to view model thinking and tool calls (streamed)","服务器名（1-32 位字母/数字/_/-）":"Server name (1-32 letters/digits/_/-)","尚无智能运行统计（运行智能任务后在此显示）":"No agent run stats yet (shown here after an agent task runs)","输入 API Key（隐藏显示，仅存本机）":"Enter API Key (hidden; stored on this machine only)","选择服务商后自动载入其模型列表与接口地址。":"Selecting a provider loads its model list and endpoint automatically.","智能节点（读文件 / 联网 / 执行命令）":"Agent Node (read files / network / run commands)","」· 点击切换（无 / 低 / 中 / 高）":"\" · Click to cycle (Off / Low / Medium / High)","本次智能运行的统计（与 dsh 客户端一致）":"Stats for this agent run (same as the dsh client)","复制该会话为新会话(参考 dsh fork)":"Duplicate this session as a new one (like dsh fork)","技能内容（Markdown，模型按此执行）…":"Skill content (Markdown; the model follows this)…","聚合：全部条目合并保存为 {路径}.yaml":"Aggregate: merge all entries and save as {path}.yaml","框选模式已开启：左键拖拽即可框选（再点关闭）":"Marquee mode on: drag with left button to select (click again to turn off)","请先框选 / 选中节点（所选节点不能在组内）":"Marquee / select nodes first (selected nodes must not be inside a group)","上下文用量(最近一次运行的输入 token)":"Context usage (input tokens of the last run)","图像 · Midjourney（自定义接口）":"Image · Midjourney (custom API)","暂无条目 · 添加图像或拖拽多张图像到节点上":"No entries yet · Add images or drag multiple images onto the node","智能助手（可读文件 / 联网 / 执行命令）":"Agent assistant (can read files / network / run commands)","子目录（可选，技能/MCP 的列表所在目录）":"Subdirectory (optional; folder that lists skills/MCP)","Agent 预设（智能能力的角色与行为风格）":"Agent preset (role and behavior style for agent capability)","MCP 服务器（jsDelivr repo）":"MCP servers (jsDelivr repo)","【要求】先制定并展示分步计划,再开始执行。\n\n":"[Requirement] First make and show a step-by-step plan, then start executing.\n\n","○ 未处理 · 点击 ▶ 基于提示词+输入处理":"○ Idle · Click ▶ to process from prompt + input","⚠ 本画布包含图像等多媒体资产或体积较大（约 ":"⚠ This canvas contains media assets such as images, or is large (about ","从文件导入条目（field=标题，内容=内容）":"Import entries from file (field=title, content=content)","导入 YAML（field=标题，内容=内容）":"Import YAML (field=title, content=content)","暂无条目 · 点击下方按钮添加或导入 YAML":"No entries yet · Click the button below to add or import YAML","MCP 服务器（stdio，经 npx 运行）":"MCP servers (stdio, run via npx)","streamable-http（远程 URL）":"streamable-http (remote URL)","🐋 智能任务（读文件 / 联网 / 执行命令）":"🐋 Agent task (read files / network / run commands)","合并节点：每个输入 = 批次中的一项，输出为批次":"Merge node: each input = one item in the batch; output is a batch","技能（安装时从 CDN 拉取 SKILL.md）":"Skills (fetches SKILL.md from CDN on install)","批量：保存为 {路径}_{输入节点标题}.png":"Batch: save as {path}_{input node title}.png","批量输出：按 {文件名}_{输入节点标题} 命名":"Batch output: named {filename}_{input node title}","粘贴 .mtnodes 的 Base64 内容：":"Paste Base64 content of a .mtnodes file: ","Enter 换行 · Ctrl+Enter 发送":"Enter newline · Ctrl+Enter send","」不支持识图。以下已保存的视觉模型可选，是否改用？":"\" does not support vision. Switch to one of the saved vision models below?","插件（扩展 agent 能力；安装后自动重启引擎）":"Plugins (extend agent capability; engine restarts automatically after install)","导入画布：从 .mtnodes 文件恢复完整工作流":"Import canvas: restore a full workflow from a .mtnodes file","该源不是 jsDelivr repo，无法安装技能":"This source is not a jsDelivr repo; cannot install skills","命令（如 npx.cmd 或 node 完整路径）":"Command (e.g. npx.cmd or a full node path)","批量：保存为 {路径}_{输入节点标题}.yaml":"Batch: save as {path}_{input node title}.yaml","任务描述（@ 引用输入节点 · 输入内容自动附加）":"Task description (@ to reference input nodes · input is attached automatically)","如 skills 或 src；留空 = 仓库根目录":"e.g. skills or src; leave empty = repo root","重做（Ctrl+Y / Ctrl+Shift+Z）":"Redo (Ctrl+Y / Ctrl+Shift+Z)","助手可读写此目录下的文件；留空使用应用默认数据目录":"The assistant can read/write files in this directory; leave empty to use the app default data directory","Enter 发送 · Shift+Enter 换行":"Enter send · Shift+Enter newline","技能 Skills（安装后智能节点可自动发现并使用）":"Skills (agent nodes can discover and use them after install)","聚合模式：所有条目作为独立输入一次运行，输出单个结果":"Aggregate mode: all entries are independent inputs in one run, outputting a single result","尚未保存（指定路径后点击 ▶，预览显示所保存的图像）":"Not saved yet (set a path, then click ▶; preview shows the saved image)","输入任务后点击 ▶ 发送；历史对话将保留在此（只读）":"Enter a task and click ▶ to send; chat history stays here (read-only)","：点击切换查看该次结果，后续节点引用当前选中的尝试内容":": click to view that result; downstream nodes use the currently selected attempt","当前聚合（合并为一个文件）→ 点击改为批量（逐项保存）":"Currently Aggregate (merge into one file) → click to switch to Batch (save per item)","当前批量（逐项保存）→ 点击改为聚合（合并为一个文件）":"Currently Batch (save per item) → click to switch to Aggregate (merge into one file)","拖拽左侧边缘调整输出面板宽度（← 拉宽 · → 收窄）":"Drag the left edge to resize the output panel (← wider · → narrower)","以下为模型生成该条回复前的思考内容（随对话记录保存）。":"Thinking content generated before this reply (saved with the chat log).","整体缩放（横竖可分别拉伸；成员达到最小尺寸后停止缩放）":"Scale overall (stretch axes independently; stops when a member hits minimum size)","执行(Enter 发送,Shift+Enter 换行)":"Run (Enter send, Shift+Enter newline)","智能能力可读写此目录下的文件；留空使用应用默认数据目录":"Agent capability can read/write files in this directory; leave empty to use the app default data directory","MCP 服务器（连接后智能节点自动获得该服务器的工具）":"MCP servers (agent nodes get this server's tools after connecting)","<a href=\"#\" title=\"已阻止不安全链接\"":"<a href=\"#\" title=\"Blocked unsafe link\"","点击切换查看对应尝试结果，下游节点引用当前选中的尝试内容":"Click to view that attempt's result; downstream nodes use the currently selected attempt","该服务商未填写 API Key（设置 · API/配置）":"This provider has no API Key (Settings · API/Config)","例如：将输入内容总结为三句话… 输入 @ 引用已连接节点":"e.g. Summarize the input in three sentences… type @ to reference connected nodes","运行智能任务：模型可读文件 / 联网 / 执行命令后完成":"Run agent task: the model can read files / network / run commands, then finish","智能能力（DeepSeek Harness / dsh）":"Agent capability (DeepSeek Harness / dsh)","当前批量 → 点击改为聚合（所有条目作为独立输入一次运行）":"Currently Batch → click to switch to Aggregate (all entries as independent inputs in one run)","技能名（kebab-case，如 pdf-summary）":"Skill name (kebab-case, e.g. pdf-summary)","例如：赛博朋克城市夜景… 输入 @ 引用已连接节点/参考图":"e.g. Cyberpunk city at night… type @ to reference connected nodes/reference images","描述任务…（Enter 换行，Ctrl+Enter 发送）":"Describe the task… (Enter newline, Ctrl+Enter send)","任务完成音效（仅当智能任务运行超过 5 分钟后完成时触发）":"Task completion sound (only when an agent task finishes after running more than 5 minutes)","输入消息…（Enter 换行，Ctrl+Enter 发送）":"Enter a message… (Enter newline, Ctrl+Enter send)","以下为模型运行时的思考内容（仅保留在内存中，不写入存档）。":"Thinking content during the model run (kept in memory only; not written to the archive).","由拆分节点生成的只读节点：标题为原批次项名，内容为该项内容":"Read-only node created by a Split node: title is the original batch item name, content is that item","智能会话：全屏 agent 会话画布（等于常驻的智能任务）":"Agent session: full-screen agent session canvas (a persistent agent task)","npm 镜像 registry.npmmirror.com":"npm mirror registry.npmmirror.com","开启批量模式：以多个「标题+内容」条目运行，下游自动批量处理":"Enable batch mode: run with multiple \"title+content\" entries; downstream processes as a batch automatically","描述任务…（Enter 发送，Shift+Enter 换行）":"Describe the task… (Enter send, Shift+Enter newline)","输入消息…（Enter 发送，Shift+Enter 换行）":"Enter a message… (Enter send, Shift+Enter newline)","图像 · Stability AI（v2beta core）":"Image · Stability AI (v2beta core)","YAML 解析已关闭：仅显示原始内容 · 点击恢复为批量条目":"YAML parsing is off: showing raw content only · Click to restore as batch entries","模型列表，逗号分隔，如 gpt-4o-mini, gpt-4o":"Model list, comma-separated, e.g. gpt-4o-mini, gpt-4o","提示词 Prompt（@ 引用输入节点 · 输入内容自动附加）":"Prompt (@ to reference input nodes · input is attached automatically)","未配置 API Key（请在「设置 · API/配置」中填写）":"No API Key configured (fill it in \"Settings · API/Config\")","在线浏览:线上目录(插件 / 技能 / MCP),可安装与卸载":"Browse online: online catalog (Plugins / Skills / MCP), install and uninstall","组：把选中的节点组成一个组（快捷键 G）；选中组后再次点击解散":"Group: group selected nodes (shortcut G); click again when a group is selected to ungroup","从剪贴板读取 YAML（field=标题，内容=内容）并写入条目":"Read YAML from clipboard (field=title, content=content) and write as entries","文本 · OpenAI 兼容（chat/completions）":"Text · OpenAI-compatible (chat/completions)","Node 运行环境随应用自带（与主程序同一版本），无需单独安装。":"The Node runtime is bundled with the app (same version as the main program); no separate install needed.","</b> 及其全部本地数据文件（含节点图像资产）。此操作不可恢复。":"</b> and all of its local data files (including node image assets). This cannot be undone.","模型正在思考，内容流式显示中…（模型支持思考时自动出现此弹窗入口）":"The model is thinking; content is streaming… (this popup entry appears automatically when the model supports thinking)","输入下一条指令…（Enter 发送，Shift+Enter 换行）":"Enter the next instruction… (Enter send, Shift+Enter newline)","文件参考：导入文本文件内容到本节点（超过 500KB 会提示拒绝）":"File reference: import a text file into this node (files over 500KB are rejected)","），Base64 会明显膨胀，建议改用「导出为文件」以保证完整可靠。":"), Base64 will expand significantly; use \"Export as file\" instead for a complete, reliable copy.","运行：把输入图像按网格（行×列）切割成 GIF 帧动画，支持透明色键":"Run: slice the input image on a grid (rows×cols) into a GIF frame animation; chroma key supported","主页 · 下载 http://mt-agent.com/mtnode":"Home · Download http://mt-agent.com/mtnode","框选模式：开启后左键拖拽框选节点（也可随时按住 Ctrl+左键 框选）":"Marquee mode: when on, drag with left button to select nodes (or hold Ctrl+left-click anytime)","选择导入方式：从 .mtnodes 文件，或粘贴 Base64 内容。":"Choose import method: from a .mtnodes file, or paste Base64 content.","自定义音效文件（mp3 / wav / ogg，留空 = 内置提示音）":"Custom sound file (mp3 / wav / ogg; leave empty = built-in chime)","点击 ▶ 将输入图像按网格均匀切割为 GIF 帧动画（依次行、从左到右）":"Click ▶ to slice the input image evenly on a grid into a GIF frame animation (row by row, left to right)","运行智能任务：提示词成为任务，模型可读文件 / 联网 / 执行命令后完成":"Run agent task: the prompt becomes the task; the model can read files / network / run commands, then finish","点击切换查看对应尝试的结果，<b>下游节点引用当前选中的尝试内容</b>。":"Click to view that attempt's result; <b>downstream nodes use the currently selected attempt</b>.","该节点已连接输入：内容只读，自动继承输入内容（符合 YAML 则转为批量）":"This node has connected input: content is read-only and inherited automatically (valid YAML becomes a batch)","输出文件路径（批量模式下自动生成 {文件名}_{输入节点标题} 系列文件）":"Output file path (in batch mode, generates {filename}_{input node title} series files automatically)","MTNode AI编排器 · MTNode AI Orchestrator":"MTNode AI Orchestrator","<div class=\"dsh-plugin-empty\">插件列表不可用（":"<div class=\"dsh-plugin-empty\">Plugin list unavailable (","尺寸 Size（gpt-image-2-vip · auto 或 30 档）":"Size (gpt-image-2-vip · auto or 30 presets)","描述任务…（Enter 换行，Ctrl+Enter 发送；/ 开头输入命令）":"Describe the task… (Enter newline, Ctrl+Enter send; / to start a command)","添加自定义在线源(插件搜索接口 / jsDelivr repo),以标签切换":"Add a custom online source (plugin search API / jsDelivr repo), switch with tabs","描述任务…（Enter 发送，Shift+Enter 换行；/ 开头输入命令）":"Describe the task… (Enter send, Shift+Enter newline; / to start a command)","权限预设（沙箱模式 + 审批策略；“逐项审批”档位会在任务需要越权时弹窗询问）":"Permission preset (sandbox mode + approval policy; \"Approve each\" prompts when a task needs extra permission)","输入变化时自动保存（批量 = 每条目一个文件，YAML 项 = 输入节点标题）":"Auto-save on input change (batch = one file per entry; YAML item = input node title)","未配置带 API Key 的文本服务商（设置 · API/配置 → 模型服务）":"No text provider with an API Key configured (Settings · API/Config → Model services)"," · 右键画布添加节点 · 拖线连接节点 · Ctrl+拖拽框选 · 滚轮缩放画布":" · Right-click the canvas to add a node · Drag wires to connect nodes · Ctrl+drag to marquee-select · Scroll to zoom the canvas","【压缩任务】把以下对话压缩为一段简明摘要,保留任务目标、关键结论与未完成事项:\n\n":"[Compact task] Compress the following conversation into a concise summary, keeping the goal, key conclusions, and unfinished items:\n\n","响应无图像数据（请检查自定义接口返回格式：{image: url|base64}）":"Response has no image data (check the custom API return format: {image: url|base64})","APIs/Config 全局配置：API Key 与接口地址，所有模型节点自动读取":"APIs/Config global settings: API Key and endpoint; all model nodes read them automatically","例如：读取 E:\\素材 下的全部 txt 并汇总成大纲，保存为 summary.md":"e.g. Read all txt files under E:\\assets and summarize into an outline, save as summary.md","图像 · OpenAI 兼容（images/generations / edits）":"Image · OpenAI-compatible (images/generations / edits)","」？\n\n该操作不可撤销，会话记录将全部丢失。关联的智能任务节点会保留（断开会话关联）。":"\"?\n\nThis cannot be undone; all session history will be lost. Linked agent-task nodes are kept (session link is broken).","导出画布：把当前工作流（含图像等资产）打包为 .mtnodes 文件，可迁移到其他电脑":"Export canvas: pack the current workflow (including image assets) into a .mtnodes file, which you can move to another computer","多次尝试：并行运行 N 次（1-10）。N>1 时输出面板出现 1..N 方块 Tab，":"Multi-attempt: run N times in parallel (1-10). When N>1, 1..N square tabs appear on the output panel,","多次尝试：并行运行 N 次（1-10）。N>1 时输出下方出现 1..N 方块 Tab，":"Multi-attempt: run N times in parallel (1-10). When N>1, 1..N square tabs appear below the output,","未添加多模态模型（请在设置中为该文本服务商勾选「支持视觉」，并选择支持识图的多模态模型）":"No multimodal model added (in Settings, enable \"Vision\" for this text provider and choose a multimodal model that supports images)","设置后,本画布创建的所有智能节点都固定使用该工作目录(节点内只读);留空则每个节点单独设置":"Once set, all agent nodes created on this canvas use this working directory (read-only inside the node); leave empty to set each node separately","智能模式：提示词成为任务，模型可读文件 / 联网 / 执行命令后完成（需配置文本服务商，见帮助）":"Agent mode: the prompt becomes the task; the model can read files / network / run commands, then finish (requires a text provider; see Help)","</b> 个节点组成一个组（快捷键 G）。组标题仅用于显示；点击组框可整体移动 / 缩放 / 删除。":"</b> nodes into a group (shortcut G). The group title is display-only; click the group box to move / scale / delete it as a whole.","文件方式适合含图像或体积较大的画布；Base64 适合纯文本小画布，可复制到剪贴板后粘贴到另一台客户端。":"File export is better for canvases with images or large size; Base64 is better for small text-only canvases—copy to the clipboard and paste into another client.","参数（空格分隔，如 -y @modelcontextprotocol/server-filesystem）":"Args (space-separated, e.g. -y @modelcontextprotocol/server-filesystem)","确认后将一直使用该供应商 / 模型处理本节点的图像任务（在节点 API 面板更换供应商或模型后重新询问）。":"After confirming, this provider / model will always be used for this node's image tasks (you will be asked again if you change the provider or model in the node's API panel).","<div class=\"dsh-plugin-empty\">安装中（需要联网，可能需要几分钟）…</div>":"<div class=\"dsh-plugin-empty\">Installing (needs network; may take a few minutes)…</div>","这是<b>智能会话</b>画布:与智能任务节点能力一致,模型可读文件 / 联网 / 执行命令。直接描述你要完成的任务即可。":"This is an <b>agent session</b> canvas: same capabilities as an agent-task node; the model can read files / network / run commands. Just describe the task you want done.","检测到图像输入，但已保存的服务商都没有视觉模型；请在「模型服务」添加支持图像的服务商（如 opencode 等）并选择其视觉模型":"Image input detected, but none of the saved providers have a vision model; in \"Model services\" add a provider that supports images (e.g. opencode) and select its vision model","\n在任务描述中用 @标题 引用图像；运行时会自动使用视觉模型（DeepSeek 官方不支持图像，需支持视觉的服务商，如 opencode 等）":"\nIn the task description, use @title to reference images; a vision model is used automatically at runtime (DeepSeek Official does not support images; you need a vision-capable provider such as opencode)","并行运行 <b>N</b> 次该节点（N 为 1-10 的整数）。N &gt; 1 时：运行后输出面板（Output 下一行）出现 <b>1..N 方块 Tab</b>，":"Run this node <b>N</b> times in parallel (N is an integer from 1-10). When N &gt; 1: after running, the output panel (the row below Output) shows <b>1..N square tabs</b>,","命令:/new 新会话 · /compact 压缩上文 · /plan 规划模式 · /rename 标题 · /export 导出会话 · /permissions 查看权限预设":"Commands: /new new session · /compact compact context · /plan plan mode · /rename title · /export export session · /permissions view permission preset","插件源返回 npm search 格式；技能源每个子目录含 SKILL.md；MCP 源子目录作为服务器(经 npx @modelcontextprotocol/server-<名> 安装)。":"Plugin sources return npm search format; each skill-source subdirectory contains SKILL.md; MCP source subdirectories are servers (installed via npx @modelcontextprotocol/server-<name>).","插件:https://registry.npmmirror.com/-/v1/search?text=xxx\n技能/MCP:https://data.jsdelivr.com/v1/package/gh/用户/仓库@main":"Plugins: https://registry.npmmirror.com/-/v1/search?text=xxx\nSkills/MCP: https://data.jsdelivr.com/v1/package/gh/user/repo@main","。可选:mtnode-unattended(无人值守) / workspace-write(读写·审批) / read-only(只读·审批) / danger-full-access(完全放行)。在 设置 → 智能能力 中切换。":". Optional: mtnode-unattended (unattended) / workspace-write (read/write · approve) / read-only (read-only · approve) / danger-full-access (full access). Switch in Settings → Agent capability.","已将 ":"Added "," 个节点移出组":" node(s) removed from the group","已选中组 + ":"Group selected + "," 个节点加入组「":" node(s) added to group \"","所选节点已在该组中":"Selected nodes are already in this group"," 个节点：点击把节点加入该组":" node(s): click to add them to this group","请先框选 / 选中节点，或选中一个组":"Box-select / select nodes, or select a group first","所选节点在组内：点击将节点移出该组（脱离）":"Selected nodes are in a group: click to detach them","所选节点分属多个组，请先单独选择一个组内的节点":"Selected nodes belong to different groups; select nodes from one group first","文本节点":"Text Node","图像节点":"Image Node","文本处理节点":"Text Processing Node","图像生成节点":"Image Generation Node","保存文本节点":"Save Text Node","保存图像节点":"Save Image Node","拆分节点":"Split Node","合并节点":"Merge Node","智能任务节点":"Agent Task Node","MTNode AI编排器":"MTNode AI Orchestrator","语言":"Language","未加载工作流":"No workflow loaded","— 节点 · — 连线":"— nodes · — wires","服务商 0":"Providers 0","网格 24px":"Grid 24px","设置":"Settings","命令:/new 新会话 · /compact 压缩上文 · /plan 规划 · /rename 改名 · /export 导出 · /permissions 权限预设 · /help":"Commands: /new new session · /compact compact · /plan plan · /rename rename · /export export · /permissions permissions · /help"," · 第{turn}轮第{step}步":" · turn {turn} step {step}","移除在线源「{name}」？":"Remove online source \"{name}\"?","help.html":"  <div class=\"help-body\">\n\n  <h3>1. Node types</h3>\n  <p>Right-click <b>empty canvas</b> to add a node. Positions snap to the grid (default 24px, adjustable in Settings). There are 4 families:</p>\n  <ul>\n    <li><b>Input nodes</b>: text / image. Edit in place or drop files; saved live. Resize freely; click the title to rename.</li>\n    <li><b>Process nodes</b>: text LLM / image generation. Connect inputs, click ▶ to run; results expand on the right.</li>\n    <li><b>Save nodes</b>: write output as <code>.yaml</code> text or image files, with optional auto-save.</li>\n    <li><b>Animation nodes</b>: slice an image by <code>cols × rows</code> into frames and encode a GIF.</li>\n  </ul>\n\n  <h3>2. Wires and inheritance</h3>\n  <ul>\n    <li><b>Wires</b>: drag from an output port to an input port. Nodes start with 1 input; a new port appears after each connection (vertically centered).</li>\n    <li><b>Input inheritance</b>: once an input node is wired, its content becomes <b>read-only and inherits the upstream value</b>; disconnect to edit again.</li>\n    <li><b>Auto recursive run</b>: if inputs include unprocessed upstream nodes, run executes upstream until ready, then the current node.</li>\n  </ul>\n\n  <h3>3. Batch processing</h3>\n  <ul>\n    <li><b>Enable</b>: the “Batch” button on input nodes. Text nodes: ＋ add entries / import / paste YAML (field = title, body = content). Image nodes: multi-select or drop several files.</li>\n    <li><b>Mode</b>: process-node header “Batch / Aggregate” — Batch = one run per item; Aggregate = all items in one run, single output.</li>\n    <li><b>Split / Merge</b>: Split extracts one item from a batch in real time; Merge gathers inputs into a batch so downstream runs in batch.</li>\n    <li><b>Naming</b>: save nodes on a batch chain auto-name files as <code>{filename}_{input node title}</code>.</li>\n  </ul>\n\n  <h3>4. @ references</h3>\n  <p>Type <code>@</code> in a prompt to open a dropdown of <b>connected nodes</b> (↑↓ to select, Enter to confirm; unconnected nodes cannot be referenced). At run time all inputs go into <code>【背景信息】</code> (each block starts with <code>### title</code>) and the prompt goes into <code>【内容】</code>; <code>@title</code> drops the @ and points at that background block. Image-node refs are passed as <b>reference images</b>.</p>\n\n  <h3>5. Run and preview</h3>\n  <ul>\n    <li><b>Run</b>: click ▶ on a node to recursively run upstream and then the node.</li>\n    <li><b>Preview</b>: the ◈ button shows the full request before sending.</li>\n    <li><b>Params</b>: the “API” button picks provider / model / temperature / size; “Attempts” can retry automatically.</li>\n    <li><b>Browse</b>: the output header “Browse” opens a large viewer (text / image / all batch items) with one-click copy.</li>\n    <li><b>Clear</b>: the output header “Clear” removes output and returns to the unprocessed state.</li>\n  </ul>\n\n  <h3>6. Save and archives</h3>\n  <ul>\n    <li><b>Auto-save</b>: edits are written to local disk within a few hundred milliseconds; the last session is restored on startup.</li>\n    <li><b>Save now / archive folder</b>: toolbar “Save now” writes immediately; “Archive folder” opens the workflow save directory (<code>save/</code>, one JSON per workflow).</li>\n    <li><b>Workflows</b>: the toolbar can create / switch / delete workflows (default id <code>default</code>, recreated after delete).</li>\n    <li><b>Save nodes</b>: text save writes one YAML field per input (key = batch field); aggregate mode merges all items into one file.</li>\n  </ul>\n\n  <h3>7. Providers</h3>\n  <p>Manage providers in “Settings · API/Config”. Built-in text and image providers (DeepSeek or GPT Image 2) plus custom compatible APIs via the Type dropdown. Model nodes read this config automatically; API keys stay on this machine only.</p>\n\n  <h3>8. Other nodes</h3>\n  <ul>\n    <li><b>Chat node</b>: WeChat-style bubbles (AI white-left · user green-right), system prompt, history saved with the workflow; the output port emits the full transcript.</li>\n    <li><b>File reference</b>: the 📄 button on a text node imports txt / md / json / yaml / csv / log (rejected over 500KB) without using node space.</li>\n    <li><b>Control node</b>: header buttons switch Clear / Run; wire the control node to targets (or wire targets into it), then ▶ applies that action to all connected nodes at once. Control wires are gold and are not data inputs.</li>\n  </ul>\n\n  <h3>9. Shortcuts</h3>\n  <p><code>Ctrl+Z</code> undo · <code>Ctrl+Y</code> / <code>Ctrl+Shift+Z</code> redo · <code>Ctrl+C</code> duplicate selected nodes · <code>Delete</code> delete selected nodes / wires / groups · <code>G</code> group selected nodes / ungroup · <code>Esc</code> clear selection · click a node title to rename · <code>⤢ Fit</code> zoom to all nodes.</p>\n\n  <h3>10. Box-select and groups</h3>\n  <ul>\n    <li><b>Box-select</b>: hold <code>Ctrl + left click</code> and drag on empty canvas (or enable toolbar “▭ Box” and drag with left click). Nodes inside the box are selected for move / delete / duplicate.</li>\n    <li><b>Group</b>: select nodes, then <code>G</code> or “◫ Group”, enter a title. Dashed rounded frame; drag as a whole; edge/corner handles <b>scale X and Y independently</b> (stops when a member hits min size); ✕ or right-click to delete; click Group / press <code>G</code> again to ungroup (nodes remain).</li>\n    <li><b>Sidebar</b>: toolbar “☰” opens the node tree; filter by title; click an item to center it on the canvas.</li>\n    <li><b>Output browse</b>: process / animation output header “Browse” opens a large viewer with copy.</li>\n    <li><b>Chat thinking</b>: chat nodes support provider / model / preview; thinking streams in gray at the “typing” slot; after the reply, a “Thinking” button shows that turn’s full reasoning.</li>\n  </ul>\n\n  <h3>11. Agent capability (read files / search / run commands)</h3>\n  <p>With DeepSeek Harness the model can <b>read / write files, search the web, and run commands</b>, then return a result. The runtime ships with the app (same Node version); the engine starts with the app — <b>nothing extra to install</b>. Enable it in Settings · API/Config → <b>“Agent (DeepSeek Harness / dsh)”</b>. Configure a <b>text provider</b> with an API key first (DeepSeek or any compatible provider; switch provider/model per node or session).</p>\n  <ul>\n    <li><b>From chat-only</b> → enable <b>“Agent”</b> on a chat node and say “summarize every txt under E:\\\\assets into an outline file”; it will read and write. Pick the workspace with “Browse”.</li>\n    <li><b>From pasted content only</b> → turn on <b>🐋 Agent</b> on a text-process node so the prompt becomes a task (e.g. “search the web for the latest data and summarize”).</li>\n    <li><b>Agent Task node</b> (right-click → Agent node): aligned with text-process — <b>@ refs / multi-input / batch / aggregate / model / browse</b>, folder picker for workspace; no “attempts” (multi-step agent runs, not parallel sampling).</li>\n    <li><b>Let the assistant build a workflow</b>: in an agent task or agent session, say “build a workflow for xxx”. The model <b>creates nodes, renames them, wires them, and writes @refs</b>, laid out left-to-right. Example: an item-config pipeline “requirements → generate config → save to table” that you can edit and ▶ run.</li>\n  </ul>\n  <p><b>Visible process</b>: running shows “◉ Thinking”; click to watch reasoning and <b>tool calls (🔧)</b>; agent chat replies stream live. <b>Fallback</b>: turn off per-node agent switches (or the global switch) to restore original behavior. <b>Note</b>: agent mode is billed per completed task and may call the model several times; confirm the workspace before writing files.</p>\n  <p>The Agent settings block also has: <b>Agent presets</b> (General / Concise / Code expert / Cordis plugin helper), <b>chat send keys</b> (Enter to send or Enter for newline), <b>plugins</b> (searchable cards, install / enable / remove), <b>Skills</b> (create and use immediately), <b>MCP servers</b> (tools become available to agent nodes).</p>\n\n  </div>\n","工作流编排":"Workflow","智能会话":"Agent session","↶ 撤销":"↶ Undo","↷ 重做":"↷ Redo","⧉ 复制节点":"⧉ Duplicate","⤢ 居中":"⤢ Fit","▭ 框选":"▭ Box","◫ 组":"◫ Group","设置 · API/配置":"Settings · API/Config","新建":"New","更改名称":"Rename","导出":"Export","预设":"Preset","思考强度":"Thinking","＋ 新会话":"+ New session","全局助手":"Global assistant","可见全局状态 · 修改需确认":"Sees app state · edits need confirm","显示 / 隐藏 Live2D 占位区":"Show / hide Live2D placeholder","清空助手对话":"Clear assistant chat","关闭右侧助手栏":"Close right assistant panel","预留位 · 可接入角色模型":"Reserved · plug in a character model","可询问当前工作流状态，或让助手修改画布（每次修改会弹窗确认）":"Ask about the workflow, or have the assistant edit the canvas (each edit asks for confirm)","问助手…（Enter 发送，Shift+Enter 换行）":"Ask the assistant… (Enter send, Shift+Enter newline)","发送":"Send","全局 AI 助手（右侧栏）":"Global AI assistant (right panel)","用户拒绝了此次画布修改":"User rejected this canvas edit","更新 ":"Updated ","断开 ":"Disconnected ","重命名工作流 → ":"Rename workflow → ","自动排版":"Auto layout","修改画布":"Edit canvas","涉及：":"Involves: ","确认画布修改":"Confirm canvas edit","全局助手请求修改当前画布：":"Global assistant requests canvas changes: ","拒绝后本次修改不会生效；可让助手改方案后再试。":"If rejected, this edit will not apply; ask the assistant for another plan.","确认修改":"Confirm edit","我能看到当前工作流、节点、连线与配置。\n可以说「总结画布」或「搭一个 xxx 工作流」。\n修改画布前会请你确认。":"I can see the current workflow, nodes, wires, and settings.\nTry \"summarize the canvas\" or \"build a xxx workflow\".\nCanvas edits will ask for your confirmation.","思考中…":"Thinking…","请先终止当前运行":"Stop the current run first","助手失败：":"Assistant failed: ","全局助手失败：":"Global assistant failed: ","可见全局状态 · 危险操作需确认":"Sees app state · risky ops need confirm","可切换/新建画布、居中节点；改节点图或删除工作流会弹窗确认":"Switch/create canvases, focus nodes; graph edits or deleting a workflow ask for confirm","我能看到当前工作流、节点与配置，也能切换/新建画布、居中到节点。\n可以说「居中到某某节点」「新建画布」「切换到某某工作流」或「搭一个 xxx 工作流」。\n改节点图或删除工作流前会请你确认。":"I can see the workflow, nodes, and settings, and can switch/create canvases or focus a node.\nTry \"focus node X\", \"new canvas\", \"switch to workflow Y\", or \"build a xxx workflow\".\nGraph edits or deleting a workflow will ask for confirmation.","工作流名称不唯一，请改用 id：":"Workflow name is not unique, use id: ","找不到工作流：":"Workflow not found: ","缺少 action":"Missing action","未知应用操作：":"Unknown app action: ","确认操作":"Confirm action","确认危险操作":"Confirm risky action","全局助手请求：":"Global assistant requests: ","应用操作：":"App action: ","用户拒绝了此次操作":"User rejected this action","已删除工作流：":"Deleted workflow: ","将删除该工作流及其全部本地数据文件（含节点图像资产）。此操作不可恢复。":"This will delete the workflow and all of its local data files (including node image assets). This cannot be undone.","清空本节点输出与会话（历史 / 工具日志一并重置）":"Clear this node's output and session (history / tool logs reset)","助手会话已清空":"Assistant chat cleared","留空 = 当前画布 / 应用默认目录…":"Leave empty = current canvas / app default directory…","排队等待中…":"Queued…","拖动边框中部调整助手栏宽度":"Drag the mid-border to resize the assistant","仅图像输入节点可设置 imagePath：":"Only image input nodes accept imagePath: ","载入图像失败：":"Failed to load image: ","复制失败":"Copy failed"," 张图像":" images","控制":"Control","控制节点":"Control Node","控制节点（批量清空 / 执行）":"Control Node (batch clear / run)","⏻ 控制（批量清空 / 执行）":"⏻ Control (batch clear / run)","设为清空：点击 ▶ 清空所有已连接节点的输出":"Set to Clear: click ▶ to clear output of all connected nodes","设为执行：点击 ▶ 运行已连接节点（有依赖先上游，并行同时跑）":"Set to Run: click ▶ to run connected nodes (upstream first if depended on; parallel otherwise)","运行：清空所有已连接节点的输出":"Run: clear output of all connected nodes","运行：执行已连接节点（有依赖先上游，并行同时跑）":"Run: execute connected nodes (upstream first if depended on; parallel otherwise)","未连接任何节点":"No nodes connected","已连接 ":"Connected ","所连接节点无法执行":"Connected nodes cannot be run","从本节点连出，或把其他节点连入：点击 ▶ 对全部已连接节点执行所选操作":"Wire out from this node, or wire other nodes in: click ▶ to apply the selected action to all connected nodes","输出端子（连接到要控制的节点）":"Output port (connect to nodes to control)","已清空 ":"Cleared ","已自动切换至视觉模型：":"Auto-switched to vision model: ","运行中的节点未改模型：":"Running nodes were not re-modeled: ","找不到服务商：":"Provider not found: ","服务商名称不唯一，请改用 id：":"Provider name is not unique, use id instead: ","⧉ 复制绘制":"⧉ Duplicate drawing","已复制绘制：":"Duplicated drawing: ","请先选中节点或绘制":"Select a node or drawing first","箭头":"Arrow","框体":"Box","拖动箭头终点":"Drag arrow end","拖动箭头起点":"Drag arrow start","拖动调整大小":"Drag to resize","✕ 删除绘制":"✕ Delete drawing","删除绘制":"Delete drawing","选取颜色":"Pick color","加粗线条":"Thicker stroke","减细线条":"Thinner stroke","放大字号":"Larger text","缩小字号":"Smaller text","切换颜色":"Cycle color","仅用于展示的绘制标注（可改颜色 / 大小）":"Display-only canvas annotation (color / size editable)","已添加绘制：":"Added drawing: ","说明文字":"Note","➔ 箭头":"➔ Arrow","▢ 框体":"▢ Box","Ｔ 文本":"Ｔ Text","绘制":"Draw","设置后,本画布智能节点与保存节点的相对路径都相对该目录;改目录即可统一切换落盘位置;留空则各节点单独设置":"Once set, agent nodes and relative save paths use this directory; change it to redirect all saves; leave empty for per-node settings","有工作目录时可用相对路径（如 output.yaml）；改顶栏工作目录后统一落盘到新目录。也可填绝对路径。":"With a working directory set, use a relative path (e.g. output.yaml); changing the toolbar workspace redirects all saves. Absolute paths are also allowed.","相对工作目录或绝对路径（*.png / *.jpg）…":"Relative to working directory or absolute path (*.png / *.jpg)…","相对工作目录或绝对路径（*.yaml）…":"Relative to working directory or absolute path (*.yaml)…","相对路径需要先设置工作目录（顶栏），或改用绝对路径":"Relative paths need a working directory (toolbar), or use an absolute path"};
  Object.assign(EN, {
    "模板商店": "Template store",
    "模板商店：浏览 / 下载公开模板，登录后可上传与管理自己的模板": "Template store: browse / download public templates; sign in to upload and manage yours",
    "上传": "Upload",
    "我的": "Mine",
    "登录": "Sign in",
    "注册": "Register",
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
    "商店加载中…": "Loading store…",
    "加载失败：": "Failed to load: ",
    "模板商店不可用：": "Template store unavailable: ",
    "下载": "Download",
    "点赞": "Like",
    "已点赞": "Liked",
    "编辑": "Edit",
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
    "将打开为新工作流": "Will open as a new workflow",
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
    "处理中": "Running",
    "等待中": "Waiting",
    "点击定位到节点": "Click to focus node",
    "节点不在当前画布": "Node is not on this canvas",
    "节点预览": "Node preview",
    "点击查看大图": "Click to view full image",
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
    "审批与权限": "Approvals & permissions",
    "审批与权限：权限预设 / 识图许可，可随时调整":
      "Approvals & permissions: preset / vision allow — adjust anytime",
    "权限预设已切换：": "Permission preset: ",
    "权限预设（沙箱 + 工具越权审批；下一轮智能任务起生效）":
      "Permission preset (sandbox + tool approval; applies from next agent run)",
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
    "已开启：全局助手改画布不再弹确认": "On: assistant canvas edits skip confirm",
    "已关闭：全局助手改画布需确认": "Off: assistant canvas edits require confirm",
    "识图已被本会话拒绝；请点右上角「审批」改为允许":
      "Vision denied for this session; click Approvals (top-right) to allow",
    "「始终允许」会记住选择；「允许一次」仅本次会话有效。图片会发给已配置的视觉模型。也可随时点右上角「审批」调整。":
      "Always allow is remembered; Allow once lasts this session. Images go to your configured vision model. Adjust anytime via Approvals (top-right).",
    "模型列表（从上到下为使用优先级）": "Models (top = highest priority)",
    "当前优先使用": "Preferred now",
    "点击上下箭头调整优先级": "Use arrows to change priority",
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
    "背景移除": "Background remove",
    "背景移除已启用 · 点击设置色键与容差":
      "Background remove on · click to set key color & tolerance",
    "背景移除：点击打开设置（色键抠图）":
      "Background remove: open settings (chroma key)",
    "启用（生成时追加色键提示词，并抠除该色）":
      "Enable (append key-color prompt; punch out that color)",
    "色键颜色": "Key color",
    "容差（完全透明，0-128）": "Tolerance (full transparent, 0–128)",
    "软边（半透明过渡，0-128）": "Soft edge (alpha fade, 0–128)",
    "开启后提示词会要求模型用该纯色填充透明区；生成结果与「立即处理」会按容差/软边抠图为 PNG 透明通道。":
      "When on, the prompt asks for a solid key-color background; generation and “Process now” punch it to a PNG alpha channel.",
    "立即处理当前输出": "Process current output",
    "请先启用背景移除": "Enable background remove first",
    "暂无输出图像可处理": "No output images to process",
    "已对 ": "Processed ",
    " 张输出图像执行背景移除": " output image(s)",
    "背景移除失败：": "Background remove failed: ",
    "背景移除写入失败": "Failed to write keyed image",
    "无法读取图像": "Cannot read image",
    "请输入有效 Hex 颜色（如 #FF00FF）": "Enter a valid hex color (e.g. #FF00FF)",
    "\n\n【背景移除 / 色键】请将需要透明的背景区域全部填充为纯色 ":
      "\n\n[Background remove / chroma key] Fill all areas that should be transparent with solid color ",
    "。背景必须均匀、无渐变、无纹理；主体/前景中严禁出现该颜色（可用相近但可区分的其他颜色）。边缘尽量干净，便于后期抠除该色。":
      ". Background must be flat (no gradient/texture). Do not use this color in the subject/foreground (nearby but distinct colors OK). Keep edges clean for keying.",
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
      "One-click layout via the global assistant (undoable)",
    "一键排版：交由全局助手执行紧凑排版（可撤销）":
      "One-click layout via the global assistant (undoable)",
    "确定进行一键排版？\n\n将由全局助手基于 AI 分析并调整画布节点位置，可能需要等待一段时间，请耐心等候。操作可撤销。":
      "Start one-click layout?\n\nThe global assistant will use AI to analyze and adjust node positions. This may take a while — please wait. The action is undoable.",
    "画布上没有节点": "No nodes on the canvas",
    "已整理排版": "Layout tidied",
    "已紧凑排版": "Compact layout applied",
    "排版失败：": "Layout failed: ",
    "请整理当前画布排版：先 mtnode_canvas_get 查看每个节点与绘制的 x/y/w/h，再根据现状自行判断，用一次 mtnode_canvas_edit（layout:false）通过 update / updateMarks 校准位置与尺寸。要求美观整洁、间距舒适、图像节点便于观察、面向用户可编辑/操作的节点靠上；框体/文字/箭头等绘制要跟着节点一起调整。不要增删节点、不要改连线，不要调用任何 layout action。完成后用一句话确认。":
      "Tidy the canvas layout: first mtnode_canvas_get to read each node/mark x/y/w/h, then judge yourself and calibrate with one mtnode_canvas_edit (layout:false) via update / updateMarks. Keep it neat with comfortable spacing, image nodes easy to view, user-editable nodes toward the top; move drawings with their nodes. Do not add/remove nodes, change wires, or call any layout action. Confirm in one short sentence when done.",
    "请整理当前画布排版：立刻调用 mtnode_app，action 为 tidy_layout。要求美观整洁、面向用户可编辑/操作的节点靠上；不要增删节点、不要改连线；完成后用一句话确认。":
      "Tidy the canvas layout via mtnode_canvas_edit (not a layout action).",
    "请对当前画布执行紧凑排版：立刻调用 mtnode_app，action 为 compact_layout。不要增删节点、不要改连线；排版完成后用一句话确认。":
      "Tidy the canvas layout via mtnode_canvas_edit (not a layout action).",
    "全局助手正在运行，请稍候或先终止":
      "Global assistant is running; wait or stop it first",
    "助手执行中": "Assistant running",
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
      if (key) el.title = t(key);
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

  function listJoin(arr) {
    return (arr || []).join(locale === "en" ? ", " : "、");
  }

  return { t: t, setLocale: setLocale, getLocale: getLocale, applyDom: applyDom, listJoin: listJoin };
});
