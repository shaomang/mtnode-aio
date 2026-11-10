/* ===== 研究初始化（整画布投料台 + 队列点火）· renderer/app-research-init.js =====
 *
 * 为什么单独一份：初始化是「一次性仪式 + 可重复的增量入口」，生命周期与常驻的研究视图不同
 * （视图天天开着，初始化只在开题与补料时跑）。它只碰 research/ 下的目录与队列文件，
 * 视图的装载 / 编辑 / 图谱仍归 app-research.js。
 *
 * 四条硬口径（共识）：
 *   1) 没有初始化就没有 research/：点「开始处理」才 mkdir，取消不留半套目录；
 *   2) 文件一律复制进 research/（core/ 与 literature/sources/），原文件不动，重名加后缀；
 *   3) 一键「开始处理」才建会话、才发任务；逐篇串行，进度靠 research/init-queue.json 扫盘；
 *   4) 界面占满画布区域（只让开顶栏与左栏），课题横跨顶部、核心文件与参考资料左右分区、
 *      中间分隔条可拖；**不再有可拖动的浮窗与分步向导**。两个区都能投文件、链接、自由文本与检索式。
 *
 * 投料项（entry）与队列项（item）不是一回事：entry 是「还没提交的输入」，提交后变成 item
 * （队列项带 mdRel / foldsRel / noteRel / status，由内核 buildInitQueue 算）。
 *
 * 对外：window.MTResearchInit（open / close / openProgress / refreshQueue / retryFailed / stats / viewProcessed）
 */
(function () {
  "use strict";

  const C = () => window.MTResearchCore;
  const QUEUE_FILE = "init-queue.json";
  const QUERY_LOG = "literature/queries.jsonl";

  const RI = {
    built: false,
    open: false,
    existing: false, // 增量添加资料（旧队列只读展示，新条目续排）
    ws: "",
    root: "",
    wfId: "",
    wfName: "",
    topic: "",
    question: "",
    instruction: "", // 这一批投料随附的「给 agent 的指示」（进 taskPrompt，执行完清空）
    core: [], // entry: {rid,source,src,text,title,note,size,main}
    refs: [],
    busy: false,
    err: "",
    sessionId: "",
    queue: null,
    pollTimer: null,
    onDone: null,
    onGraph: null,
    onView: null,
    saveMeta: null,
    split: 0.5, // 左栏（核心文件）占比，记在 research.json 的 initSplit
    composer: null, // {role, mode:"auto"|"query", text}
    preview: null, // {role, rows:[{source,value,title,role}]}
    editing: "", // 正在内联编辑的 entry rid
    ridSeq: 0,
    /* 每 close() 一次 +1：startInit 是长异步（复制 / 解析 / 落盘 / 拉起会话），跑完时用它判断
       「这期间界面有没有被关掉（换画布 / 回闸门）」—— 被关掉就不要再把投料台弹回来。 */
    runSeq: 0,
  };
  window.MTResearchInitState = RI;

  /* ── 小工具（不依赖画布层同名函数）── */
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
      else console.log("[research-init]", msg);
    } catch (_) {}
  }
  function joinP(...parts) {
    const list = parts.filter((x) => x != null && String(x) !== "");
    if (window.api && window.api.pathJoin) return window.api.pathJoin(...list);
    return list.join("/").replace(/\/+/g, "/");
  }
  function baseName(p) {
    const s = String(p == null ? "" : p).replace(/[\\/]+$/, "");
    const i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
    return i < 0 ? s : s.slice(i + 1);
  }
  function stripExt(p) {
    const s = String(p == null ? "" : p);
    const i = s.lastIndexOf(".");
    const j = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
    return i > j ? s.slice(0, i) : s;
  }
  function fmtSize(n) {
    const v = Number(n) || 0;
    if (v >= 1024 * 1024) return (v / 1024 / 1024).toFixed(1) + " MB";
    if (v >= 1024) return Math.round(v / 1024) + " KB";
    return v + " B";
  }
  function readText(p) {
    return window.api
      .fileReadText(p)
      .then((r) => (r && r.exists ? String(r.content || "") : ""))
      .catch(() => "");
  }
  async function existsP(p) {
    const r = await window.api.fileStat(p).catch(() => null);
    return !!(r && r.ok);
  }
  async function writeJson(p, obj) {
    await window.api.fileMkdir(joinP(p, "..")).catch(() => {});
    await window.api.fileWriteText(p, JSON.stringify(obj, null, 2) + "\n");
  }

  /* ── 目录 / 队列 ── */
  const INIT_DIRS = [
    "",
    "notes",
    "core",
    "literature",
    "literature/sources",
    "literature/folds",
    "literature/pdf",
  ];
  function rootOf() {
    return RI.root || (RI.ws ? joinP(RI.ws, "research") : "");
  }
  async function ensureDirs(root) {
    for (const d of INIT_DIRS) await window.api.fileMkdir(d ? joinP(root, d) : root).catch(() => {});
  }
  async function readQueue() {
    const root = rootOf();
    if (!root) return null;
    const raw = await readText(joinP(root, QUEUE_FILE));
    if (!raw.trim()) return null;
    try {
      const q = JSON.parse(raw);
      return q && Array.isArray(q.items) ? q : null;
    } catch (_) {
      return null;
    }
  }
  function stats() {
    return C().initQueueStats(RI.queue || { items: [] });
  }
  function queueFinished() {
    const q = RI.queue;
    if (!q) return false;
    const list = q.items || [];
    if (!list.length) return true;
    return C().queueAllDone(q);
  }
  /* 扫盘：只在处理中轮询，结束时清掉定时器（不做空转） */
  async function refreshQueue(silent) {
    const q = await readQueue();
    if (q) {
      const before = JSON.stringify(RI.queue || null);
      RI.queue = q;
      if (!silent && before !== JSON.stringify(q)) emitChange();
      if (C().queueAllDone(q) && q.phase !== "done") {
        q.phase = "done";
        await writeJson(joinP(rootOf(), QUEUE_FILE), q).catch(() => {});
      }
    }
    schedulePoll();
    return RI.queue;
  }
  function schedulePoll() {
    if (queueFinished()) {
      if (RI.pollTimer) {
        clearInterval(RI.pollTimer);
        RI.pollTimer = null;
      }
      return;
    }
    if (RI.pollTimer) return;
    RI.pollTimer = setInterval(() => {
      refreshQueue().catch(() => {});
    }, 2500);
  }
  let changeHook = null;
  function emitChange() {
    try {
      if (typeof changeHook === "function") changeHook(RI.queue);
    } catch (_) {}
  }

  /* ── 分栏比例（记在 research.json 的 initSplit，0.18–0.82）── */
  function clampSplit(v) {
    const n = Number(v);
    if (!isFinite(n)) return 0.5;
    return Math.max(0.18, Math.min(0.82, n));
  }
  function saveSplit() {
    try {
      if (typeof RI.saveMeta === "function") RI.saveMeta({ initSplit: RI.split });
    } catch (_) {}
  }

  /* Esc 关闭这一层（浮层纪律：关闭只走窗内按钮 / Esc，绝不点外部自动关）。
     关掉 ≠ 丢弃：已放入的条目与已填的课题都留在 RI 里，再点「＋ 添加资料」原样回来。 */
  let keysBound = false;
  function bindKeys() {
    if (keysBound) return;
    keysBound = true;
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || !RI.open) return;
      e.preventDefault();
      if (RI.preview) {
        RI.preview = null;
        render();
        return;
      }
      if (RI.composer) {
        RI.composer = null;
        render();
        return;
      }
      close();
    });
  }

  /* ── 投料：拖入 / 选择文件 / 文本项 ── */
  function pathsFromDrop(dt) {
    const out = [];
    if (!dt) return out;
    const files = dt.files ? Array.from(dt.files) : [];
    for (const f of files) {
      let p = "";
      try {
        p = window.api && window.api.getPathForFile ? String(window.api.getPathForFile(f) || "") : "";
      } catch (_) {
        p = "";
      }
      if (!p && f && f.path) p = String(f.path);
      if (p) out.push(p);
    }
    return out;
  }
  function listOf(role) {
    return role === "core" ? RI.core : RI.refs;
  }
  function ensureMain() {
    if (!RI.core.length) return;
    if (RI.core.some((x) => x.main)) return;
    RI.core[0].main = true;
  }
  function addFiles(role, paths) {
    const list = listOf(role);
    let added = 0;
    for (const p of paths || []) {
      const src = String(p || "").trim();
      if (!src) continue;
      if (list.some((f) => f.source === "file" && f.src === src)) continue;
      const name = baseName(src);
      list.push({
        rid: "e" + ++RI.ridSeq,
        source: "file",
        src,
        name,
        text: "",
        title: stripExt(name),
        note: "",
        size: 0,
        main: false,
      });
      added++;
    }
    if (added) {
      if (role === "core") ensureMain();
      render();
    }
    return added;
  }
  async function pickFiles(role) {
    try {
      const r = await window.api.fileOpenDialog({
        title:
          role === "core"
            ? t("选择核心文件（tex / doc / ppt / md / txt…）")
            : t("选择参考资料（PDF / 文献 / 网页存档…）"),
        multi: true,
        defaultPath: RI.ws || "",
      });
      const list = (r && (r.paths || (r.path ? [r.path] : []))) || [];
      if (!list.length) return;
      for (const p of list) addFiles(role, [p]);
      /* 补一次体积（列表里显示大小，用户能看出是不是选错了） */
      await fillSizes(role);
    } catch (e) {
      toastSafe(t("选择文件失败：") + String((e && e.message) || e), "err");
    }
  }
  async function fillSizes(role) {
    const list = listOf(role);
    let dirty = false;
    for (const f of list) {
      if (f.source !== "file" || f.size) continue;
      const st = await window.api.fileStat(f.src).catch(() => null);
      if (st && st.ok) {
        f.size = st.size || 0;
        dirty = true;
      }
    }
    if (dirty) render();
  }

  /* 一串文字 → 条目（一行一条；链接 / arXiv / DOI 自动认，其余当笔记） */
  function parseBlock(text, force) {
    const C0 = C();
    const rows = [];
    for (const line of String(text || "").replace(/\r/g, "").split(/\n+/)) {
      const r = C0.initClassifyLine(line, force);
      if (r) rows.push({ source: r.source, value: r.value, title: "", role: "" });
    }
    return rows;
  }
  function addRows(role, rows) {
    const list = listOf(role);
    let added = 0;
    for (const r of rows || []) {
      const target = r.role === "core" || r.role === "ref" ? r.role : role;
      const tgt = listOf(target);
      const source = r.source === "url" || r.source === "query" ? r.source : "text";
      const value = String(r.value != null ? r.value : r.text || "").trim();
      if (!value) continue;
      const key = { source, url: value, text: value, query: value };
      tgt.push({
        rid: "e" + ++RI.ridSeq,
        source,
        src: source === "text" ? "" : value,
        name: "",
        text: source === "text" ? value : "",
        title: String(r.title || "").trim() || C().initEntryTitle(key),
        note: String(r.note || ""),
        size: 0,
        main: false,
      });
      added++;
    }
    if (added) {
      ensureMain();
      render();
    }
    return added;
  }
  async function commitComposer() {
    const c = RI.composer;
    if (!c) return;
    const text = String(c.text || "").trim();
    if (!text) {
      RI.err = t("先贴点什么：链接 / DOI / arXiv 编号 / 一段文字 / 检索式。");
      render();
      return;
    }
    const rows = parseBlock(text, c.mode === "query" ? "query" : "auto");
    if (!rows.length) {
      RI.err = t("没认出任何条目。");
      render();
      return;
    }
    RI.err = "";
    if (rows.length === 1) {
      addRows(c.role, rows);
      RI.composer = null;
      render();
      return;
    }
    /* 多行：先给一眼预览（可删 / 可改类型 / 可改投到哪一栏），确认后才进列表 */
    RI.preview = { role: c.role, rows: rows.map((r) => Object.assign({ role: c.role }, r)) };
    RI.composer = null;
    render();
  }
  function commitPreview() {
    const p = RI.preview;
    if (!p) return;
    const rows = (p.rows || []).filter((r) => String(r.value || "").trim());
    if (!rows.length) {
      RI.preview = null;
      RI.err = t("预览里一条都不剩了。");
      render();
      return;
    }
    RI.preview = null;
    RI.err = "";
    addRows(p.role, rows);
  }
  function moveEntry(rid, toRole) {
    const from = RI.core.some((x) => x.rid === rid) ? "core" : "ref";
    if (from === toRole) return false;
    const src = listOf(from);
    const i = src.findIndex((x) => x.rid === rid);
    if (i < 0) return false;
    const [e] = src.splice(i, 1);
    e.main = false;
    listOf(toRole).push(e);
    ensureMain();
    RI.editing = "";
    render();
    return true;
  }
  function removeEntry(rid) {
    for (const role of ["core", "ref"]) {
      const list = listOf(role);
      const i = list.findIndex((x) => x.rid === rid);
      if (i < 0) continue;
      list.splice(i, 1);
      if (role === "core") ensureMain();
      render();
      return true;
    }
    return false;
  }

  /* ── DOM ── */
  function hostRoot() {
    const pane = qid("researchPane");
    if (!pane) return null;
    return pane.querySelector(".rs-main") || pane;
  }
  function build() {
    const h = hostRoot();
    if (!h) return null;
    let box = qid("rsInit");
    if (!box) {
      box = el("div", "rs-init");
      box.id = "rsInit";
      h.appendChild(box);
    } else if (box.parentElement !== h) {
      h.appendChild(box);
    }
    RI.built = true;
    return box;
  }
  function render() {
    const box = build();
    if (!box) return;
    box.classList.toggle("show", !!RI.open);
    if (!RI.open) {
      box.innerHTML = "";
      return;
    }
    box.innerHTML = "";
    box.appendChild(renderSheet());
  }

  /* 整块画布：顶部课题（横跨）→ 左右两区（可拖分隔条）→ 底部动作条 */
  function renderSheet() {
    const sheet = el("div", "rs-init-sheet");
    sheet.appendChild(renderHead());
    const cols = el("div", "rs-init-cols");
    const coreCol = renderCol("core");
    coreCol.style.flex = "0 0 " + (RI.split * 100).toFixed(2) + "%";
    const refCol = renderCol("ref");
    refCol.style.flex = "1 1 auto";
    const split = el("div", "rs-init-split");
    split.title = t("拖动调整两栏宽度（比例会记住）");
    split.appendChild(el("i", "rs-init-split-grip"));
    bindSplit(split);
    cols.appendChild(coreCol);
    cols.appendChild(split);
    cols.appendChild(refCol);
    sheet.appendChild(cols);
    sheet.appendChild(renderFoot());
    return sheet;
  }
  function bindSplit(sp) {
    sp.addEventListener("mousedown", (ev) => {
      if (ev.button !== 0) return;
      ev.preventDefault();
      const cols = sp.parentElement;
      if (!cols) return;
      const rect = cols.getBoundingClientRect();
      const total = rect.width || 1;
      sp.classList.add("dragging");
      const move = (e2) => {
        const pct = Math.max(18, Math.min(82, ((e2.clientX - rect.left) / total) * 100));
        RI.split = clampSplit(pct / 100);
        const core = cols.querySelector('.rs-init-col[data-col="core"]');
        const ref = cols.querySelector('.rs-init-col[data-col="ref"]');
        if (core) core.style.flex = "0 0 " + pct.toFixed(2) + "%";
        if (ref) ref.style.flex = "1 1 auto";
      };
      const up = () => {
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
        sp.classList.remove("dragging");
        saveSplit();
      };
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    });
  }

  function renderHead() {
    const head = el("div", "rs-init-head");
    const row = el("div", "rs-init-head-row");
    row.appendChild(el("b", "rs-init-title", RI.existing ? t("添加资料") : t("研究初始化")));
    const s = stats();
    if (s.total) {
      const chip = el(
        "span",
        "rs-init-chip" + (s.failed ? " bad" : s.finished >= s.total ? " done" : " on"),
        t("已入队 ") + s.finished + "/" + s.total + (s.failed ? " · " + t("失败") + " " + s.failed : ""),
      );
      row.appendChild(chip);
    }
    row.appendChild(
      el(
        "span",
        "rs-init-sub",
        RI.existing
          ? t("旧条目只读；新条目接着排队（id 往后排，旧状态一项不动）")
          : t("三块同屏：课题、核心文件、参考资料。点「开始处理」才会创建 research/ 并交给 agent。"),
      ),
    );
    head.appendChild(row);

    const fields = el("div", "rs-init-fields");
    const f1 = el("label", "rs-init-field");
    f1.appendChild(el("span", "rs-init-label", t("课题名称")));
    const nameIn = el("input", "rs-init-input");
    nameIn.value = RI.topic || "";
    nameIn.placeholder = t("这张画布在研究什么");
    nameIn.oninput = () => {
      RI.topic = nameIn.value;
    };
    f1.appendChild(nameIn);
    const f2 = el("label", "rs-init-field");
    f2.appendChild(el("span", "rs-init-label", t("核心问题")));
    const qIn = el("input", "rs-init-input");
    qIn.value = RI.question || "";
    qIn.placeholder = t("一句话写清最想回答的问题（可以留空）");
    qIn.oninput = () => {
      RI.question = qIn.value;
    };
    f2.appendChild(qIn);
    fields.appendChild(f1);
    fields.appendChild(f2);
    head.appendChild(fields);

    if (s.total) {
      const bar = el("div", "rs-init-bar");
      const fill = el("i", "rs-init-bar-fill");
      fill.style.width = s.pct + "%";
      bar.appendChild(fill);
      head.appendChild(bar);
    }
    return head;
  }

  /* 一栏：头（标题 + 计数）→ 拖放区 → 录入 / 预览 → 新条目 → 已入队 → 脚（两枚加料按钮） */
  function renderCol(role) {
    const isCore = role === "core";
    const list = listOf(role);
    const col = el("div", "rs-init-col" + (isCore ? " rs-init-col-core" : ""));
    col.dataset.col = role;

    const head = el("div", "rs-init-col-head");
    head.appendChild(el("span", "rs-init-col-title", isCore ? t("核心文件") : t("参考资料")));
    head.appendChild(el("span", "rs-init-col-count", String(list.length)));
    head.appendChild(
      el(
        "span",
        "rs-init-col-hint",
        isCore ? t("我在写的东西（tex / doc / ppt / 文本 / 链接）") : t("外部资料（PDF / arXiv / DOI / 笔记 / 检索式）"),
      ),
    );
    col.appendChild(head);

    const body = el("div", "rs-init-col-body");
    body.dataset.drop = role;
    const drop = el("div", "rs-init-drop");
    drop.innerHTML =
      "<b>" + esc(isCore ? t("拖入核心文件") : t("拖入参考资料")) + "</b><span>" +
      esc(isCore ? t("tex / doc / ppt / md / txt") : t("PDF / 文献 PDF / 网页存档 / bib")) +
      "</span>";
    drop.addEventListener("dragover", (ev) => {
      ev.preventDefault();
      drop.classList.add("on");
    });
    drop.addEventListener("dragleave", () => drop.classList.remove("on"));
    drop.addEventListener("drop", async (ev) => {
      ev.preventDefault();
      drop.classList.remove("on");
      const paths = pathsFromDrop(ev.dataTransfer);
      if (!paths.length) return toastSafe(t("没拿到文件路径（试试「选择文件…」）"), "warn");
      addFiles(role, paths);
      await fillSizes(role);
    });
    body.appendChild(drop);

    if (RI.composer && RI.composer.role === role) body.appendChild(renderComposer(role));
    if (RI.preview && RI.preview.role === role) body.appendChild(renderPreview(role));

    const listEl = el("div", "rs-init-list");
    if (!list.length) listEl.appendChild(el("div", "rs-init-empty", t("还没有投料")));
    for (const e of list) listEl.appendChild(renderEntry(role, e));
    /* 跨栏拖动：把一条从这一栏拖到另一栏 */
    body.addEventListener("dragover", (ev) => {
      if (!ev.dataTransfer || ev.dataTransfer.types.indexOf("text/plain") < 0) return;
      ev.preventDefault();
      body.classList.add("drop-on");
    });
    body.addEventListener("dragleave", () => body.classList.remove("drop-on"));
    body.addEventListener("drop", (ev) => {
      const rid = ev.dataTransfer ? ev.dataTransfer.getData("text/plain") : "";
      body.classList.remove("drop-on");
      if (!rid) return;
      ev.preventDefault();
      moveEntry(rid, role);
    });
    body.appendChild(listEl);
    body.appendChild(renderQueued(role));
    col.appendChild(body);

    const foot = el("div", "rs-init-col-foot");
    const pick = el("button", "rs-btn", t("选择文件…"));
    pick.onclick = () => pickFiles(role);
    foot.appendChild(pick);
    const addText = el("button", "rs-btn", "＋ " + t("文本 / 链接"));
    addText.title = t("贴 arXiv / DOI / 网页链接，或直接写一段笔记（一行一条）");
    addText.onclick = () => {
      RI.preview = null;
      RI.composer = { role, mode: "auto", text: "" };
      RI.editing = "";
      render();
      const ta = qid("rsInitComposer");
      if (ta) ta.focus();
    };
    foot.appendChild(addText);
    const addQuery = el("button", "rs-btn", "＋ " + t("检索式"));
    addQuery.title = t("交给 agent 去检索，取前 5 篇作为参考资料自动入队");
    addQuery.onclick = () => {
      RI.preview = null;
      RI.composer = { role, mode: "query", text: "" };
      RI.editing = "";
      render();
      const ta = qid("rsInitComposer");
      if (ta) ta.focus();
    };
    foot.appendChild(addQuery);
    col.appendChild(foot);
    return col;
  }

  function renderComposer(role) {
    const c = RI.composer;
    const box = el("div", "rs-init-composer");
    box.appendChild(
      el(
        "div",
        "rs-init-composer-head",
        (c.mode === "query" ? t("检索式：交给 agent 去检索") : t("文本项：链接 / DOI / arXiv / 笔记（一行一条）")) +
          " · " +
          (role === "core" ? t("投到核心文件") : t("投到参考资料")),
      ),
    );
    const ta = el("textarea", "rs-init-textarea");
    ta.id = "rsInitComposer";
    ta.rows = 3;
    ta.value = c.text || "";
    ta.placeholder =
      c.mode === "query"
        ? t("例如：diffusion model long-context efficiency")
        : t("例如：https://arxiv.org/abs/2106.12345（也可以直接写一段摘录）");
    ta.oninput = () => {
      c.text = ta.value;
    };
    box.appendChild(ta);
    const ops = el("div", "rs-init-composer-ops");
    const ok = el("button", "rs-btn primary", t("解析并添加"));
    ok.onclick = () => commitComposer();
    ops.appendChild(ok);
    const cancel = el("button", "rs-btn", t("取消"));
    cancel.onclick = () => {
      RI.composer = null;
      render();
    };
    ops.appendChild(cancel);
    ops.appendChild(el("span", "rs-init-tip", t("多行会先给你过一眼再添加")));
    box.appendChild(ops);
    return box;
  }

  function renderPreview(role) {
    const p = RI.preview;
    const box = el("div", "rs-init-preview");
    box.appendChild(el("div", "rs-init-preview-head", t("确认这 ") + (p.rows || []).length + t(" 条（可改类型 / 可删）")));
    const list = el("div", "rs-init-preview-list");
    p.rows.forEach((r, i) => {
      const row = el("div", "rs-init-preview-row");
      const roleSel = el("select", "rs-init-mini");
      for (const [v, label] of [
        ["core", t("核心文件")],
        ["ref", t("参考资料")],
      ]) {
        const o = el("option", null, label);
        o.value = v;
        if ((r.role || role) === v) o.selected = true;
        roleSel.appendChild(o);
      }
      roleSel.onchange = () => {
        r.role = roleSel.value;
      };
      const typeSel = el("select", "rs-init-mini");
      for (const [v, label] of [
        ["url", t("网页链接")],
        ["text", t("文字笔记")],
        ["query", t("检索式")],
      ]) {
        const o = el("option", null, label);
        o.value = v;
        if (r.source === v) o.selected = true;
        typeSel.appendChild(o);
      }
      typeSel.onchange = () => {
        r.source = typeSel.value;
      };
      const valueIn = el("input", "rs-init-input rs-init-mini-value");
      valueIn.value = String(r.value || "");
      valueIn.oninput = () => {
        r.value = valueIn.value;
      };
      const del = el("button", "rs-init-x", "✕");
      del.title = t("这条不要了");
      del.onclick = () => {
        p.rows.splice(i, 1);
        render();
      };
      row.appendChild(roleSel);
      row.appendChild(typeSel);
      row.appendChild(valueIn);
      row.appendChild(del);
      list.appendChild(row);
    });
    box.appendChild(list);
    const ops = el("div", "rs-init-composer-ops");
    const ok = el("button", "rs-btn primary", t("加入 ") + (p.rows || []).length + t(" 条"));
    ok.onclick = () => commitPreview();
    ops.appendChild(ok);
    const cancel = el("button", "rs-btn", t("取消"));
    cancel.onclick = () => {
      RI.preview = null;
      render();
    };
    ops.appendChild(cancel);
    box.appendChild(ops);
    return box;
  }

  const SOURCE_ICON = { file: "📄", url: "🔗", text: "✎", query: "🔎" };
  const SOURCE_LABEL = { file: "文件", url: "网页链接", text: "文字笔记", query: "检索式" };
  function renderEntry(role, e) {
    const row = el("div", "rs-entry" + (e.main ? " is-main" : ""));
    row.dataset.rid = e.rid;
    row.dataset.source = e.source;
    row.draggable = true;
    row.addEventListener("dragstart", (ev) => {
      if (!ev.dataTransfer) return;
      ev.dataTransfer.setData("text/plain", e.rid);
      ev.dataTransfer.effectAllowed = "move";
    });

    const main = el("div", "rs-entry-main");
    main.appendChild(el("span", "rs-entry-icon", SOURCE_ICON[e.source] || "•"));
    const titleWrap = el("div", "rs-entry-title-wrap");
    const title = el("div", "rs-entry-title", e.title || e.name || t("未命名"));
    title.title = e.source === "file" ? e.src : e.source === "text" ? e.text : e.src;
    titleWrap.appendChild(title);
    const metaBits = [t(SOURCE_LABEL[e.source] || "文件")];
    if (e.source === "file" && e.size) metaBits.push(fmtSize(e.size));
    if (e.main) metaBits.push(t("主稿"));
    if (e.note) metaBits.push("📝");
    titleWrap.appendChild(el("div", "rs-entry-meta", metaBits.join(" · ")));
    if (e.source !== "file" && e.src) titleWrap.appendChild(el("div", "rs-entry-url", e.src));
    if (e.source === "text" && e.text) titleWrap.appendChild(el("div", "rs-entry-url", C().clip(e.text, 90)));
    main.appendChild(titleWrap);
    row.appendChild(main);

    const btns = el("div", "rs-entry-btns");
    if (role === "core") {
      const star = el("button", "rs-entry-star" + (e.main ? " on" : ""), e.main ? "★" : "☆");
      star.title = t("标为主稿（课题正文以它为准）");
      star.onclick = () => {
        for (const x of RI.core) x.main = false;
        e.main = true;
        render();
      };
      btns.appendChild(star);
    }
    const edit = el("button", "rs-entry-btn", t("编辑条目"));
    edit.title = t("改标题 / 写一句给 agent 的交代");
    edit.onclick = () => {
      RI.editing = RI.editing === e.rid ? "" : e.rid;
      RI.composer = null;
      RI.preview = null;
      render();
    };
    btns.appendChild(edit);
    const del = el("button", "rs-entry-x", "✕");
    del.title = t("从清单里移除（不会删原文件）");
    del.onclick = () => removeEntry(e.rid);
    btns.appendChild(del);
    row.appendChild(btns);

    if (RI.editing === e.rid) row.appendChild(renderEntryEdit(role, e));
    return row;
  }
  function renderEntryEdit(role, e) {
    const box = el("div", "rs-entry-edit");
    const lt = el("label", "rs-init-field");
    lt.appendChild(el("span", "rs-init-label", t("条目标题")));
    const ti = el("input", "rs-init-input");
    ti.value = e.title || "";
    ti.oninput = () => {
      e.title = ti.value;
    };
    lt.appendChild(ti);
    box.appendChild(lt);

    if (e.source === "url" || e.source === "query") {
      const ls = el("label", "rs-init-field");
      ls.appendChild(el("span", "rs-init-label", e.source === "query" ? t("检索式") : t("链接")));
      const si = el("input", "rs-init-input");
      si.value = e.src || "";
      si.oninput = () => {
        e.src = si.value;
      };
      ls.appendChild(si);
      box.appendChild(ls);
    }
    if (e.source === "text") {
      const lc = el("label", "rs-init-field");
      lc.appendChild(el("span", "rs-init-label", t("条目内容")));
      const ta = el("textarea", "rs-init-textarea");
      ta.rows = 3;
      ta.value = e.text || "";
      ta.oninput = () => {
        e.text = ta.value;
      };
      lc.appendChild(ta);
      box.appendChild(lc);
    }
    const ln = el("label", "rs-init-field");
    ln.appendChild(el("span", "rs-init-label", t("备注 / 给 agent 的指示")));
    const na = el("textarea", "rs-init-textarea");
    na.rows = 2;
    na.value = e.note || "";
    na.placeholder = t("例如：重点看第 4 节；只要实证部分");
    na.oninput = () => {
      e.note = na.value;
    };
    ln.appendChild(na);
    box.appendChild(ln);

    const ops = el("div", "rs-init-composer-ops");
    const done = el("button", "rs-btn primary", t("收起编辑"));
    done.onclick = () => {
      RI.editing = "";
      render();
    };
    ops.appendChild(done);
    const mv = el("button", "rs-btn", role === "core" ? t("移到参考资料 →") : t("← 移到核心文件"));
    mv.title = t("在这一栏与另一栏之间移动（也可以直接拖过去）");
    mv.onclick = () => moveEntry(e.rid, role === "core" ? "ref" : "core");
    ops.appendChild(mv);
    box.appendChild(ops);
    return box;
  }

  /* 已入队：只读 + 逐项状态（就地显示 待抓取 / 已转 md / 仅摘要 / 失败） */
  function renderQueued(role) {
    const items = ((RI.queue && RI.queue.items) || []).filter((it) => (it.role === "core" ? "core" : "ref") === role);
    const box = el("div", "rs-queue");
    box.appendChild(el("div", "rs-queue-head", t("已入队 · ") + items.length));
    if (!items.length) {
      box.appendChild(el("div", "rs-init-empty", t("还没有入队项")));
      return box;
    }
    for (const it of items) {
      const ph = C().initItemPhase(it);
      /* 已处理标记取自队列文件（processed / status=done），和主视图同一口径 */
      const marked = C().initItemMarked(it);
      const row = el("div", "rs-queue-row st-" + ph + (marked ? " st-processed" : ""));
      row.dataset.id = it.id;
      row.appendChild(el("span", "rs-queue-dot"));
      const name = el("span", "rs-queue-name", (it.main ? "★ " : "") + (it.title || it.rel || it.mdRel || it.id));
      name.title = [it.url || it.query || it.rel || it.mdRel || "", it.error || ""].filter(Boolean).join("\n");
      row.appendChild(name);
      const tags = el("span", "rs-queue-tags");
      tags.appendChild(el("span", "rs-queue-src", t(SOURCE_LABEL[it.source || "file"] || "文件")));
      if (it.hitBy) {
        const hit = el("span", "rs-queue-tag", t("由检索式命中"));
        hit.title = it.hitBy;
        tags.appendChild(hit);
      }
      row.appendChild(tags);
      const st = el("span", "rs-queue-st" + (marked ? " rs-queue-st-marked" : ""), phaseLabel(ph, marked));
      st.title = marked ? t("初始化已完成，关掉投料台也能看到") : "";
      row.appendChild(st);
      const at = marked ? fmtAt(it.processedAt) : "";
      if (at) {
        const when = el("span", "rs-queue-at", at);
        when.title = t("处理完成时间");
        row.appendChild(when);
      }
      if (ph === "failed") {
        const retry = el("button", "rs-queue-btn", t("重试此条"));
        retry.title = t("把这一项改回待处理并让 agent 重跑");
        retry.onclick = () => retryOne(it.id);
        row.appendChild(retry);
      }
      if ((it.status || "pending") === "pending" && it.hitBy) {
        const drop = el("button", "rs-queue-btn", t("剔除"));
        drop.title = t("这条不相关：从队列里去掉，并记进 literature/queries.jsonl");
        drop.onclick = () => dropItem(it.id);
        row.appendChild(drop);
      }
      box.appendChild(row);
    }
    return box;
  }
  /* 状态文案：marked（初始化已处理）只换文案，不新增状态枚举。
   * 只抓到摘要的那条虽然也算「已处理」，但「存疑」这个事实不能因此消失 —— 两条一起给。 */
  function phaseLabel(ph, marked) {
    if (marked) {
      const done = "✓ " + t("已处理");
      return ph === "summary" ? done + " · " + t("仅摘要（存疑）") : done;
    }
    return (
      {
        pending: t("待处理"),
        fetch: t("待抓取"),
        running: t("处理中"),
        done: t("已转 md"),
        summary: t("仅摘要（存疑）"),
        failed: t("失败"),
        skipped: t("跳过"),
      }[ph] || t("待处理")
    );
  }
  /* 处理时间：今天只给时分，今年给「M月D日 HH:MM」，跨年补年份 */
  function fmtAt(ms) {
    const n = Number(ms) || 0;
    if (!n) return "";
    const d = new Date(n);
    if (!isFinite(d.getTime())) return "";
    const pad = (v) => (v < 10 ? "0" + v : String(v));
    const hm = pad(d.getHours()) + ":" + pad(d.getMinutes());
    const now = new Date();
    if (d.getFullYear() !== now.getFullYear()) return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " + hm;
    if (d.getMonth() === now.getMonth() && d.getDate() === now.getDate()) return hm;
    return d.getMonth() + 1 + t("月") + d.getDate() + t("日 ") + hm;
  }

  function renderFoot() {
    const foot = el("div", "rs-init-foot");
    const wrap = el("div", "rs-init-foot-left");
    const errEl = el("div", "rs-init-err", RI.err || "");
    wrap.appendChild(errEl);
    const s = stats();
    const cnt =
      t("核心 ") + RI.core.length + t(" 条 · 参考 ") + RI.refs.length + t(" 条") +
      (s.total ? " ｜ " + t("已入队 ") + s.total + " · " + t("完成 ") + s.finished : "");
    wrap.appendChild(el("div", "rs-init-tip", cnt));
    foot.appendChild(wrap);
    foot.appendChild(el("span", "rs-grow"));

    if (s.failed) {
      const retry = el("button", "rs-btn", t("重试失败的 ") + s.failed + t(" 项"));
      retry.onclick = () => retryFailed();
      foot.appendChild(retry);
    }
    if (s.total && queueFinished()) {
      const g = el("button", "rs-btn", t("转为图谱"));
      g.title = t("解析全部笔记，重建知识图谱");
      g.onclick = () => toGraph();
      foot.appendChild(g);
      /* 补跑：老库（上一版初始化跑出来的）没有术语页 / 3-Pass 变体 / 节级三档。
         不自动烧 Token，这里给一颗手动入口 —— 点它才派一条任务给同一条初始化会话。 */
      const more = el("button", "rs-btn", t("补跑一层"));
      more.title = t(
        "给已经入库的原文补上：术语页第一层（terms/）、3-Pass 变体（略读 / 关键概念 / 技术细节）、节级三档（# 节级三档）。会消耗 Token。",
      );
      more.onclick = () => backfill();
      foot.appendChild(more);
      /* 交棒：处理完就不该只靠这个窗口，一键回主视图看已处理内容 */
      if (C().processedList(RI.queue).length) {
        const v = el("button", "rs-btn", t("查看已处理内容"));
        v.title = t("关掉投料台，回研究视图并定位到第一篇已处理的笔记");
        v.onclick = () => viewProcessed();
        foot.appendChild(v);
      }
    }
    const closeBtn = el("button", "rs-btn", RI.existing ? t("取消") : t("暂不初始化"));
    closeBtn.onclick = () => close();
    foot.appendChild(closeBtn);

    const pending = RI.core.length + RI.refs.length;
    const start = el("button", "rs-btn primary", RI.busy ? t("初始化中…") : pending ? t("开始处理（") + pending + t(" 条）") : t("开始处理"));
    start.disabled = !!RI.busy;
    start.onclick = () => startInit();
    foot.appendChild(start);
    return foot;
  }

  /* ── 补跑一层（老库）──
     上一版初始化只写了三层折叠与论断/概念：没有术语页、没有 3-Pass 变体、折叠里也没有节级三档。
     这些都要花 Token，所以**不自动补**，只在这颗按钮被点时发一条任务给同一条初始化会话；
     具体缺什么由 agent 读盘判断（它看得到 research/ 里已经有什么）。 */
  function backfill() {
    const root = rootOf();
    if (!root) {
      toastSafe(t("研究目录还没就绪"), "warn");
      return;
    }
    const st = findInitSession(root);
    if (!st || typeof agentSessionSend !== "function") {
      toastSafe(t("这条初始化会话已经关掉了：重开投料台再点「开始处理」即可接着用"), "warn");
      return;
    }
    const L = [];
    L.push("按技能 mtnode-research 给这个研究目录**补一层**（只补缺的，不许重写已有的、不许动 notes/ 里人工写的稿子）。");
    L.push("");
    L.push("逐篇检查 `core/*.md` 与它的 `literature/folds/<key>.md`，按下面三项补齐：");
    L.push("");
    L.push("1. **节级三档**：折叠文件里若没有 `# 节级三档` 这一段，就按原文的 `##` 小节补上 ——");
    L.push("   逐节写 `## s0001 · <小节标题>`（s 编号从 1 起、四位补零），每节下三档：");
    L.push("   `**一句话**`（这一节一句话干了什么）/ `**一段话**`（80–160 字）/ `**原文**`（原文照抄，公式与 `![…](…/assets/…)` 相对路径原样保留）。");
    L.push("   frontmatter 补 `secLevel: para`（没有 `secPins` 就写空）。原有三层折叠内容一个字都不许改。");
    L.push("2. **术语页第一层**：`terms/` 里还没有页时，从原文归纳 8–20 篇 `terms/<slug>.md`（六种 kind：term / concept / formula / symbol / theorem / method / dataset）；");
    L.push("   frontmatter 带 `title / kind / slug / derives: [原文标题] / sources: [原文标题 · §小节] / origin: init / verify: unverified / init: done / date`，不写 parent；");
    L.push("   正文骨架 `# 名` → `> [!term] 名` 一句定义 → `## 直觉` → 有公式才 `## 公式 / 记号` → `## 在原文里` → `## 还能引申`（`> [!question] 待展开` + `> - [[下层术语]]`）。");
    L.push("   原文里已有的图直接引相对路径，不生成新图；要画流程才用 ```mermaid（≤12 节点）；原文没写的写「原文没有展开」，不许编。");
    L.push("3. **3-Pass 变体**：每篇原文缺哪份就补哪份 —— `<原名>.skim.md`（略读：贡献 / 证据 / 局限，200–320 字）、");
    L.push("   `<原名>.concept.md`（关键概念：3–6 个，每个：简要定义 + 简化解释，优先引原文的图）、`<原名>.tech.md`（技术细节：方法步骤 / 公式原样 / 实验设置与关键数字）。");
    L.push("   frontmatter 写 `derived: skim|concept|tech`、`parent: <原文路径>`；旧的 `.summary.md` / `.excerpt.md` 留在盘上别动，但不要再新写这两种。");
    L.push("");
    L.push("做完回一段话：补了哪几项、各多少篇、还有哪些没补（以及为什么）。");
    try {
      agentSessionSend(L.join("\n"), { sessionId: st.id });
    } catch (e) {
      toastSafe(String((e && e.message) || e), "err");
      return;
    }
    toastSafe(t("已派「补跑一层」：术语页 / 3-Pass 变体 / 节级三档，进度看那条初始化会话"), "ok");
  }

  /* ── 开始初始化 ── */
  /* 落盘重名：同批次用过的（used）与磁盘上已有的都算冲突，`a.pdf` → `a-2.pdf`。
     不能每次从 rel 重新算 —— 磁盘上那一份不在 set 里时唯一性判断会原地打转。 */
  async function uniqueOnDisk(root, rel, used) {
    const C0 = C();
    const taken = new Set(used || []);
    let cand = C0.uniqueRel(rel, taken);
    let guard = 0;
    while ((await existsP(joinP(root, cand))) && guard++ < 100) {
      taken.add(cand);
      cand = C0.uniqueRel(rel, taken);
    }
    return cand;
  }
  /* PDF 图元落盘（研究投料专用）：正文里的 {{FIG:name}} / {{PAGE:n}} 换成真图 +
     相对路径 assets/<md 词干>/<name>（相对 md 自己的目录 —— core 项就是 research/core/assets/<mdBase>/，
     ref 项就是 research/literature/sources/assets/<key>/）。落盘 / 单页出图只走
     renderer/pdf-markdown.js 那一份实现（pdfMaterializeFigures，页图内部走 fileRenderPdfPages），
     这里只做三件事：把 md 绝对路径当落盘基准传进去、把 note 收成可留痕的文本、
     有图没落成就把说明附在正文末尾（正文里绝不留 {{…}} 或指向不存在文件的链接）。
     返回 { markdown, figures, pages, images }（images = 落盘图总数，写进 frontmatter 的 figures:）。 */
  async function materializeFigures(text, parsed, pdfAbs, mdAbs) {
    const body = String(text || "");
    const out = { markdown: body, figures: 0, pages: 0, images: 0 };
    if (typeof pdfMaterializeFigures !== "function") {
      console.warn("[research-init] 缺少 PDF 图元落盘内核（pdf-markdown.js 没加载），图元未落盘：" + mdAbs);
      return out;
    }
    const notes = [];
    let r = null;
    try {
      r = await pdfMaterializeFigures(
        body,
        parsed,
        pdfAbs,
        { note: (l) => notes.push(String(l)) },
        { writePath: mdAbs },
      );
    } catch (e) {
      notes.push(String((e && e.message) || e));
    }
    out.markdown = String((r && r.markdown) || body);
    out.figures = Number((r && r.figures) || 0);
    out.pages = Number((r && r.pages) || 0);
    out.images = out.figures + out.pages;
    for (const l of notes) console.warn("[research-init] PDF 图元 · " + mdAbs + " · " + l);
    /* 原本要落几张 / 实际落了几张：少了就把失败说明附在正文末尾，不吞错也不留坏引用 */
    const wantFig = (body.match(/\{\{\s*FIG:/g) || []).length;
    const wantPage = [];
    const scan = /\{\{\s*PAGE:(\d+)\s*\}\}/g;
    let m;
    while ((m = scan.exec(body))) {
      const n = Number(m[1]);
      if (n > 0 && wantPage.indexOf(n) < 0) wantPage.push(n);
    }
    if (out.figures < wantFig || out.pages < wantPage.length) {
      out.markdown +=
        "\n> [!warning] 图元没能全部落盘（正文里的占位已去掉，不留坏链接）\n" +
        (notes.length ? notes.map((l) => "> · " + l).join("\n") : "> · （没有更多说明）") +
        "\n";
    }
    return out;
  }

  async function startInit() {
    if (RI.busy) return;
    RI.err = "";
    if (!RI.ws) {
      RI.err = t("这张画布还没有工作目录：先在画布顶栏设置，再回来初始化。");
      render();
      return;
    }
    const topic = String(RI.topic || RI.wfName || "").trim();
    if (!topic) {
      RI.err = t("先写一个课题名（只要有课题名就能开始，资料以后再补）。");
      render();
      return;
    }
    const entries = RI.core.length + RI.refs.length;
    /* 只发指示也能跑（增量补料时说一句「按这个侧重」，不必非建条目）；
       条目与指示都没有才是空跑 */
    const instruction = String(RI.instruction || "").trim();
    if (RI.existing && !entries && !instruction) {
      RI.err = t("这一轮没有新条目：先加文件 / 链接 / 笔记 / 检索式，再点开始处理。");
      render();
      return;
    }
    RI.busy = true;
    RI.err = "";
    render();
    /* 这一轮的令牌：跑完时若界面已被关掉（换画布 / 回闸门 = close() 把 runSeq 加了），
       队列仍属于原来那张画布，但投料台不该自己再弹回来（用户报的「切画布后初始化界面还在」）。 */
    const runSeq = RI.runSeq;
    const root = rootOf();
    try {
      await ensureDirs(root);
      const used = new Set();
      const items = [];
      for (const role of ["core", "ref"]) {
        for (const e of listOf(role)) {
          if (e.source === "file") {
            const dir = role === "core" ? "core/" : "literature/sources/";
            const rel = await uniqueOnDisk(root, dir + baseName(e.src), used);
            used.add(rel);
            const r = await window.api.fileCopy(e.src, joinP(root, rel));
            if (!r || r.ok === false) throw new Error((r && r.error) || t("复制失败：") + baseName(e.src));
            items.push({ role, source: "file", src: e.src, rel, title: e.title, main: !!e.main });
          } else {
            items.push({
              role,
              source: e.source,
              url: e.source === "url" ? e.src : "",
              query: e.source === "query" ? e.src : "",
              text: e.source === "text" ? e.text : "",
              title: e.title,
              note: e.note,
              main: !!e.main,
            });
          }
        }
      }
      /* 主稿只能有一个：没标就取第一条核心 */
      let mainSeen = false;
      for (const it of items) {
        if (it.role !== "core") continue;
        if (it.main && !mainSeen) mainSeen = true;
        else it.main = false;
      }
      if (!mainSeen) {
        const first = items.find((x) => x.role === "core");
        if (first) first.main = true;
      }
      const q = C().buildInitQueue({ topic, question: RI.question || "", items });
      /* 非文件项：正文骨架现在就落盘（标题 + 来源 + 用户交代 + 待抓取），agent 抓到内容后替换末节 */
      for (const it of q.items) {
        if (!it.source || it.source === "file") continue;
        const rel = await uniqueOnDisk(root, it.mdRel, used);
        it.mdRel = rel;
        used.add(rel);
        await window.api.fileWriteText(joinP(root, rel), C().initFetchDoc(it));
      }
      /* PDF 先就地转 md：复用应用内 PDF 解析内核（与「PDF 入库」同一份），
         不让 agent 为每篇 PDF 现写解析器。扫描件 / 解析失败就留空，交给 agent 尽力。
         图元一起取回来（figures:true）并按 md 位置落盘：core 项 → core/assets/<mdBase>/，
         ref 项 → literature/sources/assets/<key>/（两者都是「md 同目录的 assets/<md 词干>/」）。 */
      for (const it of q.items) {
        if (it.kind !== "pdf" || it.mdDone) continue;
        if (it.status === "done") continue; /* 旧批次里已处理完的不再重转 */
        const mdAbs = joinP(root, it.mdRel);
        const st = await window.api.fileStat(mdAbs).catch(() => null);
        if (st && st.ok && st.size > 0) {
          it.mdDone = true;
          continue;
        }
        try {
          const pdfAbs = joinP(root, it.rel);
          const parsed = await window.api.fileParsePdf({ path: pdfAbs, figures: true });
          const text = String((parsed && (parsed.text || parsed.markdown)) || "");
          /* 没有文本层（扫描件 / 图片版）：仍走原分支，不因为图元逻辑变成「转成了」 */
          if (!text.trim()) {
            it.note = "no-text";
            continue;
          }
          const fig = await materializeFigures(text, parsed, pdfAbs, mdAbs);
          const head =
            "---\ntitle: " +
            JSON.stringify(it.title || it.key) +
            "\ntags: [pdf]\nsource: " +
            JSON.stringify(it.rel) +
            "\norigin: " +
            JSON.stringify(it.origin || it.rel) +
            "\nfigures: " +
            fig.images +
            "\ningestedAt: " +
            JSON.stringify(new Date().toISOString()) +
            "\n---\n\n# " +
            (it.title || it.key) +
            "\n\n";
          await window.api.fileWriteText(mdAbs, head + fig.markdown);
          it.mdDone = true;
        } catch (e) {
          it.note = "pdf-failed";
        }
      }
      /* 增量「＋ 添加资料」：接在旧队列后面，旧项的完成状态一个都不动（id 往后排） */
      let finalQ = q;
      const prev = RI.existing ? await readQueue() : null;
      if (prev && Array.isArray(prev.items) && prev.items.length) {
        finalQ = C().initQueueAppend(prev, q.items);
        finalQ.topic = topic;
        finalQ.question = RI.question || prev.question || "";
      }
      /* 只有课题、没有任何条目：队列空着，别让界面一直等进度 */
      if (!finalQ.items.length) finalQ.phase = "done";
      await writeJson(joinP(root, QUEUE_FILE), finalQ);
      RI.queue = finalQ;
      await writeResearchMeta(root, finalQ);
      await writeTopicNote(root, finalQ);
      const sess = await ignite(root, finalQ);
      RI.busy = false;
      /* 期间界面被关掉（换画布 / 回闸门）：队列与元信息已经落在原画布盘上，这里只收工，
         不再重开投料台、也不再回调 onDone（onDone 会把「当前这张新画布」的视图再刷一遍）。
         投料栏一样清空 —— 它们属于刚离开的那张画布，不能带到下一张去。 */
      if (RI.runSeq !== runSeq) {
        RI.core = [];
        RI.refs = [];
        RI.composer = null;
        RI.preview = null;
        RI.editing = "";
        RI.instruction = "";
        return;
      }
      /* 投过的料已经进了队列：清空两栏，免得下次「＋ 添加资料」把旧文件再复制一遍
         （课题与核心问题留着，增量补料还要用） */
      RI.core = [];
      RI.refs = [];
      RI.composer = null;
      RI.preview = null;
      RI.editing = "";
      RI.instruction = ""; // 指示已经随这一轮任务发出去，下一批重新给
      RI.err = sess.ok ? "" : t("队列已生成，但会话没起来：") + (sess.error || "");
      RI.open = true;
      render();
      schedulePoll();
      if (typeof RI.onDone === "function") {
        try {
          await RI.onDone({ queue: finalQ, sessionId: RI.sessionId });
        } catch (_) {}
      }
    } catch (e) {
      /* 半途失败要说清现场：已经复制进去的文件留在 research/ 里（再点一次会接着用，
         重名自动加 -2），别让用户以为目录是干净的 */
      RI.err = String((e && e.message) || e) + t("（已复制进 research/ 的文件会留着，重试可继续）");
      RI.busy = false;
      render();
    }
  }

  async function writeResearchMeta(root, q) {
    const p = joinP(root, "research.json");
    let meta = null;
    try {
      meta = JSON.parse((await readText(p)) || "null");
    } catch (_) {
      meta = null;
    }
    meta = meta || {};
    meta.ver = meta.ver || 1;
    meta.wfId = RI.wfId || meta.wfId || "";
    meta.title = q.topic || meta.title || t("未命名课题");
    meta.question = q.question || meta.question || "";
    if (!meta.corePath) meta.corePath = "notes/00-课题.md";
    if (!meta.createdAt) meta.createdAt = Date.now();
    meta.layout = meta.layout || "force";
    meta.init = { ver: 1, at: Date.now(), queue: QUEUE_FILE };
    meta.initSplit = clampSplit(RI.split);
    delete meta.win; /* 旧的浮窗几何不再使用 */
    await writeJson(p, meta);
  }

  /* 课题笔记：只做入口与索引，不吞正文（核心文件保真不动） */
  async function writeTopicNote(root, q) {
    const p = joinP(root, "notes", "00-课题.md");
    const title = q.topic || t("未命名课题");
    const cores = (q.items || []).filter((it) => it.role === "core");
    const lines = [
      "---",
      "title: " + JSON.stringify(title),
      "kind: topic",
      "core: true",
      "tags: [课题]",
      "verify: unverified",
      "date: " + new Date().toISOString().slice(0, 10),
      "---",
      "",
      "# " + title,
      "",
    ];
    if (q.question) {
      lines.push("> [!question] 核心问题", "> " + String(q.question).replace(/\n/g, "\n> "), "");
    }
    /* 没有核心文件就不写这一节（不再留空节与指向模板笔记的索引行） */
    if (cores.length) {
      lines.push("## 核心文件", "");
      for (const it of cores) {
        const where = it.source && it.source !== "file" ? "`" + it.mdRel + "`" : "`" + it.rel + "`";
        lines.push("- " + (it.main ? "**主稿**：" : "") + "[[" + it.title + "]] · " + where);
      }
      lines.push("");
    }
    await window.api.fileWriteText(p, lines.join("\n"));
  }

  /* ── 点火：新建专用会话 + 发任务 ── */
  function taskPrompt() {
    const head = "按技能 mtnode-research 的「初始化队列」一节处理研究初始化。";
    const instruction = String(RI.instruction || "").trim();
    const body = [
      "- 队列文件：`" + joinP(rootOf(), QUEUE_FILE).replace(/\\/g, "/") + "`（逐项把 status 从 pending 改成 running / done / failed，失败的写 error）",
      "- 顺序：逐篇串行，不要跳；每完成一项就回写一次队列（界面靠扫这个文件显示进度）。",
      "- 先看每一项的 `source`：",
      "  - `file`：已复制进 research/ 的文件，转成 md（PDF 多半已由应用内内核转好，`mdDone` 为 true 就别重转）。",
      "  - `url`：用户投的链接，`mdRel` 里已写好骨架（标题 / 来源 / 用户交代 / 待抓取）。用你的联网能力抓正文补进去；抓不到全文就退 Crossref / arXiv 元数据 + 摘要，并 `set <id> done --summary` 标成仅摘要。",
      "  - `text`：用户直接写的笔记，整理成正文即可，不需要抓取。",
      "  - `query`：用户投的检索式，按它检索，取前 5 篇用 `research-queue.mjs add` 追加成 ref 项（带 `--hit-by`），再逐项处理。",
      "- 参考资料另外要做：写 `literature/folds/<key>.md`（三层：全文 / 关键原句 / 主题，按段落分组共用段落 id）→ 文献条目进 `literature/library.json` → 抽论断与概念 → 建本篇的边。",
      "- 每篇处理完**还要多写两块**（都与上面同一份折叠文件、同一批原文）：",
      "  - 节级三档：在这份 `literature/folds/<key>.md` 里加一节 `# 节级三档`，按原文的 `##` 分节逐节写 `## s0001 · <小节标题>`，每节下三档 `**一句话**`（这一节一句话说清它干了什么）/ `**一段话**`（80–160 字，术语不缩写）/ `**原文**`（这一节原文，公式与图片相对路径原样保留，不许改写）。顶部 frontmatter 写 `secLevel: para` 与空的 `secPins`。这是**逐节换粒度**用的，和上面三层折叠互不覆盖。",
      "  - 三层折叠与节级三档是两套机制：折叠按段落折（全文 / 关键原句 / 主题），节级按小节给三档；两处都写，别互相替代。",
      "- 术语页（第一层，自动）：核心原文都入库后，从原文里归纳术语 / 公式页，每页一个文件 `terms/<slug>.md`：",
      "  - 种类只有六种：术语 / 概念、公式、符号约定、定理 · 命题 · 引理、方法 · 算法、数据集 · 实验设置；合计 8–20 页（原文短就少，宁少不多）。",
      "  - frontmatter 必须带：`title`、`kind`（term / concept / formula / symbol / theorem / method / dataset）、`slug`、`derives: [原文标题…]`（从哪几篇长出来的）、`sources: [原文标题 · §小节]`、`origin: init`、`verify: unverified`、`init: done`、`date`。",
      "  - 正文骨架：`# 名字` → `> [!term] 名字` 加一句能独立看懂的定义 → `## 直觉`（简化解释 / 极端例子 / 它排除了什么）→ 有公式才写 `## 公式 / 记号`（LaTeX 原样）→ `## 在原文里`（sources 逐条 + 它出现在哪一节）→ `## 还能引申`（`> [!question] 待展开` 再列 0–4 个 `> - [[下层术语]]`）。",
      "  - 直觉那段是重点：让人不看原文也能懂；不许编，原文没写就写「原文没有展开」。图优先引原文的 `![…](../core/assets/…)`，要画流程才用 ```mermaid（≤12 节点）。",
      "  - 不许给术语页写 parent（父页方向由 derives 表达，写了会在图上多一条对顶的线）。",
      "- 变体：默认变体表已改成 3-Pass（略读 `.skim` / 关键概念 `.concept` / 技术细节 `.tech`）＋中译 / 英译共五条；不要再用 summary / excerpt 这两个旧后缀。三份都从原文派生，各自独立成文件、frontmatter 写 `derived: skim|concept|tech` 与 `parent: <原文路径>`。",
      "- 全部处理完：跑一轮全局建边，然后把队列 phase 改成 done。",
    ];
    /* 这一批随投料给的指示压在最前（条目说明之前）：先说取舍 / 侧重，再说每条怎么处理 */
    if (instruction) {
      body.unshift("- 用户这次随投料给的指示：" + instruction + "（按它决定取舍 / 侧重，不要自行扩大范围）", "");
    }
    return [head, ""].concat(body).join("\n");
  }
  /* 找上一次那条初始化会话（判据：工作区就是 research/ 且标题带「研究初始化」） */
  function findInitSession(root) {
    try {
      const list = typeof agentSessions === "function" ? agentSessions() : [];
      const dir = String(root || "").replace(/[\\/]+$/, "");
      return (
        list.find(
          (s) =>
            s &&
            !s.archived &&
            String(s.workspace || "").replace(/[\\/]+$/, "") === dir &&
            String(s.title || "").indexOf(t("研究初始化")) === 0,
        ) || null
      );
    } catch (_) {
      return null;
    }
  }
  async function ignite(root, q) {
    if (typeof newAgentSession !== "function" || typeof agentSessionSend !== "function") {
      return { ok: false, error: t("会话能力尚未就绪") };
    }
    /* 增量补料：上一次那条初始化会话还在（工作区就是这个 research/）就继续用它，
       别再开第二条同题会话，否则进度与上下文都劈成两半。
       复用前提是 research/ 真的还在（research.json 存在）：目录被删过就重新开会话。 */
    const alive = await existsP(joinP(root, "research.json"));
    let st = alive ? findInitSession(root) : null;
    if (st) {
      RI.sessionId = st.id;
      try {
        agentSessionSend(taskPrompt(), { sessionId: st.id });
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e) };
      }
      return { ok: true, reused: true };
    }
    st = newAgentSession();
    st.title = t("研究初始化") + " · " + (q.topic || RI.wfName || t("未命名课题"));
    st.titleLocked = true;
    st.titleAuto = false;
    st.canvasWfId = RI.wfId || st.canvasWfId;
    try {
      await agentSetSessionWorkspace(st, root);
    } catch (_) {}
    try {
      if (typeof persistAgentSession === "function") await persistAgentSession();
      if (typeof renderAgentSessionSidebar === "function") await renderAgentSessionSidebar();
    } catch (_) {}
    RI.sessionId = st.id;
    try {
      agentSessionSend(taskPrompt(), { sessionId: st.id });
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
    return { ok: true };
  }
  function nudge(msg) {
    const sid = RI.sessionId || "";
    try {
      if (typeof agentSessionSend === "function" && sid) agentSessionSend(msg, { sessionId: sid });
      else toastSafe(t("这条初始化会话已经关掉了：请到会话视图里让它继续"), "warn");
    } catch (e) {
      toastSafe(String((e && e.message) || e), "err");
    }
  }
  async function persistQueue(q) {
    RI.queue = q;
    await writeJson(joinP(rootOf(), QUEUE_FILE), q).catch(() => {});
  }
  async function retryFailed() {
    const q = JSON.parse(JSON.stringify(RI.queue || { items: [] }));
    let changed = 0;
    for (const it of q.items || []) {
      if (it.status !== "failed") continue;
      it.status = "pending";
      it.error = "";
      it.fetch = it.source && it.source !== "file" ? "pending" : it.fetch;
      changed++;
    }
    if (!changed) return;
    q.phase = "queued";
    await persistQueue(q);
    nudge(
      "继续处理 `" +
        joinP(rootOf(), QUEUE_FILE).replace(/\\/g, "/") +
        "`：里面失败的项已重置成 pending，按技能重跑这些项；做完把 phase 改成 done。",
    );
    schedulePoll();
    render();
  }
  async function retryOne(id) {
    const q = JSON.parse(JSON.stringify(RI.queue || { items: [] }));
    const hit = (q.items || []).find((x) => x.id === id);
    if (!hit) return;
    hit.status = "pending";
    hit.error = "";
    hit.fetch = hit.source && hit.source !== "file" ? "pending" : hit.fetch;
    q.phase = "queued";
    await persistQueue(q);
    nudge("队列里的 `" + id + "` 已改回 pending，请按技能重跑这一项；做完把 phase 改成 done。");
    schedulePoll();
    render();
  }
  /* 剔除一条「由检索式命中」的项：只允许 pending，剔除会记进 literature/queries.jsonl 留痕 */
  async function dropItem(id) {
    const { queue, dropped } = C().initQueueDrop(RI.queue, id);
    if (!dropped) return;
    if ((dropped.status || "pending") !== "pending") {
      toastSafe(t("已经开始处理的条目不能剔除（只能重试）"), "warn");
      return;
    }
    await persistQueue(queue);
    await appendQueryLog(dropped);
    render();
  }
  async function appendQueryLog(it) {
    const line = JSON.stringify({
      at: Date.now(),
      id: it.id,
      query: it.hitBy || it.query || "",
      title: it.title || "",
      url: it.url || "",
      action: "dropped",
      by: "user",
    });
    try {
      const p = joinP(rootOf(), QUERY_LOG);
      await window.api.fileMkdir(joinP(p, "..")).catch(() => {});
      const prev = await readText(p);
      await window.api.fileWriteText(p, (prev ? prev.replace(/\n*$/, "\n") : "") + line + "\n");
    } catch (_) {}
  }
  function toGraph() {
    const fn = RI.onGraph;
    try {
      if (typeof fn === "function") fn();
    } catch (e) {
      toastSafe(String((e && e.message) || e), "err");
    }
    close();
  }
  /* 交棒给主视图：先关掉投料台（下面是常驻研究视图），再把视线带到第一篇已处理笔记。
     定位动作归视图层（onView，研究视图外壳在 open 时喂进来；不喂就只关窗）。 */
  function viewProcessed() {
    const list = C().processedList(RI.queue);
    const fn = RI.onView;
    close();
    try {
      if (typeof fn === "function") fn({ queue: RI.queue, processed: list, item: list[0] || null });
    } catch (e) {
      toastSafe(String((e && e.message) || e), "err");
    }
  }

  /* 绑定当前画布上下文（进研究视图时由视图外壳喂一次；换画布要重新喂）。
     只要 root 就能在没有打开界面时扫队列 —— 顶栏那个 N/M 进度 chip 要用它。 */
  function attach(ctx) {
    const o = ctx || {};
    if (o.ws != null) RI.ws = String(o.ws || "");
    if (o.root != null) RI.root = String(o.root || "");
    if (o.wfId != null) RI.wfId = String(o.wfId || "");
    if (o.wfName != null) RI.wfName = String(o.wfName || "");
    if (o.saveMeta != null) RI.saveMeta = typeof o.saveMeta === "function" ? o.saveMeta : null;
    return RI;
  }

  /* ── 对外 ── */
  async function open(opts) {
    opts = opts || {};
    attach(opts);
    RI.onDone = typeof opts.onDone === "function" ? opts.onDone : null;
    RI.onGraph = typeof opts.onGraph === "function" ? opts.onGraph : null;
    RI.onView = typeof opts.onView === "function" ? opts.onView : null;
    if (opts.saveMeta != null) RI.saveMeta = typeof opts.saveMeta === "function" ? opts.saveMeta : null;
    RI.open = true;
    RI.err = "";
    RI.busy = false;
    RI.composer = null;
    RI.preview = null;
    RI.editing = "";
    if (opts.split != null) RI.split = clampSplit(opts.split);
    bindKeys();
    /* 首次 / 增量以 research.json 是否存在判定：目录被删过就不是增量，
       并把上一轮残留（投料 / 录入 / 队列 / 状态）一律清掉，免得「删了目录仍按增量补料」 */
    const root = rootOf();
    const inited = !!root && (await existsP(joinP(root, "research.json")));
    RI.existing = inited ? !!opts.existing : false;
    if (!inited) {
      RI.core = [];
      RI.refs = [];
      RI.composer = null;
      RI.preview = null;
      RI.editing = "";
      RI.topic = "";
      RI.question = "";
      RI.queue = null;
      RI.busy = false;
    }
    const q = inited ? await readQueue() : null;
    RI.queue = q;
    /* 增量补料：从空列表开始投，别把上一批的文件带出来（旧状态在队列里，一个都不动） */
    if (RI.existing) {
      RI.core = [];
      RI.refs = [];
    }
    if (!RI.topic) RI.topic = String(opts.topic || (q && q.topic) || RI.wfName || "");
    if (!RI.question) RI.question = String(opts.question || (q && q.question) || "");
    render();
    schedulePoll();
    return RI;
  }
  /* ── 批量投料：投料台以外（「＋ 添加内容」对话框）一次交进来，一次执行 ──
     走的还是同一条通道：addFiles / addRows 自带去重与渲染，instruction 存进 RI.instruction
     交给 taskPrompt；随后直接 startInit() —— 一次 buildInitQueue + 一次 initQueueAppend +
     一次 ignite，也就是用户看到的「一起执行」（旧队列项状态一个都不动）。 */
  async function submitBatch(batch) {
    const b = batch || {};
    const files = Array.isArray(b.files) ? b.files : [];
    const rows = Array.isArray(b.rows) ? b.rows : [];
    const instruction = String(b.instruction == null ? "" : b.instruction).trim();
    if (!RI.ws && !b.ws) {
      const msg = t("这张画布还没有工作目录：先在画布顶栏设置，再回来初始化。");
      RI.err = msg;
      toastSafe(msg, "warn");
      return { ok: false, error: msg };
    }
    /* 界面没开着也照常收：先按增量口径开一次，把 root / ws 与队列基线拿到手 */
    if (!RI.open) {
      await open({
        existing: true,
        ws: b.ws != null ? b.ws : RI.ws,
        root: b.root != null ? b.root : RI.root,
        wfId: b.wfId != null ? b.wfId : RI.wfId,
        wfName: b.wfName != null ? b.wfName : RI.wfName,
        topic: b.topic != null ? b.topic : RI.topic,
        question: b.question != null ? b.question : RI.question,
        saveMeta: b.saveMeta != null ? b.saveMeta : RI.saveMeta,
        onDone: b.onDone || RI.onDone,
        onGraph: b.onGraph || RI.onGraph,
        onView: b.onView || RI.onView,
      });
    } else {
      attach({ ws: b.ws, root: b.root, wfId: b.wfId, wfName: b.wfName });
    }
    /* 文件按角色灌（role: "core" | "ref"，缺省按参考资料） */
    for (const f of files) {
      const path = String((f && f.path) || (typeof f === "string" ? f : "")).trim();
      if (!path) continue;
      addFiles(f && f.role === "core" ? "core" : "ref", [path]);
    }
    /* 网址 / DOI / arXiv / 检索式 / 文字：一条一条进，role 逐条认 */
    for (const r of rows) {
      if (!r) continue;
      addRows(r.role === "core" ? "core" : "ref", [r]);
    }
    RI.instruction = instruction;
    await startInit();
    return { ok: !RI.err, error: RI.err || "", queue: RI.queue, sessionId: RI.sessionId };
  }
  function close() {
    RI.open = false;
    /* 令牌 +1：正在跑的 startInit 回来时据此不再把界面弹回来（见 startInit 里的 runSeq） */
    RI.runSeq += 1;
    RI.composer = null;
    RI.preview = null;
    RI.editing = "";
    render();
  }
  /* 顶栏进度 chip：同一块界面打开，并把视线带到「已入队」那一段 */
  function openProgress() {
    RI.open = true;
    bindKeys();
    render();
    schedulePoll();
    setTimeout(() => {
      const box = qid("rsInit");
      const q = box && box.querySelector(".rs-queue");
      if (q && q.scrollIntoView) q.scrollIntoView({ block: "nearest" });
    }, 0);
  }
  function bindChange(fn) {
    changeHook = typeof fn === "function" ? fn : null;
  }
  function destroy() {
    if (RI.pollTimer) {
      clearInterval(RI.pollTimer);
      RI.pollTimer = null;
    }
    const box = qid("rsInit");
    if (box) box.remove();
    RI.open = false;
    /* 与 close 同一口径：销毁后正在跑的那一轮也不许再把界面建回来 */
    RI.runSeq += 1;
    RI.built = false;
  }

  window.MTResearchInit = {
    open,
    close,
    openProgress,
    destroy,
    refreshQueue,
    retryFailed,
    retryOne,
    dropItem,
    viewProcessed,
    stats,
    bindChange,
    attach,
    render,
    queue: () => RI.queue,
    state: RI,
    pathsFromDrop,
    addFiles,
    parseBlock,
    addRows,
    submitBatch,
    moveEntry,
    commitComposer,
    commitPreview,
  };
})();
