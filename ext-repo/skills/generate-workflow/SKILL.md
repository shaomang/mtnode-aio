---
name: generate-workflow
title: 生成工作流
description: 在当前画布生成可编辑、可一键重跑的数据流工作流（输入 → 处理 → 保存），带分区框与控制节点。
---

# 生成工作流

仅用于**智能会话**或**全局助手**。画布上的智能节点不能改图；若在节点里被调用，应改用读写文件完成任务，不要调用画布工具。

用户补充即目标（如「物品配置」「文生图管线」）。在当前画布上完成搭建。

## 步骤

1. 先 `mtnode_canvas_get`，看现有节点与 `taskFocus`。
2. **一次** `mtnode_canvas_edit` 搭完整条链，`layout: true`。
3. 用中文、互不重名的标题；提示词里用 `@标题`，并**连线**，否则引用无效。

## 默认结构（小管道）

- 用户要填的：`input_text` / `input_image`（可编辑，靠**画布上方**）
- 生成/转换：普通 `proc_text` / `proc_image`（单次生成用它们；要读已有文件再合并才用 `agent_task`）
- 落盘：仅接在**非智能** proc 之后的 `save_text` / `save_image`
- 一键重跑：`control`（`ctrlAction: run`，**不要创建** `clear`「清空」控制节点）**直接连线到每一个**需要一键重跑的节点（处理 / 保存 / 媒体等）
- `createMarks`：框体分区（编辑区 / 处理区 / 输出区），`around` 包住对应节点；短说明用 text 标注

## 注意

- 智能节点（`agent_task` / `proc_text`+`agent:true`）后面不要接 `save_*`
- 不要把智能节点当数据输入接到下游（改用写文件 + `wait_file` 控制阻塞）
- 不要给 `music_gen` / `video_gen` 再接保存节点：在节点上设 `outputPath` 即可
- `remotion`（Remotion 动效视频节点）**仅当已安装「remotion」应用插件时使用**；描述文本来自连线端口1（文本源），节点上可设 `duration`（秒 1–60）/ `fps`（1–60）/ `remotionSize`（如 `1280x720`、`1920x1080`、`720x1280`、`1080x1920`）/ `providerId` + `model`。与 music_gen/video_gen 相反：remotion 没有 `outputPath`，渲染出的 mp4 由**下游保存节点**落盘（`savePath` 用 `.mp4`），所以它后面要接一个 `save` 节点
- 批量 `batchMode:batch` 时不要把整批 N 条再塞进每一次运行（防 N²）
- 文生图一次不要要求「生成多张」；一跑只出 1 张
- 控制流不会沿数据线传导：control 必须与每个目标节点**直接连线**，不要指望连到一个节点就带动整条链
- 不要删除或挡住正在运行的节点

简单目标不要包一层 `task`。节点很多、区域重复时，用 `kind: "super"` 收纳（`parentSuperId`）；展开后可直接在壳内画布编辑，拖入/拖出节点即可移入移出。可为超级节点设置 `subFolder`，内部新建保存类节点的默认相对路径会落在该子文件夹下。创建超级节点通常需用户审批（`canvas_super`）。搭完用一两句话告诉用户：改输入/提示词，点控制 ▶ 即可重跑。
