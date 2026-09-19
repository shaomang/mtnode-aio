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

## 系统内存（RAM）

本方案 24G 是**显存**口径；系统内存另算：

- **超分 / 补帧链的峰值在 RAM，不在显存**：整段视频的帧张量（外加 float32 副本）攒在系统内存里逐帧过 GPU，
  峰值 ≈ 源像素 × 中间张量倍数²（x4 权重 = ×16 / x2 权重 = ×4）× 帧数。所以「显存空着、内存被跑满」是这条链的固有形状，不是故障。
- **最省内存的一档是「x2 倍率 + 原生 x2 权重」**：把 `RealESRGAN_x2plus.pth` 放进
  `ComfyUI\models\upscale_models\`（`download_models.ps1` 会顺带尝试从 `ai-forever/Real-ESRGAN` 拉一份，
  失败只 warn、不影响安装），超分节点选 x2 倍率时插件会自动优先用它 —— 中间张量只有 x4 的 1/4；
  没有该权重也能跑 x2（用 x4 权重 + 输出端缩回来，但内存口径仍按 x4 估）。
- 启动时务必给 ComfyUI 的系统内存缓存一个保留下限，否则它默认按「非活跃阈值 = 100% 内存（最高 128G）」
  留产物，64G 机器会被跑满：

  ```powershell
  python main.py --listen 127.0.0.1 --port 8188 --cache-ram 8 4
  ```

  插件控制台「24G 启动优化」里的**系统内存缓存保留下限**就是这一项（默认开、8G；置 0 = 不加该参数）。
- 插件还会在超分提交前按源分辨率 + 容器里的真实帧数估一次峰值：超预算先压目标长边，仍放不下就
  进超分前预缩放源帧，并在控制台 / 节点状态行写明取舍。

## 国内镜像（必须）

> **中国大陆网络下必须使用镜像**：HuggingFace 无法直连，Python 库须走清华/中科院镜像。

- **Python 库**：清华 `https://pypi.tuna.tsinghua.edu.cn/simple`（或中科院 USTC `https://mirrors.ustc.edu.cn/pypi/simple/`），`setup_env.ps1` 默认已用清华
- **torch cu130**：优先官方 `download.pytorch.org/whl/cu130`，失败自动回退阿里云 `mirrors.aliyun.com/pytorch-wheels/cu130`
- **模型权重**：优先 **ModelScope(魔搭)** `Comfy-Org/MiniMax-H3`（国内直连），失败回退 `hf-mirror.com`
- **GitHub**（ComfyUI / KJNodes）：直连失败用 `ghproxy.com` 前缀镜像

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
