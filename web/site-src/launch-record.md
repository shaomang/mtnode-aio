# 上线留档 —— MTNode 官网本轮改版（run rmu8ix6d7bupkpr 第 0 轮 · 直接上线并留档）

- **结论：已上线**
- **核对时间**：2026-09-20 01:27 – 01:32（UTC+8）／ 2026-09-19 17:27Z – 17:32Z
- **发布通道**：bucket `mtnode-download` · region `oss-cn-beijing` · 公网 `https://www.mt-agent.com/mtnode/`
- **执行**：画布智能节点 `a_online`；上传动作经本环节询问窗由用户确认（「由我按清单实际执行上传」），`canvas-overview.png` 经用户拍板**不上传**
- **入口**：`node site-src/publish.mjs upload <localFile> <ossKey>`（首页加 `--allow-root-index`）
- **依据**：`site-src/upload-plan.md` / `upload-plan.json`（上一环节「核对本地改动并给出上传清单」）

---

## 一、上线内容（13 个对象，全部上传返回 HTTP 200）

| # | OSS key | 字节 | 上传时间（UTC） | 上传返回 ETag | 本地 SHA256（前 16 位，与清单一致） |
| --- | --- | --- | --- | --- | --- |
| 1 | `assets/tutorial/ch01.png` | 140930 | 17:27:54 | `7CBA312B9FCBCBFE64F6510016A76DF9` | 5AA5F1037CD6E1DA |
| 2 | `assets/tutorial/ch02.png` | 169312 | 17:27:54 | `164C0B2CEA124ABF4E410774ABD95F88` | 1D821546D00F5397 |
| 3 | `assets/tutorial/ch03.png` | 166669 | 17:27:54 | `5C14B3B4D0F89EC2E083F1CA9E2203C8` | 584175BC4FBD6088 |
| 4 | `assets/tutorial/ch04.png` | 167545 | 17:27:54 | `752FA49CC71136D72A85B9699DD0D1CE` | 5921A693AF7A9469 |
| 5 | `assets/tutorial/ch05.png` | 174578 | 17:27:55 | `6519899E27B65C6091B1B73D65DBC1DE` | D13FF0562D93C073 |
| 6 | `assets/tutorial/ch06.png` | 167439 | 17:27:55 | `B72DF192A67DCB4DC04FD43EEC6321DC` | 437D394C0C59A97B |
| 7 | `assets/tutorial/ch07.png` | 196424 | 17:27:56 | `B3DB7FCE01784D816D4942B24990916E` | 3153EF346E16A354 |
| 8 | `assets/tutorial/ch08.png` | 176089 | 17:27:56 | `5CD6F1EF25765F7B00016DBD66CF954E` | 11873B5890F6943E |
| 9 | `assets/tutorial/ch09.png` | 160060 | 17:27:56 | `F0407E246D3BA773D54D33FEF4AE1B5C` | CF25E1F28B2919EA |
| 10 | `assets/tutorial/ch10.png` | 192826 | 17:27:57 | `C6250C9E2780A852A7C10C07797635D8` | BD9EABF7763168A6 |
| 11 | `assets/tutorial/ch11.png` | 142737 | 17:27:57 | `3BC24EF622A4C3A15CD3EBC721948345` | D8339970CAC51ED4 |
| 12 | `tutorial.html` | 67310 | 17:28:00 | `30D5E30423848B5CF7AE86A081D6A94E` | A01856383B5D3701 |
| 13 | `index.html` ⚠ `--allow-root-index` | 56967 | 17:28:00 | `3581EEDE1916E571CD1186B969222199` | A6F3DA191528DAFF |

合计 **1,978,886 字节**（≈1.89 MiB），与上传清单的 13 个必传文件 1:1 对齐，逐个字节数一致。
上传顺序按清单执行：**先 11 张配图 → 再 tutorial.html → 最后切 index.html**，无「页面已上线、配图 404」的时间窗。

---

## 二、生效地址（线上实测，全部 200）

| 地址 | 状态 | 字节 | 备注 |
| --- | --- | --- | --- |
| `https://www.mt-agent.com/mtnode/` | 200 | 56967 | 站点根，已切到新版首页（旧版 57571） |
| `https://www.mt-agent.com/mtnode/index.html` | 200 | 56967 | ETag `3581EEDE…` · Last-Modified `Sat, 19 Sep 2026 17:28:00 GMT` |
| `https://www.mt-agent.com/mtnode/tutorial.html` | 200 | 67310 | ETag `30D5E304…` · Last-Modified `Sat, 19 Sep 2026 17:28:00 GMT`（上一环节此地址为 404 NoSuchKey） |
| `…/mtnode/assets/tutorial/ch01.png` … `ch11.png` | 200 | 140930 / 169312 / 166669 / 167545 / 174578 / 167439 / 196424 / 176089 / 160060 / 192826 / 142737 | 11 张全部 200，字节数与本地逐一对齐 |
| `…/mtnode/downloads/MTNodeAIO-Setup-1.4.1.exe` | 200 | 126164581 | 首页下载目标（**未重传**，线上原有） |
| `…/mtnode/downloads/MTNodeAIO-src-1.4.1.zip` | 200 | 9495336 | 源码包下载目标（未重传） |
| `…/mtnode/screenshot.png` | 200 | 1882462 | 首页界面截图（未重传） |

**逐字节一致**：线上拉取的 `index.html` / `tutorial.html` 与本地文件 MD5 完全相同
（`3581EEDE1916E571CD1186B969222199` / `30D5E30423848B5CF7AE86A081D6A94E`），即线上看到的就是本地定稿。

---

## 三、OSS key 清单

**已上线（13）**：`index.html` · `tutorial.html` · `assets/tutorial/ch01.png` … `assets/tutorial/ch11.png`

**未上线（1，用户拍板不上传）**：`assets/tutorial/canvas-overview.png`（3,133,127 字节，index.html 与 tutorial.html 全文 0 次引用 → 待确认口径后再定；线上 404 属预期）

**未重传（3，线上已存在且字节数一致）**：`downloads/MTNodeAIO-Setup-1.4.1.exe` · `downloads/MTNodeAIO-src-1.4.1.zip` · `screenshot.png`

---

## 四、逐项核对结论（对应本环节 ①②③）

### ① bucket 中对应对象已生效 ✅
`node site-src/publish.mjs list assets/tutorial/` 返回 **11 个对象**（原先 0 个）；`head index.html` = `56967` 字节；`head tutorial.html` = `67310` 字节，均 `Cache-Control: no-cache, max-age=0`、Last-Modified `Sat, 19 Sep 2026 17:28:00 GMT`。

### ② 两个页面可正常访问 ✅

**首页 `https://www.mt-agent.com/mtnode/`**（渲染后 DOM + 实景截图双证据）
- hero 区（`index.html` 206–215 行）只有 pills + h1 + lead，**无按钮**：`hero-cta` 0 命中、hero 内 `a.dl-btn` 0 命中（旧版此处的两个按钮已删）。
- 下载区（218–235 行）与界面截图（240 行）之间是 **238 行 `<a class="guide-btn" href="tutorial.html">使用方法</a>`**：整行通栏、绿色。
- 实景像素扫描：1280×3200 截图里 **10 行绿色带，y = 699–757，x 跨 172–1096（通栏）**；对照上一环节对旧版线上页的同算法结果为 **0 行绿色**。
- 裁剪放大识图独立复核：hero 无按钮；两按钮文字为「下载安装包 / 下载源码包」；整行绿色按钮文字「使用方法」。
- 顶栏「使用方法」指向 `tutorial.html`（188 行），`href="#guide"` 0 命中。

**教程页 `https://www.mt-agent.com/mtnode/tutorial.html`**（脚本跑完后的 DOM）
- 左栏目录：`#tutTree` 内脚本生成 **11 个 `<details class="tut-ch">`，其中恰好 1 个带 `open`**（仅第 1 章默认展开）→ 可折叠；`#tutFilter` 搜索框与 `#tutEmpty`「无匹配项」均在；目录锚点 53 条。
- 右侧正文：**11 个 `section.chapter`**（ch1–ch11）、**11 个 `<img>`**、**11 条 `assets/tutorial/chNN.png` 引用**，与 11 章 1:1，且 11 张图线上全部 200。
- 视频窗：`#tutVideo` 仍带 `hidden`（`TUTORIAL_VIDEO.bvid/embedUrl` 为空 → 不显示，填 BV 号即出现）。
- 裁剪实景识图：左栏为可折叠目录且第 1 章展开、右侧正文带配图、正文顶部无 B 站视频窗。

### ③ 上线留档 ✅
本文件 `site-src/launch-record.md` + `site-src/launch-record.json`，同名对象已写回任务状态键 `launch_record`。

---

## 五、方法与证据留档

- 上传：`node site-src/publish.mjs upload …`（逐条 HTTP 200 + requestId + ETag，见第一节）
- 只读核对：`publish.mjs list/head`（OSS 对象）+ `curl.exe`（公网状态码/字节/响应头/Raw 落盘）
- 实景渲染：无头 Edge（`--headless=new --virtual-time-budget=12000 --force-prefers-reduced-motion`）
  - 渲染后 DOM：`.verify/live3/dom2.html`（tutorial）、`.verify/live3/index.dom.html`（index）
  - 实景截图：`.verify/live3/live-index-1280.png`、`.verify/live3/live-tutorial-1280.png`、裁图 `.verify/live3/live-index-top830.png`
  - 像素扫描：绿色判定 `G≥150 且 G−R≥40 且 G−B≥40`，行内命中 ≥8 记一行
- 线上原始字节与响应头：`.verify/live3/index.html` / `index.headers` / `tutorial.html` / `tutorial.headers`
- 上轮对照证据（仍在）：`.verify/live2/`（改版前线上 0 行绿色、tutorial 404）

---

## 六、观察项（不阻塞）

1. **线上首页基线已替换**：`57571` 字节 · ETag `A3A8C5E292B5D24800E20209746E2A0A` · Last-Modified `Sat, 19 Sep 2026 11:12:09 GMT` → `56967` 字节 · ETag `3581EEDE1916E571CD1186B969222199` · Last-Modified `Sat, 19 Sep 2026 17:28:00 GMT`。这是本轮唯一的**覆盖**写入（其余 12 个均为新增对象）。
2. **低分辨率识图的坑（留证）**：对整页 1280 宽截图识图时，模型把首页小字读错为「下载 Windows 版 / 下载 macOS 版」，并误报已删除的 hero 小字仍在；**裁到 1280×830 放大后重读，结论与渲染后 DOM 完全一致**。判断页面文案请以渲染后 DOM / 原始字节为准，识图只作版面级复核。
3. `canvas-overview.png` 未上线，两页 0 引用；若后续要在教程页引用，需先补 `<img>` 再传该 key。
4. `Cache-Control: no-cache, max-age=0` + nginx 直回源 → 上传即时可见，无需刷 CDN。
5. `index.html` 里 `<section id="guide">`（使用流程 5 步）现为只能滚动看到的孤立区块；`a.dl-btn.ghost` 为死 CSS —— 均为上轮已记的观察项，本轮未改。