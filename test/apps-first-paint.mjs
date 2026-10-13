/* test/apps-first-paint.mjs — 应用中心「首屏」优化前后对照（只读验证台 · 真实渲染器 + 真实主进程）
 *
 *   node test/apps-first-paint.mjs [--port=0] [--apps=32] [--wait=180]
 *
 * 为什么长这样（踩过的坑，别改回去）：
 *   · 主进程那一半用**真 apps-store.js**（require("electron") 打桩）+ 临时数据目录 / 两套根，
 *     量出「完整那一趟」与「轻表」的真实耗时 —— 这些数字就是渲染层对照里用的延迟，不是拍的。
 *   · 渲染层那一半不用 Electron 离屏窗口：隐藏窗口里定时器会被降频甚至停掉（页面打开后一动不动、
 *     连结论都送不回来），量出来的首屏时间不可信。改成**本地 http 起一个验证台**，用真实浏览器
 *     （本会话的浏览器 / 任意 Chromium）打开 http://127.0.0.1:<port>/ 跑：
 *       两个 iframe 先后各跑一次真渲染器（真 renderer/app-apps.js + app-apps-img.js + 真样式，
 *       window.api 桩把上面量到的耗时接到对应通道上）——
 *         old：没有精简通道（appsCatalogSlim / appsListSlim 都不存在）→ 首帧只能等完整目录
 *         new：有精简通道 → 首帧只等「精简目录 + 轻表」，完整那一趟在首帧之后（backfill）
 *       量 openAppsHub → 卡片进 DOM 的毫秒数、那一刻的取图请求数（页面自己数 window.Image）、
 *       以及 3 秒后完整那一趟与图像是否真的补齐。
 *   · 断言在 node 这边算（页面只负责量），`GET /__reports` 把结论 + 断言一并回给页面渲染成表格
 *     —— 截图里就能看到数字与 PASS/FAIL。
 *
 * 只写临时目录（os.tmpdir）；不联网（除了本地 127.0.0.1）；退出码 0 = 全部达标。
 * 用法：`node test/apps-first-paint.mjs` 打印 URL 后在浏览器里打开；结论到齐即打印表格并退出。
 * ============================================================================ */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argOf = (name, fb) => {
  const hit = process.argv.find((a) => a.startsWith("--" + name + "="));
  return hit ? hit.split("=").slice(1).join("=") : fb;
};
const APP_COUNT = Math.max(4, Number(argOf("apps", 32)) || 32);
const FAT_COUNT = Math.max(1, Math.round(APP_COUNT / 5));
const FAT_FILES = 1000;
const FAT_ZIP_MB = 16;
const FIRST_PAINT_LIMIT = 300;
const WAIT_SEC = Number(argOf("wait", 180)) || 180;

/* ── 夹具：临时数据目录 + 两套根 + N 个应用（1/5 是「胖」应用：上千文件 + 十几 MB 包） ── */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-apps-first-paint-"));
const DATA = path.join(TMP, "data");
const DL = path.join(TMP, "apps-download");
const DEV = path.join(TMP, "apps-project");
for (const d of [DATA, DL, DEV]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(DATA, "config.json"), JSON.stringify({ apps: { installDir: DL, projectDir: DEV } }, null, 2), "utf8");
const ZIP_BUF = Buffer.alloc(FAT_ZIP_MB * 1024 * 1024, 3);
const appsMeta = [];
for (let i = 0; i < APP_COUNT; i++) {
  const fat = i < FAT_COUNT;
  const dev = i % 4 === 3;
  const id = (dev ? "devapp" : "app") + String(i).padStart(2, "0");
  const name = "应用" + i;
  const dir = path.join(dev ? DEV : DL, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "app.json"),
    JSON.stringify({ id, name, title: name, version: "1.0." + (i % 9), dev, author: "作者" + (i % 5) }),
    "utf8",
  );
  fs.writeFileSync(path.join(dir, "index.html"), "<html><body>" + name + "</body></html>", "utf8");
  fs.writeFileSync(path.join(dir, "style.css"), "body{color:#333}", "utf8");
  if (fat) {
    const sub = path.join(dir, "assets", "deep");
    fs.mkdirSync(sub, { recursive: true });
    for (let k = 0; k < FAT_FILES; k++) fs.writeFileSync(path.join(sub, "f" + k + ".txt"), "x" + k, "utf8");
    /* 没有安装账本的自建应用：zipSha256 那条路会把整包读进内存算哈希（优化前首帧必须付这笔） */
    fs.writeFileSync(path.join(dir, name + ".zip"), ZIP_BUF);
  }
  appsMeta.push({ id, title: name, version: "1.0." + (i % 9), dev, owner: "作者" + (i % 5) });
}

/* ── 真主进程：量「优化前必须等的那份活」与「轻表」 ───────────────────────── */
const electronStub = {
  app: { getAppPath: () => ROOT, getPath: () => DATA, isPackaged: false, on: () => {} },
  BrowserWindow: class {},
  ipcMain: { handle() {}, on() {}, removeHandler() {} },
  dialog: {},
  shell: {},
  screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 } }) },
  protocol: { handle() {}, registerSchemesAsPrivileged() {} },
  session: {},
  nativeImage: {},
};
const origLoad = require("module")._load;
require("module")._load = function (req) {
  if (req === "electron") return electronStub;
  return origLoad.apply(this, arguments);
};
const store = require(path.join(ROOT, "apps-store.js"));
require("module")._load = origLoad;
store.registerAppsIpc({ getDataDir: () => DATA, t: (s) => String(s == null ? "" : s) });
const timed = (fn) => {
  const t = Date.now();
  const v = fn();
  return { ms: Date.now() - t, v };
};
const fullRun = timed(() => store.listApps());
const slimCold = timed(() => store.listAppsSlim({ cache: false }));
const slimWarm = timed(() => store.listAppsSlim({}));
const detailRun = timed(() => store.appDetailSummary(fullRun.v.apps[0].id));
const MAIN = {
  apps: fullRun.v.apps.length,
  fatApps: FAT_COUNT,
  fullListMs: fullRun.ms,
  slimColdMs: slimCold.ms,
  slimCacheMs: slimWarm.ms,
  detailOneMs: detailRun.ms,
  fullListFiles: fullRun.v.apps.reduce((n, a) => n + (a.files || 0), 0),
};

/* ── 验证台 http：夹具页面 + 真渲染层源码 + 结论回收 ───────────────────────── */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64",
);
const MIME = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};
let imgHits = 0;
const reports = {};
const base = {
  apps: APP_COUNT,
  delayCatSlim: Math.max(1, slimWarm.ms),
  delayListSlim: Math.max(1, slimCold.ms),
  /* 老口径：完整目录在主进程里本来就带一次全盘 attach（见 apps-store.js 的 attachInstalled），
     所以「等完整目录」= 一次完整扫描 + 网络那段，用完整那一趟的实测毫秒数代表。 */
  delayCat: Math.max(1, fullRun.ms),
  delayList: Math.max(1, fullRun.ms),
  delayDetail: Math.max(1, detailRun.ms),
};

const specsOf = (slim, stallImg) =>
  appsMeta.map((a) => ({
    id: a.id,
    title: a.title,
    name: a.title,
    version: a.version,
    latestVersion: a.version,
    desc: "离线可玩的小应用",
    description: "离线可玩的小应用",
    tags: ["工具"],
    owner: a.owner,
    ownerName: a.owner,
    updatedAt: 1730000000000,
    icon: "/img/" + a.id + ".png" + (stallImg ? "?stall=1" : ""),
    thumb: "/img/" + a.id + ".png" + (stallImg ? "?stall=1" : ""),
    coverSource: "icon",
    installed: false,
    slim: !!slim,
    urls: {
      icon: "/img/" + a.id + ".png" + (stallImg ? "?stall=1" : ""),
      thumb: "/img/" + a.id + ".png" + (stallImg ? "?stall=1" : ""),
      zip: "",
      versions: {},
    },
    ...(slim
      ? {}
      : {
          sha256: "b".repeat(64),
          bytes: 1234,
          downloads: 3,
          shots: ["shots/1.png"],
          shotsThumb: ["shots/1.thumb.png"],
          shotsSha: [],
          versions: [
            { version: a.version, zipUrl: a.id + "/" + a.version + ".zip", sha256: "", bytes: 10 },
            { version: "1.0.0", zipUrl: a.id + "/1.0.0.zip", sha256: "", bytes: 10 },
          ],
        }),
  }));
const localFull = appsMeta.map((a) => ({
  id: a.id,
  name: a.title,
  version: a.version,
  dev: a.dev,
  kind: a.dev ? "dev" : "down",
  kindLabel: a.dev ? "开发中" : "已下载",
  listKind: a.dev ? "dev" : "down",
  author: a.owner,
  dir: (a.dev ? "/dev/" : "/down/") + a.id,
  files: 4,
  bytes: 1234,
  mtimeMs: 1730000000000,
  installedAt: 1730000000000,
  lastRunAt: 0,
  canvasExists: false,
  zipExists: false,
  coreFiles: ["index.html", "app.json"],
  detailPending: false,
  slim: false,
}));
const localSlim = localFull.map((a) =>
  Object.assign({}, a, { files: 0, bytes: 0, coreFiles: [], zipSha256: "", detailPending: true, slim: true }),
);
const SLIM_CAT = {
  ok: true,
  source: "remote",
  slim: true,
  fetchedAt: Date.now(),
  sourceUrl: "/catalog.slim.json",
  sourceBase: "",
  apps: specsOf(true, false),
};
const FULL_CAT = Object.assign({}, SLIM_CAT, { slim: false, sourceUrl: "/catalog.json", apps: specsOf(false, false) });
/* 「图像完全不返回」那一轮：封面地址带 ?stall=1，服务端挂着不回（用来证「首帧不等图像」） */
const SLIM_CAT_STALL = Object.assign({}, SLIM_CAT, { apps: specsOf(true, true) });

const runnerPage = (mode, stall) => `<!doctype html>
<html><head><meta charset="utf-8"><title>应用中心首屏 · ${mode}</title>
<link rel="stylesheet" href="/r/renderer/style.css">
<link rel="stylesheet" href="/r/renderer/css/apps.css">
<link rel="stylesheet" href="/r/renderer/css/tips.css">
<style>html,body{margin:0;background:#0e1218}</style>
</head><body>
<div id="overlay" style="display:none"></div>
<script>window.__ERR = []; window.onerror = function (m, s, l) { window.__ERR.push(m + " @" + l); };</script>
<script>
window.I18n = { get: (s) => s, getLocale: () => "zh", t: (s) => s };
window.toast = () => {};
window.confirmDialog = async () => true;
window.MTNodeAuth = { state: () => ({ signedIn: true, user: { id: "u_demo", username: "demo", nickname: "演示账号" } }), onChange: () => () => {} };
window.openOverlay = () => {};
window.closeOverlay = () => {};
window.__calls = { catSlim: 0, cat: 0, listSlim: 0, list: 0, detail: 0, isOpen: 0 };
window.__mode = ${JSON.stringify(mode)};
window.__imgReq = 0;
(function () {
  var Real = window.Image;
  window.Image = function (w, h) { window.__imgReq++; return new Real(w, h); };
  var after = function (ms, v) { return new Promise(function (r) { setTimeout(function () { r(v); }, ms); }); };
  var api = {
    appsRootGet: function () { return Promise.resolve({ ok: true, path: ${JSON.stringify(DL)}, configured: true, exists: true }); },
    appsCatalog: function () { window.__calls.cat++; return after(${base.delayCat}, ${JSON.stringify(FULL_CAT)}); },
    appsList: function () { window.__calls.list++; return after(${base.delayList}, { ok: true, apps: ${JSON.stringify(localFull)}, root: ${JSON.stringify(DL)}, configured: true, exists: true }); },
    appsDetail: function () { window.__calls.detail++; return after(${base.delayDetail}, { ok: true, app: ${JSON.stringify(localFull[0])} }); },
    appsIsOpen: function () { window.__calls.isOpen++; return Promise.resolve({ ok: true, open: false }); },
    appsVersions: function () { return Promise.resolve({ ok: true }); },
    appsProgress: function () {},
  };
  /* 精简通道只在「新口径」那一轮存在：老口径模拟改动前的桥（没有这两个方法） */
  if (window.__mode !== "old") {
    api.appsCatalogSlim = function () { window.__calls.catSlim++; return after(${base.delayCatSlim}, ${JSON.stringify(stall ? SLIM_CAT_STALL : SLIM_CAT)}); };
    api.appsListSlim = function () { window.__calls.listSlim++; return after(${base.delayListSlim}, { ok: true, apps: ${JSON.stringify(localSlim)}, root: ${JSON.stringify(DL)}, configured: true, exists: true, slim: true, fromCache: false }); };
  }
  window.api = api;
})();
</script>
<script src="/r/renderer/i18n.js"></script>
<script src="/r/renderer/app-tips.js"></script>
<script src="/r/renderer/app-apps-img.js"></script>
<script src="/r/renderer/app-apps.js"></script>
<script>
(function () {
  var tiles = function () { return document.querySelectorAll("#appsHub .apps-tile").length; };
  var send = function (o) {
    try {
      fetch("/__report", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(o) }).catch(function () {});
    } catch (e) {}
  };
  var go = function () {
    var o = { mode: window.__mode, apps: ${base.apps} };
    var t0 = performance.now();
    var host = window.openAppsHub("apps");
    if (!host) { o.err = "openAppsHub 返回空"; send(o); return Promise.resolve(o); }
    var wait = function (n) {
      if (tiles() > 0) return Promise.resolve(true);
      if (n > 2400) return Promise.resolve(false);
      return new Promise(function (r) { setTimeout(r, 16); }).then(function () { return wait(n + 1); });
    };
    return wait(0)
      .then(function () {
        /* 卡片进 DOM 的那一刻就记：首帧时间 / 卡片数 / 已经发出的取图请求数 */
        o.firstPaintMs = Math.round(performance.now() - t0);
        o.tilesAtFirst = tiles();
        o.imgAtFirst = window.__imgReq;
        o.callsAtFirst = Object.assign({}, window.__calls);
        return new Promise(function (r) { setTimeout(r, 40); });
      })
      .then(function () {
        /* 再 40ms：封面懒加载（IntersectionObserver → 取图泵）这时才开始动 —— 看它取了几个 */
        o.imgSoon = window.__imgReq;
        o.tilesSoon = tiles();
        return new Promise(function (r) { setTimeout(r, 3000); });
      })
      .then(function () {
        o.callsAfter3s = Object.assign({}, window.__calls);
        o.tilesAfter3s = tiles();
        o.imgAfter3s = window.__imgReq;
        o.err = window.__ERR.slice();
        window.__fp = o;
        send(o);
        return o;
      });
  };
  window.__fpReady = go();
})();
</script>
</body></html>`;

function checksOf() {
  const oldRun = reports.old || {};
  const newRun = reports.new || {};
  const stallRun = reports["new-stall"] || {};
  const push = (name, pass, detail) => ({ name, pass: !!pass, detail: detail });
  return [
    push("新口径：首屏（卡片进 DOM）在 300ms 内", newRun.firstPaintMs > 0 && newRun.firstPaintMs <= FIRST_PAINT_LIMIT, { firstPaintMs: newRun.firstPaintMs, limit: FIRST_PAINT_LIMIT }),
    push("新口径明显快于旧口径（同一夹具、同一台机）", newRun.firstPaintMs > 0 && oldRun.firstPaintMs > newRun.firstPaintMs, { old: oldRun.firstPaintMs, new: newRun.firstPaintMs, speedup: oldRun.firstPaintMs && newRun.firstPaintMs ? +(oldRun.firstPaintMs / newRun.firstPaintMs).toFixed(1) : null }),
    push("封面完全不返回时，首帧照旧出字（图像不在首屏关键路径上）", stallRun.firstPaintMs > 0 && stallRun.firstPaintMs <= FIRST_PAINT_LIMIT && stallRun.tilesAtFirst === newRun.tilesAtFirst, { stallFirstPaintMs: stallRun.firstPaintMs, stallTiles: stallRun.tilesAtFirst, normalTiles: newRun.tilesAtFirst }),
    push("真懒加载：首帧只取进视口那几张，不是整屏都取", newRun.imgSoon > 0 && newRun.imgSoon < newRun.tilesSoon, { imgSoon: newRun.imgSoon, tilesSoon: newRun.tilesSoon }),
    push("旧口径首帧必须等完整那一趟（对照组确实更重）", oldRun.firstPaintMs >= MAIN.fullListMs, { firstPaintMs: oldRun.firstPaintMs, fullListMs: MAIN.fullListMs }),
    push("首帧之后：完整目录 + 完整本机列表真的补齐（backfill）", !!(newRun.callsAfter3s && newRun.callsAfter3s.cat > 0 && newRun.callsAfter3s.list > 0), newRun.callsAfter3s),
    push("首帧之后：封面图才开始取（图像真的补上了）", newRun.imgAfter3s > 0, { imgAtFirst: newRun.imgAtFirst, imgSoon: newRun.imgSoon, imgAfter3s: newRun.imgAfter3s }),
    push("卡片真的画出来了（不是空态占位）", newRun.tilesAtFirst > 0 && oldRun.tilesAtFirst > 0, { old: oldRun.tilesAtFirst, new: newRun.tilesAtFirst }),
    push("三轮都无渲染期 JS 报错", (!oldRun.err || !oldRun.err.length) && (!newRun.err || !newRun.err.length) && (!stallRun.err || !stallRun.err.length), { old: oldRun.err || [], new: newRun.err || [], stall: stallRun.err || [] }),
  ];
}
const indexPage = () => `<!doctype html>
<html><head><meta charset="utf-8"><title>应用中心首屏对照 · 只读验证台</title>
<style>
 body{margin:0;background:#0e1218;color:#dfe6f0;font:13px/1.6 "Microsoft YaHei",system-ui,sans-serif}
 .wrap{padding:14px 18px}
 h1{font-size:16px;margin:0 0 8px}
 table{border-collapse:collapse;margin:6px 0 10px}
 td,th{border:1px solid #2a3444;padding:3px 10px;text-align:left;font-weight:400}
 .ok{color:#67e8a0}.bad{color:#ff8f8f}
 .frame h2{font-size:13px;margin:10px 0 4px;color:#9fb0c8}
 iframe{width:1360px;height:860px;border:1px solid #2a3444;background:#0e1218}
 .hint{color:#8fa0b8}
</style></head><body><div class="wrap">
<h1>应用中心首屏 · 优化前后对照（只读验证台）</h1>
<div id="main" class="hint">主进程实测中…</div>
<div id="tbl" class="hint">正在跑三个口径（old → new → new-stall，逐个跑；同一时刻只让一个 iframe 可见 ——
视野外的 iframe 里 IntersectionObserver 不会触发，封面懒加载就测不出来）…</div>
<div class="frame"><h2>口径一：旧（首帧等完整目录与本机扫描）</h2><iframe id="fOld" style="display:none"></iframe></div>
<div class="frame"><h2>口径二：新（首帧只出字，图像与重字段随后补）</h2><iframe id="fNew" style="display:none"></iframe></div>
<div class="frame"><h2>口径三：新 + 封面服务完全不返回（证图像不在首屏关键路径上）</h2><iframe id="fStall" style="display:none"></iframe></div>
</div>
<script>
(function () {
  var MODES = [
    { mode: "old", stall: 0, el: "fOld" },
    { mode: "new", stall: 0, el: "fNew" },
    { mode: "new-stall", stall: 1, el: "fStall" },
  ];
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var pull = function () {
    return fetch("/__reports").then(function (r) { return r.json(); }).catch(function () { return null; });
  };
  var label = function (m) { return m === "old" ? "旧" : m === "new" ? "新" : "新+封面不返回"; };
  var render = function (x) {
    document.getElementById("main").innerHTML = "<b>主进程实测</b>（同一份夹具，" + x.main.apps + " 个应用 / 其中 " + x.main.fatApps + " 个胖应用 / 共 " + x.main.fullListFiles + " 个文件）：完整那一趟 <b>" + x.main.fullListMs + "</b>ms · 轻表冷启 " + x.main.slimColdMs + "ms · 轻表命中缓存 " + x.main.slimCacheMs + "ms · 按需补一件 " + x.main.detailOneMs + "ms";
    var rows = [["口径", "首屏 ms", "首帧卡片", "首帧取图", "+40ms 取图", "3s 后 完整目录/本机列表 调用", "3s 后取图"]];
    ["old", "new", "new-stall"].forEach(function (m) {
      var r = x.reports[m];
      rows.push([label(m), r ? r.firstPaintMs : "…", r ? r.tilesAtFirst : "…", r ? r.imgAtFirst : "…", r ? r.imgSoon : "…",
        r && r.callsAfter3s ? r.callsAfter3s.cat + " / " + r.callsAfter3s.list : "…", r ? r.imgAfter3s : "…"]);
    });
    var html = "<table>" + rows.map(function (r, i) {
      return "<tr>" + r.map(function (c) { return (i ? "<td>" : "<th>") + c + (i ? "</td>" : "</th>"); }).join("") + "</tr>";
    }).join("") + "</table>";
    if (x.checks && x.checks.length) {
      html += "<table><tr><th>断言</th><th>结论</th><th>数据</th></tr>" + x.checks.map(function (c) {
        return "<tr><td>" + c.name + "</td><td class='" + (c.pass ? "ok" : "bad") + "'>" + (c.pass ? "PASS" : "FAIL") + "</td><td>" + JSON.stringify(c.detail) + "</td></tr>";
      }).join("") + "</table>";
    }
    document.getElementById("tbl").innerHTML = html;
  };
  var runMode = async function (spec) {
    var f = document.getElementById(spec.el);
    f.style.display = "block";
    f.src = "/run?mode=" + spec.mode + (spec.stall ? "&stall=1" : "");
    f.scrollIntoView({ block: "start" });
    var x = null;
    for (var i = 0; i < 400; i++) {
      await sleep(400);
      x = await pull();
      if (x && x.reports && x.reports[spec.mode]) break;
    }
    if (spec.mode !== "new") f.style.display = "none";
    return x;
  };
  (async function () {
    for (var i = 0; i < MODES.length; i++) await runMode(MODES[i]);
    var x = await pull();
    if (x) render(x);
    /* 结论到齐后停在「新口径」那一屏：截图里就是真渲染器画出来的卡片网格 */
    var fNew = document.getElementById("fNew");
    if (fNew) fNew.scrollIntoView({ block: "start" });
  })();
})();
</script>
</body></html>`;

const srv = http.createServer((req, res) => {
  const u = new URL(req.url, "http://127.0.0.1");
  const p = u.pathname;
  const send = (code, body, type) => {
    res.writeHead(code, { "content-type": type || "text/html; charset=utf-8" });
    res.end(body);
  };
  if (p === "/") return send(200, indexPage());
  if (p === "/run") {
    const modeArg = u.searchParams.get("mode");
    const mode = modeArg === "old" ? "old" : modeArg === "new-stall" ? "new-stall" : "new";
    const stall = mode === "new-stall";
    return send(200, runnerPage(mode, stall));
  }
  if (p === "/__reports") {
    const done = !!(reports.old && reports.new);
    return send(200, JSON.stringify({ main: MAIN, reports, checks: done ? checksOf() : null, imgHits }), MIME[".json"]);
  }
  if (p === "/__report" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const j = JSON.parse(body);
        if (j && j.mode) reports[j.mode] = j;
      } catch (_) {}
      res.writeHead(200, { "content-type": MIME[".json"] });
      res.end('{"ok":true}');
    });
    return;
  }
  if (p.startsWith("/img/")) {
    imgHits++;
    /* 口径三：封面服务**完全不返回**（挂着 15 秒）—— 用来证「首帧不依赖图像」：
       这种情况下卡片照样按时进 DOM、标题照样可读。 */
    if (u.searchParams.get("stall") === "1") {
      const t = setTimeout(() => {
        try {
          res.writeHead(200, { "content-type": MIME[".png"], "cache-control": "no-store" });
          res.end(PNG);
        } catch (_) {}
      }, 15000);
      req.on("close", () => clearTimeout(t));
      return;
    }
    return send(200, PNG, MIME[".png"]);
  }
  if (p.startsWith("/r/")) {
    const rel = decodeURIComponent(p.slice(3));
    const abs = path.resolve(ROOT, rel);
    /* 只放行仓库内的 renderer/** 与主题样式，防目录穿越 */
    if (!abs.startsWith(path.join(ROOT, "renderer") + path.sep) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      return send(404, "not found");
    }
    return send(200, fs.readFileSync(abs), MIME[path.extname(abs).toLowerCase()] || "application/octet-stream");
  }
  return send(404, "not found");
});

await new Promise((r) => srv.listen(Number(argOf("port", 0)) || 0, "127.0.0.1", r));
const port = srv.address().port;
console.log("[first-paint] 夹具目录：" + TMP);
console.log("[first-paint] 主进程实测：" + JSON.stringify(MAIN));
console.log("[first-paint] 请在浏览器里打开： http://127.0.0.1:" + port + "/");
console.log("[first-paint] 等两个 iframe 的结论（最多 " + WAIT_SEC + " 秒）…");

const deadline = Date.now() + WAIT_SEC * 1000;
const allIn = () => !!(reports.old && reports.new && reports["new-stall"]);
while (!allIn() && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 500));
}
const got = allIn();
console.log("OLD " + JSON.stringify(reports.old || { err: "未收到结论" }));
console.log("NEW " + JSON.stringify(reports.new || { err: "未收到结论" }));
console.log("NEW-STALL " + JSON.stringify(reports["new-stall"] || { err: "未收到结论" }));
if (!got) {
  console.log("[first-paint] 没等到三份结论：请在浏览器打开上面的 URL 跑一遍（本验证台不自己在无头环境里跑渲染层 —— 原因见文件头）");
  process.exitCode = 2;
} else {
  const checks = checksOf();
  fs.writeFileSync(
    path.join(TMP, "first-paint-report.json"),
    JSON.stringify({ main: MAIN, reports, checks }, null, 2),
  );
  console.log("FIRST-PAINT-REPORT " + path.join(TMP, "first-paint-report.json"));
  for (const c of checks) console.log((c.pass ? "ok    " : "FAIL  ") + c.name + " " + JSON.stringify(c.detail));
  process.exitCode = checks.every((c) => c.pass) ? 0 : 1;
}
srv.close();
