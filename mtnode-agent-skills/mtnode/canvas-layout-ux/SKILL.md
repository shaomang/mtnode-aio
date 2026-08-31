---
name: mtnode-canvas-layout-ux
title: 画布排版与可操作区
description: MTNode 画布节点排版：可编辑/控制节点靠上（小 y），处理与保存靠下或右侧；createMarks 分区、control 一键重跑；禁止 agent 调用 layout action。Use when auto-layout, createMarks, control nodes, or improving canvas UX for the user.
---

# 画布排版与可操作区

## 可操作区靠上

用户需要 **编辑或操作** 的节点应放在画布 **偏上方**（较小 `y`）：

- 输入节点、可改提示词、`control` ▶ 等

处理、保存、长说明放 **下方或右侧**。

## 分区（createMarks）

- 用 `createMarks` 画 box/text 分区：编辑区、说明、处理区、输出区
- `box` 可用 `around:[节点alias]` 在排版后包住节点，并设 `label`

## 控制节点

- `control`：`ctrlAction=run`（不要创建 `clear`「清空」控制节点），`ctrlFillOnly=true` 时仅补跑无输出节点
- 控制流不会沿数据线传导：`control` 必须**直接连线到每一个**需要一键重跑的节点（处理 / 保存 / 媒体等）

## 一键排版（用户要求整理时）

1. `mtnode_canvas_get` 读取节点与 marks 的 x/y/w/h
2. `mtnode_canvas_edit`（`layout:false`）用 `update` / `updateMarks` 校准位置
3. **禁止**调用 `layout` action
4. 勿增删节点、勿改连线

## @引用

- 连线节点：`@标题`
- 全局广播：处理节点须 `globalRefs:true` **且** prompt/task 内写 `@源标题`（缺一不可）
- `@Tag标签` 引用该标签下全部节点（`tagCatalog`）
