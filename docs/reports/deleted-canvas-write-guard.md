# 已删画布写回拦截（防复活 / 防串写）

并行任务「防止已删画布复活或被串写」的改动汇报。只改渲染层写回入口，未动主进程。

## 结论

删除成功后，这张画布的 **id** 进入黑名单、被删的**对象**盖墓碑；此后渲染层所有 `persist` 类写回命中即丢弃，agent 的画布写入入口改为明确抛「画布已删除」，不再静默落盘把空壳画布写回磁盘。

## renderer/app.js

- `S` 新增两个运行时字段（不落盘）：`_deletedWfIds`（id → `{at,name}` 黑名单）、`_deadWfObjs`（`WeakSet` 对象墓碑）。
  墓碑是黑名单之外的第二层：`default` 被删后重建同名画布是正常路径，届时只解 id 黑名单，旧对象引用依然写不进新画布。
- 新增「实时保存」小节里的一组工具函数（约 20994 行起）：
  - `wfBlacklist()` / `wfIsDeleted(id)` / `wfWriteBlocked(wf)`：判定是否禁止写盘（墓碑优先，其次 id 黑名单）。
  - `deletedWfError(wf)`：统一错误文案「画布已删除」/「画布已删除：<name>」。
  - `forgetDeletedWf(id, wf)`：**删除成功后的统一收口** —— `clearTimeout(S.saveTimer)` + `S.saving=false`、`delete S.wfBag[id]`、按 id 与对象身份双口径把该画布从 `S.canvasRunStack` 剔除并回退 `S.canvasRunWf`、清掉 `S.nodeWfId` 中值等于该 id 的条目、记黑名单 + 盖墓碑。
  - `reviveWf(id)`：只解 id 黑名单（新建 / 导入 / 从磁盘成功加载同名画布时调用），墓碑保留。
- 写回入口全部加拦：`rememberWf`（已删对象不再入袋）、`beginCanvasRun`（不再把已删画布绑成写入目标）、`persistWf`、`flushCurrentWf`、`persist`（命中即丢弃，`persist` 顺带复位 `S.saving` 并 `renderStatus()`，防状态卡在「保存中…」）、`ownerWfOfNode`（扫描时跳过已删画布）。
- `deleteWorkflowDialog`：`wfDelete` 回 `ok` 后，原先手写的 `clearTimeout + S.saving=false` 换成 `forgetDeletedWf(snap.id, snap.wf)`。
- `loadWorkflow`：`wfLoad` 成功后 `reviveWf(id)`；`ensureWorkflow` / `createDefaultWorkflowFresh` / `adoptImportedWorkflow` 在新建落盘前 `reviveWf(id)`。

## renderer/app-nodes.js

- `deleteWorkflowByRef`：① 目标 id 已在黑名单 → 抛「画布已删除」（不重复删、不走重建）；② **改为检查 `wfDelete` 返回值**，`!ok` 抛「删除失败：…」，绝不谎报成功；③ 成功后调 `forgetDeletedWf(...)`，删掉原先只做一半的手工清理（`delete S.wfBag[id]` / `clearTimeout`）。
- `renameWorkflowByRef`：黑名单 id 直接抛「画布已删除」（它的 `wfSave` 会凭空复活空壳画布）。
- `applyCanvasOp`（`get` / `edit`）与 `applyCanvasEdit` 入口：绑定画布被删时抛 `deletedWfError(S.wf)`；该错误经 `handleCanvasEvent.finish()` 回给网关，模型拿到的是失败工具结果而不是「改图成功」。
- `createWorkflowNamed`：新建落盘前 `reviveWf(id)`。

## renderer/i18n.js

- EN 词表补 `"画布已删除"` / `"画布已删除："` 两条。

## 对主进程软删任务的依赖（接口约定）

渲染层只认这三条口径，主进程改成软删也不需要同步改这里：

1. `workflow:delete` 返回 `{ ok:true, ... }` ⇒ 视为「对用户已不存在、对渲染层已不可写」，立即拉黑该 id；软删带回的额外字段（回收站路径 / `deleted` 标记等）渲染层不依赖。
2. 返回 `{ ok:false, error }` ⇒ 不做任何收口，画布保持可写（两条删除入口都会照实报错）。
3. **`workflow:list` 与 `workflow:load` 必须不再返回已删画布**：删除后仍被 list 返回会让落点挑到幽灵；仍被 load 返回则 `loadWorkflow` 的 `reviveWf` 会按「磁盘上确实有它」解禁（这是刻意设计：以磁盘/列表为唯一真源，避免留下一张永远存不下去的画布）。

## 校验

`node --check` 通过：`renderer/app.js`、`renderer/app-nodes.js`、`renderer/i18n.js`。按任务要求未跑测试 / 构建。
