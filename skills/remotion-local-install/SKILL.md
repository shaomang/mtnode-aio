---
name: remotion-local-install
title: Remotion 动效视频插件安装与修复
description: 在用户指定的安装目录里把 Remotion（React 动效）渲染工程装起来并修好：node / npm 前置、复制随包脚手架 remotion-pack、npm install（remotion + react + @remotion/renderer）、可加载校验、Chrome Headless Shell 预置；并给出「安装窗一条步骤行一条日志都没有」这类现场（包内 scripts/ 缺失即脚本未被复制、宿主 spawn 失败）的定位方法。含自我修复指引。
---

# Remotion 动效视频插件 — 安装 / 修复

当用户或 MTNode 插件要求在某目录**安装**或**自我修复**「Remotion 动效视频」后端时使用本 skill。

插件调用时给的现场：

- **当前工作区就是 `INSTALL_DIR`**（可写），可直接读写并执行命令；
- **`PACK_ROOT` 是随包脚手架**（打包后 `<应用 resources>/remotion-pack`，开发态是仓库根 `remotion-pack`）——只读参考，宿主的安装链会先把它复制进 `INSTALL_DIR` 再跑脚本，不要假设工作区里已经有它；
- **`CONSOLE_LOG`（插件控制台最近日志）**：MTNode 会把安装日志写进 `%APPDATA%\pipeline-console\<数据目录>\remotion\console.log`，其中的 `[selfcheck]` 段就是环境自检结果，**先读它定位，再动手**。

## 目标

在 `INSTALL_DIR` 里得到一份**能渲染**的 Remotion 工程：

- `INSTALL_DIR\node_modules\remotion\package.json` 与 `node_modules\@remotion\renderer\package.json` 都存在；
- `INSTALL_DIR\render.mjs` 就位（渲染脚本），且 `INSTALL_DIR\portrait-dialogue.tsx`（内置台词卡模板）在；
- **用户工程不在安装目录里**：渲染工程（`index.tsx` / `Composition.tsx` / `render.json`）与成片都在
  画布工作目录的 `.mtnode\remotion\<节点 id>\` 下，由 MTNode 主进程按绝对路径注入（见下「路径分工」）；
- 没有常驻服务：装完即结束，渲染由 MTNode 拉起 `node <INSTALL_DIR>\render.mjs <render.json 绝对路径>`。**不要**自己常驻进程。

## 路径分工（不许把用户代码写进安装目录 / 应用目录）

| 用途 | 位置 | 谁写 |
| --- | --- | --- |
| 依赖源（`node_modules`）+ `render.mjs` + 内置模板 | `INSTALL_DIR` | 安装链 |
| 渲染工程（`Composition.tsx` / `index.tsx` / `render.json`）与成片 | `<画布工作目录>\.mtnode\remotion\<节点 id>\` | MTNode 主进程 |
| 应用目录（`app.getAppPath()` / `resources` / 随包 `remotion-pack`） | 只读参考 | 任何人都不写 |

工程目录由应用注入：`render.json` 里的 `entryPoint` / `projectDir` / `nodeModulesDir` / `outputLocation`
全是绝对路径，`react` / `remotion` 靠 `nodeModulesDir` 注入到 webpack 的 `resolve.modules` —— 所以
工作目录里**不需要** `node_modules`，也**不要**在里面造软链 / 复制依赖。

## 前置（先查，缺什么说什么）

- **node / npm 必须在 PATH 里**：`node -v` 与 `npm -v` 都要有输出。Remotion 是 Node 工程，Electron 自带的运行时**不算**；
- 命令在 PowerShell 里跑（脚本是 `.ps1`，宿主用 `-NoProfile -ExecutionPolicy Bypass -File` 拉起）。

## 插件的安装链（改动这一段代码前先读）

真源在 `remotion/main-remotion.js` 与 `remotion-pack/scripts/install.ps1`：

1. 宿主 `installProject()` 先读自己的 `config.json` 里的 `installDir`，过 `isSafeInstallDir`（盘根 / 系统目录 / **MTNode 自己的应用目录**一律拒）；
2. **预检**（`preflightForInstall()`）：node / npm、目录可写、磁盘余量、npm 源、随包脚手架与 `scripts/install.ps1` 是否在 —— 逐条写进安装日志，缺哪条当场停在失败步；
3. `copyDirRecursive(PACK_ROOT → INSTALL_DIR)`，跳过 `node_modules / .git / out / output`；
4. spawn `INSTALL_DIR\scripts\install.ps1 -InstallDir <dir> -SkipCopy`；
5. 脚本按步骤协议（`pack-steps/step.ps1` 的 `Step-Begin / Step-Ok / Step-Fail`，一行一条 JSON，`mtnodeStep: 1`）逐条上报步骤行，宿主转给安装窗；
6. 装完宿主校验 `node_modules/remotion` 存在并写 `installed.json`，再顺手预置 Chrome Headless Shell（失败不判安装失败）。

**安装包完整性是发布侧的事，不是修复侧的活**：`build.json` 的 `extraResources` 里 `remotion-pack` 一段必须包含
`scripts/**`（漏了的表现：安装窗开得出来、左侧步骤表空白，或只有表没有步骤行，脚本一行都没跑过）。
但**修复会话永远不许去改它**：用户在界面上看到的处置只有「重新安装 / 更新 MTNode」。

## 目录与日志约定

```
INSTALL_DIR\              安装目录（依赖源）：render.mjs + 内置模板 + node_modules\
<画布工作目录>\.mtnode\remotion\<节点 id>\   渲染工程 + render.json + 成片（宿主写入）
PACK_ROOT\                随包脚手架（只读）：package.json / src/** / render.mjs / scripts\install.ps1 / steps.json
<数据目录>\remotion\console.log        安装与渲染日志（[selfcheck] 段 = 环境自检）
<数据目录>\remotion\config.json        { "installDir": "..." }
<数据目录>\remotion\installed.json     安装成功后的版本与目录
```

## 国内镜像（必须）

npm 默认走 `registry.npmmirror.com`（真源 `cn-mirrors.js` / `docs/mirror-sources.md`）：

- 脚本参数：`-Registry <url>` 自定义源、`-Official` 切回官方源（两者都别用数组 splat 传给原生命令，只有 `--registry=<url>` 单字符串才不会被拆词）；
- 环境变量：`npm_config_registry`（宿主与脚本都会下发）。

## 脚本语言与编码（必须）

`remotion-pack/scripts/*.ps1` **必须是纯 ASCII**：PowerShell 5.1 读无 BOM 的 `.ps1` 时按机器 ANSI 代码页解码，非 ASCII 字节会直接把解析搞坏（报语法错，安装第一步就 fail）。要输出中文提示请走步骤协议的 `message` 或前端文案，不要写进脚本。
- 这条纪律已是**硬守卫**：`AGENTS.md` 的「协作约定」钉了它，`test/smoke-install-scripts.js` 会自动扫描全部 `*-pack` 的 `.ps1` / `.cmd` / `.bat`、`*-pack/scripts/**/*.py`、共享真源 `pack-steps/` 与 `pack-python/`、以及项目 `scripts/` 下的 `.ps1` / `.cmd` / `.bat` —— 任一字节 > 0x7F（中文、全角标点、emoji、`→`、制表线）或带 BOM 即硬失败。改脚本后**必须**跑 `node test/smoke-install-scripts.js`（同时还钉 GBK(cp936) 与 UTF-8 双解码解析零错、进度前缀与 `reason=` 等 ASCII 契约仍在）；后端运行时 Python（`*-pack/app/**`、`*-pack/shims/**`）豁免，仍是中文。

## 安装步骤（按序）

| 步骤 id（steps.json） | 干什么 | 怎么算成功 |
| --- | --- | --- |
| `node` | 查 `node --version` / `npm --version` | 两个都有版本号 |
| `copy` | 工程文件是否已就位 | `INSTALL_DIR\package.json` 存在 |
| `npm` | `npm install --registry=…` | 退出码 0 |
| `check` | `node -e "require.resolve('remotion'); require.resolve('@remotion/renderer')"` | 退出码 0，并写 `.install-ok` |

手动重跑（在工作区里）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:INSTALL_DIR\scripts\install.ps1" -InstallDir "$env:INSTALL_DIR" -SkipCopy
```

## 常见失败与修法

1. **`node / npm not found in PATH`（步骤 node 失败）**：让用户装 Node.js ≥18（建议 LTS）并确保 `node -v` 在新的 PowerShell 窗口里可用，然后重开 MTNode 再装。**不要**替用户改系统 PATH / 装运行时。
2. **`pack_missing` / `install_script_missing`：随包脚手架或 `scripts\install.ps1` 不存在**：这是**应用安装包不完整**，不是网络问题，也不是你要动代码的事 —— 让用户「重新安装 / 更新 MTNode」。**不许**去改 `build.json`、`remotion-pack` 或宿主源码。
   同理，**`install_dir_inside_app`**（安装目录落在 MTNode 应用目录里）：让用户到插件卡片点「选择安装目录」，换一个普通用户目录（如 `D:\mtnode\remotion`）。
3. **`npm install` 失败（步骤 npm 失败）**：先看日志里 npm 的 `ERR` 行。
   - `ECONNRESET / ETIMEDOUT / ENOTFOUND` → 换源重试（`-Official` 或公司内网源）；
   - `EINVALIDTAGNAME: Invalid tag name "="` → 脚本把 `--registry` 与 URL 拆成两个参数了，改成单个字符串 `"--registry=<url>"`；
   - `ERESOLVE` → 版本冲突，删 `node_modules` 与 `package-lock.json` 后重跑（已下载的包在 npm 缓存里，不会再下一次）。
4. **`runtime_missing: node_modules/remotion 未找到`**：npm 跑到一半被中断（关窗 / 取消 / 断网）。重跑安装即可续装；反复失败就删 `node_modules` 再来。
5. **装上了但渲染时下 Chrome Headless Shell 超时**：渲染会回退到本机 Edge / Chrome；要预置就重跑安装（它会从 npmmirror 代下同版本 zip 塞进 Remotion 的缓存目录）。国内网络下这一步失败**不算安装失败**。
6. **安装窗打开了却一条步骤行、一条日志都没有**：同上 —— 安装包不完整，让用户重装 / 更新 MTNode（不要自己去补包、不要要求重启应用）。
7. **`no_workspace`（渲染报「需要画布工作目录」）**：让用户先在顶栏「工作目录」选一个文件夹；工程与成片都会落在 `<工作目录>\.mtnode\remotion\<节点 id>\`。**不要**把工程改写进安装目录来「绕过去」。

## 自我修复模式（CONSOLE_LOG 已由插件提交）

1. **先读证据**：`CONSOLE_LOG` 里的 `[selfcheck]` 段与安装失败那一段（`[install] failed:` 后面就是现场）；不要没读日志就重装。
2. 按顺序排除：环境（node / npm / 磁盘 / 目录可写）→ 随包脚手架（`PACK_ROOT` 与 `INSTALL_DIR\scripts`）→ 依赖（`node_modules` 能不能 `require.resolve`）→ 渲染层（render.mjs / 工程目录 / 浏览器）。
3. 只修**缺的那一层**；已就位的依赖不要删了重下（npm 有缓存，但用户等不起）。
4. 修完自己跑一次安装脚本（见上「手动重跑」），**以退出码 0 与 `node_modules/remotion/package.json` 存在为准**，别只凭日志没报错就宣布修好。
5. 在工作区（`INSTALL_DIR`）根下写结果文件 `.mtnode-repair-result`，首行 `ok=true`（修不动写 `ok=false` 与 `reason=`），并在会话回复里给 `repair_ok=1` 与一句话根因。
6. **修复边界（硬）**：只在 `INSTALL_DIR` 内改文件；`INSTALL_DIR` 之外（`PACK_ROOT`、应用目录、插件目录、`remotion/main-remotion.js`、`build.json`、`remotion-pack\**`）**一个字节都不写**。修不动就如实写 `ok=false` 与需要用户做什么，**不许**改成「去改应用源码 + 重启应用」这类方案 —— 用户装的是成品应用，不是开发仓库。

## 约束

- 只改 `INSTALL_DIR` 内的文件；不动 `PACK_ROOT` 与应用目录（改了升级即丢，还必须重启才生效）；
- 不替用户安装 / 升级系统级运行时（Node、显卡驱动等），只如实指出缺什么；
- 不删除用户产物（`out/`、`output/`、`<工作目录>\.mtnode\remotion\` 里的合成与成片）；
- 不改仓库根 `version` / `package.json`、不跑任何 git 命令（发版由用户手动做）。

## 成功标准

- `INSTALL_DIR\node_modules\remotion\package.json` 与 `node_modules\@remotion\renderer\package.json` 存在；
- `node -e "require.resolve('remotion')"` 在 `INSTALL_DIR` 下退出码 0；
- 没有常驻进程残留；
- 插件控制台里 `remotionStatus` 显示已安装与版本号。
