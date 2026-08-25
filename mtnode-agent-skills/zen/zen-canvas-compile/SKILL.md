---
name: zen-canvas-compile
title: 禅画布构建
description: Zen Mode 画布编译技能：把已确认的计划映射为 MTNode 可执行工作流（任务/控制/判断/分区、agent_task、wait_file 文件交接），输出任务节点与计划条目的映射表。
---

# 禅画布构建（zen-canvas-compile）

把计划编译成 MTNode 画布工作流。先用 `mtnode_canvas_get` 了解画布能力与现有状态，再用 `mtnode_canvas_edit` 搭建。

## 映射原则

1. **一个计划条目 → 至少一个画布节点**；条目分解出的步骤可以多个节点。
2. **布局**：用户要编辑/操作的节点（输入、提示词、控制 ▶）放画布上方；处理居中；保存/输出/文档放下方；完成后自动排版、确保无重叠。
3. **分区**：用 createMarks 的 box/text 标注「编辑 / 处理 / 输出」等区域，控制节点（ctrlAction run/clear）接到处理节点上便于一键重跑。
4. **智能长链**：复杂多步段落用 `agent_task` 节点；跨节点文件交接用 `wait_file`（waitPath）控制线，后续节点自行读取约定路径 —— 不要把 agent_task 的输出直接接给其他节点当数据输入。
5. **批量**：逐条处理用 batchMode=batch；聚合分析才用 agg；不要在同一轮里把整批喂给每次运行。
6. **图像**：proc_image 一次只生成一张图；需要多张就拆多个节点或 1:1 批量条目。
7. 遵守 generate-task / generate-workflow 技能中的节点与连线约定（如注入时以它们为准）。

## 收尾

- 用 `mtnode_canvas_get` 核对：节点标题唯一、连线正确、无重叠。
- 输出映射表 JSON（只输出 JSON）：
  `{"map":[{"taskNodeId":"画布节点id","planAnchor":"计划锚点(如 zen:node:xxx 或序号)","title":"节点标题"}]}`
- 映射覆盖全部主要任务节点；planAnchor 与计划中的 `<!-- zen:node:... -->` 锚点一致。
