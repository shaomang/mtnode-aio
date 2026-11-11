# 编码参数、码率与硬件编码差异

## 1. CRF 与画质／体积

x264／x265 的 CRF 是「恒定质量」标度，不是码率。同一个 CRF 在不同素材上体积差别很大（静止访谈 vs 快切游戏画面可差 3 倍）。

| 用途 | CRF | preset | 说明 |
| --- | --- | --- | --- |
| 中间件／母版 | 18 | medium → slow | 视为视觉无损，反复剪辑不心疼 |
| 社交交付 1080p | 20 | medium | 平台会二压，18 的边际收益低于码率上限 |
| 社交交付 4K | 20–21 | slow | 4K 下同 CRF 体积约为 1080p 的 2.5–3 倍 |
| HEVC 交付 | 24 | medium | 同画质体积约为 x264 CRF 20 的 60–70% |
| 代理／预览 | 30 | veryfast | 只求能拖时间线，不用于任何交付 |

同画质对比（通用经验值，需按素材实测）：`CRF 18 + slow` 约比 `CRF 18 + medium` 小 5–12%；`CRF 23` 体积约为 `CRF 18` 的 45–60%。

## 2. 码率换算

```text
目标码率(kbps) = 目标体积(MB) × 8 × 1024 ÷ 时长(秒)
目标体积(MB)   = 码率(kbps) × 时长(秒) ÷ 8 ÷ 1024
```

| 分辨率／帧率 | 常用视频码率 | 说明 |
| --- | --- | --- |
| 1080p30 | 6–10 Mbps | 口播、图文、横屏交付 |
| 1080p60 | 10–16 Mbps | 游戏、运动、快切 |
| 1080×1920 竖屏 30 | 8–12 Mbps | 抖音／视频号／Reels 类 |
| 2160p30 | 35–50 Mbps | YouTube 4K 上传 |
| 音频 | 128–192 kbps AAC | 48 kHz；音乐类给 256 kbps |

平台二压普遍在 1080p 6–8 Mbps 区间，超过 12 Mbps 的收益主要体现在锐利文字与渐变，不在实拍细节。

## 3. 像素格式与色彩

| 场景 | `-pix_fmt` | 附加参数 |
| --- | --- | --- |
| SDR H.264 交付 | `yuv420p` | `-profile:v high -level 4.1` |
| SDR HEVC 交付 | `yuv420p` | `-tag:v hvc1` |
| HDR10 HEVC | `yuv420p10le` | `-profile:v main10 -color_primaries bt2020 -color_trc smpte2084 -colorspace bt2020nc` |
| HLG（iPhone 默认） | `yuv420p10le` | `-color_trc arib-std-b67` 保留原标记 |
| ProRes 母版 | `yuv422p10le` | `-c:v prores_ks -profile:v 3` |
| 带 alpha 的素材 | `yuva444p10le` | 只用于中间件，交付前必须合成到背景 |

HDR 转 SDR（不要只改标签）：

```bash
ffmpeg -y -i hdr.mp4 -vf "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p" -c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p -c:a copy out/sdr.mp4
```

保留 HDR 直接重编码：

```bash
ffmpeg -y -i hdr.mp4 -c:v libx265 -preset medium -crf 22 -pix_fmt yuv420p10le -profile:v main10 -tag:v hvc1 -color_primaries bt2020 -color_trc smpte2084 -colorspace bt2020nc -c:a copy out/hdr_hevc.mp4
```

- 判断 HDR 的依据是 `color_transfer=smpte2084`（PQ）或 `arib-std-b67`（HLG），不是文件名。
- BT.2020 SDR 素材（宽色域但 SDR 传输）同样不能直接打 BT.709 标签，交付前先 `zscale` 转 BT.709。

## 4. 帧率与关键帧

| 参数 | 建议值 | 原因 |
| --- | --- | --- |
| `-r 30` | 交付统一 30（或 25／60） | 混帧率拼接会累积音画漂移 |
| `-fps_mode cfr` | VFR 源必加 | 手机／录屏是 VFR，不加会得到时长对但节奏抖的成片 |
| `-g 60` | 30fps 时 2 秒一个 I 帧 | 平台切片、拖动预览、二次剪辑都依赖它 |
| `-keyint_min 60` | 与 `-g` 相同 | 防止编码器插入过多关键帧撑大体积 |
| `-bf 2` | 默认 | B 帧提高压缩率；`-c copy` 裁切时 B 帧会让末点吸附 |
| `-sc_threshold 0` | 需要固定 GOP 时 | 关闭场景切换自动插 I 帧 |

## 5. 硬件编码差异

| 编码器 | 质量参数 | 码控 | 与 CPU 的差异 |
| --- | --- | --- | --- |
| `libx264` | `-crf 18` | CRF | 基准；同画质体积最小，速度最慢 |
| `h264_nvenc` | `-cq 21` | `-rc vbr -b:v 0` | 同画质码率约高 10–30%（通用经验值）；`-cq` 与 `-crf` 不可直接互换 |
| `h264_qsv` | `-global_quality 21` | ICQ | 同画质略高于 NVENC；老核显对 10bit 支持不全 |
| `h264_amf` | `-rc cqp -qp_i 20 -qp_p 22` | CQP | 暗部与渐变劣化更明显，交付慎用 |
| `h264_videotoolbox` | `-q:v 71` | 质量档 | `q:v = 75 − 2.2 × (crf − 18)`（H.264）；同画质体积为 x264 的 1.1–2.9 倍 |

NVENC 完整命令：

```bash
ffmpeg -y -i master.mov -c:v h264_nvenc -preset p5 -tune hq -rc vbr -cq 21 -b:v 0 -maxrate 12M -bufsize 24M -profile:v high -pix_fmt yuv420p -c:a aac -b:a 192k -ar 48000 -ac 2 -movflags +faststart out/deliver_nvenc.mp4
```

QSV 完整命令：

```bash
ffmpeg -y -i master.mov -c:v h264_qsv -preset medium -global_quality 21 -look_ahead 1 -profile:v high -pix_fmt nv12 -c:a aac -b:a 192k -movflags +faststart out/deliver_qsv.mp4
```

- 硬件编码不做真正意义上的两遍分析，必须显式给 `-maxrate`／`-bufsize`，否则码率尖峰会被平台二压成块。
- 硬件编码失败时（驱动、会话数、分辨率上限）优先退回 CPU，不要在交付前临场调驱动。
- `-pix_fmt nv12` 是 QSV 的输入偏好，输出仍是 `yuv420p`；写 `yuv420p` 让 ffmpeg 自动转换也可，但多一次拷贝。

## 6. 版本与构建差异（6.1 至 8.x）

| 变化 | 影响 | 应对 |
| --- | --- | --- |
| `-vsync` 弃用 | 旧脚本报警告 | 改用 `-fps_mode cfr`（或 `vfr`／`passthrough`） |
| `-crf` 上限校验 | x264／x265 上限 51，SVT-AV1 上限 63 | 超上限会被拒；18 视为视觉无损 |
| `libsvtav1` 的 `-preset` 是数字 | `-preset 6` 而非 `medium` | AV1 交付时显式写数字 |
| VideoToolbox 质量档语义变化 | `-q:v` 与旧版不完全等价 | 升级 ffmpeg 后重跑一条样片对比 |
| `-movflags` 与 `-tag:v` 在部分封装被忽略 | MKV 不认 `+faststart` | 交付统一 MP4／MOV |

自检命令：

```bash
ffmpeg -hide_banner -version
ffmpeg -hide_banner -h encoder=libx264
ffmpeg -hide_banner -h encoder=h264_nvenc
```

## 7. 参数核对清单（每次交付前）

```bash
ffprobe -v error -select_streams v:0 -show_entries stream=codec_name,profile,width,height,pix_fmt,r_frame_rate,avg_frame_rate,bit_rate -of default=nw=1 out/final.mp4
ffprobe -v error -select_streams a:0 -show_entries stream=codec_name,sample_rate,channels,bit_rate -of default=nw=1 out/final.mp4
ffprobe -v error -show_entries format=duration,size,bit_rate,format_name -of default=nw=1 out/final.mp4
```

- 分辨率必须是偶数；奇数宽高在多数编码器上直接失败，用 `scale=trunc(iw/2)*2:trunc(ih/2)*2` 兜底。
- `avg_frame_rate` 与 `r_frame_rate` 在交付件里必须相等，否则说明还是 VFR。
- 有音轨时 `channels=2`、`sample_rate=48000`；单声道交付在手机上会偏左。
