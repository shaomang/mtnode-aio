/* ===== 研究画布（research view）· 视图 / 编辑 / 批注 / 框选询问 / 文献层 / 会话 =====
 *
 * 一句话：这是与画布并列的第 4 个顶层视图 —— 内容不是节点图，而是「以课题为核心的知识图谱」，
 * 默认形态是一间 Markdown 编辑窗 + 下方会话框，点「转为图谱」才把正文打散成关系图。
 *
 * 硬约束（与共识一致）：
 *   · 绑定当前画布（S.wf）与该画布的工作目录：研究数据落在 <工作目录>/research/；
 *   · 一切文本以 .md 为真源（frontmatter + [[wikilink]] + > [!claim] / > [!source] / > [!note]
 *     + Pandoc 式 [@citekey]），图谱只是投影，可随时重建；
 *   · 零依赖：图计算在 renderer/research-core.js（UMD，脚本也用它），不引第三方图库；
 *   · agent 可直接写入，但每次写入都进 research/changes.jsonl（可撤销）；
 *   · 文献：CSL-JSON 为真源，BibTeX 可导入；联网只走 window.api.netFetch（主进程 GET 代理，
 *     规避 CSP 的 connect-src 'self'）；
 *   · 入口仅对 ms2308 露出（显隐在 app-boot.js 的 researchSyncEntry）。
 *
 * 目录结构：
 *   research/research.json     项目元信息（课题标题 / 核心笔记 / 布局偏好）
 *   research/notes/*.md        笔记（真源）
 *   research/literature/library.json   CSL-JSON 数组
 *   research/literature/pdf/<key>.md   PDF 抽出的全文（可引用段落）
 *   research/graph.json        图谱缓存（派生，可删）
 *   research/changes.jsonl     变更记录（撤销用）
 */
(function () {
  "use strict";

  const C = () => window.MTResearchCore;
  const W = () => window.MTResearchGraph;
  const PDF_RE = /\.pdf$/i;
  /* 原件（只读）认得的文档类型：core/ 与 literature/sources/ 里的非 md 文件。
     它们只是「这一篇原文由哪个原件转来」的真源入口，不进图谱、不进版本组。 */
  const RS_ORIGINAL_RE = /\.(pdf|docx?|pptx?|xlsx?|odt|odp|ods|rtf|tex|bib|epub|mobi|azw3|html?|xhtml|txt)$/i;
  /* 研究页的默认纸色（深灰）：research.json 里没有 ui.rsBg 这个键时用它。
     与「空值 = 跟随主题」分开 —— 空值是用户显式点了「跟随主题」的结果，不能被默认值顶回去。 */
  const RS_BG_DEF = "#222222";

  const RS = {
    ready: false,
    wfId: "",
    root: "",
    meta: null,
    notes: [], // [{path, title, md, meta, parsed, core}]
    /* 原件（只读）：core/ 与 literature/sources/ 里的非 md 文件（pdf / docx / pptx / tex / html / epub…）
       [{path, name, title, ext, size, mtime}] —— 只做打开入口，永不参与编辑 / 派生 / 判色 */
    originals: [],
    folds: [], // literature/folds/*.md 的三层折叠（只读投影，不进图谱）
    foldPath: "",
    /* 节级三级粒度（一句话 / 一段话 / 原文）：全篇一根滑档 + 每节可单独钉住。
       状态的真源在折叠文件 frontmatter（secLevel / secPins），这里只是打开时读进来的缓存；
       切档 = 改这两个字段 → 写回文件（只改头部两行，正文不动）→ 重画这一篇。 */
    secLevel: "para",
    secPins: {},
    /* 文献正文（literature/sources/*.md、literature/pdf/*.md）：`[@key]` 点开后「导向的那篇文章」。
       [{path, key, title, md, kind}] —— 不是笔记：不进图谱 / 版本组，只是可打开的正文。 */
    srcDocs: [],
    srcDocPath: "",
    curPath: "",
    /* 左栏树的多选（Ctrl 追加 / Shift 连选）：只存相对路径数组，**与 curPath 分开** ——
       curPath 是「正在读哪一篇」，multiSel 是「要批量生成哪几篇」；Esc / 点空白清空。 */
    multiSel: [],
    multiAnchor: "",
    md: "",
    /* read = 渲染后的阅读态（默认，不写回 DOM）；edit = 左源码 + 右实时预览。
       为什么不再走 contentEditable 富文本往返：mermaid 代码块被渲染成 SVG 后，
       richToMarkdown 只读得到 SVG 的文字，围栏与语言标记全丢 —— Pele/流程图 一保存就烂掉
       （真机复现：插入流程图后笔记正文变成「是/问题/可分解?」这样的一堆散字）。 */
    editorMode: "read", // read | edit
    /* 索引页（corePath）的阅读态：dash = 紧凑仪表盘（默认，见 renderer/research-index.js），
       raw = 这一篇的 Markdown 阅读态。卡片是默认形态，页头那颗「原文」只切这一篇。 */
    indexMode: "dash", // dash | raw
    /* 索引页那行筛选（关键词）：跟着视图走，换笔记再回来还在 */
    indexKeyword: "",
    /* 左栏「核心」「资料」两页顶上的搜索关键词（跟视图走，切页回来还在）：
       core = 内容树（标题 / 路径 / 章节标题），refs = 文献库 + 折叠参考资料 */
    sideFilter: { core: "", refs: "" },
    mode: "notes", // notes | graph
    graph: null,
    layout: "force",
    lib: [], // CSL-JSON
    /* 会话框收纳（只留一条标题栏；状态跟 research.json 的 ui.chatCollapsed 走） */
    chatCollapsed: false,
    /* 研究页自己的视图偏好（写 research.json 的 ui.rsFs / ui.rsBg）：
       fs = 正文字号 px（12–24，菜单里给 14–20 逐 1px 与 22 / 24 两档，落到页面根的 --rs-fs 上）。 */
    fs: 16,
    /* 阅读背景色（写 research.json 的 ui.rsBg）：默认 RS_BG_DEF（#222222）；
       空 = 用户显式选了「跟随主题」，亮暗由全局主题决定；
       有值 = 一个 #rrggbb，落到页面根的内联 --bg 系列变量上，只改这一页的纸色，
       文字深浅按纸色明暗自动翻一档 —— 所以不再单设一个亮暗开关。 */
    bg: RS_BG_DEF,
    chatDraft: "",
    dirty: false,
    saving: false,
    lastSavedAt: 0,
    /* 阅读态正文就地编辑（双击正文进入，Esc / 底栏「完成」退出）：contenteditable 开在 .rs-read 上。
       编辑中**不重渲染**（一渲染光标就被打回块首），保存态只回显底栏；退出时才按阅读态重渲染。
       inlineEl = 当前那块编辑面，inlineBarEl / inlineBarStateEl = 底栏与它那行状态。 */
    inlineOn: false,
    inlineEl: null,
    inlineBarEl: null,
    inlineBarStateEl: null,
    /* 批注（局部 / 全文）：持久化在 research.json 的 annotations（键 = 笔记相对路径），
       不改 md 正文 —— 「插入为批注」那条才是往 md 里写 > [!note] 块。
       annoCollapsed: null = 跟着「这一篇有没有批注」走（没有就收成细条），true / false = 用户手动开合。
       annoSnap = 最近一次选段快照（.rs-anno-bar 的「局部批注」据此亮灭）。 */
    annoMap: {},
    annoCollapsed: null,
    annoBarEl: null,
    annoEl: null,
    annoFloatEl: null,
    annoLocalBtn: null,
    annoSnap: null,
    /* 「AI 依据批注处理」的内存态（不落盘、不建版本链）：null = 没有结果；
       { busy, baseMd, nextMd, model, provId, at } —— baseMd 起调用时的全文（diff 的旧侧），
       nextMd 是流式收口后的新稿（diff 的新侧）。采纳才会 rsSaveCurrent(nextMd) 覆盖原文件。 */
    annoAi: null,
    booted: false,
    redoStack: [], // 撤销后又想重做的改动（内存里，只活这一次会话）
    /* 投料台两栏的分栏比例（写回 research.json 的 initSplit 字段） */
    split: 0.5,
    /* 三层折叠：1 全文 / 2 关键原句 / 3 主题；>1 时只读（不改文件） */
    foldLevel: 1,
    /* 顶栏面包屑：crumbsEl = 整条（导航路径），crumbsTailEl = 章 / 节那一段 */
    crumbsEl: null,
    crumbsTailEl: null,
    /* 工具行的两颗 toggle（同步下游 / 初始化）：一次只开一颗，"" = 都收起；
       saveState = 编辑按钮上的保存态（saved / dirty / cancelled） */
    toggleOpen: "",
    saveState: "saved",
    /* 导航路径（点击递进）：[{path,label}] —— 点术语定义 / 链接会往下压一层，
       点面包屑回到某一层，左栏点树 / 新建则是「从头一条新路径」。见 rsNavPush。 */
    navTrail: [],
    editorWrap: null,
  };
  window.MTResearchState = RS;

  /* ── 小工具（自给自足，避免与画布层同名函数打架）── */
  function t(s) {
    try {
      return typeof I18n !== "undefined" && I18n.t ? I18n.t(s) : s;
    } catch (_) {
      return s;
    }
  }
  function el(tag, cls, txt) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
  }
  function qid(id) {
    return document.getElementById(id);
  }
  /* 工具条图标：16×16 空心线条（fill:none / stroke:currentColor），颜色跟按钮走 ——
     与专家团图标（app-team-icons.js）同一口径；研究页只用两颗，就地自给。 */
  const RS_ICON_PATHS = {
    /* 铅笔：编辑源码 */
    edit: "M2.8 13.2l.4-2.5 7.5-7.5 2.1 2.1-7.5 7.5-2.5.4zM10 4.2l2.1 2.1",
    /* 对勾：完成 */
    done: "M3.2 8.4l3.1 3.1 6.3-6.6",
    /* 环形箭头：刷新 */
    refresh: ["M13.3 8a5.3 5.3 0 1 1-1.7-3.9", "M13.5 2.3v3.4h-3.4"],
    /* 水滴取色：调整阅读背景色（亮暗随之由纸色的明暗决定） */
    tint: "M8 1.9c2.45 2.95 3.85 4.95 3.85 6.55a3.85 3.85 0 0 1-7.7 0C4.15 6.85 5.55 4.85 8 1.9z",
    /* 上下游双箭头：同步下游（上游改动 → 下游衍生物 / 参考内容） */
    sync: [
      "M2.6 6.1a5.4 5.4 0 0 1 9.3-2.4",
      "M12.4 2.2v3.2H9.2",
      "M13.4 9.9a5.4 5.4 0 0 1-9.3 2.4",
      "M3.6 13.8v-3.2h3.2",
    ],
    /* 清单 + 勾：初始化（投料 → 处理 → 已处理清单） */
    init: ["M3.2 3.2h9.6", "M3.2 8h5.4", "M3.2 12.8h3.6", "M9.4 11.6l1.7 1.7 2.9-3.3"],
    /* 三颗节点 + 两条连边：笔记 / 图谱互切 */
    graph: [
      "M4 3.9m-1.7 0a1.7 1.7 0 1 0 3.4 0a1.7 1.7 0 1 0-3.4 0",
      "M12 3.9m-1.7 0a1.7 1.7 0 1 0 3.4 0a1.7 1.7 0 1 0-3.4 0",
      "M8 12.3m-1.7 0a1.7 1.7 0 1 0 3.4 0a1.7 1.7 0 1 0-3.4 0",
      "M5.2 5.5l1.9 3.4",
      "M10.8 5.5l-1.9 3.4",
    ],
    /* 投影屏 + 支架：演示（PPT） */
    deck: ["M1.9 3.1h12.2v7.9H1.9z", "M8 11v2.5", "M5.5 13.5h5", "M4.2 5.4h7.6"],
  };
  function rsIcon(name) {
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("width", "16");
    svg.setAttribute("height", "16");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.4");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    const d = RS_ICON_PATHS[name] || "";
    for (const one of Array.isArray(d) ? d : [d]) {
      const p = document.createElementNS(NS, "path");
      p.setAttribute("d", one);
      svg.appendChild(p);
    }
    return svg;
  }
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
  /* 一行标签里的公式 → HTML（题名 / 面包屑 / 面板标题这类「一行字」用）：
     与阅读正文同一份 math-render（renderer/md-render.js 的 inlineHtml）；源码编辑
     （textarea / 源码档）仍走 textContent，不经过这里 —— 那里本来就该看见 LaTeX。 */
  function inlineHtml(s) {
    const R = window.MTRender;
    if (R && typeof R.inlineHtml === "function") return R.inlineHtml(s);
    return esc(s);
  }
  /* 盘面正文（候选面板的卡片、模型返回的一小段话）里的**行内 Markdown**：粗体 / 代码 / 公式
     都要排出来 —— 模型给的正文常写 `**要点**：… $\\zeta(s)$ …`，只排公式会留一屏星号。
     走 MTRender.inlineMd（浮层卡片与这里同一份），没挂 md-render.js 时退回只排公式。 */
  function inlineMdHtml(s) {
    const R = window.MTRender;
    if (R && typeof R.inlineMd === "function") return R.inlineMd(s);
    return inlineHtml(s);
  }
  function toastSafe(msg, kind) {
    try {
      if (typeof toast === "function") toast(msg, kind || "ok");
      else console.log("[research]", msg);
    } catch (_) {}
  }
  function joinP(...parts) {
    const list = parts.filter((x) => x != null && String(x) !== "");
    if (window.api && window.api.pathJoin) return window.api.pathJoin(...list);
    return list.join("/").replace(/\/+/g, "/");
  }
  function curWf() {
    /* 只看「当前可见画布」这一个真源（app.js 的 currentVisibleWf）：S 是脚本级 const，
       不在 window 上，别在这里再猜一份。 */
    try {
      return (typeof currentVisibleWf === "function" ? currentVisibleWf() : null) || null;
    } catch (_) {
      return null;
    }
  }
  function wsDir() {
    try {
      return String(typeof wfWorkspace === "function" ? wfWorkspace() : "").trim();
    } catch (_) {
      return "";
    }
  }
  async function readText(p) {
    const r = await window.api.fileReadText(p);
    return r && r.exists ? String(r.content || "") : "";
  }
  async function writeText(p, text) {
    await window.api.fileMkdir(joinP(p, ".."));
    return window.api.fileWriteText(p, text);
  }
  async function exists(p) {
    const r = await window.api.fileStat(p);
    return !!(r && r.ok);
  }

  /* ── 变更记录 + 撤销 / 重做（Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y）──
   * 每条 = 一次「文件内容替换」：{ts, kind, path, before, after}。
   * 撤销 = 把 before 写回去，并把这一行从 changes.jsonl 摘掉（同时压进内存重做栈）；
   * 重做 = 把 after 写回去，再把这行追加回日志。
   * 为什么不靠 textarea 的原生撤销：插入标题 / 加粗 / 批注 / 引用 / 流程图这些写入都是
   *   直接赋值 `ta.value = next`（字符串手术），浏览器自己的 undo 栈当场被清空 —— 用户按
   *   Ctrl+Z 就像没按过（本轮修的 bug）。所以撤销一律走应用层：文件内容的 before/after 才是真源。
   * 合并：同一篇、同一种操作、5 秒内的连续保存算一条 —— 否则 900ms 一次的自动保存会让
   *   撤销变成「一次撤一个字符」。
   * 只记文本变更（md / library.json）；PDF 二进制入库不记（删不掉就重拷，代价可控）。 */
  const CHANGES = "changes.jsonl";
  const HIST_COALESCE_MS = 5000;
  function changeLines(raw) {
    return String(raw || "")
      .split(/\r?\n/)
      .filter(Boolean);
  }
  function parseChange(line) {
    try {
      return JSON.parse(line);
    } catch (_) {
      return null;
    }
  }
  async function writeChangeLines(lines) {
    const keep = lines.slice(-500); /* 只留最近 500 条，避免 jsonl 无限长 */
    await window.api.fileWriteText(
      joinP(RS.root, CHANGES),
      keep.length ? keep.join("\n") + "\n" : "",
    );
  }
  async function logChange(kind, relPath, before, after) {
    if (!RS.root) return;
    const rec = {
      ts: Date.now(),
      kind,
      path: relPath,
      before: String(before == null ? "" : before),
      after: String(after == null ? "" : after),
    };
    const lines = changeLines(await readText(joinP(RS.root, CHANGES)));
    const last = lines.length ? parseChange(lines[lines.length - 1]) : null;
    if (
      last &&
      last.path === rec.path &&
      last.kind === rec.kind &&
      rec.ts - Number(last.ts || 0) < HIST_COALESCE_MS
    ) {
      last.after = rec.after;
      last.ts = rec.ts;
      lines[lines.length - 1] = JSON.stringify(last);
    } else {
      lines.push(JSON.stringify(rec));
    }
    /* 有新编辑就作废重做栈（与编辑器里的语义一致） */
    if (RS.redoStack) RS.redoStack.length = 0;
    await writeChangeLines(lines);
    /* 同步下游：每一次落盘（自动保存 / 就地编辑 / 新建笔记）都算一次「上游改动」。
       扫描是防抖的异步活儿，这里不等它 —— 保存不能因为下游扫得慢而卡住。 */
    rsSyncAfterSave(kind, relPath, before, after);
  }
  async function writeHistFile(rec, text) {
    const p = joinP(RS.root, rec.path);
    try {
      await window.api.fileMkdir(joinP(p, ".."));
    } catch (_) {}
    await window.api.fileWriteText(p, String(text == null ? "" : text));
  }
  /* 撤销 / 重做之后：从盘上重读，界面跟着回退（笔记 / 折叠 / 文献 / 图谱全刷一遍） */
  async function rsReloadAfterHistory() {
    const hadSrc = !!RS.srcEl;
    await rsLoadNotes();
    await rsLoadFolds();
    await rsLoadLibrary();
    const note = RS.notes.find((n) => n.path === RS.curPath);
    const fold = (RS.folds || []).find((f) => f.path === RS.curPath);
    if (note) {
      RS.md = note.md;
      RS.dirty = false;
      RS.foldPath = "";
    } else if (fold) {
      RS.md = fold.md;
      RS.dirty = false;
      RS.foldPath = fold.path;
    } else if (RS.curPath) {
      RS.curPath = "";
      RS.md = "";
      RS.foldPath = "";
    }
    /* 撤销 / 重做把盘上字节写回去了：判色缓存作废，下面重画的树 / 顶栏 / 平铺条按新字节算三态 */
    rsStatusReset();
    renderSide();
    /* renderEditor 里会重画阅读区入口条（金色提示）：盘上字节已回退，三态跟着新字节重算 */
    renderEditor();
    /* 版本判色同样只是投影：撤销重做后按新字节重算一遍（树 / 平铺条 / 阅读区顶条） */
    renderTop();
    if (qid("sideRefs")) renderLit();
    if (RS.graph) rsRebuildGraph({ keepPositions: true, silent: true });
    if (hadSrc && RS.srcEl) {
      try {
        RS.srcEl.focus();
      } catch (_) {}
    }
  }
  let histBusy = false;
  async function rsUndo() {
    if (histBusy || !RS.root) return false;
    histBusy = true;
    try {
      /* 还没落盘的输入先写掉：否则撤销完，自动保存又把这段输入盖回盘上。
         那一次也过写入闸，被拒（用户点了取消）就不动撤销栈。 */
      if ((await rsSaveCurrent()) === false) return false;
      const lines = changeLines(await readText(joinP(RS.root, CHANGES)));
      if (!lines.length) {
        toastSafe(t("没有可撤销的改动"), "warn");
        return false;
      }
      const rec = parseChange(lines.pop());
      if (!rec || !rec.path) {
        await writeChangeLines(lines);
        toastSafe(t("没有可撤销的改动"), "warn");
        return false;
      }
      /* 撤销也是一次写：同组有金色、要退回的却是别的版本 → 先问，拒绝就整笔不动
         （changes.jsonl 不摘、盘上不写，撤销栈原样留着）。 */
      if (!(await rsWriteGate(rec.path))) return false;
      if (rec.kind === t("新建笔记") && !rec.before) {
        /* 撤销「新建笔记」= 把刚建的那篇收进回收站（写回空文件只会留一篇空笔记） */
        try {
          await window.api.fileTrash(joinP(RS.root, rec.path));
        } catch (_) {
          await writeHistFile(rec, "");
        }
      } else {
        await writeHistFile(rec, rec.before);
      }
      await writeChangeLines(lines);
      RS.redoStack.push(rec);
      await rsReloadAfterHistory();
      toastSafe(t("已撤销：") + (rec.kind || ""));
      return true;
    } finally {
      histBusy = false;
    }
  }
  async function rsRedo() {
    if (histBusy || !RS.root) return false;
    histBusy = true;
    try {
      /* 撤销后又打了字：那段输入先落盘（它本身就是一次新编辑，顺带清掉重做栈） */
      if ((await rsSaveCurrent()) === false) return false;
      if (!RS.redoStack.length) {
        toastSafe(t("没有可重做的改动"), "warn");
        return false;
      }
      const rec = RS.redoStack.pop();
      /* 重做同样过闸：拒绝就把这一条放回栈上，什么都不写 */
      if (!(await rsWriteGate(rec.path))) {
        RS.redoStack.push(rec);
        return false;
      }
      await writeHistFile(rec, rec.after);
      const lines = changeLines(await readText(joinP(RS.root, CHANGES)));
      lines.push(JSON.stringify(rec));
      await writeChangeLines(lines);
      await rsReloadAfterHistory();
      toastSafe(t("已重做：") + (rec.kind || ""));
      return true;
    } finally {
      histBusy = false;
    }
  }
  /* 兼容旧入口：window.MTResearch.undo / 顶栏「撤销」都走 rsUndo */
  async function undoLast() {
    return rsUndo();
  }

  /* ── 写入闸：金色版本优先（renderer/research-versions.js 的三态）──
   * 一个版本组里只要有一份是金色（diverged：有基线、当前字节与基线不一致），改动就该集中在
   * 它身上，改完再扩散。这时再去写同组**别的**版本，先问一句「仍要改这一版吗」，默认取消。
   * 判据全部来自 research-versions.js（版本组 + stateOf）：这里不自己算哈希、不猜谁金色；
   * 一律在**动盘之前**问 —— 拒绝就整笔不落盘，不留半截文件、不留半截 changes.jsonl。
   * 覆盖：自动保存 / 批注与论断 / 插入 / 同步下游 / 撤销重做 / 新建笔记（都是写 md 的入口）。 */
  let rsVerInst = null;
  function rsVersions() {
    if (typeof window === "undefined" || !window.MTResearchVersions) return null;
    if (!rsVerInst) {
      rsVerInst = window.MTResearchVersions.create({
        root: () => RS.root,
        joinP: joinP,
        api: () => window.api,
        notes: () => RS.notes,
        t: t,
      });
    }
    return rsVerInst;
  }
  /* 基线没读进来之前一律「不判断」：宁可放行，也不能拿空 store 把所有文件判成没有金色 */
  function rsVerReady() {
    const V = rsVersions();
    return !!(V && V.state && V.state.loaded);
  }
  function rsNormRel(rel) {
    return String(rel == null ? "" : rel)
      .replace(/\\/g, "/")
      .trim();
  }
  /* 同版本组里的金色版本 → { path, title }；没有就 null。
     目标自己就是金色时不算命中：本来就该改它。（别与顶栏那颗「当前这一篇是不是金色」的
     rsGoldOf() 混了：那是无参的视图判读，这是按路径查同组。） */
  function rsGoldSibling(rel) {
    const want = rsNormRel(rel);
    if (!want || !rsVerReady()) return null;
    const V = rsVersions();
    try {
      const g = V.groupOf(want);
      if (!g) return null;
      for (const m of g.members || []) {
        if (!m || !m.path || rsNormRel(m.path) === want) continue;
        const st = V.stateOf(m.path);
        if (st && st.status === "diverged") return { path: m.path, title: m.title || m.path };
      }
    } catch (_) {}
    return null;
  }
  /* ── 四态判色的唯一出口（灰 / 绿 / 橙 / 金）──
     判据只在 research-versions.js 的 statusOfGroup 里：组 members + store + 规则表 → 每项
     { path, exists, status }（absent / clean / stale / diverged）。
     左栏树（app-research-tree.js 的 statusOf 分支）、rsGoldSelf（当前这一篇是否金色）、
     阅读区上方那条平铺条都问这一份 —— 不各自比哈希，也不各定一套颜色。 */
  function rsStatusRows(members) {
    if (!rsVerReady()) return [];
    const V = rsVersions();
    if (!V || typeof V.groupStatus !== "function") return [];
    try {
      return V.groupStatus(members || []) || [];
    } catch (_) {
      return [];
    }
  }
  /* 一轮笔记只算一遍：树逐行问、平铺条逐颗问，判据是同一份，重复的只是哈希 */
  let rsStatusCache = { notes: null, store: null, sig: "", map: null };
  /* 盘上字节一变就把这一轮判色作废（三态必须按盘上新字节重算）：
     RS.notes 整个换掉（rsLoadNotes）本来就会让缓存失效，但「就地改 RS.notes 里那份 md」
     （保存落盘 / 扩散后把内存稿同步回来 / 撤销重做写回文件）不换数组、不换 store ——
     不显式清，平铺条与左栏树就会拿上一轮的颜色继续画。 */
  function rsStatusReset() {
    rsStatusCache = { notes: null, store: null, sig: "", map: null };
  }
  function rsStatusMap() {
    if (!rsVerReady()) return null;
    const V = rsVersions();
    if (!V || typeof V.groupStatus !== "function" || typeof V.groups !== "function") return null;
    const notes = RS.notes || [];
    /* 规则表换过（改了后缀 / 加了语言 / 某页换了表）归组就变了：连它一起当缓存键。
       辨认口径 = 默认表 + 各页表出现过的规则（research-versions.js 的 knownRules），
       所以这里签的是那一份，而不是某一张页表。 */
    let sig = "";
    try {
      const known = typeof V.knownRules === "function" ? V.knownRules() : V.rules();
      sig = (known || []).map((r) => r.id + "/" + r.suffix).join(",");
    } catch (_) {
      sig = "";
    }
    const hit = rsStatusCache;
    if (hit.map && hit.notes === notes && hit.store === V.store && hit.sig === sig) return hit.map;
    let groups = [];
    try {
      groups = V.groups() || [];
    } catch (_) {
      return null;
    }
    const map = Object.create(null);
    for (const g of groups) {
      const rows = rsStatusRows((g && g.members) || []);
      for (const r of rows) if (r && r.path) map[r.path] = r.status;
    }
    rsStatusCache = { notes: notes, store: V.store, sig: sig, map: map };
    return map;
  }
  /* 单条：四态之一（橙要问整组，所以走组内那张表）；基线没读进来时给空串（不上色、不提示） */
  function rsStatusOf(rel) {
    const want = rsNormRel(rel);
    if (!want) return "";
    const map = rsStatusMap();
    if (!map) return "";
    if (map[want]) return map[want];
    /* 还没归进任何组（孤篇也自成一组，正常不会走到这里）：按单条判一次，别退回「不上色」以外的东西 */
    const rows = rsStatusRows([{ path: want }]);
    for (const r of rows) if (r && r.path === want) return r.status || "";
    return "";
  }
  /* 闸：true = 可以写，false = 用户选了「取消」。
     · 同组没有金色 → 直接放行；
     · 这一版这次会话里已经确认过「仍要改」→ 不再重复问（自动保存 900ms 一次，否则会一直弹）；
     · 同一时刻只问一只窗：重入时后来的那次按「取消」结算，不并发弹窗。 */
  const rsGateOk = new Map(); /* rel → 已确认可以继续写的那份金色路径 */
  let rsGateAsking = false;
  async function rsWriteGate(relPath) {
    const rel = rsNormRel(relPath);
    if (!rel || !RS.root) return true;
    const V = rsVersions();
    if (!V) return true;
    try {
      await V.ensureLoaded();
    } catch (_) {
      return true;
    }
    const gold = rsGoldSibling(rel);
    if (!gold) {
      rsGateOk.delete(rel);
      return true;
    }
    if (rsGateOk.get(rel) === gold.path) return true;
    if (rsGateAsking) return false;
    rsGateAsking = true;
    let ok = false;
    try {
      const msg =
        t("改动集中在 ") + gold.path + t("（这一版被改过，改完再扩散）。仍要改这一版吗？");
      ok =
        typeof confirmDialog === "function"
          ? await confirmDialog(msg, {
              title: t("被改过的版本优先"),
              okText: t("仍要改这一版"),
              cancelText: t("取消"),
              defaultCancel: true,
            })
          : true;
    } catch (_) {
      ok = false;
    } finally {
      rsGateAsking = false;
    }
    if (ok) {
      rsGateOk.set(rel, gold.path);
    } else {
      toastSafe(t("已取消：这一版没有写入（改动集中到 ") + gold.path + "）", "warn");
    }
    return !!ok;
  }

  /* ── 初始化 / 目录 ── */
  function rootOf() {
    const ws = wsDir();
    if (!ws) return "";
    return joinP(ws, "research");
  }
  async function ensureInit() {
    const wf = curWf();
    const wid = wf ? String(wf.id) : "";
    const root = rootOf();
    if (!root) {
      rsResetLoaded();
      RS.wfId = wid;
      RS.root = "";
      return { ok: false, code: "no_ws" };
    }
    /* 盘上探针：先看 research.json 还在不在，必须在下面的「已就绪」短路之前 ——
       研究目录被整个删掉时，RS 里还留着上一次的 ready / 笔记 / 图谱，短路会让视图
       变成「空的但已就绪」的空壳。文件不在就彻底清空状态，交回初始化引导。 */
    const metaPath = joinP(root, "research.json");
    if (!(await exists(metaPath))) {
      rsResetLoaded();
      RS.wfId = wid;
      RS.root = root;
      return { ok: false, code: "not_initialized" };
    }
    if (RS.ready && RS.wfId === wid && RS.root === root) return { ok: true };
    /* 换了一张画布（或同一个目录重载）：先丢掉上一张画布的笔记 / 文献 / 图谱，
       否则某些分支提前返回时，界面上会继续挂着别的画布的研究内容。 */
    rsResetLoaded();
    RS.wfId = wid;
    RS.root = root;
    /* 「先初始化才建目录」（共识）：这里**一个目录都不建**。判据是 research.json 与 notes/ 内容
       都不存在 —— 两者都没有就是还没初始化，交回向导；只要有一个存在就按已有研究装载
       （老目录只有 md、没有 research.json 的情况下面补一份元信息，不碰正文）。 */
    const metaRaw = (await readText(metaPath)).trim();
    const notesDir = await window.api.fileReadDir(joinP(root, "notes")).catch(() => null);
    const hasNotes = !!(notesDir && Array.isArray(notesDir.entries) && notesDir.entries.length);
    if (!metaRaw && !hasNotes) {
      RS.ready = false;
      RS.meta = null;
      return { ok: false, code: "not_initialized" };
    }
    let meta = null;
    try {
      meta = JSON.parse(metaRaw || "null");
    } catch (_) {
      meta = null;
    }
    if (!meta || !meta.corePath) {
      meta = {
        ver: C().VER,
        wfId: wid,
        title: wf ? String(wf.name || t("未命名课题")) : t("未命名课题"),
        corePath: "notes/00-课题.md",
        createdAt: Date.now(),
        layout: "force",
      };
      await window.api.fileMkdir(joinP(root, "notes")).catch(() => {});
      await window.api.fileWriteText(metaPath, JSON.stringify(meta, null, 2));
      await seedNotes(meta);
    }
    RS.meta = meta;
    RS.layout = meta.layout || "force";
    if (meta.initSplit != null) RS.split = Number(meta.initSplit) || 0.5;
    /* 左栏（文件 / 核心 / 资料）的显隐与当前那一格由应用左栏自己记，研究视图不再存 sideCollapsed */
    RS.chatCollapsed = !!(meta.ui && meta.ui.chatCollapsed);
    /* 研究页自己的字号 / 纸色也跟着 research.json 走：
       缺 ui.rsBg 这个键（老存档 / 新建）= 默认纸色 #222222；键在但为空 = 用户选了「跟随主题」。 */
    RS.fs = rsFsVal(meta.ui && meta.ui.rsFs);
    {
      const ui = (meta && meta.ui) || null;
      const hasBgKey = !!(ui && Object.prototype.hasOwnProperty.call(ui, "rsBg"));
      RS.bg = hasBgKey ? rsBgNormalize(ui.rsBg) : RS_BG_DEF;
    }
    /* 批注（局部 / 全文）跟着 research.json 走：annotations = { 笔记相对路径: [批注…] } */
    RS.annoMap = rsAnnoNormalize(meta.annotations);
    RS.annoCollapsed = null;
    applyViewSkin();
    await rsLoadLibrary();
    await rsLoadNotes();
    await rsLoadFolds();
    const cur = RS.notes.find((n) => n.path === meta.corePath) || RS.notes[0];
    RS.ready = true;
    if (cur) await rsOpenNote(cur.path, { silent: true });
    return { ok: true };
  }
  /* 初始骨架：只落一篇课题笔记（frontmatter + 标题 + 核心问题），不铺示例笔记。 */
  async function seedNotes(meta) {
    const root = RS.root;
    const title = meta.title || t("未命名课题");
    const q = String(meta.question || "").trim();
    let body = `---\ntitle: ${JSON.stringify(title)}\nkind: topic\ncore: true\ntags: [课题]\nverify: unverified\ndate: ${new Date().toISOString().slice(0, 10)}\n---\n\n# ${title}\n`;
    if (q) body += `\n> [!question] 核心问题\n> ${q}\n`;
    const p = joinP(root, "notes/00-课题.md");
    if (await exists(p)) return;
    await window.api.fileWriteText(p, body);
  }
  async function rsLoadNotes() {
    /* 笔记真源 = notes/（自己写的）+ core/（核心文件转出来的正文）+ terms/（术语页）。
       核心文件也是「一切陈述的主体」，要进图谱、能被 [[标题]] 指到，所以一并装载；
       terms/ 是初始化时从原文归纳出来的术语 / 公式页（见 research-core 的 termDoc）：
       它们与笔记同权 —— 能打开、能 [[名字]] 指到、能派生变体、也能被折叠，
       所以必须进同一份 RS.notes，而不是另立一套只读清单（另立就会在树上消失、在图谱里断边）。
       literature/folds/ 不进（那是折叠视图，不是笔记，原文已在核心或笔记里）。
       notes/ 下的一层子目录也扫（notes/cites/ 存的是「某一处 @ 的批注」）——
       它们是货真价实的笔记：要能打开、要能被 [[人物]] 指到，也得在重启后照样看得见。 */
    const dirs = ["notes", "core", "terms"];
    const sub = await window.api.fileReadDir(joinP(RS.root, "notes")).catch(() => null);
    for (const e of (sub && sub.entries) || []) {
      if (!e || !e.isDir || !e.name || e.hidden || e.name.startsWith(".")) continue;
      if (dirs.indexOf("notes/" + e.name) < 0) dirs.push("notes/" + e.name);
    }
    const list = [];
    for (const relDir of dirs) {
      const r = await window.api.fileReadDir(joinP(RS.root, relDir)).catch(() => null);
      const entries = (r && r.entries) || [];
      for (const e of entries) {
        if (e.isDir || !/\.md$/i.test(e.name)) continue;
        const rel = relDir + "/" + e.name;
        const md = await readText(joinP(RS.root, rel));
        const parsed = C().parseNote({ path: rel, md });
        list.push({
          path: rel,
          title: parsed.note.label || e.name.replace(/\.md$/i, ""),
          md,
          meta: parsed.meta,
          parsed,
          core: relDir === "core",
        });
      }
    }
    list.sort((a, b) => a.path.localeCompare(b.path));
    RS.notes = list;
    /* 原件（只读）：core/ 与 literature/sources/ 里**不是 md** 的文件 —— 这一篇原文是从哪个
       PDF / docx / tex / 网页存档转来的，就靠它一键打开。只扫一层：assets/ 之类的子目录是
       图元与附属物，不是原件。只读不改：不进 RS.notes（不参与图谱 / 版本组 / 衍生 / 判色）。 */
    const originals = [];
    for (const relDir of ["core", "literature/sources"]) {
      const r = await window.api.fileReadDir(joinP(RS.root, relDir)).catch(() => null);
      for (const e of (r && r.entries) || []) {
        if (!e || e.isDir || e.hidden || !RS_ORIGINAL_RE.test(e.name)) continue;
        const dot = e.name.lastIndexOf(".");
        originals.push({
          path: relDir + "/" + e.name,
          name: e.name,
          title: dot > 0 ? e.name.slice(0, dot) : e.name,
          ext: dot > 0 ? e.name.slice(dot).toLowerCase() : "",
          size: Number(e.size) || 0,
          mtime: Number(e.mtime) || 0,
        });
      }
    }
    originals.sort((a, b) => a.path.localeCompare(b.path));
    RS.originals = originals;
    /* 注意：这里**不重建**版本组实例 —— 树 / 衍生物 / 扩散 / 写入口的闸共用同一份 store
       （各自的 create() 会各自缓存一份基线，删掉实例会让扩散写进去的基线在闸这边看不到）。 */
  }

  /* ── 文献库 ── */
  async function rsLoadLibrary() {
    if (!RS.root) return;
    const p = joinP(RS.root, "literature/library.json");
    try {
      const raw = await readText(p);
      const arr = raw ? JSON.parse(raw) : [];
      RS.lib = Array.isArray(arr) ? arr : [];
    } catch (_) {
      RS.lib = [];
    }
  }
  async function rsSaveLibrary(next, kind) {
    const before = JSON.stringify(RS.lib, null, 2);
    RS.lib = next;
    const after = JSON.stringify(RS.lib, null, 2);
    if (before === after) return;
    await window.api.fileWriteText(joinP(RS.root, "literature/library.json"), after);
    await logChange(kind || t("更新文献库"), "literature/library.json", before, after);
  }
  function libFind(key) {
    return RS.lib.find((x) => (x.citeKey || x.id) === key) || null;
  }

  /* 联网检索：三项都是免 key 的公开 GET 接口；失败一律降级成可读错误，不抛到界面外 */
  async function httpJson(url) {
    const r = await window.api.netFetch(url);
    if (!r || !r.ok) throw new Error((r && r.error) || t("网络请求失败"));
    return JSON.parse(r.text);
  }
  async function httpText(url) {
    const r = await window.api.netFetch(url);
    if (!r || !r.ok) throw new Error((r && r.error) || t("网络请求失败"));
    return r.text;
  }
  function crossrefToCsl(msg) {
    if (!msg) return null;
    const issued = msg.issued || msg.published || msg.created;
    const authors = (msg.author || []).map((a) => ({ family: a.family || a.name || "", given: a.given || "" }));
    return {
      id: msg.DOI || "",
      title: Array.isArray(msg.title) ? msg.title[0] : msg.title || "",
      author: authors,
      issued: issued || undefined,
      containerTitle: Array.isArray(msg["container-title"]) ? msg["container-title"][0] : msg["container-title"] || "",
      DOI: msg.DOI || "",
      URL: msg.URL || (msg.DOI ? "https://doi.org/" + msg.DOI : ""),
      type: msg.type === "posted-content" ? "article" : msg.type || "article",
      volume: msg.volume || "",
      issue: msg.issue || "",
      page: msg.page || "",
      publisher: msg.publisher || "",
      abstract: String(msg.abstract || "").replace(/<[^>]+>/g, "").trim(),
      keyword: Array.isArray(msg.subject) ? msg.subject.join(", ") : "",
    };
  }
  async function litLookupDoi(doi) {
    const d = String(doi || "").replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").trim();
    if (!d) throw new Error(t("请输入 DOI"));
    const j = await httpJson("https://api.crossref.org/works/" + encodeURIComponent(d));
    return crossrefToCsl(j && j.message);
  }
  async function litSearchCrossref(q, rows) {
    const j = await httpJson(
      "https://api.crossref.org/works?rows=" +
        (rows || 8) +
        "&query.bibliographic=" +
        encodeURIComponent(String(q || "")),
    );
    const items = (j && j.message && j.message.items) || [];
    return items.map(crossrefToCsl).filter(Boolean);
  }
  async function litSearchArxiv(q, rows) {
    const xml = await httpText(
      "http://export.arxiv.org/api/query?search_query=all:" +
        encodeURIComponent(String(q || "")) +
        "&start=0&max_results=" +
        (rows || 8),
    );
    const doc = new DOMParser().parseFromString(xml, "text/xml");
    const out = [];
    for (const e of doc.querySelectorAll("entry")) {
      const get = (tag) => {
        const n = e.querySelector(tag);
        return n ? n.textContent.trim() : "";
      };
      const idUrl = get("id");
      const arxivId = (idUrl.split("/abs/")[1] || "").trim();
      const names = [...e.querySelectorAll("author > name")].map((n) => {
        const parts = n.textContent.trim().split(/\s+/);
        return { family: parts.pop() || "", given: parts.join(" ") };
      });
      const year = (/(\d{4})/.exec(get("published")) || [])[1];
      out.push({
        id: arxivId,
        arxiv: arxivId,
        title: get("title").replace(/\s+/g, " "),
        author: names,
        issued: year ? { "date-parts": [[Number(year)]] } : undefined,
        DOI: (/(10\.\d{4,9}\/[^\s<]+)/.exec(get("arxiv:doi")) || [])[1] || "",
        URL: idUrl,
        type: "article",
        abstract: get("summary").replace(/\s+/g, " "),
        containerTitle: "arXiv",
      });
    }
    return out;
  }
  async function litSearchS2(q, rows) {
    const j = await httpJson(
      "https://api.semanticscholar.org/graph/v1/paper/search?fields=title,authors,year,externalIds,abstract,venue&limit=" +
        (rows || 8) +
        "&query=" +
        encodeURIComponent(String(q || "")),
    );
    return ((j && j.data) || []).map((p) => ({
      id: (p.externalIds && p.externalIds.DOI) || p.paperId || "",
      title: p.title || "",
      author: (p.authors || []).map((a) => ({ family: a.name || "" })),
      issued: p.year ? { "date-parts": [[p.year]] } : undefined,
      DOI: (p.externalIds && p.externalIds.DOI) || "",
      URL: p.externalIds && p.externalIds.DOI ? "https://doi.org/" + p.externalIds.DOI : "",
      type: "article",
      abstract: p.abstract || "",
      containerTitle: p.venue || "",
    }));
  }

  /* ── 视图骨架 ── */
  function pane() {
    return qid("researchPane");
  }
  function buildShell() {
    const host = pane();
    if (!host) return;
    if (host.dataset.built === "1") return;
    host.dataset.built = "1";
    host.innerHTML = "";
    host.classList.add("rs-pane");

    const top = el("div", "rs-top");
    RS.topEl = top;
    host.appendChild(top);

    /* 同步 / 初始化那颗 toggle 的展开行已随两颗按钮一起移除（rs-toggle-row 不再建）；
       RS.toggleRowEl 保持 null，rsToggleRowPaint 首行就 return。 */
    RS.toggleRowEl = null;

    const main = el("div", "rs-main");
    RS.mainEl = main;
    /* 左栏不再挂在研究视图内部：内容树画进应用左栏的「核心」页（#sideCore），
       文献库 / 参考资料画进「资料」页（#sideRefs）—— 见 renderSide / renderLit，
       切页由 app-sidebar-files.js 的 sfSetTab 递一声 paintSide 进来。 */

    /* 返回边距：点术语定义 / [[链接]] 展开另一篇之后，阅读区左侧留一条竖边距 =
       「你从那一页来的」；悬停高亮，点一下退回那一页（见 rsBackRail）。
       没有展开（导航路径只有一层）时整条收起，不占正文宽度。 */
    RS.backRailEl = el("button", "rs-backrail");
    RS.backRailEl.type = "button";
    RS.backRailEl.hidden = true;
    RS.backRailEl.onclick = () => void rsNavBack();
    /* 标签竖向跟指针（CSS --rs-rail-y）：鼠标停在哪一段，来源页标题就浮在哪一段旁边 */
    RS.backRailEl.addEventListener("mousemove", (ev) => {
      const r = RS.backRailEl.getBoundingClientRect();
      if (!r.height) return;
      const y = Math.min(Math.max(ev.clientY - r.top, 20), r.height - 20);
      RS.backRailEl.style.setProperty("--rs-rail-y", y + "px");
    });
    RS.backRailEl.addEventListener("mouseleave", () => {
      RS.backRailEl.style.removeProperty("--rs-rail-y");
    });
    main.appendChild(RS.backRailEl);

    const center = el("div", "rs-center");
    RS.centerEl = center;
    const editorWrap = el("div", "rs-editor-wrap");
    RS.editorWrap = editorWrap;
    /* 工具条（插入 / 编辑 / 保存状态）：由 renderToolbar 按需挂到阅读区顶上 ——
       笔记与折叠文件都有，折叠文件多一排层级切换。这里只留槽位，先不插进 DOM。 */
    RS.toolbarEl = el("div", "rs-toolbar");
    /* 阅读进度：正文顶上一条 2px 细线，随正文滚动填充（打印时隐藏） */
    RS.progressEl = el("div", "rs-progress");
    RS.progressEl.appendChild(el("i"));
    editorWrap.appendChild(RS.progressEl);
    /* 阅读区上方那条「全部衍生稿」平铺条（renderReadTools 画）：原文 + 规则表每一类各一颗 chip。
       没有打开笔记、或读的是 literature/ 下的折叠投影时整条收起（:empty 规则在 research-derive.js）。 */
    RS.readToolsEl = el("div", "rs-read-tools");
    editorWrap.insertBefore(RS.readToolsEl, RS.progressEl);
    /* 文章内查找条（Ctrl+F）：阅读区最上面一条，默认收起（hidden），与正文同在一只 wrap 里 */
    rsFindBuild(editorWrap);
    const body = el("div", "rs-editor-body");
    RS.bodyEl = body;
    editorWrap.appendChild(body);
    /* 批注工具行（局部批注 / 全文批注 / 批注栏开合）：正文之上一条，只在阅读态出现 */
    RS.annoBarEl = el("div", "rs-anno-bar");
    RS.annoBarEl.hidden = true;
    editorWrap.insertBefore(RS.annoBarEl, body);
    /* 批注高亮 / 连线画在 .rs-main 的叠层上（坐标相对 .rs-main）：正文一滚坐标就变，
       所以滚一次重画一次（rAF 合帧）；窗放大缩小同理。 */
    body.addEventListener("scroll", () => rsAnnoPaintSoon(), { passive: true });
    window.addEventListener("resize", () => rsAnnoPaintSoon());
    /* 选段变化 → 「局部批注」亮灭。挂在 document 上（拖选不一定有 keyup），
       只做一件事：判断选区是否落在阅读面里并改一颗按钮的 disabled（见 rsAnnoSelSync）。 */
    if (!rsAnnoSelHooked) {
      rsAnnoSelHooked = true;
      document.addEventListener("selectionchange", () => rsAnnoSelSync());
    }
    center.appendChild(editorWrap);
    RS.chatEl = el("div", "rs-chat");
    center.appendChild(RS.chatEl);
    main.appendChild(center);

    /* 右侧章节大纲：长文阅读的导航（只在笔记阅读态出现，图谱态收起） */
    RS.outlineEl = el("aside", "rs-outline");
    RS.outlineEl.classList.add("empty");
    main.appendChild(RS.outlineEl);

    /* 右侧批注栏（局部 / 全文）：跟着「当前这一篇」重画，没有批注时收成一条细栏 */
    RS.annoEl = el("aside", "rs-anno");
    RS.annoEl.hidden = true;
    main.appendChild(RS.annoEl);

    RS.graphHost = el("div", "rs-graph");
    main.appendChild(RS.graphHost);
    host.appendChild(main);

    RS.gate = el("div", "rs-gate");
    host.appendChild(RS.gate);
  }

  /* 顶栏 = 唯一一条工具行：左面包屑（占满余量），右工具组
     （衍生物队列 → 水滴 / 刷新）。
     共识：笔记 / 图谱切换与「笔记 N」「初始化完成」「已保存」这些文字胶囊都收掉了 ——
     视图入口在左栏（「转为图谱」是 toggle，再点回笔记），保存状态并进编辑按钮。
     「同步下游」「初始化」两颗 toggle 已移除（不再占顶栏）：扫描逻辑与 sync.json 保留，
     初始化队列照旧入队，只是没有这颗入口；编辑按钮挪到平铺条右端的字号左边（rsTailTools）。
     这一行的配色走 --app-*（应用主题），不跟阅读纸色。 */
  function renderTop() {
    const top = RS.topEl;
    if (!top) return;
    /* 顶栏重画 = 旧的那排图标节点全被换掉：贴在上面那颗「演示」上的浮层必须先收掉，
       否则它挂在一个已经不在文档里的锚点上（和 renderReadTools 收字号菜单同一个道理）。 */
    rsSlidesMenuClose();
    top.innerHTML = "";

    /* 面包屑：导航路径（索引 › … › 现在这一篇）—— 工具行左侧，占满余量。
       它只做**页面导航**，不是项目路径：每级 = 你真点过的那一篇（点定义 / 链接会递进一层），
       点哪级回哪级，条首那颗 ← 后退一级；条尾是正文里的章与节，吃的是阅读器
       （research-reader.js）那一份章节表 —— 右侧大纲也用同一份，不解析两遍；
       点章 / 节由 reader 滚动到对应位置。 */
    ensureCrumbCss();
    RS.crumbsEl = el("div", "rs-crumbs");
    top.appendChild(RS.crumbsEl);

    const tools = el("div", "rs-top-tools");
    RS.toolsEl = tools;
    top.appendChild(tools);

    /* 两颗 toggle（同步下游 / 初始化）已从顶栏移除：rsToggleBtn / rsToggleData / rsTogglePaint
       留着不删（以后要恢复只加回这两行 + 下面那条 rs-toggle-row），但它们永远拿不到 ready 之外的入口。
       RS.syncToggleEl / RS.initToggleEl 一律为 null，rsTogglePaint 里的 continue 会跳过。 */
    RS.syncToggleEl = null;
    RS.initToggleEl = null;

    /* ③ 折叠文件的层级切换槽位（编辑按钮已挪到平铺条右端、字号左边，见 rsTailTools） */
    RS.toolSlotEl = el("div", "rs-tool-slot");
    tools.appendChild(RS.toolSlotEl);

    /* ④ 衍生物队列：条件出现的入口（有内容才占位）。
       金色 / 待扩散不再占顶栏：扩散入口只留树上右键「扩散到其他版本…」。 */
    RS.deriveChipEl = el("span", "rs-derive-chip-host");
    tools.appendChild(RS.deriveChipEl);

    /* ⑤ 投料台：两颗 toggle 从顶栏移除后，这里是它唯一的常驻入口 ——
       再投一批料、看处理队列、队列跑完后「补跑一层」（节级三档 / 术语页 / 3-Pass 变体）。
       没有 research/ 目录时点它 = 首次初始化（openInitWizard 自己按盘上有没有选档）。 */
    const iniBtn = el("button", "rs-top-ico rs-init-open");
    iniBtn.appendChild(rsIcon("init"));
    iniBtn.title = t("资料库：再投一批料 / 看处理队列 / 有新改动时点「补充处理」");
    iniBtn.setAttribute("aria-label", t("打开资料库"));
    iniBtn.onclick = () => openInitWizard(!!(RS.root && RS.notes && RS.notes.length));
    tools.appendChild(iniBtn);

    /* ⑥ 水滴（阅读纸色）/ ⑦ 刷新 */
    tools.appendChild(rsViewIcons());

    /* 顶栏重建会把编辑按钮一并清掉：按当前笔记状态重新挂一次，再刷两颗 toggle 与入口 */
    renderToolbar();
    rsToolPaint();
    rsTogglePaint();
    rsCrumbsPaint();
  }

  /* ── 工具行右侧：两颗 toggle 的「有没有内容」+ 条件入口 ──
     · sync = 同步下游（有命中才亮，角标 N = 待同步处数）
     · init = 初始化（队列有项才亮，角标 = 未完成项数）
     两者的展开行见 rsTogglePaint；这里只管图标态与金色 / 衍生物两个入口。 */
  function rsToggleData(kind) {
    const d = { ready: false, badge: "", title: "", summary: "", action: "", failed: 0 };
    if (kind === "sync") {
      const S = RS.root ? rsSync() : null;
      const st = S && S.state;
      /* 首次进来：把 sync.json 读上（与旧 chip 一样，读盘完成再重画一次图标态） */
      if (S && st && !st.loaded && !st.loading && typeof S.ensureLoaded === "function") {
        Promise.resolve(S.ensureLoaded())
          .then(() => rsTogglePaint())
          .catch(() => {});
      }
      const s = S ? S.stats() : null;
      d.ready = !!(s && s.total);
      d.badge = d.ready ? String(s.total) : "";
      d.failed = (s && s.failed) || 0;
      d.summary = d.ready
        ? t("受影响 ") + s.total + t(" 处 · ") + ((s.docCount || 0) + t(" 篇")) +
          (s.running ? " · " + t("同步中 ") + s.running : "") +
          (d.failed ? " · " + t("失败 ") + d.failed : "")
        : "";
      d.action = t("查看");
      d.title = d.ready
        ? t("同步下游：") + s.total + t(" 处待同步") + (d.failed ? " · " + t("失败 ") + d.failed : "")
        : t("同步下游：暂无待同步（改了上游、下游还留着旧字句时才会出现）");
    } else {
      const ini = window.MTResearchInit;
      const s = ini && RS.ready ? ini.stats() : null;
      const total = Number((s && s.total) || 0);
      const finished = Number((s && s.finished) || 0);
      const processed = Number((s && s.processed) || 0);
      /* 正在处理的那一条：投料台关着时，顶栏这一行就是「agent 此刻在干什么」的窗口 */
      let curTitle = "";
      try {
        const q = ini && typeof ini.queue === "function" ? ini.queue() : null;
        const curIt = ((q && q.items) || []).find((x) => x && x.status === "running");
        if (curIt) curTitle = String(curIt.title || curIt.id || "");
      } catch (_) {}
      d.ready = total > 0;
      d.failed = (s && s.failed) || 0;
      d.allDone = d.ready && finished >= total;
      d.badge = d.ready && !d.allDone ? String(total - finished) : "";
      d.summary = d.allDone
        ? processed + t(" 篇已处理")
        : finished + "/" + total + t(" 已处理") + (d.failed ? " · " + t("失败 ") + d.failed : "") +
          (curTitle ? " · " + t("正在处理 ") + curTitle : "");
      d.action = t("查看");
      d.title = !d.ready
        ? t("初始化：还没有入队的内容")
        : d.allDone
          ? t("初始化已完成：查看已处理内容（只读清单）")
          : t("研究初始化：逐项状态、失败重试") + (curTitle ? " · " + t("正在处理 ") + curTitle : "");
    }
    return d;
  }
  function rsToggleBtn(kind) {
    const b = el("button", "rs-top-ico rs-toggle");
    b.type = "button";
    b.dataset.kind = kind;
    b.appendChild(rsIcon(kind === "sync" ? "sync" : "init"));
    const badge = el("i", "rs-toggle-badge");
    badge.hidden = true;
    b.appendChild(badge);
    b.onclick = () => rsToggleSet(kind);
    return b;
  }
  function rsToggleSet(kind) {
    const d = rsToggleData(kind);
    /* 没有内容可展开：点击不做事（已展开的另一颗也跟着留着，别被一次误点收掉） */
    if (!d.ready) return;
    RS.toggleOpen = RS.toggleOpen === kind ? "" : kind;
    rsTogglePaint();
  }
  /* 工具行右侧的状态与条件入口：衍生物队列（research-derive.js 画）。 */
  function rsToolPaint() {
    rsDeriveChip();
  }
  function rsTogglePaint() {
    for (const kind of ["sync", "init"]) {
      const b = kind === "sync" ? RS.syncToggleEl : RS.initToggleEl;
      if (!b) continue;
      const d = rsToggleData(kind);
      const open = d.ready && RS.toggleOpen === kind;
      b.classList.toggle("on", open);
      b.setAttribute("aria-disabled", d.ready ? "false" : "true");
      b.setAttribute("aria-pressed", open ? "true" : "false");
      b.title = d.title;
      b.setAttribute("aria-label", d.title);
      const badge = b.querySelector(".rs-toggle-badge");
      if (badge) {
        badge.textContent = d.badge;
        badge.hidden = !d.badge;
      }
    }
    rsToggleRowPaint();
  }
  /* 展开行：同步 / 初始化互斥，一次只开一颗；行内 = 标题 + 一行摘要 + 查看（/ 重试） */
  function rsToggleRowPaint() {
    const row = RS.toggleRowEl;
    if (!row) return;
    row.innerHTML = "";
    const kind = RS.toggleOpen;
    const d = kind ? rsToggleData(kind) : null;
    if (!kind || !d || !d.ready) {
      RS.toggleOpen = "";
      row.hidden = true;
      delete row.dataset.kind;
      return;
    }
    row.hidden = false;
    row.dataset.kind = kind;
    const line = el("div", "rs-toggle-line");
    line.appendChild(el("span", "rs-toggle-k", kind === "sync" ? t("同步下游") : t("初始化")));
    line.appendChild(el("span", "rs-toggle-sum", d.summary));
    const act = el("button", "rs-toggle-act", d.action);
    act.title =
      kind === "sync"
        ? t("打开同步面板：勾选要改写的下游位置，逐项写盘（可 Ctrl+Z 撤销）")
        : d.allDone
          ? t("查看已处理内容（只读清单）")
          : t("打开初始化进度：逐项状态、失败重试");
    act.onclick = () => {
      if (kind === "sync") {
        const S = rsSync();
        if (S) S.openPanel(act);
        return;
      }
      const ini = window.MTResearchInit;
      if (!ini) return;
      if (d.allDone) openProcessedList();
      else ini.openProgress();
    };
    line.appendChild(act);
    /* 初始化有失败项：展开行里直接给一颗「重试」，不必先开进度窗 */
    if (kind === "init" && d.failed) {
      const retry = el("button", "rs-toggle-act", t("重试"));
      retry.title = t("重试失败的那几项初始化");
      retry.onclick = () => {
        const ini = window.MTResearchInit;
        if (ini && typeof ini.retryFailed === "function") void ini.retryFailed();
      };
      line.appendChild(retry);
    }
    row.appendChild(line);
  }

  /* ── 折叠文件（literature/folds/<key>.md）：三层视图 + 全文层编辑 ──
   * 折叠文件不是笔记（不进图谱、不算 notes/），但用户要能打开看：文献页点「折叠」就开在这里。
   * 只有第 1 层（全文）可写，且走源码编辑 —— 富文本往返会把 `**全文**` 这类层级标记改坏。 */
  async function rsLoadFolds() {
    const dir = joinP(RS.root, "literature", "folds");
    const r = await window.api.fileReadDir(dir).catch(() => null);
    const list = [];
    for (const e of (r && r.entries) || []) {
      if (e.isDir || !/\.md$/i.test(e.name)) continue;
      const rel = "literature/folds/" + e.name;
      const md = await readText(joinP(RS.root, rel));
      const model = C().parseFolds(md);
      list.push({
        path: rel,
        title: model.title || e.name.replace(/\.md$/i, ""),
        key: model.key || e.name.replace(/\.md$/i, ""),
        md,
        count: model.paragraphs.length,
      });
    }
    list.sort((a, b) => a.path.localeCompare(b.path));
    RS.folds = list;
    /* 文献正文：`[@key]` 点开后「导向的那篇文章」就是这两处的 md。
       与折叠文件同一条只读文档通道（见 rsOpenLitDoc），但**不冒充折叠**：没有层级切换、
       默认阅读态。sources 优先于 pdf（前者是整理过的正文，后者是抽取原文）。
       这里只登记路径（PDF 抽出来的全文可能很大），正文在打开那一刻才读（rsOpenLitDoc）。 */
    const docs = [];
    for (const [dirRel, kind] of [
      ["literature/sources", "source"],
      ["literature/pdf", "pdf"],
    ]) {
      const rr = await window.api.fileReadDir(joinP(RS.root, dirRel)).catch(() => null);
      for (const e of (rr && rr.entries) || []) {
        if (e.isDir || !/\.md$/i.test(e.name)) continue;
        const key = e.name.replace(/\.md$/i, "");
        docs.push({ path: dirRel + "/" + e.name, key, title: key, md: "", kind });
      }
    }
    docs.sort((a, b) => a.path.localeCompare(b.path));
    RS.srcDocs = docs;
  }
  /* 一条引用键在本地有没有正文：先精确同名（键 = 文件名），再按文献库条目的题名 / DOI
     退一步比一次（PDF 抽出来的文件名常常是题名或 DOI 的 slug）。找不到 = 还没下载全文。 */
  function rsLitDocOf(key) {
    const k = String(key || "").trim().replace(/^@+/, "");
    if (!k) return null;
    const docs = RS.srcDocs || [];
    const exact = docs.find((d) => d.key === k) || null;
    if (exact) return exact;
    const sq = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "");
    const nk = sq(k);
    if (nk.length < 4) return null;
    const hit = docs.find((d) => {
      const nd = sq(d.key);
      /* 包含匹配只对够长的键开：短键（bert / gpt）太容易命中 roberta / gpt4 这类别的文件 */
      return nd === nk || (nk.length >= 6 && nd.indexOf(nk) >= 0) || (nd.length >= 6 && nk.indexOf(nd) >= 0);
    });
    if (hit) return hit;
    const item = typeof libFind === "function" ? libFind(k) : null;
    if (!item) return null;
    const nt = sq(C().itemTitle(item));
    const ndoi = sq(item.DOI);
    return (
      docs.find((d) => {
        const nd = sq(d.key);
        return (nt.length >= 6 && (nd === nt || nd.indexOf(nt) >= 0)) || (ndoi.length >= 6 && nd.indexOf(ndoi) >= 0);
      }) || null
    );
  }
  /* 引用梗浮层顶上那条「文献」行要的数据：标题 + 有没有正文（阅读器不读盘，只认这一份） */
  function rsCiteLitInfo(keys) {
    return (keys || [])
      .map((x) => String(x || "").trim())
      .filter(Boolean)
      .map((key) => {
        const item = libFind(key);
        const doc = rsLitDocOf(key);
        return {
          key,
          title: (item && C().itemTitle(item)) || (doc && doc.title) || key,
          found: !!item,
          downloaded: !!doc,
        };
      });
  }
  /* ── 载入反馈（.rs-busy 那层淡纱 + 转圈，样式见 css/research.css）──
     文献原文是 PDF 抽出来的 md，几千行很常见：读盘 + 渲染整篇的时候阅读区是空的，
     几秒没有反馈就像点了没反应。这里只盖一层淡纱说一句「在读了」——不做进度条、不改布局、
     不吃点击。三条「不突兀」的规矩：
     ① 140ms 内载完的不出现（快的一次点击不该闪一下）；
     ② 出现后至少留 240ms（刚淡入就淡出，看着像抖了一下）；
     ③ 进出都交给 CSS 的 opacity transition（ease-in-out），JS 只切 class、不手搓动画。 */
  const RS_BUSY_DELAY = 140;
  const RS_BUSY_MIN = 240;
  let rsBusyEl = null;
  let rsBusyShowTimer = 0;
  let rsBusyHideTimer = 0;
  let rsBusyShownAt = 0;
  function rsBusyNode() {
    const wrap = RS.editorWrap;
    if (!wrap) return null;
    /* 视图重建过（换画布 / 重挂 pane）：旧那颗已经不在 DOM 里，按新 wrap 重造 */
    if (!rsBusyEl || !rsBusyEl.isConnected || rsBusyEl.parentNode !== wrap) {
      rsBusyEl = el("div", "rs-busy");
      rsBusyEl.setAttribute("role", "status");
      rsBusyEl.setAttribute("aria-live", "polite");
      const sp = el("i", "rs-busy-spin");
      sp.setAttribute("aria-hidden", "true");
      rsBusyEl.appendChild(sp);
      rsBusyEl.appendChild(el("span", "rs-busy-t"));
      wrap.appendChild(rsBusyEl);
    }
    return rsBusyEl;
  }
  function rsBusyShow(text) {
    const box = rsBusyNode();
    if (!box) return;
    const label = box.querySelector(".rs-busy-t");
    if (label) label.textContent = String(text || t("正在载入…"));
    /* 上一轮的收起还没走完：直接续上，别先淡出再淡入 */
    if (rsBusyHideTimer) {
      clearTimeout(rsBusyHideTimer);
      rsBusyHideTimer = 0;
    }
    if (box.classList.contains("on")) return;
    if (rsBusyShowTimer) clearTimeout(rsBusyShowTimer);
    rsBusyShowTimer = setTimeout(() => {
      rsBusyShowTimer = 0;
      if (!box.isConnected) return;
      box.classList.add("on");
      rsBusyShownAt = Date.now();
    }, RS_BUSY_DELAY);
  }
  function rsBusyHide() {
    /* 还没亮起来就收工 = 这次够快：直接取消，一帧都不出 */
    if (rsBusyShowTimer) {
      clearTimeout(rsBusyShowTimer);
      rsBusyShowTimer = 0;
    }
    const box = rsBusyEl;
    if (!box || !box.classList.contains("on")) return;
    const wait = Math.max(0, RS_BUSY_MIN - (Date.now() - rsBusyShownAt));
    if (rsBusyHideTimer) clearTimeout(rsBusyHideTimer);
    rsBusyHideTimer = setTimeout(() => {
      rsBusyHideTimer = 0;
      box.classList.remove("on");
    }, wait);
  }

  /* 淡纱还亮着就直接走；没亮（这次载入够快）就等过那道 140ms 闸再继续 ——
     长文的整篇渲染是**同步**的一大段，不等这一下，定时器会被同步代码一起憋住，
     用户看到的还是一段空白。只在内容够长时叫它（见 rsOpenLitDoc）。 */
  function rsBusyLetPaint() {
    const box = rsBusyEl;
    if (box && box.classList.contains("on")) return Promise.resolve();
    return new Promise((r) => setTimeout(r, RS_BUSY_DELAY + 16));
  }
  /* 第一次点 `[@key]` 时还没扫过 literature/ 目录：那一次要把 sources / pdf 两个目录 readdir 完，
     快慢看盘上有多少篇。同样盖一层淡纱（文案不同），扫完就收。 */
  async function rsBusyScan(fn) {
    rsBusyShow(t("正在读取文献目录…"));
    try {
      return await fn();
    } finally {
      rsBusyHide();
    }
  }

  /* 打开一篇文献正文（只读文档通道）：foldPath 留空 → 不出现折叠层级按钮，默认阅读态 */
  async function rsOpenLitDoc(doc) {
    if ((await rsSaveCurrent()) === false) return;
    const rec = doc || (RS.srcDocs || []).find((d) => d.path === RS.curPath);
    if (!rec) return;
    rsBusyShow(t("正在载入原文…"));
    try {
      /* 正文按需读：登记时只有路径（rsLoadFolds 不预读 PDF 全文），这里读一次并抓一级标题做名字 */
      if (!rec.md) {
        rec.md = await readText(joinP(RS.root, rec.path));
        const h = /^#[ \t]+(.+)$/m.exec(String(rec.md || ""));
        if (h) rec.title = String(h[1]).trim();
        if (!rec.md) {
          toastSafe(t("读不到这篇的正文：") + rec.path, "warn");
          return;
        }
      }
      RS.curPath = rec.path;
      RS.md = rec.md;
      RS.dirty = false;
      RS.foldPath = "";
      RS.foldLevel = 1;
      RS.srcDocPath = rec.path;
      /* 窗口里正在就地编辑的是上一篇：收回编辑面，别把指针留在已换掉的 DOM 上 */
      RS.inlineOn = false;
      RS.inlineEl = null;
      RS.editorMode = "read";
      rsNavPush(rec.path, "reset");
      renderSide();
      if (String(rec.md || "").length > 40000) await rsBusyLetPaint();
      renderEditor();
      renderTop();
      rsBackRail();
      refreshChatFocus();
    } finally {
      rsBusyHide();
    }
    toastSafe(t("打开文献正文：") + rec.path, "ok");
  }
  /* ── 获取文献 ──
     口径（本轮共识）：默认不联网检索、不下载全文（很贵）；只有用户点了「获取文献」才做。
     出口三处，走同一套：正文 `[@key]` 浮层顶上那颗「文献」行、参考文献段落里点整行、左栏文献行动作。
     本地已有全文 → 打开文章；没有 → 派一条任务给当前研究会话（检索 → 下载 → 转 md → 入库 → 回执）。
     花费提示只问一次（记进 config.json 的 research 段，研究视图全局一份）。 */
  const RS_FETCH_NOTE_SRC = "ix-init-progress"; /* 与初始化过程行同一口径：只给用户看，不进模型上下文 */
  function rsFetchConsentDone() {
    try {
      const c = typeof S !== "undefined" && S && S.config ? S.config : null;
      const o = c && c.research && typeof c.research === "object" ? c.research : {};
      return o.fetchLitConsent === true;
    } catch (_) {
      return false;
    }
  }
  async function rsFetchConsentSave() {
    try {
      if (typeof S === "undefined" || !S || !S.config) return;
      S.config.research = Object.assign(
        {},
        S.config.research && typeof S.config.research === "object" ? S.config.research : {},
        { fetchLitConsent: true },
      );
      if (window.api && typeof window.api.configSave === "function") await window.api.configSave(S.config);
    } catch (_) {}
  }
  /* 交给 agent 的那条任务书：只要这一篇，不要顺手扩库 */
  function rsFetchTaskText(spec) {
    const s = spec || {};
    const k = String(s.key || "").trim().replace(/^@+/, "");
    const title = String(s.title || k || "").trim();
    const lines = [t("【获取文献】只取这一篇，不要顺带检索或下载别的文献。"), ""];
    lines.push("- " + t("文献：") + (title || t("（无标题）")) + (k ? "（@" + k + "）" : ""));
    if (s.doi) lines.push("- DOI：" + String(s.doi).trim());
    if (s.arxiv) lines.push("- arXiv：" + String(s.arxiv).trim());
    if (s.href) lines.push("- " + t("链接：") + String(s.href).trim());
    if (k)
      lines.push(
        "- " +
          t("全文写到 {path}（或 {path2}），文献库条目的 citeKey 用 @{key}。", {
            path: "`literature/pdf/" + k + ".md`",
            path2: "`literature/sources/" + k + ".md`",
            key: k,
          }),
      );
    lines.push(
      "- " +
        t("步骤：① 按 DOI / arXiv / 题名检索并确认是同一篇（认不出就用题名加作者再试一次）；② 抓取全文并转成 Markdown（PDF 走应用内内核，抓不到全文就退摘要并说明）；③ 用 `research-lit.mjs lib <research> add` 写进 `literature/library.json`；④ 需要时补 `literature/folds/<key>.md`；⑤ 回一句回执：拿到了什么、落在哪个路径，没拿到就写清卡在哪。"),
    );
    return lines.join("\n");
  }
  /* 往当前研究会话写一行只给用户看的过程行（_src 与初始化过程行同一份过滤口径）：
     同一个 key 后续调用就地改文字 —— 「正在获取」变成「已获取」，不堆一屏。 */
  function rsChatNote(sess, text, key) {
    const st = sess;
    const body = String(text || "").trim();
    if (!st || !body) return;
    st.messages = Array.isArray(st.messages) ? st.messages : [];
    const k = String(key || "");
    let msg = null;
    if (k) {
      for (let i = st.messages.length - 1; i >= 0; i--) {
        const m = st.messages[i];
        if (m && m._src === RS_FETCH_NOTE_SRC && String(m._noteKey || "") === k) {
          msg = m;
          break;
        }
      }
    }
    if (msg) {
      msg.content = body;
      msg.at = Date.now();
    } else {
      st.messages.push({
        role: "assistant",
        content: body,
        at: Date.now(),
        _src: RS_FETCH_NOTE_SRC,
        _noteKey: k,
        _ico: "📥",
      });
    }
    st.updatedAt = Date.now();
    try {
      if (typeof agentMarkSessionDirty === "function") agentMarkSessionDirty(st.id);
    } catch (_) {}
    try {
      if (typeof agentViewIs === "function" && agentViewIs(st) && typeof renderAgentSession === "function")
        renderAgentSession();
    } catch (_) {}
    try {
      setTimeout(renderChat, 50);
    } catch (_) {}
  }
  /* 获取完成后把文献页刷成新状态（agent 落盘是异步的：先等一会儿，拿到全文就收工） */
  function rsWatchFetchedLit(key, title) {
    let tries = 0;
    const step = async () => {
      tries += 1;
      let doc = null;
      try {
        await rsLoadFolds();
        doc = key ? rsLitDocOf(key) : null;
      } catch (_) {}
      if (doc) {
        try {
          renderLit();
        } catch (_) {}
        try {
          renderSide();
        } catch (_) {}
        /* 正文里那几颗 `[@key]` 也要跟着变（「获取文献」→「打开文章」）：
           只在没有未保存改动时重画，别把正在写的一行冲掉 */
        try {
          if (!RS.dirty) renderEditor();
        } catch (_) {}
        try {
          rsChatNote(ensureBoundSession(), "✅ " + t("已获取文献：") + (title || key) + " · " + doc.path, "fetch:" + (key || title));
        } catch (_) {}
        toastSafe(t("已获取文献：") + (title || key), "ok");
        return;
      }
      if (tries < 20) setTimeout(step, 15000);
    };
    setTimeout(step, 15000);
  }
  async function rsFetchLit(spec) {
    const s = spec || {};
    if (!RS.root) return;
    const k = String(s.key || "").trim().replace(/^@+/, "");
    if (!(RS.srcDocs || []).length) await rsBusyScan(() => rsLoadFolds().catch(() => {}));
    const doc = k ? rsLitDocOf(k) : null;
    if (doc) {
      await rsOpenLitDoc(doc);
      return;
    }
    const item = k ? libFind(k) : null;
    const title = String(s.title || (item && C().itemTitle(item)) || k || "").trim();
    if (!rsFetchConsentDone()) {
      const msg =
        t("将让 agent 联网检索并下载这一篇的全文，再转成 Markdown 入库 —— 会花时间，也会消耗不少 token：") +
        "\n\n" +
        (title || k || t("（无标题）")) +
        (s.doi ? "\nDOI: " + String(s.doi).trim() : "") +
        (s.arxiv ? "\narXiv: " + String(s.arxiv).trim() : "");
      let noAsk = false;
      let ok = false;
      try {
        ok =
          typeof confirmDialog === "function"
            ? !!(await confirmDialog(msg, {
                title: t("获取文献"),
                okText: t("获取文献"),
                cancelText: t("取消"),
                checkbox: { label: t("不再提醒（我已知会联网检索并花 token）"), checked: false },
                onCheckbox: (v) => {
                  noAsk = !!v;
                },
              }))
            : !!window.confirm(msg);
      } catch (_) {
        ok = false;
      }
      if (!ok) return;
      if (noAsk) await rsFetchConsentSave();
    }
    const sess = ensureBoundSession();
    if (!sess) {
      toastSafe(t("会话不可用"), "err");
      return;
    }
    /* 进度与回执都在那条会话里：先把视图切过去，别让用户在别处等 */
    try {
      if (RS.mode !== "notes") rsSetMode("notes");
    } catch (_) {}
    RS.chatCollapsed = false;
    try {
      renderChat();
    } catch (_) {}
    try {
      if (typeof agentSessionSend === "function")
        agentSessionSend(
          rsFetchTaskText(
            Object.assign(
              { key: k, title },
              {
                doi: s.doi || (item && item.DOI) || "",
                arxiv: s.arxiv || (item && item.arxiv) || "",
                href: s.href || (item && item.URL) || "",
              },
            ),
          ),
          { sessionId: sess.id },
        );
      else {
        toastSafe(t("会话发送入口不可用"), "err");
        return;
      }
    } catch (e) {
      toastSafe(String((e && e.message) || e), "err");
      return;
    }
    rsChatNote(sess, "📥 " + t("正在获取文献：") + (title || k || t("这一篇")), "fetch:" + (k || title));
    toastSafe(t("已交给 agent 获取：") + (title || k), "ok");
    rsWatchFetchedLit(k, title);
  }
  /* `[@key]` 浮层顶上那颗「文献」行 / 左栏文献行的出口：
     本地有正文 → 打开文章；没有 → 走「获取文献」。 */
  async function rsOpenCite(key) {
    const k = String(key || "").trim().replace(/^@+/, "");
    if (!k || !RS.root) return;
    /* 还没扫过目录（刚进视图 / 上一轮装的是别的画布）：先按盘上现状扫一遍再判有没有全文 */
    if (!(RS.srcDocs || []).length) await rsBusyScan(() => rsLoadFolds().catch(() => {}));
    const doc = rsLitDocOf(k);
    if (doc) {
      await rsOpenLitDoc(doc);
      return;
    }
    const item = libFind(k);
    return rsFetchLit({
      key: k,
      title: (item && C().itemTitle(item)) || k,
      doi: (item && item.DOI) || "",
      arxiv: (item && item.arxiv) || "",
      href: (item && item.URL) || "",
    });
  }
  /* 按 DOI / arXiv 在库里找同一条（参考文献整行没有 `[@key]` 时用） */
  function rsLibFindByField(field, val) {
    const norm = (x) =>
      String(x || "")
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\/(dx\.)?doi\.org\//, "")
        .replace(/^arxiv:\s*/, "");
    const v = norm(val);
    if (!v || v.length < 4) return null;
    for (const it of RS.lib || []) {
      const w = norm(it && it[field]);
      if (w && (w === v || w.indexOf(v) >= 0 || v.indexOf(w) >= 0)) return it;
    }
    return null;
  }
  /* 参考文献段落里点整行：先认 `[@key]`，再认 DOI / arXiv 编号；本地有全文就打开，没有就获取 */
  async function rsOpenRefLine(info) {
    const o = info || {};
    if (!RS.root) return;
    const key = String(o.key || "").trim().replace(/^@+/, "");
    const doi = String(o.doi || "").trim();
    const arxiv = String(o.arxiv || "").trim();
    if (!(RS.srcDocs || []).length) await rsBusyScan(() => rsLoadFolds().catch(() => {}));
    if (key) {
      await rsOpenCite(key);
      return;
    }
    const item = (doi && rsLibFindByField("DOI", doi)) || (arxiv && rsLibFindByField("arxiv", arxiv)) || null;
    if (item) {
      await rsOpenCite(item.citeKey || item.id || "");
      return;
    }
    return rsFetchLit({ key: "", title: String(o.title || doi || arxiv || ""), doi, arxiv });
  }
  async function rsOpenFold(path) {
    /* 换文档前先落盘；那一次被闸拒了（用户点取消）就留在原处，别把没保存的输入扔掉 */
    if ((await rsSaveCurrent()) === false) return;
    const rec = (RS.folds || []).find((f) => f.path === path);
    if (!rec) return;
    RS.curPath = path;
    RS.md = rec.md;
    RS.dirty = false;
    RS.foldPath = path;
    RS.foldLevel = 1;
    RS.srcDocPath = "";
    /* 打开折叠文件先进**阅读态**（节级三档：一句话 / 一段话 / 原文），要改真源再点「编辑」。
       早先默认进源码态，等于逼人先看见一堆标记才能读 —— 与「折叠是给人读的」相反。 */
    RS.editorMode = "read";
    rsSecLoad();
    /* 折叠文件从文献页点进来 = 一次新跳转：面包屑重新起一条路径（不是从哪篇笔记递进下来的） */
    rsNavPush(path, "reset");
    renderSide();
    renderEditor();
    /* 新路径没有「上一页」：把左侧返回边距一并收掉，别留着上一篇那条 */
    rsBackRail();
  }

  /* ── 初始化已处理：从盘上的标记判读（队列 processed/status + 笔记 frontmatter init）──
     两个来源命中其一即算：队列项按 noteRel / mdRel / foldsRel 映射到笔记与文献；
     笔记自己 frontmatter 写了 init: done / initAt 也算（换会话、队列丢了都还认）。 */
  /* 无条件扫盘恢复标记：标记跟着 research/ 目录走，不跟着投料台窗口的生死 ——
     本次没开过投料台，进视图 / reload 也要把 init-queue.json 读进来；
     目录被删（research.json 不在）就把内存里的队列一起清掉，徽标与 chip 随之消失。 */
  async function syncInitQueue() {
    const ini = window.MTResearchInit;
    if (!ini) return null;
    const clear = () => {
      try {
        if (ini.state) ini.state.queue = null;
      } catch (_) {}
    };
    const root = rootOf();
    if (!root) {
      clear();
      return null;
    }
    try {
      ini.attach({
        ws: wsDir(),
        root,
        wfId: String((curWf() || {}).id || ""),
        wfName: String((curWf() || {}).name || ""),
        saveMeta: saveMetaPatch,
      });
      ini.bindChange(() => {
        if (RS.ready) renderTop();
      });
      if (!(await exists(joinP(root, "research.json")))) {
        clear();
        return null;
      }
      return await ini.refreshQueue(true);
    } catch (_) {
      clear();
      return null;
    }
  }
  function initQueueNow() {
    const ini = window.MTResearchInit;
    try {
      return ini && typeof ini.queue === "function" ? ini.queue() : null;
    } catch (_) {
      return null;
    }
  }
  function initDoneRels() {
    const rels = new Set();
    for (const it of C().processedList(initQueueNow())) {
      for (const r of [it.noteRel, it.mdRel, it.foldsRel]) {
        const k = C().normRel(r);
        if (k) rels.add(k);
      }
    }
    return rels;
  }
  function noteInitDone(n, rels) {
    if (!n) return false;
    if (C().noteProcessed(n.md)) return true;
    return !!rels && rels.has(C().normRel(n.path));
  }
  function litInitDone(it, rels) {
    if (!it || !rels) return false;
    const key = it.citeKey || C().citeKeyOf(it);
    if (!key) return false;
    const noteRel = C().normRel("notes/40-" + key + ".md");
    const note = RS.notes.find((n) => C().normRel(n.path) === noteRel);
    if (note && C().noteProcessed(note.md)) return true;
    return (
      rels.has(noteRel) ||
      rels.has(C().normRel("literature/sources/" + key + ".md")) ||
      rels.has(C().normRel("literature/folds/" + key + ".md"))
    );
  }
  function initDoneBadge() {
    const b = el("span", "rs-init-done", t("✓ 已处理"));
    b.title = t("初始化已处理：这篇内容已转成笔记与引用");
    return b;
  }
  /* 处理时间：与投料台 fmtAt 同一口径 —— 当天 HH:MM，今年 M月D日，跨年补年份 */
  function fmtProcessedAt(at) {
    const n = Number(at) || 0;
    if (!n) return "";
    const d = new Date(n);
    if (!isFinite(d.getTime())) return "";
    const pad = (v) => (v < 10 ? "0" + v : String(v));
    const hm = pad(d.getHours()) + ":" + pad(d.getMinutes());
    const now = new Date();
    if (d.getFullYear() !== now.getFullYear())
      return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " + hm;
    if (d.getMonth() === now.getMonth() && d.getDate() === now.getDate()) return hm;
    return d.getMonth() + 1 + t("月") + d.getDate() + t("日 ") + hm;
  }

  /* 顶栏「初始化完成」点开的只读清单：铺已处理项，没有任何可操作按钮（投料台不在这里复用） */
  function openProcessedList() {
    const old = document.querySelector(".rs-processed");
    if (old) old.remove();
    const list = C().processedList(initQueueNow());
    const box = el("div", "rs-ask wide rs-processed");
    box.style.right = "24px";
    box.style.top = "120px";
    const head = el("div", "rs-ask-head");
    head.appendChild(el("b", null, t("已处理内容")));
    const x = el("button", "rs-ask-x", "✕");
    x.title = t("关闭");
    head.appendChild(x);
    box.appendChild(head);
    box.appendChild(
      el(
        "div",
        "rs-processed-sub",
        t("只读清单：初始化已处理 ") + list.length + t(" 篇。正文在各笔记与文献里，这里只看结果。"),
      ),
    );
    const rows = el("div", "rs-processed-list");
    if (!list.length) rows.appendChild(el("div", "rs-lit-empty", t("还没有已处理的内容。")));
    for (const it of list) {
      const row = el("div", "rs-processed-row");
      row.appendChild(el("div", "rs-processed-name")).innerHTML = inlineHtml(
        it.title || it.key || it.id || t("（无标题）"),
      );
      const meta = [it.kind, it.mdRel || it.noteRel, fmtProcessedAt(it.processedAt)]
        .filter(Boolean)
        .join(" · ");
      row.appendChild(el("div", "rs-processed-meta", meta));
      rows.appendChild(row);
    }
    box.appendChild(rows);
    document.body.appendChild(box);
    /* 只读清单 = 「看一眼」的浮层，不做 persistent：点面板外面（点正文继续读）就收掉；
       ✕ 照旧。窗内点按（滚动清单）不算外面。 */
    let offDown = null;
    const close = () => {
      if (offDown) document.removeEventListener("mousedown", offDown, true);
      offDown = null;
      box.remove();
    };
    offDown = (ev) => {
      if (box.contains(ev.target)) return;
      close();
    };
    document.addEventListener("mousedown", offDown, true);
    x.onclick = close;
  }

  /* ── 衍生物：生成 / 批量 / 导入（实现在 renderer/research-derive.js · window.MTResearchDerive）──
     面板、串行队列、导入与全部纯函数都在那个模块里；这里只做「RS ⇄ 模块」的接线：
       · generate  = 与「框选询问」同一条文本生成通道（apiCallTextStream + 当前服务商首个文本模型）
       · reload    = 一项跑完就重读笔记、重画树与顶栏（图已建过就增量投影，保住节点位置）
       · syncDoc   = 父笔记正开着时，把「补 derives」之后的那份内存稿同步回去（有未保存输入也不丢）
     失败原因（模型不可用 / 目标已存在 / parent 不存在 / 返回空内容）由模块抛上来，这里只负责原样给人看。 */
  let rsDeriveInst = null;
  function rsDerive() {
    if (!window.MTResearchDerive) return null;
    if (!rsDeriveInst) {
      rsDeriveInst = window.MTResearchDerive.create({
        el: el,
        t: t,
        api: window.api,
        C: () => C(),
        root: () => RS.root,
        notes: () => RS.notes,
        /* 版本组：扩散的目标清单、写盘后的基线都交给同一份 store */
        versions: rsVersions(),
        /* 扩散全部成功、写完基线后只重画三处（树 / 顶栏 / 阅读区入口条）：
           颜色读的就是这份 store，不必再整目录重读一遍（笔记刚在扩散里读过） */
        repaint: () => {
          /* 扩散把正文写进了好几个目标、还刚落过基线：判色缓存先作废再画，整组才当场回绿 */
          rsStatusReset();
          renderSide();
          renderTop();
          renderReadTools();
        },
        currentMd: (p) => (RS.curPath === p ? readEditorMd() : ""),
        syncDoc: (p, md) => {
          if (RS.curPath !== p) return;
          RS.md = String(md || "");
          RS.dirty = false;
          rsStatusReset();
          if (RS.srcEl) RS.srcEl.value = RS.md;
          rsSetSaveState("saved");
        },
        generate: (prompt, opts) => rsDeriveGenerate(prompt, opts),
        logChange: (kind, rel, before, after) => logChange(kind, rel, before, after),
        openNote: (p) => rsOpenNote(p),
        toast: (msg, kind) => toastSafe(msg, kind),
        reload: () => rsDeriveReload(),
        changed: () => rsDeriveChip(),
        /* 变体生成的起止 / 进度也记进会话活动流（kind=derive）：会话视图里看得见这次运行 */
        act: (row) => rsDeriveAct(row),
      });
    }
    return rsDeriveInst;
  }
  /* 生成通道：复用「框选询问」那条（apiCallTextStream），不另开一套模型调用。
     没配好文本服务商就当场说「模型不可用」，不要让用户等一场静默超时。
     opts.abKey：这一轮请求的代号 —— 运行队列那行点 ■ 时按它精确中止（main.js 的 api:abort）。 */
  async function rsDeriveGenerate(prompt, opts) {
    if (typeof apiCallTextStream !== "function") throw new Error(t("没有可用的文本模型（设置 · 默认模型）"));
    const prov = resolveProv();
    if (!prov) throw new Error(t("没有可用的文本模型（设置 · 默认模型）"));
    const model = modelOf(prov);
    if (!model) throw new Error(t("该服务商没有可用模型"));
    const spec = {
      provider: prov,
      kind: "text",
      model: model,
      temperature: 0.2,
      prompt: String(prompt || ""),
      texts: [],
      images: [],
      refImage: "",
      abKey: String((opts && opts.abKey) || ""),
    };
    const r = await apiCallTextStream(spec, null, null);
    return String((r && r.text) || "");
  }
  /* 变体生成的留痕（kind=derive）：起 / 进度 / 收尾各记一条，进会话活动流。
     落库直接走 activityPush —— 会话右栏那个「只看浏览器」收起态收的是列表刷新，不是留痕；
     栏正好开着、且就是这条会话时同时插进眼前这份列表，不用等下一次 reload 才看见。
     绝不走 BA.onEvent：它会在收起态直接丢掉，也会把会话误标成「用过浏览器」。 */
  function rsDeriveAct(row) {
    try {
      const o = row || {};
      const text = String(o.text || "");
      if (!text) return;
      const st = boundSession();
      const payload = {
        at: Date.now(),
        kind: String(o.kind || "derive"),
        sessionId: String((st && st.id) || ""),
        title: String(o.title || t("变体")),
        text: text,
        path: String(o.path || ""),
        status: String(o.status || ""),
      };
      if (window.api && typeof window.api.activityPush === "function")
        void window.api.activityPush([payload]);
      const api = typeof window !== "undefined" ? window.MTNodeBrowser : null;
      const BA = api && api.BA;
      if (
        BA &&
        typeof BA.isOpen === "function" &&
        BA.isOpen() &&
        Array.isArray(BA.rows) &&
        (!BA.sessionId || payload.sessionId === BA.sessionId)
      ) {
        BA.rows.push(payload);
        if (BA.rows.length > 800) BA.rows.splice(0, BA.rows.length - 800);
        if (typeof BA.render === "function") BA.render();
      }
    } catch (_) {}
  }
  /* 索引页（research.json 的 corePath，缺省 notes/00-课题.md）= 这棵库的索引根：
     它不需要衍生物，衍生入口（入口条 / ＋衍生 / 右键）一律不给。 */
  function rsIsIndexPage(rel) {
    const core = String((RS.meta && RS.meta.corePath) || "notes/00-课题.md")
      .replace(/\\/g, "/")
      .replace(/^\.\//, "");
    const p = String(rel || "")
      .replace(/\\/g, "/")
      .replace(/^\.\//, "");
    return !!p && !!core && p === core;
  }
  /* ── 索引页 = 原文在前的紧凑仪表盘（renderer/research-index.js · window.MTResearchIndex）──
     只做「视图状态 ⇄ 模块」的薄适配：数据装配 / 归组 / 过滤 / 计数都在模块里（node 也能复核）。
     索引页的卡片**只由全库聚合决定**（不解析索引笔记正文的小节顺序），
     索引笔记本身一个字节都不改写 —— Markdown 仍是真源，页头那颗「原文」就回到它。 */
  let rsIndexInst = null;
  function rsIndexDash() {
    /* 依赖只有一份：建实例与每一次重画都取 rsIndexOpts()（不再在 create 里另抄一遍） */
    if (!rsIndexInst && window.MTResearchIndex) rsIndexInst = window.MTResearchIndex.create(rsIndexOpts());
    return rsIndexInst;
  }
  function rsIndexRel() {
    return String((RS.meta && RS.meta.corePath) || "notes/00-课题.md")
      .replace(/\\/g, "/")
      .replace(/^\.\//, "");
  }
  /* 原文 → 衍生物的版本组：只有 research-versions.js 一份判据（译稿 / 摘要 / 节选…）。
     索引页靠它把衍生物并进原文那张卡，不在页面上再列一遍；规则表（自定义语言）是异步读的，
     读进来之后若还停在这一页就重画一次，别让自定义后缀漏在外头。 */
  let rsIdxRulesKick = false;
  function rsIndexGroups() {
    const V = rsVersions();
    if (!V || typeof V.groups !== "function") return null;
    if (!rsIdxRulesKick) {
      rsIdxRulesKick = true;
      void V.ensureRules()
        .then(() => {
          if (rsIsIndexPage(RS.curPath) && RS.indexMode !== "raw") renderEditor();
        })
        .catch(() => {});
    }
    try {
      return V.groups();
    } catch (_) {
      return null;
    }
  }
  /* 索引页模块（renderer/research-index.js）的**唯一一份依赖包**：数据（每次重画现取）+ 全部动作回调。
     模块是 UMD 纯函数、不碰盘也不认识 RS —— 渲染、落盘、打开笔记、重画全从这里注入。
     计划里的几个名字对到实现上：
       renderMd       → 本文件的 renderMarkdown（全站唯一 Markdown 入口，模块不引第二份）
       saveNote       → rsTopicWrite（rsWriteGate + writeText + logChange + rsLoadNotes + onChanged）；
                        模块按字段分开的三个入口 onTopicSave / onQuestionAdd / onQuestionSave 底层就是它
       questionStatus → 字典快照（模块缺省也认 meta.questionStatus 自己现算，这里给一份省得再算）
       saveStatuses   → rsQStatusSave（saveMetaPatch 写 research.json 的 questionStatus + 引用回落）
       openNote       → rsOpenNote（与左栏树 / 图谱跳转同一条路径，带 line 的滚到那一块）
       onChanged      → rsIndexChanged（renderEditor：索引页 dash 态在 renderEditor 里直接走仪表盘分支，
                        不挂阅读态增强 —— 卡片态没有正文可批注、也没有章节可进大纲） */
  function rsIndexOpts() {
    const I = window.MTResearchIndex;
    return {
      el,
      t,
      notes: RS.notes || [],
      groups: rsIndexGroups(),
      indexPath: rsIndexRel(),
      /* 头卡的标题 / 核心问题：笔记里读不到才退到 research.json 的 title / question */
      meta: RS.meta || null,
      /* 状态字典：默认四档 + research.json 的 questionStatus（渲染成 chip 的标签与颜色） */
      questionStatus: I && typeof I.qStatusDict === "function" ? I.qStatusDict(RS.meta || null) : [],
      /* 概念查重的归一键：真源在 research-core.nameKey（图谱与索引同一套口径） */
      nameKey: (s) => {
        const Cc = C();
        return Cc && typeof Cc.nameKey === "function" ? Cc.nameKey(s) : String(s == null ? "" : s).trim();
      },
      mode: RS.indexMode === "raw" ? "raw" : "dash",
      keyword: RS.indexKeyword || "",
      renderMd: (md) => renderMarkdown(md),
      /* 一篇的整篇写回：写入闸 → 落盘 → 记一笔 → 重载笔记模型 → 重画（任何一次就地编辑都走这条） */
      saveNote: (rel, before, next, kind) => rsTopicWrite(rel, before, next, kind),
      /* 状态字典的改动（整份数组，带 id / label / color）→ research.json 的 questionStatus */
      saveStatuses: (list) => rsQStatusSave(list),
      openNote: (path, opts) => rsOpenNote(path, { trail: "push", line: opts && opts.line }),
      onChanged: () => rsIndexChanged(),
      onNew: () => rsNewNote(),
      toast: (msg, kind) => toastSafe(msg, kind),
      /* 头卡两处的就地编辑与「＋ 新增问题」：写的都是那一篇真源（见 rsTopicWrite） */
      onTopicSave: (p) => rsTopicSave(p),
      onQuestionAdd: (p) => rsTopicAddQuestion(p),
      /* 问题清单（现在在课题头卡内部）头行「＋ 新增问题」的就地输入：标题 + 正文一起落盘 */
      onQuestionNew: (p) => rsQuestionNew(p),
      /* 问题清单：行内改内容 / 改状态、勾选批量改状态、删除（写回各自那一块，见 rsQuestionSave） */
      onQuestionSave: (p) => rsQuestionSave(p),
      onQuestionBulk: (p) => rsQuestionBulk(p),
      onQuestionDelete: (p) => rsQuestionDelete(p),
      /* 筛选值回写到视图状态：换笔记 / 切原文再回来，还是这一份筛选 */
      onFilter: (f) => {
        RS.indexKeyword = String((f && f.keyword) || "");
      },
      /* 页头那颗「原文 / 卡片」：只切索引页这一篇的阅读形态，不去改文件 */
      onMode: (mode) => {
        RS.indexMode = mode === "raw" ? "raw" : "dash";
        renderEditor();
      },
      /* 浮空卡：与阅读区**同一份**（renderer/research-reader.js 的 cards / noteCardList）。
         索引页只学会「点这一行 → 在这一行下面弹卡（卡里就这一篇一条）」；
         卡的结构、锚点定位、点外面关 / Esc 全在阅读器那份能力里，索引页不复制第二份卡。
         阅读器没加载（老页面）就整组不给，索引模块按老路「点行 = 打开笔记」退回。 */
      noteCards: rsIndexNoteCards(),
    };
  }
  /* ── 索引页的浮空卡：把阅读器那份能力包成「hits + 锚点元素 + 选中项展开」三件事 ──
     卡本体（list）、卡的去处（open）、摘要取法（summary）一并给出去：
     索引页要自己拼一份卡时也吃同一份结构，不在第二处重写。
     缺席（window.MTResearchReader 没加载）返回 null → rsIndexOpts 不下这一项。 */
  function rsIndexNoteCards() {
    /* 只在**真要弹卡**时才建阅读器（它同时是阅读态那一份实例，不另起第二只）：
       描述能力这一步不该有副作用 */
    if (!window.MTResearchReader || typeof window.MTResearchReader.create !== "function") return null;
    return {
      /* show(anchorEl, { hits, kind, kindLabel, title, keys, openSelected })
         · hits        这一行对应的条目（索引页永远是一篇一条）
         · anchorEl    这一行：卡在它下方 8px，出界自动翻到上方（阅读器那一套定位）
         · kind        卡头种类（term / formula / cite / link），卡头色相档跟着它走
         · kindLabel   卡头那颗种类字（索引页按行给「论断 / 概念 / 方法 / 问题」）
         · openSelected=true（缺省）= 卡里那一条直接展开：点行即看全文，不必再点一次。
           再点同一行 = 收起（阅读器那一套「同一条再点一次关」），这时不补展开。 */
      show(anchorEl, o) {
        const R = rsReader();
        if (!R || typeof R.cards !== "function") return false;
        const opts = o || {};
        const hits = Array.isArray(opts.hits) ? opts.hits : [];
        R.cards(anchorEl, {
          kind: opts.kind || "term",
          title: String(opts.title || (hits[0] && hits[0].dir) || ""),
          keys: Array.isArray(opts.keys) ? opts.keys : [],
          hits,
        });
        const box = R.state && R.state.cards;
        if (!box || !box.classList.contains("show")) return true;
        if (opts.kindLabel) {
          const kindEl = box.querySelector(".rs-ncards-kind");
          if (kindEl) kindEl.textContent = String(opts.kindLabel);
        }
        if (opts.openSelected !== false) {
          const row = box.querySelector(".rs-ncards-list .rs-ncard");
          if (row && !row.classList.contains("is-open") && typeof row.click === "function") row.click();
        }
        return true;
      },
      /* 收起：索引页重画 / 换标签页 / 改筛选时先收，展开态不记忆 */
      hide() {
        if (rsReaderInst && typeof rsReaderInst.hideCards === "function") rsReaderInst.hideCards();
      },
      list: (hits, o) => {
        const R = rsReader();
        return R && typeof R.noteCardList === "function" ? R.noteCardList(hits, o) : null;
      },
      open: (hit) => {
        const R = rsReader();
        return R && typeof R.openHit === "function" ? R.openHit(hit) : false;
      },
      summary: (text) => {
        const R = rsReader();
        return R && typeof R.summary === "function" ? R.summary(text) : String(text == null ? "" : text);
      },
    };
  }
  /* 索引页重画就收起那颗浮空卡：展开态是 DOM 上的临时状态，重画即回到干净态（不记忆）。
     阅读器还没建（没打开过笔记）就无事可收 —— 别为了收一张卡去建一份阅读器。 */
  function rsIndexCardsHide() {
    if (!rsReaderInst) return;
    if (typeof rsReaderInst.hideCards === "function") rsReaderInst.hideCards();
  }
  /* 索引页里任何一次落盘之后的统一重画：dash 态由 renderEditor 走仪表盘分支（不挂阅读态增强），
     原文态照旧是 Markdown 阅读态。落盘链路自己也算一次（见 rsTopicWrite / rsQStatusSave）。 */
  function rsIndexChanged() {
    renderEditor();
  }
  /* ── 课题头卡：就地编辑标题 / 核心问题、新增问题 ──
     写的都是**那一篇真源**（索引笔记 = corePath）：
       标题     → frontmatter 的 title + 正文首个 `# 行`
       核心问题 → `> [!question] 核心问题` 的正文
       新增问题 → 末尾追加一条 `> [!question] 问题 N` 块
     字符串手术全在 research-index.js 的纯函数里（node 可复核）；这里只负责落盘：
     rsWriteGate + writeText + logChange（Ctrl+Z 撤销照旧能撤回来）+ rsLoadNotes + onChanged。
     它就是依赖包里那颗 saveNote —— 索引页里任何一次整篇写回（头卡标题 / 核心问题 / 新增问题 /
     行内改内容 / 改状态 / 批量改状态）最后都落到这一处。 */
  async function rsTopicWrite(rel, before, next, kind) {
    if (!RS.root || !rel || !next || next === before) return false;
    /* 写入闸与编辑器同一个判断：同组里有金色版本时先问一句 */
    if (!(await rsWriteGate(rel))) return false;
    await writeText(joinP(RS.root, rel), next);
    await logChange(kind, rel, before, next);
    /* 当前读的正是这一篇：内存里的正文一起换掉，切「原文」不会看到旧内容 */
    if (RS.curPath === rel) {
      RS.md = next;
      RS.dirty = false;
    }
    const rec = (RS.notes || []).find((n) => n.path === rel);
    if (rec) rec.md = next;
    await rsLoadNotes();
    rsIndexChanged();
    return true;
  }
  async function rsTopicSave(p) {
    const I = window.MTResearchIndex;
    if (!I) return false;
    const field = p && p.field === "question" ? "question" : "title";
    const value = String((p && p.value) || "").trim();
    if (!value) return false;
    const rel = rsNormRel((p && p.path) || rsIndexRel());
    const rec = (RS.notes || []).find((n) => n.path === rel) || null;
    if (!rec) return toastSafe(t("这一篇还没落盘，先在原文里写一行再改"), "warn");
    const before = String(rec.md || "");
    const next = field === "title" ? I.setTopicTitle(before, value) : I.setCoreQuestion(before, value);
    const ok = await rsTopicWrite(rel, before, next, field === "title" ? t("改课题标题") : t("改核心问题"));
    if (ok) toastSafe(field === "title" ? t("标题已写回那一篇笔记") : t("核心问题已写回那一篇笔记"), "ok");
    return ok;
  }
  async function rsTopicAddQuestion(p) {
    const I = window.MTResearchIndex;
    if (!I || typeof I.appendQuestion !== "function") return false;
    const rel = rsNormRel((p && p.path) || rsIndexRel());
    const rec = (RS.notes || []).find((n) => n.path === rel) || null;
    if (!rec) return toastSafe(t("这一篇还没落盘，先在原文里写一行再改"), "warn");
    const before = String(rec.md || "");
    const ok = await rsTopicWrite(rel, before, I.appendQuestion(before, "", ""), t("新增问题"));
    if (ok) toastSafe(t("已在那一篇笔记里追加一条问题"), "ok");
    return ok;
  }
  /* 问题清单头行「＋ 新增问题」的就地输入（标题 + 正文）：落在索引那一篇的末尾，
     与 rsTopicAddQuestion 同一条写盘链，只是标题 / 正文由用户当场填。
     （清单并进课题头卡之后，这是「新增问题」唯一那颗按钮。） */
  async function rsQuestionNew(p) {
    const I = window.MTResearchIndex;
    if (!I || typeof I.appendQuestion !== "function") return false;
    const title = String((p && p.title) || "").trim();
    if (!title) return false;
    const rel = rsNormRel((p && p.path) || rsIndexRel());
    const rec = (RS.notes || []).find((n) => n.path === rel) || null;
    if (!rec) return toastSafe(t("这一篇还没落盘，先在原文里写一行再改"), "warn");
    const before = String(rec.md || "");
    const next = I.appendQuestion(before, title, String((p && p.text) || "").trim());
    const ok = await rsTopicWrite(rel, before, next, t("新增问题"));
    if (ok) toastSafe(t("已新增一条问题"), "ok");
    return ok;
  }
  /* ── 问题清单：行内改内容 / 改状态、勾选批量改状态 ──
     每一项都锚在**它自己那一篇的 Markdown** 上（行号来自 research-core 的 parsed.nodes）：
       内容 → 那一条 `> [!question]` 块里的正文行（kind: note 的项改的是笔记标题）
       状态 → 块里写 / 换 / 删一行 `> qstatus: <id>`（kind: note 的项写 frontmatter 的 qstatus）
     只改这一个块，其它块一个字节不动；落盘仍走 rsWriteGate + writeText + logChange
     （Ctrl+Z 撤销照旧），写完 rsLoadNotes + renderEditor 让清单重算。 */
  async function rsQuestionSave(p) {
    const I = window.MTResearchIndex;
    if (!I || typeof I.applyQuestionEdits !== "function") return false;
    const rel = rsNormRel((p && p.path) || "");
    const rec = (RS.notes || []).find((n) => n.path === rel) || null;
    if (!rec) return toastSafe(t("这一篇还没落盘，先在原文里写一行再改"), "warn");
    const field = p && p.field === "status" ? "status" : "text";
    const value = String((p && p.value) == null ? "" : p.value).trim();
    if (!value && field === "text") return false;
    const before = String(rec.md || "");
    const next = I.applyQuestionEdits(before, [
      {
        kind: p && p.kind === "note" ? "note" : "callout",
        line: Number(p && p.line) || 0,
        field: field,
        value: value,
      },
    ]);
    if (next === before) return false;
    const ok = await rsTopicWrite(rel, before, next, field === "status" ? t("改问题状态") : t("改问题内容"));
    if (ok) toastSafe(field === "status" ? t("状态已写回那一篇笔记") : t("问题已写回那一篇笔记"), "ok");
    return ok;
  }
  async function rsQuestionBulk(p) {
    const I = window.MTResearchIndex;
    if (!I || typeof I.applyQuestionEdits !== "function") return false;
    const statusId = String((p && p.status) || "").toLowerCase();
    const items = Array.isArray(p && p.items) ? p.items : [];
    if (!statusId || !items.length) return false;
    /* 按篇分组：同一篇里的多项合成一次写盘（一次 logChange、一次刷新） */
    const byPath = new Map();
    for (const it of items) {
      const rel = rsNormRel(it && it.path);
      if (!rel) continue;
      if (!byPath.has(rel)) byPath.set(rel, []);
      byPath.get(rel).push({
        kind: it.kind === "note" ? "note" : "callout",
        line: Number(it.line) || 0,
        field: "status",
        value: statusId,
      });
    }
    let done = 0;
    for (const [rel, edits] of byPath) {
      const rec = (RS.notes || []).find((n) => n.path === rel) || null;
      if (!rec) continue;
      const before = String(rec.md || "");
      const next = I.applyQuestionEdits(before, edits);
      if (next === before) continue;
      /* 写入闸与编辑器同一个判断：同组里有金色版本时先问一句，拒了就整批停下 */
      if (!(await rsWriteGate(rel))) break;
      await writeText(joinP(RS.root, rel), next);
      await logChange(t("批量改问题状态"), rel, before, next);
      rec.md = next;
      if (RS.curPath === rel) {
        RS.md = next;
        RS.dirty = false;
      }
      done += edits.length;
    }
    if (!done) return false;
    await rsLoadNotes();
    renderEditor();
    const hit = I.qStatusDict(RS.meta).find((s) => s.id === statusId);
    const label = hit ? t(hit.label) : statusId;
    toastSafe(t("已把 ") + done + t(" 项改成「") + label + t("」"), "ok");
    return true;
  }
  /* ── 问题清单：删掉一条 ──
       `> [!question]` 块 → 只移除那一块（research-index.js 的 removeQuestion，别的块一个字节不动）；
       kind: note 的项 → 整篇笔记就是这条问题，走回收站（与左栏树的删除同一口径，先问一句）。 */
  async function rsQuestionDelete(p) {
    const I = window.MTResearchIndex;
    if (!I) return false;
    const rel = rsNormRel((p && p.path) || "");
    const rec = (RS.notes || []).find((n) => n.path === rel) || null;
    if (!rel || !rec) return toastSafe(t("这一篇还没落盘，刷新后再试"), "warn");
    const before = String(rec.md || "");
    if ((p && p.kind) === "note") {
      const msg = t("把整篇笔记移到回收站：") + rel + t("？（这一篇就是清单里的那条问题）");
      let ok = true;
      if (typeof confirmDialog === "function") {
        ok = await confirmDialog(msg, {
          title: t("删除问题"),
          okText: t("移到回收站"),
          cancelText: t("取消"),
          defaultCancel: true,
        });
      }
      if (!ok) return false;
      try {
        await window.api.fileTrash(joinP(RS.root, rel));
      } catch (e) {
        return toastSafe(t("删除失败：") + String((e && e.message) || e), "err");
      }
      await logChange(t("删除问题"), rel, before, "");
      if (RS.curPath === rel) {
        RS.curPath = "";
        RS.md = "";
        RS.foldPath = "";
      }
      await rsLoadNotes();
      renderEditor();
      toastSafe(t("已移到回收站：") + rel, "ok");
      return true;
    }
    const next = I.removeQuestion(before, Number(p && p.line) || 0);
    if (next === before) return toastSafe(t("这一条问题已经不在了（文档变过，重画后再试）"), "warn");
    const ok = await rsTopicWrite(rel, before, next, t("删除问题"));
    if (ok) toastSafe(t("问题已从那一篇笔记里删除"), "ok");
    return ok;
  }
  /* ── 状态字典：默认四档 + 自定义名称 / 颜色（存 research.json 的 questionStatus）──
     依赖包里那颗 saveStatuses 就是这里：字典本身走 saveMetaPatch（Object.assign 合并，
     meta 里别的键原样留着）；
     删掉 / 改名后**不留悬空 id**：全库扫一遍引用，字典里已经没有的状态一律回落成 默认
     （只改 `> qstatus:` 那一行 / frontmatter 的 qstatus:，别的块一个字节不动）。
     归一化是 research-index.js 的纯函数（node 可复核），这里只负责逐篇写盘 + 刷新模型。 */
  async function rsQStatusSave(list) {
    const I = window.MTResearchIndex;
    if (!I || typeof I.qStatusDict !== "function") return false;
    if (!RS.root) return toastSafe(t("还没有打开研究库"), "warn");
    const before = I.qStatusDict(RS.meta || null);
    const next = I.qStatusDict({ questionStatus: Array.isArray(list) ? list : [] });
    const patch = I.qStatusPatch(next);
    const ok = await saveMetaPatch({ questionStatus: patch });
    if (!ok) return toastSafe(t("状态字典没能写进 research.json"), "err");
    const afterIds = new Set(patch.map((s) => s.id));
    const gone = before.map((s) => s.id).filter((id) => !afterIds.has(id));
    let fixed = 0;
    if (gone.length) {
      for (const rec of RS.notes || []) {
        const rel = rec && rec.path;
        const md = String((rec && rec.md) || "");
        if (!rel || !md) continue;
        const nx = I.normalizeQStatusRefs(md, next);
        if (nx === md) continue;
        /* 与编辑器同一个写入闸：同组里有金色版本时先问一句，拒了就停在当前这一篇 */
        if (!(await rsWriteGate(rel))) break;
        await writeText(joinP(RS.root, rel), nx);
        await logChange(t("状态已删除 · 回落默认"), rel, md, nx);
        rec.md = nx;
        if (RS.curPath === rel) {
          RS.md = nx;
          RS.dirty = false;
        }
        fixed++;
      }
    }
    await rsLoadNotes();
    rsIndexChanged();
    toastSafe(
      fixed
        ? t("状态字典已保存；") + fixed + t(" 篇里引用旧状态的问题回落到 默认")
        : t("状态字典已保存"),
      "ok",
    );
    return true;
  }
  /* 仪表盘没有章节：阅读进度那条细线回到 0，别留着上一篇的百分比 */
  function rsResetProgress() {
    try {
      const bar = RS.progressEl && RS.progressEl.firstElementChild;
      if (bar) bar.style.width = "0%";
    } catch (_) {}
  }
  /* 衍生物挂在「当前读的这一篇」下面：折叠文件（literature/folds/*）是投影不是笔记，索引页也不需要衍生，
     两者都不给衍生入口。 */
  function rsDeriveTarget() {
    const p = String(RS.curPath || "");
    if (!p || p.indexOf("literature/") === 0) return "";
    if (rsIsIndexPage(p)) return "";
    return p;
  }
  function rsDeriveOpen(opts) {
    const D = rsDerive();
    if (!D) return toastSafe(t("衍生物模块没加载（renderer/research-derive.js）"), "err");
    const o = Object.assign({}, opts || {});
    if (!o.path) o.path = rsDeriveTarget();
    if (rsIsIndexPage(o.path)) return toastSafe(t("索引页不需要衍生稿（它是这棵库的索引根）"), "warn");
    return D.openPanel(o);
  }
  function rsDeriveImport(opts) {
    const D = rsDerive();
    if (!D) return toastSafe(t("衍生物模块没加载（renderer/research-derive.js）"), "err");
    const o = Object.assign({}, opts || {});
    if (!o.path) o.path = rsDeriveTarget();
    if (rsIsIndexPage(o.path)) return toastSafe(t("索引页不需要衍生稿（它是这棵库的索引根）"), "warn");
    return D.openImport(o);
  }
  /* ── 左栏树的多选 → 「生成所选变体」 ──
     选中集合只有一个真源：RS.multiSel（相对路径数组，与 curPath 分开）。树负责读写它，
     这里只做两件事：给阅读区入口条取一份快照、把选中集合交给衍生物模块按版本组展开。 */
  function rsMultiList() {
    if (!Array.isArray(RS.multiSel)) RS.multiSel = [];
    return RS.multiSel.slice();
  }
  /* 树改完选中集合后回调：只重画阅读区顶条（树自己会 paint，别在这里再画一遍） */
  function rsMultiChanged() {
    renderReadTools();
  }
  function rsDeriveMany(paths) {
    const D = rsDerive();
    if (!D) return toastSafe(t("衍生物模块没加载（renderer/research-derive.js）"), "err");
    if (typeof D.openMany !== "function") return toastSafe(t("衍生物模块版本过旧（缺 openMany）"), "err");
    const list = (Array.isArray(paths) && paths.length ? paths : rsMultiList()).filter(Boolean);
    if (!list.length) return toastSafe(t("先在左栏选几篇（Ctrl / Shift 多选）"), "warn");
    const p = D.openMany({ paths: list });
    if (p && typeof p.catch === "function") {
      p.catch((err) => toastSafe(String((err && err.message) || err), "err"));
    }
    return p;
  }
  /* ── 金色版本 → 扩散到其他版本 ──
     顶栏不再摆「金色 · 待扩散」chip / 「扩散到其他版本…」按钮 / 「N 个版本待扩散」汇总 chip：
     扩散入口只留树上右键「扩散到其他版本…」（app-research-tree.js），面板与串行写盘仍在
     research-derive.js 的 openSpread 里。判色照旧只认 research-versions.js（与树同一份）。 */
  /* 当前这一篇自己是不是金色：判据只认 research-versions.js 的 stateOf（与树、阅读区提示同一份） */
  function rsGoldSelf() {
    const p = String(RS.curPath || "");
    if (!p || p.indexOf("literature/") === 0) return "";
    return rsStatusOf(p) === "diverged" ? p : "";
  }
  /* 基线是异步读进来的：第一次画顶栏时 store 可能还没到，读完补画一次（只补一次） */
  let rsVerPaintPending = false;
  function rsVersionsKick() {
    const V = rsVersions();
    if (!V || rsVerPaintPending || rsVerReady()) return;
    rsVerPaintPending = true;
    Promise.resolve(V.ensureLoaded())
      .catch(() => null)
      .then(() => {
        rsVerPaintPending = false;
        if (!RS.topEl) return;
        renderTop();
      });
  }
  function rsDeriveSpread(path) {
    const D = rsDerive();
    if (!D) return toastSafe(t("衍生物模块没加载（renderer/research-derive.js）"), "err");
    if (typeof D.openSpread !== "function") return toastSafe(t("衍生物模块版本过旧（缺 openSpread）"), "err");
    const p = String(path || rsDeriveTarget() || "");
    if (!p) return toastSafe(t("先打开一篇笔记"), "warn");
    const r = D.openSpread({ path: p });
    if (r && typeof r.catch === "function") {
      r.catch((err) => toastSafe(String((err && err.message) || err), "err"));
    }
    return r;
  }
  /* 顶栏 chip：批量队列的进度（内容由模块画，这里只交槽位） */
  function rsDeriveChip() {
    const D = rsDerive();
    if (!D) return;
    D.paintChip(RS.deriveChipEl || null);
  }

  /* ── 变体一致化：按「改动量最大的那一版」重新生成同组其它版本 ──
     与「扩散」不是一件事：扩散 = 把金色版正文直接拷给别的版本（零 Token）；
     这里 = 让模型按新原文重译 / 重摘 / 重节选（花 Token）。所以先确认、并写明代价。
     basePath 由 rsSyncPickBase 选（多版都被改过时取改动量最大的那一版）；targets 来自平铺条
     那次的版本组成员（{path,title,kind,lang}），只含已生成的非原文版本 ——
     **含其它也被改过的版本**（它们会被基准版覆盖，冲突就在这一步解掉）。 */
  async function rsSyncVariants(basePath, targets) {
    const D = rsDerive();
    if (!D || typeof D.syncVariants !== "function") {
      return toastSafe(t("衍生物模块没加载（renderer/research-derive.js）"), "err");
    }
    const list = (targets || []).filter((m) => m && m.path);
    if (!list.length) return;
    const names = list.slice(0, 5).map((m) => m.title || m.path);
    const msg =
      t("将按「") +
      rsNavLabel(basePath) +
      t("」（改动量最大的那一版）重新生成 ") +
      list.length +
      t(" 个版本：") +
      names.join("、") +
      (list.length > names.length ? t(" 等 ") + list.length + t(" 个") : "") +
      "。\n\n" +
      t("这一步会调用模型、消耗 Token，且逐条串行跑；同组其它也被改过的版本会一起按它重写。建议在阶段性修改完成后再同步，别每改一句就同步一次。继续吗？");
    let ok = true;
    if (typeof confirmDialog === "function") {
      ok = await confirmDialog(msg, {
        title: t("变体一致化"),
        okText: t("开始同步"),
        cancelText: t("取消"),
        defaultCancel: true,
      });
    }
    if (!ok) return;
    toastSafe(t("开始同步 ") + list.length + t(" 个版本…"));
    try {
      const r = await D.syncVariants({
        parentPath: basePath,
        items: list.map((m) => ({ path: m.path, kind: m.kind, lang: m.lang })),
      });
      const done = (r && r.ok) || [];
      const failed = (r && r.failed) || [];
      if (done.length) toastSafe(t("已同步 ") + done.length + t(" 个版本"), "ok");
      for (const f of failed) toastSafe(f.path + t(" 同步失败：") + f.why, "err");
      if (!done.length && !failed.length) toastSafe(t("没有需要同步的版本"), "warn");
    } catch (e) {
      toastSafe(String((e && e.message) || e), "err");
    }
    renderReadTools();
  }
  /* 一项跑完：重读笔记（三态按新字节重算）→ 重画树 / 顶栏 / 阅读区顶条；
     图已建过就增量投影 */
  async function rsDeriveReload() {
    await rsLoadNotes();
    await rsLoadFolds();
    /* 刚落盘的那一份就在这批新字节里：判色缓存作废，平铺条与树按新字节重算三态 */
    rsStatusReset();
    renderSide();
    renderTop();
    renderReadTools();
    if (RS.graph) rsRebuildGraph({ keepPositions: true, silent: true });
  }
  /* 阅读区上方那条「全部衍生稿」平铺条：把当前笔记的版本组（原文 + 规则表里每一类）逐颗摆出来。
     · 已生成的（组里这份还在）→ 点一下打开那一篇（rsOpenNote）
     · 未生成的 → 点一下就地生成这一份（runSingle：模板 / 目标路径 / 落盘都在 research-derive.js）
     五态与树、顶栏同一套判据（research-versions.js 的 statusOfGroup，整组一起判）：
       灰（虚线）= 未生成，绿 = 已生成且与基线一致，橙 = 同组有人改过、这份未同步，
       金 = 就是被改过的那一版（点它照旧打开，改动集中在那一份上），
       青 = 已经生成但盘上还没有基线（旧稿 / 外部放进来的稿，不与「未生成」混色）。
     正在生成的那一颗（以及顶栏队列 chip、同步更新按钮）走滚动呼吸灯 = 工作中。
     左栏树多选时另有一颗「生成所选变体」（选中集合非空才出）；两者都没有时整条收空。 */
  const rsDvBusy = new Set(); /* 正在就地生成的目标路径：连点不重复发请求 */
  /* 「＋ 变体」小面板的状态：打开着就跟 renderReadTools 一起重画（别处重画不把它关掉，
     只有面板里的取消 / 添加成功会收起它）。
     null = 收起；否则 { kind, lang, code, err } —— lang 为空串表示「自定义语言码」 */
  let rsAddVar = null;
  /* 新变体规则（「＋ 变体」小面板用）：种类（translate / skim / concept / tech）+ 语言码 → 一条规则。
     · 表里已有「同一变体」的就直接复用（existed:true），不重复加。判同一变体：翻译按语言认；
       3-Pass 三条不分语言（lang 恒为空 = 跟随原文语言），同一种类只留一条 ——
       否则两篇抢同一个文件名，第二篇会撞「目标已存在」；
     · 新加那条的 id / suffix 取「种类-语言」（翻译直接用语言码），撞了就加序号 ——
       suffix 必须唯一，否则 research-versions.js 的 suffixOf 会把两篇认成同一类变体；
     · label 同一条口径：翻译 = 语言名，3-Pass = 种类名。 */
  function rsVariantRule(rules, kind, lang, baseLang) {
    const list = Array.isArray(rules) ? rules : [];
    const K = String(kind || "").trim() || "translate";
    const Lraw = String(lang || "").trim();
    const isT = K === "translate";
    const L = isT ? Lraw.toLowerCase() : "";
    const hit = list.filter((r) => {
      if (r.derived !== K) return false;
      return (r.lang || "") === L;
    })[0];
    if (hit) return { rule: hit, existed: true };
    const V = typeof window !== "undefined" ? window.MTResearchVersions : null;
    const langName = V && typeof V.langLabel === "function" ? V.langLabel(Lraw) : Lraw;
    const name = isT
      ? ""
      : K === "skim"
        ? t("略读")
        : K === "concept"
          ? t("关键概念")
          : K === "tech"
            ? t("技术细节")
            : K === "summary"
              ? t("摘要")
              : K === "excerpt"
                ? t("节选")
                : K;
    const base = isT ? L : K;
    let id = base;
    for (let i = 2; list.some((r) => r.id === id || r.suffix === id); i += 1) id = base + "-" + i;
    return {
      rule: {
        id: id,
        label: isT ? langName : name,
        derived: K,
        lang: L,
        suffix: id,
        hint: "",
      },
      existed: false,
    };
  }
  /* 规则表改动后的唯一出口：写**这一页**的表（research.json 的 ui.deriveRulesByPage[页面路径]，
     research-derive.js 的 saveRules 只动这一个键）→ 重画左栏 / 顶栏 / 阅读区顶条。返回生效后的新表。 */
  async function rsSaveRules(D, list, pagePath) {
    const next = await D.saveRules(list, pagePath);
    renderSide();
    renderReadTools();
    return next;
  }
  /* 每颗 chip 的 ×：把这条规则从**这一页**的表里移除（别的页不受影响）。
     没生成 → 盘上没有文件，直接移除；
     已生成 → 只从规则集合移除，盘上文件保留（不做静默删文件，删除走左栏右键）。
     允许删到空：空表照常写回（ui.deriveRulesByPage[页] = []），这一页之后不出任何默认衍生物。
     删除一律先问一句：这是把一条变体从这一页的规则里删掉，点歪了就没了（删到空还会让整排消失）。 */
  async function rsDropVariant(D, kindId, exists, pagePath, label) {
    if (!D || typeof D.saveRules !== "function") {
      return toastSafe(t("衍生物模块版本过旧（缺 saveRules）"), "err");
    }
    const page = pagePath || rsDeriveTarget();
    const list =
      typeof D.rulesFor === "function" ? D.rulesFor(page) : (D.rules && D.rules()) || [];
    const next = list.filter((r) => r.id !== kindId);
    if (next.length === list.length) return renderReadTools();
    const name = String(label || kindId);
    let ok = true;
    if (typeof confirmDialog === "function") {
      const msg =
        t("从这一页的规则表移除「") +
        name +
        t("」？") +
        " " +
        (exists
          ? t("盘上已经生成的那份文件会保留（仍在左栏树里，可右键删除），只是这一页之后不再列这一颗。")
          : t("这一份还没生成，盘上没有文件，移除后不会留下任何东西。"));
      ok = await confirmDialog(msg, {
        title: t("移除变体"),
        okText: t("移除"),
        cancelText: t("取消"),
        defaultCancel: true,
      });
    }
    if (!ok) return renderReadTools();
    try {
      await rsSaveRules(D, next, page);
    } catch (e) {
      return toastSafe(String((e && e.message) || e), "err");
    }
    return toastSafe(
      exists
        ? t("已从这一页的规则表移除 ") + name + t("；盘上文件保留（仍在左栏树里，可右键删除）")
        : t("已从这一页的规则表移除 ") + name,
      exists ? "warn" : "ok",
    );
  }
  /* ── 一致化的基准：同组多版都被改过时，取「改动量最大」的那一版 ──
   * 金的判据（research-versions.js 的 stateOf）只存基线哈希，盘上没有基线正文；改动前的正文
   * 只在 changes.jsonl 每条记录的 before 里。所以「改动量」= 这一篇**最早一条记录**的 before
   * 与现在正文的行级差异（增 + 删行数，按行做多重集比对：同一行只在共同的那一份里抵一次）。
   * · 日志里没有这一篇的记录（外部编辑 / 日志已裁剪）→ 记 0，不猜；
   * · 并列（含都为 0）→ 取最近一次被编辑的那一版（该篇最后一条记录的 ts）；
   * · 只有一版被改过 → 直接用它，不必读日志。
   * 只读盘、不写盘，返回 "" 表示一版都判不出来（调用方按「没得同步」处理）。 */
  async function rsSyncPickBase(paths) {
    const list = (paths || []).map((p) => String(p || "").replace(/\\/g, "/")).filter(Boolean);
    if (!list.length) return "";
    if (list.length === 1) return list[0];
    let lines = [];
    try {
      lines = changeLines(await readText(joinP(RS.root, CHANGES)));
    } catch (_) {
      lines = [];
    }
    const firstBefore = Object.create(null);
    const lastTs = Object.create(null);
    for (const line of lines) {
      const rec = parseChange(line);
      const p = rec && rec.path ? String(rec.path).replace(/\\/g, "/") : "";
      if (!p || list.indexOf(p) < 0) continue;
      if (!(p in firstBefore)) firstBefore[p] = String(rec.before == null ? "" : rec.before);
      const ts = Number(rec.ts) || 0;
      if (!(p in lastTs) || ts > lastTs[p]) lastTs[p] = ts;
    }
    /* 现在正文：优先内存里那一份（RS.notes 就是盘上读回来的正文），读不到就当空串 */
    const nowMd = (rel) => {
      const n = (RS.notes || []).find((x) => x && x.path === rel);
      if (n && typeof n.md === "string") return n.md;
      return RS.curPath === rel ? String(RS.md || "") : "";
    };
    let best = list[0];
    let bestW = -1;
    let bestTs = -1;
    for (const rel of list) {
      const w = rel in firstBefore ? rsLineDiffWeight(firstBefore[rel], nowMd(rel)) : 0;
      const ts = lastTs[rel] || 0;
      if (w > bestW || (w === bestW && ts > bestTs)) {
        best = rel;
        bestW = w;
        bestTs = ts;
      }
    }
    return best;
  }
  /* 行级改动量（增 + 删行数）：两边的行按多重集比对，同一行只在共同的那一份里抵一次 */
  function rsLineDiffWeight(aText, bText) {
    const A = String(aText == null ? "" : aText).split(/\r?\n/);
    const B = String(bText == null ? "" : bText).split(/\r?\n/);
    const left = new Map();
    for (const l of A) left.set(l, (left.get(l) || 0) + 1);
    let same = 0;
    for (const l of B) {
      const c = left.get(l) || 0;
      if (c > 0) {
        same += 1;
        left.set(l, c - 1);
      }
    }
    return A.length + B.length - 2 * same;
  }

  /* ── 平铺条右端的视图偏好：正文字号（点击直选，菜单见 rsFsMenu）──
   * 字号只属于**这一页**：写进页面根的 --rs-fs（11–24px），正文 / 引用块 / 元信息行按它缩放。
   * 档位 14–20 逐 1px，另加 22 / 24（大标题稿与学生屏读），再加 11 / 12 / 13 三档小字
   * （密排的文献摘录、投影屏上要给旁边留地方时用）；MIN / MAX 就是菜单的两端。
   * 亮暗不再单设开关：跟随全局主题（body.theme-light → .rs-light），想换纸色走顶栏的水滴取色。
   * 状态与规则表同一份通道：research.json 的 ui（ui.rsFs）；读不到就按默认字号。 */
  const RS_FS_MIN = 11;
  const RS_FS_MAX = 24;
  const RS_FS_DEF = 16;
  /* 菜单里列的档位（三列网格：11–13 三档小字在前，14–20 逐 1px，最后 22 / 24） */
  const RS_FS_STEPS = [11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 22, 24];
  function rsFsVal(v) {
    const n = Math.round(Number(v));
    if (!isFinite(n)) return RS_FS_DEF;
    return n < RS_FS_MIN ? RS_FS_MIN : n > RS_FS_MAX ? RS_FS_MAX : n;
  }
  /* ── 阅读背景色（只这一页的纸色）──
   * 空 = 跟随主题；#rrggbb = 用户自己挑的纸色。
   * 落地方式：只往 #researchPane 上写内联 CSS 变量（内联压过 .rs-light / 暗色那两段规则），
   * 因此页面底、阅读区、卡片面一起换色，**不动**设置里的全局主题，也不改任何文件。
   * 文字与描边跟着纸色的明暗自动翻一档（浅纸 → 深字，深纸 → 浅字），避免挑了浅底还留白字。 */
  function rsBgNormalize(v) {
    const s = String(v == null ? "" : v).trim();
    return /^#[0-9a-f]{6}$/i.test(s) ? s.toLowerCase() : "";
  }
  function rsBgLum(hex) {
    const m = /^#([0-9a-f]{6})$/i.exec(String(hex || ""));
    if (!m) return NaN;
    const n = parseInt(m[1], 16);
    const f = (c) => {
      const x = c / 255;
      return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f((n >> 16) & 255) + 0.7152 * f((n >> 8) & 255) + 0.0722 * f(n & 255);
  }
  const RS_BG_VARS = [
    "--bg", "--bg2", "--panel", "--panel2", "--code", "--ink", "--muted", "--bd", "--bd2",
    "--cyan", "--cyan2", "--blue", "--green", "--red", "--yellow", "--orange", "--orange2",
    /* 术语紫（研究页「链接类记号」色版）：跟着纸色翻档，否则浅纸上会留一档淡紫看不清 */
    "--rs-tone-term",
  ];
  /* 浅纸下强调色换成亮色那一套（暗色的荧光青 / 黄在浅底上发飘、对比不够）；深纸沿用主题那套 */
  const RS_BG_ACCENTS = {
    "--cyan": "#2068b8",
    "--cyan2": "#15508f",
    "--blue": "#1a63c8",
    "--green": "#1a8a4a",
    "--red": "#cf2a1e",
    "--yellow": "#8a6100",
    "--orange": "#d9660a",
    "--orange2": "#b54f04",
    "--rs-tone-term": "#6b46c1",
  };
  function rsApplyBgSkin(host) {
    const c = rsBgNormalize(RS.bg);
    if (!c) {
      for (const k of RS_BG_VARS) host.style.removeProperty(k);
      host.style.colorScheme = "";
      /* 注意：纸色换肤的状态类叫 rs-bg-skin，**不能**叫 rs-bg-custom ——
         那是「水滴 → 自定义」那颗 chip 自己的样式类（inline-flex / align-items:center /
         圆角 / 边框 / padding），挂到整只研究页上就会让整页缩成一只居中、带圆角边框的盒子。 */
      host.classList.remove("rs-bg-skin", "rs-bg-paper-light");
      return;
    }
    const light = rsBgLum(c) > 0.34;
    /* 纸色是基底；bg2（顶栏）/ panel（卡面）/ panel2（胶囊）/ code 都从它派生一档，
       这样挑了任何颜色，整页不会出现「纸是米色、卡面还是蓝灰」的拼色。 */
    const toward = light ? "#000000" : "#ffffff";
    host.style.setProperty("--bg", c);
    host.style.setProperty("--bg2", `color-mix(in srgb, ${c} 90%, ${toward})`);
    host.style.setProperty("--panel", `color-mix(in srgb, ${c} 94%, ${light ? "#ffffff" : "#000000"})`);
    host.style.setProperty("--panel2", `color-mix(in srgb, ${c} 85%, ${toward})`);
    host.style.setProperty("--code", `color-mix(in srgb, ${c} 88%, ${toward})`);
    host.style.setProperty("--ink", light ? "#1e222b" : "#e7eaf0");
    host.style.setProperty("--muted", light ? "#5a6472" : "#98a2b0");
    host.style.setProperty("--bd", light ? "#d0d6de" : "#383c42");
    host.style.setProperty("--bd2", light ? "#b0b9c4" : "#484d55");
    for (const k of Object.keys(RS_BG_ACCENTS)) {
      if (light) host.style.setProperty(k, RS_BG_ACCENTS[k]);
      else host.style.removeProperty(k);
    }
    /* 滚动条 / 原生控件跟着纸色走（全局 html 是 color-scheme: dark） */
    host.style.colorScheme = light ? "light" : "";
    host.classList.add("rs-bg-skin");
    host.classList.toggle("rs-bg-paper-light", light);
  }
  /* 把视图偏好落到页面根上（皮肤类 + 字号 + 纸色变量）：进入视图 / 换画布 / 点按钮都只走这一处 */
  /* 全局主题变过一次就重刷一次皮肤（亮暗 toggle 已移除，.rs-light 只跟 body.theme-light 走） */
  let rsThemeObs = null;
  function rsWatchTheme() {
    if (rsThemeObs || typeof MutationObserver === "undefined" || !document.body) return;
    rsThemeObs = new MutationObserver(() => applyViewSkin());
    rsThemeObs.observe(document.body, { attributes: true, attributeFilter: ["class"] });
  }
  function applyViewSkin() {
    const host = pane();
    if (!host) return;
    rsWatchTheme();
    /* 亮暗没有单独开关了：跟随全局主题（设置里的主题切亮色才亮），纸色另由水滴取色决定。
       只在状态真的变了才写类：body 的 class 变动会反复叫到这里（见 rsWatchTheme）。 */
    const wantLight = !!(document.body && document.body.classList.contains("theme-light"));
    if (host.classList.contains("rs-light") !== wantLight) host.classList.toggle("rs-light", wantLight);
    host.style.setProperty("--rs-fs", rsFsVal(RS.fs) + "px");
    rsApplyBgSkin(host);
  }
  /* 写回 research.json 的 ui（与左栏收纳 / 会话收纳同一条通道，只动这两个键） */
  function saveViewMeta() {
    const ui = Object.assign({}, (RS.meta && RS.meta.ui) || {}, {
      rsFs: rsFsVal(RS.fs),
      rsBg: rsBgNormalize(RS.bg),
    });
    delete ui.rsLight; /* 亮暗开关已移除，顺手清掉旧存档里那条 */
    void saveMetaPatch({ ui });
  }
  /* ── 视图按钮的共享重绘表 ──
   * 背景色的状态有两处按钮（顶栏那颗水滴图标 + 浮层里的色块），点色走 rsSetBg 后
   * 把表里还挂在页面上的按钮齐刷一遍 —— 不需要谁去重建 DOM。 */
  const RS_VIEW_PAINT = [];
  function rsPaintViewBtns() {
    for (let i = RS_VIEW_PAINT.length - 1; i >= 0; i--) {
      const it = RS_VIEW_PAINT[i];
      if (!it || !it.el || !document.body.contains(it.el)) {
        RS_VIEW_PAINT.splice(i, 1);
        continue;
      }
      try {
        it.paint();
      } catch (_) {}
    }
  }
  function rsSetBg(color) {
    RS.bg = rsBgNormalize(color);
    applyViewSkin();
    saveViewMeta();
    rsPaintViewBtns();
  }
  /* 字号：一颗「16px ⌄」按钮，点开一块持久小菜单直选档位（不再一步步加减）。
     paint() 只改这颗按钮的读数与按下的态，正文 DOM 一个不动。 */
  function rsViewBar() {
    const frag = document.createDocumentFragment();
    const btn = el("button", "rs-view-fsbtn");
    btn.type = "button";
    const valEl = el("span", "rs-view-fsbtn-v");
    const caret = el("i", "rs-view-fsbtn-c", "⌄");
    btn.appendChild(valEl);
    btn.appendChild(caret);
    function paint() {
      const n = rsFsVal(RS.fs);
      valEl.textContent = n + "px";
      btn.title = t("正文字号（11–24）");
      btn.setAttribute("aria-label", btn.title);
      /* 菜单开着时按钮留一个按下态（菜单关掉由 rsFsMenuClose 回调再刷一次） */
      btn.classList.toggle("on", !!rsFsMenuEl && rsFsMenuAnchor === btn);
    }
    btn.onclick = () => rsFsMenu(btn, paint);
    paint();
    frag.appendChild(btn);
    return frag;
  }
  /* ── 正文字号菜单（持久小浮层，与 rsBgPicker 同一口径）──
   * 点菜单外**不**关；关只走：窗内 ✕ / Esc / 再点同一颗按钮。
   * 开菜单前先 closeNodePopsExcept 收掉别的节点级浮层（同时收掉自己的上一块）。
   * 选中即 applyViewSkin（写 --rs-fs）+ saveViewMeta（写 research.json 的 ui.rsFs），不关窗，方便连着试几档。 */
  let rsFsMenuEl = null;
  let rsFsMenuAnchor = null;
  let rsFsMenuPaint = null;
  function rsFsMenuClose() {
    if (!rsFsMenuEl) return;
    document.removeEventListener("keydown", rsFsMenuEl._rsKey, true);
    rsFsMenuEl.remove();
    rsFsMenuEl = null;
    rsFsMenuAnchor = null;
    const p = rsFsMenuPaint;
    rsFsMenuPaint = null;
    if (p) p();
  }
  function rsFsMenu(anchor, paintBtn) {
    /* 再点同一颗按钮 = 关上（persistent 浮层的关闭手势之一） */
    if (rsFsMenuEl && rsFsMenuAnchor === anchor) return rsFsMenuClose();
    rsFsMenuClose();
    if (typeof closeNodePopsExcept === "function") closeNodePopsExcept("");
    const box = el("div", "rs-ask rs-fspick");
    const host = pane();
    if (host && host.classList.contains("rs-light")) box.classList.add("rs-light");
    if (host && host.classList.contains("rs-bg-paper-light")) box.classList.add("rs-bg-paper-light");
    box.innerHTML =
      '<div class="rs-ask-head"><b>' +
      esc(t("正文字号")) +
      '</b><button class="rs-ask-x" type="button" title="' +
      esc(t("关闭")) +
      '">✕</button></div>' +
      '<div class="rs-fs-grid"></div>';
    document.body.appendChild(box);
    /* 贴着按钮下沿展开（右侧对齐）；越界就拉回视口内 —— 同 rsBgPicker */
    const r = anchor.getBoundingClientRect();
    const w = box.offsetWidth || 148;
    const left = Math.max(12, Math.min(window.innerWidth - w - 12, r.right - w));
    box.style.left = left + "px";
    box.style.right = "auto";
    box.style.top = Math.min(window.innerHeight - 60, r.bottom + 6) + "px";

    const grid = box.querySelector(".rs-fs-grid");
    const paint = () => {
      const cur = rsFsVal(RS.fs);
      for (const b of grid.querySelectorAll(".rs-fs-sw")) {
        b.classList.toggle("on", Number(b.dataset.fs) === cur);
      }
    };
    for (const n of RS_FS_STEPS) {
      const b = el("button", "rs-fs-sw", n + "px");
      b.type = "button";
      b.dataset.fs = String(n);
      b.onclick = () => {
        RS.fs = rsFsVal(n);
        applyViewSkin();
        saveViewMeta();
        paint();
        if (paintBtn) paintBtn();
      };
      grid.appendChild(b);
    }
    paint();
    rsFsMenuEl = box;
    rsFsMenuAnchor = anchor;
    rsFsMenuPaint = paintBtn || null;
    const onKey = (ev) => {
      if (ev.key === "Escape") {
        ev.stopPropagation();
        rsFsMenuClose();
      }
    };
    box._rsKey = onKey;
    document.addEventListener("keydown", onKey, true);
    box.querySelector(".rs-ask-x").onclick = () => rsFsMenuClose();
    if (paintBtn) paintBtn();
    return box;
  }
  /* ── 顶栏右侧两颗视图图标：背景色 / 刷新 ──
   * 为什么放顶栏而不是笔记工具条：它们管的是「这一页怎么看」，一张笔记都没打开时也要能点。
   * 亮暗 toggle 已移除：亮暗跟随全局主题，纸色（含浅底/深底）全交给这颗水滴取色。
   * 两颗都只改这一页（内联 --bg 变量），不碰设置里的全局主题。 */
  function rsViewIcons() {
    const wrap = el("div", "rs-top-icons");

    /* ① 背景色：水滴取色图标 + 右下角一格当前纸色（小颜色版 icon） */
    const bgBtn = el("button", "rs-top-ico");
    const bgPaint = () => {
      const c = rsBgNormalize(RS.bg);
      bgBtn.innerHTML = "";
      bgBtn.appendChild(rsIcon("tint"));
      const sw = el("i", "rs-top-swatch" + (c ? "" : " empty"));
      if (c) sw.style.background = c;
      bgBtn.appendChild(sw);
      bgBtn.classList.toggle("on", !!c);
      bgBtn.title = c
        ? t("阅读背景色：") + c + t("（点开可改或恢复跟随主题）")
        : t("调整阅读背景色（只影响研究页）");
      bgBtn.setAttribute("aria-label", t("调整阅读背景色"));
    };
    bgPaint();
    RS_VIEW_PAINT.push({ el: bgBtn, paint: bgPaint });
    bgBtn.onclick = () => rsBgPicker(bgBtn);
    wrap.appendChild(bgBtn);

    /* ② 刷新：重读 research/ 目录（外部编辑器改过文件时用） */
    const ref = el("button", "rs-top-ico");
    ref.appendChild(rsIcon("refresh"));
    ref.title = t("重新读取 research/ 目录（外部编辑器改过文件时用）");
    ref.setAttribute("aria-label", ref.title);
    ref.onclick = async () => {
      await rsReloadAll();
      toastSafe(t("已刷新"));
    };
    wrap.appendChild(ref);

    /* ③ 图谱：笔记 / 图谱互切的 toggle（原在左栏「核心」页，本轮挪到刷新右边） */
    const gp = el("button", "rs-top-ico rs-top-graph");
    const gpPaint = () => {
      const inGraph = RS.mode === "graph";
      gp.innerHTML = "";
      gp.appendChild(rsIcon("graph"));
      gp.classList.toggle("on", inGraph);
      gp.title = inGraph
        ? t("回到笔记视图（图谱只是投影，不改任何文件）")
        : t("转为图谱：解析全部笔记，重建知识图谱（再点一次回笔记）");
      gp.setAttribute("aria-label", inGraph ? t("回到笔记") : t("转为图谱"));
    };
    gpPaint();
    RS_VIEW_PAINT.push({ el: gp, paint: gpPaint });
    gp.onclick = () => (RS.mode === "graph" ? rsSetMode("notes") : rsBuildGraph(true));
    wrap.appendChild(gp);

    /* ④ 演示：核心稿 + 3-Pass 变体 → 一套可放映的页（PPT）。
       没有核心稿件时按不下去（内核那时只出封面 + 结语，做出来没有意义）：
       菜单里三件事 —— 打开编辑器（内核直出）/ 让 Agent 重写整份 / 让 Agent 重写这一页
       （后两颗先开编辑器收一句「这次想怎么改」，与编辑器里的按钮同一套）。 */
    const dk = el("button", "rs-top-ico rs-top-deck");
    dk.appendChild(rsIcon("deck"));
    const dkPaint = () => {
      const allow = rsSlidesReady();
      /* 与顶栏那两颗 toggle 同一口径：不用 disabled，改 aria-disabled —— 置灰但悬停还能看 title，
         说明「为什么点不了」（这里 = 还没有核心稿件）。样式见 research.css 的 .rs-top-ico[aria-disabled] */
      dk.setAttribute("aria-disabled", allow ? "false" : "true");
      dk.classList.toggle("on", allow && !!rsDeck().ctrl);
      dk.title = allow
        ? t("演示：把核心稿与 3-Pass 变体排成一套可放映的页（编辑 / 放映 / 导出 HTML）")
        : t("演示：还没有核心稿件（先投料或新建一篇原文）");
      dk.setAttribute("aria-label", t("演示"));
    };
    dkPaint();
    RS_VIEW_PAINT.push({ el: dk, paint: dkPaint });
    dk.onclick = () => {
      if (dk.getAttribute("aria-disabled") === "true") return;
      rsSlidesMenu(dk, dkPaint);
    };
    wrap.appendChild(dk);
    return wrap;
  }
  /* ── 阅读背景色选择器（持久浮层）──
   * 预设几档纸色 + 一个自定义取色；点色即生效（不关窗，方便连着换几档看）。
   * 关闭只走窗内 ✕ / Esc / 再点同一颗按钮（合约定：不点外自动关闭）。 */
  const RS_BG_PRESETS = [
    ["", "跟随主题"],
    ["#f6f2e9", "米白"],
    ["#f3ecdf", "暖纸"],
    ["#eaeaea", "中性灰"],
    ["#e7eef1", "青灰"],
    ["#e9efe6", "灰绿"],
    ["#e8eaf4", "雾蓝"],
    ["#222222", "深灰"],
    ["#1b2230", "暗蓝"],
    ["#111214", "纯黑"],
  ];
  function rsBgPicker(anchor) {
    const open = document.querySelector(".rs-ask.rs-bgpick");
    if (open) {
      open.remove();
      return;
    }
    /* 与字号菜单互斥：两块都挂在 body 上、同一处顶栏，叠起来会互相压住 */
    rsFsMenuClose();
    const box = el("div", "rs-ask rs-bgpick");
    const host = pane();
    if (host && host.classList.contains("rs-light")) box.classList.add("rs-light");
    if (host && host.classList.contains("rs-bg-paper-light")) box.classList.add("rs-bg-paper-light");
    box.innerHTML =
      '<div class="rs-ask-head"><b>' +
      esc(t("阅读背景色")) +
      '</b><button class="rs-ask-x" title="' +
      esc(t("关闭")) +
      '">✕</button></div>' +
      '<div class="rs-bg-grid"></div>' +
      '<div class="rs-ask-row rs-bg-foot"><label class="rs-bg-custom">' +
      esc(t("自定义")) +
      '<input type="color" /></label><span class="rs-bg-now"></span></div>' +
      '<div class="rs-bg-note">' +
      esc(
        t(
          "只改研究页的纸色，不动设置里的全局主题；文字深浅会跟着纸色自动翻一档。点「跟随主题」即交回主题决定亮暗。",
        ),
      ) +
      "</div>";
    document.body.appendChild(box);
    /* 贴着按钮下沿展开（右侧对齐）；越界就拉回视口内 */
    const r = anchor.getBoundingClientRect();
    const w = box.offsetWidth || 248;
    const left = Math.max(12, Math.min(window.innerWidth - w - 12, r.right - w));
    box.style.left = left + "px";
    box.style.right = "auto";
    box.style.top = Math.min(window.innerHeight - 60, r.bottom + 6) + "px";

    const grid = box.querySelector(".rs-bg-grid");
    const now = box.querySelector(".rs-bg-now");
    const custom = box.querySelector('input[type="color"]');
    /* 一颗色块：预设空值那颗画斜纹「跟随主题」，其余用纸色本身当底 */
    const paint = () => {
      const cur = rsBgNormalize(RS.bg);
      for (const b of grid.querySelectorAll(".rs-bg-sw")) {
        b.classList.toggle("on", String(b.dataset.c || "") === cur);
      }
      custom.value = cur || "#eaeaea";
      now.textContent = cur || t("跟随主题");
      /* 纸色变得浅了，浮层自己也要跟着翻（浮层挂在 body 上，不吃页面变量） */
      const lightPaper = !!cur && rsBgLum(cur) > 0.34;
      box.classList.toggle("rs-bg-paper-light", lightPaper);
    };
    for (const [c, label] of RS_BG_PRESETS) {
      const b = el("button", "rs-bg-sw" + (c ? "" : " auto"));
      b.dataset.c = c;
      const chip = el("i", "rs-bg-chip" + (c ? "" : " auto"));
      if (c) chip.style.background = c;
      b.appendChild(chip);
      b.appendChild(el("span", "rs-bg-lab", t(label)));
      b.title = c || t("跟随当前主题的底色");
      b.onclick = () => {
        rsSetBg(c);
        paint();
      };
      grid.appendChild(b);
    }
    custom.oninput = () => {
      rsSetBg(custom.value);
      paint();
    };
    paint();

    const close = () => {
      document.removeEventListener("keydown", onKey, true);
      box.remove();
    };
    const onKey = (ev) => {
      if (ev.key === "Escape") {
        ev.stopPropagation();
        close();
      }
    };
    document.addEventListener("keydown", onKey, true);
    box.querySelector(".rs-ask-x").onclick = close;
    return box;
  }
  function renderReadTools() {
    const D = rsDerive();
    const host = RS.readToolsEl;
    if (!host) return;
    /* 重画这条就把旧的字号菜单收掉：它贴着上一颗按钮定位，留着就是一块孤儿浮层
       （这里也要收 —— 下面有早返回的分支，不能指望收尾那行） */
    rsFsMenuClose();
    host.innerHTML = "";
    /* 基线（versions.json）在后台读：读进来之后重画一次 —— 四态判色都靠它 */
    if (!rsVerReady()) {
      const V = rsVersions();
      if (V) {
        void V.ensureLoaded()
          .then(() => {
            if (RS.readToolsEl === host) renderReadTools();
          })
          .catch(() => {});
      }
    }
    const p = rsDeriveTarget();
    const picked = rsMultiList();
    /* 没有衍生目标（折叠文件 / 索引页 / 空库）：平铺条里没有 chip，但条尾那一撮照常要有 ——
       编辑按钮与正文字号是「这一篇怎么写、怎么读」的开关，不该跟着有没有变体出现。 */
    if (!p && !picked.length) {
      rsTailTools(host);
      return;
    }
    const mk = (label, tip, fn) => {
      const b = el("button", "rs-tool", label);
      b.title = tip;
      b.onclick = fn;
      host.appendChild(b);
      return b;
    };
    if (p) {
      /* ── 平铺条：原文 + 这一页规则表里的每一类，一颗一份 ──
         组与成员只认 research-versions.js（RS.notes 上归组，页表换过会自己重算）；
         目标路径 / 语言 / 生成模板都交给 research-derive.js，这里不自己拼。
         表是**每页一份**（这一页加的变体不会出现在别的页）——先归组拿到原文，再取原文那一页的表。
         页表为空（用户把变体删光了）就只剩「原文」这一颗 + 条尾的「＋ 变体」，不补任何默认稿。 */
      const V = rsVersions();
      let g = null;
      try {
        g = V && typeof V.groupOf === "function" ? V.groupOf(p) : null;
      } catch (_) {
        g = null;
      }
      const members = (g && g.members) || [];
      const byPath = Object.create(null);
      for (const m of members) if (m && m.path) byPath[m.path] = m;
      const original = (g && g.original) || p;
      const origNote = (RS.notes || []).find((n) => n.path === original) || null;
      const baseLang = String((origNote && origNote.meta && origNote.meta.lang) || "zh").trim() || "zh";
      /* 这一页（原文那一页）自己的规则表：每页一份，互不影响 */
      const rules =
        D && typeof D.rulesFor === "function" ? D.rulesFor(original) : D && typeof D.rules === "function" ? D.rules() : [];
      const statusBy = rsStatusMap() || Object.create(null);
      /* 组里有几版被改过（金）：只要有一版被改过，「变体一致化」就会出现 ——
         基准由它自己按「改动量最大」的那一版定（见 rsSyncPickBase），不需要用户先挑一版。
         多版都被改过时只换 chip 的提示文案（一句「同组有多版都动过」），不另给按钮。 */
      let goldN = 0;
      for (const m of members) if (m && m.path && statusBy[m.path] === "diverged") goldN += 1;
      const strip = el("div", "rs-dv-strip");
      strip.title = t("全部衍生稿：原文与规则表里每一类的现状（缺的点一下就地生成）");
      const chip = (label, path, kindId, isOrig, langIn) => {
        const exists = !!byPath[path];
        /* 四态只问 research-versions.js 那一份判据（橙是整组的结论，不在这里自己叠）：
           灰 = 未生成，绿 = 已生成且与基线一致，橙 = 同组有人改过、这份没跟上，
           金 = 就是被改过那一版，青 = 已经生成但盘上没有基线（旧稿 / 外部放进来）。
           「没有基线」必须与「未生成」分开上色：两者混成同一个灰，用户看到的就是
           「明明有稿却还是灰的」—— 上一版就是这里没按规则分色。 */
        const st = exists ? statusBy[path] || "" : "";
        const cls = !exists
          ? "is-muted"
          : st === "diverged"
            ? "is-gold"
            : st === "stale"
              ? "is-stale"
              : st === "clean"
                ? "is-synced"
                : "is-nobase";
        /* 正在生成这一颗（就地生成用 rsDvBusy 记；批量队列走顶栏那颗进度 chip 的扫光）：滚动呼吸灯 = 工作中 */
        const busy = !exists && rsDvBusy.has(path);
        /* 一颗 chip = 一个主体按钮（打开 / 就地生成）+ 一颗 ×（把这条规则从规则表里移除）。
           × 不塞进主体按钮里：按钮里嵌按钮既不合规，点 × 也会连带打开那一篇。 */
        const wrap = el("span", "rs-dv-chip " + cls + (busy ? " is-working" : ""));
        const b = el("button", "rs-dv-chip-main", busy ? label + " …" : label);
        let stateText = "";
        if (!exists) stateText = busy ? t("正在生成…") : t("未生成 · 点一下就地生成");
        else if (cls === "is-gold")
          stateText = goldN > 1 ? t("这一版被改过（同组有多版都动过）") : t("这一版被改过（改动集中在这里）");
        else if (cls === "is-stale") stateText = t("同组有人改过、这一份未同步");
        else if (cls === "is-synced") stateText = t("已生成 · 与上次同步一致");
        else stateText = t("已生成 · 还没有同步基线（重新生成一次或扩散一次就会记上，之后按基线判同步）");
        b.title = stateText + "\n" + path;
        b.disabled = busy;
        b.onclick = () => {
          if (busy) return null;
          if (exists) return rsOpenNote(path);
          if (isOrig) return toastSafe(t("原文不存在：") + path, "warn");
          if (!D || typeof D.runSingle !== "function") {
            return toastSafe(t("衍生物模块没加载（renderer/research-derive.js）"), "err");
          }
          if (rsDvBusy.has(path)) return null;
          /* 目标语言沿用画这颗 chip 时算的那一份（规则自带语言优先），不在这里另算一遍 */
          const lang = langIn || (typeof D.langOf === "function" ? D.langOf(kindId, baseLang, rules) : baseLang);
          const job = { parentPath: original, kindId: kindId, lang: lang, label: label, rel: path };
          /* 花 Token 前先确认（与面板 / 批量同一条口径），问在「正在生成…」亮起之前 */
          const ask = typeof D.confirmGen === "function" ? D.confirmGen(job) : Promise.resolve(true);
          void Promise.resolve(ask).then((ok) => {
            if (!ok) return null; /* 用户点了取消：一个字节都不动 */
            rsDvBusy.add(path);
            /* 先按 busy 态重画一次：滚动呼吸灯当场亮起来，不是等跑完才出现 */
            renderReadTools();
            return Promise.resolve()
              .then(() => D.runSingle(job, { confirmed: true }))
              .then((made) => made && toastSafe(t("已生成 ") + made))
              .catch((e) => {
                if (!(e && e.cancelled)) toastSafe(String((e && e.message) || e), "err");
              })
              .then(() => {
                rsDvBusy.delete(path);
                rsStatusReset();
                renderReadTools();
              });
          });
          return null;
        };
        wrap.appendChild(b);
        if (!isOrig) {
          const x = el("button", "rs-dv-chipx", "×");
          x.title = exists
            ? t("从规则表移除这一条（盘上文件保留，仍在左栏树里，可右键删除）")
            : t("从规则表移除这一条（还没生成，盘上没有文件）");
          x.onclick = (ev) => {
            if (ev && typeof ev.stopPropagation === "function") ev.stopPropagation();
            void rsDropVariant(D, kindId, exists, original, label);
          };
          wrap.appendChild(x);
        }
        strip.appendChild(wrap);
        return wrap;
      };
      chip(t("原文"), original, "", true);
      /* 原件 chip：这一篇的 frontmatter 写了 origin（从 PDF / docx / tex… 转过来）就挂一颗，
         一键打开那份原件 —— 只读，不随编辑改动（pdf 走应用内翻页浮层，其余交系统程序）。
         只挂在**原文页**的页头（读的是变体时不挂：那是原文的原件，不是这一稿的）。 */
      const originRel = String((origNote && origNote.meta && origNote.meta.origin) || "").trim();
      if (originRel && String(p) === String(original)) {
        const ob = el("button", "rs-dv-origin", "🔒 " + t("原件"));
        ob.type = "button";
        ob.title = t("打开原件（只读，不随编辑改动）：") + originRel;
        ob.onclick = () => void rsOpenOriginal(originRel);
        strip.appendChild(ob);
      }
      for (const k of rules) {
        /* 规则自带语言（「＋ 变体」新加的「摘要 · 日本語」）就用它自己的，否则用原文语言：
           langOf 对非译稿是「参数优先」，这里传原文语言会把新加的日文稿写成中文稿。 */
        const wantLang = k.lang || baseLang;
        const lang = typeof D.langOf === "function" ? D.langOf(k.id, wantLang, rules) : wantLang;
        const rel = typeof D.targetRel === "function" ? D.targetRel(original, k.id, lang, rules) : "";
        if (!rel) continue;
        /* 译稿语言互斥（**只过滤这一条 chip 的显示**，规则表 / 盘上文件 / 判色 / 批量生成一概不动）：
           英文原文只留中译、中文原文只留英译 —— 与原文同语言的那一稿就是原文本身，
           再挂一颗「英译」只会让人以为还有第二份稿子。种类先问规则表（自定义规则也认），
           语言用上面算好的 lang（与 targetRel 同一个值），口径同 D.langOf / noteMeta。 */
        const rule = typeof D.kindOf === "function" ? D.kindOf(k.id, rules) : k;
        const sameLang =
          String(lang || "")
            .trim()
            .toLowerCase() ===
          String(baseLang || "")
            .trim()
            .toLowerCase();
        if (rule && rule.derived === "translate" && baseLang && sameLang) continue;
        chip(k.label, rel, k.id, false, lang);
      }

      /* ── 条尾那颗「＋ 变体」与它的小面板 ──
         面板里选种类（翻译 / 摘要 / 节选）+ 语言（中 / 英 / 自定义语言码），点「添加」只做一件事：
         把这条规则写进**这一页**的表（research.json 的 ui.deriveRulesByPage，research-derive.js 的 saveRules），
         然后收起面板、重画平铺条 —— 新 chip 以「未生成」的 is-muted 态出现。
         **不在这里出稿**：生成走既有入口（点 chip 就地生成 / 左栏右键「生成所选变体」）。
         面板不是蒙层浮层：点别处不会关，只走面板里的取消；重画时按 rsAddVar 原样重挂。 */
      const addBtn = el("button", "rs-dv-add", "＋ " + t("变体"));
      addBtn.title = t("往这一页的规则表里加一条变体（种类 + 语言）：只写入规则表，不立即生成");
      addBtn.onclick = () => {
        rsAddVar = rsAddVar ? null : { kind: "translate", lang: "zh", code: "", err: "" };
        renderReadTools();
      };
      strip.appendChild(addBtn);
      if (rsAddVar) strip.appendChild(rsAddPanel(rules));

      function rsAddPanel(curRules) {
        const st = rsAddVar;
        const box = el("div", "rs-dv-addp");
        box.appendChild(el("span", "rs-dv-addk", t("种类")));
        const ksel = el("select", "rs-dv-addsel");
        for (const kv of [
          ["translate", t("翻译")],
          ["skim", t("略读")],
          ["concept", t("关键概念")],
          ["tech", t("技术细节")],
        ]) {
          const op = el("option", null, kv[1]);
          op.value = kv[0];
          if (st.kind === kv[0]) op.selected = true;
          ksel.appendChild(op);
        }
        ksel.onchange = () => {
          st.kind = ksel.value;
          st.err = "";
          renderReadTools();
        };
        box.appendChild(ksel);
        /* 语言只对翻译有意义：3-Pass 三条跟随原文语言（lang 恒空），不摆一个选了也没用的下拉 */
        const needLang = String(st.kind || "translate") === "translate";
        if (needLang) {
          box.appendChild(el("span", "rs-dv-addk", t("语言")));
          const lsel = el("select", "rs-dv-addsel");
          /* 预设只留 中 / 英：日（ja）不再从界面新增。
             盘上已有的 .ja.md 仍由 research-versions.js 的 LANG_LABELS / 后缀归组认出来，
             不会因此变成「非标准变体」—— 只是这里不再给预设入口。
             自定义语言码（fr / de / pt-BR…）保留：它不是预设语言，去掉会让旧稿无从对应。 */
          for (const lv of [
            ["zh", t("中")],
            ["en", t("英")],
            ["", t("自定义语言码")],
          ]) {
            const op = el("option", null, lv[1]);
            op.value = lv[0];
            if (String(st.lang || "") === lv[0]) op.selected = true;
            lsel.appendChild(op);
          }
          lsel.onchange = () => {
            st.lang = lsel.value;
            st.err = "";
            renderReadTools();
          };
          box.appendChild(lsel);
          if (!st.lang) {
            const inp = el("input", "rs-dv-addsel");
            inp.value = String(st.code || "");
            inp.placeholder = "fr / de / pt-BR";
            inp.title = t("两位或三位字母的语言码，可带地区（如 fr / de / pt-BR）");
            inp.oninput = () => {
              st.code = inp.value;
            };
            box.appendChild(inp);
          }
        }
        /* 「添加」= 只写规则表，不出稿（没有 busy / 生成中态：这一步不碰生成） */
        const go = el("button", "rs-btn primary", t("添加"));
        go.onclick = () => void runAdd();
        box.appendChild(go);
        const cancel = el("button", "rs-btn", t("取消"));
        cancel.onclick = () => {
          rsAddVar = null;
          renderReadTools();
        };
        box.appendChild(cancel);
        if (st.err) box.appendChild(el("span", "rs-dv-adderr", st.err));
        return box;

        async function runAdd() {
          if (!rsAddVar) return;
          if (!D || typeof D.saveRules !== "function") {
            return toastSafe(t("衍生物模块版本过旧（缺 saveRules）"), "err");
          }
          const isT = String(rsAddVar.kind || "translate") === "translate";
          const langRaw = isT ? String(rsAddVar.lang || rsAddVar.code || "").trim().toLowerCase() : "";
          if (isT && !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/i.test(langRaw)) {
            rsAddVar.err = t("语言码不合法：两位或三位字母，可带地区（如 fr / de / pt-BR）");
            return renderReadTools();
          }
          const built = rsVariantRule(curRules, rsAddVar.kind, langRaw, baseLang);
          rsAddVar.err = "";
          try {
            /* 只往**这一页**的表里加（别的页不会因此多出这颗 chip）；表里已有就不重复写 */
            if (!built.existed) await rsSaveRules(D, (curRules || []).concat([built.rule]), original);
            rsAddVar = null;
            toastSafe(
              built.existed
                ? t("这一页的规则表里已有 ") + built.rule.label
                : t("已加入规则表：") + built.rule.label + t("（未生成 · 点那颗 chip 就地生成）"),
            );
          } catch (e) {
            const msg = String((e && e.message) || e);
            /* 写盘失败：面板留在原处，错误显示在面板里（rs-dv-adderr） */
            if (rsAddVar) rsAddVar.err = msg;
            toastSafe(msg, "err");
          }
          renderReadTools();
        }
      }
      host.appendChild(strip);
      /* ── 「变体一致化」：组里任意一版被改过（金色）时出现，基准自动取「改动量最大」的那一版 ──
         与「扩散到其他版本」分工不同：扩散把金色版正文**直接拷**过去（不调模型、不花 Token）；
         这一颗是让模型按改后的那一版**重新生成**其它版本（重译 / 重摘 / 重节选）——
         因此先确认、并当场提醒消耗 Token，建议阶段性修改之后再同步。
         基准不在这里定：要读 changes.jsonl 才知道谁的改动量最大，所以点击时才算（rsSyncPickBase）。 */
      const goldPaths = members
        .filter((m) => m && m.path && statusBy[m.path] === "diverged")
        .map((m) => m.path);
      /* 可重写的池子＝「规则表认得的那些已生成变体」（导入稿 / 手写稿 kind 对不上表，硬跑只会
         按第一条规则把它覆盖掉）。**含其它也被改过的版本**：还原按钮已删，不一起重写，
         同组就永远停在金 / 橙。基准自己那一版在点击时排除。 */
      const kindIds = (rules || []).map((r) => r.id);
      const syncPool = members.filter(
        (m) =>
          m &&
          m.path &&
          m.role !== "original" &&
          m.exists !== false &&
          byPath[m.path] &&
          kindIds.indexOf(m.kind) >= 0,
      );
      /* 池里必须存在「基准之外」的版本才挂这颗钮：只有一版、且那版就是唯一被改过的版本时，
         无论谁当基准都没有目标，点下去只会空跑 */
      const syncPossible =
        syncPool.length > 1 || (syncPool.length === 1 && goldPaths.indexOf(syncPool[0].path) < 0);
      if (goldPaths.length && syncPossible) {
        const syncBtn = el("button", "rs-dv-sync", "⟳ " + t("变体一致化"));
        syncBtn.title = t("按改动最大的那一版重新生成其它版本（会调用模型、消耗 Token，逐条串行跑）");
        syncBtn.onclick = async () => {
          /* 工作中（逐条重译 / 重摘）：按钮上跑滚动呼吸灯，跑完由 rsSyncVariants 末尾的
             renderReadTools 重画；这里只负责让它当场亮起来 + 点不动第二次。 */
          if (syncBtn.classList.contains("is-working")) return;
          syncBtn.classList.add("is-working");
          syncBtn.disabled = true;
          try {
            const base = await rsSyncPickBase(goldPaths);
            const targets = syncPool.filter((m) => m.path !== base);
            if (!base || !targets.length) return toastSafe(t("组里没有别的版本可重写"), "warn");
            await rsSyncVariants(base, targets);
          } finally {
            syncBtn.classList.remove("is-working");
            syncBtn.disabled = false;
          }
        };
        host.appendChild(syncBtn);
      }
    }
    if (picked.length) {
      mk(
        t("生成所选变体") + "（" + picked.length + "）",
        t("按版本组展开：每篇原文补上还没有的变体；目标已存在的项跳过并在面板里点名"),
        () => rsDeriveMany(picked),
      );
    }
    /* 整条的最右端：编辑（源码 ⇄ 阅读）+ 正文字号（不重画正文，只改变量与按钮态）。
       编辑按钮在字号的**左边**（rsTailTools 里先编辑、后字号）。 */
    rsTailTools(host);
  }
  /* ── 平铺条条尾那一撮：编辑按钮 + 正文字号 ──
     编辑按钮原先挂在顶栏工具行（.rs-top-tools 的 .rs-tool-slot），现在挨着字号放：
     两者都是「这一篇正文」的开关（怎么写、怎么读），平铺条末尾是它们该在的地方。
     折叠的第 2 / 3 层是只读投影：只给字号，不给编辑。 */
  function rsTailTools(host) {
    /* 没打开笔记：条尾整撮不出现（编辑与字号都属于「这一篇」，空库时不给一条空条） */
    if (!RS.curPath) return;
    const tail = el("div", "rs-tail-tools");
    const isFold = !!RS.foldPath && RS.foldPath === RS.curPath;
    /* 术语页 / 公式页：条尾多一颗「引申」—— 从这一页长出下一层（候选勾选后派会话成稿） */
    const termRec = !isFold && rsTermPage();
    if (termRec) {
      const b = el("button", "rs-tool rs-term-btn-open", t("引申"));
      b.type = "button";
      b.title = t("列出这一页还能往下讲的术语 / 公式：勾选后生成下一层（每篇独立成页，并连回这一页）");
      b.onclick = () => rsTermOpen();
      tail.appendChild(b);
    }
    if (!(isFold && RS.foldLevel > 1)) tail.appendChild(rsEditBtn());
    tail.appendChild(rsViewBar());
    host.appendChild(tail);
  }

  /* 内容树：实现在 renderer/app-research-tree.js（window.MTResearchTree）。
     左栏现在只有这一棵树 —— 索引根 / 原文 / 衍生物 / 折叠（参考资料）四段都由它画，
     原来那两份平铺清单（笔记列表 / 折叠列表）已移除。这里只做「RS ⇄ 树」的薄适配：
     打开笔记、落盘（新建衍生稿 / 删除）、重读、在文件管理器打开。 */
  let rsTreeInst = null;
  function rsTree() {
    if (!window.MTResearchTree) return null;
    if (!rsTreeInst) {
      rsTreeInst = window.MTResearchTree.create({
        el: el,
        t: t,
        state: RS,
        C: () => C(),
        root: () => RS.root,
        joinP: joinP,
        api: window.api,
        saveMeta: saveMetaPatch,
        prompt: (title, def) => promptText(title, def),
        confirm: (msg, opts) =>
          typeof confirmDialog === "function" ? confirmDialog(msg, opts) : Promise.resolve(true),
        toast: (msg, kind) => toastSafe(msg, kind),
        openNote: (path, o) => rsOpenNote(path, o),
        openFold: (path) => rsOpenFold(path),
        /* 右键「衍生一份…／导入为衍生稿…」：入口在树上，面板与队列仍在 research-derive.js */
        derive: (path, mode) => rsDeriveOpen({ path: path, mode: mode || "one" }),
        deriveImport: (path) => rsDeriveImport({ path: path }),
        revealPath: (rel) => rsRevealInFolder(rel),
        /* 左栏「原件」分组点一行：只读打开（pdf 走应用内翻页浮层，其余交系统默认程序） */
        openOriginal: (rel) => rsOpenOriginal(rel),
        /* 版本组：与顶栏金色 chip / 扩散共用同一份 store（树只读它判绿 / 金） */
        versions: rsVersions(),
        /* 树上多选后的「生成所选变体」：按版本组展开 → research-derive.js 的 openMany → enqueue */
        generateMany: (paths) => rsDeriveMany(paths),
        /* 树上右键「扩散到其他版本…」：面板与串行写盘都在 research-derive.js */
        spread: (path) => rsDeriveSpread(path),
        /* 树上右键「生成演示…」：编辑器 + 落盘 + 派单都在本文件的「演示」一段 */
        slides: (path) => rsSlidesOpen(path),
        canSlides: () => rsSlidesCanOpen(),
        /* 被改过的版本没有「还原」入口：冲突只在平铺条的「变体一致化」里解（基准＝改动量最大的那一版） */
        multiChanged: () => rsMultiChanged(),
        /* 树上删掉一篇之后：被删的名字如果还被人用 [[…]] 写着，那些就是断链 ——
           由宿主列成一张清单让用户选保留 / 删除（树只把「删了什么、删前是什么」交过来） */
        afterRemove: async (o) => {
          if (!o || !o.before) return;
          try {
            const parsed = C().parseNote({ path: o.path, md: o.before });
            const note = (parsed && parsed.note) || {};
            const names = [note.label].concat(Array.isArray(note.aliases) ? note.aliases : []);
            await rsDeadOpen(names, o.path);
          } catch (_) {}
        },
        logChange: (kind, rel, before, after) => logChange(kind, rel, before, after),
        noteBadge: (n) => (noteInitDone(n, initDoneRels()) ? initDoneBadge() : null),
        reload: async () => {
          await rsLoadNotes();
          await rsLoadFolds();
          /* 树上删掉的是当前打开的那一篇：编辑器要跟着让位，别继续挂着已删掉的正文 */
          const known =
            (RS.notes || []).some((n) => n.path === RS.curPath) ||
            (RS.folds || []).some((f) => f.path === RS.curPath);
          if (RS.curPath && !known) {
            RS.curPath = "";
            RS.md = "";
            RS.foldPath = "";
            renderEditor();
          }
          renderSide();
        },
      });
    }
    return rsTreeInst;
  }
  /* 绝对路径判据（原件 frontmatter 的 origin 既有相对 research/ 的，也可能被写成绝对路径） */
  function rsIsAbsPath(p) {
    const s = String(p == null ? "" : p).trim();
    return /^[a-zA-Z]:[\\/]/.test(s) || /^\\\\/.test(s) || s.charAt(0) === "/";
  }
  /* 打开一份**原件**（只读）：.pdf 走应用内只读翻页浮层（window.openPdfPreview），
     其它类型交系统默认程序（api.shellOpenPath）。原件永远不改 —— 这条通路里没有编辑入口。 */
  async function rsOpenOriginal(rel) {
    const p = String(rel == null ? "" : rel).trim();
    if (!p) return;
    if (!rsIsAbsPath(p) && !RS.root) return;
    const abs = rsIsAbsPath(p) ? p : joinP(RS.root, p);
    const name = abs.slice(Math.max(abs.lastIndexOf("/"), abs.lastIndexOf("\\")) + 1);
    if (/\.pdf$/i.test(abs) && typeof window.openPdfPreview === "function") {
      window.openPdfPreview(abs, { title: name });
      return;
    }
    const apiNow = window.api;
    if (!apiNow || typeof apiNow.shellOpenPath !== "function") {
      toastSafe(t("打开失败（没有系统打开通道）：") + abs, "err");
      return;
    }
    try {
      const r = await apiNow.shellOpenPath(abs);
      if (r && r.ok === false) toastSafe(t("打开失败：") + ((r && r.error) || abs), "err");
    } catch (e) {
      toastSafe(t("打开失败：") + String((e && e.message) || e), "err");
    }
  }
  /* 右键「在文件管理器打开」：shell:showItem 负责选中这个文件；目标已不在时它会退到父目录 */
  async function rsRevealInFolder(rel) {
    const s = String(rel == null ? "" : rel).trim();
    const abs = rsIsAbsPath(s) ? s : joinP(RS.root, s);
    try {
      const r = window.api && window.api.shellShowItem ? await window.api.shellShowItem(abs) : null;
      if (r && r.ok) return;
      toastSafe(t("打开失败：") + ((r && r.error) || abs), "err");
    } catch (e) {
      toastSafe(t("打开失败：") + String((e && e.message) || e), "err");
    }
  }
  /* 左栏「核心」「资料」两页顶上的搜索行：关键词存 RS.sideFilter[role]（跟视图走），
     过滤动作各页自己接 —— 核心页交给内容树重画，资料页直接筛行。 */
  function rsSideSearch(role, onInput) {
    const row = el("div", "side-search");
    const inp = el("input", "side-search-in");
    inp.type = "search";
    inp.value = (RS.sideFilter && RS.sideFilter[role]) || "";
    inp.placeholder = t("搜索…");
    inp.title = role === "core" ? t("按标题 / 路径 / 章节标题筛内容树") : t("按题名 / 作者 / 引用键筛文献与折叠");
    inp.setAttribute("aria-label", inp.title);
    inp.oninput = () => {
      if (!RS.sideFilter) RS.sideFilter = { core: "", refs: "" };
      RS.sideFilter[role] = inp.value;
      if (onInput) onInput(inp.value);
    };
    /* Esc：清空关键词（再按一次回到完整列表），不往上冒给树的快捷键 */
    inp.onkeydown = (ev) => {
      if (ev.key !== "Escape") return;
      ev.stopPropagation();
      if (!inp.value) return;
      inp.value = "";
      inp.oninput();
    };
    row.appendChild(inp);
    return row;
  }

  /* ── 左栏「核心」页 = 「＋ 创建原文」+ 原文列表 ──
     这一页只放两样东西：一颗新建原文的按钮，和下面一张原文列表（内容树的「原文」分组）。
     搜索行 / 「＋ 衍生」/「转为图谱」都已移除 —— 图谱入口挪到顶栏刷新右边（见 rsViewIcons）。
     画的是应用左栏的 #sideCore：研究视图自己不再有内部左栏，切页由
     app-sidebar-files.js 的 sfSetTab 调 MTResearch.paintSide 进来。 */
  function renderSide() {
    const side = qid("sideCore");
    if (!side) return;
    const pane = qid("researchPane");
    if (!pane || pane.style.display === "none") return;
    side.innerHTML = "";
    bindPanelDrop(side, "core");
    /* 搜索框已从这里移除：清掉内存里留着的关键词，免得树还按上一次的词只画命中项 */
    if (RS.sideFilter) RS.sideFilter.core = "";
    const tools = el("div", "rs-side-tools");
    const newBtn = el("button", "rs-btn", "＋ " + t("创建原文"));
    newBtn.title = t("在 notes/ 下新建一篇 Markdown 原文");
    newBtn.onclick = () => rsNewNote();
    tools.appendChild(newBtn);
    side.appendChild(tools);
    const tree = rsTree();
    if (tree) {
      tree.render(side);
      return;
    }
    side.appendChild(el("div", "rs-empty", t("内容树模块没加载（renderer/app-research-tree.js）")));
  }
  /* 往左栏「核心 / 资料」页拖文件 = 打开「＋ 添加内容」对话框并预填这批路径：
     拖拽解析仍走投料台同一条通道（MTResearchInit.pathsFromDrop），不另抄一份；
     核心页拖进来的默认当「核心文件」，资料页默认当「参考资料」。
     用户在对话框里还能补网址 / 写指示，确认后由 rsAddHandoff 一次性交给投料台执行
     （见 rsAddContent）。没有工作目录时由 rsAddContent 统一提示，这里不重复报。
     两个入口共用它：面板空白处、以及左栏那两颗 Tab（拖到 Tab 上也照样算投到那一页）。 */
  function dropIntoPanel(role, dt) {
    const ini = window.MTResearchInit;
    if (!ini || typeof ini.pathsFromDrop !== "function") return;
    const paths = ini.pathsFromDrop(dt);
    if (!paths.length) return;
    const r = role === "core" ? "core" : "ref";
    rsAddContent({ files: paths.map((p) => ({ path: p, role: r })) });
  }
  function bindPanelDrop(host, role) {
    if (!host || host.__rsDropBound) return;
    host.__rsDropBound = "1";
    const hasFiles = (dt) => {
      try {
        return !!dt && Array.prototype.indexOf.call(dt.types || [], "Files") >= 0;
      } catch (_) {
        return false;
      }
    };
    /* 拖拽提示：整块边栏泛一圈虚线 + 居中「拖入文件」（平时不占位，静态提示行已移除）。
       进出子元素都会冒 dragleave，故按 enter / leave 计数，别让虚线一闪一闪。 */
    let depth = 0;
    const mark = (on) => {
      host.classList.toggle("sf-drop-on", !!on);
      /* 虚线框画在整条左栏上（不是只有内容区那一块） */
      const bar = qid("sidebar");
      if (bar) bar.classList.toggle("rs-drop-on", !!on);
      let ov = host.querySelector(":scope > .side-drop-overlay");
      if (!on) {
        if (ov && ov.parentNode) ov.parentNode.removeChild(ov);
        return;
      }
      if (ov) return;
      ov = el("div", "side-drop-overlay");
      ov.appendChild(el("span", "side-drop-overlay-t", t("拖入文件")));
      host.appendChild(ov);
    };
    host.addEventListener("dragenter", (ev) => {
      if (!hasFiles(ev.dataTransfer)) return;
      ev.preventDefault();
      depth++;
      mark(true);
    });
    host.addEventListener("dragover", (ev) => {
      if (!hasFiles(ev.dataTransfer)) return;
      ev.preventDefault();
      try {
        ev.dataTransfer.dropEffect = "copy";
      } catch (_) {}
      mark(true);
    });
    host.addEventListener("dragleave", () => {
      depth = Math.max(0, depth - 1);
      if (!depth) mark(false);
    });
    host.addEventListener("drop", (ev) => {
      if (!hasFiles(ev.dataTransfer)) return;
      ev.preventDefault();
      depth = 0;
      mark(false);
      dropIntoPanel(role, ev.dataTransfer);
    });
    /* 拖着文件离开窗口 / 在别处松手时不会有配对的 dragleave：兜底收回虚线框 */
    window.addEventListener("dragend", () => {
      depth = 0;
      mark(false);
    });
    document.addEventListener("drop", () => {
      depth = 0;
      mark(false);
    }, true);
  }

  /* ── 编辑器 ── */
  /* 工具条：顶栏这一截只剩「折叠文件的层级切换」（第 2 / 3 层只读，那一层回显「只读」）。
     编辑按钮已挪到平铺条右端、正文字号左边（rsTailTools → rsEditBtn），
     「已保存 / 未保存」仍收在那颗钮右上角的小圆点 + title 里。 */
  function renderToolbar() {
    const bar = RS.toolbarEl;
    if (!bar) return;
    bar.innerHTML = "";
    RS.editBtn = null;
    const isFold = !!RS.curPath && !!RS.foldPath && RS.foldPath === RS.curPath;
    if (!isFold) {
      /* 不是折叠文件：顶栏这一截整个不出现（编辑按钮在平铺条里，由 renderReadTools 建） */
      bar.classList.add("hide");
      if (bar.parentNode) bar.parentNode.removeChild(bar);
      return;
    }
    bar.classList.remove("hide");
    const slot = RS.toolSlotEl;
    if (slot && bar.parentNode !== slot) slot.appendChild(bar);
    /* 三层折叠的层级切换：1 全文（可改）/ 2 关键原句 / 3 主题（只读投影） */
    const seg = el("div", "rs-fold-levels");
    for (const lv of C().FOLD_LEVELS) {
      const b = el(
        "button",
        "rs-tool" + (RS.foldLevel === lv.n ? " on" : ""),
        lv.n + " " + t(lv.label),
      );
      b.title =
        lv.n === 1
          ? t("全文层：作者原文，可编辑（源码）")
          : t("只读投影：从全文折出来的第 ") + lv.n + t(" 层");
      b.onclick = () => {
        RS.foldLevel = lv.n;
        /* 一律进阅读态：第 1 层的源码编辑走「编辑」按钮，切层不再顺带把源码摊开 */
        RS.editorMode = "read";
        if (lv.n === 1) rsSecLoad();
        renderEditor();
      };
      seg.appendChild(b);
    }
    bar.appendChild(seg);
    if (RS.foldLevel > 1) bar.appendChild(el("span", "rs-saved", t("只读")));
    /* 节级三级粒度：全篇一根滑档（每节可在卡片右上角单独钉住）。
       只在这一层（全文层）有意义：第 2 / 3 层是段落级投影，与节级切档互不覆盖。 */
    if (RS.foldLevel === 1) {
      const model = C().parseFolds(RS.md || "");
      if ((model.sections || []).length) {
        const sseg = el("div", "rs-sec-levels");
        for (const lv of C().SEC_LEVELS) {
          const on = (RS.secLevel || "para") === lv.key;
          const b = el("button", "rs-tool" + (on ? " on" : ""), t(lv.label));
          b.dataset.lv = lv.key;
          b.title = on
            ? t("全篇现在按「") + t(lv.label) + t("」读")
            : t("全篇切到「") + t(lv.label) + t("」；已单独钉住的节不受影响");
          b.onclick = () => {
            RS.secLevel = lv.key;
            void rsSecSave();
            /* 就地切：不整页重画（阅读位置不跳），所以按钮的选中态得自己跟上 */
            paintSecLevels();
            if (!rsSecApplyLocal()) renderEditor();
          };
          sseg.appendChild(b);
        }
        bar.appendChild(sseg);
        bar.appendChild(el("span", "rs-sec-tip", t("每节右上角可单独钉住")));
      }
    }
  }

  /* 编辑按钮（源码 ⇄ 阅读）：正文真源就是源码，直接写比插模板准；
     撤销 / 重做不出按钮，快捷键照旧（Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y）。
     位置在平铺条右端、正文字号左边（见 renderReadTools 的 rsTailTools）。 */
  function rsEditBtn() {
    const editing = RS.editorMode === "edit";
    const btn = el("button", "rs-tool ico rs-edit-btn" + (editing ? " on" : ""), "");
    btn.type = "button";
    btn.appendChild(rsIcon(editing ? "done" : "edit"));
    btn.appendChild(el("i", "rs-tool-dot"));
    btn.onclick = () => {
      RS.md = readEditorMd();
      RS.editorMode = editing ? "read" : "edit";
      renderEditor();
      if (RS.srcEl) RS.srcEl.focus();
    };
    RS.editBtn = btn;
    rsSetSaveState(RS.dirty ? "dirty" : "saved");
    return btn;
  }

  /* 保存状态（原「已保存 / 未保存…」那段文字）：收进编辑按钮 ——
     .dirty 橙点 = 有改动没落盘，.warn 红点 = 被写入门闸拒了；title 里带完整措辞。 */
  function rsSetSaveState(kind) {
    RS.saveState = kind === "dirty" || kind === "cancelled" ? kind : "saved";
    /* 就地编辑中：保存态只回显底栏（正文不能重渲染，圆点照样亮） */
    if (RS.inlineOn) rsInlinePaint(RS.saveState);
    const b = RS.editBtn;
    if (!b) return;
    const txt =
      RS.saveState === "dirty"
        ? t("未保存…")
        : RS.saveState === "cancelled"
          ? t("未保存（已取消写入）")
          : t("已保存");
    b.classList.toggle("dirty", RS.saveState === "dirty");
    b.classList.toggle("warn", RS.saveState === "cancelled");
    const base =
      RS.inlineOn
        ? t("正文就地编辑：直接改 Markdown，Esc 退出")
        : RS.editorMode === "edit"
          ? t("收起源码，回到渲染后的阅读态")
          : t("编辑 Markdown 源码：左边源码、右边实时预览");
    b.title = base + " · " + txt;
    b.setAttribute("aria-label", base + " · " + txt);
  }

  /* 正文 ⇄ 富文本：**frontmatter 不参与往返**。
     为什么：mdToRichHtml / richToMarkdown 是通用 Markdown 转换器，把 `---` 之间的 YAML 当正文
     排版，回来时标题就变成了 `## title: "..."`、行尾多出硬换行 —— 真机里一跳就把文件的
     frontmatter 改坏（title / tags / verify 全丢）。这里把头部原样切出来、只转正文，
     写回时再原样拼回去；要改 frontmatter 请切「源码」档。 */
  function splitFm(md) {
    const src = String(md || "");
    const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(src);
    if (!m) return { head: "", body: src };
    return { head: m[0].replace(/\r?\n$/, ""), body: src.slice(m[0].length) };
  }
  function joinFm(head, body) {
    const b = String(body || "").replace(/^\s*\n/, "");
    if (!head) return b;
    return head + "\n\n" + b;
  }

  /* ── 节级三级粒度（一句话 / 一段话 / 原文）──
     设计参考 TextFold：**折叠而不是摘要** —— 同一节留三档，切档是就地换一层，不是跳去另一页。
     真源在折叠文件的 frontmatter（secLevel = 全篇档、secPins = 每节钉住），正文一个字节不动。
     切档不写 changes.jsonl：这是「这一篇读到哪一档」的视图状态，不是内容改动；
     塞进撤销栈只会让人在真改内容时按到一堆读档记录。 */
  function rsSecLoad() {
    const Cc = C();
    if (!Cc || typeof Cc.foldSectionState !== "function") return;
    const st = Cc.foldSectionState(RS.md || "");
    RS.secLevel = st.level || "para";
    RS.secPins = st.pins || {};
  }
  async function rsSecSave() {
    const Cc = C();
    if (!Cc || typeof Cc.withFoldSectionState !== "function") return;
    if (!RS.curPath || !RS.root || !window.api || typeof window.api.fileWriteText !== "function") return;
    const next = Cc.withFoldSectionState(RS.md || "", RS.secLevel || "para", RS.secPins || {});
    if (next === RS.md) return;
    RS.md = next;
    RS.dirty = false;
    try {
      await window.api.fileWriteText(joinP(RS.root, RS.curPath), next);
    } catch (_) {
      return;
    }
    const rec = (RS.folds || []).find((f) => f.path === RS.curPath);
    if (rec) rec.md = next;
    rsSetSaveState("saved");
  }
  /* 切档后**就地**换每一节的内容（带折叠动效）；没有可复用的卡片时退回整页重画 */
  function rsSecApplyLocal() {
    const host = RS.selHost;
    if (!host || typeof host.querySelectorAll !== "function") return false;
    const Cc = C();
    if (!Cc || typeof Cc.sectionCards !== "function") return false;
    const model = Cc.parseFolds(RS.md || "");
    const cards = Cc.sectionCards(model, { level: RS.secLevel, pins: RS.secPins });
    const byId = new Map(cards.map((c) => [c.id, c]));
    const secs = host.querySelectorAll(".rs-sec");
    let any = false;
    for (const sec of secs) {
      const c = byId.get(sec.dataset.secId);
      if (!c) continue;
      any = true;
      const sel = sec.querySelector(".rs-sec-sel");
      if (sel) sel.value = (RS.secPins || {})[c.id] || "";
      const head = sec.querySelector(".rs-sec-head");
      const miss = sec.querySelector(".rs-sec-miss");
      if (c.fellBack && head && !miss) {
        const m = el("span", "rs-sec-miss", t("缺这一档，显示原文"));
        m.title = t("这一节还没有「") + labelOf(c.level) + t("」稿：先显示原文，不显示一张空卡");
        head.appendChild(m);
      } else if (!c.fellBack && miss && miss.parentNode) {
        miss.parentNode.removeChild(miss);
      }
      if (typeof sec.__setLevel === "function") sec.__setLevel(c.text);
    }
    return any;
  }
  /* 切某一档：secId 为空 = 改全篇档；给了 secId = 钉住 / 解除钉住这一节 */
  function rsSecSet(lv, secId) {
    const key = String(lv || "").trim();
    if (secId) {
      const pins = Object.assign({}, RS.secPins || {});
      if (key) pins[secId] = key;
      else delete pins[secId];
      RS.secPins = pins;
    } else {
      RS.secLevel = key || "para";
    }
    void rsSecSave();
    if (!rsSecApplyLocal()) renderEditor();
  }
  /* 全篇档位按钮的选中态与提示：就地切档（不整页重画）时靠它跟上，
     别让「按钮说的是这一段话、正文已经是原文」。 */
  function paintSecLevels() {
    const seg = document.querySelector(".rs-sec-levels");
    if (!seg) return;
    const cur = RS.secLevel || "para";
    for (const b of seg.querySelectorAll("button")) {
      const on = b.dataset.lv === cur;
      b.classList.toggle("on", on);
      const label = labelOf(b.dataset.lv);
      b.title = on
        ? t("全篇现在按「") + label + t("」读")
        : t("全篇切到「") + label + t("」；已单独钉住的节不受影响");
    }
  }
  /* 折叠文件的阅读态正文：一节一张卡，卡头写锚点 + 这一节自己的档位，卡身按档渲染。
     没有节级区（旧折叠 / 手写文件）返回 false，落回原来的整篇全文渲染。 */
  function rsRenderSections(body) {
    const Cc = C();
    if (!Cc || typeof Cc.sectionCards !== "function") return false;
    const model = Cc.parseFolds(RS.md || "");
    const cards = Cc.sectionCards(model, { level: RS.secLevel, pins: RS.secPins });
    if (!cards.length) return false;
    const host = el("div", "rs-rich rs-read rs-secs");
    const levels = Cc.SEC_LEVELS || [];
    for (const c of cards) {
      const sec = el("section", "rs-sec is-in");
      sec.dataset.secId = c.id;
      const head = el("div", "rs-sec-head");
      head.appendChild(el("h2", "rs-sec-t", c.anchor || c.id));
      /* 这一节的档位：空 = 跟随全篇。原生 select 在深色主题里也稳，且键盘可达。 */
      const sel = el("select", "rs-sec-sel");
      sel.title = t("这一节的粒度：默认跟随全篇，选了就单独钉住");
      const op0 = el("option", null, t("跟随全篇"));
      op0.value = "";
      sel.appendChild(op0);
      for (const lv of levels) {
        const op = el("option", null, t(lv.label));
        op.value = lv.key;
        sel.appendChild(op);
      }
      sel.value = (RS.secPins || {})[c.id] || "";
      sel.onchange = () => rsSecSet(sel.value, c.id);
      head.appendChild(sel);
      if (c.fellBack) {
        const miss = el("span", "rs-sec-miss", t("缺这一档，显示原文"));
        miss.title = t("这一节还没有「") + t(labelOf(c.level)) + t("」稿：先显示原文，不显示一张空卡");
        head.appendChild(miss);
      }
      sec.appendChild(head);
      const foldBox = el("div", "rs-sec-fold");
      const inner = el("div", "rs-sec-inner");
      inner.innerHTML = renderMarkdown(c.text || "—");
      decorateCallouts(inner);
      rsJoinSoftBreaks(inner);
      rsResolveImgs(inner);
      foldBox.appendChild(inner);
      sec.appendChild(foldBox);
      /* TextFold 的折叠动效：切档时这块先收起来（grid 行高 1fr → 0fr + 透明度），
         换完内容再展开 —— 不是整页重画，读的人视线停在原地。 */
      sec.__setLevel = (text) => {
        foldBox.classList.add("is-swapping");
        window.setTimeout(() => {
          inner.innerHTML = renderMarkdown(text || "—");
          decorateCallouts(inner);
          rsJoinSoftBreaks(inner);
          rsResolveImgs(inner);
          foldBox.classList.remove("is-swapping");
        }, 180);
      };
      host.appendChild(sec);
    }
    body.appendChild(host);
    rsBuildOutline(null);
    RS.curEl = null;
    RS.srcEl = null;
    RS.previewEl = null;
    RS.selHost = host;
    return true;
  }
  function labelOf(key) {
    const hit = (C().SEC_LEVELS || []).find((x) => x.key === key);
    return hit ? t(hit.label) : key;
  }

  /* 查找条开着时，任何一次重渲染之后都要重新遍历正文并重新计数（换页 / 切模式 / 替换落盘） */
  function renderEditor() {
    /* 图点开大图的那一次绑定：整页共用一个委托，第一次渲染时装上就够（幂等） */
    rsBindPeleZoom();
    rsRenderEditor();
    rsFindSync();
    /* 批注（栏 / 卡片 / 正文高亮）：换篇、换折叠档、切态都从这里统一收浮层并重画 */
    rsAnnoSync();
  }
  function rsRenderEditor() {
    renderToolbar();
    renderReadTools();
    /* 换笔记 / 换层级 / 换模式：面包屑按导航路径重画（章与节由阅读器回调刷新） */
    rsCrumbsPaint();
    const body = RS.bodyEl;
    if (!body) return;
    /* 选区右键菜单（复制 / 创建链接 / 剪切）的委托挂在这里：阅读态的正文与编辑态的预览
       都在 body 里，阅读器只在自己的 `.rs-rich` 宿主内生效，幂等（挂过就不再挂）。 */
    const Rctx = rsReader();
    if (Rctx && typeof Rctx.bindContextMenu === "function") Rctx.bindContextMenu(body);
    body.innerHTML = "";
    /* 这一次重画要不要就地编辑面：先取快照，再把状态收回 ——
       只有真正挂上编辑面时 rsInlineMount 才把它置回 true（源码态 / 只读投影不会误以为还在编辑）。 */
    const inlineNow = !!RS.inlineOn;
    RS.inlineOn = false;
    /* 重画正文 = 上一块编辑面已经不在了：指针清掉，底栏先收起（真要就地编辑时 rsInlineMount 再亮） */
    RS.inlineEl = null;
    if (RS.inlineBarEl) RS.inlineBarEl.hidden = true;
    if (!RS.curPath) {
      RS.curEl = null;
      RS.srcEl = null;
      body.appendChild(el("div", "rs-empty", t("左侧选一篇笔记，或新建一篇")));
      rsBuildOutline(null);
      return;
    }
    const isFold = !!RS.foldPath && RS.foldPath === RS.curPath;
    /* 折叠的第 2 / 3 层是**只读投影**（共识）：这一层是 AI 折出来的，改它就跟原文对不上了，
       要改就切回「1 全文」——那是这份文件的唯一真源。 */
    if (isFold && RS.foldLevel > 1) {
      const wrap = el("div", "rs-rich rs-fold-ro");
      wrap.innerHTML = renderMarkdown(C().foldView(RS.md, RS.foldLevel));
      decorateCallouts(wrap);
      rsJoinSoftBreaks(wrap);
      body.appendChild(wrap);
      rsBuildOutline(null);
      body.appendChild(
        el(
          "div",
          "rs-fold-hint",
          t("第 ") +
            RS.foldLevel +
            t(" 层是只读的（折叠出来的投影）：要改内容，切回「1 全文」层编辑。"),
        ),
      );
      RS.curEl = null;
      RS.srcEl = null;
      return;
    }
    /* 折叠文件 · 全文层的阅读态：按节切三档（一句话 / 一段话 / 原文）。
       文件里还没有「# 节级三档」区（旧折叠 / 手写文件）→ rsRenderSections 返回 false，
       下面照原样按整篇 Markdown 渲染，不改变旧文件的表现。 */
    if (isFold && RS.foldLevel === 1 && !inlineNow && RS.editorMode !== "edit") {
      if (rsRenderSections(body)) return;
    }
    /* 编辑态（笔记与折叠文件的全文层共用）：左边源码、右边实时预览。
        富文本往返会把 ```mermaid / `**全文**` 这类标记改坏，所以源码是真源、预览只是投影。 */
    if (RS.editorMode === "edit") {
      const split = el("div", "rs-split");
      const ta = el("textarea", "rs-src");
      ta.value = RS.md;
      ta.spellcheck = false;
      ta.oninput = () => {
        RS.md = ta.value;
        RS.dirty = true;
        rsSetSaveState("dirty");
        rsSchedulePreview();
        rsScheduleSave();
      };
      /* Tab 也当缩进用：源码态里 Tab 默认会把焦点跳到下一个控件，写 markdown 时很难受 */
      ta.onkeydown = (ev) => {
        if (ev.key === "Tab") {
          ev.preventDefault();
          rsInsertRaw("\t");
        }
        if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "s") {
          ev.preventDefault();
          rsSaveCurrent();
        }
      };
      /* 光标一动（方向键 / 点选 / 拖选 / 聚焦）→ 右侧预览跟到对应那一段并把它标出来。
         rsSyncFromCursor 幂等，多挂几个事件只是为了让「任何一次光标移动」都覆盖到；
         打字那条路走 rsSchedulePreview（重渲染之后再同步，见那边）。 */
      const syncCursor = () => rsSyncFromCursor();
      ta.addEventListener("keyup", syncCursor);
      ta.addEventListener("mouseup", syncCursor);
      ta.addEventListener("click", syncCursor);
      ta.addEventListener("select", syncCursor);
      ta.addEventListener("focus", syncCursor);
      const prev = el("div", "rs-rich rs-preview");
      prev.innerHTML = renderMarkdown(splitFm(RS.md).body);
      decorateCallouts(prev);
      rsJoinSoftBreaks(prev);
      rsResolveImgs(prev);
      split.appendChild(ta);
      split.appendChild(prev);
      body.appendChild(split);
      rsBuildOutline(null);
      RS.srcEl = ta;
      RS.previewEl = prev;
      /* 换了预览层：块映射与上一处标记一起作废（旧元素已经被 body.innerHTML 丢掉了） */
      previewGen++;
      srcSyncCache = null;
      srcSyncHl = null;
      RS.curEl = null;
      RS.selHost = null;
      return;
    }
    /* 索引页（corePath）默认**不是**一篇 Markdown 文档，而是一张原文在前的仪表盘：
       课题头卡（标题 + 核心问题 + 问题清单，三块一张卡）→ 标签页（原文 / 论断 / 概念 / 方法 /
       问题，默认原文，点一下换下方卡片区）→ 卡片（至少五行，单张占满）。
       衍生物并进原文那张卡，只在点开之后于页面内切换。
       「原文」只切这一篇的阅读形态（RS.indexMode），不动文件、不改 frontmatter。 */
    if (rsIsIndexPage(RS.curPath)) {
      /* 索引页重画：先把这一页的浮空卡收起来（展开态不记忆，重画即回到干净态） */
      rsIndexCardsHide();
      const I = rsIndexDash();
      if (I) {
        const host = el("div", "rs-idx");
        body.appendChild(host);
        const idxOpts = rsIndexOpts();
        I.renderHead(host, idxOpts);
        if (RS.indexMode !== "raw") {
          I.renderBody(host, idxOpts);
          /* 卡片态没有正文可供批注 / 查词，也没有章节：阅读态那套增强全部让位 */
          RS.curEl = null;
          RS.srcEl = null;
          RS.previewEl = null;
          RS.selHost = null;
          rsBuildOutline(null);
          rsResetProgress();
          return;
        }
        /* 原文态：页头之下照旧是 Markdown 阅读态（大纲 / 编号公式 / callout 一个不少）。
           容器挂在 host 里，页头与正文一起居中，宽度口径不跳。 */
        const ro = el("div", "rs-rich rs-read rs-idx-raw");
        ro.innerHTML = renderMarkdown(splitFm(RS.md).body);
        decorateCallouts(ro);
        rsResolveImgs(ro);
        host.appendChild(ro);
        rsDecorateReading(ro);
        RS.curEl = null;
        RS.srcEl = null;
        RS.previewEl = null;
        RS.selHost = ro;
        bindEditorKeys(ro);
        return;
      }
    }
    /* 阅读态（默认）：渲染后的 Markdown。双击正文 = 就地编辑（contenteditable 开在这块上，
       见下面的 rsInlineMount）—— 只有这条编辑面会走「富文本 → Markdown」的往返，且只替换
       splitFm 之后的正文段；只读面照旧不进 DOM 往返，选中文字照样能批注 / 询问。 */
    const ed = el("div", "rs-rich rs-read");
    /* 就地编辑面：```mermaid / ```pele **不做** SVG 替换（保留 <pre><code class="language-…">），
       否则 richToMarkdown 只读得到 SVG 里的散字、围栏与语言标记全丢；退出编辑态再按 SVG 重渲染。 */
    ed.innerHTML = renderMarkdown(splitFm(RS.md).body, inlineNow ? { rawFences: true } : null);
    decorateCallouts(ed);
    rsResolveImgs(ed, { fig: !inlineNow });
    body.appendChild(ed);
    if (inlineNow) {
      /* 编辑面不挂阅读器那套装饰（公式编号 / callout 抬头）：那些都是**投影**，
         richToMarkdown 只认得出文字，`[!claim]` 的记号会被当场吃掉。
         双链 `[[译名]]` 例外：它回写可逆（rsInlineMd 按 data-wl 还原成 `[[…]]`，与引用梗同一口径），
         所以编辑面里照样收成链接 —— 否则一进就地编辑，正文里所有术语都变回 `[[序列转导]]` 这种源码。
         链接在编辑面里只作显示：点了只放光标，不跳篇（见 research-reader.js 的 click 分支）。 */
      ed.dataset.rsInline = "1";
      rsDecorateInlineLinks(ed);
      rsJoinSoftBreaks(ed);
      rsBuildOutline(ed);
      rsInlineMount(ed);
    } else {
      rsDecorateReading(ed);
    }
    RS.curEl = null;
    RS.srcEl = null;
    RS.previewEl = null;
    RS.selHost = ed;
    bindEditorKeys(ed);
    /* 双击正文 = 进就地编辑（在公式 / 图片 / 围栏块 / 链接上的双击不算：那些有自己的点击行为） */
    if (!inlineNow) {
      ed.addEventListener("dblclick", (ev) => {
        const tgt = ev.target && ev.target.nodeType === 1 ? ev.target : null;
        if (tgt && tgt.closest(".rv-math, .katex, .rs-eq, .rs-term, .rs-wl, .rs-cite, pre, img, .rs-fig, a, table")) return;
        let block = tgt;
        while (block && block.parentNode && block.parentNode !== ed) block = block.parentNode;
        ev.preventDefault();
        rsInlineEnter(block && block.parentNode === ed ? block : null);
      });
    }
  }

  /* ── 正文就地编辑（Markdown 直接改）──
   * 进：双击正文（公式 / 图片 / 围栏块上的双击不触发）；出：Esc、底栏「完成」，或底栏「源码态」。
   * 口径：
   *   · contenteditable 开在 .rs-read 上，公式 / 图片 / 围栏块（mermaid、代码）子块一律
   *     contenteditable=false —— KaTeX 与 SVG 里再打进字，式子当场就烂了；
   *   · 打字只记账（脏标记 + 底栏），debounce 后 richToMarkdown → **只替换 splitFm 之后的正文段**
   *     → rsSaveCurrent 落盘（写入闸 / changes.jsonl / 图谱增量一个不少）；
   *   · 编辑中不重渲染（一渲染光标就被打回块首），保存态只回显底栏；
   *   · Esc 退出并重渲染（围栏恢复成 SVG）；源码态（左源码 + 右预览）本身没有改动。 */
  let inlineTimer = null;
  let inlinePending = null; /* {idx, top}：进来时点的是第几块，重渲染后把光标放回它开头 */

  /* 底栏：编辑中才有（挂在 .rs-editor-wrap 末尾，正文区下面一行）——左边说「在就地编辑」，
     中间是保存态，右边两颗：源码态 / 完成。它只回显状态，不参与渲染。 */
  function rsInlineBar() {
    let bar = RS.inlineBarEl;
    if (bar && bar.isConnected) return bar;
    bar = el("div", "rs-inline-bar");
    bar.hidden = true;
    const name = el("span", "rs-inline-bar-t", t("正文就地编辑"));
    name.title = t("正文就地编辑：直接改 Markdown，Esc 退出");
    const st = el("span", "rs-inline-bar-s", t("已保存"));
    const src = el("button", "rs-inline-bar-btn", t("源码态"));
    src.type = "button";
    src.title = t("切到源码态（左边源码、右边实时预览）");
    src.onclick = () => rsInlineExit({ toSource: true });
    const done = el("button", "rs-inline-bar-btn is-done", t("完成"));
    done.type = "button";
    done.title = t("退出就地编辑（Esc），按阅读态重新渲染");
    done.onclick = () => rsInlineExit();
    bar.appendChild(name);
    bar.appendChild(st);
    bar.appendChild(src);
    bar.appendChild(done);
    RS.inlineBarEl = bar;
    RS.inlineBarStateEl = st;
    if (RS.editorWrap) RS.editorWrap.appendChild(bar);
    return bar;
  }
  function rsInlinePaint(state) {
    const bar = RS.inlineBarEl;
    const st = RS.inlineBarStateEl;
    if (!bar || !st) return;
    const kind = state === "dirty" || state === "cancelled" ? state : "saved";
    bar.classList.toggle("is-dirty", kind === "dirty");
    bar.classList.toggle("is-cancelled", kind === "cancelled");
    st.textContent =
      kind === "dirty" ? t("未保存…") : kind === "cancelled" ? t("未保存（已取消写入）") : t("已保存");
  }

  /* 就地编辑态里的点击命中：contenteditable 会把正文里所有点击吃掉（点 `[[…]]` 不跳、
     点外链不打开），用户看到的就是「正文里所有链接都失效」。
     这里只做**认位置**：先看是不是点在 <a href> 上，再看点击点落在哪个文本节点的
     `[[双链]]` 里（caretPositionFromPoint / caretRangeFromPoint，两者都没有就放弃）。 */
  function rsInlineLinkAt(ev, ed) {
    let node = null;
    let off = -1;
    try {
      if (document.caretPositionFromPoint) {
        const p = document.caretPositionFromPoint(ev.clientX, ev.clientY);
        if (p) {
          node = p.offsetNode;
          off = p.offset;
        }
      } else if (document.caretRangeFromPoint) {
        const r = document.caretRangeFromPoint(ev.clientX, ev.clientY);
        if (r) {
          node = r.startContainer;
          off = r.startOffset;
        }
      }
    } catch (_) {}
    if (!node || node.nodeType !== 3 || !ed.contains(node)) return null;
    /* 代码块 / 公式里的 `[[` 是内容本身，不是双链 */
    const pEl = node.parentElement;
    if (pEl && pEl.closest && pEl.closest("pre, code, .rv-math, .katex")) return null;
    const s = String(node.nodeValue || "");
    if (s.indexOf("[[") < 0) return null;
    const re = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;
    let m;
    while ((m = re.exec(s))) {
      if (off < m.index || off > m.index + m[0].length) continue;
      const target = String(m[1] || "").trim();
      if (target) return { kind: "wl", target: target };
    }
    return null;
  }
  /* 编辑态点外链：与阅读态同一条出口（http(s) 走内嵌预览窗，mailto 交系统，本机路径走打开对话框） */
  function rsOpenHref(href) {
    const h = String(href || "").trim();
    if (!h) return;
    const api = window.api || null;
    if (/^https?:/i.test(h)) {
      if (api && typeof api.openInAppDialog === "function") {
        api.openInAppDialog({ kind: "url", target: h });
        return;
      }
      if (api && typeof api.openExternal === "function") api.openExternal(h);
      return;
    }
    if (/^mailto:/i.test(h)) {
      if (api && typeof api.openExternal === "function") api.openExternal(h);
      return;
    }
    if (/^file:/i.test(h) || /^[a-zA-Z]:[\\/]/.test(h)) {
      let p = h;
      try {
        p = decodeURIComponent(h.replace(/^file:\/\//i, ""));
        if (/^\/[a-zA-Z]:/.test(p)) p = p.slice(1);
      } catch (_) {}
      if (api && typeof api.openInAppDialog === "function") api.openInAppDialog({ kind: "path", target: p });
    }
  }
  function rsInlineMount(ed) {
    if (!ed) return;
    RS.inlineEl = ed;
    RS.inlineOn = true;
    ed.classList.add("rs-inline");
    ed.setAttribute("contenteditable", "true");
    ed.setAttribute("spellcheck", "false");
    ed.setAttribute("role", "textbox");
    ed.setAttribute("aria-multiline", "true");
    /* 链接照常可点（编辑态本来一个都点不动，就是「所有链接失效」）：
       单击命中 <a href> / `[[双链]]` / 引用梗时先退出编辑面（退出会把正文收回 RS.md 并落盘），
       再按阅读态同一套动作跳。有选区（在拖选文字）时不动 —— 那是在编辑，不是点链接。 */
    ed.addEventListener("click", (ev) => {
      if (!RS.inlineOn || ev.button !== 0) return;
      const sel = window.getSelection ? window.getSelection() : null;
      if (sel && !sel.isCollapsed) return;
      const tgt = ev.target && ev.target.nodeType === 1 ? ev.target : null;
      const a = tgt && tgt.closest ? tgt.closest("a[href]") : null;
      const cite = tgt && tgt.closest ? tgt.closest(".rs-cite") : null;
      let hit = null;
      if (a) hit = { kind: "url", href: String(a.getAttribute("href") || "") };
      else if (cite) hit = { kind: "cite" };
      else hit = rsInlineLinkAt(ev, ed);
      if (!hit) return;
      ev.preventDefault();
      ev.stopPropagation();
      const rect = {
        left: ev.clientX,
        top: ev.clientY,
        right: ev.clientX,
        bottom: ev.clientY,
        width: 0,
        height: 0,
      };
      rsInlineExit();
      if (hit.kind === "url") {
        rsOpenHref(hit.href);
        return;
      }
      if (hit.kind === "wl") {
        if (rsOpenLinkByName(hit.target) === false) rsMissingOpen("term", hit.target, rect);
        return;
      }
      /* 引用梗的浮层由阅读器在阅读态挂（编辑态没有它）：退出编辑面后同一位再点即可 */
      toastSafe(t("已退出就地编辑：再点一次 @引用 查看笔记"));
    });
    /* 子块锁死：公式（KaTeX）/ 图片 / 围栏块是投影，不是可写的文本 */
    ed.querySelectorAll("img, svg, .rv-math, .katex, .katex-display, pre, .rs-eq, .rs-pele-err")
      .forEach((n) => n.setAttribute("contenteditable", "false"));
    ed.addEventListener("input", () => {
      if (!RS.inlineOn) return;
      RS.dirty = true;
      /* 只记账：底栏与编辑按钮上的圆点一起亮，转换与落盘交给下面的 debounce */
      rsSetSaveState("dirty");
      rsScheduleInlineSave();
    });
    /* Esc 退出（捕获阶段：正文里的 Esc 不再往下冒给查找条 / 全局浮层） */
    ed.addEventListener("keydown", (ev) => {
      if (!RS.inlineOn || ev.key !== "Escape") return;
      /* 查找条开着时 Esc 先归它（与阅读态同一口径） */
      if (RS.findEl && !RS.findEl.hidden) return;
      ev.preventDefault();
      ev.stopPropagation();
      rsInlineExit();
    }, true);
    const bar = rsInlineBar();
    bar.hidden = false;
    rsInlinePaint(RS.saveState);
    /* 重渲染把 DOM 整块换掉了：滚回原位，并把光标放到进来时点的那一块开头 */
    const pending = inlinePending;
    inlinePending = null;
    if (pending && RS.bodyEl) RS.bodyEl.scrollTop = pending.top || 0;
    if (pending && pending.idx >= 0) {
      const block = ed.children[pending.idx];
      if (block) {
        try {
          ed.focus({ preventScroll: true });
          const r = document.createRange();
          r.selectNodeContents(block);
          r.collapse(true);
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(r);
        } catch (_) {}
      }
    }
  }
  function rsInlineEnter(blockEl) {
    if (!RS.curPath || RS.inlineOn || RS.editorMode === "edit") return false;
    /* 折叠的第 2 / 3 层是从全文折出来的只读投影：那一层不给就地改 */
    if (RS.foldPath && RS.foldPath === RS.curPath && RS.foldLevel > 1) return false;
    const ed = RS.bodyEl ? RS.bodyEl.querySelector(".rs-rich.rs-read") : null;
    if (!ed) return false;
    inlinePending = { idx: blockEl ? [...ed.children].indexOf(blockEl) : -1, top: RS.bodyEl.scrollTop || 0 };
    RS.inlineOn = true;
    renderEditor();
    return true;
  }
  function rsInlineExit(opts) {
    const o = opts || {};
    if (!RS.inlineOn) return;
    /* 退出前先取一次正文：最后几个字还在 DOM 里，重渲染一刷就没了 */
    const md = rsInlineMd();
    clearTimeout(inlineTimer);
    RS.inlineOn = false;
    RS.inlineEl = null;
    inlinePending = null;
    if (md != null && md !== RS.md) {
      RS.md = md;
      RS.dirty = true;
    }
    if (o.toSource) RS.editorMode = "edit";
    if (RS.inlineBarEl) RS.inlineBarEl.hidden = true;
    renderEditor();
    /* 写入闸刚拒过就别在退出这一下再问一遍：md 已经收回内存，编辑按钮上的告警还在 */
    if (RS.dirty && RS.saveState !== "cancelled") void rsSaveCurrent();
  }
  /* 编辑面 DOM → Markdown：**只替换 splitFm 之后的正文段**（frontmatter 原样留着，只在源码态改）。
     转换口径沿用 app-review.js 的 richToMarkdown，编辑面另补三件事：
       ① 围栏块整块摘出来再放回 —— 它的 <pre> 分支会吃掉 ```lang 的语言标记，也会归一化代码里的空白；
       ② 查找高亮 mark.rs-find 去壳（只留文字）；
       ③ 引用梗 .rs-cite 按 data-cite 还原成 `[@a; @b]`（合软换行时包上的，纸面上只显示 `@a; @b`）；
       ④ 双链 .rs-wl 按 data-wl 还原成 `[[目标]]` / `[[目标|显示名]]`（编辑面里也挂了链接装饰）。
     返回 null = 现在没有编辑面（只读投影 / 源码态 / 转换器没加载），调用方据此保持原样。 */
  function rsInlineMd() {
    const ed = RS.inlineEl;
    if (!ed || !RS.inlineOn) return null;
    if (typeof richToMarkdown !== "function") return null;
    const clone = ed.cloneNode(true);
    const fences = [];
    clone.querySelectorAll("pre").forEach((pre) => {
      const code = pre.querySelector("code") || pre;
      const cls = String(code.getAttribute("class") || "") + " " + String(pre.getAttribute("class") || "");
      const m = /language-([\w+.#-]+)/.exec(cls);
      const src = String(code.textContent || "").replace(/\n$/, "");
      fences.push("```" + (m ? m[1] : "") + "\n" + src + "\n```");
      const ph = document.createElement("p");
      ph.textContent = "\u0003" + (fences.length - 1) + "\u0004";
      pre.parentNode.replaceChild(ph, pre);
    });
    clone.querySelectorAll("mark.rs-find").forEach((n) => n.replaceWith(document.createTextNode(n.textContent || "")));
    clone.querySelectorAll(".rs-cite").forEach((n) => {
      const keys = String(n.dataset.cite || "")
        .split(";")
        .map((k) => k.trim())
        .filter(Boolean);
      const body = keys.length ? keys.map((k) => "@" + k).join("; ") : String(n.textContent || "");
      n.replaceWith(document.createTextNode("[" + body + "]"));
    });
    /* 双链 `.rs-wl` 同理按 data-wl 还原：`[[目标]]`，显示名与目标不同就写回 `[[目标|显示名]]`
       （编辑面里挂了链接装饰，见 rsRenderEditor 的 inlineNow 分支）。 */
    clone.querySelectorAll(".rs-wl").forEach((n) => {
      const target = String(n.dataset.wl || "").trim();
      if (!target) return;
      const label = String(n.textContent || "").trim();
      n.replaceWith(document.createTextNode(label && label !== target ? "[[" + target + "|" + label + "]]" : "[[" + target + "]]"));
    });
    let out = "";
    try {
      out = richToMarkdown(clone);
    } catch (_) {
      return null;
    }
    out = String(out || "").replace(/\u0003(\d+)\u0004/g, (all, i) => fences[Number(i)] || "");
    return joinFm(splitFm(RS.md).head, out);
  }
  /* 输入 debounce：攒一段再转一次（每敲一个字就整篇 richToMarkdown 太贵），落盘走 rsSaveCurrent */
  function rsScheduleInlineSave() {
    clearTimeout(inlineTimer);
    inlineTimer = setTimeout(() => {
      if (!RS.inlineOn) return;
      void rsSaveCurrent();
    }, 800);
  }

  /* ── 批注（局部 / 全文）：阅读面上的批注，**不改 md 正文** ──
   * 与「插入为批注」分工（两个入口的文案要能分开）：那条（rsAnnotate / 框选询问结果里的
   * 「插入为批注」）往 md 里写 `> [!note]` 块、进图谱；这条只落在 research.json 的 annotations
   * 映射（键 = 笔记相对路径，写入走 saveMetaPatch 同一通道），正文一个字不动。
   *   · 局部：拖选正文 →「局部批注」→ 浮空便笺；写入后正文加淡橙虚线下划线，hover 才显到右侧
   *     批注卡的连线，点高亮重开便笺（可改可删）。锚点 = snippet + from/to —— from/to 是**渲染后
   *     正文**的字符偏移（md 一改就对不上），所以正文改动后按 snippet 就近重锚，找不到标「失效」。
   *   · 全文：不绑选段，列在批注栏顶部。
   *   · 批注栏挂在阅读区右侧、可折叠（没有批注时收成一条细栏）；换篇 / 换折叠档 / 切态一律
   *     收浮层并重画（见 rsAnnoSync）。
   * 高亮与连线画在 .rs-main 的叠层上：连线要跨过阅读区右缘接进批注卡，叠层不能放进会裁剪的正文容器。
   */
  /* `svg` 也在跳过名单里：图的标签是 SVG `<text>` 里的字，换行内高亮只能塞 HTML 节点，
     塞进 `<text>` 那一段标签会整块不画（与 reading 层 .rs-pele 的口径一致）。 */
  const RS_ANNO_SKIP = ".katex, .katex-display, .rv-math, .rs-eq-no, script, style, textarea, svg, .rs-anno-float";
  const RS_ANNO_HIT_H = 6; /* 虚线上下各几 px 算「点到这条批注」 */
  const RS_ANNO = { hits: [], eatClick: false };
  let rsAnnoSelHooked = false;
  let rsAnnoPaintRaf = 0;

  function rsAnnoId() {
    return "rn" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }
  /* 盘上那份 annotations 的归一化：坏条目（没正文 / 不是对象）直接丢，键一律当相对路径 */
  function rsAnnoNormalize(map) {
    const out = {};
    if (!map || typeof map !== "object") return out;
    for (const path of Object.keys(map)) {
      const list = Array.isArray(map[path]) ? map[path] : [];
      const keep = [];
      for (const nt of list) {
        if (!nt || typeof nt !== "object") continue;
        const body = String(nt.body == null ? "" : nt.body);
        if (!body.trim()) continue;
        const from = Number(nt.from);
        const to = Number(nt.to);
        keep.push({
          id: String(nt.id || rsAnnoId()),
          kind: nt.kind === "full" ? "full" : "local",
          body: body,
          snippet: String(nt.snippet || ""),
          from: Number.isFinite(from) ? from : -1,
          to: Number.isFinite(to) ? to : -1,
          ts: Number(nt.ts) || Date.now(),
          dead: nt.dead === true,
          /* done = 这一条已经被「采纳并覆盖」处理过：不再进下一轮提示词，卡片灰显 */
          done: nt.done === true,
          doneAt: Number(nt.doneAt) || 0,
        });
      }
      if (keep.length) out[path] = keep;
    }
    return out;
  }
  /* 这一篇的批注（create = 没有就当场建一个空数组；读的时候不要建，免得盘上多出一堆空键） */
  function rsAnnoList(path, create) {
    if (!path) return [];
    if (!RS.annoMap || typeof RS.annoMap !== "object") RS.annoMap = {};
    let list = RS.annoMap[path];
    if (!Array.isArray(list)) {
      if (!create) return [];
      list = [];
      RS.annoMap[path] = list;
    }
    return list;
  }
  function rsAnnoPersist() {
    return saveMetaPatch({ annotations: RS.annoMap || {} });
  }
  /* 能不能在这一面批注：阅读态、不是就地编辑、不是折叠的第 2/3 层（只读投影），
     且当前这块阅读面还在文档里（换篇 / 重画之后旧节点已经摘掉了）。 */
  function rsAnnoRoot() {
    if (!RS.curPath || !RS.root) return null;
    if (RS.editorMode !== "read" || RS.inlineOn) return null;
    if (RS.foldPath && RS.foldPath === RS.curPath && RS.foldLevel > 1) return null;
    const host = RS.selHost;
    if (!host || !host.isConnected) return null;
    if (!host.classList || !host.classList.contains("rs-read")) return null;
    return host;
  }
  /* 渲染后正文的纯文本 + 每个文本节点的全局起止（批注锚点都在这个坐标系里）。
     跳过公式（KaTeX 里再切文本就散成碎片，与查找条同一口径）与脚本样式。 */
  function rsAnnoFlat(root) {
    const nodes = [];
    let text = "";
    if (!root) return { text: text, nodes: nodes };
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      const p = n.parentElement;
      if (p && p.closest && p.closest(RS_ANNO_SKIP)) continue;
      const s = String(n.textContent || "");
      if (!s) continue;
      nodes.push({ node: n, start: text.length, end: text.length + s.length });
      text += s;
    }
    return { text: text, nodes: nodes };
  }
  function rsAnnoRangeOf(flat, a, b) {
    let s = null;
    let e = null;
    for (const it of flat.nodes) {
      if (!s && a < it.end) s = { node: it.node, off: Math.max(0, a - it.start) };
      if (b <= it.end) {
        e = { node: it.node, off: Math.max(0, b - it.start) };
        break;
      }
    }
    if (!s || !e) return null;
    try {
      const r = document.createRange();
      r.setStart(s.node, s.off);
      r.setEnd(e.node, e.off);
      return r;
    } catch (_) {
      return null;
    }
  }
  /* 锚点定位：先按 from 精确对，再在 from 附近 ±400 字里找，最后全文找第一处；
     找不到返回 -1（调用方标「失效」）。找到就把 from/to 挪到新位置 —— 这就是「自动重锚」。 */
  function rsAnnoLocate(text, nt) {
    const snip = String(nt.snippet || "");
    if (!text || !snip) return -1;
    const from = Number(nt.from);
    if (Number.isFinite(from) && from >= 0 && text.substr(from, snip.length) === snip) return from;
    if (Number.isFinite(from) && from >= 0) {
      const a = Math.max(0, from - 400);
      const b = Math.min(text.length, from + snip.length + 400);
      const rel = text.slice(a, b).indexOf(snip);
      if (rel >= 0) return a + rel;
    }
    return text.indexOf(snip);
  }
  function rsAnnoRectOf(node) {
    const r = node && node.getBoundingClientRect ? node.getBoundingClientRect() : null;
    if (!r) return null;
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
  }
  /* 当前选段（必须整段落在阅读面里）：{snippet, from, to, rect}；没有就 null。
     起点落在文本节点上就精确算偏移，跨元素就退到 indexOf（够用：重锚本来就按 snippet 找）。 */
  function rsAnnoSelSnap(root) {
    if (!root) return null;
    const sel = window.getSelection ? window.getSelection() : null;
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    let r = null;
    try {
      r = sel.getRangeAt(0);
    } catch (_) {
      return null;
    }
    if (!r || !root.contains(r.commonAncestorContainer)) return null;
    const snippet = String(sel.toString() || "").trim();
    if (!snippet) return null;
    const flat = rsAnnoFlat(root);
    let from = -1;
    if (r.startContainer && r.startContainer.nodeType === 3) {
      const hit = flat.nodes.find((it) => it.node === r.startContainer);
      if (hit) from = hit.start + r.startOffset;
    }
    if (from >= 0 && flat.text.substr(from, snippet.length) !== snippet) {
      const near = flat.text.indexOf(snippet, Math.max(0, from - 40));
      from = near >= 0 ? near : flat.text.indexOf(snippet);
    }
    if (from < 0) from = flat.text.indexOf(snippet);
    if (from < 0) from = 0;
    return { snippet: snippet, from: from, to: from + snippet.length, rect: rsAnnoRectOf(r) };
  }
  function rsAnnoSelSync() {
    const root = rsAnnoRoot();
    RS.annoSnap = root ? rsAnnoSelSnap(root) : null;
    const b = RS.annoLocalBtn;
    if (!b) return;
    b.disabled = !RS.annoSnap;
    b.title = RS.annoSnap
      ? t("给选中的这段正文加一条局部批注（只存进 research.json，不改 md 正文）")
      : t("先在正文里拖选一段，再点这里加局部批注");
  }

  /* 正文之上那条批注工具行：局部批注（有选段才亮）/ 全文批注 / 批注栏开合 */
  function rsAnnoBarRender() {
    const bar = RS.annoBarEl;
    if (!bar) return;
    const root = rsAnnoRoot();
    rsAnnoAiTickStop(); /* 每画一次就先停上一颗进度定时器（下面按当前态决定要不要再起） */
    if (!root) {
      bar.hidden = true;
      bar.innerHTML = "";
      RS.annoLocalBtn = null;
      return;
    }
    bar.hidden = false;
    bar.innerHTML = "";
    const list = rsAnnoList(RS.curPath, false);
    const local = el("button", "rs-anno-btn", t("局部批注"));
    local.type = "button";
    local.disabled = !RS.annoSnap;
    local.title = RS.annoSnap
      ? t("给选中的这段正文加一条局部批注（只存进 research.json，不改 md 正文）")
      : t("先在正文里拖选一段，再点这里加局部批注");
    /* 别把正文里的选区抢走：mousedown 一 preventDefault，选段与快照都还在 */
    local.onmousedown = (ev) => ev.preventDefault();
    local.onclick = () => {
      const snap = RS.annoSnap || rsAnnoSelSnap(root);
      if (!snap) return toastSafe(t("先在正文里拖选一段"), "warn");
      rsAnnoFloatOpen({
        kind: "local",
        title: t("局部批注"),
        snippet: snap.snippet,
        rect: snap.rect,
        onSave: (body) => rsAnnoAdd("local", body, snap),
      });
    };
    bar.appendChild(local);
    RS.annoLocalBtn = local;
    const full = el("button", "rs-anno-btn", t("全文批注"));
    full.type = "button";
    full.title = t("不绑选段，给整篇写一条批注（列在批注栏顶部；不改 md 正文）");
    full.onclick = () =>
      rsAnnoFloatOpen({
        kind: "full",
        title: t("全文批注"),
        onSave: (body) => rsAnnoAdd("full", body, null),
      });
    bar.appendChild(full);
    /* ── 入口：「让 AI 依据批注处理（N）」，N = 未处理批注数 ──
       N=0 或处理中置灰（处理中显示已收到的字数当进度）；结果卡在时这颗变「查看处理结果」。
       点了先就地弹一行确认（会花 Token，与 rsMissSuggest 的确认卡同一口径，不弹内置 grill）。 */
    const aiN = rsAnnoAiList().length;
    const aiBusy = rsAnnoAiBusy();
    const aiDone = rsAnnoAiReady();
    if (aiBusy || aiDone) RS.annoAiAsk = null; /* 已经开跑 / 结果已出：确认条不再挂着 */
    if (aiDone) {
      const look = el("button", "rs-anno-btn is-ai", t("查看处理结果"));
      look.type = "button";
      look.title = t("这份结果还没写进文件：点开看差异，再决定采纳还是放弃");
      look.onclick = () => {
        RS.annoCollapsed = false; /* 栏收着就先展开，否则「看」不到 */
        rsAnnoAiPaint();
        const card = RS.annoEl && RS.annoEl.querySelector(".rs-anno-ai");
        if (card && card.scrollIntoView) {
          try {
            card.scrollIntoView({ block: "nearest" });
          } catch (_) {}
        }
      };
      bar.appendChild(look);
    } else {
      const goAi = el(
        "button",
        "rs-anno-btn is-ai",
        aiBusy ? rsAnnoAiBusyLabel() : t("让 AI 依据批注处理") + "（" + aiN + "）",
      );
      goAi.type = "button";
      goAi.disabled = aiBusy || !aiN;
      goAi.title = aiBusy
        ? t("正在依据批注重写这一篇（正文照常可编辑）；结果出来后再决定是否覆盖")
        : aiN
          ? t("把这一篇连同 ") + aiN + t(" 条未处理批注交给模型重写（点了会先确认：会消耗 Token）")
          : t("没有未处理的批注：先在批注栏写几条，或把「已处理」的删掉");
      if (!aiBusy) {
        goAi.onclick = () => {
          RS.annoAiAsk = RS.curPath; /* 记下是哪一篇在等确认：换篇后确认条自然失效 */
          rsAnnoBarRender();
        };
      }
      bar.appendChild(goAi);
      /* 处理中的进度：流式收到的字数就是唯一进度信号，半秒刷一次字面，不重画整条工具行 */
      if (aiBusy) {
        RS.annoAiTick = setInterval(() => {
          if (!rsAnnoAiBusy() || !goAi.isConnected || RS.annoBarEl !== bar) {
            rsAnnoAiTickStop();
            return;
          }
          goAi.textContent = rsAnnoAiBusyLabel();
        }, 500);
      }
      if (!aiBusy && aiN && RS.annoAiAsk && RS.annoAiAsk === RS.curPath) {
        const conf = el("div", "rs-anno-ai-confirm");
        const q = t("将让 Agent 依据这 ") + aiN + t(" 条批注重写整篇，会消耗 Token。确认继续？");
        const qt = el("span", "rs-anno-ai-confirm-t", q);
        qt.title = q; /* 窄栏里折成一行省略号，完整话留在 title */
        conf.appendChild(qt);
        const ok = el("button", "rs-anno-btn is-primary", t("继续"));
        ok.type = "button";
        ok.onclick = () => {
          RS.annoAiAsk = null;
          rsAnnoBarRender(); /* 先把确认条收掉：起调用的前置检查失败时也不会留一条过期确认条 */
          void rsAnnoAiRun(); /* 起调用：正文只读不锁，处理中仍可滚动 / 编辑 */
        };
        const no = el("button", "rs-anno-btn", t("取消"));
        no.type = "button";
        no.onclick = () => {
          RS.annoAiAsk = null;
          rsAnnoBarRender();
        };
        conf.appendChild(ok);
        conf.appendChild(no);
        bar.appendChild(conf);
      }
    }
    const pane = el("button", "rs-anno-btn is-count", t("批注栏") + " " + list.length);
    pane.type = "button";
    pane.title = rsAnnoPaneCollapsed(list) ? t("展开批注栏") : t("收起批注栏");
    pane.onclick = () => {
      RS.annoCollapsed = !rsAnnoPaneCollapsed(list);
      rsAnnoPaintAll();
    };
    bar.appendChild(pane);
    if (!list.length) bar.appendChild(el("span", "rs-anno-hint", t("拖选正文可加局部批注")));
  }

  /* 右侧批注栏：头部（标题 / 条数 / 开合）+ 卡片表；全文批注在前，局部批注按时间在后 */
  function rsAnnoPaneCollapsed(list) {
    if (typeof RS.annoCollapsed === "boolean") return RS.annoCollapsed;
    return !(list && list.length);
  }
  function rsAnnoPaneRender() {
    const host = RS.annoEl;
    if (!host) return;
    const root = rsAnnoRoot();
    if (!root) {
      host.hidden = true;
      host.innerHTML = "";
      return;
    }
    const list = rsAnnoList(RS.curPath, false);
    const collapsed = rsAnnoPaneCollapsed(list);
    host.hidden = false;
    host.classList.toggle("is-collapsed", collapsed);
    host.innerHTML = "";
    const head = el("div", "rs-anno-head");
    head.appendChild(el("span", "rs-anno-title", t("批注栏")));
    head.appendChild(el("span", "rs-anno-count", String(list.length)));
    const fold = el("button", "rs-anno-fold", collapsed ? "«" : "»");
    fold.type = "button";
    fold.title = collapsed ? t("展开批注栏") : t("收起批注栏");
    fold.onclick = () => {
      RS.annoCollapsed = !collapsed;
      rsAnnoPaintAll();
    };
    head.appendChild(fold);
    host.appendChild(head);
    /* 收起时只留一条竖排细栏（点它展开） */
    if (collapsed) {
      const rail = el("button", "rs-anno-rail", t("批注栏") + (list.length ? " " + list.length : ""));
      rail.type = "button";
      rail.title = t("展开批注栏");
      rail.onclick = () => {
        RS.annoCollapsed = false;
        rsAnnoPaintAll();
      };
      host.appendChild(rail);
      return;
    }
    /* 待确认的 AI 结果：常驻卡挂在列表之上（表里滚动，卡不跟着滚走） */
    const ai = rsAnnoAiReady();
    if (ai) host.appendChild(rsAnnoAiCard(ai));
    const box = el("div", "rs-anno-list");
    if (!list.length) {
      box.appendChild(el("div", "rs-anno-empty", t("还没有批注：拖选正文加「局部批注」，或点「全文批注」")));
    }
    const full = list.filter((nt) => nt.kind === "full");
    const local = list.filter((nt) => nt.kind !== "full");
    for (const nt of full.concat(local)) box.appendChild(rsAnnoCard(nt));
    host.appendChild(box);
  }
  function rsAnnoCard(nt) {
    const card = el(
      "div",
      "rs-anno-card " +
        (nt.kind === "full" ? "is-full" : "is-local") +
        (nt.dead ? " is-dead" : "") +
        (nt.done ? " is-done" : ""),
    );
    card.dataset.noteId = String(nt.id || "");
    const head = el("div", "rs-anno-card-head");
    head.appendChild(
      el(
        "span",
        "rs-anno-tag " + (nt.kind === "full" ? "is-full" : "is-local"),
        nt.kind === "full" ? t("全文") : t("局部"),
      ),
    );
    /* 已处理（被「采纳并覆盖」用过的那一轮）：灰显，且不再进下一轮提示词 */
    if (nt.done) {
      const doneTag = el("span", "rs-anno-tag is-done", t("已处理"));
      doneTag.title = t("这条批注已经用在一次采纳里：不再进下一轮的 AI 处理");
      head.appendChild(doneTag);
    }
    head.appendChild(el("span", "rs-anno-card-ts", fmtProcessedAt(nt.ts)));
    const del = el("button", "rs-anno-x", "✕");
    del.type = "button";
    del.title = t("删除这条批注");
    del.onclick = () => rsAnnoDelete(nt.id);
    head.appendChild(del);
    card.appendChild(head);
    if (nt.kind !== "full" && nt.snippet) {
      const snip = el("div", "rs-anno-card-snip", "「" + nt.snippet + "」");
      snip.title = nt.dead ? t("锚点文字已变更，这条批注已失效") : t("点这里在正文里定位这一段");
      if (!nt.dead) snip.onclick = () => rsAnnoJump(nt);
      card.appendChild(snip);
    }
    if (nt.dead) card.appendChild(el("div", "rs-anno-card-warn", t("锚点文字已变更，批注可能失效")));
    card.appendChild(el("div", "rs-anno-card-body", nt.body));
    /* 点卡片（除了那颗 ✕ 与定位用的引文）= 改这条 */
    card.addEventListener("click", (ev) => {
      const tg = ev.target;
      if (tg && tg.closest && tg.closest("button, .rs-anno-card-snip")) return;
      rsAnnoEdit(nt, rsAnnoRectOf(card));
    });
    return card;
  }
  function rsAnnoAdd(kind, body, snap) {
    const text = String(body || "").trim();
    if (!text || !RS.curPath) return;
    const list = rsAnnoList(RS.curPath, true);
    const isFull = kind === "full";
    list.push({
      id: rsAnnoId(),
      kind: isFull ? "full" : "local",
      body: text,
      snippet: isFull ? "" : String((snap && snap.snippet) || ""),
      from: isFull ? -1 : Number(snap && snap.from >= 0 ? snap.from : -1),
      to: isFull ? -1 : Number(snap && snap.to >= 0 ? snap.to : -1),
      ts: Date.now(),
      dead: false,
    });
    /* 新批注写完就把栏展开（否则收着的那条细栏会把刚写的东西藏起来） */
    RS.annoCollapsed = false;
    rsAnnoChanged();
    toastSafe(isFull ? t("已写入全文批注") : t("已写入局部批注"));
  }
  function rsAnnoDelete(id) {
    const list = rsAnnoList(RS.curPath, false);
    const i = list.findIndex((x) => String(x.id) === String(id));
    if (i < 0) return;
    list.splice(i, 1);
    if (!list.length && RS.annoMap) delete RS.annoMap[RS.curPath];
    rsAnnoChanged();
    toastSafe(t("批注已删除"));
  }
  /* 改完 / 删完的唯一出口：落盘（research.json，与 saveMetaPatch 同一通道）+ 三处重画 */
  function rsAnnoChanged() {
    void rsAnnoPersist();
    rsAnnoBarRender();
    rsAnnoPaintAll();
  }
  /* ── AI 依据批注处理：批注 → 整篇新稿（**只出稿，不落盘、不动批注**）──
   * 与 app-review.js 的 teRunRevision 同一口径（全文 + 全部批注 → 整篇 Markdown），但**不建版本链**：
   * 结果只进内存态 RS.annoAi = { baseMd, nextMd }，后续的 diff 卡让用户确认，确认才覆盖原文件。
   * 提示词直接复用 app-review.js 的全局 buildRevisionPrompt(md, log)（脚本顺序：app-review.js 在前，
   * index.html:1326 → :1374），模型走 resolveProv() / modelOf() —— 与「设置 · 默认模型」、
   * 框选询问（rsAskOpen）、rsMissStream 同一条路由，不另开设置窗。
   * 本函数**不做**的事：不写盘（rsSaveCurrent 只由「采纳」调）、不改批注的 done、不产生任何版本副本。
   */
  function rsAnnoAiList() {
    /* 未处理的批注：local 带 snippet、full 不带（两者都送进提示词）；done 位由「采纳并覆盖」置上 */
    return rsAnnoList(RS.curPath, false).filter((nt) => nt && !nt.done);
  }
  function rsAnnoAiBusy() {
    return !!(RS.annoAi && RS.annoAi.busy);
  }
  /* 处理中按钮上的字：已收到的字数（流式累加的字数就是唯一的进度信号） */
  function rsAnnoAiBusyLabel() {
    const ai = RS.annoAi;
    const n = ai && ai.nextMd ? String(ai.nextMd).length : 0;
    return t("AI 处理中…") + (n ? " " + n + t(" 字") : "");
  }
  /* 进度定时器：每次重画工具行先停掉上一颗，处理完 / 换篇自然收掉 */
  function rsAnnoAiTickStop() {
    if (RS.annoAiTick) clearInterval(RS.annoAiTick);
    RS.annoAiTick = null;
  }
  /* 结果卡长在批注栏里：清结果要连栏一起重画（只重画工具行，卡会留在屏幕上） */
  function rsAnnoAiPaint() {
    rsAnnoBarRender();
    rsAnnoPaneRender();
  }
  function rsAnnoAiClear() {
    RS.annoAi = null;
    rsAnnoAiPaint();
  }
  /* 服务商有没有可用 Key：直填的 apiKey，或中转卡（Key 由账号登录托管，source=relay*）——
     与 resolveProv 的 hasKey 同一口径，这里单独一句是为了给出指路错误而不是静默 401 */
  function rsAnnoAiHasKey(prov) {
    if (!prov) return false;
    if (String(prov.apiKey || "").trim()) return true;
    return String(prov.source || "").toLowerCase().indexOf("relay") >= 0;
  }
  async function rsAnnoAiRun() {
    /* 禁重入：处理中再点直接返回当前态（按钮侧另行置灰） */
    if (rsAnnoAiBusy()) return RS.annoAi;
    if (!RS.curPath) {
      toastSafe(t("先打开一篇笔记"), "warn");
      return null;
    }
    /* 折叠的第 2/3 层是只读投影：改它没有落点（与 rsSaveCurrent 同一口径） */
    if (RS.foldPath && RS.foldPath === RS.curPath && RS.foldLevel > 1) {
      toastSafe(t("折叠的第 2/3 层是只读投影，先回到全文再让 AI 处理"), "warn");
      return null;
    }
    const log = rsAnnoAiList();
    if (!log.length) {
      toastSafe(t("无未处理批注"), "warn");
      return null;
    }
    const prov = resolveProv();
    if (!prov) {
      toastSafe(t("没有可用的文本模型（设置 · 默认模型）"), "err");
      return null;
    }
    const model = modelOf(prov);
    if (!model) {
      toastSafe(t("该服务商没有可用模型"), "err");
      return null;
    }
    if (!rsAnnoAiHasKey(prov)) {
      toastSafe(t("该服务商还没有 API Key：到 设置 · 服务商 里填上再试"), "err");
      return null;
    }
    if (typeof apiCallTextStream !== "function" || typeof buildRevisionPrompt !== "function") {
      toastSafe(t("文本模型通道未就绪（设置 · 默认模型）"), "err");
      return null;
    }
    const baseMd = readEditorMd();
    /* 提示词的批注条目：buildRevisionPrompt 只认 { kind, snippet, body }（多给的字段它不看） */
    const prompt = buildRevisionPrompt(
      baseMd,
      log.map((nt) => ({ kind: nt.kind === "full" ? "full" : "local", snippet: nt.snippet, body: nt.body })),
    );
    const mine = {
      busy: true,
      baseMd: baseMd,
      nextMd: "",
      model: model,
      provId: String(prov.id || ""),
      at: Date.now(),
      /* 这一份结果属于哪一篇、由哪几条批注生成：「采纳」只覆盖这一篇、只把这批标 done */
      path: RS.curPath,
      ids: log.map((nt) => String(nt.id)),
    };
    RS.annoAi = mine;
    rsAnnoAiPaint(); /* 「AI 处理中…」态：按钮侧按 rsAnnoAiBusy() 取用 */
    toastSafe(t("AI 处理中…"));
    try {
      const spec = {
        provider: prov,
        kind: "text",
        model: model,
        temperature: 0.3,
        prompt: prompt,
        texts: [],
        images: [],
        refImage: "",
      };
      const r = await apiCallTextStream(spec, null, (delta) => {
        if (RS.annoAi !== mine) return; /* 途中被放弃 / 换篇清掉：不再往旧态里堆字 */
        mine.nextMd = String(mine.nextMd || "") + String(delta || "");
      });
      /* 换篇 / 用户放弃会把 RS.annoAi 换掉或清掉：这份结果不再回填 */
      if (RS.annoAi !== mine) return null;
      let text = String((r && r.text) || mine.nextMd || "");
      text = typeof stripFences === "function" ? stripFences(text) : String(text).trim();
      if (!String(text || "").trim()) {
        RS.annoAi = null;
        rsAnnoAiPaint();
        toastSafe(t("模型未返回处理结果"), "err");
        return null;
      }
      mine.nextMd = text;
      mine.busy = false;
      RS.annoCollapsed = false; /* 结果卡要看得见：栏收着就先展开 */
      rsAnnoAiPaint();
      toastSafe(t("已生成处理结果，请确认差异"));
      return mine;
    } catch (e) {
      if (RS.annoAi === mine) RS.annoAi = null;
      rsAnnoAiPaint();
      toastSafe(t("AI 处理失败：") + String((e && e.message) || e), "err");
      return null;
    }
  }

  /* ── 行级 diff：给「AI 处理结果」卡算 rows ──
   * rsAnnoDiffRows(oldMd, newMd) → [{ k: "del" | "add" | "same", t: 整行文本 }]
   * 先裁掉公共前缀 / 后缀（几百行的笔记一般只剩一个小变更块），块内再走 LCS 保序配对；
   * 换行一律按 \n 切（\r\n 先归一），行尾不补换行符 —— 渲染侧按行平铺。
   * 折叠成「… 其余 N 行」是**渲染**的事（rsAnnoDiffView），数据这一层保留全量 same 行。 */
  function rsAnnoDiffLines(md) {
    return String(md == null ? "" : md).replace(/\r\n?/g, "\n").split("\n");
  }
  /* 变更块内部的行级比对：LCS（后缀 DP，O(n·m)）；
     整篇重写这种超大块（乘积 > 2e6，DP 数组要 > 8MB）退化成「整块删 + 整块加」，不改结论只降配对精度 */
  function rsAnnoDiffMid(A, B) {
    const n = A.length;
    const m = B.length;
    if (!n) return B.map((s) => ({ k: "add", t: s }));
    if (!m) return A.map((s) => ({ k: "del", t: s }));
    if (n * m > 2000000) {
      return A.map((s) => ({ k: "del", t: s })).concat(B.map((s) => ({ k: "add", t: s })));
    }
    const w = m + 1;
    const dp = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i * w + j] =
          A[i] === B[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
      }
    }
    const rows = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (A[i] === B[j]) {
        rows.push({ k: "same", t: A[i] });
        i++;
        j++;
      } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
        rows.push({ k: "del", t: A[i] });
        i++;
      } else {
        rows.push({ k: "add", t: B[j] });
        j++;
      }
    }
    while (i < n) rows.push({ k: "del", t: A[i++] });
    while (j < m) rows.push({ k: "add", t: B[j++] });
    return rows;
  }
  function rsAnnoDiffRows(oldMd, newMd) {
    const A = rsAnnoDiffLines(oldMd);
    const B = rsAnnoDiffLines(newMd);
    let pre = 0;
    while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
    let suf = 0;
    while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;
    const rows = [];
    for (let i = 0; i < pre; i++) rows.push({ k: "same", t: A[i] });
    for (const r of rsAnnoDiffMid(A.slice(pre, A.length - suf), B.slice(pre, B.length - suf))) rows.push(r);
    for (let i = A.length - suf; i < A.length; i++) rows.push({ k: "same", t: A[i] });
    return rows;
  }

  /* 只留变更块上下各 2 行上下文：中间那段 same 折成 { k:"gap", n, from, to }（from/to = rows 下标） */
  function rsAnnoDiffView(rows) {
    const CONTEXT = 2;
    const out = [];
    let i = 0;
    while (i < rows.length) {
      if (rows[i].k !== "same") {
        out.push(rows[i]);
        i++;
        continue;
      }
      let j = i;
      while (j < rows.length && rows[j].k === "same") j++;
      const run = j - i;
      const head = i > 0 ? CONTEXT : 0; /* 顶上没有变更就不用留上文 */
      const tail = j < rows.length ? CONTEXT : 0;
      if (run <= head + tail + 1) {
        for (let x = i; x < j; x++) out.push(rows[x]);
      } else {
        for (let x = i; x < i + head; x++) out.push(rows[x]);
        out.push({ k: "gap", t: "", n: run - head - tail, from: i + head, to: j - tail });
        for (let x = j - tail; x < j; x++) out.push(rows[x]);
      }
      i = j;
    }
    return out;
  }

  /* 结果卡（批注栏内一张常驻卡）：标题 + ±行数 + diff 体（可滚动、长上下文可展开）+ 采纳 / 放弃。
     它不是浮层，所以没有「点外面关闭」这条路 —— 关掉只走卡里的按钮。 */
  function rsAnnoAiReady() {
    const ai = RS.annoAi;
    if (!ai || ai.busy) return null;
    if (!String(ai.nextMd || "").trim()) return null;
    /* 结果属于生成它的那一篇：用户换篇之后不要在别人的批注栏里挂这张卡（采纳会覆盖错文件） */
    if (ai.path && ai.path !== RS.curPath) return null;
    return ai;
  }
  function rsAnnoAiRow(it) {
    const kind = it.k === "add" ? "add" : it.k === "del" ? "del" : "same";
    const row = el("div", "rs-anno-ai-row is-" + kind);
    row.appendChild(el("span", "rs-anno-ai-sign", kind === "add" ? "+" : kind === "del" ? "−" : "·"));
    row.appendChild(el("span", "rs-anno-ai-text", it.t === "" ? " " : it.t));
    return row;
  }
  function rsAnnoAiCard(ai) {
    const card = el("div", "rs-anno-ai");
    const rows = rsAnnoDiffRows(ai.baseMd, ai.nextMd);
    let adds = 0;
    let dels = 0;
    for (const r of rows) {
      if (r.k === "add") adds++;
      else if (r.k === "del") dels++;
    }
    const head = el("div", "rs-anno-ai-head");
    head.appendChild(el("span", "rs-anno-ai-title", t("AI 处理结果")));
    head.appendChild(el("span", "rs-anno-ai-stat is-add", "+" + adds));
    head.appendChild(el("span", "rs-anno-ai-stat is-del", "−" + dels));
    card.appendChild(head);
    if (ai.model) card.appendChild(el("div", "rs-anno-ai-sub", t("模型") + " · " + String(ai.model)));
    const body = el("div", "rs-anno-ai-diff");
    card.appendChild(body);
    /* 展开过的「… 其余 N 行」记在结果态上：换一份结果自然重来，不用另开一份 UI 状态 */
    const open = ai.open || (ai.open = {});
    const paint = () => {
      const keep = body.scrollTop;
      body.innerHTML = "";
      if (!adds && !dels) {
        body.appendChild(el("div", "rs-anno-ai-empty", t("AI 结果与原文一致：没有要覆盖的改动")));
      }
      for (const it of rsAnnoDiffView(rows)) {
        if (it.k === "gap") {
          const key = it.from + ":" + it.to;
          if (open[key]) {
            for (let x = it.from; x < it.to; x++) body.appendChild(rsAnnoAiRow(rows[x]));
          } else {
            const gap = el("button", "rs-anno-ai-gap", t("… 其余 ") + it.n + t(" 行"));
            gap.type = "button";
            gap.title = t("展开这段未改动的上下文");
            gap.onclick = () => {
              open[key] = true;
              paint();
            };
            body.appendChild(gap);
          }
          continue;
        }
        body.appendChild(rsAnnoAiRow(it));
      }
      body.scrollTop = keep;
    };
    paint();
    const foot = el("div", "rs-anno-ai-foot");
    const take = el("button", "rs-anno-btn is-primary", t("采纳并覆盖"));
    take.type = "button";
    take.title = t("把这份结果写回笔记，并把已处理的批注标记为完成");
    /* 写盘走既有的 rsSaveCurrent（写入闸 / changes.jsonl / 判色 / 图谱都在里面），这里不另写一份 */
    take.disabled = !!ai.saving;
    take.onclick = () => rsAnnoAiAccept();
    foot.appendChild(take);
    const drop = el("button", "rs-anno-btn is-danger", t("放弃"));
    drop.type = "button";
    drop.title = t("丢掉这份结果，笔记不动");
    drop.onclick = () => {
      rsAnnoAiClear();
      toastSafe(t("已放弃这次处理结果"));
    };
    foot.appendChild(drop);
    card.appendChild(foot);
    return card;
  }

  /* ── 采纳即覆盖：AI 结果写回原文件 + 参与本轮的批注置「已处理」──
   * 落盘只走 rsSaveCurrent：写入闸（金色版本校验）与 changes.jsonl 都由它负责；
   * 被拒就整笔不落（文件、changes、图谱都没动），diff 结果卡留着让用户再决定。
   * 不产生任何版本副本（不建版本链、不写备份文件）。 */
  async function rsAnnoAiAccept() {
    const ai = rsAnnoAiReady();
    if (!ai) return false;
    if (ai.saving) return false; /* 双击 / 重入：一笔只写一次 */
    const path = ai.path || RS.curPath;
    if (!path || path !== RS.curPath) {
      /* 结果属于另一篇：覆盖谁都不对，直接丢掉这份结果（正文与批注原样） */
      RS.annoAi = null;
      rsAnnoAiPaint();
      toastSafe(t("这份结果来自另一篇笔记，已丢弃"), "warn");
      return false;
    }
    ai.saving = true;
    const next = String(ai.nextMd || "");
    const ok = await rsSaveCurrent(next);
    if (ok === false) {
      /* 写入闸拒了：整笔不落盘，diff 卡保留（与「放弃」区分开：取消不等于丢弃结果） */
      ai.saving = false;
      /* 这一笔没落盘：别让防抖保存拿旧正文再碰一次闸 */
      RS.dirty = false;
      rsAnnoAiPaint();
      toastSafe(t("版本组里这一版被改过，这次覆盖已取消（diff 结果还留着）"), "warn");
      return false;
    }
    if (RS.curPath !== path) {
      /* 落盘途中换了篇：这一份结果已经落到它该去的那篇，批注与结果态都不再动 */
      RS.annoAi = null;
      rsAnnoAiPaint();
      return true;
    }
    /* 参与本轮的那批批注置 done（按生成时记下的 id：期间新加的批注不算这一轮） */
    const ids = Array.isArray(ai.ids) && ai.ids.length ? ai.ids : rsAnnoAiList().map((nt) => nt.id);
    const want = new Set(ids.map((x) => String(x)));
    const now = Date.now();
    let n = 0;
    for (const nt of rsAnnoList(path, false)) {
      if (!want.has(String(nt.id)) || nt.done) continue;
      nt.done = true;
      nt.doneAt = now;
      n++;
    }
    if (n) void rsAnnoPersist();
    /* 收口：结果态清掉（卡随之消失），正文重画（批注卡灰显「已处理」），图谱增量补齐 */
    RS.annoAi = null;
    renderEditor();
    if (RS.graph) rsRebuildGraph({ keepPositions: true, silent: true });
    toastSafe(n ? t("已覆盖原文件，") + n + t(" 条批注标记为已处理") : t("已覆盖原文件"));
    return true;
  }

  function rsAnnoJump(nt) {
    const root = rsAnnoRoot();
    if (!root || !nt.snippet) return;
    const flat = rsAnnoFlat(root);
    const a = rsAnnoLocate(flat.text, nt);
    if (a < 0) {
      nt.dead = true;
      rsAnnoChanged();
      return toastSafe(t("未能在正文中找到这条批注的片段"), "warn");
    }
    const r = rsAnnoRangeOf(flat, a, a + String(nt.snippet).length);
    const node = r && r.startContainer;
    const hostEl = node && (node.nodeType === 3 ? node.parentElement : node);
    if (hostEl && hostEl.scrollIntoView) {
      try {
        hostEl.scrollIntoView({ block: "center", behavior: "smooth" });
      } catch (_) {}
    }
    rsAnnoPaint();
  }

  /* ── 浮空便笺（新建 / 改批注共用）──
     带输入的面板一律 persistent（点外面不关）：只走便笺里的按钮 / ✕ / Esc。 */
  function rsAnnoFloatEl() {
    let f = RS.annoFloatEl;
    if (f && f.isConnected) return f;
    f = el("div", "rs-anno-float");
    f.hidden = true;
    f.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") {
        ev.preventDefault();
        ev.stopPropagation();
        rsAnnoFloatClose();
      }
    });
    RS.annoFloatEl = f;
    if (RS.mainEl) RS.mainEl.appendChild(f);
    return f;
  }
  function rsAnnoFloatClose() {
    const f = RS.annoFloatEl;
    if (!f) return;
    f.hidden = true;
    f.innerHTML = "";
  }
  function rsAnnoFloatPlace(f, rect) {
    const main = RS.mainEl;
    if (!main || !f) return;
    const mr = main.getBoundingClientRect();
    let x = 16;
    let y = 64;
    if (rect && (rect.width || rect.height)) {
      x = rect.left - mr.left;
      y = rect.bottom - mr.top + 8;
    } else if (RS.annoBarEl && !RS.annoBarEl.hidden) {
      const br = RS.annoBarEl.getBoundingClientRect();
      x = br.left - mr.left + 12;
      y = br.bottom - mr.top + 8;
    }
    f.hidden = false;
    const fw = f.offsetWidth || 272;
    const fh = f.offsetHeight || 186;
    f.style.left = Math.max(8, Math.round(Math.min(x, mr.width - fw - 12))) + "px";
    f.style.top = Math.max(8, Math.round(Math.min(y, mr.height - fh - 12))) + "px";
  }
  /* o = {kind, title, snippet, body, rect, onSave(body), onDelete} */
  function rsAnnoFloatOpen(o) {
    const opt = o || {};
    const f = rsAnnoFloatEl();
    if (!f) return;
    f.innerHTML = "";
    const head = el("div", "rs-anno-float-head");
    head.appendChild(
      el(
        "span",
        "rs-anno-tag " + (opt.kind === "full" ? "is-full" : "is-local"),
        opt.kind === "full" ? t("全文") : t("局部"),
      ),
    );
    head.appendChild(el("span", "rs-anno-float-t", opt.title || t("批注栏")));
    const closeB = el("button", "rs-anno-x", "✕");
    closeB.type = "button";
    closeB.title = t("关闭便笺（Esc）");
    closeB.onclick = () => rsAnnoFloatClose();
    head.appendChild(closeB);
    f.appendChild(head);
    if (opt.snippet) f.appendChild(el("div", "rs-anno-float-snip", "「" + opt.snippet + "」"));
    const ta = el("textarea", "rs-anno-float-in");
    ta.rows = 4;
    ta.spellcheck = false;
    ta.placeholder = t("写一条批注…（只存进 research.json，不改 md 正文）");
    ta.value = String(opt.body || "");
    f.appendChild(ta);
    const btns = el("div", "rs-anno-float-btns");
    if (typeof opt.onDelete === "function") {
      const del = el("button", "rs-anno-btn is-danger", t("删除批注"));
      del.type = "button";
      del.onclick = () => {
        opt.onDelete();
        rsAnnoFloatClose();
      };
      btns.appendChild(del);
    }
    const ok = el("button", "rs-anno-btn is-primary", opt.onDelete ? t("保存修改") : t("写入批注"));
    ok.type = "button";
    const commit = () => {
      const body = String(ta.value || "").trim();
      if (!body) {
        toastSafe(t("批注内容不能为空"), "warn");
        ta.focus();
        return;
      }
      opt.onSave(body);
      rsAnnoFloatClose();
    };
    ok.onclick = commit;
    btns.appendChild(ok);
    f.appendChild(btns);
    ta.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") {
        ev.preventDefault();
        ev.stopPropagation();
        rsAnnoFloatClose();
      } else if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "s") {
        ev.preventDefault();
        commit();
      }
    });
    rsAnnoFloatPlace(f, opt.rect);
    ta.focus();
  }
  function rsAnnoEdit(nt, rect) {
    if (!nt) return;
    rsAnnoFloatOpen({
      kind: nt.kind,
      title: t("改批注"),
      body: nt.body,
      snippet: nt.kind === "full" ? "" : nt.snippet,
      rect: rect,
      onDelete: () => rsAnnoDelete(nt.id),
      onSave: (body) => {
        nt.body = body;
        nt.ts = Date.now();
        rsAnnoChanged();
        toastSafe(t("批注已更新"));
      },
    });
  }

  /* ── 正文里的那条淡橙虚线 + 到批注卡的连线 ──
     叠层挂在 .rs-main（pointer-events 全关），坐标全相对 .rs-main；命中判定用坐标窄带
     （见 rsAnnoHitAt），所以在被批注的文字上正常拖选 / 点双链一律不受影响。 */
  function rsAnnoLayer() {
    const main = RS.mainEl;
    if (!main) return null;
    let layer = main.querySelector(".rs-anno-layer");
    if (!layer) {
      layer = el("div", "rs-anno-layer");
      layer.hidden = true;
      layer.innerHTML = '<svg class="rs-anno-svg" aria-hidden="true"></svg>';
      main.appendChild(layer);
    }
    return layer;
  }
  function rsAnnoPaintSoon() {
    if (rsAnnoPaintRaf) return;
    const raf = window.requestAnimationFrame || ((fn) => setTimeout(fn, 16));
    rsAnnoPaintRaf = raf(() => {
      rsAnnoPaintRaf = 0;
      rsAnnoPaint();
    });
  }
  function rsAnnoPaintClear(layer) {
    RS_ANNO.hits = [];
    const l = layer || rsAnnoLayer();
    if (!l) return;
    l.hidden = true;
    const svg = l.querySelector("svg");
    if (svg) svg.innerHTML = "";
  }
  function rsAnnoPaint() {
    const layer = rsAnnoLayer();
    const main = RS.mainEl;
    const root = rsAnnoRoot();
    if (!main || !layer || !root) return rsAnnoPaintClear(layer);
    const list = rsAnnoList(RS.curPath, false).filter((nt) => nt.kind !== "full" && nt.snippet);
    if (!list.length) return rsAnnoPaintClear(layer);
    const svg = layer.querySelector("svg");
    if (!svg) return rsAnnoPaintClear(layer);
    const flat = rsAnnoFlat(root);
    if (!flat.text) return rsAnnoPaintClear(layer);
    const mr = main.getBoundingClientRect();
    const bodyRect = RS.bodyEl ? RS.bodyEl.getBoundingClientRect() : null;
    const cards = new Map();
    if (RS.annoEl) {
      RS.annoEl.querySelectorAll(".rs-anno-card[data-note-id]").forEach((c) => {
        cards.set(c.getAttribute("data-note-id"), c);
      });
    }
    const parts = [];
    const hits = [];
    /* 这一段里有没有批注的失效态翻面（翻了就得把卡片重画一次，调用方据此再走一遍） */
    let deadChanged = false;
    for (const nt of list) {
      const a = rsAnnoLocate(flat.text, nt);
      /* 找不到原文 = 这条批注的锚点已经失效：不画标记，卡片上打「失效」 */
      if (a < 0) {
        if (!nt.dead) {
          nt.dead = true;
          deadChanged = true;
        }
        continue;
      }
      nt.from = a;
      nt.to = a + String(nt.snippet).length;
      if (nt.dead) {
        nt.dead = false;
        deadChanged = true;
      }
      const r = rsAnnoRangeOf(flat, a, nt.to);
      if (!r) continue;
      let rects = [];
      try {
        rects = Array.from(r.getClientRects());
      } catch (_) {
        rects = [];
      }
      const vis = [];
      for (const rr of rects) {
        if (!rr || !(rr.width || rr.height)) continue;
        let box = { x1: rr.left, x2: rr.right, y1: rr.top, y2: rr.bottom };
        /* 只画落在正文可见区里的那几行（滚出去的部分别糊到工具行 / 批注栏上） */
        if (bodyRect) {
          box = {
            x1: Math.max(rr.left, bodyRect.left),
            x2: Math.min(rr.right, bodyRect.right),
            y1: Math.max(rr.top, bodyRect.top),
            y2: Math.min(rr.bottom, bodyRect.bottom),
          };
          if (box.x2 - box.x1 < 1 || box.y2 - box.y1 < 1) continue;
        }
        vis.push(box);
      }
      if (!vis.length) continue;
      for (const v of vis) {
        const l = Math.round(v.x1 - mr.left);
        const rr2 = Math.round(v.x2 - mr.left);
        const y = Math.round(v.y2 - mr.top) - 2;
        parts.push(
          '<line class="rs-anno-ul" x1="' +
            l +
            '" y1="' +
            y +
            '" x2="' +
            rr2 +
            '" y2="' +
            y +
            '"><title>' +
            esc(t("点击修改这条批注")) +
            "</title></line>",
        );
        hits.push({ id: String(nt.id || ""), left: l, right: rr2, top: y - RS_ANNO_HIT_H, bottom: y + RS_ANNO_HIT_H });
      }
      /* 连线：这段文字整体的最右端中点 → 右侧那张批注卡的左侧中点（直线，平时不显形） */
      const card = cards.get(String(nt.id || ""));
      if (!card) continue;
      const cr = card.getBoundingClientRect();
      let uR = -Infinity;
      let uT = Infinity;
      let uB = -Infinity;
      for (const v of vis) {
        if (v.x2 > uR) uR = v.x2;
        if (v.y1 < uT) uT = v.y1;
        if (v.y2 > uB) uB = v.y2;
      }
      parts.push(
        '<line class="rs-anno-link" data-note="' +
          esc(String(nt.id || "")) +
          '" x1="' +
          (Math.round(uR - mr.left) + 2) +
          '" y1="' +
          Math.round((uT + uB) / 2 - mr.top) +
          '" x2="' +
          (Math.round(cr.left - mr.left) - 2) +
          '" y2="' +
          Math.round(cr.top - mr.top + cr.height / 2) +
          '"/>',
      );
    }
    svg.innerHTML = parts.join("");
    RS_ANNO.hits = hits;
    layer.hidden = !parts.length;
    return deadChanged;
  }
  function rsAnnoHitAt(ev) {
    const main = RS.mainEl;
    const hits = RS_ANNO.hits;
    if (!main || !hits || !hits.length) return null;
    const mr = main.getBoundingClientRect();
    const x = ev.clientX - mr.left;
    const y = ev.clientY - mr.top;
    for (const h of hits) {
      if (x >= h.left - 2 && x <= h.right + 2 && y >= h.top && y <= h.bottom) return h;
    }
    return null;
  }
  /* 连线只在 hover 到被批注正文时显形：一次只亮当前那条 */
  function rsAnnoLinkShow(id) {
    const layer = rsAnnoLayer();
    if (!layer) return;
    layer.querySelectorAll(".rs-anno-link").forEach((l) => {
      l.classList.toggle("on", !!id && l.getAttribute("data-note") === String(id));
    });
  }
  /* 挂在每一块阅读面上（重画就是新元素，所以用 dataset 标记幂等）：
     hover 到虚线 → 手型 + 亮连线；点虚线 → 重开这条批注（吃掉 mousedown，光标不跳进正文）。 */
  function rsAnnoBindSurface(root) {
    if (!root || root.dataset.annoBound === "1") return;
    root.dataset.annoBound = "1";
    root.addEventListener("mousemove", (ev) => {
      if (!RS_ANNO.hits.length) return;
      const hit = rsAnnoHitAt(ev);
      root.style.cursor = hit ? "pointer" : "";
      rsAnnoLinkShow(hit ? hit.id : "");
    });
    root.addEventListener("mouseleave", () => {
      root.style.cursor = "";
      rsAnnoLinkShow("");
    });
    root.addEventListener("mousedown", (ev) => {
      if (ev.button !== 0 || !RS_ANNO.hits.length) {
        RS_ANNO.eatClick = false;
        return;
      }
      const hit = rsAnnoHitAt(ev);
      if (!hit) {
        RS_ANNO.eatClick = false;
        return;
      }
      ev.preventDefault();
      ev.stopPropagation();
      /* 紧随其后的那次 click 也要吃掉：不然点在「带虚线的链接 / 术语」上会连跳转一起触发 */
      RS_ANNO.eatClick = true;
      const nt = rsAnnoList(RS.curPath, false).find((x) => String(x.id) === String(hit.id));
      if (nt) {
        rsAnnoEdit(nt, {
          left: ev.clientX,
          top: ev.clientY,
          right: ev.clientX,
          bottom: ev.clientY,
          width: 0,
          height: 0,
        });
      }
    });
    root.addEventListener(
      "click",
      (ev) => {
        if (!RS_ANNO.eatClick) return;
        RS_ANNO.eatClick = false;
        ev.preventDefault();
        ev.stopPropagation();
      },
      true,
    );
    /* 划选完（松手 / 键盘选段）刷新一次「局部批注」的亮灭 */
    root.addEventListener("mouseup", () => rsAnnoSelSync());
    root.addEventListener("keyup", () => rsAnnoSelSync());
  }
  /* 换篇 / 换折叠档 / 切态 / 每次重画之后的唯一同步口：收浮层 → 栏 / 卡片 / 正文高亮 */
  function rsAnnoSync() {
    rsAnnoFloatClose();
    RS.annoSnap = null;
    const root = rsAnnoRoot();
    if (root) rsAnnoBindSurface(root);
    rsAnnoBarRender();
    rsAnnoPaintAll();
  }
  /* 先画卡片再画正文标记：批注是不是「失效」要等 rsAnnoPaint 定位过才知道，
     翻了面就再走一遍（卡片补「失效」、连线也按新卡片位置重算）。 */
  function rsAnnoPaintAll() {
    rsAnnoPaneRender();
    if (rsAnnoPaint() === true) {
      rsAnnoPaneRender();
      rsAnnoPaint();
    }
  }

  /* 实时预览：源码输入后小延时重渲染（不打字打到一半就重排，也不抖动滚动） */
  let previewTimer = null;
  let previewGen = 0; /* 预览层的第几次重画：块映射按它作废（DOM 换了，旧引用全废） */
  function rsSchedulePreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => {
      if (!RS.previewEl) return;
      const box = RS.previewEl;
      const top = box.scrollTop;
      box.innerHTML = renderMarkdown(splitFm(RS.md).body);
      decorateCallouts(box);
      rsJoinSoftBreaks(box);
      rsResolveImgs(box);
      box.scrollTop = top;
      previewGen++;
      /* 重画之后块映射作废，按当前光标重新认一次（块在视野里就不动滚动） */
      rsSyncFromCursor();
      /* 预览刷新后正文里的高亮全没了：查找条开着就重新遍历一遍（计数跟着更新） */
      rsFindSync();
    }, 160);
  }

  /* ── 源码 ⇄ 预览 位置同步（编辑态：左边源码、右边实时预览）──
   * 用户要求：左侧源码的光标一动，右侧渲染页就滚到对应位置，并把那一块标出来。
   * 口径：
   *   · 行 ⇄ 块 的唯一依据是 marked 的**顶层 token**：每个顶层块在正文里的字符偏移是确定的
   *     （按顺序 indexOf 出各自的 raw），光标落在哪个 token 里就对应哪一块 —— 不按比例猜、
   *     不重排、不改正文。marked 缺席（切片沙箱）时退化成「按空行切段」，同步仍在，粒度粗一档。
   *   · 顶层 token ⇄ 预览的直接子元素按顺序对齐（一个 token 出一颗元素，space / def 不出），
   *     对齐时先用「块头几个字」认一遍，认不出就顺位顶一个（顺序天然一致，顺位不会错）。
   *   · 只有目标块跑出视野才滚，滚到离顶 16px：块内继续打字不会被反复拖动。
   *   · 标记 = 那一块加 .rs-sync-hl（淡底 + 左侧一道强调色，见 research.css），换块就挪走。 */
  const RS_SYNC_PAD = 16;
  let srcSyncCache = null; /* { preview, gen, body, toks, elByTok } */
  let srcSyncHl = null; /* 当前被标记的那一块 */

  /* 只留文字与数字（中英文都算字）：先把两边（源码 raw / 渲染后文本）的标记符全部抹掉，
     剩下的字序一致就能认出是同一块（`## 概述` 与渲染出的「概述」在这里是同一个键）。 */
  function rsSyncNorm(s) {
    return String(s == null ? "" : s).replace(/[^\w\u3400-\u9fff\uf900-\ufaff]+/g, "");
  }

  /* 正文的顶层块：[{ start, raw }]，start = 该块在正文（已去 frontmatter）里的字符偏移 */
  function rsTopBlocks(body) {
    const src = String(body || "");
    const out = [];
    const M = window.marked;
    let toks = null;
    if (M && typeof M.lexer === "function") {
      try {
        toks = M.lexer(src);
      } catch (_) {
        toks = null;
      }
    }
    if (Array.isArray(toks)) {
      let pos = 0;
      for (const tk of toks) {
        const type = tk && tk.type;
        if (!type || type === "space" || type === "def") continue;
        const raw = String(tk.raw || "");
        const at = raw ? src.indexOf(raw, pos) : -1;
        out.push({ start: at >= 0 ? at : pos, raw });
        if (at >= 0) pos = at + raw.length;
      }
    }
    if (!out.length && src.trim()) {
      let pos = 0;
      for (const part of src.split(/\n[ \t]*\n/)) {
        if (!part.trim()) continue;
        const at = src.indexOf(part, pos);
        if (at < 0) continue;
        out.push({ start: at, raw: part });
        pos = at + part.length;
      }
    }
    return out;
  }

  function rsSyncBuild(prev, body) {
    const toks = rsTopBlocks(body);
    const elByTok = new Array(toks.length).fill(null);
    let ti = 0;
    for (const kid of prev.children) {
      if (ti >= toks.length) break;
      const want = rsSyncNorm(kid.textContent).slice(0, 12);
      let hit = -1;
      if (want) {
        for (let k = ti; k < toks.length; k++) {
          if (rsSyncNorm(toks[k].raw).includes(want)) {
            hit = k;
            break;
          }
        }
      }
      if (hit < 0) hit = ti;
      elByTok[hit] = kid;
      ti = hit + 1;
    }
    return { preview: prev, gen: previewGen, body, toks, elByTok };
  }
  function rsSyncCacheFor(prev, body) {
    const hit = srcSyncCache;
    if (hit && hit.preview === prev && hit.gen === previewGen) return hit;
    srcSyncCache = rsSyncBuild(prev, body);
    return srcSyncCache;
  }

  /* 光标位置 → 预览滚到对应块 + 标出来。幂等：同一处反复调只挪一次标记、只在视野外才滚。 */
  function rsSyncFromCursor(force) {
    const ta = RS.srcEl;
    const prev = RS.previewEl;
    if (!ta || !prev || !prev.isConnected) return;
    const md = String(ta.value || "");
    const fm = splitFm(md);
    const off = fm.body ? md.length - fm.body.length : 0; /* frontmatter 不参与渲染，位移要减掉 */
    const caret = Number(ta.selectionStart) || 0;
    const rel = Math.max(0, Math.min(fm.body.length, caret - off));
    const cache = rsSyncCacheFor(prev, fm.body);
    const toks = cache.toks;
    if (!toks.length) return;
    let idx = 0;
    for (let i = 0; i < toks.length && toks[i].start <= rel; i++) idx = i;
    let el = null;
    for (let i = idx; i >= 0 && !el; i--) el = cache.elByTok[i] || null;
    for (let i = idx + 1; i < cache.elByTok.length && !el; i++) el = cache.elByTok[i] || null;
    if (!el) return;
    if (srcSyncHl !== el) {
      if (srcSyncHl) srcSyncHl.classList.remove("rs-sync-hl");
      el.classList.add("rs-sync-hl");
      srcSyncHl = el;
    }
    const boxTop = prev.getBoundingClientRect().top;
    const rect = el.getBoundingClientRect();
    const top = rect.top - boxTop;
    const h = prev.clientHeight;
    if (force || top < RS_SYNC_PAD || top + rect.height > h - RS_SYNC_PAD) {
      prev.scrollTop += top - RS_SYNC_PAD;
    }
  }

  /* ── 文章内查找 ↔ 替换（Ctrl+F，只作用于当前这一篇）──
   * 查找条挂在阅读区最上面（RS.editorWrap 的第一颗），随视图存在、不随换页销毁。
   * 匹配：遍历**渲染后**的阅读容器（阅读态 .rs-read / 编辑态预览 .rs-preview / 折叠只读 .rs-fold-ro）
   * 里的行内文本节点，逐段包 `<mark class="rs-find">`；当前命中单独一档（.rs-find-on）并滚进视野。
   * 替换：只写这一篇的 RS.md（跳过 frontmatter），走 rsSaveCurrent 落盘（写入闸 / changes.jsonl /
   * 图谱增量都在里面），落盘后重渲染重新计数。折叠第 2 / 3 层是只读投影 —— 两颗替换钮禁用。 */
  const RSF = { q: "", hits: [], cur: -1 };
  /* 高亮要跳过的子树：公式（KaTeX 里再切文本就散成碎片）、脚本 / 样式、查找条自己 */
  /* `svg` 同上：查找高亮用的是 <mark>，塞进图的 `<text>` 里那一段标签就不画了 */
  const RSF_SKIP = ".katex, .katex-display, .rv-math, .rs-eq-no, .rs-findbar, .rs-ctxmenu, script, style, textarea, svg";

  function rsFindReadonly() {
    return !!(RS.foldPath && RS.foldPath === RS.curPath && RS.foldLevel > 1);
  }
  /* 当前这一篇渲染出来的容器（换页 / 重渲染后整块换掉，所以每次都现查） */
  function rsFindRoot() {
    const body = RS.bodyEl;
    if (!body) return null;
    return body.querySelector(".rs-rich.rs-read") || body.querySelector(".rs-rich");
  }
  function rsFindBuild(wrap) {
    if (!wrap || RS.findEl) return;
    const bar = el("div", "rs-findbar");
    bar.hidden = true;
    const inp = el("input", "rs-find-in");
    inp.type = "text";
    inp.spellcheck = false;
    inp.placeholder = t("在本篇里查找");
    const cnt = el("span", "rs-find-count", "0/0");
    cnt.title = t("第几处 / 共几处");
    const mkBtn = (cls, label, title, fn) => {
      const b = el("button", "rs-find-btn " + cls, label);
      b.type = "button";
      b.title = title;
      b.dataset.title = title;
      b.onclick = fn;
      return b;
    };
    const prevB = mkBtn("rs-find-prev", "↑", t("上一个匹配"), () => rsFindStep(-1));
    const nextB = mkBtn("rs-find-next", "↓", t("下一个匹配"), () => rsFindStep(1));
    const rep = el("input", "rs-find-rep");
    rep.type = "text";
    rep.spellcheck = false;
    rep.placeholder = t("替换为");
    const repB = mkBtn("rs-find-replace", t("替换"), t("替换当前这一处（只写这一篇）"), () => void rsFindReplace(false));
    const allB = mkBtn("rs-find-all", t("全部替换"), t("替换本篇里的所有匹配"), () => void rsFindReplace(true));
    const closeB = mkBtn("rs-find-close", "✕", t("关闭查找条（Esc）"), () => rsFindClose());
    [inp, cnt, prevB, nextB, rep, repB, allB, closeB].forEach((n) => bar.appendChild(n));
    inp.oninput = () => rsFindMark();
    inp.onkeydown = (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        rsFindStep(ev.shiftKey ? -1 : 1);
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        rsFindClose();
      }
    };
    rep.onkeydown = (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        void rsFindReplace(false);
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        rsFindClose();
      }
    };
    /* 条内的点击不当作「点空白」：右键菜单 / 浮层的关闭判定都挂在 document 上 */
    bar.addEventListener("mousedown", (ev) => ev.stopPropagation());
    wrap.insertBefore(bar, wrap.firstChild);
    RS.findEl = bar;
    RS.findInput = inp;
    RS.findRepInput = rep;
    RS.findCountEl = cnt;
    RS.findRepBtns = [repB, allB];
  }
  /* 先拆掉上一轮的高亮：相邻文本节点要合回去，否则命中被切成两半就再也搜不到 */
  function rsFindClear() {
    const root = rsFindRoot();
    RSF.hits = [];
    RSF.cur = -1;
    if (!root) return;
    const marks = [...root.querySelectorAll("mark.rs-find")];
    if (!marks.length) return;
    const touched = new Set();
    for (const m of marks) {
      const p = m.parentNode;
      if (!p) continue;
      p.replaceChild(document.createTextNode(m.textContent || ""), m);
      touched.add(p);
    }
    touched.forEach((p) => {
      try {
        p.normalize();
      } catch (_) {}
    });
  }
  function rsFindPaint(scroll) {
    const hits = RSF.hits || [];
    for (let i = 0; i < hits.length; i++) hits[i].classList.toggle("rs-find-on", i === RSF.cur);
    if (RS.findCountEl) RS.findCountEl.textContent = hits.length ? RSF.cur + 1 + "/" + hits.length : "0/0";
    const cur = hits[RSF.cur];
    if (cur && scroll) {
      try {
        cur.scrollIntoView({ block: "center", inline: "nearest" });
      } catch (_) {}
    }
  }
  function rsFindMark() {
    const q = String((RS.findInput && RS.findInput.value) || "");
    RSF.q = q;
    /* 只读投影：两颗替换钮置灰，title 说清为什么 */
    const ro = rsFindReadonly();
    (RS.findRepBtns || []).forEach((b) => {
      b.disabled = ro;
      b.title = ro ? t("第 ") + RS.foldLevel + t(" 层是只读投影：切回「1 全文」才能替换") : b.dataset.title || "";
    });
    const root = rsFindRoot();
    rsFindClear();
    if (!root || !q) {
      if (RS.findCountEl) RS.findCountEl.textContent = "0/0";
      return;
    }
    const hay = q.toLowerCase();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const jobs = [];
    let tn;
    while ((tn = walker.nextNode())) {
      const p = tn.parentElement;
      if (!p) continue;
      const s = String(tn.nodeValue || "");
      if (!s || s.toLowerCase().indexOf(hay) < 0) continue;
      if (p.closest && p.closest(RSF_SKIP)) continue;
      jobs.push(tn);
    }
    const hits = [];
    for (const node of jobs) {
      const s = String(node.nodeValue || "");
      const low = s.toLowerCase();
      let pos = 0;
      let at = low.indexOf(hay);
      let frag = null;
      while (at >= 0) {
        if (!frag) frag = document.createDocumentFragment();
        if (at > pos) frag.appendChild(document.createTextNode(s.slice(pos, at)));
        const mk = el("mark", "rs-find", s.slice(at, at + q.length));
        frag.appendChild(mk);
        hits.push(mk);
        pos = at + q.length;
        at = low.indexOf(hay, pos);
      }
      if (!frag) continue;
      if (pos < s.length) frag.appendChild(document.createTextNode(s.slice(pos)));
      node.parentNode.replaceChild(frag, node);
    }
    RSF.hits = hits;
    RSF.cur = hits.length ? 0 : -1;
    rsFindPaint(true);
  }
  /* 重渲染之后（换页 / 切模式 / 替换落盘 / 预览刷新）重新遍历并计数 */
  function rsFindSync() {
    if (!RS.findEl || RS.findEl.hidden) return;
    rsFindMark();
  }
  function rsFindOpen() {
    if (!RS.findEl) rsFindBuild(RS.editorWrap);
    const bar = RS.findEl;
    if (!bar) return false;
    /* 正文里选中一段再按 Ctrl+F 是最常见的用法：把选中的文字带进查找框 */
    const sel = window.getSelection ? String(window.getSelection().toString() || "").trim() : "";
    if (sel && sel.length <= 80 && sel.indexOf("\n") < 0 && RS.findInput) {
      RS.findInput.value = sel;
      RSF.q = sel;
    }
    bar.hidden = false;
    if (RS.findInput) {
      try {
        RS.findInput.focus();
        RS.findInput.select();
      } catch (_) {}
    }
    rsFindMark();
    return true;
  }
  function rsFindClose() {
    const bar = RS.findEl;
    if (bar) bar.hidden = true;
    RSF.q = "";
    rsFindClear();
    if (RS.findCountEl) RS.findCountEl.textContent = "0/0";
    try {
      if (RS.srcEl && document.body.contains(RS.srcEl)) RS.srcEl.focus();
    } catch (_) {}
  }
  function rsFindStep(dir) {
    const n = (RSF.hits || []).length;
    if (!n) {
      rsFindMark();
      return;
    }
    RSF.cur = ((RSF.cur + dir) % n + n) % n;
    rsFindPaint(true);
  }
  async function rsFindReplace(all) {
    const q = String((RS.findInput && RS.findInput.value) || RSF.q || "");
    if (!q) return;
    if (!RS.curPath) {
      toastSafe(t("先打开一篇笔记"), "warn");
      return;
    }
    if (rsFindReadonly()) {
      toastSafe(t("第 ") + RS.foldLevel + t(" 层是只读投影：切回「1 全文」再替换"), "warn");
      return;
    }
    const rep = String((RS.findRepInput && RS.findRepInput.value) || "");
    const md = readEditorMd();
    /* 正文起点：替换只发生在 frontmatter 之后（YAML 里的标题 / 标签一个字都不动） */
    const bodyStart = md.length - splitFm(md).body.length;
    const body = md.slice(bodyStart);
    const low = body.toLowerCase();
    const key = q.toLowerCase();
    const occ = [];
    let at = low.indexOf(key);
    while (at >= 0) {
      occ.push(at);
      at = low.indexOf(key, at + q.length);
    }
    if (!occ.length) {
      toastSafe(t("正文里没有这段文字（跳过 frontmatter）"), "warn");
      return;
    }
    /* 「替换」只动当前这一处：按命中序号对到正文里的同一处，序号对不上就退回首处 */
    const picks = all ? occ : [occ[Math.max(0, Math.min(occ.length - 1, RSF.cur < 0 ? 0 : RSF.cur))]];
    let out = "";
    let last = 0;
    for (const p of picks) {
      out += body.slice(last, p) + rep;
      last = p + q.length;
    }
    out += body.slice(last);
    const next = md.slice(0, bodyStart) + out;
    if (next === md) return;
    RS.md = next;
    RS.dirty = true;
    if (RS.srcEl) RS.srcEl.value = next;
    if (!(await rsSaveCurrent(next))) {
      /* 写入闸拒了：整笔不落盘，正文回到替换前 */
      RS.md = md;
      RS.dirty = false;
      if (RS.srcEl) RS.srcEl.value = md;
      return;
    }
    if (RS.srcEl) {
      /* 编辑态：预览稍后重渲染（rsSchedulePreview 里会再调一次 rsFindSync 重新计数） */
      rsSchedulePreview();
    } else {
      /* 阅读态：整篇重渲染，新文字当场可读（renderEditor 收尾会重新计数） */
      renderEditor();
    }
    toastSafe(all ? t("已全部替换 ") + picks.length + t(" 处") : t("已替换 1 处"));
  }
  /* Ctrl+F 在研究视图里＝正文内查找（不是画布的全局搜索）：挂在 window 的捕获段，
     先于 app-find.js（输入框内查找，document 捕获）与 app.js（window 冒泡 → 全局搜索）拿到按键。 */
  let findKeyWired = false;
  function wireFindKeys() {
    if (findKeyWired) return;
    findKeyWired = true;
    window.addEventListener(
      "keydown",
      (ev) => {
        const p = qid("researchPane");
        if (!p || p.style.display === "none" || !RS.ready) return;
        if (RS.mode === "graph") return;
        /* 盖在研究视图之上的弹窗自己管按键 */
        const dlg = qid("mtDialog");
        if (dlg && dlg.classList.contains("on")) return;
        const pop = qid("mtPop");
        if (pop && pop.classList.contains("on")) return;
        const key = String(ev.key || "").toLowerCase();
        const mod = ev.ctrlKey || ev.metaKey;
        if (mod && key === "f" && !ev.altKey && !ev.shiftKey) {
          /* 焦点在别的输入框里（会话草稿 / 检索框）：走框内查找，不抢它的 Ctrl+F */
          const tgt = ev.target && ev.target.nodeType === 1 ? ev.target : null;
          const tag = String((tgt && tgt.tagName) || "").toLowerCase();
          const inField = tag === "input" || tag === "textarea" || !!(tgt && tgt.isContentEditable);
          /* 就地编辑的正文自己那块也算「本篇正文」：Ctrl+F 照样开查找条，不交给框内查找 */
          if (inField && !(RS.inlineEl && tgt && RS.inlineEl.contains(tgt)) &&
            !(RS.findEl && tgt && RS.findEl.contains(tgt))) return;
          ev.preventDefault();
          ev.stopPropagation();
          if (!RS.curPath) {
            toastSafe(t("先打开一篇笔记"), "warn");
            return;
          }
          rsFindOpen();
          return;
        }
        if (ev.key === "Escape" && RS.findEl && !RS.findEl.hidden) {
          /* 盖在上面的主弹窗壳（设置 / 素材 / 工具库）开着时，Esc 归它 */
          const ov = qid("overlay");
          if (ov && ov.style.display === "flex") return;
          ev.preventDefault();
          ev.stopPropagation();
          rsFindClose();
        }
      },
      true,
    );
  }

  /* Markdown → 富文本：复用 app-review.js 的同一套实现（公式 / 表格 / 图片往返口径一致）。
     opt.rawFences = 围栏块**不**现场渲成 SVG（```mermaid / ```pele 原样留成
     <pre><code class="language-…">）：编辑面要把它转回 Markdown，渲成 SVG 就只能读到散字了。
     只读面（阅读态 / 预览 / 折叠投影）照旧走替换。 */
  function renderMarkdown(md, opt) {
    const rawFences = !!(opt && opt.rawFences);
    let html = "";
    try {
      html = typeof mdToRichHtml === "function" ? mdToRichHtml(md) : "";
    } catch (_) {
      html = "";
    }
    if (!html) {
      html = esc(md).replace(/\n/g, "<br>");
    }
    /* Pele 代码块：```mermaid / ```pele 现场渲染成 SVG（替换掉 marked 给的 <pre><code>）。
       外面包一层 `.rs-pele`：可点（开全站图片灯箱看大图，绑定见 rsBindPeleZoom）、
       也顺手接住 hover 提示与缩放光标。 */
    if (!rawFences) {
      try {
        html = html.replace(
          /<pre><code class="language-(mermaid|pele)">([\s\S]*?)<\/code><\/pre>/g,
          (all, lang, code) => {
            const src = decodeEntities(code);
            if (!window.MTPele) return all;
            const r = window.MTPele.render(src);
            if (!r.svg) return '<pre class="rs-pele-err">' + esc(src) + "</pre>";
            return (
              '<div class="rs-pele" title="' + esc(t("点击查看大图")) + '">' + r.svg + "</div>"
            );
          },
        );
      } catch (_) {}
    }
    return html;
  }
  /* ── 图（```mermaid / ```pele 渲出来的 SVG）点一下开大图 ──
     为什么走灯箱而不是自己画一层：灯箱那条链（滚轮缩放 / 点图逐级放大 / 1:1 / 适应窗口 /
     放大后拖动平移）已经写好了，这里只负责把图交过去，不再养第二套缩放交互。
     交过去的是 data: 图：灯箱里装的是一只 <img>，页面里的 CSS 变量在 <img> 内不生效，
     所以序列化前先把每个元素的 fill / stroke / 字体按**计算值**钉死 ——
     否则大图里的字会退回兜底色（亮色主题下等于看不见）。 */
  let rsPeleZoomBound = false;
  function rsSvgDataUrl(svg) {
    const clone = svg.cloneNode(true);
    const src = [svg, ...svg.querySelectorAll("*")];
    const dst = [clone, ...clone.querySelectorAll("*")];
    const paint = (to, cs) => {
      const tag = String(to.tagName || "").toLowerCase();
      if (tag === "rect" || tag === "circle" || tag === "ellipse" || tag === "polygon" || tag === "path") {
        to.setAttribute("fill", cs.fill && cs.fill !== "none" ? cs.fill : "none");
        to.setAttribute("stroke", cs.stroke && cs.stroke !== "none" ? cs.stroke : "none");
        if (cs.strokeWidth) to.setAttribute("stroke-width", cs.strokeWidth);
        return;
      }
      if (tag === "line") {
        to.setAttribute("stroke", cs.stroke && cs.stroke !== "none" ? cs.stroke : "none");
        if (cs.strokeWidth) to.setAttribute("stroke-width", cs.strokeWidth);
        return;
      }
      if (tag === "text") {
        to.setAttribute("fill", cs.fill && cs.fill !== "none" ? cs.fill : "none");
        to.setAttribute("font-family", cs.fontFamily || "system-ui");
        to.removeAttribute("class");
      }
      /* svg / defs / marker 这类容器不动：它们只负责继承与摆放，改了反而会把子元素连坐 */
    };
    for (let i = 0; i < src.length && i < dst.length; i++) {
      try {
        paint(dst[i], window.getComputedStyle(src[i]));
      } catch (_) {}
    }
    /* 定死画布尺寸：<img> 的天然尺寸就从这两个属性来（缺了灯箱只会显示空框） */
    const vb = String(clone.getAttribute("viewBox") || "").split(/[\s,]+/).map(Number);
    if ((!clone.getAttribute("width") || !clone.getAttribute("height")) && vb.length === 4) {
      if (vb[2] > 0) clone.setAttribute("width", String(vb[2]));
      if (vb[3] > 0) clone.setAttribute("height", String(vb[3]));
    }
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    const xml = new XMLSerializer().serializeToString(clone);
    return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(xml);
  }
  function rsBindPeleZoom() {
    if (rsPeleZoomBound || typeof document === "undefined") return;
    rsPeleZoomBound = true;
    /* 委托挂在 document 上：阅读态 / 索引页原文态 / 节级折叠 / 浮层预览里的图都走这一处，
       不必每个渲染入口各绑一次（图是 innerHTML 铺出来的，绑在元素上会随重渲染丢）。 */
    document.addEventListener(
      "click",
      (ev) => {
        const tgt = ev.target && ev.target.nodeType === 1 ? ev.target : null;
        const svg = tgt && tgt.closest ? tgt.closest(".rs-pele > svg.pele-svg") : null;
        if (!svg || typeof openImageLightbox !== "function") return;
        ev.preventDefault();
        ev.stopPropagation();
        let url = "";
        try {
          url = rsSvgDataUrl(svg);
        } catch (_) {
          url = "";
        }
        if (!url) {
          toastSafe(t("这张图打不开大图（导出失败）"), "warn");
          return;
        }
        openImageLightbox(url, t("关系图"));
      },
      true,
    );
  }
  /* 图链路的小出口：`renderMarkdown`（围栏 → `.rs-pele` + SVG）、`dataUrl`（SVG → 灯箱能吃的
     data: 图）、`bind`（点图开灯箱的委托，renderEditor 第一次渲染时自动调）。
     给冒烟脚本一条真入口（test/smoke-research-pele.js），别的视图要复用也走这里。 */
  window.MTResearchPele = { renderMarkdown: renderMarkdown, dataUrl: rsSvgDataUrl, bind: rsBindPeleZoom };
  /* ── 正文插图：相对引用按「当前笔记所在目录」解析 ──
     盘上正文里的 `![图注](assets/x.png)` 是相对**这篇笔记**的，阅读态直接把相对路径塞进
     <img src> 就是一只裂图。这里把 src 换成 file:/// 绝对 URL，原始相对路径记在 data-rv-src 上
     —— 就地编辑面回写时 richToMarkdown 优先读它，正文里的相对路径一个字符都不会被改掉。
     只读面（阅读态 / 源码右预览 / 索引页原文态）再包一层 .rs-fig：居中等宽、alt 当图注、
     点开灯箱看原图；文件不在就换一行「缺图：…」，不留裂图。
     opt.fig = false（就地编辑面）只做 src / data-rv-src 两步：包 <figure> 会把图注文字
     带进正文，richToMarkdown 当场把它当段落写回 Markdown。 */
  function rsNoteDir() {
    const root = String(RS.root || "");
    if (!root) return "";
    const p = String(RS.curPath || "");
    const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
    return i > 0 ? joinP(root, p.slice(0, i)) : root;
  }
  function rsFileUrl(p) {
    const m = window.MTInlineImg;
    if (m && typeof m.fileUrl === "function") {
      try {
        const u = m.fileUrl(p);
        if (u) return u;
      } catch (_) {}
    }
    return String(p || "");
  }
  function rsResolveImgs(root, opt) {
    if (!root || !root.querySelectorAll) return;
    const dir = rsNoteDir();
    if (!dir) return; /* 没有笔记目录（未就绪 / 虚拟文档）：相对引用无从解析，原样留着 */
    const fig = !(opt && opt.fig === false);
    root.querySelectorAll("img").forEach((img) => {
      const raw = String(img.getAttribute("src") || "").trim();
      if (!raw) return;
      /* 只有相对引用要解析：http(s) / data: / file: / 绝对路径原样保留 */
      if (/^(https?:|data:|file:|blob:|\/\/)/i.test(raw)) return;
      if (/^[a-zA-Z]:[\\/]/.test(raw) || raw.charAt(0) === "/" || raw.charAt(0) === "\\") return;
      let rel = raw;
      try {
        rel = decodeURIComponent(raw);
      } catch (_) {}
      const abs = joinP(dir, rel);
      img.setAttribute("data-rv-src", raw);
      img.setAttribute("src", rsFileUrl(abs));
      if (fig) rsImgFigure(img, abs, raw);
    });
  }
  /* 一颗粒子：<figure class="rs-fig"><img><figcaption>alt</figcaption></figure>
     独占一段的图（<p> 里只有它）连 <p> 一起换掉，免得留一个空段落。 */
  function rsImgFigure(img, abs, raw) {
    const parent = img.parentNode;
    if (!parent || (parent.classList && parent.classList.contains("rs-fig"))) return;
    const alt = String(img.getAttribute("alt") || "").trim();
    const onlyP =
      parent.nodeName === "P" &&
      !String(parent.textContent || "").trim() &&
      parent.querySelectorAll("img").length === 1;
    const host = onlyP ? parent.parentNode : parent;
    if (!host) return;
    const box = document.createElement("figure");
    box.className = "rs-fig";
    box.setAttribute("data-rs-img", abs);
    /* 先把壳挂进 DOM（独占段落的图挂到 <p> 原来的位置），再把 <img> 挪进壳里 ——
       反过来做的话，img 已经不在原父节点上了，insertBefore 的参照点当场失效。 */
    host.insertBefore(box, onlyP ? parent : img);
    img.classList.add("rs-fig-img");
    img.title = t("点击查看原图");
    box.appendChild(img);
    if (alt) {
      const cap = document.createElement("figcaption");
      cap.className = "rs-fig-cap";
      cap.textContent = alt;
      box.appendChild(cap);
    }
    img.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (typeof openImageLightbox === "function") openImageLightbox(abs, alt || raw);
    });
    if (onlyP) parent.remove();
    rsImgCheck(box, abs, raw);
  }
  /* 落盘探针：文件不在就把这颗粒子换成一行提示（异步回来时重渲染已经把它换掉了就什么都不做）。 */
  function rsImgCheck(box, abs, raw) {
    if (!window.api || typeof window.api.fileStat !== "function") return;
    window.api
      .fileStat(abs)
      .then((r) => {
        if (r && r.ok) return;
        if (!box.isConnected || !box.parentNode) return;
        const miss = document.createElement("div");
        miss.className = "rs-img-miss";
        miss.textContent = t("缺图：") + raw;
        box.parentNode.replaceChild(miss, box);
      })
      .catch(() => {});
  }
  function decodeEntities(s) {
    return String(s)
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, "&");
  }
  /* callout 装饰：只加类与 data-*，**不动文字** —— 文字里的 `[!claim]` 是回写 Markdown 的标记，
     改掉它等于把语义抹了（下一次保存图谱就少一条论断）。视觉差异全部交给 CSS。 */
  function decorateCallouts(root) {
    if (!root) return;
    root.querySelectorAll("blockquote").forEach((q) => {
      const first = q.firstElementChild;
      if (!first) return;
      const m = /^\s*\[!([A-Za-z-]+)(?:\|([A-Za-z-]+))?\]/.exec(first.textContent || "");
      if (!m) return;
      const kind = m[1].toLowerCase();
      const mod = (m[2] || "").toLowerCase();
      q.classList.add("rs-callout", "rs-callout-" + kind);
      q.dataset.callout = mod ? kind + "|" + mod : kind;
    });
  }
  function readEditorMd() {
    if (RS.srcEl) return RS.srcEl.value;
    /* 就地编辑面：正文就是 DOM —— 取最新的 DOM 转回 Markdown（只替换 frontmatter 之后的正文段）。
       rsInlineMd 返回 null（没有编辑面 / 转换器没加载）就退回内存里那份，不拿空串覆盖。 */
    if (RS.inlineOn) {
      const md = rsInlineMd();
      if (md != null) return md;
    }
    return RS.md;
  }

  let saveTimer = null;
  function rsScheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => rsSaveCurrent(), 900);
  }
  async function rsSaveCurrent(override) {
    if (!RS.curPath || !RS.root) return true;
    /* 折叠的第 2/3 层是只读投影：不落盘（否则会把 AI 层写回真源） */
    if (RS.foldPath && RS.foldPath === RS.curPath && RS.foldLevel > 1) return true;
    /* override：正文级写入（批注 / 论断 / 插入 Pele）已经把新的 Markdown 算好了，
       此时 DOM 还是旧的 —— 再从 DOM 读一次会把刚写进去的块整段丢掉（真机踩过）。 */
    const md = typeof override === "string" ? override : readEditorMd();
    if (md === RS.md && !RS.dirty) return true;
    /* 写入闸（金色版本优先）：同组里有金色、要写的却是别的版本 → 先问一句，默认取消。
       拒绝就整笔不落盘：文件、changes.jsonl、下游扫描都不发生，编辑器里那段输入原样留着。 */
    if (!(await rsWriteGate(RS.curPath))) {
      RS.dirty = true;
      rsSetSaveState("cancelled");
      return false;
    }
    const rec = RS.notes.find((n) => n.path === RS.curPath);
    const foldRec = (RS.folds || []).find((f) => f.path === RS.curPath);
    const srcRec = (RS.srcDocs || []).find((f) => f.path === RS.curPath);
    const before = rec ? rec.md : foldRec ? foldRec.md : srcRec ? srcRec.md : "";
    /* 落盘前的「旧名字」：标题与别名（只对笔记算 —— 折叠文件不进 [[…]] 的命名空间） */
    const oldNames = [];
    if (rec) {
      const oldNote = (rec.parsed && rec.parsed.note) || {};
      if (rec.title) oldNames.push(rec.title);
      if (Array.isArray(oldNote.aliases)) oldNames.push(...oldNote.aliases);
    }
    RS.md = md;
    RS.dirty = false;
    await window.api.fileWriteText(joinP(RS.root, RS.curPath), md);
    if (before !== md) await logChange(t("编辑笔记"), RS.curPath, before, md);
    if (rec) {
      rec.md = md;
      rec.parsed = C().parseNote({ path: rec.path, md });
      rec.title = rec.parsed.note.label;
    }
    if (foldRec) {
      foldRec.md = md;
      const model = C().parseFolds(md);
      foldRec.title = model.title || foldRec.title;
      foldRec.count = model.paragraphs.length;
    }
    if (srcRec) srcRec.md = md;
    rsSetSaveState("saved");
    RS.lastSavedAt = Date.now();
    /* 增量：图已建过就只更新投影（保持节点位置，不重排，避免视线被甩走） */
    if (RS.graph) rsRebuildGraph({ keepPositions: true, silent: true });
    /* 刚落盘的字节可能就是这一版变金 / 变橙（或把整组带回绿）的原因：判色缓存先作废，
       下面这次重画才会按新字节算三态，而不是沿用保存前那一轮的颜色 */
    rsStatusReset();
    renderSide();
    renderReadTools();
    /* 刚写进去的字节可能就是这一组的金色由来：树上金色行与平铺条要当场变色，
        不能等换笔记才更新（自动保存 900ms 一次，这里只重建顶栏那一行，不比 renderSide 重） */
    renderTop();
    /* 标题 / 别名被改掉：别的笔记里还写着旧名字的 [[…]] 全成了断链 ——
       列出来让用户当场决定保留还是删。自动保存 900ms 一次，打字过程中标题会经过一串
       中间态（A → AB → ABC）：这里先攒着、停手一会儿再判一次，别每敲一个字弹一块面板。 */
    if (rec && oldNames.length) rsDeadLater(oldNames, RS.curPath);
    return true;
  }

  /* ── 断链提醒（dead links）──
     上游笔记的标题 / 别名被改掉、或整篇被删掉之后，别的笔记里还写着 [[旧标题]] 的地方
     就成了断链（点下去只会弹「库里没有这条笔记」）。这里把那些位置一次列成一张清单，
     让用户当场决定：
       · 保留 = 一字不动（也许马上要把标题改回去，或打算换个库）
       · 删除 = 只摘掉 [[ ]] 这一层包裹（[[旧标题]] → 旧标题、[[旧|显示]] → 显示），
                正文一个字不删；每篇各记一条 changes.jsonl，撤销照样退得回去。
     判据是「这个名字在库里还认不认」（标题 / label / 别名任一命中）—— 不看缓存，不看印象。 */
  let rsDeadEl = null;
  let rsDeadEsc = null;
  /* 还没弹的那一批旧名字：自动保存一次一次地来，名字会经过一串中间态 ——
     全部攒进这个集合，停手 1.5s 之后只判一次（结果里自然只剩真正已经不在库里的那些）。 */
  let rsDeadPending = null;
  let rsDeadTimer = null;
  function rsDeadLater(names, skipPath) {
    if (!rsDeadPending) rsDeadPending = { names: new Set(), skip: skipPath || "" };
    if (skipPath) rsDeadPending.skip = skipPath;
    for (const n of names || []) {
      const s = String(n || "").trim();
      if (s) rsDeadPending.names.add(s);
    }
    if (rsDeadTimer) clearTimeout(rsDeadTimer);
    const batch = rsDeadPending;
    rsDeadTimer = setTimeout(() => {
      rsDeadTimer = null;
      if (rsDeadPending === batch) rsDeadPending = null;
      void rsDeadOpen(Array.from(batch.names), batch.skip);
    }, 1500);
  }
  function rsDeadClose() {
    if (rsDeadEsc) document.removeEventListener("keydown", rsDeadEsc, true);
    rsDeadEsc = null;
    if (rsDeadEl) rsDeadEl.remove();
    rsDeadEl = null;
  }
  /* 这个名字在库里还认不认（与 rsOpenLinkByName 同一口径：标题 / label / 别名） */
  function rsNameAlive(name) {
    const key = String(name || "").trim();
    if (!key) return true;
    return (RS.notes || []).some((n) => {
      const note = (n.parsed && n.parsed.note) || {};
      const aliases = Array.isArray(note.aliases) ? note.aliases : [];
      return n.title === key || note.label === key || aliases.indexOf(key) >= 0;
    });
  }
  /* 扫全库：哪几篇里还写着指向这些名字的 [[…]]（跳过发源地那一篇） */
  function rsDeadScan(names, skipPath) {
    const set = new Set((names || []).map((s) => String(s || "").trim()).filter(Boolean));
    if (!set.size) return [];
    const out = [];
    for (const n of RS.notes || []) {
      if (!n.md || n.path === skipPath) continue;
      const lines = String(n.md).split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const re = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;
        let m;
        while ((m = re.exec(lines[i]))) {
          const target = String(m[1] || "").trim();
          if (!set.has(target)) continue;
          out.push({
            path: n.path,
            title: n.title || n.path,
            line: i + 1,
            target: target,
            display: String(m[2] || target).trim(),
            snippet: lines[i].trim().slice(0, 120),
          });
        }
      }
    }
    return out;
  }
  /* 摘掉 [[…]] 这层包裹：只留显示文字，正文其余一字不动 */
  function rsDeadUnlink(md, targets) {
    const set = new Set(targets);
    return String(md || "").replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (all, tg, dp) => {
      const target = String(tg || "").trim();
      if (!set.has(target)) return all;
      return String(dp || target).trim();
    });
  }
  async function rsDeadOpen(names, skipPath) {
    if (!RS.root) return;
    const gone = (names || [])
      .map((s) => String(s || "").trim())
      .filter((s) => s && !rsNameAlive(s));
    if (!gone.length) return;
    const hits = rsDeadScan(gone, skipPath);
    if (!hits.length) return;
    rsDeadClose();
    if (typeof closeNodePopsExcept === "function") closeNodePopsExcept("");
    const box = el("div", "rs-ask wide rs-dead");
    const paneEl = pane();
    if (paneEl && paneEl.classList.contains("rs-light")) box.classList.add("rs-light");
    if (paneEl && paneEl.classList.contains("rs-bg-paper-light")) box.classList.add("rs-bg-paper-light");
    box.innerHTML =
      '<div class="rs-ask-head"><b>' +
      esc(t("链接被断开：")) +
      esc(gone.join(" / ")) +
      '</b><button class="rs-ask-x" type="button" title="' +
      esc(t("关闭")) +
      '">✕</button></div>' +
      '<div class="rs-dead-tip">' +
      esc(
        t(
          "这些笔记里还写着旧名字，点过去已经找不到那篇笔记了。可以保留（一个字节都不动，之后自己改标题或补回那篇），也可以删掉这些链接（只摘掉 [[ ]] 这一层，显示文字留在原处）。",
        ),
      ) +
      "</div>" +
      '<ul class="rs-dead-list"></ul>' +
      '<div class="rs-ask-row"><button class="rs-btn primary" data-a="del">' +
      esc(t("删除这些链接")) +
      '</button><button class="rs-btn" data-a="keep">' +
      esc(t("保留")) +
      "</button></div>";
    document.body.appendChild(box);
    const list = box.querySelector(".rs-dead-list");
    for (const h of hits) {
      const li = el("li", "rs-dead-item");
      li.appendChild(el("b", "rs-dead-path", h.path));
      li.appendChild(el("span", "rs-dead-line", t("第 ") + h.line + t(" 行")));
      li.appendChild(el("span", "rs-dead-link", "[[" + h.target + "]]"));
      li.appendChild(el("span", "rs-dead-snip", h.snippet));
      list.appendChild(li);
    }
    box.style.left = Math.max(12, Math.round((window.innerWidth - (box.offsetWidth || 560)) / 2)) + "px";
    box.style.top = Math.max(12, Math.round(window.innerHeight * 0.12)) + "px";
    rsDeadEl = box;
    rsDeadEsc = (ev) => {
      if (ev.key !== "Escape") return;
      ev.stopPropagation();
      rsDeadClose();
    };
    document.addEventListener("keydown", rsDeadEsc, true);
    box.querySelector(".rs-ask-x").onclick = () => rsDeadClose();
    box.querySelector('[data-a="keep"]').onclick = () => rsDeadClose();
    box.querySelector('[data-a="del"]').onclick = () => {
      void rsDeadDelete(hits);
    };
  }
  async function rsDeadDelete(hits) {
    const byPath = new Map();
    for (const h of hits) {
      if (!byPath.has(h.path)) byPath.set(h.path, new Set());
      byPath.get(h.path).add(h.target);
    }
    let changed = 0;
    for (const [path, targets] of byPath) {
      const rec = (RS.notes || []).find((n) => n.path === path);
      if (!rec) continue;
      const before = String(rec.md || "");
      const after = rsDeadUnlink(before, targets);
      if (after === before) continue;
      try {
        await window.api.fileWriteText(joinP(RS.root, path), after);
        await logChange(t("断开链接"), path, before, after);
        rec.md = after;
        rec.parsed = C().parseNote({ path: path, md: after });
        if (RS.curPath === path && !RS.dirty) RS.md = after;
        changed++;
      } catch (_) {}
    }
    rsDeadClose();
    if (!changed) {
      toastSafe(t("没有改动：这些链接已经不在了"), "warn");
      return;
    }
    rsStatusReset();
    rsVersionsKick();
    renderSide();
    renderTop();
    renderReadTools();
    if (RS.graph) await rsRebuildGraph({ keepPositions: true, silent: true });
    if (RS.curPath && !RS.dirty && document.activeElement !== RS.srcEl) renderEditor();
    toastSafe(t("已摘掉 ") + changed + t(" 篇里的断链（显示文字留在原处）"));
  }

  /* 阅读态的键盘绑定（Ctrl+S 存盘）。
   * 选区浮动条已整体移除：它在文档级 selectionchange 上弹，只要研究视图开着，
   * 在应用任何地方选字都会冒出「批注 / 问 AI / 改成论断」那一排（见 RS.selHost 口径）。
   * 批注改走正文上方那条批注行（「局部批注」/「全文批注」，见 rsAnnoBarRender）。 */
  function bindEditorKeys(ed) {
    if (!ed || ed.dataset.selBound === "1") return;
    ed.dataset.selBound = "1";
    ed.addEventListener("keydown", (ev) => {
      if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "s") {
        ev.preventDefault();
        rsSaveCurrent();
      }
    });
  }
  /* 正文级写入：把一段块追加到「选区所在块」之后；找不到就追加到文末。
     只做字符串手术，不碰 DOM —— 富文本模式的下一帧会整体重渲染，不会出现半截标记。 */
  function blockOfSelection(md, quote) {
    const parsed = C().parseNote({ path: RS.curPath || "notes/x.md", md });
    const q = String(quote || "").replace(/\s+/g, " ").trim();
    if (!q) return null;
    let best = null;
    for (const b of parsed.blocks || []) {
      if (!b.raw) continue;
      const norm = b.raw.replace(/^\s*>\s?/gm, "").replace(/\s+/g, " ");
      if (norm.indexOf(q.slice(0, Math.min(40, q.length))) >= 0) {
        best = b;
        break;
      }
    }
    if (best) return best;
    /* 跨块 / 片段：退化成「找包含选区首词的那一块」 */
    const head = q.slice(0, 12);
    for (const b of parsed.blocks || []) {
      if (b.raw && b.raw.indexOf(head) >= 0) return b;
    }
    return null;
  }
  function insertAfterBlock(md, block, snippet) {
    const lines = String(md).split(/\r?\n/);
    /* 下限：frontmatter 的最后一行。块行号万一算错，宁可追加到正文开头，也不能写进 YAML。 */
    const head = splitFm(md).head;
    const floor = head ? head.split(/\r?\n/).length : 0;
    if (!block) {
      const tail = String(md).replace(/\s*$/, "");
      return tail + "\n\n" + snippet + "\n";
    }
    const at = Math.max(floor, Math.min(lines.length, (block.endLine || block.line || 1) - 1));
    const out = lines.slice(0, at + 1);
    out.push("");
    out.push(...snippet.split("\n"));
    out.push(...lines.slice(at + 1));
    return out.join("\n");
  }
  function quoteLine(quote) {
    return String(quote || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 160);
  }

  async function rsAnnotate(kind, quote) {
    const sel = quote || (window.getSelection ? String(window.getSelection().toString() || "") : "");
    const q = quoteLine(sel);
    if (!RS.curPath) {
      toastSafe(t("先打开一篇笔记"), "warn");
      return;
    }
    const md = readEditorMd();
    const blk = blockOfSelection(md, q);
    let body = "";
    if (kind === "claim") {
      body =
        "> [!claim] " +
        (q.slice(0, 30) || t("论断")) +
        "\n> " +
        (q || t("写一句可验证的陈述")) +
        "\n> 来源: [[文献笔记]]\n> verify: unverified";
    } else if (kind === "question") {
      body = "> [!question] " + (q.slice(0, 30) || t("待解决问题")) + "\n> " + (q || t("问题描述"));
    } else {
      body = "> [!note] 批注（引用：" + (q.slice(0, 30) || "—") + "）\n> " + (q || t("写你的批注"));
    }
    const next = insertAfterBlock(md, blk, body);
    RS.md = next;
    RS.dirty = true;
    if (RS.srcEl) RS.srcEl.value = next;
    if (!(await rsSaveCurrent(next))) {
      /* 闸拒了：整笔不落盘，正文退回插入前（不让半截块留在界面上） */
      RS.md = md;
      RS.dirty = false;
      if (RS.srcEl) RS.srcEl.value = md;
      renderEditor();
      return;
    }
    renderEditor();
    if (RS.graph) rsRebuildGraph({ keepPositions: true, silent: true });
    toastSafe(t("已写入 ") + C().NODE_KINDS[kind === "question" ? "question" : kind === "claim" ? "claim" : "annotation"]);
  }

  /* ── 正文写入：一律落进源码（编辑态），不再走 contentEditable 往返 ──
   * 为什么这样改：富文本态把 ```mermaid 渲成 SVG，保存时 richToMarkdown 只能读回 SVG 的文字，
   * 围栏 / 语言标记全丢 —— 流程图（旧「Pele」按钮）插进去一保存就烂成「是/问题/可分解?」的散字，
   * 用户看到的就是「点了没反应 / 图没了」。源码是真源，预览只是投影。 */
  /* 笔记与折叠文件的全文层都能进源码态；只有折叠的第 2/3 层（只读投影）不给改，
     调用方（插入标题 / 公式 / 流程图 / 引用）这时自行退到「追加到文末」的正文级写入。 */
  function rsEnsureEdit() {
    const isFold = !!RS.foldPath && RS.foldPath === RS.curPath;
    if (isFold && RS.foldLevel > 1) return null;
    if (RS.editorMode !== "edit") {
      /* 从就地编辑面切过来：先把 DOM 里的输入转回 md（不然那几个字跟着重渲染一起没了） */
      RS.md = readEditorMd();
      RS.inlineOn = false;
      RS.editorMode = "edit";
      renderEditor();
    }
    return RS.srcEl || null;
  }
  /* 源码里就地插一小段（Tab 缩进用）：不重排、不抢滚动 */
  function rsInsertRaw(text) {
    const ta = RS.srcEl;
    if (!ta) return;
    const start = typeof ta.selectionStart === "number" ? ta.selectionStart : ta.value.length;
    const end = typeof ta.selectionEnd === "number" ? ta.selectionEnd : start;
    const v = ta.value;
    ta.value = v.slice(0, start) + text + v.slice(end);
    const at = start + text.length;
    ta.setSelectionRange(at, at);
    RS.md = ta.value;
    RS.dirty = true;
    rsSetSaveState("dirty");
    rsSchedulePreview();
    rsScheduleSave();
  }
  function rsSetBody(next, caret) {
    RS.md = next;
    RS.dirty = true;
    const ta = rsEnsureEdit();
    if (ta) {
      ta.value = next;
      const at = typeof caret === "number" ? caret : next.length;
      try {
        ta.focus();
        ta.setSelectionRange(at, at);
        /* 把光标滚进视野：按行数粗算，够用（真正的高度由 CSS 决定，行高 20px） */
        const lines = next.slice(0, at).split(/\r?\n/).length;
        ta.scrollTop = Math.max(0, lines * 20 - ta.clientHeight / 2);
      } catch (_) {}
    }
    rsSetSaveState("dirty");
    rsSchedulePreview();
    rsScheduleSave();
  }
  /* 光标落点：在 frontmatter 里就退到正文末尾（往 YAML 里插 markdown 只会把头部写坏） */
  function rsCaretIn(ta) {
    const v = String(ta.value || "");
    const at = typeof ta.selectionStart === "number" ? ta.selectionStart : v.length;
    const fm = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(v);
    if (fm && at < fm[0].length) return v.length;
    return at;
  }
  function rsInsertText(snippet) {
    if (!RS.curPath) {
      toastSafe(t("先打开一篇笔记"), "warn");
      return false;
    }
    const body = String(snippet || "").replace(/^\n+/, "").replace(/\s+$/, "\n");
    const ta = rsEnsureEdit();
    /* 笔记只剩阅读态：没有源码框可插，就当成一次正文级写入 —— 追加到文末再重渲染。
       与批注 / 论断同一条路，「插入引用」不因为拿掉了源码框就失效。 */
    if (!ta) {
      const prev = String(RS.md || "");
      const next = prev.replace(/\s*$/, "") + "\n\n" + body;
      RS.md = next;
      RS.dirty = true;
      renderEditor();
      /* 写入闸在 rsSaveCurrent 里：被拒就整笔不落盘，正文回到插入前 */
      void rsSaveCurrent(next).then((ok) => {
        if (ok) return;
        RS.md = prev;
        RS.dirty = false;
        renderEditor();
      });
      return true;
    }
    const v = ta.value;
    const at = rsCaretIn(ta);
    const next = v.slice(0, at).replace(/\s*$/, "\n\n") + body + v.slice(at);
    rsSetBody(next, at + body.length);
    return true;
  }
  function rsWrapSelection(a, b) {
    if (!RS.curPath) return toastSafe(t("先打开一篇笔记"), "warn");
    const sel = window.getSelection ? String(window.getSelection().toString() || "") : "";
    if (!sel) return rsInsertText(a + t("内容") + b);
    const md = readEditorMd();
    const at = md.indexOf(sel);
    if (at < 0) return rsInsertText(a + sel + b);
    const next = md.slice(0, at) + a + sel + b + md.slice(at + sel.length);
    rsSetBody(next, at + a.length + sel.length + b.length);
  }
  /* ── 选区右键菜单里要动源码的两项（阅读器只回调，md 与落盘都在这儿）──
   * 创建链接：把选中的那段文字在**正文**里包成 `[[…]]`（frontmatter 不参与，原样留着）；
   *           源码里找不到这段原文（渲染把空白 / 标记拉开了）就退回编辑态，把 `[[…]]` 插到光标处。
   * 剪切：只认编辑态，删的是源码（textarea）里那段 —— setRangeText 删字，删掉的写进剪贴板。
   * 落盘照旧走 rsSaveCurrent / rsScheduleSave：写入闸、changes.jsonl、图谱增量一个不少。 */
  async function rsWrapLinkText(text) {
    /* 双链名要能当笔记标题：换行与连续空白折成一个空格，别把整段硬塞进 [[…]] */
    const raw = String(text == null ? "" : text)
      .replace(/\s+/g, " ")
      .trim();
    if (!raw) return false;
    if (!RS.curPath) {
      toastSafe(t("先打开一篇笔记"), "warn");
      return false;
    }
    if (RS.foldPath && RS.foldPath === RS.curPath && RS.foldLevel > 1) {
      toastSafe(t("第 ") + RS.foldLevel + t(" 层是只读投影：切回「1 全文」再创建链接"), "warn");
      return false;
    }
    const snippet = "[[" + raw + "]]";
    const md = readEditorMd();
    /* 正文起点：替换只发生在 frontmatter 之后 */
    const headLen = md.length - splitFm(md).body.length;
    const at = md.indexOf(raw, headLen);
    if (at >= headLen) {
      const next = md.slice(0, at) + snippet + md.slice(at + raw.length);
      RS.md = next;
      RS.dirty = true;
      if (RS.srcEl) RS.srcEl.value = next;
      if (!(await rsSaveCurrent(next))) {
        /* 闸拒了：整笔不落盘，正文回到替换前 */
        RS.md = md;
        RS.dirty = false;
        if (RS.srcEl) RS.srcEl.value = md;
        renderEditor();
        return false;
      }
      /* 落盘成功：阅读态整篇重渲染（新 [[…]] 当场变成可点的双链）；
         编辑态只换源码框里的字并把光标留在替换之后，不重排整个编辑器 */
      if (RS.srcEl) {
        const taEdit = RS.srcEl;
        taEdit.value = next;
        try {
          taEdit.focus();
          taEdit.setSelectionRange(at + snippet.length, at + snippet.length);
        } catch (_) {}
        rsSchedulePreview();
      } else {
        renderEditor();
      }
      toastSafe(t("已创建链接 ") + snippet);
      return true;
    }
    /* 源码里没有这段原文：切编辑态，把 `[[…]]` 插到光标处（不猜位置、不动别处） */
    const ta = rsEnsureEdit();
    if (!ta) {
      toastSafe(t("这里改不了原文（只读）"), "warn");
      return false;
    }
    const v = String(ta.value || "");
    const caret = rsCaretIn(ta);
    const next = v.slice(0, caret) + snippet + v.slice(caret);
    rsSetBody(next, caret + snippet.length);
    toastSafe(t("源码里没有这段原文，已把 ") + snippet + t(" 插到光标处"));
    return true;
  }
  function rsCutSelection(text) {
    if (RS.editorMode !== "edit" || !RS.srcEl) return false;
    const ta = RS.srcEl;
    const want = String(text == null ? "" : text);
    let start = typeof ta.selectionStart === "number" ? ta.selectionStart : 0;
    let end = typeof ta.selectionEnd === "number" ? ta.selectionEnd : start;
    /* 光标处选中的不是这一段（比如右键选的是右侧预览里的字）：按那段文字在源码里定位，
       选中它再删 —— setRangeText 删的始终是 textarea 里那一段。 */
    if (!(end > start) || ta.value.slice(start, end) !== want) {
      const at = want ? ta.value.indexOf(want) : -1;
      if (at < 0) return false;
      start = at;
      end = at + want.length;
      ta.setSelectionRange(start, end);
    }
    const cut = ta.value.slice(start, end);
    ta.setRangeText("", start, end, "end");
    RS.md = ta.value;
    RS.dirty = true;
    rsSetSaveState("dirty");
    rsSchedulePreview();
    rsScheduleSave();
    try {
      /* 剪贴板只走唯一出口（app-clipboard.js）：成功报「已剪切」，失败报准确原因 */
      appClipboardCopy(cut, t("已剪切"));
    } catch (_) {}
    return true;
  }
  /* 流程图：mermaid flowchart 代码块（渲染器仍是 Pele，只是入口叫「流程图」） */
  function rsInsertFlowchart() {
    const code = [
      "```mermaid",
      "flowchart TD",
      "  A[问题] --> B{可分解?}",
      "  B -->|是| C[拆成子问题]",
      "  B -->|否| D[查文献]",
      "  C --> D",
      "  D --> E[写论断]",
      "```",
      "",
    ].join("\n");
    if (!rsInsertText(code)) return;
    toastSafe(
      RS.srcEl
        ? t("已插入流程图：左边改源码，右边实时预览，点「完成」回到阅读态")
        : t("已追加流程图到文末"),
    );
  }
  /* 旧名保留：外部脚本 / 旧入口还在调 rsInsertPele 时行为一致 */
  function rsInsertPele() {
    rsInsertFlowchart();
  }

  /* ── 框选询问（浮窗就地回答 + 一键落图）── */
  /* 走哪个服务商 / 哪只模型 —— 与设置 · 默认模型同一口径，不再自己另判一套：
     ① 设置里设了默认模型（S.config.dsh.model）且本机能挂它 → 就用那条路由与那只模型；
     ② 没设 / 那只不可用 → 本机有效的智能路由里第一只能跑文本的服务商（有 Key / 中转卡优先）；
     ③ 再兜底：任何含文本模型的服务商（混挂端点、没配默认模型的旧库）。
     以前只认「type=text_openai 且有 API Key」，于是中转卡（Key 由账号登录托管）、
     混挂端点、以及设了默认模型却没在第一张卡上的情况都报「没有可用的文本模型」。
     真的一个文本服务商都没有时仍返回 null，由调用点给出指路错误。 */
  function resolveProv() {
    const cfg = (window.S && S.config) || {};
    const list = cfg.providers || [];
    const provOfRoute = (route) => {
      try {
        const p = typeof providerForAgentRoute === "function" ? providerForAgentRoute(route) : null;
        if (p) return p;
      } catch (_) {}
      /* 路由反查不到（type 不是 text_openai 的混挂端点）：按 id 直取，形态由 providerHasKind 判 */
      const id = String(route || "").indexOf("mtnode_") === 0 ? String(route).slice("mtnode_".length) : "";
      if (!id) return null;
      return list.find((x) => x && x.id === id) || null;
    };
    const hasKey = (p) =>
      !!String(p.apiKey || "").trim() || String(p.source || "").toLowerCase().indexOf("relay") >= 0;
    const isText = (p) =>
      typeof providerHasKind === "function" ? providerHasKind(cfg, p, "text") : p.type === "text_openai";
    let noKey = null;
    try {
      const pick = typeof dshDefaultModelPick === "function" ? dshDefaultModelPick() : null;
      if (pick && pick.ok) {
        const p = provOfRoute(pick.route);
        if (p && isText(p)) return Object.assign({}, p, { rsModel: String(pick.model || "") });
      }
    } catch (_) {}
    try {
      const routes = typeof agentRouteOptions === "function" ? Array.from(agentRouteOptions()) : [];
      for (const r of routes) {
        const p = provOfRoute(r);
        if (!p || !isText(p)) continue;
        if (hasKey(p)) return p;
        if (!noKey) noKey = p;
      }
    } catch (_) {}
    for (const p of list) {
      if (!p || !isText(p)) continue;
      if (hasKey(p)) return p;
      if (!noKey) noKey = p;
    }
    return noKey;
  }
  function modelOf(prov) {
    if (prov && prov.rsModel) return String(prov.rsModel);
    const cfg = (window.S && S.config) || {};
    /* 只挑**文本**模型：混挂端点（同一张卡还挂着出图模型）的第一只未必能对话 */
    let models = [];
    try {
      if (typeof modelsOfKind === "function") models = modelsOfKind(cfg, prov, "text") || [];
    } catch (_) {
      models = [];
    }
    if (!models.length) {
      models =
        typeof providerModelFilter === "function" ? providerModelFilter(prov, prov.models) : prov.models || [];
    }
    return String((models && models[0]) || "");
  }
  function rsAskOpen(quote) {
    const old = qid("rsAsk");
    if (old) old.remove();
    const box = el("div", "rs-ask");
    box.id = "rsAsk";
    const head = el("div", "rs-ask-head");
    head.appendChild(el("b", "", t("就这段提问")));
    const close = el("button", "rs-ask-x", "✕");
    close.title = t("关闭");
    close.onclick = () => box.remove();
    head.appendChild(close);
    box.appendChild(head);
    const q = el("blockquote", "rs-ask-quote", quote);
    box.appendChild(q);
    const ta = el("textarea", "rs-ask-input");
    ta.placeholder = t("想问什么？例如：这个式子的前提是什么 / 这句话有反例吗 / 出自哪篇文献");
    box.appendChild(ta);
    const row = el("div", "rs-ask-row");
    const go = el("button", "rs-btn primary", t("提问"));
    const stop = el("button", "rs-btn", t("关闭"));
    stop.onclick = () => box.remove();
    row.appendChild(go);
    row.appendChild(stop);
    box.appendChild(row);
    const out = el("div", "rs-ask-out");
    box.appendChild(out);
    const actions = el("div", "rs-ask-actions");
    box.appendChild(actions);
    document.body.appendChild(box);
    /* 摆到编辑区右侧，不盖住正在读的那段 */
    const bodyRect = RS.bodyEl ? RS.bodyEl.getBoundingClientRect() : { right: 600, top: 120 };
    box.style.top = Math.max(80, window.scrollY + bodyRect.top) + "px";
    box.style.right = "24px";
    ta.focus();

    let text = "";
    let busy = false;
    go.onclick = async () => {
      if (busy) return;
      const ask = String(ta.value || "").trim();
      if (!ask) return ta.focus();
      const prov = resolveProv();
      if (!prov) return toastSafe(t("没有可用的文本模型（设置 · 默认模型）"), "err");
      const model = modelOf(prov);
      if (!model) return toastSafe(t("该服务商没有可用模型"), "err");
      busy = true;
      go.disabled = true;
      out.textContent = "";
      text = "";
      const note = RS.notes.find((n) => n.path === RS.curPath);
      const prompt =
        t("你在协助用户研究一个课题。下面是笔记《") +
        (note ? note.title : RS.curPath) +
        t("》里被框选的一段内容：\n\n") +
        "> " +
        String(quote).replace(/\n/g, "\n> ") +
        "\n\n" +
        t("用户的问题：") +
        ask +
        "\n\n" +
        t("要求：① 直接回答，不要客套；② 如果答案指向本文其他地方，用 [[笔记标题]] 指出；③ 如果属于外部依据，给出可核验的出处（作者 年份 标题 / DOI / URL），不确定就明说「不确定」；④ 公式用 $…$ 或 $$…$$ 写，不要用图片。");
      try {
        const spec = {
          provider: prov,
          kind: "text",
          model,
          temperature: 0.3,
          prompt,
          texts: [],
          images: [],
          refImage: "",
        };
        const r = await apiCallTextStream(
          spec,
          null,
          (delta) => {
            text += delta;
            out.textContent = text;
          },
        );
        text = String((r && r.text) || text);
        out.textContent = text;
        /* 一键落图：把回答写成「批注」或「论断」，并把引用/链接解析成图谱里的边 */
        actions.innerHTML = "";
        const mkAct = (label, title, fn) => {
          const b = el("button", "rs-btn", label);
          b.title = title;
          b.onclick = fn;
          actions.appendChild(b);
        };
        mkAct(t("插入为批注"), t("写回 md 的 note 块（图谱生成 annotates 边）"), async () => {
          await rsCommitAsk("note", quote, text, ask);
          box.remove();
        });
        mkAct(t("插入为论断"), t("写回 md 的 claim 块（带来源，进图谱可标验证态）"), async () => {
          await rsCommitAsk("claim", quote, text, ask);
          box.remove();
        });
        mkAct(t("复制"), t("复制回答全文"), () => {
          /* 剪贴板只走唯一出口（裸调 navigator.clipboard 会被主窗权限闸拒） */
          try {
            appClipboardCopy(text, t("已复制"));
          } catch (_) {}
        });
      } catch (e) {
        out.textContent = t("调用失败：") + String((e && e.message) || e);
      } finally {
        busy = false;
        go.disabled = false;
      }
    };
    ta.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) {
        ev.preventDefault();
        go.onclick();
      }
      if (ev.key === "Escape") box.remove();
    });
  }
  async function rsCommitAsk(kind, quote, answer, question) {
    const md = readEditorMd();
    const blk = blockOfSelection(md, quoteLine(quote));
    const head = kind === "claim" ? "[!claim] " : "[!note] ";
    const title = (question || t("框选询问")).slice(0, 30);
    const body =
      "> " +
      head +
      title +
      "\n> " +
      String(answer || "")
        .trim()
        .split(/\r?\n/)
        .join("\n> ") +
      (kind === "claim" ? "\n> verify: unverified" : "") +
      "\n> " +
      t("提问依据：") +
      quoteLine(quote);
    const next = insertAfterBlock(md, blk, body);
    RS.md = next;
    RS.dirty = true;
    if (RS.srcEl) RS.srcEl.value = next;
    if (!(await rsSaveCurrent(next))) {
      /* 同上：闸拒了就不落盘、不留半截块 */
      RS.md = md;
      RS.dirty = false;
      if (RS.srcEl) RS.srcEl.value = md;
      renderEditor();
      return;
    }
    renderEditor();
    if (RS.graph) rsRebuildGraph({ keepPositions: true, silent: true });
    toastSafe(t("已插入并写入图谱"));
  }

  /* ── 问题清单里的「建议 / 方案」起草面板（参考原文与文献）──
     入口给的是清单里的一行问题：{ path（问题所在笔记）, title, text }（见 research-index.js 的
     .rs-idx-qs-adv 那一条）。面板三块：① 问题标题 + 正文（都能再改，起草按改后的算）；
     ②「建议」「方案」两块也能手写；③「AI 起草」按固定三段让模型出稿，流式回填、失败原因就地显示。
     模型路由与「框选询问」同一条：resolveProv() + modelOf() + apiCallTextStream（错误提示、设置页口径一致）。
     浮层口径：persistent —— 只走窗内「关闭」/ ✕ / Esc，不点外关闭；开新的先收旧的，与其它节点级浮层互斥。 */
  let rsQAdvEl = null;
  let rsQAdvEsc = null;
  function rsQuestionAdviseClose() {
    if (rsQAdvEsc) document.removeEventListener("keydown", rsQAdvEsc, true);
    rsQAdvEsc = null;
    if (rsQAdvEl) rsQAdvEl.remove();
    rsQAdvEl = null;
  }
  /* 关键词：中文取相邻二字（bigram）、西文取 3 字以上的词 —— 够粗，但比整句匹配稳得多 */
  function rsQAdvTerms(s) {
    const raw = String(s || "").toLowerCase();
    const out = [];
    const add = (w) => {
      if (w && out.indexOf(w) < 0) out.push(w);
    };
    for (const w of raw.match(/[a-z][a-z0-9_-]{2,}/g) || []) add(w);
    for (const seg of raw.replace(/[^\u4e00-\u9fa5]+/g, " ").split(/\s+/)) {
      if (!seg) continue;
      if (seg.length <= 2) {
        if (seg.length === 2) add(seg);
        continue;
      }
      for (let i = 0; i + 1 < seg.length; i++) add(seg.slice(i, i + 2));
    }
    return out;
  }
  /* 文献库里与这条问题最匹配的 3–5 条：题名 3 > 关键词 2 > 摘要 1；
     一条都没命中而库里确有条目时按库内顺序取 3 条（宁可少给，也别把整库塞进提示词）。 */
  function rsQAdvRefs(text) {
    const lib = Array.isArray(RS.lib) ? RS.lib : [];
    if (!lib.length) return [];
    const terms = rsQAdvTerms(text).slice(0, 24);
    const hay = (v) => String(v == null ? "" : v).toLowerCase();
    const itemTitleOf = (it) => String((typeof C().itemTitle === "function" ? C().itemTitle(it) : it.title) || "");
    const rows = lib.map((it, i) => {
      const tt = hay(itemTitleOf(it));
      const kw = hay(it.keyword);
      const ab = hay(it.abstract);
      let score = 0;
      for (const w of terms) {
        if (tt.indexOf(w) >= 0) score += 3;
        if (kw.indexOf(w) >= 0) score += 2;
        if (ab.indexOf(w) >= 0) score += 1;
      }
      return { it, i, score };
    });
    rows.sort((a, b) => b.score - a.score || a.i - b.i);
    let pick = rows.filter((r) => r.score > 0).slice(0, 5);
    if (pick.length < 3) pick = rows.slice(0, Math.min(3, rows.length));
    return pick.map((r) => r.it);
  }
  /* 一条文献进提示词的样子：citekey / 题名 / 作者 / 年份 / 摘要（截 240 字） */
  function rsQAdvRefLine(it) {
    const key = String(it.citeKey || (typeof C().citeKeyOf === "function" ? C().citeKeyOf(it) : it.id) || "");
    const title = String((typeof C().itemTitle === "function" ? C().itemTitle(it) : it.title) || "");
    const authors = (Array.isArray(it.author) ? it.author : [])
      .map((a) => (a && (a.family || a.given || a.name)) || "")
      .filter(Boolean)
      .slice(0, 3)
      .join(", ");
    const yp = it.issued && it.issued["date-parts"];
    const year = (yp && yp[0] && yp[0][0]) || "";
    const ab = String(it.abstract || "").replace(/\s+/g, " ").trim();
    const tail = ab ? t(" 摘要：") + (ab.length > 240 ? ab.slice(0, 240) + "…" : ab) : "";
    return (
      "- [" + (key ? "@" + key : t("无引用键")) + "] " + title + (authors ? " · " + authors : "") + (year ? "（" + year + "）" : "") + tail
    );
  }
  /* 库里全部引用键（CSL-JSON 真源 literature/library.json → RS.lib）：citeKey 优先，退 id，
     与 C().citeKeyOf 同一口径。顺序同库里、去重。提示词里的「只能用这些键」与落盘校验共用这一份。 */
  function rsQAdvLibKeys() {
    const out = [];
    for (const it of Array.isArray(RS.lib) ? RS.lib : []) {
      const k = String(
        it.citeKey || (typeof C().citeKeyOf === "function" ? C().citeKeyOf(it) : it.id) || "",
      ).trim();
      if (k && out.indexOf(k) < 0) out.push(k);
    }
    return out;
  }
  /* 一段文本里点到的 [@citekey] 中，哪些在库里查不到（查不到 = 不可核验的出处）。
     解析只走 research-core 的 collectCites（与图谱建边、正文点引用同一个正则），不另写一份。 */
  function rsQAdvCitesBad(text) {
    const have = rsQAdvLibKeys();
    const bad = [];
    const list = typeof C().collectCites === "function" ? C().collectCites(String(text || "")) : [];
    for (const c of list || []) {
      const k = String((c && c.key) || "").trim();
      if (k && have.indexOf(k) < 0 && bad.indexOf(k) < 0) bad.push(k);
    }
    return bad;
  }
  /* 打回提示：库外引用逐条点名（该入库哪一条、该删哪一处一眼看得出），绝不静默写进笔记 */
  function rsQAdvCitesWhy(bad) {
    const keys = (Array.isArray(bad) ? bad : []).map((k) => "[@" + k + "]");
    return (
      t("文献库里没有这条引用：") +
      keys.join("、") +
      (rsQAdvLibKeys().length
        ? t("（外部依据只能用库里已有的引用键：先把它加进文献库，或删掉这一处再存）")
        : t("（文献库还是空的：先入库，或删掉这一处引用再存）"))
    );
  }
  /* 提示词：这条问题的正文 + 所在笔记《标题》全文（截 7000 字，与 rsMissPrompt 同口径）
     + 库里最相关的 3–5 条 + 库内其它笔记标题；固定三段：## 建议 / ## 方案 / 可选 ## 原文改动。 */
  function rsQuestionAdvisePrompt(q) {
    const path = String(q.path || "");
    const rec = (RS.notes || []).find((n) => n.path === path);
    const noteTitle =
      (rec && rec.title) || (path ? path.replace(/^.*\//, "").replace(/\.md$/i, "") : t("未命名笔记"));
    const body = String((rec && rec.md) || (RS.curPath === path ? RS.md : "") || "").slice(0, 7000);
    const refs = rsQAdvRefs(String(q.title || "") + "\n" + String(q.text || ""));
    const others = (RS.notes || [])
      .filter((n) => n.path !== path)
      .map((n) => String(n.title || ""))
      .filter(Boolean)
      .slice(0, 60);
    let s =
      t("你在协助用户处理研究课题里的一条问题。问题所在的笔记《") +
      noteTitle +
      t("》全文如下（节选）：\n\n") +
      body +
      "\n\n";
    s +=
      t("【这一条问题】\n标题：") +
      (String(q.title || "").trim() || t("（没写标题）")) +
      "\n" +
      t("正文：") +
      (String(q.text || "").trim() || t("（还没写正文）")) +
      "\n\n";
    /* 文献：库里有时把「哪几条最相关」摆出来，并列出**全部可用引用键**（模型只许从这里挑）；
       库空时整段换口径 —— 只依据原文，不许给出处，宁可少说也不编一条假文献。 */
    const keys = rsQAdvLibKeys();
    s +=
      t("【文献库里与它最相关的条目】\n") +
      (keys.length
        ? refs.length
          ? refs.map(rsQAdvRefLine).join("\n")
          : t("库内没有匹配条目")
        : t("文献库还是空的：这一次只依据原文写，不要给出处")) +
      "\n\n";
    s +=
      t("【库内其它笔记标题】\n") +
      (others.length ? others.join(" / ") : t("（没有其它笔记）")) +
      "\n\n";
    s +=
      t("要求：严格按下面三段输出，段首必须是这些二级标题本身：\n") +
      "## 建议\n" +
      (keys.length
        ? t("给出判断与依据。引用本文其它地方用 [[笔记标题]]；外部依据只能用文献库里已有的引用键（") +
          keys.slice(0, 60).join(" / ") +
          (keys.length > 60 ? t(" …库内共 ") + keys.length + t(" 条，其余同样照库里的键写") : "") +
          t("），写进正文时用 [@引用键] 的形式；库里没有就明说「库内没有对应文献」，不要编造文献、页码或数据。")
        : t(
            "给出判断与依据。引用本文其它地方用 [[笔记标题]]；文献库是空的 —— 只依据原文，不要写 [@citekey] 形式的出处，也不要编造文献、页码或数据。",
          )) +
      "\n## 方案\n" +
      t("可执行步骤，用 1. 2. 3. 逐条列，每条说清做什么、做完凭什么判断成了。") +
      "\n## 原文改动\n" +
      t("只在确实要修改或补充原文时才写：每一对先一行「原句：…」再一行「改写：…」；不需要改就整段省略，不要写「无」。") +
      "\n\n" +
      t("不要开场白、不要复述要求、不要代码块、不要 JSON；公式用 $…$ 写。");
    return s;
  }
  /* 把三段切开（流式也能切）：未知小标题下的内容落到 other，一段都切不出来时原样留给调用点兜底 */
  function rsQAdvSections(md) {
    const out = { advise: "", plan: "", change: "", other: "" };
    let cur = "";
    for (const line of String(md || "").split(/\r?\n/)) {
      const h = /^\s*#{1,4}\s*(.+?)\s*$/.exec(line);
      if (h) {
        const nm = h[1];
        let next = "";
        if (/建议|advice|suggest/i.test(nm)) next = "advise";
        else if (/方案|步骤|计划|plan|step/i.test(nm)) next = "plan";
        else if (/原文改动|改动|改写|change|edit|diff/i.test(nm)) next = "change";
        /* 段内小标题（### …）留在这一段里；段外的小标题（开场白之类）不认 */
        if (next) cur = next;
        else if (cur) out[cur] += line + "\n";
        continue;
      }
      if (!cur) {
        if (line.trim()) out.other += line + "\n";
        continue;
      }
      out[cur] += line + "\n";
    }
    for (const k of ["advise", "plan", "change", "other"]) out[k] = out[k].replace(/^\s+|\s+$/g, "");
    return out;
  }
  /* 「## 原文改动」→ [{from, to}]：只认成对的「原句：…」+「改写：…」
     （容错：全半角冒号、前导 `> ` / 列表符号 / 缩进 —— 模型常把整段写进引用里）。
     落单的原句 / 改写不算一对：宁可少写，也不写半句到原文里。 */
  function rsQAdvPairs(sec) {
    const pairs = [];
    let lost = 0;
    let from = "";
    for (const raw of String(sec || "").split(/\r?\n/)) {
      const line = raw
        .replace(/^\s*(?:>\s*)+/, "")
        .replace(/^\s*[-*+]\s+/, "")
        .trim();
      if (!line || /^#{1,4}\s/.test(line)) continue;
      let m = /^原句\s*[:：]\s*(.*)$/.exec(line);
      if (m) {
        if (from) lost++;
        from = String(m[1] || "").trim();
        continue;
      }
      m = /^改写\s*[:：]\s*(.*)$/.exec(line);
      if (m) {
        const to = String(m[1] || "").trim();
        if (from && to) pairs.push({ from, to });
        else lost++;
        from = "";
      }
    }
    if (from) lost++;
    return { pairs, lost };
  }
  /* 成对写回：一对只改**第一处**命中（同一句在原文出现多次时，宁可少改也不整篇替换）。
     原文里找不到的那一对跳过并返回，由调用点如实说「没改」，不假装成功。 */
  function rsQAdvApplyPairs(md, pairs) {
    let out = String(md == null ? "" : md);
    const done = [];
    const miss = [];
    for (const p of pairs || []) {
      const src = String((p && p.from) || "");
      const to = String((p && p.to) || "");
      if (!src || !to) continue;
      const at = out.indexOf(src);
      if (at < 0) {
        miss.push(p);
        continue;
      }
      out = out.slice(0, at) + to + out.slice(at + src.length);
      done.push(p);
    }
    return { md: out, done, miss };
  }
  /* ④ 采纳之后在该处补一行指向建议衍生物的双链：`> advice: [[标题]]`（问题块里的建议链接字段）。
     Markdown 手术不在这里另写一份 —— 走 research-index 的 setQuestionAdvice（与清单那颗
     「＋ 建议 / 建议笔记」读的是同一份字段）。与下一任务协同：存衍生物的那一步也调这里，
     块里已经有同一个标题就原样返回（幂等），不会写第二行；找不到那一块（问题被改 / 删了）
     同样原样返回，链接不硬塞。 */
  function rsQAdvLinkAdd(md, q, title) {
    const I = window.MTResearchIndex;
    const ttl = String(title || "").trim();
    const src = String(md == null ? "" : md);
    if (!ttl || !I || typeof I.setQuestionAdvice !== "function") return src;
    const blocks = typeof I.questionBlocks === "function" ? I.questionBlocks(src) || [] : [];
    const b = rsQAdvBlockOf(blocks, q);
    if (!b) return src;
    if ((b.advice || []).indexOf(ttl) >= 0) return src; /* 已经挂着这一篇：不写第二行 */
    /* 按块首行定位（blockAt 认块首行本身）；只动 advice / fix 这两类元数据行，别的块一个字节不动 */
    return I.setQuestionAdvice(src, b.start + 1, { advice: (b.advice || []).concat([ttl]) });
  }
  /* 在 questionBlocks() 里定位「这一条问题」：行号 → 标题 → 正文首行，三档降级。
     面板里拿到的那一条可能已经被改过（标题 / 正文都是输入框里改后的），所以不能只认行号。
     找不到就返回 null，调用点原样返回/如实报错，绝不硬塞到别的块上。 */
  function rsQAdvBlockOf(blocks, q) {
    const o = q || {};
    const list = Array.isArray(blocks) ? blocks : [];
    const line = Number(o.line) || 0;
    const want = String(o.title || "").trim();
    const txt = String(o.text || "").trim();
    let b = null;
    if (line) b = list.find((x) => line >= x.start + 1 && line <= x.end) || null;
    if (!b && want) b = list.find((x) => String(x.title || "").trim() === want) || null;
    if (!b && txt) {
      const head = txt.split(/\r?\n/)[0].slice(0, 24);
      b = list.find((x) => head && String(x.text || "").indexOf(head) >= 0) || null;
    }
    return b;
  }
  /* ── 存成「建议稿」衍生物并建链接（问题块 ↔ 建议稿 ↔ 原文）──
     只在用户点面板里那颗「存为建议稿」时发生，一次事务式操作：
       ① notes/<问题标题slug>-建议.md：frontmatter 写 title / kind: note / parent: 原文路径 /
          relates: [原文标题] / derived: advice / verify: unverified / date；正文 = 建议 + 方案 + 参考文献
       ② 原文 frontmatter 补一条 derives（withDerives，幂等、只动那几行）
       ③ 问题块写 `> advice: [[建议稿标题]]`（有方案再补一条 `> fix:`，指的还是同一篇稿子）
     ②③ 落在同一份 md 上、**一次写盘**（一条 logChange，Ctrl+Z 一次撤回）；全部写盘走
     rsWriteGate + writeText + logChange，写完 rsLoadNotes + renderEditor（rsTopicWrite 内部那一步）。
     ⑤ 判色：`derived: advice` 不在规则表里 —— suffixOf 认不出（文件名以「-建议」收尾，没有变体后缀）、
     平铺条不为它画 chip、也没有基线，所以它不会挤进译文版本组的平铺条与金色判色；归组只由 `parent` 决定
     （它作为原文的衍生物挂在原文那一组里，与中译 / 摘要同列在左栏树，但不参与变体判色）。 */
  async function rsQAdvSaveNote(q, draft) {
    const o = q || {};
    const d = draft || {};
    const I = window.MTResearchIndex;
    const D = window.MTResearchDerive;
    const fail = (why) => ({ ok: false, why: why, rel: "", title: "" });
    const parentRel = rsNormRel(o.path || RS.curPath || "");
    const advice = String(d.advice == null ? "" : d.advice).trim();
    const plan = String(d.plan == null ? "" : d.plan).trim();
    if (!RS.root) return fail(t("还没有工作目录：先设置画布的工作目录"));
    if (!parentRel) return fail(t("这一条问题不知道在哪一篇笔记里，存不了"));
    if (!advice && !plan) return fail(t("建议和方案都还是空的：先写（或 AI 起草）再存"));
    /* 引用可核验：写进稿子的每一处 [@citekey] 都必须在文献库里 —— 库外的一律打回，
       一个字节都不落盘（不静默把假出处写进笔记）。手写、AI 起草走的是同一道闸。 */
    const badCites = rsQAdvCitesBad(advice + "\n" + plan);
    if (badCites.length) return fail(rsQAdvCitesWhy(badCites));
    if (!I || typeof I.setQuestionAdvice !== "function" || typeof I.questionBlocks !== "function")
      return fail(t("索引模块没加载（renderer/research-index.js）"));
    if (!D || typeof D.withDerives !== "function") return fail(t("衍生物模块没加载（renderer/research-derive.js）"));
    const rec = (RS.notes || []).find((n) => n.path === parentRel) || null;
    /* 当前正开着的那一篇以内存在稿为准（用户可能刚在上面打过字，还没进 RS.notes） */
    const before = String((RS.curPath === parentRel ? readEditorMd() : "") || (rec && rec.md) || "");
    if (!before) return fail(t("这一篇还没读进来：先在库里打开它再存"));
    const parentTitle =
      String((rec && rec.title) || "").trim() || parentRel.replace(/^.*\//, "").replace(/\.md$/i, "");
    /* 建议稿标题的底：问题标题 → 问题正文首行 → 原文标题（都不空着） */
    const base =
      String(o.title || "").trim() ||
      String(o.text || "").trim().split(/\r?\n/)[0].slice(0, 40).trim() ||
      parentTitle;
    const blocks = I.questionBlocks(before) || [];
    const blk = rsQAdvBlockOf(blocks, o);
    /* 这一块已经挂过一张「建议稿」（derived: advice）就复用它：存第二次 = 更新同一份，
       不复制第二份文件、也不再写第二条链接 */
    let rel = "";
    let title = "";
    for (const tt of (blk && blk.advice) || []) {
      const hit = (RS.notes || []).find((n) => String(n.title || "").trim() === String(tt).trim());
      if (hit && String((hit.meta && hit.meta.derived) || "").trim().toLowerCase() === "advice") {
        rel = hit.path;
        title = String(hit.title || "").trim() || tt;
        break;
      }
    }
    if (!rel) {
      const stem = (C().slugify(base) || "advice") + "-建议";
      rel = "notes/" + stem + ".md";
      let i = 2;
      while ((RS.notes || []).some((n) => n.path === rel) || (await exists(joinP(RS.root, rel)))) {
        rel = "notes/" + stem + "-" + i + ".md";
        i += 1;
      }
      title = base + " · 建议";
      /* 标题撞了 [[双链]] 就指不准：补序号，与文件名的 -2 / -3 同口径 */
      let k = 2;
      const taken = (tt) => (RS.notes || []).some((n) => n.path !== rel && String(n.title || "").trim() === tt);
      while (taken(title)) {
        title = base + " · 建议 " + k;
        k += 1;
      }
    }
    /* 正文 = 建议 + 方案 + 参考文献（文献只写库里真有的那几条，与起草用的是同一份打分） */
    const refs = rsQAdvRefs(String(o.title || "") + "\n" + String(o.text || ""));
    const parts = [];
    /* 正文是「笔记内容」，一律中文字面量（不跟界面语言走：换英文界面不该把库里的稿子译掉） */
    parts.push("> 原文：[[" + parentTitle + "]]（" + parentRel + "）");
    parts.push("");
    parts.push("# " + title);
    parts.push("");
    if (advice) {
      parts.push("## 建议");
      parts.push("");
      parts.push(advice);
      parts.push("");
    }
    if (plan) {
      parts.push("## 方案");
      parts.push("");
      parts.push(plan);
      parts.push("");
    }
    parts.push("## 参考文献");
    parts.push("");
    parts.push(refs.length ? refs.map(rsQAdvRefLine).join("\n") : "库内没有对应文献。");
    parts.push("");
    const md = C().stringifyFrontmatter(
      {
        title: title,
        kind: "note",
        parent: parentRel,
        relates: [parentTitle],
        derived: "advice",
        verify: "unverified",
        date: new Date().toISOString().slice(0, 10),
      },
      parts.join("\n"),
    );
    /* 原文那一份：问题块链接（只动 advice / fix 两行）+ 补 derives（只动 frontmatter 那几行）。
       顺序不能反：**先按 `before` 里的行号改问题块**，再补 derives —— 补 derives 会往 frontmatter
       插一行，块的行号当场全部下移，反过来做就会写到一个不相干的块上（或干脆写不进去）。
       两处合成同一份 md：一次写盘，一次 Ctrl+Z 就能撤回。 */
    let next = before;
    if (blk) {
      const advLinks = (blk.advice || []).slice();
      if (advLinks.indexOf(title) < 0) advLinks.push(title);
      const fixLinks = (blk.fix || []).slice();
      if (plan && fixLinks.indexOf(title) < 0) fixLinks.push(title);
      next = I.setQuestionAdvice(next, blk.start + 1, { advice: advLinks, fix: plan ? fixLinks : undefined });
    }
    next = D.withDerives(next, title);
    /* 写入闸先问：原文这一版是不是「改动集中在别人那一版」。拒了整笔不落 —— 建议稿也不写 */
    if (!(await rsWriteGate(parentRel))) {
      const gold = rsGoldSibling(parentRel);
      return fail(t("写入被取消：一个字节都没有动") + (gold ? t("（改动集中在 ") + gold.path + t("）") : ""));
    }
    const wasGold = rsStatusOf(parentRel) === "diverged";
    let hadBaseline = false;
    try {
      const V = rsVersions();
      hadBaseline = !!(V && typeof V.entryOf === "function" && V.entryOf(parentRel));
    } catch (_) {
      hadBaseline = false;
    }
    const prevNote = await readText(joinP(RS.root, rel));
    await writeText(joinP(RS.root, rel), md);
    await logChange(t("存为建议稿"), rel, prevNote, md);
    if (next !== before) {
      const ok = await rsTopicWrite(parentRel, before, next, t("存为建议稿 · 补 derives 与建议链接"));
      if (!ok) {
        return {
          ok: false,
          why: t("建议稿已写入 ") + rel + t("，但原文那一份没写进（写入被取消）：derives 与建议链接未建"),
          rel: rel,
          title: title,
        };
      }
      /* 原文只因补了 derives + 一行链接而变字节：那是记录，不是内容改动 ——
         不把基线跟上，原文会凭空变金（整组跟着发橙）。只在它本来就有基线、且本来不是金时才记。 */
      if (hadBaseline && !wasGold) {
        try {
          const V = rsVersions();
          if (V && typeof V.markBaseline === "function" && typeof V.commit === "function") {
            const res = V.markBaseline([parentRel]);
            if (res && res.patch) await V.commit(res.patch);
            rsStatusReset();
          }
        } catch (_) {}
      }
    }
    return {
      ok: true,
      rel: rel,
      title: title,
      text:
        t("已存为 ") +
        rel +
        t("；原文补了一条 derives") +
        (blk ? t("、问题块里写入 ") + (plan ? "> advice: / > fix:" : "> advice:") + t(" 链接") : "") +
        t("（Ctrl+Z 可撤回）"),
    };
  }
  function rsQuestionAdviseOpen(o) {
    const q = o || {};
    const path = String(q.path || RS.curPath || "");
    const t0 = String(q.title || "").trim();
    const x0 = String(q.text || "").trim();
    if (!t0 && !x0) {
      toastSafe(t("这条问题还没有内容：先在清单里补一句"), "warn");
      return;
    }
    rsQuestionAdviseClose();
    /* 与其它节点级浮层互斥（同 .rs-miss / .rs-ask 的口径） */
    if (typeof closeNodePopsExcept === "function") closeNodePopsExcept("");

    const box = el("div", "rs-ask wide");
    box.id = "rsQAdv";
    /* 五块内容一格屏放不下：抬高上限并让面板自己滚，输入框不跟着被压扁 */
    box.style.maxHeight = "84vh";
    box.style.overflow = "auto";
    const head = el("div", "rs-ask-head");
    head.appendChild(el("b", "", t("建议 / 方案")));
    const sub = el("span", "", t("AI 起草，或自己写"));
    sub.style.color = "var(--muted)";
    sub.style.fontSize = "12px";
    head.appendChild(sub);
    const close = el("button", "rs-ask-x", "✕");
    close.title = t("关闭");
    close.onclick = () => rsQuestionAdviseClose();
    head.appendChild(close);
    box.appendChild(head);
    const lab = (txt) => {
      const d = el("div", "rs-ask-head");
      d.appendChild(el("b", "", txt));
      return d;
    };

    box.appendChild(lab(t("问题标题")));
    const inpTitle = el("input", "rs-ask-input");
    inpTitle.type = "text";
    inpTitle.value = t0;
    inpTitle.placeholder = t("一句话说清这条问题");
    box.appendChild(inpTitle);

    box.appendChild(lab(t("问题正文")));
    const taText = el("textarea", "rs-ask-input");
    taText.rows = 3;
    taText.value = x0;
    taText.placeholder = t("问题具体在问什么（判断 / 依据 / 要落到什么上）");
    box.appendChild(taText);

    const row = el("div", "rs-ask-row");
    const go = el("button", "rs-btn primary", t("AI 起草"));
    go.title = t("按这条问题 + 笔记全文 + 库里最相关的文献，起草「建议 / 方案」");
    const stop = el("button", "rs-btn", t("关闭"));
    stop.onclick = () => rsQuestionAdviseClose();
    row.appendChild(go);
    row.appendChild(stop);
    box.appendChild(row);

    box.appendChild(lab(t("建议")));
    const taAdv = el("textarea", "rs-ask-input");
    taAdv.rows = 5;
    taAdv.placeholder = t("AI 起草，也可以直接手写");
    box.appendChild(taAdv);

    box.appendChild(lab(t("解决方案")));
    const taPlan = el("textarea", "rs-ask-input");
    taPlan.rows = 5;
    taPlan.placeholder = t("可执行的步骤，AI 起草，也可以直接手写");
    box.appendChild(taPlan);
    /* 四格输入不参与收缩（面板自己滚），否则 max-height 一到就被压成一条缝 */
    for (const f of [inpTitle, taText, taAdv, taPlan]) f.style.flex = "0 0 auto";

    /* 存成衍生物：把这两块落成一篇建议稿，并把问题块 ↔ 建议稿 ↔ 原文互相链起来（一次写盘）。
       摆在这一块字段下面 —— 填完就能存，不用回头看顶上那颗「AI 起草」。 */
    const saveRow = el("div", "rs-ask-row");
    const save = el("button", "rs-btn primary", t("存为建议稿"));
    save.title = t("把「建议 / 方案」落成一篇建议稿笔记，并建好与原文、这一条问题的链接（可 Ctrl+Z 撤回）");
    save.onclick = () => void saveNote();
    saveRow.appendChild(save);
    box.appendChild(saveRow);

    /* 模型给的「原文改动」只在这里渲染成一张 diff 卡（不写盘）：点卡里的「采纳」才落，
       不采纳 / 直接关面板 → 原文一个字节不动，也不产生任何版本副本 */
    const chgHost = el("div", "");
    chgHost.style.flex = "0 0 auto";
    box.appendChild(chgHost);

    /* 状态 / 失败原因写在这一块（空的时候没有高度） */
    const out = el("div", "rs-ask-out");
    box.appendChild(out);

    document.body.appendChild(box);
    rsQAdvEl = box;
    /* 摆到编辑区右侧，与「框选询问」同一处（不盖住正在读的那段） */
    const bodyRect = RS.bodyEl ? RS.bodyEl.getBoundingClientRect() : { top: 120 };
    box.style.top = Math.max(80, window.scrollY + bodyRect.top) + "px";
    box.style.right = "24px";
    inpTitle.focus();
    rsQAdvEsc = (ev) => {
      if (ev.key !== "Escape") return;
      ev.stopPropagation();
      rsQuestionAdviseClose();
    };
    document.addEventListener("keydown", rsQAdvEsc, true);

    let busy = false;
    const onScreen = () => rsQAdvEl === box;
    /* 原文改动的处理态：drop = 用户点了「不采纳」；done = 已经写进原文；applying = 这一笔正在写盘 */
    let changeDrop = false;
    let changeDone = false;
    let applying = false;
    let chgSig = null;
    let modelName = "";
    /* 这一次存下来的建议稿标题：「采纳并写入原文」那条双链就用它（同一处只会写一行，幂等） */
    let adviceTitle = "";
    /* 成对的「原句 → 改写」渲染成一张 diff 卡（展示与按钮口径同批注栏的「AI 处理结果」卡：
       删 = 原句、增 = 改写句，底部「采纳并写入原文」/「不采纳」）。
       只渲染、不写盘；成不了对就原样摊出来、不给一键写入的按钮。 */
    const paintChange = (sec, force) => {
      const text = String(sec || "");
      if (!onScreen()) return;
      /* 流式每来一个 delta 都会重画：内容没变（或已处理完）就不重造 DOM */
      const sig = changeDone ? "-done-" : changeDrop ? "-drop-" : text;
      if (!force && sig === chgSig) return;
      chgSig = sig;
      chgHost.innerHTML = "";
      if (changeDone || changeDrop || !text.trim()) return;
      const got = rsQAdvPairs(text);
      const card = el("div", "rs-anno-ai");
      card.style.margin = "0";
      const head2 = el("div", "rs-anno-ai-head");
      card.appendChild(head2);
      const body2 = el("div", "rs-anno-ai-diff");
      if (!got.pairs.length) {
        /* 没按格式给：原文照样不动，只把这一段摊出来让人自己处理 */
        head2.appendChild(
          el("span", "rs-anno-ai-title", t("原文改动（没按「原句 / 改写」成对写出，不能一键写入）")),
        );
        const same = el("div", "rs-anno-ai-row is-same");
        same.appendChild(el("span", "rs-anno-ai-sign", "·"));
        same.appendChild(el("span", "rs-anno-ai-text", text));
        body2.appendChild(same);
        card.appendChild(body2);
        chgHost.appendChild(card);
        return;
      }
      head2.appendChild(el("span", "rs-anno-ai-title", t("原文改动")));
      head2.appendChild(el("span", "rs-anno-ai-stat is-add", "+" + got.pairs.length));
      head2.appendChild(el("span", "rs-anno-ai-stat is-del", "−" + got.pairs.length));
      /* 落点 = 问题所在的那一篇（这张卡只认这一篇，不会写到别的文件上） */
      const rec0 = (RS.notes || []).find((n) => n.path === path);
      const nm = String((rec0 && rec0.title) || path.replace(/^.*\//, "").replace(/\.md$/i, ""));
      card.appendChild(el("div", "rs-anno-ai-sub", t("落点：") + nm + "（" + path + "）"));
      if (modelName) card.appendChild(el("div", "rs-anno-ai-sub", t("模型") + " · " + modelName));
      for (const p of got.pairs) {
        const rd = el("div", "rs-anno-ai-row is-del");
        rd.appendChild(el("span", "rs-anno-ai-sign", "−"));
        rd.appendChild(el("span", "rs-anno-ai-text", p.from));
        body2.appendChild(rd);
        const ra = el("div", "rs-anno-ai-row is-add");
        ra.appendChild(el("span", "rs-anno-ai-sign", "+"));
        ra.appendChild(el("span", "rs-anno-ai-text", p.to));
        body2.appendChild(ra);
      }
      card.appendChild(body2);
      if (got.lost)
        card.appendChild(
          el("div", "rs-anno-ai-sub", t("另有 ") + got.lost + t(" 行没成对（原句或改写缺一半），不会写入")),
        );
      const foot2 = el("div", "rs-anno-ai-foot");
      const take = el("button", "rs-anno-btn is-primary", t("采纳并写入原文"));
      take.type = "button";
      /* 还在起草时不给点：半截输出写进原文是最坏的一种结果 */
      take.disabled = busy || applying;
      take.title = t("只改这几处并写回问题所在的这一篇（可 Ctrl+Z 撤回）");
      take.onclick = () => void adoptChange(got.pairs);
      foot2.appendChild(take);
      const drop = el("button", "rs-anno-btn is-danger", t("不采纳"));
      drop.type = "button";
      drop.title = t("原文一个字节都不动，也不产生任何版本副本");
      drop.onclick = () => {
        changeDrop = true;
        paintChange("", true);
        out.className = "rs-ask-out";
        out.textContent = t("这一份原文改动没有采纳：原文未动。");
        toastSafe(t("原文未改动"));
      };
      foot2.appendChild(drop);
      card.appendChild(foot2);
      chgHost.appendChild(card);
    };
    /* 采纳 = 一次写盘：成对的改动 +（若已有建议衍生物）那一行双链合成同一份 md，
       走 rsTopicWrite（rsWriteGate + writeText + logChange）—— 闸拒就整笔不落，Ctrl+Z 一次撤回。
       不采纳 / 直接关面板根本走不到这里，原文与版本链都不会动。 */
    const adoptChange = async (pairs) => {
      if (busy || applying) return;
      const rel = rsNormRel(path);
      if (!rel) {
        out.className = "rs-ask-out rs-miss-err";
        out.textContent = t("这一条问题没有落点（不知道改哪一篇），不能写入。");
        return;
      }
      const rec = (RS.notes || []).find((n) => n.path === rel);
      /* 当前正开着的这一篇：以内存在稿为准（用户可能刚在上面打过字，还没进 RS.notes） */
      const before = String((RS.curPath === rel ? readEditorMd() : "") || (rec && rec.md) || "");
      if (!before) {
        out.className = "rs-ask-out rs-miss-err";
        out.textContent = t("这一篇还没读进来：先在库里打开它再采纳。");
        return;
      }
      const res = rsQAdvApplyPairs(before, pairs);
      if (!res.done.length) {
        out.className = "rs-ask-out rs-miss-err";
        out.textContent = t("这几处原句在原文里找不到（原文可能已经改过），这一笔没有写入。");
        return;
      }
      /* 要写进原文的那几句也过同一道引用闸：库外的 [@citekey] 打回，原文一个字节不动 */
      const badCites = rsQAdvCitesBad(res.done.map((p) => String((p && p.to) || "")).join("\n"));
      if (badCites.length) {
        out.className = "rs-ask-out rs-miss-err";
        out.textContent = rsQAdvCitesWhy(badCites) + t("；原文未动。");
        return;
      }
      let next = res.md;
      let linked = false;
      /* ④ 应用后在该处补一行指向建议衍生物的双链（同一标题只写一行；
         下一任务存衍生物时也走 rsQAdvLinkAdd，不会写第二行） */
      const linkTitle = String(adviceTitle || q.adviseTitle || q.adviceTitle || "").trim();
      if (linkTitle) {
        const withLink = rsQAdvLinkAdd(next, q, linkTitle);
        linked = withLink !== next;
        next = withLink;
      }
      applying = true;
      for (const b of chgHost.querySelectorAll("button")) b.disabled = true;
      const ok = await rsTopicWrite(rel, before, next, t("采纳原文改动"));
      applying = false;
      if (!ok) {
        /* 写入闸被拒（或用户点了取消）：整笔不落盘，卡留着让人再决定 */
        for (const b of chgHost.querySelectorAll("button")) b.disabled = false;
        out.className = "rs-ask-out rs-miss-err";
        out.textContent = t("写入被取消：原文未动，这一份改动还留着。");
        return;
      }
      changeDone = true;
      paintChange("", true);
      out.className = "rs-ask-out";
      const bits = [t("已写入原文 ") + res.done.length + t(" 处（Ctrl+Z 可撤回）")];
      if (res.miss.length) bits.push(t("另有 ") + res.miss.length + t(" 处原句没找到，未改"));
      if (linked) bits.push(t("已在问题块里补一行指向建议的双链"));
      out.textContent = bits.join(t("；")) + "。";
      toastSafe(t("已写入原文 ") + res.done.length + t(" 处"));
    };

    /* 存为建议稿（衍生物 + 三向链接）：一次事务式写盘，全部在 rsQAdvSaveNote 里
       （① notes/<问题标题slug>-建议.md ② 原文补 derives ③ 问题块写 advice / fix 链接）。
       失败只把原因写在状态区，原文与库里的文件都不动；成功给一个「打开建议稿」的入口。 */
    let saving = false;
    async function saveNote() {
      if (busy || applying || saving) return;
      saving = true;
      save.disabled = true;
      out.className = "rs-ask-out";
      out.textContent = t("正在写入…");
      try {
        const res = await rsQAdvSaveNote(
          {
            path: path,
            line: q.line,
            title: String(inpTitle.value || "").trim(),
            text: String(taText.value || "").trim(),
          },
          { advice: taAdv.value, plan: taPlan.value },
        );
        if (!res.ok) {
          out.className = "rs-ask-out rs-miss-err";
          out.textContent = res.why;
          toastSafe(res.why, "warn");
          return;
        }
        /* 存下来的这一篇就是「采纳原文改动」时该补的那条双链目标（同一处只写一行） */
        adviceTitle = res.title;
        out.className = "rs-ask-out";
        out.textContent = res.text;
        const open = el("button", "rs-btn", t("打开建议稿"));
        open.title = res.rel;
        open.onclick = () => {
          rsQuestionAdviseClose();
          void rsOpenNote(res.rel);
        };
        out.appendChild(document.createTextNode(" "));
        out.appendChild(open);
        toastSafe(t("已存为 ") + res.rel);
      } catch (e) {
        out.className = "rs-ask-out rs-miss-err";
        out.textContent = t("写入失败：") + String((e && e.message) || e);
      } finally {
        saving = false;
        save.disabled = false;
      }
    }

    /* 上一趟 AI 填进去的原文：再点一次「AI 起草」是**替换**那一趟，不叠第二份；
       用户自己改过（或手写的）内容则保留，AI 内容接在后面。 */
    let lastA = "";
    let lastP = "";
    const trimEnd = (v) => String(v || "").replace(/\s+$/, "");
    go.onclick = async () => {
      if (busy) return;
      const title = String(inpTitle.value || "").trim();
      const qtext = String(taText.value || "").trim();
      if (!title && !qtext) {
        toastSafe(t("先把问题写清楚：标题或正文至少一行"), "warn");
        return;
      }
      const prov = resolveProv();
      if (!prov) return toastSafe(t("没有可用的文本模型（设置 · 默认模型）"), "err");
      const model = modelOf(prov);
      if (!model) return toastSafe(t("该服务商没有可用模型"), "err");
      const curA = trimEnd(taAdv.value);
      const curP = trimEnd(taPlan.value);
      const baseA = curA === lastA ? "" : curA;
      const baseP = curP === lastP ? "" : curP;
      busy = true;
      go.disabled = true;
      /* 起草中「存为建议稿」也灰着：别把半截输出落成一篇稿子 */
      save.disabled = true;
      go.textContent = t("起草中…");
      /* 新一趟起草：上一趟那张 diff 卡的「不采纳 / 已写入」状态作废（否则新结果出不来卡） */
      changeDrop = false;
      changeDone = false;
      chgSig = null;
      chgHost.innerHTML = "";
      modelName = model;
      out.className = "rs-ask-out";
      out.textContent = t("正在起草…");
      taAdv.readOnly = true;
      taPlan.readOnly = true;
      const cat = (sec, base) => (sec ? (base ? base + "\n\n" : "") + sec : base);
      /* 面板被 ✕ / Esc / 换篇收掉之后不许再往回写（写进一个看不见的框里就是白烧 Token） */
      const alive = onScreen;
      const paint = (full) => {
        const sec = rsQAdvSections(full);
        if (!alive()) return sec;
        taAdv.value = cat(sec.advise, baseA);
        taPlan.value = cat(sec.plan, baseP);
        /* 原文改动一律走那张卡：模型没给的段不会让卡凭空出现，给了也只渲染、不写盘 */
        paintChange(sec.change);
        return sec;
      };
      let acc = "";
      try {
        const spec = {
          provider: prov,
          kind: "text",
          model,
          temperature: 0.4,
          prompt: rsQuestionAdvisePrompt({ path, title, text: qtext }),
          texts: [],
          images: [],
          refImage: "",
        };
        const r = await apiCallTextStream(spec, null, (delta) => {
          acc += String(delta || "");
          paint(acc);
        });
        acc = String((r && r.text) || acc);
        const sec = paint(acc);
        if (!alive()) return;
        /* 一段都没切出来（模型没按格式）：原样放进状态区，宁可难看也别把内容吞掉；
           有「原文改动」时那段在卡里，状态区只收掉起草中的那行字 */
        if (!sec.advise && !sec.plan && !sec.change) {
          out.textContent = t("模型没按三段格式回复，原样放在这里：\n\n") + acc;
        } else if (out.textContent === t("正在起草…")) {
          out.textContent = "";
        }
        lastA = trimEnd(taAdv.value);
        lastP = trimEnd(taPlan.value);
        /* 起草结果里点到库外的 [@citekey]：当场说清（存 / 采纳时会被打回，不静默写进笔记） */
        const badCites = rsQAdvCitesBad(String(taAdv.value || "") + "\n" + String(taPlan.value || ""));
        if (badCites.length && alive()) {
          out.className = "rs-ask-out rs-miss-err";
          out.textContent = (out.textContent ? out.textContent + "\n\n" : "") + rsQAdvCitesWhy(badCites);
        }
      } catch (e) {
        if (alive()) {
          out.className = "rs-ask-out rs-miss-err";
          out.textContent = t("调用失败：") + String((e && e.message) || e);
        }
      } finally {
        busy = false;
        go.disabled = false;
        save.disabled = false;
        go.textContent = t("AI 起草");
        taAdv.readOnly = false;
        taPlan.readOnly = false;
        /* 起草期间「采纳」是灰的（防半截输出写进原文）：这一趟结束后重新可点 */
        for (const b of chgHost.querySelectorAll("button")) b.disabled = false;
      }
    };
    taText.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) {
        ev.preventDefault();
        go.onclick();
      }
    });
  }

  /* ── 笔记操作 ── */
  async function rsOpenNote(path, opts) {
    const o = opts || {};
    /* 换文档前先落盘；被闸拒（用户点取消）就留在原处，别把没保存的输入扔掉 */
    if ((await rsSaveCurrent()) === false) return;
    const rec = RS.notes.find((n) => n.path === path);
    if (!rec) return;
    /* 面包屑那份导航路径：默认「从头一条新路径」（左栏点树 / 新建 / 图谱跳转），
       阅读器里点定义 / 链接带 trail:"push" 往下压一层，返回与面包屑带 trail:"back" / "jump" */
    rsNavPush(path, o.trail);
    RS.curPath = path;
    RS.md = rec.md;
    RS.dirty = false;
    RS.foldPath = "";
    RS.srcDocPath = "";
    /* 每篇从阅读态打开（要改原文点工具条「源码编辑」）：上一篇停在编辑态不该把下一篇也拖进编辑态 */
    RS.editorMode = o.edit ? "edit" : "read";
    /* 就地编辑也是「这一篇的」状态：换篇一律收回阅读态 */
    RS.inlineOn = false;
    RS.inlineEl = null;
    clearTimeout(inlineTimer);
    /* 换了篇：候选面板里那三个角度是按上一篇的正文生成的，留着就是错的内容 */
    rsMissClose();
    renderSide();
    renderEditor();
    /* 版本三态跟着「当前这一篇」重算：树上金色行与平铺条要立刻换成本篇那一组 */
    renderTop();
    /* 左侧返回边距跟着这一跳重画（展开才有） */
    rsBackRail();
    refreshChatFocus();
    if (o.line) {
      /* 从图谱跳回来：滚到那一行对应的块（富文本按块序号近似，源码模式精确定位） */
      setTimeout(() => rsScrollToLine(o.line), 30);
    }
  }
  function rsScrollToLine(line) {
    if (RS.srcEl) {
      const lines = RS.srcEl.value.split(/\r?\n/);
      const idx = Math.max(0, Math.min(lines.length - 1, line - 1));
      const upto = lines.slice(0, idx).join("\n").length;
      RS.srcEl.focus();
      RS.srcEl.setSelectionRange(upto, upto);
      const lh = 20;
      RS.srcEl.scrollTop = Math.max(0, idx * lh - 80);
      return;
    }
    if (!RS.selHost) return;
    const blocks = [...RS.selHost.children];
    const idx = Math.max(0, Math.min(blocks.length - 1, Math.floor(line / 4)));
    const target = blocks[idx];
    if (target) {
      target.scrollIntoView({ block: "center", behavior: "smooth" });
      target.classList.add("rs-flash");
      setTimeout(() => target.classList.remove("rs-flash"), 1400);
    }
  }
  async function rsNewNote() {
    const name = await promptText(t("新笔记标题"), t("未命名笔记"));
    if (name == null) return;
    const title = String(name).trim() || t("未命名笔记");
    let rel = "notes/" + C().slugify(title) + ".md";
    let i = 2;
    while (await exists(joinP(RS.root, rel))) {
      rel = "notes/" + C().slugify(title) + "-" + i + ".md";
      i++;
    }
    const md = C().stringifyFrontmatter(
      { title, tags: [], verify: "unverified", date: new Date().toISOString().slice(0, 10) },
      "\n# " + title + "\n\n",
    );
    /* 写入闸：新文件名可能正好落在某个版本组里（如 原名.zh.md），同组有金色就先问一句 */
    if (!(await rsWriteGate(rel))) return;
    await window.api.fileWriteText(joinP(RS.root, rel), md);
    await logChange(t("新建笔记"), rel, "", md);
    await rsLoadNotes();
    await rsOpenNote(rel);
    renderTop();
    toastSafe(t("已新建 ") + rel);
  }
  /* ── 引用梗 → 「写一条笔记」（只绑这一处 @）──
     唯一键 = 引用键 + 当前笔记路径 + 行号：落 notes/cites/<key>-<行号>.md（重名 -2 / -3），
     正文第一行写 `来源：<笔记>:<行号>`，浮层此后按这一行精确匹配 ——
     同一篇文章在别处（或某个人物名下的所有 @）不会被这一篇抢走。
     骨架不调模型、不花 Token：只写引用块与来源行，正文由作者自己补。 */
  async function rsCiteNewNote(req) {
    const o = req || {};
    const key = String(o.key || "").trim().replace(/^@+/, "");
    const srcPath = C().normRel(o.path || "");
    const line = Number(o.line) || 0;
    if (!key || !srcPath || !line) {
      toastSafe(t("这一处引用定位不到行号（切到阅读态再点一次）"), "warn");
      return;
    }
    if (!RS.root) return;
    const stem = (C().slugify(key) || "cite") + "-" + line;
    let rel = "notes/cites/" + stem + ".md";
    let i = 2;
    while (await exists(joinP(RS.root, rel))) {
      rel = "notes/cites/" + stem + "-" + i + ".md";
      i++;
    }
    const title = "@" + key + " · " + stem;
    /* 不写 derivedFrom：引用笔记是「某一处的批注」，不是那篇文章的又一个版本 ——
       写进去它就会被归进那一篇的版本组，跟中译 / 摘要 一起被扩散、判色、当变体列出来。
       出处记在 citePath / citeLine 与正文的来源行里，足够追溯。 */
    const md = C().stringifyFrontmatter(
      {
        title: title,
        tags: [],
        verify: "unverified",
        date: new Date().toISOString().slice(0, 10),
        cite: key,
        citePath: srcPath,
        citeLine: line,
      },
      "\n> [!cite] @" + key + "\n>\n> 来源：" + srcPath + ":" + line + "\n\n",
    );
    await window.api.fileMkdir(joinP(RS.root, "notes/cites"));
    await window.api.fileWriteText(joinP(RS.root, rel), md);
    await logChange(t("新建引用笔记"), rel, "", md);
    await rsLoadNotes();
    await rsOpenNote(rel);
    renderTop();
    toastSafe(t("已新建 ") + rel);
  }
  function promptText(title, def) {
    return new Promise((resolve) => {
      const box = el("div", "rs-prompt");
      box.innerHTML =
        '<div class="rs-prompt-t">' +
        esc(title) +
        '</div><input class="rs-prompt-i" type="text" /><div class="rs-prompt-row"><button class="rs-btn primary" data-a="ok">' +
        esc(t("确定")) +
        '</button><button class="rs-btn" data-a="cancel">' +
        esc(t("取消")) +
        "</button></div>";
      document.body.appendChild(box);
      const inp = box.querySelector("input");
      inp.value = def || "";
      inp.focus();
      inp.select();
      const done = (v) => {
        box.remove();
        resolve(v);
      };
      box.querySelector('[data-a="ok"]').onclick = () => done(inp.value);
      box.querySelector('[data-a="cancel"]').onclick = () => done(null);
      inp.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") done(inp.value);
        if (ev.key === "Escape") done(null);
      });
    });
  }

  /* ── 阅读区增强（大纲 / 公式编号与放大 / 术语解释 / 阅读进度）──
     实现在 renderer/research-reader.js（window.MTResearchReader）：只读 DOM 增强，
     不动 RS.md、不写 changes.jsonl。这里只做「视图状态 ⇄ 阅读器」的薄适配，
     保证真机与验证页跑的是同一份代码。 */
  let rsReaderInst = null;
  function rsReader() {
    if (!rsReaderInst && window.MTResearchReader) {
      rsReaderInst = window.MTResearchReader.create({
        el,
        t,
        openNote: (path, o) => rsOpenNote(path, Object.assign({ trail: "push" }, o || {})),
        openLink: (name) => rsOpenLinkByName(name),
        /* `[[双链]]` 点开是浮空卡（见 rsLinkPage）：第一行是它指向的那一页，其余是写过它的笔记；
           一个都没有时卡底那颗「新建一条笔记」走 onMissing 的候选面板 */
        linkPage: (name) => rsLinkPage(name),
        /* 阅读器认出「没有对应笔记」：名词给 wiki 式简释，在被点元素上方弹候选面板 */
        onMissing: (kind, name, rect) => rsMissingOpen(kind, name, rect),
        /* 公式浮层头部那颗「编辑 LaTeX」：改的是原文里这条式子，写完照常落盘 + 记 changes */
        onEditTex: (hostEl, oldTex, newTex) => rsSwapFormula(hostEl, oldTex, newTex),
        /* 公式浮层下部那块「扩充方向」：与术语浮层同一份（rsMissSuggest），点方向先确认再调模型 */
        onEqExpand: (mountEl, info) => rsEqExpand(mountEl, info),
        /* 术语说明这类「一小段正文」用整段 Markdown 渲染（列表 / 表格 / 公式都在这一份里） */
        renderMd: (md) => renderMarkdown(md),
        /* 点 `[@key]` 浮层里的「写一条笔记」：只绑这一处（引用键 + 本篇 + 行号） */
        onNewNote: (req) => rsCiteNewNote(req),
        /* 引用梗浮层顶上那条「文献」行：有没有正文由宿主判；点了就导向文章或问一句搜索入库 */
        citeInfo: (keys) => rsCiteLitInfo(keys),
        onOpenCite: (key) => rsOpenCite(key),
        /* 参考文献段落里点整行（含 `[@key]` 或 DOI / arXiv）：本地有全文就打开，没有就获取文献 */
        openRef: (info) => rsOpenRefLine(info),
        /* 选区右键菜单里要动源码的两项：阅读器只回调，改 md 与落盘都在下面这两个函数里 */
        isEditing: () => RS.editorMode === "edit",
        wrapLink: (text) => rsWrapLinkText(text),
        cutSelection: (text) => rsCutSelection(text),
        toast: (msg, kind) => toastSafe(msg, kind),
        math: () => window.MTMathRender,
      });
    }
    return rsReaderInst;
  }
  /* `[[条目]]` → 同名笔记（标题 / label / 别名都认）。没有就明说没有 ——
     图谱要用户按需建，阅读态不假装那条笔记存在。
     返回值是「开没开成」：false 交给阅读器的 onMissing，由 rsMissingOpen 弹候选面板
     （不在这一层 toast，否则点一下既要弹面板又冒一条警告）。 */
  function rsOpenLinkByName(name) {
    const key = String(name || "").trim();
    if (!key) return false;
    const hit = (RS.notes || []).find((n) => {
      const note = (n.parsed && n.parsed.note) || {};
      const aliases = Array.isArray(note.aliases) ? note.aliases : [];
      return n.title === key || note.label === key || aliases.indexOf(key) >= 0;
    });
    if (hit) {
      /* `[[链接]]` 打开另一篇 = 沿路径往下压一层（面包屑因此能「递进 + 返回」） */
      rsOpenNote(hit.path, { trail: "push" });
      return true;
    }
    return false;
  }
  /* `[[名字]]` 指向的那一页（标题 / label / 别名都认）—— 双链浮空卡的第一行。
     阅读器点双链**不再直接跳页**：先摊开「这条链接对应哪几条内容」（这一页 + 写过它的笔记），
     要进页面就点这一行（page: true）。dir 取这一页 frontmatter 的 `方向:`，没写就写「这一页」。 */
  function rsLinkPage(name) {
    const key = String(name || "").trim();
    if (!key) return null;
    const hit = (RS.notes || []).find((n) => {
      const note = (n.parsed && n.parsed.note) || {};
      const aliases = Array.isArray(note.aliases) ? note.aliases : [];
      return n.title === key || note.label === key || aliases.indexOf(key) >= 0;
    });
    if (!hit) return null;
    const note = (hit.parsed && hit.parsed.note) || {};
    return {
      path: hit.path,
      line: 0,
      page: true,
      dir: String(note.angle || "").trim() || t("这一页"),
      text: String(note.label || hit.title || key),
    };
  }

  /* ── 缺失条目候选面板（点「还没有那条笔记」的名词；公式走阅读器的 .rs-eqmodal，不在这块）──
      内容由本机文本模型现场生成：与「框选询问」同一条通道（resolveProv + modelOf + apiCallTextStream）。
     三个角度各一段，每段带「依据本页哪一段」的锚点；名词 = wiki 式简释，公式 = 由来分析。
     浮层口径：persistent —— 只走面板内 ✕ / Esc / 再点同一元素关闭，不点外关闭；
     开新面板与其它节点级浮层互斥（closeNodePopsExcept）。面板自己只做生成、不落盘；
     **点某一条候选**才派会话写出 notes/<标题>.md（见下面的 rsMissPick 一段）。 */
  let rsMissEl = null;
  let rsMissKey = "";
  let rsMissEsc = null;
  let rsMissDown = null; /* 点外部就关（这一块是只读浮层，不做 persistent） */
  let rsMissStateEl = null; /* 面板底部那行状态：派活 / 等落盘 / 失败原因 */
  let rsMissRect = null; /* 被点元素的 rect（DOMRect 拷贝），面板长高后重摆还用它 */
  let rsMissJob = null; /* 正在等落盘的那一件（点候选 → 会话写 notes/<标题>.md） */
  function rsMissStop() {
    if (rsMissJob && rsMissJob.timer) clearInterval(rsMissJob.timer);
    rsMissJob = null;
  }
  function rsMissClose() {
    if (rsMissEsc) document.removeEventListener("keydown", rsMissEsc, true);
    rsMissEsc = null;
    if (rsMissDown) document.removeEventListener("mousedown", rsMissDown, true);
    rsMissDown = null;
    rsMissStop();
    if (rsMissEl) rsMissEl.remove();
    rsMissEl = null;
    rsMissKey = "";
    rsMissStateEl = null;
    rsMissRect = null;
  }
  /* 位置：优先贴在被点元素**上方**；上方放不开（贴到视口顶）就翻到下方并夹进视口 ——
     夹取算法与术语浮层 showTermTip 同一套。 */
  function rsMissPlace(el2, rect) {
    if (!el2 || !rect) return;
    const w = el2.offsetWidth;
    const h = el2.offsetHeight;
    const vw = window.innerWidth || 1280;
    const vh = window.innerHeight || 800;
    const left = Math.min(Math.max(8, rect.left), Math.max(8, vw - w - 12));
    let top = rect.top - h - 8;
    if (top < 8) top = Math.max(8, Math.min(rect.bottom + 8, vh - h - 8));
    el2.style.left = Math.round(left) + "px";
    el2.style.top = Math.round(top) + "px";
  }
  /* 名词直接给名字；公式的名字是「(1.2) <latex>」——标题行只留编号，原式由阅读器的公式浮层排。
     编号永远带圆括号（numberFormulas 写的是 "(2.3)"），只认开头那一段，
     没有编号时整串都是式子 —— 别按第一个空格切，`\int_0^1 f dx` 里就有空格。 */
  function rsMissParts(name) {
    const s = String(name || "").trim();
    const m = /^(\([^)]{0,24}\))\s+/.exec(s);
    if (!m) return { label: "", tex: s };
    return { label: m[1], tex: s.slice(m[0].length).trim() };
  }
  function rsMissTitle(kind, name) {
    const s = String(name || "").trim();
    if (kind !== "formula") return s;
    return rsMissParts(s).label || t("公式");
  }
  /* 可选的补充方向：面板打开时只列这些按钮，**一个模型请求都不发**；
    用户点某一个方向、再确认「会花 Token」之后才真正调用（rsMissSuggest 里的 runAngle）。
    每条 = 一个角度：给一份单角度简释；id "all" = 三个角度一起（旧行为，三张候选卡）。
   列表之外面板末尾另加一颗「自定义…」——用户自己写角度（ask = 原文，见 rsMissCustomAngle）。 */
  const RS_MISS_ANGLES = {
    term: [
      { id: "define", label: "定义", ask: "它是什么：一句话说清，再补两句边界（什么算、什么不算）" },
      { id: "usage", label: "上下文用法", ask: "它在本文哪一段出现、被用来做什么、在哪个论证里承担什么" },
      { id: "compare", label: "相邻概念对照", ask: "与本文里最接近的另外 1–2 个概念有什么区别" },
      { id: "refs", label: "引用与出处", ask: "文中哪条引用 / 哪篇文献支持这个概念；文中没有就明说「文中没有对应文献」" },
      { id: "all", label: "三条简释（定义 · 用法 · 对照）", ask: "" },
    ],
    formula: [
      { id: "derive", label: "由来推导", ask: "由哪条定义或前式推出，把推到这一步的推理链写清" },
      { id: "symbols", label: "符号与前提", ask: "每个符号在本文里指什么、成立需要什么条件或假设" },
      { id: "refs", label: "与文献对应", ask: "文中所引文献里哪一式是它的来源，对不上就明说「文中没有对应文献」" },
      { id: "all", label: "三条由来分析（推导 · 符号 · 文献）", ask: "" },
    ],
  };
  function rsMissAngle(kind, id) {
    const list = RS_MISS_ANGLES[kind] || RS_MISS_ANGLES.term;
    const want = String(id || "all");
    return list.find((a) => a.id === want) || list[list.length - 1];
  }
  /* 自定义方向：用户写的那句话就是 ask；label 只用于确认卡与提示词里那一行小标题
     （压成单行、截短，长句原样留在 ask 里进提示词）。 */
  function rsMissCustomAngle(ask) {
    const raw = String(ask || "").trim();
    const one = raw.replace(/\s+/g, " ");
    return { id: "custom", label: one.length > 24 ? one.slice(0, 24) + "…" : one, ask: raw };
  }
  /* 内置方向的 label 走 i18n；自定义的是用户原文，不能再丢进 t()（撞上词条会被翻掉） */
  function rsMissAngleLabel(ang) {
    if (!ang) return "";
    return ang.id === "custom" ? String(ang.label || "") : t(ang.label);
  }
  function rsMissPrompt(kind, name, angleId, customAsk) {
    const note = (RS.notes || []).find((n) => n.path === RS.curPath);
    const title = (note && note.title) || RS.curPath || t("未命名笔记");
    const body = String(RS.md || "").slice(0, 7000);
    const head =
      t("你在协助用户研究一个课题。用户正在阅读笔记《") +
      title +
      t("》，这一页的正文如下（节选）：\n\n") +
      body +
      "\n\n";
    /* 自定义方向不走内置表：直接按「单个角度」那一支排版，用户原文就是 ask */
    const ang =
      String(angleId || "") === "custom"
        ? rsMissCustomAngle(customAsk)
        : rsMissAngle(kind === "formula" ? "formula" : "term", angleId);
    const what = kind === "formula" ? t("一条公式") : t("一个名词");
    if (!ang || ang.id === "all") {
      const fmt =
        t("严格按下面的格式输出：三个角度各一段，段首用 ### 开头写角度名，正文 2–4 句，最后单独一行写「依据：」+ 本页哪一节 / 哪一句 / 哪个式子。不要开场白、不要复述要求、不要代码块、不要 JSON。公式用 $…$ 写。");
      if (kind === "formula") {
        return (
          head +
          t("用户点了正文里的一条公式：") +
          "\n" +
          String(name || "") +
          "\n\n" +
          t("这一页还没有为它写过说明。请只依据这一页正文与其中引用的定义，给出 3 个不同角度的由来分析：") +
          "\n" +
          t("① 由哪条定义或前式推出：把推到这一步的推理链写清；") +
          "\n" +
          t("② 符号与前提：每个符号在本文里指什么、成立需要什么条件或假设；") +
          "\n" +
          t("③ 与引用文献对应：文中所引文献里哪一式是它的来源，对不上就明说「文中没有对应文献」。") +
          "\n\n" +
          fmt
        );
      }
      return (
        head +
        t("用户点了正文里的一个名词：") +
        "\n" +
        String(name || "") +
        "\n\n" +
        t("库里还没有这个名词的笔记。请只依据这一页正文，给「") +
        String(name || "") +
        t("」写 3 个不同角度的 wiki 式简释：") +
        "\n" +
        t("① 定义：它是什么，一句话说清；") +
        "\n" +
        t("② 上下文里的用法：它在本文哪一段出现、被用来做什么；") +
        "\n" +
        t("③ 相邻概念对照：与本文里最接近的另外 1–2 个概念有什么区别。") +
        "\n\n" +
        t("本页没写到的内容不要编，直接写「本页没有说明」。") +
        "\n\n" +
        fmt
      );
    }
    /* 单角度：只出一张卡（一条建议），格式与多角度时的一张卡一致 */
    const labelOne = rsMissAngleLabel(ang);
    /* 自定义方向：用户写的那句话原样进提示词（不再过 t()，否则撞上词条会被翻译掉） */
    const askOne = ang.id === "custom" ? String(ang.ask || "") : t(ang.ask);
    const fmtOne =
      t("严格按下面的格式输出：一行 `### ") +
      labelOne +
      t("`，下面 2–5 句正文，最后单独一行写「依据：」+ 本页哪一节 / 哪一句 / 哪个式子。不要开场白、不要复述要求、不要代码块、不要 JSON。公式用 $…$ 写。");
    return (
      head +
      t("用户点了正文里的") +
      what +
      "：" +
      String(name || "") +
      "\n\n" +
      t("请只依据这一页正文（与其中引用的定义 / 文献），针对「") +
      labelOne +
      t("」这一个角度写一段简释：") +
      askOne +
      "\n" +
      t("本页没写到的内容不要编，直接写「本页没有说明」。") +
      "\n\n" +
      fmtOne
    );
  }
  /* 生成通道：与 rsDeriveGenerate / rsAskOpen 同一条（apiCallTextStream + 当前服务商首个文本模型） */
  async function rsMissStream(prompt, onDelta) {
    if (typeof apiCallTextStream !== "function") throw new Error(t("没有可用的文本模型（设置 · 默认模型）"));
    const prov = resolveProv();
    if (!prov) throw new Error(t("没有可用的文本模型（设置 · 默认模型）"));
    const model = modelOf(prov);
    if (!model) throw new Error(t("该服务商没有可用模型"));
    const spec = {
      provider: prov,
      kind: "text",
      model,
      temperature: 0.4,
      prompt: String(prompt || ""),
      texts: [],
      images: [],
      refImage: "",
    };
    const r = await apiCallTextStream(spec, null, (delta) => {
      if (typeof onDelta === "function") onDelta(String(delta || ""));
    });
    return String((r && r.text) || "");
  }
  /* 把「### 角度 / 正文 / 依据：…」切成卡片；切不出来就原样留着（宁可难看，也别把内容吞掉）。
     每张卡片点一下就派给会话扩充成 notes/<标题>.md（onPick 由面板注入）。 */
  function rsMissRender(bodyEl, text, onPick) {
    const raw = String(text || "").trim();
    bodyEl.innerHTML = "";
    if (!raw) {
      bodyEl.appendChild(el("div", "rs-miss-err", t("模型没有返回内容")));
      return;
    }
    const parts = [];
    let cur = null;
    for (const line of raw.split(/\r?\n/)) {
      const h = /^\s*#{1,4}\s*(.+?)\s*$/.exec(line);
      if (h) {
        cur = { title: h[1], lines: [] };
        parts.push(cur);
        continue;
      }
      if (!cur) {
        cur = { title: "", lines: [] };
        parts.push(cur);
      }
      cur.lines.push(line);
    }
    const cards = parts.filter((p) => p.title || p.lines.join("").trim());
    for (const c of cards) {
      const card = el("div", "rs-miss-card");
      if (c.title) {
        const ct = el("div", "rs-miss-card-t");
        ct.innerHTML = inlineMdHtml(c.title);
        card.appendChild(ct);
      }
      let buf = [];
      const seed = []; /* 交给会话的候选原文（标题 + 正文 + 依据），按卡片内容拼 */
      if (c.title) seed.push("### " + c.title);
      const flush = () => {
        const txt = buf.join("\n").trim();
        buf = [];
        if (txt) {
          const cb = el("div", "rs-miss-card-b");
          cb.innerHTML = inlineMdHtml(txt);
          card.appendChild(cb);
          seed.push(txt);
        }
      };
      for (const line of c.lines) {
        if (/^\s*(?:\*\*)?\s*(依据|出处)/.test(line)) {
          flush();
          const cb = el("div", "rs-miss-basis");
          cb.innerHTML = inlineMdHtml(line.trim());
          card.appendChild(cb);
          seed.push(line.trim());
        } else if (!line.trim()) {
          flush();
        } else {
          buf.push(line);
        }
      }
      flush();
      if (typeof onPick === "function") {
        card.classList.add("pick");
        card.title = t("点这一条：派会话把它扩充成一篇笔记，并把源笔记这一处写成 [[标题]]");
        card.appendChild(el("div", "rs-miss-card-go", t("扩充成笔记 →")));
        const cand = { title: String(c.title || ""), text: seed.join("\n\n") };
        card.onclick = () => onPick(cand);
      }
      bodyEl.appendChild(card);
    }
    if (!cards.length) bodyEl.appendChild(el("div", "rs-miss-live", raw));
  }
  /* ── 「扩充方向」那一块（第一屏只列方向按钮，**一个模型请求都不发**）──
     术语浮层（rsMissingOpen）与公式浮层（阅读器的 .rs-eqmodal，见 rsEqExpand）共用这一份：
     点一个方向 → 就地弹一行确认（会花 Token）→ 确认后才跑 rsMissStream → 卡片可点，
     点卡片才派会话写出 notes/<标题>.md。
     o = { body, kind, name, place?, alive? }
       body  = 挂内容的容器（每次重画前清空）
       place = 内容长高后重摆面板（浮层贴锚点定位时给，缺省不动）
       alive = () => 还该往这块写吗（面板关了 / 换成另一条就成了 false） */
  function rsMissSuggest(o) {
    const kind = String(o.kind || "term") === "formula" ? "formula" : "term";
    const nm = String(o.name || "");
    const bodyEl = o.body;
    if (!bodyEl) return null;
    const place = typeof o.place === "function" ? o.place : () => {};
    const alive = typeof o.alive === "function" ? o.alive : () => true;
    let text = "";
    let tick = 0;
    /* 第一屏：只列「可以补哪些内容」的按钮 */
    function paintSuggest() {
      bodyEl.innerHTML = "";
      const sug = el("div", "rs-miss-sug");
      const list = RS_MISS_ANGLES[kind] || RS_MISS_ANGLES.term;
      for (const ang of list) {
        const b = el("button", "rs-miss-sugbtn", t(ang.label));
        b.type = "button";
        b.title = t("补充这一方向：") + t(ang.label) + t("（点了会先确认是否调用模型）");
        b.onclick = () => paintConfirm(ang);
        sug.appendChild(b);
      }
      /* 末尾那颗「自定义…」：没列到的角度自己写，就地展开输入框，不发请求 */
      const own = el("button", "rs-miss-sugbtn rs-miss-own", t("自定义…"));
      own.type = "button";
      own.title = t("自己写一个方向（提交后同样先确认是否调用模型）");
      own.onclick = () => paintCustom();
      sug.appendChild(own);
      /* 不经过 Agent 的一条路：直接建一篇空笔记，建好就打开给用户自己写（不调模型、不花 Token） */
      const blank = el("button", "rs-miss-sugbtn rs-miss-blank", t("直接新建空笔记"));
      blank.type = "button";
      blank.title = t("不调用模型：只落一个空骨架（标题 + frontmatter），建好就打开，正文由你自己写");
      blank.onclick = () => {
        void rsMissBlank(kind, nm);
      };
      sug.appendChild(blank);
      bodyEl.appendChild(sug);
      place();
    }
    /* 自定义方向：就地展开文本框，空输入时提交按钮禁用；提交后走同一份确认卡 */
    function paintCustom() {
      bodyEl.innerHTML = "";
      const wrap = el("div", "rs-miss-custom");
      const ta = el("textarea", "rs-miss-custom-ta");
      ta.rows = 3;
      ta.placeholder = t("写下你想补的角度（例如：它在证明里起什么作用）");
      const row = el("div", "rs-miss-confirm-row");
      const go = el("button", "rs-btn primary", t("提交"));
      go.type = "button";
      go.disabled = true;
      const back = el("button", "rs-btn", t("再看别的方向"));
      back.type = "button";
      back.onclick = () => paintSuggest();
      const read = () => String(ta.value || "").trim();
      ta.oninput = () => {
        go.disabled = !read();
      };
      go.onclick = () => {
        const txt = read();
        if (!txt) return;
        paintConfirm(rsMissCustomAngle(txt));
      };
      /* Ctrl / Cmd + Enter 与点「提交」同一条路 */
      ta.onkeydown = (ev) => {
        if (ev.key !== "Enter" || !(ev.ctrlKey || ev.metaKey)) return;
        ev.preventDefault();
        if (read()) go.onclick();
      };
      wrap.appendChild(ta);
      row.appendChild(go);
      row.appendChild(back);
      wrap.appendChild(row);
      bodyEl.appendChild(wrap);
      place();
      ta.focus();
    }
    function paintConfirm(ang) {
      bodyEl.innerHTML = "";
      const conf = el("div", "rs-miss-confirm");
      conf.appendChild(
        el(
          "div",
          "rs-miss-confirm-t",
          t("将调用 Agent 生成「") + rsMissAngleLabel(ang) + t("」，会消耗 Token。确认继续？"),
        ),
      );
      const row = el("div", "rs-miss-confirm-row");
      const go = el("button", "rs-btn primary", t("继续"));
      go.type = "button";
      go.onclick = () => runAngle(ang);
      const no = el("button", "rs-btn", t("再看别的方向"));
      no.type = "button";
      no.onclick = () => paintSuggest();
      row.appendChild(go);
      row.appendChild(no);
      conf.appendChild(row);
      bodyEl.appendChild(conf);
      place();
    }
    function runAngle(ang) {
      bodyEl.innerHTML = "";
      const live = el("div", "rs-miss-live", t("生成中…"));
      bodyEl.appendChild(live);
      text = "";
      tick = 0;
      rsMissStream(rsMissPrompt(kind, nm, ang.id, ang.ask), (delta) => {
        text += delta;
        live.textContent = text;
        /* 流式时面板会长高：每 8 片重摆一次，别每个 token 都量一遍 */
        if (++tick % 8 === 0) place();
      })
        .then((full) => {
          if (!alive()) return; /* 已经关掉或换成另一条：别把内容写进错的面板 */
          const txt = full || text;
          /* 点某一条候选 = 派给会话扩充成 notes/<标题>.md */
          rsMissRender(bodyEl, txt, (card) => rsMissPick(kind, nm, card));
          /* 卡片换掉「生成中」后高度会变：重摆一次，放不开自然翻到下方 */
          place();
        })
        .catch((e) => {
          if (!alive()) return;
          bodyEl.innerHTML = "";
          bodyEl.appendChild(el("div", "rs-miss-err", t("调用失败：") + String((e && e.message) || e)));
          const back = el("button", "rs-btn", t("再看别的方向"));
          back.type = "button";
          back.onclick = () => paintSuggest();
          bodyEl.appendChild(back);
          place();
        });
    }
    paintSuggest();
    return { paint: paintSuggest };
  }
  function rsMissingOpen(kind, name, rect) {
    const k = String(kind || "term") === "formula" ? "formula" : "term";
    const nm = String(name || "").trim();
    if (!nm) return;
    const key = k + "\u0000" + nm;
    /* 再点同一元素 = 关上（与 Esc / 点外部 / ✕ 并列的关闭手势） */
    if (rsMissEl && rsMissKey === key) {
      rsMissClose();
      return;
    }
    rsMissClose();
    /* 与其它节点级浮层互斥；术语浮层也先收掉，别两块叠在同一处 */
    if (typeof closeNodePopsExcept === "function") closeNodePopsExcept("");
    const R = rsReader();
    if (R && typeof R.tip === "function") R.tip();
    if (R && typeof R.hideCards === "function") R.hideCards();

    const box = el("div", "rs-miss");
    box.id = "rsMiss";
    /* 面板挂在 body 上（与 .rs-ask 同一口径），亮色页下自己带上 .rs-light 才吃得到这页的变量 */
    const pane = qid("researchPane");
    if (pane && pane.classList.contains("rs-light")) box.classList.add("rs-light");
    const head = el("div", "rs-miss-head");
    head.appendChild(el("span", "rs-miss-kind", k === "formula" ? t("公式") : t("名词")));
    const titleEl = el("b", "rs-miss-name");
    titleEl.innerHTML = inlineHtml(rsMissTitle(k, nm));
    titleEl.title = rsMissTitle(k, nm);
    head.appendChild(titleEl);
    const close = el("button", "rs-miss-x", "✕");
    close.title = t("关闭");
    close.onclick = () => rsMissClose();
    head.appendChild(close);
    box.appendChild(head);
    const bodyEl = el("div", "rs-miss-body");
    box.appendChild(bodyEl);
    /* 派活 / 等落盘 / 失败原因都写在这一行（空的时候 CSS 收起来） */
    const stateEl = el("div", "rs-miss-state");
    box.appendChild(stateEl);
    document.body.appendChild(box);
    rsMissEl = box;
    rsMissKey = key;
    rsMissStateEl = stateEl;
    rsMissRect = rect;
    rsMissPlace(box, rect);
    rsMissEsc = (ev) => {
      if (ev.key !== "Escape") return;
      ev.stopPropagation();
      rsMissClose();
    };
    document.addEventListener("keydown", rsMissEsc, true);
    /* 点外部就关：这块浮层是「点一下看一眼」的只读面板，不做 persistent
       （只有带输入的 .rs-ask 表单才 persistent；公式浮层与它同类，点幕布即收）。
       点在术语 / 公式 / 引用 / 双链上不算外部 ——
       那颗 click 自己会换一块浮层，同一处再点一次也还要留成「关」。 */
    rsMissDown = (ev) => {
      if (rsMissEl !== box) return;
      const tgt = ev.target;
      if (box.contains(tgt)) return;
      if (tgt && tgt.closest && tgt.closest(".rs-term, .rv-math, .rs-cite, .rs-wl")) return;
      rsMissClose();
    };
    document.addEventListener("mousedown", rsMissDown, true);

    /* 第一屏：列「可以补哪些内容」的方向按钮（点方向 → 确认 → 才调模型）。
       公式不再走这块面板 —— 公式用阅读器的 .rs-eqmodal，那一块挂的也是这一份方向区（rsEqExpand）。 */
    rsMissSuggest({
      kind: k,
      name: nm,
      body: bodyEl,
      place: () => rsMissPlace(box, rect),
      alive: () => rsMissEl === box,
    });
  }
  /* ── 公式浮层（阅读器的 .rs-eqmodal）下部的「扩充方向」──
     阅读器每打开一次浮层就把容器交过来，这里把与术语浮层同一份方向区挂进去：
     点方向 → 确认「会消耗 Token」→ 调模型 → 卡片可点 → 派会话扩充成笔记。
     两块浮层不会同时开，状态行（rsMissStateEl）同一时刻只服务一块。 */
  let rsEqToken = null; /* 当前这块方向区的身份：浮层重开就换一个，老的流式结果不再往回写 */
  function rsEqExpand(mountEl, info) {
    if (!mountEl) return;
    const name = String((info && info.name) || "").trim();
    if (!name) return;
    const body = el("div", "rs-miss-body");
    const stateEl = el("div", "rs-miss-state");
    mountEl.appendChild(el("div", "rs-eqmodal-expand-t", t("扩充方向")));
    mountEl.appendChild(body);
    mountEl.appendChild(stateEl);
    const token = {};
    rsEqToken = token;
    /* 派活 / 等落盘 / 失败原因那一行与术语浮层共用一个全局：谁开着就写谁 */
    rsMissStateEl = stateEl;
    /* 浮层重开就换身份，另外浮层被 Esc / 关闭按钮收起来之后也不许再往回写：
       流式结果落到一个看不见的框里就是白烧 Token。 */
    const alive = () => {
      if (rsEqToken !== token) return false;
      const box = mountEl.closest(".rs-eqmodal");
      return !box || box.classList.contains("show");
    };
    rsMissSuggest({ kind: "formula", name, body, alive });
  }
  /* ── 候选 → 派给会话扩充成笔记（接上一项：点候选 → 会话在原研究目录里写 notes/<标题>.md）──
     会话走 research-sync.js 同一套 sessions 薄适配（create / setWorkspace / send / persist / sidebar）；
     面板只负责：派活 → 等那一个文件落盘 → 源笔记那一处写成 [[标题]] → 判色 / 树 / 图谱重建。
     全程只新建这一个 md（源笔记只多一个 [[标题]]，别的一字不动）；失败原因一律回显在面板里。 */
  const RS_MISS_WAIT_MS = 240000; /* 会话迟迟不落盘也算失败，别让面板永远停在「等落盘」 */
  function rsMissSay(text, bad) {
    const s = rsMissStateEl;
    if (!s) return;
    s.textContent = String(text || "");
    s.className = "rs-miss-state" + (bad ? " bad" : "");
    /* 这一行会让面板长高：按被点元素重摆一次（上面放不开自然翻到下方） */
    if (rsMissEl) rsMissPlace(rsMissEl, rsMissRect);
  }
  /* 新笔记的标题 / 名字 / 原式：名词就是名字本身（去掉 [[ ]] 与别名），
     公式按编号给「式 1.2」，没编号就截一段 LaTeX。 */
  function rsMissNote(kind, name) {
    const raw = String(name || "").trim();
    let title = raw;
    let label = "";
    let tex = "";
    if (kind === "formula") {
      const sp = raw.indexOf(" ");
      label = sp > 0 ? raw.slice(0, sp).trim() : "";
      tex = (sp > 0 ? raw.slice(sp + 1) : raw).trim();
      title = label
        ? t("式") + " " + label.replace(/^[（(]+|[）)]+$/g, "").trim()
        : t("式") + " " + (tex.length > 20 ? tex.slice(0, 20) + "…" : tex);
    } else {
      title = raw.replace(/^\[\[|\]\]$/g, "").split("|").pop() || raw;
    }
    /* 文件名不吃 Windows 保留字符；空标题兜一句，别落出一个 `.md` */
    title = title.replace(/[\\/:*?"<>|]/g, "").trim() || t("未命名笔记");
    return { title: title, label: label, tex: tex };
  }
  /* 落盘路径：notes/<slug>.md，同名已存在就 -2 / -3（与 rsNewNote 同一口径） */
  async function rsMissRel(title) {
    const slug = C().slugify(title) || "note";
    let rel = "notes/" + slug + ".md";
    let i = 2;
    while (await exists(joinP(RS.root, rel))) {
      rel = "notes/" + slug + "-" + i + ".md";
      i++;
    }
    return rel;
  }
  /* 会话薄适配（与 rsSync 用同一份；两处各留一份会漂） */
  function rsSessionApi() {
    return {
      list: () => (typeof agentSessions === "function" ? agentSessions() : []),
      create: () => (typeof newAgentSession === "function" ? newAgentSession() : null),
      setWorkspace: (st, dir) =>
        typeof agentSetSessionWorkspace === "function" ? agentSetSessionWorkspace(st, dir) : null,
      persist: () => (typeof persistAgentSession === "function" ? persistAgentSession() : null),
      sidebar: () => (typeof renderAgentSessionSidebar === "function" ? renderAgentSessionSidebar() : null),
      send: (msg, id) => (typeof agentSessionSend === "function" ? agentSessionSend(msg, { sessionId: id }) : null),
    };
  }
  /* 同一个研究目录里复用一条「扩充笔记」会话（没有才新建），与 research-sync 的 findSession 同口径 */
  function rsMissSession(S, rootDir, prefix) {
    if (!S || typeof S.list !== "function") return null;
    const pref = prefix || t("扩充笔记");
    const dir = String(rootDir || "").replace(/[\\/]+$/, "");
    for (const s of S.list() || []) {
      if (!s || s.archived) continue;
      if (String(s.workspace || "").replace(/[\\/]+$/, "") !== dir) continue;
      if (String(s.title || "").indexOf(pref) !== 0) continue;
      return s;
    }
    return null;
  }
  function rsMissAgentPrompt(kind, name, N, card, srcRel) {
    const src = (RS.notes || []).find((n) => n.path === srcRel) || {};
    const root = String(RS.root || "").replace(/\\/g, "/");
    const sel = String((card && card.text) || "").trim();
    const L = [];
    L.push(t("你要把用户选中的一条候选扩充成一篇研究笔记，只新建这一个文件。"));
    L.push("");
    L.push("- " + t("工作目录") + "：`" + root + "`");
    L.push("- " + t("要新建的文件（唯一）") + "：`" + N.rel + "`");
    L.push(
      "- " +
        t("源笔记（只读，一个字都不许改）") +
        "：`" +
        srcRel +
        "`《" +
        String(src.title || srcRel) +
        "》",
    );
    L.push("");
    L.push(
      t("用户点了源笔记里的") + (kind === "formula" ? t("一条公式") : t("一个名词")) + "：" + name,
    );
    L.push("");
    L.push(t("选中的候选（新笔记正文就是它的扩充稿）："));
    L.push(sel || t("（候选为空：按下面三个角度自己写。）"));
    L.push("");
    L.push(t("新笔记严格按这个格式写（Markdown + frontmatter）："));
    L.push("1. " + t("frontmatter：`title: " + N.title + "`、`tags: [...]`、`verify: unverified`；"));
    if (kind !== "formula") {
      L.push(
        "   " +
          t("名词稿再加一行 `aliases: [...]`：外文原词与常见别称都列进去，正文里只用 [[标题]] 这一种写法，不写「（原词）」这类括注。"),
      );
    }
    if (kind === "formula") {
      L.push(
        "   " +
          t("公式稿再加两行关系：`annotates: " + String(src.title || N.title) + "` 与 `relates: [" + String(src.title || "") + "]`（源笔记标题）。"),
      );
    }
    L.push(
      "2. " +
        t("正文：以 `# " + N.title + "` 开头，按候选那三个角度分 `##` 小节，每个角度写实（不要复述要求，不要开场白）。"),
    );
    if (kind === "formula") {
      L.push(
        "3. " +
          t("公式稿必须保留 LaTeX：行内用 $…$，独立成式用 $$…$$；一个符号都不许改写成文字。"),
      );
      L.push(
        "4. " +
          t("再补两类关系块：① 一条 `> [!note] 由来` 批注，写明它由源笔记哪条定义 / 前式推出；② 源笔记里确实存在相关 claim 时，每条写一个 `> [!claim] 论断正文` 块（没有就不写）。"),
      );
      L.push("5. " + t("原式本身再写一个 `> [!formula] " + (N.label || N.title) + "` 块，块内放原 LaTeX。"));
    } else {
      L.push(
        "3. " +
          t("名词稿的术语卡：`> [!term] " + N.title + "`，块内三行写定义 / 上下文里的用法 / 相邻概念对照。"),
      );
    }
    L.push("");
    L.push(t("硬性要求："));
    L.push("- " + t("只新建上面那一个文件；不改源笔记、不新建别的文件、不写 changes.jsonl 或 graph.json、不跑测试、不装依赖。"));
    L.push("- " + t("内容只依据源笔记正文与其中引用的定义；源笔记没写到的不要编，直接写「源笔记没有说明」。"));
    L.push("- " + t("写完回一句话：写了哪个文件、大概多少字。"));
    return L.join("\n");
  }
  async function rsMissDispatch(N, prompt) {
    const S = rsSessionApi();
    if (typeof S.send !== "function" || typeof S.create !== "function")
      throw new Error(t("会话模块没加载（agent 会话不可用）"));
    let st = rsMissSession(S, RS.root);
    if (!st) {
      st = S.create();
      if (!st) throw new Error(t("新建会话失败"));
      st.title = t("扩充笔记") + " · " + String((RS.meta && RS.meta.title) || N.title);
      st.titleLocked = true;
      st.titleAuto = false;
      st.canvasWfId = String(RS.wfId || "") || st.canvasWfId;
      try {
        if (S.setWorkspace) await S.setWorkspace(st, RS.root);
      } catch (_) {}
      try {
        if (S.persist) await S.persist();
        if (S.sidebar) await S.sidebar();
      } catch (_) {}
    }
    S.send(prompt, st.id);
    return st.id;
  }
  /* 点了某一条候选：派活，然后盯着 notes/<标题>.md 出现（会话是异步写盘的） */
  async function rsMissPick(kind, name, card) {
    if (rsMissJob) return; /* 一次只等一件：上一件还没落盘就再点，只会写出两篇互相打架的稿子 */
    if (!RS.root) return rsMissSay(t("研究目录还没就绪"), true);
    const srcRel = String(RS.curPath || "");
    if (!srcRel) return rsMissSay(t("还没打开笔记"), true);
    const N = rsMissNote(kind, name);
    /* 同名笔记已经有了：再建一篇 -2 只会让 [[标题]] 指错地方，直接把那一篇报出来 */
    const dup = (RS.notes || []).find((n) => n.title === N.title);
    if (dup) {
      rsMissSay(t("库里已经有这篇笔记：") + dup.path);
      return;
    }
    /* 派活 = 起一条 agent 会话写文件（比上面那次简释更贵）：再确认一次，别一点就烧 Token */
    if (typeof confirmDialog === "function") {
      rsMissSay(""); /* 先把上一行的「正在派」清掉，等用户确认 */
      const ok = await confirmDialog(
        t("将派一条 Agent 会话，把这一条扩写成 ") + N.title + t(" 这篇笔记（会消耗 Token，可能要等几十秒）。继续吗？"),
        { title: t("扩充成笔记"), okText: t("派给会话"), cancelText: t("取消"), defaultCancel: true },
      );
      if (!ok) return;
    }
    rsMissSay(t("正在派给会话…"));
    try {
      N.rel = await rsMissRel(N.title);
      const prompt = rsMissAgentPrompt(kind, name, N, card, srcRel);
      await rsMissDispatch(N, prompt);
    } catch (e) {
      rsMissSay(t("派活失败：") + String((e && e.message) || e), true);
      return;
    }
    /* 一个面板只派一次：再点同一批候选只会写出同名第二篇 */
    if (rsMissEl)
      for (const c of rsMissEl.querySelectorAll(".rs-miss-card.pick")) {
        c.classList.remove("pick");
        c.onclick = null;
      }
    rsMissWatch(N, kind, name, srcRel);
  }
  function rsMissWatch(N, kind, name, srcRel) {
    const abs = joinP(RS.root, N.rel);
    const job = { rel: N.rel, timer: null, last: null, stable: 0, startedAt: Date.now(), busy: false };
    rsMissJob = job;
    const stop = () => {
      if (job.timer) clearInterval(job.timer);
      job.timer = null;
      if (rsMissJob === job) rsMissJob = null;
    };
    const tick = async () => {
      if (rsMissJob !== job || job.busy) return;
      job.busy = true;
      try {
        const txt = await readText(abs).catch(() => "");
        if (rsMissJob !== job) return;
        if (String(txt || "").trim()) {
          /* 会话可能分几次写：连着两拍字节一样才算写完 */
          if (txt !== job.last) {
            job.last = txt;
            job.stable = 0;
          } else {
            job.stable++;
          }
          rsMissSay(t("会话正在写 ") + N.rel + "…");
          if (job.stable >= 2) {
            stop();
            await rsMissDone(N, kind, name, srcRel, txt);
          }
          return;
        }
        if (Date.now() - job.startedAt > RS_MISS_WAIT_MS) {
          stop();
          rsMissSay(t("超时：会话没有写出 ") + N.rel + t("（去左栏那条「扩充笔记」会话看它卡在哪）"), true);
        } else {
          rsMissSay(t("已派给会话，等它写出 ") + N.rel + "…");
        }
      } finally {
        job.busy = false;
      }
    };
    job.timer = setInterval(() => {
      tick().catch(() => {});
    }, 1500);
    rsMissSay(t("已派给会话，等它写出 ") + N.rel + "…");
    tick().catch(() => {});
  }
  /* 落盘之后：新笔记进历史 → 源笔记那一处写成 [[标题]] → 判色 / 树 / 图谱一起刷新 */
  async function rsMissDone(N, kind, name, srcRel, txt) {
    const body = String(txt || "");
    if (!body.trim()) {
      rsMissSay(t("会话写出的 ") + N.rel + t(" 是空的"), true);
      return;
    }
    let link = { changed: false, why: "" };
    try {
      /* 与 rsNewNote 同一个 kind：撤销时才能把这篇收进回收站，而不是留一个空文件 */
      await logChange(t("新建笔记"), N.rel, "", body);
      link = await rsMissLink(kind, name, N, srcRel);
      await rsLoadNotes();
      /* 判色（research-versions）：新笔记按当前字节重判三态，不沿用上一轮缓存 */
      rsStatusReset();
      rsVersionsKick();
      renderSide();
      renderTop();
      /* 图谱重建：新笔记立刻出现，源笔记那条 [[标题]] 把它连上（公式稿的 annotates / claim 边由它自己正文带来） */
      if (RS.graph) await rsRebuildGraph({ keepPositions: true, silent: true });
      /* 阅读区里那一段原来只是纯文字：重画一次，刚写的 [[标题]] 当场变成可点链接
         （正在源码模式打字时不重画，免得吃掉光标） */
      if (RS.curPath === srcRel && !RS.dirty && document.activeElement !== RS.srcEl) renderEditor();
    } catch (e) {
      rsMissSay(t("已生成 ") + N.rel + t("，但收尾失败：") + String((e && e.message) || e), true);
      return;
    }
    rsMissSay(
      t("已生成 ") + N.rel + " · " + (link.changed ? t("源笔记那一处已写成 ") + "[[" + N.title + "]]" : t("源笔记") + link.why),
    );
  }
  /* ── 术语页「引申」：候选清单 → 勾选 → 长出一层 ──
     术语页（terms/<slug>.md）既是图谱里的一类节点，也是「递归解释」的入口：每一页底部列着
     「还能引申」的候选，勾几个就长出下一层，下一层自己也可以再引申 —— 越读越贴近根的直觉。
     两道闸（共识）：① 候选先摆在眼前（不花 Token，勾选即止）；② 点「生成这一层」才派会话。 */
  let rsTermEl = null;
  let rsTermJob = null;
  let rsTermEsc = null;
  let rsTermSayEl = null;

  function rsTermSay(msg, bad) {
    if (!rsTermSayEl) return;
    rsTermSayEl.textContent = String(msg || "");
    rsTermSayEl.classList.toggle("bad", !!bad);
  }
  function rsTermClose() {
    if (rsTermEsc) {
      document.removeEventListener("keydown", rsTermEsc, true);
      rsTermEsc = null;
    }
    if (rsTermEl && rsTermEl.parentNode) rsTermEl.parentNode.removeChild(rsTermEl);
    rsTermEl = null;
    rsTermSayEl = null;
  }
  /* 当前读的这一页是不是术语页：认目录（terms/）也认 frontmatter 的 kind，
     这样把术语页挪到 notes/ 下、或手写一篇 kind: formula 的稿子，也同样能引申。 */
  function rsTermPage() {
    const rel = String(RS.curPath || "");
    const rec = (RS.notes || []).find((n) => n.path === rel);
    if (!rec) return null;
    const Cc = C();
    /* 判据只有两条，且都不许「空值兜底成 term」：
       ① 在 terms/ 目录下；② frontmatter 显式写了术语类的 kind（term / concept / formula / …）。
       普通笔记没有 kind（termKindOf("") 会兜成 "term"），所以必须要求原值非空再归一。 */
    const rawKind = String((rec.meta && rec.meta.kind) || "").trim();
    const kind = rawKind && Cc && Cc.termKindOf ? Cc.termKindOf(rawKind) : "";
    const isTermDir = /^terms\//.test(rel);
    const isTermKind = !!(kind && Cc.TERM_KINDS && Cc.TERM_KINDS[kind]);
    return isTermDir || isTermKind ? rec : null;
  }
  /* 取某一节的正文（`## 标题` 到下一个 `##`） */
  function rsTermSection(md, head) {
    const lines = String(md || "").split(/\r?\n/);
    const re = new RegExp("^##\\s*" + head + "\\s*$");
    const i = lines.findIndex((l) => re.test(l));
    if (i < 0) return "";
    const out = [];
    for (let k = i + 1; k < lines.length; k++) {
      if (/^##\s+/.test(lines[k])) break;
      out.push(lines[k]);
    }
    return out.join("\n");
  }
  /* 候选 = 页面「还能引申」段里列过的 + 正文里 [[…]] 还没建页的。
     已经在库里的名字不列（引申不许重复造页）—— 判重按 nameKey 归一：
     大小写 / 全半角括号 / 空格不同也算同一件事，不能再长第二页。 */
  function rsTermCands(rec) {
    const Cc = C();
    const md = String((rec && rec.md) || "");
    const keyOf = (s) => (Cc && typeof Cc.nameKey === "function" ? Cc.nameKey(s) : String(s || "").trim());
    const known = new Set((RS.notes || []).map((n) => keyOf(n.title)));
    const raw = rsTermSection(md, "还能引申")
      .replace(/^\s*>\s?/gm, "")
      .replace(/\[!question\][^\n]*/g, "");
    const out = [];
    const seen = new Set();
    const add = (name, kind, why) => {
      const n = String(name || "").replace(/^\[\[|\]\]$/g, "").trim();
      if (!n) return;
      const k = keyOf(n);
      if (!k || k === keyOf(rec && rec.title) || known.has(k) || seen.has(k)) return;
      seen.add(k);
      out.push({ name: n, kind: kind || "term", why: String(why || "").trim() });
    };
    for (const c of (Cc && Cc.parseTermCandidates ? Cc.parseTermCandidates(raw) : [])) add(c.name, c.kind, c.why);
    const re = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
    let m;
    while ((m = re.exec(md))) add(m[1]);
    return out;
  }
  /* 面板：一颗「引申」按钮点开它；再点一次 / Esc / ✕ 关闭（带输入的浮层，点外部不关）。 */
  function rsTermOpen() {
    const rec = rsTermPage();
    if (!rec) {
      toastSafe(t("引申只对术语页 / 公式页开放（terms/ 下的页面）"), "warn");
      return;
    }
    if (rsTermEl) {
      rsTermClose();
      return;
    }
    const pop = el("div", "rs-term-pop");
    pop.setAttribute("role", "dialog");
    pop.setAttribute("aria-label", t("从这一页引申"));
    const head = el("div", "rs-term-pop-head");
    head.appendChild(el("b", null, t("从「") + rec.title + t("」引申")));
    const x = el("button", "rs-term-x", "✕");
    x.type = "button";
    x.title = t("关闭（Esc）");
    x.onclick = () => rsTermClose();
    head.appendChild(x);
    pop.appendChild(head);
    pop.appendChild(
      el("div", "rs-term-pop-sub", t("勾选要长出来的下一层：每个都会是一篇独立的术语页，并连回这一页与原文。")),
    );
    const list = el("div", "rs-term-list");
    pop.appendChild(list);
    const say = el("div", "rs-term-say");
    rsTermSayEl = say;
    pop.appendChild(say);
    const foot = el("div", "rs-term-foot");
    const moreBtn = el("button", "rs-term-btn", t("让 Agent 再找一轮候选"));
    moreBtn.type = "button";
    moreBtn.title = t("按这一页正文再找 2–6 个候选，追加到「还能引申」；不建页、不花太多 Token");
    moreBtn.onclick = () => void rsTermMore(rec, list, moreBtn);
    const goBtn = el("button", "rs-term-btn go", t("生成这一层"));
    goBtn.type = "button";
    goBtn.onclick = () => void rsTermGo(rec);
    foot.appendChild(moreBtn);
    foot.appendChild(goBtn);
    pop.appendChild(foot);
    (RS.bodyEl || document.body).appendChild(pop);
    rsTermEl = pop;
    rsTermEsc = (ev) => {
      if (ev.key === "Escape") {
        ev.stopPropagation();
        rsTermClose();
      }
    };
    document.addEventListener("keydown", rsTermEsc, true);
    rsTermRender(rec, list);
  }
  function rsTermRender(rec, list) {
    list.innerHTML = "";
    const cands = rsTermCands(rec);
    if (!cands.length) {
      list.appendChild(el("div", "rs-term-empty", t("这一页还没有候选：点下面「让 Agent 再找一轮候选」。")));
      return;
    }
    for (const c of cands) {
      const row = el("label", "rs-term-row");
      const cb = el("input");
      cb.type = "checkbox";
      cb.value = c.name;
      cb.dataset.kind = c.kind;
      cb.dataset.why = c.why;
      row.appendChild(cb);
      const nm = el("span", "rs-term-name");
      nm.textContent = c.name;
      row.appendChild(nm);
      const kd = el("span", "rs-term-kind");
      kd.textContent = t((C().TERM_KINDS || {})[c.kind] || c.kind);
      row.appendChild(kd);
      if (c.why) row.appendChild(el("span", "rs-term-why", c.why));
      list.appendChild(row);
    }
  }
  /* 让 agent 补一轮候选：结果解析成候选行，直接写回本页「还能引申」（不建页）。 */
  async function rsTermMore(rec, list, btn) {
    if (!rec) return;
    btn.disabled = true;
    rsTermSay(t("正在让 Agent 找候选…"));
    try {
      const known = (RS.notes || []).map((n) => n.title);
      const prompt = C().termExpandPrompt({
        name: rec.title,
        md: rec.md,
        existing: known,
      });
      const txt = await rsMissStream(prompt);
      const got = C().parseTermCandidates(txt);
      if (!got.length) {
        rsTermSay(t("没解析出候选：把 Agent 的话看一眼，或自己往「还能引申」里写 [[名字]]"), true);
        return;
      }
      /* 写回页面：追加到「还能引申」段末（写成带种类与理由的一行，下一次读回来就有理由） */
      const lines = got.map((c) => {
        const k = (C().TERM_KINDS || {})[c.kind] || "术语";
        return "- " + c.name + " | " + k + (c.why ? " | " + c.why : "");
      });
      await rsTermAppendNext(rec, got.map((c) => c.name));
      rsTermSay(t("加了 ") + got.length + t(" 个候选（只列在「还能引申」里，还没建页）"));
      rsTermRender(rec, list);
      void lines;
    } catch (e) {
      rsTermSay(t("找候选失败：") + String((e && e.message) || e), true);
    } finally {
      btn.disabled = false;
    }
  }
  /* 往「还能引申」段末补 [[名字]]（已有就不重复写）；只动这一页，正文别处一个字节不改。 */
  async function rsTermAppendNext(rec, names) {
    const cur = (RS.notes || []).find((n) => n.path === rec.path);
    if (!cur) return;
    const md = String(cur.md || "");
    const missing = (names || []).filter((n) => md.indexOf("[[" + n + "]]") < 0);
    if (!missing.length) return;
    const lines = md.split(/\r?\n/);
    const i = lines.findIndex((l) => /^##\s*还能引申\s*$/.test(l));
    /* 候选写成普通列表行，不套 `> [!question] 待展开`：那个 callout 会进「问题清单」，
       而问题清单只放用户自己填的问题。 */
    const add = missing.map((n) => "- [[" + n + "]]");
    if (i < 0) {
      lines.push("", "## 还能引申", "", ...add, "");
    } else {
      let at = i + 1;
      for (let k = i + 1; k < lines.length; k++) {
        if (/^##\s+/.test(lines[k])) break;
        at = k + 1;
      }
      lines.splice(at, 0, ...add);
    }
    const next = lines.join("\n");
    cur.md = next;
    if (RS.curPath === rec.path) RS.md = next;
    try {
      await window.api.fileWriteText(joinP(RS.root, rec.path), next);
      await logChange(t("补候选"), rec.path, md, next);
    } catch (_) {}
  }
  /* 勾选 → 生成一层：一次会话写多个文件（每个子术语一篇）。 */
  async function rsTermGo(rec) {
    if (rsTermJob) {
      rsTermSay(t("上一批还在等落盘，别叠着派"), true);
      return;
    }
    const picks = [];
    for (const cb of (rsTermEl ? rsTermEl.querySelectorAll(".rs-term-row input:checked") : [])) {
      picks.push({ name: cb.value, kind: cb.dataset.kind || "term", why: cb.dataset.why || "" });
    }
    if (!picks.length) {
      rsTermSay(t("先勾几个候选"), true);
      return;
    }
    const Cc = C();
    const keyOf = (s) => (Cc && typeof Cc.nameKey === "function" ? Cc.nameKey(s) : String(s || "").trim());
    const haveKeys = new Set((RS.notes || []).map((n) => keyOf(n.title)));
    const targets = [];
    let existed = 0;
    for (const p of picks) {
      const rel = Cc.TERM_DIR + "/" + Cc.termSlug(p.name) + ".md";
      /* 判重两道：同一个 rel（同一个 slug），或同一件事换个写法已经有页了 ——
         **已存在的不再添加**：那一页照旧在图谱里连着，不新建第二篇。 */
      if ((RS.notes || []).some((n) => n.path === rel) || haveKeys.has(keyOf(p.name))) {
        existed++;
        continue;
      }
      if (targets.some((x) => x.rel === rel)) continue;
      targets.push({ name: p.name, kind: p.kind, why: p.why, rel });
    }
    if (!targets.length) {
      rsTermSay(t("勾选的这些都已经有页了"), true);
      return;
    }
    if (existed) rsTermSay(t("跳过 ") + existed + t(" 个已有页（沿用那一页，不重新建）"));
    if (typeof confirmDialog === "function") {
      const ok = await confirmDialog(
        t("将派一条 Agent 会话，写出 ") +
          targets.length +
          t(" 篇术语页（会消耗 Token，可能要等几十秒）。继续吗？"),
      );
      if (!ok) return;
    }
    const prompt = rsTermLayerPrompt(rec, targets);
    try {
      await rsMissDispatch({ title: rec.title }, prompt);
    } catch (e) {
      rsTermSay(t("派活失败：") + String((e && e.message) || e), true);
      return;
    }
    rsTermWatch(rec, targets);
  }
  /* 给会话的成稿要求：字段照 termDoc 的口径，图 / 公式原样搬，不许编。
     提示词正文直接写中文（它是给 agent 的，不进界面，不需要 i18n 词条）。 */
  function rsTermLayerPrompt(rec, targets) {
    const root = String(RS.root || "").replace(/\\/g, "/");
    const meta = rec.meta || {};
    const derives = (Array.isArray(meta.derives) ? meta.derives : []).filter(Boolean);
    const sources = (Array.isArray(meta.sources) ? meta.sources : []).filter(Boolean);
    const L = [];
    L.push("你要给一篇术语页长出下一层：只新建下面列出的文件，别的文件一个字都不许改。");
    L.push("");
    L.push("- 工作目录：`" + root + "`");
    L.push("- 父页（只读，除「还能引申」外不许改）：`" + rec.path + "`《" + rec.title + "》");
    L.push("");
    L.push("要新建的文件（每个一行，文件名与路径照抄，不许改名）：");
    for (const x of targets) L.push("- `" + x.rel + "` → " + x.name + "（" + x.kind + "）" + (x.why ? " · 为什么要讲：" + x.why : ""));
    L.push("");
    L.push("每篇的 frontmatter 必须正好这些键：");
    L.push("`title`（就是这个名字）、`kind`（term / concept / formula / symbol / theorem / method / dataset 之一）、`slug`（文件名去后缀）、`derives: [" + (derives.length ? derives.join(", ") : rec.title) + "]`（原文标题）、`relates: [" + rec.title + "]`（父页，用来在图谱里连回去）、`sources: [" + (sources[0] || rec.title) + "]`（父页「在原文里」列过的那一条，照抄）、`origin: expand`、`verify: unverified`、`init: done`、`date`（今天，YYYY-MM-DD）。");
    L.push("");
    L.push("正文按这个骨架写（段落顺序不许变，没有内容的段落就写一句「父页没有展开」）：");
    L.push("# 名字");
    L.push("> [!term] 名字");
    L.push("> 一句定义（能独立看懂，不要「如上所述」这种依赖上下文的写法）");
    L.push("## 直觉");
    L.push("## 公式 / 记号   （只有公式 / 符号类才写，LaTeX 原样保留：行内 $…$、独立 $$…$$）");
    L.push("## 符号          （符号约定类才写）");
    L.push("## 在原文里      （父页 sources 那一条 + 一句它出现在哪一节、解决什么）");
    L.push("## 还能引申      （**只有真的冒出 1–4 个下层候选才写这一节**，每个一行 `- [[下层术语]]`；没有候选就整节不写 —— 别留空标题、别写「暂无」、别写 `> [!question]` 块）");
    L.push("");
    L.push("硬性要求：");
    L.push("- 内容只许来自父页正文、父页「在原文里」指向的原文小节、以及这两处出现的定义；父页没写的不要编，写「父页没有展开」。");
    L.push("- 图上能画就用原文里的图（父页若有 `![…](…/assets/…)`，子页要引用同一张时照抄相对路径，不要生成新图）；要画流程才用 ```mermaid（≤12 个节点）。");
    L.push("- 只新建上面那几个文件；不改父页以外的任何文件、不写 changes.jsonl / graph.json、不跑测试、不装依赖。");
    L.push("- 父页的「## 还能引申」里，把已建页的名字写成 `- [[名字]]`（缺就补一行），其余不动。");
    L.push("- 写完回一句话：写了哪几个文件。");
    return L.join("\n");
  }
  function rsTermWatch(rec, targets) {
    const job = {
      files: targets.map((x) => x.rel),
      timer: null,
      last: {},
      stable: {},
      startedAt: Date.now(),
      busy: false,
    };
    rsTermJob = job;
    const stop = () => {
      if (job.timer) clearInterval(job.timer);
      job.timer = null;
      if (rsTermJob === job) rsTermJob = null;
    };
    const tick = async () => {
      if (rsTermJob !== job || job.busy) return;
      job.busy = true;
      try {
        let done = 0;
        for (const rel of job.files) {
          const txt = await readText(joinP(RS.root, rel)).catch(() => "");
          if (!String(txt || "").trim()) continue;
          if (txt !== job.last[rel]) {
            job.last[rel] = txt;
            job.stable[rel] = 0;
          } else {
            job.stable[rel] = (job.stable[rel] || 0) + 1;
          }
          if ((job.stable[rel] || 0) >= 2) done++;
        }
        if (done >= job.files.length) {
          stop();
          await rsTermDone(rec, targets);
          return;
        }
        rsTermSay(t("会话正在写：") + done + " / " + job.files.length);
        if (Date.now() - job.startedAt > RS_MISS_WAIT_MS) {
          stop();
          rsTermSay(t("超时：会话没有写出全部页面（去左栏那条「扩充笔记」会话看它卡在哪）"), true);
        }
      } finally {
        job.busy = false;
      }
    };
    job.timer = setInterval(() => {
      tick().catch(() => {});
    }, 1500);
    rsTermSay(t("已派给会话，等它写出 ") + job.files.length + t(" 篇…"));
    tick().catch(() => {});
  }
  async function rsTermDone(rec, targets) {
    try {
      for (const x of targets) {
        const raw = await readText(joinP(RS.root, x.rel)).catch(() => "");
        if (!String(raw || "").trim()) continue;
        /* 会话照着骨架常留一个空的「## 还能引申」标题：落盘前收掉（只删空节，真写了候选的一个字节不动） */
        const body = (C() && C().stripEmptyNextSection) ? C().stripEmptyNextSection(raw) : raw;
        if (body !== raw) await window.api.fileWriteText(joinP(RS.root, x.rel), body).catch(() => {});
        await logChange(t("新建术语页"), x.rel, "", body);
      }
      await rsLoadNotes();
      rsStatusReset();
      rsVersionsKick();
      renderSide();
      renderTop();
      if (RS.graph) await rsRebuildGraph({ keepPositions: true, silent: true });
      if (RS.curPath === rec.path && !RS.dirty) renderEditor();
      rsTermSay(t("已长出 ") + targets.length + t(" 页：") + targets.map((x) => x.name).join("、"));
      if (rsTermEl) {
        const list = rsTermEl.querySelector(".rs-term-list");
        const fresh = (RS.notes || []).find((n) => n.path === rec.path);
        if (list && fresh) rsTermRender(fresh, list);
      }
    } catch (e) {
      rsTermSay(t("已生成，但收尾失败：") + String((e && e.message) || e), true);
    }
  }

  /* 「直接新建空笔记」：**不派会话、不调模型、不花 Token** ——
     只落一个带 frontmatter 的空骨架（标题 + 日期 + verify: unverified），
     再把源笔记那一处写成 [[标题]]，最后把这篇打开给用户自己写。
     与 rsMissDone 的收尾同一套（判色 / 树 / 图谱 / 打开），只少了「等会话写盘」那一段。 */
  async function rsMissBlank(kind, name) {
    if (!RS.root) return rsMissSay(t("研究目录还没就绪"), true);
    const srcRel = String(RS.curPath || "");
    if (!srcRel) return rsMissSay(t("还没打开笔记"), true);
    const N = rsMissNote(kind, name);
    /* 同名笔记已经有了：再建一篇 -2 只会让 [[标题]] 指错地方，直接把那一篇报出来 */
    const dup = (RS.notes || []).find((n) => n.title === N.title);
    if (dup) return rsMissSay(t("库里已经有这篇笔记：") + dup.path);
    let link = { changed: false, why: "" };
    try {
      N.rel = await rsMissRel(N.title);
      const md = C().stringifyFrontmatter(
        {
          title: N.title,
          tags: [],
          verify: "unverified",
          date: new Date().toISOString().slice(0, 10),
        },
        "\n# " + N.title + "\n\n",
      );
      await window.api.fileWriteText(joinP(RS.root, N.rel), md);
      await logChange(t("新建笔记"), N.rel, "", md);
      link = await rsMissLink(kind, name, N, srcRel);
      await rsLoadNotes();
      rsStatusReset();
      rsVersionsKick();
      renderSide();
      renderTop();
      if (RS.graph) await rsRebuildGraph({ keepPositions: true, silent: true });
      rsMissClose();
      await rsOpenNote(N.rel);
      toastSafe(
        t("已新建空笔记 ") +
          N.rel +
          (link.changed ? t("，源笔记那一处已写成 ") + "[[" + N.title + "]]" : t("（正文由你自己写）")),
      );
    } catch (e) {
      rsMissSay(t("新建空笔记失败：") + String((e && e.message) || e), true);
    }
  }
  /* 源笔记那一处写成 [[标题]]：名词换掉正文里第一处该词（不在已有 [[…]] 内、不碰 frontmatter）；
     公式插在原式之后（插进 $…$ 里会坏渲染）。已有同名链接就不重复插。 */
  async function rsMissLink(kind, name, N, srcRel) {
    const abs = joinP(RS.root, srcRel);
    const disk = await readText(abs).catch(() => "");
    /* 这一篇正开在编辑器里就用内存里那份（含未落盘的输入），否则读盘 */
    const edited = RS.curPath === srcRel && RS.foldPath !== srcRel && RS.md != null;
    const before = edited ? String(RS.md) : String(disk || "");
    const res = rsMissLinkText(before, kind, name, N);
    if (!res.changed) return res;
    if (edited) {
      /* 既有写入口：写入闸 / changes.jsonl / 判色 / 图谱都在 rsSaveCurrent 里 */
      const ok = await rsSaveCurrent(res.md);
      if (ok === false) return { changed: false, why: t("那一处没写进去（版本组里这一版被改过，已取消）") };
      return { changed: true };
    }
    if (!(await rsWriteGate(srcRel))) return { changed: false, why: t("那一处没写进去（版本组里这一版被改过，已取消）") };
    await window.api.fileWriteText(abs, res.md);
    await logChange(t("扩充笔记"), srcRel, before, res.md);
    return { changed: true };
  }
  function rsMissLinkText(md, kind, name, N) {
    const text = String(md || "");
    const link = "[[" + N.title + "]]";
    if (text.indexOf(link) >= 0) return { changed: false, md: text, why: t("里已经有 ") + link };
    const head = splitFm(text).head || "";
    const from = head.length; /* 只在正文里找：frontmatter 里插链接会把 YAML 写坏 */
    const spans = [];
    const re = /\[\[[^\]]*\]\]/g;
    let m;
    while ((m = re.exec(text))) spans.push([m.index, m.index + m[0].length]);
    const inLink = (i) => spans.some((s) => i >= s[0] && i < s[1]);
    if (kind !== "formula") {
      let at = text.indexOf(name, from);
      while (at >= 0 && inLink(at)) at = text.indexOf(name, at + 1);
      if (at < 0) return { changed: false, md: text, why: t("里没找到这处名词，未插入链接") };
      return { changed: true, md: text.slice(0, at) + link + text.slice(at + name.length) };
    }
    /* 公式：原式之后插链接（先原 LaTeX，找不到再退回按编号） */
    const at = N.tex ? text.indexOf(N.tex, from) : -1;
    if (at >= 0) {
      let i = at + N.tex.length;
      while (i < text.length && text.charAt(i) !== "$") i++;
      let j = i;
      while (j < text.length && text.charAt(j) === "$") j++;
      if (i < text.length) return { changed: true, md: text.slice(0, j) + " " + link + text.slice(j) };
    }
    const lb = N.label || "";
    const lat = lb ? text.indexOf(lb, from) : -1;
    if (lat >= 0)
      return { changed: true, md: text.slice(0, lat + lb.length) + " " + link + text.slice(lat + lb.length) };
    return { changed: false, md: text, why: t("里没找到这条式子，未插入链接") };
  }
  /* 公式浮层里改 LaTeX：只换原文里**这一条**式子（第一处匹配，四种定界符都认），
     就地换掉阅读区那颗节点（不整篇重渲染，阅读位置不跳），再走常规落盘（含 changes 记录）。
     源码里找不到（例如式子在 frontmatter / 折叠投影里）→ false，浮层原样留着让用户取消。
     写入闸拒了：整笔不落盘（RS.md 没动过），重渲染回到改之前那一版，并 toast 说清。 */
  async function rsSwapFormula(hostEl, oldTex, newTex) {
    const from = String(oldTex || "").trim();
    const to = String(newTex || "").trim();
    if (!from || !to || from === to) return false;
    /* 就地编辑面上 RS.md 可能比 DOM 旧一步（debounce 还没转）：先把正文转回 md 再换这条式子，
       否则刚打的那几个字会被这一笔覆盖掉 */
    if (RS.inlineOn) {
      const fresh = rsInlineMd();
      if (fresh != null) RS.md = fresh;
    }
    const md = String(RS.md || "");
    const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pairs = [
      ["$$", "$$"],
      ["$", "$"],
      ["\\(", "\\)"],
      ["\\[", "\\]"],
    ];
    let next = "";
    for (const pair of pairs) {
      const re = new RegExp(escRe(pair[0]) + "\\s*" + escRe(from) + "\\s*" + escRe(pair[1]));
      if (re.test(md)) {
        next = md.replace(re, () => pair[0] + to + pair[1]);
        break;
      }
    }
    if (!next || next === md) return false;
    try {
      const M = window.MTMathRender;
      if (M && hostEl && hostEl.parentNode) {
        const display = hostEl.getAttribute("data-rv-display") === "1";
        const delim = hostEl.getAttribute("data-rv-delim") || (display ? "$$" : "$");
        const holder = document.createElement("span");
        holder.innerHTML = M.latexToHtml(to, { display: display, delim: delim });
        const node = holder.firstElementChild;
        if (node) hostEl.parentNode.replaceChild(node, hostEl);
      }
    } catch (_) {}
    /* 落盘走常规通道（金色版本写入闸 / changes.jsonl / 图谱增量都在里面），等它落地再回报：
       闸拒了就整笔不落盘 —— RS.md 从来没被改过，重渲染即回到改之前那一版，并 toast 说清。 */
    let ok = false;
    try {
      ok = await rsSaveCurrent(next);
    } catch (_) {
      ok = false;
    }
    if (!ok) {
      RS.dirty = false;
      renderEditor();
      toastSafe(t("没保存：写入被拒，公式已回到修改前"), "warn");
      return false;
    }
    return true;
  }
  function rsDecorateReading(root) {
    const R = rsReader();
    if (!R) return;
    R.decorate(root, {
      outline: RS.outlineEl,
      progress: RS.progressEl,
      scrollRoot: RS.bodyEl,
      notes: RS.notes,
      /* 这一篇的源码：阅读器据此把每一颗 `[@key]` 对到它的行号（引用笔记的唯一键要用） */
      src: { path: RS.curPath || "", md: RS.md || "" },
      /* 章节表换了 / 读到另一节：只刷面包屑末两级，整条不重建 */
      onActive: () => rsCrumbsTail(),
    });
  }
  /* 图谱右栏预览那一块的收尾：与阅读态同一批装饰器（`[!term]` / `[!claim]` 的抬头与术语卡、
      `[[双链]]` → 条目梗、`[@key]` → 引用梗、机器写的「一句一行」合回段落流）。不跑整份 decorate
     —— 它还要建大纲 / 进度 / 滚动侦听，那些只属于正文那一面。顺序照阅读态走。 */
  function rsGraphPreviewDecorate(root) {
    const R = rsReader();
    if (!R || !root) return;
    /* 1) 先挂引用块的类（`[!term]` → .rs-callout-term）：CSS 的形制、术语卡的选中都靠它 */
    try {
      decorateCallouts(root);
    } catch (_) {}
    /* 2) 再收标记：`[!term]` 名称 → 「术语 · 名称」抬头，`[!claim] 标题` → 抬头行 */
    if (typeof R.decorateCalloutHeads === "function") {
      try {
        R.decorateCalloutHeads(root);
      } catch (_) {}
    }
    if (typeof R.decorateWikilinks === "function") {
      try {
        R.decorateWikilinks(root);
      } catch (_) {}
    }
    /* 3) 溯源行要在合软换行之前收：joinSoftBreaks 会跳过 .rs-meta-line */
    if (typeof R.decorateMetaLines === "function") {
      try {
        R.decorateMetaLines(root);
      } catch (_) {}
    }
    /* joinSoftBreaks 内部已先跑 decorateCitations（`[@key]` → 引用梗） */
    if (typeof R.joinSoftBreaks === "function") {
      try {
        R.joinSoftBreaks(root);
      } catch (_) {}
    }
  }
  /* 就地编辑面里的双链：只做 `[[译名]]` → 链接这一层（术语浮层 / 公式编号仍不挂），
     回写靠 rsInlineMd 按 data-wl 还原，所以编辑面不再把 `[[…]]` 原样露给用户。 */
  function rsDecorateInlineLinks(root) {
    const R = rsReader();
    if (!R || typeof R.decorateWikilinks !== "function") return;
    R.decorateWikilinks(root);
  }
  /* 编辑态右侧预览没走 decorate，单独补「合软换行」这一步 */
  function rsJoinSoftBreaks(root) {
    const R = rsReader();
    if (R && typeof R.joinSoftBreaks === "function") R.joinSoftBreaks(root);
  }
  function rsBuildOutline(root) {
    const R = rsReader();
    if (!R) return;
    R.outline(root, RS.outlineEl, RS.bodyEl, { onActive: () => rsCrumbsTail() });
  }
  function rsStopSpy() {
    const R = rsReader();
    if (R) R.stopSpy();
  }

  /* ── 同步下游（renderer/research-sync.js · window.MTResearchSync）──
     上游改一段，下游衍生物 / 参考内容里还留着旧字句的地方先记进 research/sync.json，
     顶栏冒一颗「同步下游 · N」；勾选后逐项交给 subagent **原地改写**（不另存 v2），
     每项各记一条 changes.jsonl（撤销照样能一条条退）。这里只做「视图 ⇄ 模块」的薄适配。 */
  let rsSyncInst = null;
  let rsSyncQuiet = false;
  function rsSync() {
    if (!rsSyncInst && window.MTResearchSync) {
      rsSyncInst = window.MTResearchSync.create({
        el,
        t,
        state: () => RS,
        C: () => C(),
        joinP,
        api: () => window.api,
        toast: (msg, kind) => toastSafe(msg, kind),
        saveChange: (kind, rel, before, after) => rsSyncLog(kind, rel, before, after),
        /* 写入口的闸：同步下游要原地改写的那几篇，动盘前先过金色版本优先（research-sync.js 在
           派活之前逐篇问，被拒就整轮不派、不落任何文件） */
        gate: (rel) => rsWriteGate(rel),
        refresh: () => rsSyncRefresh(),
        repaint: () => {
          if (RS.ready) renderTop();
        },
        sessions: rsSessionApi(),
      });
    }
    return rsSyncInst;
  }
  /* 同步 chip 的旧入口已收进工具行的 toggle（renderTop → rsTogglePaint）；
     这里不再往外挂 chip —— 保留一个空实现只为老调用点不炸。 */
  function rsSyncChip() {}
  /* 保存路径上的一次「上游改动」：模块自己再防抖 700ms 后扫下游（自动保存 900ms 一次，
     每一笔都全量扫会把大盘拖慢，所以先攒起来一起扫）。 */
  function rsSyncAfterSave(kind, rel, before, after) {
    if (rsSyncQuiet) return;
    const S = rsSync();
    if (S) S.afterSave(kind, rel, before, after);
  }
  /* 同步写入的改动：**不走 logChange 的合并窗口** —— 合并按 path+kind 抓 5 秒内的连续保存，
     同一篇里两项同步会被并成一条，撤销就少退一步。这里一条一项，原样追加。 */
  async function rsSyncLog(kind, rel, before, after) {
    const was = rsSyncQuiet;
    rsSyncQuiet = true;
    try {
      await rsAppendChange(kind, rel, before, after);
    } finally {
      rsSyncQuiet = was;
    }
  }
  async function rsAppendChange(kind, relPath, before, after) {
    if (!RS.root) return;
    const lines = changeLines(await readText(joinP(RS.root, CHANGES)));
    const rec = {
      ts: Date.now(),
      kind,
      path: relPath,
      before: String(before == null ? "" : before),
      after: String(after == null ? "" : after),
    };
    if (RS.redoStack) RS.redoStack.length = 0;
    lines.push(JSON.stringify(rec));
    await writeChangeLines(lines);
  }
  /* 同步完一轮：盘上重读（衍生物可能变了）+ 树 + 图谱统计 + 顶栏，一起刷新 */
  async function rsSyncRefresh() {
    await rsLoadNotes();
    await rsLoadFolds();
    renderSide();
    renderTop();
    if (RS.graph) await rsRebuildGraph({ keepPositions: true, silent: true });
  }

  /* ── 顶栏面包屑：索引 › 原文 › 衍生物 › 章 › 节 ──
     前三级是「当前这一篇在知识库里的位置」，判读口径与左栏内容树一致：
     meta.corePath 是索引根，core/*.md 是原文，notes/ 里其余是衍生物；
     父子链读 frontmatter 的 parent / derivedFrom（research-core.js 的 readDeriveParents）。
     后两级是正文里的章与节 —— 章节表由 research-reader.js 统一解析（右侧大纲同源），
     这里只取「现在读到哪一节」，不重复解析 Markdown。 */
  const CRUMB_CSS_ID = "rsCrumbCss";
  function ensureCrumbCss() {
    if (document.getElementById(CRUMB_CSS_ID)) return;
    const st = document.createElement("style");
    st.id = CRUMB_CSS_ID;
    st.textContent = [
      /* 顶栏第一行左侧：占满余量（不再独占一整行 —— 顶栏现在只有这一行）。
         颜色一律走 --app-*（应用主题）：这一页可以换纸色，工具行不跟着换。 */
      ".rs-crumbs{flex:1 1 auto;display:flex;align-items:center;gap:2px;min-width:0;",
      "  font-size:12px;color:var(--app-muted);overflow:hidden;white-space:nowrap;}",
      ".rs-crumb{background:transparent;border:0;color:var(--app-muted);font-size:12px;",
      "  padding:1px 4px;border-radius:5px;cursor:pointer;max-width:280px;overflow:hidden;",
      "  text-overflow:ellipsis;white-space:nowrap;}",
      ".rs-crumb:hover{background:var(--app-panel2);color:var(--app-ink);}",
      ".rs-crumb.on{color:var(--app-ink);}",
      ".rs-crumb.cur{color:var(--app-cyan);}",
      ".rs-crumb:disabled{opacity:.55;cursor:default;}",
      ".rs-crumb:disabled:hover{background:transparent;color:var(--app-muted);}",
      ".rs-crumb-sep{color:var(--app-bd2);font-size:11px;padding:0 1px;}",
      ".rs-crumb-k{color:var(--app-muted);margin-right:3px;font-size:11px;}",
      ".rs-crumb-tail{display:inline-flex;align-items:center;gap:2px;min-width:0;}",
      /* ← 返回：沿导航路径后退一级（路径只有一级时禁用） */
      ".rs-crumb-back{font-size:13px;padding:0 6px;line-height:18px;}",
      ".rs-crumb-back:disabled{opacity:.4;}",
      /* 当前这一级是「现在读的这篇」：即使禁用也要吃青色，不能跟灰掉的占位同级 */
      ".rs-crumb.cur:disabled{color:var(--app-cyan);opacity:1;}",
      /* 兜底：工具条从 DOM 摘掉前的那一帧也不该占位（只有折叠文件才挂它） */
      ".rs-editor-wrap > .rs-toolbar.hide{display:none;}",
    ].join("\n");
    document.head.appendChild(st);
  }
  function crumbSep() {
    return el("span", "rs-crumb-sep", "›");
  }
  /* ── 导航路径：面包屑就是「你怎么走到这一篇的」──
     点术语定义 / `[[链接]]` 打开另一篇 = 往下压一层；点面包屑某一层回到那一层；
     左栏点树 / 新建 / 图谱跳转 = 从头开一条新路径（索引 › 目标）。
     路径只在内存里（RS.navTrail），换画布就清 —— 不进 research.json，也不写盘。 */
  function rsNavRel(rel) {
    return C().normRel(String(rel == null ? "" : rel));
  }
  function rsNavLabel(rel) {
    const key = rsNavRel(rel);
    const n = (RS.notes || []).find((x) => rsNavRel(x.path) === key);
    if (n) return String(n.title || key);
    const f = (RS.folds || []).find((x) => rsNavRel(x.path) === key);
    if (f) return String(f.title || key);
    const s = (RS.srcDocs || []).find((x) => rsNavRel(x.path) === key);
    if (s) return String(s.title || key);
    return key;
  }
  function rsNavPush(rel, mode) {
    const key = rsNavRel(rel);
    if (!key) return;
    const trail = Array.isArray(RS.navTrail) ? RS.navTrail : (RS.navTrail = []);
    const last = trail.length ? rsNavRel(trail[trail.length - 1].path) : "";
    if (mode === "back") return; /* 返回：栈已由 rsNavBack 截好，这一层不再压 */
    if (last === key && trail.length && (mode === "push" || mode == null)) return;
    if (mode === "jump") {
      const i = trail.map((x) => rsNavRel(x.path)).lastIndexOf(key);
      if (i >= 0) trail.length = i + 1;
      else RS.navTrail = [{ path: key, label: rsNavLabel(key) }];
      return;
    }
    if (mode === "push") {
      trail.push({ path: key, label: rsNavLabel(key), drill: true });
      return;
    }
    /* 默认：一条新路径 —— 索引根（有这一篇才带上）› 目标 */
    RS.navTrail = [];
    const rootPath = rsNavRel((RS.meta && RS.meta.corePath) || "notes/00-课题.md");
    if (rootPath && rootPath !== key && (RS.notes || []).some((n) => rsNavRel(n.path) === rootPath)) {
      RS.navTrail.push({ path: rootPath, label: rsNavLabel(rootPath) });
    }
    RS.navTrail.push({ path: key, label: rsNavLabel(key) });
  }
  async function rsNavGo(i) {
    const trail = RS.navTrail || [];
    const hit = trail[i];
    if (!hit) return;
    if (rsNavRel(hit.path) === rsNavRel(RS.curPath)) return;
    if (i < trail.length - 1) trail.length = i + 1;
    await rsOpenNote(hit.path, { trail: "jump" });
  }
  async function rsNavBack() {
    const trail = RS.navTrail || [];
    if (trail.length <= 1) return;
    trail.pop();
    const last = trail[trail.length - 1];
    if (last) await rsOpenNote(last.path, { trail: "back" });
  }
  /* ── 返回边距（阅读区最左那一竖条）──
     只在「展开」时出现：最后一层是从阅读器里点术语定义 / 双链压上去的（drill），
     且下面还有一层来源页。从树 / 新建 / 文献页点开的新路径不是展开，不出现。
     点整条 = rsNavBack（沿路径退一级，与面包屑的 ← 同一份实现）。
     文案取来源页标题，悬停由 CSS 把标签弹出来（ease-in-out）。 */
  function rsBackRail() {
    const btn = RS.backRailEl;
    if (!btn) return;
    const trail = RS.navTrail || [];
    const cur = trail[trail.length - 1];
    const prev = trail.length >= 2 ? trail[trail.length - 2] : null;
    if (!cur || !cur.drill || !prev) {
      btn.hidden = true;
      btn.innerHTML = "";
      return;
    }
    const label = String(prev.label || prev.path || "");
    btn.hidden = false;
    btn.title = t("返回上一页") + "：" + label + "（" + String(prev.path || "") + "）";
    btn.innerHTML =
      '<span class="rs-backrail-bar"></span>' +
      '<span class="rs-backrail-tip"><span class="rs-backrail-ico">←</span>' +
      '<span class="rs-backrail-t">' +
      esc(label) +
      "</span></span>";
  }
  /* 面包屑各级 = 导航路径各级（最后一级 = 现在这一篇，不再可点） */
  function rsCrumbLevels() {
    const trail = (RS.navTrail || []).slice();
    const cur = rsNavRel(RS.curPath || "");
    if (!trail.length && cur) trail.push({ path: cur, label: rsNavLabel(cur) });
    return trail.map((it, i) => ({
      label: it.label,
      title: it.path,
      cur: i === trail.length - 1,
      go: i === trail.length - 1 ? null : () => rsNavGo(i),
    }));
  }
  function rsCrumbsPaint() {
    const box = RS.crumbsEl;
    if (!box) return;
    box.innerHTML = "";
    const levels = rsCrumbLevels();
    const back = el("button", "rs-crumb rs-crumb-back", "←");
    back.type = "button";
    back.title = t("返回上一级（沿你点进来的路径后退）");
    back.disabled = levels.length <= 1;
    back.onclick = () => void rsNavBack();
    box.appendChild(back);
    levels.forEach((lv, i) => {
      if (i) box.appendChild(crumbSep());
      const b = el("button", "rs-crumb" + (lv.cur ? " cur" : ""));
      b.innerHTML = inlineHtml(lv.label);
      b.type = "button";
      b.title = lv.title || lv.label;
      if (lv.go) b.onclick = () => void lv.go();
      else b.disabled = true;
      box.appendChild(b);
    });
    RS.crumbsTailEl = el("span", "rs-crumb-tail");
    box.appendChild(RS.crumbsTailEl);
    rsCrumbsTail();
  }
  /* 章 / 节：滚动读到另一节时只重画这一段（整条重建会打断 hover 与焦点） */
  function rsCrumbsTail() {
    const box = RS.crumbsTailEl;
    if (!box) return;
    box.innerHTML = "";
    const R = rsReader();
    const info = R && typeof R.active === "function" ? R.active() : null;
    const parts = [];
    if (info && info.chapter) parts.push(info.chapter);
    if (info && info.part) parts.push(info.part);
    parts.forEach((p, i) => {
      box.appendChild(crumbSep());
      const b = el("button", "rs-crumb" + (i === parts.length - 1 ? " cur" : ""), "");
      b.type = "button";
      b.title = p.kind + " · " + p.text;
      b.appendChild(el("span", "rs-crumb-k", p.kind));
      const lab = el("span", "rs-crumb-label");
      if (p.html) lab.innerHTML = p.html;
      else lab.innerHTML = inlineHtml(p.text);
      b.appendChild(lab);
      b.onclick = () => {
        const RR = rsReader();
        if (RR && typeof RR.scrollToIndex === "function") RR.scrollToIndex(p.index);
      };
      box.appendChild(b);
    });
  }

  /* ── 图谱 ── */
  /* 转为图谱：笔记 + 它们的衍生物一起投影。
     衍生物写了自己的 parent，而 parent 可能不在 notes/ 与 core/ 里（被挪走 / 还没落过去）——
     盘上真有的就补读进来，读不到的交给内核记成缺口条目，**这里不抛错**：
     初始化后第一次「转为图谱」不能因为一条悬空 parent 就整个失败。 */
  async function buildFullGraph() {
    const docs = RS.notes.map((n) => ({
      path: n.path,
      parsed: C().parseNote({ path: n.path, md: n.md }),
    }));
    const seen = new Set(docs.map((d) => C().normRel(d.path)));
    const keep = new Set(seen);
    /* 衍生物可能落在 notes/ 的子目录里（notes/derived/…）：左栏笔记列表不摊平它们，
       但建图时一刀全收 —— 否则衍生物节点永远上不了图。目录不在就跳过，不报错。 */
    try {
      const top = await window.api.fileReadDir(joinP(RS.root, "notes"));
      for (const e of (top && top.entries) || []) {
        if (!e.isDir) continue;
        const sub = "notes/" + e.name;
        const r2 = await window.api.fileReadDir(joinP(RS.root, sub)).catch(() => null);
        for (const f of (r2 && r2.entries) || []) {
          if (f.isDir || !/\.md$/i.test(f.name)) continue;
          const key = C().normRel(sub + "/" + f.name);
          if (seen.has(key)) continue;
          try {
            const md = await readText(joinP(RS.root, key));
            docs.push({ path: key, parsed: C().parseNote({ path: key, md }) });
            seen.add(key);
            keep.add(key);
          } catch (_) {}
        }
      }
    } catch (_) {}
    for (const d of docs.slice()) {
      const parents = (d.parsed && d.parsed.note && d.parsed.note.parents) || [];
      for (const ref of parents) {
        const rel = C().normRel(String(ref || "")).replace(/^\/+/, "");
        if (!rel) continue;
        const cands = [rel];
        if (!/\.md$/i.test(rel)) cands.push(rel + ".md");
        for (const dir of ["notes/", "core/"]) {
          cands.push(dir + rel);
          if (!/\.md$/i.test(rel)) cands.push(dir + rel + ".md");
        }
        for (const c of cands) {
          const key = C().normRel(c);
          if (seen.has(key)) {
            keep.add(key);
            break;
          }
          let ok = false;
          try {
            ok = await exists(joinP(RS.root, key));
          } catch (_) {
            ok = false;
          }
          if (!ok) continue;
          try {
            const md = await readText(joinP(RS.root, key));
            docs.push({ path: key, parsed: C().parseNote({ path: key, md }) });
            seen.add(key);
            keep.add(key);
          } catch (_) {}
          break;
        }
      }
    }
    /* 删文件 / 删衍生物后的兜底：只留盘上还存在的路径，指向被删文件的边（含 derives）一并清掉 */
    return C().pruneGraph(C().buildGraph(docs, { library: RS.lib }), [...keep]);
  }
  async function rsRebuildGraph(opts) {
    const o = opts || {};
    const g = await buildFullGraph();
    RS.graph = g;
    try {
      await window.api.fileWriteText(
        joinP(RS.root, "graph.json"),
        JSON.stringify({ ver: g.ver, builtAt: g.builtAt, nodes: g.nodes, edges: g.edges }, null, 2),
      );
    } catch (_) {}
    if (RS.mode === "graph" && W()) {
      const gw = window.__rsGraphApi;
      if (gw) {
        if (o.keepPositions) gw.setGraphNoRelayout(g);
        else gw.setGraph(g, { layout: RS.layout });
      }
    }
    renderTop();
    if (!o.silent) {
      const s = C().stats(g);
      toastSafe(t("图谱已更新：") + s.nodes + t(" 个节点 / ") + s.edges + t(" 条关系"));
    }
  }
  async function rsBuildGraph(manual) {
    if (!RS.ready) return;
    await rsSaveCurrent();
    await rsLoadNotes();
    await rsRebuildGraph({});
    if (manual) {
      rsSetMode("graph");
      const g = RS.graph;
      const s = C().stats(g);
      if (s.nodes <= 1) toastSafe(t("笔记里还没有可成图的内容（写 [[链接]] 或 claim 块）"), "warn");
    }
  }
  function rsSetMode(mode) {
    RS.mode = mode;
    renderTop();
    if (mode === "graph") {
      if (RS.mainEl) RS.mainEl.classList.add("is-graph");
      if (RS.centerEl) RS.centerEl.classList.add("is-graph");
      if (RS.outlineEl) RS.outlineEl.classList.add("hide");
      RS.graphHost.classList.add("show");
      /* 左栏在应用侧栏里，图谱态照旧可见（内容树 / 资料两页与图谱互不影响） */
      try {
        if (!W()) throw new Error(t("图谱渲染模块没加载（app-research-graph.js）"));
        if (!window.__rsGraphApi) {
          window.__rsGraphApi = W().mount(RS.graphHost, {
            layout: RS.layout,
            onOpen: (n) => {
              if (!n.path) return;
              RS.mode = "notes";
              rsSetMode("notes");
              rsOpenNote(n.path, { line: n.line || 1 });
            },
            /* 文献节点（paper）的出口：本地有全文就先回笔记态再打开它；
               没有就走 rsOpenCite →「获取文献」（派 agent 检索 / 下载 / 入库）。 */
            onCite: (key) => {
              if (rsLitDocOf(key)) {
                RS.mode = "notes";
                rsSetMode("notes");
              }
              void rsOpenCite(key);
            },
            /* 图谱里换了选中节点 → 会话框那颗「当前焦点」跟着换 */
            onSelect: () => refreshChatFocus(),
            /* 右栏预览与正文同一套：整段 Markdown 走 renderMarkdown，
                再补阅读器那层记号装饰（`[[双链]]` / `[@引用]` / 软换行合并） */
            renderMd: (md) => renderMarkdown(md),
            decorate: (root) => rsGraphPreviewDecorate(root),
            /* 右栏预览要读整篇正文（图谱里笔记节点只带 120 字 excerpt）：
               直接从已装载的 RS.notes 取那一篇的 Markdown 正文，找不到就回空串。 */
            noteText: (p) => {
              const rel = String(p || "").trim();
              if (!rel) return "";
              const item = (RS.notes || []).find((x) => x && x.path === rel);
              if (!item) return "";
              return String((item.parsed && item.parsed.body) || item.md || "");
            },
          });
        }
        if (!window.__rsGraphApi) throw new Error(t("图谱容器挂载失败"));
        if (RS.graph) window.__rsGraphApi.setGraph(RS.graph, { layout: RS.layout });
        else rsRebuildGraph({});
        /* 图谱栏刚显示出来时宿主宽度才定（隐藏态 rect 为 0），下一帧再适配一次窗口，
           否则节点会停在上一次「窄栏」的缩放里，四周留白一大片。 */
        requestAnimationFrame(() =>
          requestAnimationFrame(() => window.__rsGraphApi && window.__rsGraphApi.fit && window.__rsGraphApi.fit()),
        );
      } catch (e) {
        toastSafe(t("图谱打开失败：") + String((e && e.message) || e), "err");
      }
    } else {
      RS.graphHost.classList.remove("show");
      if (RS.mainEl) RS.mainEl.classList.remove("is-graph");
      if (RS.centerEl) RS.centerEl.classList.remove("is-graph");
      if (RS.outlineEl) RS.outlineEl.classList.remove("hide");
      renderEditor();
    }
    /* 左栏「核心」页与顶栏图谱按钮的高亮跟着本轮模式走 */
    renderSide();
    rsPaintViewBtns();
  }

  /* ── 会话框：接入当前画布绑定的现有会话 ── */
  function boundSession() {
    try {
      const wid = String((curWf() || {}).id || "");
      const list = typeof agentSessions === "function" ? agentSessions() : [];
      const hit = list
        .filter((s) => String(s.canvasWfId || "") === wid && !s.archived)
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
      return hit || null;
    } catch (_) {
      return null;
    }
  }
  function ensureBoundSession() {
    const hit = boundSession();
    if (hit) {
      try {
        S.agentActiveId = hit.id;
        return hit;
      } catch (_) {}
    }
    try {
      S.agentActiveId = "";
      return typeof agentSessionState === "function" ? agentSessionState() : null;
    } catch (_) {
      return null;
    }
  }
  function msgText(m) {
    if (!m) return "";
    if (typeof m.content === "string" && m.content.trim()) return m.content;
    if (Array.isArray(m.segments)) {
      const say = m.segments.filter((s) => s && s.type === "say").map((s) => s.text || "");
      if (say.join("").trim()) return say.join("");
    }
    if (Array.isArray(m.content)) {
      return m.content.map((c) => (c && c.text) || "").join("");
    }
    return "";
  }
  /* ── 会话框收纳 ──
   * 下方 agent 页占着编辑区 42% 的高度，写东西时嫌挤。收纳后只留一条标题栏（会话名 + 当前焦点），
   * 编辑区 / 图谱独占剩余空间；状态写进 research.json（与纸色 / 字号同一套记忆口径）。 */
  function toggleChat() {
    RS.chatCollapsed = !RS.chatCollapsed;
    saveMetaPatch({
      ui: Object.assign({}, (RS.meta && RS.meta.ui) || {}, {
        chatCollapsed: !!RS.chatCollapsed,
      }),
    });
    renderChat();
  }

  /* ── 当前焦点（发送时随消息带给 agent，防止它改到别的笔记 / 文献 / 图谱）── */
  function graphSelection() {
    const gw = window.__rsGraphApi;
    if (!gw || typeof gw.selection !== "function") return null;
    try {
      return gw.selection();
    } catch (_) {
      return null;
    }
  }
  function lineOfIndex(md, idx) {
    if (idx < 0) return 0;
    return md.slice(0, idx).split(/\r?\n/).length;
  }
  /* 选中原文 + 行号：编辑态读 textarea 的选区，阅读态读 DOM 选区（折回 RS.md 求行号） */
  function focusSelection() {
    const ta = RS.srcEl;
    if (ta && document.body.contains(ta) && typeof ta.selectionStart === "number") {
      const v = String(ta.value || "");
      const a = ta.selectionStart;
      const b = ta.selectionEnd;
      return { text: b > a ? v.slice(a, b) : "", line: lineOfIndex(v, a) };
    }
    const sel = window.getSelection ? window.getSelection() : null;
    const text = sel ? String(sel.toString() || "").trim() : "";
    if (!text) return { text: "", line: 0 };
    const host = RS.selHost;
    if (host && sel.rangeCount && !host.contains(sel.getRangeAt(0).startContainer)) return { text: "", line: 0 };
    return { text, line: lineOfIndex(String(RS.md || ""), String(RS.md || "").indexOf(text)) };
  }
  function focusLabel() {
    if (RS.mode === "graph") {
      const g = graphSelection();
      return t("图谱") + (g ? " · " + g.label : "");
    }
    if (!RS.curPath) return t("未打开笔记");
    const n = RS.notes.find((x) => x.path === RS.curPath);
    if (n) return (n.title || RS.curPath) || RS.curPath;
    const sd = (RS.srcDocs || []).find((x) => x.path === RS.curPath);
    if (sd) return String(sd.title || RS.curPath);
    return RS.curPath;
  }
  /* 切笔记 / 切视图时只刷新标题栏那颗焦点标签 —— 不整体重绘会话框，正在打的草稿与光标都留着 */
  function refreshChatFocus() {
    const chip = RS.chatEl && RS.chatEl.querySelector(".rs-chat-focus");
    if (chip) chip.innerHTML = "◎ " + inlineHtml(focusLabel());
  }
  /* 拼一段「本轮只改这里」的抬头：内容全是发送那一刻的事实，随用户消息一起发出去。
   * 不做成隐藏系统提示 —— 用户得看得见 agent 被告知了什么，才敢让它动手改文件。 */
  function focusContext() {
    const lines = [t("研究根目录：") + (RS.root || "—")];
    const isFold = !!RS.foldPath && RS.foldPath === RS.curPath;
    if (RS.mode === "graph") {
      const g = graphSelection();
      lines.push(
        g
          ? t("视图：图谱；聚焦节点「") + g.label + "」" + (g.kind ? "（" + g.kind + "）" : "") + (g.path ? " · " + g.path : "")
          : t("视图：图谱；没有选中节点"),
      );
    } else if (isFold) {
      const lv = (C().FOLD_LEVELS || []).find((x) => x.n === RS.foldLevel);
      lines.push(
        t("视图：笔记；当前打开折叠文件「") +
          RS.curPath +
          "」，第 " +
          RS.foldLevel +
          t(" 层（") +
          ((lv && lv.label) || "") +
          t("）；只有第 1 层（全文）可写"),
      );
    } else if (RS.srcDocPath && RS.srcDocPath === RS.curPath) {
      lines.push(t("视图：笔记；当前打开文献正文「") + RS.curPath + t("」（参考资料的全文，不是笔记）"));
    } else {
      const n = RS.notes.find((x) => x.path === RS.curPath);
      lines.push(
        t("视图：笔记；当前打开「") +
          ((n ? n.title : "") || "—") +
          "」（" +
          (RS.curPath || t("未打开笔记")) +
          "）",
      );
    }
    const s = focusSelection();
    const clip = String(s.text || "").replace(/\s+/g, " ").trim().slice(0, 160);
    if (clip) lines.push(t("用户选中的原文（约第 ") + (s.line || "?") + t(" 行）：「") + clip + t("」"));
    else if (s.line) lines.push(t("光标在第 ") + s.line + t(" 行"));
    return (
      t("【当前聚焦（研究视图 · 发消息时自动附带）】") +
      "\n" +
      lines.join("\n") +
      "\n" +
      t("只改上面这一处；用户没明确点名时，不要动其它笔记、文献库与图谱。")
    );
  }

  function renderChat() {
    const host = RS.chatEl;
    if (!host) return;
    host.innerHTML = "";
    host.classList.toggle("collapsed", !!RS.chatCollapsed);
    const st = boundSession();
    const head = el("div", "rs-chat-head");
    if (RS.chatCollapsed) head.onclick = () => toggleChat();
    const fold = el("button", "rs-chat-fold", RS.chatCollapsed ? "▸" : "▾");
    fold.title = RS.chatCollapsed ? t("展开会话框") : t("收起会话框（只留标题栏，编辑区占满）");
    fold.onclick = (ev) => {
      if (ev) ev.stopPropagation();
      toggleChat();
    };
    head.appendChild(fold);
    const title = el("span", "rs-chat-title", t("会话 · 与当前画布共用上下文"));
    title.title = t("这里发的消息进入该画布绑定的会话（与「会话」视图同一条），回答会同步到那边");
    head.appendChild(title);
    const focus = el("span", "rs-chat-focus");
    focus.innerHTML = "◎ " + inlineHtml(focusLabel());
    focus.title = t("发送时会把这处焦点一并告诉 agent：只改这里，不动其它笔记 / 文献 / 图谱");
    head.appendChild(focus);
    const who = el("span", "rs-chat-who", st ? String(st.title || st.id).slice(0, 24) : t("还没有绑定会话，发送即新建"));
    head.appendChild(who);
    host.appendChild(head);
    if (RS.chatCollapsed) return;

    const list = el("div", "rs-chat-list");
    const msgs = (st && st.messages) || [];
    const tail = msgs.slice(-14);
    for (const m of tail) {
      const txt = msgText(m);
      if (!txt.trim()) continue;
      const row = el("div", "rs-msg " + (m.role === "user" ? "u" : "a"));
      row.appendChild(el("span", "rs-msg-role", m.role === "user" ? t("你") : "AI"));
      const b = el("div", "rs-msg-body");
      b.innerHTML = renderMarkdown(txt);
      rsJoinSoftBreaks(b);
      row.appendChild(b);
      list.appendChild(row);
    }
    if (!tail.length)
      list.appendChild(
        el("div", "rs-chat-empty", t("还没有对话。可以让 agent 解释这一段、找反例、把论断拆成子问题。")),
      );
    host.appendChild(list);
    list.scrollTop = list.scrollHeight;

    const box = el("div", "rs-chat-box");
    const ta = el("textarea", "rs-chat-input");
    ta.rows = 2;
    /* 草稿留在 RS 上：会话整页重绘、或把会话框收起来，已经打了一半的话不能没 */
    ta.value = RS.chatDraft || "";
    ta.addEventListener("input", () => {
      RS.chatDraft = ta.value;
    });
    ta.placeholder = t("对 agent 说：帮我核实这条论断 / 把这段文献入库 / 补三条反例…");
    const send = el("button", "rs-chat-send", "↑");
    send.title = t("发送");
    box.appendChild(ta);
    box.appendChild(send);
    host.appendChild(box);
    const doSend = () => {
      const raw = String(ta.value || "").trim();
      if (!raw) return;
      const sess = ensureBoundSession();
      if (!sess) return toastSafe(t("会话不可用"), "err");
      ta.value = "";
      RS.chatDraft = "";
      /* 焦点必须在清空输入框之前取：它描述的是「发送那一刻用户在做什么」 */
      let msg = raw;
      try {
        msg = focusContext() + "\n\n" + raw;
      } catch (_) {}
      try {
        if (typeof agentSessionSend === "function")
          agentSessionSend(msg, { sessionId: sess.id });
        else toastSafe(t("会话发送入口不可用"), "err");
      } catch (e) {
        toastSafe(String((e && e.message) || e), "err");
      }
      setTimeout(renderChat, 300);
    };
    send.onclick = doSend;
    ta.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && !ev.shiftKey) {
        ev.preventDefault();
        doSend();
      }
    });
  }

  /* 会话整页重绘时同步一份到研究视图（不改原渲染，只加一层镜像） */
  function hookAgentRender() {
    if (typeof window.renderAgentSession !== "function" || window.renderAgentSession.__rsHooked) return;
    const orig = window.renderAgentSession;
    const wrapped = function () {
      const r = orig.apply(this, arguments);
      try {
        if (RS.mode === "notes" && qid("researchPane") && qid("researchPane").style.display !== "none")
          renderChat();
      } catch (_) {}
      return r;
    };
    wrapped.__rsHooked = true;
    try {
      window.renderAgentSession = wrapped;
      /* app-boot 里的调用是同作用域的函数名，改 window 上的同名属性不会影响它；
         故再补一条事件通道：会话侧每次重绘都会触发下面这个自定义事件（见 app-boot 的接线）。 */
    } catch (_) {}
  }

  /* ── 左栏「资料」页 = 文献库 + 折叠参考资料 ──
   * 原来顶栏那颗「文献」开的是一个持久浮层；现在整套能力（＋添加内容 / 插入引用 / 折叠 /
   * ↗ / 移除）就画在应用左栏的 #sideRefs 里，与「文件」「核心」两页并列成 Tabs ——
   * 研究视图不再有自己的内部左栏。
   * 投料入口收成一颗「＋ 添加内容」：拖文件 / 填网址 / 写 agent 指示都在同一只对话框里累加，
   * 确认后一次性入队执行（见 rsAddContent）。 */
  function renderLit() {
    const host = qid("sideRefs");
    if (!host) return;
    const pane = qid("researchPane");
    if (!pane || pane.style.display === "none") return;
    host.innerHTML = "";
    bindPanelDrop(host, "ref");
    /* 搜索行（与「核心」页同一个位置：最上面）：按题名 / 作者 / 引用键筛文献与折叠。
       只切行显隐（不重画整页），打字时光标不跳。 */
    let applySearch = () => {};
    host.appendChild(rsSideSearch("refs", () => applySearch()));
    const hay = (s) => String(s == null ? "" : s).toLowerCase();
    const rows = []; // { node, hay, kind: "lit" | "fold" }
    const tools = el("div", "rs-side-tools");
    /* 投料入口：拖文件 / 填网址 / 写 agent 指示，确认后一起执行（原「＋添加资料」那排按钮收成一颗） */
    const btnAdd = el("button", "rs-btn", "＋ " + t("添加内容"));
    btnAdd.title = t("拖入文件 / 填网址 / 写 agent 指示，确认后一起执行");
    btnAdd.onclick = () => rsAddContent();
    tools.appendChild(btnAdd);
    host.appendChild(tools);

    const list = el("div", "rs-lit-list");
    const litRels = initDoneRels();
    let litEmpty = null;
    if (!RS.lib.length) {
      litEmpty = el("div", "rs-lit-empty", t("文献库是空的。导入 BibTeX 或按 DOI / 标题检索后加入。"));
      list.appendChild(litEmpty);
    }
    for (const it of RS.lib) {
      const row = el("div", "rs-lit-item");
      const key = it.citeKey || C().citeKeyOf(it);
      const title = C().itemTitle(it) || t("（无标题）");
      const sub = C().citeText(it) + " · " + key + (it.DOI ? " · " + it.DOI : "");
      rows.push({ node: row, hay: hay(title + " " + sub), kind: "lit" });
      const head = el("div", "rs-lit-head");
      const titleEl = el("div", "rs-lit-title");
      titleEl.innerHTML = inlineHtml(title);
      head.appendChild(titleEl);
      if (litInitDone(it, litRels)) head.appendChild(initDoneBadge());
      row.appendChild(head);
      row.appendChild(el("div", "rs-lit-sub", sub));
      const acts = el("div", "rs-lit-acts");
      /* 这篇在本地有没有正文（literature/sources 或 literature/pdf）：有就「正文」直接打开，
         没有就「获取文献」派 agent 去取 —— 文献行与正文里的 [@key] 是同一个出口。 */
      const doc = rsLitDocOf(key);
      const docBtn = el("button", "rs-tool", doc ? t("正文") : t("获取文献"));
      docBtn.title = doc ? t("打开这篇的正文：") + doc.path : t("本地还没有全文：让 agent 联网检索并下载这一篇");
      docBtn.onclick = () => void rsOpenCite(key);
      acts.appendChild(docBtn);
      if (doc) {
        titleEl.classList.add("is-link");
        titleEl.title = t("打开这篇的正文：") + doc.path;
        titleEl.onclick = () => void rsOpenLitDoc(doc);
      } else {
        titleEl.classList.add("is-link");
        titleEl.title = t("本地还没有全文：点它获取这一篇");
        titleEl.onclick = () => void rsOpenCite(key);
      }
      const copy = el("button", "rs-tool", t("插入引用"));
      copy.title = t("在正文光标处插入 Pandoc 式引用 [@key]");
      copy.onclick = () => {
        /* 参考文献就在左栏，不再挡正文：插完把视图切回笔记，让用户直接看到写进去的位置 */
        rsInsertText(" [@" + key + "] ");
        if (RS.mode !== "notes") rsSetMode("notes");
      };
      acts.appendChild(copy);
      /* 三层折叠：这篇有 folds/<key>.md 就直接开（没有就让 agent 生成） */
      const foldBtn = el("button", "rs-tool", t("折叠"));
      foldBtn.title = t("打开这篇的折叠视图（1 全文 / 2 关键原句 / 3 主题）");
      foldBtn.onclick = () => {
        const hit = (RS.folds || []).find((f) => f.key === key || f.path.endsWith("/" + key + ".md"));
        if (!hit) {
          toastSafe(t("这篇还没有折叠：让 agent 按技能生成 literature/folds/") + key + ".md", "warn");
          return;
        }
        rsOpenFold(hit.path);
      };
      acts.appendChild(foldBtn);
      if (it.URL || it.DOI) {
        const open = el("button", "rs-tool", "↗");
        open.title = t("用系统浏览器打开");
        open.onclick = () => {
          try {
            window.api.openExternal(it.URL || "https://doi.org/" + it.DOI);
          } catch (_) {}
        };
        acts.appendChild(open);
      }
      const del = el("button", "rs-tool", "✕");
      del.title = t("从文献库移除（不删 PDF 全文）");
      del.onclick = async () => {
        await rsSaveLibrary(
          RS.lib.filter((x) => (x.citeKey || x.id) !== key),
          t("移除文献"),
        );
        renderLit();
        if (RS.graph) rsRebuildGraph({ keepPositions: true, silent: true });
      };
      acts.appendChild(del);
      row.appendChild(acts);
      list.appendChild(row);
    }
    host.appendChild(list);
    /* 折叠（参考资料）：literature/folds/ 下的三层投影（与内容树里那一组同源 RS.folds） */
    let foldsHead = null;
    if ((RS.folds || []).length) {
      foldsHead = el("div", "rs-side-head", t("折叠（参考资料）"));
      host.appendChild(foldsHead);
      const folds = el("div", "rs-lit-list");
      for (const f of RS.folds) {
        const row = el("div", "rs-lit-item");
        rows.push({ node: row, hay: hay(String(f.title || "") + " " + String(f.key || "") + " " + f.path), kind: "fold" });
        row.appendChild(el("div", "rs-lit-title")).innerHTML = inlineHtml(String(f.title || f.key || f.path));
        const acts = el("div", "rs-lit-acts");
        const open = el("button", "rs-tool", t("打开"));
        open.title = f.path;
        open.onclick = () => rsOpenFold(f.path);
        acts.appendChild(open);
        row.appendChild(acts);
        folds.appendChild(row);
      }
      host.appendChild(folds);
    }
    /* 筛完一条不剩时给一句话（只在有关键词时出现） */
    const noneLine = el("div", "rs-lit-empty", t("没有匹配的条目（清掉搜索再看看）"));
    noneLine.style.display = "none";
    list.appendChild(noneLine);
    applySearch = () => {
      const kw = String((RS.sideFilter && RS.sideFilter.refs) || "").trim().toLowerCase();
      let litN = 0;
      let foldN = 0;
      for (const r of rows) {
        const on = !kw || r.hay.indexOf(kw) >= 0;
        r.node.style.display = on ? "" : "none";
        if (on) {
          if (r.kind === "fold") foldN++;
          else litN++;
        }
      }
      if (litEmpty) litEmpty.style.display = kw ? "none" : "";
      if (foldsHead) foldsHead.style.display = kw && !foldN ? "none" : "";
      noneLine.style.display = kw && !litN && !foldN ? "" : "none";
    };
    applySearch();
  }
  /* ── 「＋ 添加内容」：拖文件 / 填网址 / 写 agent 指示，收进同一只对话框 ──
   * 壳沿用 .rs-ask（fixed 挂 body、面板内滚动、persistent —— 只有窗内 ✕ / 取消 / Esc 能关，
   * 点外面一概不关）。内容三段：
   *   ① 拖放区 + 「选择文件…」：拖进来走 MTResearchInit.pathsFromDrop（与投料台同一条通道，
   *      见 dropIntoPanel），选择走 api.fileOpenDialog({multi:true})；两处都能多次追加，
   *      列表里显示文件名与大小，可 ✕ 删；
   *   ② 网址行：一个输入框 + 「加入」（回车也加入），一次可以贴多行 —— 每行交
   *      MTResearchCore.initClassifyLine 认 url / DOI / arXiv / 检索式，认不出就当文字条目；
   *   ③ 「给 agent 的指示」textarea：一段自然语言，可为空。
   * 每条条目自己带一个「核心文件 / 参考资料」的小 select（默认参考资料，这是「资料」页的语义）。
   * 底部「已添加 N 项」+「取消」+「确认执行（N 项）」；确认时收集
   * {files:[{path,role}], rows:[{source,value,role,title}], instruction} 交给投料台，然后关窗。 */
  const RS_ADD_ID = "rsAdd";
  /* 角色 / 来源的文案（投料台内部用的是 core / ref、url / query / text 这些短码） */
  const RS_ADD_ROLES = { core: "核心文件", ref: "参考资料" };
  const RS_ADD_SOURCES = { url: "网页", query: "检索式", text: "文字" };
  let rsAddEsc = null;
  function rsAddClose() {
    if (rsAddEsc) document.removeEventListener("keydown", rsAddEsc, true);
    rsAddEsc = null;
    const old = qid(RS_ADD_ID);
    if (old) old.remove();
  }
  function rsAddBaseName(p) {
    const s = String(p == null ? "" : p).replace(/[\\/]+$/, "");
    const i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
    return i < 0 ? s : s.slice(i + 1);
  }
  function rsAddSize(n) {
    const v = Number(n) || 0;
    if (v >= 1024 * 1024) return (v / 1024 / 1024).toFixed(1) + " MB";
    if (v >= 1024) return Math.round(v / 1024) + " KB";
    return v ? v + " B" : "";
  }
  /* 一条文字 / 链接的默认标题：与投料台 addRows 用的是同一份规则，列表里先给人看一眼 */
  function rsAddTitleOf(source, value) {
    const C0 = window.MTResearchCore;
    if (!C0 || typeof C0.initEntryTitle !== "function") return "";
    const key = { source };
    if (source === "url") key.url = value;
    else if (source === "query") key.query = value;
    else key.text = value;
    try {
      return String(C0.initEntryTitle(key) || "");
    } catch (_) {
      return "";
    }
  }
  function rsAddPushFile(st, path, role) {
    const p = String(path == null ? "" : path).trim();
    if (!p) return false;
    if (st.files.some((f) => f.path === p)) return false;
    st.files.push({ path: p, role: role === "core" ? "core" : "ref", size: 0 });
    return true;
  }
  function rsAddPushRow(st, source, value, role, title) {
    const v = String(value == null ? "" : value).trim();
    if (!v) return false;
    const s = source === "url" || source === "query" ? source : "text";
    if (st.rows.some((r) => r.source === s && r.value === v)) return false;
    st.rows.push({
      source: s,
      value: v,
      role: role === "core" ? "core" : "ref",
      title: String(title || "").trim() || rsAddTitleOf(s, v),
    });
    return true;
  }
  /* 补一次文件体积（列表里显示大小，用户能看出是不是选错了） */
  async function rsAddFillSizes(st, refresh) {
    let dirty = false;
    for (const f of st.files) {
      if (f.size) continue;
      const r = await window.api.fileStat(f.path).catch(() => null);
      if (r && r.ok) {
        f.size = Number(r.size) || 0;
        dirty = true;
      }
    }
    if (dirty && typeof refresh === "function") refresh();
  }
  async function rsAddPick(st, refresh) {
    try {
      const r = await window.api.fileOpenDialog({
        title: t("选择要添加的文件"),
        multi: true,
        defaultPath: wsDir() || "",
      });
      const list = (r && (r.paths || (r.path ? [r.path] : []))) || [];
      let added = 0;
      for (const p of list) if (rsAddPushFile(st, p, "ref")) added++;
      if (!added) return;
      refresh();
      await rsAddFillSizes(st, refresh);
    } catch (e) {
      toastSafe(t("选择文件失败：") + String((e && e.message) || e), "err");
    }
  }
  /* 确认后这一批的去处：投料台（renderer/app-research-init.js 那只整画布投料台）。
     先把它打开（openInitWizard 按 research.json 在不在自动选首次 / 增量，并清掉上一批的列表），
     再把条目按角色灌进它的两栏：文件走 addFiles（由它复制进 research/），网址 / 检索式 / 文字
     走 addRows；「给 agent 的指示」挂到这批条目的 note 上 —— 投料台会把它写进正文骨架的
     「用户交代」一节。 */
  async function rsAddHandoff(bundle) {
    const I = window.MTResearchInit;
    if (!I) {
      toastSafe(t("初始化模块没加载：请重启应用"), "err");
      return false;
    }
    try {
      await openInitWizard(true);
      const note = String((bundle && bundle.instruction) || "").trim();
      const files = (bundle && bundle.files) || [];
      for (const role of ["core", "ref"]) {
        const paths = files.filter((f) => f.role === role).map((f) => f.path);
        if (!paths.length) continue;
        I.addFiles(role, paths);
        if (!note) continue;
        const list = (I.state && (role === "core" ? I.state.core : I.state.refs)) || [];
        for (const e of list) {
          if (e && e.source === "file" && !e.note && paths.indexOf(e.src) >= 0) e.note = note;
        }
      }
      const rows = (bundle && bundle.rows) || [];
      if (rows.length) {
        I.addRows(
          "ref",
          rows.map((r) => ({ source: r.source, value: r.value, role: r.role, title: r.title, note })),
        );
      }
      if (typeof I.render === "function") I.render();
      toastSafe(t("已交给资料库：") + (files.length + rows.length) + t(" 项"));
      return true;
    } catch (e) {
      toastSafe(t("交给资料库失败：") + String((e && e.message) || e), "err");
      return false;
    }
  }
  /* prefill 可选：{files:[{path,role}], rows:[{source,value,role,title}], instruction}，
     或直接一段字符串（当「给 agent 的指示」）。 */
  function rsAddContent(prefill) {
    /* 没有工作目录就没有 research/ 可投：与 openInitWizard 同一条提示 */
    if (!wsDir()) {
      toastSafe(t("请先在画布顶栏设置工作目录"), "warn");
      return;
    }
    const C0 = window.MTResearchCore;
    if (!C0 || typeof C0.initClassifyLine !== "function") {
      toastSafe(t("研究内核没加载：请重启应用"), "err");
      return;
    }
    const st = { files: [], rows: [], instruction: "" };
    if (typeof prefill === "string") st.instruction = prefill;
    else if (prefill && typeof prefill === "object") {
      for (const f of Array.isArray(prefill.files) ? prefill.files : []) {
        const path = String(typeof f === "string" ? f : (f && (f.path || f.src)) || "").trim();
        if (path) rsAddPushFile(st, path, f && f.role);
      }
      for (const r of Array.isArray(prefill.rows) ? prefill.rows : []) {
        if (typeof r === "string") {
          const c = C0.initClassifyLine(r, "auto");
          if (c) rsAddPushRow(st, c.source, c.value, "ref", "");
          continue;
        }
        if (r) rsAddPushRow(st, r.source, r.value != null ? r.value : r.text, r.role, r.title);
      }
      if (prefill.instruction != null) st.instruction = String(prefill.instruction || "");
    }
    rsAddClose();
    if (typeof closeNodePopsExcept === "function") closeNodePopsExcept("");

    const box = el("div", "rs-ask rs-add");
    box.id = RS_ADD_ID;
    const pn = pane();
    if (pn && pn.classList.contains("rs-light")) box.classList.add("rs-light");

    const head = el("div", "rs-ask-head");
    head.appendChild(el("b", "", t("添加内容")));
    const x = el("button", "rs-ask-x", "✕");
    x.title = t("关闭");
    x.onclick = () => rsAddClose();
    head.appendChild(x);
    box.appendChild(head);

    /* 内容三段放在自己会滚的那一层里：底部「已添加 N 项」常驻 */
    const body = el("div", "rs-add-body");
    box.appendChild(body);

    /* ① 文件：拖放区 + 选择文件… */
    const secFiles = el("div", "rs-add-sec");
    secFiles.appendChild(el("div", "rs-add-label", t("文件（拖进来，或点「选择文件…」；可多次追加）")));
    const drop = el("div", "rs-add-drop");
    drop.appendChild(el("span", "", t("把文件拖到这里")));
    const pick = el("button", "rs-btn", t("选择文件…"));
    drop.appendChild(pick);
    secFiles.appendChild(drop);
    const fileList = el("div", "rs-add-list");
    secFiles.appendChild(fileList);
    body.appendChild(secFiles);

    /* ② 网址行：用 textarea 而不是 input —— 多行粘贴在 input 里会被浏览器吞掉换行 */
    const secRows = el("div", "rs-add-sec");
    secRows.appendChild(el("div", "rs-add-label", t("链接 / DOI / arXiv / 检索式（一行一条，可一次贴多行）")));
    const lineRow = el("div", "rs-ask-row");
    const lineIn = el("textarea", "rs-ask-input rs-add-line");
    lineIn.rows = 2;
    lineIn.placeholder = t("粘贴链接 / DOI / arXiv 编号 / 检索式，回车加入（Shift+回车换行）");
    const addBtn = el("button", "rs-btn", t("加入"));
    lineRow.appendChild(lineIn);
    lineRow.appendChild(addBtn);
    secRows.appendChild(lineRow);
    const rowList = el("div", "rs-add-list");
    secRows.appendChild(rowList);
    body.appendChild(secRows);

    /* ③ 给 agent 的指示：一段自然语言，可为空 */
    const secIns = el("div", "rs-add-sec");
    secIns.appendChild(el("div", "rs-add-label", t("给 agent 的指示（可为空）")));
    const insTa = el("textarea", "rs-ask-input");
    insTa.rows = 3;
    insTa.placeholder = t("例如：只收实证部分；重点看第 4 节；几篇结论冲突的地方列个表");
    insTa.value = st.instruction;
    insTa.oninput = () => {
      st.instruction = insTa.value;
    };
    secIns.appendChild(insTa);
    body.appendChild(secIns);

    /* 底部：已添加 N 项 + 取消 + 确认执行（N 项） */
    const foot = el("div", "rs-ask-row rs-add-foot");
    const count = el("span", "rs-add-count", "");
    foot.appendChild(count);
    const cancel = el("button", "rs-btn", t("取消"));
    cancel.onclick = () => rsAddClose();
    foot.appendChild(cancel);
    const okBtn = el("button", "rs-btn primary", "");
    foot.appendChild(okBtn);
    box.appendChild(foot);

    /* 每条条目一个「核心文件 / 参考资料」小 select（默认参考资料） */
    const roleSelOf = (item) => {
      const sel = el("select", "rs-add-role");
      for (const v of ["ref", "core"]) {
        const o = el("option", null, t(RS_ADD_ROLES[v]));
        o.value = v;
        if ((item.role || "ref") === v) o.selected = true;
        sel.appendChild(o);
      }
      sel.onchange = () => {
        item.role = sel.value === "core" ? "core" : "ref";
      };
      return sel;
    };
    const refresh = () => {
      const n = st.files.length + st.rows.length;
      /* 整句带 {n} 一次翻完：别拆成「已添加 」+「 项」两段 —— 「 项」在别处另有一条
         英文是 " failed"（重试那条），英文界面会翻串 */
      count.textContent = t("已添加 {n} 项").replace("{n}", n);
      okBtn.textContent = t("确认执行（{n} 项）").replace("{n}", n);
      fileList.innerHTML = "";
      for (const f of st.files.slice()) {
        const row = el("div", "rs-add-item");
        const nm = el("span", "rs-add-name", rsAddBaseName(f.path));
        nm.title = f.path;
        row.appendChild(nm);
        row.appendChild(el("span", "rs-add-meta", rsAddSize(f.size)));
        row.appendChild(roleSelOf(f));
        const del = el("button", "rs-tool", "✕");
        del.title = t("这条不要了");
        del.onclick = () => {
          const i = st.files.indexOf(f);
          if (i >= 0) st.files.splice(i, 1);
          refresh();
        };
        row.appendChild(del);
        fileList.appendChild(row);
      }
      rowList.innerHTML = "";
      for (const r of st.rows.slice()) {
        const row = el("div", "rs-add-item");
        const nm = el("span", "rs-add-name", r.title || r.value);
        nm.title = r.value;
        row.appendChild(nm);
        row.appendChild(el("span", "rs-add-meta", t(RS_ADD_SOURCES[r.source] || "文字")));
        row.appendChild(roleSelOf(r));
        const del = el("button", "rs-tool", "✕");
        del.title = t("这条不要了");
        del.onclick = () => {
          const i = st.rows.indexOf(r);
          if (i >= 0) st.rows.splice(i, 1);
          refresh();
        };
        row.appendChild(del);
        rowList.appendChild(row);
      }
    };
    /* 网址行 → 条目：一行一条，认不出就当文字条目（initClassifyLine 自己会退成 text） */
    const addLines = () => {
      const raw = String(lineIn.value || "");
      let n = 0;
      for (const line of raw.replace(/\r/g, "").split(/\n+/)) {
        const s = line.trim();
        if (!s) continue;
        const c = C0.initClassifyLine(s, "auto");
        if (!c) continue;
        if (rsAddPushRow(st, c.source, c.value, "ref", "")) n++;
      }
      if (!n) {
        if (raw.trim()) toastSafe(t("这几行都在列表里了"), "warn");
        return;
      }
      lineIn.value = "";
      refresh();
      lineIn.focus();
    };
    addBtn.onclick = () => addLines();
    lineIn.addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter" || ev.shiftKey) return;
      ev.preventDefault();
      addLines();
    });

    /* 拖放：与投料台自己的拖拽同一条通道（MTResearchInit.pathsFromDrop） */
    drop.addEventListener("dragover", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      drop.classList.add("on");
    });
    drop.addEventListener("dragleave", () => drop.classList.remove("on"));
    drop.addEventListener("drop", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      drop.classList.remove("on");
      const ini = window.MTResearchInit;
      const paths = ini && typeof ini.pathsFromDrop === "function" ? ini.pathsFromDrop(ev.dataTransfer) : [];
      let added = 0;
      for (const p of paths) if (rsAddPushFile(st, p, "ref")) added++;
      if (!added) return;
      refresh();
      void rsAddFillSizes(st, refresh);
    });
    pick.onclick = () => void rsAddPick(st, refresh);

    okBtn.onclick = async () => {
      const bundle = {
        files: st.files.map((f) => ({ path: f.path, role: f.role })),
        rows: st.rows.map((r) => ({ source: r.source, value: r.value, role: r.role, title: r.title })),
        instruction: String(st.instruction || "").trim(),
      };
      if (!bundle.files.length && !bundle.rows.length) {
        toastSafe(t("先加点什么：拖文件 / 填网址 / 写指示"), "warn");
        return;
      }
      okBtn.disabled = true;
      const done = await rsAddHandoff(bundle);
      okBtn.disabled = false;
      if (done) rsAddClose();
    };

    document.body.appendChild(box);
    box.style.left = Math.max(12, Math.round((window.innerWidth - (box.offsetWidth || 560)) / 2)) + "px";
    box.style.top = Math.max(12, Math.round(window.innerHeight * 0.1)) + "px";
    rsAddEsc = (ev) => {
      if (ev.key !== "Escape") return;
      ev.stopPropagation();
      rsAddClose();
    };
    document.addEventListener("keydown", rsAddEsc, true);
    refresh();
    /* 预填进来的路径（左栏拖放那条入口）补一次体积，列表里能看出是什么文件 */
    if (st.files.length) void rsAddFillSizes(st, refresh);
    lineIn.focus();
  }

  async function addToLib(items, source) {
    const next = RS.lib.slice();
    let added = 0;
    for (const it of items || []) {
      if (!it) continue;
      const key = C().citeKeyOf(it);
      if (next.some((x) => (x.citeKey || C().citeKeyOf(x)) === key)) continue;
      it.citeKey = key;
      if (!it.id) it.id = key;
      next.push(it);
      added++;
    }
    C().assignCiteKeys(next);
    await rsSaveLibrary(next, t("导入文献（") + source + "）");
    RS.lib = next;
    renderLit();
    if (RS.graph) rsRebuildGraph({ keepPositions: true, silent: true });
    toastSafe(t("已加入文献库：") + added);
  }
  /* ── 初始化投料台（整画布分区 + 队列点火全在 renderer/app-research-init.js）── */
  async function saveMetaPatch(patch) {
    if (!RS.root) return false;
    const next = Object.assign({}, RS.meta || {}, patch || {});
    RS.meta = next;
    if (patch && patch.initSplit != null) RS.split = Number(patch.initSplit) || RS.split;
    try {
      await window.api.fileWriteText(
        joinP(RS.root, "research.json"),
        JSON.stringify(next, null, 2) + "\n",
      );
      return true;
    } catch (_) {
      return false;
    }
  }
  async function openInitWizard(existing) {
    const I = window.MTResearchInit;
    if (!I) return toastSafe(t("初始化模块没加载：请重启应用"), "err");
    if (!wsDir()) {
      toastSafe(t("请先在画布顶栏设置工作目录"), "warn");
      return;
    }
    RS.gate.classList.remove("show");
    RS.gate.innerHTML = "";
    try {
      await I.open({
        existing: !!existing,
        ws: wsDir(),
        root: rootOf(),
        wfId: String((curWf() || {}).id || ""),
        wfName: String((curWf() || {}).name || ""),
        topic: (RS.meta && RS.meta.title) || "",
        question: (RS.meta && RS.meta.question) || "",
        /* 读者水平跟着 research.json 走（老库没有这个字段 → null，投料台自己回到「不限」） */
        knowledge: (RS.meta && RS.meta.knowledge) || null,
        split: RS.split,
        saveMeta: saveMetaPatch,
        onDone: async () => {
          await rsReloadAll();
          renderTop();
        },
        onGraph: () => rsBuildGraph(true),
        onIndex: async () => {
          await rsShowIndexPage();
        },
      });
    } catch (e) {
      toastSafe(String((e && e.message) || e), "err");
    }
  }

  /* 收掉投料台，并把按「上一张画布」攒下的状态清干净。
     只藏界面不够：MTResearchInit.open() 只在 topic / question 为空时才重取，留着旧值就会把
     上一张画布的课题名串到新画布；核心 / 参考列表与队列同理（队列的真源在盘上，清的是内存里
     那份快照，换画布后由 open() 重新读新目录）。 */
  function rsDropInitWizard() {
    const I = window.MTResearchInit;
    if (!I) return;
    const st = I.state && typeof I.state === "object" ? I.state : null;
    if (!(st && st.open)) return;
    try {
      if (typeof I.close === "function") I.close();
    } catch (_) {}
    /* 正在跑的那一轮（busy）别动这两栏：startInit 会接着按它们复制 / 入队，清掉就等于把用户
       刚投的料丢了。那一轮跑完自己会收工（runSeq 已失效），列表它自己会清。 */
    if (!st.busy) {
      st.core = [];
      st.refs = [];
      st.instruction = "";
      st.composer = null;
      st.preview = null;
      st.editing = "";
    }
    st.topic = "";
    st.question = "";
    st.queue = null;
    st.existing = false;
    st.err = "";
  }

  /* 清掉「上一张画布的研究」——内存与界面都要清。
     只清内存不够：闸门是半透明盖在视图上的，底下的顶栏 / 编辑区 / 图谱还是上一次画的，
     于是「在未初始化的画布点研究」会看到别的画布的正文（用户报的 bug）。 */
  function rsResetLoaded() {
    RS.ready = false;
    RS.meta = null;
    RS.notes = [];
    RS.originals = [];
    RS.folds = [];
    RS.foldPath = "";
    RS.srcDocs = [];
    RS.srcDocPath = "";
    RS.curPath = "";
    /* 多选是「这一份研究里的哪几篇」：换画布 / 回闸门必须清掉，别把别处的路径带过去 */
    RS.multiSel = [];
    RS.multiAnchor = "";
    RS.md = "";
    RS.graph = null;
    RS.lib = [];
    RS.dirty = false;
    RS.split = 0.5;
    /* 就地编辑面跟着这一份研究一起作废：指针与 debounce 都清掉，底栏收起 */
    RS.inlineOn = false;
    RS.inlineEl = null;
    clearTimeout(inlineTimer);
    inlinePending = null;
    if (RS.inlineBarEl) RS.inlineBarEl.hidden = true;
    /* 批注也是「这一份研究」的：内存里的那份映射、选段快照、浮层与叠层一起清掉 */
    RS.annoMap = {};
    RS.annoCollapsed = null;
    RS.annoSnap = null;
    RS_ANNO.hits = [];
    if (RS.annoFloatEl) {
      RS.annoFloatEl.hidden = true;
      RS.annoFloatEl.innerHTML = "";
    }
    rsAnnoPaintClear(null);
    /* 字号 / 纸色是「这一份研究」的偏好：换画布先回落成默认字号与默认纸色
       （随后的 rsLoad 会按新画布 research.json 的 ui 覆盖回来） */
    RS.fs = 16;
    RS.bg = RS_BG_DEF;
    applyViewSkin();
    /* 换画布 / 回闸门：候选面板是上一份研究的正文生成的，一并收掉 */
    rsMissClose();
    /* 查找条同理：它搜的是上一份研究的正文，换画布后收起并清掉高亮 */
    rsFindClose();
    /* 重做栈只在同一份研究目录里有效：换画布 / 回闸门就作废，免得把别处的内容重做回来 */
    RS.redoStack = [];
    /* 导航路径同理：上一份研究里的笔记路径在另一份里点不到 */
    RS.navTrail = [];
    if (RS.backRailEl) {
      RS.backRailEl.hidden = true;
      RS.backRailEl.innerHTML = "";
    }
  }
  function rsClearPane() {
    rsResetLoaded();
    /* 草稿只在换画布 / 回闸门时清（同目录刷新不该吃掉打了一半的话） */
    RS.chatDraft = "";
    RS.wfId = String((curWf() || {}).id || "");
    RS.root = rootOf();
    if (RS.graphHost) {
      try {
        if (W() && typeof W().destroy === "function") W().destroy();
      } catch (_) {}
      window.__rsGraphApi = null;
      RS.graphHost.classList.remove("show");
      RS.graphHost.innerHTML = "";
    }
    if (RS.mainEl) RS.mainEl.classList.remove("is-graph");
    if (RS.centerEl) RS.centerEl.classList.remove("is-graph");
    /* 工具行 / 展开行 / 编辑器 / 会话框 + 应用左栏的「核心」「资料」两页一起清空：
       闸门只负责说明，底图不该再有内容 */
    for (const node of [
      RS.topEl,
      RS.toolSlotEl,
      RS.toggleRowEl,
      RS.toolbarEl,
      RS.bodyEl,
      RS.chatEl,
      qid("sideCore"),
      qid("sideRefs"),
    ]) {
      if (node) node.innerHTML = "";
    }
    RS.toggleOpen = "";
    if (RS.toggleRowEl) RS.toggleRowEl.hidden = true;
    RS.deriveChipEl = null;
    if (RS.outlineEl) {
      RS.outlineEl.innerHTML = "";
      RS.outlineEl.classList.add("empty");
    }
    /* 面包屑跟着顶栏一起清空：留着上一张画布的笔记名只会让人点错 */
    RS.crumbsEl = null;
    RS.crumbsTailEl = null;
    rsStopSpy();
    /* 上一轮「正在初始化」的观察一起收掉：要盯的话 showInitBusyGate 会重新起一支 */
    rsInitWatchStop();
    /* 上一张画布留下的初始化告示一起收掉：切到已有内容的画布时它不该还盖在视图上。
       需要告门时 showInitGate / showNoWsGate 会在这之后再铺。 */
    if (RS.gate) {
      RS.gate.classList.remove("show");
      RS.gate.innerHTML = "";
    }
    if (window.__rsInitGateBound) window.__rsInitGateBound = false;
  }

  /* ── 对外：进入 / 离开 / 监听 ── */
  async function enter() {
    /* 门禁第二道：即使有人绕过按钮直接调 setView("research") / MTResearch.enter()，
       非白名单账号也进不来（第一道在 researchSyncEntry 的显隐 + 点击守卫）。 */
    if (!userIsOwner()) {
      try {
        if (typeof setView === "function") setView("workflow");
      } catch (_) {}
      return;
    }
    buildShell();
    const r = await ensureInit();
    /* 进来就恢复：盘上有队列文件就认标记，目录不在就清掉（与重载同一口径） */
    await syncInitQueue();
    if (!r.ok && r.code === "no_ws") {
      rsClearPane();
      showNoWsGate();
      return;
    }
    if (!r.ok && r.code === "not_initialized") {
      /* 还没初始化：不给一份空壳目录，先把「要放什么」问清楚（共识：先初始化才建 research/）。
         先清空视图再出闸门 —— 否则底图是上一张画布的笔记 / 图谱。
         但这一轮初始化正跑在这份目录上时不能这么说（盘上还没 meta，其实后台正在准备）：
         投料台的进度 / 一张「正在初始化」的卡片才是真话。 */
      rsClearPane();
      if (initRunningHere()) showInitBusyGate();
      else showInitGate();
      return;
    }
    RS.gate.classList.remove("show");
    RS.gate.innerHTML = "";
    if (window.__rsInitGateBound) window.__rsInitGateBound = false;
    /* 这一轮初始化还在准备（盘上只有 meta 先落的那一份，笔记还没落）：别把空库画成成品 ——
       投料台开着就让它显示进度，关着就出一张「正在初始化」的卡片；收工后观察轮询自动装载。 */
    if (initRunningHere() && !(RS.notes && RS.notes.length)) {
      rsClearPane();
      showInitBusyGate();
      return;
    }
    /* 装载成功 = 「正在初始化」的观察到此为止（那一轮已经落盘） */
    rsInitWatchStop();
    renderTop();
    renderSide();
    renderLit();
    renderEditor();
    renderChat();
    if (RS.mode === "graph") rsSetMode("graph");
    hookAgentRender();
  }
  /* 没有工作目录时的闸门（与初始化闸门同一块容器，底图同样先清空） */
  function showNoWsGate() {
    if (!RS.gate) return;
    RS.gate.innerHTML =
      '<div class="rs-gate-card"><b>' +
      esc(t("这张画布还没有工作目录")) +
      "</b><p>" +
      esc(t("研究内容要落在画布工作目录下的 research/ 目录里。请先在画布顶栏设置工作目录，再回到这里。")) +
      '</p><button class="rs-btn" id="rsGateGo">' +
      esc(t("去设置工作目录")) +
      "</button></div>";
    RS.gate.classList.add("show");
    const go = qid("rsGateGo");
    if (go)
      go.onclick = () => {
        try {
          if (typeof openWfWorkspaceDialog === "function") openWfWorkspaceDialog();
        } catch (_) {}
      };
  }
  /* 未初始化时的空态：一句说明 + 一枚「初始化研究」按钮（点了才进向导） */
  function showInitGate() {
    if (!RS.gate) return;
    RS.gate.innerHTML =
      '<div class="rs-gate-card"><b>' +
      esc(t("这个课题还没有初始化")) +
      "</b><p>" +
      esc(t("初始化是一整块资料库：上面写课题，左边放核心文件，右边放参考资料（都能直接贴 arXiv / DOI / 网页链接、写笔记或检索式）。点「开始处理」才会创建 research/ 目录并交给 agent 处理；以后加了新资料，这颗按钮变成「补充处理」，只处理新内容。")) +
      '</p><button class="rs-btn" id="rsGateInit">' +
      esc(t("初始化研究")) +
      "</button></div>";
    RS.gate.classList.add("show");
    const btn = qid("rsGateInit");
    if (btn)
      btn.onclick = () => {
        RS.gate.classList.remove("show");
        openInitWizard(false);
      };
  }
  /* 初始化是不是正在这一份 research/ 上跑（投料台从「开始处理」到队列落盘那一段：复制文件 /
     转 PDF / 拉起会话）。判据只认投料台模块的 busy + 同一个目录 —— 不看盘上的 research.json：
     meta 是条目备齐之后才写的，那之前盘上本来就还没有，拿它判就会把「正在初始化」说成「没初始化」。 */
  function rsSamePath(a, b) {
    const norm = (v) => String(v || "").replace(/[\\/]+$/, "").toLowerCase();
    return !!a && !!b && norm(a) === norm(b);
  }
  function initRunningHere() {
    try {
      const I = window.MTResearchInit;
      const st = I && I.state && typeof I.state === "object" ? I.state : null;
      return !!(st && st.busy && rsSamePath(st.root, rootOf()));
    } catch (_) {
      return false;
    }
  }
  /* 「正在初始化」闸门：这一轮还在后台准备时不许说「这个课题还没有初始化」（用户报的 bug）。
     投料台本身开着就让它露出来（它自己画实时进度），关着就给一张带「查看进度」的卡片；
     两种都把闸门停在一支小轮询上：meta 一落盘就自动装载，准备收工（busy 变 false）还没 meta
     就退回正常的初始化入口。 */
  function showInitBusyGate() {
    if (!RS.gate) return;
    const I = window.MTResearchInit;
    const st = I && I.state && typeof I.state === "object" ? I.state : null;
    if (st && st.open) {
      /* 投料台 = 这一轮的进度面板：收掉闸门，别拿它盖住 */
      RS.gate.classList.remove("show");
      RS.gate.innerHTML = "";
      try {
        if (typeof I.render === "function") I.render();
      } catch (_) {}
    } else {
      RS.gate.innerHTML =
        '<div class="rs-gate-card"><b>' +
        esc(t("这个课题正在初始化")) +
        "</b><p>" +
        esc(t("资料库正在复制文件 / 转 PDF / 拉起会话，跑完会自己进索引页。可以先去别的视图，回来进度还在。")) +
        '</p><button class="rs-btn" id="rsGateInitBusy">' +
        esc(t("查看进度")) +
        "</button></div>";
      RS.gate.classList.add("show");
      const btn = qid("rsGateInitBusy");
      if (btn)
        btn.onclick = () => {
          rsInitWatchStop();
          RS.gate.classList.remove("show");
          RS.gate.innerHTML = "";
          try {
            if (I && typeof I.openProgress === "function") I.openProgress();
          } catch (_) {}
        };
    }
    rsInitWatchStart();
  }
  /* 初始化进行中的小轮询：只在研究视图开着、且这一轮就落在这个目录上时跑 */
  let rsInitWatchTimer = 0;
  function rsInitWatchStop() {
    if (rsInitWatchTimer) {
      clearInterval(rsInitWatchTimer);
      rsInitWatchTimer = 0;
    }
  }
  function rsInitWatchStart() {
    rsInitWatchStop();
    const root = rootOf();
    if (!root) return;
    rsInitWatchTimer = setInterval(async () => {
      try {
        const pane = qid("researchPane");
        /* 切走了 / 换了画布：这一支立刻收，回来由 enter() 重新铺 */
        if (!pane || pane.style.display === "none" || !rsSamePath(root, rootOf())) return rsInitWatchStop();
        /* 只等这一轮收工（成功 = meta + 队列 + 课题笔记都已落盘；失败 = 停在投料台上）：
           中途 reload 出来的是一份「有 meta、还没笔记」的空库，画出来只会让人以为初始化丢了。 */
        if (!initRunningHere()) {
          rsInitWatchStop();
          await rsReloadAll();
        }
      } catch (_) {
        rsInitWatchStop();
      }
    }, 2000);
  }
  async function rsReloadAll() {
    RS.ready = false;
    const r = await ensureInit();
    /* 重载同样无条件恢复标记：research/ 被删掉时这里会把队列清空，徽标 / chip 一起消失 */
    await syncInitQueue();
    /* 研究目录已被删掉 / 还没初始化 / 没有工作目录：清空视图并回闸门，不要留在空壳里 */
    if (!r.ok) {
      rsClearPane();
      try {
        if (r.code === "not_initialized") {
          if (initRunningHere()) showInitBusyGate();
          else showInitGate();
        } else showNoWsGate();
      } catch (_) {}
      return;
    }
    /* 已有内容：把「这个课题还没有初始化」的告示收掉（重载时不一定走过 rsClearPane） */
    if (RS.gate) {
      RS.gate.classList.remove("show");
      RS.gate.innerHTML = "";
    }
    if (window.__rsInitGateBound) window.__rsInitGateBound = false;
    /* 同 enter()：这一轮还在准备（只有 meta、没有笔记）就不画空库，先把进度亮出来 */
    if (initRunningHere() && !(RS.notes && RS.notes.length)) {
      rsClearPane();
      showInitBusyGate();
      return;
    }
    rsInitWatchStop();
    renderTop();
    renderSide();
    renderLit();
    renderEditor();
    renderChat();
    if (RS.mode === "graph") rsSetMode("graph");
  }
  /* 初始化跑完后的落点：研究视图的**索引页**（research.json 的 corePath，缺省 notes/00-课题.md）。
     投料台一关就该看见「这个课题现在有什么」，而不是停在发起初始化的那一页：
     先重读一遍盘（agent 刚写进来的原文 / 术语页 / 折叠 / 文献都在这一趟进树），
     再把当前这篇切回索引页（等初始化时用户可能已经翻到别的笔记、或切到了图谱）。 */
  async function rsShowIndexPage() {
    await rsReloadAll();
    if (!RS.ready) return;
    if (RS.mode === "graph") rsSetMode("notes");
    const rel = rsIndexRel();
    const has = !!rel && (RS.notes || []).some((n) => n.path === rel);
    if (has && RS.curPath !== rel) {
      await rsOpenNote(rel);
      return;
    }
    renderTop();
    renderEditor();
  }
  function onCanvasChanged() {
    if (!qid("researchPane")) return;
    /* 换画布先收掉投料台（初始化界面）：它装的是上一张画布的队列 / 核心与参考列表，留着就会
       原样盖在新画布上（用户报的「初始化界面切画布不关」）。这一步必须赶在下面那句
       「不在研究视图就早退」之前 —— 视图被切走时这块浮层同样得收，否则下次进来还挂着。 */
    rsDropInitWizard();
    const vis = qid("researchPane").style.display !== "none";
    if (!vis) {
      RS.ready = false;
      return;
    }
    /* 下拉菜单切画布：研究视图一直开着时 applyViewChrome 不会再跑，左栏的根还锁在
       上一张画布的 <工作目录>/research 上 —— 这里补一次，让左栏跟着换成新画布的目录。 */
    try {
      if (window.MTNodeSideFiles && typeof window.MTNodeSideFiles.onViewChange === "function")
        window.MTNodeSideFiles.onViewChange("research");
    } catch (_) {}
    /* 先把上一张画布的正文 / 图谱从界面上抹掉，再按新画布装载：
       读盘是异步的，不清就会出现「新画布的视图里先是旧画布内容」的闪回。 */
    rsClearPane();
    rsReloadAll().catch(() => {});
  }
  function onAuthChanged() {
    try {
      researchSyncEntry();
    } catch (_) {}
  }
  /* 入口显隐：登录用户名精确等于 ms2308 才显示（测试用功能，其它账号一律隐藏） */
  const RESEARCH_OWNER = "ms2308";
  function userIsOwner() {
    try {
      const A = window.MTNodeAuth;
      if (!A) return false;
      const snap = typeof A.state === "function" ? A.state() : A.state;
      const u = snap && snap.user;
      if (!u) return false;
      const name = String(u.username || "").trim().toLowerCase();
      return name === RESEARCH_OWNER;
    } catch (_) {
      return false;
    }
  }
  function researchSyncEntry() {
    const btn = qid("btnResearch");
    if (!btn) return;
    const on = userIsOwner();
    btn.hidden = !on;
    btn.style.display = on ? "" : "none";
    /* 权限收回时把研究视图顶掉：否则视图还开着、人已经不是白名单账号了。
       判据看面板本身而不是 window.S（app.js 的 S 是脚本级 const，不在 window 上）。 */
    const p = qid("researchPane");
    if (!on && p && p.style.display !== "none") {
      try {
        if (typeof setView === "function") setView("workflow");
      } catch (_) {}
    }
  }
  window.researchSyncEntry = researchSyncEntry;
  /* 左栏切页入口：app-sidebar-files.js 的 sfSetTab 切到「核心 / 资料」时调这里。
     研究视图没装载好（闸门未过 / 已切走）就什么都不画，免得把内容写进画布视图的左栏。 */
  function paintSide(tab) {
    if (!RS.ready) {
      /* 还没装载好（闸门未过 / 没有工作目录）：给一句说明，别留一块空白页 */
      const host = qid(tab === "refs" ? "sideRefs" : "sideCore");
      if (host) host.innerHTML = '<div class="rs-empty">' + esc(t("还没装载研究目录")) + "</div>";
      return;
    }
    if (tab === "refs") renderLit();
    else if (tab === "core") renderSide();
  }
  /* ══ 演示（PPT）：入口接线 · 落盘 · 模型重写派单 ══════════════════════════════
     三个模块的分工（本段只做接线、落盘与派单，页模型与界面都不在这里重写）：
       · research-slides.js        内核：notes + 3-Pass 变体（.skim / .concept / .tech）→ 页模型
       · research-slides-view.js   放映 / 单文件导出（零外链）
       · app-research-slides.js    三栏编辑器（window.MTResearchSlidesEditor）

     落盘口径（与 versions.json 同级、应用独占；不进 changes.jsonl —— 它不是正文）：
       research/slides/<slug>.json         手改（overlay / order / hidden）+ 主题 + 转场
       research/slides/<slug>.rewrite.json 模型重写的交付文件（模型写，宿主读走后合并进 overlay）
       research/exports/<slug>/<slug>.html 导出的单文件 HTML

     Token 口径：首次生成、单页重新生成、重置为自动生成全走内核直出（读盘上没改过的 notes 与
     三份变体稿，不花 Token）；**只有**「让 Agent 重写这一页 / 整份」才派现有 agent 会话，
     且**首次**派活一定先过「会消耗 Token」的确认：编辑器那颗小输入框在第一次时按钮上就写着它
     （编辑器的幕布层级高于 #mtDialog，宿主确认窗在幕布里看不见），宿主这张窗只留给不经编辑器的调用方。 */
  const RS_SLIDES_WAIT_MS = 240000; /* 会话迟迟不写出 rewrite.json 也算失败，别一直挂着 */
  /* 「会消耗 Token」那张确认只在**首次**派活时问一次：同一会话里后面的每一轮不再拦
     （多轮迭代本来就要来回好几次，每轮都弹一次窗只会挡住人）。 */
  let rsSlidesTokenAcked = false;
  /* 状态行（等第几轮写出 / 超时提示）：写进编辑器的状态行；编辑器没开着就跳过（改成 toast 会刷屏）。
     文案是中文常量 —— 与编辑器那一侧同一口径（app-research-slides.js 的文案暂不做 i18n），
     所以这几句**不过 t()**：半句进词条表反而会拼出中英混排。 */
  function rsSlidesAgentStatus(msg) {
    const D = rsDeck();
    if (!D.ctrl || typeof D.ctrl.setAgentStatus !== "function") return;
    try {
      D.ctrl.setAgentStatus(String(msg == null ? "" : msg));
    } catch (_) {}
  }
  /* 「等第 N 轮写出 X」这半句：超时提示一起带上（点「继续等」就是再续一整个窗口） */
  function rsSlidesWaitText(rel, round) {
    const mins = Math.max(1, Math.round(RS_SLIDES_WAIT_MS / 60000));
    return (
      "等第 " +
      String(Math.max(1, Number(round) || 1)) +
      " 轮写出 " +
      String(rel) +
      "（" +
      mins +
      " 分钟还没写出会问你要不要继续等）"
    );
  }
  let rsDeckState = null; /* { deck, slug, brief, ctrl, job } —— 惰性实例，rsDeck() 建 */
  let rsSlidesMenuEl = null;
  let rsSlidesMenuAnchor = null;
  let rsSlidesMenuPaint = null;

  function rsSlidesCoreMod() {
    return window.MTResearchSlides || null;
  }
  function rsSlidesEditorMod() {
    return window.MTResearchSlidesEditor || null;
  }
  /* 「有 core 稿件」：与内核取主稿的顺序一致（索引页 → notes/*.md → core/*.md）。
     一份都拿不到就**不给演示**（那套页只剩封面 + 结语，做出来没有意义）。 */
  function rsSlidesCoreNote() {
    const notes = RS.notes || [];
    if (!notes.length) return null;
    const core = rsNormRel(rsIndexRel());
    const byCore = notes.filter((n) => rsNormRel(n.path) === core)[0];
    if (byCore) return byCore;
    const byNotes = notes.filter((n) => /^notes\//.test(rsNormRel(n.path)))[0];
    if (byNotes) return byNotes;
    return notes.filter((n) => /^core\//.test(rsNormRel(n.path)))[0] || null;
  }
  function rsSlidesReady() {
    return !!rsSlidesCoreMod() && !!rsSlidesCoreNote();
  }
  function rsDeck() {
    if (!rsDeckState) rsDeckState = { deck: null, slug: "", brief: null, ctrl: null, job: null };
    return rsDeckState;
  }
  /* 内核输入：笔记（连 md 一起）/ 版本组 / 3-Pass 规则表 / 文献库 / research.json。
     三条来源都取调用期的现成实例，各留第二份就会与树上判色 / 衍生漂开。 */
  function rsSlidesInput(extra) {
    const V = rsVersions();
    const D = rsDerive();
    let groups = [];
    let rules = [];
    try {
      groups = V && typeof V.groups === "function" ? V.groups() || [] : [];
    } catch (_) {
      groups = [];
    }
    try {
      rules = D && typeof D.rules === "function" ? D.rules() || [] : [];
    } catch (_) {
      rules = [];
    }
    if (!rules.length) {
      try {
        rules = V && typeof V.rules === "function" ? V.rules() || [] : [];
      } catch (_) {
        rules = [];
      }
    }
    const core = rsSlidesCoreNote();
    const input = {
      notes: (RS.notes || []).map((n) => ({ path: n.path, title: n.title, md: n.md, meta: n.meta })),
      groups: groups,
      rules: rules,
      meta: RS.meta || {},
      lib: RS.lib || [],
      corePath: rsIndexRel(),
      title: String((core && core.title) || (RS.meta && RS.meta.title) || ""),
    };
    if (extra && typeof extra === "object") {
      for (const k of Object.keys(extra)) if (extra[k] != null) input[k] = extra[k];
    }
    return input;
  }
  /* 建 / 读一份 deck：内核算页 → 把 slides/<slug>.json 里的 brief、手改与主题盖回去。
     force = 丢掉内存里那份（盘上改了笔记 / 刚重置过）。
     brief 与 theme / patch 同级存在存档顶层（初始化卡写的）；老存档没有这个键 → 归一成默认值，
     读进来与今天完全一样（内核 briefOf 就是这条兼容口径）。 */
  async function rsDeckLoad(force) {
    const Ck = rsSlidesCoreMod();
    const D = rsDeck();
    if (!Ck || !RS.root) return null;
    if (D.deck && !force) return D.deck;
    const base = Ck.build(rsSlidesInput());
    const slug = String(base.slug || "");
    let saved = null;
    try {
      const txt = await readText(joinP(RS.root, Ck.fileOf(slug)));
      if (String(txt || "").trim()) saved = JSON.parse(txt);
    } catch (_) {
      saved = null;
    }
    const theme = saved && saved.theme && typeof saved.theme === "object" ? saved.theme : null;
    const brief = saved && saved.brief && typeof saved.brief === "object" ? saved.brief : null;
    const savedTier = saved && typeof saved.tier === "string" ? String(saved.tier) : "";
    /* 联网补料的缺省是「开」：只有显式存过 online:false 才算关 */
    const savedOnline = !(saved && saved.online === false);
    const input = rsSlidesInput({
      slug: slug,
      patch: saved && saved.patch ? saved.patch : null,
      theme: theme,
      transition: theme ? String(theme.transition || "") : "",
      brief: brief,
      tier: savedTier,
      online: savedOnline,
    });
    /* 创作档的真源是演示脚本（slides/<slug>.script.md）：在就用它编页；
       没有这个文件 / 编不出页（格式写坏了）才退回内核直出 —— 绝不把人挡在门外。 */
    let deck = null;
    if (savedTier !== "direct") {
      const scriptRel = rsSlidesScriptRel(slug);
      let scriptTxt = "";
      try {
        scriptTxt = String((await readText(joinP(RS.root, scriptRel))) || "");
      } catch (_) {
        scriptTxt = "";
      }
      if (scriptTxt.trim()) {
        const parsed = Ck.parseScript(scriptTxt, { path: scriptRel });
        if (parsed && parsed.ok && parsed.pages.length) {
          const base = Object.assign({}, input, {
            script: scriptTxt,
            scriptPath: scriptRel,
            slug: slug,
            theme: theme,
            transition: theme ? String(theme.transition || "") : "",
            brief: brief,
            patch: saved && saved.patch ? saved.patch : null,
            online: savedOnline,
          });
          /* 标题以脚本第一行 `#` 为准（研究标题只是兜底） */
          delete base.title;
          deck = Ck.buildFromScript(base);
        }
      }
    }
    if (!deck) deck = Ck.build(input);
    /* 导出视频成功后回填的成片信息（见 rsDeckExportVideo）：没有这个键 = 还没导出过，形状不变 */
    if (saved && saved.video && typeof saved.video === "object" && saved.video.path) {
      deck.video = saved.video;
    }
    D.deck = deck;
    D.slug = String(deck.slug || slug);
    D.brief = Ck.briefOf(deck);
    return deck;
  }
  /* 存档里的主题只留「预设 + 明暗 + 转场 + 真被改过的覆盖」：
     编辑器给的 theme 是把预设算开之后的整张表（primary / paper / font 都已解析），
     原样写回去再读回就会把「当时算出来的颜色」当成用户显式覆盖 —— 之后换预设 / 切明暗，
     纸色会被上一次的解析结果顶住。与预设默认值相同的一律不存。 */
  function rsSlidesCompactTheme(theme) {
    const Ck = rsSlidesCoreMod();
    if (!Ck || !theme || typeof theme !== "object") return null;
    const th = Ck.normalizeTheme(theme);
    const preset = typeof Ck.presetOf === "function" ? Ck.presetOf(th.preset) : null;
    const base = (preset && (preset[th.mode] || preset.light)) || {};
    const out = { preset: th.preset, mode: th.mode, transition: th.transition };
    for (const k of ["primary", "accent", "paper", "font"]) {
      const v = String(th[k] || "").trim();
      if (v && v !== String(base[k] || "").trim()) out[k] = v;
    }
    return out;
  }
  /* 手改落盘：slides/<slug>.json（与 versions.json 同级、应用独占）。
     只存「手改 + 主题 + brief」，页本身永远由内核现算 —— 上游笔记改了，重开就跟着变。 */
  async function rsDeckSave(info) {
    const Ck = rsSlidesCoreMod();
    const D = rsDeck();
    if (!Ck || !RS.root) return null;
    const deck = (info && info.deck) || D.deck;
    if (!deck) return null;
    const slug = String(deck.slug || D.slug || "slides");
    /* brief 与 theme 同一个 compact 口径：**全默认时不写这个键**（老存档读回来再写回去，形状不变） */
    const brief = Ck.normalizeBrief(info && info.brief ? info.brief : D.brief || (deck && deck.brief) || null);
    /* patch 显式给 null = 「这份存档没有手改」（初始化卡只写 brief + theme，不塞空 patch） */
    const patch = info && Object.prototype.hasOwnProperty.call(info, "patch") ? info.patch : deck.patch || null;
    const payload = {
      ver: Number(Ck.VER) || 1,
      slug: slug,
      title: String(deck.title || ""),
      core: String(deck.core || ""),
      theme: rsSlidesCompactTheme((info && info.theme) || deck.theme || null),
      patch: patch,
      savedAt: Date.now(),
    };
    if (!Ck.briefIsDefault(brief)) payload.brief = brief;
    /* 做法与联网补料：只在**非缺省**时写键 —— 老存档读回再写回，形状不变。
       缺省 = 创作档（页由 script.md 编出来）、联网开；所以只显式存 direct 与 online:false。 */
    const tier = String((info && info.tier) || deck.tier || "");
    if (tier === "author" || tier === "direct") payload.tier = tier;
    const online = info && Object.prototype.hasOwnProperty.call(info, "online") ? info.online !== false : deck.online !== false;
    if (online === false) payload.online = false;
    /* 成片信息（导出视频成功后回填）：路径存**相对研究目录**那一份（整包搬走也不丢），
       规格与时长一起存，播放 / 分发不必再 probe 一遍。没导出过就不写这个键。 */
    if (deck.video && typeof deck.video === "object" && deck.video.path) {
      payload.video = {
        path: String(deck.video.path),
        durationSec: Number(deck.video.durationSec) || 0,
        w: Number(deck.video.w) || 0,
        h: Number(deck.video.h) || 0,
        fps: Number(deck.video.fps) || 0,
      };
    }
    const rel = Ck.fileOf(slug);
    try {
      const res = await window.api.fileWriteText(joinP(RS.root, rel), JSON.stringify(payload, null, 2));
      if (res && res.ok === false) throw new Error(String(res.error || rel));
    } catch (e) {
      toastSafe(t("演示存档没写进去：") + String((e && e.message) || e), "err");
      return null;
    }
    D.deck = deck;
    D.slug = slug;
    D.brief = brief;
    return rel;
  }
  /* ── 演示叠加媒体：导入（复制进研究目录）/ 放映解析 / 导出内联 ──────────────────
     口径：overlay 里只存 slides/media/<slug>/<文件名> 这条**相对**路径（研究目录整包搬走
     也不丢，且绝不落应用目录）；放映 / 预览前宿主把它换成 file:// 绝对 URL，
     导出前换成 data: URL 内联，所以导出仍然是一份单文件 HTML。
     视频单项超过 ~24MB 不内联 —— toast 明确说明（不静默失败），这一项降级成相对导出文件
     的 ../../slides/media/…（文件留在原处时仍能播）。 */
  const RS_MEDIA_VIDEO_MAX = 24 * 1024 * 1024;
  const RS_MEDIA_IMG_EXT = ["png", "jpg", "jpeg", "webp", "gif", "svg", "avif", "bmp"];
  const RS_MEDIA_VID_EXT = ["mp4", "webm", "ogv", "ogg", "mov", "m4v"];
  function rsMediaExt(name) {
    const m = /\.([a-z0-9]+)$/i.exec(String(name == null ? "" : name));
    return m ? String(m[1]).toLowerCase() : "";
  }
  function rsMediaKindOf(name) {
    const e = rsMediaExt(name);
    if (RS_MEDIA_VID_EXT.indexOf(e) >= 0) return "video";
    if (RS_MEDIA_IMG_EXT.indexOf(e) >= 0) return "image";
    return "";
  }
  function rsMediaRelDir(slug) {
    const Ck = rsSlidesCoreMod();
    const base = Ck ? String(Ck.STORE_DIR) : "slides";
    return base + "/media/" + (String(slug || "").trim() || "slides");
  }
  /* 相对路径 → 绝对路径。不属于研究目录 media/ 的一律 null（外链 / 盘上别处都不收） */
  function rsMediaAbs(rel) {
    const Ck = rsSlidesCoreMod();
    const s = rsNormRel(rel);
    if (!Ck || !RS.root || !s) return null;
    if (/^[a-z][a-z0-9+.-]*:/i.test(s) || s.charAt(0) === "/") return null;
    if (s.indexOf(String(Ck.STORE_DIR) + "/media/") !== 0) return null;
    if (s.split("/").indexOf("..") >= 0) return null;
    return joinP(RS.root, s);
  }
  /* 放映 / 预览用：相对路径 → file:// 绝对 URL（data: / file: 原样放行，其余不认） */
  function rsMediaUrl(src) {
    const s = rsNormRel(src);
    if (!s) return "";
    if (/^(data|file):/i.test(s)) return s;
    if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return "";
    const abs = rsMediaAbs(s);
    if (!abs) return "";
    try {
      return window.api && window.api.toFileUrl ? String(window.api.toFileUrl(abs) || "") : "";
    } catch (_) {
      return "";
    }
  }
  /* 同名不覆盖：已存在就 -2 / -3 …（用户已有的媒体绝不被顶掉） */
  async function rsMediaUniq(dirAbs, name) {
    const one = String(name || "media");
    const dot = one.lastIndexOf(".");
    const stem = dot > 0 ? one.slice(0, dot) : one;
    const ext = dot > 0 ? one.slice(dot) : "";
    let out = one;
    for (let i = 2; i <= 999; i++) {
      let st = null;
      try {
        st = await window.api.fileStat(joinP(dirAbs, out));
      } catch (_) {
        st = null;
      }
      if (!st || st.ok === false) return out;
      out = stem + "-" + i + ext;
    }
    return stem + "-" + Date.now().toString(36) + ext;
  }
  /* 媒体「＋」：选文件 → 复制进 research/slides/media/<slug>/ → 只回相对路径 */
  async function rsMediaPick(slug) {
    const Ck = rsSlidesCoreMod();
    if (!Ck || !RS.root) return [];
    let r = null;
    try {
      r = await window.api.fileOpenDialog({
        title: t("选择图片或视频（会复制进研究目录）"),
        multi: true,
        filters: [
          { name: t("图片 / 视频"), extensions: RS_MEDIA_IMG_EXT.concat(RS_MEDIA_VID_EXT) },
          { name: t("全部文件"), extensions: ["*"] },
        ],
      });
    } catch (e) {
      toastSafe(t("打开选择框失败：") + String((e && e.message) || e), "err");
      return [];
    }
    const picks = (r && r.paths) || [];
    if (!picks.length) return [];
    return await rsMediaCopyIn(slug, picks);
  }
  /* 拖文件进预览走这条：路径是现成的（不用再开选择框），复制 / 去重口径与「＋图片」完全一致 */
  async function rsMediaImport(slug, paths) {
    const Ck = rsSlidesCoreMod();
    if (!Ck || !RS.root) return [];
    const picks = (Array.isArray(paths) ? paths : []).map((x) => String(x || "")).filter(Boolean);
    if (!picks.length) return [];
    return await rsMediaCopyIn(slug, picks);
  }
  async function rsMediaCopyIn(slug, picks) {
    const Ck = rsSlidesCoreMod();
    const dirRel = rsMediaRelDir(slug);
    const dirAbs = joinP(RS.root, dirRel);
    try {
      await window.api.fileMkdir(dirAbs);
    } catch (_) {
      /* 目录可能已存在：真正的失败由下面的 fileCopy 报出来 */
    }
    const out = [];
    const bad = [];
    for (const src of picks) {
      const base = String(src || "").split(/[\\/]/).pop() || "";
      const kind = rsMediaKindOf(base);
      if (!kind) {
        bad.push(base || String(src));
        continue;
      }
      const name = await rsMediaUniq(dirAbs, base.replace(/[\\/:*?"<>|]+/g, "_"));
      let cp = null;
      try {
        cp = await window.api.fileCopy(src, joinP(dirAbs, name));
      } catch (e) {
        cp = { ok: false, error: String((e && e.message) || e) };
      }
      if (!cp || cp.ok === false) {
        bad.push(base + "（" + String((cp && cp.error) || t("复制失败")) + "）");
        continue;
      }
      out.push({ id: "m-" + String(Ck.hashString(dirRel + "/" + name) || "").slice(0, 8), kind: kind, src: dirRel + "/" + name });
    }
    if (bad.length) toastSafe(t("有文件没导入：") + bad.join("、"), "warn");
    return out;
  }
  /* 导出前内联：media 的相对路径 → data: URL（导出仍是单文件）；超限 / 读不出来就明说。
     自由版面的 objects[] 里也有图 / 视频（src 同一套 slides/media/… 相对路径），一并内联 ——
     导出的单文件因此仍然零外链。 */
  async function rsMediaInlineOne(src, kindHint, missed) {
    const abs = rsMediaAbs(src);
    if (!abs) return { src: src, hit: false };
    const name = String(src).split("/").pop();
    const isVid = kindHint === "video" || rsMediaKindOf(name) === "video";
    let st = null;
    try {
      st = await window.api.fileStat(abs);
    } catch (_) {
      st = null;
    }
    if (isVid && st && st.ok && Number(st.size) > RS_MEDIA_VIDEO_MAX) {
      missed.push(name + " " + Math.round(Number(st.size) / 1048576) + "MB");
      /* 不内联：改成相对导出文件的路径（导出文件留在 exports/<slug>/ 里时仍能播） */
      return { src: "../../" + rsNormRel(src), hit: true };
    }
    let res = null;
    try {
      res = await window.api.assetReadDataUrl(abs);
    } catch (e) {
      res = { ok: false, error: String((e && e.message) || e) };
    }
    if (!res || res.ok === false || !res.dataUrl) {
      missed.push(name + "（" + String((res && res.error) || t("读不出来")) + "）");
      return { src: src, hit: false };
    }
    return { src: String(res.dataUrl), hit: true };
  }
  async function rsMediaInline(deck) {
    const d = deck && typeof deck === "object" ? deck : null;
    if (!d || !Array.isArray(d.pages)) return deck;
    const missed = [];
    let touched = false;
    const pages = [];
    for (const pg of d.pages) {
      if (!pg || typeof pg !== "object") {
        pages.push(pg);
        continue;
      }
      const media = Array.isArray(pg.media) ? pg.media : [];
      const objects = Array.isArray(pg.objects) ? pg.objects : [];
      if (!media.length && !objects.length) {
        pages.push(pg);
        continue;
      }
      let hit = false;
      const mediaOut = [];
      for (const m of media) {
        if (!m || !m.src || /^data:/i.test(m.src)) {
          mediaOut.push(m);
          continue;
        }
        const one = await rsMediaInlineOne(m.src, m.kind, missed);
        mediaOut.push(Object.assign({}, m, { src: one.src }));
        hit = hit || one.hit;
      }
      const objectsOut = [];
      for (const ob of objects) {
        if (!ob || !ob.src || /^data:/i.test(ob.src)) {
          objectsOut.push(ob);
          continue;
        }
        const one = await rsMediaInlineOne(ob.src, ob.kind, missed);
        objectsOut.push(Object.assign({}, ob, { src: one.src }));
        hit = hit || one.hit;
      }
      touched = touched || hit;
      if (!hit) {
        pages.push(pg);
        continue;
      }
      const next = Object.assign({}, pg);
      if (media.length) next.media = mediaOut;
      if (objects.length) next.objects = objectsOut;
      pages.push(next);
    }
    if (missed.length) {
      toastSafe(t("这些媒体没能内联进单文件（超过 24MB 或读不出来）：") + missed.join("、"), "warn");
    }
    return touched ? Object.assign({}, d, { pages: pages }) : d;
  }
  /* 交给编辑器的媒体口子（编辑器不碰盘：导入 / 解析 / 内联都在宿主这一侧） */
  function rsMediaApi(slugGetter) {
    const get = typeof slugGetter === "function" ? slugGetter : () => "slides";
    return {
      dir: () => rsMediaRelDir(get()),
      pick: () => rsMediaPick(get()),
      import: (paths) => rsMediaImport(get(), paths),
      url: (src) => rsMediaUrl(src),
      inline: (deck) => rsMediaInline(deck),
    };
  }
  /* 导出 PDF（一页一张）+ 逐页 PNG：同一份自包含 HTML，落在 research/exports/<slug>/ 里
     （<slug>.pdf + <slug>-p01.png…）。渲染与落盘都在主进程（隐藏窗 printToPDF / capturePage，
     见 slides-export.js），这里只算路径、把 HTML 交过去。 */
  async function rsDeckExportPrint(html, deck) {
    const Ck = rsSlidesCoreMod();
    if (!Ck || !RS.root || !html) return null;
    if (!window.api || typeof window.api.slidesPrint !== "function") {
      toastSafe(t("主进程没接导出接口（slidesPrint）"), "err");
      return null;
    }
    const slug = String((deck && deck.slug) || rsDeck().slug || "slides");
    const htmlRel = String(Ck.exportOf(slug) || "");
    const dirRel = htmlRel.replace(/\/[^/]*$/, "");
    const pdfPath = joinP(RS.root, htmlRel.replace(/\.html$/i, ".pdf"));
    const pngDir = joinP(RS.root, dirRel);
    let res = null;
    try {
      res = await window.api.slidesPrint({
        html: String(html),
        pdfPath: pdfPath,
        pngDir: pngDir,
        base: slug,
        aspect: String((deck && deck.aspect) || "16:9"),
      });
    } catch (e) {
      res = { ok: false, error: String((e && e.message) || e) };
    }
    if (!res || res.ok === false) {
      toastSafe(t("导出 PDF / PNG 失败：") + String((res && res.error) || ""), "err");
      return null;
    }
    const n = Array.isArray(res.pngs) ? res.pngs.length : 0;
    toastSafe(t("已导出 PDF：") + String(res.pdf || pdfPath) + (n ? t("，逐页 PNG ") + n + t(" 张") : ""));
    return res;
  }
  /* ── 导出视频（Remotion → MP4）────────────────────────────────────────────────
     分工与导出 HTML / PDF 同一条口径：渲染层只交数据，进程与落盘都在主进程。
       · 工程树 / 时间轴 / 字幕由 window.MTResearchSlidesVideo（纯函数）现算；
       · 宿主（remotion/main-remotion.js 的 renderProjectTree）只认「源码树 + props + 输出路径」，
         **不依赖画布节点**；产物与 HTML / PDF / PNG 同一目录：research/exports/<slug>/<slug>.mp4；
       · 旁白音轨**存在才混**（deck.narration 或约定位置 slides/media/<slug>/narration.<ext>），
         没有就纯画面、也不铺字幕；
       · 封面帧宿主用 ffmpeg 抽一帧 <slug>-cover.png（失败只记 warning，不影响成片）；
       · 成功后把 deck.video = { path, durationSec, w, h, fps } 回填并落盘（path 相对研究目录）。
     进度 / 取消：宿主推 research:slidesVideoProgress，取消走 researchSlidesVideoCancel(jobId)。 */
  function rsSlidesVideoMod() {
    return window.MTResearchSlidesVideo || null;
  }
  /* 旁白音轨的候选扩展名（与 remotion 宿主的 MIME 表同一批）。 */
  const RS_NARRATION_EXT = ["mp3", "wav", "m4a", "flac", "aac", "ogg"];
  /* 相对研究目录的路径（writing 回 deck.video.path 用；整包搬走也指得对）。
     不在研究目录里就原样返回绝对路径，绝不猜。 */
  function rsRootRel(abs) {
    const root = String(RS.root || "").replace(/\\/g, "/").replace(/\/+$/, "");
    const p = String(abs || "").replace(/\\/g, "/");
    if (root && p.toLowerCase().indexOf(root.toLowerCase() + "/") === 0) return p.slice(root.length + 1);
    return p;
  }
  /* 成片路径 → 绝对路径：存档里存的是研究目录相对路径（rsRootRel 的产物），绝对路径原样认。
     右栏「成片」块的播放 / 在文件夹中显示都以它为唯一解析口（不猜、不改）。 */
  function rsFilmAbs(p) {
    const s = String(p || "").trim();
    if (!s) return "";
    if (/^([a-z]:[\\/]|\\\\)/i.test(s)) return s;
    return RS.root ? joinP(RS.root, s) : "";
  }
  /* 封面帧 URL：成片与 HTML / PDF / PNG 同目录（exports/<slug>/），封面帧叫 <slug>-cover.png */
  function rsFilmCoverUrl(deck) {
    const Ck = rsSlidesCoreMod();
    const api = window.api || {};
    if (!Ck || !RS.root || typeof api.toFileUrl !== "function") return "";
    const slug = String((deck && deck.slug) || "") || "slides";
    const htmlRel = String(Ck.exportOf(slug) || "");
    if (!htmlRel) return "";
    const dirRel = htmlRel.replace(/\/[^/]*$/, "");
    try {
      return String(api.toFileUrl(joinP(RS.root, dirRel + "/" + slug + "-cover.png")) || "");
    } catch (_) {
      return "";
    }
  }
  /* 旁白音轨：deck.narration（绝对路径或研究目录相对路径）优先，否则认约定位置
     slides/media/<slug>/narration.<ext>。**存在才返回**（不存在 = 这次不混旁白、不铺字幕）。 */
  async function rsNarrationOf(deck, slug) {
    const api = window.api || {};
    const exists = async (p) => {
      try {
        return typeof api.fileExists === "function" ? !!(await api.fileExists(p)) : false;
      } catch (_) {
        return false;
      }
    };
    const cands = [];
    const raw = String((deck && deck.narration) || "").trim();
    if (raw && !/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
      cands.push(/^([a-z]:[\\/]|\\\\)/i.test(raw) ? raw : joinP(RS.root, raw));
    }
    const mediaRel = rsMediaRelDir(slug);
    for (let i = 0; i < RS_NARRATION_EXT.length; i++) cands.push(joinP(RS.root, mediaRel + "/narration." + RS_NARRATION_EXT[i]));
    for (const p of cands) {
      if (await exists(p)) return p;
    }
    return "";
  }
  /* 当前那一次视频导出（同一时刻只跑一个；取消按它认 jobId） */
  let RS_VIDEO_JOB = "";
  async function rsDeckExportVideo(deck, onProgress) {
    const Ck = rsSlidesCoreMod();
    const Vd = rsSlidesVideoMod();
    const api = window.api || {};
    if (!Ck || !RS.root || !deck) return { ok: false, error: t("研究目录还没就绪") };
    if (!Vd || typeof Vd.build !== "function") {
      toastSafe(t("视频工程生成器没加载（research-slides-video.js）"), "err");
      return { ok: false, error: "generator_missing" };
    }
    if (typeof api.researchSlidesVideo !== "function") {
      toastSafe(t("主进程没接视频导出接口（research:slidesVideo）"), "err");
      return { ok: false, error: "no_host_api" };
    }
    if (RS_VIDEO_JOB) {
      toastSafe(t("已经有一个视频导出在跑：等它结束，或先在顶栏点「取消」"), "warn");
      return { ok: false, error: "busy" };
    }
    const D = rsDeck();
    const slug = String((deck && deck.slug) || D.slug || "slides") || "slides";
    /* ① 工程树：deck + theme + brief → Remotion 源码树（纯函数，不碰盘） */
    const built = Vd.build({
      deck: deck,
      theme: (deck && deck.theme) || null,
      brief: Ck.briefOf(deck),
      aspect: deck && deck.aspect,
    });
    if (!built || built.ok === false) {
      const msg = String((built && built.error) || t("未知原因"));
      toastSafe(t("视频工程生成失败：") + msg, "err");
      return { ok: false, error: msg };
    }
    /* 静态检查不过的树不送去渲染：宿主那边也校验，但先在这里点名是哪个文件哪条规则 */
    if (built.audit && built.audit.ok === false) {
      const errs = Array.isArray(built.audit.errors) ? built.audit.errors : [];
      const msg = errs.join("\n") || t("工程没通过静态检查");
      toastSafe(t("视频工程没通过静态检查：") + msg, "err");
      return { ok: false, error: "audit_failed", message: msg };
    }
    const meta = built.meta || {};
    /* ② 落点：与 HTML / PDF / PNG 同一目录（research/exports/<slug>/），封面帧同目录 */
    const htmlRel = String(Ck.exportOf(slug) || "");
    const dirRel = htmlRel.replace(/\/[^/]*$/, "");
    const mp4Abs = joinP(RS.root, dirRel + "/" + slug + ".mp4");
    const coverAbs = joinP(RS.root, dirRel + "/" + slug + "-cover.png");
    const narration = await rsNarrationOf(deck, slug);
    /* jobId 按 slug 固定：同一份演示的工程目录稳定复用，取消 / 进度也按它认 */
    const jobId = "research-slides-" + (String(slug).replace(/[^\w.-]/g, "") || "slides");
    RS_VIDEO_JOB = jobId;
    let off = null;
    try {
      if (typeof api.onResearchSlidesVideoProgress === "function") {
        off = api.onResearchSlidesVideoProgress((ev) => {
          if (!ev || String(ev.jobId || "") !== jobId) return;
          try {
            if (typeof onProgress === "function") onProgress(ev);
          } catch (_) {}
        });
      }
      const res = await api.researchSlidesVideo({
        jobId: jobId,
        files: built.files,
        props: {},
        narrationPath: narration,
        outputPath: mp4Abs,
        coverPath: coverAbs,
        fps: Number(meta.fps) || 30,
        width: Number(meta.width) || 0,
        height: Number(meta.height) || 0,
        durationSeconds: Number(meta.durationSec) || 0,
        durationInFrames: Number(meta.durationInFrames) || 0,
        compositionId: String(meta.id || "Main"),
        timeoutSec: 20 * 60,
      });
      if (!res || res.ok === false) {
        const msg = String((res && (res.message || res.error)) || t("未知原因"));
        toastSafe(
          t("导出视频失败：") +
            msg +
            (res && res.cancelled ? "" : res && res.logPath ? t("（宿主日志：") + res.logPath + t("）") : ""),
          "err",
        );
        return { ok: false, error: msg, logPath: (res && res.logPath) || "", cancelled: !!(res && res.cancelled) };
      }
      /* ③ 回填 deck.video 并落盘（slides/<slug>.json） */
      const info = {
        path: rsRootRel(res.path || mp4Abs),
        durationSec: Math.round((Number(res.durationSec) || Number(meta.durationSec) || 0) * 100) / 100,
        w: Number(res.width) || Number(meta.width) || 0,
        h: Number(res.height) || Number(meta.height) || 0,
        fps: Number(res.fps) || Number(meta.fps) || 0,
      };
      deck.video = info;
      D.deck = deck;
      await rsDeckSave({ deck: deck });
      toastSafe(
        t("视频已导出：") +
          joinP(RS.root, info.path) +
          t("（") +
          info.durationSec +
          t("s · ") +
          info.w +
          "×" +
          info.h +
          (res.cover ? t(" · 封面 ") + res.cover : "") +
          t("）"),
      );
      return {
        ok: true,
        video: info,
        path: res.path,
        cover: res.cover || "",
        warnings: Array.isArray(res.warnings) ? res.warnings : [],
      };
    } catch (e) {
      const msg = String((e && e.message) || e);
      toastSafe(t("导出视频失败：") + msg, "err");
      return { ok: false, error: msg };
    } finally {
      if (off) {
        try {
          off();
        } catch (_) {}
      }
      RS_VIDEO_JOB = "";
    }
  }
  /* ── 一轮链路：脚本落地 / 直出档重算完 → 自动接一次出片 ────────────────────────
     判据只看 brief.mode（版本）：slides = 只要静态版（不出片）；video / both = 出片。
     出口只有编辑器那颗 exportVideo（就是顶栏「导出视频」）——它背后仍是宿主 onExportVideo →
     rsDeckExportVideo 这**唯一**一条写盘 / 渲染路径：进度条、状态行、失败行（原因 + 宿主日志）
     全在它那儿，宿主这边不另开一条。失败不打断链路：编辑器照常可用，重试还是点同一颗按钮。
     返回 true = 真派出去了；false = 这一档不要片 / 编辑器没开 / 已经有一条在渲。 */
  function rsSlidesAutoVideo(deck) {
    const Ck = rsSlidesCoreMod();
    const D = rsDeck();
    const target = deck || D.deck || null;
    if (!target || !Ck) return false;
    const brief = Ck.briefOf(target);
    if (String((brief && brief.mode) || "slides") === "slides") return false;
    const ctrl = D.ctrl;
    if (!ctrl || typeof ctrl.exportVideo !== "function") return false; /* 编辑器没开：不另开一条没有进度条的渲染路 */
    if (RS_VIDEO_JOB) return false; /* 已经有一条在渲：不叠第二条（取消 / 重试仍归那一条） */
    try {
      void Promise.resolve(ctrl.exportVideo()).catch(() => {});
    } catch (_) {
      return false;
    }
    return true;
  }
  /* 顶栏「取消」：结束这一次导出的渲染进程树（宿主不往报错总线写失败） */
  function rsDeckVideoCancel() {
    const api = window.api || {};
    if (!RS_VIDEO_JOB) return { ok: false, cancelled: false, error: "no_job" };
    if (typeof api.researchSlidesVideoCancel !== "function") return { ok: false, cancelled: false, error: "no_api" };
    return api.researchSlidesVideoCancel(RS_VIDEO_JOB);
  }
  /* 演讲者第二屏：主窗的 window.open 被拒，第二屏由主进程开窗、之后每翻一页推一次状态。
     第一次带 html（开窗），之后只带 state（推进去）；窗口被用户关掉就下次重新开。 */
  const RS_PRESENTER = { id: "" };
  async function rsSlidesPresenter(state, html) {
    if (!state) return null;
    const api = window.api || {};
    if (html && typeof api.slidesPresenter === "function") {
      let res = null;
      try {
        res = await api.slidesPresenter(String(html));
      } catch (e) {
        res = { ok: false, error: String((e && e.message) || e) };
      }
      if (!res || res.ok === false) {
        toastSafe(t("演讲者视图没开起来：") + String((res && res.error) || ""), "err");
        return null;
      }
      RS_PRESENTER.id = String(res.id || "");
      return res;
    }
    if (!RS_PRESENTER.id || typeof api.slidesPresenterPush !== "function") return null;
    try {
      const r = await api.slidesPresenterPush(RS_PRESENTER.id, state);
      if (r && r.ok === false) RS_PRESENTER.id = "";
    } catch (_) {}
    return null;
  }
  function rsSlidesPresenterClose() {
    const api = window.api || {};
    if (RS_PRESENTER.id && typeof api.slidesPresenterClose === "function") {
      try {
        void api.slidesPresenterClose(RS_PRESENTER.id);
      } catch (_) {}
    }
    RS_PRESENTER.id = "";
  }
  /* 导出：research/exports/<slug>/<slug>.html（零外链单文件）→ toast 绝对路径 → 用系统默认程序打开 */
  async function rsDeckExport(html, deck) {
    const Ck = rsSlidesCoreMod();
    if (!Ck || !RS.root || !html) return null;
    const slug = String((deck && deck.slug) || rsDeck().slug || "slides");
    const abs = joinP(RS.root, Ck.exportOf(slug));
    try {
      const res = await window.api.fileWriteText(abs, String(html));
      if (res && res.ok === false) throw new Error(String(res.error || abs));
    } catch (e) {
      toastSafe(t("导出失败：") + String((e && e.message) || e), "err");
      return null;
    }
    toastSafe(t("演示已导出：") + abs);
    try {
      const r = window.api && window.api.shellOpenPath ? await window.api.shellOpenPath(abs) : null;
      if (r && r.ok === false) toastSafe(t("打开失败：") + ((r && r.error) || abs), "err");
    } catch (_) {}
    return abs;
  }
  /* 右栏 / 树上点进来某一篇：编辑器落到这篇稿对应的那一页（变体稿也有自己的页） */
  function rsSlidesGotoNote(rel) {
    const D = rsDeck();
    const ctrl = D.ctrl;
    if (!ctrl || typeof ctrl.goto !== "function" || typeof ctrl.deck !== "function") return;
    const want = rsNormRel(rel || "");
    if (!want) return;
    const pages = (ctrl.deck() && ctrl.deck().pages) || [];
    const hit = pages.filter((p) => p && p.src && rsNormRel(p.src.path) === want)[0];
    if (hit) ctrl.goto(hit.id);
  }
  /* ── 初始化卡（renderer/app-research-slides-init.js）──────────────────────────
     三块：版本（brief.mode）/ 风格（theme = preset + mode）/ 额外指示（brief 的受众 / 场合 /
     时长 / 重点 / 忌口 / extra）。卡本身不碰盘、不重算页；这里只做三件事：
       ① 给卡喂当前 brief / theme（老存档没有 brief → 归一成默认值，卡里就是默认选项）；
       ② 卡确认后走 rsDeckSave 落盘（brief 与 theme 同级，patch 一个字节都不动）；
       ③ 按盘上刚写的 brief + theme 重跑内核，再把结果交给编辑器（setDeck）或打开编辑器。
     弹卡口径（spec §4.3）：brief 没有或 updatedAt === 0（从没确认过）才先出这张卡；
     有就直接进编辑器，「重新生成 / 重置 / 单页重算」都复用同一份 brief，不再弹。 */
  function rsSlidesInitMod() {
    return window.MTResearchSlidesInit || null;
  }
  /* 初始化卡挡在编辑器前面时，那一篇要落到的页先记着：确认后编辑器一开就跳过去 */
  let rsSlidesInitRel = "";
  async function rsSlidesInitSubmit(inf) {
    const Ck = rsSlidesCoreMod();
    const D = rsDeck();
    if (!Ck || !RS.root) return { ok: false, error: t("研究目录还没就绪") };
    const deck = D.deck || (await rsDeckLoad(true));
    if (!deck) return { ok: false, error: t("演示还没生成") };
    const brief = Ck.normalizeBrief(inf && inf.brief);
    /* 风格没动就带上编辑器里那几个颜色覆盖（右栏改过 primary / accent 的不该被这张卡洗掉）；
       真换了预设 / 明暗才按新那一套重算（旧覆盖属于上一套风格）。 */
    const wantPreset = (inf && inf.theme && inf.theme.preset) || (deck.theme && deck.theme.preset);
    const wantMode = (inf && inf.theme && inf.theme.mode) || (deck.theme && deck.theme.mode);
    const sameStyle = !!deck.theme && deck.theme.preset === wantPreset && deck.theme.mode === wantMode;
    const th = sameStyle
      ? Ck.normalizeTheme(deck.theme)
      : Ck.normalizeTheme({ preset: wantPreset, mode: wantMode, transition: deck.theme && deck.theme.transition });
    /* 手改（overlay / 顺序 / 显隐 / 比例 / 页面元素开关）原样带上；一处都没有就写 null，
       存档里不留一个空 patch —— 初始化卡只负责 brief + theme。 */
    const p0 = deck.patch || {};
    const hasPatch =
      Object.keys(p0.overlay || {}).length > 0 ||
      (p0.order || []).length > 0 ||
      (p0.hidden || []).length > 0 ||
      !!p0.aspect ||
      Object.keys(p0.chrome || {}).length > 0;
    /* ① 做法：creator = Agent 按指示写演示脚本（默认）；direct = 内核照原文直出（不花 Token）。
       ② 联网补料：默认开；关掉 = 一个字节都不许上网，产物与今天完全一致。 */
    const tier = inf && String(inf.tier || "") === "direct" ? "direct" : "author";
    const online = !(inf && inf.online === false);
    const rel = await rsDeckSave({
      deck: deck,
      patch: hasPatch ? p0 : null,
      theme: th,
      brief: brief,
      tier: tier,
      online: online,
    });
    if (!rel) return { ok: false, error: t("没写进 ") + Ck.fileOf(String(deck.slug || D.slug || "slides")) };
    D.brief = brief;
    const slug = String(deck.slug || D.slug || "slides");
    /* 创作档：brief 落盘之后交给 Agent 写脚本（slides/<slug>.script.md），
       写完由 rsSlidesWatchScript 编成 deck 再换到编辑器里 —— 这条路不阻塞这张卡。 */
    if (tier === "author") {
      const scriptRel = rsSlidesScriptRel(slug);
      let existing = "";
      try {
        existing = String((await readText(joinP(RS.root, scriptRel))) || "");
      } catch (_) {
        existing = "";
      }
      /* 已有脚本：脚本就是成品 —— 按它重算一遍把界面顶上来，然后直接出片（见 rsSlidesAutoVideo）。
         这一档**不再派单**：再派一轮只会把脚本重写一遍、把刚落的片重渲一遍（同一份 slug 两条渲染撞在一起）。 */
      if (existing.trim()) {
        D.deck = null;
        const cur = await rsDeckLoad(true);
        if (cur && D.ctrl && typeof D.ctrl.setDeck === "function") D.ctrl.setDeck(cur);
        else if (cur && !D.ctrl) await rsSlidesOpen();
        rsSlidesAutoVideo(cur || D.deck);
        return { ok: true, rel: rel, deck: D.deck || cur, script: scriptRel };
      }
      deck.tier = "author";
      D.deck = deck;
      D.slug = slug;
      /* 先把编辑器顶上来（这几页仍是内核直出的），脚本落盘后 rsSlidesScriptAdopt 再整体换掉 */
      if (D.ctrl && typeof D.ctrl.setDeck === "function") D.ctrl.setDeck(deck);
      else if (!D.ctrl) await rsSlidesOpen();
      /* 已经有一轮脚本在等写盘：不重复派单（同一份文件派两轮，落盘后会重放出两条链） */
      if (D.job && D.job.kind === "script") {
        return { ok: true, rel: rel, deck: D.deck, pending: "script", script: scriptRel };
      }
      void rsSlidesScriptAsk(deck, brief, online, "");
      return { ok: true, rel: rel, deck: D.deck, pending: "script", script: scriptRel };
    }
    /* 直出档：按盘上那份重算（brief 影响视频侧计划与派单，页本身仍由内核全量算） */
    D.deck = null;
    const fresh = await rsDeckLoad(true);
    if (D.ctrl && typeof D.ctrl.setDeck === "function" && fresh) {
      D.ctrl.setDeck(fresh);
      D.ctrl.raise();
    } else if (!D.ctrl) {
      await rsSlidesOpen();
      if (rsSlidesInitRel) {
        const to = rsSlidesInitRel;
        rsSlidesInitRel = "";
        rsSlidesGotoNote(to);
      }
    }
    /* 直出档也一轮到底：重算完直接出片（不花 Token，也不再多点一次「导出视频」） */
    rsSlidesAutoVideo(fresh);
    return { ok: true, rel: rel, deck: fresh };
  }
  function rsSlidesInitOpen(reason) {
    const Ck = rsSlidesCoreMod();
    const Init = rsSlidesInitMod();
    if (!Ck || !Init) {
      toastSafe(t("初始化卡没加载（app-research-slides-init.js）"), "err");
      return null;
    }
    const D = rsDeck();
    const deck = D.deck;
    const slug = String((deck && deck.slug) || D.slug || "slides");
    return Init.open({
      deck: deck || null,
      title: String((deck && deck.title) || (RS.meta && RS.meta.title) || ""),
      brief: Ck.briefOf(deck || {}),
      theme: (deck && deck.theme) || null,
      reason: reason === "settings" ? "settings" : "init",
      hint: Ck.fileOf(slug),
      onSubmit: (info) => rsSlidesInitSubmit(info),
    });
  }
  /* 编辑器那两颗（左栏当前页「A」/ 顶栏「让 Agent 重写整份」）→ 与顶栏菜单同一条：
     memo = 用户在小输入框里写的「这次想怎么改」（可空串）。页 id 是编辑器传上来的那一页，
     对不上（页被删了）就退回「当前打开那篇笔记对应的页」。 */
  async function rsSlidesAgentRewrite(scope, pageId, memo) {
    const Ck = rsSlidesCoreMod();
    const deck = await rsSlidesEnsureDeck();
    if (!Ck || !deck) return null;
    let page = null;
    if (scope === "page") {
      page = pageId ? Ck.pageById(deck, String(pageId)) : null;
      if (!page) page = rsSlidesPageTarget();
      if (!page) {
        toastSafe(t("没有可重写的页"), "warn");
        return null;
      }
    }
    return await rsSlidesRewrite(scope === "page" ? "page" : "all", page, memo, { acked: true });
  }
  /* 顶栏菜单那两颗也走同一套：先把编辑器打开（没开就开），再由它收「这次想怎么改」，
     然后回到 rsSlidesRewrite（首次才弹「会消耗 Token」）→ 状态行报等待轮次。 */
  async function rsSlidesAgentAsk(scope) {
    const ctrl = await rsSlidesOpen();
    if (!ctrl || typeof ctrl.askRewrite !== "function") {
      toastSafe(t("演示还没打开（先把初始化卡确认掉），再点一次这条"), "warn");
      return null;
    }
    const id = scope === "page" ? String((rsSlidesPageTarget() || {}).id || "") : "";
    return await ctrl.askRewrite(scope === "page" ? "page" : "all", id);
  }
  /* 打开编辑器：首次进来就是内核直出（不花 Token）。
     onChange 一回就写 slides/<slug>.json（含 brief）；onExport 走上面的落盘；
     onReset / onRegeneratePage 都只重跑内核（重读盘上的稿子），不派会话。
     从没确认过初始化卡（brief 没有 / updatedAt === 0）时，先出那张卡，确认后由
     rsSlidesInitSubmit 落盘再回到这里 —— 所以这条分支只会走一次。 */
  async function rsSlidesOpen(rel) {
    const Ck = rsSlidesCoreMod();
    const UI = rsSlidesEditorMod();
    if (!Ck || !UI) {
      toastSafe(t("演示模块没加载（research-slides.js / app-research-slides.js）"), "err");
      return null;
    }
    if (!RS.root) {
      toastSafe(t("研究目录还没就绪"), "warn");
      return null;
    }
    if (!rsSlidesCoreNote()) {
      toastSafe(t("还没有核心稿件：先投料或新建一篇原文，再做演示"), "warn");
      return null;
    }
    const D = rsDeck();
    /* 已经开着一块：抬回来并落到那一篇对应的页，不重建 deck（别把正在改的那一页刷掉） */
    if (D.ctrl && typeof D.ctrl.raise === "function") {
      D.ctrl.raise();
      if (rel) rsSlidesGotoNote(rel);
      return D.ctrl;
    }
    const deck = await rsDeckLoad(true);
    if (!deck) return null;
    /* 从没确认过初始化卡（没有 brief / updatedAt === 0）：先出那张卡，确认后它自己回来打开编辑器。
       卡里的「取消」= 这次不做演示，一个文件都不写（slides/<slug>.json 保持原样）。 */
    const brief0 = Ck.briefOf(deck);
    if (!(brief0 && brief0.updatedAt > 0)) {
      rsSlidesInitRel = String(rel || "");
      const card = rsSlidesInitOpen("init");
      if (card) return card;
      /* 卡没加载（模块缺失）：退回今天的行为直接进编辑器，不把人挡在门外 */
      rsSlidesInitRel = "";
    }
    const ctrl = UI.open({
      deck: deck,
      /* 叠加媒体：编辑器只调这三件事（选文件复制进研究目录 / 放映换成 file:// / 导出内联），
         落盘、路径解析与 data URL 都在宿主这一侧（见 rsMediaApi 那段）。 */
      media: rsMediaApi(() => String(rsDeck().slug || "slides")),
      onChange: (inf) => {
        if (inf && inf.deck) D.deck = inf.deck;
        void rsDeckSave(inf);
      },
      onExport: (html, dk) => void rsDeckExport(html, dk),
      /* 导出 PDF（一页一张）+ 逐页 PNG（同一份自包含 HTML，落 research/exports/<slug>/） */
      onExportPrint: (html, dk) => void rsDeckExportPrint(html, dk),
      /* 导出视频：工程树现算 → 宿主渲染 MP4 → 回填 deck.video 并落盘（见 rsDeckExportVideo）。
         进度经 onProgress 驱动编辑器进度条；取消走 onExportVideoCancel（结束渲染进程树）。 */
      onExportVideo: (dk, onProgress) => rsDeckExportVideo(dk, onProgress),
      onExportVideoCancel: () => rsDeckVideoCancel(),
      /* 右栏「成片」块的三个薄回调（不新开 IPC）：播放 / 在文件夹中显示 / 封面帧 URL。
         deck.video.path 存的是研究目录相对路径，绝对路径原样认（见 rsFilmAbs）。 */
      onOpenVideo: async (p) => {
        const abs = rsFilmAbs(p);
        const apiNow = window.api || {};
        if (!abs) return { ok: false, error: t("没有成片可播放") };
        if (typeof apiNow.shellOpenPath !== "function") return { ok: false, error: "no_api" };
        try {
          return await apiNow.shellOpenPath(abs);
        } catch (e) {
          return { ok: false, error: String((e && e.message) || e) };
        }
      },
      onRevealVideo: async (p) => {
        const abs = rsFilmAbs(p);
        const apiNow = window.api || {};
        if (!abs) return { ok: false, error: t("没有成片可定位") };
        if (typeof apiNow.shellShowItem !== "function") return { ok: false, error: "no_api" };
        try {
          return await apiNow.shellShowItem(abs);
        } catch (e) {
          return { ok: false, error: String((e && e.message) || e) };
        }
      },
      /* 封面帧：与成片同目录 research/exports/<slug>/<slug>-cover.png（主进程 ffmpeg 抽的一帧）；
         只拼 URL 不查盘 —— 文件不在时编辑器那边 img.onerror 退回占位，不摆破图。 */
      coverUrl: (dk) => rsFilmCoverUrl(dk),
      /* 演讲者第二屏（主进程开窗；之后每翻一页推进状态） */
      onPresenter: (state, html) => void rsSlidesPresenter(state, html),
      /* 退出放映：把第二屏那只窗关掉（再进一次放映会重新开） */
      onPresenterClose: () => rsSlidesPresenterClose(),
      /* 顶栏「初始化设置」：再开同一张卡改版本 / 风格 / 额外指示（brief 不重复弹，改完立刻重排） */
      onSettings: () => {
        void rsSlidesInitOpen("settings");
      },
      /* 重置为自动生成：把存档里的 overlay / order / hidden 清掉，再按盘上的稿子重算一遍。
         brief 是「怎么讲」的指示、不是手改 —— 原样留住（也就不会因为重置又弹一次初始化卡）。 */
      onReset: () => {
        void (async () => {
          const slug = String(D.slug || "slides");
          const brief = Ck.normalizeBrief(D.brief || Ck.briefOf(D.deck || {}));
          const payload = { ver: Number(Ck.VER) || 1, slug: slug, patch: null, theme: null, savedAt: Date.now() };
          if (!Ck.briefIsDefault(brief)) payload.brief = brief;
          try {
            await window.api.fileWriteText(joinP(RS.root, Ck.fileOf(slug)), JSON.stringify(payload, null, 2));
          } catch (_) {}
          D.deck = null;
          const fresh = await rsDeckLoad(true);
          if (fresh && D.ctrl && typeof D.ctrl.setDeck === "function") D.ctrl.setDeck(fresh);
        })();
      },
      /* 单页重新生成：按内存里最新的稿子重算（编辑器已经先丢了这一页的手改，
         所以传回来的是「已经清干净」的 patch）；不读盘、不派会话，brief 原样带上 */
      onRegeneratePage: (id, inf) => {
        const fresh = Ck.build(
          rsSlidesInput({ slug: D.slug, patch: (inf && inf.patch) || null, brief: Ck.normalizeBrief(D.brief || {}) }),
        );
        D.deck = fresh;
        return { deck: fresh };
      },
      /* Agent 改写（左栏每行「A」/ 顶栏「让 Agent 重写整份」）：memo = 那一轮「想怎么改」，可空；
         派活、首次「会消耗 Token」的确认、等第几轮写出都在 rsSlidesRewrite / rsSlidesWatch 里 */
      onAgentRewritePage: (id, memo) => rsSlidesAgentRewrite("page", id, memo),
      onAgentRewriteAll: (memo) => rsSlidesAgentRewrite("all", null, memo),
      /* 撤销这次模型改写：读最近一份 pre-agent 快照回写 patch 并 setDeck（函数在下面） */
      onAgentUndo: () => rsSlidesUndoRewrite(),
      onClose: () => {
        D.ctrl = null;
        /* 编辑器关了：演讲者第二屏一起收掉（别留一只没人推状态的窗） */
        rsSlidesPresenterClose();
      },
    });
    D.ctrl = ctrl || null;
    /* 编辑器刚打开 / 刚重开：还有一路在等模型写出，就把「等第几轮」补回状态行 */
    if (D.ctrl && D.job) rsSlidesAgentStatus(rsSlidesWaitText(D.job.rel, D.job.round + 1));
    if (ctrl && rel) rsSlidesGotoNote(rel);
    return ctrl;
  }
  /* 「模型重写这一页」的目标页 = 当前打开那篇笔记对应的页；没有就第一页 */
  function rsSlidesPageTarget() {
    const D = rsDeck();
    const deck = D.deck;
    if (!deck) return null;
    const pages = (deck.pages || []).filter((p) => !p.hidden);
    const want = rsNormRel(RS.curPath || "");
    const hit = want ? pages.filter((p) => p && p.src && rsNormRel(p.src.path) === want)[0] : null;
    return hit || pages[0] || null;
  }
  async function rsSlidesEnsureDeck() {
    const D = rsDeck();
    if (D.deck) return D.deck;
    return await rsDeckLoad(true);
  }
  /* 派给会话的改写提示：只改文案、不动页 id、不编事实；交付文件是 rewrite.json（宿主读走后合进 overlay）。
     规格 §4.2 的两条口径在这一层定死：
       · brief 全字段（受众 / 场合 / 语气 / 重点 / 忌口 / 额外指示）必须进提示词 —— 不然模型不知道讲给谁听；
       · 这是可反复迭代的一轮，不是一次性交付 —— 这一轮改哪些由用户那句「想怎么改」(memo) 决定，改完停手等下一轮。 */
  /* ── 创作档（tier = author）：Agent 写演示脚本，内核编译成 deck ────────────────
     与「模型重写」(rewrite.json) 是两条独立的路：
       · rewrite 只换页里的字（overlay 压在页上），页结构仍由内核从笔记算；
       · script  就是演示本身（每页一节），整份 deck 由它编（research-slides.js 的 parseScript）。
     交付文件固定 slides/<slug>.script.md —— 格式的解释器只有内核一份，这里只负责写给模型看。 */
  function rsSlidesScriptRel(slug) {
    const Ck = rsSlidesCoreMod();
    return String((Ck && Ck.STORE_DIR) || "slides") + "/" + (String(slug || "").trim() || "slides") + ".script.md";
  }
  /* 展示风格（brief.style）翻成「怎么写页」的执行指示 —— 与内核 STYLE_MOTION / STYLE_SCENE_MAX 同一套口径
     （见 research-slides.js resolveStyle）：scholarly 慢推克制、motion 大字色块、d2_5 分层、d3 真三维轨道相机。
     颜色 / 字体归 theme，这里只说「怎么演」；且风格服从内容，撑不起就退回学术那套讲法。 */
  const RS_SLIDE_STYLE_BRIEF = {
    scholarly: [
      "克制：一页只讲一件事，要点 3–4 条、每条 ≤ 18 字，宁少不多；不要感叹号与营销腔。",
      "公式与图注优先：材料里有写得出来的公式就单独一行 `$$ … $$`，要点退到解释它的位置。",
      "慢推：先给问题、再给做法、最后给结论，页与页之间留出呼吸，不要堆并列短句。",
      "三维场景最多 1 页，只在层级 / 系统非三维讲不清时才加。",
    ],
    motion: [
      "大字与色块：标题一句话就够，要点写成短句（≤ 12 字）或对比的两头（A 对 B）。",
      "数字当主角：关键数字直接写进要点，带单位与口径（「快了 3.2 倍」「从 31% 到 74%」）。",
      "讲得出变化：用「提升 / 下降 / 倍 / 占比 / 前后」这类能动的说法，少用形容词。",
      "不加三维场景页（这一档靠字与色块，`<!-- scene -->` 一律不写）；遮罩转场由内核做。",
    ],
    d2_5: [
      "分层：一页讲清「一层套一层」的关系（大纲、子问题、步骤、分类），要点按层写，不要平铺三个并列结论。",
      "每页都落到一个能分层的东西上；同一层最多 3 条，层间用「先 / 再 / 最后」或序数标出来。",
      "三维场景最多 2 页，只给真正的层级结构。",
    ],
    d3: [
      "空间优先：只把「位置、方向、距离、轨道、传播、维度、映射」这类内容做成三维页，全片最多 4 页。",
      "三维页只讲空间关系（`<!-- scene: orbit|grid|signal -->`），结论仍写在要点里，别让每页都上场景。",
      "旁白要说清镜头在看什么（「我们绕着这个系统转一圈」），不要只念要点。",
    ],
  };
  /* 派单提示词：做法（受众 / 场合 / 重点 / 风格）、可联网的边界、脚本格式，一次说清。
     格式与内核 parseScript 一一对应 —— 改格式必须两边一起改，否则模型写的脚本编不成页。 */
  function rsSlidesScriptPrompt(deck, brief, online, memo) {
    const Ck = rsSlidesCoreMod();
    const D = rsDeck();
    const root = String(RS.root || "").replace(/\\/g, "/");
    const slug = String((deck && deck.slug) || D.slug || "slides");
    const rel = rsSlidesScriptRel(slug);
    const want = String(memo == null ? "" : memo)
      .replace(/\r\n?/g, "\n")
      .trim()
      .slice(0, 2000);
    const b = Ck ? Ck.normalizeBrief(brief) : {};
    const L = [];
    L.push(
      t(
        "你要把这份研究做成一支能直接讲给人听的演示：先写演示脚本（每页一节），宿主会用内核把它编成演示页与视频。脚本就是成品的唯一真源 —— 页标题、要点、公式、引文、口播旁白全从它来。",
      ),
    );
    L.push(t("用户已有的材料只是**参考资料**：不要照抄它的章节顺序，按「怎么讲最清楚」重新组织。"));
    L.push("");
    L.push(t("开工顺序（第一步不许跳）："));
    L.push(
      "- " +
        t(
          "先读懂：读 `notes/` 里的核心稿件（连带 `notes/cites/*.md` 的引文）与 `literature/library.json`，把这份材料究竟在讲什么弄明白 —— 作者主张什么、凭什么、哪一步最容易讲错。",
        ),
    );
    L.push(
      "- " +
        t(
          "再定口径：用三五句话写下「这份内容必须讲清的点」，然后把这层意思直接落进脚本首页（`## 01`）的要点与旁白里 —— 不另开文件、不单独汇报、只写进脚本。",
        ),
    );
    L.push("- " + t("最后才决定怎么演：拿这几句话去铺页（页数 / 顺序 / 哪页上公式、哪页上三维），没想清楚的那一页就别硬凑。"));
    L.push("");
    L.push("- " + t("工作目录") + "：`" + root + "`");
    L.push("- " + t("要写的文件（唯一）") + "：`" + rel + "`");
    L.push("- " + t("演示名") + "：`" + slug + "`（" + String((deck && deck.title) || "") + "）");
    L.push("");
    L.push(t("这份演示是讲给谁听的（用户填的 brief，原样照做，别自己另设一套）："));
    if (!b || Ck.briefIsDefault(b)) {
      L.push("- " + t("用户没填：按「第一次听这个课题的人也能跟上」的默认口径写，别堆术语与缩写。"));
    } else {
      if (b.audience) L.push("- " + t("受众") + "：" + b.audience);
      if (b.occasion) L.push("- " + t("场合") + "：" + b.occasion);
      if (b.tone) L.push("- " + t("语气") + "：" + b.tone);
      if (b.focus && b.focus.length) L.push("- " + t("重点讲透") + "：" + b.focus.join("、"));
      if (b.extra) L.push("- " + t("额外指示") + "：" + String(b.extra).replace(/\n/g, "\n  "));
    }
    L.push("");
    /* 展示风格：选定档给它的执行指示；auto 给内核 resolveStyle 的判定口径（按页上的字判，确定性） */
    const styleId = String((b && b.style) || "auto");
    const styleLabel = (Ck && Ck.SLIDE_STYLE_LABEL && Ck.SLIDE_STYLE_LABEL[styleId]) || styleId;
    L.push(t("这份演示怎么「演」（展示风格：只管视觉动势与节奏，不改变要讲的内容）："));
    if (styleId === "auto") {
      L.push(
        "- " +
          t(
            "用户没选（自动）：由内容定 —— 公式与术语多 → 学术；数字与对比多 → Motion Graphics；层级与续页多 → 2.5D；空间关系多 → 3D；拿不准就按学术写（最不会把内容演坏）。写的时候把对应的特征写足，别四种混着来。",
          ),
      );
    } else {
      L.push("- " + t("用户选的是") + "：" + styleLabel);
      for (const line of RS_SLIDE_STYLE_BRIEF[styleId] || []) L.push("  - " + t(line));
    }
    L.push(
      "- " +
        t(
          "风格服从内容，不是套模板：材料撑不起这套演法（比如没有可比数字却要 Motion Graphics）就按学术那套克制地讲 —— 绝不为了风格编数字、硬拆页或堆装饰。",
        ),
    );
    L.push("");
    L.push(t("用户这一轮的补充要求（原话，可能为空）："));
    L.push(want ? want.replace(/\n/g, "\n  ") : "- " + t("（空）按上面的 brief 自主创作。"));
    L.push("");
    L.push(t("可以读的参考（只读）："));
    L.push("- " + t("`notes/*.md`（含三份 3-Pass 变体与 `notes/cites/*.md` 的引文）：事实、术语、公式的第一来源。"));
    L.push("- " + t("`literature/library.json`（CSL-JSON）：核对作者年份与引用键；只引用库里真有的条目。"));
    L.push(
      "- " +
        (online
          ? t(
              "允许联网查证与补料：遇到材料讲不清的术语、公式推导、最新进展可以查，但**每一条外部信息都要给出处**（标题 + 链接 + 访问日期）。",
            )
          : t("这一轮不联网：只用工作目录里已有的材料，查不到就不写。")),
    );
    L.push("");
    if (online) {
      L.push(t("联网补来的新内容不许混进笔记正文，按下面这样另存成衍生笔记（内核与图谱都按这个约定认）："));
      L.push("- " + t("文件") + "：`notes/" + slug + ".explain.md`（术语解释 / 背景补充）");
      L.push("- " + t("开头必须是 frontmatter：") + "`---`、" + "`title: …`、" + "`derived: true`、" + "`of: <被解释的笔记路径>`、" + "`sources:`（每行一条 `- 标题 | 链接 | YYYY-MM-DD`）、`---`");
      L.push("- " + t("正文里每个外部事实后面带 `[@cite]`，与 sources 里的条目同名；没出处的句子一律不写。"));
      L.push("- " + t("脚本页里引用这条新内容时，在要点末尾写 `[@cite]`，不要把链接塞进正文。"));
      L.push("");
    }
    L.push(t("脚本格式（严格照此写，宿主按它逐行解析；写歪了就编不出页）："));
    L.push("```");
    L.push("# " + t("演示标题（只一行）"));
    L.push("");
    L.push("## 01 " + t("这一页的标题"));
    L.push("> " + t("可选的副标题/眉题（一句话，紧跟在标题下面）"));
    L.push("- " + t("要点一（≤ 22 字，3–5 条）"));
    L.push("- " + t("要点二"));
    L.push("$$ \\mathrm{softmax}(QK^\\top/\\sqrt{d}) V $$");
    L.push("> " + t("可选：一句引文 —— 作者，年份"));
    L.push(t("旁白：这一页要讲的一到两句（≤ 60 字，直接念得出来）"));
    L.push("<!-- scene: orbit -->");
    L.push("```");
    L.push(t("逐条规矩："));
    L.push("- " + t("`#` 只有一行（整份演示的标题）；每页用 `## 序号 标题` 起一节，序号从 01 起。"));
    L.push("- " + t("副题 `> ` 只在页首出现一次；引文也写 `> `，但放在要点之后（宿主按位置判断哪个是哪个）。"));
    L.push("- " + t("公式用 `$$ … $$` 一行写完，TeX 源码；不确定的就别写，宁可用文字说。"));
    L.push("- " + t("旁白写 `旁白：` 开头，一到两句、≤ 60 字，念出来是人话（不要括号、不要破折号、不要缩写堆叠）。"));
    L.push("- " + t("`<!-- scene: orbit -->` 可选，只有这一页真的适合用三维几何讲时才加：`orbit` = 层级/系统/围绕关系，`grid` = 空间/结构/高低对比，`signal` = 波/传播/序列。全片最多 4 页。"));
    L.push("- " + t("页数 8–14 页：第一页封面（`## 01`），最后一页收束（结论 / 要记住的三件事）；中间每页只讲一件事。"));
    L.push("- " + t("不许编造：数字、结论、引文、文献都必须在材料里有出处；不确定的地方写成「材料没讲清」，不要补一个看起来合理的答案。"));
    L.push("");
    L.push(t("除了上面那个脚本文件与（联网时）那一份 explain 笔记，别的文件一律不写、不改、不新建。"));
    L.push(
      t("这一轮就是全部：脚本与（联网时）`notes/") +
        slug +
        t(".explain.md` 都在这一轮一次写完，写完就停手 —— 不要回问、不要等第二轮、不要把剩下几页留到下一轮。宿主会自动接着把脚本编成演示页并出视频。"),
    );
    L.push(t("写完只回一句话：多少页、讲了哪几件事。"));
    return L.join("\n");
  }
  /* 采纳脚本：读盘重算 deck（rsDeckLoad 认 slides/<slug>.script.md），再把编辑器那块换掉 */
  async function rsSlidesScriptAdopt(slug, rel, parsed) {
    const D = rsDeck();
    D.deck = null;
    const fresh = await rsDeckLoad(true);
    if (!fresh) return null;
    if (D.ctrl && typeof D.ctrl.setDeck === "function") {
      D.ctrl.setDeck(fresh);
      D.ctrl.raise();
    } else {
      await rsSlidesOpen();
    }
    toastSafe(t("演示脚本已落盘（") + String((parsed && parsed.pages ? parsed.pages.length : 0)) + t(" 页）：") + rel);
    /* 一轮到此收尾：脚本就是这一轮的终点，接着自动出片（brief.mode ≠ slides 才出，见 rsSlidesAutoVideo） */
    rsSlidesAutoVideo(fresh);
    return fresh;
  }
  /* 盯脚本文件：两拍字节一样才算写完 → 内核 parseScript 过一遍 → 编成 deck。
     格式不对就用同一条会话回一句让它修（只一次），再不对才报错 —— 与 rewrite 那条同一套自救口径。 */
  function rsSlidesWatchScript(abs, rel, slug, sessionId) {
    const Ck = rsSlidesCoreMod();
    const D = rsDeck();
    if (D.job && D.job.timer) clearInterval(D.job.timer);
    const job = {
      timer: null,
      last: "",
      seen: "",
      stable: 0,
      round: 0,
      rel: String(rel || ""),
      startedAt: Date.now(),
      sessionId: String(sessionId || ""),
      retried: false,
      kind: "script",
    };
    D.job = job;
    let ticks = 0;
    const stop = () => {
      if (job.timer) clearInterval(job.timer);
      job.timer = null;
      if (D.job === job) D.job = null;
    };
    job.timer = setInterval(() => {
      ticks += 1;
      readText(abs)
        .then((txt) => {
          if (D.job !== job) return;
          const s = String(txt || "");
          if (!s.trim()) {
            if (ticks * 1200 >= RS_SLIDES_WAIT_MS) {
              stop();
              rsSlidesAgentStatus("");
              toastSafe(t("还没等到演示脚本：") + rel + t("（会话可能没写盘；想再来一次就再点一次「按指示创作」）"), "warn");
            }
            return;
          }
          if (s !== job.last) {
            job.last = s;
            job.stable = 0;
            return;
          }
          job.stable += 1;
          if (job.stable < 2 || s === job.seen) return;
          job.seen = s;
          const parsed = Ck && typeof Ck.parseScript === "function" ? Ck.parseScript(s, { path: rel }) : null;
          if (!parsed || !parsed.ok || !(parsed.pages || []).length) {
            const why = (parsed && (parsed.error || "")) || t("没有解析出任何页（缺 `## 序号 标题` 分节？）");
            const S = rsSessionApi();
            if (!job.retried && job.sessionId && S && typeof S.send === "function") {
              job.retried = true;
              try {
                S.send(
                  t("上一轮写的 ") +
                    rel +
                    t(" 用不了：") +
                    why +
                    t("。请按提示词里的格式重写这同一个文件（同一个路径、覆盖写），写完只回一句话。"),
                  job.sessionId,
                );
              } catch (_) {}
              toastSafe(t("脚本格式对不上，已回它一句让它修（只重试这一次）"), "warn");
              return;
            }
            stop();
            rsSlidesAgentStatus("");
            toastSafe(t("演示脚本还是不能用：") + why, "err");
            return;
          }
          stop();
          rsSlidesAgentStatus("");
          void rsSlidesScriptAdopt(slug, rel, parsed);
        })
        .catch(() => {});
    }, 1200);
  }
  /* 派活：清空交付文件 → 交给现有会话 → 盯它写出脚本 */
  async function rsSlidesScriptAsk(deck, brief, online, memo) {
    const Ck = rsSlidesCoreMod();
    if (!Ck || !RS.root) return null;
    const D = rsDeck();
    const slug = String((deck && deck.slug) || D.slug || "slides");
    const rel = rsSlidesScriptRel(slug);
    const abs = joinP(RS.root, rel);
    if (!rsSlidesTokenAcked && typeof confirmDialog === "function") {
      const go = await confirmDialog(
        t("将派一条 Agent 会话，让它按你的指示创作整份演示脚本（会消耗 Token，可能要等一两分钟）。继续吗？"),
        { title: t("按指示创作演示"), okText: t("派给会话"), cancelText: t("取消"), defaultCancel: true },
      );
      if (!go) return null;
      rsSlidesTokenAcked = true;
    }
    let sid = "";
    try {
      const prompt = rsSlidesScriptPrompt(deck, brief, online, memo);
      await window.api.fileWriteText(abs, "");
      sid = await rsSlidesDispatch(prompt);
    } catch (e) {
      toastSafe(t("派活失败：") + String((e && e.message) || e), "err");
      return null;
    }
    toastSafe(t("已派给会话，等它写出 ") + rel + "…");
    rsSlidesAgentStatus(rsSlidesWaitText(rel, 1));
    rsSlidesWatchScript(abs, rel, slug, sid);
    return rel;
  }
  function rsSlidesRewritePrompt(scope, page, rel, memo) {
    const Ck = rsSlidesCoreMod();
    const D = rsDeck();
    const deck = D.deck || {};
    const root = String(RS.root || "").replace(/\\/g, "/");
    const slug = String(deck.slug || D.slug || "slides");
    const all = (deck.pages || []).filter((p) => !p.hidden);
    const pick = scope === "page" && page ? [page] : all;
    /* brief：deck 上那份（D.brief 是读盘时算好的），没有就是全默认 */
    const brief = Ck.normalizeBrief(D.brief || Ck.briefOf(deck));
    /* 用户这一轮的原话：可空；换行保留，长度与 brief.extra 同一量级 */
    const want = String(memo == null ? "" : memo)
      .replace(/\r\n?/g, "\n")
      .trim()
      .slice(0, 2000);
    const L = [];
    L.push(t("你要把一份研究演示（PPT）的讲稿改写得更适合当面讲：一页只说一件事、每条要点一句话、去掉论文腔与朗读不出来的符号。"));
    L.push(t("这是一次可以反复来的改写：每一轮只做这一轮要改的事，改完就停手等下一轮。"));
    L.push("");
    L.push("- " + t("工作目录") + "：`" + root + "`");
    L.push("- " + t("要写的文件（唯一）") + "：`" + rel + "`");
    L.push("- " + t("演示名") + "：`" + slug + "`（" + String(deck.title || "") + "）");
    L.push("");
    L.push(t("这份演示是讲给谁听的（用户填的 brief，原样照做，别自己另设一套）："));
    if (Ck.briefIsDefault(brief)) {
      L.push("- " + t("用户没填：按「第一次听这个课题的人也能跟上」的默认口径改，别堆术语与缩写。"));
    } else {
      if (brief.audience) L.push("- " + t("受众") + "：" + brief.audience);
      if (brief.occasion) L.push("- " + t("场合") + "：" + brief.occasion);
      if (brief.tone) L.push("- " + t("语气") + "：" + brief.tone);
      if (brief.focus && brief.focus.length) L.push("- " + t("重点讲透") + "：" + brief.focus.join("、"));
      if (brief.extra) L.push("- " + t("额外指示") + "：" + brief.extra.replace(/\n/g, "\n  "));
    }
    L.push("");
    L.push(t("用户这一轮想怎么改（原话，可能为空）："));
    L.push(want ? want.replace(/\n/g, "\n  ") : "- " + t("（空）没有额外要求：按下面的原页把该改的改好。"));
    L.push("");
    L.push(t("可以读的参考（只读，一个字都不许改）："));
    L.push(
      "- " +
        t(
          "`notes/*.md`（含 `notes/cites/*.md` 里的引文）：需要核对原文、补上下文、确认一句话原本怎么说时读它。",
        ),
    );
    L.push(
      "- " +
        t(
          "`literature/library.json`（CSL-JSON 文献库）：需要核对引文出处、作者年份、引用键时读它；只引用库里真有的条目。",
        ),
    );
    L.push("- " + t("除了上面那个要写的文件，别的文件一律不写、不改、不新建。"));
    L.push("");
    L.push(t("硬性要求："));
    L.push(
      "- " +
        (scope === "page"
          ? t("只重写下面列出来的这一页：文件里的 pages 只放这一页，其它页一个都不许出现。")
          : want
            ? t(
                "这一轮按用户那句话改：文件里的 pages 只放这一轮真改过的页（宿主按页 id 合并，没写的页保持原样），别顺手把整份重写一遍。",
              )
            : t("整份都重写：文件里的 pages 覆盖下面列出的每一页，一页都不许漏、也不许新增。")),
    );
    L.push("- " + t("页 id 原样照抄，一个字都不许改（改了就对不上页，宿主管不了手改）。"));
    L.push("- " + t("不许编：不新增数字、结论、引文与文献；只能压缩、重排、换更清楚的说法。原文没说的，一个字都别加。"));
    L.push("- " + t("每条要点 ≤ 60 字、一页最多 5 条；标题 ≤ 24 字；讲者备注 2–3 句，写「这一页要讲什么」。"));
    L.push(
      "- " +
        t(
          '输出格式：UTF-8、合法 JSON、不要 Markdown 围栏 —— {"pages":[{"id":"原样照抄","title":"…","kicker":"…","bullets":["…"],"quote":"…","note":"…"}]}',
        ),
    );
    L.push("");
    L.push(t("需要改写的页（id / 现在的内容）："));
    for (const pg of pick) {
      L.push("- id: " + String(pg.id || "") + " | " + String(pg.kind || "") + " | " + String(pg.title || ""));
      if (pg.kicker) L.push("  眉题：" + String(pg.kicker));
      const bs = Array.isArray(pg.bullets) ? pg.bullets : [];
      for (const b of bs) L.push("  · " + String(b || ""));
      if (pg.quote) L.push("  引用：" + String(pg.quote));
      if (pg.note) L.push("  备注：" + String(pg.note));
      if (pg.src && pg.src.path) L.push("  出处：" + String(pg.src.path) + ":" + String(pg.src.line || 1));
    }
    L.push("");
    L.push(t("这一轮就到这里：把该写的写进上面那个文件，然后停手 —— 不要顺手改别的页、不要改页结构（新增 / 删页 / 换页序 / 显隐都不归你）。"));
    L.push(t("写完后只回一句话：这一轮改了哪几页、每页改了什么。下一轮我会带新的「想怎么改」再来，改写同一个文件即可。"));
    return L.join("\n");
  }
  /* 派活：复用研究目录里那一条「重写演示」会话（没有才新建），与 rsMissingOpen 同一套薄适配 */
  async function rsSlidesDispatch(prompt) {
    const S = rsSessionApi();
    if (typeof S.send !== "function" || typeof S.create !== "function")
      throw new Error(t("会话模块没加载（agent 会话不可用）"));
    let st = rsMissSession(S, RS.root, t("重写演示"));
    if (!st) {
      st = S.create();
      if (!st) throw new Error(t("新建会话失败"));
      st.title = t("重写演示") + " · " + String((RS.meta && RS.meta.title) || "研究演示");
      st.titleLocked = true;
      st.titleAuto = false;
      st.canvasWfId = String(RS.wfId || "") || st.canvasWfId;
      try {
        if (S.setWorkspace) await S.setWorkspace(st, RS.root);
      } catch (_) {}
      try {
        if (S.persist) await S.persist();
        if (S.sidebar) await S.sidebar();
      } catch (_) {}
    }
    S.send(prompt, st.id);
    return st.id;
  }
  /* 模型重写（这一页 / 整份）：先确认「会消耗 Token」→ 清空交付文件 → 派会话 → 盯着它落盘。
     memo = 用户这一轮「想怎么改」的原话（可空）：只进提示词，决定这一轮改哪些页。
     opts.acked = 调用方已经确认过 Token（编辑器那颗小输入框，第一次派活时按钮上就写着「会消耗 Token」）——
     这时不再叠一张宿主确认窗：编辑器的幕布 z-index（9995）高于 #mtDialog（2400），弹出来也看不见。 */
  async function rsSlidesRewrite(scope, pageHint, memo, opts) {
    const Ck = rsSlidesCoreMod();
    if (!Ck || !RS.root) return null;
    if (!rsSlidesCoreNote()) {
      toastSafe(t("还没有核心稿件：先投料或新建一篇原文，再做演示"), "warn");
      return null;
    }
    const deck = await rsSlidesEnsureDeck();
    if (!deck) return null;
    const page = pageHint || rsSlidesPageTarget();
    if (scope === "page" && !page) {
      toastSafe(t("没有可重写的页"), "warn");
      return null;
    }
    const acked = !!(opts && opts.acked);
    if (!acked && !rsSlidesTokenAcked && typeof confirmDialog === "function") {
      const ok = await confirmDialog(
        scope === "page"
          ? t("将派一条 Agent 会话，让模型重写「") +
              String(page.title || "") +
              t("」这一页（会消耗 Token，可能要等几十秒）。继续吗？")
          : t("将派一条 Agent 会话，让模型重写整份演示（会消耗 Token，可能要等几十秒）。继续吗？"),
        { title: t("模型重写演示"), okText: t("派给会话"), cancelText: t("取消"), defaultCancel: true },
      );
      if (!ok) return null;
      /* 确认过就不再拦：后面每一轮都是同一条会话上的迭代 */
      rsSlidesTokenAcked = true;
    }
    const D = rsDeck();
    const rel = String(Ck.STORE_DIR) + "/" + String(D.slug || deck.slug || "slides") + ".rewrite.json";
    const abs = joinP(RS.root, rel);
    let sid = "";
    try {
      const prompt = rsSlidesRewritePrompt(scope, page, rel, memo);
      /* 上一轮留下的交付文件先清空：不然「盯着落盘」会立刻把旧内容当成新结果 */
      await window.api.fileWriteText(abs, "");
      sid = await rsSlidesDispatch(prompt);
    } catch (e) {
      toastSafe(t("派活失败：") + String((e && e.message) || e), "err");
      return null;
    }
    toastSafe(t("已派给会话，等它写出 ") + rel + "…");
    /* 状态行报「等第几轮」与超时口径（编辑器开着才写，关着就只靠 toast） */
    rsSlidesAgentStatus(rsSlidesWaitText(rel, 1));
    /* sid 一起带下去：结果对不上时要用同一条会话回话让它修 */
    rsSlidesWatch(abs, rel, scope, sid);
    return rel;
  }
  /* 模型交回来的东西不能用（不是合法 JSON / 没有 pages / 页 id 全对不上）时的自救：
     用同一条会话自动回一句「按原样重写这个文件」；只额外给 1 次机会，再不行才报错。
     返回 true = 已经把话递出去了（调用方就别再弹错了）。 */
  function rsSlidesRepairAsk(job, rel, why) {
    if (!job || job.retried) return false;
    const sid = String(job.sessionId || "");
    const S = rsSessionApi();
    if (!sid || typeof S.send !== "function") return false;
    job.retried = true;
    try {
      S.send(
        t("上一轮写出的 ") +
          rel +
          t(" 用不了：") +
          why +
          t("。请按提示词里的格式重写这同一个文件（同一个路径、覆盖写，页 id 原样照抄），写完只回一句话。"),
        sid,
      );
    } catch (_) {
      return false;
    }
    toastSafe(t("模型写出的结果对不上，已回它一句让它修（只重试这一次）"), "warn");
    return true;
  }
  /* 盯交付文件：会话是异步写盘的，连着两拍字节一样才算写完（与 rsMissWatch 同一口径）。
     合成之后**不停**：同一份文件继续盯下一轮写入（多轮迭代，用户下一句「想怎么改」会再写一次它）；
     合过的那一版（job.seen）不再重复合；每合一轮重新计时，久等不来不直接判失败，问用户【继续等 / 放弃】。 */
  function rsSlidesWatch(abs, rel, scope, sessionId) {
    const D = rsDeck();
    if (D.job && D.job.timer) clearInterval(D.job.timer);
    const job = {
      timer: null,
      last: "",
      seen: "",
      stable: 0,
      round: 0, /* 已经合进来的轮次（状态行「等第 N 轮」= round + 1） */
      rel: String(rel || ""), /* 交付文件（编辑器重开时用它把状态行补回去） */
      startedAt: Date.now(),
      busy: false,
      retried: false,
      sessionId: String(sessionId || ""),
    };
    D.job = job;
    const stop = () => {
      if (job.timer) clearInterval(job.timer);
      job.timer = null;
      if (D.job === job) D.job = null;
    };
    /* 超时：不再直接判失败，弹一次窗口问到底还等不等 */
    const askMoreWait = async () => {
      const mins = Math.max(1, Math.round(RS_SLIDES_WAIT_MS / 60000));
      if (typeof confirmDialog !== "function") {
        stop();
        toastSafe(t("超时：会话没有写出 ") + rel + t("（去左栏那条「重写演示」会话看它卡在哪）"), "err");
        return;
      }
      let more = false;
      /* 弹窗前先把状态行改成「等你决定」，免得状态行还挂着「等第 N 轮」 */
      rsSlidesAgentStatus("已经等了 " + mins + " 分钟：等你选【继续等 / 放弃】");
      try {
        more = await confirmDialog(
          t("已经等了 ") +
            mins +
            t(" 分钟，会话还没写出 ") +
            rel +
            t("。要继续等吗？（选「放弃」就收工，去左栏那条「重写演示」会话看它卡在哪）"),
          { title: t("还在等模型"), okText: t("继续等"), cancelText: t("放弃"), defaultCancel: false },
        );
      } catch (_) {
        more = false;
      }
      if (D.job !== job) return;
      if (more) {
        job.startedAt = Date.now();
        toastSafe(t("继续等 ") + rel + t("…"));
        rsSlidesAgentStatus(rsSlidesWaitText(rel, job.round + 1));
      } else {
        stop();
        toastSafe(t("已放弃：会话没有写出 ") + rel, "warn");
        rsSlidesAgentStatus("已放弃：第 " + String(job.round + 1) + " 轮没写出 " + rel);
      }
    };
    const tick = async () => {
      if (D.job !== job || job.busy) return;
      job.busy = true;
      try {
        const txt = await readText(abs).catch(() => "");
        if (D.job !== job) return;
        if (String(txt || "").trim()) {
          if (txt !== job.last) {
            job.last = txt;
            job.stable = 0;
          } else {
            job.stable++;
          }
          /* 稳 2 拍 = 这一轮写完（半成品刷页也就挡住了）；合过的同一版不再合第二遍 */
          if (job.stable >= 2 && txt !== job.seen) {
            job.seen = txt;
            job.last = txt;
            job.stable = 0;
            const ok = await rsSlidesApplyRewrite(txt, rel, scope, job);
            if (D.job !== job) return;
            if (ok === false) {
              /* 这一版用不了（已自动回它一句让它修）：仍按同一轮继续等下一版，状态行说清楚 */
              rsSlidesAgentStatus("等第 " + String(job.round + 1) + " 轮：上一版不能用，已让它重写同一份文件");
            } else {
              job.round += 1;
              rsSlidesAgentStatus(
                "第 " +
                  String(job.round) +
                  " 轮已合入；继续等第 " +
                  String(job.round + 1) +
                  " 轮写出（同一份文件再写一次即可）",
              );
            }
            job.startedAt = Date.now(); /* 这一轮收下了：下一轮从头计时 */
          }
          return;
        }
        if (Date.now() - job.startedAt > RS_SLIDES_WAIT_MS) await askMoreWait();
      } finally {
        job.busy = false;
      }
    };
    job.timer = setInterval(() => {
      tick().catch(() => {});
    }, 1500);
    tick().catch(() => {});
  }
  /* ── 模型改写前的快照 + 「撤销这次模型改写」 ────────────────────────────────
     模型改写的落点就是 patch（手改全在里面），覆盖之前先把**当前** patch 原样存成
     slides/<slug>.pre-agent-<时间戳>.json；只留最近 5 份，多的删旧。
     写盘只走 window.api.fileWriteText（与 rsDeckSave 同一个入口，不开第二条写盘路径）。 */
  const RS_SLIDES_SNAP_KEEP = 5;
  function rsSlidesSnapStamp(d) {
    const x = d instanceof Date ? d : new Date();
    const p2 = (n) => String(n).padStart(2, "0");
    return (
      String(x.getFullYear()) +
      p2(x.getMonth() + 1) +
      p2(x.getDate()) +
      "-" +
      p2(x.getHours()) +
      p2(x.getMinutes()) +
      p2(x.getSeconds()) +
      "-" +
      String(x.getMilliseconds()).padStart(3, "0")
    );
  }
  function rsSlidesSnapDir() {
    const Ck = rsSlidesCoreMod();
    return Ck ? String(Ck.STORE_DIR) : "slides";
  }
  /* 一份演示的快照清单（新 → 旧）：文件名里是定宽时间戳，字典序就是时间序 */
  async function rsSlidesSnapList(slug) {
    if (!RS.root || !window.api || typeof window.api.fileReadDir !== "function") return [];
    const dir = rsSlidesSnapDir();
    const name = String(slug || "slides");
    const re = new RegExp(
      "^" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\.pre-agent-[0-9-]+\\.json$",
      "i",
    );
    const r = await window.api.fileReadDir(joinP(RS.root, dir)).catch(() => null);
    const out = [];
    for (const e of (r && r.entries) || []) {
      if (!e || e.isDir || !re.test(String(e.name || ""))) continue;
      out.push(dir + "/" + e.name);
    }
    out.sort();
    out.reverse();
    return out;
  }
  /* 覆盖前存一份当前 patch；顺手把超出 5 份的旧快照删掉。返回快照相对路径（失败 = null，不挡这次改写） */
  async function rsSlidesSnapshotPreAgent(slug, patch) {
    if (!RS.root || !window.api || typeof window.api.fileWriteText !== "function") return null;
    const Ck = rsSlidesCoreMod();
    const dir = rsSlidesSnapDir();
    const name = String(slug || "slides");
    try {
      if (typeof window.api.fileMkdir === "function") await window.api.fileMkdir(joinP(RS.root, dir)).catch(() => {});
      const rel = dir + "/" + name + ".pre-agent-" + rsSlidesSnapStamp() + ".json";
      const payload = {
        ver: Number(Ck && Ck.VER) || 1,
        slug: name,
        at: Date.now(),
        patch: patch || null,
      };
      const res = await window.api.fileWriteText(joinP(RS.root, rel), JSON.stringify(payload, null, 2));
      if (res && res.ok === false) return null;
      const list = await rsSlidesSnapList(name);
      for (const old of list.slice(RS_SLIDES_SNAP_KEEP)) {
        if (typeof window.api.fileTrash === "function") await window.api.fileTrash(joinP(RS.root, old)).catch(() => {});
      }
      return rel;
    } catch (_) {
      return null;
    }
  }
  /* 撤销这次模型改写：读最近一份快照，把 patch 回写存档（rsDeckSave 唯一落盘口）→ 编辑器换页。 */
  async function rsSlidesUndoRewrite() {
    const Ck = rsSlidesCoreMod();
    if (!Ck || !RS.root) return null;
    const deck = await rsSlidesEnsureDeck();
    if (!deck) return null;
    const D = rsDeck();
    const slug = String(deck.slug || D.slug || "slides");
    const list = await rsSlidesSnapList(slug);
    if (!list.length) {
      toastSafe(t("没有可撤销的快照：这一份演示还没有模型改写记录"), "warn");
      return null;
    }
    let snap = null;
    try {
      snap = JSON.parse(await readText(joinP(RS.root, list[0])));
    } catch (_) {
      snap = null;
    }
    if (!snap || typeof snap !== "object") {
      toastSafe(t("快照读不出来：") + list[0], "err");
      return null;
    }
    const patch = Ck.normalizePatch(snap.patch);
    const next = Ck.applyPatch(deck, patch);
    D.deck = next;
    await rsDeckSave({ deck: next, patch: patch, theme: next.theme });
    if (D.ctrl && typeof D.ctrl.setDeck === "function") D.ctrl.setDeck(next);
    toastSafe(t("已撤销这次模型改写：回到 ") + String(list[0].split("/").pop()));
    rsSlidesAgentStatus("已撤销这次模型改写（回到 " + String(list[0].split("/").pop()) + "）");
    return list[0];
  }
  /* 模型写回来的 {pages:[…]} → 合并进 patch.overlay（只认 deck 里真有的页 id）→ 落盘 → 编辑器换页。
     用不了（不是 JSON / 没有 pages / 页 id 全对不上）先在同一条会话里回一句让它修，只重试 1 次。
     返回 true = 这一轮合进去了；false = 这一版不能用（调用方据此报「等第几轮」）。 */
  async function rsSlidesApplyRewrite(txt, rel, scope, job) {
    const Ck = rsSlidesCoreMod();
    const D = rsDeck();
    if (!Ck || !D.deck) return false;
    let data = null;
    try {
      data = JSON.parse(String(txt || ""));
    } catch (_) {
      if (rsSlidesRepairAsk(job, rel, t("不是合法 JSON（多余的解释或 Markdown 围栏都不行）"))) return false;
      toastSafe(t("模型写出的演示文稿不是合法 JSON：") + rel, "err");
      return false;
    }
    const list = Array.isArray(data && data.pages) ? data.pages : Array.isArray(data) ? data : null;
    if (!list || !list.length) {
      if (rsSlidesRepairAsk(job, rel, t("JSON 里没有 pages 数组"))) return false;
      toastSafe(t("模型写出的演示文稿里没有 pages：") + rel, "err");
      return false;
    }
    const patch = Ck.normalizePatch(D.deck.patch);
    /* 改之前的 patch 先抄一份：合并循环是就地改 patch，晚了就抄不到原样了 */
    let before = null;
    try {
      before = JSON.parse(JSON.stringify(patch));
    } catch (_) {
      before = null;
    }
    const known = Object.create(null);
    for (const p of D.deck.pages || []) known[String(p.id)] = p;
    let n = 0;
    for (const it of list) {
      const id = String((it && it.id) || "");
      if (!id || !known[id]) continue;
      const one = Object.assign({}, patch.overlay[id] || {});
      const keys = Array.isArray(Ck.EDIT_KEYS) && Ck.EDIT_KEYS.length ? Ck.EDIT_KEYS : ["title", "kicker", "bullets", "quote", "note", "layout"];
      for (const k of keys) {
        if (!it || it[k] == null) continue;
        if (k === "bullets") {
          one.bullets = (Array.isArray(it.bullets) ? it.bullets : [it.bullets])
            .map((x) => String(x == null ? "" : x).trim())
            .filter(Boolean)
            .slice(0, Number(Ck.MAX_BULLETS) || 5);
        } else if (k === "layout") {
          const l = String(it.layout || "").trim();
          if ((Ck.LAYOUTS || []).indexOf(l) >= 0) one.layout = l;
        } else one[k] = String(it[k] == null ? "" : it[k]);
      }
      patch.overlay[id] = one;
      n++;
    }
    if (!n) {
      if (rsSlidesRepairAsk(job, rel, t("pages 里的页 id 一个都对不上，要原样照抄提示词里列出的那些 id")))
        return false;
      toastSafe(t("模型写出的页 id 一个都对不上：演示没有改动"), "warn");
      return false;
    }
    /* 真要覆盖了：先把当前 patch 存成快照（撤销这次模型改写就靠它） */
    await rsSlidesSnapshotPreAgent(D.slug || D.deck.slug || "slides", before);
    const next = Ck.applyPatch(D.deck, patch);
    D.deck = next;
    await rsDeckSave({ deck: next, patch: patch, theme: next.theme });
    if (D.ctrl && typeof D.ctrl.setDeck === "function") D.ctrl.setDeck(next);
    if (job) job.retried = false; /* 这一轮合上了：下一轮又能重试一次 */
    toastSafe(t("模型重写已合进演示：改了 ") + n + t(" 页"));
    return true;
  }
  /* ── 顶栏「演示」那颗图标的菜单（persistent：只走窗内 ✕ / Esc / 再点同一颗）──
     三件事都摆在同一处：打开编辑器（内核直出）、让 Agent 重写整份 / 这一页
     （先开编辑器收一句「这次想怎么改」，首次派活才确认「会消耗 Token」）。 */
  function rsSlidesMenuClose() {
    if (!rsSlidesMenuEl) return;
    document.removeEventListener("keydown", rsSlidesMenuEl._rsKey, true);
    rsSlidesMenuEl.remove();
    rsSlidesMenuEl = null;
    rsSlidesMenuAnchor = null;
    const p = rsSlidesMenuPaint;
    rsSlidesMenuPaint = null;
    if (p) p();
  }
  function rsSlidesMenu(anchor, paintBtn) {
    if (rsSlidesMenuEl && rsSlidesMenuAnchor === anchor) return rsSlidesMenuClose();
    rsSlidesMenuClose();
    rsFsMenuClose();
    if (typeof closeNodePopsExcept === "function") closeNodePopsExcept("");
    const box = el("div", "rs-ask rs-deck-menu");
    const host = pane();
    if (host && host.classList.contains("rs-light")) box.classList.add("rs-light");
    box.innerHTML =
      '<div class="rs-ask-head"><b>' +
      esc(t("演示")) +
      '</b><button class="rs-ask-x" type="button" title="' +
      esc(t("关闭")) +
      '">✕</button></div>' +
      '<div class="rs-deck-menu-stat"></div>' +
      '<div class="rs-deck-menu-list"></div>';
    document.body.appendChild(box);
    const r = anchor.getBoundingClientRect();
    const w = box.offsetWidth || 248;
    box.style.left = Math.max(12, Math.min(window.innerWidth - w - 12, r.right - w)) + "px";
    box.style.right = "auto";
    box.style.top = Math.min(window.innerHeight - 60, r.bottom + 6) + "px";

    const stat = box.querySelector(".rs-deck-menu-stat");
    const list = box.querySelector(".rs-deck-menu-list");
    const item = (label, hint, fn, disabled) => {
      const b = el("button", "rs-deck-menu-btn");
      b.type = "button";
      b.appendChild(el("b", "rs-deck-menu-lab", label));
      if (hint) b.appendChild(el("span", "rs-deck-menu-hint", hint));
      b.disabled = !!disabled;
      b.onclick = () => {
        if (b.disabled) return;
        rsSlidesMenuClose();
        Promise.resolve()
          .then(fn)
          .catch((e) => toastSafe(String((e && e.message) || e), "err"));
      };
      list.appendChild(b);
      return b;
    };
    const btnOpen = item(t("打开演示编辑器"), t("内核直出 · 不花 Token"), () => rsSlidesOpen());
    /* 这两颗与编辑器里的按钮走同一套：开编辑器 → 收一句「这次想怎么改」→ 派活（首次才确认 Token） */
    const btnAll = item(t("让 Agent 重写整份…"), t("先写一句想怎么改 · 会消耗 Token"), () => rsSlidesAgentAsk("all"));
    const btnOne = item(
      t("让 Agent 重写这一页…"),
      t("先写一句想怎么改 · 会消耗 Token"),
      () => rsSlidesAgentAsk("page"),
      true,
    );

    /* 摘要要等 deck 读进来：先画一版「读取中…」，读到再补一遍（按钮一直可点，别让面板空等） */
    const paintStat = () => {
      const D = rsDeck();
      const deck = D.deck;
      if (!deck) {
        stat.textContent = t("正在读取演示…");
        return;
      }
      const pages = deck.pages || [];
      const hidden = pages.filter((p) => p.hidden).length;
      let edits = 0;
      const Ck = rsSlidesCoreMod();
      try {
        const patch = Ck ? Ck.normalizePatch(deck.patch) : null;
        edits = patch ? Object.keys(patch.overlay || {}).length : 0;
      } catch (_) {
        edits = 0;
      }
      const page = rsSlidesPageTarget();
      stat.textContent =
        pages.length + t(" 页") + (hidden ? " · " + t("隐藏 ") + hidden : "") + " · " + t("手改 ") + edits + t(" 处");
      btnOne.disabled = !page;
      btnOne.title = page ? t("这一页：") + String(page.title || "") : t("没有可重写的页");
    };
    paintStat();
    void rsSlidesEnsureDeck()
      .then(() => paintStat())
      .catch(() => {});

    rsSlidesMenuEl = box;
    rsSlidesMenuAnchor = anchor;
    rsSlidesMenuPaint = paintBtn || null;
    const onKey = (ev) => {
      if (ev.key !== "Escape") return;
      ev.stopPropagation();
      rsSlidesMenuClose();
    };
    box._rsKey = onKey;
    document.addEventListener("keydown", onKey, true);
    box.querySelector(".rs-ask-x").onclick = () => rsSlidesMenuClose();
    if (paintBtn) paintBtn();
    return box;
  }
  /* 树上右键「生成演示…」：只在有 core 稿件时给（判据与顶栏那颗图标同一份） */
  function rsSlidesCanOpen() {
    return !!RS.root && rsSlidesReady();
  }

  window.MTResearch = {
    enter,
    reload: rsReloadAll,
    onCanvasChanged,
    onAuthChanged,
    userIsOwner,
    state: RS,
    buildGraph: rsBuildGraph,
    /* 工具行重画（队列 / 同步数据在别处变了以后，让顶栏那两颗 toggle 跟上） */
    paintTop: renderTop,
    /* 同步引擎实例（它自己也管读盘缓存）：需要让顶栏跟上 sync.json 变化时先清缓存再 paintTop */
    syncEngine: () => rsSync(),
    undo: rsUndo,
    redo: rsRedo,
    paintSide,
    dropIntoPanel,
    /* 写入口的闸（金色版本优先）：任何走研究目录的写入都该先过它，别各自判一套 */
    writeGate: rsWriteGate,
    goldOf: rsGoldSelf, /* 当前这一篇是不是金色（视图判读） */
    goldSibling: rsGoldSibling, /* 同组里那一份金色版本（按路径查） */
    statusOf: rsStatusOf,
    openInitWizard,
    rootOf,
    /* 运行队列里「生成变体」那行点进来时用：回到研究视图并打开某一篇 */
    openNote: rsOpenNote,
    /* 撤销这次模型改写（读最近一份 pre-agent 快照回写 patch） */
    slidesUndoRewrite: rsSlidesUndoRewrite,
  };

  /* Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y：研究视图里的撤销与重做。
     为什么挂在 document 捕获阶段：焦点常常不在正文源码框里（刚点过工具条 / 左栏），
     那时 app.js 的全局 Ctrl+Z 会把**画布**的撤销跑起来 —— 在研究界面按撤销，
     撤掉的却是背后画布上的节点。这里先吃掉，只在研究面板可见时生效。 */
  let histKeyWired = false;
  function wireHistoryKeys() {
    if (histKeyWired) return;
    histKeyWired = true;
    document.addEventListener(
      "keydown",
      (ev) => {
        const key = String(ev.key || "").toLowerCase();
        if (!(ev.ctrlKey || ev.metaKey) || ev.altKey) return;
        if (key !== "z" && key !== "y") return;
        const p = qid("researchPane");
        if (!p || p.style.display === "none") return;
        /* 盖在研究视图之上的弹窗（确认框 / 提示浮层）自己管撤销 */
        const dlg = qid("mtDialog");
        if (dlg && dlg.classList.contains("on")) return;
        const pop = qid("mtPop");
        if (pop && pop.classList.contains("on")) return;
        /* 其它输入框（会话草稿 / 检索框…）里的撤销归浏览器，只接管正文源码框 */
        const tgt = ev.target && ev.target.nodeType === 1 ? ev.target : null;
        const tag = String((tgt && tgt.tagName) || "").toLowerCase();
        const editable =
          tag === "input" || tag === "textarea" || tag === "select" || !!(tgt && tgt.isContentEditable);
        if (editable && tgt !== RS.srcEl) return;
        ev.preventDefault();
        ev.stopPropagation();
        /* 研究视图还没装载好（闸门 / 引导页）：吃掉按键即可，别落到画布的撤销上 */
        if (!RS.ready) return;
        if (key === "y" || ev.shiftKey) rsRedo();
        else rsUndo();
      },
      true,
    );
  }

  /* 自动接线：脚本加载完就绑定顶栏按钮与登录态监听（不依赖 app-boot 的时序） */
  function autoWire() {
    wireHistoryKeys();
    /* Ctrl+F ＝ 正文内查找（研究视图里先于全局搜索拿到按键） */
    wireFindKeys();
    const btn = qid("btnResearch");
    if (btn && !btn.dataset.wired) {
      btn.dataset.wired = "1";
      btn.onclick = () => {
        if (!userIsOwner()) return;
        if (typeof setView === "function") setView("research");
      };
    }
    researchSyncEntry();
    try {
      if (window.MTNodeAuth && typeof window.MTNodeAuth.onChange === "function") {
        window.MTNodeAuth.onChange(() => researchSyncEntry());
      }
    } catch (_) {}
    /* 启动竞态兜底：auth 模块的首次 refresh 可能是异步的，DOMContentLoaded 时还没回来 ——
       过一秒与三秒各再同步一次（纯显隐，幂等，不做任何写入）。 */
    setTimeout(researchSyncEntry, 1000);
    setTimeout(researchSyncEntry, 3000);
  }
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", autoWire);
  else autoWire();
})();
