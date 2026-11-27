/* renderer/app-find.js — 输入框内查找（Ctrl+F · 自包含，零依赖）
 * ============================================================================
 * 需求：焦点在文本输入框里时，Ctrl+F 开一只查找框，用来在**这一个输入框内部**
 *   快速定位指定文字（高亮命中 + 自动滚到可视区，可循环上一个 / 下一个）。
 *
 * 与「全局搜索」的分工（renderer/app-search.js）：
 *   · 焦点**不在**可编辑区 → 维持原状，Ctrl+F 仍由 app.js 呼出跨区域全局搜索浮层。
 *   · 焦点**在** input / textarea / 单行文本宿主里 → 本模块接管 Ctrl+F，
 *     开这只框内查找框；app.js 那条 `if (!inField …)` 分支照旧不抢（让位语义不变），
 *     只是「让位给浏览器自带查找」改成「让位给本模块的查找框」。
 *
 * 键位（全部走键盘显式路径，不挂「点外部即关」，与全应用浮层口径一致）：
 *   Ctrl+F     开框；框已开着则跳到下一个命中（反复按＝逐个走）
 *   Enter / ↓  下一个命中          Shift+Enter / ↑  上一个命中
 *   Esc / ✕    关框并把光标留在当前命中处（可直接接着改）
 *
 * 查找 + 替换（多行文本才有，即文本节点正文框 / 源码档 textarea）：
 *   多行框开框时多出第二行「替换为 ___ 替换 全部替换」；在替换框里按 Enter ＝ 替换当前命中。
 *   写入优先走 execCommand("insertText")：保住原生撤销栈，并且自动派发 input，
 *   宿主（节点正文 / 源码档）的既有监听不用另接一条通路。全部替换从后往前逐处换，
 *   前面的下标不会被顶歪；重叠命中（"aaa" 找 "aa"）按不重叠算，免得同一段被换两遍。
 *
 * 实现要点（为什么这么写）：
 *   · 监听挂在 **document 捕获段**：app.js / app-keys.js 的 window 冒泡监听在它之后，
 *     所以必须 stopPropagation 才能让「Ctrl+F / Esc 被消费掉」这件事对所有下游一致；
 *     捕获段又保证本模块不依赖 index.html 里的脚本加载顺序（app.js 先于本模块加载）。
 *   · 命中高亮不做自绘蒙层：统一用原生选区（setSelectionRange / Range），
 *     输入框与 contenteditable 都会自己把选区滚进可视区 —— 免掉一层容易错位的浮层。
 *   · 输入框横向滚动位置自己算（字符宽 × 下标，按行取行内偏移），
 *     只依赖 content-box 几何，不给不同输入控件写特例。
 *   · 不修改输入框的值 / 不派发 input：宿主（节点参数 / 代码编辑器 / 会话输入框）
 *     的既有监听一律不受影响。
 *
 * 公开入口：openFieldFind(opts) / closeFieldFind() / fieldFindIsOpen()
 * 纯函数（冒烟直接 vm 载入本文件即可调用）：
 *   fdFindMatches(text, query) / fdFindMatchesOnce(text, query) / fdCycle(cur, total, dir) /
 *   fdScrollLeftFor(geom)
 * ─────────────────────────────────────────────────────────────────── */

/* 最近一次被查找的输入框：焦点在查找框里时，Ctrl+F / 再开一次都还能指回它 */
let FD_FIELD_LAST = null;

const FD_BAR = {
  open: false,
  ui: null,
  el: null, // 本次查找的目标输入框
  q: "",
  matches: [],
  cur: -1,
  token: 0,
};

/* ── 纯逻辑（可单测） ─ */

/* 大小写不敏感、允许重叠地列出全部命中（重叠才能「aaaa 里找 aa」也数得对） */
function fdFindMatches(text, query) {
  const t = String(text == null ? "" : text);
  const q = String(query == null ? "" : query);
  const out = [];
  if (!t || !q) return out;
  const hay = t.toLowerCase();
  const needle = q.toLowerCase();
  let at = hay.indexOf(needle);
  while (at >= 0) {
    out.push({ start: at, end: at + q.length });
    at = hay.indexOf(needle, at + 1);
  }
  return out;
}

/* 不重叠的命中（替换用）：重叠命中会把同一段字换两遍，替换一律按这一份算 */
function fdFindMatchesOnce(text, query) {
  const t = String(text == null ? "" : text);
  const q = String(query == null ? "" : query);
  const out = [];
  if (!t || !q) return out;
  const hay = t.toLowerCase();
  const needle = q.toLowerCase();
  let at = hay.indexOf(needle);
  while (at >= 0) {
    out.push({ start: at, end: at + q.length });
    at = hay.indexOf(needle, at + q.length);
  }
  return out;
}

/* 循环取位：dir>0 下一个、dir<0 上一个、dir=0 取当前（越界夹回两端） */
function fdCycle(cur, total, dir) {
  const n = Number(total) || 0;
  if (n <= 0) return -1;
  let i = Number(cur);
  if (!Number.isFinite(i)) i = -1;
  if (i < 0 || i >= n) return dir < 0 ? n - 1 : 0;
  if (dir > 0) return (i + 1) % n;
  if (dir < 0) return (i - 1 + n) % n;
  return i;
}

/* 输入框横向滚动量：按下标估行内偏移，超出可视宽度才滚 */
function fdScrollLeftFor(geom) {
  const before = String((geom && geom.before) || "");
  const line = before.lastIndexOf("\n");
  const col = line < 0 ? before.length : before.length - line - 1;
  const charW = Number(geom && geom.charW) || 0;
  const boxW = Number(geom && geom.boxW) || 0;
  const need = col * charW;
  if (!charW || !boxW) return 0;
  if (need < boxW * 0.6) return 0; // 命中已在靠左区域：别乱滚
  return Math.max(0, need - boxW * 0.25);
}

/* ── 元素判定 ── */

/* 单行文本类 input（数字 / 搜索 / 颜色等没有可查找的文本，排除） */
const FD_INPUT_TEXT_TYPES = { text: 1, search: 1, url: 1, tel: 1, email: 1, "": 1 };

/* 富文本宿主：只认「编辑-文本节点」对话框里的正文编辑器（#textEditRich / .rv-rich）。
   别的 contenteditable（会话输入、笔记正文…）不接管：那里的 Ctrl+F 仍归全局搜索 ——
   本模块的命中与替换全按纯文本下标算，只对这颗编辑面验过。 */
function fdIsRichHost(el) {
  if (!el || el.nodeType !== 1 || !el.isContentEditable) return false;
  return !!(el.closest && el.closest("#textEditDlg"));
}

function fdIsSearchableField(el) {
  if (!el || el.nodeType !== 1) return false;
  const tag = String(el.tagName || "").toLowerCase();
  if (tag === "textarea") return true;
  if (tag === "input") {
    const type = String(el.getAttribute("type") || "").toLowerCase();
    return !!FD_INPUT_TEXT_TYPES[type];
  }
  return fdIsRichHost(el);
}

/* 当前焦点所在的输入框（没有就退回上一个还在文档里的） */
function fdFieldFromFocus() {
  const ae = document.activeElement;
  if (fdIsSearchableField(ae)) return ae;
  const last = FD_FIELD_LAST;
  if (last && last.isConnected && fdIsSearchableField(last)) return last;
  return null;
}

/* 富文本正文的纯文本视图：按行块补 "\n"、<br> 也算换行，同时记下每个文本节点的
   下标区间（map）。不直接用 textContent 是因为它把块与块粘在一起 ——
   "第一段末" + "第二段首" 会拼成一个并不存在的命中，替换下去就把两段并成一段。 */
const FD_RICH_BLOCKS =
  /^(p|div|li|ul|ol|h1|h2|h3|h4|h5|h6|blockquote|pre|table|thead|tbody|tr|td|th|hr)$/;

function fdRichScan(el) {
  const parts = [];
  const map = [];
  let pos = 0;
  const nl = () => {
    if (pos > 0 && parts[parts.length - 1] !== "\n") {
      parts.push("\n");
      pos += 1;
    }
  };
  const walk = (node) => {
    const kids = (node && node.childNodes) || [];
    for (let i = 0; i < kids.length; i++) {
      const k = kids[i];
      if (k.nodeType === 3) {
        const v = k.nodeValue || "";
        if (!v) continue;
        map.push({ node: k, start: pos, end: pos + v.length });
        parts.push(v);
        pos += v.length;
      } else if (k.nodeType === 1) {
        const tag = String(k.tagName || "").toLowerCase();
        if (tag === "br") {
          parts.push("\n");
          pos += 1;
          continue;
        }
        const block = FD_RICH_BLOCKS.test(tag);
        if (block) nl();
        walk(k);
        if (block) nl();
      }
    }
  };
  walk(el);
  return { text: parts.join(""), map: map };
}

function fdTextOf(el) {
  if (!el) return "";
  if (fdIsRichHost(el)) return fdRichScan(el).text;
  if (typeof el.value === "string") return el.value;
  return el.textContent || "";
}

/* ── 查找框本体 ── */

function fdEl(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = String(text);
  return e;
}

function fdBarEl() {
  return document.getElementById("fdBar");
}

/* 目标在「编辑-文本节点」对话框里时，把条子挂进对话框盒子（绝对定位在头部 / 档位条下方）：
   留在 body 上会被近全屏对话框压住边角，正好盖住 ✕ 与放大按钮。目标换出去再挂回 body。 */
function fdMountBar(el) {
  const bar = fdBarEl();
  if (!bar) return;
  const dlg = el && el.closest ? el.closest("#textEditDlg") : null;
  const box = dlg && dlg.querySelector("#textEditBox");
  if (box) {
    if (bar.parentNode !== box) box.appendChild(bar);
    bar.classList.add("fd-in-dlg");
  } else {
    if (bar.parentNode !== document.body) document.body.appendChild(bar);
    bar.classList.remove("fd-in-dlg");
  }
}

function fdPaintLabels() {
  const ui = FD_BAR.ui;
  if (!ui) return;
  ui.input.placeholder = I18n.t("在本输入框内查找");
  /* 本轮提示去重：输入框的 placeholder 已经把用途说清，不再另挂逐字相同的 title；
     框身的 title 改与输入框同一句「在本输入框内查找」（键位只在脚注讲一次）。 */
  ui.bar.title = I18n.t("在本输入框内查找");
  ui.prev.title = I18n.t("上一个");
  ui.prev.setAttribute("aria-label", I18n.t("上一个命中"));
  ui.next.title = I18n.t("下一个");
  ui.next.setAttribute("aria-label", I18n.t("下一个命中"));
  ui.close.title = I18n.t("关闭");
  ui.close.setAttribute("aria-label", I18n.t("关闭查找框"));
  ui.foot.textContent = I18n.t("Enter 下一个 · Shift+Enter 上一个 · Esc 关闭");
  /* 替换那一行只在多行文本（文本节点正文框 / 源码档）里出现，文案单列在下面 */
  if (ui.rep) ui.rep.placeholder = I18n.t("替换为");
  if (ui.repOne) {
    ui.repOne.textContent = I18n.t("替换");
    ui.repOne.title = I18n.t("替换当前命中（Enter）");
    ui.repOne.setAttribute("aria-label", I18n.t("替换当前命中（Enter）"));
  }
  if (ui.repAll) {
    ui.repAll.textContent = I18n.t("全部替换");
    ui.repAll.title = I18n.t("替换本框里的全部命中");
    ui.repAll.setAttribute("aria-label", I18n.t("替换本框里的全部命中"));
  }
}

/* 多行文本（textarea / 编辑-文本节点对话框的富文本正文）才给替换行：
   单行框（节点名 / 搜索框）替换没意义又容易误触 */
function fdIsMultiline(el) {
  const tag = String((el && el.tagName) || "").toLowerCase();
  return tag === "textarea" || fdIsRichHost(el);
}

/* 替换行显隐：跟着目标框走，换目标 / 关框都重算一次 */
function fdSyncReplaceRow() {
  const ui = FD_BAR.ui;
  if (!ui || !ui.repRow) return;
  ui.repRow.hidden = !fdIsMultiline(FD_BAR.el);
}

function fdEnsureBar() {
  let bar = fdBarEl();
  if (bar) return bar;

  bar = fdEl("div", "fd-bar");
  bar.id = "fdBar";
  bar.setAttribute("role", "dialog");
  bar.setAttribute("aria-label", I18n.t("查找（Ctrl+F）：焦点在输入框里时，在框内高亮并定位文字"));

  const ico = fdEl("span", "fd-ico", "⌕");
  const input = fdEl("input", "fd-input");
  input.id = "fdInput";
  input.type = "text";
  input.setAttribute("autocomplete", "off");
  input.setAttribute("spellcheck", "false");

  const count = fdEl("span", "fd-count", "");
  count.id = "fdCount";

  const prev = fdEl("button", "fd-btn", "↑");
  prev.id = "fdPrev";
  prev.type = "button";
  const next = fdEl("button", "fd-btn", "↓");
  next.id = "fdNext";
  next.type = "button";
  const close = fdEl("button", "fd-btn fd-close", "✕");
  close.id = "fdClose";
  close.type = "button";

  const foot = fdEl("div", "fd-foot", "");
  foot.id = "fdFoot";

  /* 第二行：替换（仅多行文本显示，见 fdSyncReplaceRow） */
  const rep = fdEl("input", "fd-input fd-rep-input");
  rep.id = "fdRepInput";
  rep.type = "text";
  rep.setAttribute("autocomplete", "off");
  rep.setAttribute("spellcheck", "false");
  const repOne = fdEl("button", "fd-btn fd-btn-txt", "");
  repOne.id = "fdRepOne";
  repOne.type = "button";
  const repAll = fdEl("button", "fd-btn fd-btn-txt", "");
  repAll.id = "fdRepAll";
  repAll.type = "button";

  const findRow = fdEl("div", "fd-row");
  findRow.appendChild(ico);
  findRow.appendChild(input);
  findRow.appendChild(count);
  findRow.appendChild(prev);
  findRow.appendChild(next);
  findRow.appendChild(close);
  findRow.appendChild(foot);

  const repRow = fdEl("div", "fd-row fd-row-rep");
  repRow.hidden = true;
  repRow.appendChild(fdEl("span", "fd-ico", "⇄"));
  repRow.appendChild(rep);
  repRow.appendChild(repOne);
  repRow.appendChild(repAll);

  bar.appendChild(findRow);
  bar.appendChild(repRow);
  document.body.appendChild(bar);

  FD_BAR.ui = {
    bar: bar,
    input: input,
    count: count,
    prev: prev,
    next: next,
    close: close,
    foot: foot,
    repRow: repRow,
    rep: rep,
    repOne: repOne,
    repAll: repAll,
  };

  input.addEventListener("input", () => {
    /* noFocus：打一个字就把焦点搬到正文，后面的字会打进正文（富文本档尤其致命）。
       命中照样实时重算并选中 —— 富文本档的选区不靠焦点也画得出来；输入框那档靠 fd-hit 描边提示。 */
    fdSearch(input.value, { reset: true, noFocus: true });
  });
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      ev.stopPropagation();
      closeFieldFind({ focus: true });
    } else if (ev.key === "Enter" || ev.key === "ArrowDown") {
      ev.preventDefault();
      ev.stopPropagation();
      fdGoto(FD_BAR.cur + (ev.shiftKey ? 0 : 1), { dir: ev.shiftKey ? -1 : 1 });
    } else if (ev.key === "ArrowUp") {
      ev.preventDefault();
      ev.stopPropagation();
      fdGoto(FD_BAR.cur - 1, { dir: -1 });
    }
  });
  rep.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      ev.stopPropagation();
      closeFieldFind({ focus: true });
    } else if (ev.key === "Enter") {
      ev.preventDefault();
      ev.stopPropagation();
      fdReplaceOne();
    }
  });
  /* 按钮都在 mousedown 先拦一下：不把焦点从查找框抢走，用户接着打字不中断 */
  for (const b of [prev, next, close, repOne, repAll]) {
    b.addEventListener("mousedown", (ev) => ev.preventDefault());
  }
  prev.onclick = () => fdGoto(FD_BAR.cur - 1, { dir: -1 });
  next.onclick = () => fdGoto(FD_BAR.cur + 1, { dir: 1 });
  close.onclick = () => closeFieldFind({ focus: true });
  repOne.onclick = () => fdReplaceOne();
  repAll.onclick = () => fdReplaceAll();

  fdPaintLabels();
  return bar;
}

function fdPaintCount() {
  const ui = FD_BAR.ui;
  if (!ui) return;
  const el = ui.count;
  const n = FD_BAR.matches.length;
  el.classList.remove("fd-empty");
  if (!FD_BAR.q) {
    el.textContent = "";
    return;
  }
  if (!n) {
    el.textContent = I18n.t("无匹配");
    el.classList.add("fd-empty");
    return;
  }
  el.textContent = FD_BAR.cur + 1 + "/" + n;
}

/* 目标框当前是否还持有焦点（焦点能回来＝这次跳转要顺手聚焦） */
function fdFocusInField(el) {
  return !!el && document.activeElement === el;
}

/* 纯文本下标 → DOM Range（富文本宿主用）：按文本节点顺序累加偏移。
   下标的来源（textContent）与这里的遍历是同一批文本节点，两边一定对得上。 */
function fdDomRange(el, start, end) {
  if (fdIsRichHost(el)) return fdRichRange(el, start, end);
  try {
    const doc = el.ownerDocument || document;
    const NF = window.NodeFilter || (typeof NodeFilter !== "undefined" ? NodeFilter : null);
    if (!NF || !doc.createTreeWalker) return null;
    const walker = doc.createTreeWalker(el, NF.SHOW_TEXT, null);
    let node = walker.nextNode();
    let pos = 0;
    let a = null;
    let b = null;
    while (node) {
      const len = node.nodeValue ? node.nodeValue.length : 0;
      if (!a && start <= pos + len && start >= pos) a = [node, start - pos];
      if (!b && end <= pos + len && end >= pos) b = [node, end - pos];
      if (a && b) break;
      pos += len;
      node = walker.nextNode();
    }
    if (!a) return null;
    const range = doc.createRange();
    range.setStart(a[0], a[1]);
    range.setEnd(b ? b[0] : a[0], b ? b[1] : a[1]);
    return range;
  } catch (e) {
    return null;
  }
}

/* 富文本下标 → Range：用 fdRichScan 的映射，命中跨段 / 跨行时也能精确框住 */
function fdRichRange(el, start, end) {
  try {
    const scan = fdRichScan(el);
    const pick = (i) => {
      const list = scan.map;
      for (let k = 0; k < list.length; k++) {
        if (i >= list[k].start && i <= list[k].end) return [list[k].node, i - list[k].start];
      }
      const last = list[list.length - 1];
      if (!last) return null;
      /* 落在行块补出来的 "\n" 上：贴到相邻文本节点的两端 */
      if (i <= start) return [list[0].node, 0];
      return [last.node, last.end - last.start];
    };
    const a = pick(start);
    const b = pick(end);
    if (!a) return null;
    const doc = el.ownerDocument || document;
    const range = doc.createRange();
    range.setStart(a[0], a[1]);
    range.setEnd(b ? b[0] : a[0], b ? b[1] : a[1]);
    return range;
  } catch (e) {
    return null;
  }
}

/* 富文本命中滚进视野：只在它不在可视区时才滚，免得每次跳转都把正文甩一下 */
function fdRevealRichScroll(el, range) {
  try {
    const r = range.getBoundingClientRect ? range.getBoundingClientRect() : null;
    if (!r || !r.height) return;
    const box = el.getBoundingClientRect();
    if (r.top >= box.top + 4 && r.bottom <= box.bottom - 4) return;
    const nd = range.startContainer && range.startContainer.parentElement;
    if (nd && typeof nd.scrollIntoView === "function") nd.scrollIntoView({ block: "nearest" });
  } catch (e) {}
}

/* 把第 i 个命中设成选区：原生选区自带高亮，输入框与 contenteditable 都会自动滚进视野 */
function fdSetInputRange(el, start, end) {
  const tag = String((el && el.tagName) || "").toLowerCase();
  if (tag === "input" || tag === "textarea") {
    if (typeof el.setSelectionRange !== "function") return false;
    try {
      el.setSelectionRange(start, end);
    } catch (e) {
      /* 个别 input 类型不支持 setSelectionRange：静默退化为不选中 */
    }
    return true;
  }
  /* 富文本宿主（编辑-文本节点对话框的正文编辑器）：走 Range，把命中选出来 */
  const range = fdDomRange(el, start, end);
  if (!range) return false;
  const sel = window.getSelection && window.getSelection();
  if (!sel) return false;
  sel.removeAllRanges();
  sel.addRange(range);
  fdRevealRichScroll(el, range);
  return true;
}

/* 输入框横向滚动：只处理单行 / 长行，按行内字符偏移估算 */
function fdRevealInputScroll(el, m) {
  if (!el || !m || typeof el.value !== "string") return;
  if (!("scrollLeft" in el)) return;
  const geom = fdCharGeom(el);
  if (!geom.charW) return;
  const before = String(el.value).slice(0, m.start);
  const line = before.lastIndexOf("\n");
  const row = line < 0 ? before : before.slice(line + 1);
  const target = row.length * geom.charW;
  const boxW = (el.clientWidth || 0) - 2 * geom.pad;
  if (!boxW || boxW <= 0) return;
  if (target >= el.scrollLeft && target <= el.scrollLeft + boxW - geom.charW) return;
  el.scrollLeft = fdScrollLeftFor({ before: before, charW: geom.charW, boxW: boxW });
}

/* 量一次字符宽：用一个隐藏的同字体 span，几何比 canvas 更贴近真实排版 */
function fdCharGeom(el) {
  const cache = FD_BAR;
  const font = (window.getComputedStyle && window.getComputedStyle(el).font) || "";
  if (cache._font === font && cache._charW) {
    return { charW: cache._charW, pad: cache._pad };
  }
  let charW = 0;
  let pad = 0;
  try {
    const cs = window.getComputedStyle(el);
    pad = parseFloat(cs.paddingLeft || "0") || 0;
    const probe = document.createElement("span");
    probe.textContent = "0123456789abcdefghij";
    probe.style.cssText =
      "position:absolute;left:-9999px;top:-9999px;white-space:pre;visibility:hidden;font:" + font;
    document.body.appendChild(probe);
    const w = probe.getBoundingClientRect().width || probe.offsetWidth || 0;
    document.body.removeChild(probe);
    if (w > 0) charW = w / 20;
    if (!charW) {
      /* 兜底：按字号 0.55 估一个，宁可滚多一点也不把命中留在屏外 */
      const fs = parseFloat(cs.fontSize || "13") || 13;
      charW = fs * 0.55;
    }
  } catch (e) {
    charW = 0;
  }
  cache._font = font;
  cache._charW = charW;
  cache._pad = pad;
  return { charW: charW, pad: pad };
}

/* 应用当前命中：选中 + 定位，并按需把焦点还给目标框 */
function fdApplyCurrent(opts) {
  opts = opts || {};
  const ui = FD_BAR.ui;
  if (!ui) return;
  const el = FD_BAR.el;
  const m = FD_BAR.matches[FD_BAR.cur];
  if (!m || !el || !el.isConnected) return;
  /* noFocus：替换那条路用 —— 焦点要留在替换框里，好连续按「替换」 */
  if (!opts.noFocus && (!fdFocusInField(el) || opts.refocus)) {
    try {
      el.focus({ preventScroll: true });
    } catch (e) {}
  }
  fdSetInputRange(el, m.start, m.end);
  fdRevealInputScroll(el, m);
  /* 描边提示只给输入框：富文本宿主整块闪一下太吵，命中本来就有原生选区高亮 */
  const valuelike = /^(input|textarea)$/i.test(String((el && el.tagName) || ""));
  if (valuelike && FD_BAR.token && opts.flash !== false) {
    el.classList.remove("fd-hit");
    void el.offsetWidth;
    el.classList.add("fd-hit");
    clearTimeout(FD_BAR.flashTimer);
    FD_BAR.flashTimer = setTimeout(() => {
      try {
        el.classList.remove("fd-hit");
      } catch (e) {}
    }, 700);
  }
}

/* 跳转：i 越界时循环；dir 只用于给 fdCycle 判方向 */
function fdGoto(i, opts) {
  opts = opts || {};
  const total = FD_BAR.matches.length;
  if (!total) {
    fdPaintCount();
    return;
  }
  const dir = opts.dir || (i > FD_BAR.cur ? 1 : -1);
  if (i < 0 || i >= total) i = fdCycle(FD_BAR.cur, total, dir);
  FD_BAR.cur = i;
  fdPaintCount();
  fdApplyCurrent(opts);
}

/* 重新收集命中：reset=true 时把当前位重置到第一个（新查询）。
   打字过程中**不抢焦点**（焦点留在查找框：中文输入法组合态与连续输入都不被打断），
   只有键盘 / 按钮跳转（fdGoto）与开框那次才把焦点带到目标输入框。 */
function fdSearch(query, opts) {
  opts = opts || {};
  const ui = FD_BAR.ui;
  if (!ui) return;
  FD_BAR.q = String(query == null ? "" : query);
  FD_BAR.token++;
  const el = FD_BAR.el;
  if (!FD_BAR.q || !el || !el.isConnected) {
    FD_BAR.matches = [];
    FD_BAR.cur = -1;
    fdPaintCount();
    return;
  }
  FD_BAR.matches = fdFindMatches(fdTextOf(el), FD_BAR.q);
  if (!FD_BAR.matches.length) {
    FD_BAR.cur = -1;
    fdPaintCount();
    return;
  }
  FD_BAR.cur = opts.reset ? 0 : fdCycle(FD_BAR.cur, FD_BAR.matches.length, 1);
  fdPaintCount();
  fdApplyCurrent({ refocus: !!opts.refocus, noFocus: !!opts.noFocus, flash: opts.flash });
}

/* ── 替换（多行文本：文本节点正文框 / 源码档） ──
   写入优先 execCommand("insertText")：保住原生撤销栈，并自动派发 input，
   宿主（.n-text → node.text、源码档 → node.review）的既有监听一条都不用另接；
   环境不支持时退回整值写回 + 手动派发 input。 */
function fdReplaceRange(el, start, end, rep) {
  if (fdIsRichHost(el)) return fdReplaceRich(el, start, end, rep);
  const tag = String((el && el.tagName) || "").toLowerCase();
  if (tag !== "input" && tag !== "textarea") return false;
  let ok = false;
  try {
    el.focus({ preventScroll: true });
    el.setSelectionRange(start, end);
    if (typeof document.execCommand === "function")
      ok = document.execCommand("insertText", false, String(rep));
  } catch (e) {
    ok = false;
  }
  if (ok) return true;
  const text = String(el.value == null ? "" : el.value);
  el.value = text.slice(0, start) + String(rep) + text.slice(end);
  try {
    el.dispatchEvent(new Event("input", { bubbles: true }));
  } catch (e) {}
  try {
    el.setSelectionRange(start + String(rep).length, start + String(rep).length);
  } catch (e) {}
  return true;
}

/* 富文本替换：选中那段 DOM Range 后 execCommand("insertText") —— Chromium 对
   contenteditable 支持它，原生撤销栈保住，并自动派发 input，编辑器自己的
   input 监听（teCommit / tePushToNode）照旧把正文推回节点，不用另接通路；
   不支持时退回 Range 增删 + 手动派发 input。 */
function fdReplaceRich(el, start, end, rep) {
  const text = String(rep == null ? "" : rep);
  const range = fdDomRange(el, start, end);
  if (!range) return false;
  let ok = false;
  try {
    el.focus({ preventScroll: true });
    const sel = window.getSelection && window.getSelection();
    if (sel) {
      sel.removeAllRanges();
      sel.addRange(range);
      if (typeof document.execCommand === "function")
        ok = document.execCommand("insertText", false, text);
    }
  } catch (e) {
    ok = false;
  }
  if (ok) return true;
  try {
    range.deleteContents();
    if (text) {
      const tn = (el.ownerDocument || document).createTextNode(text);
      range.insertNode(tn);
      range.setStartAfter(tn);
      range.collapse(true);
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  } catch (e) {
    return false;
  }
}

/* 替换后停在「刚换过那一处的后面」的第一个命中（没有就回到第一处） */
function fdMatchAtOrAfter(pos) {
  const list = FD_BAR.matches;
  for (let i = 0; i < list.length; i++) if (list[i].start >= pos) return i;
  return list.length ? 0 : -1;
}

/* 焦点原本在查找框里的话，替换完再放回去：连按「替换」不被打断 */
function fdRestoreFocus(prev) {
  if (!prev || !prev.isConnected || !FD_BAR.ui || !FD_BAR.ui.bar.contains(prev)) return;
  try {
    prev.focus({ preventScroll: true });
  } catch (e) {}
}

function fdReplaceOne() {
  const ui = FD_BAR.ui;
  const el = FD_BAR.el;
  if (!ui || !el || !el.isConnected || !FD_BAR.q) return false;
  const m = FD_BAR.matches[FD_BAR.cur];
  if (!m) {
    fdPaintCount();
    return false;
  }
  const rep = String(ui.rep.value == null ? "" : ui.rep.value);
  const prev = document.activeElement;
  if (!fdReplaceRange(el, m.start, m.end, rep)) return false;
  const caret = m.start + rep.length;
  fdSearch(FD_BAR.q, { reset: true, noFocus: true });
  const at = fdMatchAtOrAfter(caret);
  if (at >= 0) fdGoto(at, { noFocus: true });
  fdRestoreFocus(prev);
  return true;
}

function fdReplaceAll() {
  const ui = FD_BAR.ui;
  const el = FD_BAR.el;
  if (!ui || !el || !el.isConnected || !FD_BAR.q) return false;
  const rep = String(ui.rep.value == null ? "" : ui.rep.value);
  /* 重叠命中（"aaa" 找 "aa"）按不重叠算，否则同一段字会被换两遍 */
  const list = fdFindMatchesOnce(fdTextOf(el), FD_BAR.q);
  if (!list.length) return false;
  const prev = document.activeElement;
  /* 从后往前换：前面的命中下标不会被打乱 */
  for (let i = list.length - 1; i >= 0; i--) {
    if (!fdReplaceRange(el, list[i].start, list[i].end, rep)) break;
    if (!el.isConnected) return true;
  }
  fdSearch(FD_BAR.q, { reset: true, noFocus: true });
  fdRestoreFocus(prev);
  if (typeof toast === "function") toast(I18n.t("已全部替换 {n} 处", { n: list.length }), "ok");
  return true;
}

function fieldFindIsOpen() {
  return !!FD_BAR.open;
}

/* ── 开关 ── */

/* 开框：field 省略时取当前焦点所在的输入框；返回 false 表示该场合并无框内查找 */
function openFieldFind(opts) {
  opts = opts || {};
  const el = opts.field && fdIsSearchableField(opts.field) ? opts.field : fdFieldFromFocus();
  if (!el) return false;
  const bar = fdEnsureBar();
  if (!bar) return false;

  const same = FD_BAR.open && FD_BAR.el === el;
  FD_BAR.el = el;
  FD_FIELD_LAST = el;
  FD_BAR.open = true;
  fdMountBar(el);
  bar.classList.add("on");

  /* 换目标时清空旧查询（不同输入框的正文没有共享查询的意义）；同一目标保留查询，
     这样「点走再点回来 / 再按一次 Ctrl+F」都不用重新输 */
  if (opts.query != null) FD_BAR.ui.input.value = String(opts.query);
  else if (!same) FD_BAR.ui.input.value = "";
  if (!same) FD_BAR.ui.rep.value = "";
  fdPaintLabels();
  fdSyncReplaceRow();

  const advance = !!(opts.advance && same && FD_BAR.ui.input.value && FD_BAR.matches.length);
  if (advance) {
    /* 已经在这只框里查过一轮了：Ctrl+F 就是「下一个」，别把当前位 reset 回第一个 */
    fdGoto(FD_BAR.cur + 1, { dir: 1 });
  } else {
    fdSearch(FD_BAR.ui.input.value, { reset: true });
    if (!same) {
      /* 新开的：光标默认落在查找框里，接着直接打字即可 */
      try {
        FD_BAR.ui.input.focus({ preventScroll: true });
      } catch (e) {}
      FD_BAR.ui.input.select();
      /* 焦点留在查找框，但第一个命中照样先选上并滚进视野（开框就能看见落在哪）。
         noFocus：别把焦点抢到正文去 —— 开框后用户要接着打字。 */
      fdApplyCurrent({ flash: false, noFocus: true });
    }
  }
  return true;
}

function closeFieldFind(opts) {
  opts = opts || {};
  if (!FD_BAR.open) return false;
  FD_BAR.open = false;
  FD_BAR.token++;
  clearTimeout(FD_BAR.flashTimer);
  const ui = FD_BAR.ui;
  if (ui) {
    ui.bar.classList.remove("on");
    /* 光标停在当前命中处（不是框首）：关掉就能接着改这一处 */
    const el = FD_BAR.el;
    const m = FD_BAR.matches[FD_BAR.cur];
    if (opts.focus && el && el.isConnected && m) {
      try {
        el.focus({ preventScroll: true });
      } catch (e) {}
      fdSetInputRange(el, m.end, m.end);
    }
    try {
      el && el.classList.remove("fd-hit");
    } catch (e) {}
    if (ui.input) ui.input.value = "";
    if (ui.rep) ui.rep.value = "";
    if (ui.repRow) ui.repRow.hidden = true;
  }
  FD_BAR.matches = [];
  FD_BAR.cur = -1;
  FD_BAR.q = "";
  FD_BAR.el = null;
  return true;
}

/* ── 键盘接线（document 捕获段：先于 app.js / app-keys.js 的 window 冒泡监听） ── */

document.addEventListener(
  "keydown",
  (ev) => {
    const mod = ev.ctrlKey || ev.metaKey;
    const key = String(ev.key || "").toLowerCase();

    /* Ctrl+F：焦点在输入框里 → 框内查找；不在 → 放行给 app.js 的全局搜索。
     焦点已经在查找框自己身上时（点 / 走完一个命中接着按），目标仍是那只被查找的输入框。 */
    if (mod && key === "f" && !ev.altKey && !ev.shiftKey) {
      /* 焦点在本框任意一处（查找框 / 替换框）都指回被查找的那只输入框，
         别把查找框自己当成目标（Ctrl+F 在替换框里也该是「下一个」） */
      const self = !!(FD_BAR.ui && FD_BAR.ui.bar && FD_BAR.ui.bar.contains(document.activeElement));
      const el = self ? FD_BAR.el || FD_FIELD_LAST : fdFieldFromFocus();
      if (!el || !fdIsSearchableField(el)) return;
      ev.preventDefault();
      ev.stopPropagation();
      if (FD_BAR.open && FD_BAR.el === el) openFieldFind({ field: el, advance: true });
      else openFieldFind({ field: el });
      return;
    }

    /* Esc：先让图片灯箱 / 全局搜索等更外层的浮层按各自口径处理，收尾才轮到查找框 */
    if (ev.key === "Escape" && FD_BAR.open) {
      const lb = document.getElementById("imgLb");
      if (lb && lb.classList.contains("on")) return;
      const gs = document.getElementById("gsLayer");
      if (gs && gs.classList.contains("on") && gs.contains(ev.target)) return;
      ev.preventDefault();
      ev.stopPropagation();
      closeFieldFind({ focus: true });
    }
  },
  true,
);

/* 目标框被搬走（切画布 / 重渲染 / 面板关闭）时收框，别留一只指向空气的浮层。
   面板级对话框同样 persistent：这里**不**因为焦点离开就关。 */
document.addEventListener(
  "focusout",
  (ev) => {
    if (!FD_BAR.open) return;
    if (ev.target !== FD_BAR.el) return;
    if (!FD_BAR.el.isConnected) closeFieldFind();
  },
  true,
);

window.addEventListener("resize", () => {
  /* 查找框贴右上角，窗口变化只影响命中滚动几何：重算一次当前命中 */
  if (FD_BAR.open) {
    FD_BAR._charW = 0;
    FD_BAR._font = "";
    fdApplyCurrent({ flash: false });
  }
});

/* 与全局搜索浮层同一口径：切语言时重绘本框文案（app-boot.js 的 applyLocale 会调） */
function fieldFindRepaint() {
  fdPaintLabels();
  fdPaintCount();
}

window.openFieldFind = openFieldFind;
window.closeFieldFind = closeFieldFind;
window.fieldFindIsOpen = fieldFindIsOpen;
window.fieldFindRepaint = fieldFindRepaint;