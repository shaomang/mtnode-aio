# 本地语音转写后端（Qwen3-ASR）设计说明

> 面向维护者：动手改「音频 → 文字」这条链路之前先读这份说明。
> 本文是本地语音转写后端（Qwen3-ASR）+ 画布音频输入接入文字节点的**定稿口径**：
> 模型、端口、目录、契约、缓存语义都按这里实现，不要再另起一套。
> 后端只服务一件事：把画布上接到文字节点的音频转成文本，作为「【音频转写】…」段落注入提示词。
> 代码落点：`asr/main-asr.js`（主进程模块 + IPC 总线，文件头注释即指向本文）、`asr-pack/`（随包脚手架）、
> `skills/asr-local-install/SKILL.md`（安装 / 自我修复技能）、`plugins/catalog.default.json` 的 `asr-local` 卡片、
> `renderer/`（节点内转写文本的查看 / 编辑 / 重新转写）、`media-gen-global-lock.js`（音视频全局互斥锁，复用不改语义）。

## 一、目标与范围

### 1.1 目标

在画布上把**音频输入**接到**文字处理节点**，运行时自动把音频转成文字，并作为文本注入提示词：

- 适用节点：`proc_text`（普通模式与智能模式）、`agent_task`。
- 注入形态：在该节点本次运行的提示词里追加一段固定格式的段落

  ```
  【音频转写】<转写文本>
  ```

  音频本体不进模型（不做「多模态音频直传」），语言步骤始终是纯文本调用。
- 节点内可查看 / 编辑转写文本，编辑结果即刻生效并被记住（见 §六）。
- 全程本机运行：模型与 venv 都在用户选定目录，运行期数据与日志在 `%APPDATA%\pipeline-console\asr\`。

### 1.2 明确不做

| 不做 | 原因 / 边界 |
| --- | --- |
| 时间戳（segment / word-level timestamps） | 当前只服务「把音频变成提示词文本」，时间轴没有消费方；只回分段数 `segments` 供 UI 显示 |
| 说话人分离（diarization） | 同上，且会显著抬高模型与依赖体积 |
| 独立 ASR 节点 | 转写是**文字节点的前置注入步骤**，不是画布上可连线的节点类型；不新增节点类型、不补节点指南 |
| 批量音频特化 | 音频只按现有端子逐条参与运行；不为 ASR 另做 batchMode / 抽样 / 对齐逻辑 |
| 模型切换 | **固定单模型** `Qwen/Qwen3-ASR-0.6B`，不提供模型下拉、不做多模型管理、不开放识别调参（只有 `language` 透传） |

不做项一律不预留 UI 入口与配置字段；需要时另开设计文档。

## 二、整体架构与数据流

### 2.1 分层

| 层 | 位置 | 职责 |
| --- | --- | --- |
| 渲染层 | `renderer/` | 音频端子接线、提示词注入、节点内转写文本查看 / 编辑 / 「重新转写」、首次连线弹窗、缺后端提示 |
| 主进程模块 | `asr/main-asr.js` | 后端进程静默 spawn / 空闲释放 / 退出清理、安装编排、IPC 总线（前缀 `asr:`）、转写调用与缓存落盘 |
| 后端进程 | 用户选定安装目录的 venv + `asr-pack/app/`（`python -m app <port>`） | 加载 Qwen3-ASR + fsmn-vad，暴露 HTTP 契约（§三） |
| 全局互斥 | `media-gen-global-lock.js` | 转写与音乐 / 视频 / TTS 生成共用一把锁，同一时刻只跑一个（§五） |

主进程向后端下发环境变量（后端按需读，不落盘）：`ASR_PORT`、`ASR_DEVICE`（`cuda` / `cpu`）、
`ASR_MODEL_DIR`、`ASR_FFMPEG`（便携 ffmpeg 绝对路径，缺失则传空串），并固定 `HF_ENDPOINT` / `HF_HUB_DISABLE_XET` 兜底镜像。

### 2.2 文字节点如何取音频

1. 音频输入端子在画布上的**数据值 = `file:///` 本机绝对路径**（与其它媒体输入端子一致）；
   转换出的绝对路径是后续全部缓存键与契约入参的基准。
2. 文字节点运行开始时（**在任何 LLM 调用之前**）做一次前置解析：

   ```
   连线音频 → 绝对路径
     ├─ 文件不存在 / 不是文件           → audio_missing，本次运行失败并提示
     ├─ 查转写缓存（路径 + mtime + size + 热词指纹）→ 命中：直接用缓存文本，不启后端、不占锁
     └─ 未命中 → 占用全局锁 → ensureReady（必要时冷启）→ 转写 → 写缓存 → 放锁
   ```

3. 取到文本后拼进本次运行的提示词，随后按节点原语义执行：普通 `proc_text` 走一次文本补全，
   智能 `proc_text` / `agent_task` 走智能会话。
4. 音频转写段落与节点里 `@标题` 引用的拼接顺序：**先 `@` 引用内容，后「【音频转写】」段落**——
   注入内容贴近生成位置，不易被长上下文稀释。
5. 转写失败**不静默降级**：本次运行以失败结束并带上短码与中文提示，绝不悄悄丢掉音频当纯文本跑。

### 2.3 注入点

| 节点 | 注入点 | 语义 |
| --- | --- | --- |
| `proc_text`（普通） | 本次运行的 prompt | 转写文本作为输入文本的一部分，参与一次补全 |
| `proc_text`（智能，agent:true） | 任务描述 | 作为任务自带上下文，智能体可自行读写中间文件 |
| `agent_task` | 任务描述 | 同上；智能节点自行写文档，其后不接 `save`（沿用既有纪律） |

注入**不改动节点已保存的 prompt 文本**，只在运行时拼接；节点内可见 / 可编辑的那份转写文本存在缓存里（§六），不在提示词里。

## 三、后端契约

后端只监听 **`127.0.0.1`**，默认端口 **`8772`**（可在设置中改），不需要 API Key、不做鉴权：
只走回环地址，且同一时刻只允许一个转写。

### 3.1 接口表

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `POST` | `/v1/audio/transcriptions` | 转写：OpenAI 兼容形状，同时接受 multipart 与 JSON 两种入参 |
| `GET` | `/health` | 存活 + 模型加载状态 + 是否忙，供主进程探活与就绪等待 |
| `GET` | `/v1/models` | 回显唯一模型条目，供调用方确认后端身份 |
| `POST` | `/api/shutdown` | 优雅退出（卸载模型 / 释放显存后进程结束），供空闲释放与 MTNode 退出使用 |

### 3.2 `/v1/audio/transcriptions` 请求字段

| 字段 | 入参形态 | 必填 | 说明 |
| --- | --- | --- | --- |
| `file` | multipart | 二选一 | 音频二进制；适合渲染层 / 外部脚本直传 |
| `audio_path` | JSON body | 二选一 | 本机**绝对路径**；画布侧走这条，避免重复拷贝大文件 |
| `prompt` | 两者皆可 | 否 | 热词提示（上下文引导），拼进识别提示 |
| `hotwords` | 两者皆可 | 否 | 热词提示；与 `prompt` 同义通道，节点热词与设置里的全局热词合并后写这里 |
| `language` | 两者皆可 | 否 | 语言提示，默认 `"auto"`；参与缓存指纹，其它识别参数不开放 |
| `response_format` | 两者皆可 | 否 | `text`（纯文本 body）或 `json`（结构化对象，主进程用这条） |

`response_format=json` 的响应形状（主进程按这些字段解读）：

```json
{
  "ok": true,
  "text": "转写文本",
  "segments": 3,
  "duration_sec": 12.4,
  "model": "Qwen/Qwen3-ASR-0.6B",
  "mock": false
}
```

失败时同一层返回 `{"ok": false, "error": "<短码>", "message": "<中文提示>"}`。
`response_format=text` 直接返回 `text/plain` 的转写文本，不包 JSON。

### 3.3 并发保护

- **同时刻只允许一个转写**：主进程侧 `asr/main-asr.js` 用一条串行链（`transcribeChain`）把并发的
  `asr:transcribe` 排成一队，**先占 `media-gen-global-lock.js`、再发请求**；后端内部再做一层忙保护。
  两层分工：主进程锁管住「MTNode 内所有音视频类任务」，后端互斥管住「任何来源打到 8772 的并发」。
- 后端忙时立即返回 **HTTP 429**，body 带短码 `busy`，调用方不要并发重发。

### 3.4 错误短码

短码是稳定契约：前端与调用方按短码分支，**不解析文案**。

后端错误：

| 短码 | 典型 HTTP | 触发条件 | 处理指引 |
| --- | --- | --- | --- |
| `no_ffmpeg` | 500 | 找不到 ffmpeg，非 wav 音频解不开 | 补装便携 ffmpeg（见 §八） |
| `decode_failed` | 400 | 文件损坏 / 编码不支持 / 采样率异常 | 换素材或先转成 16 kHz 单声道 wav |
| `model_load_failed` | 500 | 权重缺失 / 损坏 / 显存不足 | 卡片「自我修复」或重装模型（§八） |
| `audio_missing` | 404 | `audio_path` 不存在或不可读 | 检查画布音频端子指向的源文件是否被移动 / 删除 |
| `busy` | 429 | 已有转写在跑 | 稍后重试 |

主进程侧错误（发生在调用后端之前 / 之后，同样按短码分支）：

| 短码 | 触发条件 | 处理指引 |
| --- | --- | --- |
| `busy_media` | 音乐 / 视频 / TTS（或另一次转写）占着全局锁 | 按 `mediaLock.busyMessage()` 提示等待，禁止并行 |
| `busy`（安装） | 已有一个安装 / 自修复在进行 | 等安装结束 |
| `no_cuda` | 无 NVIDIA 显卡且未开「仍装 CPU 版」后门 | 上层直接提示「不可用」，引导「仍装 CPU 版（很慢）」或换机器 |
| `not_installed` / `no_venv` | 就绪信号不全（缺 `.install-ok` / `.venv\Scripts\python.exe`） | 走安装 / 自我修复 |
| `backend_unreachable` / `transcribe_failed` | 后端进程挂了或返回无法归类的结果 | 看 `console.log`，必要时重启后端 |
| `bad_dir` / `refuse_root` / `refuse_system` | 安装目录非法（盘根 / 系统目录 / 应用文件夹内） | 重新选目录 |

`MTNODE_ASR_MOCK=1` 为 **mock 模式**：后端不加载模型、不读音频，按输入路径返回固定转写文本（响应 `mock: true`），
契约与错误码照常。用途是冒烟与联调——画布接线、提示词注入、缓存、编辑语义都能在没装模型的机器上验证；
安装技能收尾也用它起一次服务做冒烟（`/health` + 一次 mock 转写）。

## 四、安装与目录

### 4.1 脚手架

```
asr-pack/
  app/                     Python 后端（python -m app <port>）
    __main__.py            入口：读 ASR_PORT / ASR_DEVICE / ASR_MODEL_DIR / ASR_FFMPEG
    server.py              FastAPI 服务：契约 §三、模型加载、忙保护
    audio.py               音频解码（ffmpeg 调用、重采样到 16 kHz 单声道）
    vad.py                 fsmn-vad 静音分段
  scripts/install.ps1      参考安装脚本：-InstallDir / -Cpu / -ModelDir
  manifest.json            插件身份（id asr-local、模型、apiPort 8772、diskHintGb 8）
  requirements.txt         后端依赖
  README.md                脚手架说明
```

`asr-pack/` 由 `build.json` 的 extraResources 打进安装包（与 `tts-pack/` / `llama-pack/` 同口径）；
`asr/main-asr.js` 必须进 `build.json` 的 `files` 白名单。安装时主进程把脚手架同步进安装目录，
**跳过 `.venv` / `models` / `ffmpeg` / `__pycache__` / `.git`**（只补脚手架，不覆盖用户已下好的东西），
并把脚手架路径写入 `<INSTALL_DIR>/.scaffold-ref` 供会话读取。

### 4.2 安装目录（用户选定）

**绝不落应用文件夹**（`app.getAppPath()` / exe 同目录、盘根、系统目录一律拒绝，与 llama / tts 同口径）。

```
<INSTALL_DIR>/
  .venv/                              Python 虚拟环境（3.10+）
  app/                                Python 后端（由脚手架同步）
  models/                             模型目录（可用 config.json 的 modelDir 指到别处）
    .ok                               模型下载完成标记
    Qwen3-ASR-0.6B/                   主模型
    speech_fsmn_vad_zh-cn-16k-common-pytorch/   VAD
  ffmpeg/bin/ffmpeg.exe               便携 ffmpeg（安装时放入，经 ASR_FFMPEG 下发）
  .ffmpeg-ok                          ffmpeg 就位标记（内容 = 便携路径或 `PATH`；缺失即无 ffmpeg）
  .install-ok                         安装完成标记（唯一就绪判据之一；缺 ffmpeg 不会写）
  .asr-agent-result                   Agent 安装回执，首行 ok=true
  .scaffold-ref                       随包脚手架路径
```

模型与来源（固定，不提供切换）：

| 用途 | 来源仓库 | 精度 / 体积 | 许可 |
| --- | --- | --- | --- |
| 语音识别 | ModelScope `Qwen/Qwen3-ASR-0.6B` | Pytorch / BF16，约 1.88 GB | apache-2.0 |
| 语音活动检测（VAD） | ModelScope `iic/speech_fsmn_vad_zh-cn-16k-common-pytorch` | Pytorch | 随仓库声明 |

就绪信号（`projectSignals`）：`app/server.py` 存在 + `.venv\Scripts\python.exe` 存在 + `.install-ok` 存在 = `ready`；
三者缺任一即「未装好」，主进程不 spawn，直接引导安装。
`ffmpeg` 单列一项（`ffmpeg/bin/ffmpeg.exe` 或系统 PATH），状态里为 `ffmpeg: { ok, source, path }`：
**缺 ffmpeg 时后端仍能起，但任何音频都解不开**，因此安装脚本把它当硬门槛（缺则不写 `.install-ok`），
控制台/卡片另给「补装 ffmpeg」入口（`-FfmpegOnly`）。

torch 安装口径：

- **只装 CUDA 版**，先探 `nvidia-smi` 与驱动版本，按能力匹配 `cu13x` / `cu12x`，某一档装不上自动**降一档**再试；
- 机器上**没有 NVIDIA 显卡**时，上层（插件卡片 / 弹窗）直接返回 `supported: false` 并提示「不可用」，
  **拦在安装之前**，不浪费一次完整下载；
- 卡片里保留后门：**「仍装 CPU 版（很慢）」**（`config.json` 的 `allowCpu`）——用户明确选择后才按 `-Cpu` 口径装 CPU 轮子，
  安装会话会明确告知会非常慢。

### 4.3 数据目录

`%APPDATA%\pipeline-console\asr\`（用户数据一律不落应用文件夹）：

| 文件 | 内容 |
| --- | --- |
| `config.json` | `installDir` / `port` / `idleMinutes` / `hotwords[]` / `allowCpu` / `modelDir` / `wantRunning` |
| `installed.json` | 安装元信息（`ok`、版本、模型、时间等），与磁盘信号互为印证 |
| `backend-pid.json` | 后端进程 pid / 端口 / 启动时间 / 安装目录（含 `reused` 标记），供探活与残留清理 |
| `console.log` | 后端 stdout/stderr 与主进程侧转写日志（面板「运行日志」读它） |
| `transcripts.json` | 转写缓存（§六） |

`config.json` 关键字段：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `installDir` | `""` | 用户选定安装目录，未设即不可用 |
| `port` | `8772` | 后端端口，仅回环 |
| `idleMinutes` | `10` | 空闲释放分钟数，合法区间 `0–240`；**`0` = 不自动释放** |
| `hotwords[]` | `[]` | 全局热词，与节点热词合并，去重保序，上限 200 |
| `allowCpu` | `false` | 「仍装 CPU 版」后门开关 |
| `modelDir` | `""` | 模型目录覆盖（默认 `<INSTALL_DIR>/models`） |

### 4.4 安装路径（复用现有模式）

> 插件（`plugins/catalog.default.json` 的 `asr-local` 卡片）或画布弹窗触发
> → **先跑脚本** `asr-pack/scripts/install.ps1`
> → 脚本失败或环境不完整 → **自动接 Agent 会话保底**（mode `recover`）
> → 卡片提供「自我修复」（mode `recover` + `selfRepair`）

- **Agent 路径**：按 `skills/asr-local-install/SKILL.md` 执行——pip 国内镜像（清华 / 阿里云）、
  建 `.venv`（Python 3.10+）、按驱动装 CUDA torch（`cu13x` 失败降 `cu12x`）、装 `requirements.txt`、
  下载便携 ffmpeg 到 `<INSTALL_DIR>\ffmpeg`、用 ModelScope 下两个模型到 `<INSTALL_DIR>\models`
  （失败回退 `HF_ENDPOINT=https://hf-mirror.com`），最后以 `MTNODE_ASR_MOCK=1` 起一次服务做冒烟。
  主进程安装前会清掉旧的 `.install-ok` / `.asr-agent-result`，成功后由会话写回两个 marker。
  该技能由主进程同步进 dsh 技能目录，Agent 会话在工作区内即可读到。
- **脚本路径**：`asr-pack/scripts/install.ps1 -InstallDir <目录> [-Cpu] [-ModelDir <目录>] [-FfmpegOnly] [-ForceFfmpeg]`，
  供命令行用户与诊断使用；脚本**幂等**，装到一半失败可原样重跑补齐（这是「再次安装」的实现基础）；
  主进程把脚本进度按 `pct` 解析进 `asr:progress`。
  只补 ffmpeg 走 `-FfmpegOnly`（几分钟内完成，不动 venv / 依赖 / torch / 模型，也不需要 N 卡）。
  ffmpeg 下载因 Windows PowerShell 5.1 默认 TLS1.0 而失败是历史 bug：脚本现在显式启用 TLS1.2、
  多源重试并校验（大小 / zip 头 / 可执行），全失败还会回退系统 PATH 检测。

## 五、进程生命周期与互斥

### 5.1 spawn 与退出

- **首次需要时静默 spawn**：只在第一次真正要转写（或后端探活失败）时启动，`windowsHide` 无窗口、
  **无托盘图标**，用户不感知它的存在。
- **随 MTNode 退出而结束**：后端是 MTNode 的子进程，退出路径上先 `POST /api/shutdown` 优雅退出，
  超时未结束则强杀；`backend-pid.json` 里的残留 pid 在下次启动时清理。
  这一点与 **tts / llama 刻意相反**（那两个 detached、不随退出、靠托盘手动关闭）——
  ASR 是画布运行的内部步骤，不是要用户长期驻留的服务。
- 冷启动等模型加载要留足时间（`MODEL_IDLE_START_TIMEOUT_MS` = 10 分钟），到点未就绪才判失败。

### 5.2 空闲释放与冷启

- **空闲 10 分钟自动释放**（`idleMinutes` 默认 10）：无转写活动满 10 分钟即 `POST /api/shutdown`，
  结束后端进程，释放显存与内存；每次转写成功 / 命中后重新计时。
- 该行为**可调**（0–240 分钟）也可**关闭**（`idleMinutes = 0` → 常驻到 MTNode 退出）。
- 释放后再来转写请求 → **自动冷启**（重新 spawn + 等 `/health` 就绪），对用户表现为「这次慢一点」，不报错。

### 5.3 全局互斥

转写与音乐 / 视频 / TTS 生成**共用 `media-gen-global-lock.js`**（该文件不改语义）：

- 转写前 `tryAcquireLock({ nodeId, workflowId, kind: "asr" })`；`nodeId` 取文字节点 id，
  缺省回落 `"asr:" + 音频绝对路径`（同一 `nodeId` 可重入，节点重跑 / 抽卡连跑不会自锁）。
- 抢不到锁返回短码 `busy_media`，文案走 `mediaLock.busyMessage(lock.lock)`（`kind: "asr"` 落到默认的「音视频」分支）。
- 锁**只在转写阶段占用，`finally` 里立即释放**；后面的 LLM 调用不占这把锁，否则会把整段生成期拖进互斥、白等。
- 陈旧锁判定沿用 `JOB_LOCK_STALE_MS`（45 分钟）：崩溃残留不会永久堵死排队。

## 六、缓存与编辑语义

缓存文件：`%APPDATA%\pipeline-console\asr\transcripts.json`，形状 `{ "version": 1, "entries": { <key>: <entry> } }`。

### 6.1 缓存键

```
key = sha1( 音频绝对路径（小写） | mtimeMs | size | 热词指纹 )[:16]
热词指纹 = sha1( 合并后的热词 join("\u0001") + language + "|" + 模型名 )[:12]
```

- **音频绝对路径**（小写归一）区分同路径换文件；
- **`mtimeMs` + `size`** 兜住「同路径不同内容」；
- **热词指纹**含合并后的热词（全局 + 节点）、`language` 与固定模型名——热词或语言改了，识别结果应当重算。

缓存条目字段：`path`、`text`、`hotwords[]`、`language`、`model`、`segments`、`duration_sec`、`at`、`edited`。
容量上限 `CACHE_MAX = 500` 条，超出按 `at` 从旧到新淘汰（FIFO）。

### 6.2 语义

| 行为 | 结果 |
| --- | --- |
| 命中缓存 | 直接取用，不启后端、不占全局锁、不产生转写耗时（返回 `cached: true`） |
| 用户编辑节点上的转写文本 | **覆盖该条缓存**（写 `edited: true`），后续运行直接用编辑后的文本，不重算；同一画布其它引用同一音频的节点同样受益 |
| 音频文件变了（mtime / size 变） | 键变 → 该条缓存**失效**，下次运行重新转写 |
| 点「重新转写」 | `force` 跳查缓存，**强制重算**并覆盖条目（无视 `edited`） |
| 换热词 / 换 language | 指纹变 → 视为未命中，重新转写 |

规则一句话：**同一条音频 + 同一组热词（+ 同一 language）= 同一条转写；用户改过就是最终稿，只有音频本体变了才作废。**

## 七、画布侧交互

### 7.1 弹窗时机

1. **首次把音频线连到文字节点时**，该画布**自动弹一次**「下载并启用本地语音识别」窗（每个画布只自动弹一次）。
   窗内必须写清：**体积**（模型约 1.88 GB + CUDA 版 torch 运行时，按 `diskHintGb = 8` 给出保守的磁盘占用）、
   **来源**（ModelScope `Qwen/Qwen3-ASR-0.6B` + `iic/speech_fsmn_vad_zh-cn-16k-common-pytorch`）、
   **安装目录**（用户选定、可改）、**磁盘提示**；`supported: false`（无 N 卡且未开后门）时直接说明「不可用」。
2. **用户拒绝后不再自动弹**。改由两处显式入口触发：
   - 节点上的**「缺语音后端」提示条** + **「一键安装」**入口；
   - 点 **▶ 运行时再拦一次**：后端不可用就中止本次运行并给出安装入口，不做静默降级、不静默丢音频。
3. 安装进行中，弹窗与提示条显示进度（订阅 `asr:progress`），失败时给短码与修复指引（§八）。
4. 插件卡片（`plugins/catalog.default.json` 的 `asr-local`）默认入口是**插件控制台窗口**（§7.4，与 tts / llama / h3 / music3 同构）；
   安装弹窗保留为「状态与设置」二级入口。卡片动作只有「打开控制台 / 关闭控制台」（开始 / 关闭）两态 + 状态与设置，
   **不再有「移除 / 卸载」入口**（与其他应用插件卡片一致：卡片不做删除）；封面图标 `plugins/icons/asr-local.png`
   由 `scripts/make-asr-icon.js` 生成（1:1，512×512，随 `scripts/stage-plugins.mjs` 发布）。

### 7.2 节点 UI 与 IPC

| 元素 | 行为 |
| --- | --- |
| 转写文本区 | 展示当前转写结果，可直接编辑；编辑即写缓存（`asr:cacheSet`） |
| 状态徽标 | `未连线音频` / `待安装后端` / `待转写` / `转写中…` / `已转写（缓存）` / `已编辑` |
| 「重新转写」按钮 | `asr:transcribe { force: true }`，强制重算并刷新文本 |
| 「缺语音后端」提示条 + 「一键安装」 | 拒绝过自动弹窗后的固定入口（`asr:agentInstall`） |
| 热词输入 | 写进请求的 `hotwords`，并参与缓存指纹 |

节点面板遵循全仓纪律：**persistent 浮层**（不挂「点外部即关」），关闭只走显式按钮 / ✕ / Esc / 再点触发器。

IPC 总线（`asr/main-asr.js` `register()`）与事件：

| 通道 | 用途 |
| --- | --- |
| `asr:getStatus` | 状态快照：`installed` / `running` / `apiUp` / `installing` / `consoleOpen` / `ffmpeg` / `gpu` / `supported` / `project` / `port` / `hotwords` / `allowCpu` / `modelDir` / `consolePath` / `installSkill` |
| `asr:pickInstallDir` / `asr:setInstallDir` / `asr:pickModelDir` / `asr:setConfig` | 目录与配置（`idleMinutes` 越界回落默认值，`hotwords` 清洗去重截断 200） |
| `asr:install` / `asr:agentInstall` / `asr:agentRecoverInstall` / `asr:cancelInstall` | 安装、重装 / 补充安装与自我修复、取消（`installing` 期间一律 `busy`） |
| `asr:installFfmpeg` | 只补装便携 ffmpeg（脚本 `-FfmpegOnly`，不动 venv / 依赖 / 模型） |
| `asr:open` / `asr:close` | 打开 / 关闭插件控制台窗口（独立 BrowserWindow，`asr/ui/index.html`） |
| `asr:start` / `asr:stop` / `asr:ensureReady` | 后端启停与就绪等待（静默，无窗口） |
| `asr:transcribe` / `asr:cacheGet` / `asr:cacheSet` / `asr:cacheClear` | 转写与缓存读写（编辑写回、清缓存） |
| `asr:consoleTail` / `asr:gpuProbe` | 日志尾部与 GPU 探测 |
| 事件 `asr:progress` | 进度：`{ phase: "install" \| "runtime", step, stepLabel?, message, pct, error? }` |
| 事件 `asr:consoleChanged` | 日志有新增 / 控制台窗口开合（`{ id, open }`），面板据此刷新 |

### 7.3 热词

- **两级合并**：`config.json` 的全局热词 + 节点级热词，去重保序后发给后端（`hotwords`），全局部分上限 200。
- 用途是引导专有名词、人名、术语的识别（Qwen3-ASR 的上下文提示通道）。
- 热词与 `language` 一起进缓存指纹（§六），因此调完热词应重跑一次节点才会得到新结果。

### 7.4 插件控制台窗口（与其他本地后端同构）

插件卡片默认给**打开控制台**（`asr:open`），打开 `asr/ui/index.html` 的独立 `BrowserWindow`
（`asr/preload-asr.js` 暴露 `window.asrApi`，无 Node 能力）；卡片在窗口开着时显示**关闭控制台**（`asr:close`）。
窗口内提供：

| 区域 | 行为 |
| --- | --- |
| 状态区 | 模型 / VAD / 显卡 / 安装目录 / **ffmpeg 就绪状态** / 磁盘建议，以及运行状态徽标 |
| 安装区 | **安装**（未装）/ **重新安装 · 补充安装**（已装，可重复执行、幂等）、**补装 ffmpeg**、**交给 AI 修复**、**取消安装** |
| 后端区 | 启动 / 停止 / 立即释放（空闲释放＝`asr:stop`，下次转写自动冷启） |
| 日志区 | `console.log` 尾部（`asr:consoleTail`，2.5s 轮询 + `asr:progress` 实时刷新） |
| 设置区 | `idleMinutes` / 全局热词 / `allowCpu` / 已有模型目录 |

**允许再次安装**是硬要求：脚本安装失败、只缺 ffmpeg、或想重建 venv 时都从同一入口重跑（脚本幂等），
不需要先卸载。缺 ffmpeg 时卡片与弹窗都直接给「补装 ffmpeg」，走 `-FfmpegOnly` 快速通道。

## 八、失败排查

| 现象 | 短码 / 状态 | 大概率原因 | 修复指引 |
| --- | --- | --- | --- |
| 运行时报「缺少语音后端」 | `not_installed` / `no_venv` | `.install-ok` 缺失 / `.venv` 不完整 / 与 `installed.json` 不符 | 点节点「一键安装」或卡片「自我修复」，按 `skills/asr-local-install/SKILL.md` 只补缺失部分（别整包重下） |
| 提示「本机不可用」 | `supported: false` / `no_cuda` | 无 NVIDIA 显卡 / 驱动不满足 CUDA 版 torch | 换机器；或在卡片里显式开「仍装 CPU 版（很慢）」（`allowCpu`） |
| 安装卡在 torch | — | 驱动与 `cu13x` 不匹配 / 镜像缺轮子 | 自动降一档重试 `cu12x`；仍失败看 `console.log` 换 pip 镜像后重跑安装技能 |
| 模型下载中断 | — | ModelScope 网络抖动 | 回退 `hf-mirror` 通道重试；`models/` 下残留的半包先删再下 |
| 转写报错 | `no_ffmpeg` | `<INSTALL_DIR>\ffmpeg\bin\ffmpeg.exe` 缺失（或系统 PATH 里也没有） | 卡片 / 弹窗点「补装 ffmpeg」（`-FfmpegOnly` 多源重试 + TLS1.2 + 校验）；仍失败手动放 `ffmpeg.exe` 或设 `ASR_FFMPEG` / 加入 PATH（后端经 `ASR_FFMPEG` 拿路径，取不到再回退 PATH） |
| 安装结束仍报未装 | `ffmpeg_failed` | 便携 ffmpeg 全部源下载失败 | 脚本**不写** `.install-ok`（缺 ffmpeg 任何音频都解不开，视为装不上）；点「补装 ffmpeg」重试，或交给 AI 修复 |
| 转写报错 | `decode_failed` | 文件损坏 / 编码不支持 | 先转成 16 kHz 单声道 wav 再试；确认素材本身能播放 |
| 转写报错 | `model_load_failed` | 权重缺失 / 显存不足 | 卡片自我修复；关掉占显存的应用；确认 torch 档位与驱动匹配 |
| 转写报错 | `audio_missing` | 画布音频端子指向的文件被移动 / 删除 / 不是普通文件 | 修好连线源文件后重跑 |
| 请求被拒 | `busy`（429）/ `busy_media` | 已有转写在跑，或音乐 / 视频 / TTS 占着全局锁 | 等当前任务完成再试；不要并发重发 |
| 安装点了没反应 | `busy`（安装） | 已有安装 / 自修复在进行 | 等它结束，或先取消再重来 |
| 首次转写特别慢 | — | 空闲释放后冷启 + 加载 1.88 GB 模型 | 属预期（冷启等待上限 10 分钟）；在设置里调大 `idleMinutes` 或设 0 常驻 |
| 转写结果还是旧的 | — | 命中缓存 | 点「重新转写」强制重算；换了音频则确认磁盘上 mtime / size 确实变了 |
| 后端地址打不通 | `backend_unreachable` | 端口被占 / 后端崩溃 / 系统代理拦回环 | 改 `port`；看 `console.log`；确认走 127.0.0.1 且绕开系统代理 |

后端 stdout/stderr 与主进程侧日志统一在 `%APPDATA%\pipeline-console\asr\console.log`；诊断先看它，
再看 `installed.json`、`backend-pid.json` 与 `config.json`。

## 九、相关文件清单

| 路径 | 角色 |
| --- | --- |
| `asr/main-asr.js` | 主进程模块：进程生命周期、安装编排、IPC（前缀 `asr:`）、进度事件 `asr:progress`、转写调用与缓存读写 |
| `asr/preload-asr.js` / `asr/ui/index.html` / `asr/ui/ui.js` / `asr/ui/ui.css` | 插件控制台窗口（状态 / 安装 · 重装 · 补装 ffmpeg / 启停 / 日志 / 设置） |
| `asr-pack/app/` | Python 后端（`python -m app <port>`：契约 §三、Qwen3-ASR + fsmn-vad、忙保护） |
| `asr-pack/app/audio.py` / `asr-pack/app/vad.py` | 音频解码（ffmpeg / 重采样）与 fsmn-vad 静音分段 |
| `asr-pack/scripts/install.ps1` | 参考安装脚本（`-InstallDir` / `-Cpu` / `-ModelDir`，国内镜像 + 模型 + ffmpeg） |
| `asr-pack/manifest.json` | 插件身份：id `asr-local`、模型、`apiPort` 8772、`diskHintGb` 8 |
| `asr-pack/requirements.txt` / `asr-pack/README.md` | 后端依赖与脚手架说明 |
| `skills/asr-local-install/SKILL.md` | Agent 安装 / 自我修复技能（镜像、模型来源、目录约定、marker 收尾、冒烟） |
| `plugins/catalog.default.json` | `asr-local` 插件卡片（标题 / 副标题 / 图标 `asr-local.png`，自我修复入口，含「仍装 CPU 版」后门） |
| `renderer/`（画布与节点 UI） | 音频端子接线、提示词注入、转写文本查看 / 编辑、「重新转写」、首次连线弹窗、缺后端提示 |
| `media-gen-global-lock.js` | 音视频全局互斥锁（复用，`kind: "asr"`） |
| `build.json` | 打包白名单：`asr/main-asr.js` 进 `files`，`asr-pack/` 进 extraResources |
| `%APPDATA%\pipeline-console\asr\` | 运行期数据：`config.json`、`installed.json`、`backend-pid.json`、`console.log`、`transcripts.json` |
