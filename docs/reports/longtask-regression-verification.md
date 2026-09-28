# 长周期任务 · 回归验证报告（冒烟 + 既有红灯归属）

- 验收对象：长周期任务模块（`longtask-store.js`、`renderer/app-longtask.js`、`renderer/app-longtask-ui.js`、`renderer/css/longtask.css`、`dsh/gateway/longtask-plugin.mjs`、`dsh/gateway/plugins/session-steer-server.mjs`、`guides/manual/longtask.md`、`test/smoke-longtask.js` 与其在 `main.js` / `preload.js` / `renderer/index.html` / `renderer/app.js` / `renderer/app-canvas.js` / `renderer/i18n.js` / `build.json` 的接线）
- 本轮只做回归验证：不改任何源码、不跑构建、不装依赖。全部证据为本机真跑，日志在 `%TEMP%\lt-regress\`（本模块相关）与 `%TEMP%\lt-regress-full\`、`%TEMP%\lt-reds2\`（全量套件与红灯复跑）。
- 运行环境：Node v24.2.0（`node --check` / 纯 Node 冒烟）、Windows、仓库 `E:\dev\tools\pipeline-console`。

## 一、结论

1. **任务列出的 9 个冒烟全部全绿（合计 1037 项断言，exit 全 0）**；另附 3 项模块敏感冒烟同绿（`smoke-session-steer-pause` 196 / `smoke-toolbuild` 120 / `smoke-canvas-scope` 69）。
2. **静态检查通过**：改动 / 新增的 87 个 JS 中 86 个过 `node --check`（唯一例外是未跟踪临时探针 `.tmp-pdfseq.js`）；5 个改动 JSON 全部解析通过；本模块 6 份 JS 全部 exit 0。
3. **既有红灯 14 个（全 `.js` 套件）+ 1 个额外 `.mjs`（`smoke-token-report.mjs`）**，两次独立复跑（`lt-reds2`）全部 exit=1 且根因一致。逐条归属证据见第三节：**没有一条的失败对象落在本模块的改动面内**；其中 9 条与本模块无关的红灯在 **2026-09-11 的既有基线**里就已存在（早于本模块全部产物的最早时间 2026-09-14 17:52）。

## 二、本模块相关冒烟（重跑结果）

| 测试 | 断言量 | 结果 |
| --- | --- | --- |
| `test/smoke-longtask.js`（本模块主冒烟：存储 / 装配 / 网关契约 / 交付节点 / 引擎真行为 / 条带） | 150 项 | ✅ 全部通过（exit 0） |
| `test/smoke-session-steer-pause.js`（同模块 steer 服务端） | 196/196 | ✅ 全部通过 |
| `test/smoke-node-settings.js` | 251 checks | ✅ ALL OK |
| `test/smoke-team-perms.js` | 50 checks | ✅ ALL OK |
| `test/smoke-token-budget.js` | 214 项 | ✅ 全部通过 |
| `test/smoke-dialog-persistence.js` | 54 项 | ✅ 全部通过 |
| `test/smoke-dialog-minimize.js` | 63 checks | ✅ ALL OK |
| `test/smoke-topbar-buttons.js` | 26 项 | ✅ 全部通过 |
| `test/smoke-pdf-gen.js` | 135 项 | ✅ 失败 0 项 |
| 技能索引口径（`test/smoke-music-skills-builtin.js`：内置库 / 索引条目 / 紧凑索引 / 工坊下架） | 94 checks | ✅ ALL OK |
| `test/smoke-toolbuild.js`（附加） | 120 checks | ✅ ALL OK |
| `test/smoke-canvas-scope.js`（附加） | 69 项 | ✅ 全绿 |

跑法（纯 Node，无 Electron）：
```powershell
cd E:\dev\tools\pipeline-console
node test/smoke-longtask.js   # 其余同理逐个跑
```
> 说明：本仓没有「技能索引」同名的冒烟文件；技能索引口径由 `test/smoke-music-skills-builtin.js` 覆盖（它直接读 `mtnode-agent-skills/index.json` 与 `mtnode-agent-skills-lib.js` 的紧凑索引，断言条目名 = front matter name、`.builtin` / `.mtnode-internal` 归属、长度预算），本轮取它作为「技能索引」项。

## 三、静态检查

- `node --check`：`git status` 里全部 87 个改动 / 新增 JS 逐个检查，**86 通过**。
  - 唯一失败：`.tmp-pdfseq.js`（**未跟踪的临时调试探针**，第 7 行模板字符串未闭合；非产品源码、非本模块产物，未删——超出本轮范围，建议随手清掉）。
  - 本模块 6 份 JS 单独复核全部 exit 0：`longtask-store.js`、`renderer/app-longtask.js`、`renderer/app-longtask-ui.js`、`dsh/gateway/longtask-plugin.mjs`、`dsh/gateway/plugins/session-steer-server.mjs`、`test/smoke-longtask.js`。
- JSON 解析：改动 JSON 5 个全部通过 —— `ext-repo/catalog.json`、`guides/manual/index.json`、`guides/nodes/index.json`、`mtnode-agent-skills/index.json`、`plugins/catalog.default.json`。

## 四、既有红灯（14 个 `.js` + 1 个额外 `.mjs`）与归属证据

归属口径（三档证据，逐条给出）：
- **E1 对象零改动**：失败断言读的文件相对 `HEAD` 零改动（`git status` 干净）→ 任何工作区改动都不可能造成。
- **E2 非本模块面**：失败断言的对象文件里 **长任务符号引用数 = 0**，或本模块在该文件的改动只有一行注释 / 一条 `kind deliver` 登记，失败符号与该改动无关。
- **E3 早于本模块的基线**：2026-09-11 的既有运行记录里已有同一失败（`%TEMP%\mtnode-test-scan.txt` 09:15:48；`%TEMP%\fail-head.txt` / `fail-mine.txt` 11:05:21），而本模块全部产物最早为 2026-09-14 17:52（steer 服务端），其余为 2026-09-15（报告 11:00、store 10:53、应用层 11:02–11:03），且这些文件在 git 中是未跟踪 / 新增。**基线早于本模块存在**。

| # | 测试（均 exit=1，两次复跑一致） | 失败断言 / 根因 | 失败对象 | 归属证据 |
| --- | --- | --- | --- | --- |
| 1 | `smoke-agent-preset-lean.js` | `FAIL 定位到 EFFORTS/normalizeEffort 块`；`ReferenceError: EFFORTS is not defined` | `dsh/gateway/gateway.mjs`（思考档归一表 / 压档机制被拆） | E2（该文件长任务引用 0，本模块未改它）+ E3（09-11 基线同条红） |
| 2 | `smoke-assets.js` | `FAILED 2 / 482`：手册页未写「文本也一样能上传本机文件」/ 英文页不同步 | `guides/manual/asset-library.md`、`guides/manual/en/asset-library.md` | **E1**（两文件相对 HEAD 零改动）+ 素材模块文档面 |
| 3 | `smoke-dev-suggest.js` | `FAIL 要求按两段式规范回写概述与状态` + 崩溃 `ENOENT CHANGELOG-v1.1.md` | 细化 brief 文案 + 仓库中不存在的 `CHANGELOG-v1.1.md` | E2（文案真源在 `app-devnode.js` / `app.js`，与长任务无关）+ E3 |
| 4 | `smoke-global-refs.js` | 崩溃 `ReferenceError: runImagePaths is not defined`（测试自建 `global-refs-extract.js` 的提取清单未跟上源码） | `renderer/app-nodes.js`、`renderer/app.js` 的 buildSpec / 图像引用链 | **E2**（`renderer/app-nodes.js` 长任务引用 = 0，本模块从未改该文件） |
| 5 | `smoke-image-mask-edit.js` | `✗ 4 / 121`：`ensureMaskPrereqs` / `maskSourceImagePath` / 有蒙版时 size 钉首张参考图 | `renderer/app-nodes.js` + 新增未跟踪 `renderer/app-mask.js` | E2（同上，app-nodes.js 零长任务引用；蒙版模块在制品） |
| 6 | `smoke-plan-dialog.js` | 崩溃 `ENOENT CHANGELOG-v1.1.md`（测试 `:771`） | 仓库中不存在的 `CHANGELOG-v1.1.md` | E3（09-11 基线同文件同行号已红）+ 顶部 12 项「计划」断言全绿（无一条关于长任务；测试里的 `planDelivered` 与交付节点无关） |
| 7 | `smoke-privacy-page.js` | 崩溃 `ENOENT docs/msix-store-publish.md` | 仓库中不存在的 `docs/msix-store-publish.md`（AGENTS.md 仍指向它） | 文档缺口 + E3（09-11 基线同条红） |
| 8 | `smoke-ratio-lock.js` | `✗ 1 / 124`：`return cropRatioLockOutput(...)` 位置断言（裁回须排在抠图之后） | `renderer/app-nodes.js` 出图收尾链 | **E2**（app-nodes.js 零长任务引用；抠图 / 画幅模块在制品） |
| 9 | `smoke-rel-layout.js` | 2 项：仍在建 `n-port-label` 板外文字（canvas.css / theme-light.css / app-canvas.js）+ 分层排版指标 | 端子排 DOM/CSS 与排版度量 | E2（`canvas.css`、`theme-light.css` 长任务引用 0；本模块在 `app-canvas.js` 只留一行注释）+ E3（09-11 已红，当时 1 项） |
| 10 | `smoke-session-canvas.js` | `✗ 21 / 183`：手册「会话属于哪张画布」小节 + `app-assist` / `app-agent` 口径 + `_write.mjs` 模板同口径 | `guides/manual/*`、`guides/nodes/_write.mjs`、`renderer/app-assist.js` | E2（`app-assist.js` 零长任务引用）+ E3（09-11 已红，当时 9 项） |
| 11 | `smoke-team-i18n.js` | `FAILED 10 / 122`：`one-person-company.md` 缺「画布锚点 / 空心线条 / 管理分类 / 39 个模板」等 | `guides/manual/one-person-company.md`、`en/one-person-company.md`（新增未跟踪页） | E2（属专家团手册页）+ E3（09-11 已红，当时 3 项） |
| 12 | `smoke-wf-view-memory.js` | 2 项：手册未写「切 Tab 保留位置」/ 英文页不同步 | `guides/manual/workflows.md`、`en/workflows.md` | **E1**（两文件相对 HEAD 零改动）+ E3（09-11 同条红） |
| 13 | `smoke-two-pass-matte.js` | 崩溃 `ReferenceError: maskPromptSuffix is not defined`（测试自建 extract 未含该函数） | `renderer/app.js` 的双通道抠图提示词后缀 | E2（`maskPromptSuffix` 是抠图函数；本模块在 `app.js` 的改动只有 `:211-213` 的 `kind deliver` 登记注释 + 条带挂载） |
| 14 | `smoke-workspace-project.js` | `✗ 1 / 94`：`app.js` 与 `app-agent.js` 的 `dshWorkspaceOf` 逐字一致 | `renderer/app.js` vs `renderer/app-agent.js` | **行尾工件**：两段正文逐字相同，仅行尾不同（`app.js` 全 LF / `app-agent.js` 全 CRLF；归一化后 `equal=true`）。本计划被编辑的多份文件（`app-assist.js` / `app-nodes.js` / `i18n.js` / `index.html` / `main.js` / `preload.js`）同样是 LF——是编辑器产物，非长任务行为改动 |
| 15 | `smoke-token-report.mjs`（**额外的 .mjs**，不在 14 个 `.js` 内） | 8 项 `FAIL`（`tok-round-table` / 按轮次逐轮行 / `openRoundPerfDialog`…全不存在）+ `TypeError: ctx.openRoundPerfDialog is not a function` | `renderer/app-cost.js`（新增未跟踪） | E2（该文件长任务引用 0）+ E3（`%TEMP%\fail-head.txt` / `fail-mine.txt`，2026-09-11 11:05，已记录同样的 8 行） |

### 证据文件

| 证据 | 路径 | 时间 |
| --- | --- | --- |
| 既有红灯基线（12 条，含本表 1/2/3/6/7/9/10/11/12） | `%TEMP%\mtnode-test-scan.txt` | 2026-09-11 09:15:48 |
| 令牌轮次表既有红灯（本表 15 的 8 行） | `%TEMP%\fail-head.txt`、`%TEMP%\fail-mine.txt` | 2026-09-11 11:05:21 |
| 本轮 9 项模块相关冒烟日志 | `%TEMP%\lt-regress\*.log` + `summary.txt` | 本轮 |
| 本轮全量套件日志（107 个 `smoke-*`） | `%TEMP%\lt-regress-full\*.log` | 本轮 |
| 红灯复跑日志（15 项） | `%TEMP%\lt-reds2\*.log` + `summary.txt` | 本轮 |

## 五、未做 / 说明

- 未跑需要 Electron 真窗口的探针（`.tmp-lt-accept.js` 等临时件），未跑 `smoke.js`（`require ./main.js`）；本轮按任务只跑冒烟与静态检查。
- 未改动任何源码、未删除任何临时文件（含 `.tmp-pdfseq.js`）。
- 若上游的「14 个红灯」来自只扫 `test/smoke-*.js` 的口径，则与本报告第 1–14 行**完全对齐**；`smoke-token-report.mjs` 是本轮额外发现（`.mjs` 口径之外的第 15 条）。
