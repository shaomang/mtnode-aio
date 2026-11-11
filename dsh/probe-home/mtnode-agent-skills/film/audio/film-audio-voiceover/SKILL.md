---
name: film-audio-voiceover
title: 配音与旁白：选型·表演·对位
description: 把旁白稿做成可剪辑的配音音轨：按语言、情绪与预算选 TTS 引擎，写可执行的表演指令，逐句核算时间窗并做有上限的语速补偿，最后校验音画与口型同步。需要配音、旁白、角色台词、换声重配时用。
tags: 配音, 旁白, TTS, 表演指令, 时间对齐, 口型同步
version: 1.0.0
---

# 配音与旁白：选型·表演·对位

## 何时用

- 已有旁白稿 / 台词稿，要变成能进时间线的音频段。
- 要在 ElevenLabs、Azure、豆包、Fish Audio、本地引擎之间选型或换供应商。
- 逐句音频装不进镜头时间窗，需要缩稿或语速补偿。
- 数字人对口型、后期换声、译制配音之后，要验证音画是否同步。
- 不适用：纯音乐与音效（用 `film-audio-sound-design`）、只做字幕（用 `film-subtitle-production`）、成片响度母版（用 `film-audio-loudness`）。

## 核心原则

1. **先定角色，再选引擎**：纪录片旁白、广告口播、角色表演是三种活，别用一个音色通吃。
2. **先样音后批量**：用最长的、情绪最强的一段先出 10–15 秒样音并让人确认；批量返工的成本是样音的几十倍。
3. **一段一文件、一段一时间窗**：每段必须有 `start` / `end`，禁止整篇合成后再按停顿硬切。
4. **时长只认实测**：合成后 `ffprobe` 读时长，字数估算只能用来写稿预算，不能当结论。
5. **时间窗优先于文本**：装不下先改稿（删虚词、拆句），再用 TTS 语速，最后才用 `atempo`；累计语速倍率 ≤ 1.35。
6. **批准稿不许静默改写**：导演/客户签过的句子，缩稿必须回签；删字要在交付里列出来。
7. **密钥只进环境变量**：API Key 不许出现在项目文件、清单、日志、提示词回显里。
8. **对齐看画面**：音频偏移可以测，口型不能测；报「已同步」之前必须抽帧看。

## 工作流

1. **输入**：旁白稿（Markdown 表格 / CSV / JSON）+ 分镜时间线。
   动作：按语义句切段，补 `start`、`end`、`emotion`、`pause_after_ms`。
   产出：`narration.json`（格式见「关键参数与模板」）。
2. **选引擎**：按语言、情绪强度、是否需要词级时间戳、预算查选型表，定 1 主 1 备（备用要写进交付记录）。
3. **样音**：取首段、最长段、情绪最强段各合成 10–15 秒，试听音色、口音、数字读法、语速。
   分支：不合格 → 换音色/引擎重来；合格 → 锁定 `voice_id` 与 model 并写入 `tts_meta.json`。
4. **批量合成**：并发 2–4，单段超时 120 s，失败重试 2 次；产物落 `tts_segments/nNNN.wav`，命名与段号一一对应。
5. **时长核算**：`ffprobe` 读每段实测时长；超过时间窗 → 进第 6 步；明显长于文本下限（中文 2.5 字/秒、英文 1.5 字/词）→ 判为 TTS 幻读，重合成并保留 `*.rejected.wav`。
6. **超窗处理**（严格按顺序，前一步不够再下一步）：
   删虚词 → 拆句 → 提高该段 TTS 语速（单段 ≤ +8%）→ 段内 `atempo`（≤ 1.20）→ 全局 `atempo`（累计 ≤ 1.35）→ 回退改分镜时长。
7. **拼装**：按 `start` 放置，段间补 `pause_after_ms` 静音；写 `tts_meta.json`（路径、start、实测时长、实际语速、引擎、音色）。
   分支：需要与已有画面严格对位 → 先铺静音轨做「占位时长」，再逐段替换。
8. **音画校验**：`sync.py` 测音频偏移与漂移，`confidence < 0.3` 或偏移贴边视为不可信；对口型镜头抽 3 帧（起始 / 中段 / 收尾）看口型。
9. **交付**：48 kHz 音轨（WAV 24-bit 或 AAC 192 kbps）+ `tts_meta.json` + 引擎/音色/参数/用量记录。

## 关键参数与模板

### 引擎选型表（单价与额度以官方当期为准）

| 引擎 | 模型 / 接口 | 语言 | 表演控制 | 时间戳 | 适用场景 |
| --- | --- | --- | --- | --- | --- |
| ElevenLabs | `eleven_multilingual_v2`（质量）/ `eleven_turbo_v2_5`（快）/ `eleven_flash_v2_5`（~75 ms 流式）/ `eleven_v3`（情绪幅度最大，alpha） | 32+ | `stability` / `similarity_boost` / `style` / `speed`，v3 支持音频标签 | 有（对齐接口） | 多语种成片旁白、需要情绪层次 |
| Azure AI Speech | REST `/cognitiveservices/v1`，`azure_tts` | 多语种神经音色 | SSML `rate` / `pitch` / `style` | 词级（STT 侧） | 企业合规、批量稳定、$16/1M 字符 |
| 豆包 Speech 2.0 | `X-Api-Resource-Id: seed-tts-2.0`，异步 `/api/v3/tts/submit` + `/query` | 中文为主 | `speech_rate`（0 正常，100=2x，-50=0.5x） | `sentences[].words[]` 字级 | 中文长解说、字幕要字级时间 |
| Fish Audio | `POST /v1/tts`，`model` 走 HTTP header | 80+ | 内联情绪标签（S2 起）、`temperature`、`prosody.speed` | 无 | 高情绪克隆音、角色台词 |
| MiMo TTS | `mimo-v2.5-tts` / `-voiceclone` | 中文 | 一句自然语言表演指令 + `emotion` | 无 | 中文口播、10 秒参考音克隆 |
| 本地 | edge-tts（`zh-CN-YunxiNeural`）、piper、IndexTTS、GPT-SoVITS | 依模型 | edge-tts 只有 `RATE`；IndexTTS 无段级控制 | edge-tts 有词边界 | 离线、零边际成本、隐私素材 |

选型判据：**离线优先 → 有字级时间戳需求选豆包 → 要情绪与克隆选 Fish / ElevenLabs → 要稳定批量与合规选 Azure**。

### 表演指令怎么写

| 维度 | 可执行写法 | 反例 |
| --- | --- | --- |
| 情绪 | 「克制、压低、像在耳边说」；Fish 用 `[whispers]`、`[laugh]` 内联 | 「有感情一点」 |
| 语速 | 数值：Azure `-4%`~`-8%`；Fish `prosody.speed=1.0`；豆包 `speech_rate=0/25/50` | 「慢一点」 |
| 停顿 | 逗号 150–250 ms、句号 300–500 ms；段末 `pause_after_ms` 200–400 ms | 靠模型自由发挥 |
| 重音 | 把要重的词单独成短句，或前后加逗号断开 | 全句大写（多数引擎不认） |
| 音高 | Azure `pitch=0%` 保持原声；只有修音色时才动 | 为「有活力」整体升调 |

MiMo 风格指令模板（一句，直接进 messages）：

```text
用{克制/温和/兴奋}的语气，像{纪录片旁白/产品讲解/对朋友说话}一样，语速{中等/略快/略慢}，吐字清楚，句末自然收住。
```

ElevenLabs 情绪档位参考（`stability` 越低越有起伏）：旁白 `0.5`、角色表演 `0.35`、播报 `0.75`；`style` 从 `0.0` 起，每次只加 `0.1`。

### 段内语速策略（按位置给偏移，不是全局加速）

| 段位置 | 语速偏移 | 理由 |
| --- | --- | --- |
| 首段（钩子） | `+5%`（强钩子可 `+8%`） | 前 3 秒抓注意力 |
| 中段 | `0%` | 保持可懂度 |
| 倒数第二段 | `-2%` | 进收束 |
| 末段 | `-5%` | 收尾感 |
| 含省略号/悬念 | `-3%` | 犹豫、留白 |

Fish 接数值 `speed = 1 + 偏移`；MiMo 的自然语言指令只在 `≥ +6%` 或 `≤ -3%` 时改措辞，中间档位不会真正改变合成请求（缓存也据此命中）。

### 时长预算公式

```text
预计语音时长(s) = 有效字数 ÷ 语速(字/秒) + 标点数 × 0.25 + 段末停顿
其中：中文口播 4.5–5.5 字/秒；克制 2.5–3.2；自然 3.5–4.2；急促 4.5–5.5（通用经验值）
      英文按词：2.9 词/秒（通用经验值）
      数字逐个计 1 字；`%` 按「百分之」计 3 字
```

- 幻读判定：段音频时长 > `首尾静音 + 字数 ÷ 2.5`（中文）即判失败重合成。
- 时间窗留白：镜头时长 = 语音实测时长 + 0.3~0.5 s（呼吸与转场余量）。
- 双语/译制：目标语速按 5 字/秒写稿，超过 7 字/秒必须拆句（人耳开始跟不上）。

### 旁白脚本格式

```json
{
  "engine": "fish-audio",
  "voice": {"model": "s2-pro", "reference_id": "<playground-voice-id>"},
  "segments": [
    {"id": "n01", "start": 0.2, "end": 3.6, "narration": "先看结论。", "emotion": "calm", "pause_after_ms": 250},
    {"id": "n02", "start": 4.0, "end": 11.8, "narration": "同一段素材，换一个顺序，观众的理解就完全不同。", "emotion": "serious"}
  ]
}
```

字段口径：`start` / `end` 用**成片输出时间线的秒**（剪后时间，不是原片时间）；`narration` 只放要念的字，舞台提示另开 `emotion`；`pause_after_ms` 是该段结束后的静音。

### 口型与画面同步

| 做法 | 适用 | 关键参数 |
| --- | --- | --- |
| 先配音后驱动口型（数字人 / 对口型模型） | 已有成片语音，画面跟着嘴动 | 输入 48 kHz 单声道；给 0.1–0.2 s 预卷，避免吞首字 |
| 先定口型后配音（动画 / 逐帧） | 动画、游戏 CG | 音素或音节切点对齐到帧；25 fps 下每帧 40 ms，误差允许 ±1 帧 |
| 后期换声（保留原表演） | 译制、修音 | `sync.py --replace-audio`；换声后原音轨保留备查 |

对口型必须看：起始帧（第一字是否对上下颌打开）、重音帧、收尾帧（是否提前闭嘴）。`sync.py` 只测音轨偏移，**`lip_sync` 属于未测项**，不能拿偏移 0 当口型正确。

细表（各引擎全部参数、错误码、限额、计价）见 `references/tts-engines.md`；脚本模板、`ffmpeg` 拼装与口型校验命令见 `references/voiceover-script-format.md`。

## 常见坑

- **音色对了但语速全片偏快**：为了塞进时长做了全局加速 → 先改稿删字，全局 `atempo` 不超过 1.15，累计不超过 1.35；超过 1.35 人耳会听出「赶」。
- **TTS 念完正文又编一段**：段音频长度超过 2.5 字/秒对应的上限 → 按幻读处理：重合成、不入缓存，保留 `*.rejected.wav` 备听；别把编出来的话放进成片。
- **Fish 情绪标签被念出来**：用了 `s1` 模型 → 只有 `s2-pro` / `s2.1-pro` 解释 `[laugh]` 一类标签；`s1` 必须先剥标签。
- **豆包报 `load grant: requested grant not found`**：用了老控制台的 `X-Api-App-Id` + `X-Api-Access-Key` → 新控制台 Key 只发 `X-Api-Key` + `X-Api-Resource-Id: seed-tts-2.0`。
- **Azure 设了 `style` 却没变化**：该音色不支持 express-as，Azure 会静默忽略 → 先出 10 秒样音确认，不支持就换 `MultilingualNeural` 音色。
- **合成完听着对，剪进片子口型差半拍**：段起点按估算时间放的 → 以 `tts_meta.json` 的实测 `start` 放置，并用 `sync.py` 复测偏移。

## 来源与合并说明

| 上游仓库 | ★ | 许可 | 贡献内容 |
| --- | --- | --- | --- |
| calesthio/OpenMontage | 76149 | AGPL-3.0 | `elevenlabs`、`azure-text-to-speech`、`doubao-tts`、`fish-audio-tts`、`text-to-speech`：引擎参数、音色、计价、错误码；`ffmpeg` 的音频处理命令 |
| zenstory-ai/video-recap-skills | 601 | MIT | `video-voiceover`：时间窗适配、语速预算与累计上限、幻读检查、克隆授权门禁；`video-cut` 的句界吸附 |
| kajisho5/ffmpeg-skill | 4475 | MIT | `sync.py` 音轨对位与漂移校正、置信度阈值、`lip_sync` 未测口径 |
| joeseesun/qiaomu-cut-skill | 377 | MIT | `timeline-schema.md` 的旁白 cue 结构（`start` / `maxDuration` / 文件型旁白字段） |
| Vincentwei1021/video-shotcraft | 16747 | Apache-2.0 | 声音与画面时间线分离、按成片语境试听的验收口径 |

- 抓取日期：2026-11-04
- 合并的上游技能：text-to-speech、elevenlabs、doubao-tts、fish-audio-tts、azure-text-to-speech、ffmpeg、video-voiceover、video-cut、qiaomu-cut-skill（timeline-schema / social-safe-zones）
- 冲突与取舍：上游 ElevenLabs 页写「音效单次上限 22 秒」，`sound-effects` 技能写 `duration_seconds` 范围 0.5–30 秒 —— 配音侧不受影响，音效侧见 `film-audio-sound-design` 并列两说。Fish `s2.1-pro-free` 的免费窗口按源记载截至 2026-08-31，抓取时已过期，正文按付费 `s2.1-pro` 估价，不把免费额度写进预算。
