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

  const RS = {
    ready: false,
    wfId: "",
    root: "",
    meta: null,
    notes: [], // [{path, title, md, meta, parsed, core}]
    folds: [], // literature/folds/*.md 的三层折叠（只读投影，不进图谱）
    foldPath: "",
    curPath: "",
    md: "",
    /* read = 渲染后的阅读态（默认，不写回 DOM）；edit = 左源码 + 右实时预览。
       为什么不再走 contentEditable 富文本往返：mermaid 代码块被渲染成 SVG 后，
       richToMarkdown 只读得到 SVG 的文字，围栏与语言标记全丢 —— Pele/流程图 一保存就烂掉
       （真机复现：插入流程图后笔记正文变成「是/问题/可分解?」这样的一堆散字）。 */
    editorMode: "read", // read | edit
    mode: "notes", // notes | graph
    graph: null,
    layout: "force",
    lib: [], // CSL-JSON
    sideCollapsed: false,
    /* 会话框收纳（只留一条标题栏；状态跟 research.json 的 ui.chatCollapsed 走） */
    chatCollapsed: false,
    chatDraft: "",
    litOpen: false,
    dirty: false,
    saving: false,
    lastSavedAt: 0,
    booted: false,
    redoStack: [], // 撤销后又想重做的改动（内存里，只活这一次会话）
    /* 投料台两栏的分栏比例（写回 research.json 的 initSplit 字段） */
    split: 0.5,
    /* 三层折叠：1 全文 / 2 关键原句 / 3 主题；>1 时只读（不改文件） */
    foldLevel: 1,
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
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
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
    renderSide();
    renderEditor();
    renderTop();
    if (qid("rsLit")) renderLit();
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
      /* 还没落盘的输入先写掉：否则撤销完，自动保存又把这段输入盖回盘上 */
      await rsSaveCurrent();
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
      await rsSaveCurrent();
      if (!RS.redoStack.length) {
        toastSafe(t("没有可重做的改动"), "warn");
        return false;
      }
      const rec = RS.redoStack.pop();
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
    /* 左栏收纳状态跟着 research.json 走（与画布边栏一样：收起后下次进来还是收起的） */
    RS.sideCollapsed = !!(meta.ui && meta.ui.sideCollapsed);
    RS.chatCollapsed = !!(meta.ui && meta.ui.chatCollapsed);
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
    /* 笔记真源 = notes/（自己写的）+ core/（核心文件转出来的正文）。
       核心文件也是「一切陈述的主体」，要进图谱、能被 [[标题]] 指到，所以一并装载；
       literature/folds/ 不进（那是折叠视图，不是笔记，原文已在核心或笔记里）。 */
    const dirs = ["notes", "core"];
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

    const main = el("div", "rs-main");
    RS.mainEl = main;
    const side = el("aside", "rs-side");
    RS.sideEl = side;
    main.appendChild(side);

    const center = el("div", "rs-center");
    RS.centerEl = center;
    const editorWrap = el("div", "rs-editor-wrap");
    const toolbar = el("div", "rs-toolbar");
    RS.toolbarEl = toolbar;
    editorWrap.appendChild(toolbar);
    const body = el("div", "rs-editor-body");
    RS.bodyEl = body;
    editorWrap.appendChild(body);
    center.appendChild(editorWrap);
    RS.chatEl = el("div", "rs-chat");
    center.appendChild(RS.chatEl);
    main.appendChild(center);

    RS.graphHost = el("div", "rs-graph");
    main.appendChild(RS.graphHost);
    host.appendChild(main);

    RS.gate = el("div", "rs-gate");
    host.appendChild(RS.gate);
  }

  /* 顶栏：画布 / 工作目录只读回显 + 视图切换 + 关键动作 */
  function renderTop() {
    const top = RS.topEl;
    if (!top) return;
    top.innerHTML = "";
    /* 左栏收纳：与画布顶栏那颗边栏按钮同一套手感 —— 一颗小按钮开合，状态记在 research.json */
    const sideBtn = el("button", "rs-top-ico" + (RS.sideCollapsed ? "" : " on"), RS.sideCollapsed ? "▶" : "◀");
    sideBtn.title = RS.sideCollapsed ? t("展开左侧文件栏") : t("收起左侧文件栏");
    sideBtn.onclick = () => toggleSide();
    top.appendChild(sideBtn);
    const wf = curWf();
    const chip = el("span", "rs-chip", (wf ? "画布：" + (wf.name || wf.id) : "未绑定画布"));
    chip.title = t("研究内容绑定当前画布与该画布的工作目录");
    top.appendChild(chip);
    const wsChip = el("span", "rs-chip ghost", "📂 " + (wsDir() || t("未设置工作目录")));
    wsChip.title = wsDir() || t("请先在画布顶栏设置工作目录");
    top.appendChild(wsChip);

    const tabs = el("div", "rs-tabs");
    for (const [v, label] of [
      ["notes", t("笔记")],
      ["graph", t("图谱")],
    ]) {
      const b = el("button", "rs-tab" + (RS.mode === v ? " on" : ""), label);
      b.onclick = () => rsSetMode(v);
      tabs.appendChild(b);
    }
    top.appendChild(tabs);

    const stat = el("span", "rs-stat");
    if (RS.graph) {
      const s = C().stats(RS.graph);
      stat.textContent =
        t("节点 ") +
        s.nodes +
        " · " +
        t("关系 ") +
        s.edges +
        " · " +
        t("已验证 ") +
        (s.byVerify.verified || 0) +
        "/" +
        (s.byVerify.verified + s.byVerify.doubt + s.byVerify.unverified || 0);
    } else {
      stat.textContent = t("笔记 ") + RS.notes.length;
    }
    top.appendChild(stat);

    /* 初始化进度：队列在跑就显示 N/M（点开看逐项状态），跑完变成一条完成提示 */
    const ini = window.MTResearchInit;
    if (ini && RS.ready) {
      const s = ini.stats();
      if (s && s.total) {
        const allDone = s.finished >= s.total;
        const chipIni = el(
          "button",
          "rs-chip rs-chip-init" + (s.failed ? " bad" : allDone ? " done" : " on"),
          allDone
            ? t("初始化完成") + " · " + (Number(s.processed) || 0) + t(" 篇已处理")
            : t("初始化 ") + s.finished + "/" + s.total + (s.failed ? " · " + t("失败") + " " + s.failed : ""),
        );
        chipIni.title = allDone
          ? t("初始化已完成：查看已处理内容（只读清单）")
          : t("研究初始化：逐项状态、失败重试");
        chipIni.onclick = () => (allDone ? openProcessedList() : ini.openProgress());
        top.appendChild(chipIni);
      }
    }

    const spacer = el("span", "rs-grow");
    top.appendChild(spacer);

    const mkBtn = (label, title, fn, cls) => {
      const b = el("button", "rs-btn " + (cls || ""), label);
      b.title = title || label;
      b.onclick = fn;
      top.appendChild(b);
      return b;
    };
    mkBtn(t("转为图谱"), t("解析全部笔记，重建知识图谱（之后保存时增量更新）"), () => rsBuildGraph(true), "primary");
    mkBtn("＋ " + t("添加资料"), t("打开投料台，增量添加文件 / 链接 / 笔记 / 检索式"), () => openInitWizard(true));
    const litBtn = mkBtn(
      t("文献"),
      t("打开文献库：导入 BibTeX / 按 DOI 添加 / 检索 / PDF 入库 / 插入引用 / 折叠"),
      () => openLit(litBtn),
    );
    mkBtn(t("撤销"), t("撤销上一次改动（Ctrl+Z）：手工编辑与 agent 写入都记在 changes.jsonl"), () => rsUndo());
    mkBtn(t("重做"), t("重做被撤销的改动（Ctrl+Shift+Z / Ctrl+Y）"), () => rsRedo());
    mkBtn(t("刷新"), t("重新读取 research/ 目录（外部编辑器改过文件时用）"), async () => {
      await rsReloadAll();
      toastSafe(t("已刷新"));
    });
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
  }
  async function rsOpenFold(path) {
    await rsSaveCurrent();
    const rec = (RS.folds || []).find((f) => f.path === path);
    if (!rec) return;
    RS.curPath = path;
    RS.md = rec.md;
    RS.dirty = false;
    RS.foldPath = path;
    RS.foldLevel = 1;
    RS.editorMode = "edit";
    renderSide();
    renderEditor();
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
    x.onclick = () => box.remove();
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
      row.appendChild(el("div", "rs-processed-name", it.title || it.key || it.id || t("（无标题）")));
      const meta = [it.kind, it.mdRel || it.noteRel, fmtProcessedAt(it.processedAt)]
        .filter(Boolean)
        .join(" · ");
      row.appendChild(el("div", "rs-processed-meta", meta));
      rows.appendChild(row);
    }
    box.appendChild(rows);
    document.body.appendChild(box);
  }

  /* ── 笔记列表 ── */
  /* ── 左侧文件栏（笔记 / 折叠两段；文献已经搬到顶栏「文献」浮层） ── */
  function toggleSide() {
    RS.sideCollapsed = !RS.sideCollapsed;
    renderSide();
    renderTop();
    saveMetaPatch({ ui: Object.assign({}, (RS.meta && RS.meta.ui) || {}, { sideCollapsed: !!RS.sideCollapsed }) });
  }
  function renderSide() {
    const side = RS.sideEl;
    if (!side) return;
    side.innerHTML = "";
    side.classList.toggle("hide", !!RS.sideCollapsed);
    if (RS.sideCollapsed) return;
    const tools = el("div", "rs-side-tools");
    const newBtn = el("button", "rs-btn", "＋ " + t("新建笔记"));
    newBtn.title = t("在 notes/ 下新建一篇 Markdown 笔记");
    newBtn.onclick = () => rsNewNote();
    tools.appendChild(newBtn);
    side.appendChild(tools);
    const list = el("div", "rs-note-list");
    const rels = initDoneRels();
    for (const n of RS.notes) {
      const row = el("div", "rs-note" + (n.path === RS.curPath ? " on" : ""));
      const head = el("div", "rs-note-head");
      head.appendChild(el("div", "rs-note-title", n.title));
      if (noteInitDone(n, rels)) head.appendChild(initDoneBadge());
      const sub = el("div", "rs-note-sub");
      const kind = n.meta && n.meta.kind ? String(n.meta.kind) : "";
      sub.textContent =
        (n.core ? t("核心文件") : kind ? C().NODE_KINDS[kind] || kind : "") + " · " + n.path;
      row.appendChild(head);
      row.appendChild(sub);
      row.onclick = () => rsOpenNote(n.path);
      list.appendChild(row);
    }
    side.appendChild(list);
    /* 折叠（参考资料的三层视图）：单独一段，点了进只读的 2/3 层或改全文层 */
    if ((RS.folds || []).length) {
      const head = el("div", "rs-side-head", t("折叠（参考资料）"));
      side.appendChild(head);
      const fl = el("div", "rs-note-list");
      for (const f of RS.folds) {
        const row = el("div", "rs-note rs-fold" + (f.path === RS.curPath ? " on" : ""));
        row.appendChild(el("div", "rs-note-title", f.title));
        row.appendChild(el("div", "rs-note-sub", f.count + t(" 段 · ") + f.path));
        row.onclick = () => rsOpenFold(f.path);
        fl.appendChild(row);
      }
      side.appendChild(fl);
    }
  }

  /* ── 编辑器 ── */
  function renderToolbar() {
    const bar = RS.toolbarEl;
    if (!bar) return;
    bar.innerHTML = "";
    const isFold = !!RS.foldPath && RS.foldPath === RS.curPath;
    const name = el("span", "rs-cur", RS.curPath || t("未选择笔记"));
    bar.appendChild(name);
    /* 三层折叠的层级切换：1 全文（可改）/ 2 关键原句 / 3 主题（只读投影） */
    if (isFold) {
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
          RS.editorMode = lv.n === 1 ? "edit" : "read";
          renderEditor();
        };
        seg.appendChild(b);
      }
      bar.appendChild(seg);
    }
    const ro = isFold && RS.foldLevel > 1;
    if (ro) {
      const saved = el("span", "rs-saved", t("只读"));
      RS.savedEl = saved;
      bar.appendChild(saved);
      return;
    }
    const mk = (label, title, fn) => {
      const b = el("button", "rs-tool", label);
      b.title = title;
      b.onclick = fn;
      bar.appendChild(b);
      return b;
    };
    mk("H2", t("插入二级标题"), () => rsInsertText("\n## 标题\n"));
    mk("B", t("加粗"), () => rsWrapSelection("**", "**"));
    mk("$", t("插入行内公式"), () => rsWrapSelection("$", "$"));
    mk("$$", t("插入公式块"), () => rsInsertText("\n$$\nE = mc^2\n$$\n"));
    mk("❝", t("把选区写成论断（claim）"), () => rsAnnotate("claim"));
    mk("✎", t("对选区加批注（写回 md 的 note 块）"), () => rsAnnotate("note"));
    mk("?", t("把选区写成待解决问题"), () => rsAnnotate("question"));
    /* 这颗钮就是「流程图」：只插 flowchart 模板。历史上它叫 Pele（渲染器名），
       用户看不出是干什么的，也找不到「为什么会话里点了没反应」。 */
    mk(t("流程图"), t("在光标处插入流程图（mermaid flowchart 代码块，正文里直接渲染成图）"), () =>
      rsInsertFlowchart(),
    );
    const editing = RS.editorMode === "edit";
    const mode = el("button", "rs-tool" + (editing ? " on" : ""), editing ? t("完成") : t("编辑"));
    mode.title = editing
      ? t("收起源码，回到渲染后的阅读态")
      : t("编辑 Markdown 源码：左边源码、右边实时预览");
    mode.onclick = () => {
      RS.md = readEditorMd();
      RS.editorMode = editing ? "read" : "edit";
      renderEditor();
      if (RS.srcEl) RS.srcEl.focus();
    };
    bar.appendChild(mode);
    const saved = el("span", "rs-saved");
    saved.textContent = RS.dirty ? t("未保存…") : t("已保存");
    RS.savedEl = saved;
    bar.appendChild(saved);
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

  function renderEditor() {
    renderToolbar();
    const body = RS.bodyEl;
    if (!body) return;
    body.innerHTML = "";
    if (!RS.curPath) {
      RS.curEl = null;
      RS.srcEl = null;
      body.appendChild(el("div", "rs-empty", t("左侧选一篇笔记，或新建一篇")));
      return;
    }
    const isFold = !!RS.foldPath && RS.foldPath === RS.curPath;
    /* 折叠的第 2 / 3 层是**只读投影**（共识）：这一层是 AI 折出来的，改它就跟原文对不上了，
       要改就切回「1 全文」——那是这份文件的唯一真源。 */
    if (isFold && RS.foldLevel > 1) {
      const wrap = el("div", "rs-rich rs-fold-ro");
      wrap.innerHTML = renderMarkdown(C().foldView(RS.md, RS.foldLevel));
      decorateCallouts(wrap);
      body.appendChild(wrap);
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
    /* 折叠文件的全文层同样走「源码 + 实时预览」：富文本往返会把 `**全文**` 这类层级标记改坏 */
    if (RS.editorMode === "edit") {
      const split = el("div", "rs-split");
      const ta = el("textarea", "rs-src");
      ta.value = RS.md;
      ta.spellcheck = false;
      ta.oninput = () => {
        RS.md = ta.value;
        RS.dirty = true;
        if (RS.savedEl) RS.savedEl.textContent = t("未保存…");
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
      const prev = el("div", "rs-rich rs-preview");
      prev.innerHTML = renderMarkdown(splitFm(RS.md).body);
      decorateCallouts(prev);
      split.appendChild(ta);
      split.appendChild(prev);
      body.appendChild(split);
      RS.srcEl = ta;
      RS.previewEl = prev;
      RS.curEl = null;
      RS.selHost = null;
      return;
    }
    /* 阅读态（默认）：渲染后的 Markdown，**不进 DOM 往返**，所以流程图 / 公式 / 表格
       不会被 richToMarkdown 抹掉；选中文字照样能批注 / 询问（选中工具条只读取文本）。 */
    const ed = el("div", "rs-rich rs-read");
    ed.innerHTML = renderMarkdown(splitFm(RS.md).body);
    decorateCallouts(ed);
    body.appendChild(ed);
    RS.curEl = null;
    RS.srcEl = null;
    RS.previewEl = null;
    RS.selHost = ed;
    bindSelectionTools(ed);
  }

  /* 实时预览：源码输入后小延时重渲染（不打字打到一半就重排，也不抖动滚动） */
  let previewTimer = null;
  function rsSchedulePreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => {
      if (!RS.previewEl) return;
      const box = RS.previewEl;
      const top = box.scrollTop;
      box.innerHTML = renderMarkdown(splitFm(RS.md).body);
      decorateCallouts(box);
      box.scrollTop = top;
    }, 160);
  }

  /* Markdown → 富文本：复用 app-review.js 的同一套实现（公式 / 表格 / 图片往返口径一致） */
  function renderMarkdown(md) {
    let html = "";
    try {
      html = typeof mdToRichHtml === "function" ? mdToRichHtml(md) : "";
    } catch (_) {
      html = "";
    }
    if (!html) {
      html = esc(md).replace(/\n/g, "<br>");
    }
    /* Pele 代码块：```mermaid / ```pele 现场渲染成 SVG（替换掉 marked 给的 <pre><code>） */
    try {
      html = html.replace(
        /<pre><code class="language-(mermaid|pele)">([\s\S]*?)<\/code><\/pre>/g,
        (all, lang, code) => {
          const src = decodeEntities(code);
          if (!window.MTPele) return all;
          const r = window.MTPele.render(src);
          return r.svg || '<pre class="rs-pele-err">' + esc(src) + "</pre>";
        },
      );
    } catch (_) {}
    return html;
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
    return RS.md;
  }

  let saveTimer = null;
  function rsScheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => rsSaveCurrent(), 900);
  }
  async function rsSaveCurrent(override) {
    if (!RS.curPath || !RS.root) return;
    /* 折叠的第 2/3 层是只读投影：不落盘（否则会把 AI 层写回真源） */
    if (RS.foldPath && RS.foldPath === RS.curPath && RS.foldLevel > 1) return;
    /* override：正文级写入（批注 / 论断 / 插入 Pele）已经把新的 Markdown 算好了，
       此时 DOM 还是旧的 —— 再从 DOM 读一次会把刚写进去的块整段丢掉（真机踩过）。 */
    const md = typeof override === "string" ? override : readEditorMd();
    if (md === RS.md && !RS.dirty) return;
    const rec = RS.notes.find((n) => n.path === RS.curPath);
    const foldRec = (RS.folds || []).find((f) => f.path === RS.curPath);
    const before = rec ? rec.md : foldRec ? foldRec.md : "";
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
    if (RS.savedEl) RS.savedEl.textContent = t("已保存");
    RS.lastSavedAt = Date.now();
    /* 增量：图已建过就只更新投影（保持节点位置，不重排，避免视线被甩走） */
    if (RS.graph) rsRebuildGraph({ keepPositions: true, silent: true });
    renderSide();
  }

  /* 选区工具条：批注 / 询问 / 复制链接（含公式的选区一样支持）
   * 阅读态与编辑态是两个容器：只有当前挂上来的那个（RS.selHost）才弹工具条。 */
  function bindSelectionTools(ed) {
    if (!ed || ed.dataset.selBound === "1") return;
    ed.dataset.selBound = "1";
    document.addEventListener("selectionchange", () => {
      if (!RS.selHost || RS.selHost !== ed) return;
      const sel = window.getSelection();
      const text = sel ? String(sel.toString() || "").trim() : "";
      if (!text || text.length < 2) return rsHideSelBar();
      rsShowSelBar(text);
    });
    ed.addEventListener("keydown", (ev) => {
      if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "s") {
        ev.preventDefault();
        rsSaveCurrent();
      }
    });
  }
  function rsShowSelBar(text) {
    let bar = qid("rsSelBar");
    if (!bar) {
      bar = el("div", "rs-selbar");
      bar.id = "rsSelBar";
      document.body.appendChild(bar);
    }
    bar.innerHTML = "";
    const quote = el("span", "rs-selbar-q", text.length > 40 ? text.slice(0, 40) + "…" : text);
    bar.appendChild(quote);
    const mk = (label, title, fn) => {
      const b = el("button", "rs-selbar-btn", label);
      b.title = title;
      b.onmousedown = (ev) => ev.preventDefault();
      b.onclick = () => {
        rsHideSelBar();
        fn(text);
      };
      bar.appendChild(b);
    };
    mk(t("批注"), t("把这段写成 note 块（写回 md）"), () => rsAnnotate("note", text));
    mk(t("问 AI"), t("就这段内容就地提问，结果可一键落图"), (q) => rsAskOpen(q));
    mk(t("改成论断"), t("把这段提升成 claim 块，进入图谱并可标验证态"), () => rsAnnotate("claim", text));
    let rect = null;
    try {
      const sel = window.getSelection();
      rect = sel && sel.rangeCount ? sel.getRangeAt(0).getBoundingClientRect() : null;
    } catch (_) {}
    bar.style.display = "flex";
    if (rect) {
      bar.style.left = Math.max(8, window.scrollX + rect.left) + "px";
      bar.style.top = Math.max(8, window.scrollY + rect.top - bar.offsetHeight - 8) + "px";
    }
  }
  function rsHideSelBar() {
    const bar = qid("rsSelBar");
    if (bar) bar.style.display = "none";
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
    await rsSaveCurrent(next);
    renderEditor();
    if (RS.graph) rsRebuildGraph({ keepPositions: true, silent: true });
    toastSafe(t("已写入 ") + C().NODE_KINDS[kind === "question" ? "question" : kind === "claim" ? "claim" : "annotation"]);
  }

  /* ── 正文写入：一律落进源码（编辑态），不再走 contentEditable 往返 ──
   * 为什么这样改：富文本态把 ```mermaid 渲成 SVG，保存时 richToMarkdown 只能读回 SVG 的文字，
   * 围栏 / 语言标记全丢 —— 流程图（旧「Pele」按钮）插进去一保存就烂成「是/问题/可分解?」的散字，
   * 用户看到的就是「点了没反应 / 图没了」。源码是真源，预览只是投影。 */
  function rsEnsureEdit() {
    if (RS.editorMode !== "edit") {
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
    if (RS.savedEl) RS.savedEl.textContent = t("未保存…");
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
    if (RS.savedEl) RS.savedEl.textContent = t("未保存…");
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
    const ta = rsEnsureEdit();
    if (!ta) {
      toastSafe(t("这篇笔记当前不可编辑"), "warn");
      return false;
    }
    const v = ta.value;
    const at = rsCaretIn(ta);
    const body = String(snippet || "").replace(/^\n+/, "").replace(/\s+$/, "\n");
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
    toastSafe(t("已插入流程图：左边改源码，右边实时预览，点「完成」回到阅读态"));
  }
  /* 旧名保留：外部脚本 / 旧入口还在调 rsInsertPele 时行为一致 */
  function rsInsertPele() {
    rsInsertFlowchart();
  }

  /* ── 框选询问（浮窗就地回答 + 一键落图）── */
  function resolveProv() {
    const list = (window.S && S.config && S.config.providers) || [];
    return (
      list.find((p) => p.type === "text_openai" && String(p.apiKey || "").trim()) || null
    );
  }
  function modelOf(prov) {
    const models =
      typeof providerModelFilter === "function" ? providerModelFilter(prov, prov.models) : prov.models || [];
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
      if (!prov) return toastSafe(t("没有可用的文本模型（设置 · 模型服务）"), "err");
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
    await rsSaveCurrent(next);
    renderEditor();
    if (RS.graph) rsRebuildGraph({ keepPositions: true, silent: true });
    toastSafe(t("已插入并写入图谱"));
  }

  /* ── 笔记操作 ── */
  async function rsOpenNote(path, opts) {
    const o = opts || {};
    await rsSaveCurrent();
    const rec = RS.notes.find((n) => n.path === path);
    if (!rec) return;
    RS.curPath = path;
    RS.md = rec.md;
    RS.dirty = false;
    RS.foldPath = "";
    renderSide();
    renderEditor();
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
    await window.api.fileWriteText(joinP(RS.root, rel), md);
    await logChange(t("新建笔记"), rel, "", md);
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

  /* ── 图谱 ── */
  function buildFullGraph() {
    const docs = RS.notes.map((n) => ({
      path: n.path,
      parsed: C().parseNote({ path: n.path, md: n.md }),
    }));
    const g = C().buildGraph(docs, { library: RS.lib });
    return g;
  }
  async function rsRebuildGraph(opts) {
    const o = opts || {};
    const g = buildFullGraph();
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
      RS.graphHost.classList.add("show");
      RS.sideEl.classList.toggle("hide", !!RS.sideCollapsed);
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
      renderEditor();
    }
    refreshChatFocus();
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
   * 编辑区 / 图谱独占剩余空间；状态写进 research.json（与左栏同一套记忆口径）。 */
  function toggleChat() {
    RS.chatCollapsed = !RS.chatCollapsed;
    saveMetaPatch({
      ui: Object.assign({}, (RS.meta && RS.meta.ui) || {}, {
        sideCollapsed: !!RS.sideCollapsed,
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
    return (n ? n.title : RS.curPath) || RS.curPath;
  }
  /* 切笔记 / 切视图时只刷新标题栏那颗焦点标签 —— 不整体重绘会话框，正在打的草稿与光标都留着 */
  function refreshChatFocus() {
    const chip = RS.chatEl && RS.chatEl.querySelector(".rs-chat-focus");
    if (chip) chip.textContent = "◎ " + focusLabel();
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
    const focus = el("span", "rs-chat-focus", "◎ " + focusLabel());
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
      row.appendChild(b);
      list.appendChild(row);
    }
    if (!tail.length) list.appendChild(el("div", "rs-chat-empty", t("还没有对话。可以让 agent 帮你补文献、找反例、把论断拆成子问题。")));
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

  /* ── 文献浮层（顶栏「文献」）──
   * 以前它挂在左栏第二个 tab 里，跟笔记抢一块地方；现在左栏只放文件，文献整套能力
   * （BibTeX / DOI / 检索 / PDF 入库 / 插入引用 / 折叠 / ↗ / 移除）搬进一个持久浮层。
   * 持久口径：只有窗内 ✕ 与 Esc 能关，点外部不关。 */
  function openLit(anchor) {
    const old = qid("rsLit");
    if (old) {
      closeLit();
      return; /* 顶栏那颗钮是开关：再点一次收起 */
    }
    RS.litOpen = true;
    const box = el("div", "rs-ask wide rs-lit-panel");
    box.id = "rsLit";
    /* 贴着顶栏那颗「文献」按钮挂下来：写死 top 会压住研究视图自己的工具条（真机看过确实挡按钮） */
    const r = anchor && anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : null;
    if (r && r.width) {
      box.style.top = Math.round(r.bottom + 8) + "px";
      box.style.left = "auto";
      box.style.right = Math.max(12, Math.round(window.innerWidth - r.right)) + "px";
      box.style.maxHeight = Math.max(240, Math.round(window.innerHeight - r.bottom - 32)) + "px";
    }
    const head = el("div", "rs-ask-head");
    head.appendChild(el("b", "", t("文献库")));
    const cnt = el("span", "rs-lit-count", String((RS.lib || []).length));
    cnt.title = t("文献库条目数");
    head.appendChild(cnt);
    const close = el("button", "rs-ask-x", "✕");
    close.title = t("关闭");
    close.onclick = () => closeLit();
    head.appendChild(close);
    box.appendChild(head);
    RS.litHost = el("div", "rs-lit-body");
    box.appendChild(RS.litHost);
    document.body.appendChild(box);
    if (!box.dataset.keyBound) {
      box.dataset.keyBound = "1";
      document.addEventListener("keydown", (e) => {
        if (e.key !== "Escape" || !qid("rsLit")) return;
        e.preventDefault();
        closeLit();
      });
    }
    renderLit();
  }
  function closeLit() {
    const box = qid("rsLit");
    if (box) box.remove();
    RS.litOpen = false;
  }
  function renderLit() {
    const host = RS.litHost && document.body.contains(RS.litHost) ? RS.litHost : null;
    if (!host) return;
    host.innerHTML = "";
    const tools = el("div", "rs-side-tools");
    const btnBib = el("button", "rs-btn", t("导入 BibTeX"));
    btnBib.onclick = () => litImportBib();
    const btnDoi = el("button", "rs-btn", t("按 DOI 添加"));
    btnDoi.onclick = () => litByDoi();
    const btnSearch = el("button", "rs-btn", t("检索"));
    btnSearch.onclick = () => litSearchDialog();
    const btnPdf = el("button", "rs-btn", t("PDF 入库"));
    btnPdf.title = t("选本地 PDF，抽取全文到 literature/pdf/（复用应用内 PDF 解析内核）");
    btnPdf.onclick = () => litIngestPdf();
    for (const b of [btnBib, btnDoi, btnSearch, btnPdf]) tools.appendChild(b);
    host.appendChild(tools);

    const list = el("div", "rs-lit-list");
    const litRels = initDoneRels();
    if (!RS.lib.length)
      list.appendChild(el("div", "rs-lit-empty", t("文献库是空的。导入 BibTeX 或按 DOI / 标题检索后加入。")));
    for (const it of RS.lib) {
      const row = el("div", "rs-lit-item");
      const key = it.citeKey || C().citeKeyOf(it);
      const title = C().itemTitle(it) || t("（无标题）");
      const head = el("div", "rs-lit-head");
      head.appendChild(el("div", "rs-lit-title", title));
      if (litInitDone(it, litRels)) head.appendChild(initDoneBadge());
      row.appendChild(head);
      row.appendChild(
        el("div", "rs-lit-sub", C().citeText(it) + " · " + key + (it.DOI ? " · " + it.DOI : "")),
      );
      const acts = el("div", "rs-lit-acts");
      const copy = el("button", "rs-tool", t("插入引用"));
      copy.title = t("在正文光标处插入 Pandoc 式引用 [@key]");
      copy.onclick = () => {
        /* 浮层挡着正文：插完就收起，让用户直接看到写进去的位置（并已切到编辑态） */
        rsInsertText(" [@" + key + "] ");
        closeLit();
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
        closeLit();
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
  function litImportBib() {
    const box = el("div", "rs-ask");
    box.style.right = "24px";
    box.style.top = "120px";
    box.innerHTML =
      '<div class="rs-ask-head"><b>' +
      esc(t("粘贴 BibTeX")) +
      '</b><button class="rs-ask-x">✕</button></div>' +
      '<textarea class="rs-ask-input big" placeholder="@article{key, title={...}, author={...}, year={2024}}"></textarea>' +
      '<div class="rs-ask-row"><button class="rs-btn primary" data-a="ok">' +
      esc(t("导入")) +
      '</button><button class="rs-btn" data-a="file">' +
      esc(t("从 .bib 文件导入")) +
      "</button></div>";
    document.body.appendChild(box);
    box.querySelector(".rs-ask-x").onclick = () => box.remove();
    box.querySelector('[data-a="file"]').onclick = async () => {
      const r = await window.api.fileOpenDialog({
        multi: false,
        filters: [{ name: "BibTeX", extensions: ["bib"] }],
      });
      const p = r && (r.path || (r.paths && r.paths[0]));
      if (!p) return;
      const txt = await readText(p);
      const items = C().parseBibtex(txt);
      box.remove();
      await addToLib(items, "BibTeX");
    };
    box.querySelector('[data-a="ok"]').onclick = async () => {
      const txt = box.querySelector("textarea").value;
      const items = C().parseBibtex(txt);
      box.remove();
      if (!items.length) return toastSafe(t("没有解析到条目"), "warn");
      await addToLib(items, "BibTeX");
    };
  }
  function litByDoi() {
    const box = el("div", "rs-ask");
    box.style.right = "24px";
    box.style.top = "120px";
    box.innerHTML =
      '<div class="rs-ask-head"><b>' +
      esc(t("按 DOI 添加")) +
      '</b><button class="rs-ask-x">✕</button></div>' +
      '<input class="rs-ask-input" placeholder="10.1038/nature12373 或 https://doi.org/..." />' +
      '<div class="rs-ask-row"><button class="rs-btn primary" data-a="ok">' +
      esc(t("检索并加入")) +
      "</button></div>" +
      '<div class="rs-ask-out"></div>';
    document.body.appendChild(box);
    box.querySelector(".rs-ask-x").onclick = () => box.remove();
    const out = box.querySelector(".rs-ask-out");
    box.querySelector('[data-a="ok"]').onclick = async () => {
      const v = box.querySelector("input").value;
      out.textContent = t("查询中…");
      try {
        const it = await litLookupDoi(v);
        if (!it) throw new Error(t("没有结果"));
        box.remove();
        await addToLib([it], "Crossref");
      } catch (e) {
        out.textContent = t("失败：") + String((e && e.message) || e);
      }
    };
  }
  function litSearchDialog() {
    const box = el("div", "rs-ask wide");
    box.style.right = "24px";
    box.style.top = "100px";
    box.innerHTML =
      '<div class="rs-ask-head"><b>' +
      esc(t("检索文献")) +
      '</b><button class="rs-ask-x">✕</button></div>' +
      '<div class="rs-ask-row"><input class="rs-ask-input" placeholder="' +
      esc(t("标题 / 关键词 / 作者")) +
      '" /><select class="rs-sel"><option value="crossref">Crossref</option><option value="arxiv">arXiv</option><option value="s2">Semantic Scholar</option></select></div>' +
      '<div class="rs-ask-row"><button class="rs-btn primary" data-a="go">' +
      esc(t("检索")) +
      "</button></div>" +
      '<div class="rs-ask-out"></div>';
    document.body.appendChild(box);
    box.querySelector(".rs-ask-x").onclick = () => box.remove();
    const out = box.querySelector(".rs-ask-out");
    const inp = box.querySelector("input");
    const sel = box.querySelector("select");
    box.querySelector('[data-a="go"]').onclick = async () => {
      const q = String(inp.value || "").trim();
      if (!q) return inp.focus();
      out.textContent = t("检索中…");
      try {
        const src = sel.value;
        const items =
          src === "arxiv"
            ? await litSearchArxiv(q, 8)
            : src === "s2"
              ? await litSearchS2(q, 8)
              : await litSearchCrossref(q, 8);
        out.innerHTML = "";
        if (!items.length) {
          out.textContent = t("没有结果（换个源或换关键词）");
          return;
        }
        for (const it of items) {
          const row = el("div", "rs-lit-item");
          row.appendChild(el("div", "rs-lit-title", C().itemTitle(it) || t("（无标题）")));
          row.appendChild(el("div", "rs-lit-sub", C().citeText(it) + (it.DOI ? " · " + it.DOI : "")));
          const add = el("button", "rs-tool", t("加入"));
          add.onclick = () => addToLib([it], src);
          row.appendChild(add);
          out.appendChild(row);
        }
      } catch (e) {
        out.textContent = t("检索失败：") + String((e && e.message) || e);
      }
    };
    inp.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") box.querySelector('[data-a="go"]').click();
    });
  }
  async function litIngestPdf() {
    try {
      const r = await window.api.fileOpenDialog({
        multi: false,
        filters: [{ name: "PDF", extensions: ["pdf"] }],
      });
      const p = r && (r.path || (r.paths && r.paths[0]));
      if (!p) return;
      toastSafe(t("解析 PDF 中…（大文件需要一会儿）"));
      const parsed = await window.api.fileParsePdf({ path: p });
      const text = String((parsed && (parsed.text || parsed.markdown)) || "");
      if (!text.trim()) throw new Error(t("没有解析到文本层（可能是扫描件，需要 OCR）"));
      const key = C().slugify(C().baseName(p).replace(PDF_RE, "")) || "paper-" + Date.now();
      const dest = joinP(RS.root, "literature", "pdf", key + ".md");
      const head =
        "---\ntitle: " +
        JSON.stringify(C().baseName(p).replace(PDF_RE, "")) +
        "\ntags: [pdf]\nsource: " +
        JSON.stringify(p) +
        "\ningestedAt: " +
        JSON.stringify(new Date().toISOString()) +
        "\n---\n\n# " +
        C().baseName(p).replace(PDF_RE, "") +
        "\n\n> [!source] 全文入库\n> " +
        p +
        "\n\n";
      const md = head + text;
      await window.api.fileWriteText(dest, md);
      await logChange(t("PDF 全文入库"), "literature/pdf/" + key + ".md", "", md);
      /* 同时把 PDF 原件拷进库，方便以后核对页码 */
      try {
        await window.api.fileCopy(p, joinP(RS.root, "literature", "pdf", key + ".pdf"));
      } catch (_) {}
      toastSafe(t("已入库：") + "literature/pdf/" + key + ".md");
    } catch (e) {
      toastSafe(t("PDF 入库失败：") + String((e && e.message) || e), "err");
    }
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
        split: RS.split,
        saveMeta: saveMetaPatch,
        onDone: async () => {
          await rsReloadAll();
          renderTop();
        },
        onGraph: () => rsBuildGraph(true),
      });
    } catch (e) {
      toastSafe(String((e && e.message) || e), "err");
    }
  }

  /* 清掉「上一张画布的研究」——内存与界面都要清。
     只清内存不够：闸门是半透明盖在视图上的，底下的顶栏 / 编辑区 / 图谱还是上一次画的，
     于是「在未初始化的画布点研究」会看到别的画布的正文（用户报的 bug）。 */
  function rsResetLoaded() {
    RS.ready = false;
    RS.meta = null;
    RS.notes = [];
    RS.folds = [];
    RS.foldPath = "";
    RS.curPath = "";
    RS.md = "";
    RS.graph = null;
    RS.lib = [];
    RS.dirty = false;
    RS.split = 0.5;
    /* 重做栈只在同一份研究目录里有效：换画布 / 回闸门就作废，免得把别处的内容重做回来 */
    RS.redoStack = [];
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
    /* 顶栏 / 左栏 / 编辑器 / 会话框一起清空：闸门只负责说明，底图不该再有内容 */
    for (const node of [RS.topEl, RS.sideEl, RS.toolbarEl, RS.bodyEl, RS.chatEl]) {
      if (node) node.innerHTML = "";
    }
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
         先清空视图再出闸门 —— 否则底图是上一张画布的笔记 / 图谱。 */
      rsClearPane();
      showInitGate();
      return;
    }
    RS.gate.classList.remove("show");
    RS.gate.innerHTML = "";
    if (window.__rsInitGateBound) window.__rsInitGateBound = false;
    renderTop();
    renderSide();
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
      '</p><button class="rs-btn primary" id="rsGateGo">' +
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
      esc(t("初始化是一整块投料台：上面写课题，左边放核心文件，右边放参考资料（都能直接贴 arXiv / DOI / 网页链接、写笔记或检索式）。点「开始处理」才会创建 research/ 目录并交给 agent 处理。")) +
      '</p><button class="rs-btn primary" id="rsGateInit">' +
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
  async function rsReloadAll() {
    RS.ready = false;
    const r = await ensureInit();
    /* 重载同样无条件恢复标记：research/ 被删掉时这里会把队列清空，徽标 / chip 一起消失 */
    await syncInitQueue();
    /* 研究目录已被删掉 / 还没初始化 / 没有工作目录：清空视图并回闸门，不要留在空壳里 */
    if (!r.ok) {
      rsClearPane();
      try {
        if (r.code === "not_initialized") showInitGate();
        else showNoWsGate();
      } catch (_) {}
      return;
    }
    /* 已有内容：把「这个课题还没有初始化」的告示收掉（重载时不一定走过 rsClearPane） */
    if (RS.gate) {
      RS.gate.classList.remove("show");
      RS.gate.innerHTML = "";
    }
    if (window.__rsInitGateBound) window.__rsInitGateBound = false;
    renderTop();
    renderSide();
    renderEditor();
    renderChat();
    if (RS.mode === "graph") rsSetMode("graph");
  }
  function onCanvasChanged() {
    if (!qid("researchPane")) return;
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
  window.MTResearch = {
    enter,
    reload: rsReloadAll,
    onCanvasChanged,
    onAuthChanged,
    userIsOwner,
    state: RS,
    buildGraph: rsBuildGraph,
    undo: rsUndo,
    redo: rsRedo,
    openInitWizard,
    rootOf,
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
