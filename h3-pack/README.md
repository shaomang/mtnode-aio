# MiniMax H3（24G）

本地视频生成脚手架：ComfyUI + pruned INT8 DiT + NVFP4 文本编码器。显卡：**RTX 4090 24GB**。

## 24G 选定方案

| 组件 | 文件 | 约占用 |
|------|------|--------|
| DiT FL2VA | `minimax_h3_fl2va_pruned_int8_convrot.safetensors` | ~21GB |
| DiT Ref2VA | `minimax_h3_ref2va_pruned_int8_convrot.safetensors` | ~21GB |
| Text Encoder | `qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors` | ~16GB |
| VAEs | video fp16 + audio fp32 | ~6GB |

整机建议预留 **≥70GB** 磁盘（含 ComfyUI 与缓存）。

## 快速开始

```powershell
# 1) 环境（复用本机 CUDA torch；可由 dsh agent 探测）
.\scripts\setup_env.ps1

# 2) 下载 24G 权重
.\scripts\download_models.ps1

# 3) 启动 ComfyUI（默认 127.0.0.1:8188）
.\start_backend.cmd
```

显存紧张时可用：`.\scripts\start_backend.cmd --cpu-vae`（采样仍在 GPU）。

## 国内镜像（必须）

> **中国大陆网络下必须使用镜像**：HuggingFace 无法直连，Python 库须走清华/中科院镜像。

- **Python 库**：清华 `https://pypi.tuna.tsinghua.edu.cn/simple`（或中科院 USTC `https://mirrors.ustc.edu.cn/pypi/simple/`），`setup_env.ps1` 默认已用清华
- **torch cu130**：优先官方 `download.pytorch.org/whl/cu130`，失败自动回退阿里云 `mirrors.aliyun.com/pytorch-wheels/cu130`
- **模型权重**：优先 **ModelScope(魔搭)** `Comfy-Org/MiniMax-H3`（国内直连），失败回退 `hf-mirror.com`
- **GitHub**（ComfyUI / KJNodes / TeaCache）：直连失败用 `ghproxy.com` 前缀镜像

## 能力

| 模式 | 节点 | 输入 |
|------|------|------|
| FL2VA | `MiniMaxH3ImageToVideo` | 文本；可选首帧 / 末帧图 |
| R2V | `MiniMaxH3ReferenceToVideo` | 文本；参考图 ≤9、视频 ≤3、独立音频 ≤3 |

输出：视频 + 原生 32kHz 立体声音频；时长 4–15s @24fps。

## 目录结构

```
mt-h3/
├── app/                 # 冒烟 / 健康检查
├── scripts/             # setup / download / start
├── ComfyUI/             # 安装后生成
├── output/              # 可选导出目录
└── requirements.txt
```

## 参考

- [MiniMaxAI/MiniMax-H3](https://huggingface.co/MiniMaxAI/MiniMax-H3)
- [Comfy-Org/MiniMax-H3](https://www.modelscope.cn/models/Comfy-Org/MiniMax-H3)
