/* 浏览器活动右栏「只看浏览器」（收起活动区 + 停追踪）真行为回归
 *   node test/smoke-ba-list-toggle.js
 *
 * 本次需求：实况画面下方的「追踪活动」要能一键不显示，同时也不追踪 ——
 *   · 收起态：#baPanel 带 .ba-list-off（CSS 把活动区整块收掉，实况铺满右栏）；
 *   · 收起态：新活动**不进列表、也不落活动库**（onEvent 直接早退，activityPush 不发）；
 *   · 展开：重新查库并把列表画回来（reload → render）；
 *   · 键面写「点一下会怎样」+ aria-pressed，状态按 localStorage（mtnode.baListOn）记忆。
 * CSS / DOM / i18n 那半由 smoke-browser.js 钉住。
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const APP_BROWSER = fs.readFileSync(path.join(ROOT, "renderer", "app-browser.js"), "utf8");

let fails = 0;
const ok = (cond, msg) => {
  console.log((cond ? "  ok    " : "FAIL  ") + msg);
  if (!cond) fails++;
};
const eq = (got, want, msg) => ok(got === want, msg + "（得到 " + JSON.stringify(got) + "）");
const tick = (n) => new Promise((r) => setTimeout(r, 0)).then(() => (n > 1 ? tick(n - 1) : null));
/* 落库是 400ms 合并一拍（app-browser.js 的 pushTimer）：断言落库前要等它真发出去 */
const settle = () => new Promise((r) => setTimeout(r, 460));

const IDS = [
  "agentPane", "agentBrowserChip", "baPanel", "baResize", "baClose", "baOpen", "baStop",
  "baTakeover", "baPolicy", "baRefresh", "baFilter", "baAll", "baClear", "baFollow", "baListOn",
  "baList", "baCount", "baStatus", "baLiveCanvas", "baLivePause", "baLiveModeBtn", "baLiveMode",
  "baLiveNote", "baLiveMask", "baLive",
];

function mkClassList() {
  const s = new Set();
  return {
    _s: s,
    add: (c) => s.add(c),
    remove: (c) => s.delete(c),
    contains: (c) => s.has(c),
    toggle: (c, on) => {
      if (on === undefined) { s.has(c) ? s.delete(c) : s.add(c); return s.has(c); }
      if (on) s.add(c); else s.delete(c);
      return !!on;
    },
  };
}
function mkEl(id) {
  const handlers = {};
  const el = {
    id,
    hidden: false,
    textContent: "",
    innerHTML: "",
    value: "",
    checked: false,
    clientWidth: 380,
    clientHeight: 400,
    scrollTop: 0,
    scrollHeight: 0,
    title: "",
    attrs: {},
    classList: mkClassList(),
    style: { display: "", width: "", _vars: {}, setProperty(k, v) { this._vars[k] = v; }, removeProperty(k) { delete this._vars[k]; } },
    handlers,
    addEventListener(t, fn) { (handlers[t] = handlers[t] || []).push(fn); },
    removeEventListener(t, fn) { if (handlers[t]) handlers[t] = handlers[t].filter((f) => f !== fn); },
    fire(t, ev) {
      const prop = el["on" + t];
      if (typeof prop === "function") prop(ev || {});
      (handlers[t] || []).slice().forEach((fn) => fn(ev || {}));
    },
    count(t) { return (handlers[t] || []).length; },
    appendChild() {},
    setAttribute(k, v) { el.attrs[k] = v; },
    getAttribute: (k) => (k in el.attrs ? el.attrs[k] : null),
    focus() {},
    getContext: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    setPointerCapture() {},
    hasPointerCapture: () => false,
    releasePointerCapture() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 380, height: 620 }),
  };
  return el;
}

function makeApp(storage) {
  const els = {};
  for (const id of IDS) els[id] = mkEl(id);
  els.baPanel.hidden = true;
  els.baList.clientHeight = 400;
  const store = Object.assign({}, storage || {});
  const calls = { query: 0, push: [] };
  const win = { document: null, I18n: { t: (k) => "T:" + k }, toast: () => {} };
  win.api = {
    dshBrowser: async () => ({ ok: true, running: false }),
    dshBrowserViewStart: async () => ({ ok: true, on: true, mode: "docked" }),
    dshBrowserViewStop: async () => ({ ok: true, on: false }),
    dshBrowserViewInput: async () => ({ ok: true }),
    dshBrowserViewMode: async () => ({ ok: true }),
    activityQuery: async () => { calls.query++; return { ok: true, rows: [], total: 0 }; },
    activityPush: async (rows) => { calls.push.push(rows); return { ok: true }; },
    activityClear: async () => ({ ok: true }),
    dshOnActivity: () => () => {},
    onBrowserFrame: () => () => {},
  };
  const doc = {
    readyState: "complete",
    addEventListener() {},
    body: mkEl("body"),
    querySelector: (sel) => (sel && sel[0] === "#" ? els[sel.slice(1)] || null : null),
    querySelectorAll: () => [],
    createElement: (t) => mkEl(t),
  };
  win.document = doc;
  const sb = {
    console,
    setTimeout,
    clearTimeout,
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    },
    MutationObserver: class { constructor(cb) { this.cb = cb; } observe() {} },
    Image: class {},
    requestAnimationFrame: (cb) => setTimeout(cb, 0),
    document: doc,
  };
  sb.window = win;
  vm.createContext(sb);
  vm.runInContext(APP_BROWSER, sb, { filename: "app-browser.js" });
  return { BA: win.BrowserAct, els, store, calls, btn: els.baListOn, panel: els.baPanel, list: els.baList };
}
const row = (i) => ({ at: Date.now(), kind: "click", text: "活动 " + i, sessionId: "s1" });

(async () => {
  console.log("[1] 默认：活动区显示、追踪开、键面写「只看浏览器」");
  {
    const app = makeApp({ "mtnode.baOpen": "1" });
    await tick(2);
    eq(app.BA.listOn, true, "默认 listOn=true（老行为一字不变）");
    eq(app.panel.classList.contains("ba-list-off"), false, "面板不带 .ba-list-off");
    eq(app.btn.textContent, "T:只看浏览器", "键面写「点一下会怎样」");
    eq(app.btn.attrs["aria-pressed"], "false", "aria-pressed=false（活动区在显示）");
    ok(!!app.btn.title && app.btn.title.indexOf("收起") >= 0, "tooltip 说清点一下会收起 + 停止追踪");
    const before = app.calls.query;
    app.BA.onEvent(row(1));
    await tick(3);
    eq(app.BA.rows.length, 1, "显示态：事件进列表");
    await settle();
    eq(app.calls.push.length, 1, "显示态：事件落活动库（push 一次）");
    ok(app.calls.query >= before, "显示态：reload 正常查库");
  }

  console.log("\n[2] 点「只看浏览器」= 收起活动区 + 停追踪（不重画、不落库）");
  {
    const app = makeApp({ "mtnode.baOpen": "1" });
    await tick(2);
    app.btn.fire("click");
    await tick(2);
    eq(app.BA.listOn, false, "收起后 listOn=false");
    eq(app.panel.classList.contains("ba-list-off"), true, "面板戴上 .ba-list-off（CSS 收掉活动区、实况铺满）");
    eq(app.btn.textContent, "T:显示活动", "键面翻成「显示活动」");
    eq(app.btn.attrs["aria-pressed"], "true", "aria-pressed=true（活动区已收起）");
    eq(app.store["mtnode.baListOn"], "0", "状态落盘 localStorage mtnode.baListOn=0（重开还记得）");
    const q0 = app.calls.query;
    const rows0 = app.BA.rows.length;
    app.BA.onEvent(row(2));
    app.BA.onEvent(row(3));
    await tick(4);
    eq(app.BA.rows.length, rows0, "收起态：事件不进列表");
    eq(app.calls.push.length, 0, "收起态：事件**不落活动库**（停止追踪的实质）");
    eq(app.calls.query, q0, "收起态：不查库（列表不显示就没有重画的必要）");
    app.BA.render();
    eq(app.BA.rows.length, rows0, "收起态：即使被叫去重画也是空转（早退）");
  }

  console.log("\n[3] 再点回来：恢复列表与追踪 + 补查这段时间的库");
  {
    const app = makeApp({ "mtnode.baOpen": "1" });
    await tick(2);
    app.btn.fire("click");
    await tick(2);
    const qOff = app.calls.query;
    app.btn.fire("click");
    await tick(3);
    eq(app.BA.listOn, true, "展开后 listOn=true");
    eq(app.panel.classList.contains("ba-list-off"), false, "面板摘掉 .ba-list-off");
    eq(app.btn.textContent, "T:只看浏览器", "键面翻回「只看浏览器」");
    eq(app.store["mtnode.baListOn"], "1", "状态落盘 mtnode.baListOn=1");
    ok(app.calls.query > qOff, "展开即 reload：把收起这段时间库里攒下的条目补回来");
    app.BA.onEvent(row(9));
    await tick(3);
    eq(app.BA.rows.length, 1, "恢复后：新事件又进列表");
    await settle();
    eq(app.calls.push.length, 1, "恢复后：落库也重新发出");
  }

  console.log("\n[4] 记忆：上次收起的存档，启动就是收起态");
  {
    const app = makeApp({ "mtnode.baOpen": "1", "mtnode.baListOn": "0" });
    await tick(3);
    eq(app.BA.listOn, false, "按记忆恢复收起态");
    eq(app.panel.classList.contains("ba-list-off"), true, "启动即戴 .ba-list-off");
    eq(app.store["mtnode.baListOn"], "0", "恢复不覆写记忆（persist=false）");
    eq(app.calls.push.length, 0, "收起态启动：一条都不落库");
  }

  console.log("\n[5] 收起态不影响「浏览器真在跑就把右栏带出来」");
  {
    /* 有当前会话 + 浏览器真在跑 → autoOpenForUse 的三道刹车都不拦（只被用户亲手关过才拦） */
    const app = makeApp({});
    app.BA.sessionId = "as1";
    app.BA.driver = "as1";
    app.BA.running = true;
    await tick(2);
    app.btn.fire("click"); /* 收起 */
    await tick(2);
    app.BA.onEvent({ at: Date.now(), kind: "navigate", text: "打开某站", sessionId: "as1" });
    await tick(6);
    eq(app.BA.listOn, false, "仍是收起态（这条事件不落库）");
    ok(app.BA.isOpen(), "右栏照旧被浏览器活动带出来（收起的是活动区，不是整条栏）");
    eq(app.calls.push.length, 0, "带出来的这一拍也没有落库");
  }

  console.log(fails ? "\n✗ " + fails + " 项失败" : "\n✓ 全部通过  (smoke-ba-list-toggle)");
  process.exit(fails ? 1 : 0);
})();
