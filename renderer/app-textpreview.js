"use strict";
/* ============ 文本预览窗（节点文本 · 只读大窗）============
 * 入口：
 *   openTextPreview({ text, title, node, meta, file, onEdit }) —— 打开预览窗（全局，节点头部按钮调用）
 *   closeTextPreview()                            —— 显式关闭（✕ / Esc / 互斥时被邻居调用）
 *
 * 纯只读是默认口径；只有调用方显式给 opts.file（磁盘上某件产物文件）时，头部才按需多出一枚
 * ✎ 按钮，点击交给同一套应用内可编辑阅读器（openTextViewer(file) / opts.onEdit）——即
 * 「文件型预览可一步到编辑」。opts.file 缺省时行为与过去逐字一致，对 proc_text / input_text
 * 这类只读调用方仍是「纯只读、不改内容」。
 *
 * 为什么单独一个模块：节点在画布上只能缩到几百像素，超长文本在板身上读不动
 * （浏览态为护画布流畅度还会把 Markdown 降级成轻量纯文本）。本窗给「完整读一遍」
 * 这件事一个近乎全屏、只读、可复制的出口 —— 与节点自身渲染解耦，不改任何节点数据。
 *
 * 口径（与 AGENTS.md 的对话框纪律一致）：
 *   · 持久对话框：只允许显式关闭（✕ / Esc），绝不挂「点外部即关」；
 *   · 蒙层不接指针事件（CSS .tv-dlg），不给画布加任何拦截；
 *   · 右上可拖调，最小宽 ≥50vw（右下角把手）；尺寸记忆在 localStorage；
 *   · 与同级浮层互斥：打开时先收掉审阅窗 / 图片灯箱；
 *   · 纯展示：不修改节点、不落盘、不触发运行。复制只读走剪贴板。
 *
 * 依赖（调用期取，均在同画布运行期全局可用）：I18n / toast /
 *   nodeTextViewEl、detectViewLang、analyzeTextView（renderer/app-nodeview.js）、
 *   escapeHtml（renderer/app.js）。本文件在 index.html 里排在它们之后加载。
 */

/* 只读大窗的 Markdown 护栏：超过这个体量就用「已截断 + 一键复制全文」替代整篇渲染，
   否则一次性生成几十万字符的 DOM 会把窗口拖死（完整读仍可复制出去用别的编辑器看）。 */
const TV_RICH_MAX_LINES = 6000;
const TV_RICH_MAX_CHARS = 300000;

/* 预览窗用到的中文词条 → 英文对照（界面语言切 EN 时给本模块自己的词条用）。
   本模块自包含：不改 renderer/i18n.js，也不包 I18n.t（避免任何全局副作用）。 */
const TV_I18N = {
  "文本预览": "Text preview",
  "渲染": "Rendered",
  "源码": "Source",
  "复制全文": "Copy all",
  "编辑": "Edit",
  "编辑并保存": "Edit & save",
  "编辑这件文本产物并保存回文件": "Edit this text artifact and save it back to the file",
  "编辑器未就绪": "The editor is not ready",
  "关闭预览（Esc）": "Close preview (Esc)",
  "没有可复制的内容": "Nothing to copy",
  "已复制 {n} 字符": "Copied {n} characters",
  "复制失败，请手动选择文本": "Copy failed — please select the text manually",
  "该节点还没有可预览的文本": "This node has no text to preview",
  "文本预览窗未就绪": "Text preview is not ready",
  "文本过长，已在「渲染」视图截断显示（前 {n} 字符）· 切到「源码」可看全文":
    "Text is very long — the Rendered view is truncated (first {n} characters). Switch to Source for the whole text.",
  "{chars} 字符 · {lines} 行": "{chars} chars · {lines} lines",
};

/* 本模块的取词：先查自己的对照表（EN 界面时），否则交回 I18n.t
   （中文界面下 I18n.t 原样返回 key，正是我们要的中文）。 */
function tvT(key, vars) {
  const k = String(key == null ? "" : key);
  let s = null;
  try {
    if (typeof I18n !== "undefined" && I18n && typeof I18n.getLocale === "function" && I18n.getLocale() === "en")
      s = Object.prototype.hasOwnProperty.call(TV_I18N, k) ? TV_I18N[k] : null;
  } catch (_) {}
  if (s == null) return typeof I18n !== "undefined" && I18n ? I18n.t(k, vars) : k;
  if (vars && typeof vars === "object")
    s = s.replace(/\{(\w+)\}/g, (_, n) => (vars[n] == null ? "" : String(vars[n])));
  return s;
}

let _tv = { text: "", title: "", node: null, meta: "", mode: "rich", file: "", onEdit: null };

/* 文本片段（节点 / 输出）→ 预览窗要显示的纯文本；无内容返回 ""。
   口径：普通文本处理节点优先给**输出正文**（结果），还没有输出时退回提示词 / 任务文本；
   输入文本节点给它的正文。与节点头部 👁 按钮的取值逐字一致。 */
function textPreviewOf(node) {
  if (!node) return "";
  const outText = (() => {
    const o = node.output;
    return o && o.kind === "text" ? String(o.text || "") : "";
  })();
  if (node.kind === "proc_text" || node.kind === "proc_image" || node.kind === "agent_task") {
    if (outText.trim()) return outText;
    return typeof procPromptOf === "function" ? String(procPromptOf(node) || "") : "";
  }
  if (node.kind === "input_text") return String(node.text || "");
  return outText;
}

/* 节点是否有可预览的文本（头部按钮据此决定显不显示） */
function nodeHasPreviewText(node) {
  return !!textPreviewOf(node).trim();
}

/* 语种判定（与节点只读视图同源）：调用期 app-nodeview.js 已加载。 */
function tvLangOf(text) {
  if (typeof detectViewLang === "function") return detectViewLang(text);
  return "plain";
}

/* 只读 DOM 构造：MD / YAML 走节点同款只读视图（含 @引用着色），纯文本走 pre。 */
function tvViewEl(text, node, lang, classCls) {
  if (lang === "md" || lang === "yaml") {
    if (typeof nodeTextViewEl === "function") {
      try {
        const el = nodeTextViewEl(text, {
          node: node,
          lang: lang,
          /* 预览窗就是要看完整渲染：不做节点浏览态的超长降级 */
          full: true,
          class: classCls || (lang === "md" ? "tv-md" : "tv-pre"),
        });
        if (el) return el;
      } catch (_) {}
    }
  }
  const pre = document.createElement("pre");
  pre.className = "tv-pre";
  pre.textContent = text;
  return pre;
}

/* ── 宿主（只建一次，之后只更新内容） ── */
let _tvInit = false;
function ensureTextPreviewDlg() {
  let host = document.getElementById("tvDlg");
  if (host) return host;
  host = document.createElement("div");
  host.id = "tvDlg";
  host.className = "tv-dlg";
  host.innerHTML =
    '<div class="tv-box" id="tvBox" role="dialog" aria-modal="true" tabindex="-1">' +
    '<div class="tv-head">' +
    '<div class="tv-title"><span class="tv-title-dot">👁</span><b id="tvTitle"></b>' +
    '<span class="tv-meta" id="tvMeta"></span></div>' +
    '<div class="tv-actions">' +
    '<button type="button" class="tv-btn on" id="tvModeRich"></button>' +
    '<button type="button" class="tv-btn" id="tvModeSrc"></button>' +
    '<button type="button" class="tv-btn" id="tvEdit" hidden></button>' +
    '<button type="button" class="tv-btn" id="tvCopy"></button>' +
    '<button type="button" class="tv-btn tv-close" id="tvClose" title="">✕</button>' +
    "</div></div>" +
    '<div class="tv-body" id="tvBody"></div>' +
    '<div class="tv-note" id="tvNote" hidden><span id="tvNoteTxt"></span>' +
    '<button type="button" class="tv-note-btn" id="tvNoteCopy"></button></div>' +
    '<div class="tv-resize" id="tvResize"></div>' +
    "</div>";
  document.body.appendChild(host);

  host.querySelector("#tvModeRich").textContent = tvT("渲染");
  host.querySelector("#tvModeSrc").textContent = tvT("源码");
  host.querySelector("#tvCopy").textContent = tvT("复制全文");
  const tvEditBtn = host.querySelector("#tvEdit");
  tvEditBtn.textContent = "✎ " + tvT("编辑");
  tvEditBtn.title = tvT("编辑这件文本产物并保存回文件");
  tvEditBtn.setAttribute("aria-label", tvT("编辑并保存"));
  host.querySelector("#tvClose").title = tvT("关闭预览（Esc）");
  host.querySelector("#tvNoteCopy").textContent = tvT("复制全文");

  /* 显式关闭路径：✕ / Esc */
  host.querySelector("#tvClose").onclick = () => closeTextPreview();
  document.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape") return;
    if (!host.classList.contains("on")) return;
    ev.stopPropagation();
    closeTextPreview();
  });

  /* 视图切换 */
  const setMode = (mode) => {
    if (mode !== "rich" && mode !== "src") return;
    _tv.mode = mode;
    renderTextPreviewBody();
  };
  host.querySelector("#tvModeRich").onclick = () => setMode("rich");
  host.querySelector("#tvModeSrc").onclick = () => setMode("src");
  /* 复制全文（两个按钮同一口径） */
  const copyAll = () => tvCopyText(_tv.text);
  host.querySelector("#tvCopy").onclick = copyAll;
  host.querySelector("#tvNoteCopy").onclick = copyAll;
  /* ✎ 一步到编辑（仅文件型预览会露出这枚按钮）：交给应用内同一套可编辑阅读器。
     编辑器自己落盘、自己刷新节点（mtnode:file-saved），本窗不写任何文件、不改节点。 */
  tvEditBtn.onclick = () => {
    const file = String(_tv.file || "");
    if (!file) return;
    if (typeof _tv.onEdit === "function") {
      try {
        _tv.onEdit(file);
        return;
      } catch (_) {}
    }
    if (typeof openTextViewer === "function") {
      openTextViewer(file);
      return;
    }
    toast(tvT("编辑器未就绪"), "warn");
  };

  /* 右下拖调（最小宽 ≥50vw，与审阅窗同口径；尺寸记忆 localStorage） */
  const box = host.querySelector("#tvBox");
  const rz = host.querySelector("#tvResize");
  let sz = { w: 0, h: 0 };
  try {
    const j = JSON.parse(localStorage.getItem("tvDlgSize") || "null");
    if (j && j.w && j.h) {
      sz = j;
      box.style.width = j.w + "px";
      box.style.height = j.h + "px";
    }
  } catch (_) {}
  const doResize = (dx, dy) => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let nw = sz.w + dx;
    let nh = sz.h + dy;
    nw = Math.max(Math.round(vw * 0.5), Math.min(nw, vw - 24));
    nh = Math.max(360, Math.min(nh, vh - 24));
    sz.w = nw;
    sz.h = nh;
    box.style.width = nw + "px";
    box.style.height = nh + "px";
    try {
      localStorage.setItem("tvDlgSize", JSON.stringify(sz));
    } catch (_) {}
  };
  rz.addEventListener("mousedown", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const sx = ev.clientX;
    const sy = ev.clientY;
    const base = { w: sz.w || box.offsetWidth, h: sz.h || box.offsetHeight };
    sz.w = base.w;
    sz.h = base.h;
    const move = (e) => doResize(e.clientX - sx, e.clientY - sy);
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  });
  _tvInit = true;
  return host;
}

/* 剪贴板：优先 Async Clipboard，失败回退 execCommand（Electron 里两条路都通）。 */
function tvCopyText(text) {
  const s = String(text == null ? "" : text);
  if (!s) {
    toast(tvT("没有可复制的内容"), "warn");
    return;
  }
  const done = () => toast(tvT("已复制 {n} 字符", { n: s.length }), "ok");
  try {
    const nav = window.navigator;
    if (nav && nav.clipboard && nav.clipboard.writeText) {
      nav.clipboard.writeText(s).then(done, () => tvCopyFallback(s, done));
      return;
    }
  } catch (_) {}
  tvCopyFallback(s, done);
}
function tvCopyFallback(s, done) {
  try {
    const ta = document.createElement("textarea");
    ta.value = s;
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    const okd = document.execCommand && document.execCommand("copy");
    document.body.removeChild(ta);
    if (okd) {
      done();
      return;
    }
  } catch (_) {}
  toast(tvT("复制失败，请手动选择文本"), "warn");
}

/* 正文渲染：按当前视图模式（渲染 / 源码）重建 .tv-body。 */
function renderTextPreviewBody() {
  const host = ensureTextPreviewDlg();
  const body = host.querySelector("#tvBody");
  const note = host.querySelector("#tvNote");
  const rich = _tv.mode !== "src";
  host.querySelector("#tvModeRich").classList.toggle("on", rich);
  host.querySelector("#tvModeSrc").classList.toggle("on", !rich);
  body.innerHTML = "";
  note.hidden = true;
  const text = _tv.text;

  if (!rich) {
    const pre = document.createElement("pre");
    pre.className = "tv-pre";
    pre.textContent = text;
    body.appendChild(pre);
    return;
  }
  /* 渲染视图的超大体量护栏：先截断再渲染，提示条随时可「复制全文」。
     纯文本同样适用 —— 几十万字符塞进一个 <pre>，滚动与重排都会明显发顿。 */
  const lines = text.split("\n");
  const tooBig = lines.length > TV_RICH_MAX_LINES || text.length > TV_RICH_MAX_CHARS;
  const shown = tooBig
    ? lines.slice(0, TV_RICH_MAX_LINES).join("\n").slice(0, TV_RICH_MAX_CHARS)
    : text;
  const lang = tvLangOf(shown) === "md" ? "md" : "plain";
  const el = tvViewEl(shown, _tv.node, lang, lang === "md" ? "tv-md" : "tv-pre");
  body.appendChild(el);
  body.scrollTop = 0;
  if (tooBig) {
    host.querySelector("#tvNoteTxt").textContent = tvT(
      "文本过长，已在「渲染」视图截断显示（前 {n} 字符）· 切到「源码」可看全文",
      { n: shown.length },
    );
    note.hidden = false;
  }
}

/* 打开预览窗：opts = { text, title, node, meta, file, onEdit }（text 缺省时按 node 推导）。
   file / onEdit 只有「磁盘上的文本产物」（ltart 节点 👁）会传：给了 file 才露 ✎ 编辑按钮，
   缺省时本窗保持纯只读口径不变。 */
function openTextPreview(opts) {
  const o = opts && typeof opts === "object" ? opts : { text: String(opts == null ? "" : opts) };
  const node = o.node || null;
  const text = o.text != null ? String(o.text) : textPreviewOf(node);
  if (!text.trim()) {
    toast(tvT("该节点还没有可预览的文本"), "warn");
    return;
  }
  /* 同级浮层互斥：只收掉纯查看型浮层（图片灯箱）。
     审阅窗刻意不动 —— 它的关闭路径会把编辑器里的改动 adopt 回节点，替用户触发
     「采用当前版」是越权的副作用；反过来由审阅窗打开时来收掉本窗（单向互斥）。 */
  try {
    if (typeof closeImageLightbox === "function") closeImageLightbox();
  } catch (_) {}
  _tv = {
    text: text,
    title:
      String(o.title || (node && node.title) || tvT("文本预览")),
    node: node,
    mode: "rich",
    file: String(o.file || ""),
    onEdit: typeof o.onEdit === "function" ? o.onEdit : null,
  };
  const host = ensureTextPreviewDlg();
  /* ✎ 只在文件型预览露出：有路径、且同一套可编辑阅读器确实就绪（否则不摆空按钮）。 */
  const editBtn = host.querySelector("#tvEdit");
  if (editBtn)
    editBtn.hidden = !(_tv.file && (typeof _tv.onEdit === "function" || typeof openTextViewer === "function"));
  host.querySelector("#tvTitle").textContent = _tv.title;
  const lines = text.split("\n").length;
  host.querySelector("#tvMeta").textContent = tvT("{chars} 字符 · {lines} 行", {
    chars: text.length,
    lines: lines,
  });
  host.classList.add("on");
  renderTextPreviewBody();
  try {
    host.querySelector("#tvBox").focus();
  } catch (_) {}
}

/* 显式关闭：只清视图状态，不改节点、不落盘。 */
function closeTextPreview() {
  const host = document.getElementById("tvDlg");
  if (!host) return;
  host.classList.remove("on");
  const body = host.querySelector("#tvBody");
  if (body) body.innerHTML = "";
  _tv = { text: "", title: "", node: null, meta: "", mode: "rich", file: "", onEdit: null };
}
