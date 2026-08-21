---
name: minimax-h3-install
title: MiniMax H3 本地安装
description: 在用户指定目录安装 MiniMax H3（24G ComfyUI）后端：隔离 venv、依赖、模型、冒烟；含自我修复与 24G 显存最佳实践。
---

# MiniMax H3 本地安装

当用户或 MTNode 插件要求在某目录安装 / **自我修复** **MiniMax H3（24G ComfyUI）** 时使用本 skill。

插件调用时：

- **当前工作区就是 `INSTALL_DIR`**，可直接读写并执行命令
- **`SCAFFOLD_REF`（或 `.scaffold-ref`）仅作参考**：内置脚手架/脚本是示例实现，不是已完成的安装
- 不要假设插件已替你复制好脚手架
- 若任务附带 **CONSOLE_LOG**，以「最近失败焦点」为准自行分析修复（每人环境不同）

## 目标

在 `INSTALL_DIR` 完成可运行后端：

- `ComfyUI\venv\Scripts\python.exe` 存在且 **venv 内** `torch.cuda.is_available()` 为真
- `import comfy_kitchen` 成功（torch 必须在 `ComfyUI\venv`，禁止 `--system-site-packages`）
- `ComfyUI\main.py` 存在
- 权重就绪（约 42–65GB；建议预留 ≥70GB）：
  - `models\diffusion_models\minimax_h3_fl2va_pruned_int8_convrot.safetensors`
  - `models\diffusion_models\minimax_h3_ref2va_pruned_int8_convrot.safetensors`（R2V）
  - `models\text_encoders\qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors`
  - `models\vae\minimax_h3_video_vae_fp16.safetensors` + `minimax_h3_audio_vae_fp32.safetensors`
- custom_nodes：`ComfyUI-MiniMaxH3-TeaCache`、`ComfyUI-KJNodes`（含 Sage / VRAM_Debug / MiniMax LowVRAM / ChunkFFN）
- **不要在本 skill 中启动 ComfyUI**

## 24G 显存最佳实践（RTX 4090 级）

官方/社区在 24GB 上稳定跑通依赖：**量化权重 + 注意力加速 + 步间缓存 + 采样后卸模型再 VAE**。整机建议 **≥32GB 系统内存**（权重会 offload 到 RAM）。

### 启动参数（插件默认开启，可关）

```
python main.py --listen 127.0.0.1 --port 8188
  --cpu-vae
  --disable-pinned-memory
  --fp16-intermediates
  --reserve-vram 4
```

环境变量：`PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True`  
**不要**与 `--lowvram` 同开（与 `--disable-pinned-memory` 冲突）。

### 工作流节点（MTNode 默认启用，节点设置可关）

| 优化 | 作用 | 节点 |
|------|------|------|
| TeaCache | H3 专用步缓存，加速采样 | `MiniMaxH3TeaCache` |
| EasyCache | 原生步跳过缓存（约 1.4–2× 采样段） | `EasyCache`（reuse≈0.2, start≈0.15, end≈0.95） |
| Sage Attention | 注意力加速（有包用 `auto`；无包则跳过） | `PathchSageAttentionKJ` |
| Low VRAM Attention | 按 head 分块降峰值显存 | `MiniMaxLowVRAMAttention` |
| Chunk FeedForward | FFN 分块降峰值 | `MiniMaxChunkFeedForward` |
| VRAM Barrier | 采样后 `unload_all_models` + empty_cache，避免双 VAE 解码 OOM | `VRAM_Debug` |

推荐模型链：`UNET → TeaCache → EasyCache → SigmaShift → LowVRAMAttn → ChunkFFN → Sage → Guider`  
采样输出经 `VRAM_Debug` 后再 `VAEDecode` / `VAEDecodeAudio`。

### 分辨率提示（24G）

- 冒烟：约 864×480、5s、20 steps  
- 生产常用：约 0.6–0.8MP（如 1056×608）；原生 ~1MP 更吃显存/时间  
- 时长越长 token 越多，注意力更易 OOM——优先开 LowVRAM / ChunkFFN / VRAM Barrier

### 可选依赖

- Windows：`triton-windows` + 匹配 torch/CUDA 的 `sageattention` wheel（装不上则禁用 Sage，其它优化仍有效）

## 已知故障摘要

### sageattention 缺失

日志：`No module named 'sageattention'`。装匹配 wheel，或关闭 Sage（保留其它优化）。

### comfy_kitchen + `list[int]` infer_schema

隔离 venv + venv 内 CUDA torch；跑 `scripts\repair_torch_kitchen.ps1` 与 `patch_comfy_kitchen_typing.py`。禁止 `--system-site-packages`。

### 采样完成但 VAE 卡住 / OOM

在 sampler 与 VAE 之间加 `VRAM_Debug`（`unload_all_models=true`）。确认启动带 `--disable-pinned-memory`。

## 步骤（全新安装）

1. 从 `SCAFFOLD_REF` 准备 `app/` / `scripts/` / `requirements.txt`（保留已有 ComfyUI/models/output）
2. 探测 CUDA Python → 写 `.cuda-python`（仅作 venv 基座）
3. `.\scripts\setup_env.ps1`：隔离 venv、装 CUDA torch、ComfyUI 依赖、TeaCache + KJNodes
4. `.\scripts\download_models.ps1`（优先 ModelScope `Comfy-Org/MiniMax-H3`）
5. 冒烟：`import torch; import comfy_kitchen`；确认模型文件非空

## 自我修复模式（dsh）

把 CONSOLE 交给 Agent：**自行根据最近失败焦点分析并修复**；已知故障仅在证据匹配时参考。模型已齐勿重下。勿启动 ComfyUI；勿删 output。

## 约束

- 不启动 ComfyUI；不删 `ComfyUI\output\` / `output\`
- 磁盘远小于 70GB 时先警告
- 已有完整布局只补缺失，勿整体重装
- **禁止** `--system-site-packages` 的 ComfyUI venv

## 成功标准

- `.install-ok`；`.h3-agent-result` 写 `ok=true`（失败 `ok=false` + `reason=`）
- 回复：`install_ok=1`、`cuda_python=`、`venv_ok=`、`comfy_ok=`、`models_ok=`、`cuda_available=`、`torch_file=`（含 `ComfyUI\venv`）
