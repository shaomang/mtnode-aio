# 插件报错弹窗与自动修复

> 面向开发：任何**需要第三方安装**的插件（本地后端宿主）运行期报错时，主窗口要**看得见地**报出来，
> 并给用户一个按钮把这件事交给**一条可见的 Agent 会话**去修，修完**自动重启该插件自己的服务**。
> 面向用户的那段写在 `guides/manual/media-gen.md`「插件报错弹窗与自动修复」。

## 一、为什么要这一层

在此之前，各宿主的失败只落在三个地方：插件控制台窗里的一行 toast、画布节点的状态行、以及
`*:progress` 广播——**插件窗没打开时根本没人监听**，用户看到的是「生成失败」四个字，既不知道根因，
也不知道哪里点一下能修好。自我修复能力其实早就有（各宿主的 `selfRepairFromConsole` /
`agentRecoverInstall`），但它藏在插件窗里，修完了只在控制台留一行字，用户既看不到它改了什么，
也没法中途插手。

这一层做三件事：

1. **跨窗收口**：主进程把六个宿主的失败出口汇成一条错误事件流，只推主窗口一处。
2. **弹窗报告**：错误码 + 错误正文 + 可折叠日志尾部 + 出问题的节点与画布，并明确「这次能不能自动修」。
3. **交给可见会话**：点「🤖 自动修复」→ 左侧栏新建一条会话（工作区 = 该插件 `INSTALL_DIR`），
   按对应 skill 的【自我修复】模式修；判定成功后**自动重启该服务**并刷新插件卡片与节点状态。

## 二、链路与文件

```
宿主失败出口（h3 / music3 / tts / llama / asr / sensenova / remotion）
  └─ reportErr(code, message, { nodeId, workflowId, … })          ← 每个宿主自己的包装，自带 try/catch
       └─ plugin-error-repair.js : reportPluginError(pluginId, payload)
            ├─ 错误码归一（别名表 + 正文兜底识别）
            ├─ 去抖：同插件 + 同错误码 60s 合并计数（suppressed 推回同一 eventId）
            ├─ 可修复性判定 + 一次性 repairToken（10 分钟 TTL、取用即销毁）
            └─ webContents.send → 主窗口
                 └─ preload 三桥：onPluginRepairError / pluginRepairReport / pluginRepairResult
                      └─ renderer/app-repair.js
                           ├─ 错误报告窗（persistent，可最小化到状态栏；#overlay 被占时排队）
                           ├─ 「🤖 自动修复」→ newAgentSession + workspace=INSTALL_DIR + canvasFree
                           │    └─ agentSessionSend(修复提示词)      ← 看得见的一条会话在改
                           ├─ 判定：末条回复 repair_ok=1 / ok=true，兜底读 INSTALL_DIR 下结果文件
                           ├─ 成功 → status→stop→start 重启该服务 + toast + 刷卡片 + 刷节点
                           └─ 失败 / 被终止 → 二次「修复结果」报告窗（窗内没有自动修复按钮）
```

| 位置 | 角色 |
| --- | --- |
| `plugin-error-repair.js`（根目录，**必须同步进 `build.json` → `files`**） | 主进程总线：`registerPluginHost` / `reportPluginError` / `runRepairByToken` / `restartByToken` / `resetDebounce` / `judgeRepairability`；`initPluginErrorBus({ getMainWin })` 注册 `pluginError:listHosts` / `:repair` / `:restart` / `:dismiss`。**本模块不写任何文件**（日志与安装目录只读），用户数据一律留 `%APPDATA%`。 |
| 六个 `*/main-*.js` | 在各自 `register*Ipc` 里注册一次宿主（id / 名称 / skillName / 取安装目录 / 取日志尾部 / 自我修复 / 重启），并在**已有的**失败出口加一行 `reportErr(...)`。`main.js` 里总线 `init` 排在这些注册之前。 |
| `preload.js` | 三个桥：`onPluginRepairError(cb)`（push，返回退订函数）、`pluginRepairReport(payload)`（本窗处理回执）、`pluginRepairResult(payload)`（修复结论）。后两条主进程 handler 缺省时只是 Promise reject，渲染层吞异常。 |
| `renderer/app-repair.js` + `renderer/css/repair.css` | 弹窗、发起修复会话、判定、重启、刷新、二次报告与收敛闸门。脚本挂在 `app-plugins.js` 之后。 |
| `skills/<name>/SKILL.md` | 【自我修复】模式的**唯一**规范来源：已知故障、交付要件、判据。弹窗里那句「请使用 skill「…」的【自我修复】模式」指的就是它。 |
| `test/smoke-plugin-repair.js` | 回归：宿主注册表、技能真源唯一、打包白名单、总线行为（真跑模块）、三桥、persistent、提示词要件、H3 安装链要件、i18n、本文档存在性。 |

## 三、哪些错误**不弹自动修复**

判定只问一句：**让 Agent 自我修复跑一遍，情况会变好吗？** 不会就只出报告 + 中文指路文案（`why`），
不发 `repairToken`。当前清单（`plugin-error-repair.js` → `NOT_REPAIRABLE`）：

| 错误码 | 为什么不修 |
| --- | --- |
| `cancelled` / `user_stopped` / `force_killed` | 用户自己取消 / 停的，或为让别的音视频任务用显存被强制结束——不是故障 |
| `busy` / `busy_other_node` / `busy_media` | 已有安装任务在跑，或全局音视频锁被别的节点占着，等它结束即可 |
| `low_disk` | 空间不够，重装只会再失败一次；要用户清盘或换目录 |
| `no_nvidia_gpu` / `no_cuda` / `driver_too_old` | 自我修复不会替用户插显卡、也不会更新驱动 |
| `bad_dir` / `refuse_root` / `refuse_system` / `dir_mismatch` | 安装目录不合法（盘根 / 系统目录 / 应用目录一律拒绝），要重选目录 |
| `missing_node_id` / `no_dsh` / `empty_console` | 画布数据异常 / 网关不可用 / 没有可分析的现场日志 |

外加两条结构性判定：宿主**没注册** `selfRepair`（如 Remotion 走 npm 安装）→ 不可修；宿主根本没注册
→ 报告照发、只说「只能人工看日志处理」。**没有 `repairToken` 就没有自动修复**，这是同一件事的两面。

## 四、修复会话的提示词契约

`pluginRepairPromptText(info)` 下达的内容（缺项就不写、不进提示词，绝不编造）：

1. `请使用 skill「<安装技能>」的【自我修复】模式。`——技能 id/kind → 名称映射在 `PLUGIN_REPAIR_SKILLS`，
   与主进程注册时的 `skillName` 同源。
2. `当前工作区（可写）= INSTALL_DIR=<安装目录>`；`SCAFFOLD_REF=<随包脚手架>（仅参考，不要改这个目录）`。
3. 插件名 / 错误码 / 出问题的节点（标题拿不到就只给 kind · id）/ 所属画布。
4. 错误正文（截 4000 字）+「最近失败焦点」+「console 最近尾部」（分别截 8K / 12K）。
5. 四条纪律：**只改 INSTALL_DIR**、**不要启动后端服务 / ComfyUI / 模型进程**（重启交给本模块，Agent 自己起会
   与后面的重启抢端口）、**不要删 output/**、模型已齐勿重下。
6. 收尾：创建标记文件（默认 `.repair-ok`）、写结果文件（默认 `.agent-repair-result`，首行 `ok=true`，可附
   `reason=`），并在回复里给 `repair_ok=1`；修不动写 `ok=false` + `reason=<哪一条没交付 + 报错>`。

判定顺序：末条 assistant 正文里的记号（`repair_ok` / `install_ok` / `ok=`）→ 正文没结论再按
`info.resultFile` → `.agent-repair-result` → 该宿主既有命名（`.h3-agent-result` 等）逐个兜底。
**任一处明确 `false`、会话被终止、或两处都判不出来 = 失败**：判不出来就不去重启后端，
免得把没修好的服务又拉起来冒充成功。

## 五、修完自动重启，以及不成环

- 重启走该服务自己的入口（`h3Start` / `music3Start` / `ttsStart` / `llamaStart` / `asrStart`），
  并且**先 `status → stop → start`**：半死的旧进程会被宿主判成「端口已有人 → reused」，等于没重启。
- `remotion` 标 `resident:false`：它没有常驻服务，改成**直接重跑报错那个节点**（拿不到节点就提示可直接重新生成）。
- 表里没登记的插件 → 只提示「没有登记的服务重启入口」，不报「失败」。
- 重启失败**只 toast，不重试也不弹窗**（真修好了只是拉不起来，再弹就又成环了）。
- 两条收敛闸门，缺一不可：
  - **一条 `repairToken` 只发一次自动修复额度**（`pluginRepairClaimAuto`；额度用完时首窗按钮置灰并说明原因）；
  - **一条错误只弹一次二次「修复结果」报告窗**（`pluginRepairClaimReport`），且结果窗内**没有**「自动修复」按钮。

载荷没带 `repairToken` 时，渲染层按「错误身份 + 发生时刻」自己生成一枚，语义等价（一条错误一个 token）。

## 六、与安装技能真源的关系

这条链能不能修好，取决于 Agent 拿到的技能正文是不是当前方案。因此技能真源唯一化是同一次改动的一部分：

- `dsh/main-dsh.js` → `INSTALL_SKILL_SOURCES` 一律指向**仓库根** `skills/<name>/SKILL.md`（5 条：
  `minimax-h3-install` / `minimax-music3-install` / `tts-local-install` / `llama-local-install` /
  `sensenova-local-install`。本地语音转写那份随旧插件一并删除：识别改用 dsh 运行时的官方
  SenseVoice，权重由运行时自己下，不再有 Agent 安装链）；
  各宿主的 `sync*InstallSkill()` 也走同一份（并先委托 `dsh.syncInstallSkills()`）。
- `h3/skills/`、`music3/skills/` 两份宿主目录副本**已删除**：留着就是「改了新份、下发的还是旧份」，
  那是本模块所有「提示词不合方案」的根因。
- 安装技能一律写 `.install-only`：不进用户技能列表、工坊，也不允许被 `skillAdd` / `skillRemove` 占用。

## 七、当前已知缺口（端到端契约，改前需单独确认）

主进程侧与渲染层侧由两步并行落地，两侧各自完整但**尚未对上**，回归只分别钉住两侧：

1. **channel 名不一致**：总线 `webContents.send("pluginError:report", event)`，而 `preload.js` 订阅的是
   `pluginRepair:error`；`pluginRepair:report` / `pluginRepair:result` 两条 invoke 通道主进程还没有 handler
   （渲染层已吞异常，不会报错，但也等于没有回执）。
2. **载荷形状不一致**：总线给的是嵌套对象（`plugin{id,name,skillName}` / `node{id,title,kind,workflowId}` /
   `autoFix{repairable,why,repairToken}` / `logTail`），`pluginRepairNormalize` 读的是扁平字段
   （`pluginId` / `nodeTitle` / `repairToken` / `logTail`）。即便 channel 对上，`p.plugin` 是个对象也会
   被 `String()` 成 `[object Object]`。

补齐的口径（任一方案都行，只改一处，别两边各抄一份）：在主进程侧把事件**摊平成扁平载荷 + 用
`pluginRepair:error` 推送**，并给 `pluginRepair:report` / `pluginRepair:result` 补上落日志的 handler；
或者反过来让 `pluginRepairNormalize` 认嵌套形状。补完后把 `test/smoke-plugin-repair.js` 头部「已知未覆盖」
那段删掉，并补一条端到端断言（总线发出的 channel 与字段 ↔ preload 订阅与渲染层读取一一对上）。

## 八、新增一个需要第三方安装的插件时要做什么

1. 宿主 `register*Ipc` 里 `registerPluginHost({ id, name, skillName, getInstallDir, tailConsole, selfRepair, restart })`；
   没有 Agent 安装链的就**不要**注册 `selfRepair`（只报告、不弹自动修复）。
2. 在**已有的**失败出口加一行 `reportErr(code, message, { phase, nodeId, workflowId, installDir })`：
   安装失败、后端退出 / 启动超时、就绪检查失败、生成 / 后处理失败、`not_installed` / `no_venv` 一类前置缺失。
   用户主动取消也要报（会被判成不可修，只报告，不会误弹自动修复）。
3. `renderer/app-repair.js` 补三张表：`PLUGIN_REPAIR_SKILLS`、`PLUGIN_REPAIR_CONSOLE`、
   `PLUGIN_REPAIR_SERVICE_BASE`（常驻服务给 `start/stop/status` + 卡片刷新口 + 结果文件名；无常驻服务标
   `resident:false`），别名口径与 `PLUGIN_REPAIR_SERVICE` 的 alias 表保持一致。
4. 新根目录主进程模块一律同步进 `build.json` → `files`；新交互写进 `guides/manual/media-gen.md`（中英）
   与相关节点指南（中英），并把新代码里的中文字面量同步进 `renderer/i18n.js` 英文档。
5. 更新 `test/smoke-plugin-repair.js` 的 `HOSTS` 表并跑一遍。
