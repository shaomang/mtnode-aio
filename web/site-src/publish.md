# 官网发布记录（web/ → 阿里云 OSS）

> 本文件由「③ 样张发预览路径」环节生成，供后续「部署上线」环节直接复用。

## 一、发布通道（实测事实）

| 项 | 值 |
| --- | --- |
| 地域 | `oss-cn-beijing` |
| Bucket | `mtnode-download` |
| 凭据文件 | `E:\dev\tools\oss-config.json`（region / bucket / accessKeyId / accessKeySecret） |
| SDK | `E:\dev\tools\oss\node_modules\ali-oss`（绝对路径引用，不复制进项目） |
| 公开域名 | `http://mt-agent.com/mtnode/` → 301 → `https://www.mt-agent.com/mtnode/` |
| 路径映射 | `/mtnode/<key>` 即 bucket 根下的 `<key>`（`/mtnode/index.html` = `oss://index.html`，实测 200） |
| 加速层 | nginx 直回源 OSS（响应头带 `x-oss-request-id`，无 CDN 缓存头），**上传后即时可见** |
| 线上首页基线 | `oss://index.html` · 57571 字节 · Last-Modified `Sun, 13 Sep 2026 08:37:40 GMT`（本轮未改动） |

## 二、发布脚本 `site-src/publish.mjs`

```bash
# 上传（预览、下载包、最终首页都用这一条）
node site-src/publish.mjs upload <localFile> <ossKey>

# 只打印将写入什么，不实际写
node site-src/publish.mjs upload <localFile> <ossKey> --dry-run

# 查对象是否存在 / 列出某前缀
node site-src/publish.mjs head <ossKey>
node site-src/publish.mjs list [prefix]
```

选项：`--content-type=<MIME>`（默认按扩展名推断，`.html` 固定带 `charset=utf-8`）、`--cache-control=<VALUE>`（默认 `no-cache, max-age=0`）、`--allow-root-index`。

内置防线：**覆盖站点根 `index.html` 必须显式加 `--allow-root-index`**，否则脚本拒绝执行；key 不允许前导斜杠 / 反斜杠 / 结尾斜杠；脚本只调 OSS API，不在服务器本地落任何文件；输出绝不打印 AccessKeySecret。

## 三、预览发布记录（当前线上 = v3 · 完全沿用原版样式版）

| 时间（UTC+8） | 上传内容 | 结果 |
| --- | --- | --- |
| 2026-09-19 02:16 | v1 表格版 · 24061 字节 · SHA256 `9616C770…` | 已被 v2 覆盖；本地留档 `.backup-index-table-1.3.3.html` |
| 2026-09-19 03:59 | v2 卡片版 · 34475 字节 · SHA256 `C7061415…` | 已被 v3 覆盖（④ 于 14:11 驳回 v2：「完全使用原版网页的样式，仅进行扩展修改」） |
| 2026-09-19 14:31 | **v3 沿用原版样式版 · 32370 字节 · SHA256 `0E73310F…`** | **当前线上 `oss://preview/index.html`** |

```bash
# v3（当前）：本地 index.html → oss://preview/index.html
node site-src/publish.mjs upload E:\dev\tools\pipeline-console\web\site-src\preview\index.html preview/index.html
# -> 上传 32370 字节 · HTTP 200  etag="875ED9A876456E1B0C92EBD91AED6711"  requestId=6AAE2B32408B2B3136C82D1E
```

- 覆盖前后 `preview/` 前缀下始终只有 1 个对象；覆盖前后站点根 `oss://index.html` 均为 **57571 字节 / Last-Modified `Sun, 13 Sep 2026 08:37:40 GMT`——线上首页一字未动**（本轮未用 `--allow-root-index`，也未在服务器落任何文件）。
- 公开路径校验：`http://mt-agent.com/mtnode/preview/index.html` → **301**（`Location: https://www.mt-agent.com/mtnode/preview/index.html`）→ **200 · text/html; charset=utf-8 · 32370 字节**，与本地文件 SHA256 **完全一致**（`0E73310F3D1241E3CED2B27748C15086BAE9B9E8C4C1EEE144E31029EB51469B`）；`<title>` = 「MTNode AI编排器 · 复杂 AI 工作流，一张画布装下」，`<h1>` 含「复杂 AI 工作流，一张画布装下」。
- 渲染校验（无头 Edge 抓**公网 URL**，与 ② 同口径）：1280×3022 与 ② 留档 `evidence/v3-desktop.png` **逐字节相同**（`E635D284617B6C3E`）；504×4314 与 `evidence/v3-narrow-504.png` **逐字节相同**（`E050F9C694715A5C`）→ 桌面两列 / 窄屏单列的公网渲染即那版已核对设计。留档：`evidence/live-v3-preview-{1280,504,hero}.png`（普通口径 = 未收尾帧）、`live-v3-vt1280.png` / `live-v3-vt504.png`（收尾态）、`live-v3-hero-rm.png`（reduced-motion 首屏，识图用）、对照组 `local-v3-plain1280.png` 与 `local-v3-vt1280.png`（本地同口径，用于证明差异来自拍摄时序而非公网渲染）。
- 识图独立核对（线上首屏 1280×900）：导航 `v1.4.0`、h1「复杂 AI 工作流，一张画布装下」、主按钮「下载 Windows 安装包」、配色为工业风深灰蓝（= v3 修正后的 `#0d1016` 系）。
- 页面自包含：全页 **0 条** `http(s)://` 资源引用，公布后不牵动任何额外上线动作。
- **拍摄时序坑（复用必读）**：无头 Edge 直接 `--screenshot` 抓带入场动效的页面会拍到**动效未收尾的那一帧**（`61CA267B…` / 147503 字节），与 ② 留档（收尾态 `E635D284…` / 263798 字节）不一致，容易误判成「公网渲染被改动」。实测**不是渲染差异**：线上与本地在普通口径下同为 `61CA267B…`（逐字节相同），加上 `--virtual-time-budget=12000` 或 `--force-prefers-reduced-motion` 后两侧同为 `E635D284…`。**复核线上是否真是定稿版，请用 reduced-motion 或 virtual-time-budget 口径。**

## 四、复用要点与已知坑

1. **部署首页**：`node site-src/publish.mjs upload site-src/index.html index.html --allow-root-index`（上线前需先把设计定稿落到 `site-src/index.html`；当前 `web/index.html` 是旧版 57571 字节）。
2. **预览路径下相对下载链接不通**：样张按任务书写的是相对路径 `downloads/<file>`，在 `/mtnode/preview/` 下解析为 `/mtnode/preview/downloads/…` → **实测 404**；这些安装包其实已在 `oss://downloads/` 根下（`MTNodeAIO-Setup-1.3.3.exe` 等 38 个对象，实测 `/mtnode/downloads/MTNodeAIO-Setup-1.3.3.exe` 200）。即：**页面本身没错，是预览位置导致的**，最终部署到站点根后自动恢复正常。若预览期就要求点通，两个办法（本轮均未擅自执行）：把包复制到 `preview/downloads/`（一份 exe 约 138 MB + zip 约 8.3 MB），或临时把 `href` 改成 `../downloads/…`。
3. 样张为零外部请求的单文件页（`<link rel="icon" href="data:,">`，无任何 `http(s)://` 资源），公布后不牵动任何额外上线动作。
4. **版本号与安装包错位（v2 起一直存在，部署前必须拍板）**：页面版本号文案全页为 `v1.4.0`（应用真源 `web/version` = `1.4.0`），但 `downloads/` 里最新可下的仍是 **1.3.3**（`git log` 最后一条发布提交是 `cd25819 发布 v1.3.3`，OSS `downloads/` 实测无 1.4.0 产物）。所以样张的下载链接刻意指向真实存在的 `MTNodeAIO-Setup-1.3.3.exe` / `MTNodeAIO-src-1.3.3.zip`（指向 1.4.0 会 404）。1.4.0 安装包发布后需同步更新这几处 `href`（`#ctaSetup` / `#btnSetup` / `#btnSrc` 及页面脚本里三处赋值）。
5. **当前待复核对象**：`oss://preview/index.html` = v3（32370 字节 · `0E73310F…`）。v3 尚在 ④「设计样张审批」待批；若 ④ 再驳回，② 改稿后重跑本节第 46 行那条上传命令覆盖预览即可（预览路径同一 key，`cache-control: no-cache, max-age=0`，无需清缓存、无需改路径）。
6. **复核线上版本时请用收尾态口径**：见本节「拍摄时序坑」那条 —— 普通 `--screenshot` 拍到的是动效未收尾帧，会与设计留档不一致。