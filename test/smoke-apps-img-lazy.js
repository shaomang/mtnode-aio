"use strict";
/* 应用中心封面「界面先出、图像一次到位」懒加载的行为回归（真源码 + 可控 DOM / 网络桩）：
     node test/smoke-apps-img-lazy.js
   口径（都断言**行为**，不看正则；桩的语义对齐真 DOM 的那几处：src / dataset / classList /
   parentNode 链 / isConnected）：
     [1] 建元素只挂 1×1 透明占位：src = 占位、dataset.src = 真地址、**一张图都没取**
     [2] 进视口才取图：换上的是一开始那个真地址，并挂上 .apps-img-in（一次到位）
     [3] 没进视口的卡一张图都不请求（首屏慢的根因就在这：不再对云端域并发取图）
     [4] 同一窗口周期的一批图**一起**显形（同一轮里全部 .apps-img-in）
     [5] 元素已被拆掉（整页重绘 / 滚出窗口）→ 不换地址（图不会跑到别的卡上）
     [6] 一次落定 appAppsImgFlush()：排队中的图当场换地址并显形，不留半张半张的卡
     [7] 回退链换地址（缩略图 → 原图）同样先占位再取，不是直接挂
     [8] 取图失败 → 真地址照写（交给卡片既有的 error 回退链），不吞错
     [9] 没有 IntersectionObserver 的运行时退化成「挂上即取」（功能不缺）
     [10] 静态接线：app-apps.js 的封面走 appsImgDefer / 回退链走 appsImgLoad / 重绘前 appsImgFlush；
          index.html 在 app-apps.js **之前**加载 app-apps-img.js；css/apps.css 有 .apps-img-in
   真跑证据（人工，不在本文件）：应用中心首屏在 CDP 里只看得到一次封面显形（同一帧 N 张
   .apps-img-in）；改动前是每张图各自一次。 */
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
const ROOT = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

/* ───────────────── 最小 DOM（语义对齐真 DOM 的那几处） ───────────────── */
function makeEl(tag) {
  const el = {
    tagName: String(tag || "div").toUpperCase(),
    children: [],
    parentNode: null,
    isConnected: false,
    dataset: {},
    style: {},
    hidden: false,
    src: "",
    alt: "",
    loading: "",
    decoding: "",
    className: "",
    listeners: {},
    attrs: {},
    classList: {
      _set: new Set(),
      add(...cs) {
        for (const c of cs) this._set.add(c);
        el.className = [...this._set].join(" ");
      },
      remove(...cs) {
        for (const c of cs) this._set.delete(c);
        el.className = [...this._set].join(" ");
      },
      contains: (c) => el.classList._set.has(c),
    },
    setAttribute(k, v) {
      el.attrs[k] = String(v);
      if (k === "id") el.id = String(v);
      /* 真 DOM 里 data-* 属性与 dataset 是同一份数据（脚本读 dataset.appsImg、
         断言看属性），桩必须一样，否则量到的是假现场 */
      if (k.startsWith("data-")) {
        const camel = k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        el.dataset[camel] = String(v);
      }
    },
    getAttribute: (k) => (k in el.attrs ? el.attrs[k] : null),
    addEventListener(type, fn) {
      (el.listeners[type] = el.listeners[type] || []).push(fn);
    },
    removeEventListener() {},
    appendChild(c) {
      c.parentNode = el;
      el.children.push(c);
      c.isConnected = el.isConnected || el === ROOT_EL;
      markConnected(c);
      return c;
    },
    removeChild(c) {
      const i = el.children.indexOf(c);
      if (i >= 0) el.children.splice(i, 1);
      c.parentNode = null;
      markConnected(c);
    },
  };
  return el;
}
/* 连通性沿父子链传播（脚本判定「元素还在不在文档里」就靠它） */
function markConnected(el) {
  const on = !!el.parentNode && (el.parentNode.isConnected || el.parentNode === ROOT_EL);
  el.isConnected = on;
  for (const c of el.children) markConnected(c);
}
const ROOT_EL = makeEl("body");
ROOT_EL.isConnected = true;

/* 可控的视口观察器：测试自己决定谁进视口 */
const OBS = { targets: new Set(), cb: null };
class FakeIO {
  constructor(cb) {
    this.cb = cb;
    OBS.cb = cb;
  }
  observe(el) {
    OBS.targets.add(el);
  }
  unobserve(el) {
    OBS.targets.delete(el);
  }
  disconnect() {
    OBS.targets.clear();
  }
}
function enter(el) {
  if (OBS.cb) OBS.cb([{ target: el, isIntersecting: true }]);
}
/* 入队后取图排在下一轮微任务（元素的挂载时序），断言前先过一拍 */
const tick = () => new Promise((r) => setTimeout(r, 0));

/* 可控的取图（new Image）：load / error 由测试触发；记录每一次请求的地址 */
const NET = { probes: [], mode: "ok" };
class FakeImage {
  constructor() {
    this.onload = null;
    this.onerror = null;
    this._src = "";
    NET.probes.push(this);
  }
  set src(v) {
    this._src = String(v);
    if (NET.mode === "auto-ok") setTimeout(() => this.onload && this.onload(), 0);
    if (NET.mode === "auto-err") setTimeout(() => this.onerror && this.onerror(), 0);
  }
  get src() {
    return this._src;
  }
}
function resolveProbe(n, mode) {
  const p = NET.probes[n];
  if (!p) throw new Error("没有第 " + n + " 次取图请求");
  if (mode === "ok") p.onload && p.onload();
  else p.onerror && p.onerror();
}
const flushTimers = () => new Promise((r) => setTimeout(r, 140));

/* 每个用例一份干净的沙箱（模块自带状态：观察器 / 批次 / 队列） */
function loadModule(opts) {
  const o = opts || {};
  OBS.targets.clear();
  OBS.cb = null;
  NET.probes.length = 0;
  NET.mode = o.net || "manual";
  const win = {};
  const doc = {
    body: ROOT_EL,
    createElement: (t) => makeEl(t),
    documentElement: ROOT_EL,
  };
  const sandbox = {
    window: win,
    document: doc,
    Image: FakeImage,
    setTimeout,
    clearTimeout,
    Map,
    Set,
    WeakMap,
    console,
    URL,
  };
  if (o.io !== false) sandbox.IntersectionObserver = FakeIO;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read("renderer/app-apps-img.js"), sandbox, { filename: "app-apps-img.js" });
  return { win, doc, sandbox };
}

/* 建一张「卡」：挂在 document.body 下的容器里（= 真结构里的 .apps-cover / .apps-tile） */
function mountCard(win) {
  const card = makeEl("div");
  const img = win.appAppsImgDefer("apps-cover-img", "https://feed.test/api/apps/a/thumb");
  card.appendChild(img);
  ROOT_EL.appendChild(card);
  return img;
}

(async function main() {
  console.log("[1] 只挂透明占位，一张图都不取");
  {
    const { win } = loadModule();
    const img = mountCard(win);
    ok(String(img.src).startsWith("data:image/gif;base64,"), "占位 = 1×1 透明 data URI：" + String(img.src).slice(0, 32) + "…");
    ok(img.dataset.src === "https://feed.test/api/apps/a/thumb", "真地址记在 dataset.src 上");
    ok(img.getAttribute("data-apps-img") === "hold", "标记为 hold（未取图）");
    ok(NET.probes.length === 0, "建元素时没有发出任何取图请求");
    ok(OBS.targets.has(img), "元素已交给视口观察器（进视口才取图）");
  }

  console.log("[2] 进视口才取图；取到就一次性换上并显形");
  {
    const { win } = loadModule();
    const img = mountCard(win);
    enter(img);
    await tick();
    ok(NET.probes.length === 1, "进视口 → 恰好一次取图请求");
    ok(NET.probes[0].src === "https://feed.test/api/apps/a/thumb", "取的就是当初那个真地址");
    ok(img.dataset.appsImg === "load", "取图中（还没换地址）");
    resolveProbe(0, "ok");
    await flushTimers();
    ok(img.src === "https://feed.test/api/apps/a/thumb", "取到后换上真地址");
    ok(img.dataset.appsImg === "ready", "标记 ready");
    ok(img.classList.contains("apps-img-in"), "已显形（.apps-img-in）");
    ok(!OBS.targets.has(img), "取过图的元素不再留在观察器里");
  }

  console.log("[3] 没进视口的卡一张图都不请求");
  {
    const { win } = loadModule();
    mountCard(win);
    mountCard(win);
    mountCard(win);
    await flushTimers();
    ok(NET.probes.length === 0, "三张卡都在屏外 → 零请求（首屏不再对云端域并发取图）");
    ok(OBS.targets.size === 3, "三张卡的图都在等进视口");
  }

  console.log("[4] 同一窗口周期的一批图一起显形");
  {
    const { win } = loadModule();
    const a = mountCard(win);
    const b = mountCard(win);
    const c = mountCard(win);
    enter(a);
    enter(b);
    enter(c);
    await tick();
    ok(NET.probes.length === 3, "三张都进视口 → 三次取图");
    resolveProbe(1, "ok"); /* 故意乱序完成：b 先到 */
    resolveProbe(0, "ok");
    resolveProbe(2, "ok");
    ok(a.classList.contains("apps-img-in") === false, "批次窗口内先到的图不抢跑（还没到点）");
    await flushTimers();
    const all = [a, b, c].every((i) => i.classList.contains("apps-img-in"));
    ok(all, "三张图在同一个批次里一起显形（不是一张张蹦）");
    ok(a.src === b.src.replace(/thumb/, "thumb"), "各自换的是自己的地址（没有串图）");
  }

  console.log("[5] 元素已被拆掉 → 不换地址");
  {
    const { win } = loadModule();
    const img = mountCard(win);
    enter(img);
    await tick();
    img.parentNode.removeChild(img); /* 整页重绘 / 滚出窗口（图还在路上） */
    resolveProbe(0, "ok");
    await flushTimers();
    ok(String(img.src).startsWith("data:image/gif;base64,"), "拆掉的元素仍是占位（图不会跑到别的卡上）");
    ok(img.dataset.appsImg !== "ready", "不标记 ready");
  }

  console.log("[6] 一次落定：正在取的图当场换上；还在等进视口的图省下请求");
  {
    const { win } = loadModule();
    /* a 进了视口、正在取；b 还在等进视口（一张图都没请求）。这时整页重绘
       （appsHubPaint 先调 appAppsImgFlush）：a 必须当场到位，b 该省就省 */
    const a = mountCard(win);
    const b = mountCard(win);
    enter(a);
    await tick();
    ok(b.dataset.appsImg === "hold" && NET.probes.length === 1, "b 还没取图（在等进视口）");
    win.appAppsImgFlush(); /* 切页 / 关闭 / 整页重绘前 */
    ok(a.src === "https://feed.test/api/apps/a/thumb", "正在取的那张当场落定");
    ok(String(b.src).startsWith("data:image/gif;base64,"), "还在等视口的那张不抢着取图（懒加载保留）");
    ok(NET.probes.length === 1, "落定没有额外发起请求");
    resolveProbe(0, "ok");
    await flushTimers();
    ok(a.classList.contains("apps-img-in"), "落定的那张显形了");
  }

  console.log("[7] 回退链换地址同样先占位再取");
  {
    const { win } = loadModule();
    const img = mountCard(win);
    enter(img);
    await tick();
    resolveProbe(0, "err");
    await flushTimers();
    ok(img.dataset.appsImg === "fail", "取图失败标记 fail");
    ok(typeof win.appAppsImgDefer === "function", "回退链能拿到延迟取图模块");
    /* 卡片自己的 error 回退链（app-apps.js 的 appsImgLoad → appAppsImgAdopt）：换成原图。
       元素这时已经不在「等取图」状态，登记后当场落定 —— 仍进当前批次跟旁边那批一起显形 */
    const fallback = "https://feed.test/icons/a.jpg";
    img.dataset.appsImg = "hold";
    img.src = win.APPS_IMG_HOLD;
    win.appAppsImgAdopt(img, fallback);
    ok(img.src === fallback, "回退地址由同一套口径换（不是绕过模块直接写 src）");
    ok(img.dataset.appsImg === "ready", "回退后的图按 ready 记账");
  }

  console.log("[8] 取图失败不吞：真地址照写，交给卡片既有回退链");
  {
    const { win } = loadModule();
    const img = mountCard(win);
    enter(img);
    await tick();
    resolveProbe(0, "err");
    await flushTimers();
    ok(img.src === "https://feed.test/api/apps/a/thumb", "失败也把真地址写上（img 的 error 事件照旧触发）");
    ok(!img.classList.contains("apps-img-in"), "失败的那张不挂显形 class（回退链会接着换）");
  }

  console.log("[9] 没有 IntersectionObserver 的运行时退化成「挂上即取」");
  {
    const { win } = loadModule({ io: false, net: "auto-ok" });
    const img = mountCard(win);
    await tick();
    ok(NET.probes.length === 1, "没有观察器 → 挂上就取（功能不缺）");
    await flushTimers();
    ok(img.src === "https://feed.test/api/apps/a/thumb", "取到后正常换上");
    ok(img.classList.contains("apps-img-in"), "照样显形");
  }

  console.log("[10] 静态接线：app-apps.js / index.html / css 三处都到位");
  {
    const apps = read("renderer/app-apps.js");
    const html = read("renderer/index.html");
    const css = read("renderer/css/apps.css");
    ok(/function appsImgDefer\(/.test(apps) && /appsImgDefer\(\s*"apps-cover-img",[\s\S]{0,120}?o\.eager,\s*\)/.test(apps), "封面走 appsImgDefer");
    /* 回退链（本轮起是 appsCoverCandidatesOf 那条备选链：封面缩略图 → 另一条缩略图 → 原图 → 图标 →
       本机已装那份）每一步都走 appsImgLoad，且详情头部还会补缓存令牌。 */
    ok(
      (apps.match(/appsImgLoad\(img, /g) || []).length >= 2 && /appsImgLoad\(img, local\)/.test(apps),
      "回退链走 appsImgLoad（备选链每一步 + 本机图）",
    );
    ok(
      /function appsCoverCandidatesOf\(/.test(apps) && /function appsCoverIsShot\(/.test(apps),
      "封面备选链与「封面源是截图」判据都在（截图当封面，拉不到退图标）",
    );
    ok((apps.match(/appsImgFlush\(\);/g) || []).length >= 2, "重绘 / 拆网格前各有一次 appsImgFlush()");
    const iImg = html.indexOf('src="app-apps-img.js"');
    const iApps = html.indexOf('src="app-apps.js"');
    ok(iImg > 0 && iApps > 0 && iImg < iApps, "index.html 在 app-apps.js 之前加载 app-apps-img.js");
    ok(/\.apps-cover-img\[data-apps-img\][\s\S]*?opacity: 0/.test(css), "css：延迟取图的图先不可见（占位期间不闪）");
    ok(/\.apps-img-in[\s\S]*?animation: apps-img-in/.test(css), "css：一次淡入 .apps-img-in");
  }

  console.log("[11] 图在批次窗口之后才到齐，也要显形（批次定时器不能只挂一次）");
  {
    /* 真浏览器实测踩过：第一批的收集窗口（80ms）先到点把批次清空，图随后才到 ——
       appsImgSwap 只 add 不重挂定时器 → 图全 ready 却永远不可见。这里把“取图完成”
       人为推迟到窗口之后，钉住这一条。 */
    const { win } = loadModule();
    const img = mountCard(win);
    enter(img);
    await tick();
    await new Promise((r) => setTimeout(r, 140)); /* 先让这一批的窗口到点（批次被收走） */
    resolveProbe(0, "ok");
    await flushTimers();
    ok(img.dataset.appsImg === "ready", "迟到的那张仍记 ready");
    ok(img.classList.contains("apps-img-in"), "迟到的那张照样显形（批次定时器重新挂上）");
  }

  console.log("\n" + (fails ? "FAILED " : "PASS ") + checks + " 项检查，" + fails + " 项失败");
  process.exit(fails ? 1 : 0);
})();
