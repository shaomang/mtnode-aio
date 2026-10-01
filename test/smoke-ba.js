/* test/smoke-ba.js — 合并聚合用例（由同模块小用例合并而成）
 * 运行：node test/smoke-ba.js
 */
const fs = require("fs"), path = require("path"), vm = require("vm"), os = require("os"), childProcess = require("child_process");
const SHARED = { fs, path, vm, os, spawn: childProcess.spawn };
const TEST_DIR = __dirname;
let MERGED_FAILED = false;

/* ==================== 已并入：test/smoke-ba-list-toggle.js ==================== */
(function () {
  const __dirname = TEST_DIR;
  const __filename = TEST_DIR + "/" + "smoke-ba-list-toggle.js";
  const { fs, path, vm, os, spawn } = SHARED;
  const section = (name) => console.log("\n" + name);
  let fails = 0, checks = 0;
  const ok = (cond, msg) => { checks++; if (cond) console.log("  ok  " + msg); else { fails++; MERGED_FAILED = true; console.log("FAIL  " + msg); } };
  try {

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
    if (fails ? 1 : 0) MERGED_FAILED = true;
  })();

  } catch (e) {
    MERGED_FAILED = true;
    console.log("FAIL  [合并块异常] smoke-ba-list-toggle.js：" + (e && e.stack ? e.stack : e));
  }
  if (fails) console.log("  ── 已并入块 smoke-ba-list-toggle.js：" + fails + " / " + checks + " 项失败");
})();

/* ==================== 已并入：test/smoke-ba-follow.js ==================== */
(function () {
  const __dirname = TEST_DIR;
  const __filename = TEST_DIR + "/" + "smoke-ba-follow.js";
  const { fs, path, vm, os, spawn } = SHARED;
  const section = (name) => console.log("\n" + name);
  let fails = 0, checks = 0;
  const ok = (cond, msg) => { checks++; if (cond) console.log("  ok  " + msg); else { fails++; MERGED_FAILED = true; console.log("FAIL  " + msg); } };
  try {

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
  const tick = () => new Promise((r) => setTimeout(r, 0));

  const IDS = [
    "agentPane", "agentBrowserChip", "baPanel", "baResize", "baClose", "baOpen", "baStop",
    "baTakeover", "baPolicy", "baRefresh", "baFilter", "baAll", "baClear", "baFollow",
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
      /* onclick / onchange 这类属性式接线也要能被点（app-browser 用的是 el.onclick） */
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
    const win = { document: null, I18n: { t: (k) => k }, toast: () => {} };
    win.api = {
      dshBrowser: async () => ({ ok: true, running: false }),
      dshBrowserViewStart: async () => ({ ok: true, on: true, mode: "docked" }),
      dshBrowserViewStop: async () => ({ ok: true, on: false }),
      dshBrowserViewInput: async () => ({ ok: true }),
      dshBrowserViewMode: async () => ({ ok: true }),
      activityQuery: async () => ({ ok: true, rows: [], total: 0 }),
      activityPush: async () => ({ ok: true }),
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
    return { BA: win.BrowserAct, els, store, list: els.baList, btn: els.baFollow };
  }
  const row = (i) => ({ at: Date.now(), kind: "click", text: "活动 " + i, sessionId: "s1" });

  (async () => {
    console.log("[1] 默认跟随最新：重画停在最新一条，键面是「停止跟随」");
    {
      const app = makeApp({ "mtnode.baOpen": "1" });
      await tick(); await tick();
      eq(app.BA.follow, true, "默认跟随（老行为不变）");
      eq(app.btn.textContent, "停止跟随", "键面写「点一下会怎样」（与 接管/交还 同口径）");
      ok(app.btn.classList.contains("on") && app.btn.attrs["aria-pressed"] === "true", "跟随中 = 键是亮的 + aria-pressed");

      for (let i = 0; i < 5; i++) app.BA.rows.push(row(i));
      app.list.scrollHeight = 1000;
      app.list.scrollTop = 0;
      app.BA.render();
      eq(app.list.scrollTop, 1000, "跟随中：每次重画都停在最新（scrollTop = scrollHeight）");
    }

    console.log("\n[2] 点「停止跟随」后：新活动照旧进来，视线留在原处（不被拽回底部）");
    {
      const app = makeApp({ "mtnode.baOpen": "1" });
      await tick(); await tick();
      app.btn.fire("click", {});
      eq(app.BA.follow, false, "点一下 → 停跟随");
      eq(app.store["mtnode.baFollow"], "0", "状态落盘 localStorage mtnode.baFollow=0（重开还记得）");
      eq(app.btn.textContent, "跟随最新", "键面翻成「跟随最新」（点一下恢复）");
      ok(!app.btn.classList.contains("on") && app.btn.attrs["aria-pressed"] === "false", "停跟随 = 键不亮");

      for (let i = 0; i < 5; i++) app.BA.rows.push(row(i));
      app.list.scrollHeight = 1000;
      app.list.scrollTop = 200;          /* 往上翻了 200px 在看旧记录 */
      app.BA.render();
      eq(app.list.scrollTop, 200, "重画后视线仍在 200（不再被拽回底部）");

      app.BA.rows.push(row(9));
      app.list.scrollHeight = 1200;
      app.BA.render();
      eq(app.list.scrollTop, 200, "又来新活动、列表变长，位置也不动");

      app.btn.fire("click", {});
      eq(app.BA.follow, true, "再点一下 → 恢复跟随");
      eq(app.store["mtnode.baFollow"], "1", "恢复也落盘");
      eq(app.list.scrollTop, 1200, "恢复跟随立刻回到最新一条");
    }

    console.log("\n[3] 不用先找开关：手动往上翻自动停跟随，滚回底部自动恢复");
    {
      const app = makeApp({ "mtnode.baOpen": "1" });
      await tick(); await tick();
      eq(app.list.count("scroll"), 1, "活动列表接了 scroll 监听（一条，不叠）");

      app.BA.rows.push(row(1));
      app.list.scrollHeight = 1000;
      app.list.scrollTop = 200;
      app.list.fire("scroll", {});                    /* 1000-200-400 = 400 > 8 → 不在底部 */
      eq(app.BA.follow, false, "往上翻 → 自动停跟随");
      eq(app.btn.textContent, "跟随最新", "键面跟着变（用户看得见状态）");
      eq(app.store["mtnode.baFollow"], "0", "自动停也落盘");

      app.list.scrollTop = 600;                       /* 1000-600-400 = 0 → 到底了 */
      app.list.fire("scroll", {});
      eq(app.BA.follow, true, "滚回底部 → 自动恢复跟随");
      eq(app.btn.textContent, "停止跟随", "键面翻回来");
    }

    console.log("\n[4] 记忆：上次停在「停止跟随」，重开面板还是停的");
    {
      const app = makeApp({ "mtnode.baOpen": "1", "mtnode.baFollow": "0" });
      await tick(); await tick();
      eq(app.BA.follow, false, "按记忆恢复「已停跟随」");
      eq(app.btn.textContent, "跟随最新", "键面直接是恢复态（用户一眼看得出）");
      app.BA.rows.push(row(1));
      app.list.scrollHeight = 1000;
      app.list.scrollTop = 120;
      app.BA.render();
      eq(app.list.scrollTop, 120, "重开后的第一帧也不拽人（跟关闭状态一致）");
    }

    console.log("\n[5] 切界面语言：JS 画的键面文字跟着换（repaintChrome）");
    {
      const app = makeApp({ "mtnode.baOpen": "1" });
      await tick(); await tick();
      ok(typeof app.BA.repaintChrome === "function", "暴露 repaintChrome 给 app-boot.js 的 applyLocale");
      app.BA.follow = true;
      app.btn.textContent = "";
      app.BA.repaintChrome();
      eq(app.btn.textContent, "停止跟随", "重画回当前状态的键面文字（applyDom 碰不到它）");
    }

    console.log(fails ? "\nFAIL " + fails + " 项" : "\n全部通过");
    if (fails ? 1 : 0) MERGED_FAILED = true;
  })();

  } catch (e) {
    MERGED_FAILED = true;
    console.log("FAIL  [合并块异常] smoke-ba-follow.js：" + (e && e.stack ? e.stack : e));
  }
  if (fails) console.log("  ── 已并入块 smoke-ba-follow.js：" + fails + " / " + checks + " 项失败");
})();

/* 收尾：正文与并入块任一失败都算这只红；退出码只在全部跑完之后才定 */
if (MERGED_FAILED) console.log("\n✗ 本文件有失败项（含已并入块）\n");
process.exit(MERGED_FAILED ? 1 : 0);
