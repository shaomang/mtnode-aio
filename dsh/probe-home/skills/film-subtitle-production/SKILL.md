---
name: film-subtitle-production
title: 字幕生产：转写·断句·双语·烧录
description: 把音轨做成可交付字幕：ASR 转写取词级时间戳，按语义与每行字数断句，翻译后做 CPS 与最短显示时长校对，再按平台安全区烧录或封装软字幕。做字幕、双语字幕、译制或修时间轴时用。
tags: 字幕, ASR, 断句, 双语, CPS, 烧录, SRT
version: 1.0.0
---

# 字幕生产：转写·断句·双语·烧录

## 何时用

- 成片要配字幕（中文、英文或双语），需要从音轨自动转写。
- 已有 SRT/ASS 但断句难看、一行太长、闪得太快、时间轴对不上。
- 要做译制字幕（原文 + 译文两层）或教学片（再加一层注释）。
- 要决定烧录（burn-in）还是软字幕（mux），以及各平台的安全区与字号。
- 不适用：配音本身（`film-audio-voiceover`）、音效与配乐（`film-audio-sound-design`）、成片响度（`film-audio-loudness`）。

## 核心原则

1. **先转写，再断句，最后翻译**：顺序不能倒；按字数硬切的字幕一定断在词中间。
2. **时间轴用成片输出时间线**：剪后时间，不是原片时间；时间线一改，字幕必须重算。
3. **双约束**：每行字数与每秒字数（CPS）同时满足；只满足一个就会出现「一行太长」或「闪太快」。
4. **最短显示 1.0 s**：不足就并句或延长到下一条之前，不许靠缩字号解决。
5. **断句看语义**：优先在标点、连词、主谓之间断；不许把「在不押单个公司的情况下」切成两半。
6. **翻译是重写不是逐字**：译文按目标语习惯重排，长度向原文靠但以可读为先；数字与专名逐条核对。
7. **先 fit 到交付尺寸，再烧字幕**：在中间尺寸烧完再放大，字会糊。
8. **软字幕优先**：能 mux 就不烧；平台强制或需要固定样式时才 burn。

## 工作流

1. **输入**：成片（或音轨）+ 语言 + 交付平台 + 是否双语。
   动作：抽音轨 `ffmpeg -i final.mp4 -vn -ac 1 -ar 16000 asr.wav`。
   产出：`asr.wav`、`subtitle-brief.md`（语言、平台、双语层数、是否烧录）。
2. **选 ASR**：按语言、时长、是否需要词级时间戳与说话人分离查表（见下）。
3. **转写**：要词级 `words[]`，不要只取整段 `text`；中文要字级时间戳（豆包 `sentences[].words[]`）。
   分支：只拿到粗窗口（如按 6 秒分片的 ASR）→ 只能做「整段一句」字幕，不许伪造成逐词对齐。
4. **清洗**：删口头禅、重复、无意义语气词；保留信息量与人物语气；清洗记录单独存，便于回滚。
5. **断句**：按标点与语义切成 cue，套用每行字数上限（中文 20 字、英文 42 字符），最多 2 行。
6. **翻译（如需要）**：先出译文初稿 → 按 cue 长度压缩 → 数字/专名/术语表核对 → 双语对齐（一条 cue 内两层，不拆成两条时间轴）。
7. **CPS 校对**：算每条 `字数 ÷ 显示时长`，超限就改写或拆 cue；同时检查最短 1.0 s、最长 7 s、相邻重叠。
8. **排版**：按平台安全区定字号、边距、描边；竖屏三层（注释/英文/中文）按固定 y 坐标；导出一份 ASS 作为样式真源。
9. **输出**：软字幕 `ffmpeg -c:s mov_text` 或 `-c:s copy` 封装；烧录 `-vf subtitles=...` 或 `ass=...`。
10. **验收**：抽 3 帧（首条、最长条、双语条）看位置与可读性；`ffprobe` 确认字幕流存在；逐条比对时间轴与音轨。

## 关键参数与模板

### ASR 选型

| 引擎 | 模型 / 接口 | 语言 | 时间戳 | 上限 | 适用 |
| --- | --- | --- | --- | --- | --- |
| ElevenLabs Scribe v2 | `model_id="scribe_v2"` | 90+ | 词级（含 `spacing`/`audio_event`） | 3 GB / 10 h | 多语种、要说话人分离 |
| Azure Fast Transcription | `azure_stt`，multipart POST | 多语种 + 自动识别 | 词级 + `phrases[]` | 单文件约 2 h | 企业合规、批量 |
| 豆包 / MiMo ASR | `mimo-v2.5-asr`、豆包字级 | 中文 | 豆包字级；MiMo 为固定分片粗窗口 | 依服务 | 中文口播、要字级 |
| 本地 whisper 系 | `faster-whisper`、`whisper-cli` | 多语种 | 词级（取决于模型） | 本机算力 | 离线、隐私素材 |

要点：Scribe v2 可传 `keyterms`（最多 100 个）纠正产品名与术语；Azure 有 `diarize` / `max_speakers` / `profanity_filter`（`None|Masked|Removed|Tags`）；`language` 明确时比自动识别更准更快。

### 断句规则

| 规则 | 中文 | 英文 | 说明 |
| --- | --- | --- | --- |
| 每行字数 | ≤ 20 字 | ≤ 42 字符（通用经验值） | 超过就拆；20 字是 16:9 中号字安全上限 |
| 每条行数 | ≤ 2 行 | ≤ 2 行 | 3 行会压画面且读不完 |
| 最短显示 | 1.0 s | 1.0 s | 不足则并句或延到下一 cue 前 |
| 最长显示 | 7 s | 7 s | 超过必须拆（通用经验值） |
| 相邻间隔 | ≥ 80 ms | ≥ 80 ms | 防两条粘成一条（通用经验值） |
| 断点优先级 | 句号 > 问号/感叹号 > 分号 > 逗号 > 连词前 | 同左 + 从句边界 | 不许断在数量词、介词短语中间 |
| 一行一个语义块 | 是 | 是 | 「因为 / 所以」不要分到两行 |

CPS（字符/秒）上限：

| 语言 / 受众 | 舒适 | 上限 | 备注 |
| --- | --- | --- | --- |
| 中文成人 | 5–7 字/秒 | 9 字/秒 | 超过 9 必须改写（通用经验值） |
| 中文口播稿目标 | 5 字/秒 | 7 字/秒 | 译制脚本按此写，7 字/秒开始告警 |
| 英文成人 | 15–17 CPS | 20 CPS | 20 CPS 是行业常用上限（通用经验值） |
| 英文儿童 | 12–14 CPS | 17 CPS | 同上 |

计算与判定：

```text
CPS = 有效字符数（不含空格与标点） ÷ (end - start)
超限处理顺序：删虚词 → 换短同义词 → 拆成两条 cue → 延长显示（不得越过下一条）
```

### 双语三层样式表（1080×1920 竖屏，qiaomu 口径）

| 层 | y（px） | 字号 | 字重 | 内容 |
| --- | ---: | ---: | --- | --- |
| Note（注释/术语） | 560 | 56 | bold | 画面留白处，最多 1 行 |
| English | 1420 | 84 | bold | 原句，允许 2 行 |
| Chinese | 1560 | 66 | bold | 译文，紧随英文下方 |
| 左右边距 | 左 120 / 右 180 | — | — | 右侧留操作栏 |

安全矩形：`x=120–900, y=240–1260`（1080×1920，按 TikTok In-Feed 模板等比换算）。长句换行后整体仍要在矩形内；超过两行就缩文案或拆 cue，不优先缩字号。

平台字幕默认值（按画面高度取比例）：

| 平台 | 字号 | 位置 | 描边 | 安全区（上/下/左/右） |
| --- | ---: | --- | ---: | --- |
| TikTok / Reels / Shorts（9:16） | 8.33% 画面高 | 底部 | 2 | 10%/22%/5%/14%（Reels 8/20/5/12；Shorts 6/18/5/12） |
| YouTube / X / LinkedIn / Facebook | 6.94% 画面高 | 底部 | 2 | 四边 5% |
| 电影感短片 | 5–6% 画面高 | 底部偏上 | 1.5–2 | 四边 5%，克制不抢画面 |

### 字幕文件与命令

```bash
# 软字幕封装（MP4 mov_text，推荐默认）
ffmpeg -i final.mp4 -i subs.srt -map 0 -map 1:0 -c:v copy -c:a copy \
  -c:s mov_text -metadata:s:s:0 language=zho -metadata:s:s:0 title="中文" out.mp4

# 多语字幕（中英各一条流）
ffmpeg -i final.mp4 -i zh.srt -i en.srt -map 0 -map 1 -map 2 \
  -c:v copy -c:a copy -c:s mov_text \
  -metadata:s:s:0 language=zho -metadata:s:s:1 language=eng out.mp4

# 烧录（先 fit 到交付尺寸，再烧）
ffmpeg -i final.mp4 -vf "subtitles=subs.ass:fontsdir=fonts" \
  -c:v libx264 -crf 18 -preset medium -c:a copy out_burn.mp4

# 只改样式烧 SRT（force_style 走 ASS 样式名）
ffmpeg -i final.mp4 -vf "subtitles=subs.srt:force_style='FontName=Noto Sans CJK SC,FontSize=20,Outline=2,MarginV=48'" \
  -c:v libx264 -crf 18 -c:a copy out_burn.mp4
```

`FontSize` 以 ASS 288 行高为基准：`20 ≈ 7% 画面高`，`24 ≈ 8.3%`。找不到中文字形时渲染会缺字或直接失败，先确认字体文件存在，别让 fontconfig 静默替换。

断句与 CPS 细则、CPS 计算脚本见 `references/break-and-cps.md`；三层样式、各平台安全区像素表、ASS 模板与验收清单见 `references/styles-and-platforms.md`。

## 常见坑

- **字幕断在词中间（「可能会被慢慢 / 稀释」）**：按固定字数切 → 先按标点与语义切块，再在块内按字数平衡拆分；单块超长时按「词数」均分，不按字符硬切。
- **一句字幕闪 0.3 秒**：直接用了 ASR 的短片段 → 并到相邻 cue，或延到 1.0 s（且不越过下一条），必要时删掉这条的冗余词。
- **双语字幕对不上**：中英各自一条时间轴 → 一条 cue 内放两层文本（`english` / `chinese` / `note` 字段），共用起止时间。
- **烧完字糊 / 出画**：在中间分辨率烧录后再放大，或先烧后裁 → 先 `fit` 到交付尺寸（如 1080×1920），再烧字幕，最后只做编码。
- **平台 UI 挡住字幕**：只按画面中心排字 → 用安全区表；竖屏底部 18–22% 不放正文，右侧 12–14% 留给操作栏。
- **ASR 文本对但时间轴整体偏移**：拿原片时间当输出时间 → 用剪后时间线重建 `start/end`，再抽首尾两条与音轨比对。

## 来源与合并说明

| 上游仓库 | ★ | 许可 | 贡献内容 |
| --- | --- | --- | --- |
| calesthio/OpenMontage | 76149 | AGPL-3.0 | `speech-to-text`（Scribe v2 参数、`keyterms`、输出结构）、`azure-speech-to-text`（Fast Transcription、`diarize`、`profanity_filter`）、`doubao-tts` 的 `sentences[].words[]` 字级时间戳口径、`ffmpeg` 字幕命令 |
| zenstory-ai/video-recap-skills | 601 | MIT | `video-assemble` 字幕轨契约与断句实现（`max_chars=20`、`max_lines=2`、按标点分块、按字重分配时间）、`video-understanding` 的 ASR 粗窗口边界声明 |
| joeseesun/qiaomu-cut-skill | 377 | MIT | `timeline-schema.md` 双语三层字幕（`english`/`chinese`/`note`）、`social-safe-zones.md` 安全矩形与字号、动态字幕 `segments` 口径 |
| kajisho5/ffmpeg-skill | 4475 | MIT | `caption.py` 的 `--max-lines 2`、`--min-duration 1.0`、字号按画面高取比例、平台安全区与字幕默认值、`--mode burn` 与 `--mode mux` 两条路径 |

- 抓取日期：2026-11-04
- 合并的上游技能：speech-to-text、azure-speech-to-text、doubao-tts、ffmpeg、video-assemble（subtitle-track / core）、video-understanding、qiaomu-cut-skill（timeline-schema / social-safe-zones / styles）
- 冲突与取舍：断句字数上游有两套——`video-assemble` 用「单行 ≤ 20 字、最多 2 行」，`caption.py` 用「字号占画面高比例 + 自动缩字号到不超 2 行」；本技能保留 20 字为**硬上限**，缩字号只在不超上限后用于适配平台安全区，不允许用缩字号换更多字。CPS 数值上游未给统一表，20 CPS / 9 字/秒按行业通用经验值标注，可被项目规范覆盖。
