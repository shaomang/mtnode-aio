# MTNode 应用脚手架（templates/app-scaffold）

**首次开发某个应用时，把本目录整份复制进它的安装子文件夹**（本地开发目录或 `<应用安装根目录>/<id>/` 的对位子目录），
再把占位符替换成该应用自己的名字与实现。它是**源**，不是运行期依赖：应用跑起来后不再引用本目录。

随包分发（`build.json` 的 `files` 已含 `templates/**`），仓库内路径 `templates/app-scaffold/`。

## 文件

| 文件 | 作用 |
| --- | --- |
| `index.html` | 入口：无框窗口骨架、拖动区、降级横幅位、数据文件夹一行、便签示例 |
| `apphost.js` | **宿主桥探测与优雅降级**：同时认 `window.appHost`（应用中心窗口）与 `window.pluginApi`（插件窗口），统一成 `window.AppHost`：`getData` / `setData` / `dataDirGet` / `dataDirPick` / `dataDirOpen` / `dataDirReset` / `storageGet…` / `accountText` / `on` / `onShown` / `offAll` / `onWillClose` / `close` / `quit` |
| `store.js` | **落盘脚手架**：`Store.create({host, file, debounceMs})` → `set(data)` 标脏 + 防抖自动写盘，`load()` 读回，`flush()` 立即写盘；没有宿主时退化为内存态（`store.persisted === false`） |
| `close.js` | **关窗收尾脚手架**：`AppClose.on(cb)` 登记钩子，宿主关窗前（`apps:willClose`）跑完再关；`visibilitychange` / `pagehide` / `beforeunload` 三处兜底冲刷 |
| `app.js` | 最小业务示范：便签落盘（脏标记 + 防抖 + 关窗冲刷）、数据文件夹显示 / 更改 / 打开、关闭按钮 |
| `style.css` | 深色主题样式；`.drag` / `.no-drag` 无框窗口拖动约定 |
| `app.json` | 应用自描述元数据（字段口径对齐云端 `catalog.json` 词条） |

## 三件基础设施（任何应用都要有）

1. **正确关闭**：关闭按钮 → `AppHost.close()`（= 宿主 `apps:closeWindow`）。宿主**不会**直接 `w.close()`，
   而是先发 `apps:willClose`，等应用把 `AppClose.on(...)` 的钩子跑完（上限 1.5s）才真关；
   主程序退出（`before-quit`）走的也是同一条。所以「写盘 + 退订」挂在 `AppClose.on` 里就够了。
   `AppHost.quit()` 是「连 MTNode 一起退出」，只有真需要才用。
2. **内容落盘**：只走 `Store`（内部是 `AppHost.getData` / `setData`），数据落 **`<数据目录>/apps-data/<id>/data.json`**
   （默认数据根；2MB 上限、原子写）。**不要写 localStorage**（`file://` 下来源不稳），**更不要写应用安装目录**
   （升级 / 卸载会带走，启动体检还会报警）。
3. **数据文件夹**：`AppHost.dataDirGet()` 拿当前落点、`dataDirPick()` 让用户亲自选（**只有用户点过、系统目录框里选的那一次生效**，
   应用传不了路径）、`dataDirOpen()` 在资源管理器中打开、`dataDirReset()` 回默认位置。换目录**不搬旧数据**，
   原目录内容原样留着；宿主只允许写「默认数据根 + 用户选过的那个文件夹」，别的路径一律拒绝。

## 复制后要做的替换

1. `app.json`：`id`（= 目录名 = catalog 词条 id）、`title` / `subtitle` / `icon` / `description`、`version`、`minAppVersion`、`window` 尺寸。
2. `index.html`：`<title>`、`#appTitle`、`#appSub`、页脚文案、图标字符。
3. `app.js`：把便签逻辑换成真实实现；`state` 的形状与落盘的 `data.json` 保持一致。
4. 需要更多宿主能力时，只往 `apphost.js` 的 `cap` 表里加**已探测**的方法，别直接假设接口存在。

## 契约（照做，别省）

- 纯静态 HTML/JS/CSS，**没有 Node、没有 `window.api`**；资源一律相对路径。
- **本身不依赖 appHost**：桥缺席（浏览器直接打开 `index.html`、旧版宿主、桥被裁剪）时仍要能启动
  （内存态 + 明确提示），禁止白屏 / 抛异常。
- 落盘只走 `Store` / `AppHost.*`；**不写应用目录**，不把 token / 密钥写进数据文件。
- 应用只做前端：**模型 API 与 MTNode 工具不在应用窗口里**。要内建 LLM / 图像 / 语音能力，升级为本地后端插件
  （见技能 `mtnode-plugin-dev`，主进程用 `dsh/mtnode-llm-creds.js` 复用设置里的模型 Key）。
- 无框窗口必须自带关闭按钮（脚手架已接 `AppHost.close()`）。

完整规范见内置技能 `mtnode-app-dev`（`mtnode-agent-skills/app/app-dev/SKILL.md`）。