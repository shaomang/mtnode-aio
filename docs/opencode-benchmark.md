# OpenCode 对标与 MTNode 增强提案

> 基准：`anomalyco/opencode` `dev` 分支 commit `03e6717`（2026-09-28），最新版本 v1.18.33，MIT，约 21.0 万 star / 2.79 万 fork（README 与 docs 取自 `https://opencode.ai/docs/`）。
> 对照方：MTNode v1.4.x，本机仓库 `E:\dev\tools\pipeline-console`（`version` 文件为版本真源）。
> 每条结论都带双方的具体依据：OpenCode 侧给命令 / 配置键 / 字段名，MTNode 侧给文件与函数名，可逐条复核。
> 本文只讨论**桌面端应用内可落地**的增强（不涉云端 `store-saas` / `web`，不改 `dsh/` 现有契约）；文末清单可直接勾选开工。

---

## 一、OpenCode 是什么（研究结论摘要）

OpenCode 已经不是「一个终端 coding agent」，而是**以 headless server 为内核、多客户端接入的 agent 平台**：

| 维度 | 事实（可复核） |
| --- | --- |
| 形态 | monorepo 31 个 package，全 TypeScript，Bun 1.3.14，内核 Effect 4 beta + Drizzle/SQLite |
| 架构 | `opencode` 启动即「TUI（客户端）+ server（唯一状态方）」；`opencode serve` 起 headless（默认 `--port 4096`、`--hostname 127.0.0.1`、`--mdns`）；OpenAPI 3.1 在 `GET /doc` 并用它生成 SDK |
| 多客户端 | `opencode attach <url>` 把终端挂到已跑后端；`opencode web` + `attach` 可「Web 与终端共享同一份 sessions 与 state」；`POST /tui/*`（append-prompt / submit-prompt / execute-command）供 IDE 插件反向驱动前端 |
| 事件流 | `GET /event`（`text/event-stream`，首事件 `server.connected`）、`GET /global/event`；事件名含 `session.status|idle|error|diff|compacted`、`message.part.updated`、`permission.asked|replied`、`lsp.client.diagnostics`、`todo.updated` |
| SDK | 仅 JS/TS：`createOpencode()` / `createOpencodeClient()`，类型由 OpenAPI 生成（`go.mdx` 讲的是 Go 订阅套餐，不是 Go SDK） |
| Agent | primary（`build` 默认全工具 / `plan` 受限）与 subagent（`general`、`explore`、`scout`）；隐藏系统 agent `compaction` / `title` / `summary`；用户可用 markdown + frontmatter（`description` 必填、`mode`、`model`、`temperature`、`permission`、`tools`）自定义；`opencode agent create` 交互生成 |
| 委派 | Task 工具按 subagent 的 `description` 自动派活；`task` 权限支持 glob（`deny` 会把该 subagent 从工具描述里整段移除）；嵌套深度 `subagent_depth` 默认 1，`0` 全禁 |
| 权限 | 单键 `permission`：`allow`/`ask`/`deny` + glob map + **last-match-wins**；键全集含 `read|edit|glob|grep|list|bash|task|todowrite|webfetch|websearch|lsp|skill|question|external_directory|doom_loop`；默认 `doom_loop`（同一调用重复 3 次）与 `external_directory` 为 `ask`，`.env` 默认 deny；`--auto` 自动批准但**显式 deny 仍强制** |
| 代码智能 | LSP 默认关、内置 35 个语言服务器（多款自动安装，`OPENCODE_DISABLE_LSP_DOWNLOAD` 可关）；formatter 默认关、内置 26 个（`$FILE` 占位、写改后在后台跑）；`snapshot` 默认开（`track/restore/revert/diff`，`/undo` `/redo` 依赖 git） |
| 会话 | SQLite 持久化；`fork`（含 `children` 子会话列表）、`revert`/`unrevert`、`summarize`、消息与 part 级删改、`share`/`unshare`（`share: manual|auto|disabled`，链接形如 `opncd.ai/s/<id>`，`unshare` 会真删数据）；`opencode import <file|share URL>` |
| 上下文与成本 | `compaction`（`auto` 默认 true、`prune`、`preserve_recent_tokens`）、常量 `PRUNE_MINIMUM 20000 / PRUNE_PROTECT 40000`；成本来自 **models.dev** 目录（`cost.input/output/cache_read/cache_write`、`limit.context/output`）；`opencode stats --days --tools --models --project`、`opencode export [--sanitize]` |
| 扩展面 | 插件 npm 包或 `.opencode/plugins/`；约 20 个 hook（`tool.execute.before/after`、`chat.params`、`permission.ask`、`shell.env`、`experimental.chat.system.transform`、`experimental.session.compacting`…）；自定义工具 `.opencode/tools/*.ts`（文件名即工具名）；技能 `SKILL.md`（frontmatter 只认 name/description/license/compatibility/metadata）；规则文件 `AGENTS.md`/`CLAUDE.md` 从 cwd 向上查找 + `instructions` 支持 URL |
| 结构化输出 | `session.prompt` 的 `body.format = { type:"json_schema", schema, retryCount }`（默认重试 2），失败抛 `StructuredOutputError` |
| 交互 | leader 键默认 `ctrl+x`（`leader_timeout` 2000ms）、命令面板 `ctrl+p`（action `command_list`）、约 130 个具名 action 全部可在 `tui.json` 改键位；`/` 命令可被 `.opencode/commands/` 覆盖，模板支持 `$ARGUMENTS`/`$1..$n`/`` !`cmd` ``/`@文件`；主题独立 `tui.json` + `defs` 复用色 + dark/light 双值 |
| 工程化 | curl 一行装 + npm/bun/brew/choco/scoop/docker/mise；`opencode run` 非交互（`--format json`、`--auto`、`--attach`）；`opencode github install` + `@opencode` 评论触发 GitHub Actions |

---

## 二、MTNode 现状（先说「已经有了」，避免误判）

对标前先核实：下列 OpenCode 能力 **MTNode 已经具备**，不在建议清单里重复建设。

| OpenCode 能力 | MTNode 现状（依据） |
| --- | --- |
| 子代理委派 | `dsh/gateway/cordis.yml` 已挂 `@deepseek-ai/dsh-subagent`、`subagent-spawn-in-process`、`subagent-fork-in-process`，以及模型可调的 `subagent` / `subagent_fork` / `subagent-report` 工具 |
| 会话 fork | `renderer/app.js` `forkAgentSession()`（约 L30328，i18n「复制该会话为新会话(参考 dsh fork)」），深拷贝消息、标 `forkedFrom` |
| 会话断点续跑 | `dsh/gateway/plugins/session-resume-server.mjs` + `renderer/app-db.js` 的 `session/resume` 握手与重发闸；`renderer/app-agent.js` 有暂停 / 继续 |
| 上下文压缩 | `dsh/gateway/cordis.yml` 的 `compaction-basic`、`command-compact`、`tool-result-pruner`（`thresholdChars 4096`）、`session-checkpoint-policy` |
| token / 成本统计 | `renderer/app-agent.js` 逐轮 usage（input/output/cacheRead/cacheWrite/reasoning）+ 输出吞吐与 TPOT；`renderer/app-cost.js` 会话合计计费与峰谷口径；`scripts/audit-token-usage.mjs` 可复核 |
| 权限 / 沙箱 / 审批 | `dsh/gateway/cordis.yml` 的 `sandbox` / `sandbox-policy` / `bash-sandbox` / `pwsh-sandbox` / `approval` / `permission`（预设 `read-only` / `workspace-write` / `danger-full-access` / `mtnode-super-ask` / `bongochat` / `mtnode-unattended`）；`renderer/app-team.js` 有 per-role `toolAllow`（含 `subagent` 开关）；顶栏「审批与权限」面板 |
| 技能 on-demand 加载 | `@deepseek-ai/dsh-skill` + `skill-filesystem` + `tool-skill`；`mtnode-agent-skills-lib.js` 生成技能索引；`renderer/app.js` `slashTick()` 的 `/` 技能菜单（16335 行起） |
| 规则文件 | `agent-instructions`（`maxBytes 65536`）读 `AGENTS.md`（无 `agent.md` 时回退） |
| MCP | 扩展能力管理对话框（`renderer/app-plugins.js` 的 `EXT_KINDS` + `#extManagerDlg`） |
| 结构化输出（部分） | `proc_text` 有「JSON 尝试」解析、`judge` 节点出 YES/NO 两路；但无 schema 校验与自动重试 |
| 回滚 | `rollback-store.js` + `renderer/app-rollback.js`（画布 / 配置级回滚） |
| 快捷键 | `renderer/app-keys.js` + `index.html` 的 `data-shortcut`（1/2/3/Space/D/J/K/L 共 8 个） |

**结论：真正的差距集中在「配置化 / 可扩展 / 面向开发代码」三层**，不是「有没有 agent 能力」。下面每条建议都建立在这个判断上。

---

## 三、结构性差异（不可照搬，但决定改法）

1. **定位不同**：OpenCode 是「终端优先的 coding agent」，一切围绕代码仓库；MTNode 是「画布优先的编排器 + 桌面应用」，用户是非程序员为主。所以 OpenCode 的 TUI / IDE 插件 / GitHub Action 这类**形态**不该照搬，但它的**机制**（权限矩阵、结构化输出、hook 面、事件流）可以直接吸收。
2. **架构不同**：OpenCode 内核是 headless server + OpenAPI + 多客户端；MTNode 内核是 Electron 主进程 + IPC 白名单桥（`main.js` / `preload.js`）+ `dsh/` 独立网关进程（stdio 换行分隔 JSON，`main-dsh.js` ↔ `gateway.mjs`）。**本轮范围不含 server 化**，但 OpenCode 的「单流事件 + 契约先行」思路可用在渲染层与网关之间（`session/*` 事件已有基础）。
3. **生态不同**：OpenCode 靠 npm 包 + `models.dev` 目录 + 社区插件；MTNode 靠应用内「插件 / 工坊 / 扩展能力」三段。因此对标重点应落在**用户可配置**，而不是「多写插件」。

---

## 四、差异矩阵与逐条增强建议

约定：**价值**=用户可感知收益，**成本**=实现代价（S ≤ 半周，M ≈ 1–2 周，L ≥ 2 周），**开关**=是否需要可关掉 / 可回滚（按已确认口径：高风险项必须有）。排序 = 价值 ÷ 成本。

### 方向 A · Agent 会话能力

| # | OpenCode 怎么做 | MTNode 现状（依据） | 建议做什么 | 价值 | 成本 | 开关 |
| --- | --- | --- | --- | --- | --- | --- |
| A1 | 约 20 个 plugin hook 是**用户可写的驻留扩展点**：`tool.execute.before/after`、`chat.params`、`shell.env`、`permission.ask`、`experimental.chat.system.transform`、`experimental.session.compacting` | `dsh/gateway/*-plugin.mjs` 全是**内部**插件，用户在应用内没有任何插桩点；`renderer/app-plugins.js` 只管「启停插件 / 挂 MCP / 装技能」 | 在「扩展能力管理」里新增 **DSH 插件可视化编辑器**：新建插件 = 选 hook 类型 + 填 JS 片段 + 起止开关，落数据目录，网关按 `cordis.yml` 现有 `plugins/` 位加载 | 高 | M | 是 |
| A2 | 权限是**用户可编的 glob 矩阵**（`permission`），last-match-wins，`.env` 默认 deny，`doom_loop` / `external_directory` 默认 ask，`--auto` 仍强制显式 deny | 只有 6 个固定预设（见 §二），规则写死在 `cordis.yml`；`renderer/app-team.js` 的 `toolAllow` 是角色级布尔，无路径 / 命令模式 | 设置 · 权限新增「规则表」：`{工具, 匹配模式, 允许/询问/拒绝}` 有序列表 + 详情页说明「后匹配先生效」；内置安全默认（`.env*` deny、工作区外 ask、同一工具同参重复 3 次 ask） | 高 | M | 是 |
| A3 | 自定义 agent = markdown + frontmatter（`description`/`mode`/`model`/`permission`/`tools`），`opencode agent create` 交互生成；subagent 未指定模型则**继承调用者** | `renderer/app-team-recruit.js` 是模板化「招募专家」，无自由系统提示词、无 mode、不能按角色指定模型 | 「专家团 · 招募」改造：开放系统提示词编辑 + 每个专家可指定 provider/model + 勾选预置工具/技能（写进现有 `toolAllow`），并提供「用一句话让 AI 生成这个角色」 | 高 | M | 否 |
| A4 | `subagent_depth` 默认 1、`0` 全禁、`2` 多一层；`task` glob `deny` 会把该 subagent 从工具描述里整段移除 | `cordis.yml` 挂了 subagent 三件套但**无深度键**；用户无法禁掉某个子代理或限制嵌套 | 设置 · 会话加「子代理」小节：最大嵌套深度（0/1/2）+ 可用子代理清单（勾掉即从工具描述移除）+ 单次并发上限 | 中 | S | 是 |
| A5 | `opencode export [sessionID] [--sanitize]` 导出 transcript；`opencode stats --days --tools --models --project` 按项目 / 模型 / 工具聚合 | 有逐会话台账（`tokenReport` / `byModel`）与 `scripts/audit-token-usage.mjs`，但**没有导出入口、没有跨会话聚合视图** | 会话面板加「导出」：Markdown / JSON 两式（含工具调用与用量，可选「脱敏」去掉正文与路径）；顶栏或设置加「用量统计」页：按天 / 按模型 / 按画布聚合 + 表格导出 | 中 | M | 否 |
| A6 | `share`（`manual|auto|disabled`）生成公开只读链接，`import <share URL>` 回灌；企业可禁 | 无分享（本轮范围也不含云端） | **不做**，仅在本文登记能力缺口 | — | — | — |

**A 方向落地要点**：A2 的规则表要与现有预设并存（预设 = 规则表的一个「一键填充」），并在 `dsh/gateway/permission-presets` 之上叠一层宿主侧规则求值，避免改 `dsh/` 契约；A1 的插件编辑器只负责「写文件 + 注册」，加载仍走网关现有插件目录位。

### 方向 B · 代码智能（MTNode 的全新能力）

| # | OpenCode 怎么做 | MTNode 现状 | 建议做什么 | 价值 | 成本 | 开关 |
| --- | --- | --- | --- | --- | --- | --- |
| B1 | LSP 客户端内建：内置 35 个语言服务器、多款自动安装（`OPENCODE_DISABLE_LSP_DOWNLOAD` 可关），`lsp` 实验工具可 goToDefinition / findReferences / hover / documentSymbol / incoming+outgoing calls；事件 `lsp.client.diagnostics` 把诊断推给客户端 | **完全没有**（全仓无 LSP 客户端、无 diagnostics 通道） | 新增主进程模块 `lsp-host.js` + `lsp-client.js`（独立子进程，LSP over stdio）+ 渲染层 `renderer/app-lsp.js`：按扩展名拉起对应语言服务器、把 `textDocument/publishDiagnostics` 归到「文件 → 诊断」，并作为**可控工具**暴露给智能体（`diagnostics` / `hover` / `definition`）；语言服务器按下表管理 | 高 | L | 是（默认关） |
| B2 | 语言服务器**自动下载**并管理，用户不用先装 | 无 | 承接你已确认的口径：应用自动下载并管理常用语言服务器 —— 首批建议 `typescript-language-server`、`pyright`、`gopls`、`rust-analyzer`、`bash-language-server`、`yaml-language-server`；统一落 `%APPDATA%\pipeline-console\pipeline-console\lsp\<lang>\<version>\`，带下载源回退、断点续传、sha256 校验、「已安装 / 可更新 / 损坏可修复」三态与手动指定本地可执行文件的逃生口 | 高 | M | 是 |
| B3 | formatter 默认关、内置 26 个，`$FILE` 占位，**写 / 改之后在后台跑**（不是编辑器保存钩子） | 无 | 智能体写完文件后按扩展名跑格式化（`prettier` / `ruff` / `gofmt` 等首批 6 个），结果记进会话工具日志；失败只提示不改写 | 中 | M | 是 |
| B4 | `snapshot` 默认开：`track/restore/revert/diff`，`/undo` `/redo` 依赖 git 仓库；`session.revert` 存 `{messageID, partID, snapshot, diff}` | 有画布 / 配置级回滚（`rollback-store.js`），**没有代码文件级快照** | 会话内新增「代码快照」：每轮开始前对**本轮被改动的文件**留底（复用 `rollback-store.js` 的存储层，不引 git），会话面板提供「回到这一步之前」并列出将还原的文件 | 中 | M | 是 |
| B5 | 官方自己提醒：LSP「不总是净收益」，更推荐让 agent 直接跑 lint / typecheck CLI，并把这些命令写进 `AGENTS.md` 或 skills | 技能体系已支持写这类规范 | **不做新功能**，改为在 `guides/` 与技能索引里补一条「项目级校验命令」最佳实践，并把 B1 的 `diagnostics` 工具定位成「写完文件后的即时反馈」而非唯一判据 | 低 | S | 否 |

### 方向 C · 模型与 Provider

| # | OpenCode 怎么做 | MTNode 现状（依据） | 建议做什么 | 价值 | 成本 | 开关 |
| --- | --- | --- | --- | --- | --- | --- |
| C1 | 目录来自 **models.dev**，支持 75+ provider；模型元数据含 `family/release_date/attachment/reasoning/tool_call/cost{input,output,cache_read,cache_write,context_over_200k}/limit{context,output}/modalities/status` | `renderer/app-cost.js` 的 `DS_PRICE` 是**硬编码的 3 个 DeepSeek 模型**（cacheHit/cacheMiss/output，¥/M tokens），非 DeepSeek 模型一律**不显示费用**（`costIsDeepseekOfficial` 为假即 `null`）；`renderer/app-settings.js` 的模型列表只从 provider 端点拉 id | 引入 models.dev 目录（随包内置快照 + 可刷新）：模型列表显示**上下文窗口、能力标签（推理 / 工具 / 视觉 / 附件）、输入输出单价**；费用估算扩到「目录里有价的任意模型」，多币种；目录取不到时回落到现有 DeepSeek 表，保证离线可用 | 高 | M | 是 |
| C2 | reasoning effort 体系化：OpenAI 系 `reasoningEffort`、Anthropic 系 `thinking.budgetTokens`；**variants**（Anthropic `high`/`max`、OpenAI `none…xhigh`）用 `ctrl+t` 在会话里即时轮换，可自定义 `variants.<name>` 与 `{disabled:true}` | 有 provider 级推理强度与全局「思考强度档」（设置 · 模型，`low/medium/high/xhigh/max`），但**档位是全局的**，不能按模型 / 按会话切换 | 把「思考强度」做成**会话内可即时轮换的模型变体**（输入框旁一个 chip，类似 OpenCode 的 `variant_cycle`），并允许在设置里为每个模型维护自己的变体清单（含停用） | 中 | M | 否 |
| C3 | provider 细项：`npm` / `env` / `whitelist` / `blacklist` / `options{apiKey,baseURL,headers,timeout(300000),headerTimeout,chunkTimeout}`；认证 `opencode auth login/logout/list` 落 `auth.json`；`disabled_providers` 优先于 `enabled_providers` | 配置在 `config-providers.js` + `%APPDATA%` 的 SQLite；有 Key 管理、模型优先级拖拽；**无「白 / 黑名单收窄模型」与「按请求超时」** | provider 详情页补两项：模型白 / 黑名单（白名单先收窄、黑名单再剔除）+ 请求超时（连接 / 首字节 / 分块三档，默认 300s）；被禁 provider 不出现在模型选择器里 | 中 | S | 否 |
| C4 | 自定义 provider：`/connect` → Other → 填 ID → 写 `"npm": "@ai-sdk/openai-compatible"` 或 `"@ai-sdk/openai"`（对应 `/v1/chat/completions` 与 `/v1/responses`） | 已有自定义 provider 与 OpenAI 兼容端点支持 | **不做新功能**；仅在 provider 表单里补一行说明两种端点风格的差异 | 低 | S | 否 |

### 方向 D · 开发者体验

| # | OpenCode 怎么做 | MTNode 现状（依据） | 建议做什么 | 价值 | 成本 | 开关 |
| --- | --- | --- | --- | --- | --- | --- |
| D1 | 命令面板 `ctrl+p`（action `command_list`），可搜全部动作 | **无命令面板**；动作只走按钮、右键菜单、`/` 技能菜单 | 新增 `renderer/app-cmdpal.js` + `css/cmdpal.css`：`Ctrl+P` 打开，聚合「顶栏入口 + 画布动作（重排 / 居中 / 导出）+ 视图切换 + 设置页 + 节点动作 + 技能」，支持拼音 / 英文 / 中文模糊匹配与最近使用 | 高 | M | 否 |
| D2 | 约 130 个具名 action 全部可在 `tui.json` 改键位，值支持字符串 / 逗号串 / 数组 / 对象，`"none"` / `false` 关闭，且有 `leader` 键 + `leader_timeout` | `renderer/app-keys.js` 只有 **8 个固定单键**（1/2/3/Space/D/J/K/L，来自 `index.html` 的 `data-shortcut`），**不可配置、无组合键、无 leader** | 键位系统升级：动作注册表（id + 默认键 + 作用域）+ 设置 · 快捷键页（录制 / 冲突检测 / 恢复默认）；`app-keys.js` 的现有 8 个键作为默认值保留，`index.html` 的 `data-shortcut` 降级为「默认值来源」 | 中 | M | 否 |
| D3 | 多会话：`/sessions` 列表、`session_child_*` 四件套导航子会话、prompt stash、`session list --format json` | 左侧栏已有多会话列表与画布 tab；`forkAgentSession` 已存在，但**子会话导航、会话重命名 / 删除的批量操作、prompt 暂存**未成体系 | 会话列表补：子会话树（父 → fork 子）、重命名 / 删除 / 导出右键项、`Ctrl+K` 会话快速切换（与 D1 共用检索） | 中 | M | 否 |
| D4 | IDE 集成：在 VS Code 系编辑器终端首跑自动装扩展，`Cmd/Ctrl+Alt+K` 插入 `@File#L37-42` 引用、自动共享选区 | 无 IDE 插件；但 `dsh` 网关是 stdio 契约（`main-dsh.js`） | 低成本版：提供 **CLI 入口**（`mtnode run` / `mtnode attach`），让外部编辑器 / 脚本能驱动一次会话并按 `--format json` 回事件；IDE 插件本身不进本轮范围 | 中 | M | 是 |
| D5 | 主题独立 `tui.json` + `defs` 复用色 + dark/light 双值 + `none` 继承；内置 11 套 | 已有主题体系（`renderer/css/` + `app-canvas.js` 主题逻辑，含 `theme-light.css`） | 已有基础，**不做**；仅在 D1 命令面板里加「切换主题」动作 | 低 | S | 否 |

### 跨方向备选（价值高但与已定范围冲突，供你决定是否破例）

| # | 内容 | 冲突点 |
| --- | --- | --- |
| X1 | **配置分层**：OpenCode 8 层配置合并（远程 `.well-known/opencode` → 全局 → env → 项目 → `.opencode` → 托管目录 → MDM），且 `additionalProperties:false` 让拼错的键直接报错 | 需引入「项目级配置目录」概念，改变现有单 `%APPDATA%` 模型；`additionalProperties:false` 会**破坏现有用户配置的兼容性**（老字段一律报错） |
| X2 | **结构化输出内建**（`body.format = {type:"json_schema", schema, retryCount}`）：让节点间传 JSON 真正可靠 | MTNode 的 `proc_text` 目前靠提示词 + 「JSON 尝试」解析；做进引擎要改 `renderer/app-nodes.js` 的请求组装，且非 OpenAI 系 provider 未必支持 `response_format`（需按 provider 能力降级） |
| X3 | **server / SDK 化**：`opencode serve` + OpenAPI + `GET /event` SSE + JS SDK | 明确超出本轮「只动桌面应用、不碰运行时骨架」的范围 |

---

## 五、实施清单（可勾选）

排序 = 价值 ÷ 成本。表格最后两列是开工前的确认项：**开关**（是否带可关 / 可回滚）与 **依赖**（必须先做哪条）。

| 勾选 | # | 条目 | 主要改动面 | 价值 | 成本 | 开关 | 依赖 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| ☐ | A1 | DSH 插件可视化编辑器（hook 插桩点） | `renderer/app-plugins.js` + 新 `css`；写数据目录的插件文件 | 高 | M | 是 | — |
| ☐ | A2 | 权限规则表（glob + 后匹配先生效 + 安全默认） | `renderer/app-team.js` / `app-settings.js` + 宿主侧规则求值（不改 `dsh/` 契约） | 高 | M | 是 | — |
| ☐ | A3 | 自定义 agent 角色（自由提示词 + per-role 模型 + 工具勾选） | `renderer/app-team-recruit.js` / `app-team.js` | 高 | M | 否 | — |
| ☐ | B1 | LSP 客户端 + 诊断工具（渲染层入口 + 智能体可控工具） | 新 `lsp-host.js` / `lsp-client.js`（记入 `build.json` `files`）+ `renderer/app-lsp.js` + `preload.js` 白名单 | 高 | L | 是（默认关） | B2 |
| ☐ | B2 | 语言服务器自动下载与管理（首批 6 种 + 三态 + 修复） | 新主进程模块 + 设置 · 代码智能页 | 高 | M | 是 | — |
| ☐ | B3 | 写文件后自动格式化（首批 6 种 formatter） | 网关插件目录位（新增独立插件）+ 会话工具日志 | 中 | M | 是 | B2（复用下载器） |
| ☐ | B4 | 会话内代码快照与回退（复用 `rollback-store.js`） | `rollback-store.js` + 会话面板 | 中 | M | 是 | — |
| ☐ | B5 | 「项目级校验命令」最佳实践文档 | `guides/` + `mtnode-agent-skills` 索引 | 低 | S | 否 | B1 |
| ☐ | C1 | models.dev 目录接入（上下文窗口 + 能力标签 + 多 provider 单价） | `renderer/app-settings.js` / `app-cost.js` + 内置目录快照 | 高 | M | 是 | — |
| ☐ | C2 | 会话内模型变体 / 思考强度即时轮换 | `renderer/app-agent.js` / `app-assist.js` 输入区 + 设置 · 模型 | 中 | M | 否 | C1 |
| ☑ | C3 | provider 停用 / 模型白黑名单 + 请求超时三档 | `renderer/app-settings.js` / `main.js`（三档看门狗） | 中 | S | 否 | — |
| ☑ | A4 | 子代理策略：嵌套深度（默认 1）+ 总开关 + 后台并行 + fork | `dsh-agent-policy.js`（新）+ `main.js` + `dsh/gateway/cordis.yml` + 设置 · 智能能力 | 中 | S | 是 | — |
| ☐ | A5 | 会话导出（Markdown / JSON / 脱敏）+ 跨会话用量统计 | 会话面板 + 新统计页 | 中 | M | 否 | — |
| ☐ | D1 | 命令面板 `Ctrl+P` | 新 `renderer/app-cmdpal.js` + `css/cmdpal.css` + `index.html` | 高 | M | 否 | — |
| ☐ | D2 | 键位系统可配置（动作注册表 + leader + 冲突检测） | `renderer/app-keys.js` + 设置 · 快捷键页 | 中 | M | 否 | D1（共用动作表） |
| ☐ | D3 | 多会话完善（子会话树 + 重命名 / 删除 / 导出 + `Ctrl+K` 切换） | 左侧栏会话列表 | 中 | M | 否 | D1 |
| ☐ | D4 | 外部驱动 CLI（`mtnode run` / `--format json`） | 新 `scripts`/根目录 CLI 入口（复用 `main-dsh.js` 契约） | 中 | M | 是 | — |
| ☐ | X2 | 结构化输出内建（JSON schema + 自动重试） | `renderer/app-nodes.js` 请求组装（需按 provider 能力降级） | 高 | M | 是 | 需你破例（超出四方向） |

**已批准的批次**（拷问确认版：每批做完停下验收，改下一批前要再确认）：

- 第 1 批：**A4**（子代理策略）+ **C3**（provider 停用 / 模型白黑名单 / 超时三档）
- 第 2 批：**A2** 权限规则表（宿主侧拦截审批自动应答，规则表叠加在现有 6 预设之上）
- 第 3 批：**C1** models.dev 目录（随包内置快照 + 设置里手动刷新）
- 第 4 批：**A3** 自定义 agent 角色 + **B2** 语言服务器自动下载（首批 6 种，带三态与手动指定逃生口）
- 第 5 批：**B1** LSP 客户端（默认关）+ **A1** DSH 插件可视化编辑器（默认开启、写插件时二次确认）
- 第 6 批：**A5** 会话导出与用量统计 + **D3** 多会话完善（无 `Ctrl+K`）+ **B4** 代码快照回退 + **C2** 思考强度即时轮换
- 第 7 批：**X2** 结构化输出内建（默认关闭、仅对有能力的 provider 可选）

**已定取舍**（本轮拷问结论，避免反复）：

- **不做**：D1 命令面板（用户明确取消）· D2 键位可配置（随 D1 一并取消）· X1 配置分层（会破坏现有单 `%APPDATA%` 兼容）· A6 分享 · B3 写文件后自动格式化 · D4 外部驱动 CLI · B5 / C4 / D5（本来建议不做）。
- **D3 降级**：去掉与命令面板共用检索的 `Ctrl+K`，只做子会话树 + 右键重命名 / 删除 / 导出。
- **改动边界**：渲染层 + 新主进程模块 + `build.json` / `preload.js` 白名单；**不改 `dsh/` 三层契约**。唯一例外是 A4 那处「写 `cordis.yml` 的配置值」。
- **验收口径**：每批带 `test/smoke-*.js` + i18n 中英词条 + `guides/` 文档，并跑通 `npm test`（= `node test/run-all.mjs`）。

### 每条开工前会一并给出的东西

1. 逐文件改动点（新增 / 修改的路径与函数名）；
2. 开关与回滚做法（设置项位置、默认值、如何一键关掉）；
3. 冒烟回归（`test/` 下新增或扩展的用例，`npm` 脚本口径）；
4. 指南与 i18n 词条（`guides/nodes/` 或 `guides/manual/` + `renderer/i18n.js` 中英）；
5. `build.json` `files` 白名单是否需要同步（新增根目录主进程模块**必须**同步）。

---

## 六、已定（拷问结论）

1. **勾选条目**：第 1–6 批全部条目 + **X2 纳入**（默认关闭、仅对有能力的 provider 可选）；**X1 不做**。
2. **改动边界**：渲染层 + 新主进程模块 + `build.json` / `preload.js` 白名单，不改 `dsh/` 三层契约（唯一例外：A4 写 `cordis.yml` 的配置值）。
3. **节奏**：每批做完停下等你验收；收尾只更新本文的勾选与实测登记，不升版本号、不 git 提交。

---

## 七、落地登记（实测）

> 每一批落地后在这里追加一行小节：改了哪些文件、行为怎么变、怎么复现、有哪些与提案不一致的地方（不一致必须写明原因，不许默默改口径）。

### 第 1 批：A4 子代理策略 + C3 provider 策略

#### A4 · 子代理（委派）策略

- **新增** `dsh-agent-policy.js`（根目录，已进 `build.json` `files` 白名单）：纯函数
  `normalizePolicy / policyFromConfig / applySubagentPolicy / subagentDisabledInCordis`，
  按策略改写 `dsh/gateway/cordis.yml` 里 `subagent*` 那 **8 行**的 `disabled:` 取值，以及两个委派工具行的
  `maxDepth` / `enableRunInBackground`。
- **接线** `main.js`：`syncSubagentPolicy(cfg)` 在两个点各写一次 —— ① 起网关之前（首次启动 / 升级后第一次启动
  都不会再按 dsh 自带的 `maxDepth: 3` 跑）；② 每次 `config:save` 之后（设置改完立刻落进组合）。
  字节没变就一次磁盘都不碰，落盘走 `tmp + rename`，与网关自己的改写（权限预设 / win32 sandbox 补丁）不撞车。
- **出货默认**：`cordis.yml` 里两行静态写成 `maxDepth: 1`（对齐 OpenCode 的 `subagent_depth` 默认），
  用户没设置过时也是收紧状态。
- **设置界面**：`renderer/app-settings.js` 的「智能能力（DeepSeek Harness / dsh）」小节新增「子代理（委派）」：
  嵌套深度 `0 / 1 / 2` + 三个开关（总开关 / 后台并行委派 / fork 型子代理），值存 `S.config.dsh.subagent`。
- **生效口径**：与权限预设、思考强度同源 —— **下一个新会话**用新值，正在跑的会话沿用原设置；实际写入在
  `<数据目录>\dsh-home\dsh.log` 的 `subagent policy applied:` 一行。
- **与提案不一致（必须说明）**：提案写的是「深度 + **可用子代理清单**（勾掉即从工具描述移除）+ **单次并发上限**」，
  实测后改成「深度 + 总开关 + 后台并行 + fork」四个语义开关：
  1. MTNode 的 dsh 运行时**没有命名的子代理注册表**（子代理是父 agent 现造的临时子会话，只有 spawn / fork 两种提供方），
     所以不存在「general / explore / scout 那种清单」可勾；能关的就是「整套委派 / fork 这一型 / 后台并行」。
  2. dsh 侧的 `@deepseek-ai/dsh-subagent` **没有并发数帽**（只有 `enableRunInBackground` 与 one-shot / continuable 两种模式），
     拿不到数值并发上限；因此用「关掉后台并行委派」把并发收敛成「前台一次一个」，这是不新增 dsh 接口前提下最接近的等价物。
  3. 另外这 8 行在网关里是**平台条件行**（`disabled: !!js ...`，`describePlugin` 判 `dynamic` → 不可手动挂/卸），
     所以开关只能由宿主改写组合文件，而不是点「扩展能力管理」里那排开关。
- **回归**：`test/smoke-subagent-policy.js`（52 项）钉住策略归一、8 行全关、**关掉再打开逐字还原**（含平台条件行）、
  深度 0/1/2、后台并行的物化与还原、fork 只关 fork 两行，以及上面所有接线点。
- **文档**：`guides/manual/dsh.md` 新增「子代理（委派）：深度与开关」小节（含排障口径）。

#### C3 · 服务商模型策略（白 / 黑名单 · 停用 · 三档超时）

- **纯函数**放在既有可 `require` 的 `renderer/app-model-kind.js`（新增「服务商模型策略」段）：
  `modelGlobToRegExp / modelMatchesPatterns / providerModelAllowed / providerModelFilter /
  providerSelectableModels / providerTimeoutTiers / providerTimeoutSpec / deepseekRouteSelectable`。
  **未新增根目录模块 ⇒ `build.json` 未动**（`main.js` 只 require 既有文件）。
- **超时看门狗**（`main.js`）：`timeoutTiersOf` / `attachRequestWatchdog` / `timeoutErrorOf` 一套内核，
  `fetchJson` / `apiCall` / `streamTextChat` / `appsAiCallStream` / `api:callStream` 全部换过来；
  **撤掉**了 `streamTextChat` 里旧的单档 `rq.setTimeout(180000, …)`。定时器 `unref()` 且每条出口
  （结束 / 400 / 出错 / `res` error / `req` close / 被 ■ 中止）都 `stop()`，不漏也不残留。
- **语义**：白名单**先收窄** → 黑名单**再剔除**；两串都空 = **原样返回**（老配置逐字不变、幂等、不复制数组）。
  分隔符 `,` / `，` / `;` / `；` / 空白，去重保序；`*` 零或多个字符、`?` 恰一个，其余字符按**字面量**
  （正则元字符全部转义），整体锚定、匹配模型 id、大小写不敏感。三档超时逐档取
  「spec 显式下发 > 服务商字段 > 缺省 300000」，非正数/非数字回落缺省，**`timeoutMs === 0` 的既有路径
  （生图取回）依旧完全不设时限**。
- **停用（`disabled`）的边界**：不进任何模型选择器（节点设置 / 智能会话 / 全局助手 / 开发节点 Agent 设定 /
  团队视图 / 专家招募 / AI 复核 / 视觉候选表），但**不阻断运行**：已绑定节点保持原路由与原模型，
  `syncAgentProviderRoute` 只在「路由真的不存在」时才兜底换路由（否则用户一停用，老画布会被悄悄改到别家）；
  节点设置表里对「已停用」的那家仍回显并标注，避免开一次设置就改掉画布。
- **UI**：`renderer/app-settings.js` 服务商对话框新增 白名单 / 黑名单 输入（含「过滤后可用 N / M」实时小结）、
  三档毫秒输入（placeholder 300000）、「停用该服务商」勾选；服务商卡片加「已停用」角标；模型行对策略外模型
  标「策略外」但仍可排序 / 删除（管理列表要看得见、能改）。样式进 `renderer/css/components.css`。
- **与提案不一致（必须说明）**：
  1. 提案写「被禁 provider 不出现在模型选择器里」，落地时把「停用」定义成**纯可见性开关**（不动配置、不阻断
     已绑定节点）；比提案更保守，代价是停用不等于「一票否决」。
  2. 三档超时按**各阶段空闲看门狗**实现（连接 / 首字节 / 分块间隔），不是「整轮绝对总时限」——绝对总时限会把
     长思考的流式回答误杀，这与 dsh 侧既有的超时策略也不一致。
- **回归**：`test/smoke-provider-policy.js`（**193 项**，含真跑 `main.js` 的 `timeoutTiersOf` 切片与三档看门狗
  真触发、临时目录验证四个字段写盘/读回、`app.js ↔ app-agent.js` 11 个同名函数逐字一致）；配套
  `test/smoke-provider-models.js` 给真跑沙箱补了 `clearTimeout`（新看门狗会清定时器）。`guides/manual/providers.md`
  新增「进阶：模型白 / 黑名单、停用服务商、请求超时」一节。