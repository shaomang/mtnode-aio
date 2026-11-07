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
  research.json              课题元信息（title / question / createdAt / verify 口径 / initSplit 投料台分栏比例）
  init-queue.json            初始化队列（用户投的料；agent 逐项处理并回写状态）
  notes/*.md                 笔记（真源；子目录随意，id = note:<相对路径>）
  core/*.md                  核心文件转出的正文（主稿在这里，与 notes/ 同权：进图谱、可被 [[标题]] 指到）
  literature/library.json    CSL-JSON 文献库（BibTeX 导入后也是这一份）
  literature/sources/<key>.md  参考资料转出的正文
  literature/folds/<key>.md    参考资料的三层折叠（全文 / 关键原句 / 主题）
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
| `$…$` / `$$…$$` | formula 节点 | 正文里 `uses`，callout 里 `depends` |
| `> [!claim|refute] 标题` | claim 节点 | `asserts`（`refute` 记 `refuted: true`） |

callout 的可用种类：`claim`（论断，带 verify 状态）、`note`（批注，`annotates`）、`source`（外部来源，抽 URL/DOI，`cites`）、`formula`（公式块，`depends`）、`method`（方法/步骤，`part_of`）、`question`（待解问题，`asks`）、以及 `claim|refute`（被反驳的论断）。

代码块 ```mermaid / ```pele 会变成 figure 节点（Pele 只支持 `flowchart TD|LR`、`sequenceDiagram`、`mindmap` 三类，语法见 `renderer/app-pele.js` 头部注释）。

## 工具

**先看这份内核，别再写一套解析**：`renderer/research-core.js`（UMD，纯函数，零依赖）就是全部解析与图算法，Node 与渲染层共用同一份。

```powershell
# 整库体检：节点/边计数、kind 分布、缺文献的引用、悬空链接
node mtnode-agent-skills/mtnode/research/scripts/research-lit.mjs graph <research目录>

# 单篇笔记解析结果（节点、边、verify 状态）
node mtnode-agent-skills/mtnode/research/scripts/research-lit.mjs note <research目录> notes/xxx.md

# 文献库清单（citeKey / 标题 / 年份 / 是否有 DOI 与 PDF 全文）
node mtnode-agent-skills/mtnode/research/scripts/research-lit.mjs ls <research目录>

# 在线检索（Crossref / arXiv），抓元数据落成 CSL-JSON 条目
node mtnode-agent-skills/mtnode/research/scripts/research-lit.mjs search crossref "sparse attention" 5
node mtnode-agent-skills/mtnode/research/scripts/research-lit.mjs search arxiv "long context transformer" 5

# 按 DOI 取准元数据（写库前先取，不手抄）
node mtnode-agent-skills/mtnode/research/scripts/research-lit.mjs doi 10.5555/3295222

# 初始化队列：看状态 / 取下一条 / 回写一条 / 追加入队 / 生成折叠骨架（唯一允许写 init-queue.json 的入口）
node mtnode-agent-skills/mtnode/research/scripts/research-queue.mjs status <research目录>
node mtnode-agent-skills/mtnode/research/scripts/research-queue.mjs next   <research目录>
node mtnode-agent-skills/mtnode/research/scripts/research-queue.mjs set    <research目录> it0001 done
node mtnode-agent-skills/mtnode/research/scripts/research-queue.mjs set    <research目录> it0002 done --summary   # 只抓到元数据+摘要
node mtnode-agent-skills/mtnode/research/scripts/research-queue.mjs add    <research目录> '{"role":"ref","source":"url","url":"https://arxiv.org/abs/2401.00001","hitBy":"long context"}'
node mtnode-agent-skills/mtnode/research/scripts/research-queue.mjs folds  <research目录> <key> literature/sources/<key>.md
```

渲染层里对应的是 `window.MTResearch`（切笔记、落图、加批注、导入文献、撤上一步）与 `window.MTResearchGraph`（布局/聚焦/搜索）；抓网络必须走 `window.api.netFetch`（CSP 只放行 `'self'`，`fetch` 会被拦）。

## 初始化队列（用户投完料后你要做的事）

用户在研究视图的整块投料台里写课题、往「核心文件」「参考资料」两栏投料（文件 / 网页链接 / 自由文本 / 检索式都行），点「开始处理」——那一刻 `research/` 才建起来，`init-queue.json` 落盘，本会话（工作区就是 `research/`）收到一句「按技能处理研究初始化」。你按下面的顺序**串行**做，一件做完再下一件。

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
4. **抽论断与概念**（核心与参考都做）：把可验证的陈述抽成 `> [!claim] …`，概念写成 `[[概念]]`，外部依据写 `[@key locator]`。**原文引用一字不改**，改写只在 `[!note]` 里做。
5. **参考资料额外两件**：
   - 三层折叠 → `foldsRel`。骨架用 `node ... research-queue.mjs folds <research> <key> <mdRel>` 生成（已按段落切好 `p0001…`），然后把每段的 `**全文**`（原文，可压缩长引用）/ `**关键原句**`（作者原话，逐字，不用改写）/ `**主题**`（3–6 字的主题词）填上；`# 主题地图` 一节按章节列 `- 章节 → 主题 · 主题`。**顺序与段落 id 不许改**，界面靠它对齐。
   - 文献条目进 `literature/library.json`（CSL-JSON）：能从正文/DOI 认出就写准，认不出就把标题、作者、年份按原文抄进去，`citeKey` 用 `key`。
   - 顺手写 `noteRel`：一段摘要 + 3–5 条可复用论断 + 与本课题的关系（这些论断要用 `[[…]]` 指回核心稿的概念）。
6. **建边**：每篇处理完就把本篇的边建好（`cites` / `relates` / `asserts` / `depends` / `annotates`），不要攒到最后才建。
7. **回写状态**：`... set <research> <id> done`；某项失败就 `set ... failed "原因"` 然后继续下一项 —— **一项失败不许中断整轮**。
   - 处理完一条，除了把队列项 `status` 置 `done`，还要在它对应的笔记 frontmatter 里写 `init: done`（可带 `initAt: <毫秒时间戳>`）：队列项与笔记标记是「已处理」的两条依据，**界面靠这个标记**给笔记 / 文献行打 ✓ 徽标、把顶栏 chip 变成「初始化完成 · N 篇已处理」，所以两条都要写，别只写一条。

### 收尾

- 全部项跑完后，再**跑一轮全局建边**：把核心稿与各参考资料之间同一主题的 `[[概念]]` 对齐（标题/别名一致就并成同一个节点），该加 `relates` 的补上，默认 `verify: unverified`。
- `... status <research>` 确认 `finished == total`，然后 `set` 最后一条（或任何一条）让 `phase` 变成 `done`。
- 回到界面会看到「已建 N 条边 · 转为图谱」。**不要**自己弹窗、不要改画布节点、不要动 `graph.json`。

## 验证状态（三态，不许自创第四态）

- `verified` 已验证 —— 有文献或实验支撑，且 locator 指得出位置；
- `doubt` 存疑 —— 有反例 / 证据不完整 / 只在单一来源；
- `unverified` 未验证 —— 默认态，agent 首轮读完后按证据升级，**人可随时改回**。

结论口径：写「已验证」必须同时给出 `[@key locator]` 或可复现的实验描述；给不出就留在 `unverified`，别用「据研究」「普遍认为」这种无主陈述冒充验证。

## 文献层三条腿（都用，别只挑一条）

1. **本地键**：BibTeX / CSL-JSON 导入 → `library.json`，`citeKey` 是引用键（重键自动补 `b/c`）。
2. **在线元数据**：DOI → Crossref；标题检索 → Crossref / arXiv / Semantic Scholar。抓回来先落库再引用，**先取后引**。
3. **PDF 全文**：`literature/pdf/<key>.md`，抽出来的正文可直接 grep 定位原文页码/章节，用于「这句话出处是哪一段」。

引用一律写 `[@key]`；引用别人的论断时把 locator 写上（页码 / 表格号 / 小节），这是「有据可查」的最低要求。

## 硬规则

- 只改 Markdown 正文（与 `library.json`、`init-queue.json` 的状态位）；**不要手改 `graph.json`、不要手写 `changes.jsonl`**。
- `init-queue.json` 只通过 `research-queue.mjs set` 改状态——手改容易漏 `phase`，界面会卡在「处理中」。
- 新增论断 = 新增 `> [!claim]` callout，不要另起一个孤立 md 文件（孤立节点等于没写）。
- 每条 `claim` 至少要有一条出边（引用 / 依赖 / 反驳），否则图谱上就是悬空断言。
- 图谱反向改正文只允许动 callout 块与 frontmatter 键，不动正文散文。
- 画布视图与画布节点**一律不碰**：研究视图与画布是两套内容，共用的是项目目录与顶栏。
