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
| `run` | `{workspace, input, model?, maxTokens?, apiKey?, baseUrl?, webSearchApiKey?, systemPrompt?, hostPersona?, preset?, effort?, provider?, mtnodeProviders?, permissionPreset?}` | 排队一条提示,流式事件直至整轮 idle。`webSearchApiKey` 专供联网搜索。`hostPersona` 经环境变量 `MTNODE_HOST_PERSONA` + `MTNODE_CHAT_ISOLATE` 注入运行时（**不是** settings.yaml：`dsh-system-prompt` 不读 settings），由 `bongochat-prompt` 覆盖 `deployment:persona` 并裁剪工具；同时 cordis 在隔离态禁用画布/文件/路由等 MTNode 插件 |
| `cancel` | `{workspace}` | 关闭该 workspace 的全部运行时(在途 run 以错误收束) |
| `interact` | `{kind:'question'\|'approval'\|'canvas', id, answers?\|outcome?\|result?}` | 回答提问 / 审批 / 画布工具结果,按交互 id 路由回对应运行时 |
| `rollbackDrain` | `{reqId?}` | 回滚收尾拉取:取走 gateway 侧该轮(缺省 = 最近一轮)缓冲的 rollback 帧,返回 `{frames:[…], dropped:n, sealed:true\|false}`,取后即清缓冲。主进程在 `done` / `cancel` / 运行时关闭后各调一次,**账本封口只以本方法的返回值为权威**(事件是推的、drain 是兜底与封口);无缓冲返回 `{frames:[],dropped:0,sealed:true}`。详见「回滚账本与 journal 帧(契约)」 |
| `providerCatalog` | — | `{deepseek:[…], piai:[…]}` 服务商/模型目录(pi-ai 同源) |
| `pluginList` / `pluginAdd` / `pluginRemove` / `pluginEnable` / `pluginDisable` | `{pkg, id?}` 等 | 读取/安装/移除/挂载/卸载 cordis.yml 插件。`pluginList` 每项含 `title`/`description`/`purpose`/`version`(来自 package.json、preset.yml、行上注释)。核心运行时行只读;非核心(用户插件、套装、可选 shipped 行)可在设置中挂载/卸载;变更后重启运行时 |
| `mcpList` / `mcpAdd` / `mcpRemove` / `mcpSetEnabled` | `{serverName, …}` | MCP 服务器管理(cordis 用户段,变更后重启运行时) |
| `shutdown` | — | 关闭全部运行时并退出 gateway |

`run` 的事件:`reasoning`(思考增量 `{text, turn, step, index}`)、`text`(正文增量
`{text, turn, step, index}`)、`say-end`(一段正文的块收尾 `{turn, step, index}`,供前端切段;
仅 `assistant/chunk` 的 `block-end` 且块类型为 `text` 时发)、`tool`(工具调用
`{name, args}`)、`status`(`{state}`)、`question`(模型提问,`{id, sessionId,
questions}`)、`approval`(越权审批,`{id, sessionId, toolName, callId?, reason?}`)、
`canvas`(画布/应用读写,`{id, op:'get'|'edit'|'app', params}` —— 渲染层执行后经 `interact`
`kind:'canvas'` 回传结果)、`journal`(回滚账本帧,`{phase:'begin'|'pre'|'post'|'end',
rid, sessionId, kind, …}` —— 主进程是唯一落盘者,转给渲染层时剥掉正文,见「回滚账本与
journal 帧(契约)`)、`session-event`(其余会话事件全量透传)、`usage`、`title`、
`error`、`done`(`{finalResponse, metrics}`)。所有事件带 `reqId`,对应一次 `run`。

> `turn` / `step` 取自 `assistant/chunk` 事件的 `params.event.data`(实测记录形如
> `{type:'assistant/chunk', seq, time, data:{turn, step, chunk:{…}}}`),取不到时回落事件顶层、
> 再回落 chunk,最后 0;`index` 是该内容块在本步内的序号(在 `chunk.index`,缺省 0)。
> `tool` 事件的 `turn` / `step` 同源(`event.data`)。这三者与 `say-end` 都只是**增量字段 /
> 新增事件**:既有事件名与语义一字未改,老渲染层忽略即可,不影响 `finalResponse`、`usage`
> 与回滚链路。渲染层据此 + `turn/start`、`step/start`(走 `session-event` 透传)按步切段。

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
  "preset": "standard",            // agent 预设: standard/minimal/code/cordis
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
- **体积优化**:after-pack 排除未挂载能力的死重依赖(sharp/@img);`llm-pi-ai`
  已随服务商目录需求重新挂载,其依赖(openai/@mistralai/@opentelemetry/
  @earendil-works)不可排除。安装包约 116~123 MB。
- **未实施(成本过高,记录备查)**:按需联网安装运行库(需捆绑 npm CLI + 镜像
  配置 + 离线失败路径,复杂度与首启体验代价不成比例);NSIS 向导日志页
  (electron-builder 的 assisted 向导已显示逐文件进度,自定义日志页需自写
  NSIS UI 宏)。
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
