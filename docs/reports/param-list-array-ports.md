# 工具 / 函数节点「数组端子（list）」——Agent 契约 / 画布 API / 双语文案同步

产出日期：2026-09-06 · 并行任务：Agent 契约、画布 API 与双语文案同步

## 口径（本次统一到一句话）

参数条目模型 = `{ name, kind, list }`。`list:true` = **列表（数组）入参端子**：同一个输入端子可被多条数据线重复连入（各来源取值按连线顺序汇成数组），一条批量线也可整体喂进一组值，`jscode` 里 `input[参数名]` 直接取到数组（只连一条线也是数组）；没标 `list` 的端子连多条线只留一个值。列表只是**输入侧**的取值语义：归一真源 `normFnToolEntry(e, i, dir)`（`renderer/app.js`）在 `dir === "in"` 时才保留 `list`，输出参数上的一律清掉（输出方向严格「参数即端子 · 一端子一值」）。

## 改动

### 1. `dsh/gateway/canvas-plugin.mjs`（Agent 侧工具描述）

- `PARAM_ENTRY_SPEC` 的参数条目已含 `list` 布尔（缺省 false），描述写明「可重复连多条数据线 → 运行时该端子值 = 按连线顺序的数组 · 未标则多连只留一个值」。
- `TOOL_CONFIG_SPEC.inputs` / `.outputs`：`inputs` 补「每条带 kind 与 list：list:true = 数组端子，可被多条数据线重复连入，JS 侧 `input[参数名]` 拿到数组」；`outputs` 补「list 只是输入侧语义，输出参数上会被归一清掉（一端子一值）」。
- `NODE_PROPS.inputs` / `.outputs`（函数节点参数表）：同一口径补齐数组说法；`.jscode` 描述补「标 list 的数组端子值 = 数组」。
- `EDIT_DESC` 的「硬规则 · tool / function 节点」段：新增数组端子的连线与取值语义（含「输出端子恒单值」）。
- `GET_DESC`（`mtnode_canvas_get`）：写明快照里入参带 `kind` + `list`（`list:true` = 数组端子、可挂多条入线、jscode 取到数组），出参恒单值且不带 `list`。
- `PAIR_SPEC.fromIndex`：补「标 list 的入参端子可被多条数据线重复连入」。

### 2. `renderer/app-nodes.js`（快照回读 + 补丁归一同源）

- `applyNodePatch` 内 `normParamList(arr, who, dir)`：多传方向，逐条走 `normFnToolEntry(e, i, dir)`——四个调用点分别是 `toolConfig.inputs` → `"in"`、`toolConfig.outputs` → `"out"`、`patch.inputs` → `"in"`、`patch.outputs` → `"out"`。此前不传方向，Agent 补丁写进来的 `list` 会被无条件清掉（数组端子存不住）；现在与「设置」面板 / 存档加载（`ensureFnToolNodeState`）同一真源、同一方向规则。
- 参数数组校验的回报文案改为「需是参数数组（每项 {name, kind, list}）：」。
- `mtnode_canvas_get` 快照：`toolConfig.inputs` 与函数节点 `inputs` 每条如实回读 `list: p.list === true`；`outputs` 侧不带 `list`（归一已清），注释里写明「回读与 canvas_edit 参数补丁、设置面板、存档加载共用同一归一真源」。

### 3. `renderer/app-assist.js`（两份「工具 / 函数节点」说明）

- 全局助手 system-prompt 段（`devNodeRule` 之后的那条）：在 kind 口径后补「**列表（数组）端子由参数的 `list:true` 决定**……canvas_get 回读的入参每条都带 list（出参恒单值、不带该字段），改参数表时如实传 list 才生效」。
- 画布智能会话 system-prompt 段（【工具 / 函数节点】）：补同样的数组端子一句（多连成组、`input[参数名]` 取到数组、回读带 list / 出参恒单值）。

### 4. `renderer/app-tools.js`（函数开发任务书）

- `fnDevParamLine(list, startIdx, isIn)`：入参端子为列表端子时在该项后标 `,×N`（出参不标）；注释同步。
- `fnDevContractText`：入参行标题改「入参端子（端子 0 = 控制入，1..N = 各入参，标注 ×N = 列表端子）：」；「执行契约」补数组口径——标 ×N 的列表端子值恒为数组（只连一条线也是数组，用 for / map 逐项处理），输出端子一律单值，要传多个值就返回数组给下游标 ×N 的列表入参端子。

### 5. `renderer/i18n.js`（zh → en 词条）

三个被改动的中文串就地换键并补英文（旧串已无引用，不留死键）：

| 中文（新） | 英文（新） |
| --- | --- |
| `需是参数数组（每项 {name, kind, list}）：` | `must be a param array (each {name, kind, list}): ` |
| `入参端子（端子 0 = 控制入，1..N = 各入参，标注 ×N = 列表端子）：` | `Input ports (port 0 = control in, 1..N = the input params; ×N marks an array port): ` |
| `执行契约：jscode 里 input = { 参数名: 值 }（… · 标 ×N 的列表端子值恒为数组 …）…` | `Execution contract: in jscode, input = { paramName: value } (… an ×N array port's value is always an array — even with a single wire in, so loop / map over it instead of treating it as one value) …` |

## 自检

- `node --check` 通过：`renderer/app-nodes.js`、`renderer/app-tools.js`、`renderer/app-assist.js`、`renderer/i18n.js`、`dsh/gateway/canvas-plugin.mjs`。
- 串对串核对：`app-tools.js` 里的「执行契约」「入参端子」两条与 `i18n.js` 的键逐字一致；`app-nodes.js` 的校验文案与 i18n 键一致（`I18n.t` 精确匹配才不会漏翻译）。
- 未跑测试 / 构建 / 安装，未改运行期取数与连线校验逻辑（那属另一并行任务）。
