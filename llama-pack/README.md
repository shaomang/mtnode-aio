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
- **llama.cpp 二进制**（GitHub Releases）：依次用 `ghfast.top` → `gh-proxy.com` → `ghproxy.net` → `ghproxy.com` 代理，最后才直连
- **GGUF 模型**：走 `hf-mirror.com`（`HF_ENDPOINT=https://hf-mirror.com`，`HF_HUB_DISABLE_XET=1`）
- 安装脚本 `scripts/install.ps1` 已内置以上镜像与回退，无需手动配置。

## 运行（通常由插件启停）

```bat
start_backend.cmd
```

管理 API 默认 `http://127.0.0.1:8765`，推理端口从 `8100` 起分配。

## 在线模型列表是「固化」的

控制台「在线模型」第一次拉取时整页落盘冻结到 `.catalog-cache.json`（连同每个仓库的真实体积与
GGUF 文件头架构 —— 这两项探测最慢）。之后每次打开 / 刷新只按时间（`sort=createdAt`）问一次
「比已固化最新一条还新」的增量，其余条目一律沿用固化结果，镜像不可达时也照旧出列表。

要整页重新拉一遍（例如换了镜像），删掉 `.catalog-cache.json` 再打开列表，或直接请求
`GET /api/catalog?force=true`。
