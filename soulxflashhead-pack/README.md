# SoulX-FlashHead Lite 实时数字人（本地后端脚手架）

音频驱动的**实时**数字人：**一张人物图 + 一段语音** → **512×512 @25fps 口型同步 mp4**。
底层是 [Soul-AILab/SoulX-FlashHead](https://github.com/Soul-AILab/SoulX-FlashHead) 的
`SoulX-FlashHead-1_3B` Model_Lite 权重 + 官方流式推理循环，跑在**本插件自己的 Python 服务**上
（默认 `127.0.0.1:8198`，与 InfiniteTalk 的 8199 互不干扰）。建议预留 **≥30GB** 磁盘。

## 为什么是「服务 + 原始仓库」

官方仓库的 `flash_head/inference.py` 用**相对路径**读 `flash_head/configs/infer_params.yaml`，
所以本插件不改造推理代码：把仓库整份放在 `<InstallDir>\SoulX-FlashHead`，由
`mtnode_server.py`（本包 `server.py`）在仓库根 `cwd` 起来，暴露一套极简 HTTP 契约：

| 方法 / 路径 | 用途 |
|---|---|
| `GET /health` | 存活 + 权重是否已加载 |
| `POST /generate` | 入队一次生成（image_path / audio_path / steps / seed / output_path） |
| `GET /job?id=` · `GET /jobs` | 查任务进度（含 fps / rtf / ms_per_chunk） |
| `POST /cancel` | 取消当前任务 |
| `POST /benchmark` | 跑一次 2 块真实基准（控制台「实时基准」） |
| `POST /free` · `POST /api/shutdown` | 还显存 / 关服务 |

## 权重清单（SoulX-FlashHead/models 下）

| 组件 | 落盘位置 | 来源 |
|------|----------|------|
| 扩散模型（Lite 蒸馏 1.3B） | `SoulX-FlashHead-1_3B/Model_Lite/diffusion_pytorch_model.safetensors` | Soul-AILab/SoulX-FlashHead-1_3B（ModelScope 优先） |
| VAE | `SoulX-FlashHead-1_3B/VAE_LTX/diffusion_pytorch_model.safetensors` | 同上 |
| 音频编码器 | `wav2vec2-base-960h/` | facebook/wav2vec2-base-960h（ModelScope 有镜像） |

输出口径固定 512×512、25fps；`frame_num: 33` 与 `vae_stride [8,32,32]` 决定**首块 9 帧 + 之后每块 24 帧**。

## 默认优化（全部默认开）

1. **torch.compile**：宿主用 `MT_FLASHHEAD_COMPILE=1` 起后端；编译失败自动退回不编译重跑一次；
2. **flash-attention（硬门槛）**：`flash_attn 2.8.3+cu128torch2.8.0` 预编译轮子（torch 固定 2.8.0+cu128），
   失败回落 GitHub Release → 镜像 → 本地轮子 → 源码编译；**装不上或 kernel 跑不通 = 安装失败**；
3. **SageAttention（软优化）**：能装就装，`--sage` 走它，失败只警告；
4. **fp16 + VAE 分片**：逐块释放显存，16G 卡可用。

## 快速开始

安装与启停都走 MTNode 插件卡片 / 控制台（步骤表真源 `steps.json`，脚本 `scripts/install.ps1`）。
手动调试时才用：

```powershell
# 起服务（先 cd 进仓库根，否则 infer_params.yaml 找不到）
cd <InstallDir>\SoulX-FlashHead
venv\Scripts\python.exe mtnode_server.py --install-dir <InstallDir> --port 8198

# 只做自检 + 2 块实时基准（打印 ACCEL 与 BENCH-OK）
venv\Scripts\python.exe mtnode_server.py --install-dir <InstallDir> --check
```

或直接 `start_backend.cmd`（固定 8198）。
