# YuE2 本地音乐生成（MTNode 插件后端）

基于 [m-a-p/YuE2-3B](https://huggingface.co/m-a-p/YuE2-3B)（3B，符号规划 + 零样本翻唱）
与 [m-a-p/YuE2-Vae](https://huggingface.co/m-a-p/YuE2-Vae) 的**本地整曲生成**后端：
给一段风格提示词（style）+ 歌词（lyrics），产出一首带人声与伴奏的 48kHz 立体声歌曲，
同时落下**可编辑的 ABC 乐谱**（score.abc）与语义 token 等中间产物。

Python venv + `yue2` 官方推理包，**不上 FastAPI 之类的 Web 框架，HTTP 服务只用标准库**。

## 这是什么 / 不是什么

- ✅ 本地、离线可跑（模型目录可手填，支持无网搬运）；只监听 `127.0.0.1`，不联网上报。
- ✅ 一次 `/generate` = 一首歌（人声 + 伴奏），`cot` 三档：`full`（旋律 + 和弦规划，默认）、
  `melody`（只给旋律，翻唱推荐）、`off`（不做符号规划）。
- ✅ 可自带 ABC 乐谱（`abc` 入参）做翻唱 / 改谱重渲染。
- ❌ 不做音频后期（人声分离、混音母带、变速变调）；不做批量并发（**一次一首**，见 `busy`）。
- ❌ 不做流式返回（没有边生成边出音频）；一首 3–5 分钟的歌在 4090 上约 1–2 分钟，属长请求。
- ⚠️ 权重许可 **CC BY-NC 4.0**（非商用），官方参考环境是 Linux + Python 3.10+ + **24GB NVIDIA GPU**。

## 目录结构

```
yue-pack/                      （安装时复制到用户选定的 INSTALL_DIR）
├─ manifest.json               插件清单（id: yue2-local / entry: app / apiPort: 8773）
├─ requirements.txt            推理依赖（torch 不在里面，见下）
├─ start_backend.cmd           手工启动入口（正常由 MTNode 启停）
├─ scripts/install.ps1         安装 / 修复脚本（幂等，可重复执行）
├─ scripts/probe_attention.py  注意力档位探针：torch 装完后探 flash / cudnn / sdpa，写回 .attention-backend
├─ app/
│   ├─ __init__.py             版本号 + 服务名
│   ├─ __main__.py             标准库 HTTP 服务入口（自查用）：`python -m app <port>`
│   ├─ server.py               标准库 HTTP 服务 + 路由 + 并发保护 + 错误码
│   ├─ ui.py                   宿主唯一入口：`python -m app.ui`（Gradio + run_generate 八槽）
│   ├─ windows_patch.py        Windows 移植补丁：读 .attention-backend，把注意力档位强制降级到 cudnn / sdpa
│   └─ engine.py               yue2 pipeline 懒加载（常驻）+ staged 进度 + 取消 + 产物落盘
├─ yue2_infer-0.1.5-py3-none-any.whl  安装时从 YuE2-3B 仓库取回的官方推理 whl
├─ models/                     模型目录
│   ├─ m-a-p__YuE2-3B/         （约 7.3GB）
│   ├─ m-a-p__YuE2-Vae/        （约 0.5GB）
│   └─ .ok                     两个模型都就位后由脚本创建
├─ outputs/                    缺省产物目录（调用方没给 outputDir 时用）
└─ .install-ok                 安装成功标记（上层据此判断装好了）
```

## 手动安装

```powershell
cd <INSTALL_DIR>
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1 -InstallDir .
```

参数：

| 参数 | 说明 |
| --- | --- |
| `-InstallDir` | 安装目录（默认脚本所在目录的上一级） |
| `-Cpu` | 装 **CPU 版** torch（无 N 卡时的显式后门；官方要求 24G 显卡，CPU 上一首歌可能几小时） |
| `-TorchIndex` | 显式指定 torch 的 `--index-url`（默认按本机驱动自动匹配 cu13x / cu12x） |
| `-ModelDir` / `-VaeDir` | 复用**已有模型目录**（离线安装；用目录联接接进 `models\`，不复制 7.3GB 权重） |
| `-WhlPath` | 复用已有的 `yue2_infer-*.whl`（离线安装） |
| `-SkipModels` | 跳过模型下载（只修 venv / 依赖 / 推理包时用） |
| `-SkipInfer` | 跳过 yue2 推理包安装（venv / 依赖 / torch / 模型 / 冒烟照跑） |

脚本顺序（每步打 `[yue2-install] progress: NN`）：

1. **探测 NVIDIA**：`nvidia-smi` 读显卡名 / 驱动主版本 / 显存；没有 N 卡且未给 `-Cpu` →
   写 `.yue2-agent-result`（`ok=false` / `reason=no_cuda`）并退出非 0；显存 <20GB 只告警不拦
2. 探测 Python（`py -3.12` 优先，退 3.13 / 3.11 / 3.10 / `python`）→ 建 `.venv`
3. pip 装 `requirements.txt`（清华镜像，失败回退阿里云）
4. 装 **CUDA 版 torch / torchaudio**：按驱动主版本选 `cu130` / `cu128` / `cu126`，失败逐档降级；
   `-Cpu` 或全部 CUDA 档位都失败时才装 CPU 版
4b. 跑 `scripts\probe_attention.py` 探**注意力档位**（Windows 必需，见「注意力档位与 Windows 差异」）：
   结果写 `<INSTALL_DIR>\.attention-backend`；一个可用档都没有 → `ok=false` / `reason=attention_backend_unsupported` 退出
5. 装 **yue2 推理包**：`hf_hub_download` 取 `m-a-p/YuE2-3B` 的
   `yue2_infer-0.1.5-py3-none-any.whl` → 直链（hf-mirror / HF resolve）→ 官方仓库
   `git+https://github.com/multimodal-art-projection/YuE.git`（直连 → ghproxy / ghfast 镜像）
6. 用 huggingface_hub 下 `m-a-p/YuE2-3B` 与 `m-a-p/YuE2-Vae` 到 `models\`
   （HF 直连失败回退 `HF_ENDPOINT=https://hf-mirror.com`；跳过 assets/文档等无关文件）
7. 建 `models\.ok` 与 `.install-ok`
8. 用 venv python 跑一次 `MTNODE_YUE2_MOCK=1` 冒烟：起服务 → `/health` → `/generate`（造出
   `audio.flac` + `score.abc` + artifact）→ `/progress`（回到 `done`）→ `/shutdown`

运行（**由 MTNode 负责启停，不要常驻**）：

```powershell
cd <INSTALL_DIR>
# 宿主（插件）入口：Gradio UI
.\.venv\Scripts\python.exe -m app.ui 8773
# 自查 / 契约冒烟入口：标准库 HTTP 服务（/health /generate /progress /cancel /shutdown）
.\.venv\Scripts\python.exe -m app 8773
# 或： start_backend.cmd [port]
```

> **缺 gradio 时先补装**：`.\.venv\Scripts\python.exe -m pip install --isolated gradio -i https://pypi.tuna.tsinghua.edu.cn/simple --trusted-host pypi.tuna.tsinghua.edu.cn`
> —— 缺 gradio 会「启动即 `RuntimeError`：Gradio 未安装」或 `ModuleNotFoundError: No module named 'gradio'`；补装后重跑即可，**不要重下模型权重**。
> 入口口径：宿主只跑 `-m app.ui`（Gradio UI）；`-m app` 是标准库 HTTP 服务入口，仅用于自查与契约冒烟。

## 端口与接口

默认端口 **8773**（可用 `YUE2_PORT` 覆盖），只监听 `127.0.0.1`；启动成功 stdout 打一行 `[yue2] ready`。
所有日志都是 `[yue2] ...` 行式 stdout 输出，上层把它追加进 `<DATA>\yue2\console.log`。

### 环境变量

| 变量 | 说明 |
| --- | --- |
| `YUE2_PORT` | 端口（命令行参数优先），默认 8773 |
| `YUE2_MODEL_DIR` | YuE2-3B 已有模型目录；空 = 自动探测 `<INSTALL_DIR>\models` → HF 缓存 → 回官方 repo id |
| `YUE2_VAE_DIR` / `YUE2_VAE` | YuE2-Vae 目录 / 直接指定 vae 源（repo id 或路径），默认 `m-a-p/YuE2-Vae` |
| `YUE2_DEVICE` | `cuda` / `cpu`；空 = 自动（有 CUDA 就用 CUDA） |
| `YUE2_ATTENTION_BACKEND` | 注意力档位 `flash` / `cudnn` / `sdpa` / `eager`；**优先于** `.attention-backend` 文件；留空 = 用文件（见「注意力档位与 Windows 差异」） |
| `YUE2_LOAD_PER_REQUEST` | `1` = 每个请求按官方 `with YuE2Pipeline.from_pretrained(...) as pipe` 重载一次（慢，默认关闭：权重懒加载一次后常驻） |
| `MTNODE_YUE2_MOCK` | `1` = 不加载模型，按入参造占位产物（冒烟 / 联调）；响应里带 `"mock": true` |
| `HF_ENDPOINT` | 模型下载回退源，默认 `https://hf-mirror.com` |

### `GET /health`

模型**懒加载**，所以没加载也秒回：

```json
{"ok":true,"service":"mtnode-yue2","version":"1.0.0","model":"m-a-p/YuE2-3B",
 "vae":"m-a-p/YuE2-Vae","backend":"yue2_infer","inferVersion":"0.1.5","device":"cuda",
 "loaded":false,"busy":false,"mock":false,"cots":["full","melody","off"],
 "modelSource":"...","vaeSource":"...","outputsRoot":"...","installDir":"...",
 "progress":{"stage":"idle","percent":0}}
```

### `POST /generate`（同步，长请求）

```bash
curl -X POST http://127.0.0.1:8773/generate \
  -H "Content-Type: application/json" \
  -d '{"style":"Mandarin funk / nu-disco, warm lead vocal, Rhodes piano",
       "lyrics":"[verse]\n今晚不眠\n[chorus]\n...",
       "cot":"full","seed":831001,
       "outputDir":"D:\\work\\song-001"}'
```

| 入参 | 类型 | 说明 |
| --- | --- | --- |
| `style` | string | **必填**，风格提示词（曲风 / 人声 / 乐器 / 制作） |
| `lyrics` | string | **必填**，歌词正文（可含 `[verse]` / `[chorus]` 等段落标签） |
| `cot` | string | `full`（默认，旋律 + 和弦规划）/ `melody`（只给旋律，翻唱推荐）/ `off`；其它值 → 400 `unknown_cot` |
| `abc` | string | 可选，自带 ABC 乐谱（`cot="melody"` 翻唱的主路径；`cot="full"` 可连和声一起给） |
| `seed` | int | 可选，缺省随机；**响应里回真实使用的 seed**（复现用） |
| `outputDir` | string | 可选，产物目录（相对路径按后端 cwd 解析；缺省 `<INSTALL_DIR>\outputs\yue2-<ts>-<hex>`） |
| `cfgScale` | float | 可选，文本引导强度（官方建议试 `1.2`） |
| `extra` | object | 可选，透传给 pipeline 的额外命名参数（与上面重名的键会被忽略） |

成功 200：

```json
{"ok":true,
 "audioPath":"D:\\work\\song-001\\audio.flac",
 "outputDir":"D:\\work\\song-001",
 "artifacts":["D:\\work\\song-001\\audio.flac","D:\\work\\song-001\\score.abc","..."],
 "scoreAbc":"D:\\work\\song-001\\score.abc","scoreAbcLen":1234,
 "durationSec":214.85,"cot":"full","seed":831001,"mock":false,"elapsedSec":97.5,"warnings":[]}
```

**产物契约**：`audio.flac`（48kHz 立体声）与 `score.abc` / 语义 token / latent / settings 等
artifact **全部落在调用方给的 `outputDir`**，响应回传**真实绝对路径**（`audioPath`、`artifacts[]`、
`scoreAbc`）。`save_artifacts` 失败不会吞掉音频，只在 `warnings[]` 里记一句。

失败非 200：`{"ok":false,"error":"<短码>","message":"<中文可读原因>"}`

| 短码 | HTTP | 触发场景 |
| --- | --- | --- |
| `bad_request` | 400 | 缺 `style` / `lyrics`、`outputDir` 建不出来、JSON 不合法、Content-Type 不对 |
| `unknown_cot` | 400 | `cot` 不是 `full` / `melody` / `off` |
| `busy` | 429 | 并发保护：同一时刻只允许一首歌（先 `/cancel` 或等本次结束） |
| `cancelled` | 409 | `/cancel` 生效，本次中止（**不写任何产物**） |
| `model_load_failed` | 500 | yue2 包不可用 / 权重缺失 / device 不对（看日志里的异常摘要） |
| `generate_failed` | 500 | 推理过程异常（常见：显存不足 OOM） |
| `save_failed` | 500 | 音频写不出来（目录无权限 / 磁盘满） |

### `GET /progress`（staged 进度）

生成期间轮询；**百分比单调不回退，但不承诺线性、不承诺精确**（阶段由 pipeline 自己的
英文阶段日志映射而来：`load_model → plan → semantic → synth → decode → save → done`）：

```json
{"ok":true,"stage":"synth","percent":72,"message":"...","running":true,"done":false,
 "cancelled":false,"error":"","seed":831001,"outputDir":"D:\\work\\song-001",
 "elapsedSec":42.1,"busy":true}
```

终态：`done`（成功）· `failed`（看 `error`）· `cancelled`。

### `POST /cancel`

```json
{"ok":true,"cancelled":true,"running":false,
 "note":"取消在下一个阶段边界生效（正在跑的推理 kernel 不能抢占）；中止后不写出任何产物。",
 "progress":{...}}
```

允许带空体或 `{}`。**语义**：置位取消标志，在 pipeline 的下一条阶段日志处抛异常中止；
正在执行的 torch kernel 无法抢占，所以不是「立即停」，但中止后**不会落任何产物**。
没有正在跑的生成时返回 `"cancelled": false`（不算错误）。

### `POST /shutdown`

```json
{"ok":true}
```

响应后关闭 pipeline 并退出进程（上层停服走这个，不要用 taskkill）。

### `GET /`

```json
{"ok":true,"service":"mtnode-yue2","version":"1.0.0","model":"m-a-p/YuE2-3B",
 "vae":"m-a-p/YuE2-Vae","port":8773,
 "endpoints":["/health","/generate","/progress","/cancel","/shutdown"]}
```

## 模型加载生命周期（为什么这么写）

官方示例是 `with YuE2Pipeline.from_pretrained("m-a-p/YuE2-3B", device="cuda") as pipe:` ——
权重加载在一首歌的总耗时里占大头，所以本后端把 `with` 块的边界**从一次请求扩到一次服务进程**：

1. 第一次 `/generate` 才加载权重（`engine.ensure_loaded()`），之后进程内常驻复用；
2. `/shutdown`（或 `engine.close()`）时关闭并释放，等价于退出 `with` 块；
3. 要严格的官方语义（每次请求重载 + 关闭）就设 `YUE2_LOAD_PER_REQUEST=1`，
   此时 `/generate` 内部走完整的一次 `with`。

加载失败一律转成 `model_load_failed` + 异常摘要，**不会把 traceback 当正常响应吐给上层**。

## 注意力档位与 Windows 差异

**这条在 Windows 上是明确故障，不是「慢一点」。** 官方 Linux 直接 `pip install flash-attn`；
本机的 torch 轮子经常**有 flash-attn 的 schema、却没有对应 kernel**，yue2 默认 `auto` 会选到 flash，
于是权重加载一切正常，直到**真实生成跑到 Planning score 阶段**才抛：

```
USE_FLASH_ATTENTION was not enabled for build.
```

所以必须把注意力档位显式降级到**本机真正可用**的那一档（`cudnn` → `sdpa` → `eager`），做法是：

1. **安装期探针**：`scripts\install.ps1` 在 torch / torchaudio 装好后立刻跑
   `scripts\probe_attention.py`（进度 `progress: 38`），把选定的档位写进 `<INSTALL_DIR>\.attention-backend`；
   探针输出与写入都失败时脚本只打日志不拦安装，但 `.attention-backend` 缺失会让运行时要再探一次。
2. **运行时下发**：`app\windows_patch.py` 在服务启动时读 `.attention-backend`，
   把该档位强制喂给 yue2 pipeline（覆盖它自己的 `auto` 选择）。
3. **一个可用档都没有**：安装脚本写 `.yue2-agent-result` 为 `ok=false` / `reason=attention_backend_unsupported`
   并退出非 0，提示两条出路 —— 装一个**带 cuDNN 的 CUDA 版 torch**（如
   `--index-url https://download.pytorch.org/whl/cu128`，或用 `install.ps1 -TorchIndex <档位>` 重装），
   或**换卡**（官方要求支持 flash / cuDNN 注意力的 24G 级 NVIDIA GPU；老架构卡、核显、CPU 版 torch 都拿不到可用档位）。

**`.attention-backend`**：单行文本，取值 `flash` / `cudnn` / `sdpa` / `eager`，缺省不存在（= 未探过）。
**`YUE2_ATTENTION_BACKEND`**（环境变量）：显式指定档位，**优先于** `.attention-backend`；留空则用文件里的值。
换过 torch、换过卡，或日志里出现 `USE_FLASH_ATTENTION was not enabled for build.` 之后，都该重跑一次探针：

```powershell
cd <INSTALL_DIR>
# 重探注意力档位（结果写 .attention-backend，并由 windows_patch 在下次启动时生效）
.\.venv\Scripts\python.exe .\scripts\probe_attention.py
```

排查口径：

- **不要装 `flash-attn`**（Windows 无官方轮子，源码编译基本失败）——降级靠探针，不靠装 flash-attn；
- **不要为此重下模型权重**（权重与注意力档位无关）；
- `app\windows_patch.py` 与 `app\engine.py` 必须**同时**存在于安装目录**与随包脚手架**：
  只缺前者会让每轮 sync（脚手架 → 安装目录）把补丁覆盖掉，故障原样复现。

## 常见错误与修复

| 现象 | 原因 | 修复 |
| --- | --- | --- |
| 启动即退出 / 端口占用 | 8773 被别的进程占了 | 换 `YUE2_PORT` 或杀占用进程后重启 |
| `/health` 的 `device` 是 `cpu` | 装成了 CPU 版 torch / 驱动太旧 | 重跑 `install.ps1`（或 `-TorchIndex` 指定匹配档位）；无 N 卡时上层应报 `no_cuda` 拦下安装 |
| `/generate` 报 `model_load_failed` | yue2 推理包没装好 / 权重没下全 | 看日志异常摘要；重跑 `install.ps1`（续传模型），或 `-ModelDir` / `-VaeDir` / `-WhlPath` 指向已有产物 |
| 第一次生成特别慢 | 权重懒加载（首次请求才加载） | 正常现象；加载期间 `/health` 与 `/progress` 都秒回 |
| `/generate` 报 `generate_failed` + CUDA OOM | 显存不够（官方未量化需 24G，峰值 11–14GiB，还要留余量） | 关掉占显存的其他后端（H3 / Music 3 等音频视频任务互斥）、降分辨率外部手段，或换大显存卡 |
| 并发请求返回 429 `busy` | 同一时刻只允许一首歌 | 串行调用（上层批处理应逐条）；或先 `/cancel` |
| `/cancel` 后响应仍是 200 但产物不存在 | 取消在阶段边界生效、且中止不落产物 | 这是设计口径；`/progress` 会变成 `cancelled` |
| 翻唱效果不像原曲 | `cot` 用错 / 没给 `abc` | 翻唱用 `cot="melody"` 并给 `abc`（旋律 ABC，不带和弦）；要连和声一起给用 `cot="full"` |
| `warnings` 里有 `save_artifacts 失败` | 只为写 artifact 的那一步失败 | `audio.flac` 已正常落盘；查 `outputDir` 写权限 / 磁盘空间 |

## 磁盘与显存

- 模型约 **7.8GB**（YuE2-3B 7.3GB + YuE2-Vae 0.5GB）+ torch / 依赖约 4–6GB，
  加上生成中的产物，建议预留 **≥30GB**（`manifest.diskHintGb = 30`）。
- 官方未量化：**24GB NVIDIA GPU** + **24GB 可用内存**，峰值显存约 11–14GiB；
  一张卡同一时刻只跑一首（本后端已用 `busy` 保护）。

## 与上层（MTNode）的对接口径

> **宿主只用 `python -m app.ui`**（Gradio，`GRADIO_SERVER_PORT` 指定端口，探到 Gradio 就算就绪），
> 调 `run_generate` 时按 8 槽 data 传参：
> `[style, lyrics, durationSec, seed, outputDir, filename, modelDir, offload]`。
> `python -m app` 的 `/health` `/generate` … **只是自查 / 契约冒烟用的老入口**，宿主不会走它。

1. 启：`<INSTALL_DIR>\.venv\Scripts\python.exe -m app.ui`（自查用 `-m app <port>`），cwd = INSTALL_DIR；
   日志追加进 `<DATA>\yue2\console.log`。
2. 生成：`POST /generate` 给 `style` / `lyrics` / `cot` / `outputDir`，**客户端超时要放到 10 分钟级**；
   期间可轮询 `GET /progress` 显示 staged 进度。
3. 中断：`POST /cancel`（尽力而为，中止不落产物）；停服：`POST /shutdown`。
4. 产物：只认响应里的 `audioPath` / `scoreAbc` / `artifacts[]` 绝对路径，不要在别处拼路径。
