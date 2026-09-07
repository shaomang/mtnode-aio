# 开发会话改动节点 title+note 的真实来源（分析结论）

结论：**不是任何应用同步（syncAgentTask\*），而是 Agent 自己用 mtnode_canvas_edit 的 update 收尾回写**。开发节点是 `super + dev:true`，应用同步路径对它们一律不可达。

## 证据链

### 1) syncAgentTask* 明确只认 agent_task，够不着开发节点
- `renderer/app.js:26834 syncAgentTaskToSession` — 走 `node.agentSessionId`，用于普通智能任务会话；只处理节点侧 → 会话侧，不写回节点 title/note。
- `renderer/app.js:26876 syncAgentTaskFromSession` — 回写节点，但第 26880 行硬筛 `n.kind !== "agent_task"` 直接 continue。开发节点 kind=super，**永不匹配**。故会话结果绝不会经此改开发节点 title/note。

### 2) 会话侧改开发节点 title 的应用路径只有「用户主动」两类，均非 Agent 收尾
- `app-assist.js:4555-4568` `/rename` 命令：用户亲口改会话名时才反向刷节点 title（且只对绑定该会话的 super+dev 节点），并置 titleLocked。
- `app-nodes.js:13843 startTitleEdit` 画布上直接改节点名；dev 节点走 `app.js:26394 syncDevSessionTitles`，方向是 **节点→会话**（会话标题跟随节点），不是会话→节点。

### 3) title+note 的真实来源 = Agent 经 mtnode_canvas_edit update 回写
任务书明文要求 Agent 自己做收尾回写：
- `renderer/app.js:26345-26349 devNodeContractText`：「完成后按两段式规范回写…概述(note)，并更新状态(devStatus)…用 mtnode_canvas_edit 的 update 按 id 定位…」。该文本每轮随 `sess._devContract` 注入系统提示。
- `renderer/app.js:26417 createDevSessionForNode`：把 `sess._devContract = devNodeContractText(...)`（26449 行）塞进会话契约；`mode==="dev"` 时 `noCanvasRead=true`（26442），保留 mtnode_canvas_edit 专供收尾。

数据流（改动发生的确切落点）：
1. Agent 调用工具 `mtnode_canvas_edit` → `dsh/gateway/canvas-plugin.mjs:651`（工具定义）→ 523 行 `send({t:'canvas', op:...})` 到渲染层。
2. 渲染层接 op=edit → `renderer/app-nodes.js:10875` → `applyCanvasEdit`（13075）。
3. update 应用循环 `app-nodes.js:13261-13301` → `applyNodePatch(node, spec)`（13282）。
4. 字段真正落地的唯一入口 `app-nodes.js:12160 applyNodePatch`：
   - `12162-12163` `patch.setTitle` → `node.title = uniqueNodeTitle(...)`
   - `12217` `patch.note != null` → `node.note = String(patch.note)`（仅 super）
   - `12244-12247` `patch.devStatus`（pending/wip/done）

### 4) devStatus 中唯一由「应用」主动置的只有开工时的 pending→wip
`renderer/app.js:26639 startDevSessionWithText`：`if (node.devStatus !== "done") node.devStatus = "wip"`。
「done」及 title/note 一律来自 Agent 的 canvas_edit update（见上）。

## 判别口径（供定位 bug 用）
若看到开发节点 title/note 被会话运行自动改掉，只可能是 Agent 主动走了 mtnode_canvas_edit update——改查 Agent 收到的任务书/其执行内容，与画布快照回滚记录（rbCanvasEditOpen，app-nodes.js:13145）。应用侧不存在任何把会话消息/结果自动落成 title/note 的同步。
