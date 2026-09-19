---
name: minimax-music-prompt
title: MiniMax Music 提示词
menu: user
description: 【内置·随应用发版，不需从工坊安装】把一句话想法写成 MiniMax Music 的风格提示词：一段英文散文，六句按 Style+Mood → Tempo/Groove → Instruments → Vocals → Structure → Production 排（写句子、不写逗号标签、不含唱词）。控制曲风、人声、乐器、段落对比与制作；含官方六步、最小改动迭代表与校验清单。MTNode「Minimax Music 3 / YuE2」节点的提示词端口用它。
---

# MiniMax Music 提示词

**本技能是应用内置技能**（随安装包发版，来自创意工坊的那份已撤下）。用户要写 / 改 MiniMax Music（网页端 Styles、Music 3.0、API `prompt`）的 **风格提示词 / 音乐描述** 时使用。

本技能**只产出风格侧那一段文本**。要唱出来的词交给内置技能 `minimax-music-lyrics`；同一件事不要在两边各写一遍。

依据：[MiniMax Music Prompt Guide](https://www.minimax-music.com/blog/minimax-music-prompt-guide)（七层公式、逐层写法、六步搭建、迭代与故障速修均出自该文）。MTNode 口径：「Minimax Music 3」节点（`music_gen`）**端口 0 = 提示词**、端口 1 = 歌词；「YuE2」节点（`yue_gen`）同为提示词 + 歌词两端口。

## 输出格式（硬口径，不可改形态）

交付给用户粘贴的**只有一段英文散文**：六个句子，连成一行（一个段落），顺序固定，句内可用逗号并列。

| 句 | 覆盖层 | 必须交代什么 | 参考写法 |
|---|---|---|---|
| 1 | Style + Mood | 主风格 + 一到两个影响 + 情绪身份 | `Modern dark R&B with subtle melodic trap influences and a late-night, introspective mood.` |
| 2 | Tempo & Groove | 速度感与律动 | `Slow to mid-tempo with a relaxed groove.` |
| 3 | Instruments | 2–4 个关键声音与它们的角色 | `Deep 808 sub-bass, sparse piano chords, soft ambient synths, and restrained percussion.` |
| 4 | Vocals | 声部 + 音色 + 唱法（器乐曲改写领奏乐器） | `Warm male baritone vocals with intimate sing-rap phrasing.` |
| 5 | Structure | 主歌 / 副歌的对比与发展 | `Keep the verses minimal, then open into a wider chorus with layered harmonies.` |
| 6 | Production | 混音、人声分离、低频 | `Clean modern mixing with clear vocals and controlled low end.` |

**照抄这个形态：**

> Modern dark R&B with subtle melodic trap influences and a late-night, introspective mood. Slow to mid-tempo with a relaxed groove. Deep 808 sub-bass, sparse piano chords, soft ambient synths, and restrained percussion. Warm male baritone vocals with intimate sing-rap phrasing. Keep the verses minimal, then open into a wider chorus with layered harmonies. Clean modern mixing with clear vocals and controlled low end.

硬性禁止：

- **不要**写成逗号标签清单（`R&B, sad, slow, piano` 是错的；逗号只用于句内并列）。
- **不要**加小标题、编号、Markdown 列表或代码围栏，**不要**输出 JSON（除非用户明确要机器可读）。
- **不要**把歌词原文、歌名、模板 ID、推理过程写进 prompt。
- **不要**把段落说明塞进来（`[Chorus] 加鼓` 属歌词侧或本段第 5 句的散文，不写方括号标签）。
- 长度：**45–110 英文词**，一行放得下；API `prompt` 上限 2000 字符，别贴着上限写。
- **一律英文**（官方：English prompts work best）。用户明确要中文提示词才给中文；中文场景词点缀在英文里是允许的。
- 六句是骨架不是死数：某一层的乐器只有两件时写两句也行；但**顺序不变**，要紧的写在前面（官方：按 `Style → Mood → Key Sounds → Vocal/Instrumental Focus` 排，竞争细节越少越容易被执行）。

## 逐句怎么写

### 第 1 句 · Style + Mood —— 三层叠出身份

1. **主风格**：Pop / R&B / Hip-hop / Indie folk / Rock / Jazz / Classical / Electronic / Lo-fi …
2. **一个有用途的影响**：`modern R&B with melodic trap influences`、`indie folk with cinematic orchestration`、`synth-pop with 1980s influences`、`electronic with ambient textures`、`orchestral with modern percussion`。
3. **美学 / 情绪身份**：`bright but nostalgic, with a polished nighttime-city aesthetic`。

- **硬规则：一个主风格 + 一到两个支持性影响。** 堆互斥标签（`calm ballad + high energy dance`）只会被模型平均掉。
- 情绪分四类挑：暖（`romantic, hopeful, nostalgic, comforting`）· 暗（`tense, lonely, mysterious, melancholic`）· 能量（`triumphant, aggressive, playful, euphoric`）· 静（`dreamy, intimate, meditative, atmospheric`）。
- **只写 genre 不写 mood 是「听着泛」的第一原因。**

### 第 2 句 · Tempo & Groove

慢 / 中速 / 快而有力 / `gradually accelerating`；groove 用 `laid-back, bouncing, driving, syncopated, swinging, steady, loose, punchy`。

- 弱：`Neo-soul, relaxing.` → 强：`Mid-tempo neo-soul with a warm late-night mood and a loose, laid-back groove.`
- 精确 BPM 只在**用户给了**或确实有必要时写（40–60 冥想 · 60–80 慢歌谣 · 80–110 中速律动 · 110–130 明快 · 130–160 推进）。用户没给就用定性词，**不要编造数值**。

### 第 3 句 · Instruments —— 乐器 + 角色 + 演奏法

`Instrument + Role + Performance`。Music 3.0 明确强化了对演奏法（slides、legato）的识别，所以别写名单：

- 弱：`Guitar, piano, drums, bass.`
- 强：`Clean electric guitar playing slow legato phrases with occasional expressive slides.`
- 强：`Soft piano chords provide the harmonic foundation while brushed drums maintain a restrained jazz groove.`
- 强：`Deep 808 bass anchors the chorus while short synth pulses add movement around the vocal.`

弱 → 强速查：acoustic guitar → `softly fingerpicked acoustic guitar`；strings → `low strings gradually building tension`；piano → `sparse piano chords under the lead vocal`；electric guitar → `distorted guitar playing a driving rhythmic riff`；drums → `tight punchy drums with restrained fills`。

**说 2–3 件关键乐器，其余留给模型。** 曲目复杂时分前景 / 背景：人声是主角时，不要让每件乐器同等活跃。

### 第 4 句 · Vocals —— 五维 + 层级

`Voice type + Tone + Delivery + Technique + Emotion`

| 维 | 词 |
|---|---|
| Voice type | female alto, bright female soprano, male baritone, warm tenor, deep male vocal |
| Tone | airy, warm, raspy, bright, soft, dark, clear |
| Delivery | intimate, restrained, conversational, powerful, rhythmic, dramatic, sing-rap |
| Technique | breathy phrasing, smooth legato, subtle vibrato, heavy autotune, layered backing vocals, close harmonies |
| Emotion | vulnerable, confident, yearning, detached, playful, frustrated |

- **不要堆形容词**：`warm, dark, soft, powerful, airy, raspy, smooth, emotional female vocal` 无效；给**层级**——`Warm female alto with restrained, breathy verses and a more powerful chorus.`（让表演有去处）
- 可直接用的人声句式：`smooth emotional vocals` · `raw, unpolished vocals shifting between whispers and screams` · `breathy delivery with intimate phrasing` · `powerful soulful vocals with gospel inflections` · `sultry, sophisticated baritone with jazz inflections` · `ethereal, crystal-clear vocals with lush reverb` · `aggressive vocal delivery with rhythmic intensity`。
- **纯器乐**：写明 `instrumental`，指定**一件领奏**、其余支撑，例如 `Reflective cinematic music led by intimate piano, with soft strings building gradually behind it.` 用户要器乐时**禁止**给人声。

### 第 5 句 · Structure —— 对比与走向

把段落发展压成一句散文（`Keep the verses sparse, then widen the chorus with stronger drums and layered harmonies.`）。情绪骨架：`Introduce → Build → Release → Contrast → Resolve`。

结构标签（`[Verse]` `[Chorus]`…）与段落说明属于**歌词侧**（见 `minimax-music-lyrics`）；走 MTNode 节点时后端把提示词与歌词分开喂，**标签不要写进这一段**，本段只负责把「副歌比主歌大」这件事说清楚。

### 第 6 句 · Production

`clean modern mixing with clear vocals and controlled low end` · `mellow beats with lo-fi elements` · `warm vintage texture` · `clear vocal separation` · `spacious arrangement around the vocal`。混音听着挤 → 写更简单的编曲 + 人声分离，而不是继续加形容词。

### 加分项：场景 / 用途

场景比空标签有用：`Upbeat indie pop for a carefree summer road-trip montage` 优于 `Upbeat indie pop`。BGM 加 `relaxed and unobtrusive`、`leave plenty of space in the arrangement`。需要时并进第 1 句末尾，别另起一段。

## 从一句话到成品（官方六步）

| 步 | 做什么 | 以「A sad late-night R&B song」为例 |
|---|---|---|
| 1 定风格 | 主 genre | `Modern dark R&B with subtle melodic trap influences.` |
| 2 加情绪与运动 | mood + tempo / groove | `introspective and nocturnal, with a slow laid-back groove` |
| 3 选声音调色 | 2–3 件关键乐器 + 角色 | `Deep 808 bass, sparse piano chords, atmospheric synth pads, and restrained drums` |
| 4 指人声 | 声部 + 音色 + 唱法 | `Warm male baritone with intimate, slightly detached sing-rap phrasing` |
| 5 造发展 | 段落对比 | `Keep the verses sparse and restrained, then widen the chorus with stronger drums and layered vocal harmonies` |
| 6 定制作 | 混音与低频 | `clean modern mixing with clear vocal separation and controlled low end` |

标准只有一条：**每一句都要能变成听得见的决定。**

## 与歌词的分工

**风格提示词定义世界；歌词结构指挥世界里发生什么。**

| 写进 prompt（本技能） | 写进 lyrics（`minimax-music-lyrics`） |
|---|---|
| 曲风、情绪、场景 / 用途 | 实际唱词 |
| 速度与律动 | `[Verse]` `[Chorus]` 等段落标签 |
| 乐器角色与演奏法 | 可唱衬词 `(Ooh)` `(Yeah)` |
| 主唱身份、唱法、和声层次 | 段落内的叙事与钩子 |
| 段落编曲对比、制作、混音 | —— |

## 迭代：听一遍，只改最小项

**一个问题 → 一次修改 → 一次试听。** 只有曲风、情绪、人声、结构全错时才整段重写。

| 听出的问题 | 只改这一处 |
|---|---|
| 风格泛 | 加影响、年代、美学、使用场景 |
| 人声不对 | 先改人声句：音色 + 唱法 |
| 副歌不够大 | 只加副歌对比：更满的鼓、更强的唱、更宽的和声 |
| 太满 | 减乐器数量与角色 |
| 平 | 段落发展（build / release），不要换曲风 |
| 情绪错 | 情绪词 |
| 节奏弱 | tempo + groove |
| 混音挤 | 更简单编曲 + 人声分离 |
| 歌词听着赶 / 发音糊 | 去改歌词那一侧，不动本段 |

其它常见故障：

1. **部分指令被忽略**：删掉互相竞争的细节，要紧的写在前（`Style → Mood → Key Sounds → Vocal/Instrumental Focus`）。
2. **段落脱节**：保留固定锚点（同一人声角色、核心乐器、动机、情绪方向），能量渐变而不是整块换声。
3. **器乐没焦点**：指定一件领奏，其余支撑。

## 约束与优先级

1. 用户明确的要求与排除项
2. 用户描述里的强暗示
3. 保守的风格默认

**绝不悄悄反转**用户明说的：人声性别、纯器乐、速度上限、必含 / 必禁乐器。用户没给的精确 BPM、调性、演唱者**一律不编造**。段落层面的局部变化交给歌词侧标签，不要在本段里逐段复述编曲。

## 校验清单

- [ ] 一段英文散文，六个句子，顺序 = Style+Mood → Tempo/Groove → Instruments → Vocals → Structure → Production
- [ ] 主风格清楚，附一到两个支持性影响；写了 mood，不只写 genre
- [ ] 乐器有角色与演奏法，不是名单；关键乐器 ≤ 3–4 件
- [ ] 人声有表演层级（主歌克制 / 副歌打开），或器乐有明确领奏
- [ ] 主歌与副歌有编曲对比（contrast），不只是标签
- [ ] 写了制作方向（混音、人声分离、低频）
- [ ] 没抄歌词、没写歌名 / 模板 ID / 方括号段落标签、没 JSON
- [ ] 没编造精确 BPM / 调性（除非用户给了）
- [ ] 45–110 英文词、< 2000 字符、无互斥堆砌

## 示例库（都符合上面那段形态）

**Pop**：Bright modern pop with a warm, optimistic mood and a steady mid-tempo groove. Clean electric guitar, light synth layers, punchy drums, and melodic bass. Clear female lead vocal with conversational verses and a bigger, more energetic chorus supported by layered harmonies.

**R&B**：Slow atmospheric R&B with a nocturnal and intimate mood. Deep sub-bass, sparse electric piano, soft percussion, and ambient synth textures. Warm male baritone vocals with restrained emotional delivery and subtle breathiness. Keep the arrangement spacious around the vocal.

**器乐影视**：Minimal cinematic score led by intimate piano, reflective and unresolved. Slow tempo with a wide, hall-like space. Low strings build tension underneath while distant synth pads blur the edges. Let the opening piano motif return and dissolve at the end. Clean, restrained mixing with a soft, controlled low end.

**游戏**：Dark fantasy boss-battle music with aggressive orchestral metal and a menacing, driven mood. Fast, driving tempo with heavy percussion. Distorted guitar accents, deep brass, and pounding low drums attack the front. Start oppressive and controlled, then build steadily toward a powerful, triumphant final section. Wide, punchy mixing with clear separation.

**BGM**：Warm instrumental lo-fi jazz for a quiet café, relaxed and unobtrusive. Slow tempo with a loose, laid-back groove. Soft electric piano, muted bass, light brushed drums, and occasional clean guitar phrases. Keep one instrument leading each idea and leave plenty of space in the arrangement. Mellow beat with lo-fi elements, gentle tape warmth, and a soft, unobtrusive low end.

## 交付

1. **风格提示词**：唯一供粘贴的那一段（不加围栏、不加标题）。
2. **一行边界说明**：本段不含唱词；段落标签与唱词见内置技能 `minimax-music-lyrics`（`music_gen` 端口 1）。
3. 用户说了上一版的问题 → 只列**最小改动**，整段重贴一份改后版本。
4. 用户只要「再来一版」→ 保持同一人声角色与核心乐器，换掉情绪与制作句，别整块换声。
