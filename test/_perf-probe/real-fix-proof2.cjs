/* test/_perf-probe/real-fix-proof2.cjs —— 端到端证据（真 apps-store 落盘内核 + 真应用页在**顶层**跑）
 *
 * 为什么要这样搭：应用窗口的 preload 只在**顶层文档**注入，子框架里没有 window.appHost ——
 * 所以量测必须跑在顶层。做法：
 *   ① 把真应用目录整份复制成一只临时应用（跳过 _verify / *.zip），
 *   ② 往复制出来的 index.html 尾部插一段**内联量测脚本**（应用页 CSP 允许 'unsafe-inline'），
 *   ③ store.openAppWindow(<临时应用 id>) → 真 preload-app.js + 真 apps-store 落盘内核，
 *   ④ 在 fs.writeFileSync 上数「应用数据文件真写了几次」，同时量应用侧每次 dataWrite 的往返耗时。
 *
 * 用法：electron test\_perf-probe\real-fix-proof2.cjs [appDir] [out.json]
 * 纪律：应用副本 / 数据目录 / userData 全在系统临时目录；不碰真应用、不碰 %APPDATA%。
 */
const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const APP_DIR = String(process.argv[2] || "E:\\mtnode\\apps\\dev\\minesweeper");
const OUT = String(process.argv[3] || path.join(os.tmpdir(), "mtnode-real-fix-proof2.json"));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-rfp2-"));
app.setPath("userData", path.join(TMP, "ud"));
const DATA = path.join(TMP, "data");
const APP_ID = "proof-app";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let STAGE = "boot";
const stage = (s) => {
  STAGE = s;
  try {
    fs.appendFileSync(path.join(TMP, "stage.log"), s + "\n", "utf8");
  } catch {}
};
function writeOut(o) {
  try {
    fs.writeFileSync(OUT, JSON.stringify(o, null, 2), "utf8");
  } catch (err) {
    try {
      fs.appendFileSync(path.join(TMP, "stage.log"), "write failed: " + String((err && err.stack) || err) + "\n", "utf8");
    } catch {}
  }
}

/* 计数：只数应用数据文件的真写盘（tmp 与最终都算同一发） */
const writeLog = [];
const origWriteFileSync = fs.writeFileSync;
fs.writeFileSync = function (p, ...rest) {
  try {
    const s = String(p);
    if (/apps-data[\\/]/.test(s) && /\.json(\.tmp\d+)?$/.test(s))
      writeLog.push({ at: Date.now(), file: path.basename(s), bytes: Buffer.byteLength(String(rest[0] || "")) });
  } catch {}
  return origWriteFileSync.call(fs, p, ...rest);
};

const store = require(path.join(ROOT, "apps-store.js"));
store.registerAppsIpc({
  getDataDir: () => DATA,
  getMainWin: () => null,
  t: (s) => String(s),
  authState: () => ({ loggedIn: false }),
  getAppVersion: () => "0.0.0-probe",
});
store.setRoot(path.join(TMP, "apps-root"));

/* 插进被复制出来的应用页尾部的量测脚本（内联跑，结果挂 window.__mResult） */
const INLINE = `(async () => {
  const waitFor = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (fn()) return true; } catch (e) {} await new Promise((r) => setTimeout(r, 100)); } return false; };
  try {
    /* 应用自己的初始化是异步的（桥探测 → dataRead → newGame）：等 window.MS 与无限盘面就位再量 */
    const ok = await waitFor(() => window.MS && window.MS.inf && window.MS.inf(), 20000);
    const MS = window.MS;
    if (!ok || !MS || !MS.inf()) { window.__mErr = "no MS hook" + (MS ? "（" + MS.mode() + "）" : ""); window.__mDone = true; return; }
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const stat = (a) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); const q = (p) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
      return { n: s.length, p50: +q(0.5).toFixed(2), p95: +q(0.95).toFixed(2), max: +s[s.length - 1].toFixed(2) }; };
    window.__writeMs = [];
    const raw = window.appHost.dataWrite.bind(window.appHost);
    window.appHost.dataWrite = async function (data, opts) {
      const a = performance.now();
      const r = await raw(data, opts);
      window.__writeMs.push(+(performance.now() - a).toFixed(2));
      return r;
    };
    const b = MS.inf(); let rings = 0;
    while (rings < 600 && b.cells.size <= 20000) {
      if (!MS.infGrowRectOnce(b, { x0: b.x0 - 1, y0: b.y0 - 1, x1: b.x1 + 1, y1: b.y1 + 1 })) break;
      rings++;
    }
    MS.refreshView();
    await sleep(500);
    window.__writeMs = [];
    const picks = [];
    b.cells.forEach((c) => { if (picks.length >= 60) return; if (c.rv || !MS.infVisible(b, c.x, c.y)) return; picks.push(c); });
    const ops = [];
    for (let i = 0; i < Math.min(24, picks.length); i++) {
      const a0 = performance.now();
      try { MS.handleFlag(picks[i].x, picks[i].y); } catch (e) {}
      ops.push(+(performance.now() - a0).toFixed(2));
      await sleep(60);
    }
    await sleep(2000);
    const saved = (() => { try { return JSON.stringify(MS.infSaveState ? MS.infSaveState() : {}).length; } catch (e) { return -1; } })();
    window.__mResult = { cells: b.cells.size, savedBytes: saved, ops: ops.length, opMs: stat(ops), writeMs: stat(window.__writeMs), writes: window.__writeMs.length };
  } catch (e) {
    window.__mErr = String((e && e.message) || e);
  }
  window.__mDone = true;
})()`;

function copyApp(srcDir, dstDir) {
  fs.mkdirSync(dstDir, { recursive: true });
  for (const e of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (/^_verify$/i.test(e.name)) continue; /* 验证产物（Edge 缓存等）不拷 */
    if (/\.zip$/i.test(e.name)) continue;
    const s = path.join(srcDir, e.name);
    const d = path.join(dstDir, e.name);
    if (e.isDirectory()) copyApp(s, d);
    else fs.copyFileSync(s, d);
  }
}

async function main() {
  const res = { app: APP_DIR, out: OUT, dataDir: DATA };
  stage("copyApp");
  const appDir = path.join(DATA, "apps-dev", APP_ID);
  copyApp(APP_DIR, appDir);
  const idx = path.join(appDir, "index.html");
  const html = fs.readFileSync(idx, "utf8");
  fs.writeFileSync(idx, html.replace(/<\/body>/i, `<script>${INLINE}</script></body>`), "utf8");
  /* 应用窗口走 loadFile（带不了 query）→ 用一段引导脚本把 location 换成「真·无限模式」再重载一次；
     只在第一次进页时做（sessionStorage 标记），不会转圈。 */
  const boot =
    "<script>(function(){try{" +
    'if(location.search.indexOf("mode=infinite")>=0)return;' +
    'if(sessionStorage.getItem("proofDeep")==="1")return;' +
    'sessionStorage.setItem("proofDeep","1");' +
    'location.replace(location.pathname+"?mode=infinite&fresh=1&diff=expert");' +
    "}catch(e){}})();</scr" + "ipt>";
  fs.writeFileSync(idx, fs.readFileSync(idx, "utf8").replace(/<head[^>]*>/i, (m) => m + boot), "utf8");
  fs.writeFileSync(
    path.join(appDir, "app.json"),
    JSON.stringify({ schema: 1, id: APP_ID, name: "端到端证据应用", version: "0.0.0", entry: "index.html", dev: true }, null, 2),
    "utf8",
  );
  stage("openWindow");
  res.openWindow = store.openAppWindow(APP_ID);
  const w = BrowserWindow.getAllWindows()[0];
  await sleep(3000);
  stage("waitDone");
  let done = null;
  for (let i = 0; i < 120; i++) {
    await sleep(1000);
    if (!w || w.isDestroyed()) break;
    const st = await w.webContents.executeJavaScript(
      `JSON.stringify({ done: !!window.__mDone, err: String(window.__mErr || ""), hasHost: !!(window.appHost && window.appHost.dataWrite), mode: (window.MS && window.MS.mode) ? String(window.MS.mode()) : "no-MS", href: String(location.search).slice(0,60) })`,
    );
    done = JSON.parse(st);
    if (done.err || done.done) break;
  }
  stage("collect");
  res.frameState = done;
  if (done && done.done && !done.err) {
    res.measure = await w.webContents.executeJavaScript(`JSON.stringify(window.__mResult)`).then((s) => JSON.parse(s));
  } else {
    res.measure = { err: (done && done.err) || "量测未完成" };
  }
  res.diskWrites = writeLog.length;
  res.diskWriteBytes = writeLog.reduce((a, b) => a + b.bytes, 0);
  res.diskWriteSample = writeLog.slice(0, 6);
  writeOut(res);
  stage("done");
  app.exit(0);
}

app.whenReady().then(() => {
  const guard = setTimeout(() => {
    writeOut({ error: "超时（150s）未完成", stage: STAGE, diskWrites: writeLog.length });
    app.exit(3);
  }, 150000);
  main()
    .then(() => clearTimeout(guard))
    .catch((err) => {
      clearTimeout(guard);
      writeOut({ error: String((err && err.message) || err), stage: STAGE });
      app.exit(1);
    });
});
