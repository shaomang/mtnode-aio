# 本地图像生成后端（SenseNova-U1.5-8B-MoT）设计说明

> 面向维护者：动手改「本机文生图」这条链路之前先读这份说明。
> 本文是本地图像生成后端（SenseNova-U1.5-8B-MoT）+ 画布 `sensenova_gen` 节点的**定稿口径**：
> 模型、端口、目录、契约、显存口径都按这里实现，不要再另起一套。
> 代码落点：`sensenova/main-sensenova.js`（主进程模块 + IPC 总线，文件头注释即指向本文）、
> `sensenova-pack/`（随包脚手架，权重 / venv / 产物全在用户选定目录）、
> `skills/sensenova-local-install/SKILL.md`（安装 / 自我修复技能）、`plugins/catalog.default.json` 的 `sensenova-local` 卡片、
> `renderer/`（`sensenova_gen` 节点 UI 与执行链）、`media-gen-global-lock.js`（音视频全局互斥锁，复用不改语义）。
> 后端脚本自带的对接面细节（参数表 / 环境变量 / 常见错误）另见 `sensenova-pack/README.md`，两者冲突时以本文件为准。

## 一、目标与范围

### 1.1 目标

在画布上放一个**跑在本机**的文生图节点：给一段提示词出一张 PNG，离线、不上传提示词、不按张计费。

- 适用节点：`sensenova_gen`（画布右键 → 处理节点 › 图像生成 › SenseNova）。
- 输出形态与 `proc_image` **完全对齐**：`node.output = { kind: "image", path }`，
  端口 0 = 图像 / 端口 1 = 控制；因此下游的图像预览、`save_image`、`@` 引用、批量成员判定一条都不用新写。
- 产物自动进入应用资产目录（`%APPDATA%\pipeline-console\assets\<wfId>`）并从输出端口 0 交出，节点上**无需填输出路径**，也**不需要再挂保存节点**（旧画布残留的 `outputPath` 会被忽略）。
- 全程本机运行：venv、权重、产物都在用户选定目录，运行期数据与日志在 `%APPDATA%\pipeline-console\sensenova\`。

### 1.2 明确不做

| 不做 | 原因 / 边界 |
| --- | --- |
| 蒙版局部重绘 / 画幅锁定 / 差分抠图 | 只对接 `t2i_generate` + `it2i_generate`（参考图条件）；这三样是云端 `proc_image` 的能力，本机链路不做 |
| 图文交错（interleave）/ 视觉理解（VQA）/ Image PE 提示词增强 | 统一多模态权重的这些能力本轮不做节点化 |
| 任意宽高 | 官方只有 **11 个训练分辨率桶**，节点给下拉而不是宽高输入框（非桶值只进 `warnings[]`，不拦请求） |
| 流式返回 / 并发 | 后端同一时刻只允许一张（第二发 `429 busy`）；一张 2048×2048 在 24G 卡上是分钟级长请求 |
| 前端框架 / 多卡分布式 / GGUF 量化推理路径 | 低显存备选只写在安装技能的文档里，不进产品链路 |

**参考图（图像编辑）**：`sensenova_gen` 的增量数据槽接图像（或 `@` 引用 / 全局广播取到图）后，渲染层把路径随 `refImages` 下发；宿主核「存在 + 图片后缀」后放进 `/generate` 请求体，后端 `engine.generate()` 据此走 `it2i_generate`（对齐上游 `examples/editing/inference.py`），响应与产物 `settings.json` 里 `mode = "edit"`。读不到的路径逐条进 `warnings`（`ref_image_missing` / `ref_image_not_image` / `ref_image_too_many`），不静默；一张都读不出来就退回纯文生图并在 `warnings` 里说明。`imgCfgScale`（=`img_cfg_scale`，默认 1.0 = 图像 CFG 关闭）只在图像编辑模式下有意义。

不做项一律不预留 UI 入口与配置字段；需要时另开设计文档。

## 二、整体架构与数据流

### 2.1 分层

| 层 | 位置 | 职责 |
| --- | --- | --- |
| 渲染层 | `renderer/app.js` · `app-nodes.js` · `app-canvas.js` | `sensenova_gen` 的常量 / 端子 / 设置表单 / 预览 / 执行链（抽卡、取消、导出路径）、未装警示条 |
| 主进程模块 | `sensenova/main-sensenova.js` | 脚手架同步、安装编排（脚本 + Agent 双通道）、后端 spawn / 探活 / GPU 采样 / 空闲自停、IPC（前缀 `sensenova:`）、生成转发与取消、失败上报 |
| 后端进程 | 用户选定安装目录的 venv + `app/`（`python -m app <port>`） | 加载 SenseNova-U1.5-8B-MoT，暴露 HTTP 契约（§三） |
| 全局互斥 | `media-gen-global-lock.js` | 与音乐 / 语音 / 视频生成共用一把锁，同一时刻只跑一个（`kind: "sensenova_gen"` → 文案落「图像」分支） |

### 2.2 一次生成的数据流

```
节点 prompt（或端口 0 接进来的文本）
  → renderer 归一：ratioBucket → width/height、枚举夹取、导出路径解析（.png）
  → 占全局锁（抢不到 → busy_media，提示等待）
  → ensureReady：探活 /health，未装或没就绪直接中止（supported === false 硬停）
  → POST /generate（超时 25 分钟起、上限 90 分钟）
  → 期间轮询 /progress 更新节点状态行（阶段 + 百分比）
  → 成功：取响应 imagePath → node.output = {kind:"image", path} → 驱动控制输出端子
  → OOM：后端自动降一档 vramMode 重试一次，结果写进 warnings，节点状态行回显
  → finally 释放全局锁
```

抽卡（`attempts` 1–10）：**逐次串行**调用，每次一张、命名 `_01` / `_02` …；摇数开启时每次 `seed + 1`。
后端是单例，多个 `sensenova_gen` 节点共享同一后端进程，也共享同一条串行链。

### 2.3 与渲染层的注入点

节点自身字段（`prompt` / `ratioBucket` / `numSteps` / `cfgScale` / `cfgNorm` / `timestepShift` / `seed` /
`rerollSeed` / `attempts` / `vramMode` / `dtype` / `think` / `outputPath` / `filename`）进 `NODE_DEFAULTS` 与快照；
设置表单里的分辨率下拉、默认值、档位枚举**全部取后端 `/health`**（`resolutions` / `defaults` / `vramModes` / `dtypes`），
渲染层只留一份兜底常量——**不抄第二份清单**（提示词单一真源口径：完整规范在
`mtnode-agent-skills/mtnode/canvas-edit-rules/SKILL.md` 的生成类节点小节，网关工具描述只卡口）。

## 三、后端契约

后端只监听 **`127.0.0.1`**，默认端口 **`8774`**（`SENSENOVA_PORT` 覆盖，命令行参数最优先，可在设置里改），
不需要 API Key、不做鉴权；同一时刻只允许一个生成（第二发 `429`）。
启动成功 stdout 打一行 `[sensenova] ready`；所有日志是 `[sensenova] …` 行式 stdout，由宿主追加进
`%APPDATA%\pipeline-console\sensenova\console.log`。

### 3.1 接口表

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/health` | 存活 + 权重加载状态 + 是否忙 + 分辨率桶 / 默认值 / 档位枚举（**权重懒加载，秒回**） |
| `POST` | `/generate` | 文生图 / 图像编辑（**同步长请求**）：一次一张 PNG；带 `refImages` 即进图像编辑模式 |
| `GET` | `/progress` | staged 进度：`queued → load_model → sample → decode → done`（异常终态 `failed` / `cancelled`） |
| `POST` | `/cancel` | 请求取消（在下一个采样步边界生效，**不落任何产物**） |
| `POST` | `/shutdown` | 优雅退出（卸载权重 / `empty_cache` 后结束进程），供空闲释放与停服使用 |
| `GET` | `/` | 服务自述：service / version / model / port / endpoints |

### 3.2 `POST /generate` 请求字段

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `prompt` | string | **必填**，图像提示词 |
| `refImages` | string[] | 可选，**参考图 / 编辑底图的本机绝对路径**（1–4 张；读不到的文件跳过并进 `warnings`）。给了就走 `it2i_generate`（图像编辑模式，响应 `mode = "edit"`），不给仍是纯文生图（`mode = "t2i"`） |
| `imgCfgScale` | float | 可选，缺省 1.0（= `img_cfg_scale`，图像 CFG 权重；1.0 = 关闭，官方默认）；**只在图像编辑模式下有意义** |
| `width` / `height` | int | 可选，缺省 2048×2048；取 §3.4 的 11 个桶 |
| `ratio` | string | 可选，直接填 `1:1` / `16:9` …（等价于给 W/H；显式 W/H 优先） |
| `numSteps` | int | 可选，缺省 50（官方默认），clamp 到 1–200；**降它是主要的省时间 / 省显存手段** |
| `cfgScale` | float | 可选，缺省 4.0 |
| `cfgNorm` | string | 可选 `none`（默认）/ `global` / `channel` / `cfg_zero_star` |
| `timestepShift` | float | 可选，缺省 3.0 |
| `cfgInterval` | `[lo,hi]` | 可选，缺省 `[0,1]` |
| `seed` | int | 可选，缺省随机（负数 / 非法也随机）；**响应回真实使用的 seed** |
| `vramMode` | string | 可选 `fast`（默认，官方 24G 档）/ `balanced` / `low` / `full`；OOM 时后端**自动降一档重试一次**并写进 `warnings` |
| `dtype` | string | 可选 `bfloat16`（默认）/ `float16` / `float32` |
| `attnBackend` | string | 可选 `sdpa`（默认）/ `auto` / `flash` |
| `think` | bool | 可选，官方 think 模式；true 时额外落 `<名>.think.txt` 并回 `thinkText` |
| `outputDir` | string | 可选，产物目录；缺省 `<INSTALL_DIR>\outputs\sensenova-<ts>` |
| `filename` | string | 可选，输出文件名（**强制 `.png`**，去路径分隔符） |
| `device` | string | 可选 `cuda` / `cuda:0` / `cpu`；空 = 自动 |

成功 200 的关键字段（完整形状见 `sensenova-pack/README.md`）：
`ok` / `imagePath` / `outputDir` / `artifacts[]` / `width` / `height` / `ratio` / `vramMode` / `dtype` /
`attnBackend` / `peakVramGiB` / `thinkText` / `thinkPath` / `seed` / `numSteps` / `cfgScale` / `cfgNorm` /
`timestepShift` / `think` / `mock` / `elapsedSec` / `warnings[]` /
`mode`（`t2i` | `edit`）/ `refImages[]` / `refImagesUsed` / `imgCfgScale`。

**产物契约**：图与 sidecar 全落在调用方给的 `outputDir`，响应回传**真实绝对路径**
（`imagePath` / `thinkPath` / `artifacts[]`）；**上层不得在别处拼路径**。

- **画布节点（`sensenova_gen`）调用不传 `outputDir`**：宿主把本次生成先落到自己的临时产物目录，再把 PNG **按字节复制进
  `%APPDATA%\pipeline-console\assets\<wfId>`（应用资产目录，与 `proc_image` 同一去处）**并把该资产绝对路径作为节点产物返回，
  下游 `save_image` / 预览直接吃这条路径——画布节点上没有输出路径可填。
- **插件控制台「试生成」显式传 `outputDir`**：保持原行为，**仍写指定目录**，宿主不搬动、不改写路径。

### 3.3 并发保护

- **同时刻只允许一个生成**：渲染层的主进程侧先占 `media-gen-global-lock.js`（与音乐 / 语音 / 视频互斥），
  再发请求；后端内部再做一层忙保护。
- 后端忙时立即返回 **HTTP 429**，body 带短码 `busy`，调用方**不要并发重发**；抽卡必须逐次等待。
- 锁**只在生成阶段占用，`finally` 里立即释放**；陈旧锁判定沿用 `JOB_LOCK_STALE_MS`。

### 3.4 官方 11 个训练分辨率桶

来自上游 `examples/t2i/inference.py` 的 `SUPPORTED_RESOLUTIONS`（`/health.resolutions` 直接给出）：

| ratio | W×H | ratio | W×H | ratio | W×H |
| --- | --- | --- | --- | --- | --- |
| `1:1` | 2048×2048 | `3:2` | 2496×1664 | `1:2` | 1440×2880 |
| `16:9` | 2720×1536 | `2:3` | 1664×2496 | `2:1` | 2880×1440 |
| `4:3` | 2368×1760 | `3:4` | 1760×2368 | `1:3` | 1152×3456 |
| | | | | `3:1` | 3456×1152 |

**最小桶也有约 4M 像素**，所以「降分辨率省显存」这条路不成立——只能降 `numSteps` 或降 `vramMode`。
非桶值只写进 `warnings[]`（与上游 `_warn_if_unsupported` 同口径），不拦请求。

### 3.5 错误短码

短码是稳定契约：前端与调用方按短码分支，**不解析文案**。
后端错误码与 HTTP 映射：`bad_request`(400) / `busy`(429) / `cancelled`(409) /
`model_load_failed`(500) / `generate_failed`(500) / `save_failed`(500)。

主进程侧错误（发生在调用后端之前 / 之后，同样按短码分支）：

| 短码 | 触发条件 | 处理指引 |
| --- | --- | --- |
| `busy_media` | 音乐 / 视频 / 语音（或另一次图像生成）占着全局锁 | 按 `mediaLock.busyMessage()` 提示等待，禁止并行 |
| `busy` | 已有一个安装 / 自修复在进行 | 等安装结束 |
| `no_cuda` / `vram_too_low` / `ram_too_low` / `low_disk` | 硬件门槛（§四） | 提示替代方案；确要强行尝试只能勾「忽略硬件门槛」（`forceHardware` → 脚本 `-Force`） |
| `not_installed` / `no_venv` | 就绪信号不全（缺 `.install-ok` / `.venv\Scripts\python.exe`） | 走安装 / 自我修复 |
| `pack_missing` / `script_missing` | 随包脚手架缺失或不完整 | 重装应用或重跑安装技能 |
| `torch_no_cuda` / `torch_install_failed` / `source_unavailable` / `package_import_failed` / `smoke_failed` | 安装期各类失败（脚本来因） | 见 `skills/sensenova-local-install/SKILL.md` 的已知故障表 |
| `backend_unreachable` / `generate_failed` / `generate_timeout` | 后端挂了 / 返回无法归类的结果 / 超过 25 分钟起的长请求上限 | 看 `console.log`，必要时重启后端 |

`MTNODE_SENSENOVA_MOCK=1` 为 **mock 模式**：后端不加载模型、不碰显存，按入参造一张真 PNG（响应 `mock: true`），
契约与错误码照常。用途是冒烟与联调——装前就能验画布接线、路径解析、进度、取消、429；
安装脚本收尾也用它起一次服务做冒烟（`/health` + 一次 mock 生成 + **带 `refImages` 的编辑模式** + 并发 429 + 取消无产物 + `/shutdown`）。
**mock 绿 ≠ 能出图**，安装成功的判据必须是真实出图一次（见安装技能）。

#### 参考图（图像编辑）链路的上线接线

「画布连了图像，本机出图却没拿它当参考图」的根因是三处都没接：渲染层没把采集到的路径发出去、宿主没放进 `/generate` 请求体、后端 `/generate` 没有参考图字段（engine 只调 `t2i_generate`）。
现在三段贯通：`playSensenovaGenNode` → `refImages: refPaths` → 宿主 `refImagePathsForBody` 只留存在且像图片的路径 → 请求体 `refImages` → `engine.generate()` 读到即走 `it2i_generate`（`images` = PIL 列表，RGBA 平铺白底，**按上游 `--input_max_pixels auto` 预算就地等比缩小**——`load_reference_images` 前 2 张各约 2048×2048、更多张按 `(4096^2)/n` 摊分、下限 512×512，只缩不放、LANCZOS、边长对齐图像 token 网格；模型侧 `load_image_native` 仍会按 min/max_pixels 兜一层）。
判据：回执 `mode:"edit"`、`refImagesUsed>0`；mock 模式下产物目录 `settings.json` 也记 `mode:"edit"` + `refImages`。

### 3.6 两次实测踩过的坑（改动 `app/engine.py` 时勿回退）

| 症状 | 机理与口径 |
| --- | --- |
| **第一张能出图，之后每次 `/generate` 都 500**：`RuntimeError: Inference tensors do not track version counter.`（`modeling_neo_vit.apply_rotary_emb_1d` 的 `cos_cached[positions]`） | 不能把 `t2i_generate` 包在 `torch.inference_mode()` 里。`inference_mode` 产出的张量带 inference 标记，而 NEO-ViT 会把**首次前向现造**的 rotary `cos/sin` 表缓存在模块上；第二次生成复用该缓存就抛错。`engine.py` 用 **`torch.no_grad()`** 代替（无反向传播，开销差异可忽略），缓存张量变回普通张量，整进程可反复出图。**上游 `examples/t2i/inference.py` 用的是 `@torch.inference_mode()`，它每次进程只跑一发所以暴露不出来** |
| 采样期 `/progress` 长时间停在 `sample 15%` | 不是进度没接上：步级进度由 `model.unpatchify` 钩子回推（`15% → 95%`），但**冷启动头一两步极慢**（offload 上下文首进 + pinned host cache + cudnn 预热）。判定「活着」要看 `step`/`totalSteps` 是否在涨，不要只看 `percent` |
| 第二次请求明显更快 | 正常：权重常驻，第二次不再加载。实测 2048²/4 步 `62.9s → 23.8s`。**不要为此重启后端** |
| **连了参考图却像没连**（出图与参考图无关） | 三段必须都在：渲染层把 `sensenovaGenRefPaths(node)` 采到的路径塞进 `window.api.sensenovaGenerate({ refImages })`（**漏掉这一个字段就整条链断**）；宿主用 `refImagePathsForBody` 过滤后放进 `/generate` 请求体；引擎读到非空数组就调 `it2i_generate`（不是 `t2i_generate`）。判据：回执 `mode:"edit"` + `refImagesUsed>0`，产物目录 `settings.json` 同字段。**不要再加「后端不支持参考图」之类的降级文案**——后端 `comfyui-v0.3.0` 的 `modeling_neo_chat.py` 本来就有 `it2i_generate` |
| **图参考（编辑）模式非常慢** | 上游口径，不是本包把参数配错了：`it2i_generate` 在 `cfg_scale>1 且 img_cfg_scale==1` 时 `needs_img_condition=True`，**前缀阶段要把参考图整个再跑一遍**（`query_condition` + `query_img_condition`），采样期每步再算两遍（`out_cond` / `out_img_cond`）。参考图越大，那次重复的 ViT + 前缀前向越贵。提速档位：① `imgCfgScale` 提到与 `cfgScale` 相同（如都 4.0）→ 第二次前缀换成**纯文本**无条件分支，省掉重复的参考图前缀；② `cfgScale=1` → 单分支（最快，但关掉 CFG）；③ 降 `numSteps`。这三条都写进回执 `warnings[]`，节点状态行可见，别静默 |
| **生成完成后显存看着没还** | `engine.generate()` 的 `finally` 一律走 `release_run_memory()`（`gc` + `synchronize` + `empty_cache`，并把 allocated/reserved 前后值写进 `console.log`）。**权重按 `vramMode` 分层常驻是有意为之**（第二次不再加载），整进程显存/内存只由「空闲自停」或控制台「停止后端」释放；插件控制台保存设置时输入框留空**不得**再把它写成 `idleMinutes=0`（`0 = 永不释放`），这是曾经「完成后不释放」的真凶 |

## 四、安装与目录

### 4.1 脚手架

```
sensenova-pack/                 随包脚手架（build.json extraResources 打进安装包）
  app/                          Python 后端（python -m app <port>）
    __main__.py                 入口：读 SENSENOVA_PORT / SENSENOVA_MODEL_DIR / SENSENOVA_DEVICE 等
    server.py                   标准库 HTTP 服务：契约 §三、并发保护、错误码
    engine.py                   sensenova_u1 懒加载 + 分层卸载 + 步级进度 / 取消 + 反归一化存 PNG
  scripts/install.ps1           参考安装脚本（幂等、可续传、全程国内镜像优先）
  manifest.json                 插件身份（id sensenova-local、apiPort 8774、diskHintGb 60）
  requirements.txt              推理依赖（**故意不含 torch**，见 §4.4）
  start_backend.cmd             手动起服务（正常由 MTNode 启停）
  README.md                     脚手架的对接面细节
```

`sensenova/main-sensenova.js` 必须进 `build.json` 的 `files` 白名单；安装时主进程把脚手架同步进安装目录，
**跳过 `.venv` / `models` / `outputs` / `src` / `__pycache__` / `.git`**（只补脚手架，不覆盖用户已下好的东西），
并把脚手架路径写入 `<INSTALL_DIR>\.scaffold-ref` 供会话读取。

### 4.2 安装目录（用户选定）

**绝不落应用文件夹**（`app.getAppPath()` / exe 同目录、盘根、系统目录一律拒绝，与 llama / tts / asr 同口径）。

```
<INSTALL_DIR>/
  .venv/                                 Python 虚拟环境（3.11 优先）
  app/                                   Python 后端（由脚手架同步）
  models/
    SenseNova__SenseNova-U1.5-8B-MoT/    权重（约 32.66GB / 8 片 safetensors）
    .ok                                  权重校验通过标记（8 片齐 + config.json + index.json + 合计 ≥30GB）
  src/SenseNova-U1-<ref>/                sensenova_u1 源码（pip install --no-deps 的对象）
  outputs/                               缺省产物目录
  .attn-backend                          安装期探出的注意力档位（flash / sdpa）
  .install-ok                            安装成功标记（唯一就绪判据之一）
  .sensenova-agent-result                Agent 安装回执（首行 ok=true，失败带 reason=…）
  .scaffold-ref                          随包脚手架路径
```

就绪信号（`projectSignals`）：`app/server.py` 存在 + `.venv\Scripts\python.exe` 存在 + `.install-ok` 存在 = `ready`；
缺任一即「未装好」，主进程不 spawn，直接引导安装。

模型与来源：

| 用途 | 来源仓库 | 体积 | 许可 |
| --- | --- | --- | --- |
| 文生图权重 | ModelScope `SenseNova/SenseNova-U1.5-8B-MoT`（回退 HF `sensenova/SenseNova-U1.5-8B-MoT` + `hf-mirror`） | 约 32.66GB（bf16，8 片） | Apache-2.0（商用前自查权重条款） |
| 推理包 | GitHub `OpenSenseNova/SenseNova-U1` tag `comfyui-v0.3.0` 的归档 tarball（**PyPI 没有这个包**） | 源码 | 随仓库 |
| torch | `torch 2.8.0 + torchvision 0.23.0`（**CUDA 轮子**，cu128 / 驱动不足降 cu126） | 约 3.5GB | BSD-3 |

### 4.3 硬件门槛

| 项 | 硬门槛 | 说明 |
| --- | --- | --- |
| 显卡 | 有 NVIDIA 卡（`nvidia-smi`） | 无 → `no_cuda`，直接拦死 |
| 显存 | `< 20GB` → `vram_too_low` | 20–24GB 可装但警告；**24G 为官方档**（`vramMode=fast`），≥48G 才用 `full`。注意这是**官方口径的安全门**而非实测下限：本机实测 `fast` 峰值约 16GiB、`low` 仅约 3GiB（下表），门槛拦下的机器用「忽略硬件门槛」+ `vramMode=low` 仍有机会跑通 |
| 内存 | `< 32GB` → `ram_too_low` | 分层卸载出去的权重放在主内存（pinned host memory）；建议 ≥40GB |
| 磁盘 | `< 60GB` 提示（`diskHintGb`，脚本侧 <50GB 只告警） | 权重 32.66GB + torch 运行时 + 源码 |

**实测基准**（RTX 4090 24GB · 驱动 610.88 · 63.8GB 内存 · bf16 · `sdpa`，`/generate` 全程耗时）：

| 分辨率桶 | `numSteps` | `vramMode` | 耗时 | `peakVramGiB` |
| --- | --- | --- | --- | --- |
| 2048×2048 | 4 | `fast` | 62.9s 冷（含 28s 权重加载）/ 23.8s 热 | 15.86 |
| 2048×2048 | 12 + `think` | `fast` | 383.7s | 15.97 |
| 2720×1536 | 4 | `fast` | 24.3s 热 | 15.85 |
| 3456×1152 | 4 | `fast` | 24.0s 热 | 15.76 |
| 2048×2048 | 4 | `low` | 57.2s 热 | 2.95 |

`fast` 的显存由 fast 档预算封顶（约 16GiB），换更大的桶几乎不涨；权重加载 28–32s。**冷启动第一发明显更慢**
（首进 offload 上下文 / pinned host cache / cudnn 预热），期间 `/progress` 会在 `sample 15%` 停一阵 —— 看 `step`/`totalSteps` 判断是否在推进。

门槛拦下时报告里必须给**替代方案**：① 改用云端「文生图」节点；② 换 ≥24G 显存的卡（24G 用 `fast`，≥48G 可用 `full`）；
③ 确要强行尝试则勾「忽略硬件门槛」（`forceHardware`）。**硬门槛之外还有后门，但默认关**。

### 4.4 安装路径（复用现有模式）

> 插件卡片（`plugins/catalog.default.json` 的 `sensenova-local`）或画布节点入口触发
> → **先跑脚本** `sensenova-pack/scripts/install.ps1`
> → 脚本失败或环境不完整 → **自动接 Agent 会话保底**（mode `recover`）
> → 卡片提供「自我修复」（mode `recover` + `selfRepair`）

- **脚本路径**：`sensenova-pack/scripts/install.ps1 -InstallDir <目录> [-Python …] [-TorchIndex …] [-TorchWheel …]
  [-Ref …] [-SrcTarball …] [-ModelDir …] [-Cpu] [-Force] [-SkipModels|-SkipDeps|-SkipPkg|-SkipTorch|-SkipSmoke]`。
  脚本**幂等**，装到一半失败可原样重跑补齐（已下好的权重分片、已解出的源码都不重来）。
  主进程把脚本进度按 `[sensenova-install] progress: NN` 解析进 `sensenova:progress`。
- **中国镜像口径**（脚本内置失败回退顺序，不留裸 GitHub 唯一路径）：
  pip 走**清华 → 阿里云**，并用 `PIP_INDEX_URL` / `PIP_EXTRA_INDEX_URL` / `PIP_TRUSTED_HOST` 覆盖本机全局 pip 配置
  （常见被 NVIDIA PyIndex 塞入国内不可达的 `pypi.ngc.nvidia.com`，会让每个包白等 5 次重试；**`pip --isolated` 挡不住**，
  它只忽略用户级 config 且会连 `PIP_*` 一起忽略）；torch 走 **SJTU pytorch-wheels → 阿里云 pytorch-wheels → download.pytorch.org**；
  `sensenova_u1` 走 tag tarball 的 **`ghfast.top` → `gh-proxy.com` → `ghproxy.net` → 直连**；
  权重走 **ModelScope**（国内直连）→ 失败回退 `HF_ENDPOINT=https://hf-mirror.com`；
  Python 优先 `uv python install 3.11`（`UV_PYTHON_INSTALL_MIRROR` 指到 npmmirror）。
- **两处最易踩的坑**：① **CUDA 本地版本号必须写进 pin**（`torch==2.8.0+cu128`），否则会被清华的 CPU 轮子
  「假成功」装上；② `pip install <sensenova_u1 源码> **--no-deps**` 是硬要求，否则 pip 会顺手把 torch 重解成 CPU 版。
- **Agent 路径**：按 `skills/sensenova-local-install/SKILL.md` 执行（工作区 = 该插件的 INSTALL_DIR，
  `danger-full-access`），成功后由会话写回 `.install-ok` 与 `.sensenova-agent-result`。
  该技能由主进程同步进 dsh 技能目录（`INSTALL_SKILL_SOURCES` 注册 + 宿主侧兜底副本），Agent 会话在工作区内即可读到。

### 4.5 数据目录

`%APPDATA%\pipeline-console\sensenova\`（用户数据一律不落应用文件夹）：

| 文件 | 内容 |
| --- | --- |
| `config.json` | `installDir` / `port` / `vramMode` / `modelDir` / `idleMinutes` / `forceHardware` / `wantRunning` |
| `backend-pid.json` | 后端 pid / 端口 / 启动时间 / 安装目录（含 `external` 标记），供探活与残留清理 |
| `console.log` | 后端 stdout/stderr 与主进程侧日志（控制台窗「运行日志」读它） |

`config.json` 关键字段：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `installDir` | `""` | 用户选定安装目录，未设即不可用 |
| `port` | `8774` | 后端端口，仅回环；合法区间 1025–65535 |
| `vramMode` | `""` | 空 = 用后端默认（`fast`）；可选 `full` / `fast` / `balanced` / `low` |
| `modelDir` | `""` | 权重目录覆盖（空 = 自动探测 `<installDir>\models` → ModelScope / HF 缓存） |
| `idleMinutes` | `10` | 空闲释放分钟数，合法区间 `0–240`；**`0` = 不自动释放** |
| `forceHardware` | `false` | 「忽略硬件门槛」后门（透传 `install.ps1 -Force`） |
| `wantRunning` | `false` | 用户期望的运行态，供重启后恢复 |

## 五、进程生命周期与互斥

### 5.1 spawn 与退出

- **首次需要时静默 spawn**：只在第一次真正要生成（或探活失败）时启动，`windowsHide` 无窗口。
- **后端是独立单例、detached**：**MTNode 退出不杀它**（权重加载要几分钟，随手杀会白等一次）。
  停服走两条显式路径：**空闲自停**（§5.2）与插件控制台 / 设置里的显式停止（`POST /shutdown`，超时再强杀）。
  `backend-pid.json` 里的残留 pid 在下次启动时清理。
- **冷启动等就绪要留足时间**（180 秒探活窗口 + 权重懒加载分钟级）；生成请求超时 **25 分钟起、上限 90 分钟**。
  加载期间 `/health` 与 `/progress` 都秒回，**不要因为「没动静」去强杀**。
- 使用既有安装目录「接入已有后端」：若 `8774` 上已有健康后端，直接复用不重复 spawn（记 `external: true`）。

### 5.2 空闲释放

- **空闲 10 分钟自动释放**（`idleMinutes` 默认 10）：无生成活动满 10 分钟即 `POST /shutdown`，
  结束后端进程，**释放显存与内存**——24G 卡上这是硬需求（后端常驻会把显存一直占着，H3 / Music3 就没法跑）。
- 该行为**可调**（0–240 分钟）也可**关闭**（`idleMinutes = 0` → 常驻到显式停止）。
- 释放后再来请求 → **自动冷启**（重新 spawn + 等 `/health` 就绪），对用户表现为「这次慢一点」，不报错。

### 5.3 全局互斥

生成与音乐 / 视频 / 语音**共用 `media-gen-global-lock.js`**（该文件只加一个文案分支，不改语义）：

- 生成前 `tryAcquireLock({ nodeId, workflowId, kind: "sensenova_gen" })`；同一 `nodeId` 可重入
  （节点重跑 / 抽卡连跑不会自锁）。
- 抢不到锁返回短码 `busy_media`，文案走 `mediaLock.busyMessage(lock.lock)`，`kind: "sensenova_gen"` 落到「图像」分支。
- 锁**只在生成阶段占用，`finally` 里立即释放**。

## 六、画布侧交互与 IPC

### 6.1 节点 UI

| 元素 | 行为 |
| --- | --- |
| 状态行 | 未装 / 待安装 / 未就绪 / 生成中（含 `/progress` 阶段与百分比）/ 已完成 / 已取消，以及后端自动降档的 `warnings` |
| 参数摘要 | 一行显示桶名与 W×H、步数、CFG、抽卡、显存档位、精度、think |
| 后端面板 | API 在位 / 权重在位 / VRAM 三枚徽章 + 「打开控制台日志」 |
| 图像预览 | 复用 `proc_image` 同一套预览与灯箱（输出端子语义一致） |
| ⚙ 设置 | 分辨率按官方 11 桶下拉（带 WxH 提示）、步数 / CFG / CFG Norm / Shift / 抽卡 / 种子 + 摇数 / 显存档位 / 精度 / think |
| ▶ / ✕ | 运行与取消（取消走 `sensenova:cancelGenerate`）；未装时 ▶ 硬停并给安装入口 |

节点面板遵循全仓纪律：**persistent 浮层**（不挂「点外部即关」），关闭只走显式按钮 / ✕ / Esc / 再点触发器。

### 6.2 IPC 总线（`sensenova/main-sensenova.js` `register()`）

| 通道 | 用途 |
| --- | --- |
| `sensenova:getStatus` | 状态快照：`installed` / `running` / `apiUp` / `installing` / `consoleOpen` / `gpu` / `supported` / `project` / `port` / `diskHintGb` / `vramModes` / `installSkill` 等 |
| `sensenova:health` | 转发后端 `/health`（渲染层据此取桶表与默认值） |
| `sensenova:pickInstallDir` / `setInstallDir` / `setConfig` | 目录与配置（`idleMinutes` 越界回落默认、`vramMode` 枚举夹取、`port` 区间校验） |
| `sensenova:install` / `agentInstall` / `agentRecoverInstall` / `selfRepair` / `cancelInstall` | 脚本安装、Agent 安装 / 恢复安装 / 自我修复、取消（`installing` 期间一律 `busy`） |
| `sensenova:start` / `stop` / `ensureReady` | 后端启停与就绪等待 |
| `sensenova:generate` / `cancelGenerate` / `getLock` | 生成转发、取消、查看当前锁占用 |
| `sensenova:forceKill` | 强杀后端（诊断用，正常走 `stop`） |
| `sensenova:consoleTail` / `gpuProbe` | 日志尾部与 GPU 探测 |
| `sensenova:open` / `close` / `removePluginMeta` | 插件控制台窗口开合、移除本地插件元信息 |
| 事件 `sensenova:progress` | 进度：安装（脚本 / Agent）与运行（生成阶段）两路 |
| 事件 `sensenova:consoleChanged` / `sensenova:gpu` | 日志有新增 / 控制台开合、GPU 采样推送 |

### 6.3 插件控制台窗口（与其他本地后端同构）

插件卡片默认给**打开控制台**（`sensenova:open`），打开 `sensenova/ui/index.html` 的独立 `BrowserWindow`
（`sensenova/preload-sensenova.js` 暴露 `window.sensenovaApi`，无 Node 能力）；卡片在窗口开着时显示**关闭控制台**。
卡片动作只有「开始 / 关闭」两态 + 「状态与设置」，**不做删除 / 卸载入口**（与其它应用插件卡片一致）。
窗口内提供：状态区（服务 / 权重 / 全局锁 / attn 后端 / 显存档位）、安装区（安装 / 重装 / 交给 AI 修复 / 取消 + 双进度条）、
后端区（启停 / 强杀 / GPU 显存与利用率）、日志区、试生成面板、设置区（`vramMode` / 空闲释放分钟 / 忽略硬件门槛）。

## 七、失败排查

| 现象 | 短码 / 状态 | 大概率原因 | 修复指引 |
| --- | --- | --- | --- |
| 点 ▶ 说未安装 | `not_installed` / `no_venv` | `.install-ok` 缺失 / `.venv` 不完整 | 插件控制台点安装 / 自我修复，按安装技能只补缺失部分（**别整包重下 32.66GB**） |
| 装到一半报错 | 脚本 `reason=` | 镜像抖动 / 驱动与 cu128 不匹配 / tarball 源全失败 | 看 `console.log` 与 `.sensenova-agent-result` 的 `reason=`，对安装技能「已知故障」表；修好**原样重跑**（幂等续传） |
| 装完仍出不了图 | `torch_no_cuda` / `model_load_failed` | 装成 CPU 版 torch / 权重不全 / transformers 太低 | 卸掉 torch 重跑脚本（`+cu128` pin）；看 `models\.ok` 在不在；升 `transformers>=4.57.1` |
| 生成报 OOM | `generate_failed` + `CUDA out of memory` | 显存真的不够 / 别的后端占着 | 降 `vramMode`（`fast` → `balanced` → `low`）、降 `numSteps`、关掉 H3 / Music3；**降分辨率无效** |
| 报 `USE_FLASH_ATTENTION …` | — | `.attn-backend` 被写成 flash 但 Windows 无轮子 | 设 `SENSENOVA_ATTN_BACKEND=sdpa` 后重启服务；**不要为此去装 flash-attn** |
| 首次生成特别慢 | — | 权重懒加载 + 分层卸载（32.66GB） | 属预期（分钟级）；加载期间 `/health` / `/progress` 秒回，别强杀 |
| 请求被拒 | `busy`（429）/ `busy_media` | 已有生成在跑，或音乐 / 视频 / 语音占着全局锁 | 等当前任务完成再试；**不要并发重发** |
| 安装点了没反应 | `busy`（安装） | 已有安装 / 自修复在进行 | 等它结束，或先取消再重来 |
| 取消后没产物 | `cancelled`（409） | 取消在采样步边界生效、中止不落产物 | 设计口径；`/progress` 会变 `cancelled` |
| 后端地址打不通 | `backend_unreachable` | 端口被占 / 后端崩溃 / 系统代理拦回环 | 改 `port`；看 `console.log`；确认走 127.0.0.1 且绕开系统代理 |
| 控制台一打进度就崩 / 乱码 | — | GBK 控制台编码 | 脚本与 `start_backend.cmd` 已设 `PYTHONIOENCODING=utf-8`；自己起进程时记得也设 |
| 生成超时 | `generate_timeout` | 步数过大 / 显存频繁换入换出 | 降 `numSteps` 与显存档位后重试 |

后端 stdout/stderr 与主进程侧日志统一在 `%APPDATA%\pipeline-console\sensenova\console.log`；诊断先看它，
再看 `backend-pid.json` 与 `config.json` 以及安装目录下的四个标记文件。

## 八、相关文件清单

| 路径 | 角色 |
| --- | --- |
| `sensenova/main-sensenova.js` | 主进程模块：安装编排、进程生命周期、IPC（前缀 `sensenova:`）、生成转发与取消、失败上报 |
| `sensenova/preload-sensenova.js` / `sensenova/ui/index.html` / `sensenova/ui/ui.js` | 插件控制台窗口（状态 / 安装 · 重装 · 自修复 / 启停 / 日志 / 试生成 / 设置） |
| `sensenova-pack/app/` | Python 后端（`python -m app <port>`：契约 §三、懒加载与分层卸载、忙保护、取消、PNG 落盘） |
| `sensenova-pack/scripts/install.ps1` | 参考安装脚本（幂等续传、国内镜像回退链、mock 冒烟） |
| `sensenova-pack/manifest.json` | 插件身份：id `sensenova-local`、entry `app`、`apiPort` 8774、`diskHintGb` 60、`vramModes` |
| `sensenova-pack/requirements.txt` / `README.md` / `start_backend.cmd` | 后端依赖（不含 torch）、对接面细节、手动起服务 |
| `skills/sensenova-local-install/SKILL.md` | Agent 安装 / 自我修复技能（镜像、门槛、marker 收尾、冒烟、已知故障） |
| `plugins/catalog.default.json` | `sensenova-local` 卡片（标题 / 副标题 / 图标 `sensenova-local.png`、自我修复入口、建议预留磁盘） |
| `renderer/`（`app.js` / `app-nodes.js` / `app-canvas.js` / `i18n.js`） | `sensenova_gen` 的常量 / 端子 / 设置表单 / 预览 / 执行链与中英词条 |
| `media-gen-global-lock.js` | 音视频全局互斥锁（复用，`kind: "sensenova_gen"` → 「图像」） |
| `guides/nodes/sensenova_gen.md` / `guides/manual/media-gen.md` | 节点指南与手册「SenseNova 图像生成」小节 |
| `build.json` | 打包白名单：`sensenova/**` 进 `files`，`sensenova-pack/` 进 extraResources |
| `%APPDATA%\pipeline-console\sensenova\` | 运行期数据：`config.json`、`backend-pid.json`、`console.log` |
