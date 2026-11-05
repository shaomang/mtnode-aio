---
name: film-prompt-cinematography
title: 摄影词表与提示词用法
description: 把「压迫感、孤独、温柔」这类中文意图翻译成模型认得的英文摄影片段：机位、运镜、焦段、光位、光质、色温、构图、材质、天气九类词表，并给意图对照表与摄影机层写法。
tags: 摄影词表,运镜,景别,光线,色温,构图,材质天气
version: 1.0.0
---

# 摄影词表与提示词用法

本技能只管**镜头层**：怎么把中文意图翻成提示词片段，并按什么顺序放进提示词。模型参数见 `film-prompt-video-models`；词表全文在 `references/` 两个文件里。

## 何时用

- 用户给的是情绪词（「压抑」「温柔」「史诗感」），需要落成可执行的摄影描述。
- 要写运镜但拿不准用 `Dolly In` 还是 `Zoom In`，或不确定这一段该不该有运动。
- 需要给一条已有提示词补「光」「色温」「景深」「构图留白」，让它不再像 CG。
- 跨模型迁移时，词表要按目标模型重挑（有的模型只认命名预设，有的更吃自然语言）。
- 不适用：定模型/时长/画幅参数；写首帧图像提示词；成片已经出了要诊断返修。

## 核心原则

1. **先定剧情功能，再选运动。** 功能是「让她被空间吞掉」→ 选 `Dolly Out` 或 `Crane Up`；不能先挑「酷炫运镜」再硬套剧情。
2. **一镜一个主运动。** 6–15s 的片子全片通常只用 0–3 种主要运动。要两个运动就切两镜，或按阶段分配给秒数。
3. **每个运动写清六件事**：起始主体/景别、摄影机实际路径或镜头变化、方向、速度、画面产生的新信息、结束主体/构图。缺一项，模型就自己编。
4. **机位不动与机位位移不得混写。** `Pan / Tilt / Zoom` 是机位不动时的方向或焦距变化；`Dolly / Truck / Tracking / Crane / Pedestal` 是摄影机真的在移动。混写的结果是画面既转又移，构图崩。
5. **光线只写 1–2 个关键词，且必须与时间/天气自洽。** 正午直射光配「柔和的窗光」= 模型二选一，随机翻车。
6. **色温用 K 值，且同一场景内固定**：`3200K / 4000K / 5600K / 8500K`。写「暖一点」等于没写。
7. **左右一律以摄影机为准。** `screen-left` / `screen-right`，不写「人物左手边」。
8. **光承担情绪，形容词不承担。** 把 `电影感`、`高级感`、`氛围拉满` 换成光源、方向、质感、色温、对比度的具体组合。

## 工作流

1. **提取剧情功能（输入：剧本/需求）** → 一句话写清这一镜要完成什么：揭示信息 / 拉近情绪 / 表现权力 / 建立空间 / 完成转场。产出：功能句。
2. **选运动（分支）** → 查 `references/camera-movement-library.md` 的 46 条表，按「适用剧情功能」列反查。若功能是「克制表演/停顿」，直接选 `Static`，不要加运动。
3. **定景别与机位高度** → 景别用标准缩写：`ECU / CU / MCU / MS / MLS / Full / Wide / ELS`；高度写 `eye-level / shoulder-level / hip-level / low angle / high angle / overhead`。
4. **定焦段与景深** → 一张表选完：广角 24mm（环境+畸变）、35mm（纪实）、50mm（自然）、85mm（人像虚化）、135mm（压缩）、微距（质感）。景深写 `shallow depth of field (f/1.8)` 这类「效果 + 光圈」组合。
5. **定光位与光质** → 先写光源（窗光/实用灯/霓虹/月光），再写方向（侧光/逆光/顶光/底光），再写质感（硬/柔/漫射/斑驳），最后给 K 值。一个场景一句，最多两句。
6. **定构图与留白** → 主体落点（三分线/中心/负空间）、headroom、lead room、前景/中景/背景三层的分工。给后续运动留出可走的空间。
7. **补材质与天气** → 只补会动或会反光的：布料、烟、雨、尘、水、金属反光。静态材质写一句即可。
8. **合成摄影机层** → 用第 4 节的「摄影机层三段式」拼成一段可粘贴文字；确认全段只有 1 个主运动。
9. **自检** → 逐条核对第 5 节的常见坑（左右、混写、光线冲突、运动数量）。

## 关键参数与模板

### 中文意图 → 英文片段（高频 20 条）

| 中文意图 | 英文提示词片段 |
| --- | --- |
| 缓慢靠近、情绪收紧 | `Dolly In`, camera physically advances on a straight line, height and direction steady |
| 拉开距离、被空间吞掉 | `Dolly Out`, subject shrinks as the room takes over the frame |
| 机位不动只推焦 | `Slow Zoom In`, camera position locked, framing tightens on the face |
| 眩晕/失衡 | `Dolly Zoom (Vertigo)`, dolly in while zooming out |
| 环绕对峙、仪式感 | `360 Orbit`, constant radius, background rotates continuously |
| 压抑、被俯视 | `High Angle`, camera above eye line looking down |
| 权力、威压 | `Low Angle`, camera below chest height looking up |
| 不安、倾斜世界 | `Dutch Angle`, horizon tilted 10–15°（角度为通用经验值） |
| 现场感、纪录片 | restrained `Handheld`, only faint breath-like sway, subject stays readable |
| 极端临场、主观 | `First-Person View / POV`, camera at eye height, hands entering frame edges |
| 黄金时刻暖调 | `golden hour`, warm directional light, long soft shadows |
| 蓝调冷调 | `blue hour`, cool ambient light just after sunset |
| 阴天无影、纪实 | `Overcast Light (Flat Light)`, no hard shadows, true color |
| 体积光、丁达尔 | `volumetric lighting`, visible light shafts through haze |
| 逆光轮廓 | `backlighting` + `rim light`, edge glow separating subject from background |
| 只靠场景灯 | `practical only`, all light motivated by visible sources in frame |
| 低照度夜景 | `low-key lighting`, deep shadow, single motivated source |
| 皮肤通透 | `subsurface scattering`, light passing through skin |
| 金属拉丝反光 | `brushed metal`, `anisotropic reflection`, specular streaks |
| 雨夜街景 | `rain-slicked asphalt`, `neon bleed`, `wet reflections`, light halation |
| 雾与颗粒 | `fog density 40%`, `visible at 15 meters`, `35mm film grain`, `halation on highlights` |

完整词表：`references/vocabulary.md`（景别/角度/光线/构图/材质/天气/镜头与胶片）。

### 情绪 → 运镜（可直接套）

| 情绪 | 运镜组合 | 理由 |
| --- | --- | --- |
| Realization 顿悟 | 慢 `Dolly In` + 眼睛睁大 | 逼近认知落点 |
| Fear 恐惧 | `Dutch Angle` + `Handheld` | 世界失衡 + 无法稳住 |
| Power 权力 | `Crane Up` / `360 Orbit` + 宽站姿 | 抬高视点、环绕施压 |
| Vulnerability 脆弱 | `Overhead` / `Dolly Out` + 人在画面里很小 | 空间压过人物 |
| Intimacy 亲密 | `Dolly In` + `shallow depth of field` | 缩短距离、隔离背景 |
| Chaos 混乱 | `FPV Drone` / `Handheld` + 快切 | 失去参照系 |

### 摄影机层三段式（粘贴即用）

```
Camera: [运动名] — [起点景别/主体] → [路径或镜头变化，含方向与速度] → [结束构图]。
Lens: [焦段]mm, [光圈], [景深效果]。
Light: [光源] from [方向], [质感], [色温 K], [对比度]。
```

示例（可直接进提示词）：

```
Camera: Dolly In — starts MS on her back at the window, advances slowly along the room axis,
stops at MCU on the reflection in the glass.
Lens: 50mm, f/2.0, shallow depth of field with the rain outside falling into soft bokeh.
Light: practical only, a single warm desk lamp from screen-left at 3200K, hard falloff into
deep shadow on the right side of her face, 35mm film grain, halation on the lamp edge.
```

### 摄影机与镜头组合（按风格取）

| 风格 | 摄影机 + 镜头 |
| --- | --- |
| 史诗 / 大场面 | IMAX 胶片摄影机 + Panavision C 系列（35mm，f4） |
| 暗调赛博 / 写实硬核 | Sony Venice + Canon K-35 系列 |
| 港片 / 武侠 | Kodak 35mm 复古胶片，跳过漂白（bleach bypass）质感 |
| 商业人像 | Canon EF 85mm f/1.2 |
| 纪实 / 手持 | 单焦距贯穿全片（`SINGLE-LENS LOCK`），构图变化靠走位 |

> 注意：部分平台的写实档明确要求**不写导演名、不写器材型号**（会被忽略或破坏复杂运动），只描述观感。给 Seedance/Higgsfield 长片档写「ARRI ALEXA aesthetic / 35mm film quality」这类**观感词**，不要写具体机型；给中文端与短片档可以用具体机型做锚点。

### 焦段与光圈的写法

| 焦段 | 画面性格 | 常用片段 |
| --- | --- | --- |
| 24mm | 环境吞人、边缘畸变 | `24mm wide-angle, strong distortion near frame edges` |
| 35mm | 纪实、自然的空间关系 | `35mm, moderate perspective, subject grounded in the room` |
| 50mm | 接近人眼 | `50mm, natural perspective` |
| 85mm | 人像、背景奶油化 | `85mm f/1.8, creamy bokeh, compressed background` |
| 135mm | 强压缩、偷窥感 | `135mm f/2, compressed perspective` |
| Macro | 质感、微观 | `macro lens, extreme close-up detail, visible material grain` |

### 光线四要素填写顺序

1. **光源**：`window light` / `practical only` / `neon` / `moonlight` / `overcast sky`
2. **方向**：`from screen-left` / `backlit` / `top-light` / `underlight`
3. **质感**：`soft and diffused` / `hard-edged` / `dappled` / `volumetric haze`
4. **色温与对比**：`3200K, deep shadow` / `5600K, low contrast, flat`

### 构图与留白（给后续运动留空间）

| 需求 | 写法 |
| --- | --- |
| 主体靠边、给运动方向留空 | `rule of thirds, subject on the left third, lead room to screen-right` |
| 极简、压迫 | `negative space`, subject occupying <1/3 of frame |
| 框中框 | `framing within a frame`, doorway/arch/mirror around subject |
| 三层景深 | `foreground interest (out of focus), midground subject sharp, background soft` |
| 竖屏 9:16 | 重新排布：单人近景替代横向双人，动作沿纵向走 |
| 镜头要跟着走 | 主体前方留 `lead room`，不要在起始帧就把画面填满 |

### 尺度与度量写法（避免「很大/很快」）

- 速度：`moves at 40 km/h`，不写 `fast`（退化最快的词）。
- 雾/霾：`fog density 40%`, `haze visible at 15 meters`，可分镜递进 20% → 40% → 60%。
- 巨大：`as tall as four humans stacked head to toe`，不写 `huge` 或 `three meters`。
- 体重：`70–80 kg`，让重力读对。
- 情绪：写肌肉动作（`jaw tightens`, `eyes glassy`），不写 `she is sad`。

## 常见坑

- **症状：画面既在转又在移，构图散架。** 原因：`Pan` 与 `Dolly` 混写，或一镜叠了三种运动。修法：只留一个主运动；确需复合就写成分阶段带秒数（`rises 0–3s, holds, pushes in 4–8s`）。
- **症状：光看起来「假」、脸发塑料。** 原因：只写「电影感打光」，没给光源与方向；或加了「柔光」但场景是正午硬光。修法：光源 + 方向 + 质感 + K 值四件套，且与时间/天气自洽。
- **症状：每次生成的色温都不一样，接不上。** 原因：没写 K 值，模型每镜自由发挥。修法：全场景固定一个 K 值，并在后续镜头逐条重复。
- **症状：人物像贴片贴进背景，没有空间感。** 原因：没有前景/中景/背景分层，也没有景深或视差。修法：加 `foreground interest`、给 `Truck`/`Slider` 制造视差、写明 `shallow depth of field`。
- **症状：运镜写得很详细，模型完全不理。** 原因：运镜埋在散文里，或用了非命名的自造词。修法：把摄影机层单独成行并以 `Camera:` 开头，用词表里的命名（`Dolly In`、`FPV Drone`、`360 Orbit`）；有的平台还要把摄影机块放在第 3 层（subject → action → **camera** → style → constraints）。
- **症状：竖屏里横向双人对峙全被切掉。** 原因：把 16:9 的构图直接搬进 9:16。修法：改纵向走位、拆成单人近景、或补一张竖屏关键帧。

## 来源与合并说明

| 上游仓库 | ★ | 许可 | 贡献内容 |
| --- | --- | --- | --- |
| jnMetaCode/ai-shortfilm-prompts | 515 | MIT | 摄影机+镜头组合表（IMAX/Panavision、Venice+K-35、Kodak 35mm）、运镜三段式（单镜头/角度/呼吸感）、景别与节奏词、构图按前景中景背景分层的写法 |
| ZeroLu/awesome-seedance | 2812 | MIT | 实拍提示词里的镜头层写法（`Shot 1: Interior/Close-up`、`Cut to`）与运镜和叙事节拍的绑定方式 |
| beshuaxian/higgsfield-seedance2-jineng | 1020 | 无许可证 | 2 秒钩子里的「打光特征 + 摄像机运动 + 深度线索」三段式、各类型片的调色与运镜倾向 |
| OSideMedia/higgsfield-ai-prompt-skill | 850 | MIT | 运镜词表（线性/垂直/环绕/变焦/跟随/特殊）、景别词表、光线与夜景词表、情绪→运镜表、可度量写法（km/h、40% 雾、K 值、身高对比）、摄影机块放在第 3 层的实测结论 |
| CyberJ0605/cinematic-video-prompt-engineer-skill | 142 | MIT | 46 条运镜库的调用原则（先功能后运动、一镜一主运动、机位不动 vs 位移不得混写）、跨空间连接与事件触发、镜头运动的中文模块写法 |
| Rylaispirit/cinematic-video-prompt-skill | 174 | MIT | 景别/角度、光线、构图、焦段与胶片、材质与天气的「英文片段 + 用途」对照表（原为越南语释义，本技能译为中文） |
| calesthio/OpenMontage | 76149 | AGPL-3.0 | 「不写导演名/器材型号、只描述观感」的写实档规则、`LENS LOCK` 与 `SINGLE-LENS LOCK` 的焦距口径（84°/47°/29°/18° 对角线视场） |

- 抓取日期：2026-11-04
- 合并的上游技能：shortfilm-prompt、awesome-seedance、seedance-cinematic（01-cinematic）、higgsfield-ai-prompt-skill、cinematic-video-prompt-engineer、cinematic-video-prompt-skill、seedance-2-0、seedance-2-5、kling-official、minimax-h3
- 冲突与取舍：
  - **器材型号**：一份源把「IMAX + Panavision C 35mm f4」当有效锚点，另一份实测「写机型会被忽略甚至破坏复杂运动」。两套并列——短片/中文端用机型锚点，Seedance 长片档改用观感词（`ARRI ALEXA aesthetic`、`35mm film quality`）。
  - **运动数量**：一份允许「0–3 种」，一份要求「严格一个」。取严口径：每镜一个主运动，全片 0–3 种。
  - **焦距表达**：一份用 mm（24/35/50/85），一份用对角线视场角（84°/47°/29°/18°）。前者给人读与中文端，后者用于需要锁死视角的长片段落。
