---
name: film-post-qc
title: 成片质检与自动检测
description: 成片交付前的可勾选体检：黑帧、静帧、爆音削波、字幕错位、响度、尺寸时长、首帧钩子，逐项给自动检测命令与通过阈值，附问题到修法的映射。导出后、上传前用。
tags: 质检, 黑帧, 静帧, 响度, 字幕, 首帧, 交付验收
version: 1.0.0
---

# 成片质检与自动检测

## 何时用

- 成片已导出，上传平台或交给客户之前，需要一份能签字的体检结论。
- 播放时看到一闪而过的黑场、卡住的画面、破音，或观众反馈「字幕对不上」「声音忽大忽小」。
- 同一支片出了多平台版本，要逐版本核对尺寸、时长、码率、音轨。
- 需要把「看着没问题」变成可复现的证据：命令、输出、阈值、结论。
- 上游素材由生成模型产出，需要确认没有畸形手、乱码文字、闪烁帧混进成片。
- 不适用：还在剪（用 `film-edit-narrative`）；改编码参数（用 `film-edit-ffmpeg`）；定平台规格（用 `film-deliver-platform`）。

## 核心原则

1. **在编码后的成片上检，不在工程里检**。预览正常不代表渲染正常；所有检测命令的输入必须是最终交付文件。
2. **每条结论都要有命令与原始输出**。写「响度没问题」不算结论；写「`I=-14.3 LUFS`、`TP=-1.2 dBTP`，阈值 −14±1／≤−1.0，通过」才算。
3. **先自动化、再人眼**。黑帧、静帧、削波、响度、时长、帧数全部脚本判定；人只看自动化指出的时间点与首帧钩子。
4. **黑帧与静帧要看上下文再判**。片头淡入、刻意的定格、转场黑场是设计；只有「非设计且超过阈值」才算缺陷。
5. **字幕按语音起点对齐，不按感觉对齐**。每条 cue 的入点与对应语音起点偏差 > 0.3 秒即失败；字幕出画、压脸、被 UI 遮挡同样算失败。
6. **响度看两个数**：积分响度与真峰。只报 LUFS 不报 TP 的质检不完整；TP 超 −1.0 dBTP 会在平台转码后爆音。
7. **一次不通过只修一类问题**。同时改画面、字幕、混音会失去对照；每轮只改一类，重渲染后重跑全套。
8. **交付件与母版分开留档**。质检报告绑定具体文件哈希；文件被替换后旧报告作废，不沿用。

## 工作流

1. **锁定受检文件**。输入：待交付文件。动作：记录路径、字节数、SHA-256、导出时间与所用参数。产出：报告头（文件名／哈希／版本）。
2. **容器与规格核对**。输入：文件。动作：`ffprobe` 读分辨率、帧率、像素格式、时长、音轨、码率；与平台表逐项比对。产出：规格核对表，任一不符即失败。
3. **画面自动检测**。输入：文件。动作：跑 `blackdetect`、`freezedetect`、解码错误扫描、帧数统计。产出：时间点清单（黑帧区间、静帧区间、解码报错）。
4. **声音自动检测**。输入：文件。动作：跑 `ebur128`（响度＋真峰）、`astats`（峰值／直流偏移）、`silencedetect`（异常长静音）。产出：LUFS／TP／峰值／静音区间数值。
5. **字幕与同步核查**。输入：文件 + 字幕。动作：按每条 cue 的入点抽帧确认文字已出现、内容正确、未出画；用语音起点对比偏差。产出：错位清单（cue 编号／应有时间／实际时间／偏差）。
6. **首帧与内容人眼复核**。输入：0–5 秒抽帧 + 全片联系表。动作：确认首帧不是黑场／空白，3 秒内出现痛点或亮点，5 秒内有第一个高能点；检查畸形、乱码、闪帧、遮挡。产出：内容问题清单（时间码 + 具体现象）。
7. **出具报告与修复**。输入：以上全部。动作：按模板 4 填报告，每条问题给「症状 → 原因 → 修法 → 复检命令」；修完重跑第 2–6 步。产出：`qc-report.md` 与通过／不通过结论。

## 关键参数与模板

### 1. 可勾选检查表

| # | 检查项 | 通过标准 | 检测方式 |
| --- | --- | --- | --- |
| 1 | 容器可解码 | `ffmpeg -v error -i final.mp4 -f null -` 无输出 | 自动 |
| 2 | 分辨率 | 与平台表一致、宽高为偶数 | `ffprobe` |
| 3 | 帧率 | `r_frame_rate == avg_frame_rate`，30／1 或 60／1 | `ffprobe` |
| 4 | 时长 | 与计划误差 ≤ 0.1 秒，不超平台上限 | `ffprobe` |
| 5 | 帧数 | 与时间线帧数一致（误差 0） | `ffprobe -count_frames` |
| 6 | 像素格式 | `yuv420p`（HDR 为 `yuv420p10le`） | `ffprobe` |
| 7 | 音轨 | 存在、`aac`、48000 Hz、2 声道 | `ffprobe` |
| 8 | 音画起点 | `abs(audio.start_time − video.start_time) ≤ 0.02` 秒 | `ffprobe` |
| 9 | 黑帧 | 非设计黑场 ≤ 0.4 秒；片头黑场 ≤ 0.5 秒 | `blackdetect` |
| 10 | 静帧 | 非设计静帧 ≤ 1.0 秒 | `freezedetect` |
| 11 | 爆音／削波 | 采样峰值 ≤ −0.1 dBFS，`Flat_factor` 无连续异常 | `astats` |
| 12 | 响度 | `I = −14 ±1 LUFS` | `ebur128`／`loudnorm` |
| 13 | 真峰 | `TP ≤ −1.0 dBTP` | `ebur128` |
| 14 | 异常静音 | 无 ≥ 3 秒的非设计静音 | `silencedetect` |
| 15 | 字幕入点 | 每条 cue 与语音起点偏差 ≤ 0.3 秒 | 抽帧 + 转写对照 |
| 16 | 字幕安全区 | 全部文字在安全矩形内，不出画、不压脸 | 抽帧叠参考线 |
| 17 | 首帧 | 0 秒不是黑场／空白／纯色 | 抽帧 |
| 18 | 钩子 | 3 秒内出现痛点或亮点，5 秒内有高能点 | 抽帧 + 人眼 |
| 19 | 内容瑕疵 | 无畸形、乱码文字、闪帧、意外水印 | 联系表 + 逐段看 |
| 20 | 平台参数 | 码率、体积、封面、字幕形态符合平台表 | 换算 + 核对 |

### 2. 自动检测命令

```bash
# 1 解码错误（有输出即失败）
ffmpeg -v error -i out/final.mp4 -f null -

# 2–7 规格
ffprobe -v error -select_streams v:0 -show_entries stream=codec_name,profile,width,height,pix_fmt,r_frame_rate,avg_frame_rate,bit_rate -of default=nw=1 out/final.mp4
ffprobe -v error -select_streams a:0 -show_entries stream=codec_name,sample_rate,channels,start_time -of default=nw=1 out/final.mp4
ffprobe -v error -show_entries format=duration,size,bit_rate -of default=nw=1 out/final.mp4
ffprobe -v error -select_streams v:0 -show_entries stream=start_time -of default=nw=1 out/final.mp4

# 5 精确帧数
ffprobe -v error -count_frames -select_streams v:0 -show_entries stream=nb_read_frames -of csv=p=0 out/final.mp4

# 9 黑帧（0.4 秒、像素阈值 0.10）
ffmpeg -hide_banner -i out/final.mp4 -vf "blackdetect=d=0.4:pix_th=0.10" -an -f null - 2>&1 | Select-String "black_start"

# 10 静帧（噪声容差 -60dB、持续 1.0 秒）
ffmpeg -hide_banner -i out/final.mp4 -vf "freezedetect=n=-60dB:d=1.0" -an -f null - 2>&1 | Select-String "freeze_start|freeze_end|freeze_duration"

# 11 峰值与直流偏移
ffmpeg -hide_banner -i out/final.mp4 -af "astats=metadata=1:reset=0" -f null - 2>&1 | Select-String "Peak level|Flat factor|DC offset"

# 12–13 响度与真峰（取 Summary 里的 I / LRA / Peak）
ffmpeg -hide_banner -i out/final.mp4 -filter_complex "ebur128=peak=true" -f null - 2>&1 | Select-String "I:|LRA:|Peak:"

# 14 异常静音（-50dB、1 秒以上全部列出，人工筛 ≥3 秒）
ffmpeg -hide_banner -i out/final.mp4 -af "silencedetect=noise=-50dB:d=1.0" -f null - 2>&1 | Select-String "silence_start|silence_end|silence_duration"

# 17 首帧与 0.5 秒间隔抽帧
ffmpeg -y -i out/final.mp4 -vf "fps=2" -frames:v 8 -q:v 2 out/qc/first_%02d.jpg

# 19 联系表（每 2 秒一帧）
ffmpeg -y -i out/final.mp4 -vf "fps=1/2,scale=320:-2,tile=4x3" -frames:v 1 out/qc/sheet.jpg

# 16 安全区参考线（竖屏）
ffmpeg -y -ss 1.000 -i out/final.mp4 -frames:v 1 -vf "drawbox=x=120:y=240:w=780:h=1020:color=yellow@0.9:t=4" -q:v 2 out/qc/safe.png
```

- 完整命令与判读（含 A/V 同步、字幕逐条比对、体积换算）见 `references/qc-commands.md`。
- Windows PowerShell 用 `Select-String`；bash 用 `grep -E`。管道过滤只影响可读性，不影响判定。

### 3. 判定阈值

| 指标 | 通过 | 警告 | 失败 |
| --- | --- | --- | --- |
| 非设计黑场 | ≤ 0.4 秒 | 0.4–0.8 秒 | > 0.8 秒 |
| 非设计静帧 | ≤ 1.0 秒 | 1.0–1.5 秒 | > 1.5 秒，或出现在动作中 |
| 采样峰值 | ≤ −0.5 dBFS | −0.5–−0.1 dBFS | > −0.1 dBFS（削波） |
| 积分响度 | −14 ±1 LUFS | ±1–2 LUFS | 超出 ±2 LUFS |
| 真峰 | ≤ −1.0 dBTP | −1.0–−0.5 dBTP | > −0.5 dBTP |
| 字幕偏差 | ≤ 0.2 秒 | 0.2–0.3 秒 | > 0.3 秒 |
| 音画起点差 | ≤ 0.02 秒 | 0.02–0.05 秒 | > 0.05 秒 |
| 时长误差 | ≤ 0.1 秒 | 0.1–0.3 秒 | > 0.3 秒 |
| 黑帧出现在 0 秒 | 允许 ≤ 0.5 秒淡入 | 0.5–1.0 秒 | > 1.0 秒或纯黑起片 |

- 这些阈值是交付基线；平台或客户有更严规格时以更严者为准。
- 艺术性定格、片头淡入、刻意黑场要写进报告「设计豁免」，并给出时间码，便于复核。

### 4. 报告模板

```markdown
# 成片质检报告

- 文件：out/deliver/douyin_1080x1920.mp4
- 大小：24.8 MB　SHA-256：3f9c…a71
- 导出参数：libx264 / crf 20 / medium / aac 192k / 30fps
- 检测时间：2026-11-04 15:20

[规格]
| 项 | 实测 | 要求 | 结论 |
| --- | --- | --- | --- |
| 分辨率 | 1080x1920 | 1080x1920 | 通过 |
| 帧率 | 30/1 = 30/1 | 30/1 | 通过 |
| 时长 | 62.04 s | ≤ 600 s，计划 62.0 s | 通过 |
| 像素格式 | yuv420p | yuv420p | 通过 |
| 音频 | aac / 48000 / 2 | 同 | 通过 |
| 码率 | 9.4 Mbps | 8–12 Mbps | 通过 |

[画面]
- 黑帧：无（blackdetect d=0.4 pix_th=0.10 无输出）
- 静帧：00:00:41.2–00:00:42.6（1.4 s，非设计）→ 失败，见问题 1
- 解码错误：无

[声音]
- 响度：I=-14.3 LUFS，LRA=6.8 LU，TP=-1.2 dBTP → 通过
- 峰值：-1.2 dBFS，无削波
- 异常静音：00:00:58.0–00:00:59.4（1.4 s，片尾留白，设计豁免）

[字幕]
- 共 32 条，入点偏差最大 0.18 s（第 12 条）→ 通过
- 安全区：全部在 x=120–900 / y=240–1260 内

[内容]
- 首帧：人物中景 + 标题，非黑场 → 通过
- 钩子：00:00:01.5 出现「三秒后灯全灭」→ 通过
- 瑕疵：无畸形手、无乱码文字

[问题与修法]
1. 00:00:41.2–00:00:42.6 静帧 1.4 s（原因：AI 生成段尾帧重复）→ 换该段最后 0.8 s 或加 0.4 s 叠化，重渲染后复跑 freezedetect。

[结论] 不通过（1 项待修）
```

### 5. 症状到修法

| 症状 | 常见原因 | 修法命令／动作 |
| --- | --- | --- |
| 一闪黑帧 | 拼接处缺帧、转场黑场过长 | 抽该区间帧定位；用 `trim` 去掉空段，或把黑场改成 0.3 秒叠化 |
| 画面卡住 1 秒以上 | 生成段重复帧、变速后帧复制 | 重生成该段，或裁掉重复区间并补 0.3 秒 B-roll |
| 破音／爆音 | 混音叠加超 0 dBFS、真峰未控 | 整体 `volume=-2dB` 后重跑 `loudnorm`，TP 设 −1.5 |
| 字幕整体晚 0.5 秒 | 转场消耗时长未计入 | 按新时间线整体平移字幕，不逐条挪 |
| 单条字幕错位 | cue 切分与语音不同步 | 该条入点对齐语音起点，出点留 0.2 秒余量 |
| 响度偏低 | 只做了峰值归一，没做积分响度 | 两遍 `loudnorm`，目标 `I=-14:TP=-1.0:LRA=11` |
| 音画不同步 | VFR 源未转 CFR、拼接混帧率 | 归一化 `-fps_mode cfr -r 30` 后重拼 |
| 首帧是黑场 | 片头淡入过长 | 剪掉前 0.5 秒，或把首帧换成有信息的画面 |

## 常见坑

- **症状：`ffmpeg -v error` 没有任何输出，就断定文件没问题。** 原因：只证明能解码，不证明画面对。修法：解码扫描只是第 1 项，必须继续跑黑帧／静帧／响度／抽帧。
- **症状：`freezedetect` 报了一堆静帧，其实都是刻意的定格。** 原因：没区分设计与缺陷。修法：把刻意定格的时间码列进「设计豁免」，其余按阈值判失败。
- **症状：本地听没问题，上传后爆音。** 原因：真峰超过 −1.0 dBTP，平台转码叠加。修法：`loudnorm` 把 TP 压到 −1.5，重测 `ebur128` 的 Peak。
- **症状：`ebur128` 的 I 值和 `loudnorm` 测出来差 1–2 LU。** 原因：测量窗口与门限不同（前者整段、后者按 EBU R128 门限）。修法：以交付工具链的 `loudnorm` 两遍值为准，报告里注明用哪条命令测的。
- **症状：抽帧看字幕都在，播放时却有一条闪了一下。** 原因：抽帧间隔 2 秒，漏掉了 0.3 秒的短 cue。修法：在可疑区间按 0.25 秒抽帧，或直接按 cue 时间逐条抽。
- **症状：报告写「已修复」，复检仍失败。** 原因：修的是工程，检的是旧文件。修法：报告绑定 SHA-256；文件变了就作废旧报告，从第 2 步重跑。

## 来源与合并说明

| 上游仓库 | ★ | 许可 | 贡献内容 |
| --- | --- | --- | --- |
| kajisho5/ffmpeg-skill | 4475 | MIT | 黑帧／静帧／响度／真峰的检测口径与阈值思路、`loudnorm` 门限说明、BT.709 与 HDR 的验收差异、按平台复核响度 |
| Bomx/super-video-maker-skill | 331 | 无许可证 | `ffmpeg_qc.py` 的检查骨架（probe → blackdetect → 音轨／编码告警）、交付前抽帧复核 |
| liyupi/ai-promo-video-maker | 435 | MIT | 可勾选审图清单、1 秒间隔抽帧查「无新信息」、渲染日志报错即失败、响度与人声压乐 8 dB 的验收 |
| wuwangzhang1216/DirectorSKILL | 311 | MIT | 三道质量门（PRE／POST／SEQUENCE）与报告格式、带时间码的缺陷记录、`ALREADY TRIED` 防重复返工 |
| zenstory-ai/video-recap-skills | 601 | MIT | 句界与帧网格对齐的验收口径、字幕与旁白一致性检查、成片为唯一判定标准 |

- 抓取日期：2026-11-04
- 合并的上游技能：kajisho5/ffmpeg-skill（`scripts/check.py`、`references/gotchas.md` 音频章节）、Bomx `tools/ffmpeg_qc.py`、liyupi `references/校验清单.md`、DirectorSKILL `assets/qc-checklist.md`、zenstory `video-cut` 验收章节
- 冲突与取舍：Bomx 的 `ffmpeg_qc.py` 只查黑帧与容器，liyupi 的清单偏审图，本技能把两者合成「自动 20 项 + 人眼 3 项」的一条主线；响度口径保留 kajisho5 的「LUFS 与真峰必须同时看」，并把 liyupi 的「人声高出音乐 ≥ 8 dB」作为混音阶段的前置检查而非成片阈值。无许可证仓库只取检测流程事实，未复制其代码。
