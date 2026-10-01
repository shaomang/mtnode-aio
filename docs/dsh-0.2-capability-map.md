# dsh 0.2 能力对照表（MTNode 接线现状）

> **唯一真源**：`dsh/gateway/node_modules/@deepseek-ai/` 下**已安装**的包（`dsh/gateway/package.json`
> 锁死全家族 `0.2.0-rc.2`，精确版本；`@deepseek-ai/cordis*` 走自己的稳定号）。
> `E:\dev\deepseek-harness` 那份本地副本**不是**真源：实测其 `package.json` = `0.1.0-rc.5`、
> `git log` 头三条为 `release(dsh): 0.1.0-rc.5`，`apps/` 下只有 `cli` 与 `web`（无桌面端），
> 其中 `packages/schedule` 的形态与 0.2 的 `schedule` 服务不同 —— 本表不引用它。
> 每条断言后面给的是**可复核依据**（文件 + 行号 / 命令）。

## 一、三层组合怎么读

运行时组合 = 内置 `sdk` profile 的两层 bundle **+** MTNode 补丁层 **+** 用户层：

| 层 | 文件 | 作用 |
|---|---|---|
| bundle 1 | `node_modules/@deepseek-ai/dsh-base/cordis.patch.yml`（20,780 字节） | 核心脊柱（默认开启的能力都在这里） |
| bundle 2 | `node_modules/@deepseek-ai/dsh-sdk-app/cordis.patch.yml`（1,818 字节） | SDK JSON-RPC 服务端 |
| 补丁 3 | `dsh/gateway/cordis.yml`（491 行） | MTNode 自有行 + 对 base 行的覆盖（**只写差异**） |
| 补丁 4 | `<DSH_HOME>/mtnode-settings.patch.yml` | 宿主托管设置（`gateway.mjs` 的 `applySettings` 整份重写） |

依据：`dsh/gateway/cordis.yml:1-11`（形态变更注释）、`dsh/DESIGN.md:35-50`。

**推论（本表的口径）**：某个能力「有没有接线」不能只看 `cordis.yml`。
`@deepseek-ai/dsh-mcp-resources` 在 `cordis.yml` 里零命中，但它**已经在 base 层启用**
（`dsh-base/cordis.patch.yml:492-493`），缺的只是 MTNode 前端界面。

## 二、测量命令与结果

```powershell
# 已安装的 dsh 家族包数 / 在任一层 cordis 组合里出现的名字
cd E:\dev\tools\pipeline-console\dsh\gateway
node -e "const fs=require('fs');
const all=['node_modules/@deepseek-ai/dsh-base/cordis.patch.yml','node_modules/@deepseek-ai/dsh-sdk-app/cordis.patch.yml','cordis.yml'].map(p=>fs.readFileSync(p,'utf8')).join('\n');
const names=new Set([...all.matchAll(/name:\s*'([^']+)'/g)].map(m=>m[1]));
const deps=Object.keys(JSON.parse(fs.readFileSync('package.json','utf8')).dependencies).filter(k=>k.startsWith('@deepseek-ai/'));
console.log('依赖',deps.length,'已启用',deps.filter(d=>names.has(d)).length,'未启用',deps.filter(d=>!names.has(d)).length);"
```

实测结果：**117 个 `@deepseek-ai/*` 依赖，85 个已在某一层出现，32 个未出现在任何一层**。
32 个里含基础设施包（`@deepseek-ai/dsh`、`dsh-base`、`dsh-fs-local`、`dsh-llm-deepseek`、
`dsh-mcp-client`、`dsh-sdk-client`、`cordis*` 等 —— 它们是入口 / 客户端 / 被别的行内联的包，
不出现在 `name:` 位不等于没生效），真正的**能力块**是下面第三节那些。

## 三、未接线能力块（有真实功能、0.2 已发包、MTNode 没接）

| 能力块 | 包 | 实测事实 | 依据 |
|---|---|---|---|
| **定时/自动化任务** | `dsh-experimental-schedule-bundle` → `dsh-schedule` + `dsh-time-context` + `dsh-client-ui-schedule` | 三行全未插入；`cordis.yml` 里 `schedule` / `time-context` 关键词 **0 命中**（`scheduleSave` 之类的渲染层同名函数不算） | `dsh-experimental-schedule-bundle/cordis.patch.yml:8-16`；`cordis.yml` 关键词扫描 = 0 |
| **语音输入（本地 SenseVoice）** | `dsh-experimental-voice-input-bundle` → `dsh-experimental-speech-to-text` + `-sensevoice` + `dsh-experimental-api-speech-to-text` + `dsh-experimental-client-ui-voice-input` | 四行全未插入；`cordis.yml` 里 `voice` / `speech` / `stt` 关键词 **0 命中** | `dsh-experimental-voice-input-bundle/cordis.patch.yml:1-15` |
| **MCP 资源读取** | `dsh-mcp-resources` | **运行时段已启用**（base 层有这个行），但 MTNode 渲染层没有资源列表 / 读取界面 | `dsh-base/cordis.patch.yml:492-493` |
| 官方多智能体 | `dsh-experimental-agent-team` / `-profile` / `-tool-agent-team` / `-client-ui-agent-team` | 未接线；与 MTNode 自研团队（`renderer/app-team-*.js`）重叠 | 未出现在任何层 |
| 浏览器自动化 | `dsh-experimental-browser-use-{runtime,playwright-mcp,chrome-devtools-mcp,stagehand-native}` | 未接线；带独立审批面（playwright / puppeteer 内核按需下载，不随包发） | `dsh/DESIGN.md:180-181` |
| 桌面操控 | `dsh-experimental-computer-use-cua-driver-{mcp,native}` | 未接线；**整包只发到 `0.2.0-rc.1`**（家族里仅此两个 + inspector） | `dsh/DESIGN.md:174-177` |
| 自动评审 / PTC Python / webworker / inspector / hooks-claude-code | `dsh-experimental-auto-review`、`-ptc-runtime-python`、`-webworker-*`、`-inspector`、`dsh-hooks-claude-code` | 未接线；偏开发者向 | 未出现在任何层 |

**本轮范围（用户已确认）**：只做前三块 —— 定时/自动化任务、语音输入、MCP 资源读取界面；
其余整块不做。

**本轮结论（2026-09-30 实测后更新）**：

| 能力块 | 本轮结果 |
|---|---|
| 语音输入 | **已落地全链路**（cordis 五行 + 网关 `speech` 方法 + 侧通道 + 主进程权限与 IPC + 渲染层录音键）。真机联网实测：权重下载 228.2MB `model.int8.onnx` + `tokens.txt` + `silero_vad.onnx` 共 230.2MB → `phase: ready` → `transcribe` 走通原生推理（合成音 `audioSeconds 1.2 / inferenceSeconds 0.009`，空文本符合预期）。 |
| MCP 资源读取 | **已落地**（网关 `mcp-resources.mjs` 用官方 `@modelcontextprotocol/client` 只读连一次 + 本地协议方法 `mcpResources` + 主进程/preload 通道 + 「扩展能力管理」MCP 详情里的资源面板）。未用真实 MCP 服务器端到端验过（见交付说明）。 |
| 定时/自动化任务 | **内核不提供，未做**（见 4.1 的实测结论）；界面上不放按不动的入口，改用画布既有的定时器节点。 |

## 四、本轮要用到的能力：实现事实

### 4.1 定时任务（`dsh-schedule`）

- **三行插法**（照上游 bundle 原文）：`time-context` → `schedule` → `ui-schedule`，
  配置只有 `deliveryHistoryDays`（默认 30）与 `deliveryHistoryRecords`（默认 200）。
  依据：`dsh-experimental-schedule-bundle/cordis.patch.yml:8-16`、`dsh-schedule/README.md`（Config 段）。
- **投递语义**：任务**绑在发起它的那个 Session** 上；到点由 `sessionController.resolveAgent(sessionId)`
  **把冷会话叫醒**，再 `resolved.agent.followup(message)` 把提醒**同步追加到会话收件箱**，
  之后才把 `lastDelivery` / `deliveryHistory` 与新目标一同落盘；提交以 Session 的 `session/flush`
  回执为准。依据：`dsh-schedule/lib/index.js:1576`（`resolveAgent`）、`:1596`（`followup`）、
  `:1598-1605`（receipt + appendDelivery）、README「Delivery resolves the original Session」段。
- **不能单独挂载，实测在 SDK profile 下确实挂不起来（本轮实测结论）**：上游 README 明说
  `Schedule cannot be mounted alone in a headless or SDK-only composition: delivery requires the
  Host Web Session controller and a Session persistence backend`。本轮用真运行时做了 6 组对照探针
  （临时 `DSH_HOME` + `DeepSeekHarness` 真起进程，脚本在 `%TEMP%\dsh-probe-02..11\probe.mjs`），实测：

  | 探针 | 加载的行 | 结果 |
  |---|---|---|
  | probe-02 | schedule 三行 + voice 四行 | `start()` 成功（行都挂上了），模型工具表 24 项里**没有** `schedule_*` |
  | probe-03 | 只 schedule 两行 | 同上；`time-context` **生效**（user/message 里出现 `Time sampled while preparing turn 1, step 1: …[Asia/Shanghai]`） |
  | probe-04 | + `session-controller` 行 | 工具表仍无 `schedule_*` |
  | probe-06 | +12 行（session-controller / job-controller / workspace / api-remotes / …） | 仍无 |
  | probe-07 | + 自写插件在 `agent/created` 里注册 `probe_ping` | **`probe_ping` 进了工具表（25 项）** ⇒ 逐 agent 注册这条路本身是通的，缺的不是机制 |
  | probe-09 | 自写插件查 `ctx.get('schedule')` | **`undefined`**（`hasSchedule: false`），`storages/` 里没有 `schedule.json` ⇒ 服务本体根本没被构造 |
  | probe-11 | schedule + voice 混挂，插件查服务表 | `ctx.speechToText` = `object`（**语音服务挂起来了**）；`ctx.sessionController` = `undefined`、`ctx.schedule` = `undefined` |

  结论：在 MTNode 这份 `0.2.0-rc.2` 组合（`dsh-base` + `dsh-sdk-app` + `cordis.yml`）里，
  `@deepseek-ai/dsh-schedule` 的行**能插进去、服务却不上线**（缺 `ctx.sessionController`，
  而它由 web-app 组合的 `session-controller` 行提供；该行插进来也没让 schedule 服务出现，
  说明注入链上还有别的缺口）。上游 README 自己写明了这个前提 —— **这不是 MTNode 接线少写一行的问题**。
  依据：`dsh-schedule/README.md`「Use this package」首段；`dsh-schedule/lib/index.js`
  `static inject = ["agents","sessions","tools","storageDomain","sessionController","sessionPersistence"]`
  （`:2590`）；`dsh-web-app/cordis.patch.yml:121-122`（`session-controller` 行在 web-app 组合里）。
  **口径**：这块本轮按「内核未提供」处置，请用户裁决（见交付说明「遗留尾巴」）。
- **错过的次数**：只有**一次**投递 —— 每个重复任务只贡献「最近一次错过的发生」；
  一次性任务在错过的那一刻到点才会投递。依据：README 首段 + `lib/index.js` 的
  `resolveEveryOccurrence` / `resolveDaily|Weekly|CronOccurrence`（`lib/types/domain.d.ts` 签名）。
- **时间选择器**（6 选 1，模型工具面）：`after_seconds` / `at` / `every_seconds`（≥60s）/
  `daily{time,time_zone}` / `weekly{time,time_zone,weekdays[1-7]}` / `cron{expression,time_zone}`；
  另必须给 `title`（去空白后非空、≤120 字）。依据：README「The Agent receives…」段 + 选择器表。
- **模型工具**：`schedule_create` / `schedule_list` / `schedule_delete` / `schedule_update`，
  只在 Schedule 已加载的 live root Agent 作用域注册。依据：`lib/index.js:2120/2157/2176/2207`。
- **落盘位置**：storage-domain 走 `json` 后端（base 层 `storage-domain.config.backend: json`），
  根目录 `!!js dshHomePath('storages')` ⇒ 任务是 `<DSH_HOME>/storages/schedule.json`。
  依据：`dsh-base/cordis.patch.yml:168-170`、`:178-180`。
- **MTNode 侧的两个约束**（本表自己推出的，实施时要处理）：
  1. 网关只在 `run` 时**按需**起 workspace runtime，LRU 上限 3 —— 有在途 req 与被点名的续跑候选
     豁免淘汰（`gateway.mjs:1958-1969`）。定时任务到点要 `resolveAgent` 时如果那台 runtime
     已不在池里，就没人叫醒它 ⇒ 需要给「有在途定时任务的 runtime」加豁免。
  2. 应用没开时网关进程不在，任务不会跑（用户已确认：**不补跑**）。
- **`ui-schedule` 是 web 插件包**（`client.js` + locales，给上游 Web 前端用的），
  MTNode 渲染层是无框架 SVG，**不复用**它的界面，只借它的 zh.json 文案口径。
  依据：`dsh-client-ui-schedule/` 文件清单（`client.js`、`zh.json`、`CalendarIcon.d.ts`…）。

### 4.2 语音输入（`dsh-experimental-voice-input-bundle`）

- **四行插法**（上游原文，已带配置）：
  `speech-to-text`（`defaultProvider: sensevoice-local`）→ `speech-to-text-sensevoice`
  （`dataRoot: !!js dshHomePath('speech-to-text','sensevoice')`）→ `api-speech-to-text` → `ui-voice-input`。
  依据：`dsh-experimental-voice-input-bundle/cordis.patch.yml:1-15`。
- **本地推理**：SenseVoiceSmall ONNX + Silero VAD，跑在 **Host CPU**；平台相关 `sherpa-onnx`
  包带 ONNX Runtime，**用户不需要 Python / 编译器 / 模型转换**（`sherpa-onnx-win-x64` 实测已在
  `dsh/gateway/node_modules/` 里）。依据：`dsh-experimental-speech-to-text-sensevoice/README.md`
  「Summary」段 + `node_modules/sherpa-onnx-win-x64` 存在。
- **模型下载**：revision 钉死 + 校验体积与 SHA-256；默认源 `https://huggingface.co` 与 HF-Mirror，
  HEAD 探测取首个 2xx，`modelOrigins` / `modelOrigin` 可覆盖，`modelDirectory` / `vadModelPath`
  可指向已有目录（离线）。权重体积：**int8 约 239MB，fp32 约 938MB**（另加运行时与 VAD）。
  依据：同上 README「Use this package」「Known Limitations」。**首次使用必须显式准备**（下载）
  才能转写 —— 转写本身永远不触发下载。
- **宿主侧硬前提（实测缺口）**：`main.js` 里 `setPermissionRequestHandler` /
  `setPermissionCheckHandler` / `setDevicePermissionHandler` **一个都没有**（grep 计数 = 0），
  Electron 默认会拒掉麦克风 ⇒ 录音必然失败。这是本轮必须补的第一件事。
- `ui-voice-input` 同样是 web 插件包（`client.js` + `PreparationCard` / `Waveform` 等），
  界面自研；它的 `zh.json` 只借文案口径。依据：`dsh-experimental-client-ui-voice-input/` 文件清单。
- **节点级转写也统一到官方 SenseVoice**（本轮改造）：画布上「音频接进文字节点 → 自动转写并注入
  提示词」这条能力保留，但识别引擎从「Qwen3-ASR 本地 HTTP 后端」换成 dsh 运行时的官方 SenseVoice
  —— 与全局语音输入同一条通道（`renderer/app-speech.js` → `dsh:speech`）。
  音频整形在渲染层做：`file:readAudioBytes` 读原始字节 → `decodeAudioData` 解码 → 混单声道 +
  重采样到 16 kHz → **按「短停顿」逐句切分**（连续安静到全局「断句停顿」，默认 300ms，
  与状态栏话筒共用 `S.config.voice.silenceMs`；句子不设长度上限，只在后端 4 MiB ≈ 131 秒的
  硬顶处、最接近的低能量点切一刀）→ 每句编成 PCM16 WAV → base64 交给运行时（**不再依赖 Python 与 ffmpeg**）。
  **一句一片、每句一行**：每句单独送一次识别，文本按行拼接、行末补句末标点（`spSentenceSpans` /
  `spLineText` / `spJoinInline`）。
  转写缓存与人工修订留在主进程 `speech-store.js`（`<数据目录>/speech/transcripts.json`）；
  缓存键带上切分口径指纹（`SEG_TAG`）与当前阈值（`pauseMs`）—— 改规则或改设置都不会沿用旧文本。
  旧后端（`asr/`、`asr-pack/`、`skills/asr-local-install/`、插件卡片、旧 IPC 通道）与它的
  安装链**已整块删除**，回归见 `test/smoke-asr.js`。
- **`speech` 每次调用都必须带 workspace（节点级转写踩过的坑，实测）**：网关的 `speech`
  方法按 workspace 挑（必要时现拉起）那台语音运行时，**不带就一律回
  `缺少 workspace：语音输入要绑定一台工作区运行时`**；而「回包是个错误」与「名单还空着
  （运行时冷起）」在相位里长得一样（都是 providers 为空），于是节点转写的引擎闸门把前者
  当成后者 —— 音频节点的 `asrState` 永远停在 `starting`（提示「语音服务正在启动，稍等一下
  再试」），点多少次都一样，而话筒听写正常（它一直带 workspace：`app-voice.js` 的
  `speechCall` / `apps-store.js` 的 `speechCallForApp`）。现状：`renderer/app-speech.js` 的
  `spStatus` 与 `spTranscribeSamples` / `spEnsureReady` 同口径带上 workspace；`spPhaseOf`
  多回一个 `error` 字段，把「明确报错」与「名单为空」分开，节点闸门据此如实上报。
  另一个实测口径：语音运行时从零冷起时 **+1.9s 名单才出现（phase=checking）、+2.4s 变 ready**，
  所以闸门的冷起窗口要连 `checking` / `loading` / `waking` 一起等（`asrStarting`），
  否则首次点「转录」会被判成「模型未就绪」并弹出下载窗。回归见 `test/smoke-asr.js`
  （桩按真网关口径校验 workspace 与冷起相位）。
- **宿主界面口径（后续一轮改造，链路未变）**：入口从「会话 / 助手输入框各挂一枚 🎤」改为
  **状态栏最左那一枚全局按钮**（`renderer/index.html` 的 `#btnVoiceGlobal` + `renderer/app-voice.js`
  + `renderer/css/voice.css`），点一下在 **关闭 → 持续转录 → 按住 F1 按键转录** 三态之间循环，
  识别结果实时写进**当前 focus 的输入框**。PTT 键用 **F1**（`PTT_KEY = "F1"`）：字符键要先插入再吞键、
  两件事有竞态（会看到反引号先落进消息框），F1 无字符产出，天然不会被录入，按键态下 `keydown` /
  `keyup` 成对吞掉、`ev.repeat` 不重复起停、Ctrl+F1 放行。启动 / 首次连接期按钮走 `is-loading`
  载入旋转（纯 CSS 弧、不写文字），按 400ms 退避重试；真连不上给一句明确提示并 5 秒后自动重试一次。
  因为官方运行时只吃整段 16 kHz 单声道 WAV（无原生流式），
  这里用**整句停顿提交 + 有序提交 + 重叠去重**拼出实时感，句尾由「连续安静帧」判（全局
  「断句停顿」，默认 300ms；句长不再封顶，只在后端 ≈131 秒硬顶处按低能量点切一刀）；
  定稿走 `document.execCommand('insertText')`（保留节点撤销栈语义）。回归见
  `test/smoke-global-voice.js`（三态 / 落点 / 静音门与逐句口径，含「已并入：smoke-voice-mcp.js」的接线段）。

### 4.3 MCP 资源读取（`dsh-mcp-resources`）

- 已在 base 层启用（`dsh-base/cordis.patch.yml:492-493`），包描述 = “Scoped MCP resource
  discovery and reading through shared model tools”，依赖 `dsh-util-values`，peer 为
  `dsh-scope` / `dsh-system-prompt` / `dsh-tools` / `dsh-llm` / `cordis`。
  依据：`dsh-mcp-resources/package.json`。
- 也就是说：**模型侧已经能用**（工具已注册），缺的是 MTNode 界面上「哪些服务器有资源、
  资源叫什么、内容看一眼 / 引用为上下文」这一层。
- MTNode 现有 MCP 管理在「扩展能力管理」对话框（`renderer/app-plugins.js` 的 `EXT_UI` +
  `#extManagerDlg`，分类体系 `EXT_KINDS`），新界面按 AGENTS.md 必须扩在这里，不新开设置内联清单。

## 五、本轮不做（明确写出原因）

- **官方 agent-team / auto-review / hooks-claude-code / browser-use / computer-use /
  PTC Python / webworker / inspector**：与 MTNode 已有能力重叠或纯开发者向（见第三节表）。
- **不改** `dsh/gateway/node_modules/`、`pnpm-lock.yaml`、`.dsh-probe/`、`dist/`、`dist_check/`、
  `data/`、`dsh/smoke-home*`、`dsh/smoke-ws*`（AGENTS.md「不要修改」清单）。
- **不手改** 根目录 `version` 与 `package.json` 的版本号（唯一真源，统一走 `node version.js bump`）。
