"use strict";
/* ============ 审阅（文档目标的所见即所得 Markdown 审阅 + 批注修订） ============
 * 入口：
 *   openTextReview(node)  —— 普通（非智能）文本处理节点 proc_text（旧签名，行为逐字不变）；
 *   openFactReview(doc)   —— 团队事实库的**单篇文档**：入参 { file, name, reviewFile, assetsDir }，
 *                            file = 该文档 md 正文 / reviewFile = 该文档 review.json 版本链 /
 *                            assetsDir = 库级共享插图目录（同库多篇文档共用一份 assets/）。
 *
 * 「文档目标」适配层（_rv.target）：审阅对象统一抽象成 { type:'node'|'fact', id, path, name }。
 *   node → 现有 node.output 为当前稿、node.review 为版本链（内存，随画布保存）；
 *   fact → 该文档 md 文件为当前稿、该文档 review.json sidecar 为 versions/notesLog
 *          （读进 _rv.doc 缓存，写回文件），采用当前版即把该文档 md 正文写回；
 *          插图仍落库级 assets/，GC 只回收「库内所有文档全部版本」都不引用的图片。
 * reviewDoc / reviewCurrent / readOnlyViewText / persistReview / adoptLatest /
 * reviewResolveProv 等全部经此分派，画布与事实库共用同一套编辑器 / 批注 / 回滚语义。
 *
 * 能力：
 *   1) 近乎全屏的持久对话框（右下可拖调，最小宽 ≥50%，显式关闭），不点外部收起；
 *   2) 所见即所得(WYSIWYG) 富文本正文编辑 + 源码切换，正文与 Markdown 双向转换；
 *   3) 顶部方形图标工具栏：全套 Markdown 编辑（标题/加粗/斜体/删除线/引用/无序/有序/
 *      待办/链接/行内码/代码块/水平线/图片/表格）+ 撤销重做；
 *      事实库目标下插图会复制进库级 assets/ 并以相对路径写回该文档 md（剪贴板 / 截图粘贴、
 *      拖拽、本机文件都支持），只有「库内所有文档全部版本」都不引用的图片才从磁盘回收；
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

/* ---------- 会话状态（内存）与持久结构（node.review / 事实库 sidecar） ---------- */

let _rv = {
  target: null,      // 文档目标 { type:'node'|'fact', id, path, name }（null = 未打开）
  doc: null,         // 事实库审阅文档缓存（sidecar JSON；node 目标时为 null，直接读写 node.review）
  verIdx: 0,         // 当前查看的版本下标
  editing: false,    // 当前查看的是否可编辑（仅最后一版）
  src: false,        // 是否源码模式
  busy: false,       // AI 修订中
  dirty: false,
  localSel: false,   // 局部批注开关：开启后拖选正文才弹浮窗
};

function rvTargetIs(type) {
  return !!(_rv.target && _rv.target.type === type);
}
/* 事实库适配层：全局 factlib* 函数（app-factlib.js 同层脚本，调用期已就绪）。 */
function rvFactLib() {
  return window.MTNodeFactLib || null;
}
/* 事实库审阅对象：{ file, reviewFile, name }（全部来自 _rv.target，按单篇文档定位）。 */
function rvFactOf() {
  if (!rvTargetIs("fact")) return null;
  const t = _rv.target;
  const p = t.path;
  if (!p) return null;
  return {
    file: p,
    reviewFile: String(t.reviewPath || ""),
    name: String(t.name || ""),
  };
}
/* 文档所在库目录（assets/ 的父目录）：优先按库级 assetsDir 反推，退回 md 所在目录。 */
function rvFactDir() {
  const lib = rvFactLib();
  const t = _rv.target || {};
  const ad = String(t.assetsDir || "");
  if (ad && lib && typeof lib.dirNameOf === "function") return lib.dirNameOf(ad);
  const f = String(t.path || "");
  if (f && lib && typeof lib.dirNameOf === "function") return lib.dirNameOf(f);
  return "";
}
/* 统一审阅文档：{ review:{versions,notesLog,…} }（node 目标返回节点本身，保持旧引用语义）。 */
function reviewDoc() {
  if (!_rv.target) return null;
  if (rvTargetIs("fact")) return _rv.doc ? { review: _rv.doc } : null;
  const n = nodeById(_rv.target.id);
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

/* 打开审阅对话框并初始化会话（节点路径，旧签名保持可用）。 */
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
  _rv.doc = null;
  beginReview({ type: "node", id: node.id, path: "", name: node.title || "" });
}

/* 打开事实库文档审阅：入参 = 单篇文档记录 { file, name, reviewFile, assetsDir }
   （assetsDir 为库级共享插图目录，可缺省；同库多篇文档共用一份 assets/）。
   读该文档 md 正文 + 该文档 review.json sidecar；版本链 / notesLog 只属于该文档。 */
async function openFactReview(doc) {
  const lib = rvFactLib();
  if (!lib || typeof lib.readDoc !== "function") {
    toast(I18n.t("事实库模块未就绪，无法打开审阅"), "err");
    return;
  }
  const rec = doc && typeof doc === "object" ? doc : null;
  const file = String((rec && rec.file) || "").trim();
  if (!file) {
    toast(I18n.t("该事实库还没有正文文件，请先在团队里建库"), "warn");
    return;
  }
  /* reviewFile 缺省时按 <同目录>/<文档名>.review.json 推导（与 app-factlib.js 一致） */
  let reviewFile = String((rec && rec.reviewFile) || "").trim();
  if (!reviewFile && typeof lib.docPathsOf === "function")
    reviewFile = String((lib.docPathsOf("", { file: file }) || {}).reviewFile || "");
  const name =
    String((rec && rec.name) || "").trim() ||
    (typeof lib.stripExt === "function" && typeof lib.baseNameOf === "function"
      ? lib.stripExt(lib.baseNameOf(file))
      : "");
  const target = {
    type: "fact",
    id: String((rec && rec.id) || ""),
    path: file,
    reviewPath: reviewFile,
    name: name,
    assetsDir: String((rec && rec.assetsDir) || ""),
    canvasId: String((rec && rec.canvasId) || ""),
  };
  /* 正文 = 该文档当前稿 */
  const r = await lib.readDoc({ file: file });
  const text = String((r && r.content) || "");
  if (!text.trim()) {
    toast(I18n.t("该事实库正文为空，请先写入内容再审阅"), "warn");
    return;
  }
  /* sidecar = 该文档的版本链 / notesLog；无 sidecar 则用正文作为原始稿 V1 */
  let d = await lib.readReview({ file: file, reviewFile: reviewFile });
  if (!d || !Array.isArray(d.versions) || !d.versions.length) {
    d = {
      createdAt: Date.now(),
      versions: [{ text: text, notes: [], ts: Date.now(), src: I18n.t("原始") }],
      notesLog: [],
    };
    lib.writeReview({ file: file, reviewFile: reviewFile }, d);
  }
  if (!Array.isArray(d.notesLog)) d.notesLog = [];
  _rv.doc = d;
  beginReview(target);
}

/* 共同初始化：置会话、刷新版本、建窗并渲染。 */
function beginReview(target) {
  _rv.target = target;
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
    '<div class="review-settings" id="reviewSettings" hidden></div>' +
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
  /* 关闭时自动采用当前可编辑最新版写回目标（node.output / 事实库 md 正文），
     不清下游、不关窗；先把版本链落盘再清会话，避免 sidecar / 正文写到一半丢。 */
  const done = () => {
    persistReview(true);
    _rv.target = null;
    _rv.doc = null;
  };
  const p = adoptLatestToNode();
  if (p && typeof p.then === "function") p.then(done, done);
  else done();
  h.classList.remove("on");
  document.body.classList.remove("review-lock");
}

/* ---------- 持久化 ---------- */
function persistReview(immediate) {
  if (!_rv.target) return;
  if (rvTargetIs("fact")) {
    /* 事实库：版本链 / notesLog 落 <name>.review.json */
    const lib = rvFactLib();
    if (lib && typeof lib.writeReview === "function" && _rv.doc) {
      return Promise.resolve(lib.writeReview(rvFactOf(), _rv.doc));
    }
    return;
  }
  if (!reviewDoc()) return;
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
  const cur = reviewCurrent();
  const isFact = rvTargetIs("fact");
  const node = isFact ? null : nodeById(_rv.target.id);
  h.querySelector("#reviewTitle").textContent =
    I18n.t("审阅 · ") +
    (isFact
      ? I18n.t("事实库") + (targetName() ? " · " + targetName() : "")
      : node
        ? node.title
        : "");
  h.querySelector("#reviewNode").textContent = isFact
    ? String((_rv.target && _rv.target.path) || "")
    : "";
  renderFactSettings(h);
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

/* 文档目标显示名（节点标题 / 事实库名）。 */
function targetName() {
  if (!_rv.target) return "";
  if (rvTargetIs("fact")) return String(_rv.target.name || "");
  const n = nodeById(_rv.target.id);
  return n ? String(n.title || "") : "";
}

/* ── 事实库审阅头部：服务商 / 模型 / 温度（写回 fact 记录） ──
   默认取任一可用文本服务商；换服务商时模型跟随该服务商模型表。 */
function renderFactSettings(h) {
  const wrap = h.querySelector("#reviewSettings");
  if (!wrap) return;
  wrap.innerHTML = "";
  if (!rvTargetIs("fact")) {
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;
  const rec = rvFactRecord();
  const provs = apiProvidersForKind("proc_text");
  const nameEl = document.createElement("span");
  nameEl.className = "rv-set-lib";
  nameEl.textContent =
    I18n.t("事实库") + "：" + ((rec && rec.name) || targetName() || "");
  wrap.appendChild(nameEl);

  const mkField = (labelText, control) => {
    const f = document.createElement("label");
    f.className = "rv-set-field";
    const s = document.createElement("span");
    s.textContent = labelText;
    f.appendChild(s);
    f.appendChild(control);
    return f;
  };

  /* 服务商（fact 记录里记的服务商可能已从配置删除 → 补一个「自定义」项，避免回显空白） */
  const provSel = document.createElement("select");
  if (!provs.length) {
    const o = document.createElement("option");
    o.value = "";
    o.textContent = I18n.t("（无可用文本服务商）");
    provSel.appendChild(o);
  }
  for (const p of provs) {
    const o = document.createElement("option");
    o.value = p.id;
    o.textContent = p.name || p.id;
    provSel.appendChild(o);
  }
  const curProv =
    (rec && rec.providerId) ||
    (provs[0] && provs[0].id) ||
    "";
  if (curProv && !provs.some((p) => p.id === curProv)) {
    const o = document.createElement("option");
    o.value = curProv;
    o.textContent = curProv + I18n.t("（自定义）");
    provSel.appendChild(o);
  }
  provSel.value = curProv;

  /* 模型 */
  const modelSel = document.createElement("select");
  const fillModels = (provId, curModel) => {
    modelSel.innerHTML = "";
    const p = provs.find((x) => x.id === provId);
    const models = (p && p.models ? p.models.slice() : []) || [];
    const cur = String(curModel || (models[0] || "")).trim();
    if (cur && models.indexOf(cur) < 0) models.unshift(cur);
    if (!models.length) {
      const o = document.createElement("option");
      o.value = "";
      o.textContent = I18n.t("（无可用模型）");
      modelSel.appendChild(o);
      return;
    }
    for (const m of models) {
      const o = document.createElement("option");
      o.value = m;
      o.textContent = m;
      modelSel.appendChild(o);
    }
    modelSel.value = cur;
  };
  fillModels(curProv, rec && rec.model);

  /* 温度 */
  const temp = document.createElement("input");
  temp.type = "number";
  temp.className = "rv-set-temp";
  temp.min = "0";
  temp.max = "2";
  temp.step = "0.1";
  temp.value = String(rec && rec.temperature != null ? rec.temperature : 0.7);

  /* 写回所属事实库记录（渲染层事实库真源 MTNodeTeam，按文档 md 反查；无记录时仅存会话内）。 */
  const patchFact = (patch) => {
    const team = window.MTNodeTeam;
    const cur = rvFactRecord();
    if (team && cur && typeof team.updateFact === "function") {
      const canvasId = rvFactCanvasId();
      if (canvasId) team.updateFact(canvasId, patch);
    }
    if (_rv.target) _rv.target.fact = Object.assign({}, _rv.target.fact || {}, patch);
  };
  provSel.addEventListener("change", () => {
    const p = provs.find((x) => x.id === provSel.value);
    const m = p && p.models && p.models.length ? p.models[0] : "";
    patchFact({ providerId: provSel.value, model: m });
    fillModels(provSel.value, m);
  });
  modelSel.addEventListener("change", () => {
    patchFact({ model: modelSel.value });
  });
  temp.addEventListener("change", () => {
    let v = Number(temp.value);
    if (!Number.isFinite(v)) v = 0.7;
    v = Math.max(0, Math.min(2, v));
    temp.value = String(v);
    patchFact({ temperature: v });
  });

  wrap.appendChild(mkField(I18n.t("服务商"), provSel));
  wrap.appendChild(mkField(I18n.t("模型"), modelSel));
  wrap.appendChild(mkField(I18n.t("温度"), temp));
}

/* 当前文档所属的事实库团队记录（服务商 / 模型 / 温度的落点；有则返回，无则 null）。
   入参只给单篇文档，故按「文档 md 路径」在团队目录里反查所属库。 */
function rvFactRecord() {
  if (!rvTargetIs("fact")) return null;
  if (_rv.target.fact) return _rv.target.fact;
  const team = window.MTNodeTeam;
  const id = rvFactCanvasId();
  if (team && id && typeof team.fact === "function") return team.fact(id);
  return null;
}
/* 文档所属画布 id：按该文档 md 路径反查（同库多篇文档各自命中同一库记录）。 */
function rvFactCanvasId() {
  if (!_rv.target) return "";
  if (_rv.target.canvasId) return String(_rv.target.canvasId);
  const team = window.MTNodeTeam;
  const file = String(_rv.target.path || "");
  if (!team || !file || typeof team.canvases !== "function") return "";
  const norm = (p) => String(p || "").replace(/\\/g, "/").toLowerCase();
  const want = norm(file);
  const hit = (team.canvases() || []).find((c) => {
    const f = c && c.fact;
    if (!f) return false;
    if (norm(f.file) === want) return true;
    return (Array.isArray(f.docs) ? f.docs : []).some(
      (d) => d && norm(d.file) === want,
    );
  });
  return hit ? String(hit.id || "") : "";
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
  mk("image", "🖼", I18n.t("插入图片"));
  mk("table", "▦", I18n.t("插入表格"));
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
      /* 图片粘贴（剪贴板 / 截图）与拖拽（本机文件） */
      ed.addEventListener("paste", (ev) => onRichPaste(ev, ed));
      ed.addEventListener("dragover", (ev) => {
        const dt = ev.dataTransfer;
        if (dt && Array.from(dt.types || []).indexOf("Files") >= 0) {
          ev.preventDefault();
          dt.dropEffect = "copy";
        }
      });
      ed.addEventListener("drop", (ev) => onRichDrop(ev, ed));
      /* 插图选中态：点中图片加 .rv-img-sel（同时只留一张），样式见 review.css */
      ed.addEventListener("click", (ev) => {
        const hit = ev.target && ev.target.tagName === "IMG" ? ev.target : null;
        Array.from(ed.querySelectorAll("img.rv-img-sel")).forEach((im) => {
          if (im !== hit) im.classList.remove("rv-img-sel");
        });
        if (hit) hit.classList.add("rv-img-sel");
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
  if (!_rv.target) return;
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
  let html = "";
  try {
    if (window.marked && window.marked.parse) {
      html = window.marked.parse(s, { gfm: true, breaks: true });
    }
  } catch (_) {}
  if (!html) html = "<p>" + escH(s) + "</p>";
  return rvRewriteImgSrc(html);
}
function escH(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escAttr(s) {
  return escH(s).replace(/"/g, "&quot;");
}

/* ── 事实库图片：md 里的相对路径 ⇄ 富文本里可显示的 file:/// 绝对路径 ──
   正文是磁盘上的 Markdown，图片以 assets/<name> 相对路径引用（可移植、可手改）；
   富文本编辑区必须用绝对路径才能显示，故渲染时写 data-rv-src 记住原始相对路径，
   序列化回 Markdown 时优先读它，保证往返幂等。 */

/* 当前文档的路径集合（非 fact 目标返回 null）：
   dir = 库目录（assets/ 的父目录，用于把 assets/x 相对引用拼成绝对路径），
   assetsDir = 库级共享插图目录（缺省时按 <库目录>/assets 兜底）。 */
function rvFactPaths() {
  if (!rvTargetIs("fact")) return null;
  const lib = rvFactLib();
  const t = _rv.target || {};
  const file = String(t.path || "");
  if (!lib || !file) return null;
  const dir = rvFactDir();
  const assetsDir =
    String(t.assetsDir || "") ||
    (dir && typeof lib.joinPath === "function"
      ? lib.joinPath(dir, "assets")
      : "");
  return {
    dir: dir,
    name: String(t.name || ""),
    file: file,
    reviewFile: String(t.reviewPath || ""),
    assetsDir: assetsDir,
  };
}
/* 本机路径 → 可显示的 file:/// URL（复用画布层的统一口径，缺桥时回退）。 */
function rvFileUrl(p) {
  const s = String(p || "").trim();
  if (!s) return "";
  if (/^file:\/\//i.test(s)) return s;
  try {
    if (typeof mediaFileUrlOf === "function") {
      const u = mediaFileUrlOf(s);
      if (u) return u;
    }
  } catch (_) {}
  try {
    if (window.api && window.api.toFileUrl)
      return String(window.api.toFileUrl(s) || "") || s;
  } catch (_) {}
  return s;
}
/* 相对引用判断：非协议、非绝对路径、非 data URL。 */
function rvIsRelSrc(src) {
  const s = String(src || "").trim();
  if (!s) return false;
  if (/^(https?:|data:|file:|blob:|\/\/)/i.test(s)) return false;
  if (/^[a-zA-Z]:[\\/]/.test(s)) return false;
  if (s.charAt(0) === "/" || s.charAt(0) === "\\") return false;
  return true;
}
/* fact 目标下把富文本里的相对图片 src 换成绝对 URL，并记下 data-rv-src。 */
function rvRewriteImgSrc(html) {
  if (!rvTargetIs("fact")) return html;
  const paths = rvFactPaths();
  const lib = rvFactLib();
  if (!paths || !lib) return html;
  let tpl = null;
  try {
    tpl = document.createElement("template");
    tpl.innerHTML = String(html || "");
  } catch (_) {
    return html;
  }
  const imgs = tpl.content.querySelectorAll("img");
  if (!imgs.length) return html;
  for (const img of imgs) {
    const src = String(img.getAttribute("src") || "").trim();
    if (!src) continue;
    if (!rvIsRelSrc(src)) {
      /* 已是绝对路径 / URL：原样保留，仍记下以便序列化 */
      if (!img.getAttribute("data-rv-src")) img.setAttribute("data-rv-src", src);
      continue;
    }
    img.setAttribute("data-rv-src", src);
    let rel = src;
    try {
      rel = decodeURIComponent(src);
    } catch (_) {}
    img.setAttribute("src", rvFileUrl(lib.joinPath(paths.dir, rel)));
  }
  return tpl.innerHTML;
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
    case "img": {
      /* 优先 data-rv-src（原始相对路径），保证事实库 md 可移植、可手改 */
      const src =
        node.getAttribute("data-rv-src") ||
        node.getAttribute("src") ||
        "";
      return "![" + (node.getAttribute("alt") || "") + "](" + src + ")";
    }
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
      /* 直接挂在编辑区根节点下的图片（不在 p 里）也要能序列化回 md */
      if (tag === "img") {
        const line = inlineToMd(child).trim();
        if (line) parts.push(line);
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
    case "image": {
      reviewImageDialog().then(async (picked) => {
        if (!picked) return;
        const saved = await rvSaveImage(picked);
        if (!saved) return;
        rvInsertSourceText(ta, "![" + saved.alt + "](" + saved.rel + ")");
        rvGcOrphanImages();
      });
      break;
    }
    case "table":
      reviewTableDialog().then((d) => {
        if (!d) return;
        const md = rvTableMd(d.rows, d.cols);
        const a2 = ta.selectionStart;
        const needNl = a2 > 0 && ta.value.charAt(a2 - 1) !== "\n";
        rvInsertSourceText(ta, (needNl ? "\n\n" : "") + md + "\n");
      });
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
      case "image": {
        const range = rvRangeIn(ed);
        reviewImageDialog().then(async (picked) => {
          if (!picked) return;
          const saved = await rvSaveImage(picked);
          if (!saved) return;
          rvRestoreRange(range, ed);
          rvInsertImgRich(saved);
        });
        return true;
      }
      case "table": {
        const range = rvRangeIn(ed);
        reviewTableDialog().then((d) => {
          if (!d) return;
          rvRestoreRange(range, ed);
          const frag = document.createRange().createContextualFragment(
            rvTableHtml(d.rows, d.cols),
          );
          insertRichNode(frag);
          _rv.dirty = true;
          commitEditorToDoc();
          renderFootbarBox();
        });
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

/* ---------- 图片 / 表格插入（事实库插图 + 剪贴板 / 截图 / 拖拽） ---------- */

/* 记住 / 还原富文本选区（开对话框后选区会丢，插入前要还原）。 */
function rvRangeIn(ed) {
  try {
    const sel = window.getSelection();
    if (sel && sel.rangeCount && sel.anchorNode && ed && ed.contains(sel.anchorNode))
      return sel.getRangeAt(0).cloneRange();
  } catch (_) {}
  return null;
}
function rvRestoreRange(range, ed) {
  try {
    if (range) {
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
    if (ed) ed.focus();
  } catch (_) {}
}

/* 小对话框：选择本机图片文件 / 从剪贴板粘贴（截图）。
   返回 Promise<{srcPath|base64,name,ext}|null>；两张按钮点下即取图并关闭。 */
function reviewImageDialog() {
  return new Promise((resolve) => {
    let done = false;
    const fin = (v) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    try {
      mtDialogForm({
        title: I18n.t("插入图片"),
        msg: rvTargetIs("fact")
          ? I18n.t("图片会复制到事实库的 assets 目录，正文以相对路径引用")
          : I18n.t("图片以本机绝对路径引用"),
        custom: (c, select) => {
          const wrap = document.createElement("div");
          wrap.className = "rv-pick-btns";
          const mk = (label, hint, fn) => {
            const b = document.createElement("button");
            b.type = "button";
            b.className = "rv-img-pick";
            const t = document.createElement("b");
            t.textContent = label;
            b.appendChild(t);
            if (hint) {
              const h = document.createElement("span");
              h.textContent = hint;
              b.appendChild(h);
            }
            b.onclick = () => fn(select);
            wrap.appendChild(b);
          };
          mk(
            I18n.t("选择图片文件…"),
            I18n.t("从本机选择 png / jpg / webp / gif / bmp"),
            async (sel) => {
              const r = await window.api.fileOpenDialog({
                title: I18n.t("选择图片"),
                filters: [
                  {
                    name: I18n.t("图像"),
                    extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp"],
                  },
                  { name: I18n.t("全部文件"), extensions: ["*"] },
                ],
              });
              const p = (r && r.path) || "";
              if (!p) return;
              sel({ srcPath: p, name: rvBaseName(p), ext: rvExtOf(p) });
            },
          );
          mk(
            I18n.t("从剪贴板粘贴（截图）"),
            I18n.t("复制图片或截图后点这里"),
            async (sel) => {
              const r = await window.api.clipboardReadImage();
              if (!r || !r.ok) {
                toast(I18n.t("剪贴板里没有图片"), "warn");
                return;
              }
              sel({ base64: r.base64, name: "screenshot", ext: ".png" });
            },
          );
          c.appendChild(wrap);
        },
        actions: [{ id: "cancel", label: I18n.t("取消") }],
      }).then(
        (res) => fin(res && res.custom ? res.custom : null),
        () => fin(null),
      );
    } catch (_) {
      fin(null);
    }
  });
}

/* 小对话框：表格行列数。返回 Promise<{rows,cols}|null>。 */
function reviewTableDialog() {
  return new Promise((resolve) => {
    let rows = 3;
    let cols = 3;
    let done = false;
    const fin = (v) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    try {
      mtDialogForm({
        title: I18n.t("插入表格"),
        msg: I18n.t("输入行数与列数（含表头行）"),
        custom: (c) => {
          const wrap = document.createElement("div");
          wrap.className = "rv-pick-btns";
          const mkNum = (label, val, min, max, onChange) => {
            const f = document.createElement("label");
            f.className = "rv-num-field";
            const s = document.createElement("span");
            s.textContent = label;
            const i = document.createElement("input");
            i.type = "number";
            i.min = String(min);
            i.max = String(max);
            i.step = "1";
            i.value = String(val);
            i.addEventListener("change", () => {
              let v = Number(i.value);
              if (!Number.isFinite(v)) v = val;
              v = Math.max(min, Math.min(max, Math.round(v)));
              i.value = String(v);
              onChange(v);
            });
            f.appendChild(s);
            f.appendChild(i);
            wrap.appendChild(f);
          };
          mkNum(I18n.t("行数"), rows, 1, 50, (v) => (rows = v));
          mkNum(I18n.t("列数"), cols, 1, 20, (v) => (cols = v));
          c.appendChild(wrap);
        },
        actions: [
          { id: "cancel", label: I18n.t("取消") },
          { id: "ok", label: I18n.t("插入"), primary: true },
        ],
      }).then(
        (res) => fin(res && res.action === "ok" ? { rows: rows, cols: cols } : null),
        () => fin(null),
      );
    } catch (_) {
      fin(null);
    }
  });
}

function rvBaseName(p) {
  const s = String(p || "").replace(/[\\/]+$/, "");
  const i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
  return i >= 0 ? s.slice(i + 1) : s;
}
function rvExtOf(p) {
  const b = rvBaseName(p);
  const i = b.lastIndexOf(".");
  return i > 0 ? b.slice(i).toLowerCase() : "";
}

/* 把选中的图片落盘并算出「相对引用 + 可显示 URL + alt」。
   fact 目标 → 复制进 assets/（相对路径写回 md）；node 目标 → 直接引用本机绝对路径。 */
async function rvSaveImage(picked) {
  const lib = rvFactLib();
  const a = window.api;
  const paths = rvFactPaths();
  if (rvTargetIs("fact") && paths && paths.assetsDir) {
    if (!a || typeof a.factSaveImage !== "function") {
      toast(I18n.t("事实库模块未就绪，无法插入图片"), "err");
      return null;
    }
    const r = await a.factSaveImage({
      dir: paths.assetsDir,
      srcPath: (picked && picked.srcPath) || "",
      base64: (picked && picked.base64) || "",
      name: String((picked && picked.name) || "image").replace(/\s+/g, "-"),
      ext: (picked && picked.ext) || "",
    });
    if (!r || !r.ok) {
      toast(I18n.t("图片保存失败：") + ((r && r.error) || ""), "err");
      return null;
    }
    const rel = "assets/" + r.name;
    const abs = rvFileUrl(lib ? lib.joinPath(paths.dir, rel) : rel);
    return { rel: rel, abs: abs, alt: lib ? lib.stripExt(r.name) : r.name };
  }
  const p = String((picked && picked.srcPath) || "").trim();
  if (!p) {
    toast(
      I18n.t("该目标不支持从剪贴板插入图片，请选择本机图片文件"),
      "warn",
    );
    return null;
  }
  return {
    rel: p,
    abs: rvFileUrl(p),
    alt: lib ? lib.stripExt(rvBaseName(p)) : rvBaseName(p),
  };
}

/* 富文本插入 <img>（src = 可显示绝对 URL，data-rv-src = 写回 md 的引用）。 */
function rvInsertImgRich(saved) {
  const ed = document.querySelector(".review-editor .rv-rich");
  if (!ed || !saved) return;
  const html =
    '<img src="' +
    escAttr(saved.abs) +
    '" data-rv-src="' +
    escAttr(saved.rel) +
    '" alt="' +
    escAttr(saved.alt || "") +
    '">';
  insertRichNode(document.createRange().createContextualFragment(html));
  _rv.dirty = true;
  commitEditorToDoc();
  renderFootbarBox();
  rvGcOrphanImages();
}

/* 源码模式：在光标处插入一段 Markdown 文本，并同步当前版本。 */
function rvInsertSourceText(ta, text) {
  const a = ta.selectionStart;
  const b = ta.selectionEnd;
  ta.value = ta.value.slice(0, a) + text + ta.value.slice(b);
  const pos = a + text.length;
  ta.setSelectionRange(pos, pos);
  const v = reviewCurrent();
  if (v) v.text = ta.value;
  _rv.dirty = true;
  ta.focus();
  renderFootbarBox();
}

/* 表格：富文本 HTML / 源码 Markdown 两种形态。 */
function rvTableHtml(rows, cols) {
  const r = Math.max(1, rows | 0);
  const c = Math.max(1, cols | 0);
  let head = "<tr>";
  for (let i = 0; i < c; i++)
    head += "<th>" + escH(I18n.t("列") + (i + 1)) + "</th>";
  head += "</tr>";
  let body = "";
  for (let i = 1; i < r; i++) {
    body += "<tr>";
    for (let j = 0; j < c; j++) body += "<td><br></td>";
    body += "</tr>";
  }
  return "<table><thead>" + head + "</thead><tbody>" + body + "</tbody></table>";
}
function rvTableMd(rows, cols) {
  const r = Math.max(1, rows | 0);
  const c = Math.max(1, cols | 0);
  const head = [];
  for (let i = 0; i < c; i++) head.push(I18n.t("列") + (i + 1));
  const out = ["| " + head.join(" | ") + " |"];
  const sep = [];
  for (let i = 0; i < c; i++) sep.push("---");
  out.push("| " + sep.join(" | ") + " |");
  for (let i = 1; i < r; i++) {
    const row = [];
    for (let j = 0; j < c; j++) row.push("");
    out.push("| " + row.join(" | ") + " |");
  }
  return out.join("\n");
}

/* 富文本粘贴：剪贴板位图（含截图）直接落盘插图，纯文本粘贴不拦截。 */
function onRichPaste(ev, ed) {
  if (!_rv.editing) return;
  const dt = ev.clipboardData;
  let file = null;
  if (dt) {
    for (const it of Array.from(dt.items || [])) {
      if (it.kind === "file" && /^image\//i.test(it.type || "")) {
        file = it.getAsFile();
        if (file) break;
      }
    }
    if (!file) {
      for (const f of Array.from(dt.files || [])) {
        if (/^image\//i.test(f.type || "")) {
          file = f;
          break;
        }
      }
    }
  }
  if (file) {
    ev.preventDefault();
    rvInsertFromBlob(file, ed);
    return;
  }
  /* 无文件项、且不是文本 / 文件粘贴（多为截图）→ 走主进程剪贴板取图 */
  const types = dt ? Array.from(dt.types || []) : [];
  const hasText = types.some((t) => /^text\//i.test(t) || t === "text");
  const hasFiles = types.indexOf("Files") >= 0;
  if (dt && !hasText && !hasFiles) {
    ev.preventDefault();
    rvInsertFromClipboard(ed);
  }
}
function onRichDrop(ev, ed) {
  if (!_rv.editing) return;
  const dt = ev.dataTransfer;
  if (!dt) return;
  const files = Array.from(dt.files || []).filter((f) =>
    /^image\//i.test(f.type || ""),
  );
  if (!files.length) return;
  ev.preventDefault();
  const f = files[0];
  let p = "";
  try {
    if (window.api && window.api.getPathForFile)
      p = String(window.api.getPathForFile(f) || "");
  } catch (_) {}
  if (p) {
    rvSaveImage({ srcPath: p, name: rvBaseName(p), ext: rvExtOf(p) }).then(
      (saved) => {
        if (saved) rvInsertImgRich(saved);
      },
    );
  } else {
    rvInsertFromBlob(f, ed);
  }
}
/* 图片 Blob → base64 → 落盘 → 插入（拖拽 / 剪贴板文件项）。 */
function rvInsertFromBlob(file, ed) {
  const reader = new FileReader();
  reader.onload = () => {
    const dataUrl = String(reader.result || "");
    if (!dataUrl) return;
    const m = /^data:([^;,]+)/i.exec(dataUrl);
    const mime = (m && m[1]) || "image/png";
    const ext = "." + mime.replace(/^image\//i, "").replace(/^jpeg$/i, "jpg");
    const range = rvRangeIn(ed);
    rvSaveImage({
      base64: dataUrl,
      name: file.name ? rvBaseName(file.name) : "image",
      ext: ext,
    }).then((saved) => {
      if (!saved) return;
      rvRestoreRange(range, ed);
      rvInsertImgRich(saved);
    });
  };
  reader.onerror = () => {};
  try {
    reader.readAsDataURL(file);
  } catch (_) {}
}
/* 主进程剪贴板位图 → 落盘 → 插入。 */
function rvInsertFromClipboard(ed) {
  const a = window.api;
  if (!a || typeof a.clipboardReadImage !== "function") return;
  const range = rvRangeIn(ed);
  Promise.resolve(a.clipboardReadImage()).then(
    (r) => {
      if (!r || !r.ok) {
        toast(I18n.t("剪贴板里没有图片"), "warn");
        return;
      }
      return rvSaveImage({ base64: r.base64, name: "screenshot", ext: ".png" }).then(
        (saved) => {
          if (!saved) return;
          rvRestoreRange(range, ed);
          rvInsertImgRich(saved);
        },
      );
    },
    () => {},
  );
}

/* 纯函数：从若干版本文本收集被引用的图片（原始引用 + 文件名两种形态）。
   GC 与测试共用，保证「任一留存版本引用到的文件都不删」。 */
function rvCollectImgRefs(texts) {
  const refs = new Set();
  for (const t of texts || []) {
    const s0 = String(t || "");
    const re = /!\[[^\]]*\]\(\s*([^)\s]+)/g;
    let m;
    while ((m = re.exec(s0))) {
      const s = m[1].replace(/^<|>$/g, "").replace(/\\/g, "/");
      refs.add(s);
      const i = s.lastIndexOf("/");
      refs.add(i >= 0 ? s.slice(i + 1) : s);
    }
  }
  return refs;
}
/* 孤立图片回收：assets/ 是库级共享目录，只有「库内所有文档的全部版本」都不引用的
   图片才经主进程从磁盘删除（跨文档引用一律保留，避免别的文档 / 回看 / 回滚断图）。 */
let _rvGcTimer = null;
function rvGcOrphanImages() {
  if (!rvTargetIs("fact")) return;
  if (_rvGcTimer) clearTimeout(_rvGcTimer);
  _rvGcTimer = setTimeout(() => {
    _rvGcTimer = null;
    rvRunGc();
  }, 300);
}
/* 收集库内「所有文档 · 全部版本」引用的图片：
   · 当前文档用内存版本链（可能含尚未落盘的编辑，比 sidecar 新）；
   · 其它文档读各自 sidecar 的 versions；
   · 每篇文档的 md 正文也计入（无 sidecar / 手改 md 的引用同样不误删）。 */
async function rvCollectLibImgRefs(lib, paths, a) {
  const texts = [];
  const cur = reviewDoc();
  if (cur && cur.review && Array.isArray(cur.review.versions))
    for (const v of cur.review.versions) texts.push(v && v.text);
  const curReview = String((rvFactOf() || {}).reviewFile || "")
    .replace(/\\/g, "/")
    .toLowerCase();
  const dir = String((paths && paths.dir) || "");
  let list = [];
  if (dir) {
    try {
      const r = await a.fileListDir(dir);
      list = (r && r.ok && r.list) || [];
    } catch (_) {
      list = [];
    }
  }
  for (const f of list) {
    if (!f || f.isDir) continue;
    const rel = String(f.rel || f.name || "");
    const low = rel.toLowerCase();
    const isReview = low.endsWith(".review.json");
    if (!isReview && !low.endsWith(".md")) continue;
    const abs = lib.joinPath(dir, rel);
    if (isReview) {
      /* 当前文档的 sidecar 可能落后于内存 → 用内存版本链，跳过磁盘上的这份 */
      if (abs.replace(/\\/g, "/").toLowerCase() === curReview) continue;
      let d = null;
      try {
        d = await lib.readReview({ reviewFile: abs });
      } catch (_) {}
      if (d && Array.isArray(d.versions))
        for (const v of d.versions) texts.push(v && v.text);
    } else {
      let r2 = null;
      try {
        r2 = await lib.readDoc({ file: abs });
      } catch (_) {}
      if (r2 && r2.content) texts.push(r2.content);
    }
  }
  return rvCollectImgRefs(texts);
}
async function rvRunGc() {
  if (!rvTargetIs("fact")) return;
  const n = reviewDoc();
  const paths = rvFactPaths();
  const lib = rvFactLib();
  const a = window.api;
  if (!n || !paths || !paths.assetsDir || !lib) return;
  if (!a || typeof a.fileListDir !== "function" || typeof a.factDeleteImages !== "function")
    return;
  const refs = await rvCollectLibImgRefs(lib, paths, a);
  let list = [];
  try {
    const r = await a.fileListDir(paths.assetsDir);
    list = (r && r.ok && r.list) || [];
  } catch (_) {
    return;
  }
  const orphans = [];
  for (const f of list) {
    if (!f || f.isDir) continue;
    const rel = String(f.rel || f.name || "").replace(/\\/g, "/");
    const i = rel.lastIndexOf("/");
    const base = i >= 0 ? rel.slice(i + 1) : rel;
    if (refs.has(rel) || refs.has("assets/" + rel) || refs.has(base)) continue;
    orphans.push(lib.joinPath(paths.assetsDir, rel));
  }
  if (!orphans.length) return;
  try {
    const d = await a.factDeleteImages(orphans);
    const removed = (d && d.removed) || [];
    if (removed.length)
      toast(
        I18n.t("已从磁盘删除 ") +
          removed.length +
          I18n.t(" 个无引用图片"),
        "ok",
      );
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

/* 审阅修订用目标自身 provider+model；节点未显式选服务商（跑过但 providerId 空）/
   事实库未选服务商时，回退到任一可用文本服务商，避免误报“未配置”。 */
function reviewResolveProv(node) {
  const list = (S.config.providers || []);
  /* 事实库：优先 fact 记录上的 providerId（头部下拉写回的那份） */
  const rec = rvFactRecord();
  const pid = rvTargetIs("fact")
    ? String((rec && rec.providerId) || "").trim()
    : node && node.providerId;
  let prov = pid ? list.find((p) => p.id === pid) : null;
  if (!prov) {
    prov =
      list.find(
        (p) => p.type === "text_openai" && String(p.apiKey || "").trim(),
      ) || null;
  }
  return prov;
}

/* 当前目标的模型 / 温度 / effort（事实库取 fact 记录，节点取节点字段）。 */
function reviewModelOf(prov) {
  const rec = rvFactRecord();
  if (rvTargetIs("fact")) {
    return String((rec && rec.model) || (prov && prov.models && prov.models[0]) || "");
  }
  const node = nodeById(_rv.target && _rv.target.id);
  return String((node && node.model) || (prov && prov.models && prov.models[0]) || "");
}
function reviewTemperatureOf() {
  const rec = rvFactRecord();
  const raw = rvTargetIs("fact")
    ? rec && rec.temperature
    : (nodeById(_rv.target && _rv.target.id) || {}).temperature;
  return raw == null ? 0.7 : Math.max(0, Math.min(2, Number(raw) || 0));
}
function reviewEffortOf() {
  if (rvTargetIs("fact")) return undefined;
  const node = nodeById(_rv.target && _rv.target.id);
  return typeof normalizeTextEffort === "function"
    ? normalizeTextEffort(node && node.effort)
    : undefined;
}

async function runRevision() {
  const n = reviewDoc();
  if (!n || !_rv.target) return;
  commitEditorToDoc();
  const v = reviewCurrent();
  if (!v || _rv.busy) return;
  const total = (v.notes || []).length;
  if (!total) return;
  const prov = reviewResolveProv(nodeById(_rv.target.id));
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
  const model = reviewModelOf(prov);
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
    const node = nodeById(_rv.target.id);
    const spec = {
      provider: prov,
      kind: "text",
      model: model,
      temperature: reviewTemperatureOf(),
      effort: reviewEffortOf(),
      size: "",
      prompt: prompt,
      texts: [],
      images: [],
      refImage: "",
      abKey: (node && node._abKey) || "",
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
    /* 新版正文的真源就是模型返回的 out（已在 push 前 commit 过用户改动）。
       这里必须 skipCommit：编辑器 DOM 此刻仍是上一版的富文本 / 源码，
       若再走 commitEditorToDoc 会把刚生成的新版正文覆盖回旧文，
       表现为「批注后点 AI 修订，内容没有任何变化」。DOM 交给 renderReviewView 重渲染。 */
    adoptLatestToNode({ skipCommit: true });
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
  rvGcOrphanImages();
  renderReviewDlg();
  toast(I18n.t("已回滚，该版现在是当前可编辑版"), "ok");
}

/* 自动采用最新可编辑版：把审阅结果写回目标（节点输出 / 事实库 md 正文；不关窗、不提示）。
   返回是否成功（事实库为 Promise<boolean>）。
   opts.skipCommit=true：跳过「把编辑器 DOM 落回当前版」——用于 runRevision 刚 push 新版、
   DOM 还停在上一版的时刻，否则会把新版正文覆盖回旧文。 */
function adoptLatestToNode(opts) {
  const n = reviewDoc();
  if (!n || !_rv.target) return false;
  if (rvTargetIs("fact")) return adoptLatestToFact(opts);
  const node = nodeById(_rv.target.id);
  if (!node) return false;
  if (!(opts && opts.skipCommit)) commitEditorToDoc();
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

/* 事实库：采用当前可编辑版 → 写回 <name>.md 正文（并落 sidecar）。
   opts.skipCommit 语义同 adoptLatestToNode（AI 修订后 DOM 尚停在上一版时用）。 */
function adoptLatestToFact(opts) {
  const lib = rvFactLib();
  const fact = rvFactOf();
  if (!lib || !fact || typeof lib.writeDoc !== "function") return Promise.resolve(false);
  if (!(opts && opts.skipCommit)) commitEditorToDoc();
  const v = reviewCurrent();
  if (!v) return Promise.resolve(false);
  const text = String(v.text || "");
  if (!text.trim()) return Promise.resolve(false);
  return Promise.resolve(lib.writeDoc(fact, text)).then((ok) => {
    persistReview(true);
    rvGcOrphanImages();
    return !!ok;
  });
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
