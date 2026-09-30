# 全量冒烟回归与交付说明（2026-09-29 06:03–06:06）

回归范围：当前工作区快照（含本批浏览器 / 右栏、BA 跟随与会话、侧栏分界线、弹窗持久化等新增与改动用例）。
一切命令都在仓库根 `E:\dev\tools\pipeline-console` 下执行，`node test/run-all.mjs` 逐只 spawn `node test/<case>`。

## 1. 结论

- 全量：`node test/run-all.mjs` → 跑 164 只（test/ 下 165 个 `smoke-*`，其中 `smoke-db-dsh.mjs` 属 MANUAL 默认跳过），**pass 145 · fail 19 · timeout 0 · spawn-error 0**。
- **失败集合与改动前逐只相同，且未新增既有用例的失败**；多出的 1 只红灯是**本批新写的用例 smoke-browser-rail.js**（其 [9]/[11] 两节 2026-09-29 05:59 才写入，改动前基线里根本不存在这两节）。
- 改动前基线 = 本机最近一次全量记录 `%TEMP%\mtnode-smoke-logs\20260928T214305\summary.txt`（本地 2026-09-29 05:43，164 只，pass 146 · fail 18）。基线 18 只失败名与本次**逐只同名**（含波动项 smoke-video-post.js），差集就是 smoke-browser-rail.js 这一只。
- 既往既有失败 17 只（从 2026-09-15 的多次全量起就一直在，与本次改动无关）：
  `smoke-agent-preset-lean` `smoke-assets` `smoke-dev-suggest` `smoke-filepeek` `smoke-image-mask-edit` `smoke-plan-dialog` `smoke-ratio-lock` `smoke-rel-layout` `smoke-session-canvas` `smoke-team-i18n` `smoke-team-model` `smoke-team-recruit` `smoke-token-report.mjs` `smoke-tools` `smoke-two-pass-matte` `smoke-wf-view-memory` `smoke-yue`。
- 波动项 1 只：`smoke-video-post.js`（基线最近 5 次全量里 3 红 2 绿；本次连跑 3 次全红，失败点固定在「目标长边被压到预算内（960px…）」，与浏览器改动无关）。

## 2. 命令、结果与日志路径

| 命令 | 结果 | 日志 |
| --- | --- | --- |
| `node test/run-all.mjs --log-dir=.tmp-smoke-adjacent browser ba-follow ba-session side-divider-drag dialog-persistence` | 7 只：pass 6 · fail 1（smoke-browser-rail） | `.tmp-smoke-adjacent\summary.txt`（各只日志同目录） |
| `node test/run-all.mjs --log-dir=.tmp-smoke-regress` | 164 只：pass 145 · fail 19 | `.tmp-smoke-regress\summary.txt` + 164 个 `<case>.log` |
| `node test/run-all.mjs --log-dir=.tmp-smoke-recheck2 video-post browser-rail` | 2 只：均 fail（复现确认） | `.tmp-smoke-recheck2\summary.txt` |
| 改动前基线（历史记录，非本次执行） | 164 只：pass 146 · fail 18 | `%TEMP%\mtnode-smoke-logs\20260928T214305\summary.txt` |

`.tmp-*` 命中 `.gitignore`，日志与报告不污染仓库。

## 3. 新增 / 改动用例逐条证据

单只用例的复现命令统一为 `node test/run-all.mjs <名字子串>`，或直接 `node test/<文件>`；下面「关键输出」取自 `.tmp-smoke-regress\<case>.log` 的行尾战果行。

| 用例 | 类别 | 关键输出 | 结论 |
| --- | --- | --- | --- |
| `smoke-browser.js` | 新增（浏览器工具 / 策略 / 白名单） | `全部通过：195 项` | pass |
| `smoke-browser-view.mjs` | 新增（实况流启停） | `ok stopViewStream 后不再有画面帧（44 → 44，只多一条 stop 状态）` / `全部通过` | pass |
| `smoke-browser-rail.js` | 新增（右栏自动开栏 / 模式控件） | `FAILED 2`（见 §4） | **fail** |
| `smoke-ba-follow.js` | 新增（BA 跟随键面状态） | `ok 重画回当前状态的键面文字（applyDom 碰不到它）（得到 "停止跟随"）` / `全部通过` | pass |
| `smoke-ba-session.js` | 新增（BA 会话驱动） | `ok 每一条都真发出去了（没有哪条被吞）（得到 6）` / `全部通过` | pass |
| `smoke-side-divider-drag.js` | 新增（侧栏分界线拖拽 / 落盘） | `ok 恢复的还是记忆里的 520（视图切换这条链没被改坏）（得到 "520px"）` / `全部通过` | pass |
| `smoke-dialog-persistence.js` | 相邻（弹窗持久化口径） | `✓ 全部 54 项通过` | pass |
| `smoke-exec-node-body.js` | 新增（执行节点正文 / i18n） | `ok i18n.js 有词条：正在启动…` / `ALL PASS 33 checks` | pass |
| `smoke-node-port-divider.js` | 新增（端子刻线） | `ok 有端子时的两排凹陷刻线仍在（只对无端子侧关）` / `ALL PASS 22 checks` | pass |
| `smoke-relay.js` | 新增（转发 / 密钥不外泄） | `ok 日志里不出现任何上游 Key 材料` / `✓ 全部 67 项通过` | pass |
| `smoke-apps.js` | 改动 | `PASS 369 项检查` | pass |
| `smoke-assets-tool.js` | 改动 | `✓ 全部 113 项通过` | pass |
| `smoke-recharge.js` | 改动 | `✓ 全部 275 项通过` | pass |
| `smoke-token-budget.js` | 改动 | `✓ 227 项全部通过` | pass |

## 4. 唯一新增红灯：smoke-browser-rail.js（2 条断言）

复现（三次同结果，可复现，非抖动）：

```
node test/run-all.mjs browser-rail
node test/run-all.mjs --log-dir=.tmp-smoke-recheck2 browser-rail
```

关键输出（`.tmp-smoke-regress\smoke-browser-rail.js.log`，第 42 / 54–61 行）：

```
[9] #baLiveModeBtn 的 onclick 真能切 docked / detached
FAIL  点一下 → detached（真调到了 BA 的实现，不是空转） [mode=docked]
[11] bindLive 里某个控件抛错，也不许跳过「画布已绑定」与后续接线
FAIL  滚轮真的送到了网关（viewInput 被调 0 次，不是只挂了个死回调）
FAILED 2
```

根因（只读核查，未改动任何源码）：

1. `[9]`：`test/smoke-browser-rail.js:279-282` 同步调用 `btn.onclick()` 后**立即**断言 `BA.live.mode === "detached"`；而 `renderer/app-browser.js:878` 的 `BA.liveToggleMode` 返回 `BA.liveSetMode(...)`，该函数 `app-browser.js:854-862` 是 `async`，`mode` 要等 `await window.api.dshBrowserViewMode(...)` 之后才落位 → 断言时仍读到 `docked`。用例少一次 `await tick()`（或实现改为同步先落 `mode`），两者取一即可。
2. `[11]`：`test/smoke-browser-rail.js:350-356` 直接取 `_on.wheel[0]` 派发滚轮并期望 `viewInput > 0`；但 `renderer/app-browser.js:687-689` 的 `BA.liveInput` 首行是 `if (!BA.live.on) return;`，该节只 `makeApp({ running: true })`、未触发浏览器活动，实况流没开（`live.on === false`）→ 网关侧 `viewInput` 自然 0 次。前两节先开流再发事件的写法是对的，这一节缺同样的前置。

处置建议：这两条落在本批新写的用例与其实现（`renderer/app-browser.js` + `test/smoke-browser-rail.js`，均为 2026-09-29 05:59 的版本）之间，归属方二选一改一处；本任务只做回归取证，未改代码。

## 5. 本次回归钉住的快照（SHA-256 前 12 位）

| 文件 | 哈希 |
| --- | --- |
| renderer/app-browser.js | D8330C017A2C |
| renderer/app-assist.js | 42071F096FC7 |
| renderer/app.js | 81A6917CFE3D |
| renderer/index.html | C562F824CCB7 |
| renderer/i18n.js | 9CFBB26D6E56 |
| test/smoke-browser.js | 570E12C822F2 |
| test/smoke-browser-rail.js | F9EB5E27A36C |
| test/smoke-browser-view.mjs | 205DC6EB8ABD |
| test/smoke-ba-follow.js | 1673C6BC4D3D |
| test/smoke-ba-session.js | 77CCA0B363C9 |
| test/smoke-side-divider-drag.js | 12A884AC3C45 |
| test/smoke-dialog-persistence.js | 7A8C37496B8C |
| test/smoke-token-budget.js | 737653B7359D |

## 6. 未验证边界（明确不做）

- **不发真实出图请求**：本回归全程离线，无任何 proc_image / 图像服务商调用；`smoke-db-dsh.mjs` 是唯一 MANUAL 用例（需真 API Key + 出网），默认跳过，本次也没加 `--include-manual`。
- **不做出网请求**：所有用例都跑在自带假体 / 纯 Node 沙箱里，不启动 Electron、不连真实网关之外的网络。
- **真机未验证**：右栏真 window dock、真实浏览器实况流（帧率 / 输入坐标换算）、超时与断流恢复这类需要真窗口 + 真浏览器的路径，用例只覆盖到「调用参数与调用次序」（`viewStart` / `viewInput` / `viewStop` 计数），未验证真实画面。
- **回归期间有并行会话在写文件**（`renderer/app-db.js` 06:00、`dsh/DESIGN.md` 06:01、`dsh/gateway/gateway.mjs` 06:02 等），本报告的结论只对 §5 所列快照成立；若这些文件在快照之后又被改动，需重跑全量。
