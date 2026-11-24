"use strict";
/* ============================================================================
 * 应用窗口 · 直接注入的顶栏（可拖动 + 关闭）（renderer/app-chrome-ui.js）
 * ----------------------------------------------------------------------------
 * 需求：无框窗口要能拖、能关。应用是用户自己的页面（下载来的常常只有一份 index.html，
 * 没人会回去补一句 -webkit-app-region:drag），所以由宿主补一条轻量顶栏。
 *
 * **只补空**：DOMContentLoaded 后扫 body 前 SCAN_MAX 个元素，只要有任何一个算出来的
 * -webkit-app-region 是 drag（模板 app-scaffold 的 header.app-head.drag、app-default 的
 * header.bar 这类），整条不注入 —— 绝不让页面变成两条标题栏 / 两个 ✕。挂上之后还会复核
 * 几次：页面自己晚一步长出可拖区，就把自己收掉。
 *
 * 界面：position:fixed 贴顶的一条（BAR_H = 30px），条体 drag；左侧写应用标题
 * （window.__mtnodeAuthorTag.title，缺则 document.title），右侧三颗 no-drag 的窗口按钮：
 * —  最小化（appHost.minimize）· □/❐ 最大化与还原（appHost.toggleMaximize，图标随状态换）
 * · ✕ 关闭（window.appHost.close）。后两颗与关闭同一道闸：桥上没有对应方法
 * （桥缺席 / 预览态 mtnode-preview:// 里没有 preload）就不画 —— 不假装能点。
 *
 * 自动让位：条体是浮层（半透明 + 轻微模糊），顶栏那 30px 由**宿主**替页面让出来 —— 挂上时往
 * documentElement 加 `.mtnode-chrome`、`--mtnode-chrome-h`，以及 mount 那一刻量到的 body 基线
 * `--mtnode-chrome-body-pt`，再由一条 `html.mtnode-chrome body{padding-top:max(基线,30px)}`
 * 抬起 body。**页面不要再自己加 padding-top**（max 保护：老页面自己写过 30px 也不会翻倍）；
 * 不注入的分支零副作用（不写变量、不加 class、不加任何 body 样式）。
 *
 * 残余限制：`#root{position:fixed;inset:0}` 这类定位满屏容器、以及页面自绘的 sticky / fixed
 * 贴顶 header，仍可能被这条浮层压住 —— body 的 padding-top 推不动它们。这类页面应自绘标题栏：
 * `capabilities.windowChrome:false` 或调 `window.__mtnodeWindowChrome.hide()`。
 *
 * 配色纪律：全部取应用**自己当前主题**的变量（--bg/--fg/--line，与作者标签
 * renderer/app-author-ui.js 同一份 palette 口径），缺变量时退回页面上算出来的实际颜色。
 * body 透明（无框窗口常见）时退回按前景亮度挑的那一条中性色，深浅底都不突兀。
 *
 * 应用自己收掉这条：window.__mtnodeWindowChrome = { hide(), show() }。
 * ==========================================================================*/

(function () {
  var BAR_H = 30; /* 条体高度（需求区间 28–32） */
  var SCAN_MAX = 24; /* 只扫 body 前 N 个元素：模板的可拖区一定在头上 */
  var ID = "mtnode-chrome";
  var CSS_ID = "mtnode-chrome-css";
  var CLASS = "mtnode-chrome";

  var bar = null;
  var styleEl = null;
  var maxBtn = null; /* 最大化 / 还原那颗（图标随窗口状态换） */
  var maxHooked = false; /* resize → 同步图标 只挂一次 */

  /* ── 语言与文案（跟宿主界面语言：preload 把 lang 写在 documentElement 上）── */
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

  /* ── 主题变量（与 app-author-ui.js 的 palette 同源；缺变量退回算出来的实际颜色）── */
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
      return String(getComputedStyle(document.documentElement).getPropertyValue(name) || "").trim();
    } catch (_) {
      return "";
    }
  }
  function palette() {
    var body = document.body || document.documentElement;
    return {
      bg: readVar("--bg") || readVar("--panel") || computed(body, "background-color", "#14171c"),
      fg: readVar("--fg") || readVar("--text") || computed(body, "color", "#e6e8eb"),
      line: readVar("--line") || readVar("--border") || "rgba(127,127,127,.35)",
    };
  }

  /* 颜色拆解：认 #rgb / #rrggbb(aa) / rgb(a)，认不出就返回 null（渐变、color-mix 之类） */
  function rgbOf(color) {
    var s = String(color == null ? "" : color).trim();
    var m = /^#([0-9a-f]{3,8})$/i.exec(s);
    if (m) {
      var h = m[1];
      if (h.length === 3 || h.length === 4) {
        h = h.split("").map(function (c) {
          return c + c;
        }).join("");
      }
      if (h.length !== 6 && h.length !== 8) return null;
      return {
        r: parseInt(h.slice(0, 2), 16),
        g: parseInt(h.slice(2, 4), 16),
        b: parseInt(h.slice(4, 6), 16),
        a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
      };
    }
    m = /^rgba?\(([^)]+)\)$/i.exec(s);
    if (m) {
      var p = m[1].split(/[,\s/]+/).filter(function (x) {
        return x !== "";
      });
      if (p.length < 3) return null;
      var n = p.map(parseFloat);
      return { r: n[0], g: n[1], b: n[2], a: p.length > 3 ? n[3] : 1 };
    }
    return null;
  }
  function alpha(color, a) {
    var c = rgbOf(color);
    /* 认不出的颜色原样用：宁可不半透明，也不凭空造一个跟页面不搭的颜色 */
    if (!c) return color;
    return "rgba(" + Math.round(c.r) + "," + Math.round(c.g) + "," + Math.round(c.b) + "," + a + ")";
  }
  function luma(color) {
    var c = rgbOf(color);
    if (!c) return null;
    return (0.299 * c.r + 0.587 * c.g + 0.114 * c.b) / 255;
  }
  /* 条体底色：正常就是页面 --bg 的 82%；body 透明（无框窗口常见）时按前景亮度挑一条中性色 */
  function barTone(p) {
    var c = rgbOf(p.bg);
    if (c && c.a > 0.05) return { bg: alpha(p.bg, 0.82), fg: p.fg };
    var l = luma(p.fg);
    var light = l == null ? true : l > 0.55;
    return light ? { bg: "rgba(20,22,26,.82)", fg: "#f2f4f7" } : { bg: "rgba(252,252,253,.86)", fg: "#1b1e24" };
  }

  /* ── 让位：宿主替页面把顶栏那 30px 让出来 ─────────────────────────────────
     mount 时（加 .mtnode-chrome **之前**）先量一次 body 自己的 padding-top 当基线，
     写进 documentElement 的 --mtnode-chrome-body-pt；样式里用
     max(基线, --mtnode-chrome-h) 定死：老文档口径下自己写了
     body{padding-top:var(--mtnode-chrome-h)} 的页面算出来仍是 30px（不会翻倍），
     没写让位的页面由宿主补上。规则挂在 html.mtnode-chrome 作用域上，
     unmount() 的 remove CLASS / removeProperty 一撤就跟着失效。 */
  function bodyPaddingTop() {
    try {
      var v = parseFloat(getComputedStyle(document.body).getPropertyValue("padding-top"));
      return v > 0 ? v : 0;
    } catch (_) {
      return 0;
    }
  }

  /* ── 样式：一次注入 ───────────────────────────────────────────────────── */
  function styleTag(p) {
    if (styleEl && styleEl.parentElement) return styleEl;
    var tone = barTone(p);
    var css = document.createElement("style");
    css.id = CSS_ID;
    css.textContent =
      "#" + ID + "{position:fixed;top:0;left:0;right:0;height:" + BAR_H + "px;z-index:12600;" +
      "box-sizing:border-box;display:flex;align-items:center;gap:8px;padding:0 6px 0 12px;" +
      "border-bottom:1px solid " + p.line + ";background:" + tone.bg + ";color:" + tone.fg + ";" +
      "font:inherit;font-size:.92em;line-height:1;" +
      "-webkit-app-region:drag;user-select:none;-webkit-user-select:none}" +
      "#" + ID + " .mtn-chrome-t{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;" +
      "white-space:nowrap;letter-spacing:.2px;opacity:.82;-webkit-app-region:drag}" +
      "#" + ID + " .mtn-chrome-b{flex:0 0 auto;display:flex;align-items:center;justify-content:center;" +
      "width:22px;height:22px;padding:0;border:0;border-radius:6px;background:transparent;" +
      "color:inherit;font:inherit;line-height:1;cursor:pointer;opacity:.62;" +
      "-webkit-app-region:no-drag}" +
      "#" + ID + " .mtn-chrome-b:hover{opacity:1;background:" + alpha(tone.fg, 0.14) + "}" +
      "#" + ID + " .mtn-chrome-b:focus-visible{outline:2px solid " + alpha(tone.fg, 0.5) + ";outline-offset:-1px}" +
      /* 让位规则：只在挂了 .mtnode-chrome 时生效，页面自己的 padding-top 一句话都不动 */
      "html." + CLASS + " body{padding-top:max(var(--mtnode-chrome-body-pt,0px),var(--mtnode-chrome-h))!important;" +
      "box-sizing:border-box}";
    (document.head || document.documentElement).appendChild(css);
    styleEl = css;
    return css;
  }

  /* ── 页面上有没有自己的可拖区 ─────────────────────────────────────────── */
  function isDrag(el) {
    try {
      var cs = getComputedStyle(el);
      if (!cs) return false;
      var v = String(cs.getPropertyValue("-webkit-app-region") || cs.webkitAppRegion || "").trim();
      return v === "drag";
    } catch (_) {
      return false;
    }
  }
  function mine(el) {
    try {
      return !!(el && el.closest && el.closest("#" + ID));
    } catch (_) {
      return false;
    }
  }
  function pageHasDrag() {
    var body = document.body;
    if (!body) return false;
    if (isDrag(body)) return true;
    var all;
    try {
      all = body.getElementsByTagName("*");
    } catch (_) {
      return false;
    }
    var n = Math.min(all.length, SCAN_MAX);
    for (var i = 0; i < n; i++) {
      var el = all[i];
      if (!el || mine(el)) continue;
      if (isDrag(el)) return true;
    }
    return false;
  }

  /* ── 标题 / 关闭 ─────────────────────────────────────────────────────── */
  function title() {
    var d = null;
    try {
      d = window.__mtnodeAuthorTag;
    } catch (_) {}
    var s = String((d && (d.title || d.id || d.name)) || "").trim();
    if (!s) {
      try {
        s = String(document.title || "").trim();
      } catch (_) {
        s = "";
      }
    }
    return s;
  }
  /* 桥上的 close 在不在：不在（页面自己打开的 / 预览态 mtnode-preview:// 没有 preload）
     就不画 ✕ —— 不假装能关 */
  function bridge() {
    try {
      var h = window.appHost;
      return h && typeof h === "object" ? h : null;
    } catch (_) {
      return null;
    }
  }
  function closable() {
    var h = bridge();
    return !!(h && typeof h.close === "function");
  }
  function closeApp() {
    try {
      var h = window.appHost;
      if (h && typeof h.close === "function") {
        h.close();
        return true;
      }
    } catch (_) {}
    return false;
  }
  /* ── 最小化 / 最大化还原（本轮需求：应用独立窗口补这两颗）──────────────────
   * 无框应用窗口（frame:false）本来没有系统按钮，只有宿主这条顶栏那枚 ✕；现在补两颗：
   *   —  最小化（appHost.minimize）
   *   □  最大化 / ❐ 还原（appHost.toggleMaximize，图标随窗口状态换）
   * 桥上没有这两个方法（老宿主 / 预览态）就不画 —— 不假装能点。图标状态在 window resize 时
   * 与点完之后各同步一次（最大化 / 还原必然伴随一次 resize）。 */
  function mkWbtn(cls, glyph, label, onClick) {
    var b = document.createElement("button");
    b.type = "button";
    b.className = "mtn-chrome-b" + (cls ? " " + cls : "");
    b.textContent = glyph;
    b.setAttribute("aria-label", label);
    b.setAttribute("title", label);
    b.addEventListener("click", function (ev) {
      if (ev && ev.preventDefault) ev.preventDefault();
      if (ev && ev.stopPropagation) ev.stopPropagation();
      onClick();
    });
    return b;
  }
  function setMaxGlyph(on) {
    if (!maxBtn) return;
    maxBtn.textContent = on ? "❐" : "□";
    var lbl = on ? t("还原窗口", "Restore window") : t("最大化窗口", "Maximize window");
    maxBtn.setAttribute("aria-label", lbl);
    maxBtn.setAttribute("title", lbl);
  }
  function syncMax() {
    var h = bridge();
    if (!maxBtn || !h || typeof h.isMaximized !== "function") return;
    try {
      Promise.resolve(h.isMaximized())
        .then(function (r) {
          setMaxGlyph(!!(r && r.maximized));
        })
        .catch(function () {});
    } catch (_) {}
  }
  function toggleMax() {
    var h = bridge();
    if (!h || typeof h.toggleMaximize !== "function") return;
    try {
      Promise.resolve(h.toggleMaximize())
        .then(function (r) {
          if (r && typeof r.maximized === "boolean") setMaxGlyph(r.maximized);
          else syncMax();
        })
        .catch(syncMax);
    } catch (_) {
      syncMax();
    }
  }

  /* ── 挂 / 收 ─────────────────────────────────────────────────────────── */
  function unmount() {
    try {
      if (bar && bar.parentElement) bar.parentElement.removeChild(bar);
    } catch (_) {}
    bar = null;
    maxBtn = null;
    if (maxHooked) {
      try {
        window.removeEventListener("resize", syncMax);
      } catch (_) {}
      maxHooked = false;
    }
    try {
      document.documentElement.classList.remove(CLASS);
      document.documentElement.style.removeProperty("--mtnode-chrome-h");
    } catch (_) {}
    return true;
  }

  /** 挂载。force = 不看页面是否有可拖区（应用自己调 show 时才用得上）。 */
  function mount(force) {
    if (bar && bar.parentElement) return true;
    if (!document.body) return false;
    if (!force && pageHasDrag()) return false;
    var p = palette();
    styleTag(p);

    bar = document.createElement("div");
    bar.id = ID;
    bar.className = "mtn-chrome";
    var head = document.createElement("span");
    head.className = "mtn-chrome-t";
    head.textContent = title();
    head.setAttribute("title", head.textContent);
    bar.appendChild(head);

    var h = bridge();
    if (h && typeof h.minimize === "function") {
      bar.appendChild(mkWbtn("", "—", t("最小化窗口", "Minimize window"), function () {
        try {
          h.minimize();
        } catch (_) {}
      }));
    }
    if (h && typeof h.toggleMaximize === "function") {
      maxBtn = mkWbtn("", "□", t("最大化窗口", "Maximize window"), toggleMax);
      bar.appendChild(maxBtn);
    }
    if (closable()) {
      bar.appendChild(
        mkWbtn("mtn-chrome-x", "✕", t("关闭窗口", "Close window"), closeApp),
      );
    }

    (document.body || document.documentElement).appendChild(bar);
    if (maxBtn) {
      syncMax();
      if (!maxHooked) {
        maxHooked = true;
        try {
          window.addEventListener("resize", syncMax);
        } catch (_) {}
      }
    }
    /* 基线量在加 class 之前（此刻上面的让位规则还不生效，量到的是页面自己的 padding-top），
       每次 mount 都重算一次：hide → show 不会沿用旧值 */
    var basePt = bodyPaddingTop();
    try {
      document.documentElement.style.setProperty("--mtnode-chrome-h", BAR_H + "px");
      document.documentElement.style.setProperty("--mtnode-chrome-body-pt", basePt + "px");
      document.documentElement.classList.add(CLASS);
    } catch (_) {}
    return true;
  }

  /* 挂上之后复核几次：页面自己晚一步长出可拖区（模板 / 应用自己补 header）就把这条收掉，
     别变成两条标题栏 / 两个 ✕ */
  function watchForeignDrag() {
    [400, 1200, 3000].forEach(function (ms) {
      setTimeout(function () {
        try {
          if (!bar) return;
          if (pageHasDrag()) unmount();
        } catch (_) {}
      }, ms);
    });
  }

  function show(force) {
    var ok = false;
    try {
      ok = mount(force === true);
    } catch (_) {}
    return ok;
  }
  function hide() {
    return unmount();
  }

  try {
    window.__mtnodeWindowChrome = { hide: hide, show: show };
  } catch (_) {}

  /* 自挂载（默认路径）：DOMContentLoaded 之后扫一次；页面已有可拖区就整条不注入 */
  (function autoMount() {
    if (typeof document === "undefined") return;
    var run = function () {
      var ok = false;
      try {
        ok = mount(false);
      } catch (_) {}
      if (ok) watchForeignDrag();
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run, { once: true });
    else run();
  })();
})();
