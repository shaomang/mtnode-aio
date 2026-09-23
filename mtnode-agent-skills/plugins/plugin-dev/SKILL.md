---
name: mtnode-plugin-dev
title: MTNode 插件开发规范
description: MTNode 应用插件（catalog 窗口插件 / builtin / 本地后端插件）的开发规范：插件类型与边界、后端插件三层结构（主进程宿主 · 预加载桥 · 控制台 UI）、主进程与渲染层接线点、build.json 打包白名单、画布节点与 i18n / 指南 / 冒烟交付清单、报错总线与自我修复、数据目录纪律，含最小骨架与常见坑。新建或改造 MTNode 插件（顶栏「插件」对话框里那个东西）时按需加载。
---

# MTNode 插件开发规范

本技能是**仓库内部开发纪律**（不写 `menu: user`，不进用户技能清单）：新建 / 改造 MTNode 应用插件时照着做。
所有结论来自当前仓库真实代码；与代码冲突时**以代码为准**，并回来修订本文件。

---

## 一、先把边界划清

MTNode 里「扩展能力」有**四种完全不同的东西**，别混为一谈：

| 东西 | 是什么 | 契约出处 |
| --- | --- | --- |
| **应用插件**（本技能管的） | 顶栏「插件」对话框里的卡片：窗口插件、pet、以及带本地后端 + 控制台 + 画布节点的 music3 / yue2 / sensenova / h3 / llama / tts / remotion / asr | `plugins/catalog.default.json`、`plugins/main-app-plugins.js`、各 `*/main-*.js` |
| DSH 插件 | Agent 网关侧插件（工具能力） | `dsh/gateway/*-plugin.mjs`、`dsh/DESIGN.md` |
| 技能 Skills | Agent 的按需指令集 | `mtnode-agent-skills/**`、`skills/**`（安装类）、`ext-repo/skills/**`（云发版） |
| MCP 扩展 | 外部 MCP server 接入 | `renderer/app-plugins.js` 的 `EXT_KINDS` + `#extManagerDlg` |

后三类都在「设置 → 扩展能力 → 管理…」里维护（`EXT_UI`）；**应用插件卡片只在顶栏「插件」对话框**，两者不要互相塞。
本技能只讲第一类。

---

## 二、实例登记表（当前真实在库的插件）

| 插件 id | kind | 主进程目录 | 控制台入口 | 画布节点 | 打包脚手架 |
| --- | --- | --- | --- | --- | --- |
| `minimax-music3` | music3 | `music3/main-music3.js` | `music3/ui/index.html` | `music_gen` | `music3-pack/` |
| `yue2-local` | yue2 | **`yue/main-yue.js`** | `yue/ui/` | `yue_gen` | `yue-pack/` |
| `sensenova-local` | sensenova | `sensenova/main-sensenova.js` | `sensenova/ui/` | `sensenova_gen` | `sensenova-pack/` |
| `minimax-h3` | h3 | `h3/main-h3.js` | `h3/ui/` | `video_gen` | `h3-pack/` |
| `llama-local` | llama | `llama/main-llama.js` | `llama/ui/console.html` | （做模型服务，无媒体节点） | `llama-pack/` |
| `tts-local` | tts | `tts/main-tts.js` | `tts/ui/console.html` | `tts_gen` | `tts-pack/` |
| `asr-local` | asr | `asr/main-asr.js` | `asr/ui/index.html` | 接音频输入即转写（无独立节点） | `asr-pack/` |
| `remotion` | remotion | `remotion/main-remotion.js` | `remotion/ui/index.html` | `remotion` | `remotion-pack/` |
| `bongochat` | pet | `pet/main-pet.js` | 独立宠物进程 `--mtnode-pet` | — | `pet-pack/` |
| `forum` | builtin(window) | `plugins/main-app-plugins.js` 的 `BUILTIN_WINDOW_PLUGINS` | 应用内 `forum/chat.html` | — | `forum/**` 直接打包 |

**坑（必记）**：目录名 ≠ kind ≠ id。YuE2 的目录叫 `yue/`、pack 叫 `yue-pack/`，但 kind 是 `yue2`、id 是 `yue2-local`。
新插件起名时**目录、pack、kind、id 四处都写清楚**，别靠猜。

---

## 三、三类插件的形态

1. **窗口插件（kind: `window`）**：一个 zip（入口 `index.html` + 宿主 `plugins/preload-window.js`），云端 `catalog.json` 里带 `zipUrl` + `sha256`，用户点「下载安装」后解到 `<数据目录>/app-plugins/<id>/runtime/`。不动主程序即可上新。
2. **builtin**：随应用内置（当前只有讨论区 `forum`），`BUILTIN_WINDOW_PLUGINS` 里写死 `dir / entry / window`，不走下载链。
3. **本地后端插件（八类 kind）**：主进程宿主 + Python/Node 后端 + 控制台窗 + 画布节点。**本技能的重点**，见下。

`KNOWN_KINDS`（`plugins/main-app-plugins.js`）是白名单：**新 kind 不加进去，卡片会被降级成 `unknown`，按钮与控制台入口全失效。**

---

## 四、后端插件的共同结构

```
<kind 目录>/                       例：music3/
  main-<name>.js     主进程宿主：安装编排 / 起停后端 / 生成 / 控制台窗 / IPC / 报错上报
  preload-<name>.js  控制台窗的能力桥（contextBridge.exposeInMainWorld）
  ui/index.html      控制台界面（无框架原生）
  ui/ui.js  ui/ui.css
  [可选] tray-main.js / preload-tray.js  托盘常驻（llama / tts 有）
  [可选] <name>-workflows.js             后端工作流适配（h3）
<name>-pack/         随包脚手架：app/ scripts/ requirements.txt manifest.json start_backend.cmd README.md
```

数据流（一条生成任务的全链）：

```
画布节点（renderer/app-nodes.js）
  → window.api.<kind>Generate(...)                     preload.js 白名单桥
    → ipcMain.handle("<kind>:generate")                宿主 main-*.js
      → 全局音视频互斥锁 media-gen-global-lock.js
      → spawn 后端 / HTTP 调后端（detached 单例，通常不随 MTNode 退出）
      → 落盘到应用资产目录（素材 / 资产），返回 { ok, path }
    ← 渲染层刷节点状态
失败 → reportErr(code, message, { phase, nodeId }) → plugin-error-repair.js
     → 主窗口弹报告 → 「🤖 自动修复」→ 按 skills/<id>-install 的【自我修复】模式开会话 → 成功自动 restart()
```

---

## 五、五层接线点（新插件一个都不能漏）

1. **catalog**：`plugins/catalog.default.json` 加词条（`id` / `kind` / `handler` / `order` / `version` / `minAppVersion` / `icon` / `title{zh,en}` / `subtitle{zh,en}`），`order` 决定卡片顺序（现用 20/30/35/36/40/50/60/65/70）。
2. **主进程白名单**：
   - `plugins/main-app-plugins.js` → `KNOWN_KINDS`（把新 kind 加进去）；若 kind 与 handler 不同名，`normalizePlugin` 里的 handler 兜底链也要补一条；
   - `build.json` → `files`：`<kind 目录>/**` 与 `<pack 目录>` 的 extraResources 条目（见第八节）。
3. **main.js 接线**：`require("./<dir>/main-<name>.js")` → 在 `app.whenReady` 段 `register<Name>Ipc({ getDataDir: DATA, getMainWin: () => mainWin, appRoot: __dirname, getDsh: () => dsh() })`，紧跟在 `initPluginErrorBus({ getMainWin: () => mainWin })` 之后；`app.on("before-quit")` 里补 `shutdown<Name>UiOnly()`。
   - **后端要不要随 MTNode 退出**：单例后端（music3 / h3 / yue / sensenova）**故意不杀**，只在 before-quit 关控制台窗；asr 随 MTNode 退出（`shutdownAsr()`）。新插件必须在两处注释里写明选了哪种、为什么。
4. **preload.js 桥**：`window.api.<kind>Xxx` 白名单转发（`ipcRenderer.invoke('<kind>:…')`），事件订阅（`onXxxProgress` / `onXxxConsoleChanged` / `onXxxGpu`）返回退订函数。渲染层拿不到桥 = 卡片与节点全是「未就绪」。
5. **渲染层卡片**：`renderer/app-plugins.js` → `refresh<Name>PluginCard(root)` + `bind<Name>Progress(card)`，并在 `openAppPluginsDialog()` 的 `kind === "<kind>" || handler === "<kind>"` 链里挂一行（顺序无所谓，但要和 `attachInstalled` / catalog 词条一致）；卡片动作按钮的图标只能取 `PLUGIN_ACT_SVG`（`play` / `stop` / `download` / `update` / `gear`）——**表里没有的 kind 必须先补图标，否则按钮渲染成没有图标的空方块**。
   封面图标放 `plugins/icons/<id>.png`（1:1），加载顺序 `plugins/icons → renderer/plugin-icons`。

---

## 六、画布节点接线

- 节点类型在 `renderer/app-nodes.js` 里实现，命名用 kind 短名（`music_gen` / `yue_gen` / `tts_gen` / `video_gen` / `remotion` / `sensenova_gen`）。
- **节点运行前先判插件就绪**：后端没装 / 没起时给明确中文指路（去顶栏「插件」装或起），不要只报「生成失败」。
- 宿主返回的错误码要在节点状态行 + 插件卡片 + 报错报告三处口径一致（同一串 code，渲染层按串匹配文案）。
- 关联回归：`test/smoke-media-gen-menu.js`（菜单与节点归属）、`test/smoke-tools.js`、`test/smoke-plugin-repair.js`。
- **新增节点类型必须补指南** `guides/nodes/<kind>.md`，并登记进 `guides/nodes/index.json`；面向用户的操作说明进 `guides/manual/`（如 `media-gen.md`）。

---

## 七、数据与目录纪律

- 用户数据**只写** `%APPDATA%\pipeline-console`（`main.js` 的 `DATA`，由 `getDataDir()` 传进宿主）或**用户自己选的安装目录**。
  **绝不写进应用目录**（`app.getAppPath()` / exe 同目录）：升级 / 卸载会带走或覆盖，且启动时 `auditAppDirData()` 会体检报警。
- 典型落点：`<数据目录>/app-plugins/<id>/{config.json,installed.json,data.json,runtime/}`（宿主自己 `path.join(getDataDir(), …)`）。
- 打包资源（`*-pack/`）运行时落 `<resources>/<xxx>-pack`，安装时由宿主复制到用户选的安装目录，脚手架文件本身**不落应用目录**。
- 密钥 / 凭据只进 `%APPDATA%`，不入库、不提交。
- **运行时热更新**用 `plugins/runtime-feed.js` 的 `fetchRemoteManifest` / `downloadRuntimeTo`（`<kind>Feed` 走 `process.env.MTNODE_<NAME>_URL` 可覆盖，便于本地联调）。

---

## 八、打包清单（最容易漏的一节）

`build.json` 的 `files` 是**显式白名单**，不是整仓拷贝。新插件必须同步：

```jsonc
"files": [
  "<kind>/ **",              // 例："music3/**"、"asr/**"（宿主 + ui + preload）
  "plugins/**",              // 已在
  "mtnode-agent-skills/**", "guides/**", "skills/**"   // 已在（技能 / 指南 / 安装技能）
],
"extraResources": [
  { "from": "<xxx>-pack", "to": "<xxx>-pack",
    "filter": ["app/**","scripts/**","requirements.txt","README.md","start_backend.cmd",".gitignore","manifest.json"] }
]
```

- 根目录新增 / 拆出的**主进程模块**（`*-store.js` / `*-lib.js` / `plugin-error-repair.js` 这类）只要会被 `main.js` 或已打包文件 `require`，**必须写进 `files`**，否则解包运行 `Cannot find module './xxx.js'`（真发生过：`assets-store.js`）。
- `extraResources` 的 `filter` 是正向白名单：**venv、模型权重、依赖锁、`_probe_*.py` 一律不随包**。
- 渲染层新脚本挂进 `renderer/index.html` 的脚本加载顺序（= 模块分层），样式进 `renderer/css/` 对应文件。

---

## 九、报错总线与自我修复（后端类插件必接）

```js
/* main-<name>.js 的 register<Name>Ipc 里注册一次宿主 */
pluginErrors.registerPluginHost({
  id: PLUGIN_ID,                     // 与 catalog id 一致
  name: "插件中文名",                 // 报告标题
  skillName: "<id>-install",         // 修复会话要用的安装技能（skills/<id>-install/SKILL.md）
  getInstallDir: () => loadConfig().installDir || "",   // 修复会话的可写工作区
  tailConsole: (n) => consoleTail(n),                   // 日志尾部（没有日志就留空，只有窗口插件会这样）
  selfRepair: (o) => selfRepairFromConsole(o || {}),
  restart: async () => { await stopBackend(); return startBackend(); },
});
/* 每个失败出口（安装 / 起后端 / 生成 / 卸载）都补一行，包在 try/catch 里，绝不能被报告拖住 */
reportErr(code, message, { phase: "install", nodeId: nid });
```

- 总线行为契约见 `docs/plugin-auto-repair.md`：错误码归一、同插件同码 60s 去抖、可修复性判定 + 一次性 repairToken（10 分钟 TTL）、修复成功自动 `restart()`。
- **不弹修复的错误**（`NOT_REPAIRABLE`）：`cancelled` / `user_stopped` / `force_killed` / `busy*` / `low_disk` 等 —— 交给 Agent 也修不好的，只出报告 + 中文指路。
- 修复技能的**唯一真源**是 `skills/<id>-install/SKILL.md` 的【自我修复】模式：已知故障、交付要件、判据都写那里；别在弹窗文案里再抄一份。
- 窗口插件没有主进程宿主：失败时 `plugins/main-app-plugins.js` 的 `ensureReportHost(id)` 按需登记（现场 = `<数据目录>/app-plugins/<id>`，不注册 `tailConsole`）。
- 回归：`test/smoke-plugin-repair.js`（宿主注册表、技能真源唯一、打包白名单、总线行为、三桥、persistent、i18n、文档存在性）。

---

## 十、配套能力：dsh / 缓存 / 存储

- **用 dsh 跑 LLM**：`getDsh` 由 `main.js` 注入；鉴权用 `dsh/mtnode-llm-creds.js` 的 `resolveDshRunAuth(getDataDir())`（复用 MTNode 设置里的模型 Key），把 `{ model, maxTokens, apiKey, baseUrl, provider, mtnodeProviders }` 塞进 `runFields`。事件回灌：导出 `on<Name>DshEvent(ev)` 并在 `main.js` 的 dsh 事件分发里挂一行。
- **转写 / 生成缓存**：明文 JSON 落插件自己的数据目录（asr 的 `cacheGet/cacheSet/cacheClear` 是范本）。
- **AI 事实库 / 素材库 / 工具库**：走 `db-store.js`、`assets-store.js`、`tools-store.js` 的既有 IPC，**不要**为插件新开一套存储。
- **音视频互斥**：`media-gen-global-lock.js` 的 `tryAcquireLock / refreshStaleLock / clearLock / releaseLock / busyMessage` —— 同时在跑的只有 1 个音视频任务。
- **资产落盘**：宿主拿 `assetDirFor(wfId)` 回调（sensenova 范本）或自己在宿主内落 `<数据目录>/assets/<wfId>`。

---

## 十一、最小骨架（占位符照抄替换）

### 后端插件 · 主进程宿主

```js
"use strict";
/**
 * <中文名> 插件主进程：
 * - 安装目录 / 脚手架 / 安装编排
 * - 后端单例（detached，<随 MTNode 退出 | 不随 MTNode 退出>）
 * - 全局生成锁、GPU 监视、控制台窗
 */
const { BrowserWindow, ipcMain, dialog, screen, app } = require("electron");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const { fetchRemoteManifest, downloadRuntimeTo, verGt } = require("../plugins/runtime-feed.js");
const { tryAcquireLock, releaseLock, busyMessage } = require("../media-gen-global-lock.js");
const pluginErrors = require("../plugin-error-repair.js");

const PLUGIN_ID = "<plugin-id>";                 // 与 catalog.default.json 的 id 一致
const DEFAULT_PORT = 7900;

let getDataDir = null, getMainWin = null, appRoot = null, consoleWin = null, backendProc = null;

function join(...a) { return path.join(...a); }
function mk(p) { fs.mkdirSync(p, { recursive: true }); return p; }
function configPath() { return join(getDataDir(), "app-plugins", PLUGIN_ID, "config.json"); }
function loadConfig() { try { return JSON.parse(fs.readFileSync(configPath(), "utf8")); } catch { return {}; } }
function saveConfig(patch) { mk(path.dirname(configPath())); /* 原子写：tmp + rename */ }

/** 安装目录护栏：只允许用户选定的普通目录，拒绝应用目录 / exe 同目录 */
function isSafeInstallDir(dir) { /* 见 docs/fact-library.md §一 / §六 的口径 */ }

/** 后端单例：detached，退出前先把 pid 记进 config，下次启动用 probe 探活接管 */
async function startBackend() { /* probe → 未起则 spawn(chcp 包里的 start_backend.cmd) → 轮询 /health */ }
async function stopBackend() { /* 只停本插件记录的那个 pid */ }

function uiEntry() { return join(appRoot, "<kind>", "ui", "index.html"); }
function consoleTail(n) { /* 读自己的 console.log 尾部 */ }

function openConsoleWindow() {
  if (consoleWin && !consoleWin.isDestroyed()) { consoleWin.show(); consoleWin.focus(); return { ok: true, open: true }; }
  consoleWin = new BrowserWindow({
    width: 420, height: 640, frame: true, title: "<中文名> · 插件测试中",
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false,
      preload: join(__dirname, "preload-<name>.js") },
  });
  consoleWin.loadFile(uiEntry());
  consoleWin.on("closed", () => { consoleWin = null; notifyConsoleChanged(false); });
  notifyConsoleChanged(true);
  return { ok: true, open: true };
}
function notifyConsoleChanged(open) { /* webContents.send("<kind>:consoleChanged", { open }) 给主窗口 */ }

function reportErr(code, message, extra) {
  try { pluginErrors.reportPluginError(PLUGIN_ID, Object.assign({ code: String(code || ""), message: String(message || "") }, extra || {})); } catch {}
}

async function generate(params) {
  const lock = tryAcquireLock("<kind>", params.nodeId);      // 全局音视频互斥
  if (!lock.ok) return { ok: false, error: "busy_media", message: busyMessage(lock) };
  try { /* 调后端 → 落资产目录 → { ok: true, path } */ }
  catch (e) { reportErr(String(e && e.code) || "generate_failed", String(e && e.message || e), { phase: "generate", nodeId: params.nodeId }); return { ok: false, error: "generate_failed" }; }
  finally { releaseLock("<kind>", params.nodeId); }
}

function register<Name>Ipc(opts) {
  getDataDir = opts.getDataDir; getMainWin = opts.getMainWin; appRoot = opts.appRoot || join(__dirname, "..");
  pluginErrors.registerPluginHost({
    id: PLUGIN_ID, name: "<中文名>", skillName: "<plugin-id>-install",
    getInstallDir: () => loadConfig().installDir || "",
    tailConsole: (n) => consoleTail(n),
    restart: async () => { await stopBackend(); return startBackend(); },
  });
  ipcMain.handle("<kind>:getStatus", async () => statusForUi());
  ipcMain.handle("<kind>:pickInstallDir", async () => pickInstallDir());
  ipcMain.handle("<kind>:install", async (e, o) => installProject(o || {}));
  ipcMain.handle("<kind>:cancelInstall", async () => { installCancel = true; return { ok: true }; });
  ipcMain.handle("<kind>:start", async () => startBackend());
  ipcMain.handle("<kind>:stop", async () => stopBackend());
  ipcMain.handle("<kind>:generate", async (e, p) => generate(p || {}));
  ipcMain.handle("<kind>:open", async () => openConsoleWindow());
  ipcMain.handle("<kind>:close", async () => closeConsoleWindow());
  ipcMain.handle("<kind>:consoleTail", async (e, n) => consoleTail(n));
  ipcMain.handle("<kind>:removePluginMeta", async () => removePluginMetaOnly());
}

/** 按第九节的两选一：单例后端只关控制台窗；随应用退出的后端这里要真停 */
function shutdown<Name>UiOnly() { try { if (consoleWin && !consoleWin.isDestroyed()) consoleWin.close(); } catch {} consoleWin = null; }

module.exports = { register<Name>Ipc, shutdown<Name>UiOnly, PLUGIN_ID };
```

### 后端插件 · 控制台 preload

```js
"use strict";
const { contextBridge, ipcRenderer } = require("electron");
function sub(ch, cb) { const h = (_e, d) => cb && cb(d); ipcRenderer.on(ch, h); return () => ipcRenderer.removeListener(ch, h); }
contextBridge.exposeInMainWorld("<name>Api", {
  getStatus: () => ipcRenderer.invoke("<kind>:getStatus"),
  install: (o) => ipcRenderer.invoke("<kind>:install", o || {}),
  start: () => ipcRenderer.invoke("<kind>:start"),
  stop: () => ipcRenderer.invoke("<kind>:stop"),
  onProgress: (cb) => sub("<kind>:progress", cb),
  onConsole: (cb) => sub("<kind>:console", cb),
  close: () => { try { window.close(); } catch {} },
});
```

### main.js 注册

```js
const { register<Name>Ipc, shutdown<Name>UiOnly } = require("./<dir>/main-<name>.js");
/* app.whenReady 内，initPluginErrorBus 之后 */
register<Name>Ipc({ getDataDir: DATA, getMainWin: () => mainWin, appRoot: __dirname, getDsh: () => dsh() });
/* app.on("before-quit") 内 */
try { shutdown<Name>UiOnly(); } catch {}
```

### 窗口插件（zip）

```
<id>/index.html        入口（其它资源同目录，相对引用；只走 UI，不留任何主进程能力）
<id>/…                 样式 / 脚本 / 图标
```
catalog 词条补 `"kind": "window"`、`"zipUrl"`、`"sha256"`、`"entry"`、`"window": { width, height, frame, transparent, alwaysOnTop, skipTaskbar }`。
preload 由宿主统一注入 `plugins/preload-window.js`；窗口内可用 `appPlugins:dataGet / dataSet` 存取该插件自己的数据（落 `<数据目录>/app-plugins/<id>/data.json`）。

---

## 十二、常见坑

| 坑 | 后果 | 正解 |
| --- | --- | --- |
| 新目录没进 `build.json` `files` | 打包后 `Cannot find module` / 控制台白屏 | 加 `<kind>/**`，pack 加 extraResources 条目 |
| 新 kind 没进 `KNOWN_KINDS` | 卡片降级 `unknown`，按钮与控制台入口全失效 | 补 `KNOWN_KINDS`（+ `normalizePlugin` 的 handler 兜底链） |
| handler 与 kind 不同名 | 卡片分支匹配不上、状态永远「未就绪」 | 渲染层一律写 `item.kind === k \|\| item.handler === k` |
| 用了 `PLUGIN_ACT_SVG` 里没有的图标名 | 按钮渲染成无图标空方块 | 先往表里补 SVG，或用已有 `play/stop/download/update/gear` |
| 往应用目录写数据 / 脚手架 | 升级卸载数据丢失，启动体检报警 | 只写 `getDataDir()` 或用户选定的安装目录 |
| 新增节点没写 `guides/nodes/<kind>.md` | 用户手册缺页，回归不过 | 补指南 + `guides/nodes/index.json` |
| 主进程新模块忘了白名单 | 同上第一条 | 与插件目录一并核对 |
| 后端随 MTNode 退出与否没写明 | 遗留孤儿进程 / 每次开应用重装重跑 | before-quit 与文件头注释都写清（单例 vs 随退） |
| 失败只 toast 不 `reportErr` | 插件窗没开时用户看不到根因 | 每个失败出口补一行 `reportErr` |
| 修复逻辑抄进弹窗文案 | 技能真源分裂，回归 `smoke-plugin-repair` 判失败 | 只留一句指向 `skills/<id>-install` 的【自我修复】模式 |
| 插件卡片加「删除 / 卸载」按钮 | 违反产品口径 | 卡片只有 play / stop（必要时 download / update / gear），卸载留控制台窗内 |

---

## 十三、新建插件交付清单

- [ ] 定名：`id` / `kind` / `handler` / 目录 / `*-pack` 六处一致（或差异有明确注释），`id` 满足 `^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$`
- [ ] 主进程宿主 `main-<name>.js`：安装编排 / 起停 / 生成 / 控制台窗 / IPC / `registerPluginHost` / 每个失败出口 `reportErr`
- [ ] 控制台 `ui/`（HTML+JS+CSS）+ `preload-<name>.js` 白名单桥
- [ ] `plugins/catalog.default.json` 词条（含中英 `title` / `subtitle`、`order`、`version`、`minAppVersion`）+ 封面 `plugins/icons/<id>.png`
- [ ] `plugins/main-app-plugins.js` 的 `KNOWN_KINDS`（+ handler 兜底）
- [ ] `main.js`：`require` + `register*Ipc` + `before-quit` 的 `shutdown*`
- [ ] `preload.js`：`window.api.<kind>*` 桥 + 事件订阅（返回退订）
- [ ] `renderer/app-plugins.js`：`refresh<Name>PluginCard` / `bind<Name>Progress` + `openAppPluginsDialog` 分支
- [ ] 画布节点（如需）：`app-nodes.js` 实现 + 就绪判定 + 错误码口径一致 + `guides/nodes/<kind>.md` + `guides/nodes/index.json`
- [ ] i18n：`renderer/i18n.js` 中英词条齐全（按钮文案 / tooltip / aria-label / 状态文案）
- [ ] `build.json`：`files` 加 `<kind>/**`，pack 加 extraResources 条目；渲染层脚本进 `index.html` 加载顺序
- [ ] `*-pack/manifest.json` + `start_backend.cmd` + `README.md`（脚本里所有落盘路径都指用户安装目录）
- [ ] 报错与修复：`skills/<id>-install/SKILL.md` 的【自我修复】写全（已知故障 / 交付要件 / 判据）
- [ ] dsh / 缓存 / 存储 / 音视频锁：按第十节接
- [ ] 测试：`test/smoke-*.js` 钉住（卡片分支 / 桥 / 打包白名单 / 技能真源 / 节点归属），`node test/run-all.mjs --list` 确认被收集
- [ ] 手工验证：安装 → 起后端 → 控制台可用 → 节点跑通一次 → 停/重启 → 报错弹窗能自动修复 → 用户数据在 `%APPDATA%`
