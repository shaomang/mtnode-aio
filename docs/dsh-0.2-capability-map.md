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
- **不能单独挂载**：README 明说 `Schedule cannot be mounted alone in a headless or SDK-only
  composition: delivery requires the Host Web Session controller and a Session persistence backend`
  ⇒ **必须在真机实测**它在 `sdk` profile 下是否挂得上（本轮实施第一步就验）。
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
- MTNode 现有本地 Qwen3-ASR（`renderer/app-asr.js`、`asr-pack/`、`test/smoke-asr.js`）
  **一行不动**（用户已确认）：输入框录音走官方 SenseVoice，节点级批量转写仍走 Qwen3-ASR，
  分工写进手册。

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
