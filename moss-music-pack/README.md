# MOSS-Music 本地后端（随包脚手架）

本目录是 `moss-music` 应用插件（kind `mossmusic`，画布节点 `moss_music`）的**安装脚手架**。
MTNode 把它整份复制到用户选定的安装目录，再跑 `scripts\install.ps1` 逐步骤安装；
venv、权重、源码、ffmpeg 全部落在**用户安装目录**，不写应用目录。

上游：[OpenMOSS/MOSS-Music](https://github.com/OpenMOSS/MOSS-Music)（Apache-2.0）。
本地版只提供 **int8 / int4** 两档（bitsandbytes 装载时量化，全精度档已移除），沿用官方
processor / 模型类与 generate 参数，**不接 SGLang、不套官方 Gradio UI**。

## 安装后会有什么

```
<安装目录>\
  .venv\                          Python 3.12（uv 取）+ CUDA torch 2.9.1+cu128 + 依赖
  source\MOSS-Music\              官方推理源码（zip 下载，不用 git）
  models\MOSS-Music-8B-Instruct\  约 18GB
  tools\ffmpeg\ffmpeg.exe         便携 ffmpeg（解码 / 长音频切片）
  tools\uv\uv.exe                 uv（本机没有时自动取）
  outputs\                        手工起服务时的默认产物目录
  .env                            运行时默认值（端口 / 默认模型 / 量化 / 路径）
  .install-ok                     安装成功标记（宿主据此判「已安装」）
  app\server.py                   本服务（安装时随脚手架复制）
```

磁盘建议 ≥60GB。模型是 8B（权重约 18GB，装载成 int8 / int4 由 bitsandbytes 现场量化），CUDA torch 与依赖约 12GB。

## 安装

安装窗（插件卡片 →「安装」）走的就是这条命令：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install.ps1 -InstallDir "D:\mtnode\moss-music"
```

可重复执行：已下载的 uv / Python / 源码 / 权重分片都会复用。参数：

| 参数 | 作用 |
| --- | --- |
| `-InstallDir` | 安装目录（默认本目录） |
| `-DiskHintGb` | 磁盘门槛，默认 60 |
| `-ForceSource` | 强制重下官方源码 zip |
| `-SkipWeights` | 跳过权重下载（只搭环境 / 排障用） |

步骤 id（与 `steps.json` 同源）：
`disk → python → torch → deps → source → weights → files → ffmpeg → env → smoke`。

- Python 3.12 由 **uv** 取（`UV_PYTHON_INSTALL_MIRROR` 默认指向 npmmirror 的 python-build-standalone）。
- torch / torchaudio 固定 `2.9.1+cu128`，镜像顺序 SJTU → 阿里云 pytorch-wheels → 官方。
- 依赖：`transformers==4.57.1`、`accelerate`、`torchcodec==0.9.*`、`soundfile`、`modelscope`、
  `huggingface_hub`、`bitsandbytes`（int8 / int4 档）等；pip 顺序 清华 → 阿里云 → USTC → 官方。
- 源码：`codeload.github.com` 的 main 分支 zip；失败回退 `gh-proxy.com` / `ghfast.top` / `ghproxy.net`。
- 权重：ModelScope（`openmoss/MOSS-Music-8B-*`）优先，失败回退 hf-mirror（`HF_ENDPOINT`）。
- 任一失败都会在安装窗停在对应步骤并给中文原因：错误码与文案在 `steps.json` 的 `messages` 表，
  修复口径在技能 `skills/moss-music-install/SKILL.md`。

## 起服务

```cmd
start_backend.cmd
start_backend.cmd --port 8791
start_backend.cmd --check
```

MTNode 正常运行时由插件宿主拉起（detached 单例，**不随 MTNode 退出**），端口默认 `8790`。
`--check` 只校验源码 / 权重清单 / torch+CUDA / ffmpeg，不加载 18GB 权重。

## HTTP 契约（127.0.0.1）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 探活：`ready / loading / generating / cancelRequested / model / quant / models{...} / error / pid`，绝不加载权重 |
| POST | `/load` | `{model:"instruct", quant:"int8"\|"int4"}`，装载（30~90s）；旧调用方传 `bf16` 归一化成 `int8`、传 `thinking` 归一化成 `instruct`，都在回包里带 `migrated` |
| POST | `/unload` | 释放模型与显存（推理在跑时先请求取消，2.5s 内没退就回 `busy_generating`） |
| POST | `/cancel` | 取消在途 `/generate`：每个分块边界检查，退出后由调用方 `/unload` |
| POST | `/generate` | `{audioPath, question, outputDir?, maxNewTokens?, temperature?, topP?, topK?, longAudio?, stem?}`；被取消时回 `{ok:false,error:"cancelled"}` |

`/generate` 返回：

```json
{
  "ok": true,
  "text": "整段答案",
  "files": {"md": "…md", "json": "…json", "srt": "…srt"},
  "cues": [{"start": 0.0, "end": 4.2, "text": "…"}],
  "chunks": [{"index": 0, "start": 0, "end": 180, "chars": 900, "timestamped": true}],
  "durationSeconds": 402.5,
  "longAudio": true,
  "estimatedTimestamps": false,
  "elapsedSeconds": 84.2,
  "model": "instruct",
  "quant": "int8"
}
```

### 长音频

- 时长 > **300s** 且 `longAudio` 为真：按 **180s 一段、相邻段重叠 5s** 切片（ffmpeg 转 16k 单声道），
  逐段提问（附加「本段为原曲第 X–Y 秒」），再按段起点把时间戳平移回原曲时间轴，重叠区里的重复行去重。
- 模型没给时间戳时：不伪造逐句对齐，按字符数把已知时长摊到句子上，并在 JSON 里
  `estimatedTimestamps: true`（控制台与 md 会注明「估算」）；`.srt` 仍会写，便于直接当草稿用。

### 产物

写进 `outputDir`（缺省 `<安装目录>\outputs`）：

- `<stem>.md`：元信息 + 提问 + 答案 + 时间轴；
- `<stem>.json`：完整结构化结果（模型 / 量化 / 时长 / 分段 / cues / 文件路径）；
- `<stem>.srt`：时间戳字幕（估算时同样注明）。

## 环境变量

`app\server.py` 启动时读 `<安装目录>\.env`（不覆盖已存在的环境变量）：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `MOSS_MUSIC_PORT` | `8790` | 监听端口（`--port` 优先） |
| `MOSS_MUSIC_MODEL` | `instruct` | 仅 `--preload` 用 |
| `MOSS_MUSIC_QUANT` | `int8` | 仅 `--preload` 用；`bf16` 已下线，会被归一化成 `int8` |
| `MOSS_MUSIC_SOURCE` | `<安装目录>\source\MOSS-Music` | 官方源码目录 |
| `MOSS_MUSIC_MODELS` | `<安装目录>\models` | 权重根目录 |
| `MOSS_MUSIC_FFMPEG` | `<安装目录>\tools\ffmpeg\ffmpeg.exe` | ffmpeg |
| `HF_ENDPOINT` | `https://hf-mirror.com` | 权重回退源 |

## 常见故障

| 现象 | 原因 / 处理 |
| --- | --- |
| 安装停在 `python` | uv / Python 3.12 取不下来：网络到不了 GitHub 或 npmmirror；重跑即可（已下载会复用） |
| 安装停在 `torch`，`cuda False` | 装成了 CPU 版或驱动太旧（cu128 需驱动 ≥525，建议 550+）；升级驱动后重跑该步 |
| 安装停在 `weights`，某个模型 incomplete | ModelScope 与 hf-mirror 都失败；网络恢复后重跑（分片续传），或手工把仓库文件放进 `models\` |
| `/generate` 报 `model_not_loaded` | 先 `POST /load`（宿主首次生成会自动装载） |
| `/generate` 报 `busy` | 单任务互斥：同一时刻只跑一首；等上一首结束 |
| `/generate` 报 `Could not load libtorchcodec` | `torchaudio` 2.9 把解码交给 `torchcodec`，而随包 ffmpeg 是静态构建（没有 `avcodec-*.dll`）。`app\server.py` 探测到 torchcodec 不可用会自动改用「ffmpeg 转 wav + soundfile」解码，正常装完不会再报；旧安装目录把包里新的 `app\server.py` 覆盖过去、重启后端即可 |
| 控制台「切量化档」很久 | 切档 = 卸载 + 重新装载 18GB 权重，30~90s 属正常 |
| 显存不够 | 控制台把量化档降到 `int4`，再 `/load` |

修复口径的唯一真源是 `skills/moss-music-install/SKILL.md` 的【自我修复】段，本文件只列现象。
