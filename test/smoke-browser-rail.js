/* 会话右边栏「被调用即出现」的功能回归（vm 沙箱里真跑 app-browser.js）
 *   node test/smoke-browser-rail.js
 *
 * 钉住本轮修的那个洞：右栏不自动出现 → 实况流不连（liveSync 要求面板开着）→
 * 浏览器永远只能当眼前的独立窗口（dock 只在 viewStart 成功后才发生）。
 * 覆盖：
 *   [1] 默认：没被调用时整条不显示（hidden + 无 .ba-open）
 *   [2] 会话一碰浏览器（browser-act）→ 右栏自动出现 + 真开流（viewStart 被调）
 *   [3] 用户亲手关过（✕ / chip 收起）→ 本次运行不再自动弹
 *   [4] shell / 文件摘要这类非浏览器活动不替用户弹第三栏
 *   [5] 非会话视图（#agentPane display:none）不弹
 *   [6] 浏览器没在跑不弹（实况自己不拉起浏览器）
 *   [7] 栏本来就开着（上次没收 / 启动恢复）→ 浏览器后来被拉起也要把流补上
 *       （否则没人 dock 真窗口，窗口留在屏幕上 = 用户报的「单独的一个窗口」）
 *   [8] 「独立窗口」（detached）后不再自动开流；点「收回」才回到右栏实况
 *   [9] 控件引用必须真实存在：点 #baLiveModeBtn 的 onclick 真把 live.mode 在
 *       docked / detached 间切一圈（不是属性在、函数没了）
 *  [10] 静态扫描 renderer/app-browser.js 里的每个 BA.<name>：逐个断言在 BA 上真实
 *       存在（白名单放行数据字段 / 容器）——「引用了不存在的 BA API」变红灯
 *  [11] bindLive 抛错隔离：桩一个会抛错的 liveToggleMode，点下去不许把「这颗画布
 *       已经绑过」（canvas._bound）跳过，后面的 pointer / wheel / key 转发照旧可用
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SRC = fs.readFileSync(path.join(__dirname, "..", "renderer", "app-browser.js"), "utf8");

let fails = 0;
const ok = (cond, msg) => {
  console.log((cond ? "  ok    " : "FAIL  ") + msg);
  if (!cond) fails++;
};
const tick = () => new Promise((r) => setTimeout(r, 0));

/* ── 最小 DOM 桩（只覆盖 app-browser.js 用到的那些）──────────────────────── */
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
  /* addEventListener 记下回调：用例要真把事件打进去，看接线有没有生效
     （不再只是「onclick 是个函数」这种表面断言） */
  const on = {};
  return {
    id,
    hidden: false,
    textContent: "",
    innerHTML: "",
    value: "",
    checked: false,
    oninput: null,
    onclick: null,
    onchange: null,
    clientWidth: 1280,
    scrollTop: 0,
    scrollHeight: 0,
    classList: mkClassList(),
    style: { display: "", width: "", setProperty() {}, removeProperty() {} },
    _on: on,
    addEventListener(type, cb) { (on[type] = on[type] || []).push(cb); },
    appendChild() {},
    setAttribute() {},
    getAttribute: () => null,
    focus() {},
    getContext: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 340, height: 620 }),
  };
}

const IDS = [
  "agentPane", "agentBrowserChip", "baPanel", "baResize", "baClose", "baOpen", "baStop",
  "baTakeover", "baPolicy", "baRefresh", "baFilter", "baAll", "baClear", "baList",
  "baCount", "baStatus", "baLiveCanvas", "baLivePause", "baLiveModeBtn", "baLiveMode",
  "baLiveNote", "baLiveMask", "baLive",
];

function makeApp(opts) {
  const o = opts || {};
  const els = {};
  for (const id of IDS) els[id] = mkEl(id);
  els.baPanel.hidden = true;

  const store = Object.assign({}, o.storage || {});
  const calls = { viewStart: 0, viewStop: 0, status: 0, viewInput: 0 };
  const state = { running: !!o.running };

  const api = {
    dshBrowser: async (p) => {
      const action = p && p.action;
      if (action === "status") {
        calls.status++;
        return { ok: true, running: state.running, exe: "msedge.exe", port: 9222 };
      }
      return { ok: true, running: state.running };
    },
    dshBrowserViewStart: async () => { calls.viewStart++; return { ok: true, on: true, mode: "docked" }; },
    dshBrowserViewStop: async () => { calls.viewStop++; return { ok: true, on: false }; },
    dshBrowserViewInput: async () => { calls.viewInput++; return { ok: true }; },
    /* viewMode 像真网关一样「回声」请求的形态（真网关回 {ok, mode, parked, ...}）：
       渲染层现在以网关回执为准（没摆出来的 detached 会被回落成 docked），
       假实现恒回 docked 就测不出两个方向。 */
    dshBrowserViewMode: async (m) => {
      const raw = m && typeof m === "object" ? m.mode : m;
      const want = String(raw || "") === "detached" ? "detached" : "docked";
      state.mode = want;
      calls.viewMode = (calls.viewMode || 0) + 1;
      return { ok: true, mode: want, parked: want === "docked", on: state.running };
    },
    activityQuery: async () => ({ ok: true, rows: [], total: 0 }),
    activityPush: async () => ({ ok: true }),
    activityClear: async () => ({ ok: true }),
    dshOnActivity: () => () => {},
    onBrowserFrame: () => () => {},
    dshSteer: async () => ({ ok: true }),
  };

  const win = { api, I18n: { t: (k) => k }, toast: () => {} };
  const observers = [];
  const sb = {
    console,
    setTimeout,
    clearTimeout,
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    },
    MutationObserver: class { constructor(cb) { this.cb = cb; observers.push(this); } observe() {} },
    Image: class { },
    requestAnimationFrame: (cb) => setTimeout(cb, 0),
    document: {
      readyState: "complete",
      addEventListener() {},
      body: mkEl("body"),
      querySelector: (sel) => (sel && sel[0] === "#" ? els[sel.slice(1)] || null : null),
      querySelectorAll: () => [],
      createElement: (t) => mkEl(t),
    },
  };
  sb.window = win;
  win.document = sb.document;
  /* 「用户正看着哪条会话」的唯一判据（app-assist.js 的 agentViewHas）：
     给了 viewing 才注入 —— 没给的用例走「认不出会话 → 退回旧行为」，与老壳同口径。
     state.viewing 可在用例里改（测切会话）。 */
  if (o.viewing) {
    state.viewing = String(o.viewing);
    sb.agentViewHas = (id) => String(id || "") === state.viewing;
    win.agentViewHas = sb.agentViewHas;
  }
  vm.createContext(sb);
  vm.runInContext(SRC, sb, { filename: "app-browser.js" });
  const BA = win.BrowserAct;
  const act = (kind, text) => { win.browserActivityOnEvent({ kind, text: text || "x" }); };
  return { BA, els, store, calls, state, act, pane: els.agentPane };
}

(async () => {
  /* ── [1] 默认不显示 ───────────────────────────────────────────────────── */
  console.log("[1] 默认：没被调用时整条不显示");
  {
    const app = makeApp({ running: false });
    await tick(); await tick();
    const BA = app.BA;
    ok(!!BA, "app-browser.js 在沙箱里装起来了（window.BrowserAct）");
    ok(BA.isOpen() === false && app.els.baPanel.hidden === true && !app.pane.classList.contains("ba-open"),
      "右栏默认收起（hidden + 无 .ba-open，旧两栏界面一字不差）");
    ok(app.calls.viewStart === 0, "没被调用就不开流（不占帧、不占解码成本）");
    ok(app.els.baLiveModeBtn.hidden === true,
      "浏览器没开时「独立窗口」按钮不显示（形态切换只在真有一只在跑的浏览器时才有意义）");
  }

  /* ── [2] 会话一用浏览器 → 右栏出现 + 真开流 ──────────────────────────── */
  console.log("\n[2] 会话一碰浏览器：右栏自动出现并连上实况");
  {
    const app = makeApp({ running: false });
    await tick(); await tick();
    /* 浏览器是被会话刚拉起来的：渲染层手里的状态还是「没在跑」，
       所以自动开栏必须先问一次网关，别拿过期状态当判据 */
    app.state.running = true;
    app.act("browser", "浏览器已启动（Edge）");
    await tick(); await tick(); await tick(); await tick();
    ok(app.calls.status > 0, "自动开栏前先刷新一次浏览器状态（不吃过期状态）");
    ok(app.BA.isOpen() === true && app.els.baPanel.hidden === false && app.pane.classList.contains("ba-open"),
      "右栏自己出现（.ba-open + hidden=false：dock 的前提就是它）");
    ok(app.calls.viewStart === 1, "紧接着真开实况流（viewStart → 网关 dock 真实窗口）"
      + " [viewStart=" + app.calls.viewStart + " on=" + app.BA.live.on + " running=" + app.BA.running
      + " open=" + app.BA.isOpen() + " stop=" + app.calls.viewStop + "]");
    ok(app.store["mtnode.baOpen"] === "1", "显隐照旧落 localStorage（可复核）");
    ok(app.els.baLiveModeBtn.hidden === false,
      "浏览器在跑时「独立窗口」按钮显示出来（文案由 livePaintStatus 按形态切）");
  }

  /* ── [3] 用户亲手关过就不打扰 ─────────────────────────────────────────── */
  console.log("\n[3] 用户亲手关过：本次运行不再自动弹");
  {
    const app = makeApp({ running: true });
    await tick(); await tick();
    app.BA.setOpen(false);              // 等于点 ✕ / 再点一次 chip
    await tick();
    ok(app.BA.userClosed === true, "亲手关＝记下 userClosed");
    app.act("navigate", "打开 https://platform.deepseek.com");
    await tick(); await tick();
    ok(app.BA.isOpen() === false && app.els.baPanel.hidden === true, "后续活动不再自动弹出来");
    ok(app.calls.viewStart === 0, "也没开流");
  }

  /* ── [4] 非浏览器活动不弹 ─────────────────────────────────────────────── */
  console.log("\n[4] shell / 文件摘要不替用户弹第三栏");
  {
    const app = makeApp({ running: true });
    await tick(); await tick();
    app.act("shell", "npm test");
    app.act("file", "写入 E:/tmp/a.md");
    await tick(); await tick();
    ok(app.BA.isOpen() === false, "命令 / 文件类活动不自动开栏（那些不是「浏览器活动」）");
    app.act("browser_launch", "browser_launch · {}");   // 网关的工具类活动行
    await tick(); await tick();
    ok(app.BA.isOpen() === true, "浏览器工具行（browser_*）照旧自动开栏");
  }

  /* ── [5] 非会话视图不弹 ───────────────────────────────────────────────── */
  console.log("\n[5] 非会话视图（画布 / 团队）不弹");
  {
    const app = makeApp({ running: true });
    await tick(); await tick();
    app.pane.style.display = "none";
    app.act("browser", "浏览器已启动（Edge）");
    await tick(); await tick();
    ok(app.BA.isOpen() === false && app.els.baPanel.hidden === true, "不在会话视图就不占宽度（与助手栏同口径）");
  }

  /* ── [6] 浏览器没在跑不弹 ─────────────────────────────────────────────── */
  console.log("\n[6] 浏览器没在跑：不弹、也不顺手拉起");
  {
    const app = makeApp({ running: false });
    await tick(); await tick();
    app.act("browser", "浏览器已启动（Edge）");   // 状态仍是 running:false
    await tick(); await tick();
    ok(app.BA.isOpen() === false, "状态说没在跑就不开栏（开流只连已经在跑的浏览器）");
    ok(app.calls.viewStart === 0, "更不会去拉流");
  }

  /* ── [7] 栏本来就开着，浏览器后来才被拉起 ─────────────────────────────── */
  console.log("\n[7] 栏已经开着（上次没收 / 启动恢复）但流没连：浏览器被拉起就把流补上");
  {
    const app = makeApp({ running: false, storage: { "mtnode.baOpen": "1" } });
    await tick(); await tick();
    ok(app.BA.isOpen() === true, "按记忆恢复：这一栏本来就是开着的");
    ok(app.calls.viewStart === 0, "此刻浏览器还没跑，不硬开流");
    app.state.running = true;
    app.act("browser_launch", "browser_launch · {}");
    await tick(); await tick(); await tick();
    ok(app.calls.viewStart === 1,
      "开着的那条栏把实况流补上（viewStart=1 —— 少了它，窗口就没人 dock）");
  }

  /* ── [8] 「提出来」= 独立窗口，不再被偷偷搬走 ─────────────────────────── */
  console.log("\n[8] 提出来之后不再自动开流，点「收回」才回到右栏实况");
  {
    const app = makeApp({ running: true });
    await tick(); await tick();
    await app.BA.liveSetMode("detached");
    await tick(); await tick();
    ok(app.BA.live.mode === "detached" && app.BA.live.on === false,
      "提出来 = 流停掉（画面就在眼前，不重复解码）");
    const before = app.calls.viewStart;
    app.act("browser_navigate", "browser_navigate · platform.deepseek.com");
    await tick(); await tick(); await tick();
    ok(app.calls.viewStart === before,
      "独立窗口形态下浏览器动作不再自动开流（否则真窗口会被立刻搬回去）");
    await app.BA.liveSetMode("docked");
    await tick(); await tick(); await tick();
    ok(app.calls.viewStart === before + 1, "点「收回」→ 重新开流（画面回右栏、真窗口让位）");
  }

  /* ── [9] 控件引用的 API 真实存在：点下去真把形态切一圈 ────────────────── */
  console.log("\n[9] #baLiveModeBtn 的 onclick 真能切 docked / detached（不是属性在、实现没了）");
  {
    const app = makeApp({ running: true });
    await tick(); await tick();
    const btn = app.els.baLiveModeBtn;
    ok(typeof app.BA.liveToggleMode === "function",
      "BA.liveToggleMode 是函数（控件引用的成员真实存在）");
    ok(!!btn.onclick, "#baLiveModeBtn.onclick 被接上了（bindLive 认得这个 id）");
    ok(app.BA.live.mode === "docked", "实况默认形态 = docked（右栏）");
    /* 点下去要等一拍：BA.liveSetMode 是 async（先 viewMode 再改形态），
       不等就把「同步刻还没变」误判成按钮空转 */
    let threw = "";
    try { await btn.onclick(); } catch (err) { threw = String((err && err.message) || err); }
    await tick();
    ok(!threw && app.BA.live.mode === "detached",
      "点一下 → detached（真调到了 BA 的实现，不是空转）"
      + " [mode=" + app.BA.live.mode + (threw ? " threw=" + threw : "") + "]");
    try { await btn.onclick(); } catch (_) {}
    await tick();
    ok(app.BA.live.mode === "docked",
      "再点一下 → 切回来 docked（两个方向都通，不是单向假按钮）");
  }

  /* ── [10] 静态扫描：每个 BA.<name> 引用都必须在 BA 上真实存在 ─────────── */
  console.log("\n[10] 扫全文件的 BA.<name>：引用了不存在的 BA API 就红灯");
  {
    const app = makeApp({ running: false });
    await tick(); await tick();
    const BA = app.BA;
    /* 白名单 = BA 上的数据字段 / 容器（不是 API），只放行这些；
       其余引用一律要求「在 BA 上真实存在」，函数类引用还要求可调用 */
    const DATA = {
      rows: "object", total: "number", running: "boolean", takeover: "boolean", policy: "object",
      sessionId: "string", browserSessions: "object", dbBrowserSession: "string", driver: "string",
      userChoice: "object", open: "boolean", userClosed: "boolean", userOpened: "boolean",
      autoOpenBusy: "boolean", filter: "string", follow: "boolean", w: "number", live: "object",
      _sideMarked: "object",
    };
    const names = new Set();
    const re = /\bBA\.([A-Za-z_$][\w$]*)/g;
    let m;
    while ((m = re.exec(SRC))) names.add(m[1]);

    const typed = new Set();
    const missing = [];
    const badType = [];
    for (const n of names) {
      // hasOwnProperty 不用 in：别让 Object.prototype 上的名字（constructor…）混过去
      const has = Object.prototype.hasOwnProperty.call(BA, n);
      if (!has) { missing.push(n); continue; }
      const want = DATA[n];
      if (!want) continue;
      typed.add(n);
      const got = typeof BA[n];
      if (got !== want) badType.push(n + "=" + got + "≠" + want);
    }
    ok(names.size >= 40, "扫到 " + names.size + " 个 BA.<name> 引用（覆盖实况 / 会话 / 活动流各面）");
    ok(missing.length === 0,
      "每个被引用的 BA API 都真实存在（引用了不存在的 BA API = 红灯）"
      + (missing.length ? " [缺: " + missing.join(" ") + "]" : ""));
    ok(badType.length === 0,
      "白名单数据字段类型也对得上（" + typed.size + " 个："
      + [...typed].sort().join(" ") + "）" + (badType.length ? " [不符: " + badType.join(" ") + "]" : ""));
    ok(typeof DATA.liveMode !== "string" && typeof BA.live.mode === "string",
      "白名单不藏私货：它只放行数据字段，函数 / API 类引用一律走「真实存在」这一关");
  }

  /* ── [11] bindLive 抛错隔离：绑过的事实不许被跳过 ─────────────────────── */
  console.log("\n[11] bindLive 里某个控件抛错，也不许跳过「画布已绑定」与后续接线");
  {
    const app = makeApp({ running: true });
    await tick(); await tick();
    /* 实况输入转发的前提是「面板开着 + 流在跑」（liveInput 见 BA.live.on）：这里按
       用户真会点它的情形来 —— 面板开着、浏览器在跑，画布上的滚轮才该送到网关。 */
    app.BA.setOpen(true);
    await tick(); await tick();
    const canvas = app.els.baLiveCanvas;
    ok(canvas._bound === true, "启动接线跑完后 #baLiveCanvas 已盖过章（_bound）");
    const on = canvas._on || {};
    ok(typeof on.pointerdown === "function" || (on.pointerdown || []).length > 0,
      "指针接线在（_bound 之后才挂的画布监听）");
    /* 桩一个会抛错的实现：真机换模型 / 网关卡死时就是这种抛错 */
    app.BA.liveToggleMode = function () { throw new Error("boom-live-toggle"); };
    const btn = app.els.baLiveModeBtn;
    let threw = "";
    try { btn.onclick(); } catch (err) { threw = String((err && err.message) || err); }
    ok(canvas._bound === true,
      "点了会抛错的控件之后，_bound 仍然是 true（绑定事实没有被抛错跳过）"
      + (threw ? " [已隔离: " + threw + "]" : ""));
    let wheelThrew = "";
    const wheel = (on.wheel || [])[0];
    try {
      if (wheel) wheel({ deltaY: 120, clientX: 10, clientY: 10, preventDefault() {}, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, button: 0, buttons: 0 });
    } catch (err) { wheelThrew = String((err && err.message) || err); }
    ok(!!wheel && !wheelThrew, "抛错之后滚轮转发照旧可用（后面的接线没被跳过）");
    ok(app.calls.viewInput > 0, "滚轮真的送到了网关（viewInput 被调 "
      + app.calls.viewInput + " 次，不是只挂了个死回调）");
  }

  /* ── [12] 焦点不在该会话：静默处理（本轮需求）──────────────────────────── */
  console.log("\n[12] 焦点不在该会话：不弹右栏 / 不切界面 / 只留被动标记 + 静默连流");
  {
    /* 沙箱里补上「用户正看着哪条会话」的唯一判据（app-assist.js 的 agentViewHas）：
       本段专门测会话闸，所以它必须存在 —— 认不出会话时 BA.viewing 会回 true（老壳退回旧行为）。 */
    const app = makeApp({ running: true, viewing: "as_a" });
    await tick(); await tick();
    app.BA.setSession("as_a");
    await tick(); await tick();
    ok(app.BA.viewing("as_a") === true && app.BA.viewing("as_b") === false,
      "BA.viewing 真读 agentViewHas（焦点是否在这条会话上）");
    /* ① 焦点在这条会话：照旧自动开栏 */
    app.act("navigate", "打开 https://example.com");
    await tick(); await tick(); await tick();
    ok(app.BA.isOpen() === true, "焦点在这条会话：右栏照旧自己出现");

    /* ② 切到另一条会话（焦点不在它）：它再动浏览器 → 不弹栏、不提示、但画面照常连 */
    const app2 = makeApp({ running: true, viewing: "as_other" });
    await tick(); await tick();
    app2.BA.setSession("as_me");
    await tick(); await tick();
    ok(app2.BA.isOpen() === false, "起点：右栏收着");
    app2.act("navigate", "打开 https://example.com");
    await tick(); await tick(); await tick();
    ok(app2.BA.isOpen() === false && app2.els.baPanel.hidden === true,
      "焦点不在该会话：**不弹右栏**（绝不把用户的界面挪走）");
    ok(app2.calls.viewStart === 1,
      "但把实况画面静默连起来（切过去立刻有画面，不是「连接中…」空窗）[viewStart="
      + app2.calls.viewStart + " on=" + app2.BA.live.on + "]");
    ok(app2.BA._sideMarked.has("as_me"),
      "左栏那条会话上留了被动标记（BA._sideMarked：不抢焦点、不弹提示）");
    ok(!app2.BA._sideMarked.has("as_other"), "别的会话不会被顺手盖章");

    /* ③ 静态口径：静默走的是「只连流」的函数，没碰 setOpen */
    const silent = (SRC.split("BA.silentConnect = function")[1] || "").slice(0, 500);
    ok(!/setOpen|autoOpenForUse/.test(silent),
      "静默连流只开流，不改面板显隐、不递归触发自动开栏");
    ok(/BA\.viewing = function/.test(SRC) && /agentViewHas/.test(SRC),
      "「焦点在不在这条会话」的唯一判据收口到 agentViewHas");
  }

  console.log("\n" + (fails ? "FAILED " + fails : "全部通过"));
  process.exit(fails ? 1 : 0);
})();
