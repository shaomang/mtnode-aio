/* test/_perf-probe/wordless-input-latency.cjs —— wordless 真 OS 退格键：从按下到棋子重画的端到端时延
 *
 * 为什么要单独一支：wordless-del-latency.cjs 已证明**页面内**的输入处理只要 0.4~0.9ms
 * （连 400KB 存档、12 次同步写盘期间也一样）。所以「卡」如果真存在，只可能在
 * 「真按键 → 事件送进渲染进程」这段（主进程 / 系统输入链），页面内计时看不见它。
 *
 * 做法：真应用窗口（真 preload-app.js + 真 apps-store 内核）里装一只页面探针，
 *   · 探针记录每次 keydown 到达页面的 performance.now / Date.now，以及其后第一条棋子 DOM 变化；
 *   · 主进程侧用 PowerShell SendInput 发**真**退格键（keybd_event，先 SetForegroundWindow 并核对前台 pid）；
 *   · 两套时钟用「发键前 / 发完各记一次页面时钟」双基准对齐（页面 Date.now 与主进程 Date.now 同为本地墙钟）。
 * 于是得到：t_press → t_keydown（输入路由时延）、t_keydown → t_paint（页面内处理时延）。
 *
 * 用法：electron test\_perf-probe\wordless-input-latency.cjs [appDir] [out.json] [mode]
 * 纪律：应用副本 / 数据目录 / userData 全在系统临时目录；不碰真应用、不碰 %APPDATA%、不改仓库文件。
 */
const { app, BrowserWindow } = require("electron");
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const SRC_APP = String(process.argv[2] || "E:\\mtnode\\apps\\dev\\wordless");
const OUT = String(process.argv[3] || path.join(os.tmpdir(), "wordless-input-latency.json"));
const MODE = String(process.argv[4] || "disk");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "wordless-inlat-"));
app.setPath("userData", path.join(TMP, "ud"));
app.on("window-all-closed", () => {});
const DATA = path.join(TMP, "data");
const APP_ID = "wordless-inlat";
const STAGE_LOG = path.join(TMP, "stage.log");
const LIVE_DATA = "C:\\Users\\shaom\\AppData\\Roaming\\pipeline-console\\pipeline-console\\apps-data\\dev\\wordless\\data.json";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stage = (s, x) => {
  try {
    fs.appendFileSync(STAGE_LOG, s + (x ? " " + JSON.stringify(x) : "") + "\n", "utf8");
  } catch (e) {}
};
function writeOut(o) {
  try {
    fs.writeFileSync(OUT, JSON.stringify(o, null, 2), "utf8");
    console.log("[out] " + OUT);
  } catch (e) {
    console.log("[out FAIL] " + String((e && e.message) || e));
  }
}

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

/* 页面探针：keydown 到达时刻 + 其后第一条棋子变化；再给一个「取页面时钟」的口 */
const PROBE = `(() => {
  if (window.__ip) return "already";
  const P = { kd: [], mut: [], frames: [] };
  window.__ip = P;
  P.clock = () => ({ perf: +performance.now().toFixed(2), date: Date.now() });
  P.reset = () => { P.kd = []; P.mut = []; };
  document.addEventListener("keydown", (ev) => P.kd.push({ key: String(ev.key), perf: +performance.now().toFixed(2), date: Date.now() }), true);
  try {
    const ob = new MutationObserver((list) => {
      const rec = P.clock();
      for (const m of list) {
        const t = m.target;
        if (!t || !t.classList || !t.classList.contains("tile")) continue;
        P.mut.push({ cls: String(t.className), txt: String(t.textContent || ""), perf: rec.perf, date: rec.date });
      }
      if (P.mut.length > 4000) P.mut.splice(0, 2000);
    });
    ob.observe(document.body, { subtree: true, attributes: true, childList: true, characterData: true, attributeFilter: ["class"] });
  } catch (e) {}
  const ft = (now) => { P.frames.push(+now.toFixed(1)); if (P.frames.length > 8000) P.frames.splice(0, 4000); requestAnimationFrame(ft); };
  requestAnimationFrame(ft);
  P.wrap = (mode) => {
    if (P.wrapped) return "already";
    P.wrapped = 1;
    if (mode !== "disk" && window.appHost) {
      window.appHost.dataWrite = async () => ({ ok: true, bytes: 0, stub: true });
    }
    return "ok";
  };
  return "ok";
})()`;

const PS1 = `
param([string]$Plan, [string]$Done)
Add-Type -Namespace W -Name U -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
[DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
'@
$raw = [System.IO.File]::ReadAllText($Plan, [System.Text.Encoding]::UTF8)
$doc = ConvertFrom-Json -InputObject $raw
$proc = Get-Process -Id ([int]$doc.pid) -ErrorAction SilentlyContinue
if ($proc -and $proc.MainWindowHandle -ne 0) { [void][W.U]::SetForegroundWindow($proc.MainWindowHandle) }
Start-Sleep -Milliseconds 900
$rows = New-Object System.Collections.ArrayList
foreach ($c in @($doc.keys)) {
  $fg = [W.U]::GetForegroundWindow(); $fgPid = [uint32]0
  [void][W.U]::GetWindowThreadProcessId($fg, [ref]$fgPid)
  $t0 = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  [W.U]::keybd_event([byte][int]$c, 0, 0, [UIntPtr]::Zero)
  [W.U]::keybd_event([byte][int]$c, 0, 2, [UIntPtr]::Zero)
  [void]$rows.Add([pscustomobject]@{ vk = [int]$c; sentMs = [double]$t0; fgPid = [int]$fgPid })
  Start-Sleep -Milliseconds 330
}
$txt = ConvertTo-Json -InputObject @($rows) -Depth 3
[System.IO.File]::WriteAllText($Done, [string]$txt, (New-Object System.Text.UTF8Encoding($false)))
`;

async function main() {
  const res = { app: SRC_APP, out: OUT, tmp: TMP, mode: MODE };
  const appDir = path.join(DATA, "apps-dev", APP_ID);
  copyApp(SRC_APP, appDir);
  fs.writeFileSync(
    path.join(appDir, "app.json"),
    JSON.stringify({ schema: 1, id: APP_ID, name: "wordless inlat", title: "Wordless inlat", version: "0.0.0", entry: "index.html", dev: true }, null, 2),
    "utf8",
  );
  const dataDir = path.join(DATA, "apps-data", "dev", APP_ID);
  fs.mkdirSync(dataDir, { recursive: true });
  try {
    fs.copyFileSync(LIVE_DATA, path.join(dataDir, "data.json"));
  } catch (e) {}
  stage("open");
  res.open = store.openAppWindow(APP_ID);
  const all = BrowserWindow.getAllWindows();
  const win = all[all.length - 1];
  stage("window", { wins: all.length });
  try {
    win.setBounds({ x: 80, y: 60, width: 700, height: 860 });
    win.focus();
    win.show();
  } catch (e) {}
  await sleep(2500);
  res.probe = await win.webContents.executeJavaScript(PROBE);
  res.wrap = await win.webContents.executeJavaScript(`window.__ip.wrap(${JSON.stringify(MODE)})`);
  await sleep(400);
  /* 先把草稿填成 5 个字母（真键 a/b/c/d/e 走页面内的 typeLetter 做不到，用合成事件铺一版草稿） */
  await win.webContents.executeJavaScript(
    `(async () => { const f = (k) => document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })); for (const k of ["a","b","c","d","e"]) { f(k); await new Promise((r) => setTimeout(r, 60)); } return 1; })()`,
  );
  await sleep(1200);
  res.draft = await win.webContents.executeJavaScript(`(() => document.querySelectorAll("#board .tile.filled").length)()`);
  /* 双基准对时：发键前后各取一次页面时钟 */
  const clockBefore = await win.webContents.executeJavaScript(`JSON.stringify(window.__ip.clock())`).then(JSON.parse);
  await win.webContents.executeJavaScript(`window.__ip.reset()`);
  const planPath = path.join(TMP, "plan.json");
  const donePath = path.join(TMP, "done.json");
  const keys = [8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8];
  fs.writeFileSync(planPath, JSON.stringify({ pid: process.pid, keys: keys }), "utf8");
  const ps1 = path.join(TMP, "keys.ps1");
  fs.writeFileSync(ps1, PS1, "utf8");
  const hostBefore = Date.now();
  stage("sendinput");
  const ps = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", ps1, "-Plan", planPath, "-Done", donePath], { encoding: "utf8", timeout: 120000, windowsHide: true });
  const hostAfter = Date.now();
  const clockAfter = await win.webContents.executeJavaScript(`JSON.stringify(window.__ip.clock())`).then(JSON.parse);
  const sent = fs.existsSync(donePath) ? JSON.parse(fs.readFileSync(donePath, "utf8")) : [];
  await sleep(1500);
  const page = JSON.parse(await win.webContents.executeJavaScript(`JSON.stringify({ kd: window.__ip.kd, mut: window.__ip.mut.slice(-400) })`));
  stage("collected", { kd: page.kd.length, mut: page.mut.length });
  /* 对时：页面 date ≈ 主进程 date（同机墙钟），用两次取样算出残差并取其中点 */
  const skewA = clockBefore.date - hostBefore;
  const skewB = clockAfter.date - hostAfter;
  const skew = (skewA + skewB) / 2;
  const press = [];
  for (const s of sent) {
    const want = Number(s.sentMs) + skew; /* 换算成页面时钟 */
    const kd = page.kd.find((k) => k.date >= want - 5);
    const paint = kd ? page.mut.find((m) => m.perf >= kd.perf) : null;
    press.push({
      fgIsSelf: s.fgPid === process.pid,
      routeMs: kd ? +(kd.date - want).toFixed(1) : null,
      handleMs: kd && paint ? +(paint.perf - kd.perf).toFixed(2) : null,
      cls: paint ? paint.cls : "",
      txt: paint ? paint.txt : "",
    });
  }
  const nums = (a) => {
    const v = a.filter((x) => x != null).sort((x, y) => x - y);
    return v.length ? { n: v.length, p50: v[Math.floor(v.length / 2)], max: v[v.length - 1], min: v[0] } : null;
  };
  res.sync = { skewA: skewA, skewB: skewB, skew: skew, hostSpanMs: hostAfter - hostBefore };
  res.press = press;
  res.routeStat = nums(press.map((p) => p.routeMs));
  res.handleStat = nums(press.map((p) => p.handleMs));
  res.fgAllSelf = press.every((p) => p.fgIsSelf);
  res.psStatus = ps.status;
  res.psErr = ps.stderr ? String(ps.stderr).slice(0, 300) : "";
  res.nsent = sent.length;
  res.nkd = page.kd.length;
  res.nmut = page.mut.length;
  writeOut(res);
  stage("done");
  app.exit(0);
}

app.whenReady().then(() => {
  const guard = setTimeout(() => {
    writeOut({ error: "超时 120s", tmp: TMP });
    app.exit(3);
  }, 120000);
  main()
    .then(() => clearTimeout(guard))
    .catch((e) => {
      clearTimeout(guard);
      writeOut({ error: String((e && e.message) || e), stack: String((e && e.stack) || "").slice(0, 1500), tmp: TMP });
      app.exit(1);
    });
});
