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

## 运行（通常由插件启停）

```bat
start_backend.cmd
```

管理 API 默认 `http://127.0.0.1:8765`，推理端口从 `8100` 起分配。
