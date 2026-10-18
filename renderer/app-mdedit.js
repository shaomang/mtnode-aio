"use strict";
/* ===== Markdown 编辑手感（四个编辑面共用的一份实现）=====
 *
 * 谁在用（同一套口径，不各写一份）：
 *   ① 文本节点的 Markdown 编辑器  renderer/app-textedit.js（富文本档 + 源码档）
 *   ② ✎ AI 审阅窗的正文编辑面      renderer/app-review.js（富文本档 + 源码档）
 *   ③ 内置 Markdown 阅读器的编辑态 renderer/app.js 的 mdViewer（富文本档 + 源码档）
 *   ④ 画布节点板身的正文 textarea  renderer/app-canvas.js / app.js（纯 Markdown 文本）
 *
 * 提供两件事：
 *   · tabRich / tabSource —— Tab 只插 4 个空格（富文本档与源码档同一口径）。
 *     富文本档：光标折叠时插在光标处；选中了多行就每行行首各插一次。
 *     源码档 / 板身 textarea：选中了多行同样逐行缩进，Shift+Tab 退一档。
 *     早先那套「Tab 把列表项缩进一层、显示层按 CSS 计数器数出 1. → 1.1.」的自动层级、
 *     以及「空块里敲 `- ` / `1. ` / `# ` / `> ` / `- [ ] ` 即时成块」的自动转换，
 *     用户口径已整体下线：编辑器不再替用户改 Markdown 结构，正文怎么写就怎么存。
 *   · onPasteRich —— 粘贴：优先吃剪贴板里的 HTML（structure 保真），纯文本才按 Markdown 解析。
 *
 * 依赖（全部在调用期取，缺了就降级，不在加载期依赖）：
 *   window.marked（vendor/marked.min.js）、mdToRichHtml（app-review.js）。
 * 加载顺序：app-review.js 之后、app-textedit.js / app.js 之前（见 renderer/index.html）。
 */

(function () {
  /* 缩进单位：4 个空格。Markdown 里 4 空格既是列表缩进也是代码块缩进，
     写空格比写制表符可移植；正文里存的就是这 4 个空格，不做任何结构改写。 */
  const INDENT = "    ";

  /* 改完 DOM 之后自己派发一次 input：宿主的「脏标记 / 实时保存 / 读回来的草稿」
     全靠这个事件（早先的 Tab 缩进只改 DOM 不报案，宿主按旧正文重渲染就把缩进吃了）。 */
  function fireInput(el) {
    if (!el) return;
    try {
      el.dispatchEvent(new Event("input", { bubbles: true }));
    } catch (_) {}
  }

  /* ---------- 源码档 / 纯文本 textarea：缩进 / 反缩进 ---------- */

  /* 当前行（含）到行尾的区间 + 选区覆盖的行范围 */
  function lineInfo(ta) {
    const v = String(ta.value == null ? "" : ta.value);
    const s = Number(ta.selectionStart) || 0;
    const e = Number(ta.selectionEnd) || 0;
    const delims = [v.lastIndexOf("\n", Math.max(0, s - 1)), v.lastIndexOf("\r", Math.max(0, s - 1))];
    const ls = Math.max(delims[0], delims[1]) + 1;
    let le = v.indexOf("\n", e);
    if (le < 0) le = v.length;
    return { v: v, s: s, e: e, ls: ls, le: le };
  }
  /* 源码档 Tab：选区覆盖的每一行行首都加 4 个空格（没选行 = 当前行）。
     与 Shift+Tab 对称：一个加一档、一个减一档，光标跟着移动，行内位置基本不动。 */
  function tabSource(ta) {
    if (!ta) return false;
    const L = lineInfo(ta);
    const lines = L.v.slice(L.ls, L.le).split("\n");
    const out = lines.map((ln) => INDENT + ln);
    ta.value = L.v.slice(0, L.ls) + out.join("\n") + L.v.slice(L.le);
    try {
      ta.setSelectionRange(L.s + INDENT.length, L.e + INDENT.length * out.length);
    } catch (_) {}
    fireInput(ta);
    return true;
  }
  function shiftTabSource(ta) {
    if (!ta) return false;
    const L = lineInfo(ta);
    const chunk = L.v.slice(L.ls, L.le);
    const lines = chunk.split("\n");
    let n = 0;
    let changed = false;
    const out = lines.map((ln) => {
      const m = /^ {1,4}/.exec(ln);
      if (m) {
        changed = true;
        n += m[0].length;
        return ln.slice(m[0].length);
      }
      return ln;
    });
    if (!changed) return false;
    ta.value = L.v.slice(0, L.ls) + out.join("\n") + L.v.slice(L.le);
    try {
      const pos = Math.max(L.ls, L.s - Math.min(4, n));
      ta.setSelectionRange(pos, pos);
    } catch (_) {}
    fireInput(ta);
    return true;
  }

  /* ---------- 富文本档：Tab 插 4 个空格 ---------- */

  /* 富文本档里的「行」= 这些块级容器；只认最深的那些（<li><p>…</p></li> 缩 p，
     缩 li 会把空格塞到 <ul> 外面去）。 */
  const BLOCK_SEL = "p,li,h1,h2,h3,h4,h5,h6,blockquote,pre,td,th,dd,dt";
  function blocksInRange(ed, r) {
    if (!ed || !r || !ed.querySelectorAll) return [];
    let all = [];
    try {
      all = ed.querySelectorAll(BLOCK_SEL);
    } catch (_) {
      all = [];
    }
    const hit = [];
    for (let i = 0; i < all.length; i++) {
      let on = false;
      try {
        on = r.intersectsNode ? r.intersectsNode(all[i]) : false;
      } catch (_) {
        on = false;
      }
      if (on) hit.push(all[i]);
    }
    return hit.filter((el) => !hit.some((o) => o !== el && el.contains(o)));
  }
  function selectionIn(ed) {
    let sel = null;
    try {
      sel = window.getSelection ? window.getSelection() : null;
    } catch (_) {
      sel = null;
    }
    if (!sel || !sel.rangeCount) return null;
    let r = null;
    try {
      r = sel.getRangeAt(0);
    } catch (_) {
      return null;
    }
    if (!r || !ed.contains(r.startContainer)) return null;
    return { sel: sel, range: r };
  }
  /* 在光标处插一段纯文本，光标落到后面 */
  function insertTextAtCaret(sel, range, text) {
    try {
      range.deleteContents();
    } catch (_) {}
    const tn = document.createTextNode(text);
    try {
      range.insertNode(tn);
      const nr = document.createRange();
      nr.setStart(tn, tn.nodeValue.length);
      nr.collapse(true);
      sel.removeAllRanges();
      sel.addRange(nr);
      return true;
    } catch (_) {
      return false;
    }
  }
  /* 在块首插一段纯文本（多行缩进用），返回插进去的文本节点 */
  function insertTextAtBlockStart(block, text) {
    const r = document.createRange();
    const first = block.firstChild;
    if (first && first.nodeType === 3) r.setStart(first, 0);
    else r.setStart(block, 0);
    r.collapse(true);
    const tn = document.createTextNode(text);
    r.insertNode(tn);
    return tn;
  }
  /* 富文本档 Tab：只插 4 个空格，不碰列表结构、不接管序号。
     选中多行 → 每行行首各插一次，选区保持覆盖这几行。 */
  function tabRich(ed) {
    if (!ed || !ed.isContentEditable) return false;
    const got = selectionIn(ed);
    if (!got) return false;
    const { sel, range } = got;
    const blocks = blocksInRange(ed, range);
    if (blocks.length <= 1) {
      /* 单行（或光标折叠）：插在光标处 */
      if (insertTextAtCaret(sel, range, INDENT)) {
        fireInput(ed);
        return true;
      }
      return false;
    }
    const firsts = [];
    const lasts = [];
    for (let i = 0; i < blocks.length; i++) {
      try {
        firsts.push(insertTextAtBlockStart(blocks[i], INDENT));
        lasts.push(blocks[i]);
      } catch (_) {}
    }
    if (!firsts.length) return false;
    try {
      const tail = lasts[lasts.length - 1];
      const nr = document.createRange();
      nr.setStart(firsts[0], INDENT.length);
      const lastChild = tail.lastChild;
      if (lastChild && lastChild.nodeType === 3) nr.setEnd(lastChild, lastChild.nodeValue.length);
      else nr.setEnd(tail, tail.childNodes.length);
      sel.removeAllRanges();
      sel.addRange(nr);
    } catch (_) {}
    fireInput(ed);
    return true;
  }
  /* 富文本档 Shift+Tab：不做任何 Markdown 处理（用户口径 —— 编辑器不再替用户改结构），
     交回浏览器默认行为。 */
  function shiftTabRich() {
    return false;
  }

  /* ---------- 富文本档：粘贴 ---------- */

  function hasMarkup(s) {
    return /<\/?[a-z][\s\S]*>/i.test(String(s || ""));
  }
  function insertHtmlAtCaret(html) {
    try {
      if (document.execCommand) return document.execCommand("insertHTML", false, String(html));
    } catch (_) {}
    return false;
  }
  /* 优先吃剪贴板里的 HTML；纯文本才按 Markdown 解析。
     返回 true = 已按结构插入（调用方要 preventDefault）。
     同一个事件上只处理一次（插图模块也听 paste，它排在后面时不能重复插一份）。 */
  function onPasteRich(ed, ev) {
    const dt = ev && ev.clipboardData;
    if (!dt || !ed) return false;
    try {
      if (ev.__mtMdPaste) return true;
    } catch (_) {}
    let html = "";
    let text = "";
    try {
      html = dt.getData("text/html") || "";
    } catch (_) {}
    try {
      text = dt.getData("text/plain") || "";
    } catch (_) {}
    try {
      if (!text && dt.getData("text/rtf")) text = dt.getData("text/rtf");
    } catch (_) {}
    if (!text && !html) return false;
    let payload = "";
    if (hasMarkup(html)) {
      payload = html;
    } else if (text.indexOf("\n") >= 0) {
      let rendered = "";
      try {
        rendered = typeof mdToRichHtml === "function" ? mdToRichHtml(text) : "";
      } catch (_) {
        rendered = "";
      }
      if (!rendered) return false;
      payload = rendered;
    } else {
      return false;
    }
    const done = insertHtmlAtCaret(payload);
    if (done) {
      try {
        ev.__mtMdPaste = true;
      } catch (_) {}
      if (ev.preventDefault) ev.preventDefault();
    }
    return done;
  }

  /* ---------- 事件接线（一处接好，四个编辑面共用） ---------- */

  function bindRich(ed) {
    if (!ed) return;
    ed.addEventListener("keydown", (ev) => {
      if (ev.key !== "Tab") return;
      /* 富文本档 Tab 一律自己吃掉：插 4 个空格，不把光标踢出编辑区。
         Shift+Tab 不接管（交回浏览器默认）。 */
      if (ev.shiftKey) return;
      const out = tabRich(ed);
      if (out !== false && ev.preventDefault) ev.preventDefault();
    });
    ed.addEventListener("paste", (ev) => {
      try {
        onPasteRich(ed, ev);
      } catch (_) {}
    });
  }
  function bindSource(ta) {
    if (!ta) return;
    ta.addEventListener("keydown", (ev) => {
      if (ev.key !== "Tab") return;
      const out = ev.shiftKey ? shiftTabSource(ta) : tabSource(ta);
      if (out !== false && ev.preventDefault) ev.preventDefault();
    });
  }

  /* ---------- 焦点保管：「保存」不许夺焦（四个编辑面共用） ----------
     现场：在编辑框里打字，停笔 600ms 自动保存 / Ctrl+S / 关窗收尾 / AI 修订落地 / 板身
     双向同步 —— 这些落盘路径都会顺手 renderCanvas()、重建板身 textarea，某些路径还会整段
     重建编辑区 DOM。这一拍只要把正在打字的元素换掉或 blur 掉，字还在、光标没了，用户就得
     再点一次才能接着输。
     口径（保存路径必须遵守）：
       ① surfaceKey(el) 认出「Markdown 编辑面」，画布那边的重绘守卫也认这一份判据；
       ② captureEditFocus / restoreEditFocus 做一次「焦点 + 光标 / 选区 + 滚动」快照与还原；
       ③ 元素被换成新节点时按「同一个面」（同 key + 同节点 id）把它找回来，光标按文本偏移
          落回去 —— 重建过的 DOM 也能接着输；
       ④ 只还原同一个面：焦点已经落在另一个编辑面 / 用户点过的控件上就不抢回来。
     keepEditFocus(fn) 是落盘路径的统一包法：fn 跑完（哪怕抛错）都把编辑面放回原样。 */

  /* 编辑面登记表：key 一旦出现在冒烟里就被钉住，加面 / 改选择器要同步 test/smoke-edit-focus.js */
  const SURFACES = [
    { key: "te-rich", sel: "#textEditDlg .rv-rich" },
    { key: "te-src", sel: "#textEditDlg .rv-src" },
    { key: "rv-rich", sel: "#reviewDlg .rv-rich" },
    { key: "rv-src", sel: "#reviewDlg .rv-src" },
    { key: "mdv-rich", sel: "#mdViewerDlg #mdViewerRich" },
    { key: "mdv-src", sel: "#mdViewerDlg #mdViewerEditor" },
    { key: "node-body", sel: "#stage textarea.n-text" },
  ];
  function surfaceKey(el) {
    if (!el || el.nodeType !== 1 || typeof el.matches !== "function") return "";
    for (let i = 0; i < SURFACES.length; i++) {
      try {
        if (el.matches(SURFACES[i].sel)) return SURFACES[i].key;
      } catch (_) {}
    }
    return "";
  }
  /* 编辑面所属的画布节点（板身正文框才有；弹窗 / 阅读器为空） */
  function surfaceNodeId(el) {
    try {
      const host = el && el.closest ? el.closest(".wf-node") : null;
      return host && host.dataset ? String(host.dataset.nid || "") : "";
    } catch (_) {
      return "";
    }
  }
  function surfaceVisible(el) {
    try {
      return !!el && el.isConnected !== false && el.getClientRects().length > 0;
    } catch (_) {
      return false;
    }
  }
  /* 重建后再找一次「同一个面」：同 key、同节点 id、可见。找不到就返回 null（不硬抢焦点）。 */
  function findSurface(key, nodeId) {
    for (let i = 0; i < SURFACES.length; i++) {
      const s = SURFACES[i];
      if (s.key !== key) continue;
      let list = null;
      try {
        list = s.key === "node-body" && nodeId
          ? document.querySelectorAll('.wf-node[data-nid="' + nodeId + '"] textarea.n-text')
          : document.querySelectorAll(s.sel);
      } catch (_) {
        list = null;
      }
      for (let j = 0; list && j < list.length; j++) {
        const el = list[j];
        if (!surfaceVisible(el)) continue;
        if (s.key === "node-body" && surfaceNodeId(el) !== String(nodeId || "")) continue;
        return el;
      }
      return null;
    }
    return null;
  }
  /* ---------- contenteditable 的「文本偏移」----------
     偏移只在「拍快照 → 还原」这一来一回里用，两边必须是同一把尺子。
     早先只数文本节点的字符数：<br> 与块级元素（<p> 的边界就是换行）一律不计长度，
     于是「回车后的新行开头」与「上一行末尾」算出来是同一个偏移 —— 还原时按偏移反查
     只能命中上一段文本（文本长度刚好等于该偏移），光标被拽回上一行：用户看到的正是
     「按回车光标不往下走」。同一段还原还会在 700ms 轮询 / 自动保存里跑，于是「点正文
     某处、光标却落在别处」也出在这里。
     口径（capture 与 restore 同一份）：文本按字符数；<br>/<img>/<hr> 各占 1 位；
     块级元素尾部各占 1 位（块内文字因此不会与相邻块的落点撞车）。 */
  const ATOM_TAG = /^(BR|IMG|HR)$/;
  const BLOCK_TAG =
    /^(P|DIV|LI|UL|OL|H1|H2|H3|H4|H5|H6|BLOCKQUOTE|PRE|TABLE|THEAD|TBODY|TR|TD|TH|DL|DT|DD|FIGURE|SECTION)$/;
  function isAtomEl(n) {
    return !!n && n.nodeType === 1 && ATOM_TAG.test(String(n.tagName || ""));
  }
  function isBlockEl(n) {
    return !!n && n.nodeType === 1 && BLOCK_TAG.test(String(n.tagName || ""));
  }
  /* 一个节点在偏移尺子上占多少：文本 = 字数，原子元素 = 1，块级元素 = 内容 + 块尾 1 位 */
  function nodeOffsetLen(n) {
    if (!n) return 0;
    if (n.nodeType === 3) return n.nodeValue ? n.nodeValue.length : 0;
    if (n.nodeType !== 1) return 0;
    if (isAtomEl(n)) return 1;
    let s = 0;
    for (let i = 0; i < n.childNodes.length; i++) s += nodeOffsetLen(n.childNodes[i]);
    return isBlockEl(n) ? s + 1 : s;
  }
  /* 节点在父节点 childNodes 里的下标（Range 的元素级 offset 就是它） */
  function idxInParent(n) {
    if (!n || !n.parentNode) return 0;
    let i = 0;
    let p = n;
    while (p && p.previousSibling) {
      p = p.previousSibling;
      i += 1;
    }
    return i;
  }
  function richTextOffset(root, node, offset) {
    if (!root || !node) return null;
    const want = Math.max(0, Number(offset) || 0);
    let total = 0;
    let done = null;
    const walk = (n) => {
      if (done !== null) return;
      if (n === node) {
        if (n.nodeType === 3) {
          done = total + Math.min(want, n.nodeValue ? n.nodeValue.length : 0);
        } else {
          /* 元素节点：到第 offset 个子节点之前为止（用同一把尺子累加前缀） */
          let s = 0;
          const lim = Math.min(want, n.childNodes.length);
          for (let i = 0; i < lim; i++) s += nodeOffsetLen(n.childNodes[i]);
          done = total + s;
        }
        return;
      }
      if (n.nodeType === 3) {
        total += n.nodeValue ? n.nodeValue.length : 0;
        return;
      }
      if (isAtomEl(n)) {
        total += 1;
        return;
      }
      for (let i = 0; i < n.childNodes.length; i++) {
        walk(n.childNodes[i]);
        if (done !== null) return;
      }
      if (n !== root && isBlockEl(n)) total += 1;
    };
    walk(root);
    return done;
  }
  function richNodeAtOffset(root, offset) {
    if (!root) return null;
    const want = Math.max(0, Number(offset) || 0);
    let total = 0;
    let hit = null;
    const walk = (n) => {
      if (hit) return;
      if (n.nodeType === 3) {
        const len = n.nodeValue ? n.nodeValue.length : 0;
        if (want <= total + len) {
          hit = { node: n, offset: want - total };
          return;
        }
        total += len;
        return;
      }
      if (isAtomEl(n)) {
        const p = n.parentNode || root;
        /* 原子元素占 1 位：落点在它之前 = 父里它的下标，之后 = 下标 + 1 */
        if (want <= total) {
          hit = { node: p, offset: idxInParent(n) };
          return;
        }
        total += 1;
        if (want <= total) {
          hit = { node: p, offset: idxInParent(n) + 1 };
          return;
        }
        return;
      }
      for (let i = 0; i < n.childNodes.length; i++) {
        walk(n.childNodes[i]);
        if (hit) return;
      }
      if (n !== root && isBlockEl(n)) {
        /* 块尾那一位 = 光标紧跟在整块之后（父节点里它的下一个位置） */
        if (want <= total + 1) {
          hit = { node: n.parentNode || root, offset: idxInParent(n) + 1 };
          return;
        }
        total += 1;
      }
    };
    walk(root);
    if (!hit) {
      const last = root.lastChild;
      hit = { node: root, offset: root.childNodes.length };
      if (last && last.nodeType === 3) hit = { node: last, offset: last.nodeValue.length };
    }
    return hit;
  }
  /* 快照：只对「Markdown 编辑面」生效（别的控件与保存无关，一律不碰） */
  function captureEditFocus(el) {
    const target = el || (typeof document !== "undefined" ? document.activeElement : null);
    const key = surfaceKey(target);
    if (!key) return null;
    const snap = {
      key: key,
      nodeId: surfaceNodeId(target),
      el: target,
      scrollTop: Number(target.scrollTop) || 0,
      scrollLeft: Number(target.scrollLeft) || 0,
      start: null,
      end: null,
      rich: false,
    };
    try {
      if (typeof target.selectionStart === "number") {
        snap.start = target.selectionStart;
        snap.end = typeof target.selectionEnd === "number" ? target.selectionEnd : snap.start;
      } else if (target.isContentEditable) {
        const sel = typeof window !== "undefined" && window.getSelection ? window.getSelection() : null;
        if (sel && sel.rangeCount > 0) {
          const r = sel.getRangeAt(0);
          if (target.contains(r.startContainer) && target.contains(r.endContainer)) {
            snap.rich = true;
            snap.start = richTextOffset(target, r.startContainer, r.startOffset);
            snap.end = richTextOffset(target, r.endContainer, r.endOffset);
          }
        }
      }
    } catch (_) {}
    return snap;
  }
  /* 现在的选区是不是已经等价于快照？等价就一个字节都不动 —— 重设选区会打断中文输入法的
     组合、也会把用户刚点下的落点拽回上一处（「点击时没落在光标的地方」就是这么来的）。 */
  function textareaCaretSame(el, snap) {
    try {
      const a = Number(el.selectionStart);
      const b = Number(el.selectionEnd);
      return a === Number(snap.start) && b === Number(snap.end == null ? snap.start : snap.end);
    } catch (_) {
      return false;
    }
  }
  function richCaretSame(el, snap) {
    try {
      const sel = window.getSelection ? window.getSelection() : null;
      if (!sel || sel.rangeCount <= 0) return false;
      const r = sel.getRangeAt(0);
      if (!r || !el.contains(r.startContainer) || !el.contains(r.endContainer)) return false;
      const a = richTextOffset(el, r.startContainer, r.startOffset);
      const b = richTextOffset(el, r.endContainer, r.endOffset);
      return a === Number(snap.start) && b === Number(snap.end == null ? snap.start : snap.end);
    } catch (_) {
      return false;
    }
  }
  /* 还原：同元素就补齐光标与滚动；元素被重建过就找回同一个面再落光标。
     焦点已落在「另一个编辑面」上时不抢（那是用户自己换的台）；
     选区本来就落在快照那一处时也不重设（见上面两个判据）。 */
  function restoreEditFocus(snap) {
    if (!snap) return false;
    const cur = typeof document !== "undefined" ? document.activeElement : null;
    if (cur && cur !== snap.el && surfaceKey(cur) && surfaceKey(cur) !== snap.key) return false;
    let el = snap.el && snap.el.isConnected !== false && surfaceKey(snap.el) === snap.key ? snap.el : null;
    if (!el) el = findSurface(snap.key, snap.nodeId);
    if (!el || typeof el.focus !== "function") return false;
    try {
      if (cur !== el) el.focus({ preventScroll: true });
    } catch (_) {
      try {
        el.focus();
      } catch (_) {
        return false;
      }
    }
    try {
      if (!snap.rich && snap.start != null && typeof el.setSelectionRange === "function") {
        if (!textareaCaretSame(el, snap)) el.setSelectionRange(snap.start, snap.end);
      } else if (snap.rich && snap.start != null && el.isContentEditable && !richCaretSame(el, snap)) {
        const a = richNodeAtOffset(el, snap.start);
        const b = richNodeAtOffset(el, snap.end == null ? snap.start : snap.end);
        const sel = window.getSelection();
        if (a && b && sel) {
          const r = document.createRange();
          r.setStart(a.node, a.offset);
          r.setEnd(b.node, b.offset);
          sel.removeAllRanges();
          sel.addRange(r);
        }
      }
    } catch (_) {}
    try {
      if (snap.scrollTop) el.scrollTop = snap.scrollTop;
      if (snap.scrollLeft) el.scrollLeft = snap.scrollLeft;
    } catch (_) {}
    return true;
  }
  /* 落盘路径的统一包法：跑完（抛错也算）把编辑面的焦点 / 光标 / 滚动放回原样。
     没有编辑面在焦点里时它是个零成本直通（快照为 null）。 */
  function keepEditFocus(fn) {
    const snap = captureEditFocus();
    try {
      return typeof fn === "function" ? fn() : undefined;
    } finally {
      if (snap) {
        try {
          restoreEditFocus(snap);
        } catch (_) {}
      }
    }
  }

  const api = {
    tabRich,
    shiftTabRich,
    tabSource,
    shiftTabSource,
    onPasteRich,
    bindRich,
    bindSource,
    /* 「保存不夺焦」四件套：surfaceKey（判据）/ captureEditFocus / restoreEditFocus / keepEditFocus */
    surfaceKey,
    captureEditFocus,
    restoreEditFocus,
    keepEditFocus,
    SURFACES,
    /* 只读探针（冒烟测试用）：看「当前选区里认到了哪些块」，
       不暴露任何写入口 —— 改 DOM 仍然只走 tabRich / tabSource。 */
    _probe: {
      blocksInRange,
      BLOCK_SEL,
      INDENT,
    },
  };
  try {
    window.MTMdEdit = api;
  } catch (_) {}
  try {
    if (typeof globalThis !== "undefined") globalThis.MTMdEdit = api;
  } catch (_) {}
})();
