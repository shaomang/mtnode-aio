---
name: mtnode-app-dev
title: MTNode 应用开发
description: 开发 MTNode「应用」（顶栏「应用中心」下载 / 自建后独立窗口运行，或「插件」对话框里 kind=window 的窗口类应用）：静态 HTML/JS/CSS 契约（本身不依赖 appHost 也能跑）、两套宿主桥的能力清单与调用样例（应用中心 window.appHost · 插件窗口 window.pluginApi：数据落盘、数据文件夹、账号摘要、创意工坊请求、图片选择与缓存、生命周期事件）、三件基础设施（正确关闭的数据冲刷握手 / 内容落盘与自动迁移 / 数据文件夹）、应用目录结构与 app.json 字段、桌面外壳与运行时能力（模型 API / 工具）的正确接法、常见坑（iframe 无 window.api、sandbox 与 file:// 资源路径、数据只写数据目录）。配套脚手架 templates/app-scaffold/。
---

# MTNode 应用开发

MTNode 里的「应用」＝一份**静态** HTML / JS / CSS，由宿主用独立窗口装载，并注入一座**白名单能力桥**。两种窗口宿主：

| 宿主 | 桥（window 上的名字） | 谁来装 | 数据落点 |
| --- | --- | --- | --- |
| **应用中心**（顶栏「应用」；用户自建 / 云端下载） | **`window.appHost`**（`preload-app.js` + `apps-store.js`） | `apps-store.js` `openAppWindow`，`loadFile` 应用安装根目录 `<id>/` 的入口页 | `<数据目录>/apps-data/<id>/data.json`（可在窗口里改） |
| 插件窗口（「插件」对话框里 `kind: "window"` 的卡片） | `window.pluginApi`（= `window.forumApi`，`plugins/preload-window.js` + `plugins/main-app-plugins.js`） | 插件宿主，解包到 `<数据目录>/app-plugins/<id>/runtime/` | `<数据目录>/app-plugins/<id>/data.json` |

**新写应用优先照「应用中心」那一套**（脚手架的主路）；插件窗口那套的接口差异见第二节的对照表，脚手架 `apphost.js` 会自动探测两套，写一套代码两边都能跑。

本技能管这两种窗口应用。带本地后端 + 控制台窗 + 画布节点的插件（music3 / h3 / tts / llama / …）见 `mtnode-plugin-dev`，两者不要混。

所有结论来自当前仓库真实代码，**唯一真源**：`preload-app.js` + `apps-store.js`（应用中心桥与宿主）、`plugins/preload-window.js`（插件窗口桥）、`build.json`（打包白名单）。与代码冲突时以代码为准，并回来修订本文件。

**脚手架**：`templates/app-scaffold/`（随包分发，`build.json` 的 `files` 已含 `templates/**`）＝ 首次开发某个应用时**复制进它的源码目录**的源，占位符替换即得最小可用应用；
里面四件套：`apphost.js`（桥探测与降级）、`store.js`（脏标记 + 防抖存盘 + flush）、`close.js`（关窗收尾注册）、`app.js`（业务示范）。
新建应用的**默认欢迎页**在 `templates/app-default/index.html`（`apps-store.js` 的 `defaultPageHtml()` 读它），与脚手架同一套设计语言与同一段上手文案。

**界面设计先按 impeccable 规范**：动手写应用界面（默认页 / 脚手架 / 任何窗口页）之前，先加载 `mtnode-agent-skills/app/impeccable/`（`SKILL.md` 入门，`reference/craft-floor.md` 是底线，`reference/operate.md` 讲产品界面）；项目里若已有 `PRODUCT.md` / `DESIGN.md` 就先读它们，改完用该技能的检测器自查一遍。

---

## 一、应用契约（四条硬线）

1. **纯静态**：只有 HTML / JS / CSS（+ 图标、字体、json 数据等静态资源）。没有 Node、没有 `require`、没有 `import` 主程序模块。
   `index.html` 用**相对路径**引用同目录资源（`./style.css`、`./app.js`、`./assets/…`）。
2. **本身不依赖 appHost**：`window.appHost` / `window.pluginApi` **都可能不存在**（用浏览器直接打开 index.html、旧版本宿主、桥被裁剪）。
   应用必须在**没有任何 appHost 的情况下仍能启动并可用**：数据退回内存、功能按能力缺失降级、界面明确告知而不是白屏或抛异常。
   优先只调用 `typeof host.x === "function"` 判过的能力（脚手架 `apphost.js` 的 `window.AppHost.cap` 已把这层包好）。
3. **内容要落盘**：存档只走桥（应用中心 `dataWrite` / 插件窗口 `dataSet`），**不要**用 `localStorage` 当存档、**不要**往应用目录写文件；
   自动存盘（脏标记 + 防抖）+ 关窗前强制冲刷是默认姿势（脚手架 `store.js` + `close.js`，见第三节）。
4. **需要后端 / 模型 / 文件能力时才调 appHost，且必须优雅降级**：没有对应接口时不假装成功、不静默丢数据。
   appHost 是**白名单桥**，只暴露第二节列出的那些方法；**没有的接口就是没有**，不要发明（见第六节）。

窗口内的运行环境事实（`openWindowPlugin` 固定）：`contextIsolation: true`、`nodeIntegration: false`、`sandbox: false`；
`setWindowOpenHandler` 只把 http/https 交给系统浏览器，其余一律 deny；`will-navigate` 阻止离开本页。

---

## 二、appHost 能力清单（两套桥对照）

不要假设还有 `window.api`（那是**主窗口**渲染层的桥，应用窗口里没有）。

| 能力 | 应用中心窗口 `window.appHost`（`preload-app.js`） | 插件窗口 `window.pluginApi`（= `window.forumApi`） |
| --- | --- | --- |
| 应用 id | `id`（宿主按发送方窗口认应用，应用侧拿不到别人的） | `id`（`--mtnode-plugin-id=` 注入，取不到是 `""`） |
| **数据读写（整份）** | `dataRead({file?})` → `{ok,data,file,migrated}`；`dataWrite(data,{file?})` → `{ok,bytes}` | `dataGet()` → `{ok,data}`；`dataSet(data)` → `{ok}` |
| **数据文件夹** | `dataDirGet()` → `{ok,dir,root,def,exists,file,allow}`；`dataDirPick()`（用户亲自选）；`dataDirOpen()`；`dataDirReset()`（回默认） | —（路径由宿主管，应用看不到） |
| 键值存储（老写法） | `storageGet/Set/All/Remove`（内部走同一个 `data.json` 的 `kv`） | —（用 `dataGet`/`dataSet` 自己存对象） |
| 账号摘要 | `account()` → `{ok,loggedIn,user,encryption}`（无 token） | `authGetState()` / `authMe()` / `authLoginPassword` / `authChangePassword` / `authLogout` / `onAuthChanged(cb)` |
| 创意工坊请求 | —（应用中心窗口没有网络面） | `storeRequest({method,path,json,anon})`（主进程持 token） |
| 选图 / 压图 / 缓存 | — | `pickImage()` / `compressImage()` / `cacheImage(id,base64)` / `readCachedImage(id)` |
| 模型能力（可选） | `textGenStream(opts, cb)` / `imageGen(opts)`（**服务商与 Key 只留主进程**，应用只能给 prompt / messages / 温度） | —（见第六节的正路） |
| **生命周期** | `close()`（关自己窗口）· `quit()`（连 MTNode 一起退）· **`onWillClose(cb)`**（关窗前收尾，见第三节） | `close()` · `onShown(cb)` · `onAuthChanged(cb)` |

调用前一律先探测：`typeof host.dataWrite === "function"`，缺就走降级分支。**脚手架的 `window.AppHost` 把两套桥统一成一套名字**
（`getData`/`setData`/`dataDir*`/`storage*`/`accountText`/`request`/`on`/`onShown`/`onWillClose`/`close`/`quit`），新应用照它写即可。

**调用样例**（先探测、再调用、失败不炸）：

```js
/* 脚手架统一层：两套桥都认，缺能力自动降级 */
const H = window.AppHost;

/* 数据落盘：带脏标记 + 防抖 + 关窗冲刷（store.js） */
const store = window.Store.create({ host: H, file: "data.json", debounceMs: 400, initial: { notes: [] } });
await store.load();            // 启动读回（老 storage/store.json 首次读会自动迁移过来）
store.set({ notes: notes });   // 改完标脏，防抖后自动写盘
store.flush();                 // 想立刻落盘时手动调
if (!store.persisted) showBanner("本次数据不会保存");   // 桥缺席：内存态 + 明确提示

/* 数据文件夹：显示 / 打开 / 让用户改 */
const info = await H.dataDirGet();          // { ok, dir, root, def, exists }
// info.dir 显示给用户；info.def=false 说明是用户改过的地方
await H.dataDirPick();                      // 弹系统目录框（只有用户亲自选的那一次生效）
await H.dataDirOpen();                      // 在资源管理器中打开
await H.dataDirReset();                     // 回默认数据根（只删指针，不删文件）

/* 账号摘要（两套桥都走这一个名字） */
const line = await H.accountText();         // "未登录" / 昵称 / "未接入宿主"
```

**生命周期 / 事件**：窗口 `ready-to-show` 与 `did-finish-load` 后宿主会 show 并置顶（应用中心窗口还会按需发 `apps:windowChanged`）。
事件订阅**都返回退订函数**，应用在收尾时退订（见第三节），避免重复绑定。

---

## 三、三件基础设施（每个应用都要有）

### 3.1 正确关闭（关窗 = 先请应用收尾，再关）

宿主 `close()` **不会**直接销毁窗口，而是：

```
按钮 → host.close() → 主进程 closeAppWindow(id) → webContents.send("apps:willClose")
     → 应用把所有收尾动作跑完 → ipcRenderer.invoke("apps:ackClose") → 主进程 w.close()
     （应用忘了回包 / 卡住：WILL_CLOSE_MS = 1500ms 到点直接关，绝不钉住窗口）
```

主程序退出（`before-quit` → `shutdownApps()`）走的**同一条**；`quit()`（连 MTNode 一起退）也是先让该应用收尾，再请主进程正常退出。

应用侧要做的就一件事：**把「写盘 + 退订」挂进收尾钩子**（脚手架 `close.js`）：

```js
window.AppClose.on(() => Promise.all([store.flush(), Promise.resolve(H.offAll())]));
```

`close.js` 还挂了 `visibilitychange(hidden)` / `pagehide` / `beforeunload` 三处兜底冲刷（主程序被强杀时最后一道闸），
但**主路是 willClose 握手**：只有它会等在飞的那次写盘完成。

### 3.2 内容落盘（默认数据根）

- 默认落点：`<数据目录>/apps-data/<id>/data.json`（`apps-store.js` 的 `appDataRoot`）。**不跟应用安装目录走** —— 升级 / 卸载不带走数据。
- 形态：整份 JSON，**原子写**（tmp + rename），整份上限 `2MB`（超了回 `{ok:false,error:"应用数据超出上限（2MB）"}`）。
- 文件名白名单：`data.json`（老名字 `store.json` 兼容）；**不许带分隔符 / `..` / 盘符**（`normDataFileName` 会拒）。
- **老数据自动迁移**：首次读时若 `data.json` 不在、而应用安装目录里的 `<id>/storage/store.json` 在，
  宿主自动把它迁到默认数据根（旧文件保留、不删）；只在「还没有 data.json」时搬，且**只搬默认数据根**，绝不动用户另选过的文件夹。
- 撤写白名单：只有「默认数据根 + 用户亲自选过的文件夹」是合法落点（`dataAllowList`），别的路径一律拒绝。

### 3.3 数据文件夹（用户可改）

- 默认 = 默认数据根；用户可以在**应用窗口里**（`dataDirPick()`）或**应用中心「库」页那一行**改。
- 路径**只能来自用户在系统目录框里亲自选的那一次**：`dataDirPick` 是宿主自己弹的框，应用（与 agent）传不了路径；主进程侧 `pickAppDataDir` 无宿主窗口直接拒绝。
- 改完**不搬数据**：新目录当场生效（没有就建），旧目录文件原样留着；「恢复默认」只删指针（`dataDir.json`），也不删文件。
- 指针存 `<数据目录>/apps-data/<id>/dataDir.json`：选在根内记**相对名**（换数据目录 / 换机器仍认），选在根外记绝对路径；落在应用目录里 / 盘根一律不认（回落默认数据根）。
- 应用中心那一行还有状态徽标：「自定义位置」「还没写过数据」，以及打开 / 更改… / 恢复默认三个动作。

---

## 四、应用目录结构

```
<应用 id>/                        zip 根；应用中心的源码目录 / 插件窗口解包后到 runtime/
  index.html                      入口（app.json 的 entry，默认 index.html；宿主只认 .html）
  apphost.js                      桥探测与优雅降级（脚手架四件套之一；两套桥都认）
  store.js                        内容落盘：脏标记 + 防抖自动存盘 + flush()
  close.js                        关窗收尾：AppClose.on(cb) 登记，宿主关窗前跑完
  app.js                          逻辑
  style.css                       样式
  app.json                        自描述元数据（下节；离线 / 本地开发 / 发布自检用）
  assets/…                        图标 / 图片 / 字体 / 静态 json
```

宿主机上落点（**应用自己不要写这些路径**，只能通过 appHost 间接读写）：

```
应用中心这套：
  应用安装根目录/<AppName>/                源码目录（升级 / 卸载 = 整目录替换，别往里写数据）
  <数据目录>/apps-data/<id>/data.json      应用数据（默认数据根；dataRead / dataWrite 的落点）
  <数据目录>/apps-data/<id>/dataDir.json   数据文件夹指针（用户改过才有）

插件窗口这套：
  <数据目录>/app-plugins/<id>/             默认 %APPDATA%\pipeline-console\app-plugins\<id>\
    runtime/                                解包后的应用静态文件（升级 = 整目录替换）
    installed.json                          宿主写的安装元数据
    data.json                               appPlugins:dataGet / dataSet 的落点
```

**本地开发目录建议**：直接把应用源码放在一个普通文件夹里（如 `apps/<id>/`），目录名与 `app.json` 的 `id` 保持一致；
应用中心「开发」页可以直接把这个目录当预览源（`mtnode-preview://<id>/<entry>`），改完刷新即见。

---

## 五、`app.json`：应用自描述元数据

`build.json` 的 `files` 已含 `templates/**`，脚手架 `templates/app-scaffold/app.json` 是范本。字段口径**对齐云端目录词条**
（`plugins/catalog.default.json` → `normalizePlugin`），**当前宿主不读 app.json**：真正生效的窗口参数与卡片信息来自云端
`catalog.json` / 本地 `catalog.default.json`。app.json 的用途是：让 zip 自描述、本地开发时一眼看清契约、发布打 zip 前做校验。

```jsonc
{
  "id": "my-app",                       // 必填，^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$，必须与目录名 / catalog 词条 id 一致
  "kind": "window",                     // 窗口类应用固定 "window"（KNOWN_KINDS 白名单里有它）
  "entry": "index.html",                // 入口，必须 .html，仓库内相对路径，不含 .. 与盘符
  "version": "1.0.0",                   // 应用版本（与 catalog 词条、installed.json 比对更新）
  "minAppVersion": "1.2.0",             // 需要的最低 MTNode 版本；宿主低于它时卡片按「请更新应用」处理（可省）
  "title":    { "zh": "我的应用", "en": "My App" },        // 卡片标题
  "subtitle": { "zh": "一句话说明", "en": "One-liner" },   // 卡片副标题
  "icon": "my-app.png",                 // 图标名：1:1 PNG，发布放 plugins/icons/<id>.png（可省，缺省 <id>.png）
  "window": {
    "width": 380, "height": 520,        // 被夹到 280–1200 / 320–1200；缺省 380x520
    "minWidth": 280, "minHeight": 320,  // 可省
    "frame": false,                     // 默认 false：无系统标题栏，关闭按钮要自己做
    "transparent": true,                // 默认 true：窗口透明，自己画圆角背景
    "alwaysOnTop": true,                // 默认 true
    "skipTaskbar": true                 // 默认 true：不在任务栏留按钮
  },
  "description": "给用户看的一段说明（可省）",
  "permissions": ["storage", "account"] // 可选：自述用到的 appHost 能力，便于发布前审查
}
```

窗口位置由宿主固定贴在**主窗口右侧**（`pluginRightBounds`，工作区右边距 16px、垂直居中），应用**不能**指定坐标。

---

## 六、桌面外壳与运行时能力（模型 API / 工具）的正确接法

**事实（别猜）**：窗口里的应用**拿不到模型 API，也拿不到 MTNode 的工具**。

- appHost 是白名单桥，只有第二节那些方法；**没有** `chat` / `complete` / `generateText` / `generateImage` 之类的接口。
- 主窗口渲染层的 `window.api`（`preload.js`）里有 `storeRequest`、`auth*` 等，**应用窗口里不存在** `window.api`。
- `storeRequest` 只能打到创意工坊服务端（`store-saas/`）的既有路由：账户（`/api/login`、`/api/me`、`/api/auth/*`）、
  工坊（`/api/templates*`、`/api/skills*`、`/api/tags`）、讨论区（`/api/forum/*`）、钱包（`/api/wallet/*`）、管理端。
  **服务端没有 LLM 补全路由**，不要按 `/v1/chat/completions` 写代码。
- 应用窗口里也**跑不了 dsh**（那是主进程 / 智能节点的事），不能 `require`、不能起子进程。

所以「应用里要模型 / 要生成」只有三条正路：

| 需求 | 正解 |
| --- | --- |
| 纯提示词 / 文案工具 | 应用内拼好提示词：`openExternal` 或写入剪贴板让用户丢给全局助手；或把「生成」做成**画布工作流**（`proc_text` / `proc_image` / 智能节点），应用只做前端 |
| 应用必须有内建 LLM / 图像 / 语音能力 | 升级为**本地后端插件**（见 `mtnode-plugin-dev`）：主进程宿主用 `dsh/mtnode-llm-creds.js` 的 `resolveDshRunAuth(getDataDir())` **复用 MTNode 设置里的模型 Key** 调模型，再由控制台 preload 暴露给界面 |
| 需要联网能力但服务端还没有 | 先在服务端补路由（`store-saas/server.mjs`），应用再用 `storeRequest` 调；服务端没路由前，应用只能降级提示 |

一句话：**应用 = 前端外壳；模型与工具留在主程序 / 画布一侧**。

---

## 七、常见坑

| 坑 | 后果 | 正解 |
| --- | --- | --- |
| 在应用里访问 `window.api`（主窗口的桥） | 永远 `undefined`，功能全哑 | 应用窗口只有 `window.appHost`（应用中心）或 `window.pluginApi` / `window.forumApi`（插件窗口） |
| 只认 `window.pluginApi`、不认 `window.appHost` | 在应用中心窗口里功能全哑（没有 `dataGet`） | 用脚手架的 `apphost.js` 统一探测；新代码优先按 `appHost` 那套写 |
| 关了窗口最后一条内容没了 | 直接 `close()` 而没冲刷未落盘的内容 | 把 `store.flush()` 挂进 `AppClose.on(cb)`（`close.js` 已挂，主进程还会等 1.5s） |
| 以为 `close()` 会等你写完 | 实际宿主发 `apps:willClose` 等你回包 / 超时才关；不登记钩子就是「立刻走」 | 收尾只写在 `AppClose.on` / `onWillClose` 里，别只写 `beforeunload` |
| 往应用安装目录写数据 | 升级 / 卸载整目录替换带走数据，启动体检还会报警 | 数据只走 `dataWrite` / `dataSet`（默认数据根 `<数据目录>/apps-data/<id>/`） |
| 自己拼数据文件路径 / 想写别的文件名 | 宿主白名单只认 `data.json`（+ 兼容 `store.json`），越界一律拒绝 | 走 `dataDirGet()` 拿路径显示，写入交给宿主（固定文件名 + 原子写） |
| 应用自己传一个目录当数据文件夹 | 宿主不认（路径只能来自用户在系统目录框里亲自选的那一次） | 让用户点「更改」→ `dataDirPick()`；应用只显示 `dataDirGet()` 的结果 |
| 以为改数据文件夹会顺手搬数据 | 走神：**不搬**（新目录当场生效，旧文件原样留着） | 需要搬就在切换前自己读出来、切完写回去（脚手架示范：先 `flush()` 再切） |
| 把宿主对象传进 `<iframe>` / 子框架 | iframe 里 **没有** appHost（桥只注入顶层文档） | 别跨框架传引用：由顶层调 appHost，再把结果 `postMessage` 给 iframe |
| 忘了探能力就 `await host.dataWrite(...)` | appHost 缺席时抛异常 / 白屏 | 一律 `typeof host.x === "function"` 先判，缺能力走降级分支 |
| 用 `fetch('./data.json')`、XHR 读本地文件 | `file://` 下被拦，读不到 | 静态数据直接写进 JS（`const DATA = {...}`）或做成 `<script>` 引入 |
| 资源写成绝对路径 / `<base href="/">` | 换机器、打包后 404 | 全部相对路径（`./app.js`、`./assets/a.png`） |
| 把 token / 密钥写进 `data.json` | 明文落盘、便于泄露 | 凭据只走宿主的 `account` / `authGetState`（token 只留主进程），应用侧一个字节都不落 |
| 把 localStorage 当存档 | 窗口 `file://` 下 localStorage 来源不稳（清缓存 / 换路径即丢） | 存档走 `store.js`（内部 `dataWrite` / `dataSet`） |
| 假设窗口大小 / 位置可自定 | 被宿主夹到合法区间；插件窗口位置固定在主窗口右侧 | 用 `minWidth` / `minHeight` 声明下限，布局自适应 |
| `frame:false` 却没做关闭按钮 | 用户关不掉应用（只能关主程序） | 画自己的关闭按钮 → `host.close()` |
| `onShown` / `onAuthChanged` 不退订 | 重开窗口重复绑定、回调叠加 | 保存返回的退订函数，收尾钩子里调（脚手架挂进 `AppClose.on`） |
| 以为窗口就是 `app.json` 里的尺寸 | 实际生效的是云端 catalog 词条（app.json 只是自描述） | 发版时同步 catalog 词条的 `entry` / `version` / `window` |
| app 目录没进打包白名单 | 打包后目录为空 | `build.json` 的 `files` 里加 `app/**`（或实际目录名）；仓库新增顶层目录必查 |

---

## 八、交付清单

- [ ] 目录：`<id>/index.html` + `apphost.js` + `store.js` + `close.js` + `app.js` + `style.css` + `app.json`（从 `templates/app-scaffold/` 复制后替换占位符）
- [ ] 契约：**无 appHost 也能跑**（`window.appHost` / `window.pluginApi` 都缺时降级分支可达：内存态 + 界面明确提示）
- [ ] 资源全相对路径；静态数据内联；`frame:false` 时自带关闭按钮接 `close()`
- [ ] **正确关闭**：写盘 + 退订挂进 `AppClose.on(cb)`（宿主 `apps:willClose` 等它跑完，上限 1.5s）
- [ ] **内容落盘**：数据只走 `store.js` / `dataWrite`（默认数据根 `apps-data/<id>/data.json`），不用 localStorage、不写应用目录
- [ ] **数据文件夹**：窗口里能显示当前落点、能让用户改（`dataDirGet` / `dataDirPick` / `dataDirOpen`），换目录不搬数据
- [ ] 应用侧不落凭据；账号摘要走 `accountText()` / `account()` / `authGetState()`
- [ ] 事件 `onShown` / `onAuthChanged` 都退订
- [ ] `app.json` 字段与云端 catalog 词条一致（`id` / `entry` / `version` / `window`）
- [ ] 发布：打 zip（根目录就是应用目录）→ 上传 → `catalog.json` 词条补 `zipUrl` + `sha256` + `entry` + `window`
- [ ] `build.json`：若把应用放进了新的顶层目录，`files` 补 `"<目录>/**"`
- [ ] 手工验证：安装 / 更新 → 打开窗口 → 改一条内容 → **关掉再开（内容还在）** → 改数据文件夹（数据跟着走、旧目录还在） →
      拔掉 appHost（浏览器直接打开 index.html）仍可用 → 数据在 `<数据目录>/apps-data/<id>/data.json`
- [ ] 一行回归：`node test/run-all.mjs apps`（`test/smoke-apps.js` 的 [8] 段钉着数据根 / 指针 / 白名单 / 关窗握手）