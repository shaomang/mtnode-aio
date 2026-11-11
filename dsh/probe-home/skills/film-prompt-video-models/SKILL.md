---
name: film-prompt-video-models
title: 视频模型提示词骨架
description: 按 Seedance 2.0/2.5、Kling 3.0、Veo 3.1、Sora、MiniMax H3 等模型的字段结构写可直接粘贴的视频提示词：定规格、选骨架、排时间轴、锁参考、写声音，并给出跨模型差异表与参数上限。
tags: 视频提示词,模型差异,Seedance,Kling,镜头结构,参数上限
version: 1.0.0
---

# 视频模型提示词骨架

同一句创意，喂给不同模型要换骨架。本技能解决三件事：**先定模型规格 → 选对骨架 → 按该模型的字段顺序填内容**。词表在 `film-prompt-cinematography`，参考图在 `film-prompt-keyframe-image`，跨镜锁定在 `film-prompt-consistency`，返修在 `film-prompt-qc`。

## 何时用

- 用户要把一段创意/剧本/分镜写成「可直接粘贴到视频模型」的提示词，且还没定用哪个模型。
- 已定模型（Seedance 2.0 / 2.5、Kling 3.0、Veo 3.1、MiniMax H3、Wan、LTX-2），需要知道该模型的时长上限、画幅档、参考素材配额、是否原生音频。
- 要把一条已经写好的提示词从 A 模型迁到 B 模型（结构不变、字段与口头禅要换）。
- 要判断「这条需求该不该拆成多次生成」——时长与镜头数是否超出单次能力。
- 不适用：只写首帧/关键帧图像提示词；只要运镜词表；只做已有片段的返修诊断。

## 核心原则

1. **先定模型，再定结构。** 模型的时长上限、画幅档、参考配额、有无原生音频，直接决定骨架能写多长。先查参数，再动笔。
2. **结构声明放第一句。** Seedance 系对「这是什么形态」极其敏感：`Montage, multi-shot Hollywood action, don't use one camera angle or single cut` / `Single continuous shot, first-person POV`。第一句没声明形态，后面写得再好也会被剪成一堆碎镜。
3. **时间轴必须带秒。** 用 `0–3s: … 3–6s: …` 或 `Shot 1 … Hard cut. Shot 2 …`。多镜头生成的实测节奏是 **每镜约 2.5 秒**（15s ≈ 6 镜）。
4. **一镜一个主运镜。** 同一镜叠加 handheld + 上升 + 推近 + 变焦，结果必然是画面抖成废片。复合运镜要写成分阶段：`Camera rises 0–3s, holds, then pushes in 4–8s`。
5. **约束正着写。** 不用尾部 negative prompt 兜底，改成命名块里的正向声明：`COUNT LOCK: exactly four, never five`、`the set contains only what the reference shows`。FLUX 系明确不支持 negative prompt；Seedance 的约束要落在 `POSITIVE LOCKS` 块。
6. **数值化，不写形容词。** 速度写 `40 km/h`，雾写 `fog density 40%`，色温写 `3200K / 4000K / 5600K / 8500K`（同场景内固定），身高写 `165 cm / 178 cm`。`fast`、`epic`、`cinematic` 是退化最快的词。
7. **参考素材先映射角色，再写正文。** 每张图/每段视频只锁一件事（身份 / 场景 / 道具 / 风格 / 动作），并在提示词里点名：`@Image1 as the main character`、`视频1只参考闪避步法与动作衔接，不继承人物、场景和声音`。
8. **时长是天花板，不是目标。** 一个动作只值 6 秒就写 6 秒。为凑 30 秒加戏，是最常见的崩片原因。

## 工作流

1. **定规格（输入：用户需求）** → 查第 4 节「模型差异表」，锁定 `模型 + duration + aspect_ratio + resolution + 是否原生音频 + 参考配额`。产出：一行规格声明，例如 `Seedance 2.5 / 4–30s 取 12s / 21:9 / 720p / generate_audio=true / 2 图 1 视频`。
2. **判是否要拆（分支）** → 若「镜头数 × 2.5s > 时长上限」或「剧情转折 > 2 个」，拆成多条，每条自成一个完整小弧。不拆的代价是每条都拍不完。
3. **选骨架（分支）**：
   - 通用/跨模型/中文平台 → 方案 A 五段式（第 4 节模板 A）。
   - Seedance 2.0 动作/变身/多镜 → 方案 B 开场声明 + 分镜时间轴（模板 B）。
   - Seedance 2.5 长片/多参考 → 方案 C 九段 section order（模板 C）。
   - 单镜简单镜头 → 方案 D 八段式（模板 D）。
4. **写开场结构声明** → 从模板 B 的三条开场里挑一条原样贴，再往下扩写。不要自己造开场句。
5. **排时间轴** → 每个 beat 写「动作 + 镜头 + 特效」三件套；多镜版写「景别 + 构图 + 运镜 + 画面内容」四件套。给出每镜的秒数与切点（`Hard cut` / `SMASH CUT`）。
6. **填人物与参考** → 按第 4 节「身份锚点句」堆叠 3–5 条；参考素材写明角色与排除项。
7. **填光与色** → 一段场景级光 Baseline（光源、方向、落在脸上的效果）+ 一句色彩/胶片响应。Seedance 2.5 的 `GLOBAL STYLE` 与 `LIGHTING` 必须显式写，因为 API 路由没有 genre 选择器。
8. **填声音** → 环境音 1 条 + 拟音 1–2 条 +（可选）音乐质感 1 条；默认 `No music, no discernible dialogue`，除非场景需要。
9. **自检交付** → 核对第 4 节「字数与时长上限」，然后交付：提示词 + 3 行说明（模型适配 / 先试哪一段 / 一条该模型的注意事项）。用户只要求改某一段时，只重写那一段。

## 关键参数与模板

逐模型的模型 ID、计价、模式路由与参数自检清单见 `references/model-parameter-tables.md`。

### 模型差异表（数值均来自源）

| 模型 | 单次时长 | 画幅 | 分辨率 | 参考配额 | 原生音频 | 吃哪一套描述 |
| --- | --- | --- | --- | --- | --- | --- |
| Seedance 2.5 | 4–30s（默认 5） | auto / 21:9 / 16:9 / 4:3 / 1:1 / 3:4 / 9:16 | 480p / 720p / 1080p（无 4K） | ≤30 图、≤10 视频、≤10 音频；含首尾帧总量 ≤50 | 是（`generate_audio` 默认 true） | 九段 section order + 命名锁 + 逐镜 `Hard cut` |
| Seedance 2.0 | 4–15s | auto / 21:9 / 16:9 / 4:3 / 1:1 / 3:4 / 9:16 | 480p / 720p / 1080p / 4k | 9 图 + 3 视频 + 3 音频（共 12 项） | 是 | 开场结构声明 + 时间轴 beat + 显式否定运镜 |
| Seedance 2.0 Fast | 4–15s | 同上 | 480p / 720p（无 1080p/4K） | 同上 | 是 | 同上，但首次不要用于慢动作/多镜/推轨 |
| Kling 3.0 | 3–15s | 16:9 / 9:16 / 1:1 | `mode` std / pro / 4k | 参考图 + 首尾帧（`start_image` / `end_image`） | 是 | 清晰的时间顺序动作 + 运镜动词 + 简洁 negative |
| Kling 3.0 Turbo | 3–15s | 16:9 / 9:16 / 1:1 | 720p / 1080p | 单张起始帧动画 | 是 | 同上，预算档 |
| Veo 3.1 | 4 / 6 / 8s | 16:9 / 9:16 | 目录暴露 `quality` basic / high / ultra | 目录仅暴露 `start_image` 角色（其余能力在 UI） | 是 | 描述性散文 + 参考图/首尾帧 + 明确声音意向 |
| Sora 2 | 4–12s（已退役） | — | 720p 基础 / 1080p Pro 档 | 4 变体家族 | 是 | 简洁优先，长句会被丢 |
| MiniMax H3 | 4–15s | auto / 21:9 / 16:9 / 4:3 / 1:1 / 3:4 / 9:16 | 2K | 首尾帧或图/视频/音频参考，`batch_size` 1–4 | 视路由 | subject + action + camera path + environment + lighting + audio intent |
| Wan 3.0 | 2–30s 或 `-1` 智能 | auto / 16:9 / 9:16 / 1:1 / 4:3 / 3:4 | 480p / 720p / 1080p | 图/视频/音频多模态参考 | 是（`generate_audio` 默认 on） | 参考驱动 + `enable_thinking` 提升听从度 |
| LTX-2.3 | 约 5s（默认 161 帧） | 自定义 `--width/--height` | 1024×576 等自定义 | I2V 单图 | 否 | 短句 + 一个明确运动 |

> Sora 状态冲突：两份源仍按在役模型举例，另一份记录 **OpenAI 于 2026-09-24 关停 Sora 2 API**。给用户方案时按「已退役」处理，只作历史参考。

### 模板 A：通用五段式（跨模型 / 中文平台 / 国内模型）

```
1. 核心主题：写实暗黑特摄 | BLACK SUN美学 | 战损变身 | 末日战场
2. 人物与基础设定
   面部：参照上传图片，五官、脸型、发型百分百还原，杜绝美化；保留轻微面部瑕疵。
   服装：哑光黑色皮质长风衣，金属腰带为哑光质地，腰带核心为暗红色水晶。
   场景：末日战场，微风，硝烟弥漫，阴天荒野，灰蓝色调天空。
3. 氛围与画质：变形宽荧幕电影质感。模拟 IMAX 胶片摄影机 + Panavision C 系列镜头（35mm，f4）。
   低饱和灰蓝主调，暗部信息压缩保留细节，边缘轻微柔焦 + 适度胶片颗粒。
4. 运镜规则
   单镜头：一镜到底，无剪辑。
   角度：开场仰拍，人物半身左侧面 30 度；以极缓速度环绕至正面平视上半身；完成后环绕至右侧面俯拍。
   呼吸感：手持拍摄，全程极轻微、如呼吸般的镜头浮动。
5. 分镜（时间轴）
   0-3秒 · 凝视：动作 / 镜头 / 特效 三件套
   3-6秒 · 启动：声音 / 动作 / 特效 / 镜头
   6-9秒 · 撕裂：按需细分核心 / 身体 / 衣物 / 甲壳 / 面部 / 镜头
```

适用：Seedance 2.0、即梦、可灵中文端、以及任何「吃中文自然语言 + 分段时间轴」的模型。

### 模板 B：Seedance 2.0 开场声明（原样贴，再扩写）

```
Montage, multi-shot Hollywood action, don't use one camera angle or single cut, cinematic lighting,
photorealistic, 35mm film quality, ARRI ALEXA aesthetic, heavy film grain, sharp but imperfect focus,
motion blur on fast actions, halation on highlights, soft highlight rolloff, wide-angle lens with strong
distortion, subtle chromatic aberration near frame edges, no 3D, no cartoon, no VFX aesthetic.
```

```
Single continuous shot, first-person POV perspective, the camera IS [his/her] eyes, hyper-chaotic handheld
motion, completely unstabilized, violent raw human movement, constant micro-jitters, aggressive head swings,
abrupt jerks, frequent over-rotation, no smoothness at all, no cuts, no zoom, 35mm film, photorealistic.
```

```
One continuous shot, POV [setting] perspective, no cuts, no zoom, natural head movement, photorealistic, 35mm film grain.
```

开场之后按顺序写：环境感官细节 → 主角块（含参考标签与身份锁）→ 对手/配角块 → 逐拍编排（带 `0–3s:` 时间标记）→ 括号内 VFX `[VFX: …]` → 慢动作标记 `RAMPS TO SLOW MOTION` / `SNAPS BACK TO REAL TIME` → 声音块（`no music, only raw SFX` 或显式 SFX 序列）。

### 模板 C：Seedance 2.5 九段 section order

```
GLOBAL STYLE
  Genre, color grade, film stock or digital look, aspect ratio, shutter behavior, 以及必须不出现的东西。
SCENE
  一句话 logline：发生什么、在哪、什么情绪。
CHARACTERS
  脸、发、体型、服装。有参考图时只写「哪张参考是哪个角色」。
LOCATION
  空间与陈设，跟人分开写。地点写虚是多镜漂移的第一原因。
FIRST FRAME AND BLOCKING
  开场瞬间谁在哪、面朝哪。任何运动开始前就固定住的东西。
Shot 1: [shot type] [action in one or two sentences]. Hard cut.
Shot 2: [...]. Hard cut.
Shot 3: [...].
OPTICS / CAMERA
  焦距、机位高度、手持/推轨/摇臂，逐镜写。
PHYSICS
  布料、烟、头发、液体——任何「当固体动就会假」的东西。
LIGHTING
  光从哪来、方向、怎么落在脸上。
AUDIO
  环境、具体音效、以及必须听不到的东西。默认 "No music, no discernible dialogue"。
```

规律：**顶部一条视觉规则，底部一条声音规则，中间全是镜头**。`CHARACTERS` 有参考图时可以极短；`GLOBAL STYLE`、分镜、`AUDIO` 不能省。

### 模板 D：八段式（仅用于单镜简单场景）

```
[Shot / framing] + [Camera movement] +
[Subject description — 必须跨镜保持的物理细节] +
[Action beat 1] → [optional cut] → [Action beat 2] +
[Setting / environment] + [Lighting / palette] +
[Style / grade / era] + [Audio — ambient, diegetic, music, dialogue]
```

### 身份锚点句（堆叠使用，冗余有效）

```
the same character
consistent across different scenes / all shots
maintain exact appearance from reference image
no deformation, no drift, no face morph
Do not alter clothing category or primary color
```

参考图中的写法（Seedance 2.0 接受括号标签 + 身份锁）：

```
[reference_image: hero_portrait.png]
[identity_lock]
The same character — bald, blue arrow tattoo, orange robes — consistent across all shots,
no drift or deformation. Do not alter clothing category or primary color.
```

### 参数调用骨架

```text
// Seedance 2.0
seedance_video.execute({
    "prompt": PROMPT,
    "model_variant": "standard",     # "standard" / "fast"
    "operation": "text_to_video",    # 或 image_to_video / reference_to_video
    "aspect_ratio": "21:9",          # 21:9 / 16:9 / 9:16 / 4:3 / 1:1 / 3:4
    "duration": "10",                # auto / 4..15
    "resolution": "720p",            # 480p / 720p / 1080p / 4k
    "generate_audio": True,
    "seed": 12345,
})
```

```text
// Seedance 2.5 平台参数面
mode: t2v | omni_reference | video_edit | video_extension   （默认 t2v）
duration: 4–30（默认 5；video_edit 下忽略）
resolution: 480p | 720p | 1080p（默认 720p，无 4K）
generate_audio: bool（默认 true）
bitrate_mode: standard | high（默认 standard）
extension_mode: backward | forward（仅 video_extension 必填）
aspect_ratio: auto | 21:9 | 16:9 | 4:3 | 1:1 | 3:4 | 9:16（video_edit 忽略，video_extension 跟随源）
media roles: start_image | end_image | image_references | video_references | audio_references
            （start_image / end_image 只在 omni_reference 合法）
```

配额硬规则：`t2v` 不接受任何参考；`omni_reference` 至少一个参考；图参考 + 首帧 + 尾帧 ≤30；全部参考 ≤50；`video_edit` 按源视频时长计费且 `duration` / `aspect_ratio` 不可设。

### 字数与时长上限（最终提示词本体）

| 时长 | 目标字数 | 上限 | 说明 |
| --- | --- | --- | --- |
| 1–15s | 800–1300 字 | 2000 字 | 单人单动作场景 500–800 字 |
| 16–24s | 1600–2600 字 | 3200 字 | 超过 2400 字时，每多一句都要能提升稳定性 |
| 25–30s | 2200–3400 字 | 4000 字（硬顶） | 3000 字为软阈值 |

短表单镜口径（另一套判据，适用 Higgsfield 短提示词场景）：**200 词以内**；Seedance/Cinema 诊断树给出的健康区是 **30–100 词**，超 100 词开始模糊/抖动。

### 收尾规则（时长分配）

- 关键台词或动作至少提前 **1–2 秒**完成，留反应与呼吸；不要把强拍放在最后一帧再切。
- 按戏剧权分配秒数，不平均切。
- 复杂场景先砍「助手加的装饰性 beat」，再考虑砍用户核心事件。

## 常见坑

- **症状：片子被剪成一堆碎镜，节奏全散。** 原因：第一句没有结构声明，模型自己决定切点。修法：把模板 B 的开场句原样贴到最前面，并在分镜后追加 `cuts only at the specified points, the camera does not cut on its own.`
- **症状：画面持续抖动/旋转，什么都看不清。** 原因：一镜里叠了多个运镜（handheld + rise + push-in + rack focus）。修法：只留一个主运镜；复合运动拆成两镜，或写成有秒数的阶段。
- **症状：参考图给了 20 张，人物反而更不像。** 原因：参考集里互相竞争的脸/场景/道具把身份拉平。修法：一个必须保持的元素配一张参考；50 项是上限不是目标。
- **症状：写了「不要 XX」，XX 反而更明显。** 原因：该模型不吃 negative prompt（FLUX 系明确不支持，Seedance 约束要走命名锁）。修法：改写成正向事实 + 具体替代物（`no blood` → `the cut edge glows orange, sparks blow out, the body crumbles to ash`）。
- **症状：中文提示词贴进英文界面后描述全漂。** 原因：两套语料不同。修法：同一份意图准备两版——中文版给人读/给中文端模型，英文片段版给 Seedance/Veo/Kling 英文界面；术语（`Dolly In`、`ECU`、`35mm`）在两版里都保留英文。
- **症状：按 Sora 方案交付，用户那边根本调不通。** 原因：Sora 2 API 已于 2026-09-24 关停。修法：规模/物理镜头改路由到 Seedance 2.0 或 Hailuo 2.3，并明说这一条。

## 来源与合并说明

| 上游仓库 | ★ | 许可 | 贡献内容 |
| --- | --- | --- | --- |
| jnMetaCode/ai-shortfilm-prompts | 515 | MIT | 五段式结构（核心主题/人物设定/氛围画质/运镜规则/分镜时间轴）、摄影机组合表、按秒与按镜两种分镜写法、字数与时长习惯 |
| ZeroLu/awesome-seedance | 2812 | MIT | Seedance 2.0 的 `Style/Duration/[00-05s] Shot` 时间码写法与商业/短片类实战提示词范式 |
| beshuaxian/higgsfield-seedance2-jineng | 1020 | 无许可证 | Seedance 2.0（Higgsfield）输入规格（9 图/3 视频/3 音频、4–15s 720p、`@material[名称]`）、2 秒钩子框架、漫画/分镜转视频的镜头推断规则 |
| OSideMedia/higgsfield-ai-prompt-skill | 850 | MIT | 模型对比表（时长/画幅/分辨率/音频）、Seedance 2.5 参数面与参考配额、MCSLA 与 200 词短表口径、身份锚点与 @ 参考角色分类 |
| CyberJ0605/cinematic-video-prompt-engineer-skill | 142 | MIT | 时长选择规则（15s 分界、30s 硬顶）、按字数分档的提示词预算、中文为主只保留术语英文的写法、生产路径路由 |
| Rylaispirit/cinematic-video-prompt-skill | 174 | MIT | 「意图 → 英文提示词片段」的对照式写法与镜头/光线/材质词表组织方式 |
| calesthio/OpenMontage | 76149 | AGPL-3.0 | Seedance 2.0 开场声明与格式优先级、Seedance 2.5 九段 section order 与命名锁、Kling/Veo/MiniMax H3/Wan/LTX-2 的路由参数与「各吃什么描述」 |

- 抓取日期：2026-11-04
- 合并的上游技能：shortfilm-prompt、awesome-seedance、seedance-cinematic（01-cinematic）、higgsfield-ai-prompt-skill、cinematic-video-prompt-engineer、cinematic-video-prompt-skill、seedance-2-0、seedance-2-5、kling-official、minimax-h3、ltx2、ai-video-gen
- 冲突与取舍：
  - **提示词语言**：一份源明确「只写英文提示词」，另一份以中文为主、只保留 `ECU/Dolly In/35mm` 等术语英文。两套并列——英文版给 Seedance/Veo/Kling 英文界面与 API 调用，中文版给中文端模型与人工审读；术语英文在两版都保留。
  - **提示词长度**：短表口径 200 词 / 30–100 词，与长片口径 800–3400 字并存。按交付形态分流：单镜短表用词数，叙事长片用字数档。
  - **Sora 状态**：两份源按在役举例，一份记录 API 已于 2026-09-24 关停。按「已退役」写，差异在正文标注。
  - **参考图数量**：9 图 / 12 项（2.0）与 50 项（2.5）并存，按模型分流，不合并成单一数值。
