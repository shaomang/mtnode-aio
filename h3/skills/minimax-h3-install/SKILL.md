---
name: minimax-h3-install
title: MiniMax H3 本地安装
description: 在用户指定目录安装 MiniMax H3（24G ComfyUI）后端：探测 GPU/驱动/显存，建隔离 venv、装 CUDA torch(cu130)、依赖、模型、冒烟；含自我修复与显存最佳实践。
---

# MiniMax H3 本地安装

当用户或 MTNode 插件要求在某目录安装 / **自我修复** **MiniMax H3（本地 ComfyUI 视频生成）** 时使用本 skill。

插件调用时：

- **当前工作区就是 `INSTALL_DIR`**，可直接读写并执行命令
- **`SCAFFOLD_REF`（或 `.scaffold-ref`）仅作参考**：内置脚手架/脚本是示例实现，不是已完成的安装
- 不要假设插件已替你复制好脚手架
- 若任务附带 **CONSOLE_LOG**，以「最近失败焦点」为准自行分析修复（每人环境不同）
- **先做硬件探测，再决定装什么/怎么装**（不同 GPU/驱动/显存差异很大，见下）

## 国内镜像（必须）

> **中国大陆网络下，以下镜像必须使用**：HuggingFace 无法直连，Python 库必须走清华/中科院镜像。

- pip：**清华** `https://pypi.tuna.tsinghua.edu.cn/simple`（或**中科院 USTC** `https://mirrors.ustc.edu.cn/pypi/simple/`、阿里云 `https://mirrors.aliyun.com/pypi/simple/`）；可用 `MT_H3_PIP_INDEX` 覆盖；pip 一律加 `--isolated`（避开坏掉的 `pypi.ngc.nvidia.com` extra-index）
- torch cu130：优先官方 `https://download.pytorch.org/whl/cu130`，失败回退阿里云 `https://mirrors.aliyun.com/pytorch-wheels/cu130`（`MT_H3_TORCH_INDEX` 可覆盖）
- 模型权重（HuggingFace 无法直连）：**优先 ModelScope(魔搭)** `Comfy-Org/MiniMax-H3`（国内直连），失败才回退 hf-mirror（`HF_ENDPOINT=https://hf-mirror.com`，`HF_HUB_DISABLE_XET=1`）
- GitHub（ComfyUI / KJNodes / TeaCache 克隆）：直连失败用 `ghproxy.com` 前缀镜像
- 安装示例：
  ```powershell
  .\scripts\setup_env.ps1   # 内部 pip 默认走清华镜像
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
- custom_nodes：`ComfyUI-MiniMaxH3-TeaCache`、`ComfyUI-KJNodes`（含 Sage / VRAM_Debug / MiniMax LowVRAM / ChunkFFN）
- **不要在本 skill 中启动 ComfyUI**

## 显存最佳实践

官方/社区在 24GB 上稳定跑通依赖：**量化权重 + 注意力加速 + 步间缓存 + 采样后卸模型再 VAE**。整机建议 **≥32GB 系统内存**（权重会 offload 到 RAM）。

### 启动参数（插件默认开启，可关）

```
python main.py --listen 127.0.0.1 --port 8188
  --disable-pinned-memory
  --fp16-intermediates
  --reserve-vram 4
```

环境变量 `PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True`。

> **警告**：**不要启用 `--cpu-vae`**。实测它会让 VideoVAE 解码报 dtype 错：`expected m1 and m2 to have the same dtype, but got: float != struct c10::Half`。VAE 解码请保持在 GPU，用下面的 `VRAM_Debug` 屏障先卸模型。
> `--disable-pinned-memory` 与 `--lowvram` 同开冲突；不要用 `--lowvram`。

### 工作流节点（MTNode 默认启用，节点设置可关）

| 优化 | 作用 | 节点 |
|------|------|------|
| TeaCache | H3 专用步缓存，加速采样 | `MiniMaxH3TeaCache` |
| EasyCache | 原生步跳过缓存（约 1.4–2× 采样段） | `EasyCache`（reuse≈0.2, start≈0.15, end≈0.95） |
| Sage Attention | 注意力加速（有包用 `auto`；无包则跳过） | `PathchSageAttentionKJ` |
| Low VRAM Attention | 按 head 分块降峰值显存 | `MiniMaxLowVRAMAttention` |
| Chunk FeedForward | FFN 分块降峰值 | `MiniMaxChunkFeedForward` |
| **VRAM Barrier** | 采样后 `unload_all_models` + empty_cache，**避免双 VAE 解码 OOM（必开）** | `VRAM_Debug` |

推荐模型链：`UNET → TeaCache → EasyCache → SigmaShift → LowVRAMAttn → ChunkFFN → Sage → Guider`  
采样输出**必须**经 `VRAM_Debug`（`unload_all_models=true`）后再 `VAEDecode` / `VAEDecodeAudio`。**缺失该屏障 → 解码在 24G 上卡死**（DiT 19.9G + VideoVAE 4.9G 超 24G）。

### 分辨率/时长提示（按显存）

- 冒烟：约 864×480、5s、8~20 steps（24G 下 5.2s/it，8 步约 41s）
- 生产常用：约 0.6–0.8MP（如 1056×608）；原生 ~1MP 更吃显存/时间
- `<24GB`：降到 ~0.3–0.5MP、≤5s；`≥48GB`：可放宽。时长越长 token 越多，越易 OOM——优先开 LowVRAM / ChunkFFN / VRAM Barrier

### 可选依赖

- Windows：`triton-windows` + 匹配 torch/CUDA 的 `sageattention` wheel（装不上则禁用 Sage，其它优化仍有效）。**必须与 torch 版本（cu130）匹配。**

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

若 ComfyUI 的 `MiniMaxH3ReferenceToVideo` 是较新版本（用 `io.Autogrow` 嵌套 `ref_images`），而插件/前端仍发扁平键 `ref_image_0`，会抛 `TypeError: ...unexpected keyword argument 'ref_image_0'`（插件包装为 `comfy_execution_error`）。修复：给该节点 `execute` 加 `**legacy_refs` 并把扁平键折回嵌套 dict：

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

## 步骤（全新安装）

1. **硬件探测**（见上）。GPU 非 NVIDIA / 驱动不支持 CUDA 13 → fail 并写 reason。
2. 从 `SCAFFOLD_REF` 准备 `app/` / `scripts/` / `requirements.txt`（保留已有 ComfyUI/models/output）；或用内置脚本。
3. 探测 CUDA Python → 写 `.cuda-python`（仅作 venv 基座）。
4. `.\scripts\setup_env.ps1`：隔离 venv（**禁 `--system-site-packages`**）、装 **cu130** torch（torchvision/torchaudio 匹配）、ComfyUI 依赖、TeaCache + KJNodes。
   - 装完**必须**校验 `torch.cuda.is_available()` 为真且日志里 cuda backend 未被禁用；否则按「驱动太旧」处理。
   - pip 用 `--isolated` 避开坏掉的 `pypi.ngc.nvidia.com` extra-index（否则 DNS 反复重试，下载几乎不前进）。
5. 按需静默给 `nodes_minimax_h3.py` 加 `**legacy_refs` 折叠（幂等，见上）；如需，补 `polyfill`。
6. `.\scripts\download_models.ps1`（优先 ModelScope `Comfy-Org/MiniMax-H3`，再 HuggingFace）。
7. 冒烟：`import torch; assert torch.cuda.is_available(); import comfy_kitchen`；确认模型文件非空（>1MB）。

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
- 回复：`install_ok=1`、`gpu=`（name+VRAM+driver）、`cuda_python=`、`venv_ok=`、`comfy_ok=`、`models_ok=`、`cuda_available=`、`torch_version=`（含 `ComfyUI\venv`，须 `≥2.9.1+cu130`）、`cuda_backend_enabled=`（日志中未被告示 disabled）
