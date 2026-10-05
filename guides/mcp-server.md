# MTNode MCP 服务端 · 接入指南

> 面向第三方开发者：怎么把 Claude Code / Cursor / 自研 Agent 接到本机 MTNode 上。
> 面向用户的那一版在应用内手册 `guides/manual/mcp-server.md`；本文件是工程口径（含协议细节与排障）。
> 机器可读契约：[`../mcp-tools.json`](../mcp-tools.json)（生成物，禁止手改）。

## 1. 这是什么

MTNode 原本只做 MCP **客户端**（`dsh/gateway/mcp-resources.mjs` 连别人的服务器，给自家 Agent 加工具）。
本模块补上另一半：MTNode 自己作为 MCP **服务端**，对外暴露画布 / 应用 / 数据库 / 事实库 / 长任务 / 素材 / 识图能力。

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
  │ window.api.mcpInteract
  ▲ 原路回执
```

于是「第三方调用」与「自家 Agent 调用」共用同一套准入、落盘、告警与回执口径。

## 2. 快速接入

### 2.1 stdio（推荐，多数本地客户端）

面板「设置 → 扩展能力 → 管理… → 服务端 → 复制配置片段」给出的就是这一段：

```json
{
  "mcpServers": {
    "mtnode": {
      "command": "node",
      "args": ["<repo-root-or-install-dir>/mcp-stdio.js"]
    }
  }
}
```

- macOS / Linux 同上（路径换成实际安装位置）。
- 桥脚本自己读数据目录里的 `mcp-server.json` 拿端口与令牌，所以**配置里不需要地址与令牌**；
  也可用环境变量显式覆盖（便携版 / 多用户）：`MTNODE_DATA_DIR`、`MTNODE_MCP_URL`、`MTNODE_MCP_TOKEN`。
- 需要 Node ≥ 18（脚本只用 `fetch` 与内置模块；MTNode 自身用的受管 Node 也满足）。
- 客户端重启一次即可看到 8 个工具。

### 2.2 本机 HTTP（自研客户端 / 远程工具宿主）

```bash
curl -s http://127.0.0.1:<port>/mcp \
  -H 'content-type: application/json' \
  -H "authorization: Bearer <token>" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

- 端口与令牌：面板里可见；`%APPDATA%\pipeline-console\mcp-server.json` 里也可读。
- 只绑 `127.0.0.1`，不对外网开放。
- 另有两个只读辅助端点：`GET /meta`（健康与能力摘要，**不需要令牌**，不含令牌本身）、`GET /health`。
- 给 stdio 桥用的扁平控制面 `POST /ctl`（`{method, params}` → `{ok, result|error}`），第三方一般不需要它。

### 2.3 各客户端的落点（供参考，以官方文档为准）

| 客户端 | 配置文件 |
| --- | --- |
| Claude Code | 项目内 `.mcp.json` 或用户级 MCP 配置的 `mcpServers` 段 |
| Cursor | 「Settings → MCP」里粘贴同一段 `mcpServers` |
| 自研 Agent | 直接实现 HTTP 传输，或 `spawn('node', ['mcp-stdio.js'])` 走 stdio |

## 3. 协议面

- 协议版本：`2025-06-18`（也接受 `2025-03-26` / `2024-11-05` 的握手，回以自己支持的那一版）。
- 传输：Streamable HTTP 的 JSON 响应形态（`POST /mcp`，`initialize` 回 `Mcp-Session-Id` 头）；
  通知（`notifications/*`）回 `202`、无体。stdio 侧是换行分隔 JSON-RPC。
- 能力位：`tools`（8 个，`listChanged:false`）、`resources`（2 个静态 + 3 个模板）、`prompts`（3 份）、`logging`。
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

参数表的**唯一真源**是 `dsh/gateway/*-plugin.mjs` 的 `defineTool` 参数表；`mcp-tools.json`
由 `scripts/build-mcp-contract.mjs` 真实执行插件模块抓取并编译成 JSON Schema，
`test/smoke-mcp-server.js` 钉住「重跑生成器结果一致」。

### 3.2 MCP 侧路由参数（**不在**插件参数表里，只属于 MCP 面）

| 参数 | 适用 | 语义 |
| --- | --- | --- |
| `canvas` | 画布 / 数据库 / 事实库 / 长任务族 | 目标画布：id、精确名称，或 `current`（默认）。省略 = 当前打开的画布 |
| `baseHash` | `mtnode_canvas_edit`、`mtnode_app` 的写动作 | 上一次 `mtnode_canvas_get` 回执里的 `contentHash`；不一致 → 本次修改被拒 |

这两个参数在服务端被摘出来（不下发给渲染层的插件处理函数）。

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
| 不把媒体生成做成独立工具 | 文生图 / 音乐 / 语音 / 视频是画布节点；MCP 负责建与连线，运行由用户点 |
| 不做局域网 / 公网绑定 | 共识口径是只绑回环；需要远程接入请自行加隧道，并自行承担令牌保管 |
| 不发独立 npm 包 | 共识口径是随包发 stdio 桥脚本；`npx` 形态留待需要时再评估 |

## 6. 自检与回归

```bash
node scripts/build-mcp-contract.mjs --check   # 契约与插件参数表是否漂移（冒烟同口径）
node scripts/probe-mcp-server.mjs             # 服务端 + 协议面 + 版本闸 + 审计（假渲染层）
node scripts/probe-mcp-stdio.mjs              # stdio 桥端到端（真子进程）
node test/smoke-mcp-server.js                 # 契约 / 接线 / 渲染层钩子 / 面板 的静态与逻辑回归
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

覆盖：端口/令牌落盘与桥自解析、`/meta` `/health` 免令牌与 401、8 个工具的 `tools/list`、
2+3 资源、3 份提示词、协议级错误面（未知方法 / 未导出工具 / 参数类型 / 枚举越界）、
`canvas_get` 三档 detail 与 `sections`、`canvas_edit` 建连改分组绘制 + 版本闸（过期 baseHash 被拒、
写后哈希刷新、**哈希与 detail 档位无关**）、`mtnode_app` 六种动作、`mtnode_facts` / `mtnode_db` /
`mtnode_assets` / `mtnode_vision` 四族回执、并发双连接、审计账目、`--print-config` 自适应。

> 干净环境的边界（如实，不是缺陷）：AI 事实库要「画布文件夹」、素材库要「指定根目录」、
> 数据库要接 `db_replica`、识图要视觉模型 —— 这些前置没配时四个工具族一律回**明确原因**
> （而不是挂死或空回执），端到端脚本按「合格边界」记一条并继续；配好前置即走真往返。

## 7. 排障对照

| 现象 | 成因 / 处置 |
| --- | --- |
| 桥报「连不上 MTNode MCP 服务端」 | MTNode 没开着，或重启后端口变了（桥每次调用都重读 `mcp-server.json`，打开 MTNode 即可） |
| 桥报「找到数据目录，但 MCP 服务端没在跑」 | 端口没落盘 / `enabled:false`：面板「服务端」页看开关与状态；端口由服务端每次启动写入 `mcp-server.json`，`port:0` = 没在监听 |
| 桥报「找不到 …运行信息」，但 MTNode 明明开着 | 数据目录不一致：桥按 `$MTNODE_DATA_DIR` →（+`pipeline-console` 子目录）→ `%APPDATA%\pipeline-console` 顺序找；便携版请显式设 `MTNODE_DATA_DIR` 或 `MTNODE_MCP_URL` + `MTNODE_MCP_TOKEN` |
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
| `mcp-server.js` | 主进程 MCP 服务端（HTTP / 协议分发 / 排队 / 版本闸 / 审计 / 抓包 / 自检） |
| `mcp-stdio.js` | stdio 桥（只转发；`--print-config` / `--check`） |
| `mcp-prompts.js` | prompts 模板正文 |
| `mcp-tools.json` / `mcp-tool-schemas.js` | 生成的契约快照与参数校验表（**禁止手改**） |
| `scripts/build-mcp-contract.mjs` | 契约生成器（真跑插件 `apply()` 抓 `defineTool` 规格） |
| `scripts/probe-mcp-server.mjs` / `scripts/probe-mcp-stdio.mjs` | 可跑探针 |
| `scripts/e2e-mcp-full.mjs` | 干净环境全量端到端（真应用 + 真 stdio 客户端，逐条实时打印 + JSON 报告） |
| `renderer/mcp-bridge.js` | 渲染层执行桥（帧 → 既有宿主处理函数 → 回执） |
| `renderer/app-plugins.js` | 「扩展能力管理 → 服务端」页 |
| `test/smoke-mcp-server.js` | 回归：契约 / 接线 / 帧的生命周期 / 三族回执通道 / 面板 |
| `test/smoke-mcp-version-gate.js` | 回归：版本闸哈希与 detail 档位解耦、真改必变 |
