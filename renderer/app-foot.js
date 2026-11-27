"use strict";
/* ============================================================================
 * 应用窗口 · 宿主 footer 的让位（renderer/app-foot.js）
 * ----------------------------------------------------------------------------
 * 需求（用户原话）：「解决应用中，footer（放置内置功能的控制条）会遮挡应用的问题，应当在应用界面
 * 底部下方，而不要占据应用主体，因为应用开发自身可能不可知 footer。」
 *
 * 现场：宿主注入的底部 UI 全是 `position:fixed;bottom:0` 的浮层 ——
 *   #mtnode-dictate-bar（听写条 / 作者标签共用的底栏）、#mtnode-author-bar、
 *   #mtnode-aiwork-bar（AI 过程条）、#mtnode-media-bar（播放条）。
 * 应用是用户自己的页面，它**不知道**有这条 footer，不可能自己留出位置，于是浮层直接压住应用
 * 最后那几十像素（应用自己的底栏 / 按钮 / 列表尾）。所以由宿主替它让位：
 *   · 量出这些浮层从视口底往上占了多少（含 AI 过程条被抬到听写条之上的情形），
 *   · 写进 <html> 的 --mtnode-foot-h 并挂 .mtnode-foot，
 *   · 由一条 `html.mtnode-foot body{padding-bottom:max(基线, --mtnode-foot-h)}` 把页面内容抬到
 *     footer 上面 —— footer 因此待在「应用界面底部下方」，应用主体一点不被它占据；
 *   · 浮层收掉（听写条收起 / AI 跑完 / 播放条收起）时高度归零、class 撤掉，页面排版一个字节不留。
 *
 * 只认宿主自己那几条（id 白名单 + `[data-mtnode-foot]`），**绝不**替应用自绘的底栏让位：
 * 判据是「这个元素本身是 position:fixed」—— 已经落进应用自己 <footer> 里的条不是浮层，不用让位。
 *
 * 残余限制（与顶栏 renderer/app-chrome-ui.js 同一条口径）：`#root{position:fixed;inset:0}` 这类
 * 满屏容器、以及 `height:100vh` 定高的根容器，padding-bottom 推不动它们 —— 那种页面能滚到，
 * 但首屏仍会被浮层压住一点。应用想彻底避开，自己画一条 footer 并把条挂进去即可（宿主会优先落进去，
 * 那时这里量不到浮层，一个字节都不改页面）。
 *
 * 失败静默：量不了几何 / 老引擎没有 MutationObserver，就当没有浮层，绝不因为让位把页面弄坏。
 * ==========================================================================*/

(function () {
  var CLASS = "mtnode-foot";
  var CSS_ID = "mtnode-foot-css";
  var IDS = ["mtnode-dictate-bar", "mtnode-author-bar", "mtnode-aiwork-bar", "mtnode-media-bar"];
  var H_VAR = "--mtnode-foot-h";
  var BASE_VAR = "--mtnode-foot-body-pb";

  var styleEl = null;
  var queued = false;
  var baseline = null; /* 挂 class **之前**量到的 body padding-bottom（老页面自己留过位就不重复留） */

  function cssOf(el, prop) {
    try {
      var cs = getComputedStyle(el);
      var v = cs && cs.getPropertyValue ? cs.getPropertyValue(prop) : "";
      return String(v || "").trim() || String((cs && cs[prop]) || "");
    } catch (_) {
      return "";
    }
  }
  function bodyPaddingBottom() {
    try {
      var v = parseFloat(getComputedStyle(document.body).getPropertyValue("padding-bottom"));
      return v > 0 ? v : 0;
    } catch (_) {
      return 0;
    }
  }
  /** 宿主自己那几条底部浮层（id 白名单 + data-mtnode-foot） */
  function hostBars() {
    var out = [];
    for (var i = 0; i < IDS.length; i++) {
      var n = document.getElementById(IDS[i]);
      if (n && out.indexOf(n) < 0) out.push(n);
    }
    var more = [];
    try {
      more = document.querySelectorAll("[data-mtnode-foot]");
    } catch (_) {
      more = [];
    }
    for (var j = 0; j < more.length; j++) if (out.indexOf(more[j]) < 0) out.push(more[j]);
    return out;
  }
  /** 这些浮层从视口底往上占了多少（px）；没有浮层 = 0 */
  function footHeight() {
    var vh = 0;
    try {
      vh = Number(window.innerHeight || 0);
    } catch (_) {
      return 0;
    }
    if (!vh) return 0;
    var list = hostBars();
    var best = 0;
    for (var i = 0; i < list.length; i++) {
      var n = list[i];
      if (!n || !n.getBoundingClientRect) continue;
      /* 落进应用自己 footer 里的条（普通文档流）不让位；只有浮层才压内容 */
      if (cssOf(n, "position") !== "fixed") continue;
      if (cssOf(n, "display") === "none" || cssOf(n, "visibility") === "hidden") continue;
      var r = n.getBoundingClientRect();
      if (!r || !r.height) continue;
      /* 只要还压在视口下部就算（AI 过程条被抬到听写条之上时它自己并不贴底，
         但「这一摞」的上沿才是要让出的高度） */
      if (r.top > vh) continue;
      var off = Math.round(vh - r.top);
      if (off > best) best = off;
    }
    return best;
  }

  function styleTag() {
    if (styleEl && styleEl.parentElement) return styleEl;
    var css = document.createElement("style");
    css.id = CSS_ID;
    css.textContent =
      /* 让位规则只在挂了 .mtnode-foot 时生效：没浮层时页面一个字节都不动 */
      "html." + CLASS + " body{padding-bottom:max(var(" + BASE_VAR + ",0px),var(" + H_VAR + ",0px))!important;" +
      "box-sizing:border-box}";
    (document.head || document.documentElement).appendChild(css);
    styleEl = css;
    return css;
  }

  /** 一次复核：有浮层就让位，没有就原样还回去（幂等，可反复调） */
  function apply() {
    var root = document.documentElement;
    if (!root || !root.style) return 0;
    var h = footHeight();
    if (h > 0) {
      if (baseline === null) baseline = bodyPaddingBottom(); /* 量在挂 class 之前 */
      styleTag();
      var hv = h + "px";
      var bv = (baseline || 0) + "px";
      if (root.style.getPropertyValue(H_VAR) !== hv) root.style.setProperty(H_VAR, hv);
      if (root.style.getPropertyValue(BASE_VAR) !== bv) root.style.setProperty(BASE_VAR, bv);
      try {
        if (!root.classList.contains(CLASS)) root.classList.add(CLASS);
      } catch (_) {}
      return h;
    }
    try {
      if (root.classList.contains(CLASS)) root.classList.remove(CLASS);
    } catch (_) {}
    try {
      root.style.removeProperty(H_VAR);
      root.style.removeProperty(BASE_VAR);
    } catch (_) {}
    baseline = null;
    return 0;
  }

  /* 复核节流：同一帧只量一次（浮层显隐 / 内容变化都由下面的观察者推过来） */
  function schedule() {
    if (queued) return;
    queued = true;
    var run = function () {
      queued = false;
      try {
        apply();
      } catch (_) {}
    };
    try {
      if (window.requestAnimationFrame) window.requestAnimationFrame(run);
      else setTimeout(run, 16);
    } catch (_) {
      setTimeout(run, 16);
    }
  }

  function hook() {
    try {
      if (window.MutationObserver && document.body)
        new MutationObserver(schedule).observe(document.body, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ["style", "class", "hidden"],
        });
    } catch (_) {}
    try {
      window.addEventListener("resize", schedule);
    } catch (_) {}
    /* 应用页几乎都是「先出壳、内容后到」，浮层也是挂载之后才长出来的：
       定时复核几次兜底（没有 MutationObserver 的老引擎也有救） */
    [0, 120, 400, 1000, 2500].forEach(function (ms) {
      try {
        setTimeout(schedule, ms);
      } catch (_) {}
    });
    /* 条的显隐不一定改 DOM（只改内联样式 / 内容高度），低频再复核一次兜底 */
    try {
      setInterval(function () {
        try {
          if (!document.body || document.hidden) return;
          apply();
        } catch (_) {}
      }, 1200);
    } catch (_) {}
  }

  /* 对外：应用 / 别的宿主模块想手动刷一次（可选；不调也会自己跟上） */
  try {
    window.__mtnodeFoot = { apply: apply, height: footHeight };
  } catch (_) {}

  if (typeof document !== "undefined") {
    var boot = function () {
      hook();
      schedule();
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
    else boot();
  }
})();
