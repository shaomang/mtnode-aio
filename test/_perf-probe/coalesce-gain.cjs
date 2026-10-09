/* test/_perf-probe/coalesce-gain.cjs —— 合并写的收益：同一份「整份 state」连写 N 次
 *
 * 现场：应用每次操作都会 store.set(整份 state) → 防抖 → dataWrite（独立窗口那条真写盘）。
 * 本脚本对同一份数据量两种落盘口径各跑一轮，量**总耗时**与**真写盘次数**：
 *   · before：一发一写（旧口径：JSON.stringify(v, null, 2) + writeFileSync + rename，逐发同步）
 *   · after ：合并写（本修复口径：紧凑序列化 + 120ms 合并窗 + 连发 20 发落一次）
 * 用法：electron test\_perf-probe\coalesce-gain.cjs [out.json]
 * 纪律：只写系统临时目录。
 */
const { app, ipcMain, BrowserWindow } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");

const OUT = String(process.argv[2] || path.join(os.tmpdir(), "mtnode-coalesce-gain.json"));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-cgain-"));
app.setPath("userData", path.join(TMP, "ud"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 旧口径：一发一写，pretty-print */
function writeJsonOld(p, v) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + ".tmp" + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(v, null, 2), "utf8");
  fs.renameSync(tmp, p);
}
/* 新口径：紧凑 + 合并窗（与 apps-store.queueDataWrite 同一套参数） */
const COALESCE_MS = 120;
const MAX_DELAY_MS = 1500;
const BURST = 20;
const pending = new Map();
let diskWritesNew = 0;
function writeJsonNew(p, v) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + ".tmp" + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(v), "utf8");
  fs.renameSync(tmp, p);
  diskWritesNew++;
}
function queueWrite(p, data) {
  const now = Date.now();
  const prev = pending.get(p);
  if (prev) {
    if (prev.burst >= BURST) {
      clearTimeout(prev.timer);
      pending.delete(p);
      writeJsonNew(p, prev.data);
    } else clearTimeout(prev.timer);
  }
  const cur = pending.get(p);
  const firstAt = cur && cur.data ? cur.firstAt : now;
  const burst = (cur && cur.burst) || 0;
  const wait = Math.min(COALESCE_MS, Math.max(0, MAX_DELAY_MS - (now - firstAt)));
  const rec = { data: data, firstAt: firstAt, burst: burst + 1, timer: null };
  rec.timer = setTimeout(() => {
    const q = pending.get(p);
    if (q !== rec) return;
    pending.delete(p);
    writeJsonNew(p, rec.data);
  }, wait);
  pending.set(p, rec);
}

ipcMain.handle("probe:old", (e, arg) => {
  writeJsonOld(path.join(TMP, "old.json"), arg.data);
  return { ok: true };
});
ipcMain.handle("probe:new", (e, arg) => {
  queueWrite(path.join(TMP, "new.json"), arg.data);
  return { ok: true };
});

function payload(mb) {
  const n = Math.round((mb * 1048576) / 12);
  const cells = new Array(n);
  for (let i = 0; i < n; i++) cells[i] = { x: i % 400, y: (i / 400) | 0, rv: i % 3 === 0, f: i % 7 === 0, v: (i % 9) - 1 };
  return { v: 1, cells: cells, savedAt: Date.now() };
}

const PRELOAD = path.join(TMP, "pre.cjs");
fs.writeFileSync(
  PRELOAD,
  `const { contextBridge, ipcRenderer } = require("electron");\n` +
    `contextBridge.exposeInMainWorld("__ipc", { call: (ch, arg) => ipcRenderer.invoke(ch, arg) });\n`,
  "utf8",
);

async function main() {
  const res = { out: OUT, runs: [] };
  const win = new BrowserWindow({
    width: 900,
    height: 600,
    show: false,
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  await win.loadURL("data:text/html,<html><body>probe</body></html>");
  for (const mb of [0.05, 0.5, 2]) {
    const runCase = async (ch) =>
      win.webContents.executeJavaScript(`(async () => {
        const mk = (mb) => { const n = Math.round((mb * 1048576) / 12); const cells = new Array(n);
          for (let i = 0; i < n; i++) cells[i] = { x: i % 400, y: (i / 400) | 0, rv: i % 3 === 0, f: i % 7 === 0, v: (i % 9) - 1 };
          return { v: 1, cells: cells, savedAt: Date.now() }; };
        const data = mk(${mb});
        const t = [];
        const a0 = performance.now();
        for (let i = 0; i < 20; i++) { const s = performance.now(); await window.__ipc.call(${JSON.stringify(ch)}, { data: data }); t.push(+(performance.now() - s).toFixed(2)); }
        const total = +(performance.now() - a0).toFixed(1);
        const s = t.slice().sort((x, y) => x - y);
        return { totalMs: total, perCallP50: s[10], perCallMax: s[s.length - 1], calls: t.length };
      })()`);
    const before = await runCase("probe:old");
    const beforeBytes = (() => { try { return fs.statSync(path.join(TMP, "old.json")).size; } catch (e) { return 0; } })();
    diskWritesNew = 0;
    const after = await runCase("probe:new");
    await sleep(1800); /* 等合并窗与连发阈值把尾巴落完 */
    const afterBytes = (() => { try { return fs.statSync(path.join(TMP, "new.json")).size; } catch (e) { return 0; } })();
    res.runs.push({ mb: mb, before: before, beforeDiskBytes: beforeBytes, after: after, afterDiskWrites: diskWritesNew, afterDiskBytes: afterBytes });
    try { fs.rmSync(path.join(TMP, "old.json"), { force: true }); } catch {}
    try { fs.rmSync(path.join(TMP, "new.json"), { force: true }); } catch {}
  }
  fs.writeFileSync(OUT, JSON.stringify(res, null, 2), "utf8");
  console.log(JSON.stringify(res, null, 2));
  app.exit(0);
}

app.whenReady().then(() =>
  main().catch((err) => {
    fs.writeFileSync(OUT, JSON.stringify({ error: String((err && err.message) || err) }, null, 2), "utf8");
    app.exit(1);
  }),
);
