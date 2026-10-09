# Breeze TTS 2 本地 TTS（MTNode 插件后端）

基于 [breezeblue-ai/breeze-tts](https://github.com/breezeblue-ai/breeze-tts) 的**本地**文本转语音：
实时流式 Breeze TTS 2 + 参考片段音色库 + OpenAI 兼容 `/v1/audio/speech`（API Key 鉴权）。

## ⚠️ 许可（务必先读）

| 对象 | 许可 | 能不能商用 |
| --- | --- | --- |
| **推理代码**（breeze-tts 仓库） | Apache-2.0 | 可以 |
| **模型权重 / 衍生模型 / 自托管输出** | [BreezeBlue Research and Non-Commercial License](https://huggingface.co/BreezeBlue/Breeze-TTS-2/blob/main/LICENSE) | **不可以**（仅限研究与非商用） |

Apache-2.0 **不授予**权重的商用权；付费订阅只覆盖 breezeblue.ai 托管平台 / API 的输出，不覆盖
自托管（也就是本插件）的输出。请自行确认对参考音频、声音与生成内容拥有合法权利；
**禁止未授权的语音克隆与冒用**。

## 结构

```
app/                    管理服务（FastAPI，本机回环）
  config.py             路径 / 配置 / API Key / ffmpeg 定位 / 许可文案
  voices.py             音色库 voices/<id>/{ref.wav, ref.txt}
  audio.py              PCM(s16le 24k) → wav / flac / mp3，参考音频读取与重采样
  engine.py             推理引擎进程编排（起停 / 探活 / 日志 / 预检）
  server.py             全部 HTTP 接口
  console_banner.py     启动横幅（含许可告知）
engine/                 安装时克隆的 breeze-tts 推理源码
.venv/                  隔离虚拟环境
checkpoints/breeze-tts-2/   Breeze TTS 2 权重
voices/                 参考片段音色库（ref.wav + ref.txt）
tools/ffmpeg/ffmpeg.exe 便携 ffmpeg（mp3 用；缺失不影响 wav / flac）
logs/manager.log        服务与引擎日志
out/                    控制台试听产物
scripts/install.ps1     Windows 原生安装脚本
scripts/download_weights.py  权重下载（ModelScope → hf-mirror → HF 官方）
```

## 安装

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -InstallDir <安装目录>
```

或使用 MTNode 顶栏「插件 · Breeze TTS 2 本地 TTS」的安装向导（推荐），
也可以让 Agent 走 `skills/breeze-tts-local-install`。

可覆盖的环境变量：

| 变量 | 作用 |
| --- | --- |
| `BREEZE_WEIGHTS_DIR` | 已有本地权重目录（跳过下载） |
| `BREEZE_WEIGHTS_REPO` | 权重仓库名（默认 `BreezeBlue/breeze-tts-2`） |
| `BREEZE_TORCH_INDEX` | torch 轮子镜像（默认 aliyun pytorch-wheels cu128，失败回退 cu126） |
| `BREEZE_SKIP_TORCH` / `BREEZE_SKIP_FFMPEG` | 调试用跳过 |

### 国内镜像（必须）

- **Python 库**：清华 `https://pypi.tuna.tsinghua.edu.cn/simple`（回退中科院 USTC）
- **torch**：阿里云 `https://mirrors.aliyun.com/pytorch-wheels/cu128`（回退 cu126）
- **权重**：ModelScope（魔搭）优先 → `hf-mirror.com` → `huggingface.co`
- **引擎源码**：GitHub 直连失败回退 `ghproxy.com`

## 运行（通常由插件启停）

```bat
start_backend.cmd          :: 默认 8772；可传第一个参数改端口
```

管理服务默认 `http://127.0.0.1:8772`（本机回环），推理引擎默认 `8773`。
**引擎按需拉起**：调用 `/api/engine/start` 或第一次合成时由宿主拉起，
首次要在显存里加载约 7.7GB 权重（NVIDIA GPU 必需，12GB 显存起步）。

## 平台说明

官方 README 只写 Linux；本插件做的是 **Windows 原生**适配：依赖里没有 flash-attn，
默认 eager 路径是纯 PyTorch，Windows 可直接跑。**CUDA Graph 的 fast 路径不启用**
（`--fast-all` 需另测）；需要更低延迟时改用官方 Docker / Linux 环境。

## API

```bash
# 音色克隆（参考音频 + 文稿）——OpenAI 兼容接口
curl -X POST http://127.0.0.1:8772/v1/audio/speech \
  -H "Authorization: Bearer $BREEZE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"input":"[叹气] 没想到过了这么久，你还记得我的声音。","voice":"my-voice","response_format":"wav","cfg_scale":1,"seed":42}' \
  -o out.wav

# 音色设计（无参考音频，instruction 描述音色；官方建议 cfg_scale=4）
curl -X POST http://127.0.0.1:8772/v1/audio/speech \
  -H "Authorization: Bearer $BREEZE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"input":"[笑] 欢迎来到今晚的故事时间。","instruction":"一位温柔自信的年轻女性，声音清晰，语气亲切。","cfg_scale":4,"response_format":"mp3"}' \
  -o out.mp3

# 参考音频也可以直接 multipart 传（官方示例口径）
curl -X POST http://127.0.0.1:8772/v1/audio/speech \
  -H "Authorization: Bearer $BREEZE_API_KEY" \
  -F "cfg_scale=4" -F "ref_audio=@reference.wav" -F "ref_text=这是参考音频的准确文字稿。" \
  -F "text=(clears throat) We need to discuss what happened last night." \
  -F "instruction=Speak slowly with a restrained, serious tone." \
  -F "seed=42" -F "response_format=wav" -o voice_direction.wav

# 管理
curl -H "Authorization: Bearer $BREEZE_API_KEY" http://127.0.0.1:8772/api/status
curl -H "Authorization: Bearer $BREEZE_API_KEY" http://127.0.0.1:8772/api/voices
curl -X POST -H "Authorization: Bearer $BREEZE_API_KEY" -F "voiceId=播音" -F "ref_text=参考音频的文字稿" -F "ref_audio=@ref.wav" http://127.0.0.1:8772/api/voices/add
```

### 参数口径

| 字段 | 说明 |
| --- | --- |
| `input` / `text` | 待合成文本。**中文用方括号内联事件**（`[笑]` `[咳嗽]` `[清嗓子]` `[叹气]`），英文用圆括号（`(laugh)` …） |
| `voice` | 音色 id（音色库）。给了参考音频时以参考音频为准 |
| `ref_audio` / `ref_audio_path` | 参考音频（multipart 文件或本机绝对路径） |
| `ref_text` | 参考音频的**准确文稿**。与参考音频必须成对出现 |
| `instruction` | 自然语言指令（音色设计 / 音色导演）。语言要与正文一致 |
| `cfg_scale` | 指令跟随强度；默认 1，**有 instruction 时官方建议 4** |
| `seed` | 采样种子（默认 42），同种子可复现 |
| `speed` | 语速 0.25–4.0（默认 1，本地按重采样实现） |
| `response_format` | `wav`（默认）/ `flac` / `mp3`。引擎吐的是 24kHz s16le PCM，容器由本服务封装 |
| `filename` / `save` | 给了 `filename` 或 `save=1` 时，音频同时落到安装目录 `out/`，路径回在 `X-Breeze-Path` 响应头 |

能力判定（与官方语义一致）：**有参考音频且无 instruction = 音色克隆；有 instruction = 音色导演；
无参考音频 = 音色设计**。`mode` 字段可显式指定 `clone` / `design` / `direction`。

### 错误码

管理服务与引擎的错误都归一成 `{"detail":{"code":…,"message":…}}`：

`text_required` · `ref_text_required` · `ref_audio_required` · `mode_conflict` · `instruction_required`
`bad_cfg_scale` · `bad_speed` · `unsupported_format` · `missing_ffmpeg` · `transcode_failed`
`empty_audio` · `busy_engine` · `engine_loading` · `engine_down` · `engine_rejected`
`not_installed` · `no_weights` · `bad_python` · `torch_missing` · `cuda_unavailable` · `engine_exited`

## 端口与代理

两个端口都是**本机回环**。挂着 Clash / v2rayN 等系统代理时，代理可能把发往
`127.0.0.1` 的请求回一个空 body 的 503，表现成「引擎没起来 / 合成失败」，
且随代理软件是否运行而时好时坏 —— 本服务对回环请求不走代理，下载权重时才走代理。
