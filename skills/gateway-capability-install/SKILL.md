---
name: gateway-capability-install
title: 网关可选能力按需安装（浏览器自动化 / 原生协议 SDK / Markdown 渲染链 / sharp wasm）
description: 安装包按能力组剪掉了四簇「本部署用不到」的网关依赖（browser-automation 68.75MB、cloud-native-llm 30.75MB、markdown-render、sharp-wasm，见 docs/app-size-audit.md §8 与 docs/app-deps-capability.json）。当 Agent 遇到 `Cannot find package '@anthropic-ai/sdk' / '@google/genai' / 'playwright' / '@img/sharp-wasm32' / '@shikijs/*'`，或用户要启用 dsh 浏览器自动化、要选 Anthropic / Google 原生协议时用本 skill：按 pi-ai / sharp 声明的**精确版本**把包装回**网关树自己的 node_modules**，真 import 一次验证，并说清「重装应用会覆盖」这条边界。含自我修复与回滚口径。
---

# 网关可选能力 — 按需安装 / 修复

安装包为了体积，把四簇「本部署从不加载」的网关依赖按**能力组**剪掉了（判定与清单见
`docs/app-size-audit.md` §8 与 `docs/app-deps-capability.json`，剪枝在打包时由
`dsh/after-pack.cjs` 经 `scripts/app-deps-rules.cjs` 按组执行）。

| 组 key | 是什么 | 剪掉的体积 | 缺它时的现场 |
| --- | --- | --- | --- |
| `browser-automation` | dsh 的浏览器自动化 / 计算机使用插件簇：`playwright` · `playwright-core` · `@playwright/mcp` · `chrome-devtools-mcp` · `@trycua/cua-driver(-win32-x64-msvc)` · `@browserbasehq/*` · `@deepseek-ai/dsh-{experimental-browser-use,experimental-computer-use}-*` | 68.75 MB | 挂载 `dsh-experimental-browser-use-*` 后报 `Cannot find package 'playwright'` / `'chrome-devtools-mcp'` |
| `cloud-native-llm` | pi-ai 的**原生协议**适配器 SDK：`@google/genai` · `@anthropic-ai/sdk` | 30.75 MB | 选到走原生协议的 Anthropic / Google 服务商时报 `Cannot find package '@anthropic-ai/sdk'`（OpenAI 兼容链路不受影响） |
| `markdown-render` | dsh web 前端的 Markdown / 公式渲染链 `@shikijs/*` · `katex` · `vscode-textmate` · `vscode-oniguruma` | 0 MB（当前树上已无） | `dsh --profile web` 渲染 Markdown 报缺包（MTNode 不用这个 profile） |
| `sharp-wasm` | `@img/sharp-wasm32`，sharp 的 wasm 兜底 | 0 MB（当前树上已无） | 只有 `@img/sharp-win32-x64` 加载失败时才走到，报 `Cannot find package '@img/sharp-wasm32'` |

## 关键前提（先读，否则会白装一遍）

1. **网关只从自己的树里解析包**：`<安装目录>\resources\dsh\gateway\node_modules`
   （dev 态 = 仓库的 `dsh/gateway/node_modules`）。所以「装到 `%APPDATA%\pipeline-console\...` 再指过去」
   这条路**对这四个组不成立** —— 它们没有 office 引擎那种「cli 路径写回 cordis.yml」的配置位。
   （用户数据仍然一律不落应用目录；这里装的是网关的**程序依赖**，不是用户数据。）
2. **重装 / 升级应用会覆盖网关树**，装回去的包会再次消失。要**持久**启用，正确做法是改仓库：
   从 `scripts/app-deps-usage.mjs` 的 `CAPABILITY_GROUPS` 里删掉那个组（或删对应名字）→
   `npm run deps:cap` → `npm run deps:check` → 重新打包。本 skill 处理的是「不重打包、先把能力救回来」。
3. **版本必须跟声明方一致**，不要装 latest：pi-ai 与 sharp 都是按精确版本声明/解析的（见下表）。

| 包 | 装哪个版本 | 谁声明的 |
| --- | --- | --- |
| `@google/genai` | `2.21.0` | `@earendil-works/pi-ai` 的 dependencies |
| `@anthropic-ai/sdk` | `0.129.0` | `@earendil-works/pi-ai` 的 dependencies |
| `playwright` / `playwright-core` | `1.63.0-alpha-2026-08-31` | dsh 的 browser-use 试验插件（两者必须同版本） |
| `chrome-devtools-mcp` | `1.9.0` | dsh-experimental-browser-use-chrome-devtools-mcp |
| `@playwright/mcp` | `0.0.80` | dsh-experimental-browser-use-playwright-mcp |
| `@trycua/cua-driver` | `0.28.0`（win32-x64 另需 `@trycua/cua-driver-win32-x64-msvc` 同版本） | dsh-experimental-computer-use-cua-driver-native |
| `@browserbasehq/sdk` / `@browserbasehq/stagehand` | `2.21.0` / `4.1.0` | dsh-experimental-browser-use-stagehand-native |
| `@img/sharp-wasm32` | 与 `sharp` 同版本（当前 `0.35.5`） | sharp 代码里按名解析的兜底 |
| `@shikijs/*` / `katex` | 与 dsh 内置前端同版本（先看 dsh 的补丁层/模板声明的范围） | dsh web 前端 |

> 表里的版本 = 本次剪枝时的实测值（`dsh/gateway/node_modules/<pkg>/package.json`）。
> dsh 升级后版本会变：**先读声明方**（`node -e "console.log(require('<网关>/node_modules/@earendil-works/pi-ai/package.json').dependencies)"`），别照抄本表。

## 步骤

1. **定位网关树**：`<安装目录>\resources\dsh\gateway`（有 `gateway.mjs` + `cordis.yml` 的那个目录）；
   dev 态是仓库的 `dsh/gateway`。下面的命令里记作 `%GW%`。
2. **先探存量**：`Test-Path %GW%\node_modules\@anthropic-ai\sdk`（或对应包）。
   在 → 跳到第 5 步验证；不在 → 第 3 步。
3. **装包**（只装缺的那几个，别一次装整簇）：
   ```
   npm install --prefix "%GW%" --no-save --no-audit --no-fund --registry=https://registry.npmmirror.com @anthropic-ai/sdk@0.129.0
   ```
   - `--no-save`：**不要**改网关树的 `package.json` / 锁文件（那是 dsh 的，改了下次升级会冲突）。
   - 国内镜像优先（口径见 `docs/mirror-sources.md` 与仓库根 `cn-mirrors.js`）；只有镜像站本身挂了才回退
     `https://registry.npmjs.org`，不要改用户机器上的 `.npmrc`。
   - 装在 `Program Files` 下需要管理员权限；没有权限就说明「装不进安装目录」，走第 2 条前提里的仓库改法。
   - `playwright` 装完**不要**跑 `npx playwright install`（那会往磁盘再下几百 MB 浏览器内核）；
     dsh 的这几个插件用的是本机已装的 Edge/Chrome。确实需要内核时先问用户。
4. **接线**（只在必要时）：
   - `cloud-native-llm`：不需要改 `cordis.yml` —— pi-ai 的 `*.lazy.js` 壳在，包一在就能被解析。
     只有用户真要选原生协议服务商时才需要把服务商配到 `anthropic-messages` / `google-generative-ai`。
   - `browser-automation`：dsh 的这簇插件**默认不挂载**（MTNode 的 `browser_*` 工具面由
     `./browser-plugin.mjs` 提供，与它们无关）。要用必须自己在 `dsh/gateway/cordis.yml` 加 `insert` 行，
     加之前先确认包已在（第 5 步），否则网关启动即 `ERR_MODULE_NOT_FOUND`。
   - `markdown-render` / `sharp-wasm`：无接线动作。
5. **真 import 验证**（只 `Test-Path` 不算验证；在 `%GW%` 目录里跑，让解析就从这棵树开始）：
   ```
   node --input-type=module -e "import('@anthropic-ai/sdk').then(m=>console.log('ok',Object.keys(m).length)).catch(e=>{console.error('FAIL',e.message);process.exit(1)})"
   ```
   把 `@anthropic-ai/sdk` 换成实际装的那个包名，逐个跑一遍。
6. **网关冒烟**：真起一次网关确认没被弄坏（比 import 更硬）——在仓库里跑 `node dsh/smoke-gateway.mjs`
   （打包态就先把它拷到 `resources/dsh/` 旁边，再在那个目录里跑）。
   期望 `exit 0`，status / pluginList / run / shutdown 全通。
7. **收尾回报**：装了哪些包与版本、`%GW%` 绝对路径、每条的 import 结果、冒烟退出码；
   并明确写一句「重装应用会覆盖，持久启用要改能力组重打包」。

## 自我修复

| 现象 | 先查 | 处理 |
| --- | --- | --- |
| `npm install` 报 `EPERM` / `EACCES` | `%GW%` 是否在 Program Files 下 | 没有写权限：让用户以管理员重试，或改走「删能力组 + 重打包」 |
| 装完仍 `Cannot find package X` | `%GW%\node_modules\X` 在不在；包名大小写 | 包装到了别的目录（例如 `--prefix` 指错，装进了 cwd）；`node -e "console.log(require.resolve('X'))"` 从 `%GW%` 里跑一次看解析到哪 |
| 网关起不来，`ERR_MODULE_NOT_FOUND` | `cordis.yml` 新加的行引用的包在不在 | 先注释掉那行（宁可不挂，也不要让网关起不来），再补装 |
| 原生协议报 401 / 模型不认 | 服务商 baseURL 与协议口径 | MTNode 的服务商设置默认走 OpenAI 兼容；要用原生协议得把 provider 指到 `anthropic-messages` / `google-generative-ai`，这是设置层的事，不是装包的事 |
| `playwright` 报「Executable doesn't exist」 | 是否漏了浏览器内核 | **先问用户**是否要下内核（`npx playwright install chromium`，几百 MB）；能用本机 Edge/Chrome 就别下 |
| 重装应用后能力又没了 | 网关树被覆盖 | 预期行为，见「关键前提」第 2 条 |

## 回滚

- 只是临时试：`npm uninstall --prefix "%GW%" --no-save <包名>`，或直接删 `%GW%\node_modules\<包名>`
  （别删 `package.json` / 锁文件，它们本来就不该被改）。
- 要回到「安装包默认的瘦身状态」：把上表那几簇包删掉即可 —— 安装包默认就是没有它们的。
- 要**改变默认**（让它们随包发布）：从 `scripts/app-deps-usage.mjs` 的 `CAPABILITY_GROUPS` 删组 →
  `npm run deps:cap` → `npm run deps:check` → 重打包。
