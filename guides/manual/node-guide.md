# 节点指南索引

> 一句话目标：知道每个节点类型的专用说明在哪个文件里，以及怎么从画布上一步打开它。

![节点类型全图](img/mtnode-canvas-06-ui.svg)
*图 1：39 个已登记节点类型，每一种都有一份自己的 Markdown 图示指南。*

## 目标

**节点指南**是「这一种节点」的说明书：它的**端口怎么接、按钮干什么、什么情况会失败**。手册讲的是**整个应用怎么用**，两者分工明确、不重复。

节点指南是 Markdown 文件，放在 `guides/nodes/`，由 `guides/nodes/index.json` 登记 **39 个 id**，中英各一套（缺英译时回退中文）。本页就是这份清单的中文索引。

## 前置条件

- 画布上已经有一个节点（任选一种方式新建，见 [节点、端子与连线](#nodes-wires)）。
- 想看英文版，先把顶栏语言切成 EN——指南语言跟随界面语言。

## 步骤

### 1. 从节点直接打开

在画布上**右键任意节点** → 菜单第一项就是 **节点指南**，点开即可。

对话框标题是「**节点指南 · <节点标题>**」，正文是该类型的 Markdown 图示，右下角 **关闭**（或 ✕ / `Esc`）收起。

### 2. 认清「指南 id」是怎么定的

打开的指南文件由节点类型决定，规则很简单：

- 一般节点 → 直接用它的 kind 当 id（如 `proc_text`、`gate`）；
- **保存节点** → 统一走 `save`；
- **控制节点** → 按角色分流：起点走 `ctrl-start`、成功终点走 `ctrl-end-ok`、失败终点走 `ctrl-end-fail`，其余走 `control`。

### 3. 按类型查下面的索引表

| id | 指南文件 | 说明 |
| --- | --- | --- |
| `input_text` | `guides/nodes/input_text.md` | 文本输入 |
| `input_image` | `guides/nodes/input_image.md` | 图像输入 |
| `input_audio` | `guides/nodes/input_audio.md` | 音频输入 |
| `input_video` | `guides/nodes/input_video.md` | 视频输入 |
| `input_file` | `guides/nodes/input_file.md` | 文件输入 |
| `asset` | `guides/nodes/asset.md` | 素材节点（绑定素材库 · 内容条目即端子） |
| `proc_text` | `guides/nodes/proc_text.md` | 文本处理 |
| `proc_image` | `guides/nodes/proc_image.md` | 图像生成 / 处理 |
| `save` | `guides/nodes/save.md` | 保存（保存节点的统一入口） |
| `save_text` | `guides/nodes/save_text.md` | 保存 · 文本 |
| `save_image` | `guides/nodes/save_image.md` | 保存 · 图像 |
| `split` | `guides/nodes/split.md` | 拆分批次 |
| `merge` | `guides/nodes/merge.md` | 合并 |
| `global` | `guides/nodes/global.md` | 全局节点（只连入的广播源） |
| `task` | `guides/nodes/task.md` | 任务节点 |
| `super` | `guides/nodes/super.md` | 超级节点 |
| `agent_task` | `guides/nodes/agent_task.md` | 智能任务节点 |
| `execute` | `guides/nodes/execute.md` | 执行节点（启动本机程序） |
| `control` | `guides/nodes/control.md` | 控制节点 |
| `ctrl-start` | `guides/nodes/ctrl-start.md` | 任务起点 |
| `ctrl-end-ok` | `guides/nodes/ctrl-end-ok.md` | 成功终点 |
| `ctrl-end-fail` | `guides/nodes/ctrl-end-fail.md` | 失败终点 |
| `judge` | `guides/nodes/judge.md` | 判断（YES / NO 两路输出） |
| `wait_file` | `guides/nodes/wait_file.md` | 等文件（监视到文件存在才放行） |
| `timer` | `guides/nodes/timer.md` | 定时器 |
| `delayer` | `guides/nodes/delayer.md` | 延时 |
| `sequencer` | `guides/nodes/sequencer.md` | 序列 |
| `gate` | `guides/nodes/gate.md` | 闸门 |
| `splitter` | `guides/nodes/splitter.md` | 分发 |
| `counter` | `guides/nodes/counter.md` | 计数 |
| `mutex` | `guides/nodes/mutex.md` | 互斥 |
| `net_recv` | `guides/nodes/net_recv.md` | 网络接收 |
| `net_send` | `guides/nodes/net_send.md` | 网络发送 |
| `music_gen` | `guides/nodes/music_gen.md` | 音乐生成（Minimax Music 3） |
| `tts_gen` | `guides/nodes/tts_gen.md` | 语音生成（SoVITS） |
| `video_gen` | `guides/nodes/video_gen.md` | 视频生成（Minimax H3） |
| `remotion` | `guides/nodes/remotion.md` | Remotion 视频 |
| `db_table` | `guides/nodes/db_table.md` | 表节点 |
| `db_replica` | `guides/nodes/db_replica.md` | 数据库副本 |

同一目录下还有 `function.md` 与 `tool.md` 两份（函数节点 / 工具节点），以及给维护者看的 `README.md`；`index.json` 的 `ids` 数组登记的是上面这 39 个。

> 💡 技巧：节点指南按**节点类型**索引——画布上有两个同类型节点时打开的是同一份指南，差异只在它们各自的参数与提示词里。

### 4. 控制类节点：先看指南，再回手册

定时、延时、序列、闸门、分发、计数、互斥、判断、等文件这些节点的「按钮语义」容易望文生义——尤其**定时器的 ▶ 是打开闹钟**而不是立刻跑。建议先看节点指南弄清单个节点的端口与按钮，再回到手册的 [控制流与判断](#control-flow) 章节把它们串成一条链。

### 5. 找不到指南时

如果该节点类型**没有对应指南文件**，对话框会直接提示缺失（正文里给出那个 id），**不影响画布**——节点照常能拖、能连、能跑。遇到这种情况请把 id 反馈给开发者。

## 结果

- 你能从任意节点一步打开它自己的说明书，不必翻整本手册。
- 端口序号、按钮语义、失败原因这三类问题，在节点指南里就能得到答案。
- 需要跨节点串联时，回到手册对应章节（控制流、批量、媒体等）继续读。

## 常见错误

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 右键没有「节点指南」，或打开后提示找不到 | 点在空白处，或该类型还没有对应指南文件 | 确认点在节点本体上；确实缺失时节点照常可用，把对话框里显示的 id 反馈给开发者 |
| 指南是中文，想要英文 | 指南语言跟随界面语言 | 用顶栏地球按钮切成 EN；缺英译时回退中文属正常 |
| 保存节点的指南 id 不是 `save_text` | 保存节点的指南 id 统一是 `save` | 想看按类型细分的说明就查 `save_text.md` / `save_image.md` 文件 |
| 控制节点打开的指南和预期不符 | 控制节点按**角色**分流 id | 起点看 `ctrl-start`，成功 / 失败终点看 `ctrl-end-ok` / `ctrl-end-fail`，其余看 `control` |
| 把手册当节点手册查端子序号 | 手册讲全局用法 | 端子序号以该节点的节点指南为准 |
| 指南里的按钮和界面对不上 | 版本差异 | 以界面为准，并把差异反馈给作者 |
| 想要「整个应用怎么用」的说明 | 节点指南只讲这一种节点 | 用顶栏 **文档** 打开本手册（见 [界面导览](#ui-tour)） |

## 下一步

- [控制流与判断](#control-flow)
- [节点、端子与连线](#nodes-wires)
- [输入 / 处理 / 保存](#io-proc)
- [音乐、视频、网络与执行节点](#media-net)
- [名词表](#glossary)
