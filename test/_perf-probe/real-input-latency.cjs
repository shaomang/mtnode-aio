/* test/_perf-probe/real-input-latency.cjs —— 用**真 OS 鼠标输入**量「右键那一下」的响应时延
 *
 * 为什么要这一版：所有走 webContents.sendInputEvent 的探针（含 hand-vs-preview.cjs）都在
 * **合成输入这一层就把差别抹平了** —— 合成事件不会走 Windows 的原生右键消息
 * （WM_RBUTTONDOWN / WM_CONTEXTMENU → Electron 的 context-menu 那条链），而真窗口与预览
 * iframe 恰恰可能在那一层分叉。这一版用 SendInput（PowerShell 侧）发**真**输入：
 *
 *   1) 本脚本（Electron）把应用页装进一只真应用窗口（真 preload-app.js / 真 appHost），
 *      页面里埋一只探针：记录每个「未翻开格」的视口矩形 + MutationObserver 记下**每一次
 *      格子 DOM 变化**的时刻与类名变化（插旗 = classList 里出现 flag / 数字 / 翻开）；
 *   2) 探针把一批目标格子（视口内、还没插旗的）写成 JSON 落到 out.json.pending；
 *   3) 脚本调 PowerShell 子进程（win-input.ps1）用 SetCursorPos + SendInput 对每个格子发
 *      **真右键**（记录发之前、之后的 process.hrtime 时间戳）；
 *   4) 页面把「最近 N 次格子变化」的真实时刻（performance.now + Date.now 双时间轴）写回；
 *   5) 脚本把「发输入那一刻」与「页面里格子真变的那一刻」对起来 → 每一个手势的端到端时延。
 *
 * 用法（项目根）：
 *   electron test\_perf-probe\real-input-latency.cjs [right|left] [appDir] [out.json]
 * 纪律：只读量测，不改应用文件；userData 落系统临时目录；真输入只对本进程自己开的窗口发。
 */
const { app, BrowserWindow } = require("electron");
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const BUTTON = String(process.argv[2] || "right");
const APP_DIR = String(process.argv[3] || "E:\\mtnode\\apps\\dev\\minesweeper");
const OUT = String(process.argv[4] || path.join(os.tmpdir(), "mtnode-realin-" + BUTTON + ".json"));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mtnode-realin-"));
app.setPath("userData", path.join(TMP, "ud"));
const fileUrl = (p) => "file:///" + String(p).replace(/\\/g, "/");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PROBE = `(() => {
  if (window.__r) return "already";
  const R = { mut: [], frames: [], marks: {} }; window.__r = R;
  R.info = { dpr: devicePixelRatio, w: innerWidth, h: innerHeight, href: location.href };
  R.sync = () => { R.marks = { perf: performance.now(), date: Date.now() }; };
  try {
    const ob = new MutationObserver((list) => {
      for (const m of list) {
        const t = m.target;
        if (!t || !t.classList || !t.classList.contains("cell")) continue;
        R.mut.push({ perf: +performance.now().toFixed(2), date: Date.now(), i: String(t.dataset.i || ""), cls: String(t.className), attr: m.attributeName || "", kind: m.type });
      }
      if (R.mut.length > 4000) R.mut.splice(0, R.mut.length - 4000);
    });
    ob.observe(document.body, { subtree: true, attributes: true, childList: true, attributeFilter: ["class", "style", "data-st"] });
  } catch (e) {}
  window.__rFrames = (ms) => new Promise((res) => { const t = []; let last = performance.now(); const end = last + ms;
    const step = (now) => { t.push(+(now - last).toFixed(2)); last = now; if (now < end) requestAnimationFrame(step); else res(t); }; requestAnimationFrame(step); });
  R.frames = [];
  const ftick = (now) => { R.frames.push(+now.toFixed(1)); if (R.frames.length > 6000) R.frames.splice(0, 3000); requestAnimationFrame(ftick); };
  requestAnimationFrame(ftick);
  window.__rTargets = (n) => {
    const out = [];
    const cells = document.querySelectorAll(".world .cell, .cell");
    for (const d of cells) {
      if (out.length >= (n || 6)) break;
      const q = d.getBoundingClientRect();
      if (q.width < 6 || q.height < 6) continue;
      if (q.left < 30 || q.top < 130 || q.right > innerWidth - 30 || q.bottom > innerHeight - 30) continue;
      if (d.classList.contains("flag") || d.classList.contains("open") || d.classList.contains("rv")) continue;
      out.push({ i: String(d.dataset.i || ""), x: Math.round(q.left + q.width / 2), y: Math.round(q.top + q.height / 2), cls: String(d.className) });
    }
    return out;
  };
  return "ok";
})()`;

function writeOut(obj) {
  try {
    fs.writeFileSync(OUT, JSON.stringify(obj, null, 2), "utf8");
  } catch (e) {}
}

/* PowerShell 侧的真输入脚本：SetCursorPos + SendInput（右键 / 左键各一次），带标记文件 */
const PS1 = `
param([string]$Plan, [string]$Done)
Add-Type -Namespace W -Name U -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
[DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
'@
$LDOWN = 0x0002; $LUP = 0x0004; $RDOWN = 0x0008; $RUP = 0x0010;
# 两个坑（都是 Windows PowerShell 5.1 的）：
#   ① 变量名别用 $plan —— 它是 PS 的自动变量（当前进程对象，System.Diagnostics.Process），
#      赋值会被静默忽略，于是 ConvertFrom-Json 的入参变成进程对象 → 后面全空。
#   ② 写回别用 Set-Content（带 BOM，Node 侧 JSON.parse 会炸），走 .NET WriteAllText 无 BOM。
$raw = [System.IO.File]::ReadAllText($Plan, [System.Text.Encoding]::UTF8)
$doc = ConvertFrom-Json -InputObject $raw
$proc = Get-Process -Id ([int]$doc.pid) -ErrorAction SilentlyContinue
if ($proc -and $proc.MainWindowHandle -ne 0) {
  [W.U]::SetForegroundWindow($proc.MainWindowHandle) | Out-Null
  Start-Sleep -Milliseconds 350
}
$rows = New-Object System.Collections.ArrayList
foreach ($it in @($doc.targets)) {
  [W.U]::SetCursorPos([int]$it.x, [int]$it.y) | Out-Null
  Start-Sleep -Milliseconds 60
  $t0 = [DateTime]::UtcNow.Ticks
  if ($doc.button -eq 'right') { [W.U]::mouse_event($RDOWN,0,0,0,[UIntPtr]::Zero); [W.U]::mouse_event($RUP,0,0,0,[UIntPtr]::Zero) }
  else { [W.U]::mouse_event($LDOWN,0,0,0,[UIntPtr]::Zero); [W.U]::mouse_event($LUP,0,0,0,[UIntPtr]::Zero) }
  $t1 = [DateTime]::UtcNow.Ticks
  $fg = [W.U]::GetForegroundWindow()
  $fgPid = [uint32]0
  [void][W.U]::GetWindowThreadProcessId($fg, [ref]$fgPid)
  [void]$rows.Add([pscustomobject]@{ i = [string]$it.i; x = [int]$it.x; y = [int]$it.y; sentUtcMs = [double]([DateTimeOffset]::new($t0, [TimeSpan]::Zero).ToUnixTimeMilliseconds()); sentUtcMs2 = [double]([DateTimeOffset]::new($t1, [TimeSpan]::Zero).ToUnixTimeMilliseconds()); fgPid = [int]$fgPid })
  Start-Sleep -Milliseconds 700
}
$txt = ConvertTo-Json -InputObject @($rows) -Depth 4
[System.IO.File]::WriteAllText($Done, [string]$txt, (New-Object System.Text.UTF8Encoding($false)))
`;

async function run() {
  const res = { button: BUTTON, app: APP_DIR, out: OUT };
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
  await win.loadURL(fileUrl(path.join(APP_DIR, "index.html")) + "?mode=infinite&fresh=1&diff=expert&cb=" + Date.now());
  win.setPosition(40, 40);
  win.focus();
  await win.webContents.executeJavaScript(PROBE);
  await sleep(4500);
  /* 对准窗口：把窗口放到固定位置，页面坐标 → 屏幕坐标 = 窗口内容原点 + 视口坐标 */
  const b = win.getContentBounds();
  res.content = b;
  const targets = JSON.parse(await win.webContents.executeJavaScript(`JSON.stringify(window.__rTargets(6))`));
  res.targets = targets;
  if (!targets.length) {
    writeOut(Object.assign(res, { err: "没有视口内可右键的未翻开格" }));
    app.exit(0);
    return;
  }
  const planPath = path.join(TMP, "plan.json");
  const donePath = path.join(TMP, "done.json");
  fs.writeFileSync(
    planPath,
    JSON.stringify({ pid: process.pid, button: BUTTON, targets: targets.map((t) => ({ i: t.i, x: b.x + t.x, y: b.y + t.y })) }),
    "utf8",
  );
  const ps1Path = path.join(TMP, "win-input.ps1");
  fs.writeFileSync(ps1Path, PS1, "utf8");
  /* 同步基准：同一时刻在页面里记一次（perf, date），用于把两套时钟对上 */
  const sync = JSON.parse(await win.webContents.executeJavaScript(`(() => { window.__r.sync(); return JSON.stringify(window.__r.marks); })()`));
  res.sync = sync;
  /* 发真输入（阻塞式：PowerShell 走完所有手势） */
  const t0 = Date.now();
  const ps = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", ps1Path, "-Plan", planPath, "-Done", donePath], {
    encoding: "utf8",
    timeout: 60000,
    windowsHide: true,
  });
  res.psMs = Date.now() - t0;
  res.psStatus = ps.status;
  if (ps.stderr) res.psErr = String(ps.stderr).slice(0, 800);
  const sent = fs.existsSync(donePath) ? JSON.parse(fs.readFileSync(donePath, "utf8")) : [];
  res.sent = sent;
  /* 真窗口与预览 iframe 在**主进程这一层**有没有分叉：真右键会走到 WebContents 的
     context-menu 事件（Electron 的原生菜单那条链），这一条 iframe 里的右键永远不会触发。
     把它的到达时刻与耗时也记下来（只挂监听、不 popup，不改应用行为）。 */
  const ctx = [];
  win.webContents.on("context-menu", () => {
    const t = Date.now();
    ctx.push({ at: t, sync: Date.now() - t });
  });
  await sleep(1200);
  const mut = JSON.parse(await win.webContents.executeJavaScript(`JSON.stringify(window.__r.mut.slice(-400))`));
  const frames = JSON.parse(await win.webContents.executeJavaScript(`(async () => JSON.stringify(await window.__rFrames(1000)))()`));
  res.ctxMenuEvents = ctx;
  res.ctxMenuCount = ctx.length;
  /* 帧时间轴：PS 那一段里主线程有没有被冻住（找最大帧间隔与其出现的页面时刻） */
  const tl = JSON.parse(await win.webContents.executeJavaScript(`JSON.stringify(window.__r.frames.slice(-1200))`));
  res.frameTimeline = { n: tl.length, start: tl[0], end: tl[tl.length - 1], gapMax: 0, gapAt: 0 };
  for (let i = 1; i < tl.length; i++) {
    const g = tl[i] - tl[i - 1];
    if (g > res.frameTimeline.gapMax) { res.frameTimeline.gapMax = +g.toFixed(1); res.frameTimeline.gapAt = tl[i - 1]; }
  }
  res.mutations = mut.length;
  res.mutTail = mut.slice(-30);
  res.frameMs = frames.length ? { n: frames.length, max: Math.max(...frames), over33: frames.filter((x) => x > 33).length } : null;
  /* 端到端：每条 sent 的 (页面时钟时刻) → 页面里第一条 date >= 它的格子变化 */
  const drift = sync.date - sync.perf; /* date = perf + drift */
  const pairs = [];
  const EPOCH_TICKS = 621355968000000000; /* 1970-01-01 的 .NET ticks */
  for (const s of sent) {
    /* 兼容两种口径：sentUtcMs2 若是 .NET ticks（1e17 量级）就换算成 epoch ms */
    let want = Number(s.sentUtcMs2);
    if (want > 1e14) want = (want - EPOCH_TICKS) / 10000;
    const hit = mut.find((m) => m.date >= want && m.i === s.i);
    const hitAny = mut.find((m) => m.date >= want);
    pairs.push({
      i: s.i,
      msToSameCell: hit ? +(hit.date - want).toFixed(1) : null,
      msToAny: hitAny ? +(hitAny.date - want).toFixed(1) : null,
      cls: hitAny ? hitAny.cls : "",
      clsSame: hit ? hit.cls : "",
    });
  }
  res.e2e = pairs;
  const vals = pairs.map((p) => p.msToSameCell).filter((v) => v != null);
  /* 前台进程是谁（挡住「输入打到别的窗口去了」这条误判：fgPid 应当 = 本进程 pid） */
  res.fgPids = sent.map((s) => s.fgPid);
  res.selfPid = process.pid;
  /* 这一段（从第一条输入发出到最后一格真变）在页面时钟上跨多久 —— 只有真实的队列积压才会这么大 */
  if (sent.length && mut.length) {
    const first = Number(sent[0].sentUtcMs2);
    const lastMut = mut[mut.length - 1].date;
    res.pageSpanMs = +(lastMut - first).toFixed(1);
    res.mutSpanMs = +(mut[mut.length - 1].date - mut[0].date).toFixed(1);
  }
  res.e2eStat = vals.length
    ? { n: vals.length, p50: vals.slice().sort((a, c) => a - c)[Math.floor(vals.length / 2)], max: Math.max(...vals), min: Math.min(...vals) }
    : null;
  writeOut(res);
  app.exit(0);
}

app.whenReady().then(() =>
  run().catch((err) => {
    writeOut({ button: BUTTON, error: String((err && err.message) || err), stack: String((err && err.stack) || "") });
    app.exit(1);
  }),
);
