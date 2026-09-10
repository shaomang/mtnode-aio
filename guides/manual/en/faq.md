# FAQ

> One-sentence goal: a single "symptom → cause → fix" table that lets you match up the pitfalls people hit most often, in one pass.

![FAQ](img/mtnode-app-05-ui.svg)
*Figure 1: The FAQ covers eight families of symptoms — canvas, batch, control flow, assets, media, network, agent features, and the Chinese / English interface.*

## Goal

Collect the questions that used to be scattered across pages into one scannable table, then add an **error-code / symptom index** so you can jump from the sentence on your screen straight to the matching section.

If what you want is "how do I do something from scratch", read the section for it in the left-hand contents. This page answers "it should have run — so why didn't it".

For logs, the diagnostic bundle or the startup data-folder audit, see [Troubleshooting](#troubleshoot).

## Before you start

- Look at the **error bar on the node card** first — it already explains most symptoms.
- If you are unsure what request is actually being sent to the provider, use **◈ Preview** on the node.
- To dig deeper, have your local data folder path ready (see [Workspace & archives](#workspace)).

## Steps

Look the symptom up in the tables.

### Canvas and operations

| Symptom | Cause | Fix |
| --- | --- | --- |
| Pressing ▶ does nothing / it always fails | No API Key filled in, no input wired, or an image job on a provider that does **not support vision** | Work through the node's error bar item by item; use ◈ Preview to see the request that is about to be sent (see [Providers & API](#providers)) |
| A wire will not drag out | You started dragging from the node title instead of pressing the port circle | Press on the port circle and then drag; if an input port is already taken, disconnect it first or use a new port (see [Nodes, wires, @ refs](#nodes-wires)) |
| After expanding a super node you cannot see the inner nodes / ports | It is still in the collapsed state | Use the header expand icon to open the **shell**, or click **↪ Enter** to edit full-screen; the inner ports sit on the shell's left and right edges (see [Super nodes](#super-nodes)) |
| Save paths inside a super node land in the canvas root | The super node has no subfolder set | Give it a **subfolder**; inner relative paths are then automatically hung under that prefix (see [Workspace & archives](#workspace)) |
| Two copies of a saved file while the assistant builds the graph | While the global assistant / agent session is editing the canvas, save nodes do **not** write to disk — everything is written once the whole task finishes | If you still see an older file, you probably pressed a manual ▶ save mid-run; just delete the extra copy |
| "How do I switch between Chinese and English?" | The UI language follows the globe button in the top bar | Click the globe button in the top-right to switch; the manual and the node guides both exist in matching languages, falling back to Chinese when an English translation is missing (see [Settings](#settings)) |

### Batch and control flow

| Symptom | Cause | Fix |
| --- | --- | --- |
| Batch only ran the first item | The process node is in **Aggregate** mode | Click the mode switch in the header and change it to Batch (批量) (see [Batch, split, merge](#batch)) |
| Pressing ▶ on a timer runs downstream immediately | A timer's ▶ **arms the alarm**; the pulse only fires when the time comes | If you want to run right now, use an ordinary process node or the Run (执行) control node (see [Control flow & judges](#control-flow)) |
| The gate never lets anything through | An AND gate waits for the **configured** number of inputs, and **unwired ports count too** | Lower the input count, or wire every port |
| You cannot tell which line is thinking and which is the reply | Output is rendered as segments in the order things happened | **"◉ Thinking · N chars"** collapses only the model's internal reasoning (N counts thinking characters only); what it says mid-run appears as normal-size body text, and 🔧 tool calls are inserted inline where they happened (see [What agent mode is](#dsh)) |

### Assets, media and network

| Symptom | Cause | Fix |
| --- | --- | --- |
| An asset node shows "asset lost" (素材失联) | The asset library root moved, or the asset folder was deleted / renamed | Put it back in the original folder and click Refresh (刷新), or bind it again (see [Asset library](#asset-library)) |
| After a run, the copy in the library has not changed | Existing library content is never silently overwritten | Click the **⟳** that lights up on the entry to replace it by hand |
| Do music / speech / video nodes need a save node after them? | No, they do not | Minimax Music 3, SoVITS speech and Minimax H3 all carry their own output path (`.wav` / `.mp3` / `.mp4`); adding a save node writes irrelevant content instead. **Remotion video is the exception** — it needs a downstream save node to land the file (see [Network & launch](#media-net)) |
| A network node receives no messages | One of three things does not match: protocol, channel id, host/port | Check TCP / UDP, the channel id and host/port one by one (default ports live in Settings · Network); make sure the receive node is **listening** |
| How does an execute node run? | It is a local program launcher | Double-click the node, or click the play button twice; the bound `.exe` / `.bat` or any file is launched through the OS default handler |

### Agent features and databases

| Symptom | Cause | Fix |
| --- | --- | --- |
| An agent task edits the wrong files | The workspace is wrong, or the approval level is too loose | Check the workspace; set permissions to Approve each (逐项审批) or turn off tool permissions you do not need (see [Approvals](#approvals)) |
| The docs assistant says it does not know | The docs assistant reads **only this manual** | For details of a single node, use **Node guide** on the node's right-click menu; or rephrase the question around a section in the left-hand contents (see [Node guide index](#node-guide)) |
| An agent node cannot answer database questions | No database is attached | Wire the **Database replica** into the input, or write `!@数据库标题` in the prompt. If one is attached but nothing matches, the discipline requires it to answer "数据库中没有该信息" — it will not guess (see [Database nodes](#database-nodes)) |
| Does dev-node Suggest need network / a model run? | Yes | The AI does a **read-only** review (reads the project code plus module progress) and then returns 4 options; the result is cached — "view last suggestion" does not re-run it, "another batch" does (see [Dev nodes](#dev-nodes)) |
| The assistant says "turn off the unrelated-to-the-canvas switch first" | The global assistant has the "unrelated to the canvas" (与画布无关) option on, so no canvas tools are registered for this run | Turn that switch off and run again (see [Agent task & session](#agent-nodes)) |

## Result

- You can go from one sentence on your screen to "which item was not configured / which step did not run / which switch is still on".
- When you need details, every row of the tables points at the section for it, so you can keep reading from there.
- For anything you still cannot find, go to [Troubleshooting](#troubleshoot) and run the three read-only diagnostic tools.

## Common mistakes

The table below is the **error-code / symptom index**: the left column is the wording (or key fragment) that appears on your screen, the right column is the section to read.

| Text / symptom on screen | Where to look |
| --- | --- |
| 「未配置服务商（设置 · API/配置）」·「未配置带 API Key 的文本服务商」 | [Providers & API](#providers) |
| 「该服务商未填写 API Key（设置 · API/配置）」 | [Providers & API](#providers) |
| Provider cannot read images / image job fails | [Providers & API](#providers) |
| 「请先指定保存路径（可用「浏览」选择）」 | [Input / process / save](#io-proc) |
| 「相对路径需要先设置工作目录（顶栏），或改用绝对路径」 | [Workspace & archives](#workspace) |
| 「工作目录无效 / 该路径不存在或不是有效文件夹，已自动清空」 | [Workspace & archives](#workspace) |
| 「数据保存在应用文件夹内」(startup dialog) | [Workspace & archives](#workspace) · [Troubleshooting](#troubleshoot) |
| 「监听失败：…」· port already in use | [Network & launch](#media-net) · [Troubleshooting](#troubleshoot) |
| 「已有音视频生成任务进行中…（全局仅 1 个，禁止并行）」 | [Network & launch](#media-net) |
| 「素材失联」·「内容暂不可读：素材失联…」 | [Asset library](#asset-library) |
| 「素材库正在回滚，请稍等一下再撤销 / 重做」 | [Undo & rollback](#rollback) |
| 「该轮仍在运行中，结束后才能回滚」·「该轮已回滚过，不能重复回滚」 | [Undo & rollback](#rollback) |
| 「画布已不存在，可能已被删除」 | [Undo & rollback](#rollback) |
| 「该输入端子已被占用」·「该保存节点按图像保存，只接受图像端子」 | [Nodes, wires, @ refs](#nodes-wires) |
| 「本助手已声明「与画布无关」…请先关掉」 | [Agent task & session](#agent-nodes) |
| 「请先等该节点运行完成再审阅」·「该节点还没有文本输出」 | [AI review: notes & revisions](#ai-review) |
| 「无法定位该文件的完整路径，只给你看文件名」 | [Markdown & code editing](#editors) |
| 「发现新版本 v…，是否下载更新？」download fails | [Updates](#update) |
| 「用户名或密码错误」 | [Account & sign-in](#account) |

## Next

- [Troubleshooting](#troubleshoot)
- [Glossary](#glossary)
- [Node guide index](#node-guide)
- [Shortcuts](#shortcuts)
- [Where things are](#ui-tour)
