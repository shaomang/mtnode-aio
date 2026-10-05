# MTNode × DeepSeek Harness 集成设计

> 本文件是 dsh 集成的架构契约。修改集成代码前先读这里。
> 面向普通用户的说明见 [README.md](README.md)。

## 目标与约束

1. **解耦优先**:dsh 处于 developer preview,破坏性变更频繁。dsh 的任何升级只能触及
   `dsh/` 目录(gateway、cordis.yml、依赖版本),`main.js`/`preload.js`/`app.js` 只依赖
   本仓库自有的稳定协议,不 import 任何 dsh 代码。
2. **降级保底**:所有升级节点保留原有实现。dsh 未启用、未安装、启动失败、无适配的
   服务商时,节点行为与接入前完全一致。
3. **普通用户可用**:新增能力以「一键开关 + 节点模板」形态呈现,不需要命令行知识。

## 架构总览

```
renderer (app.js, CJS 浏览器侧)
  │  window.api.dsh.*            (preload 白名单桥)
  ▼
main.js (CJS, Electron 39 / 内置 Node 22.22.1)
  │  dsh/main-dsh.js             (主进程适配器,只懂本地协议)
  │  本地协议:换行分隔 JSON over stdio   ← 稳定契约,mtnode 自有
  ▼
gateway (dsh/gateway/gateway.mjs, ESM, 独立 Node ≥ 22.19)
  │  @deepseek-ai/dsh-sdk-client (DeepSeekHarness)
  ▼
dsh runtime 子进程 (node @deepseek-ai/dsh/lib/bin.js --profile sdk --patch cordis.yml)
  │  profile=sdk = @deepseek-ai/dsh-base + @deepseek-ai/dsh-sdk-app 两层 bundle
  │  cordis.yml = MTNode 的补丁层（覆盖行 + insert 段）
  ▼
DeepSeek API
```

### 运行时组合（0.2 profile + patch）

dsh 0.2 起运行时不再由「一个完整 cordis.yml + sdk-jsonrpc-demo/bin」直起，而是**命名
profile + 有序补丁层**：

1. CLI 在 `$DSH_HOME/profiles/sdk/` 生成 profile（首次自动从内置模板初始化），
   `package.json` 的 `dsh.profile.bundles` 列出该 profile 的 bundle 层
   （SDK 发行物固定为 `@deepseek-ai/dsh-base`（核心脊柱）+ `@deepseek-ai/dsh-sdk-app`
   （SDK JSON-RPC 服务端，含 `sdk-jsonrpc-server` 行））。
2. 组合顺序：bundle 层 → `--patch` 传入的补丁层（= 本仓 `dsh/gateway/cordis.yml`）
   → `$DSH_HOME/profiles/sdk/cordis.patch.yml`（用户层）。
3. 补丁层两种语义（见上游 `docs/user/develop/basic/config`）：
   - 顶层 `- id: <已存在的行>`：**整份替换**该行的 `config`（不是合并）；
   - `- insert: [ ... ]`：新增条目（`insert:` 只能出现一次，段内行缩进 4 空格）。
   所以 `cordis.yml` 只写「与 base 不同的覆盖行」+「MTNode 自有 / 0.2 新增行」，
   不再逐行抄一遍骨架。

网关侧对应改动（`gateway.mjs`）：

- `new DeepSeekHarness({ dshBin, profile: 'sdk', patches: [CORDIS_PATH], cwd, processCwd, env })`
  —— 0.2 的 launcher 是 `dshBin` / `profile` / `patches` / `env` / `cwd`，旧写法
  `launch: { command, args }` 已不存在；bin 由 `require.resolve('@deepseek-ai/dsh')`
  解析后显式传入（SDK 的 `dshManifest.version !== clientManifest.version` 会硬报错）。
- 握手走 `await harness.start()`（高层 API，自带「只握手一次 + 失败换新客户端」）；
  旧写法 `harness.client.start()` + `harness.client.initialize(params)` 在 0.2 不可用。
- 低层 JSON-RPC 直呼（`session/resume`、`session/steer`、`session/pause` 三枚桥方法）
  仍是 `harness.client.request(method, params, timeoutMs)`，语义未变。
- `parsePluginRows` 兼容缩进行（`insert:` 段）——网关设置页的插件清单据此列出插入行；
  `applySandboxWorkaround` 仍按文本替换 `- id: sandbox` 段（顶层覆盖行，未缩进）。
- 内置 UI 行 `session-log-deepseek` / `plugin-package-inventory-deepseek` 显式关闭：
  两者各在每条请求前认领一个顶层扩展字段，缺服务即整条请求 preparation 失败
  （实测 `DeepSeek request extension preparation failed`）；MTNode 不發也不消费这两个字段。

### 设置下发（0.2：命令行叠加层）

0.1 代网关把「服务商目录 / 权限预设 / 官方模型清单 / 宿主人设」写进 `<DSH_HOME>/settings.yaml`，
运行时经 `dsh-settings-file` 读回。0.2 删掉了这个文件型适配器（基座组合里不再有该行）：

- 运行时侧只剩 `@deepseek-ai/dsh-settings`，它在启动时把遗留的 `settings.yaml` **改名成
  `settings.yaml.imported` 并尝试导入进 profile**；导入后该文件不再被读取，网关继续写它
  等于写进死信（实测目录里只剩 `settings.yaml.imported`）。
- 0.2 的真源是**补丁层**，但另外两处都打不到宿主托管的那四行 —— 实测（`config/probe` 桥）：
  · `profiles/sdk/cordis.patch.yml`（profile 用户补丁层）：打得到顶层行
    （`permission.defaultPreset` 实测生效），打不到基座 `insert:` 里插进来的行
    （`llm-deepseek` / `system-prompt` / `llm-pi-ai` 的补丁被静默忽略）；
  · 运行时自己的 `ctx.settings.update(ns, values)`：直接拒绝，实测回
    `Configuration for "llm-deepseek" is overridden by a home patch or command-line overlay`
    （`system-prompt` 另回 `has no volatile fields`）。
- **落地写法（已实测四段全部抵达运行时）**：网关把托管四段写成
  `<DSH_HOME>/mtnode-settings.patch.yml`，作为**第二枚 `--patch` 叠加层**随 `cordis.yml`
  之后下发（见 `getRuntime` 的 `patches`）。命令行叠加层层序在 profile 用户层之后
  = 最后写入者胜，四行全部打得中；文件由 `applySettings` 每次运行前**整份重写**（只装
  托管段，用户自己的补丁请写 profile 层那一个文件，两处职责不重叠）。
- 口径：`llm-deepseek.reasoningEffort` 只写兜底默认 `high`（档位切换走 env `MTNODE_EFFORT`
  + `mtnode-effort` 插件按模型能力夹紧）；`llm-pi-ai.providers` 的密钥只经 `apiKeyEnv`
  引用宿主注入的 `MTNODE_KEY_n`，配置文件里不出现密钥值。
- **硬约束（踩过）**：按 id 的补丁是**整份替换该行的 `config`**，不是深合并
  （`dsh-app-boot` 的 `applyEntryPatches`：`target[key] = value`）。所以托管行必须**自带它
  需要的全部字段**：`- id: permission` 只写 `defaultPreset` 会把 `cordis.yml` 那张 presets
  表整张抹掉 → 插件回落自带的 `workspace-write` / `danger-full-access` 两个默认档 →
  `PermissionPresetService` 构造期 `resolve('mtnode-unattended')` 抛错 → 整行不激活，
  stderr 见 `permission: unknown preset "mtnode-unattended" (known: workspace-write,
  danger-full-access)`。故网关的 `permissionPresetsConfig()` 每次重写都带上六档全表
  （`read-only` / `workspace-write` / `danger-full-access` / `mtnode-super-ask` /
  `bongochat` / `mtnode-unattended`），用它与 `cordis.yml` 的 `- id: permission` 逐字同源；
  回归见 `test/smoke-settings-profile-patch.js` [6]，组合层复核跑
  `scripts/audit-dsh-profile-patch.mjs`（只读，审计本机 `DSH_HOME` 那份叠加层）。
- 遥测：基座组合自带两行 OTel（`dsh-otel` / `dsh-session-telemetry-otel`，`FEEDBACK_ONLY`），
  在这台机器的运行时里两行都导入失败、每次启动在 stderr 刷两条 `failed to import`
  （实测：两个包单独 `import` 都成功，是运行时导入路径的问题，不是缺依赖）。
  两行的**稳定**关断写在 `cordis.yml`：按 id 各来一行 `disabled: true`（**两行都要** ——
  补丁一条只打一个 id，只关一行另一行照样报；dsh 自己的 `DSH_TELEMETRY_DISABLED` 开关
  按 id 也只打得到 `session-telemetry-otel`）。网关另在 `getRuntime` 的 spawn env 里注入
  `DSH_TELEMETRY_DISABLED=1` 作为 dsh 官方口径的兜底（任何非空值即禁用；组合里没有遥测行
  时无副作用）。该 env 不进 runtime key：不影响模型能力 / 工具集，换档不多起进程。
  需要遥测时删掉 `cordis.yml` 那两行即可。

### 设置抵达运行时的自检（`config/probe` 桥）

写了文件 ≠ 运行时读到了。`plugins/session-resume-server.mjs` 另装一枚只读 JSON-RPC 方法
`config/probe`（与 `session/resume` / `session/steer` 同构的原型级补丁）：运行时把
`ctx.get('configEditor').configuration()` 里宿主关心的行（`llm-deepseek` / `llm-pi-ai` /
`permission` / `system-prompt` / `mtnode-tool-visibility` / `agent-default-model`）
按 `{ id, config }` 回给网关。网关侧 `configProbe` 本地方法按 `reqId` / `runKey` 定位那台
live runtime 转发（池里没有 = `{ ok:false, reason:'no_runtime' }`，不为探针新起进程）。
回归见 `test/smoke-config-probe.js`（端到端，只跑假 key 的一轮、不跑真模型对话）与
`test/smoke-settings.js` 的「已并入：smoke-settings-profile-patch.js」段（写入器形状 + 幂等 + 用户补丁不被碰）。

### Node 运行时（网关必须跑在真 Node 上）

dsh 0.2 的内核在 boot 阶段要用原生插件 `node-addon-require-builtin` 去 hook ESM 内部模块，
而该插件**只认它编译过的 Electron 版本**。MTNode 是 Electron 39，实测打包版每次 run 都在
host preparation 阶段硬失败（应用侧表现 = 主进程记「dsh 网关已退出」，运行时立刻消失）：

```
dsh: fatal uncaught exception: Error: dsh: host preparation failed:
node-addon-require-builtin unsupported: Unsupported/no-context
(unsupported Electron runtime fingerprint: Node 22.22.1, V8 14.2.231.22-electron.0
 (supported Electron versions: 43.0.0, 44.0.0, 45.0.0-alpha.6))
```

又因为 SDK 客户端把运行时子进程写死成 `command: process.execPath`
（`@deepseek-ai/dsh-sdk-client` 的 `resolveDshLaunch`），**网关自己必须跑在真 Node 上** ——
光给运行时换 node 是做不到的（网关是 Electron，运行时就跟着是 Electron）。
契约落在根目录 `dsh-node.js`（主进程唯一 require 入口，`build.json` 白名单内）：

1. 候选顺序：`MTNODE_NODE_BIN`（显式覆盖 / 内网自备）→ 托管 Node
   （`<数据目录>/node-runtime/node.exe`）→ PATH → 常见安装位置
   （Program Files、nvm-windows、fnm、volta、scoop、choco）。
2. 每条候选都**真跑一次版本探针**（`-p`，带 `ELECTRON_RUN_AS_NODE=1` 以免 Electron 弹窗）：
   自报 `process.versions.electron` 的一律拒（这正是坏掉的那条路），Node < 22.19 判 `too-old`。
   命中的 node 版本进 `dsh.log` 的 spawn 行（`[node 24.2.0 · path]`），排障一眼可见。
3. 一个可用的都找不到 → 回退 Electron 自带 Node（老行为）并**后台自动下载托管 Node**
   （npmmirror → nodejs.org，零依赖解压、装进数据目录），装好且**没有在途轮**时收掉网关，
   下一次请求用真 Node 冷起（有在途轮不打断用户）。`MTNODE_NO_NODE_DOWNLOAD=1` 关掉自动下载
   （内网 / 测试）。
4. 回退期间真跑起来仍会失败：main-dsh 把网关 `error` 帧里那段 SDK stderr 尾巴换成
   「本机需要 Node ≥22.19 + 现状 + 下一步」（`translateRuntimeReject`），不让用户直面 V8 指纹；
   非该错一律原样透传。
5. 自检与修复入口：`dsh:status` 附带 `node`（bin / source / version / fallback / installed /
   managed）；`dsh:installNode`（preload `dshInstallNode`）显式安装。

回归见 `test/smoke-dsh-node.js`（候选顺序、探针判据、回退、报错翻译、zip 解压、安装失败路径、
接线口径）。**不要**把 `process.execPath` 重新写回网关 spawn —— 那等于把这条事故原样搬回来。

### Messages 端点根（0.2：配置里的 OpenAI 兼容根要归一）

dsh 0.2 的 `llm-deepseek` 把 `config.baseURL` / `DEEPSEEK_BASE_URL` 当 **Messages 兼容的端点根**，
自己在其后拼 `/v1/messages`（`@deepseek-ai/dsh-llm-deepseek` 的 `messagesApiRoot`，并明说
`protocol is not configurable; use a Messages-compatible baseURL`）。而 MTNode 服务商配置里存的
是 **OpenAI 兼容根** `https://api.deepseek.com` —— 0.2 下实测（真 key）：

- `https://api.deepseek.com/v1/messages` → **404**（空体），应用侧表现 = 会话报
  `DeepSeek Messages request failed (404)`，一轮什么都没干就结束；
- `https://api.deepseek.com/anthropic/v1/messages` → **200**（`deepseek-chat` 真回复），
  DeepSeek 的 Messages 面就在 `/anthropic`。

所以网关在下发 `DEEPSEEK_BASE_URL` 前过一道 `dsh/gateway/messages-base-url.mjs` 的
`messagesBaseUrl()`：**只给官方域（`api.deepseek.com`）的裸根补 `/anthropic`**，其它域、
已带路径的端点（第三方 `.../v1`、本地 `127.0.0.1` 端点、用户手填的 Messages 根）一律原样透传。
归一幂等，且不动 runtime key 的指纹成分（key 用的是用户配置原文）。回归见
`test/smoke-dsh-node.js` 的「已并入：smoke-dsh-base-url.js」段。

三层各守其界:

- **本地协议(main.js ↔ gateway)**是 mtnode 自有格式,随 mtnode 版本演进,与 dsh 无关。
- **gateway**吸收 dsh 的全部 API 变化:SDK 客户端 API、线协议、cordis.yml 行结构、
  发布物形态,都只在这里被翻译成本地协议事件。
- **运行时组合(cordis.yml)**决定 agent 拥有哪些工具。发布 rc.6 代的全栈版本必须
  一致(见下),升级时整体升。

### 版本锁定原则

**`dsh/gateway/package.json` 必须把 dsh 全家族锁死在同一版本（当前 `0.2.0-rc.2`，
精确版本不加 `^`）**，任何升级都要整套同升并在 probe 目录验证。两条实测口径：

- `@deepseek-ai/cordis*` 是另一条产品线，用各自的稳定号（当前 cordis `4.0.4`、
  `cordis-plugin-timer` `1.1.6`、`-loader` `1.0.5`、`-include` `1.0.9`、`-group` `1.0.4`，
  精确版本）。dsh 0.2 全家族通过 `~`/`^` 依赖这一层，不要跟着 dsh 的 rc 号走。
- **两个包在 0.2 只发到 `0.2.0-rc.1`**（`@deepseek-ai/dsh-experimental-inspector`、
  `@deepseek-ai/dsh-experimental-computer-use-cua-driver-mcp`），其余家族都在
  `0.2.0-rc.2`；`@deepseek-ai/dsh-tool-subagent-report` 整包下线（不再发布），
  相关行从组合里摘掉、`dsh-agent-policy.js` 的 subagent 行表同步减一条。
- 升级后 `node_modules` 体积实测从 227MB 涨到约 760MB（内核族 233 个 `@deepseek-ai`
  目录 + 20 个实验包）；`dsh/after-pack.cjs` 会把整棵网关树按
  `docs/app-deps-prune.json` 的零引用口径剪枝后再进安装包，浏览器内核仍由
  playwright / `@puppeteer/browsers` 在用户机器上按需下载，不随包发。

## 运行时托管

- **统一 Node**:gateway 与 dsh 运行时都用**真 Node（≥22.19）**启动 —— 由 `dsh-node.js`
  在本机挑一个可用的（托管 Node → PATH → 常见安装位置），都找不到才回退 Electron 自带的
  Node 并后台自动装托管 Node。**不能**再用 `process.execPath + ELECTRON_RUN_AS_NODE=1`
  复用 Electron：dsh 0.2 的内核拒绝 Electron 指纹（见上「Node 运行时」）。
- 网关**随应用启动**(app ready 时 `ensureStarted()`,幂等,不重复起进程);
  崩溃后下一次请求自动重新拉起(自愈)。
- 运行时按 workspace 池化:同一 workspace 复用同一 runtime 进程;LRU 上限 3,超出时
  关最旧的。runtime 随网关关闭(应用退出)统一回收。
- `DSH_HOME` 指向 mtnode 自有目录(`<DATA>/dsh-home`),与开发机 `~/.dsh` 隔离。
- 凭据注入:`DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL` 由 gateway 从主进程传入
  (mtnode 配置的服务商 apiKey),每次启动运行时注入 env,不写盘。
  联网搜索(`dsh-web-search-deepseek`)固定请求 `api.deepseek.com/anthropic`,
  使用独立的 `webSearchApiKey`(优先 DeepSeek 官方服务商 Key),避免对话选了
  第三方路由时把错误 Key 注入搜索。
- 权限预设(dsh permission-presets)每次运行可切换:gateway 双写
  settings.yaml 的 `permission.defaultPreset`(热重载,覆盖池化运行时的后续会话)
  **与** cordis.yml 同名行(rc.6 运行时 settings 注入回调晚于首个会话创建,
  首个会话只认 cordis 基础层)。审批策略与沙箱随预设生效,`ask` 档位的审批请求
  经交互桥(见下)弹到宿主 UI。
- 交互桥:运行时内本地插件经 localhost TCP(端口在 spawn 时经 `MTNODE_BRIDGE_PORT`
  注入)与 gateway 通信,同一端口允许多条连接(提问桥 + 画布工具)。
  `bridge-plugin.mjs`(只 import node 内置模块)注册 `user-questions/request` 回答者与
  审批 answerer —— 两者都是普通 Cordis 瀑布监听(`ctx.on(事件, (req, next) => …)`,
  与 `approval/request` 同形状)。**dsh 0.2 起 `ctx.userQuestions` 没有 `registerProvider`**
  (0.1 的写法):提问由服务发 Agent 作用域的 `user-questions/request` 瀑布,返回值即
  `ask()` 的结果(`{answers:[…]}`),无人认领回 `NO_PROVIDER`(「no user-questions
  answerer accepted the request」→ 工具失败、不弹询问窗)。桥没连上时监听器
  `return next()` 让位给别的回答者,绝不自己造一个失败的答案。
  `canvas-plugin.mjs` 注册 `mtnode_canvas_get` /
  `mtnode_canvas_edit`(import `defineTool`,dsh 升级只改 `dsh/`)。帧转发到
  gateway,再由本地协议事件送达 renderer;回答经 `interact` 原路返回。
  `longtask-plugin.mjs` 是长周期任务系统（状态机）的工具面：注册 `lt_state`（读写本轮共享
  状态，写只允许本环节声明的输出键）与 `lt_memory`（recall / list / write / propose 四个
  动作），发 `{t:'lt', id, sessionId, action, params}`,renderer 经 `interact` 的
  `kind:'lt'` 回 `{t:'lt-result', id, ok, result|error}`。两个工具都由 `isToolHidden` 按
  运行裁剪（名单在 `tool-visibility.mjs`,渲染层据「这一轮的运行体是不是状态机里的伪节点」
  决定是否点名藏掉）。真源始终在渲染层与 `longtask-store.js`,网关不存任何长任务状态。
- **交互桥的归属契约(询问不得成为死卡)**:
  - 真实轮的 dsh session id 由 **gateway 铸造**并显式传给 `harness.run(blocks,
    {sessionId})`(SDK `RunOptions.sessionId`,未知 id = 新建会话);预热轮另铸一个,
    两轮因此不可能共用 session。占用表 `keyToReqId` 的值为
    `{reqId, sessionId, sessions}`:`sessions` 是本轮通知流里见到过的全部 session id
    (真实轮 + 它派生的子代理/后台 job),即这一轮的**会话树**。
  - **四类交互帧一律盖发起方的 session 章**:`question` / `approval` 由 `bridge-plugin.mjs`
    盖(分别取 `request.agent.id` 与 `req.agent.session.id`),`canvas` / `db` 由
    `canvas-plugin.mjs` / `db-plugin.mjs` 在发帧处盖 `exec.agent.id`(`Agent.id` 的类型就是
    `SessionId`,与提问同源)。拿不到 `agent` 时发**空串**,由网关按越权处理(fail closed)——
    归属不明的交互不该出现在任何会话里。`{t:'drop'}` 撤帧带同一枚章,与主帧归属一致。
  - gateway 收到后比对占用表:**没有归属本轮的 sessionId(与本轮会话树无交集、帧不带 id、
    或本轮尚未定型)一律立刻回 `{t:'abort'}`**,并在 stderr 打 `[ix-gate] reject …` 诊断。
    于是「本轮预热轮(`harness.run('ok')`)在问话」「上一轮遗留的后台 job / 子代理现在才醒
    过来发起交互」这类越权请求不会再弹进用户当前会话(答案送回没人听的 session = 点了没反应
    的死框);运行时侧那个工具以失败收场,模型继续走。
    **`canvas` / `db` 从前豁免门控,是「开发任务跑一会儿突然多出一个确认框、回答后执行无效」
    的直接成因**:预热轮与上一轮遗留的后台任务一样能把「危险操作确认框」弹进你正在看的这一轮,
    而那一轮早就收场了,点「确认」只把结果写回一条没人听的 socket。现在四类帧同走一道门。
  - 门控诊断必须带**来路分类**,方便按 `%APPDATA%\pipeline-console\dsh.log` 定位:
    `origin=no-sid`(帧没盖章)/ `warm`(本轮预热轮)/ `stale`(上一轮遗留,靠 `priorRunSessions`
    快照识别)/ `foreign`(会话树之外)。快照**只用于日志分类**,放行判据永远只看当前
    `claim.sessions`,快照不开任何口子。一行打全 `runKey / reqId / frameSid / runSid / tree`。
  - **逐帧异常兜底**:桥的 `socket.on('data')` 回调里对每一帧 `try/catch`。net socket 的
    `data` 回调抛出异常没有任何人接管 —— 整个网关进程当场退出(实测:一次改名漏改末行引用,
    `ReferenceError` 让网关一投交互帧就死,而主进程只在下次请求时才懒重启),所以单帧出错
    只 `{t:'abort'}` 它那一条交互并打 `[ix-gate] frame-error …`,桥与其余帧继续。
  - 撤销在途交互(`run` 收尾、`closeBridge`、单条 socket 断开)**必须同步发
    `ix-drop` 事件**:`{event:{reqId, type:'ix-drop', data:{id, kind, reason}}}`。
    本轮 reqId 已解除时发 `reqId:''` 的**全局撤卡帧**,渲染层按 `data.id` 兜底撤卡。
    插件主动放弃一条交互(`{t:'drop'}`)同样无条件发 `ix-drop`。
    pending 登记的是**四类**帧,所以画布 / 数据库的挂起确认框也一起被撤。
  - 渲染层配套(`renderer/app-nodes.js` 的 `canvasConfirm*` + `app-db.js`):由 `canvas` /
    `db` 帧弹出的确认框登记在**发起轮**的句柄上,命中 `ix-drop`、本轮收尾或该轮已不在
    `S._runCancels`(与 `ixPruneOrphanCards` 同口径)时自动关闭并以
    `{ok:false, error:'发起轮已结束,未执行'}` 回执;`{ok:true, stale:true}` 一律 toast 说明,
    绝不留「点了没反应」的死框。
  - 本契约由 `dsh/smoke-interaction-gate.mjs` 锁住(不起真实模型、不联网:网关进程内加载,
    假运行时讲 JSON-RPC,测试直连桥端口喂假帧),改门控 / 盖章 / 撤帧任一条都会红。
  - `interact` 找不到 pending 时回 `{ok:true, stale:true}`(**不是** error):
    error 会让渲染层以为"没发出去"而把卡留在屏上,用户对着死卡反复点;`stale`
    明确"这张卡作废了",渲染层据此撤卡并说明原因。
## 本地协议(main.js ↔ gateway)

换行分隔 JSON;主进程发 `{id, method, params}`,gateway 回 `{id, ok, result|error}`
以及无 id 的 `{event: {type, ...}}`。

| method | params | 语义 |
|---|---|---|
| `status` | — | `{gateway, node, runtimes, runtimeBin, configPath}` 健康与版本 |
| `run` | `{workspace, input, model?, maxTokens?, apiKey?, baseUrl?, webSearchApiKey?, systemPrompt?, hostPersona?, preset?, effort?, provider?, mtnodeProviders?, permissionPreset?, pure?, resumeSession?, images?, hostSessionId?, officialModels?}` | 排队一条提示,流式事件直至整轮 idle。`hostSessionId`(**活动流归属**,可缺省)= 宿主(渲染层)那条会话的 id(`as…`):本轮的浏览器动作 / 命令 / 文件摘要进活动流(`browser-act`)时按它盖章(`BrowserCtl.push` + `hostSessionTagOf`),活动流面板据此只显示当前会话的活动、切会话即切换;非会话轮(助手 / 未绑定节点)不带 = 那些条目不算进任何会话。它只影响留痕归属,不参与归属门控与断点续跑。`resumeSession`(**断点续跑**,可缺省)= 宿主点名沿用上一轮(崩溃 / 断线 / 超额失败)那次的 dsh session id:网关先按本机会话日志判「盘上有没有这份会话」(第一道闸),续跑轮还会先经 `session/resume` 握手让运行时把旧日志恢复为 live —— 同进程复用 / 跨进程恢复 / `RESUME_UNAVAILABLE` 三态详见「断点续跑契约」;只有**盘上无日志**(状态 C 第 1 条)才"不起 runtime、不消耗任何 token"地只回 `error`(带固定标记 `RESUME_UNAVAILABLE: …`)。`webSearchApiKey` 专供联网搜索。`hostPersona` 经环境变量 `MTNODE_HOST_PERSONA` + `MTNODE_CHAT_ISOLATE` 注入运行时（**不是** settings.yaml：`dsh-system-prompt` 不读 settings），由 `bongochat-prompt` 覆盖 `deployment:persona` 并裁剪工具；同时 cordis 在隔离态禁用画布/文件/路由等 MTNode 插件。`pure`（会话「纯净模式」，渲染层按钮开启）= **双清空 + 引擎侧裁剪**：网关强制空预设文本，并要求宿主同轮把 `systemPrompt` 置空（见 `app-assist.js` / `app-db.js` 的 pure 分支）——两段都空时 `sys` 为空，用户消息**原样**下发，不拼 `【系统设定】` 前缀；同时以 `MTNODE_PURE=1` 注入运行时，`pure-prompt` 插件（在 `system-prompt/assemble` 上 `prepend` 站到 waterfall 最外层）清空**全部** system prompt 段与运行时上下文（`suppressRuntimeContext()`），工具**仅保留联网搜索**；cordis.yml 用同一标记门控禁用画布 / 数据库 / 文件 / 命令 / 技能等 MTNode 插件。runtime key 含 pure 标记，纯净 / 非纯净**不共用进程**；fresh runtime 的预热轮（`harness.run('ok')`）与真实消息分属两个 session，不进纯净会话上下文。真实轮的 session id 由**网关铸造**并显式经 `RunOptions.sessionId` 下发（预热轮另铸一个），据此门控交互桥的提问 / 审批归属——见「交互桥的归属契约」。`officialModels`（**官方模型清单**,可缺省）= 宿主按设置勾选的 DeepSeek 官方模型列表（`[{id, name, contextWindow, maxTokens, inputModalities}]`,也接受纯 id 字符串）：网关归一（id 白名单字符 / 去重保序 / 上限 24 条 / 补已知别名映射）后写进 settings.yaml 的 `llm-deepseek.models`,**空清单 = 不写该键**（适配器回落自身 `DEFAULT_MODELS`,行为与接入前一字不变）；该段本就由宿主托管（与 `reasoningEffort` 同段,适配器每次操作重读 settings）,故**不进 runtime key**、不改续跑签名成分 |
| `cancel` | `{workspace}` | 关闭该 workspace 的全部运行时(在途 run 以错误收束) |
| `steer` | `{reqId\|cancelTag, sessionId?, text?\|contentBlocks?}` | **轮内插话**:往**正在跑的这一轮**的下一步边界投一句话(运行时侧 `agent.steer`),不重开轮、不等本轮结束。网关按在途表(`reqId → {runKey, cancelTag, sessionId}`)定位那一轮那台 runtime 的 client,同步下发 `session/steer`(10s)。送达 → `{ok:true, reqId, sessionId, steered:true, reqIds}`;没有在途这一轮 / 那台 runtime 已回收 / **老运行时没有该方法** / 下达超时 → `{ok:false, reason:'unsupported', detail}`,宿主据此回落成普通排队消息。详见「运行中插话与暂停契约」 |
| `pause` | `{reqId\|cancelTag, sessionId?}` | **轮内暂停**:中止当前请求但**保留 live 会话与收件箱**(运行时侧 `agent.cancel({kind:'user'},{keepInbox:true})`,**不关 runtime**),之后可点名 `run.resumeSession` 从中断处接下去。回执与降级口径同 `steer`(`{ok:true, paused:true}` / `{ok:false, reason:'unsupported'}`)。成功后本轮以 `done{paused:true}` 收尾,**该轮不会有 `error` 事件**(否则宿主的失败重发闸会把一次暂停当 429 类失败连重发 5 次) |
| `interact` | `{kind:'question'\|'approval'\|'canvas'\|'db'\|'facts'\|'abort', id, answers?\|outcome?\|result?\|error?}` | 回答提问 / 审批 / 画布工具 / 数据库工具 / AI 事实库工具结果,按交互 id 路由回对应运行时(`canvas` → `{t:'canvas-result'}`,`db` → `{t:'db-result'}`,`facts` → `{t:'facts-result'}`);`kind:'abort'` 让该次交互以失败收场(工具报错而非空答案)。id 已失效 → `{ok:true, stale:true}`(见「交互桥的归属契约」) |
| `providerCatalog` | — | `{deepseek:[…], piai:[…]}` 服务商/模型目录(pi-ai 同源) |
| `pluginList` / `pluginAdd` / `pluginRemove` / `pluginEnable` / `pluginDisable` | `{pkg, id?}` 等 | 读取/安装/移除/挂载/卸载 cordis.yml 插件。`pluginList` 每项含 `title`/`description`/`purpose`/`version`(来自 package.json、preset.yml、行上注释)。核心运行时行只读;非核心(用户插件、套装、可选 shipped 行)可在设置中挂载/卸载;变更后重启运行时 |
| `mcpList` / `mcpAdd` / `mcpRemove` / `mcpSetEnabled` | `{serverName, …}` | MCP 服务器管理(cordis 用户段,变更后重启运行时) |
| `shutdown` | — | 关闭全部运行时并退出 gateway |

`run` 的事件:`reasoning`(思考增量 `{text, turn, step, index}`)、`text`(正文增量
`{text, turn, step, index}`)、`say-end`(一段正文的块收尾 `{turn, step, index}`,供前端切段;
仅 `assistant/chunk` 的 `block-end` 且块类型为 `text` 时发)、`tool`(工具调用
`{name, args}`)、`status`(`{state}`)、`effort`(本轮生效思考档回传,`{requested, effort,
route}` —— 真实轮起跑前发一次,宿主按它回显「用户选的档 → 该路由实际生效的档」,见
「思考强度契约」)、`question`(模型提问,`{id, sessionId,
questions}`)、`approval`(越权审批,`{id, sessionId, toolName, callId?, reason?}` —— 沙箱拒绝
工作区外的写 / 执行后,运行时会在同一轮给模型一句 `[sandbox: escalation available …]` 提示,
模型据此带 `sandbox_permissions` + `justification` 重试,工具层才发起这次审批;宿主据此弹
「沙箱放行」卡,出口为允许一次 / **本会话后续都放行**(宿主按 runKey + 目标模式记住,之后同类
升权直接回 `allowed-once`,不再打扰)/ 拒绝。故审批档不能是 `never`:该档在审批服务内即判
rejected,请求进不了宿主 UI,沙箱拒绝就只剩一句失败)、
`canvas`(画布/应用读写,`{id, sessionId, op:'get'|'edit'|'app', params}` —— 渲染层执行后经 `interact`
`kind:'canvas'` 回传结果)、`db`(事实库读写,`{id, sessionId, action, params}` —— 经 `interact`
`kind:'db'` 回传结果)、`facts`(**AI 事实库**读写,`{id, sessionId, action, params}` —— 每张画布一份的
极简条例库,宿主按本轮绑定画布读写 `<画布文件夹>\团队事实库\AI\ai-facts.json`,经 `interact`
`kind:'facts'` 回传 `{t:'facts-result'}`;没有绑定画布时宿主回错误文本,会话不中断。与 db 帧同形状;
`canvas` / `db` / `facts` 三类帧的 `sessionId` 都是发起轮的章,网关据此门控归属)、
`ix-drop`(**撤卡通知**,`{id, kind?, reason:'aborted'|'dropped'}`
—— 该交互在本轮收尾 / 桥断开 / 运行时放弃时已作废,渲染层必须撤掉对应卡片;`reqId` 为**空串**
时是「无归属的全局撤卡帧」,渲染层按 `id` 兜底撤卡。见「交互桥的归属契约」)、
`session-event`(其余会话事件全量透传 —— **插话的注入回执 `agent/inbox/spliced`
就靠这条回流**，宿主按 `data.inserted` 的文本认回那句插话，见「运行中插话与暂停契约」)、`usage`、`title`、
`error`、`session`(**本轮 dsh 会话归属**,`{sessionId, resumed}` —— runtime 占用成功即发一次,
首条 `session.event` 改判权威 id 时再发一次,见「断点续跑契约」)、
`done`(`{finalResponse, metrics, sessionId, resumed}`;续跑不可用时另带 `resumeUnavailable:true`；
**被宿主暂停的这一轮另带 `paused:true`，且该轮保证不会有 `error` 事件**，否则宿主的失败重发闸会把
一次暂停当 429 类失败连重发 5 次，见「运行中插话与暂停契约」)。
所有事件带 `reqId`,对应一次 `run`
(`ix-drop` 的全局撤卡帧例外:reqId 为空串)。

> `turn` / `step` 取自 `assistant/chunk` 事件的 `params.event.data`(实测记录形如
> `{type:'assistant/chunk', seq, time, data:{turn, step, chunk:{…}}}`),取不到时回落事件顶层、
> 再回落 chunk,最后 0;`index` 是该内容块在本步内的序号(在 `chunk.index`,缺省 0)。
> `tool` 事件的 `turn` / `step` 同源(`event.data`)。这三者与 `say-end` 都只是**增量字段 /
> 新增事件**:既有事件名与语义一字未改,老渲染层忽略即可,不影响 `finalResponse`、`usage`
> 与其余事件链路。渲染层据此 + `turn/start`、`step/start`(走 `session-event` 透传)按步切段。

### 图像附件(`run.images`)

`run.images`(**本轮新增的图像附件**,可缺省)= 宿主给出的**本机图片绝对路径**数组。
网关按 `dsh-attachment-local` 的内容寻址布局把图写入
`<DSH_HOME>/attachments/v1/objects/<sha 前2位>/<sha256>`,并把本轮用户消息拼成
「文本块 + image 内容块」(`attachImages`;`sharp` 为可选依赖:探测不到的条目**跳过**,
绝不阻断任务)。**只发本轮新增的图**:图进的是本轮这条用户消息,此后它随会话历史一直在
上下文里(运行时重放历史时图一并带上),宿主每轮再发一遍 = 同一张图反复计费 —— 渲染层
因此只从**这一轮**的正文里取图(`renderer/app-db.js` 的 `dshRunImages` →
`renderer/app-inline-img.js` 的 `absImgPaths`;会话 / 开发节点正文框写的是
`![名称](绝对路径)` 图行),暂停后的续跑轮("继续")也不再下发。缺省 / 空数组 = 纯文本轮,
行为与接入前一字不变;宿主正文里的图行原样留在消息里,界面回看时按它显示缩略图 ——
下发与回看是两条互不依赖的路径(见 `renderer/app-assist.js` 的 `dshUserBodyHtml`)。

## 思考强度契约(gateway ↔ 运行时 ↔ 宿主)

> 参考 codex(`codex-rs/protocol/src/openai_models.rs` 的 ReasoningEffort / ModelPreset,
> `core/src/client.rs` 的 `reasoning_effort_for_request`)把 MTNode 的思考强度收敛成一套
> 「宽档位 + 按模型能力归一」:档位词汇、路由能力表与回退链的唯一真源是
> `dsh/gateway/reasoning-effort.mjs`(纯函数模块,gateway 与运行时插件共用,禁止 import
> dsh / pi-ai 运行时包)。本节锁契约,不锁实现;要改档位语义先改那个模块再改这里。

- **档位词汇(可选用档)**:`off / low / medium / high / xhigh / max`(对齐 pi-ai 能力集
  `@earendil-works/pi-ai` 的 `EXTENDED_THINKING_LEVELS` 的可选用子集)。`off` = 会话 / 助手
  「思考强度 · 无」= **关闭思考**(llm-deepseek 适配器的 `thinking.type=disabled`);它是
  「关档」不是预算档 —— 只在明确选了 `off` 时下发,不支持 `off` 的路由退回最近正档,绝不把
  `off` 当成最小档参与同侧回退。`minimal` 无消费方,不入选(proc_text 非智能节点另有自己的
  off/低/中/高 循环,不经网关)。openai 专有的 `ultra / persistent / service_tiers` 不在范围。
- **旧档兼容**:宿主传来的 `none / 无` 一律归一到 `off`(与用户点「无」同判);空串与非法值
  归一为 `high`(兜底默认,与历史行为一致);`effort` 参数缺省 = `high`。
- **路由能力表**:`deepseek-official`(llm-deepseek 适配器)能力 `off/low/high/max`,
  可选用交集 `off/low/high/max` —— `off` 原样下发(关思考),`medium`、`xhigh` 请求按
  「同侧最近低档」回退(`medium→low`,`xhigh→high`);目录/pi-ai 等其余路由按全档,模型级
  精确能力由运行时按 `ctx.llm` 解析后夹紧(见下)。归一化**永不硬失败**:不支持 → 最近低档
  → `high` 兜底。
- **按 run 下发(三条通道,同一个 `runEffort`)**:网关每轮 run 先定 `route`
  (`routeOfProvider`),经 `effortForRoute(effort, route)` 得生效档,然后
  ① settings.yaml 的 `llm-deepseek.reasoningEffort` **只写兜底默认 `high`**(档位切换
  不再写 settings、不再触发热重载与 450ms 等待);② `runtime key` 含档位(换档冷起
  新 runtime);③ spawn env 注入 `MTNODE_EFFORT`。
- **运行时插件(`mtnode-effort`,cordis.yml 行,跑在 dsh 运行时进程内)**:读
  `MTNODE_EFFORT`,在每个 agent 步骤的 `agent/request` waterfall 上把模型请求的
  `reasoningEffort` 提案成本档 —— 这是 llm-deepseek / llm-pi-ai 两条路由都吃得到的
  统一下发通道(SDK `RunOptions` 没有档位字段;settings 段只有 llm-deepseek 会读,
  所以 pi-ai 路由此前思考档完全不生效)。适配器在 `prepareCall` 按**精确模型能力**
  校验档位,不支持的值会 `UNSUPPORTED_REASONING_EFFORT` 硬失败,故插件先解析:
  `deepseek-official` 按固定能力 `off/low/high/max` 夹;其余路由经
  `ctx.llm.resolveModelInfo(provider, model)` 的 `reasoning.efforts`(即 pi-ai 的
  `getSupportedThinkingLevels`)夹到最近可支持档;解析失败或模型无 reasoning 能力
  → **不下发档位**,沿用适配器/提供方默认(绝不盲发)。env 缺席 = 插件 no-op,
  行为与接入前一字不变(降级保底)。
- **回传(回显=下发契约)**:真实轮起跑前发一次 `run` 事件 `effort`
  (`{requested, effort, route}`,见上事件列表),宿主按它回显「用户选的档 → 该路由实际
  生效的档」;`done` 载荷不带档位,以早到的 `effort` 事件为准。
- **辅助直连调用不受 run 档位影响(有意的取舍)**:压缩摘要等辅助 LLM 调用直接走
  `llm/stream`(不经 `agent/request` 扩展点),使用适配器默认档 —— settings.yaml 兜底
  的 `high`。旧实现把 run 档位写进 settings 作适配器默认,这些调用曾随档位走;现在
  档位只经 env 对 agent 主链路生效,辅助调用稳定在 `high`,换档也不再写 settings /
  触发 450ms 热重载等待。
- **断点续跑的签名**:宿主侧的续跑签名(配置指纹,含 effort 与网关 runtime key 同源成分,
  口径见下节「断点续跑契约」)含 effort 一项不变 —— 档位不同就整轮重发,`resumeSession`
  判据与签名规则见下节,本节不改动它们。

## 按运行裁剪可见工具集契约(gateway ↔ 运行时 ↔ 宿主)

> 每一次模型调用都随固定前缀重发**全部可见工具的定义**(优化前实测:tools 段 ≈ 98K 字符、
> 空会话首步 32K token,且**每一步**都付)。所以「这一轮根本不可能用的工具」应当整个不下发,
> 而不是留着让模型去撞 —— 撞一次是白烧一轮,留着是每步白烧 7K token。

**三条通道,一份规范名单**

| 通道 | run 参数 → env | 形状 | 生效点 |
| --- | --- | --- | --- |
| 精简工具负载 | `lean` → `MTNODE_LEAN_TOOLS` | 整档(布尔):`mtnode_app` / `mtnode_vision` | `canvas-plugin.mjs` 的 `register()` |
| 智能节点锁画布 | `noCanvas` → `MTNODE_NO_CANVAS` | 整档(布尔):画布主干三件 | 同上 |
| 按名字裁剪 | `hideTools` → `MTNODE_HIDE_TOOLS` | 名单(数组/逗号串):数据库、预设拒项、goal/子代理/后台任务档 | MTNode 自有 → 各自插件注册口;引擎自带 → `mtnode-tool-visibility` 插件 |

- **名单真源**:`dsh/gateway/tool-visibility.mjs`(纯模块、零依赖,网关进程与运行时进程共用)。
  `HIDEABLE_TOOLS` 是**唯一白名单**,`normalizeHiddenTools()` 负责丢未知名 + 去重 + 字典序排序;
  不在这份名单里的字符串一律丢弃 —— 宿主传来的东西不允许原样进 env,更不允许拿它去
  `restrict()` 一个没见过的名字。新增可裁工具只改这一处(渲染层的触发条件在
  `app-nodes.js` 的 `agentDeniedToolNames()`,两边由 `test/smoke-token-budget.js` 钉住一致)。
- **MTNode 自有工具**(画布 / 应用 / 识图 / 数据库)注册在我们自己的插件里,最省事的做法就是
  **不注册**:`canvas-plugin.mjs` 的 `register()` 与 `db-plugin.mjs` 的入口各查一次名单。
- **引擎自带工具**(`create_goal` / `todo_write` / `subagent` 家族 / `job_*` / `ask_user_question`)
  注册在 `@deepseek-ai` 的包里,改不到注册 —— 用官方口子
  [`ctx.tools.restrict({deny})`](gateway/plugins/tool-restrict-plugin.mjs)。它要求
  **agent 作用域**的 ctx(普通插件 ctx 调用直接抛),且只能裁「该作用域继承来的」工具
  (own-layer 注册不可裁 —— 那正是子代理回执 / 结构化输出机制存活的原因),所以挂在
  `agent/created` 上、在 `agent.ctx.effect(...)` 里装掩码,随该 agent 析构自动解除。
  装之前逐个用 `tools.get(name, agent)` + `view(agent).restrictableNames` 过一遍:
  `restrict()` 点未知名字会抛,可见但不可裁的名字必须筛掉。

**缓存纪律(比省字符更高优先级)**

可见集**只在 spawn 时定档**:名单进 `getRuntime` 的 runtime key(`hx:` 指纹,与既有
`lean:` / `nc:` 同级),换档 = 冷起一台属于自己的运行时。**绝不允许轮内改可见集** ——
`restrict` 掩码中途变化会让提示缓存从第一个变动的 schema 起整段失效,省几千字符却赔掉
整轮缓存。同档会话每一步前缀逐字一致,才是"裁剪"而不是"抖动"。
宿主侧同一口径的续跑签名(`renderer/app-db.js` 的 `dshRunSigOf`,含 `lean` / `noCanvas` /
`hide`)必须同步,否则会把"旧可见集的会话"当同配置点名续跑。

**下达说明与降级保底**

- 裁掉了工具 → 网关在预设文本后补一句点名(既有 `LEAN_TOOLS_NOTE`;名单通道补
  【本轮不注册的工具】),因为人设 / 技能里可能还写着它们。宿主侧的【Agent 工具许可】节
  本来就说"拒绝项对应的工具不可调用",不重复第三遍。
- env 缺席 / 名单为空 / 名字全非法 → 不注册监听、不裁任何工具,**行为与未接入本能力时
  一字不差**;老网关忽略未知 run 字段 = 全量注册。
- 裁剪链路上任何异常(`restrict` 抛、作用域不给裁)一律**放弃裁剪照常起轮**:省 token 的
  通道绝不允许把用户的任务跑挂。
- **刻意不裁的部分**:`fs_read` / `fs_write` / `shell` / `web` 四个许可项不翻译成名单 ——
  它们由 dsh 沙箱与审批档管辖,把 `read` 藏掉会让"读过的文件才能写"这类观察策略变成模型
  永远满足不了的条件,反而更费 token。`str_replace_editor` 与 read/edit/write 的重叠留待
  后续单独评估。

## 流式增量帧契约(gateway ↔ 运行时 ↔ 宿主) —— dsh 0.2 的 `assistant/chunk` 缺席

> **一句话**:宿主协议的 `reasoning` / `text` / `say-end` / `tool-preparing` 四类帧只有一个出口
> = `gateway.mjs` 的 `mapNotification` 里的 `assistant/chunk` 分支;而 dsh 0.2 的运行时**不再发这条
> 增量事件**,它把整段流式数据骑在完整的 `assistant/message` 上。不补这一层,会话里就永远看不到
> 模型思考、正文也不逐字出现(前两轮都在改渲染层,因此怎么改都不好)。

现场取证(2026-09-30,`node` 直连网关发真请求 + 扫本机会话日志):

- 连发 **60 个** `<DSH_HOME>/sessions/**/session.jsonl*`,`assistant/chunk` 出现 **0 次**;
  每个 step 只有一条 `assistant/message`(`{type:'assistant/message', data:{turn, step, message, usage, stream}}`)。
- 该消息里 `message.content` **有真思考**:实测 `[{type:'reasoning', text:"…544 字…"},{type:'text', text:"…"}]`;
  `data.stream` 是回放数据:`{type:'chunk', chunk:{type:'block-start'|'block-end'|'usage'|'finish', …}}`
  与 `{type:'reasoning-chunks'|'text-chunks', index, time0, texts:[…], dt:[…]}`(`texts` = 逐块文本,
  `dt[i]` = 该块相对前一块的毫秒间隔)。
- `tool` / `tool-result` 两类帧照常到达 —— 所以事故现场看起来是「工具卡正常、就是没有思考」。

落点(gateway 侧,`synthesizeChunksFromStream`):

- `assistant/message` 分支把 `stream` 还原成**与 `assistant/chunk` 分支完全同形**的帧;文本以
  `texts` 逐块原样相接(**不插空格**:插了就把字词拆开),`block-end(index ∈ 正文块)` → `say-end`,
  tool-call 增量 → `tool-preparing`(同一个 `toolPrepAcc` 限频器,与原生分支共用)。
- **不双发**:原生 `assistant/chunk` 分支登记 `(turn,step)`(`chunkSeen`),该步的
  `assistant/message` 整步跳过;函数自身也做同一判据(幂等)。老运行时(发 chunk 的)行为一个字不变。
- **用 `break` 不用 `return`**:`mapNotification` 末尾还要发「原始事件透传帧」
  (`emit('session-event', …)`),提前 return 会让 `assistant/chunk` 整帧到不了前端。
- **节奏 = 默认 instant**:实测 `assistant/message` 是生成完毕之后才到的(同一步里没有更早的同名
  事件),所以立刻连发就是「轮到就显示」,既不假装逐字、也不白等一轮生成时间。
  env `MTNODE_STREAM_REPLAY=paced` 改为按 `dt` 限幅重放(同步 `Atomics.wait` 保持帧序),
  `0|off|false|no` 整关(回到「只有完整消息」的老行为)。
- 失败面:合成任何异常只记一行 `diag`,一条帧都不发,不影响这一轮收尾。

回归:`test/smoke-gateway-stream-replay.js`(帧序列 / 元数据 / 不双发 / 开关 / 接线口径);
现场复核 = `test/_probe-trajectory-live.js` 同族的直连探针(改前 reasoning=0 帧 → 改后 reasoning/text 多帧)。

> **别再改回渲染层**:报「思考不显示」时,第一步是确认**帧有没有到**(探针数列),不是改折叠逻辑。
> 渲染层的 `dshMsgSegsViewable` / `agentLiveSegsEl` 只消费上面这四类帧。

### 同源第二坑:token 统计也只在 `assistant/chunk` 上取(2026-10-01 修)

同一份 0.2 事实的另一处后果:`handleRun` 的统计分支只在 `case 'assistant/chunk'` 里看
`c.type === 'usage'` 记账。0.2 既然不发这条增量事件,**一个 token 都统计不到** —— 现场表现 =
会话末尾的 Token 报告所有数字为 0(以及已下线的输入区圆环显示「上下文已用 0 / 1.0M tok」)。

- 0.2 的用量真源 = 完整 `assistant/message` 的 **`data.usage`**,形如
  `{inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalTokens}`
  (实测本机会话日志 `session-*.v4.jsonl.zstd`:21 行记录里 `assistant/chunk` 0 条、
  `assistant/message` 2 条且各带 `usage`)。
- 落点:`gateway.mjs` 抽出 `accountUsage(metrics, u, t)` 一处记账(token 累计 + 逐模型台账 +
  llmMs / TTFT / prefill / genMs + `emit('usage')`),`assistant/chunk` 的 `c.usage` 与
  `assistant/message` 的 `data.usage` 两个来源都调它。两者在 0.2 里互斥(原生 chunk 不再带 usage),
  同一次调用只记一次账;五个口径全 0 的 `usage`(老适配器 / 非计费路径)直接跳过,不凭空多一「次」。
- 已知缺口:0.2 没有原生增量帧,`stats.firstTokenMs`(首 token 延迟)没有采样点,
  `firstTokenAvgMs` / `ttftAvgMs` 在纯 0.2 运行时上恒为 0 —— 要恢复得靠 `request/header` 的
  时间与首块 `dt` 反推,本轮不做(不猜数)。
- 回归:真跑一轮看 `usage` 帧与 `done.metrics`(见下「现场复核」)。

## 历史思考回放裁剪契约(运行时插件 `mtnode-reasoning-replay-trim`)

> 省的是**发出去的请求**里的钱:思考模式下,上一步的思考原文会被适配器写回协议字段随历史
> 重发(llm-deepseek 的 `serializeAssistant` → `reasoning_content`;pi-ai 的
> `openai-completions` `convertMessages` → `assistantMsg[thinkingSignature]`,实测该签名就是
> `reasoning_content`)。实测单会话思考文本最高 309KB,重思考的步每步多带 10–15K token。
> 插件 `dsh/gateway/plugins/reasoning-replay-trim-plugin.mjs`,cordis.yml 固定挂载行
> `id: mtnode-reasoning-replay-trim`;只 import node 内置(零 import)。

- **注入点 = `llm/stream` 瀑布,而且只能这样注入**:cordis 的 `waterfall` 不做载荷替换 —— 它把
  同一个 args 数组 spread 给链上每个监听器(`dispatch` 后 `args=[options]`,
  `next = () => (cbs.shift() ?? inner)(...args)`),而最内层的默认处理器
  `() => this.adapterStream(options, prepared)` 闭包捕获的是**原始 options**;loop 造的请求又是
  `deepFreeze` 过的(`dsh-agent-loop` 不变式要求 `Object.isFrozen(options)`),改不动。所以想换
  请求内容,唯一办法是**不调 `next()`,自己带新对象重进一次 `ctx.llm.stream(copy)`**,并凭 WeakSet
  认出自己重建的那一次(第二遍必须直接 `next()` 放行,否则无限递归)。dsh 升级若把该瀑布改成真
  替换语义,这里随之简化,但**判据不变**:重进的副本不得再被第二次裁剪。
- **重进的副本刻意不打 agent-loop 标记**:`markAgentLoopRequest` 是进程内 WeakSet 按对象记的,
  新对象天然不是 loop-built,于是 `dsh-agent-loop` 的「请求必须等于耐久推导
  (`session.deriveMessages()`)」不变式把它当 hand-built 调用跳过;而该不变式仍会在**原始请求**上
  先跑一遍(它 `prepend: true` = 最外层,本插件默认注册 = 内侧),耐久推导照旧被校验,我们只在它
  内侧改发出去的字节。同理 `session-title` 的调度、`session-checkpoint-policy` 的 flush 都先在
  原始请求上完成(重进会再 flush 一次,幂等);`prepared` 一次性句柄随原链路作废,重进走
  `resolveCallFor` 再解析一次同一档配置(与 `mtnode-effort` 每步解析模型能力同量级)。
- **裁剪规则**:只动 `role:'assistant'` 的消息,且**保留最后一条 assistant 不动**(那一步的思考是
  正在续写的上半句,删了才是真掉能力;思考模式的工具调用轮次也要求回传 `reasoning_content`)。
  其余 assistant 消息里长度 ≥ 阈值的 `reasoning` 块换成一枚极短的 `type:'reasoning'` 占位块
  (`[earlier thinking elided]`)。
- **占位替换,绝不删块(硬契约)**:块数与块类型必须与 `source.replayState.blocks` 保持位置对齐 ——
  pi-ai 适配器 `replayedAssistant` 以 `blocks.length !== content.length`(或逐位类型不符)判失配,
  整条消息降级为 `foreignAssistant`,连带丢掉 `textSignature` / `thoughtSignature` 等保真元数据
  (靠加密推理详情回放的路由会因此报错)。占位块同为 `reasoning` 类型,对齐不破,且保证工具调用
  轮次的 `reasoning_content` 字段存在且非空(DeepSeek 思考模式要求它;pi-ai 侧
  `compat.requiresReasoningContentOnAssistantMessages` 对 DeepSeek 自动补空串,两条路都不受影响)。
  **要把这里改成删块,先重读这条。**
- **只在请求侧**:裁的是这一次 `llm/stream` 的 options 副本 —— 会话日志
  (`<DSH_HOME>/sessions/**/session.jsonl*`)、UI 回显(`reasoning` 事件流)、
  `deriveMessages` 的耐久推导与续跑签名**一概不变**,历史仍按原文存盘与显示。副作用是实际 prompt
  token 低于压缩器按耐久历史做的估计,压缩因此略晚触发(省下的正是这笔)。
- **开关与降级保底**:gateway 在 spawn 时注入 env `MTNODE_TRIM_REASONING`,值 = 生效的最小思考字数
  (`Number.isInteger` 且 ≥1);`1/on/true/yes` = 用默认阈值 200 字。**env 缺席 / 空 /
  `0|off|false|no` / 非整数 / <1 → 插件不注册任何监听器**,行为与未接入时一字不变;裁剪或重进过程中
  任何异常一律回落 `next()`(原始请求照发),诊断写不出去也静默 —— 任何情况下不得让一次模型调用因
  「省 token 失败」而失败。每 session 首裁向运行时 stderr 打一行
  `[rr-trim] session=… turns=… elided=…chars`(去重集合有界,只作定位)。**该 env 目前由宿主/网关侧
  决定是否注入**(见「运行时托管」的 env 注入清单):不注入 = 本能力整体休眠,挂载本身零副作用。

## 断点续跑契约(gateway ↔ 宿主)

> 一轮 run 崩在中途(API 报错、网关被杀、宿主重启)后,宿主可以**接着那一轮的会话**再跑一次,
> 而不是把上下文全丢重来。本节锁四件事:怎么点名(`run.resumeSession`)、点名后沿哪条路径
> 续上(**三态**:同进程复用 → 跨进程盘上恢复 → 整轮重发兜底)、怎么知道点的是谁
> (`session` 事件 / `done.sessionId`)、以及宿主侧什么才算「点得动」的签名前提。

### 新 run 参数字段:`resumeSession`

- `resumeSession` = 上一轮(失败轮)的 **dsh session id**(形如 `session-<uuid去横线>`),缺省 = 空 =
  照旧每轮新铸一个 session,行为与接入前一字不变(降级保底)。
- 网关在 `handleRun` 铸 `runSession` 处判**第一道闸**:有 `resumeSession` 且该会话的日志
  **在盘上** → 沿用它(显式经 `RunOptions.sessionId` 下发,运行时把这一轮追加到旧会话上);
  否则照旧新铸。盘上判据**必须由网关侧**做纯文件系统检查(`resumeSessionExists`,只读、不建目录、
  不起 runtime、不打网络):`<DSH_HOME>/sessions/<projectKey(workspace 路径)>/<sessionId>/` 下
  存在 `session.jsonl` 或 `session.jsonl.zstd`(运行时 `dsh-session-persistence-jsonl` 的落盘布局,
  压缩档为默认 zstd)。中间那层 project 目录名由运行时按 workspace 推导、宿主未必拿得准,
  所以**按 sid 扫 `sessions` 的一层 project 子目录**,任一命中即「本机存过这个会话」
  (session id 全局唯一,不会串到别的 workspace)。`.` / `..` 一律判不可续跑
  (`normSessionId` 的净化保留点号,故由 `resumeSessionExists` 显式排除)。
- **文件在盘只是第一道闸(必要不充分)**:文件在 ≠ 续得上 —— 续跑轮实际走哪条路径,取决于
  「持有该会话 live 句柄的 runtime 进程在不在」与「运行时能否把它从盘上恢复」。完整判定链见
  下节「续跑的三态」。网关绝不让「点名续不上」静默发生:运行时对未知 id 的语义是
  **新建空会话**,若带着假 session 起轮,模型只看到一句「继续」而没有任何上文 —— 静默跑偏
  比失败更难查,故接不上时必须显式收场(下节状态 C),不能"传下去让运行时自己看"。

### 续跑的三态:同进程复用 → 跨进程盘上恢复 → 整轮重发兜底

点名续跑后,按「这台 runtime 还在不在、能不能把旧日志拉回 live」分三态。网关对宿主的对外
语义只有两个出口:**真续跑**(沿用旧 session 追加)或 **RESUME_UNAVAILABLE**(退回整轮重发):

- **状态 A · 同进程续跑(进程内复用 · 真续)**:续跑轮点名时,SDK JSON-RPC server 的
  `getOrCreateSession` 在这台 runtime 的 live 会话表(`server.sessions`)里**进程内命中** → 直接
  沿 live agent/session 追加这一轮,零恢复成本。这是最轻的路径,也是重发窗口的默认期望。
  为让它在「429 后 ~5s 重发」里尽量命中,网关对**失败轮 runtime** 打「**续跑候选**」保活标记
  (`gateway.mjs markResumeCandidate` / `resumeCandidates` 表,时限
  `RESUME_CANDIDATE_TTL_MS = 60s`,覆盖宿主 5s/5s 的整条重发链):候选 runtime **豁免 LRU 淘汰
  与 `closeRuntimeByKey`**,留在池里等宿主点名;时限到、或被新一轮正常占用
  (`claimRuntime` 登记新 reqId)、或用户显式取消(`cancelRuntime` / `closeAllRuntimes`
  关进程前先摘标记)即清除,不泄漏。打标判据 `isRetryableGatewayFailure` 只认
  429/限流/5xx/网络/传输类 —— 取消、配置类、会话不可续跑等宿主不会重发的错误一律不标。
- **状态 B · 跨进程盘上恢复(跨进程真续 · session/resume 桥)**:失败轮那台 runtime 已不在
  (LRU 换出 / 引擎重启 / 网关被杀后拉起 / 换档冷起),点名续跑落在**另一台或新 runtime** 上。
  宿主续跑轮在 `handleRun` 起真实轮之前,先经 SDK client 公开面 `harness.client.request` 发一枚
  新 JSON-RPC 方法 **`session/resume`**(运行时插件 `dsh/gateway/plugins/session-resume-server.mjs`,
  幂等装在 `HarnessSdkJsonRpcServer` 原型上,只扩 handleRequest 一处):会话已在本进程 live →
  回 `{resumed:false}` 零开销(状态 A 已覆盖);不在 live 但盘上有日志 → 用 `ctx.agents.resume`
  (agent-loop resume 语义:`persistence.prepare` 整读旧日志、含 torn-tail 崩溃修复 → 恢复为
  live 并登记进 server 的 `sessions` 表),随后的 `session/prompt` 命中同进程 live 会话 →
  **真续跑**,事件沿 server 既有 `session/event` 订阅自然回流,网关通知路径零改动。归属与清理
  沿既有机制:恢复句柄与 create 出的会话同权(进同一 `sessions` 表,shutdown 统一 dispose),
  权威 id 仍由 `session` 事件记账,无泄漏。守卫:恢复出的会话若属别的 workspace
  (header.cwd ≠ 本进程 cwd,win32 大小写不敏感)或已在 live 而 server 表没有 → 拒绝,防
  跨 workspace 归属错乱与重复注册。握手预算 `RESUME_HANDSHAKE_TIMEOUT_MS = 30s`(跨进程恢复要
  整读数 MB zstd 日志,给足);**unknown method / 超时 / runtime 将死** = 跳过握手走原 create
  语义,与接入前行为一字不变,绝不误报。
- **状态 C · RESUME_UNAVAILABLE(整轮重发兜底)**:续不上时的唯一收场。**盘上无日志**
  (下第 1 条)时本轮**根本不开始**:网关对续跑轮只发两条事件后收轮,`reqId` 照常收尾
  (不占 runtime、不消耗 token);握手 / 运行期才暴露的接不上(下第 2 / 3 条,已占 runtime)
  同样按下方两条事件收场,宿主不区分:
  ```
  {event:{type:'error', data:{message:'RESUME_UNAVAILABLE: 会话 … 在本机不可续跑（…），请改为整轮重发'}}}
  {event:{type:'done',  data:{finalResponse:'', resumeUnavailable:true}}}
  ```
  触发情形按顺序:
  1. **盘上无日志**(第一道闸不过):会话文件被设置面板清理 / id 非法 / 属别的机器;
  2. **握手/恢复被运行时明确拒绝**:日志损坏、格式版本不符、cwd 不符、已在 live 防重
     (见 `handleRun` 的 `session/resume` catch 分支,未命中 collision 正则也按此收场);
  3. **老运行时回落 create 语义撞 persistence**:运行时没有 `session/resume`(接入前版本)且
     进程已不在 → 新 runtime 以「新会话 + 只有续跑指令的 seed」去碰盘上旧日志,
     `dsh-session-persistence` 在 session/created 时判前缀不符,抛 `(id collision)` 硬错误
     (`… already has a persisted log on disk that does not match this live session (id collision)` 等)。
     网关对**续跑轮**捕获到这类报文时,把它转译成同款 `RESUME_UNAVAILABLE: …` 收场
     (`done.resumeUnavailable:true`),不原样透传 —— 否则宿主会把同一个 dead id 连撞 5 次
     重发预算,用户只见莫名报错而不会自动整轮重发。识别口径在
     `gateway.mjs resumeCollisionMessage`(与 `renderer/app-db.js dshResumeCollision`
     同一正则族,老网关原样透传时由宿主兜底识别),新增 runtime 冲突文案需同步两处。
  **collision 因此只在「真正不可恢复」时出现**:接入 resume 桥后,状态 A / B 已把「进程不在」
  的大部分情形变成真续跑,persistence 的 id collision 只剩第 3 条兜底路径才可能冒头;
  它对宿主始终是 RESUME_UNAVAILABLE 语义,宿主无需区分是哪种。
  **宿主侧识别口径是 `error.message` 的固定前缀 `RESUME_UNAVAILABLE: `**(标记字符串是契约,
  改它要同改宿主)。宿主据此**退回整轮重发**(丢掉 `resumeSession` 重新铸一轮),而不是把
  "续跑失败"当普通错误显示给用户。

### 事件 `session`(网关 → 宿主:本轮权威 session id)

- `{reqId, type:'session', data:{sessionId, resumed}}`。`resumed:true` = 本轮沿用宿主点名的旧会话
  (状态 A 进程内复用与状态 B 跨进程恢复都发 `resumed:true`);`false` = 本轮网关新铸。
- 发射时机有两处,**语义同一个**:`getRuntime` 占用成功后立刻发一次(此时 `sessionId` 就是
  网关铸/沿用的 `runSession`,宿主不必等到 `done` 才拿到续跑用的 id —— 崩溃恰恰多发在起机与
  首帧之间);随后首条 `session.event` 若**改判了权威 id**(运行时自行另铸 / 版本漂移,见
  「交互桥的归属契约」的 `rebindRunSession`)再发一次,以事件里的 id 为准。
- 宿主**只以最后收到的一条为权威**,并随该轮存档(`sessionId` + 该轮的 preset/effort/model/workspace 签名)。
- `done` 载荷同样带 `sessionId`(成功与失败/终止两条路径都带),宿主不监听 `session` 事件也能工作,
  只是拿不到"崩在半路"的那一轮的 id —— 那正是最需要续跑的时刻。

### 宿主侧的硬前提:续跑必须带签名校验

- `resume` 不只是"接着写":运行时恢复会话时会沿用**会话持久化字段**(预设 `agentPreset` 即其一,
  另有 effort / model / workspace 等)。这些与失败轮不一致时,恢复出来的是**改了档位的同一会话**,
  表现为"档位没生效""工具许可变了"这类难查现象。
- 因此**只有当失败轮与本轮的配置指纹完全一致**时,宿主才允许带
  `resumeSession`;任一不同就整轮重发(新 session)。签名由宿主自持(网关不参与比对),网关只保证
  「点名的会话在不在盘上 + 续跑轮先握手恢复」这一条判据。
- **签名必须覆盖网关 runtime key 的全部成分**(不只是 preset / effort / model / workspace):
  网关 `getRuntime` 的 runtime key 与 provHash 由下表成分拼成,任一漂移网关都会**另起一台新
  runtime**——此时若宿主签名还判「一致」而点名续跑旧会话,即便跨进程恢复成功,恢复出来的也是
  **旧配置的上下文**,与本轮不符(撞上文状态 C / 或「档位没生效」类难查现象),等价于
  "假装续上,实则换配置冷起"。宿主签名口径在 `renderer/app-db.js dshRunSigOf`
  (基础七项 + runtimeKey 同源成分,漂移即判整轮重发);新增/改名 runtime key 成分需同步
  该函数与下表:

| runtime key 成分 | 网关取值来源 | 宿主签名输入(`dshRunSigOf`) | 漂移后果 |
|---|---|---|---|
| workspace | 宿主 run 参数 | `workspace` | 换工作区 → 换 runtime → 续不上 → 整轮重发 |
| model | 宿主 run 参数 | `model` | 同上 |
| maxTokens | 宿主 run 参数 | `maxTokens` | 同上 |
| provider(route) | 宿主 run 参数 | `provider` | 同上 |
| preset | 宿主 run 参数(会话持久化字段之一) | `preset` | 同上 |
| effort | 宿主 run 参数(思考档) | `effort` | 同上(档位不同即整轮重发,见「思考强度」节) |
| pure | 纯净模式标记 | `pure` | 纯净 / 非纯净不共用进程 |
| apiKey(secret) | provider 配置(密钥) | `apiKey` | 换密钥 = 换配置冷起伪续跑 |
| baseUrl | provider 配置(端点) | `baseUrl` | 换端点 = 换配置冷起伪续跑 |
| webSearchKey(provHash `ws:`) | 联网搜索配置 | `webSearchKey` | 同上 |
| persona(provHash `hp:`) | 宿主 run 的 hostPersona | `persona` | 同上 |
| tools(provHash `tl:`) | 工具描述子 JSON | `tools` | 工具集漂移 = 换 runtime 冷起伪续跑 |
| envPatch(provHash 密钥表) | 服务商密钥表 | `envPatch` | 同上 |

- 会话文件的淘汰属宿主的磁盘清理策略(设置面板的 `dsh-home/sessions` 清理),契约不承诺存在时长:
  删过就是 `RESUME_UNAVAILABLE`(状态 C 第 1 条),宿主退回整轮重发即可,不需要额外状态。

## 运行中插话与暂停契约(运行时 ↔ gateway ↔ 宿主)

> 一条提示**已经跑起来之后**，用户还想做两件事：① 追加一句即时纠偏（不想等本轮跑完，也不想
> 重开一轮）；② 让这一轮停在当前这一步，但**不丢**上下文和已排队的后续消息，之后还能接着跑。
> 这就是「插话（steer）」与「暂停（pause）」。两枚运行时原语本来就齐（`@deepseek-ai/dsh-agent`
> 的 `Agent` 接口：`steer(message)` / `cancel(cause, { keepInbox })`），缺的只是从运行时到界面
> 的这条接线。**本节锁三层职责、暂停的收尾语义、以及 unknown-method 降级** —— 与「断点续跑契约」
> 同一套路子（可选 JSON-RPC 方法 + 原型级补丁 + 缺能力即回退，绝不让新功能把老环境打崩）。

### 三层职责（谁只干什么）

| 层 | 落点 | 只负责 | 明确不负责 |
|---|---|---|---|
| 运行时（cordis 进程内） | `dsh/gateway/plugins/session-steer-server.mjs`（插件 id `mtnode-session-steer`，挂在 `mtnode-session-resume` 行之后、`# ── user plugins ──` 段之前） | 把 `session/steer` / `session/pause` 两枚**可选** JSON-RPC 方法装到上游 `HarnessSdkJsonRpcServer.prototype.handleRequest` 上：按 `sessionId` 取这台 runtime 的 live agent → `agent.steer(createUserMessage(...))` / `agent.cancel({kind:'user'},{keepInbox:true})` | 不寻址「哪一轮在哪台进程」（网关的事）；不从盘上恢复会话（插话 / 暂停只对正在跑的轮次有意义）；不决定降级成排队还是终止 |
| 网关 | `dsh/gateway/gateway.mjs`：在途表 `inFlightRuns` / 暂停戳 `pausedRuns` / stdio `case 'steer'`\|`case 'pause'` → `handleInflightRequest` | 把宿主点名（`reqId` 或 `cancelTag`〔+ `sessionId` 收窄〕）解析成**那一轮那台** runtime 的 `client`，同步下发（`INFLIGHT_REQUEST_TIMEOUT_MS = 10s`）；把「送不出去」一律折算成 `{ok:false, reason:'unsupported'}`；并保证**暂停的这一轮只以 `done{paused:true}` 收尾，绝不发 `error`** | 不判断「该不该插话」（宿主只在确实有一轮在跑时才发）；不改 `session/prompt` 的 followup 语义（不插话时行为与接入前一字不变） |
| 宿主（渲染层） | `dsh/main-dsh.js` 的 `steer/pause` + `preload.js` 的 `dshSteer/dshPause` + `renderer/app-assist.js`（`agentSteerNow` / `agentPauseNow` / `agentResumePaused`），暂停语义由 `renderer/app-db.js` 的 `dshRunOnce` 认 `done.paused` | 决定按哪枚键、失败怎么兜底（**一律回落既有的「发送队列」**）、把插话落成一条 `_kind:'steer'` 气泡并按注入帧升级为「已注入本轮」、暂停期间压住 outbox 排水、点「继续」走 `run.resumeSession` 续跑通道 | 不自己编 `reqId`（渲染层拿不到，一律用 `cancelTag = "agent:"+会话 id` 点名自己那一轮）；不改「■ 终止」的关 runtime 语义；不改 429 自动重发闸的判据 |

- **在途表的建与清**：`claimRuntime` 占用成功即登记（此刻就有 `runKey` / `cancelTag` / 网关铸造的
  `runSession`），`handleRun` 两处 `emit('session')`（起轮前 + 首条 `session.event` 改判权威 id 后）
  刷新 `sessionId`，`handleRun` 的 `finally` 调 `clearInFlightRun(reqId)` 与 `keyToReqId` 同进同退。
  整表上限 `INFLIGHT_RUNS_MAX = 256`，超出丢最早登记的（防泄漏）。收尾之后 `steer/pause` 找不到
  这一轮 → `unsupported`，宿主自己回落排队 —— 这是**常态而不是错误**（那一轮确实已经跑完了）。
- **插话消息与普通用户消息同形**：运行时侧用 `@deepseek-ai/dsh-llm` 的
  `createUserMessage({content:[{type:'text',text}], source:{kind:'user'}})`（与上游 `server.prompt`
  同源），所以插话在会话日志与宿主投影里不需要任何特殊分支。
- **注入回执不新增事件名**：运行时把插话拼进收件箱时吐 `agent/inbox/spliced`，网关 `mapNotification`
  的 default 分支原样透传成 `session-event`；宿主按 `data.inserted` 里的文本认回那句插话，把气泡
  从「已插话 · 将在下一步生效」升级为「已注入本轮」。这类帧**不参与** token / jobs 记账（token 只在
  `usage` 增量块累计，jobs 只数 `job/*started`；插话自身的用量在它所属调用的 `usage` 里正常出现）。

### 暂停的收尾语义（最容易做错的一条）

`pause` 落地后，运行时会把当前这一轮以 **aborted** 收流 —— 这在网关看来长得和失败一模一样。
宿主的失败自动重发闸（见「断点续跑契约」与 `renderer/app-db.js` 的重发链）**只看 `error` 事件**，
所以一次暂停若漏出 `error`，就会被当成 429 类失败**连着重发 5 轮**（用户按了暂停，模型反而又跑 5 次）。
网关的保证与实现口径：

1. **先盖戳再下发**：`pausedRuns.set(reqId)` 在 `client.request('session/pause')` 之前 —— 运行时往往
   在同一拍里就把这一轮 abort 收尾，等 `await` 回来再标记会漏判。任何一条**明确送不出去**的路径
   （没有在途轮 / runtime 不在池 / 参数不合法 / 运行时拒收）都把戳摘回去，否则那一轮的真实失败会被
   `handleRun` 误吞成「暂停完成」而丢了报错。
2. **超时例外（宁少报错，不丢语义）**：10s 没回音时请求很可能已经落进运行时，摘掉戳会让随后的
   aborted 被报成 `error` → 连重发 5 次；所以超时**保留**标记（回执照样 `unsupported`）。
3. **两条收尾路径都只发 `done{paused:true}`**：`harness.run` 正常收流 → `emit('done', {…, paused:true})`；
   抛错（运行时顺手把会话关了 → `TransportClosed` / 「已请求终止」一类）→ `catch` 里在**僵尸清理之后、
   collision 转译之前**判 `runPaused()`，同样只发 `done{paused:true, finalResponse:''}`。并且 `emit`
   包装器对已暂停的轮次**吞掉 `error`**（留一行 `pause-swallow-error` 诊断），透给宿主就是没有 error。
4. **宿主的对应动作**：`dshRunOnce` 认 `data.paused` → 按现状定稿返回，并**保留**该轮登记的可续跑
   会话（`finish(ok, val, keepRunSession)` 第三参）—— 暂停不是跑完，点「继续」正是按那个 sid
   `run.resumeSession` 从中断处接下去。「继续」的指令文案与出错续跑共用
   `dshResumeInstruction()`（`dshPausedResumeDirective` 只多一句「被用户手动暂停」的说明），
   两条路径不分叉；界面语言不影响发给模型的指令（见 AGENTS.md「提示词单一真源」）。
5. **暂停期间绝不自动排水**：会话的 `st.outbox`（发送队列）在 `st.paused` 为真时一律不发 —— 用户按停
   就是「停在这里」，自动排水等于把暂停变成继续。左下角运行队列把暂停列为独立可见态（`state:'paused'`），
   行内键是「▶ 继续」而不是「■」。

### unknown-method 降级（新功能不得把老环境打崩）

- **两枚方法都是可选的**：插件不调用时行为与接入前一字不变；老运行时没有 `session/steer` /
  `session/pause` = 上游 `handleRequest` 回 unknown method，网关折算成 `{ok:false, reason:'unsupported'}`。
  老网关连 `steer` / `pause` 这两枚 stdio 方法都没有 = 错误从 `main.js` 的 catch 成形，落在 `error` 字段。
- **运行时侧一律不抛**：参数缺失回 `{ok:false, reason:'invalid_params'}`，会话不在 live 回
  `{ok:false, reason:'no_live_agent'}`，`agent.cancel` 内部异常也吞掉回 `ok:false` —— 抛错会经 JSON-RPC
  变成 error 响应，把用户**正在跑的那一轮**判成失败并整轮重发；插话失败本该只是「没插进去」。
- **`ok:false` 不算送达**：网关把运行时明确的 `{ok:false}` 也折算成 `unsupported`（`detail` 记
  `runtime refused: …`）。按成功回报的话，宿主以为那句话已进本轮 —— 它既没进模型也没进队列，
  等于**静默丢字**。
- **宿主的降级必须可解释**（不是"点了没反应"）：
  · 桥（`window.api.dshSteer` / `dshPause`）压根没有 → 键**整枚不显示**；
  · 引擎回 unknown method（老网关 / 老运行时）→ 键**还在但置灰**（`.is-unsupported` 类而不是
    `disabled`：disabled 的按钮在 Chromium 不派发鼠标事件、原生 `title` 也弹不出来），按下去
    直接走发送队列并说明一次；
  · 其它失败（这一轮刚好跑完 / runtime 已回收 / 超时）→ 只是「这枪没赶上」，什么都不记，
    下一轮照样能插话。**「引擎没这枚能力」与「这枪没赶上」必须分开判**（`agentCapabilityMissing`
    只认 unknown-method 文案），否则一次运气不好就把键永久焊死。
- 幂等与安全：`steer` 可安全重发（最多让模型多看一眼同一句话），主进程那一跳超时回
  `{ok:false, reason:'timeout', retryable:true}`；`pause` 按 `reqId` 记账幂等（同一条在途轮再点回
  `{ok:true, paused:true, idempotent:true}`，超时回 `{…, pending:true}`），记账随该轮 `done` 事件与
  网关退出清空。

### 与「■ 终止」的分界（三条路，别混）

| 动作 | 运行时原语 | 那一轮的结局 | live 会话 | 已排队消息 | 之后 |
|---|---|---|---|---|---|
| ⚡ 插话 | `agent.steer(msg)`（`InboxTarget='next-step'`） | **继续跑**，下一步读到这句 | 保留 | 不动 | 无需任何操作 |
| ⏸ 暂停 | `agent.cancel({kind:'user'},{keepInbox:true})` | 停在当前这一步，`done{paused:true}` | **保留**（进程不死） | **保留**（不排水） | 「▶ 继续」= `run.resumeSession` 续跑 |
| ■ 终止 | `cancelRuntime` → `closeRuntimeByKey` | 整轮作废（`error`/aborted 语义照旧） | 关掉 | 按既有口径处理 | 下一轮是全新会话或按既有重发链 |

`keepInbox` 是「暂停」与「终止」的唯一分界：丢了它，暂停就退化成终止（已排队消息与 steering 条目
一并作废）。回归口径由 `test/smoke-session-steer-pause.js` 钉住（三层各自真跑 / 真抽函数跑）。

## 节点升级与新增(renderer)

| 节点 | 接入方式 | 降级 |
|---|---|---|
| `chat` 对话 | 新增「智能助手」开关:开启后走 dsh 会话(历史由节点自持),有记忆、会动手、流式思考;工作目录用文件夹窗口选择 | 开关关闭 = 原 API 路径,一字不改 |
| `proc_text` 文本处理 | 新增「agent 模式」开关:提示词成为任务,可读文件/联网,输出回填 output 槽;批量 = 每条一次 run(全部并行) | 关闭 = 原 buildSpec/apiCall 路径 |
| `agent_task`(新) | 通用 agent 节点:与 proc_text 功能对齐(@引用 / 多输入 / 批量 / 聚合 / 模型选择 / 输出浏览 / 停止),无「多次尝试」;服务商固定 DeepSeek 路由 | dsh 不可用时节点报错置灰,不落盘脏数据 |
| `wait_file` 需求等待 | 监视路径,文件就绪后放行;无输入、不输出内容 | 仅控制线 |
| `timer` 定时触发器 | 一次计划 / 间隔(天时分) / Cron(本地时间);Cron 旁可「智能填写」;武装后到点启用输出端目标;也可接在控制流中等待下一次触发点 | 无输入端子 |
| `delayer` 延时器 | 控制脉冲到达后等待指定时长(天/时/分)再继续;也可 ▶ 立即延时并启用目标 | 有输入 |
| `sequencer` 序列器 | 多路输出(2–8);按序逐路点燃,可设步间间隔;也可 ▶ 试跑 | 有输入 |
| `gate` 闸门 | 多路输入 AND:按配置路数(2–8)每一口都到达后放行一次并清零;未接线口也挡住放行;▶ 强制放行 | 有输入(2–8) |
| `splitter` 分发 | 一路入同时点亮多路出(并行扇出) | 有输入 |
| `counter` 计数 | 每 N 次控制脉冲放行一次 | 有输入 |
| `mutex` 互斥 | 多入选一(OR);任一输入到达即放行;▶ 按先到/端口优先/随机标记 | 有输入(2–8) |
| `judge` 判断 | 用文本模型对照任务目标裁决 YES/NO,两个输出端子(fromIndex 0=是, 1=否) | 无 Key 时任务进入需干涉 |

### 控制流节点方案(全集)

| 类别 | 节点 | 状态 | 作用 |
|---|---|---|---|
| 边界 | 起点 / 成功终点 / 失败终点 | 已有 | 任务控制流入口与终态 |
| 批控 | 执行 / 清空 | 已有 | 对已连接目标批量 ▶ 或清空 |
| 等待 | 需求等待 `wait_file` | 已有 | 监视文件就绪后放行 |
| 时间 | 定时触发器 `timer` | 已有 | 计划/间隔/Cron 主动触发 |
| 时间 | 延时器 `delayer` | 已有 | 脉冲到达后延迟再继续(单次) |
| 分支 | 判断 `judge` | 已有 | YES/NO 双路径 |
| 编排 | 序列器 `sequencer` | 已有 | 按序扇出多路 |
| 编排 | 闸门 `gate` | **已实现** | 多路控制入全部到达才放行(AND) |
| 编排 | 分发 `splitter` | **已实现** | 一路入同时点亮多路出(并行扇出) |
| 编排 | 计数 `counter` | **已实现** | 每经过 N 次放行一次 |
| 编排 | 互斥 `mutex` | **已实现** | 多入选一路(先到/优先/随机) |

控制类节点画布上统一金色外圈(`.is-ctrl`),内部底色与标题色按种类区分。

所有 dsh 工作目录输入框都提供「浏览」按钮(系统文件夹窗口),同时保留手填。

**新增 kind 必改点**(测绘自 app.js):`NODE_DEFAULTS`、右键菜单组、`buildBody` +
节点头部按钮、`statusOf`、`fillPreviews`、`clearDownstream`、`migrateWf`、帮助文档。
`agent_task` 复用 proc_text 的完整执行机器(`buildSpec`/`buildSpecAgg`/`playNode`/
`runOnce`/`runAttempt`/`ensureProcessed`),任务文本经 `procPromptOf` 读写。

## 配置扩展(config.json)

```jsonc
"dsh": {
  "enabled": true,                 // 总开关;关掉 = 全产品退回原行为
  "model": "deepseek-flash",    // agent 功能默认模型
  "maxTokens": 49152,
  "defaultWorkspace": "",          // agent 节点默认工作目录(文件夹窗口选择)
  "preset": "minimal",             // agent 预设(默认档 = minimal): minimal/standard/lean/code/cordis
  "chatEnter": "send",             // 对话发送行为: send(Enter 发送) / newline(Ctrl+Enter 发送)
  "permissionPreset": "mtnode-unattended", // 权限预设: mtnode-unattended/workspace-write/read-only/danger-full-access
  "agentToolPresetId": "default",          // 当前 Agent 工具许可预设 id
  "agentToolPresets": [                    // 工具许可预设列表；default 为内置「当前能力全开」
    { "id": "default", "name": "默认（当前能力）", "builtin": true, "allow": { "canvas_read": true, "canvas_nodes": true, "canvas_control": true, "canvas_draw": true, "canvas_layout": true, "app_ops": true, "app_delete": true, "fs_read": true, "fs_write": true, "shell": true, "web": true, "subagent": true, "ask_user": true, "vision": true } }
  ],
  "doneSound": true,               // 完成音效总开关(一把音色,两档音量):① 任何一件任务跑完 → 短促「叮咚」(E5→A5,0.42s) ② 所有任务都完成(运行队列彻底为空) → 同一把音色按 1.5 倍音量再响一声(滑杆拉满时夹安全上限);没有时长门槛。长任务音效(三音上行 / 随包 all-done.wav)与提醒音主进程通道已移除,提示音只走渲染层 WebAudio
  "doneSoundVolume": 35,           // 完成音音量百分比(0~100,两档共用;收尾那一档再乘 1.5;自定义音频文件按文件自身响度分 0.5/0.75 两档)
  "theme": "industrial"            // 主题色(10 款,见 app.js THEMES)
}
```

设置面板还承载(迁移自 dsh Web 设置):引擎状态检查、插件完整清单
(用户插件可安装/启停/移除,内置插件只读列出)、技能与 MCP 管理、存档位置与
说明入口(从顶栏移入设置)。

服务商映射:仅 `type === "text_openai"` 且 baseUrl 主机含 `deepseek` 的提供方启用
agent 能力(映射为 `deepseek-official` 路由);其余提供方在 UI 上明确标注「仅支持
原模式」。这是显式的产品边界,不是缺陷。

## 画布 Tab 条

顶栏第二行(logo 副标题行)承载版本号与画布操作提示;原提示行(fn-toolbar)变为
Edge 风格的画布 Tab 条:切换过的工作流显示为标签页(最多 12 个,关闭标签仅移出
条、不删工作流),「＋」新建画布。已访问清单持久化于 `config.visitedWorkflows`,
替换原顶栏工作流下拉。

## 插件扩展(需求 3)

- 插件 = npm 包名 / GitHub 地址 / 本地路径 + cordis.yml 追加行。设置面板提供安装入口；
  已装清单在近全屏对话框中管理（左 grid / 右描述与用途，英文描述会补中文，缺用途会补全）。
  非核心插件(用户安装、bundled 套装、可选 shipped 行)可 **挂载 / 取消挂载**,
  核心运行时行只读。内置插件留在应用包（升级后仍可挂载，开关写入
  `$DSH_HOME/cordis-mount.json`）；用户插件安装到 `$DSH_HOME/plugins`，清单在
  `cordis-user.yml`。启动时以应用包组合为底合并配置目录用户段。全局助手可通过
  `mtnode_app` 的 `list_dsh_plugins` / `install_dsh_plugin` / `remove_dsh_plugin` /
  `set_dsh_plugin` 管理（安装/移除/挂载需确认）。
- 已内置 [dsh-router-standard](https://github.com/yjh051108/dsh-router-standard)
  (`./plugins/router-standard/router-bootstrap.mjs`):**默认不加载**(组合行静态
  `disabled: true`),assemble 永不抛错,保留 MTNode persona 与 `mtnode_*` 工具;
  设置里可挂载/取消挂载,也可完整卸载(移除组合行 + 插件目录)。
  注入器与 router-spec 不随应用分发。见 `dsh/gateway/plugins/README.md`。
- 高级用户可直接编辑 cordis.yml(只读展示 + 复制路径)。
- 插件声明自己不保证 rc 版本兼容;安装失败回滚 package.json 与 cordis.yml。

### 内置画布插件(mtnode-canvas)

运行时组合固定挂载 `dsh/gateway/canvas-plugin.mjs`,向模型暴露三个工具:

| 工具 | 作用 |
|---|---|
| `mtnode_canvas_get` | 读取当前工作流:节点(id/kind/标题/坐标/提示词摘要)、连线、组、相机、视图、全部工作流列表 |
| `mtnode_canvas_edit` | 批量创建/改标题与字段/连线/@引用补全/成组/删除;默认分层从左到右排版且不与已有节点重叠 |
| `mtnode_app` | 应用级操作:工作流状态/列表、重命名/删除工作流、选中节点、撤销重做、DSH 插件列出/安装/移除/挂载。删除画布与装卸插件在全局助手侧需用户确认 |
| `mtnode_vision` | 识图子代理:对本地绝对路径图片调用视觉模型作答;首次需用户许可(允许一次/始终允许/拒绝) |

渲染层 `applyCanvasOp` 是唯一写画布的地方:校验节点类型与回路、拒绝删除正在运行的节点、一次编辑一条撤销记录。画布**智能节点**运行时硬拒绝 `get` / `edit` / `app`（不改图、不改工作流、不创建任务），仍可用文件读写、命令、联网与 `mtnode_vision`；智能会话与全局助手仍走上述画布工具。典型任务(「实现物品配置工作流」)由会话或助手一次 `edit` 创建「需求 → 生成 → 写入配置表」管道,用户可继续改提示词并点 ▶ 运行。

右上角「审批」另有 **Agent 工具许可预设**(与 `permissionPreset` 正交):按类别设为批准 / 询问 / 拒绝（默认全批准）。内置 `default` 预设为当前产品能力全开;用户可克隆自定义。`applyCanvasOp` / `applyAppOp` / `applyVisionInspect` 对画布/应用/识图做硬拦截（拒绝）或调用前确认（询问）;读文件/终端/联网等经 `dshRunTask` 注入系统提示约束。

## 指引(需求 4)

- 应用内:帮助文档新增「智能能力(dsh)」章节,按「原来只能 X → 现在可以 Y」结构。
- 仓库内:`dsh/README.md` 面向普通用户,内容见该文件。

## 打包(Windows)

- `dsh/main-dsh.js` 随 asar 打包;gateway(含 cordis.yml 与 node_modules 全树)由
  `dsh/after-pack.cjs`(electron-builder afterPack 钩子)复制到
  `resources/dsh/gateway` —— 普通 Node 子进程读不了 asar,运行时侧必须全部在真实
  文件系统上。gateway 路径已在 main-dsh.js 按 `app.isPackaged` 区分。
- 不用 extraResources:electron-builder 对 extraResources 来源同样应用
  .gitignore 剪枝,而 node_modules 必须保持 git 忽略,因此改用 afterPack 手动复制。
- **依赖布局(打包硬约束 · 2026-09-30 实测事故)**:网关依赖只能用 npm 式**真实目录**布局安装 ——
  `dsh/gateway/pnpm-workspace.yaml` 固定 `nodeLinker: hoisted`(同值也写在 `dsh/gateway/.npmrc`,
  供 pnpm < 11 读;**pnpm 11 只认 pnpm-workspace.yaml,`.npmrc` 里的 `node-linker` 会被忽略**)。
  病根:pnpm 默认 isolated 布局把包做成 junction 指向 `node_modules/.pnpm`,而 afterPack 是手动遍历复制
  (只搬真实文件)—— `fs.readdirSync` 的 dirent 对 junction 报 `isDirectory()=false`,于是 junction
  被当普通文件走 `fs.copyFileSync`,在 Windows 上直接抛 EPERM/EISDIR:复制中断后
  `resources/dsh/gateway` 只剩半棵树(`node_modules`、`package.json`、`plugins/` 全缺),
  安装包启动时网关立刻 exit 1 —— `Cannot find package '@deepseek-ai/dsh-sdk-client'`
  (main-dsh.js 侧表现为「dsh 网关已退出(code=1)」)。因此 after-pack 两道保险:
  ① 顶层 `node_modules/.pnpm` 整目录跳过 —— hoisted 下它运行时不可达(顶层与各包内部都没有任何链接
  指回 `.pnpm`,Node 只会向上找 `node_modules`),实测把它改名后 `node dsh/smoke-gateway.mjs` 仍 exit 0,
  它却白占 ~1.8GB;② 遇到「指向目录的符号链接」直接报错中止打包(`assertNoDirLink`),
  把「静默产出坏安装包」变成一眼可见的打包失败。hoisted 重装命令:`cd dsh/gateway && pnpm install`。
- **减重(依赖体检)**:`resources/dsh/gateway` 是安装包里最大的一块。剪枝依据是 `docs/` 下**两份名单**,
  都由 `scripts/app-deps-usage.mjs` 生成,`dsh/after-pack.cjs` 经 `scripts/app-deps-rules.cjs` 的
  `loadExcluder()` 合并读取(三处共用同一判定,不各自写死名单),`build.json` 的 `files` 取反只管根树:
  ① `docs/app-deps-prune.json` —— **零引用口径**(机器判定:从入口出发完全没有任何引用);
  ② `docs/app-deps-capability.json` —— **能力组口径**(人工判定:包在懒加载分支里可达,但本部署永不加载)。

  ```
  npm run deps:usage   # 体检 → 两份 JSON(两棵 node_modules 可达性 + 能力组闭包)
  npm run deps:cap     # 只重算能力组闭包(groups[] + rejected)并打印(两份 JSON 同步刷新)
  npm run deps:check   # 临时镜像复现同一套剪枝 + 六道守卫(改规则/改名单/升级 dsh 后必跑)
  npm run compile      # 或 --win nsis 真打包,看 after-pack 报的「剪枝明细」
  ```

  零引用口径(按用户约定):**只移除「从入口出发完全没有任何引用」的东西**,懒加载分支
  (pi-ai 的 google/anthropic 适配器、sharp 的 wasm32 回退)一律保留。六道守卫(全在
  「零引用 ∪ 能力组」的完整排除集上跑):① 保留包的 `main`/`exports` 入口不得被剪;
  ② 保留代码里 `./`、`../` 相对引用的文件不得被剪(yaml 的 `dist/doc/directives.js` 就是
  靠这条发现的);③ 保留代码里的**裸包名**不得命中排除集 —— 例外只有写死的懒加载白名单
  (`pi-ai/dist/api/mistral-conversations.js` ← `mistral-conversations.lazy.js`、
  `bedrock-converse-stream.js` ← `bedrock-converse-stream.lazy.js`、`dsh-session-telemetry-otel/**`);
  ④ 在镜像与打包产物上真跑 runtimeBin 加载探针;⑤ 启动探针(真实 `import` pi-ai 的
  `providers/all` 与 `openai-completions.lazy` + 按 `cordis.yml` 逐行 import 插件链 + 真起一次
  `gateway.mjs`);⑥ `dsh/smoke-gateway.mjs` 协议冒烟。外加体检内的声明守卫(不可达但被活包
  声明为 runtime/optional 依赖 → 不排除,`--no-decl-guard` 可看差异)。
  目录级规则**只认包根第一层**的 `test/docs/examples`(歧义目录如 `dist/doc` 是运行时代码),
  异平台目录(`prebuilds/win32-arm64`、`win10-arm64`)与异平台 `.node` 任意层都剪,
  `.dll`/`.exe` 永远保留(node-pty 的 winpty、OpenConsole 要它们),LICENSE 一律保留。
- **能力组契约(第二种口径,排除来源)**:见 `docs/app-deps-slimming.md` §7。要点三条 ——
  - 组对象 `{key,title,globs,entries,downstream,reason,risk}`;生效判定 = 各组 `entries ∪ downstream`
    的逐包名 **+** 各组 `globs` 的 scope 通配**在判定时展开**(`@opentelemetry/* · @aws-sdk/* ·
    @smithy/* · @aws-crypto/*`),所以**从 JSON 里删掉一个组对象 = 一键回滚该组**,不改任何代码,
    dsh 升级后新出现的同 scope 包自动落进同一组。当前四组:`otel` OTLP 遥测导出、`awsui` 网关自带
    Web 外壳与前端产物、`mistral` Mistral SDK、`aws` Bedrock 运行时 SDK。
  - `rejected`(114 包)是**硬保护名单**:仍被保留侧硬引用(mount / import / prefix / declared)的名字,
    通配与连带桶都越不过它 —— `@deepseek-ai/dsh-web`(联网搜索,`cordis.yml:351` 挂载)因此留在包里,
    `awsui` 的 globs 只写 `dsh-web-app` / `dsh-web-frontend` 两个精确名而非同前缀通配;「独占下游」
    由闭包重算得出(不是手写),在保留包里还有嵌套副本的包自动退回 rejected。
  - 摘的只是**打进 `resources` 的副本**,开发树 `node_modules`、依赖声明、锁文件一律不动;要恢复
    某项能力 → 删组 + `npm run deps:check` + 重打包。**若改走 `dsh --profile web/headless` 或挂载
    `dsh-session-telemetry-otel`,必须先撤 `otel` 与 `awsui` 两组**,否则网关启动即 `ERR_MODULE_NOT_FOUND`。
- **实测效果(1.2.2,win32-x64)**:`resources` 243.71MB → **93.27MB**;其中
  `resources/dsh` 191.18MB → **76.30MB**(复制 6129 files / 1501 dirs,pruned 151.57MB)。
  after-pack 分桶报的明细(单位 MB):能力组 77.21(`otel` 21.51 / `awsui` 40.01 / `mistral` 9.24 /
  `aws` 5.79 / `cap:collateral` 连带 0.66)+ 零引用包 1.92 + 文件级 72.44(sourcemap、类型声明、
  异平台目录与二进制、MSVC 中间产物、README/CHANGELOG、包根顶层 test/docs/examples、缓存、
  `better-sqlite3/deps` 类源码)。另 `app.asar` 10.68 → 9.29MB,`app.asar.unpacked` 29.08 → 2.43MB,
  `resources/uiohook-napi` 8.02 → 0.50MB;安装包 154.9MB → **117.79MB**(安装包降幅小于 resources
  降幅:NSIS 对 JS 文本压缩率远高于 1:1)。**升级 dsh 后必须重跑 `deps:usage` + `deps:check`**
  (两份名单都会重算,守卫会拦住新的误剪;`reason`/`risk` 里的证据链要人再核一遍)。回滚:删掉
  JSON 里对应条目 / 删掉能力组对象 / 注释掉 build.json 取反规则。已知观感问题:`@opentelemetry`
  `@mistralai` `@aws-sdk` `@smithy` `@aws-crypto` `@shikijs` 在包内留 0 文件的空 scope 目录。
  注:`scripts/` 与 `build.json` 按 `.gitignore` 约定不入库(打包链只在作者工作副本里跑),
  `docs/app-deps-{prune,capability}.json` 入库,是 after-pack 的全部剪枝依据。
- 包级移除的实测结论:根 `node_modules` 441MB 里 production 闭包只有 22 包 / 37.5MB
  (devDependencies 本就不随包发布),**零引用可移除的包 = 0**;网关树 540 包里零引用可
  移除的只有 16 包 / 1.92MB。也就是说「删包」几乎没得删,重量全在保留包内部的非运行时
  文件里 —— 这正是文件级规则承担 99% 减重量的原因。包级还能挤出的量只来自**能力取舍**
  (见上条「能力组契约」):用户点名四组后网关树才又少 77.21MB —— 那是「砍能力」,不是「删冗余」。
  根树侧四组通配实测命中 0 个包,故 `build.json` 不需要跟随取反。
- **未实施(成本过高,记录备查)**:按需联网安装运行库(需捆绑 npm CLI + 镜像
  配置 + 离线失败路径,复杂度与首启体验代价不成比例);NSIS 向导日志页
  (electron-builder 的 assisted 向导已显示逐文件进度,自定义日志页需自写
  NSIS UI 宏)。
- electron-builder 自身对 node_modules 还会兜底排除 `.d.ts/.pdb/.o/.obj/.a/.cc/.sln/
  .csproj` 与包根 `README*/test*/example*`(`app-builder-lib/out/fileMatcher.js`
  的 `excludedExts/excludedNames`),所以 `build.json` 的取反规则只需补它没覆盖的:
  异平台 prebuild、`better-sqlite3/{deps,src}`、`.map/.lib/.iobj/.ipdb/.exp/.tlog` 等。
  网关树由 after-pack 手动复制,**不经过** electron-builder 的这套默认排除,故所有
  规则在 `scripts/app-deps-rules.cjs` 里自带一份。

- 不附带独立 node.exe,但**托管 Node 按需下载**到数据目录(`<DATA>/node-runtime`,约 30MB,
  只在「本机找不到任何真 Node」时才发生):dsh 0.2 的内核拒绝 Electron 自带的 Node,见
  「Node 运行时」一节 —— 该节是这条的唯一真源。
- `dsh/gateway/package.json` 锁死 dsh 全家族精确版本,升级 = 改这里 + `npm install`
  + 重跑 `dsh/smoke-gateway.mjs` 与 `dsh/smoke-real.mjs`。

## 验证记录(0.1.0-rc.6 代)

- 探测:发布 rc.6 全栈(client/server/protocol/base/demo)实测通过;boot 需移除
  `cordis-plugin-hmr` 行(要求 --expose-internals);permission 组合需自定义预设
  `mtnode-unattended`(workspace-write + approval never)。
- `dsh/smoke-gateway.mjs`:本地协议 status/pluginList/run/shutdown 全通过;模型错误
  正确穿透为 error+done 事件。
- `dsh/smoke-interaction-gate.mjs`:交互桥归属契约(四类帧的盖章 / 门控 / 分类诊断 /
  逐帧异常兜底 / 收尾与 closeBridge 撤帧)41 项断言全通过;不起真实模型、不联网。
- `dsh/smoke-real.mjs`(需 key):agent 真实执行「写文件」任务 —— 流式 reasoning →
  write 工具调用 → 文件落盘 → done;在 **Electron 39 自带 Node 22.22.1**
  (`ELECTRON_RUN_AS_NODE=1` 下的 electron.exe)再次全链路通过,工具 write+read。
- 应用冒烟:Electron 39 启动无新 error.log;dsh.log 记录网关随应用自动拉起且保持
  存活;渲染层/主进程语法检查通过。

## 验证记录(0.2.0-rc.2 代 · 两处 0.2 破坏性变更的修复)

2026-09-30 实测(打包产物 `dist/win-unpacked` + 真 key + 真模型),两条链路都是先复现、再修、
再复验:

1. **Electron 指纹**:打包版网关用 Electron 自带 Node 起运行时,每次 run 都回
   `host preparation failed: node-addon-require-builtin unsupported … unsupported Electron
   runtime fingerprint: Node 22.22.1, V8 14.2.231.22-electron.0`(截自 `dsh.log` 的
   `dsh gateway stderr` 与 error 帧)。换真 Node 后同一产物、同一 DSH_HOME 直接跑通:
   status 报 `node: v24.2.0`,运行时正常起机 —— 托管 Node 22.22.1(npm 镜像真下载,5.2s)
   同样跑通,两条路都不再出现指纹错误。
2. **Messages 端点根**:修复前 error 帧是 `DeepSeek Messages request failed (404)`;
   修复后 dev 网关 + 真 Node + 真 key 一轮跑完,`done.finalResponse = "你好"`
   (`deepseek-flash` → 实回 `deepseek-v4-flash`)。同一 key 单独打端点复核:
   `/v1/messages` 404(空体)、`/anthropic/v1/messages` 200。

回归:`node test/smoke-dsh-node.js`（55 项 +「已并入：smoke-dsh-base-url.js」23 项）、
`node test/run-all.mjs` 全量口径见本轮交付说明。

## 已知风险

- rc 版本全栈同升、tag 滞后:npm 安装必须带精确版本。
- 线协议无中途取消:节点停止 = 界面先行复位并提示,引擎侧自然结束,不杀 runtime。
- 无 per-session close:会话句柄常驻至 runtime 重启;会话列表清理走
  `dsh-home/sessions` 磁盘清理(设置面板提供)。
- Windows 上 shell 工具为 pwsh(`tool-bash` 被平台禁用),行为与 Unix 不同。
- Electron 39 升级跨越 31→39:已通过本应用全部所用 API 的启动冒烟;发布前建议
  在目标 Windows 版本上完整回归(尤其图像/GIF/对话框路径)。
