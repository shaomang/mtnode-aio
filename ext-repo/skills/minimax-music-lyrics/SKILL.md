---
name: minimax-music-lyrics
title: MiniMax Music 歌词
description: 按 MiniMax Music / Music 3 官方规范写可演唱歌词：结构标签、可唱行长、副歌钩子、中英歌词，且不把舞台指示写进会唱出来的正文。
---

# MiniMax Music 歌词

用户要写、改、续写 MiniMax Music（含 Music 3 / music-3.0）的 **lyrics** 时使用。歌词与风格提示词是**两个独立输入**：本 skill 只产出歌词；声音、编曲、人声表演交给「MiniMax Music 提示词」skill。

依据：[MiniMax Music 3](https://github.com/MiniMax-AI/MiniMax-Music3)、[MiniMax Music Prompt Guide](https://www.minimax-music.com/blog/minimax-music-prompt-guide)、[Lyrics Generation API](https://platform.minimax.io/docs/api-reference/lyrics-generation)、[Music Generation API](https://platform.minimax.io/docs/api-reference/music-generation)。

## 任务

1. 向用户确认：主题/叙事、语言（中/英/双语）、情绪、目标结构、是否纯器乐。
2. 输出**可直接粘贴**到 MiniMax `lyrics` / Music 3 `input` 的歌词。
3. 默认同屏给出：推荐结构、字数、以及一句「风格提示词应写什么、不要写进歌词」。

纯器乐：不要编造演唱正文。只给结构标签骨架（如 `[Intro]` `[Instrumental]` `[Outro]`），并说明应设 `is_instrumental` / 不传歌词。

## 两个输入如何分工

| 歌词 lyrics | 风格提示词 prompt / Structured Caption |
|---|---|
| 要唱出来的词 | 曲风、情绪、BPM/律动 |
| `[Verse]` `[Chorus]` 等段落标签 | 人声身份与唱法 |
| 可唱的和声拟声 `(Ooh)` `(Yeah)` | 乐器与段落编曲变化 |
| 钩子、重复、对白式短句 | 制作、混音、场景 |

不要把同一句话同时写进歌词和提示词。官方原则：**风格提示词定义声音世界；歌词结构指挥世界里发生什么。**

## 硬性规则

- 最终歌词是纯文本。不要用 Markdown 代码围栏包一层给用户「去粘贴」的那份；若需解释，把解释放在歌词块外面。
- **结构标签单独成行**，用方括号。标签是可执行结构指令，不是歌词。
- **不要把舞台指示写进会唱的正文。** `(music fades)`、`(repeat twice)`、`(Soft piano)`、`(Fade out...)` 会被唱成字。乐器、渐强、淡出写进风格提示词或 Structured Caption 的 Arrangement。
- 括号只用于**要发声**的衬词/和声：`(Ooh-ooh-ooh)`、`(Yeah)`、`(typ-typ-typical)`、`(Coming back to me)`。
- 为唱而写：缩短长句；降低信息密度；相邻行长度接近。目标语速下说不顺的句子必须改短。
- 专有名词、缩写、难读词：改成按读音拼写，或拆到两行。先改那一行，不要整首重写。
- 副歌与主歌必须有**文本对比**：副歌更短、更可重复、有 1–2 个核心短语。
- 事实与编造：用户没给的专名、情节不要硬编进「原著」叙事；可以写通用情绪歌词并标明是创作。
- 长度：对接 music-3.0 非器乐时歌词 **1–3500** 字符；翻唱 cover 常见 **10–1000**。默认完整流行歌控制在约 1500–2800 字符，优先可唱而非堆段。
- 中文歌词按顿挫断行（官方示例一行约 6–12 字）；英文一行约 **8–12 词**。
- 语言：按用户语言写。中文歌词官方 Demo 可用；提示词仍建议英文（见提示词 skill）。

## 结构标签

Music 3 核心（优先用这一套）：

`[Intro]` `[Verse]` / `[Verse 1]` `[Pre-Chorus]` `[Chorus]` `[Post-Chorus]` `[Bridge]` `[Instrumental]` `[Solo]` `[Outro]`

歌词生成 API 另支持：`[Hook]` `[Drop]` `[Build-up]` `[Breakdown]` `[Break]` `[Interlude]`。

音乐生成 API 还可见：`[Pre Chorus]` `[Post Chorus]` `[Build Up]` `[Inst]` `[Transition]`（空格写法）。**同一首歌只用一种拼写**，优先连字符：`[Pre-Chorus]`、`[Post-Chorus]`、`[Build-up]`、`[Instrumental]`。

标签职责：

| 标签 | 写什么 |
|---|---|
| Intro | 短衬词或留空（器乐开场把说明放进提示词） |
| Verse | 叙事、细节、推进 |
| Pre-Chorus | 蓄力，指向副歌钩子 |
| Chorus | 核心承诺句，可原样重复 |
| Post-Chorus / Hook | 更短的记忆点、拟声、品牌句 |
| Bridge | 视角或和声对比，不要再讲一遍副歌 |
| Instrumental / Solo / Interlude | **不要填唱词**；需要的演奏说明写进提示词 |
| Outro | 回收钩子或极短收束 |

默认完整结构（可按需删减）：

`Intro → Verse → Pre-Chorus → Chorus → Verse → Pre-Chorus → Chorus → Bridge → Chorus → Outro`

电子/舞曲可加入 `[Build-up]` `[Drop]` `[Breakdown]`。不要为了显得完整而堆无词标签。

## 写法

1. **先定钩子**：副歌 1–2 句，可单独成歌。
2. **主歌服务副歌**：细节与场景，不要在主歌提前耗尽钩子。
3. **重复是功能**：副歌重复允许；主歌 2 换细节不换节奏型。
4. **衬词克制**：每段最多 1–2 行括号和声，避免整段 `(ooh)`。
5. **情绪弧**：引入 → 推进 → 释放 → 对比 → 收束。副歌歌词应比主歌更直接。
6. **中英混合**：用户要求时，钩子可用短英文，主歌用中文；保持每行可唱。

## 输出格式

按顺序给出：

1. **歌词**（唯一供粘贴的正文，含标签与换行）
2. **结构说明**（各段功能，3–6 条）
3. **演唱风险**（过长行、难读词、已做的改写）
4. **提示词分工**（一句：编曲/人声/制作不要写进歌词，去写 Structured Caption）

不要在歌词里写歌名行（除非用户要把歌名唱出来）。Music 3 生成不要把标题写进 `input`。

## 示例形态（结构，非固定主题）

```
[Intro]
(Ooh-ooh)

[Verse 1]
短句叙事
短句叙事

[Pre-Chorus]
蓄力短句
(呼应钩子)

[Chorus]
核心钩子
核心钩子变体
(短衬词)

[Verse 2]
新细节，行长与 Verse 1 接近

[Chorus]
（可原样或加一行加码）

[Bridge]
对比视角
不要复述副歌

[Chorus]
最强重复

[Outro]
钩子碎片
```

## 修改与续写

- 只改出问题的段或行（官方：先改那句歌词，不改整段 prompt）。
- 续写须沿用已有标签拼写、行长和钩子。
- 用户已有标签内的**音乐指令**（如 Chorus 后的「加鼓、加和声」）不要抄进唱词；列给提示词 skill。

## 校验清单

- [ ] 每个演唱段落都有标签，标签独占一行
- [ ] 无可唱的舞台指示 / 乐器说明
- [ ] 副歌有可重复钩子；主歌与副歌能量不同
- [ ] 行长适合演唱；难读词已处理
- [ ] 总字符符合目标接口上限
- [ ] 器乐段无假唱词
- [ ] 未把风格、BPM、麦型写进歌词
