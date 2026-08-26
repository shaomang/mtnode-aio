---
name: tts-local-install
title: GPT-SoVITS 本地 TTS 安装
description: 在用户指定目录安装 GPT-SoVITS 本地 TTS 后端：创建 venv、安装 Python 依赖、克隆 GPT-SoVITS、下载预训练权重（GPT/SoVITS + 中文 BERT/HuBERT）、冒烟验证。含自我修复指引。
---

# GPT-SoVITS 本地 TTS 插件 — 安装 / 修复

当用户或 MTNode 插件要求在某目录安装 / **自我修复** **GPT-SoVITS 本地 TTS 管理后端** 时使用本 skill。

插件调用时：

- **当前工作区就是 `INSTALL_DIR`**，可直接读写并执行命令
- **`SCAFFOLD_REF`（或 `.scaffold-ref`）仅作参考**：内置脚手架/脚本是示例实现，不是已完成的安装。请按下方目标自行准备目录；可按需从参考路径复制或改写，也可等价实现
- 不要假设插件已替你复制好脚手架
- 若任务附带 **CONSOLE_LOG**（插件 console 最近日志），优先根据日志定位并修复，不要盲目重装全部模型

## 目标

在 `INSTALL_DIR` 建立可运行的 GPT-SoVITS TTS 管理服务（FastAPI 管理 + GPT-SoVITS api_v2 推理），供 MTNode 插件启停。

完成后应满足：

- `INSTALL_DIR\.venv\Scripts\python.exe` 存在且 `import fastapi; from app import server, tts` 成功
- `INSTALL_DIR\engine\api_v2.py` 存在（GPT-SoVITS 官方仓库克隆）
- `INSTALL_DIR\engine\GPT_SoVITS\pretrained_models\` 下有 GPT 权重（`s1bert25hz-2kh-longer-epoch=68e-step=50232.ckpt` 或 v2 `s1bert25hz-5kh-longer-epoch=12-step=369668.ckpt`）与 SoVITS 权重（`s2G233k.pth` 或 `s2G488k.pth`），以及 `chinese-hubert-base`、`chinese-roberta-wwm-ext-large`
- `INSTALL_DIR\voices\` 目录存在
- **不要**启动 `python -m app` 或 `api_v2.py` 推理进程

## 目录约定

- `INSTALL_DIR/app/` — Python 管理服务（`python -m app`）
- `INSTALL_DIR/.venv/` — 虚拟环境
- `INSTALL_DIR/engine/` — GPT-SoVITS 源码克隆
- `INSTALL_DIR/engine/GPT_SoVITS/pretrained_models/` — 预训练权重
- `INSTALL_DIR/voices/` — 音色库（每音色一子目录：`ref.wav` + `ref.txt` 提示文本 + `ref.lang` 语言）
- `INSTALL_DIR/requirements.txt` — 管理服务依赖（fastapi、uvicorn、httpx、huggingface_hub、soundfile、numpy）
- `INSTALL_DIR/scripts/install.ps1` — 参考安装脚本（国内 pip 镜像 + 克隆 GPT-SoVITS + 下载权重）
- `SCAFFOLD_REF` — 内置脚手架参考路径（可复制 app/scripts/requirements/manifest）

## 国内镜像（必须）

> **中国大陆网络下，以下镜像必须使用**：HuggingFace 无法直连，Python 库必须走清华/中科院镜像。

- pip：**清华** `https://pypi.tuna.tsinghua.edu.cn/simple`（或**中科院 USTC** `https://mirrors.ustc.edu.cn/pypi/simple/`、阿里云 `https://mirrors.aliyun.com/pypi/simple/`）
- 模型权重：**优先 ModelScope(魔搭)** `lj1995/GPT-SoVITS`（可用环境变量 `TTS_MODELSCOPE_REPO` 覆盖）；失败再回退 `HF_ENDPOINT=https://hf-mirror.com`（建议 `HF_HUB_DISABLE_XET=1`）
- GitHub：克隆 GPT-SoVITS 直连失败时用 `ghproxy.com` 前缀镜像
- 安装示例：
  ```powershell
  .venv\Scripts\python.exe -m pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple --trusted-host pypi.tuna.tsinghua.edu.cn
  ```

## 安装步骤（按序）

1. **准备工程文件**  
   若缺 `app/server.py` / `scripts/install.ps1` / `requirements.txt` / `manifest.json`：从 `SCAFFOLD_REF` 复制或按参考自行生成。保留用户已有的 `.venv` / `engine` / `voices`。

2. **探测 Python 3.10+**（优先 `py -3.10` 或 `python`）

3. **创建 venv 并安装管理服务依赖**（可参考 `SCAFFOLD_REF\scripts\install.ps1`）  
   ```powershell
   cd INSTALL_DIR
   powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1 -InstallDir INSTALL_DIR
   ```
   脚本会：
   - 创建 `.venv` 并用国内镜像安装 `requirements.txt`
   - `git clone --depth 1 https://github.com/RVC-Boss/GPT-SoVITS.git` 到 `engine/`（GitHub 失败则尝试 `ghproxy.com` 镜像）
   - 权重下载：**优先 ModelScope(魔搭)** `lj1995/GPT-SoVITS`（可用 `TTS_MODELSCOPE_REPO` 覆盖），失败回退 `huggingface_hub`（hf-mirror）——GPT/SoVITS 权重与 `chinese-hubert-base`、`chinese-roberta-wwm-ext-large` 到 `engine/GPT_SoVITS/pretrained_models/`
   - 若 api_v2 运行需要额外依赖（torch/torchaudio 等），参考 GPT-SoVITS 官方 `requirements.txt` 安装

4. **冒烟测试**  
   ```powershell
   .\.venv\Scripts\python.exe -c "import fastapi; from app import server, tts; print('ok')"
   Test-Path .\engine\api_v2.py
   ```

5. **（可选）放置示例音色**  
   在 `voices\示例音色\` 放置 `ref.wav` + `ref.txt`（该音频的转写文本）+ `ref.lang`（`zh`/`en`/`ja`/`auto`）。音色越多越好用；无音色时合成会报 `no_voice`。

6. **标记完成**  
   - 创建空文件 `INSTALL_DIR\.install-ok`
   - 写入 `INSTALL_DIR\.tts-agent-result` 首行 `ok=true`
   - **不要**启动管理服务或 api_v2 推理进程

## 自我修复模式（CONSOLE_LOG 已由插件提交给 dsh）

1. 以「最近失败焦点」为准判断根因；更早日志仅参考。
2. 常见修复：
   - 缺 `engine/api_v2.py` → 重跑 git clone（换镜像）；无 git 则安装 git 或改用下载 zip 解压
   - pip 失败 → 换国内镜像重装 requirements；api_v2 缺 torch → 用官方 GPT-SoVITS requirements 装 torch（CUDA 版本按 nvidia-smi 驱动匹配）
   - 权重缺失 → 重下到 `engine/GPT_SoVITS/pretrained_models/`（hf-mirror）；单个文件失败不影响整体，能跑即可
   - import 失败 → 检查 venv 与 `app/` 是否完整
   - 管理服务启动即退出 / `uvloop` 报错 → `pip uninstall -y uvloop`，并确保 `app/server.py` 使用 `loop="asyncio"`
3. 已下载权重勿删；仅修 venv / engine / 脚本。
4. 冒烟后写 `.install-ok` 与 `.tts-agent-result`；回复 `repair_ok=1`。
5. **不要启动** `python -m app` 或 `api_v2.py`。

## 约束

- 不要启动管理服务或推理进程（启停由插件负责）。
- 不要删除用户已有的 `engine/` 权重（除非损坏且任务明确要求重下）。
- 磁盘不足时先警告用户再继续（GPT-SoVITS 全套约 6–12GB，建议预留 ≥12GB）。

## 成功标准

- `INSTALL_DIR\.install-ok` 存在
- `.venv\Scripts\python.exe -c "from app import server"` 成功
- `engine\api_v2.py` 存在
- 写入 `.tts-agent-result`（`ok=true`）；失败写 `ok=false` + `reason=`
- 回复：`install_ok=1`、`venv_ok=`、`engine_ok=`、`gpt_weights=`、`sovits_weights=`（若已下载）
