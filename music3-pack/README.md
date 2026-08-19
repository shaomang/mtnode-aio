# MiniMax Music 3（24G）

本地生成 App（Diffusers + Gradio/CLI）+ 可选 ComfyUI 工作流。显卡：**RTX 4090 24GB**。

## 24G 选定方案

| 路径 | 精度 / 量化 | 说明 |
|------|-------------|------|
| **App（推荐）** | `MiniMaxAI/MiniMax-Music3` BF16 + **auto CPU offload** | 官方 24G 方案，峰值约 17–22GB |
| ComfyUI（可选） | DiT **fp16** + Text Encoder **pruned INT8** + DAV | 见 `workflows/` |

不建议在 24G 上对 App 路径做激进量化；Comfy 长曲 OOM 时再换 DiT INT8 或开 `tiled_decode`。

## 快速开始（App）

```powershell
# 1) 环境（复用本机 CUDA torch）
.\scripts\setup_env.ps1

# 2) 下载官方权重 -> models/MiniMax-Music3
.\scripts\download_models.ps1 -Target app

# 3) 启动 Gradio（默认输出到仓库 output/）
.\start_backend.cmd
# 或: .\scripts\run_app.ps1
```

浏览器打开 http://127.0.0.1:7860 。界面参数：

| 参数 | 含义 |
|------|------|
| `prompt` | Structured Caption（Global Metadata / Vocal Details / Arrangement） |
| `lyrics` | 带 `[Verse]` / `[Chorus]` 等标签的歌词 |
| `audio_duration` | 目标时长秒（≤300） |
| `seed` | 随机种子 |
| `output_dir` | **音频保存目录**（默认 `E:\mt-music\output`） |
| `filename` | 可选文件名；空则自动命名 |
| `model_path` | 本地 `models/MiniMax-Music3` 或 HF id |
| `auto CPU offload` | 24G 建议开启 |

### CLI（同样写入指定文件夹）

```powershell
.\.venv\Scripts\python.exe -m app.generate `
  --prompt-file prompts\example_lofi.txt `
  --lyrics-file prompts\example_lyrics.txt `
  --audio-duration 60 `
  --seed 7 `
  --output-dir E:\mt-music\output `
  --filename demo_lofi.wav
```

成功后打印 `saved=...` 路径；WAV 为模型采样率 stereo（当前 checkpoint 为 **44.1 kHz**）。

## ComfyUI（可选）

```powershell
.\scripts\download_models.ps1 -Target comfy -ComfyRoot "D:\ComfyUI"
# 或同时下 App + Comfy：
.\scripts\download_models.ps1 -Target both -ComfyRoot "D:\ComfyUI" -IncludeInt8Dit
```

导入 [`workflows/minimax_music3_24g.json`](workflows/minimax_music3_24g.json)。默认：DiT fp16、Encoder pruned INT8、`tiled_decode=false`。

## Prompt

模板与示例：[`prompts/`](prompts/)。

```bash
npx skills add MiniMax-AI/MiniMax-Music3 --skill music-caption-rewriter
```

## 目录结构

```
mt-music/
├── app/                 # Diffusers 生成器 + Gradio
├── models/MiniMax-Music3/
├── output/              # 默认音频输出
├── prompts/
├── scripts/
└── workflows/           # ComfyUI 24G 工作流
```

## 许可

[MiniMax-Music3 Community License](https://huggingface.co/MiniMaxAI/MiniMax-Music3/blob/main/LICENSE)。

## 参考

- [MiniMaxAI/MiniMax-Music3](https://huggingface.co/MiniMaxAI/MiniMax-Music3)
- [ComfyUI MiniMax Music 3](https://docs.comfy.org/tutorials/audio/minimax/minimax-music-3)
- [官方 Demo](https://minimax-ai.github.io/music3-demo/)
