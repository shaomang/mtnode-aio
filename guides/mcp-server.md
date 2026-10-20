# MTNode MCP 服务端 · 接入指南

> 面向第三方开发者：怎么把 Claude Code / Cursor / 自研 Agent 接到本机 MTNode 上。
> 面向用户的那一版在应用内手册 `guides/manual/mcp-server.md`；本文件是工程口径（含协议细节与排障）。
> 机器可读契约：[`../mcp-tools.json`](../mcp-tools.json)（生成物，禁止手改）。

## 1. 这是什么

MTNode 原本只做 MCP **客户端**（`dsh/gateway/mcp-resources.mjs` 连别人的服务器，给自家 Agent 加工具）。
本模块补上另一半：MTNode 自己作为 MCP **服务端**，对外暴露 13 个工具 ——
画布 / 应用 / 数据库 / 事实库 / 长任务 / 素材 / 识图 / 窗口操作（`mtnode_gui`），
以及**媒体生成**（图像 / 音乐 / 语音 / 视频）、**跑节点与整图**、**用户工具节点**、**会话**。

**同一个服务端也给自己用**（§3.6 自用回环）：应用内的 Agent 经 MCP 调自己的生成能力，
走的是与第三方客户端完全相同的入口 —— 不另开一条只有 agent 能走的后门。

**执行不另起一套**：外部客户端的每一次调用都被翻译成宿主内部那条既有路径 ——

```
第三方客户端
  │ stdio（mcp-stdio.js 桥，只转发）或 HTTP
  ▼
主进程 mcp-server.js（协议 / 鉴权 / 排队 / 审计 / 版本闸）
  │ webContents.send('mcp:event')
  ▼
渲染层 renderer/mcp-bridge.js（执行桥）
  │ 复用既有宿主处理函数
  ▼
handleCanvasEvent / handleDbToolEvent / handleAiFactsToolEvent / handleAssetToolEvent / LT
  / window.MTNodeMcpExtra（跑节点 / 用户工具 / 会话 / 建媒体节点）
  │ window.api.mcpInteract
  ▲ 原路回执
```

例外有两族（都不经渲染层）：`mtnode_gui`（主进程操作窗口）与
`mtnode_generate`（主进程直连四个本机生成后端）。

于是「第三方调用」与「自家 Agent 调用」共用同一套准入、落盘、告警与回执口径。

## 2. 快速接入

### 2.1 stdio（推荐，多数本地客户端）

面板「设置 → 扩展能力 → 管理… → 服务端 → 复制配置片段」给出的就是这一段（打包态 `command` = 安装目录里的 `MTNodeAIO.exe`，并**连 `env` 一起给**）：

```json
{
  "mcpServers": {
    "mtnode": {
      "command": "<MTNode 安装目录>\\MTNodeAIO.exe",
      "args": ["<MTNode 安装目录>\\resources\\mcp-stdio.js"],
      "env": { "ELECTRON_RUN_AS_NODE": "1" }
    }
  }
}
```

- **为什么 `command` 是应用自己的可执行文件、且打包态必须带 `ELECTRON_RUN_AS_NODE=1`**：`MTNodeAIO.exe` 是 **Electron 二进制，不是 Node**。打包态**只有**同时给出环境变量 `ELECTRON_RUN_AS_NODE=1`，它才会以普通 Node 模式运行这个脚本、正常吐 JSON-RPC；**漏掉这条环境变量它会再拉起一个应用实例**（真机实测：10 秒不退出、多出 4 个实例、stdout 只有 `[user-plugins]` 体检文本、**零 JSON-RPC**）—— 客户端侧的表现就是怎么都连不上。开发态（未打包）的 `command` 本身就是真 Node（`node_modules\\electron\\dist\\electron.exe` 或系统 `node`），**不带**这条 env（带了也无害，但不要在开发态抄进配置）。想用系统 Node：把 `command` 换成 `node` 并**删掉 `env` 这一段**（要求 Node ≥ 18，脚本只用 `fetch` 与内置模块）。
- 同一个口径也在 `GET /meta` 的 `stdioCommand`（`{script, node, env, display}`）里给出：面板片段与它取自同一真源，不会再一个说 exe、一个说 node —— 打包态两边都给 `ELECTRON_RUN_AS_NODE=1`。
- macOS / Linux 同上（`command` 换成实际的 MTNode 可执行文件或 `node`，路径换成实际安装位置；用应用可执行文件时同样要带 `ELECTRON_RUN_AS_NODE=1`）。
- 桥脚本自己读数据目录里的 `mcp-server.json` 拿端口与令牌，所以**配置里不需要地址与令牌**；
  也可用环境变量显式覆盖（便携版 / 多用户）：`MTNODE_DATA_DIR`、`MTNODE_MCP_URL`、`MTNODE_MCP_TOKEN`。
- 客户端重启一次即可看到全部 13 个工具（包含只在 MCP 这一侧提供的 `mtnode_gui` 与生成 / 跑图四件）。

### 2.2 本机 HTTP（自研客户端 / 远程工具宿主）

```bash
curl -s http://127.0.0.1:<port>/mcp \
  -H 'content-type: application/json' \
  -H "authorization: Bearer <token>" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

- 端口与令牌：面板里可见；数据目录（默认 `%APPDATA%\pipeline-console\pipeline-console`，设置在「配置数据目录」里改过就是它指向的那个目录）下的 `mcp-server.json` 里也可读。
- 令牌也可以放在 query 里：`http://127.0.0.1:<port>/mcp?token=<token>`（给**只能填 url、塞不了请求头**的客户端用；服务端只绑回环，口径与 HTTP 头等价）。
- 只绑 `127.0.0.1`，不对外网开放。
- 另有两个只读辅助端点：`GET /meta`（健康与能力摘要，**不需要令牌**，不含令牌本身）、`GET /health`。
- 给 stdio 桥用的扁平控制面 `POST /ctl`（`{method, params}` → `{ok, result|error}`），第三方一般不需要它。

### 2.3 各客户端的落点（供参考，以官方文档为准）

| 客户端 | 配置文件 |
| --- | --- |
| Claude Code | 项目内 `.mcp.json` 或用户级 MCP 配置的 `mcpServers` 段 |
| Cursor | 「Settings → MCP」里粘贴同一段 `mcpServers` |
| 自研 Agent | 直接实现 HTTP 传输，或 `spawn(process.execPath, ['mcp-stdio.js'], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })` 走 stdio（自家的 Electron 运行时**必须**带这条 env，理由见 §2.1；换成真 Node 则去掉它） |

## 3. 协议面

- 协议版本：`2025-06-18`（也接受 `2025-03-26` / `2024-11-05` 的握手，回以自己支持的那一版）。
- 传输：Streamable HTTP 的 JSON 响应形态（`POST /mcp`，`initialize` 回 `Mcp-Session-Id` 头）；
  通知（`notifications/*`）回 `202`、无体。stdio 侧是换行分隔 JSON-RPC。
- 能力位：`tools`（13 个，`listChanged:false`）、`resources`（2 个静态 + 3 个模板）、`prompts`（3 份）、`logging`。
- 工具调用失败按 MCP 口径回报：**JSON-RPC 成功 + `result.isError: true`**，错误文本原样给模型；
  协议级 `error` 只用于「方法不存在 / 请求非法」这类真的协议错误。
- 工具名一律 `mtnode_*` / `lt_*` 前缀，`initialize` 的 `instructions` 里也声明了这条约定 ——
  与其它 MCP 服务端同时挂载时按前缀区分。

### 3.1 工具

| 工具 | family / 渲染层 op | 写 | 说明 |
| --- | --- | --- | --- |
| `mtnode_canvas_get` | canvas / `get` | 否 | 节点索引 → 配置 → 正文，`contentHash` 也在这里 |
| `mtnode_canvas_edit` | canvas / `edit` | 是 | 建 / 连 / 改 / 删 / 分组 / 绘制 |
| `mtnode_app` | canvas / `app` | 部分 | 应用级动作（含长任务图存取、插件管理） |
| `mtnode_vision` | canvas / `vision` | 否 | 识图子代理 |
| `mtnode_db` | db / `db` | 部分 | 数据库副本 |
| `mtnode_facts` | facts / `facts` | 部分 | 本画布 AI 事实库 |
| `lt_state` | lt / `lt` | 是 | 长任务本轮状态（只在环节内有归属） |
| `mtnode_assets` | asset / `asset` | 否 | 素材库 / 窗口静帧 |
| `mtnode_generate` | gen / **主进程执行** | 是 | 媒体生成：`kind` = `image` / `music` / `speech` / `video`；回本机绝对路径，默认顺手进素材库 |
| `mtnode_run` | run / `run`（渲染层 `MTNodeMcpExtra.run`） | 是 | `action:"node"` 跑单个节点（要 `nodeId` + `baseHash`），`action:"graph"` 跑整图（找那颗 `control` 节点） |
| `mtnode_tools` | tool / `tool` | 否 | `action:"list"` 列当前画布**用户工具节点**（参数即端子），`action:"call"` 真调一个 |
| `mtnode_session` | session / `sessionTask` | 是 | `create` / `send` / `read` / `close`：新建一条带前缀的会话跑一轮任务（默认用完即弃） |
| `mtnode_gui` | gui / **主进程执行**（不经渲染层） | 是 | 认元素 / 点 / 输入 / 按键 / 滚动 / 等待 / 读结构 / 窗口截图 |

参数表的**唯一真源**是 `dsh/gateway/*-plugin.mjs` 的 `defineTool` 参数表；`mcp-tools.json`
由 `scripts/build-mcp-contract.mjs` 真实执行插件模块抓取并编译成 JSON Schema，
`test/smoke-mcp-server.js` 钉住「重跑生成器结果一致」。

### 3.2 MCP 侧路由参数（**不在**插件参数表里，只属于 MCP 面）

| 参数 | 适用 | 语义 |
| --- | --- | --- |
| `canvas` | 画布 / 数据库 / 事实库 / 长任务族 | 目标画布：id、精确名称，或 `current`（默认）。省略 = 当前打开的画布 |
| `baseHash` | `mtnode_canvas_edit`、`mtnode_app` 的写动作 | 上一次 `mtnode_canvas_get` 回执里的 `contentHash`；不一致 → 本次修改被拒 |

这两个参数在服务端被摘出来（不下发给渲染层的插件处理函数）。

### 3.2.1 `mtnode_gui`：主进程执行（GUI 一族）

`mtnode_gui` 由主进程直接干（`mcp-gui-agent.js`）：
只有主进程拿得到 `BrowserWindow`，能往**任意**窗口注入脚本、能 `webContents.capturePage` 拍照。
渲染层桥里仍留着一支 `case "gui"` 的回执文案，那是给「旧版服务端推错帧」时的可读报错。

```jsonc
// 先看清有哪几只窗（安装窗 / 各插件控制台都算）
{ "action": "windows" }
// 看一眼结构 + 可见文字（拿 ref，随后点击）
{ "action": "outline", "which": "install", "textMax": 40 }
// 点一个按钮：按可见文字（推荐，改版也不容易失效）
{ "action": "click", "which": "install", "target": { "text": "开始安装" } }
// 等它变成「安装完成」
{ "action": "wait", "which": "install", "text": "安装完成", "timeoutMs": 60000 }
// 拍一张静帧落盘（外部 Agent 自己看）
{ "action": "screenshot", "which": "install", "path": "E:\\tmp\\install.png" }
```

- `which`：`main`（默认）· `install`（插件安装窗）· `any`（焦点窗）· 或窗口标题的任意子串
  （各插件控制台窗口以插件名命名，如 `"Minimax H3"`）。
- `target` 五种写法：`{css}` · `{text, exact?, index?}` · `{title}` · `{role, name?}` ·
  `{ref}`（outline 给的引用，页面重渲染后失效，重跑 outline 即可）。
- 动作：`windows` / `outline` / `text` / `click` / `type` / `set` / `key` / `scroll` / `wait` /
  `eval` / `screenshot`；细节与参数以工具描述为准（真源 `dsh/gateway/gui-plugin.mjs`）。
- **点的是页面里真实的 DOM**（`el.click()` + 完整鼠标事件序列），不是屏幕坐标 ——
  所以窗口不必在前台、不必获得焦点，也不会因为别的窗口挡住而点歪。
- **够不着的**（会明确报错，不会假装成功）：原生菜单、系统文件选择对话框、托盘菜单
  （它们不在 DOM 里）；最小化 / 隐藏的窗口拍不到图（先把它显示出来）。
- **不代填凭据**：密码类输入一律由人在窗口里输入。

### 3.3 resources

| URI | 内容 |
| --- | --- |
| `mtnode://canvases` | 画布清单（id / 名称 / 节点数 / 是否当前） |
| `mtnode://skills` | 内置技能清单（名称 / 标题 / 描述 / 路径） |
| `mtnode://canvas/{canvas}/snapshot` | 画布快照（默认 `detail:"minimal"`） |
| `mtnode://canvas/{canvas}/node/{node}` | 单节点正文（`detail:"full"`） |
| `mtnode://skill/{name}` | 内置技能 SKILL.md 正文（`text/markdown`） |

### 3.4 prompts

`takeover-canvas`（接手画布）、`build-workflow`（建工作流，必填 `goal`）、`review-canvas`（只读审阅）。
正文由 `mcp-prompts.js` 组装：只指向真源（工具名、资源 URI、技能名），不抄建图硬规则。

### 3.5 作业：`mtnode_generate` / `mtnode_run` 为什么是异步的

生成一张图要几十秒，跑整图可能几十分钟 —— 一次 HTTP 请求干等会对不上任何客户端的超时。
所以这两族**默认立刻回**一个 `jobId`，结果另取：

```jsonc
// 起作业（立刻返回）
{ "kind": "image", "prompt": "赛博朋克猫", "size": "1024x1024" }
// → { ok:true, jobId:"job-1a2b3c4d", kind:"image", status:"running", hint:"…" }

// 取结果（不阻塞）
{ "action": "status", "jobId": "job-1a2b3c4d" }
// → { ok:true, status:"ok", result:{ ok:true, path:"E:\\…\\cat.png", bytes:812345, asset:{…} } }
```

- `action`：`run`（默认；`mtnode_run` 是 `node` / `graph`）· `status` · `cancel` · `list`。
- `wait: true` 就地等到出结果（上限 15 分钟），适合小图 / 短任务；超时后先前的 `jobId` 仍可用 `status` 再查。
- **作业只活在内存里**：MTNode 一关就清空，重启后查旧 id 一律回 `JOB_GONE`（不假装有结果）。
  面板「服务端」页有一份只读列表（`mcp:jobs`）。
- **媒体生成共用画布那唯一一把音视频互斥锁**（`media-gen-global-lock.js`）：画布节点在跑时这里会等到它跑完。
- 产物回**本机绝对路径**，并默认归档进素材库（`archive:false` 可关；归档失败只记一条 warning）。
- 想顺手把产物摆到画布上：`createNode:true` **且**同时给 `canvas` + `baseHash`
  （`canvas` 来自上一次 `mtnode_canvas_get`）。缺任一项只加一条 warning、不建节点。
- 取消：音乐 / 视频有真取消口；图像 / 语音没有 → 回 `cancel_unsupported`（让它跑完）。
- `mtnode_run` 的 `node` 要 `baseHash`（防跑在已改过的图上），`graph` 不用。

### 3.6 自用回环：MTNode 自己调自己

面板「设置 → 扩展能力 → 管理… → 服务端」有一个**自用回环**开关（默认开）。开着时：

- 服务端监听成功后，主进程把「自己」注册成引擎 MCP 客户端清单里的一行：`mtnode-self`，
  url = `http://127.0.0.1:<port>/mcp?token=<token>`（令牌落 `cordis-user.yml`，与 `mcp-server.json` 同一份）。
- 只暴露**四项**：`mtnode_generate` / `mtnode_run` / `mtnode_tools` / `mtnode_session`。
  画布读写、GUI、数据库仍让 agent 走内置工具（同进程、能带确认卡），不绕远路。
- 每次启动端口都变 → 该行随之重写；关掉开关 = 撤掉那一行（服务端本身照跑，第三方客户端不受影响）。
- 受**总开关**约束：MCP 服务端关着就不注册。
- 于是「应用内 Agent 生成一张图」与「外部客户端生成一张图」走的是同一套鉴权、审计、作业语义。

## 4. 权限、并发与审计

- **授权模型（用户已确认的口径）**：服务端开着 + 令牌正确 = 全量读写，**不再逐笔确认**。
  收回：关总开关 / 重置令牌（`POST` 面板按钮）。
- **不影响自家会话**：`renderer/mcp-bridge.js` 只在一次调用期间置 `S._mcpAuthorized`，
  用户自己的会话 / 助手 / 智能节点的确认框、审批档与许可面板一字未改。
- **并发**：写操作串行化（服务端按会话排队 + 渲染层按会话二次排队），读并发。
  跨连接与「用户手改」之间的冲突靠 `baseHash` 乐观并发拦下：过期写一律拒绝，不做半截修改。
- **审计**：`<数据目录>/mcp-audit/mcp-YYYY-MM-DD.jsonl`（按天轮转，保留 7 天；面板可读）。
  字段：`ts / seq / session / client / method / tool / canvas / ms / ok / error / args(≤200 字)`；
  **参数校验失败与未知工具同样入账**（那是最该被看见的几条）。
- **抓包**：面板可开的原始 JSON-RPC 记录，最近 200 条、仅内存、默认关闭。

## 5. 刻意不做（边界）

| 不做 | 为什么 |
| --- | --- |
| 不导出 dsh 引擎自带工具（文件 / 命令 / 联网） | 那些能力客户端自己就有；开了等于把主进程的 shell 与文件系统也交出去 |
| 不导出 `browser_*`（13 个会话浏览器工具） | 那是用户自己的浏览器会话，不交给外部客户端 |
| 不推进长任务、不替人审批 / 交付 | 长任务的人工环节必须有人的位置；MCP 只读写状态与图定义 |
| 不替人挑模型与账号 | `mtnode_generate` 用应用里**已配好**的模型 / 本机后端；没配就回明确原因，不猜测、不静默降级 |
| 不代填凭据、不碰原生对话框 | `mtnode_gui` 只操作页面 DOM：密码输入的凭据只由人给；系统文件选择框、原生菜单、托盘菜单够不着（会明确报错） |
| 不做局域网 / 公网绑定 | 共识口径是只绑回环；需要远程接入请自行加隧道，并自行承担令牌保管 |
| 不发独立 npm 包 | 共识口径是随包发 stdio 桥脚本；`npx` 形态留待需要时再评估 |

## 6. 自检与回归

```bash
node scripts/build-mcp-contract.mjs --check   # 契约与插件参数表是否漂移（冒烟同口径）
node scripts/probe-mcp-server.mjs             # 服务端 + 协议面 + 版本闸 + 审计（假渲染层）
node scripts/probe-mcp-stdio.mjs              # stdio 桥端到端（真子进程）
node test/smoke-mcp-server.js                 # 契约 / 接线 / 渲染层钩子 / 面板 的静态与逻辑回归
node test/smoke-mcp-self-loop.js              # 自用回环真跑：query 令牌 / 回环注册 / 作业表 / 媒体执行体（假后端）
node test/smoke-mcp-stdio-discovery.js         # stdio 桥的**默认发现路径**（临时 APPDATA + 真子进程，不设 MTNODE_DATA_DIR）
node test/smoke-mcp-version-gate.js           # 版本闸哈希真跑（与 detail 档位解耦 + 真改必变）
node mcp-stdio.js --print-config              # 打印客户端配置片段与当前地址
```

应用内还有一键**自检**（面板「服务端」页 → 自检）：真走一遍 `initialize → tools/list → tools/call mtnode_canvas_get`。

### 6.1 干净环境全量端到端（真应用 + 真渲染层 + 真 stdio 客户端）

上面几只是单模块 / 假宿主；要验「第三方客户端接进来真的能用」，用 `scripts/e2e-mcp-full.mjs`：
起一个**独立数据目录**的 MTNode，再用**真子进程**拉起 `mcp-stdio.js` 逐条按 MCP 协议打全部工具 /
资源 / 提示词，每步实时打印（可 `Tee-Object` 出来看过程），末尾落一份 JSON 报告。

```powershell
# 1) 干净环境：独立数据目录（不碰 %APPDATA% 的真实数据；数据目录 = <根>\pipeline-console）
$env:MTNODE_DATA_DIR = "E:\tmp\mtnode-mcp-e2e"
& .\node_modules\electron\dist\electron.exe .

# 2) 另一个终端：跑全量（74 项）
node scripts/e2e-mcp-full.mjs --data "E:\tmp\mtnode-mcp-e2e\pipeline-console" --report "E:\tmp\e2e-report.json"
```

覆盖：端口/令牌落盘与桥自解析、`/meta` `/health` 免令牌与 401、13 个工具的 `tools/list`、
2+3 资源、3 份提示词、协议级错误面（未知方法 / 未导出工具 / 参数类型 / 枚举越界）、
`canvas_get` 三档 detail 与 `sections`、`canvas_edit` 建连改分组绘制 + 版本闸（过期 baseHash 被拒、
写后哈希刷新、**哈希与 detail 档位无关**）、`mtnode_app` 六种动作、`mtnode_facts` / `mtnode_db` /
`mtnode_assets` / `mtnode_vision` 四族回执、并发双连接、审计账目、`--print-config` 自适应。

> 干净环境的边界（如实，不是缺陷）：AI 事实库要「画布文件夹」、素材库要「指定根目录」、
> 数据库要接 `db_replica` —— 这些前置没配时四个工具族一律回**明确原因**
> （而不是挂死或空回执），端到端脚本按「合格边界」记一条并继续；配好前置即走真往返。
> 识图**不再要求单独配「视觉模型」**：默认按当前模型直跑，模型真不吃图时由回执把上游原因
> 如实带出来（会话里写作「当前模型不支持图片输入：…」），而不是提前拦死。

## 7. 排障对照

| 现象 | 成因 / 处置 |
| --- | --- |
| 桥报「连不上 MTNode MCP 服务端」 | MTNode 没开着，或重启后端口变了（桥每次调用都重读 `mcp-server.json`，打开 MTNode 即可） |
| 桥报「找到数据目录，但 MCP 服务端没在跑」 | 端口没落盘 / `enabled:false`：面板「服务端」页看开关与状态；端口由服务端每次启动写入 `mcp-server.json`，`port:0` = 没在监听 |
| 桥报「找不到 …运行信息」，但 MTNode 明明开着 | 数据目录不一致。桥按这个顺序找 `mcp-server.json`：`$MTNODE_DATA_DIR`（+`pipeline-console` 子目录）→ `<应用数据根>\pipeline-console`（**默认数据目录就是这一层**：`%APPDATA%\pipeline-console\pipeline-console`）→ `data-root.json` 指定的自定义数据目录 → 应用数据根（旧版位置）。报错会把**逐个候选探活的结果**列出来（每个候选的路径、端口、死活与连不上原因），照着比对即可；仍不一致就显式给 `MTNODE_DATA_DIR` 或 `MTNODE_MCP_URL` + `MTNODE_MCP_TOKEN` |
| 同时开着多个 MTNode（共用同一个数据目录），桥连到的端口不对 | `mcp-server.json` 里**没有 pid**，而且每个实例都会**无条件覆盖**它（启动即 `saveState()`）：后启动的那个把自己的端口写进去，先启动的实例就对不上了。排障先**绕开自动发现** —— 给客户端设 `MTNODE_MCP_URL` + `MTNODE_MCP_TOKEN` 显式指定真正在监听的那个地址与令牌；只留一个实例最干净 |
| 桥报 `fetch failed` | 那是「采纳了一个已经死掉的端口」的表现（状态文件是旧进程 / 另一个实例留下的）。桥的报错会把**逐个候选探活的结果**列出来（哪个目录、哪个端口、连不上的原因）—— 按这份候选清单逐条核对端口死活：目录不对就显式给 `MTNODE_DATA_DIR`，端口不对就用 `MTNODE_MCP_URL` + `MTNODE_MCP_TOKEN` 指定；先确认没开多个实例（见上一行） |
| HTTP 401 | 令牌不对（被重置过 / 抄错）；重新复制配置片段 |
| 工具返回「画布已被改动（版本不一致）」 | 读图之后画布真被改过 → 重新 `mtnode_canvas_get` 拿新 `contentHash`。若**刚读完、什么都没改**就被拒：那是版本闸哈希的实现缺陷（曾出现「哈希随 detail 档位变」），跑 `node test/smoke-mcp-version-gate.js` 定位 |
| 工具返回「渲染层未回执（超时）」 | 主窗口被关掉 / 渲染层卡住；执行在渲染层，窗口不在就没人执行 |
| 工具**一直不返回**（客户端干等到超时） | 渲染层没收口这次调用。历史成因：`db` / `facts` / `asset` 三族的回执曾走 `dshInteract`（只认自家在跑的轮），第三方帧的结果写给没人认领的 id —— 现已改为交回 MCP 通道，回归见 `test/smoke-mcp-server.js` |
| 工具返回「本轮不导出 …」 | 调了边界外的工具（`browser_*` 或引擎自带工具） |
| 客户端看不到工具 | 先看面板自检；再看是否 `initialize` 被拒（协议版本）；最后开抓包看原始帧 |
| 审计里只有一部分调用 | 现在不会了：校验失败 / 未知工具同样入账（早期版本只记成功路径，已修） |

## 8. 关键文件

| 路径 | 作用 |
| --- | --- |
| `dsh/gateway/mcp-extra-plugin.mjs` | 回环四件的契约真源（`defineTool` 参数表） |
| `mcp-server.js` | 主进程 MCP 服务端（HTTP / 协议分发 / 排队 / 版本闸 / 审计 / 抓包 / 自检 / 作业表 / 自用回环注册） |
| `mcp-gui-agent.js` | `mtnode_gui` 的执行器（主进程直接操作窗口：注入脚本 + `capturePage` 截图） |
| `mcp-media-agent.js` | `mtnode_generate` 的执行器（图像 / 语音 / 音乐 / 视频四路，共用全局互斥锁；产物 stat + 归档素材库） |
| `mcp-stdio.js` | stdio 桥（只转发；`--print-config` / `--check`） |
| `mcp-prompts.js` | prompts 模板正文 |
| `mcp-tools.json` / `mcp-tool-schemas.js` | 生成的契约快照与参数校验表（**禁止手改**） |
| `scripts/build-mcp-contract.mjs` | 契约生成器（真跑插件 `apply()` 抓 `defineTool` 规格） |
| `scripts/probe-mcp-server.mjs` / `scripts/probe-mcp-stdio.mjs` | 可跑探针 |
| `scripts/e2e-mcp-full.mjs` | 干净环境全量端到端（真应用 + 真 stdio 客户端，逐条实时打印 + JSON 报告） |
| `renderer/mcp-bridge.js` | 渲染层执行桥（帧 → 既有宿主处理函数 → 回执） |
| `renderer/mcp-extra.js` | 回环四项的执行体：跑节点 / 跑整图 / 用户工具 / 会话任务 / 建媒体节点（`window.MTNodeMcpExtra`） |
| `renderer/app-plugins.js` | 「扩展能力管理 → 服务端」页 |
| `test/smoke-mcp-server.js` | 回归：契约 / 接线 / 帧的生命周期 / 三族回执通道 / 面板 |
| `test/smoke-mcp-stdio-discovery.js` | 回归：stdio 桥的**默认发现路径**（打包态 `%APPDATA%\pipeline-console\pipeline-console` 布局、`data-root.json` 自定义数据目录、`MTNODE_DATA_DIR` 两种写法） |
| `test/smoke-mcp-version-gate.js` | 回归：版本闸哈希与 detail 档位解耦、真改必变 |
| `test/smoke-mcp-self-loop.js` | 回归：query 令牌、回环注册回调、作业表语义、媒体执行体（真 HTTP，假生成后端） |
