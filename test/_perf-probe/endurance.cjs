/* test/_perf-probe/endurance.cjs —— 耐久对照：两只窗口（MTNode 主窗口样的 60fps 页 + 真应用窗口）
 * 一起跑 N 分钟，每 60 秒在**应用窗口**里量一轮「一次操作的同步耗时 + 帧间隔」，
 * 看有没有「越跑越卡」的累积劣化（现场症状：开着 30+ 分钟后变卡）。
 *
 * 用法：electron test\_perf-probe\endurance.cjs [分钟] [appDir] [out.json]
 * 纪律：userData 在系统临时目录；不改应用 / 仓库任何文件。
 */
const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const MINUTES = Number(process.argv[2] || 12);
const APP_DIR = String(process.argv[3] || "E:\\mtnode\\apps\\dev\\minesweeper");
const OUT = String(process.argv[4] || path.join(os.tmpdir(), "mtnode-endurance.json"));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-endurance-"));
app.setPath("userData", path.join(TMP, "ud"));
const fileUrl = (p) => "file:///" + String(p).replace(/\\/g, "/");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PROBE = `(() => {
  if (window.__p) return "already";
  const P = { long: [] }; window.__p = P;
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) P.long.push(+e.duration.toFixed(1)); }).observe({ entryTypes: ["longtask"] }); } catch (e) {}
  window.__pReset = () => { P.long.length = 0; };
  window.__pFrames = (ms) => new Promise((res) => { const t = []; let last = performance.now(); const end = last + ms;
    const step = (now) => { t.push(+(now - last).toFixed(2)); last = now; if (now < end) requestAnimationFrame(step); else res(t); }; requestAnimationFrame(step); });
  return "ok";
})()`;

/* 每一轮：连点 60 次（不同格子），取同步耗时分布 + 之后 800ms 的帧间隔 */
const ROUND = `(async () => {
  const MS = window.MS;
  if (!MS || !MS.inf()) return { err: "no hook" };
  if (window.__pReset) window.__pReset();
  const b = MS.inf();
  const picks = [];
  b.cells.forEach((c) => { if (picks.length >= 120) return; if (c.rv || !MS.infVisible(b, c.x, c.y)) return; picks.push(c); });
  const one = [];
  for (let i = 0; i < Math.min(60, picks.length); i++) {
    const a0 = performance.now();
    try { MS.handleFlag(picks[i].x, picks[i].y); } catch (e) {}
    one.push(+(performance.now() - a0).toFixed(2));
  }
  const t = (await window.__pFrames(800)).filter((x) => x > 0).sort((x, y) => x - y);
  const st = (a) => { if (!a.length) return null; const q = (p) => a[Math.min(a.length - 1, Math.floor(a.length * p))];
    return { n: a.length, p50: +q(0.5).toFixed(2), p95: +q(0.95).toFixed(2), max: +a[a.length - 1].toFixed(2) }; };
  return { cells: b.cells.size, dom: (MS.stats() || {}).dom, op: st(one), frame: st(t), jank: t.filter((x) => x > 33).length,
    long: { n: window.__p.long.length, max: window.__p.long.length ? +Math.max(...window.__p.long).toFixed(1) : 0 } };
})()`;

function writeOut(o) {
  try {
    fs.writeFileSync(OUT, JSON.stringify(o, null, 2), "utf8");
  } catch (e) {}
}

function busyWin() {
  const html = `<!doctype html><html><body style="margin:0;background:#0d1016;overflow:hidden">
<div id="bg" style="position:absolute;left:0;top:0;width:1500px;height:940px"></div>
<script>
var bg = document.getElementById("bg"), n = 380, els = [];
for (var i = 0; i < n; i++) { var d = document.createElement("div");
  d.style.cssText = "position:absolute;width:26px;height:26px;border-radius:6px;background:#1b2b40;will-change:transform"; bg.appendChild(d); els.push(d); }
var t = 0;
function tick() { t += 0.02;
  for (var i = 0; i < n; i++) { var e = els[i];
    e.style.transform = "translate3d(" + (700 + 600 * Math.sin(t + i * 0.13)) + "px," + (400 + 380 * Math.cos(t * 1.3 + i * 0.07)) + "px,0)"; }
  requestAnimationFrame(tick); }
requestAnimationFrame(tick);
</script></body></html>`;
  const f = path.join(TMP, "busy.html");
  fs.writeFileSync(f, html, "utf8");
  const w = new BrowserWindow({ width: 1500, height: 940, show: true, backgroundColor: "#0d1016" });
  w.loadURL(fileUrl(f));
  return w;
}

async function run() {
  const res = { app: APP_DIR, minutes: MINUTES, rounds: [] };
  busyWin();
  const win = new BrowserWindow({
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
  await win.loadURL(fileUrl(path.join(APP_DIR, "index.html")) + "?mode=infinite&fresh=1&diff=expert&cb=" + Date.now());
  await win.webContents.executeJavaScript(PROBE);
  await sleep(3000);
  /* 先把盘面长到满区域量级，再开始耐久轮次（现场就是这么大的盘） */
  await win.webContents.executeJavaScript(`(() => { const b = window.MS.inf(); let r = 0;
    while (r < 600) { if (!window.MS.infGrowRectOnce(b, { x0: b.x0 - 1, y0: b.y0 - 1, x1: b.x1 + 1, y1: b.y1 + 1 })) break; r++; }
    window.MS.refreshView(); return r; })()`);
  await sleep(1000);
  const t0 = Date.now();
  for (let i = 0; i <= MINUTES; i++) {
    const r = await win.webContents.executeJavaScript(ROUND);
    const mem = await win.webContents.executeJavaScript(
      `JSON.stringify(performance.memory ? { usedMB: Math.round(performance.memory.usedJSHeapSize / 1048576), totalMB: Math.round(performance.memory.totalJSHeapSize / 1048576) } : {})`,
    );
    res.rounds.push({ at: Math.round((Date.now() - t0) / 1000) + "s", ...r, mem: JSON.parse(mem) });
    writeOut(res);
    if (i < MINUTES) await sleep(60000);
  }
  writeOut(res);
  app.exit(0);
}

app.whenReady().then(() =>
  run().catch((err) => {
    writeOut({ error: String((err && err.message) || err) });
    app.exit(1);
  }),
);
