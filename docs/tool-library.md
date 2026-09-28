# 工具库（Tool Library）设计文档

> 状态：已实现（渲染层 `renderer/app-tools.js` · 主进程 `tools-store.js`）
> 配套契约：[docs/tool-function-nodes.md](./tool-function-nodes.md)（工具/函数节点数据模型）·
> [docs/func-call-chain.md](./func-call-chain.md)（Agent 工具调用链路）· 节点指南
> `guides/nodes/tool.md`。
> 应用内手册：`guides/manual/tools-functions.md`（英文 `guides/manual/en/tools-functions.md`，目录见 `guides/manual/index.json`）。

## 1. 概念与一句话

**工具库 = 跨画布可复用的「完整工具包」仓库**：把画布上一个工具节点（`super + tool:true`
变体或普通 `kind "tool"`，判定统一走 `isToolNode()`）连同它的**内部图 JSON 快照**存成一个
工具包，之后可在**任意画布插入**复用；库内每个工具另有一个 **「会话随时可调用」(`always`)**
开关（默认关），打开后智能会话不依赖画布副本即可直接调用该工具（消费方见
func-call-chain.md）。

- 渲染层没有 fs：列举 / 读取 / 保存 / 删除 / 改名 / 切开关全部经主进程 `tools-store.js`
  注册的 IPC（`preload.js` 白名单桥 `api.tools*`）。
- 落盘位置：`<数据目录>/tools/<id>.json`，与画布存档同根 `DATA()`，跟随「配置数据目录」迁移；
  每工具一文件，原子写沿用 `config-providers.js` 的 `readJson / writeJson`（tmp + rename）。

## 2. 工具包数据格式（唯一真源）

```
{
  id:          string   // "tl" + 时间戳36 + 随机串；正则 ^[A-Za-z0-9_-]{4,80}$
  name:        string   // 工具名（非空；重名覆盖由渲染层先确认，这里只按 id 落盘）
  description: string   // 用途说明（给 Agent / 人）
  inputs:      [{name, kind}]   // kind ∈ text | image，缺省 text（normParams 归一）
  outputs:     [{name, kind}]
  always:      boolean  // 「会话随时可调用」开关（默认 false；本模块只存不管语义）
  graph: { rootId, nodes:[...], wires:[...] }   // 内部图快照，插入画布即用
  createdAt / updatedAt: number
}
```

`tools:list` 返回的是**轻量列表**（id / name / description / inputs / outputs / always /
createdAt / updatedAt / nodeCount / wireCount，不含完整 graph）；插入与「随时可调用」执行时才
`tools:get` 取全量包。

## 3. IPC 契约（`tools-store.js` · `registerToolsIpc(opts)`）

| IPC | 入参 | 语义 |
|---|---|---|
| `tools:list` | — | 轻量列表，按 `updatedAt`（无则 `createdAt`）倒序 |
| `tools:get` | `id` | 全量工具包；id 非法 → `非法工具 id`；不存在 → `工具不存在` |
| `tools:save` | `pkg` | 新增或覆盖：`id` 已存在且合法 → 覆盖（保留原 `createdAt`，供「随时可调用」开关延续）；否则生成新 id。`name` 非空校验；参数表 `normParams` 归一 |
| `tools:delete` | `id` | 删除文件；不影响已插入画布的副本 |
| `tools:patch` | `{id, patch}` | 改名 / 改描述 / 切 `always`。**改名同步快照**：`patchGraphName` 把 graph 内根节点的 `toolConfig.name` 一并改掉，标题仍等于旧名（或空）时才跟随改名——与渲染层 `applyToolConfigName` 同口径 |

## 4. 渲染层流程（`app-tools.js`）

- **保存 `saveToolFromCanvas(node)`**：未命名先弹「工具名」输入；`toolPackageFromNode`
  抓完整包 = `toolConfig`（名称/描述/入出参数）+ 内部图快照（本节点 + 全部后代 + 两端都在
  集合内的连线；**跨画布专用外部连线不收录**）；同名工具已存在（且非本节点记忆的
  `toolLibId`）→ 确认后覆盖（保留原 id）；成功后写回 `node.toolLibId`（记住出处，再次保存 /
  改名更新同一份）并 `notifyUserToolsChanged()`。
- **插入 `insertToolToCanvas(pkg)`**：克隆（`cloneNodesDeep`，新 id / 标题唯一化 / 内部
  父子与连线按新 id 重建）、偏移到当前视野、按当前 task / super 焦点归属、记忆
  `toolLibId` 与 `toolAlways`、**工具壳默认折叠插入**（避免抢占画布）、可重复插入。
- **对话框 `openToolsLibrary()`**：顶栏「工具库」按钮（图标＝程序自己的图标 `renderer/app-icon.png`）
  → overlay「工具库」，打开后列出本机已保存的工具 / 函数包与**应用内置条目**（创建这两类节点的
  入口在画布右键菜单的「工具」一级菜单下）。结构 = 顶部
  「从当前画布保存」（下拉选画布工具节点 + 保存按钮）+ 中部库内工具行。每行：
  名称 / 入出参数摘要 / 内部节点与连线数 / **「会话随时可调用」开关** / 插入 / 改名 / 删除
  （内置条目带「内置」徽标，不给改名 / 删除，只有开关可切）。

## 4b. 应用内置条目（随包发版 · 不是用户数据）

真源：`renderer/preset-tools.json`（与 renderer 一起随包发；改它 = 改内置清单）。
`tools-store.js` 在 `tools:list` / `tools:get` 时现读现拼，**不往数据目录写副本**：

- 条目 id 统一 `builtin:<key>`（用户工具 id 走 `genId()` → `tl…`，两者永不冲突）；
- 条目带 `builtin: true`，清单里加「内置」徽标，改名 / 删除被拒（改随包文件下次升级就没了）；
- `always`（会话随时可调用）**工具条目**可切：清单里没被覆写过就按条目自己的 `always` 取值
  （工具条目可按需写 `true` 做「装好即默认开」），开关状态写
  `<数据目录>/tools/_builtin.json`（`{ "<key>": bool }`），`_builtin.json` 不以合法工具 id
  开头，`listTools()` 不会把它当工具读；
  **函数条目恒 false**（会话可调用链路跑的是工具节点的内部图，函数包没有那条执行路 ——
  与用户函数条目同一口径，渲染层也不给它这个开关）；
- 条目可带 `presets`（`{ 参数名: 字符串 }`）：渲染层 `insertToolToCanvas` 把预设写进该节点的
  **测试台快照**（`fnTestInputs` / `toolTestInputs`），用户插入后点「测试」就有能直接跑的样例值，
  绝不参与画布运行取数。

内置条目一：**屏幕 / 窗口截图**（函数包 `desktop-capture`）——`target` / `screen` / `window` /
`x` / `y` / `w` / `h` → 图像路径；实现侧见根目录 `desktop-capture.js` 与函数节点桥
`mtnode.screenShot` / `screenList` / `windowList`（`fn-runtime.js` + `main.js` 注入）。

内置条目二：**PDF 转 Markdown**（工具条目 `pdf-to-markdown`）——把本机 PDF 的文本层解析成
Markdown 正文，入参 `path`（本机 PDF 绝对路径）→ 出参 `markdown` / `pages` / `formulas` /
`warning`；只读、不落盘，加密件 / 扫描件按同一份内核给出明确错误或警告。它是**工具条目**
（`kind: "tool"`，内部图 = 一个函数节点），因此带「会话随时可调用」开关，清单里写
`always: true`（**默认开**：装上就能在会话里直接调用，不必先插入画布）；用户可在工具库里
关掉，开关状态照旧写进 `<数据目录>/tools/_builtin.json` 覆写。实现侧走的是与「拖入 PDF」
同一份解析内核，由函数节点桥 `mtnode.readPdf` / `pdfInfo` 接入（`fn-runtime.js` + `main.js`
注入 `pdfConvert`）。

内置条目三：**Markdown 转 PDF**（工具条目 `markdown-to-pdf`）——把 Markdown / 纯文本排版成
一份 PDF 落盘，入参 `Markdown内容` / `源文件路径`（本机 `.md` / `.txt` 绝对路径，正文留空时才读）
/ `输出路径`（必填，本机 `.pdf` 绝对路径）→ 出参 `文件路径` / `字节数`（**回真实落盘路径**，
Agent 拿得到「写哪儿了」，不像「PDF生成」节点那样无输出端子）。它是**工具条目**
（`kind: "tool"`，内部图 = 一个函数节点），带「会话随时可调用」开关，清单里写 `always: true`
（**默认开**：装上就能在会话里直接调用）。实现侧不另写排版器：函数节点桥 `mtnode.writePdf`
（`fn-runtime.js`）落到主进程 `fnPdfWrite` → `pdf-write.js` 的 `writeTextPdf`，也就是
**「PDF生成」节点经 `pdf:writeText` 用的同一份内核**（隐藏打印窗 + `printToPDF`，公式走
`renderer/math-render.js`，数据不落应用目录）。与条目二互为反向：那一支只读、不落盘，这一支只写、
不解析。

## 5. 与会话调用链路的关系（`always` 的消费）

`app-tools.js` 的 `agentUserToolsSnapshot(wf)` 是**单一真源**：每次会话 run 前收集
「当前画布全部工具节点 + 库中 `always: true` 的工具」，同名去重（画布副本优先），产出
纯 JSON 描述子列表随 run 参数下发。画布有 `toolLibId` 同源副本时优先直跑副本，否则
`runLibToolShadowForAgent` 临时物化克隆、跑完即清（不落盘为永久节点）。细节见
[docs/func-call-chain.md](./func-call-chain.md)。

## 6. 边界与约定

- 删除库条目不影响已插入画布的工具副本；覆盖保存保留原 id，使「随时可调用」开关延续。
- `always` 只决定**会话是否可调用**；画布内运行（▶ / 控制触发 / 下游级联）始终可用。
- 库内工具依赖画布节点判定与克隆工具（app.js 全局函数）；`toolsApiOk()` 未就绪时
  库入口 toast 提示并拒绝打开。
- 渲染层与主进程共用同一份 i18n（`renderer/i18n.js` UMD 导出），本模块错误文案
  （如 `工具名不能为空`）在主进程侧 `registerToolsIpc` 传入的 `t` 中解析。
