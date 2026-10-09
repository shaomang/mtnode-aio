/* test/_perf-probe/disk-write-cost.cjs —— 量「应用每次操作要付的那一笔真落盘」有多贵
 *
 * 背景：应用（扫雷 / wordless）每次操作都会 store.set(整份 state) → 防抖 400ms → dataWrite。
 * 真窗口那条 dataWrite 落到 apps-store.js 的 writeDataFile：JSON.stringify + writeFileSync(tmp)
 * + renameSync，全在**主进程**同步做。预览帧那条只多一趟中继，最终走同一个内核。
 * 本脚本量三件事：
 *   ① writeJson 一发的实测耗时（不同体积）；
 *   ② 经 ipcMain.handle 走完整链路（渲染层 await invoke 的往返 + 写盘）的耗时；
 *   ③ 主进程被同步写盘占住时，另一只渲染窗口的输入 / rAF 有没有被拖住。
 *
 * 用法：electron test\_perf-probe\disk-write-cost.cjs [out.json]
 * 纪律：只写系统临时目录（不碰 %APPDATA%、不碰应用目录）。
 */
const { app, BrowserWindow, ipcMain } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");

const OUT = String(process.argv[2] || path.join(os.tmpdir(), "mtnode-disk-write.json"));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-diskw-"));
app.setPath("userData", path.join(TMP, "ud"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 与 config-providers.js 的 writeJson 逐字同口径（apps-store 的落盘内核） */
function writeJson(p, v) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + ".tmp" + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(v, null, 2), "utf8");
  fs.renameSync(tmp, p);
}

function payload(mb) {
  /* 造一份「像应用存档」的对象：数字网格 + 一点字符串，别用 Buffer（要真序列化） */
  const n = Math.round((mb * 1024 * 1024) / 12);
  const cells = new Array(n);
  for (let i = 0; i < n; i++) cells[i] = { x: i % 400, y: (i / 400) | 0, rv: i % 3 === 0, f: i % 7 === 0, v: (i % 9) - 1 };
  return { v: 1, cells: cells, savedAt: Date.now(), note: "probe" };
}

async function main() {
  const res = { tmp: TMP, out: OUT, sizes: [], ipc: null, uiUnderLoad: null };
  const target = path.join(TMP, "data.json");

  /* ① 纯主进程侧：writeJson 一发要多久 */
  for (const mb of [0.003, 0.5, 2, 8]) {
    const data = payload(mb);
    const t = [];
    for (let i = 0; i < 12; i++) {
      const a = process.hrtime.bigint();
      writeJson(target, data);
      t.push(Number(process.hrtime.bigint() - a) / 1e6);
    }
    const s = t.slice().sort((a, b) => a - b);
    res.sizes.push({ mb: mb, n: t.length, p50ms: +s[Math.floor(s.length / 2)].toFixed(2), maxMs: +s[s.length - 1].toFixed(2), bytes: fs.statSync(target).size });
  }

  /* ② 完整链路：渲染层 invoke → 主进程写盘 → 回包（真窗口那条路） */
  ipcMain.handle("probe:dataWrite", (e, arg) => {
    const body = JSON.stringify(arg && arg.data ? arg.data : {});
    if (body.length > 2 * 1024 * 1024) return { ok: false, error: "storage_full" };
    writeJson(target, arg.data);
    return { ok: true, bytes: body.length, file: target };
  });
  const win = new BrowserWindow({ width: 900, height: 700, show: false, webPreferences: { preload: path.join(__dirname, "ipc-preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: false } });
  await win.loadURL("data:text/html,<html><body>probe</body></html>");
  await win.webContents.executeJavaScript(`(() => { window.__probeFrames = (ms) => new Promise((res) => {
    const t = []; let last = performance.now(); const end = last + ms;
    const step = (now) => { t.push(+(now - last).toFixed(2)); last = now; if (now < end) requestAnimationFrame(step); else res(t); }; requestAnimationFrame(step); });
    return 1; })()`);

  res.ipc = await win.webContents.executeJavaScript(`(async () => {
    const mk = (mb) => { const n = Math.round((mb * 1048576) / 12); const cells = new Array(n);
      for (let i = 0; i < n; i++) cells[i] = { x: i % 400, y: (i / 400) | 0, rv: i % 3 === 0, f: i % 7 === 0, v: (i % 9) - 1 };
      return { v: 1, cells: cells, savedAt: Date.now() }; };
    const out = [];
    for (const mb of [0.003, 0.5, 2]) {
      const data = mk(mb);
      const t = [];
      for (let i = 0; i < 8; i++) { const a = performance.now(); await window.__ipc.invoke("probe:dataWrite", { data: data }); t.push(+(performance.now() - a).toFixed(2)); }
      const s = t.slice().sort((a, b) => a - b);
      out.push({ mb: mb, p50ms: s[Math.floor(s.length / 2)], maxMs: s[s.length - 1] });
    }
    return out;
  })()`);

  /* ③ 主进程被同步写盘占住时，这只渲染窗口的帧有没有被拖住（对照：空闲时） */
  const idle = await win.webContents.executeJavaScript(`window.__probeFrames(1000)`);
  const busy = await win.webContents.executeJavaScript(`(async () => {
    const n = Math.round((8 * 1048576) / 12); const cells = new Array(n);
    for (let i = 0; i < n; i++) cells[i] = { x: i % 400, y: (i / 400) | 0, rv: i % 3 === 0, v: (i % 9) - 1 };
    const data = { v: 1, cells: cells };
    const done = [];
    for (let i = 0; i < 6; i++) window.__ipc.invoke("probe:dataWrite", { data: data }).then(() => done.push(performance.now()));
    const t = await window.__probeFrames(1000);
    return { writes: done.length, frames: t };
  })()`);
  const st = (a) => { const s = a.filter((x) => x > 0).sort((x, y) => x - y); return { n: s.length, p50: +s[Math.floor(s.length / 2)].toFixed(2), p95: +s[Math.floor(s.length * 0.95)].toFixed(2), max: +s[s.length - 1].toFixed(2), jank: s.filter((x) => x > 33).length }; };
  res.uiUnderLoad = { idle: st(idle), busy: st(busy.frames), writesWhileMeasuring: busy.writes };

  fs.writeFileSync(OUT, JSON.stringify(res, null, 2), "utf8");
  app.exit(0);
}

app.whenReady().then(() =>
  main().catch((err) => {
    fs.writeFileSync(OUT, JSON.stringify({ error: String((err && err.message) || err) }, null, 2), "utf8");
    app.exit(1);
  }),
);
