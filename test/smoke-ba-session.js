/* 浏览器活动右栏「跟随当前会话」真行为回归（vm 沙箱里真切会话、真查库、真开栏）
 *   node test/smoke-ba-session.js
 *
 * 用户口径：「活动与浏览器应当跟随当前的会话。切换会话应当同时切换
 * （如果没有浏览器则隐藏该边栏）」。
 * 钉住：
 *   · 切会话 = 换活动范围（按会话查库、别人的活动不进眼前这份列表）；
 *   · 当前会话有浏览器（见过它的浏览器活动 / 网关说它驱动着 / 库里有它的浏览器历史）
 *     → 显示；没有 → 整条收起，且**不改用户落盘的偏好**（mtnode.baOpen）；
 *   · 别的会话的浏览器活动不会替当前会话把栏顶开；
 *   · 实况只给持驱动锁的那条会话（别人驱动时不拉帧）；
 *   · 用户亲手开 / 关按会话记着，切走再切回不被自动判据顶掉；
 *   · #baAll 勾上才查全库；
 *   · 跨层契约：渲染层不再用那个从没赋过值的 lastSessionId，run 参数带 hostSessionId，
 *     网关按 hostSessionTagOf 把 dsh 侧 session id 翻成宿主会话 id。
 * 样式 / DOM 那半由 smoke-browser.js 钉住，旧口径（自动开栏 / 跟随最新）由
 * smoke-browser-rail.js / smoke-ba-follow.js 钉住。
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const APP_BROWSER = fs.readFileSync(path.join(ROOT, "renderer", "app-browser.js"), "utf8");
const APP_DB = fs.readFileSync(path.join(ROOT, "renderer", "app-db.js"), "utf8");
const APP_ASSIST = fs.readFileSync(path.join(ROOT, "renderer", "app-assist.js"), "utf8");
const GATEWAY = fs.readFileSync(path.join(ROOT, "dsh", "gateway", "gateway.mjs"), "utf8");

let fails = 0;
const ok = (cond, msg) => {
  console.log((cond ? "  ok    " : "FAIL  ") + msg);
  if (!cond) fails++;
};
const eq = (got, want, msg) => ok(got === want, msg + "（得到 " + JSON.stringify(got) + "）");
const tick = () => new Promise((r) => setTimeout(r, 0));
const waitMs = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = async () => { for (let i = 0; i < 6; i++) await tick(); };

const IDS = [
  /* 本轮需求：baOpen / baStop / baTakeover / baPolicy / baRefresh 与 baLiveModeBtn 已下架，
     实况区改为只在独立窗口形态下出现的「收回」小键 #baLiveBack。 */
  "agentPane", "agentBrowserChip", "baPanel", "baResize", "baClose",
  "baFilter", "baAll", "baClear", "baFollow",
  "baList", "baCount", "baStatus", "baLiveCanvas", "baLivePause", "baLiveBack", "baLiveMode",
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

/* 造一个「有会话」的沙箱：app-assist.js 的 agentViewId / S.agentActiveId /
   agentSessionState 在真壳里是全局函数，这里以沙箱全局提供，语义等价。 */
function makeApp(opt) {
  const opts = opt || {};
  const els = {};
  for (const id of IDS) els[id] = mkEl(id);
  els.baPanel.hidden = true;
  els.baList.clientHeight = 400;
  const storage = Object.assign({}, opts.storage || {});
  const state = {
    viewId: opts.viewId === undefined ? "asA" : opts.viewId,
    driver: opts.driver || "",
    running: opts.running === undefined ? true : opts.running,
    calls: { query: [], push: [], viewStart: 0, viewStop: 0, browser: [] },
  };
  const db = opts.db || {};
  const win = { document: null, I18n: { t: (k) => k }, toast: () => {} };
  win.api = {
    dshBrowser: async (p) => {
      state.calls.browser.push(p);
      if ((p && p.action) === "status") return { ok: true, running: state.running, driver: state.driver };
      return { ok: true, running: state.running, driver: state.driver };
    },
    dshBrowserViewStart: async () => { state.calls.viewStart++; return { ok: true, on: true, mode: "docked" }; },
    dshBrowserViewStop: async () => { state.calls.viewStop++; return { ok: true, on: false }; },
    dshBrowserViewInput: async () => ({ ok: true }),
    dshBrowserViewMode: async () => ({ ok: true }),
    activityQuery: async (q) => {
      state.calls.query.push(Object.assign({}, q));
      const sid = String((q && q.sessionId) || "");
      const d = (opts.queryDelay && opts.queryDelay[sid]) || 0;
      if (d) await waitMs(d);
      if (!sid) {
        const rows = [];
        for (const k of Object.keys(db)) rows.push(...db[k]);
        rows.push({ at: 9, kind: "pwsh", text: "没有归属会话的行", sessionId: "" });
        return { ok: true, rows, total: rows.length };
      }
      const rows = db[sid] || [];
      return { ok: true, rows: rows.map((r) => Object.assign({}, r)), total: rows.length };
    },
    activityPush: async (rows) => { state.calls.push.push(...rows); return { ok: true }; },
    activityClear: async () => ({ ok: true }),
    dshOnActivity: () => () => {},
    onBrowserFrame: () => () => {},
    dshSteer: async () => ({ ok: true }),
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
      getItem: (k) => (k in storage ? storage[k] : null),
      setItem: (k, v) => { storage[k] = String(v); },
      removeItem: (k) => { delete storage[k]; },
    },
    MutationObserver: class { constructor(cb) { this.cb = cb; } observe() {} },
    Image: class {},
    requestAnimationFrame: (cb) => setTimeout(cb, 0),
    document: doc,
    /* 真壳里这三个是 app-assist.js（普通脚本）的全局函数 / app.js 的全局状态 */
    agentViewId: () => state.viewId,
    agentSessionState: () => ({ id: state.viewId }),
    /* S.agentActiveId 是真壳里的活字段（app.js 的全局 S），这里同样取值即真值 */
    S: {
      get agentActiveId() { return state.viewId; },
      set agentActiveId(v) { state.viewId = v; },
    },
  };
  sb.window = win;
  vm.createContext(sb);
  vm.runInContext(APP_BROWSER, sb, { filename: "app-browser.js" });
  return {
    BA: win.BrowserAct, els, storage, state, db,
    act: (data) => win.browserActivityOnEvent(data),
    pane: els.agentPane, box: els.baPanel,
  };
}
const rowOf = (sid, kind, text, at) => ({ at: at || Date.now(), kind, text, sessionId: sid });

(async () => {
  /* ── [1] 切会话 = 换活动范围 ──────────────────────────────────────────── */
  console.log("[1] 切会话：活动范围跟着换（按会话查库，上一会话的内存样本作废）");
  {
    const db = {
      asA: [rowOf("asA", "browser", "A：浏览器已启动", 1), rowOf("asA", "pwsh", "A：npm test", 2)],
      asB: [rowOf("asB", "pwsh", "B：dir", 3)],
    };
    const app = makeApp({ viewId: "asA", driver: "asA", db });
    await settle();
    eq(app.BA.sessionId, "asA", "启动即绑上当前会话（渲染层会话 id）");
    const q1 = app.state.calls.query[app.state.calls.query.length - 1];
    eq(q1.sessionId, "asA", "查库按当前会话过滤（旧写法恒为空串 = 永远查全库）");
    eq(app.BA.rows.length, 2, "眼前这份列表只有本会话的条目");
    ok(app.BA.rows.every((r) => r.sessionId === "asA"), "没有别会话的条目混进来");

    app.state.viewId = "asB";
    app.BA.setSession(app.BA.currentSessionId());
    await settle();
    eq(app.BA.sessionId, "asB", "切换后绑定到新会话");
    eq(app.state.calls.query[app.state.calls.query.length - 1].sessionId, "asB", "重新按新会话查库");
    eq(app.BA.rows.length, 1, "列表换成新会话的活动（旧样本没有被留下来）");
    eq(app.BA.rows[0].text, "B：dir", "留下的正是新会话那一条");
  }

  /* ── [2] 没有浏览器的会话 → 整条收起，且不动用户的偏好 ─────────────────── */
  console.log("\n[2] 切到没有浏览器的会话：整条收起，不改落盘偏好");
  {
    const db = { asA: [rowOf("asA", "browser", "A：浏览器已启动", 1)], asB: [rowOf("asB", "read", "B：读文件", 2)] };
    const app = makeApp({ viewId: "asA", driver: "asA", db, storage: { "mtnode.baOpen": "1" } });
    await settle();
    eq(app.BA.isOpen(), true, "A 有浏览器 → 这条栏显示");

    app.state.viewId = "asB";
    app.state.driver = "";
    app.BA.setSession(app.BA.currentSessionId());
    await settle();
    eq(app.BA.isOpen(), false, "B 没有浏览器（只有命令 / 文件类活动）→ 收起");
    eq(app.box.hidden, true, "面板真的 hidden（不占宽度）");
    eq(app.storage["mtnode.baOpen"], "1", "自动收起**不写**记忆：用户的偏好不被「跟随会话」改写");

    app.state.viewId = "asA";
    app.state.driver = "asA";
    app.BA.setSession(app.BA.currentSessionId());
    await settle();
    eq(app.BA.isOpen(), true, "切回有浏览器的 A → 按记忆恢复显示");
  }

  /* ── [3] 当前会话没有浏览器时，别的会话的活动不会把它顶开 ──────────────── */
  console.log("\n[3] 别的会话用浏览器：不替当前会话弹栏（也不刷新眼前这份列表）");
  {
    const db = { asB: [] };
    const app = makeApp({ viewId: "asB", driver: "", db });
    await settle();
    eq(app.BA.isOpen(), false, "B 没有浏览器，栏是收着的");
    app.act({ kind: "browser_navigate", text: "A 打开了网页", sessionId: "asA" });
    await settle();
    eq(app.BA.isOpen(), false, "A 的浏览器动作不弹 B 的栏（旧写法：谁最后动手弹谁的）");
    eq(app.BA.rows.length, 0, "A 的条目也不进 B 眼前这份列表");
    await waitMs(460);   /* 落库是一拍合并（400ms）后批量发的，等它真发出去 */
    ok(app.state.calls.push.some((r) => r.sessionId === "asA" && /打开了网页/.test(r.text)), "但照旧落库（账本是全的，只是不显示）");
    eq(app.BA.sessionHasBrowser("asA"), true, "记下「A 有浏览器」——切过去时据此显示");

    app.state.viewId = "asA";
    app.state.driver = "asA";
    app.state.running = true;
    app.BA.setSession(app.BA.currentSessionId());
    await settle();
    eq(app.BA.isOpen(), true, "切到 A → 这条栏出现（有浏览器）");
  }

  /* ── [4] #baAll：勾上才查全库 ─────────────────────────────────────────── */
  console.log("\n[4] 「含其它会话」勾上才查全库");
  {
    const db = { asA: [rowOf("asA", "browser", "A：启动", 1)], asB: [rowOf("asB", "pwsh", "B：跑命令", 2)] };
    const app = makeApp({ viewId: "asA", driver: "asA", db });
    await settle();
    eq(app.state.calls.query[app.state.calls.query.length - 1].sessionId, "asA", "默认只看当前会话");
    app.els.baAll.checked = true;
    app.els.baAll.fire("change", {});
    await settle();
    eq(app.state.calls.query[app.state.calls.query.length - 1].sessionId, "", "勾上 → 查全库");
    ok(app.BA.rows.some((r) => r.sessionId === "asB"), "别人的条目这时才看得到");
    ok(app.BA.rows.some((r) => r.sessionId === "" && /没有归属会话/.test(r.text)), "没有归属的老条目也在这一档里出现");
  }

  /* ── [5] 实况只给持驱动锁的那条会话 ────────────────────────────────────── */
  console.log("\n[5] 实况只给驱动着浏览器的那条会话");
  {
    const db = { asA: [rowOf("asA", "browser", "A：启动", 1)], asB: [rowOf("asB", "browser", "B：启动", 2)] };
    const app = makeApp({ viewId: "asB", driver: "asA", db, running: true });
    await settle();
    eq(app.BA.isOpen(), true, "B 自己也有浏览器历史 → 栏显示（看自己的账本）");
    eq(app.state.calls.viewStart, 0, "但画面此刻由 A 驱动 → 不拉帧（同一时刻只有一条会话驱动）");
    app.state.driver = "asB";
    app.BA.applyStatus({ ok: true, running: true, driver: "asB" });
    await settle();
    eq(app.state.calls.viewStart, 1, "驱动权回到 B → 补上实况流");
  }

  /* ── [6] 用户亲手开 / 关按会话记着（切回来不被自动判据顶掉） ────────────── */
  console.log("\n[6] 用户亲手关过：切走再切回仍按用户的选择");
  {
    const db = { asA: [rowOf("asA", "browser", "A：启动", 1)], asB: [rowOf("asB", "browser", "B：启动", 2)] };
    const app = makeApp({ viewId: "asA", driver: "asA", db });
    await settle();
    eq(app.BA.isOpen(), true, "A 有浏览器 → 显示");
    app.BA.setOpen(false);                  /* 用户点 ✕ */
    eq(app.BA.isOpen(), false, "用户亲手关掉");
    eq(app.storage["mtnode.baOpen"], "0", "显式关闭落盘（跨重启的记忆）");
    app.state.viewId = "asB";
    app.BA.setSession(app.BA.currentSessionId());
    await settle();
    eq(app.BA.isOpen(), true, "B 有自己的浏览器 → 显示（A 的取舍不影响 B）");
    app.state.viewId = "asA";
    app.BA.setSession(app.BA.currentSessionId());
    await settle();
    eq(app.BA.isOpen(), false, "切回 A：仍是用户亲自关掉的那个状态");

    app.BA.setOpen(true);                   /* 用户点 chip 开回来 */
    app.state.viewId = "asB";
    app.BA.setSession(app.BA.currentSessionId());
    app.state.viewId = "asA";
    app.BA.setSession(app.BA.currentSessionId());
    await settle();
    eq(app.BA.isOpen(), true, "反过来也一样：用户亲手开过的会话切回来是开着的");
  }

  /* ── [7] 认不出会话（老壳 / 单文件冒烟）→ 退回旧口径，不劣化 ───────────── */
  console.log("\n[7] 认不出当前会话时不藏栏（旧口径兜底）");
  {
    const app = makeApp({ viewId: "asA", db: {} });
    await settle();
    app.state.viewId = "";
    app.BA.setSession(app.BA.currentSessionId());
    await settle();
    eq(app.BA.sessionId, "", "没有会话可取 → 绑定为空（会话闸关）");
    eq(app.state.calls.query[app.state.calls.query.length - 1].sessionId, "", "空会话照旧查全库（老口径）");
    app.act({ kind: "browser", text: "浏览器已启动" });
    await settle();
    eq(app.BA.isOpen(), true, "没有会话闸时浏览器活动照旧自动开栏（行为不劣化）");
  }

  /* ── [8] 跨层契约 ─────────────────────────────────────────────────────── */
  console.log("\n[8] 跨层契约：会话 id 一路传得下来");
  {
    ok(!/BA\.lastSessionId/.test(APP_BROWSER), "app-browser.js 不再用那个从没赋过值的 lastSessionId");
    ok(/setSession = function/.test(APP_BROWSER) && /currentSessionId = function/.test(APP_BROWSER),
      "对外只暴露 setSession / currentSessionId 两个入口");
    ok(/agentNotifyBrowserSession\(\)/.test(APP_ASSIST) && /function agentNotifyBrowserSession/.test(APP_ASSIST),
      "app-assist.js 在 renderAgentSession 里通知右栏跟随当前会话");
    ok(/hostSessionId: dshHostSessionIdOf\(runKey, opts\)/.test(APP_DB) && /function dshHostSessionIdOf/.test(APP_DB),
      "run 参数带 hostSessionId（渲染层会话 id）");
    ok(/hostSessionId/.test(GATEWAY) && /function hostSessionTagOf/.test(GATEWAY),
      "网关按 hostSessionId 给活动流盖章，并把 dsh session id 翻成宿主会话 id");
    ok(/sessionId: hostSessionTagOf\(raw\) \|\| raw/.test(GATEWAY), "翻译只改归属字段，查不到就原样带（不静默丢条目）");
  }

  /* ── [9] 切得快：上一会话的查库结果迟到也不能落到新会话眼前 ────────────── */
  console.log("\n[9] 切会话途中迟到的查库结果被丢掉（不串台）");
  {
    const db = { asA: [rowOf("asA", "browser", "A：启动", 1)], asB: [rowOf("asB", "pwsh", "B：跑命令", 2)] };
    const app = makeApp({ viewId: "asA", driver: "asA", db, queryDelay: { asA: 80 } });
    await waitMs(20);                       /* A 的查库还在飞 */
    app.state.viewId = "asB";
    app.state.driver = "";
    app.BA.setSession(app.BA.currentSessionId());
    await waitMs(20);                       /* B 的结果先回来 */
    eq(app.BA.rows.length, 1, "先显示新会话（B）的条目");
    await waitMs(120);                      /* A 的迟到结果此刻才回来 */
    eq(app.BA.sessionId, "asB", "仍然绑在 B 上");
    eq(app.BA.rows.length, 1, "迟到的 A 结果没有把 B 的列表顶掉");
    eq(app.BA.rows[0].text, "B：跑命令", "眼前这份列表仍是 B 的");
  }

  /* ── [10] 网关盖章逻辑真跑一遍（把线上那份源码抠出来在沙箱里执行） ─────── */
  console.log("\n[10] 网关的归属翻译 / 盖章规则真执行（不是读源码文本）");
  {
    const tagSrc = (GATEWAY.match(/function hostSessionTagOf\(dshSid\) \{[\s\S]*?\n\}/) || [""])[0];
    const pushSrc = (GATEWAY.match(/\n {2}push\(item\) \{[\s\S]*?\n {2}\},/) || [""])[0];
    ok(!!tagSrc && !!pushSrc, "从 dsh/gateway/gateway.mjs 抠出 hostSessionTagOf 与 BrowserCtl.push 的源码");
    const claims = new Map([
      ["rk", { sessionId: "session-1", sessions: new Set(["session-1", "session-2"]), host: "asA" }],
      ["rk2", { sessionId: "session-9", sessions: new Set(["session-9"]), host: "" }],
    ]);
    const frames = [];
    const sb = { console, keyToReqId: claims, out: (m) => frames.push(m) };
    vm.createContext(sb);
    vm.runInContext(tagSrc + "\n;globalThis.__ctl = { " + pushSrc + " };", sb, { filename: "gateway-push.js" });
    const ctl = sb.__ctl;
    const stamp = (item, last) => ctl.push.call({ lastSessionId: last || "" }, item);
    const sid = () => frames[frames.length - 1].event.data.sessionId;

    stamp({ kind: "click", text: "点了按钮" }, "session-1");
    eq(sid(), "asA", "dsh 侧 session id 翻成宿主会话 id（浏览器 / 工具帧走这条）");
    stamp({ kind: "click", text: "点了按钮" }, "session-2");
    eq(sid(), "asA", "运行时改铸过的 id（写进 sessions 集合）同样翻得回同一条会话");
    stamp({ kind: "read", text: "读文件", sessionId: "session-1" });
    eq(sid(), "asA", "条目自带 dsh id 时也翻");
    stamp({ kind: "pwsh", text: "跑命令", sessionId: "" });
    eq(sid(), "", "显式空串＝这一轮没有归属会话（画布节点 / 助手），不被顺手算进某条会话");
    stamp({ kind: "click", text: "点了按钮" }, "session-未知");
    eq(sid(), "session-未知", "查不到就原样带（旧库条目不静默丢，勾「含其它会话」还能看）");
    stamp({ kind: "browser", text: "浏览器已启动", sessionId: "asA" });
    eq(sid(), "asA", "用户从面板触发的动作（面板直接带宿主会话 id）原样盖章");
    eq(frames.length, 6, "每一条都真发出去了（没有哪条被吞）");
  }

  console.log(fails ? "\nFAIL " + fails + " 项" : "\n全部通过");
  process.exit(fails ? 1 : 0);
})();
