---
name: film-edit-ffmpeg
title: ffmpeg 剪辑命令工具链
description: 用本机 ffmpeg 完成裁切、拼接、变速、抽帧、转码、加字幕、加音轨与响度归一，给出可直接照抄的完整参数与 CRF／preset／硬件编码取舍。拿到素材要落地成片，或命令跑出黑帧、花屏、音画不同步时用。
tags: ffmpeg, 剪辑, 转码, 抽帧, 字幕, 响度, 编码参数
version: 1.0.0
---

# ffmpeg 剪辑命令工具链

## 何时用

- 已经有一段或几段素材，要把它们剪短、拼起来、变速、抽帧做封面、压成交付文件。
- 要在画面上烧中文字幕，或把 SRT／ASS 作为软字幕轨挂进 MP4。
- 要替换／叠加音轨，做旁白压音乐、整体响度拉到目标值。
- 交付前发现花屏、黑帧、开头停一帧、声音比画面早／晚，需要定位是哪一步命令写错。
- 需要判断「这条命令该用 `-c copy` 还是重编码」「CRF 给多少」「要不要开硬件编码」。
- 不适用：要决定剪哪几段、钩子放哪（用 `film-edit-narrative`）；已定平台规格要批量出多版本（用 `film-deliver-platform`）；成片体检（用 `film-post-qc`）；导剪映草稿（用 `film-post-jianying`）。

## 核心原则

1. **先 probe 再动手**。任何剪辑前先读 `ffprobe` 的 `width/height/r_frame_rate/avg_frame_rate/codec_name/pix_fmt/color_transfer/sample_rate/channels`。不读就编命令，VFR、HDR、10bit、单声道四类素材必翻车。
2. **能用 copy 就不重编码，但只在不跨关键帧时用**。`-c copy` 的入点会被拉到前一个关键帧（常见 1–10 秒），偏差超过 0.5 秒就必须改成重编码，不要为了「无损」接受错帧。
3. **一条链路只重编码一次**。中间产物用 CRF 18 + `preset medium` 的 H.264 或 ProRes 422 HQ；最后一次交付才用目标码率／CRF。反复重编码的损失远大于参数选错。
4. **中间产物与交付产物分目录、分文件名**。`work/` 放中间件（CRF 18），`out/` 只放交付件；每次渲染换新文件名，不覆盖上一版，出问题才有对照。
5. **统一规格再拼接**。拼接前把每段归一化成同一分辨率、同一帧率、同一像素格式、同一采样率、双声道；`concat` 只对参数完全一致的流成立。
6. **字幕最后烧，画面先定稿**。裁切、缩放、变速完成后再烧字幕；先烧后裁会让字幕出画或被缩放糊掉。
7. **响度按目的地定，不按「听着差不多」定**。网络交付默认 `-14 LUFS` 积分响度、真峰 `-1.0 dBTP`，用 `loudnorm` 两遍法实测后写回参数，不要凭音量推子。
8. **每一步都要有可检验的产出**。剪完抽首帧／末帧，拼完数帧数，转码后 `ffprobe` 核对分辨率、帧率、时长、音轨；不核对就等于没做。

## 工作流

1. **盘点素材**。输入：素材目录。动作：对每个文件跑 `ffprobe`，把时长、分辨率、帧率（`r_frame_rate` 与 `avg_frame_rate` 是否一致）、像素格式、色彩标记、音轨参数记进 `work/probe.json`。产出：一张素材清单表，标出 VFR／HDR／Log／无声四类要特殊处理的文件。
2. **建目录与基线**。输入：清单。动作：建 `work/`、`out/`、`work/proxy/`；原片只读，任何处理都写到新文件。产出：目录骨架 + 一份 `work/edit.md` 记录本片所有命令与参数。
3. **归一化**。输入：每段素材。动作：统一到目标画幅与帧率（命令见模板 3），VFR 素材加 `-fps_mode cfr`，HDR 素材先决定保 HDR 还是转 SDR。产出：`work/norm/*.mp4`，全部 CRF 18、`yuv420p`、48 kHz 双声道。
4. **粗剪**。输入：归一化素材 + 剪辑点表。动作：按 `film-edit-narrative` 给出的 EDL 逐段裁切；跨度大、需要精确到帧时用重编码裁切，纯切头尾且落在关键帧上时用 copy。产出：`work/cut/C01.mp4…`，每段带 0.3 秒前后手柄。
5. **拼接**。输入：C01…Cn。动作：参数一致时用 concat demuxer + `-c copy`；有一项不一致就用 concat 滤镜重编码。产出：`work/assembly.mp4`，帧数 = 各段之和。
6. **变速与抽帧**。输入：assembly。动作：恒定变速用 `setpts` + `atempo`（单条 atempo 限 0.5–2.0，超出就串联）；封面／检查帧用 `-frames:v 1` 抽。产出：定稿画面 + `out/cover.jpg` + 关键帧 PNG。
7. **字幕与音轨**。输入：定稿画面 + SRT／ASS + 旁白／BGM。动作：决定烧录还是软轨（见模板 6），音轨做旁白压音乐与整体响度归一（模板 7）。产出：`out/final_master.mp4`（CRF 18 或 ProRes，留作母版）。
8. **交付转码与自检**。输入：母版。动作：按平台出 1–N 个版本（见 `film-deliver-platform`），每个版本跑 `ffprobe` 核对尺寸、帧率、时长、音轨、`pix_fmt`、`-movflags`。产出：`out/` 交付件 + 一页参数核对结果。任一项不符就回到第 3 步，不在成品上打补丁。

## 关键参数与模板

### 1. 探测（所有判断的起点）

```bash
ffprobe -v error -show_streams -show_format -of json input.mp4
ffprobe -v error -select_streams v:0 -show_entries stream=width,height,r_frame_rate,avg_frame_rate,codec_name,pix_fmt,color_transfer,color_primaries,nb_frames -of default=nw=1 input.mp4
ffprobe -v error -show_entries format=duration,size,bit_rate -of default=nw=1 input.mp4
```

判读：`r_frame_rate` 与 `avg_frame_rate` 不等 → VFR；`pix_fmt` 含 `10le`／`color_transfer=smpte2084|arib-std-b67` → HDR；`avg_frame_rate` 是 `24000/1001` 这类 → 23.976，不要写成 24。

### 2. 编码参数取值

| 参数 | 取值 | 说明 |
| --- | --- | --- |
| `-crf` | 中间件 18；社交交付 20；HEVC 交付 24；代理 30 | x264／x265 标度，18 视为视觉无损；数值越小文件越大 |
| `-preset` | 母版 `slow`；日常 `medium`；代理 `veryfast` | 只影响编码耗时与压缩率，不改画质目标 |
| `-pix_fmt` | SDR `yuv420p`；HDR10 `yuv420p10le`；ProRes `yuv422p10le` | 交付件不要留 `yuv444p`／`yuv420p10le`，多数平台与播放器不认 |
| `-profile:v` | `high`（H.264 8bit）；`main10`（HEVC HDR） | 平台兼容性下限 |
| `-level` | 1080p30 `4.1`；1080p60 `4.2`；4K30 `5.1` | 老设备与部分审核链路会卡 level |
| `-r` / `-fps_mode` | 交付 `-r 30`；VFR 源 `-fps_mode cfr` | 不要同时用 `-r` 与 `-vsync` 旧写法 |
| `-g` | 30fps 用 60；60fps 用 120 | 关键帧间隔 2 秒，便于平台切片与拖动 |
| `-movflags` | `+faststart` | moov 前置，网页与手机起播快；MKV 不需要 |
| `-tag:v` | HEVC 用 `hvc1` | `hev1` 在苹果生态里常黑屏 |
| 音频 | `-c:a aac -b:a 192k -ar 48000 -ac 2` | 交付统一 48 kHz 双声道；旁白素材可保留单声道到混音前 |

- 完整命令集与画中画、绿幕、旋转、去静音等写法见 `references/ffmpeg-recipes.md`。
- CRF 与码率换算、HDR 保真、硬件编码差异见 `references/encoding-params.md`。

### 3. 归一化（统一规格）

```bash
ffmpeg -y -i input.mp4 -vf "fps=30,scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p" -c:v libx264 -preset medium -crf 18 -profile:v high -c:a aac -b:a 192k -ar 48000 -ac 2 -fps_mode cfr -movflags +faststart work/norm/C01.mp4
```

- 竖屏把两处 `1920:1080` 换成 `1080:1920`；要裁满而不是加黑边，把 `decrease` 改 `increase` 并把 `pad` 换成 `crop=1080:1920`。
- `setsar=1` 必写：手机素材常带非 1:1 像素比，不归一会让后续 overlay 位置漂移。

### 4. 裁切：两套做法

**方案 A：copy 裁切（适用：只要粗切、入点正好落在关键帧、追求速度）**

```bash
ffmpeg -y -ss 00:00:12.000 -i input.mp4 -t 16.000 -map 0 -c copy -avoid_negative_ts make_zero -movflags +faststart work/cut/A_copy.mp4
```

**方案 B：重编码裁切（适用：要精确到帧、要交付、源是 VFR／非关键帧入点）**

```bash
ffmpeg -y -ss 00:00:12.400 -i input.mp4 -t 16.100 -c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p -c:a aac -b:a 192k -movflags +faststart work/cut/B_exact.mp4
```

- 用 `-ss` + `-t`（时长）而不是 `-ss` + `-to`：`-to` 在输入侧 `-ss` 之后是绝对时间轴，容易多切或少切。
- 判断依据：copy 出来的首帧与要求时间差 > 0.5 秒（抽帧对比）就改用方案 B。

### 5. 拼接：两套做法

**方案 A：concat demuxer + copy（适用：所有段编码参数完全一致）**

```bash
printf "file '%s'\n" work/cut/C01.mp4 work/cut/C02.mp4 work/cut/C03.mp4 > work/list.txt
ffmpeg -y -f concat -safe 0 -i work/list.txt -c copy -movflags +faststart work/assembly.mp4
```

**方案 B：concat 滤镜重编码（适用：分辨率／帧率／音轨有一项不一致）**

```bash
ffmpeg -y -i work/cut/C01.mp4 -i work/cut/C02.mp4 -filter_complex "[0:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30[v0];[1:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30[v1];[v0][0:a][v1][1:a]concat=n=2:v=1:a=1[v][a]" -map "[v]" -map "[a]" -c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p -c:a aac -b:a 192k -ar 48000 -ac 2 -movflags +faststart work/assembly.mp4
```

- 段数超过 6 段时先用方案 A 分组合并，再合并各组，避免一条命令过长。
- 任一段没有音轨会直接失败：先给该段补静音轨 `-f lavfi -i anullsrc=r=48000:cl=stereo -shortest`。

### 6. 变速、字幕、音轨

```bash
# 恒定 1.25 倍速（画面与声音同步）
ffmpeg -y -i in.mp4 -filter_complex "[0:v]setpts=PTS/1.25[v];[0:a]atempo=1.25[a]" -map "[v]" -map "[a]" -c:v libx264 -preset medium -crf 18 -c:a aac -b:a 192k out.mp4

# 烧录 ASS 字幕（含中文字体目录）
ffmpeg -y -i in.mp4 -vf "subtitles=captions.ass:fontsdir=fonts" -c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p -c:a copy out.mp4

# SRT 作为软字幕轨（不重编码画面）
ffmpeg -y -i in.mp4 -i captions.srt -map 0 -map 1 -c copy -c:s mov_text -metadata:s:s:0 language=chi out.mp4

# 换音轨（保留画面，不重编码）
ffmpeg -y -i video.mp4 -i voice.wav -map 0:v:0 -map 1:a:0 -c:v copy -c:a aac -b:a 192k -shortest out.mp4
```

- 字幕与画面同时定稿时用烧录；要留多语言、要用户可关字幕用软轨。烧录与软轨不要同时出现在同一交付件里，除非平台明确要求。
- Windows 上 `subtitles` 滤镜路径写成 `subtitles='C\:/work/captions.ass':fontsdir='C\:/work/fonts'`，冒号必须转义。

### 7. 混音与响度

```bash
# 旁白为主、BGM 侧链压低（BGM 先降到 0.25，再被旁白压 8:1）
ffmpeg -y -i video.mp4 -i voice.wav -i bgm.wav -filter_complex "[2:a]volume=0.25,aloop=loop=-1:size=2e+09[bg];[bg][1:a]sidechaincompress=threshold=0.05:ratio=8:attack=20:release=350[duck];[1:a][duck]amix=inputs=2:duration=first:normalize=0[a]" -map 0:v -map "[a]" -c:v copy -c:a aac -b:a 192k -ar 48000 out/mix.mp4

# 两遍 loudnorm：第一遍只测量
ffmpeg -hide_banner -i out/mix.mp4 -af loudnorm=I=-14:TP=-1.0:LRA=11:print_format=json -f null -
```

第一遍输出里的 `input_i`、`input_tp`、`input_lra`、`input_thresh`、`target_offset` 填进第二遍：

```bash
ffmpeg -y -i out/mix.mp4 -af "loudnorm=I=-14:TP=-1.0:LRA=11:measured_I=-18.2:measured_TP=-1.4:measured_LRA=8.1:measured_thresh=-28.6:offset=0.3:linear=true" -c:v copy -c:a aac -b:a 192k out/final_audio.mp4
```

- `-40 LUFS` 以下的素材是环境声或静音，不要按人声目标拉 25 dB，只会把底噪放大；这种情况写明「未归一」。
- 只看 LUFS 不够，必须同时看真峰 `TP ≤ -1.0 dBTP`。

### 8. 硬件编码：三套并列

| 方案 | 命令核心 | 适用 | 代价 |
| --- | --- | --- | --- |
| CPU x264／x265 | `-c:v libx264 -preset medium -crf 18` | 交付母版、需要确定性画质 | 慢；质量与体积最优 |
| NVIDIA NVENC | `-c:v h264_nvenc -preset p5 -tune hq -rc vbr -cq 21 -b:v 0` | 大批量出片、代理、预览 | 同画质码率约高 10–30%；`-cq` 与 `-crf` 标度不同 |
| Apple VideoToolbox | `-c:v h264_videotoolbox -q:v 71` | Mac 上赶时间 | 同画质体积为 x264 的 1.1–2.9 倍；`q:v` 由 `75 - 2.2 × (crf - 18)` 换算 |

- 硬件编码一律先跑一条 10 秒样片，肉眼对比暗部与渐变，再决定是否全片使用。
- 硬件编码不做两遍码率控制，`-maxrate／-bufsize` 要显式给，否则平台二压后易出块。

## 常见坑

- **症状：copy 裁出来的片子开头定格半秒或画面从上一个镜头开始。** 原因：入点不在关键帧，解码器从前一个 I 帧起解。修法：入点偏差 > 0.5 秒就重编码；或用 `-ss` 放在 `-i` 之后（精确但慢）。
- **症状：拼接后音画逐渐不同步、总时长比各段之和小。** 原因：各段帧率／采样率不一致，concat 按时间戳硬拼。修法：回到归一化，全部 `fps=30`、`-ar 48000 -ac 2` 后再拼。
- **症状：字幕烧上去位置全错、字号忽大忽小。** 原因：先烧字幕后缩放，或用 SRT 直接烧而没有样式。修法：画面定稿后再烧；字幕用 ASS 固定 `PlayResX/PlayResY` 与字号；Windows 路径转义。
- **症状：视频在某些播放器黑屏、只有声音。** 原因：`pix_fmt` 是 `yuv444p`／`yuv420p10le`，或 HEVC 用了 `hev1` 标签。修法：`-pix_fmt yuv420p`、`-tag:v hvc1`、`-profile:v high -level 4.1`。
- **症状：iPhone HDR 素材转完发灰、颜色发闷。** 原因：BT.2020／PQ 像素被打上 BT.709 标签。修法：保 HDR 就用 `libx265 -pix_fmt yuv420p10le` 并写入原 `color_primaries/transfer/matrix`；要 SDR 就先 `zscale` 转换再编码，不要只改标签。
- **症状：`moov atom not found`、网页上传后无法拖动进度。** 原因：缺少 `-movflags +faststart`，或转码被中断留下半截文件。修法：重跑并加 `+faststart`；确认退出码为 0 再看文件。

## 来源与合并说明

| 上游仓库 | ★ | 许可 | 贡献内容 |
| --- | --- | --- | --- |
| kajisho5/ffmpeg-skill | 4475 | MIT | 编码参数默认值（中间件 CRF 18、社交 CRF 20、HEVC 24）、关键帧裁切与 0.5 秒重编码阈值、VFR 的 `-fps_mode cfr`、HDR 10bit 路径、loudnorm 门限与真峰口径、VideoToolbox `q:v` 换算与体积代价 |
| calesthio/OpenMontage | 76149 | AGPL-3.0 | `video-edit` 的基础命令骨架（trim／concat／resize／speed／替换音轨）、平台缩放滤镜写法、`ffmpeg` 技能的 GIF 与偶数尺寸处理 |
| Bomx/super-video-maker-skill | 331 | 无许可证 | 归一化模板（`fps=30,format=yuv420p`）、绿幕与画中画叠人像、`drawbox`／PNG 下三分之一、交付前抽帧复核 |
| joeseesun/qiaomu-cut-skill | 377 | MIT | 必需滤镜能力清单（libass／drawtext／loudnorm／sidechaincompress／zoompan／xfade）、ffmpeg-full 探测顺序、中文字体与 ASS 渲染要求 |

- 抓取日期：2026-11-04
- 合并的上游技能：kajisho5/ffmpeg-skill（根 SKILL.md、`references/flags.md`、`references/gotchas.md`、`scripts/export.py`、`scripts/_platforms.py`、`scripts/_common/decision.py`）、calesthio/OpenMontage `video-edit` 与 `ffmpeg`、Bomx/super-video-maker-skill `FFMPEG_PLAYBOOK.md`、joeseesun/qiaomu-cut-skill `references/ffmpeg-full.md`
- 冲突与取舍：kajisho5 主张「不要手写 ffmpeg、全部走脚本」，本技能面向没有该脚本包的机器，改为「手写但给全参数 + 每步 ffprobe 复核」，两者判断标准（关键帧 0.5 秒阈值、CRF 18/20/24、-14 LUFS）一致；OpenMontage 的 `-c copy` 直切与本技能的方案 A 相同，方案 B 是补充而非冲突。AGPL-3.0 与无许可证仓库只取参数与流程事实，未复制其代码。
