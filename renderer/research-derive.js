/* ===== 研究视图「衍生物」：生成 / 批量排队 / 导入 / 新建空稿 =====
 * renderer/research-derive.js · window.MTResearchDerive（自包含，样式由本模块注入 #rs-derive-css）
 *
 * 一句话：把一篇笔记派生成「同目录的兄弟稿」—— 默认是中译 / 英译 / 摘要 / 节选（规则表可配，
 * 见下面的「衍生规则表」一节；加一条 { lang: "ja" } 就多出日语译稿），
 * 文件名叫 `原名.<lang|kind>.md`，frontmatter 写 `parent / derived / lang`，
 * 落盘后顺手把父笔记的 `derives` 补上（图谱里那条 父 → 子 的推导边就是它），再刷左栏内容树。
 *
 * 六个入口（实现全在这一份里，宿主只负责摆按钮）：
 *   ①  ＋衍生   → 选类型（规则表里每一条 = 一种变体）与语言，生成一份
 *   ②  批量     → 同一篇一次勾多个变体，串行排队生成；进度回显在顶栏 chip，可取消
 *   ③  导入 md  → 选一个已有 .md，填 parent / derived / lang，复制进目标目录
 *   ④  右键新建 → 树上右键「新建衍生稿」：只落一个带 frontmatter 壳的空稿（由 app-research-tree.js 调）
 *   ⑤  生成所选 → 树上 Ctrl / Shift 多选后（右键菜单 / 阅读区入口条）：每篇归到它的版本组，
 *      补上组里还没有的变体一次排队；目标已存在的项不排队，在面板里逐条点名
 *   ⑥  扩散到其他版本 → 金色版本（被改过、待扩散）把正文推回同组其它版本（入口：树上右键「扩散到其他版本…」）：
 *      目标默认全组其它版本、可勾选；同种类同语言直接覆盖，跨语言 / 跨种类走同一根 ctx.generate
 *      （buildPrompt 复用，输入换成金色版正文）；逐项写盘 + logChange，串行不并发；
 *      任一项失败就保留金色并逐条报原因，全部成功才 markBaseline（整组回绿）
 *
 * 生成走宿主给的 `ctx.generate`：app-research.js 里接到的是「框选询问」那条同一个文本生成通道
 * （apiCallTextStream + 当前服务商的首个文本模型）。渲染层拿不到 agent 子代理的原生入口，
 * 也不该为「改写一篇稿子」另开一条模型通道 —— 所以这里只认宿主注进来的那一根管子，
 * 管子没接上就报「模型不可用」，不自己猜服务商、不偷偷降级成本地模板。
 *
 * 花 Token 前一律先确认（用户共识）：单篇 / 批量 / 生成所选 / 一致化四条路都先弹确认窗，
 * 列清「哪一篇的哪种变体、写到哪」；点取消就一个字节不动、一次模型都不调。
 * 运行中一律可见可停（用户共识）：每次生成都登记进 window.MTNodeDeriveRuns，
 * app.js 的左下角运行队列因此有这一行（点行回研究视图、■ 精确中止那次请求），
 * 起 / 进度 / 收尾同时记进会话活动流（ctx.act，kind=derive，结果路径可点开）。
 *
 * 失败一律给具体原因（模型不可用 / 目标已存在 / parent 不存在 / 返回空内容），不静默吞：
 * 单项失败进 chip 的「失败 N」并 toast 出原文，队列接着跑后面的项（一项失败不中断整批）。
 *
 * 与 research-core.js 的衍生物约定同一口径：子记 `parent`（也认 parents / derivedFrom…），
 * 父记 `derives: [衍生物标题]`；两条声明在 buildGraph 里按 端点+种类 去重，不会画成两条平行线。
 */
(function () {
  "use strict";

  const CSS_ID = "rs-derive-css";

  /* ── 衍生规则表（种类 + 语言）· 每页一份 ──
   * 表只有一份口径，在 renderer/research-versions.js：DEFAULT_RULES / normalizeRules / rules /
   * setRules / tables / setTables / tableFor / rulesFor / setTable。本模块**不复制第二份表**，只做两件事：
   *   ① 把 research.json 里 `ui.deriveRules`（默认表 = 新页默认值）与 `ui.deriveRulesByPage`
   *      （每页一份，键 = 页的相对路径）读出来交给版本组内核，于是某页新加的语言
   *      （ja / fr…）只会得到**这一页**的 notes/原名.<lang>.md 与 frontmatter `derived` + `lang`，
   *      别的页的入口条不会跟着多出一颗 chip；
   *   ② 用户改完某一页的表再写回 ui.deriveRulesByPage 的同一个键（其余键一个不动），
   *      见 create() 里的 loadRules / saveRules。默认那四条（中译 / 英译 / 摘要 / 节选）
   *      只在「这个键根本不存在」时由内核的 normalizeRules 兜底；键在、值是空数组 = 这一页的空表。 */
  function kernel() {
    return typeof window !== "undefined" && window.MTResearchVersions ? window.MTResearchVersions : null;
  }
  /* 当前生效的规则表（内核缺席 / 还没读盘时给空数组：面板就不列变体，不猜） */
  function rules() {
    const V = kernel();
    if (!V || typeof V.rules !== "function") return [];
    const list = V.rules();
    return Array.isArray(list) ? list : [];
  }
  /* 某一页生效的表（每页一份：没有这个键就落到「新页默认值」，键在但是空数组 = 这一页的空表 → 空数组）。
     页 = research/ 里的一个 md（notes/xx.md / core/xx.md），它的相对路径就是键。 */
  function rulesFor(pagePath) {
    const V = kernel();
    if (!V) return [];
    if (typeof V.rulesFor === "function") {
      const list = V.rulesFor(pagePath);
      return Array.isArray(list) ? list : [];
    }
    return rules();
  }
  /* 语言下拉的选项 = 表里出现过的语言（不再另写一张 LANGS） */
  function languages(list) {
    const V = kernel();
    if (V && typeof V.languages === "function") return V.languages(list);
    const out = [];
    for (const k of Array.isArray(list) && list.length ? list : rules()) {
      if (!k.lang || out.some((x) => x.id === k.lang)) continue;
      out.push({ id: k.lang, label: k.lang });
    }
    return out;
  }
  const NO_RULE = { id: "", label: "", derived: "", lang: "", suffix: "", hint: "" };
  /* 语言显示名（zh → 中文 / en → English / ja → 日本語…）：整张映射表也在内核里 */
  function langLabel(id) {
    const V = kernel();
    if (V && typeof V.langLabel === "function") return V.langLabel(id);
    return String(id || "");
  }
  /* 变体：先问内核（同一份表 + 同一套兜底），内核缺席时按传进来的那份表找。
     第三个参数 rulesArg 是「这一页生效的表」；不传就按默认表 —— 与内核的口径一致。 */
  function kindOf(id, rulesArg) {
    const V = kernel();
    if (V && typeof V.kindOf === "function") {
      const k = V.kindOf(id, rulesArg);
      if (k) return k;
    }
    const list = Array.isArray(rulesArg) && rulesArg.length ? rulesArg : rules();
    for (let i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return list[0] || NO_RULE;
  }
  /* 译稿的语言由变体本身决定（中译就是中文），摘要 / 节选用用户选的那个语言 */
  function langOf(kindId, lang, rulesArg) {
    const V = kernel();
    if (V && typeof V.langOf === "function") return V.langOf(kindId, lang, rulesArg);
    const k = kindOf(kindId, rulesArg);
    if (k.derived === "translate") return String(k.lang || "").trim();
    return String(lang || k.lang || "zh").trim() || "zh";
  }
  /* 同目录兄弟文件：notes/40-hardy.md → notes/40-hardy.zh.md / notes/40-hardy.ja.md */
  function targetRel(parentRel, kindId, lang, rulesArg) {
    const V = kernel();
    if (V && typeof V.targetRel === "function") return V.targetRel(parentRel, kindId, lang, rulesArg);
    return "";
  }
  /* 原名.<后缀>.md → 原文路径（后缀认哪些由规则表定，不写死 zh|en|summary|excerpt） */
  function originalOfVariant(rel) {
    const V = kernel();
    const p = normRel(rel);
    if (!V || typeof V.suffixOf !== "function" || !p) return "";
    const s = V.suffixOf(p);
    return s && s.base ? dirOf(p) + s.base + ".md" : "";
  }
  /* 某语言的译稿规则 id（扩散「原文 → 译稿」时用）；rulesArg 给「这一页的表」 */
  function kindIdForLang(lang, rulesArg) {
    const lg = String(lang || "").trim().toLowerCase();
    if (!lg) return "";
    const list = Array.isArray(rulesArg) && rulesArg.length ? rulesArg : rules();
    for (const k of list) if (k.derived === "translate" && k.lang === lg) return k.id;
    return "";
  }

  /* ── 纯函数（宿主、自检都走这一份，不碰 DOM）── */

  function normRel(p) {
    return String(p == null ? "" : p)
      .replace(/\\/g, "/")
      .replace(/^\.\//, "")
      .replace(/\/+/g, "/");
  }
  function dirOf(rel) {
    const s = normRel(rel);
    const i = s.lastIndexOf("/");
    return i < 0 ? "" : s.slice(0, i + 1);
  }
  function baseNoExt(rel) {
    const s = normRel(rel);
    return s.slice(s.lastIndexOf("/") + 1).replace(/\.md$/i, "");
  }
  function fmScalar(v) {
    const s = String(v == null ? "" : v).trim();
    if (!s) return "";
    if (/[:#[\]{}",]/.test(s) || /^\s|\s$/.test(s)) return JSON.stringify(s);
    return s;
  }
  function unquote(s) {
    const v = String(s == null ? "" : s).trim();
    if (v.length >= 2 && ((v[0] === '"' && v[v.length - 1] === '"') || (v[0] === "'" && v[v.length - 1] === "'")))
      return v.slice(1, -1);
    return v;
  }

  /* 父笔记补一条 derives —— **只动 frontmatter 里的那几行**，其余字节一个不碰。
     为什么不走 parseFrontmatter → stringifyFrontmatter 往返：那会把父笔记整块头部重新序列化
     （引号、注释、没见过的键都可能变形），而这里只想加一行反记。四种形态都认：
       ① `derives: [a, b]`（内联数组）→ 往数组里追加
       ② `derives:` + `  - a`（块列表）→ 在最后一项后面插一行
       ③ `derives: a`（单个标量）   → 改写成块列表
       ④ 压根没有 derives 键        → 在闭合 `---` 前补一行
     已经有了就原样返回（幂等：同一条边不会因为重跑多记一次）。 */
  function withDerives(md, title) {
    const src = String(md == null ? "" : md);
    const name = String(title == null ? "" : title).trim();
    if (!name) return src;
    const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(src);
    if (!m) return "---\nderives: [" + fmScalar(name) + "]\n---\n\n" + src.replace(/^\s*\n/, "");
    const head = m[1];
    const at = m[0].indexOf(head);
    const lines = head.split(/\r?\n/);
    const put = (next) => src.slice(0, at) + next.join("\n") + src.slice(at + head.length);
    for (let i = 0; i < lines.length; i++) {
      const kv = /^([A-Za-z0-9_\u4e00-\u9fa5.-]+):[ \t]*(.*)$/.exec(lines[i]);
      if (!kv || kv[1] !== "derives") continue;
      const val = kv[2].trim();
      if (/^\[.*\]$/.test(val)) {
        const inner = val.slice(1, -1).trim();
        const items = inner
          ? inner
              .split(",")
              .map(unquote)
              .filter(Boolean)
          : [];
        if (items.indexOf(name) >= 0) return src;
        lines[i] = "derives: [" + items.concat([name]).map(fmScalar).join(", ") + "]";
        return put(lines);
      }
      if (!val) {
        let j = i + 1;
        let last = i;
        const items = [];
        while (j < lines.length && /^[ \t]+-(\s|$)/.test(lines[j])) {
          items.push(unquote(lines[j].replace(/^[ \t]+-\s*/, "")));
          last = j;
          j += 1;
        }
        if (items.indexOf(name) >= 0) return src;
        lines.splice(last + 1, 0, "  - " + fmScalar(name));
        return put(lines);
      }
      if (unquote(val) === name) return src;
      lines[i] = "derives:\n  - " + fmScalar(unquote(val)) + "\n  - " + fmScalar(name);
      return put(lines);
    }
    lines.push("derives: [" + fmScalar(name) + "]");
    return put(lines);
  }

  /* 提示词：各变体各自的硬要求。共同点是「只输出正文」——
     模型带来的开场白 / 整篇围栏会在 cleanOut 里再兜一层。
     现行默认表 = 中译 / 英译 + 3-Pass 三条（略读 / 关键概念 / 技术细节）；
     摘要与节选两条分支只为「用户手工把旧种类加回页表」保留，默认表不再产出它们。 */
  function bodyOf(md) {
    const src = String(md == null ? "" : md).replace(/^\uFEFF/, "");
    const m = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(src);
    return (m ? src.slice(m[0].length) : src).replace(/^\s*\n/, "");
  }
  /* opts.label：只换「派生出一份 X 稿」里的 X（扩散到「原文」时用「原文」，
     规则表里没有 original 这一档，其它一律照 kindId 的 label 走）。
     opts.table：这一页生效的规则表 —— 变体名 / 语言都按它算（某页自己加的「日语」也能出对提示词）。 */
  function buildPrompt(kindId, lang, parentTitle, parentPath, md, opts) {
    const tbl = opts && Array.isArray(opts.table) && opts.table.length ? opts.table : null;
    const k = kindOf(kindId, tbl);
    const label = String((opts && opts.label) || "").trim() || k.label;
    const lg = langOf(kindId, lang, tbl);
    /* 目标语言取规则表的语言显示名（zh → 中文、en → English、ja → 日本語…），不写死中英两档 */
    const target = langLabel(lg) || lg || "中文";
    const head =
      k.derived === "translate"
        ? "你在协助一个研究课题：把下面这篇 Markdown 笔记派生出一份「" + label + "」稿（目标语言：" + target + "）。"
        : "你在协助一个研究课题：把下面这篇 Markdown 笔记派生出一份「" + label + "」稿。";
    let rules = "";
    if (k.derived === "translate") {
      rules = [
        "要求：",
        "① 逐段译，一段不落：不摘要、不删节、不增补观点、不合并段落；",
        "② 结构原样保留：标题层级（# / ##）、列表、表格、引用块、`> [!claim]` / `> [!term]` 这类 callout 的种类与标题、代码块围栏与语言标记；",
        "③ `[[双链]]` 里的笔记标题与 `[@引用键]` 本身不译（只译叙述文字），术语按 ④ 另写成 [[译名]]；`$…$` 与 `$$…$$` 公式一个字符都不改；",
        "④ 术语直接写成 `[[译名]]`（它本身就是可点的那一段），不加「（原词）」这类括注，反复出现也只写译名；原词写进那篇术语笔记 frontmatter 的 `aliases`；专名保留原文；",
      ].join("\n");
    } else if (k.derived === "skim") {
      /* 3-Pass · 第 1 遍：只回答「这篇贡献是什么、证据够不够、边界在哪」。
         刻意**不**要求它复述方法细节 —— 那是第 3 遍的活，混在一起就又变成摘要。 */
      rules = [
        "这是 3-Pass 阅读法的第 1 遍（略读）。目标是让人读完这一段就能回答：这篇论文的贡献是什么、凭什么成立、哪里不成立。",
        "要求：",
        "① 开头一句话给贡献（「它主张……，靠的是……，因此……」这种能站住的句子，不要「本文研究了」这类空话）；",
        "② 接着 1–2 段给证据强度：数据 / 实验 / 证明是什么量级，哪一条最关键；",
        "③ 再一段给边界与未解：作者自己承认的限制 + 你看出来的适用边界（没写就明说「原文未给出」）；",
        "④ 总长控制在 200–320 字（中文）/ 120–200 词（英文）；不复述公式推导，术语用 `[[术语名]]` 链到术语页；",
        "⑤ 不编造原文没有的内容。",
      ].join("\n");
    } else if (k.derived === "concept") {
      /* 3-Pass · 第 2 遍：把核心概念讲到有直觉。可视化优先引用**原文里的图**
         （初始化时图元已落盘在 core/assets/<md>/ 下，正文里有相对路径），必要时补 Mermaid。 */
      rules = [
        "这是 3-Pass 阅读法的第 2 遍（关键概念）。目标是让没读过原文的人对核心概念建立直觉，而不是记住定义。",
        "要求：",
        "① 先列 3–6 个核心概念，每个三段：`简要定义：……`（一句能独立看懂的话，换句话讲清它是什么）→ `简化解释：……`（打比方 / 极端例子 / 它排除了什么）→ 它在本文里的作用；",
        "② **优先引用原文里已有的图**：原文正文里以 `![…](…/assets/…)` 或 `![…](…)` 出现的图，按原相对路径原样搬进来（一节最多两张），图下一行写「图注：这张图在说什么」；不要重新画同一张图；",
        "③ 原文没有合适的图、而概念之间有关系需要看清时，补一张 ```mermaid 关系图（≤12 个节点，边上写动词）；没有就不补，不要硬凑；",
        "④ 概念名一律写成 `[[概念名]]`（可点、能继续引申），首次出现时括号里给原文英文词；",
        "⑤ 不复述公式推导、不列实验数字 —— 那是第 3 遍的活。",
      ].join("\n");
    } else if (k.derived === "tech") {
      /* 3-Pass · 第 3 遍：规格级复述，公式与实验设置一个不落，但**不做新推导**。 */
      rules = [
        "这是 3-Pass 阅读法的第 3 遍（技术细节）。目标是让人不看原文也能把方法复现出来。",
        "要求：",
        "① 按原文顺序复述方法与推导：每一步的输入、操作、输出写清；公式**逐字保留**（`$…$` / `$$…$$` 一个字符都不改），并给每个符号一句含义；",
        "② 实验设置写成表：数据集 / 规模 / 指标 / 基线 / 超参 / 训练细节（原文没写的格子写「未给出」，不要猜）；",
        "③ 关键数字（提升幅度、显著性、消融结果）照抄原文，并标出处小节；",
        "④ 原文没写的推导一律标注「本文未展开」，不要替作者补证明；",
        "⑤ 术语首次出现写成 `[[术语名]]`。",
      ].join("\n");
    } else if (k.derived === "summary") {
      rules = [
        "要求：",
        "① 3–8 段，先给结论与主结果，再给关键方法 / 前提 / 证据；",
        "② 保留必要的公式、数字、`[[双链]]` 与 `[@引用键]`（原样，不改写）；",
        "③ 关键结论后面用「（摘自 <章节标题>）」标出处；",
        "④ 不编造原文没有的内容；原文没结论就写「原文未给出结论」。",
      ].join("\n");
    } else {
      /* 节选：默认按原文逐字抽段。但规则表允许「节选 · 日本語」这种目标语言 ——
         目标语言与原文语言不同时必须跟着译，否则出一份语言不对的稿子（真机报过）。 */
      const srcLang = String((opts && opts.parentLang) || "").trim().toLowerCase();
      const needTr = !!srcLang && !!lg && srcLang !== String(lg).toLowerCase();
      rules = needTr
        ? [
            "要求：",
            "① 先按原文挑出承载论证的段落，再把这些段落逐句译成目标语言（" + target + "）：不改写、不串接、不补句子、不调整段落顺序；术语直接写成 `[[译名]]`（不加「（原词）」这类括注），原词写进那篇术语笔记 frontmatter 的 `aliases`；专名保留原文；",
            "② 每段前面单独一行 `> 摘自 <章节标题>` 标出处（章节标题也译成目标语言）；",
            "③ 按原文顺序排列；保留块里的 callout 种类、公式与引用键（公式一个字符都不改）；",
            "④ 只抽真正承载论证的段落，宁少不多。",
          ].join("\n")
        : [
            "要求：",
            "① 逐字引用原文，不改写、不串接、不补句子、不调整语序；",
            "② 每段前面单独一行 `> 摘自 <章节标题>` 标出处；",
            "③ 按原文顺序排列；保留块里的 callout 种类、公式与引用键；",
            "④ 只抽真正承载论证的段落，宁少不多。",
          ].join("\n");
    }
    const tail = [
      "输出格式：只输出 Markdown 正文 —— 不要 frontmatter（`---` 头部）、不要用代码围栏把整篇包起来、不要写「以下是译文」这类开场白。",
      "",
      "原文（笔记《" + parentTitle + "》，路径 " + parentPath + "）：",
      "",
      bodyOf(md),
    ].join("\n");
    return head + "\n" + rules + "\n\n" + tail;
  }

  /* 模型回来的正文洗一遍：去掉整篇包着的 ``` 围栏、去掉自己加的 frontmatter、
     去掉首尾空行（这三样是「输出格式」那条要求最常见的漏网之鱼）。 */
  function cleanOut(text) {
    let s = String(text == null ? "" : text).replace(/\r\n/g, "\n");
    s = s.trim();
    const fm = /^---[ \t]*\n[\s\S]*?\n---[ \t]*(?:\n|$)/;
    if (fm.test(s)) s = s.replace(fm, "").replace(/^\s*\n/, "");
    const fence = /^```[A-Za-z0-9_-]*[ \t]*\n([\s\S]*?)\n```[ \t]*$/;
    const m = fence.exec(s);
    if (m) s = m[1];
    return s.replace(/^\s*\n/, "").replace(/\s+$/, "") + "\n";
  }

  /* 落盘的正文：frontmatter 走内核的 stringifyFrontmatter（与其它笔记同一套序列化），
     没有内核时用同一口径的兜底实现。 */
  function composeDoc(C, meta, body) {
    const keys = Object.keys(meta || {}).filter((k) => {
      const v = meta[k];
      return v != null && v !== "" && !(Array.isArray(v) && !v.length);
    });
    if (C && typeof C.stringifyFrontmatter === "function") {
      const obj = {};
      for (const k of keys) obj[k] = meta[k];
      return C.stringifyFrontmatter(obj, "\n" + String(body || "").replace(/^\s*\n/, ""));
    }
    const lines = ["---"];
    for (const k of keys) {
      const v = meta[k];
      lines.push(k + ": " + (Array.isArray(v) ? "[" + v.map(fmScalar).join(", ") + "]" : fmScalar(v)));
    }
    lines.push("---");
    return lines.join("\n") + "\n\n" + String(body || "").replace(/^\s*\n/, "");
  }

  /* ── 样式（只挂 .rs-dv* 与 .rs-derive-chip，不动 research.css 里已有的那套）── */
  const CSS = [
    ".rs-dv-mask{position:fixed;inset:0;z-index:9998;background:rgba(0,0,0,.32);display:flex;",
    "align-items:flex-start;justify-content:center;padding-top:9vh;}",
    ".rs-dv{width:min(560px,92vw);max-height:78vh;display:flex;flex-direction:column;background:var(--panel);",
    "border:1px solid var(--bd2);border-radius:12px;box-shadow:0 18px 48px rgba(0,0,0,.36);overflow:hidden;}",
    ".rs-dv-head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--bd);}",
    ".rs-dv-head b{font-size:13px;color:var(--ink);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
    ".rs-dv-path{flex:1 1 auto;min-width:0;font-size:11px;color:var(--muted);overflow:hidden;",
    "text-overflow:ellipsis;white-space:nowrap;}",
    ".rs-dv-x{border:0;background:transparent;color:var(--muted);font-size:13px;cursor:pointer;padding:2px 6px;border-radius:6px;}",
    ".rs-dv-x:hover{background:var(--panel2);color:var(--ink);}",
    ".rs-dv-body{padding:12px;overflow:auto;display:flex;flex-direction:column;gap:10px;}",
    ".rs-dv-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}",
    ".rs-dv-k{flex:0 0 40px;font-size:11.5px;color:var(--muted);}",
    ".rs-dv-kinds{display:flex;gap:6px;flex-wrap:wrap;}",
    ".rs-dv-kind{border:1px solid var(--bd);background:var(--panel2);color:var(--ink);font-size:12px;",
    "padding:4px 12px;border-radius:999px;cursor:pointer;}",
    ".rs-dv-kind.on{border-color:var(--cyan);color:var(--cyan);}",
    ".rs-dv-kind small{display:block;font-size:10px;color:var(--muted);}",
    ".rs-dv-sel{background:var(--panel2);border:1px solid var(--bd);color:var(--ink);font-size:12px;",
    "padding:3px 6px;border-radius:6px;}",
    ".rs-dv-hint{font-size:11px;color:var(--muted);}",
    ".rs-dv-target{font-size:11.5px;color:var(--ink);background:var(--panel2);border:1px solid var(--bd);",
    "border-radius:6px;padding:2px 6px;}",
    ".rs-dv-vars{display:flex;flex-direction:column;gap:4px;padding:2px 0 0 48px;}",
    ".rs-dv-var{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--ink);cursor:pointer;}",
    ".rs-dv-var code{font-size:11px;color:var(--muted);}",
    /* 多选批量面板：按版本组列 jobs + 点名跳过项 */
    ".rs-dv-many{display:flex;flex-direction:column;gap:8px;max-height:40vh;overflow:auto;padding:2px 0;}",
    ".rs-dv-many-group{display:flex;flex-direction:column;gap:2px;}",
    ".rs-dv-many-base{font-size:11.5px;color:var(--muted);}",
    ".rs-dv-many-row{display:flex;align-items:baseline;gap:8px;font-size:12px;color:var(--ink);}",
    ".rs-dv-many-row code{font-size:11px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;",
    "white-space:nowrap;}",
    ".rs-dv-many-row.bad code{color:var(--red);}",
    ".rs-dv-many-kind{flex:0 0 auto;font-size:11px;color:var(--cyan);}",
    ".rs-dv-err{min-height:0;padding:0 12px;font-size:11.5px;color:var(--red);white-space:pre-wrap;}",
    ".rs-dv-foot{display:flex;align-items:center;gap:8px;padding:10px 12px;border-top:1px solid var(--bd);}",
    ".rs-dv-foot .rs-grow{flex:1 1 auto;}",
    ".rs-dv-open{border:0;background:transparent;color:var(--muted);font-size:11.5px;cursor:pointer;",
    "text-decoration:underline;padding:0;}",
    ".rs-derive-chip{display:inline-flex;align-items:center;gap:6px;border-radius:999px;font-size:11.5px;",
    "padding:2px 4px 2px 10px;border:1px solid var(--bd2);background:var(--panel2);color:var(--ink);}",
    ".rs-derive-chip.on{border-color:var(--cyan);color:var(--cyan);}",
    ".rs-derive-chip.bad{border-color:var(--red);color:var(--red);}",
    ".rs-derive-chip button{border:0;background:transparent;color:inherit;font-size:11px;cursor:pointer;",
    "padding:1px 6px;border-radius:999px;}",
    ".rs-derive-chip button:hover{background:var(--panel);}",
    ".rs-read-tools{display:flex;align-items:center;gap:6px;padding:6px 10px 2px;flex-wrap:wrap;}",
    ".rs-read-tools:empty{display:none;}",
    ".rs-read-tools .rs-grow{flex:1 1 auto;}",
    ".rs-read-tools .rs-tool{font-size:11.5px;}",
    /* 顶栏 chip 的槽位：没有进度时是空的，不占宽度 */
    ".rs-derive-chip-host{display:inline-flex;align-items:center;}",
  ].join("\n");

  function ensureCss(doc) {
    const d = doc || document;
    if (d.getElementById(CSS_ID)) return;
    const st = d.createElement("style");
    st.id = CSS_ID;
    st.textContent = CSS;
    d.head.appendChild(st);
  }

  /* ── 实例 ── */
  function create(ctx) {
    const el = ctx.el;
    const t = ctx.t || ((s) => s);
    const api = ctx.api || (typeof window !== "undefined" ? window.api : null);

    ensureCss(typeof document !== "undefined" ? document : null);

    /* 队列状态（批量与单项共用一份；顶栏 chip 读它，取消按钮也改它） */
    const D = {
      items: [], // [{parentPath, kindId, lang, label, rel}]
      total: 0,
      done: 0,
      failed: 0,
      err: "",
      cur: "",
      running: false,
      cancelled: false,
    };
    /* 扩散状态（金色版本 → 整组）：与生成队列各一份，共用一个顶栏槽位（两块 chip 并排） */
    const S = {
      items: [], // [{path, kind, lang, mode, label}]（本次要写的目标，按组内顺序）
      gold: "",
      total: 0,
      done: 0,
      failed: 0,
      err: "",
      cur: "",
      running: false,
      cancelled: false,
      fails: [], // [{path, why}] —— 逐条点名，失败的项保留金色正文
      green: false, // 全部成功并记过基线 = 整组回绿
    };

    /* ── 写盘互斥：生成队列与扩散队列共用一把锁 ──
     * 「不并发写同一组」不是靠调用顺序碰运气：两条队列各自串行，但两条之间可能同时在跑
     * （一边补变体、一边扩散），所以真正写盘的那一步统一排队，任何时刻只有一项在写文件。 */
    let writeChain = Promise.resolve();
    function withWriteLock(fn) {
      const run = writeChain.then(fn, fn);
      writeChain = run.then(
        () => {},
        () => {},
      );
      return run;
    }

    /* ── 花 Token 前先问一句（用户共识：每次生成都确认）──
     * 「单篇就地生成 / 批量排队 / 生成所选变体 / 一致化」四条路都会调模型，以前点一下就烧 Token。
     * 走宿主那只单例确认窗（app.js 的 confirmDialog）；宿主没接上才退化成 window.confirm，
     * 绝不因为拿不到宿主就直接放行 —— 那样这条共识等于没做。 */
    async function askConfirm(o) {
      const opt = o || {};
      const msg = String(opt.message || "");
      try {
        if (typeof confirmDialog === "function")
          return !!(await confirmDialog(msg, {
            title: opt.title || t("生成变体"),
            okText: opt.okText || t("生成"),
            cancelText: t("取消"),
          }));
      } catch (_) {}
      try {
        if (typeof window !== "undefined" && typeof window.confirm === "function")
          return !!window.confirm(msg);
      } catch (_) {}
      return false;
    }
    /* 一次单项生成要花什么、写到哪儿 —— 确认文案与生成都按这一份算（不各算一遍） */
    function planOne(job) {
      const j = job || {};
      const parentPath = normRel(j.parentPath || "");
      const tbl = rulesFor(parentPath);
      const k = kindOf(j.kindId, tbl);
      const rel = j.rel || targetRel(parentPath, j.kindId, j.lang, tbl);
      return {
        parentPath: parentPath,
        rel: rel || "",
        kindLabel: (k && k.label) || String(j.label || j.kindId || ""),
        title: String((noteOf(parentPath) || {}).title || baseNoExt(parentPath)),
      };
    }
    async function confirmGen(job) {
      const p = planOne(job);
      if (!p.parentPath) return true;
      return askConfirm({
        message:
          t("将生成 1 篇衍生稿（会调用模型，消耗 Token）：") +
          "\n\n" +
          t("原文：") +
          p.title +
          "\n" +
          p.parentPath +
          "\n" +
          t("变体：") +
          p.kindLabel +
          "\n" +
          t("目标：") +
          (p.rel || "—"),
        okText: t("生成"),
      });
    }
    async function confirmJobs(list) {
      const items = (list || []).filter(Boolean);
      if (!items.length) return true;
      const paths = items.map((j) => planOne(j).rel).filter(Boolean);
      const head = paths.slice(0, 8);
      const tail = paths.length > head.length ? "\n" + t("……等 ") + paths.length + t(" 项") : "";
      return askConfirm({
        message:
          t("将排队生成 ") +
          items.length +
          t(" 篇衍生稿（会调用模型，逐条串行，消耗 Token）：") +
          "\n\n" +
          head.join("\n") +
          tail,
        okText: t("开始生成"),
      });
    }

    /* ── 在途登记（左下角运行队列 + 会话活动流）──
     * 用户共识：模型跑的那几十秒要看得见、停得掉。以前只有研究视图顶栏那颗 chip 知道这件事，
     * 离开这一页就完全看不见，也没有停止入口。
     *   ① 登记一份到 window.MTNodeDeriveRuns.rows（app.js 的 collectRunQueueAll 读它出
     *      「左下角运行队列」的一行：点行回研究视图、行内 ■ = row.stop() + abKey 精确中止）；
     *   ② 起 / 进度 / 收尾各记一条进会话活动流（ctx.act，kind=derive）——
     *      会话视图里能看到这次运行与它的结果，结果路径可点开。
     * 行对象字段与 app.js 那边的读法一一对应，别只改一侧。 */
    const RUNS =
      typeof window !== "undefined"
        ? (window.MTNodeDeriveRuns = window.MTNodeDeriveRuns || { rows: new Map() })
        : { rows: new Map() };
    function runPoke() {
      try {
        if (typeof updateRunQueuePanel === "function") updateRunQueuePanel();
      } catch (_) {}
    }
    function actNote(row, text, status) {
      if (!text) return;
      try {
        if (typeof ctx.act === "function")
          ctx.act({
            kind: "derive",
            title: (row && row.title) || t("变体"),
            text: String(text),
            path: (row && row.path) || "",
            status: String(status || ""),
          });
      } catch (_) {}
    }
    function runBegin(o) {
      const opt = o || {};
      const key = "dv" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const row = {
        key: key,
        abKey: "derive:" + key,
        title: String(opt.title || t("生成变体")),
        sub: String(opt.sub || ""),
        stateText: String(opt.stateText || ""),
        kindCls: "derive",
        kindLabel: t("变体"),
        startedAt: Date.now(),
        path: String(opt.path || ""),
        parentPath: String(opt.parentPath || ""),
        /* 这一批「停」怎么做由调用方给（队列停整批 / 单项只举旗）；app.js 点 ■ 时调它 */
        stop: typeof opt.stop === "function" ? opt.stop : null,
      };
      try {
        RUNS.rows.set(key, row);
      } catch (_) {}
      runPoke();
      actNote(row, opt.text || t("开始生成变体：") + row.title, "run");
      return { key: key, abKey: row.abKey };
    }
    function runSay(run, o) {
      const row = run && RUNS.rows ? RUNS.rows.get(run.key) : null;
      if (!row) return;
      const opt = o || {};
      if (opt.stateText != null) row.stateText = String(opt.stateText);
      if (opt.path) row.path = String(opt.path);
      if (opt.stop) row.stop = opt.stop;
      runPoke();
      actNote(row, opt.text, opt.status);
    }
    function runEnd(run, text, status) {
      const row = run && RUNS.rows ? RUNS.rows.get(run.key) : null;
      if (!row) return;
      try {
        RUNS.rows.delete(run.key);
      } catch (_) {}
      runPoke();
      actNote(row, text || t("变体生成已结束"), status || "ok");
    }
    /* 用户点了停：先让队列收手（stop()），再按 abKey 中止此刻在途的那次模型请求。
       中止后 runOne 会抛错，调用方按「已取消」结算（不当失败报红）。 */
    function cancelError() {
      const e = new Error(t("已取消：用户终止了这次生成"));
      e.cancelled = true;
      return e;
    }

    /* ── 小工具 ── */
    function root() {
      try {
        return String((ctx.root && ctx.root()) || "");
      } catch (_) {
        return "";
      }
    }
    function joinP() {
      const list = Array.prototype.slice.call(arguments).filter((x) => x != null && String(x) !== "");
      if (api && api.pathJoin) return api.pathJoin.apply(api, list);
      return list.join("/").replace(/\/+/g, "/");
    }
    function core() {
      try {
        return ctx.C ? ctx.C() : null;
      } catch (_) {
        return null;
      }
    }
    async function readRel(rel) {
      const r = await api.fileReadText(joinP(root(), rel));
      return r && r.exists ? String(r.content || "") : "";
    }
    async function existsRel(rel) {
      try {
        const r = await api.fileStat(joinP(root(), rel));
        if (r && typeof r.ok === "boolean") return !!r.ok;
      } catch (_) {}
      return !!String(await readRel(rel)).length;
    }
    async function writeRel(rel, text) {
      return api.fileWriteText(joinP(root(), rel), String(text == null ? "" : text));
    }

    /* ── 规则表读写（research.json 的 ui.deriveRules + ui.deriveRulesByPage）──
     * 表本身只有一份口径（research-versions.js）；这里只管「读出来交给内核 / 把改动写回去」。
     * 读：默认表（ui.deriveRules，只当新页默认值）+ 每页一份（ui.deriveRulesByPage，键 = 页路径），
     *     宿主注入了 ctx.rules() 就以宿主那份默认表为准，页表仍读文件；
     * 写：宿主注入了 ctx.saveMeta 就交给它（它手里才是整份 meta 的真相），否则自己改文件 ——
     *     两个分支都只动 ui.deriveRulesByPage 这一个键，别的键一个不碰。
     * 生效后内核的 suffixOf / kindIdOf / KIND_ORDER 一起跟新表走：新语言稿立刻归得进版本组。 */
    const META_FILE = "research.json";
    async function readMetaFile() {
      if (!api || typeof api.fileReadText !== "function") return null;
      const r = root();
      if (!r) return null;
      try {
        const res = await api.fileReadText(joinP(r, META_FILE));
        if (!res || !res.exists) return null;
        const raw = String(res.content || "").trim();
        if (!raw) return null;
        const meta = JSON.parse(raw);
        return meta && typeof meta === "object" ? meta : null;
      } catch (_) {
        return null;
      }
    }
    function applyRules(list) {
      const V = kernel();
      if (!V || typeof V.setRules !== "function") return rules();
      return V.setRules(list);
    }
    /* 页级表（ui.deriveRulesByPage）落到内核：整份换一次，界面口径立刻跟上 */
    function applyTables(obj) {
      const V = kernel();
      if (!V || typeof V.setTables !== "function") return null;
      return V.setTables(obj);
    }
    /* 读盘 → 生效。面板打开前 / 换工作目录后各调一次。
       两张表一起读：默认表（ui.deriveRules，只当新页默认值）+ 每页一份（ui.deriveRulesByPage）。
       **顺手做一次旧表迁移**：摘要 / 节选两条换成 3-Pass 三条（略读 / 关键概念 / 技术细节），
       迁移只写 research.json 的 ui 这一处，旧稿文件一个都不删（它们落成「非标准变体」）。 */
    async function loadRules() {
      const meta = await readMetaFile();
      let ui = (meta && meta.ui) || {};
      const V = kernel();
      if (V && typeof V.migrateUiRules === "function") {
        const mig = V.migrateUiRules(ui);
        if (mig.changed) {
          ui = mig.ui;
          const p2 = {};
          for (const k of ["deriveRules", "deriveRulesByPage"]) {
            if (ui[k] !== undefined) p2[k] = ui[k];
          }
          try {
            ui = await patchUi(p2);
          } catch (_) {
            /* 写不进去（只读目录 / 宿主没桥）就只在内存里生效，界面上照旧能生成 */
          }
        }
      }
      applyTables(ui.deriveRulesByPage);
      if (typeof ctx.rules === "function") {
        try {
          const v = ctx.rules();
          if (Array.isArray(v) && v.length) return applyRules(v);
        } catch (_) {}
      }
      return applyRules(ui.deriveRules);
    }
    /* 改 research.json 的 ui：只动传进来的那几个键，别的键一个不碰 */
    async function patchUi(patch) {
      const ui = Object.assign({}, await currentUi(), patch || {});
      if (typeof ctx.saveMeta === "function") {
        await ctx.saveMeta({ ui: ui });
        return ui;
      }
      const r = root();
      if (!r) throw new Error(t("还没有工作目录：先设置画布的工作目录"));
      if (!api || typeof api.fileWriteText !== "function") throw new Error(t("主进程没有写文件的接口"));
      const meta = (await readMetaFile()) || {};
      const out = Object.assign({}, meta, { ui: ui });
      const res = await api.fileWriteText(joinP(r, META_FILE), JSON.stringify(out, null, 2) + "\n");
      if (res && res.ok === false) throw new Error(String(res.error || t("写文件失败")));
      return ui;
    }
    /* 写一页的规则表：research.json 的 ui.deriveRulesByPage[页路径]（或宿主的 saveMeta）
       → 内核生效 → 刷左栏 / 顶栏 / 阅读区（徽标与判色跟着这张页表走）。
       传空数组 = 这一页的空表（键留着、值为 []）：平铺条只剩「原文」+「＋ 变体」，不出任何默认衍生物。 */
    async function saveRules(list, pagePath) {
      const V = kernel();
      if (!V || typeof V.normalizeRules !== "function") {
        throw new Error(t("版本模块没加载（renderer/research-versions.js）"));
      }
      const key = normRel(pagePath || "");
      if (!key) throw new Error(t("先打开一篇笔记：衍生规则表是每页一份"));
      const next = V.normalizeRules(list);
      /* 落盘只写有值的键（hint 空着就不写），表读起来跟手写的一样干净 */
      const saved = next.map((r) => {
        const o = { id: r.id, label: r.label, derived: r.derived, lang: r.lang, suffix: r.suffix };
        if (r.hint) o.hint = r.hint;
        return o;
      });
      const byPage = Object.assign({}, (await currentUi()).deriveRulesByPage || {});
      byPage[key] = saved;
      const ui = await patchUi({ deriveRulesByPage: byPage });
      applyTables(ui.deriveRulesByPage);
      if (typeof ctx.repaint === "function") {
        try {
          ctx.repaint();
        } catch (_) {}
      }
      return rulesFor(key);
    }
    /* 索引页（research.json 的 corePath，缺省 notes/00-课题.md）= 这棵库的索引根：
       它不需要衍生物，衍生入口一律不给。 */
    async function isIndexPage(rel) {
      const key = normRel(rel || "");
      if (!key) return false;
      const meta = await readMetaFile();
      const core = normRel((meta && meta.corePath) || "notes/00-课题.md");
      return !!core && key === core;
    }
    async function currentUi() {
      const meta = await readMetaFile();
      return (meta && meta.ui) || {};
    }
    /* 版本组内核（renderer/research-versions.js）：宿主注进来就用宿主那一份（与左栏树同一份 store），
       没注就自己建一个（同一根目录、同一批 notes，判据一样）。 */
    let verInst = null;
    function versions() {
      if (ctx.versions) return ctx.versions;
      if (verInst) return verInst;
      if (typeof window === "undefined" || !window.MTResearchVersions) return null;
      verInst = window.MTResearchVersions.create({
        root: () => root(),
        joinP: joinP,
        api: () => api,
        notes: () => notes(),
        t: t,
      });
      return verInst;
    }
    function notes() {
      try {
        return (ctx.notes && ctx.notes()) || [];
      } catch (_) {
        return [];
      }
    }
    function noteOf(rel) {
      const key = normRel(rel);
      return notes().filter((n) => normRel(n.path) === key)[0] || null;
    }
    function toast(msg, kind) {
      try {
        if (ctx.toast) ctx.toast(msg, kind || "ok");
      } catch (_) {}
    }
    function changed() {
      try {
        if (ctx.changed) ctx.changed();
      } catch (_) {}
    }
    async function reload() {
      try {
        if (ctx.reload) await ctx.reload();
      } catch (_) {}
    }
    function dateStr() {
      return new Date().toISOString().slice(0, 10);
    }
    function titleOf(parent, kindId, rulesArg) {
      const k = kindOf(kindId, rulesArg);
      const base = String((parent && parent.title) || baseNoExt((parent && parent.path) || "")).trim();
      return base + " · " + k.label;
    }
    /* 目标语言：父笔记声明过 lang 就用它，否则中文库按中文算 */
    function parentLang(rec) {
      const v = rec && rec.meta && rec.meta.lang;
      return String(v || "").trim() || "zh";
    }

    /* ── 生成一件：校验 → 调通道 → 落盘 → 补 derives → 刷树 ──
       abKey 是「停这一次」的把手：主进程按它注册这次请求，运行队列那一行点 ■ 就 apiAbort 它。 */
    async function runOne(job, abKey) {
      if (!root()) throw new Error(t("还没有工作目录：先设置画布的工作目录"));
      const parent = noteOf(job.parentPath);
      if (!parent) throw new Error(t("parent 不存在：") + job.parentPath);
      /* 索引页（corePath）是这棵库的索引根，不给它衍生稿 */
      if (await isIndexPage(parent.path)) throw new Error(t("索引页不需要衍生稿（它是这棵库的索引根）"));
      /* 这一页自己的表：它加了日语，不会让别的页也长出日语稿 */
      const tbl = rulesFor(parent.path);
      const rel = targetRel(parent.path, job.kindId, job.lang, tbl);
      /* 表里没有这条变体（排队期间被删掉 / 旧队列带来的）：明确报错，别拿空路径去写盘 */
      if (!rel) throw new Error(t("这一页的规则表里没有这条变体：") + job.kindId + t("（可能刚被删掉，重开一次面板再点）"));
      if (await existsRel(rel)) throw new Error(t("目标已存在：") + rel + t("（先删掉或改名再试）"));
      if (typeof ctx.generate !== "function") throw new Error(t("没有可用的文本模型（设置 · 模型服务）"));
      const k = kindOf(job.kindId, tbl);
      const lang = langOf(job.kindId, job.lang, tbl);
      const title = titleOf(parent, job.kindId, tbl);
      const prompt = buildPrompt(job.kindId, lang, String(parent.title || baseNoExt(parent.path)), parent.path, parent.md || "", {
        table: tbl,
        /* 原文语言：节选要按目标语言译（原文是同一种语言就不用译） */
        parentLang: parentLang(parent),
      });
      const raw = await ctx.generate(prompt, { abKey: abKey || "" });
      const body = cleanOut(raw);
      if (!String(body || "").trim()) throw new Error(t("模型返回空内容：") + rel + t("（换个模型或再试一次）"));
      const doc = composeDoc(core(), {
        title: title,
        kind: "note",
        derived: k.derived,
        parent: normRel(parent.path),
        lang: lang,
        tags: [],
        verify: "unverified",
        date: dateStr(),
      }, body);
      await api.fileWriteText(joinP(root(), rel), doc);
      if (ctx.logChange) await ctx.logChange(t("生成衍生稿 · ") + k.label, rel, "", doc);
      await addDerivesToParent(parent.path, title);
      return rel;
    }

    /* 记基线（只算 + 落 store）：失败不影响这一次生成已经落盘的结果，只让颜色晚一轮才对。
        必须在写盘之后调，且按**当前字节**算 —— 所以写完文件、把新正文同步进内存笔记之后再记。 */
    async function markBaselineQuiet(paths) {
      const list = (Array.isArray(paths) ? paths : [paths]).filter(Boolean);
      if (!list.length) return;
      try {
        const V = versions();
        if (!V || typeof V.markBaseline !== "function" || typeof V.commit !== "function") return;
        if (typeof V.ensureLoaded === "function") await V.ensureLoaded();
        /* 新写的文件还不在 notes() 里：按 rsLoadNotes 同一份字段补进内存，
           否则 markBaseline 会把这一篇当成 notfound（颜色仍是灰） */
        const arr = notes();
        for (const p of list) {
          const rel = normRel(p);
          if (!rel || noteOf(rel)) continue;
          try {
            const md = await readRel(rel);
            if (!md) continue;
            const C = core();
            const parsed = C && typeof C.parseNote === "function" ? C.parseNote({ path: rel, md: md }) : null;
            arr.push({
              path: rel,
              title: (parsed && parsed.note && parsed.note.label) || baseNoExt(rel),
              md: md,
              meta: (parsed && parsed.meta) || {},
              parsed: parsed,
              core: rel.indexOf("core/") === 0,
            });
          } catch (_) {}
        }
        const res = V.markBaseline(list);
        if (res && res.patch) await V.commit(res.patch);
      } catch (_) {}
    }

    /* 父笔记补 derives：父正开着就改内存里那一份（脏了也不丢），否则读盘改盘。
       只动 frontmatter 的一行，正文一个字节不碰。 */
    async function addDerivesToParent(parentPath, title) {
      const prev = String((ctx.currentMd && ctx.currentMd(parentPath)) || "") || (await readRel(parentPath));
      if (!prev) return;
      const next = withDerives(prev, title);
      if (next === prev) return;
      await api.fileWriteText(joinP(root(), parentPath), next);
      if (ctx.logChange) await ctx.logChange(t("补 derives 边"), parentPath, prev, next);
      if (typeof ctx.syncDoc === "function") ctx.syncDoc(parentPath, next);
    }

    /* ── 顶栏 chip：进度 + 取消（生成队列与扩散队列各一块，并排） ── */
    function paintChip(host) {
      if (!host) return;
      host.innerHTML = "";
      paintDeriveChip(host);
      paintSpreadChip(host);
    }

    function paintDeriveChip(host) {
      const live = D.running || D.total;
      if (!live) return;
      const chip = el("span", "rs-derive-chip");
      let text = "";
      if (D.running) {
        text = t("衍生 ") + Math.min(D.done + D.failed, D.total) + "/" + D.total + (D.cur ? " · " + D.cur : "");
        chip.classList.add("on");
      } else if (D.cancelled) {
        text = t("衍生已取消 · 完成 ") + D.done + "/" + D.total;
        chip.classList.add("bad");
      } else if (D.failed) {
        text = t("衍生完成 · 失败 ") + D.failed + "/" + D.total;
        chip.classList.add("bad");
      } else {
        text = t("衍生完成 · ") + D.done + "/" + D.total;
      }
      chip.appendChild(el("span", null, text));
      if (D.err) chip.title = D.err;
      if (D.running) {
        const x = el("button", null, t("取消"));
        x.title = t("取消排队：当前这一项跑完就停，已生成的不动");
        x.onclick = () => cancel();
        chip.appendChild(x);
      } else {
        const x = el("button", null, "✕");
        x.title = t("收起这条进度");
        x.onclick = () => {
          D.total = 0;
          D.done = 0;
          D.failed = 0;
          D.err = "";
          D.cancelled = false;
          changed();
        };
        chip.appendChild(x);
      }
      host.appendChild(chip);
    }

    /* 扩散进度：串行，一项一行；失败的那几项保留金色（不改文件），金色版本也保持金色 */
    function paintSpreadChip(host) {
      if (!S.running && !S.total) return;
      const chip = el("span", "rs-derive-chip");
      let text = "";
      if (S.running) {
        text = t("扩散 ") + Math.min(S.done + S.failed, S.total) + "/" + S.total + (S.cur ? " · " + S.cur : "");
        chip.classList.add("on");
      } else if (S.cancelled) {
        text = t("扩散已取消 · 完成 ") + S.done + "/" + S.total;
        chip.classList.add("bad");
      } else if (S.failed) {
        text = t("扩散完成 · 失败 ") + S.failed + "/" + S.total;
        chip.classList.add("bad");
      } else {
        text = t("扩散完成 · ") + S.done + "/" + S.total + (S.green ? t(" · 整组已同步") : "");
      }
      chip.appendChild(el("span", null, text));
      if (S.err) chip.title = S.err;
      if (S.running) {
        const x = el("button", null, t("取消"));
        x.title = t("取消扩散：当前这一项跑完就停，已写的不动");
        x.onclick = () => cancelSpread();
        chip.appendChild(x);
      } else {
        const x = el("button", null, "✕");
        x.title = t("收起这条进度");
        x.onclick = () => {
          S.total = 0;
          S.done = 0;
          S.failed = 0;
          S.err = "";
          S.fails = [];
          S.cancelled = false;
          S.green = false;
          changed();
        };
        chip.appendChild(x);
      }
      host.appendChild(chip);
    }

    function cancelSpread() {
      if (!S.running) return;
      S.cancelled = true;
      S.err = t("已取消（当前这一项跑完即停）");
      changed();
      toast(t("已取消：当前这一项跑完就停"), "warn");
    }

    function cancel() {
      if (!D.running) return;
      D.cancelled = true;
      D.items = [];
      D.err = t("已取消（当前这一项跑完即停）");
      changed();
      toast(t("已取消：当前这一项跑完就停"), "warn");
    }

    /* 串行跑队列：一项失败只记一笔，接着跑下一项；每项跑完刷一次树
       —— 整批同时在「左下角运行队列」占一行（进度写在 stateText，■ = 停整批）。 */
    async function pump() {
      if (D.running) return;
      D.running = true;
      D.cancelled = false;
      D.cur = "";
      changed();
      const total0 = D.items.length;
      if (!total0) {
        D.running = false;
        changed();
        return;
      }
      const stopFlag = { stopped: false };
      const run = runBegin({
        title: t("生成变体"),
        sub: t("共 ") + total0 + t(" 项"),
        stateText: t("衍生 0/") + total0,
        stop: () => {
          stopFlag.stopped = true;
          cancel();
        },
      });
      while (D.items.length && !D.cancelled) {
        const job = D.items[0];
        D.cur = job.label;
        changed();
        runSay(run, {
          stateText:
            t("衍生 ") +
            Math.min(D.done + D.failed, D.total) +
            "/" +
            D.total +
            (job.label ? " · " + job.label : ""),
          path: job.rel || "",
        });
        try {
          const parentWasGold = isGoldNow(job.parentPath);
          const rel = await withWriteLock(() => runOne(job, run.abKey));
          D.done += 1;
          toast(t("已生成 ") + rel);
          await reload();
          /* 与 runSingle 同一套：新稿记基线（否则一直是灰的），
             父笔记只因补了 `derives` 边而变字节时也记一次（别让原文凭空变金） */
          await markBaselineQuiet([rel]);
          if (!parentWasGold) await markBaselineQuiet([job.parentPath]);
          runSay(run, { text: t("已生成：") + rel, status: "ok" });
        } catch (e) {
          if (D.cancelled || stopFlag.stopped) {
            /* 用户按了停：这一项不算失败，也不报红（顶栏 chip 自己会说「已取消」） */
          } else {
            D.failed += 1;
            D.err = String((e && e.message) || e);
            toast(D.err, "err");
            runSay(run, { text: t("生成失败：") + D.err, status: "err" });
          }
        }
        D.items.shift();
        D.cur = "";
        changed();
      }
      D.running = false;
      D.cur = "";
      D.items = [];
      changed();
      runEnd(
        run,
        D.cancelled
          ? t("变体生成已取消 · 完成 ") + D.done + "/" + D.total
          : D.failed
            ? t("变体生成完成 · 失败 ") + D.failed + "/" + D.total
            : t("变体生成完成 · ") + D.done + "/" + D.total,
        D.cancelled || D.failed ? "warn" : "ok",
      );
    }

    /* 单项（面板里的「生成」/ 平铺条 chip 就地生成）：不走队列，直接跑一件 ——
       错误交给调用方（面板里显示 / chip 那条 toast），不弹到顶栏。
       花 Token 前先确认一次（已问过的入口传 { confirmed: true }，不重复问）。 */
    async function runSingle(job, opts) {
      const o = opts || {};
      if (!o.confirmed && !(await confirmGen(job))) return "";
      const plan = planOne(job);
      const stopFlag = { stopped: false };
      const run = runBegin({
        title: String(job.label || t("生成变体")),
        sub: plan.parentPath,
        stateText: t("生成中"),
        path: plan.rel || "",
        parentPath: plan.parentPath,
        text: t("开始生成：") + (plan.rel || plan.kindLabel),
        stop: () => {
          stopFlag.stopped = true;
        },
      });
      try {
        const rel = await runSingleInner(job, run);
        runEnd(run, t("已生成：") + rel, "ok");
        return rel;
      } catch (e) {
        if (stopFlag.stopped) {
          runEnd(run, t("已停止：用户终止了这次生成"), "warn");
          throw cancelError();
        }
        runEnd(run, t("生成失败：") + String((e && e.message) || e), "err");
        throw e;
      }
    }
    async function runSingleInner(job, run) {
      const parentWasGold = isGoldNow(job.parentPath);
      const rel = await withWriteLock(() => runOne(job, run && run.abKey));
      await reload();
      /* 新稿记基线：不记的话平铺条 / 左栏树只能判成「没有基线」= 灰，
         用户看到的就是「衍生物未正确上色」（生成了却一直是灰的）。
         必须在 reload 之后：基线按**内存里那一份字节**算，reload 之前那篇还不在库里。 */
      await markBaselineQuiet([rel]);
      /* 生成时给父笔记补了一行 `derives`：那是记录边，不是内容改动 ——
         不一起记基线，原文会莫名其妙变金（整组跟着发橙），看起来就像「上色不对」。
         原文本来就是金（用户真改过）时不记：金色要保持，那是让他先把改动扩散出去。 */
      if (!parentWasGold) await markBaselineQuiet([job.parentPath]);
      return rel;
    }
    /* 这一篇现在是不是金色（与基线不一致）。基线没读进来时一律 false（不猜） */
    function isGoldNow(rel) {
      try {
        const V = versions();
        if (!V || typeof V.stateOf !== "function" || !V.state || !V.state.loaded) return false;
        const st = V.stateOf(rel);
        return !!(st && st.status === "diverged");
      } catch (_) {
        return false;
      }
    }

    /* ── 变体一致化：组里有人被改过（金色）时，按**改后的那一版**重新生成其它版本 ──
       与「扩散」分工不同：扩散把金色版正文**直接拷**给别的版本（不调模型、不花 Token）；
       这一条是让模型按新原文重译 / 重摘 / 重节选（花 Token）——
       所以入口按钮上必须先说清代价，建议阶段性修改完成后再同步。串行跑，逐条报失败。 */
    async function syncVariants(opts) {
      const o = opts || {};
      if (!root()) throw new Error(t("还没有工作目录：先设置画布的工作目录"));
      const parentPath = normRel(o.parentPath || "");
      const items = (o.items || []).filter((x) => x && x.path);
      if (!parentPath) throw new Error(t("没有指定「被改过的那一版」"));
      if (!items.length) throw new Error(t("没有要同步的版本"));
      const parent = noteOf(parentPath);
      if (!parent) throw new Error(t("这一篇不在库里：") + parentPath);
      if (typeof ctx.generate !== "function") throw new Error(t("没有可用的文本模型（设置 · 默认模型）"));
      const tbl = rulesFor(parent.path);
      const okPaths = [];
      const failed = [];
      /* 一致化也要「看得见、停得掉」：整批占运行队列一行，■ = 停（当前这一项跑完即停） */
      const stopFlag = { stopped: false };
      const run = runBegin({
        title: t("变体一致化"),
        sub: parentPath,
        stateText: t("一致化 0/") + items.length,
        path: parentPath,
        text: t("开始一致化：") + items.length + t(" 个版本"),
        stop: () => {
          stopFlag.stopped = true;
        },
      });
      for (const it of items) {
        if (stopFlag.stopped) break;
        runSay(run, {
          stateText: t("一致化 ") + (okPaths.length + failed.length) + "/" + items.length,
          path: normRel(it.path) || "",
        });
        const rel = normRel(it.path);
        if (!rel) continue;
        try {
          await withWriteLock(async () => {
            const k = kindOf(it.kind, tbl);
            const lg = langOf(it.kind, it.lang, tbl);
            const prompt = buildPrompt(
              it.kind,
              lg,
              String(parent.title || baseNoExt(parent.path)),
              parent.path,
              parent.md || "",
              { table: tbl, parentLang: parentLang(parent) },
            );
            const body = cleanOut(await ctx.generate(prompt, { abKey: run.abKey }));
            if (!String(body || "").trim()) throw new Error(t("模型返回空内容"));
            const before = await readRel(rel).catch(() => "");
            const doc = composeDoc(core(), {
              title: titleOf(parent, it.kind, tbl),
              kind: "note",
              derived: k.derived,
              parent: normRel(parent.path),
              lang: lg,
              tags: [],
              verify: "unverified",
              date: dateStr(),
            }, body);
            await api.fileWriteText(joinP(root(), rel), doc);
            if (ctx.logChange) await ctx.logChange(t("同步更新衍生稿 · ") + k.label, rel, before, doc);
            /* 正开着的那篇就地换正文（不重渲染，光标与滚动不动） */
            if (typeof ctx.syncDoc === "function") ctx.syncDoc(rel, doc);
            okPaths.push(rel);
          });
        } catch (e) {
          failed.push({ path: rel, why: String((e && e.message) || e) });
          if (!stopFlag.stopped)
            runSay(run, {
              text: t("一致化失败：") + rel + "（" + String((e && e.message) || e) + "）",
              status: "err",
            });
        }
      }
      runEnd(
        run,
        stopFlag.stopped
          ? t("一致化已停止 · 完成 ") + okPaths.length + "/" + items.length
          : failed.length
            ? t("一致化完成 · 失败 ") + failed.length + "/" + items.length
            : t("一致化完成 · ") + okPaths.length + "/" + items.length,
        failed.length || stopFlag.stopped ? "warn" : "ok",
      );
      await reload();
      /* 全部成功：金色版 + 刚同步的几版一起记基线 → 整组回绿。
         有失败就**不记**：留橙 / 金，让用户还能看出「这组没同步完」。 */
      if (okPaths.length && !failed.length) await markBaselineQuiet([parentPath].concat(okPaths));
      if (typeof ctx.repaint === "function") {
        try {
          ctx.repaint();
        } catch (_) {}
      }
      return { ok: okPaths, failed: failed };
    }

    /* ── 面板 ── */
    let maskEl = null;
    let escBound = false;

    function closePanel() {
      if (maskEl && maskEl.parentNode) maskEl.parentNode.removeChild(maskEl);
      maskEl = null;
    }
    function bindEsc() {
      if (escBound || typeof document === "undefined") return;
      escBound = true;
      document.addEventListener(
        "keydown",
        (ev) => {
          if (ev.key === "Escape" && maskEl) {
            ev.preventDefault();
            closePanel();
          }
        },
        true,
      );
    }

    /* mode: "one"（选类型 + 语言，生成一份） / "batch"（勾多个变体，排队） */
    function openPanel(opts) {
      const o = opts || {};
      const parentPath = normRel(o.path || "");
      const parent = noteOf(parentPath);
      bindEsc();
      closePanel();
      const mask = el("div", "rs-dv-mask");
      const box = el("div", "rs-dv");
      mask.appendChild(box);
      maskEl = mask;
      /* 带输入 / 设置的面板一律 persistent：点蒙层不关（关闭只走 ✕ / Esc，见 AGENTS.md） */

      const head = el("div", "rs-dv-head");
      head.appendChild(el("b", null, t("衍生稿")));
      const pathEl = el("span", "rs-dv-path", parentPath || "—");
      pathEl.title = parentPath;
      head.appendChild(pathEl);
      const x = el("button", "rs-dv-x", "✕");
      x.title = t("关闭");
      x.onclick = () => closePanel();
      head.appendChild(x);
      box.appendChild(head);

      const body = el("div", "rs-dv-body");
      box.appendChild(body);
      const errEl = el("div", "rs-dv-err");
      box.appendChild(errEl);
      const foot = el("div", "rs-dv-foot");
      box.appendChild(foot);

      /* 这一页自己的表（不是全库那张）：面板里列什么、目标叫什么，都只按它算；
         读盘回来若页表变了（首开 / 刚在别处改过），就换掉这份再画一遍 */
      let ruleList = rulesFor(parentPath);
      /* 勾选框按规则表来：新增一条语言规则就自带一个格子，不再写死那四条 */
      function defaultPicked() {
        const out = {};
        for (const k of ruleList) out[k.id] = true;
        return out;
      }
      const state = {
        mode: o.mode === "batch" ? "batch" : "one",
        kind: o.kind || (ruleList[0] && ruleList[0].id) || "",
        lang: parent ? parentLang(parent) : "zh",
        picked: defaultPicked(),
        busy: false,
      };
      function fail(msg) {
        errEl.textContent = String(msg || "");
      }

      /* 前置校验：parent 不存在就在这里说清，别等模型跑完才报 */
      if (!parentPath) fail(t("先打开一篇笔记：衍生稿要挂在它下面"));
      else if (!parent) fail(t("parent 不存在：") + parentPath + t("（内容树里可能已经被删了，刷新一下再看）"));

      function paint() {
        body.innerHTML = "";
        foot.innerHTML = "";

        if (state.mode === "one") {
          const r1 = el("div", "rs-dv-row");
          r1.appendChild(el("span", "rs-dv-k", t("类型")));
          const kinds = el("div", "rs-dv-kinds");
          for (const k of ruleList) {
            const b = el("button", "rs-dv-kind" + (state.kind === k.id ? " on" : ""), k.label);
            if (k.hint) b.title = t(k.hint);
            b.onclick = () => {
              state.kind = k.id;
              fail("");
              paint();
            };
            kinds.appendChild(b);
          }
          r1.appendChild(kinds);
          body.appendChild(r1);

          const r2 = el("div", "rs-dv-row");
          r2.appendChild(el("span", "rs-dv-k", t("语言")));
          const sel = el("select", "rs-dv-sel");
          const forced = kindOf(state.kind, ruleList).derived === "translate";
          for (const lg of languages(ruleList)) {
            const op = el("option", null, lg.label);
            op.value = lg.id;
            if (langOf(state.kind, state.lang, ruleList) === lg.id) op.selected = true;
            sel.appendChild(op);
          }
          sel.disabled = forced;
          sel.onchange = () => {
            state.lang = sel.value;
            fail("");
            paint();
          };
          r2.appendChild(sel);
          r2.appendChild(
            el(
              "span",
              "rs-dv-hint",
              forced
                ? t("译稿的语言由类型决定（如「中译」→ 中文、「英译」→ English）")
                : t("摘要 / 节选用哪种语言写"),
            ),
          );
          body.appendChild(r2);

          const r3 = el("div", "rs-dv-row");
          r3.appendChild(el("span", "rs-dv-k", t("目标")));
          const rel = parentPath ? targetRel(parentPath, state.kind, state.lang, ruleList) : "—";
          const code = el("code", "rs-dv-target", rel);
          code.title = rel;
          r3.appendChild(code);
          body.appendChild(r3);
          body.appendChild(el("div", "rs-dv-hint", t("同目录兄弟文件；frontmatter 写 parent / derived / lang，父笔记补一条 derives")));

          const go = el("button", "rs-btn primary", state.busy ? t("生成中…") : t("生成"));
          go.disabled = state.busy || !parentPath || !parent;
          go.onclick = async () => {
            if (state.busy) return;
            /* 先问一次再进「生成中…」：确认窗还弹着的时候，按钮不该显得已经在跑 */
            const okGo = await confirmGen({
              parentPath,
              kindId: state.kind,
              lang: state.lang,
              label: titleOf(parent, state.kind, ruleList),
            });
            if (!okGo) return;
            state.busy = true;
            fail("");
            paint();
            try {
              const rel2 = await runSingle(
                {
                  parentPath,
                  kindId: state.kind,
                  lang: state.lang,
                  label: titleOf(parent, state.kind, ruleList),
                },
                { confirmed: true },
              );
              if (!rel2) return;
              closePanel();
              toast(t("已生成 ") + rel2);
              if (ctx.openNote) await ctx.openNote(rel2);
            } catch (e) {
              if (!(e && e.cancelled)) fail(String((e && e.message) || e));
            } finally {
              state.busy = false;
              if (maskEl && maskEl.parentNode) paint();
            }
          };
          foot.appendChild(go);
          const toBatch = el("button", "rs-btn", t("批量…"));
          toBatch.title = t("一次勾多个变体，排队串行生成（顶栏显示进度，可取消）");
          toBatch.onclick = () => {
            state.mode = "batch";
            fail("");
            paint();
          };
          foot.appendChild(toBatch);
          foot.appendChild(el("span", "rs-grow"));
          const cancelBtn = el("button", "rs-btn", t("取消"));
          cancelBtn.onclick = () => closePanel();
          foot.appendChild(cancelBtn);
          return;
        }

        /* 批量：规则表里每一行一个变体，勾中的排队 */
        const r0 = el("div", "rs-dv-row");
        r0.appendChild(el("span", "rs-dv-k", t("变体")));
        r0.appendChild(el("span", "rs-dv-hint", t("勾几个就排几个；串行跑，顶栏 chip 显示进度")));
        body.appendChild(r0);
        const vars = el("div", "rs-dv-vars");
        for (const k of ruleList) {
          const row = el("label", "rs-dv-var");
          const cb = el("input");
          cb.type = "checkbox";
          cb.checked = !!state.picked[k.id];
          if (state.busy) cb.disabled = true;
          cb.onchange = () => {
            state.picked[k.id] = !!cb.checked;
            fail("");
            paint();
          };
          row.appendChild(cb);
          row.appendChild(el("span", null, k.label));
          const rel = parentPath
            ? targetRel(parentPath, k.id, parent ? state.lang : "zh", ruleList)
            : "—";
          row.appendChild(el("code", null, rel));
          vars.appendChild(row);
        }
        body.appendChild(vars);

        const picked = ruleList.filter((k) => state.picked[k.id]);
        const run = el("button", "rs-btn primary", t("排队生成 ") + picked.length + t(" 项"));
        run.disabled = state.busy || !picked.length || !parentPath || !parent;
        run.onclick = async () => {
          if (!parentPath || !parent) return fail(t("parent 不存在：") + parentPath);
          const jobs = [];
          for (const k of picked) {
            const lang = langOf(k.id, state.lang, ruleList);
            const rel = targetRel(parentPath, k.id, lang, ruleList);
            if (jobs.some((j) => j.rel === rel)) continue;
            jobs.push({ parentPath, kindId: k.id, lang, label: titleOf(parent, k.id, ruleList), rel });
          }
          if (!jobs.length) return;
          /* 花 Token 前先确认（份数与目标逐条列出），取消了连面板都不关 */
          if (!(await confirmJobs(jobs))) return;
          closePanel();
          enqueue(jobs, { confirmed: true });
        };
        foot.appendChild(run);
        const toOne = el("button", "rs-btn", t("单个…"));
        toOne.onclick = () => {
          state.mode = "one";
          fail("");
          paint();
        };
        foot.appendChild(toOne);
        foot.appendChild(el("span", "rs-grow"));
        const cancelBtn = el("button", "rs-btn", t("取消"));
        cancelBtn.onclick = () => closePanel();
        foot.appendChild(cancelBtn);
      }

      paint();
      document.body.appendChild(mask);
      /* 页表可能还没读进来（首开 / 刚改过配置）：读完若变了就再画一遍，
         别让人对着旧的四条点，也别把新语言稿算到错的目标路径上。 */
      const sigOf = (list) =>
        (list || [])
          .map((k) => k.id + ":" + k.suffix)
          .join(",");
      const openedWith = sigOf(ruleList);
      loadRules()
        .then(() => {
          if (!maskEl || maskEl !== mask) return;
          const now = rulesFor(parentPath);
          if (sigOf(now) === openedWith) return;
          ruleList = now;
          for (const k of now) if (!(k.id in state.picked)) state.picked[k.id] = true;
          if (!state.picked[state.kind]) state.kind = (now[0] && now[0].id) || "";
          paint();
        })
        .catch(() => {});
      return mask;
    }

    /* 排队：已有一个在跑就往队尾续（不并行，不丢项）
       没经过确认的调用（以后新增的入口）也补问一次 —— 别把「每次生成都确认」漏在门外。 */
    function enqueue(jobs, opts) {
      const list = (jobs || []).filter(Boolean);
      if (!list.length) return;
      if (!(opts && opts.confirmed)) {
        void confirmJobs(list).then((ok) => {
          if (ok) enqueue(list, { confirmed: true });
        });
        return;
      }
      const live = D.running ? D.items.length : 0;
      for (const j of list) D.items.push(j);
      if (!D.running) {
        D.total = list.length;
        D.done = 0;
        D.failed = 0;
        D.err = "";
        D.cancelled = false;
      } else {
        D.total += list.length;
        D.err = "";
      }
      changed();
      pump();
      if (live) toast(t("已有队列在跑：新的 ") + list.length + t(" 项排在后面"), "warn");
    }

    /* ── 树上多选 → 生成所选变体：按「版本组」展开成 jobs ──
       版本组 = 原文 + 同目录的 原名.<规则后缀>.md（归组口径在 research-versions.js 的
       buildGroups；变体表 / 目标路径也从同一份规则表算 —— 本模块不再自带一份 KINDS）。
       展开规则：每篇选中条目先归到它的原文，再补上这一组**还没有**的变体（逐个规则一条）；
       目标已存在的项不排队（runOne 会直接报「目标已存在」），改为在面板里逐条点名。
       批量面板那些勾选框的口径不变 —— 那条路是「一篇 × 全表变体」，这条是「多篇各自的组」。 */
    function groupIndex() {
      const V = typeof window !== "undefined" ? window.MTResearchVersions : null;
      if (!V || typeof V.buildGroups !== "function") return { V: null, groups: [] };
      const docs = notes().map((n) => ({ path: n.path, title: n.title, meta: n.meta || {} }));
      return { V: V, groups: V.buildGroups(docs) };
    }
    async function planMany(paths) {
      const picked = (paths || []).map(normRel).filter(Boolean);
      await loadRules();
      const idx = groupIndex();
      const out = { picked: picked, list: [], jobs: [], skip: [] };
      const seenBase = Object.create(null);
      for (const raw of picked) {
        if (raw.indexOf("literature/") === 0) {
          out.skip.push({ path: raw, why: t("折叠文件是只读投影，不参与生成") });
          continue;
        }
        const rec = noteOf(raw);
        if (!rec) {
          out.skip.push({ path: raw, why: t("不在库里（刷新后再看）") });
          continue;
        }
        /* 归到原文：组里原文在就用它；只有变体、原文已经没了 → 跳过并说明缺的是哪一份 */
        let base = normRel(rec.path);
        let missing = "";
        const g = idx.V && typeof idx.V.groupOf === "function" ? idx.V.groupOf(base, idx.groups) : null;
        if (g && g.originalExists) base = normRel(g.original);
        else if (g) missing = normRel(g.original) || base;
        else {
          const orig = originalOfVariant(base);
          if (orig) missing = orig;
        }
        if (missing) {
          out.skip.push({ path: raw, why: t("原文不存在：") + missing });
          continue;
        }
        if (seenBase[base]) continue;
        seenBase[base] = 1;
        out.list.push({ base: base, jobs: [] });
      }
      for (const item of out.list) {
        const parent = noteOf(item.base);
        if (!parent) {
          out.skip.push({ path: item.base, why: t("原文不在库里") });
          continue;
        }
        /* 索引页是这棵库的索引根：不给它衍生稿（连批量也跳过，逐条点名） */
        if (await isIndexPage(parent.path)) {
          out.skip.push({ path: normRel(parent.path), why: t("索引页不需要衍生稿（它是这棵库的索引根）") });
          continue;
        }
        /* 每篇按**它自己那一页**的表展开（页级表各管各的，不再全库一张） */
        const tbl = rulesFor(parent.path);
        for (const k of tbl) {
          const lang = langOf(k.id, parentLang(parent), tbl);
          const rel = targetRel(parent.path, k.id, lang, tbl);
          if (!rel || normRel(rel) === normRel(parent.path)) continue;
          if (await existsRel(rel)) {
            out.skip.push({ path: rel, why: t("目标已存在（原文 ") + normRel(parent.path) + "）" });
            continue;
          }
          const job = {
            parentPath: normRel(parent.path),
            kindId: k.id,
            lang: lang,
            label: titleOf(parent, k.id, tbl),
            rel: rel,
          };
          item.jobs.push(job);
          out.jobs.push(job);
        }
      }
      return out;
    }

    /* 面板：先算好 job 清单（含跳过的冲突项），确认后交 enqueue 串行跑 */
    async function openMany(opts) {
      const picked = ((opts || {}).paths || []).map(normRel).filter(Boolean);
      if (!picked.length) {
        toast(t("先在左栏选几篇（Ctrl / Shift 多选）"), "warn");
        return null;
      }
      let plan;
      try {
        plan = await planMany(picked);
      } catch (e) {
        toast(String((e && e.message) || e), "err");
        return null;
      }
      bindEsc();
      closePanel();
      const mask = el("div", "rs-dv-mask");
      const box = el("div", "rs-dv");
      mask.appendChild(box);
      maskEl = mask;
      /* 带输入 / 设置的面板一律 persistent：点蒙层不关（关闭只走 ✕ / Esc，见 AGENTS.md） */

      const head = el("div", "rs-dv-head");
      head.appendChild(el("b", null, t("生成所选变体")));
      const sum = el(
        "span",
        "rs-dv-path",
        t("已选 ") +
          plan.picked.length +
          t(" 篇 · 原文 ") +
          plan.list.length +
          t(" 篇 · 待生成 ") +
          plan.jobs.length +
          t(" 项"),
      );
      sum.title = plan.picked.join("\n");
      head.appendChild(sum);
      const x = el("button", "rs-dv-x", "✕");
      x.title = t("关闭");
      x.onclick = () => closePanel();
      head.appendChild(x);
      box.appendChild(head);

      const body = el("div", "rs-dv-body");
      box.appendChild(body);
      body.appendChild(
        el(
          "div",
          "rs-dv-hint",
          t("按版本组展开：每篇原文补上规则表里还没有的变体（默认中译 / 英译 / 摘要 / 节选）；串行跑，顶栏 chip 显示进度（可取消）"),
        ),
      );

      const many = el("div", "rs-dv-many");
      for (const item of plan.list) {
        const parent = noteOf(item.base);
        const title = String((parent && parent.title) || baseNoExt(item.base));
        const grp = el("div", "rs-dv-many-group");
        const h = el("div", "rs-dv-many-base", title + " · " + item.base);
        h.title = item.base;
        grp.appendChild(h);
        if (!item.jobs.length) grp.appendChild(el("div", "rs-dv-many-row", t("这一组的变体都已存在，跳过")));
        for (const job of item.jobs) {
          const jr = el("div", "rs-dv-many-row");
          jr.appendChild(el("span", "rs-dv-many-kind", kindOf(job.kindId, rulesFor(job.parentPath)).label));
          const code = el("code", null, job.rel);
          code.title = job.rel;
          jr.appendChild(code);
          grp.appendChild(jr);
        }
        many.appendChild(grp);
      }
      body.appendChild(many);

      /* 冲突项点名：目标已存在 / 原文不存在 / 折叠文件 —— 一条一行，点开就是路径原文 */
      if (plan.skip.length) {
        const sk = el("div", "rs-dv-many");
        sk.appendChild(el("div", "rs-dv-many-base", t("跳过 ") + plan.skip.length + t(" 项（逐条点名）")));
        for (const s of plan.skip) {
          const r = el("div", "rs-dv-many-row bad");
          const code = el("code", null, s.path);
          code.title = s.path;
          r.appendChild(code);
          r.appendChild(el("span", "rs-dv-hint", String(s.why || "")));
          sk.appendChild(r);
        }
        body.appendChild(sk);
      }

      const errEl = el("div", "rs-dv-err");
      box.appendChild(errEl);
      if (!plan.jobs.length) errEl.textContent = t("没有可生成的项：上面点名的目标都已存在");
      const foot = el("div", "rs-dv-foot");
      box.appendChild(foot);
      const run = el("button", "rs-btn primary", t("排队生成 ") + plan.jobs.length + t(" 项"));
      run.disabled = !plan.jobs.length;
      run.onclick = async () => {
        if (!plan.jobs.length) return;
        if (!(await confirmJobs(plan.jobs))) return;
        closePanel();
        enqueue(plan.jobs, { confirmed: true });
      };
      foot.appendChild(run);
      foot.appendChild(el("span", "rs-grow"));
      const cancelBtn = el("button", "rs-btn", t("取消"));
      cancelBtn.onclick = () => closePanel();
      foot.appendChild(cancelBtn);
      document.body.appendChild(mask);
      return mask;
    }

    /* ══════════ 扩散到其他版本（金色版本 → 同组其它版本）══════════
     * 入口两处（app-research.js 顶栏 chip 旁 / 树上右键），都落到 openSpread。
     * 归组与目标清单由 research-versions.js 的 planSpread 算（只算不写），这里只负责：
     *   · 面板：目标默认全组其它版本，可逐个取消勾选；
     *   · 逐项写盘 + logChange（可 Ctrl+Z 撤销），串行、不与生成队列并发写同一组；
     *   · 同 kind + 同 lang（中译 → 中译、摘要 → 摘要）= copy：直接以金色正文覆盖；
     *     跨语言 / 跨种类 = generate：buildPrompt 复用同一份提示词，输入换成金色版正文；
     *   · 任一项失败：失败项保留金色（文件不动）、金色版本也保持金色，逐条报原因；全部成功才
     *     markBaseline + commit —— 整组回绿。
     */
    const ORIGINAL = "original";
    /* 按 id 精确取变体（kindOf 对未知 id 会兜到第一条，标签就会写错种类 —— 这里不兜）
       不传表就按「辨认口径」（默认表 + 各页表出现过的规则）找：扩散时标签才认得日语这类页级变体 */
    function kindById(id, rulesArg) {
      const want = normRel(id);
      if (!want) return null;
      const list = Array.isArray(rulesArg) && rulesArg.length ? rulesArg : knownRules();
      for (const k of list) if (k.id === want) return k;
      return null;
    }
    function knownRules() {
      const V = kernel();
      if (V && typeof V.knownRules === "function") {
        const list = V.knownRules();
        if (Array.isArray(list) && list.length) return list;
      }
      return rules();
    }
    function labelOfKindName(kind, rulesArg) {
      const id = normRel(kind);
      if (id === ORIGINAL) return t("原文");
      const k = kindById(id, rulesArg);
      return (k && k.label) || t("衍生");
    }
    function targetLabel(item, rulesArg) {
      const lg = String(item.lang || "").trim();
      return labelOfKindName(item.kind, rulesArg) + (lg && lg !== item.kind ? " · " + lg : "");
    }
    function freshMeta(item, plan, rulesArg) {
      const rel = normRel(item.path);
      const k =
        normRel(item.kind) === ORIGINAL
          ? null
          : kindById(item.kind, rulesArg) || kindById(plan && plan.gold && plan.gold.kind, rulesArg);
      const meta = {
        title: String(item.title || baseNoExt(rel)),
        kind: "note",
        parent: normRel((plan && plan.group && plan.group.original) || rel),
        lang: String(item.lang || (k ? langOf(item.kind, item.lang, rulesArg) : "zh") || "zh"),
        tags: [],
        verify: "unverified",
        date: dateStr(),
      };
      if (k && k.derived) meta.derived = k.derived;
      return meta;
    }
    /* 一项：算出正文 → 保住目标自己的 frontmatter → 写盘 → 记一笔改动（可撤销） */
    async function spreadOne(item, gold, plan) {
      const rel = normRel(item.path);
      if (!rel) throw new Error(t("目标路径为空"));
      if (rel === normRel(gold.path)) throw new Error(t("目标就是被改过的这一版自己"));
      /* 扩散的「页」= 这一组的原文页：变体名 / 语言 / 提示词都按它那一页的表算 */
      const pageRel = normRel((plan && plan.group && plan.group.original) || gold.path);
      const tbl = rulesFor(pageRel);
      const goldMd = gold.md;
      if (goldMd == null) throw new Error(t("读不到被改过的那一版的正文：") + gold.path);
      const gBody = bodyOf(goldMd);
      if (!String(gBody).trim()) throw new Error(t("被改过的那一版正文是空的：") + gold.path);
      const C = core();
      const before = await readRel(rel);
      /* 目标现有的 frontmatter（标题 / parent / derived / lang）原样留着，只换正文 */
      let prevMeta = null;
      if (before && C && typeof C.parseFrontmatter === "function") {
        try {
          prevMeta = (C.parseFrontmatter(before) || {}).meta || null;
        } catch (_) {
          prevMeta = null;
        }
      }
      let body = "";
      if (item.mode === "copy") {
        body = gBody;
      } else {
        if (typeof ctx.generate !== "function") throw new Error(t("没有可用的文本模型（设置 · 模型服务）"));
        let tgtLang = String(item.lang || "").trim();
        if (!tgtLang && prevMeta) tgtLang = String(prevMeta.lang || "").trim();
        if (!tgtLang) tgtLang = normRel(item.kind) === ORIGINAL ? "zh" : langOf(item.kind, "", tbl);
        const k = kindById(item.kind, tbl) || kindById(gold.kind, tbl);
        /* 「原文 → 某语言的译稿」按规则表找那条译稿规则（不再写死 en / zh 两档） */
        const kindId =
          normRel(item.kind) === ORIGINAL
            ? kindIdForLang(tgtLang, tbl) || (k && k.id) || ""
            : (k && k.id) || "";
        const prompt = buildPrompt(
          kindId,
          tgtLang,
          String(gold.title || baseNoExt(gold.path)),
          gold.path,
          goldMd,
          { label: labelOfKindName(item.kind, tbl), table: tbl },
        );
        body = cleanOut(await ctx.generate(prompt));
        if (!String(body || "").trim()) throw new Error(t("模型返回空内容：") + rel + t("（换个模型或再试一次）"));
      }
      const meta = prevMeta && Object.keys(prevMeta).length ? prevMeta : freshMeta(item, plan, tbl);
      const doc = composeDoc(C, meta, body);
      await writeRel(rel, doc);
      if (ctx.logChange) await ctx.logChange(t("扩散到其他版本 · ") + labelOfKindName(item.kind, tbl), rel, before, doc);
      /* 目标正好开着：把内存里那一份同步成刚写进去的，别让随后那次自动保存把扩散结果盖回去 */
      if (typeof ctx.syncDoc === "function") ctx.syncDoc(rel, doc);
      return rel;
    }

    function startSpread(plan, picked) {
      const list = (picked || []).filter(Boolean);
      if (!plan || !plan.gold) return toast(t("这一篇不在任何版本组里"), "warn");
      if (!list.length) return toast(t("没有勾选任何目标版本"), "warn");
      if (S.running) return toast(t("上一次扩散还在跑：等它跑完"), "warn");
      S.gold = plan.gold.path;
      S.items = list;
      S.total = list.length;
      S.done = 0;
      S.failed = 0;
      S.err = "";
      S.cur = "";
      S.cancelled = false;
      S.fails = [];
      S.green = false;
      S.running = true;
      changed();
      /* 队列本身逐项 catch；这里再兜一层：重读 / 写基线这类整体性错误也要落到 chip 上 */
      Promise.resolve(pumpSpread(plan, list)).catch((e) => {
        S.running = false;
        S.cur = "";
        S.err = String((e && e.message) || e);
        changed();
        toast(t("扩散中断：") + S.err, "err");
      });
    }

    /* 串行扩散：一项一项写，写完一项刷一次 chip；全部成功后记基线（整组回绿） */
    async function pumpSpread(plan, list) {
      const goldRec = noteOf(plan.gold.path);
      const gold = {
        path: plan.gold.path,
        title: plan.gold.title,
        md: goldRec ? goldRec.md : null,
      };
      const okPaths = [];
      for (const item of list) {
        if (S.cancelled) break;
        S.cur = targetLabel(item);
        changed();
        try {
          await withWriteLock(() => spreadOne(item, gold, plan));
          S.done += 1;
          okPaths.push(normRel(item.path));
          toast(t("已扩散 ") + item.path);
        } catch (e) {
          S.failed += 1;
          const why = String((e && e.message) || e);
          S.fails.push({ path: item.path, why: why });
          S.err = S.fails.map((f) => f.path + "：" + f.why).join("\n");
          toast(t("扩散失败：") + item.path + " · " + why, "err");
        }
        S.cur = "";
        changed();
      }
      S.running = false;
      S.cur = "";
      S.items = [];
      changed();
      /* 先重读笔记：markBaseline 按「当前字节」记基线，读的是 RS.notes 里那一份 */
      await reload();
      if (S.failed || S.cancelled) {
        if (S.failed) toast(t("扩散没全部成功：失败 ") + S.failed + t(" 项，被改过的那一版保持原样（逐条原因见顶栏 chip）"), "warn");
        return;
      }
      /* 全部成功：金色 + 刚写过的目标一起记基线 —— 整组回绿；再刷一次树（颜色跟着 store 走） */
      try {
        const V = versions();
        if (!V || typeof V.markBaseline !== "function" || typeof V.commit !== "function") {
          throw new Error(t("版本模块没加载（renderer/research-versions.js）"));
        }
        const res = V.markBaseline([gold.path].concat(okPaths));
        if (res && res.patch) await V.commit(res.patch);
        S.green = true;
        toast(t("扩散完成：整组已同步（回绿）"));
      } catch (e) {
        S.err = String((e && e.message) || e);
        toast(t("写入基线失败：") + S.err, "err");
      }
      changed();
      if (typeof ctx.repaint === "function") {
        try {
          ctx.repaint();
        } catch (_) {}
      } else {
        await reload();
      }
    }

    /* 面板：目标默认全组其它版本（可勾选），确认后 startSpread 串行跑 */
    async function openSpread(opts) {
      const goldPath = normRel((opts || {}).path || "");
      if (!root()) return toast(t("还没有工作目录：先设置画布的工作目录"), "err");
      if (!goldPath) return toast(t("先打开一篇笔记"), "warn");
      if (!noteOf(goldPath)) return toast(t("不在库里（刷新后再看）：") + goldPath, "err");
      const V = versions();
      if (!V || typeof V.planSpread !== "function") {
        return toast(t("版本模块没加载（renderer/research-versions.js）"), "err");
      }
      /* 规则表先落地（新语言 / 改过后缀要参与归组），再读 store：hasBaseline 之类的回显才准 */
      try {
        await loadRules();
      } catch (_) {}
      try {
        await V.ensureLoaded();
      } catch (_) {}
      let plan;
      try {
        plan = V.planSpread(goldPath);
      } catch (e) {
        return toast(String((e && e.message) || e), "err");
      }
      if (!plan || !plan.group) return toast(t("这一篇不在任何版本组里：") + goldPath, "warn");

      bindEsc();
      closePanel();
      const mask = el("div", "rs-dv-mask");
      const box = el("div", "rs-dv");
      mask.appendChild(box);
      maskEl = mask;
      /* 带输入 / 设置的面板一律 persistent：点蒙层不关（关闭只走 ✕ / Esc，见 AGENTS.md） */

      const head = el("div", "rs-dv-head");
      head.appendChild(el("b", null, t("扩散到其他版本")));
      const goldEl = el("span", "rs-dv-path", plan.gold.path);
      goldEl.title = plan.gold.path;
      head.appendChild(goldEl);
      const x = el("button", "rs-dv-x", "✕");
      x.title = t("关闭");
      x.onclick = () => closePanel();
      head.appendChild(x);
      box.appendChild(head);

      const body = el("div", "rs-dv-body");
      box.appendChild(body);
      body.appendChild(
        el(
          "div",
          "rs-dv-hint",
          t("被改过的版本《") +
            String(plan.gold.title || baseNoExt(plan.gold.path)) +
            t("》的正文扩散到同组其它版本：同种类同语言直接覆盖，跨语言 / 跨种类走模型改写；逐项写盘，可 Ctrl+Z 撤销"),
        ),
      );

      const picked = Object.create(null);
      const many = el("div", "rs-dv-many");
      const grp = el("div", "rs-dv-many-group");
      many.appendChild(grp);
      for (const item of plan.targets) {
        picked[item.path] = true;
        const row = el("label", "rs-dv-var");
        const cb = el("input");
        cb.type = "checkbox";
        cb.checked = true;
        row.appendChild(cb);
        row.appendChild(el("span", "rs-dv-many-kind", targetLabel(item)));
        const code = el("code", null, item.path);
        code.title = item.path;
        row.appendChild(code);
        row.appendChild(el("span", "rs-dv-hint", item.mode === "copy" ? t("直接覆盖") : t("模型改写")));
        grp.appendChild(row);
        cb.onchange = () => {
          picked[item.path] = !!cb.checked;
          fail("");
          paintFoot();
        };
      }
      if (!plan.targets.length) {
        many.appendChild(el("div", "rs-dv-many-base", t("这一组只有这一篇（没有其它版本可扩散）")));
      }
      body.appendChild(many);

      const errEl = el("div", "rs-dv-err");
      box.appendChild(errEl);
      const foot = el("div", "rs-dv-foot");
      box.appendChild(foot);
      function fail(msg) {
        errEl.textContent = String(msg || "");
      }
      function pickList() {
        return plan.targets.filter((it) => picked[it.path]);
      }
      function paintFoot() {
        foot.innerHTML = "";
        const list = pickList();
        const run = el("button", "rs-btn primary", t("扩散 ") + list.length + t(" 项"));
        run.title = t("逐项写盘；全部成功才整组回绿，任一项失败就不动被改过的那一版");
        run.disabled = !list.length;
        run.onclick = () => {
          const sel = pickList();
          if (!sel.length) return fail(t("没有勾选任何目标版本"));
          closePanel();
          startSpread(plan, sel);
        };
        foot.appendChild(run);
        foot.appendChild(el("span", "rs-grow"));
        const cancelBtn = el("button", "rs-btn", t("取消"));
        cancelBtn.onclick = () => closePanel();
        foot.appendChild(cancelBtn);
      }
      paintFoot();
      if (!plan.targets.length) fail(t("这一组只有这一篇：先衍生出其它版本，再扩散"));
      document.body.appendChild(mask);
      return mask;
    }


    /* ── 导入已有 md ──
       选文件 → 填 parent / derived / lang → 复制进目标目录（父笔记所在目录），frontmatter 合并。 */
    async function openImport(opts) {
      const o = opts || {};
      if (!api || typeof api.fileOpenDialog !== "function") {
        toast(t("这个环境没有文件选择器"), "err");
        return null;
      }
      let picked = "";
      try {
        const r = await api.fileOpenDialog({
          title: t("选一个已有的 Markdown 作为衍生稿"),
          multi: false,
          filters: [
            { name: "Markdown", extensions: ["md", "markdown", "txt"] },
            { name: t("全部文件"), extensions: ["*"] },
          ],
          defaultPath: String(o.defaultPath || (root() && joinP(root(), "notes")) || ""),
        });
        picked = String((r && (r.path || (r.paths && r.paths[0]))) || "");
      } catch (e) {
        toast(t("选择文件失败：") + String((e && e.message) || e), "err");
        return null;
      }
      if (!picked) return null;
      const srcText = await api
        .fileReadText(picked)
        .then((r) => (r && r.exists ? String(r.content || "") : ""))
        .catch(() => "");
      if (!String(srcText).trim()) {
        toast(t("这个文件读不出内容：") + picked, "err");
        return null;
      }

      bindEsc();
      closePanel();
      const mask = el("div", "rs-dv-mask");
      const box = el("div", "rs-dv");
      mask.appendChild(box);
      maskEl = mask;
      /* 带输入 / 设置的面板一律 persistent：点蒙层不关（关闭只走 ✕ / Esc，见 AGENTS.md） */
      const head = el("div", "rs-dv-head");
      head.appendChild(el("b", null, t("导入为衍生稿")));
      const p = el("span", "rs-dv-path", picked);
      p.title = picked;
      head.appendChild(p);
      const x = el("button", "rs-dv-x", "✕");
      x.onclick = () => closePanel();
      head.appendChild(x);
      box.appendChild(head);
      const body = el("div", "rs-dv-body");
      box.appendChild(body);
      const errEl = el("div", "rs-dv-err");
      box.appendChild(errEl);
      const foot = el("div", "rs-dv-foot");
      box.appendChild(foot);

      const srcName = String(picked).slice(Math.max(String(picked).lastIndexOf("/"), String(picked).lastIndexOf("\\")) + 1);
      const srcBase = srcName.replace(/\.md$/i, "");
      const st = {
        parent: normRel(o.path || ""),
        derived: "import",
        lang: (noteOf(normRel(o.path || "")) && parentLang(noteOf(normRel(o.path || "")))) || "zh",
        name: srcBase,
      };
      function fail(msg) {
        errEl.textContent = String(msg || "");
      }

      const r1 = el("div", "rs-dv-row");
      r1.appendChild(el("span", "rs-dv-k", t("parent")));
      const sel = el("select", "rs-dv-sel");
      const list = notes();
      if (!list.length) {
        const op = el("option", null, t("（库里还没有笔记）"));
        op.value = "";
        sel.appendChild(op);
      }
      for (const n of list) {
        const op = el("option", null, String(n.title || n.path));
        op.value = normRel(n.path);
        if (st.parent === normRel(n.path)) op.selected = true;
        sel.appendChild(op);
      }
      sel.onchange = () => {
        st.parent = sel.value;
        fail("");
      };
      r1.appendChild(sel);
      body.appendChild(r1);

      const r2 = el("div", "rs-dv-row");
      r2.appendChild(el("span", "rs-dv-k", t("derived")));
      const dsel = el("select", "rs-dv-sel");
      /* 选项 = import / draft + 规则表里的 derived（新种类加一条规则就出现在这里） */
      const derivedOpts = ["import"];
      for (const k of rules()) if (derivedOpts.indexOf(k.derived) < 0) derivedOpts.push(k.derived);
      if (derivedOpts.indexOf("draft") < 0) derivedOpts.push("draft");
      for (const v of derivedOpts) {
        const op = el("option", null, v);
        op.value = v;
        if (st.derived === v) op.selected = true;
        dsel.appendChild(op);
      }
      dsel.onchange = () => {
        st.derived = dsel.value;
        fail("");
      };
      r2.appendChild(dsel);
      const lsel = el("select", "rs-dv-sel");
      for (const lg of languages()) {
        const op = el("option", null, lg.label);
        op.value = lg.id;
        if (st.lang === lg.id) op.selected = true;
        lsel.appendChild(op);
      }
      lsel.onchange = () => {
        st.lang = lsel.value;
        fail("");
      };
      r2.appendChild(el("span", "rs-dv-k", t("lang")));
      r2.appendChild(lsel);
      body.appendChild(r2);

      const r3 = el("div", "rs-dv-row");
      r3.appendChild(el("span", "rs-dv-k", t("文件名")));
      const nameIn = el("input", "rs-dv-sel");
      nameIn.value = st.name;
      nameIn.oninput = () => {
        st.name = nameIn.value;
        fail("");
      };
      r3.appendChild(nameIn);
      r3.appendChild(el("span", "rs-dv-hint", t(".md 会自动补；落在父笔记所在目录")));
      body.appendChild(r3);

      const go = el("button", "rs-btn primary", t("复制进目标目录"));
      go.onclick = async () => {
        const parentPath = normRel(st.parent);
        if (!parentPath) return fail(t("parent 不存在：先选一篇笔记"));
        const parent = noteOf(parentPath);
        if (!parent) return fail(t("parent 不存在：") + parentPath);
        const base = String(st.name || "").trim().replace(/\.md$/i, "");
        if (!base) return fail(t("文件名不能为空"));
        const rel = dirOf(parent.path) + base + ".md";
        const same = normRel(picked).replace(/\\/g, "/").toLowerCase();
        const abs = joinP(root(), rel);
        if (same === String(abs).replace(/\\/g, "/").toLowerCase()) return fail(t("目标就是源文件：换个文件名"));
        if (await existsRel(rel)) return fail(t("目标已存在：") + rel + t("（先删掉或改名再试）"));
        go.disabled = true;
        try {
          /* frontmatter 合并：源文件原有的键留着，只覆盖 parent / derived / lang，标题缺了才补 */
          const C = core();
          let meta = {};
          if (C && typeof C.parseFrontmatter === "function") meta = C.parseFrontmatter(srcText).meta || {};
          const title = String(meta.title || base).trim() || base;
          const next = Object.assign({}, meta, {
            title: title,
            derived: String(st.derived || "import"),
            parent: normRel(parent.path),
            lang: String(st.lang || "zh"),
          });
          const out = composeDoc(C, next, bodyOf(srcText));
          await api.fileWriteText(abs, out);
          if (ctx.logChange) await ctx.logChange(t("导入衍生稿"), rel, "", out);
          await addDerivesToParent(parent.path, title);
          await reload();
          closePanel();
          toast(t("已导入 ") + rel);
          if (ctx.openNote) await ctx.openNote(rel);
        } catch (e) {
          fail(String((e && e.message) || e));
        } finally {
          go.disabled = false;
        }
      };
      foot.appendChild(go);
      foot.appendChild(el("span", "rs-grow"));
      const cancelBtn = el("button", "rs-btn", t("取消"));
      cancelBtn.onclick = () => closePanel();
      foot.appendChild(cancelBtn);
      document.body.appendChild(mask);
      return mask;
    }

    return {
      version: 1,
      /* 打开面板：{ path, mode: "one" | "batch", kind } */
      openPanel: openPanel,
      /* 导入已有 md */
      openImport: openImport,
      /* 排队一组变体：[{parentPath, kindId, lang}] */
      enqueue: enqueue,
      /* 树上多选：按版本组展开成 jobs（跳过已存在的目标，冲突项在面板里点名）→ enqueue */
      openMany: openMany,
      planMany: planMany,
      /* 金色版本 → 同组其它版本：面板（目标默认全选、可勾选）→ startSpread 串行写 */
      openSpread: openSpread,
      startSpread: startSpread,
      cancelSpread: cancelSpread,
      /* 直接生成一件（给宿主做快捷键用，错误照常抛） */
      runSingle: runSingle,
      /* 花 Token 前的确认（宿主自己的入口 —— 比如平铺条 chip 就地生成 —— 也走这一条） */
      confirmGen: confirmGen,
      confirmJobs: confirmJobs,
      /* 同步更新：按被改过的那一版重新生成其它版本（花 Token；逐条报失败） */
      syncVariants: syncVariants,
      cancel: cancel,
      close: closePanel,
      /* 顶栏 chip：宿主每次重画顶栏后调一次 */
      paintChip: paintChip,
      state: D,
      spreadState: S,
      /* 纯函数摆出来：宿主 / 自检都能直接用同一份 */
      targetRel: targetRel,
      withDerives: withDerives,
      buildPrompt: buildPrompt,
      cleanOut: cleanOut,
      composeDoc: composeDoc,
      /* 规则表（每页一份）：读 = research.json 的 ui.deriveRulesByPage（没有该键 = 默认表；
         键在、值是空数组 = 这一页的空表，不出变体），写 = 落回同一个键；
         默认表（ui.deriveRules）只当新页默认值，界面不再改它 */
      rules: rules,
      rulesFor: rulesFor,
      saveRules: saveRules,
      loadRules: loadRules,
      isIndexPage: isIndexPage,
      languages: languages,
      langLabel: langLabel,
      kindOf: kindOf,
      langOf: langOf,
      get KINDS() {
        return rules();
      },
      get LANGS() {
        return languages();
      },
    };
  }

  window.MTResearchDerive = {
    create: create,
    version: 1,
    /* 规则表只有一份口径（research-versions.js）；这里的 KINDS / LANGS 是它的当前快照代理 */
    rules: rules,
    rulesFor: rulesFor,
    languages: languages,
    langLabel: langLabel,
    kindOf: kindOf,
    langOf: langOf,
    targetRel: targetRel,
    withDerives: withDerives,
    buildPrompt: buildPrompt,
    cleanOut: cleanOut,
    composeDoc: composeDoc,
    bodyOf: bodyOf,
    get KINDS() {
      return rules();
    },
    get LANGS() {
      return languages();
    },
  };
})();
