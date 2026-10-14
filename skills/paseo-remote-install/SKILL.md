---
name: paseo-remote-install
title: Paseo 手机接管插件安装与修复
description: 把「Paseo 手机接管」插件的后端装好或修好。安装走插件卡片上那颗「安装 / 重装」开的**通用安装窗**（`plugins/main-install.js` 那只窗，步骤表真源 `paseo/steps.json`）：第一步探测本机已装的 Paseo（桌面端自带 resources\bin\paseo.cmd，或 PATH 里的 paseo）并优先复用（不装第二份），没有才在**插件根目录下的 paseo 子目录** npm 装 @getpaseo/cli 并起独立 daemon（独立 home、避开 6767 冲突；**由宿主静默托管**：`paseo daemon run`，不再用官方 `daemon start`，因为后者在 Windows 上会留一只可被误关的终端窗口）；随后注册 provider、试算配对码，收尾只提示去控制台开远程开关。控制台只做只读状态 + 打开安装窗 + 启停。含自我修复指引（RELAY_DISABLED / CLI 找不到 / daemon 起不来 / provider 没生效 / 手机连不上）。
---

# Paseo 手机接管 — 安装 / 修复

当用户或 MTNode 插件要求**安装**或**自我修复**「Paseo 手机接管」（应用插件 `paseo-remote`，kind `paseo`）时使用本 skill。

插件调用时给的现场：

- **当前工作区就是 `INSTALL_DIR`**（可写）：自建后端时它是 `npm install --prefix` 的目标目录（默认 = 插件根目录 + `paseo`，即用户设的插件根目录下的 `paseo` 子目录；`node_modules/.bin/paseo.cmd` 就在里面）；复用模式（用本机已装的 Paseo）时它是宿主数据目录 `%APPDATA%\pipeline-console\paseo`。
- **`CONSOLE_LOG`（插件控制台最近日志）**：`<数据目录>\paseo\console.log`——`[install]` / `[pair]` / `[provider]` / `[daemon]` / `[reset]` / `[migrate]` 这些前缀就是宿主的每一步动作，**先读它定位，再动手**。
  （老机器上这份日志可能在旧落点 `<数据目录>\app-plugins\paseo-remote\console.log`：宿主首次注册时会把配置 / 日志 / 自建 home 搬到 `<数据目录>\paseo`，旧文件保留不删。）
- **Paseo 的 home**：复用模式 `%USERPROFILE%\.paseo`；自建模式 `<数据目录>\paseo\paseo-home`（旧落点 `<数据目录>\app-plugins\paseo-remote\paseo-home` 会被搬迁过来）。`config.json` / `daemon-keypair.json` / `server-id` / `paseo.pid` / `daemon.log` 都在里面。

## 目标（装好的判据）

按顺序全部成立才算可用：

1. **CLI 可用**：`"<CLI>" --version` 有版本号输出（当前实测组合：0.11.2 / Apache-2.0）；
2. **daemon 在跑**：`<home>\paseo.pid` 存在，且 `http://127.0.0.1:6767/api/status`（或 pid 里那条 listen）返回 `{status:"server_info",…}`；
3. **relay 已开**：`<home>\config.json` 的 `daemon.relay.enabled === true` —— **新装的 home 默认是关的**，关着时 `daemon pair` 会以退出码 1 报 `RELAY_DISABLED` 且不给二维码；
4. **provider 已注册**：`<home>\config.json` 的 `agents.providers.mtnode` 存在，且形如
   `{ "extends": "acp", "label": "MTNode 会话", "command": ["<真 Node>", "<…>\paseo\acp-bridge.mjs"], "env": { "MTNODE_DATA_DIR": "<MTNode 数据目录>" } }`；
5. **能出配对码**：`"<CLI>" daemon pair --json` 回 `{relayEnabled:true, url:"https://app.paseo.sh/#offer=…", qr:"…", connectionUri:"relay://…"}`；
6. **MTNode 侧开关打开**：插件的「远程连接」总开关默认关，配对完要由用户打开（关着时会话族一律拒绝）。

## 前置

- **node / npm**：自建后端需要 Node ≥ 22.19（Paseo 官方仓库口径 22.20.0，本机 Node 24 实测可跑）。
  **宿主现在会自己备好这一份**：PATH 里的 Node 缺了或过旧时，它复用 dsh 那套托管安装
  （`dsh-node.js` 的 `installManagedNode`，版本 22.22.1）下载到 `<数据目录>\node-runtime`，再用**它**跑
  npm 与 paseo CLI（不经 `.cmd` shim —— shim 会去 PATH 找 node，旧 Node 现场就是这么崩的）。
  下载不通（内网 / 断网）时宿主**直接拒绝安装**并给出口（自己装 Node 22+ 后重试 / 修好网络让安装窗的托管安装跑通 / 改用本机已装的 Paseo），
  不会退回「用旧 Node 先装上再说」。
  **Electron 自带的运行时不算** —— 桥的 `command[0]` 必须是真 Node，缺了它连 provider 都别注册（宿主会回 `real_node_missing`）；
- 命令在 PowerShell 里跑；CLI 在 Windows 上是 `.cmd`，spawn 必须经 shell（宿主已按 `CommandLineToArgvW` 规则自己加引号）。
  宿主里两条实测结论（改代码前先记住）：
  - **npm 不能用 `spawnSync("npm")` / `spawnSync("npm.cmd")`**：Windows 上直接回 `EINVAL`，现场表现成「明明装了 Node，插件却说没 npm」。宿主走 `cmd.exe /d /s /c "npm.cmd --version"`（`probeCommand`），调用 CLI 走 `cmd.exe` + 逐参数转义（`spawnCli`）。
  - **自建后端的 daemon 不能沿用 6767**：官方 daemon 的 listen 来自持久配置 `daemon.listen`（`@getpaseo/server` 的 `resolveListenAddress`，默认 6767），而桌面端那份长期占着 6767 —— 自建 daemon 一起来就 `EADDRINUSE` 退出。宿主安装时把 `daemon.listen` 钉到第一个空闲端口（6768+，只写自建 home），`startDaemon` 撞上 `EADDRINUSE` 会换端口重试一次。`PASEO_LISTEN` 只对**前台 `daemon run`** 那一路有效（官方 `daemon start` 由 supervisor 拉起 worker，环境变量不会传下去 —— 实测：配了 `PASEO_LISTEN` 仍然去 listen 6767 并因占用退出）。**本轮起自建后端走的就是前台 `daemon run`**（见下条），所以 `PASEO_LISTEN` 在自建这条路上是有效的。
  - **不许再用官方 `paseo daemon start` 起自建后端**（本轮共识，2026-10）：它自己 detached 一个 supervisor，在 Windows 上会**留下一只可见的终端窗口**（实测：标题 `Paseo Daemon`，窗口类 `CASCADIA_HOSTING_WINDOW_CLASS`；隔离 home 里复现 = 一次 start 新增 2 只可见窗口），用户误关一下后端就跟着死。现在由宿主自己持有 `paseo daemon run --home <自建 home>`：`windowsHide: true` + `stdio: ["ignore","pipe","pipe"]` + `detached: false` → **零新增可见控制台窗口**（实测），输出逐行进控制台日志，意外退出宿主重启（≤3 次），**随 MTNode 退出而停**。回归：`test/smoke-paseo-daemon-silent.js`（含真窗口测量）。

## 宿主是怎么装的（改这段代码前先读）

真源：`paseo/main-paseo.js`（宿主 / 安装会话）+ `paseo/steps.json`（步骤表）+ `paseo/bridge-info.js`（片段真源）。

**入口分工（本轮口径）**：卡片两颗按钮 = 「安装」（未装）/「重装」（已装）+「控制台」。安装 / 重装开那只**通用安装窗**
（`plugins/main-install.js`），窗里那颗「开始安装 / 重试」调宿主 `paseoRemote:install`，宿主再跑 `installBackend()`；
控制台**不再装任何东西**（那一整块已搬走），它只显示只读状态 + 「打开安装窗」+「启动后端 / 停止后端」。
窗里那个复选框「仍要自建一份（忽略本机已装的 Paseo）」透传 `{forceOwn:true}`。

**安装会话（`installBackend`）按 `paseo/steps.json` 的 8 步走，状态由宿主自己上报**（本插件是纯 JS 驱动，
没有 PowerShell 脚本，所以不走 `pack-steps` 协议；上报走 `plugins/install-step-reporter.js` + `installHost.reportPluginStep`）：

1. **探测**（`probe`）：`verifyOwnInstall()` 看自建那份能不能用 + `reuseCandidate()` 看本机有没有别的 Paseo。
   三条路：`own-ready`（自建那份自检通过 → 继续用它）/ `reuse`（本机已装且用户没勾 forceOwn → `switchToReuse()`，
   后面 node / npm / check / daemon 四步标「跳过」）/ `selfbuild`（真装一份）。**这一步就是原来控制台里那颗
   「改用本机已装的 Paseo」**（回落不再要用户点，探测自己做；想强制自建就在窗里勾复选框）。
2. **真 Node**（`node`）：`ensureNodeRuntime` 拿一份 ≥22.19 的真 Node（托管那份 → PATH → dsh 解析结果），
   缺 / 过旧就自动装托管 Node；装不上**在跑 npm 之前就拒绝**（`paseo.node.missing` / `paseo.node.npm_missing`）。
3. **npm 安装**（`npm`）：`npm i @getpaseo/cli --prefix <INSTALL_DIR>`，用 `<真 Node> <同目录 node_modules\npm\bin\npm-cli.js>` 跑
   （走 `cn-mirrors.js` 的国内源）。npm 子进程一 spawn 就登记进 `plugins/install-cancel.js`（安装窗那颗「取消安装」真杀进程树）。
4. **自检**（`check`）：`verifyOwnInstall` —— `<installDir>\node_modules\@getpaseo\cli\bin\paseo --version` 真能报版本才算装好
   （只看依赖目录在不在会误报：现场 `[install] 完成：code=0 installed=false`）。不过就清掉 `node_modules` + lock 重装一次，
   仍不过按 `paseo.check.dep_missing` / `cli_bin_missing` / `cli_not_runnable` 停在失败步。
   装好顺手 `daemon config set daemon.relay.enabled true --home <自建 home>`（**新 home 默认不开 relay，漏这一步一定出不了码**；
   复用模式**不碰**这一项 —— 那是用户自己那份 Paseo 的配置）。
5. **provider**（`provider`）：`applyProvider({})` 写 `agents.providers.mtnode`；Paseo 里正有会话在跑时回 `need_confirm`，
   这一步标「跳过」并提示用户到控制台点「注册到 Paseo」确认一次（不静默动配置）。
6. **daemon**（`daemon`）：只对自建那份。先 `ensureOwnListen` 把 `daemon.listen` 钉到空闲端口（6767 被桌面端占着时用 6768+，
   只写自建 home），再由宿主**静默**拉起：`ensureOwnDaemon()` → 若发现正跑着的是「旧方式（`daemon start` 起的、带窗口）」
   实例就先优雅停掉再以 `paseo daemon run` 托管（存量迁移，配对密钥不动），否则直接托管起来；
   已在跑且是宿主托管的那份就标 ok，6767~6787 全占 → `paseo.daemon.no_port`。
7. **配对冒烟**（`pair`）：relay 关着 → 标「跳过」并提示去控制台开 relay；开着才 `daemon pair --json` 只读试算一次。
8. **收尾**（`done`）：**不自动开远程接管总开关**（默认关是安全口径），只提示一句。

失败一律停在失败步（步骤标 `fail`、`code` + `params` 走 `steps.json` 的 `messages` 表渲染中英文文案），
`finishPluginInstall({ok:false})` 如实回报，**不再自动转 Agent 兜底**；窗里可点「交给 mtnode 会话修复」（按本 skill 走）。

**卸载**（窗里底栏那颗）：`paseoRemote:uninstallPreview` / `paseoRemote:uninstall`（`plugins/main-install.js` 的
`UNINSTALL_SPECS["paseo-remote"].custom`）。先停自建 daemon，再删**只属于这个插件的数据**：
自建 npm 依赖目录 + `<数据目录>\paseo` 的配置 / 日志 / ui 副本 + 自建 daemon home（`paseo-home`，删了手机要重新扫码）。
守卫 `underDataDir()`：只删落在 MTNode 数据目录里的路径 —— **本机已装的 Paseo Desktop 与 `~/.paseo` 一律不碰**。

其余不变的部分：`resolveCli` 的候选顺序、`spawnCli` 的 Windows 调用姿势（`cmd.exe` + `CommandLineToArgvW` 转义）、
`daemon.listen` 的持久键口径、provider 的「整段替换 + 回退直接改文件 + reload」、出码用自研 `paseo/qr.js` 画（**不要**用官方那串 ANSI 字符画）。

## 常见故障与处置

| 现象 | 根因 | 处置 |
| --- | --- | --- |
| 控制台说「没找到 Paseo 的命令行」 | 本机没装 Paseo，或装在非常规路径 | 让用户到插件卡片点「安装」→ 窗里「开始安装」自建一份；或确认 `%ProgramFiles%\Paseo\resources\bin\paseo.cmd` 在不在。**本机其实装着桌面端**时探测步骤会自己切回复用（`switchToReuse`），不装第二份 |
| 装完仍显示 `installed=false` | 判据与真实可用性不一致：旧版只看 `node_modules\@getpaseo\cli` 目录在不在，而 npm 可能只落了依赖、没生成 `.bin\paseo.cmd`（半成品），或 CLI 根本跑不起来 | 现在以 `paseo --version` 自检为准（安装窗第 4 步），链上已自动清理重装一次；仍不过按 `paseo.check.*` 的原因处置（依赖没落盘 / bin 没生成 / CLI 跑不起来），必要时在安装窗点「重装」 |
| 安装日志里一串 `npm WARN EBADENGINE … required: { node: '>= 20' } current: { node: 'v18.x' }`，之后 CLI 跑不起来 | PATH 里那份 Node 太旧（本轮要 ≥22.19）：npm 只警告不拦，装出来的 CLI 一跑就崩。宿主现在会在**跑 npm 之前**就拦住，并用真 Node 重跑 | 正常路径已自愈（安装窗第 2 步自动备好 Node）。若安装窗停在 `node` 那一步：装 Node 22+ / 修好网络让托管 Node 下得来，再点「重试」；或勾「仍要自建一份」旁边那条路走复用。要人工复核就看 `<数据目录>\paseo\console.log` 里的 `[node]` 与 `[install]` 两行 |
| 自建后端起不来 / 端口被占（日志里 `EADDRINUSE`） | 已经有一份 daemon 占着那个端口（多半是桌面端托管的 6767） | 别用 `PASEO_LISTEN` 去猜（自建这条 `daemon run` 认它，但持久配置才是真源）：写 `paseo daemon config set daemon.listen 127.0.0.1:<空闲端口> --home <自建 home>`，或点控制台「启动后端」让宿主自动换端口重试。**本机已有桌面端时优先走复用**（安装窗的探测步骤会自己切过去）|
| 又冒出一只标题 `Paseo Daemon` 的终端窗口 | 有人把启动方式改回了官方 `paseo daemon start`（它自己 detached supervisor，Windows 上必带窗口），或机器上跑的是旧版本留下的实例 | 启动只走宿主托管：`ensureOwnDaemon()` → `paseo daemon run`（`windowsHide` + stdio 管道）。控制台 daemon 那行会标「旧方式（带窗口）」，宿主开机时会自动迁移；回归跑 `node test/smoke-paseo-daemon-silent.js`（真窗口测量）|
| 关了 MTNode 手机就连不上 | 本轮口径如此：自建 daemon 是 MTNode 的子进程，**随 MTNode 退出而停**（不再有独立窗口里的常驻进程）。复用模式（Paseo Desktop 那份）不受影响 | 与用户确认这是预期；要手机随时连着就别关 MTNode。若用户要的是「MTNode 关了后端仍在」，那是另一条口径，别自己改成 detached —— 会重新引入窗口问题 |
| 控制台标「是 Electron 自带 Node（桥要真 Node）」 | 本机没有 Node ≥22.19（Electron 自带的那个 Paseo 不认） | 到安装窗跑一次安装（第 2 步会自动装托管 Node 进数据目录），装完重开 MTNode 再看。**别改 `dsh-node.js`**：paseo 宿主只是再解析一次它的结果，不写入 |
| `pair` 报 `RELAY_DISABLED`（退出码 1） | 这个 home 的 relay 关着（新装默认关） | `paseo daemon config set daemon.relay.enabled true --home <home>`（runtime-safe，reload 即生效），或点控制台「开启 relay」 |
| Paseo 里看不到「MTNode 会话」 | provider 没写进去 / 没 reload / 自定义 provider 缺 `label` | 核对 `agents.providers.mtnode` 三个必需项（`extends:"acp"` + `label` + `command`），跑 `paseo daemon reload`；`command[0]` 必须是**真 Node**，不能是 Electron 可执行文件 |
| 手机上连不上 / 扫码没反应 | relay 关着、旧码对应的 daemon 换了、或 MTNode 侧总开关没开 | 先看控制台「正在接管 N 条」是否为 0；再看本机服务端（MCP）开关是否打开；端口**每次启动都会变**，桥脚本自己从数据目录读，不要手填地址 |
| 手机答了审批卡但电脑上还挂着 | 那张卡已失效（发起轮结束 / 已被别处答过） | 正常语义：桥上会明确报 stale，让模型重发一次请求 |
| 想作废已经发出去的配对码 | 官方**没有**撤销接口（offer 无有效期、无 nonce） | 只能重置 daemon 密钥：删 `<home>\daemon-keypair.json` 后重启 daemon（插件控制台的「重置配对凭据」就是它，密钥会先备份到 `<数据目录>\keypair-backup\`）。**这会作废所有已配对设备**，不要静默替用户做 |

## 边界（修复时也不许越线）

- 只碰会话层与 Paseo 自己的配置：**不画布、不节点、不动 MTNode 的其它设置**（唯一例外是用户亲手点的「一键开启本机服务端」）。
- 不改用户的 `relay` 端点 / TLS 配置，不自建 relay（官方 relay `relay.paseo.sh:443` 免费、可选自托管，但那是另一件事）。
- 不把会话族（`mtnode_session_*`）列进 MCP 的 `tools/list`：它只给桥内部用。
- 用户数据只落 MTNode 数据目录（`%APPDATA%\pipeline-console\paseo` 与插件根目录下的 `paseo` 安装目录），
  绝不写进应用目录；**本机已装的 Paseo Desktop 与 `~/.paseo` 一律不碰**（卸载也不碰）。

## 自我修复（Agent 按这条走）

1. **先读日志**：`<数据目录>\paseo\console.log`（最近 64KB；老机器上也可能还在 `<数据目录>\app-plugins\paseo-remote\console.log`），
   按前缀定位失败那一步（`[install]` / `[daemon]` / `[pair]` / `[provider]`）；安装窗左栏那个 ✕ 是第几步，就是它。
2. **再跑三只只读命令**（顺序固定，缺哪条补哪条，不要瞎猜）：
   - `"<CLI>" --version`（报不出编号又看得到 `EBADENGINE` / Node 版本线索 → 先按「Node 太旧」那条处置，别急着重装）
   - `"<CLI>" daemon status --json`
   - `"<CLI>" daemon pair --json`
   另外看一眼宿主状态里的「安装用 Node」行（`nodeRuntime`）：它不是 ≥22.19 就说明 npm 与 CLI 都不该由它跑。
3. **按上表处置**：relay 关 → 开它；provider 缺/形态不对 → 用官方 CLI 重写；端口冲突 → 给自建 home 写 `daemon.listen`
   （或让用户在安装窗里改用本机已装的那份）；CLI 缺失 → 到安装窗点「重装」；报 `check` 那步不过 → 安装窗点「重装」
   （宿主会先清 `node_modules` 再用真 Node 装回）。
4. **收尾复核**：上面「目标（装好的判据）」六条逐条验一遍，并把结论写进回复（哪条命令、什么输出）。
   修完回到插件控制台点「刷新」（状态区是只读的，装 / 重装都在安装窗里），再由宿主 `restart()` 收尾。
5. **不许**为了「看起来修好了」而伪造状态：验不过就如实说卡在哪一条。

## 想复现「一台没装 Paseo 的新机器」

不用装虚拟机：宿主支持把「去哪找 Paseo」注入（`MTNODE_PASEO_DIRS` = path.delimiter 分隔的目录列表；`MTNODE_PASEO_USERPROFILE` 换掉 `~` 落点；`MTNODE_PASEO_PORT` 指定自建端口）。仓库里有两只现成的：

```bash
node test/smoke-paseo-install-isolation.js   # 离线：空机器 / 半成品 / 回落 / 自检判据 / 旧 Node 拒绝安装（不联网）
node test/smoke-paseo-daemon-silent.js       # 后台静默：静态口径 + 真起一次后端数可见控制台窗口（要一份真装好的自建后端；没有就 SKIP 真测量）
node test/smoke-paseo-install-real.mjs       # 真装 @getpaseo/cli + 真起 daemon（要网络，收尾自删隔离目录）
```

`MTNODE_PASEO_SMOKE_INSTALL_DIR` 可以指定静默冒烟用哪份自建 CLI（默认自己找 `E:\mtnode-plugins\paseo` 一类落点）。

「旧 Node + 下载不通」那条现场怎么离线复现：`MTNODE_NODE_BIN` 指一份假 node（自报 18.x）+ `MTNODE_NO_NODE_DOWNLOAD=1`
（dsh-node 的测试钩子，禁掉下载）—— 用例 `[4.6]/[4.7]` 就是这么演的：断言预检拦住、**不跑 npm**、目录里不留半成品。

真装那只走**宿主真身**（假 electron 加载 `paseo/main-paseo.js` 直呼 `installBackend` / `startDaemon`），
所以它验的就是用户点那颗按钮的同一条路；结论要引它的输出，别用「应该可以」代替。
