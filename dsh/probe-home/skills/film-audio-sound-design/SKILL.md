---
name: film-audio-sound-design
title: 音效与配乐：选材·卡点·混音
description: 把分镜翻成可检索的声音需求，按动作、材质、时长与许可选音效，用节拍网格把切点钉到拍上，再按层级铺 BGM 与 SFX 并做闪避。需要配乐选型、找音效、卡点剪辑、混音层级或交付双版本时用。
tags: 音效, 配乐, BGM, 卡点, 混音, 许可, Freesound
version: 1.0.0
---

# 音效与配乐：选材·卡点·混音

## 何时用

- 分镜已定，要给每个动作配 whoosh / impact / riser / sparkle / transition。
- 用户给了一首 BGM，要求「卡点」，需要先测节拍网格再排切点。
- 要判断音效能不能商用、怎么署名、怎么随片交付。
- 成片人声被音乐盖住、多轨叠起来削波、SFX 听不见或太吵。
- 需要同时交付「带 BGM」和「无 BGM 保留 SFX」两版。
- 不适用：纯旁白（`film-audio-voiceover`）、字幕（`film-subtitle-production`）、成片响度（`film-audio-loudness`）。

## 核心原则

1. **声音是时间线级资产**：SFX 集中写在一张钉帧表里，场景组件/镜头内部不许内嵌音频。
2. **先铺 BGM 定能量骨架，再钉画面独有动作**；强鼓点本身已有节拍，不要给每一拍再加 impact。
3. **按声源选，不按情绪选**：搜「paper slide」不搜「click」；搜「ceramic mug set on wood」不搜「nice sound」。
4. **许可先定再下载**：默认 CC0；要署名才用 CC BY；商用片不接受 BY-NC、Sampling+ 或未知许可。
5. **下载即落本地**：文件、`audio-manifest.json`、署名清单三者同批落盘，渲染时不许联网找音。
6. **音量按实测给**：模板里的 `volume: 0.34` 是乘法系数，不是目标响度；多轨叠加后必须重测峰值。
7. **音乐先行，网格没验收不排分镜**：BPM 与相位用整段 beat 序列拟合，不信 `beat_track` 的 tempo 标量。
8. **两版交付**：带 BGM 与无 BGM（保留 SFX）同时间线出，避免平台二次配乐时打架。

## 工作流

1. **输入**：分镜表（镜号、动作、时长）+ 用户指定音乐（可能没有）。
   动作：为每个镜头写声音需求行：动作、声源/材质、目标时长、攻击/尾音、许可要求。
   产出：`sfx-cue-sheet.csv`（模板见下）。
2. **判断 BGM 路线**：
   分支 A：用户已指定音乐 → 先做节拍网格（第 4 步），再让切点锚到拍。
   分支 B：没有指定 → BGM 选型放到剪辑后段，动效按内容节奏排，不强行卡点。
3. **BGM 选型**：按片种能量选（产品片优先鼓点清楚的电子底；纪录片用低频铺底；口播用无旋律 pad），把候选垫进成片试听，不靠「好听」定稿。
4. **卡点分析**：`librosa` 取 beat 序列 → 最小二乘拟合 `t_i = t0 + i·T` → 得真实 BPM、相位 `t0`、残差。
   验收：残差 ≤ ±15 ms（半帧内）；不通过先分离鼓轨再测。
5. **SFX 检索**：用第 4 节的检索式搜 Freesound，`--license cc0|by`、`--max-duration` 卡时长，保留相关性顺序，本地再按许可/时长过滤。
6. **验收候选**：`ffprobe` + `ffmpeg` 解码，记录格式、采样率、声道、时长、sample peak、整体 RMS、10 ms 能量峰、相对峰值 -40 dB 的活动区间；再把候选垫进片段试听音色、底噪、尾音。
7. **落地**：下载到工程 `public/audio/sfx/`，写 `audio-manifest.json`（来源、作者、素材页、许可 URL/版本、下载时间、SHA-256、改动记录）与 `FREESOUND-CREDITS.md`。
8. **钉帧**：`from` 从镜头表/拍号派生；按实测峰值时间补偿音源攻击段与输出偏移；片头 2 帧内的重音不要设计（补偿做不到）。
9. **混音**：按层级表设 BGM / SFX / 人声 / 环境；说话段压低音乐；多轨叠加后测峰值，超 -1 dBTP 就整体降。
10. **交付与终检**：出带 BGM 与无 BGM 两版；重渲后对 2–3 个探针重跑互相关，残差 ≤ 0.5 帧为合格。

## 关键参数与模板

### SFX 检索式（动作 + 材质 + 时长 + 许可）

```text
[动作] + [材质/物体] + [场景] + [时长/尾音] + [许可]
例：paper slide + cardstock + close + 0.2-0.8s dry single hit + CC0
例：whoosh + fabric + fast pass by + 0.4-0.9s short tail + CC0
例：impact + metal door + interior + 0.8-1.5s deep tail + CC BY
```

| 片种 / 动作 | 检索词骨架 | 时长 | 攻击/尾音 | 备注 |
| --- | --- | --- | --- | --- |
| 运镜 whoosh | `whoosh [材质] fast pass` | 0.3–0.9 s | 软起、短尾 | 与镜头运动同向 |
| 落地/撞击 impact | `impact [材质] heavy` | 0.5–1.5 s | 硬起、长尾 | 低频不要糊住人声 |
| 铺垫 riser | `riser tension build` | 1.5–4 s | 渐强、切在 drop 前一帧 | 长度=build 段长 |
| 光效 sparkle | `sparkle shimmer glass` | 0.4–1.2 s | 软起、金属尾 | 高频，音量压低 |
| 转场 transition | `transition swoosh reverse` | 0.3–0.8 s | 中起、无尾 | 与 xfade 时长对齐 |
| UI 点击 | `ui click tactile` | 0.05–0.2 s | 极短 | 拟音与合成音分开判断 |
| 环境铺底 | `room tone [空间]` | ≥ 10 s 可循环 | 无 | 循环点必须无缝 |

检索纪律：单击/滑动不要选混了多个动作的长录音；下载量与评分只用于排序，不能替代匹配度（400 人评的 4.4 比 6 人评的 4.9 更可信）；上传者描述能提供声源、设备、处理方式线索。

### 声音 cue 表模板（时间线级唯一真源）

```csv
cue_id,shot_id,from_sec,from_frame,sound,asset,peak_at,volume,duck_db,license,credit
sfx01,S03,4.20,126,纸卡滑入,fs:12345,0.14,0.55,0,CC0,-
sfx02,S05,7.60,228,镜头右移 whoosh,fs:23456,0.06,0.45,0,CC0,-
sfx03,S09,15.10,453,金属门 impact,fs:34567,0.03,0.60,-3,CC BY,someone
bgm01,-,0.00,0,主 BGM,assets/audio/bgm/main.mp3,0,0.34,-9,授权文件,-
```

- `from_frame` 由 `from_sec × fps` 取整；`peak_at` 是该素材实测攻击点（10 ms RMS 峰），钉帧时减掉。
- `duck_db` 只对 BGM 与长音效有效，SFX 一般填 0；负值表示与对白重叠时压低。
- 表里一行一个声音事件；同一素材复用要另起一行，方便单独调音量。

### 声音类型与剪辑点

| 剪辑点 | 配什么 | 时长 | 起手位置 |
| --- | --- | --- | --- |
| 硬切（cut） | 无，或极短 whoosh | 0.2–0.4 s | 切点前 1–2 帧 |
| 叠化（dissolve） | 过渡 whoosh / 反向音 | 与叠化等长 | 叠化开始帧 |
| 匹配剪辑（match cut） | 同材质动作声延续 | 跨切点 0.5 s | 前一镜尾 |
| J-cut（声先入） | 下一镜环境或人声 | 提前 0.3–1 s | 上一镜画面内 |
| L-cut（声延后） | 上一镜尾音 | 延后 0.3–1 s | 下一镜画面内 |
| 速度变化（ramp） | riser 或 pitch 变化 | 与变速段等长 | 变速起点 |
| 静止/定格 | 环境铺底抽掉低频 | 全段 | 定格第一帧 |

原则：一个剪辑点只给**一个**主导声音；同帧叠 whoosh + impact + riser 会听成噪音墙。

### 音量层级表（乘法系数 + 目标电平）

| 层 | 相对人声 | 目标（混音内，通用经验值） | 模板系数 | 处理 |
| --- | --- | --- | --- | --- |
| 旁白 / 对白 | 0 dB（基准） | -18 ~ -16 LUFS（段级） | 1.0 | 压缩 2:1，慢起 |
| BGM（说话段） | -12 ~ -18 dB | 闪避后 -30 ~ -26 LUFS | 0.20–0.30 | sidechain 或包络压低 |
| BGM（无对白段） | -6 ~ -10 dB | -24 ~ -20 LUFS | 0.34 | 首尾 0.5–1.5 s 淡入淡出 |
| SFX 主体 | -6 ~ -10 dB | 峰值 -10 ~ -6 dBFS | 0.4–0.6 | 单次、不叠同源 |
| SFX 点缀（sparkle/UI） | -18 ~ -24 dB | 峰值 -24 ~ -18 dBFS | 0.2–0.3 | 高通 200 Hz |
| 环境铺底 | -24 ~ -30 dB | -40 LUFS 以上才当内容 | 0.10–0.15 | 循环无缝、避免低频堆积 |

`volume` 是**乘法系数**，不是 LUFS。改完必须重测：整体真峰值 ≤ -1 dBTP，人声段与 SFX 段互不遮蔽。

### 卡点数值

| 指标 | 合格线 | 说明 |
| --- | --- | --- |
| 节拍网格残差 | ≤ ±15 ms | 半帧内；超过说明曲子变速或检测漂移 |
| 切点/动效误差 | ≤ 3 帧（30 fps ≈ 100 ms） | 感知阈值约 3 帧；实测样板 ≤ 2.2 帧 |
| 补偿后复测残差 | ≤ 0.5 帧 | 重渲后对探针重跑互相关 |
| 探针数量 | 2–3 个 | 片头、中段 drop、片尾各一个 |

BGM 结构（通用经验值，按总时长取比例，卡点片按拍数取整）：

| 段 | 占比 | 作用 | 声音动作 |
| --- | --- | --- | --- |
| intro | 0–10% | 建立调性与空间 | 只留 pad/环境，第 1 个重音落在首个切点 |
| build | 10–45% | 累积张力 | 加 riser、加鼓层，切点密度提高 |
| drop / chorus | 45–70% | 情绪峰值 | 全编制进入，impact 只给关键 1–2 个动作 |
| sustain | 70–88% | 维持不泄气 | 去掉 riser，留主律动 |
| outro | 88–100% | 收束 | 抽掉低频与鼓，末帧前 0.5 s 收干净 |

许可对照（Freesound 路线）：

| 参数 | 允许 | 不允许 |
| --- | --- | --- |
| `--license cc0`（默认） | CC0 | 任何需署名/禁商用 |
| `--license by` | CC0 + CC BY | BY-NC、Sampling+、未知许可 |
| 商用产品片 | CC0 / CC BY（成片或发布页署名） | 预览标记冒充原始无损、来源不明文件 |

细表见 `references/sfx-sourcing-and-rights.md`（检索 CLI、清单字段、署名写法）与 `references/beat-and-mix.md`（节拍拟合代码、ducking 命令、结构模板）。

## 常见坑

- **音效听着对，进片子却「不在点上」**：钉的是文件起点，而音效峰值在 80–200 ms 之后 → 用 10 ms RMS 能量峰定位真实攻击点，按峰值而不是文件头钉帧。
- **每拍一个 impact，越剪越吵**：把鼓点当空白填 → 强鼓点本身已是节拍，impact 只留给画面独有的落地/撞击；同源 impact 连续出现间隔 ≥ 2 拍。
- **人声被音乐糊住**：只降了 BGM 的 `volume` 没做闪避 → 说话段用 sidechain 压 6–12 dB，释放 300 ms；或直接对 BGM 做包络自动化。
- **拿到的是 MP3 预览却当无损交付**：Freesound `get` 下的是高质量有损预览 → 需要无损就走素材页登录下载原文件，并把真实文件类型、地址、哈希写回清单；不要把预览转 WAV 标成「原始无损」。
- **BGM 用了 SFX 的许可**：两条授权线不同 → BGM 授权单独记录（`assets/audio/ATTRIBUTION.md` 一类），不能把 CC0 音效许可套到用户提供的音乐上。
- **改了时间线没重钉**：镜头挪了 1 s，SFX 还在老位置 → 声音表必须从 `SHOTS`/`beatF` 派生，时间线变更后逐条复核并重跑探针。

## 来源与合并说明

| 上游仓库 | ★ | 许可 | 贡献内容 |
| --- | --- | --- | --- |
| calesthio/OpenMontage | 76149 | AGPL-3.0 | `sound-effects`（ElevenLabs SFX 参数与循环）、`music`、`lyria`、`acestep`（BGM 提示词与风格档）、`ffmpeg` 音频命令 |
| Vincentwei1021/video-shotcraft | 16747 | Apache-2.0 | 上游 sound-design、sfx-sourcing、music-beat-sync 三篇参考：钉帧表、Freesound 选材与许可纪律、节拍网格最小二乘拟合、补偿与探针验收 |
| joeseesun/qiaomu-cut-skill | 377 | MIT | `timeline-schema.md` 的音乐/独立音效分层、`bgm` 开关与双版本渲染口径 |
| zenstory-ai/video-recap-skills | 601 | MIT | `video-cut` 的句界/硬切边界处理、声音完整性优先原则 |

- 抓取日期：2026-11-04
- 合并的上游技能：sound-effects、music、lyria、acestep、ffmpeg、sound-design、sfx-sourcing、music-beat-sync、qiaomu-cut-skill（timeline-schema / workflows）
- 冲突与取舍：ElevenLabs 的 `sound-effects` 技能写 `duration_seconds` 支持 0.5–30 s，同仓 `elevenlabs` 教学页写「单次上限 22 秒」—— 两者并列：方案 A 按 0.5–30 s 规划（适用 API 直调）；方案 B 保守取 22 s（适用以 422 报错为准的批量任务），实测超限时按 422 处理并缩短时长。另一处：上游模板用 `volume: 0.34` 表示 BGM，本技能明确它是乘法系数而非响度目标，电平以实测 LUFS/峰值判定。
