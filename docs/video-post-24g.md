# 视频后处理 24G 实测（纯超分 / 纯补帧）

> 目的：在 RTX 4090 24G 上，用已装好的 MiniMax H3 ComfyUI 后端，对现成短视频分别跑**一次纯超分（不补帧）**与**一次纯补帧（不超分）**，实测峰值显存与耗时，确认 24G 安全档不 OOM。
> 实测日期：2026-09-13 21:24–21:31（本机时间）

## 一、结论（先说结果）

| 用例 | 24G 安全档参数 | 输出 | 峰值显存(整卡) | 耗时 | OOM |
|------|----------------|------|----------------|------|-----|
| 纯超分（不补帧） | `RealESRGAN_x4plus.pth` + `targetLongSide=3840` + `per_batch=1` | 3840×2112 / 124 帧 / 24fps / 带音轨 | **16162 MiB（≈15.8 GiB，占 24G 的 65.8%）** | **341 s**（ComfyUI 自报 336.99 s） | 否 |
| 纯补帧（不超分） | `rife47.pth` + `multiplier=2` + `batch_size=1` + `clear_cache_after_n_frames=2` | 1280×704 / 247 帧 / 48fps / 带音轨 | **2286 MiB（≈2.2 GiB，占 24G 的 9.3%）** | **35 s**（ComfyUI 自报 30.72 s） | 否 |

- **两档都在 24G 安全档一次跑通，没有 OOM，没有触发降档**。峰值时刻整卡仍有 **8402 MiB（≈8.2 GiB）空闲**，`--reserve-vram 4` 的 4G 保留下限被满足。
- **失败档位：本轮无**。因此 `downgradePostOptions()`（超分长边减半、补帧退回最小缓存）这条降级路径**未被触发**，无需落回更低档。
- **已实测的安全阈值（4090 24G 口径）**：
  - 超分：源 1280×704 → 目标长边 3840（输出 3840×2112）+ `per_batch=1`，峰值 15.8 GB，**可用**（余量 8.2 GB）。
  - 补帧：1280×704 @2x，峰值 2.2 GB，**可用**（余量 21.9 GB）。
  - 超分是显存大头，且**由目标长边（分辨率）而非帧数决定峰值**：Real-ESRGAN x4 是整图推理（非分块），单帧 1280×704 在 x4 中间特征上就要十几 GB；`per_batch=1` 只保证逐帧、不叠加批次，不降低单帧峰值。要压显存只能降 `targetLongSide`（24G 安全档的降级正是这么做的）。
- **待验证的边界（本轮未测，勿当结论）**：源长边 > 1280 或目标长边 > 3840 的超分档位本轮未跑；按上面 65.8% 的占用率外推，源长边 1920 直出 3840 请先按降档口径钳到 `targetLongSide≤3840` 再试。

## 二、环境

- GPU：NVIDIA GeForce RTX 4090，24564 MiB，驱动 610.88（CUDA UMD 13.3）
- 空闲基线：桌面占用约 1276–1492 MiB（下表峰值均为**整卡 used**，含这部分基线；扣基线后超分净增 ≈14.7 GiB）
- ComfyUI：`E:\mtnode-plugins\video\ComfyUI`（venv：`ComfyUI\venv\Scripts\python.exe`，torch 2.9.1+cu130）
- 权重：`models\upscale_models\RealESRGAN_x4plus.pth`（63.9 MB）、`custom_nodes\ComfyUI-Frame-Interpolation\ckpts\rife\rife47.pth`（20.4 MB）
- 自定义节点：`ComfyUI-KJNodes`（`ImageUpscaleWithModelBatched`）、`ComfyUI-Frame-Interpolation`（`RIFE VFI`）
- h3 宿主配置（`%APPDATA%\pipeline-console\pipeline-console\h3\config.json`）：`installDir=E:\mtnode-plugins\video`、`port=8188`、`cpuVae=false`、`optDisablePinnedMemory=true`、`optFp16Intermediates=true`、`optExpandableSegments=true`、`optReserveVramGb=4`
- 源视频（现成短视频，H3 生成产物）：`ComfyUI\output\video\MiniMax_H3_00020_.mp4`，1280×704，24 fps，124 帧，5.17 s，含音轨

## 三、方法

1. 用 **h3 宿主自己的后端端点与工作流图**跑，不另起一套：宿主 `postProcessVideo()` 提交到 `http://127.0.0.1:8188/prompt`，图由 `buildPostWorkflow()` 生成；本轮以同样的端点、同样的图、同样的 24G 安全档参数（`resolvePostOptions()`）提交，源视频按宿主做法先放进 `ComfyUI\input`。
2. 启动参数与宿主 `startBackend()` 完全一致（config 里 `cpuVae=false`，故不加 `--cpu-vae`）。
3. 显存用独立采样进程每 200 ms 取一次 `nvidia-smi --query-gpu=memory.used`，按「提交 prompt → 产出视频」的时间窗取峰值。
4. 每次提交前调 `POST /free {unload_models, free_memory}` 释放上一阶段模型（与宿主一致）。

## 四、命令

### 1) 启动后端（= 宿主口径）

```powershell
cd E:\mtnode-plugins\video\ComfyUI
$env:PYTORCH_CUDA_ALLOC_CONF = "expandable_segments:True"
.\venv\Scripts\python.exe main.py --listen 127.0.0.1 --port 8188 `
  --disable-pinned-memory --fp16-intermediates --reserve-vram 4
# 就绪判据: GET http://127.0.0.1:8188/system_stats 返回 200
```

### 2) 显存采样（独立进程）

```powershell
while ($true) {
  $ms = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $u  = (& nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits)
  "$ms,$u" | Add-Content E:\...\vram.csv
  Start-Sleep -Milliseconds 200
}
```

### 3) 提交后处理任务（POST /prompt）

释放显存后再提交：

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8188/free `
  -ContentType 'application/json' -Body '{"unload_models":true,"free_memory":true}'
```

**纯超分（不补帧）** —— 源视频先放 `ComfyUI\input\h3bench_upscale_src.mp4`：

```json
{"prompt": {
  "1": {"class_type":"LoadVideo","inputs":{"file":"h3bench_upscale_src.mp4"}},
  "2": {"class_type":"GetVideoComponents","inputs":{"video":["1",0]}},
  "3": {"class_type":"UpscaleModelLoader","inputs":{"model_name":"RealESRGAN_x4plus.pth"}},
  "4": {"class_type":"ImageUpscaleWithModelBatched","inputs":{"upscale_model":["3",0],"images":["2",0],"per_batch":1}},
  "5": {"class_type":"ImageScale","inputs":{"image":["4",0],"upscale_method":"lanczos","width":3840,"height":2112,"crop":"disabled"}},
  "6": {"class_type":"CreateVideo","inputs":{"images":["5",0],"audio":["2",1],"fps":24,"bit_depth":8}},
  "7": {"class_type":"SaveVideo","inputs":{"video":["6",0],"filename_prefix":"video/h3bench_upscale","format":"auto","codec":"auto"}}
}, "client_id": "<uuid>"}
```

**纯补帧（不超分）** —— 源视频放 `ComfyUI\input\h3bench_interp_src.mp4`：

```json
{"prompt": {
  "1": {"class_type":"LoadVideo","inputs":{"file":"h3bench_interp_src.mp4"}},
  "2": {"class_type":"GetVideoComponents","inputs":{"video":["1",0]}},
  "3": {"class_type":"RIFE VFI","inputs":{"ckpt_name":"rife47.pth","frames":["2",0],
        "clear_cache_after_n_frames":2,"multiplier":2,"fast_mode":false,"ensemble":true,
        "scale_factor":1.0,"dtype":"float32","torch_compile":false,"batch_size":1}},
  "4": {"class_type":"CreateVideo","inputs":{"images":["3",0],"audio":["2",1],"fps":48,"bit_depth":8}},
  "5": {"class_type":"SaveVideo","inputs":{"video":["4",0],"filename_prefix":"video/h3bench_interp","format":"auto","codec":"auto"}}
}, "client_id": "<uuid>"}
```

轮询 `GET /history/<prompt_id>` 直到 `status.completed`；出错时取 `status.messages` 里的 `execution_error` 文本，按宿主的 OOM 正则
`/out of memory|OutOfMemory|insufficient memory|allocation on device|CUBLAS_STATUS_ALLOC_FAILED|CUDNN_STATUS_ALLOC_FAILED/i`
判定是否需要降一档重试。

### 4) 降档路径（本轮未触发，留档）

- 超分：`targetLongSide = max(1280, targetLongSide/2)`、强制 `per_batch=1`；
- 补帧：`multiplier = min(2, multiplier)`、`clear_cache_after_n_frames=1`、`batch_size=1`；
- 降档后先 `POST /free` 再重提交，只重试一次。

### 5) 收尾

```powershell
Stop-Process -Id <后端 pid> -Force   # 实测结束已停，显存回落至 1276 MiB
```

## 五、原始记录

- 超分窗口：`2026-09-13T13:25:00.331Z → 13:30:41.359Z`（返回码 0，attempt 0 成功）
- 补帧窗口：`13:30:41.361Z → 13:31:16.447Z`（attempt 0 成功）
- 显存采样：超分窗 1324 个样本，峰值 16162 MiB / 最低 1476 MiB；补帧窗 139 个样本，峰值 2286 MiB / 最低 1663 MiB；全窗峰值 16162 MiB
- ComfyUI 自报：`Prompt executed in 336.99 seconds`（超分）、`Prompt executed in 30.72 seconds`（补帧）；日志内无 `out of memory` / 无降档记录
- 产物（保留作证据）：
  - `E:\mtnode-plugins\video\ComfyUI\output\video\h3bench_upscale_a0_00001_.mp4`（5.09 MB，3840×2112，124 帧，24 fps，含音轨）
  - `E:\mtnode-plugins\video\ComfyUI\output\video\h3bench_interp_a0_00001_.mp4`（0.92 MB，1280×704，247 帧，48 fps，含音轨）
  - 输入副本：`ComfyUI\input\h3bench_upscale_src.mp4`、`ComfyUI\input\h3bench_interp_src.mp4`

## 六、16G 流式档实测（CPU 自检 + 口径说明）

> 上面第一至五节是**旧图链（ComfyUI `ImageUpscaleWithModelBatched`）在 4090 24G 上的实测**，只作对照与兜底路径存档。
> 超分的默认路径已换成**逐帧分块流式**（`h3-pack/post/stream_upscale.py`），本节记录这条新链的实测事实。
> 实测日期：2026-09-14（本机时间） · 机器：与第二同一台（RTX 4090 24G / 系统内存未变）

### 6.1 先把「为什么换」说清楚

旧图链的峰值**只由分辨率与时长决定，与显存无关**：`ImageUpscaleWithModelBatched` 逐批过 GPU 后把结果 `.cpu()` 攒在系统内存，最后再 `torch.cat + .float()` 复制一份 —— 也就是整段视频的全部帧张量同时躺在 RAM 里，峰值 ≈ 帧数 × 源像素 × 模型倍数² × 4B。

- 15 s @720p（1280×720×30fps = 450 帧）走 x4 中间张量 ≈ 450 × 1280×720 × 16 × 4B ≈ **21 GB**，再加 `.float()` 副本与输出帧，**64 GB 也会见顶**；
- 图上 `per_batch` / `tile` 只能压显存，**压不住 RAM**，所以「降档重试」对 RAM 型 OOM 基本无效；
- 新链把每帧按 tile 分块过模型、拼好一帧就立刻编码写盘并丢掉张量，**常驻内存只与「一个 tile + 一帧输出画布」有关，与视频多长无关** —— 这就是「16G 也能用」的依据。

### 6.2 已实测：CPU 自检整链跑通（本机真实数字）

命令（与本篇其它命令同口径，脚本在仓库内真源路径）：

```powershell
& E:\mtnode-plugins\video\ComfyUI\venv\Scripts\python.exe `
  E:\dev\tools\pipeline-console\h3-pack\post\stream_upscale.py `
  --self-test --json-out <临时文件>
```

自检做的事：纯 CPU 生成 1 个 96×64 / 3 帧 / 8 fps / 带静音 AAC 的假视频 → PyAV 顺序 decode → `--tile 64` / `--overlap 8` 分块过模型 → 编码 yuv420p/libx264 → 从源文件直拷音轨 → 回读校验帧数与分辨率。
权重：**随机初始化**（`weights: "random-init"`，自检刻意不加载 `RealESRGAN_x4plus.pth` —— 画面无意义，只验链路口径）。

| 项 | 实测值 | 备注 |
|----|--------|------|
| 退出码 | **0** | `{"type":"done","ok":true, "selfTest":true}` |
| 输出分辨率 | 384×256（= 96×64 × x4） | 与 `modelScale=4`、`requestScale=4` 一致 |
| 输出帧数 / 音轨 | 3 帧 / 1 条音轨（18 个音频包） | 回读校验 `verify.frames=3`、`verify.audioStreams=1` |
| `seconds`（脚本自报链路耗时） | **1.425 s** | 96×64 小图 ×3 帧，含模型前向 + 编码 + 音轨直拷 |
| 墙钟（含 python/torch 导入） | **3.37 s** | 命令行整体耗时 |
| `peakRamMb`（进程 RSS 峰值） | **698.4 MB** | **含 python 3.10 + torch 2.9.1 常驻 + 3 帧输出画布** |
| `peakVramMb` | **0.0 MB** | `--self-test` 强制 `--device cpu`，无显存占用 |
| 输出文件 | 9870 B | 落 `%TEMP%\stream-upscale-selftest-*\out.mp4`，跑完即清 |

**口径说明（不要把上表读成「15 秒片只要 700 MB」）**：

- 698.4 MB = **python + torch 的固定底座（数百 MB）+ 一个 tile + 一帧输出画布**，其中底座与视频无关；
- 自检是 **96×64 / tile 64 的小图**，而真实 720p 片的输出画布是 3840×2112 float32（≈ 97 MB/帧）那一档，tile 内前向的中间张量也按 tile 边长走 —— 所以真实峰值会明显高于 698 MB；
- 但**关键结论成立**：常驻内存只与「一个 tile + 一帧输出画布」有关，**不随帧数/时长增长**，这是与旧图链「峰值 ∝ 帧数」的本质区别，也是 16G 可用的依据。
- 自检顺带修掉一个真实 bug：`upscale_frame` 里 `net(crop)` 在 `inference_mode` 下产出的张量带 inference 标记，随后 `out.mul_(win)` 会被 torch 拒绝（`Inplace update to inference tensor outside InferenceMode is not allowed`）。已在 `out[0].float().cpu()` 后补 `.clone()`，自检由 exit 1 转 exit 0。

### 6.3 待用户在真机验证（本会话未测，勿当结论）

- **RAM 峰值与 15 s 片端到端**：真实 720p/1080p、15 s 级视频在 16G 内存机器上的实际 `peakRamMb` 与耗时 —— 本会话只跑了 CPU 小图自检，**没有跑真实 GPU 长视频**；
- **显存峰值**：`--precision fp16` + `--tile 512` 在真实分辨率下的 `peakVramMb`（自检在 CPU 上，该项恒为 0）；
- **画质**：随机初始化权重下无法评估，需用户用真机加载 `RealESRGAN_x4plus.pth` 出片肉眼确认；
- **x2 档**：`--scale 2` 走「x4 权重 + 输出端缩回」的输出尺寸已在代码里确定（`min(目标长边, 源长边 × 2)`），但未在真机出片验证。

### 6.4 随包结论（与本节同批核对）

- `build.json` 的 `h3-pack` → `extraResources` 条目**带 `filter` 白名单**（`app/**` `scripts/**` `custom_nodes/**` `workflows/**` + `requirements.txt` / `README.md` / `start_backend.cmd` / `.gitignore` / `manifest.json`）。`filter` 是白名单，因此新增的 `post/` 目录**必须显式列入**，否则打包后脚本不会进 `resources/h3-pack`，宿主只能一直回退旧图链。已补 `"post/**"`，`build.json` 按 JSONC 解析通过，现条目为 `app/** · post/** · scripts/** · custom_nodes/** · workflows/** + 5 个文件`。
- 脚本不写应用目录：除用户给的 `--output` 与 `--json-out` 外只写 `%TEMP%`（自检临时目录，跑完 `shutil.rmtree`）；代码内无 `__file__` / `app.getAppPath` 等取应用路径的写法，符合「数据不落应用文件夹」。
- `h3-pack/manifest.json` 未改动（版本仍 1.0.6）：`post/stream_upscale.py` 是宿主自带脚本，不经插件市场分发包体，故无需 bump；`minimax-h3-install` 技能按此 manifest 下载 `h3-runtime-1.0.6.zip`。

## 七、补帧 16G 流式档实测（CPU 自检 + 口径说明）

> 第六节是**超分**换链的实测；本节是**补帧（RIFE）** 换链的实测事实，新链 = `h3-pack/post/stream_interp.py`。
> 实测日期：2026-09-14（本机时间） · 机器：与第二节同一台（RTX 4090 24G / 系统内存未变）

### 7.1 先把「为什么换」说清楚

旧图链（ComfyUI `GetVideoComponents` → RIFE VFI 节点 → `CreateVideo`）的峰值同样**只由分辨率与时长决定，与显存无关**：三段节点各自把整段视频的帧序列攒在系统内存里（解帧一份、VFI 全片收集一份、编码前又一份），15 s @1080p30（450 帧）单份帧张量就约 **11 GB**，4x 补帧后帧数翻四倍、单份 ≈ **45 GB** —— 这就是「64G 内存也不够 15 秒片」的成因。

新链（`stream_interp.py`）用 PyAV 顺序 `decode`，同一时刻只持有**相邻两帧 + 一张中间帧**，逐对插值、每帧算完立刻 `libx264/yuv420p` 编码写盘，**常驻内存只与「相邻两帧 + 模型」有关，与时长/总帧数无关** —— 这是「16G 也能用」的依据。

### 7.2 已实测：CPU 自检整链跑通（本机真实数字）

命令（与本篇其它命令同口径，脚本在仓库内真源路径）：

```powershell
& E:\mtnode-plugins\video\ComfyUI\venv\Scripts\python.exe `
  E:\dev\tools\pipeline-console\h3-pack\post\stream_interp.py `
  --self-test --json-out <临时文件> --comfy-root E:\mtnode-plugins\video\ComfyUI
```

自检做的事：纯 CPU 生成 1 个 96×64 / 4 帧 / 8 fps / 带静音 AAC 的假视频 → PyAV 顺序 decode → 相邻两帧过 RIFE IFNet 插中间帧 → 编码 yuv420p/libx264 → 从源文件直拷音轨 → 回读校验输出帧数 / 分辨率 / 音轨，**2x 与 4x 两档都跑**，另对 9 个支持的架构版本各跑一次极小前向。
权重：**真实 `rife47.pth`**（`E:\mtnode-plugins\video\ComfyUI\custom_nodes\ComfyUI-Frame-Interpolation\ckpts\rife\rife47.pth`，架构自动判定 `4.7`）；`--device cpu`、`precision fp32`。

| 项 | 2x 实测值 | 4x 实测值 | 备注 |
|----|-----------|-----------|------|
| 退出码 | **0** | **0** | `{"type":"done","ok":true,"selfTest":true}` |
| 回读帧数 | **7 / 7** | **13 / 13** | = 4 + (4-1)×(倍率-1)，校验通过 |
| 回读分辨率 | 96×64 | 96×64 | 补帧不改分辨率 |
| 音轨 | 1 条 / 0.5 s | 1 条 / 0.5 s | 直拷，未重编码 |
| 输出时长 | 0.5 s | 0.5 s | 源 4 帧 @8fps = 0.5 s，**时长不变** |
| 输出帧率 | 16.0 fps | 32.0 fps | = 源帧率 × 倍率 |
| `seconds`（脚本自报） | **0.158 s** | **0.258 s** | 96×64 小图，含每对前向 + 编码 + 音轨直拷 |
| `peakRamMb`（进程 RSS 峰值） | **608.8 MB** | **617.1 MB** | **含 python 3.10 + torch 2.9.1 常驻** |
| `peakVramMb` | **0.0 MB** | **0.0 MB** | 自检强制 CPU，无显存占用 |
| 输出文件 | 3848 B | 4765 B | 落 `%TEMP%\stream-interp-selftest-*\out_*.mp4`，跑完即清 |
| 架构前向 | 4.0 / 4.2 / 4.3 / 4.5 / 4.6 / 4.7 / 4.10 / 4.17 / 4.26 **全部 ok** | | 4.0 族额外跑一次 `fastmode=False`（覆盖 Contextnet/Unet） |
| 墙钟（含 python/torch 导入） | **2.7 s**（两档合计） | | `seconds` 合计 0.416 s |

**口径说明（不要把 617 MB 读成「15 秒片只要 620 MB」）**：

- 617 MB ≈ **python + torch 固定底座（数百 MB）+ 相邻两帧 + 一张中间帧**，底座与视频无关；2x 与 4x 只差 8.3 MB，正是「多一轮插值不改变常驻量级」的直接证据；
- 自检是 **96×64 小图**，真实 1080p 帧的 float32 张量约 24 MB/帧、网络内部多尺度特征图按分辨率放大，所以真实峰值会明显高于 617 MB；
- 但**关键结论成立**：常驻内存只与「相邻两帧 + 模型」有关，**不随帧数/时长增长**，这是与旧图链「峰值 ∝ 时长」的本质区别，也是 16G 可用的依据。

### 7.3 自检暴露并修掉的一个真实 bug（4x 档必须过）

首次运行 **exit 1**，报错：`clamp() received an invalid combination of arguments - got (numpy.ndarray, int, int)`。

成因：`multiplier=4` 走递归插值 —— 第一轮算出中点后，**第二轮要拿这个中点当输入**，但 `interp_once` 的返回值是 `uint8 HxWx3` 的 **numpy** 帧，`_recursive_middles` 直接把它当张量喂回了 IFNet，于是 `torch.clamp` 收到 numpy 数组。2x 档不递归，所以只有 4x 会炸（自检两档都跑才暴露出来）。

最小修复（`stream_interp.py`，张量域留在递归里、只在产出时转 uint8）：

- 抽出 `interp_middle_tensor()` —— 负责 inference_mode 内的网络前向，返回**中间帧张量**（不转 numpy）；
- `interp_once()` 改为调用它并在 inference_mode 内 `tensor_to_rgb(...)`（保留「inference 张量转换留在块内」的防坑口径）；
- `_recursive_middles()` 递归全程传张量，`yield` 时才 `tensor_to_rgb(middle)` —— 递归不再经过 uint8 往返，精度与参考实现（Practical-RIFE 全程 float 张量）一致。

改后重跑 2x / 4x 均 exit 0，即上表数字。

### 7.4 待用户在真机验证（本会话未测，勿当结论）

- **RAM 峰值与 15 s 片端到端**：真实 720p/1080p、15 s 级视频在 16G 内存机器上的实际 `peakRamMb` 与耗时 —— 本会话只跑了 CPU 小图自检，**没有跑真实 GPU 长视频**；
- **显存峰值**：`--precision fp16` 在真实分辨率下的 `peakVramMb`（自检在 CPU 上，该项恒为 0）；补帧没有 tile 分块，显存主要跟单帧分辨率与精度有关，`--max-long-side` 是显式降显存的唯一开关；
- **画质**：本次自检虽然加载的是真实 `rife47.pth`（不是随机权重），但源是纯色假帧，无法评估画质，需用户用真机出片肉眼确认；
- **4x 档真机耗时**：小图 4x 比 2x 慢约 63%（0.258 s vs 0.158 s，含固定开销），真实分辨率下的耗时倍率未测。

### 7.5 随包结论（与本节同批核对，未改清单）

- `build.json` 的 `h3-pack` → `extraResources` 条目已在超分任务补上 `"post/**"`（`filter` 是**白名单**），因此新增的 `h3-pack/post/stream_interp.py` **自动随包**，无需再改 `build.json`，也无需改 `h3-pack/manifest.json`（版本仍 1.0.6，脚本是宿主自带件）。
- 脚本不写应用目录：除用户给的 `--output` 与 `--json-out` 外只写 `%TEMP%`（自检临时目录，跑完 `shutil.rmtree`）；全文无 `__file__` / `app.getAppPath` / `process.resourcesPath` 等取应用路径的写法，符合「数据不落应用文件夹」。
- 与超分脚本共享同一套 CLI 契约（stdout 换行分隔 JSON · stdin `cancel` 中断 · 退出码 0/1/2/3/4），宿主 `resolvePostEngine` 按同一口径选路与回退。
