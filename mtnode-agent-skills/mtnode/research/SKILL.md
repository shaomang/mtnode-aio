---
name: mtnode-research
title: 研究画布（知识图谱 + 文献层）
description: 在研究视图里以课题为核心建知识图谱：Markdown 笔记规范（frontmatter / callout / wikilink / 引用 / 公式）、图谱查询与文献检索脚本、验证状态与溯源口径。改研究笔记或做文献调研前读它。
---

# 研究画布

研究视图（顶栏「研究」，第 4 个视图）把一切内容拆成**可回查的陈述**：一个课题 = 一个画布 = 一份 Markdown 库，图谱只是这份库的投影。**正文是真源，图谱是缓存** —— 任何结论都要能顺着边回到某段正文的某一行。本技能是这套规范的唯一真源。

## 数据在哪

```
<画布工作目录>/research/
  research.json              课题元信息（title / question / createdAt / verify 口径 / initSplit 资料库分栏比例）
  init-queue.json            初始化队列（用户投的料；agent 逐项处理并回写状态）
  notes/*.md                 笔记（真源；子目录随意，id = note:<相对路径>）
  core/*.md                  核心文件转出的正文（主稿在这里，与 notes/ 同权：进图谱、可被 [[标题]] 指到）
  core/<原名>.skim.md       3-Pass 变体：略读（贡献 / 证据 / 局限）
  core/<原名>.concept.md    3-Pass 变体：关键概念（简要定义 + 简化解释 + 优先引原文的图）
  core/<原名>.tech.md       3-Pass 变体：技术细节（方法 / 公式原样 / 实验设置）
  terms/<slug>.md            术语页（一页一个术语，全库共用；第一层初始化时归纳，之后靠「引申」长下一层）
  literature/library.json    CSL-JSON 文献库（BibTeX 导入后也是这一份）
  literature/sources/<key>.md  参考资料转出的正文
  literature/folds/<key>.md    参考资料的三层折叠（全文 / 关键原句 / 主题）+ 节级三档（一句话 / 一段话 / 原文）
  literature/pdf/<key>.md    PDF 抽出的全文（已经过解析，可 grep）
  graph.json                 增量构建的图谱缓存（可删，删了重建）
  changes.jsonl              可撤销的改动日志（保留最近 500 条）
```

**不要**另建第二份索引或把内容写进 `graph.json` —— 它随时会被下一次保存覆盖。

## 笔记规范（照抄即合规）

```markdown
---
title: 稀疏注意力是否足够
kind: claim            # 可选：topic / claim / concept / method / question / note
tags: [claim, method]
aliases: [SparseAttention]
verify: doubt          # verified | doubt | unverified
方向: 定义              # 可选：这条笔记从哪个方向写这个对象（自由文字，见下）
date: 2026-03-01
refs: [vaswani2017]    # 引用键，等价于正文写 [@vaswani2017]
relates: [长序列建模]
---

## 研究背景

我们关心 [[稀疏注意力]] 在长序列上的表现，参见 [@vaswani2017 第 3 节]。

> [!claim] 稀疏注意力可以等价替代全注意力
> 在长序列任务上误差小于 1%。[[长序列]]
> 支撑：[@vaswani2017 表 2]
> $$ \varepsilon = \lVert A - \hat A \rVert_2 $$
```

四类语法，全部**内联在正文里**（不另开字段，不另建表）：

| 写法 | 变成 | 边 |
| --- | --- | --- |
| `[[目标]]` / `[[目标\|别名]]` | concept，能对上笔记标题/别名就并回该笔记 | `relates` / `mentions` |
| `[@key]` / `[@key 第 3 节]` / `[-@key]` | paper 节点（键来自文献库） | `cites`（保留 locator） |
| `> [!formula] 题目` | formula 节点（**按内容合并**） | `depends` |
| `> [!claim|refute] 标题` | claim 节点 | `asserts`（`refute` 记 `refuted: true`） |

**公式不进图**：行内 `$…$` 与块级 `$$…$$` 只在正文渲染（阅读区按小节自动编号；点公式弹出「库里哪些笔记写过这条式子」的浮层，浮层头部那颗 ⤢ 才是原来的放大 / 改源码）。
要让一条公式上图，就写成显式块 `> [!formula] 简短题目`，正文写 TeX —— 同一道公式按内容合并成一个节点。
**章节标题也不进图**：`## 1. 引言` 是排版结构，导航交给阅读区右侧大纲。

callout 的可用种类：`claim`（论断，带 verify 状态）、`note`（批注，`annotates`）、`source`（外部来源，抽 URL/DOI，`cites`）、`formula`（公式块，`depends`）、`method`（方法/步骤，`part_of`）、`question`（待解问题，`asks`）、`term`（术语定义，**只做渲染、不进图**：术语在别处首次出现时带锚点，悬停看定义、点击看「哪些笔记写过它」）、以及 `claim|refute`（被反驳的论断）。

**「方向」是笔记自己的一个自由字段**：`方向: 定义` / `方向: 反例` / `方向: 动机` / `方向: 历史`……
意思是「这条笔记从哪个方向写它谈到的那个对象」。它在阅读区点术语 / 点公式弹出来的浮层里，就是每张卡片开头那颗有色标签
（标签后面紧跟正文，同一条流、整卡截三行）；没写方向的旧笔记退回 callout 种类（定义 / 公式 / 论断…），不留空标签。
中英文主键都认（`方向:` 优先，其次 `angle:` / `direction:` / `dir:`），所以既有笔记不用改。

代码块 ```mermaid / ```pele 会变成 figure 节点（Pele 只支持 `flowchart TD|LR`、`sequenceDiagram`、`mindmap` 三类，语法见 `renderer/app-pele.js` 头部注释）。

## 工具

**先看这份内核，别再写一套解析**：`renderer/research-core.js`（UMD，纯函数，零依赖）就是全部解析与图算法，Node 与渲染层共用同一份。

```powershell
# 整库体检：节点/边计数、kind 分布、缺文献的引用、悬空链接、没有出边的论断
# 笔记真源是 notes/ + core/ + frontmatter 里的 parents —— 与界面 rsLoadNotes 同口径，core/ 的主稿不会被误报悬空
node mtnode-agent-skills/mtnode/research/scripts/research-lit.mjs graph <research目录>

# 体检 + 按界面同一份 buildGraph + pruneGraph 落 graph.json（这是命令行唯一允许写图谱的入口）
node mtnode-agent-skills/mtnode/research/scripts/research-lit.mjs graph <research目录> --write

# 单篇笔记解析结果（节点、边、verify 状态）
node mtnode-agent-skills/mtnode/research/scripts/research-lit.mjs note <research目录> notes/xxx.md

# 文献库清单（citeKey / 标题 / 年份 / 是否有 DOI 与 PDF 全文）
node mtnode-agent-skills/mtnode/research/scripts/research-lit.mjs ls <research目录>

# 文献入库（library.json 的唯一命令行写入口；同 DOI 覆盖、重键自动补 b/c）
node mtnode-agent-skills/mtnode/research/scripts/research-lit.mjs lib <research目录> add --doi 10.1038/nature14539
'{"title":"…","author":[{"family":"…"}],"issued":{"date-parts":[[2020]]},"DOI":"10.…"}' | node mtnode-agent-skills/mtnode/research/scripts/research-lit.mjs lib <research目录> add -

# 在线检索（Crossref / arXiv），抓元数据落成 CSL-JSON 条目
node mtnode-agent-skills/mtnode/research/scripts/research-lit.mjs search crossref "sparse attention" 5
node mtnode-agent-skills/mtnode/research/scripts/research-lit.mjs search arxiv "long context transformer" 5

# 按 DOI 取准元数据（写库前先取，不手抄）
node mtnode-agent-skills/mtnode/research/scripts/research-lit.mjs doi 10.5555/3295222

# 初始化队列：看状态 / 取下一条 / 回写一条 / 追加入队 / 生成折叠骨架 / 体检（唯一允许写 init-queue.json 的入口）
node mtnode-agent-skills/mtnode/research/scripts/research-queue.mjs status <research目录>
node mtnode-agent-skills/mtnode/research/scripts/research-queue.mjs next   <research目录>
node mtnode-agent-skills/mtnode/research/scripts/research-queue.mjs set    <research目录> it0001 done
node mtnode-agent-skills/mtnode/research/scripts/research-queue.mjs set    <research目录> it0002 done --summary   # 只抓到元数据+摘要
node mtnode-agent-skills/mtnode/research/scripts/research-queue.mjs add    <research目录> '{"role":"ref","source":"url","url":"https://arxiv.org/abs/2401.00001","hitBy":"long context"}'
node mtnode-agent-skills/mtnode/research/scripts/research-queue.mjs folds  <research目录> <key> literature/sources/<key>.md --write   # 落盘 + 原句按首句预填 + 节级三档骨架（原文已填，一句话/一段话留空）
node mtnode-agent-skills/mtnode/research/scripts/research-queue.mjs folds  check <research目录>   # 三层空槽 / 段落 id 错位 / 节级三档空槽
node mtnode-agent-skills/mtnode/research/scripts/research-queue.mjs doctor <research目录>         # 一轮还差什么（含缺节级 / 缺术语 / 缺变体），一次列全
```

**传 JSON 别跟引号较劲**：PowerShell / cmd 会把内联 JSON 的双引号吃掉（`{"a":1}` 到 node 变成 `{a:1}`）。长载荷一律走管道 `-`（stdin）或 `@路径.json`，`add` 与 `lib add` 都认这两种写法。

渲染层里对应的是 `window.MTResearch`（切笔记、落图、加批注、导入文献、撤上一步）与 `window.MTResearchGraph`（布局/聚焦/搜索）；抓网络必须走 `window.api.netFetch`（CSP 只放行 `'self'`，`fetch` 会被拦）。

## 初始化队列（用户投完料后你要做的事）

用户在研究视图的整块**资料库**（原投料台）里写课题、往「核心文件」「参考资料」两栏投料（文件 / 网页链接 / 自由文本 / 检索式都行），点「开始处理」——那一刻 `research/` 才建起来，`init-queue.json` 落盘，本会话（工作区就是 `research/`）收到一句「按技能处理研究初始化」。你按下面的顺序**串行**做，一件做完再下一件。

已经初始化过的库再加料，底栏那颗按钮会变成「补充处理」：`init-queue.json` 里**只追加新条目**，旧的 `done` 项连状态都不重写。这时你**只跑 `status` 不是 `done` 的项**（含 `failed` 被重排成 `pending` 的），并且顺手把老库缺的术语页第一层 / 3-Pass 变体 / 节级三档补齐 —— 只补缺的，已有文件与已有小节一个字都不改。写术语 / 公式页前先扫 `terms/`，`slug` 或标题命中就**复用那一页**（只追加 `sources` / `derives` / `relates`），绝不新建重复页。

初始化只生成**课题那一篇** `notes/00-课题.md`（标题 + 核心问题），没有预置的「术语 / 论断 / 文献笔记」骨架：需要哪篇就按上面的笔记规范自己新建，别假设它们已存在，也别把正文里的 `[[…]]` 指向并不存在的模板笔记。

### 队列长什么样

```json
{
  "ver": 1, "phase": "queued", "topic": "课题名", "question": "核心问题",
  "items": [{
    "id": "it0001", "role": "core | ref", "main": true,
    "source": "file | url | text | query",   // 这条是怎么投进来的
    "src": "原文件绝对路径（仅 source=file）", "rel": "core/main.tex（仅 source=file）",
    "url": "https://arxiv.org/abs/…（仅 source=url）",
    "query": "检索式原文（仅 source=query）",
    "text": "用户直接写的内容（仅 source=text）",
    "hitBy": "由哪条检索式命中（自动入队的 ref 项才有）",
    "kind": "tex | pdf | doc | ppt | md | text | data | image | html | web | query | other",
    "title": "显示名", "key": "main",
    "mdRel": "core/main.md",                 // 正文写这里（非文件项此时已有骨架）
    "foldsRel": "literature/folds/main.md",  // 仅 ref：三层折叠写这里
    "noteRel": "notes/40-main.md",           // 仅 ref：文献笔记写这里
    "note": "用户交代 / 或 no-text | pdf-failed",
    "fetch": "pending | done | summary | failed",  // 非文件项：抓取到了哪一步
    "verify": "unverified | doubt | verified",
    "status": "pending|running|done|failed|skipped",
    "error": "", "attempts": 0, "mdDone": false
  }]
}
```

- `role: "core"` 是用户自己在写的东西（主稿 `main: true` 那篇是课题正文）；`role: "ref"` 是外部资料。
- `source` 决定你怎么拿到正文：`file` 已在 `research/` 里；`url` 要联网抓；`text` 用户已写好；`query` 要检索后自己扩项。
- 非文件项的 `mdRel` 在入队时**已经有骨架**（标题 / 来源 / 用户交代 / 待抓取）—— 你把正文补进去，别另起文件。
- `mdDone: true` 表示 PDF **已经**由应用内内核转好了，`mdRel` 里就是全文 —— 别重转。
- 状态只准写代码里的那五个值（`pending / running / done / failed / skipped`），写完把 `phase` 置 `done`。

### 每项要做的事

1. **取一条**：`node mtnode-agent-skills/mtnode/research/scripts/research-queue.mjs next <research>`，拿到的就是下一条 `pending`。
2. **标记开跑**：`... set <research> <id> running`。
2b. **按 `source` 拿正文**：
   - `url`：用你的联网能力抓正文写进 `mdRel`（`window.api.netFetch` 也行）。**抓不到全文就退等价来源** —— Crossref / arXiv 元数据 + 摘要写进去，`set <id> done --summary`（内核会置 `fetch=summary`、`verify=doubt`）。彻底打不开（404 / 付费墙关死）才 `set <id> failed 原因`，让用户在界面上重试或换链接。**不许编造没抓到的段落。**
   - `text`：用户直接写的摘录或要求，整理成正文即可，不用抓取。
   - `query`：按这条检索式检索（`research-lit.mjs search crossref|arxiv "<式>" 5`），取**前 5 篇**用 `research-queue.mjs add` 追加成 `ref` 项、每条带 `--hitBy`（写成 `"hitBy":"<式>"`），再逐项处理；本项自己标 `done`，摘要里写清「命中 N 篇、已入队」。
   - 用户在界面上剔除的命中项会记进 `literature/queries.jsonl`（`action: "dropped"`），别再加回来。
3. **转 md**（`mdDone` 已为 true 就跳过）：
   - `md` / `text` / `tex` / `data` / `html` / `image`：读原文件，整理成干净 Markdown 写到 `mdRel`（去掉 LaTeX 导言区、HTML 标签、导航与页脚；公式保留 `$…$`；不要改写原意，不要摘要）。
   - `pdf`：先跑 `window.api.fileParsePdf` 等价能力（应用内已有内核），拿不到文本层就 `set ... failed "no-text"` 跳过 —— **不要自己 OCR，也不要猜内容**。扫描件请留 `failed` 并在 `error` 里写明原因。
   - `doc` / `ppt`：本机没有 Office 转换器时，能读到什么就写什么（文本层），读不到就 `set ... failed "需要手工导出"`，不要编造。
   - 正文第一行写 `# <title>`，frontmatter 用 `title / kind / source / convertedAt`（`kind` 取 `topic | note | source`）。
4. **转写阶段不抽论断**：这一轮**不写** `> [!claim]`、不建图谱边 —— 论断与概念是作者的活，图谱由他在界面上按需构建（点「转为图谱」）。原文照抄：**不摘要、不改写、不补段落**。转写完成后，再按后面「三件跟着初始化学一起做的产物」补 3-Pass 变体 / 术语页 / 节级三档 —— 这三样是**衍生投影**，不改原文一个字节。
5. **参考资料额外两件**：
   - 三层折叠 → `foldsRel`。用 `node ... research-queue.mjs folds <research> <key> <mdRel> --write` 直接落盘：脚本剥掉 frontmatter、按空行切段（`p0001…`）、`**全文**` 抄原文、`**关键原句**` 按段首句**逐字**预填（超长才在截断处留 `…`）、`**主题**` 留空。你只做判断的那部分：改不合适的原句、逐段补 3–6 字主题、按章节写 `# 主题地图`。**顺序与段落 id 不许改**，界面靠它对齐；收工前跑 `folds check <research>` 确认三层无空缺、id 不错位。
   - 文献条目**别手抄 JSON**：`research-lit.mjs lib <research> add --doi <DOI>`（认不出 DOI 就管道传 CSL-JSON：`add -`），同 DOI 覆盖、重键自动补 b/c，与界面归并口径一致。
   - 顺手写 `noteRel`：一段摘要 + 这篇文献与本课题的关系。**不写 claim 块、不写 `[[…]]` 链接**（那是作者的事）。
6. **不建图谱边**：初始化不写 `cites` / `relates` / `asserts` 这些关系；正文里的引用 `[@key]` 照原文保留即可（文献库里没有的键也不用补）。
7. **回写状态**：`... set <research> <id> done`；某项失败就 `set ... failed "原因"` 然后继续下一项 —— **一项失败不许中断整轮**。
   - `set ... done` 会**自动**在该项的 `noteRel` 笔记 frontmatter 里补 `init: done` / `initAt`（队列项与笔记标记是「已处理」的两条依据，界面靠这个给笔记 / 文献行打 ✓ 徽标、把顶栏 chip 变成「初始化完成 · N 篇已处理」）—— 不用再手工 edit，命令回执里会打印写没写上。项里没有 `noteRel`（例如后来手工追加的项）时脚本不会乱建文件。

### 收尾

- `... status <research>` 确认 `finished == total`，然后 `set` 最后一条（或任何一条）让 `phase` 变成 `done`。
- 收尾前跑一遍 `... doctor <research>`：它一次列出「待处理 / 卡在 running / 缺正文 / 缺笔记 / 缺 init 标记 / 折叠空槽 / 节级三档空槽 / 缺术语页 / 缺 3-Pass 变体 / phase 与进度不符 / 文献缺 DOI」，按清单补完再收尾（别再靠自己一项项肉眼核）。
- **初始化不建图、不建边**：`graph.json` 只在用户点「转为图谱」时由界面投影生成，或由 `research-lit.mjs graph <research> --write` 生成。**不要**自己弹窗、不要改画布节点、不要手写 `graph.json`。

## 三件跟着初始化学一起做的产物

每个**核心原文**（`core/*.md`）除了正文，还要产出下面三样。它们互相独立、各自成文件，都在 `research/` 里，界面都认：

### 1) 3-Pass 变体（三份独立文件）

对每篇原文各写三份（后缀固定，别自创）：

| 后缀 | 内容 | 篇幅 |
| --- | --- | --- |
| `.skim.md` | **略读**：贡献 / 证据 / 局限 | 200–320 字 |
| `.concept.md` | **关键概念**：3–6 个概念，每个：简要定义 + 简化解释 + 优先引原文里已有的图 | ≤ 600 字 |
| `.tech.md` | **技术细节**：方法步骤 / 公式原样抄 / 实验设置与关键数字 | 不限，但只写原文有的 |

- frontmatter：`title`、`derived: skim | concept | tech`、`parent: core/<原名>.md`；不写 `lang`（这三份不是翻译）。
- 文件名 = 原文件名 + 后缀：`core/attention.md` → `core/attention.skim.md`。
- 旧的 `*.summary.md` / `*.excerpt.md` **留在盘上别动**（用户要求保留），但**不要再新写**这两种。
- 三份都不许编：原文没写的写「原文没有展开」。

### 2) 术语页 `terms/<slug>.md`（第一层）

初始化时按原文自动归纳**第一层** 8–20 页；更深的层不自动跑，等用户在某页点「引申」。

- 文件：`terms/<slug>.md`，`slug` = 术语名（中文保留、空白与符号转 `-`），全库一页一个术语名，不按文章分目录。
- frontmatter 六键：
  ```
  ---
  title: 稀疏注意力
  kind: term            # term | concept | formula | symbol | theorem | method | dataset
  slug: 稀疏注意力
  aliases: [sparse attention]
  derives: [attention]  # 来源原文的 title（图谱上 = 术语页 → 原文这条边）
  relates: [注意力机制]  # 上层术语（术语页 → 父术语）
  sources: [attention · §2]   # 原文里哪一节讲的
  origin: init          # init | derive（第二层以后写 derive）
  verify: unverified
  date: 2026-11-09
  ---
  ```
  **不写 `parent`**：那会在图上多出一条与 `derives` 对顶的边。
- 正文骨架（缺的节删掉，别留空标题）：
  ```
  # 稀疏注意力

  > [!term] 稀疏注意力
  > 只让一部分 token 互看，其余置零。

  ## 直觉
  开会时只跟邻座说话 —— 省了寒暄，也漏掉了远处的信息。

  ## 公式 / 记号
  $$ \text{Attn}(Q,K,V) = \mathrm{softmax}(M \odot QK^\top/\sqrt{d})V $$

  ## 符号
  - $M$：掩码矩阵（0/1）

  ## 在原文里
  - attention · §2：定义与复杂度对比

  ## 还能引申
  - [[块稀疏]]
  - [[Top-k 选择]]
  ```
- `## 直觉` 是必需节：没有一段简化解释，这页就只是抄词典。
- `## 还能引申` 里列的是**下一层候选**（`[[…]]` 指向还不存在的页也允许）；用户点「引申」后你才生成那些页。候选写成普通列表行，**不要**套 `> [!question] 待展开` —— 那个 callout 会进「问题清单」，而问题清单只放用户自己写的待解问题。
- **问题清单只归用户**：`> [!question]` 块一律由用户自己写。初始化 / 补跑 / 引申都不新建、不追加 question 块（课题那一篇里的 `核心问题` 是用户填的，原样留着）。
- `kind: formula` / `symbol` 的页：公式 / 记号原样抄进 `## 公式 / 记号`，一个符号一行写进 `## 符号`；不许改写符号含义。

### 3) 节级三档（写进折叠文件，不另起文件）

`literature/folds/<key>.md` 除三层折叠外，还有一段 `# 节级三档`：读者在界面上给**每一节**切「一句话 / 一段话 / 原文」。

- `folds --write` 已经把骨架写好：每节 `## s0001 · <锚点>` + `**一句话**` / `**一段话**` 留空（`—`）+ `**原文**` 抄好。
- 你要做的是把每节的 `**一句话**`（≤ 40 字，说清这节干了什么）与 `**一段话**`（80–150 字，可独立读懂）填上；`**原文**` **一个字都不要动**（它是回落基准，顺序与 id 也不许改）。
- 顶部 frontmatter 只有两行归你偶尔改：`secLevel: one | para | full`（全篇默认档）与 `secPins: s0002=full, s0005=one`（每节钉住，逗号分隔）。平时不用动 —— 读者在界面上切，界面自己写。
- 节级三档与三层折叠**互不影响**：前者按「节」切颗粒度，后者按「段」做折叠投影；改一个别把另一个删了。

## 用户明确要求建论断 / 建边时（超出初始化范围）

初始化默认不建边（见上），但用户明确说「抽论断、抽概念、建边、跑一轮全局建边」时照下面做 —— 别为这件事临时写脚本：

1. 论断按笔记规范写进正文：`> [!claim] 标题` + 支撑行 `> 支撑：[@key locator]`，`verify` 按证据给 `doubt` / `verified`（单一来源就是 `doubt`）；
2. 概念写成 `notes/<编号>-<概念>.md`（`kind: concept`，带 `> [!term]`），别建空模板，别让 `[[…]]` 指向不存在的笔记；
3. 建边 = 改正文后重算，不是手写 JSON：先 `research-lit.mjs graph <research>` 看缺口（悬空 wikilink / 没有出边的论断 / 引用键不在文献库），改到缺口归零；数值、条目一律回原文核对，别凭印象；
4. 再 `graph <research> --write` 落盘 —— 走的正是界面那份 `buildGraph + pruneGraph`，节点 / 边 / kind 分布与界面完全一致；
5. 交付时报 `nodes / edges / 各类边计数 / 缺口`，这些都能从命令回执里复核。

## 验证状态（三态，不许自创第四态）

- `verified` 已验证 —— 有文献或实验支撑，且 locator 指得出位置；
- `doubt` 存疑 —— 有反例 / 证据不完整 / 只在单一来源；
- `unverified` 未验证 —— 默认态，agent 首轮读完后按证据升级，**人可随时改回**。

结论口径：写「已验证」必须同时给出 `[@key locator]` 或可复现的实验描述；给不出就留在 `unverified`，别用「据研究」「普遍认为」这种无主陈述冒充验证。

## 文献层三条腿（工具都在，默认不动手）

**默认不检索、不下载。** 联网检索与全文下载都很贵（一篇 PDF 转 md 要逐页读，几万 token 起），所以：

- 只有**用户点名**才做：他投了检索式（队列项 `source: "query"`）、贴了某篇的链接 / DOI / arXiv 编号，或在界面上点「获取文献」。
- 你自己的判断（「这里该有一篇文献支撑」）**不是**用户点名：缺文献就在回执里写清缺什么、给一条建议检索式，由用户决定。**不许**自行扩库、自行下载 PDF、自行把全文转成 md。
- 正文里的 `[@key]` 不在文献库时，别去检索补它（键照原文保留）。

下面是「用户要的时候走哪条」，不是「每轮都要跑一遍」：

1. **本地键**：BibTeX / CSL-JSON 导入 → `library.json`，`citeKey` 是引用键（重键自动补 `b/c`）。
2. **在线元数据**：DOI → Crossref；标题检索 → Crossref / arXiv / Semantic Scholar。抓回来先落库再引用（先取后引）。
3. **PDF 全文**：`literature/pdf/<key>.md`，抽出来的正文可直接 grep 定位原文页码/章节，用于「这句话出处是哪一段」。

引用一律写 `[@key]`；引用别人的论断时把 locator 写上（页码 / 表格号 / 小节），这是「有据可查」的最低要求。

## 硬规则

- 只改 Markdown 正文（与 `library.json`、`init-queue.json` 的状态位）；`graph.json` 只由界面「转为图谱」或 `research-lit.mjs graph --write` 生成，**不要手写**；`changes.jsonl` 不要手写。
- `init-queue.json` 只通过 `research-queue.mjs set` 改状态——手改容易漏 `phase`，界面会卡在「处理中」；`library.json` 只通过 `research-lit.mjs lib add`（或界面导入）写，别手抄 JSON。
- **不自行补文献**：默认不联网检索、不下载全文（口径见「文献层三条腿」一节）；只有用户的检索式 / 链接 / 「获取文献」才触发联网。
- 需要「体检 / 折叠 / 入库 / 建图」这类活，先用上面那两条命令（`research-lit.mjs` / `research-queue.mjs`），**不要另写临时脚本**：内核 `renderer/research-core.js` 是唯一真源，另写一套必然与界面口径不一致。
- 新增论断 = 新增 `> [!claim]` callout，不要另起一个孤立 md 文件（孤立节点等于没写）。
- 每条 `claim` 至少要有一条出边（引用 / 依赖 / 反驳），否则图谱上就是悬空断言。
- 图谱反向改正文只允许动 callout 块与 frontmatter 键，不动正文散文。
- 画布视图与画布节点**一律不碰**：研究视图与画布是两套内容，共用的是项目目录与顶栏。
