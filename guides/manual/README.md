# 应用内手册 · 集成说明（帮助中心 / 搜索 / 深链接 / 版本切换 / 暗色）

本文件只记录**代码里能验证**的接入口径，供新增 / 重写手册页时对照。所有行号以当前仓库为准；查不到依据的写 `[待确认]`。

## 1. 帮助中心接入链（页面如何显示出来）

```
顶栏「文档」#btnDocs (renderer/index.html:24)
  → renderer/app-boot.js:521-526       开/关切换：已开 → closeAppDocs()，否则 openAppDocs()
  → renderer/app.js:8812 openAppDocs() 弹窗 = #appDocsDlg（app.js:8475 ensureAppDocsDlg 懒建）
  → window.api.docsCatalog()           preload.js:71 → IPC docs:catalog
  → main.js:412 loadDocsCatalog()      读 <__dirname>/guides/manual/index.json
  → renderer/app.js:8546 renderDocsNav() 左树按 sections[].pages[] 渲染
  → 点页 → app.js:8616 loadDocsPage(id) → docs:load → main.js:355 loadMarkdownPack 读 <id>.md
```

另一入口：设置页「帮助」`renderer/app-settings.js:2428 openHelp()` 直接调 `openAppDocs()`（不预选页）。

**新增一页要满足的全部条件**（缺一不可）：

1. 页面 `id` 已登记进 `guides/manual/index.json` 的 `sections[].pages[]` —— 左树与答疑只遍历 `index.json`，**磁盘上有 `<id>.md` 但没登记 = 应用里看不到、也进不了答疑正文**（`main.js:449-477`）。
2. `id` 只允许 `[a-z0-9_-]`：`main.js:356` 与 `app.js:8619` 都会 `replace(/[^a-z0-9_-]/gi, "")`，其它字符被静默删掉（`_write.mjs` 的 `id` 约定同此，见本文件 §1.5 与 §3）。
3. 中文正文 `guides/manual/<id>.md`；英文正文 `guides/manual/en/<id>.md`（可选）。
4. 图放在 `img/` 下，正文按**打包根**（`guides/manual/`）相对路径写，例如 `![](img/mtnode-start-01-ui.svg)`：不带协议、**不含 `..`**，否则不内联（`main.js` 的 `loadMarkdownPack`：先 `rel.indexOf("..") >= 0` 直接跳过，再按 `join(root, rel)` 校验是否越出 root，最后按扩展名转 data URI）。`en/<id>.md` 同样写 `img/...` —— 解析基准是 root 而不是 `en/`，**写成 `../img/` 反而会被判为越界、图片不内联**。
5. 若走生成器：`guides/manual/_write.mjs` 的 `catalog`（`_write.mjs:320`）是 `index.json` 的唯一真源，重跑会重写 `index.json`（`_write.mjs:406`）——章节 / 页序 / 页 id 只改这一处，再重跑生成器；**正文以磁盘为准**，磁盘上已有的 `<id>.md` 原样保留，重跑不会盖回（`_write.mjs:412` 起，只有缺正文的 id 才写一版兜底模板）。
6. 图同样由生成器出：`_write.mjs` 的 `diagrams`（`_write.mjs:131`）用 `bx / ar / tx / bd / dl / ln` 写成数据、由 `render()` 渲染为 SVG（`_write.mjs:310` 起写盘）。命名口径 `mtnode-{章节}-{序号}-{类型}.svg`，章节 = `start|canvas|flow|agent|share|edit|app`，类型 = `ui|flow|state`（自 2026-09 起只出静态图，不再生成 `-demo` 动效图与 `-static` 回退）。生成器只写清单里列出的图，清单外的旧图不会被自动清理，需要手工删。

### 1.5 本手册与画布「快速开始」的对应（2026-09 口径）

- **内容唯一依据**是画布「快速开始」的说明卡片：分区顺序 = 章节顺序，卡片 = 页内小节；卡片里没有的内容不写，卡片里有的必须落到正文，画布给多少写多少、宁短不编。
- 页骨架：`# 页标题` → `> 一句话目标：`（由该分区的说明改写）→ 图（只有关键页有）→ `## <卡片标题>`（去掉 ①② 序号）→ 卡片内【…】降为 `###`。
- 分区 → 页：1.准备工作 → `providers`；2.内容生成（①文本 ②图像 → `io-proc`，③音乐 ④语音 ⑤视频 ⑥Remotion → `media-gen`，⑦审阅 → `ai-review`，⑧蒙版 → `image-edit`）；3.全局助手与工作流 → `workflows`、`quick-build`（另含 `longtask`：快速开始卡片没有这一页，长周期任务上线后补进本章）；4.开发节点 → `dev-nodes`；5.会话 → `dsh`、`agent-nodes`、`approvals`；6.工具 / 函数节点 → `tools-functions`；7.素材库 → `asset-library`；8.专家团 → `one-person-company`；9.社区 → `community`；其他 → `nodes-wires`、`marks-groups`、`rollback`、`glossary`、`faq`。
- 配图只给 10 个关键页：`providers`(start-01-ui)、`io-proc`(flow-01-ui)、`media-gen`(flow-02-flow)、`ai-review`(edit-01-ui)、`image-edit`(edit-02-ui)、`workflows`(canvas-01-flow)、`quick-build`(agent-01-flow)、`dev-nodes`(app-01-ui)、`agent-nodes`(agent-02-ui)、`tools-functions`(canvas-02-ui)。
- 术语统一用「思考强度」（英文 thinking effort）。

## 2. IPC 契约

主进程三支（`main.js:432-479`），渲染层白名单桥（`preload.js:71-73`）：

| IPC | preload 方法 | 入参 | 返回 |
| --- | --- | --- | --- |
| `docs:catalog` | `docsCatalog()` | 无 | `{ ok:true, catalog }` 或 `{ ok:false, error }` |
| `docs:load` | `docsLoad(id, locale)` | `{ id, locale }` | `{ ok:true, id, markdown, assets }` / `{ ok:false, error:"missing"|"bad id" }` |
| `docs:bundle` | `docsBundle(locale)` | `{ locale }` | `{ ok:true, text, bytes }`，供「答疑」拼 system prompt |

- `docs:load` 的 `locale`：`"en"` 开头走 `en/<id>.md`；**英文页不存在则自动回落中文** `<id>.md`（`main.js:358-368`）。`assets` 是 `{ 原图相对路径: "data:<mime>;base64,…" }`，由 `renderGuideMarkdown`（`app.js:8340`）回填进 `<img src>`。
- 支持的内联图类型：`.svg/.png/.webp/.gif/.jpg/.jpeg`（`main.js:390-401`）。
- `catalog` 结构：`{ defaultPage, sections:[{ id, title:{zh,en}, pages:[{ id, title:{zh,en} }] }] }`；`defaultPage` 缺省回落 `"overview"`（`app.js:8845-8847`）——注意那只是**代码兜底**，现行 `index.json` 里 `defaultPage` 已改为 `"providers"`，共 10 章 22 页，章节顺序与画布「快速开始」的十个分区一一对应（`longtask` 是后补进第 3 章 `assistant` 的第 3 页、`ai-facts` 是后补进第 8 章 `team` 的第 2 页，两张页在快速开始卡片里都没有，前者随长周期任务上线、后者随 AI 事实库上线补进本章），`overview` 已不存在。
- 主进程根目录固定为 `join(__dirname, "guides", "manual")`（`main.js:408-410`），打包后随 asar 携带；**不读用户数据目录、不联网**。

## 3. 页面 id 与 `#id` 深链接

- 文章内 `<a href="#xxx">` 会被 `#appDocsBody` 的 click 代理接住：`ev.preventDefault()` → 过滤出 `[a-z0-9_-]` → `loadDocsPage(id)` 换页（`app.js:8518-8527`）。即 **`#` 后的值被当作「页 id」，不是标题锚点**。
- 没有对 `location.hash` / 启动参数的监听：全仓无 `openAppDocs("#…")` 的外部调用，`openAppDocs(pageId)` 虽带可选参数，但现有两处调用（`app-boot.js:525`、`app-settings.js:2429`）都不传。**因此「用 URL 深链接直达某页」目前不存在 → [待确认]**。
- 标题级锚点（`#某小节`）不支持：`renderMarkdown` 生成的标题不带 `id`；`#foo-bar` 若不对应任何页 id，会走到 `main.js:369` 的 `"missing"`，界面显示「找不到该文档 <code>foo-bar</code>」（`app.js:8630-8638`）。

## 4. 搜索

现状有两条，且都不搜正文：

- **左栏筛选框 `#appDocsFilter`**（`app.js:8513-8517`）：输入即 `renderDocsNav()` 重画左树；匹配范围只有「页标题 + 章节标题 + 页 id」三者拼接后的子串（`app.js:8564-8573`），大小写不敏感。匹配不到显示「无匹配项」。
- **右侧「答疑」**（`app.js:8715 sendDocsAsk`）：首次提问时调 `docs:bundle`，把**整本手册**按 `## 章节 / 页面` 拼成一段文本喂给模型，system prompt 明令「只能根据手册回答、不操作画布」（`app.js:8688 docsSystemPrompt`）。包体上限见下。

`docs:bundle` 的切片口径（`main.js:437-479`）：

- 每页先删掉所有 `![](...)` 图片语法，正文超 **4500 字**截断加 `…`；
- 全文总量上限 **80000 字**，超限即停止后续页；
- 只遍历 `index.json` 已登记的页。

**正文全文检索（含高亮 / 结果列表）当前不存在**；要做需改渲染层（本轮范围外）→ [待确认]。

## 5. 版本切换 / 语言切换

- 没有「手册版本切换」机制：`index.json` 无 `versions` 字段，读取路径也不含版本号（`main.js:408-413`）→ 页面只能有一份现行正文。
- 有**语言切换**，跟随界面语言：`docsLocale()`（`app.js:8404`）取 `I18n.getLocale()`，`en` 才走英文。顶栏 `#btnLang` 切语言走 `app-boot.js:265 applyLocale()`，末尾调用 `refreshAppDocsIfOpen()`（`app-boot.js:305`）——手册窗开着时重取 catalog、清空答疑 bundle 缓存、重载当前页（`app.js:8798-8810`）。
- 目录标题用 `docsLocText(obj)` 按 `zh → en` 取舍（`app.js:8408-8414`），缺英文标题回落中文。

## 6. 离线与回退

- 正文与图全部来自本机磁盘（`__dirname/guides/manual`）+ IPC，图片在读取时内联为 data URI（`main.js:388-402`），**全程不需要网络**，断网可正常打开、换页、看下图。
- 缺页回退：英文缺 → 中文；`index.json` 读取失败或结构不对 → `{ ok:false, error:"bad catalog" }`，界面显示「载入失败：…」（`app.js:8824-8834`）；单页缺失显示「找不到该文档 `<id>`」。
- 答疑是唯一需要网络的环节：它要一个带 API Key 的 `text_openai` 服务商；没有时提示「未配置带 API Key 的文本服务商」（`app.js:8720-8732`），正文阅读不受影响。

## 7. 暗色 / 亮色主题适配

- 手册弹窗的样式在 `renderer/css/base.css:1457-1730`，颜色基本走主题变量：`--panel/--panel2/--bd/--bd2/--ink/--muted/--orange/--orange2/--cyan/--cyan2/--code`。
  变量定义：暗色默认在 `base.css:1-20`（`:root`），`body.theme-industrial` `:root` 邻近段 `base.css:22-39`，亮色在 `base.css:41-58`（`body.theme-light`）。
- 主题由 `applyTheme(name)`（`app-db.js:3749-3768`）切换：给 `<body>` 加 `theme-light` / `theme-industrial`，并注入 `#themeStyle` 覆盖 `--cyan/--cyan2/--orange/--orange2/--green/--red`；设置在「设置 · 主题」下拉（`app-settings.js:91-98`）。手册窗无需单独适配，变量一变即跟随。
- **少数硬编码深色值没有亮色覆盖，切到 Light 主题时会保持深色**（`renderer/css/theme-light.css` 内无任何 `.app-docs` 选择器）：
  - `.app-docs-ask` 背景渐变 `linear-gradient(180deg, #141820, var(--panel))`（`base.css:1612`）
  - `.app-docs-ask-msg.ai .chat-bubble` 背景 `#1a1f28`（`base.css:1678`）
  - `.app-docs-article.md img` 背景 `#0d1016`（`base.css:1602`，与手册 SVG 的深色底一致，通常可接受）
  新增手册样式请沿用变量，避免再引入硬编码深色。
- 亮色下 `html:not([lang="en"])` 会把章节标题改回中文排版（不转大写、字距 2px，`base.css:1552-1555`）。

## 8. 已知口径 / 待确认

- `[待确认]` 手册**版本切换**（同一手册保留多版）未纳入本次范围；若要做，需在 `index.json` 增设版本字段并改 `loadDocsCatalog` / `loadMarkdownPack` 的路径解析。
- `[待确认]` 手册**正文全文搜索**未实现（见 §4）。
- `[待确认]` 从应用外部（命令行 / 协议链接 / `location.hash`）直接打开手册某页未实现（见 §3）。
- 手册自 2026-09 起**只出静态图**（类型 `ui|flow|state`），不再生成 `-demo` 动效图；所以「动效 SVG 经 data URI 注入 `<img>` 后 SMIL 是否循环播放」这条口径暂时没有现场可验（内联链路本身见 `main.js:388-402`）。
