/* test/_perf-probe/wordless-input-under-cfg-load.cjs —— 「独立窗口退格卡顿」是不是宿主被大 config 占住
 *
 * 与 wordless-under-config-load.cjs 的区别（那一版踩过一个坑，本版改掉）：
 *   旧版用 PowerShell 注入真 OS 键，而 PowerShell 自己也会被同一个忙宿主饿住 —— 它记下的
 *   sentMs 是不准的，算出来的「发出→keydown 3–4 秒」是量法伪影，不能当证据。
 *   本版改成**从宿主侧（Electron 主进程）逐发派发合成 keydown**：主进程每发前记一个 t0，
 *   页面 document 捕获阶段记收到时刻，两者都在同一台机器上取墙上时钟；同一发再配一次
 *   executeJavaScript（也是宿主 → 渲染进程的 IPC）。因此：
 *     ipcMs = 页面收到 keydown 的时刻 − 宿主派发的时刻  = 「这一刻窗口要等多久才被喂到输入」
 *     rttMs = 一次 executeJavaScript 往返                          = 「这一刻窗口还能不能及时回话」
 *   这两个数才是「整个窗口发木」的量化口径；页面内部的处理器快慢另有一组数（页面内 performance.now）。
 *
 * 模式：
 *   disk        基线：真窗口 + 真落盘，宿主什么都不多做
 *   mainblock   同样的窗口、同样的落盘，宿主按现场口径连续做 config:save 那份活
 *               （读真 config.json → parse → merge → stringify(null,2) → 写整份 → copyFileSync 备份）
 *               —— 真 config.json 只读；写出去的 config 与备份全在系统临时目录
 * 每个模式量：ipcMs / rttMs 分布 · 页面内输入→绘制（rAF 后一帧）· 帧间隔与掉帧数 ·
 *            旁挂 ping 往返峰值 · 宿主每发 config:save 的分段耗时
 *
 * 用法：electron test\_perf-probe\wordless-input-under-cfg-load.cjs [appDir] [out.json] [modes]
 * 纪律：应用副本 / 数据目录 / userData / config 副本全在系统临时目录；%APPDATA% 只读打开。
 */
const { app, BrowserWindow } = require("electron");
const { fork } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const SRC_APP = String(process.argv[2] || "E:\\mtnode\\apps\\dev\\wordless");
const OUT = String(process.argv[3] || path.join(os.tmpdir(), "wordless-input-cfgload.json"));
const MODES = String(process.argv[4] || "disk,mainblock").split(",").filter(Boolean);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "wordless-ucfg-"));
app.setPath("userData", path.join(TMP, "ud"));
app.on("window-all-closed", () => {});
const DATA = path.join(TMP, "data");
const APP_ID = "wordless-cfgprobe";
const LIVE_DATA = path.join(
  process.env.APPDATA || "",
  "pipeline-console",
  "pipeline-console",
  "apps-data",
  "dev",
  "wordless",
  "data.json",
);
const LIVE_CFG = path.join(process.env.APPDATA || "", "pipeline-console", "pipeline-console", "config.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const store = require(path.join(ROOT, "apps-store.js"));
store.registerAppsIpc({
  getDataDir: () => DATA,
  getMainWin: () => null,
  t: (s) => String(s),
  authState: () => ({ loggedIn: false }),
  getAppVersion: () => "0.0.0-probe",
});
store.setRoot(path.join(TMP, "apps-root"));

function copyApp(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (/^_verify$/i.test(e.name) || /\.zip$/i.test(e.name)) continue;
    if (e.isDirectory()) copyApp(path.join(src, e.name), path.join(dst, e.name));
    else fs.copyFileSync(path.join(src, e.name), path.join(dst, e.name));
  }
}
function stat(list) {
  if (!list || !list.length) return null;
  const a = list.slice().sort((x, y) => x - y);
  const q = (p) => a[Math.min(a.length - 1, Math.max(0, Math.round((a.length - 1) * p)))];
  return { n: a.length, p50: +q(0.5).toFixed(1), p95: +q(0.95).toFixed(1), max: +a[a.length - 1].toFixed(1) };
}

/* 旁挂探针：子进程每 5ms ping 一次，父进程同步忙时回包被推迟 → 就是「窗口这一刻等多久」 */
const PINGER = fork(path.join(__dirname, "cfg-save-pinger.cjs"), [], {
  stdio: ["ignore", "ignore", "inherit", "ipc"],
});
const pinger = { waits: [], trips: [], live: false };
PINGER.on("message", () => {
  const w = pinger.waits.shift();
  if (w) w();
});
async function pingOnce() {
  const t0 = Date.now();
  await new Promise((res) => {
    pinger.waits.push(res);
    PINGER.send("ping");
  });
  pinger.trips.push(Date.now() - t0);
}

/* 现场口径的一发 config:save（main.js config:save 的五步），落盘全在临时目录 */
const cfgWork = { n: 0, rows: [] };
function oneConfigSave() {
  if (!fs.existsSync(LIVE_CFG)) return;
  const outDir = path.join(TMP, "cfg-out");
  fs.mkdirSync(outDir, { recursive: true });
  const hr = (a) => Number(process.hrtime.bigint() - a) / 1e6;
  const t = {};
  let a = process.hrtime.bigint();
  const raw = fs.readFileSync(LIVE_CFG, "utf8");
  t.read = +hr(a).toFixed(1);
  a = process.hrtime.bigint();
  const obj = JSON.parse(raw);
  t.parse = +hr(a).toFixed(1);
  a = process.hrtime.bigint();
  obj.__probeStamp = Date.now() + ":" + cfgWork.n;
  const text = JSON.stringify(obj, null, 2);
  t.stringify = +hr(a).toFixed(1);
  a = process.hrtime.bigint();
  const dest = path.join(outDir, "config.json");
  fs.writeFileSync(dest + ".tmp", text, "utf8");
  fs.renameSync(dest + ".tmp", dest);
  t.write = +hr(a).toFixed(1);
  a = process.hrtime.bigint();
  const bakDir = path.join(outDir, "config-backups");
  fs.mkdirSync(bakDir, { recursive: true });
  fs.copyFileSync(dest, path.join(bakDir, "config-" + Date.now() + ".json"));
  t.backup = +hr(a).toFixed(1);
  t.total = +(t.read + t.parse + t.stringify + t.write + t.backup).toFixed(1);
  t.bytes = Buffer.byteLength(text);
  cfgWork.n++;
  cfgWork.rows.push(t);
  try {
    const fs2 = fs
      .readdirSync(bakDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => ({ f, t: fs.statSync(path.join(bakDir, f)).mtimeMs }))
      .sort((x, y) => y.t - x.t);
    for (const old of fs2.slice(6)) fs.unlinkSync(path.join(bakDir, old.f));
  } catch {}
}

/* 页面探针：捕获阶段记 keydown 到达时刻（与宿主同一个墙上时钟），并在 rAF 的下一帧量
 * 「这次输入真的画出来了没有」；长任务用 PerformanceObserver 抓。 */
const PROBE = `(() => {
  const P = window.__u = { kd: [], frames: [], longtasks: [], phase: "" };
  document.addEventListener("keydown", (ev) => {
    P.kd.push({ key: String(ev.key), at: Date.now(), perf: +performance.now().toFixed(2) });
    if (P.kd.length > 4000) P.kd.splice(0, 2000);
  }, true);
  const ftick = (t) => { P.frames.push(+t.toFixed(1)); if (P.frames.length > 20000) P.frames.splice(0, 10000); requestAnimationFrame(ftick); };
  requestAnimationFrame(ftick);
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) P.longtasks.push({ d: +e.duration.toFixed(1), at: Date.now() }); }).observe({ entryTypes: ["longtask"] });
  } catch (e) {}
  /* 页面内量法：派发一发 keydown，量「同步处理完」与「下一帧真画完」各要多久 */
  P.measureInPage = async (n, gapMs) => {
    const out = { sync: [], paint: [] };
    const keyOf = () => "Backspace";
    for (let i = 0; i < n; i++) {
      /* 先保证草稿里有字可退：补字母（草稿满了会被忽略，不影响口径） */
      const a0 = performance.now();
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "q", bubbles: true, cancelable: true }));
      out.sync.push(+(performance.now() - a0).toFixed(2));
      const b0 = performance.now();
      document.dispatchEvent(new KeyboardEvent("keydown", { key: keyOf(), bubbles: true, cancelable: true }));
      out.sync.push(+(performance.now() - b0).toFixed(2));
      const c0 = performance.now();
      await new Promise((r) => requestAnimationFrame(() => r()));
      out.paint.push(+(performance.now() - c0).toFixed(2));
      await new Promise((r) => setTimeout(r, gapMs));
    }
    return out;
  };
  return "ok";
})()`;

/* 宿主侧逐发派发：每发 = 一次 executeJavaScript（自带 IPC 往返），页面捕获阶段记到达时刻 */
async function hostDrivenKeys(win, n, gapMs) {
  const ipc = [];
  const rtt = [];
  const before = await win.webContents.executeJavaScript(`window.__u.kd.length`);
  for (let i = 0; i < n; i++) {
    const t0 = Date.now();
    try {
      await win.webContents.executeJavaScript(
        `document.dispatchEvent(new KeyboardEvent("keydown",{key:${JSON.stringify(i % 3 === 2 ? "Backspace" : "q")},bubbles:true,cancelable:true})); 1`,
      );
    } catch (e) {
      ipc.push(-1);
    }
    rtt.push(Date.now() - t0);
    const at = await win.webContents
      .executeJavaScript(`(window.__u.kd.length ? window.__u.kd[window.__u.kd.length-1].at : 0)`)
      .catch(() => 0);
    if (at) ipc.push(Math.max(0, at - t0));
    await sleep(gapMs);
  }
  const after = await win.webContents.executeJavaScript(`window.__u.kd.length`);
  return { dispatched: n, arrived: after - before, ipcMs: stat(ipc), rttMs: stat(rtt), ipc, rtt };
}

async function runMode(mode) {
  const res = { mode };
  fs.rmSync(path.join(DATA, "apps-data", "dev", APP_ID), { recursive: true, force: true });
  fs.mkdirSync(path.join(DATA, "apps-data", "dev", APP_ID), { recursive: true });
  try {
    fs.copyFileSync(LIVE_DATA, path.join(DATA, "apps-data", "dev", APP_ID, "data.json"));
  } catch (e) {}
  const tOpen = Date.now();
  store.openAppWindow(APP_ID);
  const all = BrowserWindow.getAllWindows();
  const win = all[all.length - 1];
  if (!win) return Object.assign(res, { error: "没拿到窗口" });
  win.on("unresponsive", () => (res.unresponsive = true));
  try {
    win.setBounds({ x: 60, y: 40, width: 700, height: 860 });
    win.focus();
  } catch (e) {}
  for (let i = 0; i < 60; i++) {
    const b = await win.webContents
      .executeJavaScript(`document.querySelectorAll("#board .tile").length`)
      .catch(() => 0);
    if (b > 0) break;
    await sleep(200);
  }
  res.bootMs = Date.now() - tOpen;
  res.probe = await win.webContents.executeJavaScript(PROBE);

  let loadTimer = null;
  if (mode === "mainblock") {
    res.cfgBytes = fs.existsSync(LIVE_CFG) ? fs.statSync(LIVE_CFG).size : 0;
    cfgWork.n = 0;
    cfgWork.rows.length = 0;
    pinger.trips.length = 0;
    pinger.live = true;
    (async () => {
      while (pinger.live) await pingOnce().catch(() => {});
    })();
    loadTimer = setInterval(() => {
      try {
        oneConfigSave();
      } catch (e) {
        cfgWork.rows.push({ err: String((e && e.message) || e) });
      }
    }, 900);
  }
  await sleep(2000); /* 让负载先跑起来，再量输入（对齐「启动后」那一刻） */
  res.hostKeys = await hostDrivenKeys(win, 60, 120);
  res.inPage = await win.webContents.executeJavaScript(`window.__u.measureInPage(20, 60)`).catch((e) => String(e.message));
  const frames = await win.webContents.executeJavaScript(`window.__u.frames.slice(-6000)`).catch(() => []);
  const gaps = [];
  for (let i = 1; i < frames.length; i++) gaps.push(+(frames[i] - frames[i - 1]).toFixed(1));
  res.frameGaps = Object.assign({ over33: gaps.filter((x) => x > 33).length, over100: gaps.filter((x) => x > 100).length }, stat(gaps));
  res.longtasks = await win.webContents.executeJavaScript(`window.__u.longtasks.slice(-50)`).catch(() => []);
  res.pinger = Object.assign({ trips: pinger.trips.length }, stat(pinger.trips));
  res.cfgSaves = cfgWork.rows.length;
  if (cfgWork.rows.length) {
    const sum = (k) => cfgWork.rows.reduce((s, r) => s + (Number(r[k]) || 0), 0);
    const mx = (k) => cfgWork.rows.reduce((s, r) => Math.max(s, Number(r[k]) || 0), 0);
    res.cfgSaveStat = {
      n: cfgWork.rows.length,
      bytes: cfgWork.rows[0].bytes || 0,
      avgTotal: +(sum("total") / cfgWork.rows.length).toFixed(0),
      maxTotal: +mx("total").toFixed(0),
      avgRead: +(sum("read") / cfgWork.rows.length).toFixed(0),
      avgParse: +(sum("parse") / cfgWork.rows.length).toFixed(0),
      avgStringify: +(sum("stringify") / cfgWork.rows.length).toFixed(0),
      avgWrite: +(sum("write") / cfgWork.rows.length).toFixed(0),
      avgBackup: +(sum("backup") / cfgWork.rows.length).toFixed(0),
    };
  }
  if (loadTimer) clearInterval(loadTimer);
  pinger.live = false;
  try {
    res.savedBytes = fs.statSync(path.join(DATA, "apps-data", "dev", APP_ID, "data.json")).size;
  } catch (e) {}
  try {
    store.closeAppWindow(APP_ID);
  } catch (e) {}
  await sleep(500);
  return res;
}

async function main() {
  const res = { app: SRC_APP, out: OUT, tmp: TMP, modes: MODES, cases: [] };
  const appDir = path.join(DATA, "apps-dev", APP_ID);
  copyApp(SRC_APP, appDir);
  fs.writeFileSync(
    path.join(appDir, "app.json"),
    JSON.stringify(
      { schema: 1, id: APP_ID, name: "wordless cfg probe", title: "probe", version: "0.0.0", entry: "index.html", dev: true },
      null,
      2,
    ),
    "utf8",
  );
  for (const m of MODES) {
    try {
      res.cases.push(await runMode(m));
    } catch (e) {
      res.cases.push({ mode: m, error: String((e && e.message) || e), stack: String((e && e.stack) || "").slice(0, 1200) });
    }
  }
  fs.writeFileSync(OUT, JSON.stringify(res, null, 2), "utf8");
  console.log("[out] " + OUT);
  app.exit(0);
}

app.whenReady().then(() => {
  const guard = setTimeout(() => {
    fs.writeFileSync(OUT, JSON.stringify({ error: "超时 300s", tmp: TMP }, null, 2), "utf8");
    app.exit(3);
  }, 300000);
  main()
    .then(() => clearTimeout(guard))
    .catch((e) => {
      clearTimeout(guard);
      fs.writeFileSync(OUT, JSON.stringify({ error: String((e && e.message) || e), stack: String((e && e.stack) || "").slice(0, 1500), tmp: TMP }, null, 2), "utf8");
      app.exit(1);
    });
});
