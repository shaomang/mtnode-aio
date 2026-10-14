# 用手机接管 MTNode 会话（Paseo 桥）

> 面向用户：手机上装 **Paseo** App（[paseo.sh](https://paseo.sh)，开源、可自托管），扫码配对后就能
> 看并接管 MTNode 左栏里的**智能体会话**：读消息与工具调用、看实时输出、发消息、中途插话、
> 终止本轮，以及接管工具审批 / 画布修改确认 / 模型提问。
> 面向工程：怎么装、怎么排障、边界在哪；实现见本文末「关键文件」。
## 1. 它是什么（一句话）

MTNode 自己的会话（左栏 `as…` 那条）**借 Paseo 的手机端**用：

```
手机 Paseo App ──(扫码配对 · 走 Paseo 自带 relay / 或 Tailscale 直连)──► 电脑上的 Paseo daemon
                                                                          │ 按 ~/.paseo/config.json
                                                                          ▼ 把桥当 ACP provider 拉起
                                            paseo/acp-bridge.mjs（桥：说 ACP ↔ 说 MTNode 本机 HTTP）
                                                                          │ POST /ctl 的会话族
                                                                          │ GET /session/stream（SSE）
                                                                          ▼
                                              MTNode 主进程（会话桥）→ 渲染层（与你自己点发送同一套）
```

手机上看到的就是 MTNode 里那条会话本身 —— **同一份账**：手机上发的消息在电脑左栏看得到，
电脑上开的会话手机也能接着聊。

## 2. 装（两步，都在插件里）

从顶栏「**插件**」打开「**Paseo 手机接管**」插件控制台（`paseo-remote`，kind `paseo`）：

1. **认后端 / 装后端**：控制台会先找本机已装的 Paseo —— 桌面端自带的 CLI
   （`C:\Program Files\Paseo\resources\bin\paseo.cmd`）或 PATH 里的 `paseo` 都能直接用；
   找不到时才点「安装后端」，它会在你选的目录里 `npm i @getpaseo/cli` 装一份独立后端
   （独立 home；**不与桌面端抢 6767** —— 见下）。
   - **装完会自检**：`node_modules\.bin\paseo.cmd --version` 真能报版本才算装好
     （只看 `node_modules\@getpaseo\cli` 目录在不在会误报 —— 曾经的现场就是
     `[install] 完成：code=0 installed=false`：npm 正常退出、依赖也落了盘，界面却说没装上）。
     第一次自检不过会自动清掉半成品（`node_modules` + lock）重装一次；仍不过就给出可操作原因
     （依赖没落盘 / bin 没生成 / CLI 跑不起来），控制台「安装自检」那行直接写着是哪一种。
   - **不抢端口**：官方 daemon 的 listen 来自持久配置 `daemon.listen`（默认 6767），
     而桌面端那份长期占着 6767。自己装的那份起来时会先试 6767，被占就**把 `daemon.listen`
     钉到第一个空闲端口**（6768+），只在自建 home 的配置里写，不动你 `~/.paseo` 那份。
     万一还是撞上（`EADDRINUSE`），控制台点「启动后端」会自动换端口重试一次。
   - **自建用不了就切回复用**：自建模式检测不到可用 CLI、而本机其实装着 Paseo 时，
     控制台会多出一颗**「改用本机已装的 Paseo」**（不静默改配置，要你点一下）。
   - **真 Node 是硬前置**：桥的 `command[0]` 必须是真 Node（≥22.19，Electron 自带的那个 Paseo 不认）。
     只有 Electron Node 时控制台给「等真 Node 就位」（等 dsh 的托管 Node 装好）；注册 provider 前
     也会先等一会儿 —— 宁可不写，也不把一份错的 provider 配置写进 Paseo。
2. **出码 → 注册 → 打开开关**：点「生成配对二维码」，手机 Paseo App 扫码配对；
   点「注册到 Paseo」把 MTNode 会话注册成它的一个 ACP provider（走官方 CLI，官方负责合并与 reload）；
   最后打开「远程连接」总开关（**默认关**，配对完由你亲手开）。

> 控制台同时显示：CLI 落在哪、用哪个真 Node 拉起桥、数据目录、协议与最低 Paseo 版本、
> 「桥自检」结果，以及「重置配对凭据」（换 daemon 密钥，会作废所有已配对设备）。
>
> 老路径（本机手动装 Paseo + 手改 `~/.paseo/config.json` + 跑 `paseo reload`）仍然有效，
> 只是不再需要：同一件事已经收进插件控制台。想手工核对 provider 片段的话，它的真源是
> `paseo/bridge-info.js` 的 `providerSnippet()`（桥自己的 `--config` 打印的也是同一份）：

   ```json
   {
     "agents": {
       "providers": {
         "mtnode": {
           "extends": "acp",
           "label": "MTNode 会话",
           "command": ["<真 Node 可执行文件>", "<安装目录>\\resources\\paseo\\acp-bridge.mjs"],
           "env": { "MTNODE_DATA_DIR": "<你的 MTNode 数据目录>" }
         }
       }
     }
   }
   ```

   > `command` 必须是**真 Node**（Electron 自带的那个不算）。控制台给的就是当前应用在用的那个 Node。
3. **手机配对**：直接扫控制台里那张码（relay 扫码），
   或在手机上「Add host → Direct connection」填 Tailscale IP + 端口 6767。
   然后新建 agent 时选 **MTNode 会话**，就能看到会话清单了。

## 3. 怎么用

- 新建会话时可选的**模式**就是左栏那些会话（「新建 MTNode 会话」= 在电脑左栏新建一条）；
  「可接管的已有会话」清单来自桥的 `session/list`（电脑左栏里没归档的会话都在里面）。
  Paseo 会对清单里的每条会话再发一次 `session/load`，桥在那一步**把这条件话的正文回放**成
  ACP 的消息帧（它靠这些帧判断「这条会话有没有对话」，一条都不发就会把它从清单里剔掉）。
  回放上限：最近 **80 条**消息、单条 4000 字（可在 provider 的 env 里设
  `MTNODE_PASEO_HISTORY_LIMIT` 调整条数）。
- **模型与供应商在 Paseo 里选**：桥把本机的服务商配置整理成 ACP 的模型清单交出去
  （`models.availableModels`），模型 id 形如 `route::model`（如 `deepseek-official::deepseek-v4-flash`）。
  同一份清单也作为 ACP 的 **`configOptions`（`category: "model"` 的 select）**露出 ——
  Paseo 选模型有两条通道（先 `session/set_model`，这条不通才退到配置项那条），两条都实现了。
  - 手机上选中的模型**在新建会话时就生效**：桥到第一条消息才真在 MTNode 建会话，并把选中的
    provider / model 一起带过去（所以在手机上新建的会话，用的就是你选的那个模型）。
  - **已经有会话也能中途换模型**：桥调会话族的 `mtnode_session_model`，改的就是这条会话的
    provider / model 两个字段（与电脑上界面那两格「模型提供商 / 模型」同一落点），
    **下一条消息就用新模型**；历史消息与**正在跑的那一轮**不变（那一轮的模型在开轮时就定下了，
    这时手机上会收到一条说明帧）。这跟电脑上的行为一致 —— 不是「假装改成功」。
  - 真改不了时（模型不在该家清单里 / 这条会话已被删）桥**如实报错**，而且因为配置项那条通道也在，
    Paseo 会把桥的原话显示到手机上（早先两条通道缺一条时，它会替换成
    `acp does not expose ACP model selection` —— 那句与真实原因无关，是本轮修掉的 bug）。
  - 控制台「桥自检」里能看到当前有几个模型可选（`models: N`）、换模型的两条通道在不在
    （`model switching:` / `configOptions(model):`）。
- 发消息、插话、终止：与电脑上完全同一套语义 ——
  - 会话正在跑时，手机发的消息进**这条会话的发送队列**（不打断正在跑的那一轮）；
  - 「插话」优先塞进正在跑的那一轮，塞不进去自动回落成排队消息，一句话都不丢；
  - 「终止」= 电脑上那个 ■，连排队消息一起清掉。
- **审批**：会话里要写工作区外的文件、要跑命令、要改画布时，手机上会弹卡：
  允许一次 / 本会话后续都放行 / 拒绝。电脑上同时也会显示这张卡 —— **谁先答算谁的**。
- **模型提问（询问卡）**：模型用 `ask_user_question` 问话时，手机上弹的是一张**表单**
  （ACP 的 `session/elicitation`，form 模式）——一题一字段：单选题是一组按钮、
  多选题可勾多项、没有选项的题就是一行自由文本；题面第一行当标题，空行之后的 Markdown
  总结进字段说明（与电脑上询问卡同一份数据）。答完答案按题 id 回到 MTNode 的询问卡，
  模型接着往下跑，电脑侧会话里也会留下这轮回答的痕迹。
  - 手机端**不支持表单问答**（老版本 / 自己接的 ACP 客户端没声明 `elicitation.form`）时：
    桥会回退成「允许一次 / 拒绝」那一对按钮，**并推一条说明**让模型重发或到电脑上答 ——
    绝不代答、也不假装送达（回退路径是刻意保留的，不是故障）。
  - 桥没拿到回执（手机断线 / 你一直没答）时 MTNode 那边**继续等**，不自动作答也不自动拒绝。
- 手机断线时：MTNode 这边**继续等**（不自动拒绝、不自动超时），重连后接着答即可。
- **电脑上的界面会跟着动**：手机发一条消息时，MTNode 会把那条会话切成当前会话（这是
  会话正文落盘的必要条件 —— 渲染层只在「活动会话」换代或内容变脏时才写 `agent-sessions/<id>.json`），
  这一轮跑完再切回你原来在看的那条会话（你要是中途自己切走了，它就不抢）。

## 4. 边界（刻意不做）

| 不做 | 为什么 |
| --- | --- |
| 手机上直接改画布 | 共识：远程接管**只碰会话层**。改画布的动作仍由会话里的 Agent 发起，你只是替它按了确认按钮。 |
| 把会话族工具列给第三方 MCP 客户端 | 会话族（`mtnode_session_*`）只给桥内部用（走 `POST /ctl`），不进 `tools/list`，不撑大别的客户端的提示词。 |
| 手机上看模型的思考流 / token 用量 | 这一版只映射「正文分段 + 工具调用 + 权限请求」。 |
| 图片 / 附件消息 | 只转发文本（桥会明确拒绝图片块，不静默丢）。 |
| 不经 Paseo 的远程通道 | MTNode 不绑局域网 / 公网；远程一律走 Paseo 自己的 relay 或 Tailscale。 |

顺带一条工程口径（用户能感知到的副作用）：**Paseo 每次刷新 provider 清单都会探针式地发一次
`session/new`**，桥在这种探针上**不在 MTNode 建会话**（只登记一条 pending，第一条消息才真建）——
所以刷清单不会在左栏留下空会话。同一条道理：`session/load` 让 Paseo 取到的是**已有会话的正文**，
它不会新建；桥声明 `sessionCapabilities.close` 后 Paseo 也会把用完的探针会话收掉。

## 5. 排障

插件控制台上先点「**桥自检**」——它就是真跑一次：

```bash
"<真 Node>" "<安装目录>\resources\paseo\acp-bridge.mjs" --check
```

它会打印：桥脚本路径 / Node 版本 / 数据目录候选 / **探活结果** / **模型 N 个** / **换模型的两条通道** / **可接管会话 M 条**。逐条对照：

| 现象 | 原因与处置 |
| --- | --- |
| Paseo 里选模型报 **`acp does not expose ACP model selection`** | Paseo 选模型先在 `session/set_model` 上试，**回错误就退到 ACP 配置项（`category: model`）那条路**；两条都不通才会抛这句（`acp` 是 `extends` 基名，不是 provider id）。本轮已修：`session/set_model` 真改这条会话的 provider/model，`configOptions` 那条通道也补上了。若在旧包上看到它 → 桥脚本是旧的：重新打包 / 让控制台「注册到 Paseo」把 `command` 指到新桥脚本后 reload。自检里 `model switching:` 与 `configOptions(model):` 两行就是这两条通道在不在。 |
| 桥自检说「找不到 MTNode 的本地服务端」 | MTNode 没开，或「服务端」总开关被关了；也可能数据目录不一致 —— 自检会把**逐条候选**的探活结果列出来。 |
| 桥自检说「探活失败 ECONNREFUSED」 | 端口是上次启动的旧端口（**端口每次启动都会变**）：重开 Paseo 的 provider / 重跑 daemon 即可。 |
| 手机上「**未检测到 Model**」 | 桥没把模型清单交出去。看控制台「手机端能选到」那行或自检的 `models: N`：为 0 说明渲染层没就绪（MTNode 主窗口关着）或服务商配置是空的 —— 先在 MTNode 里配好服务商 / 打开窗口，再在控制台点「注册到 Paseo」重来一次让它 reload，手机上**下拉刷新**。 |
| 手机上看不到任何**已有会话** | 两处都得对：桥要在 `initialize` 里声明 `sessionCapabilities.list`（旧版桥没声明，Paseo 直接回空清单），并且它得真跑 `session/list`、并在 `session/load` 里**回放正文**（Paseo 靠 load 期间的帧判断这条会话有没有对话，没有就把它剔掉）。自检的 `sessions: M` 就是桥交出去的条数：显示 0 但左栏明明有会话 → 那些会话被归档了；数字正常但手机空 → Paseo 版本旧 / 没 reload，重开 provider 后再刷新。 |
| 控制台说「没找到 Paseo 的命令行」 | 本机没装 Paseo，或装在非常规路径；点控制台的「安装后端」自建一份，或装官方桌面端。**若本机其实装着桌面端**，控制台会多一颗「改用本机已装的 Paseo」，点它切回复用即可。 |
| 「安装后端」跑完仍显示未装好 | 看控制台「安装自检」那行的原因：`dep_missing` 依赖没落盘（npm 报错/被打断）、`cli_bin_missing` 依赖在但 `.bin\paseo.cmd` 没生成（半成品，宿主已自动清掉重装过一次）、`cli_not_runnable` CLI 在位但 `--version` 失败。处置：点「重装依赖（修复）」，或「换目录重装」换一个普通目录（**不要**选 MTNode 自己的目录、也不要用要管理员权限的位置）；仍失败看日志里的 npm 输出。 |
| 起后端后手机连着又断 / 控制台说 daemon 没在跑 | 多半是**端口被本机已装的 Paseo 占着**（6767）：看日志里有没有 `EADDRINUSE`。自建后端会在安装时把 `daemon.listen` 钉到一个空闲端口；手动起撞上时再点一次「启动后端」会自动换端口重试。 |
| 控制台标「是 Electron 自带 Node（桥要真 Node）」 | 本机没有 Node ≥22.19：桥由真 Node 拉起是硬要求。装 Node 后重开 MTNode，或点「等真 Node 就位」（dsh 会把托管 Node 装进数据目录）。这段时间里注册 provider 会被明确拒绝（不写错配置）。 |
| 出码时报 `RELAY_DISABLED` | 这个 Paseo home 的 relay 关着（**新装默认关**）；点控制台「开启 relay」或 `paseo daemon config set daemon.relay.enabled true`。 |
| Paseo 里看不到 MTNode 会话 provider | provider 没注册 / 没 reload / 缺 `label`：在控制台点「注册到 Paseo」重来一次；`command` 第一条要是真 Node，不能是 Electron 可执行文件。 |
| Paseo 报「版本过低」 | 本桥声明了最低兼容版本（控制台上「协议 / 最低 Paseo 版本」可见）。升级 Paseo；确实要用未验证的组合可设环境变量 `MTNODE_PASEO_MIN_VERSION` 放宽。 |
| 手机上发消息没反应 | 看控制台「正在接管 N 条会话」是否为 0（为 0 说明没有观察者：桥没连上），以及「远程连接」总开关是否打开；再看 MTNode 主窗口是否还开着 —— 会话的执行在渲染层，窗口关了没人执行。 |
| 手机上答了审批但电脑上还挂着卡 | 那张卡已失效（发起轮结束 / 已被别处答过）：手机上会明确报 stale，让模型重发一次请求。 |
| 手机上**询问卡不弹**、模型在电脑侧一直干等 | 先在控制台点「**提问通道自检**」——它把这条链逐拍验一遍：① 桥起得来、② 会话落到 MTNode、③ MTNode 真的发出询问卡、④ 桥把它翻成 `session/elicitation`（form）、⑤ 表单回执翻成 `answers[]`、⑥ 答案回到 MTNode。哪一拍 ✗ 就是断在哪一拍：<br>· ④ ✗ 且改发权限请求 → 客户端没声明 `elicitation.form`（Paseo 版本旧，或自己接的 ACP 客户端没声明）；<br>· ④ 全没有 → 卡根本没从 MTNode 出去（看那一轮是不是真调了 `ask_user_question`）；<br>· ⑥ ✗ → 回执没落回 MTNode（会话已被删 / 该轮已结束，日志里会写明）。 |
| 手机上答了询问卡但模型没反应 | 同上先跑「提问通道自检」。手机端答的是**表单**，答案要经桥翻成 `{ answers: [{id, selected[]}] }` 再打回 MTNode —— 自检的 ⑥ 就是验这一段；它通过而真机没反应时，多半是那一轮已经结束（卡作废，电脑上会看到「这一轮已经结束」的痕迹）。 |
| 手机上的提问卡只有「允许一次 / 拒绝」两个按钮 | 走到了**回退**路径（客户端不支持 form elicitation）：卡片上同时会有一条说明。要让表单问答生效，把 Paseo 升级到声明 `elicitation.form` 的版本，或换支持该能力的客户端。 |
| 想作废已经发出去的配对码 | 官方**没有撤销接口**（offer 无有效期、无 nonce）：控制台「重置配对凭据」= 换 daemon 密钥并重启，**会作废所有已配对设备**（密钥先备份到数据目录）。 |

## 6. 连不上时手查（不依赖面板）

```powershell
# 1) MTNode 的服务端在不在（端口 + 令牌落在这个文件里）
Get-Content "$env:APPDATA\pipeline-console\pipeline-console\mcp-server.json"

# 2) 会话族通不通（有会话就该回一串 sessions）
$j = Get-Content "$env:APPDATA\pipeline-console\pipeline-console\mcp-server.json" | ConvertFrom-Json
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$($j.port)/ctl" `
  -Headers @{ authorization = "Bearer $($j.token)" } -ContentType 'application/json' `
  -Body '{"method":"session/list","params":{}}'
```

## 7. 关键文件（工程口径）

| 路径 | 作用 |
| --- | --- |
| `paseo/main-paseo.js` | **插件主进程宿主**：认后端（复用 / 自建）、配对、注册 provider、远程总开关、控制台窗、报错总线 |
| `paseo/preload-paseo.js` | 控制台窗的能力桥（`window.paseoApi`，白名单转发 `paseoRemote:*`） |
| `paseo/ui/{index.html,ui.js,ui.css}` | 插件控制台（状态 / 二维码 / provider / 开关 / 前置依赖 / 日志） |
| `paseo/qr.js` | 自研零依赖二维码编码器（官方 `qr` 字段是 ANSI 字符画，不能直接用于界面） |
| `paseo/acp-bridge.mjs` | 桥本体：ACP（stdio JSON-RPC）↔ MTNode 本机 HTTP；`--config` / `--check` / `--probe-question`（提问通道自检：跑一次真桥，逐拍验询问卡那条链） |
| `paseo/bridge-info.js` | 落点与 provider 配置片段的**单一真源**（桥、宿主与控制台共用一份纯函数） |
| `session-bridge.js` | 主进程侧的会话回路：文件层读会话 + 按会话分发实时事件给观察者；`probeQuestion` / `probeAnswer` 供提问通道自检用（不是给模型 / 第三方客户端的口） |
| `session-tools.js` | 会话族（`mtnode_session_*`，11 个）的参数表（手写，不进生成契约） |
| `renderer/app-session-bridge.js` | 渲染层执行那一半：发消息 / 插话 / 终止 / 审批 / **换模型（`sessionModel`）** / 模型清单 + 事件旁路 |
| `renderer/mcp-bridge.js` | 帧分派：会话族在这一支里（**不**打开「第三方已授权」开关） |
| `mcp-server.js` | 会话族的协议面：`POST /ctl` 的 `session/*`、`GET /session/stream`（SSE）；**会话族闸门**（`sessionGate`）与 `dropSessionStreams` 也在这里 |
| `plugins/catalog.default.json` | 插件卡片词条（id `paseo-remote` / kind `paseo`） |
| `skills/paseo-remote-install/SKILL.md` | 安装 / 自我修复技能（报错弹窗的「交给 mtnode 会话修复」按它走） |
| `test/smoke-paseo-remote.js` | 冒烟：五层接线 + 宿主契约 + 会话族闸门 + QR 真编码 + 打包与交付 |
| `test/smoke-session-bridge.js` | 冒烟：主进程回路 + 协议面 + SSE + 渲染层接线 + 打包白名单 |
| `test/smoke-paseo-bridge.mjs` | 冒烟：真子进程跑桥，假 MTNode + 假 ACP 客户端走完一整轮（含模型清单 / 配置项两条换模型通道 / 懒创建 / `session/list` / 审批 / **询问卡（form elicitation）+ 回退** / 取消 / `--check` 计数） |

## 8. 参考

- Paseo 文档：[连接方式（relay / Tailscale / SSH）](https://paseo.sh/docs/connectivity)、
  [自定义 provider（ACP）](https://paseo.sh/docs/custom-providers)、
  [安全模型](https://paseo.sh/docs/security)
- ACP 协议：[v1 总览](https://agentclientprotocol.com/protocol/v1/overview)、
  [schema（session/new · session/prompt · session/update · session/request_permission）](https://agentclientprotocol.com/protocol/v1/schema)
