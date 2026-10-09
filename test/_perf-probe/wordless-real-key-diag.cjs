/* test/_perf-probe/wordless-real-key-diag.cjs —— 诊断：真 OS 退格键到底有没有进 wordless 的处理链
 *
 * 只回答三个问题（不带任何时延推断）：
 *   ① 真 keybd_event 发出去的键，页面 document 层能不能收到（捕获监听计数）；
 *   ② 应用自己的 keydown 处理器有没有跑到 backspace()/typeLetter()（用草稿格数 / 棋盘 DOM 变化判定）；
 *   ③ 有没有异常被吞掉（console-message / error 事件）。
 *
 * 用法：electron test\_perf-probe\wordless-real-key-diag.cjs [appDir] [out.json]
 */
const { app, BrowserWindow } = require("electron");
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const SRC_APP = String(process.argv[2] || "E:\\mtnode\\apps\\dev\\wordless");
const OUT = String(process.argv[3] || path.join(os.tmpdir(), "wordless-realkey-diag.json"));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "wordless-rkd-"));
app.setPath("userData", path.join(TMP, "ud"));
app.on("window-all-closed", () => {});
const DATA = path.join(TMP, "data");
const APP_ID = "wordless-rkd";
const LIVE_DATA = "C:\\Users\\shaom\\AppData\\Roaming\\pipeline-console\\pipeline-console\\apps-data\\dev\\wordless\\data.json";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const logs = [];
function writeOut(o) {
  try {
    fs.writeFileSync(OUT, JSON.stringify(o, null, 2), "utf8");
  } catch (e) {}
}

const store = require(path.join(ROOT, "apps-store.js"));
store.registerAppsIpc({ getDataDir: () => DATA, getMainWin: () => null, t: (s) => String(s), authState: () => ({ loggedIn: false }), getAppVersion: () => "probe" });
store.setRoot(path.join(TMP, "apps-root"));

function copyApp(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (/^_verify$/i.test(e.name) || /\.zip$/i.test(e.name)) continue;
    if (e.isDirectory()) copyApp(path.join(src, e.name), path.join(dst, e.name));
    else fs.copyFileSync(path.join(src, e.name), path.join(dst, e.name));
  }
}

const PS1 = `
param([string]$Plan, [string]$Done)
Add-Type -Namespace W -Name U -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
[DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey);
[DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
'@
$raw = [System.IO.File]::ReadAllText($Plan, [System.Text.Encoding]::UTF8)
$doc = ConvertFrom-Json -InputObject $raw
$proc = Get-Process -Id ([int]$doc.pid) -ErrorAction SilentlyContinue
if ($proc -and $proc.MainWindowHandle -ne 0) { [void][W.U]::SetForegroundWindow($proc.MainWindowHandle) }
Start-Sleep -Milliseconds 900
$fg = [W.U]::GetForegroundWindow(); $fgPid = [uint32]0
[void][W.U]::GetWindowThreadProcessId($fg, [ref]$fgPid)
$rows = New-Object System.Collections.ArrayList
foreach ($c in @($doc.keys)) {
  $st = [W.U]::GetAsyncKeyState(8)
  $t0 = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  [W.U]::keybd_event([byte][int]$c, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 40
  [W.U]::keybd_event([byte][int]$c, 0, 2, [UIntPtr]::Zero)
  [void]$rows.Add([pscustomobject]@{ vk = [int]$c; sentMs = [double]$t0; fgPid = [int]$fgPid; asyncState = [int]$st })
  Start-Sleep -Milliseconds 300
}
$txt = ConvertTo-Json -InputObject @($rows) -Depth 3
[System.IO.File]::WriteAllText($Done, [string]$txt, (New-Object System.Text.UTF8Encoding($false)))
`;

async function main() {
  const res = { app: SRC_APP, tmp: TMP };
  const appDir = path.join(DATA, "apps-dev", APP_ID);
  copyApp(SRC_APP, appDir);
  fs.writeFileSync(path.join(appDir, "app.json"), JSON.stringify({ schema: 1, id: APP_ID, name: "rkd", title: "rkd", version: "0.0.0", entry: "index.html", dev: true }, null, 2), "utf8");
  const dataDir = path.join(DATA, "apps-data", "dev", APP_ID);
  fs.mkdirSync(dataDir, { recursive: true });
  try {
    fs.copyFileSync(LIVE_DATA, path.join(dataDir, "data.json"));
  } catch (e) {}
  res.open = store.openAppWindow(APP_ID);
  const all = BrowserWindow.getAllWindows();
  const win = all[all.length - 1];
  win.on("closed", () => logs.push("win-closed"));
  win.webContents.on("render-process-gone", (e, d) => logs.push("render-gone " + JSON.stringify(d)));
  win.webContents.on("unresponsive", () => logs.push("unresponsive"));
  win.webContents.on("console-message", (a, b) => {
    try {
      const m = typeof a === "object" && a && a.message != null ? a.message : b;
      logs.push("console: " + String(m).slice(0, 300));
    } catch (e) {}
  });
  try {
    win.setBounds({ x: 80, y: 60, width: 700, height: 860 });
    win.focus();
    win.show();
  } catch (e) {}
  await sleep(3000);
  const state = async () =>
    JSON.parse(
      await win.webContents.executeJavaScript(
        `JSON.stringify({ tiles: document.querySelectorAll("#board .tile").length, filled: document.querySelectorAll("#board .tile.filled").length, boardHtmlLen: (document.getElementById("board")||{innerHTML:""}).innerHTML.length, toast: String((document.getElementById("toast")||{}).textContent||""), foot: String((document.getElementById("footSave")||{}).textContent||""), active: String((document.activeElement&&document.activeElement.id)||"") })`,
      ),
    );
  res.before = await state();
  await win.webContents.executeJavaScript(`(() => {
    window.__kd = { n: 0, keys: [], err: [] };
    document.addEventListener("keydown", (ev) => { window.__kd.n++; if (window.__kd.keys.length < 40) window.__kd.keys.push(String(ev.key) + "@" + Date.now()); }, true);
    document.addEventListener("backspace", () => {}, true);
    window.addEventListener("error", (e) => window.__kd.err.push(String((e && e.message) || e)));
    return "ok";
  })()`);
  /* 合成键作对照（页面内直接派发，必然到应用处理器） */
  const synthBefore = await state();
  await win.webContents.executeJavaScript(`(async () => { for (let i = 0; i < 3; i++) { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true })); await new Promise((r) => setTimeout(r, 120)); } return 1; })()`);
  await sleep(400);
  const synthAfter = await state();
  /* 真键 */
  const planPath = path.join(TMP, "plan.json");
  const donePath = path.join(TMP, "done.json");
  fs.writeFileSync(planPath, JSON.stringify({ pid: process.pid, keys: [8, 8, 8, 8, 8] }), "utf8");
  const ps1 = path.join(TMP, "keys.ps1");
  fs.writeFileSync(ps1, PS1, "utf8");
  const pss = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", ps1, "-Plan", planPath, "-Done", donePath], { encoding: "utf8", timeout: 60000, windowsHide: true });
  await sleep(1200);
  const realAfter = await state();
  res.synth = { before: synthBefore, after: synthAfter };
  res.realAfter = realAfter;
  res.kd = JSON.parse(await win.webContents.executeJavaScript(`JSON.stringify(window.__kd)`));
  res.sent = fs.existsSync(donePath) ? JSON.parse(fs.readFileSync(donePath, "utf8")) : [];
  res.psStatus = pss.status;
  res.psErr = pss.stderr ? String(pss.stderr).slice(0, 400) : "";
  res.selfPid = process.pid;
  res.logs = logs.slice(-40);
  writeOut(res);
  app.exit(0);
}

app.whenReady().then(() => {
  const guard = setTimeout(() => {
    writeOut({ error: "超时 90s", tmp: TMP, logs: logs.slice(-20) });
    app.exit(3);
  }, 90000);
  main()
    .then(() => clearTimeout(guard))
    .catch((e) => {
      clearTimeout(guard);
      writeOut({ error: String((e && e.message) || e), stack: String((e && e.stack) || "").slice(0, 1200), tmp: TMP, logs: logs.slice(-20) });
      app.exit(1);
    });
});
