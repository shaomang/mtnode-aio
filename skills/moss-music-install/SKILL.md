---
name: moss-music-install
title: MOSS-Music 本地音乐理解后端安装
description: 在用户指定目录安装 / 修复 MOSS-Music（OpenMOSS 8B 音乐理解 Instruct 模型 · 本地 HTTP 8790）后端：探测 NVIDIA 显存与磁盘，用 uv 取 Python 3.12 建隔离 venv，装 CUDA torch 2.9.1+cu128 与推理依赖，下载官方推理源码（zip，不用 git）与 Instruct 权重（ModelScope 优先，回退 hf-mirror），备便携 ffmpeg，跑「只导入不加载权重」的冒烟并写 .install-ok；含目录约定、重跑边界、已知故障与按错误码分派的【自我修复】。
---

# MOSS-Music 本地音乐理解 — 安装 / 修复

当用户或 MTNode 插件要求在某目录**安装 / 自我修复**「MOSS-Music（本地音乐理解）」时使用本 skill。

上游：[OpenMOSS/MOSS-Music](https://github.com/OpenMOSS/MOSS-Music)（Apache-2.0）。
本机跑的是**官方 Transformers 推理路径**（`src/hf_inference.py`），不接 SGLang、不套官方 Gradio UI；
`app/server.py` 是 MTNode 自己的服务壳（只加 JSON 契约、长音频切片与产物落盘）。

插件调用时：

- **当前工作区就是 `INSTALL_DIR`**，可直接读写并执行命令。
- **`SCAFFOLD_REF`（或 `.scaffold-ref`）只作参考**：随包脚手架 `moss-music-pack/` 是示例实现，不是已完成的安装。
- 若任务附带 **`CONSOLE_LOG`**，以「最近失败焦点」为准定位根因（更早的 Traceback 可能已被后续步骤绕开）。
- 安装窗的步骤表真源是 `moss-music-pack/steps.json`；失败码与中文文案也在那里。**本文是该失败码对应处置的唯一真源**，弹窗只负责指路。

## 目标与验收

在 `INSTALL_DIR` 完成后端，使：

- `.venv\Scripts\python.exe` 存在，且能 `import torch / transformers`，`torch.cuda.is_available()` 为真
- `source\MOSS-Music\src\hf_inference.py` 存在
- `models\MOSS-Music-8B-Instruct\` 有 `config.json` 与完整 safetensors（约 18GB）
- `tools\ffmpeg\ffmpeg.exe` 就位（缺了安装仍算成功，但长音频切片 / 时长探测会失败）
- `.env` 写好运行时默认值
- **冒烟通过**：只导入 `torch` / `transformers` / `src.hf_inference`，**不加载 18GB 权重**；通过后写 `.install-ok`

宿主判「已装」看的是 `projectSignals().ready`，即**同时**满足
`app\server.py` + `.venv\Scripts\python.exe` + `source\MOSS-Music\src\hf_inference.py`
+ 模型目录的 `config.json` + `.install-ok`。
**文件不齐时只补 `.install-ok` 没用，也不会让权重重下**；反过来脚本 exit 0 但文件不齐，宿主仍会报「安装脚本结束但项目不完整」。

## 目录约定

```
INSTALL_DIR\
  app\server.py                       本地 HTTP 服务（安装时随脚手架复制）
  scripts\install.ps1 / step.ps1      逐步骤安装（幂等，可重复执行）
  steps.json / manifest.json / README.md
  .venv\                              Python 3.12（uv）+ CUDA torch + 依赖
  source\MOSS-Music\                  官方推理源码（zip 下载，不用 git）
  models\MOSS-Music-8B-Instruct\      约 18GB
  tools\ffmpeg\ffmpeg.exe             便携 ffmpeg
  tools\uv\uv.exe                     uv（本机没有时自动取）
  tools\uv-cache\                     uv 的 Python / 包缓存
  outputs\                            手工起服务时的默认产物目录
  .env                                运行时默认值（server.py 启动时读）
  .install-ok                         安装成功标记
  .scaffold-ref                       脚手架来源（仅参考）
```

数据纪律：venv / 权重 / 源码 / ffmpeg **全在用户安装目录**，不写应用文件夹；
插件自己的 config / 日志 / pid 只在 `%APPDATA%\pipeline-console\app-plugins\moss-music\`。

## 硬件门槛（第一步，不合格不要硬装）

```powershell
nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader
(Get-PSDrive -Name D).Free / 1GB     # 换成安装目录所在盘
```

| 情况 | 处理 |
| --- | --- |
| 没有 NVIDIA 显卡 / 读不到驱动 | **拒绝**：不建 `.install-ok`，说明本后端只走 CUDA，并给替代方案（云端 API / 换机器） |
| 显存 `< 12GB` | **拒绝**：连 int4 都不够，说明装上也跑不起来 |
| 显存 `12–16GB` | 可装，**只能 int4**（int8 会 OOM） |
| 显存 `≥16GB` | 可装，默认 **int8**；不够再降到 int4 |
| 驱动主版本 `< 525` | **拒绝 / 先升级驱动**：cu128 轮子跑不了；装完也会在 `cuda.is_available()` 挂着 |
| 磁盘剩余 `< 60GB` | **拒绝**：8B 权重约 18GB + CUDA torch 与依赖约 12GB；清盘或换目录后重跑 |

- 量化档与显存是**运行时**选择，不是安装时选择：安装只装一份 Instruct 权重（约 18GB），
  节点 / 控制台切 `int8` / `int4` 只影响装载方式（bitsandbytes 装载时现场量化）。
- 插件列表里 12G 门槛由 `plugins/vram-gate.js` 统一判定：显存不足且没装过时卡片会被隐藏，
  不是安装脚本报错，别把它当故障修。

## 基座 Python 与 uv

- Python 固定 **3.12**，由 **uv** 获取并创建 `.venv`（`uv venv --seed`），**不碰系统 Python、不许 `--system-site-packages`**。
- uv 查找顺序：PATH 里的 `uv` → `INSTALL_DIR\tools\uv\uv.exe` → `%LOCALAPPDATA%\uv\uv.exe`；
  都没有才从 `github.com/astral-sh/uv` 下载 zip，失败回退 `gh-proxy.com` / `ghfast.top` / `ghproxy.net`，解开到 `tools\uv\`。
- Python 下载镜像：`UV_PYTHON_INSTALL_MIRROR=https://registry.npmmirror.com/-/binary/python-build-standalone/`（可用同名环境变量覆盖）。
- 缓存固定 `UV_CACHE_DIR=INSTALL_DIR\tools\uv-cache`，`UV_HTTP_TIMEOUT=120`。
- 失败一律落到 `moss.python.failed`；本机已有 uv 时优先复用，不要重复下载。

## 镜像与源顺序（国内网络必须）

1. **pip**：清华 `pypi.tuna.tsinghua.edu.cn/simple` → 阿里云 → USTC → 官方 PyPI。
2. **torch / torchaudio**：固定 `2.9.1+cu128`，索引顺序
   `mirror.sjtu.edu.cn/pytorch-wheels/cu128` → `mirrors.aliyun.com/pytorch-wheels/cu128` → `download.pytorch.org/whl/cu128`。
   装完立刻用 `python -c "import torch;print(torch.cuda.is_available())"` 验，**不要接受 CPU 版充数**。
3. **官方源码**：`codeload.github.com/OpenMOSS/MOSS-Music/zip/refs/heads/main`
   → `gh-proxy.com` → `ghfast.top` → `ghproxy.net`（zip 解包，**不用 git**）。
4. **权重**：**ModelScope 优先**，仓库 id 依次试 `openmoss/MOSS-Music-8B-Instruct` / `OpenMOSS-Team/MOSS-Music-8B-Instruct`；
   都失败才回退 `HF_ENDPOINT=https://hf-mirror.com` + `HF_HUB_DISABLE_XET=1` 下
   `OpenMOSS-Team/MOSS-Music-8B-Instruct`。**仓库 id 以实际可达为准**，最终用了哪个写进日志与结论。
5. **ffmpeg**：`gyan.dev` 的 essentials zip → GitHub BtbN 构建（经三个 gh 代理）；只取 `ffmpeg.exe` / `ffprobe.exe`。

依赖版本（`install.ps1` 写死，别随手改）：`transformers==4.57.1`、`torchcodec==0.9.*`、
`accelerate`、`safetensors`、`numpy>=2.0`、`soundfile`、`tiktoken`、`einops`、`scipy`、`tqdm`、
`packaging`、`requests`、`huggingface_hub`、`modelscope`、`bitsandbytes`（量化档要用）。

## 安装步骤（`scripts\install.ps1` 按此顺序跑）

| # | id | 做什么 | 失败码 |
| --- | --- | --- | --- |
| 1 | `disk` | 读安装目录所在盘剩余空间，`-DiskHintGb` 默认 60 | `moss.disk.low_space` / `moss.disk.unreadable` |
| 2 | `python` | 取 uv → `uv python install 3.12` → 建 `.venv` | `moss.python.failed` |
| 3 | `torch` | 三镜像装 `torch==2.9.1+cu128` + `torchaudio`，验 CUDA | `moss.torch.cuda_unavailable` / `moss.torch.install_failed` |
| 4 | `deps` | 四镜像装推理依赖 | `moss.deps.pip_failed` |
| 5 | `source` | 下载官方源码 zip 并解到 `source\MOSS-Music` | `moss.source.download_failed` |
| 6 | `weights` | 8B Instruct 权重（先 ModelScope 两个 id，再 hf-mirror） | `moss.weights.download_failed` |
| 7 | `files` | 模型目录要有 `config.json` 且合计 ≥1GB；源码关键文件在 | `moss.files.incomplete` |
| 8 | `ffmpeg` | 便携 ffmpeg；下不到只 skip，不失败 | —（`Step-Skip`） |
| 9 | `env` | 写 `.env`（ASCII） | `moss.env.write_failed` |
| 10 | `smoke` | 导入 torch / transformers / `src.hf_inference`，验 CUDA，写 `.install-ok` | `moss.smoke.cuda_unavailable` / `moss.smoke.import_failed` |

脚本参数：`-InstallDir`、`-DiskHintGb`、`-ForceSource`、`-SkipWeights`。
脚本文件（`.ps1` / `.cmd`）必须保持**纯 ASCII**（PowerShell 5.1 在中文 Windows 上按 ANSI 解码无 BOM 的 `.ps1`，中文会把语法解崩）；中文文案只放 `steps.json`。

## 运行时契约（修完要按这个验）

- 端口 **8790**（`MOSS_MUSIC_PORT` / `--port` 可改），只监听 `127.0.0.1`；与 H3 / Music3 / YuE2 的端口互不冲突。
- 端点：
  - `GET /health` → `ready / loading / model / quant / models{...} / error / pid`；**不加载权重**，可随时探活。
  - `POST /load` `{model:"instruct", quant:"int8"|"int4"}`，30~90s；旧调用方传 `bf16` 归一化成 `int8`、传 `thinking` 归一化成 `instruct`，都在回包里带 `migrated`。
  - `POST /unload` 释放显存（推理在跑时先协作取消，2.5s 没退就回 `busy_generating`）。
  - `POST /cancel` 取消在途生成（分块边界退出）；画布节点 ■ 走 `mossmusic:cancelGenerate`：`/cancel` → 3s → `taskkill /T /F` → `/unload`。
  - `POST /generate` `{audioPath, question, outputDir?, model?, quant?, longAudio?, ...}`
    → `{ok, text, files:{md,json,srt}, cues, chunks, durationSeconds, longAudio, estimatedTimestamps, elapsedSeconds}`。
- 产物：`<outputDir>\<stem>.md` / `.json` / `.srt`；缺省 `INSTALL_DIR\outputs`，画布节点会把 `outputDir`
  指到应用托管的画布资产目录（**不要替用户改这个落点**）。
- 长音频：时长 > **300s** 且 `longAudio` 为真才切片，**180s 一段、相邻段重叠 5s**，ffmpeg 转 16k 单声道，
  段内时间戳平移回原曲并去重；模型没给时间戳时按字数摊到句子上，并在 JSON 标 `estimatedTimestamps: true`。
- 模型 / 量化：只有 Instruct 一个模型；同一时刻只驻留一份；切量化档 = 卸载旧权重 + 重新装载 18GB（30~90s 属正常）。
- 进程生命周期：后端是**有意的常驻单例，不随 MTNode 退出**；`before-quit` 只关控制台窗。
  停它只有两条路：控制台「停止服务」，或用户自己结束进程。单个生成任务的 ■ 走 `/cancel`（3 秒不退就杀进程），会把模型一起卸掉。
- 全局互斥：与音乐 / 语音 / 视频共用 `media-gen-global-lock.js` 那把锁，同一时刻只跑一个音视频任务；
  宿主单次生成超时 **45 分钟**。

## 重跑与幂等边界

| 步骤 | 重跑时 |
| --- | --- |
| `disk` | 每次必跑，毫秒级 |
| `python` | uv / Python 已缓存则复用；`.venv` 存在则不再创建 |
| `torch` | **每轮都重新 pip install**（数 GB），没有跳过开关；这是重跑的固定成本 |
| `deps` | 每轮都重新 pip install；已满足时 pip 很快，但并非零成本 |
| `source` | `src\hf_inference.py` 在就复用；`-ForceSource` 强制重下 |
| `weights` | 模型目录里 safetensors 合计 **>1GB 就判「已完成」并跳过**；已完成的分片在重跑时会被下载器复用 |
| `files` | 每次必跑，纯校验 |
| `ffmpeg` | exe 在就跳过；下载失败只 skip |
| `env` | 每次重写 |
| `smoke` | 每次必跑；开头先删 `.install-ok`，末尾成功才写回 |

**重跑不会自动修复「看起来 >1GB 但缺分片」的权重目录**（`done()` 只看总量 >1GB，`files` 也只看 >1GB）：
遇到加载时报 safetensors 缺失 / 形状不符，核对模型目录体积是否接近 18GB，缺就删掉该目录再重下。
只删 `.install-ok` 不会触发任何重下。

## 已知故障（按证据对号，不要套剧本）

| 现象 / 错误码 | 判据 | 处置 |
| --- | --- | --- |
| `moss.disk.low_space` | 实测剩余 < 60GB | 清盘或换安装目录；**运维问题，不自动修** |
| `moss.python.failed` | uv / Python 取不下来，或安装目录不可写 | 查网络到 GitHub / npmmirror；本机装 uv 后重跑；已下载的会复用 |
| `moss.torch.cuda_unavailable` | `cuda False`，probe 里 torch 版本正常 | 装成了 CPU 轮子或驱动 <525；升级驱动后重跑 `torch`（不能只改配置） |
| `moss.torch.install_failed` | 三个索引全失败 | 确认能访问 SJTU / 阿里云 / 官方之一；看首个 pip 报错 |
| `moss.deps.pip_failed` | 某包四个源都没有，或 transformers 版本冲突 | 读日志首个失败包；**不要升级 transformers**（服务按 4.57.1 写的） |
| `moss.source.download_failed` | codeload + 三个代理都失败 | 网络恢复后重跑；手动解包到 `source\MOSS-Music` 也认 |
| `moss.weights.download_failed` | ModelScope 与 hf-mirror 都没成功 | 重跑（已完成分片复用）；或手工把仓库全部文件放进 `models\MOSS-Music-8B-Instruct` |
| `moss.files.incomplete` | 缺 `config.json` / 合计 <1GB / 缺 `hf_inference.py` | 按报错补齐；注意 >1GB 的残缺目录会漏过这条校验 |
| `moss.env.write_failed` | 目录不可写 / 被占用 | 换目录或解除占用后重跑 |
| `moss.smoke.cuda_unavailable` | 冒烟时 `cuda False` | 虚拟机没直通 GPU、驱动掉了，或 torch 被别的包换成 CPU 版 |
| `moss.smoke.import_failed` | 导入 `src.hf_inference` 报错 | 依赖装了一半 / transformers 被换 / 源码不全；看冒烟日志 |
| `not_installed` / `no_venv` | 缺 `app\server.py` 或 `.venv\Scripts\python.exe` | 重跑安装（宿主启动前会把 `app` / `scripts` 从随包脚手架重新同步） |
| `stale_python` | `.venv` 里的 python 跑不起来（基座被删 / 挪走） | 删 `.venv` 重装；不要试图修那个已失效的解释器 |
| `vram_low` | 当前量化档超出显存（int8 16G / int4 12G） | 降到 int4；**不是安装问题** |
| `backend_spawn_failed` / `backend_exited` / `backend_start_timeout` | 进程起不来 / 起来就退 / 180s 内 `/health` 不就绪 | 看控制台日志尾部；先手工跑 `.venv\Scripts\python.exe app\server.py --install-dir . --check` 定位 |
| `load_failed` / `load_timeout` | `/load` 报错或 300s 没完成 | 权重残缺（见上）、显存不足或量化档不支持；先降档再查权重 |
| `model_not_loaded` / `model_mismatch` | 请求的档与已装载的不一致 | 宿主会自动 `/load`；持续出现说明切档失败，看 `/load` 返回 |
| `busy` / `busy_other_node` | 后端或全局锁正被占用 | 等当前任务结束；**不是故障** |
| `generate_timeout` | 单次超过 45 分钟 | 开长音频分块、降量化档或换短音频 |
| `deliverable_missing` | 后端没写出 md / json / srt | 看 `outputDir` 是否可写、磁盘是否满；服务端异常会打到控制台 |
| 长音频 / 时长识别失败 | `ffmpeg slicing failed` 或时长 0 | `tools\ffmpeg\ffmpeg.exe` 缺失（安装时 ffmpeg 步骤允许 skip）或不在 PATH；补下 ffmpeg |

**两个结构性坑（修之前先认）：**

- **宿主每次启动后端前都会用随包脚手架覆盖 `app\` / `scripts\`**。在 `INSTALL_DIR\app\server.py` 里改代码，
  下次启动就被还原 —— 那不是可交付的修复。需要改服务壳时，改的是应用侧 `moss-music-pack/app/server.py`，
  并在回复里说明超出了本会话可写范围。
- `server.py` 读 `.env` 时**不覆盖已存在的环境变量**。机器上残留的 `MOSS_MUSIC_SOURCE` / `MOSS_MUSIC_MODELS` /
  `MOSS_MUSIC_FFMPEG` 会盖过 `.env`，指向旧路径。

## 【自我修复】模式

插件报错弹窗 / 安装窗点「交给 mtnode 会话修复」时，按下面顺序做；**不要一上来重装全套**。

1. **先分型**：安装链失败（停在 `disk`…`smoke` 某步，带 `moss.*` 码）还是运行期失败（启动 / 装载 / 生成）。
   安装链看失败那一步的日志尾；运行期看 `/health`、控制台日志与错误码。
2. **读现场，不猜**：
   ```powershell
   Get-Content .\.env
   Test-Path .\.venv\Scripts\python.exe, .\source\MOSS-Music\src\hf_inference.py
   .\.venv\Scripts\python.exe -c "import torch, transformers; print(torch.__version__, torch.cuda.is_available(), transformers.__version__)"
   .\.venv\Scripts\python.exe app\server.py --install-dir . --check
   Get-ChildItem .\models\MOSS-Music-8B-Instruct | Measure-Object Length -Sum
   $env:PYTHONPATH = (Join-Path (Get-Location) "source\MOSS-Music")
   .\.venv\Scripts\python.exe -c "import torch, transformers; from src.hf_inference import MossMusicHFInference; print('import ok', torch.cuda.is_available())"
   ```
   `--check` 只检查源码与模型目录的 `config.json` 在不在，并打印 torch / CUDA / ffmpeg 路径；**不加载权重、不起服务**。
   它**不导入** `src.hf_inference`，也不把 `cuda=False` 判成失败，所以冒烟口径要配合最后那条导入探针一起看。
3. **只修能修的那一层**：缺依赖补依赖、缺 ffmpeg 补 ffmpeg、权重缺片补权重、`.env` 路径错了改 `.env`、
   `.venv` 坏了删了重建。**不要**启动后端 / 加载模型、不要删 `outputs\`、不要重下已验证完整的权重。
4. **不自动修的判据**（只报告 + 说清下一步，不要烧一轮）：
   - 没 NVIDIA 显卡 / 显存 <12GB / 驱动 <525：`vram_low`、`cuda_unavailable` 属于环境不达标；
   - 磁盘不足（`moss.disk.low_space`）；
   - 安装目录不合法（盘根 / 系统目录 / 应用目录）；
   - 用户主动取消、安装正在进行中；
   - 需要改应用侧代码（见上面的结构性坑）。
5. **改脚本时守 ASCII**：`scripts\*.ps1` 里的中文（含注释）会让 PowerShell 5.1 语法崩；中文文案只进 `steps.json`。
6. **收尾**：能修就修到 `--check` 退出 0 **且**上面的导入探针通过（两者合起来才是冒烟口径），
   必要时重跑 `scripts\install.ps1`（幂等，但 torch / deps 会重装）；
   然后在 `INSTALL_DIR` 根下按提示词给定的名字写标记与结果文件（没给就用 `.repair-ok` / `.agent-repair-result`，
   首行 `ok=true`，可附 `reason=`），并在回复里给出 `repair_ok=1` 与简要根因。
   修不动就写 `ok=false` + `reason=<哪一条没交付 + 具体报错>`，并明确告诉用户还需要做什么。

## 安装成功后的交接

- 安装脚本已写 `.install-ok`，宿主会刷新卡片为已装态（主按钮变「重装」、出现「启用」）；**不要**再手工启动服务（启动由卡片「启用」或节点 ▶ 负责）。
- 如果是在安装窗里跑完的：回到安装窗看步骤全绿即可；权重或 venv 不齐时宿主会提示「安装脚本结束但项目不完整」。
- 用户侧只会看到「插件 · MOSS-Music」卡片：安装 / 重装、启用 / 停用、控制台；操作说明在 `guides/manual/moss-music.md`。

## 卸载

移除插件**不删已装项目**（安装目录里的 venv / 源码 / 18GB 权重都留在原处），也不删画布资产目录里的
md / json / srt；要清理只能由用户自己删目录。
后端是常驻单例，**移除插件不会替你停它** —— 先到控制台点「停止服务」（或结束进程），再处理目录。
