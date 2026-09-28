# MTNode · Microsoft Store（MSIX）打包与提审手册

本文只写 **`scripts/release.mjs` 与 `scripts/msix/*` 的实际行为**（读码口径，不含推测步骤）。
改脚本请同步改本文；版本号真源是仓库根 `version` 文件（`x.y.z`），本文不写死当前版本。

- 包身份三要素（`identityName` / `publisher` / `applicationId`）等账号级常量集中在
  [`scripts/msix/msix.config.json`](../scripts/msix/msix.config.json)，**不散落进命令行**。
- 主脚本 [`scripts/msix/make-msix.mjs`](../scripts/msix/make-msix.mjs)、磁贴资产
  [`scripts/msix/make-assets.mjs`](../scripts/msix/make-assets.mjs)。
- NSIS 更新通道（electron-updater / OSS `updates/`）另见 [`scripts/UPDATES.md`](../scripts/UPDATES.md)。

## 1. 一条链与几个入口

**发版纪律（AGENTS.md 协作约定）：一次发版必须同时出 NSIS 安装包与 Store（MSIX）包，两包版本号必须一致。**

| 命令 | 实际执行 | 产物 |
| --- | --- | --- |
| `npm run release` | `scripts/release.mjs`：① 版本校验（根 `version` ↔ `package.json`，不一致直接退出）→ ② `npm run dist`（electron-builder `--win`）→ ②b 校验 `dist/latest.yml` ↔ 根 `version` → ③ `make-msix.mjs --skip-build` → ④ `stage-updates.mjs` → ⑤ 另存 `.msix` + 打印上传指引 → ⑥ `release-git.mjs`（审计漏传 → `git add -A` → 敏感复查 → commit「发布 vX.Y.Z（源码同步…）」→ tag → push origin） | `dist\updates-publish\`（NSIS 更新通道）+ `dist\msix-publish\`（Store 包）+ 源码入库 |
| `npm run release:store` | 同上 `--store-only`：版本校验 → `make-msix.mjs`（自己跑构建）→ 另存 + 指引 → `release-git.mjs`。**不**跑 NSIS 打包、**不**跑 `stage-updates` | `dist\msix-publish\` + 源码入库 |
| `node scripts/release.mjs --dry-run` | 只做版本一致性校验并打印将执行的步骤顺序，不构建 / 不打包 / 不上传 / 不提交（`dist/latest.yml` 存在时顺带校验它） | 无 |
| `npm run release -- --no-git` / `--no-push` | 跳过第 ⑥ 步源码入库 / 只本地提交不推远端 | 同上（按开关变化） |
| `node scripts/release-git.mjs --dry-run` | 只做漏传审计 + 打印将提交文件的分类统计，不改任何 git 状态 | 无 |
| `npm run dist:msix` | 单跑 `make-msix.mjs`：含 `electron-builder --win --dir`（等价 `npm run compile`，走 `dsh/after-pack.cjs` 剪枝） | `dist\<identityName>-<版本>-x64.msix` |
| `npm run dist:msix:sign` | 加 `--selfsign`：自签同 CN 测试证书，**仅供本机试装，不要上传** | 同上（已签名） |
| `npm run dist:msix:test` | 加 `--install-test`：隐含 `--selfsign`，并打印证书受信与 `Add-AppxPackage` 步骤 | 同上 |

`make-msix.mjs` 按序执行的十步（`--skip-build` 只影响第 ③ 步）：

1. 探测本机 Windows SDK 的 `makeappx.exe` / `signtool.exe`（全程离线，不下 kits）
2. 校验包身份（`msix.config.json`），把根 `version` 换算成包版本、**第 4 段强制 0**
3. 构建应用内容 `electron-builder --win --dir --config build.json --publish never` → `dist\win-unpacked`
4. 清空 `dist\msix\layout` 工作区
5. 生成磁贴资产（交给 `make-assets.mjs`，全部**不带 scale 限定名**）
6. 生成 `AppxManifest.xml`（`runFullTrust` + `Windows.FullTrustApplication`）
7. 组装包布局 `layout\app`（junction / symlink 一律解引用成真实文件）
8. `makeappx pack /d layout /p <包> /o /h SHA256`
9. 自检：`makeappx unpack` 反向解包，回读断言身份 / 资产 / 文件数 / 体积（见 §4）
10. 可选签名（默认**不签** —— 上传 Store 不需要签名，微软认证后会用官方证书重签）

其它开关：`--out <path>`、`--version <x.y.z[.r]>`、`--sdk-bin <dir>`、`--dump-manifest`（只把清单打到标准输出，不落盘不打包）、`--no-verify`、`--keep-verify`、`--sign-pfx <path>`、`--timestamp-url <url>`。

**为什么不用 electron-builder 的 `appx` 目标**：它会去 CDN 下载 `windows-kits-bundle`（离线不可靠）、发布者名要从签名证书反推、产物扩展名固定 `.appx`、资产缺省用它的示例图。本链用本机已有 SDK 工具链，Store 专属约束（保留产品名 / 发布者 CN 逐字符一致 / 版本末段必须为 0）显式可控。

**边界**：零依赖（只用 Node 内置模块 + 本机 `makeappx` / `signtool` / PowerShell 自签证书）；只出 **x64 单包**，不做 arm64、不做 `.msixbundle` 多架构分包；不改 `build.json` 的 NSIS 链，也不改版本号真源。

## 2. 包身份与清单

`msix.config.json` 是 JSONC（与 `build.json` 同款去注释解析）。字段的取值位置：**Partner Center → 应用身份/属性 → 「包标识」**；应用信息 → 名称/说明；属性 → 「兼容性 / Windows 版本要求」。

| 字段 | 硬校验（`loadConfig()`，不合规直接退出） | 写进清单哪里 |
| --- | --- | --- |
| `identityName` | ASCII（禁中文）+ `/^[A-Za-z][A-Za-z0-9.]*$/` | `<Identity Name>`；= 保留产品名后系统给的包名，**不是**商店显示名 |
| `publisher` | ASCII + `/^CN=[A-Za-z0-9.,="()& -]+$/`，且不含单引号（否则无法安全传给 PowerShell 建证书） | `<Identity Publisher>`；须与上传账号发布者证书 Subject **逐字符**一致（个人 / 未认证组织账号是一串 GUID，属正常） |
| `applicationId` | ASCII + `/^[A-Za-z0-9._-]{1,64}$/` | `<Application Id>`；决定 AUMID `<identityName>!<applicationId>`，改动会让已装用户的快捷方式与通知通道失效 |
| `executable` | ASCII + `/^[A-Za-z0-9._ -]+\.exe$/` | `<Application Executable>` = `app\<executable>`；必须 = `build.json` 的 `win.executableName + ".exe"`，否则装完启不来（打包后会打印 `win-unpacked` 里实际的 exe 名） |
| `minVersion` / `maxVersionTested` | 四段版本号，且 `maxVersionTested ≥ minVersion` | `<TargetDeviceFamily Name="Windows.Desktop">`；与 Partner Center「Windows 版本要求」两处必须一致 |
| `languages` | 每项匹配 `/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/` | `<Resources><Resource Language>` |
| `capabilities` | 每项匹配 `/^[A-Za-z][A-Za-z0-9.]*$/` | `<Capabilities>`；受限能力（含 `runFullTrust`）走 `rescap:Capability` 命名空间，其余用默认命名空间 |
| `displayName` / `description` | 非空字符串（**唯一允许中文的展示字段**） | `<Properties>` 与 `<uap:VisualElements>`；显示名要与 NSIS 快捷方式名（`build.json` `nsis.shortcutName`）一致 |
| `publisherDisplayName` | 非空字符串 | `<Properties><PublisherDisplayName>`（面向用户，可与证书主题不同） |
| `backgroundColor` | 非空字符串 | `<VisualElements BackgroundColor>` 与 `<uap:SplashScreen BackgroundColor>`、占位图底色 |

清单还固定写 `<Application EntryPoint="Windows.FullTrustApplication">`，`IgnorableNamespaces="uap rescap"`，并注明「由 `scripts/msix/make-msix.mjs` 生成，请勿手改；改身份/文案改 `msix.config.json`」。

能力三项的必要性：`runFullTrust`（Electron 主进程需完整信任并拉起本地后端子进程）、`internetClient`（出方向访问模型 API 与 `mt-agent.com`）、`privateNetworkClientServer`（`net_recv` / `net_send` 与本地后端宿主在 localhost 监听并回连）。

**磁贴资产 7 个**（`make-assets.mjs` 纯 Node 手写 PNG 编码，按目标尺寸以 34 逻辑格参数化重绘、整数吸附，不放大位图）：`Square44x44Logo.png`、`Square150x150Logo.png`、`Square71x71Logo`→`SmallTile.png`、`Square310x310Logo.png`、`Wide310x150Logo.png`、`SplashScreen.png`（620x300，透明底）、`StoreLogo.png`。文件名**一律不带** `.scale-*` / `.targetsize-*` 限定符 → 不需要 `resources.pri`，也不需要 `makeappx /l`。每个文件写出后立即回读校验 PNG 签名、IHDR 尺寸与 RGBA8。

生成清单后脚本会逐个检查清单引用的文件是否真在磁盘上（`app\` 查 `win-unpacked`，`assets\` 查 layout），缺一个就报错退出。

## 3. 上传与版本规则

本节先讲**包版本与拖包上传**，再登记**提审用的隐私政策 URL**（§3.1）与 HTTPS 升级待办（§3.2）。

**包版本与上传**

- 版本真源 = 根 `version` 文件；读不到才退回 `package.json` 的 `version`（`--version` 可覆盖）。
- **Store 保留包版本第 4 段（revision），必须为 0**：`x.y.z → x.y.z.0`；传了非 0 的第 4 段会被强制改 0 并告警。
- 上限 `[255, 255, 65535, 65535]`，任一段超出即报错。`version` 与 `package.json` 不一致时本脚本只告警并用 `version` 换算 —— 但 `npm run release` 会**硬拦**（步骤 ① 与 ②b），所以别绕开发版主链。
- 升版统一 `node version.js bump`（`bump-major` 递增第二位并归零末位，`npm run version:major` 同义），**不要手改** `version` / `package.json`。
- 产物默认名 `dist\<identityName>-<包版本>-x64.msix`；`release.mjs` 按 `*-<x.y.z>.0-x64.msix` 取最新的一个，清掉 `dist\msix-publish\` 里的旧 `.msix` 后另存进去。
- NSIS 包同期产物为 `dist\MTNodeAIO-Setup-<x.y.z>.exe`（`build.json` 的 `nsis.artifactName`）；两包同源于同一个根 `version`。

上传（**本链不做自动上传，只能人工拖进上传框**）：

1. Partner Center → 你的应用 → **包（Packages）**
2. 点「添加新包」，把 `.msix` 直接拖进上传框（*Drag your packages here …*）或 browse your files 选中它 —— 不需要改名、不需要压缩、不需要自己签名（上传框也接受 `.msixupload` / `.appx`）
3. 核对「属性 → 包标识」的 Name / Publisher 与 `msix.config.json` **逐字符**一致
4. 提交后回「包」页看云端认证报告；**版本号只能升不能降**

### 3.1 隐私政策 URL（提审必填 · 唯一真源）

Microsoft Store 提审要求一个公开可访问的隐私政策 URL。该 URL 的**唯一登记处就是本节**，其它地方（README、商店后台、Partner Center）只复制、不再各写一份。政策正文的每条断言以 [`docs/privacy-data-inventory.md`](privacy-data-inventory.md)（代码 + 服务器实测清单）为唯一依据。

- 正文源文件（中英两版，单文件自包含）：`web/privacy/index.html`、`web/privacy/en/index.html`
- 云端落盘目录（nginx `alias`）：`/var/www/mtnode/privacy/`
- 上传目标目录（`scripts/upload-privacy.py` 的 `REMOTE`）：`/var/www/mtnode/privacy` —— 与 `alias` 必须是同一个路径，两处拼错位就打不开
- 重跑方式：`npm run deploy:privacy`，即
  `python scripts/upload-privacy.py --upload-only && python scripts/upload-privacy.py --patch-only`
  （先 sftp 上传整目录 + `chmod -R a+rX`，再经 SSH 跑 `scripts/patch-nginx-privacy.py` → `nginx -t` → `systemctl reload nginx`；`nginx -t` 失败用 `.conf.bak-privacy` 还原）

**提审 URL**（整行复制，不要手加 `index.html`、不要改成别的路径）：

```
http://mt-agent.com/mtnode/privacy/
```

英文版线上地址：`http://mt-agent.com/mtnode/privacy/en/`。两页互链用相对路径（中文页 `./en/`、英文页 `../`，回下载页 `../../`），拼上部署基址后必须正好等于上面两个 URL —— 回归由 `test/smoke-privacy-page.js` [10] 钉住。

nginx 侧必须是**带 `^~` 的前缀 location**（`scripts/patch-nginx-privacy.py` 的 `MARKER` 逐字为此，插到「# === MTNode AI编排器 下载页」注释之前，幂等）：

```nginx
location ^~ /mtnode/privacy/ {
    alias /var/www/mtnode/privacy/;
    default_type text/html;
    add_header Cache-Control "no-cache";
}

location = /mtnode/privacy {
    return 302 /mtnode/privacy/;
}
```

`^~` 不是可选项：服务器上 `/mtnode/**` 未被本地 location 覆盖时，会被一条**正则** location 以 `proxy_pass https://mtnode-download.oss-cn-beijing.aliyuncs.com/…` 转给阿里云 OSS（见 `docs/privacy-data-inventory.md` §3.7）。nginx 的正则 location 优先级高于普通前缀匹配，缺 `^~` 时隐私页请求会打到 OSS 并返回 OSS 侧的结果（响应头带 `x-oss-request-id`，页面上不会出现政策正文）。加上 `^~` 后，该前缀一命中就不再评测正则。`alias` 与 `location` 都以 `/` 结尾是本家族的写法约定。

上传脚本会自检两个 URL（目录页 + 无斜杠 302）、断言 `Content-Type: text/html` 且**无** `Content-Disposition`（下载页那段带 hide 头，本 location 不写任何下载头），并确认无斜杠路径 302 到 `/mtnode/privacy/`。凭据沿用发布链约定（`E:\dev\mt-ai-router\.vscode\sftp.json`，或环境变量 `MTNODE_SFTP_JSON` / `MTNODE_SSH_*`）。

政策写作三条红线（清单 §7，政策页与文档都不得违反）：不得写「不收集任何个人信息」；不得写「全程加密传输」；不得把「可选账号」写成「无账号体系」（创意工坊 / 讨论区有可选账号且**无自助注销**，必须给出可执行的删除请求渠道）。联系渠道只有 GitHub Issues `https://github.com/shaomang/mtnode-aio/issues` —— 仓库内不存在任何邮箱，不得编造。

### 3.2 HTTPS 升级前置（升级后待办）

**现状：`mt-agent.com` 仅监听 80 端口，443 未监听**（`docs/privacy-data-inventory.md` §3.7 的 `ss -lntp` 实测）。因此本节以上一律按 `http://` 登记，README、政策页与 Partner Center 都**不得**提前写 https 地址（写了就是给审核员一个打不开的链接）。

真正升级到 HTTPS 之后（`npm run deploy:ssl` → `scripts/deploy-ssl.py`；证书材料按 `.gitignore` 只放本机 `ssl/`，一律不入库），才依次做：

1. 政策页与 nginx 加 301 跳转，把 `https://mt-agent.com/mtnode/privacy/` 与 `https://mt-agent.com/mtnode/privacy/en/` 作为新规范地址，两页互链保持不变；
2. 回填本文 §3.1 登记的提审 URL，并在 Partner Center「隐私政策」框里换成 https；
3. 同步 `README.md`「数据与隐私」小节的链接（该处断言「README 不出现尚不存在的 https 链接」由 `test/smoke-privacy-page.js` 钉住，改本文措辞时记得一起改断言）；
4. 重跑 `npm run deploy:privacy` 与 `node test/smoke-privacy-page.js` 复核。

## 4. 自检、签名与本机试装

**解包自检**（默认开，`--no-verify` 可跳；不建议）：用 `makeappx unpack` 把刚封好的包反解到 `dist\msix\verify`，只相信包本身，逐项断言：

- `<Identity>` 的 Name / Publisher / Version / ProcessorArchitecture 与配置和包版本一致；第 4 段确为 0
- 清单含 `EntryPoint="Windows.FullTrustApplication"` 与 `runFullTrust` 能力
- 清单里每个文件引用都能在包里找到（资产名与主程序逐字对齐）
- `layout` 里的**每个**文件都真的进了包（锁文件 / 读失败的条目 `makeappx` 可能静默丢掉）
- 体积：≥ 1MB（否则判异常）、≤ 16GB（Store 单包上限）；> 4GB 会告警（个别分发/镜像通道受限）
- 失败时保留解包现场便于排查；通过时默认删除该目录（约 420MB），`--keep-verify` 可留

**签名**：上传 Store **不需要**签名（微软认证后重签）。

- `--selfsign`：用 PowerShell `New-SelfSignedCertificate` 在 `Cert:\CurrentUser\My` 建 / 复用同 CN 测试证书（CN 必须与 `publisher` 完全相同），导出 `.cer`，`signtool sign /fd SHA256 /sha1 <指纹>`。该包**只能本机试装，不要上传**。
- `--sign-pfx <path>`：正式代码签名证书，口令取环境变量 `MSIX_PFX_PASSWORD`（未设则按无口令尝试并告警），默认加时间戳 `http://timestamp.digicert.com`（`--timestamp-url none` 关闭）。签后跑 `signtool verify /pa`，本机校验不过多为缺根 / 中间证书，不影响上传。
- 两者都需要 `signtool.exe`（完整 Windows SDK，或 `--sdk-bin` 指到含它的目录）。

**本机侧载试装**（只有自签包需要；商店正式包由 Store 负责安装）：

1. 管理员 PowerShell 让证书受信（一次即可）：`Import-Certificate -FilePath <cer> -CertStoreLocation Cert:\LocalMachine\TrustedPeople`，同样再导一份到 `Cert:\LocalMachine\TrustedRoot`；并开启 设置 → 更新和安全 → 开发者选项 → 「侧加载应用」
2. 安装：`Add-AppxPackage <msix>`
3. 查看 / 启动：`Get-AppxPackage -Name <identityName>`；`Start-Process "shell:AppsFolder\<identityName>!<applicationId>"`
4. 卸载：`Get-AppxPackage -Name <identityName> | Remove-AppxPackage`，完事删掉受信证书条目（测试证书在 `Cert:\CurrentUser\My`）

**Store 包不做应用内自更新**：`updater.js` 以最高优先级判定 Store / MSIX 运行环境（`process.windowsStore`、容器注入的 `APPX_PACKAGE_*` / `MSIX_PACKAGE_*` 环境变量、exe 路径落在 `WindowsApps`），命中则**整条自更新链不启动**（不加载 electron-updater、不设更新源、不发检查请求、绝不静默安装 —— 包目录只读且违反商店政策），渲染层据此隐藏「更新」入口并提示走商店。

## 5. 常见报错与处置

| 现象 | 根因与处置 |
| --- | --- |
| 上传报「无效的软件包标识名称 / 系列名称 / 发布者名称」三连 | `identityName` 或 `publisher` 与 Partner Center「属性 → 包标识」不逐字符相同。只改 `msix.config.json` 一处再重封；**包系列名称** = `<identityName>_<发布者哈希>`，后段由 Publisher 算出，本机离线不可推算，别手填 |
| `未在本机找到 Windows SDK 的 makeappx.exe` | 装 Visual Studio 的「Windows 10/11 SDK」组件（或独立 Windows SDK）；默认查找 `C:\Program Files (x86)\Windows Kits\10\bin\<版本>\x64`，多版本取最高，也可 `--sdk-bin` 直指 |
| `未找到 signtool.exe` | 同上：要签名就得装完整 SDK，或用 `--sdk-bin` 指定含它的目录 |
| 包安装后无法启动 | `msix.config.json` 的 `executable` 与 `build.json` 的 `win.executableName` 不一致；改 `executable`（清单里 exe 走 `app\` 相对包根路径） |
| 清单引用的路径在磁盘上不存在 | 资产名与 `make-assets.mjs` 产出、或主程序与 `win-unpacked` 没逐字对齐；先看 `--dump-manifest` 的清单文本 |
| `makeappx` 报 reparse point / 打包莫名失败 | MSIX 不接受 junction / symlink。`stepLayoutApp()` 已一律解引用（用 `realpath` 去环），悬空或循环链接会跳过并告警 —— 别改用 `robocopy`：它默认把 junction 当链接原样带走 |
| 路径过长类奇怪失败 | 接近 `MAX_PATH(260)`（阈值 245）时脚本自动加 `\\?\` 前缀；工作目录超过 90 字符会告警，建议项目放更短的盘符路径下 |
| `自检未通过：有 N 个布局文件没进包` | 多为文件被占用 / 杀软拦截；关掉占用后 `--skip-build` 快速重封 |
| 版本被判不符 / 发版中途退出 | 根 `version` ↔ `package.json` ↔ `dist/latest.yml` 三者必须一致；先 `node version.js`（只读并同步 package.json）或 `node version.js bump`，再重跑 `npm run release`。任一步失败即非零退出，不会留下半截发布 |
| 隐私政策链接审核不过 | 回 §3.2：URL 是否整行等于提审地址、`^~` location 是否真在 conf 里、443 是否仍未监听（未监听就只能写 http） |

## 6. 相关约定（改链前先读）

- **数据不落应用文件夹**：MSIX 包目录（`Program Files\WindowsApps\`）只读，用户数据一律在 `%APPDATA%\pipeline-console`。口径见 `AGENTS.md` 与 `docs/fact-library.md` §一 / §六。
- **不要新增自动上传**：Store 包进 Partner Center、NSIS 包进 OSS `updates/` 都是人工步骤（脚本只打印指引）；发布流程只在 `scripts/` 里走，别在别处自创。
- 回归：隐私页与其部署链由 `node test/smoke-privacy-page.js` 钉住（含本文 §3 的 URL / location / 章节骨架断言）；网关与 MSIX 无关的 dsh 契约见 `dsh/DESIGN.md`。
