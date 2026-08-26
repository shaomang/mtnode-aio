# llama.cpp 本地模型管理（MTNode 插件后端）

基于 [llama.cpp](https://github.com/ggml-org/llama.cpp) 的 GGUF 模型下载、部署与 OpenAI 兼容 API 代理。

## 结构

- `app/` — FastAPI 管理服务 + `llama-server` 进程编排
- `scripts/install.ps1` — 创建 venv、安装依赖、下载官方 `llama-server` 到 `bin/`
- `models/` — 用户下载的 GGUF 权重（安装时创建）
- `bin/` — `llama-server.exe`（安装脚本下载）

## 安装

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -InstallDir .
```

或使用 MTNode 插件 UI / `skills/llama-local-install` Agent 流程。

## 国内镜像（必须）

> **中国大陆网络下必须使用镜像**：HuggingFace 无法直连，Python 库须走清华/中科院镜像。

- **Python 库**：清华 `https://pypi.tuna.tsinghua.edu.cn/simple`（或中科院 USTC `https://mirrors.ustc.edu.cn/pypi/simple/`）
- **llama.cpp 二进制**（GitHub Releases）：直连失败自动回退 `ghproxy.com` 镜像
- **GGUF 模型**：走 `hf-mirror.com`（`HF_ENDPOINT=https://hf-mirror.com`，`HF_HUB_DISABLE_XET=1`）
- 安装脚本 `scripts/install.ps1` 已内置以上镜像与回退，无需手动配置。

## 运行（通常由插件启停）

```bat
start_backend.cmd
```

管理 API 默认 `http://127.0.0.1:8765`，推理端口从 `8100` 起分配。
