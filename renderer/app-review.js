"use strict";
/* ============ 审阅（文本处理节点的所见即所得 Markdown 审阅 + 批注修订） ============
 * 入口：openTextReview(node) —— 仅在普通（非智能）文本处理节点 proc_text 上唤起。
 *
 * 能力：
 *   1) 近乎全屏的持久对话框（右下可拖调，最小宽 ≥50%，显式关闭），不点外部收起；
 *   2) 所见即所得(WYSIWYG) 富文本正文编辑 + 源码切换，正文与 Markdown 双向转换；
 *   3) 顶部方形图标工具栏：全套 Markdown 编辑（标题/加粗/斜体/删除线/引用/无序/有序/
 *      待办/链接/行内码/代码块/水平线）+ 撤销重做（不支持插入图片与表格）；
 *   4) 批注：全文批注 + 局部批注（拖选正文 → 右侧浮空便笺绑定该段）；
 *   5) 出现首个批注后顶部出现醒目的「让 AI 修订」按钮；点击把「当前全文 + 历史全部批注」
 *      用该节点自身 provider+model 重新提交，生成新一版并进入下一轮批注；每版全文按轮
 *      完整留存；
 *   6) 回看 + 回滚：历史各版可回看；回滚把所选版本重新设为当前可编辑版，其后的版本
 *      将被删除、不可恢复（仅当前版允许修改）；
 *   7) 会话数据随节点持久化（node.review，随工作流保存/回滚）；
 *   8) 确认最终版后写回该节点作为新的文本内容。
 *
 * 依赖（均在同画布运行期全局可用）：nodeById / S / scheduleSave / renderCanvas / toast /
 * I18n / window.marked / apiCallTextStream / pushHistory / clearDownstream /
 * procPromptOf 等。本文件在 index.html 里最后加载，故引用只发生在函数调用期。
 */

/* ---------- 会话状态（内存）与持久结构（node.review） ---------- */

let _rv = {
  nodeId: "",        // 正在审阅的节点
  verIdx: 0,         // 当前查看的版本下标
  editing: false,    // 当前查看的是否可编辑（仅最后一版）
  src: false,        // 是否源码模式
  busy: false,       // AI 修订中
  dirty: false,
  localSel: false,   // 局部批注开关：开启后拖选正文才弹浮窗
};

function reviewDoc() {
  const n = nodeById(_rv.nodeId);
  return n && n.review ? n : null;
}

/* 当前被编辑版本（永远是最新的一版）。 */
function reviewCurrent() {
  const n = reviewDoc();
  if (!n || !n.review.versions.length) return null;
  return n.review.versions[n.review.versions.length - 1];
}
function reviewActiveText() {
  const v = reviewCurrent();
  return v ? String(v.text || "") : "";
}

/* 读节点当前“输出全文”（审阅对象）。proc_text 输出为单条文本才可用。 */
function nodeDocTextOf(n) {
  if (!n) return "";
  const o = n.output;
  if (o && o.kind === "text") return String(o.text || "");
  /* 容错：智能/多尝试不在本功能范围；普通 proc_text 走上方分支 */
  return "";
}

function nodeHasDoc(n) {
  return !!nodeDocTextOf(n);
}

/* 打开审阅对话框并初始化会话。 */
function openTextReview(node) {
  if (!node || node.kind !== "proc_text" || node.agent) return;
  if (node.running) {
    toast(I18n.t("请先等该节点运行完成再审阅"), "warn");
    return;
  }
  const doc = nodeDocTextOf(node);
  if (!doc.trim()) {
    toast(I18n.t("该节点还没有文本输出，请先运行一次再审阅"), "warn");
    return;
  }
  /* 没有历史会话 → 用当前输出全文作为原始稿 V1 */
  if (!node.review || !node.review.versions || !node.review.versions.length) {
    node.review = {
      createdAt: Date.now(),
      versions: [
        {
          text: doc,
          notes: [],
          ts: Date.now(),
          src: I18n.t("原始"),
        },
      ],
      notesLog: [],
    };
  }
  _rv.nodeId = node.id;
  _rv.src = false;
  _rv.busy = false;
  _rv.dirty = false;
  _rv.localSel = false;
  refreshVerIdx();
  ensureReviewDlg();
  renderReviewDlg();
  openReviewDlg();
}

function refreshVerIdx() {
  const n = reviewDoc();
  _rv.verIdx = n && n.review.versions.length ? n.review.versions.length - 1 : 0;
  _rv.editing = !!n;
}

/* ---------- 对话框宿主（持久 · 显式关闭 · 可拖调，最小宽 ≥50%） ---------- */

let _reviewDlgInit = false;
function ensureReviewDlg() {
  let host = document.getElementById("reviewDlg");
  if (host) return host;
  host = document.createElement("div");
  host.id = "reviewDlg";
  host.className = "review-dlg";
  host.innerHTML =
    '<div class="review-box" id="reviewBox" role="dialog" aria-modal="true">' +
    '<div class="review-head">' +
    '<div class="review-title"><span class="review-title-dot">✎</span><b id="reviewTitle"></b>' +
    '<span class="review-node" id="reviewNode"></span></div>' +
    '<div class="review-actions">' +
    '<button type="button" class="rv-btn rv-btn-primary rv-revise" id="reviewReviseBtn" hidden>' +
    '<span class="rv-revise-ic">✨</span><span id="reviewReviseTxt"></span></button>' +
    '<button type="button" class="rv-btn" id="reviewCloseBtn">✕</button>' +
    "</div></div>" +
    '<div class="review-toolbar" id="reviewToolbar"></div>' +
    '<div class="review-main">' +
    '<div class="review-editor-wrap">' +
    '<div class="review-editor-tabs">' +
    '<button type="button" class="rv-tab on" data-mode="rich">' +
    I18n.t("编辑") +
    "</button>" +
    '<button type="button" class="rv-tab" data-mode="src">' +
    I18n.t("源码") +
    "</button>" +
    '<i class="rv-tab-sep"></i>' +
    '<div class="rv-vtabs" id="reviewVerTabs"></div>' +
    "</div>" +
    '<div class="review-editor" id="reviewEditor"></div>' +
    '<div class="review-footbar" id="reviewFootbar"></div>' +
    "</div>" +
    '<div class="review-notes" id="reviewNotes"></div>' +
    "</div>" +
    '<div class="review-note-float" id="reviewNoteFloat" hidden></div>' +
    '<div class="review-resize" id="reviewResize" title="' +
    I18n.t("拖拽右下角调整大小") +
    '"></div>' +
    "</div>";
  document.body.appendChild(host);

  /* 显式关闭：✕ / Esc */
  host.querySelector("#reviewCloseBtn").onclick = () => closeReviewDlg();
  host.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") closeReviewDlg();
  });
  const box = host.querySelector("#reviewBox");
  const rz = host.querySelector("#reviewResize");
  let rsv = { w: 0, h: 0 };
  const restoreSz = () => {
    const k = "reviewDlgSize";
    try {
      const j = JSON.parse(localStorage.getItem(k) || "null");
      if (j && j.w && j.h) {
        rsv = j;
        box.style.width = j.w + "px";
        box.style.height = j.h + "px";
      }
    } catch (_) {}
  };
  restoreSz();
  const doResize = (dx, dy) => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let nw = rsv.w + dx;
    let nh = rsv.h + dy;
    const minW = Math.round(vw * 0.5);
    const minH = 360;
    nw = Math.max(minW, Math.min(nw, vw - 24));
    nh = Math.max(minH, Math.min(nh, vh - 24));
    rsv.w = nw;
    rsv.h = nh;
    box.style.width = nw + "px";
    box.style.height = nh + "px";
    try {
      localStorage.setItem("reviewDlgSize", JSON.stringify(rsv));
    } catch (_) {}
  };
  rz.addEventListener("mousedown", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const sx = ev.clientX;
    const sy = ev.clientY;
    const base = { w: rsv.w || box.offsetWidth, h: rsv.h || box.offsetHeight };
    const move = (e) => doResize(e.clientX - sx + base.w - rsv.w, e.clientY - sy + base.h - rsv.h);
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  });

  /* 模式切换 */
  host.querySelectorAll(".rv-tab").forEach((tb) => {
    tb.onclick = () => {
      commitEditorToDoc();
      _rv.src = tb.dataset.mode === "src";
      renderEditor();
    };
  });

  host.querySelector("#reviewReviseBtn").onclick = () => runRevision();
  _reviewDlgInit = true;
  return host;
}

function openReviewDlg() {
  const h = ensureReviewDlg();
  h.classList.add("on");
  document.body.classList.add("review-lock");
  h.querySelector("#reviewBox").focus();
}
function closeReviewDlg() {
  const h = document.getElementById("reviewDlg");
  if (!h) return;
  commitEditorToDoc();
  adoptLatestToNode(); // 关闭时自动采用当前可编辑最新版写回 node.output（不清下游、不关窗）
  persistReview(true);
  h.classList.remove("on");
  document.body.classList.remove("review-lock");
  _rv.nodeId = "";
}

/* ---------- 持久化 ---------- */
function persistReview(immediate) {
  const n = reviewDoc();
  if (!n) return;
  if (typeof scheduleSave === "function") scheduleSave(!!immediate);
}

/* ---------- 渲染 ---------- */

/* 统一视图刷新：所有版本/模式切换路径都收敛到这一处，保证版本 tab 高亮、
   编辑器（可编辑 / 只读回看）、批注、底栏与两个按钮彼此一致，
   避免「创建新版后回到旧版界面错乱 / 消失」。调用方先各自 commit+置好
   _rv.verIdx / _rv.editing，再调本函数做整面渲染。 */
function renderReviewView() {
  const h = ensureReviewDlg();
  const n = reviewDoc();
  if (!n) return;
  const node = nodeById(_rv.nodeId);
  const cur = reviewCurrent();
  h.querySelector("#reviewTitle").textContent =
    I18n.t("审阅 · ") + (node ? node.title : "");
  h.querySelector("#reviewNode").textContent = "";
  renderVersions(h, n);
  renderToolbar(h, cur);
  renderEditor();
  renderNotes(h, n);
  renderRevisionButton(h, n);
  renderFootbar(h, cur);
  h.querySelector("#reviewToolbar").style.visibility =
    cur && _rv.editing ? "" : "hidden";
  h.querySelector("#reviewNotes").style.pointerEvents =
    cur && _rv.editing ? "" : "none";
}

function renderReviewDlg() {
  renderReviewView();
}

function renderRevisionButton(h, n) {
  const b = h.querySelector("#reviewReviseBtn");
  const cur = reviewCurrent();
  const total = (cur ? cur.notes.length : 0);
  if (_rv.editing && total > 0) {
    b.hidden = false;
    h.querySelector("#reviewReviseTxt").textContent =
      I18n.t("让 AI 依据批注修订") +
      (total ? "（" + total + "）" : "");
  } else {
    b.hidden = true;
  }
}

function renderVersions(h, n) {
  const wrap = h.querySelector("#reviewVerTabs");
  if (!wrap) return;
  wrap.innerHTML = "";
  const versions = n.review.versions || [];
  /* 视图：顺序 tab（按序 1,2,…），末版（可编辑）标「最新」 */
  const seg = (v, idx) => {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "rv-vtab";
    if (idx === _rv.verIdx && _rv.editing) el.classList.add("cur");
    const total = (v.notes || []).length;
    /* 标签按序：旧版直接显示序号，末版（可编辑）显示「最新」 */
    const isLast = idx === versions.length - 1;
    const lab = isLast ? I18n.t("最新") : String(idx + 1);
    el.innerHTML =
      "<span class='rv-ver-n'>" + lab + "</span>" +
      (total ? "<em class='rv-ver-notes'>" + total + "</em>" : "");
    el.title = lab + " · " + (v.src || "") + " · " + rvFmtTime(v.ts);
    el.onclick = (ev) => {
      ev.stopPropagation();
      viewVersion(idx, true);
    };
    return el;
  };
  versions.forEach((v, i) => wrap.appendChild(seg(v, i)));
  /* 回看态：当前正在回看某个非末版旧版 → 高亮该 tab */
  if (_rv.editing === false && _rv.verIdx >= 0 && _rv.verIdx < versions.length - 1) {
    const curEl = wrap.children[_rv.verIdx];
    if (curEl) curEl.classList.add("cur");
  }
  /* 非末版回看态：在 tab 行尾提供「回滚到此」 */
  if (_rv.editing === false && _rv.verIdx < versions.length - 1 && versions.length > 1) {
    const rb = document.createElement("button");
    rb.type = "button";
    rb.className = "rv-vtab rollback";
    rb.textContent = "↩ " + I18n.t("回滚到此版");
    rb.title = I18n.t("回滚后该版成为当前可编辑版，其后的版本将被删除、不可恢复");
    rb.onclick = (ev) => {
      ev.stopPropagation();
      rollbackTo(_rv.verIdx);
    };
    wrap.appendChild(rb);
  }
  /* 默认滚动到最新 tab，保证新版本产生后「最新」可见 */
  try {
    wrap.scrollLeft = wrap.scrollWidth;
  } catch (_) {}
}

function rvFmtTime(ts) {
  if (!ts) return "";
  try {
    const d = new Date(ts);
    const p = (x) => (x < 10 ? "0" + x : "" + x);
    return (
      d.getFullYear() +
      "-" +
      p(d.getMonth() + 1) +
      "-" +
      p(d.getDate()) +
      " " +
      p(d.getHours()) +
      ":" +
      p(d.getMinutes())
    );
  } catch (_) {
    return "";
  }
}

function viewVersion(idx) {
  commitEditorToDoc();
  const n = reviewDoc();
  if (!n) return;
  if (idx < 0 || idx >= n.review.versions.length) return;
  _rv.verIdx = idx;
  _rv.editing = idx === n.review.versions.length - 1;
  renderReviewView();
}

/* ---------- 工具栏：方形 Markdown 图标按钮 ---------- */
function renderToolbar(h, cur) {
  const tb = h.querySelector("#reviewToolbar");
  tb.innerHTML = "";
  if (!cur || !_rv.editing) return;
  const mk = (action, label, title, html) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "rv-tool";
    b.title = title || label;
    if (html) b.innerHTML = html;
    else b.textContent = label;
    b.onclick = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      onToolbar(action);
    };
    tb.appendChild(b);
  };
  /* 结构 */
  mk("h1", "H1", I18n.t("一级标题"));
  mk("h2", "H2", I18n.t("二级标题"));
  mk("h3", "H3", I18n.t("三级标题"));
  mk("p", "¶", I18n.t("正文段落"));
  tb.appendChild(sep());
  /* 行内 */
  mk("bold", "B", I18n.t("加粗"), "<b>B</b>");
  mk("italic", "I", I18n.t("斜体"), "<i>I</i>");
  mk("strike", "S", I18n.t("删除线"), "<s>S</s>");
  mk("quote", "❝", I18n.t("引用"));
  tb.appendChild(sep());
  mk("ul", "•≡", I18n.t("无序列表"));
  mk("ol", "1.", I18n.t("有序列表"));
  mk("task", "☑", I18n.t("任务清单"));
  mk("hr", "—", I18n.t("水平线"));
  tb.appendChild(sep());
  mk("link", "🔗", I18n.t("链接"));
  mk("inlineCode", "⟨⟩", I18n.t("行内代码"));
  mk("code", "{;}", I18n.t("代码块"));
  tb.appendChild(sep());
  const u = document.createElement("button");
  u.type = "button";
  u.className = "rv-tool";
  u.title = I18n.t("撤销");
  u.textContent = "↶";
  u.onclick = () => undoRedo(false);
  tb.appendChild(u);
  const r = document.createElement("button");
  r.type = "button";
  r.className = "rv-tool";
  r.title = I18n.t("重做");
  r.textContent = "↷";
  r.onclick = () => undoRedo(true);
  tb.appendChild(r);
  tb.appendChild(sep());
  /* 批注入口（全文字即点即开） */
  const fullBtn = document.createElement("button");
  fullBtn.type = "button";
  fullBtn.className = "rv-note-enter";
  fullBtn.textContent = I18n.t("全文批注");
  fullBtn.title = I18n.t("对整个文档附加一条批注");
  fullBtn.onclick = () => {
    reviewFullNoteDialog().then((box) => {
      if (box && box.trim()) addFullNote(box.trim());
    });
  };
  tb.appendChild(fullBtn);
  const localBtn = document.createElement("button");
  localBtn.type = "button";
  localBtn.className = "rv-note-enter";
  localBtn.textContent = I18n.t("局部批注");
  const syncLocalBtn = () => {
    const on = _rv.localSel;
    localBtn.classList.toggle("on", on);
    localBtn.title = on
      ? I18n.t("局部批注已开启，拖选正文即可添加")
      : I18n.t("在正文中拖选文字可添加局部批注");
  };
  localBtn.onclick = () => {
    _rv.localSel = !_rv.localSel;
    syncLocalBtn();
    if (_rv.localSel) {
      /* 开启后聚焦富文本，让拖选可直接触发局部批注 */
      const edHost = document.getElementById("reviewBox");
      const edEl = edHost && edHost.querySelector(".rv-rich");
      if (edEl) edEl.focus();
    } else {
      hideFloatNote(true);
    }
  };
  syncLocalBtn();
  tb.appendChild(localBtn);
  function sep() {
    const s = document.createElement("i");
    s.className = "rv-tool-sep";
    return s;
  }
}

/* ---------- 编辑区 ---------- */

function renderEditor() {
  const host = document.getElementById("reviewBox");
  if (!host) return;
  const box = host.querySelector("#reviewEditor");
  box.innerHTML = "";
  const modeTabRich = host.querySelector('.rv-tab[data-mode="rich"]');
  const modeTabSrc = host.querySelector('.rv-tab[data-mode="src"]');
  if (modeTabRich) modeTabRich.classList.toggle("on", !_rv.src);
  if (modeTabSrc) modeTabSrc.classList.toggle("on", _rv.src);

  const text = _rv.editing ? reviewActiveText() : readOnlyViewText();
  box.classList.toggle("editing", !!_rv.editing);
  if (_rv.src) {
    const ta = document.createElement("textarea");
    ta.className = "rv-src";
    ta.spellcheck = false;
    ta.value = text;
    if (_rv.editing) {
      ta.oninput = () => {
        const v = reviewCurrent();
        if (v) v.text = ta.value;
        _rv.dirty = true;
        hideFloatNote(true);
      };
    } else {
      ta.readOnly = true;
    }
    box.appendChild(ta);
  } else {
    if (_rv.editing) {
      const ed = document.createElement("div");
      ed.className = "rv-rich";
      ed.contentEditable = "true";
      ed.spellcheck = false;
      ed.innerHTML = mdToRichHtml(text);
      ed.dataset.ver = reviewActiveText().length;
      /* 局部批注：拖选文字弹出右侧浮空便笺 */
      ed.addEventListener("mouseup", (ev) => {
        if (_rv.editing && _rv.localSel) maybeShowFloatNote(ed, ev);
      });
      ed.addEventListener("keyup", (ev) => {
        if (_rv.editing && _rv.dirty) {
          /* 富文本改动后把脏标记清掉；文本已由 DOM 承载，序列化在下一次 commit 做 */
          scheduleDirtyClear();
        }
      });
      ed.addEventListener("input", () => {
        _rv.dirty = true;
        _rv._lastDirtyAt = Date.now();
        /* 批注锚点自动重锚 */
        reAnchorNotesAfterEdit();
      });
      box.appendChild(ed);
      box.scrollTop = 0;
    } else {
      box.innerHTML =
        "<div class='rv-preview'>" + markedPreviewHtml(text) + "</div>";
    }
  }
  renderFootbarBox();
}

function readOnlyViewText() {
  const n = reviewDoc();
  if (!n) return "";
  if (n.review.versions[_rv.verIdx]) return n.review.versions[_rv.verIdx].text || "";
  return "";
}
function _visVer() {
  const n = reviewDoc();
  if (!n) return null;
  return n.review.versions[_rv.verIdx] || null;
}
function markedPreviewHtml(raw) {
  return mdToRichHtml(raw);
}
function commitEditorToDoc() {
  const host = document.getElementById("reviewBox");
  if (!host) return;
  const ed = host.querySelector(".rv-rich");
  const src = host.querySelector(".rv-src");
  const v = reviewCurrent();
  if (!v || !_rv.editing) return;
  if (ed && ed.contentEditable === "true") {
    v.text = richToMarkdown(ed) || v.text;
  } else if (src && !src.readOnly) {
    v.text = src.value;
  }
  _rv.dirty = false;
}

function scheduleDirtyClear() {
  /* 富文本已在 DOM 里承载；无需额外逻辑（serialize 在 commit 时统一做）。 */
}

let _reAnchorTimer = null;
function reAnchorNotesAfterEdit() {
  if (_reAnchorTimer) clearTimeout(_reAnchorTimer);
  _reAnchorTimer = setTimeout(() => {
    const v = _visVer();
    if (v && v.notes) {
      for (const nt of v.notes) {
        if (nt.kind === "local" && nt.dead !== true) tryReAnchorNote(nt, v.text);
      }
      renderNotesEl();
    }
  }, 350);
}

/* ---------- 富文本 ↔ Markdown ---------- */

function mdToRichHtml(raw) {
  const s = String(raw || "");
  if (!s.trim()) return "<p><br></p>";
  try {
    if (window.marked && window.marked.parse) {
      return window.marked.parse(s, { gfm: true, breaks: true });
    }
  } catch (_) {}
  return "<p>" + escH(s) + "</p>";
}
function escH(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/* 将富文本 DOM 序列化为 Markdown（覆盖我们工具栏与 marked 产生的语义子集）。 */
function richToMarkdown(root) {
  const parts = [];
  walkBlocks(root, parts, 0);
  let md = parts.join("\n");
  md = md.replace(/\n{3,}/g, "\n\n");
  return md.trim() + (md.trim() ? "\n" : "");
}

function inlineToMd(node) {
  /* 输出某文本/行内元素在「行内上下文」中的 markdown 片段 */
  if (!node) return "";
  if (node.nodeType === Node.TEXT_NODE) return node.textContent;
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  const tag = node.tagName.toLowerCase();
  let inner = "";
  for (const c of node.childNodes) inner += inlineToMd(c);
  switch (tag) {
    case "strong":
    case "b":
      return "**" + inner + "**";
    case "em":
    case "i":
      return "*" + inner + "*";
    case "s":
    case "del":
    case "strike":
      return "~~" + inner + "~~";
    case "code":
      return "`" + inner + "`";
    case "a":
      return "[" + inner + "](" + (node.getAttribute("href") || "") + ")";
    case "img":
      return "![" + (node.getAttribute("alt") || "") + "](" + (node.getAttribute("src") || "") + ")";
    case "br":
      return "  \n";
    case "input": {
      const chk = node.checked;
      return "[" + (chk ? "x" : " ") + "] ";
    }
    default:
      return inner;
  }
}

function walkBlocks(node, parts, depth) {
  for (const child of node.childNodes) {
    if (child.nodeType === Node.ELEMENT_NODE) {
      const tag = child.tagName.toLowerCase();
      if (tag === "br") {
        parts.push("");
        continue;
      }
      if (tag === "div" || tag === "p") {
        if (child.childNodes.length === 1 && child.firstChild.nodeType === Node.ELEMENT_NODE &&
          child.firstChild.tagName && ["UL", "OL", "TABLE", "PRE", "BLOCKQUOTE"].indexOf(child.firstChild.tagName.toUpperCase()) >= 0) {
          walkBlocks(child, parts, depth);
          continue;
        }
        const line = inlineToMd(child).replace(/\s+/g, " ").trim();
        if (line) parts.push(line);
        continue;
      }
      if (/^h[1-6]$/.test(tag)) {
        const lvl = Number(tag[1]);
        parts.push("#".repeat(lvl) + " " + inlineToMd(child).trim());
        continue;
      }
      if (tag === "blockquote") {
        const inner = [];
        walkBlocks(child, inner, depth);
        for (const line of inner) parts.push("> " + line.replace(/\n/g, "\n> "));
        continue;
      }
      if (tag === "pre") {
        const code = child.querySelector("code") || child;
        parts.push("```\n" + code.textContent.replace(/\n$/, "") + "\n```");
        continue;
      }
      if (tag === "ul" || tag === "ol") {
        walkList(child, parts, depth, tag === "ul");
        continue;
      }
      if (tag === "hr") {
        parts.push("---");
        continue;
      }
      if (tag === "table") {
        parts.push(tableToMd(child));
        continue;
      }
      /* 其它容器：递归 */
      walkBlocks(child, parts, depth);
    } else if (child.nodeType === Node.TEXT_NODE) {
      const t = child.textContent;
      if (t && t.trim()) parts.push(t.replace(/\s+/g, " ").trim());
    }
  }
}

function walkList(ul, parts, depth, unordered) {
  for (const li of ul.childNodes) {
    if (li.nodeType !== Node.ELEMENT_NODE || li.tagName.toLowerCase() !== "li") continue;
    const md = inlineToMd(li);
    /* 任务清单 */
    const chk = li.querySelector("input[type=checkbox]");
    if (chk) {
      const mark = chk.checked ? "[x] " : "[ ] ";
      parts.push(mark + md.trim());
    } else {
      parts.push((unordered ? "- " : "1. ") + md.trim());
    }
    /* 嵌套列表 */
    for (const sub of li.childNodes) {
      if (sub.nodeType === Node.ELEMENT_NODE && ["UL", "OL"].indexOf(sub.tagName.toUpperCase()) >= 0) {
        walkList(sub, parts, depth, sub.tagName.toLowerCase() === "ul");
      }
    }
  }
}

function tableToMd(tab) {
  const rows = [];
  const trs = Array.from(tab.querySelectorAll("tr"));
  for (let i = 0; i < trs.length; i++) {
    const cells = Array.from(trs[i].querySelectorAll("th,td")).map((c) =>
      inlineToMd(c).trim().replace(/\|/g, "\\|"),
    );
    const pad = cells.length || 1;
    while (cells.length < pad) cells.push("");
    rows.push(cells);
    if (i === 0) rows.push(Array(pad).fill("---"));
  }
  return rows.map((r) => "| " + r.join(" | ") + " |").join("\n");
}

/* ---------- 工具栏动作 ---------- */

function onToolbar(action) {
  commitEditorToDoc();
  const host = document.getElementById("reviewBox");
  const ed = host && host.querySelector(".rv-rich");
  const src = host && host.querySelector(".rv-src");
  if (src) {
    applyToolbarToSource(action, src);
    return;
  }
  if (!ed) return;
  ed.focus();
  if (applyToolbarToRich(action, ed)) return;
}

function applyToolbarToSource(action, ta) {
  const a = ta.selectionStart;
  const b = ta.selectionEnd;
  const sel = ta.value.slice(a, b);
  const r = sel ? "" : "";
  const prefixMap = {
    h1: "## ", h2: "## ", h3: "## ", p: "",
    ul: "- ", ol: "1. ", task: "- [ ] ", quote: "> ",
    bold: "**", italic: "*", strike: "~~",
    inlineCode: "`", code: "```\n", link: "[", hr: "\n---\n",
  };
  const fmt = (pre, post, sample, mid) => {
    const body = sel || sample;
    const nb = pre + body + (mid ? mid : "") + post;
    ta.value =
      ta.value.slice(0, a) + nb + ta.value.slice(b);
    ta.setSelectionRange(a, a + nb.length);
    const v = reviewCurrent();
    if (v) v.text = ta.value;
    _rv.dirty = true;
    ta.focus();
  };
  switch (action) {
    case "h1": case "h2": case "h3":
      sourceHeading(ta, action);
      break;
    case "ul": case "ol": case "task": case "quote":
      wrapLines(ta, action);
      break;
    case "bold": fmt("**", "**", I18n.t("文本"), ""); break;
    case "italic": fmt("*", "*", I18n.t("文本"), ""); break;
    case "strike": fmt("~~", "~~", I18n.t("文本"), ""); break;
    case "inlineCode": fmt("`", "`", I18n.t("code"), ""); break;
    case "code":
      fmt("```\n", "\n```", I18n.t("代码"), "\n");
      break;
    case "link":
      fmt("[", "](url)", I18n.t("链接文字"), "");
      break;
    case "hr":
      if (ta.value && !ta.value.endsWith("\n")) ta.value += "\n";
      ta.value += "\n---\n\n";
      const v = reviewCurrent();
      if (v) v.text = ta.value;
      _rv.dirty = true;
      ta.focus();
      break;
  }
}

function sourceHeading(ta, action) {
  /* 源码模式标题：对选区覆盖的每一行改写行首井号（去旧标题标记） */
  const hashes = { h1: "#", h2: "##", h3: "###" }[action];
  const a = ta.selectionStart;
  const b = ta.selectionEnd;
  let ls = ta.value.lastIndexOf("\n", a - 1) + 1;
  let le = ta.value.indexOf("\n", b);
  if (le < 0) le = ta.value.length;
  const seg = ta.value.slice(ls, le);
  const rep = seg
    .split("\n")
    .map((l) => {
      const t = l.trim();
      if (!t) return l;
      const clean = t.replace(/^#{1,6}\s*/, "");
      return hashes + " " + clean;
    })
    .join("\n");
  ta.value = ta.value.slice(0, ls) + rep + ta.value.slice(le);
  ta.setSelectionRange(ls, ls + rep.length);
  const v = reviewCurrent();
  if (v) v.text = ta.value;
  _rv.dirty = true;
  ta.focus();
}

function wrapLines(ta, action) {
  const pre = { ul: "- ", ol: "1. ", task: "- [ ] ", quote: "> " }[action];
  const a = ta.selectionStart;
  const b = ta.selectionEnd;
  let ls = ta.value.lastIndexOf("\n", a - 1) + 1;
  let le = ta.value.indexOf("\n", b);
  if (le < 0) le = ta.value.length;
  const seg = ta.value.slice(ls, le);
  const rep = seg
    .split("\n")
    .map((l) => (l.trim() ? pre + l : l))
    .join("\n");
  ta.value = ta.value.slice(0, ls) + rep + ta.value.slice(le);
  ta.setSelectionRange(ls, ls + rep.length);
  const v = reviewCurrent();
  if (v) v.text = ta.value;
  _rv.dirty = true;
  ta.focus();
}

function applyToolbarToRich(action, ed) {
  try {
    ed.focus();
    switch (action) {
      case "h1": case "h2": case "h3": {
        const lvl = { h1: "h1", h2: "h2", h3: "h3" }[action];
        document.execCommand("formatBlock", false, lvl);
        return true;
      }
      case "p":
        document.execCommand("formatBlock", false, "p");
        return true;
      case "bold":
        document.execCommand("bold");
        return true;
      case "italic":
        document.execCommand("italic");
        return true;
      case "strike":
        document.execCommand("strikeThrough");
        return true;
      case "quote":
        document.execCommand("formatBlock", false, "blockquote");
        return true;
      case "ul":
        document.execCommand("insertUnorderedList");
        return true;
      case "ol":
        document.execCommand("insertOrderedList");
        return true;
      case "task": {
        const sel = window.getSelection();
        if (sel && !sel.isCollapsed) {
          const frag = document.createRange().createContextualFragment(
            '<ul data-task="1"><li><input type="checkbox">' +
              sel.toString().replace(/&/g, "&amp;").replace(/</g, "&lt;") +
              "</li></ul>",
          );
          insertRichNode(frag);
        } else {
          insertRichNode(
            document.createRange().createContextualFragment(
              '<ul data-task="1"><li><input type="checkbox"><br></li></ul>',
            ),
          );
        }
        return true;
      }
      case "hr":
        insertRichNode(document.createRange().createContextualFragment("<hr>"));
        return true;
      case "link": {
        /* 先捕获正文选区再开输入框：对话框夺焦后 window.getSelection()
           就指向输入框，拿不到原选中文字，故提前 clone 保存 */
        const sel = window.getSelection();
        const hasSel = !!(sel && !sel.isCollapsed && sel.rangeCount);
        const anchorText = hasSel ? sel.toString() : "";
        const range = hasSel ? sel.getRangeAt(0).cloneRange() : null;
        promptDialog(I18n.t("链接地址（https://…）"), "https://", {
          title: I18n.t("插入链接"),
          inputType: "url",
        }).then((url) => {
          if (url == null) return; // 取消 / Esc
          if (range) {
            const a = document.createElement("a");
            a.href = url;
            a.textContent = anchorText;
            try {
              range.deleteContents();
              range.insertNode(a);
            } catch (_) {}
            placeCaretAfter(a);
          } else {
            insertRichNode(
              document.createRange().createContextualFragment(
                '<a href="' + escH(url) + '">' + escH(url) + "</a>",
              ),
            );
          }
        });
        return true;
      }
      case "inlineCode":
        wrapInlineRich("code");
        return true;
      case "code": {
        const frag = document.createRange().createContextualFragment(
          "<pre><code>" + I18n.t("代码") + "</code></pre>",
        );
        insertRichNode(frag);
        return true;
      }
      default:
        return false;
    }
  } catch (_) {
    toast(I18n.t("该编辑操作在当前浏览器不受支持"), "warn");
    return true;
  }
}

function wrapInlineRich(tag) {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) {
    const el = document.createElement(tag);
    el.textContent = I18n.t("code");
    const frag = document.createDocumentFragment();
    frag.appendChild(el);
    insertRichNode(frag);
    return;
  }
  const r = sel.getRangeAt(0);
  const wrap = document.createElement(tag);
  try {
    r.surroundContents(wrap);
  } catch (_) {
    /* 跨块选区：逐字抽取文本包起来 */
    const txt = sel.toString();
    r.deleteContents();
    wrap.textContent = txt;
    r.insertNode(wrap);
  }
  placeCaretAfter(wrap);
}
function insertRichNode(frag) {
  const sel = window.getSelection();
  const ed = document.querySelector(".review-editor .rv-rich");
  if (sel && sel.rangeCount && sel.anchorNode && ed && ed.contains(sel.anchorNode)) {
    const r = sel.getRangeAt(0);
    r.deleteContents();
    r.insertNode(frag.nodeType ? frag : document.createRange().createContextualFragment(frag));
    placeCaretAfter(frag.lastChild || frag);
  } else if (ed) {
    ed.appendChild(frag.nodeType ? frag : document.createRange().createContextualFragment(frag));
  }
}
function placeCaretAfter(el) {
  const sel = window.getSelection();
  const r = document.createRange();
  r.setStartAfter(el);
  r.collapse(true);
  sel.removeAllRanges();
  sel.addRange(r);
}
function undoRedo(redo) {
  const host = document.getElementById("reviewBox");
  const ed = host && host.querySelector(".rv-rich");
  const src = host && host.querySelector(".rv-src");
  try {
    if (ed && !_rv.src) {
      if (redo) document.execCommand("redo");
      else document.execCommand("undo");
    } else if (src) {
      if (redo) document.execCommand("redo");
      else document.execCommand("undo");
    }
  } catch (_) {}
}

/* ---------- 局部批注：浮空便笺 ---------- */

function maybeShowFloatNote(ed, ev) {
  if (!_rv.editing) return;
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) return;
  const txt = sel.toString().trim();
  if (!txt || txt.length < 2) return;
  const rect = sel.getRangeAt(0).getBoundingClientRect();
  if (!rect || (!rect.width && !rect.height)) return;
  const host = document.getElementById("reviewBox");
  if (!host) return;
  const boxRect = host.getBoundingClientRect();
  showFloatNote(
    rect.right - boxRect.left + 12,
    rect.top - boxRect.top,
    txt,
  );
}

function showFloatNote(x, y, snippet) {
  const host = document.getElementById("reviewBox");
  const f = host.querySelector("#reviewNoteFloat");
  f.hidden = false;
  f.style.left = x + "px";
  f.style.top = y + "px";
  f.innerHTML =
    '<div class="rv-note-caret"></div>' +
    '<div class="rv-note-snip">“' +
    escH(snippet.slice(0, 60)) +
    (snippet.length > 60 ? "…" : "") +
    '”</div>' +
    '<textarea class="rv-note-in" rows="3" placeholder="' +
    I18n.t("输入批注内容…") +
    '"></textarea>' +
    '<div class="rv-note-btns">' +
    '<button type="button" class="rv-btn primary" id="reviewNoteOk">' +
    I18n.t("绑定批注") +
    "</button>" +
    '<button type="button" class="rv-btn" id="reviewNoteCancel">✕</button>' +
    "</div>";
  f._snippet = snippet;
  const ta = f.querySelector(".rv-note-in");
  const ok = f.querySelector("#reviewNoteOk");
  const cancel = f.querySelector("#reviewNoteCancel");
  const commit = () => {
    const body = ta.value.trim();
    if (!body) {
      hideFloatNote(true);
      return;
    }
    addLocalNote(snippet, body);
    hideFloatNote(true);
  };
  ok.onclick = commit;
  cancel.onclick = () => hideFloatNote(true);
  ta.focus();
}

function hideFloatNote(dropSelection) {
  const host = document.getElementById("reviewBox");
  if (host) {
    const f = host.querySelector("#reviewNoteFloat");
    if (f) f.hidden = true;
  }
  if (dropSelection) {
    try {
      window.getSelection().removeAllRanges();
    } catch (_) {}
  }
}

function addLocalNote(snippet, body) {
  const v = _visVer();
  if (!v || !_rv.editing) return;
  /* 先把富文本 DOM 落回 v.text，锚点才以最新正文为准 */
  commitEditorToDoc();
  if (!v.notes) v.notes = [];
  /* 锚点：在 markdown 文本中定位 snippet */
  const text = v.text || "";
  const idx = text.indexOf(snippet);
  const note = {
    id: rvUid("rn"),
    kind: "local",
    body,
    snippet,
    start: idx >= 0 ? idx : -1,
    ts: Date.now(),
  };
  v.notes.push(note);
  _rv.dirty = true;
  renderNotesEl();
  renderRevisionButton(document.getElementById("reviewBox"), reviewDoc());
  persistReview(false);
  toast(I18n.t("已绑定局部批注"), "ok");
}

/* 自动重锚：文档改动后，把局部批注重新贴到就近匹配位置 */
function tryReAnchorNote(nt, text) {
  if (!nt.snippet) return;
  const from = Math.max(0, (nt.start || 0) - 120);
  const to = Math.min(text.length, (nt.start || 0) + 200);
  const near = text.slice(from, to);
  const rel = near.indexOf(nt.snippet);
  if (rel >= 0) {
    nt.start = from + rel;
    nt.dead = false;
    return;
  }
  const g = text.indexOf(nt.snippet);
  if (g >= 0) {
    nt.start = g;
    nt.dead = false;
    return;
  }
  nt.dead = true;
}

function addFullNote(body) {
  const v = _visVer();
  if (!v || !_rv.editing) return;
  if (!v.notes) v.notes = [];
  v.notes.push({
    id: rvUid("rn"),
    kind: "full",
    body,
    snippet: "",
    ts: Date.now(),
  });
  _rv.dirty = true;
  renderNotesEl();
  renderRevisionButton(document.getElementById("reviewBox"), reviewDoc());
  persistReview(false);
}

function deleteNote(id) {
  const v = _visVer();
  if (!v || !v.notes) return;
  v.notes = v.notes.filter((x) => x.id !== id);
  _rv.dirty = true;
  renderNotesEl();
  renderRevisionButton(document.getElementById("reviewBox"), reviewDoc());
  persistReview(false);
}

/* 全文批注输入弹层：应用内多行对话框（复用 mt-dialog），
 * 返回去首尾空白的批注内容；取消 / Esc 返回空串。 */
function reviewFullNoteDialog() {
  return new Promise((resolve) => {
    try {
      mtDialogForm({
        title: I18n.t("全文批注"),
        msg: I18n.t("对整个文档附加一条批注"),
        textarea: {
          label: I18n.t("批注内容"),
          rows: 6,
          placeholder: I18n.t("输入批注内容…"),
        },
        actions: [
          { id: "cancel", label: I18n.t("取消") },
          { id: "ok", label: I18n.t("添加批注"), primary: true },
        ],
      }).then((res) => {
        resolve(
          res && res.action === "ok" ? String(res.text || "").trim() : "",
        );
      });
    } catch (_) {
      resolve("");
    }
  });
}

function renderNotes(h, n) {
  renderNotesEl();
}
function renderNotesEl() {
  const host = document.getElementById("reviewBox");
  if (!host) return;
  const wrap = host.querySelector("#reviewNotes");
  wrap.innerHTML = "";
  const v = _visVer();
  if (!_rv.editing) {
    /* 只读回看（非末版历史版本）：只读列出该版本绑定的批注，不带全文批注/提示与写操作 */
    const head = document.createElement("div");
    head.className = "rv-notes-head";
    const t = document.createElement("span");
    t.className = "rv-notes-title";
    t.textContent = I18n.t("该版本的批注");
    head.appendChild(t);
    wrap.appendChild(head);
    const list = document.createElement("div");
    list.className = "rv-notes-list";
    const notes = (v && v.notes) || [];
    if (!notes.length) {
      const e = document.createElement("div");
      e.className = "rv-notes-empty";
      e.textContent = I18n.t("该版本没有批注");
      list.appendChild(e);
    }
    for (const nt of notes) {
      list.appendChild(noteCardEl(nt, true));
    }
    wrap.appendChild(list);
    return;
  }
  /* 全文批注按钮（顶部批注条） */
  const head = document.createElement("div");
  head.className = "rv-notes-head";
  const bt = document.createElement("button");
  bt.type = "button";
  bt.className = "rv-btn rv-add-full";
  bt.textContent = "+ " + I18n.t("全文批注");
  bt.title = I18n.t("对整个文档附加一条批注");
  bt.onclick = () => {
    reviewFullNoteDialog().then((box) => {
      if (box && box.trim()) addFullNote(box.trim());
    });
  };
  head.appendChild(bt);
  const hint = document.createElement("span");
  hint.className = "rv-notes-hint";
  hint.textContent = I18n.t("在正文中拖选文字可添加局部批注");
  head.appendChild(hint);
  wrap.appendChild(head);

  const list = document.createElement("div");
  list.className = "rv-notes-list";
  const notes = (v && v.notes) || [];
  if (!notes.length) {
    const e = document.createElement("div");
    e.className = "rv-notes-empty";
    e.textContent = I18n.t("暂无批注 · 添加批注后顶部会出现「让 AI 修订」");
    list.appendChild(e);
  }
  for (const nt of notes) {
    list.appendChild(noteCardEl(nt));
  }
  wrap.appendChild(list);
}

function noteCardEl(nt, readOnly) {
  const el = document.createElement("div");
  el.className = "rv-note" + (nt.kind === "local" ? " local" : " full") + (nt.dead ? " dead" : "");
  const head = document.createElement("div");
  head.className = "rv-note-head";
  const tag = document.createElement("span");
  tag.className = "rv-note-tag";
  tag.textContent = nt.kind === "local" ? I18n.t("局部") : I18n.t("全文");
  head.appendChild(tag);
  const jt = document.createElement("span");
  jt.className = "rv-note-meta";
  jt.textContent = rvFmtTime(nt.ts);
  head.appendChild(jt);
  if (!readOnly && _rv.editing) {
    const del = document.createElement("button");
    del.type = "button";
    del.className = "rv-note-del";
    del.textContent = "✕";
    del.title = I18n.t("删除批注");
    del.onclick = () => deleteNote(nt.id);
    head.appendChild(del);
  }
  el.appendChild(head);
  if (nt.kind === "local" && nt.snippet) {
    const snip = document.createElement("div");
    snip.className = "rv-note-snip";
    snip.textContent = "“" + nt.snippet + "”";
    snip.title = nt.dead ? I18n.t("批注锚点文字已变更，可能已失效") : "";
    if (!readOnly) {
      /* 只读回看态没有 .rv-rich 富文本元素，跳转定位依赖它，故回看态跳过绑定（仅提示） */
      snip.onclick = () => jumpToSnippet(nt);
    } else {
      snip.title = (snip.title ? snip.title + " · " : "") + I18n.t("只读回看，无法定位正文");
    }
    el.appendChild(snip);
  }
  if (nt.dead) {
    const w = document.createElement("div");
    w.className = "rv-note-warn";
    w.textContent = I18n.t("锚点文字已变更，批注可能失效");
    el.appendChild(w);
  }
  const body = document.createElement("div");
  body.className = "rv-note-body";
  body.textContent = nt.body;
  el.appendChild(body);
  return el;
}

function jumpToSnippet(nt) {
  const host = document.getElementById("reviewBox");
  if (!host) return;
  const ed = host.querySelector(".rv-rich");
  if (!ed) return;
  /* 在富文本中定位 snippet 文本并选中 */
  try {
    const tn = document.createTreeWalker(ed, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = tn.nextNode())) {
      const i = n.textContent.indexOf(nt.snippet);
      if (i >= 0) {
        const r = document.createRange();
        r.setStart(n, i);
        r.setEnd(n, i + nt.snippet.length);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(r);
        ed.focus();
        const rr = r.getBoundingClientRect();
        if (rr) {
          const boxRect = host.querySelector("#reviewBox").getBoundingClientRect();
          const dy = rr.top - boxRect.top - 120;
          host.querySelector("#reviewEditor").scrollTop += dy;
        }
        return;
      }
    }
    toast(I18n.t("未能在正文中找到该批注片段"), "warn");
  } catch (_) {}
}

/* ---------- 让 AI 修订（生成新一版） ---------- */

/* 审阅修订用节点自身 provider+model；节点未显式选服务商（跑过但 providerId 空）时，
   回退到任一可用文本服务商，避免误报“未配置”。 */
function reviewResolveProv(node) {
  const list = (S.config.providers || []);
  let prov = node && node.providerId
    ? list.find((p) => p.id === node.providerId)
    : null;
  if (!prov) {
    prov =
      list.find(
        (p) => p.type === "text_openai" && String(p.apiKey || "").trim(),
      ) || null;
  }
  return prov;
}

async function runRevision() {
  const n = reviewDoc();
  const node = nodeById(_rv.nodeId);
  if (!n || !node) return;
  commitEditorToDoc();
  const v = reviewCurrent();
  if (!v || _rv.busy) return;
  const total = (v.notes || []).length;
  if (!total) return;
  const prov = reviewResolveProv(node);
  if (!prov) {
    toast(
      I18n.t("未找到可用文本服务商（请在设置 · API/配置中配置并填写 API Key）"),
      "err",
    );
    return;
  }
  if (!String(prov.apiKey || "").trim()) {
    toast(I18n.t("该服务商未填写 API Key（设置 · API/配置）"), "err");
    return;
  }
  const model = node.model || (prov.models && prov.models[0]) || "";
  if (!model) {
    toast(I18n.t("未找到可用模型（请在节点设置中选择该服务商的模型）"), "err");
    return;
  }
  /* 记录本轮批注到累计 notesLog */
  for (const nt of v.notes || []) {
    n.review.notesLog.push({
      round: n.review.notesLog.length + 1,
      kind: nt.kind,
      snippet: nt.snippet || "",
      body: nt.body,
    });
  }
  const prompt = buildRevisionPrompt(v.text, n.review.notesLog);
  _rv.busy = true;
  renderRevisionButton(document.getElementById("reviewBox"), n);
  renderBusy(true);
  try {
    const spec = {
      provider: prov,
      kind: "text",
      model: model,
      temperature:
        node.temperature == null
          ? 0.7
          : Math.max(0, Math.min(2, Number(node.temperature) || 0)),
      effort:
        typeof normalizeTextEffort === "function"
          ? normalizeTextEffort(node.effort)
          : undefined,
      size: "",
      prompt: prompt,
      texts: [],
      images: [],
      refImage: "",
      abKey: node._abKey || "",
    };
    const r = await apiCallTextStream(spec, null, null);
    let out = String((r && r.text) || "");
    out = stripFences(out);
    if (!out.trim()) throw new Error(I18n.t("模型未返回修订正文"));
    /* 生成新一版，批注清空（历史保留在 notesLog 与前序版本上） */
    n.review.versions.push({
      text: out,
      notes: [],
      ts: Date.now(),
      src: I18n.t("AI 修订") + (n.review.versions.length),
    });
    refreshVerIdx();
    persistReview(true);
    adoptLatestToNode();
    renderReviewView();
    toast(I18n.t("已生成修订版，可继续批注下一轮"), "ok");
  } catch (e) {
    toast(I18n.t("修订失败：") + (e && e.message ? e.message : e), "err");
  } finally {
    _rv.busy = false;
    renderBusy(false);
  }
}

function stripFences(t) {
  let s = String(t || "").trim();
  const m = s.match(/^```[a-zA-Z0-9_+-]*\n([\s\S]*?)\n```$/);
  if (m) s = m[1];
  return s.trim();
}

function buildRevisionPrompt(text, log) {
  const lines = [];
  lines.push(I18n.t("你是一位严谨的文字审阅与修订助手。"));
  lines.push(
    I18n.t(
      "请依据文档全文与用户的全部批注，产出一份修订后的完整 Markdown 正文。",
    ),
  );
  lines.push(
    I18n.t(
      "要求：只输出修订后的 Markdown 正文本身，不要任何解释、不要前言后语、不要包在代码块里；未被批注点名的段落，如无必要请原样保留；被批注的段落请认真按其意见修改。",
    ),
  );
  lines.push("");
  lines.push("## " + I18n.t("当前全文"));
  lines.push("");
  lines.push(text);
  lines.push("");
  if (log && log.length) {
    lines.push("## " + I18n.t("历史全部批注"));
    lines.push("");
    let r = 0;
    for (const it of log) {
      r++;
      const where =
        it.kind === "local"
          ? I18n.t("局部 · 被批注片段：") + (it.snippet || "—")
          : I18n.t("全文");
      lines.push("【第 " + r + " 条 · " + where + "】" + (it.body || ""));
    }
  }
  return lines.join("\n");
}

function renderBusy(busy) {
  const host = document.getElementById("reviewBox");
  if (!host) return;
  host.classList.toggle("busy", busy);
}

/* 回滚到第 idx 版：idx 之后的版本整体删除(splice，草稿分支删除，不可恢复)，idx 成为当前可编辑版。 */
async function rollbackTo(idx) {
  const n = reviewDoc();
  if (!n) return;
  const ok = await confirmDialog(
    I18n.t("确定回滚到该版本？其后的版本将被删除，不可恢复。"),
    { title: I18n.t("回滚版本"), okText: I18n.t("回滚到此版"), danger: true },
  );
  if (!ok) return;
  const vv = n.review.versions;
  if (idx < 0 || idx >= vv.length - 1) return;
  vv.splice(idx + 1);
  _rv.verIdx = vv.length - 1;
  _rv.editing = true;
  persistReview(true);
  renderReviewDlg();
  toast(I18n.t("已回滚，该版现在是当前可编辑版"), "ok");
}

/* 自动采用最新可编辑版：把审阅结果写回节点输出（不关窗、不提示）。返回是否成功。 */
function adoptLatestToNode() {
  const n = reviewDoc();
  const node = nodeById(_rv.nodeId);
  if (!n || !node) return false;
  commitEditorToDoc();
  const v = reviewCurrent();
  if (!v) return false;
  const text = String(v.text || "").trim();
  if (!text) return false;
  if (typeof pushHistory === "function") {
    try {
      pushHistory();
    } catch (_) {}
  }
  node.output = { kind: "text", text: text };
  node.ranAt = Date.now();
  node._reviewApplied = true;
  if (typeof clearDownstream === "function") {
    try {
      clearDownstream(node.id);
    } catch (_) {}
  }
  persistReview(true);
  if (typeof renderCanvas === "function") renderCanvas();
  return true;
}

/* 底部条：字数 / 保存提示 */
function renderFootbar(h, cur) {
  renderFootbarBox();
}
function renderFootbarBox() {
  const host = document.getElementById("reviewBox");
  if (!host) return;
  const fb = host.querySelector("#reviewFootbar");
  if (!fb) return;
  const v = _visVer();
  const text = v ? String(v.text || "") : "";
  fb.innerHTML =
    '<span class="rv-meta">' +
    I18n.t("字数：") +
    text.length +
    "</span>" +
    '<span class="rv-meta">' +
    I18n.t("字符（不含空白）") +
    "：" +
    text.replace(/\s/g, "").length +
    "</span>";
}

function renderReviewDlgNotesOnly() {
  renderReviewView();
}

function rvUid(p) {
  return (
    (p || "") +
    Date.now().toString(36) +
    Math.random().toString(36).slice(2, 7)
  );
}
