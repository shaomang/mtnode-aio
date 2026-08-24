---
name: llama-local-install
title: llama.cpp 本地模型安装
description: 在用户指定目录安装 llama.cpp 本地模型后端：创建 venv、安装 Python 依赖、下载 llama-server（CUDA/CPU）、冒烟验证。含自我修复指引。
---

# llama.cpp 本地模型插件 — 安装 / 修复

当用户或 MTNode 插件要求在某目录安装 / **自我修复** **llama.cpp 本地模型管理后端** 时使用本 skill。

插件调用时：

- **当前工作区就是 `INSTALL_DIR`**，可直接读写并执行命令
- **`SCAFFOLD_REF`（或 `.scaffold-ref`）仅作参考**：内置脚手架/脚本是示例实现，不是已完成的安装。请按下方目标自行准备目录；可按需从参考路径复制或改写，也可等价实现
- 不要假设插件已替你复制好脚手架
- 若任务附带 **CONSOLE_LOG**（插件 console 最近日志），优先根据日志定位并修复，不要盲目重装全部模型

## 目标

在 `INSTALL_DIR` 建立可运行的 llama.cpp 本地管理服务（FastAPI + llama-server），供 MTNode 插件启停。

完成后应满足：

- `INSTALL_DIR\.venv\Scripts\python.exe` 存在且 `import fastapi; from app import server` 成功
- `INSTALL_DIR\bin\llama-server.exe` 存在（来自官方 llama.cpp release，优先 CUDA 构建）
- `INSTALL_DIR\models\` 目录存在
- **不要**启动 `python -m app` 或 `llama-server` 推理进程

## 目录约定

- `INSTALL_DIR/app/` — Python 管理服务（`python -m app`）
- `INSTALL_DIR/.venv/` — 虚拟环境
- `INSTALL_DIR/bin/` — `llama-server.exe` 等 llama.cpp 二进制
- `INSTALL_DIR/models/` — GGUF 模型文件（按 `google/gemma-4-E4B-it` → `models/google__gemma-4-E4B-it/`）
- `INSTALL_DIR/requirements.txt` — 依赖清单（fastapi、uvicorn、httpx、huggingface_hub）
- `INSTALL_DIR/scripts/install.ps1` — 参考安装脚本（国内 pip 镜像 + 下载 llama.cpp）
- `SCAFFOLD_REF` — 内置脚手架参考路径（可复制 app/scripts/requirements/manifest）

## 国内镜像（必须）

- pip：`https://pypi.tuna.tsinghua.edu.cn/simple` 或阿里云 `https://mirrors.aliyun.com/pypi/simple/`
- HuggingFace：`HF_ENDPOINT=https://hf-mirror.com`，建议 `HF_HUB_DISABLE_XET=1`
- 安装示例：
  ```powershell
  .venv\Scripts\python.exe -m pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple --trusted-host pypi.tuna.tsinghua.edu.cn
  ```

## 安装步骤（按序）

1. **准备工程文件**  
   若缺 `app/server.py` / `scripts/install.ps1` / `requirements.txt` / `manifest.json`：从 `SCAFFOLD_REF` 复制或按参考自行生成。保留用户已有的 `.venv` / `bin` / `models`。

2. **探测 Python 3.10+**（优先 `py -3.10` 或 `python`）

3. **创建 venv 并安装依赖**（可参考 `SCAFFOLD_REF\scripts\install.ps1`）  
   ```powershell
   cd INSTALL_DIR
   powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1 -InstallDir INSTALL_DIR
   ```
   脚本会：
   - 创建 `.venv` 并用国内镜像安装 `requirements.txt`
   - 从 `manifest.json` 的 `llamaRelease`（默认 `b10566`）下载 `llama-<release>-bin-win-cuda-12.4-x64.zip`，失败则尝试 `cuda-13.3` 或 CPU 包
   - 解压到 `bin/` 并确保 `bin\llama-server.exe` 存在

4. **冒烟测试**  
   ```powershell
   .\.venv\Scripts\python.exe -c "import fastapi; from app import server; print('ok')"
   Test-Path .\bin\llama-server.exe
   ```

5. **（可选）下载测试模型 GGUF**  
   若任务要求验证 `google/gemma-4-E4B-it`（参考 [avenchat Gemma 4 + llama.cpp 指南](https://avenchat.com/zh/blog/run-gemma-4-with-llama-cpp)）：
   - **优先** Unsloth：`unsloth/gemma-4-E4B-it-GGUF` / `gemma-4-E4B-it-Q8_0.gguf`（显存不足再试 `gemma-4-E4B-it-Q4_K_M.gguf`）
   - 目标：`INSTALL_DIR\models\google__gemma-4-E4B-it\`
   - 同时确保 `chat_template.jinja` 存在（从 `google/gemma-4-E4B-it` 或脚手架 `templates/gemma-4-it.jinja` 复制）
   - 若该目录已有 `.gguf` 文件则跳过
   ```powershell
   $env:HF_ENDPOINT='https://hf-mirror.com'
   $env:HF_HUB_DISABLE_XET='1'
   .\.venv\Scripts\python.exe -c "from huggingface_hub import hf_hub_download; hf_hub_download(repo_id='unsloth/gemma-4-E4B-it-GGUF', filename='gemma-4-E4B-it-Q8_0.gguf', local_dir='models/google__gemma-4-E4B-it', local_dir_use_symlinks=False); print('ok')"
   ```
   **部署 llama-server 时**（由插件负责，勿在此步启动）：使用 `--jinja --chat-template-file .../chat_template.jinja`，`--temp 1.0 --top-p 0.95 --top-k 64`，`--reasoning off`（关闭 thinking 模式）；**不要**硬编码 `-c 8192`（让 llama.cpp 自动设置上下文）。
   **自我修复且模型已齐全时跳过本步。**

6. **标记完成**  
   - 创建空文件 `INSTALL_DIR\.install-ok`
   - 写入 `INSTALL_DIR\.llama-agent-result` 首行 `ok=true`
   - **不要**启动管理服务或 llama-server

## 自我修复模式（CONSOLE_LOG 已由插件提交给 dsh）

1. 以「最近失败焦点」为准判断根因；更早日志仅参考。
2. 常见修复：
   - 缺 `llama-server.exe` → 重跑 `install.ps1` 或手动下载 release 到 `bin/`
   - pip 失败 → 换国内镜像重装 requirements
   - import 失败 → 检查 venv 与 `app/` 是否完整
   - 管理服务启动即退出 / `uvloop` 报错 → `pip uninstall -y uvloop`（从 vLLM 迁移残留），并确保 `app/server.py` 使用 `loop="asyncio"`
3. 已下载 GGUF 勿删；仅修 venv / bin / 脚本。
4. 冒烟后写 `.install-ok` 与 `.llama-agent-result`；回复 `repair_ok=1`。
5. **不要启动** `python -m app` 或 `llama-server`。

## 约束

- 不要启动管理服务或推理进程（启停由插件负责）。
- 不要删除用户已有的 `models/` 权重（除非损坏且任务明确要求重下）。
- 磁盘不足时先警告用户再继续（单模型 Q4 约 3–5GB，建议预留 ≥20GB）。

## 成功标准

- `INSTALL_DIR\.install-ok` 存在
- `.venv\Scripts\python.exe -c "from app import server"` 成功
- `bin\llama-server.exe` 存在
- 写入 `.llama-agent-result`（`ok=true`）；失败写 `ok=false` + `reason=`
- 回复：`install_ok=1`、`venv_ok=`、`llama_server=`、`model_gguf=`（若已下载）
