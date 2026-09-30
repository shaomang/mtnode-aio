/* 浏览器活动右栏「跟随最新 / 停止跟随」真行为回归（vm 沙箱里真按、真滚动）
 *   node test/smoke-ba-follow.js
 *
 * 钉住用户报的第二件事：活动列表一直「追踪」最新活动 —— 往上翻看旧记录，新活动一来
 * 就被拽回底部。现在给一个「停止跟随」开关（默认跟随），并且：
 *   · 拖着不动时，关掉跟随后再重画，视线留在原处（不被拽回底部）；
 *   · 手动往上翻 = 想停住看 → 自动停跟随；滚回底部 = 想跟上 → 自动恢复；
 *   · 状态按 localStorage 记忆（与右栏显隐 / 宽度同口径）。
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
  process.exit(fails ? 1 : 0);
})();
