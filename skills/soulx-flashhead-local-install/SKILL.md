---
name: soulx-flashhead-local-install
title: SoulX-FlashHead Lite 实时数字人本地安装
description: 在用户指定目录安装 SoulX-FlashHead Lite（实时数字人 · 1.3B 流式 · 自带 Python 服务）后端：探测 GPU/磁盘，下载官方推理仓库，建隔离 venv 与 cu128 torch 2.8.0，强制安装 flash-attn（失败即安装失败）并可选 SageAttention，用 ModelScope（回退 hf-mirror）下载 Model_Lite + VAE_LTX + wav2vec2，跑真实权重的 4 块流式基准（BENCH-OK / fps / rtf，首块预热不计入）当冒烟。含自我修复、实时基准与 512×512@25fps 口径。
---

# SoulX-FlashHead Lite 实时数字人本地安装

当用户或 MTNode 插件要求在某目录**安装 / 自我修复**「SoulX 实时数字人（Soul-AILab SoulX-FlashHead · Lite 1.3B）」时使用本 skill。

插件调用时：

- **当前工作区就是 `INSTALL_DIR`**，可直接读写并执行命令。
- **`SCAFFOLD_REF`（或 `.scaffold-ref`）只作参考**：随包脚手架 `soulxflashhead-pack/` 是示例实现，不代表已经装好。
- 若任务附带 **CONSOLE_LOG**，以「最近失败焦点」为准分析（更早的 Traceback 可能已被后续步骤绕开）。
- **先探测硬件再动手**：非 NVIDIA 直接说明跑不动（本插件只走 CUDA 推理，且拒绝 CPU 降级）。

## 目录约定

```
INSTALL_DIR/
  SoulX-FlashHead/                          官方推理仓库（zip 解包，不用 git）
    generate_video.py
    flash_head/
    mtnode_server.py                        MTNode 的 HTTP 封装（来自 soulxflashhead-pack/server.py）
    venv/Scripts/python.exe                 隔离解释器（禁止 --system-site-packages）
    models/
      SoulX-FlashHead-1_3B/Model_Lite/      config.json + diffusion_pytorch_model.safetensors
      SoulX-FlashHead-1_3B/VAE_LTX/         config.json + diffusion_pytorch_model.safetensors
      wav2vec2-base-960h/                   音频编码器
  wheels/pip/                              pip 依赖轮子缓存（离线/断点续装的复用点）
  .install-ok                                全部步骤通过后由脚本写
```

- 宿主自己的数据在 **`%APPDATA%\pipeline-console\soulxflashhead-local\`**（`config.json`、`console.log`、`smoke-flashhead.log`），**不要**写进 `INSTALL_DIR` 之外的应用目录。
- 安装脚本真源：`soulxflashhead-pack/scripts/install.ps1`（纯 ASCII、无 BOM）；步骤 id 必须与 `soulxflashhead-pack/steps.json` 一致：`disk / source / venv / flashattn / sage / weights / files / smoke`。
- **`flash_head/inference.py` 用相对路径读 `flash_head/configs/infer_params.yaml`**：起服务必须 `cwd` 进仓库根，别在别处 `import flash_head`。

## 硬件与磁盘

- **显存**：Lite 1.3B + fp16 VAE 分片，16GB 起可跑；实时验收口径是**单张 40 系卡（4090）单路稳定 25FPS**。
- **磁盘建议 ≥ 30GB**：cu128 torch 约 3GB，Model_Lite 6.1GB，VAE 1.6GB，wav2vec2 与依赖若干。
- 驱动要能跑 cu128 torch（脚本按 `nvidia-smi` 探测；不满足直接给 `flashhead.venv.torch_failed`）。

## 默认优化项（全部默认开）

1. **torch.compile**：后端默认 `MT_FLASHHEAD_COMPILE=1`；编译失败自动退回不编译重跑一次，结果写日志（不静默降级成「装好了」）。
2. **flash-attention（硬门槛）**：`flash_attn 2.8.3+cu128torch2.8.0` Windows 预编译轮子（对应 torch 2.8.0+cu128），失败回落 GitHub Release → 镜像 → 本地轮子（`MT_FLASHHEAD_FLASH_ATTN_WHEEL` / `_URL`）→ 源码编译 `--no-build-isolation`。**装不上或 kernel 跑不通 = 安装失败**，绝不悄悄退回 SDPA。
3. **SageAttention（软优化）**：能装就装，后端带 `--sage` 走它；失败只警告（flash-attn 已在实时路径上）。
4. **fp16 + VAE 分片**：逐块释放显存，16G 卡可用。

## 安装后验证（缺一步都不算装好）

1. `INSTALL_DIR/.install-ok` 存在。
2. `venv\Scripts\python.exe -c "import torch;print(torch.cuda.is_available(), torch.version.cuda)"` → `True 12.8`。
3. `venv\Scripts\python.exe -c "import flash_attn, flash_attn_func; print(flash_attn.__version__)"` 无异常（kernel 冒烟由 `scripts/flash_attn_install.py` 打印 `FLASHATTN-OK=1`）。
4. `cd` 进仓库根后 `python mtnode_server.py --check --install-dir <InstallDir>` 打印
   `ACCEL torch=… cuda=… flash_attn=… sage=… gpu=… vram=…GB` 与 `BENCH-OK fps=… rtf=… ms_per_chunk=… chunks=…`。
   **没有 BENCH-OK 就是没装好**（这一步同时证明权重路径、注意力后端与流式循环都真的能跑）。
5. 关掉探针进程，再 `start_backend.cmd` 能在 **8198** 起来并 `GET /health` 返回 200。

## 实时口径（排障时要知道）

- 输出固定 **512×512 @ 25fps**；`flash_head/configs/infer_params.yaml` 的 `frame_num: 33`、`motion_frames_latent_num: 2`、`vae_stride [8,32,32]` 决定**首块 9 帧 + 之后每块 24 帧**。
- 整段音频**一次流式跑完**：模型内部按窗口续写，宿主不切片、不拼缝；帧直接进 ffmpeg rawvideo 管道，最后封回原音轨。
- `--check` 的 4 块基准确认「加载 + 连续出片」都通，稳态数字取后 3 块中位数；正式安装还会把 `fps / rtf / ms_per_chunk` 写进配置，供控制台与安装收尾展示。

## 已知故障与自我修复

| 现场 | 判据 | 处理 |
| --- | --- | --- |
| `flashhead.flashattn.failed` | `FLASHATTN-*` 带 `FAILED` / `import flash_attn` 崩 | 先确认 torch 是 **2.8.0+cu128**（轮子按这个 tag 匹配）；再查 `MT_FLASHHEAD_FLASH_ATTN_WHEEL` 指向的本地轮子；源码编译需要 MSVC + CUDA Toolkit，缺就别硬编，换本地轮子 |
| `flashhead.venv.torch_failed` | pip 装 torch 失败 / `torch.cuda.is_available()` 为 False | 按驱动重装 cu128；`PIP_CONFIG_FILE` 已被脚本清空，别再叠个人 index |
| `flashhead.venv.requirements_failed` | 依赖解析失败 | 确认装的是**本包** `requirements.txt`（Windows 子集，不含 `nvidia-nccl-cu12` / `xformers` / `decord`；opencv 两个包钉在 `==4.12.0.88`，别放开） |
| 安装卡在 `Downloading opencv_contrib_python-…whl` 不动 | 十几分钟没有任何新行 | 镜像给了条「连上但涓流」的连接（实测 aliyun 对该 53.8MB 轮子只有 ~85KB/s，pip 的 `--timeout` 管不到）。脚本已自带看门狗：`wheels <n> MB (+x MB/s)` 是进度，75 秒无新字节就杀 pip 换下一个镜像（清华 → 阿里 → 官方）。轮子落在 `<InstallDir>\wheels\pip\`，重跑直接复用；手工排查可 `curl -o NUL -w "%{speed_download}" <轮子URL>` 量速 |
| `flashhead.weights.failed` | 某个 safetensors 缺失 / 大小不符 | 重跑脚本走断点续传；ModelScope 超时自动回落 hf-mirror 与 huggingface.co |
| `flashhead.smoke.failed` | 没有 `BENCH-OK` | 看 `<InstallDir>\smoke-flashhead.log`：`CHECK-FAIL=` 后面就是原因（权重 / 编译 / 显存 / ffmpeg） |
| 起服务报 `FileNotFoundError: infer_params.yaml` | 没 `cwd` 进仓库根 | 用 `start_backend.cmd`（它先 cd 再起 `mtnode_server.py`） |
| `sage_missing` 只警告 | `import sageattention` 失败 | 可重跑 `scripts/sage_install.py`；不影响出片，别为此判定安装失败 |
| 生成报 `busy` | 全局音视频锁被别的节点占着 | 等当前任务结束或取消它（全局仅 1 个） |
| OOM（显存不足） | 16G 卡同时跑别的后端 | 先停其它本地后端（顶栏「释放显存」），再重试 |
| 端口 8198 被占 | 上一次后端没退干净 | 控制台「停止后端」，或任务管理器结束那只 python 后重起 |
