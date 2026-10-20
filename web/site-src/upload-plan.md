# 本轮改动复核 + 待上传清单（run rmu8ix6d7bupkpr 第 0 轮）

- 复核对象：`E:\dev\tools\pipeline-console\web`（index.html / tutorial.html / assets/tutorial/）
- 目标通道：**bucket `mtnode-download` · region `oss-cn-beijing`**
- 路径映射：`/mtnode/<key>` = bucket 根下 `<key>`；公网 `http://mt-agent.com/mtnode/` → 301 → `https://www.mt-agent.com/mtnode/`
- 上传入口：`node site-src/publish.mjs upload <localFile> <ossKey>`
- 机器可读清单：`site-src/upload-plan.json`（同名 `upload_plan` 已写回任务状态）

---

## 一、复核结论（逐条对应任务书 ①②③）

### ① index.html — 全部落实 ✅

| 要求 | 结论 | 证据 |
| --- | --- | --- |
| hero 区两个按钮（下载 Windows 安装包 / 查看新能力）已删除 | ✅ | 当前 hero（206–215 行）只有 pills + h1 + lead，**无** `<div class="hero-cta">`、无任何 `a.dl-btn`；对照旧版 `site-src/preview/index.html:316-320` 仍在 |
| 「Windows 10 / 11 x64 · NSIS 一键安装 · MIT License …」整行字样已删除 | ✅ | 当前页 grep「离线可用」0 匹配；`NSIS` 只剩安装包卡片描述一行（223 行）。对照 `preview/index.html:458`、`index.html.template:92` 该行仍在（`Windows 10 / 11 x64 · NSIS 一键安装 · …`） |
| 下载区与界面截图之间新增**整行绿色**「使用方法」按钮 → tutorial.html | ✅ | 238 行 `<a class="guide-btn" href="tutorial.html">使用方法</a>`，位于 `dl-zone`(218–235) 与 `app-shot`(240) 之间；CSS 90–95 行：`display:block;width:100%`、绿色边框/文字 `var(--green)` |
| 顶栏导航「使用」改指 tutorial.html | ✅ | 188 行 `<a href="tutorial.html" data-i18n="nav.guide">使用方法</a>`；词条中英齐备（`nav.guide`：使用方法 / How to use） |
| 无头 Edge 1280 抓图 + 识图独立核对 | ✅ | 顶栏含「使用方法」；hero 无按钮；无该整行小字；橙框下载区与截图之间确有整行绿色「使用方法」；下载按钮文字为「下载安装包 / 下载源码包」 |

### ② tutorial.html — 全部落实 ✅

| 要求 | 结论 | 证据 |
| --- | --- | --- |
| 左侧可折叠目录 | ✅ | `aside.tut-nav > #tutFilter + #tutTree`；脚本逐章生成 `<details class="tut-ch">`，`d.open = (i<1)` 仅默认展开第一章（784–805 行） |
| 关键词过滤 | ✅ | `#tutFilter` 的 input 事件按「章节标题 + 小节标题」过滤，无命中显示 `#tutEmpty`「无匹配项」（808–829 行） |
| 右侧 11 章锚点长文 | ✅ | 11 个 `<section class="chapter" id="ch1..ch11">`；章 `h2[id=chN-h]`、节 `h3[id=chN-M]`；目录 `a.href = "#" + h3.id` |
| 每章一张配图 | ✅ | 全页恰好 11 个 `<img>`，依次 `assets/tutorial/ch01.png … ch11.png`，与 11 章 1:1 |
| 未引用 B 站视频时视频窗隐藏 | ✅ | `TUTORIAL_VIDEO = { bvid:"" , embedUrl:"" }`（758–762）；`initVideo` 中 url 为空即 `box.hidden = true`（772 行）；HTML 上 `#tutVideo` 亦带 `hidden`（154 行）。填 BV 号即出现 |
| 无头 Edge 抓图 + 识图核对 | ✅ | 左右两栏：左目录栏（搜索框 + 可展开章节列表，第 1 章默认展开）；右侧第 1 章带配图；正文顶部**无** B 站视频窗 |

**11 章标题**：1 准备工作 · 2 内容生成 · 3 全局助手与工作流 · 4 开发节点 · 5 会话 · 6 长任务 · 7 工具 / 函数节点 · 8 素材库 · 9 专家团 · 10 社区（工坊 / 讨论区） · 11 其他（操作技巧与常见问题）

### ③ assets/tutorial/ ✅

`ch01–ch11.png` + `canvas-overview.png` 共 12 个文件全部存在，合计 **4,987,736 字节**。

---

## 二、待上传文件 ↔ OSS key 清单（核心交付）

### 必传 13 个（合计 **1,978,886 字节** ≈ 1.89 MiB）

| # | 本地文件（E:\dev\tools\pipeline-console\web\） | OSS key | 字节 | 公网 URL |
| --- | --- | --- | --- | --- |
| 1 | `index.html` | `index.html` ⚠ 需 `--allow-root-index` | 56,967 | https://www.mt-agent.com/mtnode/index.html |
| 2 | `tutorial.html` | `tutorial.html` | 67,310 | https://www.mt-agent.com/mtnode/tutorial.html |
| 3 | `assets\tutorial\ch01.png` | `assets/tutorial/ch01.png` | 140,930 | …/mtnode/assets/tutorial/ch01.png |
| 4 | `assets\tutorial\ch02.png` | `assets/tutorial/ch02.png` | 169,312 | …/ch02.png |
| 5 | `assets\tutorial\ch03.png` | `assets/tutorial/ch03.png` | 166,669 | …/ch03.png |
| 6 | `assets\tutorial\ch04.png` | `assets/tutorial/ch04.png` | 167,545 | …/ch04.png |
| 7 | `assets\tutorial\ch05.png` | `assets/tutorial/ch05.png` | 174,578 | …/ch05.png |
| 8 | `assets\tutorial\ch06.png` | `assets/tutorial/ch06.png` | 167,439 | …/ch06.png |
| 9 | `assets\tutorial\ch07.png` | `assets/tutorial/ch07.png` | 196,424 | …/ch07.png |
| 10 | `assets\tutorial\ch08.png` | `assets/tutorial/ch08.png` | 176,089 | …/ch08.png |
| 11 | `assets\tutorial\ch09.png` | `assets/tutorial/ch09.png` | 160,060 | …/ch09.png |
| 12 | `assets\tutorial\ch10.png` | `assets/tutorial/ch10.png` | 192,826 | …/ch10.png |
| 13 | `assets\tutorial\ch11.png` | `assets/tutorial/ch11.png` | 142,737 | …/ch11.png |

SHA256（逐个，均按本地文件实测）：

```
index.html    A6F3DA191528DAFF8A43CE3E5B7C4B9183C58F1465B12DC5DAED566D9A2D53E0
tutorial.html A01856383B5D3701579A05FAEA7DF131E8A19C26143F8A0429983535BA89212E
ch01 5AA5F1037CD6E1DA7E9F01FB2C051A21E06D72418AA826B986F6549D48E1F3CB
ch02 1D821546D00F53975DFF3A2C582A0C0567333FB0364CEDE361CF2F4FB58611CC
ch03 584175BC4FBD6088430C2267C5887440C6AEBB51469D88626F57CE38A5FDF5F4
ch04 5921A693AF7A9469917B0FF7694816A5EFB0E1500E9F9C7629E5FC983095F840
ch05 D13FF0562D93C0739F4D68FF98916EFB775BB9CB404B130C37ED9B13C06F7DB8
ch06 437D394C0C59A97B05D3164F6FEA764EDC8A2E949710310304CE9E325B48377A
ch07 3153EF346E16A354695EA0152AD4017CB47B1173E8E6EA840F451C5B5C05E017
ch08 11873B5890F6943ED85DBA43AB62DAFFDD8CA84D5A579B4909AB07A92B7EF59D
ch09 CF25E1F28B2919EAB0450BEF8D0300A4EAC45420E5BCEF7A48B1E5EF66E2A3E8
ch10 BD9EABF7763168A62111034E36CA88E20CAC93289E4557F1D4058C98AC995CA3
ch11 D8339970CAC51ED421791EA7896A41455DD29F29463BA7B2735CB618952A36AE
```

### 待拍板 1 个（可传可不传）

| 本地文件 | OSS key | 字节 | 说明 |
| --- | --- | --- | --- |
| `assets\tutorial\canvas-overview.png` | `assets/tutorial/canvas-overview.png` | 3,133,127 | **待拍板**：index.html 与 tutorial.html 全文 grep **0 次**引用，3.13 MB。若本是教程页配图却漏了 `<img>`，请先补引用；若作分享 / OG 图，请给口径 |

含它的话总计 **14 个 / 5,112,013 字节**。

### 无需重传（线上已存在，字节数与本地一致）

| OSS key | 线上字节 | 线上 Last-Modified (GMT) | 说明 |
| --- | --- | --- | --- |
| `downloads/MTNodeAIO-Setup-1.4.1.exe` | 126,164,581 = 本地 | Sat, 19 Sep 2026 11:12:17 | index.html 安装包下载目标 ✅ 不会 404 |
| `downloads/MTNodeAIO-src-1.4.1.zip` | 9,495,336 = 本地 | Sat, 19 Sep 2026 11:12:17 | index.html 源码包下载目标 ✅ |
| `screenshot.png` | 1,882,462 = 本地 | Sat, 19 Sep 2026 11:12:09 | index.html 引用的界面截图（本轮未改） |

### 不需要上线

`assets/favicon.ico`、`assets/icon.png`（两页均无图标引用）· `index.html.template` · `site-src/**`（设计与发布留档）· `downloads/` 里 1.3.3 及更早的历史版本（本轮无改动）。

---

## 三、上传命令（建议顺序）

**先传图 → 再传教程页 → 最后切首页**，避免「页面已上线、图 404」的时间窗。

```bash
# 1) 11 张配图（先）
node site-src/publish.mjs upload E:\dev\tools\pipeline-console\web\assets\tutorial\ch01.png assets/tutorial/ch01.png
# … ch02 … ch11 同式

# 2) 教程页（新对象）
node site-src/publish.mjs upload E:\dev\tools\pipeline-console\web\tutorial.html tutorial.html

# 3) 首页（覆盖站点根，必须显式授权）
node site-src/publish.mjs upload E:\dev\tools\pipeline-console\web\index.html index.html --allow-root-index
```

覆盖前可用 `--dry-run` 预演；覆盖后建议 `head` 核对字节数，并按 `publish.md` 的口径（reduced-motion / `--virtual-time-budget`）复核线上渲染。

---

## 四、注意事项 / 观察项

1. **上传顺序**（上面已展开）：图在前、首页最后。
2. **`index.html` 覆盖需 `--allow-root-index`** —— `publish.mjs` 硬防线，不加直接拒绝。
3. **线上首页基线**：当前 `oss://index.html` = 57,571 字节 · Last-Modified Sat, 19 Sep 2026 11:12:09 GMT（即 1.4.1 发布版，尚无绿色「使用方法」按钮、hero 区仍有按钮）。本轮把它覆盖为本地新版 56,967 字节。
4. **版本号已对齐**：页面 `VER = 1.4.1`、`verTag = v1.4.1`，下载链接指向 `1.4.1` 安装包 / 源码包，且两者线上已存在 —— 此前 `publish.md` 记录的「1.4.0 文案 / 1.3.3 产物」错位问题本轮已消除。
5. **观察项（不阻塞）**：`index.html` 里 `<section id="guide">`（使用流程 5 步）仍在页面中，但顶栏「使用方法」已改指 tutorial.html，页脚也未再链 `#guide` → 该区块目前只能靠滚动看到。
6. **观察项（不阻塞）**：`index.html` 114–115 行 `a.dl-btn.ghost` 规则随 hero 按钮删除后已无元素使用（死 CSS，可顺手清）。
7. **教程页非零外链**：`tutorial.html` 含 6 条外链（DeepSeek / 阿里云百炼 / 智谱 / Moonshot / apiyi / B 站空间），与自包含的 `index.html` 不同，属教程内容需要。
8. **视频窗埋点**：想挂 B 站视频只需改 `tutorial.html` 里 `TUTORIAL_VIDEO.bvid` 一处。

---

## 五、本地核对留档

无头 Edge 抓图（临时目录 `.verify/`，未进站点、未上线）：`index-top-1280.png`、`tutorial-1280.png`，均已用识图独立复核上述结论。