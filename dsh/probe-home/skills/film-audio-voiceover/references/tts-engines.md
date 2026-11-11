# TTS 引擎参数表（配音与旁白）

所有价格为上游抓取时（2026-11-04）公开数值，只用于估算；下单前查官方当期价。

## 1. ElevenLabs

### 模型

| model_id | 定位 | 语言 | 延迟 |
| --- | --- | --- | --- |
| `eleven_multilingual_v2` | 质量最高，长旁白首选 | 32 | 标准 |
| `eleven_turbo_v2_5` | 速度与质量折中 | 32 | 低 |
| `eleven_flash_v2_5` | 超低延迟流式 | 32 | ~75 ms |
| `eleven_v3` | 情绪幅度最大（alpha），支持音频标签 | 32+ | 较高 |

### 音色参数

| 参数 | 范围 | 默认 | 效果 |
| --- | --- | --- | --- |
| `stability` | 0.0–1.0 | 0.5 | 越低越有起伏，越高越稳（播报） |
| `similarity_boost` | 0.0–1.0 | 0.75 | 越高越贴原音色 |
| `style` | 0.0–1.0 | 0.0 | 风格夸张度（v2 系） |
| `speed` | 0.5–2.0 | 1.0 | 播放速度倍率 |

### 输出格式

| 格式码 | 采样率 | 码率 | 门槛 |
| --- | --- | --- | --- |
| `mp3_44100_128` | 44.1 kHz | 128 kbps | 免费（默认） |
| `mp3_44100_192` | 44.1 kHz | 192 kbps | Creator+ |
| `pcm_44100` | 44.1 kHz | 无损 | Pro+ |

交付走 `mp3_44100_192` 或 `pcm_44100`；只做样音用默认 128。

### 常用音色 ID

| 名字 | voice_id | 性格 |
| --- | --- | --- |
| George | `JBFqnCBsd6RMkjVDRZzb` | 温暖旁白 |
| Rachel | `21m00Tcm4TlvDq8ikWAM` | 清晰女声 |
| Adam | `pNInz6obpgDQGcFmaJgB` | 专业男声 |

### 克隆

- 即时克隆：`client.voices.ivc.create(name=..., files=[...], remove_background_noise=True)`，传文件句柄（`"rb"`），不要传路径。
- 素材：2–3 段、总时长 1 分钟以上效果最好；m4a 先转 mp3：`ffmpeg -i in.m4a -codec:a libmp3lame -qscale:a 2 out.mp3`。
- 专业克隆：Creator 计划以上，30 分钟以上音频。

### 错误码

| 码 | 含义 | 处理 |
| --- | --- | --- |
| 401 | Key 无效 | 查环境变量，不要回显 |
| 403 | 功能不可用 | 升级套餐或换模型 |
| 422 | 参数非法 | 查 `stability`/`style` 范围与文本长度 |
| 429 | 限流 | 退避重试，不要并发猛冲 |

## 2. Azure AI Speech（TTS）

- 接口：`https://<region>.tts.speech.microsoft.com/cognitiveservices/v1`（同步，无需 Blob、无需轮询）。
- 凭据：`AZURE_SPEECH_KEY` + `AZURE_SPEECH_REGION`（或 `AZURE_TTS_ENDPOINT` 覆盖完整主机）；一个 Speech 资源同时供 TTS 与 STT。
- 单请求上限：10 分钟音频。
- 文本自动 XML 转义：不要自己包 SSML，传纯文本 + `rate` / `pitch` / `style`。

### 音色

| 别名 | 全名 | 性格 |
| --- | --- | --- |
| `andrew` | `en-US-AndrewMultilingualNeural` | 温暖、可信、口语（默认） |
| `brandon` | `en-US-BrandonMultilingualNeural` | 低沉、克制 |
| `ava` | `en-US-AvaMultilingualNeural` | 明亮、自信女声 |
| `guy` | `en-US-GuyNeural` | 权威 |
| `jenny` | `en-US-JennyNeural` | 亲和、清晰 |

也可直接传完整短名（如 `de-DE-KatjaNeural`）；`Multilingual` 系列跨语种更稳，`locale` 要跟文本语言一致。

### 表演参数

| 参数 | 建议值 | 说明 |
| --- | --- | --- |
| `rate` | `-4%` ~ `-8%` | 旁白稍慢更好懂 |
| `pitch` | `0%` | 除修音色外不要动 |
| `style` | `narration-professional` / `calm` / `newscast` | 仅部分音色支持，不支持时静默忽略 |

### 输出与计价

- `output_format`: `mp3`（48 kHz / 192 kbit）交付；`wav`（48 kHz PCM）进混音。
- 标准层约 **$16 / 1M 字符**（≈ $0.016 / 1k 字符；150 词段落 ≈ $0.015）。
- 确定性：固定音色 + 固定 SSML 重渲染基本一致，可单独重做某段而不重录全套。

## 3. 豆包 Speech 2.0（火山引擎）

### 鉴权（新控制台）

```text
POST https://openspeech.bytedance.com/api/v3/tts/submit
X-Api-Key: ${DOUBAO_SPEECH_API_KEY}
X-Api-Resource-Id: seed-tts-2.0
```

长解说优先异步：`/api/v3/tts/submit` 提交 → `/api/v3/tts/query` 轮询，返回 `audio_url` 与 `sentences[].words[]`。

### 参数

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `voice_id` | `DOUBAO_SPEECH_VOICE_TYPE` | 如 `zh_female_vv_uranus_bigtts` |
| `resource_id` | `seed-tts-2.0` | 2.0 音色必须用这个 |
| `speech_rate` | `0` | `0` 正常，`100`=2x，`-50`=0.5x |
| `sample_rate` | `24000` | 交付可再升采样到 48 kHz |
| `enable_timestamp` | `true` | 关掉就没字级时间戳 |
| `return_usage` | `true` | 返回用量 |

### 坑

- `load grant: requested grant not found`：Key 类型或鉴权头错，新控制台只用 `X-Api-Key`。
- `speaker permission denied`：音色 ID 错或未对该 resource 授权。
- `quota exceeded`：额度、终身字符数或并发超限。
- 时间戳缺失：确认 `enable_timestamp: true`，并保存 query 返回的 JSON 作为字幕唯一依据。
- 不要默认传 `additions.explicit_language`，部分组合会报 `unsupported additions explicit language zh-cn`。

## 4. Fish Audio

```text
POST https://api.fish.audio/v1/tts
Authorization: Bearer ${FISH_AUDIO_API_KEY}
model: s2.1-pro        # HTTP header，不是 body 字段，且必填、无默认
```

### 模型

| model | 说明 |
| --- | --- |
| `s2.1-pro` | 最新一代，内联情绪标签，80+ 语言，多说话人，主打旁白 |
| `s2.1-pro-free` | s2.1-pro 的促销免费入口（源记载免费至 2026-08-31，已过期；无 SLA，商用受限） |
| `s2-pro` | 第一代 S2，稳定高质量，支持情绪标签 |
| `s1` | 上一代旗舰，兼容老集成；**不解释情绪标签** |

### 计价

按**输入文本 UTF-8 字节**计费，不按字符：中日韩与 emoji 约为同长度 ASCII 的 3–4 倍成本。列表价 `s1`/`s2-pro`/`s2.1-pro` = **$15 / 1M 字节**。

### 表演与质量参数

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `reference_id` | 无（用模型默认音色） | playground 里建好的音色模型 ID；不支持请求内即时克隆 |
| `latency` | `normal` | `balanced` / `low` 会牺牲一点质量 |
| `normalize` | `true` | 数字、日期、货币读法更自然，别关 |
| `prosody` | `{"speed":1.0,"volume":0}` | 语速与音量微调 |
| `mp3_bitrate` | `128` | 音乐垫底的混音用 `192` |
| `temperature` | `0.7` | 上到 `0.9` 更有表现力（配情绪标签），降低更稳 |
| `top_p` / `repetition_penalty` | `0.7` / `1.2` | 一般不调 |

### 情绪标签（仅 S2 系）

`That's hilarious [laugh] but let me explain seriously.` —— `[laugh]`、`[whispers]` 会在句中改变表演；`s1` 会把标签当正文念出来。

### 错误码

| 码 | 含义 |
| --- | --- |
| 401 | Key 缺失或错误 |
| 402 | 余额不足 |
| 404 | `reference_id` 不存在或不属于该账号 |
| 空/过短音频 | 文本为空，或 `normalize` 把输入整段剥掉 |

## 5. MiMo TTS（中文口播 / 克隆）

- 模型：`mimo-v2.5-tts`；克隆用 `mimo-v2.5-tts-voiceclone`。
- 内置音色示例：`冰糖`。
- 请求：chat 接口，`messages` 里一条 system/风格指令（自然语言） + 一条 user（实读文本）。
- 克隆：`--voice-ref` 参考音频转 **24 kHz 单声道 WAV，最长 30 秒**，base64 随每段请求发送；只有获得说话人授权才能用。
- 段级控制只有自然语言：语速措辞在 `≥ +6%` 或 `≤ -3%` 才变，中间档位不改变请求。

## 6. 本地引擎

| 引擎 | 调用 | 语速控制 | 备注 |
| --- | --- | --- | --- |
| edge-tts | `edge-tts --voice zh-CN-YunxiNeural --rate=+0%` | 只有 `RATE` | 中文原速约 5.5 字/秒、`+8%` 约 6 字/秒（通用经验值）；有词边界，字幕节拍最准 |
| piper | `piper --model zh_CN-*.onnx` | `--length_scale`（越大越慢） | 纯离线兜底，音色机械 |
| IndexTTS | 自托管 HTTP | 无段级语速 | 必须显式选择，不做自动兜底 |
| GPT-SoVITS | 本地服务 / 训练音色 | 参考音频决定 | 克隆质量取决于 5–10 分钟干净素材 |
| macOS `say` | `say -v Samantha -r 174` | `-r` 词/分钟 | 仅本机快速占位，不做交付 |

## 7. 引擎选择的硬判据

| 需求 | 首选 | 备选 |
| --- | --- | --- |
| 中文长解说 + 字级时间戳 | 豆包 Speech 2.0 | Azure + 本地 ASR 对齐 |
| 高情绪角色台词 / 克隆 | Fish `s2-pro` | ElevenLabs v3 + 专业克隆 |
| 多语种成片 + 稳定批量 | ElevenLabs `multilingual_v2` | Azure `MultilingualNeural` |
| 企业合规 / 可审计 | Azure | 本地 GPT-SoVITS |
| 零成本 / 离线 / 隐私 | edge-tts、piper | IndexTTS |
