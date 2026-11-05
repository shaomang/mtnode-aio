# 字幕样式、安全区与烧录

## 1. 安全区（像素，按平台模板等比换算）

换算公式：`目标像素 = 官方模板像素 × 目标边长 / 模板边长`。UI 会随设备、文案长度、广告组件变化，固定坐标只是保守基线，最终以平台预览为准。

| 画布 | 左 | 右 | 上 | 下 | 核心矩形 |
| --- | ---: | ---: | ---: | ---: | --- |
| 720×1280（TikTok 模板原值） | 80 | 120 | 160 | 440 | x=80–600, y=160–840 |
| 1080×1920（等比） | 120 | 180 | 240 | 660 | x=120–900, y=240–1260 |

各平台 UI 占比（可直接乘画面尺寸）：

| 平台 | 上 | 下 | 左 | 右 | 1080×1920 时（上/下/左/右 px） |
| --- | ---: | ---: | ---: | ---: | --- |
| TikTok | 10% | 22% | 5% | 14% | 192 / 422 / 54 / 151 |
| Instagram Reels | 8% | 20% | 5% | 12% | 154 / 384 / 54 / 130 |
| YouTube Shorts | 6% | 18% | 5% | 12% | 115 / 346 / 54 / 130 |
| YouTube / X / LinkedIn / Facebook | 5% | 5% | 5% | 5% | 96 / 96 / 54 / 54 |

抖音官方没有与 TikTok In-Feed 同等稳定的带像素标注文件；同一条 9:16 同时投抖音与 TikTok 时，用上表 `x=120–900, y=240–1260` 当风险参考，不要把它当硬框压扁所有文字。发布前用平台预览叠加检查，不要只看静帧。

## 2. 两套竖屏字号方案（并列，按片种选）

| 方案 | 字号 | 位置 | 适用 | 代价 |
| --- | --- | --- | --- | --- |
| A：平台大字幕 | 画面高 8.33%（ASS 288 网格 `FontSize=24`） | 底部安全区之上 | 抖音/Reels/Shorts 信息流，静音也要看懂 | 占画面多，长句必须拆 |
| B：教学片三层 | Note 56 px / English 84 px / Chinese 66 px（1080×1920 固定坐标） | y=560 / 1420 / 1560 | 影视解说、双语教学、需要保留画面 | 字号小，必须近距离观看 |

方案 B 的左右边距用非对称 120/180，给右侧操作栏留空间；长句换行后整体仍要在安全矩形内，超过两行缩文案或拆 cue，不优先缩字号。

横屏（1920×1080）对应：方案 A 约 6.94% 画面高（`FontSize=20`），方案 B 每层按 2/3 缩放（Note 40 / English 56 / Chinese 44 px），底边距 ≥ 48 px。

## 3. ASS 样式模板（1080×1920，方案 B）

```ass
[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Note,Noto Sans CJK SC,56,&H00FFFFFF,&H000000FF,&H00000000,&H64000000,1,0,0,0,100,100,0,0,1,2,1,8,120,180,560,1
Style: English,Noto Sans CJK SC,84,&H00FFFFFF,&H000000FF,&H00000000,&H64000000,1,0,0,0,100,100,0,0,1,3,1,2,120,180,420,1
Style: Chinese,Noto Sans CJK SC,66,&H00FFFFFF,&H000000FF,&H00000000,&H64000000,1,0,0,0,100,100,0,0,1,3,1,2,120,180,300,1
Style: BigChinese,Noto Sans CJK SC,120,&H00FFFFFF,&H000000FF,&H00000000,&H64000000,1,0,0,0,100,100,0,0,1,4,1,2,120,180,360,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.20,0:00:03.80,English,,0,0,0,,One word. {\c&H00D2FF&}Three layers.
Dialogue: 0,0:00:00.20,0:00:03.80,Chinese,,0,0,0,,一个词，三层意思。
```

口径：

- `Alignment=2` 底部居中、`8` 顶部居中；`MarginV` 是距该边缘的距离（底部样式填「底边到文字底部」）。
- 颜色是 `&HBBGGRR`（BGR，不是 RGB）；强调色用内联 `{\c&H00D2FF&}`。
- 描边 2–3 px + 阴影 1 px 足够；不要用不透明底色块盖住画面（除非平台强制）。
- 字体必须是**实际存在的文件**，`FontName` 与文件 family 一致；缺中文字形时 libass 会静默替换成方框或缺字。

## 4. 烧录 vs 软字幕

| 方式 | 命令要点 | 适用 | 代价 |
| --- | --- | --- | --- |
| 软字幕（mux） | `-c:s mov_text` / `-c:s copy`，不重编码 | 平台支持字幕轨、需要多语切换、要保留可编辑 | 部分平台不显示，样式受播放器控制 |
| 烧录（burn） | `-vf subtitles=...`，必重编码视频 | 竖屏信息流、样式必须固定、平台只认画面 | 不可关闭、改字要重渲 |
| 双份交付 | 同时出 `out.mp4`（软）+ `out_burn.mp4`（烧） | 客户既要审核又要发布 | 体积翻倍，需注明版本 |

```bash
# 软字幕（推荐默认）
ffmpeg -i final.mp4 -i subs.srt -map 0 -map 1:0 -c:v copy -c:a copy \
  -c:s mov_text -metadata:s:s:0 language=zho -metadata:s:s:0 title="中文" out.mp4

# 烧录（ASS 样式 + 项目字体目录）
ffmpeg -i final.mp4 -vf "ass=subs.ass:fontsdir=fonts" \
  -c:v libx264 -crf 18 -preset medium -c:a aac -b:a 192k out_burn.mp4

# 烧录后确认字幕流与时长
ffprobe -v error -show_entries stream=index,codec_type,codec_name -of csv out_burn.mp4
```

顺序铁律：**fit 到交付尺寸 → 烧字幕 → 编码交付**。在 1280×720 烧完再放大的竖屏成片，字会明显发虚（1280 宽的 9:16 实际只有 406×720 有效画面）。

## 5. 动态字幕

| 动画 | 参数 | 适用 | 注意 |
| --- | --- | --- | --- |
| `fade` | 0.15–0.25 s | 纪录片、访谈 | 最稳，不抢注意力 |
| `pop` | 缩放 100%→112%→100%，0.2 s | 竖屏信息流 | 每条都 pop 会累 |
| `slide-up` | 需给 `pos: [x, y]` 起点 | 章节标题、金句 | 没有明确路径就不要用 |
| `word-follow` / `karaoke` | 需显式 `segments`（文本 + durationMs） | 口播跟读、教学 | 中文自动按字切会破坏语义节奏 |
| `typewriter` | 逐字 8–10 字/秒 | 代码、命令演示 | 纯英文可到 18 字符/秒 |

卡拉OK/逐词高亮底层走 ASS `\kf` 时间，可复现；中文必须手写 `segments`，不要让渲染器按字均分。

## 6. 验收

1. 出 `preview` 档，看至少一张与设备等宽的单帧（540×960 或 1080×1920），不用缩略图判断字号。
2. 叠加平台 UI 预览：含长发布文案、锚点、购物卡时用更严格模板。
3. 先查字幕是否盖住人物脸、原片字幕、关键道具；再查平台 UI 风险。两者冲突时重排画面留白，不把字压回画面。
4. 抽 3 帧：首条（是否被顶部 UI 挡）、最长条（是否出安全区）、双语条（两层是否重叠）。
5. 软字幕版与烧录版逐条比对文本一致（不得因换行/缩写产生差异）。
6. 记录字体文件名与许可；不得随片分发从本机发现的商用字体。
