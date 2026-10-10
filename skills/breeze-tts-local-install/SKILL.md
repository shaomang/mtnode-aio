---
name: breeze-tts-local-install
title: Breeze TTS 2 本地 TTS 安装
description: 在用户指定目录安装 Breeze TTS 2（breezeblue-ai/breeze-tts）本地 TTS 后端：创建 venv、按国内镜像装依赖（torch 走阿里云 pytorch-wheels）、克隆推理引擎、从 ModelScope/hf-mirror 下载权重、准备便携 ffmpeg，建立 OpenAI 兼容管理服务契约（音色库 voices/ + 音色克隆/设计/导演 + API Key 鉴权）并冒烟验证。含自我修复指引。
---

# Breeze TTS 2 本地 TTS 插件 — 安装 / 修复

当用户或 MTNode 插件要求在某目录安装 / **自我修复** **Breeze TTS 2 本地 TTS 后端** 时使用本 skill。

插件调用时：

- **当前工作区就是 `INSTALL_DIR`**，可直接读写并执行命令
- **`SCAFFOLD_REF`（或 `.scaffold-ref`）仅作参考**：内置脚手架/脚本是示例实现，不是已完成的安装。请按下方目标自行准备目录；可按需从参考路径复制或改写，也可等价实现
- 不要假设插件已替你复制好脚手架
- 若任务附带 **CONSOLE_LOG**（插件 console 最近日志），优先根据日志定位并修复，不要盲目重下已就绪的权重

## ⚠️ 许可（务必向用户说清，不要忽略）

- **推理代码**（breeze-tts 仓库）是 **Apache-2.0**。
- **模型权重、衍生模型与自托管输出**受 **BreezeBlue Research and Non-Commercial License** 约束，**仅限研究与「非商用」用途**；Apache-2.0 **不授予**权重的商用权。付费订阅只覆盖 breezeblue.ai 托管平台的输出，**不覆盖本机自托管结果**。
- 提醒用户自行确认对参考音频、声音与生成内容拥有合法权利，**禁止未授权的语音克隆与冒用**。

## 目标

在 `INSTALL_DIR` 建立可运行的 Breeze TTS 2 管理服务（FastAPI 管理 + 官方 `breeze_infer.api` 推理引擎），供 MTNode 插件启停。

完成后应满足：

- `INSTALL_DIR\.venv\Scripts\python.exe` 存在，且 `import torch, soundfile, fastapi, uvicorn` 成功
- `INSTALL_DIR\engine\infer.py` 存在（**breezeblue-ai/breeze-tts 官方仓库**克隆/解包）
- `INSTALL_DIR\checkpoints\breeze-tts-2\` 下有 `config.json` 与至少一个权重文件（`*.safetensors` / `*.pt` / `*.bin`）；
  若用户已有权重目录，写 `INSTALL_DIR\checkpoints\breeze-tts-2\USE_LOCAL_WEIGHTS.txt`（内容 = 该绝对路径），服务会改用它
- `INSTALL_DIR\voices\` 目录存在（参考片段音色库）
- `INSTALL_DIR\tools\ffmpeg\ffmpeg.exe` 存在（**mp3 输出用**；确实下载不到时可缺，但要在结论里说明「mp3 不可用，请用 wav / flac」）
- `INSTALL_DIR\scripts\install.ps1` 与 `scripts\download_weights.py` 存在（脚手架参考；已复制则可直接用）
- `INSTALL_DIR\.install-ok` 存在（**安装完成的唯一判据文件**，插件认它 + 上面几项要件）
- `INSTALL_DIR\api-key.txt` 由管理服务首次启动生成（**不要手工建**）
- **不要**启动 `python -m app`，也不要启动 `breeze_infer.api` 推理进程（启停由插件负责）
- `INSTALL_DIR\.breeze-agent-result`（仅插件交办的 Agent 安装/修复任务）：首行 `ok=true`；失败写 `ok=false` + `reason=...`

## 目录约定

- `INSTALL_DIR/app/` — Python 管理服务（`python -m app <port>`；`server.py` 全部 HTTP 接口 / `engine.py` 推理引擎进程编排 / `audio.py` PCM→wav/flac/mp3 / `voices.py` 音色库 / `config.py` 路径与配置 / `console_banner.py` 启动横幅）
- `INSTALL_DIR/.venv/` — 虚拟环境（Python **3.10+**）
- `INSTALL_DIR/engine/` — breeze-tts 官方推理源码（`infer.py` + `breeze_infer/` + `models/` + `requirements.txt`）
- `INSTALL_DIR/checkpoints/breeze-tts-2/` — Breeze TTS 2 权重（`config.json` + safetensors/pt/bin）
- `INSTALL_DIR/voices/<音色id>/` — 音色库：`ref.wav`（或 ref.flac / ref.mp3）+ `ref.txt`（**与该音频逐字一致的文稿**）
- `INSTALL_DIR/tools/ffmpeg/ffmpeg.exe` — 便携 ffmpeg（mp3 转码）
- `INSTALL_DIR/logs/manager.log` — 管理服务与引擎日志
- `INSTALL_DIR/out/` — 控制台试听产物
- `INSTALL_DIR/manager.json` — 服务配置（`apiPort` / `enginePort` / `fastAll`）
- `INSTALL_DIR/api-key.txt` — API Key（服务首次启动生成）
- `SCAFFOLD_REF` — 内置脚手架参考路径（`app/`、`scripts/`、`manifest.json`、`start_backend.cmd`）

## 端口

- 管理服务 **8772**（`BREEZE_API_PORT` 可覆盖；只监听 127.0.0.1）
- 推理引擎 **8773**（官方 `breeze_infer.api`，由管理服务按需拉起；首次加载约 7.7GB 显存）

## 国内镜像（必须）

> **中国大陆网络下，以下镜像必须使用**：HuggingFace 无法直连，Python 库必须走清华/中科院镜像。

- pip：**清华** `https://pypi.tuna.tsinghua.edu.cn/simple`（或**中科院 USTC** `https://mirrors.ustc.edu.cn/pypi/simple/`）
- **torch / torchaudio**：阿里云 PyTorch 轮子镜像 `https://mirrors.aliyun.com/pytorch-wheels/cu128`（失败回退 `.../cu126`，再回退官方 `https://download.pytorch.org/whl/cu128`）；版本按 `engine/requirements.txt` 的钉版（当前 **torch==2.9.1 / torchaudio==2.9.1**）
- 权重：**优先 ModelScope(魔搭)** `BreezeBlue/breeze-tts-2`（可用环境变量 `BREEZE_WEIGHTS_REPO` 覆盖）→ 失败回退 `HF_ENDPOINT=https://hf-mirror.com`（设 `HF_HUB_DISABLE_XET=1`）→ 最后官方 `huggingface.co`
- GitHub（引擎源码）：直连失败用 `ghproxy.com` 前缀镜像，或改下 `archive/refs/heads/main.zip`
- ffmpeg：`https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip`（失败回退 `https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip`）

## 脚本语言与编码（必须：零中文 + 钉死 UTF-8）

> 宿主用 `powershell.exe`（Windows PowerShell 5.1）跑 `scripts\*.ps1`。而 **UTF-8 无 BOM 的 `.ps1` 在中文 Windows 上会被按 GBK(cp936) 解码** —— 中文变成乱码字节，还会吞掉紧跟的 `}` / `'` / `"`，脚本**直接语法崩**（本轮改前实测：breeze 10 处、sensenova 113 处、yue 42 处、tts 15 处、llama 3 处、h3 download_models 6 处 + repair_torch_kitchen 1 处语法错），控制台同时一片乱码。

- `scripts\*.ps1` / `scripts\*.cmd` 与安装期辅助 `*.py`（`download_weights.py` 等）**一律纯 ASCII 英文**：注释、消息、异常文本全英文；不许有中文、全角标点、`——`、制表线 `─`、emoji。
- `.ps1` 开头（param 块之后）必须钉死编码三行，`.cmd` 在 `setlocal` 后加两行：

  ```powershell
  try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
  $OutputEncoding = New-Object System.Text.UTF8Encoding($false)
  $env:PYTHONIOENCODING = 'utf-8'
  ```

  ```bat
  chcp 65001 >nul
  set "PYTHONIOENCODING=utf-8"
  ```

  这样脚本自身与 pip / git / python 的输出都按 UTF-8 出去，宿主（用 UTF-8 解码 stdout，并按 `[breeze-install] progress:` 抓进度）看到的就是正常文本。
- 改脚本后跑 `node test/smoke-install-scripts.js`：钉住「零非 ASCII + GBK 解码后 PowerShell 解析零错 + 进度前缀 / `reason=` 等 ASCII 契约仍在」。
- Python **后端**（`app/*.py` 的启动横幅与日志）本轮不做零中文，仍是中文，靠上面的 UTF-8 钉死正确显示。

## 安装步骤（按序）

1. **前置检查**：Python ≥ 3.10（`python -c "import sys;print(sys.version_info[:2])"`）；NVIDIA 驱动可见（`nvidia-smi`）。
   显存要求：eager 约 **7.7GB**，官方建议 12GB 卡起步。**没有 CUDA 设备就直接停下并如实告知用户**（本项目在 Windows 原生跑，只走默认 eager 路径，不启用 CUDA Graph fast 路径）。
2. **建 venv**：`python -m venv .venv`，然后 `python -m pip install --upgrade pip -i <清华镜像>`。
3. **取引擎源码**：`git clone --depth 1 https://github.com/breezeblue-ai/breeze-tts engine`（失败依次回退 ghproxy / zip 解包）。校验 `engine/infer.py` 存在。
4. **装依赖**：按 `engine/requirements.txt`（可去掉 `pytest` / `ruff`）：
   - 先装 torch/torchaudio（上表镜像与版本）
   - 再 `pip install -r <过滤后的 requirements> -i <清华镜像>`
5. **下权重**：`python scripts/download_weights.py --repo BreezeBlue/breeze-tts-2 --dest checkpoints/breeze-tts-2`
   （或直接 `from modelscope.hub.snapshot_download import snapshot_download; snapshot_download("BreezeBlue/breeze-tts-2", local_dir=...)`；
   失败回退 `HF_ENDPOINT=https://hf-mirror.com` 的 `huggingface_hub.snapshot_download`）。
   若用户已给权重目录：写 `checkpoints/breeze-tts-2/USE_LOCAL_WEIGHTS.txt`（内容 = 该目录绝对路径），跳过下载。
6. **便携 ffmpeg**：下载 essentials 包，把里面的 `ffmpeg.exe` 放到 `tools/ffmpeg/ffmpeg.exe`。
7. **建目录**：`voices/`、`logs/`、`out/`、`checkpoints/breeze-tts-2/`。
8. **冒烟**（不要起服务）：
   ```powershell
   .venv\Scripts\python.exe -c "import torch,soundfile,fastapi,uvicorn;print(torch.__version__, torch.cuda.is_available())"
   .venv\Scripts\python.exe -c "import sys;sys.path.insert(0,'engine');import breeze_infer.api;print('engine import ok')"
   ```
   务必看到 `torch.cuda.is_available()` 为 `True`；`breeze_infer.api` 能 import 成功。
9. **落标记**：写 `.install-ok`（内容 = ISO 时间即可）。**不要**起服务。

## 服务契约（装好后由插件启停，供你自检用）

- `GET /health`、`GET /api/health` → `{"ok":true}`（**免鉴权**）
- `GET /api/status` → 安装 / 引擎 / GPU / 音色 / 许可汇总（带 `Authorization: Bearer <api-key.txt 内容>` 时含 `apiKey`）
- `POST /api/engine/start` / `POST /api/engine/stop` → 拉起 / 停掉 `breeze_infer.api`（探活 `/health`，加载期回 503 loading）
- `GET /api/voices`、`POST /api/voices/add`（multipart: `voiceId` + `ref_text` + `ref_audio`）、`POST /api/voices/delete`、`POST /api/voices/rename`
- `POST /v1/audio/speech` → OpenAI 兼容（JSON 或 multipart）：`input`/`text`、`voice`、`ref_audio`/`ref_audio_path`、`ref_text`、`instruction`、`cfg_scale`、`seed`、`response_format`(wav/flac/mp3)、`filename`/`save`
- `POST /api/preview` → 控制台试听（回 wav base64）
- `POST /api/shutdown` → 停引擎并退出服务（插件「停止」走它）
- 错误统一 `{"detail":{"code":…,"message":…}}`，带 `Authorization: Bearer <key>` 之外的请求回 401 `unauthorized`

## 【自我修复】模式

被插件的「🤖 自动修复」拉起（任务里带 `selfRepair` / CONSOLE 日志）时：

1. **先读日志**：`INSTALL_DIR/logs/manager.log`（管理服务 + 引擎输出都在这）与插件 console 尾部。**按真因修**，不要套用不匹配的旧剧本。
2. **不要重下已就绪的东西**：`checkpoints/breeze-tts-2/` 有 `config.json` + 权重文件就跳过下载；`engine/infer.py` 在就不要重克隆。
3. 修完**必须**重跑第 8 步冒烟（`torch.cuda.is_available()` + `import breeze_infer.api`）。
4. 成功后写 `.install-ok`，并在插件交办的任务里写 `.breeze-agent-result`（首行 `ok=true`）。
5. 修不了就写 `ok=false` + `reason=<一句可读原因>`，并在结论里说清「试过什么、卡在哪、需要用户做什么」。

### 已知故障 → 处置

| 现象（日志 / 错误码） | 真因 | 处置 |
| --- | --- | --- |
| `no_weights` / `weights 不完整` | 权重没下完或目录不对 | 重跑第 5 步；或写 `USE_LOCAL_WEIGHTS.txt` 指向已有目录 |
| `torch_missing` | 依赖没装进 venv（可能装到系统 Python 了） | 用 `INSTALL_DIR\.venv\Scripts\python.exe -m pip ...` 重装，别用裸 `pip` |
| `cuda_unavailable` | 装成了 CPU 版 torch | 卸载后按上表 CUDA 镜像重装 `torch==2.9.1`，确认 `torch.version.cuda` 非空 |
| `engine_exited` / `engine_start_timeout` | 引擎起不来（见 `logs/manager.log` 的 `[engine:err]`） | 常见：`config.json` 缺 / 权重被截断 / 显存被别的任务占满；按日志真因处理，必要时 `POST /api/engine/stop` 后重启 |
| `missing_ffmpeg` | `tools/ffmpeg/ffmpeg.exe` 缺失 | 重跑第 6 步；下不到就明确告诉用户「mp3 不可用，请用 wav / flac」 |
| `port 8772/8773 已被占用` | 上次的服务/引擎没退干净 | `netstat -ano | findstr :8772` 找 PID → `taskkill /PID <pid> /T /F`，再让插件「停止 → 开始」 |
| `import breeze_infer.api` 失败 | 引擎源码不完整 / `PYTHONPATH` 没指到 `engine/` | 重新克隆引擎；确认以 `cwd=engine` 或 `PYTHONPATH=engine` 运行 |
| 合成一直 `busy_engine`（409） | 引擎是单并发的，有请求卡住 | 停引擎再起（`/api/engine/stop` → `/api/engine/start`），检查是否有别的调用方在占 |

## 失败要留裁决（宿主靠它决定「谁修」）

宿主不读日志做判断，它只看 `INSTALL_DIR\.breeze-agent-result`：

- **冒烟没过**（依赖没装全 / `torch` 起不来）→ 写 `ok=false` + `reason=smoke_failed`，并且**不写** `.install-ok`。
  宿主据此把你（Agent）拉起来继续修。
- **没有可用 CUDA**（CPU 版 torch / 无 N 卡）→ 写 `ok=false` + `reason=no_cuda`，同样不写 `.install-ok`。
  这一类宿主只给用户指路、**不**拉起修复会话（Agent 也变不出显卡）。
- 其它情况用 `reason=<短码>`，尽量贴报错总线的已知错误码（`no_weights` / `cuda_unavailable` /
  `missing_ffmpeg` / `engine_exited` / `port 占用` …），宿主才能给出对的指路文案。

`scripts/install.ps1` 本身就是这个口径：冒烟闸门 → 写裁决 → `exit 1`（非 0 退出才会触发宿主保底链）。
`BREEZE_SKIP_CUDA_CHECK=1` 只是给无卡机器做静态排查的逃生阀，正常安装不要用。

宿主侧同口径（调试时先看这两处）：

- 安装 / 启用的**前置阶段**出错（脚手架解析、代码指纹、技能同步…）会写 console 的 `[host-error] stage=…`
  行，并以 `host_error` 上报报错总线 → 主窗弹报告窗 → 一键 AI 修复。这类错误绝不该表现为「点了没反应」。
- 控制台「安装」那一行的**自我修复**按钮 = 把 console 尾部交给 Agent（`breeze:agentRecoverInstall`）。
## 收尾（必须）

- 落 `.install-ok`；插件交办的任务另写 `.breeze-agent-result`（首行 `ok=true` / 失败 `ok=false` + `reason=`）。
- 结论里给出：安装目录、引擎源码路径、权重目录（或 `USE_LOCAL_WEIGHTS` 指向的目录）、ffmpeg 是否就绪、venv Python 版本、`torch.cuda.is_available()` 结果、以及**未解决 / 需用户确认**的点。
- 别忘了把**许可**（权重仅限研究与非商用）写进结论。
