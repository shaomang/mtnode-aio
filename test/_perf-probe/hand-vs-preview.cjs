/* test/_perf-probe/hand-vs-preview.cjs —— 「右键插旗的手感」两条宿主逐项对照（只读量测）
 *
 * 用法（都在项目根跑；结果直接 fs.writeFileSync 落盘）：
 *   electron test\_perf-probe\hand-vs-preview.cjs window  [appDir] [out.json]
 *   electron test\_perf-probe\hand-vs-preview.cjs frame   [appDir] [out.json]
 *   electron test\_perf-probe\hand-vs-preview.cjs window-nocm [appDir] [out.json]   # 对照：全局吃掉 contextmenu
 *
 * 为什么要这一版：此前的探针走的是 window.MS.handleFlag() —— **合成手势跳过了事件链**
 * （sendInputEvent / contextmenu / pointerup 全没走），所以「右键那一下」的差别量不到。
 * 这一版改成**主进程真发输入事件**（webContents.sendInputEvent），三条路同一份应用代码：
 *   · window      = 独立应用窗口（preload-app.js，真 appHost）
 *   · frame       = 中栏预览 iframe（640×520 视口 + 真源预览桥小助手）
 *   · window-nocm = 独立窗口但页面里先装一只捕获阶段 contextmenu 监听 eat（对照实验：
 *                   若这条变快，说明代价出在 contextmenu 事件链本身）
 *
 * 量什么（同一批格子、同一节奏，右键/左键交替各 30 次）：
 *   · 每一下的「发事件 → 应用侧事件回调跑完」往返 ms（sendInputEvent 自带 timestamp 回执）
 *   · 事件链耗时分布（PerformanceObserver type:event，含 contextmenu / pointerup / mousedown）
 *   · 每一下之后 1 秒内的 rAF 帧间隔（掉帧 / 长任务）
 *   · 右键那一下在页面里看到的 e.type 序列（证明 event 链真跑过）
 * 纪律：不改应用文件；userData 落系统临时目录；只读量测，不落任何用户数据。
 */
const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const MODE = String(process.argv[2] || "window");
const APP_DIR = String(process.argv[3] || "E:\\mtnode\\apps\\dev\\minesweeper");
const OUT = String(process.argv[4] || path.join(os.tmpdir(), "mtnode-hand-" + MODE + ".json"));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-hand-" + MODE + "-"));
app.setPath("userData", path.join(TMP, "ud"));
const fileUrl = (p) => "file:///" + String(p).replace(/\\/g, "/");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 装探针：只挂 PerformanceObserver（事件链 / 长任务）+ 右键那一下的 event.type 序列 */
const PROBE = `(() => {
  if (window.__h) return "already";
  const H = { ev: [], long: [], seq: [] }; window.__h = H;
  H.info = { dpr: devicePixelRatio, w: innerWidth, h: innerHeight, href: location.href, hasAppHost: !!window.appHost };
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) H.long.push(+e.duration.toFixed(1)); }).observe({ entryTypes: ["longtask"] }); } catch (e) {}
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) if (e.duration >= 0.5) H.ev.push({ n: e.name, d: +e.duration.toFixed(2), delay: +Math.max(0, e.processingStart - e.startTime).toFixed(2) }); }).observe({ type: "event", durationThreshold: 0.5 }); } catch (e) {}
  ["mousedown","mouseup","pointerdown","pointerup","contextmenu","auxclick","click"].forEach((t) => {
    window.addEventListener(t, (e) => { if (e.button === 2 || t === "contextmenu") { H.seq.push(t + ":" + Math.round(e.timeStamp)); if (H.seq.length > 24) H.seq.shift(); } }, true);
  });
  window.__hReset = () => { H.ev.length = 0; H.long.length = 0; H.seq.length = 0; };
  window.__hFrames = (ms) => new Promise((res) => { const t = []; let last = performance.now(); const end = last + ms;
    const step = (now) => { t.push(+(now - last).toFixed(2)); last = now; if (now < end) requestAnimationFrame(step); else res(t); }; requestAnimationFrame(step); });
  return "ok";
})()`;

/* 在页面里量：给出「该点哪个格子」的屏幕坐标（走应用自己的 MS 钩子取可见格） */
const PICK = `(() => {
  const MS = window.MS; if (!MS) return JSON.stringify({ err: "no MS" });
  const st = MS.stats ? MS.stats() : null;
  const stage = document.querySelector(".stage") || document.querySelector("#stage") || document.body;
  const r = stage.getBoundingClientRect();
  const b = MS.inf ? MS.inf() : null;
  if (!b) return JSON.stringify({ err: "no inf" });
  /* 直接量真实 DOM 格子的视口矩形（= sendInputEvent 认的那套坐标）；只取没翻开、没插旗的 */
  const out = [];
  const cells = document.querySelectorAll(".world .cell, .cell");
  for (const d of cells) {
    if (out.length >= 8) break;
    const q = d.getBoundingClientRect();
    if (q.width < 4 || q.height < 4) continue;
    if (q.left < 20 || q.top < 120 || q.right > innerWidth - 20 || q.bottom > innerHeight - 20) continue;
    out.push({ i: String(d.dataset.i || ""), sx: Math.round(q.left + q.width / 2), sy: Math.round(q.top + q.height / 2) });
  }
  return JSON.stringify({ stage: { x: r.left, y: r.top, w: r.width, h: r.height }, cells: out, mode: MS.mode ? MS.mode() : "", domCells: cells.length, hasCellScreen: typeof MS.cellScreen === "function" });
})()`;

const STAT = `(a) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); const q = (p) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
  return { n: s.length, p50: +q(0.5).toFixed(2), p95: +q(0.95).toFixed(2), max: +s[s.length - 1].toFixed(2), avg: +(s.reduce((x, y) => x + y, 0) / s.length).toFixed(2) }; }`;

function writeOut(obj) {
  try {
    fs.writeFileSync(OUT, JSON.stringify(obj, null, 2), "utf8");
  } catch (e) {}
}

function appWin() {
  return new BrowserWindow({
    width: 1500,
    height: 940,
    show: true,
    backgroundColor: "#0d1016",
    webPreferences: {
      preload: path.join(ROOT, "preload-app.js"),
      additionalArguments: ["--mtnode-app-id=minesweeper"],
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: false,
      webSecurity: true,
      spellcheck: false,
    },
  });
}

/* 一次真输入：mousedown + mouseup（右键 = button "right"），回执带 sendInputEvent 的流程时间 */
async function gesture(wc, x, y, right) {
  const button = right ? "right" : "left";
  const ms = right ? "right" : "left";
  const t0 = process.hrtime.bigint();
  wc.sendInputEvent({ type: "mouseDown", x: Math.round(x), y: Math.round(y), button, clickCount: 1, modifiers: [] });
  wc.sendInputEvent({ type: "mouseUp", x: Math.round(x), y: Math.round(y), button, clickCount: 1, modifiers: [] });
  const t1 = process.hrtime.bigint();
  return Number(t1 - t0) / 1e6;
}

async function measureIn(wc, PICKJSON, statSrc, label) {
  const picks = JSON.parse(PICKJSON);
  if (picks.err) return { err: picks.err, label };
  const cells = (picks.cells || []).filter((c) => c.sx != null);
  const res = { label, mode: picks.mode, hasCellScreen: picks.hasCellScreen, stage: picks.stage, cells: cells.length };
  if (!cells.length) return Object.assign(res, { err: "没有拿到可见格子的屏幕坐标（MS.cellScreen 缺失？）" });
  await wc.executeJavaScript(`window.__hReset && window.__hReset()`);
  const sendCost = [];
  const rightSend = [];
  const frames = [];
  const seqs = [];
  /* 同一格子右 / 左交替各 30 下（先右键，贴近现场：「右键标记雷」那一下） */
  for (let i = 0; i < 30; i++) {
    const c = cells[i % cells.length];
    const t0 = process.hrtime.bigint();
    const cost = await gesture(wc, c.sx, c.sy, true);
    const t1 = process.hrtime.bigint();
    rightSend.push(+(Number(t1 - t0) / 1e6).toFixed(2));
    sendCost.push(+cost.toFixed(2));
    const f = await wc.executeJavaScript(`window.__hFrames(260)`);
    frames.push(...f.map(Number));
    const sq = await wc.executeJavaScript(`JSON.stringify(window.__h.seq.slice(-6))`);
    try { seqs.push(JSON.parse(sq)); } catch (_) {}
    await sleep(120);
    const c2 = cells[(i + 1) % cells.length];
    await gesture(wc, c2.sx, c2.sy, false);
    await sleep(120);
  }
  const ev = await wc.executeJavaScript(`JSON.stringify(window.__h.ev.slice().sort((a,b)=>b.d-a.d).slice(0,12))`);
  const long = await wc.executeJavaScript(`JSON.stringify({ n: window.__h.long.length, max: window.__h.long.length ? Math.max(...window.__h.long) : 0, total: +window.__h.long.reduce((a,b)=>a+b,0).toFixed(1) })`);
  const st = await wc.executeJavaScript(`(${statSrc})(${JSON.stringify(frames)})`);
  res.sendCostMs = await eval(`(${statSrc})(${JSON.stringify(sendCost)})`);
  res.rightGestureWallMs = await eval(`(${statSrc})(${JSON.stringify(rightSend)})`);
  res.frameMs = st;
  res.frameJank33 = frames.filter((x) => x > 33).length;
  res.longtask = JSON.parse(long);
  res.topEvents = JSON.parse(ev);
  res.lastRightSeqs = seqs.slice(-4);
  return res;
}

async function run() {
  const idx = path.join(APP_DIR, "index.html");
  const res = { mode: MODE, app: APP_DIR, out: OUT };
  if (MODE === "frame") {
    const previewBridge = require(path.join(__dirname, "preview-bridge.js"));
    const html = fs.readFileSync(idx, "utf8");
    const withBridge = html.replace(
      /(<head[^>]*>)/i,
      `$1<base href="${fileUrl(APP_DIR)}/"><script>${previewBridge}</script>`,
    );
    const page = path.join(TMP, "preview.html");
    fs.writeFileSync(page, withBridge, "utf8");
    const mainFile = path.join(TMP, "dev.html");
    fs.writeFileSync(
      mainFile,
      `<!doctype html><html><body style="margin:0;background:#0d1016">
<div id="mid" style="position:fixed;inset:0"><iframe id="pv" style="width:100%;height:100%;border:0"></iframe></div>
<script>
(function () {
  var K = "__mtnodePreview";
  var frame = document.getElementById("pv");
  window.addEventListener("message", function (ev) {
    var d = ev.data || {};
    if (!d || d[K] !== 1) return;
    if (d.op === "host-ping") { try { ev.source.postMessage({ [K]: 1, op: "host-ready", appId: "minesweeper", readOnly: false }, "*"); } catch (e) {} return; }
    if (d.op === "host-call") {
      var done = function (result, ok) { try { frame.contentWindow.postMessage({ [K]: 1, op: "host-result", id: d.id, ok: ok !== false, result: result }, "*"); } catch (e) {} };
      if (d.method === "dataRead") return done({ ok: true, data: null, file: "" });
      if (d.method === "dataWrite") return done({ ok: true, bytes: 0, file: "" });
      if (d.method === "storageAll" || d.method === "storageGet") return done({ ok: true, value: null, kv: {} });
      if (d.method === "storageSet" || d.method === "storageRemove") return done({ ok: true });
      if (d.method === "account") return done({ ok: true, loggedIn: false, user: null });
      return done({ ok: false, error: "stub", code: "probe_stub" }, false);
    }
  });
})();
</script></body></html>`,
      "utf8",
    );
    const main = new BrowserWindow({ width: 1500, height: 940, show: true, webPreferences: { sandbox: false } });
    await main.loadURL(fileUrl(mainFile));
    main.webContents.focus();
    await main.webContents.executeJavaScript(
      `new Promise((res) => { const f = document.getElementById("pv"); f.src = ${JSON.stringify(fileUrl(page) + "?mode=infinite&fresh=1&diff=expert&cb=" + Date.now())}; setTimeout(() => res(1), 400); })`,
    );
    await sleep(5200);
    /* 探针注入到帧里（帧内不能 eval，只能插内联 script） */
    await main.webContents.executeJavaScript(`(() => { const w = document.getElementById("pv").contentWindow;
      const s = w.document.createElement("script"); s.textContent = ${JSON.stringify(PROBE)}; w.document.body.appendChild(s); return 1; })()`);
    await sleep(300);
    const state = JSON.parse(
      await main.webContents.executeJavaScript(`(() => { const w = document.getElementById("pv").contentWindow;
        return JSON.stringify({ hasMS: !!w.MS, hasBridge: !!w.__mtnodePreviewHost, hasH: !!w.__h, href: w.location.href }); })()`),
    );
    res.frameState = state;
    const realPick = await main.webContents.executeJavaScript(`(() => {
      const fr = document.getElementById("pv"); const w = fr.contentWindow; const MS = w.MS;
      if (!MS) return JSON.stringify({ err: "no MS" });
      const fr2 = fr.getBoundingClientRect();
      const st = w.document.querySelector(".stage") || w.document.body;
      const r = st.getBoundingClientRect();
      const cells = w.document.querySelectorAll(".world .cell, .cell");
      const out = [];
      for (const d of cells) {
        if (out.length >= 8) break;
        const q = d.getBoundingClientRect();
        if (q.width < 4 || q.height < 4) continue;
        const sx = Math.round(fr2.left + q.left + q.width / 2), sy = Math.round(fr2.top + q.top + q.height / 2);
        if (sx < 20 || sy < 120 || sx > innerWidth - 20 || sy > innerHeight - 20) continue;
        out.push({ i: String(d.dataset.i || ""), sx: sx, sy: sy });
      }
      return JSON.stringify({ stage: { x: fr2.left + r.left, y: fr2.top + r.top, w: r.width, h: r.height }, cells: out, mode: MS.mode ? MS.mode() : "", domCells: cells.length, hasCellScreen: typeof MS.cellScreen === "function" });
    })()`);
    /* 帧里的输入发到**主窗口的 webContents**（坐标 = 主窗口视口坐标，也是发输入事件那一层认的） */
    res.measure = await measureIn(main.webContents, realPick, STAT, "frame");
    writeOut(res);
    app.exit(0);
    return;
  }

  /* window / window-nocm：独立应用窗口 */
  const win = appWin();
  const url = fileUrl(idx) + "?mode=infinite&fresh=1&diff=expert&cb=" + Date.now();
  await win.loadURL(url);
  win.webContents.focus();
  if (MODE === "window-nocm") {
    await win.webContents.executeJavaScript(
      `(() => { const eat = (e) => { e.preventDefault(); e.stopPropagation(); }; window.addEventListener("contextmenu", eat, true); return "cm-eaten"; })()`,
    );
  }
  await win.webContents.executeJavaScript(PROBE);
  await sleep(4200);
  res.windowState = JSON.parse(
    await win.webContents.executeJavaScript(
      `JSON.stringify({ hasMS: !!window.MS, hasAppHost: !!window.appHost, hasH: !!window.__h, href: location.href })`,
    ),
  );
  const pick = await win.webContents.executeJavaScript(PICK);
  res.pickSummary = JSON.parse(pick);
  res.measure = await measureIn(win.webContents, pick, STAT, MODE);
  writeOut(res);
  app.exit(0);
}

app.whenReady().then(() =>
  run().catch((err) => {
    writeOut({ mode: MODE, error: String((err && err.message) || err), stack: String((err && err.stack) || "") });
    app.exit(1);
  }),
);
