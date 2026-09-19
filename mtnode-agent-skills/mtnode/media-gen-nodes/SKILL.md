---
name: mtnode-media-gen-nodes
title: 音乐/语音/视频生成节点
description: MTNode music_gen / tts_gen / video_gen 节点：MiniMax Music 3、SoVITS 语音、H3 后端、输出路径 outputPath、抽卡次数、种子 +1、全局仅 1 个音视频任务互斥、媒体输入端子走 file:/// URL。Use when wiring music_gen, tts_gen, video_gen, media output paths, gacha rolls, or VRAM-related concurrency errors.
---

# 音乐 / 语音 / 视频生成节点

## 节点种类

| kind | 后端 | 输入 |
|------|------|------|
| `music_gen` | MiniMax Music 3（Gradio） | P=提示词，L=歌词 |
| `tts_gen` | SoVITS 语音（GPT-SoVITS 本机插件 · 文本转语音） | 端口0=待合成文本（端口1=控制输入）；`voice`=音色、`speed`=语速 0.5–2.0、`ttsFormat`=wav/mp3 |
| `video_gen` | MiniMax H3（ComfyUI） | **端口 0 = 控制输入（固定在第一个端子）**；端口 1 = 提示词，2+ = 可选图 / 音 / 视频参考（端口号 ≡「端子 N」）|

## 媒体端子口径（URL）

- 输入节点（`input_audio` / `input_video`）各有 **1 个数据输出端子**，值是该本机文件的 **`file:///` URL**
- 生成节点的**媒体参考端子会自动归一**：`file:///` URL → 本机绝对路径，无需手动转换
- 因此音/视频输入节点可以直接连线到 `video_gen` 等需要媒体参考的节点

## 自建 ComfyUI 工作流（video_gen）

- `video_gen.workflowId` = 全局 H3 工作流库里的条目 id：**留空 = 内置 FL2VA / R2V 链**（默认，行为与老画布完全一致）
- 库里的图在 H3 管理窗口导入（ComfyUI 的 API 格式 / UI 格式都收），**不要凭空编造 workflowId**：先用 `mtnode_app` 的 `list_dsh_plugins` 之外的方式确认库里有什么——节点面板「工作流来源 → 自建 ComfyUI 工作流」下拉就是那份清单
- 自建模式下端子排布：**端口 0 = 控制输入（固定在最前）· 数据端子 1 = 文本参数 · 2+ = 素材参数（图 / 视频 / 音频，按参数表顺序）**；哪些字段占端子由节点上的参数表决定。**v5 起端口号 ≡ 面板里的「端子 N」（数据槽号）**，不必再换算
- 参数值优先级：**端子接进来的值 > 面板直填值 > 工作流 JSON 原值**
- 内置的 `duration` / `ratio` / `outputRes` / `steps` / `postEnabled` 在自建模式下**一律失效**（由工作流图自己决定）；抽卡、种子、进度、取消、全局互斥照常
- 种子：一次执行把节点种子下发到图里**所有** `seed` / `noise_seed` 类字段，所以种子参数不再单独占值输入

## 输出

- 在节点 **设置** 中配置 `outputPath`（及可选文件名）：`music_gen` / `tts_gen` 写音频（.wav，tts 可选 .mp3），`video_gen` 写视频（.mp4）
- 抽卡 `attempts` 1–10：多轮生成，文件名 `#1`、`#2`…（目标文件已存在时同样按 `#1`、`#2` 递增，绝不叠加 `_1`）
- **不要**再接 `save_*` 节点

## 种子

- 「摇数」开启时：每次执行（含每一抽）**种子 +1**，非随机

## 全局互斥（显存）

- 全应用 **同时只允许 1 个** 音乐或视频生成任务
- 另一节点启动会被拒绝并提示占用中的节点
- 抽卡连跑为 **串行**，每轮结束释放锁后再占
- `tts_gen`（SoVITS 语音）**不持这条全局锁**：GPT-SoVITS 是独立进程、显存另算

## 图像尺寸策略

- **生成输出**：保持 API 原尺寸（`assetWriteBase64` 不降采样）
- **参考图输入**：超过 1080p 等比缩小（`assetCopy` / API 参考图）

## 插件安装

- 后端未安装时走插件设置或 `minimax-music3-install` / `minimax-h3-install` 技能（安装专用，非用户工坊列表）

## 写 `music_gen` / `yue_gen` 的两段文本

- **端口 0（风格提示词）** → 先加载内置技能 `minimax-music-prompt`：产出固定为**一段六句英文散文**（曲风+情绪 → 速度与律动 → 乐器 → 人声 → 段落对比 → 制作混音），不是逗号标签、不是 JSON、不含唱词。
- **端口 1（歌词）** → 先加载内置技能 `minimax-music-lyrics`：结构标签独占一行，只有会唱出来的话进正文。
- 两份技能**随包内置**（frontmatter `menu: user` → `$DSH_HOME/skills` 带 `.builtin`），不再从创意工坊下载；写歌时不要让用户先去装。
- 字段名对照：Music 3 后端设置窗里端口 0 那格标的是 **Structured Caption（音乐描述）**，就是上面这段六句散文的原样落点——**不要**在那里自创三标题（Global Metadata / Vocal Details / Arrangement）结构，官方口径是一段能读的音乐描述。
