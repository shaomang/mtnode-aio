# SenseNova 本地文生图（MTNode 插件后端）

基于 **[SenseNova-U1.5-8B-MoT](https://www.modelscope.cn/models/SenseNova/SenseNova-U1.5-8B-MoT)**
（商汤「日日新」原生统一多模态权重，8B MoT，官方仓库
[OpenSenseNova/SenseNova-U1](https://github.com/OpenSenseNova/SenseNova-U1)）的**本地图像生成**后端：
给一段提示词（prompt），出一张官方训练分辨率桶内的图（1:1 = 2048×2048，最高原生 4K = 3:1 / 1:3 = 3456×1152），
可选 think 模式（模型先写规划文本再出图，规划文本落 `.think.txt`）。

Python venv + 官方 `sensenova_u1` 推理包（transformers 口径），**不上 FastAPI 之类的 Web 框架，
HTTP 服务只用标准库**。权重、venv、产物全部落在用户选定的安装目录，**不落应用文件夹**。

## 这是什么 / 不是什么

- ✅ 本地、离线可跑（权重目录可手填 `-ModelDir`，源码包可手填 `-SrcTarball`）；只监听 `127.0.0.1`。
- ✅ 一次 `/generate` = **一张图**（`batch_size` 固定 1；要多张请由上层节点逐次调用 / 抽卡，seed 各自回传）。
- ✅ 官方 11 个训练分辨率桶（`/health.resolutions` 直接给出，宿主下拉用它，**渲染层不抄第二份**）。
- ✅ 单卡 24GB 可跑：靠官方 `vram_mode` 分层卸载（bf16 权重 32.66GB > 显存，`full` 档在 24G 上必炸）。
- ✅ **参考图 / 图像编辑**：`/generate` 带 `refImages`（本机绝对路径，1–4 张）时走 `model.it2i_generate`，参考图作为图像前缀条件参与生成（对齐上游 `examples/editing/inference.py`）；响应 `mode="edit"` 与 `refImagesUsed` 回实际用上的张数；不带 `refImages` 仍是纯文生图（`mode="t2i"`）。参考图按上游 `--input_max_pixels auto` 预算**只缩不放**地等比缩小（前 2 张各约 2048×2048，更多张按 `(4096^2)/n` 摊分，下限 512×512）——编辑模式的前缀阶段要在参考图上跑 ViT，原样喂 4K 截图会让它慢一个量级。`imgCfgScale`（=`img_cfg_scale`，默认 1.0 = 关闭图像 CFG）只在编辑模式有意义。
- ❌ 不做蒙版局部重绘 / 画幅锁定 / 差分抠图，也不做图文交错（interleave）/ 视觉理解（VQA）。
- ❌ 不做流式返回、不做并发（同一时刻只允许一张，见 `busy`）；一张 2048×2048 在 24G 卡上是**分钟级长请求**。
- ⚠️ 官方参考环境是 **Linux + Python 3.11 + CUDA 12.8 + 24GB 级 NVIDIA 卡**；本包是 Windows 单机移植口径。

## 目录结构

```
sensenova-pack/                       （安装时复制到用户选定的 INSTALL_DIR）
├─ manifest.json                      插件清单（id: sensenova-local / entry: app / apiPort: 8774 / diskHintGb: 60）
├─ requirements.txt                   推理依赖（**torch 不在里面**，见下）
├─ start_backend.cmd                  手工启动入口（正常由 MTNode 启停）
├─ scripts/install.ps1                安装 / 修复脚本（幂等、可续传、全程国内镜像优先）
├─ app/
│   ├─ __init__.py                    版本号 + 服务名（mtnode-sensenova）
│   ├─ __main__.py                    标准库 HTTP 服务入口：`python -m app [port]`
│   ├─ server.py                      HTTP 服务 + 路由 + 并发保护 + 错误码（对接面冻结）
│   └─ engine.py                      sensenova_u1 懒加载（常驻）+ 分层卸载 + staged 进度 + 取消 + PNG 落盘
├─ src/SenseNova-U1-<ref>/            安装期解出来的 sensenova_u1 源码（pip install --no-deps 的对象）
├─ models/
│   ├─ SenseNova__SenseNova-U1.5-8B-MoT/   权重（约 32.66GB / 8 片 safetensors）
│   └─ .ok                            权重校验通过标记（8 片齐 + config.json + index.json + ≥30GB）
├─ outputs/                           缺省产物目录（调用方没给 outputDir 时用）
├─ .attn-backend                      安装期探出的注意力档位（flash / sdpa）
├─ .install-ok                        安装成功标记（上层据此判断装好了）
└─ .sensenova-agent-result            Agent 安装结果标记（ok=true|false [+ reason=...]）
```

## 手动安装

```powershell
cd <INSTALL_DIR>
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1 -InstallDir .
```

参数（全部可省）：

| 参数 | 说明 |
| --- | --- |
| `-InstallDir` | 安装目录（默认脚本所在目录的上一级）。**建议放空间充足的非系统盘**，如 `E:\dev\sensenova` |
| `-Python` | 显式指定 `python.exe`（本机有 3.11 又不想装 uv 时用） |
| `-TorchIndex` | 显式指定 torch 的 `--index-url`（跳过自动镜像选择；公司内网镜像填这里） |
| `-TorchWheel` | 本地 `torch-2.8.0*.whl` 路径（完全离线；同目录会顺带找 `torchvision-*.whl`） |
| `-Ref` | `sensenova_u1` 的 GitHub tag，默认 `comfyui-v0.3.0`（本包对接面按该 tag 逐行核对） |
| `-SrcTarball` | 已下载好的 SenseNova-U1 归档 `.tar.gz`，或**已解压的源码目录**（离线安装） |
| `-ModelDir` | 已有权重目录（离线安装；建目录联接进 `models\`，不复制 32.66GB） |
| `-ModelScopeRepo` / `-HfRepo` | 权重仓库名（默认 ModelScope `SenseNova/SenseNova-U1.5-8B-MoT` / HF `sensenova/…`） |
| `-Cpu` | 装 CPU 版 torch（**仅供调试**；官方不支持 CPU 推理） |
| `-Force` | 跳过显存 / 内存门槛（明知不够仍要装来看看） |
| `-SkipModels` / `-SkipDeps` / `-SkipPkg` / `-SkipTorch` / `-SkipSmoke` | 只修某一环时跳过其它环节（**权重已就位时别重下**） |

脚本顺序（每步打 `[sensenova-install] progress: NN`，失败写 `.sensenova-agent-result` 的 `reason=`）：

1. **探测 NVIDIA**：`nvidia-smi` 读显卡名 / 驱动主版本 / 显存 → 无 N 卡 `no_cuda`、
   显存 <20GB `vram_too_low`（**都是拦死**，因为权重 bf16 32.66GB，官方最低档 `low` 也是给 24G 卡准备的）
2. 探测内存（<32GB → `ram_too_low`：分层卸载要在**内存里**放未驻留的权重）与磁盘（<50GB 只告警）
3. **选 Python**：优先 `uv python install 3.11`（`UV_PYTHON_INSTALL_MIRROR` 指到 npmmirror，
   不卡 GitHub release）→ 回退本机 `py -3.11 / 3.12 / 3.13 / 3.10` → `python`
4. 建 `.venv`（`python -m venv` 优先，缺 pip 走 `ensurepip`，再退 `uv venv --seed`）+ 升级 pip（清华 → 阿里云）
5. 装 **CUDA 版 torch 2.8.0 + torchvision 0.23.0**（官方 requirements 钉 cu128）：
   **SJTU 镜像 → 阿里云镜像 → download.pytorch.org** 逐源尝试；驱动主版本 <570 自动降 `cu126`；
   装完立刻自检 `torch.cuda.is_available()`（假成功 = 装成 CPU 版，这里就拦下）
6. 装 `requirements.txt`（清华 → 阿里云）+ 校验 `transformers>=4.57.1`（低了认不出 `model_type: neo_chat`）
7. 装 **sensenova_u1 推理包**：PyPI **没有**这个包（已核实 404）→ 下 GitHub tag 归档 tarball
   （`ghfast.top` → `gh-proxy.com` → `ghproxy.net` → 直连），只解 `pyproject.toml + src/`，
   然后 `pip install <dir> --no-deps`；再探一次 flash-attn 写 `.attn-backend`
8. 下 **权重**：ModelScope `SenseNova/SenseNova-U1.5-8B-MoT`（国内直连）→ 失败回退
   `HF_ENDPOINT=https://hf-mirror.com`；校验 8 片 + `config.json` + `model.safetensors.index.json`
   + 分片合计 ≥30GB 才写 `models\.ok`
9. 核对工程文件清单
10. **mock 冒烟**（`MTNODE_SENSENOVA_MOCK=1`，不加载模型）：起服务 → `/health`（11 个分辨率桶）→
    `/generate` 出真 PNG → 并发第二发必须 429 `busy` → 中途 `/cancel` 必须 409 且不落产物 →
    `/progress` 回 `done` → `/shutdown`
11. 写 `.install-ok` + `.sensenova-agent-result`

> 断点续传：任何一步失败，**修好后重跑同一条命令即可**（已下好的权重分片、已解出的源码都不重来）。

运行（**由 MTNode 负责启停，不要常驻**）：

```powershell
cd <INSTALL_DIR>
.\.venv\Scripts\python.exe -m app 8774      # 或： start_backend.cmd [port]
```

## 端口与接口

默认端口 **8774**（`SENSENOVA_PORT` 覆盖，命令行参数最优先），只监听 `127.0.0.1`；
启动成功 stdout 打一行 `[sensenova] ready`。所有日志都是 `[sensenova] ...` 行式 stdout，
上层追加进 `<DATA>\sensenova\console.log`。

### 环境变量

| 变量 | 说明 |
| --- | --- |
| `SENSENOVA_PORT` | 端口（命令行参数优先），默认 8774 |
| `SENSENOVA_MODEL_DIR` | 已有权重目录；空 = 自动探测 `<INSTALL_DIR>\models` → ModelScope / HF 缓存 → 回官方 repo id（走 `HF_ENDPOINT`） |
| `SENSENOVA_DEVICE` | `cuda` / `cuda:0` / `cpu`；空 = 自动（有 CUDA 就用 CUDA） |
| `SENSENOVA_VRAM_MODE` | `fast`（默认，官方 24G 卡档）/ `balanced` / `low` / `full`（需 48G+ 或多卡） |
| `SENSENOVA_DTYPE` | `bfloat16`（默认）/ `float16` / `float32` |
| `SENSENOVA_ATTN_BACKEND` | `sdpa`（默认）/ `auto` / `flash`；空 = 用 `.attn-backend` 文件里的探出值 |
| `SENSENOVA_FAST_VRAM_FRACTION` / `SENSENOVA_FAST_VRAM_HEADROOM_GIB` / `SENSENOVA_FAST_ACTIVATION_RESERVE_GIB` | `fast` 档显存预算三参数（默认 0.90 / 2 / 4 GiB），对应官方 `--fast_vram_fraction` / `--fast_vram_headroom_gib` / `--fast_activation_reserve_gib` |
| `SENSENOVA_FAST_VRAM_BUDGET_GIB` | `fast` 档**绝对**显存预算（GiB）；设了就覆盖上面的 fraction 自动预算（官方 `--fast_vram_budget_gib`） |
| `SENSENOVA_MOCK_DELAY_SEC` | mock 模式下让「一次生成」总耗时拉长到 N 秒（联调进度条 / busy / cancel 用） |
| `MTNODE_SENSENOVA_MOCK` | `1` = 不加载模型，按入参造占位 PNG；响应带 `"mock": true` |
| `HF_ENDPOINT` | HF 回退源，默认 `https://hf-mirror.com` |

### `GET /health`

权重**懒加载**，所以没加载也秒回（**绝不**在健康检查里碰模型）：

```json
{"ok":true,"service":"mtnode-sensenova","version":"1.0.0",
 "model":"sensenova/SenseNova-U1.5-8B-MoT","modelModelScope":"SenseNova/SenseNova-U1.5-8B-MoT",
 "backend":"sensenova_u1","packageVersion":"0.1.0","device":"cuda",
 "gpu":{"name":"NVIDIA GeForce RTX 4090","totalGiB":24.0,"allocatedGiB":0.0,"peakGiB":22.7},
 "loaded":false,"busy":false,"mock":false,"modelReady":true,
 "vramModes":["full","fast","balanced","low"],"vramMode":"fast",
 "dtypes":["bfloat16","float16","float32"],"dtype":"bfloat16",
 "attnBackends":["auto","flash","sdpa"],"attnBackend":"sdpa","effectiveAttnBackend":"sdpa",
 "cfgNorms":["none","global","channel","cfg_zero_star"],
 "defaults":{"width":2048,"height":2048,"numSteps":50,"cfgScale":4.0,"cfgNorm":"none","timestepShift":3.0,"seed":42},
 "resolutions":[{"ratio":"1:1","width":2048,"height":2048},"…共 11 个官方训练桶"],
 "installDir":"…","outputsRoot":"…","progress":{"stage":"idle","percent":0}}
```

### 官方 11 个训练分辨率桶

来自上游 `examples/t2i/inference.py` 的 `SUPPORTED_RESOLUTIONS`（**最小桶也有约 4M 像素，
所以「降分辨率省显存」这条路不成立**，只能降 `numSteps` 或降 `vramMode`）：

| ratio | W×H | ratio | W×H | ratio | W×H |
| --- | --- | --- | --- | --- | --- |
| `1:1` | 2048×2048 | `3:2` | 2496×1664 | `1:2` | 1440×2880 |
| `16:9` | 2720×1536 | `2:3` | 1664×2496 | `2:1` | 2880×1440 |
| `4:3` | 2368×1760 | `3:4` | 1760×2368 | `1:3` | 1152×3456 |
| | | | | `3:1` | 3456×1152 |

非桶值只写进 `warnings[]`（与上游 `_warn_if_unsupported` 同口径），不拦请求。

### `POST /generate`（同步，长请求）

```bash
curl -X POST http://127.0.0.1:8774/generate ^
  -H "Content-Type: application/json" ^
  -d "{\"prompt\":\"a red cube on a white table, studio light\",\"width\":2048,\"height\":2048,\"numSteps\":50,\"seed\":831001,\"outputDir\":\"D:\\out\"}"
```

| 入参 | 类型 | 说明 |
| --- | --- | --- |
| `prompt` | string | **必填**，图像提示词 |
| `width` / `height` | int | 可选，缺省 2048×2048；见上表 11 个桶 |
| `ratio` | string | 可选，直接填 `1:1` / `16:9` … （等价于给 W/H；显式 W/H 优先） |
| `numSteps` | int | 可选，缺省 50（官方默认），clamp 到 1~200；**降它是主要的省时间/省显存手段** |
| `cfgScale` | float | 可选，缺省 4.0（官方默认；细节/色彩过强就往下调） |
| `cfgNorm` | string | 可选 `none`（默认）/ `global` / `channel` / `cfg_zero_star` |
| `timestepShift` | float | 可选，缺省 3.0（官方默认） |
| `cfgInterval` | `[lo,hi]` | 可选，缺省 `[0,1]` |
| `seed` | int | 可选，缺省随机（负数/非法也随机）；**响应回真实使用的 seed** |
| `vramMode` | string | 可选 `fast`（默认）/ `balanced` / `low` / `full`；OOM 时后端会**自动降一档重试一次**并写进 `warnings` |
| `dtype` | string | 可选 `bfloat16`（默认）/ `float16` / `float32` |
| `attnBackend` | string | 可选 `sdpa`（默认）/ `auto` / `flash` |
| `think` | bool | 可选，官方 think 模式；true 时额外落 `<名>.think.txt` 并回 `thinkText` |
| `outputDir` | string | 可选，产物目录（相对路径按后端 cwd 解析；缺省 `<INSTALL_DIR>\outputs\sensenova-<ts>`） |
| `filename` | string | 可选，输出文件名（**强制 `.png`**，去路径分隔符）；缺省 `sensenova-<时间戳>.png` |
| `device` | string | 可选 `cuda` / `cuda:0` / `cpu`；空 = 自动 |

成功 200：

```json
{"ok":true,
 "imagePath":"D:\\out\\smoke.png",
 "outputDir":"D:\\out",
 "artifacts":["D:\\out\\settings.json","D:\\out\\smoke.png","D:\\out\\smoke.think.txt"],
 "width":2048,"height":2048,"ratio":"1:1",
 "vramMode":"fast","dtype":"bfloat16","attnBackend":"sdpa","peakVramGiB":22.7,
 "thinkText":"","thinkPath":"",
 "prompt":"…","seed":831001,"numSteps":50,"cfgScale":4.0,"cfgNorm":"none","timestepShift":3.0,
 "think":false,"mock":false,"elapsedSec":184.2,"warnings":[]}
```

**产物契约**：图与 sidecar 全落在调用方给的 `outputDir`，响应回传**真实绝对路径**
（`imagePath` / `thinkPath` / `artifacts[]`）；上层不要在别处拼路径。

失败非 200：`{"ok":false,"error":"<短码>","message":"<中文可读原因>"}`

| 短码 | HTTP | 触发场景 |
| --- | --- | --- |
| `bad_request` | 400 | 缺 `prompt`、`vramMode`/`dtype`/`cfgNorm`/`attnBackend` 非法、`outputDir` 建不出来、JSON / Content-Type 不合法 |
| `busy` | 429 | 并发保护：同一时刻只允许一张（先 `/cancel` 或等本次结束） |
| `cancelled` | 409 | `/cancel` 生效（**不写任何产物**，已写出的也会被删） |
| `model_load_failed` | 500 | torch 看不到 CUDA / `sensenova_u1` 或 `transformers` 不可用 / 权重缺失或不完整 / 加载期 OOM |
| `generate_failed` | 500 | 采样过程异常（常见：显存不足 OOM，message 里带降档建议） |
| `save_failed` | 500 | 图片写不出（目录无权限 / 磁盘满） |

### `GET /progress`（staged 进度）

生成期间轮询；**百分比单调不回退，不承诺线性也不承诺精确**：

```json
{"ok":true,"stage":"sample","percent":64,"message":"采样 32/50 步","running":true,"done":false,
 "cancelled":false,"error":"","seed":831001,"outputDir":"D:\\out",
 "step":32,"totalSteps":50,"elapsedSec":96.4,"busy":true}
```

阶段：`queued → load_model → sample → decode → done`（`failed` / `cancelled` 为异常终态）。
**步数怎么来的**：上游 `t2i_generate` 没有回调、也没有阶段日志，官方 ComfyUI 版靠临时替换
`model.unpatchify`（每个采样步恰好调用一次）拿步进 —— 本引擎照抄这个口径（见 `engine.py`
的 `_install_step_hook`），`load_model` 阶段只能报「正在加载」，进度在采样阶段才真的走。

### `POST /cancel`

```json
{"ok":true,"cancelled":true,"running":false,
 "note":"取消在下一个采样步边界生效（正在跑的 torch kernel 不能抢占）；中止后不写出任何图像。",
 "progress":{...}}
```

允许空体或 `{}`。没有正在跑的生成时返回 `"cancelled": false`（不算错误）。

### `POST /shutdown`

```json
{"ok":true}
```

响应后释放权重与显存（`close()`：`del model` + `gc` + `torch.cuda.empty_cache()`）再退出进程。
**上层停服走这个，不要用 taskkill。**

### `GET /`

```json
{"ok":true,"service":"mtnode-sensenova","version":"1.0.0",
 "model":"sensenova/SenseNova-U1.5-8B-MoT","port":8774,
 "endpoints":["/health","/generate","/progress","/cancel","/shutdown"]}
```

## 显存 / 内存口径（为什么必须这样装）

| 事实 | 数字 | 后果 |
| --- | --- | --- |
| 权重体积 | **32.66GB**（8 片 safetensors，bf16） | > 24GB 显存 → `vram_mode=full` 在 4090 上必 OOM |
| 官方 `vram_mode` 档位 | `full`(不卸载) / `fast`(异步预取 + 预算内常驻 generation) / `balanced`(异步预取) / `low`(同步逐层) | 24G 卡走 `fast`；仍 OOM 依次降 `balanced` → `low`（后端会自动降一次并写 `warnings`） |
| 卸载的权重去哪了 | **主内存**（pinned host memory） | 需要 ≥40GB 内存（32GB 是硬门槛，脚本按 32GB 拦） |
| 最小训练桶像素 | 2048×2048 ≈ 4M 像素 | **降分辨率省不了显存**；要省只能降 `numSteps` / 降 `vramMode` |
| 注意力 | 官方可选 `flash-attn`，但**不提供 Windows 轮子** | 默认 `sdpa`；装 flash-attn 不是修复项 |
| 与其它后端 | H3 / Music3 / 视频都吃显存 | 24G 卡上必须**互斥**（MTNode 侧走全局媒体生成锁） |

## 常见错误与修复

| 现象（reason / 短码） | 原因 | 修复 |
| --- | --- | --- |
| `no_cuda` | 没检测到 nvidia-smi / 无 N 卡 | 换机或改用云端 `proc_image` 节点；只跑流程加 `-Cpu` |
| `vram_too_low` | 显存 <20GB | 官方最低档也是 24G 卡；换卡或用云端节点 |
| `ram_too_low` | 内存 <32GB | 分层卸载要在内存放权重；加内存，或 `-Force` 只是装上跑不了 |
| `torch_no_cuda` | 装成了 CPU 版 torch / 驱动太旧 | `pip uninstall -y torch torchvision` 后重跑脚本（会自动选国内镜像装 cu128；驱动 <570 自动降 cu126），**别重下权重** |
| `torch_install_failed` | 三个 torch 源都没拿到轮子 | 手动下载 `torch-2.8.0+cu128-cp311-cp311-win_amd64.whl` 后用 `-TorchWheel <路径>`；或 `-TorchIndex` 指内网镜像 |
| `source_unavailable` | GitHub tag 归档四个源都失败 | 手动下 `.../archive/refs/tags/comfyui-v0.3.0.tar.gz` 后 `-SrcTarball <路径>` |
| `package_import_failed` | `sensenova_u1` import 失败 | 九成是 `transformers` 太低 → `-U "transformers>=4.57.1,<6"`，或 `--no-deps` 后漏装 `sentencepiece`；**别重下权重** |
| `model_load_failed`（含 `unrecognized model_type`） | 权重不全 / transformers 不认 NEOChat / 包版本过旧 | 看 `models\.ok` 在不在 → 重跑脚本续传；仍不行按 message 里的提示升 `sensenova_u1`（`-Ref` 指新 tag） |
| `model_load_failed` + OOM | `vramMode=full`（或 fast 档预算过激） | 依次降 `balanced` → `low`；先关 H3 / Music3；仍不行说明显存真的不够 |
| `generate_failed` + `CUDA out of memory` | 采样期激活值撑爆 | 降 `numSteps`（50 → 30 → 20）；降 `vramMode`；关掉别的占显存后端 |
| `generate_failed` + `Inference tensors do not track version counter.`（**第一张能出、之后每次 500**） | `t2i_generate` 被包在 `torch.inference_mode()` 里：inference 张量被 NEO-ViT 缓存在 rotary 表上，第二次生成复用即抛错 | 已修：`app/engine.py` 改用 `torch.no_grad()`。旧装把新 `engine.py` 同步过去（宿主启动会 sync）后重启服务；**与权重 / torch 无关，别重装** |
| 真实生成报 `USE_FLASH_ATTENTION ...` / flash 相关 | `.attn-backend` 被写成 flash 但轮子不可用 | 设 `SENSENOVA_ATTN_BACKEND=sdpa` 后重启服务；**不要为此去装 flash-attn** |
| 首次 `/generate` 特别慢 | 权重懒加载（32.66GB + 分层卸载，实测加载 28–32s）；**冷启动头一两步采样极慢**（首进卸载上下文 / pinned cache / cudnn 预热） | 正常；加载期间 `/health` 与 `/progress` 都秒回，实测算完头几步后进度正常推进。判定「活着」看 `/progress` 的 `step`/`totalSteps`（每次 `unpatchify` 钩子推进一次），别只看 `percent`、别 kill 进程 |
| 第二张比第一张快很多 | 模型常驻，第二次不再加载 | **正常**。实测 2048²/4 步 `fast`：62.9s（冷）→ 23.8s（热）。不要为此重启后端 |
| 只发一发就在验收 | 「第一张成功、之后每次 500」的 inference 张量坑只连跑才暴露 | 真实验收**必须连跑两次** `/generate` 都 200 |
| 429 `busy` | 同一时刻只允许一张 | 串行调用；上层「抽卡 N 次」必须逐次等待 |
| `/cancel` 后 200 但没产物 | 取消在采样步边界生效、中止不落产物 | 设计口径；`/progress` 会变 `cancelled` |
| 控制台一打进度就崩 / 乱码 | GBK 控制台编码 | 脚本与 `start_backend.cmd` 已设 `PYTHONIOENCODING=utf-8`；自己起进程时记得也设 |

## 与上层（MTNode）的对接口径

1. **启**：`<INSTALL_DIR>\.venv\Scripts\python.exe -m app <port>`（cwd = INSTALL_DIR，端口 8774），
   stdout 逐行追加进 `<DATA>\sensenova\console.log`，探到 `[sensenova] ready` 或 `/health` 通即就绪。
2. **生成**：`POST /generate` 给 `prompt` / `width` / `height` / `numSteps` / `seed` / `outputDir` / `filename`，
   **客户端超时要放到 10 分钟级**（首次还含加载）；期间轮询 `GET /progress` 显示 `采样 n/m 步`。
3. **中断**：`POST /cancel`（尽力而为，中止不落产物）；**停服**：`POST /shutdown`。
4. **产物**：只认响应里的 `imagePath`（PNG 绝对路径）与 `artifacts[]`；节点把它包成
   `{kind:"image", path}` 供下游 `save_image` / 预览 / @ 引用直接复用。
5. **表单**：分辨率下拉、默认值、档位枚举一律取 `/health` 的
   `resolutions` / `defaults` / `vramModes` / `dtypes` / `attnBackends`，渲染层不抄第二份清单。

## 上游参考

- 仓库与安装：<https://github.com/OpenSenseNova/SenseNova-U1>（`docs/installation_CN.md`）
- 对接面核对基准：tag `comfyui-v0.3.0` 的 `examples/t2i/inference.py`（`t2i_generate` 十一个入参、
  `_denorm`/`_to_pil`、`SUPPORTED_RESOLUTIONS`）与 `apps/comfyui/local_pipeline.py`（`_progress_hook`）
- 权重：<https://www.modelscope.cn/models/SenseNova/SenseNova-U1.5-8B-MoT>（国内主源）·
  <https://huggingface.co/sensenova/SenseNova-U1.5-8B-MoT>（回退源）
- 许可：Apache-2.0（仓库 `LICENSE`）；商用前请自行核对模型权重条款。
