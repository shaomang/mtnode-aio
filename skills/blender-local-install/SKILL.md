---
name: blender-local-install
title: Blender 本地插件安装与修复
description: 把「Blender 本地插件」装好或修好：从官方 download.blender.org 解析最新稳定版、下 windows-x64 便携 zip（sha256 校验 + 断点续传）解到用户选的目录，装 uv（缺时跑官方 install.ps1，失败回退官方 release zip）、用 uvx 装 mcp-for-blender addon 并在 Blender 里启用（改 userpref 前先备份）、通过 dsh 的 MCP 注册口注册 serverName=blender（落盘到 dsh-home/cordis-user.yml），最后跑一次端到端冒烟（启 Blender → addon socket → MCP initialize/tools/list）。含自我修复指引（下载 / 校验 / uv / addon 启用 / 端口 / 握手 / MCP 行）。
---

# Blender 本地插件 — 安装 / 修复

当用户或 MTNode 插件要求**安装**或**自我修复**「Blender 本地插件」（应用插件 `blender-local`，kind `blender`）时使用本 skill。

插件调用时给的现场：

- **当前工作区就是 `INSTALL_DIR`**（可写）：官方便携 zip 解压到这里，正常情况下 `blender.exe` 直接躺在根上（官方 zip 多套的那层 `blender-<ver>-windows-x64/` 会被宿主剥掉）。默认 = 插件根目录 + `blender` 子目录；用户可在安装窗里换。
- **`CONSOLE_LOG`（插件控制台最近日志）**：`<数据目录>\blender\console.log`。前缀就是宿主的每一步动作：
  `[install]` / `[download]` / `[uv]` / `[addon]` / `[blender]` / `[mcp]` / `[smoke]` / `[console]` / `[repair]` / `[uninstall]`。
  **先读它定位，再动手**。
- **插件配置**：`<数据目录>\blender\config.json`（`installDir` / `blenderVersion` / `blenderExe` / `uvPath` / `port` / `mcpRegistered` / `latestSeen` / `latestSource`）。
- **userpref 备份**：`<数据目录>\blender-backup\userpref-<x.y>-<ts>.blend`（改 userpref 前自动备份；**卸载不删**）。
- **MCP 行**：`<数据目录>\dsh-home\cordis-user.yml`，`serverName: 'blender'`；行 id（`user-mcp-xxxx`）由网关分配，**认 serverName，不要认 id**。

## 目标（装好的判据）

按顺序全部成立才算可用：

1. **Blender 本体**：`INSTALL_DIR\blender.exe` 存在，`blender.exe --version` 第一行报 `Blender 5.x.y`；
2. **addon 已落盘**：`%APPDATA%\Blender Foundation\Blender\<x.y>\scripts\addons\blender_mcp.py` 存在（官方 addon 的 bl_info name = `MCP for Blender`）；
3. **addon 已启用**：`%APPDATA%\Blender Foundation\Blender\<x.y>\config\userpref.blend` 里该 addon 是启用态（宿主用无头 `addon_utils.enable(..., default_set=True)` + `bpy.ops.wm.save_userpref()` 落的）；
4. **uv / uvx 可用**：`uv.exe --version` 与同目录 `uvx.exe` 都在（mcp-for-blender 靠 uvx 跑）；
5. **MCP 已注册**：`cordis-user.yml` 里有 `serverName: 'blender'` 的行块，`command` 指向 uvx.exe，`args` 里 `--port` 与 `config.port` 一致；
6. **端到端冒烟过**：起 Blender（`--python-expr` 把端口写进 `scene.blendermcp_port` 并调 `_blendermcp_ensure_server_running()`）→ 该端口可连 → `uvx mcp-for-blender --host 127.0.0.1 --port <p>` 的 `initialize` + `tools/list` 拿回工具列表。

## 前置

- **Windows x64**（官方发布只取 windows-x64.zip；不装 ARM / 其它平台）。
- **能访问 `download.blender.org`**：版本号靠解析该目录的 HTML listing（`release/` → `BlenderX.Y/` → 最高的 `blender-<ver>-windows-x64.zip`）。取不到版本号时宿主回退内置清单（`blender/main-blender.js` 的 `KNOWN_VERSIONS`），界面会标「非实时最新」——**回退不是失败**，但要在回复里说明。
- **sha256 必须有**：官方同目录 `blender-<ver>.sha256` 里要有该 zip 的值，否则宿主**拒绝安装**（`blender.sha256_unavailable` / `blender.sha256_missing`）。不要绕过校验。
- **磁盘**：zip 约 405MB + 解压后约 1.2GB（另加 uvx 缓存与 addon 的 whl 缓存）。
- **uv**：先复用本机 `~/.local/bin/uv.exe` / `~/.cargo/bin/uv.exe` / `<插件根>\blender\.uv\uv.exe` / PATH 里的 uv；都没有就跑 `irm https://astral.sh/uv/install.ps1 | iex`，仍失败回退 `https://api.github.com/repos/astral-sh/uv/releases/latest` 的 `uv-x86_64-pc-windows-msvc.zip`（sha256 校验后解到 `<数据目录>\blender\.uv`，再拷到 `INSTALL_DIR\.uv` 备查）。
- **Blender 里没有官方 MCP**：上游事实标准是社区包 `mcp-for-blender`（PyPI，MIT，原 `blender-mcp`），控制台脚本 `mcp-for-blender`，addon 模块名 `blender_mcp`，`ADDON_PROTOCOL_VERSION = 14`。别去找 blender.org 的 MCP。

## 宿主是怎么装的（改这段代码前先读）

真源：`blender/main-blender.js`（宿主 / 安装编排）+ `blender/steps.json`（步骤表）+ `blender/ui/`（控制台）。
安装窗那颗「开始安装 / 重试」调 `blender:install`，宿主跑 `installBackend()`，**状态由宿主自己上报**
（纯 JS 驱动，没有 PowerShell 安装脚本 → 不走 pack-steps 协议，直接 `installHost.reportPluginStep`）：

1. `probe`：已装的判断 = 目标目录里找得到 `blender.exe`（或配置里记的 exe 还在）。**已装即跳过下载、不自动升级**（共识），但仍会查一次官方最新版号存进 `config.latestSeen` 供界面显示；若 addon 丢了，会补走 uv / addon / mcp / smoke；若只是 MCP 行丢了（`mcpStatus().registered === false`），只补注册这一行。
2. `download`：解析官方目录 → 取 `.sha256` → 下 zip 到 `INSTALL_DIR\.download\`（`.part` 断点续传，3 次重试）→ 校验；不一致就删包报 `blender.sha256_mismatch`（重试即可）。
3. `extract`：`tar.exe -xf`（失败回退 `Expand-Archive`）→ `flattenSingleDir` 剥掉官方那层目录。
4. `uv`：见前置；`uvx.exe` 必须与 uv 同目录。
5. `addon`：`uvx mcp-for-blender install-addon --addons-dir <user addons dir>` → 再 `blender.exe --background --python-expr <ENABLE_ADDON_SCRIPT> -- blender_mcp`（脚本在 `main-blender.js` 的 `ENABLE_ADDON_SCRIPT`，打印 `MTNODE_BLENDER_RESULT {json}`；`BLENDERMCP_NO_UPDATE_CHECK=1`）。改 userpref 前 `backupUserPref()` 已备份。
6. `mcp`：9876 被占就在 9876–9886 里挑一个空闲端口 → 走 **`dsh().mcpAdd`**（网关自己的注册口，会持久化用户段）注册 `serverName=blender`；只有拿不到网关时才退回直接改 `cordis-user.yml`。**别手写 YAML**：下次启动网关按用户段重写组合时会把外来的行冲掉。
7. `smoke`：见判据第 6 条；冒烟结束会关掉**插件拉起的**那只 Blender（`taskkill /PID <pid> /T /F`）。
8. `done`：提示重启 MTNode（MCP 配置只在启动时读）。

**接口约定（别踩）**：
- 官方 zip 里的顶层目录只有一层，且必须剥掉，否则 `READY_MARKERS`（`blender.exe`）认不出「装过东西」。
- addon 在 `--background` 下**不会自己起服务**（`_blendermcp_ensure_server_running()` 在 `bpy.app.background` 时返回 None）——冒烟必须开 GUI Blender，并用 `--python-expr` 主动设 `scene.blendermcp_port` + 调 `_blendermcp_ensure_server_running()`。
- 启停口径：只认宿主 `blenderChild.pid`；用户手开的 Blender（`tasklist` 里能看到）只提示不杀，卸载也一样。
- 卸载（`blender:uninstall`）：撤 MCP 行 → 删 addon → 删安装目录（`isSafeInstallDir` 白名单外一律拒删）→ 删 `<数据目录>\blender`；**保留** userpref 备份、本机 uv、用户工程文件。

## 常见故障与处置

| 现场（日志 / 错误码） | 原因 | 处置 |
| --- | --- | --- |
| `blender.download_failed` / 一直 0% | 官方站点不通 / 代理拦 | 换网络或代理后**重试**（会续传）。仍不行：`curl -I https://download.blender.org/release/` 看状态码，把结论写进回复，别改源 |
| `blender.sha256_mismatch` | 传输截断 / 中间盒改写 | 直接重试（宿主已删掉坏包）；连续两次就查代理 / 磁盘 |
| `blender.sha256_unavailable` / `sha256_missing` | 目录刚更新、`.sha256` 还没同步 | 等几分钟重试；把具体 URL 报给用户，**不要**跳过校验装 |
| `blender.extract_failed` | 目标不可写 / 磁盘不足 / tar 被拦 | 换目录（安装窗「更换目录」）或清空间；确认 `tar.exe -xf` 能跑 |
| `blender.exe_missing` | zip 截断 / 解压到一半 | 删 `INSTALL_DIR\.download` 后重试 |
| `blender.uv_failed` | `install.ps1` 被策略拦 / GitHub 也连不上 | 手动 `irm https://astral.sh/uv/install.ps1 \| iex`，或从官方 release 下 `uv-x86_64-pc-windows-msvc.zip` 解到 `~/.local/bin`；确认 `uv --version` 有输出后回安装窗重试 |
| `blender.uvx_missing` | uv 装了但目录不完整 | 删那个 uv 目录后重装（宿主会重下） |
| `blender.addon_install_failed` | uvx 拉 PyPI 失败 / 代理 | 设 `UV_DEFAULT_INDEX` 走清华 `https://pypi.tuna.tsinghua.edu.cn/simple` 后重试；`uvx mcp-for-blender --help` 应能跑（**uvx 没有 `--yes`**，别加） |
| `blender.addon_enable_failed` | userpref 被运行中的 Blender 占用 / 旧版残留 | 关掉所有 Blender → 重试；仍失败：手动 `blender.exe` → 编辑 → 偏好设置 → 插件 → 勾选「MCP for Blender」→ 保存；再看 `config.json` 的 `blenderVersion` 是否与 `%APPDATA%\Blender Foundation\Blender\` 下目录一致 |
| `blender.socket_timeout` | addon 没启用 / 端口被占 / 防火墙 | 先看 `[blender]` 日志里 `MTNODE_BLENDER_START_ERROR`；`netstat -ano \| findstr 9876` 查占用；确认 `blender_mcp.py` 在 addons 目录，重启 Blender 后重试 |
| `blender.mcp_handshake_failed` | uvx 起不来 / addon 协议版本旧 | `uvx mcp-for-blender --host 127.0.0.1 --port <p>` 手跑看报错；`pip download` 不了就走 `UV_DEFAULT_INDEX` 镜像；协议版本旧就 `uvx --refresh mcp-for-blender` 重拉 |
| `blender.no_free_port` | 9876–9886 全被占 | 关掉占用者（常见：另一个 Blender / 旧 MCP 服务端 / 上次没退的 uvx），或重启机器 |
| `blender.mcp_write_failed` | dsh 网关没起来 / `cordis-user.yml` 不可写 | 看 `[mcp] 注册失败：…` 那行原始报错；网关要本机 Node ≥22.19。别手写 YAML 顶替，改好网关后回安装窗重试（已装时只会补注册这一行） |
| 重启后 Agent 里没有 blender 工具 | MCP 配置只在启动时读 | 关掉 MTNode 重开；再不行看 `设置 → 扩展能力 → MCP` 里 `blender` 是否列出、`cordis-user.yml` 里 `--port` 与 config 是否一致 |

## 边界（修复时也不许越线）

- **只从官方 `download.blender.org` 下 Blender**；不许换第三方镜像、不许跳过 sha256。
- **不自动升级**：已装就跳过。用户要新版 = 卸载后重装，或明确要求后再做。
- **不动用户的 Blender 实例**：只杀 `config` / 宿主记录里那只 pid；卸载前也只停这一只。
- **不删用户工程文件**、不删 `blender-backup`、不卸本机 uv。
- 不写应用目录（`app.getAppPath()` / exe 同目录）；一切落在 `%APPDATA%\pipeline-console` 或用户选的安装目录。
- 端口只动 `scene.blendermcp_port` 与 MCP 行的 `--port`，别去改用户 Blender 的其它偏好。

## 自我修复（Agent 按这条走）

1. **先读日志**：`<数据目录>\blender\console.log`（最近 64KB），按前缀定位失败那一步；安装窗左栏哪一步是 ✕，就是它。
2. **跑四只只读命令**（缺哪条补哪条，不要瞎猜）：
   - `"<INSTALL_DIR>\blender.exe" --version`
   - `"<INSTALL_DIR>\blender.exe" --background --python-expr "import addon_utils;print([m.__name__ for m in addon_utils.modules(refresh=True) if 'blender_mcp' in m.__name__])"`
   - `uv --version` 与 `uvx --version`（找不到就按上表「uv 失败」处置）
   - `node -e "const fs=require('fs');const p=process.env.APPDATA+'/pipeline-console/dsh-home/cordis-user.yml';const t=fs.existsSync(p)?fs.readFileSync(p,'utf8'):'';console.log(t.includes(\"serverName: 'blender'\")?'registered':'missing')"`（认 `serverName: 'blender'`，行 id 由网关分配）
3. **按上表处置**，改完只做「重试 / 重装」这一件事；需要重装就回安装窗点「重装」（宿主会复用已下好的包与 uv）。
4. **收尾复核**：「目标（装好的判据）」六条逐条验，把命令 + 输出写进回复；跑一次控制台「测试连接」拿到工具数最好。
   插件交办的 Agent 安装 / 修复任务还要落结论文件 `INSTALL_DIR\.blender-agent-result`：
   首行 `ok=true`（修好了）或 `ok=false` + `reason=<一句可读原因>`；成功也顺手写 `.install-ok`。
5. **不许伪造**：验不过就如实说卡在哪一条、下一步该谁做（用户换网络 / 关 Blender / 换目录）。

## 手工复现（无 UI）

```powershell
# 1) 官方最新版号
(Invoke-WebRequest https://download.blender.org/release/ -UseBasicParsing).Content -split "`n" | Select-String 'Blender5\.' | Select-Object -First 3

# 2) 只验安装结果（不启动 GUI）
& "$env:APPDATA\pipeline-console\blender\blender.exe" --version
Get-ChildItem "$env:APPDATA\Blender Foundation\Blender" -Directory | ForEach-Object { Join-Path $_.FullName 'scripts\addons\blender_mcp.py' } | ForEach-Object { "$_ : $(Test-Path $_)" }
uvx --yes mcp-for-blender --help
```
