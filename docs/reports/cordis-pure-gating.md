# 任务汇报：cordis.yml 按 MTNODE_PURE 门控插件与 system-prompt 配置

只改了一个文件：`dsh/gateway/cordis.yml`。

## ① system-prompt 源头关段（原第 376-377 行）

`includeHarnessIdentity` / `includeRuntimeContext` 各追加 `&& process.env.MTNODE_PURE !== '1'`，纯净模式在**源头就不发**这两段，`pure-prompt` 插件的段过滤退化为兜底：

```yaml
    includeHarnessIdentity: !!js process.env.MTNODE_CHAT_ISOLATE !== '1' && process.env.MTNODE_PURE !== '1'
    includeRuntimeContext: !!js process.env.MTNODE_CHAT_ISOLATE !== '1' && process.env.MTNODE_PURE !== '1'
```

并在该段上方注释补两行说明（纯净模式口径 + 插件行按同一环境变量禁用）。

## ② 25 条插件行的 disabled 追加 `|| process.env.MTNODE_PURE === '1'`

沿用既有 `MTNODE_CHAT_ISOLATE` 写法，`=== '1'` 形式与平台条件前置不变：

| 分组 | 插件行（id） |
| --- | --- |
| MTNode 工具 | `mtnode-canvas`(L62) · `mtnode-db`(L76) · `mtnode-rollback`(L70) |
| 终端 / 任务 | `tool-bash`(L190，保留 `process.platform === 'win32' ||` 前置) · `tool-pwsh`(L194，保留 `!== 'win32' ||` 前置) · `tool-jobs`(L198) |
| 文件系统 | `fs-observation-policy`(L202) · `tool-fs`(L206) · `tool-fs-search`(L210) |
| 指令 / 技能（`<available_skills>` 与 AGENTS.md 的注入源） | `agent-instructions`(L216) · `skill`(L222) · `skill-filesystem`(L226) · `tool-skill`(L230) |
| 计划模式 | `plan-mode`(L249) |
| subagent 系列 | `subagent`(L265) · `subagent-spawn-in-process`(L269) · `subagent-fork-in-process`(L275) · `tool-subagent-control`(L281) · `tool-subagent-list-agents`(L285) · `tool-subagent`(L289) · `tool-subagent-fork`(L297) · `tool-subagent-report`(L305) |
| 其它工具 | `tool-todo`(L330) · `tool-goal`(L336) · `tool-str-replace-editor`(L340) |

## 保持不动（按计划）

- **保留**：`web` · `web-search-deepseek` · `tool-web` · `mtnode-bridge`（审批桥）· 运行时骨架（`agent` / `llm` / `session` / `jobs` / `sandbox` / `permission` / `approval` / `compaction` / `spill` / `tools` / `agent-loop` 等）。
- **未改** `tool-ask-user`(L51)：不在本任务的门控清单内，纯净模式仍可经桥向宿主提问。
- 未改 `goal` / `commands` / `command-goal` 等运行时骨架行；`bash-sandbox` / `pwsh-sandbox` 的平台条件不变。

## 为什么改这里 & 生效链路

`<available_skills>` 目录与 `AGENTS.md` 是 `skill` / `skill-filesystem` / `agent-instructions` 等插件以消息 / 上下文形式注入的，只过滤 prompt 段（`pure-prompt` 只删 `deployment:persona` 与 `harness:identity`）清不掉，必须在装配源头禁用插件行。
链路已核对：`gateway.mjs` 的 `getRuntime` 已按 `pure` 写入 / 删除 `env.MTNODE_PURE`（L762-763），runtime key 含 pure 标记（纯净 / 非纯净不共用运行时），cordis 运行时是带该 `env` spawn 出的子进程（L822-828，`args: [RUNTIME_BIN, CORDIS_PATH]`），所以 cordis.yml 里的 `!!js` 表达式在子进程内求值，门控随每次建runtime生效——与已验证的桌宠 isolate 档同一机制。

## 校验方式（未跑测试）

- 逐行复核 `git diff`：27 行表达式改动 + 2 行注释新增，无其它改动、无缩进变化（`diff --stat`：33 insertions / 27 deletions，其中多出的 4 行是工作区里本任务之前就已存在的 `pure-prompt` 行块，非本次产出）。
- `grep` 复核：清单内 25 条 disabled 行全部带上新条件，且 `disabled: !!js process.env.MTNODE_CHAT_ISOLATE === '1'`（无 PURE）现在仅剩 `tool-ask-user` 一处。
- 未运行任何测试 / 构建 / 依赖安装；未改 `gateway.mjs`、`plugins/pure-prompt.mjs`、`dsh/DESIGN.md`。

## 遗留（计划外，未动，供后续决定是否补文档）

以下三处注释仍写着「保留工具与运行时上下文」，与本次源头门控后的实际行为已不符：
`dsh/gateway/plugins/pure-prompt.mjs` L4-L6 · `dsh/gateway/gateway.mjs` L761 上方注释与 L1031 附近 · `renderer/app-db.js` L1615 / `renderer/app-assist.js` L4159 · `dsh/DESIGN.md` L92 的 `pure` 字段说明。
