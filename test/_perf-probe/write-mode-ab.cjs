/* test/_perf-probe/write-mode-ab.cjs —— 对照：**同样的应用页**，落盘那条通道「真写」vs「不写只回 ok」
 *
 * 现场症状：应用在独立窗口里每次操作卡一下，开发页预览完全顺。
 * 已知事实：预览帧那座桥在「同一应用已开在独立窗口」时是**只读**的（写类能力同步拒），
 * 一条盘都不写；独立窗口那条每次操作都会走 dataWrite（真写盘，全在主进程同步做）。
 *
 * 本脚本把这条差异**单独抽出来**量：
 *   disk 模式：宿主真写盘（JSON.stringify + writeFileSync + rename，同 apps-store 口径）
 *   stub 模式：宿主只回 {ok:true}，一个字节都不写（= 预览那条路的代价）
 * 两种模式跑的都是同一个应用页、同一个玩法入口（MS.handleFlag），量操作总耗时与写往返耗时。
 *
 * 用法：electron test\_perf-probe\write-mode-ab.cjs [appDir] [out.json]
 * 纪律：临时目录里读写；不碰 %APPDATA%，不改应用 / 仓库文件。
 */
const { app, BrowserWindow, ipcMain } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");

const APP_DIR = String(process.argv[2] || "E:\\mtnode\\apps\\dev\\minesweeper");
const OUT = String(process.argv[3] || path.join(os.tmpdir(), "mtnode-write-mode-ab.json"));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-wmab-"));
app.setPath("userData", path.join(TMP, "ud"));
const fileUrl = (p) => "file:///" + String(p).replace(/\\/g, "/");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let MODE = "disk"; /* disk | stub —— 由渲染层在加载前告诉主进程 */
const DATA_FILE = path.join(TMP, "data.json");
function writeJson(p, v) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + ".tmp" + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(v), "utf8");
  fs.renameSync(tmp, p);
}
/* 同一条通道名（apps:hostDataWrite），两种模式只差「写不写盘」 */
ipcMain.handle("apps:hostDataWrite", (e, arg) => {
  const body = JSON.stringify((arg && arg.data) || {});
  if (body.length > 2 * 1024 * 1024) return { ok: false, error: "应用数据超出上限（2MB）", code: "storage_full" };
  if (MODE === "disk") writeJson(DATA_FILE, (arg && arg.data) || {});
  return { ok: true, file: DATA_FILE, bytes: body.length };
});
ipcMain.handle("apps:hostDataRead", () => ({ ok: true, data: null, file: DATA_FILE }));

/* 以 preload-app.js 为基底，额外暴露一个「只切模式」的小口：
   真窗口那座桥的 dataWrite 会走 apps:hostDataWrite，本脚本要测的就是那条通道。 */
const PRELOAD = path.join(TMP, "preload-probe.cjs");
const PRELOAD_ERR = path.join(TMP, "preload-err.txt");
fs.writeFileSync(
  PRELOAD,
  `try {\n` +
    `  require(${JSON.stringify(path.join(__dirname, "..", "..", "preload-app.js"))});\n` +
    `} catch (e) {\n` +
    `  require("fs").writeFileSync(${JSON.stringify(PRELOAD_ERR)}, "preload-app require 失败: " + String((e && e.stack) || e), "utf8");\n` +
    `}\n`,
  "utf8",
);
console.log("[probe] preload =", PRELOAD);

const MEASURE = `(async () => {
  const MS = window.MS;
  if (!MS || !MS.inf()) return { err: "no hook" };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const stat = (a) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); const q = (p) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
    return { n: s.length, p50: +q(0.5).toFixed(2), p95: +q(0.95).toFixed(2), max: +s[s.length - 1].toFixed(2) }; };
  const b = MS.inf(); let rings = 0;
  while (rings < 600 && b.cells.size <= 40000) { if (!MS.infGrowRectOnce(b, { x0: b.x0 - 1, y0: b.y0 - 1, x1: b.x1 + 1, y1: b.y1 + 1 })) break; rings++; }
  MS.refreshView();
  await sleep(400);
  /* 包一层 dataWrite 计时 */
  window.__writeMs = [];
  if (!window.__wrapped) {
    window.__wrapped = 1;
    const raw = window.appHost.dataWrite.bind(window.appHost);
    window.appHost.dataWrite = async function (data, opts) {
      const a = performance.now();
      const r = await raw(data, opts);
      window.__writeMs.push(+(performance.now() - a).toFixed(2));
      return r;
    };
  }
  const picks = [];
  b.cells.forEach((c) => { if (picks.length >= 60) return; if (c.rv || !MS.infVisible(b, c.x, c.y)) return; picks.push(c); });
  const ops = [];
  for (let i = 0; i < Math.min(24, picks.length); i++) {
    const a0 = performance.now();
    try { MS.handleFlag(picks[i].x, picks[i].y); } catch (e) {}
    ops.push(+(performance.now() - a0).toFixed(2));
    await sleep(40);
  }
  await sleep(1500);
  const saved = (() => { try { return JSON.stringify(MS.infSaveState ? MS.infSaveState() : {}).length; } catch (e) { return -1; } })();
  return { cells: b.cells.size, savedBytes: saved, opMs: stat(ops), writeMs: stat(window.__writeMs || []), writes: (window.__writeMs || []).length };
})()`;

function writeOut(o) {
  try {
    fs.writeFileSync(OUT, JSON.stringify(o, null, 2), "utf8");
    console.log("[out] " + OUT);
  } catch (e) {
    console.log("[out FAIL] " + String((e && e.message) || e));
  }
}

async function runMode(mode) {
  MODE = mode;
  const w = new BrowserWindow({
    width: 1400,
    height: 900,
    show: true,
    backgroundColor: "#0d1016",
    webPreferences: {
      preload: PRELOAD,
      additionalArguments: ["--mtnode-app-id=minesweeper"],
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
      spellcheck: false,
    },
  });
  await w.loadURL(fileUrl(path.join(APP_DIR, "index.html")) + "?mode=infinite&fresh=1&diff=expert&cb=" + Date.now());
  await sleep(2500);
  let hasHost = false;
  try {
    hasHost = await w.webContents.executeJavaScript(`!!(window.appHost && window.appHost.dataWrite)`);
  } catch (err) {
    console.log("[mode " + mode + "] hasHost 探测失败：" + ((err && err.message) || err));
  }
  let m;
  try {
    m = hasHost ? await w.webContents.executeJavaScript(MEASURE) : { err: "no appHost" };
  } catch (err) {
    m = { err: "measure failed: " + String((err && err.message) || err) };
  }
  const bytesOnDisk = (() => {
    try {
      return fs.statSync(DATA_FILE).size;
    } catch (e) {
      return 0;
    }
  })();
  w.close();
  await sleep(300);
  try {
    fs.rmSync(DATA_FILE, { force: true });
  } catch {}
  return { mode: mode, hasHost: hasHost, bytesOnDisk: bytesOnDisk, measure: m };
}

async function run() {
  const res = { app: APP_DIR, out: OUT, cases: [] };
  res.cases.push(await runMode("disk"));
  res.cases.push(await runMode("stub"));
  writeOut(res);
  app.exit(0);
}

app.whenReady().then(() =>
  run().catch((err) => {
    writeOut({ error: String((err && err.message) || err) });
    app.exit(1);
  }),
);
