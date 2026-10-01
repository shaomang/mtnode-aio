# 会话的浏览器能力：设计口径与契约

**范围**：给 MTNode 的**会话**（`app-assist.js` 的 agent session）加一只属于它自己的浏览器，并配套「活动流」「求助与接管」「长时自治」。参考 `CopilotKit/OpenBot` 的框架与哲学（每个 coworker 有自己的浏览器与登录态；动作先有决定、后有记录；Screen + Activity 双窗；人该上手时把轮子接过去；私网地址与策略名单失败即拒；长时工作靠 routine 推进），落到 MTNode 已有的三层契约上，**不引入任何新依赖、不随包发浏览器内核**。

## 1. 三条不能破的前提

1. **仅会话可用**（用户 q17）：画布智能节点 / 智能任务不注册浏览器工具 —— 没人看着的自动运行不该自己去点网页；纯净模式同样不注册。
2. **活动流不进模型上下文**（用户 q25）：浏览器动作、shell 命令、文件读写摘要只进侧边活动面板与本机活动库；模型看不到这份流水（省 token，也避免它把账本当材料）。
3. **不自动中断**（用户 q21）：长时自治只在「目标达成 / 清单收口 / 用户终止 / 安全上限」四条上停；时间与开销只累计给用户看，不拦人。

## 2. 分层落点（照 dsh 三层契约）

```
renderer/app-browser.js      右边栏（活动流 + 实况画面 · 提出来/收回）· 控制按钮 · 名单编辑
renderer/app-longrun.js      自动续跑开关 + 累计状态 + 自检判停（会话侧，性能无关）
renderer/app-db.js           求助 / 确认卡渲染与回执（ix 卡面板，复用既有通道）
        ↕ preload.js 白名单桥：dshBrowser / activityPush / activityQuery / activityClear / dshOnActivity / onBrowserFrame
main.js                      IPC: dsh:browser · activity:push|query|clear → activity-store.js
        ↕ stdio 换行分隔 JSON（dsh/main-dsh.js 的 browser(params)）
dsh/gateway/gateway.mjs      BrowserCtl：策略 / 安全闸 / 求助卡 / 活动流转发 / 控制面方法
        ↕ 本地 TCP 桥（新帧类型 'browser'）
dsh/gateway/browser-plugin.mjs   13 个 browser_* 工具（运行时侧，注册口判整档闸）
dsh/gateway/browser-host.mjs     CDP 驱动：进程 / 标签页 / 驱动锁 / 快照 / 截图 / 网络
        ↕ CDP（内置全局 WebSocket，Node ≥22）
本机 Edge / Chrome（--remote-debugging-port + 专属 --user-data-dir）
```

**为什么驱动放在网关进程、不放在运行时插件里**：浏览器只有一个，驱动权要串行（用户 q30）；网关是所有会话的汇聚点，进程内单例天然就是那把锁。运行时插件只做「参数 → browser 帧」的转发与工具描述，不持有进程。

**为什么用 CDP 直驱**（用户 q7）：Node ≥22 自带全局 `WebSocket`，零依赖；不打包浏览器内核（省几百 MB）；用户已有的 Edge / Chrome 就是目标环境（本机实测 Edge 153）。

## 3. 新增帧类型 `browser`

运行时 → 网关（桥，换行分隔 JSON）：

| 字段 | 说明 |
| --- | --- |
| `t` | `'browser'`（已进网关的帧白名单；归属不明一律 abort —— 与 `question` / `approval` 同一份失败即拒口径） |
| `op` | `status` / `launch` / `snapshot` / `navigate` / `click` / `submit` / `type` / `key` / `eval` / `wait` / `screenshot` / `tabs` / `network` / `help` / `release` |
| `params` | 各 op 自己的参数（见工具表） |
| `sessionId` | 发起轮的 `exec.agent.id`（归属判据） |

网关 → 运行时：`browser-result`（`{ id, ok, result }` 或 `{ id, ok:false, error }`）。

**交互（要人）不复用 `question` 帧**：用户明确要求新做一张「浏览器求助卡」（q29）。网关走 `BrowserCtl.ask()` → `bridgePending`（`kind:'browser'`）→ 宿主事件 `type:'browser'` → 渲染层 `ixPush('browser-help')` 卡片；用户点了回执 → `dshInteract({kind:'browser'})` → 网关 resolve。**多发一张卡不是多一条通道**：底层还是既有交互桥，只是卡片类型、渲染与回执语义另算。

## 4. 工具面与可见集闸

13 个工具：`browser_launch` / `browser_snapshot` / `browser_navigate` / `browser_click` / `browser_type` / `browser_key` / `browser_eval` / `browser_wait` / `browser_screenshot` / `browser_tabs` / `browser_network` / `browser_help` / `browser_release`（核心 + 常用扩展，用户 q9）。

两道**整档闸**（不进模型上下文 = 一步都不发 schema）：

| 闸 | 下达方式 | 生效范围 |
| --- | --- | --- |
| 纯净模式 | `MTNODE_PURE=1`（与 pure-prompt 同源） | 整个会话 |
| 非会话 | 宿主按运行算 `noBrowser` → `MTNODE_NO_BROWSER=1` | 画布智能节点（`nodeLock`）/ 用户声明「与画布无关」/ 长任务未授权环节 |

`noBrowser` 与 `lean` / `noCanvas` 同级：**进 runtime key（`nb:` 成分）** —— 可见集变了就必须冷起一台运行时，否则同一台运行时被两种可见集复用，既打爆提示缓存又让「不注册」变成随机行为。名单白名单在 `dsh/gateway/tool-visibility.mjs`（`HIDEABLE_TOOLS`），与宿主侧名录同源（回归在 `test/smoke-token-budget.js` [9]）。

## 5. 安全闸（固定几类可控项，复用现有审批通道 —— 用户 q13 / q24）

不是新规则引擎，只有三样：

- **域名名单**：`blocked`（硬拒，回执说明怎么改名单）/ `confirm`（风险站点首次访问弹一次确认卡，本会话内该 host 记住）。内置默认名单，用户可在面板里改，落 `%APPDATA%\pipeline-console\browser-policy.json`。
- **危险动作审批**：`提交 / 支付 / 删除 / 发送 / 发布…` 关键词 + `type=submit` 判据 → 危险动作确认卡（可整档关掉）。
- **凭据**：`browser_type` 明文禁止代填密码；活动流摘要里凭据类入参只记长度。

**失败即拒（fail closed）**：名单命中一律拒绝；确认卡被撤 / 发起轮已结束 → 回执为「失效」，工具以错误收场而不是静默放行。

## 6. 活动流

- 来源：`BrowserHost.registerActivitySink()` → `BrowserCtl.push()`；网关另在 `tool/call` 与 `tool-result` 上给 shell / 文件类工具做**摘要**（跳过 `mtnode_*` 与 `lt_*`，避免把画布帧噪声灌进流水）。
- 去路：宿主事件 `browser-act`（实时，渲染层按 400ms 合并批量落库）→ `activity-store.js`（SQLite：`activity` 表 + 索引）→ `renderer/app-browser.js` 面板（分类着色、筛选、含其它会话、清空）。
- 清理：每会话 4000 条、整库 30000 条，超量删最旧。
- 归属会话 = **宿主（渲染层）会话 id**（`as…`）：桥帧自带的 `sessionId` 是 dsh 侧的 `session-<uuid>`（归属判据用），两者不是一套 id。宿主每轮 `run` 带 `hostSessionId`（`app-db.js` 的 `dshHostSessionIdOf`：会话聊天 / 计划执行 / 长任务续跑 = runKey `agent:<会话id>`；画布智能任务节点 = `node.agentSessionId`），网关登记进 runtime 占用表，`BrowserCtl.push()` 用 `hostSessionTagOf()` 把 dsh id 翻成宿主 id 再盖章；查不到就原样带（旧库条目勾「含其它会话」仍可见），非会话轮（助手 / 未绑定节点）显式空串 = 不算进任何会话。
- 面板**跟随当前会话**：`renderer/app-browser.js` 的 `BA.setSession()` 是唯一入口（`app-assist.js` 的 `renderAgentSession` → `agentNotifyBrowserSession()` 每次会话渲染通知一次），活动按会话查库 / 过滤；**当前会话没有浏览器就整条收起**（判据 = 本次运行见过它的浏览器活动 ∪ 网关 `status.driver` 说它驱动着 ∪ 库内该会话有浏览器类历史）；自动显隐**不写** `mtnode.baOpen`（那是用户偏好），用户在本次运行里对每条会话的开 / 关按会话记着（`BA.userChoice`）。
- 实况**只给持驱动锁的那条会话**：`viewStart` 仍不申请驱动锁，但渲染层 `liveSync` 在 `status.driver` 是别的会话时不拉帧（画面属于驱动者，切回驱动会话再开）。
- **不进模型上下文**：这条是设计约束，不是实现细节 —— 网关只 `out({event:{type:'browser-act'}})`，从不把它塞进任何 run 的输入。

## 7. 求助与接管

五种 `helpKind`（用户 q3）：`login` / `verify` / `choice` / `blocked` / `danger`。

- `login`：卡片默认带「接管浏览器（我来操作）」；网关同时 `setTakeover(true, sessionId)`，**接管期间 Agent 的浏览器动作被拒绝（不是排队）**；用户交还 → `setTakeover(false)`，工具以 `released` 收场并提示「先 `browser_snapshot` 再看当前页面」。
- 密码：**由用户在窗口里亲自输入，不经过会话**（用户 q15）；本条与「默认内部界面」不冲突 —— 接管时**不再 `bringToFront()` 抬真窗口**（那是「又开出一个窗口」的第二条来源），登录 / 验证码在会话右栏的实况区里直接操作（用户本轮确认：接管也走内部界面）。要看真窗口由用户自己点「独立窗口」。
- 手动入口（不写命令，用户 q36）：会话右边栏「浏览器活动」→「打开浏览器」/「接管」/「名单」。按钮经 `window.api.dshBrowser` 走同一条控制面。接管时渲染层另发一句 steer，让正在跑的会话也立刻知道。
- 卡片另有「允许这一次 / 拒绝 / 我已处理，继续 / 撤销这张卡」；卡片失效（发起轮已结束）时渲染层就地提示并撤卡。

## 7b. 实况流与「提出来 / 收回」（用户口径：默认 dock 在会话右边栏）

浏览器**默认 dock 在会话主内容的右边栏**（第三栏的「实况」区），可「提出来」变回独立窗口、「收回」再 dock；**没被调用 / 浏览器没启动时整条不显示**（沿用 `#baPanel hidden` + `.agent-pane.ba-open` 这一个显隐口径，旧界面一字不差）。

### 启用即内部界面（本轮需求：不再另开一个新窗口）

用户口径（已确认）：**启用浏览器 = 用内部的界面**。真实 Edge/Chrome 进程照常起（profile 与登录态不变），但窗口立刻被移出可视区（`-2400,-2400`），画面只在会话右栏的实况区里；「独立窗口」是用户**亲手点**的那一次例外，且只当**本次浏览器运行内**有效（进程重启 / 重开应用回到内部界面，形态不再写进 `localStorage`）。

- 三条「开门」路径全部默认停靠：
  1. 会话驱动（`browser_launch` 与其余 `browser_*`）：`BrowserCtl.handle` 的 launch 分支在 `ensureBrowser` 之后调 `BrowserHost.parkSessionWindow()`（`mode === 'detached'` 时才让位给用户的例外）；
  2. 面板上的「打开浏览器」（`BrowserCtl.open`）：同样 `parkSessionWindow()`（不再 `bringToFront()`）；
  3. 开实况流（`viewStart` → `startViewStream`）：`state.viewParked === false` 时补一次 `parkSessionWindow()`（幂等）——这条是「面板有画面、屏幕上还多一只 Edge」的老 bug 的兜底。
- 判据是「真的搬走了没有」（`viewParked` / `parked`），不是 `viewMode`：`viewMode` 默认就是 `docked`，新起的窗口却还摆在屏幕上（新进程会把 `viewMode` 归零到 `docked`、`viewParked` 清 false，见 `ensureBrowser`）。
- 「独立窗口」取 `browser` 控制面 `action:'view'` 的 `method:'mode'`：`detachWindow()` 先把窗口摆到可见位姿（`viewBounds ∪ VIEW_FALLBACK_BOUNDS`）再置前，**位姿没还原成功就不算切过去**（回落成 `docked` + `reason`，面板把原因说在实况区）——否则用户点了等于什么都没发生，只能停浏览器。
- 只读快照（`statusOf`）也带 `mode` / `parked`，渲染层每次 `status` 都能把面板对齐到网关的真形态（`BA.applyStatus` 只跟随网关，不落盘）。

**被调用即出现**（`renderer/app-browser.js` 的 `BA.autoOpenForUse`）：会话第一条 browser-act 进来时右栏自己打开，三条刹车都不开 —— 用户本次运行亲手关过（`BA.userClosed`，`setOpen` 显式开合时落）/ 不在会话视图（`#agentPane` display:none）/ 浏览器没在跑（先问一次 `action:'status'`，不吃过期状态）。触发面只认浏览器类活动（`AUTO_OPEN_KINDS`），shell / 文件摘要不替用户弹第三栏。没有这一条，实况流永远不会连（`liveSync` 的第一项就是「面板开着」），浏览器就只能停在眼前的独立窗口里。

**焦点不在该会话时静默处理**（本轮需求）：`BA.viewing(sid)` 走 `app-assist.js` 的 `agentViewHas`（唯一判据）；false 时 `BA.silentConnect()` —— **照常连流但不弹右栏、不切界面、不提示**，只在左栏那条会话行挂一枚被动标记（`app-assist.js` 的 `.side-sess-ba`，由 `BA.noteBrowserSession` 触发、每条会话只重绘一次）。相应地 `liveSync` 把「正在驱动本会话」也算作要连流的条件（`silentStream`）：静默期面板虽收着，流照旧连着 —— 那条流不只是画面，更是「真实窗口让位」本身；掐了它窗口就又留回屏幕上。帧在面板收起时本来就不画（`onFrame` 挡着），所以静默期只花网关那点编码成本。
**栏本来就开着**（上次没收 / 启动时按 `mtnode.baOpen` 恢复）时不再「弹」，但**必须补一次 `liveSync`**：面板开着 ≠ 流在连（启动那一刻浏览器还没跑，那一拍开流会失败），少了这一条，浏览器后来被会话拉起也没人 dock 它，窗口就一直留在屏幕上。回归：`test/smoke-browser.js` 里的「已并入：smoke-browser-rail.js」段（vm 沙箱里真跑渲染层，十三段，[7] 钉「栏开着补流」、[8]/[9] 钉形态切换、[12] 钉静默处理）。

三层落点与数据流：

```
browser-host.mjs   startViewStream/stopViewStream/viewInput/setViewMode
                   · Page.startScreencast(jpeg 72 / max 1280×800 / everyNthFrame 1)
                   · 每帧先投给 registerViewSink 再 Page.screencastFrameAck（慢客户端不积压）
                   · 最小帧间隔 80ms（≈12fps 上限）：更密的帧只 ack 不投（丢中间帧，末帧必达）
                   · viewInput：Input.dispatchMouseEvent / dispatchKeyEvent / insertText
                     （调用方给 CSS 像素 + 画布显示尺寸，host 按真实视口换算后再派发）
                   · setViewMode('docked'|'detached')：Browser.setWindowBounds 移出可视区 / 恢复
        ↓ 网关事件总线（**不经 push()**）
gateway.mjs        out({event:{type:'browser-frame', data:{seq,w,h,dpr,frame(裸 base64 JPEG),event,mode,fallback,reason}}})
        ↓ 既有 dsh 事件总线（main-dsh.js → main.js 的 dsh:event 原样转发）
preload.js         onBrowserFrame(cb)（+ dshBrowserViewStart/Stop/Input/Mode 四条控制面）
        ↓
app-browser.js     canvas drawImage（只留最新一帧）· 指针/滚轮/键盘/IME 转发 · 模式按钮
```

硬约束（本功能块的验收口径）：

- **帧绝不落库**：`browser-frame` 不走 `activityPush`，也不进 `activity-store`；它与活动流是两条互不相干的路。
- **帧绝不进模型上下文**：网关只 `out()` 事件，从不塞进任何 run 的输入。
- **没启动不显示、也不顺手启动**：`viewStart` 只连「已经在跑的」那只浏览器（`statusOf().running` 为假就回 `{ok:false,error}`）；渲染层只在「面板开着 + 会话视图 + 浏览器在跑 + 没暂停」四条同时成立时才开流，收起面板 / 切画布视图 / 点暂停即停流。
- **默认 docked（= 内部界面）**：`viewStart` 成功即成 dock（真实窗口移出可视区）；会话驱动与「打开浏览器」都在拉起进程后立刻 `parkSessionWindow()`。`--disable-backgrounding-occluded-windows` + `--disable-features=…,CalculateNativeWinOcclusion` 让离屏窗口照常出帧。
  **判据是「真的搬走了没有」（`state.viewParked` / `parked`），不是 `viewMode`**：`viewMode` 默认就是 `docked`，新起的窗口却还摆在屏幕上 —— 只看 mode 会漏搬（开流时补一次 `parkSessionWindow()`）；`viewParked` 在进程（重）起时清零，`viewMode` 一并归零到 docked。重复 dock 不把落点 `-2400,-2400` 记成「用户位置」（`isAtParkingSpot`），否则下次「提出来」会把窗口还原到看不见的地方。
- **「提出来」要真的留得住**：`detached` 时渲染层停流（`liveStop`）并在实况区说明「已在独立窗口」；`liveSync` 的条件里带上「形态是 docked」，否则浏览器一动就又开流 → 刚提出来就被搬回去；`viewStart` 也只在 `mode !== 'detached'` 时停靠。**形态不落 `localStorage`**（本轮口径：独立窗口只是本次运行里的一次显式例外），浏览器停止 / 崩溃回到 docked 待启动态；位姿没还原成功时不切 detached（回落 docked + `reason`）。
- **兜底**：离屏后 1.5s 仍无帧 → 看门狗回落成「窗口停在屏幕上 + 面板照常出帧」，`fallback:true` + `reason` 文案，只回落一次（不反复搬动用户眼前的窗口）。
- **独立窗口形态不重复解码**：见上条「提出来要真的留得住」。
- **只转发不改写**：面板里的输入一律按 CSS 像素转发给页面，不改页面状态、不落活动流（与「用户接管」是两件事：接管是 Agent 动作被拒，实况是用户直接上手）。

## 8. 长时自治与自检

`renderer/app-longrun.js`（会话侧，唯一入口是 `app-assist.js` 轮末钩子 `window.LongRun.afterRound(st, outcome)`）：

- **开关 + 累计状态**（用户 q35）：输入区一枚「自动续跑」chip，小字显示已续几轮 / 已跑多久 / 累计 token。
- **自检判停**（用户 q33）：① 答复里有完成 / 停手信号；② 会话待办清单全部收口；③ 用户终止 / 暂停；④ 安全上限 30 轮。前两条是「目标达成」判据，后两条是护栏。
- **不自动中断**（用户 q21）：时间 / 轮数 / 开销只累计显示，不弹卡不拦人。
- **续跑指令**：发一条「自检 + 续跑」消息 —— 先对照最初目标自查（已完成的带证据、未完成的差在哪）→ 有问题的先修好重跑 → 有下一步就做 → 全完成就明确收工 → 卡住就 `browser_help('blocked')` → 禁止空转。用户已在聊天里按下终止或 pause、或队列里还有用户消息时**不追轮**（给用户让路，绝不插队）。
- **建议而非自动改图**：连续跑超 8 轮或超 90 分钟，给一次「可提升为长周期任务图」的建议（用户 q20）。

**自检纪律**（用户 q19，写在系统提示 `SELF_CHECK_DISCIPLINE`，`app-assist.js`）：分阶段自检 + 交付前全检；发现问题先自行修复并重跑，修不好才告知；关键结论必须带证据（URL / 命令输出 / 截图路径）；长任务不空转。**只写这一处** —— 参数机制在工具描述、操作规范在技能，这里只留行为纪律（与 `docs/prompt-source-of-truth.md` 的分层一致）。

## 9. 数据落点（一律不进应用文件夹）

| 内容 | 路径 |
| --- | --- |
| 浏览器用户数据目录（登录态） | `%APPDATA%\pipeline-console\browser-profile` |
| 截图 / 下载 | `%APPDATA%\pipeline-console\browser-shots`、`…\browser-downloads` |
| 名单与审批 | `%APPDATA%\pipeline-console\browser-policy.json` |
| 活动库 | `%APPDATA%\pipeline-console\activity.sqlite` |

`activity-store.js` 是根目录主进程模块，**必须进 `build.json` 的 `files` 白名单**（否则打包后 `Cannot find module './activity-store.js'`）—— 冒烟测试 [8] 钉住这一条。

## 10. 验收

- `node test/smoke-browser.js` —— 主用例（209 项）+「已并入：smoke-browser-rail.js」段：右栏「被调用即出现 + 焦点不在该会话时静默」的功能回归（vm 沙箱真跑 `renderer/app-browser.js`，十三段）：默认不显示 / 来电即开栏并真开流（viewStart 单飞，一次）/ 用户亲手关过不再弹 / shell 类活动不弹 / 非会话视图不弹 / 浏览器没在跑不弹 / 栏开着补流 / 形态切换与「不落 localStorage」/ **[12] 静默**：不弹右栏、不切界面、照常连流、左栏留一枚被动标记（且只给该会话盖章）。
- `node test/smoke-browser.js` —— 209 项：实况流（帧只进内存 / 不落库 / 不自动拉起 / dock-detach 状态机 / **launch 即 parkSessionWindow、登录求助不再 bringToFront**）/ 底座 / 纯函数安全闸 / 网关接线 / 插件工具面 / cordis 挂载 / 活动库真读写 / 渲染层与 i18n（含默认内部界面两条词条 + `.side-sess-ba` 被动标记）/ 打包白名单。
- MTNODE_BROWSER_SMOKE=1 node test/smoke-browser.js —— 追加真机段：真起浏览器 → 导航 example.com → 快照（标题 / URL / 元素）→ 截图落盘 → 网络留痕 → 关闭。
- MTNODE_BROWSER_SMOKE=1 MTNODE_BROWSER_VIEW=1 node test/smoke-browser.js —— 真机段再加实况：真出帧（screencast / 帧率受控 / 裸 base64 JPEG）→ iewInput 真点到页面（面板坐标 → 按钮）→ 提出来/收回真搬窗口 → 停流后不再有画面帧。
- 
ode test/smoke-browser-view.mjs —— 同一套实况真机口径的独立脚本（会真开一只可见 Edge/Chrome，跑完自动关）。
- 相关旧冒烟：`test/smoke-token-budget.js`（可见集通道扩到四个）、`smoke-dialog-persistence.js`（新面板持久、不点外部即关）、`smoke-ask-panel-top.js`（交互卡位置）、`smoke-team-perms.js`、`smoke-longtask-create.js`、`smoke-longtask-strip-scroll.js`（长任务条带按住保护 + **丢 mouseup 的 TTL 自愈**：真窗口抢走前台时不许把条带冻成「点了没反应」）。
- 应用内手册：`guides/manual/agent-browser.md`；节点指南：`guides/nodes/browser.md`。

## 已知边界

- 只在 Windows 验收真机链（候选探测链含 macOS / Linux，未在本机实测 —— 用户 q34）。
- 广度高但不碰封闭站与批量账号操作（用户 q18）：名单是第一道闸，接管是兜底。
- 浏览器窗口的「置前」依赖 CDP `Page.bringToFront`，个别系统上不抢焦点：找不到窗口时走面板「打开浏览器」按钮。