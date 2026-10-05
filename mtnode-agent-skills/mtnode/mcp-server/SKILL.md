---
name: mtnode-mcp-server
title: MTNode MCP 服务端（第三方接进来操作）
description: 从 MTNode 外面（Claude Code / Cursor / 自研 Agent）经 MCP 操作本机 MTNode 的完整规范：服务端在哪、8 个工具各自怎么用、必须先读图拿 contentHash 再改、resources/prompts 三类能力、权限与审计口径、以及做不到的事（长任务人工环节 / 媒体生成仍要人在界面上点）。Use when connecting an external MCP client to MTNode, debugging third-party calls, or writing code that drives MTNode over MCP.
---

# MTNode MCP 服务端

MTNode 平时是 MCP **客户端**（去连别人的服务器给自家 Agent 加工具）。这一条讲反方向：MTNode 自己开一个 MCP **服务端**，让外面的客户端连进来操作这台机器上的 MTNode。

**什么时候用它**：你要从 MTNode 外面驱动画布（Claude Code 里说「把这张图接上保存节点」）、要把 MTNode 接进自己的自动化流水线、或第三方调用报错要定位。

## 一、怎么连

- **服务端**：主进程里的 `mcp-server.js`，只绑 `127.0.0.1`、随机端口、Bearer 令牌；默认开启。开关与地址/令牌在「设置 → 扩展能力 → 管理… → 服务端」页。
- **运行信息**：数据目录（`%APPDATA%\pipeline-console`）的 `mcp-server.json` = `{enabled, token, port, clientId, capture}`；stdio 桥与脚本都从这里发现服务端，不需要手填地址。
- **两种传输，同一个服务端**：
  - **stdio**：客户端配 `node <应用根>/mcp-stdio.js`（桥只做 stdio ↔ HTTP 转发，执行仍在主进程 → 渲染层）。
  - **HTTP**：`POST http://127.0.0.1:<port>/mcp`，头带 `Authorization: Bearer <token>`。
- MTNode 没开着 → 桥会回「连不上 MTNode MCP 服务端，请打开 MTNode 后重试」；主窗口被关掉 → 调用会超时（执行在渲染层，窗口不在就没人执行）。

## 二、工具面（8 个，与自家 Agent 同名同义）

| 工具 | 干什么 | 写 |
| --- | --- | --- |
| `mtnode_canvas_get` | 读画布：节点索引 / 配置 / 正文 / 连线 / 绘制 | 否 |
| `mtnode_canvas_edit` | 建节点、连线、改字段、分组、绘制、删除 | 是 |
| `mtnode_app` | 应用级：状态、画布列表、改名、选中、撤销重做、导出 PNG、长任务图存取、DSH 插件管理 | 部分 |
| `mtnode_db` | 数据库副本查询（list / get / query / write / delete / calc） | 部分 |
| `mtnode_facts` | 本画布的 AI 事实库（极简条例库） | 部分 |
| `lt_state` | 长任务本轮共享状态 | 是（限环节内） |
| `mtnode_assets` | 素材库：清单 / 读条目 / 窗口静帧截图 | 否 |
| `mtnode_vision` | 识图子代理（读本机图片像素） | 否 |

**参数表真源**：`dsh/gateway/{canvas,db,ai-facts,longtask,assets}-plugin.mjs` 里的 `defineTool` 参数表 —— 不在这里抄第二份。要完整 schema：`tools/list`，或读仓里生成的 `mcp-tools.json`（`node scripts/build-mcp-contract.mjs` 重新生成）。

**多画布**：省略 `canvas` = 当前打开的画布；要动其它画布就传画布 **id 或精确名称**（清单见资源 `mtnode://canvases`）。解析不到会有明确错误（含「名字有歧义」这一种）。

**不导出的**：dsh 引擎自带的通用工具（文件读写 / 命令执行 / 联网搜索）与 `browser_*`（13 个会话浏览器工具）。调用它们会回一句说明原因，不是「未知工具」的模糊报错。

## 三、改画布的硬规矩（唯一真源是画布编辑技能）

1. **先读再改**：`mtnode_canvas_get` 的 `contentHash` → 原样作为 `baseHash` 传给 `mtnode_canvas_edit`（或 `mtnode_app` 的写动作）。
2. 哈希对不上 = 期间有人改过这张图 → **调用被拒**，重新读一遍再改（不做半截修改）。
3. 一次调用把这一批改完（`create` + `connect` + `update` 可以同批）；回执自足（含 x/y/w/h、端口占用、warnings），不要为核对再整图重读。
4. 一次连接同一时刻只有一笔写（服务端排队），读并发。

建图 / 连线 / 批次的**完整硬规则**（kind 速查、task 三端、super 边界端子、tool/function 参数即端子、@引用三条件、save 与 wait_file、批次与文生图）在技能 `mtnode-canvas-edit-rules`，也可以直接读资源 `mtnode://skill/mtnode-canvas-edit-rules` —— 动手前读它，别凭记忆建图。

## 四、resources 与 prompts

- `mtnode://canvases` 画布清单 · `mtnode://skills` 内置技能清单
- `mtnode://canvas/{canvas}/snapshot` 画布快照（默认 minimal 档）
- `mtnode://canvas/{canvas}/node/{node}` 单节点正文（`detail:"full"`）
- `mtnode://skill/{name}` 内置技能正文（Markdown）
- prompts：`takeover-canvas`（接手画布）、`build-workflow`（建工作流）、`review-canvas`（只读审阅）—— 模板里已经写好「先读图、再动手、收尾自证」这套纪律。

## 五、权限、并发与审计

- **首次连接授权即全量读写**：令牌对就能改画布，不逐笔弹确认框。收回方式 = 关总开关 / 重置令牌。
  - 实现口径：`renderer/mcp-bridge.js` 在每次调用期间把 `S._mcpAuthorized` 置真（跑完立刻复原），`app-nodes.js` 的 `canvasOpNeedsConfirm` 与 `ensureAgentTool` 认这个开关。**用户自己的会话 / 助手 / 智能节点不受影响**。
- **审计**：数据目录 `mcp-audit/mcp-YYYY-MM-DD.jsonl`，按天轮转保留 7 天；每条含 `ts / session / client / tool / canvas / ms / ok / error / args(200 字)`，**被拒的调用也记**。面板「最近调用」读它；排障时可打开「原始 JSON-RPC 抓包」（最近 200 条，仅内存）。

## 六、做不到的事（如实，别让客户端白试）

- **长任务的人工环节**：`lt_state` 只在长任务的 Agent 环节内部有归属（那一步声明了可写键）；MCP 连接不在任何环节里，`write` 会被拒。看 / 改长任务图用 `mtnode_app` 的 `get_longtask` / `update_longtask` / `create_longtask`；**启用运行、推进、审批交付由人在条带上操作**。
- **媒体生成不是独立工具**：文生图 / 音乐 / 语音 / 视频是画布**节点**（`proc_image` / `music_gen` / `tts_gen` / `video_gen`）。第三方能做的是把节点建好、连好、写好提示词与输出路径；真正执行由用户点运行（与自家 Agent 一致，音视频另有全局互斥锁）。
- **不替人做判断**：需要用户在界面上点的动作（选择节点高亮、撤销重做这类依赖前台画布的动作）在目标画布不是前台时会被拒 —— 先把画布切到前台，或改用不依赖前台的动作。

## 七、自检与排障

```bash
# 从仓库/安装目录跑（不接外部客户端，自己验整链）
node scripts/probe-mcp-server.mjs      # 服务端 + 协议面 + 假渲染层
node scripts/probe-mcp-stdio.mjs       # stdio 桥端到端
node scripts/build-mcp-contract.mjs --check   # 契约与插件参数表是否漂移
node mcp-stdio.js --print-config       # 打印客户端配置片段与当前地址
node mcp-stdio.js --check              # 只验证「能否连上服务端」
```

界面里还有一键**自检**（「服务端」页），它真读一次画布 —— 绿了就说明「主进程 → 渲染层 → 既有执行器」这条链路是通的。

| 现象 | 先看哪里 |
| --- | --- |
| 401 | 令牌不对（重置过？）—— 重新复制配置片段 |
| 「画布已被改动」 | 有人在你读图之后改过：重新 `canvas_get` 再改 |
| 调用超时 | 主窗口是不是关掉了；渲染层在不在 |
| 工具「本轮不导出」 | 那是会话浏览器 / 引擎自带工具，本轮确实不开 |
| 想看清客户端发了什么 | 面板里打开「原始 JSON-RPC 抓包」再复现 |
