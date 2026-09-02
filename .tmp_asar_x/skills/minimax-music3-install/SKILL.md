---
name: minimax-music3-install
title: MiniMax Music 3 本地安装
description: 在用户指定目录安装 MiniMax Music 3（24G Diffusers + Gradio）后端：探测 CUDA Python、创建 venv（system-site-packages）、安装依赖（diffusers 固定 commit）、下载官方权重、冒烟验证。含 Gradio 生成契约、LM+RVQ offload 显存自修复与 console 自我修复指引。
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
- 可用 `python -m app` 启动 Gradio（`127.0.0.1:7860`，api_name `run_generate`）——**不要在本 skill 中启动**
- 目录结构：`app/`（pipeline.py / ui.py / generate.py / __main__.py）、`models/MiniMax-Music3/`、`output/`（默认音频输出，**勿删**）、`prompts/`（caption/歌词模板）、`scripts/`、`workflows/`（ComfyUI 可选）

## 国内镜像（必须）

> **中国大陆网络下，以下镜像必须使用**：HuggingFace 无法直连，Python 库必须走清华/中科院镜像。

- pip：**清华** `https://pypi.tuna.tsinghua.edu.cn/simple`（或**中科院 USTC** `https://mirrors.ustc.edu.cn/pypi/simple/`、阿里云 `https://mirrors.aliyun.com/pypi/simple/`）；可用 `MT_MUSIC_PIP_INDEX` 覆盖
- 模型权重（HuggingFace 无法直连）：
  - Comfy 权重：**优先 ModelScope(魔搭)** `Comfy-Org/MiniMax-Music-3`（国内直连），失败回退 hf-mirror
  - App(Diffusers) 权重：`HF_ENDPOINT=https://hf-mirror.com`（`HF_HUB_DISABLE_XET=1`）；如需 ModelScope，设 `MUSIC3_MODELSCOPE_REPO` 指向你的魔搭仓库
- diffusers 依赖来自 GitHub（`git+https://github.com/huggingface/diffusers@<commit>`，脚手架固定 `dafe3733fcfdbf3c48915fe77be3aef65b5d6a2d`）：pip 直连失败时改用 `git+https://ghproxy.com/https://github.com/huggingface/diffusers@...` 前缀重试
- 安装示例：
  ```powershell
  .\.venv\Scripts\python.exe -m pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple
  ```

## 关键环境要点（与 H3 相反，勿混淆）

- **venv 用 `--system-site-packages`**（`setup_env.ps1` 默认）：复用本机 conda 的 CUDA torch，只装应用依赖。这与 H3（必须隔离 venv、禁 system-site-packages）相反
- `setup_env.ps1` 依次探测：`-CudaPython` → env `MT_MUSIC_CUDA_PYTHON` → 常见 conda（`envs\seg|torch|pytorch|cuda|base`）→ PATH → 兜底 `C:\ProgramData\miniconda3\envs\seg\python.exe`；结果写 `INSTALL_DIR\.cuda-python`
- Windows：`app/ui.py` 顶部设置 `asyncio.WindowsSelectorEventLoopPolicy()` 并过滤 `ConnectionResetError/10054` 日志——Gradio 长任务客户端断开时刷 10054 属**预期噪音**，不代表生成失败
- 环境变量（插件启动默认）：`MUSIC3_MEMORY_RESERVE_MARGIN=6GB`、`PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True`；`MUSIC3_ALLOWED_PATHS` 可追加 Gradio 可访问路径（分号分隔）

## 已知故障：LM + RVQ depth decoder 显存不足（auto offload）

### 症状

```
Error: The language model and the RVQ depth decoder must fit on the device together for autoregressive generation;
there is not enough free device memory under CPU offloading.
```

### 根因

Diffusers 自回归阶段要求 **language_model** 与 **rvq_depth_decoder** 同时在 GPU；默认 offload 策略可能只放上 LM，RVQ 留在 CPU。常见诱因：

1. 显存被其它进程占用（H3 ComfyUI、浏览器、上一次生成未卸回 CPU）
2. `app/pipeline.py` 过旧：`release_vram` 未通过 `_components_manager.model_hooks` 卸载
3. `memory_reserve_margin` 过小（建议 **6GB**）

### 修复（参考成功部署 `E:\mt-music`）

1. 确保 `app/pipeline.py` 含 **Music3AutoregressiveOffloadStrategy**（LM+RVQ 成对 offload）与修复后的 `release_vram`
2. 关闭其它占 GPU 的后端；重启 Music3 Gradio 以加载新 `pipeline.py`
3. 环境变量（插件启动默认）：`MUSIC3_MEMORY_RESERVE_MARGIN=6GB`、`PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True`
4. 画布节点保持 **auto CPU offload** 开启；时长先用 60s 冒烟
5. 仍 OOM：缩短 `audio_duration` 或增大 margin 至 `8GB`

## Gradio / CLI 生成契约（插件依赖，实现 app/ 时勿缺）

以 `SCAFFOLD_REF` 的 `app/` 为权威实现；若自行生成需覆盖，否则画布 music_gen 节点不可用：

- **入口**：`python -m app`（`app/__main__.py` → `ui.main()`）启动 Gradio `127.0.0.1:7860`
- **Gradio API**：`api_name="run_generate"`，参数顺序 `[prompt, lyrics, audio_duration, seed, output_dir, filename, model_path, offload]`：
  - `prompt`：Structured Caption（Global Metadata / Vocal Details / Arrangement），必填
  - `lyrics`：带 `[Verse]`/`[Chorus]` 等标签的歌词，必填（纯音乐用 `[instrumental]`）
  - `audio_duration`：目标秒数，**≤150**（越界报错）；`seed`：整数（CPU generator，跨 offload 不钉 CUDA RNG）
  - `output_dir`：音频保存目录（默认仓库 `output/`，自动创建）；`filename`：可选（空则自动 `{时间戳}_{slug}_seed{seed}.wav`）
  - `model_path`：本地 `models/MiniMax-Music3` 或 HF id；`offload`：auto CPU offload（24G 建议 true）
  - 成功后返回 `[预览路径, 状态文本]`，状态文本含 `Saved: <path>`、`Duration: x.xxs @ 44100 Hz`、`Seed:`、`Model:`；输出目录还写 `_last_generate_inputs.txt` sidecar（记录本次入参，便于排查）
- **输出**：WAV **stereo @ 模型采样率**（当前 checkpoint **44.1 kHz**，`soundfile` 写入）
- **串行**：生成互斥（`concurrency_limit=1`），每首生成结束 `release_vram()` 把模型卸回 CPU 并清显存——**服务常驻**，不要因"第二首卡死"去重启后端
- **CLI**（同契约，冒烟/自测用）：
  ```powershell
  .\.venv\Scripts\python.exe -m app.generate --prompt-file prompts\example_lofi.txt --lyrics-file prompts\example_lyrics.txt --audio-duration 60 --seed 7 --output-dir output --filename demo_lofi.wav
  ```
  成功打印 `saved=<path>`、`duration_sec=`、`sampling_rate=`、`seed=`、`model_path=`；`--no-offload` 保持全模型在 GPU（24G 易 OOM，默认 offload）

## 步骤（按序）

1. **准备工程文件**  
   若缺 `app\pipeline.py` / `app\ui.py` / `app\generate.py` / `scripts\*.ps1` / `requirements.txt` / `prompts\`：从 `SCAFFOLD_REF` 复制或按参考自行生成。保留用户已有的 `.venv` / `models` / `output`。

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
   若已有 `.venv`，可跳过创建，只装/补依赖。**注意**：music3 的 venv 是 `--system-site-packages`（复用 CUDA torch；与 H3 的隔离 venv 相反）。

4. **下载 App 权重**（可参考 `SCAFFOLD_REF\scripts\download_models.ps1`）  
   ```powershell
   .\scripts\download_models.ps1 -Target app
   ```
   默认 `HF_ENDPOINT=https://hf-mirror.com`，`snapshot_download(MiniMaxAI/MiniMax-Music3)` 到 `models\MiniMax-Music3`。下载时间长，保持运行直到权重就绪。  
   **自我修复且模型已齐全时跳过本步。**  
   可选 Comfy 权重（仅任务明确要求）：`.\scripts\download_models.ps1 -Target comfy -ComfyRoot <ComfyUI路径> [-IncludeInt8Dit]`，清单 `diffusion_models/minimax_music3_dit_fp16.safetensors`、`text_encoders/minimax_music3_text_encoder_pruned_int8_convrot.safetensors`、`vae/minimax_music3_dav.safetensors`（+可选 `dit_int8_convrot`），优先 ModelScope `Comfy-Org/MiniMax-Music-3`。

5. **冒烟**  
   ```powershell
   .\.venv\Scripts\python.exe -c "import torch; from diffusers import ModularPipeline; print(torch.cuda.is_available())"
   ```
   并确认 `models\MiniMax-Music3` 非空。可选端到端自测：`python -m app.generate`（见上契约）产出 WAV 即通过。

## 自我修复模式（CONSOLE_LOG 已由插件提交给 dsh）

插件「自我修复」把 console 交给 **dsh Agent** 自行分析并修复（不做本地固定规则短路）：

1. 以「最近失败焦点」为准判断根因；更早日志仅参考。
2. 自行修复依赖 / 环境；模型已齐则勿重下。
3. 常见方向：`import diffusers/ModularPipeline` 失败 → 重装 requirements（diffusers 固定 commit）；LM+RVQ offload 报错 → 按「已知故障」节；Gradio 报 10054 → 预期噪音非失败；生成中途 OOM → 关其它 GPU 进程 / 增大 `MUSIC3_MEMORY_RESERVE_MARGIN` / 缩短时长；输出缺失 → 查 `output_dir` 权限与 `_last_generate_inputs.txt`。
4. 冒烟后写 `.install-ok` 与 `.music3-agent-result`；回复 `repair_ok=1`。
5. **不要启动 Gradio**；勿删 `output/`。

## 约束

- 不要启动 Gradio（启停由插件负责）。
- 不要删除用户已有的 `output\`。
- 不要下载 ComfyUI 权重，除非任务明确要求。
- 磁盘不足（自由空间远小于 65GB）时先警告用户再继续。

## 成功标准

- 创建空文件 `.install-ok`
- 写入 `.music3-agent-result`（`ok=true`）；失败写 `ok=false` + `reason=`
- `python -m app.generate` 端到端产出 WAV（可选，推荐）
- 回复：`install_ok=1`、`cuda_python=`、`venv_ok=`、`model_dir=`、`cuda_available=`
