"use strict";
/* ============================================================================
 * 应用窗口 · footer 里的作者 / 版本按钮（renderer/app-author-ui.js）
 * ----------------------------------------------------------------------------
 * 需求（2026-02 二轮，用户原话）：「作者和版本按钮不要浮空，直接固化在 footer 即可」，
 * 并且「应用在画布中打开（dock 状态）应当与独立窗口时一致」。
 * 于是本模块的落点从「贴视口左下角的浮空小标签」改成**常驻在应用 footer 里的一枚按钮**：
 *   · 位置：与听写条（renderer/app-speech-ui.js）**同一个宿主** —— 它挑好 footer 时就跟进
 *     同一个 footer（紧跟 footer 里那枚小话筒后面）；它自己都没落地时，退回应用自己的
 *     <footer>；应用压根没有 footer（或 footer 在视口外被裁掉）时，退到宿主自建的那条
 *     固定底栏（与听写条共用一个宿主，绝不叠第二条）。
 *   · 样式：一行小圆角 chip，`@作者 - v版本`；平时就是 footer 里的一行元信息（不再
 *     opacity:0 藏起来等人 hover —— 藏起来的东西没人找得到）。点一下弹只读「应用详情」。
 *   · 两套宿主一致：独立窗口由 preload-app.js 注入本模块；画布内的应用节点 / 开发页预览
 *     是 mtnode-preview:// 的 iframe，由 apps-store.js 的 iframeAppUiSource 把本模块连同
 *     清单（window.__mtnodeAuthorTag）一起内联进去 —— 同一个能力位 showAuthor 控闸门。
 *
 * 数据来源按顺序取：
 *   ① window.__mtnodeAuthorTag（宿主在注入前放好的纯值清单：独立窗口来自 preload，iframe
 *      来自 apps-store.js 按 authorTagOf 算好的那一份）
 *   ② window.appHost.authorTag()（老宿主 / 页面自己调时的兜底，主进程现算一份）
 * 两份都拿不到 → 整块不出现（应用照常跑，绝不留半截 UI）。
 * 名字与版本缺任一个也不出现（主进程的 authorTagOf 已按这条判过一遍）。
 *
 * 详情面板：图标 / 标题 / 应用 id / 作者 / 版本 / 说明 / 标签 / 数据目录（只读），
 *   关闭只有两条路：面板上的 ✕ 与 Esc（本仓纪律：浮层不做「点外部即关」）。
 *   它是**浮层**（position:fixed，贴着那枚按钮往上弹），按钮本身不再浮空。
 *
 * 配色纪律：全部取应用**自己当前主题**的变量（--bg/--fg/--muted/--accent/--line…，与宿主注入的
 * 听写条 renderer/app-speech-ui.js 同一份 palette 口径），缺变量时退回页面上算出来的实际颜色 ——
 * 深浅底的应用都不会被塞进一块突兀的方块。
 * ==========================================================================*/

(function () {
  /** 面板贴角的兜底偏移（量不到按钮位置时用） */
  var PAD_X = 10;
  var PAD_Y = 8;
  /** 应用自己的 footer 候选（与听写条同一份选择器口径） */
  var FOOT_SELS = ["footer", ".app-foot", ".foot", "#appFoot"];
  var HIDDEN_ATTR = "data-mtnode-hidden";

  var root = null; /* 那枚按钮 */
  var panel = null; /* 详情面板 */
  var info = null; /* 宿主给的清单摘要 {name, version, id, title, description, tags, icon, dataDir} */
  var host = null;
  var styleEl = null;
  var escKeyHooked = false;

  var footEl = null; /* 应用自己的 footer（找到才用） */
  var barEl = null; /* 宿主自建的固定底栏（没有 footer / footer 装不下时的落点） */
  var placedIn = ""; /* "footer" | "bar" */
  var missCount = 0; /* 连续量到「在 footer 里看不见」的次数（连中两次才搬走） */
  var resizeHooked = false;

  /* ── 语言与文案：跟宿主界面语言（preload 把 --mtnode-lang 塞进 documentElement.lang）── */
  function zh() {
    try {
      var l = String(document.documentElement.getAttribute("lang") || "").toLowerCase();
      if (l.indexOf("zh") === 0) return true;
      if (l.indexOf("en") === 0) return false;
    } catch (_) {}
    try {
      return /^zh/i.test(String(navigator.language || ""));
    } catch (_) {
      return true;
    }
  }
  function t(zhText, enText) {
    return zh() ? zhText : enText || zhText;
  }

  /* ── 主题变量（与 app-speech-ui.js 的 palette 同源；缺变量退回算出来的实际颜色）── */
  function computed(el, prop, fallback) {
    try {
      var v = getComputedStyle(el).getPropertyValue(prop);
      v = String(v || "").trim();
      return v || fallback;
    } catch (_) {
      return fallback;
    }
  }
  function readVar(name) {
    try {
      var v = getComputedStyle(document.documentElement).getPropertyValue(name);
      return String(v || "").trim();
    } catch (_) {
      return "";
    }
  }
  function palette() {
    var body = document.body || document.documentElement;
    var bg = readVar("--bg") || readVar("--panel") || computed(body, "background-color", "#14171c");
    var fg = readVar("--fg") || readVar("--text") || computed(body, "color", "#e6e8eb");
    return {
      bg: bg,
      fg: fg,
      muted: readVar("--muted") || readVar("--fg-dim") || computed(body, "color", fg),
      accent: readVar("--accent") || readVar("--accent-dim") || "#8ab4ff",
      line: readVar("--line") || readVar("--border") || "rgba(127,127,127,.35)",
      font: computed(body, "font", "13px system-ui"),
    };
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  /* 宿主给的值一律当不可信文本画（textContent / esc），不拼进 HTML 属性以外的地方 */
  function text(el, s) {
    if (el) el.textContent = String(s == null ? "" : s);
    return el;
  }

  /* ── 样式：一次注入，全部走应用主题变量 ─────────────────────────────────── */
  function styleTag() {
    if (styleEl && styleEl.parentElement) return styleEl;
    var p = palette();
    /* 与听写条同一条纪律：颜色写成 CSS 变量引用（实算色值只当兜底）。应用常在宿主注入之后才换肤，
       色值算死就会出现「浅档配深字 / 深档配浅字」，footer 里那枚标签糊在底上。 */
    var vx = function (name, fallback) { return "var(" + name + ", " + fallback + ")"; };
    var FG = vx("--fg", vx("--ink", p.fg));
    var DIM = vx("--fg-dim", vx("--muted", vx("--ink-2", p.muted)));
    var LINE = vx("--line", vx("--border", p.line));
    var ACCENT = vx("--accent", vx("--accent-dim", p.accent));
    var BG = vx("--bg", vx("--panel", p.bg));
    var css = document.createElement("style");
    css.id = "mtnode-author-css";
    css.textContent =
      /* 按钮本体：footer 里的一枚**内联** chip（不定位、不浮空、不占视口角落）。
         默认就是可见的元信息（opacity .75），hover / 聚焦时提亮 —— 「不要浮空」
         的反面不是「藏起来」，藏起来的东西在 footer 里没人找得到。 */
      ".mtn-author{display:inline-flex;align-items:center;gap:6px;padding:1px 9px;margin:0 0 0 8px;" +
      "border:1px solid " + LINE + ";border-radius:999px;background:transparent;color:" + FG + ";" +
      "font:" + p.font + ";font-size:.88em;line-height:1.6;letter-spacing:.2px;cursor:pointer;" +
      "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:min(60vw,420px);" +
      "flex:0 0 auto;vertical-align:middle;user-select:none;opacity:.75;" +
      "transition:opacity .14s ease,color .14s ease,border-color .14s ease}" +
      ".mtn-author:hover,.mtn-author:focus-visible,.mtn-author.is-on{opacity:1;" +
      "border-color:" + ACCENT + ";color:" + FG + "}" +
      ".mtn-author:focus{outline:none}" +
      ".mtn-author::before{content:'';width:6px;height:6px;border-radius:50%;" +
      "background:" + ACCENT + ";opacity:.85;flex:0 0 auto}" +
      /* 详情面板：只读清单；浮层不做「点外部即关」（本仓纪律），出口只有 ✕ 与 Esc。
         left / bottom 由 placePanel() 按按钮的实际位置写内联（贴着 footer 往上弹）。 */
      ".mtn-author-panel{position:fixed;left:" + PAD_X + "px;bottom:" + (PAD_Y + 30) + "px;z-index:12570;" +
      "width:min(360px,92vw);max-height:min(70vh,520px);display:flex;flex-direction:column;" +
      "border:1px solid " + LINE + ";border-radius:12px;background:" + BG + ";color:" + FG + ";" +
      "box-shadow:0 14px 44px rgba(0,0,0,.45);font:" + p.font + "}" +
      ".mtn-author-panel[hidden]{display:none}" +
      ".mtn-author-ph{display:flex;align-items:center;gap:8px;padding:9px 11px;border-bottom:1px solid " + LINE + "}" +
      ".mtn-author-ph b{font-weight:600}" +
      ".mtn-author-x{margin-left:auto;border:0;background:transparent;color:inherit;cursor:pointer;" +
      "font:inherit;opacity:.75;padding:2px 4px}" +
      ".mtn-author-x:hover{opacity:1;color:" + ACCENT + "}" +
      ".mtn-author-body{padding:10px 11px;overflow:auto;display:flex;flex-direction:column;gap:9px}" +
      ".mtn-author-id{display:flex;align-items:center;gap:10px}" +
      ".mtn-author-ico{width:38px;height:38px;border-radius:9px;object-fit:cover;flex:0 0 auto;" +
      "border:1px solid " + LINE + "}" +
      ".mtn-author-ico.ph{display:flex;align-items:center;justify-content:center;font-size:17px;" +
      "background:transparent;color:" + ACCENT + "}" +
      ".mtn-author-name{font-weight:600;font-size:1.06em;word-break:break-word}" +
      ".mtn-author-sub{color:" + DIM + ";font-size:.9em;word-break:break-all}" +
      ".mtn-author-row{display:flex;gap:8px;font-size:.94em}" +
      ".mtn-author-k{flex:0 0 62px;color:" + DIM + "}" +
      ".mtn-author-v{flex:1 1 auto;min-width:0;word-break:break-word;white-space:pre-wrap}" +
      ".mtn-author-tags{display:flex;flex-wrap:wrap;gap:5px}" +
      ".mtn-author-tag{border:1px solid " + LINE + ";border-radius:999px;padding:1px 8px;" +
      "font-size:.86em;color:" + DIM + "}" +
      /* 隐藏态兜底（只有应用自己调 apAuthorHide() 之后才会命中）：它现在是 footer 里的一行，
         藏起来就用 display:none（不像从前那个浮空标签还得留着 hover 的余地）。 */
      "#mtnode-author[data-mtnode-hidden='1']{display:none !important}";
    (document.head || document.documentElement).appendChild(css);
    styleEl = css;
    return css;
  }

  /* ── 文案：`@作者 - v版本`（两边缺任一个 → 不注入、也不显示，见 mount 的判据）── */
  function label(d) {
    var who = String((d && d.name) || "").trim();
    var ver = String((d && d.version) || "").trim();
    if (!who || !ver) return "";
    return "@" + who + " - v" + ver;
  }

  /* ── 落点：footer 优先（与听写条同一个宿主），装不下 / 没有 footer 才用宿主底栏 ────── */
  function rectOf(el) {
    try {
      return el && el.getBoundingClientRect ? el.getBoundingClientRect() : null;
    } catch (_) {
      return null;
    }
  }
  function cssOf(el, prop) {
    try {
      var cs = getComputedStyle(el);
      var v = cs && cs.getPropertyValue ? cs.getPropertyValue(prop) : "";
      v = String(v || "").trim();
      return v || String((cs && cs[prop]) || "");
    } catch (_) {
      return "";
    }
  }
  /** 这一枚现在真的看得见吗（量不出来就当看得见：量不了几何不是「装不下」的证据） */
  function visibleNow(el) {
    if (hiddenNow(el)) return false;
    var r = rectOf(el);
    if (!r) return true;
    if (!r.width && !r.height) return false; /* display:none / 折叠 */
    var vh = 0;
    try {
      vh = Number(window.innerHeight || 0);
    } catch (_) {}
    if (vh && (r.bottom > vh + 1 || r.top < -1)) return false;
    var p = el.parentElement;
    var guard = 0;
    while (p && guard++ < 40) {
      if (cssOf(p, "display") === "none" || cssOf(p, "visibility") === "hidden") return false;
      if (/(hidden|clip|auto|scroll)/.test(cssOf(p, "overflow-y") || cssOf(p, "overflow"))) {
        var pr = rectOf(p);
        if (pr && r.width && (r.bottom > pr.bottom + 1 || r.top < pr.top - 1)) return false;
      }
      p = p.parentElement;
    }
    return true;
  }
  /** 听写条落好的那个宿主（footer 或它自建的固定底栏）：作者按钮跟着它走，
   *  于是两枚 footer 元素永远在同一行、同一个容器里。 */
  function dictateHost() {
    var z = document.getElementById("mtnode-dictate-zone");
    if (!z) return null;
    var p = z.parentElement;
    if (!p) return null;
    return { host: p, after: z };
  }
  /** 应用自己的 footer（与听写条同一份选择器；跳过宿主自建的那两条底栏） */
  function findFooter() {
    for (var i = 0; i < FOOT_SELS.length; i++) {
      var el = null;
      try {
        el = document.querySelector(FOOT_SELS[i]);
      } catch (_) {
        el = null;
      }
      if (!el) continue;
      var id = String(el.id || "");
      if (id === "mtnode-author-bar" || id === "mtnode-dictate-bar") continue;
      return el;
    }
    return null;
  }
  /** 宿主自建的固定底栏：footer 不存在 / 装不下时用它。听写条已经拉过一条就借它，
   *  绝不在同一个位置叠第二条底栏。 */
  function barHost() {
    var shared = document.getElementById("mtnode-dictate-bar");
    if (shared) return shared;
    if (barEl && barEl.parentElement) return barEl;
    var p = palette();
    var bar = document.createElement("div");
    bar.id = "mtnode-author-bar";
    bar.style.cssText =
      "position:fixed;left:0;right:0;bottom:0;z-index:12550;display:flex;align-items:center;" +
      "justify-content:flex-end;gap:10px;padding:3px 12px;border-top:1px solid " +
      "var(--line, " + p.line + ")" +
      ";background:" +
      "var(--bg, " + p.bg + ")" +
      ";color:" +
      "var(--fg, " + p.fg + ")" +
      ";font:" +
      p.font;
    (document.body || document.documentElement).appendChild(bar);
    barEl = bar;
    return bar;
  }
  /** 底栏空了就收掉：不留一条空的固定底栏压着应用内容 */
  function dropEmptyBar() {
    if (barEl && !barEl.childNodes.length && barEl.parentElement) {
      barEl.parentElement.removeChild(barEl);
      barEl = null;
    }
  }
  /** 落进宿主后按宿主布局微调外边距：flex / grid 容器里推到行尾（footer 右侧的元信息），
   *  普通块级 footer 里就按自然流排，不动它原有的排版。 */
  function fitChip(hostEl) {
    if (!root || !root.style) return;
    var d = cssOf(hostEl, "display");
    root.style.marginLeft = /flex|grid/.test(d) ? "auto" : "8px";
  }
  function mountInto(hostEl, after) {
    if (!hostEl) return false;
    var ok = false;
    try {
      if (after && after.parentElement === hostEl) {
        if (root.parentElement !== hostEl || root.previousSibling !== after) {
          hostEl.insertBefore(root, after.nextSibling);
        }
        ok = true;
      } else {
        if (root.parentElement !== hostEl) hostEl.appendChild(root);
        ok = true;
      }
    } catch (_) {
      try {
        hostEl.appendChild(root);
        ok = true;
      } catch (__) {
        ok = false;
      }
    }
    if (ok) fitChip(hostEl);
    return ok;
  }
  /** 落位（幂等，可反复调）。
   *  opts.allowReturn = true（只在窗口尺寸真的变了时用）：允许从宿主底栏搬回应用 footer 再量一次；
   *  默认只允许「footer → 底栏」单向，免得来回弹。 */
  function place(opts) {
    if (!root) return false;
    var allowReturn = !!(opts && opts.allowReturn);
    /* ① 听写条的宿主：它已经替我们判过「footer 装不装得下」，直接跟进去（同一行） */
    var dz = dictateHost();
    if (dz) {
      mountInto(dz.host, dz.after);
      placedIn = "footer";
      missCount = 0;
      dropEmptyBar();
      return true;
    }
    /* ② 应用自己的 footer：装得下就留在这儿 */
    if (footEl && !footEl.parentElement) footEl = null;
    if (!footEl) footEl = findFooter();
    if (footEl) {
      if (root.parentElement !== footEl && (allowReturn || placedIn !== "bar")) mountInto(footEl, null);
      if (root.parentElement === footEl) {
        if (visibleNow(root)) {
          placedIn = "footer";
          missCount = 0;
          dropEmptyBar();
          return true;
        }
        /* 要连中两次才搬：应用页中途会有那么一瞬量出来在视口外，为一次瞬时测量就搬走属于过度反应 */
        missCount++;
        if (!allowReturn && missCount < 2) return true;
      }
    }
    /* ③ 应用压根没有 footer（或 footer 在视口外被裁掉）：宿主自建的固定底栏 */
    mountInto(barHost(), null);
    placedIn = "bar";
    missCount = 0;
    return true;
  }
  /* ── 详情面板（只读）──────────────────────────────────────────────────── */
  function row(k, v) {
    var s = String(v == null ? "" : v).trim();
    if (!s) return null;
    var r = document.createElement("div");
    r.className = "mtn-author-row";
    var kk = document.createElement("span");
    kk.className = "mtn-author-k";
    text(kk, k);
    var vv = document.createElement("span");
    vv.className = "mtn-author-v";
    text(vv, s);
    r.appendChild(kk);
    r.appendChild(vv);
    return r;
  }
  function panelEl() {
    if (panel && panel.parentElement) return panel;
    var d = info || {};
    panel = document.createElement("div");
    panel.className = "mtn-author-panel";
    panel.id = "mtnode-author-panel";
    panel.hidden = true;
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", t("应用详情", "App details"));

    var head = document.createElement("div");
    head.className = "mtn-author-ph";
    var title = document.createElement("b");
    text(title, t("应用详情", "App details"));
    var x = document.createElement("button");
    x.type = "button";
    x.className = "mtn-author-x";
    x.setAttribute("data-act", "close");
    x.setAttribute("title", t("关闭", "Close"));
    x.setAttribute("aria-label", t("关闭", "Close"));
    text(x, "✕");
    x.addEventListener("click", function () {
      hidePanel();
    });
    head.appendChild(title);
    head.appendChild(x);

    var body = document.createElement("div");
    body.className = "mtn-author-body";
    /* ① 图标 + 标题 + 应用 id：图标是宿主读成 data URL 给过来的（读不到就画个占位方块） */
    var idRow = document.createElement("div");
    idRow.className = "mtn-author-id";
    if (d.icon) {
      var img = document.createElement("img");
      img.className = "mtn-author-ico";
      img.alt = "";
      img.src = String(d.icon);
      idRow.appendChild(img);
    } else {
      var ph = document.createElement("div");
      ph.className = "mtn-author-ico ph";
      text(ph, "▣");
      idRow.appendChild(ph);
    }
    var nm = document.createElement("div");
    var n1 = document.createElement("div");
    n1.className = "mtn-author-name";
    text(n1, String(d.title || d.id || ""));
    var n2 = document.createElement("div");
    n2.className = "mtn-author-sub";
    text(n2, String(d.id || ""));
    nm.appendChild(n1);
    nm.appendChild(n2);
    idRow.appendChild(nm);
    body.appendChild(idRow);
    /* ② 作者 / 版本 / 说明：缺项的行不画（不写「未知作者」那类占位字） */
    var rows = [
      row(t("作者", "Author"), "@" + String(d.name || "")),
      row(t("版本", "Version"), "v" + String(d.version || "")),
      row(t("说明", "Description"), d.description),
      row(t("数据目录", "Data folder"), d.dataDir),
    ];
    rows.forEach(function (r) {
      if (r) body.appendChild(r);
    });
    /* ③ 标签：一排小圆角（没有就不画这一块） */
    var tags = Array.isArray(d.tags) ? d.tags.filter(Boolean) : [];
    if (tags.length) {
      var tr = document.createElement("div");
      tr.className = "mtn-author-row";
      var tk = document.createElement("span");
      tk.className = "mtn-author-k";
      text(tk, t("标签", "Tags"));
      var tv = document.createElement("span");
      tv.className = "mtn-author-v mtn-author-tags";
      tags.forEach(function (s) {
        var b = document.createElement("span");
        b.className = "mtn-author-tag";
        text(b, s);
        tv.appendChild(b);
      });
      tr.appendChild(tk);
      tr.appendChild(tv);
      body.appendChild(tr);
    }
    panel.appendChild(head);
    panel.appendChild(body);
    (document.body || document.documentElement).appendChild(panel);
    return panel;
  }
  /** 面板贴着那枚按钮往上弹（按钮在 footer 里，位置可能随应用布局变） */
  function placePanel() {
    if (!panel || panel.hidden || !panel.style) return false;
    var r = rectOf(root);
    var vw = 0;
    var vh = 0;
    try {
      vw = Number(window.innerWidth || 0);
      vh = Number(window.innerHeight || 0);
    } catch (_) {}
    var left = r ? Math.round(r.left) : PAD_X;
    var bottom = r && vh ? Math.round(vh - r.top + 8) : PAD_Y + 30;
    /* 面板宽 min(360px,92vw)：别让它顶出右边界 */
    var maxLeft = vw ? Math.max(8, vw - (Math.min(360, Math.round(vw * 0.92)) + 8)) : left;
    panel.style.left = Math.max(8, Math.min(left, maxLeft)) + "px";
    panel.style.bottom = Math.max(8, bottom) + "px";
    return true;
  }
  function showPanel() {
    var el = panelEl();
    if (!el) return false;
    el.hidden = false;
    if (root) root.classList.add("is-on");
    placePanel();
    return true;
  }
  function hidePanel() {
    if (panel) panel.hidden = true;
    if (root) root.classList.remove("is-on");
    return true;
  }
  function panelOpen() {
    return !!(panel && !panel.hidden && panel.parentElement);
  }
  function togglePanel() {
    return panelOpen() ? hidePanel() : showPanel();
  }
  function hookEsc() {
    if (escKeyHooked) return;
    escKeyHooked = true;
    try {
      window.addEventListener("keydown", function (ev) {
        if (!ev || ev.key !== "Escape") return;
        if (!panelOpen()) return;
        hidePanel();
      });
    } catch (_) {}
  }

  /* ── 可见性（与听写条同一套标记口径：data-mtnode-hidden="1" + CSS !important 兜底）──
   * 与从前那个浮空标签的区别：它现在是 footer 里的一行，藏起来就是 display:none
   * （CSS 里那条 #mtnode-author[data-mtnode-hidden='1']），不需要再为 :hover 留余地。
   * 「平时可见」是默认态；hide() 只在应用自己主动调 apAuthorHide() 时命中。 */
  function hiddenNow(el) {
    var n = el || root;
    try {
      return !!(n && n.getAttribute && n.getAttribute(HIDDEN_ATTR) === "1");
    } catch (_) {
      return false;
    }
  }
  function markHidden(el) {
    var n = el || root;
    if (!n) return false;
    try {
      n.setAttribute(HIDDEN_ATTR, "1");
      /* 详情开着时被藏起来：把面板一起收掉（否则面板飘着、is-on 也把按钮顶成可见态） */
      if (panelOpen()) hidePanel();
      n.classList.remove("is-on");
      if (n.style) {
        n.style.opacity = "";
        n.style.pointerEvents = "";
      }
    } catch (_) {}
    return true;
  }
  function markShown(el) {
    var n = el || root;
    if (!n) return false;
    try {
      n.removeAttribute(HIDDEN_ATTR);
      if (n.style) {
        n.style.opacity = "";
        n.style.pointerEvents = "";
      }
    } catch (_) {}
    return true;
  }
  /* ── 数据来源：① 宿主放好的纯值 ② 桥上的 authorTag() ─────────────────── */
  function givenInfo() {
    try {
      var v = window.__mtnodeAuthorTag;
      if (v && typeof v === "object") return v;
    } catch (_) {}
    return null;
  }
  function relayedInfo() {
    try {
      var v = window.__mtnodeAuthorRelay;
      if (v && typeof v === "object") return v;
    } catch (_) {}
    return null;
  }
  function fetchInfo() {
    var have = fetchInfoSync();
    if (have) return Promise.resolve(have);
    var h = host || (typeof window !== "undefined" ? window.appHost : null) || null;
    if (!h || typeof h.authorTag !== "function") return Promise.resolve(null);
    try {
      return Promise.resolve(h.authorTag()).then(
        function (r) {
          return r && r.ok !== false && typeof r === "object" ? r : null;
        },
        function () {
          return null;
        },
      );
    } catch (_) {
      return Promise.resolve(null);
    }
  }

  /* ── 挂载 ─────────────────────────────────────────────────────────────── */
  /** 挂载。host 可省（自己读 window.appHost）；info 可省（读 __mtnodeAuthorTag / 桥上问）。
   *  名字或版本缺任一个 → 不挂（整枚按钮不出现）。 */
  function apAuthorMount(api, data) {
    host = api || (typeof window !== "undefined" ? window.appHost : null) || null;
    if (root || !document.body) return false;
    var d = data && typeof data === "object" ? data : null;
    if (!d) {
      d = fetchInfoSync();
      if (!d) return false;
    }
    if (!label(d)) return false;
    info = d;
    styleTag();
    root = document.createElement("div");
    root.className = "mtn-author";
    root.id = "mtnode-author";
    root.setAttribute("role", "button");
    root.setAttribute("tabindex", "0");
    var txt = label(d);
    text(root, txt);
    root.setAttribute("title", t("点一下看应用详情", "Click for app details"));
    root.setAttribute("aria-label", txt + " · " + t("应用详情", "app details"));
    root.addEventListener("click", function (ev) {
      if (ev && ev.preventDefault) ev.preventDefault();
      togglePanel();
    });
    root.addEventListener("keydown", function (ev) {
      if (!ev) return;
      if (ev.key === "Enter" || ev.key === " ") {
        if (ev.preventDefault) ev.preventDefault();
        togglePanel();
      }
    });
    /* 先挂进 body，再交给 place() 落到 footer（找不到落点时它就是底栏里的一行） */
    (document.body || document.documentElement).appendChild(root);
    /* 挂上了就认账：autoMount 的重试据此收手（显式调用 apAuthorMount 也算已挂） */
    try {
      window.apAuthorMounted = true;
    } catch (_) {}
    place();
    hookResize();
    hookEsc();
    return true;
  }
  /** 同步取一份现成的清单（挂载时不阻塞：桥是异步的，异步那条走 autoMount 的重试） */
  function fetchInfoSync() {
    return givenInfo() || relayedInfo() || null;
  }
  function reveal() {
    if (!root) return false;
    var d = info || fetchInfoSync();
    if (d) {
      info = d;
      var s = label(d);
      if (s) {
        text(root, s);
        root.setAttribute("title", t("点一下看应用详情", "Click for app details"));
      }
    }
    markShown(root);
    place({ allowReturn: true });
    return true;
  }
  function hide() {
    if (!root) return false;
    hidePanel();
    markHidden(root);
    dropEmptyBar();
    return true;
  }

  /* ── 落点复核：窗口尺寸 / 内容长高 / 听写条搬家时都重排一次 ───────────────── */
  function hookResize() {
    if (resizeHooked) return;
    resizeHooked = true;
    try {
      window.addEventListener("resize", function () {
        try {
          place({ allowReturn: true });
          placePanel();
        } catch (_) {}
      });
    } catch (_) {}
    /* 听写条把 footer 里那枚小话筒挂上 / 挪位时广播一次（见 app-speech-ui.js 的 tellZoneMoved） */
    try {
      window.addEventListener("mtnode-dictate-zone", function () {
        try {
          place({ allowReturn: true });
        } catch (_) {}
      });
    } catch (_) {}
    /* 应用页几乎都是「先出壳、内容后到」：footer 被内容顶下去是挂载之后才发生的，
       所以延后复核几次（没有 ResizeObserver 的老引擎也有救） */
    [0, 300, 1200, 2500].forEach(function (ms) {
      setTimeout(function () {
        try {
          place();
        } catch (_) {}
      }, ms);
    });
    try {
      if (window.ResizeObserver) {
        new ResizeObserver(function () {
          try {
            place();
          } catch (_) {}
        }).observe(document.body || document.documentElement);
      }
    } catch (_) {}
  }

  /* 宿主派发桥（注入脚本与 preload 分处两个世界时走这条兜底）：
     detail.host 是新桥；detail.author 是新清单（宿主直接把值塞进事件里） */
  try {
    window.addEventListener("mtnode-apphost", function (ev) {
      try {
        var d = ev && ev.detail ? ev.detail : null;
        if (d && d.author && typeof d.author === "object") {
          try {
            window.__mtnodeAuthorRelay = d.author;
          } catch (_) {}
        }
        if (!root && d && d.host) apAuthorMount(d.host, d.author || null);
        else if (root) place({ allowReturn: true });
      } catch (_) {}
    });
  } catch (_) {}

  try {
    window.apAuthorMount = apAuthorMount;
    window.apAuthorPanel = showPanel;
    window.apAuthorClose = hidePanel;
    window.apAuthorOpen = panelOpen;
    window.apAuthorHidden = hiddenNow;
    window.apAuthorReveal = reveal;
    window.apAuthorHide = hide;
    window.apAuthorPlace = function () {
      place();
      placePanel();
      return true;
    };
    window.apAuthorLabel = function () {
      return root ? String(root.textContent || "") : "";
    };
  } catch (_) {}

  /* 自挂载（默认路径）：注入脚本在页面世界里跑，window.__mtnodeAuthorTag 这时已经在了 —— 直接挂。
     极端时序下（宿主异步那条）再退避重试几次，最多 12 秒，绝不死循环。 */
  (function autoMount() {
    var tries = 0;
    var asked = false; /* 异步问桥只问一次（重试循环每 300ms 一次，别堆一串待决的 promise） */
    var tick = function () {
      if (window.apAuthorMounted) return;
      var ok = false;
      try {
        if (root) {
          window.apAuthorMounted = true;
          return;
        }
        ok = apAuthorMount();
      } catch (_) {}
      if (ok) {
        window.apAuthorMounted = true;
        return;
      }
      if (!asked && !fetchInfoSync()) {
        /* 清单还没到：异步问一次（桥上有 authorTag 时），回来再挂 */
        asked = true;
        fetchInfo().then(function (d) {
          if (window.apAuthorMounted || root) return;
          if (!d) return;
          try {
            if (apAuthorMount(null, d)) window.apAuthorMounted = true;
          } catch (_) {}
        });
      }
      if (tries++ < 40) setTimeout(tick, 300);
    };
    if (typeof document === "undefined") return;
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", tick, { once: true });
    else tick();
  })();
})();
