# 平台交付参数全集

数值分两类：**上游平台表**（TikTok／Reels／Shorts／YouTube，来自 kajisho5 `_platforms.py`）与**通用经验值**（中文平台与封面尺寸，2026-11 投稿页常见区间，会变）。交付时以平台当前投稿页为准，本表用于提前把参数定下来。

## 1. 完整规格表

| 字段 | 抖音 | 视频号 | 小红书 | B站 | YouTube | TikTok | Reels |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 画幅 | 9:16 | 9:16 或 6:7 | 3:4 优先 | 16:9 | 16:9 | 9:16 | 9:16 |
| 分辨率 | 1080×1920 | 1080×1920／1080×1260 | 1080×1440 | 1920×1080 | 1920×1080（4K 可选） | 1080×1920 | 1080×1920 |
| 帧率 | 30 | 30 | 30 | 30／60 | ≤ 60 | 30 | 30 |
| 时长上限 | 按账号（常见 15 分钟） | 30 分钟 | 15 分钟 | 无硬上限，单文件 ≤ 8 GB | 12 小时 | 600 秒 | 90 秒 |
| 视频编码 | H.264 High | H.264 High | H.264 High | H.264 High | H.264／HEVC／AV1／VP9 | H.264 | H.264 |
| 视频码率 | 8–12 Mbps | 6–10 Mbps | 5–8 Mbps | 6–8 Mbps | 12–16 Mbps | 8–12 Mbps | 8–12 Mbps |
| 像素格式 | yuv420p | yuv420p | yuv420p | yuv420p | yuv420p | yuv420p | yuv420p |
| 音频 | AAC 192k／48 kHz／立体声 | AAC 192k | AAC 192k | AAC 320k | AAC 192k | AAC 128k | AAC 128k |
| 响度 | −14 LUFS／TP −1.0 | −14 LUFS／TP −1.0 | −14 LUFS／TP −1.0 | −14 LUFS／TP −1.0 | −14 LUFS ±2／TP −1.0 | −14 LUFS ±2／TP −1.0 | −14 LUFS ±2／TP −1.0 |
| 封面 | 1080×1440（3:4） | 1080×1260（6:7） | 1080×1440（3:4） | 1146×717（16:10） | 1280×720（16:9） | 1080×1920 | 1080×1920 |
| 字幕 | 烧录 | 烧录 | 烧录 | 软轨 + 简介 SRT | 软轨、多语言 | 烧录 | 烧录 |
| 最小高度 | — | — | — | 720 | 720 | 720 | 720 |

平台表补充（上游口径）：TikTok／Reels／Shorts 只接受 H.264；YouTube 允许 h264／hevc／prores／av1／vp9，单文件上限 256 GB；X 上限 140 秒、512 MB；LinkedIn 1:1／600 秒；Facebook 16:9／4 小时。

## 2. 安全区与文字位置

以 1080×1920 为基准（由 TikTok In-Feed 720×1280 模板的 左80／右120／上160／下440 等比换算）：

| 区域 | 像素 | 说明 |
| --- | --- | --- |
| 顶部 UI 风险带 | `y=0–240` | 状态栏、顶部返回／搜索 |
| 左侧风险带 | `x=0–120` | 头像与关注按钮 |
| 右侧风险带 | `x=900–1080` | 点赞／评论／分享竖栏 |
| 底部 UI 风险带 | `y=1260–1920` | 用户名、文案、音乐条、购物卡 |
| 文字安全矩形 | `x=120–900, y=240–1260` | 关键文字必须整体落在其中 |

推荐版面（学习／解说类）：标题在上方留白约 `y=560`，主字幕在下方留白约 `y=1500`（中文）／`y=1420`（英文），左右边距 120／180。

3:4（1080×1440）与 6:7（1080×1260）没有公开的同级模板，按同一比例留边：左右 ≥ 108 px，上 ≥ 8%，下 ≥ 18%。核查命令见 SKILL.md 模板 5。

## 3. 封面规格与文字下限

| 平台 | 尺寸 | 比例 | 单字最小高度 | 文字区 |
| --- | --- | --- | --- | --- |
| 抖音 | 1080×1440 | 3:4 | 72 px | 中间 80% |
| 视频号 | 1080×1260 | 6:7 | 72 px | 中间 80% |
| 小红书 | 1080×1440 | 3:4 | 72 px | 中间 80% |
| B站 | 1146×717 | 16:10 | 48 px | 中间 85% |
| YouTube | 1280×720 | 16:9 | 54 px | 中间 85% |

- 封面最多 2 行、每行 ≤ 8 个汉字；数字与品牌名单独一行时字号再放大 20%。
- 同一支片的多平台封面可以是同一张主视觉，但必须按比例重排，不做拉伸。

## 4. 多版本导出命令矩阵

| 版本 | 缩放滤镜 | 编码 | 音频 | 备注 |
| --- | --- | --- | --- | --- |
| 9:16 | `scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920` | `libx264 -preset medium -crf 20` | `aac 192k` | 裁满不留黑边 |
| 6:7 | `scale=1080:1260:force_original_aspect_ratio=increase,crop=1080:1260` | 同上 | 同上 | 视频号专用 |
| 3:4 | `scale=1080:1440:force_original_aspect_ratio=increase,crop=1080:1440` | 同上 | 同上 | 小红书专用 |
| 16:9 | `scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2` | `libx264 -preset slow -crf 20` | `aac 192k` | 保留完整画面 |
| 1:1 | `scale=1080:1080:force_original_aspect_ratio=increase,crop=1080:1080` | `libx264 -preset medium -crf 20` | `aac 192k` | 朋友圈／备用 |
| 4K | `scale=3840:2160:force_original_aspect_ratio=decrease,pad=3840:2160:(ow-iw)/2:(oh-ih)/2` | `libx264 -preset slow -crf 21 -level 5.1` | `aac 192k` | YouTube 专用 |

所有命令都要带：`-pix_fmt yuv420p -r 30 -g 60 -movflags +faststart`；音频带 `-ar 48000 -ac 2`。

PowerShell 批量导出（把 `$specs` 按项目改掉即可）：

```powershell
$master = "out/master.mov"
$specs = @(
  @{ name = "douyin_1080x1920";       w = 1080; h = 1920; fit = "crop"; preset = "medium"; crf = 20 },
  @{ name = "shipinhao_1080x1260";    w = 1080; h = 1260; fit = "crop"; preset = "medium"; crf = 20 },
  @{ name = "xiaohongshu_1080x1440";  w = 1080; h = 1440; fit = "crop"; preset = "medium"; crf = 20 },
  @{ name = "bilibili_1920x1080";     w = 1920; h = 1080; fit = "pad";  preset = "slow";   crf = 20 }
)
foreach ($s in $specs) {
  if ($s.fit -eq "crop") {
    $vf = "scale=$($s.w):$($s.h):force_original_aspect_ratio=increase,crop=$($s.w):$($s.h),setsar=1"
  } else {
    $vf = "scale=$($s.w):$($s.h):force_original_aspect_ratio=decrease,pad=$($s.w):$($s.h):(ow-iw)/2:(oh-ih)/2,setsar=1"
  }
  & ffmpeg -y -i $master -vf $vf -c:v libx264 -preset $s.preset -crf $s.crf -profile:v high -pix_fmt yuv420p -r 30 -g 60 -c:a aac -b:a 192k -ar 48000 -ac 2 -movflags +faststart "out/deliver/$($s.name).mp4"
  if ($LASTEXITCODE -ne 0) { Write-Error "导出失败: $($s.name)"; break }
}
```

## 5. 时长裁剪与分平台版本差异

```bash
# 抖音取 60 秒版（从开头截，保留钩子）
ffmpeg -y -i out/deliver/douyin_1080x1920.mp4 -t 60.000 -c:v libx264 -preset medium -crf 20 -c:a aac -b:a 192k -movflags +faststart out/deliver/douyin_60s.mp4

# B站保留完整长版；YouTube 追加片尾 5 秒 CTA 卡（黑场 + 静音）
ffmpeg -y -i out/deliver/bilibili_1920x1080.mp4 -f lavfi -i "color=c=black:s=1920x1080:d=5:r=30" -f lavfi -i "anullsrc=r=48000:cl=stereo" -filter_complex "[0:v][1:v]concat=n=2:v=1:a=0[v];[0:a][2:a]concat=n=2:v=0:a=1[a]" -map "[v]" -map "[a]" -c:v libx264 -preset slow -crf 20 -pix_fmt yuv420p -c:a aac -b:a 192k -shortest -movflags +faststart out/deliver/youtube_with_cta.mp4
```

- 同一支片的短版不是长版的截断：短版要重写钩子与结尾，否则第 55 秒会停在半句话上。
- 横屏改竖屏时，若原片字幕已烧录，必须在竖屏版上遮罩或重排，不能直接裁。

## 6. 交付前核对表

| 检查项 | 命令／方法 | 通过标准 |
| --- | --- | --- |
| 分辨率 | `ffprobe -select_streams v:0 -show_entries stream=width,height` | 与平台表完全一致，且为偶数 |
| 帧率 | `ffprobe -show_entries stream=r_frame_rate,avg_frame_rate` | 两者相等且为 30／1 或 60／1 |
| 时长 | `ffprobe -show_entries format=duration` | 不超过平台上限，误差 ≤ 0.1 秒 |
| 码率 | 文件字节 × 8 ÷ 时长 | 落在平台区间内 |
| 音频 | `ffprobe -select_streams a:0 -show_entries stream=codec_name,sample_rate,channels` | `aac`／48000／2 |
| 响度 | `ffmpeg -af loudnorm=...:print_format=json -f null -` | I 在 −14 ±1，TP ≤ −1.0 |
| 像素格式 | `ffprobe -show_entries stream=pix_fmt` | `yuv420p` |
| 起播 | `ffprobe -show_entries format_tags` 或二进制查 `moov` 位置 | `faststart` 生效 |
| 安全区 | 抽首／中／末帧叠参考线 | 标题、字幕、CTA 全在安全矩形内 |
| 封面 | 打开缩略图尺寸预览 | 字可读，未被裁切 |

## 7. 交付目录与命名

```text
out/
├─ master.mov                     # ProRes 422 HQ 母版
├─ master.mp4                     # H.264 CRF 18 母版
├─ delivery-plan.md               # 平台参数与版本清单
├─ deliver/
│  ├─ douyin_1080x1920.mp4
│  ├─ shipinhao_1080x1260.mp4
│  ├─ xiaohongshu_1080x1440.mp4
│  └─ bilibili_1920x1080.mp4
├─ cover/
│  ├─ douyin_cover.jpg
│  ├─ xhs_cover.jpg
│  ├─ bilibili_cover.jpg
│  └─ youtube_cover.jpg
└─ subs/
   ├─ zh.ass
   ├─ zh.srt
   └─ en.srt
```

命名规则：`平台_宽x高[_语言][_版本].mp4`；不用「最终版」「最终版2」这类名字，版本用 `v01`／`v02`。
