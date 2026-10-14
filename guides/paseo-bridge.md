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

## 2. 装（三步）

1. **电脑上装 Paseo**：按官方文档装 Desktop 或 CLI（`npx @getpaseo/cli`），让它管起本机 daemon。
2. **把 provider 片段写进 Paseo 配置**：
   打开 MTNode →「扩展能力管理 → 服务端」页最下方的 **Paseo 桥** 那一块，
   点「复制 provider 片段」，把它合并进 `~/.paseo/config.json` 的 `agents.providers`，
   然后跑 `paseo reload`。片段长这样（路径会按你的实际情况填好）：

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

   > `command` 必须是**真 Node**（Electron 自带的那个不算）。面板给的就是当前应用在用的那个 Node。
3. **手机配对**：在 Paseo 里「Pairs a device / 配对设备」扫码（relay），
   或在手机上「Add host → Direct connection」填 Tailscale IP + 端口 6767。
   然后新建 agent 时选 **MTNode 会话**，就能看到会话清单了。

## 3. 怎么用

- 新建会话时可以在模式里选「**新建 MTNode 会话**」或**接着某条已有会话**（清单就是左栏那些）。
  模型与供应商在 Paseo 里选（桥把 `session/models` 那份清单交给它），本桥这一版**不做会话中途
  换模型**：要换就在新建时选，或在电脑上改那条会话的模型。
- 发消息、插话、终止：与电脑上完全同一套语义 ——
  - 会话正在跑时，手机发的消息进**这条会话的发送队列**（不打断正在跑的那一轮）；
  - 「插话」优先塞进正在跑的那一轮，塞不进去自动回落成排队消息，一句话都不丢；
  - 「终止」= 电脑上那个 ■，连排队消息一起清掉。
- **审批**：会话里要写工作区外的文件、要跑命令、要改画布时，手机上会弹卡：
  允许一次 / 本会话后续都放行 / 拒绝。电脑上同时也会显示这张卡 —— **谁先答算谁的**。
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

## 5. 排障

面板上先点「**桥自检**」——它就是真跑一次：

```bash
"<真 Node>" "<安装目录>\resources\paseo\acp-bridge.mjs" --check
```

它会打印：桥脚本路径 / Node 版本 / 数据目录候选 / **探活结果**。逐条对照：

| 现象 | 原因与处置 |
| --- | --- |
| 桥自检说「找不到 MTNode 的本地服务端」 | MTNode 没开，或「服务端」总开关被关了；也可能数据目录不一致 —— 自检会把**逐条候选**的探活结果列出来。 |
| 桥自检说「探活失败 ECONNREFUSED」 | 端口是上次启动的旧端口（**端口每次启动都会变**）：重开 Paseo 的 provider / 重跑 daemon 即可。 |
| Paseo 里看不到 MTNode 会话 provider | `~/.paseo/config.json` 没写对或没跑 `paseo reload`；`command` 第一条要是真 Node，不能是 Electron 可执行文件。 |
| Paseo 报「版本过低」 | 本桥声明了最低兼容版本（面板上「协议 / 最低 Paseo 版本」可见）。升级 Paseo；确实要用未验证的组合可设环境变量 `MTNODE_PASEO_MIN_VERSION` 放宽。 |
| 手机上发消息没反应 | 看面板上「正在远程接管 N 条会话」是否为 0（为 0 说明没有观察者：桥没连上）；再看 MTNode 主窗口是否还开着 —— 会话的执行在渲染层，窗口关了没人执行。 |
| 手机上答了审批但电脑上还挂着卡 | 那张卡已失效（发起轮结束 / 已被别处答过）：手机上会明确报 stale，让模型重发一次请求。 |

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
| `paseo/acp-bridge.mjs` | 桥本体：ACP（stdio JSON-RPC）↔ MTNode 本机 HTTP；`--config` / `--check` |
| `paseo/bridge-info.js` | 落点与 provider 配置片段的**单一真源**（桥与面板共用一份纯函数） |
| `session-bridge.js` | 主进程侧的会话回路：文件层读会话 + 按会话分发实时事件给观察者 |
| `session-tools.js` | 会话族（`mtnode_session_*`，10 个）的参数表（手写，不进生成契约） |
| `renderer/app-session-bridge.js` | 渲染层执行那一半：发消息 / 插话 / 终止 / 审批 / 模型清单 + 事件旁路 |
| `renderer/mcp-bridge.js` | 帧分派：会话族在这一支里（**不**打开「第三方已授权」开关） |
| `mcp-server.js` | 会话族的协议面：`POST /ctl` 的 `session/*`、`GET /session/stream`（SSE） |
| `test/smoke-session-bridge.js` | 冒烟：主进程回路 + 协议面 + SSE + 渲染层接线 + 打包白名单 |
| `test/smoke-paseo-bridge.mjs` | 冒烟：真子进程跑桥，假 MTNode + 假 ACP 客户端走完一整轮（含审批与取消） |

## 8. 参考

- Paseo 文档：[连接方式（relay / Tailscale / SSH）](https://paseo.sh/docs/connectivity)、
  [自定义 provider（ACP）](https://paseo.sh/docs/custom-providers)、
  [安全模型](https://paseo.sh/docs/security)
- ACP 协议：[v1 总览](https://agentclientprotocol.com/protocol/v1/overview)、
  [schema（session/new · session/prompt · session/update · session/request_permission）](https://agentclientprotocol.com/protocol/v1/schema)
