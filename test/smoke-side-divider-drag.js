/* 分栏分界线的「整条边界可拖」真行为回归（vm 沙箱里真按指针事件）
 *   node test/smoke-side-divider-drag.js
 *
 * 钉住用户报的那个 bug：浏览器边栏拖不动。CSS 那半（命中区铺满栏高、常态竖筋、
 * 不再有中间加宽把手）由 smoke-browser.js 钉住；这里钉另一半——**真的能用**：
 * 按下即捕获指针、拖动跟手、松手才落盘一次、中途被打断（pointercancel）也干净收尾。
 *
 * 覆盖：
 *   [1] app-browser.js 右栏分界线：pointerdown → 拖动跟手（--ba-w 真变）→ 松手落盘一次
 *   [2] 同一条线被打断（pointercancel）：宽度保留、class / 监听 / 光标全收干净
 *   [3] app-assist.js 共享的 bindSideDividerDrag（会话左栏 / 助手栏走它）：捕获 + 增量 + 落盘 + 中断
 *   [4] app-apps-dev.js 的 appsDevBindColResize（开发页三栏两条）：同口径 + 双击复位
 *   [5] 根因回归：拖动写 --ba-w 引发的样式变更**不得**把宽度按回记忆里的旧值
 *       （app-browser.js 的 MutationObserver → applyDeferred → setOpen → applyWidth）
 *   [6] 真切换视图（display 变了）仍按记忆恢复显隐与宽度
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const APP_BROWSER = read("renderer/app-browser.js");
const APP_ASSIST = read("renderer/app-assist.js");
const APP_APPS_DEV = read("renderer/app-apps-dev.js");

let fails = 0;
const ok = (cond, msg) => {
  console.log((cond ? "  ok    " : "FAIL  ") + msg);
  if (!cond) fails++;
};
const eq = (got, want, msg) => ok(got === want, msg + "（得到 " + JSON.stringify(got) + "）");
const tick = () => new Promise((r) => setTimeout(r, 0));

/* 真的会响的 MutationObserver（沙箱里那份）：盯住 style 写入，微任务里回一次回调 ——
   与浏览器同一时序。被测代码的 applyDeferred 就是挂在这个回调上的。 */
const MOS = [];
function notifyStyle(el) {
  if (!MOS.length) return;
  queueMicrotask(() => {
    for (const o of MOS.slice()) {
      if (o.target === el && o.alive) o.cb([], o);
    }
  });
}

/* ── 带事件登记的 DOM 桩（比只读断言更进一步：真按下去拖）────────────────── */
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
    clientWidth: 1280,
    clientHeight: 620,
    scrollTop: 0,
    scrollHeight: 0,
    title: "",
    attrs: {},
    _cap: null,
    classList: mkClassList(),
    handlers,
    addEventListener(t, fn) { (handlers[t] = handlers[t] || []).push(fn); },
    removeEventListener(t, fn) { if (handlers[t]) handlers[t] = handlers[t].filter((f) => f !== fn); },
    fire(t, ev) { (handlers[t] || []).slice().forEach((fn) => fn(ev)); },
    count(t) { return (handlers[t] || []).length; },
    appendChild() {},
    setAttribute(k, v) { el.attrs[k] = v; },
    getAttribute: (k) => (k in el.attrs ? el.attrs[k] : null),
    focus() {},
    getContext: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    setPointerCapture(pid) { el._cap = pid; },
    hasPointerCapture(pid) { return el._cap === pid; },
    releasePointerCapture() { el._cap = null; },
    /* 宽度跟着 style.width 走：applyWidth 写完，下一次 current() 读到的就是新宽度（真实口径） */
    getBoundingClientRect() {
      const n = Number(String(el.style.width).replace("px", ""));
      return { left: 0, top: 0, width: Number.isFinite(n) && n > 0 ? n : 340, height: 620 };
    },
  };
  /* style：写 --ba-w（setProperty）与写 display 都当成一次样式变更 → 通知观察器，
     这正是真浏览器里 MutationObserver(attributeFilter:["style"]) 的触发面。 */
  let disp = "";
  const st = {
    width: "",
    _vars: {},
    /* 值没变就不通知：与真浏览器一致（CSS 文本没变的 setProperty 不会产生属性变更记录），
       顺带避免「同一个值反复写 → 观察器 → 再写」这种测试里的自激循环。 */
    setProperty(k, v) { if (this._vars[k] === v) return v; this._vars[k] = v; notifyStyle(el); return v; },
    removeProperty(k) { if (!(k in this._vars)) return; delete this._vars[k]; notifyStyle(el); },
  };
  Object.defineProperty(st, "display", {
    enumerable: true,
    get: () => disp,
    set: (v) => { if (disp === v) return; disp = v; notifyStyle(el); },
  });
  el.style = st;
  return el;
}
function mkWin() {
  const handlers = {};
  const win = {
    handlers,
    addEventListener(t, fn) { (handlers[t] = handlers[t] || []).push(fn); },
    removeEventListener(t, fn) { if (handlers[t]) handlers[t] = handlers[t].filter((f) => f !== fn); },
    fire(t, ev) { (handlers[t] || []).slice().forEach((fn) => fn(ev)); },
    count(t) { return (handlers[t] || []).length; },
  };
  return win;
}
const pd = (x, pid) => ({ button: 0, clientX: x, clientY: 300, pointerId: pid || 1, preventDefault() {}, stopPropagation() {} });
const pm = (x) => ({ clientX: x, clientY: 300, preventDefault() {} });

/* 从源码里抠出一个顶层函数（被测文件各有依赖，只取这一段，按需注入桩） */
function extractFn(src, name) {
  const at = src.indexOf("function " + name + "(");
  if (at < 0) return "";
  const open = src.indexOf("{", at);
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}" && --depth === 0) return src.slice(at, j + 1);
  }
  return "";
}
function makeFn(src, name, params, args) {
  const body = extractFn(src, name);
  if (!body) throw new Error("抽不出函数：" + name);
  return new Function(...params, body + "\nreturn " + name + ";")(...args);
}

/* ── [1] 右栏（浏览器活动栏）分界线：真拖一次 ─────────────────────────── */
const IDS = [
  "agentPane", "agentBrowserChip", "baPanel", "baResize", "baClose", "baOpen", "baStop",
  "baTakeover", "baPolicy", "baRefresh", "baFilter", "baAll", "baClear", "baList",
  "baCount", "baStatus", "baLiveCanvas", "baLivePause", "baLiveModeBtn", "baLiveMode",
  "baLiveNote", "baLiveMask", "baLive",
];
function makeBrowserApp(storage) {
  const els = {};
  for (const id of IDS) els[id] = mkEl(id);
  els.baPanel.hidden = true;
  const store = Object.assign({}, storage || {});
  const win = mkWin();
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
  win.I18n = { t: (k) => k };
  win.toast = () => {};
  const doc = {
    readyState: "complete",
    addEventListener() {},
    body: mkEl("body"),
    querySelector: (sel) => (sel && sel[0] === "#" ? els[sel.slice(1)] || null : null),
    querySelectorAll: () => [],
    createElement: (t) => mkEl(t),
  };
  const sb = {
    console,
    setTimeout,
    clearTimeout,
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    },
    MutationObserver: class {
      constructor(cb) { this.cb = cb; this.target = null; this.alive = true; }
      observe(t) { this.target = t; MOS.push(this); }
      disconnect() { this.alive = false; }
    },
    Image: class {},
    requestAnimationFrame: (cb) => setTimeout(cb, 0),
    document: doc,
  };
  sb.window = win;
  win.document = doc;
  vm.createContext(sb);
  vm.runInContext(APP_BROWSER, sb, { filename: "app-browser.js" });
  return { BA: win.BrowserAct, els, store, win, doc, pane: els.agentPane, box: els.baPanel, handle: els.baResize };
}

(async () => {
  console.log("[1] 浏览器活动栏分界线：整条边界按下就能拖（右栏那个 bug 的主场）");
  {
    const app = makeBrowserApp({ "mtnode.baOpen": "1" });
    await tick(); await tick();
    const h = app.handle;
    ok(app.BA.isOpen() === true, "右栏已开（分界线这时才在画面上）");
    ok(h.count("pointerdown") > 0, "分界线已接 pointerdown（不再只有中间一小段能按）");
    eq(app.pane.style._vars["--ba-w"], "340px", "起始宽度走 --ba-w（340 默认，与网格同一真源）");

    h.fire("pointerdown", pd(1000, 3));
    ok(h.classList.contains("dragging") && app.doc.body.style.cursor === "col-resize",
      "按下：整条线进 .dragging（CSS 整条高亮）+ 全窗口 col-resize");
    eq(app.store["mtnode.baW"], undefined, "拖动中不落盘（只改样式）");

    app.win.fire("pointermove", pm(940));
    eq(app.pane.style._vars["--ba-w"], "400px", "向左拖 60px → 栏宽 340+60=400（跟手）");
    eq(app.box.style.width, "400px", "面板本体宽度同步（面板真的变宽了）");

    app.win.fire("pointerup", {});
    eq(app.store["mtnode.baW"], "400", "松手才落盘一次：localStorage mtnode.baW=400");
    ok(!h.classList.contains("dragging") && app.doc.body.style.cursor === "",
      "松手：.dragging 与光标都收干净");
    eq(app.win.count("pointermove"), 0, "松手后 window 上不留 pointermove 监听（不叠监听）");
  }

  console.log("\n[2] 拖动被系统打断（pointercancel）：同样干净收尾、宽度保留");
  {
    const app = makeBrowserApp({ "mtnode.baOpen": "1" });
    await tick(); await tick();
    const h = app.handle;
    h.fire("pointerdown", pd(1000, 5));
    app.win.fire("pointermove", pm(900));
    eq(app.pane.style._vars["--ba-w"], "440px", "拖到 440px（100px 增量）");
    app.win.fire("pointercancel", {});
    ok(!h.classList.contains("dragging") && app.doc.body.style.cursor === "",
      "被打断：class / 光标照样收干净（不会卡在「拖动中」）");
    eq(app.store["mtnode.baW"], "440", "被打断也把当前宽度落盘（用户拖过的宽度不丢）");
    eq(app.win.count("pointermove"), 0, "被打断后不留监听");
  }

  console.log("\n[3] app-assist.js 共享的 bindSideDividerDrag（会话左栏 / 助手栏 / 也接管右栏）");
  {
    const handle = mkEl("assistResize");
    const $ = (s) => (s === "#assistResize" ? handle : null);
    const win = mkWin();
    const doc = { body: { style: {} } };
    const bindSideDividerDrag = makeFn(APP_ASSIST, "bindSideDividerDrag", ["$", "window", "document"], [$, win, doc]);
    const applied = [];
    const out = bindSideDividerDrag({
      id: "assistResize",
      sign: 1, /* 助手栏在右，向左拖 = 变宽 */
      current: () => 420,
      apply: (w, persist) => applied.push([w, persist]),
    });
    ok(out === handle, "返回把手元素（绑定成功）");
    eq(handle.attrs["role"], "separator", "有无障碍语义（role=separator / 竖向）");
    eq(handle.attrs["aria-orientation"], "vertical", "aria-orientation=vertical");

    handle.fire("pointerdown", pd(600, 9));
    eq(handle._cap, 9, "按下即 setPointerCapture（指针移出细线 / 移出窗口也断不了线）");
    ok(handle.classList.contains("dragging") && doc.body.style.cursor === "col-resize",
      "按下进 dragging + 全窗口 col-resize");

    win.fire("pointermove", pm(540));
    eq(applied.length, 1, "拖动中每次 move 只走一次 apply");
    eq(applied[0][0], 480, "向左 60px → 420+60=480（跟手）");
    eq(applied[0][1], false, "拖动中 persist=false（不落盘）");

    win.fire("pointerup", {});
    eq(applied.length, 2, "松手再 apply 一次");
    eq(applied[1][1], true, "松手这次才 persist=true（只落盘一次）");
    eq(handle._cap, null, "松手释放指针捕获");
    ok(!handle.classList.contains("dragging") && doc.body.style.cursor === "" && doc.body.style.userSelect === "",
      "松手：class / 光标 / 选中态全收干净");
    eq(win.count("pointermove"), 0, "松手后 window 上无残留监听");

    /* 中断路径：pointercancel 必须等价于松手 */
    applied.length = 0;
    handle.fire("pointerdown", pd(600, 11));
    win.fire("pointermove", pm(560));
    win.fire("pointercancel", {});
    eq(applied.length, 2, "被打断：同样只 apply 两次（拖动中 + 收尾）");
    eq(applied[1][1], true, "被打断也落盘一次");
    ok(!handle.classList.contains("dragging") && win.count("pointermove") === 0, "被打断不留残留态");

    /* 非左键不启动拖动 */
    applied.length = 0;
    handle.fire("pointerdown", { button: 2, clientX: 600, pointerId: 13, preventDefault() {}, stopPropagation() {} });
    ok(!handle.classList.contains("dragging") && applied.length === 0, "右键不误触发拖动");
  }

  console.log("\n[4] 开发页三栏两条分界线（appsDevBindColResize）：同口径 + 双击复位");
  {
    const S = { appsDevSideW: 240, appsDevConvW: 300 };
    const calls = [];
    const applyAppsDevCols = (side, conv, persist) => {
      calls.push([side, conv, persist]);
      if (side != null) S.appsDevSideW = side;
      if (conv != null) S.appsDevConvW = conv;
    };
    const make = (kind) => {
      const handle = mkEl("appsDevResize-" + kind);
      const win = mkWin();
      const doc = { body: { style: {} } };
      const fn = makeFn(
        APP_APPS_DEV,
        "appsDevBindColResize",
        ["appsDevT", "S", "applyAppsDevCols", "window", "document"],
        [(k) => k, S, applyAppsDevCols, win, doc],
      );
      fn(handle, kind);
      return { handle, win, doc };
    };

    const side = make("side");
    side.handle.fire("pointerdown", pd(300, 21));
    ok(side.handle.classList.contains("dragging") && side.doc.body.style.cursor === "col-resize",
      "左分界线按下：dragging + col-resize");
    side.win.fire("pointermove", pm(360));
    eq(JSON.stringify(calls[calls.length - 1]), "[300,null,false]", "左分界线向右 60px → 240+60=300（拖动中不落盘）");
    side.win.fire("pointerup", {});
    eq(calls[calls.length - 1][2], true, "左分界线松手才落盘一次");
    eq(side.win.count("pointermove"), 0, "左分界线松手后无残留监听");

    const conv = make("conv");
    conv.handle.fire("pointerdown", pd(900, 22));
    conv.win.fire("pointermove", pm(860));
    eq(JSON.stringify(calls[calls.length - 1]), "[null,340,false]", "右分界线向左 40px → 300+40=340");
    conv.win.fire("pointercancel", {});
    eq(calls[calls.length - 1][2], true, "右分界线被打断也收尾落盘");
    ok(!conv.handle.classList.contains("dragging") && conv.doc.body.style.cursor === "",
      "右分界线被打断不留残留态");

    conv.handle.fire("dblclick", { preventDefault() {}, stopPropagation() {} });
    eq(JSON.stringify(calls[calls.length - 1]), "[" + S.appsDevSideW + ",0,true]",
      "双击右分界线 → 只复位这一栏（右栏回 0=与中栏等分，左栏保持用户当前宽度）并立即落盘");
  }

  console.log("\n[5] 根因回归：写 --ba-w 引发的样式变更不得把宽度按回去（右栏拖不动的真凶）");
  {
    const app = makeBrowserApp({ "mtnode.baOpen": "1" });
    await tick(); await tick();
    const h = app.handle;
    eq(app.pane.style._vars["--ba-w"], "340px", "起始 340px");

    h.fire("pointerdown", pd(1000, 31));
    app.win.fire("pointermove", pm(940));
    eq(app.pane.style._vars["--ba-w"], "400px", "pointermove 立刻跟手 400px");
    /* 关键：applyWidth 写的是 #agentPane 自己的 style 属性 —— 浏览器会把它交给
       MutationObserver，回调若不加限定就会走 setOpen → applyWidth(记忆宽度)，
       同一帧内把 400 改回 340（实测真机就是这个现象）。等微任务跑完再看。 */
    await tick(); await tick();
    eq(app.pane.style._vars["--ba-w"], "400px",
      "样式变更被观察器看到之后，宽度仍是 400（不再被 applyDeferred 按回记忆里的 340）");
    eq(app.box.style.width, "400px", "面板本体也停在 400px（拖动真的跟手）");
    eq(app.store["mtnode.baW"], undefined, "拖动中依旧不落盘");

    app.win.fire("pointermove", pm(900));
    await tick(); await tick();
    eq(app.pane.style._vars["--ba-w"], "440px", "继续拖到 440px 也不被按回");
    app.win.fire("pointerup", {});
    eq(app.store["mtnode.baW"], "440", "松手把用户真拖到的 440 落盘（不是记忆里的旧值）");
  }

  console.log("\n[6] 真切换视图（display 变了）仍按记忆恢复显隐与宽度");
  {
    const app = makeBrowserApp({ "mtnode.baOpen": "1", "mtnode.baW": "520" });
    await tick(); await tick();
    ok(app.BA.isOpen() === true, "进会话视图：右栏按记忆打开");
    eq(app.pane.style._vars["--ba-w"], "520px", "宽度取记忆值 520");
    /* display 变化才是视图切换（app-assist.js setView 改的就是它） */
    app.pane.style.display = "none";
    await tick(); await tick();
    app.pane.style.display = "";
    await tick(); await tick();
    ok(app.BA.isOpen() === true, "切回会话视图：仍按记忆恢复显示");
    eq(app.pane.style._vars["--ba-w"], "520px", "恢复的还是记忆里的 520（视图切换这条链没被改坏）");
  }

  console.log(fails ? "\nFAIL " + fails + " 项" : "\n全部通过");
  process.exit(fails ? 1 : 0);
})();
