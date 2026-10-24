---
name: mtnode-local-media
title: 本地语音与视频分析
description: MTNode 里要「听音频 / 做字幕 / 看视频」时用本机能力：audio_subtitle 出字幕条（cues + SRT/VTT 文本），audio_transcribe 走官方本地 SenseVoice 出逐字稿，ffmpeg 工具做探测 / 抽音轨 / 抽帧 / 任意转码，describe 一次返回画面描述；用户要把转写「落在画布上」时指到工具库内置工具「音频转字幕（时间轴）」（工具壳，参数在壳内的 JSON 文本节点，同一内核的 mtnode.subtitle）。不要另装 whisper / Qwen-ASR / 在线 ASR，也不要自己下载 ffmpeg。Use when the task needs subtitles with per-line timing, speech-to-text, audio/video probing, frame extraction, or video content analysis inside MTNode.
---

# 本地语音与视频分析（先看这里，别另找方案）

MTNode 的 Agent 自带三个本机媒体工具。**需要听音频、做字幕、看视频内容时，先用它们**；
不要为此安装 whisper / Qwen-ASR / 在线 ASR，也不要下载 ffmpeg 或写 Python 转写脚本。

## 三个工具

| 工具 | 用途 |
| --- | --- |
| `audio_subtitle` | 音频 / 视频 → **字幕条**：`cues[{index,start,end,text}]` + 整份 `srt` / `vtt` 文本（不写文件） |
| `audio_transcribe` | 音频 / 视频 → 逐字稿（视频自动抽音轨）。内部按静音切句，返回全文 + `segments[{start,end,text}]` |
| `ffmpeg` | `probe` 探测、`extract_audio` 抽 16k WAV、`frames` 抽帧 PNG、`describe` 抽帧 + 识图返回画面描述、`run` 任意参数 |

SenseVoice **不返回词级时间戳**（provider 只给整段文本与时长），两个转写工具的时间轴都来自
ffmpeg 静音切句，属切片级近似。所以「要字幕」直接用 `audio_subtitle`，不要拿 `segments` 自己拼时间码。

## 做字幕（最常见的场景）

1. 直接 `audio_subtitle` 传视频或音频的**绝对路径**（长文件不用自己切，工具内部切片拼接）。
2. 返回里 `cues` 是已经排好版的字幕条（每条一行、已断句、已限长），`srt` / `vtt` 是完整字幕文本。
3. 要落盘就自己把 `srt` / `vtt` 文本写进工作区文件（本工具**不写文件**，写文件工具有自己的护栏）。
4. 常用参数：`maxDurationSec`（单条最长秒数，默认 6）、`maxChars`（默认中文 18 / 英文 42，自动判）、
   `noiseDb`（静音阈值，默认 -35dB）、`minSilenceSec`（默认 0.4 秒）、`breakPunctuation`（断句标点集）、
   `script`（**原台词**，可选：给了就走切分模式，正文从台词里逐字截取，避免识别错字；对不上的进
   `unmatchedScript` / `unmatchedAsr` 清单）、`keepPunctuation`（保留标点：默认 `false` 只去掉句末句号，
   `true` = 标点一律原样不动）。
5. 只要逐字稿或要做别的文本处理：用 `audio_transcribe`。
6. 想要更细的句子：先用 `ffmpeg` 的 `extract_audio` 抽 16k WAV，再用 `run` 截取区间分段转写。

**要「落在画布上」**（用户想让转写变成画布上的一个节点、或要批量 / 定时跑）：
让用户在顶栏 **工具库** 里插入内置工具 **「音频转字幕（时间轴）」**——外侧输入 **音频** / **视频**
（视频自动抽音轨）、外加两个可选文本端子 **原台词** / **参数**：接上原台词即切分模式（正文取台词），
「参数」端子接一份 JSON 按键覆盖壳内设置。内部设置写在壳里那颗 **「转写参数」文本节点**的 JSON
（`language` / `maxDurationSec` / `maxChars` / `noiseDb` / `minSilenceSec` / `keepPunctuation`，
不写就用默认），三个输出端子 **字幕数据 / SRT / VTT**，挂一条「保存文本」就落成 `.srt` / `.vtt`。
文件只认媒体端子 —— 参数 JSON 里写 `file` 不生效。
这条内置工具就是 `audio_subtitle` 同一份内核的工具节点版（`mtnode.subtitle`），**不要**为此另写
转写脚本、也不要叫用户去装别的 ASR。Agent 自己跑不了画布（不建节点、不点运行），这类需求把
「工具库 → 音频转字幕 → 接音频或视频端子 → （可选）接原台词 / 参数 → 展开壳改转写参数 → 保存文本」
这条路径说清楚即可。

## 看视频内容

- `ffmpeg` + `action:"describe"`：默认均匀抽 7 帧（上限 12 帧、单帧宽 ≤ 1280），逐帧转调宿主识图
  （与 `mtnode_vision` 同一条视觉路由与许可），一次返回每个时间点的描述。
- 需要指定时间点就传 `times:[秒,…]`；只想要图片就 `action:"frames"`，再把路径交给 `mtnode_vision`。
- 用户问「视频里有什么 / 这一段在干什么 / 封面用哪一帧」时，走这条链路，不要靠猜。

## 画布侧的同一个能力

| 位置 | 是什么 |
| --- | --- |
| 工具库 → **音频转字幕（时间轴）** | 内置**工具条目**（工具壳 + 内部子图：JSON 参数文本节点 + 函数节点），外侧端子 **音频**(audio) / **视频**(video) / **原台词**(text，可选) / **参数**(text，可选) → **字幕数据 / SRT / VTT**；内部设置在壳内「转写参数」文本节点的 JSON（`language` / `maxDurationSec` / `maxChars` / `noiseDb` / `minSilenceSec` / `keepPunctuation`），「参数」端子上的 JSON 按键覆盖同键；接上原台词即切分模式（正文取台词） |
| 函数节点里的 `mtnode.subtitle(...)` | 同一个内核的桥（自己写函数节点时直接调，参数与返回同上） |
| Agent 工具 `audio_subtitle` | 会话里的同名能力（排版内核与画布工具共用一份，口径不会走偏） |

三者都**不写文件**（`mtnode.subtitle` 只回文本，落盘交给保存节点 / 写文件工具），都要求 ffmpeg。

## 依赖与失败处理

- 转写用运行时内的**官方本地 SenseVoice**（CPU、离线，与麦克风听写同一份权重）。
  **自动启用，不要让用户手动启用 / 手动下载**：语音运行时按需拉起，权重首次使用自动下载
  （约 239MB，断点续传），识别器还没注册好或报「还没就绪」时工具会自己等 / 自动重试一次；
  这次调用会等到就绪（可能几分钟），之后都是秒级。别让用户先去设置里「启用」什么。
- `ffmpeg` 的解析顺序：系统 PATH → Remotion 安装目录（装 Remotion 时自带）→ 其它本地后端便携目录。
  **找不到时工具会报错并提示去插件里安装 Remotion**：把这句话转告用户，等装好再重试，
  不要自己下载 ffmpeg、也不要换别的转码库。
- 纯净模式 / 桌宠隔离态没有这些工具与语音服务：如实说明，别绕路。

## 护栏（会被拒绝的写法）

- `run` 的 `args` 必须是**参数数组**（不含 `ffmpeg` 本身），不经 shell。
- 输出必须落在可写范围：本轮工作区 / MTNode 数据目录 / 系统临时目录；工作区外的既有文件只能当输入读。
- 不默认 `-y`：要覆盖已有文件必须显式 `overwrite:true`。
- 单次上限：2 小时 / 1GB（`allowLarge:true` 放宽）；`run` 默认 120 秒超时（`timeoutSec` 上限 600）。
- 别把整段长视频逐帧塞进识图：`describe` 最多 12 帧，需要更多就分多次按时间点调用。
