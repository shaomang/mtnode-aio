"use strict";
/* ===== 文本节点的 Markdown 编辑器（WPS 式写作 + 批注 + AI 逐轮修订） =====
 *
 * 需求：给「文本节点」（kind = input_text，可编辑形态 —— 非只读 / 非继承 / 非拆分）加一枚
 * 节点头部 ✎ 入口，打开一个近乎全屏、右下可拖调的写作窗：正文所见即所得（也可切源码）、
 * 顶部方形图标工具栏做全套 Markdown 编辑（标题 / 粗斜删 / 引用 / 列表 / 待办 / 链接 /
 * 行内码 / 代码块 / 图片 / 表格 / 水平线 / 公式 + 撤销重做），并支持全文批注与局部批注、
 * 「让 AI 依据批注修订」逐轮出新版；每版完整留存、可回看 / 回滚。
 *
 * 与既有能力的分工（刻意不再造第二份实现）：
 *   · 正文 ⇄ Markdown 的真源仍是 renderer/app-review.js 的 mdToRichHtml / richToMarkdown /
 *     rvTableHtml / rvTableMd（含公式 data-rv-tex 往返与表格序列化），本模块直接调用；
 *   · 插图能力是 renderer/app-inline-img.js 的 window.MTInlineImg（粘贴 / 拖入 / 选择文件），
 *     本模块只提供「落盘到画布工作目录 assets/」的目标描述符；
 *   · 修订调用沿用同一套口径：apiCallTextStream(spec) + app-review.js 的 buildRevisionPrompt
 *     （当前版全文 + 历史全部批注）+ stripFences + 服务商回退规则（reviewResolveProv）。
 *
 * 数据：版本链 / 批注与「✎ AI 审阅」**共用同一份 node.review**
 *   node.review = { createdAt, versions:[{text, notes:[], ts, src}], notesLog:[{round,kind,snippet,body}] }
 *   本编辑器写的是 node.text（文本节点是输入节点，下游读的就是它），不写 node.output。
 *   同一节点两个窗互斥（见 openTextReview 开头与 openTextNodeEditor 开头各一次收窗）。
 *
 * 保存（实时保存：不再要求用户主动保存）：
 *   正文每次 input / 工具栏动作 / 批注增删都走 teScheduleAutoSave() —— 停笔 TE_SAVE_DEBOUNCE_MS 毫秒后
 *   自动落盘一次（node.text + node.review + scheduleSave），顶部那颗「保存」按钮已移除；
 *   Ctrl+S 仍是「立即保存」，AI 修订出新版那一刻也立即落盘（teSaveToNode(true)）。
 *   正文变化引起的 clearDownstream（清下游中间结果）只在停笔落盘与关窗时各做一次，不在每个按键上做。
 *   保存结果只回显在底栏状态行（保存中… / 已自动保存 / 保存失败：原因），失败额外弹一次 toast；
 *   实时保存后不存在「未保存的改动」，故关窗不再有「未保存先确认」的夹问。
 *
 * 依赖（全部在调用期取，缺了就降级，不在加载期依赖）：
 *   nodeById / S / pushHistory / scheduleSave / renderCanvas / clearDownstream / toast /
 *   confirmDialog / mtDialogForm / I18n / window.marked / window.MTMathRender /
 *   window.MTInlineImg / apiCallTextStream / normalizeTextEffort / providerModelFilter /
 *   wfWorkspace / ensureRunWorkspace（app.js / app-nodes.js / app-canvas.js 同层脚本）。
 *
 * 样式：复用 css/review.css 的 .rv-* 组件（编辑器与审阅同一套图标语言与版式），
 *   本模块自己的容器类在 css/textedit.css。
 */

/* ---------- 会话状态（内存；持久结构在 node.review） ---------- */
let _te = {
  node: null, // 正在编辑的节点 id
  verIdx: 0, // 当前查看的版本下标
  editing: false, // 当前版是否可编辑（仅最后一版可改）
  src: false, // 源码档
  busy: false, // AI 修订中
  saveState: "idle", // 实时保存状态：idle（还没动过） / pending（等停笔） / ok / err
  saveErr: "", // 最近一次落盘失败的原因（saveState === "err" 时显示）
  saveAt: 0, // 最近一次成功落盘的时刻（状态行给「已自动保存 · 刚刚」用）
  saveTimer: 0, // 实时保存的防抖句柄
  localSel: false, // 局部批注开关：开启后拖选正文才弹浮窗
  pushed: "", // 本编辑器上一步写进 node.text 的正文（借此认出「节点那边被改了」）
  rendered: -1, // 编辑区 DOM 代表的是哪一版（-1 = 还没渲染，此时不序列化 DOM）
  timer: 0, // 双向同步轮询句柄（宿主每次重建，关窗停）
  h: 0, // 记住的窗口尺寸（关窗后再开沿用）
  w: 0,
};
/* 正文只有一个真源：文本节点的 node.text（节点板身 textarea 写它，下游也读它），
   编辑器里的版本链只是这份正文的历史。两者必须完全同步，四条路径都在下面：
     ① 开窗  —— 节点正文有变（板身直接输入 / 导入文件 / 上游写入）→ tePullFromNode 拉进当前版；
     ② 编辑  —— 富文本 / 源码每次 input → tePushToNode：当前版正文 + node.text + 板身 textarea 一起走；
     ③ 同开  —— 板身 textarea 在编辑器开着时切成只读并提示（见 teBodyEditable / teRenderBodyTextarea），
                 编辑面只剩一个；万一 node.text 仍被别的路径改了，teSyncTick 轮询拉回来；
     ④ 修订 / 回滚 / 保存 —— 新一版写完后 teTrackNodeText 记住它，持久化仍走 scheduleSave。
   node.review 是内存 + 随画布保存的记录，本模块不调 scheduleSave（编排由调用方与既有路径负责）。 */

/* 当前挂载的编辑面（渲染时登记、重渲染时清空）：序列化 / 工具栏认定哪个面，全靠它，
   不靠 querySelector 现捞 —— 捞错了就会把另一档的 DOM 当成正文。 */
let _teRichEl = null;
let _teSrcEl = null;
/* 上一次打开过的节点 id：会话清掉之后还要能找回板身那颗 textarea（关窗解锁就靠它） */
let _teBodyNodeId = "";
/* 板身上那行「编辑器已打开」提示：按引用记着，关窗时精确摘掉 */
let _teTipEl = null;

/* ---------- 取元素 / 取文档 ---------- */
function teEl(id) {
  const host = document.getElementById("textEditDlg");
  return host ? host.querySelector("#" + id) : null;
}
function teNode() {
  if (!_te.node) return null;
  return typeof nodeById === "function" ? nodeById(_te.node) : null;
}
/* 审阅文档宿主：node.review 所在的节点对象 */
function teDoc() {
  const n = teNode();
  return n && n.review ? n : null;
}
function teVersions() {
  const n = teDoc();
  return n && Array.isArray(n.review.versions) ? n.review.versions : [];
}
function teCurrent() {
  const vs = teVersions();
  return vs.length ? vs[vs.length - 1] : null;
}
/* 当前「看着」的那一版（回看旧版时是旧版） */
function teVisible() {
  const vs = teVersions();
  return vs[_te.verIdx] || null;
}
function teVisibleText() {
  const v = teVisible();
  return v ? String(v.text || "") : "";
}
function teLog() {
  const n = teDoc();
  if (!n) return [];
  if (!Array.isArray(n.review.notesLog)) n.review.notesLog = [];
  return n.review.notesLog;
}
/* ---------- 实时保存（不再要求主动保存） ----------
   正文的任何改动（富文本 input / 源码 input / 工具栏动作 / 批注增删）都走 teScheduleAutoSave()：
   停笔 TE_SAVE_DEBOUNCE_MS 毫秒后自动落盘一次。Ctrl+S 与 AI 修订仍走 teSaveToNode(true) 立即落盘。 */
const TE_SAVE_DEBOUNCE_MS = 600;
function teSetSave(s, err) {
  _te.saveState = s;
  _te.saveErr = s === "err" ? String(err || "") : "";
  teRenderFoot();
}
/* 停笔即保存：同一串输入只落盘一次（旧的定时器一律清掉）。 */
function teScheduleAutoSave() {
  if (!_te.editing || !_te.node) return;
  if (typeof setTimeout !== "function") return;
  teSetSave("pending");
  try {
    clearTimeout(_te.saveTimer);
  } catch (_) {}
  _te.saveTimer = setTimeout(() => {
    _te.saveTimer = 0;
    teAutoFlush();
  }, TE_SAVE_DEBOUNCE_MS);
  try {
    if (
      _te.saveTimer &&
      typeof _te.saveTimer === "object" &&
      typeof _te.saveTimer.unref === "function"
    )
      _te.saveTimer.unref();
  } catch (_) {}
}
/* 停笔落盘：正文 → node.text，刷新画布，并清一次下游中间结果
   （打字期间不清，避免每个按键都清一遍把画布刷得乱跳）。 */
function teAutoFlush() {
  if (!_te.node) return false;
  try {
    return teSaveToNode({ immediate: true, clearDown: true, silent: true });
  } catch (e) {
    teSaveFailed(e);
    return false;
  }
}
/* 关窗 / 切档前把待落盘的那一笔写完（没待写的就什么都不做） */
function teFlushPending() {
  if (!_te.saveTimer) return false;
  try {
    clearTimeout(_te.saveTimer);
  } catch (_) {}
  _te.saveTimer = 0;
  return teAutoFlush();
}
/* 兼容旧调用名：批注 / 工具栏插入等路径原先用它标「有未保存改动」，
   实时保存下它的语义就是「催一次自动保存」。 */
function teMarkDirty() {
  teScheduleAutoSave();
}
function teCloseBlocked() {
  if (_te.busy) {
    toast(I18n.t("AI 修订中：等这一轮跑完再关闭（或先看结果）"), "warn");
    return true;
  }
  return false;
}
function tePersist(immediate) {
  if (typeof scheduleSave === "function") scheduleSave(!!immediate);
}

/* ───────── 节点板身 textarea ⇄ 编辑器正文：完全同步 ─────────
   板身那次输入是用户最常用的入口（见 app-canvas.js 的 input_text body），
   与编辑器共用 node.text，任何一侧改动都要立刻在另一侧看见。 */

/* 板身上那颗文本 textarea（没打开 / 已关窗 / 板身被重画都会重新取一次；
   关窗时 _te.node 已经清掉，故调用方要先把节点 id 递进来） */
function teBodyTa(nodeId) {
  const n = teNode();
  const id = String(nodeId || (n && n.id) || _te.node || _teBodyNodeId || "");
  if (!id) return null;
  const el = document.getElementById("node-" + id);
  if (!el || typeof el.querySelector !== "function") return null;
  let ta = null;
  try {
    ta = el.querySelector('textarea.n-text:not([readonly])');
    if (!ta) ta = el.querySelector("textarea.n-text");
  } catch (_) {
    ta = null;
  }
  return ta || null;
}
/* 编辑器开着时板身 textarea 只读：同一份正文不让两个面同时写（内容仍随时同步刷新） */
function teBodyEditable(on, nodeId) {
  const ta = teBodyTa(nodeId);
  if (!ta) return;
  const ro = !on;
  try {
    ta.readOnly = ro;
  } catch (_) {}
  try {
    if (ro) ta.classList.add("n-md-synced");
    else ta.classList.remove("n-md-synced");
  } catch (_) {}
  try {
    if (ro) ta.setAttribute("readonly", "readonly");
    else ta.removeAttribute("readonly");
  } catch (_) {}
  /* 提示元素直接挂在 textarea 上：插过就记着，收的时候按引用摘 —— 不再依赖"再查一次 DOM" */
  if (!ro) {
    if (_teTipEl && _teTipEl.parentNode) _teTipEl.parentNode.removeChild(_teTipEl);
    _teTipEl = null;
    return;
  }
  if (_teTipEl && _teTipEl.parentNode) return;
  if (!ta.parentNode || typeof ta.parentNode.insertBefore !== "function") return;
  const tip = document.createElement("div");
  tip.className = "n-md-open-tip";
  tip.textContent = I18n.t("Markdown 编辑器已打开：正文在那里编辑，这里只读并实时同步");
  tip.title = I18n.t("关闭编辑器后，这里恢复为可编辑");
  ta.parentNode.insertBefore(tip, ta.nextSibling || null);
  _teTipEl = tip;
}
/* 把编辑器里的正文写回板身 textarea：只改 value 不重画整张画布（重画会打断打字） */
function teRenderBodyTextarea() {
  const node = teNode();
  if (!node) return;
  const ta = teBodyTa();
  if (!ta) return;
  const text = String(node.text || "");
  if (String(ta.value == null ? "" : ta.value) !== text) ta.value = text;
}
/* 记住「这一步写进 node.text 的正文」，供轮询认出节点那边的外部改动 */
function teTrackNodeText(node) {
  _te.pushed = String((node && node.text) || "");
  return _te.pushed;
}

/* ① 拉：节点正文 ≠ 当前版 → 以节点正文为准刷新当前版（顺带把板身显示对齐）。
   只认「确实变了」的情形，避免把编辑器里刚打的字用旧正文盖掉。 */
function tePullFromNode(node, silent) {
  if (!node) return false;
  const text = String(node.text || "");
  if (!node.review || !Array.isArray(node.review.versions)) return false;
  const vs = node.review.versions;
  if (!vs.length) {
    vs.push({ text: text, notes: [], ts: Date.now(), src: I18n.t("原始") });
    _te.pushed = text;
    if (!silent) teRenderAll();
    return true;
  }
  const cur = vs[vs.length - 1];
  /* 节点正文与**历史某一版**一致（回滚 / 换节点对象）→ 别把旧正文当新内容覆盖当前版 */
  if (vs.some((v) => String((v && v.text) || "") === text)) {
    _te.pushed = text;
    return false;
  }
  const ctext = String((cur && cur.text) || "");
  /* 节点正文与本编辑器上一步写下去的一模一样 → 是我们自己写的，不是外部改动 */
  if (text === _te.pushed && text === ctext) return false;
  if (text === ctext) {
    _te.pushed = text;
    return false;
  }
  cur.text = text;
  cur.ts = Date.now();
  _te.pushed = text;
  teRenderBodyTextarea();
  if (!silent) {
    teRenderAll();
    toast(I18n.t("已从节点正文同步最新内容"), "ok");
  }
  return true;
}

/* ② 推：编辑器正文 → 当前版 + node.text + 板身 textarea（每次 input / 切换档位 / 每次保存）。
   注意「只有正文真的变了才排实时保存」这一层守卫：teSyncTick 每 700ms 也会走一次 teCommit →
   tePushToNode，若无条件排保存，编辑器开着（哪怕没在打字）就会每 700ms 落一次盘、
   底栏状态永远停在「保存中…」。 */
function tePushToNode() {
  if (!_te.editing) return;
  const node = teNode();
  if (!node) return;
  const v = teCurrent();
  if (!v) return;
  const text = String(v.text || "");
  const changed = text !== _te.pushed;
  if (String(node.text || "") !== text) node.text = text;
  teTrackNodeText(node);
  teRenderBodyTextarea();
  /* 正文一改就排一次实时保存（所有改动路径：富文本 / 源码 / 工具栏插入 / 批注都经过这里）；
     与上一步写下去的正文一模一样就不排 —— 开窗后的第一次序列化（Markdown 归一化往返）、
     以及没在打字的 700ms 轮询，都不该被当成一次改动去反复落盘。 */
  if (changed) teScheduleAutoSave();
}

/* ③ 轮询（编辑器开着期间）：板身 / 别的路径改了 node.text → 拉回来；当前版在别处被改 → 推过去。
   打字期间不动（编辑区 DOM 是此刻最新的，重渲染只会打断输入）。 */
function teSyncTick() {
  const host = document.getElementById("textEditDlg");
  if (!host || !host.classList.contains("on") || _te.busy) return;
  const node = teNode();
  if (!node) return;
  const text = String(node.text || "");
  /* 顺序要紧：先判「node.text 还是不是我们写下去的那份」，再谈序列化编辑区。
     否则 node.text 被别的路径改过时，teCommit 会把编辑区里那份旧文又写回 node.text，
     外部改动就被吃掉了（拉回来再重渲染才是对的）。 */
  if (text !== _te.pushed) {
    /* 焦点还在正文编辑面里 = 用户正在这里打字，此刻绝不重渲染打断他
       （焦点落在窗壳 / 按钮上不算：那不是打字现场） */
    let focused = false;
    try {
      const a = document.activeElement;
      const ed = host.querySelector(".rv-rich");
      const src = host.querySelector(".rv-src");
      focused =
        !!a && ((ed && (a === ed || (ed.contains && ed.contains(a)))) || (src && a === src));
    } catch (_) {}
    if (!focused) tePullFromNode(node, false);
    return;
  }
  if (_te.editing && !_te.src && _te.rendered === _te.verIdx) teCommit();
  const v = teCurrent();
  if (!v) return;
  if (String(v.text || "") !== text) {
    v.text = text;
    teRenderAll();
    return;
  }
  teRenderBodyTextarea();
}
/* 同步轮询在本编辑器第 N 次「打开 → 关窗」上只跑一个（宿主是持久的，重复打开不能叠加定时器） */
let _teSyncSeq = 0;
function teSyncStart() {
  teSyncStop();
  _teSyncSeq += 1;
  const seq = _teSyncSeq;
  /* 编辑器开着时才轮询（关窗立刻停；宿主是持久的，重复打开也只留一个） */
  if (typeof setInterval !== "function") return;
  const id = setInterval(() => {
    const host = document.getElementById("textEditDlg");
    if (!host || !host.classList.contains("on")) {
      teSyncStop();
      return;
    }
    if (seq !== _teSyncSeq) {
      try {
        clearInterval(id);
      } catch (_) {}
      return;
    }
    try {
      teSyncTick();
    } catch (_) {}
  }, 700);
  /* 后台定时器不该拖住进程（Electron 渲染层无 process，故判存） */
  try {
    if (id && typeof id === "object" && typeof id.unref === "function") id.unref();
  } catch (_) {}
  _te.timer = id;
}
function teSyncStop() {
  if (!_te.timer) return;
  try {
    if (typeof clearInterval === "function") clearInterval(_te.timer);
  } catch (_) {}
  _te.timer = 0;
}

/* ---------- 打开 / 关闭 ---------- */

/* 文本节点是否「可编辑」：非只读、非继承上游、非拆分只读 —— 与节点板身的判据一致。
   判据函数在 app-canvas.js / app.js 里（inputInherited 等），只读取用。 */
function textNodeEditable(node) {
  if (!node || node.kind !== "input_text") return false;
  if (node.ro) return false;
  if (typeof inputInherited === "function") {
    try {
      if (inputInherited(node)) return false;
    } catch (_) {}
  }
  return true;
}

/* 入口：打开文本节点的 Markdown 编辑器（节点头部 ✎ 调用）。 */
function openTextNodeEditor(node) {
  if (!node || node.kind !== "input_text") return;
  if (!textNodeEditable(node)) {
    toast(I18n.t("该文本节点内容只读（来自上游 / 拆分），不能编辑"), "warn");
    return;
  }
  /* 互斥（一）：同一个节点上 ✎ AI 审阅窗开着 → 先收掉，两个编辑面不并存 */
  if (typeof closeReviewDlg === "function" && teReviewOpenFor(node.id)) {
    try {
      closeReviewDlg();
    } catch (_) {}
  }
  if (!node.review || !Array.isArray(node.review.versions) || !node.review.versions.length) {
    node.review = {
      createdAt: Date.now(),
      versions: [
        {
          text: String(node.text || ""),
          notes: [],
          ts: Date.now(),
          src: I18n.t("原始"),
        },
      ],
      notesLog: [],
    };
  }
  if (!Array.isArray(node.review.notesLog)) node.review.notesLog = [];
  /* 会话先认下这颗节点，再拉一次节点正文：板身直接输入的内容不能被旧的版本链压住
     （teRenderBodyTextarea / teBodyTa 都要靠 _te.node 找回板身那颗 textarea） */
  _te.node = node.id;
  _teBodyNodeId = String(node.id || "");
  tePullFromNode(node, true);
  _te.src = false;
  _te.busy = false;
  _te.saveState = "idle";
  _te.saveErr = "";
  _te.saveAt = 0;
  _te.localSel = false;
  _te.pushed = String(node.text || "");
  _te.rendered = -1;
  _te.verIdx = node.review.versions.length - 1;
  _te.editing = true;
  teEnsureHost();
  teOpenHost();
  teRenderAll();
  if (typeof pushHistory === "function") {
    /* 打开时先做一次快照：从空节点开始写的第一笔也能被 Ctrl+Z 撤销 */
    try {
      pushHistory();
    } catch (_) {}
  }
  setTimeout(() => {
    const ed = teRichEl();
    if (ed) ed.focus();
  }, 0);
}

/* ✎ AI 审阅窗是否正开在**同一个节点**上（只读 app-review.js 的会话标记 _rv 与它的窗壳；
   两文件同处渲染层同一作用域，读它是既有跨模块判据的用法）。 */
function teReviewOpenFor(nodeId) {
  const host = document.getElementById("reviewDlg");
  if (!host || !host.classList.contains("on")) return false;
  try {
    const t = (typeof _rv !== "undefined" && _rv && _rv.target) || null;
    if (t && t.type === "node") return String(t.id || "") === String(nodeId || "");
  } catch (_) {}
  /* 拿不到会话标记时保守处理：审阅窗开着就算占用了这个节点 */
  return !!nodeId;
}

/* 本编辑器是否正开在某个节点上（app-review.js 的 openTextReview 反向互斥用）。 */
function textNodeEditorOpenFor(nodeId) {
  const host = document.getElementById("textEditDlg");
  if (!host || !host.classList.contains("on")) return false;
  return String(_te.node || "") === String(nodeId || "");
}

function teClose() {
  if (teCloseBlocked()) return;
  /* 关窗前把待落盘的那一笔写完（清下游也在这里做一次）；关窗本身就是显式落盘点，
     实时保存没跑完的定时器不该被丢掉。 */
  teFlushPending();
  teCommit();
  teSyncStop();
  if (_te.saveTimer) {
    try {
      clearTimeout(_te.saveTimer);
    } catch (_) {}
    _te.saveTimer = 0;
  }
  const host = document.getElementById("textEditDlg");
  if (host) host.classList.remove("on");
  document.body.classList.remove("review-lock");
  /* 会话先清掉，板身解锁按记下来的节点 id 走（此时 teNode() 已经拿不到东西了） */
  const bodyId = String(_te.node || "");
  _te.node = null;
  _te.saveState = "idle";
  _te.saveErr = "";
  _te.rendered = -1;
  _te.pushed = "";
  /* 关窗即把板身 textarea 放回可编辑（并收掉那行提示） */
  teBodyEditable(true, bodyId);
  if (typeof renderCanvas === "function") renderCanvas();
}

/* 关窗（✕ / Esc / 底部按钮共用）：实时保存下不存在「未保存的改动」，
   故不再夹问一句 —— 只把待落盘的最后一笔写完就关（上面的 teClose）。 */
async function teRequestClose() {
  if (teCloseBlocked()) return;
  teClose();
}

/* ---------- 宿主（持久 · 显式关闭 · 可拖调 · 近全屏） ---------- */

function teEnsureHost() {
  let host = document.getElementById("textEditDlg");
  if (host) return host;
  host = document.createElement("div");
  host.id = "textEditDlg";
  host.className = "review-dlg txmd-dlg";
  host.innerHTML =
    '<div class="review-box txmd-box" id="textEditBox" role="dialog" aria-modal="true">' +
    '<div class="review-head">' +
    '<div class="review-title"><span class="review-title-dot">✎</span>' +
    '<b id="textEditTitle"></b><span class="review-node" id="textEditSub"></span></div>' +
    '<div class="review-actions">' +
    '<button type="button" class="rv-btn" id="textEditSizeBtn"></button>' +
    '<button type="button" class="rv-btn rv-revise" id="textEditReviseBtn" hidden>' +
    '<span class="rv-revise-ic">✨</span><span id="textEditReviseTxt"></span></button>' +
    '<button type="button" class="rv-btn" id="textEditCloseBtn">✕</button>' +
    "</div></div>" +
    '<div class="review-toolbar" id="textEditToolbar"></div>' +
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
    '<div class="rv-vtabs" id="textEditVerTabs"></div>' +
    "</div>" +
    '<div class="review-editor" id="textEditEditor"></div>' +
    '<div class="review-footbar" id="textEditFootbar"></div>' +
    "</div>" +
    '<div class="review-notes" id="textEditNotes"></div>' +
    "</div>" +
    '<div class="review-note-float" id="textEditNoteFloat" hidden></div>' +
    '<div class="review-resize" id="textEditResize" title="' +
    I18n.t("拖拽右下角调整大小") +
    '"></div>' +
    "</div>";
  document.body.appendChild(host);

  host.querySelector("#textEditCloseBtn").onclick = () => teRequestClose();
  host.querySelector("#textEditReviseBtn").onclick = () => teRunRevision();
  host.querySelector("#textEditSizeBtn").onclick = () => teToggleSize();
  host.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      ev.stopPropagation();
      teRequestClose();
    }
  });
  /* 档位切换：编辑（所见即所得）/ 源码 */
  Array.from(host.querySelectorAll(".rv-tab[data-mode]")).forEach((b) => {
    b.onclick = () => teSetView(b.getAttribute("data-mode") === "src");
  });  /* 拖右下角调大小（最小宽 ≥ 50% 视口 · 最小高 420px，与审阅窗同口径） */
  const box = host.querySelector("#textEditBox");
  const rz = host.querySelector("#textEditResize");
  let drag = null;
  rz.addEventListener("mousedown", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const r = box.getBoundingClientRect();
    drag = { x: ev.clientX, y: ev.clientY, w: r.width, h: r.height };
  });
  window.addEventListener("mousemove", (ev) => {
    if (!drag) return;
    const minW = Math.max(560, Math.round(window.innerWidth * 0.5));
    const w = Math.max(minW, Math.round(drag.w + (ev.clientX - drag.x)));
    const h = Math.max(420, Math.round(drag.h + (ev.clientY - drag.y)));
    box.style.width = w + "px";
    box.style.height = h + "px";
    _te.w = w;
    _te.h = h;
  });
  window.addEventListener("mouseup", () => {
    drag = null;
  });
  /* 窗口失焦（切到别的程序）：把待落盘的那一笔立刻写完，别等防抖计时器 —— 用户可能就此走开 */
  window.addEventListener("blur", () => {
    if (_te.node) teFlushPending();
  });
  return host;
}

function teOpenHost() {
  const host = document.getElementById("textEditDlg");
  if (!host) return;
  const box = host.querySelector("#textEditBox");
  if (_te.w > 0 && _te.h > 0) {
    box.style.width = _te.w + "px";
    box.style.height = _te.h + "px";
  }
  host.classList.add("on");
  document.body.classList.add("review-lock");
  host.setAttribute("tabindex", "-1");
  try {
    host.focus();
  } catch (_) {}
  teSyncSizeBtn();
  /* 板身 textarea 只读 + 值与节点正文对齐 + 起同步轮询（关窗时各还原） */
  teBodyEditable(false);
  teRenderBodyTextarea();
  teSyncStart();
}

/* 放大 / 还原：近全屏 ⇄ 记住的尺寸 */
function teToggleSize() {
  const box = teEl("textEditBox");
  if (!box) return;
  const r = box.getBoundingClientRect();
  if (!_te.w) {
    _te.w = Math.round(r.width);
    _te.h = Math.round(r.height);
  }
  const big = r.width >= window.innerWidth * 0.98 && r.height >= window.innerHeight * 0.98;
  if (big) {
    box.style.width = _te.w + "px";
    box.style.height = _te.h + "px";
  } else {
    box.style.width = "98vw";
    box.style.height = "98vh";
  }
  teSyncSizeBtn();
}
function teSyncSizeBtn() {
  const b = teEl("textEditSizeBtn");
  const box = teEl("textEditBox");
  if (!b || !box) return;
  const r = box.getBoundingClientRect();
  const big = r.width >= window.innerWidth * 0.98;
  b.textContent = big ? "⤡" : "⤢";
  b.title = big ? I18n.t("还原窗口大小") : I18n.t("放大到全屏");
}

/* 视图档位：true = 源码档，false = 所见即所得档（工具栏 tab 与调用方共用这一处） */
function teSetView(want) {
  const src = !!want;
  if (src === !!_te.src) return;
  teCommit();
  _te.src = src;
  teRenderAll();
  if (!src) {
    const ed = teRichEl();
    if (ed) setTimeout(() => ed.focus(), 0);
  }
}

/* ---------- 整面渲染 ---------- */

function teRenderAll() {
  const host = document.getElementById("textEditDlg");
  if (!host) return;
  const node = teNode();
  if (!node) {
    teClose();
    return;
  }
  const title = teEl("textEditTitle");
  if (title) title.textContent = I18n.t("编辑") + " · " + (node.title || "");
  const sub = teEl("textEditSub");
  if (sub) {
    sub.textContent = I18n.t("文本节点 · 正文实时保存（改动自动落盘）");
    sub.title = I18n.t(
      "正文随节点保存持久化；批注与历史版本与「✎ 审阅」共用同一份记录",
    );
  }
  host.classList.toggle("busy", !!_te.busy);
  teRenderToolbar();
  teRenderEditor();
  teRenderVerTabs();
  teRenderNotes();
  teRenderRevisionButton();
  teRenderFoot();
}

/* 工具栏：方形图标按钮，动作全部作用于 #textEditRich（样式复用 review.css 的 .rv-tool，
   与「✎ AI 审阅」同一套图标语言与全套 Markdown 动作）。 */
function teRenderToolbar() {
  const tb = teEl("textEditToolbar");
  if (!tb) return;
  tb.innerHTML = "";
  if (!_te.editing) return;
  const sep = () => {
    const s = document.createElement("i");
    s.className = "rv-tool-sep";
    tb.appendChild(s);
  };
  const mk = (action, label, title, html) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "rv-tool";
    b.title = title || label;
    if (html) b.innerHTML = html;
    else b.textContent = label;
    /* 按下不夺焦：编辑区里的光标 / 选区原样留着，execCommand 才落对地方 */
    b.addEventListener("mousedown", (ev) => ev.preventDefault());
    b.onclick = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      teToolbarAct(action);
    };
    tb.appendChild(b);
  };
  /* 结构 */
  mk("h1", "H1", I18n.t("一级标题"));
  mk("h2", "H2", I18n.t("二级标题"));
  mk("h3", "H3", I18n.t("三级标题"));
  mk("p", "¶", I18n.t("正文段落"));
  sep();
  /* 行内 */
  mk("bold", "B", I18n.t("加粗"), "<b>B</b>");
  mk("italic", "I", I18n.t("斜体"), "<i>I</i>");
  mk("strike", "S", I18n.t("删除线"), "<s>S</s>");
  mk("quote", "❝", I18n.t("引用"));
  sep();
  mk("ul", "•≡", I18n.t("无序列表"));
  mk("ol", "1.", I18n.t("有序列表"));
  mk("task", "☑", I18n.t("任务清单"));
  mk("hr", "—", I18n.t("水平线"));
  sep();
  mk("link", "🔗", I18n.t("链接"));
  mk("inlineCode", "⟨⟩", I18n.t("行内代码"));
  mk("code", "{;}", I18n.t("代码块"));
  mk("image", "🖼", I18n.t("插入图片"));
  mk("table", "▦", I18n.t("插入表格"));
  mk("mathInline", "$", I18n.t("插入行内公式"), "<i>$</i>");
  mk("mathDisplay", "$$", I18n.t("插入显示公式"), "<i>$$</i>");
  sep();
  mk("undo", "↶", I18n.t("撤销"));
  mk("redo", "↷", I18n.t("重做"));
  sep();
  /* 批注入口：全文 / 局部（局部开启后拖选正文即弹右侧浮空便笺） */
  const full = document.createElement("button");
  full.type = "button";
  full.className = "rv-note-enter";
  full.textContent = I18n.t("全文批注");
  full.title = I18n.t("对整个文档附加一条批注");
  full.onclick = () => teFullNoteDialog();
  tb.appendChild(full);
  const local = document.createElement("button");
  local.type = "button";
  local.className = "rv-note-enter" + (_te.localSel ? " on" : "");
  local.textContent = I18n.t("局部批注");
  local.title = _te.localSel
    ? I18n.t("局部批注已开启，拖选正文即可添加")
    : I18n.t("在正文中拖选文字可添加局部批注");
  local.onclick = () => {
    _te.localSel = !_te.localSel;
    if (!_te.localSel) teHideFloatNote(true);
    teRenderToolbar();
    if (_te.localSel) {
      const ed = teRichEl();
      if (ed) ed.focus();
    }
  };
  tb.appendChild(local);
}

/* ---------- 编辑区 ---------- */

function teRichEl() {
  return _teRichEl || teEl("textEditRich");
}

function teRenderEditor() {
  const box = teEl("textEditEditor");
  if (!box) return;
  box.innerHTML = "";
  /* 两个编辑面的登记一并作废（旧 DOM 已经摘下来，不能再当正文来源） */
  _teRichEl = null;
  _teSrcEl = null;
  const host = document.getElementById("textEditDlg");
  Array.from(host.querySelectorAll(".rv-tab[data-mode]")).forEach((b) => {
    b.classList.toggle("on", (b.getAttribute("data-mode") === "src") === _te.src);
  });
  box.classList.toggle("editing", !!_te.editing);
  /* DOM 已被清空 → 「DOM 代表哪一版」的记账一并失效（此刻任何序列化都不可信） */
  _te.rendered = -1;
  const text = teVisibleText();
  if (_te.src) {
    /* 源码档装着的就是当前版全文：先记账（免得 TeCommit 的守卫把切档后的第一次序列化挡掉） */
    _te.rendered = _te.verIdx;
    const ta = document.createElement("textarea");
    ta.className = "rv-src";
    ta.id = "textEditSrc";
    ta.spellcheck = false;
    _teSrcEl = ta;
    ta.value = text;
    if (_te.editing) {
      ta.oninput = () => {
        teCommit();
        tePushToNode();
        teHideFloatNote(true);
        teRenderFoot();
      };
      ta.addEventListener("keydown", (ev) => {
        if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "s") {
          ev.preventDefault();
          teSaveNow();
        }
      });
    } else {
      ta.readOnly = true;
    }
    box.appendChild(ta);
    return;
  }
  if (_te.editing) {
    const ed = document.createElement("div");
    ed.className = "rv-rich";
    ed.id = "textEditRich";
    ed.contentEditable = "true";
    _teRichEl = ed;
    ed.spellcheck = false;
    ed.setAttribute("role", "textbox");
    ed.setAttribute("aria-multiline", "true");
    ed.innerHTML = mdToRichHtml(text);
    _te.rendered = _te.verIdx;
    /* 局部批注：拖选文字弹出右侧浮空便笺 */
    ed.addEventListener("mouseup", (ev) => teMaybeShowFloatNote(ed, ev));
    ed.addEventListener("input", () => {
      teCommit();
      teReAnchorNotesAfterEdit();
      tePushToNode();
      teRenderFoot();
    });
    ed.addEventListener("keydown", (ev) => {
      if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "s") {
        ev.preventDefault();
        teSaveNow();
      }
    });
    /* 插图：粘贴（截图 / 剪贴板）、拖入（本机图片）、点工具栏插图 —— 全套走共享模块 */
    teBindImageEditor(ed);
    box.appendChild(ed);
    box.scrollTop = 0;
    return;
  }
  /* 回看历史版：只读渲染 */
  box.innerHTML = '<div class="rv-preview">' + mdToRichHtml(text) + "</div>";
}

/* 富文本 DOM → 当前版正文（幂等；任何序列化前都先走这一步，锚点才以最新正文为准）。 */
function teCommit() {
  if (!_te.editing) return;
  /* DOM 不是当前版的（刚开窗 / 刚切档 / 正在重渲染）：此刻序列化只会把上一版的 DOM 写进正文，直接跳过 */
  if (_te.rendered !== _te.verIdx) return;
  const host = document.getElementById("textEditDlg");
  if (!host) return;
  const v = teCurrent();
  if (!v) return;
  /* 先认当前档位对应的那个编辑面：源码档读 textarea，所见即所得档序列化富文本。
     顺序不能反 —— 源码档下 .rv-rich 已经不在 DOM 里，querySelector 可能捞到别的同名节点。 */
  if (_te.src) {
    const src = _teSrcEl;
    if (src && !src.readOnly) v.text = src.value;
  } else {
    const ed = _teRichEl;
    if (ed && ed.contentEditable === "true") {
      const md = richToMarkdown(ed);
      if (md != null) v.text = md;
    }
  }
  /* 当前版正文一变就同步到 node.text 与板身 textarea（两个编辑面完全同步） */
  tePushToNode();
}

/* 底部条：字数 / 未保存提示 */
function teRenderFoot() {
  const f = teEl("textEditFootbar");
  if (!f) return;
  const v = teVisible();
  const text = v ? String(v.text || "") : "";
  const chars = text.replace(/\s/g, "").length;
  const lines = text ? text.replace(/\r\n?/g, "\n").split("\n").length : 0;
  const bits = [
    I18n.t("字数") + " " + chars,
    I18n.t("行数") + " " + lines,
    _te.editing ? I18n.t("当前版可编辑") : I18n.t("历史版只读回看"),
  ];
  /* 实时保存的状态回显（保存按钮已移除，这里就是唯一的「存没存」落点）：
     改过之后一律有一段可见状态，用户不必靠猜。 */
  if (_te.editing) {
    const st = _te.saveState;
    if (st === "pending") bits.push(I18n.t("保存中…"));
    else if (st === "err") bits.push(I18n.t("保存失败：") + (_te.saveErr || ""));
    else if (st === "ok") bits.push(I18n.t("已自动保存") + " · " + teAgoText(_te.saveAt));
    else bits.push(I18n.t("改动会自动保存"));
    /* Ctrl+S 仍是「立即保存」这一条显式出口（按钮没了，提示要留着） */
    bits.push(I18n.t("Ctrl+S 立即保存"));
  }
  f.textContent = bits.join(" · ");
}

/* 「刚刚 / N 秒前 / N 分钟前」——底栏给「已自动保存」配一个看得懂的时间感 */
function teAgoText(ts) {
  const t = Number(ts) || 0;
  if (!t) return I18n.t("刚刚");
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 5) return I18n.t("刚刚");
  if (s < 60) return s + I18n.t(" 秒前");
  const m = Math.floor(s / 60);
  if (m < 60) return m + I18n.t(" 分钟前");
  return new Date(t).toLocaleTimeString();
}

/* ---------- 版本链（可回看 / 回滚；仅当前版可改） ---------- */

function teRenderVerTabs() {
  const wrap = teEl("textEditVerTabs");
  if (!wrap) return;
  wrap.innerHTML = "";
  const vs = teVersions();
  vs.forEach((v, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "rv-vtab";
    if (i === _te.verIdx && _te.editing) b.classList.add("cur");
    const isLast = i === vs.length - 1;
    const lab = isLast ? I18n.t("最新") : String(i + 1);
    const total = (v.notes || []).length;
    b.innerHTML =
      "<span class='rv-ver-n'>" +
      lab +
      "</span>" +
      (total ? "<em class='rv-ver-notes'>" + total + "</em>" : "");
    b.title = lab + " · " + (v.src || "") + " · " + teFmtTime(v.ts);
    b.onclick = (ev) => {
      ev.stopPropagation();
      teViewVersion(i);
    };
    wrap.appendChild(b);
  });
  if (_te.editing === false && _te.verIdx < vs.length - 1 && vs.length > 1) {
    const curEl = wrap.children[_te.verIdx];
    if (curEl) curEl.classList.add("cur");
    const rb = document.createElement("button");
    rb.type = "button";
    rb.className = "rv-vtab rollback";
    rb.textContent = "↩ " + I18n.t("回滚到此版");
    rb.title = I18n.t("回滚后该版成为当前可编辑版，其后的版本将被作废、但仍可回看");
    rb.onclick = (ev) => {
      ev.stopPropagation();
      teRollbackTo(_te.verIdx);
    };
    wrap.appendChild(rb);
  }
  try {
    wrap.scrollLeft = wrap.scrollWidth;
  } catch (_) {}
}

function teFmtTime(ts) {
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

function teViewVersion(idx) {
  teCommit();
  const vs = teVersions();
  if (idx < 0 || idx >= vs.length) return;
  _te.verIdx = idx;
  _te.editing = idx === vs.length - 1;
  teRenderAll();
}

/* 回滚：该版重设为当前可编辑版，其后各版「作废但仍可回看」（不删记录 —— 与 node.review
   共用同一份历史，删了会让「✎ AI 审阅」里的版本对不上）。作废版在存盘时经 voided 标记。 */
async function teRollbackTo(idx) {
  const vs = teVersions();
  if (idx < 0 || idx >= vs.length - 1) return;
  const ok = await confirmDialog(
    I18n.t(
      "确定回滚到该版本？它会重新成为当前可编辑版，其后各版作废（仍可回看，但不再参与修订）。",
    ),
    { title: I18n.t("回滚版本"), okText: I18n.t("回滚到此版"), danger: true },
  );
  if (!ok) return;
  const v = vs[idx];
  /* 作废标记：存在版本对象上，随 node.review 持久化 */
  for (let i = idx + 1; i < vs.length; i++) vs[i].voided = true;
  if (v) v.voided = false;
  _te.editing = true;
  /* 把该版正文复制成新的尾版：尾版永远是「当前可编辑版」，其后各版留作回看 */
  vs.push({
    text: String((v && v.text) || ""),
    notes: (v && v.notes ? v.notes.slice() : []).map((nt) =>
      Object.assign({}, nt, { id: teUid("rn") }),
    ),
    ts: Date.now(),
    src: I18n.t("回滚"),
  });
  _te.verIdx = vs.length - 1;
  teCommit();
  teSaveToNode(true);
  teRenderAll();
  toast(I18n.t("已回到该版本，它现在是当前可编辑版"), "ok");
}

function teUid(prefix) {
  return (
    String(prefix || "id") +
    Date.now().toString(36) +
    Math.random().toString(36).slice(2, 7)
  );
}

/* ---------- 工具栏动作 ---------- */

function teToolbarAct(action) {
  teCommit();
  tePushToNode();
  const host = document.getElementById("textEditDlg");
  const ed = host && host.querySelector(".rv-rich");
  const src = host && host.querySelector(".rv-src");
  if (src) {
    teToolbarOnSource(action, src);
    return;
  }
  if (!ed) return;
  try {
    ed.focus();
  } catch (_) {}
  teToolbarOnRich(action, ed);
}

function teToolbarOnRich(action, ed) {
  const after = () => {
    teMarkDirty();
    teCommit();
    teRenderFoot();
  };
  const insertFrag = (html) => {
    const frag = document.createRange().createContextualFragment(html);
    const m = window.MTInlineImg;
    if (m && typeof m.insertAtCaret === "function") m.insertAtCaret(ed, frag);
    else ed.appendChild(frag);
  };
  const exec = (cmd, arg) => {
    try {
      document.execCommand(cmd, false, arg);
    } catch (_) {
      toast(I18n.t("该编辑操作在当前浏览器不受支持"), "warn");
    }
  };
  switch (action) {
    case "h1":
    case "h2":
    case "h3":
      exec("formatBlock", { h1: "h1", h2: "h2", h3: "h3" }[action]);
      after();
      return;
    case "p":
      exec("formatBlock", "p");
      after();
      return;
    case "bold":
      exec("bold");
      after();
      return;
    case "italic":
      exec("italic");
      after();
      return;
    case "strike":
      exec("strikeThrough");
      after();
      return;
    case "quote":
      exec("formatBlock", "blockquote");
      after();
      return;
    case "ul":
      exec("insertUnorderedList");
      after();
      return;
    case "ol":
      exec("insertOrderedList");
      after();
      return;
    case "task":
      exec("insertUnorderedList");
      after();
      return;
    case "hr":
      insertFrag("<hr>");
      after();
      return;
    case "code":
      insertFrag("<pre><code>" + I18n.t("代码") + "</code></pre>");
      after();
      return;
    case "inlineCode":
      teWrapInline(ed, "code");
      after();
      return;
    case "link":
      teInsertLink(ed);
      return;
    case "image":
      teInsertImageFromPicker(ed, after);
      return;
    case "table":
      teInsertTable(ed, after);
      return;
    case "mathInline":
    case "mathDisplay":
      teInsertMath(ed, action === "mathDisplay", after);
      return;
    case "undo":
      exec("undo");
      teRenderFoot();
      return;
    case "redo":
      exec("redo");
      teRenderFoot();
      return;
    default:
      return;
  }
}

/* 行内包裹（行内码等）：选区跨块时逐字抽取文本包起来 */
function teWrapInline(ed, tag) {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) {
    const el = document.createElement(tag);
    el.textContent = I18n.t("code");
    const frag = document.createDocumentFragment();
    frag.appendChild(el);
    const m = window.MTInlineImg;
    if (m && typeof m.insertAtCaret === "function") m.insertAtCaret(ed, frag);
    else ed.appendChild(frag);
    return;
  }
  const r = sel.getRangeAt(0);
  const wrap = document.createElement(tag);
  try {
    r.surroundContents(wrap);
  } catch (_) {
    const txt = sel.toString();
    r.deleteContents();
    wrap.textContent = txt;
    r.insertNode(wrap);
  }
  tePlaceCaretAfter(wrap);
}

function tePlaceCaretAfter(el) {
  const m = window.MTInlineImg;
  if (m && typeof m.placeCaretAfter === "function") return m.placeCaretAfter(el);
}

/* 记住 / 还原选区：开小对话框后选区会丢，插入前要还原 */
function teRangeIn(ed) {
  try {
    const sel = window.getSelection();
    if (sel && sel.rangeCount && sel.anchorNode && ed && ed.contains(sel.anchorNode))
      return sel.getRangeAt(0).cloneRange();
  } catch (_) {}
  return null;
}
function teRestoreRange(range, ed) {
  try {
    if (range) {
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
    if (ed) ed.focus();
  } catch (_) {}
}

function teInsertLink(ed) {
  const sel = window.getSelection();
  const hasSel = !!(sel && !sel.isCollapsed && sel.rangeCount);
  const anchorText = hasSel ? sel.toString() : "";
  const range = hasSel ? sel.getRangeAt(0).cloneRange() : null;
  promptDialog(I18n.t("链接地址（https://…）"), "https://", {
    title: I18n.t("插入链接"),
    inputType: "url",
  }).then((url) => {
    if (url == null) return;
    if (range) {
      const a = document.createElement("a");
      a.href = url;
      a.textContent = anchorText;
      try {
        range.deleteContents();
        range.insertNode(a);
      } catch (_) {}
      tePlaceCaretAfter(a);
    } else {
      const m = window.MTInlineImg;
      const frag = document.createRange().createContextualFragment(
        '<a href="' + teEscAttr(url) + '">' + teEscAttr(url) + "</a>",
      );
      if (m && typeof m.insertAtCaret === "function") m.insertAtCaret(ed, frag);
      else ed.appendChild(frag);
    }
    teMarkDirty();
    teCommit();
    teRenderFoot();
  });
}

/* 插图：先记选区 → 选图 → 落盘到画布工作目录 assets/ → 还原选区 → 插入 <img> */
function teInsertImageFromPicker(ed, after) {
  const range = teRangeIn(ed);
  const target = teImgTarget();
  if (!target) return;
  const m = window.MTInlineImg;
  if (!m) {
    toast(I18n.t("内嵌图片模块未就绪（app-inline-img.js）"), "warn");
    return;
  }
  Promise.resolve(m.pickImage(target)).then(async (picked) => {
    if (!picked) return;
    const saved = await m.saveImage(picked, target);
    if (!saved) return;
    teRestoreRange(range, ed);
    m.insertImgRich(ed, saved, { richClass: false });
    if (after) after();
  });
}

/* 编辑器里粘贴 / 拖入图片：与工具栏插图同一条落盘路径（画布工作目录 assets/）。
   markdown 正文里的图片引用是「相对工作目录」的路径，显示时换成 file:/// 绝对地址。 */
function teBindImageEditor(ed) {
  const m = window.MTInlineImg;
  if (!m || !ed) return;
  m.bindEditor(ed, {
    target: teImgTarget,
    canEdit: () => !!_te.editing,
    onInserted: () => {
      teMarkDirty();
      teCommit();
      teRenderFoot();
    },
  });
}

/* 图片落盘目标：画布工作目录下的 assets/（正文以 assets/<名> 相对路径引用）。
   没有工作目录就弹现成的「请填写工作目录」窗让用户选一个 —— 不落绝对路径，
   正文才能随工作目录搬走。返回 null = 本次不插图。 */
function teImgTarget() {
  const ws = typeof wfWorkspace === "function" ? String(wfWorkspace() || "").trim() : "";
  if (!ws) {
    toast(I18n.t("插图需要先设置画布工作目录：请在弹出的窗口里选一个文件夹"), "warn");
    /* 复用画布统一的工作目录闸门（app-nodes.js 的 ensureRunWorkspace → app.js 的
       chooseWorkspaceFolderDialog）：用户选好目录后重按一次插图即可。 */
    if (typeof ensureRunWorkspace === "function") {
      try {
        ensureRunWorkspace(null);
      } catch (_) {}
    } else if (typeof chooseWorkspaceFolderDialog === "function") {
      try {
        chooseWorkspaceFolderDialog({ canvasWorkspace: true });
      } catch (_) {}
    }
    return null;
  }
  return {
    kind: "fact", // 复用「复制进目录 + 相对引用」那条既有路径（main.js 的 fact:saveImage）
    dir: ws,
    assetsDir: teAssetsDir(ws),
    name: "assets",
  };
}
/* 工作目录下的 assets/（Windows 反斜杠；工作目录自带尾分隔符时先去掉） */
function teAssetsDir(ws) {
  const base = String(ws || "").replace(/[\\/]+$/, "");
  const sep = base.indexOf("\\") >= 0 ? "\\" : "/";
  return base ? base + sep + "assets" : "";
}

function teInsertTable(ed, after) {
  const range = teRangeIn(ed);
  teTableDialog().then((d) => {
    if (!d) return;
    teRestoreRange(range, ed);
    const m = window.MTInlineImg;
    const frag = document.createRange().createContextualFragment(
      teTableHtml(d.rows, d.cols),
    );
    if (m && typeof m.insertAtCaret === "function") m.insertAtCaret(ed, frag);
    else ed.appendChild(frag);
    if (after) after();
  });
}

function teInsertMath(ed, display, after) {
  const range = teRangeIn(ed);
  teMathDialog(display).then((tex) => {
    if (!tex) return;
    teRestoreRange(range, ed);
    /* 公式交给 math-render.js 渲染成只读节点；LaTeX 原文写在 data-rv-tex 上，
       序列化回 Markdown 时按原定界符还原（与「✎ AI 审阅」同一口径）。 */
    const M = window.MTMathRender;
    const html =
      M && typeof M.latexToHtml === "function"
        ? M.latexToHtml(tex, { display: !!display })
        : '<span class="rv-math rv-legacy" data-rv-tex="' +
          teEscAttr(tex) +
          '" data-rv-display="' +
          (display ? "1" : "0") +
          '">' +
          teEscH(tex) +
          "</span>";
    if (!html) return;
    const frag = document.createRange().createContextualFragment(html);
    const m = window.MTInlineImg;
    if (m && typeof m.insertAtCaret === "function") m.insertAtCaret(ed, frag);
    else ed.appendChild(frag);
    toast(I18n.t("公式已插入"), "ok");
    if (after) after();
  });
}

/* 源码档的工具栏动作：直接在 textarea 里改 Markdown */
function teToolbarOnSource(action, ta) {
  const a = ta.selectionStart;
  const b = ta.selectionEnd;
  const sel = ta.value.slice(a, b);
  const fmt = (pre, post, sample, mid) => {
    const body = sel || sample;
    const nb = pre + body + (mid ? mid : "") + post;
    ta.value = ta.value.slice(0, a) + nb + ta.value.slice(b);
    ta.setSelectionRange(a, a + nb.length);
    teMarkDirty();
    ta.focus();
    teRenderFoot();
  };
  const insert = (text) => {
    const p = ta.selectionStart;
    ta.value = ta.value.slice(0, p) + text + ta.value.slice(ta.selectionEnd);
    ta.setSelectionRange(p + text.length, p + text.length);
    teMarkDirty();
    ta.focus();
    teRenderFoot();
  };
  switch (action) {
    case "h1":
    case "h2":
    case "h3": {
      const hashes = { h1: "#", h2: "##", h3: "###" }[action];
      const ls = ta.value.lastIndexOf("\n", a - 1) + 1;
      let le = ta.value.indexOf("\n", b);
      if (le < 0) le = ta.value.length;
      const rep = ta.value
        .slice(ls, le)
        .split("\n")
        .map((l) => {
          const t = l.trim();
          if (!t) return l;
          return hashes + " " + t.replace(/^#{1,6}\s*/, "");
        })
        .join("\n");
      ta.value = ta.value.slice(0, ls) + rep + ta.value.slice(le);
      ta.setSelectionRange(ls, ls + rep.length);
      teMarkDirty();
      ta.focus();
      teRenderFoot();
      return;
    }
    case "ul":
    case "ol":
    case "task":
    case "quote": {
      const mark = { ul: "- ", ol: "1. ", task: "- [ ] ", quote: "> " }[action];
      const ls = ta.value.lastIndexOf("\n", a - 1) + 1;
      let le = ta.value.indexOf("\n", b);
      if (le < 0) le = ta.value.length;
      const rep = ta.value
        .slice(ls, le)
        .split("\n")
        .map((l) => (l.trim() ? mark + l.replace(/^\s*(?:[-*+]|\d+\.|>)\s*(\[[ xX]\]\s*)?/, "") : l))
        .join("\n");
      ta.value = ta.value.slice(0, ls) + rep + ta.value.slice(le);
      ta.setSelectionRange(ls, ls + rep.length);
      teMarkDirty();
      ta.focus();
      teRenderFoot();
      return;
    }
    case "bold":
      fmt("**", "**", I18n.t("文本"));
      return;
    case "italic":
      fmt("*", "*", I18n.t("文本"));
      return;
    case "strike":
      fmt("~~", "~~", I18n.t("文本"));
      return;
    case "inlineCode":
      fmt("`", "`", I18n.t("code"));
      return;
    case "code":
      fmt("```\n", "\n```", I18n.t("代码"), "\n");
      return;
    case "link":
      fmt("[", "](https://)", I18n.t("链接文字"));
      return;
    case "hr":
      insert("\n---\n");
      return;
    case "image": {
      const target = teImgTarget();
      if (!target) return;
      const m = window.MTInlineImg;
      if (!m) return;
      Promise.resolve(m.pickImage(target)).then(async (picked) => {
        if (!picked) return;
        const saved = await m.saveImage(picked, target);
        if (!saved) return;
        insert("![" + saved.alt + "](" + saved.rel + ")\n");
      });
      return;
    }
    case "table":
      teTableDialog().then((d) => {
        if (!d) return;
        insert("\n" + teTableMd(d.rows, d.cols) + "\n");
      });
      return;
    case "mathInline":
    case "mathDisplay":
      teMathDialog(action === "mathDisplay").then((tex) => {
        if (!tex) return;
        insert(action === "mathDisplay" ? "\n$$\n" + tex + "\n$$\n" : "$" + tex + "$");
      });
      return;
    case "undo":
      try {
        document.execCommand("undo");
      } catch (_) {}
      teRenderFoot();
      return;
    case "redo":
      try {
        document.execCommand("redo");
      } catch (_) {}
      teRenderFoot();
      return;
    default:
      return;
  }
}

function teEscH(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function teEscAttr(s) {
  return teEscH(s).replace(/"/g, "&quot;");
}

/* 小对话框：表格行列数（与审阅同一套 mtDialogForm） */
function teTableDialog() {
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

/* 小对话框：LaTeX 公式录入 */
function teMathDialog(display) {
  return new Promise((resolve) => {
    let done = false;
    const fin = (v) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    try {
      mtDialogForm({
        title: I18n.t(display ? "插入显示公式" : "插入行内公式"),
        msg: I18n.t(
          "输入 LaTeX 公式，支持上下标、分式、根号、希腊字母、矩阵与 \\text",
        ),
        textarea: {
          label: I18n.t("公式（LaTeX）"),
          rows: 3,
          placeholder: display ? "\\frac{a}{b} = c" : "x^2 + y^2 = r^2",
        },
        actions: [
          { id: "cancel", label: I18n.t("取消") },
          { id: "ok", label: I18n.t("插入公式"), primary: true },
        ],
      }).then(
        (res) =>
          fin(
            res && res.action === "ok"
              ? String(res.text || "").replace(/\r/g, "").trim()
              : "",
          ),
        () => fin(""),
      );
    } catch (_) {
      fin("");
    }
  });
}

/* 表格两条形态（与审阅同口径）：富文本 HTML / 源码 Markdown。 */
function teTableHtml(rows, cols) {
  const r = Math.max(1, rows | 0);
  const c = Math.max(1, cols | 0);
  let head = "<tr>";
  for (let i = 0; i < c; i++) head += "<th>" + teEscH(I18n.t("列") + (i + 1)) + "</th>";
  head += "</tr>";
  let body = "";
  for (let i = 1; i < r; i++) {
    body += "<tr>";
    for (let j = 0; j < c; j++) body += "<td><br></td>";
    body += "</tr>";
  }
  return "<table><thead>" + head + "</thead><tbody>" + body + "</tbody></table>";
}
function teTableMd(rows, cols) {
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

/* ---------- 批注（全文 / 局部） ---------- */

function teRenderNotes() {
  const wrap = teEl("textEditNotes");
  if (!wrap) return;
  wrap.innerHTML = "";
  const v = teVisible();
  const notes = (v && v.notes) || [];
  const head = document.createElement("div");
  head.className = "rv-notes-head";
  if (_te.editing) {
    const bt = document.createElement("button");
    bt.type = "button";
    bt.className = "rv-btn rv-add-full";
    bt.textContent = "+ " + I18n.t("全文批注");
    bt.title = I18n.t("对整个文档附加一条批注");
    bt.onclick = () => teFullNoteDialog();
    head.appendChild(bt);
    const hint = document.createElement("span");
    hint.className = "rv-notes-hint";
    hint.textContent = I18n.t("在正文中拖选文字可添加局部批注");
    head.appendChild(hint);
  } else {
    const t = document.createElement("span");
    t.className = "rv-notes-title";
    t.textContent = I18n.t("该版本的批注");
    head.appendChild(t);
  }
  wrap.appendChild(head);
  const list = document.createElement("div");
  list.className = "rv-notes-list";
  if (!notes.length) {
    const e = document.createElement("div");
    e.className = "rv-notes-empty";
    e.textContent = _te.editing
      ? I18n.t("暂无批注 · 添加批注后顶部会出现「让 AI 依据批注修订」")
      : I18n.t("该版本没有批注");
    list.appendChild(e);
  }
  for (const nt of notes) list.appendChild(teNoteCardEl(nt));
  wrap.appendChild(list);
}

function teNoteCardEl(nt) {
  const el = document.createElement("div");
  el.className =
    "rv-note" + (nt.kind === "local" ? " local" : " full") + (nt.dead ? " dead" : "");
  const head = document.createElement("div");
  head.className = "rv-note-head";
  const tag = document.createElement("span");
  tag.className = "rv-note-tag";
  tag.textContent = nt.kind === "local" ? I18n.t("局部") : I18n.t("全文");
  head.appendChild(tag);
  const meta = document.createElement("span");
  meta.className = "rv-note-meta";
  meta.textContent = teFmtTime(nt.ts);
  head.appendChild(meta);
  if (_te.editing) {
    const del = document.createElement("button");
    del.type = "button";
    del.className = "rv-note-del";
    del.textContent = "✕";
    del.title = I18n.t("删除批注");
    del.onclick = () => teDeleteNote(nt.id);
    head.appendChild(del);
  }
  el.appendChild(head);
  if (nt.kind === "local" && nt.snippet) {
    const snip = document.createElement("div");
    snip.className = "rv-note-snip";
    snip.textContent = "“" + nt.snippet + "”";
    snip.title = nt.dead
      ? I18n.t("批注锚点文字已变更，可能已失效")
      : I18n.t("点这里在正文中定位该段");
    if (_te.editing) snip.onclick = () => teJumpToSnippet(nt);
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

function teFullNoteDialog() {
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
    const body = res && res.action === "ok" ? String(res.text || "").trim() : "";
    if (body) teAddFullNote(body);
  });
}

function teAddFullNote(body) {
  const v = teVisible();
  if (!v || !_te.editing) return;
  if (!v.notes) v.notes = [];
  v.notes.push({ id: teUid("rn"), kind: "full", body: body, snippet: "", ts: Date.now() });
  teMarkDirty();
  teRenderNotes();
  teRenderRevisionButton();
  tePersist(false);
}

function teAddLocalNote(snippet, body) {
  const v = teVisible();
  if (!v || !_te.editing) return;
  /* 先把富文本 DOM 落回 v.text，锚点才以最新正文为准 */
  teCommit();
  if (!v.notes) v.notes = [];
  const text = String(v.text || "");
  const idx = text.indexOf(snippet);
  v.notes.push({
    id: teUid("rn"),
    kind: "local",
    body: body,
    snippet: snippet,
    start: idx >= 0 ? idx : -1,
    ts: Date.now(),
  });
  teMarkDirty();
  teRenderNotes();
  teRenderRevisionButton();
  tePersist(false);
  toast(I18n.t("已绑定局部批注"), "ok");
}

function teDeleteNote(id) {
  const v = teVisible();
  if (!v || !v.notes) return;
  v.notes = v.notes.filter((x) => x.id !== id);
  teMarkDirty();
  teRenderNotes();
  teRenderRevisionButton();
  tePersist(false);
}

/* 局部批注：拖选正文 → 右侧浮空便笺绑定该段 */
function teMaybeShowFloatNote(ed, ev) {
  if (!_te.editing || !_te.localSel) return;
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) return;
  const txt = sel.toString().trim();
  if (!txt || txt.length < 2) return;
  const rect = sel.getRangeAt(0).getBoundingClientRect();
  if (!rect || (!rect.width && !rect.height)) return;
  const box = teEl("textEditBox");
  if (!box) return;
  const boxRect = box.getBoundingClientRect();
  teShowFloatNote(rect.left - boxRect.left, rect.bottom - boxRect.top + 6, txt);
}

function teShowFloatNote(x, y, snippet) {
  const f = teEl("textEditNoteFloat");
  if (!f) return;
  f.hidden = false;
  f.style.left = Math.max(8, Math.round(x)) + "px";
  f.style.top = Math.max(8, Math.round(y)) + "px";
  f.innerHTML =
    '<div class="rv-note-caret"></div>' +
    '<div class="rv-note-snip">“' +
    teEscH(snippet.slice(0, 60)) +
    (snippet.length > 60 ? "…" : "") +
    "”</div>" +
    '<textarea class="rv-note-in" rows="3" placeholder="' +
    I18n.t("输入批注内容…") +
    '"></textarea>' +
    '<div class="rv-note-btns">' +
    '<button type="button" class="rv-btn primary" id="textEditNoteOk">' +
    I18n.t("绑定批注") +
    "</button>" +
    '<button type="button" class="rv-btn" id="textEditNoteCancel">✕</button>' +
    "</div>";
  const ta = f.querySelector(".rv-note-in");
  const ok = f.querySelector("#textEditNoteOk");
  const cancel = f.querySelector("#textEditNoteCancel");
  ok.onclick = () => {
    const body = ta.value.trim();
    teHideFloatNote(true);
    if (body) teAddLocalNote(snippet, body);
  };
  cancel.onclick = () => teHideFloatNote(true);
  ta.focus();
}

function teHideFloatNote(dropSelection) {
  const f = teEl("textEditNoteFloat");
  if (f) f.hidden = true;
  if (dropSelection) {
    try {
      window.getSelection().removeAllRanges();
    } catch (_) {}
  }
}

/* 改动后自动重锚：局部批注重新贴到就近匹配位置，找不到就标「失效」 */
let _teAnchorTimer = null;
function teReAnchorNotesAfterEdit() {
  if (_teAnchorTimer) clearTimeout(_teAnchorTimer);
  _teAnchorTimer = setTimeout(() => {
    const v = teCurrent();
    if (!v || !v.notes) return;
    const text = String(v.text || "");
    for (const nt of v.notes) {
      if (nt.kind === "local" && nt.dead !== true) teTryReAnchor(nt, text);
    }
    teRenderNotes();
  }, 350);
}
function teTryReAnchor(nt, text) {
  if (!nt.snippet) return;
  const from = Math.max(0, (nt.start || 0) - 120);
  const to = Math.min(text.length, (nt.start || 0) + 200);
  const rel = text.slice(from, to).indexOf(nt.snippet);
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

function teJumpToSnippet(nt) {
  const ed = teRichEl();
  if (!ed || !nt.snippet) return;
  try {
    const tn = document.createTreeWalker(ed, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = tn.nextNode())) {
      const i = n.textContent.indexOf(nt.snippet);
      if (i < 0) continue;
      const r = document.createRange();
      r.setStart(n, i);
      r.setEnd(n, i + nt.snippet.length);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
      ed.focus();
      const rr = r.getBoundingClientRect();
      const box = teEl("textEditBox");
      if (rr && box) {
        const boxRect = box.getBoundingClientRect();
        const edBox = teEl("textEditEditor");
        if (edBox) edBox.scrollTop += rr.top - boxRect.top - 120;
      }
      return;
    }
    toast(I18n.t("未能在正文中找到该批注片段"), "warn");
  } catch (_) {}
}

/* ---------- 让 AI 依据批注逐轮修订 ---------- */

function teRenderRevisionButton() {
  const b = teEl("textEditReviseBtn");
  if (!b) return;
  const cur = teCurrent();
  const total = cur && Array.isArray(cur.notes) ? cur.notes.length : 0;
  if (_te.editing && total > 0) {
    b.hidden = false;
    const t = teEl("textEditReviseTxt");
    if (t) t.textContent = I18n.t("让 AI 依据批注修订") + "（" + total + "）";
  } else {
    b.hidden = true;
  }
}

/* 修订用的服务商：节点自身 providerId 优先，没有就回退任一可用文本服务商
   （与「✎ AI 审阅」判据同源，见 app-review.js 的 reviewResolveProv）。 */
function teResolveProv(node) {
  const list = (S.config && S.config.providers) || [];
  const pid = String((node && node.providerId) || "").trim();
  let prov = pid ? list.find((p) => p.id === pid) : null;
  if (!prov) {
    prov =
      list.find(
        (p) => p.type === "text_openai" && String(p.apiKey || "").trim(),
      ) || null;
  }
  return prov;
}

async function teRunRevision() {
  if (_te.busy) return;
  const node = teNode();
  if (!node || !node.review) return;
  teCommit();
  const v = teCurrent();
  if (!v) return;
  const total = (v.notes || []).length;
  if (!total) return;
  const prov = teResolveProv(node);
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
  const models =
    typeof providerModelFilter === "function"
      ? providerModelFilter(prov, prov.models)
      : prov.models || [];
  const model = String(node.model || (models && models[0]) || "");
  if (!model) {
    toast(I18n.t("未找到可用模型（请在设置里为该服务商配置模型）"), "err");
    return;
  }
  const temp =
    node.temperature == null ? 0.7 : Math.max(0, Math.min(2, Number(node.temperature) || 0));
  const effort =
    typeof normalizeTextEffort === "function"
      ? normalizeTextEffort(node.effort)
      : undefined;
  /* 本轮批注计入累计 notesLog（历史全部批注随提示词一起送给模型） */
  for (const nt of v.notes || []) {
    teLog().push({
      round: teLog().length + 1,
      kind: nt.kind,
      snippet: nt.snippet || "",
      body: nt.body,
    });
  }
  const prompt = buildRevisionPrompt(v.text, teLog());
  _te.busy = true;
  teRenderAll();
  try {
    const spec = {
      provider: prov,
      kind: "text",
      model: model,
      temperature: temp,
      effort: effort,
      size: "",
      prompt: prompt,
      texts: [],
      images: [],
      refImage: "",
      abKey: node._abKey || "",
    };
    const r = await apiCallTextStream(spec, null, null);
    let out = stripFences(String((r && r.text) || ""));
    if (!out.trim()) throw new Error(I18n.t("模型未返回修订正文"));
    const vs = teVersions();
    vs.push({
      text: out,
      notes: [],
      ts: Date.now(),
      src: I18n.t("AI 修订") + vs.length,
    });
    _te.verIdx = vs.length - 1;
    _te.editing = true;
    /* 新版正文的真源就是模型返回的 out：不能再用编辑区 DOM 覆盖（此刻 DOM 还停在上一版），
       所以立即落盘写回 node.text（skipCommit），再由下面的 teRenderAll 重渲染。 */
    teSaveToNode({ immediate: true, clearDown: true, silent: true, skipCommit: true });
    teTrackNodeText(node);
    teRenderAll();
    toast(I18n.t("已生成修订版，可继续批注下一轮"), "ok");
  } catch (e) {
    toast(I18n.t("修订失败：") + ((e && e.message) || e), "err");
  } finally {
    _te.busy = false;
    const host = document.getElementById("textEditDlg");
    if (host) host.classList.remove("busy");
    teRenderAll();
  }
}

/* ---------- 保存写回节点（实时保存的落盘口） ---------- */

/* 保存：当前版正文 → node.text（文本节点是输入节点，下游读的就是它），
   持久化 + 刷新画布；opts.clearDown 时顺带清一次下游中间结果（下游重跑即拿到新正文）。
   调用口径（三处，别的路径一律走实时保存）：
     · teAutoFlush()  —— 停笔自动落盘（silent：不弹 toast，只回显底栏状态）
     · Ctrl+S         —— 立即保存 + 一次「已保存到节点正文」的提示
     · AI 修订出新版   —— src="revision" 立即落盘（此时编辑区 DOM 还停在上一版，故内部先不 commit）
   三个选项都可省：teSaveToNode(true) 等价于 { immediate: true }（旧签名照旧能用）。 */
function teSaveToNode(opts) {
  const o = opts === true || opts === false ? { immediate: !!opts } : opts || {};
  const node = teNode();
  if (!node) return false;
  /* 先把编辑区 DOM 落回当前版：正文的真源是富文本 / 源码 DOM，
     不先序列化，保存下去的会是上一版（这是个真会咬人的顺序坑）。
     唯一例外是 AI 刚 push 新版那一下（DOM 还停在上一版），由调用方传 silent 同源的 skipCommit。 */
  if (!o.skipCommit) teCommit();
  const v = teCurrent();
  if (!v) return false;
  const text = String(v.text || "");
  node.text = text;
  teTrackNodeText(node);
  teRenderBodyTextarea();
  try {
    if (typeof clearDownstream === "function" && (o.clearDown || o.immediate))
      clearDownstream(node.id);
  } catch (_) {}
  tePersist(!!o.immediate);
  if (typeof renderCanvas === "function") renderCanvas();
  teSetSave("ok");
  _te.saveAt = Date.now();
  teRenderFoot();
  if (!o.silent) toast(I18n.t("已保存到节点正文"), "ok");
  return true;
}
/* 立即保存（Ctrl+S / 保存写回节点正文的显式出口）：跳过防抖直接落盘一次。 */
function teSaveNow(opts) {
  if (!_te.node) return false;
  try {
    return teSaveToNode(
      Object.assign({ immediate: true, clearDown: true, src: "ctrl-s" }, opts || {}),
    );
  } catch (e) {
    teSaveFailed(e);
    return false;
  }
}
/* 落盘失败（工作流保存报错 / 没绑定工作流）：底栏转红写原因，并弹一次提示。
   定时器与 Ctrl+S 两条路径共用，避免同类错误反复弹窗刷屏。 */
function teSaveFailed(e) {
  const msg = (e && e.message) || String(e || "");
  teSetSave("err", msg);
  toast(I18n.t("保存失败：") + msg, "err");
}
