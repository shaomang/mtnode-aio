---
name: mtnode-media-gen-nodes
title: 音乐/视频生成节点
description: MTNode music_gen 与 video_gen 节点：MiniMax Music 3 / H3 后端、输出路径、抽卡次数、种子 +1、全局仅 1 个音视频任务互斥。Use when wiring music_gen, video_gen, media output paths, gacha rolls, or VRAM-related concurrency errors.
---

# 音乐 / 视频生成节点

## 节点种类

| kind | 后端 | 输入 |
|------|------|------|
| `music_gen` | MiniMax Music 3（Gradio） | P=提示词，L=歌词 |
| `video_gen` | MiniMax H3（ComfyUI） | P=提示词；可选图/音/视频参考 |

## 输出

- 在节点 **设置** 中配置 `outputPath`（及可选文件名）
- 抽卡 `attempts` 1–10：多轮生成，文件名 `_01`、`_02`…
- **不要**再接 `save_*` 节点

## 种子

- 「摇数」开启时：每次执行（含每一抽）**种子 +1**，非随机

## 全局互斥（显存）

- 全应用 **同时只允许 1 个** 音乐或视频生成任务
- 另一节点启动会被拒绝并提示占用中的节点
- 抽卡连跑为 **串行**，每轮结束释放锁后再占

## 图像尺寸策略

- **生成输出**：保持 API 原尺寸（`assetWriteBase64` 不降采样）
- **参考图输入**：超过 1080p 等比缩小（`assetCopy` / API 参考图）

## 插件安装

- 后端未安装时走插件设置或 `minimax-music3-install` / `minimax-h3-install` 技能（安装专用，非用户工坊列表）
