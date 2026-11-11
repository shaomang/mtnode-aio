/* ===== 研究视图阅读区增强（window.MTResearchReader） =====
 * 归属 renderer/app-research.js 的**阅读态**：章节大纲 / 公式编号与放大 / 术语解释 / 阅读进度。
 * 为什么单独成文件：这四件事都是「只读 DOM 增强」，与视图外壳（装载、保存、图谱、会话）无关，
 * 拆出来既能被 app-research.js 复用，也能在纯页面里被验证（改动 CSS 排版时直接渲染一篇真稿子看）。
 *
 * 硬约束：
 *   · 只改渲染出来的 DOM；唯一会碰到 Markdown 源码的入口是公式浮层头部那颗「编辑 LaTeX」
 *     （reader 只算出新旧 tex，替换与落盘交给宿主回调 onEditTex）；
 *   · 术语唯一真源是正文里的 `> [!term] 名称` 块（初始化不自动抽概念）；
 *   · 公式编号按小节（h2）计，显示式才编号；行内式也提供点开放大。
 *
 * 用法（app-research.js 的 rsDecorateReading 是薄适配层）：
 *   const R = MTResearchReader.create({ el, t, openNote, toast, math, onEditTex, onEqExpand });
 *   R.decorate(rootEl, { outline, progress, scrollRoot, notes });
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.MTResearchReader = factory();
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  function defaultEl(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  /* ── SVG 子树：`<text>` 里塞 HTML 元素画不出来 ──
     Pele 流程图 / 时序图的标签是 SVG 文本节点。双链、术语高亮、引用梗这三个装饰器都是
     「把文本节点换成一堆 span」，一旦走进 SVG，标签就在图上当场消失 —— 只剩包裹用的引号
     （曾经的现场：每个方框里只剩两个引号）。所以三个装饰器共用这一道闸：SVG 里的字一个都不动。 */
  function inSvgTree(p) {
    if (!p) return true;
    if (p.ownerSVGElement) return true;
    return typeof p.closest === "function" && !!p.closest("svg");
  }

  function create(deps) {
    const d = deps || {};
    const el = typeof d.el === "function" ? d.el : defaultEl;
    const t = typeof d.t === "function" ? d.t : (s) => String(s == null ? "" : s);
    const openNote = typeof d.openNote === "function" ? d.openNote : null;
    const openLink = typeof d.openLink === "function" ? d.openLink : null;
    /* `[[双链]]` 指向的那一页（宿主给）：{ path, dir, text, page: true } | null。
       有它就说明宿主支持「点链接先弹卡」——卡片第一行是它，其余是库里写过它的笔记；
       没有（老嵌入方 / 验证页）就退回老行为：点一下直接跳页。 */
    const linkPage = typeof d.linkPage === "function" ? d.linkPage : null;
    /* 点了「还没有那条笔记」的名词：把判定结果交给宿主，由它弹候选面板
       （reader 只管认出「缺失」并报位置，不生成内容、不碰 md）。
       公式不走这里 —— 公式浮层自带「扩充方向」，见下面的 onEqExpand。 */
    const onMissing = typeof d.onMissing === "function" ? d.onMissing : null;
    /* 公式源码改完写回 Markdown（阅读器不碰 md）：onEditTex(hostEl, 旧 tex, 新 tex) → 替换成功与否 */
    const onEditTex = typeof d.onEditTex === "function" ? d.onEditTex : null;
    /* 公式浮层下部的「扩充方向」：整块由宿主挂（与术语浮层同一份，见 app-research.js 的 rsMissSuggest）。
       onEqExpand(mountEl, { tex, label, name, host }) → 宿主自己重画，阅读器只给容器。 */
    const onEqExpand = typeof d.onEqExpand === "function" ? d.onEqExpand : null;
    /* 整段 Markdown → HTML（术语说明这类「一小段正文」用它）：不注入时退回只排公式 */
    const renderMd = typeof d.renderMd === "function" ? d.renderMd : null;
    /* 「写一条笔记」：引用梗浮层底部那颗钮交给宿主落盘（阅读器不碰文件） */
    const onNewNote = typeof d.onNewNote === "function" ? d.onNewNote : null;
    /* 引用梗浮层顶上那条「文献」行：这篇文章在本地有没有正文，由宿主判（阅读器不读盘、不联网）。
       citeInfo(keys) → [{ key, title, found, downloaded }] */
    const citeInfo = typeof d.citeInfo === "function" ? d.citeInfo : null;
    /* onOpenCite(key)：有正文 → 导向那篇文章；没有 → 宿主走「获取文献」（派 agent 去取） */
    const onOpenCite = typeof d.onOpenCite === "function" ? d.onOpenCite : null;
    /* 参考文献段落里点整行：reader 只负责认出「这一行是文献」（行内含 `[@key]` 或 DOI / arXiv），
       本地有没有全文、要不要派 agent 获取，全由宿主决定。openRef({ key, doi, arxiv, title }) */
    const openRef = typeof d.openRef === "function" ? d.openRef : null;
    /* 选区右键菜单里要动 Markdown 的两项（阅读器自己不改 md、不落盘，只回调宿主）：
       wrapLink(选中文字) → 在正文里包成 [[…]] 并落盘；
       cutSelection(选中文字) → 编辑态从源码里删掉这段并写剪贴板；
       isEditing() → 只有编辑态才给「剪切」这一项。 */
    const wrapLink = typeof d.wrapLink === "function" ? d.wrapLink : null;
    const cutSelection = typeof d.cutSelection === "function" ? d.cutSelection : null;
    const isEditing = typeof d.isEditing === "function" ? d.isEditing : () => false;
    const toast = typeof d.toast === "function" ? d.toast : null;
    const math = typeof d.math === "function" ? d.math : () => (typeof window !== "undefined" ? window.MTMathRender : null);

    const state = {
      spy: null,
      tip: null,
      cards: null,
      cardsKey: "",
      cardsEsc: null,
      cardsDown: null,
      cardsAnchor: null,
      notes: [],
      modal: null,
      eqHost: null,
      eqTex: "",
      terms: new Map(),
      /* 当前这一篇的源码 + 每一处 `[@key]` 的行号：引用梗要「只看当前上下文」就靠它 */
      citeCtx: { path: "", entries: [] },
      /* 选区右键菜单：一次性浮层，开了就把 Esc / 点空白这两个监听一并记下来 */
      ctx: null,
      ctxKey: "",
      ctxEsc: null,
      ctxDown: null,
      scroll: null,
      outline: null,
      root: null,
      fitQueued: false,
      fitBound: false,
    };

    /* ── 术语索引：全库扫 `> [!term] 名称` 块，块的正文就是定义；同名以先出现的为准 ── */
    function termIndex(notes) {
      const idx = new Map();
      for (const n of notes || []) {
        const blocks = (n && n.parsed && n.parsed.blocks) || [];
        for (const b of blocks) {
          if (b.type !== "callout" || b.kind !== "term") continue;
          const name = String(b.title || "").trim();
          if (!name || idx.has(name)) continue;
          let body = String(b.text || "").trim();
          if (body.indexOf(name) === 0) body = body.slice(name.length).replace(/^[ \t]*\n?/, "").trim();
          idx.set(name, { name, text: body, path: n.path, line: b.line || 1 });
        }
      }
      return idx;
    }

    /* ── 标记行切分：`> [!claim] 标题` 的第一行到第一个 <br> 为止 ──
       标题里常常带行内公式（「定理 1（主结果：$max_θ|S_N| ≪ …$）」），所以标题不能取纯文本，
       而是把标记行剩下的**节点**整段搬进标题里 —— 公式、代码都保持渲染后的样子。
       返回 null 表示这一块不是 callout。 */
    function splitMarkerLine(p) {
      if (!p) return null;
      const kids = [...p.childNodes];
      const brIdx = kids.findIndex((nd) => nd.nodeType === 1 && nd.tagName === "BR");
      const lineEnd = brIdx < 0 ? kids.length : brIdx;
      const lineText = kids
        .slice(0, lineEnd)
        .map((nd) => (nd.nodeType === 3 ? nd.nodeValue : ""))
        .join("");
      const m = /^\s*\[!([A-Za-z-]+)(?:\|([A-Za-z-]+))?\]\s*/.exec(lineText);
      if (!m) return null;
      const lead = kids[0];
      if (lead && lead.nodeType === 3) {
        lead.nodeValue = String(lead.nodeValue || "").replace(/^\s*\[![A-Za-z-]+(?:\|[A-Za-z-]+)?\]\s*/, "");
      }
      if (brIdx >= 0) kids[brIdx].remove();
      return { kind: m[1].toLowerCase(), mod: (m[2] || "").toLowerCase(), titleNodes: kids.slice(0, lineEnd) };
    }
    function tidyEmpty(p) {
      if (p && !String(p.textContent || "").trim() && !p.querySelector("*")) p.remove();
    }

    /* ── 引用块标题：`> [!claim] Hardy 的部分上界` → 「论断 · Hardy 的部分上界」 ──
       只在阅读态做（编辑态的 DOM 要回写 Markdown，标记不能动）。
       为什么必须做：`[!claim]` 是回写用的标记，直接留在正文里像没渲染完的源码。 */
    const KIND_LABEL = {
      claim: "论断", note: "注记", question: "问题", source: "出处", formula: "公式",
      method: "方法", term: "术语", def: "定义", define: "定义", assume: "假设",
      proof: "证明", quote: "引文", warn: "注意", tip: "提示", todo: "待办", info: "说明",
      cite: "引用",
    };
    function decorateCalloutTitles(rootEl) {
      if (!rootEl) return;
      rootEl.querySelectorAll("blockquote.rs-callout").forEach((q) => {
        if (q.dataset.calloutHead === "1" || q.classList.contains("rs-callout-term")) return;
        const first = q.firstElementChild;
        const got = splitMarkerLine(first);
        if (!got) return;
        q.dataset.calloutHead = "1";
        const head = el("div", "rs-callout-head");
        /* 论断不挂标签：claim 是笔记里出现最多的一类，每段顶一颗「论断」就成了色块；
           标题自己就够读（其余种类仍留一行小字，形制见 CSS 的 .rs-callout-kind）。 */
        if (got.kind !== "claim") head.appendChild(el("span", "rs-callout-kind", KIND_LABEL[got.kind] || got.kind));
        const title = el("span", "rs-callout-title");
        got.titleNodes.forEach((nd) => title.appendChild(nd));
        if (String(title.textContent || "").trim() || title.querySelector("*")) head.appendChild(title);
        q.insertBefore(head, q.firstChild);
        tidyEmpty(first);
      });
    }

    /* ── 双链：`[[指数和]]` / `[[指数和|显示名]]` → 可点的条目梗 ──
       `[[…]]` 是这个项目里的「条目引用」，直接留原文就是没渲染完的源码；
       点一下跳到同名笔记，没有笔记就明说没有（图谱要用户自己建，不假装有条目）。
       标题里的双链同样要收：初始化 / 派生稿把术语直接写进小节标题
       （`### 1. [[Transformer]]（Transformer）`），过去 h1–h3 被整段跳过，
       标题里就永远露着 `[[…]]` 源码。 */
    function decorateWikilinks(rootEl) {
      if (!rootEl) return;
      const skipTag = new Set(["CODE", "PRE", "SCRIPT", "STYLE", "A", "TEXTAREA"]);
      const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT);
      const jobs = [];
      let tn;
      while ((tn = walker.nextNode())) {
        const p = tn.parentElement;
        if (!p || skipTag.has(p.tagName)) continue;
        if (inSvgTree(p)) continue;
        if (p.closest(".rv-math, .rs-wl, .rs-callout-title, .rs-term-name")) continue;
        if (String(tn.nodeValue || "").indexOf("[[") < 0) continue;
        jobs.push(tn);
      }
      for (const node of jobs) {
        const s = String(node.nodeValue || "");
        const re = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;
        let m;
        let pos = 0;
        let frag = null;
        while ((m = re.exec(s))) {
          if (!frag) frag = document.createDocumentFragment();
          if (m.index > pos) frag.appendChild(document.createTextNode(s.slice(pos, m.index)));
          const target = String(m[1] || "").trim();
          const span = el("span", "rs-wl", String(m[2] || target).trim());
          span.dataset.wl = target;
          span.title = target;
          frag.appendChild(span);
          pos = m.index + m[0].length;
        }
        if (!frag) continue;
        if (pos < s.length) frag.appendChild(document.createTextNode(s.slice(pos)));
        node.parentNode.replaceChild(frag, node);
      }
    }

    /* ── 溯源行：`支撑：…` / `verify: doubt` 这类是给机器读的元信息，不该和正文同样抢眼 ──
       引用块里这些行是同一个 <p> 里用 <br> 隔开的，所以按 <br> 切行再包 span。 */
    const META_RE = /^\s*(支撑|核验|verify|status|状态|标签|tags)\s*[:：]/i;
    function decorateMetaLines(rootEl) {
      if (!rootEl) return;
      rootEl.querySelectorAll("p").forEach((p) => {
        if (p.dataset.metaDone === "1") return;
        p.dataset.metaDone = "1";
        const lines = [[]];
        for (const nd of [...p.childNodes]) {
          if (nd.nodeType === 1 && nd.tagName === "BR") {
            lines.push([]);
            continue;
          }
          lines[lines.length - 1].push(nd);
        }
        if (lines.length < 2) {
          if (META_RE.test(String(p.textContent || ""))) p.classList.add("rs-meta");
          return;
        }
        for (const group of lines) {
          if (!group.length) continue;
          const text = group.map((n) => String(n.textContent || "")).join("");
          if (!META_RE.test(text)) continue;
          const span = el("span", "rs-meta-line");
          /* 核验状态是这套笔记的核心字段 —— `verify: doubt` 与 `verify: verified` 一眼要能分开 */
          const vm = /verify\s*[:：]\s*([A-Za-z-]+)/i.exec(text);
          if (vm) {
            const st = vm[1].toLowerCase();
            span.classList.add("rs-meta-verify");
            if (st === "verified") span.classList.add("rs-verified");
            else if (st === "doubt") span.classList.add("rs-doubt");
          }
          group[0].parentNode.insertBefore(span, group[0]);
          group.forEach((n) => span.appendChild(n));
        }
      });
    }

    /* ── 段首引导句提级：`**贡献。** 本文提出…` 这种「行内粗体 + 紧随正文」的写法，
       阅读态把块首那一截粗体提成独立的 `.rs-h-lead` 小标题块，后继文字留成它下面的一段。
       判定只看块首那颗 <strong>/<b>：文本以 。：: 收尾，或者它自己就短（中文 ≤ 12 字 /
       英文 ≤ 6 词）—— 太长的粗体是强调，提出来会读成一条假标题。
       **只在阅读态 DOM 上做**：编辑面（contenteditable）不走 decorate，richToMarkdown 也
       就看不到这些块，回写不受影响。 */
    const LEAD_END_RE = /[。：:]$/;
    const LEAD_LATIN_RE = /[A-Za-z]/;
    /* 不参与提级的上下文：代码 / 表格 / SVG 里改结构会烂排版；列表项里塞块级子节点会断列表；
       引用块与术语卡本身就是「块中块」、自带抬头形制；溯源行是元信息，不是标题。 */
    const LEAD_SKIP_SEL =
      "pre, code, table, svg, li, figcaption, button, .rs-callout, .rs-term-card, .rs-meta-line, .rs-meta, .rs-h-lead";
    function isLeadHeading(txt) {
      const s = String(txt == null ? "" : txt).replace(/\s+/g, " ").trim();
      if (!s) return false;
      if (LEAD_END_RE.test(s)) return true;
      /* 带拉丁字母的（纯英文，或 `对 Rademacher 与 Stein` 这种夹专名的）按词数算：
         按字数算会把这类短引导句误判成长句，把中文长句误判成标题 */
      if (LEAD_LATIN_RE.test(s)) return s.split(" ").filter(Boolean).length <= 6;
      return s.length <= 12;
    }
    function promoteLeadInlines(rootEl) {
      if (!rootEl) return;
      [...rootEl.querySelectorAll("p")].forEach((p) => {
        if (p.dataset.leadDone === "1") return;
        p.dataset.leadDone = "1";
        if (typeof p.closest === "function" && p.closest(LEAD_SKIP_SEL)) return;
        /* 块首第一颗「有内容」的节点：前导空白文本节点不算，先遇到文字就不是引导句 */
        let first = null;
        for (const nd of [...p.childNodes]) {
          if (nd.nodeType === 3) {
            if (String(nd.nodeValue || "").trim()) return;
            continue;
          }
          if (nd.nodeType !== 1) continue;
          first = nd;
          break;
        }
        if (!first || (first.tagName !== "STRONG" && first.tagName !== "B")) return;
        /* 一截「行内」粗体：里面还套了换行 / 块级节点就不是引导句 */
        if (first.querySelector("br, p, div, ul, ol, table, pre")) return;
        if (!isLeadHeading(first.textContent)) return;
        const lead = el("div", "rs-h-lead");
        lead.appendChild(first); /* 搬走这块粗体；p 里剩下的就是后继正文 */
        p.parentNode.insertBefore(lead, p);
        /* 换行合并后段首常留一个空格、或者留一个 <br>（元信息行旁边那一颗不参与合并）：
           去掉，否则新段落第一行会空一格 / 空一行 */
        let head = p.firstChild;
        while (
          head &&
          ((head.nodeType === 3 && !String(head.nodeValue || "").trim()) ||
            (head.nodeType === 1 && head.tagName === "BR"))
        ) {
          const next = head.nextSibling;
          head.remove();
          head = next;
        }
        if (head && head.nodeType === 3) head.nodeValue = String(head.nodeValue || "").replace(/^\s+/, "");
        /* 原来整段只有这一句标题（没有后继正文）：空段落就地删掉 */
        if (!String(p.textContent || "").trim() && !p.querySelector("*")) p.remove();
      });
    }

    /* ── 软换行合并：把「每句话单独一行」收成正常段落流 ──
       笔记源码是一句一行（机器写出来的就是这种行文），marked 开着 breaks:true 会把每个
       换行都渲染成 <br>，读起来就成了「每句话都自动换行」。这里在读完结构装饰之后，
       把这些**软换行**改回文字流：两侧都是中日韩字符直接贴合，否则补一个空格
       （英文笔记句子之间不能连字）。带语义的元信息行（支撑 / verify）与代码块不动。 */
    const CJK_EDGE_RE = /[\u2E80-\u9FFF\u3000-\u303F\uFE30-\uFE4F\uFF00-\uFFEF]/;
    function edgeChar(node, dir) {
      let n = dir < 0 ? node.previousSibling : node.nextSibling;
      while (n) {
        const raw = String(n.textContent || "");
        const txt = dir < 0 ? raw.replace(/\s+$/, "") : raw.replace(/^\s+/, "");
        if (txt) return dir < 0 ? txt.slice(-1) : txt.charAt(0);
        n = dir < 0 ? n.previousSibling : n.nextSibling;
      }
      return "";
    }
    function joinSoftBreaks(rootEl) {
      if (!rootEl) return;
      /* 同一趟「渲染收尾」里先把 `[@key]` 包成引用梗：阅读态、分栏预览、折叠投影、会话消息
         都走这一步，不必各自再调一次。 */
      decorateCitations(rootEl);
      /* 参考文献段落里含 `[@key]` / DOI / arXiv 的列表行整行可点（与引用梗同一趟收尾） */
      decorateRefLines(rootEl);
      for (const br of [...rootEl.querySelectorAll("br")]) {
        /* 代码块 / 表格里的换行是排版本身，别碰 */
        if (br.closest("pre, code, table")) continue;
        const prevEl = br.previousElementSibling;
        const nextEl = br.nextElementSibling;
        if (prevEl && prevEl.classList.contains("rs-meta-line")) continue;
        if (nextEl && nextEl.classList.contains("rs-meta-line")) continue;
        const a = edgeChar(br, -1);
        const b = edgeChar(br, 1);
        if (!a || !b || (CJK_EDGE_RE.test(a) && CJK_EDGE_RE.test(b))) {
          br.remove();
          continue;
        }
        br.replaceWith(document.createTextNode(" "));
      }
    }

    /* ── 文献引用：`[@key]`（Pandoc 式）在正文里原本只是一段裸文本 ──
       包成 `.rs-cite` 才有形制可上（圆角虚线 + 极浅底 + 引用色，见 research.css「链接类记号」）。
       `[@a; @b]` 是多篇同引，显示成 `@a; @b`，`data-cite` 留原始键表，后续要追溯时不用再解析一遍。
       **每一颗还带 data-line**（这一处 `[@…]` 在源码里的行号）：点开写笔记时「仅针对当前上下文」的
       唯一键 = 引用键 + 所在笔记 + 这一行，不靠猜、也不把同一篇文章的所有 @ 混成一条。 */
    const CITE_RE = /\[@([^\]\n]{1,160})\]/g;
    /* 源码里每一处 `[@…]` 的行号（围栏代码块里的不算，与渲染口径一致） */
    function citeEntriesOf(md) {
      const out = [];
      const lines = String(md == null ? "" : md).split(/\r?\n/);
      let fence = "";
      for (let i = 0; i < lines.length; i++) {
        const L = lines[i];
        const f = /^\s*(```+|~~~+)/.exec(L);
        if (f) {
          const mark = f[1].charAt(0);
          if (!fence) fence = mark;
          else if (fence === mark) fence = "";
          continue;
        }
        if (fence) continue;
        CITE_RE.lastIndex = 0;
        let m;
        while ((m = CITE_RE.exec(L))) {
          const keys = String(m[1] || "")
            .split(/[;,]/)
            .map((k) => k.replace(/^[\s@]+/, "").trim())
            .filter(Boolean);
          if (!keys.length) continue;
          out.push({ line: i + 1, keys: keys, sig: keys.join(";") });
        }
      }
      return out;
    }
    /* 这一颗引用梗对应源码里的哪一行：先按出现次序对号，次序对不上再按键找第一处同键 */
    function citeEntryFor(rootEl, idx, keys) {
      const list = (state.citeCtx && state.citeCtx.entries) || [];
      if (!list.length) return null;
      const sig = (keys || []).join(";");
      const hit = list[idx];
      if (hit && hit.sig === sig) return hit;
      for (let i = 0; i < list.length; i++) if (list[i].sig === sig) return list[i];
      return null;
    }
    function decorateCitations(rootEl) {
      if (!rootEl) return;
      const skipTag = new Set(["CODE", "PRE", "SCRIPT", "STYLE", "A", "TEXTAREA"]);
      const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT);
      const jobs = [];
      let tn;
      while ((tn = walker.nextNode())) {
        const p = tn.parentElement;
        if (!p || skipTag.has(p.tagName)) continue;
        if (inSvgTree(p)) continue;
        if (p.closest(".rv-math, .rs-wl, .rs-cite, .rs-term, .rs-callout-title, .rs-term-name")) continue;
        if (String(tn.nodeValue || "").indexOf("[@") < 0) continue;
        jobs.push(tn);
      }
      /* 已经包好的引用梗会算进次序里：分栏预览二次装饰时行号仍然对得上 */
      let seq = rootEl.querySelectorAll(".rs-cite").length;
      for (const node of jobs) {
        const s = String(node.nodeValue || "");
        CITE_RE.lastIndex = 0;
        let m;
        let pos = 0;
        let frag = null;
        while ((m = CITE_RE.exec(s))) {
          const keys = String(m[1] || "")
            .split(/[;,]/)
            /* 先削空白再削 `@`：`[@a; @b]` 里第二段前面带空格，顺序反了会拼出 `@@b` */
            .map((k) => k.replace(/^[\s@]+/, "").trim())
            .filter(Boolean);
          if (!keys.length) continue;
          if (!frag) frag = document.createDocumentFragment();
          if (m.index > pos) frag.appendChild(document.createTextNode(s.slice(pos, m.index)));
          const label = keys.map((k) => "@" + k).join("; ");
          const span = el("span", "rs-cite", label);
          span.dataset.cite = keys.join(";");
          const hit = citeEntryFor(rootEl, seq, keys);
          if (hit) span.dataset.line = String(hit.line);
          seq += 1;
          span.title = hit ? label + " · " + t("第 ") + hit.line + t(" 行") : label;
          frag.appendChild(span);
          pos = m.index + m[0].length;
        }
        if (!frag) continue;
        if (pos < s.length) frag.appendChild(document.createTextNode(s.slice(pos)));
        node.parentNode.replaceChild(frag, node);
      }
    }

    /* ── 参考文献段落：整行可点 ──
       判据（本轮共识）：**只认行内含 `[@key]` 或 DOI / arXiv 编号**的列表行 —— 不按「参考文献」标题推断，
       也不认纯文本的「作者. 题名. 年份」。命中就给整行挂 data-ref-* 与 .rs-refline；
       点下去做什么（打开全文 / 派 agent 获取）由宿主的 openRef 决定。 */
    const CITE_ONE_RE = /\[@([^\]\n]{1,160})\]/;
    const DOI_RE = /\b(10\.\d{4,9}\/[^\s，。；;)\]>"'）】]+)/;
    const ARXIV_RE = /\barXiv:\s*(\d{4}\.\d{4,5})(?:v\d+)?\b/i;
    function refLineInfo(li) {
      if (!li) return null;
      if (typeof li.closest === "function" && li.closest("pre, code, table")) return null;
      const txt = String(li.textContent || "").trim();
      if (!txt) return null;
      /* `[@key]` 这一趟已经被 decorateCitations 包成 `.rs-cite`（文字里只剩 `@key`），
         所以先看那颗引用梗的 data-cite，再退回原文正则（防止装饰顺序变化时漏掉）。 */
      const citeEl = li.querySelector ? li.querySelector(".rs-cite") : null;
      const mc = CITE_ONE_RE.exec(txt);
      const src = (citeEl && citeEl.dataset && citeEl.dataset.cite) || (mc ? mc[1] : "");
      const keys = src
        ? String(src)
            .split(/[;,]/)
            .map((k) => k.replace(/^[\s@]+/, "").trim())
            .filter(Boolean)
        : [];
      const md = DOI_RE.exec(txt);
      const ma = ARXIV_RE.exec(txt);
      if (!keys.length && !md && !ma) return null;
      return {
        key: keys[0] || "",
        doi: md ? String(md[1]).replace(/[.,;]+$/, "") : "",
        arxiv: ma ? String(ma[1]) : "",
        title: txt.slice(0, 160),
      };
    }
    function decorateRefLines(rootEl) {
      if (!rootEl || !openRef) return;
      rootEl.querySelectorAll("li").forEach((li) => {
        if (li.dataset.refline === "1") return;
        const info = refLineInfo(li);
        if (!info) return;
        li.dataset.refline = "1";
        if (info.key) li.dataset.refKey = info.key;
        if (info.doi) li.dataset.refDoi = info.doi;
        if (info.arxiv) li.dataset.refArxiv = info.arxiv;
        li.dataset.refTitle = info.title;
        li.classList.add("rs-refline");
        li.setAttribute("role", "link");
        li.tabIndex = 0;
        li.title = info.key
          ? t("这一行引用的是 @") + info.key + t("：本地有全文就打开，没有就让 agent 获取")
          : t("这一段是文献引用：本地有全文就打开，没有就让 agent 获取");
      });
    }
    function openRefLine(li) {
      if (!li || !openRef) return;
      openRef({
        key: String(li.dataset.refKey || ""),
        doi: String(li.dataset.refDoi || ""),
        arxiv: String(li.dataset.refArxiv || ""),
        title: String(li.dataset.refTitle || ""),
      });
    }

    /* ── 术语卡：`> [!term] 名称` 的引用块 → 「术语 · 名称」+ 定义 ── */
    function decorateTermCards(rootEl) {
      if (!rootEl) return;
      rootEl.querySelectorAll("blockquote.rs-callout-term").forEach((q) => {
        if (q.dataset.termDone === "1") return;
        q.dataset.termDone = "1";
        const first = q.firstElementChild;
        const got = splitMarkerLine(first);
        const head = el("div", "rs-term-name");
        if (got) {
          const title = el("span", "rs-term-title");
          got.titleNodes.forEach((nd) => title.appendChild(nd));
          head.appendChild(title);
          const name = String(title.textContent || "").trim();
          if (name) q.dataset.term = name;
          tidyEmpty(first);
        } else {
          head.appendChild(el("span", "rs-term-title", t("术语")));
        }
        q.insertBefore(head, q.firstChild);
      });
    }

    /* ── 公式编号：显示式按所在小节（h2）编号，2.3 = 第 2 节第 3 式 ── */
    function numberFormulas(rootEl) {
      if (!rootEl) return;
      let sec = 0;
      let no = 0;
      const list = [...rootEl.querySelectorAll("h2, .rv-math[data-rv-display='1']")];
      for (const node of list) {
        if (node.tagName === "H2") {
          sec += 1;
          no = 0;
          continue;
        }
        if (node.closest(".rs-eq")) continue;
        no += 1;
        const label = sec ? "(" + sec + "." + no + ")" : "(" + no + ")";
        const wrap = el("span", "rs-eq");
        wrap.dataset.eq = label;
        node.parentNode.insertBefore(wrap, node);
        wrap.appendChild(node);
        wrap.appendChild(el("span", "rs-eq-no", label));
      }
    }

    /* ── 超长公式：先缩一档，缩到底才露滚动提示 ──
       版心固定（v4 起 48rem ≈ 768px），`(\\log N)^{7/4+\\varepsilon}` 这类长式子比版心宽是常态。
       v8 的做法是「公式向左右各借 2.5rem + 内部可滚 + 滚动条藏起来」，实测 66 条显示式里仍有 2 条超出
       （(7.3) 差 81px）—— 而滚动条藏起来，读者根本不知道右边还有内容。
       所以责任分工改成：**JS 量宽、按可用宽度等比缩**（KaTeX 全部用 em，缩字号是等比缩宽，且不失真），
       下限 0.8（再小就伤可读性）；缩到底还溢出才挂 `.rs-eq-over`，由 v9 CSS 给一条细滚动条当提示。
       量之前先复位 inline 字号，否则上一次的缩放会影响这一次的判断（窗口变宽后本该还原）。 */
    const EQ_MIN_SCALE = 0.8;
    function fitFormulas(rootEl) {
      if (!rootEl) return [];
      const report = [];
      rootEl.querySelectorAll(".rs-eq").forEach((eq) => {
        const inner = eq.querySelector(".rv-math-display");
        if (!inner) return;
        inner.style.fontSize = "";
        eq.classList.remove("rs-eq-over");
        const avail = inner.clientWidth;
        const need = inner.scrollWidth;
        if (!avail || !need || need <= avail + 2) return;
        const base = parseFloat(getComputedStyle(inner).fontSize) || 16;
        const scale = Math.max(EQ_MIN_SCALE, avail / need);
        if (scale >= 0.995) {
          eq.classList.add("rs-eq-over");
          return;
        }
        inner.style.fontSize = (base * scale).toFixed(2) + "px";
        const stillOver = inner.scrollWidth > inner.clientWidth + 2;
        if (stillOver) eq.classList.add("rs-eq-over");
        report.push({
          eq: eq.dataset.eq || "?",
          scale: Math.round(scale * 1000) / 1000,
          stillOver,
        });
      });
      return report;
    }
    function queueFit() {
      if (!state.root || state.fitQueued) return;
      state.fitQueued = true;
      const run = () => {
        state.fitQueued = false;
        fitFormulas(state.root);
      };
      if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
      else setTimeout(run, 16);
    }

    /* ── 术语高亮：只在文本节点里换 span，跳过代码 / 公式 / 链接 / 术语卡自身 ── */
    function markTerms(rootEl) {
      const idx = state.terms;
      const names = [...idx.keys()].filter((n) => n && n.length >= 2).sort((a, b) => b.length - a.length);
      if (!names.length || !rootEl) return;
      const skipTag = new Set(["CODE", "PRE", "SCRIPT", "STYLE", "A", "BUTTON", "TEXTAREA", "H1", "H2", "H3", "H4"]);
      const seen = new Set();
      const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT);
      const jobs = [];
      let tn;
      while ((tn = walker.nextNode())) {
        const p = tn.parentElement;
        if (!p || skipTag.has(p.tagName)) continue;
        if (inSvgTree(p)) continue;
        if (p.closest(".rv-math, .rs-term, .rs-wl, .rs-callout-term, .rs-eq-no, .rs-term-name, .rs-callout-title, .rs-callout-head")) continue;
        const s = tn.nodeValue || "";
        if (s.trim().length < 2) continue;
        const hits = [];
        for (const nm of names) {
          let at = s.indexOf(nm);
          while (at >= 0) {
            hits.push({ name: nm, at, end: at + nm.length });
            at = s.indexOf(nm, at + nm.length);
          }
        }
        if (hits.length) jobs.push({ node: tn, s, hits });
      }
      for (const job of jobs) {
        const s = job.s;
        job.hits.sort((a, b) => a.at - b.at || b.end - b.at - (a.end - a.at));
        const frag = document.createDocumentFragment();
        let pos = 0;
        let lastEnd = 0;
        for (const h of job.hits) {
          if (h.at < lastEnd) continue;
          if (h.at > pos) frag.appendChild(document.createTextNode(s.slice(pos, h.at)));
          const span = el("span", "rs-term");
          span.textContent = h.name;
          span.dataset.term = h.name;
          if (!seen.has(h.name)) {
            seen.add(h.name);
            span.classList.add("rs-term-first");
          }
          frag.appendChild(span);
          pos = h.end;
          lastEnd = h.end;
        }
        if (pos < s.length) frag.appendChild(document.createTextNode(s.slice(pos)));
        job.node.parentNode.replaceChild(frag, job.node);
      }
    }

    /* ── 标题里的文字 / 公式：只取「看得见」的那一层 ──
       KaTeX 给每个公式都排了两份：可见的 .katex-html，以及给读屏与复制用的 .katex-mathml
       （MathML 的 <annotation> 里还留着整段原始 TeX）。直接 textContent 会把两份念一遍，
       大纲 / 面包屑上就成了「排版结果 + 一段 LaTeX 源码」粘在一起 —— 取文本前先摘掉那份。 */
    const MATH_SKIP = ".katex-mathml, .rs-eq-no";
    function visibleInline(node) {
      const box = el("span");
      if (node) [...node.childNodes].forEach((nd) => box.appendChild(nd.cloneNode(true)));
      box.querySelectorAll(MATH_SKIP).forEach((n) => n.remove());
      return box;
    }
    function inlineTextOf(node) {
      return String(visibleInline(node).textContent || "").replace(/\s+/g, " ").trim();
    }
    /* 公式搬进大纲 / 面包屑时不重排一次，直接搬可见节点（字号由容器决定）；
       标题里若嵌了 <a>，在 <a> 里再套 <a> 不合法，就地摊平成它的内容。
       双链 `.rs-wl` 同样摊平：标题里的 `[[术语]]` 已经收成链接，但大纲 / 面包屑里的那一份
       是「点了滚到这一节」的按钮内容 —— 留着链接样式会让人以为点它能跳篇，而实际不跳。 */
    function inlineHtmlOf(node) {
      const box = visibleInline(node);
      box.querySelectorAll(".rs-wl").forEach((w) => {
        w.replaceWith(document.createTextNode(String(w.textContent || "")));
      });
      box.querySelectorAll("a").forEach((a) => {
        const frag = document.createDocumentFragment();
        while (a.firstChild) frag.appendChild(a.firstChild);
        a.replaceWith(frag);
      });
      return box.innerHTML;
    }
    /* 纯文本里的一行公式 → HTML（术语定义这类只有字符串的地方用）：
       与正文同一份 math 渲染器；抽不出公式时原样转义，不吞字符。 */
    function inlineMathHtml(text) {
      const s = String(text == null ? "" : text);
      const M = math();
      if (M && typeof M.inlineToHtml === "function") {
        try {
          return M.inlineToHtml(s);
        } catch (_) {}
      }
      return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }

    /* ── 章节数据：一次解析，右侧大纲与顶栏面包屑共用 ──
       h1 / h2 算「章」，h3 算「节」，`.rs-h-lead`（阅读态提级的段首引导句）算「小标题」：
       大纲里比「节」再缩进一级，面包屑不吃它（末两级仍是 章 / 节）。
       state.sections 是唯一的章节表：换笔记时整体替换，源码 / 折叠投影 / 图谱态置空。 */
    function collectSections(rootEl) {
      const heads = rootEl ? [...rootEl.querySelectorAll("h1, h2, h3, .rs-h-lead")] : [];
      const out = [];
      heads.forEach((h) => {
        const text = inlineTextOf(h);
        if (!text) return;
        if (!h.id) h.id = "rs-out-" + out.length;
        out.push({
          id: h.id,
          el: h,
          level: h.tagName === "H1" ? 1 : h.tagName === "H2" ? 2 : h.tagName === "H3" ? 3 : 4,
          text: text,
          html: inlineHtmlOf(h),
        });
      });
      /* 第一个 h1 就是这篇的标题（页面顶上已大字写着）：它是「文档名」不是「章」，
         大纲不列它、面包屑的章一级也不拿它充数。 */
      const firstH1 = out.find((s) => s.level === 1) || null;
      if (firstH1) firstH1.isDocTitle = true;
      return out;
    }
    /* 现在读到哪一节：章 = 当前 / 之前最近的 h1·h2，节 = 当前正好是 h3（或 h3 下的段首小标题）
       时的那一节。面包屑末两级吃这一份结构，滚动时不再解析 Markdown。 */
    function activeInfo() {
      const secs = state.sections || [];
      const i = typeof state.active === "number" ? state.active : -1;
      if (i < 0 || !secs[i]) return null;
      let chapter = null;
      for (let k = i; k >= 0; k--) {
        if (secs[k].level <= 2 && !secs[k].isDocTitle) {
          chapter = { index: k, kind: t("章"), text: secs[k].text, html: secs[k].html };
          break;
        }
      }
      const part = secs[i].level >= 3 ? nearestPart(i) : null;
      return { index: i, chapter: chapter, part: part };
    }
    /* 当前落在「节」或节内的段首小标题（level 4）上时，那一节 = 往上最近的 h3。
       小标题自己不进面包屑，但读它时「章 / 节」不该空掉。 */
    function nearestPart(i) {
      const secs = state.sections || [];
      for (let k = i; k >= 0; k--) {
        if (secs[k].level === 3) return { index: k, kind: t("节"), text: secs[k].text, html: secs[k].html };
        if (secs[k].level <= 2) return null;
      }
      return null;
    }
    function emitActive() {
      if (typeof state.onActive !== "function") return;
      try {
        state.onActive(activeInfo());
      } catch (_) {}
    }
    function setActive(idx, items) {
      const secs = state.sections || [];
      if (!secs[idx]) return;
      const a = items ? items.get(secs[idx].id) : null;
      if (state.curItem && state.curItem !== a) state.curItem.classList.remove("on");
      if (a) {
        a.classList.add("on");
        state.curItem = a;
      }
      if (idx === state.active) return;
      state.active = idx;
      emitActive();
    }

    /* ── 右侧大纲：h1/h2/h3 与段首小标题（lv4，再缩进一级）进目录，点击平滑滚动，滚动时高亮当前节 ── */
    function buildOutline(rootEl, pane, scrollEl, opts) {
      const o = opts || {};
      if (typeof o.onActive === "function") state.onActive = o.onActive;
      stopSpy();
      /* 章节表只在这里解析：pane 为空（源码 / 折叠投影 / 图谱态）时表也清空，
         面包屑的章 / 节随之收起，不留上一篇的旧标题。 */
      state.sections = collectSections(rootEl);
      state.active = state.sections.length ? 0 : -1;
      state.curItem = null;
      state.scroll = scrollEl;
      const all = state.sections;
      if (!pane) {
        emitActive();
        return all;
      }
      pane.innerHTML = "";
      /* 第一个 h1 就是这篇笔记的标题（页面顶上已经大字写着），目录里再列一遍是重复；
         面包屑仍认它在章节表里（滚动判定要用），只是不进目录、不当「章」。 */
      const docTitle = all.find((s) => s.isDocTitle) || null;
      const valid = all.filter((s) => s !== docTitle);
      if (valid.length < 2) {
        pane.classList.add("empty");
        emitActive();
        return all;
      }
      pane.classList.remove("empty");
      const head = el("div", "rs-outline-head");
      head.appendChild(el("span", "rs-outline-title", t("大纲")));
      const fold = el("button", "rs-outline-fold", "▾");
      fold.title = t("折叠 / 展开大纲");
      fold.onclick = () => {
        pane.classList.toggle("collapsed");
        fold.textContent = pane.classList.contains("collapsed") ? "▸" : "▾";
      };
      head.appendChild(fold);
      pane.appendChild(head);
      const list = el("div", "rs-outline-list");
      valid.forEach((s) => {
        const a = el("a", "rs-outline-item lv" + s.level);
        a.href = "#" + s.id;
        if (s.html) a.innerHTML = s.html;
        else a.textContent = s.text;
        a.title = s.text;
        a.onclick = (ev) => {
          ev.preventDefault();
          scrollToHead(s.el, scrollEl);
        };
        list.appendChild(a);
      });
      pane.appendChild(list);
      /* 首屏往往没有任何标题落在顶部判定带里（大标题 + 摘要还没滚到），
         先点亮第一条，别让人以为目录不跟着正文走。
         必须同时记成 curItem：否则滚到下一节时 setActive 只给新项加 .on，
         这一条留在原地，大纲里会同时亮两条（DOM 体检抓到的）。 */
      const first = list.firstElementChild;
      if (first) {
        first.classList.add("on");
        state.curItem = first;
      }
      watchHeads(pane, all, scrollEl);
      state.outline = pane;
      emitActive();
      return all;
    }
    function stopSpy() {
      if (state.spy) {
        try {
          state.spy.disconnect();
        } catch (_) {}
        state.spy = null;
      }
    }
    function scrollToHead(h, scrollEl) {
      const body = scrollEl;
      if (!body) return;
      const top = h.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop - 18;
      try {
        body.scrollTo({ top, behavior: "smooth" });
      } catch (_) {
        body.scrollTop = top;
      }
    }
    /* 面包屑点「章 / 节」：按章节表下标滚过去 */
    function scrollToIndex(i, scrollEl) {
      const s = (state.sections || [])[i];
      if (!s) return;
      scrollToHead(s.el, scrollEl || state.scroll);
    }
    function watchHeads(pane, sections, scrollEl) {
      const body = scrollEl;
      if (!body || typeof IntersectionObserver !== "function") return;
      const items = new Map();
      pane.querySelectorAll(".rs-outline-item").forEach((a) => {
        const id = String(a.getAttribute("href") || "").slice(1);
        if (id) items.set(id, a);
      });
      state.spy = new IntersectionObserver(
        (entries) => {
          const vis = entries.filter((e) => e.isIntersecting);
          if (!vis.length) return;
          const top = vis.sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
          const idx = sections.findIndex((s) => s.id === top.target.id);
          if (idx >= 0) setActive(idx, items);
        },
        { root: body, rootMargin: "0px 0px -72% 0px", threshold: 0 },
      );
      sections.forEach((s) => state.spy.observe(s.el));
    }

    /* ── 阅读进度：正文滚到哪儿，顶上那条细线就走到哪儿 ── */
    function updateProgress(scrollEl, progressEl) {
      const body = scrollEl || state.scroll;
      const bar = progressEl && progressEl.firstElementChild;
      if (!body || !bar) return;
      const max = body.scrollHeight - body.clientHeight;
      const p = max > 0 ? Math.min(1, Math.max(0, body.scrollTop / max)) : 0;
      bar.style.width = (p * 100).toFixed(2) + "%";
    }
    function bindProgress(scrollEl, progressEl) {
      const body = scrollEl;
      if (!body || body.dataset.progBound === "1") return;
      body.dataset.progBound = "1";
      body.addEventListener("scroll", () => updateProgress(body, progressEl), { passive: true });
      updateProgress(body, progressEl);
    }

    /* ── 术语浮层 / 公式放大：事件委托挂在滚动容器上（宿主 DOM 不变，内容换了也还认） ── */
    function bindTips(scrollEl) {
      const host = scrollEl;
      if (!host || host.dataset.tipsBound === "1") return;
      host.dataset.tipsBound = "1";
      host.addEventListener("mouseover", (ev) => {
        const s = ev.target.closest && ev.target.closest(".rs-term");
        if (s) showTermTip(s);
      });
      host.addEventListener("mouseout", (ev) => {
        const s = ev.target.closest && ev.target.closest(".rs-term");
        if (!s) return;
        const to = ev.relatedTarget;
        if (to && (s.contains(to) || (state.tip && state.tip.contains(to)))) return;
        hideTermTip();
      });
      /* 参考文献整行是 role=link：键盘 Enter / 空格与点击同一条路（不做「看不见的可聚焦点」） */
      host.addEventListener("keydown", (ev) => {
        if (ev.key !== "Enter" && ev.key !== " ") return;
        const tgt = ev.target;
        if (!(tgt && tgt.closest && tgt.closest(".rs-rich"))) return;
        const li = tgt.closest(".rs-refline");
        if (!li) return;
        ev.preventDefault();
        openRefLine(li);
      });
      host.addEventListener("click", (ev) => {
        const tgt = ev.target;
        /* 只在自己的 `.rs-rich` 宿主里生效：委托挂在**滚动容器**上（跨笔记复用），索引页
           `.rs-idx-src` 的正文也在容器里，但整张卡就是一个按钮 —— 里面的公式要是照常弹公式浮层，
           卡就打不开了。术语 / 引用梗 / 双链本来就只在 `.rs-rich` 里装饰，这里一并按宿主收口。 */
        if (!(tgt && tgt.closest && tgt.closest(".rs-rich"))) return;
        /* 参考文献整行可点：行内那颗 `[@key]` 引用梗自己优先（它弹引用浮层，浮层里就是「文献」行） */
        const refLi = tgt.closest && tgt.closest(".rs-refline");
        if (refLi && !(tgt.closest && tgt.closest(".rs-cite"))) {
          ev.preventDefault();
          openRefLine(refLi);
          return;
        }
        const wl = tgt.closest && tgt.closest(".rs-wl");
        if (wl) {
          /* 就地编辑面（data-rs-inline）：双链只是显示层，点了放光标就好 —— 编辑到一半
             被跳去另一篇是最难受的一种（引用梗的浮层照旧，它不改正文）。 */
          if (wl.closest && wl.closest('[data-rs-inline="1"]')) return;
          const name = wl.dataset.wl || "";
          /* 双链点击 = 与术语同一套浮空卡，**不直接进页面**：一条链接可能对应多条内容
             （它指向的那一页 + 库里写过它的笔记），也可能一个都没有、需要现场新建 ——
             所以先把「有哪几条」摊开，进页面只在点第一行 / 点某张卡时发生；卡底那颗
             「新建一条笔记」交给宿主的候选面板（模型给角度 → 勾选 → 派会话成稿）。
             linkPage 由宿主提供（只有那边认得全库笔记的标题 / label / 别名）；
             没有它（老嵌入方 / 验证页）才退回老行为：直接跳页。 */
          ev.preventDefault();
          if (linkPage) {
            const page = linkPage(name);
            const hits = (page ? [page] : []).concat(noteHits("term", [name]));
            showNoteCards(wl, { kind: "link", title: name, keys: [name], hits });
            return;
          }
          const ok = openLink ? openLink(name) : false;
          if (!openLink && toast) toast(t("条目：") + name);
          if (ok === false && onMissing) onMissing("term", name, rectOf(wl));
          return;
        }
        /* 点 `[@key]` 引用梗 = 与术语同一套浮层：列出「写过这一处引用」的笔记（引用键 + 本篇 + 这一行，
           精确匹配，不把同一篇文章在别处的 @ 拉进来），底部给一颗「写一条笔记」交给宿主落盘。 */
        const cite = tgt.closest && tgt.closest(".rs-cite");
        if (cite) {
          ev.preventDefault();
          const keys = String(cite.dataset.cite || "")
            .split(";")
            .map((k) => k.trim())
            .filter(Boolean);
          if (!keys.length) return;
          const ctx = { path: String((state.citeCtx && state.citeCtx.path) || ""), line: Number(cite.dataset.line) || 0 };
          const hits = noteHits("cite", keys, ctx);
          showNoteCards(cite, {
            kind: "cite",
            title: keys.map((k) => "@" + k).join("; "),
            keys,
            hits,
            cite: ctx,
          });
          return;
        }
        const s = tgt.closest && tgt.closest(".rs-term");
        if (s) {
          /* 点术语 = 看「库里哪些笔记写过它」（一篇一卡）；库里一条都没有才退回候选面板 */
          ev.preventDefault();
          const name = String(s.dataset.term || "").trim();
          const hits = noteHits("term", [name]);
          if (hits.length) showNoteCards(s, { kind: "term", title: name, keys: [name], hits });
          else if (onMissing) {
            hideNoteCards();
            onMissing("term", name, rectOf(s));
          }
          return;
        }
        const m = tgt.closest && tgt.closest(".rv-math");
        if (!m) return;
        const sel = typeof window !== "undefined" && window.getSelection ? String(window.getSelection().toString() || "").trim() : "";
        if (sel) return;
        /* 点公式 = 一次点击一个浮层：库里写过这条式子就列笔记卡（卡头那颗 ⤢ 进同一个公式浮层）；
           一条都没有就直接开公式浮层 —— 编号 / 编辑 LaTeX / 放大 / 关闭，中部渲染式，
           下部就是「扩充方向」（与术语浮层同一块，不再弹第二个面板）。 */
        ev.preventDefault();
        const eq = m.closest ? m.closest(".rs-eq") : null;
        const label = (eq && eq.dataset.eq) || "";
        const tex = (m.getAttribute && m.getAttribute("data-rv-tex")) || "";
        const keys = [];
        if (label) keys.push(label);
        if (tex && String(tex).trim().length >= 4) keys.push(tex);
        const fHits = noteHits("formula", keys.length ? keys : [label || tex]);
        if (fHits.length) {
          showNoteCards(m, { kind: "formula", title: label || t("公式"), keys, hits: fHits, mathEl: m, tex });
        } else {
          hideNoteCards();
          openEq(m);
        }
      });
    }
    /* ── 选区右键菜单：复制 / 创建链接 / 剪切 ──
       委托挂在正文容器上，**只在自己的 `.rs-rich` 宿主里生效**；选中为空时什么都不做，
       原生菜单照旧弹（不抢浏览器的行为）。三项里只有「复制」由阅读器自己做（与公式弹窗
       同一个出口 appClipboardWrite）；「创建链接」「剪切」都要动 Markdown 源码，
       一律交宿主回调 —— 阅读器不改 md、不落盘。
       浮层口径：点空白 / Esc / 右键同一处同一段再点一次关闭；开菜单先收术语卡与笔记浮层，
       两块不叠放。 */
    function closeCtxMenu() {
      if (state.ctxEsc) document.removeEventListener("keydown", state.ctxEsc, true);
      if (state.ctxDown) document.removeEventListener("mousedown", state.ctxDown, true);
      state.ctxEsc = null;
      state.ctxDown = null;
      if (state.ctx) state.ctx.remove();
      state.ctx = null;
      state.ctxKey = "";
    }
    /* 复制：剪贴板唯一出口（裸调 navigator.clipboard 会被主窗权限闸拒，见 app-clipboard.js） */
    function copyViaClipboard(text) {
      const p = typeof appClipboardWrite === "function" ? appClipboardWrite(text) : Promise.resolve({ ok: false });
      Promise.resolve(p).then(
        (r) => {
          if (toast) toast(r && r.ok ? t("已复制") : t("复制失败：剪贴板不可用"), r && r.ok ? "ok" : "warn");
        },
        () => {
          if (toast) toast(t("复制失败：剪贴板不可用"), "warn");
        },
      );
    }
    function showCtxMenu(ev, rich, text) {
      const key = text + "\u0000" + String(rich && rich.className ? rich.className : "");
      /* 再点一次（同一宿主、同一段文字）＝ 关掉菜单 */
      if (state.ctx && state.ctxKey === key) {
        closeCtxMenu();
        return;
      }
      closeCtxMenu();
      hideTermTip();
      hideNoteCards();
      const box = el("div", "rs-ctxmenu");
      box.addEventListener("mousedown", (e) => e.stopPropagation());
      box.addEventListener("contextmenu", (e) => e.preventDefault());
      const add = (label, title, fn) => {
        const b = el("button", "rs-ctxmenu-item", label);
        b.type = "button";
        if (title) b.title = title;
        b.onclick = () => {
          closeCtxMenu();
          try {
            fn();
          } catch (e) {
            if (toast) toast(String((e && e.message) || e), "err");
          }
        };
        box.appendChild(b);
      };
      add(t("复制"), t("复制选中的这段文字"), () => copyViaClipboard(text));
      if (wrapLink) {
        add(t("创建链接"), t("把这段文字在正文里包成 [[…]]"), () => {
          const r = wrapLink(text);
          if (r && typeof r.catch === "function") {
            r.catch((e) => {
              if (toast) toast(String((e && e.message) || e), "err");
            });
          }
        });
      }
      /* 剪切只在编辑态出现：删的是源码（textarea）里那段文字 */
      if (isEditing && isEditing() && cutSelection) {
        add(t("剪切"), t("从源码里删掉这段文字并写进剪贴板"), () => {
          const ok = cutSelection(text);
          if (ok === false && toast) toast(t("源码里没有这段文字，没有动"), "warn");
        });
      }
      /* 浮层挂在 body 上：亮色纸（.rs-light）那一档的变量得自己带上 */
      const paneEl = typeof document !== "undefined" ? document.getElementById("researchPane") : null;
      if (paneEl && paneEl.classList.contains("rs-light")) box.classList.add("rs-light");
      document.body.appendChild(box);
      const w = box.offsetWidth;
      const h = box.offsetHeight;
      const left = Math.min(Math.max(8, ev.clientX), Math.max(8, window.innerWidth - w - 12));
      const top = Math.min(Math.max(8, ev.clientY), Math.max(8, window.innerHeight - h - 12));
      box.style.left = left + "px";
      box.style.top = top + "px";
      state.ctx = box;
      state.ctxKey = key;
      state.ctxEsc = (e2) => {
        if (e2.key !== "Escape") return;
        e2.stopPropagation();
        closeCtxMenu();
      };
      document.addEventListener("keydown", state.ctxEsc, true);
      state.ctxDown = (e2) => {
        /* 右键交给 contextmenu 那一路判（它才知道是不是「同一处同一段 = 再点一次」） */
        if (e2.button === 2) return;
        if (state.ctx && state.ctx.contains(e2.target)) return;
        closeCtxMenu();
      };
      document.addEventListener("mousedown", state.ctxDown, true);
    }
    /* 挂一次就够（dataset 标记）：容器换了内容也还认，因为委托不挂在 `.rs-rich` 自己身上 */
    function bindContextMenu(host) {
      if (!host || host.dataset.ctxBound === "1") return;
      host.dataset.ctxBound = "1";
      host.addEventListener("contextmenu", (ev) => {
        const tgt = ev.target;
        const rich = tgt && tgt.closest ? tgt.closest(".rs-rich") : null;
        if (!rich || !host.contains(rich)) {
          /* 右键落在阅读区外面：菜单收起，原生菜单照常弹 */
          closeCtxMenu();
          return;
        }
        const sel = typeof window !== "undefined" && window.getSelection ? window.getSelection() : null;
        const text = sel ? String(sel.toString() || "").trim() : "";
        if (!text) {
          closeCtxMenu();
          return; /* 选中为空：不动原生菜单 */
        }
        /* 选区必须就在这个宿主里（页面别处选中的字不该在这里右键成菜单） */
        const node = sel.anchorNode;
        const hostEl = node && (node.nodeType === 3 ? node.parentElement : node);
        if (!hostEl || !rich.contains(hostEl)) {
          closeCtxMenu();
          return;
        }
        ev.preventDefault();
        showCtxMenu(ev, rich, text);
      });
    }
    /* 普通对象化的矩形：回调里可能延迟使用，别让它抱着会变的 live DOMRect */
    function rectOf(node) {
      const r = node && node.getBoundingClientRect ? node.getBoundingClientRect() : null;
      if (!r) return { left: 8, top: 8, right: 8, bottom: 8, width: 0, height: 0 };
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
    }
    /* 一小段 Markdown → HTML（术语说明这类「卡片正文」用）：
       优先用宿主注入的整段渲染器，其次用页面上的 MTRender.toHtml ——
       段落 / 列表 / 粗体 / 行内代码 / 引用 / 表格 与公式都在这一份里；
       两者都缺席才退回「只排公式」，别在术语卡里露 `**` 或 `$…$` 源码。 */
    function cardHtml(text) {
      const s = String(text == null ? "" : text);
      let fn = renderMd;
      if (!fn && typeof window !== "undefined" && window.MTRender && typeof window.MTRender.toHtml === "function") {
        fn = window.MTRender.toHtml;
      }
      if (fn) {
        try {
          const html = fn(s);
          if (html) return html;
        } catch (_) {}
      }
      return inlineMathHtml(s);
    }
    /* 这一页有没有整段 Markdown 渲染器：有就走块级排版（CSS 的 pre-wrap 要关掉） */
    function hasMdRenderer() {
      if (renderMd) return true;
      return !!(typeof window !== "undefined" && window.MTRender && typeof window.MTRender.toHtml === "function");
    }
    /* 浮层卡片正文（术语 / 引用 / 公式那三档里的「方向 + 正文」）：**一段流**里的行内 Markdown。
       为什么不走 cardHtml：卡片靠 -webkit-line-clamp 截 3 行，块级 <p>/<ul> 会把这段流拆散。
       不注入时退回只排公式 —— 任何一档都别在卡片里露 `**定义**` / `$p$` 源码。 */
    function cardInlineHtml(text) {
      const s = String(text == null ? "" : text);
      if (typeof window !== "undefined" && window.MTRender && typeof window.MTRender.inlineMd === "function") {
        try {
          const html = window.MTRender.inlineMd(s);
          if (html) return html;
        } catch (_) {}
      }
      return inlineMathHtml(s);
    }
    function showTermTip(span, pinned) {
      const name = span.dataset.term || "";
      const def = state.terms.get(name);
      if (!def) return;
      /* 笔记浮层开着的时候不再冒定义小卡：两块都贴着同一个词，叠在一起谁也读不了。
         这时点术语仍然有效（点 = 换成/关掉笔记浮层），浮层一关，悬停立刻恢复。 */
      if (state.cards && state.cards.classList.contains("show")) return;
      if (!state.tip) {
        state.tip = el("div", "rs-termtip");
        state.tip.addEventListener("mouseleave", () => hideTermTip());
        document.body.appendChild(state.tip);
      }
      const tip = state.tip;
      tip.innerHTML = "";
      tip.appendChild(el("div", "rs-termtip-name", name));
      /* 定义里常带 Markdown（列表 / 粗体 / 代码 / 表格）与公式：按正文同一套排出来 */
      const body = el("div", "rs-termtip-body");
      body.innerHTML = cardHtml(def.text || t("（这条术语还没有写定义）"));
      if (hasMdRenderer()) body.classList.add("is-md");
      tip.appendChild(body);
      if (openNote) {
        const go = el("button", "rs-termtip-go", t("打开出处"));
        go.onclick = () => {
          hideTermTip();
          openNote(def.path, { line: def.line });
        };
        tip.appendChild(go);
      }
      tip.classList.add("show");
      tip.classList.toggle("pinned", !!pinned);
      const r = span.getBoundingClientRect();
      const w = tip.offsetWidth;
      const h = tip.offsetHeight;
      const left = Math.min(Math.max(8, r.left), Math.max(8, window.innerWidth - w - 12));
      let top = r.bottom + 8;
      if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 8);
      tip.style.left = left + "px";
      tip.style.top = top + "px";
    }
    function hideTermTip() {
      if (state.tip && !state.tip.classList.contains("pinned")) state.tip.classList.remove("show");
    }

    /* ── 笔记浮层：点术语 / 点公式 → 「这条东西，库里哪些笔记写过它」──
       共识（真机拍的板）：浮层里一篇笔记一张卡，默认一行 = **标题 + 一行摘要**。
       标题取方向来自 frontmatter 的 `方向:` / `angle:` / `direction:`（值是自由文字）；旧笔记没写方向，
       就退回这条 callout 的种类（定义 / 公式 / 论断 / 注记…），不留空标签。
       摘要取正文第一句（剥掉行内 Markdown 标记，单行省略交给 CSS），不改写任何数据。
       点这条 = 就地向下展开全文（cardInlineHtml：`**粗**`、`` `代码` ``、`$…$` 都不许露源码）；
       进笔记只走展开后行尾那颗「打开」（页那一行 line=0 = 进整篇）。同一份卡一次只展开一条。 */
    const CARDS_MAX = 24;
    /* 引用笔记的「来源行」：`来源：notes/x.md:120`（全角/半角冒号都认）——
       这一行就是「仅针对当前上下文」的唯一键，引用键只说明引的是哪一篇，不说明是哪一处。 */
    function citeSrcOf(text) {
      const m = /来源[ \t]*[:：][ \t]*([^\s:：]+)[ \t]*[:：][ \t]*(\d+)/.exec(String(text || ""));
      if (!m) return null;
      return { path: normRelLite(m[1]), line: Number(m[2]) || 0 };
    }
    function normRelLite(p) {
      return String(p == null ? "" : p)
        .replace(/\\/g, "/")
        .replace(/^\.\//, "")
        .replace(/\/+/g, "/");
    }
    function noteHits(kind, keys, ctxArg) {
      const wants = (keys || []).map((k) => String(k || "").trim()).filter((k) => k);
      if (!wants.length) return [];
      const ctx = ctxArg || null;
      const out = [];
      for (const n of state.notes || []) {
        const note = (n && n.parsed && n.parsed.note) || {};
        const dir = String(note.angle || "").trim();
        for (const b of (n && n.parsed && n.parsed.blocks) || []) {
          if (!b || b.type !== "callout") continue;
          let body = "";
          if (kind === "cite") {
            /* 只认 `> [!cite] @key` 的笔记，且来源行必须**正好是这一处**（同一篇 + 同一行） */
            if (b.kind !== "cite") continue;
            const title = String(b.title || "").trim().replace(/^@+/, "");
            const tk = title
              .split(/[;,]/)
              .map((x) => x.trim())
              .filter(Boolean);
            if (!tk.some((k) => wants.indexOf(k) >= 0)) continue;
            const src = citeSrcOf(b.text);
            if (!src) continue;
            if (!ctx || !ctx.path) continue;
            if (src.path !== normRelLite(ctx.path)) continue;
            if (Number(ctx.line) && src.line !== Number(ctx.line)) continue;
            body = String(b.text || "")
              .split(/\r?\n/)
              .filter((line) => !/来源[ \t]*[:：]/.test(line))
              .join("\n")
              .trim();
          } else if (kind === "term") {
            if (b.kind !== "term") continue;
            const name = String(b.title || "").trim();
            if (wants.indexOf(name) < 0) continue;
            body = String(b.text || "").trim();
            if (body.indexOf(name) === 0) body = body.slice(name.length).replace(/^[ \t]*\n?/, "").trim();
          } else {
            const text = String(b.text || "");
            const label = String(b.title || "");
            if (!wants.some((w) => text.indexOf(w) >= 0 || label.indexOf(w) >= 0)) continue;
            body = text.trim();
          }
          out.push({
            path: String(n.path || ""),
            line: Number(b.line) || 1,
            dir: dir || KIND_LABEL[b.kind] || t("笔记"),
            text: body || t("（这条笔记只是引用了它，没有写说明）"),
          });
          if (out.length >= CARDS_MAX) return out;
        }
      }
      return out;
    }
    /* ── 一条卡的去处：页那一行（h.page）没有行号（0）= 进整篇；
       其余落在写过它的那一行。展开态里行尾那颗「打开」才走这里。 */
    function hitLine(h) {
      return Number(h && h.line) || 0;
    }
    function openHit(h) {
      const path = String((h && h.path) || "");
      if (!path || !openNote) return false;
      openNote(path, { line: hitLine(h) });
      return true;
    }
    /* 默认那一行摘要 = 正文第一句：剥掉行内 Markdown 标记后压成一行（只读，不改数据）。
       CSS 再单行省略；这里不改写、不落盘，也不抽新字段。 */
    function hitSummary(text) {
      let s = String(text == null ? "" : text);
      s = s.replace(/```[\s\S]*?```/g, " ");
      s = s.replace(/^\s{0,3}#{1,6}\s+/gm, "");
      s = s.replace(/^\s{0,3}>\s?/gm, "");
      s = s.replace(/!?\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, a, b) => String(b || a));
      s = s.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1");
      s = s.replace(/(\*\*|__)([\s\S]*?)\1/g, "$2");
      s = s.replace(/(^|[^*\w])\*([^*\n]+)\*/g, "$1$2");
      s = s.replace(/`([^`]*)`/g, "$1");
      s = s.replace(/\$([^$]*)\$/g, "$1");
      s = s.replace(/^\s*[-*+]\s+/gm, "");
      s = s.replace(/\s+/g, " ").trim();
      const m = /[^。！？；!?;]*[。！？；!?;]/.exec(s);
      if (m && m[0].trim()) s = m[0].trim();
      return s;
    }
    /* ── 一份卡：hits → 一串「标题 + 一行摘要 + 点开展开 + 行尾打开」──
       阅读区浮空卡与索引页浮空卡共用这一份（索引页不复制第二份卡）。
       opts: { onOpen(hit), empty, className }
       · 点这条 = 就地向下展开全文；同一份一次只展开一条（点开新的旧的自动收起）；
       · 展开后在行尾挂一颗「打开」，只有它进笔记（点行本身不跳转）；
       · 展开态是 DOM 节点（body / 打开钮按需挂、收起即摘），不赖 CSS 才敢动，
         整份重画（关浮层、切标签页、改筛选、重读笔记）自然全部收起，不做记忆。 */
    function noteCardList(hits, opts) {
      const o = opts || {};
      const list = el("div", "rs-ncards-list" + (o.className ? " " + o.className : ""));
      let openRow = null;
      function collapse(row) {
        if (!row) return;
        row.classList.remove("is-open");
        if (row.rsBody && row.rsBody.parentNode) row.rsBody.parentNode.removeChild(row.rsBody);
        if (row.rsOpen && row.rsOpen.parentNode) row.rsOpen.parentNode.removeChild(row.rsOpen);
        row.rsBody = null;
        row.rsOpen = null;
        if (openRow === row) openRow = null;
      }
      function expand(row, h) {
        if (openRow && openRow !== row) collapse(openRow);
        openRow = row;
        row.classList.add("is-open");
        const body = el("div", "rs-ncard-body");
        const textEl = el("div", "rs-ncard-text");
        textEl.innerHTML = cardInlineHtml(h && h.text);
        body.appendChild(textEl);
        row.appendChild(body);
        /* 进笔记的唯一入口：展开后挂在行尾（这颗钮只负责「打开」，点行是展开） */
        const go = el("button", "rs-ncard-open", t("打开"));
        go.type = "button";
        go.title = h && h.page ? t("打开这一页") : t("打开出处（滚到写过它的那一行）");
        go.onclick = (ev) => {
          if (ev && ev.stopPropagation) ev.stopPropagation();
          if (typeof o.onOpen === "function") o.onOpen(h);
          else openHit(h);
        };
        row.rsHead.appendChild(go);
        row.rsBody = body;
        row.rsOpen = go;
      }
      const rows = Array.isArray(hits) ? hits : [];
      if (!rows.length) {
        list.appendChild(el("div", "rs-ncards-empty", o.empty || t("库里还没有写过它的笔记")));
        return list;
      }
      for (const h of rows) {
        /* 双链卡的第一行是「它指向的那一页」（h.page）：与其它卡分开一档，
           「打开」进那一页；其它卡落在写过它的那一行 */
        const card = el("div", "rs-ncard" + (h.page ? " is-page" : ""));
        const head = el("div", "rs-ncard-head");
        head.appendChild(el("span", "rs-ncard-dir", h.dir));
        head.appendChild(el("span", "rs-ncard-sum", hitSummary(h.text)));
        card.appendChild(head);
        card.rsHead = head;
        card.title = h.page ? String(h.path || "") : String(h.path || "") + " · " + t("第 ") + hitLine(h) + t(" 行");
        card.onclick = (ev) => {
          /* 展开出来的全文里点 / 拖选不该把卡收回去：只有点「行」（抬头）才折叠 */
          const tgt = ev && ev.target;
          if (tgt && tgt.nodeType === 1 && card.rsBody && card.rsBody.contains(tgt)) return;
          if (card.classList.contains("is-open")) collapse(card);
          else expand(card, h);
        };
        list.appendChild(card);
      }
      return list;
    }
    function hideNoteCards() {
      if (state.cardsEsc) document.removeEventListener("keydown", state.cardsEsc, true);
      state.cardsEsc = null;
      if (state.cardsDown) document.removeEventListener("mousedown", state.cardsDown, true);
      state.cardsDown = null;
      state.cardsAnchor = null;
      state.cardsKey = "";
      if (state.cards) state.cards.classList.remove("show");
    }
    function showNoteCards(anchorEl, o) {
      const opts = o || {};
      const kind =
        opts.kind === "formula" ? "formula" : opts.kind === "cite" ? "cite" : opts.kind === "link" ? "link" : "term";
      const title = String(opts.title || "").trim();
      const citeCtx = opts.cite && kind === "cite" ? opts.cite : null;
      const key =
        kind +
        "\u0000" +
        title +
        "\u0000" +
        (opts.keys || []).join("\u0001") +
        (citeCtx ? "\u0000" + citeCtx.path + ":" + citeCtx.line : "");
      if (state.cards && state.cards.classList.contains("show") && state.cardsKey === key) {
        hideNoteCards();
        return;
      }
      hideTermTip();
      if (!state.cards) {
        state.cards = el("div", "rs-ncards");
        state.cards.addEventListener("mousedown", (ev) => ev.stopPropagation());
        document.body.appendChild(state.cards);
      }
      const box = state.cards;
      state.cardsKey = key;
      box.innerHTML = "";
      box.classList.toggle("is-formula", kind === "formula");
      box.classList.toggle("is-cite", kind === "cite");
      box.classList.toggle("is-link", kind === "link");
      /* 浮层挂在 body 上：亮色纸（.rs-light）那一档的变量得自己带上，否则方向色 / 边框还是暗色的 */
      const paneEl = typeof document !== "undefined" ? document.getElementById("researchPane") : null;
      if (paneEl && paneEl.classList.contains("rs-light")) box.classList.add("rs-light");
      else box.classList.remove("rs-light");

      const head = el("div", "rs-ncards-head");
      head.appendChild(
        el(
          "span",
          "rs-ncards-kind",
          kind === "formula"
            ? t("公式")
            : kind === "cite"
              ? t("引用")
              : kind === "link"
                ? t("链接")
                : t("术语"),
        ),
      );
      const nameEl = el("b", "rs-ncards-name", title);
      nameEl.title = title;
      head.appendChild(nameEl);
      if (kind === "formula" && opts.mathEl) {
        /* 进「公式浮层」（编辑 LaTeX / 放大 / 扩充方向都在那一块，见 openEq）：式子本身点开是看笔记 */
        const big = el("button", "rs-ncards-ico", "⤢");
        big.type = "button";
        big.title = t("打开公式浮层（编辑 LaTeX / 放大 / 补充方向）");
        big.setAttribute("aria-label", t("打开公式浮层（编辑 LaTeX / 放大 / 补充方向）"));
        big.onclick = () => {
          const host = opts.mathEl;
          hideNoteCards();
          openEq(host);
        };
        head.appendChild(big);
      }
      const close = el("button", "rs-ncards-x", "✕");
      close.type = "button";
      close.title = t("关闭");
      close.onclick = () => hideNoteCards();
      head.appendChild(close);
      box.appendChild(head);

      if (kind === "formula") {
        const eqBox = el("div", "rs-ncards-eq");
        const tex = String(opts.tex || "");
        let html = "";
        try {
          const M = math();
          html = M && typeof M.latexToHtml === "function" ? M.latexToHtml(tex, { display: true }) : "";
        } catch (_) {
          html = "";
        }
        if (html) eqBox.innerHTML = html;
        else eqBox.textContent = tex;
        box.appendChild(eqBox);
      }

      /* 引用梗：先给「这篇文章本身」—— 本地有正文就点开文章，没有就给「搜索并入库」。
         引用梗以前只列「哪些笔记写过这一处 @」，正文里的引用点下去到不了那篇文章。 */
      if (kind === "cite" && citeInfo) {
        let rows = [];
        try {
          rows = citeInfo(opts.keys || []) || [];
        } catch (_) {
          rows = [];
        }
        if (rows.length) {
          const litBox = el("div", "rs-ncards-lit");
          for (const r of rows) {
            if (!r || !r.key) continue;
            const line = el("div", "rs-ncards-lit-row");
            const ttl = el("span", "rs-ncards-lit-t", String(r.title || "@" + r.key));
            ttl.title = (r.downloaded ? t("打开这篇的正文：") : t("本地还没有这篇的全文：")) + String(r.title || "@" + r.key);
            const go = el("button", "rs-btn" + (r.downloaded ? " primary" : ""), r.downloaded ? t("打开文章") : t("获取文献"));
            go.type = "button";
            go.title = r.downloaded
              ? t("导向这篇文献的正文（literature/ 里的全文）")
              : r.found
                ? t("这篇在文献库里，但本地没有全文：让 agent 按 DOI / 网址获取这一篇")
                : t("文献库里没有这一条：让 agent 检索这一篇并入库");
            go.onclick = (ev) => {
              if (ev && ev.stopPropagation) ev.stopPropagation();
              const key = String(r.key || "");
              hideNoteCards();
              if (onOpenCite) onOpenCite(key);
            };
            /* 整行可点：与那颗按钮同一条路（一个点击一个结果，不必先瞄准按钮） */
            line.onclick = () => {
              const key = String(r.key || "");
              hideNoteCards();
              if (onOpenCite) onOpenCite(key);
            };
            line.appendChild(ttl);
            line.appendChild(go);
            litBox.appendChild(line);
          }
          box.appendChild(litBox);
        }
      }

      const hits = Array.isArray(opts.hits)
        ? opts.hits
        : noteHits(kind === "link" ? "term" : kind, opts.keys || [title], citeCtx);
      /* 卡片本体交给 noteCardList（索引页浮空卡吃的是同一份）：空话说一次，行怎么长只有一处 */
      const list = noteCardList(hits, {
        empty:
          kind === "cite"
            ? t("这一处引用还没有笔记（点下面那颗钮写一条）")
            : kind === "link"
              ? t("这一条链接还没有对应内容（点下面那颗钮补一条）")
              : t("库里还没有写过它的笔记"),
        /* 阅读区这次只负责「打开」：收起浮层再进笔记（索引页自己那一份会先收它自己的浮层） */
        onOpen: (h) => {
          hideNoteCards();
          openHit(h);
        },
      });
      box.appendChild(list);
      /* 引用梗才有：把这**一处** @ 写成一篇笔记（骨架由宿主落盘，阅读器不碰文件） */
      if (citeCtx && onNewNote) {
        const foot = el("div", "rs-ncards-foot");
        const add = el("button", "rs-btn primary", t("写一条笔记"));
        add.type = "button";
        add.title = t("按这一处引用新建一篇笔记（只绑这一处，不是这条引用的全部 @）");
        add.onclick = () => {
          const req = {
            kind: "cite",
            key: (opts.keys || [])[0] || "",
            keys: (opts.keys || []).slice(),
            path: citeCtx.path,
            line: citeCtx.line,
          };
          hideNoteCards();
          onNewNote(req);
        };
        foot.appendChild(add);
        box.appendChild(foot);
      }
      /* 双链才有：这一条链接往后要写的内容 —— 「新建一条笔记」交给宿主的候选面板
         （模型先给几个角度，勾选后派会话写成 notes/<名字>.md；会花 Token，宿主自己先确认） */
      if (kind === "link" && onMissing) {
        const foot = el("div", "rs-ncards-foot");
        const add = el("button", "rs-btn primary", t("新建一条笔记"));
        add.type = "button";
        add.title = t("让模型先给几个角度的候选，勾选后写成一篇笔记（会调用模型、消耗 Token）");
        add.onclick = () => {
          const rect = anchorEl && anchorEl.getBoundingClientRect ? anchorEl.getBoundingClientRect() : null;
          hideNoteCards();
          onMissing("term", title, rect);
        };
        foot.appendChild(add);
        box.appendChild(foot);
      }

      box.classList.add("show");
      const r = anchorEl && anchorEl.getBoundingClientRect ? anchorEl.getBoundingClientRect() : null;
      if (!r) {
        box.style.left = "24px";
        box.style.top = "80px";
        return;
      }
      const w = box.offsetWidth;
      const h = box.offsetHeight;
      const left = Math.min(Math.max(8, r.left), Math.max(8, window.innerWidth - w - 12));
      let top = r.bottom + 8;
      if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 8);
      box.style.left = left + "px";
      box.style.top = top + "px";
      /* 换一条再弹：旧的那颗 Esc 监听先摘掉，别越挂越多 */
      if (state.cardsEsc) document.removeEventListener("keydown", state.cardsEsc, true);
      state.cardsEsc = (ev) => {
        if (ev.key !== "Escape") return;
        ev.stopPropagation();
        hideNoteCards();
      };
      document.addEventListener("keydown", state.cardsEsc, true);
      /* 点外部就关：这一块是「点一下看一眼」的只读浮层，不做 persistent（带输入的
         .rs-ask 表单才 persistent；公式浮层 .rs-eqmodal 同样是看一眼的，点幕布即收）。
         被点的那个词本身除外 —— 那颗 click 还要负责「再点一次 = 关」，
         别在 mousedown 就把它收掉再被 click 弹回来。 */
      if (state.cardsDown) document.removeEventListener("mousedown", state.cardsDown, true);
      state.cardsAnchor = anchorEl || null;
      state.cardsDown = (ev) => {
        if (!state.cards || !state.cards.classList.contains("show")) return;
        const tgt = ev.target;
        if (state.cards.contains(tgt)) return;
        if (state.cardsAnchor && state.cardsAnchor.contains && state.cardsAnchor.contains(tgt)) return;
        hideNoteCards();
      };
      document.addEventListener("mousedown", state.cardsDown, true);
    }
    function openEq(hostEl) {
      const tex = hostEl.getAttribute("data-rv-tex") || "";
      if (!tex) return;
      if (!state.modal) {
        const box = el("div", "rs-eqmodal");
        box.innerHTML =
          '<div class="rs-eqmodal-box"><div class="rs-eqmodal-head"><span class="rs-eqmodal-no"></span>' +
          '<span class="rs-grow"></span><button class="rs-btn" data-a="edit"></button>' +
          '<button class="rs-btn" data-a="zoom"></button>' +
          '<button class="rs-btn" data-a="close"></button></div>' +
          '<div class="rs-eqmodal-render"></div>' +
          '<div class="rs-eqmodal-edit"><textarea class="rs-eqmodal-ta" spellcheck="false"></textarea>' +
          '<div class="rs-eqmodal-saverow"><span class="rs-eqmodal-hint"></span>' +
          '<button class="rs-btn primary" data-a="save"></button>' +
          '<button class="rs-btn" data-a="cancel"></button></div></div>' +
          '<div class="rs-eqmodal-expand"></div></div>';
        /* 出口三选一：窗内「关闭」、Esc、**点幕布（窗外面任意位置）**。
           公式浮层是「点一下看一眼」的浮层，不做 persistent —— 点外面就收；
           窗内（含 LaTeX 源码框、方向区）一律不关，滚动条与拖选也不误伤（只认 mousedown 在幕布本身）。 */
        document.addEventListener(
          "keydown",
          (ev) => {
            if (ev.key !== "Escape" || !box.classList.contains("show")) return;
            ev.stopPropagation();
            box.classList.remove("show");
          },
          true,
        );
        document.addEventListener(
          "mousedown",
          (ev) => {
            if (!box.classList.contains("show")) return;
            /* 只有落在幕布自己身上（= 窗外）才收：窗内点按 target 是盒子里的元素 */
            if (ev.target !== box) return;
            box.classList.remove("show");
          },
          true,
        );
        const close = box.querySelector('[data-a="close"]');
        close.textContent = t("关闭");
        close.onclick = () => box.classList.remove("show");
        /* 「编辑 LaTeX」：就地铺开源码框 —— 渲染式留在上面，改的时候两边能对着看 */
        const edit = box.querySelector('[data-a="edit"]');
        edit.textContent = t("编辑 LaTeX");
        edit.title = t("编辑这条式子的 LaTeX 源码");
        edit.setAttribute("aria-pressed", "false");
        edit.onclick = () => {
          const wrap = box.querySelector(".rs-eqmodal-edit");
          const ta = box.querySelector(".rs-eqmodal-ta");
          const on = wrap.classList.contains("show");
          wrap.classList.toggle("show", !on);
          edit.classList.toggle("on", !on);
          edit.setAttribute("aria-pressed", on ? "false" : "true");
          if (!on) {
            ta.value = String((state.eqHost && state.eqHost.getAttribute("data-rv-tex")) || state.eqTex || "");
            ta.focus();
          }
        };
        /* 「放大」：把中部那条渲染式放大一档（再点一次收回），不另开窗 */
        const zoom = box.querySelector('[data-a="zoom"]');
        zoom.textContent = t("放大");
        zoom.title = t("把这条式子放大看（再点一次收回）");
        zoom.setAttribute("aria-pressed", "false");
        zoom.onclick = () => {
          const renderEl = box.querySelector(".rs-eqmodal-render");
          const on = !renderEl.classList.contains("zoom");
          renderEl.classList.toggle("zoom", on);
          zoom.classList.toggle("on", on);
          zoom.setAttribute("aria-pressed", on ? "true" : "false");
        };
        /* 源码改完写回 Markdown：宿主负责替换原文里这条式子并落盘（阅读器只给 newTex）。
           宿主可能要走写入闸，所以返回值可能是 Promise：等它落地再决定关不关窗。 */
        const save = box.querySelector('[data-a="save"]');
        save.textContent = t("保存");
        save.onclick = async () => {
          const ta = box.querySelector(".rs-eqmodal-ta");
          const hint = box.querySelector(".rs-eqmodal-hint");
          const host = state.eqHost;
          const oldTex = String((host && host.getAttribute("data-rv-tex")) || state.eqTex || "");
          const next = String(ta.value || "").trim();
          if (!next) return ta.focus();
          if (!host || !onEditTex) {
            if (toast) toast(t("这里改不了原文（只读）"), "warn");
            return;
          }
          if (next === oldTex.trim()) {
            box.querySelector('[data-a="cancel"]').click();
            return;
          }
          let ok = false;
          hint.textContent = t("保存中…");
          save.disabled = true;
          try {
            ok = await onEditTex(host, oldTex, next);
          } catch (e) {
            hint.textContent = "";
            save.disabled = false;
            if (toast) toast(String((e && e.message) || e), "err");
            return;
          }
          save.disabled = false;
          /* 宿主已经 toast 过失败原因（写入闸 / 回滚），这里只把源码框留着让用户改 */
          if (ok === false) {
            hint.textContent = "";
            return;
          }
          hint.textContent = "";
          box.classList.remove("show");
          if (toast) toast(t("公式已更新"), "ok");
        };
        const cancel = box.querySelector('[data-a="cancel"]');
        cancel.textContent = t("取消");
        cancel.onclick = () => {
          box.querySelector(".rs-eqmodal-edit").classList.remove("show");
          box.querySelector('[data-a="edit"]').classList.remove("on");
          box.querySelector('[data-a="edit"]').setAttribute("aria-pressed", "false");
          box.querySelector(".rs-eqmodal-hint").textContent = "";
        };
        document.body.appendChild(box);
        state.modal = box;
      }
      const box = state.modal;
      let html = "";
      try {
        const M = math();
        html = M && typeof M.latexToHtml === "function" ? M.latexToHtml(tex, { display: true }) : "";
      } catch (_) {
        html = "";
      }
      /* 每次打开都回到「只看渲染式」那一档：源码框收起、放大关掉 */
      state.eqHost = hostEl;
      state.eqTex = tex;
      const eq = hostEl.closest(".rs-eq");
      box.querySelector(".rs-eqmodal-no").textContent = eq ? t("公式 ") + (eq.dataset.eq || "") : t("公式");
      const renderEl = box.querySelector(".rs-eqmodal-render");
      renderEl.innerHTML = html || '<pre class="rs-eqmodal-src"></pre>';
      renderEl.classList.remove("zoom");
      const zoomBtn = box.querySelector('[data-a="zoom"]');
      zoomBtn.classList.remove("on");
      zoomBtn.setAttribute("aria-pressed", "false");
      const wrap = box.querySelector(".rs-eqmodal-edit");
      wrap.classList.remove("show");
      const ta = box.querySelector(".rs-eqmodal-ta");
      ta.value = tex;
      box.querySelector(".rs-eqmodal-hint").textContent = "";
      const editBtn = box.querySelector('[data-a="edit"]');
      editBtn.classList.remove("on");
      editBtn.setAttribute("aria-pressed", "false");
      /* 源码不可用（只读投影 / 没接回写通道）时把「编辑 LaTeX」也收起来，别给一个点了没反应的钮 */
      editBtn.style.display = onEditTex ? "" : "none";
      /* 下部「扩充方向」交宿主挂（与术语浮层同一块）：点方向先确认「会消耗 Token」再调模型 */
      const mountEl = box.querySelector(".rs-eqmodal-expand");
      mountEl.innerHTML = "";
      mountEl.style.display = onEqExpand ? "" : "none";
      if (onEqExpand) {
        const label = String((eq && eq.dataset.eq) || "");
        try {
          onEqExpand(mountEl, { tex, label, name: (label ? label + " " : "") + tex, host: hostEl });
        } catch (e) {
          if (toast) toast(String((e && e.message) || e), "warn");
        }
      }
      box.classList.add("show");
    }

    /* ── 引用块的「收标记」一趟：术语卡 + callout 抬头 ──
       阅读态整份 decorate 里有这两步；图谱右栏这种只渲一块正文的地方单独要它
       （不能跑整份 decorate：那会重建大纲、进度与滚动侦听）。顺序与 decorate 一致：
       先术语卡（`[!term]` 的抬头形制与其余种类不同），再其余种类。 */
    function decorateCalloutHeads(rootEl) {
      if (!rootEl) return;
      decorateTermCards(rootEl);
      decorateCalloutTitles(rootEl);
    }

    /* ── 总入口：顺序有讲究（先术语卡去标记，再包公式容器，最后才高亮术语） ── */
    function decorate(rootEl, opts) {
      const o = opts || {};
      /* 换页 / 重排：上一页弹出的笔记浮层不能留在屏幕上（它记的是上一页的式子与笔记） */
      hideNoteCards();
      /* 选区右键菜单同理：换页后那段文字已经不在了 */
      closeCtxMenu();
      state.terms = termIndex(o.notes);
      state.notes = Array.isArray(o.notes) ? o.notes : [];
      /* 换页就把「这一篇的引用行号表」整份换掉：上一页的行号留在下一颗引用梗上就是错上下文 */
      const src = o.src || null;
      state.citeCtx = {
        path: src && src.path ? String(src.path) : "",
        entries: citeEntriesOf(src && src.md),
      };
      if (typeof o.onActive === "function") state.onActive = o.onActive;
      if (!rootEl) {
        state.root = null;
        buildOutline(null, o.outline, o.scrollRoot);
        return;
      }
      decorateTermCards(rootEl);
      decorateCalloutTitles(rootEl);
      decorateWikilinks(rootEl);
      decorateMetaLines(rootEl);
      joinSoftBreaks(rootEl);
      /* 收标记收完、软换行合完，段落已经是干净的文字流：这时才把段首引导句提成小标题，
         免得反过来被「合并换行 / 包引用梗」当成正文中间的节点去处理。 */
      promoteLeadInlines(rootEl);
      numberFormulas(rootEl);
      state.root = rootEl;
      /* 挂一次 resize 重算：窗口变宽后，上一轮为长式子缩掉的字号要还回去 */
      if (!state.fitBound && typeof window !== "undefined" && window.addEventListener) {
        state.fitBound = true;
        window.addEventListener("resize", queueFit, { passive: true });
      }
      fitFormulas(rootEl);
      /* KaTeX 的字体度量要等一次布局才准，第二帧再复核一遍（幂等：先复位再量）*/
      queueFit();
      markTerms(rootEl);
      buildOutline(rootEl, o.outline, o.scrollRoot, { onActive: o.onActive });
      bindTips(o.scrollRoot);
      bindContextMenu(o.scrollRoot);
      bindProgress(o.scrollRoot, o.progress);
      updateProgress(o.scrollRoot, o.progress);
    }

    return {
      decorate,
      outline: buildOutline,
      stopSpy,
      tip: hideTermTip,
      cards: showNoteCards,
      hideCards: hideNoteCards,
      /* 浮空卡的可复用入口（索引页「论断 / 概念 / 方法 / 问题」弹的是同一款卡，不复制第二份）：
         noteCardList(hits, { onOpen, empty, className }) → .rs-ncards-list（标题 + 一行 + 点开展开 + 行尾打开）；
         openHit(hit) = 打开某一条（页那一行进整篇，其余落在写过它的那一行）；
         summary(text) = 那一行摘要的取法（正文第一句，剥掉行内 Markdown 标记）。 */
      noteCardList,
      openHit,
      summary: hitSummary,
      noteHits,
      eq: openEq,
      fit: fitFormulas,
      termIndex,
      /* 编辑态右侧实时预览没有走 decorate，单独要这一步合软换行 */
      joinSoftBreaks,
      /* 只渲一块正文的地方（图谱右栏预览）：`[!term]` / `[!claim]` 的抬头与术语卡 */
      decorateCalloutHeads,
      /* 溯源行（`支撑：…` / `verify: doubt`）收成小字，免得预览里露成正文 */
      decorateMetaLines,
      /* 就地编辑面（contenteditable）单独要的一步：`[[…]]` 收成链接，回写由宿主按 data-wl 还原 */
      decorateWikilinks,
      /* 选区右键菜单的委托：编辑态没有 decorate，由宿主在正文容器上补挂一次 */
      bindContextMenu,
      decorateCitations,
      /* 章节表与「读到哪一节」对外只读暴露：顶栏面包屑吃这一份，不再自己解析一遍 */
      sections: () => (state.sections || []).slice(),
      active: activeInfo,
      scrollToIndex,
      state,
    };
  }

  return { create };
});
