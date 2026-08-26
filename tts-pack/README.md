# GPT-SoVITS 本地 TTS（MTNode 插件后端）

基于 [GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS) 的本地文本转语音：音色（参考音频）管理、OpenAI 兼容 `/v1/audio/speech` API、API Key 鉴权。

## 结构

- `app/` — FastAPI 管理服务 + GPT-SoVITS `api_v2.py` 进程编排
- `engine/` — GPT-SoVITS 源码克隆（安装时创建）
- `voices/` — 音色库：每个音色一个子目录（`ref.wav` + `ref.txt` 提示文本 + `ref.lang` 语言）；训练完成的音色额外带 `weights.json`（GPT/SoVITS 权重）
- `projects/` — 训练项目：每个项目一个子目录（`audio/` 上传音频、`text/` 文字标注、`logs/train.log` 训练日志、`manifest.json` 记录）
- `scripts/install.ps1` — 创建 venv、装依赖、克隆 GPT-SoVITS、下载预训练权重

## 安装

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -InstallDir .
```

或使用 MTNode 插件 UI / `skills/tts-local-install` Agent 流程。

## 国内镜像（必须）

> **中国大陆网络下必须使用镜像**：HuggingFace 无法直连，Python 库须走清华/中科院镜像。

- **Python 库**：清华 `https://pypi.tuna.tsinghua.edu.cn/simple`（或中科院 USTC `https://mirrors.ustc.edu.cn/pypi/simple/`）
- **预训练权重**：优先 **ModelScope(魔搭)** `lj1995/GPT-SoVITS`（可用 `TTS_MODELSCOPE_REPO` 覆盖），失败自动回退 `hf-mirror.com`
- **GitHub**（GPT-SoVITS 源码）：直连失败自动回退 `ghproxy.com` 镜像
- 安装脚本 `scripts/install.ps1` 已内置以上镜像与回退，无需手动配置。

## 运行（通常由插件启停）

```bat
start_backend.cmd
```

管理 API 默认 `http://127.0.0.1:8770`；GPT-SoVITS 推理端口 `9880`。

## API（OpenAI 兼容）

```bash
# 文本转语音
curl -X POST http://127.0.0.1:8770/v1/audio/speech \
  -H "Authorization: Bearer $TTS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-sovits","input":"你好，世界","voice":"my-voice","response_format":"wav"}' \
  -o out.wav

# 管理
curl http://127.0.0.1:8770/api/status          # 状态 + API Key + 音色
curl http://127.0.0.1:8770/api/voices          # 音色列表
```

`POST /api/voices/add`（multipart：`file`=wav、`name`、`prompt_text`、`lang`）添加音色。

## 音频训练（GPT-SoVITS 微调）

数据要求（参考 GPT-SoVITS）：建议 **3–10 分钟**单人干净音频（可分多段，≥30 秒亦可）；文字标注**可选**——不提供将自动 ASR，提供（.txt 每行对应一个音频文件）更准更快。

```bash
# 新建项目
curl -X POST http://127.0.0.1:8770/api/projects \
  -H "Authorization: Bearer $TTS_API_KEY" -H "Content-Type: application/json" \
  -d '{"name":"我的音色"}'

# 上传数据（multipart：files=音频可多个，text_file=可选 .txt）
curl -X POST http://127.0.0.1:8770/api/projects/我的音色/upload \
  -H "Authorization: Bearer $TTS_API_KEY" \
  -F "files=@a.wav" -F "files=@b.wav" -F "text_file=@transcript.txt"

# 开始训练（进度：GET /api/projects/我的音色/status，含 pct / phaseLabel / logTail）
curl -X POST http://127.0.0.1:8770/api/projects/我的音色/train \
  -H "Authorization: Bearer $TTS_API_KEY"
curl http://127.0.0.1:8770/api/projects/我的音色/status -H "Authorization: Bearer $TTS_API_KEY"

# 取消
curl -X POST http://127.0.0.1:8770/api/projects/我的音色/cancel \
  -H "Authorization: Bearer $TTS_API_KEY"
```

训练完成（ASR→HuBERT→语义→s1 GPT→s2 SoVITS）后，自动把该音色注册进 `voices/<项目名>/`（含训练权重），可直接用 `voice=<项目名>` 合成，如：

```bash
curl -X POST http://127.0.0.1:8770/v1/audio/speech \
  -H "Authorization: Bearer $TTS_API_KEY" -H "Content-Type: application/json" \
  -d '{"model":"gpt-sovits","input":"你好，欢迎使用MTNode AI编排器！","voice":"我的音色","response_format":"wav"}' \
  -o preview.wav
```
