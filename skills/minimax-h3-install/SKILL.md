---
name: minimax-h3-install
title: MiniMax H3 本地安装
description: 在用户指定目录安装 MiniMax H3（24G ComfyUI）后端：探测 GPU/驱动/显存，建隔离 venv、装 CUDA torch(cu130)、ComfyUI 依赖与自定义节点、下载权重（ModelScope 优先）、冒烟与健康检查。含自我修复与显存最佳实践。
---

# MiniMax H3 本地安装

当用户或 MTNode 插件要求在某目录安装 / **自我修复** **MiniMax H3（本地 ComfyUI 视频生成）** 时使用本 skill。

插件调用时：

- **当前工作区就是 `INSTALL_DIR`**，可直接读写并执行命令
- **`SCAFFOLD_REF`（或 `.scaffold-ref`）仅作参考**：内置脚手架/脚本是示例实现，不是已完成的安装
- 不要假设插件已替你复制好脚手架
- 若任务附带 **CONSOLE_LOG**，以「最近失败焦点」为准自行分析修复（每人环境不同）
- **先做硬件探测，再决定装什么/怎么装**（不同 GPU/驱动/显存差异很大，见下）

## 目录约定（以 `SCAFFOLD_REF` 为参考）

- `INSTALL_DIR/ComfyUI/` — ComfyUI 根（`main.py` + `venv/` + `models/` + `custom_nodes/`）
- `INSTALL_DIR/custom_nodes/` — 随包脚手架自带的本地节点包源（当前只有 `nanfeng_prompt_nodes_v10/`），由 `setup_env.ps1` 部署进 `ComfyUI\custom_nodes\`
- `INSTALL_DIR/app/` — 冒烟/健康检查模块（`python -m app` 打印 JSON 报告，见下）
- `INSTALL_DIR/scripts/` — setup_env.ps1 / download_models.ps1 / repair_torch_kitchen.ps1 / patch_*.py / start_backend.cmd
- `INSTALL_DIR/output/` — 视频输出（**勿删**）
- `INSTALL_DIR/.cuda-python` — 探测到的 CUDA Python 基座路径（setup 后写入）
- 权重位置（ComfyUI 约定）：`models/diffusion_models/`、`models/text_encoders/`、`models/vae/`、`models/upscale_models/`、`custom_nodes/ComfyUI-Frame-Interpolation/ckpts/rife/`

## 国内镜像（必须）

> **中国大陆网络下，以下镜像必须使用**：HuggingFace 无法直连，Python 库必须走清华/中科院镜像。

- pip：**清华** `https://pypi.tuna.tsinghua.edu.cn/simple`（或**中科院 USTC** `https://mirrors.ustc.edu.cn/pypi/simple/`、阿里云 `https://mirrors.aliyun.com/pypi/simple/`）；可用 `MT_H3_PIP_INDEX` 覆盖；pip 一律加 `--isolated`（避开坏掉的 `pypi.ngc.nvidia.com` extra-index）
- torch cu130：优先官方 `https://download.pytorch.org/whl/cu130`，失败回退阿里云 `https://mirrors.aliyun.com/pytorch-wheels/cu130`（`MT_H3_TORCH_INDEX` 可覆盖）
- 模型权重（HuggingFace 无法直连）：**优先 ModelScope(魔搭)** `Comfy-Org/MiniMax-H3`（国内直连），失败才回退 hf-mirror（`HF_ENDPOINT=https://hf-mirror.com`，`HF_HUB_DISABLE_XET=1`）
- GitHub（ComfyUI / KJNodes 克隆）：直连失败用 `ghproxy.com` 前缀镜像
- 安装示例：
  ```powershell
  .\scripts\setup_env.ps1   # 内部 pip 默认走清华镜像；CUDA Python 可传 -CudaPython 或设 MT_H3_CUDA_PYTHON
  .\scripts\download_models.ps1  # 权重默认走 ModelScope
  ```

## 硬件探测（第一步，必做）

用 `nvidia-smi` 探测，**不要假设是 RTX 4090**：

```powershell
nvidia-smi --query-gpu=name,memory.total,driver_version,compute_cap --format=csv,noheader
```

判定并记录：

| 项 | 获取方式 | 判定 |
|----|----------|------|
| GPU 型号 | `name` | 非 NVIDIA（AMD/Apple/无 GPU）→ CUDA 不可用，H3（int8+cuda）无法运行，**fail 并说明** |
| 显存 | `memory.total` | `<24GB`：仍可装但速度/质量受限，主动降分辨率；`≥48GB`：可放宽优化与分辨率 |
| 驱动版本 | `driver_version` | **必须支持 CUDA 13.0**（torch cu130 运行时要求，见下） |
| 显存利用率 | `utilization.gpu` | 是否已被其它程序占满 |

系统内存：`(Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory` → `<32GB`：权重 offload 到 RAM 会挤，警告并建议优化。

> 若 GPU 非 NVIDIA 或驱动过老，**如实返回失败**并写清原因（`reason=`），不要硬装或给出能用假象。

## 关键版本事实（实测，务必遵守）

H3 量化算子依赖 CUDA 13 的优化算子；**torch 必须是 cu130 或更高**。实测：

- `torch 2.9.1+cu130`（torchvision 0.24.1+cu130、torchaudio 2.9.1+cu130）→ **正常跑通**，采样约 5s/it。
- `torch 2.6.0+cu124` → ComfyUI 日志 `comfy_kitchen backend cuda: {'available': True, 'disabled': True}`，**第一次 denoise forward 永久卡死**（GPU 100%、CPU 0、进度停在 `0%`，tqdm 计时却在跑）。这是最常见的「能启动但不出片」假象。
- 排查：若启动日志出现 `You need pytorch with cu130 or higher to use optimized CUDA operations` 或 `DynamicVRAM ... PyTorch 2.8+`，即 torch 太旧。

配套版本（实测可跑通）：`comfy-kitchen 0.2.31`、`comfy-aimdo 0.4.13`、`comfyui ~0.33`。

### 驱动与 CUDA 13

torch `cu130` wheel 自带 CUDA 13.0 运行时，但**要求 NVIDIA 驱动足够新**。安装后必须验证：

```powershell
& "ComfyUI\venv\Scripts\python.exe" -c "import torch; print(torch.cuda.is_available(), torch.version.cuda)"
```

- 打印 `True` → 继续（CUDA 13 可用）。
- 打印 `False` → **驱动太旧**，H3 无法跑优化的 CUDA 算子。此时：告知用户更新 NVIDIA 驱动（≥ 支持 CUDA 13.0 的版本），并 `ok=false reason=driver_too_old`，不要退回 cu124 重装（会回到卡死）。
- 顺带核对启动日志中 `comfy_kitchen backend cuda ... 'disabled': False`（未被禁用）。

## CUDA Python 探测（setup_env 自动，也可手动）

`setup_env.ps1` 依次取：`-CudaPython` 参数 → env `MT_H3_CUDA_PYTHON` → env `MT_MUSIC_CUDA_PYTHON` → 常见 conda（`ProgramData`/用户目录的 `miniconda3`/`anaconda3` 的 `envs\seg|torch|pytorch|cuda|base\python.exe`）→ PATH 中的 `python`/`python3`。用 `import torch; torch.cuda.is_available()` 验证，取第一个可用的，写入 `INSTALL_DIR\.cuda-python`。

## 目标

在 `INSTALL_DIR` 完成可运行后端：

- `ComfyUI\venv\Scripts\python.exe` 存在且 **venv 内** `torch.cuda.is_available()` 为真（**torch ≥ 2.9.1+cu130**）
- `import comfy_kitchen` 成功（torch 必须在 `ComfyUI\venv`，禁止 `--system-site-packages`）
- `ComfyUI\main.py` 存在
- 权重就绪（约 42–65GB；建议预留 ≥70GB）：
  - `models\diffusion_models\minimax_h3_fl2va_pruned_int8_convrot.safetensors`
  - `models\diffusion_models\minimax_h3_ref2va_pruned_int8_convrot.safetensors`（R2V）
  - `models\text_encoders\qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors`
  - `models\vae\minimax_h3_video_vae_fp16.safetensors` + `minimax_h3_audio_vae_fp32.safetensors`
  - 后处理：`models\upscale_models\RealESRGAN_x4plus.pth` + `custom_nodes\ComfyUI-Frame-Interpolation\ckpts\rife\rife47.pth`（供**独立后处理通道** `h3:postProcess` 用：视频超分 / 视频补帧节点；生成链不内联）
  - 后处理（可选）：`models\upscale_models\RealESRGAN_x2plus.pth` —— 超分节点选 **x2 倍率**时优先用它（中间张量只有 x4 的 1/4，峰值系统内存降一档）；**缺失不影响安装**，缺时用 x4 权重 + 输出端缩到 2 倍
  - `models\latent_upscale_models\` **必须至少 1 个文件**（南风节点把该 combo 声明为 `required`，空目录会让 ComfyUI 以 `value_not_in_list` 拒单）；`setup_env.ps1` 会补一个空占位 `h3_latent_upscaler_placeholder.safetensors`，不删不改真实模型
- custom_nodes：`ComfyUI-KJNodes`（含 Sage / VRAM_Debug / MiniMax LowVRAM / ChunkFFN）、`ComfyUI-Frame-Interpolation`（4K 补帧）、`ComfyUI-MiniMaxH3-TeaCache`（**脚手架仍克隆但推荐链已移除 TeaCache**，保留作可选）
- custom_nodes（本地随包，非 git 克隆）：`nanfeng_prompt_nodes_v10`（南风提示词 / H3 多参视频生成 V10 公开版，**已强制禁用二采**）——`setup_env.ps1` 的 `Deploy-LocalCustomNode` 从 `INSTALL_DIR\custom_nodes\nanfeng_prompt_nodes_v10` 部署到 `ComfyUI\custom_nodes\nanfeng_prompt_nodes_v10`；**必须保留其 `web/` 与 `*.api.py`**（`__init__.py` 的 `WEB_DIRECTORY="./web"` 指向它，`*.api.py` 注册后端路由；缺失会让插件注册/前端加载报错）。MTNode 只走 `POST /prompt`，不加载其前端界面
- `python -m app` 健康检查退出码 0（见「冒烟与健康检查」）
- **不要在本 skill 中启动 ComfyUI**

## 显存最佳实践

官方/社区在 24GB 上稳定跑通依赖：**量化权重 + 注意力加速 + 步间缓存 + 采样后卸模型再 VAE**。整机建议 **≥32GB 系统内存**（权重会 offload 到 RAM）。

### 启动参数（脚手架 `scripts\start_backend.cmd` 默认，插件可关）

```
python main.py --listen 127.0.0.1 --port 8188
  --disable-pinned-memory
  --fp16-intermediates
  --reserve-vram 4
  --cache-ram 8 4
```

环境变量 `PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True`。插件侧 `--disable-pinned-memory`/`--fp16-intermediates` 默认开启、`--reserve-vram` 档位可配置（关闭/调整后按本表仍应保持 VAE 在 GPU）。

> **`--cache-ram` 是「系统内存（RAM）被跑满、显存反而空着」那类故障的正解，别省**：ComfyUI 默认按
> 「非活跃阈值 = 100% 内存（最高 128G）」保留节点产物，而**超分 / 补帧链的峰值本来就在 RAM**——
> 整段视频的帧张量（外加 float32 副本）攒在系统内存里逐帧过 GPU，峰值 ≈ 源像素 × 16（x4 中间张量）× 帧数。
> `--cache-ram 8 4` = 活跃 / 非活跃两个保留下限（GB），内存吃紧时才释放缓存产物。插件侧默认开、档位可配置
> （【系统内存缓存保留下限】，置 0 = 不加该参数）。超分提交前插件还会按容器里的真实帧数估峰值，
> 超预算先压目标长边、仍放不下就**进超分前预缩放源帧**（控制台会写明取舍）——排查这类问题先看那条日志。

> **`--cpu-vae` 默认关闭，并且不要打开**（脚手架 `start_backend.cmd` 不带它；H3 后端设置里的「CPU VAE」开关同样按关闭口径处理，若发现自己环境启动参数里有它，一律关掉再复测）。**开启必致 dtype 崩**：VideoVAE 解码报 `expected m1 and m2 to have the same dtype, but got: float != struct c10::Half` —— 采样跑得完、解码阶段挂掉；**南风链（`nanfeng_prompt_nodes_v10`）在 CPU VAE 下直接不可用**。所以见到这条 dtype 报错，第一件事是核对插件 Console 的 `[launch] flags=…` 里**有没有** `--cpu-vae`，而不是去改工作流的 VAE 组合。
> 显存峰值靠下面的 `VRAM_Debug` 屏障（先卸 DiT 再解码）压，不靠把 VAE 搬到 CPU。
> `--disable-pinned-memory` 与 `--lowvram` 同开冲突；不要用 `--lowvram`。

### 工作流节点（MTNode 默认启用，节点设置可关）

| 优化 | 作用 | 节点 |
|------|------|------|
| EasyCache | 原生步跳过缓存（约 1.4–2× 采样段） | `EasyCache`（**reuse 0.08 / start 0.30 / end 0.90**，见下「EasyCache 档位口径」） |
| Sage Attention | 注意力加速（有包用 `auto`；无包则跳过） | `PathchSageAttentionKJ` |
| Low VRAM Attention | 按 head 分块降峰值显存 | `MiniMaxLowVRAMAttention` |
| Chunk FeedForward | FFN 分块降峰值 | `MiniMaxChunkFeedForward` |
| **VRAM Barrier** | 采样后 `unload_all_models` + empty_cache，**避免双 VAE 解码 OOM（必开）** | `VRAM_Debug` |

推荐模型链：`UNET → EasyCache → SigmaShift → LowVRAMAttn → ChunkFFN → Sage → Guider`（TeaCache 已移除）
采样输出**必须**经 `VRAM_Debug`（`unload_all_models=true`）后再 `VAEDecode` / `VAEDecodeAudio`。**缺失该屏障 → 解码在 24G 上卡死**（DiT 19.9G + VideoVAE 4.9G 超 24G）。

#### EasyCache 档位口径（H3 不是图像模型，别照抄节点默认值）

- **本 skill 只给结论与判据，数值真源在 `h3/main-h3.js` 的 `EASY_SAFE`**（下发前把用户自定义值夹进该区间）。修环境 / 改图时**不要**把档位改回官方默认，那会把「一开就废」的档放回去。
- **质量安全档：`reuse_threshold=0.08` / `start_percent=0.30` / `end_percent=0.90`**（夹取区间 reuse 0.01–0.2、start 0.15–0.6、end 0.6–1.0；三个值都是越小 / 越晚 = 越保真、越不加速）。
- **为什么不用 ComfyUI `EasyCache` 节点自带的 0.2 / 0.15 / 0.95**：那套是按几十步的图像模型调的；H3 内置生成链只有 **20 步**（官方 template 靠 turbo LoRA 压到 4–8 步、根本不用 EasyCache）。起点 0.15 → 第 3 步就进缓存，reuse 额度 0.2 又够大 → **第 3 步起大段步骤直接复用上一版输出**，表现为跳步 / 画面漂移。
- 实测判据（864×480 / 20 步 / 同种子，与「关缓存」对比）：官方默认 0.2/0.15/0.95 → 逐帧差异 mean 0.0385、max 0.1323，相邻帧抖动 mean 0.0119（关缓存 0.0092），画面明显跳变；**0.08/0.30/0.90 → 差异 mean 0.004、抖动与关缓存基本一致，同时仍实打实跳步（有加速收益）**。
- 因此用户报「开了 EasyCache 画质明显下降 / 画面在跳」时：**先看节点上三个数有没有落回官方默认**（插件 Console / 生成的 workflow JSON 里 `EasyCache.inputs`），再考虑关缓存或降档；这不是节点开关坏了，也不该为此重装环境。

### 24G 分辨率红线（超限是**自动钳制**，不是故障）

内置生成链按 24G（4090 实测）钉两条硬上限，真源在 `h3/main-h3.js` 的 `VRAM_SAFE_MAX_DIM` / `VRAM_SAFE_MAX_MP`：

- **长边 ≤ 1280px**、**面积 ≤ 0.98MP**（≈1280×768）；超限时等比钳制（先限长边再缩到面积达标，结果按 32 对齐并取偶），并在插件 Console 打印 `[generate] 分辨率超 24G 安全上限，钳制为 WxH`。
- **看到这条日志不要判为环境坏了**，也不要为了让它「不钳制」把尺寸改回 `1344×768` —— 实测 **1344×768 必卡死**，所以内置 16:9 默认档已是 `1280×704`（9:16 = 704×1280、1:1 = 768×768、4:3 = 1024×768、3:4 = 768×1024、21:9 = 1280×544）。
- `outputRes` 档位：`auto` = 用上面的比例默认档；`480p` / `720p` / `1080p` = 按比例把**短边**对齐到目标值（同样 32 对齐、取偶）。**先按档位算尺寸，再过红线**，所以 `1080p` 在 16:9 下必然被钳到长边 1280 以内 —— 这是保护，不是没生效。
- **自建 ComfyUI 工作流分支不做 24G 钳制**，也不读 `duration` / `outputRes` / 后处理字段（尺寸由那张图自己决定）；那条链超限真 OOM 时，别指望宿主兜底。

### 分辨率/时长提示（按显存）

- 冒烟：约 864×480、5s、8~20 steps（24G 下 5.2s/it，8 步约 41s）
- 生产常用：约 0.6–0.8MP（如 1056×608）；再高会撞上上面的红线被钳制
- `<24GB`：降到 ~0.3–0.5MP、≤5s；`≥48GB`：可放宽（红线是插件侧 24G 口径，高显存机器同样会被钳到 1280 / 0.98MP）。时长越长 token 越多，越易 OOM——优先开 LowVRAM / ChunkFFN / VRAM Barrier

### 可选依赖：Sage Attention（注意力加速 · 约 1.5–2× 提速）

Windows 上 **两个包必须成对**：`sageattention` 的 `core` 在 **import 期**就 `from .triton.…` 拉 Triton kernel，而 PyPI 的 `triton` 只有 Linux 轮子 —— 只装 sageattention 不装 triton-windows，`import sageattention` 一样失败。

1. `triton-windows`（PyPI 有；大版本跟着 torch 自带 triton 走：torch 2.6→3.2 / 2.7→3.3 / 2.8→3.4 / **2.9→3.5** / 2.10→3.6）

   ```powershell
   & "ComfyUI\venv\Scripts\python.exe" -m pip install --isolated "triton-windows==3.5.*"
   ```

2. `sageattention` 2.x **预编译 wheel**：PyPI 上只有老的 1.0.6（v1，且要现场编译），2.x 只能从 <https://github.com/woct0rdho/SageAttention/releases> 按本机组合挑轮子。文件名三段都要对上：
   - `cuNNN`：**CUDA 大版本**必须一致（cu130 与 cu128 不通用）
   - `torchX.Y[.Z][andhigher]`：优先精确同 minor；其次 `andhigher` 且 ≤ 本机 torch
   - `cpX-abi3`：稳定 ABI，支持 Python ≥ X（本机 3.10 → `cp39-abi3` / `cp310-abi3` 可用；老的非 abi3 轮子 `cpNN-cpNN` 必须精确同 minor）

   例（实测组合 Python 3.10.16 + torch 2.9.1+cu130 + RTX 4090/sm89）：`sageattention-2.2.0+cu130torch2.9.1.post6-cp310-abi3-win_amd64.whl`

   ```powershell
   & "ComfyUI\venv\Scripts\python.exe" -m pip install --isolated --no-deps --force-reinstall "<下载好的 .whl>"
   ```

3. 自检（**装完必做**，MTNode 的 H3 插件按同一口径判定）：

   ```powershell
   & "ComfyUI\venv\Scripts\python.exe" -c "import triton, sageattention, torch; print('triton', triton.__version__, 'sm', 'sm%d%d' % torch.cuda.get_device_capability(0))"
   ```

   再小跑一次 kernel（能 import ≠ 能算：缺对应架构的 `_qattn_sm89.pyd` 时是调用期才炸）：

   ```powershell
   & "ComfyUI\venv\Scripts\python.exe" -c "import torch; from sageattention import sageattn; q=torch.randn(1,2,128,64,device='cuda',dtype=torch.float16); o=sageattn(q,q,q,tensor_layout='NHD'); torch.cuda.synchronize(); print('sage ok', bool(torch.isfinite(o.float()).all().item()))"
   ```

- **装不上就跳过，不判失败**：MTNode 每次生成前自检，缺包自动不带 `PathchSageAttentionKJ`（只慢一点，不影响出片）。判错反而更糟——包在但不可用时，KJNodes 那个节点会直接把 `/prompt` 打到 `prompt_outputs_failed_validation`。
- 画质提示：`auto` 在 sm89 走 `sageattn_qk_int8_pv_fp8_cuda(pv_accum_dtype="fp32+fp16")`。个别模型（Wan / Qwen-Image 一类）中间值会量化溢出出黑图/噪点；真遇到就把 Sage 关掉（其它优化仍然有效）。

## 冒烟与健康检查（步骤 7 必做）

1. 基础冒烟（venv 内）：
   ```powershell
   & "ComfyUI\venv\Scripts\python.exe" -c "import torch, torchvision, torchaudio; assert torch.cuda.is_available(); assert torch.__version__.startswith('2.9.1') and 'cu130' in torch.__version__; import comfy_kitchen; print('ok')"
   ```
2. **权威健康检查**：`INSTALL_DIR` 下运行 `python -m app`（复用 venv 外探测到的 CUDA Python 亦可）：
   ```powershell
   .\.venv\Scripts\python.exe -m app   # 若 app/ 已随脚手架复制；无 venv 时用基座 Python
   ```
   打印 JSON：`{comfy_main, venv, models:{fl2va, ref2va, clip, vae_video, vae_audio}, postModels:{realesrgan_x4plus, rife47}, cuda}`；**退出码 0** 当 `comfy_main`+`venv`+`fl2va`+`clip` 均就绪且 >1MB。自修复/安装完成判定以此为准。
3. 确认模型文件非空（>1MB）；确认 `custom_nodes\ComfyUI-Frame-Interpolation\ckpts\rife\rife47.pth` 非空。
4. **南风节点包自检**（不启动 ComfyUI）：确认 `custom_nodes\nanfeng_prompt_nodes_v10\` 已部署且关键文件齐全，并确认 venv 内依赖可导入：
   ```powershell
   $p = "ComfyUI\custom_nodes\nanfeng_prompt_nodes_v10"
   foreach ($f in @("__init__.py","nodes.py","h3_generator.py","storyboard_api.py",
                    "audio_drive_api.py","audio_media_api.py","model_refresh_api.py",
                    "web\nanfeng_prompt.js","web\h3_multiref.js")) {
       if (-not (Test-Path (Join-Path $p $f))) { throw "nanfeng package missing: $f" }
   }
   & "ComfyUI\venv\Scripts\python.exe" -c "import soundfile, numpy, aiohttp; print('nanfeng deps ok', soundfile.__version__)"
   ```
   缺 `soundfile` 时音频节点（`audio_media_api.py`）会在运行期报错，补装：`& "ComfyUI\venv\Scripts\python.exe" -m pip install --isolated soundfile`（`numpy` / `aiohttp` 已由 ComfyUI 自身 requirements 提供，不重复装）。
5. **`latent_upscale_models` 非空自检**（南风节点 combo 是 `required`，空列表会被 ComfyUI 以 `value_not_in_list` 拒单，`/prompt` 直接失败）：
   ```powershell
   Get-ChildItem -File "ComfyUI\models\latent_upscale_models" | Select-Object Name, Length
   (Get-ChildItem -File "ComfyUI\models\latent_upscale_models").Count   # 必须 ≥ 1
   ```
   `setup_env.ps1` 的 `Ensure-LatentUpscalePlaceholder` 会幂等补一个 10 字节合法空 safetensors（`h3_latent_upscaler_placeholder.safetensors`，0 张量）保证列表非空；**已有真实 H3 放大模型时不删不改**，只补这一个占位文件。计数为 0 才需要处理。

## 已知故障摘要

### sageattention 缺失（最常见的「不是故障」）

日志：`No module named 'sageattention'`；MTNode 插件 Console：`sageattention missing → sageMode=disabled`。
含义：**没装加速包，生成会自动跳过 Sage 这一档优化**（EasyCache / LowVRAM / ChunkFFN / VRAM Barrier 照常，只是慢约 1.5–2×），不是报错，别为此重装环境。
要提速按「可选依赖：Sage Attention」一节成对装 `triton-windows` + 匹配的 `sageattention` 预编译 wheel；MTNode 侧用户可在 H3 插件窗点「Sage 加速」一键补装（宿主自己挑轮子并在装完自检）。
判据必须同时看 triton 与 sageattention：只装其中一个，`import sageattention` 照样失败。

### torch<cu130 卡死（最常见）

日志：`You need pytorch with cu130 or higher to use optimized CUDA operations` / `comfy_kitchen backend cuda ... 'disabled': True` / 采样停在 `0%` 但计时在跑。**升级到 ≥2.9.1+cu130**，勿用 cu124/cu126。

### comfy_kitchen + `list[int]` infer_schema

隔离 venv + venv 内 CUDA torch；跑 `scripts\repair_torch_kitchen.ps1` 与 `patch_comfy_kitchen_typing.py`。禁止 `--system-site-packages`。

### 采样完成但 VAE 卡住 / OOM

在 sampler 与 VAE 之间加 `VRAM_Debug`（`unload_all_models=true`）。确认启动带 `--disable-pinned-memory`。**不要用 `--cpu-vae`**（默认就关着，开着必 dtype 崩，见「启动参数」）。

### 第二段起画面漂移 / 越往后画质越差（分段衔接）

**先确认这不是环境故障**（权重、torch、驱动都可能是好的）。按顺序查：

1. **衔接到底有没有生效**：插件 Console 应出现 `[generate] chain source → input/<file>`。若是 `衔接视频不存在，已跳过段间引导：…`，说明上一段成片路径没接到本段 **↩ 上一段视频** 端子（或文件被删/路径变了）——本段等于全新起头，画面自然对不上。
2. **首帧是否把锚顶掉了**（仅 `fl2va`）：`MiniMaxH3ImageToVideo.first_frame` 只认一个来源，**用户自备首帧优先于衔接锚定帧**。第 2 段还手填首帧 → 衔接帧只是构图锚、不起定位作用，把它清空让衔接帧兜底。`r2v` 没有 `first_frame`：衔接占的是 `ref_video_k`，先看 Console 里「分段衔接：…占用 V几」那行有没有出现。
3. **重绘幅度停在 1**（纯引导）：段数一多会逐段劣化（背景涂抹感、人物饱和度漂移）。把 `chainDenoise` 调到 **0.3–0.6**（引导加重绘，重置画面状态）。
4. **引导帧数太少**：`chainFrames` 默认 22，上一段结尾动作快 / 变化大时锚不住，可提到 32–48（上限 60）。
5. **提示词没接上上一段结尾**：角色 / 场景描述必须与上一段保持一致，动作要写清从上一段末帧继续。
6. **排除 EasyCache 干扰**：档位若被改回官方默认 0.2/0.15/0.95，多段叠加时跳变更明显——按「EasyCache 档位口径」回到 0.08/0.30/0.90，或先关缓存（`optEasyCache=false`）复测一次再下结论。

### 「生成完没有 4K / 没有补帧」——设计如此，别改回去

内置生成链**只出原生分辨率片**，超分 / 补帧已从生成里拆走、走独立通道 `h3:postProcess`（画布上单独的 **视频超分 / 视频补帧** 节点）。**不要**在生成图里重新内联 `VHS_VideoCombine` 或把后处理串回采样链后面——那会恢复 24G 上必爆的双模型同驻峰值。要 4K 就在 H3 节点后串 **视频超分**（`per_batch=1` 安全档）→ 需要高帧率再串 **视频补帧**（2x；要 4x 就串两个 2x）。

### 本次已修：`unexpected keyword argument 'ref_image_0'`

若 ComfyUI 的 `MiniMaxH3ReferenceToVideo` 是较新版本（用 `io.Autogrow` 嵌套 `ref_images`），而插件/前端仍发扁平键 `ref_image_0`，会抛 `TypeError: ...unexpected keyword argument 'ref_image_0'`（插件包装为 `comfy_execution_error`）。修复：给该节点 `execute` 加 `**legacy_refs` 并把扁平键折回嵌套 dict（`scripts\patch_h3_autogrow_refs.py` 幂等）：

```python
def execute(cls, clip, vae, audio_vae, prompt, width, height, length, ref_image_size="match",
            ref_images=None, ref_videos=None, ref_video_audios=None, ref_audios=None, **legacy_refs):
    def fold_flat(prefix, base):
        folded = dict(base or {})
        for name in [k for k in legacy_refs if k.startswith(prefix)]:
            folded[name] = legacy_refs.pop(name)
        return folded
    ref_video_audios = fold_flat("ref_video_audio_", ref_video_audios)
    ref_videos = fold_flat("ref_video_", ref_videos)
    ref_images = fold_flat("ref_image_", ref_images)
    ref_audios = fold_flat("ref_audio_", ref_audios)
    ...
```

## 插件侧 ComfyUI 契约（修复/排查时参考）

- 插件以 `GET http://127.0.0.1:8188/system_stats` 探测 ComfyUI 存活
- 任务提交 `POST /prompt`（`{prompt: <workflow>, client_id}`），轮询 `GET /history/{prompt_id}` 取输出
- 参考图/视频/音频经 `POST /upload/image` 上传（表单字段 `image`）
- 工作流节点输入（扁平键）：FL2VA `MiniMaxH3ImageToVideo`（prompt/width/height/length/ref_image_size + 首/末帧图）；R2V `MiniMaxH3ReferenceToVideo`（`ref_image_0..8`、`ref_video_0..2`、`ref_video_audio_0..2`、`ref_audio_0..2`）——即上面 legacy_refs 补丁要兼容的键
- **内置的分段衔接子图**（长视频无缝衔接；**内置 `fl2va` 与 `r2v` 都生效**，自建工作流不下发）：入参 `chainVideoPath`（上一段成片绝对路径）+ `chainFrames`（段间引导帧数，1–60，默认 **22**）+ `chainDenoise`（引导重绘幅度 0–1，默认 **1**）。公共子图：
  `LoadVideo(file=input 目录里的文件名)` → `GetVideoComponents` → `ImageFromBatch(batch_index=-chainFrames, length=chainFrames)`（取上一段**末尾 N 帧**，batch_index 负数 = 从末尾倒数）
  - **FL2VA**：再 `ImageFromBatch(batch_index=-1, length=1)`（= 窗口最后一帧，即**锚定首帧**）；该锚定帧只在**用户没自备首帧**时接给 `MiniMaxH3ImageToVideo.first_frame`，接了首帧则以用户首帧为准（锚定帧不覆盖）
  - **R2V**：`MiniMaxH3ReferenceToVideo` 没有 `first_frame`，锚只能是**一路参考视频**——上面那 N 帧的 IMAGE 输出直接当 `ref_video_k`（官方 `<Video N>` 语义含 *video continuation* / 续写起点）。参考视频**硬上限 3 路**（`ref_video_0..2`）：没连满时追加为最后一路，连满时**顶掉 `ref_video_2`（V3）**并把被顶掉那条的 `LoadVideo`/`GetVideoComponents` 从图里摘掉；占用情况写进 `[generate]` 日志，不静默丢。衔接这一路**不带** `ref_video_audio_k`（窗口只有 N 帧，配整段音轨会音画长度不匹配）
  - `chainDenoise ∈ (0,1)` 时它落到 `BasicScheduler.denoise` = **引导加重绘**（对引导区域重绘、重置画面状态）；`0` = 纯引导，`1` = 沿用全局 denoise —— 两种模式同一条判据
  - 上一段视频经同一个 `POST /upload/image`（表单字段一律 `image`、`type=input`、`overwrite=true`；宿主侧 `kind` 只分类不改字段）登记进 `ComfyUI/input`（`LoadVideo` 只认该目录的文件名）；文件不存在只记日志 `[generate] 衔接视频不存在，已跳过段间引导：…` 并照常生成本段（**不是故障**）
- **超分 / 补帧是独立后处理通道，不内联进生成链**：内置生成链末端只有 `CreateVideo` + `SaveVideo`（**不再挂 `VHS_VideoCombine`**，也不在生成任务里串跑后处理）；老画布残留的 `postEnabled` / `postInterp*` 字段一律忽略、不报错
- 后处理经 IPC **`h3:postProcess`** 单独提交（对应画布上的 **视频超分 / 视频补帧** 节点，可串联 `H3 → 视频超分 → 视频补帧`），图：
  `LoadVideo` → `GetVideoComponents`（输出 0 = 帧、1 = 音轨）→ 超分 `UpscaleModelLoader` + `ImageUpscaleWithModelBatched`（`per_batch`，**24G 安全档 = 1 逐帧**；「低显存安全档」强制 1）→ 可选 `ImageScale` 到目标长边（默认 3840 = 4K）；补帧 `RIFE VFI`（`ckpt_name=rife47.pth`、`batch_size=1` + `clear_cache_after_n_frames` 极小、fps 按倍数重算）→ `CreateVideo`（音轨原样带回）→ `SaveVideo`（`filename_prefix video/MiniMax_H3_post_*`）
  - 提交前后各调一次 `POST /free` 释放生成模型（DiT / VAE）以压低峰值；命中 OOM 报错签名时后端**自动降一档重试一次**
  - `UpscaleModelLoader.model_name` 是 combo，值**必须带扩展名**（`RealESRGAN_x4plus.pth`）；老节点存的不带扩展名会被判 `value_not_in_list` 拒图
  - **超分倍率 x2 / x4**：节点参数 `scale`（2 / 4，缺省 4）。输出长边 = min(目标长边, 源长边 × 倍率)；x2 时后端先在本机 `upscale_models` 里找原生 x2 权重（找到就用，**中间张量少 4 倍**），没有就用 x4 权重超分后由末端 `ImageScale` 缩到 2 倍（能跑，但峰值内存仍按 x4 口径估算）
  - 后处理与生成共用全局音视频互斥锁（同一时刻只 1 个任务），并复用 `activeGenerate` 取消与 `/history` 轮询口径

## 步骤（全新安装）

1. **硬件探测**（见上）。GPU 非 NVIDIA / 驱动不支持 CUDA 13 → fail 并写 reason。
2. 从 `SCAFFOLD_REF` 准备 `app/` / `scripts/` / `requirements.txt` / `custom_nodes/nanfeng_prompt_nodes_v10/`（保留已有 ComfyUI/models/output）；或用内置脚本。
3. 探测 CUDA Python → 写 `.cuda-python`（仅作 venv 基座；优先 `MT_H3_CUDA_PYTHON`）。
4. `.\scripts\setup_env.ps1`：隔离 venv（**禁 `--system-site-packages`**）、装 **cu130** torch（torchvision/torchaudio 匹配）、ComfyUI 依赖（含 `soundfile`，见 `requirements.txt`）、KJNodes + ComfyUI-Frame-Interpolation（4K 补帧）+ ComfyUI-MiniMaxH3-TeaCache（备用），并把随包本地节点包 **`nanfeng_prompt_nodes_v10`** 部署到 `ComfyUI\custom_nodes\`（`Deploy-LocalCustomNode`，幂等；只补该包，**不清空 custom_nodes**）。
   - 装完**必须**校验 `torch.cuda.is_available()` 为真且日志里 cuda backend 未被禁用；否则按「驱动太旧」处理。
   - pip 用 `--isolated` 避开坏掉的 `pypi.ngc.nvidia.com` extra-index（否则 DNS 反复重试，下载几乎不前进）。
5. 按需静默给 `nodes_minimax_h3.py` 加 `**legacy_refs` 折叠（幂等，见上）；如需，补 `polyfill`。
6. `.\scripts\download_models.ps1`（优先 ModelScope `Comfy-Org/MiniMax-H3`，再 HuggingFace）；脚本还会拉 **RealESRGAN_x4plus.pth → models/upscale_models/** 与 **rife47.pth → custom_nodes/ComfyUI-Frame-Interpolation/ckpts/rife/**（这两个只服务**独立后处理通道** `h3:postProcess`（视频超分 / 视频补帧节点），生成链不再内联后处理）；另外**尝试**拉可选的 **RealESRGAN_x2plus.pth → models/upscale_models/**（超分 x2 倍率的原生权重；拉不到只 warn，不中断安装）；已存在 >1MB 的文件自动跳过。
7. 冒烟 + `python -m app` 健康检查（见「冒烟与健康检查」）。

## 自我修复模式（dsh）

把 CONSOLE 交给 Agent：**自行根据最近失败焦点分析并修复**；已知故障仅在证据匹配时参考。模型已齐勿重下。勿启动 ComfyUI；勿删 output。

**不要把「档位」当故障修**：EasyCache `0.08/0.30/0.90`、24G 红线钳制（Console 打 `分辨率超 24G 安全上限，钳制为 WxH`）、`--cpu-vae` 关闭、生成链不含超分/补帧——这四样都是实测安全档，真源在 `h3/main-h3.js`（`EASY_SAFE` / `VRAM_SAFE_MAX_DIM` / `VRAM_SAFE_MAX_MP` / `POST_SAFE_DEFAULTS`）。把它们改回「官方默认」或「一次性出 4K」正是历史上的坏档，改回去会让用户重新踩坑；只有用户明确要求实验时才临时改，并在结论里说明偏离了安全档。

## 约束

- 不启动 ComfyUI；不删 `ComfyUI\output\` / `output\`
- 磁盘远小于 70GB 时先警告；确认驱动是否支持 CUDA 13（不支持则 fail，勿用 cu124 充数）
- 已有完整布局只补缺失，勿整体重装
- **禁止** `--system-site-packages` 的 ComfyUI venv
- 无 NVIDIA GPU / 显存极端不足 → 如实失败并说明，不硬装

## 成功标准

- `.install-ok`；`.h3-agent-result` 写 `ok=true`（失败 `ok=false` + `reason=`）
- `python -m app` 健康检查退出码 0（`comfy_main`+`venv`+`fl2va`+`clip` 就绪）
- 回复：`install_ok=1`、`gpu=`（name+VRAM+driver）、`cuda_python=`、`venv_ok=`、`comfy_ok=`、`models_ok=`、`cuda_available=`、`torch_version=`（含 `ComfyUI\venv`，须 `≥2.9.1+cu130`）、`cuda_backend_enabled=`（日志中未被告示 disabled）
