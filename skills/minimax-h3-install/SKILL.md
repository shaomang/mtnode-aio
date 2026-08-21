---
name: minimax-h3-install
title: MiniMax H3 本地安装
description: 在用户指定目录安装 MiniMax H3（24G ComfyUI）后端：探测 CUDA Python、创建隔离 venv、安装依赖、下载模型并冒烟验证。含 console 自我修复指引。
---

# MiniMax H3 本地安装

当用户或 MTNode 插件要求在某目录安装 / **自我修复** **MiniMax H3（24G ComfyUI）** 时使用本 skill。

插件调用时：

- **当前工作区就是 `INSTALL_DIR`**，可直接读写并执行命令
- **`SCAFFOLD_REF`（或 `.scaffold-ref`）仅作参考**：内置脚手架/脚本是示例实现，不是已完成的安装。请按下方目标自行准备目录；可按需从参考路径复制或改写，也可等价实现
- 不要假设插件已替你复制好脚手架
- 若任务附带 **CONSOLE_LOG**（插件 console 最近日志），优先根据日志定位并修复，不要盲目重装全部模型

## 目标

在 `INSTALL_DIR`（由任务给出）完成可运行的后端，使：

- `INSTALL_DIR\ComfyUI\venv\Scripts\python.exe` 存在且 **venv 内** `torch.cuda.is_available()` 为真
- `import comfy_kitchen` 在 **同一 venv python** 下成功（不得再引用 conda 旧 torch）
- `INSTALL_DIR\ComfyUI\main.py` 存在
- 权重就绪（约 42–65GB；整机建议预留 ≥70GB）：
  - `models\diffusion_models\minimax_h3_fl2va_pruned_int8_convrot.safetensors`
  - `models\diffusion_models\minimax_h3_ref2va_pruned_int8_convrot.safetensors`（R2V）
  - `models\text_encoders\qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors`
  - `models\vae\minimax_h3_video_vae_fp16.safetensors` + `minimax_h3_audio_vae_fp32.safetensors`
- 可用 `ComfyUI\venv\Scripts\python.exe main.py --listen 127.0.0.1 --port 8188` 启动（**不要**在本 skill 中启动）

## 已知故障：comfy_kitchen + 旧 torch（高频）

### 症状（console）

```
ValueError: infer_schema(func): Parameter kernel_size has unsupported type list[int]
...
File "...\comfy_kitchen\backends\eager\na.py"
File "...\miniconda3\envs\seg\lib\site-packages\torch\..."
backend_exited / backend start failed
```

### 根因

旧版 `setup_env.ps1` 用 `python -m venv --system-site-packages`，ComfyUI 装了新版 `comfy_kitchen`（注解用 `list[int]`），但运行时仍加载 **conda 环境里的旧 torch**（只认 `typing.List[int]`），启动即崩。

### 修复（优先执行，勿重下模型）

1. **不要**再用 `--system-site-packages`。
2. 运行（可参考 `SCAFFOLD_REF\scripts\repair_torch_kitchen.ps1`）：
   ```powershell
   cd INSTALL_DIR
   .\scripts\repair_torch_kitchen.ps1
   ```
   或手动：
   - 若 `ComfyUI\venv\pyvenv.cfg` 含 `include-system-site-packages = true`：删掉整个 `ComfyUI\venv`，用探测到的 CUDA Python **无** `--system-site-packages` 重建
   - 在 venv 内安装 CUDA torch：  
     `.\ComfyUI\venv\Scripts\python.exe -m pip install -U torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu124`
   - 再 `pip install -r ComfyUI\requirements.txt`
3. 冒烟：
   ```powershell
   .\ComfyUI\venv\Scripts\python.exe -c "import torch; assert torch.cuda.is_available(); import comfy_kitchen; print(torch.__version__)"
   ```
4. 确认 `python -c "import torch; print(torch.__file__)"` 路径落在 `ComfyUI\venv\...`，**不是** `miniconda3\envs\...`。

## 步骤（按序 · 全新安装）

1. **准备工程文件**  
   若缺 `app\pipeline.py` / `scripts\*.ps1` / `requirements.txt`：从 `SCAFFOLD_REF` 复制或按参考自行生成。保留用户已有的 `ComfyUI` / `models` / `output`。

2. **探测 CUDA Python（自行判断）**  
   - 优先环境变量 `MT_H3_CUDA_PYTHON` / `MT_MUSIC_CUDA_PYTHON`
   - 再查常见 conda：`ProgramData` / 用户目录下的 `miniconda3`、`anaconda3` 的 `envs\seg|torch|pytorch|cuda|base\python.exe`
   - 再查 PATH 中的 `python`
   - 用 `python -c "import torch; print(torch.cuda.is_available())"` 验证；选第一个 CUDA 可用的  
     （此解释器**仅作 venv 基座**；最终推理必须用 venv 内 torch）
   - 将路径写入 `INSTALL_DIR\.cuda-python`（单行绝对路径）

3. **环境**（可参考 `SCAFFOLD_REF\scripts\setup_env.ps1`）  
   ```powershell
   cd INSTALL_DIR
   .\scripts\setup_env.ps1 -CudaPython "<探测到的路径>"
   ```
   - **必须**创建隔离 venv（**禁止** `--system-site-packages`）
   - 在 venv 内安装 CUDA torch，再装 ComfyUI / helper requirements
   - 若已有错误的 system-site-packages venv：先跑 `repair_torch_kitchen.ps1` 或删 venv 重建

4. **下载权重**（可参考 `SCAFFOLD_REF\scripts\download_models.ps1`）  
   ```powershell
   .\scripts\download_models.ps1
   ```
   优先 ModelScope `Comfy-Org/MiniMax-H3`。下载时间长，保持运行直到权重就绪。  
   **自我修复且模型已齐全时跳过本步。**

5. **冒烟**  
   ```powershell
   .\ComfyUI\venv\Scripts\python.exe -c "import torch; assert torch.cuda.is_available(); import comfy_kitchen; print('ok')"
   .\ComfyUI\venv\Scripts\python.exe -m app
   ```
   或确认上述模型文件非空。

## 自我修复模式（CONSOLE_LOG 已提供）

1. 阅读 CONSOLE_LOG，归类：
   - `list[int]` / `comfy_kitchen` / `infer_schema` / torch 路径在 conda → 按「已知故障」修 venv/torch
   - `not_installed` / 缺 `main.py` / 缺 venv → 走安装步骤 1–3
   - 缺模型文件 → 只跑 download_models
   - 其它 ImportError / CUDA OOM → 对症修依赖或提示用户，勿删 output
2. 修完后用 venv python 冒烟；写 `.install-ok` 与 `.h3-agent-result`
3. **不要启动 ComfyUI**（由插件启停）

## 约束

- 不要启动 ComfyUI（启停由插件负责）。
- 不要删除用户已有的 `ComfyUI\output\` 或 `output\`。
- 磁盘不足（自由空间远小于 70GB）时先警告用户再继续。
- 若用户目录已是完整 `mt-video` 式布局（已有 ComfyUI + 模型），仅补齐缺失部分，勿整体重装。
- **禁止**新建带 `--system-site-packages` 的 ComfyUI venv。

## 成功标准

- 创建空文件 `.install-ok`
- 写入 `.h3-agent-result`（`ok=true`）；失败写 `ok=false` + `reason=`
- 回复：`install_ok=1`、`cuda_python=`、`venv_ok=`、`comfy_ok=`、`models_ok=`、`cuda_available=`、`torch_file=`（应包含 `ComfyUI\venv`）
