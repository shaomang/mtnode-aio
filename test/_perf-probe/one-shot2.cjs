/* test/_perf-probe/one-shot2.cjs —— 一次性对照量测（结果直接 fs.writeFileSync 落盘）
 *
 * 用法：
 *   electron test\_perf-probe\one-shot2.cjs window [appDir] [out.json]   # 独立应用窗口（真 preload-app.js）
 *   electron test\_perf-probe\one-shot2.cjs frame  [appDir] [out.json]   # 中栏预览 iframe（640×520 + 真源预览桥）
 *   electron test\_perf-probe\one-shot2.cjs noise  [appDir] [out.json]   # 独立应用窗口 + 另一只 60fps 主窗口跑着
 *
 * 量什么（都走应用自己给无头验证用的 window.MS.* 入口，纯同步、不 await）：
 *   · 每个玩法操作（handleFlag）的耗时分布（p50 / p95 / max）+ 连点 40 次的总同步耗时
 *   · 之后 1 秒的帧间隔分布（合成 / paint 有没有跟上）+ 长任务（>50ms）
 *   · 帧那一路另记：帧里 DOM 节点数 / 画布尺寸（「预览里元素少所以不卡」这条要能证伪）
 * 纪律：不改应用文件、不写 %APPDATA%（userData 落在系统临时目录）。
 */
const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const MODE = String(process.argv[2] || "window");
const APP_DIR = String(process.argv[3] || "E:\\mtnode\\apps\\dev\\minesweeper");
const OUT = String(process.argv[4] || path.join(os.tmpdir(), "mtnode-oneshot-" + MODE + ".json"));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-oneshot-" + MODE + "-"));
app.setPath("userData", path.join(TMP, "ud"));
const fileUrl = (p) => "file:///" + String(p).replace(/\\/g, "/");
const previewBridge = require(path.join(__dirname, "preview-bridge.js"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PROBE = `(() => {
  if (window.__p) return "already";
  const P = { long: [], ev: [] }; window.__p = P;
  P.info = { dpr: devicePixelRatio, w: innerWidth, h: innerHeight, href: location.href };
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) P.long.push(+e.duration.toFixed(1)); }).observe({ entryTypes: ["longtask"] }); } catch (e) {}
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) P.ev.push({ n: e.name, d: +e.duration.toFixed(2), delay: +Math.max(0, e.processingStart - e.startTime).toFixed(2) }); }).observe({ type: "event", durationThreshold: 0 }); } catch (e) {}
  window.__pReset = () => { P.long.length = 0; P.ev.length = 0; };
  window.__pFrames = (ms) => new Promise((res) => { const t = []; let last = performance.now(); const end = last + ms;
    const step = (now) => { t.push(+(now - last).toFixed(2)); last = now; if (now < end) requestAnimationFrame(step); else res(t); }; requestAnimationFrame(step); });
  return "ok";
})()`;

const MEASURE_BODY = `const MS = window.MS;
  if (!MS) return { err: "no MS hook" };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const stat = (a) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); const q = (p) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
    return { n: s.length, p50: +q(0.5).toFixed(2), p95: +q(0.95).toFixed(2), max: +s[s.length - 1].toFixed(2), avg: +(s.reduce((x, y) => x + y, 0) / s.length).toFixed(2) }; };
  if (window.__pReset) window.__pReset();
  if (MS.mode() !== "infinite") return { err: "不是真·无限模式（mode=" + MS.mode() + "）" };
  if (!MS.inf()) return { err: "MS.inf() 为空（未进无限模式）" };
  const g0 = performance.now();
  const b = MS.inf(); let rings = 0;
  /* 长到「满区域」量级（现场说明里的 119,680 格是常规局面）：上限由应用自己的内存闸门兜底 */
  while (rings < 600) {
    if (!MS.infGrowRectOnce(b, { x0: b.x0 - 1, y0: b.y0 - 1, x1: b.x1 + 1, y1: b.y1 + 1 })) break;
    rings++;
  }
  MS.refreshView();
  const growMs = +(performance.now() - g0).toFixed(1);
  await sleep(500);
  const picks = [];
  b.cells.forEach((c) => { if (picks.length >= 80) return; if (c.rv || !MS.infVisible(b, c.x, c.y)) return; picks.push(c); });
  const one = [];
  for (let i = 0; i < Math.min(40, picks.length); i++) {
    const a0 = performance.now();
    try { MS.handleFlag(picks[i].x, picks[i].y); } catch (e) {}
    one.push(+(performance.now() - a0).toFixed(2));
  }
  const batch0 = performance.now();
  for (let i = 0; i < Math.min(40, picks.length); i++) {
    const c = picks[Math.min(picks.length - 1, i + 1)];
    try { MS.handleFlag(c.x, c.y); } catch (e) {}
  }
  const batchMs = +(performance.now() - batch0).toFixed(1);
  const frames = await window.__pFrames(1000);
  const P = window.__p;
  const fs2 = frames.filter((x) => x > 0);
  const cv = document.querySelector("canvas");
  return { info: P.info, growMs, rings, cells: b.cells.size, dom: (MS.stats() || {}).dom,
    domNodes: document.getElementsByTagName("*").length,
    canvas: cv ? { w: cv.width, h: cv.height, cssW: cv.clientWidth, cssH: cv.clientHeight, dpr: devicePixelRatio } : null,
    oneOpMs: stat(one), batchMs, batchN: Math.min(40, picks.length),
    frameMs: stat(fs2), frameJank: fs2.filter((x) => x > 33).length,
    long: { n: P.long.length, total: +P.long.reduce((a, x) => a + x, 0).toFixed(1), max: P.long.length ? +Math.max(...P.long).toFixed(1) : 0 },
    ev: P.ev.slice().sort((a, x) => x.d - a.d).slice(0, 5) };`;

const MEASURE = `(async () => { ${MEASURE_BODY} })()`;

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
async function loadApp(win, idx) {
  await win.loadURL(fileUrl(idx) + "?mode=infinite&fresh=1&diff=expert&cb=" + Date.now());
  await win.webContents.executeJavaScript(PROBE);
  await sleep(4000);
}
/* 「另一只主窗口在跑」：60fps 的 DOM 动画（真 MTNode 主窗口那类负载），只为压合成器。 */
function busyWin() {
  const html = `<!doctype html><html><body style="margin:0;background:#0d1016;overflow:hidden">
<div id="bg" style="position:absolute;left:0;top:0;width:1500px;height:940px;background:#0d1016"></div>
<script>
var bg = document.getElementById("bg");
var n = 420, els = [];
for (var i = 0; i < n; i++) { var d = document.createElement("div");
  d.style.cssText = "position:absolute;width:26px;height:26px;border-radius:6px;background:#1b2b40;will-change:transform";
  bg.appendChild(d); els.push(d); }
var t = 0, last = performance.now(), frames = 0;
function tick(now) {
  frames++;
  if (now - last > 1000) { console.log("busy fps=" + frames); frames = 0; last = now; }
  t += 0.02;
  for (var i = 0; i < n; i++) { var e = els[i];
    e.style.transform = "translate3d(" + (700 + 600 * Math.sin(t + i * 0.13)) + "px," + (400 + 380 * Math.cos(t * 1.3 + i * 0.07)) + "px,0)"; }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
</script></body></html>`;
  const f = path.join(TMP, "busy.html");
  fs.writeFileSync(f, html, "utf8");
  const w = new BrowserWindow({ width: 1500, height: 940, show: true, backgroundColor: "#0d1016" });
  w.loadURL(fileUrl(f));
  w.webContents.on("console-message", (e, level, message) => {
    if (String(message || "").indexOf("busy fps") === 0) console.log("[busy]", message);
  });
  return w;
}

async function run() {
  const idx = path.join(APP_DIR, "index.html");
  const html = fs.readFileSync(idx, "utf8");
  const res = { mode: MODE, app: APP_DIR, out: OUT };
  if (MODE === "frame") {
    const withBridge = html.replace(
      /(<head[^>]*>)/i,
      `$1<base href="${fileUrl(APP_DIR)}/"><script>${previewBridge}</script>`,
    );
    const page = path.join(TMP, "preview.html");
    /* 量测脚本作为**内联脚本**追加在页尾（应用页 CSP 允许 'unsafe-inline'）：
       帧里不允许 eval、跨窗口挂函数也拿不回来，只有内联脚本这条路能在帧里真跑。 */
    fs.writeFileSync(
      page,
      withBridge.replace(/<\/body>/i, `<script>window.__run = (async () => { ${MEASURE_BODY} });</script></body>`),
      "utf8",
    );
    const mainFile = path.join(TMP, "dev.html");
    fs.writeFileSync(
      mainFile,
      `<!doctype html><html><body style="margin:0;background:#0d1016">
<div id="mid" style="width:640px;height:520px"><iframe id="pv" style="width:100%;height:100%;border:0"></iframe></div>
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
    await main.webContents.executeJavaScript(
      `new Promise((res) => { let n = 0; const go = () => { const f = document.getElementById("pv"); if (f) { f.src = ${JSON.stringify(fileUrl(page) + "?mode=infinite&fresh=1&diff=expert&cb=" + Date.now())}; return res(1); } if (++n > 200) return res(0); setTimeout(go, 25); }; go(); })`,
    );
    await sleep(5000);
    await main.webContents.executeJavaScript(`(() => {
      const w = document.getElementById("pv").contentWindow;
      const s = w.document.createElement("script"); s.textContent = ${JSON.stringify(PROBE)};
      w.document.body.appendChild(s); return 1; })()`);
    await sleep(300);
    res.frameState = JSON.parse(
      await main.webContents.executeJavaScript(`(() => { const w = document.getElementById("pv").contentWindow;
        return JSON.stringify({ hasMS: !!w.MS, hasBridge: !!w.__mtnodePreviewHost, hasRun: typeof w.__run === "function", href: w.location.href, scripts: w.document.scripts.length }); })()`),
    );
    const out = await main.webContents.executeJavaScript(
      `(async () => await document.getElementById("pv").contentWindow.__run())()`,
    );
    res.measure = out;
    if (out && out.err) res.err = out.err;
  } else {
    if (MODE === "noise") busyWin();
    const win = appWin();
    await loadApp(win, idx);
    res.windowState = JSON.parse(
      await win.webContents.executeJavaScript(
        `JSON.stringify({ hasMS: !!window.MS, hasAppHost: !!window.appHost, href: location.href })`,
      ),
    );
    const out = await win.webContents.executeJavaScript(MEASURE);
    res.measure = out;
    if (out && out.err) res.err = out.err;
  }
  writeOut(res);
  app.exit(0);
}

app.whenReady().then(() =>
  run().catch((err) => {
    writeOut({ mode: MODE, error: String((err && err.message) || err) });
    app.exit(1);
  }),
);
