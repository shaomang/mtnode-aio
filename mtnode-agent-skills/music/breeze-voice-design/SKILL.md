---
name: breeze-voice-design
title: Breeze 音色设计
menu: user
description: 【内置·随应用发版，不需从工坊安装】把用户一句话的需求扩成 Breeze TTS 2 的音色提示词（instruction），两档：默认「简洁」= 按性别年龄 / 音色质感 / 语速节奏 / 情绪性格 / 场景用途五个槽位拼成一句自然语言；「详细」= 固定四段分行（声线类型 / 音色关键词 / 共鸣位置 / 参考质感）。语言跟随台词或用户输入，配 cfg_scale=4 与 seed=42。交付时只给提示词正文。用于 MTNode「Breeze 语音生成」节点（breeze_gen）端口 3 的指令，或 breezeblue.ai API 的 instruction 字段。
---

# Breeze 音色设计

**本技能是应用内置技能**（随安装包发版，与 `minimax-music-*` 同一套内置标记，`/` 菜单可点名）。

用户要「设计一个音色 / 描述一个声音 / 给角色定声音」时用它。它只做 **Voice Design（音色设计，无参考音频）** 这一条路；台词怎么写、语气怎么落到正文里，交给内置技能 `breeze-script-format`。

依据：
- [Breeze TTS 2 官方 README（模型卡）](https://hf-mirror.com/BreezeBlue/breeze-tts-2/raw/main/README.md) —— Voice Design 示例、`--cfg-scale 4`、instruction 语言需与目标文本一致。
- 本仓库 `breeze-pack/app/server.py` 的 `_resolve_mode()` —— 模式判定口径（无参考音频 = design；有参考音频 + instruction = direction；有参考音频无 instruction = clone）。

## 输出格式（硬口径，不可改形态）

本技能有两档，**默认简洁档**；只有调用方明确说要「详细 / 四段」时才走详细档（见下一节）。两档都**不可改形态**。

简洁档交付给用户的**只有那一句音色提示词正文**：

- 一句自然语言（中文 30–60 字 / 英文 20–40 词为宜），句内用逗号并列，最后收一个句号。
- **不要**标题、不要「提示词：」之类的引导词、不要代码围栏、不要表格、不要槽位清单、不要解释理由、不要 JSON、不要附「贴到端口 3」之类说明。
- 用户追问「还能怎么改」时才展开；单纯要提示词就只给那一句。
- 语言：**跟随台词语言**；用户没给台词时**跟随用户输入的语言**（中文提问 → 中文 instruction，英文提问 → 英文 instruction）。官方要求 instruction 与目标文本同语言，混语言会削弱指令跟随。

## 详细档（可选：四段分行）

用户明确要「更详细的声线描述 / 四段式 / 像人设卡那样」时用它。形态**固定四段**，每段一行或两行，段首标题加冒号，段与段之间空一行；不要开场白、不要解释、不要 JSON、不要引号、不要代码围栏。

| 段 | 写什么 |
| --- | --- |
| 声线类型 | 声部与年龄感 + 音色明暗冷暖 + 质地 + 语速；必要的排除项写在括号里（如「非萝莉尖细型，非御姐低沉型」） |
| 音色关键词 | 4–6 个词，顿号并列（英文逗号），只写形容词 / 名词短语，不解释 |
| 共鸣位置 | 哪一路共鸣为主、哪一路偏少、哪一路偶尔点缀，并点出听感后果（显年轻 / 不沉稳 / 激动时往上飘） |
| 参考质感 | 一到两句通感比喻（从日常场景取材）+ 气息 / 鼻音 / 摩擦感等细节 |

- 长度：四段合计约 120–300 个汉字（英文约 60–150 词），宁短勿堆；四段不许互相矛盾，也不要堆互斥词。
- 场景 / 用途（含「备选音色」这次要主导的场景 / 情绪）**写进「参考质感」**，不新增第五段。
- 语言同样跟随台词 / 输入语言：英文设定时四个标题改用 `Voice type / Tone keywords / Resonance / Reference texture`，内容也用英文，仍是四段。
- 详细档用于 Breeze 的 instruction 时比简洁档长得多；若听感变钝（指令跟随下降），先回简洁档，或只保留最关键的「声线类型」+「音色关键词」两段。

## 五个槽位（内部思考用，不输出）

| 槽位 | 要定什么 | 可用的词 |
| --- | --- | --- |
| 性别 · 年龄 | 声部与年龄感 | 年轻女性 / 成熟男性 / 中年女性 / 少年 / 老人；female, male, young, middle-aged |
| 音色质感 | 声音的「材质」 | 温柔 / 清澈 / 低沉 / 沙哑 / 明亮 / 磁性 / 气声感 / 干净利落；warm, clear, deep, raspy, bright, airy |
| 语速 · 节奏 | 快慢与停顿习惯 | 语速偏慢、字句从容 / 中速自然 / 语速偏快、节奏利落 / 停顿克制 |
| 情绪 · 性格 | 稳定的底色（不是某一句的情绪） | 亲切自信 / 冷静克制 / 活泼俏皮 / 沉稳可靠 / 疲惫疏离 |
| 场景 · 用途 | 这句话要用在哪 | 有声书旁白 / 客服播报 / 短视频口播 / 游戏角色 / 纪录片解说 |

**怎么拼**：挑 3–4 个**决定性**维度写成一句，别把五个槽位都塞满形容词。堆互斥词（`又活泼又沉稳`、`warm, cold, bright, dark`）会被模型平均掉。

```
[性别年龄] + [音色质感]，[语速节奏]，[情绪性格]，适合[场景用途]。
```

官方示例（中文）：`一位温柔自信的年轻女性，声音清晰，语气亲切，表达轻快而富有感染力。`
官方示例（英文）：`A warm, thoughtful young woman with a clear voice and a calm, reflective delivery.`

## 缺项怎么办

- 用户只给了场景（「游戏里的大反派」）→ 按场景给**保守默认**（低沉中年男声 + 慢速 + 压迫感），不要编造具体年龄 / 口音 / 地域。
- 用户给了明确排除项（「不要甜」「别太播音腔」）→ 必须照做，并在同一句里换成反向词（`克制、不甜腻`）。
- 用户没说语言 → 跟输入语言；台词是英文就给英文 instruction，即使需求是中文写的。

## 模式边界（先确认，再写）

| 模式 | 需要什么 | instruction 里写什么 |
| --- | --- | --- |
| 音色设计（本技能） | **没有**参考音频 | 音色 + 语速 + 情绪底色（音色**只来自 instruction**） |
| 音色克隆 | 参考音频 + 逐字参考文稿（必须成对） | 不写 instruction（写了就变导演模式） |
| 音色导演 | 参考音频 + 参考文稿 + instruction | 只写**表演**（语气、情绪、节奏），不重复描述音色 |

用户其实要克隆（「照这个人的声音」）或导演（「用这个声音读得凶一点」）时，告诉他要走哪条路并要参考音频 + 文稿，不要硬用音色设计顶替。台词侧的气口、事件、分段见 `breeze-script-format`。

## 参数

- `cfg_scale = 4`：官方建议在 instruction 场景用 4 来加强指令跟随（本仓库后端缺省也是 4）。再往上调往往换来失真与机械感，别默认开高。
- `seed = 42`：要复现同一条结果就固定 seed；换 seed 才是换一版（±1 递增）。
- 输出为 24kHz 单声道，一次运行只出一个音频文件。

## 贴到哪里

- MTNode：节点「Breeze 语音生成」（`breeze_gen`）——**端口 3 = 指令 instruction**；节点设置里「能力」选**音色设计**、音色库留空、不接参考音频与参考文稿；`cfg_scale` 填 4、`seed` 填 42。
- 官方 API：`POST /v1/audio/speech` 的 `instruction` 表单字段 + `cfg_scale=4`（见官方 README 的 Voice Design 段）。
- 许可提醒：自托管权重与输出受 BreezeBlue Research and Non-Commercial License 约束，仅限研究与**非商用**用途；不得未授权克隆或冒用他人声音。

## 迭代：听一遍，只改一处

| 听出来的问题 | 只改这一槽 |
| --- | --- |
| 声音太「播音腔」/ 太标准 | 场景槽 → 加「口语感、不端着」；质感槽去「清晰」 |
| 太甜 / 太软 | 情绪槽换「冷静克制」，质感槽去「温柔、亲切」 |
| 太老 / 太小 | 只改性别年龄槽 |
| 太快 / 太赶 | 只改语速槽（字句从容、停顿克制） |
| 情绪不对 | 只改情绪槽，别动音色 |
| 像另一性别 | 性别年龄槽写死声部（男低音 / 女中音） |

一次只改一个槽，重贴一整句（不是贴补丁）。

## 校验清单

简洁档（默认）：

- [ ] 只有一句正文，无标题 / 无围栏 / 无解释 / 无 JSON
- [ ] 语言与台词（或用户输入）一致
- [ ] 覆盖 3–4 个槽位，没有互斥堆砌
- [ ] 用户明说的要求与排除项都在里面，没编造年龄 / 口音 / 地域
- [ ] 是设计模式（无参考音频）；要克隆 / 导演的已改走对应路径
- [ ] 附带的参数口径是 `cfg_scale=4`、`seed=42`

详细档（用户点名要时才用）：

- [ ] 恰好四段，段首标题加冒号，段间空一行，无开场白 / 无解释 / 无围栏
- [ ] 关键词段 4–6 个词、顿号并列；场景写进「参考质感」，没有第五段
- [ ] 合计约 120–300 字（英文 60–150 词），四段互不矛盾
- [ ] 语言一致；英文时四个标题也是英文

## 示例库（简洁档：都只有一句正文）

**中文 · 有声书旁白**：一位声音低柔的中年男性，嗓音略带沙哑，语速偏慢、句间留白从容，适合深夜长篇旁白。

**中文 · 短视频口播**：一位二十五岁上下的年轻女性，声音明亮干净，语速偏快、节奏利落，语气俏皮有元气，适合三分钟好物口播。

**中文 · 游戏反派**：一位低沉的中年男性，共鸣厚实、咬字缓慢清晰，语气冷静而带压迫感，适合黑暗奇幻游戏里的最终反派。

**English · audiobook**：A low, slightly raspy middle-aged male voice with a slow, unhurried pace and generous pauses, suited to late-night audiobook narration.

**English · support IVR**：A clear, warm young female voice with a steady mid-tempo delivery and a patient, reassuring tone, suited to customer-support prompts.

**English · trailer**：A deep, resonant male voice with deliberate pacing and restrained intensity, suited to cinematic trailer narration.

## 示例库（详细档：四段分行）

**中文 · 中高音少女音**：

声线类型：中高音区少女音（非萝莉尖细型，非御姐低沉型），音色明亮偏暖，带一点「毛边感」的沙沙质地，速度中等偏快，像刚跑完步说话时那种微微的气息摩擦感。

音色关键词：透亮、微沙、饱满、不修边幅、有肉感

共鸣位置：以口腔共鸣为主，胸腔共鸣偏少（显得年轻、不沉稳），头腔偶尔点缀（激动时声音往上飘）

参考质感：像夏天午后棒冰融化时的清爽感 + 一点刚睡醒的鼻音残留

**English · morning-radio host**：

Voice type: a bright, slightly husky female voice in her early thirties (not a thin girlish tone, not a deep mature alto), warm mid-bright timbre with a faint sandy edge, medium-fast pace.

Tone keywords: luminous, slightly raspy, full, unpolished, fleshy

Resonance: mostly oral resonance, little chest resonance (which keeps it young and a touch ungrounded), with occasional light head-voice lift when excited.

Reference texture: the cool clarity of a popsicle melting on a summer afternoon, plus a trace of just-woken nasal warmth — suited to a relaxed morning-radio opening.

## 交付

1. 默认只给那一句音色提示词正文，不加任何包装；用户点名要详细版才给四段（同样不加包装）。
2. 用户问「为什么这么写 / 怎么改」→ 才展开槽位与最小改动项。
3. 台词侧的需求（事件、语气分段、口播安全化）→ 指向内置技能 `breeze-script-format`，不在本技能里代写。
