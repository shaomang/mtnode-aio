---
name: infinitetalk-local-install
title: InfiniteTalk 数字人本地安装
description: 在用户指定目录安装 InfiniteTalk（数字人视频 · Wan2.1 I2V 14B · 独立 ComfyUI）后端：探测 GPU/磁盘，建隔离 venv 与 CUDA torch，强装 SageAttention，下载 fp8 扩散模型 + InfiniteTalk patch + umt5 + VAE + wav2vec2 + lightx2v LoRA + CLIP Vision，跑 /object_info 冒烟并建健康检查。含自我修复、分块续写与 V2V 口径。
---

# InfiniteTalk 数字人本地安装

当用户或 MTNode 插件要求在某目录**安装 / 自我修复**「InfiniteTalk 数字人（MeiGen-AI InfiniteTalk · Wan2.1 I2V 14B）」时使用本 skill。

插件调用时：

- **当前工作区就是 `INSTALL_DIR`**，可直接读写并执行命令。
- **`SCAFFOLD_REF`（或 `.scaffold-ref`）只作参考**：随包脚手架 `infinitetalk-pack/` 是示例实现，不代表已经装好。
- 若任务附带 **CONSOLE_LOG**，以「最近失败焦点」为准分析（更早的 Traceback 可能已被后续步骤绕开）。
- **先探测硬件再动手**：非 NVIDIA 直接说明跑不动（本插件只走 CUDA 推理）。

## 目录约定

```
INSTALL_DIR/
  ComfyUI/                                  独立 checkout（不复用 H3 那份）
    main.py
    venv/Scripts/python.exe                 隔离解释器（禁止 --system-site-packages）
    models/
      diffusion_models/Wan2_1-I2V-14B-480p_fp8_e4m3fn_scaled_KJ.safetensors
      model_patches/wan2.1_infiniteTalk_single_fp16.safetensors
      text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors
      vae/Wan2_1_VAE_bf16.safetensors
      audio_encoders/wav2vec2-chinese-base_fp16.safetensors
      loras/lightx2v_I2V_14B_480p_cfg_step_distill_rank64_bf16.safetensors
      clip_vision/clip_vision_h.safetensors
    output/                                  COMFY 产物（宿主从这里取 mp4）
  .install-ok                                全部步骤通过后由脚本写
```

- 宿主自己的任务目录在 **`%APPDATA%\pipeline-console\infinitetalk-local\`**（`jobs/`、`config.json`、`console.log`），**不要**写进 `INSTALL_DIR` 之外的应用目录。
- 安装脚本真源：`infinitetalk-pack/scripts/install.ps1`（纯 ASCII、无 BOM）；步骤 id 必须与 `infinitetalk-pack/steps.json` 一致：`disk / comfy / venv / sage / weights / files / smoke`。
- 不自建自定义节点：用的是 ComfyUI **自带**的 `WanInfiniteTalkToVideo`（`comfy_extras/nodes_wan.py`），官方模板 `video_wan2_1_infinitetalk`。

## 硬件与磁盘

- **显存**：480p fp8 + 4 步实测 24GB 卡留有余量；24GB 以下不设门槛但会很慢，先让用户看控制台日志再决定。
- **磁盘建议 ≥ 55GB**：CUDA torch + ComfyUI 依赖约 8–12GB，fp8 扩散模型 16.6GB，其余权重约 7.5GB。
- 驱动要能跑本机 CUDA torch（脚本按 `nvidia-smi` 的驱动版本选 cu128 / cu126）。

## 默认优化项（全部默认开，缺一不可）

1. **fp8 扩散模型**（`Wan2_1-I2V-14B-480p_fp8_e4m3fn_scaled_KJ`）—— 显存与速度的基线。
2. **lightx2v 4 步蒸馏 LoRA**（`LoraLoaderModelOnly`，strength 1.0）—— 采样固定 4 步、cfg 1.0、euler/simple。
3. **SageAttention**：`sageattention` + `triton` 必须 import 成功，后端以 `--use-sage-attention` 启动；**装不上就算安装失败**（不要悄悄退回 SDPA）。wheel 走 `scripts/sage_install.py`（GitHub release 优先，失败回落到 PyPI 源码构建）。
4. **显存水位**：启动带 `--reserve-vram 1.0`；720p 或 `vramMode=low` 时追加 `--lowvram`。

## 安装后验证（缺一步都不算装好）

1. `INSTALL_DIR/.install-ok` 存在。
2. `venv\Scripts\python.exe -c "import torch;print(torch.cuda.is_available(), torch.version.cuda)"` → `True`。
3. `venv\Scripts\python.exe -c "import triton, sageattention"` 无异常。
4. 冷启动 `python main.py --cpu --port 8231`，`GET /object_info/WanInfiniteTalkToVideo` 返回 200 且含 `audio_encoder_output_1` / `motion_frame_count` / `previous_frames`。这一步同时证明权重文件名与节点输入名对得上。
5. 关掉探针进程，再 `start_backend.cmd`（带 `--use-sage-attention`）应能在 8199 起来并 `/health` 200。

## 分块续写 / V2V 口径（宿主实现，排障时要知道）

- 单块 **81 帧 @ 25fps ≈ 3.24 秒**；音频按 3.24s 切片，`apad` 补齐尾块。
- 第 2 块起：`start_image` = 上一块**末帧**，`previous_frames` = 上一块**末 9 帧**（`motion_frame_count=9`），保证口型与画面连续。
- V2V：按同一时间窗切源视频，`start_image` 取窗口首帧；画幅按所选 480p / 720p 缩放。
- 成片 = 各块 concat 后**封回原音轨**（不是分块音频拼接）；分块产物留在 `jobs/<nodeId>-<ts>/` 供断点续跑。

## 已知故障与自我修复

| 现场 | 判据 | 处理 |
| --- | --- | --- |
| `SAGE-OK` 缺失 / `sage_missing` | `import sageattention` 失败 | 重跑 `scripts/sage_install.py`；仍失败查 triton 与 torch 版本是否匹配，别改回 SDPA 蒙混 |
| `weights.failed` | 某个 `.safetensors` 缺失或大小不符 | 按脚本的 `-Resume` 逻辑重下；hf-mirror 超时自动回落 huggingface.co |
| `/object_info/WanInfiniteTalkToVideo` 404 | ComfyUI 版本太旧 | 更新 ComfyUI checkout（该节点在 `comfy_extras/nodes_wan.py`，2025-08 之后才有） |
| `smoke.failed` 但 200 正常 | 8231 被占 / 探针进程残留 | 关掉占端口的进程后重跑 `-SkipWeights` |
| 生成报 `audio_no_stream` | 端口 1 接的是图片或静音视频 | 换真音频；宿主会先转 16k 单声道 |
| 生成报 `busy` | 全局音视频锁被别的节点占着 | 等当前任务结束或取消它（全局仅 1 个） |
| 720p OOM | 24GB 卡跑 1280×768 | 降到 480p，或 `vramMode=low` |
| `cuda` 不可用 | 装成了 CPU 版 torch | 按驱动重装 cu128 / cu126 的 torch，不要用 CPU 版冒充实装成功 |
