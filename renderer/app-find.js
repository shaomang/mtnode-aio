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
 *   fdFindMatches(text, query) / fdCycle(cur, total, dir) / fdScrollLeftFor(geom)
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

function fdIsSearchableField(el) {
  if (!el || el.nodeType !== 1) return false;
  const tag = String(el.tagName || "").toLowerCase();
  if (tag === "textarea") return true;
  if (tag === "input") {
    const type = String(el.getAttribute("type") || "").toLowerCase();
    return !!FD_INPUT_TEXT_TYPES[type];
  }
  return false;
}

/* 当前焦点所在的输入框（没有就退回上一个还在文档里的） */
function fdFieldFromFocus() {
  const ae = document.activeElement;
  if (fdIsSearchableField(ae)) return ae;
  const last = FD_FIELD_LAST;
  if (last && last.isConnected && fdIsSearchableField(last)) return last;
  return null;
}

function fdTextOf(el) {
  if (!el) return "";
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

function fdPaintLabels() {
  const ui = FD_BAR.ui;
  if (!ui) return;
  ui.input.placeholder = I18n.t("在本输入框内查找");
  ui.input.title = I18n.t("在本输入框内查找");
  ui.bar.title = I18n.t("查找（Ctrl+F）：焦点在输入框里时，在框内高亮并定位文字");
  ui.prev.title = I18n.t("上一个（Shift+Enter / ↑）");
  ui.prev.setAttribute("aria-label", I18n.t("上一个命中"));
  ui.next.title = I18n.t("下一个（Enter / ↓）");
  ui.next.setAttribute("aria-label", I18n.t("下一个命中"));
  ui.close.title = I18n.t("关闭（Esc）");
  ui.close.setAttribute("aria-label", I18n.t("关闭查找框"));
  ui.foot.textContent = I18n.t("Enter 下一个 · Shift+Enter 上一个 · Esc 关闭");
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

  bar.appendChild(ico);
  bar.appendChild(input);
  bar.appendChild(count);
  bar.appendChild(prev);
  bar.appendChild(next);
  bar.appendChild(close);
  bar.appendChild(foot);
  document.body.appendChild(bar);

  FD_BAR.ui = { bar: bar, input: input, count: count, prev: prev, next: next, close: close, foot: foot };

  input.addEventListener("input", () => {
    fdSearch(input.value, { reset: true });
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
  /* 按钮都在 mousedown 先拦一下：不把焦点从查找框抢走，用户接着打字不中断 */
  for (const b of [prev, next, close]) {
    b.addEventListener("mousedown", (ev) => ev.preventDefault());
  }
  prev.onclick = () => fdGoto(FD_BAR.cur - 1, { dir: -1 });
  next.onclick = () => fdGoto(FD_BAR.cur + 1, { dir: 1 });
  close.onclick = () => closeFieldFind({ focus: true });

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
  /* 富文本宿主（当前不在查找范围，留作扩展）：走 Range，把命中选出来 */
  try {
    const doc = el.ownerDocument || document;
    const NF = window.NodeFilter || (typeof NodeFilter !== "undefined" ? NodeFilter : null);
    if (!NF || !doc.createTreeWalker) return false;
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
    if (!a) return false;
    const range = doc.createRange();
    range.setStart(a[0], a[1]);
    range.setEnd(b ? b[0] : a[0], b ? b[1] : a[1]);
    const sel = window.getSelection && window.getSelection();
    if (!sel) return false;
    sel.removeAllRanges();
    sel.addRange(range);
    return true;
  } catch (e) {
    return false;
  }
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
  if (!fdFocusInField(el) || opts.refocus) {
    try {
      el.focus({ preventScroll: true });
    } catch (e) {}
  }
  fdSetInputRange(el, m.start, m.end);
  fdRevealInputScroll(el, m);
  if (FD_BAR.token && opts.flash !== false) {
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
  fdApplyCurrent({ refocus: !!opts.refocus });
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
  bar.classList.add("on");

  /* 换目标时清空旧查询（不同输入框的正文没有共享查询的意义）；同一目标保留查询，
     这样「点走再点回来 / 再按一次 Ctrl+F」都不用重新输 */
  if (opts.query != null) FD_BAR.ui.input.value = String(opts.query);
  else if (!same) FD_BAR.ui.input.value = "";
  fdPaintLabels();

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
      /* 焦点留在查找框，但第一个命中照样先选上并滚进视野（开框就能看见落在哪） */
      fdApplyCurrent({ flash: false });
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
      const self = FD_BAR.ui && FD_BAR.ui.input === document.activeElement;
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