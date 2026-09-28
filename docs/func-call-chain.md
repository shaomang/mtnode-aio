# Agent 工具调用链路（func call chain）设计文档

> 状态：已实现（渲染层 `app-tools.js`「Agent 工具调用链路」段 + `app-assist.js` 会话内清单展示）
> 配套契约：[docs/tool-function-nodes.md](./tool-function-nodes.md)（工具/函数节点数据模型）·
> [docs/tool-library.md](./tool-library.md)（工具库存储与 `always` 开关）· 节点指南
> `guides/nodes/tool.md`。

## 1. 链路总览

「工具节点」让用户把**画布内的一段流程**注册成 Agent 可调用的工具。一次会话调用走：

```
会话 run 前
   agentUserToolsSnapshot(wf)     单一真源：画布工具节点 + 库中 always 工具 → 描述子列表
        │  描述子 = 纯 JSON（key / ASCII toolName / 名称 / 描述 / inputs / outputs）
        ▼
 runParams.tools                  随 run 参数交给网关（不含内部图，token 安全）
        │  网关按工具集指纹分池 → 注入运行时 tools-plugin.mjs → 注册同名 function-call 工具
        ▼
模型发起工具调用（tool-run 帧）    data = { id, tool:{key}, args:{参数名:值} }
        │  S._runToolDescs[runKey] 本轮定位表（每轮结束即失效，下轮重新收集）
        ▼
handleToolRunEvent → executeAgentToolCall(desc, args, wf)
   ├─ desc.origin === "canvas" → runCanvasToolNodeForAgent（画布节点直跑）
   └─ desc.origin === "lib"    → 画布有 toolLibId 同源副本 ? 直跑副本
                                 : runLibToolShadowForAgent（临时物化克隆，跑完即清）
        ▼
结果 payload → dshInteract({kind:"tool", id, result})   失败 → 错误文本回执，绝不中断会话
```

## 2. 描述子（tools-provider · 单一真源）

| 描述子 | key | 说明 |
|---|---|---|
| 画布工具节点 | `cn:<nodeId>` | `canvasToolDescriptor`：名字取 `toolConfig.name`，空则退回节点标题；不携带内部图——节点已在画布上 |
| 库中 always 工具 | `lib:<toolId>` | `libToolDescriptor`：只有定义（名称/描述/入出参数），执行时再物化 |

- **ASCII 函数名**：`agentToolAsciiName` 把中文名 slug 成 `mtnode_tool_<base>_<hash>`，
  模型按它发起 function call；`<hash>` 由 key 派生，画布/库两条来源互不撞名。
- **去重**：同名（ASCII）去重，画布副本优先 —— 库中 `always` 工具若画布已有同名工具节点，
  只发画布那条。
- **新鲜度**：**每次 run 前重新收集**（画布或工具库可能已变），定位表只活到本轮结束；
  run 参数里的 `tools` 是纯 JSON 描述子，内部图从不下发。
- **描述子字段（「描述自足」）**：除 `key / toolName / name / description / inputs / outputs`
  外，还有 `example`（一份最小调用 JSON 文本）、`limits`（限制与失败情形）、
  `atLeastOne`（参数组「至少给一个」），参数条目带 `description`（参数说明）与
  `optional`（可选位）。**未标 optional = 必填**（老包口径不变）。
- **`{{outDir}}` 展开**：作者在描述 / 示例 / 参数说明里写 `{{outDir}}`，宿主拼描述子时
  替换成本机真实可写的用户输出目录（数据目录下 `exports/`，主进程 `tools:env` 提供并确保存在）；
  取不到时退回一句说明、绝不编造路径。注入值是**本机固定**的，不放画布工作目录等易变值 ——
  描述子整串的 sha1 是网关运行时指纹（`gateway.mjs` 的 `tlHash`），易变值会让每次换画布都冷启。
- **旧副本刷新**：画布上的工具节点是插入时的深拷贝，且**画布副本优先**于库条目；
  打开画布（`loadWorkflow`）时 `refreshBuiltinToolCopies(wf)` 把 `toolLibId = builtin:*` 的副本
  按内置最新刷一遍文案类字段（参数个数与顺序永不动，按名字对齐、对不上的不碰）。

## 3. 宿主执行

**端子对齐**（契约 §2）：输入端子 0 = 控制入（固定），参数 i 对应端子 i+1；Agent 入参只覆盖
数据端子（`vals[i+1] = agentArgValue(args[参数名] | args["arg"+(i+1)], kind)`），控制口不动；
入参经 `node._agentCallArgs` 注入，跑完即删。文本参数值为字符串、图像参数值 `{kind:"image",path}`
（`agentArgValue`）。

**执行前预检**（`agentToolPrecheck`，不跑内部图就挡下）：① 未标 `optional` 的入参一个都没给值；
② `atLeastOne` 的某个参数组整组为空。命中就抛错、由回执附用法摘要 —— 省掉一轮（可能含真实
API 调用的）无效执行。预检只看结构化字段，不猜语义。

- **画布节点直跑**：`runCanvasToolNodeForAgent` → `runToolNode(node, true, {noCascade:true})`
  （引擎执行内部图，见 tool-function-nodes.md §3 / §7）；运行中重入抛错；结束时 `node.error`
  非空则抛错文本，否则按输出端子 `$0..$n-1` 组装结果。
- **库工具无画布副本**：`runLibToolShadowForAgent` 用 `tools:get` 取全量包，`cloneNodesDeep`
  临时物化到当前 wf 顶层（不 pushHistory / 不落盘），跑完过滤清理，并补一次
  `scheduleSave(true)` 把瞬态存档里的临时副本冲掉。

## 4. 回执与失败语义

`agentToolResultPayload(outputs, node)`：`{ ok:true, tool, outputs:[{name,kind,value}] }`；
单文本输出时附 `text` 快捷字段（截断 24000 字符）。经 `dshInteract({kind:"tool", id, result})`
回执。

失败一律**以错误文本回执、会话不中断**：
- 节点不在画布（可能已删）→「工具节点不在当前画布…」；
- 工具正在运行 →「请稍后再调用」；引擎未就绪 / 壳内无可执行节点 → 对应错误；
- 库包缺失 / 无法实例化 →「工具包不可用…」；
- 描述子在本次 run 的定位表中找不到 →「不在本次运行的可用清单中」（快照过期兜底）。

**失败回执附用法摘要**（每次失败都附）：`toolUsageSummary(desc)` 把该工具**自己给出的信息**
拼成一段 —— 用途 / 入参清单（含义 + 必填或可选）/「至少给一个」的参数组 / 返回项 /
限制与失败情形 / 最小调用示例。模型下一轮照它改参数即可调对，不必「同一条错反复试」；
执行前预检失败走的也是这条回执。信息全部来自描述子，不额外猜、不编造路径。

## 5. 可见性与刷新

- 会话侧展示（`app-assist.js`）：🧰 chip 显示「本画布 + 库中随时可调用」工具数，点击列清单
  （每行标注来源：`本画布` 或 `工具库 · 随时可调用`，附描述与入出参数摘要）；数据 = 同一份
  `agentUserToolsSnapshot(S.wf)` 快照，防抖刷新避免每次渲染打 `toolsList` IPC。
- 任何库/画布工具集合变化（保存 / 插入 / 删除 / 改名 / 切 always）都走
  `notifyUserToolsChanged()` 通知刷新。
- 工具调用计入运行轨迹（`tool` 段：只挂 callId 与 step，明细在 `m.tools`）与用量统计
  （`toolMs` / 次数），不混进思考文本。
- 纯文本（非智能）会话不注入工具描述子（`pure` 会话不下发，网关不注入运行时）。
