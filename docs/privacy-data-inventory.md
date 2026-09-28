# MTNode 隐私数据清单（代码核对版）

> 用途：本文件是 `web/privacy/index.html`（中文）与 `web/privacy/en/index.html`（英文）两页隐私政策正文的**唯一事实依据**。
> 政策里出现的每一条「收集 / 不收集 / 传输 / 保留」断言，都必须能在下面某张表里找到对应行与代码证据；找不到证据的句子一律删掉，不靠推测写作。
> 本文件只做事实登记，不面向终端用户发布；措辞请另行改写进政策页。
> 核对时间：2026-09-04。核对方式：项目源码只读通读 + 云服务器（`mt-agent.com` / 118.190.216.22）只读探测（`nginx -T`、logrotate、systemd、`ss -lntp`、data 目录结构）。
> 版本号不参与本文件（以 `version` 文件为唯一真源）。

## 0. 结论速览

| 问题 | 答案 | 依据 |
| --- | --- | --- |
| 是否内置遥测 / 埋点 / 广告 SDK | 否。全仓无遥测上报代码，dsh 的 OTLP 遥测导出簇在安装包内已被摘除且未挂载 | §5.1、§5.2 |
| 是否使用设备唯一标识 / 指纹 | 否（本机无 `hostname` / 网卡 MAC / `MachineGuid` 等读取） | §5.3 |
| 是否强制注册账号 | 否。仅「创意工坊」上传/点赞与「讨论区」发帖需要账号 | §3.1、§3.4 |
| 关键个人数据出境到哪 | ① 用户在设置里自行配置的 AI 服务商 API（含 DeepSeek 官方）；② `mt-agent.com`（更新 / 插件目录 / 扩展目录 / 创意工坊 / 讨论区 / 桌宠 / 本地后端下载） | §2、§3 |
| 是否用 HTTPS | 云端站点当前只监听 80（无 443、无证书）；对第三方服务商则由用户配置的地址决定（默认 `https://api.deepseek.com`） | §3.6、§2.1 |

---

## 1. 本机存储（不离开这台电脑）

数据根目录：`%APPDATA%\pipeline-console\`（Electron `userData`）→ 应用数据在其下的 `pipeline-console\` 子目录。
证据：`main.js:122`（`APP_DATA_ROOT`）、`main.js:134-137`（`app.setPath("userData", …)`，可被 `MTNODE_DATA_DIR` 覆盖）、`main.js:140`（`defaultDataDir()` 再嵌一层）。
用户可在设置里改「配置数据目录」，指针文件 `data-root.json` 留在原处（`main.js:123-132`）。

| # | 内容 | 位置 | 触发时机 | 数据类别 | 证据 |
| --- | --- | --- | --- | --- | --- |
| 1.1 | 画布 / 工作流 JSON | `save/<id>.json` | 每次自动保存（用户编辑即写） | 用户自录内容：节点提示词、输入文本、参数、@引用 | `main.js:226` |
| 1.2 | 画布随附素材（拖入的图片等原文件副本） | `assets/<工作流id>/` | 添加图像节点 / 导入画布时 | 用户本机文件的**内容本体**（图像字节） | `main.js:228`、`main.js:662-663` |
| 1.3 | 画布定时快照 | `save-backups/<id>/<id>-<时间戳>.json` | 每 5 分钟一次，仅源文件有变更时复制；每条工作流留最近 72 份（≈6 小时） | 同 1.1 | `main.js:233-282` |
| 1.4 | 删除画布的回收站 | `trash/<时间戳>__<id>/`（`save/` + `assets/` 整体搬入） | 用户删除工作流时 | 同 1.1 + 1.2 | `main.js:230-231` |
| 1.5 | 应用配置 `config.json`（含服务商列表、**API Key 明文**、在线源列表、语言/主题等） | `config.json` | 保存设置、登录创意工坊、插件写入托管服务商时 | 凭据 + 用户配置；文件可达数十 MB | `main.js:158`、`main.js:476`、`main.js:506`、`main.js:532`、`config-providers.js:97`、`renderer/app-store.js:38-42`、`renderer/app-boot.js:308` |
| 1.6 | 配置自动备份（含 API Key 的历史副本，保留最近 30 份） | `config-backups/config-<时间戳>.json` | 每次服务商配置变更前 | 同 1.5 | `config-providers.js:21-39`、`config-providers.js:69` |
| 1.7 | 事实库（数据库超级节点 / SQLite + FTS5） | 数据目录下数据库文件（`db-store.js`） | 用户在画布建表 / 写记录时 | 用户录入的事实条目与来源文件引用 | `db-store.js`（模块「数据 · 配置 · 持久化」） |
| 1.8 | Agent 会话记录（对话正文、工具调用与结果） | `dsh-home/sessions/`（JSONL 持久化） | 每次智能节点 / 助手会话运行 | 用户输入 + 模型输出 + **工具读到的本机文件内容片段** | `dsh/gateway/cordis.yml:111-113`（`dsh-session-persistence-jsonl`，`root: <DSH_HOME>/sessions`）、`dsh/main-dsh.js:52` |
| 1.9 | Agent 文件回滚日志（被改文件的改前副本） | `dsh-home/rollback/<sessionId>/` | Agent 改写本机文件前 | 被改文件的历史内容 | `dsh/gateway/gateway.mjs:684-688` |
| 1.10 | 智能任务携带图像的附件仓库（内容寻址） | `dsh-home/attachments/v1/objects/…` | 会话带图运行时 | 图像内容 | `dsh/gateway/gateway.mjs:760-782` |
| 1.11 | 匿名标识文件 `.anonymous-user-id`（随机 UUID v4，一行裸值） | `dsh-home/.anonymous-user-id` | 首次模型请求前创建并长期保留 | **伪匿名标识**：仅随机 UUID，不含姓名/硬件号；用途见 §2.2 | `@deepseek-ai/dsh-anonymous-user-id`（README：per-harness-home 随机 UUID，持久化为该裸行）、实测本机文件存在（37 字节） |
| 1.12 | 引擎设置 `dsh-home/settings.yaml` | 同左 | 每次运行前由网关重写 | 服务商路由名、`baseURL`、`apiKeyEnv`（**只写环境变量名，不写密钥值**）、思考档、权限预设 | `dsh/gateway/gateway.mjs:1660-1690`、`1686`（`apiKeyEnv: MTNODE_KEY_n`）、`1666`（密钥经进程环境变量注入） |
| 1.13 | 应用插件与其数据 | `app-plugins/<插件id>/`（含 `installed.json`、`data.json`）、目录缓存 `app-plugins/catalog.json` | 安装/运行/刷新插件列表时 | 插件自带内容 + 插件运行数据（由各插件决定） | `plugins/main-app-plugins.js:37-57`、`plugins/main-app-plugins.js:40-41` |
| 1.14 | 讨论区本地缓存 | `forum/messages.json`、`forum/img/<图片id>.jpg` | 打开讨论区窗口、拉取/浏览消息时 | 会话内消息文本与已缓存图片 | `main.js:3203-3212` |
| 1.15 | 创意工坊预览/模板本地缓存 | `store-cache/` | 浏览商店时 | 服务器返回的预览图与模板包 | `main.js:2130` |
| 1.16 | 日志与崩溃报告（**只写本机，永不自动上传**） | `error.log`、`logs/error.log`（滚动 4MB）、`logs/crash-reports/MTNode-crash-*.txt`（留最近 30 份）、`dsh.log` | 任何异常/渲染错误时追加 | 异常栈 + 环境块：版本、Electron/Chrome/Node 版本、平台与 `os.release()`、架构、界面语言、`packaged`、`execPath`、`dataDir`、`cwd`、`pid` | `crash-report.js:29-59`、`crash-report.js:110-130`、`crash-report.js:159-187`、`crash-report.js:132-153` |
| 1.17 | 诊断包（**只在用户主动点「导出诊断日志」并经另存为对话框选路径后**写出，默认落桌面） | 用户选择的位置（`MTNode-diagnostic-*.txt`） | 用户手动导出 | 1.16 的环境块 + 日志尾部；导出头两行显式声明 `note: API keys and secrets are NOT included.` | `crash-report.js:224-294`（`buildExportBundle`、`exportDiagnosticBundle`） |
| 1.18 | Electron/Chromium 运行环境自带存储（`Cache`、`Code Cache`、`GPUCache`、`Local Storage`、`Session Storage`、`IndexedDB`、`Network`、`Preferences`、`Local State`、`DIPS`、`SharedDictionary`、`.updaterId`） | `%APPDATA%\pipeline-console\` 根 | Electron 自行维护 | 渲染缓存与网络状态文件；`.updaterId` 为 electron-updater 的本机随机更新标识（项目代码从不读取、不参与任何请求） | 实测本机目录清单；全仓 `updaterId` 零引用（含 `updater.js` 未使用） |
| 1.19 | 本地后端的模型与依赖（Music3 / H3 / TTS / llama / SenseNova / Remotion） | `music3/`、`h3/`、`llama/`、`tts/`、`sensenova/`、`remotion/`、`zen/`、`vllm/` 等数据子目录 + 用户选择的安装目录 | 用户主动点「安装」时下载 | 第三方模型权重、Python/Node 依赖；**不含用户数据** | `build.json:75-185`（extraResources）、`music3-pack/README.md:94`、`h3-pack/README.md:36-37`、`llama-pack/README.md:26`、`tts-pack/README.md:26`、`sensenova-pack/README.md` |

---

## 2. 出网到第三方（目的地不是 `mt-agent.com`）

> 共性：所有出网都由**用户动作**触发（运行节点、发起对话、安装后端、浏览在线源、点下载）。渲染层 CSP 为 `connect-src 'self'`，页面自身无法直连外网，请求一律由主进程或网关子进程发出（`renderer/index.html:5`）。所有 HTML 均无外链资源：全仓 `*.html` 中 `src=/href="http…"` 零匹配，界面不加载任何第三方 CDN、字体或统计脚本。

### 2.1 AI 服务商 API（用户自行配置、自行计费）

| # | 数据 | 目的地 | 触发时机 | 证据 |
| --- | --- | --- | --- | --- |
| 2.1.1 | 提示词、系统/人设提示、被 @引用进请求的节点正文、用户上传并被引用的图像内容 | 用户在「设置 · 服务商」里配置的任意 OpenAI 兼容端点；内置默认 `https://api.deepseek.com`；粘贴导入样例含 `https://api.siliconflow.cn/v1` | 运行 `proc_text` / `proc_image` / 智能节点 / 助手对话的每一次请求 | `renderer/app-boot.js:77`、`renderer/app-settings.js:927`、`renderer/app-settings.js:1276` |
| 2.1.2 | Agent 工具读到的本机文件内容（`read` / `grep` / 命令输出等），作为工具结果回流进下一轮模型请求 | 同上 | Agent 会话中被授权读取文件的每一步 | `dsh/gateway/cordis.yml`（`tool-fs` / `tool-fs-search` / `tool-pwsh` 挂载）、`dsh/gateway/gateway.mjs:1443-1457`（`tool/result` 回流） |
| 2.1.3 | 请求头 `User-Agent: deepseek-harness/<ver> (+https://github.com/deepseek-ai/deepseek-harness)`（应用归因，框架强制发送、不可关闭，不含个人信息） | 所有走 dsh 网关的模型请求 | 每次模型请求 | `@deepseek-ai/dsh-llm` `lib/index.js:599-623`（`APP_IDENTITY` / `attributionHeaders`） |
| 2.1.4 | **`x-deepseek-harness-user-id`：本机随机匿名 UUID（见 1.11）**，带会话时另发 `x-deepseek-harness-session-id`；二者只进 HTTP 头，不进请求正文、模型不可见 | DeepSeek 官方路由（`dsh-llm-deepseek`）及其解析到的 `baseURL` | 每次 DeepSeek 官方对话请求 | `@deepseek-ai/dsh-llm-deepseek/lib/index.js:726-734`；路由归属见 `dsh/gateway/gateway.mjs:1610`（「mtnode 的 DeepSeek 走 llm-deepseek 官方路由」） |
| 2.1.5 | 联网搜索的查询词 | `api.deepseek.com`（搜索提供方固定为 `deepseek-official`，只认 DeepSeek 官方 Key；`web_fetch` 已关） | 助手 / Agent 主动调用 `web_search` | `dsh/gateway/cordis.yml:350-364`（`searchProvider: deepseek-official`、`apiKeyEnv: DEEPSEEK_API_KEY`、`fetch: false`）、`dsh/gateway/gateway.mjs:889-894` |
| 2.1.6 | 用户自行添加的 MCP 服务器按其配置连接（stdio 为本机进程；remote 为用户填写的任意 URL），工具调用的入参出参会发往该地址 | 用户配置的目标 | 该 MCP 被启用并调用时 | `dsh/gateway/gateway.mjs:2298-2345`（`mcpAdd`：`transport` / `command` / `url`） |

### 2.2 安装依赖与模型的下发方

| # | 目的地 | 内容 | 触发时机 | 证据 |
| --- | --- | --- | --- | --- |
| 2.2.1 | PyPI 国内镜像（清华 / 阿里云）、`download.pytorch.org`、`mirrors.aliyun.com/pytorch-wheels`、`mirror.sjtu.edu.cn/pytorch-wheels`、GitHub 国内代理（`ghfast.top` / `gh-proxy.com` / `ghproxy.net`） | 标准包下载请求（客户端 IP、UA） | 用户安装 Music3 / H3 / TTS / llama / SenseNova 后端 | `skills/minimax-h3-install/SKILL.md:33`、`skills/tts-local-install/SKILL.md:53`、`tts-pack/app/train.py:638-644`、`h3-pack/README.md:36`、`sensenova-pack/scripts/install.ps1` |
| 2.2.2 | ModelScope（魔搭）`modelscope.cn`、`hf-mirror.com`（`HF_ENDPOINT`）、必要时 `huggingface.co` | 模型权重下载请求（客户端 IP、UA） | 同上 | `skills/minimax-music3-install/SKILL.md:32-34`、`skills/minimax-h3-install/SKILL.md:34`、`skills/llama-local-install/SKILL.md:51`、`llama/main-llama.js:647`、`tts/main-tts.js:662`、`llama-pack/app/catalog.py:10`、`sensenova-pack/scripts/install.ps1` |
| 2.2.3 | `registry.npmmirror.com`、`data.jsdelivr.com` | 扩展浏览检索请求（含用户在搜索框输入的关键词）；默认源列表内置这两处 | 用户在「扩展能力管理」里在线浏览插件 / 技能 / MCP | `renderer/app-settings.js:1480-1498` |
| 2.2.4 | npm registry（用户所选包）与 GitHub 仓库地址 | 包安装请求 | 用户安装 DSH 插件 / Remotion 后端（`npm install`） | `remotion/main-remotion.js:383-402`、`renderer/app-plugins.js:561-589` |

---

## 3. 出网到 `mt-agent.com`（本项目自有服务器）

统一说明：以上请求都由主进程 `fetch` / Node `http(s)` 发出，固定 UA（`MTNodeAIO/1.1`、`MTNodeAIO/1.1-plugins`、`MTNodeAIO/1.1-pet`、`MTNodeAIO/plugin-runtime`），**不附带姓名、邮箱、设备号或画布内容**；例外见表内注明。服务器 `nginx` 对**所有**请求记录访问日志（§3.6）。

| # | 用途 | 地址 | 发送内容 | 触发时机 | 证据 |
| --- | --- | --- | --- | --- | --- |
| 3.1 | 创意工坊（模板 / 技能 / 讨论区）API | `http://mt-agent.com/mtnode/store-api`（可被 `MTNODE_STORE_URL` 覆盖） | 见 3.1.1–3.1.4 | 用户打开商店面板 / 登录 / 上传 / 发帖 | `main.js:1920-1922`、`main.js:1930-1944` |
| 3.1.1 | 注册与登录 | `/api/register`、`/api/login`、`/api/change-password` | **用户名**（3–24 位字母数字下划线）、**密码**（6–72 位，服务端 scrypt + 随机盐哈希后存储，不留明文）、**昵称**（1–32 位）；三者全部由用户填写，不采集邮箱/手机号 | 用户主动注册/登录 | `store-saas/server.mjs:752-817`、`store-saas/server.mjs:99-101` |
| 3.1.2 | 会话令牌 | `Authorization: Bearer <token>` | 登录令牌；本机由主进程 `auth-store.js` 保管（`auth-store.json`，优先系统 safeStorage 加密），不再写入 `config.json` | 登录后的每次商店请求 | `main.js:1934`、`store-saas/server.mjs:222-242`、`auth-store.js` |
| 3.1.3 | 上传模板 / 技能 | `POST /api/templates`、`POST /api/skills` | 用户选择的 `.mtnodes` 画布包或 `SKILL.md` 及附件、标题、描述（≤2000 字）、标签、预览图/缩略图。**上传前应用会主动清空其中的本机工作目录字段**（工作流 `workspace` 与节点 `workspace`/`agentWorkspace` → 空串），避免泄漏本地路径；但画布正文本身（提示词、参数、素材副本）按用户意愿公开 | 用户主动点上传 | `renderer/app-store.js:2051-2058`、`main.js:1807-1820`、`main.js:1749-1758`、`store-saas/server.mjs:928-974` |
| 3.1.4 | 讨论区发帖 | `POST /api/forum/messages` | 房间（general/bug/improve）、消息文本（≤2000 字）、可选图片（本机先缩到最长边 ≤1080px、JPEG ≤3MB 再上传）；读取时附带 `tzOffset`（客户端时区偏移，分钟数，仅用于按天分桶显示） | 用户主动发帖/浏览 | `store-saas/server.mjs:1451-1493`、`main.js:3200-3246`、`store-saas/server.mjs:1416-1417` |
| 3.2 | 应用内自动更新（NSIS 版） | `http://mt-agent.com/mtnode/updates` | 仅对 `latest.yml` 等元数据与差分块的 GET 请求；**Microsoft Store（MSIX）版整条链关闭**，不加载 electron-updater、不设更新源 | 打包版启动后 8 秒一次、其后每 6 小时一次，以及用户手点「检查更新」 | `updater.js:19-20`、`updater.js:362-373`、`updater.js:46-57`、`updater.js:99-127`、`build.json:190-195` |
| 3.3 | 应用插件目录与安装包 | `http://mt-agent.com/mtnode/plugins/catalog.json` 及目录内 zip | GET 请求（列表 / 下载包），无用户数据 | 用户打开「插件」面板刷新列表、点安装 | `plugins/main-app-plugins.js:15-16`、`plugins/main-app-plugins.js:89-98`、`plugins/main-app-plugins.js:399` |
| 3.4 | 扩展目录（插件 / 技能 / MCP 官方源） | `http://mt-agent.com/mtnode/ext/catalog.json` 及其 `.tgz` 资产 | GET 请求，无用户数据 | 用户在「扩展能力管理」在线浏览 / 安装 | `renderer/app-settings.js:1469-1478`、`ext-repo/build.mjs:13` |
| 3.5 | 本地后端与桌宠的安装包清单 | `http://mt-agent.com/mtnode/music3`、`/mtnode/h3`、`/mtnode/pet` | GET manifest 与包文件 | 用户点安装 / 检查后端更新 | `music3/main-music3.js:37`、`h3/main-h3.js:36`、`pet/main-pet.js:27`、`plugins/runtime-feed.js:70-76` |
| 3.6 | 「在线浏览」通用取回 | 用户在画布/设置里填写的任意 http(s) 地址（经主进程 `net:fetch` 代取） | 用户指定的 URL；固定 UA `MTNodeAIO/1.1` | 用户主动触发 | `main.js:1903-1918` |

### 3.7 服务器侧对 `mt-agent.com` 请求的记录（实测）

| 项 | 实测结论 |
| --- | --- |
| nginx 访问日志 | **开启**。`nginx -T` 显示 http 级 `access_log /var/log/nginx/access.log;`，无自定义 `log_format`（即默认 combined），无任何 location 关闭日志 → `/mtnode/**` 全量入日志 |
| 记录字段 | 客户端 IP、时间戳、完整请求行（方法 + **含查询串的路径**）、状态码、响应字节、`Referer`、`User-Agent`；反代到商店服务的路由另设 `X-Real-IP` / `X-Forwarded-For` 头传给后端（`store-saas/patch-nginx.py:11-21`） |
| 保留期 | `logrotate`：`daily` + `rotate 14` + `compress` → 当前天与前一天明文、其后约 14 份按日 gzip，超期删除（实测 `/var/log/nginx/` 存在 `access.log`、`access.log.1`、`access.log.2.gz` … `access.log.14.gz`） |
| 商店服务自身日志 | 无逐请求日志：`store-saas/server.mjs` 只 `console.log` 启动行与保存失败（`:90`、`:1515`），实测 `journalctl -u mtnode-store` 仅有启停与启动行 |
| 商店服务端保存的字段（实测 `db.json` 键名，未取值） | `users`：`id,username,nickname,salt,pass,createdAt,downloadsReceived,likesReceived`；`sessions`：`tokenHash,userId,expiresAt`；`templates`：`id,userId,title,description,tags,downloads,likes,bytes,hasPreview,createdAt,updatedAt`；`skills`：另含 `skillName,version,official,files`；`forumMessages`：`id,room,userId,text,imageId,createdAt`。**无邮箱、无电话、无 IP 字段**（IP 只出现在 nginx 访问日志） |
| 传输加密 | **仅 80 端口监听，443 未监听**（`ss -lntp` 实测）；即隐私政策 URL 与商店/更新流量当前均为明文 HTTP |
| 下载与更新包的 OSS 侧 | `/mtnode/**` 未被本地 location 覆盖时正则以 `proxy_pass https://mtnode-download.oss-cn-beijing.aliyuncs.com/…` 转发到阿里云 OSS（`/etc/nginx/sites-available/mt-ai-router.conf:198-209`）；OSS 服务端日志由阿里云按其条款记录，不在本项目控制内 |

---

## 4. 服务器端保留与删除（`mt-agent.com`）

| 数据 | 保留期 | 删除方式 | 证据 |
| --- | --- | --- | --- |
| 账号（用户名 / 昵称 / 口令哈希+盐） | 直到被删除（服务端无到期清理） | **无自助注销接口**：路由表只有 `register/login/change-password/logout/me/me-templates`，无账号删除端点 → 需向开发者提出请求 | `store-saas/server.mjs` 路由清单（`:743-1502`）、实测探测 |
| 登录令牌 | 30 天（`SESSION_MS`）；同账号再次登录会作废此前的会话 | 过期自动失效；`/api/logout` 即时删除该令牌 | `store-saas/server.mjs:35`、`store-saas/server.mjs:222-227`、`store-saas/server.mjs:819-828` |
| 已上传模板 / 技能（文件 + 预览图 + 元数据） | 直到被删除 | 作者本人或管理员 `DELETE /api/templates/<id>`：同时删除记录、点赞关系、`files/<id>.mtnodes` 与预览图；技能同理 | `store-saas/server.mjs:1029-1046`、`store-saas/server.mjs:1365` |
| 讨论区消息与图片 | **30 天**（`FORUM_TTL_MS`）自动过期 | 每次读写前 `pruneForum()` 删除超期消息并 `unlink` 其图片；**无单条自助删除接口** → 需向开发者提出请求 | `store-saas/server.mjs:21`、`store-saas/server.mjs:634-652` |
| nginx 访问日志（含 IP / UA / 请求路径） | 约 14 天（daily + rotate 14 + compress） | 自动轮转删除（§3.7） | 实测 `logrotate` 与 `/var/log/nginx` |
| 下载计数等统计 | 与模板记录同寿命 | 随模板删除 | `store-saas/server.mjs:888-908` |

本机侧删除：退出应用后删除数据根目录（`%APPDATA%\pipeline-console\`，或用户在设置里改指的目录）即清除全部工作流、素材、配置与 API Key、会话记录与日志；商店版同样适用（本项目未额外写入注册表存放用户数据）。

---

## 5. 明确不收集 / 不传输（可写进政策的否定式断言）

### 5.1 无遥测、无埋点、无广告

- 全仓（含打包清单 `build.json` 的 `files`）无 `telemetry` / `analytics` / `sentry` / `posthog` / `matomo` / `gtag` 上报代码；`dsh/gateway/cordis.yml` **未挂载任何 telemetry 行**。
- dsh 框架自带的 OTLP 遥测导出簇（`@opentelemetry/*`、`dsh-session-telemetry-otel`）在安装包内被按能力组摘除，包内不可用；因此 `.anonymous-user-id` 不会被任何遥测后端上报。
  证据：`docs/app-deps-capability.json:60-66`（`otel` 组与其判定链）、`CHANGELOG-v1.1.md:262`、`dsh/DESIGN.md:464-494`。

### 5.2 无第三方统计/社交/定位脚本

- 所有 `*.html`（含 `renderer/`、各本地后端 UI、桌宠、讨论区）外链资源零匹配；CSP `connect-src 'self'`。
- 无 `getUserMedia` / `mediaDevices` / `desktopMedia` / `geolocation` 调用 → 不申请摄像头、麦克风、屏幕与位置权限。

### 5.3 无设备指纹与身份标识采集

- 全仓无 `networkInterfaces` / `hostname()` / `getMacAddress` / `userInfo()` / `MachineGuid` / `wmic` / `machineid` 引用（grep 零匹配）→ 不采集硬件序列号、MAC、用户名、Windows 账户标识。
- 唯一稳定标识是本机生成的随机 UUID（1.11），用途仅限 §2.1.4 的 DeepSeek 官方请求头；它不由服务器下发，也不能被本项目的代码关联到自然人。

### 5.4 崩溃诊断不外传

- `crash-report.js` 通篇只有 `fs` / `dialog` / `shell` 写本机与打开文件夹，无 `http` / `fetch`；崩溃弹窗只给「导出诊断日志…／打开日志文件夹／关闭」三个本地动作（`crash-report.js:189-222`）。导出内容里显式声明不含 API Key 与密钥（`crash-report.js:227`）。
- 已知边界（政策中不应写成绝对化保证）：日志尾部是**用户自己产生的文本片段**（工作流正文、报错消息、命令行输出），且环境块含 `execPath` / `dataDir` / `cwd` —— 这些路径可能带 Windows 用户名。它们只在用户主动导出并自行提交时才离开本机。

### 5.5 不出售 / 不共享

- 项目自有服务器（`mt-agent.com`）与随包代码中不存在把用户数据转给任何第三方的通路；除 §2 表格所列「由用户自己选择并计费的服务商」和「用户自己配置的地址」外，无任何自动转发。法定披露义务与用户主动投稿除外。

---

## 6. 需要在政策页如实交代的三处「敏感但真实」

1. **Agent 能读写本机文件、执行命令**：这是功能而非收集。被读到的文件内容会作为工具结果发往用户所选模型服务商（§2.1.2）；工具授权由 Agent 预设决定，「纯净模式」会剥掉全部提示与工具、只留联网搜索（`renderer/app-assist.js:1376`、`dsh/gateway/gateway.mjs:907-911`）。默认运行于无人值守预设（实测 `settings.yaml` 的 `permission.defaultPreset: mtnode-unattended`）。
2. **桌宠插件的全局输入监听**：启用桌宠时，它会注册系统级键盘/鼠标钩子（`keydown`/`keyup`/`mousedown`/`mouseup`/`mousemove`），仅把**按键名与鼠标坐标**发给桌宠自己的窗口做动画反应，全部留在本机进程内、不写盘、不出网；不用时停用或卸载该插件即可（`pet/main-pet.js:756-776`、`pet/standalone-main.js:751`）。
3. **「网络接收」节点监听 `0.0.0.0`**：运行该节点会在本机所填端口（TCP / UDP）监听全部网卡，局域网内其他设备可连入并推送数据 —— 这是用户自建的数据入口，收发内容不经过任何服务器（`main.js:944-979`）。

---

## 7. 政策写作口径（给任务 2 / 3 的约束）

- 不得写「本产品不收集任何个人信息」：账号（用户名/昵称/口令哈希）、上传内容与讨论区发帖确实存在于服务器，nginx 亦记录 IP 与 UA。
- 不得写「全程加密传输」：当前 `mt-agent.com` 仅 HTTP（§3.7）。可以写「对第三方服务商的访问由用户配置的地址决定，DeepSeek 官方默认为 HTTPS 端点」。
- 不得把「不建账号也能用」写成「本产品无账号体系」：创意工坊与讨论区**有**可选账号，且**无自助注销**，因此政策必须给出可执行的删除请求渠道。
- 联系渠道：仓库内不存在任何邮箱地址，唯一可用的公开渠道是 GitHub Issues `https://github.com/shaomang/mtnode-aio/issues`；政策页与文档都只写这一个，不得编造邮箱。
- 生效日期与版本记录由政策页自身标注；本清单随代码变更同步更新（改动了任何出网行为或服务器保留策略时，先改本文件再改政策页）。
