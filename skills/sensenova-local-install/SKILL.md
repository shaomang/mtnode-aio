---
name: sensenova-local-install
title: SenseNova 本地图像生成安装
description: 在用户指定目录安装 SenseNova-U1.5-8B-MoT 本地文生图后端：探测 NVIDIA 驱动/显存/内存/磁盘/Python（显存 <20GB 或内存 <32GB 直接拒绝并给 vram_mode 建议与替代方案）、优先用 uv 从 npmmirror 拉 Python 3.11 建隔离 venv、按驱动装 cu128/cu126 的 CUDA 版 torch 2.8.0（SJTU→阿里云→官方三级回退）、从 GitHub tag 归档装 sensenova_u1 推理包（--no-deps，国内 gh 代理回退）、用 ModelScope 下载 SenseNova/SenseNova-U1.5-8B-MoT 权重（32.66GB / 8 片，失败回退 hf-mirror）、拉起 8774 端口标准库 HTTP 服务做 mock 冒烟与连续两次真实出图（只发一发测不出「第一张成功、之后每次 500」的坑）。含按错误码分派的自我修复指引与实测显存/耗时基准。
---

# SenseNova 本地图像生成 — 安装 / 修复

当用户或 MTNode 插件要求在某目录安装 / **自我修复** **SenseNova（SenseNova-U1.5-8B-MoT 本地文生图）** 后端时使用本 skill。

上游参考：[OpenSenseNova/SenseNova-U1](https://github.com/OpenSenseNova/SenseNova-U1)（安装文档 `docs/installation_CN.md`）、
权重 [ModelScope SenseNova/SenseNova-U1.5-8B-MoT](https://www.modelscope.cn/models/SenseNova/SenseNova-U1.5-8B-MoT) ·
[HuggingFace sensenova/SenseNova-U1.5-8B-MoT](https://huggingface.co/sensenova/SenseNova-U1.5-8B-MoT)。
官方文档与示例脚本以 **Linux** 为准，本 skill 是本机（Windows）移植口径，两者冲突时**以本 skill 为准**（见「Windows 与官方 Linux 的差异」）。

对接面核对基准：tag **`comfyui-v0.3.0`** 的 `examples/t2i/inference.py`（`t2i_generate` 的入参、`SUPPORTED_RESOLUTIONS` 11 个训练桶、`_denorm` 反归一化）、`examples/editing/inference.py`（**参考图 / 图像编辑**：`it2i_generate(tokenizer, prompt, images, image_size=…, cfg_scale=…, img_cfg_scale=…, …)`，`images` 是 PIL 列表）与 `apps/comfyui/local_pipeline.py`（进度钩子）。**升级 `-Ref` 到新 tag 前必须重核这几处**，接口一变本包的 `app/engine.py` 就要跟着改。

插件调用时：

- **当前工作区就是 `INSTALL_DIR`**，可直接读写并执行命令
- **`SCAFFOLD_REF`（或 `.scaffold-ref`）仅作参考**：内置 `sensenova-pack/` 脚手架是示例实现，不是已完成的安装。请按下方目标自行准备目录；可按需从参考路径复制或改写，也可等价实现
- 不要假设插件已替你复制好脚手架
- 若任务附带 **CONSOLE_LOG**（插件 console 最近日志），以「最近失败焦点」为准定位根因并修复，**不要盲目重下 32.66GB 权重**

## 目标

在 `INSTALL_DIR` 完成可运行的 SenseNova 后端，使：

- `INSTALL_DIR\.venv\Scripts\python.exe` 存在；`-c "from app import server"`、`-c "import sensenova_u1"`、`-c "import torch"` 三条都成功
- venv 内 **只装 CUDA 版 torch**（禁 `--system-site-packages`），`torch.cuda.is_available()` 为真且版本串带 `+cu1xx`（不带 `+cu` 就是 CPU 版，**判失败**）
- `transformers >= 4.57.1`：低于此版本 `AutoConfig` 认不出 `model_type: "neo_chat"`，加载必失败
- `INSTALL_DIR\models\SenseNova__SenseNova-U1.5-8B-MoT\` 权重就绪：`config.json` + `model.safetensors.index.json` + **8 片** `model-*-of-00008.safetensors`，分片合计 **≥30GB**（应约 32.66GB）
- `INSTALL_DIR\models\.ok`、`INSTALL_DIR\.attn-backend`（`flash` 或 `sdpa`）、`INSTALL_DIR\.install-ok`、`INSTALL_DIR\.sensenova-agent-result` 存在
- **冒烟通过后不要保留常驻服务**：启停由插件负责（冒烟用的一次性启停必须结束就关）

## 输入参数

| 参数 | 含义 |
| --- | --- |
| `INSTALL_DIR` | 安装目录（当前工作区）。`app/`、`scripts/`、`requirements.txt`、`manifest.json`、`start_backend.cmd` 放这里 |
| `SCAFFOLD_REF` | 内置脚手架参考路径（`sensenova-pack/`）。可复制 app/scripts/requirements/manifest，也可等价实现 |
| `CONSOLE_LOG` | 插件 console 最近日志（修复模式下优先据此定位根因） |

**固定口径（不要改）**：模型 `SenseNova/SenseNova-U1.5-8B-MoT`（ModelScope id，HF id 为小写 `sensenova/...`）、推理包 `sensenova_u1`（GitHub tag `comfyui-v0.3.0`）、服务端口 **8774**、默认 `vram_mode=fast`、默认 `dtype=bfloat16`、默认 `attn_backend=sdpa`。

脚本参数（`scripts\install.ps1`，幂等可重跑）：

| 参数 | 用途 |
| --- | --- |
| `-InstallDir` | 安装目录（默认脚本上一级） |
| `-Python` | 显式指定 `python.exe`（离线 / 特殊环境） |
| `-TorchIndex` | 显式覆盖 torch 的 `--index-url`（跳过自动镜像选择；公司内网镜像用它） |
| `-TorchWheel` | 本地 `torch-2.8.0*.whl` 完全离线安装（同目录需有 torchvision whl） |
| `-Ref` | `sensenova_u1` 的 GitHub tag（默认 `comfyui-v0.3.0`） |
| `-SrcTarball` | 已下好的 SenseNova-U1 归档 `.tar.gz` 或已解压目录（离线续装） |
| `-ModelDir` | 已有权重目录：建**目录联接**接进 `models\`，不复制 32.66GB |
| `-SkipModels` / `-SkipDeps` / `-SkipPkg` / `-SkipTorch` / `-SkipSmoke` | 只修某一段时跳过其它段（**权重就绪的修复一律配 `-SkipModels`**） |
| `-ModelScopeRepo` / `-HfRepo` | 仓库 id 变更时用 |
| `-Cpu` | 装 CPU 版 torch，**仅供联调**（真实出图慢到不可用） |
| `-Force` | 强行跳过显存 / 内存门槛（明知不够仍要装；结论里必须注明） |

## 目录约定（以 `SCAFFOLD_REF` 为参考）

- `INSTALL_DIR/app/` — **只用标准库**的 HTTP 服务（`python -m app <port>`；`server.py` / `engine.py` / `__init__.py` / `__main__.py`）
- `INSTALL_DIR/.venv/` — 隔离虚拟环境（Python 3.11）
- `INSTALL_DIR/models/SenseNova__SenseNova-U1.5-8B-MoT/` — 权重（+ 同级 `.ok` 标记）
- `INSTALL_DIR/outputs/` — 默认产物目录（**勿删**；节点给了 `outputDir` 时写别处）
- `INSTALL_DIR/src/` — `sensenova_u1` 源码解包目录（安装期产物，可留存）
- `INSTALL_DIR/scripts/` — `install.ps1`（幂等）；根目录 `start_backend.cmd`（手动起服用）
- `INSTALL_DIR/.attn-backend` — 单行注意力档位（`flash` / `sdpa`），由安装期探针写出
- `INSTALL_DIR/.install-ok`、`INSTALL_DIR\.sensenova-agent-result` — 成功 / 结论标记（见「marker 约定」）

## 硬件与系统探测（第一步，必做，不合格直接拒绝）

```powershell
nvidia-smi --query-gpu=name,memory.total,driver_version,compute_cap --format=csv,noheader
(Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory
(Get-PSDrive <安装目录所在盘>).Free
```

**判定（硬门槛，不要硬装）**：

| 情况 | 处理 |
| --- | --- |
| `nvidia-smi` 不存在 / 读不到驱动 / 非 NVIDIA（AMD/Intel 核显/Apple） | **拒绝**：`ok=false` + `reason=no_cuda`，不建 `.install-ok`，给替代方案 |
| 显存 **< 20GB** | **拒绝**：`ok=false` + `reason=vram_too_low`（记录实测 `memory.total`）。官方最省的 `vram_mode=low` 也是为 24GB 级卡准备的；但注意**实测 `low` 档峰值只有约 3GiB**（见下表），小卡用户如果有 32GB+ 内存，可用 `-Force` + `vramMode=low` 一试，结论里注明「非官方档、风险自担」 |
| 显存 **20–24GB** | 可装（**警告**为官方推荐档位下限）：**先试 `fast`**，OOM 再降 `balanced` → `low`。实测 4090（24GB）`fast` 峰值仅约 16GiB，`fast` 并不需要 24GB 才跑得动 |
| 显存 **≥ 24GB（4090 / 3090 / A5000 档）** | 官方目标档：默认 `fast`；OOM 自动降 `balanced` → `low` |
| 显存 **≥ 48GB 或多卡** | 可用 `vramMode=full`（不卸载，最快） |
| 物理内存 **< 32GB** | **拒绝**：`reason=ram_too_low`。分层卸载把 32.66GB 权重放进**主内存**，内存不够装得上跑不动；建议 ≥40GB |
| 驱动主版本 **< 570** | 不拒绝：脚本自动降档装 `cu126`（`cu128` 需要 570+）。降档后仍 `cuda.is_available()=False` → `reason=torch_no_cuda`，提示升级驱动 |
| 磁盘剩余 **< 50GB** | **警告后可继续**（结论里注明）：权重 32.66GB + venv 约 12GB + 产物，**建议预留 ≥60GB** |
| 找不到 Python 3.10–3.13 | 见「Python 选择」：先试 uv；都没有 → `reason=python_not_found` 给指引 |

**拒绝时必须一并给出的替代方案**：

1. 改用 MTNode 的**云端文生图节点 `proc_image`**（不占本机显存、无安装成本），要本地化再谈；
2. 换 / 升级到 **24GB 级以上的 NVIDIA 卡**（4090 / 3090 / A5000 / A6000），或 48GB 卡上走 `vram_mode=full`；
3. 内存不足 → 加内存到 ≥40GB（权重 bf16 无法在内存里再压）；
4. 只有 CPU：官方链路在 CPU 上慢到不可用（且部分算子不可用），**不提供 CPU 兜底**，`-Cpu` 只能验流程不能出图。

> 拒绝不是失败报告：要写清实测 `gpu=` / `vram=` / `ram=` / `driver=` / 磁盘剩余，与上面 1–4 条，让用户能自己选下一手。

### 为什么必须分层卸载（别在文档里自创说法）

| 事实 | 数字 | 后果 |
| --- | --- | --- |
| 权重体积 | **32.66GB**（8 片 safetensors，bf16） | > 24GB 显存 → `vram_mode=full` 在 4090 上必 OOM |
| 官方 `vram_mode` | `full`(不卸载) / `fast`(异步预取 + 预算内常驻 generation 层) / `balanced`(异步预取) / `low`(同步逐层) | 24G 卡走 **`fast`**（本包默认），OOM 自动降一档并写进响应 `warnings` |
| 卸载去处 | **pinned 主内存** | 所以内存门槛 32GB、建议 40GB |
| 最小训练桶 | 2048×2048 ≈ **4M 像素** | **降分辨率省不了显存**；要省只能降 `numSteps` 或降 `vramMode` |
| 注意力 | 官方支持 `flash-attn`，**不提供 Windows 轮子** | 默认 `sdpa`；装 flash-attn **不是修复项** |

### 实测基准（RTX 4090 24GB · 驱动 610.88 · 63.8GB 内存 · bf16 · `sdpa` · E: NVMe）

首图含权重加载（懒加载），冷启动第一发比后续慢；同进程后续请求**不必再加载**。下表 `elapsedSec` 是 `/generate` 全程：

| 分辨率桶 | `numSteps` | `vramMode` | 耗时 | `peakVramGiB` |
| --- | --- | --- | --- | --- |
| 2048×2048（1:1 最小桶） | 4 | `fast` | 62.9s（冷，含 28s 加载）/ 23.8s（热） | 15.86 |
| 2048×2048 | 12 + `think` | `fast` | 383.7s | 15.97 |
| 2720×1536（16:9） | 4 | `fast` | 24.3s（热） | 15.85 |
| 3456×1152（3:1） | 4 | `fast` | 24.0s（热） | 15.76 |
| 2048×2048 | 4 | `low` | 57.2s（热） | **2.95** |

读法：`fast` 的显存是**预算封顶**的（约 16GiB，换更大的桶也只涨一点），所以 24GB 卡上 `fast` 就是默认档；`low` 把显存压到 3GiB 但慢约 2.4×。权重加载 **28–32s**（NVMe、8 片）；`low`/`balanced` 因逐层同步会更慢。**冷启动第一发明显更慢**（第一次进 offload 上下文、pinned cache 与 cudnn 预热）：12 步那次前一两步就吃掉几分钟，`/progress` 会一段时间停在 `sample 15%` 不动 —— 那是正常的，看 `step`/`totalSteps` 而不是只看 `percent`。

## Python 选择（优先 uv 托管 3.11，全程不翻墙）

上游 `requires-python >=3.10,<3.14`，官方参考环境是 **3.11**。依次：

1. 显式 `-Python <路径>`
2. **`uv python find 3.11` → 没有就 `uv python install 3.11`**（约 30–60 秒）。必须先设镜像，否则卡在 GitHub release：
   ```powershell
   $env:UV_PYTHON_INSTALL_MIRROR = "https://registry.npmmirror.com/-/binary/python-build-standalone"
   ```
3. 本机 `py -3.11` → `-3.12` → `-3.13` → `-3.10`（`py -<ver> -c "import sys;print(sys.executable)"` 取真实路径）
4. PATH 里的 `python`（**必须核对版本在 3.10–3.13**）
5. 都没有 → `reason=python_not_found`，指引：装 uv（`pip install uv`）或 python.org / Microsoft Store 装 3.11，或用 `-Python` 指路后重跑

命中后 venv 一律用它的 `-m venv` 创建（缺 pip 用 `ensurepip` 兜底，再退 `uv venv --seed .venv`）。

## 国内镜像（必须）与回退顺序

> **中国大陆网络下必须走镜像**：HuggingFace 无法直连、`download.pytorch.org` 与 GitHub 极易超时。

| 内容 | 顺序 |
| --- | --- |
| **pip** | 清华 `https://pypi.tuna.tsinghua.edu.cn/simple`（带 `--trusted-host pypi.tuna.tsinghua.edu.cn`）→ 失败回退**阿里云** `https://mirrors.aliyun.com/pypi/simple/`。**用 `PIP_*` 环境变量覆盖本机全局配置**（`PIP_INDEX_URL` / `PIP_EXTRA_INDEX_URL` / `PIP_TRUSTED_HOST`，外加 `PIP_NO_CACHE_DIR=0` 保留 torch 3.5GB 轮子缓存），别用 `pip --isolated` —— 实测 `--isolated` 只忽略**用户级** config，机器上 `C:\ProgramData\pip\pip.ini` 被 NVIDIA PyIndex 塞的 `extra-index-url = https://pypi.ngc.nvidia.com`（国内 DNS 直接失败）照样生效，每个包白等 5 次重试；而且 `--isolated` 会连 `PIP_*` 环境变量一起忽略，反而把 ngc 放回来 |
| **torch / torchvision**（**不写进 `requirements.txt`**） | ① **SJTU** `https://mirror.sjtu.edu.cn/pytorch-wheels/<cuXXX>`（`--index-url`，传递依赖走清华 extra）→ ② **阿里云** `https://mirrors.aliyun.com/pytorch-wheels/<cuXXX>`（平铺轮子，用 `--find-links`）→ ③ 官方 `https://download.pytorch.org/whl/<cuXXX>`；`-TorchIndex` 可整体覆盖、`-TorchWheel` 可完全离线 |
| **cu 档位** | 驱动主版本 `≥570` → `cu128`；`<570` → `cu126`。每档装完**必须验证** `torch.cuda.is_available()` 为 `True` 且版本带 `+cu` |
| **`sensenova_u1` 推理包**（**PyPI 上 404，不存在**） | GitHub tag 归档 tarball `https://github.com/OpenSenseNova/SenseNova-U1/archive/refs/tags/<Ref>.tar.gz`，直连失败逐个试国内代理：`https://ghfast.top/…` → `https://gh-proxy.com/…` → `https://ghproxy.net/…`；都失败 → 让用户手动下载后用 `-SrcTarball <路径>` |
| **模型权重** | **优先 ModelScope（魔搭）**：`modelscope.snapshot_download("SenseNova/SenseNova-U1.5-8B-MoT", local_dir=…, ignore_patterns=["assets/*","docs/*","*.mp4","*.webm","*.gif"])`（国内直连）→ 失败回退 `HF_ENDPOINT=https://hf-mirror.com` + `HF_HUB_DISABLE_XET=1` + `huggingface_hub.snapshot_download("sensenova/SenseNova-U1.5-8B-MoT")` |
| **uv 的 Python** | `UV_PYTHON_INSTALL_MIRROR` → npmmirror（见上节） |

- 权重下载**可续传**：已存在且非空的分片自动跳过；中断就重跑脚本。
- **ModelScope 与 HF 的 id 大小写不同**（`SenseNova/…` vs `sensenova/…`），结论文本里写清最终实际用到的源与 id。
- Windows PowerShell 5.1 下载前必须开 TLS1.2：`[Net.ServicePointManager]::SecurityProtocol = … -bor [Net.SecurityProtocolType]::Tls12`，否则 pip 装得上、tarball 下不动。
- 全程 `PYTHONIOENCODING=utf-8`（GBK 控制台打进度会崩）。

## 安装步骤（按序；括号内是脚本打印的 `progress:` 值）

1. **硬件 / Python 探测**（见上）。不合格 → 按拒绝口径写结论并中止，给替代方案。（04–10）
2. **准备工程文件**：若缺 `app\server.py` / `app\engine.py` / `app\__main__.py` / `scripts\install.ps1` / `requirements.txt` / `manifest.json` / `start_backend.cmd`，从 `SCAFFOLD_REF` 复制或按参考生成。**保留**用户已有的 `.venv` / `models` / `outputs`。
   入口口径：`<INSTALL_DIR>\.venv\Scripts\python.exe -m app <port>` 就是宿主启动命令（SenseNova **没有** Gradio UI 入口，与 YuE2 不同）。
3. **建 venv**（隔离，禁 `--system-site-packages`）+ 升级 pip / setuptools / wheel（清华 → 阿里云）。（12–16）
4. **装 CUDA 版 `torch==2.8.0` + `torchvision==0.23.0`**（官方 requirements 钉 cu128；SJTU → 阿里云 → 官方）。（22–30）
   - **本地版本号必须写进 pin**（`torch==2.8.0+cu128`）：清华 / PyPI 上的 Windows 轮子就是 CPU 版，只写 `torch==2.8.0` 会「装成功但看不到 CUDA」。
   - 自检：`& ".venv\Scripts\python.exe" -c "import torch; print(torch.__version__, torch.version.cuda, torch.cuda.is_available())"` 打印 `True` 才算过。（30）
5. **装 `requirements.txt`**（`accelerate` / `transformers>=4.57.1,<6` / `modelscope` / `huggingface-hub` / `safetensors` / `sentencepiece==0.2.1` / `pillow==12.0.0` / `numpy` / `tqdm` / `packaging` / `httpx`；**torch 不在其中**）。（34–40）
   - 随后**单独校验 transformers 能认 `model_type: "neo_chat"`**（读 `models\...\config.json` 过一遍 `AutoConfig.from_pretrained`）；不达标 → `reason=transformers_too_old`。
6. **装 `sensenova_u1` 推理包**（44–54）：
   - `pip install <解包目录> --no-deps`。**`--no-deps` 是硬要求**：`pyproject.toml` 钉 `torch==2.8.0`，让 pip 重解依赖会把刚装好的 cu128 覆盖成 CPU 版。
   - 解包只取 `pyproject.toml` + `README.md` + `LICENSE` + `src/`（跳过 `training/`、`evaluation/` 大目录）。**`LICENSE` 不能省**：`pyproject.toml` 里是 `license = { file = "LICENSE" }`，漏掉它 hatchling 会在 `Preparing metadata (pyproject.toml)` 阶段抛 `OSError: License file does not exist: LICENSE`（看着像构建环境/网络问题，实际就是少个文件）。
   - **`--strip-components=1` 与「按成员名选择」不能同时用**（Windows 自带 bsdtar 实测）：成员名已经含顶层目录 `${包名}-${tag}/`，再剥一层会把文件吐到 `INSTALL_DIR\src\` 而不是 `INSTALL_DIR\src\<顶层>\`，脚本随后检查 `<顶层>\pyproject.toml` 就误判「没拿到文件」并报 `source_unavailable`（源码其实已解压）。退回整包解压时才用 `--strip-components=1 -C <顶层目录>`。
   - 装完立刻跑一次接口自检：`import sensenova_u1`（会把 NEO-Unify 注册进 transformers）、`from sensenova_u1.utils import load_model_and_tokenizer, make_offload_ctx, vram_mode_to_prefetch_count, vram_mode_keeps_generation_resident, best_available_device`、`from sensenova_u1.models.neo_unify import NEOChatModel`，并探 `import flash_attn`：**能 import → 写 `.attn-backend`=flash；不能 → sdpa（Windows 常态）**。（52）
7. **下载权重**（56–82）：ModelScope 优先 → hf-mirror 回退；校验「8 片 + `config.json` + `model.safetensors.index.json` + 合计 ≥30GB」才写 `models\.ok`。离线复用用 `-ModelDir`（目录联接，不复制）。
8. **核对工程文件清单**。（82）
9. **mock 冒烟**（脚本自动，86–96）：见下节「冒烟口径 ①」；未过 → 只写 `ok=false reason=smoke_failed`，**不写 `.install-ok`**，退出码 1。
10. **一次真实出图**（判定安装真能用；见「冒烟口径 ②」）。脚本不自动做（要几分钟到几十分钟），由 Agent / 用户显式跑一次并记录峰值显存与耗时。
11. **标记完成**：创建 `.install-ok`；写 `.sensenova-agent-result`（`ok=true`）；失败写 `ok=false` + `reason=<短码>`。（96–100）

**手工等价安装**（不用脚本时，命令与镜像必须同上）：

```powershell
cd INSTALL_DIR
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1 -InstallDir .
# 只修环境不重下权重：
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1 -InstallDir . -SkipModels
```

## 冒烟口径（先 mock 再真实，两步都算数）

### ① mock（契约层，秒级，不加载模型）

`MTNODE_SENSENOVA_MOCK=1` 起 `python -m app 8774`（cwd = `INSTALL_DIR`），依次验：

1. `GET /health` → 200，字段齐全（见契约），`mock:true`、`loaded:false`、`resolutions` 有 **11 个桶**；
2. `POST /generate`（只给 `prompt`）→ 200，`imagePath` 指向的文件**存在且是真 PNG**（首 8 字节 PNG 签名），`width/height/seed` 与入参一致，`artifacts[]` 齐；
2b. `POST /generate` 带 `refImages`（先造一张 1×1 PNG，另给一条不存在的路径）→ 200 且 `mode:"edit"`、`refImagesUsed:1`（不存在的被跳过）；产物目录 `settings.json` 里也记成 `mode:"edit"` —— 参考图（图像编辑）链路通不通就看这条；
3. 生成期间并发第二发 → **429 + `error:"busy"`**；
4. 采样期间 `GET /progress` 能采到百分比 / 步数，且 `percent` 单调不回退；
5. `POST /cancel` → 首发 **409 + `error:"cancelled"`**，且**不留半成品产物**；
6. `POST /shutdown` → 200 后进程自退（**不留常驻进程**）。

全绿才认为「服务契约没问题」。mock 通过 **不代表能出图**（模型 / torch / 注意力档位都没真跑）。

### ② 真实出图（判定安装成功，mock 不能替代）

关 mock 重启服务，发一次**极小成本**请求：`vramMode=fast`（24G 卡 OOM 则依次 `balanced` / `low`）、`attnBackend=sdpa`、`ratio="1:1"`（2048×2048 是最小桶，省不了）、`numSteps` 先给 4~20、`think=false`。判定：

- 返回 200 且 `imagePath` 的 PNG **非空、能被 PIL 打开、尺寸与请求一致**；
- 记下 `peakVramGiB` / `elapsedSec` 与是否触发**自动降档 warnings**（写进结论，作为该机型默认值依据）；
- 首次请求含权重加载（32.66GB），**数分钟级属正常**：期间 `/health` 与 `/progress` 仍秒回，别当卡死去 `taskkill`。
- **必须连跑两次**（第 2 次 200 才算真通过）：本机实测过一个「第一张成功、之后每次 500」的坑
  （`RuntimeError: Inference tensors do not track version counter.`，根因见已知故障表），
  只发一发是测不出来的。第二次还会快很多（热路径）。

## SenseNova 服务契约（插件依赖，实现 `app/` 时勿缺、字段名勿改）

以 `SCAFFOLD_REF` 的 `app/server.py` 为权威实现。

- **启动**：`<INSTALL_DIR>\.venv\Scripts\python.exe -m app <port>`，cwd = `INSTALL_DIR`，默认端口 **8774**，**只监听 `127.0.0.1`**；就绪时 stdout 打一行 `[sensenova] ready`；日志行式 UTF-8，统一 `[sensenova] ` 前缀（供上层追加进 `<DATA>\sensenova\console.log`）。不使用任何弹窗 / 浏览器。
- **环境变量**：`SENSENOVA_PORT`、`SENSENOVA_MODEL_DIR`、`SENSENOVA_DEVICE`、`SENSENOVA_VRAM_MODE`、`SENSENOVA_DTYPE`、`SENSENOVA_ATTN_BACKEND`、`SENSENOVA_FAST_VRAM_FRACTION` / `SENSENOVA_FAST_VRAM_HEADROOM_GIB` / `SENSENOVA_FAST_ACTIVATION_RESERVE_GIB` / `SENSENOVA_FAST_VRAM_BUDGET_GIB`（`fast` 档显存预算）、`SENSENOVA_MOCK_DELAY_SEC`、`MTNODE_SENSENOVA_MOCK=1`（**必须支持**）、`HF_ENDPOINT`。
- **`GET /health`** → 200：`ok` / `service` / `version` / `model` / `modelModelScope` / `backend` / `packageVersion` / `device` / `gpu` / `loaded` / `busy` / `mock` / `modelSource` / `modelReady` / `installDir` / `outputsRoot` / `vramModes` / `vramMode` / `dtypes` / `dtype` / `attnBackends` / `attnBackend` / `effectiveAttnBackend` / `cfgNorms` / `defaults{width,height,numSteps,cfgScale,cfgNorm,timestepShift,imgCfgScale,maxRefImages,seed}` / `resolutions[{ratio,width,height}×11]` / `progress{stage,percent}`。
  权重**懒加载**：未加载时 `/health` 必须秒回，**绝不能触发加载**。上层（节点表单、下拉、默认值）一律读这里，**不要在渲染层再抄第二份清单**。
- **`POST /generate`**（`application/json`）：`prompt`（必填）、`refImages`（可选，参考图 / 编辑底图的本机绝对路径数组，1–4 张；**非空即走 `it2i_generate` 图像编辑模式**，响应 `mode:"edit"`，读不到的路径跳过并进 `warnings`）、`imgCfgScale`（可选，缺省 1.0 = 图像 CFG 关闭，只在编辑模式有意义）、`width`/`height` 或 `ratio`、`numSteps`(1–200, 默认 50)、`cfgScale`(默认 4.0)、`cfgNorm`(`none`/`global`/`channel`/`cfg_zero_star`)、`timestepShift`(默认 3.0)、`cfgInterval[lo,hi]`、`seed`、`vramMode`、`dtype`、`attnBackend`、`think`(bool)、`outputDir`、`filename`（强制 `.png`）、`device`。
  成功 200：`{"ok":true,"imagePath":"<绝对 PNG>","outputDir":…,"artifacts":[…],"width":…,"height":…,"ratio":"1:1","vramMode":…,"dtype":…,"attnBackend":…,"peakVramGiB":…,"thinkText":"","thinkPath":"","seed":…,"numSteps":…,"cfgScale":…,"cfgNorm":…,"timestepShift":…,"think":false,"mock":false,"elapsedSec":…,"warnings":[],"mode":"t2i"|"edit","refImages":[…],"refImagesUsed":0,"imgCfgScale":1.0}`。
  产物：主图 PNG；`think=true` 额外落 `<名>.think.txt`；并写一份 `settings.json` sidecar 记录入参。
- **`GET /progress`** → `{stage,percent,message,step,totalSteps,running,cancelRequested,elapsedSec}`；**`POST /cancel`**；**`POST /shutdown`**（响应后 `close()` 释放显存再退出，**上层停服走这个，不要 taskkill**）；`GET /` 服务自述。
- **串行互斥**：同一时刻只允许一张图（并发 → **429 + `busy`**）。**服务常驻即可，不要因「第二张卡住」重启后端**。
- 失败非 200：`{"ok":false,"error":"<短码>","message":"<中文可读原因>"}`；短码与 HTTP：`bad_request`(400) · `not_found`(404) · `cancelled`(409) · `busy`(429) · `model_load_failed` / `generate_failed` / `save_failed` / `internal_error`(500)。
- 取消语义：置位后在**下一个采样步边界**生效（torch kernel 不可抢占，不是立即停）；中止后**不写任何产物**。

### 官方 11 个训练分辨率桶（非桶值只告警不拦）

| ratio | W×H | ratio | W×H | ratio | W×H |
| --- | --- | --- | --- | --- | --- |
| `1:1` | 2048×2048 | `16:9` | 2720×1536 | `9:16` | 1536×2720 |
| `3:2` | 2496×1664 | `2:3` | 1664×2496 | `4:3` | 2368×1760 |
| `3:4` | 1760×2368 | `1:2` | 1440×2880 | `2:1` | 2880×1440 |
| `1:3` | 1152×3456 | `3:1` | 3456×1152 | | |

## Windows 与官方 Linux 的差异（本机移植口径）

官方文档以 Linux 为准。**不要照抄 bash 命令**，按下表换算：

| 主题 | 官方（Linux） | 本机（Windows）口径 |
| --- | --- | --- |
| 环境 / 激活 | `source .venv/bin/activate` + `uv pip install -e .` | 直接调 `.\.venv\Scripts\python.exe`（不依赖 activate） |
| 装 `sensenova_u1` | `pip install -e .`（从仓库根装） | PyPI **无此包**：下 tag 归档 tarball（国内 gh 代理）→ 解 `pyproject.toml`+`src/` → `pip install <dir> --no-deps` |
| 注意力 | `pip install flash-attn`（要源码编译） | **不装 flash-attn**（无官方轮子）；默认 `sdpa`，`.attn-backend` 记录探针结论，`SENSENOVA_ATTN_BACKEND` 可覆盖 |
| torch 来源 | `--extra-index-url https://download.pytorch.org/whl/cu128` | 同上但**必须换国内镜像**（SJTU / 阿里云），且带 `+cu1xx` 本地版本号 |
| 权重下载 | HF Hub 直连 | **ModelScope 优先**，回退 `HF_ENDPOINT=https://hf-mirror.com` + `HF_HUB_DISABLE_XET=1` |
| 符号链接 | `ln -s` | Windows 建 symlink 要开发者模式：`-ModelDir` 复用与缓存一律 `New-Item -ItemType Junction`（目录联接）或复制 |
| 多卡 / 分布式 | — | 本包**只做单卡**：不接多机 / 张量并行，省显存全靠 `vram_mode` 分层卸载 |
| 进程终止 | `kill <pid>` / SIGTERM | 无 SIGTERM：优先 `POST /shutdown`，兜底 `Stop-Process -Id <pid> -Force`；确认端口释放（`Get-NetTCPConnection -LocalPort 8774`）后再重启 |
| 控制台编码 | UTF-8 | GBK 会打崩进度条：`PYTHONIOENCODING=utf-8` + `PYTHONUNBUFFERED=1` |
| 路径 | `/` 无盘符 | 统一 `\` 与绝对路径；`INSTALL_DIR` **不要含中文 / 空格 / 超长路径**（32GB 分片 + 深目录易炸 260 字符限制） |
| 官方文档口径 | `docs/installation_CN.md` 的 pip 兼容安装段：从仓库源码装 + `--no-deps` | 本包照此实现（tag 归档 tarball 代替 clone，`--no-deps` 保留），再叠加国内镜像与单卡分层卸载 |

以上差异要在结论里说明「本机是移植口径，哪些优化被关了、代价是什么（慢一点，但能出图）」。

## 已知故障（失败自查）

按「最近失败焦点」逐条排查，**不要先重装模型**：

| reason / 现象 | 根因 → 处置 |
| --- | --- |
| `no_cuda` | 非 NVIDIA / 读不到 `nvidia-smi`：按拒绝口径走，给替代方案，**不硬装** |
| `vram_too_low` | 显存 <20GB：见「硬件探测」的拒绝口径（`proc_image` / 换卡），别拿 `-Force` 当修复 |
| `ram_too_low` | 内存 <32GB：分层卸载要在主内存放 32.66GB 权重 → 加内存；`-Force` 只是装上跑不动 |
| `python_not_found` | 无 uv 且无 3.10–3.13：`pip install uv` 后重跑（走 npmmirror 自动拉 3.11），或 `-Python` 指路 |
| `venv_creation_failed` | 删半成的 `.venv` 重跑；仍失败手动 `& "<py>" -m venv .\.venv` 看真实报错（多为路径含中文 / 权限 / 杀软拦 python.exe） |
| `torch_install_failed` | 三个源都没拿到轮子：手动下 `torch-2.8.0+cu128-cp311-cp311-win_amd64.whl` 后 `-TorchWheel <路径>`；或 `-TorchIndex` 指内网镜像。核对 venv 的 Python 小版本与 whl 的 `cpXXX` 是否一致 |
| `torch_no_cuda`（`cuda.is_available()=False`、版本不带 `+cu`） | **pip 把 torch 重解成了 CPU 版**（最常见：漏了 `--no-deps`，或把 torch 写进 `requirements.txt`）。处置：`pip uninstall -y torch torchvision` → 重跑脚本第 4 步（**权重不重下**）；驱动 <570 确认已降 `cu126`，否则升驱动 |
| `requirements_install_failed` | 清华 → 阿里云逐个试；单跑 `pip install --isolated -r requirements.txt -i <清华> --trusted-host <host>` 看完整报错 |
| `transformers_too_old` | 低于 4.57.1 认不出 `model_type: "neo_chat"`：`pip install -U "transformers>=4.57.1,<6" -i <清华>` 后重跑；**不要重下权重** |
| `source_unavailable` | 四个源都拿不到 tarball：手动下 `.../archive/refs/tags/comfyui-v0.3.0.tar.gz` 后 `-SrcTarball <路径>` 重跑（离线机器让同事拷过来）；换 `-Ref` 前先重核接口。**若归档明明下好了还报这条**：看 `INSTALL_DIR\src\<顶层目录>\` 里有没有 `pyproject.toml`（没有 = 解包时误加了 `--strip-components=1`，文件被吐到了 `src\` 根）；再看源码就绪判据是否只认 `pyproject.toml` —— 判据必须是**完整成员集**（`pyproject.toml` + `LICENSE` + `src\sensenova_u1\__init__.py`），否则残缺目录永不自愈 |
| `package_install_failed` | `pip install <dir> --no-deps` 失败，多半是 build 隔离环境拉不到 `hatchling`：加 `-i <阿里云>` 或 `--no-build-isolation`。**若报 `OSError: License file does not exist: LICENSE`**：不是构建/网络问题——解包漏了 `LICENSE`，把它补进解包成员清单重跑 |
| pip 反复卡在 `pypi.ngc.nvidia.com` 重试 | 本机全局 pip 配置里被塞了不可达的 `extra-index-url`（NVIDIA PyIndex 常见）。用 `PIP_INDEX_URL` / `PIP_EXTRA_INDEX_URL` / `PIP_TRUSTED_HOST` 覆盖；**`pip --isolated` 不管用**（只忽略用户级 config，还会忽略 `PIP_*`） |
| `package_import_failed` | `sensenova_u1` import 崩：九成是 `transformers` 太低，或 `--no-deps` 后漏装 `sentencepiece` / `safetensors` —— 按报错补装，**不要重装 torch、不要重下权重** |
| `model_load_failed` + `unrecognized model_type` | transformers 过旧 / `sensenova_u1` 版本与权重不匹配：先升 transformers，再确认 `import sensenova_u1` 已把 NEO-Unify 注册进 transformers；仍不行用 `-Ref` 指更新的推理包 tag |
| `model_load_failed` + `CUDA out of memory` | `vramMode=full` 或 `fast` 档预算过激 → 依次降 `balanced` → `low`；先关 H3 / Music3 / 浏览器等占卡进程；后端本身会自动降一次并写 `warnings`，看 warnings 判断实际用了哪档 |
| `generate_failed` + `Inference tensors do not track version counter.`（**第一张能出、之后每次都 500**） | 本包已修（`app/engine.py` 用 `torch.no_grad()` 取代 `torch.inference_mode()`）。机理：`inference_mode` 造出的张量带 inference 标记，而 `sensenova_u1` 的 NEO-ViT 会把首次前向现造的 rotary `cos/sin` 表缓存在模块上（`modeling_neo_vit.apply_rotary_emb_1d` 的 `cos_cached[positions]`），第二次生成复用该缓存即抛错。**若用户的安装目录里 `app\engine.py` 是旧版**：把脚手架里的新 `engine.py` 同步过去（宿主启动时会 sync，也可手动拷）后重启服务；**不要重装权重、不要重装 torch**，与模型文件无关 |
| `generate_failed` + `CUDA out of memory` | 采样期激活值撑爆：降 `numSteps`（50→30→20）、降 `vramMode`、`PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True`；**降分辨率无效**（最小桶就是 4M 像素） |
| 真实生成报 `USE_FLASH_ATTENTION ...` / flash 相关 | `.attn-backend` 写成 `flash` 但轮子不可用：设 `SENSENOVA_ATTN_BACKEND=sdpa`（或把 `.attn-backend` 改成 `sdpa`）重启服务；**绝不要为此去装 flash-attn** |
| `model_missing` / `models\.ok` 不存在 | 权重未下全（8 片不齐或合计 <30GB）：重跑脚本续传；或 `-ModelDir <已有目录>`；核对 ModelScope / HF 的 id 大小写 |
| 权重下载反复中断 | 续传＝直接重跑；查磁盘剩余、代理 / 镜像、`LongPathsEnabled`、杀软与网盘同步锁文件（32GB 分片最容易被锁） |
| 服务起了但 `/health` 无响应 / 立刻退出 | 端口被占（换 `SENSENOVA_PORT`；`Get-NetTCPConnection -LocalPort 8774` 查占用）、venv 内 import 失败（`python -c "from app import server"` 看真实报错）、`app\` 文件缺一半（`engine.py` 与 `server.py` 必须**同时**在 INSTALL_DIR **与**随包脚手架里，否则每轮 sync 覆盖回坏的） |
| 429 `busy` | **不是故障**：单任务互斥。上层「抽卡 N 次」必须串行等上一张结束 |
| `/cancel` 返回 200 但没有产物 | 设计口径：取消在采样步边界生效、中止不落产物；`/progress` 会变 `cancelled` |
| 首次 `/generate` 极慢、看着像死掉 | 懒加载 32.66GB + 分层卸载，数分钟级属正常；`/health` `loaded:false` 且 `/progress` 有推进就不是死。**冷启动第一两项采样步尤其慢**（offload 上下文首进、pinned host cache、cudnn 预热），实测 12 步那次的头一两步就吃掉几分钟，`/progress` 会停在 `sample 15%` —— 看 `step`/`totalSteps`，别只看 `percent` |
| 第二张图比第一张快很多 | **正常且符合预期**：模型常驻，第二次不再加载（实测 2048²/4 步：62.9s → 23.8s）。不要为此改配置 |
| 控制台一打进度就崩 / 乱码 | GBK：设 `PYTHONIOENCODING=utf-8`（脚本与 `start_backend.cmd` 已设，自己起进程时也要设） |
| 产物写不出 / `save_failed` | `outputDir` 不存在且无权限、路径含中文、磁盘满；产物目录属用户数据，**不要**写进应用安装目录 |

## marker 约定

| 文件 | 内容 | 含义 |
| --- | --- | --- |
| `<INSTALL_DIR>\.install-ok` | 空文件 | 安装成功（**只有 mock 冒烟真跑通才写**；失败不要创建它） |
| `<INSTALL_DIR>\.sensenova-agent-result` | 首行 `ok=true`；失败首行 `ok=false` 且下一行 `reason=<短码>` | Agent 安装 / 修复结论（修复模式同样要重写） |
| `<INSTALL_DIR>\models\.ok` | 空文件 | 8 片权重合计 ≥30GB 且 `config.json` 在位（服务据此判 `modelReady`） |
| `<INSTALL_DIR>\.attn-backend` | 单行 `flash` 或 `sdpa` | 安装期注意力探针结论；`SENSENOVA_ATTN_BACKEND` 优先级更高 |
| `<INSTALL_DIR>\.scaffold-ref` | 单行绝对路径 | 随包脚手架参考路径（仅参考，不等于已安装） |

`reason` 短码至少覆盖：`no_cuda`、`vram_too_low`、`ram_too_low`、`python_not_found`、`venv_creation_failed`、
`torch_install_failed`、`torch_no_cuda`、`requirements_install_failed`、`transformers_too_old`、`source_unavailable`、
`package_install_failed`、`package_import_failed`、`model_download_failed`、`smoke_failed`、`port_busy`。

## 自我修复模式（CONSOLE_LOG 已由插件提交给 dsh）

1. 以「最近失败焦点」为准判根因；更早日志仅参考。
2. **权重已齐（`models\.ok` 在、8 片 ≥30GB）→ 一律 `-SkipModels` 重跑，绝不重下 32.66GB。**
3. **只改 `INSTALL_DIR` 内的东西**：venv / torch 档位 / app 脚本 / 标记 / 环境变量。不改画布、不改插件其它目录、不改版本号。
4. **不擅自把服务起成常驻**：冒烟的一次性启停结束就关（`POST /shutdown` 优先，兜底 `Stop-Process`）；启停归插件。
5. 常见修复：
   - `torch_no_cuda` → `pip uninstall -y torch torchvision` 后重跑第 4 步（**保留 `--no-deps` 口径**，否则再被重解成 CPU 版）
   - `package_import_failed` / `transformers_too_old` → 只补装对应包，其它不动
   - flash 报错 → `.attn-backend` 改 `sdpa`（或设 `SENSENOVA_ATTN_BACKEND=sdpa`），**不装 flash-attn**
   - OOM → 降 `vramMode`（fast→balanced→low）、降 `numSteps`、关其它占卡后端（MTNode 侧有全局媒体锁）；`fast` 档预算可调 `SENSENOVA_FAST_VRAM_HEADROOM_GIB` / `SENSENOVA_FAST_VRAM_BUDGET_GIB`
   - `model_load_failed` 且 `modelReady:false` → 只补缺的分片（重跑续传）
   - `smoke_failed` → 直接 `python -m app 8774` 手工看 stdout 真实报错：多半是 `app\server.py` / `app\engine.py` 缺半边或字段名被改
   - `busy` → 不是故障，改串行
6. 修完**重跑 mock 冒烟**（`/health` + `/generate` + busy + cancel + shutdown），条件允许再补一次真实出图；通过后重建 `.install-ok`、把 `.sensenova-agent-result` 改回 `ok=true`；回复 `repair_ok=1`。
7. 勿删 `outputs\`（用户产物）、勿删 `models\`、勿把用户数据写进应用安装目录。

## 约束

- **不启动常驻服务**（启停由插件负责）；冒烟进程必须关掉。
- 不删用户已有的 `models\` / `outputs\`（除非损坏且任务明确要求重下）。
- **禁止** `--system-site-packages` 的 venv；**禁止**把 torch 写进 `requirements.txt`。
- **`sensenova_u1` 一律 `--no-deps` 安装**（这是防止 CPU 版 torch 复现的唯一办法）。
- **不装 flash-attn、不做多卡 / 分布式、不引入 conda。**
- 磁盘不足先警告再继续（权重 32.66GB + venv 约 12GB + 产物：**建议预留 ≥60GB**）。
- 无 N 卡 / 显存 <20GB / 内存 <32GB → **如实拒绝**并给替代方案，不硬装、不伪造成功。
- 所有脚本输出、日志、注释与文档都用**中文**。

## 成功标准

- `INSTALL_DIR\.install-ok` 存在；`.sensenova-agent-result` 写 `ok=true`（失败 `ok=false` + `reason=`）
- `.venv\Scripts\python.exe -c "import sensenova_u1, torch, transformers"` 成功；`torch` 版本带 `+cu1xx` 且 `cuda.is_available()` 为真；`transformers >= 4.57.1`
- `.venv\Scripts\python.exe -c "from app import server"` 成功
- `models\SenseNova__SenseNova-U1.5-8B-MoT\` 8 片合计 ≥30GB，`models\.ok` 存在；`.attn-backend` 存在
- **mock 冒烟全绿**（`/health` 11 桶 / 一次 PNG 产物 / 带 `refImages` 进图像编辑模式 / 并发 429 busy / `/progress` 单调 / `/cancel` 409 无产物 / `/shutdown` 自退），随后服务已关闭
- **两次真实出图都 200**（`vramMode=fast` 起，OOM 则降档）产出非空可打开的 PNG，`peakVramGiB` 与 `elapsedSec` 已记录 —— **只发一发不算通过**（「第一张成功、之后每次 500」的坑只有连跑才暴露，见已知故障表）
- 回复：`install_ok=1`、`gpu=`（name+VRAM+driver）、`ram=`、`python=`、`venv_ok=`、
  `torch=`（含 `+cu1xx` 与 `cuda_available`）、`sensenova_u1_ref=`（tag）、`attn_backend=`、
  `model_dir=`、`model_source=`（ModelScope / hf-mirror / 离线 `-ModelDir`）、`health_ok=`、
  `mock_smoke_ok=`、`real_gen_ok=`、`image_out=`（PNG 绝对路径 + 尺寸）、`peak_vram_gib=`、`elapsed_sec=`、`vram_mode_used=`
