/* ── app-pdfview.js · PDF 应用内预览（连续滚动 / 缩放 / 大版面降采样）──────────
 *
 * 为什么有这只窗：过去 PDF 一律交系统阅读器（画布 PDF 生成节点、文件节点行的
 * 「打开」），理由是「PDF 当不了图片显示」。其实真源通道早就有 —— 主进程
 * pdf:render（pdf-read.js → renderer/pdf-render.html 的 pdf.js 隐藏窗）把页面渲成
 * PNG 回传，扫描件「逐页识图」走的就是它。这里只是把那张页面图摆进 UI，不引新依赖、
 * 不动模型链路。
 *
 * 阅读口径（滚轮连续向下翻页）：
 *   页面按顺序竖排成一条长卷，滚轮 / 触控板直接滚动，滚到哪就渲到哪（IntersectionObserver
 *   提前一屏预取，只有一页渲染在途，其余排队并按离当前页远近排序）；页码随滚动实时更新。
 *   不再有「一屏一页、必须点 ‹ ›」的限制。
 *
 * 口径（与 pdf-read.js / pdf-render.html 对齐）：
 *   ① 页数：pdf:probe（filePdfInfo）→ { pages, encrypted, warning }，同一路径只探一次；
 *   ② 页面图：pdf:render（fileRenderPdfPages）按需单页渲，scale 2 + maxWidth / maxHeight
 *      让**大版面图纸**（比如 12360×9014 的 CAD 页）在渲染侧就降下来，别把一张 15MB 的
 *      base64 顶进 IPC 和内存 —— 这也是「按页取图」相较于「一次全渲」的关键；
 *   ③ 位图只留在内存（dataUrl 缓存，按页 FIFO，上限 16 页），不落盘 —— 与 pdf-read.js 的
 *      「PDF 处理不写盘」口径一致；滚出缓存窗口且已不可见的页会把 <img> 卸掉回收内存；
 *   ④ 加密 PDF（无空口令可开）不猜口令：直接给提示 + 「用系统阅读器打开」兜底；
 *   ⑤ 点阅读区（body）任意空白/页面处 = 直接用 Windows 默认 PDF 阅读器打开（矢量版式 /
 *      批注 / 可搜索文本只有它最完整），是随时可以走的一步。
 *
 * 关闭口径：带翻页 / 缩放的阅读浮层属于**持久浮层**，只走 ✕ / 关闭 / Esc，
 * 点外部不关（见 AGENTS.md「带输入或设置的浮层一律 persistent」）。
 *
 * 出口：window.openPdfPreview(path, opts) —— 调用期取，app-canvas.js（PDF 生成节点）
 * 与 app-db.js（文件节点里的 PDF 行）都用 typeof 判一次再用。
 */
(function () {
  "use strict";

  /* 页面图缓存上限（页）：A4 · scale 2 的 PNG ≈ 300KB，16 页 ≈ 5MB 内存，翻回上一页不用重渲 */
  var CACHE_MAX = 16;
  /* 渲染侧像素上限：够 2 倍屏看清晰，又不至于把大图纸整张塞进内存 */
  var RENDER_SCALE = 2;
  var RENDER_MAX_W = 1800;
  var RENDER_MAX_H = 2600;
  /* 预取范围：视口上下各提前一屏多就开始渲，滚下去时基本不空 */
  var PRELOAD_MARGIN = "1400px 0px";

  var el = null;
  var body = null;
  var pagesEl = null;
  var footPage = null;
  var footZoom = null;
  var titleEl = null;
  var msgEl = null;

  /* 当前会话：path / pages / zoom / cache / nodes / loading / failed / queue / busy / current */
  var cur = null;
  /* 页数探测缓存（同一份 PDF 反复打开不重复探测） */
  var infoCache = new Map();
  var observer = null;
  var rafId = 0;

  function api() {
    return (typeof window !== "undefined" && window.api) || null;
  }
  function tt(s) {
    try {
      return I18n.t(s);
    } catch (_) {
      return s;
    }
  }
  function warn(msg) {
    if (typeof toast === "function") toast(msg, "warn");
  }
  function nameOf(p) {
    try {
      if (typeof fileName === "function") return fileName(p);
    } catch (_) {}
    return String(p || "").split(/[\\/]/).pop() || "PDF";
  }
  function openExternally(p) {
    var a = api();
    if (a && typeof a.shellOpenPath === "function") a.shellOpenPath(p);
  }
  function keyOf(p, n) {
    return p + "#" + n;
  }
  /* 文件戳（mtime:size）。PDF 生成节点是**同名覆盖**写的：只按路径缓存页数 / 页面图的话，
     重新生成之后打开预览看到的还是旧那几页（用户报的「里面内容仍然未更新」）。
     每次打开先取一次戳，戳变了就把这份 PDF 的缓存整份作废、重渲。 */
  function stampOf(p) {
    var a = api();
    if (!a || typeof a.fileStat !== "function") return Promise.resolve("");
    return Promise.resolve(a.fileStat(p))
      .then(function (st) {
        if (!st || st.ok === false) return "";
        return (Number(st.mtime) || 0) + ":" + (Number(st.size) || 0);
      })
      .catch(function () {
        return "";
      });
  }
  function infoKeyOf(p, stamp) {
    return p + "|" + (stamp || "");
  }
  /* 丢掉某份 PDF 的页数缓存（文件被重写过，见 invalidatePdfPreview） */
  function forgetInfoOf(p) {
    var pre = String(p || "") + "|";
    var drop = [];
    infoCache.forEach(function (_v, k) {
      if (String(k).indexOf(pre) === 0) drop.push(k);
    });
    for (var i = 0; i < drop.length; i++) infoCache.delete(drop[i]);
  }
  /* 外部入口（保存节点落完盘后调，见 app-nodes.js savePdfOnce）：这份 PDF 刚被重写 ——
     缓存作废；预览正开着就整页重挂，新内容立刻可见，不必手动关掉再开。 */
  function invalidatePdfPreview(path) {
    var p = String(path || "");
    if (!p) return false;
    forgetInfoOf(p);
    if (cur && cur.path === p) {
      var wasOpts = cur.opts || {};
      var wasOpen = !!(el && el.classList.contains("on"));
      cur = null;
      if (wasOpen) openPdfPreview(p, wasOpts);
    }
    return true;
  }

  /* ── 浮层骨架（只建一次，之后复用）────────────────────────────────────── */
  function ensureEl() {
    if (el && document.body.contains(el)) return el;
    el = document.createElement("div");
    el.id = "pdfPreview";
    el.className = "pdf-pv";
    el.innerHTML =
      '<div class="pdf-pv-box" role="dialog" aria-modal="true">' +
      '<div class="pdf-pv-head"><b id="pdfPvTitle"></b>' +
      '<span class="pdf-pv-page" id="pdfPvHeadPage"></span>' +
      '<button type="button" class="mini" id="pdfPvClose">✕</button></div>' +
      '<div class="pdf-pv-body" id="pdfPvBody" tabindex="0">' +
      '<div class="pdf-pv-msg" id="pdfPvMsg"></div>' +
      '<div class="pdf-pv-pages" id="pdfPvPages"></div>' +
      "</div>" +
      '<div class="pdf-pv-foot" id="pdfPvFoot"></div></div>';
    document.body.appendChild(el);
    titleEl = el.querySelector("#pdfPvTitle");
    body = el.querySelector("#pdfPvBody");
    pagesEl = el.querySelector("#pdfPvPages");
    msgEl = el.querySelector("#pdfPvMsg");
    footPage = el.querySelector("#pdfPvHeadPage");
    var closeX = el.querySelector("#pdfPvClose");
    closeX.title = tt("关闭预览（Esc）");
    closeX.onclick = closePdfPreview;

    /* 点阅读区 = 用系统阅读器打开（用户口径：点击 body 直接走 Windows 默认 PDF 阅读器） */
    body.title = tt("点击用系统阅读器打开（矢量版式 / 批注 / 可搜索文本）");
    body.addEventListener("click", function (ev) {
      if (ev.target.closest("button, input, a, .pdf-pv-msg")) return;
      if (cur && cur.path) openExternally(cur.path);
    });

    /* 底部工具条：翻页 + 页码输入 + 缩放 + 系统阅读器 + 关闭 */
    var foot = el.querySelector("#pdfPvFoot");
    var mk = function (txt, hint, fn, cls) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "mini" + (cls ? " " + cls : "");
      b.textContent = txt;
      if (hint) b.title = tt(hint);
      b.onclick = function (ev) {
        ev.stopPropagation();
        fn();
      };
      foot.appendChild(b);
      return b;
    };
    var prev = mk("‹", "上一页（←）", function () {
      gotoPage((cur && cur.current ? cur.current : 1) - 1);
    }, "pdf-pv-nav");
    prev.id = "pdfPvPrev";
    /* 页码输入框：回车跳页（属于阅读浮层自己的设置件，随浮层一起常驻） */
    footPage = document.createElement("input");
    footPage.type = "number";
    footPage.min = "1";
    footPage.step = "1";
    footPage.className = "pdf-pv-pagein";
    footPage.id = "pdfPvPage";
    footPage.title = tt("页码（回车跳转）");
    footPage.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter") {
        ev.preventDefault();
        gotoPage(footPage.value);
        footPage.blur();
      }
    });
    footPage.addEventListener("blur", function () {
      if (cur) footPage.value = String(cur.current || 1);
    });
    foot.appendChild(footPage);
    var next = mk("›", "下一页（→）", function () {
      gotoPage((cur && cur.current ? cur.current : 1) + 1);
    }, "pdf-pv-nav");
    next.id = "pdfPvNext";

    mk("－", "缩小（Ctrl + 滚轮）", function () {
      setZoom(((cur && cur.zoom) || 1) - 0.25);
    });
    footZoom = document.createElement("span");
    footZoom.className = "pdf-pv-zoom";
    footZoom.id = "pdfPvZoom";
    footZoom.textContent = "100%";
    foot.appendChild(footZoom);
    mk("＋", "放大（Ctrl + 滚轮）", function () {
      setZoom(((cur && cur.zoom) || 1) + 0.25);
    });
    mk(tt("适应宽度"), "回到适应宽度（100%）", function () {
      setZoom(1);
    });
    var sys = mk(tt("系统阅读器"), "用系统默认 PDF 阅读器打开（矢量版式 / 批注 / 可搜索文本）", function () {
      if (cur) openExternally(cur.path);
    });
    sys.id = "pdfPvSystem";
    var closeBtn = mk(tt("关闭"), "关闭预览（Esc）", closePdfPreview, "primary");
    closeBtn.id = "pdfPvFooterClose";

    /* 滚轮：普通滚轮 = 连续滚动（阅读），Ctrl + 滚轮 = 缩放 */
    body.addEventListener(
      "wheel",
      function (ev) {
        if (!ev.ctrlKey) return; /* 交给浏览器原生滚动：连续向下翻页 */
        ev.preventDefault();
        setZoom(((cur && cur.zoom) || 1) + (ev.deltaY < 0 ? 0.25 : -0.25));
      },
      { passive: false },
    );
    /* 滚动 → 更新页码（rAF 节流） */
    body.addEventListener("scroll", function () {
      if (rafId) return;
      rafId = requestAnimationFrame(function () {
        rafId = 0;
        trackCurrent();
      });
    });
    return el;
  }

  /* ── 页面图（带缓存）────────────────────────────────────────────────── */
  function cacheGet(p, n) {
    if (!cur || !cur.cache) return "";
    return cur.cache.get(keyOf(p, n)) || "";
  }
  function cachePut(p, n, dataUrl) {
    var s = cur;
    if (!s || !s.cache) return;
    s.cache.set(keyOf(p, n), dataUrl);
    while (s.cache.size > CACHE_MAX) {
      var oldest = s.cache.keys().next().value;
      if (!oldest) break;
      s.cache.delete(oldest);
      var num = Number(String(oldest).split("#").pop());
      /* 已滚出视野的旧页：连 <img> 一起卸掉，别让位图在 DOM 里常驻；
         但占位比例要补回去，否则这一页会塌成一条线，滚动位置跟着跳 */
      if (num && !s.visible.has(num)) {
        var node = s.nodes[num - 1];
        var im = node && node.querySelector("img");
        if (im) {
          im.remove();
          node.style.aspectRatio = String(s.ratios[num] || s.ratio);
        }
      }
    }
  }

  function setMsg(text, cls) {
    if (!msgEl) return;
    msgEl.textContent = text || "";
    msgEl.className = "pdf-pv-msg" + (cls ? " " + cls : "");
    msgEl.hidden = !text;
  }

  /* ── 长卷：按页建占位块，滚到哪渲到哪 ───────────────────────────────── */
  function pageWidth() {
    var avail = Math.max(160, (body ? body.clientWidth : 800) - 24);
    var z = (cur && cur.zoom) || 1;
    return Math.max(120, Math.round(avail * z));
  }

  function applyWidths() {
    var s = cur;
    if (!s || !s.nodes || !s.nodes.length) return;
    var w = pageWidth();
    for (var i = 0; i < s.nodes.length; i++) s.nodes[i].style.width = w + "px";
  }

  function buildPages(total) {
    var s = cur;
    if (!s) return;
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    pagesEl.innerHTML = "";
    s.nodes = [];
    s.loading = {};
    s.failed = {};
    s.queue = [];
    s.busy = false;
    s.visible = new Set();
    s.nodes.length = 0;
    var frag = document.createDocumentFragment();
    for (var i = 1; i <= total; i++) {
      var d = document.createElement("div");
      d.className = "pdf-pv-sheet";
      d.dataset.page = String(i);
      if (s.ratio) d.style.aspectRatio = String(s.ratio);
      frag.appendChild(d);
      s.nodes.push(d);
    }
    pagesEl.appendChild(frag);
    applyWidths();
    s.current = 1;
    observePages(s);
  }

  function observePages(s) {
    if (typeof IntersectionObserver !== "function") {
      /* 老内核兜底：全渲（页数少时才可接受） */
      for (var i = 1; i <= s.nodes.length; i++) requestPage(i);
      return;
    }
    observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (en) {
          var n = Number(en.target.dataset.page) || 0;
          if (!n) return;
          if (en.isIntersecting) {
            s.visible.add(n);
            requestPage(n);
          } else {
            s.visible.delete(n);
          }
        });
        trackCurrent();
      },
      { root: body, rootMargin: PRELOAD_MARGIN, threshold: 0 },
    );
    s.nodes.forEach(function (n) {
      observer.observe(n);
    });
  }

  function markLoading(n, on) {
    var s = cur;
    var node = s && s.nodes[n - 1];
    if (!node) return;
    node.classList.toggle("is-loading", !!on);
  }

  function markFailed(n, text) {
    var node = cur && cur.nodes[n - 1];
    if (!node) return;
    node.classList.remove("is-loading");
    node.classList.add("is-failed");
    var im = node.querySelector("img");
    if (im) im.remove();
    var tip = node.querySelector(".pdf-pv-sheet-err");
    if (!tip) {
      tip = document.createElement("span");
      tip.className = "pdf-pv-sheet-err";
      node.appendChild(tip);
    }
    tip.textContent = text;
  }

  function fill(n, dataUrl, meta) {
    var s = cur;
    if (!s) return;
    var node = s.nodes[n - 1];
    if (!node) return;
    node.classList.remove("is-loading");
    node.classList.remove("is-failed");
    var err = node.querySelector(".pdf-pv-sheet-err");
    if (err) err.remove();
    var img = node.querySelector("img");
    if (!img) {
      img = document.createElement("img");
      img.className = "pdf-pv-img";
      img.alt = tt("PDF 页面");
      img.draggable = false;
      node.appendChild(img);
    }
    /* 真图有真实宽高：占位用的估算比例撤掉，避免横版页被拉成竖版 */
    node.style.aspectRatio = "";
    if (meta && meta.width && meta.height) {
      s.ratio = meta.width / meta.height;
      s.ratios[n] = s.ratio;
    }
    if (img.getAttribute("src") !== dataUrl) img.src = dataUrl;
  }

  /* 需要某页：命中缓存直接贴图，否则排队渲 */
  function requestPage(n) {
    var s = cur;
    if (!s || !s.nodes || !s.nodes.length) return;
    if (n < 1 || n > s.nodes.length) return;
    var hit = cacheGet(s.path, n);
    if (hit) {
      var node = s.nodes[n - 1];
      if (!node.querySelector("img")) fill(n, hit);
      return;
    }
    if (s.loading[n] || s.failed[n]) return;
    if (s.queue.indexOf(n) < 0) {
      s.queue.push(n);
      markLoading(n, true);
    }
    pump();
  }

  /* 一次只渲一页，排队按「离当前页远近」排序：快速滚动时不至于把中间页全渲一遍 */
  function pump() {
    var s = cur;
    if (!s || s.busy || !s.queue.length) return;
    var base = s.current || 1;
    s.queue.sort(function (a, b) {
      return Math.abs(a - base) - Math.abs(b - base);
    });
    var n = s.queue.shift();
    var hit = cacheGet(s.path, n);
    if (hit) {
      fill(n, hit);
      return pump();
    }
    var a = api();
    if (!a || typeof a.fileRenderPdfPages !== "function") {
      s.queue = [];
      setMsg(tt("当前窗口不支持页面渲染"), "is-err");
      return;
    }
    s.busy = true;
    s.loading[n] = true;
    markLoading(n, true);
    var done = function () {
      if (cur !== s) return;
      s.loading[n] = false;
      s.busy = false;
      pump();
    };
    a.fileRenderPdfPages({
      path: s.path,
      pages: [n],
      scale: RENDER_SCALE,
      maxWidth: RENDER_MAX_W,
      maxHeight: RENDER_MAX_H,
    })
      .then(function (r) {
        if (cur !== s) return;
        if (!r || r.ok === false) {
          var e = (r && r.error) || {};
          var msg =
            e.code === "password_required" || e.code === "encrypted"
              ? tt("这份 PDF 需要口令，应用内无法渲染页面 —— 请用系统阅读器打开")
              : e.message || tt("页面渲染失败");
          s.failed[n] = true;
          markFailed(n, String(msg));
          return;
        }
        if (!s.pages && r.pages) s.pages = r.pages;
        var im = (r.images || [])[0];
        if (!im || !im.dataUrl) {
          s.failed[n] = true;
          markFailed(n, tt("页面渲染失败"));
          return;
        }
        cachePut(s.path, n, im.dataUrl);
        fill(n, im.dataUrl, im);
      })
      .catch(function (err) {
        if (cur !== s) return;
        s.failed[n] = true;
        markFailed(n, String((err && err.message) || err));
      })
      .then(done, done);
  }

  /* 当前页 = 视口顶部最近的一页（只看可见集合，O(可见页数)） */
  function trackCurrent() {
    var s = cur;
    if (!s || !s.nodes || !s.nodes.length || !body) return;
    var top = body.getBoundingClientRect().top + 8;
    var best = s.current || 1;
    var bestD = Infinity;
    var cand = [];
    s.visible.forEach(function (n) {
      cand.push(n);
    });
    if (!cand.length) cand.push(s.current || 1);
    for (var i = 0; i < cand.length; i++) {
      var node = s.nodes[cand[i] - 1];
      if (!node) continue;
      var d = Math.abs(node.getBoundingClientRect().top - top);
      if (d < bestD) {
        bestD = d;
        best = cand[i];
      }
    }
    if (best !== s.current) {
      s.current = best;
      syncChrome();
    }
  }

  /* 缩放：zoom=1 即「适应宽度」，其余按同一基准换算成像素宽（位图本身不重渲） */
  function setZoom(z) {
    var s = cur;
    if (!s) return;
    s.zoom = Math.max(0.5, Math.min(4, Math.round(z * 100) / 100));
    applyWidths();
    if (footZoom) footZoom.textContent = Math.round(s.zoom * 100) + "%";
    syncChrome();
  }

  function gotoPage(n) {
    var s = cur;
    if (!s || !s.nodes || !s.nodes.length) return;
    var total = s.nodes.length;
    var v = Math.round(Number(n) || 0);
    if (!v) return;
    if (v < 1) v = 1;
    if (v > total) v = total;
    var node = s.nodes[v - 1];
    if (!node) return;
    requestPage(v);
    body.scrollTop = Math.max(0, node.offsetTop - 10);
    s.current = v;
    syncChrome();
  }

  /* 头部页码 + 底部页码输入 / 翻页按钮的可用态 */
  function syncChrome() {
    var s = cur || {};
    var total = s.pages || (s.nodes ? s.nodes.length : 0) || 0;
    var page = s.current || 1;
    if (footPage && footPage.tagName === "INPUT") {
      footPage.value = String(page);
      footPage.max = String(total || 0);
      footPage.disabled = !total;
    }
    if (titleEl) titleEl.textContent = s.path ? nameOf(s.path) : "PDF";
    var headPage = el && el.querySelector("#pdfPvHeadPage");
    if (headPage) headPage.textContent = total ? page + " / " + total : page + " / ?";
    var prev = el && el.querySelector("#pdfPvPrev");
    var next = el && el.querySelector("#pdfPvNext");
    if (prev) prev.disabled = page <= 1;
    if (next) next.disabled = !!total && page >= total;
  }

  /* ── 打开 / 关闭 ─────────────────────────────────────────────────────── */
  function openPdfPreview(path, opts) {
    var p = String(path || "").trim();
    if (!p) {
      warn(tt("文件不存在或无法预览"));
      return null;
    }
    var a = api();
    /* 主进程渲染通道不可用（老窗口 / 单独加载本文件）→ 退回系统阅读器，功能不回退 */
    if (!a || typeof a.fileRenderPdfPages !== "function" || typeof a.filePdfInfo !== "function") {
      openExternally(p);
      return null;
    }
    ensureEl();
    /* 先取文件戳再挂：同一路径的旧页面图 / 旧页数不能拿来顶新文件 */
    return stampOf(p).then(function (stamp) {
      mountPdf(p, opts, stamp);
      return null;
    });
  }

  /* 挂载 / 复用阅读会话：stamp 变了（同名文件被重新生成）就整份重建 */
  function mountPdf(p, opts, stamp) {
    var a = api();
    var same = !!(cur && cur.path === p && stamp && cur.stamp === stamp);
    if (!same) {
      cur = {
        path: p,
        stamp: stamp || "",
        pages: 0,
        zoom: 1,
        current: 1,
        ratio: 1 / Math.SQRT2, /* A4 竖版占位比例，首张真图回来后会校正 */
        cache: new Map(),
        ratios: {},
        nodes: [],
        loading: {},
        failed: {},
        queue: [],
        busy: false,
        visible: new Set(),
        opts: opts || {},
      };
      pagesEl.innerHTML = "";
      setMsg("");
      body.scrollTop = 0;
    } else if (opts) {
      cur.opts = opts;
    }
    /* 从 #mtDialog（z-index 2400）里开预览时临时抬一层，否则会被弹窗整片盖住 */
    el.classList.toggle("pdf-pv-top", !!(opts && opts.above));
    el.classList.add("on");
    applyWidths();
    syncChrome();
    var ikey = infoKeyOf(p, stamp);
    var ready = infoCache.get(ikey);
    if (ready) {
      applyInfo(p, ready);
      return null;
    }
    setMsg(tt("正在读取页数…"), "is-busy");
    a.filePdfInfo(p)
      .then(function (info) {
        var rec = {
          pages: (info && info.pages) || 0,
          encrypted: !!(info && info.encrypted),
          warning: (info && info.warning) || "",
          renderable: !(info && info.encrypted),
        };
        infoCache.set(ikey, rec);
        if (!cur || cur.path !== p) return;
        applyInfo(p, rec);
      })
      .catch(function (err) {
        if (!cur || cur.path !== p) return;
        setMsg(String((err && err.message) || err), "is-err");
      });
    return null;
  }

  function applyInfo(p, rec) {
    var s = cur;
    if (!s || s.path !== p) return;
    if (!rec.renderable) {
      s.pages = 0;
      pagesEl.innerHTML = "";
      s.nodes = [];
      setMsg(rec.warning || tt("这份 PDF 需要口令，应用内无法渲染页面 —— 请用系统阅读器打开"), "is-err");
      syncChrome();
      return;
    }
    s.pages = rec.pages || 0;
    setMsg("");
    if (!s.pages) {
      setMsg(tt("这份 PDF 没有可渲染的页面 —— 请用系统阅读器打开"), "is-err");
      return;
    }
    if (s.nodes.length !== s.pages) {
      buildPages(s.pages);
      var keep = Math.min(Math.max(1, s.current || 1), s.pages);
      gotoPage(keep);
    }
    /* 兜底：观察器在浮层从 display:none 转出来时可能还没来得及回调，先主动渲当前页 */
    requestPage(s.current || 1);
    syncChrome();
  }

  function closePdfPreview() {
    if (el) {
      el.classList.remove("on");
      el.classList.remove("pdf-pv-top");
    }
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
  }

  /* 键盘：上下 / PgUp·PgDn / 空格 = 连续滚动（与滚轮一致），左右 = 整页跳，Esc 关闭。
     在页码输入框里打字时不抢键。 */
  document.addEventListener("keydown", function (ev) {
    if (!el || !el.classList.contains("on") || !cur) return;
    var t = ev.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) {
      if (ev.key === "Escape") {
        t.blur();
        closePdfPreview();
      }
      return;
    }
    var step = Math.max(80, Math.round(body.clientHeight * 0.9));
    if (ev.key === "Escape") {
      closePdfPreview();
      ev.preventDefault();
    } else if (ev.key === "ArrowDown") {
      body.scrollBy(0, 120);
      ev.preventDefault();
    } else if (ev.key === "ArrowUp") {
      body.scrollBy(0, -120);
      ev.preventDefault();
    } else if (ev.key === "PageDown" || ev.key === " ") {
      body.scrollBy(0, ev.key === " " ? step : step);
      ev.preventDefault();
    } else if (ev.key === "PageUp") {
      body.scrollBy(0, -step);
      ev.preventDefault();
    } else if (ev.key === "ArrowRight") {
      gotoPage((cur.current || 1) + 1);
      ev.preventDefault();
    } else if (ev.key === "ArrowLeft") {
      gotoPage((cur.current || 1) - 1);
      ev.preventDefault();
    } else if (ev.key === "Home") {
      gotoPage(1);
      ev.preventDefault();
    } else if (ev.key === "End") {
      gotoPage(cur.pages || 1);
      ev.preventDefault();
    } else if (ev.key === "+" || ev.key === "=") {
      setZoom((cur.zoom || 1) + 0.25);
      ev.preventDefault();
    } else if (ev.key === "-" || ev.key === "_") {
      setZoom((cur.zoom || 1) - 0.25);
      ev.preventDefault();
    }
  });

  /* 窗口尺寸变化：适应宽度那一档要跟着重算（手动缩放过就按新基准重排） */
  window.addEventListener("resize", function () {
    if (!el || !el.classList.contains("on")) return;
    applyWidths();
  });

  window.openPdfPreview = openPdfPreview;
  window.closePdfPreview = closePdfPreview;
  /* 同名 PDF 被重写过 → 作废缓存（保存节点落盘后调） */
  window.invalidatePdfPreview = invalidatePdfPreview;
})();
