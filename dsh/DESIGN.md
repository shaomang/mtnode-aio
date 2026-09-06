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
main.js (CJS, Electron 31 / 内置 Node 20)
  │  dsh/main-dsh.js             (主进程适配器,只懂本地协议)
  │  本地协议:换行分隔 JSON over stdio   ← 稳定契约,mtnode 自有
  ▼
gateway (dsh/gateway/gateway.mjs, ESM, 独立 Node ≥ 22.19)
  │  @deepseek-ai/dsh-sdk-client (DeepSeekHarness)
  ▼
dsh runtime 子进程 (node dsh-jsonrpc-agent/lib/bin.js dsh/gateway/cordis.yml)
  │  发布物:@deepseek-ai/dsh-sdk-jsonrpc-demo + cordis.yml 组合
  ▼
DeepSeek API
```

三层各守其界:

- **本地协议(main.js ↔ gateway)**是 mtnode 自有格式,随 mtnode 版本演进,与 dsh 无关。
- **gateway**吸收 dsh 的全部 API 变化:SDK 客户端 API、线协议、cordis.yml 行结构、
  发布物形态,都只在这里被翻译成本地协议事件。
- **运行时组合(cordis.yml)**决定 agent 拥有哪些工具。发布 rc.6 代的全栈版本必须
  一致(见下),升级时整体升。

### 版本锁定原则

发布物存在代差陷阱:`@deepseek-ai/dsh-sdk-client` 等包的 `latest` dist-tag 停在
0.0.1-rc.1 代,而 0.1.0-rc.6 代全栈齐套但 tag 未更新。**gateway/package.json 必须把
dsh 全家族锁死在同一 rc 版本(当前 0.1.0-rc.6,精确版本不加 ^)**,任何升级都要整套
同升并在 probe 目录验证。

## 运行时托管

- **统一 Node(零安装)**:gateway 与 dsh 运行时都用 `process.execPath +
  ELECTRON_RUN_AS_NODE=1` 启动 —— Electron 39 内置 Node 22.22.1,满足 dsh
  `^22.19` 且与应用主程序完全同版本。用户机器无需安装任何运行环境。
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
  `bridge-plugin.mjs`(只 import node 内置模块)注册 user-questions provider 与
  审批 answerer;`canvas-plugin.mjs` 注册 `mtnode_canvas_get` /
  `mtnode_canvas_edit`(import `defineTool`,dsh 升级只改 `dsh/`)。帧转发到
  gateway,再由本地协议事件送达 renderer;回答经 `interact` 原路返回。
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
- 回滚目录:`MTNODE_ROLLBACK_DIR` 由 gateway 在 spawn 时注入**绝对路径**(默认
  `<DATA>/rollback`,`<DATA>` = 主进程数据目录)。运行时侧回滚插件用它排除自指(账本与
  对象库自身的写入不进捕获)。未注入 = 回滚能力整体 no-op,其余行为一字不改
  (降级保底:该插件缺席时产品与接入前完全一致)。
- 回滚捕获插件:cordis.yml 固定挂载行 `id: mtnode-rollback` /
  `name: './rollback-plugin.mjs'`,只 import node 内置模块;经同一条桥 TCP **单向**发
  `begin` / `journal` / `end` 帧(不登记 pending、不等回答、自己不写盘)。字段见
  「回滚账本与 journal 帧(契约)」。

## 本地协议(main.js ↔ gateway)

换行分隔 JSON;主进程发 `{id, method, params}`,gateway 回 `{id, ok, result|error}`
以及无 id 的 `{event: {type, ...}}`。

| method | params | 语义 |
|---|---|---|
| `status` | — | `{gateway, node, runtimes, runtimeBin, configPath}` 健康与版本 |
| `run` | `{workspace, input, model?, maxTokens?, apiKey?, baseUrl?, webSearchApiKey?, systemPrompt?, hostPersona?, preset?, effort?, provider?, mtnodeProviders?, permissionPreset?, pure?, resumeSession?}` | 排队一条提示,流式事件直至整轮 idle。`resumeSession`(**断点续跑**,可缺省)= 宿主点名沿用上一轮(崩溃 / 断线 / 超额失败)那次的 dsh session id:网关先按本机会话日志判「盘上有没有这份会话」(第一道闸),续跑轮还会先经 `session/resume` 握手让运行时把旧日志恢复为 live —— 同进程复用 / 跨进程恢复 / `RESUME_UNAVAILABLE` 三态详见「断点续跑契约」;只有**盘上无日志**(状态 C 第 1 条)才"不起 runtime、不消耗任何 token"地只回 `error`(带固定标记 `RESUME_UNAVAILABLE: …`)。`webSearchApiKey` 专供联网搜索。`hostPersona` 经环境变量 `MTNODE_HOST_PERSONA` + `MTNODE_CHAT_ISOLATE` 注入运行时（**不是** settings.yaml：`dsh-system-prompt` 不读 settings），由 `bongochat-prompt` 覆盖 `deployment:persona` 并裁剪工具；同时 cordis 在隔离态禁用画布/文件/路由等 MTNode 插件。`pure`（会话「纯净模式」，渲染层按钮开启）= **双清空 + 引擎侧裁剪**：网关强制空预设文本，并要求宿主同轮把 `systemPrompt` 置空（见 `app-assist.js` / `app-db.js` 的 pure 分支）——两段都空时 `sys` 为空，用户消息**原样**下发，不拼 `【系统设定】` 前缀；同时以 `MTNODE_PURE=1` 注入运行时，`pure-prompt` 插件（在 `system-prompt/assemble` 上 `prepend` 站到 waterfall 最外层）清空**全部** system prompt 段与运行时上下文（`suppressRuntimeContext()`），工具**仅保留联网搜索**；cordis.yml 用同一标记门控禁用画布 / 数据库 / 回滚 / 文件 / 命令 / 技能等 MTNode 插件。runtime key 含 pure 标记，纯净 / 非纯净**不共用进程**；fresh runtime 的预热轮（`harness.run('ok')`）与真实消息分属两个 session，不进纯净会话上下文。真实轮的 session id 由**网关铸造**并显式经 `RunOptions.sessionId` 下发（预热轮另铸一个），据此门控交互桥的提问 / 审批归属——见「交互桥的归属契约」 |
| `cancel` | `{workspace}` | 关闭该 workspace 的全部运行时(在途 run 以错误收束) |
| `interact` | `{kind:'question'\|'approval'\|'canvas'\|'db'\|'abort', id, answers?\|outcome?\|result?\|error?}` | 回答提问 / 审批 / 画布工具 / 数据库工具结果,按交互 id 路由回对应运行时(`canvas` → `{t:'canvas-result'}`,`db` → `{t:'db-result'}`);`kind:'abort'` 让该次交互以失败收场(工具报错而非空答案)。id 已失效 → `{ok:true, stale:true}`(见「交互桥的归属契约」) |
| `rollbackDrain` | `{reqId?}` | 回滚收尾拉取:取走 gateway 侧该轮(缺省 = 最近一轮)缓冲的 rollback 帧,返回 `{frames:[…], dropped:n, sealed:true\|false}`,取后即清缓冲。主进程在 `done` / `cancel` / 运行时关闭后各调一次,**账本封口只以本方法的返回值为权威**(事件是推的、drain 是兜底与封口);无缓冲返回 `{frames:[],dropped:0,sealed:true}`。详见「回滚账本与 journal 帧(契约)」 |
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
questions}`)、`approval`(越权审批,`{id, sessionId, toolName, callId?, reason?}`)、
`canvas`(画布/应用读写,`{id, sessionId, op:'get'|'edit'|'app', params}` —— 渲染层执行后经 `interact`
`kind:'canvas'` 回传结果)、`db`(事实库读写,`{id, sessionId, action, params}` —— 经 `interact`
`kind:'db'` 回传结果;两类帧的 `sessionId` 是发起轮的章,网关据此门控归属)、`ix-drop`(**撤卡通知**,`{id, kind?, reason:'aborted'|'dropped'}`
—— 该交互在本轮收尾 / 桥断开 / 运行时放弃时已作废,渲染层必须撤掉对应卡片;`reqId` 为**空串**
时是「无归属的全局撤卡帧」,渲染层按 `id` 兜底撤卡。见「交互桥的归属契约」)、
`journal`(回滚账本帧,`{phase:'begin'|'pre'|'post'|'end',
rid, sessionId, kind, …}` —— 主进程是唯一落盘者,转给渲染层时剥掉正文,见「回滚账本与
journal 帧(契约)`)、`session-event`(其余会话事件全量透传)、`usage`、`title`、
`error`、`session`(**本轮 dsh 会话归属**,`{sessionId, resumed}` —— runtime 占用成功即发一次,
首条 `session.event` 改判权威 id 时再发一次,见「断点续跑契约」)、
`done`(`{finalResponse, metrics, sessionId, resumed}`;续跑不可用时另带 `resumeUnavailable:true`)。
所有事件带 `reqId`,对应一次 `run`
(`ix-drop` 的全局撤卡帧例外:reqId 为空串)。

> `turn` / `step` 取自 `assistant/chunk` 事件的 `params.event.data`(实测记录形如
> `{type:'assistant/chunk', seq, time, data:{turn, step, chunk:{…}}}`),取不到时回落事件顶层、
> 再回落 chunk,最后 0;`index` 是该内容块在本步内的序号(在 `chunk.index`,缺省 0)。
> `tool` 事件的 `turn` / `step` 同源(`event.data`)。这三者与 `say-end` 都只是**增量字段 /
> 新增事件**:既有事件名与语义一字未改,老渲染层忽略即可,不影响 `finalResponse`、`usage`
> 与回滚链路。渲染层据此 + `turn/start`、`step/start`(走 `session-event` 透传)按步切段。

## 思考强度契约(gateway ↔ 运行时 ↔ 宿主)

> 参考 codex(`codex-rs/protocol/src/openai_models.rs` 的 ReasoningEffort / ModelPreset,
> `core/src/client.rs` 的 `reasoning_effort_for_request`)把 MTNode 的思考强度收敛成一套
> 「宽档位 + 按模型能力归一」:档位词汇、路由能力表与回退链的唯一真源是
> `dsh/gateway/reasoning-effort.mjs`(纯函数模块,gateway 与运行时插件共用,禁止 import
> dsh / pi-ai 运行时包)。本节锁契约,不锁实现;要改档位语义先改那个模块再改这里。

- **档位词汇(可选用档)**:`low / medium / high / xhigh / max`(对齐 pi-ai 能力集
  `@earendil-works/pi-ai` 的 `EXTENDED_THINKING_LEVELS` 的可选用子集)。`off` / `minimal`
  不入选:`off` 在 agent 链上的语义是旧档「关思考」→ `high`(proc_text 非智能节点另有
  自己的 off/低/中/高 循环,不经网关);`minimal` 无消费方。openai 专有的
  `ultra / persistent / service_tiers` 不在范围。
- **旧档兼容**:宿主传来的 `off / none / 无 / 空` 与非法值一律归一为 `high`(兜底默认,
  与历史行为一致);`effort` 参数缺省 = `high`。
- **路由能力表**:`deepseek-official`(llm-deepseek 适配器)能力 `off/low/high/max`,
  可选用交集 `low/high/max` —— `medium`、`xhigh` 请求按「同侧最近低档」回退
  (`medium→low`,`xhigh→high`);目录/pi-ai 等其余路由按全档,模型级精确能力由运行时
  按 `ctx.llm` 解析后夹紧(见下)。归一化**永不硬失败**:不支持 → 最近低档 → `high` 兜底。
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
  [`ctx.tools.restrict({deny})`](../../dsh/gateway/plugins/tool-restrict-plugin.mjs)。它要求
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
  (`<DSH_HOME>/sessions/**/session.jsonl*`)、UI 回显(`reasoning` 事件流)、回滚账本、
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

## 回滚账本与 journal 帧(契约)

> **唯一真源**:主进程落盘、网关转发、渲染层展示三路都按本节字段实现,不得各写一套。
> 本节只锁契约(字段、路径、归属、语义、失败行为),不锁实现;要改字段,先改这里。

### 分工(三路各自的地盘)

| 环节 | 归属 | 只做这件事 |
|---|---|---|
| 捕获 | 运行时插件 `dsh/gateway/rollback-plugin.mjs`(`id: mtnode-rollback`) | 在工具 pre/post 观察点采样,**只发桥帧**,不写盘、不等回答 |
| 定序与转发 | `dsh/gateway/gateway.mjs` | 生成 `rid`、按帧 `id` 去重、把帧转成本地协议事件 `journal`,并留存本轮帧待 `rollbackDrain` |
| 落盘 | `main.js` + `dsh/main-dsh.js` | 写对象库与轮次账本(全仓唯一写入者);渲染层永不直接碰这两个目录 |
| 展示与还原 | `renderer/`(app-assist / app-canvas / app-plan / app-db) | 只读摘要;还原时按 `rid` 向主进程取 blob,写文件经主进程,画布/计划/数据库走渲染层既有唯一入口 |

### 路径与命名

- 根:`<ROLLBACK>` = `MTNODE_ROLLBACK_DIR`(缺省 `<DATA>/rollback`,`<DATA>` = 主进程数据目录)。
- 对象库:`<ROLLBACK>/objects/<sha[0:2]>/<sha>` —— `<sha>` 是**内容字节的 sha256 小写十六进制**(裸 hash 作文件名,不带 `sha256:` 前缀);2 字符分片只为控目录宽度。对象**只增不改**;淘汰属主进程配额策略,契约不承诺存在时长。
- 账本:`<ROLLBACK>/rounds/<sessionId>/<rid>.json` —— 一个 `rid` 一个文件 = 一次 agent 轮次(run)。
- `sha256(内容)` 即对象 id;账本内引用对象一律写裸 `<sha>` 字符串。
- `sessionId` / `rid` 进文件名前消毒:仅保留 `[A-Za-z0-9._-]`,其余替换为 `_`;消毒后撞名视为异常,**拒绝写入**(绝不覆盖已有账本)。
- 账本写入必须原子:先 `<rid>.json.tmp`,封口时 rename 覆盖;崩溃残留的 `.tmp` 与非 `sealed` 账本由下一次 `rollbackDrain` 补齐或标 `partial`。

### 轮次账本(round ledger)schema

```jsonc
{
  "v": 1,                            // 契约版本:只加字段,已有字段语义不改
  "sessionId": "…",                  // dsh 会话 id,与事件 data.sessionId 同源
  "rid": "r-…",                      // roundId,gateway 生成(见下),一次 run 一个
  "reqId": "…",                      // 本地协议该次 run 的 reqId(与日志对齐用)
  "workspace": "E:\\dev\\…",         // 绝对路径,files[].path 的相对基准
  "startedAt": 1720000000000,        // begin 帧时刻(ms)
  "endedAt": 1720000006000,          // end 帧时刻(ms);未封口为 0
  "status": "sealed",                // open(在途) | sealed(完整封口) | partial(有丢帧) | failed
  "msgLen": 48213,                   // 本轮 journal 帧 JSON 累计字节数(配额与诊断)
  "dropped": 0,                      // 被丢弃帧数(超限 / 重复 id / 无归属)
  "files": [{
    "path": "src/a.js",              // 相对 workspace;工作区外写绝对路径并置 outside:true
    "objId": "e3b0c4…",              // 回滚要写回的【改前内容】对象 sha;existed=false(本轮新建)时为 ""
    "beforeHash": "…",               // 改前字节 sha256;改前不存在时 ""
    "afterHash": "…",                // 本轮最晚 post 的字节 sha256;本轮删除时 ""
    "existed": true,                 // 本轮开始前该路径是否已存在 → 决定回滚是写回还是删除
    "size": 2048,                    // 改前字节数
    "mtimeMs": 1719999000000,        // 改前 mtime,回滚后原样复位
    "callId": "tc_12",               // 本轮【最早】触及它的工具调用 id
    "tool": "write",                 // 该次工具名
    "hits": 2,                       // 本轮被改次数(同 path 合并计数)
    "outside": false,                // 是否位于 workspace 之外
    "unsupported": ""                // 非空 = 改前内容不可得,回滚跳过该条并如实报告:
                                     // "too-large" | "binary" | "denied" | "gone"(对象缺失)
                                     // | "frame-dropped" | "shell" | "outside"
  }],
  "canvas": [{
    "wfId": "wf_…",                  // 工作流 id
    "before": "sha…",                // 改前整工作流快照(序列化 JSON)对象 sha;首次 = ""
    "after": "sha…",                 // 改后整工作流快照对象 sha
    "touched": {                     // 本轮实际改动的元素,供 UI 高亮与「这一轮改了什么」列表
      "nodeIds": [], "wireIds": [], "markIds": [], "groupIds": []
    }
  }],
  "plan": {                          // 该轮结束时会话计划态快照(还原时原样放回)
    "plan": null,                    // st.plan:已确认计划(步骤 + 每项状态 + 进度)
    "todos": [],                     // st.todos
    "outbox": [],                    // st.outbox:发送队列残留(含 _planExec / planRunId / sessionId)
    "_planExec": null                // st._planExec 运行时游标;还原前必须核对 sessionId 归属
  },
  "planObj": "",                     // plan 序列化 > 256KB 时整段落对象库,此处存 sha,"plan" 置 null
  "db": [{
    "dir": "E:\\…\\<db dir>",        // 数据库目录(db-store 的 SQLite 所在目录)
    "id": "rec_…",                   // 记录 id
    "before": null,                  // 改前记录 JSON;本轮新增时 null
    "after": { "id": "…", "title": "…", "content": "…" }  // 改后记录 JSON;本轮删除时 null
  }],
  "untracked": { "shellCalls": 1 },  // 本轮 shell / execute 次数:其文件改动不可捕获,只记数
  "restoredAt": null                 // 已回滚时刻(ms);非空 = 该账本已消费,二次回滚默认拒绝
}
```

### journal 帧 schema(桥 TCP,换行分隔 JSON)

与 `question` / `approval` / `canvas` / `db` 同一条通道(`MTNODE_BRIDGE_PORT`),但
**单向 fire-and-forget**:gateway 对 `t:'begin'|'journal'|'end'` 不登记 `bridgePending`,
不回 `answer`/`outcome`/`abort`。

```jsonc
{ t:'begin',   id, sessionId, roundId?, workspace, reqId?, at }
{ t:'journal', id, sessionId, roundId?, phase:'pre'|'post',
  kind:'file'|'canvas'|'db'|'shell',
  callId, tool,                       // 触发它的工具调用
  // kind:'file'   → path, existed, hash, size, mtimeMs
  //                + phase='pre' 才带 content('utf8'|'base64')与 encoding;'post' 只带 hash/size/mtimeMs
  // kind:'canvas' → wfId, snapshot(pre/post 各一份整工作流快照), touched{nodeIds,wireIds,markIds,groupIds}
  // kind:'db'     → dir, id, record(pre/post 的记录 JSON;不存在时 null)
  // kind:'shell'  → cmd(截断 512B), cwd                 → 只汇总进 untracked.shellCalls
}
{ t:'end',     id, sessionId, roundId?, at, dropped? }
```

- `id` = 帧 uuid,**去重键**(同 id 二次到达 gateway 丢弃并 `dropped++`)。
- `rid` 权威在 gateway:本轮第一个 `begin` 上 stamp gateway 生成的 rid(格式
  `r-<base36(ms)>-<6 random>`);后续缺 `roundId` 的帧挂到本轮,自带不一致的以 gateway
  为准并在该帧标 `roundMismatch`。渲染层与主进程一律用事件里的 `rid`,不自造。
- 没 `begin` 就来 `journal`:gateway 就地补一个 begin(`workspace` 取该 run 的 params),
  不丢帧。`end` 到达即封口,`rollbackDrain` 为权威收尾点。
- 单帧 > 2 MB:整帧丢弃(`dropped++`),但 file 类仍落一条 `unsupported:'too-large'`
  条目(hash / size / mtime 照记)——宁可标记不可静默。
- 插件侧丢帧(桥断开、无端口)一律静默:不重试、不缓存正文,**绝不拖慢 agent**;
  缺口由 `dropped>0` → 账本 `status:'partial'` 显式暴露。
- `done` / `cancel` 之后到达的帧:gateway 只留在本轮缓冲,等 `rollbackDrain` 取走
  (此时 reqId 已回收,不再直接推事件)。
- **画布与计划快照由渲染层补齐**:运行时插件看不见画布与会话内存,它只能在相关工具调用上
  发 `kind:'canvas'` 的关联帧(`wfId` / `callId`,表示"本轮动了这个工作流")。真正的
  `before` / `after` 整快照与 `plan` 段由渲染层在 `applyCanvasOp` 前后、以及本轮封口时各取
  一份,经既有 preload 白名单 IPC 交给主进程按同一 `rid` 合并进账本。缺这份上报时账本仍
  记"动了哪个 `wfId`",但对应 `before` / `after` 留 `""`(= 快照不可得,还原跳过该条并报告)。

### 事件 `journal`(gateway → main.js → renderer)

`{reqId, type:'journal', data:{ phase:'begin'|'pre'|'post'|'end', rid, sessionId, kind, … }}`。

- 主进程边收边写:pre 帧正文即时入对象库(内容寻址天然去重),并维护 `status:'open'`
  账本;`rollbackDrain` 返回后按帧重放补齐、去重,再改写为 `sealed` / `partial`。
- 转发给渲染层时**剥掉正文**(`content` / `snapshot` / `record` 全换成 sha + 大小摘要):
  渲染层只拿"哪一轮、哪些路径、多大、touched 了哪些元素",还原才按 `rid` 回头索取。
- 落盘失败(磁盘满、路径不可写)只记 `<ROLLBACK>/rollback-error.log` 并降级该轮为
  `failed`,不得影响该轮 agent 运行。

### 合并、守卫与还原顺序

- 同一 `rid` 内同 `path` 合并为**一条**:`beforeHash` / `objId` / `existed` / `size` /
  `mtimeMs` / `callId` / `tool` 取本轮**最早**的 pre,`afterHash` 取最晚的 post,`hits` 计数。
- 只有改前内容入对象库(回滚要写回的就是它);文件改后内容**不入库**(体积翻倍且回滚
  用不到),`afterHash` 只服务守卫校验。画布相反:`before` 与 `after` 两份快照都入库
  (相对小,且要支持"还原到改前 / 跳回改后"两种视图)。
- 还原前置守卫:还原前必须校验当前字节的 sha256 == `afterHash`(说明本轮结束后没人动过它);
  若 == `beforeHash` 视为幂等 no-op;两者都不等 = 已被第三方改动 → 冲突,该条**默认拒绝**并报告,
  只有用户显式强制才覆盖。`afterHash:""`(本轮删除)则要求当前文件确实不存在,否则同为冲突。
- 应用顺序与捕获顺序相反:`files`(逆序)→ `db`(逆序 upsert,`before:null` = 删除该记录)
  → `canvas`(整快照经 `applyCanvasOp`,一次一条撤销记录)→ `plan`(核对 `sessionId` 后放回)。
- **安全失败**是本契约的硬底线:账本缺、对象缺、`unsupported` 非空、`outside:true` 的条目,
  一律跳过并逐条如实报告(写清"这一项回滚不了,需人工处理"),任何情况下不得凭猜测
  创建 / 删除 / 覆盖工作区里的文件。
- 一个 `rid` 是一次回滚单位,不承诺跨轮批量回滚;要连续回滚由渲染层按 rid 从新到旧逐个走。
- 回滚成功后把 `restoredAt` 写回同一账本;非空时再次还原默认拒绝(避免把回滚当撤销反复抖动)。

### 捕获边界(明确不保证)

- **捕获**:agent 文件工具(write / edit / str_replace_editor 类)、`mtnode_canvas_edit`
  与 `applyCanvasOp` 的画布写、`mtnode_db` 的 write / delete。
- **不捕获**:`pwsh` / `execute` / 外部程序对文件的改动(只累计 `untracked.shellCalls`,
  回滚前必须提示"有 N 次命令可能改了文件,账本管不了,请自查");`<ROLLBACK>` / `<DATA>`
  自身写入(自指,靠 `MTNODE_ROLLBACK_DIR` 排除);`node_modules/`、`dist/` 等
  AGENTS.md「不要修改」清单内的路径记条目但 `unsupported:'outside'`,不还原。
- **不承诺 redo / 前向重放**:账本只存改前 blob,redo 需另立契约再改本节。

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
  "model": "deepseek-v4-flash",    // agent 功能默认模型
  "maxTokens": 49152,
  "defaultWorkspace": "",          // agent 节点默认工作目录(文件夹窗口选择)
  "preset": "minimal",             // agent 预设(默认档 = minimal): minimal/standard/lean/code/cordis
  "chatEnter": "send",             // 对话发送行为: send(Enter 发送) / newline(Ctrl+Enter 发送)
  "permissionPreset": "mtnode-unattended", // 权限预设: mtnode-unattended/workspace-write/read-only/danger-full-access
  "agentToolPresetId": "default",          // 当前 Agent 工具许可预设 id
  "agentToolPresets": [                    // 工具许可预设列表；default 为内置「当前能力全开」
    { "id": "default", "name": "默认（当前能力）", "builtin": true, "allow": { "canvas_read": true, "canvas_nodes": true, "canvas_control": true, "canvas_draw": true, "canvas_layout": true, "app_ops": true, "app_delete": true, "fs_read": true, "fs_write": true, "shell": true, "web": true, "subagent": true, "ask_user": true, "vision": true } }
  ],
  "doneSound": true,               // 长任务(>5 分钟)完成音效
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

- 无需附带独立 node.exe:Electron 39 内置 Node 22.22.1,gateway/runtime 经
  `process.execPath + ELECTRON_RUN_AS_NODE=1` 复用同一二进制(见「运行时托管」)。
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

## 已知风险

- rc 版本全栈同升、tag 滞后:npm 安装必须带精确版本。
- 线协议无中途取消:节点停止 = 界面先行复位并提示,引擎侧自然结束,不杀 runtime。
- 无 per-session close:会话句柄常驻至 runtime 重启;会话列表清理走
  `dsh-home/sessions` 磁盘清理(设置面板提供)。
- Windows 上 shell 工具为 pwsh(`tool-bash` 被平台禁用),行为与 Unix 不同。
- Electron 39 升级跨越 31→39:已通过本应用全部所用 API 的启动冒烟;发布前建议
  在目标 Windows 版本上完整回归(尤其图像/GIF/对话框路径)。
