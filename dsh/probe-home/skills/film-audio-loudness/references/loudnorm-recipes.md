# loudnorm 两遍法与限幅链（可直接抄）

## 1. 首遍：只测量，不改文件

```bash
ffmpeg -hide_banner -nostdin -i mix.wav -vn \
  -af "loudnorm=I=-14:TP=-1:LRA=11:print_format=json" \
  -f null - 2>&1 | tail -n 24
```

输出（示例，数值换成你自己的）：

```json
{
  "input_i": "-19.42",
  "input_tp": "-2.31",
  "input_lra": "7.80",
  "input_thresh": "-29.70",
  "output_i": "-14.02",
  "output_tp": "-1.05",
  "output_lra": "7.20",
  "output_thresh": "-24.30",
  "normalization_type": "linear",
  "target_offset": "0.02"
}
```

读四个值：`input_i`（当前综合响度）、`input_tp`（当前真峰值）、`input_lra`（响度范围）、`input_thresh`（门限）。

判线性（不改参数先算一遍）：

```text
peak_after_gain = input_tp + (target_I - input_i)
linear 可行 ⇔ peak_after_gain ≤ TP 且 input_lra ≤ LRA
例：-2.31 + (-14 - (-19.42)) = -2.31 + 5.42 = +3.11 dBTP > -1 → 不可行，需要先限幅
```

## 2. 第二遍：线性归一

```bash
ffmpeg -hide_banner -nostdin -i mix.wav -vn \
  -af "loudnorm=I=-14:TP=-1:LRA=11:\
measured_I=-19.42:measured_TP=-2.31:measured_LRA=7.80:\
measured_thresh=-29.70:offset=0.02:linear=true" \
  -ar 48000 -c:a pcm_s24le mix_norm.wav
```

- `LRA` 用 `max(11, input_lra)`；实测 LRA 大于 11 时填实测值，否则线性不成立。
- `offset` 用首遍的 `target_offset`。
- `-ar 48000` 必加：`loudnorm` 内部 192 kHz，不指定会输出 96 kHz。
- `-vn` 只处理音频；视频母版用 `-c:v copy` 保留画面（见第 5 节）。

## 3. 峰值挡住增益时：限幅 → 再归一

```bash
# 3.1 预增益 + 4 倍过采样限幅（ceiling 0.891 ≈ -1 dBFS，削最多 6 dB）
ffmpeg -hide_banner -nostdin -i mix.wav -vn -af "\
volume=3.5dB,\
aresample=192000,\
alimiter=limit=0.891:attack=5:release=100:level=false,\
aresample=48000" \
  -ar 48000 -c:a pcm_s24le mix_limited.wav

# 3.2 对限幅后的文件重新测量（必须重测，不能沿用限幅前的值）
ffmpeg -hide_banner -nostdin -i mix_limited.wav -vn \
  -af "loudnorm=I=-14:TP=-1:LRA=11:print_format=json" -f null - 2>&1 | tail -n 24

# 3.3 用新测量值做线性第二遍
ffmpeg -hide_banner -nostdin -i mix_limited.wav -vn \
  -af "loudnorm=I=-14:TP=-1:LRA=11:measured_I=<新 input_i>:measured_TP=<新 input_tp>:\
measured_LRA=<新 input_lra>:measured_thresh=<新 input_thresh>:offset=<新 offset>:linear=true" \
  -ar 48000 -c:a pcm_s24le mix_norm.wav
```

替代：只降目标响度，不动动态（适合对白清晰度优先的片子）：

```bash
# 峰值放不下 5.4 dB，就把目标从 -14 降到 -19 左右，线性即可成立
ffmpeg -i mix.wav -af "loudnorm=I=-19:TP=-1:LRA=11:...:linear=true" -ar 48000 out.wav
```

## 4. 其他交付档

```bash
# 播客 -16 LUFS / -1 dBTP
ffmpeg -i ep.wav -af "loudnorm=I=-16:TP=-1:LRA=11:print_format=json" -f null -

# 广电 EBU R128 -23 LUFS / -1 dBTP / LRA ≤ 20
ffmpeg -i master.wav -af "loudnorm=I=-23:TP=-1:LRA=20:print_format=json" -f null -

# 电影感短片 -16 LUFS（横屏，保留动态）
ffmpeg -i film.wav -af "loudnorm=I=-16:TP=-1:LRA=15:print_format=json" -f null -
```

## 5. 视频母版：音轨归一、画面不重编

```bash
ffmpeg -i final.mp4 -i normalized.wav \
  -map 0:v -map 1:a -c:v copy -c:a aac -b:a 192k -ar 48000 \
  -movflags faststart -t "$(ffprobe -v error -show_entries format=duration -of csv=p=0 final.mp4)" \
  final_master.mp4
```

- `-t` 用输入画面时长裁齐，防止 AAC 补齐导致音轨比画面长 0.02–0.1 s。
- `-movflags faststart` 把索引移到文件头，网页播放不用下完。
- 首渲 TP 目标取 `-1.5 dBTP`（比 -1 再低 0.5 dB），编码后复测；若实测仍超 -1，再降 0.5 dB 重渲。

## 6. 批量处理（Bash）

```bash
for f in mixes/*.wav; do
  stats=$(ffmpeg -hide_banner -nostdin -i "$f" -vn \
    -af "loudnorm=I=-14:TP=-1:LRA=11:print_format=json" -f null - 2>&1 | tail -n 24)
  I=$(echo "$stats"  | python3 -c 'import sys,json;print(json.load(sys.stdin)["input_i"])')
  TP=$(echo "$stats" | python3 -c 'import sys,json;print(json.load(sys.stdin)["input_tp"])')
  LRA=$(echo "$stats"| python3 -c 'import sys,json;print(json.load(sys.stdin)["input_lra"])')
  TH=$(echo "$stats" | python3 -c 'import sys,json;print(json.load(sys.stdin)["input_thresh"])')
  OFF=$(echo "$stats"| python3 -c 'import sys,json;print(json.load(sys.stdin)["target_offset"])')
  out="out/$(basename "${f%.wav}")_norm.wav"
  ffmpeg -nostdin -i "$f" -vn \
    -af "loudnorm=I=-14:TP=-1:LRA=11:measured_I=$I:measured_TP=$TP:measured_LRA=$LRA:measured_thresh=$TH:offset=$OFF:linear=true" \
    -ar 48000 -c:a pcm_s24le "$out"
done
```

批处理纪律：每个文件独立测量，禁止把第一条的测量值套给所有文件；失败的条目单独列，不要静默跳过。

## 7. 复测与容差

| 指标 | 命令 | 合格 |
| --- | --- | --- |
| 综合响度 | `ebur128` Summary `I:` | 与目标差 ≤ 1.0 LU |
| 真峰值 | `ebur128=peak=true` Summary `Peak:` 与 `loudnorm` 的 `output_tp` 取较高者 | ≤ 目标 TP + 0.1 dB |
| 响度范围 | `ebur128` Summary `LRA:` | ≤ 设定的 LRA 目标 |
| 时长 | `ffprobe format=duration` | 与输入差 ≤ 0.03 s |
| 采样率 / 声道 | `ffprobe stream=sample_rate,channels` | 48 kHz；交付按平台要求（通常立体声） |
| 静音段 | `ebur128` 分段读 | 数字静音不应被拉到 -40 LUFS 以上 |

`loudnorm` 与 `ebur128` 的真峰值可能差 0.1–0.3 dB（过采样实现不同），取更高值判定，别挑对自己有利的那个。
