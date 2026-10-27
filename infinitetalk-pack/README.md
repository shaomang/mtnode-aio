# InfiniteTalk 数字人（本地后端脚手架）

音频驱动的无限时长口播视频：**一张人物图**（I2V）或**一段源视频**（V2V）+ 一段语音，出
口型同步的 mp4。底层是 [MeiGen-AI/InfiniteTalk](https://github.com/MeiGen-AI/InfiniteTalk) 的
Wan2.1 I2V 14B 权重 + InfiniteTalk patch，跑在**独立安装的一份 ComfyUI** 上（默认 `127.0.0.1:8199`，
与 H3 的 8188 不冲突）。建议预留 **≥55GB** 磁盘，N 卡 24G 档最稳。

## 为什么用 ComfyUI 原生节点

ComfyUI 已内置 `WanInfiniteTalkToVideo`（`comfy_extras/nodes_wan.py`），并有官方示例工作流
`video_wan2_1_infinitetalk`。本插件**不克隆任何第三方自定义节点**，只下载权重 + 用原生节点组图，
所以 ComfyUI 升级不会把插件带崩。

## 权重清单（ComfyUI/models 下）

| 组件 | 落盘位置 | 来源 |
|------|----------|------|
| DiT（I2V 14B fp8） | `diffusion_models/wan2.1-i2v-14b-480p-fp8_e4m3fn_scaled.safetensors` | Kijai/WanVideo_comfy_fp8_scaled |
| InfiniteTalk patch（single） | `model_patches/wan2.1_infiniteTalk_single_fp16.safetensors` | Comfy-Org/Wan_2.1_ComfyUI_repackaged |
| 文本编码器 | `text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors` | Comfy-Org/Wan_2.1_ComfyUI_repackaged |
| VAE | `vae/Wan2_1_VAE_bf16.safetensors` | Kijai/WanVideo_comfy |
| 音频编码器 | `audio_encoders/wav2vec2-chinese-base_fp16.safetensors` | Kijai/wav2vec2_safetensors |
| 4 步蒸馏 LoRA | `loras/lightx2v_I2V_14B_480p_cfg_step_distill_rank64_bf16.safetensors` | Kijai/WanVideo_comfy |
| CLIP Vision | `clip_vision/clip_vision_h.safetensors` | Comfy-Org/Wan_2.1_ComfyUI_repackaged |

分辨率两档：`480p` = 832×480、`720p` = 1280×768，帧率 25fps。

## 默认优化（全部默认开）

1. **fp8 扩散模型**（16.6GB → 显存占用远低于 fp16）；
2. **lightx2v 4 步蒸馏 LoRA**（cfg=1、4 步出片）；
3. **SageAttention**（`triton-windows` + 匹配 venv 的 sageattention wheel，装不上安装直接失败）；
4. **分层卸载 / 显存水位**：宿主启动 ComfyUI 时带 `--reserve-vram`，24G 卡跑 720P 时自动换出。

## 快速开始

安装与启停都走 MTNode 插件卡片 / 控制台（步骤表真源 `steps.json`，脚本 `scripts/install.ps1`）。
手动调试时才用：

```powershell
# 启动（默认 127.0.0.1:8199）
.\start_backend.cmd
```

安装步骤（每一步在安装窗里一行）：磁盘 → ComfyUI 源码 → venv/CUDA torch → **SageAttention** →
7 份权重 → 文件清单 → 冒烟（起一次 ComfyUI，确认 `/object_info/WanInfiniteTalkToVideo` 可用）。

## 长音频怎么处理

- 任意音频先转 **16kHz 单声道 wav**；
- 宿主按 **81 帧（≈3.24s）** 一段切片：第一段用人物图 / 源视频首窗，之后每段把上一段的
  **末 9 帧**作为 `previous_frames` 续写；
- V2V 每段从**源视频对应时间窗**取帧（缩放到目标分辨率、25fps）；
- 已完成段落在 `<数据目录>/infinitetalk-local/jobs/<任务id>/` 保留，中断后点「继续」从断点续跑；
- 成片把**原始音轨**封回 mp4。

> 分段是宿主的窗口级续写；段边界可能有轻微接缝，这是当前实现已知的取舍。

## 镜像

- **Python 库**：阿里云 `mirrors.aliyun.com/pypi/simple`（torch 另走 SJTU / 阿里云 pytorch-wheels）
- **权重**：`hf-mirror.com` → 官方 `huggingface.co` 回退，curl 断点续传
- **GitHub**：`ghfast.top` → `gh-proxy.com`，最后直连

## 目录结构

```
<安装目录>/
├── ComfyUI/                  # 安装后生成（含 venv、models）
├── output/                   # ComfyUI 渲染产物（宿主按 mtime 取最新 mp4）
├── scripts/                  # install.ps1 / step.ps1 / sage_install.py
├── steps.json                # 安装步骤表（中英文案）
└── .install-ok               # 安装完成标记
```

任务中间产物在数据目录：`%APPDATA%\pipeline-console\infinitetalk-local\`。
