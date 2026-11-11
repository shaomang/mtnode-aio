---
name: film-deliver-platform
title: 平台交付规格与多版本导出
description: 按抖音、视频号、小红书、B站、YouTube 的画幅、时长、码率、封面与字幕策略出片，给一份母版导出多版本的完整参数表与命令。成片要投平台、或被二压糊掉、封面被裁时用。
tags: 交付, 平台规格, 多版本导出, 封面, 字幕, 码率, 安全区
version: 1.0.0
---

# 平台交付规格与多版本导出

## 何时用

- 母版已定稿，要按平台出竖屏／横屏／方版多套文件，并保证每套都过审、不被二压糊掉。
- 要确认某个平台的分辨率、帧率、时长上限、码率区间、音频响度与封面尺寸。
- 上传后被平台裁掉标题、字幕被 UI 遮住、封面比例不对。
- 同一支片要同时发抖音、视频号、小红书、B站、YouTube，需要一次导出多版本而不是逐条手调。
- 要决定字幕是烧录、挂软轨还是交给平台自动识别。
- 不适用：还在剪内容（用 `film-edit-narrative`）；只做编码参数取舍（用 `film-edit-ffmpeg`）；成片体检（用 `film-post-qc`）。

## 核心原则

1. **母版与交付件分离**。先出 ProRes 422 HQ 或 CRF 18 的母版（`out/master.mov`），所有平台版本从母版派生；不要从上一个平台的压缩件再压。
2. **一个平台一个文件，不靠平台自动裁**。9:16、3:4、16:9 各自单独构图导出；中心裁切不是第二个构图，标题与字幕要按新画幅重排。
3. **码率给平台「二压前的舒适区」**。1080p 给 8–12 Mbps，1080p60 给 12–16 Mbps，4K 给 35–50 Mbps；低于 6 Mbps 的平台会先降清晰度再降码率。
4. **响度统一到 `-14 LUFS`、真峰 `≤ -1.0 dBTP`**。不按平台分别调；个别平台有自己的响度归一，交付前用 `loudnorm` 两遍法实测一次即可。
5. **字幕按观看场景选形态**：竖屏信息流（抖音／视频号／小红书）默认烧录，因为大量用户静音观看；横屏长视频（B站／YouTube）挂软字幕并保留可编辑 SRT。
6. **文字必须落在安全区内**。9:16 在 1080×1920 下，左右各留 120／180 px，顶部 240 px，底部 660 px 不放关键文字；标题放上方留白，字幕放下方留白。
7. **封面单独出，不从视频里截了就算**。每个平台按自己的比例导出（3:4、16:10、16:9），封面上的字要在手机缩略图尺寸下仍可读。
8. **交付前逐版本核对参数**。分辨率、帧率、时长、音轨、像素格式、`faststart` 六项全对才算完成；只核对一个版本等于没核对。

## 工作流

1. **锁定母版**。输入：定稿时间线。动作：导出 `out/master.mov`（ProRes 422 HQ，`yuv422p10le`，PCM 48 kHz）与 `out/master.mp4`（H.264 CRF 18）。产出：两个母版 + `ffprobe` 记录。
2. **定平台清单**。输入：投放计划。动作：为每个平台写一行：画幅、分辨率、帧率、时长上限、码率、音频、封面尺寸、字幕形态。产出：`out/delivery-plan.md`（可直接抄 `references/platform-specs.md` 的表）。
3. **重构图，不是缩放**。输入：母版。动作：竖屏重排标题与字幕位置，横屏保留原有构图；需要裁切时先确认主体与字幕都在安全区内。产出：每个画幅一份构图确认帧（首帧、中段、末帧）。
4. **批量导出**。输入：母版 + 参数表。动作：按模板 2 的命令逐版本转码，文件名带画幅与平台。产出：`out/deliver/douyin_1080x1920.mp4` 等。
5. **字幕与封面**。输入：字幕文件 + 封面帧。动作：竖屏烧录（带描边、底部留 58 px 边距），横屏挂 `mov_text` 软轨；封面按平台比例裁切并压字。产出：烧录版视频、`out/subs/*.srt`、各平台 `cover_*.jpg`。
6. **响度统一**。输入：各版本音频。动作：对每个版本跑 `loudnorm` 两遍法，目标 `I=-14:TP=-1.0:LRA=11`。产出：响度一致的交付件 + 实测 LUFS／TP 数值。
7. **逐版本核对**。输入：交付件。动作：`ffprobe` 六项核对 + 实际码率换算 + 首末帧抽帧看安全区 + 播放器试播。产出：核对表（版本／分辨率／帧率／时长／码率／LUFS／结论）。
8. **打包交付**。输入：核对通过的版本。动作：按平台建子目录，附 `delivery-plan.md`、字幕源文件、封面、参数记录。产出：可一次性上传的交付包。

## 关键参数与模板

### 1. 平台对照表（摘要）

| 平台 | 画幅／分辨率 | 帧率 | 时长上限 | 视频 | 音频 | 封面 | 字幕 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 抖音 | 9:16／1080×1920 | 30 | 按账号权限（常见 15 分钟） | H.264 High，8–12 Mbps | AAC 192k／48 kHz | 1080×1440（3:4） | 烧录 |
| 视频号 | 9:16／1080×1920 或 6:7／1080×1260 | 30 | 30 分钟 | H.264 High，6–10 Mbps | AAC 192k／48 kHz | 1080×1260 | 烧录 |
| 小红书 | 3:4／1080×1440（首选）或 9:16 | 30 | 15 分钟 | H.264 High，5–8 Mbps | AAC 192k／48 kHz | 1080×1440 | 烧录 |
| B站 | 16:9／1920×1080 | 30 或 60 | 单文件 ≤ 8 GB | H.264 High，6–8 Mbps | AAC 320k／48 kHz | 1146×717 | 软轨 + 可选烧录 |
| YouTube | 16:9／1920×1080（4K 3840×2160） | ≤ 60 | 12 小时 | H.264 High，12–16 Mbps | AAC 192k／48 kHz | 1280×720 | 软轨（多语言） |
| TikTok | 9:16／1080×1920 | 30 | 600 秒 | H.264 High，8–12 Mbps | AAC 128k／48 kHz | 1080×1920 | 烧录 |
| Instagram Reels | 9:16／1080×1920 | 30 | 90 秒 | H.264 High，8–12 Mbps | AAC 128k／48 kHz | 1080×1920 | 烧录 |

- 抖音／视频号／小红书／B站的中文平台数值为**通用经验值**（2026-11 投稿页常见区间），平台规则会变，上传前以投稿页当前提示为准；TikTok／Reels／YouTube 的时长与响度取自上游平台表。
- 完整字段（含最小高度、允许编码、体积上限、响度容差、安全区比例）见 `references/platform-specs.md`。

### 2. 一次导出多版本（参数表）

| 版本 | 分辨率 | 帧率 | 编码 | 质量 | 音频 | 文件名 |
| --- | --- | --- | --- | --- | --- | --- |
| 竖屏主版 | 1080×1920 | 30 | libx264 high | CRF 20／medium | AAC 192k | `douyin_1080x1920.mp4` |
| 6:7 版 | 1080×1260 | 30 | libx264 high | CRF 20／medium | AAC 192k | `shipinhao_1080x1260.mp4` |
| 3:4 版 | 1080×1440 | 30 | libx264 high | CRF 20／medium | AAC 192k | `xiaohongshu_1080x1440.mp4` |
| 横屏版 | 1920×1080 | 30 | libx264 high | CRF 20／slow | AAC 192k | `bilibili_1920x1080.mp4` |
| 4K 版 | 3840×2160 | 30 | libx264 high | CRF 21／slow | AAC 192k | `youtube_2160p.mp4` |

```bash
# 竖屏主版（抖音／视频号／Reels）
ffmpeg -y -i out/master.mov -vf "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1" -c:v libx264 -preset medium -crf 20 -profile:v high -level 4.1 -pix_fmt yuv420p -r 30 -g 60 -c:a aac -b:a 192k -ar 48000 -ac 2 -movflags +faststart out/deliver/douyin_1080x1920.mp4

# 6:7 版（视频号）
ffmpeg -y -i out/master.mov -vf "scale=1080:1260:force_original_aspect_ratio=increase,crop=1080:1260,setsar=1" -c:v libx264 -preset medium -crf 20 -profile:v high -pix_fmt yuv420p -r 30 -g 60 -c:a aac -b:a 192k -ar 48000 -ac 2 -movflags +faststart out/deliver/shipinhao_1080x1260.mp4

# 3:4 版（小红书）
ffmpeg -y -i out/master.mov -vf "scale=1080:1440:force_original_aspect_ratio=increase,crop=1080:1440,setsar=1" -c:v libx264 -preset medium -crf 20 -profile:v high -pix_fmt yuv420p -r 30 -g 60 -c:a aac -b:a 192k -ar 48000 -ac 2 -movflags +faststart out/deliver/xiaohongshu_1080x1440.mp4

# 横屏版（B站／YouTube）
ffmpeg -y -i out/master.mov -vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1" -c:v libx264 -preset slow -crf 20 -profile:v high -level 4.1 -pix_fmt yuv420p -r 30 -g 60 -c:a aac -b:a 192k -ar 48000 -ac 2 -movflags +faststart out/deliver/bilibili_1920x1080.mp4

# 4K 版（YouTube）
ffmpeg -y -i out/master.mov -vf "scale=3840:2160:force_original_aspect_ratio=decrease,pad=3840:2160:(ow-iw)/2:(oh-ih)/2,setsar=1" -c:v libx264 -preset slow -crf 21 -profile:v high -level 5.1 -pix_fmt yuv420p -r 30 -g 60 -c:a aac -b:a 192k -ar 48000 -ac 2 -movflags +faststart out/deliver/youtube_2160p.mp4
```

- 要卡平台体积上限时，把 `-crf` 换成 `-b:v 10M -maxrate 12M -bufsize 20M`。
- 竖屏用 `increase + crop`（裁满不留黑边）；横屏用 `decrease + pad`（保留完整画面）。
- 每个版本导出后立刻抽首帧确认主体没被裁掉，再看末帧 CTA 是否完整。

### 3. 封面

```bash
# 抖音 3:4
ffmpeg -y -ss 2.000 -i out/master.mov -frames:v 1 -vf "scale=1080:1440:force_original_aspect_ratio=increase,crop=1080:1440" -q:v 2 out/cover/douyin_cover.jpg

# 小红书 3:4
ffmpeg -y -ss 2.000 -i out/master.mov -frames:v 1 -vf "scale=1080:1440:force_original_aspect_ratio=increase,crop=1080:1440" -q:v 2 out/cover/xhs_cover.jpg

# B站 16:10
ffmpeg -y -ss 2.000 -i out/master.mov -frames:v 1 -vf "scale=1146:717:force_original_aspect_ratio=increase,crop=1146:717" -q:v 2 out/cover/bilibili_cover.jpg

# YouTube 16:9
ffmpeg -y -ss 2.000 -i out/master.mov -frames:v 1 -vf "scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720" -q:v 2 out/cover/youtube_cover.jpg
```

- 封面文字单个字高 ≥ 画面高度的 5%（1080 宽时 ≥ 54 px），最多 2 行、每行 ≤ 8 个汉字。
- 封面上的承诺必须与成片兑现位置一致；不写片子里没有的数字。

### 4. 字幕策略

| 平台 | 形态 | 理由 | 做法 |
| --- | --- | --- | --- |
| 抖音／视频号／小红书 | 烧录 | 信息流大量静音观看 | ASS 烧录，字号按画幅高度 4–5%，底部 `MarginV=58` |
| B站 | 软轨 + 可选烧录 | 用户可开关，审核与二创友好 | `mov_text` 或 SRT 外挂 + 简介区 |
| YouTube | 软轨、多语言 | 可自动翻译、可搜索 | 上传 SRT／VTT，主语言 `language=chi` |

```bash
# 竖屏烧录（1x1 以外的画幅都要重设字号与边距）
ffmpeg -y -i out/deliver/douyin_1080x1920.mp4 -vf "subtitles=out/subs/zh.ass:fontsdir=fonts" -c:v libx264 -preset medium -crf 20 -pix_fmt yuv420p -c:a copy out/deliver/douyin_subbed.mp4

# 横屏软轨
ffmpeg -y -i out/deliver/bilibili_1920x1080.mp4 -i out/subs/zh.srt -map 0 -map 1 -c copy -c:s mov_text -metadata:s:s:0 language=chi out/deliver/bilibili_softsub.mp4
```

### 5. 安全区核查

9:16／1080×1920 的文字安全矩形为 `x=120–900, y=240–1260`（由 720×1280 模板的 80／120／160／440 边距等比换算）。核查时叠一层参考线抽帧：

```bash
ffmpeg -y -ss 1.000 -i out/deliver/douyin_1080x1920.mp4 -frames:v 1 -vf "drawbox=x=120:y=240:w=780:h=1020:color=yellow@0.9:t=4,drawbox=x=0:y=1260:w=1080:h=660:color=red@0.35:t=fill" -q:v 2 out/check/safe_9x16.png
```

- 标题放上方留白（约 `y=560`），字幕放下方留白（1080×1920 约 `y=1500–1560`），左右边距非对称 120／180，给右侧操作栏留空间。
- 长句换行后仍要整体在安全矩形内；超过两行就改文案或拆 cue，不要缩到不可读。

## 常见坑

- **症状：上传后标题被头像和文案挡住。** 原因：按 16:9 的边距做竖屏字幕。修法：按 9:16 安全矩形重排，底部 660 px 不放关键文字，抽帧核对后再导出。
- **症状：平台播放明显比本地糊，尤其文字边缘。** 原因：码率低于 6 Mbps 或 CRF 给到 26 以上，平台二压叠加。修法：1080p 提到 8–12 Mbps（或 CRF 20），文字层单独加 1 px 描边。
- **症状：抖音版和 B站版「像两支不同的片子」。** 原因：只做了中心裁切，没有为重构图重排标题。修法：每个画幅单独排文案与字幕位置，裁切后抽首／中／末三帧复核。
- **症状：封面在信息流里被裁掉半边字。** 原因：用了 16:9 封面投 3:4 位。修法：按平台比例单独导出封面，字放在中间 80% 区域内。
- **症状：B站上传后没有字幕轨。** 原因：软字幕封装成 `mov_text` 但容器是 MKV，或播放器默认关闭字幕。修法：交付用 MP4 + `mov_text`，同时在简介区提供 SRT；不要只依赖内嵌轨。

## 来源与合并说明

| 上游仓库 | ★ | 许可 | 贡献内容 |
| --- | --- | --- | --- |
| kajisho5/ffmpeg-skill | 4475 | MIT | 平台表字段与取值（TikTok 600 秒、Reels 90 秒、Shorts 180 秒、YouTube 12 小时、最小高度 720、`-14 LUFS ±2`、真峰 `-1.0 dBTP`）、交付编码线（H.264 slow CRF 18／社交 medium CRF 20、AAC 128/192k）、安全区比例、封面与字幕默认值 |
| calesthio/OpenMontage | 76149 | AGPL-3.0 | 各平台缩放与补边滤镜写法、TikTok／YouTube／Instagram／Square 的预设分辨率 |
| joeseesun/qiaomu-cut-skill | 377 | MIT | 9:16 安全区的像素换算（720×1280 → 1080×1920）、抖音与 TikTok 的 UI 风险口径、字幕位置与 120／180 非对称边距 |
| liyupi/ai-promo-video-maker | 435 | MIT | 封面与 CTA 停留时长、字幕可读性下限、交付目录与中文命名约定 |

- 抓取日期：2026-11-04
- 合并的上游技能：kajisho5/ffmpeg-skill（`scripts/_platforms.py`、`scripts/export.py`、`templates/reels.json`）、OpenMontage `video-edit` 平台预设、qiaomu-cut `references/social-safe-zones.md`、liyupi `references/校验清单.md` 与 `AGENTS.md` 交付章节
- 冲突与取舍：kajisho5 的 `reels` 预设固定 30fps 且 CRF 20，本技能沿用；OpenMontage 用 `decrease + pad` 出竖屏（留黑边），qiaomu 用裁满，本技能按平台分开写——竖屏裁满、横屏补边，并写明适用场景。中文平台（抖音／视频号／小红书／B站）的时长与码率上游没有一手表，本技能标为「通用经验值」，不与上游数值混列。AGPL-3.0 仓库只取参数事实，未复制代码。
