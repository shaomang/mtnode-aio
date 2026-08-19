---
name: minimax-music-prompt
title: MiniMax Music 提示词
description: 按 MiniMax Music / Music 3 官方规范写风格提示词与 Structured Caption（Global Metadata、Vocal Details、Arrangement），控制曲风、人声、乐器、结构与制作，且不把歌词写进 prompt。
---

# MiniMax Music 提示词

用户要写或改 MiniMax Music（含 Music 3）的 **音乐描述 / prompt / instructions / Structured Caption** 时使用。本 skill **不写歌词**；唱词与 `[Verse]` 标签交给「MiniMax Music 歌词」skill。

依据：[MiniMax Music 3](https://github.com/MiniMax-AI/MiniMax-Music3)、官方 skill [`music-caption-rewriter`](https://github.com/MiniMax-AI/MiniMax-Music3/tree/main/skills/music-caption-rewriter)、[MiniMax Music Prompt Guide](https://www.minimax-music.com/blog/minimax-music-prompt-guide)、[Prompt Writing Guide](https://github.com/MiniMax-AI/skills/blob/main/skills/minimax-music-gen/references/prompt_guide.md)、[Music Generation API](https://platform.minimax.io/docs/api-reference/music-generation)。

## 任务

把用户的一句话想法扩成可生成的音乐描述。默认产出两档，让用户按产品粘贴：

1. **短提示词**：连贯英文句子（约 80–180 词），适合网页端 Styles 或 API `prompt`（上限 **2000** 字符）。
2. **Music 3 Structured Caption**：固定三个标题 —— `Global Metadata` / `Vocal Details` / `Arrangement`（约 250–450 英文词，除非用户指定长度）。开源 Music 3 把该文放到 `instructions`，歌词仍在 `input`。

除非用户明确要求中文提示词，**提示词用英文写**（官方：English prompts work best；中文场景词可点缀）。不要把歌词原文抄进 caption。

## 两个输入如何分工

风格提示词定义世界；歌词结构指挥世界内部。

| 写进 prompt / caption | 写进 lyrics |
|---|---|
| 曲风、情绪、场景、用途 | 实际唱词 |
| 人声身份、唱法、和声层次 | `[Chorus]` 等标签 |
| 乐器角色与演奏法（slide、legato） | 可唱衬词 `(Ooh)` |
| 段落编曲对比、制作、空间 | 不要舞台指示 |

同一指令不要两边各写一遍。歌词里若出现「副歌加鼓」这类**音乐指令**，吸收进 Arrangement，不要写进唱词。

## 七层公式（短提示词）

`Style + Mood + Tempo/Groove + Instruments + Vocals + Structure + Production`

不必写满每一秒。选对这首歌要紧的层：

| 层 | 控制什么 | 写法 |
|---|---|---|
| Style | 音乐身份 | 1 个主风格 + 最多 1–2 个有用影响 + 美学 |
| Mood | 情绪 | 暖/暗/能量/平静中选具体词，不要只写 genre |
| Tempo & Groove | 运动 | slow / mid-tempo / 约 90 BPM；laid-back、driving、syncopated |
| Instruments | 声音调色 | **乐器 + 角色 + 演奏**，不要纯名单 |
| Vocals | 人声表演 | 声部 + 音色 + 唱法 + 情绪；主歌与副歌可以不同 |
| Structure | 发展 | 疏主歌、满副歌；Intro→Build→Release→Contrast→Resolve |
| Production | 成品感 | clean mix、warm vintage、controlled low end |

官方更好规则：**一个主风格 + 一到两个支持性影响**，不要堆互斥标签。

### 短提示词句式

```
A [mood] [optional BPM] [genre + subgenre] song/piece.
[Vocal character OR "Instrumental with..." lead].
[Scene / purpose / what it is about — not lyric quotes].
[2–3 key instruments with roles and techniques].
[Section contrast and production].
```

写**句子，不要逗号标签清单**。`"A melancholic R&B song about…"` 优于 `"R&B, sad, slow, piano"`。旧版逗号标签仅在用户点名兼容旧 API 时使用。

### 从一句话扩写（官方六步）

1. 主风格与影响  
2. 情绪与律动  
3. 声音调色（乐器角色）  
4. 歌手怎么唱（或器乐谁领奏）  
5. 段落对比（主歌疏、副歌宽）  
6. 制作方向  

每一句都要能变成听得见的决定。

## Music 3 Structured Caption

按此顺序，恰好三个一级标题：

### Global Metadata

曲风与子风格、速度（无依据不要编精确 BPM，用范围或 qualitative）、情绪进程、聆听场景、制作轮廓。调性/音阶仅在用户明确或确实有用时写。

### Vocal Details

有人声：主唱配置、音色、音域、唱法、和声/伴唱、克制的人声效果（呼吸、咬字、和声叠层；Music 3 人声引擎针对这些）。

器乐：写明 instrumental，并指出承担主旋律的乐器/织体。用户要求纯器乐时**禁止添加人声**。

不要编造歌词主题句，不要复述歌词。

### Arrangement

按**用户歌词里的段落标签**做时间线；没有标签则用风格合适的默认：

`Intro → Verse → Pre-Chorus → Chorus → Verse → Chorus → Bridge → Final Chorus → Outro`

每一段写清：什么进来、出去、变强、变疏。乐器要有进入/变化/退出，而不是设备清单。过渡要说得通。不要歌名、模板 ID、推理过程、歌词原句。

段落标签告诉模型**歌在哪**；段落说明告诉模型**这里发生什么**。网页端可在 `[Chorus]` 后写编曲备注；Structured Caption 里把这些备注写进对应段，不要写进 lyrics。

## 各层写法要点

**风格：** 先定主 genre（Pop / R&B / Hip-hop / Indie folk / Rock / Jazz / Classical / Electronic / Lo-fi 等）→ 加一个影响（modern R&B with melodic trap；indie folk with cinematic orchestration）→ 加美学（bright but nostalgic nighttime-city）。

**情绪词库：** 暖 romantic/hopeful/nostalgic；暗 tense/lonely/melancholic；能量 triumphant/playful/euphoric；静 dreamy/intimate/atmospheric。

**乐器：** `Clean electric guitar playing slow legato phrases with occasional expressive slides.` Music 3 强调演奏法（slides、legato）。弱：`guitar, piano, drums`。强：前景/背景分工，人声为主时不要件件同等活跃。

**人声五维，选层级不要堆十个形容词：** Voice type（female alto、male baritone）+ Tone（warm、breathy、raspy）+ Delivery（intimate、sing-rap、powerful）+ Technique（legato、subtle vibrato、layered close harmonies）+ Emotion（yearning、detached）。给表演去处：主歌克制，副歌打开。

**器乐焦点：** 指定一个领奏，其余支撑。`Reflective cinematic music led by intimate piano, with soft strings building gradually behind it.`

## 约束与优先级

1. 用户明确要求与排除  
2. 歌词标签上的段落局部指令（只作用于该段）  
3. 用户描述中的强暗示  
4. 保守的风格默认  

标签可以改局部编曲，不能偷换全局曲风。不要悄悄反转：人声性别、器乐、速度上限、必含/禁用乐器。未指定精确 BPM/调性时不要编造。

Open-source Music 3 限制（告知即可，不必写入 prompt）：文本条件约 5000 token；最长约五分钟；标签与描述是生成性控制，BPM/调性/结构不一定逐字兑现。

## 迭代（听完再改最小项）

| 问题 | 改什么 |
|---|---|
| 风格泛 | 影响、年代、美学、使用场景 |
| 人声不对 | 音色 + 唱法（先改人声句） |
| 副歌不够大 | 只加副歌对比：更满的鼓、更强的唱、更宽的和声 |
| 太满 | 减少乐器数量与角色 |
| 平 | 段落发展，不要换曲风 |
| 情绪错 | 情绪词 |
| 节奏弱 | tempo + groove |
| 混音挤 | 更简单编曲 + 人声分离 |
| 歌词听着赶 | 去改歌词 skill，不改风格 |

一条问题 → 一次修改 → 一次试听。不要整段重写，除非曲风、情绪、人声、结构全错。

提示被忽略时：减少互斥细节，按 **Style → Mood → Key Sounds → Vocal/Instrumental Focus** 排序，关键句靠前。

## 输出格式

1. **短提示词**（可粘贴）  
2. **Structured Caption**（三标题，可粘贴到 Music 3 `instructions`）  
3. **与歌词的边界**（本 caption 未包含唱词；段落标签应对齐用户歌词）  
4. **可选修改建议**（若用户说了上一版问题，只列最小改动）

用户只要一档时，只给那一档。默认英文。JSON 仅在用户要机器可读时给，字段含 `prompt` 与 `rewritten_caption`，不要塞歌词全文。

## 短提示词示例（官方方向）

**R&B：** Modern dark R&B with subtle melodic trap influences, introspective and nocturnal, with a slow laid-back groove. Deep 808 bass, sparse piano chords, atmospheric synth pads, and restrained drums. Warm male baritone vocals with intimate, slightly detached sing-rap phrasing. Keep the verses sparse, then open into a wider chorus with stronger drums and layered harmonies. Clean modern mixing with clear vocals and controlled low end.

**Pop：** Bright modern pop with a warm, optimistic mood and a steady mid-tempo groove. Clean electric guitar, light synth layers, punchy drums, and melodic bass. Clear female lead vocal with conversational verses and a bigger, more energetic chorus supported by layered harmonies.

**器乐影视：** Minimal cinematic score beginning with low piano and distant strings. Slowly introduce pulsing synthesizers and restrained percussion as tension rises. Build toward a broad orchestral climax, then resolve with the original piano motif.

**游戏：** Dark fantasy boss-battle music with heavy low percussion, aggressive strings, distorted guitar accents, and deep brass. Start oppressive and controlled, then steadily build toward a powerful, triumphant final section.

**BGM：** Warm instrumental lo-fi jazz for a quiet café, relaxed and unobtrusive. Soft electric piano, muted bass, light brushed drums, and occasional clean guitar phrases. Keep the melody subtle and leave plenty of space.

场景比空标签有用：`Upbeat indie pop for a carefree summer road-trip montage` 优于 `Upbeat indie pop`。

## 校验清单

- [ ] 主风格清楚；有情绪，不只 genre  
- [ ] 乐器有角色/演奏法，不是名单  
- [ ] 人声有表演层次，或器乐有领奏  
- [ ] 主歌/副歌有编曲对比  
- [ ] 未抄歌词、未写舞台指示进 lyrics  
- [ ] 未编造精确 BPM/调性（除非用户给了）  
- [ ] 短提示词 < 2000 字符；Caption 有且仅有三个标题  
- [ ] 无互斥堆砌（calm ballad + high energy dance）  
