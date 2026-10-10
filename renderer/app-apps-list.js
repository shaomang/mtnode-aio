/* ============================================================================
 * 应用 · 库 · 我的应用 —— 列表模式（类似 Steam：左列表 + 右详情）与内嵌详情面板
 *   renderer/app-apps-list.js · 样式 css/apps.css 的 .apps-list* / .apps-panel*
 *
 * 为什么单开一个文件（而不是塞进 app-apps.js）：
 *   app-apps.js 已经有 6900 行、承担卡片网格 / 目录 / 版本树 / 对话框；列表模式是**另一种
 *   版式**，它需要的东西恰好都是 app-apps.js 已经对外挂好的那些函数（window.appsXxx）。
 *   本文件因此**自包含、零依赖**：只按名字探测调用 app-apps.js 的公有出口，读不到就如实
 *   降级（不抛错、不白屏），这样它可以在 app-apps.js 之后随意加载、也能单独被冒烟脚本加载。
 *
 * 三条口径（用户共识，见本轮拷问）：
 *   ① 左列 = 固定宽度的可滚动条目列表，右列 = 剩余宽度放详情；左右各自滚动；
 *   ② 点条目 → 右侧**内嵌**详情面板（不弹窗），面板内容与详情窗一致：
 *      左图画廊 + 右列（描述 / 分支 / 打赏 / 本机版本回滚 / 上架状态 / 开发者信息）+ 下方评论
 *      + 底部按钮（左下动作、右下关闭——关闭只在窗里，面板不需要）；
 *   ③ 切换状态写本机 localStorage、**按页分别记住**（apps / lib / mine 各记各的）。
 * ==========================================================================*/
(function () {
  "use strict";

  /* ── 视图模式（列表 / 网格）：按页分别记住 ──────────────────────────────
     key 里带版本号（v1）：以后改了语义就是换 key，老值自然作废。 */
  var VIEW_KEY = "mtnode.apps.view.v1";
  var MODES = { apps: 1, lib: 1, mine: 1 }; /* 只有这三页有列表模式（开发页是三栏开发台） */
  var VIEW = null; /* { apps:"grid"|"list", … }，首次读盘时填 */

  function readView() {
    if (VIEW) return VIEW;
    VIEW = { apps: "grid", lib: "grid", mine: "grid" };
    try {
      var raw = window.localStorage ? window.localStorage.getItem(VIEW_KEY) : "";
      var j = raw ? JSON.parse(raw) : null;
      if (j && typeof j === "object") {
        for (var k in MODES) if (j[k] === "list" || j[k] === "grid") VIEW[k] = j[k];
      }
    } catch (_) {}
    return VIEW;
  }
  function writeView() {
    try {
      if (window.localStorage) window.localStorage.setItem(VIEW_KEY, JSON.stringify(readView()));
    } catch (_) {}
  }
  /** 这一页现在是列表模式吗（开发页恒 false：它没有列表模式） */
  function isListMode(nav) {
    return !!MODES[nav] && readView()[nav] === "list";
  }
  /** 切换某一页的视图模式（写完落盘） */
  function toggleView(nav) {
    if (!MODES[nav]) return false;
    var v = readView();
    v[nav] = v[nav] === "list" ? "grid" : "list";
    writeView();
    return v[nav] === "list";
  }
  /** 视图切换钮（壳的第 1 行：刷新右边那一枚）——文案随当前模式给「下一步动作」 */
  function toggleBtnEl(nav) {
    var list = isListMode(nav);
    var b = document.createElement("button");
    b.type = "button";
    b.className = "mini apps-hub-viewbtn apps-ico-btn";
    b.id = "appsViewToggle";
    b.dataset.appsView = list ? "list" : "grid";
    b.innerHTML = list ? ICON.rows : ICON.grids;
    b.title = list ? appsTr("切回卡片网格视图") : appsTr("切换成列表视图（左列表 + 右详情）");
    b.setAttribute("aria-label", b.title);
    b.setAttribute("aria-pressed", list ? "true" : "false");
    b.onclick = function (ev) {
      if (ev) ev.preventDefault();
      var now = toggleView(nav);
      if (typeof appsToast === "function") {
        appsToast(appsTr(now ? "已切换成列表视图" : "已切换成卡片视图"), "ok");
      }
      if (typeof appsHubPaint === "function") appsHubPaint();
    };
    return b;
  }

  /* 内联图标（与 app-apps.js 的 APPS_ICO_SVG 同一份口径：16 viewBox、stroke=currentColor） */
  var ICON = {
    grids:
      '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9" y="2" width="5" height="5" rx="1"/><rect x="2" y="9" width="5" height="5" rx="1"/><rect x="9" y="9" width="5" height="5" rx="1"/></svg>',
    rows:
      '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.6 3.6h10.8"/><path d="M2.6 8h10.8"/><path d="M2.6 12.4h10.8"/></svg>',
    gear:
      '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.6 4.4h10.8"/><path d="M4.6 8h6.8"/><path d="M6.6 11.6h2.8"/></svg>',
    back:
      '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6.4 3.2 2.8 8l3.6 4.8"/><path d="M2.8 8h10.4"/></svg>',
  };

  /* 翻译出口：app-apps.js 的 appsT 是那一层专用的（词条表同名），这里只在缺失时退回 I18n.t */
  function appsTr(s, vars) {
    if (typeof window.appsT === "function") return window.appsT(s, vars);
    if (window.I18n && typeof window.I18n.t === "function") return window.I18n.t(s, vars);
    return String(s == null ? "" : s);
  }

  /* ── 虚拟列表（长列表不能一次建上千个 DOM：与应用页的窗口化网格同一纪律） ──
     与 app-apps.js 的 appsVirtualGridMount 的差别只有两点：列宽恒 100%（一个 item 一行），
     以及 item 由调用方自建（列表行 / 卡片都行）。宿主必须 position:relative + 自己滚动。 */
  var VLIST = null;

  function listDispose() {
    if (!VLIST) return;
    try {
      VLIST.dispose();
    } catch (_) {}
    VLIST = null;
  }

  function listMount(host, list, opts) {
    var o = opts || {};
    listDispose();
    var items = Array.isArray(list) ? list.slice() : [];
    if (!host || !items.length) return null;
    var wrap = document.createElement("div");
    wrap.className = "apps-vlist";
    host.appendChild(wrap);
    var GAP = 6;
    var BUFFER = 4;
    var rows = []; /* 已知行高（首帧后统一） */
    var els = new Map(); /* idx -> el */
    var rowH = 0;
    var raf = 0;

    function measure() {
      if (rowH > 0) return;
      var est = Number(o.rowHeight) || 0;
      rowH = est > 0 ? est : 0;
    }
    function build(i) {
      var el = o.itemEl ? o.itemEl(items[i], i) : document.createElement("div");
      el.classList.add("apps-vlist-item");
      wrap.appendChild(el);
      return el;
    }
    function render() {
      raf = 0;
      var top = host.scrollTop || 0;
      var vh = host.clientHeight || 400;
      /* 行高未知（首帧）：先建第 1 行量真实行高，再按它排（列表行高度确定，不必反复校正） */
      if (!rowH) {
        var probe = build(0);
        els.set(0, probe);
        rowH = probe.offsetHeight || Number(o.rowHeight) || 56;
      }
      var first = Math.max(0, Math.floor(top / (rowH + GAP)) - BUFFER);
      var last = Math.min(items.length - 1, Math.floor((top + vh) / (rowH + GAP)) + BUFFER);
      wrap.style.height = items.length * (rowH + GAP) + "px";
      var keep = new Set();
      for (var i = first; i <= last; i++) {
        keep.add(i);
        var el = els.get(i);
        if (!el) {
          el = build(i);
          els.set(i, el);
        }
        el.style.transform = "translateY(" + i * (rowH + GAP) + "px)";
      }
      els.forEach(function (el, idx) {
        if (keep.has(idx)) return;
        els.delete(idx);
        if (el.parentNode) el.parentNode.removeChild(el);
      });
    }
    function schedule() {
      if (raf) return;
      raf = window.requestAnimationFrame(render);
    }
    /* 首帧：先量一行真实高度，再排（列表行高度是确定的，不必反复校正） */
    measure();
    render();
    host.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    var ro = window.ResizeObserver ? new ResizeObserver(schedule) : null;
    if (ro) {
      try {
        ro.observe(host);
      } catch (_) {}
    }
    VLIST = {
      dispose: function () {
        host.removeEventListener("scroll", schedule);
        window.removeEventListener("resize", schedule);
        if (ro) {
          try {
            ro.disconnect();
          } catch (_) {}
        }
        if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
      },
    };
    return VLIST;
  }

  /* ── 列表行（左列条目） ─────────────────────────────────────────────────
     一行 = 图标 + 名称 + 作者 + 右侧版本 / 时间那一栏。封面图仍走 app-apps.js 的
     appsIconEl（懒加载 + 占位都归它），这里不重复一套。 */
  function rowEl(spec, opts) {
    var o = opts || {};
    var id = String((spec && spec.id) || "");
    var name = typeof appsSpecTitle === "function" ? appsSpecTitle(spec) : String((spec && spec.name) || id);
    var row = document.createElement("button");
    row.type = "button";
    row.className = "apps-lrow";
    row.dataset.appId = id;
    row.setAttribute("aria-label", name);
    var ico = document.createElement("span");
    ico.className = "apps-lrow-ico";
    if (typeof appsIconEl === "function") {
      var im = appsIconEl(spec, name, "apps-lrow-img");
      if (im) ico.appendChild(im);
    }
    row.appendChild(ico);
    var main = document.createElement("span");
    main.className = "apps-lrow-main";
    var t = document.createElement("span");
    t.className = "apps-lrow-t";
    t.textContent = name;
    t.title = name;
    main.appendChild(t);
    var who = typeof appsAuthorOf === "function" ? String(appsAuthorOf(spec) || "") : "";
    if (who) {
      var w = document.createElement("span");
      w.className = "apps-lrow-who";
      w.textContent = who;
      w.title = who;
      main.appendChild(w);
    }
    row.appendChild(main);
    /* 右栏：库页给「最后一次运行」，其余页给云端最新版（缺哪个都不硬编） */
    var meta = document.createElement("span");
    meta.className = "apps-lrow-meta";
    var local = typeof appsLocalById === "function" ? appsLocalById(id) : null;
    var rel = Number((local && local.lastRunAt) || 0);
    var ver = String((spec && (spec.latestVersion || spec.version)) || (local && local.version) || "");
    if (o.sort === "lastRun" && typeof appsLastRunText === "function") {
      meta.textContent = appsLastRunText(rel);
      meta.title = meta.textContent;
    } else if (ver) {
      meta.textContent = "v" + ver;
    }
    row.appendChild(meta);
    if (spec && spec.dev === true) {
      var dv = document.createElement("span");
      dv.className = "apps-badge";
      dv.textContent = appsTr("开发中");
      row.appendChild(dv);
    }
    return row;
  }

  /* ── 全局唯一的活动面板（切页 / 重绘时由页面重新登记） ── */
  var PANEL = null; /* 面板状态对象（{ id, paint, ver, verSeq, … }） */

  function panelDrop(id) {
    if (!PANEL) return;
    if (id == null || String(id) === PANEL.id) PANEL = null;
  }
  function currentPanel() {
    return PANEL;
  }

  /* 悬停/选中态：选中行高亮（重绘时由页面用 setPanel 重新登记） */
  function markRow(el, on) {
    if (!el) return;
    el.classList.toggle("on", !!on);
    el.setAttribute("aria-current", on ? "true" : "false");
  }

  /* ── 面板：把「详情方块」拼成左图 + 右列 + 下方评论 ─────────────────────
     右列的各块**全部复用 app-apps.js 已有的元件**（描述 / 分支树 / 打赏记录 / 回滚 /
     开发者信息 / 上架提示），所以面板与详情窗的内容永远一致、不必写第二份。 */
  function panelEl(host, spec, opts) {
    var o = opts || {};
    var id = String((spec && spec.id) || "");
    if (!host || !id) return null;
    var st = { id: id, spec: spec, ver: null, verSeq: 0, right: null, ownerId: "" };
    var holder = document.createElement("div");
    holder.className = "apps-panel-holder";
    host.appendChild(holder);

    var media = document.createElement("div");
    media.className = "apps-panel-media";
    holder.appendChild(media);
    var col = document.createElement("div");
    col.className = "apps-panel-col";
    holder.appendChild(col);
    var head = document.createElement("div");
    head.className = "apps-detail-head";
    col.appendChild(head);
    var right = document.createElement("div");
    right.className = "apps-detail-who apps-panel-who";
    col.appendChild(right);
    st.right = right;

    var cmt = document.createElement("div");
    cmt.className = "apps-panel-cmt";
    holder.appendChild(cmt);
    st.cmt = cmt;
    var foot = document.createElement("div");
    foot.className = "apps-panel-foot";
    holder.appendChild(foot);
    st.foot = foot;

    st.paint = function () {
      /* 右列的各块（描述 / 分支树 / 打赏 / 本机版本回滚 / 上架状态 / 开发者信息）与详情窗
         **同一份实现**（app-apps.js 的 appsDetailRightColEl）：面板与窗里永远一致。
         把 current 指针挂上去是为了分支树点选能回画这一格（见 app-apps.js 的 APPS_DETAIL_CTX）。 */
      /* 当前选中的那条分支：与详情窗同源 —— 「分支 / 版本」跳窗里选过就记在
         appsPickOf（APPS_PICK）里，没选过回原作者。面板自己那一次点选（st.ownerId）兜底。 */
      var selKey = "";
      try {
        selKey = typeof appsPickOf === "function" ? appsPickOf(st.id).key || "" : "";
      } catch (_) {}
      var ctx = {
        id: st.id,
        /* ★ panel: st —— appsDetailSelKey 会读 ctx.panel.ownerId，于是下面的
           appsDetailSpecOf(id) 回的就是**面板里选中的那条分支**（左列截图 / 作者行 / 说明 /
           评论区都跟着它走）。少了这一项，面板永远画主干那份 spec —— 用户报的
           「切到别的作者分支，截图还是老那位作者的」正是这里。 */
        panel: st,
        branchOwnerId: selKey || String(st.ownerId || ""),
        setBranch: function (key) {
          st.ownerId = String(key || "");
          st.paint();
        },
        repaint: function () {
          st.paint();
        },
      };
      var prev = window.APPS_DETAIL_CTX || null;
      window.APPS_DETAIL_CTX = ctx;
      /* 当前选中的那条分支条目（拿不到就退回调用方给的 spec） */
      var cur = st.spec;
      try {
        if (typeof appsDetailSpecOf === "function") cur = appsDetailSpecOf(st.id) || st.spec;
        if (typeof appsDetailMediaEl === "function") {
          media.innerHTML = "";
          media.appendChild(appsDetailMediaEl(cur, typeof appsLocalById === "function" ? appsLocalById(st.id) : null, st.title || ""));
        }
        head.innerHTML = "";
        right.innerHTML = "";
        var local = typeof appsLocalById === "function" ? appsLocalById(st.id) : null;
        var name = st.title || String((cur && (cur.name || cur.id)) || "");
        right.appendChild(appsDetailNameEl(name));
        right.appendChild(appsDetailInfoRowsEl(cur, local));
        /* 说明 / 分支树 / 打赏 / 编辑 / 开发者信息：与详情窗**同一份实现**
           （app-apps.js 的 appsDetailBodyEl 的 head 路径）—— 面板与窗里永远一致。 */
        if (typeof appsDetailBodyEl === "function") {
          var body = appsDetailBodyEl(cur, { app: local || undefined, noVers: true, head: true });
          if (body) right.appendChild(body);
        }
        /* 回滚那一格的占位：台账回来时就地替换它，不整块重画右列（否则刚写了一半的评论框会被拆掉） */
        var roll = document.createElement("div");
        roll.className = "apps-panel-roll";
        right.appendChild(roll);
        st.roll = roll;
        /* 评论区：目标 = **当前选中的那条分支**（app-apps.js 的 appsCommentTarget）——
           切分支整块换成那一支的评论，草稿由 appsCommentsMountInto 原样保住。
           以前只挂一次（st.cmtMounted），切分支后整个评论区不动，评论也就分不开。 */
        if (st.cmt && cur && cur.id && typeof appsCommentsMountInto === "function") {
          var cmtTarget = typeof appsCommentTarget === "function" ? appsCommentTarget(cur) : null;
          if (cmtTarget) {
            /* 挂载本身会整块重画（切分支 = 换成那一支的评论）并保住草稿；
               宿主被别处清过时靠 appsCommentsMountInto 的 DOM 判据自己补挂回来。 */
            appsCommentsMountInto(st.cmt, cmtTarget, { title: st.title || "" }, selKey || st.ownerId || cmtTarget.ownerId);
          } else if (typeof appsCommentsClearHost === "function") {
            /* 本机自建 / 还没上架（云端没有这条）→ 不挂评论区：
               清场必须走它（DOM 与记账一起清），否则换到有云端的应用时记账会拦下重挂。 */
            appsCommentsClearHost(st.cmt);
          } else {
            st.cmt.innerHTML = "";
          }
        }
      } finally {
        window.APPS_DETAIL_CTX = prev || null;
      }
      appsPanelPatchRoll(st);
      appsPanelPaintFoot(st);
      return st;
    };

    /* 底栏（左下动作 / 右下关闭只在窗里）——上下两块都在 foot 里左右分列 */
    st.idOf = function () {
      return st.id;
    };
    st.holder = holder;
    st.mediaEl = media;
    st.colEl = col;
    st.footEl = foot;
    return st;
  }

  /* 本机版本回滚那一格：台账（apps:versions）回来后**只替换这一格** ——
     整块重画右列会把评论框里刚写了一半的字拆掉。 */
  function appsPanelPatchRoll(st) {
    if (!st || !st.roll) return;
    st.roll.innerHTML = "";
    if (typeof appsLocalRollbackEl !== "function") return;
    var prev = window.APPS_DETAIL_CTX || null;
    window.APPS_DETAIL_CTX = {
      id: st.id,
      /* 与 st.paint 同一份口径（选中分支 / 面板归属）：回滚那一块也按选中的那一支画 */
      panel: st,
      ver: st.ver,
      branchOwnerId: String(st.ownerId || ""),
      setBranch: function () {},
      repaint: function () {
        appsPanelPatchRoll(st);
      },
    };
    try {
      var el = appsLocalRollbackEl(st.id);
      if (el) st.roll.appendChild(el);
    } finally {
      window.APPS_DETAIL_CTX = prev || null;
    }
  }

  /* 面板底栏：左下 = 运行 / 下载、二次开发、数据目录、卸载（+ 回滚），
     右侧 = 「在独立窗口里打开详情」（面板不是窗，没有「关闭」，但给一条去窗口的路）。 */
  function appsPanelPaintFoot(st) {
    var foot = st.foot;
    if (!foot) return;
    foot.innerHTML = "";
    var left = document.createElement("div");
    left.className = "apps-panel-foot-l";
    var local = typeof appsLocalById === "function" ? appsLocalById(st.id) : null;
    if (local) {
      left.appendChild(appsMini(appsTr("运行"), function () {
        if (typeof appsOpenApp === "function") appsOpenApp(st.id);
      }, true));
      var dir = appsMini("📂 " + appsTr("数据目录"), function () {
        if (typeof appsDataOpenNow === "function") appsDataOpenNow(st.id);
      });
      dir.title = appsTr("打开这个应用的数据目录（默认在 MTNode 数据目录下按应用 id 建）");
      left.appendChild(dir);
      if (typeof appsSecondaryDevBtnEl === "function") left.appendChild(appsSecondaryDevBtnEl(local || { id: st.id }));
      var isDev = !!(local.dev === true || local.kind === "dev");
      var un = appsMini(appsTr(isDev ? "移除登记" : "卸载"), function () {
        if (typeof appsUninstallApp === "function") appsUninstallApp(local || { id: st.id });
      });
      if (!isDev) un.classList.add("danger");
      un.title = isDev
        ? appsTr("只移除登记：项目文件夹与里面的文件一个都不会删（要删文件请自己在资源管理器里删）")
        : appsTr("卸载只删它在下载根下的子文件夹与它自己那一棵树，项目根与开发数据一概不动");
      left.appendChild(un);
    } else {
      var dl = appsMini(appsTr("下载到本机"), function () {
        if (typeof appsDownload === "function") appsDownload(st.id, "", "", st.ownerId || "");
      }, true);
      left.appendChild(dl);
    }
    foot.appendChild(left);
    var r = document.createElement("div");
    r.className = "apps-panel-foot-r";
    var open = appsMini(appsTr("在独立窗口里看详情"), function () {
      if (typeof window.openAppsDetail === "function") window.openAppsDetail(st.id);
    });
    open.title = appsTr("同样的内容在一只可调宽高的窗口里打开");
    r.appendChild(open);
    foot.appendChild(r);
  }

  /* ── 面板要用的小元件（能复用 app-apps.js 的就复用，这里只补面板专有的两三个） ── */
  function appsMini(text, onclick, primary) {
    if (typeof appsMiniBtn === "function") {
      var b = appsMiniBtn(text, onclick, !!primary);
      return b;
    }
    var el = document.createElement("button");
    el.type = "button";
    el.className = "mini" + (primary ? " primary" : "");
    el.textContent = text;
    el.onclick = onclick;
    return el;
  }
  function appsDetailNameEl(name) {
    var h = document.createElement("div");
    h.className = "apps-detail-name";
    h.textContent = name;
    h.title = name;
    return h;
  }
  /** 名称下面那几行（应用名 / 作者 / 更新时间 / 版本 / 大小 / 标签 / 二次开发来源） */
  function appsDetailInfoRowsEl(spec, local) {
    if (typeof appsDetailWhoEl === "function") {
      var who = appsDetailWhoEl(spec, local, "");
      /* appsDetailWhoEl 自带名称行（面板上面已经画了一份）：只取它里面的信息行 */
      var rows = who.querySelector ? who.querySelector(".apps-detail-info") : null;
      if (rows) return rows;
      return who;
    }
    var box = document.createElement("div");
    box.className = "apps-detail-info";
    return box;
  }

  /* ── 页内列表模式：左列表 + 右面板（三个页面共用同一份装配） ───────────────
     opts.items / opts.rowEl(spec, i) / opts.panelSpec(spec) / opts.sortKey / opts.emptyText
     返回 { panel } —— 调用方不用管内部状态，重绘整页时重新调用即可。 */
  function mountListMode(body, opts) {
    var o = opts || {};
    var items = Array.isArray(o.items) ? o.items : [];
    var box = document.createElement("div");
    box.className = "apps-listmode";
    body.appendChild(box);
    var side = document.createElement("div");
    side.className = "apps-list-side";
    box.appendChild(side);
    var mainScroll = document.createElement("div");
    mainScroll.className = "apps-panel-scroll";
    box.appendChild(mainScroll);

    if (!items.length) {
      var empty = document.createElement("div");
      empty.className = "apps-empty";
      empty.textContent = o.emptyText || appsTr("无内容");
      mainScroll.appendChild(empty);
      return { panel: null, box: box, side: side, main: mainScroll };
    }

    var picked = null;
    var makeRow = function (spec, i) {
      var el = o.rowEl ? o.rowEl(spec, i) : rowEl(spec, i);
      el.classList.add("apps-lrow-btn");
      el.addEventListener("click", function () {
        pick(spec, el);
      });
      return el;
    };
    function pick(spec, el) {
      if (picked && picked.el && picked.el !== el) markRow(picked.el, false);
      picked = { spec: spec, el: el };
      markRow(el, true);
      panelDrop(null);
      mainScroll.innerHTML = "";
      var ps = o.panelSpec ? o.panelSpec(spec) : spec;
      var st = panelEl(mainScroll, ps, { sortKey: o.sortKey });
      PANEL = st;
      if (st) {
        st.title = typeof appsSpecTitle === "function" ? appsSpecTitle(ps) : "";
        /* 当前选择那一支：与详情窗同源（app-apps.js 的 appsPickOf —— 在「分支 / 版本」跳窗里
           选过就用它，没选过回原作者），面板右列的说明 / 作者行才不会与外面那行动作条打架。 */
        st.ownerId =
          typeof appsPickOf === "function" ? appsPickOf(st.id).key || "" : String((ps && ps.ownerId) || "");
        st.paint();
        loadVersions(st);
      }
    }

    listMount(side, items, { itemEl: makeRow, rowHeight: o.rowHeight });
    /* 首个条目默认选中（Steam 也是这个手感：进来右列不是空的） */
    var first = side.querySelector(".apps-lrow-btn");
    if (first) pick(items[0], first);
    return { panel: PANEL, box: box, side: side, main: mainScroll };
  }

  /** 面板自己的本机台账（回滚那一块要）：与详情窗同一个 IPC，回来只重画面板 */
  function loadVersions(st) {
    var api = window.api || {};
    if (!st || typeof api.appsVersions !== "function") return;
    var seq = ++st.verSeq;
    api.appsVersions(st.id).then(
      function (r) {
        if (seq !== st.verSeq || !PANEL || PANEL !== st) return;
        st.ver = r && r.ok !== false ? r : null;
        st.paint();
      },
      function () {}
    );
  }

  /* ── 库页的「应用目录」小菜单（紧挨刷新那一枚按钮，点击展开） ─────────────
     两个动作：更改目录（走 appsRootPickNow("down")）/ 在资源管理器中打开（appsRootFolderNow）。
     浮层纪律：这是一只**瞬态菜单**（没有待提交的输入），所以点外部即收 —— 与右键菜单同类。 */
  function rootMenuEl(anchor) {
    var menu = document.createElement("div");
    menu.className = "apps-rootmenu";
    var path = "";
    try {
      var roots = (window.APPS_ST && APPS_ST.list && APPS_ST.list.roots) || {};
      path = String(((roots.down || (window.APPS_ST && APPS_ST.root) || {}) || {}).path || "");
    } catch (_) {}
    var head = document.createElement("div");
    head.className = "apps-rootmenu-path";
    /* 路径永远有（根目录默认就在画布所在的数据目录下，本轮需求：不再要求手选）——
       path 为空只可能是应用中心还没把 roots 拉回来，兜一句中性的「未设置」。 */
    head.textContent = path || appsTr("未设置");
    head.title = path;
    menu.appendChild(head);
    menu.appendChild(
      appsMini(appsTr("更改目录…"), function () {
        close();
        if (typeof appsRootPickNow === "function") appsRootPickNow("down");
      })
    );
    menu.appendChild(
      appsMini("📂 " + appsTr("在资源管理器中打开"), function () {
        close();
        if (typeof appsRootFolderNow === "function") appsRootFolderNow("down");
      })
    );
    function close() {
      document.removeEventListener("mousedown", onDoc, true);
      document.removeEventListener("keydown", onKey, true);
      if (menu.parentNode) menu.parentNode.removeChild(menu);
    }
    function onDoc(ev) {
      if (menu.contains(ev.target) || (anchor && anchor.contains(ev.target))) return;
      close();
    }
    function onKey(ev) {
      if (ev.key === "Escape") close();
    }
    menu.__appsClose = close;
    return { el: menu, close: close, bind: function () {
      document.addEventListener("mousedown", onDoc, true);
      document.addEventListener("keydown", onKey, true);
    } };
  }

  /* 页面重绘时把还开着的根目录菜单收掉（它挂在壳上，不随正文重绘消失） */
  function closeRootMenu() {
    var m = document.querySelector(".apps-rootmenu");
    if (m && typeof m.__appsClose === "function") m.__appsClose();
    else if (m && m.parentNode) m.parentNode.removeChild(m);
  }

  window.AppsList = {
    ICON: ICON,
    isListMode: isListMode,
    toggleView: toggleView,
    toggleBtnEl: toggleBtnEl,
    rowEl: rowEl,
    panelEl: panelEl,
    mountListMode: mountListMode,
    listMount: listMount,
    listDispose: listDispose,
    markRow: markRow,
    panelDrop: panelDrop,
    currentPanel: function () {
      return PANEL;
    },
    rootMenuEl: rootMenuEl,
    closeRootMenu: closeRootMenu,
    GEAR: ICON.gear,
  };
})();
