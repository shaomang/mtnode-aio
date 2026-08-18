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

## 本地协议(main.js ↔ gateway)

换行分隔 JSON;主进程发 `{id, method, params}`,gateway 回 `{id, ok, result|error}`
以及无 id 的 `{event: {type, ...}}`。

| method | params | 语义 |
|---|---|---|
| `status` | — | `{gateway, node, runtimes, runtimeBin, configPath}` 健康与版本 |
| `run` | `{workspace, input, model?, maxTokens?, apiKey?, baseUrl?, systemPrompt?, preset?, effort?, provider?, mtnodeProviders?, permissionPreset?}` | 排队一条提示,流式事件直至整轮 idle |
| `cancel` | `{workspace}` | 关闭该 workspace 的全部运行时(在途 run 以错误收束) |
| `interact` | `{kind:'question'\|'approval'\|'canvas', id, answers?\|outcome?\|result?}` | 回答提问 / 审批 / 画布工具结果,按交互 id 路由回对应运行时 |
| `providerCatalog` | — | `{deepseek:[…], piai:[…]}` 服务商/模型目录(pi-ai 同源) |
| `pluginList` / `pluginAdd` / `pluginRemove` / `pluginEnable` / `pluginDisable` | `{pkg, id?}` 等 | 读取/安装/移除/挂载/卸载 cordis.yml 插件。`pluginList` 每项含 `title`/`description`/`purpose`/`version`(来自 package.json、preset.yml、行上注释)。核心运行时行只读;非核心(用户插件、套装、可选 shipped 行)可在设置中挂载/卸载;变更后重启运行时 |
| `mcpList` / `mcpAdd` / `mcpRemove` / `mcpSetEnabled` | `{serverName, …}` | MCP 服务器管理(cordis 用户段,变更后重启运行时) |
| `shutdown` | — | 关闭全部运行时并退出 gateway |

`run` 的事件:`reasoning`(思考增量)、`text`(正文增量)、`tool`(工具调用
`{name, args}`)、`status`(`{state}`)、`question`(模型提问,`{id, sessionId,
questions}`)、`approval`(越权审批,`{id, sessionId, toolName, callId?, reason?}`)、
`canvas`(画布/应用读写,`{id, op:'get'|'edit'|'app', params}` —— 渲染层执行后经 `interact`
`kind:'canvas'` 回传结果)、`session-event`(其余会话事件全量透传)、`usage`、`title`、
`error`、`done`(`{finalResponse, metrics}`)。所有事件带 `reqId`,对应一次 `run`。

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

- 插件 = npm 包名 / GitHub 地址 / 本地路径 + cordis.yml 追加行。设置面板提供列表/
  添加/移除;非核心插件(用户安装、bundled 套装、可选 shipped 行)可 **挂载 / 取消挂载**,
  核心运行时行只读。gateway 用捆绑 pnpm 在 `dsh/gateway/` 安装,成功后重启运行时。
- 已内置 [dsh-routing-suite](https://github.com/yjh051108/dsh-routing-suite):
  注入器(`./plugins/dsh-super-injector/lib/index.js`)默认挂载;router-standard 默认挂载
  (assemble 永不抛错,保留 MTNode persona 与 `mtnode_*` 工具);router-spec
  默认卸载(与 standard 互斥)。
  见 `dsh/gateway/plugins/README.md`。
- 高级用户可直接编辑 cordis.yml(只读展示 + 复制路径)。
- 插件声明自己不保证 rc 版本兼容;安装失败回滚 package.json 与 cordis.yml。

### 内置画布插件(mtnode-canvas)

运行时组合固定挂载 `dsh/gateway/canvas-plugin.mjs`,向模型暴露三个工具:

| 工具 | 作用 |
|---|---|
| `mtnode_canvas_get` | 读取当前工作流:节点(id/kind/标题/坐标/提示词摘要)、连线、组、相机、视图、全部工作流列表 |
| `mtnode_canvas_edit` | 批量创建/改标题与字段/连线/@引用补全/成组/删除;默认分层从左到右排版且不与已有节点重叠 |
| `mtnode_app` | 应用级操作:居中/聚焦节点、切换视图、切换/新建/重命名/删除工作流、选中节点、撤销重做。删除工作流与图编辑在全局助手侧需用户确认 |
| `mtnode_vision` | 识图子代理:对本地绝对路径图片调用视觉模型作答;首次需用户许可(允许一次/始终允许/拒绝) |

渲染层 `applyCanvasOp` 是唯一写画布的地方:校验节点类型与回路、拒绝删除正在运行的节点、一次编辑一条撤销记录。典型任务(「实现物品配置工作流」)由模型一次 `edit` 创建「需求 → 生成 → 写入配置表」管道,用户可继续改提示词并点 ▶ 运行。

右上角「审批」另有 **Agent 工具许可预设**(与 `permissionPreset` 正交):按类别开关画布读/节点/控制/绘图/排版、应用操作、引擎基础能力、识图。内置 `default` 预设为当前产品能力全开;用户可克隆自定义。`applyCanvasOp` / `applyAppOp` / `applyVisionInspect` 对画布/应用/识图做硬拦截;读文件/终端/联网等经 `dshRunTask` 注入系统提示约束。

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
