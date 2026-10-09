/* test/_perf-probe/wordless-oskey-latency.cjs —— 真 OS 退格键「按下 → 页面收到 → 画出来」的端到端时延
 *
 * 要回答的是唯一还没量准的那一问：宿主主进程被同步活占住时，**真的用键盘敲**到底要等多久？
 *
 * 前两版的量法各有硬伤，本版把它们都补掉：
 *   · 旧版（wil/wdl3）：用 PowerShell 的 sentMs 当「发出时刻」。实测那批 routeMs 呈 4162→369ms
 *     单调递减，是判据伪影的形状：真正被推迟的是**注射端**（PowerShell 自己也被饿住 / 父进程
 *     用 spawnSync 把宿主同步堵了整段注射期），不是应用。本版：注射走**异步 spawn**（宿主事件
 *     循环全程不堵），「OS 事件时刻」改由**独立子进程的全局键盘钩子**（oskey-hook.cjs）记。
 *   · 新版 wuic：改用宿主 executeJavaScript 逐发派发合成 keydown —— 这条路**绕开了 OS 输入
 *     队列与浏览器进程的输入转发**（那正是宿主阻塞时会堵住的一段），所以它的 ipcMs=1ms
 *     只能证明「渲染进程不忙」，证明不了「真键盘不被堵」。本版：真实的 keybd_event。
 *
 * 于是三者相减即得：
 *   sendToHook = hookT − PS.sentMs   → 注射端自己迟了多久（旧版的伪影量，本版用来暴露它）
 *   routeMs    = pageWall − hookT    → OS 事件产生 → 页面 document 收到 keydown（宿主/浏览器转发这段）
 *   d1 / d2    = keydown → 下一帧 / 再下一帧（应用真画出来的时刻）
 *
 * 模式：
 *   disk       基线：真窗口 + 真落盘，宿主不做额外的事
 *   hostblock  正对照：宿主每隔 1200ms 故意同步忙 700ms（证明这套量法**能**量出阻塞）
 *   mainblock  现场口径：宿主连续做 config:save 那份活（读真 config.json → parse → merge →
 *              stringify(null,2) → 整份写 → copyFileSync 备份）；真 config 只读，写出全在临时目录
 *
 * 用法：electron test\_perf-probe\wordless-oskey-latency.cjs [appDir] [out.json] [modes]
 * 纪律：应用副本 / 数据目录 / userData / config 副本全在系统临时目录；%APPDATA% 只读打开。
 */
const { app, BrowserWindow } = require("electron");
const { fork, spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const SRC_APP = String(process.argv[2] || "E:\\mtnode\\apps\\dev\\wordless");
const OUT = String(process.argv[3] || path.join(os.tmpdir(), "wordless-oskey.json"));
const MODES = String(process.argv[4] || "disk,hostblock,mainblock").split(",").filter(Boolean);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "wordless-osk-"));
app.setPath("userData", path.join(TMP, "ud"));
app.on("window-all-closed", () => {});
const DATA = path.join(TMP, "data");
const APP_ID = "wordless-osk";
const LIVE_DATA = path.join(process.env.APPDATA || "", "pipeline-console", "pipeline-console", "apps-data", "dev", "wordless", "data.json");
const LIVE_CFG = path.join(process.env.APPDATA || "", "pipeline-console", "pipeline-console", "config.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const KEYS = [8, 8, 65, 8, 8, 66, 8, 8, 67, 8, 8, 8]; /* 退格为主，夹几个字母保证有字可退 */

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

/* ── 独立子进程：全局键盘钩子，只报「OS 事件时刻」 ─────────────────────────── */
const hook = { events: [], started: false, fatal: "", pid: 0 };
const hookChild = fork(path.join(__dirname, "oskey-hook.cjs"), [], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
hookChild.on("message", (m) => {
  if (!m || typeof m !== "object") return;
  if (m.kind === "fatal") hook.fatal = String(m.msg || "");
  else if (m.kind === "started") {
    hook.started = true;
    hook.pid = m.pid;
  } else if (m.kind === "down" || m.kind === "up") hook.events.push(m);
});

/* ── 旁挂探针：宿主同步忙时回包被推迟 = 这一刻宿主被占住多久 ─────────────── */
const PINGER = fork(path.join(__dirname, "cfg-save-pinger.cjs"), [], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
const pinger = { trips: [], live: false };
const pingerWaits = [];
PINGER.on("message", () => {
  const w = pingerWaits.shift();
  if (w) w();
});
async function pingOnce() {
  const t0 = Date.now();
  await new Promise((res) => {
    pingerWaits.push(res);
    PINGER.send("ping");
  });
  pinger.trips.push(Date.now() - t0);
}

/* ── 现场口径的一发 config:save（main.js config:save 的五步），落盘全在临时目录 ── */
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
    const old = fs
      .readdirSync(bakDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => ({ f, t: fs.statSync(path.join(bakDir, f)).mtimeMs }))
      .sort((x, y) => y.t - x.t);
    for (const o of old.slice(6)) fs.unlinkSync(path.join(bakDir, o.f));
  } catch (e) {}
}
/* 正对照用的纯 CPU 同步忙（模拟「宿主主进程被同步活占住」这一段） */
function spin(ms) {
  const end = Date.now() + ms;
  let x = 1;
  while (Date.now() < end) x += Math.sqrt(x);
  return x;
}

/* ── 页面探针：捕获阶段记 keydown（墙上时钟），随后两帧量「真画出来没有」 ── */
const PROBE = `(() => {
  const P = window.__ok = { hits: [], frames: [] };
  document.addEventListener("keydown", (ev) => {
    const wall = Date.now(); const perf = performance.now(); const key = String(ev.key);
    requestAnimationFrame(() => {
      const d1 = performance.now() - perf;
      requestAnimationFrame(() => {
        P.hits.push({ key: key, wall: wall, d1: +d1.toFixed(1), d2: +(performance.now() - perf).toFixed(1) });
        if (P.hits.length > 4000) P.hits.splice(0, 2000);
      });
    });
  }, true);
  const ft = (t) => { P.frames.push(+t.toFixed(1)); if (P.frames.length > 30000) P.frames.splice(0, 15000); requestAnimationFrame(ft); };
  requestAnimationFrame(ft);
  return "ok";
})()`;

/* 注射脚本：真 keybd_event（异步 spawn，宿主不堵）。
 * 窗口句柄由宿主用 win.getNativeWindowHandle() 直接给（不靠 Get-Process.MainWindowHandle 猜），
 * 抢前台走「AttachThreadInput + ALT 解锁 + 重试」，抢不到就如实报 focusOk=false（否则 0 命中会被误读成「不卡」）。 */
const PS1 = `
param([string]$Plan, [string]$Done)
Add-Type -Namespace W -Name U -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
[DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey);
[DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
[DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
[DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
[DllImport("user32.dll")] public static extern IntPtr SetFocus(IntPtr h);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
'@
$doc = ConvertFrom-Json -InputObject ([System.IO.File]::ReadAllText($Plan, [System.Text.Encoding]::UTF8))
$target = [IntPtr][int64]$doc.hwnd
$tPid = [uint32]0
$tThread = [W.U]::GetWindowThreadProcessId($target, [ref]$tPid)
[void][W.U]::ShowWindow($target, 9)
$focusOk = $false
for ($i = 0; $i -lt 25 -and -not $focusOk; $i++) {
  $fg = [W.U]::GetForegroundWindow()
  $fgPid = [uint32]0
  $fgThread = [W.U]::GetWindowThreadProcessId($fg, [ref]$fgPid)
  [W.U]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
  [void][W.U]::AttachThreadInput($fgThread, $tThread, $true)
  [void][W.U]::SetForegroundWindow($target)
  [void][W.U]::BringWindowToTop($target)
  [void][W.U]::SetFocus($target)
  [void][W.U]::AttachThreadInput($fgThread, $tThread, $false)
  [W.U]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 150
  $now = [W.U]::GetForegroundWindow()
  $nowPid = [uint32]0
  [void][W.U]::GetWindowThreadProcessId($now, [ref]$nowPid)
  if ($nowPid -eq $tPid) { $focusOk = $true }
}
Start-Sleep -Milliseconds 300
$rows = New-Object System.Collections.ArrayList
foreach ($c in @($doc.keys)) {
  $t0 = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  [W.U]::keybd_event([byte][int]$c, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 40
  [W.U]::keybd_event([byte][int]$c, 0, 2, [UIntPtr]::Zero)
  [void]$rows.Add([pscustomobject]@{ vk = [int]$c; sentMs = [double]$t0; focusOk = [bool]$focusOk; fgPid = [int]$tPid })
  Start-Sleep -Milliseconds 400
}
[System.IO.File]::WriteAllText($Done, (ConvertTo-Json -InputObject @($rows) -Depth 3), (New-Object System.Text.UTF8Encoding($false)))
`;

function injectRealKeys(hwnd) {
  const planPath = path.join(TMP, "plan.json");
  const donePath = path.join(TMP, "done-" + Date.now() + ".json");
  fs.writeFileSync(planPath, JSON.stringify({ hwnd: String(hwnd), keys: KEYS }), "utf8");
  const ps1 = path.join(TMP, "keys.ps1");
  fs.writeFileSync(ps1, PS1, "utf8");
  const t0 = Date.now();
  const ps = spawn("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", ps1, "-Plan", planPath, "-Done", donePath], {
    windowsHide: true,
    stdio: "ignore",
  });
  return new Promise((res) => {
    const fin = () => {
      let sent = [];
      try {
        sent = JSON.parse(fs.readFileSync(donePath, "utf8"));
      } catch (e) {}
      res({ spanMs: Date.now() - t0, sent: sent, status: ps.exitCode });
    };
    ps.on("exit", fin);
    setTimeout(() => {
      try {
        ps.kill();
      } catch (e) {}
      fin();
    }, 40000);
  });
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
  try {
    win.setBounds({ x: 60, y: 40, width: 700, height: 860 });
    win.show();
    win.focus();
  } catch (e) {}
  for (let i = 0; i < 60; i++) {
    const b = await win.webContents.executeJavaScript(`document.querySelectorAll("#board .tile").length`).catch(() => 0);
    if (b > 0) break;
    await sleep(200);
  }
  res.bootMs = Date.now() - tOpen;
  res.page = await win.webContents.executeJavaScript(PROBE);
  /* 注射目标：应用窗口的原生句柄（Electron 直接给，别让 PowerShell 去猜 MainWindowHandle） */
  let hwnd = "0";
  try {
    const b = win.getNativeWindowHandle();
    hwnd = String(b.length >= 8 ? b.readBigUInt64LE(0) : BigInt(b.readUInt32LE(0)));
  } catch (e) {}
  res.hwnd = hwnd;

  let loadTimer = null;
  let spinTimer = null;
  hook.events.length = 0;
  pinger.trips.length = 0;
  if (mode === "mainblock") {
    res.cfgBytes = fs.existsSync(LIVE_CFG) ? fs.statSync(LIVE_CFG).size : 0;
    cfgWork.n = 0;
    cfgWork.rows.length = 0;
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
  } else if (mode === "hostblock") {
    pinger.live = true;
    (async () => {
      while (pinger.live) await pingOnce().catch(() => {});
    })();
    spinTimer = setInterval(() => spin(700), 1200); /* 正对照：宿主主进程被同步占住 */
  }
  await sleep(2000); /* 让负载先跑起来，对齐「启动后」那一刻 */
  const inj = await injectRealKeys(hwnd);
  res.focusOk = inj.sent && inj.sent.length ? !!inj.sent[0].focusOk : false;
  res.targetPid = inj.sent && inj.sent.length ? inj.sent[0].fgPid : null;
  await sleep(800);
  const hits = await win.webContents.executeJavaScript(`window.__ok.hits.slice()`).catch(() => []);
  const frames = await win.webContents.executeJavaScript(`window.__ok.frames.slice(-6000)`).catch(() => []);
  const gaps = [];
  for (let i = 1; i < frames.length; i++) gaps.push(+(frames[i] - frames[i - 1]).toFixed(1));
  res.frameGaps = Object.assign({ over33: gaps.filter((x) => x > 33).length, over100: gaps.filter((x) => x > 100).length }, stat(gaps));
  if (loadTimer) clearInterval(loadTimer);
  if (spinTimer) clearInterval(spinTimer);
  pinger.live = false;
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

  /* ── 配对：钩子侧 keydown 与页面 keydown 按尾部对齐（从后往前配，计数不等时以短的为准） */
  const downs = hook.events.filter((e) => e.kind === "down");
  const k = Math.min(downs.length, hits.length);
  const rows = [];
  const route = [];
  const d1s = [];
  const d2s = [];
  const sendToHook = [];
  for (let i = 0; i < k; i++) {
    const h = downs[downs.length - k + i];
    const p = hits[hits.length - k + i];
    const sent = inj.sent && inj.sent[inj.sent.length - k + i] ? inj.sent[inj.sent.length - k + i].sentMs : null;
    const r = {
      vk: h.vk,
      key: p.key,
      sentMs: sent,
      hookT: h.t,
      pageWall: p.wall,
      sendToHook: sent ? h.t - sent : null,
      routeMs: p.wall - h.t,
      d1: p.d1,
      d2: p.d2,
    };
    rows.push(r);
    route.push(r.routeMs);
    d1s.push(r.d1);
    d2s.push(r.d2);
    if (r.sendToHook != null) sendToHook.push(r.sendToHook);
  }
  res.keys = {
    hookDowns: downs.length,
    pageHits: hits.length,
    paired: k,
    fgPid: inj.sent && inj.sent[0] ? inj.sent[0].fgPid : null,
    selfPid: process.pid,
    sendToHookMs: stat(sendToHook),
    routeMs: stat(route),
    paintD1Ms: stat(d1s),
    paintD2Ms: stat(d2s),
    rows: rows,
  };
  res.injectSpanMs = inj.spanMs;
  try {
    store.closeAppWindow(APP_ID);
  } catch (e) {}
  await sleep(400);
  return res;
}

async function main() {
  const res = { app: SRC_APP, out: OUT, tmp: TMP, modes: MODES, hookPid: hook.pid, hookStarted: hook.started, hookFatal: hook.fatal, cases: [] };
  const appDir = path.join(DATA, "apps-dev", APP_ID);
  copyApp(SRC_APP, appDir);
  fs.writeFileSync(
    path.join(appDir, "app.json"),
    JSON.stringify({ schema: 1, id: APP_ID, name: "wordless osk probe", title: "osk probe", version: "0.0.0", entry: "index.html", dev: true }, null, 2),
    "utf8",
  );
  await sleep(500); /* 等钩子子进程挂上 */
  res.hookStarted = hook.started;
  res.hookFatal = hook.fatal;
  for (const m of MODES) {
    try {
      res.cases.push(await runMode(m));
    } catch (e) {
      res.cases.push({ mode: m, error: String((e && e.message) || e), stack: String((e && e.stack) || "").slice(0, 1200) });
    }
  }
  try {
    hookChild.send("stop");
  } catch (e) {}
  fs.writeFileSync(OUT, JSON.stringify(res, null, 2), "utf8");
  console.log("[out] " + OUT);
  app.exit(0);
}

app.whenReady().then(() => {
  const guard = setTimeout(() => {
    fs.writeFileSync(OUT, JSON.stringify({ error: "超时 300s", tmp: TMP, hookStarted: hook.started, hookFatal: hook.fatal }, null, 2), "utf8");
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
