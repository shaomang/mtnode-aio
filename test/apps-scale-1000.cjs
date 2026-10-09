/* 「1000 个应用」客户端承载验证台（只读 · 不碰用户数据）：用**真源码 + 真样式**在固定视口里
   画 1000 条目录，量首屏时间 / DOM 节点数 / 内存增量 / 滚动条长度，并与「关掉窗口化渲染的
   全量渲染」同一份数据对照。用法：

     node_modules/.bin/electron test/apps-scale-1000.cjs [输出目录]

   口径与 test/apps-visual.cjs 同源：
     · 夹具数据在页面里 window.api = …（不走 contextBridge，免「object could not be cloned」）；
     · 样式与脚本都是仓库里的真文件（renderer/style.css 的 @import 链 + css/tips.css）；
     · 封面不进网络（icon/thumb 留空，走兜底底色）：这轮量的是「1000 条列表的渲染承载」，
       不是带宽；真图会把首屏时间变成网络抖动。
     · 量测跑在固定视口 1360×860 的 iframe 里；只写 [输出目录]（默认系统临时目录）。
   退出码：0 = 结论达标，1 = 有项不达标（可当回归闸门）。 */
const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const OUT = process.argv[2] || path.join(os.tmpdir(), "mtnode-apps-scale");
fs.mkdirSync(OUT, { recursive: true });
const REL = (p) => "file:///" + path.join(ROOT, p).replace(/\\/g, "/");

const APPS = 1000;
const THRESH = {
  firstPaintMs: 1500, // 应用中心首屏（进页 → 卡片画完）
  heapDeltaMB: 150, // 渲染进程 JS 堆增量
  renderedRatio: 0.2, // 首屏真进 DOM 的卡片占比上限（窗口化的存在意义）
  scrollDeltaPct: 6, // 虚拟滚动条长度与全量渲染的偏差（差太多说明漏内容 / 白条）
};

/* 目录夹具：1000 条，形状贴近真实（每应用 3 版 / 每 5 条一个同 id 多作者分支 / 每 10 条带上架截图） */
function buildCatalog(n) {
  const apps = [];
  for (let i = 0; i < n; i++) {
    const id = "app-" + i;
    const versions = [];
    for (let v = 1; v <= 3; v++) versions.push({ version: "1.0." + v, zipUrl: id + "/1.0." + v + ".zip", sha256: "" });
    const branches = [];
    if (i % 5 === 0) {
      branches.push({
        id: id,
        ownerId: "u_branch_" + i,
        owner: "author" + i,
        ownerName: "作者" + i,
        version: "1.0.2",
        latestVersion: "1.0.2",
      });
    }
    apps.push({
      id: id,
      title: "应用 " + i,
      desc: "离线可玩的小应用：四档难度、候选笔记、撤销重做、提示计时与战绩。",
      description: "离线可玩的小应用：四档难度、候选笔记、撤销重做、提示计时与战绩。",
      version: "1.0.3",
      latestVersion: "1.0.3",
      versions: versions,
      ownerId: "u_owner_" + (i % 40),
      owner: "author" + (i % 40),
      ownerName: "作者" + (i % 40),
      familyRootId: id,
      trunk: true,
      icon: "",
      thumb: "",
      shots: i % 10 === 0 ? ["shots/" + id + "/1.png", "shots/" + id + "/2.png"] : [],
      zipUrl: id + ".zip",
      url: id + ".zip",
      sha256: "",
      tags: ["工具", "效率"],
      branches: branches,
      tips: { count: i % 7, totalYuan: (i % 7) * 6 },
    });
  }
  return apps;
}

function frameHtml(catalog) {
  const CAT = {
    ok: true,
    source: "static",
    sourceBase: "https://mt-agent.com/mtnode/apps",
    url: "https://mt-agent.com/mtnode/apps/catalog.json",
    fetchedAt: Date.now(),
    apps: catalog,
  };
  return `<!doctype html>
<html><head><meta charset="utf-8">
<link rel="stylesheet" href="${REL("renderer/style.css")}">
<link rel="stylesheet" href="${REL("renderer/css/tips.css")}">
</head><body>
<div id="overlay" style="display:none"></div>
<script>window.__ERR = []; window.onerror = function (m, s, l) { window.__ERR.push(m + " @" + l); };</script>
<script>
window.I18n = { get: () => "zh", getLocale: () => "zh", t: (s) => s };
window.toast = () => {};
window.confirmDialog = async () => true;
window.MTNodeAuth = { state: () => ({ signedIn: true, user: { id: "u_demo", username: "demo", nickname: "演示账号" } }), onChange: () => () => {} };
window.openOverlay = () => {};
window.closeOverlay = () => {};
window.api = {
  appsCatalog: () => Promise.resolve(${JSON.stringify(CAT)}),
  appsList: () => Promise.resolve({ ok: true, apps: [] }),
  appsRootGet: () => Promise.resolve({ ok: true, path: "E:/apps", configured: true, exists: true }),
  appsMine: () => Promise.resolve({ ok: true, byId: {} }),
  appsVersions: () => Promise.resolve({ ok: true, version: "1.0.0" }),
  appsProgress: () => {},
  appsIsOpen: () => Promise.resolve({ ok: true, open: false }),
};
</script>
<script src="${REL("renderer/i18n.js")}"></script>
<script src="${REL("renderer/app-tips.js")}"></script>
<script src="${REL("renderer/app-apps.js")}"></script>
<script>
/* 量测：主进程先给出 __modeReady（= 这次要跑哪种模式），结论挂 window.__scale */
window.__scale = null;
window.__mode = "virtual";
window.__modeReady = new Promise(function (res) {
  window.__setMode = function (m) {
    window.__mode = m;
    res(m);
  };
});
(function () {
  const out = { apps: ${catalog.length} };
  const now = function () { return performance.now(); };
  const nodes = function () { return document.getElementById("appsHub").querySelectorAll("*").length; };
  const cards = function () { return document.querySelectorAll("#appsHub .apps-tile").length; };
  const go = async function () {
    const mode = await window.__modeReady;
    out.mode = mode;
    /* 对照组：把网格出口换成「一次性全建」（= 优化前的行为），同一份数据量一遍。
       出口只在 window.__mtnodeGridPaint 上留了注入点（见 app-apps.js 的 APPS_GRID_PAINT）。 */
    if (mode === "full") {
      window.__mtnodeGridPaint = function (body, list) {
        const grid = document.createElement("div");
        grid.className = "apps-grid";
        for (let i = 0; i < list.length; i++) grid.appendChild(window.appsTileEl(list[i], {}));
        body.appendChild(grid);
        return null;
      };
    }
    const t0 = now();
    const heap0 = performance.memory ? performance.memory.usedJSHeapSize : 0;
    const host = window.openAppsHub("apps");
    if (!host) { window.__scale = { err: "openAppsHub 返回空" }; return; }
    for (let i = 0; i < 200; i++) {
      await new Promise(function (r) { setTimeout(r, 50); });
      if (cards() > 0) break;
    }
    await new Promise(function (r) { requestAnimationFrame(function () { requestAnimationFrame(r); }); });
    out.firstPaintMs = Math.round(now() - t0);
    const heap1 = performance.memory ? performance.memory.usedJSHeapSize : 0;
    out.heapDeltaMB = +((heap1 - heap0) / 1048576).toFixed(1);
    out.domNodes = nodes();
    out.cardsInDom = cards();
    const sc = document.querySelector("#appsHub .apps-hub-body");
    out.scrollHeight = sc ? sc.scrollHeight : 0;
    out.clientHeight = sc ? sc.clientHeight : 0;
    out.gridHeight = (document.querySelector("#appsHub .apps-grid") || {}).offsetHeight || 0;
    out.vgridCards = (function () {
      const v = document.querySelector("#appsHub .apps-vgrid");
      return v ? v.querySelectorAll(".apps-tile").length : -1;
    })();
    /* 诊断：网格几何（列数 / 行高 / 容器高 / 薄片 style 高）——滚动条长度不对时看这里 */
    var gEl = document.querySelector("#appsHub .apps-grid");
    var vg = window.__appsVGrid;
    out.geom = {
      cols: vg ? vg.cols : null,
      rowH: vg ? vg.rowH : null,
      rendered: vg ? vg.rendered() : null,
      gridOffsetH: gEl ? gEl.offsetHeight : null,
      gridStyleH: gEl ? gEl.style.height : null,
      vgridH: (document.querySelector("#appsHub .apps-vgrid") || {}).offsetHeight || null
    };
    out.err = window.__ERR.slice();
    out.scrollReq = false;
    window.__dbg = ["publish"];
    window.__scale = out;
    /* 滚动验证由主进程喊（调 window.__askScroll()）：走完「分档下滚 → 每档看真进 DOM 的卡」再收尾 */
    let asked = false;
    let resolveAsk = null;
    window.__askScroll = function () {
      asked = true;
      window.__dbg.push("asked");
      if (resolveAsk) { resolveAsk(true); window.__dbg.push("resolved"); }
    };
    if (!asked) await new Promise(function (r) {
      resolveAsk = r;
      setTimeout(function () {
        r(true);
        window.__dbg.push("timeout");
      }, 30000);
      window.__dbg.push("waiting");
    });
    window.__dbg.push("after-wait:" + asked);
    if (asked) {
      try {
        out.scroll = await scrollTrip();
        out.finalIds = idsAll();
        out.finalCardsInDom = cards();
        window.__dbg.push("trip-ok:" + (out.scroll ? out.scroll.distinctSeen : "null"));
      } catch (e) {
        window.__dbg.push("trip-err:" + String((e && e.message) || e));
      }
    }
    out.scrollReqSeen = asked;
    out.dbg = window.__dbg;
    window.__scale = out;
  };
  const idsAll = function () {
    return [].slice.call(document.querySelectorAll("#appsHub .apps-tile")).map(function (c) { return c.dataset.appId; });
  };
  const scrollTrip = async function () {
    const sc = document.querySelector("#appsHub .apps-hub-body");
    const vg = window.__appsVGrid;
    const steps = [];
    const deepIds = {};
    for (let f = 0.1; f <= 0.9001; f += 0.1) {
      sc.scrollTop = Math.round((sc.scrollHeight - sc.clientHeight) * f);
      await new Promise(function (r) { requestAnimationFrame(function () { requestAnimationFrame(function () { setTimeout(r, 30); }); }); });
      const list = idsAll();
      for (let i = 0; i < list.length; i++) deepIds[list[i]] = 1;
      steps.push({ f: +f.toFixed(1), scrollTop: sc.scrollTop, cardsInDom: list.length, first: list[0] || "", last: list[list.length - 1] || "" });
    }
    /* 最后滚到底再量一屏：这一档专门验「末屏不留白（能画到目录最后一条）」 */
    sc.scrollTop = sc.scrollHeight;
    await new Promise(function (r) { requestAnimationFrame(function () { requestAnimationFrame(function () { setTimeout(r, 60); }); }); });
    const tail = idsAll();
    for (let i = 0; i < tail.length; i++) deepIds[tail[i]] = 1;
    steps.push({ f: 1, scrollTop: sc.scrollTop, cardsInDom: tail.length, first: tail[0] || "", last: tail[tail.length - 1] || "" });
    /* 一路滚下来应当见过「很多张」不同的卡（窗口化在滚动时按需补画，不是只画首屏那几张） */
    return {
      steps: steps,
      distinctSeen: Object.keys(deepIds).length,
      maxInDom: Math.max.apply(null, steps.map(function (x) { return x.cardsInDom; })),
      tailIds: tail,
      vgridCount: vg ? vg.count : null
    };
  };
  go().catch(function (e) { window.__scale = { err: String((e && e.message) || e), errs: window.__ERR }; });
})();
</script>
</body></html>`;
}

const SHELL_FILE = path.join(OUT, "scale-shell.html");
function writeShell(frameFile) {
  fs.writeFileSync(
    SHELL_FILE,
    `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:#0e1218}</style></head>
<body><iframe id="f" src="file:///${frameFile.replace(/\\/g, "/")}" style="position:fixed;left:0;top:0;width:1360px;height:860px;border:0"></iframe></body></html>`,
  );
}

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1400, height: 900, webPreferences: { offscreen: true } });
  const readScale = async () =>
    JSON.parse(
      await win.webContents.executeJavaScript(
        'JSON.stringify((document.getElementById("f") && document.getElementById("f").contentWindow.__scale) || null)',
        true,
      ),
    );
  const runOnce = async (catalog, mode, tag) => {
    const f = path.join(OUT, "scale-frame-" + tag + ".html");
    fs.writeFileSync(f, frameHtml(catalog));
    writeShell(f);
    await win.loadFile(SHELL_FILE);
    await win.webContents.executeJavaScript(
      'document.getElementById("f").contentWindow.__setMode(' + JSON.stringify(mode) + "); true",
      true,
    );
    let r = null;
    for (let i = 0; i < 40 && !r; i++) {
      await new Promise((res) => setTimeout(res, 250));
      r = await readScale();
    }
    try {
      fs.writeFileSync(path.join(OUT, "scale-" + tag + ".png"), (await win.webContents.capturePage()).toPNG());
    } catch (_) {}
    /* 首屏结论到手后喊一次滚动验证，再等它把 scroll 段补进同一份结论里 */
    console.log("[scale] " + tag + " 首屏结论:", JSON.stringify(r && { firstPaintMs: r.firstPaintMs, cardsInDom: r.cardsInDom, err: r.err }));
    if (r && r.firstPaintMs && !r.scroll) {
      const askRet = await win.webContents.executeJavaScript(
        '(function () { var w = document.getElementById("f").contentWindow; if (typeof w.__askScroll === "function") { w.__askScroll(); return "called"; } return "missing:" + Object.keys(w).slice(0, 5).join(","); })()',
        true,
      );
      console.log("[scale] " + tag + " askScroll 回执:", askRet);
      console.log("[scale] " + tag + " 已发出滚动验证请求");
      let n2 = null;
      for (let i = 0; i < 120 && !n2; i++) {
        await new Promise((res) => setTimeout(res, 250));
        const cur = await readScale();
        if (cur && cur.scroll) n2 = cur;
      }
      if (n2) r = n2;
    }
    return r || { err: "超时未拿到结论" };
  };

  const catalog = buildCatalog(APPS);
  const virtual = await runOnce(catalog, "virtual", "virtual");
  const full = await runOnce(catalog, "full", "full");

  const checks = [];
  const push = (name, cond, detail) => checks.push({ name: name, pass: !!cond, detail: detail });

  push(
    "窗口化：首屏真进 DOM 的卡片远少于总条数",
    virtual.cardsInDom > 0 && virtual.cardsInDom / APPS <= THRESH.renderedRatio,
    { cardsInDom: virtual.cardsInDom, apps: APPS, ratio: virtual.cardsInDom ? +(virtual.cardsInDom / APPS).toFixed(3) : 0, limit: THRESH.renderedRatio },
  );
  push("窗口化：首屏时间在阈值内", virtual.firstPaintMs <= THRESH.firstPaintMs, { firstPaintMs: virtual.firstPaintMs, limit: THRESH.firstPaintMs });
  push("窗口化：DOM 节点数不随 1000 条线性膨胀", virtual.domNodes > 0 && virtual.domNodes < 6000, { domNodes: virtual.domNodes, limit: 6000 });
  push("窗口化：JS 堆增量在阈值内", virtual.heapDeltaMB <= THRESH.heapDeltaMB, { heapDeltaMB: virtual.heapDeltaMB, limit: THRESH.heapDeltaMB });
  push(
    "窗口化：滚动条长度与全量渲染基本一致（不漏内容、不跳）",
    full.scrollHeight > 0 && Math.abs(virtual.scrollHeight - full.scrollHeight) / full.scrollHeight <= THRESH.scrollDeltaPct / 100,
    {
      virtual: virtual.scrollHeight,
      full: full.scrollHeight,
      deltaPct: full.scrollHeight ? +(((virtual.scrollHeight - full.scrollHeight) / full.scrollHeight) * 100).toFixed(2) : null,
      limitPct: THRESH.scrollDeltaPct,
    },
  );
  push(
    "对照组：全量渲染确实更重（证明这层优化有实际收益）",
    full.domNodes > virtual.domNodes * 5,
    { fullNodes: full.domNodes, virtualNodes: virtual.domNodes, fullCards: full.cardsInDom, virtualCards: virtual.cardsInDom },
  );
  push(
    "滚动时按需补画（一路滚下来见过的卡远多于首屏，且单帧 DOM 恒定）",
    !!virtual.scroll && virtual.scroll.distinctSeen > 100 && virtual.scroll.maxInDom <= 200,
    virtual.scroll ? { distinctSeen: virtual.scroll.distinctSeen, maxInDom: virtual.scroll.maxInDom, steps: virtual.scroll.steps.length, tail: virtual.scroll.tailIds ? virtual.scroll.tailIds.slice(-3) : [] } : null,
  );
  push(
    "滚到底不留白（最深处仍有卡片在 DOM 里，末屏能画到目录末尾）",
    !!virtual.scroll && virtual.finalCardsInDom > 0 && (virtual.scroll.tailIds || []).indexOf("app-999") >= 0,
    { finalCardsInDom: virtual.finalCardsInDom, lastIds: (virtual.scroll && virtual.scroll.tailIds ? virtual.scroll.tailIds.slice(-4) : []) },
  );
  push("无渲染期 JS 报错", !virtual.err || !virtual.err.length, { err: virtual.err || [] });

  const report = { apps: APPS, thresholds: THRESH, virtual: virtual, full: full, checks: checks };
  fs.writeFileSync(path.join(OUT, "scale-report.json"), JSON.stringify(report, null, 2));
  console.log("SCALE-REPORT", path.join(OUT, "scale-report.json"));
  console.log(
    "VIRTUAL " +
      JSON.stringify({ firstPaintMs: virtual.firstPaintMs, cardsInDom: virtual.cardsInDom, domNodes: virtual.domNodes, heapDeltaMB: virtual.heapDeltaMB, scrollHeight: virtual.scrollHeight }) +
      "\nFULL    " +
      JSON.stringify({ firstPaintMs: full.firstPaintMs, cardsInDom: full.cardsInDom, domNodes: full.domNodes, heapDeltaMB: full.heapDeltaMB, scrollHeight: full.scrollHeight }),
  );
  for (const c of checks) console.log((c.pass ? "ok    " : "FAIL  ") + c.name + " " + JSON.stringify(c.detail));
  app.exit(checks.every((c) => c.pass) ? 0 : 1);
});
