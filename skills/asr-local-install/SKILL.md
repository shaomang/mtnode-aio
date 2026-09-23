---
name: asr-local-install
title: Qwen3-ASR 本地语音识别安装
description: 在用户指定目录安装 Qwen3-ASR 本地语音识别后端：创建 venv、只装 CUDA 版 torch（无 N 卡则拒绝或 -Cpu 后门）、下载便携 ffmpeg、用 ModelScope 下载 Qwen/Qwen3-ASR-0.6B 与 fsmn-vad 模型、建立 OpenAI 兼容转写服务契约（/health、/v1/audio/transcriptions、/api/shutdown）并做 mock 冒烟验证。含自我修复指引。
---

# Qwen3-ASR 本地语音识别插件 — 安装 / 修复

当用户或 MTNode 插件要求在某目录安装 / **自我修复** **Qwen3-ASR 本地语音识别后端** 时使用本 skill。

插件调用时：

- **当前工作区就是 `INSTALL_DIR`**，可直接读写并执行命令
- **`SCAFFOLD_REF`（或 `.scaffold-ref`）仅作参考**：内置脚手架/脚本是示例实现，不是已完成的安装。请按下方目标自行准备目录；可按需从参考路径复制或改写，也可等价实现
- 不要假设插件已替你复制好脚手架
- 若任务附带 **CONSOLE_LOG**（插件 console 最近日志），优先根据日志定位并修复，不要盲目重装模型

## 目标

在 `INSTALL_DIR` 建立可运行的 Qwen3-ASR 语音识别服务（Python venv + transformers 直接加载模型，
HTTP 服务**只用 Python 标准库**，不引入 FastAPI / uvicorn），供 MTNode 插件启停。

完成后应满足：

- `INSTALL_DIR\.venv\Scripts\python.exe` 存在，且 `.venv\Scripts\python.exe -c "from app import server"` 成功
- `INSTALL_DIR\ffmpeg\bin\ffmpeg.exe` 存在（wav / mp3 / flac / m4a / ogg / aac 解码全靠它）
- `INSTALL_DIR\models\Qwen__Qwen3-ASR-0.6B\`（含 `config.json` 与权重）
- `INSTALL_DIR\models\iic__speech_fsmn_vad_zh-cn-16k-common-pytorch\`（含 `configuration.json`）
- `INSTALL_DIR\models\.ok` 与 `INSTALL_DIR\.install-ok` 存在
- **不要**启动 `python -m app`（启停由插件负责）

## 输入参数

| 参数 | 含义 |
| --- | --- |
| `INSTALL_DIR` | 安装目录（当前工作区）。脚手架 `app/`、`scripts/`、`requirements.txt`、`manifest.json` 放这里 |
| `SCAFFOLD_REF` | 内置脚手架参考路径（`asr-pack/`）。可复制 app/scripts/requirements/manifest，也可等价实现 |
| `CONSOLE_LOG` | 插件 console 最近日志（修复模式下优先据此定位根因） |

脚本参数（`scripts\install.ps1`）：`-InstallDir`、`-Cpu`、`-TorchIndex`、`-ModelDir`、`-SkipModels`、
`-FfmpegOnly`（只补装便携 ffmpeg）、`-ForceFfmpeg`（已存在也重下）。

## 固定型号（不要改、不要做模型切换）

- ASR：**`Qwen/Qwen3-ASR-0.6B`**（Pytorch / BF16 / safetensors 约 1.88GB / apache-2.0 /
  架构 `Qwen3ASRForConditionalGeneration`）
- VAD：**`iic/speech_fsmn_vad_zh-cn-16k-common-pytorch`**（fsmn-vad，长音频静音分段）

## 目录约定

- `INSTALL_DIR/app/` — 标准库 HTTP 服务（`python -m app <port>`；server.py / engine.py / audio.py / vad.py / __main__.py）
- `INSTALL_DIR/.venv/` — 虚拟环境
- `INSTALL_DIR/models/` — 模型（如上两个子目录 + `.ok` 标记）
- `INSTALL_DIR/ffmpeg/bin/` — 便携 ffmpeg（`ffmpeg.exe` + `ffprobe.exe`）
- `INSTALL_DIR/.ffmpeg-ok` — ffmpeg 就位标记（内容 = 实际 ffmpeg 路径，或 `PATH` 表示走系统 PATH；缺 ffmpeg 时**不存在**）
- `INSTALL_DIR/.install-ok` — 安装成功标记
- `INSTALL_DIR/requirements.txt` — 依赖（numpy / soundfile / transformers / modelscope / funasr；**torch 不写在这里**）
- `INSTALL_DIR/scripts/install.ps1` — 安装脚本（幂等，可重复执行）
- `SCAFFOLD_REF` — 内置脚手架参考路径

## 国内镜像与下载回退顺序（必须）

> **中国大陆网络下必须走镜像**：HuggingFace 无法直连。

1. **pip**：清华 `https://pypi.tuna.tsinghua.edu.cn/simple`（`--trusted-host pypi.tuna.tsinghua.edu.cn`）
   → 失败回退**阿里云** `https://mirrors.aliyun.com/pypi/simple/`
2. **torch**：**只装 CUDA 版**（无 N 卡机器不装，上层会拦）。
   按 `nvidia-smi --query-gpu=driver_version` 的**驱动主版本**自动匹配：
   驱动 ≥580 → `https://download.pytorch.org/whl/cu130` → 失败降 `cu128` → 再降 `cu126`；
   驱动 ≥550 → `cu128` → `cu126`；驱动未知/较低 → `cu128` → `cu126`；
   可用 `-TorchIndex` 显式指定。`-Cpu` 时才用 `https://download.pytorch.org/whl/cpu`。
   **不要把 torch 放进 requirements.txt**（清华镜像上只有 CPU 轮子，会静默装成 CPU 版）
3. **模型**：ModelScope（`modelscope.snapshot_download`）优先 → 失败回退
   `HF_ENDPOINT=https://hf-mirror.com` + `HF_HUB_DISABLE_XET=1`（`huggingface_hub.snapshot_download`）
4. **ffmpeg**：`https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip`
   → BtbN `ffmpeg-master-latest-win64-gpl.zip`（github 直连）→ 镜像前缀 `ghfast.top` / `ghproxy.net` / `gh-proxy.com`
   （解压后把 `ffmpeg.exe` / `ffprobe.exe` 拍平到 `INSTALL_DIR\ffmpeg\bin\`）。
   **Windows PowerShell 5.1 必须先启用 TLS1.2**（`[Net.ServicePointManager]::SecurityProtocol`），
   否则 `Invoke-WebRequest` 下 HTTPS 直接失败——这正是「pip 装得上、ffmpeg 下不动」的常见根因；
   下载后要校验（大小 >1MB、zip 头 `PK`、解压出的 ffmpeg.exe 能执行），全失败还要看系统 PATH 里有没有 ffmpeg。
   只补 ffmpeg：`powershell -File scripts\install.ps1 -InstallDir INSTALL_DIR -FfmpegOnly`（几分钟内完成，不动 venv / 模型）。
   **ffmpeg 不到位 = 安装不完整**：脚本不写 `.install-ok`，写 `ok=false` + `reason=ffmpeg_failed` 并退出非 0。
5. **离线安装**：用户已有模型目录时用 `-ModelDir <目录>`（脚本建**目录联接**接进 `models\`，不复制 1.88GB 权重）；
   也可给服务设 `ASR_MODEL_DIR=<目录>`。服务自身也会自动探测 ModelScope / HuggingFace 缓存目录。

## 安装步骤（按序）

1. **准备工程文件**
   若缺 `app/server.py` / `app/engine.py` / `app/audio.py` / `app/vad.py` / `app/__main__.py` /
   `scripts/install.ps1` / `requirements.txt` / `manifest.json`：从 `SCAFFOLD_REF` 复制或按参考自行生成。
   保留用户已有的 `.venv` / `models` / `ffmpeg`。

2. **探测 Python 3.10+**：依次试 `py -3.12` / `-3.11` / `-3.10` / `-3.13` / `-3`，再 `python`；
   都没有就**报明确错误并中止**（提示用户先装 Python 3.10+）。

3. **跑安装脚本**（可参考 `SCAFFOLD_REF\scripts\install.ps1`）
   ```powershell
   cd INSTALL_DIR
   powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1 -InstallDir INSTALL_DIR
   ```
   脚本会：建 `.venv` → 清华镜像装 `requirements.txt`（失败回退阿里云）→ 按驱动装 CUDA 版 torch（失败逐档降级）
   → 下载便携 ffmpeg → 用 modelscope 下两个模型（失败回退 hf-mirror）→ 建 `models\.ok`
   → 跑一次 `MTNODE_ASR_MOCK=1` 的 mock 冒烟（起服务 → `/health` → `/v1/models` → 一次 mock 转写 → `shutdown`）
   → 建 `.install-ok`。全程打印 `[asr-install] progress: NN`（0-100），便于上层解析。

4. **冒烟测试**（脚本已自动做一遍，手工复核可用同样三条）
   ```powershell
   .\.venv\Scripts\python.exe -c "from app import server; print('ok')"
   Test-Path .\ffmpeg\bin\ffmpeg.exe
   Test-Path .\models\Qwen__Qwen3-ASR-0.6B\config.json
   Test-Path .\models\iic__speech_fsmn_vad_zh-cn-16k-common-pytorch\configuration.json
   ```
   服务层冒烟（**必须带 `MTNODE_ASR_MOCK=1`**，否则会真去加载 1.88GB 模型）：
   起 `.venv\Scripts\python.exe -m app 8772`（cwd = `INSTALL_DIR`），请求 `GET /health` 与一次
   `POST /v1/audio/transcriptions`（JSON `{"audio_path": ...}` 或 multipart `file`），
   看到响应里 `"mock": true` 即通过，然后 `POST /api/shutdown` 关掉。

5. **标记完成**
   - 创建空文件 `INSTALL_DIR\.install-ok`
   - 写入 `INSTALL_DIR\.asr-agent-result`：首行 `ok=true`；失败时写 `ok=false` 且紧跟一行 `reason=<短码>`
   - **不要**启动 `python -m app`（启停由插件负责）

## 服务契约（插件 `asr/main-asr.js` 依赖，实现 app/ 时勿缺）

以 `SCAFFOLD_REF` 的 `app/` 为权威实现；字段名不要改。

- **启动**：`<INSTALL_DIR>\.venv\Scripts\python.exe -m app <port>`，cwd = `INSTALL_DIR`，默认端口 **8772**，
  **只监听 `127.0.0.1`**；启动成功 stdout 打一行 **`[asr] ready`**（上层不解析，但便于日志排查）；
  不使用任何弹窗 / 浏览器。
- **环境变量**：`ASR_PORT`、`ASR_MODEL_DIR`、`ASR_DEVICE`（`cuda`/`cpu`/空=自动）、`ASR_FFMPEG`、
  `MTNODE_ASR_MOCK=1`（**必须支持**：不加载任何模型，按音频文件名回假转写文本，响应带 `"mock": true`）、`HF_ENDPOINT`。
- **`GET /health`** → 200 JSON：
  `{"ok":true,"model":"Qwen/Qwen3-ASR-0.6B","device":"cuda"|"cpu","loaded":false|true,"vad":true|false,"ffmpeg":"<path 或 ''>","mock":false,"version":"1.0.0"}`；
  模型**懒加载**，未加载时也必须秒回（`/health` 绝不能触发加载）。
- **`POST /v1/audio/transcriptions`**（OpenAI 兼容），两种入参都要支持：
  ① `multipart/form-data`（字段 `file` 上传音频字节，可选 `model`/`language`/`prompt`/`response_format`）；
  ② `application/json`：`{"audio_path":"本机绝对路径","hotwords":["词1","词2"],"language":"auto","prompt":"","response_format":"json"}`。
  `hotwords` 与 OpenAI 的 `prompt` 都作为**热词/上下文提示词**喂给模型（拼成 `热词：a、b`）。
  成功 200：`{"text":"...","segments":3,"duration_sec":12.3,"model":"Qwen/Qwen3-ASR-0.6B","language":"zh","cached":false,"mock":false}`；
  `response_format=text` 时直接返回 `text/plain` 纯文本。
  失败非 200：`{"ok":false,"error":"<短码>","message":"<中文可读原因>"}`，短码至少覆盖
  `no_ffmpeg` / `decode_failed` / `model_load_failed` / `audio_missing` / `busy`（并发保护：同一时刻只允许一个转写，
  忙时 **429 + busy**）。
- **`POST /api/shutdown`** → 200 后进程退出。
- **`GET /v1/models`** → `{"object":"list","data":[{"id":"Qwen/Qwen3-ASR-0.6B",...}]}`。

实现细节（不要简化掉）：

- HTTP 服务**只用标准库**（`http.server.ThreadingHTTPServer` + 自己解析 multipart 的 `file` 字段）；
  额外依赖只允许 `torch` / `transformers` / `modelscope` / `funasr` / `soundfile` / `numpy`。
- **模型加载防御式**：先试 `AutoProcessor` + `Qwen3ASRForConditionalGeneration`
  （用 `getattr` / `try: import` 探测，类不存在就走下一条），再试 `AutoProcessor` + `AutoModelForSpeechSeq2Seq`
  （`trust_remote_code=True`）；**实际用到的加载路径写进日志**；任何异常都转 `model_load_failed` + 异常摘要，
  **绝不把 traceback 当正常响应吐给上层**。输入按官方 chat 形式组装（user 消息里音频 + 文本提示），
  失败退回纯文本提示。
- **长音频**：先 ffmpeg 统一转 **16kHz 单声道 wav**（临时文件放系统临时目录，用完即删）→ fsmn-vad 静音分段
  （拿不到 VAD 退回**固定 30 秒窗口**；单段最长也切到 30 秒）→ 逐段转写 → 按顺序拼接，
  **拼接结果里不出现分段标记**，段间用一个空格。不限时长。
- **日志**：`print` 行式 stdout（UTF-8），关键节点 `[asr] ...`，供上层追加进 `<DATA>\asr\console.log`。

## marker 约定

| 文件 | 内容 | 含义 |
| --- | --- | --- |
| `<INSTALL_DIR>\.install-ok` | 空文件 | 安装成功（上层据此认为装好了） |
| `<INSTALL_DIR>\.asr-agent-result` | 首行 `ok=true`；失败首行 `ok=false` 且下一行 `reason=<短码>` | Agent 安装/修复结论（修复模式同样要重写） |
| `<INSTALL_DIR>\models\.ok` | 空文件 | 两个模型都就位（服务与插件据此判断能不能离线转写） |

约定：**只有真正跑通冒烟才写 `.install-ok`**；失败时**不要**创建它，并老老实实写 `ok=false` + `reason=`。
`reason` 用短码，至少覆盖下面这些：

| reason | 触发条件 |
| --- | --- |
| `no_cuda` | 本机没有 NVIDIA 显卡 / 读不到 `nvidia-smi` —— **应报 `ok=false` + `reason=no_cuda` 并中止安装**，除非用户**显式要求** CPU 版（此时带 `-Cpu` 继续装，结果里注明是 CPU 版） |
| `torch_install_failed` | CUDA 各档位与 CPU 兜底都没装上 torch |
| `venv_creation_failed` | 建 `.venv` 失败（Python 缺失 / 权限） |
| `requirements_install_failed` | 镜像装依赖失败 |
| `model_download_failed` | 两个模型没下全（重跑可续传） |
| `ffmpeg_failed` | 全部 ffmpeg 源都失败（服务仍能起，但转写会 `no_ffmpeg`） |
| `smoke_failed` | mock 冒烟（`/health` 或 mock 转写）不符合契约 |

## 无 N 卡机器的明确口径

**默认拒绝**：探测不到 NVIDIA 显卡（`nvidia-smi` 不存在或读不到驱动版本）时，
不要偷偷装 CPU 版 torch，而应：

1. **不要**创建 `.install-ok`；
2. 写 `<INSTALL_DIR>\.asr-agent-result`：`ok=false` + `reason=no_cuda`；
3. message 里说清「本机没有可用的 NVIDIA 显卡，语音识别后端需要 CUDA；如果你确认要用 CPU 跑（会明显更慢），
   请明确回复」；
4. 只有用户**显式要求** CPU 版时，才用 `-Cpu`（或 `-TorchIndex https://download.pytorch.org/whl/cpu`）继续安装，
   并在结果里注明这是 CPU 版（`cpu=true`）。

已经装了 CPU 版 torch 的机器上，服务会以 `ASR_DEVICE=cpu` 正常跑，只是慢 —— 这不算安装失败。

## 自我修复模式（CONSOLE_LOG 已由插件提交给 dsh）

1. 以「最近失败焦点」为准判断根因；更早日志仅参考。
2. 常见修复：
   - **`no_ffmpeg`** → 先跑 `powershell -File .\scripts\install.ps1 -InstallDir . -FfmpegOnly`
     （多源重试 + TLS1.2 + 校验，成功写 `.ffmpeg-ok`）；仍失败就手动下载 ffmpeg 解压出 `ffmpeg.exe` 放到
     `<INSTALL_DIR>\ffmpeg\bin\`，或设 `ASR_FFMPEG` 指向已有的 ffmpeg.exe、把 ffmpeg 加入系统 PATH
     —— 补齐后必须补写 `.ffmpeg-ok`（内容为路径或 `PATH`）
   - **`model_load_failed`** → 看日志尾部 `[asr] 模型加载路径` 与异常摘要；`models\` 下缺 `config.json`/权重就重跑下载
     （modelscope → hf-mirror）；torch 是 CPU 版却要 `ASR_DEVICE=cuda` 时改回 `cpu` 或重装 CUDA 版 torch
   - **torch 装成了 CPU 版** → 用 `-TorchIndex` 指定与本机驱动匹配的 `cu13x`/`cu12x` 重装
   - **`decode_failed`** → 该段音频损坏或 ffmpeg 中途失败；换音频或用 ffmpeg 手工转 16k 单声道 wav 再试
   - **`busy`（429）** → 不是故障：调用方在并发调用，改成串行（批处理逐条）
   - **`/health` 一直没响应 / 进程立刻退出** → 端口被占用（换 `ASR_PORT`）、venv 里 import 失败
     （`.venv\Scripts\python.exe -c "from app import server"` 看真实报错）、或 `app/` 文件缺失
   - **VAD 没生效（长音频只出一段）** → 看日志是 `fsmn-vad 就绪` 还是 `改用固定 30 秒窗口`；
     后者说明 VAD 模型目录没找到，补下 `iic/speech_fsmn_vad_zh-cn-16k-common-pytorch` 到 `models\`
3. 已下载的模型与 ffmpeg **勿删**；只修 venv / app / 脚本 / 标记。
4. 冒烟通过后重建 `.install-ok`，并把 `.asr-agent-result` 改回 `ok=true`；回复 `repair_ok=1`。
5. **不要启动** `python -m app`（启停由插件负责）。

## 约束

- 不要启动管理服务常驻（冒烟用的一次性启停必须结束就关）。
- 不要删除用户已有的 `models/` 或 `ffmpeg/`（除非损坏且任务明确要求重下）。
- 磁盘不足时先警告用户再继续（模型 1.88GB + 依赖与 torch 约 3–5GB，建议预留 ≥8GB）。
- 所有脚本输出、日志、注释与文档都用**中文**。

## 成功标准

- `INSTALL_DIR\.install-ok` 存在
- `.venv\Scripts\python.exe -c "from app import server"` 成功
- `ffmpeg\bin\ffmpeg.exe` 存在
- `models\Qwen__Qwen3-ASR-0.6B\config.json` 与 `models\iic__speech_fsmn_vad_zh-cn-16k-common-pytorch\configuration.json` 存在
- mock 冒烟（`MTNODE_ASR_MOCK=1`）通过：`/health` 字段齐全且 `mock:true`、一次 mock 转写返回 `"mock": true` 且 `text` 非空
- 写入 `.asr-agent-result`（`ok=true`）；失败写 `ok=false` + `reason=`
- 回复：`install_ok=1`、`venv_ok=`、`ffmpeg_ok=`、`asr_model=`、`vad_model=`、`cpu=`（是否 CPU 版）
