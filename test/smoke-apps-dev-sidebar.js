"use strict";
/* 应用开发页左栏「以应用为主体」的逻辑冒烟：
 *   node test/smoke-apps-dev-sidebar.js
 *
 * 本轮需求（renderer/app-apps-dev.js + renderer/app-assist.js）：
 *   ① 左栏由「当前应用的会话列表」改成**应用列表**（每个应用一行，会话折叠在它自己下面）；
 *   ② 点左栏某应用 = 选中它（中栏预览与右栏会话一起换）；回到开发页自动选上次打开的应用；
 *   ③ 「＋ 新建应用」从顶栏菜单条移到左栏列表底部（顶栏那条下拉 + 「应用」字样 + 作者整组删掉）；
 *   ④ 切应用时预览盖一层黑幕（底色改不透明黑），新页加载完成前不闪白；
 *   ⑤ 「新开发会话」移到左栏每条应用行右端、用「＋」表示（点它 = 切到该应用并回到首轮态，
 *      下一次输入就在这个应用下新建一条会话）。
 *
 * 这里真跑 renderer/app-apps-dev.js（借本文件自带的迷你 DOM：
 * vm 沙箱 + 手搓 DOM），钉住的都是能在 DOM / 返回值上看见的行为，不是源码字符串：
 *   [1] appsDevSidebarHost：应用分组（只列 dev:true / 顺序照本机列表 / 已归档会话不进左栏 /
 *       当前应用标记 + 默认展开）
 *   [2] 展开收起：appsDevAppToggle 翻一位并立刻重绘，当前应用默认展开
 *   [3] 默认选中应用：appsDevPickApp（当前 > 上次打开 > 第一个）与 appsDevLastAppSave 落盘
 *   [4] 预览黑幕：appsDevCurtainShouldShow（只在换应用时 true）+ Show / Drop 真往预览容器里挂 / 撤
 *   [5] 左栏真画出来了（应用行 + 会话折叠 + 搜索 + 老路径不变）
 *   [6] 应用行右端「＋」新开发会话（宿主 onAppNew → appsDevNewSessionFor；本应用 = 回首轮态，
 *       别的应用 = 切过去）
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let fails = 0;
let checks = 0;
function ok(cond, msg) {
  checks++;
  if (cond) console.log("  ok    " + msg);
  else {
    fails++;
    console.log("FAIL  " + msg);
  }
}
const read = (rel) =>
  fs.readFileSync(path.join(__dirname, "..", rel.split("/").join(path.sep)), "utf8");

/* ============================ 迷你 DOM（与 smoke-apps-dev-borrow.js 同口径） ============================ */
function mkEl(tag, cls, id) {
  const el = {
    nodeType: 1,
    tagName: String(tag || "div").toUpperCase(),
    id: String(id || ""),
    parentNode: null,
    children: [],
    dataset: {},
    _cls: new Set(String(cls || "").split(/\s+/).filter(Boolean)),
  };
  el.classList = {
    add: (c) => el._cls.add(c),
    remove: (c) => el._cls.delete(c),
    contains: (c) => el._cls.has(c),
    toString: () => Array.from(el._cls).join(" "),
  };
  el.appendChild = (c) => {
    if (!c) return c;
    if (c.parentNode) c.parentNode.removeChild(c);
    c.parentNode = el;
    el.children.push(c);
    return c;
  };
  el.removeChild = (c) => {
    const i = el.children.indexOf(c);
    if (i >= 0) el.children.splice(i, 1);
    if (c) c.parentNode = null;
    return c;
  };
  el.remove = () => {
    if (el.parentNode) el.parentNode.removeChild(el);
  };
  el.contains = (node) => {
    for (let n = node; n; n = n.parentNode) if (n === el) return true;
    return false;
  };
  el.setAttribute = () => {};
  /* innerHTML = "" 必须真的清空（左栏每次重绘都这么清；不实现它 = 行会一层层叠起来） */
  Object.defineProperty(el, "innerHTML", {
    get: () => el.textContent || "",
    set: () => {
      for (const c of el.children.slice()) el.removeChild(c);
    },
  });
  /* className 与 classList 同一份集合（真实 DOM 就是这样；黑幕那层是 setAttribute
     + className 一起用的，测试里必须能读到） */
  Object.defineProperty(el, "className", {
    get: () => Array.from(el._cls).join(" "),
    set: (v) => {
      el._cls = new Set(String(v || "").split(/\s+/).filter(Boolean));
    },
  });
  return el;
}
function docGetById(root, id) {
  const walk = (node) => {
    if (node.id === id) return node;
    for (const c of node.children || []) {
      const hit = walk(c);
      if (hit) return hit;
    }
    return null;
  };
  return walk(root);
}

/* 本机应用清单：只列 dev:true 的顺序与库页一致（安装时间新→旧），所以顺序敏感 */
const APPS = [
  { id: "app-new", name: "新应用", dev: true, author: "ms2308" },
  { id: "app-mid", name: "中间应用", dev: true },
  { id: "app-lib", name: "库页应用" /* dev 没写 = 不在开发名单里 */ },
];
const SESSIONS = {
  "app-new": [
    { id: "s1", title: "开发 · 新应用", appId: "app-new", updatedAt: 3 },
    { id: "s0", title: "旧会话", appId: "app-new", updatedAt: 1, archived: true },
  ],
  "app-mid": [{ id: "s2", title: "开发 · 中间应用", appId: "app-mid", updatedAt: 2 }],
};

function build() {
  const root = mkEl("body", "", "");
  const list = mkEl("div", "agent-side-list", "appsDevSideList");
  const wrap = mkEl("div", "apps-dev-framewrap", "");
  const frame = wrap.appendChild(mkEl("iframe", "apps-dev-frame", "appsDevFrame"));
  root.appendChild(list);
  root.appendChild(wrap);
  const calls = { sidebar: 0, paint: 0, configSave: [] };
  const S = { config: {} };
  const sandbox = {
    document: {
      getElementById: (id) => docGetById(root, String(id)),
      querySelector: () => null,
      createElement: (t) => mkEl(t),
      body: root,
      contains: (n) => root.contains(n),
      querySelectorAll: () => [],
      addEventListener: () => {},
      removeEventListener: () => {},
    },
    window: { api: { configSave: (cfg) => { calls.configSave.push(cfg); return Promise.resolve(); } } },
    console,
    I18n: { t: (x) => x },
    APPS_ST: { nav: "dev" },
    S,
    appsHubIsOpen: () => true,
    appsLocalList: () => APPS,
    appsLocalById: (id) => APPS.find((a) => a.id === id) || null,
    appsAuthorOf: (a) =>
      String((a && (a.owner || a.author)) || "").trim() || "ms2308",
    appSessionsOf: (id) =>
      (SESSIONS[id] || []).slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)),
    renderAgentSessionSidebar: () => {
      calls.sidebar++;
    },
    appsHubPaint: () => {
      calls.paint++;
    },
    setTimeout: () => 0,
    clearTimeout: () => {},
    S: S,
  };
  vm.createContext(sandbox);
  vm.runInContext(read("renderer/app-apps-dev.js"), sandbox, {
    filename: "renderer/app-apps-dev.js",
  });
  const get = (expr) => vm.runInContext(expr, sandbox);
  return { sandbox, DEVD: get("DEVD"), get, calls, S, list, wrap, frame };
}
/* 把开发页「装起来」：页面算开着（listEl 在 DOM 里 + 选中了一个应用 + nav=dev）。
   注意 appId 空 = 页面不算开着（appsDevPageOpen 的判据），所以这里必须给一个应用。 */
function open(s, appId) {
  s.DEVD.listEl = s.list;
  s.DEVD.appId = appId || "app-new";
}

/* ============================ [1] 应用分组宿主 ============================ */
console.log("[1] 左栏宿主（appsDevSidebarHost）：应用分组 + 只列开发中 + 已归档不进左栏");
{
  const s = build();
  s.DEVD.listEl = s.list;
  ok(s.get("appsDevSidebarHost()") === null, "还没选中应用时宿主为 null（会话视图照旧走自己的路径）");
  open(s);
  const host = s.get("appsDevSidebarHost()");
  ok(!!host && Array.isArray(host.apps), "页面开着时宿主给的是「应用分组」（apps 数组）");
  ok(
    host.apps.map((g) => g.id).join(",") === "app-new,app-mid",
    "只列 dev:true 的应用、顺序照本机列表（新→旧）：得到 " + host.apps.map((g) => g.id).join(","),
  );
  ok(
    host.apps[0].count === 1 && host.apps[0].sessions.length === 1,
    "已归档的会话不进左栏（app-new 有 2 条、只剩未归档的 1 条）",
  );
  ok(
    host.apps[0].author === "ms2308",
    "应用行带作者（与库页同一口径 appsAuthorOf）：得到 " + host.apps[0].author,
  );
  ok(
    typeof host.onAppSelect === "function" && typeof host.onAppToggle === "function",
    "宿主给出两个动作（点行 = 选应用，点箭头 = 展开收起）",
  );
  s.DEVD.appId = "app-gone";
  const hostGone = s.get("appsDevSidebarHost()");
  ok(
    hostGone.apps.every((g) => !g.current && !g.expanded),
    "选中的那个应用已不在本机时：没有 current、也没人展开（页面会自行回落到名单里的应用）",
  );
  s.DEVD.appId = "app-mid";
  const host2 = s.get("appsDevSidebarHost()");
  ok(
    host2.apps[1].current === true && host2.apps[1].expanded === true,
    "当前应用 = current 且默认展开，其它应用收起",
  );
  ok(host2.apps[0].expanded === false, "非当前应用默认收起");
  ok(host2.active === "", "首轮态（draft）左栏没有活跃会话行");
  s.DEVD.draft = false;
  s.DEVD.sessionId = "s2";
  ok(s.get("appsDevSidebarHost()").active === "s2", "非首轮态活跃行 = 本页正显示的那条会话");
}

/* ============================ [2] 展开收起 ============================ */
console.log("[2] 展开收起（appsDevAppToggle）：翻一位 + 立刻重绘");
{
  const s = build();
  open(s);
  s.DEVD.appId = "app-new";
  const before = s.calls.sidebar;
  s.get('appsDevAppToggle("app-new")');
  ok(s.get('appsDevAppExpanded("app-new")') === false, "点箭头：当前应用收起");
  ok(s.calls.sidebar > before, "收起即重绘左栏（renderAgentSessionSidebar 被调）");
  s.get('appsDevAppToggle("app-new")');
  ok(s.get('appsDevAppExpanded("app-new")') === true, "再点一次：又展开");
  s.get('appsDevAppToggle("app-mid")');
  ok(
    s.get('appsDevAppExpanded("app-mid")') === true &&
      s.get('appsDevAppExpanded("app-new")') === true,
    "别的应用也能各自展开（展开态按应用分别记）",
  );
  ok(
    typeof s.DEVD.expanded === "object" && s.DEVD.expanded !== null,
    "展开态记在 DEVD.expanded（会话级记忆，不落盘、不动画布）",
  );
}

/* ============================ [3] 默认选中的应用 ============================ */
console.log("[3] 回开发页选哪个应用（appsDevPickApp / appsDevLastAppSave）");
{
  const s = build();
  open(s);
  ok(
    s.get("appsDevPickApp(appsDevApps())") === "app-new",
    "没记过、也没选中过 → 名单第一个（不会出现「没选中应用」的空页）",
  );
  s.get('appsDevLastAppSave("app-mid")');
  ok(
    s.S.config.appsDevLastApp === "app-mid" && s.calls.configSave.length === 1,
    "选中应用即写回 config.appsDevLastApp（走 window.api.configSave，与三栏宽度同一落盘口径）",
  );
  s.DEVD.appId = ""; /* 本页还没选中任何应用 = 刚回开发页 */
  ok(
    s.get("appsDevPickApp(appsDevApps())") === "app-mid",
    "回到开发页自动选「上次打开过的应用」",
  );
  s.S.config.appsDevLastApp = "app-gone";
  ok(
    s.get("appsDevLastAppId()") === "" && s.get("appsDevPickApp(appsDevApps())") === "app-new",
    "上次那个应用已不在本机 → 退回名单第一个",
  );
  s.DEVD.appId = "app-mid";
  ok(
    s.get("appsDevPickApp(appsDevApps())") === "app-mid",
    "本页当前选中的优先（重绘不会把用户选好的应用换掉）",
  );
  s.DEVD.appId = "";
  s.S.config = {};
  s.calls.configSave.length = 0;
  s.get('appsDevLastAppSave("app-new")');
  s.get('appsDevLastAppSave("app-new")');
  ok(s.calls.configSave.length === 1, "同值不重复落盘（重绘不刷盘）");
}

/* ============================ [4] 预览黑幕 ============================ */
console.log("[4] 切应用的预览黑幕（appsDevCurtainShouldShow / Show / Drop）");
{
  const s = build();
  s.DEVD.frameWrap = s.wrap;
  ok(s.get("appsDevCurtainShouldShow(\"app-new\")") === false, "首次进开发页不盖幕（lastApp 还是空）");
  s.DEVD.lastApp = "app-new";
  ok(
    s.get("appsDevCurtainShouldShow(\"app-new\")") === false,
    "同一个应用重绘不盖幕（日常「刷新预览」不闪黑）",
  );
  ok(s.get("appsDevCurtainShouldShow(\"app-mid\")") === true, "换应用才盖幕");
  ok(s.get("appsDevCurtainShouldShow(\"\")") === false, "没有选中应用时不盖幕");
  s.get("appsDevCurtainShow()");
  const cur = s.get("DEVD.curtainEl");
  ok(!!cur && s.wrap.contains(cur), "Show：黑幕真挂在预览容器（.apps-dev-framewrap）里");
  ok(cur._cls.has("apps-dev-curtain"), "黑幕类名 = .apps-dev-curtain（css 里那层不透明黑）");
  ok(Number(s.get("DEVD.curtainTimer")) >= 0, "Show：挂了超时兜底（load 事件没来也得撤幕）");
  s.get("appsDevCurtainDrop()");
  ok(s.get("DEVD.curtainEl") === null, "Drop：引用清掉");
  ok(cur._cls.has("hide"), "Drop：加 .hide（淡出，不是硬切）");
  s.get("appsDevCurtainDrop()");
  ok(true, "Drop 幂等：没幕时再调不抛错（load 与超时会同时到）");
}

/* ============================ [5] 左栏真画出来了（app-assist.js 应用分组渲染） ============================ */
/* renderer/app-assist.js 与 renderer/app-apps-dev.js 放进同一个 vm 上下文真跑：
   左栏第一层必须是**应用行**、会话缩进一层挂在各自应用下、搜索同时搜应用名与会话标题；
   同时钉住「宿主不在 → 总会话视图（按项目目录分组）那条老路径一字未变」。 */
const SESSION_LIST_ALL = [
  { id: "s9", title: "画布会话", workspace: "E:\\proj", updatedAt: 5, messages: [] },
];
function buildSidebar() {
  const root = mkEl("body", "", "");
  const list = mkEl("div", "agent-side-list", "appsDevSideList");
  const sideAll = mkEl("div", "agent-side-list", "agentSideList");
  root.appendChild(list);
  root.appendChild(sideAll);
  const calls = { paint: 0 };
  const noop = () => {};
  const sandbox = {
    document: {
      getElementById: (id) => docGetById(root, String(id)),
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: (t) => mkEl(t),
      createTextNode: (x) => ({ nodeType: 3, textContent: String(x) }),
      body: root,
      contains: (n) => root.contains(n),
      addEventListener: noop,
      removeEventListener: noop,
      activeElement: null,
    },
    window: {},
    console,
    I18n: { t: (x) => x, getLocale: () => "zh" },
    APPS_ST: { nav: "dev" },
    /* agentSessions() 读的是 S.agentSessions（app-assist.js 里的真函数），所以老路径那条
       检查要把会话放在这里；开发页那条路径走 appSessionsOf（本测试自己给的桩）。 */
    S: { agentSessions: SESSION_LIST_ALL },
    $: (sel) => (String(sel) === "#appsDevSideList" ? list : String(sel) === "#agentSideList" ? sideAll : null),
    appsHubIsOpen: () => true,
    appsLocalList: () => APPS,
    appsLocalById: (id) => APPS.find((a) => a.id === id) || null,
    appsAuthorOf: (a) => String((a && (a.owner || a.author)) || ""),
    appSessionsOf: (id) =>
      (SESSIONS[id] || []).slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)),
    agentSessions: () => SESSION_LIST_ALL,
    agentSessionById: (id) => SESSION_LIST_ALL.concat(
      Object.values(SESSIONS).reduce((o, arr) => o.concat(arr), []),
    ).find((s) => s.id === id) || null,
    sessionLastAt: (s) => Number((s && s.updatedAt) || 0),
    formatRelTime: () => "刚刚",
    formatMsgStamp: () => "",
    sessionBusyForUi: () => false,
    sessionIsRunning: () => false,
    sessionIsDevBoundTitle: () => false,
    sessionCanvasName: () => "",
    sessionWorkspaceTooltipLine: () => "",
    sessionWorkspaceShown: (s) => String((s && s.workspace) || "默认目录"),
    wsGroupOf: (w) => String(w || "默认目录"),
    activeAgentId: () => "",
    startSessionTitleEdit: noop,
    forkAgentSession: async () => {},
    archiveAgentSession: async () => {},
    deleteAgentSession: async () => {},
    startAgentSideTimeTicker: noop,
    setInterval: () => 0,
    clearInterval: noop,
    setTimeout: () => 0,
    clearTimeout: noop,
    appsHubPaint: () => {
      calls.paint++;
    },
    appsDevToast: noop,
    toast: noop,
  };
  vm.createContext(sandbox);
  for (const f of ["renderer/app-apps-dev.js", "renderer/app-assist.js"]) {
    vm.runInContext(read(f), sandbox, { filename: f });
  }
  const get = (expr) => vm.runInContext(expr, sandbox);
  return { sandbox, get, calls, list, sideAll, DEVD: get("DEVD") };
}
const cls = (el) => el.className;
const kidRows = (box, c) => (box.children || []).filter((x) => String(cls(x)).split(/\s+/).includes(c));
const textOf = (el) => (el.children || []).map((c) => c.textContent || "").join(" ");
console.log("[5] 左栏真画出来了：应用行 + 会话折叠 + 搜索 + 老路径不变");
{
  const s = buildSidebar();
  s.DEVD.listEl = s.list;
  s.DEVD.appId = "app-new";
  s.get("renderAgentSessionSidebar()");
  const apps = kidRows(s.list, "side-apps-app");
  ok(apps.length === 2, "第一层是应用行（2 个开发中的应用）：得到 " + apps.length);
  ok(
    apps[0].children.some((c) => c.textContent === "新应用") &&
      apps[1].children.some((c) => c.textContent === "中间应用"),
    "应用行写的是应用名，顺序照本机列表",
  );
  ok(
    apps[0].children.some((c) => String(c.textContent) === "作者 ms2308"),
    "作者跟在应用行上（顶栏那条下拉整组删掉后它在这里）",
  );
  ok(
    apps[0].children.some((c) => c.textContent === "1"),
    "应用行带会话数（不含已归档：app-new 显示 1）",
  );
  ok(
    cls(apps[0]).includes("active") && !cls(apps[1]).includes("active"),
    "当前应用那个行高亮（active），别的应用不亮",
  );
  const sessRows = kidRows(s.list, "side-sess");
  ok(
    sessRows.length === 1 && sessRows[0].dataset && sessRows[0].dataset.sid === "s1",
    "只有展开的应用（当前应用）画出它的会话行：得到 " + sessRows.length + " 条",
  );
  ok(
    cls(sessRows[0]).includes("side-apps-sess"),
    "应用下的会话行带缩进类 side-apps-sess（层级靠留白表达）",
  );
  ok(
    !kidRows(s.list, "side-sess").some((r) => r.dataset.sid === "s0"),
    "已归档的会话不进左栏（s0 不画）",
  );
  const carets = kidRows(s.list, "side-apps-app").map((r) =>
    (r.children || []).filter((c) => String(cls(c)).includes("side-apps-caret"))[0],
  );
  ok(
    carets[0].textContent === "▾" && carets[1].textContent === "▸",
    "箭头方向跟着展开态（当前应用 ▾，收起的 ▸）",
  );
  /* 点箭头：收起当前应用 → 它的会话行消失（并且不让 click 冒到行身 = 不换应用） */
  let stopped = false;
  carets[0].onclick({ stopPropagation: () => { stopped = true; } });
  ok(stopped, "点箭头 stopPropagation（收起 ≠ 选中该应用）");
  ok(
    kidRows(s.list, "side-sess").length === 0 &&
      (s.list.children || []).filter((r) => String(cls(r)).includes("side-apps-app")).length === 2,
    "收起后：应用行还在、它的会话行不再画（会话行 " +
      kidRows(s.list, "side-sess").length +
      " / 应用行 " +
      (s.list.children || []).filter((r) => String(cls(r)).includes("side-apps-app")).length +
      "）",
  );
  /* 点行身：选中那个应用（appsDevSelectApp → 整页重绘） */
  const before = s.calls.paint;
  apps[1].onclick();
  ok(
    s.DEVD.appId === "app-mid" && s.calls.paint > before,
    "点应用行 = 选中它（DEVD.appId 换过去 + 整页重绘，中栏预览与右栏会话一起换）",
  );
  ok(
    s.DEVD.expanded["app-mid"] === true,
    "选中的应用一定展开（点它就是要看它的会话）",
  );
  s.get("renderAgentSessionSidebar()");
  ok(
    kidRows(s.list, "side-sess").length === 1 &&
      kidRows(s.list, "side-sess")[0].dataset.sid === "s2",
    "换应用后左栏画的是新应用的会话",
  );
  /* 搜索：应用名命中 → 连它的会话一起留；会话标题命中 → 只留命中的；都不命中 → 空态 */
  s.DEVD.filter = "中间";
  s.get("renderAgentSessionSidebar()");
  ok(
    kidRows(s.list, "side-apps-app").length === 1 &&
      kidRows(s.list, "side-sess").length === 1,
    "搜索命中应用名：只留那个应用（连它的会话）",
  );
  s.DEVD.filter = "旧会话";
  s.get("renderAgentSessionSidebar()");
  ok(
    kidRows(s.list, "side-apps-app").length === 0 &&
      kidRows(s.list, "side-empty").length === 1,
    "搜索：只命中一条**已归档**会话 → 左栏不列它，给一行空态",
  );
  s.DEVD.filter = "";
  s.DEVD.listEl = null; /* 关掉开发页 = 宿主不生效 */
  s.get("renderAgentSessionSidebar()");
  ok(
    kidRows(s.sideAll, "side-group").length === 1 &&
      kidRows(s.sideAll, "side-sess").length === 1,
    "宿主不在：总会话视图照旧按「项目目录」分组渲染进 #agentSideList（老路径没动）：组 " +
      kidRows(s.sideAll, "side-group").length +
      " / 会话 " +
      kidRows(s.sideAll, "side-sess").length,
  );
  ok(
    kidRows(s.list, "side-apps-app").length === 0,
    "会话视图那条路径不会写进开发页左栏容器",
  );
}

/* ============ [6] 应用行右端「＋」= 新开发会话 ============ */
/* 本轮需求：入口从开发页顶栏挪到左栏每条应用行右端，用「＋」表示。
   这里真画左栏（app-assist.js 的 mkAppRow + app-apps-dev.js 的宿主回调一起跑）：
   每行右侧一颗 .side-apps-new；点当前应用的那颗 = 回首轮态（下一次输入即新建会话），
   点别的应用的那颗 = 先切到那个应用（否则会出现「左栏指着 A、右栏在 A 下建会话」的分家）。 */
console.log("[6] 应用行右端「＋」新开发会话（宿主 onAppNew）");
{
  const s = buildSidebar();
  s.DEVD.listEl = s.list;
  s.DEVD.appId = "app-new";
  s.get("renderAgentSessionSidebar()");
  ok(
    typeof s.get("appsDevSidebarHost()").onAppNew === "function",
    "宿主给出 onAppNew（app-assist.js 的应用行按它挂「＋」）",
  );
  const apps = kidRows(s.list, "side-apps-app");
  const plusOf = (row) =>
    (row.children || []).filter((c) => String(cls(c)).includes("side-apps-new"))[0];
  ok(
    apps.length === 2 && apps.every((r) => !!plusOf(r)),
    "每条应用行右端各一枚「＋」（应用数 = 按钮数）：得到 " +
      apps.filter((r) => !!plusOf(r)).length +
      " 枚",
  );
  ok(
    plusOf(apps[0]).textContent === "＋",
    "按钮内容就是一枚「＋」（不再是「＋ 新开发会话」全文字）：得到 " + plusOf(apps[0]).textContent,
  );
  /* 点当前应用那颗：不换应用、不动整页重绘，只回到首轮态 */
  let stopped = false;
  s.DEVD.draft = false;
  s.DEVD.sessionId = "s1";
  const before = s.calls.paint;
  plusOf(apps[0]).onclick({ stopPropagation: () => { stopped = true; } });
  ok(stopped, "点「＋」stopPropagation（新开发会话 ≠ 行身的选中该应用）");
  ok(
    s.DEVD.appId === "app-new" && s.DEVD.draft === true && s.DEVD.sessionId === "",
    "点当前应用的「＋」= 回到首轮态（下一次输入就在这个应用下新建会话）",
  );
  ok(s.calls.paint === before, "点当前应用的「＋」不触发整页重绘（本页本就指着它）");
  /* 点别的应用那颗：先切过去（整页重绘 + 选中项换过去），再回首轮态 */
  const before2 = s.calls.paint;
  plusOf(apps[1]).onclick({ stopPropagation: () => {} });
  ok(
    s.DEVD.appId === "app-mid" && s.calls.paint > before2,
    "点别的应用的「＋」= 先切到那个应用（整页重绘：中栏预览与右栏会话一起换）",
  );
  ok(
    s.DEVD.draft === true && s.DEVD.sessionId === "" && s.DEVD.expanded["app-mid"] === true,
    "切过去即首轮态、该应用展开（新会话就建在它名下）",
  );
  ok(
    s.get("appsDevNewSessionFor(\"app-mid\")") === undefined &&
      s.DEVD.appId === "app-mid" &&
      s.DEVD.draft === true,
    "宿主回调 appsDevNewSessionFor 与「＋」同一处实现（当前应用 = 直接回首轮态）",
  );
  /* 应用 id 拿不到（行没画全 / 老壳）时按「当前应用」处理：回首轮态，不瞎切应用 */
  s.get('appsDevNewSessionFor("")');
  ok(
    s.DEVD.appId === "app-mid" && s.DEVD.draft === true,
    "空的 appId = 按当前应用回首轮态（不把本页切到空应用）",
  );
}

console.log("");
if (fails) {
  console.log("FAILED " + fails + " / " + checks + " 项检查");
  process.exit(1);
}
console.log("ALL PASS " + checks + " 项检查");