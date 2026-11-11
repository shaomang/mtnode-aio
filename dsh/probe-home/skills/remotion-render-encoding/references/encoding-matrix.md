# 编码矩阵与平台交付预设

## 1. 平台交付预设

| 平台 | 分辨率 | fps | 命令关键参数 | 备注 |
| --- | --- | --- | --- | --- |
| 抖音 / Reels / Shorts | 1080×1920 | 30 | `--codec=h264 --crf=18 --pixel-format=yuv420p` | 上传后必被重压，母版留 16 |
| YouTube / B 站 横屏 | 1920×1080 | 30 / 60 | `--codec=h264 --crf=18` | 60fps 时 `durationInFrames` 翻倍 |
| 微信视频号 | 1080×1920 | 30 | `--codec=h264 --crf=20` | 体积敏感 |
| 官网 / 落地页自动播放 | 1280×720 | 25 / 30 | `--codec=h264 --crf=23 --muted` | 静音 + 小体积 |
| 网页透明叠加 | 1920×1080 | 30 | `--codec=vp9 --pixel-format=yuva420p` | 出 `.webm`，Safari 支持有限 |
| 进剪辑软件二次调色 | 原分辨率 | 原 fps | `--codec=prores --pixel-format=yuv422p10le` | 数十 GB 级，注意磁盘 |
| 表情 / 循环预览 | 480×480 | 15 | `--codec=gif` | 无音频，色带明显，控制在 3s 内 |

母版 → 平台版的二次压缩（不重渲，只转码）：

```bash
ffmpeg -i out/main.mp4 -c:v libx264 -crf 20 -preset slow -pix_fmt yuv420p -c:a aac -b:a 128k out/main-upload.mp4
```

## 2. crf 与体积实测（1080×1920 / 30s / 文字动画为主）

| crf | 体积 | 文字边缘 | 判定 |
| --- | --- | --- | --- |
| 16 | ~28MB | 锐利无蚊噪 | 母版 |
| 18 | ~18MB | 锐利 | 默认交付 |
| 20 | ~13MB | 小字略软 | 平台上传 |
| 23 | ~9MB | 细笔画开始糊 | 内部预览 |
| 28 | ~4MB | 明显块状 | 只做节奏检查 |

数值随画面复杂度浮动，看趋势不看绝对值；**文字片对 crf 比实拍更敏感**——大面积纯色 + 细笔画最容易出蚊噪，宁可降一档。

## 3. 透明通道（alpha）出片

```bash
# 方案 A：vp9 + yuva420p（浏览器主流）
npx remotion render src/index.ts Overlay out/overlay.webm \
  --codec=vp9 --pixel-format=yuva420p --image-format=png

# 方案 B：prores 4444（进剪辑软件）
npx remotion render src/index.ts Overlay out/overlay.mov \
  --codec=prores --prores-profile=4444 --pixel-format=yuva444p10le
```

硬要求：

- 画面必须是真透明：`AbsoluteFill` 不能有背景色，根节点 `background: "transparent"`。
- 必须 `--image-format=png`（jpeg 无 alpha）。
- 中间帧会变多、体积变大；透明层越多渲染越慢。
- `h264` 不支持 alpha，别指望 mp4 带透明。

## 4. 音轨参数

```bash
--audio-codec=aac --audio-bitrate=192k     # 交付默认
```

| 场景 | 建议 |
| --- | --- |
| 旁白为主 | `aac 128–192k`，采样率 48kHz |
| 音乐为主 | `aac 192–256k` |
| 只出音频 | `--codec=mp3` 或 `--codec=wav` |
| 静音片 | `--muted`（不写音轨，体积与兼容性都更好） |

音画对齐检查：

```bash
ffprobe -v error -show_entries stream=codec_type,duration,nb_frames -of json out/main.mp4
```

音频与视频时长差 >0.05s 就要查 `Sequence` 端点或 `fps` 是否与素材一致。

## 5. 验片命令（交付前必跑）

```bash
# 1) 结构：有几个流、分辨率、帧率、时长
ffprobe -v error -select_streams v:0 -show_entries stream=width,height,r_frame_rate,nb_frames -of default=nw=1 out/main.mp4

# 2) 抽 5 帧看图（首/尾必抽）
ffmpeg -i out/main.mp4 -vf "select='eq(n\,0)+eq(n\,90)+eq(n\,180)+eq(n\,270)+eq(n\,420)'" -vsync 0 qa_%02d.png

# 3) 单帧全分辨率检查文字描边与安全区
ffmpeg -i out/main.mp4 -vf "select='eq(n\,120)'" -vframes 1 qa_full.png

# 4) 成片整体缩略图（一眼看节奏与黑场）
ffmpeg -i out/main.mp4 -vf "fps=1/2,scale=240:-1,tile=6x4" -frames:v 1 qa_sheet.png
```

判据：

| 检查 | 合格线 |
| --- | --- |
| 首帧 | 不是黑场/空画面（除非设计如此） |
| 末帧 | 有收尾 hold，不是突然断掉 |
| 黑场 | 用 `ffmpeg -vf blackdetect` 扫一遍，非设计黑场一律修 |
| 文字 | 距画面边缘 ≥60px（竖屏左右）、不被平台 UI 遮挡 |
| 时长 | 与脚本预期差 ≤2 帧 |

```bash
# 黑场扫描
ffmpeg -i out/main.mp4 -vf "blackdetect=d=0.1:pix_th=0.10" -an -f null - 2>&1 | grep blackdetect
```

## 6. MTNode / 本机渲染注意

| 项 | 约定 |
| --- | --- |
| 依赖源 | 安装目录的 `node_modules`（`nodeModulesDir` 注入），工程目录不装依赖 |
| 工程与产物 | `.mtnode/remotion/<节点 id>/`，不要写安装目录 |
| 进度 | `render.mjs` 以 JSON Lines 输出 `progress`（0.5% 步进节流），宿主据此画进度条 |
| 失败 | 输出 `{"type":"error","message":...}` 且退出码 1，不要把错误吞成空文件 |
| 覆盖 | 默认不覆盖，重渲要显式 `--overwrite`，否则会验到上一次的旧文件 |
| 浏览器 | 首次渲染会下 Chrome Headless Shell；离线环境必须先预置 |
