/* ============================================================================
   app-browser.js — 会话主内容右边栏「浏览器活动」+ 会话自己的浏览器控制面

   用户已确认的口径（本功能块的开发任务书与拷问共识）：
     · 观察面＝独立浏览器窗口 + **会话主内容右边栏**（第三栏）的「浏览器活动」：
       活动流同时把浏览器动作、shell 命令（含输出摘要）与文件读写摘要摊开，供人
       事后核对；**不被调用或启动时整条不显示**（hidden + 不占宽度），会话左栏与
       对话框照旧，旧界面一字不差（本轮需求）；
     · 入口＝会话输入区那枚「浏览器活动」chip（#agentBrowserChip）与
       window.openBrowserActivityPanel()；面板自带 DOM（index.html #baPanel）；
     · **这条栏属于当前会话**（本轮需求）：活动流按当前会话过滤、切会话即切换，
       当前会话没有浏览器（事件里没见过它的浏览器活动 / 网关没说它驱动着浏览器 /
       库里查不到它的浏览器类历史）就整条收起；实况画面只给持有驱动锁的那条会话看。
       会话 id = 渲染层会话 id（as…），由 app-assist.js 的 agentViewId() 现取，
       落库条目也按它盖章（见 dsh/gateway 的 hostSessionId）；写操作 / 显隐一律由
       BA.setSession 收口 —— 认不出会话时（老壳 / 单文件冒烟）退回旧口径，不劣化。
     · 活动流只进面板 / 落库（activity-store.js），**不进模型上下文**；
     · 面板上给「打开浏览器」入口（可先手动登录）、「接管 / 交还」与域名名单编辑；
     · 全量动作留痕 + 危险动作审批 + 域名名单＝固定几类可控项（不另造规则引擎）。

   本文件自包含：只经 window.api 的桥说话，调用期取 I18n / toast / agentSessions
   （app-db.js）与 openOverlay（app.js），不反向依赖它们的加载顺序。
   ========================================================================== */
"use strict";

(function () {
  const $ = (s) => document.querySelector(s);
  const T = (zh, en) => {
    try {
      if (window.I18n && typeof window.I18n.t === "function") return window.I18n.t(zh);
    } catch (_) {}
    return zh;
  };
  const toastSafe = (msg, kind) => {
    try { if (typeof window.toast === "function") window.toast(msg, kind || "ok"); } catch (_) {}
  };

  const BA = {
    rows: [],            // 最近的活动（内存滚动样本，落库是异步的）
    total: 0,
    running: false,
    /* 这一只是**无窗口（后台）**起的（会话自动拉起的默认形态，见 dsh/gateway/browser-host.mjs
       的 launchArgs）：面板据此收起「独立窗口」按钮并说明「想看真窗口点打开浏览器」。 */
    headless: false,
    takeover: false,
    policy: { blocked: [], confirm: [], approveDangerous: true },
    /* ── 会话绑定（本轮需求：活动与浏览器跟随当前会话）─────────────────────
       sessionId = 当前绑定的**渲染层会话 id**（agentSessions 里的 as…）：
         · 活动流按它过滤（落库的条目也按它盖章，见 dsh/gateway 的 hostSessionId）；
         · 它的有没有浏览器决定这条栏显不显（没浏览器就整条不显示）。
       null = 还没人告诉过本模块当前会话（老壳 / 单文件冒烟）→ 退回旧口径。
       历史 bug：这里原本是一个从没被赋值过的 lastSessionId，于是 activityQuery 的
       sessionId 恒为空串 = 永远查全库，会话页与开发页看到的活动一模一样。 */
    sessionId: null,
    /* 本次运行里见过浏览器活动的会话（事件盖的章）——「本会话有没有浏览器」判据之一 */
    browserSessions: new Set(),
    /* 库里查出来的「本会话有浏览器」的那个会话 id（见 reload：只认样本里的浏览器类活动） */
    dbBrowserSession: "",
    /* 网关说浏览器此刻由哪条会话驱动（'' = 没有会话持锁 / 用户手动开的） */
    driver: "",
    /* 本次运行里用户对每条会话的显式取舍：true = 亲手开过，false = 亲手关过。
       切回同一会话尊重它；切到别的会话按「那个会话有没有浏览器」重算。
       （落盘的 mtnode.baOpen 仍是跨重启的记忆，两者互不覆盖。） */
    userChoice: new Map(),
    open: false,
    /* 用户这次运行里亲手关过右栏 → 不再自动弹（autoOpenForUse 的刹车之一） */
    userClosed: false,
    /* 用户这次运行里亲手开过右栏（AutoOpen 之外的显式意图，切会话时按它保留） */
    userOpened: false,
    autoOpenBusy: false,
    filter: "",
    /* 实况视图（右栏第三栏的「实况」区）：默认 dock，可切成独立窗口。
       mode 与网关的 viewMode 同源（applyStatus / applyView 会对齐）：**不落 localStorage** ——
       用户口径是「独立窗口」只当本次运行里的一次显式例外，重启浏览器 / 重开应用回到内部界面。 */
    live: {
      on: false,          // 流在跑（网关 startScreencast 成功）
      starting: false,    // 正在开流（单飞：同一拍重复 liveSync 只发一次 viewStart）
      paused: false,      // 「暂停观察」：只丢帧不关流
      mode: "docked",     // docked = 面板实况（真实窗口让位）；detached = 独立窗口（用户亲手点）
      seq: 0,
      w: 0,
      h: 0,
      dpr: 1,
      fallback: false,
      reason: "",
      frame: null,        // 待画的 Image（只留最新一帧，中间帧直接丢）
      painting: false,
      lastPaintAt: 0,
      frames: 0,
    },
  };
  window.BrowserAct = BA;  window.openBrowserActivityPanel = () => BA.openPanel();
  window.browserActivityOnEvent = (data) => BA.onEvent(data);
  window.browserActivityOnDrop = (data) => BA.onDrop(data);
  window.browserHelpOnEvent = (data) => BA.onHelpEvent(data);

  /* 会话动手用浏览器时该把右栏带出来的活动类型（shell / 文件摘要不在此列：
     那些不是「浏览器活动」，不该替用户弹第三栏） */
  const AUTO_OPEN_KINDS = {
    browser: 1, navigate: 1, click: 1, type: 1, key: 1, screenshot: 1,
    snapshot: 1, evaluate: 1, wait: 1, tabs: 1, takeover: 1, help: 1,
  };

  const KIND_LABEL = {
    browser: "浏览器",
    navigate: "导航",
    click: "点击",
    type: "输入",
    key: "按键",
    screenshot: "截图",
    snapshot: "读页",
    evaluate: "脚本",
    wait: "等待",
    tabs: "标签页",
    takeover: "接管",
    help: "求助",
    tool: "工具",
    "tool-result": "结果",
    shell: "命令",
    file: "文件",
    activity: "其它",
  };
  const KIND_GROUP = (k) => {
    const s = String(k || "");
    if (/^browser|^navigate|^click|^type|^key|^screenshot|^snapshot|^evaluate|^wait|^tabs|^takeover|^help/.test(s)) return "browser";
    if (/^(bash|pwsh|shell|execute|run|cmd|terminal)/.test(s)) return "shell";
    if (/^(read|write|edit|glob|grep|str_replace|fs_|file)/.test(s)) return "file";
    return "other";
  };
  const GROUP_LABEL = { browser: "浏览器", shell: "命令", file: "文件", other: "其它" };

  /* 一条活动算不算「浏览器活动」：网关的工具类行（kind = browser_launch / browser_click…）
     按前缀一并认，与 AUTO_OPEN_KINDS 同源。显隐判据（本会话有没有浏览器）也用它。 */
  const isBrowserKind = (k) => {
    const s = String(k || "");
    return !!AUTO_OPEN_KINDS[s] || s.startsWith("browser");
  };
  /* 「含其它会话」勾没勾：默认只看当前会话（勾上才查全库 / 显示别人的活动） */
  const allChecked = () => {
    try { const el = $("#baAll"); return !!(el && el.checked); } catch (_) { return false; }
  };

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
  function hhmmss(at) {
    try {
      const d = new Date(Number(at) || Date.now());
      return (
        String(d.getHours()).padStart(2, "0") + ":" +
        String(d.getMinutes()).padStart(2, "0") + ":" +
        String(d.getSeconds()).padStart(2, "0")
      );
    } catch (_) { return ""; }
  }

  /* ── 右边栏（会话主内容 · 第三栏）────────────────────────────────────────
     面板在 index.html 里自带完整 DOM（#baPanel，启动即建、hidden），这里只负责
     显隐与宽度：关着 = 不占宽度、不显示，.agent-pane 仍是原来那套两栏网格，旧界面
     一字不差（用户已确认口径）。宽度写 CSS 变量 --ba-w 并落 localStorage。 */
  const BA_W_DEFAULT = 340;
  const BA_W_MIN = 240;

  BA.width = function () {
    let w = BA_W_DEFAULT;
    try {
      const raw = Number(localStorage.getItem("mtnode.baW"));
      if (Number.isFinite(raw) && raw > 0) w = raw;
    } catch (_) {}
    /* 上限 = 会话主内容的一半：中栏（对话）永远留够宽度 */
    const pane = $("#agentPane");
    const half = pane && pane.clientWidth ? Math.round(pane.clientWidth / 2) : 640;
    return Math.max(BA_W_MIN, Math.min(half, Math.round(w)));
  };

  BA.applyWidth = function (w, persist) {
    const pane = $("#agentPane");
    const box = $("#baPanel");
    const px = Math.max(BA_W_MIN, Math.round(Number(w) || BA_W_DEFAULT));
    BA.w = px;
    if (pane) pane.style.setProperty("--ba-w", px + "px");
    if (box) box.style.width = px + "px";
    if (persist !== false) {
      try { localStorage.setItem("mtnode.baW", String(px)); } catch (_) {}
    }
  };

  /* ── 会话绑定：这条栏属于哪条会话 ─────────────────────────────────────────
     用户口径：活动与浏览器跟随当前会话 —— 切会话即切活动范围，当前会话没有浏览器
     就整条收起。会话 id 一律取渲染层那条（app-assist.js 的显示会话）：
       agentViewId()（开发页开着时 = 本页显示的会话）
       → S.agentActiveId → agentSessionState().id
     每个入口都 typeof 守卫 + try/catch：本文件单独被冒烟加载时这些全局都不存在，
     那时 currentSessionId() 返回空串 = 退回旧口径（按记忆恢复显隐），绝不因此藏栏。 */
  BA.currentSessionId = function () {
    const pick = (fn) => {
      try { const v = fn(); return v == null ? "" : String(v); } catch (_) { return ""; }
    };
    let sid = pick(typeof agentViewId === "function" ? agentViewId : null);
    if (!sid) sid = pick(() => (typeof S !== "undefined" && S ? S.agentActiveId : ""));
    if (!sid) sid = pick(() => (typeof agentSessionState === "function" ? agentSessionState().id : ""));
    /* 覆盖态下的占位空会话（开发页首轮）：不是真会话，按「没有会话」处理 */
    return sid.indexOf("\u0000") === 0 ? "" : sid;
  };

  /* 本会话有没有浏览器：内存里见过它的浏览器活动 ∪ 网关说浏览器由它驱动 ∪ 库里查出历史。
     库里那份只认 reload 拿回的那批样本（limit 400）——比这更早的历史不再追，够用且省一次 IPC。 */
  BA.sessionHasBrowser = function (sid) {
    const s = String(sid || "");
    if (!s) return false;
    if (BA.browserSessions.has(s)) return true;
    if (BA.driver && BA.driver === s) return true;
    return BA.dbBrowserSession === s;
  };

  /* 按当前会话决定这条栏显不显 / 拉不拉流。唯一显隐口径（除了用户点 chip）。
     · 认不出当前会话（老壳 / 冒烟）→ 旧口径：按 mtnode.baOpen 记忆恢复；
     · 认得出 → 用户亲手定过（开 / 关）按用户的，否则「有浏览器就显示、没有就收起」；
       自动收起 / 展开一律不落盘（别把「跟随会话」变成改写用户的偏好）。 */
  BA.applySessionPanel = function () {
    const pane = $("#agentPane");
    if (pane && pane.style.display === "none") return; /* 不在会话视图：进视图时再算 */
    let want;
    if (!BA.sessionId) {
      if (BA.userClosed) want = false;
      else {
        want = false;
        try { want = localStorage.getItem("mtnode.baOpen") === "1"; } catch (_) {}
      }
    } else {
      const choice = BA.userChoice.get(BA.sessionId);
      want = choice === undefined ? BA.sessionHasBrowser(BA.sessionId) : !!choice;
    }
    if (want !== BA.isOpen()) BA.setOpen(want, false);
    BA.liveSync();
  };

  /* 切会话：换活动范围 + 按新会话有没有浏览器重算显隐。
     force = 只是重新进会话视图 / 启动恢复，不清内存样本、不重置用户的取舍。 */
  BA.setSession = function (id, opts) {
    const sid = String(id == null ? BA.currentSessionId() : id || "");
    const changed = sid !== BA.sessionId;
    if (!changed && !(opts && opts.force)) return false;
    BA.sessionId = sid;
    if (changed) {
      /* 换会话 = 新的活动上下文：内存样本作废（新会话按 id 重新查库），
         用户的显式取舍按目标会话自己的记录恢复（切回去还是上次那样）。 */
      BA.rows = [];
      BA.total = 0;
      BA.dbBrowserSession = "";
      BA.filter = "";
      const fi = $("#baFilter");
      if (fi) fi.value = "";
      const choice = sid ? BA.userChoice.get(sid) : undefined;
      BA.userClosed = choice === false;
      BA.userOpened = choice === true;
    }
    BA.applySessionPanel();
    void BA.reload();
    return true;
  };

  BA.isOpen = function () {
    const pane = $("#agentPane");
    return !!(pane && pane.classList.contains("ba-open"));
  };

  /* 唯一显隐口径：open=true 开右边栏（并把活动流刷成当前），false 收起。
     收起时只 hidden + 拆掉 .ba-open，不动 DOM 里的内容（再打开时滚动位置还在）。 */
  BA.setOpen = function (open, persist) {
    const pane = $("#agentPane");
    const box = $("#baPanel");
    const on = !!open;
    BA.open = on;
    if (pane) pane.classList.toggle("ba-open", on);
    if (box) box.hidden = !on;
    const chip = $("#agentBrowserChip");
    if (chip) chip.classList.toggle("on", on);
    if (on) BA.applyWidth(BA.width(), false);
    if (persist !== false) {
      try { localStorage.setItem("mtnode.baOpen", on ? "1" : "0"); } catch (_) {}
      /* 显式开 / 关（chip、✕）＝用户的意思：关过之后本次运行不再自动弹；
         按会话记一份取舍，切走再切回来仍按用户那次的选择，不被自动判据顶掉。 */
      BA.userClosed = !on;
      BA.userOpened = on;
      if (BA.sessionId) BA.userChoice.set(BA.sessionId, on);
    }
    if (on) BA.reload();
    /* 面板状态变了：实况流跟着开 / 关（收起面板不占帧、不占解码成本） */
    BA.liveSync();
    return on;
  };

  BA.toggle = function () {
    return BA.setOpen(!BA.isOpen());
  };

  /* ── 活动列表「跟随最新」（用户要的「停止追踪活动」）──────────────────────
     开着（默认）：每次重画都把列表停在最新一条 —— 新活动永远在眼前；
     关掉：重画只保持当前位置，往上翻看旧记录不会被新活动拽回底部。
     两条自动路径（省得用户先去找开关）：手动往上翻 = 想停住看 → 自动停跟随；
     滚回底部 = 想跟上 → 自动恢复。状态落 localStorage（与右栏显隐 / 宽度同口径）。 */
  BA.follow = true;

  function paintFollow() {
    const b = $("#baFollow");
    if (!b) return;
    /* 键面写「点一下会怎样」（与 #baTakeover / #baLivePause 同口径），.on = 正在跟随 */
    const label = BA.follow ? T("停止跟随") : T("跟随最新");
    if (b.textContent !== label) b.textContent = label;
    b.classList.toggle("on", BA.follow);
    b.setAttribute("aria-pressed", BA.follow ? "true" : "false");
    const tip = BA.follow
      ? T("正在跟随最新：有新活动就停在最新一条；点一下停止跟随（往上翻旧记录不被拽回底部）")
      : T("已停止跟随：往上翻旧记录不会被拽回底部；点一下恢复跟随最新");
    if (b.title !== tip) b.title = tip;
  }

  BA.setFollow = function (on, persist) {
    BA.follow = !!on;
    paintFollow();
    if (persist !== false) {
      try { localStorage.setItem("mtnode.baFollow", BA.follow ? "1" : "0"); } catch (_) {}
    }
    if (BA.follow) {
      const list = $("#baList");
      if (list) list.scrollTop = list.scrollHeight;
    }
    return BA.follow;
  };

  BA.toggleFollow = function () { return BA.setFollow(!BA.follow); };

  /* ── 活动流「收起 / 展开」（本次需求）────────────────────────────────────
     用户口径：实况画面下方的追踪活动要能一键不显示，**同时也不追踪** —— 收起后
     实况画面独占右栏剩下的高度（.ba-col.ba-list-off .ba-live 铺满），并且
       · 新事件不再重画列表（省 DOM）、也不再落活动库（省一次 IPC + 一条记录）；
       · 再打开时 reload() 把这段时间的条目从库里补回来（照旧按当前会话查）。
     状态落 localStorage（mtnode.baListOn），与右栏显隐 / 宽度 / 跟随同一口径。
     键面写「点一下会怎样」（与 #baFollow 同款）；文案随状态变，所以不挂 data-i18n*。 */
  BA.listOn = true;

  function paintListBtn() {
    const b = $("#baListOn");
    if (!b) return;
    const label = BA.listOn ? T("只看浏览器") : T("显示活动");
    if (b.textContent !== label) b.textContent = label;
    b.classList.toggle("on", !BA.listOn);
    b.setAttribute("aria-pressed", BA.listOn ? "false" : "true");
    const tip = BA.listOn
      ? T("收起下方的追踪活动：活动区整块不显示，同时停止追踪（新活动不再记入活动库），实况画面占满右栏；点一下即可恢复")
      : T("活动区已收起、追踪已停止：新活动不再记入活动库；点一下恢复列表与追踪");
    if (b.title !== tip) b.title = tip;
  }

  BA.setListOn = function (on, persist) {
    BA.listOn = !!on;
    /* 判据一处写：类挂在面板上，样式见 css/browser.css 的 .ba-col.ba-list-off */
    const box = $("#baPanel");
    if (box) box.classList.toggle("ba-list-off", !BA.listOn);
    paintListBtn();
    if (persist !== false) {
      try { localStorage.setItem("mtnode.baListOn", BA.listOn ? "1" : "0"); } catch (_) {}
    }
    /* 恢复显示：把收起这段时间库里攒下的条目补回来（收起时 reload 是空转） */
    if (BA.listOn) void BA.reload();
    return BA.listOn;
  };

  BA.toggleList = function () { return BA.setListOn(!BA.listOn); };

  /* 切界面语言后由 app-boot.js 的 applyLocale 叫一次：本面板的键面文字是 JS 画的
     （跟随最新 / 接管 / 交还 / 只看浏览器），applyDom 碰不到它们。只重画文字，不动状态机。 */
  BA.repaintChrome = function () {
    paintFollow();
    paintListBtn();
    const tk = $("#baTakeover");
    if (tk) tk.textContent = BA.takeover ? T("交还") : T("接管");
  };

  /* 面板元素已由 index.html 提供（#baPanel）：本模块不再自建 DOM，
     老版本 / 被裁掉的 HTML 里没有它就是没有面板（入口也不在），不静默造一份。 */
  BA.ensurePanel = function () {
    return $("#baPanel");
  };

  BA.openPanel = function () {
    const box = BA.ensurePanel();
    if (!box) return null;
    BA.setOpen(true);
    return box;
  };

  /* 用户此刻是不是正看着这条会话（焦点在它身上）。
     判据走 app-assist.js 的 agentViewHas（唯一口径：覆盖态比覆盖值，否则比 S.agentActiveId）；
     认不出当前会话（老壳 / 单文件冒烟）时回 true = 退回旧行为，不为难老壳。 */
  BA.viewing = function (sid) {
    const s = String(sid || "");
    if (!s) return true;
    try {
      if (typeof agentViewHas === "function") return !!agentViewHas(s);
    } catch (_) {}
    return true;
  };

  /* 会话列表上的**被动标记**（静默处理那一半）：这条会话有浏览器在跑时，
     左栏那一行挂一枚不抢焦点的小标（app-assist.js 的 side-sess-ba）。
     只在本会话第一次进来时重绘一次列表（内存样本，切画布 / 重启即清零），
     绝不在每条活动上都刷一次侧栏。 */
  BA.noteBrowserSession = function (sid) {
    const s = String(sid || "");
    if (!s || BA._sideMarked.has(s)) return false;
    BA._sideMarked.add(s);
    try {
      if (typeof renderAgentSessionSidebar === "function") renderAgentSessionSidebar();
    } catch (_) {}
    return true;
  };
  BA._sideMarked = new Set();

  /* 会话真开始用浏览器（browser-act 进来）→ 右栏自己出现；**焦点不在该会话时静默**：
     照常把实况画面连起来（切过去立刻有画面，不是「连接中…」的空窗），但不弹右栏、
     不切界面、不提示 —— 用户正看着别的会话 / 画布，别把他的界面挪走；
     左栏那条会话上留一枚被动标记（app-assist.js 的 side-sess-ba，BA.onEvent 触发重绘）。
     不开这条：实况流只在「面板开着」时才连，浏览器就永远只能是眼前的独立窗口
     （dock 由 liveStart → viewStart → setViewMode('docked') 完成，见网关 viewStart）。
     三道刹车：用户这次运行亲手关过 / 不在会话视图 / 浏览器没在跑 —— 都不自动开。 */
  BA.autoOpenForUse = async function () {
    if (BA.userClosed || BA.autoOpenBusy) return false;
    /* 会话闸：只让**当前会话自己**的浏览器动作把栏带出来（调用方已按会话过滤过事件，
       这里再判一次，防「别的会话的活动漏进来」把眼前这条会话的栏顶开）。 */
    if (BA.sessionId && BA.driver && BA.driver !== BA.sessionId) return false;
    const pane = $("#agentPane");
    if (!pane || pane.style.display === "none") return false;
    /* 状态可能是旧的（浏览器由会话刚拉起）：问一次网关再决定，别拿过期状态当判据 */
    if (!BA.running && window.api && typeof window.api.dshBrowser === "function") {
      BA.autoOpenBusy = true;
      try {
        const st = await window.api.dshBrowser({ action: "status" }).catch(() => null);
        if (st && st.ok !== false) BA.applyStatus(st);
      } catch (_) {} finally {
        BA.autoOpenBusy = false;
      }
    }
    if (!BA.running) return false;
    /* 焦点不在该会话（用户正看着别的会话 / 画布）→ 静默：把画面连起来就好，
       不弹右栏、不切界面、不提示（左栏那条会话上有被动标记，见 app-assist.js）。
       这里也不做「栏开着就补流」的决定 —— 当下显示的可能是别的会话，
       liveSync 的会话闸会挡住它。 */
    if (!BA.viewing(BA.sessionId)) {
      BA.silentConnect();
      return false;
    }
    /* 栏已经开着（上次开着没收 / 启动时按 mtnode.baOpen 恢复的）：不用再弹，
       但必须把「开流」补上 —— 面板开着不等于流在连（启动那一刻浏览器还没跑，
       那一拍开流会失败），少这一步：浏览器后来被会话拉起，也没人去 dock 它，
       窗口就一直留在屏幕上 = 用户看到的「单独的一个窗口」。 */
    if (BA.isOpen()) { BA.liveSync(); return false; }
    BA.setOpen(true);
    return true;
  };

  /* 静默连流：只把实况拉起来（内部界面），**不动面板显隐、不切视图、不弹提示**。
     焦点不在该会话、或该会话的浏览器在后台跑时走这条 —— 画面先准备好，
     用户切过去时不是「连接中…」的空窗（帧只走内存，不花 token、不落库）。 */
  BA.silentConnect = function () {
    const pane = $("#agentPane");
    if (!pane || pane.style.display === "none") return false;
    if (!BA.running) return false;
    if (BA.live.mode === "detached") return false; /* 用户亲手点的独立窗口不算静默对象 */
    if (BA.live.on || BA.live.starting) return true;
    void BA.liveStart({ silent: true });
    return true;
  };

  /* ── 与网关对话（浏览器控制面）──────────────────────────────────────── */
  BA.browser = async function (action, extra) {
    try {
      if (!window.api || typeof window.api.dshBrowser !== "function") {
        toastSafe(T("当前外壳没有浏览器桥（老版本）"), "warn");
        return null;
      }
      const res = await window.api.dshBrowser(Object.assign({ action }, extra || {}));
      if (res && res.ok === false) {
        toastSafe(T("浏览器操作失败：") + String(res.error || ""), "warn");
        return res;
      }
      BA.applyStatus(res);
      if (action === "open") toastSafe(T("浏览器已就绪（默认在右栏实况里；想看真窗口点「独立窗口」）"), "ok");
      if (action === "stop") toastSafe(T("浏览器已停止"), "ok");
      return res;
    } catch (e) {
      toastSafe(T("浏览器操作失败：") + ((e && e.message) || String(e)), "warn");
      return null;
    }
  };

  BA.applyStatus = function (st) {
    if (!st || typeof st !== "object") return;
    if (st.policy && typeof st.policy === "object") BA.policy = st.policy;
    /* 谁在驱动这只浏览器（'' = 没有会话持锁 / 用户手动开的）：实况流只给驱动它的那条会话看。
       只在回执真带了 driver 时才更新（policy / view 这类回执不带它，别把已知的驱动者抹掉）。 */
    if (typeof st.driver === "string") {
      BA.driver = st.driver;
      if (BA.driver) BA.browserSessions.add(BA.driver);
    }
    const wasRunning = BA.running;
    BA.running = !!st.running;
    /* 形态与网关同源（status 回执带 mode；policy / view 这类不带就保持原样）：
       用户口径是**内部界面为默认**，「独立窗口」只是他亲手点的本次运行例外 ——
       重开应用 / 重启浏览器都从 docked 起，所以这里只跟随网关、不落 localStorage。 */
    /* 与网关同源：mode 只认这两个值；headless = 这一只没有可显示的真窗口（见 browser-host
       的 launchArgs），渲染层据此把「独立窗口」这枚按钮收起来并说明原因。 */
    if (st.mode === "detached" || st.mode === "docked") BA.live.mode = st.mode;
    if (typeof st.headless === "boolean") BA.headless = st.headless;
    /* 无窗口那只：headless 模式下 status 不带 mode 之外的窗口信息，别让面板停在「独立窗口」上 */
    if (BA.headless) BA.live.mode = "docked";
    /* 浏览器停了 / 崩了：回到「待启动 + docked」，别让面板卡在「独立窗口」文案上 */
    if (wasRunning && !BA.running) {
      BA.live.on = false;
      BA.live.frames = 0;
      BA.live.frame = null;
      BA.live.mode = "docked";
      BA.live.fallback = false;
      BA.live.reason = "";
      BA.headless = false;
    }
    BA.takeover = !!(st.takeover && st.takeover.on);
    BA.paintStatus(st);
  };

  BA.paintStatus = function (st) {
    const el = $("#baStatus");
    if (!el) return;
    const s = st || {};
    const parts = [];
    parts.push(BA.running ? T("运行中") : T("未启动"));
    if (s.exe) parts.push(String(s.exe).includes("msedge") ? "Edge" : String(s.exe).includes("chrome") ? "Chrome" : "浏览器");
    if (s.port) parts.push(":" + s.port);
    if (s.driver) parts.push(T("驱动中：") + String(s.driver).slice(0, 10) + "…");
    if (BA.takeover) parts.push(T("你已接管"));
    el.textContent = parts.join(" · ");
    el.classList.toggle("on", BA.running);
    const tk = $("#baTakeover");
    if (tk) {
      tk.textContent = BA.takeover ? T("交还") : T("接管");
      tk.classList.toggle("on", BA.takeover);
    }
    /* 状态刷新是「浏览器起没起」的权威来源：实况流按它开 / 关
       （没启动 = 不显示实况，也不去拉帧） */
    BA.liveSync();
  };

  BA.toggleTakeover = async function () {
    const on = !BA.takeover;
    /* 接管是「用户替这条会话动手」：sessionId 用当前会话（旧写法取那个从没赋过值的
       lastSessionId = 恒空串，于是下面那句插话永远发不出去）。 */
    const cur = BA.currentSessionId();
    const res = await BA.browser("takeover", { on, sessionId: cur });
    if (!res || res.ok === false) return;
    try {
      /* 接管期间 Agent 的动作会被网关直接拒绝（不是排队），所以顺手把这件事插话告诉
         正在跑的那一轮：模型下一步就听见「现在由我操作，别动浏览器」。 */
      const sid = cur;
      if (sid && typeof window.api.dshSteer === "function") {
        await window.api.dshSteer({
          cancelTag: "agent:" + sid,
          text: on
            ? T("【用户接管浏览器】我现在亲自操作浏览器（登录 / 验证码 / 付款一类），你的浏览器动作会被拒绝。请先用 browser_help 说明你需要什么，或等我交还后再继续。")
            : T("【用户交还浏览器控制权】你可以继续操作浏览器了；先 browser_snapshot 看一眼当前页面再往下做。"),
        });
      }
    } catch (_) {}
    toastSafe(on ? T("你已接管浏览器（Agent 动作已暂停）") : T("已交还控制权（Agent 可继续）"), "ok");
  };

  BA.reload = async function () {
    try {
      await BA.browser("status");
    } catch (_) {}
    /* 「只看浏览器」收起态：活动区不显示、也不追踪 → 连查库都跳掉（省一次 IPC /
       一次全量重画）；重新展开时 setListOn 会自己再调一次本函数把条目补回来。 */
    if (!BA.listOn) return;
    const all = allChecked();
    const sid = String(BA.sessionId || "");
    /* 勾「含其它会话」= 查全库；认不出当前会话（老壳 / 单文件冒烟）也查全库 —— 旧口径不劣化。 */
    const scoped = !all && !!sid;
    if (!window.api || typeof window.api.activityQuery !== "function") return;
    const res = await window.api
      .activityQuery({ sessionId: scoped ? sid : "", limit: 400 })
      .catch(() => null);
    /* 查库期间用户又切了会话：这一拍的结果已经过期，丢掉 ——
       否则上一条会话的条目会落到新会话眼前（切得快时真会发生）。 */
    if (String(BA.sessionId || "") !== sid) return;
    if (!res || res.ok === false) {
      if (res && res.error) toastSafe(T("读活动流失败：") + res.error, "warn");
      return;
    }
    BA.rows = Array.isArray(res.rows) ? res.rows.slice().reverse() : [];
    BA.total = Number(res.total) || BA.rows.length;
    /* 本会话有没有浏览器：这批样本里有没有浏览器类活动（勾「含其它会话」时样本混着别的
       会话，不能拿来判本会话的显隐 → 保持上一次的结论不动）。 */
    if (scoped) {
      BA.dbBrowserSession = BA.rows.some((r) => isBrowserKind(r && r.kind)) ? sid : "";
    }
    BA.render();
    /* 查完再校一次显隐：会话有浏览器历史但这一拍才知道（见 applySessionPanel） */
    BA.applySessionPanel();
  };

  BA.clear = async function () {
    if (!window.api || typeof window.api.activityClear !== "function") return;
    const res = await window.api
      .activityClear({ sessionId: allChecked() ? "" : String(BA.sessionId || "") })
      .catch(() => null);
    if (res && res.ok) {
      BA.rows = [];
      toastSafe(T("活动流已清空"), "ok");
      BA.render();
    }
  };

  /* 活动落库（事件进来即写；批量合并一拍，避免每条一次 IPC） */
  let pushBuf = [];
  let pushTimer = 0;
  BA.onEvent = function (data) {
    const kind = String((data && data.kind) || "activity");
    const row = {
      at: Number(data && data.at) || Date.now(),
      kind,
      /* 归属会话＝网关盖的章（**渲染层会话 id**，见 dsh/gateway 的 hostSessionId）：
        每一条 browser-act 都带它（浏览器动作 / 命令 / 文件摘要都归属发起那一轮）。
        缺章（用户点「打开浏览器 / 停止 / 接管」这类由界面触发的条目）才回落到
        「当前会话」—— 用户此刻看的就是它。旧库里用 dsh session id 盖的老条目
        （session-…）对不上任何会话，勾「含其它会话」仍看得到。 */
      sessionId: String((data && data.sessionId) || BA.sessionId || ""),
      text: String((data && data.text) || ""),
      path: String((data && data.path) || ""),
    };
    if (!row.text) return;
    /* 本会话见过浏览器活动 = 「本会话有没有浏览器」的判据之一（切回它时据此显示这条栏）。
       别的会话的也算 —— 正是为了切过去时知道它有自己的浏览器。
       会话列表上那枚被动标记也在这里补：**不弹栏、不切界面、不提示**，
       只让用户扫一眼左栏就知道哪条会话正在动浏览器（静默处理那一半）。 */
    if (isBrowserKind(kind) && row.sessionId) {
      BA.browserSessions.add(row.sessionId);
      BA.noteBrowserSession(row.sessionId);
    }
    /* 浏览器在跑而这条会话正是驱动者：同样补标记（launch 类活动也可能不在 AUTO_OPEN_KINDS 里） */
    if (BA.driver && isBrowserKind(kind)) BA.noteBrowserSession(BA.driver);
    /* 会话真碰了浏览器：右栏自己出现（用户亲手关过就不打扰）。
       工具类活动行（kind = browser_launch / browser_navigate …）按前缀一起认。 */
    if (isBrowserKind(kind) && row.sessionId === BA.sessionId) void BA.autoOpenForUse();
    /* 「只看浏览器」收起态 = 用户明确说「不追踪活动」：这条事件不进列表、不落活动库、
       也不触发重画（省一次 IPC 与一次 DOM 重建）。弹栏那一步在上面已经放过了 ——
       会话真动浏览器时右栏照旧自己出现，只是里面只有实况、没有活动流。 */
    if (!BA.listOn) return;
    /* 只把当前会话的活动放进眼前这份列表：别的会话的照旧落库，但不刷新 / 不弹栏
       （否则「A 会话用浏览器，B 会话被弹第三栏」）。认不出当前会话时退回旧口径。 */
    const mine = !BA.sessionId || row.sessionId === BA.sessionId;
    if (mine || allChecked()) BA.rows.push(row);
    if (BA.rows.length > 800) BA.rows.splice(0, BA.rows.length - 800);
    /* 只在右边栏开着的时候重画：收起的面板不花 DOM 成本，再打开时 reload/render 补上 */
    if (BA.isOpen() && mine) BA.render();
    pushBuf.push(row);
    if (!pushTimer) {
      pushTimer = setTimeout(() => {
        pushTimer = 0;
        const rows = pushBuf;
        pushBuf = [];
        try {
          if (window.api && typeof window.api.activityPush === "function") void window.api.activityPush(rows);
        } catch (_) {}
      }, 400);
    }
  };

  BA.onDrop = function (data) {
    /* 网关撤掉一张浏览器确认 / 求助卡：把它的卡片撤掉（与 app-db 的 ixDrop 同源） */
    try {
      if (typeof window.ixDrop === "function") window.ixDrop(data && data.id);
    } catch (_) {}
  };

  /* 浏览器求助卡：app-db 的 ixPush 收进面板后，用本函数的渲染器画它 */
  BA.onHelpEvent = function (data) {
    try {
      if (typeof window.ixPush === "function") window.ixPush("browser-help", data || {}, "", null);
    } catch (_) {}
  };

  BA.render = function () {
    const list = $("#baList");
    /* 收起态：活动区整块不显示（css/browser.css 的 .ba-col.ba-list-off），
       重画它纯属白花 DOM —— 直接早退；展开时 setListOn → reload → 这里重画。 */
    if (!list || !BA.listOn) return;
    /* 重画前记下距顶偏移：关掉「跟随最新」时就靠它把视线留在原处。
       列表只往后追加、只渲染尾巴 300 条，所以「距顶偏移不变」= 看到的还是那几条。 */
    const keepTop = Number(list.scrollTop) || 0;
    const f = BA.filter;
    const rows = BA.rows.filter((r) => {
      if (!f) return true;
      return (String(r.text || "") + " " + String(r.kind || "")).toLowerCase().includes(f);
    });
    if (!rows.length) {
      /* 按会话看时，空列表的含义是「这条会话还没有活动」（不是「全库没有」）——
         文案得说清，否则用户会以为留痕坏了。 */
      const empty = BA.sessionId && !allChecked()
        ? T("本会话还没有活动。它用浏览器、跑命令或改文件后，这里会逐条记下。")
        : T("还没有活动。会话开始用浏览器后，这里会逐条记下它做了什么、跑了什么命令。");
      list.innerHTML = `<div class="ba-empty">${esc(empty)}</div>`;
    } else {
      /* 只渲染最后 300 条，避免长任务把 DOM 撑爆 */
      const tail = rows.slice(-300);
      list.innerHTML = tail
        .map((r) => {
          const g = KIND_GROUP(r.kind);
          const label = KIND_LABEL[String(r.kind)] || GROUP_LABEL[g] || r.kind;
          const path = r.path
            ? `<div class="ba-path"><a href="#" data-path="${esc(r.path)}">${esc(r.path)}</a></div>`
            : "";
          return (
            `<div class="ba-row g-${g}">` +
            `<span class="ba-t">${esc(hhmmss(r.at))}</span>` +
            `<span class="ba-k">${esc(label)}</span>` +
            `<span class="ba-x">${esc(r.text)}</span>` +
            path +
            `</div>`
          );
        })
        .join("");
      for (const a of list.querySelectorAll("a[data-path]")) {
        a.onclick = (ev) => {
          ev.preventDefault();
          const p = a.getAttribute("data-path");
          try { if (typeof window.openFilePeek === "function") window.openFilePeek(p); } catch (_) {}
        };
      }
      /* 跟随最新（默认）：停在最后一条；停了跟随：回到原来的位置 —— 悄悄替用户
         把视线拉走是最烦的（他正在核对上文），所以这条口子必须真的有效。 */
      list.scrollTop = BA.follow ? list.scrollHeight : Math.min(keepTop, list.scrollHeight);
    }
    const cnt = $("#baCount");
    if (cnt) cnt.textContent = T("共 ") + rows.length + T(" 条（库内 ") + BA.total + T(" 条）");
  };

  /* ── 实况区：浏览器默认 dock 在右栏，可切「独立窗口」 ────────────────
     帧来自 preload.onBrowserFrame（网关 screencast → dsh 事件总线），**只走内存**：
     不落库、不进模型上下文。帧只在面板开着且没暂停时画；画布上的指针 / 滚轮 / 键盘
     按 CSS 像素转发给页面（BA.liveInput），所以右栏里点得动、滚得动、打得进字。 */
  const LIVE_KEYCODE = {
    Backspace: 8, Tab: 9, Enter: 13, Shift: 16, Control: 17, Alt: 18, CapsLock: 20,
    Escape: 27, " ": 32, Space: 32, PageUp: 33, PageDown: 34, End: 35, Home: 36,
    ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Insert: 45, Delete: 46,
    Meta: 91, ContextMenu: 93,
    F1: 112, F2: 113, F3: 114, F4: 115, F5: 116, F6: 117, F7: 118, F8: 119, F9: 120, F10: 121, F11: 122, F12: 123,
  };
  const LIVE_BS = ["~", "!", "@", "#", "$", "%", "^", "&", "*", "(", ")", "_", "+"];
  const LIVE_BSV = ["`", "1", "2", "3", "4", "5", "6", "7", "8", "9", "0", "-", "="];
  const LIVE_OTHER_BS = [["{", "["], ["}", "]"], ["|", "\\"], [":", ";"], ['"', "'"], ["<", ","], [">", "."], ["?", "/"]];

  function liveKeyInfo(ev) {
    const k = ev.key;
    let code = String(ev.code || "");
    if (!code && /^[a-zA-Z]$/.test(k)) code = "Key" + k.toUpperCase();
    if (!code && /^[0-9]$/.test(k)) code = "Digit" + k;
    let keyCode = LIVE_KEYCODE[k] || 0;
    const shift = !!ev.shiftKey;
    if (!keyCode) {
      const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
      if (k.length === 1) {
        const up = k.toUpperCase();
        const i = letters.indexOf(up);
        if (i >= 0) keyCode = up.charCodeAt(0);
      }
      if (!keyCode) {
        const i = LIVE_BS.indexOf(k);
        if (i >= 0) keyCode = LIVE_BSV[i].charCodeAt(0);
        else {
          for (const pair of LIVE_OTHER_BS) {
            if (pair[0] === k) { keyCode = pair[1].charCodeAt(0); break; }
          }
        }
      }
    }
    let text = "";
    if (!ev.ctrlKey && !ev.metaKey && !ev.altKey && k && k.length === 1) text = k;
    return { key: k, code, keyCode, text, shift };
  }
  function liveMods(ev) {
    return (ev.altKey ? 1 : 0) | (ev.ctrlKey ? 2 : 0) | (ev.metaKey ? 4 : 0) | (ev.shiftKey ? 8 : 0);
  }
  function liveButtonOf(ev) {
    const b = Number(ev.button) || 0;
    return b === 1 ? "middle" : b === 2 ? "right" : b === 3 ? "back" : b === 4 ? "forward" : "left";
  }
  /* 画布显示尺寸（转发坐标用）：画布 CSS 像素就是「面板里的坐标」 */
  function liveSize() {
    const c = $("#baLiveCanvas");
    if (!c) return { w: 0, h: 0 };
    const r = c.getBoundingClientRect();
    return { w: Math.max(1, Math.round(r.width)), h: Math.max(1, Math.round(r.height)) };
  }

  BA.liveInput = function (params) {
    if (!BA.live.on) return;
    if (!window.api || typeof window.api.dshBrowserViewInput !== "function") return;
    const p = Object.assign({}, params || {});
    try { void window.api.dshBrowserViewInput(p).catch(() => {}); } catch (_) {}
  };

  /* 一帧只画最新的一张：中间帧（Image 还在解码）直接让位，避免卡界面。
     网关给的是**裸 base64**（CDP screencast 的 data 字段），这里补成 dataURL 再解码。 */
  BA.livePaint = function (raw, w, h) {
    const c = $("#baLiveCanvas");
    if (!c) return;
    const s = String(raw || "");
    if (!s) return;
    const dataUrl = /^data:image\//.test(s) ? s : "data:image/jpeg;base64," + s;
    let img;
    try { img = new Image(); } catch (_) { return; }
    img.onload = () => {
      BA.live.frame = img;
      if (!BA.live.painting) BA.liveSchedule();
    };
    img.onerror = () => {};
    try { img.src = dataUrl; } catch (_) {}
    if (w > 0) BA.live.w = w;
    if (h > 0) BA.live.h = h;
  };

  BA.liveSchedule = function () {
    if (BA.live.painting) return;
    BA.live.painting = true;
    const step = () => {
      BA.live.painting = false;
      BA.liveDraw();
    };
    try { requestAnimationFrame(step); } catch (_) { step(); }
  };

  BA.liveDraw = function () {
    const c = $("#baLiveCanvas");
    const L = BA.live;
    if (!c || !L.frame) return;
    const r = c.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const dpr = Math.min(2, Number(window.devicePixelRatio) || 1);
    const pxW = Math.max(1, Math.round(r.width * dpr));
    const pxH = Math.max(1, Math.round(r.height * dpr));
    if (c.width !== pxW || c.height !== pxH) { c.width = pxW; c.height = pxH; }
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const iw = L.frame.naturalWidth || L.w || 1;
    const ih = L.frame.naturalHeight || L.h || 1;
    /* contain：等比铺满、留黑边（不裁切，用户看到的和页面一致） */
    const s = Math.min(pxW / iw, pxH / ih);
    const dw = Math.max(1, Math.round(iw * s));
    const dh = Math.max(1, Math.round(ih * s));
    const dx = Math.round((pxW - dw) / 2);
    const dy = Math.round((pxH - dh) / 2);
    ctx.clearRect(0, 0, pxW, pxH);
    try { ctx.drawImage(L.frame, dx, dy, dw, dh); } catch (_) { return; }
    L.lastPaintAt = Date.now();
    L.frames += 1;
    if (L.frames === 1) {
      /* 第一帧到了：清掉「连接中…」，别让它挂在实况区下面 */
      if (L.reason === T("正在连接浏览器画面…")) L.reason = "";
      BA.livePaintStatus();
    }
  };

  BA.livePaintStatus = function () {
    const btn = $("#baLiveModeBtn");
    const modeEl = $("#baLiveMode");
    const note = $("#baLiveNote");
    const mask = $("#baLiveMask");
    const L = BA.live;
    const detached = L.mode === "detached" && !BA.headless;
    if (btn) {
      /* 浏览器没开（未启动）时这枚按钮不该出现：形态切换只在「真有一只在跑的浏览器」时
         才有意义（否则点下去只会去搬一个不存在的窗口）。文案「独立窗口 / 收回」按形态切。
         无窗口那只（headless）也没有窗口可摆：按钮收起，并把「想看真窗口点打开浏览器」写进 title。 */
      btn.hidden = !BA.running || !!BA.headless;
      const label = detached ? T("收回") : T("独立窗口");
      if (btn.textContent !== label) btn.textContent = label;
      btn.classList.toggle("on", detached);
      btn.title = BA.headless ? T("这只是无窗口（后台）浏览器，没有可显示的窗口") : "";
    }
    if (modeEl) {
      modeEl.textContent = BA.headless
        ? T("无窗口运行")
        : detached
          ? T("已在独立窗口")
          : L.on ? (L.frames ? T("实况中") : T("连接中…")) : T("未连接");
    }
    if (note) {
      const txt = BA.headless
        ? T("这只是无窗口（后台）浏览器，画面就在这里；想看真窗口请在面板上点「打开浏览器」。")
        : L.reason || (detached ? T("已在独立窗口操作；点「收回」回到右栏。") : "");
      note.textContent = txt;
      note.hidden = !txt;
      note.classList.toggle("warn", !!L.fallback);
    }
    if (mask) mask.hidden = !!(L.frames && L.on);
    const col = document.querySelector(".ba-col");
    if (col) col.classList.toggle("ba-live-on", !!L.on || detached);
  };

  /* 开实况流。silent = 这是「焦点不在该会话」的静默连流（BA.silentConnect）：
     它要的就只是**把真实窗口搬走**（内部界面的定义），此时面板本来就收着 ——
     不放开「面板必须开着」，静默那一半就只是句空话，窗口仍留在屏幕上（用户报的 bug）。
     面板没开时帧照收但不画（onFrame 里挡着），所以静默期只有网关那点编码成本。 */
  BA.liveStart = async function (opts) {
    const L = BA.live;
    const silent = !!(opts && opts.silent);
    if (!silent && !BA.isOpen()) return;
    if (!silent && !BA.running) return;
    if (L.on || L.starting) return;
    if (!window.api || typeof window.api.dshBrowserViewStart !== "function") return;
    /* 单飞：开栏那一拍 liveSync 可能连来两次（setOpen 与 reload→status→applyStatus），
       不挡的话会重复发 viewStart（网关虽幂等，但别让渲染层靠它擦屁股） */
    L.starting = true;
    try {
      const res = await window.api.dshBrowserViewStart({});
      if (res && res.ok === false) {
        /* 浏览器起不来 / 这台机器开不了实况：状态里说明，不弹错误轰炸 */
        L.reason = String(res.error || res.reason || "");
        L.on = false;
      } else {
        L.on = true;
        /* 连上但还没帧时给一句「连接中…」：不然用户只看到遮罩，不知道是在等还是坏了 */
        if (!L.frames) L.reason = T("正在连接浏览器画面…");
        if (res) BA.applyView(res);
      }
    } catch (e) {
      L.reason = (e && e.message) || String(e);
      L.on = false;
    } finally {
      L.starting = false;
    }
    BA.livePaintStatus();
  };

  BA.liveStop = async function () {
    const L = BA.live;
    L.on = false;
    L.frames = 0;
    L.frame = null;
    L.seq = 0;
    try {
      if (window.api && typeof window.api.dshBrowserViewStop === "function") await window.api.dshBrowserViewStop();
    } catch (_) {}
    BA.livePaintStatus();
  };

  /* 面板 / 视图开着才要帧：收起面板、离开会话视图、暂停观察时不占资源。
     「独立窗口」（detached）时也不连：独立窗口形态下画面就在用户眼前，
     再开一条流只会立刻把真实窗口又搬走 —— 等于用户点不动那个按钮。 */
  BA.liveSync = function () {
    const pane = $("#agentPane");
    const inSessionView = !!(pane && pane.style.display !== "none");
    /* 会话闸：这只浏览器此刻由**别的会话**驱动时不拉帧 —— 同一时刻只有一条会话持驱动锁，
       画面属于那条会话，本会话的右栏不该把它的画面搬到自己眼下（切回驱动会话再开）。 */
    const mine = !BA.sessionId || !BA.driver || BA.driver === BA.sessionId;
    /* 静默期（焦点不在该会话、右栏收着）流照旧连着：那条流不只是画面，更是「真实窗口让位」
       —— 内部界面的定义。收起面板就把流掐了，等于让窗口又留回屏幕上（用户报的 bug）。
       帧在面板收起时本来就不画（onFrame 挡着），所以静默期只花网关那点编码成本。 */
    const silentStream = !!(BA.sessionId && BA.driver === BA.sessionId && BA.viewing(BA.sessionId));
    const shown = BA.isOpen() && inSessionView;
    const want = (shown || silentStream) && BA.running && !BA.live.paused && BA.live.mode !== "detached" && mine;
    if (want) { if (!BA.live.on) void BA.liveStart({ silent: !shown }); return; }
    if (BA.live.on) void BA.liveStop();
  };

  BA.toggleLivePause = function () {
    BA.live.paused = !BA.live.paused;
    const b = $("#baLivePause");
    if (b) {
      b.classList.toggle("on", BA.live.paused);
      const label = BA.live.paused ? T("继续观察") : T("暂停观察");
      if (b.textContent !== label) b.textContent = label;
    }
    /* 暂停 = 真停流（不是把帧丢掉攒着）：省 CPU，也不让「暂停中还在偷偷出帧」 */
    if (BA.live.paused) void BA.liveStop();
    else BA.liveSync();
    BA.livePaintStatus();
  };

  /* 「独立窗口 / 收回」= 真实窗口形态：detached 让真实窗口可见并置前；docked 把它移出可视区、
     画面回到右栏。**不落 localStorage**：默认形态是内部界面（用户口径），
     「独立窗口」只是本次运行里他亲手点的一次显式例外，重开应用 / 重启浏览器都回到内部界面。
     detached 没能真把窗口摆出来（网关兜底判据）时回落成 docked 并把原因显示在实况区，
     不留「点了却什么都没发生」的死按钮。 */
  BA.liveSetMode = async function (mode) {
    const want = mode === "detached" ? "detached" : "docked";
    let res = null;
    try {
      if (window.api && typeof window.api.dshBrowserViewMode === "function") {
        res = await window.api.dshBrowserViewMode(want);
      }
    } catch (_) {}
    /* 形态以网关回执为准（它可能把没摆出来的 detached 回落成 docked） */
    const back = res && (res.mode === "detached" || res.mode === "docked") ? res.mode : want;
    BA.live.mode = back;
    if (res && res.reason) BA.live.reason = String(res.reason);
    else if (res && res.fallback) BA.live.reason = String(res.reason || "");
    else if (res && res.ok !== false) BA.live.reason = "";
    if (back === "detached") {
      /* 独立窗口形态下右栏不再出帧（画面就在用户眼前，没必要再解码一份） */
      await BA.liveStop();
      toastSafe(T("已切到独立窗口：这只浏览器现在是独立窗口，可直接在里面操作；点「收回」回到右栏。"), "ok");
    } else {
      if (want === "detached" && res && res.ok === false) {
        toastSafe(T("没能把真实窗口摆出来：先在右栏实况里操作，或再点一次。"), "warn");
      } else {
        toastSafe(T("已收回：画面回到会话右边栏。"), "ok");
      }
    }
    BA.livePaintStatus();
    BA.liveSync();
    return res;
  };

  BA.liveToggleMode = function () {
    return BA.liveSetMode(BA.live.mode === "detached" ? "docked" : "detached");
  };

  BA.applyView = function (st) {
    if (!st || typeof st !== "object") return;
    const L = BA.live;
    if (st.mode) L.mode = String(st.mode);
    if (typeof st.on === "boolean") L.on = st.on;
    if (typeof st.fallback === "boolean") L.fallback = st.fallback;
    if (st.reason != null) L.reason = String(st.reason || "");
    if (Number(st.w) > 0) L.w = Number(st.w);
    if (Number(st.h) > 0) L.h = Number(st.h);
    if (Number(st.dpr) > 0) L.dpr = Number(st.dpr);
    if (Number(st.seq) > L.seq) L.seq = Number(st.seq);
    BA.livePaintStatus();
  };

  /* 帧事件（preload.onBrowserFrame；'start'/'mode'/'stop' 这类不带 frame 的也走这里） */
  BA.onFrame = function (data) {
    const L = BA.live;
    if (!data || typeof data !== "object") return;
    const ev = String(data.event || "");
    if (Number(data.seq) > 0) {
      if (Number(data.seq) <= L.seq) return;      // 乱序 / 重放：丢掉旧的
      L.seq = Number(data.seq);
    }
    if (data.mode) L.mode = String(data.mode);
    if (typeof data.fallback === "boolean") L.fallback = data.fallback;
    if (data.reason != null) L.reason = String(data.reason || "");
    if (ev === "stop") { L.on = false; L.frames = 0; L.frame = null; }
    if (ev === "start" || data.on) L.on = true;
    let drawn = false;
    if (data.frame && !L.paused) {
      /* 只画面板开着的时候；收起时不花任何解码成本 */
      if (BA.isOpen()) { BA.livePaint(String(data.frame), Number(data.w) || 0, Number(data.h) || 0); drawn = true; }
    }
    if (!drawn) BA.livePaintStatus();
  };

  /* ── 域名名单 / 危险动作审批（简单编辑入口，写回本机策略文件）────────── */
  BA.openPolicy = async function () {
    await BA.browser("status");
    const p = BA.policy || { blocked: [], confirm: [], approveDangerous: true };
    const html = `
      <div class="ba-policy">
        <p class="ba-hint">${esc(T("拦截名单：这些域名一律拒绝访问（每行一条）。风险名单：首次访问会弹一次确认卡。空行与 # 开头会被忽略。"))}</p>
        <div class="ba-p2">
          <label>${esc(T("拦截名单"))}<textarea id="baBlocked" spellcheck="false">${esc((p.blocked || []).join("\n"))}</textarea></label>
          <label>${esc(T("风险名单（首次访问需确认）"))}<textarea id="baConfirm" spellcheck="false">${esc((p.confirm || []).join("\n"))}</textarea></label>
        </div>
        <label class="ba-check"><input type="checkbox" id="baDanger" ${p.approveDangerous !== false ? "checked" : ""}> ${esc(T("危险动作（提交 / 支付 / 删除 / 发送 / 发布…）先弹确认卡"))}</label>
      </div>`;
    const host = $("#baPolicyBox");
    let box = host;
    if (!box) {
      box = document.createElement("div");
      box.id = "baPolicyBox";
      box.className = "ba-policy-box";
      box.hidden = true;
      (document.querySelector(".ba-col") || document.querySelector(".agent-side") || document.body).appendChild(box);
    }
    box.innerHTML =
      `<div class="ba-policy-head"><span>${esc(T("浏览器名单与审批"))}</span><button type="button" class="mini" id="baPClose">✕</button></div>` +
      `<div class="ba-policy-body">${html}</div>` +
      `<div class="ba-policy-foot"><button type="button" class="mini primary" id="baPSave">${esc(T("保存"))}</button></div>`;
    box.hidden = false;
    $("#baPClose").onclick = () => { box.hidden = true; };
    $("#baPSave").onclick = async () => {
      const parse = (v) =>
        String(v || "")
          .split("\n")
          .map((x) => x.trim().replace(/^#.*$/, "").trim().toLowerCase())
          .filter(Boolean);
      const next = {
        blocked: parse($("#baBlocked").value),
        confirm: parse($("#baConfirm").value),
        approveDangerous: !!$("#baDanger").checked,
      };
      const res = await BA.browser("policy", { policy: next });
      if (res && res.policy) BA.policy = res.policy;
      box.hidden = true;
      toastSafe(T("名单已保存（下一次动作即刻生效）"), "ok");
    };
  };

  /* ── 启动接线 ─────────────────────────────────────────────────────────── */
  /* 实况区的单个控件绑定：绑定期缺 DOM / 点击期缺实现或抛错，都只记一条警告，
     绝不许把后面的 canvas 接线（canvas._bound / 指针 / 滚轮 / 键盘转发 / livePaintStatus）打断。 */
  function bindLiveBtn(el, label, run) {
    if (!el) return;
    try {
      if (typeof run !== "function") return;
      el.onclick = () => {
        try { run(); } catch (err) { try { console.warn(`[ba] live ${label} 控件出错：`, err); } catch (_) {} }
      };
    } catch (err) {
      try { console.warn(`[ba] live ${label} 控件绑定失败：`, err); } catch (_) {}
    }
  }

  /* 实况区的接线：模式按钮 / 暂停 / 画布上的指针·滚轮·键盘。
     坐标换算（CSS 像素 → 页面视口）在网关侧做（browser-host.viewInput），
     这里只负责把事件原样翻译成 {kind, ...}。 */
  function bindLive() {
    const canvas = $("#baLiveCanvas");
    const pause = $("#baLivePause");
    const modeBtn = $("#baLiveModeBtn");
    if (!canvas || canvas._bound) { BA.livePaintStatus(); return; }
    /* 先盖章再接线：后面任一入口抛错，也不让「这颗画布已经绑过」这一事实被跳过
       （重复 bindLive 会把指针 / 键盘转发再挂一遍，帧收到两次就有双倍输入） */
    canvas._bound = true;
    bindLiveBtn(pause, "pause", () => BA.toggleLivePause && BA.toggleLivePause());
    bindLiveBtn(modeBtn, "mode", () => BA.liveToggleMode && BA.liveToggleMode());
    /* 形态默认 docked（右栏实况 = 内部界面），**不按上次恢复**：
       「独立窗口」是用户本次运行里亲手点的例外（用户口径：默认内部界面），
       重开应用回到内部界面；跟随网关的那一半见 applyStatus / applyView。 */

    /* 上次按下的键（keyup 要用同一份 key/code/keyCode） */
    let lastKey = null;

    canvas.addEventListener("pointerdown", (ev) => {
      ev.preventDefault();
      try { canvas.focus({ preventScroll: true }); } catch (_) { try { canvas.focus(); } catch (_) {} }
      const r = canvas.getBoundingClientRect();
      const sz = liveSize();
      BA.liveInput({
        kind: "mouse",
        type: "mousePressed",
        x: Math.round(ev.clientX - r.left),
        y: Math.round(ev.clientY - r.top),
        button: liveButtonOf(ev),
        buttons: 1,
        clickCount: 1,
        modifiers: liveMods(ev),
        w: sz.w,
        h: sz.h,
      });
    });

    canvas.addEventListener("pointermove", (ev) => {
      const r = canvas.getBoundingClientRect();
      const sz = liveSize();
      const buttons = ev.buttons ? (ev.buttons & 1 ? 1 : ev.buttons & 2 ? 2 : ev.buttons & 4 ? 4 : 0) : 0;
      BA.liveInput({
        kind: "mouse",
        type: "mouseMoved",
        x: Math.round(ev.clientX - r.left),
        y: Math.round(ev.clientY - r.top),
        button: "none",
        buttons,
        modifiers: liveMods(ev),
        w: sz.w,
        h: sz.h,
      });
    });

    const up = (ev) => {
      const r = canvas.getBoundingClientRect();
      const sz = liveSize();
      BA.liveInput({
        kind: "mouse",
        type: "mouseReleased",
        x: Math.round(ev.clientX - r.left),
        y: Math.round(ev.clientY - r.top),
        button: liveButtonOf(ev),
        buttons: 0,
        clickCount: 1,
        modifiers: liveMods(ev),
        w: sz.w,
        h: sz.h,
      });
    };
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointercancel", up);

    canvas.addEventListener(
      "wheel",
      (ev) => {
        ev.preventDefault();
        const r = canvas.getBoundingClientRect();
        const sz = liveSize();
        BA.liveInput({
          kind: "mouse",
          type: "mouseWheel",
          x: Math.round(ev.clientX - r.left),
          y: Math.round(ev.clientY - r.top),
          button: "none",
          buttons: 0,
          deltaX: Math.round(ev.deltaX),
          deltaY: Math.round(ev.deltaY),
          modifiers: liveMods(ev),
          w: sz.w,
          h: sz.h,
        });
      },
      { passive: false }
    );

    canvas.addEventListener("keydown", (ev) => {
      /* 只吞掉会滚动 / 会触发浏览器默认行为的键；其余交给页面 */
      if (/^(Tab|Backspace|Enter|Arrow|Page|Home|End| |F[0-9])/.test(String(ev.key || ""))) ev.preventDefault();
      const info = liveKeyInfo(ev);
      lastKey = info;
      BA.liveInput({
        kind: "key",
        type: "rawKeyDown",
        key: info.key,
        code: info.code,
        keyCode: info.keyCode,
        text: info.text,
        modifiers: liveMods(ev),
      });
    });
    canvas.addEventListener("keyup", (ev) => {
      const info = lastKey && lastKey.key === ev.key ? lastKey : liveKeyInfo(ev);
      lastKey = null;
      BA.liveInput({
        kind: "key",
        type: "keyUp",
        key: info.key,
        code: info.code,
        keyCode: info.keyCode,
        text: "",
        modifiers: liveMods(ev),
      });
    });
    /* IME / 输入法：合成结束一次性把整段文本送进去（不逐字模拟按键） */
    canvas.addEventListener("compositionend", (ev) => {
      const txt = String((ev && ev.data) || "");
      if (txt) BA.liveInput({ kind: "text", text: txt });
    });
    /* 失焦即停转发：焦点不在面板上时键盘不该继续打进页面 */
    canvas.addEventListener("blur", () => { lastKey = null; });

    BA.livePaintStatus();
  }

  /* 右栏左边缘分界线：整条边界都可拖（命中区由 css/browser.css 的 .ba-resize 铺满栏高，
     取消了原中间那段加宽把手），往左拖 = 活动栏变宽；拖动中只改样式，松手才落盘。
     拖拽口径与左栏 / 助手栏同源 —— app-assist.js 的 bindSideDividerDrag（正常加载顺序下它
     一定在）；但本文件单独被跑起来时（冒烟按文件加载、assist 不在）退化成同样口径的本地
     一份，不靠外部变量活着。 */
  function bindResize() {
    const opts = {
      id: "baResize",
      sign: 1,
      current: () =>
        $("#baPanel") ? $("#baPanel").getBoundingClientRect().width : BA.width(),
      apply: (w, persist) => BA.applyWidth(w, persist),
    };
    if (typeof bindSideDividerDrag === "function") {
      bindSideDividerDrag(opts);
      return;
    }
    const handle = $("#baResize");
    if (!handle || handle._bound) return;
    handle._bound = true;
    let dragging = false;
    let startX = 0;
    let startW = 0;
    const onMove = (ev) => {
      if (!dragging) return;
      opts.apply(startW + (startX - (Number(ev.clientX) || 0)) * opts.sign, false);
    };
    const finish = () => {
      if (!dragging) return;
      dragging = false;
      handle.classList.remove("dragging");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      opts.apply(opts.current(), true);
    };
    handle.addEventListener("pointerdown", (ev) => {
      if (ev.button !== 0) return;
      ev.preventDefault();
      dragging = true;
      startX = Number(ev.clientX) || 0;
      startW = opts.current();
      handle.classList.add("dragging");
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", finish);
      window.addEventListener("pointercancel", finish);
    });
  }

  /* 记住的显隐只在「会话视图」里恢复：画布 / 团队视图下这条栏一律不显示
     （与 app-assist.js 的助手栏同口径），切回会话视图再按当前会话重算（见 setSession）。
     ⚠ 只认「display 真变了」这一次：下面那个 MutationObserver 盯的是 #agentPane 的
     style 属性，而拖分界线的 applyWidth 写的**正是同一个 style 属性**上的 --ba-w。
     若把宽度写入也当成视图切换，拖动中每来一个 pointermove 就会走
     applyDeferred → BA.setSession(force) → applySessionPanel → setOpen → applyWidth(BA.width())，
     用记忆（localStorage，拖动中不落盘 = 还是旧值）把刚拖出来的宽度按回去：
     真机实测拖 360/380/400 全在同一帧内被改回 340，分界线就成了「按得下、拖不动」。
     真切换视图走的是 app-assist.js setView 里的 pane.style.display，照旧命中。 */
  let lastDisplay = null;
  function applyDeferred() {
    const pane = $("#agentPane");
    if (!pane) return;
    const disp = pane.style.display;
    if (disp === lastDisplay) return; /* 不是视图切换（宽度写入 / 其它样式微调）→ 不动宽度 */
    lastDisplay = disp;
    /* 进 / 出会话视图都重算一次会话绑定：活动范围与显隐判据都跟着当前会话，
       不在会话视图时 applySessionPanel 自己早退（隐藏的面板不折腾 DOM）。
       force 只重算，不清内存样本、不重置用户在本次运行里的取舍。 */
    BA.setSession(BA.currentSessionId(), { force: true });
  }

  function boot() {
    const pane = $("#agentPane");
    if (!pane) return;
    BA.ensurePanel();
    BA.applyWidth(BA.width(), false);
    const chip = $("#agentBrowserChip");
    if (chip) chip.onclick = () => BA.toggle();
    const close = $("#baClose");
    if (close) close.onclick = () => BA.setOpen(false);
    $("#baOpen").onclick = () => {
      /* 用户亲手为这条会话开浏览器：记下「它有浏览器」（切走再切回来这条栏还在），
         并把会话带上 —— 网关据此给这次动作的活动条盖归属章。
         **这是唯一会给一只带窗口浏览器的入口**：会话自动拉起的那只默认无窗口
         （开发 / 会话过程中不弹真窗口）。已在跑的是无窗口那只时，网关会重起一只带窗口的，
         所以这里补一次 liveSync 把实况流接到新进程上。 */
      if (BA.sessionId) BA.browserSessions.add(BA.sessionId);
      return BA.browser("open", Object.assign({ visible: true }, BA.sessionId ? { sessionId: BA.sessionId } : {})).then(() => {
        try { BA.liveSync(); } catch (_) {}
      });
    };
    $("#baStop").onclick = () => BA.browser("stop", BA.sessionId ? { sessionId: BA.sessionId } : {});
    $("#baTakeover").onclick = () => BA.toggleTakeover();
    $("#baPolicy").onclick = () => BA.openPolicy();
    $("#baRefresh").onclick = () => BA.reload();
    $("#baFilter").oninput = (e) => { BA.filter = e.target.value.trim().toLowerCase(); BA.render(); };
    $("#baAll").onchange = () => BA.reload();
    $("#baClear").onclick = () => BA.clear();
    /* 「跟随最新」开关：按记忆恢复（默认跟）；手动往上翻 = 想停住看 → 自动停跟随，
       滚回底部 = 想跟上 → 自动恢复，不用先去找开关。 */
    const follow = $("#baFollow");
    if (follow) follow.onclick = () => BA.toggleFollow();
    let followOn = true;
    try { followOn = localStorage.getItem("mtnode.baFollow") !== "0"; } catch (_) {}
    BA.setFollow(followOn, false);
    /* 「只看浏览器」开关（本次需求）：按记忆恢复（默认显示活动），点击即收起 / 展开
       下方活动区并同步停止 / 恢复追踪（见 setListOn；persist=false = 恢复记忆不算用户动作）。 */
    const listOnBtn = $("#baListOn");
    if (listOnBtn) listOnBtn.onclick = () => BA.toggleList();
    let listOnMem = true;
    try { listOnMem = localStorage.getItem("mtnode.baListOn") !== "0"; } catch (_) {}
    BA.setListOn(listOnMem, false);
    const baList = $("#baList");
    if (baList) {
      baList.addEventListener("scroll", () => {
        const atBottom = baList.scrollHeight - baList.scrollTop - baList.clientHeight <= 8;
        if (atBottom !== BA.follow) BA.setFollow(atBottom);
      });
    }
    /* 实况区：模式按钮（独立窗口 / 收回）· 暂停观察 · 画布上的指针 / 滚轮 / 键盘转发 */
    try { bindLive(); } catch (_) {}
    bindResize();
    /* 视图切换（app-assist.js setView 改的是 #agentPane 的 display）时同步：
       进会话视图按记忆恢复右边栏，离开会话视图收起它。 */
    try {
      new MutationObserver(applyDeferred).observe(pane, {
        attributes: true,
        attributeFilter: ["style"],
      });
    } catch (_) {}
    applyDeferred();
    /* 活动流事件（reqId 空 = 全局通道） */
    try {
      if (window.api && typeof window.api.dshOnActivity === "function") window.api.dshOnActivity(BA.onEvent);
    } catch (_) {}
    /* 实况帧（同样走 reqId 为空的全局通道；帧不进活动流、不落库） */
    try {
      if (window.api && typeof window.api.onBrowserFrame === "function") window.api.onBrowserFrame(BA.onFrame);
    } catch (_) {}
    BA.reload();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();

  /* 出口：浏览器活动面板的通道给别的自包含模块用（BA.browser = 会话浏览器控制面这一条通道，
     与面板本身共用，不另造一条）。 */
  window.MTNodeBrowser = { BA };
})();
