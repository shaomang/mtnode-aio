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
  - 后处理：`models\upscale_models\RealESRGAN_x4plus.pth` + `custom_nodes\ComfyUI-Frame-Interpolation\ckpts\rife\rife47.pth`（4K 超分补帧）
- custom_nodes：`ComfyUI-KJNodes`（含 Sage / VRAM_Debug / MiniMax LowVRAM / ChunkFFN）、`ComfyUI-Frame-Interpolation`（4K 补帧）、`ComfyUI-MiniMaxH3-TeaCache`（**脚手架仍克隆但推荐链已移除 TeaCache**，保留作可选）
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
```

环境变量 `PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True`。插件侧 `--disable-pinned-memory`/`--fp16-intermediates` 默认开启、`--reserve-vram` 档位可配置（关闭/调整后按本表仍应保持 VAE 在 GPU）。

> **警告**：**不要启用 `--cpu-vae`**。实测它会让 VideoVAE 解码报 dtype 错：`expected m1 and m2 to have the same dtype, but got: float != struct c10::Half`。VAE 解码请保持在 GPU，用下面的 `VRAM_Debug` 屏障先卸模型。
> `--disable-pinned-memory` 与 `--lowvram` 同开冲突；不要用 `--lowvram`。

### 工作流节点（MTNode 默认启用，节点设置可关）

| 优化 | 作用 | 节点 |
|------|------|------|
| EasyCache | 原生步跳过缓存（约 1.4–2× 采样段） | `EasyCache`（reuse≈0.2, start≈0.15, end≈0.95） |
| Sage Attention | 注意力加速（有包用 `auto`；无包则跳过） | `PathchSageAttentionKJ` |
| Low VRAM Attention | 按 head 分块降峰值显存 | `MiniMaxLowVRAMAttention` |
| Chunk FeedForward | FFN 分块降峰值 | `MiniMaxChunkFeedForward` |
| **VRAM Barrier** | 采样后 `unload_all_models` + empty_cache，**避免双 VAE 解码 OOM（必开）** | `VRAM_Debug` |

推荐模型链：`UNET → EasyCache → SigmaShift → LowVRAMAttn → ChunkFFN → Sage → Guider`（TeaCache 已移除）
采样输出**必须**经 `VRAM_Debug`（`unload_all_models=true`）后再 `VAEDecode` / `VAEDecodeAudio`。**缺失该屏障 → 解码在 24G 上卡死**（DiT 19.9G + VideoVAE 4.9G 超 24G）。

### 分辨率/时长提示（按显存）

- 冒烟：约 864×480、5s、8~20 steps（24G 下 5.2s/it，8 步约 41s）
- 生产常用：约 0.6–0.8MP（如 1056×608）；原生 ~1MP 更吃显存/时间（插件默认 1344×768）
- `<24GB`：降到 ~0.3–0.5MP、≤5s；`≥48GB`：可放宽。时长越长 token 越多，越易 OOM——优先开 LowVRAM / ChunkFFN / VRAM Barrier

### 可选依赖

- Windows：`triton-windows` + 匹配 torch/CUDA 的 `sageattention` wheel（装不上则禁用 Sage，其它优化仍有效）。**必须与 torch 版本（cu130）匹配。**

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

## 已知故障摘要

### sageattention 缺失

日志：`No module named 'sageattention'`。装匹配 wheel，或关闭 Sage（保留其它优化）。

### torch<cu130 卡死（最常见）

日志：`You need pytorch with cu130 or higher to use optimized CUDA operations` / `comfy_kitchen backend cuda ... 'disabled': True` / 采样停在 `0%` 但计时在跑。**升级到 ≥2.9.1+cu130**，勿用 cu124/cu126。

### comfy_kitchen + `list[int]` infer_schema

隔离 venv + venv 内 CUDA torch；跑 `scripts\repair_torch_kitchen.ps1` 与 `patch_comfy_kitchen_typing.py`。禁止 `--system-site-packages`。

### 采样完成但 VAE 卡住 / OOM

在 sampler 与 VAE 之间加 `VRAM_Debug`（`unload_all_models=true`）。确认启动带 `--disable-pinned-memory`。**不要用 `--cpu-vae`（dtype 错）。**

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
- 4K 超分补帧后处理在生成图上再接 `GetVideoComponents` → 超分/补帧 → `VHS_VideoCombine`（`filename_prefix video/MiniMax_H3_post`）

## 步骤（全新安装）

1. **硬件探测**（见上）。GPU 非 NVIDIA / 驱动不支持 CUDA 13 → fail 并写 reason。
2. 从 `SCAFFOLD_REF` 准备 `app/` / `scripts/` / `requirements.txt`（保留已有 ComfyUI/models/output）；或用内置脚本。
3. 探测 CUDA Python → 写 `.cuda-python`（仅作 venv 基座；优先 `MT_H3_CUDA_PYTHON`）。
4. `.\scripts\setup_env.ps1`：隔离 venv（**禁 `--system-site-packages`**）、装 **cu130** torch（torchvision/torchaudio 匹配）、ComfyUI 依赖、KJNodes + ComfyUI-Frame-Interpolation（4K 补帧）+ ComfyUI-MiniMaxH3-TeaCache（备用）。
   - 装完**必须**校验 `torch.cuda.is_available()` 为真且日志里 cuda backend 未被禁用；否则按「驱动太旧」处理。
   - pip 用 `--isolated` 避开坏掉的 `pypi.ngc.nvidia.com` extra-index（否则 DNS 反复重试，下载几乎不前进）。
5. 按需静默给 `nodes_minimax_h3.py` 加 `**legacy_refs` 折叠（幂等，见上）；如需，补 `polyfill`。
6. `.\scripts\download_models.ps1`（优先 ModelScope `Comfy-Org/MiniMax-H3`，再 HuggingFace）；脚本还会拉 **RealESRGAN_x4plus.pth → models/upscale_models/** 与 **rife47.pth → custom_nodes/ComfyUI-Frame-Interpolation/ckpts/rife/**（4K 超分补帧后处理权重）；已存在 >1MB 的文件自动跳过。
7. 冒烟 + `python -m app` 健康检查（见「冒烟与健康检查」）。

## 自我修复模式（dsh）

把 CONSOLE 交给 Agent：**自行根据最近失败焦点分析并修复**；已知故障仅在证据匹配时参考。模型已齐勿重下。勿启动 ComfyUI；勿删 output。

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
