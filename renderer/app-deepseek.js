/* renderer/app-deepseek.js — 状态栏「DeepSeek 对话」入口 + **整个页面右半边**的抽屉浮层。
 *
 * 需求：左下角状态栏加一枚入口（#btnDeepSeek，快捷会话右邻、语音播报左邻），点开由右缘滑出
 * 一只占**页面右半边**的抽屉，里面装 DeepSeek 官方网页（https://chat.deepseek.com/）——
 * 边看画布边问 DeepSeek，不用切窗口。
 *
 * 三条硬约束（都是产品口径，不是实现细节）：
 *   ① **不挤占布局**：抽屉挂在 #layout（.layout，position:relative）上、position:absolute，
 *      top:0 / bottom:0 / right:0 —— 上下正好卡在顶栏之下、状态栏之上，左右到窗口右缘；
 *      不参与 sidebar / pane / agentPane / assistPane 的 flex 布局 —— 打开不压缩画布，
 *      关掉不留空位，画布的平移 / 缩放 / 框选语义完全不变（drawer 上的指针事件仍一律
 *      stopPropagation，保证不漏到画布的 pan / zoom 监听上）；
 *   ② **persistent**：带输入 / 登录态的浮层不许「点外部 / 点蒙层自动关」。关闭只走
 *      ✕ / Esc / 再点一次入口按钮 / 窗内 F2；点画布、点别的按钮都不关它；
 *   ③ **不销毁 webview**：收起只是 transform + visibility（css/deepseek.css 的 .is-open），
 *      `<webview>` 一直挂在 DOM 上 —— 一销毁登录态与对话记录就没了。所以本模块
 *      **从不 removeChild** 那只 webview，只在第一次打开时创建。
 *
 * 其他纪律：
 *   · webview 惰性创建（首次打开才发请求），启动阶段不额外联网；
 *   · UA 抹掉 Electron / 应用名两段（很多站点见到 Electron 就弹「浏览器不支持」），
 *     Chromium 版本沿用本机自带的那一串，不手写版本号；
 *   · 宽度默认 = **窗口宽度的一半**（「右半边」口径），左边缘把手可拖、双击复位回半屏；
 *     上限按窗口宽度现算，至少给左侧内容留 96px；窗口缩放时「没拖过」的抽屉继续跟着半屏走；
 *   · 状态记忆走**现有 config 口径**（config.json 的 deepseek 段，与 teamView / apps 同处
 *     一份文件，不新建文件格式）：开合状态、宽度、上次访问的 DeepSeek 页面三样跨重启记住；
 *   · 生命周期：窗口最小化 / 切画布 / 切视图一律**不销毁** guest、也绝不建第二只 ——
 *     抽屉挂在 #layout 上（重绘只动 #stage），面板一旦被搬走就搬回去而不是重建；
 *   · 网页加载失败只放一条「在系统浏览器中打开」的兜底（走 preload 的 openExternal，
 *     与全应用打开外链同一入口），不重试、不自己造一套聊天界面。
 *
 * 词条：入口 tooltip / 抽屉标题 / 兜底链接三条，中文原文做键，英文在 renderer/i18n.js。
 */
(function () {
  "use strict";

  var BTN_ID = "btnDeepSeek";
  var PANEL_ID = "deepseekDrawer";
  var HOME = "https://chat.deepseek.com/";
  var PARTITION = "persist:deepseek"; /* 与主进程 DEEPSEEK_WEBVIEW_PARTITION 同值（白名单硬校验） */
  var ST_KEY = "deepseek"; /* config.json 里的段名（S.config.deepseek） */
  var HALF = 0.5; /* 默认宽度 = 窗口宽度的一半 —— 「整个页面右半边」 */
  var W_MIN = 300;
  var W_MAX = 1600; /* 硬上限；实际上限按窗口现算（maxWidth） */
  var KEEP = 96; /* 抽屉打开时至少留给左侧内容（边栏 / 画布）的宽度 */

  var open = false;
  var built = false;
  var panel = null;
  var body = null;
  var btn = null;
  var wv = null;
  var width = 0; /* 当前像素宽（applyWidth / clampWidth 写） */
  var autoFit = true; /* true = 宽度跟着「窗口一半」走；用户拖过就 false */
  var drag = null;

  function T(s) {
    return typeof I18n !== "undefined" && I18n.t ? I18n.t(s) : s;
  }

  function host() {
    /* 挂 #layout（.layout，position:relative）而不是 #canvas：抽屉要占**整个页面右半边** ——
       上下到顶栏之下 / 状态栏之上，左右到窗口右缘，不受画布那块区域限制。万一取不到
       #layout（正常不会）就退回 #canvas，行为与上一版一致。 */
    return document.getElementById("layout") || document.getElementById("canvas");
  }

  /* ── 状态（config.json 的 deepseek 段）────────────────────────────────
     三样东西要跨重启记住：抽屉开着没（open）、拖出来的宽度（width）、上次访问的
     DeepSeek 页面（url）。**不新建文件格式** —— 与 teamView / apps / dsh 一样落在现有
     config.json（S.config）里，写盘走 window.api.configSave(S.config)（preload.js 的
     config:save 通道；主进程侧是 mergeConfigForSave 的顶层浅合并，多一段不打扰别人）。
     配置由 app-boot.js 的 init 异步读到（S.config = await configLoad），本文件在
     DOMContentLoaded 就跑、可能早于它：读不到就按缺省跑，稍后 restoreState 轮询回填。 */

  /* 配置对象到位了没（app-boot.js 的 init 里 S.config = await configLoad 之后才有） */
  function cfgReady() {
    var box = typeof S !== "undefined" && S ? S.config : null;
    return !!box && typeof box === "object";
  }

  /* 取出（create=false 时只读）本模块那一段；配置还没到就返回 null，调用方按缺省走。 */
  function cfgSec(create) {
    if (!cfgReady()) return null;
    var box = S.config;
    var sec = box[ST_KEY];
    if (!sec || typeof sec !== "object") {
      if (!create) return null;
      sec = box[ST_KEY] = {};
    }
    return sec;
  }

  /* 落状态：配置没到就只作用于本次运行（启动最早那几百毫秒），不排队、不补写。 */
  function saveState(patch) {
    var sec = cfgSec(true);
    if (!sec) return;
    for (var k in patch) {
      if (Object.prototype.hasOwnProperty.call(patch, k)) sec[k] = patch[k];
    }
    try {
      if (window.api && typeof window.api.configSave === "function")
        Promise.resolve(window.api.configSave(S.config)).catch(function () {});
    } catch (_) {
      /* 桥不在（理论上不会）：本次运行照常，只是记不住 */
    }
  }

  /* ── 宽度（半屏默认 + 可拖 + 记忆）──────────────────────────────────── */

  /* 半屏宽度：宿主（#layout，即整条页面主体）宽度的一半 */
  function defaultWidth() {
    var h = host();
    var avail = (h && h.clientWidth) || window.innerWidth || 1440;
    return Math.round(avail * HALF);
  }

  function readWidth() {
    var sec = cfgSec(false);
    /* wv2 = 「半屏口径」的存档标记。上一版存的是绝对像素（默认 420，更早还有 localStorage
       那份），跟「右半边」不是一个意思 —— 见到没有这个标记的存档就当没有宽度，按半屏重算
       一次；标记与 auto 一起写回，此后就只认新口径。 */
    if (sec && sec.wv2 === true) {
      autoFit = sec.auto !== false;
      if (!autoFit) {
        var v = parseInt(sec.width, 10);
        if (isFinite(v) && v > 0) return v;
      }
      autoFit = true;
      return defaultWidth();
    }
    autoFit = true;
    return defaultWidth();
  }

  function saveWidth(w) {
    saveState({ width: Math.round(w), auto: !!autoFit, wv2: true });
  }

  function maxWidth() {
    var h = host();
    var avail = (h && h.clientWidth) || window.innerWidth;
    return Math.max(W_MIN, Math.min(W_MAX, avail - KEEP));
  }

  function clampWidth(w) {
    var n = Math.round(Number(w) || defaultWidth());
    if (!isFinite(n) || n <= 0) n = defaultWidth();
    return Math.max(W_MIN, Math.min(maxWidth(), n));
  }

  function applyWidth(w) {
    width = clampWidth(w);
    if (panel) panel.style.width = width + "px";
  }

  /* 窗口尺寸变了：没拖过就继续跟着半屏（autoFit），拖过就只把旧值夹进新范围。 */
  function syncWidth() {
    applyWidth(autoFit ? defaultWidth() : width);
  }

  /* ── 官方 DeepSeek logo ──────────────────────────────────────────────
     产品口径：状态栏入口与抽屉标题都用 DeepSeek 官方 logo，不要 emoji、不要自绘鲸鱼。
     路径的唯一真源在 renderer/app-whalecoin.js 的 DS_LOGO_D（鲸圆币角标画的就是它），
     那边从 window.MtCoin.logoPath / logoColor 导出 —— 本文件只渲染，不复制第二份 path，
     也不引任何图片文件（打包漏图这种坑一并免掉）。 */
  function logoBox(px) {
    var d = "";
    var color = "#4D6BFE";
    try {
      if (window.MtCoin && window.MtCoin.logoPath) d = String(window.MtCoin.logoPath);
      if (window.MtCoin && window.MtCoin.logoColor) color = String(window.MtCoin.logoColor);
    } catch (_) {
      d = "";
    }
    if (!d) return null; /* 取不到就由调用方退回文本兜底 */
    var NS = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", String(px));
    svg.setAttribute("height", String(px));
    svg.setAttribute("focusable", "false");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("class", "ds-logo");
    var p = document.createElementNS(NS, "path");
    p.setAttribute("d", d);
    p.setAttribute("fill", color);
    svg.appendChild(p);
    return svg;
  }

  /* ── 建抽屉（一次性；之后只切 class）──────────────────────────────── */

  function build() {
    if (built) return !!panel;
    var h = host();
    if (!h) return false;
    built = true;

    panel = document.createElement("section");
    panel.className = "ds-drawer";
    panel.id = PANEL_ID;
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", T("DeepSeek 对话"));
    panel.setAttribute("aria-hidden", "true");

    /* 左边缘拖动把手：改宽度，双击回默认（半屏） */
    var grip = document.createElement("div");
    grip.className = "ds-grip";
    grip.id = "dsGrip";
    grip.setAttribute("aria-hidden", "true");
    grip.addEventListener("pointerdown", onGripDown);
    grip.addEventListener("dblclick", function (ev) {
      ev.preventDefault();
      autoFit = true; /* 双击 = 回到「右半边」口径 */
      applyWidth(defaultWidth());
      saveWidth(width);
    });

    var head = document.createElement("div");
    head.className = "ds-head";

    var dot = document.createElement("span");
    dot.className = "ds-dot";
    dot.setAttribute("aria-hidden", "true");
    var headLogo = logoBox(14);
    if (headLogo) dot.appendChild(headLogo);
    else dot.textContent = "🐋"; /* MtCoin 没就位时的兜底（正常不会走到） */

    var title = document.createElement("span");
    title.className = "ds-title";
    title.setAttribute("data-i18n", "DeepSeek 对话");
    title.textContent = T("DeepSeek 对话");

    var close = document.createElement("button");
    close.type = "button";
    close.className = "ds-close";
    close.id = "dsClose";
    close.setAttribute("data-i18n-title", "关闭");
    close.title = T("关闭");
    close.setAttribute("aria-label", T("关闭"));
    close.textContent = "✕";
    close.addEventListener("click", function (ev) {
      ev.preventDefault();
      setOpen(false);
    });

    head.appendChild(dot);
    head.appendChild(title);
    head.appendChild(close);

    body = document.createElement("div");
    body.className = "ds-body";
    body.id = "dsBody";

    panel.appendChild(grip);
    panel.appendChild(head);
    panel.appendChild(body);
    h.appendChild(panel);

    /* 画布自己的 pointerdown / wheel 监听挂在 #canvas 上：抽屉里的这些事件一律不冒泡上去
       （抽屉已改挂 #layout、本来就不在 #canvas 里，这条是防御性保留：将来谁把挂点挪回画布，
       也不会点一下抽屉就顺带把画布平移 / 缩放了；webview 内部事件本来就不会冒出来）。 */
    ["pointerdown", "mousedown", "wheel", "dblclick", "contextmenu"].forEach(function (type) {
      panel.addEventListener(
        type,
        function (ev) {
          ev.stopPropagation();
        },
        false,
      );
    });

    applyWidth(readWidth());
    return true;
  }

  /* ── webview（惰性创建，永不销毁）────────────────────────────────── */

  function webviewUA() {
    var ua = "";
    try {
      ua = String(navigator.userAgent || "");
    } catch (_) {
      ua = "";
    }
    /* 抹掉 Electron/x.y.z 与本应用自己的标识段；其余（Chromium 版本）原样沿用 */
    ua = ua
      .replace(/\sElectron\/[\d.]+/gi, "")
      .replace(/\s[A-Za-z0-9._-]*electron[A-Za-z0-9._-]*\/[\d.]+/gi, "")
      .replace(/\smtnode[A-Za-z0-9._-]*\/[\d.]+/gi, "")
      .replace(/\spipeline-console\/[\d.]+/gi, "");
    return ua.replace(/\s{2,}/g, " ").trim();
  }

  function showFallback() {
    if (!body || body.querySelector(".ds-fallback")) return;
    var box = document.createElement("div");
    box.className = "ds-fallback";
    var link = document.createElement("button");
    link.type = "button";
    link.className = "ds-link";
    link.setAttribute("data-i18n", "网页没加载出来 —— 在系统浏览器中打开");
    link.textContent = T("网页没加载出来 —— 在系统浏览器中打开");
    link.addEventListener("click", function (ev) {
      ev.preventDefault();
      try {
        if (window.api && typeof window.api.openExternal === "function")
          window.api.openExternal(HOME);
        else window.open(HOME, "_blank");
      } catch (_) {}
    });
    box.appendChild(link);
    body.appendChild(box);
  }

  /* 上次访问的 DeepSeek 页面：只认主进程白名单认的那一只（https + chat.deepseek.com
     含子域）。认不出来（手改 config / 老版本存了别站）就回首页 —— 否则挂上去也会被
     will-attach-webview 当场拒掉，留一块空白不如直接回首页。 */
  function safeUrl(u) {
    var s = String(u || "");
    if (!s) return "";
    try {
      var url = new URL(s);
      if (url.protocol !== "https:") return "";
      var h = url.hostname.toLowerCase();
      if (h !== "chat.deepseek.com" && !/\.chat\.deepseek\.com$/.test(h)) return "";
      return url.href;
    } catch (_) {
      return "";
    }
  }

  function startUrl() {
    var sec = cfgSec(false);
    return (sec && safeUrl(sec.url)) || HOME;
  }

  function currentUrl() {
    try {
      if (wv && typeof wv.getURL === "function") return String(wv.getURL() || "");
    } catch (_) {}
    return "";
  }

  function rememberUrl(u) {
    var good = safeUrl(u);
    if (!good) return;
    var sec = cfgSec(false);
    if (sec && sec.url === good) return; /* 同一条不重复写盘 */
    saveState({ url: good });
  }

  /* 抽屉挂在 #layout 上（画布只重建 #stage / #canvas 里的东西）：切画布只重建 #stage 里的
     内容，抽屉与它肚子里那只 guest 一个字节都不动 —— 「切画布不销毁 guest」就落在这里。
     万一哪天有人整段替换了 #layout 的子节点，这里把**同一个** <section>（连同里面那只
     webview）搬回去，而不是新建第二份。只在真的不在树上时才 append（append 已挂着的
     节点等于先摘再插，那会把 guest 重建一遍）。 */
  function ensureMounted() {
    var h = host();
    if (!h || !panel) return;
    if (panel.parentNode !== h) h.appendChild(panel);
  }

  /* ── 建造条让位 ────────────────────────────────────────────────────────
     F2 呼出的抽屉挂 #layout、铺满右半边到底边；画布建造条（#canvasDock，z-index 90）
     压在抽屉（74）上面，抽屉底部那一截 —— 正好是 chat 的输入区 —— 就被条子挡住。
     让位量写进 --ds-dock-h，CSS 拿它当 bottom（见 css/deepseek.css），抽屉收在条子
     之上：两边都不被盖、条子仍可点。

     量的是「抽屉容器（#layout）底边 − 建造条顶边」，**不是**条子自己的高度：条子贴的是
     #canvas 的底边，而 #canvas 底下还留着约 10px 留白（实测 #canvas.bottom 比
     #layout.bottom 高 10px，再加 0.67px 画布边框）。上一版只按条高 49px 让位，抽屉下沿
     正好压进条子里那 10px —— 用户复报「没修好」就是这 10px。两条边现量，留白怎么变都对。

     四种情况算 0（不让位）：条子没挂上 / 设置里关掉（hidden）/ 不在可视链上
     （非画布视图，body 上没有 view-workflow 时 #wfWrap 被整体 display:none）/
     收纳态（整条淡出，只剩左下角一枚按钮，抽屉右半边根本碰不到它）。 */
  function dockInset() {
    var dock = document.getElementById("canvasDock");
    if (!dock || dock.hidden) return 0;
    if (dock.offsetParent === null) return 0;
    if (dock.getAttribute("data-state") === "mini") return 0;
    var dr = dock.getBoundingClientRect();
    if (!(dr.height > 0)) return 0;
    var h = host();
    var base = h ? h.getBoundingClientRect().bottom : window.innerHeight;
    /* 向上取整：亚像素（1.25 / 1.5 缩放 + 0.67px 画布边框）下宁愿多让 1px，也别留一条缝 */
    var inset = Math.ceil(base - dr.top);
    return inset > 0 ? inset : 0;
  }

  /* 观察者：视图切换（body 上的 view-* 类）、条子自身展开 / 收纳 / 开关都会改变让位量；
     条子被重建（换画布 / #canvas 重挂）时旧观察目标会失效，所以顺带盯一眼 #canvas 的子节点
     变化，每次同步都把观察目标换成当前那只。 */
  var mo = null;
  var moCanvas = null;
  var moDock = null;

  function watchLayout() {
    if (typeof MutationObserver !== "function" || !document.body) return;
    if (!mo) {
      mo = new MutationObserver(function () {
        syncDockInset();
      });
      mo.observe(document.body, { attributes: true, attributeFilter: ["class"] });
    }
    var cv = document.getElementById("canvas");
    if (cv && cv !== moCanvas) {
      moCanvas = cv;
      mo.observe(cv, { childList: true });
    }
    var dock = document.getElementById("canvasDock");
    if (dock && dock !== moDock) {
      moDock = dock;
      mo.observe(dock, { attributes: true, attributeFilter: ["hidden", "data-state", "class", "style"] });
    }
  }

  function syncDockInset() {
    if (panel) panel.style.setProperty("--ds-dock-h", dockInset() + "px");
    watchLayout();
  }

  /* 单实例闸门：同一块面板里只认一只 <webview>。wv 引用仍挂在树上就直接用它；引用失真
     （面板被搬动 / 重绘过）时按 DOM 找回来，**绝不**再建第二只 —— 第二只 guest = 第二个
     页面、第二份登录态，还白烧一份渲染进程。 */
  function ensureWebview() {
    if (!body) return;
    var existing = wv && wv.parentNode ? wv : body.querySelector("webview.ds-webview");
    if (existing) {
      wv = existing;
      return;
    }
    var el = document.createElement("webview");
    el.className = "ds-webview";
    /* 专用会话（登录态落盘就靠它）：主进程 will-attach-webview 只认正好这一只 partition，
        漏了这一个属性 = 整笔挂载被拒（面板一片空白，error.log 里写「partition=(空)」）。 */
    el.setAttribute("partition", PARTITION);
    var ua = webviewUA();
    if (ua) el.setAttribute("useragent", ua);
    el.setAttribute("src", startUrl());
    el.addEventListener("did-fail-load", function (ev) {
      /* -3 = ERR_ABORTED（用户点了链接 / 中途取消），不算失败 */
      if (ev && ev.errorCode === -3) return;
      if (ev && ev.isMainFrame === false) return;
      showFallback();
    });
    /* 上次访问的路径记忆：站内跳转（含前端路由的 in-page 跳转）都记一条 */
    el.addEventListener("did-navigate", function (ev) {
      rememberUrl((ev && ev.url) || currentUrl());
    });
    el.addEventListener("did-navigate-in-page", function (ev) {
      rememberUrl((ev && ev.url) || currentUrl());
    });
    body.appendChild(el);
    wv = el;
  }

  /* ── 开关 ─────────────────────────────────────────────────────────── */

  function setOpen(v) {
    applyOpen(v, true);
  }

  function toggle() {
    applyOpen(!open, true);
  }

  /* persist=false 只给启动回填用：按存档摆回开合状态，不为「恢复」再多写一次盘。 */
  function applyOpen(v, persist) {
    v = !!v;
    if (v && !build()) return;
    if (v) {
      ensureMounted();
      ensureWebview();
    }
    /* 与既有浮层互斥：打开抽屉前先收掉节点级浮层（参数 / 后端 / 封面 / 字号…），
       免得两块浮层叠在一起抢焦点；助手栏菜单与顶栏瞬态菜单不算「同类」，不动。 */
    if (v && !open) closeNodePopsForDrawer();
    open = v;
    if (v) {
      /* 建造条让位：这一刻画布那边可能还没把条子挂进树（启动回填时尤其如此），
         下一帧与半秒后再补两次，之后靠 resize / 视图切换 / 条子状态变化同步。 */
      syncDockInset();
      window.requestAnimationFrame(syncDockInset);
      window.setTimeout(syncDockInset, 500);
    }
    if (panel) {
      panel.classList.toggle("is-open", open);
      panel.setAttribute("aria-hidden", open ? "false" : "true");
    }
    if (btn) {
      btn.classList.toggle("is-open", open);
      btn.setAttribute("aria-pressed", open ? "true" : "false");
    }
    if (persist !== false) saveState({ open: open });
  }

  /* ── 拖宽 ─────────────────────────────────────────────────────────── */

  function onGripDown(ev) {
    if (ev.button !== 0 || !panel) return;
    ev.preventDefault();
    var h = host();
    /* 抽屉贴窗口右缘（css 的 right:0），所以宽度 = 宿主右缘 − 指针 x，不再留右缘内缩 */
    var right = h ? h.getBoundingClientRect().right : window.innerWidth;
    drag = { right: right };
    panel.classList.add("is-resizing");
    /* 指针捕获：把后续 pointermove / pointerup 直接绑在把手上 —— 往右拖时指针很快就滑到
       抽屉里的网页（webview，独立渲染进程）上方，那些事件会被 guest 吃掉，宿主这层收不到，
       抽屉就卡在半路（用户报的 bug：左边界拖不动 / 只能变宽不能变窄）。CSS 那边同时把
       is-resizing 态的网页设为 pointer-events:none，两条一起兜住。 */
    try {
      if (ev.pointerId != null && ev.currentTarget && ev.currentTarget.setPointerCapture)
        ev.currentTarget.setPointerCapture(ev.pointerId);
    } catch (_) {}
    try {
      document.documentElement.classList.add("ds-resizing");
    } catch (_) {}
    window.addEventListener("pointermove", onDragMove, true);
    window.addEventListener("pointerup", onDragEnd, true);
    window.addEventListener("pointercancel", onDragEnd, true);
  }

  function onDragMove(ev) {
    if (!drag) return;
    ev.preventDefault();
    autoFit = false; /* 真拖过一次就不再跟随半屏 */
    applyWidth(drag.right - ev.clientX);
  }

  function onDragEnd(ev) {
    if (!drag) return;
    drag = null;
    if (panel) panel.classList.remove("is-resizing");
    try {
      if (ev && ev.pointerId != null && ev.currentTarget && ev.currentTarget.releasePointerCapture)
        ev.currentTarget.releasePointerCapture(ev.pointerId);
    } catch (_) {}
    try {
      document.documentElement.classList.remove("ds-resizing");
    } catch (_) {}
    window.removeEventListener("pointermove", onDragMove, true);
    window.removeEventListener("pointerup", onDragEnd, true);
    window.removeEventListener("pointercancel", onDragEnd, true);
    saveWidth(width);
  }

  /* ── 键盘：只留 Esc 关 ──────────────────────────────────────────────────
     开关改由窗内 F2 负责（renderer/app-status-keys.js 统一管 F1–F4）；原先的反引号
     开关键**已停用**（用户口径：只留 F2，反引号还给正常打字）。
     blockingLayerOpen 留着给 Esc 那一支判「键该不该让给别的浮层」。 */

  /* 收掉节点级浮层（app.js 的 closeNodePopsExcept，本文件加载更早，调用期按 typeof 取）。
     节点「?」说明小窗是瞬态 tooltip，一并收掉，别让它压在抽屉上。 */
  function closeNodePopsForDrawer() {
    try {
      if (typeof closeNodePopsExcept === "function") closeNodePopsExcept("");
      else if (typeof closeAllNodePops === "function") closeAllNodePops();
    } catch (_) {}
    try {
      if (typeof window.hideNodeHelpTip === "function") window.hideNodeHelpTip();
    } catch (_) {}
  }

  /* 有全屏浮层压在前面时把键让给它（各窗自己会用 Esc 关自己） */
  function blockingLayerOpen() {
    var ov = document.getElementById("overlay");
    if (ov && (ov.style.display === "flex" || ov.classList.contains("on"))) return true;
    if (document.querySelector(".mt-dialog.on")) return true;
    var gs = document.getElementById("gsLayer");
    if (gs && gs.classList.contains("on")) return true;
    var lb = document.getElementById("imgLb");
    if (lb && lb.classList.contains("on")) return true;
    return false;
  }

  function onKeydown(ev) {
    if (ev.isComposing || ev.repeat) return;
    var key = String(ev.key || "");
    if (key === "Escape" || key === "Esc") {
      if (!open) return;
      if (blockingLayerOpen()) return;
      setOpen(false);
      return;
    }
    /* 反引号不再开合抽屉（已停用）：这里什么都不做，键原样交回页面 */
  }

  /* ── 启动回填（配置是异步读到的，可能晚于本文件）──────────────────────
     每 120ms 看一次，最多约 12s（≈100 次）：配置一到就把宽度与开合状态摆回去；一直没到
     （config 读坏档 / 桥不在）就彻底放弃，按缺省跑，绝不为此重试到天荒地老。 */
  function restoreState(tries) {
    if (!cfgReady()) {
      if ((tries || 0) < 100)
        window.setTimeout(function () {
          restoreState((tries || 0) + 1);
        }, 120);
      return;
    }
    /* 配置到位即可回填 —— 这一段可能是空的（头一次用 / 别处整份覆盖过），空就按缺省 */
    var sec = cfgSec(false) || {};
    applyWidth(readWidth());
    if (sec.open === true) applyOpen(true, false);
  }

  /* ── 启动 ─────────────────────────────────────────────────────────── */

  function init() {
    btn = document.getElementById(BTN_ID);
    if (btn) {
      /* 入口用 DeepSeek 官方 logo（index.html 里那枚 🐋 只是无脚本兜底，这里换成真图标） */
      var btnLogo = logoBox(14);
      if (btnLogo) {
        btn.textContent = "";
        btn.appendChild(btnLogo);
      }
      btn.setAttribute("aria-pressed", "false");
      /* mousedown 先拦掉：点入口不把焦点从用户正在写的输入框里抢走 */
      btn.addEventListener("mousedown", function (ev) {
        ev.preventDefault();
      });
      btn.addEventListener("click", function (ev) {
        ev.preventDefault();
        toggle();
      });
    }
    /* 面板先建好（此刻不建 webview、不联网），宽度记忆才能一开就对上 */
    build();
    /* 窗内 keydown（capture，先于页面里其它处理拿到）：抽屉开关只在本窗口生效，
       不注册任何全局快捷键。焦点落进 guest（chat.deepseek.com）后按键只在那一侧走，
       冒不到这里 —— 所以 guest 里的 F2 由主进程截下、从 api.onDeepSeekHotkey 转过来，
       走同一个 toggle（再按一次就收回，用户口径）。 */
    window.addEventListener("keydown", onKeydown, true);
    try {
      var api = window.api;
      if (api && typeof api.onDeepSeekHotkey === "function") {
        api.onDeepSeekHotkey(function () {
          toggle();
        });
      }
    } catch (_) {}
    window.addEventListener("resize", function () {
      if (!panel) return;
      ensureMounted();
      syncWidth();
      syncDockInset();
    });
    /* 窗口整体失焦（Alt+Tab / 点了别的程序）时指针捕获会断，pointerup 可能永远不来 ——
       这里收尾一次，免得 is-resizing / html.ds-resizing 留在页面上。 */
    window.addEventListener("blur", function () {
      if (drag) onDragEnd();
    });
    /* 上次关在「抽屉开着」的时候，这次开机照旧开着（宽度与上次的页面一起回填） */
    restoreState(0);
  }

  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", init, { once: true });
  else init();

  /* 给别的模块 / 控制台留一个开关入口（与 window.rebindShortcutKeys 同一写法） */
  window.toggleDeepSeekDrawer = toggle;
})();
