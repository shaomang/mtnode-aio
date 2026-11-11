# 音轨与母版交付检查表

## 1. 逐项验收（全部打勾才交付）

| # | 检查项 | 命令 / 方法 | 合格判据 |
| ---: | --- | --- | --- |
| 1 | 综合响度 | `ebur128` Summary `I:` | 与目标差 ≤ 1.0 LU |
| 2 | 真峰值 | `ebur128=peak=true` + `loudnorm.output_tp` 取高者 | ≤ 目标 TP + 0.1 dB |
| 3 | 响度范围 | `ebur128` `LRA:` | ≤ 设定 LRA（流媒体 11、广电 ≤ 20） |
| 4 | 归一模式 | 首遍 JSON `normalization_type` | 期望 `linear`；`dynamic` 必须写明原因 |
| 5 | 限幅量 | 限幅链的预增益与削减量 | ≤ 6 dB，且记录实际削减 |
| 6 | 时长 | `ffprobe format=duration` | 与输入差 ≤ 0.03 s |
| 7 | 采样率 | `ffprobe stream=sample_rate` | 48 kHz（不是 96 kHz） |
| 8 | 声道 | `ffprobe stream=channels` | 与平台要求一致（通常 2） |
| 9 | 编码 | `ffprobe stream=codec_name` | 视频 AAC 192 kbps 起；音频交付 AAC 256 kbps 或 PCM 24-bit |
| 10 | 静音/环境段 | 分段 `ebur128` | 原本 ≤ -40 LUFS 的段落没被拉起 |
| 11 | 相位 | 单声道兼容试听 | 人声不空、低频不塌 |
| 12 | 削波听感 | 全片过一遍 | 无「咔」声、无爆点 |
| 13 | 头尾 | 听首 3 s / 末 3 s | 无突然截断、无残留尾音被切 |
| 14 | 元数据 | `ffprobe -show_entries format_tags` | 标题、语言、日期按项目要求 |
| 15 | 多平台版本 | 每个平台单独一版 | 没有用一个文件冒充全部平台 |

## 2. 平台版本对照

| 平台 | LUFS | TP | 封装 / 编码 | 额外 |
| --- | ---: | ---: | --- | --- |
| TikTok / Reels / Shorts | -14 | -1 dBTP | MP4 / AAC 192 kbps / 48 kHz | 竖屏；字幕在安全区内 |
| YouTube（信息流口径） | -14 | -1 dBTP | MP4 / AAC 192 kbps | `-movflags faststart` |
| YouTube（叙事短片口径） | -16 | -1 dBTP | 同上 | 与同批片子统一，不混用 |
| 播客 | -16 | -1 dBTP | MP3 192 kbps 或 AAC 256 kbps | 单声道可选；章节标记另附 |
| 广电 EBU R128 | -23 | -1 dBTP | MXF / PCM 24-bit 48 kHz | LRA ≤ 20；头尾留黑场与静音 |
| 影院母版（通用经验值） | 对白锚定 -27 | -2 dBTP | PCM 24-bit 48 kHz | 需按影院校准，不用于网络分发 |

## 3. 报告模板（随片交付）

```json
{
  "file": "final_master.mp4",
  "target": {"lufs": -14.0, "tp": -1.0, "lra": 11.0, "platform": "tiktok"},
  "measured": {"lufs": -14.1, "tp": -1.2, "lra": 7.4, "duration": 63.48},
  "normalization": {"mode": "linear", "limiter_used": true, "limiter_max_db": 3.5, "gain_capped_db": 0.0},
  "codec": {"audio": "aac", "bitrate": "192k", "sample_rate": 48000, "channels": 2},
  "checks": {"lufs_ok": true, "tp_ok": true, "duration_ok": true, "silence_untouched": true},
  "source": {"mix": "mix_v7.wav", "sha256": "<64 hex>"}
}
```

`gain_capped_db > 0` 表示为了不超真峰值，实际响度低于目标；这个差值必须写出来，不能只报「已达标」。

## 4. 常见退片原因（按出现频率）

| 症状 | 根因 | 修法 |
| --- | --- | --- |
| 上传后整体变小 | 真峰值超 0 dBTP，平台统一压 | TP 目标 -1.5 dBTP 重渲，编码后复测 |
| 声音忽大忽小 | 单遍 loudnorm 动态模式 | 两遍线性；LRA 太宽先做混音压缩 |
| 人声被音乐盖住 | 只做了整体响度，没做分层 | 回混音：BGM 闪避 6–12 dB，人声段单独测 |
| 片尾被截 | AAC 补齐或 `-t` 用错 | 用画面时长裁齐，末帧留 0.3–0.5 s 余量 |
| 音频比画面长 0.1 s | 编码帧对齐 | `-t <输入时长>`；把时长纳入验收 |
| 底噪被放大 | 对 -40 LUFS 以下段落做了语音归一 | 跳过归一并在报告里写明「素材近乎无声」 |
| 送到广电被退 | 只按 -14 交付 | 单独出 -23 LUFS / LRA ≤ 20 版本 |

## 5. 不能声称的事

- 「-14 LUFS 达标」不等于「听感好」：响度是交付规范，不是混音质量。
- 短于约 10 秒的片段，`loudnorm` 的综合响度测量不稳定（门限块数太少），要结合整段节目测，别拿 5 秒样片定母版（通用经验值）。
- `loudnorm` 与 `ebur128` 数值不完全一致属实现差异，只能取更保守值，不能声称「精确到 0.01 LU」。
- 没有做过 AB 试听就不要写「动态处理自然」「对白清晰度提升」。
