/* test/_perf-probe/perf-panel-churn.cjs —— 顶栏「性能」面板的每 tick DOM 翻建基线（开发用具，手动跑）
 *
 * 目的（量化「界面闪烁」）：面板每个 1s tick 都把整块面板 innerHTML 重写一遍，用户看到的就是
 * 每秒闪一下。这只脚本用**假 DOM**（不启 Electron、不碰数据目录、零依赖）把
 * renderer/app-perf.js + renderer/app-vram.js 真跑 5 秒虚拟时间，数三件事：
 *   ① 对 .perf-data / .vram-slot 的 innerHTML 写入次数；
 *   ② 每次写入丢弃 / 新建的节点数（含合计与峰值）；
 *   ③ 读数桥（perfSample / perfSystem / vramSnapshot）被调用的次数。
 *
 * 用法：node test\_perf-probe\perf-panel-churn.cjs [outJson]
 *       （outJson 缺省系统临时目录；只写系统临时目录，不写项目目录）
 *
 * 口径（为什么这样数才可信）：
 *   · 虚拟时钟：只替换沙箱里的 Date.now 与 setInterval，1s 一跳按虚拟时间推进
 *     （面板自己的到点判定用的就是 Date.now，所以 1.5s / 5s 两档语义与真窗口一致），
 *     真实墙钟只花约 1 秒就能跑完 5 秒剧本；
 *   · 假 DOM 会真建节点树：写 innerHTML = 丢掉旧的子树（逐节点记「被丢弃」）+ 按标签建新的
 *     （逐节点记「新建」）。节点数不是估的，是数出来的；
 *   · 读数桥喂**固定**假读数：面板拿到的数值全程不变 —— 所以任何节点翻建都不是「因为读数变了」；
 *   · 记「常驻节点」：面板初次绘制时建出来的节点，到本次观测结束时是否还挂在树上。
 *     旧口径下它们每个 tick 都被换掉（常驻 0），这正是闪烁的直接证据；
 *   · 不改任何产品文件，只读 renderer/app-perf.js 与 renderer/app-vram.js。
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..", "..");
const SRC_PERF = path.join(ROOT, "renderer", "app-perf.js");
const SRC_VRAM = path.join(ROOT, "renderer", "app-vram.js");
const OUT = String(process.argv[2] || path.join(os.tmpdir(), "mtnode-perf-churn.json"));

/* ── 观测窗口与节拍 ───────────────────────────────────────────────────── */
const WINDOW_MS = 5000; /* 观测 5 秒（虚拟时间） */
const TICK_MS = 1000; /* perfStartTimer 的节拍 */

/* ═══════════ 假 DOM：真建节点树 + 记账 ═══════════ */

const counters = {
  created: 0, /* 真被建出来的节点数（含面板初次绘制） */
  discarded: 0, /* 因 innerHTML 重写而被丢掉的节点数 */
  writes: 0, /* 记录在案的 innerHTML 写入次数（只算我们认得的那几只宿主） */
};

/* 每只宿主按标签共用一份账：宿主被换掉（重建）也接着数同一份 */
const HOST_STATS = new Map();
function statsOf(label) {
  if (!HOST_STATS.has(label)) {
    HOST_STATS.set(label, {
      label: label,
      builtRef: null,
      writes: 0,
      coldWrites: 0,
      discarded: 0,
      created: 0,
      maxCreated: 0,
      lastWrite: null,
      tickBase: 0,
      seq: [],
      base: { created: counters.created, discarded: counters.discarded, at: 0 },
    });
  }
  return HOST_STATS.get(label);
}
function track(el, label) {
  if (!el) return null;
  const st = statsOf(label);
  st.builtRef = el;
  el.__stat = st;
  return st;
}
/** 每 tick 一步：宿主内容被整段重写 = 记一次写入（并改用新的宿主实例） */
function reconcile(label, tickNo) {
  const st = statsOf(label);
  if (st.builtRef) {
    const isCold = tickNo === st.tickBase; /* 首帧那一次绘制不计入「每秒翻建」 */
    const created = counters.created - st.base.created;
    const discarded = counters.discarded - st.base.discarded;
    if (isCold) {
      st.coldWrites++;
      st.base = { created: counters.created, discarded: counters.discarded, at: vnow - T0 };
      st.builtRef = null;
      const cur = ovBodyEl.querySelector(label);
      if (cur) {
        st.builtRef = cur;
        cur.__stat = st;
      }
      st.tickBase = tickNo;
      return st;
    }
    st.writes++;
    st.created += created;
    st.discarded += discarded;
    if (created > st.maxCreated) st.maxCreated = created;
    st.seq.push({ tick: tickNo, at: vnow - T0, discarded: discarded, created: created });
    st.builtRef = null;
    st.lastWrite = { created: created, discarded: discarded, at: vnow - T0 };
  }
  const cur = ovBodyEl.querySelector(label);
  if (cur) {
    st.base = { created: counters.created, discarded: counters.discarded, at: vnow - T0 };
    st.builtRef = cur;
    cur.__stat = st;
  }
  return st;
}
/** 收尾：把观测窗末尾还挂着的那一帧单独记一笔（不算作一次 tick 的改写） */
function settle(label) {
  const st = statsOf(label);
  if (!st.builtRef) return st;
  const created = counters.created - st.base.created;
  const discarded = counters.discarded - st.base.discarded;
  st.tail = { at: vnow - T0, discarded: discarded, created: created };
  st.lastWrite = { created: created, discarded: discarded, at: vnow - T0 };
  st.builtRef = null;
  return st;
}

/** 活节点数：从 el 往下走（未丢弃的）树 */
function countLive(el) {
  let n = 0;
  const walk = (x) => {
    n++;
    for (const c of x.children) walk(c);
  };
  walk(el);
  return n;
}

/** 整棵树里所有活节点（用来算上一 tick 建出来、这一 tick 还在不在） */
function liveSet(root) {
  const s = new Set();
  const walk = (x) => {
    s.add(x);
    for (const c of x.children) walk(c);
  };
  walk(root);
  return s;
}

const VOID_TAGS = new Set(["br", "img", "input", "hr", "meta", "link", "source", "path", "circle", "rect"]);
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", nbsp: " " };
const unesc = (s) => String(s).replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m, k) => ENTITIES[k] || m);

function mkEl(tag, attrs) {
  counters.created++;
  const el = {
    tag: String(tag || "div").toLowerCase(),
    id: (attrs && attrs.id) || "",
    className: (attrs && attrs.class) || "",
    attrs: attrs || {},
    style: {},
    dataset: {},
    children: [],
    parent: null,
    onClick: null,
    textContent: "",
    __alive: true,
  };
  el.classList = {
    add() {},
    remove() {},
    contains: (c) => String(el.className).split(/\s+/).indexOf(c) >= 0,
    toggle() {},
  };
  Object.defineProperty(el, "innerHTML", {
    get() {
      return el.__src || "";
    },
    set(v) {
      const s = String(v == null ? "" : v);
      /* 丢旧子树：逐节点记账（这就是「闪」的成本） */
      for (const c of el.children) destroyAll(c);
      el.children = [];
      /* 建新子树 */
      for (const c of parseFragment(s, el)) el.children.push(c);
      el.__src = s;
      counters.writes++;
      if (el.__stat && el.__stat.pending) {
        const f = el.__stat.pending;
        el.__stat.pending = null;
        f();
      }
    },
  });
  el.appendChild = (c) => {
    c.parent = el;
    el.children.push(c);
    return c;
  };
  el.removeChild = (c) => {
    const i = el.children.indexOf(c);
    if (i >= 0) el.children.splice(i, 1);
    return c;
  };
  el.querySelector = (sel) => findOne(el, sel, true);
  el.querySelectorAll = (sel) => findAll(el, sel, true);
  el.matches = (sel) => matchesSel(el, sel);
  /* 真 DOM 里 onclick 是属性；这里只记下来（onclick 重复挂载正是要盯的点） */
  Object.defineProperty(el, "onclick", {
    get() {
      return el.onClick;
    },
    set(f) {
      el.onClickHooks = (el.onClickHooks || 0) + 1;
      el.onClick = f;
    },
  });
  return el;
}

function destroyAll(el) {
  el.__alive = false;
  counters.discarded++;
  for (const c of el.children) destroyAll(c);
  el.children = [];
  if (el.parent) {
    const i = el.parent.children.indexOf(el);
    if (i >= 0) el.parent.children.splice(i, 1);
  }
}

/* ── 极简 HTML 片段解析（够 perf / vram 这两份标记用） ───────────────────── */
function parseFragment(html, parent) {
  const out = [];
  const stack = [];
  let i = 0;
  const top = () => (stack.length ? stack[stack.length - 1] : null);
  const push = (node) => {
    const p = top();
    node.parent = p || parent;
    if (p) p.children.push(node);
    else out.push(node);
  };
  while (i < html.length) {
    if (html[i] === "<") {
      const end = html.indexOf(">", i);
      if (end < 0) break;
      const raw = html.slice(i + 1, end);
      i = end + 1;
      if (raw[0] === "/") {
        stack.pop();
        continue;
      }
      const selfClose = raw.endsWith("/");
      const inner = selfClose ? raw.slice(0, -1) : raw;
      const m = /^([a-zA-Z][\w-]*)([\s\S]*)$/.exec(inner);
      if (!m) continue;
      const tag = m[1].toLowerCase();
      const attrs = {};
      const re = /([a-zA-Z_:][-\w:.]*)\s*=\s*"([^"]*)"|([a-zA-Z_:][-\w:.]*)\s*=\s*'([^']*)'/g;
      let a;
      while ((a = re.exec(m[2]))) {
        const k = (a[1] || a[3]).toLowerCase();
        attrs[k] = unesc(a[2] != null ? a[2] : a[4]);
      }
      const el = mkEl(tag, attrs);
      push(el);
      if (!selfClose && !VOID_TAGS.has(tag)) stack.push(el);
      continue;
    }
    const nxt = html.indexOf("<", i);
    const text = html.slice(i, nxt < 0 ? html.length : nxt);
    i = nxt < 0 ? html.length : nxt;
    if (text.trim()) {
      const t = mkEl("#text");
      t.textContent = unesc(text);
      t.__isText = true;
      push(t);
    }
  }
  return out;
}

/* ── 选择器：只要 class / #id / tag 三样本事 ─────────────────────────────── */
function matchesSel(el, sel) {
  const s = String(sel).trim();
  if (!s) return false;
  if (s[0] === ".") return String(el.className).split(/\s+/).indexOf(s.slice(1)) >= 0;
  if (s[0] === "#") return el.id === s.slice(1);
  return el.tag === s.toLowerCase();
}
function findOne(root, sel, skipSelf, deep) {
  if (!skipSelf && matchesSel(root, sel)) return root;
  for (const c of root.children) {
    const hit = findOne(c, sel, false, deep);
    if (hit) return hit;
  }
  return null;
}
function findAll(root, sel, skipSelf) {
  const out = [];
  const walk = (el, first) => {
    if (!(first && skipSelf) && matchesSel(el, sel)) out.push(el);
    for (const c of el.children) walk(c, false);
  };
  walk(root, true);
  return out;
}
function idIndex(root) {
  const map = new Map();
  const walk = (el) => {
    if (el.id && !map.has(el.id)) map.set(el.id, el);
    for (const c of el.children) walk(c);
  };
  walk(root);
  return map;
}

/* ═══════════ 假环境与假读数 ═══════════ */

let T0 = Date.now();
let vnow = T0;
const bridgeCalls = { perfStatics: 0, perfSample: 0, perfSystem: 0, perfPorts: 0, vramSnapshot: 0, vramRelease: 0 };

/* 静态外壳（#overlay > .overlay-box > #ovTitle/#ovBody/#ovFoot）：与 renderer/index.html 同结构 */
const docRoot = mkEl("#document");
const htmlRoot = mkEl("html", {});
docRoot.appendChild(htmlRoot);
const bodyEl = mkEl("body", {});
htmlRoot.appendChild(bodyEl);
const overlayEl = mkEl("div", { id: "overlay" });
overlayEl.style.display = "none";
bodyEl.appendChild(overlayEl);
const boxEl = mkEl("div", { class: "overlay-box" });
overlayEl.appendChild(boxEl);
const ovTitleEl = mkEl("b", { id: "ovTitle" });
const ovBodyEl = mkEl("div", { class: "overlay-body", id: "ovBody" });
const ovFootEl = mkEl("div", { class: "overlay-foot", id: "ovFoot" });
boxEl.appendChild(ovTitleEl);
boxEl.appendChild(ovBodyEl);
boxEl.appendChild(ovFootEl);

const SHELL_NODES = countLive(docRoot); /* 观测前先把外壳的建造成本摘掉 */

/* 假读数：全程固定（面板若仍翻建节点，就不是「读数变了」造成的） */
const FIXED = {
  statics: { ok: true, cores: 24, cpuModel: "Intel(R) Core(TM) i9-14900KF", dataDir: "C:\\Users\\x\\AppData\\Roaming\\pipeline-console" },
  sample: {
    ok: true,
    cpu: { overall: 21.1, cores: [40, 0, 67, 0], count: 4, model: "Intel(R) Core(TM) i9-14900KF" },
    mem: { totalBytes: 64e9, freeBytes: 40e9, usedBytes: 24e9, usedPct: 37.5 },
    gpu: {
      available: true,
      reason: "",
      cards: [{ name: "NVIDIA GeForce RTX 4090", utilPct: 62, usedMb: 2693, totalMb: 24564, memPct: 11, tempC: 50, powerW: 52.05, fanPct: 0 }],
    },
  },
  system: {
    ok: true,
    dataDir: "C:\\Users\\x\\AppData\\Roaming\\pipeline-console",
    appDir: "E:\\dev\\tools\\pipeline-console",
    volumes: [
      { letter: "C:", freeBytes: 116e9, usedBytes: 585e9, totalBytes: 701e9, freePct: 16.6, role: "data" },
      { letter: "E:", freeBytes: 264e9, usedBytes: 1080e9, totalBytes: 1344e9, freePct: 19.7, role: "app" },
    ],
    net: {
      ifaces: [{ name: "以太网 3", desc: "Realtek", status: "Up", linkSpeed: "2.5 Gbps", up: true, wireless: false }],
      rates: [{ name: "以太网 3", rx: 38e9, tx: 15e9, rxRate: 4096, txRate: 1024 }],
    },
    conns: { established: 91, listening: 66, timeWait: 55, other: 17, total: 229 },
    ports: [{ port: 8188, listening: true }, { port: 11434, listening: false }],
  },
  vram: {
    ok: true,
    gpu: { name: "NVIDIA GeForce RTX 4090", usedMb: 2693, totalMb: 24564 },
    backends: [{ id: "h3", label: "H3（ComfyUI 视频）", port: 8188, running: true, busy: false, idleReleasable: true }],
    log: ["[2026-01-01T00:00:00Z] [vram] 完成 H3：动作=soft"],
  },
};

let TICK_NO = 0;
const tickLog = [];
let windowDone = null; /* 观测窗跑完的通知（main 里挂上，虚拟时钟到点即触发） */
let clockArmed = false; /* 首帧结算完才放虚拟时钟走（否则 30ms 那一步等不到） */
const sandbox = {};
sandbox.console = { log() {}, warn() {}, error() {} };
sandbox.setTimeout = setTimeout;
sandbox.clearTimeout = clearTimeout;
sandbox.JSON = JSON;
sandbox.Math = Math;
sandbox.String = String;
sandbox.Number = Number;
sandbox.Object = Object;
sandbox.Array = Array;
sandbox.Boolean = Boolean;
sandbox.RegExp = RegExp;
sandbox.isNaN = isNaN;
sandbox.parseInt = parseInt;
sandbox.parseFloat = parseFloat;
sandbox.Date = Date;
sandbox.Date.now = () => vnow; /* 虚拟时钟：面板的到点判定（Date.now）走到这里 */
/* 虚拟时钟：面板注册的 1s 定时器按虚拟时间推进（面板的到点判定用的就是 Date.now） */
sandbox.setInterval = (fn, ms) => {
  const period = Math.max(1, Number(ms) || 1000);
  const rec = { fn: fn, period: period, cancelled: false, seq: [] };
  let waits = 0;
  const step = () => {
    if (rec.cancelled) return;
    /* 首帧（面板初次绘制）还没结算完就先让一步：主线的 30ms 等待必须先落地，
       否则整条虚拟时钟会在同一个 tick 相位里跑完，「稳态窗口」就量不到东西了 */
    if (!clockArmed && waits++ < 40) return void setTimeout(step, 0);
    vnow += period;
    if (vnow - T0 >= WINDOW_MS) {
      /* 观测窗口跑完：不再推进时钟，把剧本交给 main（用事件通知，不用真时钟等） */
      if (process.env.PERF_CHURN_DEBUG) console.log("[clk] 观测窗结束 vnow-T0=" + (vnow - T0));
      if (typeof windowDone === "function") windowDone();
      return;
    }
    if (process.env.PERF_CHURN_DEBUG) console.log("[clk] tick vnow-T0=" + (vnow - T0));
    rec.fn();
    rec.seq.push(vnow - T0);
    setTimeout(step, 0);
  };
  setTimeout(step, 0);
  return rec;
};
sandbox.clearInterval = (rec) => {
  if (rec && typeof rec === "object") rec.cancelled = true;
};
sandbox.I18n = { t: (k, vars) => (vars == null ? String(k) : String(k) + String(vars)) };
sandbox.document = {
  getElementById: (id) => idIndex(docRoot).get(String(id)) || null,
  createElement: (tag) => mkEl(tag, {}),
  querySelector: () => null,
  querySelectorAll: () => [],
};
sandbox.window = sandbox;
sandbox.window.api = {
  perfStatics: () => {
    bridgeCalls.perfStatics++;
    return Promise.resolve(FIXED.statics);
  },
  perfSample: () => {
    bridgeCalls.perfSample++;
    return Promise.resolve(FIXED.sample);
  },
  perfSystem: () => {
    bridgeCalls.perfSystem++;
    return Promise.resolve(FIXED.system);
  },
  perfPorts: () => {
    bridgeCalls.perfPorts++;
    return Promise.resolve({ ok: true, ports: [] });
  },
  vramSnapshot: () => {
    bridgeCalls.vramSnapshot++;
    return Promise.resolve(FIXED.vram);
  },
  vramRelease: () => {
    bridgeCalls.vramRelease++;
    return Promise.resolve({ ok: true, steps: [] });
  },
  onVramReleased: () => () => {},
};
vm.createContext(sandbox);

/* openOverlay 假体：与真实现同一语义（清空 body / foot、显示蒙层、记标题） */
sandbox.openOverlay = (title) => {
  sandbox.__ovTitle = String(title);
  ovBodyEl.innerHTML = "";
  ovFootEl.innerHTML = "";
  overlayEl.style.display = "flex";
};
sandbox.closeOverlay = () => {
  overlayEl.style.display = "none";
};
sandbox.openSettings = () => {};
sandbox.toast = () => {};
sandbox.escapeHtml = (s) => String(s == null ? "" : s);

const perfSrc = fs.readFileSync(SRC_PERF, "utf8");
const vramSrc = fs.readFileSync(SRC_VRAM, "utf8");
vm.runInContext(vramSrc, sandbox, { filename: "app-vram.js" });
vm.runInContext(perfSrc, sandbox, { filename: "app-perf.js" });

/* ── tick 包装：观测窗口内每一跳结算一次宿主写入，并数上一帧节点的存活数 ── */
const realTick = sandbox.perfTick;
let lastDataHost = null;
sandbox.perfTick = async function (force) {
  const beforeDiscarded = counters.discarded;
  const beforeCreated = counters.created;
  const before = liveSet(docRoot);
  TICK_NO++;
  const r = await realTick(force);
  const inside = vnow - T0 <= WINDOW_MS;
  if (inside) {
    reconcile(".perf-data", TICK_NO);
    reconcile(".vram-slot", TICK_NO);
    const after = liveSet(docRoot);
    let survivors = 0;
    for (const n of before) if (after.has(n)) survivors++;
    tickLog.push({
      tick: TICK_NO,
      at: vnow - T0,
      previousFrameNodes: before.size,
      survivorNodes: survivors,
      discarded: counters.discarded - beforeDiscarded,
      created: counters.created - beforeCreated,
    });
  }
  lastDataHost = ovBodyEl.querySelector(".perf-data");
  return r;
};

/* ═══════════ 跑剧本 ═══════════ */

async function main() {
  /* 观测起点：先重置记账，把外壳与初次绘制的成本摘出去，只量「稳态下每个 tick」 */
  T0 = vnow = Date.now();
  counters.created = 0;
  counters.discarded = 0;
  counters.writes = 0;

  /* 观测窗跑完的通知（虚拟时钟到点触发；不用真时钟空等） */
  const done = new Promise((res) => {
    windowDone = res;
  });
  setTimeout(() => {
    if (windowDone) windowDone();
  }, 20000); /* 保险：万一链条断了也不至于挂住 */

  /* 打开面板 = 真窗口里的用户动作（首轮拉数 + 开表），这一次绘制不算「每秒翻建」 */
  sandbox.openPerfPanel();
  const bootRender = await new Promise((res) => setTimeout(res, 30));
  void bootRender;
  if (process.env.PERF_CHURN_DEBUG) {
    console.log("[dbg] 首帧 vnow=" + vnow + " T0=" + T0 + " writes=" + counters.writes + " created=" + counters.created + " bridge=" + JSON.stringify(bridgeCalls));
  }
  const cold = {
    writes: counters.writes,
    created: counters.created,
    discarded: counters.discarded,
    bridge: Object.assign({}, bridgeCalls),
  };

  /* 首帧的常驻集合：面板刚画好的这批节点，稳态里本该一直在（旧口径下会被逐个换掉） */
  const firstFrame = liveSet(docRoot);
  track(ovBodyEl.querySelector(".perf-data"), ".perf-data");
  track(ovBodyEl.querySelector(".vram-slot"), ".vram-slot");
  const dataHost0 = statsOf(".perf-data").builtRef;
  const slot0 = statsOf(".vram-slot").builtRef;

  /* 重置稳态记账：从现在开始，量的是「已经开着面板的每秒」 */
  const W0 = {
    created: counters.created,
    discarded: counters.discarded,
    writes: counters.writes,
    bridge: Object.assign({}, bridgeCalls),
  };
  const coldNodes = Array.from(firstFrame);
  clockArmed = true; /* 首帧已结算：放虚拟时钟按 1s 推进 */

  /* 等观测窗口跑完（虚拟 5 秒；真实只花几十毫秒，不空等） */
  await done;
  await new Promise((res) => setTimeout(res, 30)); /* 收尾的异步落地 */

  const live = liveSet(docRoot);
  const dataStats = settle(".perf-data");
  const slotStats = settle(".vram-slot");

  const steady = {
    created: counters.created - W0.created,
    discarded: counters.discarded - W0.discarded,
    writes: counters.writes - W0.writes,
    bridge: {
      perfSample: bridgeCalls.perfSample - W0.bridge.perfSample,
      perfSystem: bridgeCalls.perfSystem - W0.bridge.perfSystem,
      vramSnapshot: bridgeCalls.vramSnapshot - W0.bridge.vramSnapshot,
    },
  };

  /* 常驻率：面板刚画好那一帧的节点，观测结束时还挂在树上的比例 */
  const survivors = coldNodes.filter((n) => live.has(n)).length;
  const dataHost = ovBodyEl.querySelector(".perf-data");
  const dataSame = !!dataHost && dataHost === dataHost0;
  const slotSame = !!ovBodyEl.querySelector(".vram-slot") && ovBodyEl.querySelector(".vram-slot") === slot0;
  const hostJson = (s) => ({
    rewrites: s.writes, /* 稳态里把宿主内容整段重写的次数 */
    firstFrameBuilds: s.coldWrites, /* 首帧绘制（不计入稳态） */
    created: s.created,
    discarded: s.discarded,
    maxCreatedPerRewrite: s.maxCreated,
    lastFrame: s.tail,
    seq: s.seq.slice(0, 12),
  });

  const res = {
    probe: "perf-panel-churn",
    file: "test/_perf-probe/perf-panel-churn.cjs",
    reads: ["renderer/app-perf.js", "renderer/app-vram.js"],
    windowMs: WINDOW_MS,
    tickMs: TICK_MS,
    shellNodes: SHELL_NODES,
    cold: cold, /* 打开面板那一次（首屏绘制）：不算入稳态 */
    steady: steady, /* ← 基线主数字：面板已开着的这 5 秒 */
    perTick: tickLog,
    resident: {
      coldFrameNodes: coldNodes.length,
      survivors: survivors,
      residentRatePct: coldNodes.length ? Math.round((survivors / coldNodes.length) * 1000) / 10 : 0,
      firstFrameDataHostIsCurrent: dataSame,
      firstFrameVramSlotIsCurrent: slotSame,
    },
    hosts: {
      ".perf-data": hostJson(dataStats),
      ".vram-slot": hostJson(slotStats),
      innerHTMLWriteCount: counters.writes,
    },
    ticks: {
      count: tickLog.length,
      everyTickDroppedWholeFrame: tickLog.every((t) => t.survivorNodes === 0),
      everyTickRewroteDataHost: dataStats.writes + (dataStats.tail ? 1 : 0) >= tickLog.length,
      everyTickRewroteVramSlot: slotStats.writes + (slotStats.tail ? 1 : 0) >= tickLog.length,
    },
  };

  fs.writeFileSync(OUT, JSON.stringify(res, null, 2), "utf8");
  console.log(JSON.stringify(res, null, 2));
  const summary = [
    "",
    "── 基线摘要（观测 " + WINDOW_MS / 1000 + "s / 每 " + TICK_MS / 1000 + "s 一跳；读数全程固定，数值一个都没变）──",
    "perfTick 次数                  : " + tickLog.length,
    ".perf-data 整段重写            : " + dataStats.writes + " 次（丢弃 " + dataStats.discarded + " / 新建 " + dataStats.created + " 个节点，单次峰值 " + dataStats.maxCreated + "）",
    ".vram-slot 整段重写            : " + slotStats.writes + " 次（丢弃 " + slotStats.discarded + " / 新建 " + slotStats.created + " 个节点，单次峰值 " + slotStats.maxCreated + "）",
    "稳态合计丢弃 / 新建节点        : " + steady.discarded + " / " + steady.created,
    "读数桥调用 sample/system/vram  : " + steady.bridge.perfSample + " / " + steady.bridge.perfSystem + " / " + steady.bridge.vramSnapshot + "（5 个 tick 只有这么几次拿到新读数）",
    "每 tick 上一帧存活节点         : " + (tickLog.map((t) => t.survivorNodes).join(", ") || "（无）"),
    "首帧常驻率                     : " + res.resident.residentRatePct + "%（" + survivors + "/" + coldNodes.length + " 个节点活过观测窗）",
    "首帧建的 .perf-data 宿主还在吗 : " + dataSame + "（内容每 tick 被整段换掉 = " + res.ticks.everyTickRewroteDataHost + "）",
    "输出 JSON                      : " + OUT,
    "",
  ].join("\n");
  console.log(summary);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error("probe failed:", (e && e.stack) || e);
    process.exit(1);
  },
);
