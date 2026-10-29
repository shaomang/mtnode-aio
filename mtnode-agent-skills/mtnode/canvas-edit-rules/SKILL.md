---
name: mtnode-canvas-edit-rules
title: 画布编辑硬规则
description: MTNode 画布建图 / 连线 / 批量的完整硬规则：kind 速查、task 三端、super 边界端子、tool/function 参数即端子、@引用三条件、save 与 wait_file、批次与文生图、数据库 / 开发节点 / 排版 / scope 细则。Use when creating, wiring, batching or laying out canvas nodes, or when a wire/tool receipt looks wrong. 这些规则不写在 mtnode_canvas_edit 描述里，按需加载本技能。
---

# 画布编辑硬规则

`mtnode_canvas_edit` 的工具描述只留卡口（kind 枚举、端子语义、不可违反的不变量）；**完整硬规则以本技能为唯一真源**。建图 / 连线 / 批量 / 媒体前先加载本技能，再动手。

## 调用形态

调用签名、端子语义与回执格式以 `mtnode_canvas_edit` 的工具描述为准（一次调用建完一棵子图，回执自足不必回读）。本节只写它没写的硬规则。

- alias 只在本调用内有效（connect / update / refs 用它），不是画布 id；标题必须唯一（新建 / 改名时）。用户在界面上**复制 / 粘贴**出来的节点会原样沿用源节点标题，画布上因此可能有两个同名节点 —— 这时按标题的引用会命中源那一颗，要精确指向某一颗就用 id。
- 读图默认 `detail:"minimal"`（只有 标题 / 描述 / 类别）：看配置用 `standard`，看正文用 `ids:[...]` + `full`，只查连线用 `sections:["nodes","wires"]`；kinds / imageSizes / defaultImageSize 走 `sections:["refs"]`。

## create.kind 速查

create.kind 速查：输入 input_text / input_image / input_audio / input_video / input_file（媒体输入由用户自己选文件，数据端子值 = file:/// URL，可直接连给需要媒体参考的端子）· 处理 proc_text / proc_image / agent_task（智能节点）/ db_table · 生成 music_gen / tts_gen / video_gen / remotion / flux3klein_gen（本机 FLUX 3 Image Klein 图像生成 / 编辑）· 保存 save（旧别名 save_text / save_image）/ save_pdf（文本 → PDF，见下「保存类节点」）· 批次 split / merge · 控制 control / judge / task · 节拍等待 wait_file / timer / delayer / sequencer / gate / splitter / counter / mutex · 容器与广播 super / db_replica / global / execute（执行节点绑 execPath，无数据端子）· 计算 tool / function（参数即端子）。

## 硬规则（误接线主要来源）

- task 自带固定 start / endSuccess / endFail（勿删）：活儿非平凡先建 task 当计划，实现用 parentTaskId 放进去，控制线必须从 start 走到成功或失败终点；judge 只有两个输出：fromIndex 0 = YES、1 = NO。
- super 用 parentSuperId 打包（需 canvas_super）：对外只暴露边界输入/输出端子。
- **跨节点层是硬规则（不是建议）**：一条数据线只允许落在「同一层」（两端 parentSuperId 相同）或「节点层 ↔ 它的直属子节点」这条边界上。跨层一律走逐层链：`层内节点 → 直属壳的输出端子 → … → 最外壳 → 最外壳 → … → 目标壳的输入端子 → 层内节点`，每一段只连直接父子，绝不越级；同壳两颗兄弟节点直接连，不碰边界端子。connect / superConnect 遇到跨层会自动改写成这条链（静默，不必手拼桥接线；同一对重复调用不新建线）；方案落不下来（端子满 / 回路 / 嵌套错）就整对拒绝并给 warning，绝不留半截线。**任何入口都不许留下「层内节点直连层外」的线**：落线总闸会拦，读档与每次编辑后也会静默清掉。
- tool / function 节点：参数表就是端子表——输入端子 0 = 控制入、1..N = 按顺序的各入参；输出端子 0..M-1 = 各出参、末位 = 控制出。fromIndex / toIndex 按这份表数（目标的 toIndex 0 = 控制入）；数组端子看参数的 list 说明；传 inputs / outputs = 整体替换该表，删参数会让已连的端子改指别的参数，改完提醒用户复核连线。
- **接进「已占用」的输入端子 = 替换旧线，不是报「已被占用」**：一端口一线的普通输入端子已有线时，再连一条**同类**线（数据线换数据线、控制线换控制线）会顶掉旧线再接上新的，旧线进撤销栈（整次替换 = 一步 Ctrl+Z），并提示「已替换端口 N 上的原有连线」；回执里该对线带 `replaced`（被换掉的上游节点 + 端子号），别把替换误当成「多接了一条」。**不替换**的情形：参数端子 9001 / 数组（批量）端子 / 动态节点的专用控制端子（本来就能多线）；类型不符仍是错（先判类型，旧线不动）；控制线与数据线互不顶替；省略 toIndex（拖到节点卡片身上 / 不点名端子）照旧走自动落点、满了才报占用。Remotion 端子无差别（控制 / 数据共用），照样顶掉。完全相同的线（同来源端子 → 同目标端子）再连一次是无操作，静默忽略。
- @引用：连线源在 prompt/task 里写 @标题；引用全局广播须同时 (1) 源接进 kind "global"、(2) 消费节点 globalRefs:true、(3) prompt/task 里 @源标题——只有被明文 @ 命中的才注入；@标签名 注入带该标签的全部节点内容。为节点写 prompt/task 而要用别的节点的内容时，一律写 @标题（连线源），不要粘贴正文——粘贴的不随上游重跑更新。素材节点本身不是 @ 候选：写它的内容条目标题（＝端子名）只引那一条，且只有已连线接进本节点的端子条目可引。
- 智能节点（agent_task、开了 agent 的 proc_text）自己会写文件：其后绝不接 save（会把会话噪声落盘），也别当数据输入连给别人——让它写文档，再用 wait_file 以控制线挡住下游（它不收数据输入、不输出值，只有末位那颗专用控制端子能接控制线），后续节点自己读约定路径。
- save 只接在普通（非智能）proc_text / proc_image / flux3klein_gen 之后（flux3klein_gen 的图像从输出端口 0 出，可直连 save 落 .png）；music_gen / yue_gen / breeze_gen / video_gen 由节点自己的 outputPath 直接写出音 / 视频，不配 save；remotion 例外：无 outputPath，mp4 由下游 save 落盘（.mp4 结尾）。**保存类节点（save / save_pdf）本身有 1 个数据输出端子＝本次保存的那份内容**（与落盘内容一致），可继续往下游接、也能被 @ 引用；详见下面「保存类节点」。
- 图像生成节点（proc_image / flux3klein_gen）每次运行只出 1 张图：要多图就一条批量项出一张、或用多个节点、或 attempts N。
- proc_image（图像处理/生成）节点可开透明背景：用户要透明底成品（贴纸 / 图标 / 精灵 / 立绘 / 抠好的主体）时，把该 proc_image 节点的 bgRmOn 置 true 即可——正常写主体提示词，内部先出纯黑基准、再严格复刻纯白并差分出 Alpha（带透明 PNG）；约 2 倍 Token，且只有能把基准图当参考图下发的服务商（OpenAI 兼容 / Stability 生图）才会抠图，其余自动跳过。不需要透明底或换回单张就置 false。
- batchMode "batch" = 每条一次运行、每次只看该条：严禁把整批 N 条又全部塞进每次运行（≈N² 次调用）；只处理其中一项先接 split，要一次看全部才用 "agg"。逐条批量优先普通 proc_text / proc_image（智能节点只用于 agg）。细则见技能 mtnode-canvas-batch-safety。
- 数据库：super + db:true 存事实、用户编译（⚙）产出 db_replica；接到副本的智能节点一切事实走 mtnode_db（纪律见该工具说明与技能 mtnode-db-facts），禁止凭记忆。
- 开发节点（super + dev:true）：note 两段 ≤200 字（【功能】非技术设计 + 【实现】技术梗概）、devPath = 项目根、parentSuperId 逐层嵌套按深度细化、元素间关系用 rel:true 关系线表达、按 DEV 功能色卡上色；建块与细化完整规范见技能 mtnode-dev-architect。
- 排版：**每次改结构的编辑都会自动排版**（create / connect / disconnect / remove / createMarks / group / 改 w·h 都算；用户自己拖拽不算），不必显式传 layout，传 `layout:false` 才跳过。算法口径：列顺序 = 层顺序，再按行折起把每层包围盒收进 16:9~9:16（收不进会在回执 warnings 里提示「仍是长条」）；同层里上游在左或在上；节点互不重叠；你显式给的 x/y 只当起始锚点。用户要编辑或点 ▶ 的节点放上方（较小 y）。完整规范（createMarks box + around 分区、control 直连每个该一键重跑的节点且控制流不走数据线、不要建 "clear"）见技能 mtnode-canvas-layout-ux。
- 局部画布（scope）：整笔调用只改某一颗超级 · 开发节点内部时传 scope=那颗壳（scopeDepth 决定一层还是整棵），界外节点跳过并在 warnings 说明；新节点缺 parentSuperId 时默认落进这颗壳。
- 建完工作流 / 改完数据流后，按技能 mtnode-ai-facts 把关键结论（端口与数据流、命令入口、约定、已知坑）沉淀进本画布的 AI 事实库（`mtnode_facts`）。
- 绝不删除或与正在运行本任务的节点重叠；改完告诉用户可编辑输入并用 control ▶ 重跑。

## 端子怎么读（读图一次读全，别靠试连反推）

`canvas_get`（standard / full）对端子数固定的节点回 `ports`；对输入端子随连线增量长出来的节点另回 `portRule`（proc_image 在 `ports` 名单里，故 `ports` 上还挂一份同样的 `rule`）。

- **端口 0 = 提示词 / 文本入口 · 端口 1+ = 数据槽**：连一条数据线就多一个槽，文本与图像引用都收；参考图（图生图 / 图像编辑）接端口 1+，**不要接端口 0**。输出 端口 0 = 内容 · 末尾 = 控制输出。
- **动态端子节点（proc_text / proc_image / agent_task / input_*）的末位恒有一颗专用控制端子**：控制线只连它（数据线永不占它；可接多条控制线 = 任一到达即触发一次，要等齐用 gate）。它的号随数据槽增长（`portRule.input` 会写出当前号），省略 `toIndex` 时控制线自动落到它 —— 不要把控制线连到端口 0 或数据槽上。
- **「组」输入端子（智能节点专有，端子号 9002）**：只有 `agent_task` 与开了智能的 `proc_text` 有，来源是画布组框标题栏的 □（不是节点），线记成 `from: "grp:<组id>"`。它不占 0..N-1 顺序端口、不参与上游补跑 / 取值 / 端口占用，也**不会**因接线触发组内任何节点运行。接上后这颗节点这一轮的上下文里会多一段【组输入】清单（组内每个节点的 标题 · 类型 · 描述 · id，多组按 id 去重合并）：那是**清单不是正文**，要正文自己用 `mtnode_canvas_get` 按 id 取；清单里出现自己属正常（组往往围着它建）。要接组线就用 `connectGroup`（`connect` 落不到这颗端子），普通数据线连它会被拒。
- `ports` / `portRule.now` 只列**当下真实存在**的端子：没连线的节点是「端口 0（数据槽）+ 末位控制端子」两颗，据此断定「没有图像参考端子」是错的。
- **不要用「先试连一条线、再看回执 warnings」反推接法**：一次读图就读全了，试连既多一轮往返又可能真接错。
- 控制类 / 固定端口类（control / wait_file / timer / gate / judge / task / video_gen / remotion / breeze_gen / super / tool / function / 素材）端子由结构或参数钉死，按 `ports` 读即可。

## 参数端子（一份 JSON 覆写节点配置）

所有**插件节点**与**存在配置的节点**（= 已登记 ⚙ 设置窗，减去排除表：control / judge / gate / splitter / counter / mutex / sequencer / delayer / timer / wait_file / net_recv / net_send / input_* / asset / super / deliver / ltout / ltart / db_*）在输入端**最末位**都有一颗独立的「参数」端子；`tool` / `function` 也有（口径不同，见本节末段）。它不占 0..N-1 的顺序端口，端子号恒为 **9001**（哨兵值）——所以既有连线号码一颗都不会被它挤动，老画布零迁移。

- **它收什么**：只接文本来源（input_text / proc_text / 变量等），正文是一份 JSON **对象**。多份参数线按接线顺序**深合并**、同键后者胜；嵌套对象逐层合；数组整体替换；`null` = 该键恢复节点默认值；不支持删键。
- **键名**：只能是该节点的配置字段正式名（camelCase：`savePath` / `outputPath` / `size` / `imgQuality` / `duration` / `temperature`…），**区分大小写，不接受 snake_case / kebab-case 变体**（写错 = 未知键）。`canvas_get`（standard / full）对该节点回 `paramKeys` —— 想知道能写哪些键就读它，不要猜；每个键的含义见节点 ⚙「参数覆写」右上的文档按钮（用户界面里的同一份说明）。
- **只覆写配置**：结构字段（`batchMode` / `ro` / 端子表…）与内容主体（`prompt` / `text` / `task` / `jscode`）写进来按未知键忽略并警告。
- **生效方式**：**运行时临时覆盖**，不改画布上的值、不写回节点配置；批量时每次运行各取当时那份。跑完节点卡片的「参数」标识消失。
- **路径**：路径类键（`…Path` / `workspace` / `dir` / `root`）支持**相对路径**，按画布工作目录解析（与 save 节点同一口径）；绝对路径原样。
- **异常**：默认宽松（没写的键沿用节点值 / 未知键忽略 / 类型不符的键回退并标黄）；要整份拒绝就在同一节点上传 `paramStrict:true`（节点 ⚙ 里那个「参数严格校验」开关，两边同源），开了就整份拒绝、该节点不运行。
- **函数 / 工具节点的 9001 不是「覆写配置」**：它们的参数不写任何节点字段。函数节点那份 JSON 整份进 `input.params`（先取节点 ⚙ 里的默认参数 JSON，再由 9001 上的线深合并上去）；工具节点那份是它内部图的**共享参数**，内部函数节点沿父壳自动继承（自己那份同名键优先，自己的 9001 线最高）。所以给这两类节点接参数线时，别指望它改 `jscode` / `prompt` —— 那是给代码读的输入。- **服务商字段也能覆写**：`providerId` / `provider` 写进参数后按本机配置解析——本机没有这个服务商时，自动按「名称唯一 → 该节点 model 归属」换成可用服务商（写回画布节点字段、可撤销），仍对不上则保留原值、警告并**跳过该节点运行**。所以别为了换个模型写死别人的服务商 id。

- **怎么给参数：只能接线，没有第二种写法** —— 建一颗 input_text 写一份 JSON 对象，再 `connect`（来源文本节点 → 目标节点，`toIndex: 9001`）。`canvas_edit` 的 create / update **不接受 `params` 字段**：带上它整笔调用会被拒绝（报错会指名冲突节点）。原因：params 会把参数直接挂到节点上、运行期压住用户在 ⚙ 里改的值，用户从此改不动参数 —— 参数必须看得见、改得动，所以只走那颗端子。

```json
{ "savePath": "out/今日海报.png", "model": "gpt-image-2-vip", "size": "1536x1024" }
```
（上面这份 JSON 是 **input_text 节点的正文**，不是 canvas_edit 的参数。）

读回：`canvas_get`（standard / full）回 `paramKeys`（本节点可覆写的键）与 `ports`（确认 9001 那颗端子接上了）；设置窗 ⚙ 里那张「参数覆写」明细表列出 键 / 节点当前值 / 本轮生效值 / 来源；同一节右上的文档按钮打开「全部参数 + 文字说明」，出问题时先看这两处。参数**只允许 Agent 经端子写入**：不要再试图「顺手把某个节点参数改成用户要的值」，那属于用户自己的设置。

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

## 生成类节点：flux3klein_gen（本机 FLUX 3 Image Klein 图像生成 / 编辑）

FLUX 3 Image Klein（5.6B 蒸馏）跑在用户本机的独立 ComfyUI 后端（插件 `flux3-klein-local`，默认端口 8197），不出网、不吃云端服务商；与云端 `proc_image` 是两套东西：proc_image 走服务商 API、size 自由填，flux3klein_gen 的比例只能是它自带的桶。节点指南见 `guides/nodes/flux3_klein_gen.md`。

- **端子是钉死的（不是 proc_image 那种增量槽）**：输入 端口 0 = 提示词文本 · 端口 1 = 参考图（可多接，最多 10 张）· 端口 2 = 控制输入；输出 端口 0 = 图像（`{kind:"image", path}`，可直连 save 落 .png / 图像预览 / @ 引用）· 端口 1 = 控制输出。空白节点就列这三颗，按 `ports` 读，别拿 proc_image 的 `portRule` 套它。
- **必须先装插件**：kind 建出来只是空壳；后端没装 / 没起时节点红字指路、▶ 硬停。安装走顶栏「插件」→ FLUX 3 Image Klein 卡片（命令行口径见技能 `flux3-klein-local-install`）；本机没装就不要替用户「先跑一下试试」。
- **连参考图就是编辑模式**：端口 1 接 1–10 张图 → 走官方编辑路径（多参考），输出跟节点「比例」参数一致；蒙版重绘取端口 1 的第 1 张参考图，所以蒙版用法必须先连一张图。
- **分辨率只能是桶**：`1:1`(1024²) · `16:9`(1344×768) · `3:2`(1248×832) · `4:3`(1152×896) · `2:3`(832×1248) · `3:4`(896×1152) · `9:16`(768×1344)。**不要传 size、也不要写自由像素值**；参数键值与默认值见节点指南的「参数」一节。
- **显存按精度分档**：`INT8 蒸馏`是默认档，8G 卡可用（1:1 / 1024²）；`BF16` 细节更好、建议 24G 卡。装不下就切回 INT8 或降比例桶。
- **抽卡 / 种子**：抽卡次数（每次执行 seed+1），抽 N 次 = N 张图；开透明背景时 = 2N 张（先黑底出基准、再把基准当参考图换纯白，两遍差分出 Alpha）。透明底适合主体清晰、背景干净的画面，复杂背景会有毛边。
- **不写输出路径**：flux3klein_gen 没有 outputPath（和 proc_image 一样）——产物落应用资产目录，从输出端口 0 以 `{kind:"image", path}` 交出去，下游直连 save / 预览即可；写 outputPath 是无效字段。
- **全局互斥**：图像生成与音乐 / 视频生成共用一把全局锁，同一时刻只跑 1 个；第二个节点报「已有媒体任务在跑」是设计行为，不是故障。
- **耗时预期**：点 ▶ 会自动拉起后端（ComfyUI）并可能现加载权重（分钟级），跑完不自动关；不要因为没立刻出图就重复点 ▶ 或重跑同一节点。

## 字段细则（工具 schema 里只留一句，细则查这里）

- **video_gen 端子（videoMode）**：控制输入恒为端口 0 = 第一个端子，数据端口从 1 起且与「端子号 / 数据槽号」同号 —— `fl2va` = 控制(0) · 提示词(1) · 首帧(2) · 末帧(3)；`r2v` = 控制(0) · 提示词(1) · 参考图 I1–I9(2–10) · 参考视频 V1–V3(11–13) · 参考音频 A1–A3(14–16)；自建工作流（workflowId 非空）= 控制(0) · 文本(1) · 素材(2+)，端子按该工作流参数重排。connect 的 `toIndex` / `fromIndex` 是 0 起始下标，就等于括号里的号。
- **proc_image 的图像参数**：`maskOn` = 蒙版局部重绘（透明区才重绘，只认第 1 张 image）；maskPath 必须由用户在节点头部蒙版编辑器里涂，Agent 不能代画；需图像输入 + OpenAI 兼容图像服务商，与 `ratioLockOn` 同时开时以蒙版为准，且请求 size 被钉成首张参考图的像素尺寸。`bgRmOn` = 差分抠图出带 Alpha 的 PNG（先出纯黑基准、再复刻纯白逐像素差分，约 2 倍 Token；只有接受「基准图当参考图」的服务商才抠得动）。`imgQuality` 直传 quality（low/medium/high/xhigh/max；空 = 服务商按 auto；旧版 DALL·E 的 standard / hd 不要传）。`imgBackground: "transparent"` 直出 Alpha PNG（自动补「背景透明」提示词并禁用 bgRmOn）。`size` 合法值用 canvas_get `sections:["refs"]` 取，缺省 2048x1360。
- **输出路径**：`outputPath` 扩展名按媒体类型强制（.mp4 / .wav / .flac / .mp3）；flux3klein_gen / proc_image 没有这个字段（结果落资产目录、从输出端口 0 交出）。
- **execute / function**：`execPath` 绑本机可执行文件（.exe / .bat / .cmd / .lnk，无数据端子）；`execIcon` 取 auto / rocket / gear / terminal / play / bolt / wrench / folder / file / power。`jscode` 里 `input = { 参数名: 值 }`（图像是 `{kind:"image", path}`），`return { 输出参数名: 值 }`；`inputs` / `outputs` 传完整数组即整体替换端子表（会连带改连线）。
- **super 展开态 / 开发节点**：`expandW` / `expandH` 是展开态尺寸；`subFolder` 是内部节点相对路径的落点；`db` 标数据库节点（编译后出 db_replica）；开发节点字段语义见技能 mtnode-dev-architect。

生成类节点的共同口径（music_gen / yue_gen / breeze_gen / video_gen 的 outputPath、抽卡 + seed、全局锁、媒体输入走 file:///）另见技能 mtnode-media-gen-nodes。
