# Qwen3-ASR 本地语音识别（MTNode 插件后端）

基于 [ModelScope](https://www.modelscope.cn/models/Qwen/Qwen3-ASR-0.6B) 的 **`Qwen/Qwen3-ASR-0.6B`**
本地语音转文字后端：Python venv + transformers 直接加载模型（**不上 FastAPI 之类的 Web 框架，
HTTP 服务只用标准库**），配 ModelScope 的 **`iic/speech_fsmn_vad_zh-cn-16k-common-pytorch`**（fsmn-vad）
做静音分段 —— 长音频先按静音切片、逐段转写再拼接，**不限时长**。

固定只有这一个模型，不做模型切换。

## 这是什么 / 不是什么

- ✅ 本地、离线可跑（模型目录可手填，支持无网搬运）；只监听 `127.0.0.1`，不联网上报。
- ✅ OpenAI 兼容的 `POST /v1/audio/transcriptions`：既能收 multipart 上传的音频字节，
  也能收 `{"audio_path": "本机绝对路径"}` + 热词。
- ❌ 不是流式接口（没有 SSE / 边说边出字），转写是一次请求一次结果。
- ❌ 不做语种识别 / 翻译；`language` 只是作为提示词喂给模型（默认 `auto`）。

## 目录结构

```
asr-pack/                      （安装时复制到用户选定的 INSTALL_DIR）
├─ manifest.json               插件清单（id: asr-local / entry: app / apiPort: 8772）
├─ requirements.txt            推理依赖（torch 不在里面，见下）
├─ scripts/install.ps1         安装 / 修复脚本（幂等，可重复执行）
├─ app/
│   ├─ __init__.py             版本号
│   ├─ __main__.py             `python -m app <port>` 入口
│   ├─ server.py               标准库 HTTP 服务 + 路由 + 并发保护 + 错误码
│   ├─ engine.py               模型懒加载（防御式双路径）+ 分段转写拼接 + 结果缓存
│   ├─ audio.py                ffmpeg 定位、统一转 16kHz 单声道 wav、读回波形
│   └─ vad.py                  fsmn-vad 静音分段（拿不到就退回固定 30 秒窗口）
├─ ffmpeg/bin/ffmpeg.exe       安装时下载的便携 ffmpeg（wav/mp3/flac/m4a/ogg/aac 全靠它）
├─ .ffmpeg-ok                  ffmpeg 就位标记（内容 = 便携路径或 PATH；缺 ffmpeg 时不存在）
├─ models/                     模型目录
│   ├─ Qwen__Qwen3-ASR-0.6B/
│   ├─ iic__speech_fsmn_vad_zh-cn-16k-common-pytorch/
│   └─ .ok                     两个模型都就位后由脚本创建
└─ .install-ok                 安装成功标记（上层据此判断装好了）
```

## 手动安装

```powershell
cd <INSTALL_DIR>
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1 -InstallDir .
```

参数：

| 参数 | 说明 |
| --- | --- |
| `-InstallDir` | 安装目录（默认脚本所在目录的上一级） |
| `-Cpu` | 装 **CPU 版** torch（无 NVIDIA 显卡时的显式后门；上层默认会拦无 N 卡安装） |
| `-TorchIndex` | 显式指定 torch 的 `--index-url`（默认按本机驱动自动匹配 cu13x / cu12x） |
| `-ModelDir` | 复用**已有模型目录**（离线安装；用目录联接接进 `models\`，不复制 1.88GB 权重） |
| `-SkipModels` | 跳过模型下载（只修 venv / ffmpeg 时用） |
| `-FfmpegOnly` | **只补装便携 ffmpeg**（venv / 依赖 / torch / 模型 / 冒烟全跳过，几分钟完成；出错时的补充安装入口） |
| `-ForceFfmpeg` | 即使 `ffmpeg\bin\ffmpeg.exe` 已存在也重新下载（配合 `-FfmpegOnly` 用于修坏掉的 ffmpeg） |

脚本顺序（每步打 `[asr-install] progress: NN`）：

1. 探测 Python（`py -3` → `python`，都没有就报明确错误）→ 建 `.venv`
2. pip 装 `requirements.txt`（清华镜像，失败回退阿里云）
3. 装 **CUDA 版 torch**：按 `nvidia-smi` 的驱动主版本选 `cu130` / `cu128` / `cu126`，失败逐档降级；
   `-Cpu` 或全部 CUDA 档位都失败时才装 CPU 版
4. 下便携 ffmpeg 到 `ffmpeg\bin\`（gyan.dev → BtbN GitHub 直连 / `ghfast.top` / `ghproxy.net` / `gh-proxy.com` 镜像；
   显式启用 TLS1.2 + 逐源重试 + zip 头 / 可执行校验；全部失败则回退系统 PATH 里的 ffmpeg）→ 写 `.ffmpeg-ok`；
   **ffmpeg 不到位 = 安装不完整**：不写 `.install-ok`，写 `ok=false` + `reason=ffmpeg_failed` 并退出非 0
5. 用 modelscope 下两个模型到 `models\`（失败回退 `HF_ENDPOINT=https://hf-mirror.com`）
6. 建 `models\.ok` 与 `.install-ok`
7. 用 venv python 跑一次 `MTNODE_ASR_MOCK=1` 冒烟：起服务 → `/health` → `/v1/models` → 一次 mock 转写 → `shutdown`

运行（**由 MTNode 负责启停，不要常驻**）：

```powershell
cd <INSTALL_DIR>
.\.venv\Scripts\python.exe -m app 8772
```

## 端口与接口

默认端口 **8772**（可用 `ASR_PORT` 覆盖），只监听 `127.0.0.1`；启动成功 stdout 打一行 `[asr] ready`。
所有日志都是 `[asr] ...` 行式 stdout 输出，上层把它追加进 `<DATA>\asr\console.log`。

### 环境变量

| 变量 | 说明 |
| --- | --- |
| `ASR_PORT` | 端口（命令行参数优先），默认 8772 |
| `ASR_MODEL_DIR` | 已有模型目录；空 = 自动探测本地缓存，再退回 modelscope / hf-mirror 下载 |
| `ASR_DEVICE` | `cuda` / `cpu`；空 = 自动（有 CUDA 就用 CUDA） |
| `ASR_FFMPEG` | `ffmpeg.exe` 绝对路径；空 = 先找 `<INSTALL_DIR>\ffmpeg\bin\ffmpeg.exe`，再找 PATH |
| `MTNODE_ASR_MOCK` | `1` = 不加载任何模型，按音频文件名回假转写文本（冒烟 / 联调）；响应里带 `"mock": true` |
| `HF_ENDPOINT` | 模型下载回退源，默认 `https://hf-mirror.com` |
| `ASR_VAD_MODEL` / `ASR_VAD_MODEL_DIR` | 覆盖 VAD 模型 id / 目录（一般不用改） |

### `GET /health`

模型**懒加载**，所以没加载也秒回：

```json
{"ok":true,"model":"Qwen/Qwen3-ASR-0.6B","device":"cuda","loaded":false,
 "vad":true,"ffmpeg":"<路径 或 ''>","mock":false,"version":"1.0.0"}
```

### `POST /v1/audio/transcriptions`（OpenAI 兼容）

两种入参：

```bash
# ① multipart/form-data（字段 file，可选 model / language / prompt / response_format）
curl -X POST http://127.0.0.1:8772/v1/audio/transcriptions \
  -F "file=@meeting.m4a" -F "language=auto"

# ② application/json：本机绝对路径 + 热词
curl -X POST http://127.0.0.1:8772/v1/audio/transcriptions \
  -H "Content-Type: application/json" \
  -d '{"audio_path":"D:\\audio\\meeting.m4a","hotwords":["MTNode","编排队列"],"language":"auto","prompt":"","response_format":"json"}'
```

- `hotwords` 与 OpenAI 的 `prompt` 都会作为**热词 / 上下文提示词**喂给模型（内部拼成 `热词：a、b`）。
- 成功 200：

```json
{"text":"...","segments":3,"duration_sec":12.3,"model":"Qwen/Qwen3-ASR-0.6B","language":"zh","cached":false,"mock":false}
```

- `response_format=text` 时直接返回纯文本（`text/plain`）。
- 失败非 200：`{"ok":false,"error":"<短码>","message":"<中文可读原因>"}`

| 短码 | 触发场景 |
| --- | --- |
| `no_ffmpeg` | 没找到 ffmpeg（wav/mp3/flac/m4a/ogg/aac 都解不了） |
| `decode_failed` | ffmpeg 解码失败 / 分段推理异常 |
| `model_load_failed` | torch / transformers 不可用、模型目录不对、权重缺失 |
| `audio_missing` | 文件不存在或没给音频（JSON 缺 `audio_path`、multipart 少 `file`） |
| `busy` | 并发保护：同一时刻只允许一个转写，忙时 **429 + `busy`** |

其它：`GET /v1/models` → `{"object":"list","data":[{"id":"Qwen/Qwen3-ASR-0.6B","object":"model","owned_by":"local"}]}`；
`POST /api/shutdown` → 200 后进程退出。

## 长音频是怎么处理的

1. 先用 ffmpeg 转成 **16kHz 单声道 wav**（临时文件放系统临时目录，用完即删）；
2. fsmn-vad 取静音分段（**拿不到 VAD 就退回固定 30 秒窗口**，单段最长也拦腰切到 30 秒）；
3. 逐段转写（每段起点/终点都记 `[asr] 转写第 i/n 段：...`），按顺序拼接；
4. 拼接结果里**不出现任何分段标记**，段间只用一个空格。

按路径请求且文件没改过会命中进程内缓存（响应 `"cached": true`）；上传字节不参与缓存（每次都是新临时文件）。

## 模型加载的两条路径（为什么这么写）

上游 transformers 对 Qwen3-ASR 的支持一直在动，所以加载是防御式的：

1. 先试 `Qwen3ASRForConditionalGeneration`（用 `getattr` 探测，类不存在就跳过）配 `AutoProcessor`；
2. 再试通用的 `AutoProcessor` + `AutoModelForSpeechSeq2Seq(trust_remote_code=True)`；
3. **实际走通哪条路会写进日志**：`[asr] 模型加载路径：...`。

输入按官方 chat 形式组装（user 消息里音频 + 文本提示），拿不到 chat 模板会自动退回纯文本提示
（日志里会记一句 `chat 模板组装失败，退回纯文本提示`）。任何加载异常都转成
`model_load_failed` + 原始异常摘要，**不会把 traceback 当正常响应吐给上层**。

## 常见错误与修复

| 现象 | 原因 | 修复 |
| --- | --- | --- |
| 启动即退出 / 端口占用 | 8772 被别的进程占了 | `ASR_PORT` 换端口，或杀掉占用进程后重启 |
| `/health` 里 `ffmpeg` 是 `''`，转写报 `no_ffmpeg` | 便携 ffmpeg 没下下来 | 跑 `install.ps1 -InstallDir . -FfmpegOnly`（多源重试），或在插件控制台点「补装 ffmpeg」；也可手动把 `ffmpeg.exe` 放到 `<INSTALL_DIR>\ffmpeg\bin\`，或设 `ASR_FFMPEG` / 加入系统 PATH |
| 转写报 `model_load_failed` | 模型没下全 / torch 装成了 CPU 版但 `ASR_DEVICE=cuda` | 看日志里的加载路径与异常摘要；重跑 `install.ps1`（会续传模型），或 `-ModelDir` 指向已有模型目录 |
| 首次转写很慢 | 模型懒加载（第一次请求才加载权重） | 正常现象；加载期间 `/health` 仍是秒回 |
| 长音频只转出很少文字 | 全是静音 / VAD 判成静音 | 看日志的分段数；VAD 不可用时会自动退回固定窗口（日志有记录） |
| 并发请求返回 429 `busy` | 同一时刻只允许一个转写 | 串行调用即可（上层批处理应逐条） |
| CUDA 装上了但 `device` 还是 `cpu` | 驱动太旧 / `ASR_DEVICE=cpu` | 更新驱动，或用 `-TorchIndex` 指定与驱动匹配的 CUDA 档位重装 torch |
| `nvidia-smi` 读不到（无 N 卡机器） | 本机没有 NVIDIA 显卡 | 上层应报 `no_cuda` 拦下安装；确实要 CPU 跑就用 `-Cpu` |

## 磁盘与显存

- 模型约 **1.88GB**（BF16 safetensors）+ 依赖与 torch 约 3–5GB，建议预留 **≥8GB**。
- 0.6B 模型显存占用很小（4GB 显存卡即可），显存不足时它会因为 `ASR_DEVICE` 自动落到 CPU 上跑（只是慢）。
