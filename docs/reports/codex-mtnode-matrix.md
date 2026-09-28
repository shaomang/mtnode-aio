# Codex × MTNode 逐维对比矩阵（任务 5 交付）

> 任务 5：把 Codex Agent 机制深读（源 A）+ Codex 功能清单（源 B）与 MTNode 现状能力表并成对比矩阵。
> 依据文件：`docs/codex-agent-capability-list.md`、`codex-features.md`（已归档至 `docs/reports/`）、`docs/reports/MTNode-现状能力表.md`；关键证据两侧源码均已回核（见文末核对清单）。
> Codex 侧路径一律 `codex-rs/` 相对（快照 `%TEMP%\codex-review`，main 分支 tarball，无 .git）；MTNode 侧为项目根相对路径。行号随演进过期，只作留痕。
> 判定口径：**C**＝Codex 领先或值得借鉴 · **M**＝MTNode 已有或更优 · **X**＝思路不同不宜照搬 · 可组合（如 C+M）。

## 0. 总览

| # | 维度 | 一句话判定 |
|---|---|---|
| D1 | Agent 会话与工具调用协议 | C：Codex 有完整轮状态机 + 每轮动态工具装配 + 发现式 tool_search；MTNode 的「工具节点可被 function-call + 事件帧桥」是画布化雏形 |
| D2 | 审批 / 安全 / 沙箱 | C 为主、思想同源：档位同名（read-only/workspace-write/danger-full-access）；Codex 深在 OS 原生沙箱 + execpolicy 规则语言 + guardian 自动复核；MTNode 独有 nodeLock「智能节点只办事不改图」边界（M） |
| D3 | MCP 与扩展生态 | C：双向 MCP + hooks + 市场；MTNode 的 EXT_KINDS 三分类统一管理与画布工具/函数节点复用是独有优势（M） |
| D4 | 配置与可复现性 | C：分层 config + 来源溯源 + profile 档 + --strict-config；MTNode 档位偏「运行身份」、无分层覆盖 |
| D5 | 审计与日志 | 各有侧重：Codex 全量会话转录 + 重放（C）；MTNode 对象级回滚账本（sha256 内容寻址、文件/canvas/db/shell 四类还原）更贴画布用户（M） |
| D6 | 上下文 / 记忆管理 | C（本报告最大差距）：自动压缩轮 + WorldState 17 分节差分（每轮只注变化段）+ 增量续传；MTNode systemPrompt 每轮全量拼装 |
| D7 | 非交互与批处理执行 | 思路不同（X）＋互有领先：Codex 有 CLI/`--json` 事件流/`--output-schema`（C）；MTNode 有 batch/agg + split/merge + timer/sequencer/gate 等可视编排原语（M，Codex 无） |
| D8 | 错误重试与恢复 | M 为主：MTNode「整轮 5s×5 原样重发不跳任务 + 可打断」是 Codex 没有的产品化闸；Codex 领先在账本重建断点续跑（C） |

---

## D1 Agent 会话与工具调用协议

| 子项 | Codex | MTNode | 判定 |
|---|---|---|---|
| 会话/轮状态机 | `Session`(session.rs) → `SessionState/TurnState/TaskKind{Regular,Review,Compact}/MailboxDeliveryPhase`；`RegularTask::run` `loop{run_turn}`，单轮 `run_turn` 2881 行 | `agent_task`/`proc_text agent:true` 共用执行机器（buildSpec/buildSpecAgg/playNode/runOnce/runAttempt），一轮 = 一次模型请求串工具循环，轨迹按步切段；无显式任务状态机 | C |
| 协议面 | `protocol/src/protocol.rs`(6291 行) `Op`/`EventMsg` 百级变体：批准/询问/压缩/回滚/审查都是一等 Op | dsh 本地协议 run 事件（reasoning/text/say-end/tool/status/question/approval/canvas/db/…，均带 reqId），UI 侧消费；未标准化对外 | C（MTNode 事件面够用但未成对外契约） |
| 每轮工具装配 | `tools/spec_plan.rs` `build_tool_router`（1552 行，本回核 L125/358/487）：按环境快照+模型信息+特性+MCP+子代理深度+权限 profile 动态装配；`ToolRouter` 分本地/MCP/extension/托管四路 | 内置工具面固定；用户工具经 `MTNODE_TOOLS_JSON` 由 tools-plugin.mjs 注册为 function-call（参数 schema 由 inputs 生成） | C（MTNode 无按轮裁剪/按需注入） |
| 调度链 | `ToolOrchestrator`：approval→sandbox 选择→attempt→被拒后升级沙箱重试（缓存免二次批准） | 工具执行帧 `{t:'tool'}` 走同一条桥回宿主渲染层跑工具节点内部图，超时 15 min；无升级重试序列 | C |
| 发现式工具 | tool_search handler + `codex_tools::tool_search`（按需把工具注入工具面） | 无（工具全量常驻） | C |
| 分支/流程 | review 是独立任务面，无画布 judge | `judge` YES/NO 双输出 + task start/成功/失败终点——MTNode 独有的可视化裁决 | M |
| 子代理 | multi-agent v2 控制环（agent/：spawn/send/wait/interrupt/close/followup/list、spawn 深度限制、role 锁定模型并声明不可改） | dsh 子代理/后台 job（并行 subagent、send_message、interrupt_agent）已在用；无深度限制/角色锁模型 | C（MTNode 已起步） |

## D2 审批 / 安全 / 沙箱模型

| 子项 | Codex | MTNode | 判定 |
|---|---|---|---|
| 沙箱档位 | `SandboxMode { read-only, workspace-write, danger-full-access }`（config_types.rs:104）＋平台实现 SandboxType（bwrap+landlock/Seatbelt/Windows restricted token） | 引擎 `permissionPreset`：mtnode-unattended / read-only / workspace-write / danger-full-access / mtnode-super-ask（app-nodes.js 8885+）；宿主侧 DSH 沙箱档同名 | 同思想；C 在 OS 级实现深度（对桌面 App 工程量不对等） |
| 批准策略 | `AskForApproval`（protocol.rs:984）四态 + `GranularApprovalConfig`（sandbox/skill/request_permissions/mcp_elicitations） | agentToolPreset 每工具三态 批准/询问/拒绝（分组 canvas/app/core），canvas/db 确认框登记发起轮句柄（ix-drop/收尾自动关） | 相当（MTNode 按工具粒度的三态覆盖常见面） |
| 自动复核 | `ApprovalsReviewer::{User, AutoReview(guardian)}`（config_types.rs:183）：guardian 子代理做风险决策；拒后用户可用 `/approve` 推翻（Op `ApproveGuardianDeniedAction`） | 无 agent 审批 agent；全走用户确认 | C（guardian 自动复核可省大量打断） |
| 规则语言 | execpolicy crate（Starlark 前缀规则 allow/deny/ask/prompt，跨环境持久化，ExecPolicyAmendment 协议下发） | 无命令级规则语言；只有路径级 agentPermOutside ask（拒绝/允许一次/始终允许该路径及子路径） | C（MTNode 路径记忆接近但无前缀规则面） |
| 网络批准 | `network_approval.rs` + 按 host/port allow/deny/ask 与规则记忆 | 无网络访问批准（桌面应用默认本机服务） | C（可选增强） |
| 沙箱内工具缓存 | 批准缓存（`with_cached_approval` 会话内已批准即跳过）+ 升级沙箱免二批 | 无缓存批准（重复弹窗靠「始终允许路径」） | C |
| 智能节点边界 | 无对应（Codex 无「节点只办事不改图」形态） | **nodeLock**：agent_task/proc_text agent 跑内部 node 档，canvas 工具被宿主硬拒（app-db.js 1708/1738-1739/1754-1760 + gateway PRESETS.node）；scopeLock 防嵌套递归 | M（MTNode 独有且已产品化） |
| 跨层批准 | MCP/插件工具带批准元数据（protocol/mcp_approval_meta.rs、codex-mcp trusted_access） | 交互桥 approval 帧按发起 session 门控（fail closed），工具许可三层正交 | 近似；C 协议更统一（extension 面） |

## D3 MCP 与扩展生态

| 子项 | Codex | MTNode | 判定 |
|---|---|---|---|
| 消费 MCP | rmcp-client 多传输：stdio/streamable HTTP/OAuth/EMA/executor；`codex mcp add/list/remove`（cli/src/mcp_cmd.rs）；config `mcp_servers`；`/mcp` | `mcpList/Add/Remove/SetEnabled` 本地协议 + 扩展管理 UI（EXT_KINDS 卡片，url http(s)://host/mcp），变更重启运行时 | C（MTNode 传输面窄；管理 UX 有） |
| 反向外露 | `codex mcp-server` 把自己当 MCP server（stdio）暴露给其它宿主 | 无 | C（可借鉴：把画布/工作流经 MCP 暴露给外部 AI 宿主） |
| hooks | Pre/PostToolUse/PreCompact 等事件钩子（策略 + 审计旁路） | 无 hooks 引擎；工具执行帧 `{t:'tool'}`/桥帧本身可作注入点 | C |
| 技能 | skills crate + `.codex/skills` + `/skills`；AGENTS.md 项目指令（agents_md.rs：根→cwd 发现拼接、`AGENTS.override.md` L42、`project_doc_max_bytes` L65、不可信项目跳过） | 内置技能索引块注入每次智能运行 systemPrompt（mtnodeInternalSkillIndexBlock）+ 云发技能 ext-repo 8 条 + 本机安装技能 skills/；AGENTS.md 同为会话共识 | 各有千秋：C 的发现/缓存/限额更工程化；MTNode 技能离画布节点更近 |
| 插件/市场 | plugin + marketplaces + `/plugins`（能力类插件进 agent 工具面） | EXT_KINDS（DSH 插件/技能/MCP 同卡样式）+ `plugins/` 应用插件宿主（window/pet/媒体后端 runtime-feed 安装）+ store-saas 创意工坊 | X（插件语义不同：Codex 扩 agent 能力，MTNode 扩宿主窗口/后端） |
| 可视化复用单元 | 无画布对应物；extension/动态工具最近似 | 工具节点（super+tool:true、toolConfig 参数即端子、子画布）与函数节点（jscode 在 fn-runtime.js worker 执行）可被 Agent function-call 复用 | M（MTNode 独有） |

## D4 配置与可复现性

| 子项 | Codex | MTNode | 判定 |
|---|---|---|---|
| 分层 | 默认 < `$CODEX_HOME/config.toml` < profile < `-c/--config` < env；`--strict-config` 未知键报错；每字段来源溯源（config_layer_source.rs） | `config.json` 的 `dsh.*` + 设置面板；无覆盖分层与溯源；无 strict 模式 | C |
| 配置档 | `ConfigProfile`（profile_toml.rs：model/service_tier/approval_policy/sandbox_mode/reasoning…）；profile-v2 `$CODEX_HOME/<name>.config.toml`；role.toml 可锁 model/effort 并在提示中声明不可改 | 运行身份 preset（standard/minimal/code/…）+ agentToolPresets 可克隆；节点级 provider/model/size | C（MTNode 档位偏身份，非可覆盖配置档） |
| 模型/服务商 | `model_providers` 表 + models-manager 目录刷新 + ModelPreset（supported/default_reasoning_effort/service_tiers）+ step_activation 模型切换安全门 | `config-providers.js` 多服务商 + providerCatalog + 节点级 provider/model/size + vision 路由 | M 为主（核心已覆盖；C 的目录刷新/切换安全门更细） |
| 热改 | config.edit SetModel/SetServiceTier 逐字段热改（config_processor） | 设置热重载（permission.defaultPreset 双写 settings.yaml 热重载；preset/工具许可改动即生效） | 相当 |

## D5 审计与日志

| 子项 | Codex | MTNode | 判定 |
|---|---|---|---|
| 会话转录 | `~/.codex/sessions/<YYYY>/<MM>/<DD>/<id>.jsonl` 全量 JSONL（rollout recorder，.zst 压缩 + reverse scanner + search）；exec 默认同落盘，`--ephemeral` 关闭；state_db sqlite 元数据 | agentSessionId 多轮历史在节点内；无全量转录文件、无重放 | C |
| 回滚/还原 | thread-store rollback_replay（ModelReplayPlanner 按 Compacted/Rollback/Turn 记录回放）；rollout_reconstruction 从账本重建活动段 | **回滚账本**：main.js 唯一落盘（sha256 内容寻址对象库 + rounds/<sessionId>/<rid>.json），捕获文件/canvas/db/shell 四类（shell 只计数），afterHash 守卫 + 逐条如实报告 | M（对象级还原对画布用户更直接；Codex 回的是模型状态） |
| 遥测 | otel/analytics 事实流（TurnTokenUsage/Compaction*/GuardianReviewed…，默认关） | 无遥测（本地优先，数据不出机） | X（隐私取向不同） |
| 审计查询 | rollout search/索引；hooks 旁路 | db 事实库 query_log 审计（mtnode_db 记录）；回滚账本可逐 rid 查看 | M（局部） |
| 网络代理审计 | NetworkProxyAuditMetadata | 无 | C |

## D6 上下文 / 记忆管理

| 子项 | Codex | MTNode | 判定 |
|---|---|---|---|
| 自动压缩 | CompactTask + `compact.rs`：`InitialContextInjection{BeforeLastUserMessage,DoNotInject}`（轮中 vs 轮前/手动压缩差异）、`COMPACT_USER_MESSAGE_MAX_TOKENS=20_000`（compact.rs:63/74）、token 预算窗口记账（auto_compact_window/rollout_budget）、远程压缩 v1/v2、pre/post compact hooks | 无自动压缩轮；长 agent 会话靠多轮历史同步 + 用户手动开新轮 | C（显著差距，最值得投入方向之一） |
| 差分注入 | `WorldState` 17 分节（agents_md/environment/permissions/tools/model/personality/…）每轮只重注变化分节，不变 0 token（world_state/mod.rs + 各节 snap 测试）；TurnDiffEvent 广播 | systemPrompt 分段拼装（宿主提示/内置技能索引/db 接地注记/语言口味/工具策略/node 能力注记）**每轮全量拼接**；长技能索引/宿主长文重复计费 | C（可直接借鉴「分节 diff」思想改 systemPrompt 装配） |
| 增量续传 | client.rs：同一 websocket 会话内仅重发增量 item（baseline 不重发、previous_response_id 续接、response_items_equal_ignoring_internal_metadata） | dsh 多轮会话走整轮消息重发（见 D8）；无服务端基线续传协议 | X/C（协议由服务商决定，MTNode 侧空间小） |
| 记忆 | memories/ + `/memories`（早期/实验） | **db 事实库**：SQLite+FTS5 BM25 中英词元化 + mtnode_db 六动作 + calc 递归下降无 eval + 接地纪律（断言带 [记录id·标题]、查无明示） | X（思路不同：MTNode 用结构化事实库接地，可当更强的记忆层） |

## D7 非交互与批处理执行

| 子项 | Codex | MTNode | 判定 |
|---|---|---|---|
| CLI 非交互 | `codex exec [PROMPT]`（stdin/-）、`exec resume/fork/review`、退出码 0/1/2 语义（exit_status.rs）；`--skip-git-repo-check`/`--ephemeral` | 无 CLI 触发面；画布 ▶ + 计划执行器（节点批跑）；外部可经 net_recv/execute 触发 | C（MTNode 无 CLI 需求面，桌面内闭环） |
| 机器契约输出 | `--json` JSONL 事件流（thread/turn/item/command_execution/file_change/mcp_tool_call/web_search…，exec_events.rs）；`-o` 写末条消息；`--output-schema` 约束最终结构 | 运行轨迹在 UI 内；无机器可读事件流/结构约束导出 | C（可借鉴：给计划执行器加运行结果 JSONL/结构导出，接 CI） |
| 批处理编排 | 无 batch 语义；queue 投递单消息；后台终端 `/ps` | **batchMode batch/agg**（batch=每项 1:1 防 N²，纪律已成文）+ split/merge + task/judge/sequencer/gate/splitter/counter/mutex + control run 一键重跑 | M（MTNode 独有可视批处理面） |
| 定时/触发 | 无画布 timer；cron 面弱 | timer（once/interval/cron）+ delayer + wait_file + net_recv/net_send + execute 节点 | M |
| 产物落盘 | `codex apply`/`-o`/git | save 节点按端子 kind 自动选型落盘（.yaml/.png/.wav/.mp4）；save_* 只在普通 proc 后（agent 自写文件）；remotion 需下游 save | M（画布产物链更直观） |

## D8 错误重试与恢复

| 子项 | Codex | MTNode | 判定 |
|---|---|---|---|
| 整轮重发 | 无「整轮用户消息重发」产品化闸 | **dshRunTask 最外层 5s×5**（DSH_RETRY_DELAY_MS=5000/DSH_RETRY_MAX=5，app-db.js 1583-1661）：失败→`dshRunRetryable` 判据（取消/配置类不重发）→等 5s 原样重发整轮（同 input/runKey）；等待可打断、重发轮 traceReset 清残文、UI toast 计数 | M（MTNode 独有且比 Codex 更产品化：429 不跳下一个任务） |
| 请求层重试 | responses_retry.rs 连接/采样双预算 + 指数退避 + handle_retryable_response_stream_error | 引擎内 `@deepseek-ai/dsh-llm-retry` 单次请求重试（cordis.yml） | 相当（双层分工同构） |
| 断点/重建 | rollout_reconstruction 从账本重建活动段；exec resume/fork 断点续跑；thread-store 回放 | wait_file「等文件产物就绪再放行」控制原语；崩溃后节点运行中状态无重建 | C（可借鉴账本重建/断点续跑） |
| 取消/打断 | Interrupt Op + abort 生命周期 + cancellation_token | 取消句柄先占「本轮在途」（dshRetryWait）；ix-drop 撤卡（reqId 空 = 全局撤卡）；run/cancel 协议成对 | 相当 |

---

## 附 1：证据核对清单（本次回核的两侧源码锚点）

Codex 侧（`%TEMP%\codex-review\codex-rs\`）：
- `core/src/tools/spec_plan.rs`：`build_tool_router`（L125 定义、L358 次入口、L487 `ToolRouter::from_parts`）、`use crate::tools::router::ToolRouter`（L62）✅
- `protocol/src/protocol.rs`：`enum AskForApproval` **L984**；approval_policy 字段多处（L530/2199/3218/3882）✅
- `protocol/src/config_types.rs`：`enum SandboxMode` **L104**、`enum ApprovalsReviewer` **L183**（User/AutoReview 序列化测试 L867-884）✅
- `core/src/agents_md.rs`：`AGENTS.override.md`（L42）、`project_doc_max_bytes` 限额（L65）、project_root_markers 发现（L22/202-213）✅
- `core/src/compact.rs`：`COMPACT_USER_MESSAGE_MAX_TOKENS = 20_000`（L63）、`enum InitialContextInjection`（L74，BeforeLastUserMessage L100/DoNotInject L115）✅
- `core/src/client.rs`：`fn reasoning_effort_for_request`（L186，调用点 L809/915）✅
- `cli/src/main.rs`：`enum Subcommand`（L147）含 Exec(L153)/MCP(L164)/MCP-server(L170)/Resume(L207)/Queue(L210)/Fork(L225)/Execpolicy(L200)/ExecServer(L240)；execpolicy 子命令实现（L990）✅
- 存在性：`core/src/guardian/approval_request.rs`、`exec/src/exec_events.rs`、`tui/src/bottom_pane/approval_overlay.rs` ✅

MTNode 侧（项目根）：
- `renderer/app-db.js`：`DSH_RETRY_DELAY_MS = 5000`（L1583）、`DSH_RETRY_MAX = 5`（L1584）、`dshRunRetryable`（L1587）、`dshRetryWait`（L1606）、整轮重发循环（L1630-1661）；`nodeLock`（L1708）、`agentToolPolicySystemNote`（L1738）、node 档判定（L1754-1760）✅
- `dsh/gateway/cordis.yml`：mtnode-bridge(L56)/mtnode-canvas(L60)/mtnode-rollback(L68)/mtnode-db(L74)/mtnode-tools(L82) 插件行，均带 `MTNODE_PURE/CHAT_ISOLATE` 门控 ✅
- `renderer/app-nodes.js`：`mtnode-unattended` 预设项（L8885）、默认回落（L8894/8900/9468/9518）✅
- `db-store.js`：`CREATE VIRTUAL TABLE IF NOT EXISTS records_fts USING fts5(...)`（L70）、BM25 查询（L187-188）、`function dbCalcExpr`（L329）✅
- `renderer/app.js`：NODE_DEFAULTS 含 proc_text(L634)/agent_task(L793)，judge 归「控制节点」组（L16978），KINDS 分组表（L14046-14089）✅
- 存在性：`fn-runtime.js`（函数节点 worker）、`media-gen-global-lock.js`（音视频全局互斥）✅

## 附 2：口径与未比项

- Codex 快照 = main 分支某时刻（0.0.0-dev）；MTNode = 根 version 1.2.4。两方演进都会使行号过期，判定以机制为准。
- 未纳入对比：UI/终端渲染像素级细节、Codex 桌面 App/Cloud/IDE 面、MTNode 的媒体生成后端质量（music3/tts/h3/remotion 属产品业务，Codex 无对应物）。
- 「MTNode 已有或更优（M）」均指已有真实代码形态（见 MTNode-现状能力表 A–I 域），非规划中能力。
