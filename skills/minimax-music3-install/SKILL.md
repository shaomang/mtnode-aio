---
name: minimax-music3-install
title: MiniMax Music 3 本地安装
description: 在用户指定目录安装 MiniMax Music 3（24G）后端：探测 CUDA Python、创建 venv、安装依赖、下载模型并冒烟验证。含 console 自我修复指引。
---

# MiniMax Music 3 本地安装

当用户或 MTNode 插件要求在某目录安装 / **自我修复** **MiniMax Music 3（24G Diffusers + Gradio）** 时使用本 skill。

插件调用时：

- **当前工作区就是 `INSTALL_DIR`**，可直接读写并执行命令
- **`SCAFFOLD_REF`（或 `.scaffold-ref`）仅作参考**：内置脚手架/脚本是示例实现，不是已完成的安装。请按下方目标自行准备目录；可按需从参考路径复制或改写，也可等价实现
- 不要假设插件已替你复制好脚手架
- 若任务附带 **CONSOLE_LOG**（插件 console 最近日志），优先根据日志定位并修复，不要盲目重装全部模型

## 目标

在 `INSTALL_DIR`（由任务给出）完成可运行的后端，使：

- `INSTALL_DIR\.venv\Scripts\python.exe` 存在且 `torch.cuda.is_available()` 为真
- `INSTALL_DIR\models\MiniMax-Music3` 权重就绪（约 53GB；整机建议预留 ≥65GB）
- 可用 `python -m app.ui` 启动 Gradio（`127.0.0.1:7860`）——**不要在本 skill 中启动**

## 步骤（按序）

1. **准备工程文件**  
   若缺 `app\pipeline.py` / `scripts\*.ps1` / `requirements.txt`：从 `SCAFFOLD_REF` 复制或按参考自行生成。保留用户已有的 `.venv` / `models` / `output`。

2. **探测 CUDA Python（自行判断）**  
   - 优先环境变量 `MT_MUSIC_CUDA_PYTHON`
   - 再查常见 conda：`ProgramData` / 用户目录下的 `miniconda3`、`anaconda3` 的 `envs\seg|torch|pytorch|cuda|base\python.exe`
   - 再查 PATH 中的 `python`
   - 兜底线索：`C:\ProgramData\miniconda3\envs\seg\python.exe`（仅提示，不强制）
   - 用 `python -c "import torch; print(torch.cuda.is_available())"` 验证；选第一个 CUDA 可用的
   - 写入 `INSTALL_DIR\.cuda-python`（单行绝对路径）

3. **环境**（可参考 `SCAFFOLD_REF\scripts\setup_env.ps1`）  
   ```powershell
   cd INSTALL_DIR
   .\scripts\setup_env.ps1 -CudaPython "<探测到的路径>"
   ```
   若已有 `.venv`，可跳过创建，只装/补依赖。

4. **下载 App 权重**（可参考 `SCAFFOLD_REF\scripts\download_models.ps1`）  
   ```powershell
   .\scripts\download_models.ps1 -Target app
   ```
   默认 `HF_ENDPOINT=https://hf-mirror.com`。下载时间长，保持运行直到权重就绪。  
   **自我修复且模型已齐全时跳过本步。**

5. **冒烟**  
   ```powershell
   .\.venv\Scripts\python.exe -c "import torch; from diffusers import ModularPipeline; print(torch.cuda.is_available())"
   ```
   并确认 `models\MiniMax-Music3` 非空。

## 自我修复模式（CONSOLE_LOG 已由插件提交给 dsh）

插件「自我修复」把 console 交给 **dsh Agent** 自行分析并修复（不做本地固定规则短路）：

1. 以「最近失败焦点」为准判断根因；更早日志仅参考。
2. 自行修复依赖 / 环境；模型已齐则勿重下。
3. 冒烟后写 `.install-ok` 与 `.music3-agent-result`；回复 `repair_ok=1`。
4. **不要启动 Gradio**；勿删 `output/`。

## 约束

- 不要启动 Gradio（启停由插件负责）。
- 不要删除用户已有的 `output\`。
- 不要下载 ComfyUI 权重，除非任务明确要求。
- 磁盘不足（自由空间远小于 65GB）时先警告用户再继续。

## 成功标准

- 创建空文件 `.install-ok`
- 写入 `.music3-agent-result`（`ok=true`）；失败写 `ok=false` + `reason=`
- 回复：`install_ok=1`、`cuda_python=`、`venv_ok=`、`model_dir=`、`cuda_available=`
