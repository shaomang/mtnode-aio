"use strict";
/* ============================================================================
 * 应用窗口 · 左下角作者标签（renderer/app-author-ui.js）
 * ----------------------------------------------------------------------------
 * 需求：应用开发里加一枚作者标签 —— 平时**隐藏**，鼠标 hover 时显示「@作者 - v版本」
 * （如 @ms2308 - v1.0.1），**再点一下**弹出「应用详情」。默认开启，与语音转录（听写条）
 * 同一条机制：固化在应用里、可按 app.json 的 capabilities 启用 / 禁用 —— 那一套的闸门在
 * preload-app.js（宿主只在 capabilities.showAuthor 为真时才注入本模块）。
 *
 * 为什么由宿主注入：应用是用户自己的页面（下载来的只有一份 index.html，没人会回去改它），
 * 这枚标签必须对任何声明了它的应用都自动出现。注入脚本与 preload 分处两个 JS 世界，所以
 * 数据来源按顺序取：
 *   ① window.__mtnodeAuthorTag（preload 在注入前放好的同一份纯值清单）
 *   ② window.appHost.authorTag()（老宿主 / 页面自己调时的兜底，主进程现算一份）
 * 两份都拿不到 → 整块不出现（应用照常跑，绝不留半截 UI）。
 * 名字与版本缺任一个也不出现（主进程的 authorTagOf 已按这条判过一遍）。
 *
 * 界面（左下角一枚小标签 + 一只详情浮层）：
 *   @ms2308 - v1.0.1    平时 opacity:0（不写 display:none —— 那样根本没有 hover 可触发）；
 *                       hover / 键盘聚焦即显现；点击 → 只读「应用详情」面板。
 *   详情面板：图标 / 标题 / 应用 id / 作者 / 版本 / 说明 / 标签 / 数据目录（只读，没有编辑入口），
 *             关闭只有两条路：面板上的 ✕ 与 Esc（本仓纪律：浮层不做「点外部即关」）。
 *
 * 配色纪律：全部取应用**自己当前主题**的变量（--bg/--fg/--muted/--accent/--line…，与宿主注入的
 * 听写条 renderer/app-speech-ui.js 同一份 palette 口径），缺变量时退回页面上算出来的实际颜色 ——
 * 深浅底的应用都不会被塞进一块突兀的方块。
 *
 * 位置纪律：贴视口左下角（position:fixed）。落在**应用自己的 footer 里**就没这问题，所以挂载后
 * 复核一次：与听写条（#mtnode-dictate / #mtnode-dictate-bar）重叠就把标签抬到它上面一行。
 * ==========================================================================*/

(function () {
  /** 视口左下角的两个偏移（标签贴着它，平时 invisible 也不占布局） */
  var PAD_X = 10;
  var PAD_Y = 8;
  /** 抬到听写条之上时用的偏移 */
  var LIFT_Y = 42;

  var root = null; /* 那枚标签 */
  var panel = null; /* 详情面板 */
  var info = null; /* 宿主给的清单摘要 {name, version, id, title, description, tags, icon, dataDir} */
  var host = null;
  var styleEl = null;
  var escKeyHooked = false;

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
    var css = document.createElement("style");
    css.id = "mtnode-author-css";
    css.textContent =
      /* 标签本体：平时 opacity:0（**不写 display:none**：那样连 hover 都触发不了），
         hover / 键盘聚焦 / 详情开着时显现；pointer-events 只在聚焦态保持，平时让开点击。 */
      ".mtn-author{position:fixed;left:" + PAD_X + "px;bottom:" + PAD_Y + "px;z-index:12560;" +
      "max-width:min(60vw,420px);display:inline-flex;align-items:center;gap:6px;padding:2px 9px;" +
      "border:1px solid " + p.line + ";border-radius:999px;background:" + p.bg + ";color:" + p.muted + ";" +
      "font:" + p.font + ";font-size:.92em;line-height:1.5;letter-spacing:.2px;cursor:pointer;" +
      "opacity:0;transition:opacity .14s ease;user-select:none;white-space:nowrap;overflow:hidden;" +
      "text-overflow:ellipsis}" +
      ".mtn-author:hover,.mtn-author:focus-visible,.mtn-author.is-on{opacity:1;" +
      "border-color:" + p.accent + ";color:" + p.fg + "}" +
      ".mtn-author:focus{outline:none}" +
      ".mtn-author::before{content:'';width:6px;height:6px;border-radius:50%;" +
      "background:" + p.accent + ";opacity:.85;flex:0 0 auto}" +
      /* 详情面板：只读清单；浮层不做「点外部即关」（本仓纪律），出口只有 ✕ 与 Esc */
      ".mtn-author-panel{position:fixed;left:" + PAD_X + "px;bottom:" + (PAD_Y + 30) + "px;z-index:12570;" +
      "width:min(360px,92vw);max-height:min(70vh,520px);display:flex;flex-direction:column;" +
      "border:1px solid " + p.line + ";border-radius:12px;background:" + p.bg + ";color:" + p.fg + ";" +
      "box-shadow:0 14px 44px rgba(0,0,0,.45);font:" + p.font + "}" +
      ".mtn-author-panel[hidden]{display:none}" +
      ".mtn-author-ph{display:flex;align-items:center;gap:8px;padding:9px 11px;border-bottom:1px solid " + p.line + "}" +
      ".mtn-author-ph b{font-weight:600}" +
      ".mtn-author-x{margin-left:auto;border:0;background:transparent;color:inherit;cursor:pointer;" +
      "font:inherit;opacity:.75;padding:2px 4px}" +
      ".mtn-author-x:hover{opacity:1;color:" + p.accent + "}" +
      ".mtn-author-body{padding:10px 11px;overflow:auto;display:flex;flex-direction:column;gap:9px}" +
      ".mtn-author-id{display:flex;align-items:center;gap:10px}" +
      ".mtn-author-ico{width:38px;height:38px;border-radius:9px;object-fit:cover;flex:0 0 auto;" +
      "border:1px solid " + p.line + "}" +
      ".mtn-author-ico.ph{display:flex;align-items:center;justify-content:center;font-size:17px;" +
      "background:transparent;color:" + p.accent + "}" +
      ".mtn-author-name{font-weight:600;font-size:1.06em;word-break:break-word}" +
      ".mtn-author-sub{color:" + p.muted + ";font-size:.9em;word-break:break-all}" +
      ".mtn-author-row{display:flex;gap:8px;font-size:.94em}" +
      ".mtn-author-k{flex:0 0 62px;color:" + p.muted + "}" +
      ".mtn-author-v{flex:1 1 auto;min-width:0;word-break:break-word;white-space:pre-wrap}" +
      ".mtn-author-tags{display:flex;flex-wrap:wrap;gap:5px}" +
      ".mtn-author-tag{border:1px solid " + p.line + ";border-radius:999px;padding:1px 8px;" +
      "font-size:.86em;color:" + p.muted + "}" +
      /* 隐藏态兜底（只有应用自己调 apAuthorHide() 之后才会命中）：!important 压过 :hover，
         且**不写内联样式** —— 内联的 opacity 会永久压住 :hover，用户就再也 hover 不出来了。
         选择器带上 id 才与上面的 :hover 规则同权重（同为 0,2,1），靠**后出现**取胜。 */
      "#mtnode-author[data-mtnode-hidden='1']{opacity:0 !important;pointer-events:none !important}";
    (document.head || document.documentElement).appendChild(css);
    styleEl = css;
    return css;
  }

  /* ── 标签文案：`@作者 - v版本`（两边缺任一个 → 不注入、也不显示，见 mount 的判据）── */
  function label(d) {
    var who = String((d && d.name) || "").trim();
    var ver = String((d && d.version) || "").trim();
    if (!who || !ver) return "";
    return "@" + who + " - v" + ver;
  }

  /* ── 位置复核：与宿主注入的听写条重叠就抬到它上面一行 ────────────────────── */
  function rectOf(el) {
    try {
      return el && el.getBoundingClientRect ? el.getBoundingClientRect() : null;
    } catch (_) {
      return null;
    }
  }
  function overlaps(a, b) {
    if (!a || !b) return false;
    if (!a.width || !a.height || !b.width || !b.height) return false;
    return !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom);
  }
  function place() {
    if (!root || !root.style) return false;
    var lift = false;
    try {
      /* ① 左下角角落区（听写条注入模块建的 #mtnode-dictate-zone，里面就是那枚浮动话筒）：
         本轮需求加了这枚常驻按钮，它与作者标签共用同一个角，所以标签排在**整列之上**
         （用容器的实际顶边算，不猜高度）。容器不在 = 听写条没注入 = 与从前一样贴角。 */
      var z = document.getElementById("mtnode-dictate-zone");
      var zr = rectOf(z);
      if (zr && zr.height) {
        root.style.bottom = Math.max(PAD_Y, Math.round(window.innerHeight - zr.top + 6)) + "px";
        return true;
      }
      /* ② 没有角落区（老宿主 / 只注入了作者标签）：退回「与听写条重叠就抬一行」的老口径 */
      var bars = [document.getElementById("mtnode-dictate"), document.getElementById("mtnode-dictate-bar")];
      var mine = rectOf(root);
      for (var i = 0; i < bars.length; i++) {
        var b = bars[i];
        if (!b || b === root) continue;
        var cs = null;
        try {
          cs = getComputedStyle(b);
        } catch (_) {}
        if (cs && (cs.display === "none" || cs.visibility === "hidden")) continue;
        if (overlaps(mine, rectOf(b))) {
          lift = true;
          break;
        }
      }
    } catch (_) {}
    root.style.bottom = (lift ? LIFT_Y : PAD_Y) + "px";
    return lift;
  }
  function hookResize() {
    try {
      window.addEventListener("resize", function () {
        try {
          place();
        } catch (_) {}
      });
      /* 左下角角落区（#mtnode-dictate-zone，听写条注入模块建的）每次挂上 / 挪位都广播一次：
         标签据此立刻重排到它上面一行，不用等下一次窗口尺寸变化 */
      window.addEventListener("mtnode-dictate-zone", function () {
        try {
          place();
        } catch (_) {}
      });
    } catch (_) {}
    /* 应用页几乎都是「先出壳、内容后到」：听写条也可能晚一步才落到底栏，所以延后复核几次 */
    [0, 300, 1200].forEach(function (ms) {
      setTimeout(function () {
        try {
          place();
        } catch (_) {}
      }, ms);
    });
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
  function showPanel() {
    var el = panelEl();
    if (!el) return false;
    el.hidden = false;
    if (root) root.classList.add("is-on");
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

  /* ── 可见性（与听写条同一套标记口径：data-mtnode-hidden="1" + CSS !important 兜底）────────
   * 这里的「平时隐藏」是**默认态**：opacity:0（CSS 里那条 .mtn-author），鼠标 hover 即显现 ——
   * 那条规则**不经过内联样式**，因为内联样式会压过 :hover（一旦写死内联 opacity:0，用户再怎么
   * hover 都看不见）。所以「藏起来」只走两件事：
   *   ① 打标记 data-mtnode-hidden="1"（脚本 / 冒烟认它）；
   *   ② CSS #mtnode-author[data-mtnode-hidden='1']{opacity:0!important;pointer-events:none!important} 兜底。
   * reveal() 把标记摘掉并清掉内联残留，回到「平时隐藏、hover 显现」的默认态。两个方向都幂等。
   * 与听写条不同的是它不占用布局（position:fixed），所以不需要「装不下就搬家」那一套。 */
  var HIDDEN_ATTR = "data-mtnode-hidden";
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
      /* 详情开着时被藏起来：把面板一起收掉（否则面板飘着、is-on 也把标签顶成可见态） */
      if (panelOpen()) hidePanel();
      n.classList.remove("is-on");
      /* 清掉可能存在的内联透明度：隐藏由标记 + CSS 负责，内联一旦写上就再也 hover 不出来了 */
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
  /* ── 数据来源：① preload 放好的纯值 ② 桥上的 authorTag() ─────────────────── */
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
   *  名字或版本缺任一个 → 不挂（整枚标签不出现）。 */
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
    /* 默认态：不动内联样式 —— 「平时隐藏」由 CSS 的 .mtn-author{opacity:0} 负责，hover 那条规则
       才能生效（写死内联 opacity 就再也 hover 不出来了，见 HIDDEN_ATTR 那一段注释） */
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
    return true;
  }
  function hide() {
    if (!root) return false;
    hidePanel();
    markHidden(root);
    return true;
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
    window.apAuthorPlace = place;
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
