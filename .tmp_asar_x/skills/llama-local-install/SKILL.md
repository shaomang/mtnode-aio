---
name: llama-local-install
title: llama.cpp 本地模型安装
description: 在用户指定目录安装 llama.cpp 本地模型后端：创建 venv、安装 Python 依赖、下载 llama-server（CUDA/CPU）、建立多模型管理服务契约（GGUF 目录/下载/部署/OpenAI 兼容代理 + API Key 鉴权）、冒烟验证。含自我修复指引。
---

# llama.cpp 本地模型插件 — 安装 / 修复

当用户或 MTNode 插件要求在某目录安装 / **自我修复** **llama.cpp 本地模型管理后端** 时使用本 skill。

插件调用时：

- **当前工作区就是 `INSTALL_DIR`**，可直接读写并执行命令
- **`SCAFFOLD_REF`（或 `.scaffold-ref`）仅作参考**：内置脚手架/脚本是示例实现，不是已完成的安装。请按下方目标自行准备目录；可按需从参考路径复制或改写，也可等价实现
- 不要假设插件已替你复制好脚手架
- 若任务附带 **CONSOLE_LOG**（插件 console 最近日志），优先根据日志定位并修复，不要盲目重装全部模型

## 目标

在 `INSTALL_DIR` 建立可运行的 llama.cpp 本地管理服务（FastAPI 管理 + llama-server 多模型编排），供 MTNode 插件启停。

完成后应满足：

- `INSTALL_DIR\.venv\Scripts\python.exe` 存在且 `import fastapi; from app import server` 成功
- `INSTALL_DIR\bin\llama-server.exe` 存在（官方 llama.cpp release，CUDA 构建优先，CPU 兜底）
- `INSTALL_DIR\models\` 目录存在（GGUF 模型库）
- `INSTALL_DIR\.api-key` 存在（管理服务 API Key，插件与调用方以 `Authorization: Bearer <key>` 鉴权）
- **不要**启动 `python -m app` 或 `llama-server` 推理进程（启停由插件负责）

## 目录约定

- `INSTALL_DIR/app/` — Python 管理服务（`python -m app <port>`；含 server.py / models.py / catalog.py / gpu.py / __main__.py）
- `INSTALL_DIR/.venv/` — 虚拟环境
- `INSTALL_DIR/bin/` — `llama-server.exe` 等 llama.cpp 二进制
- `INSTALL_DIR/models/` — GGUF 模型文件，按 `models/<modelId 的 /→__>/` 布局（如 `google/gemma-4-E4B-it` → `models/google__gemma-4-E4B-it/`）
- `INSTALL_DIR/.api-key` — API Key 鉴权文件（服务启动时若无则自动生成；插件在服务未起时也读它作回退）
- `INSTALL_DIR/.registry.json` — 模型注册表（`models: [{id, kind, ggufRepo, ggufFile, quant, chatTemplateFile, status, downloadedAt...}]`）
- `INSTALL_DIR/.deployed.json` — 部署实例（`instances: [{modelId, servedName, port, pid, vramGb, status, startedAt, error...}]`）
- `INSTALL_DIR/.want-deployed.json` — 期望常驻模型 id 列表（服务重启后 `restore_wanted_deploys` 自动恢复部署）
- `INSTALL_DIR/logs/llama-<port>.log` — 各 llama-server 实例日志（部署失败排查入口）
- `INSTALL_DIR/templates/` — 脚手架附带的 chat template（`gemma-4-it.jinja` 等）
- `INSTALL_DIR/requirements.txt` — 管理服务依赖（fastapi、uvicorn[standard]、httpx、pydantic、huggingface_hub）
- `INSTALL_DIR/scripts/install.ps1` — 参考安装脚本（国内 pip 镜像 + 下载 llama.cpp release）
- `SCAFFOLD_REF` — 内置脚手架参考路径（可复制 app/scripts/requirements/templates/manifest）

## 国内镜像（必须）

> **中国大陆网络下，以下镜像必须使用**：HuggingFace 无法直连，Python 库必须走清华/中科院镜像，GitHub Releases 可能无法直连。

- pip：**清华** `https://pypi.tuna.tsinghua.edu.cn/simple`（或**中科院 USTC** `https://mirrors.ustc.edu.cn/pypi/simple/`、阿里云 `https://mirrors.aliyun.com/pypi/simple/`）
- HuggingFace：**无法直连**，一律 `HF_ENDPOINT=https://hf-mirror.com`（建议 `HF_HUB_DISABLE_XET=1`）
- GitHub Releases（llama.cpp 二进制 zip）：直连失败自动回退 `ghproxy.com` 前缀镜像
- 安装示例：
  ```powershell
  .venv\Scripts\python.exe -m pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple --trusted-host pypi.tuna.tsinghua.edu.cn
  ```

## 安装步骤（按序）

1. **准备工程文件**  
   若缺 `app/server.py` / `app/models.py` / `app/catalog.py` / `scripts/install.ps1` / `requirements.txt` / `manifest.json` / `templates/`：从 `SCAFFOLD_REF` 复制或按参考自行生成。保留用户已有的 `.venv` / `bin` / `models` / `.registry.json`。

2. **探测 Python 3.10+**（install.ps1 依次试 `py -3.10` / `-3.11` / `-3.12`，再 `python`）

3. **创建 venv 并安装依赖、下载 llama-server**（可参考 `SCAFFOLD_REF\scripts\install.ps1`）  
   ```powershell
   cd INSTALL_DIR
   powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1 -InstallDir INSTALL_DIR
   ```
   脚本会：
   - 创建 `.venv` 并用国内镜像安装 `requirements.txt`
   - 从 `manifest.json` 的 `llamaRelease`（默认 `b10566`）下载 `llama-<release>-bin-win-cuda-12.4-x64.zip`，失败依次回退 `cuda-13.3`、`cpu` 包；GitHub 直连失败自动走 `ghproxy.com` 前缀镜像
   - 解压到 `bin/`，递归查找 `llama-server.exe` 拍平到 `bin\llama-server.exe`
   - `pip uninstall -y uvloop`（vLLM 迁移残留会致管理服务启动即退出）
   - 冒烟 `import fastapi; from app import server`，创建 `models/` 与 `.install-ok`

4. **冒烟测试**  
   ```powershell
   .\.venv\Scripts\python.exe -c "import fastapi; from app import server; print('ok')"
   Test-Path .\bin\llama-server.exe
   ```

5. **（按需）放置/下载测试模型 GGUF**  
   模型管理走管理 API（见下节）；也可直接把 GGUF 放进 `models/<id__>/`——管理服务启动时会 `scan_existing_models()` 自动扫描注册。参考 `google/gemma-4-E4B-it`：
   - GGUF 源：**优先** `unsloth/gemma-4-E4B-it-GGUF` 的 `gemma-4-E4B-it-Q8_0.gguf`（显存不足回退 `gemma-4-E4B-it-Q4_K_M.gguf`），再回退 `daniloreddy/...`、`mradermacher/...`（以 `app/models.py` 的 `GGUF_SOURCES` 为准）
   - **Gemma 4 必须有 `chat_template.jinja`**（从 `google/gemma-4-E4B-it` 拉取，或复制脚手架 `templates/gemma-4-it.jinja`）
   - `HF_ENDPOINT=https://hf-mirror.com` + `HF_HUB_DISABLE_XET=1`；若该目录已有 `.gguf` 则跳过
   - **自我修复且模型已齐全时跳过本步**
   - 部署时（由插件负责，勿在此步启动）：`--jinja --chat-template-file .../chat_template.jinja`、`--temp 1.0 --top-p 0.95 --top-k 64 --reasoning off`；**不要**硬编码 `-c 8192`（让 llama.cpp 自动设置上下文）

6. **标记完成**  
   - 创建空文件 `INSTALL_DIR\.install-ok`
   - 写入 `INSTALL_DIR\.llama-agent-result` 首行 `ok=true`
   - **不要**启动管理服务或 llama-server

## 管理服务 API 契约（插件依赖，实现 app/ 时勿缺）

以 `SCAFFOLD_REF` 的 `app/` 为权威实现；若自行生成需覆盖以下契约，否则插件面板/画布节点/模型下载部署不可用：

- **端口**：管理 `8765`（env `LLAMA_API_PORT`）；每个已部署模型在 **8100 起**分配独立推理端口（`llamaPortBase`，占用自动跳过）。插件以 `GET /api/health` 探测存活
- **鉴权**：`.api-key` 内容作 Bearer token（`X-API-Key` 头亦可）；除 `/api/health` 免鉴权外，其余接口校验 `Authorization: Bearer`
- **端点**：
  - `GET /api/health` → `{"ok": true, "engine": "llama.cpp"}`（免鉴权，插件存活探测）
  - `GET /api/status` → `{"apiBase": "http://127.0.0.1:8765/v1", "manageBase", "apiKey", "port", "deployed", "deployedModels", "gpu", "allocatedVramGb"}`（插件同步 OpenAI 兼容提供商与模型列表；`deployedModels` = 运行中实例的 servedName）
  - `GET /api/gpu`（GPU 状态 + 已分配显存）
  - `GET /api/catalog`（HF GGUF 搜索：`q`/`kind`/`limit`/`sort`/`sizeBand`/`recentOnly`，精选列表置顶，走 hf-mirror）+ `GET /api/catalog/detail?modelId=`
  - `GET /api/models`（本地注册表）；`POST /api/models/download`（body `{modelId, kind?, pipelineTag?}`）；`POST /api/models/deploy`（body `{modelId}`）；`POST /api/models/restore`（恢复 `.want-deployed.json` 期望常驻的模型）；`POST /api/models/stop`（body `{modelId}`）；`DELETE /api/models/{modelId}`（停 + 删权重目录 + 移出注册表）
  - `POST /api/shutdown`（插件停止时调用：`stop_all(clear_want=True)` 后优雅退出）
  - **OpenAI 兼容**：`GET /v1/models` + `/v1/{path}`（chat/completions 等）→ 代理到运行中实例：按 body `model` 匹配 servedName；未指定且仅一个运行实例则用它；无运行实例 `503 no_running_model`；实例端口失联 `502 engine_unreachable`；SSE 流（`text/event-stream`）透传
- **部署参数**：`llama-server -m <gguf> --host 127.0.0.1 --port <8100+> -ngl 99`；Gemma 4 追加 `--jinja --chat-template-file <chat_template.jinja>`（或 `--chat-template`）与 `--temp 1.0 --top-p 0.95 --top-k 64 --reasoning off`；部署后做 warmup 小请求（`1+1`、`max_tokens: 16`）确认权重加载后才置 `running`；部署前按 `vramGb` 校验显存（不足返回 `insufficient_vram`）
- **启动扫描**：服务启动时 `scan_existing_models()` 把 `models/` 下已有 GGUF 自动注册进 `.registry.json`（子目录名 `__` 还原为 `/`），并为 Gemma 4 补 `chat_template.jinja`
- **失败排查**：实例卡 `starting`/`failed` → 看 `logs/llama-<port>.log` 尾部含 error 的行

## 自我修复模式（CONSOLE_LOG 已由插件提交给 dsh）

1. 以「最近失败焦点」为准判断根因；更早日志仅参考。
2. 常见修复：
   - 缺 `llama-server.exe` → 重跑 `install.ps1` 或手动下载 release 到 `bin/`（CUDA 构建失败换 CPU 包）
   - pip 失败 → 换国内镜像重装 requirements
   - import 失败 → 检查 venv 与 `app/` 是否完整
   - 管理服务启动即退出 / `uvloop` 报错 → `pip uninstall -y uvloop`（vLLM 迁移残留），并确保 `app/server.py` 使用 `loop="asyncio"`
   - 模型下载失败 → 核对 `GGUF_SOURCES` 的 repo/文件名与 hf-mirror 可达性，逐级 fallback 源重试；Gemma 4 缺 `chat_template.jinja` 则补
   - 部署失败/卡 `starting` → 看 `logs/llama-<port>.log`；`engine_start_timeout`/`engine_warmup_timeout` 多为显存不足（`insufficient_vram` 或并发部署超 `vramGb`）或 GGUF 损坏/量化与构建不匹配；先 `POST /api/models/stop` 释放再重试
   - `503 no_running_model` → 没有运行中实例（未部署或部署失败）；`502 engine_unreachable` → 实例进程在但端口失联，查对应 log 与端口占用
3. 已下载 GGUF 勿删；仅修 venv / bin / 脚本 / 注册表。
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
- `.api-key` 存在
- 写入 `.llama-agent-result`（`ok=true`）；失败写 `ok=false` + `reason=`
- 回复：`install_ok=1`、`venv_ok=`、`llama_server=`、`model_gguf=`（若已下载）
