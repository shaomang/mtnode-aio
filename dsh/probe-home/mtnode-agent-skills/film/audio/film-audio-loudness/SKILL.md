---
name: film-audio-loudness
title: 响度与母版：LUFS·真峰值·交付
description: 按交付平台定响度目标，用 ffmpeg loudnorm 两遍法做线性归一，必要时先上真峰值限幅，编码后再复测真峰值与时长。成片混音收尾、平台退片、声音忽大忽小时用。
tags: 响度, LUFS, 真峰值, 母版, loudnorm, 交付检查
version: 1.0.0
---

# 响度与母版：LUFS·真峰值·交付

## 何时用

- 混音完成，要按平台规范出母版（短视频、YouTube、播客、广电）。
- 平台提示「音量不一致 / 被限流 / 审核退回」，或观众反馈「一会儿响一会儿轻」。
- 多条片子要统一听感，或同一片要出多个平台的版本。
- 需要判断一段素材是内容还是环境底噪，能不能提电平。
- 不适用：单段配音电平（`film-audio-voiceover`）、音效与 BGM 选材（`film-audio-sound-design`）、字幕（`film-subtitle-production`）。

## 核心原则

1. **先测后动**：不测就加增益的母版一律返工；先拿到 `input_i` / `input_tp` / `input_lra` / `input_thresh`。
2. **两遍法，不用单遍**：`loudnorm` 单遍是动态归一（3 秒 AGC），会有泵感；两遍线性只施加一个固定增益。
3. **线性有条件**：`measured_TP + (I_target - measured_I) ≤ TP` 且 `measured_LRA ≤ LRA` 时才走线性；不满足就先限幅或下调目标，别让 ffmpeg 静默转动态。
4. **LUFS 与真峰值一起看**：达标 LUFS 但真峰值超 0 dBTP 的母版在流媒体会被削。
5. **编码会抬峰**：AAC 192 kbps 实测比 loudnorm 输出高 0.3–1.4 dB，首渲要预留 0.5 dB。
6. **环境不归一**：整段 ≤ -40 LUFS 的是房间底噪/风声/静音，提 25 dB 只会把噪声抬上来。
7. **目标由交付决定**：一条片子出多个平台就出多版，不要用一个 -14 LUFS 通吃播客与广电。
8. **改完必须复测**：LUFS 容差 ±1 LU、真峰值容差 0.1 dB；不复测不算完成。

## 工作流

1. **输入**：混音母版（48 kHz、24-bit WAV 最佳）+ 交付平台清单。
   产出：`delivery-spec.md`（每个平台的目标 LUFS、TP、LRA、封装）。
2. **首遍测量**（不改动文件）：
   ```bash
   ffmpeg -hide_banner -nostdin -i mix.wav -vn \
     -af "loudnorm=I=-14:TP=-1:LRA=11:print_format=json" -f null -
   ```
   取 stderr 里的 JSON：`input_i`、`input_tp`、`input_lra`、`input_thresh`、`target_offset`。
3. **判线性**：算 `peak_after_gain = input_tp + (target_I - input_i)`。
   分支 A：`peak_after_gain ≤ TP` 且 `input_lra ≤ LRA` → 直接第二遍线性。
   分支 B：峰值放不下 → 先上真峰值限幅（最多削 6 dB），再测再归一；超出 6 dB 的部分下调目标响度而不是继续压。
   分支 C：`input_lra > LRA`（动态太宽）→ 线性模式不可用；先做混音层压缩，或接受动态模式并记录。
4. **第二遍线性归一**：把首遍四个测量值写进滤镜，`linear=true`。
5. **编码**：视频 `-c:v copy`（已渲好）+ `-c:a aac -b:a 192k -ar 48000`；音频交付 `pcm_s24le` 或 `aac 256k`。
6. **复测**：对**编码后的文件**跑 `ebur128=peak=true`，读 Integrated 与 True peak；同时 `ffprobe` 核时长。
7. **修正**：LUFS 偏 > 1 LU → 调整 `I=` 重跑第二遍；TP 超 → 降 0.5–1 dB 或收紧限幅 ceiling；时长变了 → 按输入长度裁齐。
8. **交付**：母版 + 报告（目标值、实测值、归一类型 linear/dynamic、限幅量、编码器与码率）。

## 关键参数与模板

### 交付目标表

| 交付 | 综合响度 | 容差 | 真峰值 | LRA | 依据 |
| --- | ---: | ---: | ---: | ---: | --- |
| TikTok / Reels / Shorts | -14 LUFS | ±2 LU | -1 dBTP | 11 | 平台交付表 |
| YouTube / X / LinkedIn / Facebook | -14 LUFS | ±2 LU（X/LI/FB ±3） | -1 dBTP | 11 | 平台交付表 |
| 播客（音频） | -16 LUFS | ±1 LU | -1 dBTP | 11 | Apple Podcasts 口径 |
| 广电 / EBU R128 | -23 LUFS | ±1 LU | -1 dBTP | ≤ 20 | EBU R128 |
| 电影感短片（横屏） | -16 LUFS | ±1 LU | -1 dBTP | 11 | 项目口径，留更多动态 |
| 影院母版 | 对白锚定 -27 LUFS | — | -2 dBTP | — | 通用经验值，需按影院校准 |

冲突处理：YouTube 横屏在两套上游里分别写 -14 与 -16 LUFS —— 方案 A 用 **-14**（平台交付表口径，投流与信息流更稳）；方案 B 用 **-16**（叙事短片，保留动态）。同一批片子只选一套，别混。

### 母版前分层电平基准（dBFS 峰值，通用经验值）

| 层 | 峰值区间 | 说明 |
| --- | ---: | --- |
| 对白 / 旁白 | -9 ~ -3 dBFS | 混音里的锚，其他层让位 |
| 音乐（说话段） | -24 ~ -18 dBFS | 叠加后仍不遮人声 |
| 音乐（无对白段） | -12 ~ -6 dBFS | 峰值段也别顶到 0 |
| SFX | -12 ~ -6 dBFS | 单次事件，密集段再降 3 dB |
| 环境铺底 | -36 ~ -24 dBFS | 只做空间感，不做内容 |
| 整体混音 | -3 ~ -1 dBFS | 留 1 dB 给 `loudnorm` 与编码 |

这些是进 `loudnorm` **之前**的相对关系，不是交付目标；交付目标只看 LUFS 与 dBTP。分层没做对时，先回混音，别用母版限幅硬压。

### 测量口径（别把三个数混着用）

| 指标 | 含义 | 使用注意 |
| --- | --- | --- |
| Integrated（I） | 整段门限积分响度，-70 LUFS 绝对门 + -10 LU 相对门 | 母版目标看这个；短于约 10 s 不稳定 |
| LRA | 10%–95% 分位的响度范围 | > 20 LU 说明动态过宽，流媒体会压；不是「动态好听」的指标 |
| True peak（TP） | 4 倍过采样峰值 | sample peak 会低估 0.3–1 dB；以 TP 为准 |
| Sample peak | 采样点峰值 | 只用于快速预检，不能当验收 |

段落测量只用来查分层（人声段、纯音乐段各测一次），母版结论一律用全片测量。

### 线性归一的判定与参数

```text
条件：input_tp + (target_I - input_i) ≤ TP  且  input_lra ≤ LRA
第二遍滤镜：
loudnorm=I=<target>:TP=-1:LRA=<max(11, input_lra)>:
         measured_I=<input_i>:measured_TP=<input_tp>:measured_LRA=<input_lra>:
         measured_thresh=<input_thresh>:offset=<target_offset>:linear=true
```

- `LRA` 目标要取 `max(11, 实测 LRA)`：线性模式不压缩动态，填小了会被判不满足条件而退回动态。
- 目标响度因峰值放不下而下调时，`gain_capped_db = 目标 - 实际` 要写进报告（可能差 0.5–3 LU）。
- `loudnorm` 内部按 192 kHz 处理，输出会带 96 kHz 采样率；交付前显式 `-ar 48000`。

### 真峰值限幅（峰值挡住线性增益时）

```bash
ffmpeg -i mix.wav -af "\
volume=3.5dB,\
aresample=192000,\
alimiter=limit=0.891:attack=5:release=100:level=false,\
aresample=48000" limited.wav
```

- ceiling `0.891` ≈ -1 dBFS，再留 1.0 dB 给第二遍 loudnorm 补回被削掉的响度（实测 6 dB 削减约损失 0.3 LU，10 dB 约 1.1 LU）。
- 4 倍过采样（48 k → 192 k）让 sample peak 逼近 true peak。
- 最多削 6 dB；超过就说明混音动态本身有问题，回去处理轨道，不靠限幅硬顶。

### 复测命令

```bash
# 综合响度 + 真峰值（读 Summary 段）
ffmpeg -hide_banner -nostdin -i out.mp4 -vn -af "ebur128=peak=true" -f null - 2>&1 | tail -n 12

# 单独读真峰值（loudnorm 与 ebur128 取较高者更保守）
ffmpeg -hide_banner -nostdin -i out.mp4 -vn \
  -af "ebur128=peak=true:framelog=quiet,loudnorm=I=-14:TP=-1:LRA=11:print_format=json" \
  -f null - 2>&1 | tail -n 20

# 时长与采样率
ffprobe -v error -show_entries format=duration:stream=codec_name,sample_rate,channels -of default=nw=1 out.mp4
```

判定：`|实测 I - 目标| ≤ 1.0 LU`；`实测 TP ≤ 目标 TP + 0.1 dB`（0.1 dB 是两次 loudnorm 的测量噪声容差）；音频时长与输入差 ≤ 0.03 s（48 kHz 一个 AAC 帧 0.021 s）。

细表见 `references/loudnorm-recipes.md`（完整两遍命令、限幅链、批处理脚本）与 `references/delivery-checklist.md`（逐项验收单、常见退片原因）。

## 常见坑

- **归一后声音「一抽一抽」**：单遍 `loudnorm` 走了动态模式 → 改两遍法并显式 `linear=true`；若仍退回动态，检查 `input_lra` 是否大于 `LRA`。
- **-14 LUFS 达标，平台还是压音量**：真峰值超了 → 复测 TP，超 -1 dBTP 就降目标或上限幅；只看 LUFS 不看 TP 是最常见的退片原因。
- **编码前达标、上传后被削**：AAC 编码抬峰 0.3–1.4 dB → 首渲把 TP 目标压到 -1.5 dBTP（预留 0.5 dB），编码后复测再定。
- **归一后音频比画面长 0.1 秒**：AAC 编码补齐了帧 → 按输入时长裁齐（`-t <输入时长>`），并把时长步纳入验收。
- **把房间底噪拉成了「嘶——」**：对 ≤ -40 LUFS 的段落做了语音目标归一 → 这类段落跳过归一，直接说明「素材本身近乎无声」，需要音乐或补录。
- **输出采样率变成 96 kHz**：`loudnorm` 内部升采样后没显式回落 → 交付命令统一加 `-ar 48000`。

## 来源与合并说明

| 上游仓库 | ★ | 许可 | 贡献内容 |
| --- | --- | --- | --- |
| kajisho5/ffmpeg-skill | 4475 | MIT | `loudness.py` 两遍 EBU R128 流程、`loudnorm` 测量字段、真峰值容差 0.1 dB、`gotchas.md` 的环境/静音判定、平台交付表 `_platforms.py`（LUFS/容差/TP） |
| zenstory-ai/video-recap-skills | 601 | MIT | `video-assemble/scripts/loudness.py`：线性条件判定、峰值限幅链（192 kHz 过采样、5/100 ms、ceiling 0.98、1 dB 余量）、编码抬峰 0.5 dB 预留、LRA 上限 20、目标 -14/-1/11、动态退回告警 |
| joeseesun/qiaomu-cut-skill | 377 | MIT | `workflows.md` 的平台响度表（抖音/小红书 -14、YouTube -16、电影感 -16）、`timeline-schema.md` 的「preview 单遍 / final 两遍」档位 |
| calesthio/OpenMontage | 76149 | AGPL-3.0 | `ffmpeg` 技能的音频编码与输出参数（AAC 48 kHz、`-movflags faststart`） |

- 抓取日期：2026-11-04
- 合并的上游技能：ffmpeg（loudness.py / gotchas / _platforms.py）、video-assemble（loudness.py / assembly_settings）、qiaomu-cut-skill（workflows / timeline-schema）
- 冲突与取舍：YouTube 横屏响度有两说 —— `_platforms.py` 的 -14 LUFS 与 qiaomu 的 -16 LUFS，正文并列保留（-14 用于信息流与投流，-16 用于叙事短片）。容差也有两套：平台表给 ±2/±3 LU，工程实现按 ±1 LU 自检；本技能取**更严的 ±1 LU 做内部验收**，对外声明仍按平台容差。影院 -27 LUFS 与 LRA ≤ 20 属通用经验值，非上游数值。
