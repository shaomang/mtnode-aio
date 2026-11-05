# 质检命令与判读

## 1. 全家桶（一条命令跑完，先看有没有硬失败）

```bash
# 解码扫描：stderr 必须为空
ffmpeg -v error -i out/final.mp4 -f null -

# 黑帧
ffmpeg -hide_banner -i out/final.mp4 -vf "blackdetect=d=0.4:pix_th=0.10" -an -f null -

# 静帧
ffmpeg -hide_banner -i out/final.mp4 -vf "freezedetect=n=-60dB:d=1.0" -an -f null -

# 响度 + 真峰
ffmpeg -hide_banner -i out/final.mp4 -filter_complex "ebur128=peak=true" -f null -

# 静音
ffmpeg -hide_banner -i out/final.mp4 -af "silencedetect=noise=-50dB:d=1.0" -f null -
```

四个滤镜都会把结果打到 stderr。PowerShell 用 `2>&1 | Select-String "black_start"` 过滤；bash 用 `2>&1 | grep -E "black_start"`。不过滤也能判读，过滤只是让报告好写。

## 2. `blackdetect` 参数与判读

| 参数 | 值 | 含义 |
| --- | --- | --- |
| `d` | 0.4 | 最短报告时长（秒）；小于它的闪黑不报，避免噪声 |
| `pix_th` | 0.10 | 像素亮度阈值（0–1），0.10 表示灰度 ≤ 10% 视为黑 |
| `picture_black_ratio_th` | 0.98（默认） | 画面中黑像素占比达到多少算黑帧 |

输出形如 `black_start:41.2 black_end:41.9 black_duration:0.7`。判读：

- 片头 0–0.5 秒的淡入黑场：设计豁免，记录时间码。
- 段中 ≥ 0.8 秒：失败，定位到拼接点或生成段尾。
- 同一位置反复出现 0.1–0.2 秒：多半是转场被压成黑场，改叠化。

## 3. `freezedetect` 参数与判读

| 参数 | 值 | 含义 |
| --- | --- | --- |
| `n` | -60dB | 噪声容差；画面变化低于此值视为冻结 |
| `d` | 1.0 | 最短报告时长（秒） |

输出 `freeze_start / freeze_end / freeze_duration`。刻意定格（片尾 CTA 定格 2 秒）写进豁免；动作中间的 1 秒冻结一律算缺陷。

## 4. 响度与真峰

```bash
ffmpeg -hide_banner -i out/final.mp4 -filter_complex "ebur128=peak=true" -f null - 2>&1 | tail -n 20
```

看 Summary 段：

```text
    I:         -14.3 LUFS
    LRA:         6.8 LU
    Peak:       -1.2 dBFS
```

- `I` 目标 −14 ±1 LUFS；口播类可到 −15，音乐类不要低于 −13。
- `Peak` 是采样峰值；真峰要用 `loudnorm` 的 `print_format=json` 看 `output_tp`（单位 dBTP）。
- 两个命令测出的 I 值差 1–2 LU 属正常：`ebur128` 整段积分，`loudnorm` 按 EBU R128 门限（−70 LUFS 绝对、−10 LU 相对）。报告里注明用哪条。

## 5. 削波与直流偏移

```bash
ffmpeg -hide_banner -i out/final.mp4 -af "astats=metadata=1:reset=0" -f null - 2>&1 | Select-String "Peak level|Flat factor|DC offset|Number of samples"
```

- `Peak level` 接近 0 dB 且 `Flat factor` 大于 2：出现平顶削波，必须降增益重混。
- `DC offset` 绝对值 > 0.001：录音链路有直流偏置，加 `highpass=f=20` 修。

## 6. 音画同步

```bash
ffprobe -v error -select_streams v:0 -show_entries stream=start_time -of default=nw=1 out/final.mp4
ffprobe -v error -select_streams a:0 -show_entries stream=start_time -of default=nw=1 out/final.mp4
```

两个 `start_time` 之差 ≤ 0.02 秒。若差值大，先查是否 `-c copy` 拼接导致音轨被裁；修法是用 `-avoid_negative_ts make_zero` 重封装，或整段重编码。

听感核对：在说话人拍手／关门的位置抽 3 帧（前 0.1 秒、事件帧、后 0.1 秒），确认口型与声音在同一帧。

## 7. 字幕逐条核查

```bash
# 按 cue 入点逐条抽帧（示例：第 12 条在 41.2 秒）
ffmpeg -y -ss 41.200 -i out/final.mp4 -frames:v 1 -q:v 2 out/qc/cue_012.png

# 全部 cue 的入点批量抽帧（先生成时间列表，再逐条跑）
ffmpeg -y -i out/final.mp4 -vf "fps=4" -q:v 2 out/qc/dense_%04d.jpg
```

判读三条：

1. 文字是否已经出现（不是上一条的残留）。
2. 内容是否与旁白／台词逐字一致（错别字、漏字、断行错误）。
3. 是否整体在安全矩形内、没有被人物脸部或平台 UI 压住。

偏差计算：`|cue_start − 语音起点|`，≤ 0.2 秒通过，0.2–0.3 秒警告，> 0.3 秒失败。

## 8. 音量与画面之外的常见缺陷

| 缺陷 | 检测 | 修法 |
| --- | --- | --- |
| 色彩断层（banding） | 抽渐变区域帧放大看 | 编码加 `-x264-params "aq-mode=3"`，或 CRF 降到 18 |
| 边缘锯齿 | 抽斜线／文字帧看 | 缩放用 `flags=lanczos`，避免二次缩放 |
| 意外水印／贴纸 | 联系表逐格看 | 回时间线关闭对应图层 |
| 生成瑕疵（手、文字） | 每个生成段抽首／中／尾帧 | 重生成该段，或裁掉瑕疵区间 |
| 帧率抖动 | `avg_frame_rate != r_frame_rate` | `-fps_mode cfr -r 30` 重编码 |
| 文件打不开 | `ffmpeg -v error` 有 `moov atom not found` | 重导出并加 `-movflags +faststart` |

## 9. 体积与码率换算

```bash
# 实际平均码率（kbps）
$size = (Get-Item out/final.mp4).Length
$dur  = [double](ffprobe -v error -show_entries format=duration -of csv=p=0 out/final.mp4)
[int]($size * 8 / $dur / 1000)
```

或在 bash 里：

```bash
ffprobe -v error -show_entries format=duration,size,bit_rate -of default=nw=1 out/final.mp4
```

`format.bit_rate` 是容器总码率（含音频）；平台核对用「文件字节 × 8 ÷ 时长」，比 `bit_rate` 更接近上传后的实际值。

## 10. 报告落盘

```bash
ffmpeg -hide_banner -i out/final.mp4 -vf "blackdetect=d=0.4:pix_th=0.10" -an -f null - > out/qc/black.log 2>&1
ffmpeg -hide_banner -i out/final.mp4 -filter_complex "ebur128=peak=true" -f null - > out/qc/loudness.log 2>&1
ffprobe -v error -show_streams -show_format -of json out/final.mp4 > out/qc/probe.json
```

报告只引用这三份原始输出 + 抽帧图，不引用「我记得测过」。文件被替换后，报告的 SHA-256 对不上即作废。
