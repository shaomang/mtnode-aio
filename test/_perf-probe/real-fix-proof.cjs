/* test/_perf-probe/real-fix-proof.cjs —— 端到端证据：真 apps-store 落盘内核 + 某个真应用页
 *
 * 目的：不靠桩，直接拿**仓库里真的 apps-store.js**（registerAppsIpc / openAppWindow / 真 dataWrite）
 * 开一只真应用窗口，量「应用连点 N 次」时：
 *   · 应用侧每次 dataWrite 的往返耗时
 *   · 主进程**真写盘次数**（在 fs.writeFileSync 上计数，只数 data.json 那一路）
 * 同一脚本跑两轮：合并写关掉（老口径：改常量 DATA_WRITE_COALESCE_MS=0 的老行为没法回退，
 * 所以对照轮直接用「每个 dataWrite 都立刻落盘」的等价实现）—— 这里只跑**当前代码**这一轮，
 * 对照轮用 test/_perf-probe/coalesce-gain.cjs 的两口径表。
 *
 * 用法：electron test\_perf-probe\real-fix-proof.cjs [appDir] [out.json]
 * 纪律：数据目录 / userData 全在系统临时目录。
 */
const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const APP_DIR = String(process.argv[2] || "E:\\mtnode\\apps\\dev\\minesweeper");
const OUT = String(process.argv[3] || path.join(os.tmpdir(), "mtnode-real-fix-proof.json"));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-rfp-"));
app.setPath("userData", path.join(TMP, "ud"));
const DATA = path.join(TMP, "data");
const fileUrl = (p) => "file:///" + String(p).replace(/\\/g, "/");
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

/* 计数：只数应用数据文件的写入（tmp 与最终都算同一发） */
const writeLog = [];
const origWriteFileSync = fs.writeFileSync;
fs.writeFileSync = function (p, ...rest) {
  try {
    const s = String(p);
    if (/apps-data[\\/]/.test(s) && /\.json(\.tmp\d+)?$/.test(s)) writeLog.push({ at: Date.now(), file: path.basename(s), bytes: Buffer.byteLength(String(rest[0] || "")) });
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
const APP_ID = "proof-app";

const MEASURE = `(async () => {
  const MS = window.MS;
  if (!MS || !MS.inf()) return { err: "no hook" };
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
  while (rings < 600 && b.cells.size <= 20000) { if (!MS.infGrowRectOnce(b, { x0: b.x0 - 1, y0: b.y0 - 1, x1: b.x1 + 1, y1: b.y1 + 1 })) break; rings++; }
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
  return { cells: b.cells.size, savedBytes: saved, ops: ops.length, opMs: stat(ops), writeMs: stat(window.__writeMs), writes: window.__writeMs.length };
})()`;

async function main() {
  const res = { app: APP_DIR, out: OUT, dataDir: DATA };
  STAGE = "start";
  /* 临时应用：wrapper 页把**真应用页**装进 iframe（外层只计时驱动）。
     不走 createApp（它会按模板覆盖 index.html），直接按项目根布局摆好目录与清单。 */
  const tplDir = path.join(__dirname, "proof-app-template");
  const appDir = path.join(DATA, "apps-dev", APP_ID);
  fs.mkdirSync(appDir, { recursive: true });
  fs.copyFileSync(path.join(tplDir, "app.json"), path.join(appDir, "app.json"));
  const gameUrl = fileUrl(path.join(APP_DIR, "index.html"));
  fs.writeFileSync(
    path.join(appDir, "index.html"),
    fs.readFileSync(path.join(tplDir, "index.html"), "utf8").replace("__GAME_URL__", gameUrl),
    "utf8",
  );
  stage("openWindow");
  const opened = store.openAppWindow(APP_ID);
  res.openWindow = opened;
  await sleep(3000);
  /* 此刻只有应用窗口（本脚本不开别的窗） */
  const w = BrowserWindow.getAllWindows()[0];
  res.appUrl = w ? w.webContents.getURL() : "";
  /* 等 wrapper 页把 iframe 挂上、真应用页在帧里起来 */
  let frameReady = null;
  stage("waitFrame");
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    if (!w || w.isDestroyed()) break;
    let raw = "";
    try {
      raw = await w.webContents.executeJavaScript(`(() => {
        const f = document.getElementById("game");
        if (!f) return JSON.stringify({ step: "no-frame" });
        const g = f.contentWindow;
        return JSON.stringify({ step: "frame", hasMS: !!(g && g.MS), hasHost: !!(g && g.appHost && g.appHost.dataWrite), src: String(f.src || "").slice(0, 120) });
      })()`);
    } catch (err) {
      raw = JSON.stringify({ step: "eval-fail", err: String((err && err.message) || err) });
    }
    frameReady = JSON.parse(raw);
    if (frameReady.hasMS && frameReady.hasHost) break;
  }
  res.frameReady = frameReady;
  if (!frameReady || !frameReady.hasMS) {
    fs.writeFileSync(OUT, JSON.stringify(res, null, 2), "utf8");
    console.log(JSON.stringify(res, null, 2));
    app.exit(2);
    return;
  }
  for (let i = 0; i < 30; i++) {
    const ok = await w.webContents.executeJavaScript(`(() => { const g = document.getElementById("game").contentWindow; return !!(g.MS && g.MS.inf && g.MS.inf()); })()`);
    if (ok) break;
    await sleep(500);
  }
  stage("measure");
  writeLog.length = 0;
  /* 帧里 CSP 不允许 eval、跨窗口挂函数也取不回来 —— 把量测作为**内联脚本**注进帧的文档
     （应用页 CSP 允许 'unsafe-inline'），跑完把结果挂在帧的 window.__mResult 上，父窗口轮询取。 */
  await w.webContents.executeJavaScript(`(() => {
    const g = document.getElementById("game").contentWindow;
    g.__mResult = null; g.__mErr = ""; g.__mDone = false;
    const s = g.document.createElement("script");
    s.textContent = "(async () => { try { const out = await (async () => {" + ${JSON.stringify(MEASURE.trim().replace(/^\(async \(\) => \{/, "").replace(/\}\)\(\)$/, ""))} + "})(); window.__mResult = out; } catch (e) { window.__mErr = String((e && e.message) || e); } window.__mDone = true; })()";
    g.document.body.appendChild(s);
    return 1;
  })()`);
  for (let i = 0; i < 180; i++) {
    await sleep(1000);
    const st = JSON.parse(
      await w.webContents.executeJavaScript(`(() => { const g = document.getElementById("game").contentWindow;
        return JSON.stringify({ done: !!g.__mDone, err: String(g.__mErr || "") }); })()`),
    );
    if (st.err) {
      res.measure = { err: st.err };
      break;
    }
    if (st.done) {
      res.measure = await w.webContents.executeJavaScript(`(() => document.getElementById("game").contentWindow.__mResult)()`);
      break;
    }
  }
  if (!res.measure) res.measure = { err: "量测超时（180s）" };
  res.diskWrites = writeLog.length;
  res.diskWriteBytes = writeLog.reduce((a, b) => a + b.bytes, 0);
  res.diskWriteSample = writeLog.slice(0, 6);
  /* 先把量测结果落盘再关窗：关窗会触发应用收尾（本进程的窗口生命周期也跟着走），
     结果不先写下来就会丢。 */
  writeOut(res);
  stage("closeWindow");
  const before = writeLog.length;
  try {
    const r = store.closeAppWindow(APP_ID);
    res.closeResult = r;
    stage("closed-ok");
  } catch (err) {
    res.closeError = String((err && err.stack) || err);
    stage("closed-throw");
  }
  await sleep(400);
  res.writesOnClose = writeLog.length - before;
  stage("done");
  try {
    const body = JSON.stringify(res, null, 2);
    fs.writeFileSync(OUT, body, "utf8");
    fs.appendFileSync(path.join(TMP, "stage.log"), "written bytes=" + body.length + "\n", "utf8");
  } catch (err) {
    fs.appendFileSync(path.join(TMP, "stage.log"), "write failed: " + String((err && err.stack) || err) + "\n", "utf8");
  }
  app.exit(0);
}

app.whenReady().then(() => {
  /* 兜底：45 秒还没出结果就把现场写下来退出（避免整轮挂死、看不见走到哪） */
  const guard = setTimeout(() => {
    try {
      fs.writeFileSync(OUT, JSON.stringify({ error: "超时（45s）未完成", stage: STAGE }, null, 2), "utf8");
    } catch {}
    app.exit(3);
  }, 45000);
  main()
    .then(() => clearTimeout(guard))
    .catch((err) => {
      clearTimeout(guard);
      fs.writeFileSync(OUT, JSON.stringify({ error: String((err && err.message) || err), stage: STAGE }, null, 2), "utf8");
      app.exit(1);
    });
});
