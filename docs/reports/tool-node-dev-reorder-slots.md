# 工具节点三项改进：工具节点「开发」· 数组端子槽位组 · 参数重排

> 开发轮次：工具节点与函数节点模块。范围：renderer 层 + 冒烟回归 + 指南/契约文档同步。
> 结论：`smoke-tools` 272 项 / `smoke-fn-array-param` 170 项 / `smoke-codeedit` 314 项全绿。

## 1. 工具节点本身支持「开发」（绑定该工具的会话）

函数节点早已有「开发」按钮 + 绑定会话（`fnDevSessionIds`）；工具节点（super + tool:true 变体）此前没有。
本轮补齐，机制与函数节点镜像：

- **按钮**：`buildFnToolBodyMain`（renderer/app-canvas.js）中函数 / 工具共用同一个「开发」按钮区，
  点击按 `isTool` 分发到 `developToolNode`（工具）/ `developFunctionNode`（函数）；
  会话数分别按 `toolDevSessionsOf` / `fnDevSessionsOf` 统计，title 提示「已绑定 N 个开发会话」。
- **字段隔离**：会话 id 记 `node.toolDevSessionIds`（上限 24，新→旧），
  与函数节点的 `fnDevSessionIds`、开发节点的 `devSessionIds` **三套各走各的**
  （工具节点是 super 变体但非 `dev:true`，混用会让功能块判定串台）。
- **契约**：`toolDevContractText`（renderer/app-tools.js）写进 `sess._devContract`，
  每轮随系统提示注入。作用域钉死 = **这一个工具节点 + 它的内部子图**：
  ① 先 `mtnode_canvas_get`（detail:"full"、ids:[标题]）读工具节点与内部子图现状；
  ② 用 `mtnode_canvas_edit` update 补丁本工具 `toolConfig`
  （name / description / inputs / outputs，必要时 setTitle 同步工具名）；
  ③ 可在**本工具内部**（`parentSuperId` = 本工具 id）新建 / 删除 / 改动节点并连线来重建行为
  （工具行为 = 内部子图：点 ▶ 或 Agent 调用按拓扑执行）；
  ④ 不得改动画布上任何其它节点 / 连线；参数即端子，动参数表必须提醒复核连线。
- 弹窗草稿键 `toolDev`（`devDraftTextareaOpts` / `devDraftSet`，取消不丢、提交清空）；
  工作区 = `dshWorkspaceOf(node)`（画布目录）；标题「开发 · 工具名」。
- 文档：`guides/nodes/tool.md`（zh/en）新增「开发（绑定该工具的会话）」；
  `docs/tool-function-nodes.md` §8.4 补工具节点字段口径。

## 2. 数组入参端子 = 渐进槽位端子组（渲染层）

函数节点勾了「数组 · 可接多条线」的入参端子，引擎仍是「同一端子号可收多条数据线 →
JS 拿到数组」；渲染层把端子徽标从「参数名 ×N」升级成**槽位组**（一条线一个槽）：

- 徽标 = 参数名 + 每个已挂数据线一个亮槽点（`参考图[1] [2] …`）+ 末尾一个空槽（可再接新线）；
  每多接一条线多一个槽，与普通处理节点「连一个自动多一个输入」同直觉（`test/smoke-fn-array-param` [8] 已随新文案更新）。
- 槽点可交互：悬停显示「第 k 条输入 · 来源：xxx」；右键某个亮槽**只断开那一条**
  （新真源 `fnToolInPortWireAt` / `fnToolInPortWireRemoveAt`，槽序 = 挂线顺序，与
  `fnToolInPortWireCount` 同一口径——壳层只数外侧入线、排除关系线与控制源线）；
  空槽 / 亮槽 mousedown 都能从该端子发起拖线（同一 idx）。
- CSS 落点：`renderer/css/canvas.css` `.fn-arr-slots / .fn-arr-slot-dot / .fn-arr-slot-add`
  （槽点 pointer-events:auto，盖过 `.port-badge` 的 pointer-events:none）。
- 工具节点**不放开数组多线**（本轮边界不变），槽位组只作用于函数节点数组入参端子；
  浏览态只读摘要 / 脚手架注释仍用 `×N` 文案（展示层措辞，非端子模型）。
- 文档：`guides/nodes/function.md`（zh/en）数组端子小节改写；`docs/tool-function-nodes.md` §2 / §5 同步。

## 3. 工具 / 函数节点：输入输出参数可重排（▲▼ + 拖动 insert）

- 设置面板参数行（`buildFnToolSettings` / renderer/app-canvas.js）：
  每行新增 ⠿ 拖把手（HTML5 drag，可 insert 到任意位置，前后有高亮反馈）与 ▲▼ 逐格按钮
  （边界置灰）。拖动 / ▲▼ 走同一 `fnToolMoveParam(node, dir, from, to)`。
- **参数即端子 ⇒ 参数跟端子走**：`fnToolMoveParam` 返回 perm（oldIdx → newIdx）并把参数表
  移位；`fnToolRemapParamWires` 按 perm 重映射该节点数据线端子号——
  输入侧（外侧入线 toIndex + 工具壳内侧桥接 fromIndex）、输出侧（外侧出线 fromIndex +
  内侧汇流 toIndex）都跟参数走，数据线不会漂到别的参数；控制端子（输入 0 / 输出末位）、
  关系线、无关线一律不动。
- 移动后 `ensureFnToolNodeState` + `clearDownstream` + 保存 + 重画端子，toast「已调整参数顺序」。
- 回归：`test/smoke-tools.js` 新增 ⑨ 参数重排段（含工具壳内侧汇流 remap 断言）与
  ⑩ 工具「开发」链路符号断言，共 272 项全绿。

## 附：相关文件

- `renderer/app.js`：`fnToolMoveParam` / `fnToolRemapParamWires`
- `renderer/app-canvas.js`：设置面板参数行排序；开发按钮函数/工具共用；数组槽位徽标
- `renderer/app-tools.js`：`toolDev*` 一套（会话 / 契约 / 对话框）
- `renderer/i18n.js`、`renderer/css/canvas.css`
- 文档：`docs/tool-function-nodes.md`、`guides/nodes/tool.md`、`guides/nodes/function.md`（含 en/）
- 冒烟：`test/smoke-tools.js`、`test/smoke-fn-array-param.js`、`test/smoke-codeedit.js`
