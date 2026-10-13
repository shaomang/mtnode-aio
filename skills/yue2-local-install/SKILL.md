---
name: yue2-local-install
title: YuE2 本地音乐生成安装
description: 在用户指定目录安装 YuE2（m-a-p/YuE2-3B + YuE2-Vae）本地全曲音乐生成后端：探测显存/驱动 + 取基座 Python（3.12 / 3.11，本机没有就从 npmmirror 下；非 NVIDIA 或显存 <24G 直接拒绝并给替代方案）、建隔离 venv、按驱动装 cu12x/cu13x torch、pip 安装 yue2 与依赖、ModelScope/HF 镜像下载权重、拉起 yue-pack 服务做 /health 与一次极短生成冒烟。含失败自查、Windows 与官方 Linux 差异（本机移植口径）与自我修复指引。
---

# YuE2 本地音乐生成 — 安装 / 修复

当用户或 MTNode 插件要求在某目录安装 / **自我修复** **YuE2（本地全曲音乐生成，含人声）** 后端时使用本 skill。

上游参考：[YuE2 官方仓库](https://github.com/multimodal-art-projection/YuE)、[m-a-p/YuE2-3B 模型卡](https://huggingface.co/m-a-p/YuE2-3B)。
官方文档与安装脚本以 **Linux** 为准，本 skill 是本机（Windows）移植口径，两者冲突时**以本 skill 为准**（见「Windows 与官方 Linux 的差异」）。

插件调用时：

- **当前工作区就是 `INSTALL_DIR`**，可直接读写并执行命令
- **`SCAFFOLD_REF`（或 `.scaffold-ref`）仅作参考**：内置 `yue-pack/` 脚手架是示例实现，不是已完成的安装。请按下方目标自行准备目录；可按需从参考路径复制或改写，也可等价实现
- 不要假设插件已替你复制好脚手架
- 若任务附带 **CONSOLE_LOG**（插件 console 最近日志），以「最近失败焦点」为准定位根因并修复，不要盲目重装全部模型

## 目标

在 `INSTALL_DIR` 完成可运行的 YuE2 后端，使：

- `INSTALL_DIR\.venv\Scripts\python.exe` 存在，且 `.venv\Scripts\python.exe -c "import yue2"` 成功
- venv 内**只装 CUDA 版 torch**（不许 `--system-site-packages`，与 Music3 的 `system-site-packages` 口径相反），`torch.cuda.is_available()` 为真
- `INSTALL_DIR\models\m-a-p__YuE2-3B\` 与 `INSTALL_DIR\models\m-a-p__YuE2-Vae\` 权重就绪（含 `config.json` 且权重文件非空）
- `INSTALL_DIR\models\.ok` 与 `INSTALL_DIR\.install-ok` 存在
- **冒烟通过后不要保留常驻服务**：启停由插件负责（冒烟用的一次性启停必须结束就关）

## 输入参数

| 参数 | 含义 |
| --- | --- |
| `INSTALL_DIR` | 安装目录（当前工作区）。`app/`、`scripts/`、`requirements.txt`、`manifest.json` 放这里 |
| `SCAFFOLD_REF` | 内置脚手架参考路径（`yue-pack/`）。可复制 app/scripts/requirements/manifest，也可等价实现 |
| `CONSOLE_LOG` | 插件 console 最近日志（修复模式下优先据此定位根因） |

脚本参数（`scripts\install.ps1`）：`-InstallDir`、`-PythonExe`（显式指定 Python 3.12）、`-TorchIndex`（显式指定 cu 档位）、
`-ModelDir`（离线复用已有权重，建目录联接不复制）、`-SkipModels`、`-AllowOtherPython`（非 3.12 后门）。

## 目录约定（以 `SCAFFOLD_REF` 为参考）

- `INSTALL_DIR/app/` — yue-pack 服务（`python -m app <port>`；`server.py` / `engine.py` / `audio.py` / `__main__.py`）
- `INSTALL_DIR/.venv/` — 隔离虚拟环境（Python 3.12）
- `INSTALL_DIR/models/` — `m-a-p__YuE2-3B/`、`m-a-p__YuE2-Vae/`（+ `.ok` 标记）
- `INSTALL_DIR/output/` — 音频输出（**勿删**）
- `INSTALL_DIR/scripts/` — `install.ps1` / `start_backend.cmd`（幂等，可重复执行）
- `INSTALL_DIR/.cuda-python` — 探测到的 Python 3.12 基座路径（install 后写入）
- `INSTALL_DIR/.install-ok`、`INSTALL_DIR/.yue2-agent-result` — 成功 / 结论标记（见「marker 约定」）

## 硬件探测（第一步，必做，不合格直接拒绝）

```powershell
nvidia-smi --query-gpu=name,memory.total,driver_version,compute_cap --format=csv,noheader
(Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory
py -3.12 -c "import sys; print(sys.version)"
```

**判定（硬门槛，不要硬装）**：

| 情况 | 处理 |
| --- | --- |
| `nvidia-smi` 不存在 / 读不到驱动 / GPU 非 NVIDIA（AMD/Apple/核显） | **拒绝**：写 `ok=false` + `reason=no_nvidia_gpu`，不建 `.install-ok`，给出替代方案 |
| 显存 `<24GB` | **拒绝**：写 `ok=false` + `reason=vram_too_small`（记录实测 `memory.total`），不建 `.install-ok`，给出替代方案 |
| 显存 `≥24GB` | 继续。24G 为**下限**，建议开 CPU offload / 短时长，`≥48GB` 可放宽 |
| 系统内存 `<32GB` | 权重 offload 到 RAM 会挤，**警告**后可继续（备注在结论里） |
| 驱动过老（装完 torch 后 `cuda.is_available()` 为假） | 按 `reason=driver_too_old` 失败，提示更新 NVIDIA 驱动；不要退回 CPU 版充数 |
| 本机没有 Python 3.12 / 3.11 且自动下载也失败 | 安装窗按 `yue2.python.missing` / `yue2.python.fetch_failed` 出中文（网络 / `%APPDATA%` 不可写是主因）；也可自己装 3.12 或设 `MT_YUE2_PYTHON` 后重跑 |

**替代方案（拒绝时必须一并告诉用户）**：

1. 用**云端 / 第三方 API** 或 MTNode 的 Music 3 / 云端音乐节点出歌（本机不用装）；
2. 显存不足但想本机跑：走 **ComfyUI 量化 YuE2 分支**（FP8/int8 量化权重，显存占用低一档）——
   如 [t8star/YuE2-Comfy](https://huggingface.co/t8star/YuE2-Comfy)、
   [ComfyUI-FL-YuE2](https://github.com/filliptm/ComfyUI-FL-YuE2)、
   [ComfyUI-Olm-YuE2](https://github.com/o-l-l-i/ComfyUI-Olm-YuE2)、
   [ComfyUI-YuE2](https://github.com/piscesbody/ComfyUI-YuE2)，按 H3 技能口径建 ComfyUI 环境；
3. 只有 CPU：官方链路在 CPU 上慢到不可用（且部分算子在 CPU 上不可用），**不提供 CPU 兜底**，如实说明。

> 拒绝不是失败报告：要写清实测 `gpu=` / `vram=` / `driver=` 与上面 1–3 条替代方案，让用户能自己选下一手。

## 基座 Python（3.12 优先 / 3.11 可用，install.ps1 自动取）

YuE2 本机移植口径：**Python 3.12 优先，3.11 也可**（cu130 轮子是 cp311+）。`install.ps1` 不再要求你先装 Python，走共享获取器 `scripts/base_python.ps1`（真源 `pack-python/base_python.ps1`，与 h3 / music3 逐字节一致）：

1. `MT_YUE2_PYTHON` / `MT_YUE2_CUDA_PYTHON` / `.cuda-python` 记录的路径（可选覆盖）
2. `py -3.12` / `py -3.11`（Windows 启动器）、常见 conda（`envs\py312|seg|torch|base`）、PATH 中的 `python` / `python3`（**必须核对版本**，3.10 / 3.13 不算命中）
3. 都没有 → **自己取**：有 `uv` 用 `uv python install 3.12`，否则从 `https://registry.npmmirror.com/-/binary/python-build-standalone` 下 `cpython-3.12…x86_64-pc-windows-msvc-install_only` 解压；缓存 `%APPDATA%\pipeline-console\python`

命中后写入 `INSTALL_DIR\.cuda-python`（单行绝对路径），venv 一律用它的 `-m venv` 创建。失败码：`yue2.python.missing`（连下载都失败）、`yue2.python.fetch_failed`、`yue2.python.too_old` / `yue2.python.too_new`（你自己指定的路径版本不合格）——文案在 `yue-pack/steps.json` 的 `messages` 表。

## 国内镜像（必须）

> **中国大陆网络下必须走镜像**：HuggingFace 无法直连。

1. **pip**：清华 `https://pypi.tuna.tsinghua.edu.cn/simple`（`--trusted-host pypi.tuna.tsinghua.edu.cn`）
   → 失败回退**阿里云** `https://mirrors.aliyun.com/pypi/simple/` → **USTC** `https://mirrors.ustc.edu.cn/pypi/simple/`
   → 官方 `https://pypi.org/simple`（官方只做最后一级兜底）；可用 `MT_YUE2_PIP_INDEX` 覆盖。
   **反制机器级 pip.ini**：用 `PIP_INDEX_URL` / `PIP_EXTRA_INDEX_URL` / `PIP_TRUSTED_HOST` **环境变量**在安装子进程内覆盖
   （宿主 `cn-mirrors.js` 的 `installEnv()` 已统一注入），**绝不改用户机器上的 pip.ini**。
   **不要用 `pip --isolated`**：它忽略环境变量与用户级 config，机器级 `extra-index-url = https://pypi.ngc.nvidia.com`
   （NVIDIA PyIndex 常塞，国内 DNS 直接失败）照样生效，每个包白等 5 次重试。
2. **torch（按驱动选 cu 档位，见下节）**：**SJTU** `https://mirror.sjtu.edu.cn/pytorch-wheels/<cuXXX>`
   → **阿里云** `https://mirrors.aliyun.com/pytorch-wheels/<cuXXX>` → 官方 `https://download.pytorch.org/whl/<cuXXX>`
   （`MT_YUE2_TORCH_INDEX` 可覆盖）。
   **不要把 torch 写进 `requirements.txt`**（清华镜像上的 torch 只有 CPU 轮子，会静默装成 CPU 版）。
3. **模型权重**：**优先 ModelScope（魔搭）** `modelscope.snapshot_download("m-a-p/YuE2-3B")` /
   `"m-a-p/YuE2-Vae"`（国内直连）→ 失败回退 `HF_ENDPOINT=https://hf-mirror.com` + `HF_HUB_DISABLE_XET=1` 的
   `huggingface_hub.snapshot_download` → 最后一级才是官方 `huggingface.co`。
   - **仓库 id 以实际可达为准**：ModelScope 上若不存在同名仓库，先用 `modelscope` 的仓库查询 / HF 镜像确认真实 id 再下，
     **不要假设魔搭 id 与 HF id 一定同名**；把最终使用的 id 写进日志与结论文本。
   - 下载中断可重跑续传；已存在且非空的权重**自动跳过**，不重下。
4. **GitHub（如需克隆官方仓库 / 自定义算子、下载 release 归档）**：直连失败用代理回退
   `https://ghfast.top` → `https://gh-proxy.com` → `https://ghproxy.net` → 直连（`cn-mirrors.js` 的 `ghProxyUrls()`）。

## 脚本语言与编码（必须：零中文 + 钉死 UTF-8）

> 宿主用 `powershell.exe`（Windows PowerShell 5.1）跑 `scripts\*.ps1`。而 **UTF-8 无 BOM 的 `.ps1` 在中文 Windows 上会被按 GBK(cp936) 解码** —— 中文变成乱码字节，还会吞掉紧跟的 `}` / `'` / `"`，脚本**直接语法崩**（本轮改前实测：breeze 10 处、sensenova 113 处、yue 42 处、tts 15 处、llama 3 处、h3 download_models 6 处 + repair_torch_kitchen 1 处语法错），控制台同时一片乱码。

- `scripts\*.ps1` / `scripts\*.cmd` 与安装期辅助 `*.py`（如 `download_weights.py` / `probe_attention.py`）**一律纯 ASCII 英文**：注释、消息、异常文本全英文；不许有中文、全角标点、`——`、制表线 `─`、emoji。
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

  这样脚本自身与 pip / git / python 的输出都按 UTF-8 出去，宿主（用 UTF-8 解码 stdout，并按 `[yue2-install] progress:` 抓进度）看到的就是正常文本。
- 这条纪律已是**硬守卫**：`AGENTS.md` 的「协作约定」钉了它，`test/smoke-install-scripts.js` 会自动扫描全部 `*-pack` 的 `.ps1` / `.cmd` / `.bat`、`*-pack/scripts/**/*.py`、共享真源 `pack-steps/` 与 `pack-python/`、以及项目 `scripts/` 下的 `.ps1` / `.cmd` / `.bat` —— 任一字节 > 0x7F（中文、全角标点、emoji、`→`、制表线）或带 BOM 即硬失败。改脚本后**必须**跑 `node test/smoke-install-scripts.js`（同时还钉 GBK(cp936) 与 UTF-8 双解码解析零错、进度前缀与 `reason=` 等 ASCII 契约仍在）；后端运行时 Python（`*-pack/app/**`、`*-pack/shims/**`）豁免，仍是中文。
- Python **后端**（`app/*.py` 的启动横幅与日志）本轮不做零中文，仍是中文，靠上面的 UTF-8 钉死正确显示。

## torch 与驱动档位（按 `driver_version` 自动匹配）

`nvidia-smi --query-gpu=driver_version --format=csv,noheader` 取主版本，按下表**优先高档、失败逐档降级**：

| 驱动主版本 | 顺序 |
| --- | --- |
| `≥580` | `cu130` → `cu128` → `cu126` |
| `≥550` | `cu128` → `cu126` |
| 未知 / 较低 | `cu128` → `cu126` |

- 每档装完**必须验证**：`& ".venv\Scripts\python.exe" -c "import torch; print(torch.__version__, torch.version.cuda, torch.cuda.is_available())"`；
  打印 `True` 才算该档成功。
- 三档全失败 → `reason=torch_install_failed`。
- `torchvision` / `torchaudio` 与 torch **同档同大版本**（同一次 pip 命令一起装）。
- 装成 CPU 版（`torch.version.cuda` 为 `None` 或版本号不带 `+cu`）→ 视为该档失败，用 `-TorchIndex` 重装，
  **不要让服务以 CPU 版启动**。

## 安装步骤（按序）

1. **硬件 / Python 探测**（见上）。不合格 → 按拒绝口径写结论并中止，给出替代方案。
2. **准备工程文件**
   若缺 `app\server.py` / `app\engine.py` / `app\ui.py` / `app\audio.py` / `app\__main__.py` /
   `scripts\install.ps1` / `scripts\start_backend.cmd` / `requirements.txt` / `manifest.json`：
   从 `SCAFFOLD_REF` 复制或按参考自行生成。**保留**用户已有的 `.venv` / `models` / `output`。
   入口口径：宿主（插件）只跑 `.venv\Scripts\python.exe -m app.ui <port>`（Gradio UI 入口）；
   `-m app <port>` 是标准库 HTTP 服务入口，仅用于自查 / 契约冒烟，不要拿它当宿主启动命令。
3. **建 venv**（隔离，禁 `--system-site-packages`）
   ```powershell
   cd INSTALL_DIR
   & "<Python312>" -m venv .venv
   .\.venv\Scripts\python.exe -m pip install -U pip setuptools wheel -i https://pypi.tuna.tsinghua.edu.cn/simple
   ```
4. **按驱动装 CUDA torch**（见上节），装完立即验证 `torch.cuda.is_available()`。
5. **pip 安装 yue2 与依赖**
   ```powershell
   .\.venv\Scripts\python.exe -m pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple
   ```
   - `requirements.txt` 至少包含 `yue2`、`modelscope`、`huggingface_hub`、`soundfile`、`numpy`、`transformers`、
     `accelerate`、`safetensors`、`sentencepiece`、`gradio`；**torch 不在其中**（`gradio` 是 `app\ui.py` 的必需依赖，
     脚手架 `install.ps1` 在 `requirements.txt` 之外显式补装并做 `import gradio` 自检）。
   - **pip 的源不靠命令行参数，靠 `PIP_INDEX_URL` / `PIP_EXTRA_INDEX_URL` / `PIP_TRUSTED_HOST` 环境变量**
     （宿主注入；手工跑时先设好），**不要加 `--isolated`** —— 它忽略环境变量，机器级 `pip.ini` 的不可达 extra-index 会照旧生效。
   - 若 `yue2` 在 PyPI 不可达：改从官方仓库以可编辑方式装（`pip install -e <仓库路径>` 或 `pip install git+<镜像前缀>https://github.com/multimodal-art-projection/YuE.git`），
     并把实际安装来源写进日志与结论。
   - **注意力档位在 Windows 上是明确故障点，不是「慢一点」**：本机 torch 常常**有 flash-attn 的 schema、没有对应 kernel**，
     yue2 默认 `auto` 会选到 flash，真实生成跑到 **Planning score** 阶段才报
     `USE_FLASH_ATTENTION was not enabled for build.`；本移植因此把档位**默认定成 `cudnn`**
     （`app\windows_patch.py` 的 `resolve_backend()`：显式覆盖 → 默认 cudnn，**不再三档探针选档**），
     安装脚本只把这份默认记一份 JSON 记录到 `<INSTALL_DIR>\.attention-backend`。
     真跑一次的确认由**宿主**在启动服务前做：`scripts\probe_attention.py --only <生效档> --json`
     （只验一档；跑不了直接报 `attention_backend_unsupported`，**不自动降级**）。
     要换档只能显式：`YUE2_ATTENTION_BACKEND=sdpa`，或在 `.attention-backend` 里写**单行纯文本**。
   - **不要装 `flash-attn`**（Windows 无官方轮子，源码编译基本失败）：换档靠显式指定，不靠装 flash-attn。
   - 装完自检：`.\.venv\Scripts\python.exe -c "import yue2, soundfile, torch; print('deps ok')"`。
6. **下载模型权重**（ModelScope 优先，hf-mirror 回退；可参考 `SCAFFOLD_REF\scripts\install.ps1`）
   目标：`models\m-a-p__YuE2-3B\`、`models\m-a-p__YuE2-Vae\` 均含 `config.json` 且权重文件非空；
   全部就位后写 `models\.ok`。已有非空权重则跳过。
7. **冒烟（必须做，判定安装是否成功）**
   1. 契约层：起服务 → `GET /health` → 字段齐全；若脚手架支持 `MTNODE_YUE2_MOCK=1`，可先跑一遍 mock（不加载 3B 权重，秒级）。
   2. **一次极短真实生成**（判定口径，mock 不能替代）：短歌词 / 极短时长 / 少步数，请求生成接口，
      确认返回音频路径存在且**文件非空**（> 几 KB，且能被 `soundfile` 读出的时长 > 0）。
   3. `POST /api/shutdown` 关掉服务（**不要留下常驻进程**），把音频路径与时长写进结论。
8. **标记完成**：创建 `.install-ok`；写 `.yue2-agent-result`（`ok=true`）；失败写 `ok=false` + `reason=`。

## yue-pack 服务契约（插件依赖，实现 `app/` 时勿缺）

以 `SCAFFOLD_REF` 的 `app/` 与插件 `yue2/main-yue2.js` 为权威实现；**字段名不要改**。

- **启动**：`<INSTALL_DIR>\.venv\Scripts\python.exe -m app <port>`，cwd = `INSTALL_DIR`，
  **只监听 `127.0.0.1`**；端口由插件下发（`YUE2_PORT`，脚手架默认取一个固定空闲端口，**以 `SCAFFOLD_REF` 为准**）；
  启动成功 stdout 打一行 `[yue2] ready`（便于日志排查）。不使用任何弹窗 / 浏览器。
- **环境变量**：`YUE2_PORT`、`YUE2_MODEL_DIR`（默认 `models\m-a-p__YuE2-3B`）、`YUE2_VAE_DIR`、
  `YUE2_DEVICE`（`cuda`/空=自动）、`YUE2_OUTPUT_DIR`（默认 `output\`）、`MTNODE_YUE2_MOCK=1`（**必须支持**：
  不加载模型、按入参回一个短音频与假元数据，响应带 `"mock": true`）、`HF_ENDPOINT`、
  `PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True`。
- **`GET /health`** → 200 JSON：
  `{"ok":true,"model":"m-a-p/YuE2-3B","vae":"m-a-p/YuE2-Vae","device":"cuda","loaded":false|true,"torch":"<版本>+cu<XXX>","cuda_available":true,"mock":false,"version":"1.0.0"}`；
  模型**懒加载**：未加载时 `/health` 必须秒回，**绝不能触发加载**。
- **生成接口**（`POST`，JSON；入参名以 `SCAFFOLD_REF` 为准）：风格 / 提示词、歌词、**时长（秒）**、步数、seed、
  输出目录与文件名；成功 200 返回
  `{"ok":true,"audio_path":"<绝对路径>","duration_sec":<实际时长>,"sample_rate":<Hz>,"seed":<int>,"model":"m-a-p/YuE2-3B","mock":false}`。
  **串行**：同一时刻只允许一个生成任务（并发给 **429 + `busy`**），生成结束要 `release_vram()`
  （卸回 CPU + 清显存），**服务常驻即可，不要因「第二首卡住」去重启后端**。
- **`POST /api/shutdown`** → 200 后进程退出。
- 失败非 200：`{"ok":false,"error":"<短码>","message":"<中文可读原因>"}`，短码至少覆盖
  `no_cuda` / `model_missing` / `model_load_failed` / `oom` / `busy` / `bad_request` / `generate_failed`。
- **日志**：行式 stdout（UTF-8），关键节点 `[yue2] ...`，供插件追加进 `<DATA>\yue2\console.log`。
- 输出音频：**WAV stereo**，采样率按模型实际输出（写进响应与 sidecar）；输出目录**勿删**，
  每次生成可写一份 `_last_generate_inputs.txt` sidecar 记录入参，便于排查。

## Windows 与官方 Linux 的差异（本机移植口径）

官方 README / 脚本以 Linux 为准。**不要照抄 bash 命令**，按下表换算成等价 PowerShell 实现：

| 主题 | 官方（Linux） | 本机（Windows）移植口径 |
| --- | --- | --- |
| 环境 / 激活 | `source .venv/bin/activate` | `.\.venv\Scripts\python.exe`（**不依赖 activate**，直接调解释器） |
| 注意力加速 | `pip install flash-attn`（需源码编译） | **不装 flash-attn**（Windows 无官方轮子）。且「缺 flash_attn」在 Windows 上**是故障、不是只慢**：本机 torch 常有 flash-attn 的 schema 却没有对应 kernel，yue2 的 `auto` 会选到 flash，真实生成跑到 **Planning score** 阶段报 `USE_FLASH_ATTENTION was not enabled for build.` → 本移植默认档就是 `cudnn`（`app\windows_patch.py` 的 `resolve_backend()`；宿主启动前用 `probe_attention.py --only <档>` 单档快检），要换档只能**显式**指定 `YUE2_ATTENTION_BACKEND` 或在 `.attention-backend` 里写单行纯文本，**不自动降级**。不要用「装 flash-attn」绕过 |
| Triton / `torch.compile` | 自带 triton 轮子 | 无 Linux 轮子；确实要加速时用 `triton-windows`（版本跟随 torch 自带 triton），装不上就**禁用 `torch.compile`**，不要判失败 |
| 量化算子（bitsandbytes 一类） | apt / 预编译轮子 | 优先**不引入**这类依赖；确需时只在有匹配 Windows 轮子时启用，否则走 offload |
| 符号链接 | `ln -s` | Windows 建 symlink 需开发者模式 / 管理员；ModelScope / HF 缓存与 `-ModelDir` 复用一律用**目录联接**（`New-Item -ItemType Junction`）或复制 |
| 路径 | `/` 分隔、无盘符 | 统一 `\` 与绝对路径；`INSTALL_DIR`**不要含中文/空格/超长路径**（模型缓存与固件易炸），必要时提示用户换目录 |
| 进程终止 | `kill <pid>` / SIGTERM | 无 SIGTERM：优先 `POST /api/shutdown`，兜底 `Stop-Process -Id <pid> -Force`；确认端口释放后再重启 |
| 音频 IO | 系统 `libsndfile` / ffmpeg | `soundfile` 的 Windows 轮子自带 `libsndfile`；需要解码 mp3/m4a 时自带便携 `ffmpeg\bin\ffmpeg.exe`（见 4 小节镜像口径） |
| 命令行工具 | `wget` / `curl` / `unzip` | `Invoke-WebRequest` / `Expand-Archive`；**Windows PowerShell 5.1 必须先开 TLS1.2**，否则 HTTPS 直接失败（`[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12`） |
| 多进程 / DataLoader | fork 语义 | Windows 是 spawn：`num_workers` 保持 0/1，别开多 worker；单卡不需要 `MASTER_ADDR` 一类分布式设置 |
| 长路径 / 杀软 | 无 | 模型缓存深目录可能触发 260 字符限制（`LongPathsEnabled`）或被杀软 / 网盘同步锁文件——下载中断先查这两个 |
| 官方精度 | bf16 / fp16 + `torch.compile` | 首次编译极慢且易 OOM：**首次冒烟先关 `torch.compile`**、用短时长，跑通后再按需打开 |

以上差异要在结论里说明「本机是移植口径，哪些优化被关了、代价是什么（慢一点，但能跑）」。

## 已知故障（失败自查）

按「最近失败焦点」逐条排查，**不要先重装模型**：

| 现象 | 根因 / 处理 |
| --- | --- |
| `reason=no_nvidia_gpu` / 读不到 `nvidia-smi` | 非 NVIDIA 机器：按拒绝口径走，给替代方案，不硬装 |
| `reason=vram_too_small` | 显存 <24G：给量化 / ComfyUI / 云端替代方案，不硬装 |
| `torch.cuda.is_available()` 为 `False` | ①torch 装成 CPU 版 → 用 `-TorchIndex` 按驱动重装；②驱动过老 → 升级驱动（`reason=driver_too_old`）；③`nvidia-smi` 版本与驱动不匹配 |
| `import yue2` 失败 | 看真实报错：缺依赖按清华镜像补装；`ModuleNotFoundError` 但目录有包 → 装到了别的解释器（核对 `.venv` 路径）；PyPI 无 `yue2` → 改从官方仓库装并记录来源 |
| `gradio_missing` / `missing_dependency` | 现象：启动即 `RuntimeError`「Gradio 未安装」，或 `ModuleNotFoundError: No module named 'gradio'`（`app\ui.py` 入口）。处置：`.\.venv\Scripts\python.exe -m pip install gradio -i https://pypi.tuna.tsinghua.edu.cn/simple --trusted-host pypi.tuna.tsinghua.edu.cn`（`PIP_*` 环境变量由宿主注入，**不要加 `--isolated`**）后重跑；**不要重下权重** |
| `attention_backend_unsupported` | **现象**：宿主启动服务前的单档快检（`scripts\probe_attention.py --only <档>`）报生效档跑不起来；或运行时真实生成在 **Planning score** 阶段报 `USE_FLASH_ATTENTION was not enabled for build.`。**根因**：本机 torch 有 flash-attn 的 schema 却没有可用 kernel（Windows 移植常见），或该档（默认 `cudnn`）在这台机器 / 这份 torch 上真跑不了。**处置**：先 `--only cudnn` 确认这一档能不能跑；跑不了就**显式**改成 `sdpa`（`YUE2_ATTENTION_BACKEND=sdpa`，或在 `.attention-backend` 里写单行纯文本）—— 本版不自动降级；若生成中途才报，则确认 `app\windows_patch.py` 与 `app\engine.py` **同时**存在于安装目录**与随包脚手架**（缺一半会被每轮 sync 覆盖）；仍不行用 `-TorchIndex` 换带 cuDNN 的 CUDA 版 torch，或换卡。**不要重下权重、不要装 flash-attn** |
| `No module named 'flash_attn'` / `triton` | 报 `ModuleNotFoundError: flash_attn` 本身是预期（Windows 无轮子），**但它不代表没事**：注意力档位必须显式换档，见上面 `attention_backend_unsupported` 行；`triton` 缺失则禁用 `torch.compile`。不要为此装 flash-attn 或重装环境 |
| 模型加载报 `model_missing` | `models\m-a-p__YuE2-3B`（或 VAE）缺 `config.json`/权重 → 重跑下载（ModelScope → hf-mirror）；核对仓库 id 是否真实存在 |
| 下载反复中断 | 续传重跑；查磁盘空间、代理 / 镜像、长路径与杀软锁文件 |
| `oom` | 关掉其它占 GPU 进程（H3 ComfyUI / 浏览器 / 上一次生成未卸回 CPU）；开 CPU offload；缩短时长；设 `PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True`；仍不行就降档到量化分支 |
| `/health` 无响应 / 进程立刻退出 | 端口被占（换 `YUE2_PORT`，`Get-NetTCPConnection -LocalPort <p>` 查看）、venv 内 import 失败（`.venv\Scripts\python.exe -c "from app import server"` 看真实报错）、`app\` 文件缺失 |
| 第二次生成卡住 | **不是故障**：生成互斥串行 + 每首结束 `release_vram()`，服务常驻；等前一首结束即可，别重启 |
| 生成成功但音频为空 / 打不开 | 查 `output\` 权限与磁盘；用 `soundfile` 读一遍时长；编解码缺库则补 `soundfile`；ffmpeg 缺失按镜像口径补装 |
| 声卡设备类报错 | 服务**只落盘不做播放**：不要把音频输出设备当依赖（无头服务器同理） |

## marker 约定

| 文件 | 内容 | 含义 |
| --- | --- | --- |
| `<INSTALL_DIR>\.install-ok` | 空文件 | 安装成功（**只有冒烟真跑通才写**；失败不要创建它） |
| `<INSTALL_DIR>\.yue2-agent-result` | 首行 `ok=true`；失败首行 `ok=false` 且下一行 `reason=<短码>` | Agent 安装 / 修复结论（修复模式同样要重写） |
| `<INSTALL_DIR>\models\.ok` | 空文件 | 两个权重目录都就位 |
| `<INSTALL_DIR>\.cuda-python` | 单行绝对路径 | 建 venv 用的基座 Python（3.12 / 3.11，自动取或显式指定） |

`reason` 短码至少覆盖：`no_nvidia_gpu`、`vram_too_small`、`no_python312`、`venv_creation_failed`、
`torch_install_failed`、`driver_too_old`、`requirements_install_failed`、`model_download_failed`、
`smoke_failed`、`port_busy`。

## 自我修复模式（CONSOLE_LOG 已由插件提交给 dsh）

1. 以「最近失败焦点」为准判断根因；更早日志仅参考。
2. 模型已齐**勿重下**；只修 venv / torch 档位 / app / 脚本 / 标记。
3. 常见修复：torch 档位不匹配 → 按驱动换 `cu1xx` 重装（SJTU → 阿里云 → 官方）；缺 `gradio` / 依赖 → 清华镜像补装
   （靠 `PIP_INDEX_URL` / `PIP_EXTRA_INDEX_URL` / `PIP_TRUSTED_HOST` 环境变量，**不要 `--isolated`**；`import` 失败同理，**不重下权重**）；
   `model_missing` → 只补缺的那个仓库；`/health` 秒回但 `loaded=false` → 生成接口再触发懒加载看真实报错；
   OOM → 关其它 GPU 进程 / 开 offload / 缩短时长；`busy` → 不发并发，改串行。
4. **注意力档位核查**（`USE_FLASH_ATTENTION was not enabled for build.` / `attention_backend_unsupported` / 换过 torch 之后必做）：
   本版**默认就是 `cudnn`**：先用 `scripts\probe_attention.py --only cudnn` 验这一档到底能不能跑
   （`--all` 只看三档实测，不据此选档）。跑不了就把档位**显式**改成 `sdpa` —— 设 `YUE2_ATTENTION_BACKEND=sdpa`，
   或在 `<INSTALL_DIR>\.attention-backend` 里写单行纯文本 `sdpa`（带 `{` 的 JSON 是记录，不是覆盖）；不自动降级。
   若生成中途仍报 flash kernel 缺失，则说明补丁没生效：确认 `app\windows_patch.py` 与 `app\engine.py`
   **同时**存在于安装目录**与随包脚手架**，否则下一轮 sync 会把补丁覆盖掉、故障原样复现。
   **不要**为这条装 `flash-attn`，也**不要**重下模型权重。
5. 修完**重跑冒烟**（`/health` + 一次极短真实生成），通过后重建 `.install-ok`、把 `.yue2-agent-result` 改回 `ok=true`；回复 `repair_ok=1`。
6. **不要启动服务常驻**（冒烟的一次性启停结束就关）；勿删 `output\`。

## 约束

- 不启动常驻服务（启停由插件负责）；冒烟用的进程必须关掉。
- 不删用户已有的 `models\` / `output\`（除非损坏且任务明确要求重下）。
- **禁止** `--system-site-packages` 的 venv。
- 磁盘不足先警告：3B 权重 + VAE + torch/cu + 依赖，建议预留 **≥25GB** 空闲（按实际文件大小估算，别凭感觉）。
- 无 NVIDIA GPU / 显存 <24G → **如实拒绝**并给替代方案，不硬装、不伪造成功。基座 Python 由脚本自己取（3.12 / 3.11），取不到才按 `yue2.python.*` 失败。
- 脚本（`scripts\*.ps1` / `*.cmd` / 安装期辅助 `*.py`）**零中文、纯 ASCII 英文**（见「脚本语言与编码」一节）；Python 后端的日志、API `message` 与本文档仍用中文。

## 成功标准

- `INSTALL_DIR\.install-ok` 存在；`.yue2-agent-result` 写 `ok=true`（失败 `ok=false` + `reason=`）
- `.venv\Scripts\python.exe -c "import yue2"` 成功，且 venv 内 `torch.cuda.is_available()` 为真（非 CPU 版）
- `.venv\Scripts\python.exe -c "import app.ui"` 不报 `ModuleNotFoundError`（允许因缺模型 / 权重而延后到运行时）
- `models\m-a-p__YuE2-3B\` 与 `models\m-a-p__YuE2-Vae\` 权重非空，`models\.ok` 存在
- 冒烟通过：`GET /health` 字段齐全、**一次极短真实生成**产出非空 WAV，随后服务已关闭；
  且这次真实生成**至少跑过 Planning score 阶段**（只加载完模型就报 `USE_FLASH_ATTENTION was not enabled for build.`、
  或拿 mock 冒烟当数，都**不算通过**）
- 回复：`install_ok=1`、`gpu=`（name+VRAM+driver）、`cuda_python=`、`venv_ok=`、`torch=`（含 `+cu1xx` 与 `cuda_available`）、
  `model_dir=`、`model_source=`（ModelScope / hf-mirror / 离线）、`health_ok=`、`smoke_ok=`、`audio_out=`（路径+时长）
