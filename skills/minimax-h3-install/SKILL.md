---
name: minimax-h3-install
title: MiniMax H3 本地安装
description: 在用户指定目录安装 MiniMax H3（24G ComfyUI）后端：探测 CUDA Python、创建 venv、安装依赖、下载模型并冒烟验证。
---

# MiniMax H3 本地安装

当用户或 MTNode 插件要求在某目录安装 **MiniMax H3（24G ComfyUI）** 时使用本 skill。

插件调用时：

- **当前工作区就是 `INSTALL_DIR`**，可直接读写并执行命令
- **`SCAFFOLD_REF`（或 `.scaffold-ref`）仅作参考**：内置脚手架/脚本是示例实现，不是已完成的安装。请按下方目标自行准备目录；可按需从参考路径复制或改写，也可等价实现
- 不要假设插件已替你复制好脚手架

## 目标

在 `INSTALL_DIR`（由任务给出）完成可运行的后端，使：

- `INSTALL_DIR\ComfyUI\venv\Scripts\python.exe` 存在且 `torch.cuda.is_available()` 为真
- `INSTALL_DIR\ComfyUI\main.py` 存在
- 权重就绪（约 42–65GB；整机建议预留 ≥70GB）：
  - `models\diffusion_models\minimax_h3_fl2va_pruned_int8_convrot.safetensors`
  - `models\diffusion_models\minimax_h3_ref2va_pruned_int8_convrot.safetensors`（R2V）
  - `models\text_encoders\qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors`
  - `models\vae\minimax_h3_video_vae_fp16.safetensors` + `minimax_h3_audio_vae_fp32.safetensors`
- 可用 `ComfyUI\venv\Scripts\python.exe main.py --listen 127.0.0.1 --port 8188` 启动（**不要**在本 skill 中启动）

## 步骤（按序）

1. **准备工程文件**  
   若缺 `app\pipeline.py` / `scripts\*.ps1` / `requirements.txt`：从 `SCAFFOLD_REF` 复制或按参考自行生成。保留用户已有的 `ComfyUI` / `models` / `output`。

2. **探测 CUDA Python（自行判断）**  
   - 优先环境变量 `MT_H3_CUDA_PYTHON` / `MT_MUSIC_CUDA_PYTHON`
   - 再查常见 conda：`ProgramData` / 用户目录下的 `miniconda3`、`anaconda3` 的 `envs\seg|torch|pytorch|cuda|base\python.exe`
   - 再查 PATH 中的 `python`
   - 兜底线索：`C:\ProgramData\miniconda3\envs\seg\python.exe`（仅提示，不强制）
   - 用 `python -c "import torch; print(torch.cuda.is_available())"` 验证；选第一个 CUDA 可用的
   - 将路径写入 `INSTALL_DIR\.cuda-python`（单行绝对路径）

3. **环境**（可参考 `SCAFFOLD_REF\scripts\setup_env.ps1`）  
   ```powershell
   cd INSTALL_DIR
   .\scripts\setup_env.ps1 -CudaPython "<探测到的路径>"
   ```
   若已有 `ComfyUI\venv`，可跳过创建，只装依赖 / 补 custom_nodes。

4. **下载权重**（可参考 `SCAFFOLD_REF\scripts\download_models.ps1`）  
   ```powershell
   .\scripts\download_models.ps1
   ```
   优先 ModelScope `Comfy-Org/MiniMax-H3`。下载时间长，保持运行直到权重就绪。

5. **冒烟**  
   ```powershell
   .\ComfyUI\venv\Scripts\python.exe -m app
   ```
   或确认上述模型文件非空，且 `torch.cuda.is_available()` 为真。

## 约束

- 不要启动 ComfyUI（启停由插件负责）。
- 不要删除用户已有的 `ComfyUI\output\` 或 `output\`。
- 磁盘不足（自由空间远小于 70GB）时先警告用户再继续。
- 若用户目录已是完整 `mt-video` 式布局（已有 ComfyUI + 模型），仅补齐缺失部分，勿整体重装。

## 成功标准

- 创建空文件 `.install-ok`
- 写入 `.h3-agent-result`（`ok=true`）；失败写 `ok=false` + `reason=`
- 回复：`install_ok=1`、`cuda_python=`、`venv_ok=`、`comfy_ok=`、`models_ok=`、`cuda_available=`
