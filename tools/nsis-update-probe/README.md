# NSIS 更新流程探针（一次性工具）

**这**不是**打包产物，也不进 `test/` 自动跑清单** —— 它是「任务 3/6：用 makensis 编最小假安装器，
实测更新时是否真的零点击、只剩进度页」用的一次性验证工具，需要时手工跑。

被测对象是仓库根的 `installer.nsh`（三只宏 `customInstallMode` / `customFinishPage` /
`customInstall`）——`probe.nsi` 里用 `!include "<绝对路径>\installer.nsh"` 原样引入，
不复制、不改写；改了 `installer.nsh` 之后重跑本探针即可复测。

## 怎么跑

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\nsis-update-probe\run-probe.ps1
```

前置：本机 `%LOCALAPPDATA%\electron-builder\Cache` 里已有 `nsis-3.0.4.1`（makensis）与
`nsis-resources-3.4.1`（StdUtils / UAC 插件）。脚本会自己找，找不到就报错退出。

它会做三件事：编两只安装器 → 真跑三次 → 把每页是否真的显示、进程是否自己退出、StartApp
是否被调用（用 `fake-app.cmd` 写标记文件代替真的拉起应用）全部记录下来。

## 三次实验

| # | 可执行文件 | 命令行 | 期望 |
|---|---|---|---|
| 1 | `build\probe.exe` | `--updated` | 更新路径：零点击、只剩进度页、装完自己关 + 自动重开 |
| 2 | `build\probe.exe` | （无参数） | 手动安装对照：模式页 / 目录页 / 完成页都要点，完成页有「运行应用」勾选 |
| 3 | `build\probe-noabort.exe` | `--updated` | 对照：不装 `customFinishPage`（= 不 Abort 完成页、只靠 MUI 的 `SetAutoClose`），看会不会自己关 |

产物：`runs\<编号>-<名字>\pages.log`、`runs\<编号>-<名字>\startapp-called.txt`、`runs\summary.json`。
（`build/` 与 `*.log` 已被仓库 `.gitignore` 忽略。）

## 实测结论（本机 2026-11-18，NSIS 3.04）

| # | 页面序列（pages.log 里出现的页） | 不点击时是否自己退出 | 点了几下 | 退出码 | StartApp |
|---|---|---|---|---|---|
| 1 | 进度页 | 是，2.9s | 0 | 0 | 被调用，`args=[--updated]` |
| 2 | 安装模式页 → 目录页 → 进度页 → 完成页 | 否 | 5 | 0 | 被调用，`args=[]`（完成页「运行应用」勾选） |
| 3 | 进度页 → **完成页** | 否（8s 仍在，窗口还在） | 2 | 0 | 被调用，`args=[--updated]` |

结论：

1. **更新路径的 Abort 有效**：装模式页（`customInstallMode` 逼定 `$isForceCurrentInstall`）与
   目录页（`skipPageIfUpdated`）都被跳过，完成页（`customFinishPage` 里的
   `skipFinishPageIfUpdated`）也被跳过，整条 UI 只剩进度页；全程零点击，2.9 秒后进程自己退出
   （退出码 0），`customInstall` 里的 `HideWindow` + `StartApp` 确实执行了。
2. **Abort 跳最后一页 = 直接收尾**：第 1 跑里完成页没有被 SHOW 过、进程随即自行退出，不是留一个
   空窗口等人点。
3. **靠 MUI 的 `SetAutoClose` 兜不住**：MUI2 `Finish.nsh:99-101` 在没定义
   `MUI_FINISHPAGE_NOAUTOCLOSE` 时确实 `SetAutoClose true`（electron-builder 的模板里没有任何
   地方去 define 它，何况 `MUI_FINISHPAGE_RUN` 也不会自动 define 它），但第 3 跑（同一只安装器，
   只差这条 Abort）完成页照常弹出并一直等在那里 —— 8 秒不退出、窗口仍在，必须人点「完成」。
   所以「更新时零点击」只能靠 Abort 拿掉那一页，autoclose 救不了。
4. **手动安装照旧**：第 2 跑四页齐全，每页都停住等点击，完成页照旧有「安装完成后运行应用」
   勾选并能拉起（标记文件里的 `args=[]` 说明非更新时 `StartApp` 传空参）。

## 与真实打包链的等价性 / 有意的偏离

等价的部分：

- flag 宏（`isUpdated` / `isForceRun` / …）按 `NsisScriptGenerator.flags` 的原文写
  （`node_modules/app-builder-lib/out/targets/nsis/NsisScriptGenerator.js:29-40`），flag 列表
  同 `NsisTarget.js:579`；section 里 `customInstall` 的位置同 `installSection.nsh:81-83`（铺完文件之后）。
- 页序照抄 `assistedInstaller.nsh`（assisted + `allowToChangeInstallationDirectory: true`），
  并按 `build.json` 的 `nsis` 配置补了 `INSTALL_MODE_PER_ALL_USERS_REQUIRED` / `APP_64` 等 define
  （`NsisTarget.js:439-448`）。用 `-WX`（警告即错误）编译，与 electron-builder 的调用一致。
- 插件与 include 全部用 electron-builder 缓存里的同一批（`nsis-3.0.4.1` / `nsis-resources-3.4.1`）。

偏离（都是为了让这只假安装器只碰 `%TEMP%`，不影响被验证的页序逻辑）：

- 只往 `%TEMP%\mtnode-nsis-probe` 写文件，不写注册表、不建快捷方式、不装任何东西；
  `INSTALL_REGISTRY_KEY` 指向一个不存在的键（真身只读它）。
- 不插 `customInit`（那只宏只决定 `$INSTDIR`，还会指到 `%LOCALAPPDATA%\Programs`）；改用 `/D=`
  把 `$INSTDIR` 钉在 `%TEMP%` 下，并在 `instFilesPre` 末尾加了一行「压回 `%TEMP%`」的兜底（真身没有）。
- `initMultiUser` 用等价替代：不带 `/allusers|/currentuser`、注册表也没有既有安装，真身的
  `initMultiUser` 必然走 `${else} → setInstallModePerUser`，探针直接调那一支。
- 脚本以文件形式编译（真身是 stdin + `cwd = nsisTemplatesDir`），所以 `multiUser.nsh` /
  `multiUserUi.nsh` / `StdUtils.nsh` / `StrContains.nsh` 一律写绝对路径，避免命中 NSIS 自带的
  `Include\MultiUser.nsh`（那是完全另一套宏）。
- `StartApp` 里的 `$launchLink` 指向 `fake-app.cmd`（写标记文件），不是真的应用 —— 所以本探针
  证明的是「StartApp 被调用了、参数对不对」，不证明真实应用真的能起来。
- `pages.log` 用 `FileOpen "a"` + `FileSeek 0 END`：这只 NSIS 3.04 的 `FileOpen "a"` 不会定位到
  文件尾（隔离试验里三行写完只剩互相压过的残缺内容），必须显式 seek。

## 文件

- `probe.nsi` —— 假安装器脚本（4 页 + 记录设施 + 被测宏）
- `gen-langs.ps1` → `probe-langs.nsh` —— 从 `assistedMessages.yml` 生成的 `LangString` 表
  （只为让 `multiUserUi.nsh` 的 `$(...)` 编得过）
- `run-probe.ps1` —— 编译两只 + 真跑三次 + 记录（含用 `PostMessage WM_COMMAND IDOK` 模拟点击）
- `build\` —— 编译产物（被 gitignore）
- `runs\` —— 每次运行的证据（`pages.log` / `startapp-called.txt` / `summary.json`）
