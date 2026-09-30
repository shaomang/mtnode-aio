# 会话答案进上下文（2026-09-29 21:0x–21:2x）

需求（本模块）：解决会话中「用户的回答未进会话上下文」——任务暂停 / 中断 / 重新起轮后
丢失用户此前给出的全部回答。

一切命令在仓库根 `E:\dev\tools\pipeline-console` 下执行。

## 1. 现场证据（改动前）

| 事实 | 证据 |
| --- | --- |
| 询问窗答案只经交互帧回运行时，**从不进会话消息** | `renderer/app-db.js` `ixAnswerQuestion` 只调用 `window.api.dshInteract({kind:"question", …})`，成功分支只有 `ixDrop`；全仓无第二处处理提问回执（`grep ixAnswerQuestion` 仅此定义 + 开卡处调用） |
| 渲染层每轮的用户输入是拿 `st.messages` 拼的 | `renderer/app-assist.js` `agentSessionSend`：`hist = rbHistSrc.slice(0,-1).slice(-20).map(m => …m.content)`，`input = resumeRound \|\| !hist ? latest : hist + "\n\n用户(最新)：" + latest` |
| 续跑轮（暂停后点「继续」）**完全不带 hist** | 同上：`resumeRound = !!opts.resumeSession`，命中即 `input = latest`（只有一句「从中断处接着写」）。运行时不在了 → 网关 `RESUME_UNAVAILABLE` → 宿主用**原始 input**（仍旧没有 hist）整轮重发 |
| 开发 / 细化绑定会话的追问被首条 kick 顶掉 | 改动前 `if (devContractMsg) { t = 第一条 _src:"dev-node" 的 content }` —— 追问轮（`agentSessionSend(txt,{sessionId})` 带 `_devContract:true`）实际发给模型的永远是第一轮的开发需求 |
| 运行时盘上日志口径（含工具结果） | 本机 `dsh-home/sessions/<projectKey>/<sid>/session.jsonl.zstd` 多帧解压后含 `user/message` · `tool/call` · `tool/result` · `assistant/chunk`（单会话实测 1557 条记录）；跨进程续跑由 `dsh/gateway/plugins/session-resume-server.mjs` 的 `agents.resume` 整读该日志恢复 |

## 2. 改动（限渲染层会话链路）

| 文件 | 改了什么 |
| --- | --- |
| `renderer/app-db.js` | 新增 `ixAnswerSessionOf` / `ixAnswerPairsOf` / `ixAnswerBubbleText` / `ixCommitAnswerToSession`：提问**提交成功**后把「问题 → 所选答案（含手填）」写成一条 `role:"user"`、`_src:"ix-answer"`、带 `_ixQids` 的会话消息并 `persistAgentSession()`；失败 / `stale` 不落库。新增 `agentHistoryEntries`（会话历史段：同文去重、回答气泡按题 id 取最新、任务书 kick 不进段、整段字符上限）与 `agentConfirmedHistoryEntries`（续跑兜底只带用户侧确认过的记录） |
| `renderer/app-assist.js` | hist 装配改走 `agentHistoryEntries`（回答气泡因此每轮随上下文重发）；续跑轮在「判据不足」（`opts.resumeSession` 有但宿主没有可续跑登记）时把「已确认」段拼在续跑指令后，并写明不得重复提问；开发会话 kick 回落加 `!t` 条件（追问原样发出） |
| `renderer/i18n.js` | 三条词条中英齐备：`【我对上面问题的回答】` / `（未作答）` / `【用户已确认的部分（续跑兜底 · 这些答案已生效，不要重复提问）】` |
| `test/smoke-session-answer-context.js` | 新增用例（49 项） |

未改：网关 `dsh/**`、dsh 会话日志口径、工具列表、画布（本会话不读也不改画布）、旧会话数据。

## 3. 验证

| 命令 | 结果 |
| --- | --- |
| `node test/smoke-session-answer-context.js` | **全部通过（49 项）** |
| `node test/run-all.mjs --only=smoke-session-answer-context,smoke-systemprompt-sections,smoke-token-budget,smoke-ask-panel-top,smoke-session-steer-pause,smoke-session-items,smoke-session-auto-title,smoke-agent-lang` | **8 只全绿**（systemprompt-sections 187 项 / token-budget 231 项 / session-items 52 项 / ask-panel-top 41 项） |
| `node test/run-all.mjs`（全量） | 172 只：**pass 154 · fail 18 · timeout 0**；日志 `%TEMP%\mtnode-smoke-logs\20260929T130230\summary.txt` |

18 只红灯与本次改动无关（逐只核对报错点均落在别处，且与 `docs/reports/smoke-regression-2026-09-29.md` 记录的既有失败同名）：
`smoke-agent-preset-lean`（EFFORTS 未定义）`smoke-assets`（手册入口）`smoke-dev-suggest`（缺 CHANGELOG-v1.1.md）
`smoke-filepeek`（既有词条「还有」英文双值 CLASH）`smoke-image-mask-edit` `smoke-plan-dialog` `smoke-ratio-lock`
`smoke-rel-layout` `smoke-session-canvas`（手册章节 / app 帧路由）`smoke-team-i18n` `smoke-team-model` `smoke-team-recruit`
`smoke-token-report.mjs`（openRoundPerfDialog 缺失）`smoke-tools`（ROOT 未定义）`smoke-two-pass-matte` `smoke-video-post`（波动项，本次转绿）
`smoke-wf-view-memory`（手册章节）`smoke-yue`（控制线端口 3）。

## 4. 行为口径（用户确认过的取舍）

1. 提交成功即刻落库并上屏（用户消息气泡），失败 / stale / 「稍后」不落库。
2. 不续跑时把该会话已确认的「询问窗答案 + 历史用户消息」拼成前置上下文段重发（题按 id 取最新、用户消息按原文去重、整段 4000 字符封顶），只进模型上下文、界面不多显一段。
3. 所有会话统一生效（普通 / 开发·细化绑定 / 长周期任务引导），不加设置开关，不动旧数据。
