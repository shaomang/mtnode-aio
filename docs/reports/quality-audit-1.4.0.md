# MTNode 1.4.0 全仓质量体检报告

- 版本真源：根 `version` = `1.4.0`（`package.json` 一致）
- 体检方式：只读扫描 → 7 段实施计划（用户确认）→ 按模块执行；每模块只在自己边界内动手
- 硬约束：**功能与用户可见行为不变**；不拆 `renderer/app.js`；不动 `*-pack/` 内部、`node_modules/`、`dist/`；不 bump 版本、不跑发版链
- 执行日期：2026-09-15（会话内时间戳 UTC 12:13–12:28）

---

## 0. 总账（七模块）

| 模块 | 结果 | 净效果 |
|---|---|---|
| ① 根目录死源 | 完成 | 删 4 个文件 / 268 KB；`build.json` 清 3 条指向不存在文件的取反 |
| ② 渲染层重复实现 | 完成（**收口时改判执行方式**，见 §1.2） | 三处静默失效的修复真正接上；两份重复实现改为逐字同步 + 行尾统一 |
| ③ i18n | 完成 | −25,618 B（重复条目 −5,823 B、死帮助文 −19,795 B）；6,222 键 `t()` 输出机器证明零变化 |
| ④ 文档 | 完成 | 版本口径归真源；README 断链清零；新建 `docs/msix-store-publish.md`（184 行） |
| ⑤ 指南 | 完成（计划里 1 项经核查是**误判**，未执行） | 补 `en/longtask.md` + `en/remotion.md`；index 登记 tool/function；堵掉「生成器吃掉手册页」的暗坑 |
| ⑥ 效率 | 完成（3 处度量成立已改，3 处度量不成立明确不改） | 保存链 −72%（2.6 MB 档）；`workflow:list` −98%；大画布 UI 线程 −46% |
| ⑦ 收口 | 聚合入口 ✅ / 报告 ✅ / **②项（跑 smoke + compile）部分未完成** | `npm test` = 110 只逐个跑，96 绿 14 红（13 只为体检前既有红）；见 §3 与 §4 |

---

## 1. 删了什么、合并了什么（附证据）

### 1.1 模块①：根目录死源（4 个，全部零引用证据在手）

| 文件 | 大小 | 零引用证据 |
|---|---|---|
| `app.js` | 176,654 B / 5,268 行 | 全仓 `require(...app.js)` / `../app.js` / `./app.js` 命中 **0**；`package.json` `main` = `main.js`；不在 `renderer/index.html` 脚本表；不在 `build.json → files`；与 `renderer/app.js`（1,181,548 B）md5 不同 = 拆分前旧副本，内含已废弃的 `gpt-image-2-vip` 尺寸表 |
| `standalone-main.js` | 57,088 B | `main.js:4` 只 `require("./pet/standalone-main.js")`；`build.json`、`scripts/patch-pet-asar.mjs` 均指向 `pet/` 版；根副本与 `pet/` 版已分叉 |
| `preload-pet.js` | 2,985 B | 唯一指向它的是上面那份 `standalone-main.js`（同批删除）；真身在 `pet/preload-pet.js`（3,530 B，与 `pet-pack/` 版同 md5） |
| `.tmp-lt-accept.js` | 34,351 B | 未入库临时探针；仅 `docs/reports/*` 三处文字提及，无代码引用 |

`build.json`：删 `!cap.js` / `!cmp.js` / `!fonttest.js`（三个文件不存在）；**保留** `:119` `"app.js"`、`:125` `"preload-pet.js"` —— 它们是 `extraResources.from = "pet-pack"` 的过滤器条目（对应 `pet-pack/app.js`、`pet-pack/preload-pet.js`，真实存在），不是根文件。改后 `files` 60 条 / `extraResources` 11 项。
保留完好：`smoke.js`（AGENTS.md 口径 `require ./main.js`）、`version.js`、`main.js`、`preload.js`、`pet/*`、`renderer/app.js`。

### 1.2 模块②：47 个同名全局函数（不是计划里说的 12 个）

`renderer/app-agent.js` 与 `renderer/app.js` 各有一份**同一整段**（`dshProvider … dshRunMaxTokens`，825 行 / 46–47 个顶层 function）。加载顺序 `index.html:422 app.js → :450 app-agent.js` → app-agent.js 那份生效，app.js 那份是被静默覆盖的死副本。逐函数取体比对，**5 处已漂移**：

| # | 函数 | 差异（死副本 → 当时生效版） | 判定 | 依据 |
|---|---|---|---|---|
| 1 | `imageInputsOf` | 认 `sensenova_gen` → 不认 | **缺陷**（修复未生效） | `sensenova_gen` 在 app.js 已是一等图像节点 35 处（输出类型 image、`.png`、与 proc_image 同支），app-agent.js 0 处 |
| 2 | `collectTaskImagePaths` | `isSuperLikeNode(src)` → 写死 `kind === "super"` | **缺陷** | `isSuperLikeNode` 定义处明写「凡按 `kind==="super"` 区分内外通道处一律用本判定」→ 工具节点（super+tool:true）图像出参取不到路径 |
| 3 | `ensureDefaultSavePath` | `save_pdf` 不预填 + 默认名带真后缀 → 旧口径（猜后缀） | **过时**（生效版落后一个发布周期） | app.js 侧该块改于 53a8bbb（2026-09-06），app-agent.js 侧停在 7cda373（2026-08-28）；注释引用的 `saveDestBaseAbs` / `pdfDefaultNameOf` 在 `app-nodes.js` 真实存在 |
| 4 | `renderSessionFooterStat` | 生效版更新（多会话累计 `cum` 块） | 死副本是搬家前旧版 | 依赖 app-agent.js 独有的 `tokViewTotals` / `fmtDurLong` / `tokBadgeTitleText` |
| 5 | `dshEffortOf` / `dshCancelActive` | 仅注释不同，函数体逐字一致 | 重复是**已知**的（原注释就写着「本文件后加载才生效」），只是没人清 | — |

**执行方式在收口时改判（重要）**：模块② 当时按「删掉 app.js 那份 + 把 1/2/3 的修复并入 app-agent.js」做，运行期三处修复确实接上了。但 110 只回归里有 **3 只把源码位置当契约**：`test/smoke-save-name.js` 按名从 `renderer/app.js` 切 `ensureDefaultSavePath` 进 vm 真跑；`test/smoke-workspace-project.js` 切 `wfWorkspace / isAbsPath / dshWorkspaceOf` 且 `[7]` 断言「app.js 与 app-agent.js 两份**逐字一致**」；`test/smoke-resume-on-retry.js [6c]` 断言两个文件各有一份 `dshCancelActive`。删除 → 这 3 只立刻红（体检当天 11:05 的基线里它们是绿的）。
收口处理：**保留 1/2/3 三处行为修复**，把该段按 app-agent.js 现文（已含修复）**逐字补回 app.js**，并把 `renderer/app-agent.js` 的行尾从 CRLF 统一成 LF（`renderer/` 其余 js 全是 LF；`core.autocrlf=true`，此改动对 `git diff` 不可见）。两边内容现逐字一致，头注释写明「另一份在哪、哪份生效、必须同步改」。
副带收益：`smoke-workspace-project.js` 体检前就是红的（94 项里 1 项：两段正文只差行尾），行尾统一后 **94/94 全绿**。

其它跨文件同名全局：`defaultToolAllow` 实际只在 `app-nodes.js:12357` 定义一次（计划里「两份」不成立）；`app-team.js` 顶层 function 声明数 0（整文件 IIFE + `window.team*`）；`pick / esc / str / T` 全是函数内局部 const；`window.LT` / `window.openLtCreateDialog` 是 `Object.assign` 增量挂载与显式包装 → 均不同作用域，未动。

### 1.3 模块③：`renderer/i18n.js`

结构真源不是「zh + EN 两份词典」，而是「键 = 中文原文，值 = 英文译文」：1 个 `EN` 字面量 + 35 个 `Object.assign(EN, {…})` 追加块 + 1 个只有 1 个键的 `ZH_EXTRA`。所以「zh/en 合法成对」这一类不存在，同键两次一律真重复。

- 条目 6,213 / 唯一键 6,076 → **重复 137 条**（同字面量内 46、跨字面量 91），其中 **38 条值与最终生效值不同**（已被静默改写）。典型：`" 个节点"` 曾有一份 `" downstream nodes"`（会污染 15 处「已删除 N 个节点」类文案，只因后面又写了三次 `" nodes"` 才被盖回去）；`"成功"` `Success→OK`、`"输入"` `In→Input`、`"工具："` `Tools: →Tool: `。
- 处置：同键只保留最后一次出现的那条（它本来就已生效）→ 纯删，映射末端状态逐字节不变（`git diff` = −146/+8，删除行中注释行 0）。
- 删除内嵌帮助文：`ZH_EXTRA["help.html"]`（10,797 B）+ `EN["help.html"]`（9,670 B）+ `ZH_EXTRA` 本体与 `t()` 里的 `else if (hasOwnProperty.call(ZH_EXTRA, key))` 分支。全仓 `git grep help\.html` 排除 i18n.js 后 **0 命中**；帮助入口早就是应用内手册（`app-settings.js openHelp() → app.js openAppDocs() → docsCatalog() → guides/manual/index.json`，10 节 21 页）。删掉的正文含「共有 4 类节点」「默认内置文本与图像两类服务商（DeepSeek 或 GPT Image 2）」等与现状矛盾的口径（画布实际 48 种 kind）。
- 机器证明：改前/改后用真实模块对全部 6,222 个键在 `en` 与 `zh` 下跑 `t(key,{n:3,k:"Ctrl+K"})` 存表比对 → `before=6222 after=6221 removedKeys=["help.html"] valueDiff=0`。
- 体积：677,394 B → 651,776 B；8,472 → 8,334 行。附带热路径收益：`t()` 少一次 `hasOwnProperty` 查找。

---

## 2. 改了哪些文档错误

**版本口径**（真源 = 根 `version`）：README「当前版本 1.2.9」→ 1.4.0 并写明真源；`AGENTS.md:3` `v1.1.28` → `v1.4.0`。

**断链**（先查为什么不存在，再决定改指/删句）：
- README → `CHANGELOG-v1.1.md`（2 处）：该文件在 `6f95935 发布 v1.3.0` 随源码同步删除 → 改指每次发版一条 `发布 vX.Y.Z` 提交（`github.com/shaomang/mtnode-aio/commits/main`）。**注意：3 处在册测试仍读这个已删文件**（`test/smoke-dev-suggest.js:540/:1760`、`test/smoke-plan-dialog.js:771`）→ 这两只当前必红，见 §3.2。
- README → `guides/manual/update.md`：zh/en 两页在 `89576cb 发布 v1.3.2` 删除，`index.json` 21 页里没有更新页 → README 里「设置 · 版本更新页」这个入口不存在（实测是顶栏 `#btnUpdate`，Store 版整条隐藏）→ 该段重写为事实描述，机制指向真存文件 `scripts/UPDATES.md`。
- `dsh/DESIGN.md:254` → `../../dsh/gateway/plugins/tool-restrict-plugin.mjs` 层级写错 → `gateway/plugins/tool-restrict-plugin.mjs`（目标文件一直存在）。
- 新建 `docs/msix-store-publish.md`（19,601 B / 184 行）：此前 README、AGENTS.md、`release-msix.cmd`、`scripts/UPDATES.md`、`test/smoke-privacy-page.js` 共 6 处引用它却无此文件（→ 那只测试必红）。内容全部按读码写实：`release.mjs` 五步 / `--store-only` / `--dry-run`；`make-msix.mjs` 十步与全部开关；`msix.config.json` 12 字段 + `loadConfig()` 的 ASCII 硬校验；`x.y.z → x.y.z.0` 与 `255.255.65535.65535` 上限；隐私政策 URL 唯一登记处（`http://mt-agent.com/mtnode/privacy/`、`npm run deploy:privacy`、nginx `location ^~ /mtnode/privacy/` 的真实原因是 `/mtnode/**` 否则被正则 `proxy_pass` 打给 OSS）；自检 8 断言 / 侧装 / Store 版禁自更新三重判定；报错-处置表。落地后 `smoke-privacy-page.js` **转绿**。
- `guides/` 面：补 `guides/manual/en/longtask.md`（20,160 B）与 `guides/nodes/en/remotion.md`（5,687 B），英文措辞逐条用 `i18n.t()` 在 `locale=en` 实测（只翻界面真翻了的，中文专属按钮按本仓 en 页既有写法保留原文 + 英文注解）；`guides/nodes/index.json` 登记 `tool` / `function`（48→50 ids）；堵掉暗坑：`guides/manual/longtask.md` 在 `index.json` 里却不在生成器 `guides/manual/_write.mjs` 的 `catalog`（README 称该 catalog 是 `index.json` 唯一真源且被无条件重写）→ 谁跑一次生成器，长任务手册页就从应用里静默消失；已补进并订正「10 章 20 页」→ 21。
- **计划里的一项经核查是误判、未执行**：把 `guides/*/en/*.md` 的 `img/xxx.svg` 改成 `../img/xxx.svg`。真源 `main.js loadMarkdownPack` 按**打包根**（`guides/manual` / `guides/nodes`）解析图片路径，且**先拒任何含 `..` 的路径**（命中即不内联）；实测 en 目录 44/44 目标文件存在于 pack 根 → 照计划改会把 44 张正常图全部改坏。真正的病灶是 `guides/manual/README.md` 那句「本目录内相对路径」→ 已按打包根口径重写并举反例。

---

## 3. 回归闸门（模块⑦ 交付物）与最终结果

### 3.1 交付

- `test/run-all.mjs`（新增）：发现 `test/smoke-*.{js,mjs}` → **逐只 `node` 跑**（不并发）、cwd 固定仓库根、计时、每只完整输出落盘、汇总最慢 5 只与全部失败的关键行；全绿退出码 0，否则 1。开关：`--only=` / `--timeout=`（默认 300s）/ `--tail=` / `--log-dir=` / `--include-manual` / `--list`。
- `package.json`：新增 `"test": "node test/run-all.mjs"`、`"test:list": "node test/run-all.mjs --list"`。
- 排除口径（写死在 runner 的 `MANUAL` 表，`--include-manual` 可强跑）：`test/smoke-db-dsh.mjs` —— 真连 DeepSeek 官方 API（要密钥 + 出网），且凭据路径硬编码到本机某用户目录，放进闸门在别的机器上必红。
- 事实订正：`test/` 下 smoke 脚本是 **111 只（107 `.js` + 4 `.mjs`）**，不是计划写的「114 个 test/smoke-*.js」；`test/` 目录总文件数才是 114（另含 `fts5-check.js`、`layout-agent-plan.js`、`auth-wechat-mock.mjs`）。退出码口径实测 **111 只全都有**（103 只 `process.exit(...)`，`smoke-codeedit` / `smoke-filepeek` / `smoke-fn-array-param` / `smoke-wechat-fastlogin` 用 `process.exitCode`，4 只 `.mjs` 同）。
- 用户点名的三只专项回归均已纳入且**全绿**：`smoke-dialog-persistence.js`（54 项）、`smoke-dialog-minimize.js`、`smoke-token-budget.js`（214 项）。

### 3.2 最终一次全量（体检后，`--timeout=240`）

`跑了 110 只：pass 96 · fail 14 · timeout 0 · spawn-error 0`（各只耗时之和 21.7s；最慢 3.3s）

| # | 红的脚本 | 一句话病根 | 归属 |
|---|---|---|---|
| 1 | `smoke-agent-preset-lean.js` | `ReferenceError: EFFORTS is not defined`：档位表已拆到 `dsh/gateway/reasoning-effort.mjs`，此脚本仍按旧块名定位 | 体检前既有（11:05 基线在册） |
| 2 | `smoke-assets.js` | 2/482：素材手册页缺「文本也一样能上传本机文件」/ 英文页不同步 | 既有 |
| 3 | `smoke-dev-suggest.js` | `ENOENT CHANGELOG-v1.1.md`（见 §2）+ 细化 brief 文案 | 既有 |
| 4 | `smoke-file-node.js` | 6≠1 颗按钮：断言切 `app-canvas.js` 里 `buildInputAnyBody → buildBody` 区间，在制品在该区间加了「转为哪种输入节点」等按钮 | 既有在制品（`renderer/app-canvas.js` 未提交工作，本体检从未改该文件） |
| 5 | `smoke-global-refs.js` | `ReferenceError: runImagePaths is not defined`（脚本自带提取清单未跟上 `app-nodes.js`） | 既有 |
| 6 | `smoke-image-mask-edit.js` | 4/121：`ensureMaskPrereqs` / `maskSourceImagePath` / 有蒙版时 size 钉首张参考图 | 既有（蒙版模块在制品） |
| 7 | `smoke-plan-dialog.js` | `ENOENT CHANGELOG-v1.1.md`（:771） | 既有 |
| 8 | `smoke-ratio-lock.js` | 1/124：「裁回排在抠图之后」顺序断言 | 既有（在制品） |
| 9 | `smoke-rel-layout.js` | 端子排仍在建「输入/输出」板外文字 + 分层排版指标（叠线 0→1、穿块 17→18） | 既有 |
| 10 | `smoke-session-canvas.js` | 21/183：手册「会话属于哪张画布」小节（zh / en / `_write.mjs` 模板三处）缺失 | 既有（口径与手册分头改动） |
| 11 | `smoke-team-i18n.js` | 10/122：`one-person-company.md` 缺画布锚点 / 空心线条 / 管理分类 / 39 个模板等 | 既有（专家团手册页） |
| 12 | `smoke-token-report.mjs` | 8 项 + `ctx.openRoundPerfDialog is not a function` | 既有（`renderer/app-cost.js` 在制品） |
| 13 | `smoke-two-pass-matte.js` | `ReferenceError: maskPromptSuffix is not defined` | 既有 |
| 14 | `smoke-wf-view-memory.js` | 手册未写「切 Tab 保留位置」/ 英文页不同步 | 既有 |

**相对基线的变化**：11:05 基线 15 只红 → 体检后 14 只红。
转绿 2 只：`smoke-privacy-page.js`（模块④ 补了它读的 `docs/msix-store-publish.md`）、`smoke-workspace-project.js`（模块② 收口时统一行尾，`[7]` 的「两份逐字一致」过了）。
新增红 1 只：`smoke-file-node.js` —— 病根在未提交的 `renderer/app-canvas.js`（文件 mtime 晚于 11:05 基线，本体检七张清单里没有它）。
零回归残留：模块② 删除该段时打红的 3 只（`smoke-save-name` / `smoke-resume-on-retry` / `smoke-workspace-project`）已全部回到绿；模块① 删除后 `node test/run-all.mjs` 全量结果与之无交集。

### 3.3 根 `smoke.js` / 应用启动 / `npm run compile`

- 根 `smoke.js`（`electron.exe smoke.js`，独立空数据目录）在模块① 与模块⑥ 各跑过改前/改后对照：106–107 行日志、可疑行取出来 `Compare-Object` **差异集为空**；尾部 5 条既有失败依旧（`wf:wire end follows mouse=false`、`Cannot set properties of null (setting 'value')`、`renderer uncaught: TypeError ... setting 'x'`、`[real-drag err]`、`[gif-check] ok=false count=0`）→ 属拖拽模拟与 GIF 解码两段，体检未动。
- `npm run compile`（`--dir`，`--publish never`）：**未跑成功，且引发一次环境事故，见 §4**。已完成的校验只到「配置能加载」：electron-builder 正常 `loaded configuration file=build.json`、跑完 `@electron/rebuild`（better-sqlite3 / uiohook-napi x64），随后在写产物阶段失败。`build.json` 的正确性另有两条静态证据：JSON5 解析通过（`files` 60 / `extraResources` 11）、模块④ 逐条核对过白名单与现存文件一致。

---

## 4. 事故记录（必须看）

跑 `npm run compile` 时 **MTNode 正在从 `dist\win-unpacked` 运行**（本会话就跑在这个 app 里）。electron-builder 在打包前先清理 app 目录，命中被自己占用的文件后中止：

```
EBUSY: resource busy or locked, unlink 'E:\dev\tools\pipeline-console\dist\win-unpacked\v8_context_snapshot.bin'
```

后果（按时间顺序，均为事实）：
1. `dist\win-unpacked` 处于**半清理状态**（它已删掉部分文件才在锁定文件上失败）；那份 unpacked 产物不能再用于本地测试。安装包与 `.msix` 产物（`dist\*.exe` / `*.msix`）**未被触碰**。
2. 该失败之后，**本会话所有需要起子进程的工具全部不可用**（`pwsh` / `grep` / `glob`），每次报同一条宿主错误：`ERROR:base\i18n\icu_util.cc:223 Invalid file descriptor to ICU data received.`，退出码 `2147483651`。纯进程内工具（`read` / `write` / `edit`）仍可用 —— 本报告即由其写出。
3. 因此模块⑦ 的 ② 项未能跑完：`npm run compile` 没有第二次机会，根 `smoke.js` 与「应用启动冒烟」在本模块内无法重跑（依据是模块① / ⑥ 的对照结果，见 §3.3）。

责任与教训：**在 app 正从 `dist\win-unpacked` 运行时跑 `electron-builder --dir` 是危险动作**。下次先关应用，或用独立输出目录（`npm run compile` 走 npm 传不进去，需直接 `npx electron-builder --win --dir --config build.json --publish never -c.directories.output=dist/audit-compile`）。

建议的用户侧恢复动作（本会话无进程工具，无法代为执行）：
1. 重启 MTNode（改用安装版或 `npm start` 的源码态），确认宿主子进程能力恢复。
2. 关掉所有 MTNode 实例后重跑 `npm run compile`（或 `npm run dist`）重建 `dist\win-unpacked`。
3. 删除本会话遗留的临时文件：`.tmp-restore-block.mjs`（模块② 收口用的一次性脚本，已执行完）、`.tmp-compile.log`（compile 输出）。

---

## 5. 效率度量前后对比（模块⑥）

根因：本机 `config.json` **57.8 MB**，其中 **91%（44.5 MB）是 `agentSessions`**（41 个会话全量转写）；渲染层 30 个 `configSave` 调用点，主进程 `config:save` 每次走「copyFileSync 整份备份 + 读 + parse + stringify + 写」≈ 5 趟全量 I/O；启动链把同一份文件整读 + parse 三遍；`config-backups` 30 份实测 **1.65 GB**。

| 改动 | 前 | 后 | 行为不变的证明 |
|---|---|---|---|
| `main.js` config 读取缓存 + 「内容没变不落盘」（≤8 MB 走 (mtime,size) 键的 {obj,text}；>8 MB 不常驻 —— 实测 55 MB 文本 = 101 MB 堆，拿内存换 CPU 不划算，但本次调用内仍比文本） | 2.6 MB 档 4 次保存 104 ms；55.1 MB 档 1,711 ms；启动链 3 读 38 ms | **29 ms（−72%）**；**1,421 ms（−17%）**；**18 ms**；备份 5→1 次、重写 4→1 次 | 两档「有改动时」写出的文件与旧实现逐字节相同；读不到 / 坏档 / 被别处改过时照旧备份+落盘；`{ok:true}` 与 `applyMainLocale` 调用次数不变；判据与同仓 `config-providers.js` 的 `if (changed){backup;write}` 同口径 |
| `workflow:list` 元数据缓存（原来每次把所有画布整读+parse 只为取 id/name/nodes；32 张 / 6.3 MB；18 个渲染层调用点） | 29.3 ms/次 | **0.48 ms/次（−98%）** | 对真实 save 目录跑完整对比：输出逐字节相同（含排序、mtime 取实时 stat、坏档/删档兜底） |
| 渲染层保存不再多跑一趟 parse（`persist` / `persistWf` / `flushCurrentWf` 由 `JSON.parse(JSON.stringify(wf))` 改只 `stringify`、字符串过桥；`workflow:save` 同时收字符串与对象） | 2.4 MB 大画布 UI 线程 8.47 ms | **4.58 ms（−46%）**，另省 ~2.16 ms 结构化克隆 | 10 用例逐字节相同（函数/Promise/undefined/NaN·±Infinity/Date·Map·Set/Symbol/空画布/真实 2.1 MB 画布）；BigInt 与循环引用两侧同一步抛同一错 → toast 文案不变 |

依赖与资源（按任务要求跑了命令）：`deps:usage` = app 树 296 包 / 440.95 MB → 零引用可移除 6 包 / 0.05 MB（`tiny-typed-emitter` 是 electron-updater 声明依赖，被守卫护住）；进 asar 的运行时闭包 22 包 / 37.5 MB；gateway 540 包 / 226.8 MB → 零引用 16 包 / 1.92 MB。`deps:check` 六道守卫全绿，gateway 227.96 → **76.39 MB（−151.57 MB / 66.5%）**，剪枝镜像真起网关 + `smoke-gateway` 通过。→ 剪枝已由 `dsh/after-pack.cjs` 读名单自动执行，**没有「确认不可达却还在包里」的项可手工再剪**；`build.json files` 白名单核对一致（模块④），本次未动。

**度量不成立 → 明确不改**（避免无依据重写）：
1. renderer 常驻定时器只有 2 个：`tickAllTimers` 用真实数据（32 张 / 1,552 节点）量到 **0.0010–0.0107 ms/拍**（32 张）≈ 0.001% CPU，写好的「timer 子表缓存」版只省 0.01 ms/s，却要引入 kind 改写 / 撤销 / 粘贴的失效风险；其余（assist 30s 文本刷、media 探测、运行队列心跳、长任务引导、开发建议、修复排队、db 看门狗、构建进度、倒计时、小游戏）逐个读到都有停止路径与 tick 上限（自毁型）。
2. `vendor/katex.min.js`（266 KB）/ `i18n.js`（651 KB）延后加载：真实页面 56 个 boot 脚本共 6,449.7 KB，`domContentLoaded` 202–384 ms（冷 603 ms），而 V8 单量最重的 9 个文件（3,661 KB）**顶层求值合计 5.1 ms**（katex 1.9 / i18n 1.4 / app.js 0.9），消融后整页 dcl 差异全在 ±150 ms 噪声内；代价是 KaTeX 缺席会改用自研 LaTeX 子集（公式观感变）、i18n 拆分给 EN 用户留一帧中文 → 按「不得改变首屏」判为不划算。
3. 九个本地后端控制台的 4–8s 状态轮询：只在该控制台窗活着时存在，且那是它们实时状态的唯一来源，改事件驱动等于砍功能。

---

## 6. 本次未处理的矛盾（给建议，不擅自改策略）

1. **`.gitignore` 与 AGENTS.md 直接对撞（最伤的一条，现在有硬后果）**
   `.gitignore` 排除了 `docs/`、`test/`、`scripts/`、`build.json`，而 AGENTS.md 把它们当协作真源（打包白名单必读、回归口径、发布链、MSIX 手册）。实测后果三条：
   - 新写的 `docs/msix-store-publish.md`（6 处引用它）**不会入库**；
   - `docs/app-deps-slimming.md` §1 说剪枝名单「随仓库流转」，但 `dsh/after-pack.cjs` 读不到 `docs/app-deps-*.json` 时**只警告并跳过** → 新克隆出来的安装包会静默把 ~150 MB 剪枝全吐回来；
   - 本次新增的回归入口 `test/run-all.mjs` 与 `package.json` 的 `test` 脚本，换机 / 克隆后同样拿不到。另测得 `guides/` 有 138 个文件在册、**另有 40 个 `.md` 未入库**（含 `guides/manual/longtask.md` 本身与 `en/longtask.md`、`sensenova_gen` / `yue_gen` / `ltart` 等一批节点指南）→ 克隆即缺页，右键「节点指南」取不到。
   建议（择一，需用户决定）：把 `docs/`、`test/`、`scripts/`、`build.json` 改为入库（它们不含密钥；敏感材料另有 `ssl/`、`*.key` 等规则守着），或反向把这些真源搬进已入库的位置并在 AGENTS.md 改口径；同时把 `guides/` 的 40 个漏网 `.md` 补进版本控制。
2. **`CHANGELOG-v1.1.md` 的两条路**：恢复一份，或把 `smoke-dev-suggest.js`（2 处）/ `smoke-plan-dialog.js`（1 处）的断言改指提交历史。属测试语义改动，未擅自动。
3. **闸门里没有本轮新增的两条不变量**：`i18n` 同对象重复键 = 0（模块③ 的扫描法现成）、渲染层「同名顶层全局 = 1 份 / 允许清单内 2 份」（模块② 的扫描法现成）。加上它们才能防止再抄一份；本次未加是因为要新写测试文件，超出计划文本。
4. **55 MB `config.json` 的真修**：把 `agentSessions`（91%）搬出 `config.json` 独立存储。收益上限已量清：有变化的保存 1,421 → ~250 ms、启动链 ~600 → ~30 ms、`config-backups` 1.65 GB → 几十 MB；需要一次数据迁移，落在「不做大规模文件重组」的边界外。
5. **`config-backups` 保留 30 份**：config 被转写撑大到几十 MB 时 30 份就是 GB 级；按总字节设上限或节流都属语义决定。
6. **`GS_GUIDES` 与指南真面脱节 10 项**：`app-search.js` 手抄一份 40 项清单做「节点指南正文检索」，而 `asset / deliver / ltout / ltart / sensenova_gen / yue_gen / save_text / save_image / video_upscale / video_interp` 磁盘有正文、`index.json` 已登记，却搜不到。建议改成读 `guides/nodes/index.json`（顺带让那份清单第一次真正有用）。
7. **`super_io` 右键「节点指南」会提示找不到**（该 kind 无正文，`app.js` 注明 "super_io proxy nodes removed; edge ports only"）：要么补一页讲边界端口，要么让 `nodeGuideId()` 对它返回空串、不显示菜单项 —— 交互取舍，未擅自决定。
8. **`docs/store-product-listing.md:5`（v1.2.4）与 `docs/project-context-memory-design.md:60`（milestone v1.1.28）**是历史快照而非现状断言，保留；`plugins/catalog.default.json` 与 `remotion-pack/manifest.json` 的 `minAppVersion: 1.1.28` 是插件兼容下限，正确；**`web/index.html` 下载页仍是 v1.2.9 口径（`VER` + 文件名/文案 9 处）**，属云端站点内容，未动。
9. **`AGENTS.md`「本地后端宿主」只列 5 个目录**，根目录实有 9 个（另有 `asr/ yue/ sensenova/ remotion/`，且都有同名 `*-pack/`）；`guides/manual/README.md` 里约 20 处**行号引用已失效**（本轮只把必须碰的那条换成函数名引用）；`_write.mjs`（manual 版）从不生成 `en/`，且 zh 兜底模板里的 `[从这里开始](#overview)` 指向已不存在的页 —— 都属「下次再抄会再腐烂」的口径债。
10. **14 只既有红**（§3.2）全在别人的未提交在制品线上（蒙版 / 抠图 / 画幅锁定 / app-cost / 专家团手册 / 长任务画布归属），本体检无权裁定产品意图；现在 `npm test` 会把它们固定列成清单，可作为后续各自的收口目标。
11. 38 条「值不同」的 i18n 重复键按「保留既成事实」处理（不改译文措辞）；若重裁 `Success/OK`、`In/Input` 这类口径属翻译取舍。

---

## 7. 改动清单（文件级）

| 文件 | 变化 | 模块 |
|---|---|---|
| `app.js`、`standalone-main.js`、`preload-pet.js`、`.tmp-lt-accept.js` | 删除（根目录死源，共 268 KB） | ① |
| `build.json` | −3 条指向不存在文件的取反 | ① |
| `renderer/app-agent.js` | 三处行为修复并入 + 文件头注释订正 + **CRLF→LF**（对 git 不可见） | ②⑦ |
| `renderer/app.js` | 模块② 删 819 行死副本 → 模块⑦ 按 app-agent.js 现文逐字补回（含三处修复）；模块⑥ 三处保存链改字符串过桥 | ②⑥⑦ |
| `renderer/i18n.js` | −146/+8 行、−25,618 B（重复键 + 死帮助文） | ③ |
| `main.js` | config 读取缓存 / 无变化不落盘；`workflow:list` 元数据缓存；`workflow:save` 兼容字符串 | ⑥ |
| `README.md`（4 行）、`AGENTS.md`（1 行）、`dsh/DESIGN.md`（1 条链接） | 版本口径与断链 | ④ |
| `docs/msix-store-publish.md` | 新建 184 行 | ④ |
| `guides/manual/en/longtask.md`、`guides/nodes/en/remotion.md` | 新建 | ⑤ |
| `guides/nodes/index.json`、`guides/manual/_write.mjs`、`guides/manual/README.md` | 登记 tool/function；catalog 补 longtask；图片路径口径订正 | ⑤ |
| `test/run-all.mjs`（新建）、`package.json`（+2 脚本） | 聚合回归入口 | ⑦ |
| `docs/app-deps-prune.json`、`docs/app-deps-capability.json` | 跑 `deps:*` 命令重新生成（既有生成物，被 gitignore） | ⑥ |
