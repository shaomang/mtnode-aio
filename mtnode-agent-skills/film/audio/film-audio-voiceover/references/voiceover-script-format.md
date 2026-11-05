# 旁白脚本格式、拼装与口型校验

## 1. 三种稿件格式

### 1.1 Markdown 表（编剧/导演交付用）

| id | start | end | 情绪 | 旁白 |
| --- | ---: | ---: | --- | --- |
| n01 | 0.2 | 3.6 | 平静、压低 | 先看结论。 |
| n02 | 4.0 | 11.8 | 认真 | 同一段素材，换一个顺序，观众的理解就完全不同。 |
| n03 | 12.2 | 15.0 | 轻快 | 下面三件事，按这个顺序做。 |

规则：`start` / `end` 是**剪后输出时间线**的秒；一格里只写一句话；舞台提示写进「情绪」列，不写进旁白。

### 1.2 CSV（批量导入 / 表格协作）

```csv
id,start,end,emotion,pause_after_ms,narration
n01,0.2,3.6,calm,250,先看结论。
n02,4.0,11.8,serious,300,同一段素材，换一个顺序，观众的理解就完全不同。
```

### 1.3 JSON（机器执行用）

```json
{
  "engine": "doubao",
  "voice": {"voice_id": "zh_female_vv_uranus_bigtts", "sample_rate": 24000},
  "defaults": {"speech_rate": 0, "enable_timestamp": true},
  "segments": [
    {"id": "n01", "start": 0.2, "end": 3.6, "narration": "先看结论。", "emotion": "calm", "pause_after_ms": 250}
  ]
}
```

必填：`id`、`start`、`end`、`narration`；选填：`emotion`、`pause_after_ms`、`overlaps_speech`（旁白压原声时必须显式标注，后期才好压低原声）。

## 2. 切段规则（写稿阶段就按这个切）

| 规则 | 数值 | 说明 |
| --- | --- | --- |
| 单段时长 | 2–8 s | 超过 8 s 难对位，低于 1.5 s 容易被吞 |
| 单段字数（中文） | ≤ 35 字 | 超出就按逗号/句号拆 |
| 单段字数（英文） | ≤ 22 词 | 同上 |
| 段间停顿 | 200–400 ms | 句号后取 300–500 ms |
| 换气点 | 逗号处 120–200 ms | 不要让模型自己猜 |
| 数字与缩写 | 写读法 | 「3.5%」→「百分之三点五」；模型读法不可控 |

断句以**语义完整**优先：宁可两段短句，也不要一段跨两个意思。跨句拆段后，`start` 按镜头切点重新给，不要沿用原稿累计时间。

## 3. 时长核算与语速预算

```text
预算上限(s) = 有效字数 ÷ 2.5 + 标点数 × 0.25 + 0.1   # 中文；低于这个上限才正常
英文预算上限(s) = 词数 ÷ 1.5 + 0.1
```

- 实测 > 预算上限 → 判为幻读（模型念完又编），重合成。
- 实测 > 时间窗但 ≤ 预算上限 → 正常超长，走缩稿或 `atempo`。
- 累计语速倍率 = TTS 语速偏移 × 全局 `atempo` × 段内 `atempo`，**上限 1.35**；段内单独上限 1.20。
- 全局 `atempo` 默认 1.15（把 4.0 字/秒的稿子拉到 4.6 字/秒，仍在可懂区间）；长片/慢节奏纪录片设 1.0。

`atempo` 单级只接受 0.5–2.0，超过要串联：

```bash
# 1.5 倍：一级就够
ffmpeg -i seg.wav -filter:a "atempo=1.5" seg_150.wav
# 2.6 倍：必须串联（2.0 × 1.3）
ffmpeg -i seg.wav -filter:a "atempo=2.0,atempo=1.3" seg_260.wav
```

## 4. 拼装成整轨

### 4.1 段间补静音 + 硬拼接（可复现，推荐）

```bash
# 1) 为每段生成等长静音（48 kHz 单声道）
ffmpeg -f lavfi -i anullsrc=r=48000:cl=mono -t 0.30 -c:a pcm_s24le pause_300.wav

# 2) 写拼接清单（顺序 = 时间线顺序）
# file 'tts_segments/n001.wav'
# file 'pause_300.wav'
# file 'tts_segments/n002.wav'

ffmpeg -f concat -safe 0 -i list.txt -c:a pcm_s24le narration_full.wav
```

### 4.2 按绝对时间放置（段间有画面空隙时）

```bash
# 把每段延迟到 start 秒；400 ms = 400
ffmpeg -i n001.wav -af "adelay=200|200" d001.wav
ffmpeg -i n002.wav -af "adelay=4000|4000" d002.wav

# 叠加成一条轨，长度取成片时长
ffmpeg -i d001.wav -i d002.wav -filter_complex \
  "[0:a][1:a]amix=inputs=2:duration=longest:normalize=0[a]" \
  -map "[a]" -t 63.5 narration_full.wav
```

`normalize=0` 必须加，否则 `amix` 会把每段电平按输入数衰减。

### 4.3 单段归一后再拼（避免段间音量跳）

```bash
ffmpeg -i seg.wav -af "loudnorm=I=-18:TP=-2:LRA=11" seg_norm.wav
```

段级只做轻归一（-18 LUFS），成片统一母版走 `film-audio-loudness`；不要在段级直接打到 -14 LUFS。

## 5. 实测时长与清单

```bash
ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 tts_segments/n001.wav
```

每段写进 `tts_meta.json`：`audio_path`、`start`、`end`、`measured_duration`、`rate_offset`、`effective_tempo`、`engine`、`voice`、`model`、`text_sha256`。

```json
{
  "engine": "fish-audio",
  "voice": "s2-pro/<reference_id>",
  "segments": [
    {"audio_path": "tts_segments/n001.wav", "start": 0.2, "end": 3.6,
     "measured_duration": 2.94, "rate_offset": 0.05, "effective_tempo": 1.20}
  ],
  "partial": false,
  "failures": []
}
```

失败段不许静默丢弃：`partial: true` + `failures: [{index,start,end,text,error}]`，缺失语音必须可见。

## 6. 音画对位与口型校验

```bash
# 测两轨偏移与漂移（音频互相关，不是口型检测）
python3 sync.py camera.mp4 narration.wav --json
# 直接替换原声（保留画面）
python3 sync.py camera.mp4 narration.wav --replace-audio -o cut_synced.mp4
# 复核：对输出再测一次，偏移应接近 0
python3 sync.py cut_synced.mp4 narration.wav --json
```

判定：`confidence < 0.3` 或偏移贴近分析窗边缘 → 不可信，换更长的分析窗或找一声拍板/关门声当锚点；超过 10 分钟的分离录制必须加 `--fix-drift`。

口型抽帧（每个对口型镜头至少 3 帧）：

```bash
ffmpeg -ss 4.10 -i cut_synced.mp4 -frames:v 1 -q:v 2 lip_0410.png
ffmpeg -ss 4.60 -i cut_synced.mp4 -frames:v 1 -q:v 2 lip_0460.png
ffmpeg -ss 5.20 -i cut_synced.mp4 -frames:v 1 -q:v 2 lip_0520.png
```

看三件事：第一字是否对上下颌打开、重音字是否张大、收尾是否提前闭嘴。偏 1 帧以内可接受（25 fps 下 40 ms），偏 2 帧以上回去调 `start`。

## 7. 交付前自检

- [ ] 每段都有实测时长，`tts_meta.json` 与文件一一对应。
- [ ] 超窗段都有处理记录（删了什么字、加到多少语速）。
- [ ] 累计语速倍率 ≤ 1.35，全局 `atempo` ≤ 1.15。
- [ ] 段间无爆音（拼接处听 3 个接缝），无 -inf 静音段。
- [ ] 音轨 48 kHz；进混音用 24-bit WAV，交付用 AAC 192 kbps。
- [ ] 克隆/参考音频有授权记录；Key 未出现在任何产物。
- [ ] 对口型镜头已抽帧看过，`lip_sync` 未被写成「已验证」。
