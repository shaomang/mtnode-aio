/* test/_perf-probe/real-like.cjs —— 尽量贴近产品现场的一组量测
 *
 * 与 one-shot2.cjs 的区别：这里让**主窗口是 MTNode 真渲染层**（renderer/index.html + preload.js），
 * 与独立应用窗口（真 preload-app.js）同进程并存 —— 现场就是这两只窗口同时在跑。
 * 于是能回答两个问题：
 *   ① 主窗口画布在跑时，应用窗口里每次操作的同步耗时 / 帧间隔有没有变化；
 *   ② 主窗口被应用窗口挡住时，它自己还在不在满速渲染（决定「两只窗口抢合成器」这条成不成立）。
 *
 * 用法：electron test\_perf-probe\real-like.cjs [appDir] [out.json]
 * 纪律：userData 落在系统临时目录（不碰 %APPDATA%\pipeline-console）；不改任何应用 / 仓库文件。
 */
const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const APP_DIR = String(process.argv[2] || "E:\\mtnode\\apps\\dev\\minesweeper");
const OUT = String(process.argv[3] || path.join(os.tmpdir(), "mtnode-real-like.json"));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-real-like-"));
app.setPath("userData", path.join(TMP, "ud"));
const fileUrl = (p) => "file:///" + String(p).replace(/\\/g, "/");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PROBE = `(() => {
  if (window.__p) return "already";
  const P = { long: [], ev: [] }; window.__p = P;
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) P.long.push(+e.duration.toFixed(1)); }).observe({ entryTypes: ["longtask"] }); } catch (e) {}
  window.__pReset = () => { P.long.length = 0; P.ev.length = 0; };
  window.__pFrames = (ms) => new Promise((res) => { const t = []; let last = performance.now(); const end = last + ms;
    const step = (now) => { t.push(+(now - last).toFixed(2)); last = now; if (now < end) requestAnimationFrame(step); else res(t); }; requestAnimationFrame(step); });
  return "ok";
})()`;

const MEASURE = `(async () => {
  const MS = window.MS;
  if (!MS) return { err: "no MS hook" };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const stat = (a) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); const q = (p) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
    return { n: s.length, p50: +q(0.5).toFixed(2), p95: +q(0.95).toFixed(2), max: +s[s.length - 1].toFixed(2), avg: +(s.reduce((x, y) => x + y, 0) / s.length).toFixed(2) }; };
  window.__pReset();
  const m0 = await window.__pFrames(1500);
  const b = MS.inf(); let rings = 0;
  while (rings < 400 && b.cells.size <= 3000) {
    if (!MS.infGrowRectOnce(b, { x0: b.x0 - 1, y0: b.y0 - 1, x1: b.x1 + 1, y1: b.y1 + 1 })) break;
    rings++;
  }
  MS.refreshView();
  await sleep(500);
  const picks = [];
  b.cells.forEach((c) => { if (picks.length >= 80) return; if (c.rv || !MS.infVisible(b, c.x, c.y)) return; picks.push(c); });
  const one = [];
  for (let i = 0; i < Math.min(40, picks.length); i++) {
    const a0 = performance.now();
    try { MS.handleFlag(picks[i].x, picks[i].y); } catch (e) {}
    one.push(+(performance.now() - a0).toFixed(2));
  }
  const frames = await window.__pFrames(1500);
  const f2 = frames.filter((x) => x > 0);
  const m0f = m0.filter((x) => x > 0);
  return { cells: b.cells.size, dom: (MS.stats() || {}).dom, oneOpMs: stat(one),
    framesIdle: stat(m0f), jankIdle: m0f.filter((x) => x > 33).length,
    framesBusy: stat(f2), jankBusy: f2.filter((x) => x > 33).length,
    long: { n: window.__p.long.length, total: +window.__p.long.reduce((a, x) => a + x, 0).toFixed(1), max: window.__p.long.length ? +Math.max(...window.__p.long).toFixed(1) : 0 } };
})()`;

function writeOut(o) {
  try {
    fs.writeFileSync(OUT, JSON.stringify(o, null, 2), "utf8");
  } catch (e) {}
}

async function run() {
  const res = { app: APP_DIR, out: OUT, steps: [] };
  const idx = path.join(APP_DIR, "index.html");

  /* ① 主窗口 = MTNode 真渲染层（preload.js + renderer/index.html） */
  const main = new BrowserWindow({
    width: 1500,
    height: 940,
    show: true,
    title: "MTNode-probe-main",
    backgroundColor: "#0d1016",
    webPreferences: {
      preload: path.join(ROOT, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true,
      backgroundThrottling: false,
    },
  });
  const mainErrs = [];
  main.webContents.on("console-message", (e, level, message) => {
    if (level >= 2 && mainErrs.length < 20) mainErrs.push(String(message || "").slice(0, 300));
  });
  await main.loadFile(path.join(ROOT, "renderer", "index.html"));
  await sleep(6000);
  res.mainState = JSON.parse(
    await main.webContents.executeJavaScript(
      `JSON.stringify({ title: document.title, nodes: document.getElementsByTagName("*").length, canvas: !!document.querySelector("canvas"), body: document.body.className })`,
    ),
  );
  res.mainErrs = mainErrs;
  await main.webContents.executeJavaScript(PROBE);

  /* ② 它自己空转时的帧间隔（作为「主窗口占多少合成预算」的基线） */
  res.mainIdleFrames = await main.webContents.executeJavaScript(`window.__pFrames(1500).then((t) => {
    const a = t.filter((x) => x > 0).sort((x, y) => x - y);
    return JSON.stringify({ p50: a[Math.floor(a.length / 2)], p95: a[Math.floor(a.length * 0.95)], n: a.length, jank: a.filter((x) => x > 33).length });
  })`);

  /* ③ 独立应用窗口（真 preload-app.js）与它并存 */
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
  await win.loadURL(fileUrl(idx) + "?mode=infinite&fresh=1&diff=expert&cb=" + Date.now());
  await win.webContents.executeJavaScript(PROBE);
  await sleep(4000);
  res.appState = JSON.parse(
    await win.webContents.executeJavaScript(`JSON.stringify({ hasMS: !!window.MS, hasAppHost: !!window.appHost })`),
  );

  /* ④ 量应用窗口（主窗口在跑，且被应用窗口挡住 —— 两只都 show 时后开的在上面） */
  res.measureWhileMainBusy = await win.webContents.executeJavaScript(MEASURE);

  /* ⑤ 主窗口在这段时间里还画不画（被挡住时的实际帧率） */
  res.mainFramesWhileCovered = await main.webContents.executeJavaScript(`window.__pFrames(1500).then((t) => {
    const a = t.filter((x) => x > 0).sort((x, y) => x - y);
    return JSON.stringify({ p50: a[Math.floor(a.length / 2)], p95: a[Math.floor(a.length * 0.95)], n: a.length, jank: a.filter((x) => x > 33).length });
  })`);

  /* ⑥ 应用窗口最小化后再量一次（现场「切走之后回来还是卡」那种场景） */
  win.minimize();
  await sleep(1500);
  res.measureWhileMinimized = await win.webContents.executeJavaScript(MEASURE);
  win.restore();
  await sleep(800);

  writeOut(res);
  app.exit(0);
}

app.whenReady().then(() =>
  run().catch((err) => {
    writeOut({ error: String((err && err.message) || err) });
    app.exit(1);
  }),
);
