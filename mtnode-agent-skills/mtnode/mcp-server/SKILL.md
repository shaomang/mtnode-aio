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
- **运行信息**：**数据目录**（默认 `%APPDATA%\pipeline-console\pipeline-console`；`main.js` 里 `userData = appData\pipeline-console`，数据目录是它下面的 `pipeline-console` 子目录，设置里改过「配置数据目录」则看 `data-root.json` 的 `path`）的 `mcp-server.json` = `{enabled, token, port, clientId, capture}`；stdio 桥与脚本都从这里发现服务端，不需要手填地址。桥的候选顺序：`$MTNODE_DATA_DIR`（+`pipeline-console` 子目录）→ `<应用数据根>\pipeline-console`（默认数据目录）→ `data-root.json` 指向的自定义数据目录 → 应用数据根（旧版位置）。
- **两种传输，同一个服务端**：
  - **stdio**：客户端配 `"command": "<MTNode 安装目录>\\MTNodeAIO.exe"` + `"args": ["<…>\\resources\\mcp-stdio.js"]` + `"env": { "ELECTRON_RUN_AS_NODE": "1" }`。**打包态的 `command` 是 Electron 二进制（不是 Node）：只有带上这条 env 才会以 Node 模式跑桥脚本，漏了它会再拉起一个 MTNode 实例且零 JSON-RPC**（`GET /meta` 与面板片段已把 env 一并给出）；开发态 `command` 是真 Node，不带 env。用系统 `node` 亦可（`command` 换 `node`、去掉 env，≥ 18）。桥只做 stdio ↔ HTTP 转发，执行仍在主进程 → 渲染层；面板「复制配置片段」与 `GET /meta` 的 `stdioCommand` 是同一口径。
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
| `mtnode_gui` | 驱动 MTNode 窗口：认元素 / 点 / 输入 / 按键 / 滚动 / 等待 / 读结构 / 窗口截图 | 是 |

**参数表真源**：`dsh/gateway/{canvas,db,ai-facts,longtask,assets,gui}-plugin.mjs` 里的 `defineTool` 参数表 —— 不在这里抄第二份。要完整 schema：`tools/list`，或读仓里生成的 `mcp-tools.json`（`node scripts/build-mcp-contract.mjs` 重新生成）。

**`mtnode_gui` 是唯一在主进程执行的一族**（只有主进程拿得到 `BrowserWindow`）：它点的是页面里真实的 DOM 元素（不是屏幕坐标），所以窗口不必在前台。`which` 选窗（`main` / `install` / `any` / 标题子串），`target` 五种写法（`css` / `text` / `title` / `role` / `ref`）。**够不着的**：原生菜单、系统文件选择框、托盘菜单、最小化窗口的截图、任何凭据输入 —— 这些会明确报错，别反复重试。

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
- **媒体生成不是独立工具**：文生图 / 音乐 / 语音 / 视频是画布**节点**（`proc_image` / `music_gen` / `breeze_gen` / `video_gen`）。第三方能做的是把节点建好、连好、写好提示词与输出路径；要真跑起来就**用 `mtnode_gui` 点那一下运行**（与自家 Agent 一致，音视频另有全局互斥锁）。
- **不替人做判断**：需要用户在界面上点的动作（选择节点高亮、撤销重做这类依赖前台画布的动作）在目标画布不是前台时会被拒 —— 先把画布切到前台，或改用不依赖前台的动作。

## 七、自家开发会话怎么用 MCP 自验（改 MTNode 时就该这么做）

MTNode 自己的开发会话（开发节点绑定会话、助手）跑在应用里，但**可以当外部客户端用**：仓库里有一把零依赖驱动 `tools/mtnode-gui.mjs`，它自己读数据目录的 `mcp-server.json` 拿端口与令牌，直连本机服务端（`POST /ctl`）——不必自己写 MCP 客户端，也不必走 stdio 桥。

```bash
node tools/mtnode-gui.mjs discover   --data <数据目录>            # tools/list + health + hasGui
node tools/mtnode-gui.mjs gui outline --data <数据目录>            # 读界面结构（元素带 ref）
node tools/mtnode-gui.mjs gui click  --target '{"text":"开始"}' --data <数据目录>
node tools/mtnode-gui.mjs gui screenshot --args '{"path":"<证据目录>\\shots\\01.png"}' --data <数据目录>
node tools/mtnode-gui.mjs call <工具名> --args '<JSON>' --data <数据目录>
```

（PowerShell / cmd 会吞掉 `--args '{"…"}'` 的引号：改用环境变量 `MTNODE_GUI_ARGS`。退出码：`0` = 回执 ok，`2` = 回执 `ok:false`（错误文本照打），`1` = 用法 / 环境错误。）

**纪律**：验证要**起一只属于自己的实例**（独立 `MTNODE_DATA_DIR`），**不驱动用户正在用的那只实例、不占默认数据目录**；起实例 → 握手 → 真读真点 → 截图读像素 → 留可复核证据，这套完整口径在技能 **mtnode-verify-in-app**，改 MTNode 自身功能时照它做。

## 八、自检与排障

```bash
# 从仓库/安装目录跑（不接外部客户端，自己验整链）
node scripts/probe-mcp-server.mjs      # 服务端 + 协议面 + 假渲染层
node scripts/probe-mcp-stdio.mjs       # stdio 桥端到端
node test/smoke-mcp-stdio-discovery.js # 桥的**默认发现路径**（临时 APPDATA + 真子进程，不设 MTNODE_DATA_DIR）
node scripts/build-mcp-contract.mjs --check   # 契约与插件参数表是否漂移
node mcp-stdio.js --print-config       # 打印客户端配置片段与当前地址
node mcp-stdio.js --check              # 只验证「能否连上服务端」
```

界面里还有一键**自检**（「服务端」页），它真读一次画布 —— 绿了就说明「主进程 → 渲染层 → 既有执行器」这条链路是通的。

| 现象 | 先看哪里 |
| --- | --- |
| 401 | 令牌不对（重置过？）—— 重新复制配置片段 |
| 「找不到运行信息」但 MTNode 明明开着 | 数据目录不一致：看 `--check` 报错里**逐个候选探活的结果**（每个候选的路径、端口、死活与连不上原因），比对 `mcp-server.json` 实际在哪（默认 `%APPDATA%\pipeline-console\pipeline-console`）；仍不一致才用 `MTNODE_DATA_DIR` / `MTNODE_MCP_URL` + `MTNODE_MCP_TOKEN` 显式指定 |
| 「画布已被改动」 | 有人在你读图之后改过：重新 `canvas_get` 再改 |
| 调用超时 | 主窗口是不是关掉了；渲染层在不在 |
| 工具「本轮不导出」 | 那是会话浏览器 / 引擎自带工具，本轮确实不开 |
| 想看清客户端发了什么 | 面板里打开「原始 JSON-RPC 抓包」再复现 |
