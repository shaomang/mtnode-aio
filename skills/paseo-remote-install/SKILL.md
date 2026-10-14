---
name: paseo-remote-install
title: Paseo 手机接管插件安装与修复
description: 把「Paseo 手机接管」插件的后端装好或修好：优先复用本机已装的 Paseo（桌面端自带 resources\bin\paseo.cmd，或 PATH 里的 paseo），没有才在用户选定目录 npm 装 @getpaseo/cli 并起独立 daemon（独立 home、避开 6767 冲突）；开 relay、用官方 CLI 把 MTNode 会话注册成 ACP provider、在控制台出配对二维码。含自我修复指引（RELAY_DISABLED / CLI 找不到 / daemon 起不来 / provider 没生效 / 手机连不上）。
---

# Paseo 手机接管 — 安装 / 修复

当用户或 MTNode 插件要求**安装**或**自我修复**「Paseo 手机接管」（应用插件 `paseo-remote`，kind `paseo`）时使用本 skill。

插件调用时给的现场：

- **当前工作区就是 `INSTALL_DIR`**（可写）：自建后端时它是 `npm install --prefix` 的目标目录（`node_modules/.bin/paseo.cmd` 就在里面）；复用模式时它是 `%APPDATA%\pipeline-console\app-plugins\paseo-remote`（宿主数据目录）。
- **`CONSOLE_LOG`（插件控制台最近日志）**：`<数据目录>\app-plugins\paseo-remote\console.log`——`[install]` / `[pair]` / `[provider]` / `[daemon]` / `[reset]` 这些前缀就是宿主的每一步动作，**先读它定位，再动手**。
- **Paseo 的 home**：复用模式 `%USERPROFILE%\.paseo`；自建模式 `<数据目录>\app-plugins\paseo-remote\paseo-home`。`config.json` / `daemon-keypair.json` / `server-id` / `paseo.pid` / `daemon.log` 都在里面。

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
  下载不通（内网 / 断网）时宿主**直接拒绝安装**并给三条出口（自己装 Node 22+ / 点「等真 Node 就位」/ 改用本机已装的 Paseo），
  不会退回「用旧 Node 先装上再说」。
  **Electron 自带的运行时不算** —— 桥的 `command[0]` 必须是真 Node，缺了它连 provider 都别注册（宿主会回 `real_node_missing`）；
- 命令在 PowerShell 里跑；CLI 在 Windows 上是 `.cmd`，spawn 必须经 shell（宿主已按 `CommandLineToArgvW` 规则自己加引号）。
  宿主里两条实测结论（改代码前先记住）：
  - **npm 不能用 `spawnSync("npm")` / `spawnSync("npm.cmd")`**：Windows 上直接回 `EINVAL`，现场表现成「明明装了 Node，插件却说没 npm」。宿主走 `cmd.exe /d /s /c "npm.cmd --version"`（`probeCommand`），调用 CLI 走 `cmd.exe` + 逐参数转义（`spawnCli`）。
  - **自建后端的 daemon 不能沿用 6767**：官方 daemon 的 listen 来自持久配置 `daemon.listen`（`@getpaseo/server` 的 `resolveListenAddress`，默认 6767），而桌面端那份长期占着 6767 —— 自建 daemon 一起来就 `EADDRINUSE` 退出。宿主安装时把 `daemon.listen` 钉到第一个空闲端口（6768+，只写自建 home），`startDaemon` 撞上 `EADDRINUSE` 会换端口重试一次。`PASEO_LISTEN` 只对**前台 `daemon run`** 那一路有效（`daemon start` 由 supervisor 拉起 worker，环境变量不会传下去 —— 实测：配了 `PASEO_LISTEN` 仍然去 listen 6767 并因占用退出）。

## 宿主是怎么装的（改这段代码前先读）

真源：`paseo/main-paseo.js`（宿主）与 `paseo/bridge-info.js`（片段真源）。

1. **检测**（`resolveCli`）：自建模式先看 `<installDir>\node_modules\.bin\paseo.cmd`，**不可用时回落到**桌面端 / PATH 那份（过去 own 模式不看这两处，选错目录就是死胡同：永远 `cli_missing` 且无路可退）；复用模式依次看
   `%ProgramFiles%\Paseo\resources\bin\paseo.cmd`、`%ProgramFiles(x86)%\Paseo\…`、`%LOCALAPPDATA%\Programs\Paseo\…`、
   最后 `where paseo`。找不到就报 `cli_missing`（UI 提示「装官方桌面端或在本窗装后端」）。
2. **自建安装**（`installBackend`）：先做 **Node 运行时预检**（`ensureNodeRuntime` / `pickNodeRuntime`）——
   拿一份 ≥ 22.19 的真 Node（托管那份 → PATH → dsh 解析结果），缺 / 过旧就自动装托管 Node（见上），
   装不上就**在跑 npm 之前拒绝**（`reason: node_too_old` / `node_install_failed`）。
   预检过了才 `npm i @getpaseo/cli --prefix <installDir>`，且用 `<真 Node> <同目录 node_modules\npm\bin\npm-cli.js>`
   跑（走 `cn-mirrors.js` 的国内源）。
   然后**自检**（`verifyOwnInstall`）：<installDir>\node_modules\@getpaseo\cli\bin\paseo --version 真能报版本才算装好
   （拿不到真 Node 时才退回 `.bin\paseo.cmd`）—— 只看
   `node_modules\@getpaseo\cli` 目录在不在会误报（现场：`[install] 完成：code=0 installed=false`）。自检不过会
   自动清掉 `node_modules` + lock 重装一次，仍不过按 `dep_missing` / `cli_bin_missing` / `cli_not_runnable` /
   `node_too_old` 给原因（`node_too_old` = 这份 CLI 是被旧 Node 装出来的，控制台给「清干净重装」那颗按钮，点了才删）。
   装好顺手（顺序固定，都只写自建 home）：
   - `daemon config set daemon.relay.enabled true`（**新 home 默认不开 relay，漏这一步一定出不了码**）；
   - `daemon config set daemon.listen 127.0.0.1:<空闲端口>`（6767 被占时；用户已配过 `daemon.listen` 则一字不改）。
3. **起后端**：`paseo daemon start --home <ownHome>`（后台常驻、supervisor 托管；`daemon run` 是前台，别用它拉起常驻服务）。撞 `EADDRINUSE` 时宿主会换端口重试一次。
4. **注册 provider**：`paseo daemon config set agents.providers.mtnode '<json>'`（官方负责合并进 `config.json` 并自动 reload）。
   写入前宿主会先 `waitRealNode()`（等真 Node，最多 20 秒）与跑一次 `paseo agent ls --json`（有会话在跑就让界面弹确认）。CLI 失败时回退「直接改 `config.json` + `daemon reload`」，并先把原文件备份到 `<数据目录>\config-backup\`。
5. **出码**：`paseo daemon pair --json` 取 `url`，二维码由前端 `paseo/qr.js`（自研零依赖）自己画 —— **不要**把官方 `qr` 字段（带 ANSI 转义的终端字符画）塞进界面。

## 常见故障与处置

| 现象 | 根因 | 处置 |
| --- | --- | --- |
| 控制台说「没找到 Paseo 的命令行」 | 本机没装 Paseo，或装在非常规路径 | 让用户点「安装后端」自建一份；或确认 `%ProgramFiles%\Paseo\resources\bin\paseo.cmd` 在不在。**本机其实装着桌面端**时控制台会给「改用本机已装的 Paseo」一键切回复用（`switchToReuse`，只改用户亲手点的这一下） |
| 装完仍显示 `installed=false` | 判据与真实可用性不一致：旧版只看 `node_modules\@getpaseo\cli` 目录在不在，而 npm 可能只落了依赖、没生成 `.bin\paseo.cmd`（半成品），或 CLI 根本跑不起来 | 现在以 `paseo --version` 自检为准，自检不过宿主已自动清理重装一次；仍不过按控制台「安装自检」那行的原因处置（`dep_missing` / `cli_bin_missing` / `cli_not_runnable` / `node_too_old`），必要时「换目录重装」 |
| 安装日志里一串 `npm WARN EBADENGINE … required: { node: '>= 20' } current: { node: 'v18.x' }`，之后 CLI 跑不起来 | PATH 里那份 Node 太旧（本轮要 ≥22.19）：npm 只警告不拦，装出来的 CLI 一跑就崩。宿主现在会在**跑 npm 之前**就拦住，并用真 Node 重跑 | 正常路径已自愈（宿主自动备好 Node）。若仍报 `node_too_old`：点控制台「清干净重装」——它会删掉这个目录的 `node_modules` + lock 再装（**点了才删**）。要人工复核就看 `<数据目录>\app-plugins\paseo-remote\console.log` 里的 `[node]` 与 `[install]` 两行 |
| `daemon start` 起不来 / 端口被占 | 已经有一份 daemon 占着 6767（多半是桌面端托管的那份） | 别用 `PASEO_LISTEN`（只对前台 `daemon run` 有效）：写持久配置 `paseo daemon config set daemon.listen 127.0.0.1:<空闲端口> --home <自建 home>`，或点控制台「启动后端」让宿主自动换端口重试。**本机已有桌面端时优先「改用本机已装的 Paseo」**，别硬自建 |
| 控制台标「是 Electron 自带 Node（桥要真 Node）」 | 本机没有 Node ≥22.19（Electron 自带的那个 Paseo 不认） | 装 Node 后重开 MTNode，或点「等真 Node 就位」（它会先复用 dsh 的托管安装把 Node 装进数据目录，再等桥那份就位；`MTNODE_PASEO_PORT` 只是测试钩子）。**别改 `dsh-node.js`**：paseo 宿主只是再解析一次它的结果，不写入 |
| `pair` 报 `RELAY_DISABLED`（退出码 1） | 这个 home 的 relay 关着（新装默认关） | `paseo daemon config set daemon.relay.enabled true --home <home>`（runtime-safe，reload 即生效），或点控制台「开启 relay」 |
| Paseo 里看不到「MTNode 会话」 | provider 没写进去 / 没 reload / 自定义 provider 缺 `label` | 核对 `agents.providers.mtnode` 三个必需项（`extends:"acp"` + `label` + `command`），跑 `paseo daemon reload`；`command[0]` 必须是**真 Node**，不能是 Electron 可执行文件 |
| 手机上连不上 / 扫码没反应 | relay 关着、旧码对应的 daemon 换了、或 MTNode 侧总开关没开 | 先看控制台「正在接管 N 条」是否为 0；再看本机服务端（MCP）开关是否打开；端口**每次启动都会变**，桥脚本自己从数据目录读，不要手填地址 |
| 手机答了审批卡但电脑上还挂着 | 那张卡已失效（发起轮结束 / 已被别处答过） | 正常语义：桥上会明确报 stale，让模型重发一次请求 |
| 想作废已经发出去的配对码 | 官方**没有**撤销接口（offer 无有效期、无 nonce） | 只能重置 daemon 密钥：删 `<home>\daemon-keypair.json` 后重启 daemon（插件控制台的「重置配对凭据」就是它，密钥会先备份到 `<数据目录>\keypair-backup\`）。**这会作废所有已配对设备**，不要静默替用户做 |

## 边界（修复时也不许越线）

- 只碰会话层与 Paseo 自己的配置：**不画布、不节点、不动 MTNode 的其它设置**（唯一例外是用户亲手点的「一键开启本机服务端」）。
- 不改用户的 `relay` 端点 / TLS 配置，不自建 relay（官方 relay `relay.paseo.sh:443` 免费、可选自托管，但那是另一件事）。
- 不把会话族（`mtnode_session_*`）列进 MCP 的 `tools/list`：它只给桥内部用。
- 用户数据只落 `%APPDATA%\pipeline-console\app-plugins\paseo-remote`，绝不写进应用目录。

## 自我修复（Agent 按这条走）

1. **先读日志**：`<数据目录>\app-plugins\paseo-remote\console.log`（最近 64KB），按前缀定位失败那一步（`[install]` / `[daemon]` / `[pair]` / `[provider]`）。
2. **再跑三只只读命令**（顺序固定，缺哪条补哪条，不要瞎猜）：
   - `"<CLI>" --version`（报不出编号又看得到 `EBADENGINE` / Node 版本线索 → 先按「Node 太旧」那条处置，别急着重装）
   - `"<CLI>" daemon status --json`
   - `"<CLI>" daemon pair --json`
   另外看一眼宿主状态里的「安装用 Node」行（`nodeRuntime`）：它不是 ≥22.19 就说明 npm 与 CLI 都不该由它跑。
3. **按上表处置**：relay 关 → 开它；provider 缺/形态不对 → 用官方 CLI 重写；端口冲突 → 给自建 home 写 `daemon.listen`（或让用户「改用本机已装的 Paseo」）；CLI 缺失 → 走自建安装；报 `node_too_old` → 点「清干净重装」（宿主会先用真 Node 重装依赖）。
4. **收尾复核**：上面「目标（装好的判据）」六条逐条验一遍，并把结论写进回复（哪条命令、什么输出）。修完回到插件控制台点「刷新」，再由宿主 `restart()` 收尾。
5. **不许**为了「看起来修好了」而伪造状态：验不过就如实说卡在哪一条。

## 想复现「一台没装 Paseo 的新机器」

不用装虚拟机：宿主支持把「去哪找 Paseo」注入（`MTNODE_PASEO_DIRS` = path.delimiter 分隔的目录列表；`MTNODE_PASEO_USERPROFILE` 换掉 `~` 落点；`MTNODE_PASEO_PORT` 指定自建端口）。仓库里有两只现成的：

```bash
node test/smoke-paseo-install-isolation.js   # 离线：空机器 / 半成品 / 回落 / 自检判据 / 旧 Node 拒绝安装（不联网）
node test/smoke-paseo-install-real.mjs       # 真装 @getpaseo/cli + 真起 daemon（要网络，收尾自删隔离目录）
```

「旧 Node + 下载不通」那条现场怎么离线复现：`MTNODE_NODE_BIN` 指一份假 node（自报 18.x）+ `MTNODE_NO_NODE_DOWNLOAD=1`
（dsh-node 的测试钩子，禁掉下载）—— 用例 `[4.6]/[4.7]` 就是这么演的：断言预检拦住、**不跑 npm**、目录里不留半成品。

真装那只走**宿主真身**（假 electron 加载 `paseo/main-paseo.js` 直呼 `installBackend` / `startDaemon`），
所以它验的就是用户点那颗按钮的同一条路；结论要引它的输出，别用「应该可以」代替。
