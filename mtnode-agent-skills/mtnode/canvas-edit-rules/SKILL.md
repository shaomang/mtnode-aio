---
name: mtnode-canvas-edit-rules
title: 画布编辑硬规则
description: MTNode 画布建图 / 连线 / 批量的完整硬规则：kind 速查、task 三端、super 边界端子、tool/function 参数即端子、@引用三条件、save 与 wait_file、批次与文生图、数据库 / 开发节点 / 排版 / scope 细则。Use when creating, wiring, batching or laying out canvas nodes, or when a wire/tool receipt looks wrong. 这些规则不写在 mtnode_canvas_edit 描述里，按需加载本技能。
---

# 画布编辑硬规则

`mtnode_canvas_edit` 的工具描述只留卡口（kind 枚举、端子语义、不可违反的不变量）；**完整硬规则以本技能为唯一真源**。建图 / 连线 / 批量 / 媒体前先加载本技能，再动手。

## 调用形态

在当前画布上创建 / 修改 / 连线 / 删除 / 分组 / 自动排版节点，并用 createMarks / updateMarks / removeMarks 画装饰（text / box / arrow）。先 `mtnode_canvas_get` 读图，再在一次调用里建完整子图。标题必须唯一；alias 只在本调用内有效（connect / update / refs 用它），不是画布 id。返回是**自足的改动回执**：计数 + 每个 created / updated 的 x/y/w/h 与端口占用摘要 + warnings，不必再回读画布；确要复核别的节点或取正文再用 `mtnode_canvas_get`（`ids:[...]` + `detail:"full"`）。

> 读图默认是 `detail:"minimal"` = 纯节点索引：每节点只有 标题 / 描述(note) / 类别(kind)，配置字段、正文与连线 / 绘制 / 分组 / 树一律不给。要看配置用 `detail:"standard"`，看正文用 `ids:[...]` + `detail:"full"`，只查连线用 `sections:["nodes","wires"]`。kinds / imageSizes / defaultImageSize 这三张静态表不再随任何快照返回，需要时 `canvas_get` 传 `sections:["refs"]`。

## create.kind 速查

create.kind 速查：输入 input_text / input_image / input_audio / input_video / input_file（媒体输入由用户自己选文件，数据端子值 = file:/// URL，可直接连给需要媒体参考的端子）· 处理 proc_text / proc_image / agent_task（智能节点）/ db_table · 生成 music_gen / tts_gen / video_gen / remotion / sensenova_gen（本机 SenseNova-U1.5-8B-MoT 图像生成）· 保存 save（旧别名 save_text / save_image）/ save_pdf（文本 → PDF，见下「保存类节点」）· 批次 split / merge · 控制 control / judge / task · 节拍等待 wait_file / timer / delayer / sequencer / gate / splitter / counter / mutex · 容器与广播 super / db_replica / global / execute（执行节点绑 execPath，无数据端子）· 计算 tool / function（参数即端子）。

## 硬规则（误接线主要来源）

- task 自带固定 start / endSuccess / endFail（勿删）：活儿非平凡先建 task 当计划，实现用 parentTaskId 放进去，控制线必须从 start 走到成功或失败终点；judge 只有两个输出：fromIndex 0 = YES、1 = NO。
- super 用 parentSuperId 打包（需 canvas_super）：对外只暴露边界输入/输出端子，连线要从 super 的输入端子进子节点、再由子节点连回它的输出端子；跨 super / 跨层级接通用 superConnect。
- tool / function 节点：参数表就是端子表——输入端子 0 = 控制入、1..N = 按顺序的各入参；输出端子 0..M-1 = 各出参、末位 = 控制出。fromIndex / toIndex 按这份表数（目标的 toIndex 0 = 控制入）；数组端子看参数的 list 说明；传 inputs / outputs = 整体替换该表，删参数会让已连的端子改指别的参数，改完提醒用户复核连线。
- @引用：连线源在 prompt/task 里写 @标题；引用全局广播须同时 (1) 源接进 kind "global"、(2) 消费节点 globalRefs:true、(3) prompt/task 里 @源标题——只有被明文 @ 命中的才注入；@标签名 注入带该标签的全部节点内容。为节点写 prompt/task 而要用别的节点的内容时，一律写 @标题（连线源），不要粘贴正文——粘贴的不随上游重跑更新。素材节点本身不是 @ 候选：写它的内容条目标题（＝端子名）只引那一条，且只有已连线接进本节点的端子条目可引。
- 智能节点（agent_task、开了 agent 的 proc_text）自己会写文件：其后绝不接 save（会把会话噪声落盘），也别当数据输入连给别人——让它写文档，再用 wait_file 以控制线挡住下游（它无输入端子、不输出值，别往它连线），后续节点自己读约定路径。
- save 只接在普通（非智能）proc_text / proc_image / sensenova_gen 之后（sensenova_gen 的图像从输出端口 0 出，可直连 save 落 .png）；music_gen / tts_gen / video_gen 由节点自己的 outputPath 直接写出音 / 视频，不配 save；remotion 例外：无 outputPath，mp4 由下游 save 落盘（.mp4 结尾）。**保存类节点（save / save_pdf）本身有 1 个数据输出端子＝本次保存的那份内容**（与落盘内容一致），可继续往下游接、也能被 @ 引用；详见下面「保存类节点」。
- 图像生成节点（proc_image / sensenova_gen）每次运行只出 1 张图：要多图就一条批量项出一张、或用多个节点、或 attempts N。
- proc_image（图像处理/生成）节点可开透明背景：用户要透明底成品（贴纸 / 图标 / 精灵 / 立绘 / 抠好的主体）时，把该 proc_image 节点的 bgRmOn 置 true 即可——正常写主体提示词，内部先出纯黑基准、再严格复刻纯白并差分出 Alpha（带透明 PNG）；约 2 倍 Token，且只有能把基准图当参考图下发的服务商（OpenAI 兼容 / Stability 生图）才会抠图，其余自动跳过。不需要透明底或换回单张就置 false。
- batchMode "batch" = 每条一次运行、每次只看该条：严禁把整批 N 条又全部塞进每次运行（≈N² 次调用）；只处理其中一项先接 split，要一次看全部才用 "agg"。逐条批量优先普通 proc_text / proc_image（智能节点只用于 agg）。细则见技能 mtnode-canvas-batch-safety。
- 数据库：super + db:true 存事实、用户编译（⚙）产出 db_replica；接到副本的智能节点一切事实走 mtnode_db（纪律见该工具说明与技能 mtnode-db-facts），禁止凭记忆。
- 开发节点（super + dev:true）：note 两段 ≤200 字（【功能】非技术设计 + 【实现】技术梗概）、devPath = 项目根、parentSuperId 逐层嵌套按深度细化、元素间关系用 rel:true 关系线表达、按 DEV 功能色卡上色；建块与细化完整规范见技能 mtnode-dev-architect。
- 排版：**每次改结构的编辑都会自动排版**（create / connect / disconnect / remove / createMarks / group / 改 w·h 都算；用户自己拖拽不算），不必显式传 layout，传 `layout:false` 才跳过。算法口径：列顺序 = 层顺序，再按行折起把每层包围盒收进 16:9~9:16（收不进会在回执 warnings 里提示「仍是长条」）；同层里上游在左或在上；节点互不重叠；你显式给的 x/y 只当起始锚点。用户要编辑或点 ▶ 的节点放上方（较小 y）。完整规范（createMarks box + around 分区、control 直连每个该一键重跑的节点且控制流不走数据线、不要建 "clear"）见技能 mtnode-canvas-layout-ux。
- 局部画布（scope）：整笔调用只改某一颗超级 · 开发节点内部时传 scope=那颗壳（scopeDepth 决定一层还是整棵），界外节点跳过并在 warnings 说明；新节点缺 parentSuperId 时默认落进这颗壳。
- 建完工作流 / 改完数据流后，按技能 mtnode-ai-facts 把关键结论（端口与数据流、命令入口、约定、已知坑）沉淀进本画布的 AI 事实库（`mtnode_facts`）。
- 绝不删除或与正在运行本任务的节点重叠；改完告诉用户可编辑输入并用 control ▶ 重跑。

## 端子怎么读（读图一次读全，别靠试连反推）

`canvas_get`（standard / full 档）对**端子数固定**的节点回 `ports`（每个端子带 dir / index / name / kind / connectedTo）；对**输入端子随连线增量长出来**的节点（proc_text / proc_image / sensenova_gen / agent_task / input_text / input_image / input_file …）另回 `portRule`（note / input / output / now / hint）——proc_image 与 sensenova_gen 同时在 `ports` 名单里，所以它们的 `ports` 上还会挂一份同样的 `rule`。读法：

- **端口 0 = 提示词 / 文本入口 · 端口 1+ = 数据槽**：连一条数据线就多一个槽，**文本与图像引用都收**；参考图（图生图 / 图像编辑）就接端口 1+，**不要接端口 0**。输出 端口 0 = 内容 · 末尾 = 控制输出。
- `ports` / `portRule.now` 只列**当下真实存在**的端子：没连线的节点只有「端口 0」，**据此断定「这个节点没有图像参考端子」是错的**；那条「端子怎么长」的规则就在 `portRule` 里。
- **不要用「先试连一条线、再看回执 warnings」的办法反推接法**：一次读图就读全了，试连既多一轮往返又可能真接错线。
- 控制类 / 固定端口类（control / wait_file / timer / gate / judge / task / video_gen / remotion / tts_gen / super / tool / function / 素材）端子由结构或参数钉死，按 `ports` 读即可。

## 保存类节点（save / save_pdf）

- **save**：按上游输入自判媒体类型的落盘节点（文本 → `.md`，批量 / 聚合 YAML 仍 `.yaml`；图像 / 音频 / 视频落对应文件）。**它现在有 1 个数据输出端子＝本次保存的那份内容**（文本给正文、图像 / 音视频给文件、`savedPath` 为空时回落到上游值），可与落盘内容一致地继续往下游接，也能被 @ 引用；`save → save` 不再自动级联落盘（要再存一份得手动点 ▶）。
- **save_pdf**：保存族里的**文本 → PDF** 节点（与 save 同族配色，右键「处理节点」→ 悬停「文本生成」二级菜单里的「PDF生成」）。**只收文本输入**（图像 / 音视频接不了）；输出＝生成的 PDF 落盘地址（path），可继续接下游或被 @ 引用。
  - **何时生成**：连上不会自动生成，**必须点节点上的 ▶（或由 control 控制节点直接指挥）才生成一份 PDF**；接线与上游更新都不自动落盘——它没有「自动保存」开关。要让用户一键重跑，control 必须**直接连线**到 save_pdf。
  - **路径**：`savePath` 可留空 = 用唯一输入节点的标题当默认文件名（上游「文本节点 2」→ `文本节点 2.pdf`），后缀固定 `.pdf`。
  - **批量 / 聚合**：口径同 save 节点——批量每条一份（`文件名_条目标题.pdf`），聚合全部合成一份（条目标题当小标题）。
  - **版面**在节点 ⚙ 里调：页面尺寸（A4 / A3 / A5 / Letter / Legal）· 横向 · 页边距 · 正文字号 · 是否显示页码 · 文档标题（留空不加）。
  - 另有一个**内置工具**形态「Markdown 转 PDF」（工具库，`markdown-to-pdf`）：有输出端子可回路径与字节数，但**没有版面下拉**（固定 A4 · 标准页边距 · 中号字 · 带页码），要自定义版面就用 save_pdf 节点。

## 生成类节点：proc_image（云端文生图 / 图生图）

- **端子**：输入 端口 0 = 提示词文本 · **端口 1+ = 数据槽（连一条多一个 · 文本 / 图像引用都收）**；输出 端口 0 = 图像（可直连 save 落 .png · 预览 · @ 引用）· 末尾 = 控制输出。空白节点只列端口 0，别误判「没有图像参考端子」（见上一节）。
- **连了参考图就是图生图**：图像输入（或 @ 引用 / 全局广播取到的图）随请求作为参考图下发；蒙版局部重绘（maskOn）与画幅锁定都只认**第 1 张参考图**，蒙版必须连图 + OpenAI 兼容图像服务商。
- **每次运行只出 1 张图**；要透明底成品用 bgRmOn。批量与尺寸口径见技能 mtnode-canvas-batch-safety。

## 生成类节点：sensenova_gen（本机 SenseNova 图像生成）

SenseNova-U1.5-8B-MoT 跑在用户本机的 Python 后端（插件 sensenova-local · 随包 sensenova-pack · 只监听 127.0.0.1:8774），与云端 proc_image 是两套东西：proc_image 走服务商 API、size 自由填；sensenova_gen 不吃云端服务商、不出网，分辨率只能是训练桶。

- **端子（与 proc_image 同一条泛用增量规则）**：输入 端口 0 = 提示词文本 · **端口 1+ = 数据槽（连一条多一个 · 文本 / 图像引用都收，连了图就进「图像编辑」模式，图作为参考图走 it2i_generate 下发本机后端）**；**没有固定控制输入端子**。输出 端口 0 = 图像 · 端口 1 = 控制输出。输出值与 proc_image 完全一致（`{kind:"image", path}`），可直接连给 save（落 .png）/ 图像预览 / @ 引用，不需要任何新写法。
- **必须先装插件**：kind 建出来只是空壳；未安装或后端未就绪时节点红字提示、▶ 硬停。安装走顶栏「插件」→ SenseNova 卡片（命令行口径见技能 sensenova-local-install）；本机没装就不要替用户"先跑一下试试"。
- **分辨率只能是桶**：ratioBucket 取官方 11 个训练桶之一 —— `1:1`(2048×2048) / `16:9`(2720×1536) / `9:16`(1536×2720) / `3:2`(2496×1664) / `2:3`(1664×2496) / `4:3`(2368×1760) / `3:4`(1760×2368) / `1:2`(1440×2880) / `2:1`(2880×1440) / `1:3`(1152×3456) / `3:1`(3456×1152)。**不要传 size、也不要写自由像素值**；桶表真源是后端 /health 的 resolutions（渲染层只留一份兜底常量）。
- **显存是硬约束**：bf16 权重约 32.7GB，单张 24G 卡放不下整模，靠 vramMode 分层卸载：`full`（全驻显存，≥48G）· `fast`（官方 24G 卡档，默认）· `balanced` / `low`（逐级多卸载，更慢更省）。OOM 时后端自动降一档并在结果 warnings 说明，不要硬填 full。最小桶也有约 4M 像素，**降分辨率省不了显存**，要省只能降 vramMode 与 numSteps。
- **其它字段**：numSteps（默认 30）· dtype（默认 bfloat16，别用 float32）· think（先出思考文本再出图，思考文本落 `.think.txt` 旁文件，默认 false）· attempts（抽卡次数，每轮 seed+1 重跑）。
- **不写输出路径**：sensenova_gen 没有 outputPath（和 proc_image 一样）——生成结果自动落应用资产目录，从输出端口 0 以 `{kind:"image", path}` 交出去，下游直连 save / 预览即可；写 outputPath 是无效字段。
- **全局互斥**：图像生成与音乐 / 视频生成共用一把全局锁，24G 卡上三者不能同时跑；并排跑时第二个节点报「已有媒体任务在跑」是设计行为，不是故障。
- **耗时预期**：首次运行要加载权重（分钟级），之后常驻；不要因为没立刻出图就重复点 ▶ 或重跑同一节点。

生成类节点的共同口径（music_gen / tts_gen / video_gen 的 outputPath、抽卡 + seed、全局锁、媒体输入走 file:///）另见技能 mtnode-media-gen-nodes。
