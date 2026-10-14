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

## 2. 装（两步：安装窗装、控制台配）

**第一步 · 装** —— 顶栏「**插件**」→「**Paseo 手机接管**」卡片上点「**安装**」（已装过就是「重装」）：
它开的是与其它本地后端**同一只安装窗**（`paseo-remote`，kind `paseo`），逐步骤显示、可取消、失败可交给会话修复。

1. **探测本机已装的 Paseo**（第一步）：桌面端自带的 CLI（`C:\Program Files\Paseo\resources\bin\paseo.cmd`）
   或 PATH 里的 `paseo` 都能直接用 —— 命中就**复用**，后面 node / npm / 自检 / 起 daemon 四步全部标「跳过」，
   不给你装第二份（免得抢端口与配对身份）。想强制装一份自建的，在安装窗里勾「**仍要自建一份（忽略本机已装的 Paseo）**」。
2. **真 Node（≥22.19）**：缺 / 过旧时安装窗会**自动装一份托管 Node** 进数据目录
   （桥的 `command[0]` 必须是真 Node，Electron 自带的那个 Paseo 不认）。
3. **npm 安装 @getpaseo/cli**：只有走自建那份时才跑（`npm i @getpaseo/cli --prefix <插件根目录>\paseo`，走国内镜像）。
   - **装完会自检**：`paseo --version` 真能报版本才算装好（只看依赖目录在不在会误报 —— 曾经的现场就是
     `[install] 完成：code=0 installed=false`）。第一次自检不过会自动清掉半成品（`node_modules` + lock）重装一次；
     仍不过就停在失败步给出原因（依赖没落盘 / bin 没生成 / CLI 跑不起来）与建议。
   - **不抢端口**：官方 daemon 的 listen 来自持久配置 `daemon.listen`（默认 6767），而桌面端那份长期占着 6767。
     自建那份起来前会先把 `daemon.listen` 钉到第一个空闲端口（6768+），只写自建 home 的配置，不动你 `~/.paseo` 那份。
4. **注册 provider**：写 `agents.providers.mtnode`；Paseo 里正有会话在跑时**不动配置**（这一步标「跳过」，
   到控制台点「注册到 Paseo」确认一次）。
5. **起自建 daemon**（复用模式跳过：那份 daemon 由 Paseo Desktop 自己管）。自建这份由**宿主静默托管**：
   跑的是 `paseo daemon run --home <自建 home>`（宿主自己持有这个进程，`windowsHide` + 接管 stdio），
   **不会再冒出那只标题 `Paseo Daemon` 的终端窗口** —— 过去用官方 `paseo daemon start` 时，
   它会自己 detached 一个 supervisor，Windows 上就多出一只可见窗口，误关一下后端就死了。
   daemon 的输出逐行进控制台日志（`<数据目录>\paseo\console.log`）。
6. **配对冒烟**：只读试算一次配对码；relay 关着时标「跳过」并提示去控制台开 relay。
7. **收尾**：远程接管总开关**不会自动打开**（默认关是安全口径）—— 提示你去控制台亲手开。

自建那份用不了、而本机其实装着 Paseo 时，**探测步骤会直接切回复用**（只用你点「安装」这一下，不静默改配置）；
要自建就在窗里勾上面那个复选框。卸载也在同一只窗里（底栏「卸载」）：只清这个插件自己的数据
（自建依赖 / 配置 / 日志 / 自建 daemon home），**本机已装的 Paseo Desktop 与 `~/.paseo` 一律不碰**。

**第二步 · 配** —— 打开「**控制台**」（卡片第二颗按钮），按顺序做三件事：
点「生成配对二维码」，手机 Paseo App 扫码配对；点「注册到 Paseo」把 MTNode 会话注册成它的一个 ACP provider
（走官方 CLI，官方负责合并与 reload）；最后打开「远程连接」总开关（**默认关**，配对完由你亲手开）。
自建模式下控制台还有「启动后端 / 停止后端」两颗：启动 = 宿主静默托管（后台跑、不留窗口），
**停止 = 优雅停 5 秒，超时按进程树强杀**；自建这份**随 MTNode 退出而停**（它是 MTNode 的子进程，
不再是一只独立窗口里的常驻进程）—— 要手机随时连着，就先别关 MTNode。意外退出宿主会自动重启，最多 3 次。

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
- **模型提问（询问卡）**：模型用 `ask_user_question` 问话时，手机上收到的是一条**普通消息**
  （`session/update · agent_message_chunk`）：题面第一行当标题、空行之后的 Markdown 总结照样带上，
  有选项的题把选项连说明一起列出来，末尾写清「**怎么答**」——正文是纯人话，**一个 JSON 都没有**。
  **作答 = 在手机输入框里回一条消息**：桥把这条回复按题翻成 `answers[]`（逐题按题 id 对齐）+
  一条可读 `answerText`，走 `/ctl` 的 `session/approval` 打回 MTNode 那张询问卡，模型接着往下跑，
  电脑侧会话里也会留下这轮回答的痕迹。手机发消息时 Paseo 会先 interrupt（`session/cancel`）再发 ——
  桥在「正等作答」时**不会**因此停掉 MTNode 那一轮（只把旧那一枪按 ACP 要求以 `cancelled` 收尾）；
  真按「停止」时（3 秒内没等到那条消息）才照常停。
  - **被手机端接管的会话，电脑上不再弹询问卡**（本轮口径）：手机端只有纯文字，**没有关掉
    MTNode 界面上那张卡的入口** —— 过去卡会一直挂在电脑上等人点，用户又不在电脑前，看着就是
    「弹窗卡住了会话」。现在判据 = **这条会话正被手机端观察**（桥自己开的 `session/watch`）：
    凡是被它登记过的会话，电脑侧不再开询问卡（已经开着的当场撤掉），改在会话里落一行可读痕迹
    ——痕迹里写明「这一问走手机纯文字、在手机输入框里回一条消息即答案、答案会落回这条会话」。
    手机端那条可读消息与 `answers[]` 回执**完全不受影响**（这条链本来就不经过电脑上那张卡）。
    自己坐在电脑前的那条会话（没人用手机看）照旧弹卡点选；工具审批与画布修改确认**两种卡不变**。
  - **为什么不走权限卡 / 表单**（踩过的两个坑）：
    · ACP 的 `ToolKind` 只有 read/edit/delete/move/search/execute/think/fetch/switch_mode/other，
      **没有 `question`** —— 发 `toolCall.kind:"question"` 会被 Paseo daemon 的校验**整帧拒掉**
      （`-32602 Invalid params`，`data.toolCall.kind`），询问卡根本到不了手机；
    · 就算 kind 合法也用不上 Paseo 的问句表单：它的渲染条件是客户端自己的
      `request.kind === "question"` 且 `request.input.questions[]`，而 ACP 通道里 daemon 只产出
      `kind: "tool"/"mode"`、**从不填 `input`**（0.11.2 的 `mapPermissionRequest`）。
  - **不再走 ACP 的 form elicitation**：那条通道要客户端声明 `clientCapabilities.elicitation.form`，
    而真机 Paseo（0.11.2 实测：客户端能力只有 `fs` + `terminal`）**从不声明**。这一版起提问走上面那条
    可读消息：**不依赖任何客户端能力位**，也不再发「这台手机端不支持表单问答」那句说明帧。
  - **提问类工具自己的工具卡不再下发**：`ask_user_question` 的参数就是那份询问 JSON，
    过去它被翻成 `toolCall.kind:"other"` 的工具卡，Paseo 把这类卡显示成 **Other**
    （`humanizeToolName("other")`），点开是原始 JSON —— 用户报的「手机端显示 Other，点进去是 JSON」
    说的就是它。现在提问只以那条可读消息出现；其它工具调用也不再写死 `kind:"other"`，
    手机上显示的是可读的工具名。
  - 断线 / 一直没答时 MTNode 那边**继续等**，不自动作答也不自动拒绝；电脑上先答了的话，
  手机再回的那条消息会按**普通消息**发下去（不会当成答案吞掉）。
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
| 安装窗说「没找到 Paseo 的命令行」 | 本机没装 Paseo，或装在非常规路径；在安装窗点「开始安装」让它自建一份（`npm i @getpaseo/cli`），或装官方桌面端。**若本机其实装着桌面端**，探测步骤会自己切回复用，不装第二份。 |
| 安装失败停在某一步 | 看安装窗左栏哪一步是 ✕：`node` = 真 Node 不达标且托管安装没成（网络 / 代理），`npm` = npm install 失败（镜像 / 磁盘），`check` = 装上了但 `paseo --version` 不通过（多半是旧 Node 装出来的依赖，点「重装」会先清掉再用真 Node 装回），`daemon` = 端口全被占或起不来，`provider` = 写 Paseo 配置失败，`pair` = relay 关着（去控制台点「开启 relay」）。失败步下会给出处置建议，也可以直接点「交给 mtnode 会话修复」。 |
| 安装窗跑完仍显示未装好 | 看控制台「安装自检」那行的原因：`dep_missing` 依赖没落盘（npm 报错/被打断）、`cli_bin_missing` 依赖在但 `.bin\paseo.cmd` 没生成（半成品，安装链已自动清掉重装过一次）、`cli_not_runnable` CLI 在位但 `--version` 失败。处置：到安装窗点「重装」；仍失败就把那一步的日志交给会话修复。 |
| 起后端后手机连着又断 / 控制台说 daemon 没在跑 | 多半是**端口被本机已装的 Paseo 占着**（6767）：看日志里有没有 `EADDRINUSE`。自建后端会在安装时把 `daemon.listen` 钉到一个空闲端口；手动起撞上时再点一次「启动后端」会自动换端口重试。 |
| 控制台 daemon 那行标着「**旧方式（带窗口）**」 | 这份是过去用官方 `paseo daemon start` 起的（它自己 detached 一个 supervisor，Windows 上外面挂着一只标题 `Paseo Daemon` 的终端窗口）。宿主会在**开机 / 下次启动后端时自动换成静默托管**（先优雅停旧的再以 `daemon run` 拉起，配对密钥与配置都不动，手机至多瞬断一次）；也可以手动点「停止后端」再「启动后端」。 |
| 关掉 MTNode 后手机就连不上了 | 本轮口径：自建那份 daemon 由宿主持有，**随 MTNode 退出而停**（过去那只独立窗口里的常驻进程不再存在）。要手机随时连着就别关 MTNode；复用模式的 daemon 由 Paseo Desktop 自己管，不受影响。 |
| 控制台日志里刷出一堆 `{"level":30 …}` | daemon 的 stdout/stderr 是逐行进控制台日志的（本意如此：过去只有 `<自建 home>\daemon.log` 里能看到）。要更完整的现场看那份 `daemon.log`。 |
| 控制台标「是 Electron 自带 Node（桥要真 Node）」 | 本机没有 Node ≥22.19：桥由真 Node 拉起是硬要求。到安装窗跑一次安装（第 2 步会把托管 Node 装进数据目录），装完重开 MTNode。这段时间里注册 provider 会被明确拒绝（不写错配置）。 |
| 出码时报 `RELAY_DISABLED` | 这个 Paseo home 的 relay 关着（**新装默认关**）；点控制台「开启 relay」或 `paseo daemon config set daemon.relay.enabled true`。 |
| Paseo 里看不到 MTNode 会话 provider | provider 没注册 / 没 reload / 缺 `label`：在控制台点「注册到 Paseo」重来一次；`command` 第一条要是真 Node，不能是 Electron 可执行文件。 |
| Paseo 报「版本过低」 | 本桥声明了最低兼容版本（控制台上「协议 / 最低 Paseo 版本」可见）。升级 Paseo；确实要用未验证的组合可设环境变量 `MTNODE_PASEO_MIN_VERSION` 放宽。 |
| 手机上发消息没反应 | 看控制台「正在接管 N 条会话」是否为 0（为 0 说明没有观察者：桥没连上），以及「远程连接」总开关是否打开；再看 MTNode 主窗口是否还开着 —— 会话的执行在渲染层，窗口关了没人执行。 |
| 手机上答了审批但电脑上还挂着卡 | 那张卡已失效（发起轮结束 / 已被别处答过）：手机上会明确报 stale，让模型重发一次请求。 |
| 电脑上弹出一张**没人点得动**的询问卡（人在手机上，卡在那里挡着） | 旧包才会这样：那一版认不出「这条会话正被手机端观察」，照旧在电脑上开卡。本轮起被手机观察的会话**不在电脑上开询问卡**（已有的当场撤），改落一行痕迹；手机那条可读消息与作答链不变。判据是桥自己开的 `session/watch`，所以**要重新打包 + 重启**才会生效（渲染层那一半在 `app.asar` 里）；开发态（`npm start`）改完重启即生效。 |
| 手机上**询问卡不弹**、模型在电脑侧一直干等 | 先在控制台点「**提问通道自检**」——它把这条链逐拍验一遍：① 桥起得来、② 会话落到 MTNode、③ MTNode 真的发出询问卡、④ 桥把它发成一条**可读消息**（`agent_message_chunk`，正文里没有 JSON、也不再发 `kind:"question"` 的权限卡）、⑤ 手机那条回复被当作答案接住（回 `end_turn`，不新起一轮）、⑥ 答案回到 MTNode。哪一拍 ✗ 就是断在哪一拍：<br>· ④ 全没有 → 卡根本没从 MTNode 出去（看那一轮是不是真调了 `ask_user_question`），或桥脚本是旧的（重新打包 / 让控制台「注册到 Paseo」把 `command` 指到新桥脚本后 reload）；<br>· ④ 说「又发了 `session/request_permission(kind=question)`」→ 桥脚本是旧的：ACP 没有那个 kind，Paseo 会整帧拒；<br>· ⑥ ✗ → 回执没落回 MTNode（会话已被删 / 该轮已结束，日志里会写明）。 |
| 手机上答了询问卡但模型没反应 | 同上先跑「提问通道自检」。**作答方式 = 在手机输入框里回一条消息**（不是点卡上的按钮）：桥把这条回复翻成 `{ answers: [{id, selected[]}] }`（外加一条可读 `answerText`）再打回 MTNode —— 自检的 ⑤⑥ 就是验这一段；它通过而真机没反应时，多半是那一轮已经结束（卡作废，电脑上会看到「这一轮已经结束」的痕迹），这时手机那条消息会按普通消息发下去。 |
| 手机上看到的提问是 **Other**、点进去是一堆 JSON | 桥脚本是旧的：那一版把提问工具自己的 tool 事件翻成 `toolCall.kind:"other"` 的工具卡，Paseo 把这类卡显示成 `humanizeToolName("other") = **Other**`，详情是 `{type:"unknown", input: rawInput}` 的原始 JSON。新桥把提问发成一条可读消息、提问类工具卡一律不下发、其它工具卡也不再写死 `kind:"other"`。重新打包 / 让控制台「注册到 Paseo」指向新桥脚本，再 reload provider。 |
| 手机上询问卡的**单选处显示 `[层级过深已省略]`** | 选项文本没到手机：MTNode 侧把询问卡事件当普通事件瘦身，而选项在第 4 层（`data.questions[].options[].label`），被整片换成占位符 —— 桥拿到的是一串占位字符串，只能把它们当标签打印出来。两条病因都已修：① 询问卡帧不做结构裁剪与文本截断（只保留「内联媒体换一句摘要」；审批 / 画布确认那两种卡手机只用标题 + 一行说明，仍照旧瘦身）；② **超过一帧 12KB 上限的长卡片**不再走「按深度 1 重裁」那条兜底（那条一裁就把第 4 层的选项整片换成占位符）—— 长卡片按**结构条数**（200 题 / 每题 50 选项）兜底，文本一个字都不截，真裁了也只留一句人话「（这段内容因为太长没能送到手机，请在电脑上作答）」。桥侧也不再截断选项与说明。<br>旧包上还会看到它，而且**只重开 MTNode 没用** —— 两半代码都要跟着更新：渲染层那一半在 `app.asar` 里、桥那一半在 `resources/paseo/`（asar 外），只有**重新打包**才会换新。开发态（`npm start`）读的就是源码，改完重启即生效；打包态（`dist/win-unpacked` 或安装版）必须先 `npm run compile`（只出 win-unpacked）或 `npm run dist`（出安装包）**再**重启，否则跑的还是旧构建（可核对：`app.asar` 里搜得到 `VERBATIM_TYPES`、`resources/paseo/acp-bridge.mjs` 里没有 `oneLine(x.label, 120)` 才算新）。手机聊天记录里那条旧消息会一直躺着，要看**新发起**的那张卡。 |
| 控制台点「提问通道自检」直接停在 ③、报 **未知的方法：`session/probe-question`** | 旧包的判据错在**跨进程**：放行那道闸长在**正在跑的 MTNode** 身上，而自检是桥 spawn 出来的**另一个进程** —— 父进程给子进程设的 `MTNODE_PASEO_PROBE_CHILD` 到不了 MTNode 进程，于是这条口永远关着（2026-10-15 实测复现；这个报错本身就是「旧包」的判据）。修好之后自检客户端改把这枚标志当**请求头** `x-mtnode-selfcheck: 1` 发出（随请求走，进程边界不丢），MTNode 只认这枚头；仍要过会话族闸门与 Bearer token，普通桥 / 第三方客户端看不到这条口。**要重新打包 + 重启**才会生效（mcp-server.js 在 `app.asar` 里、桥在 `resources/paseo/`）。 |
| 手机上回了消息，模型却当成**新指令** | 桥脚本是旧的（旧版没有「等作答」这条挂起：用户消息一律当新一轮下发）。另外这条挂起只在当前这一轮真的挂着询问时生效；电脑上先答过、或那一轮已结束，手机那条消息就按普通消息发。 |
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
| `paseo/main-paseo.js` | **插件主进程宿主**：认后端（复用 / 自建）、**安装窗会话（登记 / 步骤上报 / 卸载）**、配对、注册 provider、远程总开关、控制台窗、报错总线；**自建 daemon 的静默托管**（`paseo daemon run` 宿主持有：零新增可见控制台窗口 / 输出逐行进控制台日志 / 意外退出重启 ≤3 次 / 优雅停 5 秒再强杀 / 随 MTNode 退出而停 / 旧「带窗口」实例开机静默迁移） |
| `paseo/steps.json` | **安装窗的步骤表真源**（8 步：探测 / 真 Node / npm / 自检 / provider / daemon / 配对冒烟 / 收尾）+ 失败文案表（`messages`）；宿主用 `install-step-reporter` 按同一批 id 上报状态 |
| `paseo/preload-paseo.js` | 控制台窗的能力桥（`window.paseoApi`，白名单转发 `paseoRemote:*` + `mtnodeInstall:open`） |
| `paseo/ui/{index.html,ui.js,ui.css}` | 插件控制台（**只读后端状态 + 打开安装窗 + 启停** / 二维码 / provider / 开关 / 前置依赖 / 日志） |
| `paseo/qr.js` | 自研零依赖二维码编码器（官方 `qr` 字段是 ANSI 字符画，不能直接用于界面） |
| `paseo/acp-bridge.mjs` | 桥本体：ACP（stdio JSON-RPC）↔ MTNode 本机 HTTP；`--config` / `--check` / `--probe-question`（提问通道自检：跑一次真桥，逐拍验「询问卡 → 可读消息 → 文本作答 → 回执」那条链） |
| `paseo/bridge-info.js` | 落点与 provider 配置片段的**单一真源**（桥、宿主与控制台共用一份纯函数） |
| `session-bridge.js` | 主进程侧的会话回路：文件层读会话 + 按会话分发实时事件给观察者；`probeQuestion` / `probeAnswer` 供提问通道自检用（不是给模型 / 第三方客户端的口） |
| `session-tools.js` | 会话族（`mtnode_session_*`，11 个）的参数表（手写，不进生成契约） |
| `renderer/app-session-bridge.js` | 渲染层执行那一半：发消息 / 插话 / 终止 / 审批 / **换模型（`sessionModel`）** / 模型清单 + 事件旁路；**被手机端观察的会话名单**（`session/watch` → `remoteDriven`，对外给 `isRemoteDriven(sid)`，并调 `window.ixDropQuestionCardsOf` 收掉电脑上已开的询问卡） |
| `renderer/app-db.js` | 询问窗那一半：`ixRemoteDriven(runKey)` 判「这一轮是不是被手机端驱动」→ `ixPush` 对询问类卡**不开卡**、改落一行痕迹（审批卡与危险动作确认卡不受影响）；回归见 `test/smoke-paseo-no-popup.js` |
| `renderer/mcp-bridge.js` | 帧分派：会话族在这一支里（**不**打开「第三方已授权」开关） |
| `mcp-server.js` | 会话族的协议面：`POST /ctl` 的 `session/*`、`GET /session/stream`（SSE）；**会话族闸门**（`sessionGate`）与 `dropSessionStreams` 也在这里 |
| `plugins/catalog.default.json` | 插件卡片词条（id `paseo-remote` / kind `paseo`） |
| `skills/paseo-remote-install/SKILL.md` | 安装 / 自我修复技能（报错弹窗的「交给 mtnode 会话修复」按它走） |
| `test/smoke-paseo-remote.js` | 冒烟：五层接线 + 宿主契约 + 会话族闸门 + QR 真编码 + 打包与交付 |
| `test/smoke-session-bridge.js` | 冒烟：主进程回路 + 协议面 + SSE + 渲染层接线 + 打包白名单 |
| `test/smoke-paseo-bridge.mjs` | 冒烟：真子进程跑桥，假 MTNode + 假 ACP 客户端走完一整轮（含模型清单 / 配置项两条换模型通道 / 懒创建 / `session/list` / 审批（权限卡）/ **询问卡（可读消息 + 手机下一条消息作答 + `answers` 回执 + 先 interrupt 再作答不停 MTNode）** / 取消 / `--check` 计数） |
| `test/smoke-paseo-daemon-silent.js` | 冒烟：自建 daemon 的**后台静默**口径 —— 静态（不再用 `daemon start`、`windowsHide` + stdio 管道、退出收尾、重启上限 3 / 优雅停 5 秒）+ **真测量**（真起一次后端，用 `scripts/probe-console-windows.ps1` 数可见控制台窗口，断言零新增）+ 生命周期（`/api/status` / pid 锁同树 / 停完不留孤儿）+ 存量迁移判据 |
| `test/smoke-paseo-install-isolation.js` | 冒烟（离线）：空机器 / 半成品 / 回落 / 自检判据 / 旧 Node 拒绝安装 |

## 8. 参考

- Paseo 文档：[连接方式（relay / Tailscale / SSH）](https://paseo.sh/docs/connectivity)、
  [自定义 provider（ACP）](https://paseo.sh/docs/custom-providers)、
  [安全模型](https://paseo.sh/docs/security)
- ACP 协议：[v1 总览](https://agentclientprotocol.com/protocol/v1/overview)、
  [schema（session/new · session/prompt · session/update · session/request_permission）](https://agentclientprotocol.com/protocol/v1/schema)
