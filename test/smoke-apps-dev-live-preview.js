"use strict";
/* 应用开发页「中栏预览实时看到开发过程」冒烟：
 *   node test/smoke-apps-dev-live-preview.js
 *
 * 本轮 bug（先拷问后确认的口径）：
 *   在 MTNode 里开发应用时，开发过程看不到在中栏预览窗里 ——
 *   ① 会话自动拉起的浏览器是一只带窗口的 Edge，屏幕上会多出一只真窗口
 *      （改成默认无窗口启动，见 dsh/gateway/browser-host.mjs 的 launchArgs / ensureBrowser，
 *        宿主侧行为由 test/smoke-browser.js 钉）；
 *   ② 中栏预览只在「会话跑完」那个边沿刷一次，开发过程中一动不动
 *      （改成跑着的时候也按 1.2s 比对内容快照，改动停下来 ~400ms 才重载）。
 *
 * 这里真跑 renderer/app-apps-dev.js（迷你 DOM + 假时钟），钉住的是看得见的行为：
 *   [1] 会话跑着的时候 tick 也去看预览（旧口径在这里直接 return）
 *   [2] 防抖：快照刚变不当场重载，改动停下来（LIVE_SETTLE_MS）才重载
 *   [3] 连写多个文件：中间态一次都不刷，只在最后停下来那一拍刷一版
 *   [4] 没变不重载；force（跑完边沿 / 工具栏「刷新预览」）无条件刷
 *   [5] 单飞：上一次比对还在飞时不再叠一发
 *   [6] LIVE_RELOAD=false = 旧口径（跑着时不查预览）
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

/* ============================ 迷你 DOM ============================ */
function mkEl(tag, cls, id) {
  const el = {
    nodeType: 1,
    tagName: String(tag || "div").toUpperCase(),
    id: String(id || ""),
    parentNode: null,
    children: [],
    dataset: {},
    hidden: false,
    textContent: "",
    title: "",
    _attrs: {},
    _cls: new Set(String(cls || "").split(/\s+/).filter(Boolean)),
  };
  el.classList = {
    add: (c) => el._cls.add(c),
    remove: (c) => el._cls.delete(c),
    contains: (c) => el._cls.has(c),
    toggle: (c, on) => {
      if (on === undefined) {
        if (el._cls.has(c)) el._cls.delete(c);
        else el._cls.add(c);
      } else if (on) el._cls.add(c);
      else el._cls.delete(c);
      return el._cls.has(c);
    },
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
  el.setAttribute = (k, v) => {
    el._attrs[String(k)] = String(v);
  };
  el.getAttribute = (k) =>
    Object.prototype.hasOwnProperty.call(el._attrs, String(k)) ? el._attrs[String(k)] : null;
  el.querySelector = () => null;
  Object.defineProperty(el, "innerHTML", {
    get: () => el.textContent || "",
    set: () => {
      for (const c of el.children.slice()) el.removeChild(c);
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

/* ============================ 沙箱 ============================ */
function build() {
  const root = mkEl("body", "", "");
  const list = mkEl("div", "agent-side-list", "appsDevSideList");
  const wrap = mkEl("div", "apps-dev-framewrap", "");
  const frame = wrap.appendChild(mkEl("iframe", "apps-dev-frame", "appsDevFrame"));
  root.appendChild(list);
  root.appendChild(wrap);

  const calls = { preview: 0 };
  /* 假时钟：只推 Date.now（防抖门槛读它）；重载本身是同步 setAttribute，不必等定时器 */
  let now = 1000000;
  /* 下一次 apps:devPreview 要回的内容快照 */
  let snap = { files: 3, bytes: 1000, mtimeMs: 111 };

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
    window: {
      api: {
        appsDevPreview: async (id) => {
          calls.preview++;
          return Object.assign(
            {
              ok: true,
              id: String(id),
              entry: "index.html",
              url: "mtnode-preview://" + encodeURIComponent(String(id)) + "/index.html",
            },
            snap,
          );
        },
        configSave: async () => {},
      },
    },
    console,
    Date: { now: () => now },
    I18n: { t: (x) => x },
    APPS_ST: { nav: "dev" },
    S: { config: {} },
    appsHubIsOpen: () => true,
    appsLocalList: () => [{ id: "app-a", name: "A", dev: true }],
    appsLocalById: () => null,
    appSessionsOf: () => [],
    renderAgentSessionSidebar: () => {},
    appsHubPaint: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
  };
  vm.createContext(sandbox);
  vm.runInContext(read("renderer/app-apps-dev.js"), sandbox, {
    filename: "renderer/app-apps-dev.js",
  });
  const get = (expr) => vm.runInContext(expr, sandbox);
  const DEVD = get("DEVD");
  DEVD.listEl = list;
  DEVD.appId = "app-a";
  DEVD.frame = frame;
  DEVD.frameWrap = wrap;
  /* 「维持状态」关掉：重载路径不往预览页发 save 等回信（那条链路本就超时兜底 700ms），
     本测试要钉的是「什么时候重载」，不是状态保持。 */
  DEVD.keepState = false;
  /* 重载次数 = iframe src 上**出现过几种**带缓存戳的值（appsDevReloadPreview 每刷一次
     都会写一个新的 _r=…；同一个值再写一遍在真实浏览器里等于「没刷新」）。 */
  const srcSeen = new Set();
  const reloads = () => {
    const src = String(frame.getAttribute("src") || "");
    if (src) srcSeen.add(src);
    return srcSeen.size;
  };
  return {
    sandbox,
    DEVD,
    get,
    calls,
    frame,
    reloads,
    src: () => String(frame.getAttribute("src") || ""),
    setSnap: (s) => {
      snap = s;
    },
    tick: (ms) => {
      now += Number(ms) || 0;
    },
  };
}
/* 真实的那一拍：appsDevTick → appsDevCheckPreview（async）→ 让微任务跑完 */
const flush = () => new Promise((r) => setImmediate(r));
async function tick(s) {
  vm.runInContext("appsDevTick()", s.sandbox);
  await flush();
  await flush();
}

(async () => {
  /* ============================ [1] 会话跑着的时候也看预览 ============================ */
  console.log("[1] 开发会话跑着时，tick 也去比对内容快照（旧口径在这里直接 return）");
  {
    const s = build();
    s.sandbox.appSessionsOf = () => [{ id: "sess-1", running: true }];
    s.sandbox.agentSessionById = () => ({ id: "sess-1", running: true, messages: [] });
    s.get("DEVD.sessionId = 'sess-1'");
    await tick(s);
    ok(s.calls.preview === 1, "会话在跑 → 这一拍真去问了预览（查询 " + s.calls.preview + " 次）");
    ok(s.get("DEVD.busy") === true, "跑着时仍标 busy（收尾边沿的语义不变）");
    ok(s.reloads() === 0, "首拍只记「变了」不立刻重载（防抖没到）");
    ok(s.get("DEVD.liveChangedAt") > 0, "记下改动时刻（等它停下来再重载）");
  }

  /* ============================ [2] 防抖 ============================ */
  console.log("\n[2] 防抖：改动停下来 LIVE_SETTLE_MS 才重载");
  {
    const s = build();
    const settle = vm.runInContext("LIVE_SETTLE_MS", s.sandbox);
    ok(settle === 400, "门槛常量 = 400ms（改这里必须同步改本测试）");
    s.sandbox.appSessionsOf = () => [{ id: "sess-1", running: true }];
    s.sandbox.agentSessionById = () => ({ id: "sess-1", running: true, messages: [] });
    s.get("DEVD.sessionId = 'sess-1'");
    await tick(s); /* 首次：没有快照 = 变了 → 记时刻，不重载 */
    ok(s.reloads() === 0, "第一拍不重载（刚知道有这一版）");
    await tick(s); /* 同一版本：没变 → 清时刻、不重载 */
    ok(s.reloads() === 0, "没变不重载");
    ok(s.get("DEVD.liveChangedAt") === 0, "没变就把防抖计时清掉");
    s.setSnap({ files: 4, bytes: 1200, mtimeMs: 222 });
    await tick(s);
    ok(s.reloads() === 0, "改动那一拍不立刻重载（免得画到写一半的页）");
    s.tick(1200); /* 下一拍：距改动已过门槛、内容不再变 */
    await tick(s);
    ok(s.reloads() === 1, "改动停下来之后才重载（重载 " + s.reloads() + " 次）");
    ok(s.src().indexOf("_r=") > 0, "重载 = 给预览 url 打一记缓存戳（_r=），url 本身不变");
  }

  /* ============================ [3] 连写多个文件 ============================ */
  console.log("\n[3] Agent 连写多个文件：只在最后停下来那一拍刷一次");
  {
    const s = build();
    s.sandbox.appSessionsOf = () => [{ id: "sess-1", running: true }];
    s.sandbox.agentSessionById = () => ({ id: "sess-1", running: true, messages: [] });
    s.get("DEVD.sessionId = 'sess-1'");
    await tick(s);
    for (let i = 1; i <= 3; i++) {
      s.setSnap({ files: 3 + i, bytes: 1000 + i, mtimeMs: 100 * i });
      s.tick(300); /* 每 300ms 又变一次：一直没「停下来」 */
      await tick(s);
    }
    ok(s.reloads() === 0, "连写期间一次都没刷（刷了 " + s.reloads() + " 次）");
    s.tick(1200); /* 真正停下来（下一拍） */
    await tick(s);
    ok(s.reloads() === 1, "停下来之后只刷一版（刷了 " + s.reloads() + " 次）");
  }

  /* ============================ [4] force 不受门槛限制 ============================ */
  console.log("\n[4] force（跑完边沿 / 工具栏「刷新预览」）无条件刷一次");
  {
    const s = build();
    /* 会话跑完那个边沿：appsDevTick 走 force=true 那一路（busy 置位过） */
    s.sandbox.appSessionsOf = () => [];
    s.sandbox.agentSessionById = () => ({ id: "sess-1", running: false, messages: [{}] });
    s.get("DEVD.sessionId = 'sess-1'");
    s.get("DEVD.busy = true");
    s.get("DEVD.msgCount = 1");
    await tick(s);
    ok(s.get("DEVD.busy") === false, "跑完的边沿把 busy 落回去");
    ok(s.reloads() === 1, "跑完那一发无条件刷（重载 " + s.reloads() + " 次）");
    /* 工具栏「刷新预览」：appsDevCheckPreview(true) 直接调（真实调用点在 app-app-flow.js） */
    vm.runInContext("appsDevCheckPreview(true)", s.sandbox);
    await flush();
    await flush();
    await flush();
    ok(s.get("DEVD.checkBusy") === false, "这一次比对真跑完了（checkBusy 已落回）");
    ok(s.reloads() === 2, "显式刷新不受 LIVE_SETTLE_MS 门槛限制（重载 " + s.reloads() + " 次）");
  }

  /* ============================ [5] 单飞 ============================ */
  console.log("\n[5] 单飞：上一次比对还在飞时不再叠一发");
  {
    const s = build();
    s.sandbox.appSessionsOf = () => [];
    s.sandbox.agentSessionById = () => null;
    ok(s.get("DEVD.checkBusy") === false, "默认不在飞");
    s.get("DEVD.checkBusy = true");
    await tick(s);
    ok(s.calls.preview === 0, "上一次还在飞 → 这一拍直接跳过（0 次预览查询）");
    /* 飞完了：把 busy 置过位（对应用户刚发过一轮 / 会话刚跑完的边沿），下一拍就会真去看 */
    s.get("DEVD.checkBusy = false");
    s.get("DEVD.busy = true");
    await tick(s);
    ok(s.calls.preview === 1, "飞完了就正常查");
  }

  /* ============================ [6] 开关可关 ============================ */
  console.log("\n[6] LIVE_RELOAD=false = 旧口径（跑着时不查预览）");
  {
    const s = build();
    s.get("DEVD.LIVE_RELOAD = false");
    s.sandbox.appSessionsOf = () => [{ id: "sess-1", running: true }];
    s.sandbox.agentSessionById = () => ({ id: "sess-1", running: true, messages: [] });
    s.get("DEVD.sessionId = 'sess-1'");
    await tick(s);
    ok(s.calls.preview === 0, "关掉之后跑着时不查预览（旧口径可逐字退回）");
  }

  console.log("\n" + (fails ? "FAILED " + fails + " / " + checks : "ALL OK " + checks));
  process.exit(fails ? 1 : 0);
})();
