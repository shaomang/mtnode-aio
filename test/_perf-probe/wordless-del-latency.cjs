/* test/_perf-probe/wordless-del-latency.cjs —— wordless「启动后退格卡顿」量测
 *
 * 现场症状：应用独立窗口里，启动后按 删除（退格）会卡；开发页中栏预览里顺。
 * 预览那条路**一个字节都不写盘**（同一应用已开独立窗口时预览是只读的），独立窗口那条每次
 * 操作都走 store.set → 防抖 → appHost.dataWrite → 真 apps-store 落盘。
 *
 * 本脚本用真应用窗口（真 preload-app.js + 真 apps-store 内核）跑三种**写通道**，其余一切相同：
 *   disk   appHost.dataWrite 原样（= 真落盘，主进程 JSON.stringify + writeFileSync + rename）
 *   stub   appHost.dataWrite 换成同形状的立即回 ok（一个字节不写 = 预览那条路的写代价）
 *   delay  在 stub 上再压 40ms 才回（量「宿主慢」时输入到底会不会被拖住）
 * 每种跑法量：
 *   ① 逐操作时延：应用自己的 backspace / typeLetter 各 18 次（直接取页面内 performance.now）
 *   ② 真 OS 键：PowerShell SendInput 发真字母 / 真退格，量「发出 → 棋子 DOM 真变」的端到端时延
 *   ③ 主线程帧间隔（jank）、dataWrite 往返分布、实际落盘次数与字节
 *   ④ 冷启动：从 openAppWindow 到「有 run 且可输入」的时长（分阶段打点）
 *
 * 用法：electron test\_perf-probe\wordless-del-latency.cjs [appDir] [out.json] [modes]
 * 纪律：应用副本 / 数据目录 / userData 全在系统临时目录；不碰真应用、不碰 %APPDATA%、不改仓库文件。
 */
const { app, BrowserWindow } = require("electron");
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const SRC_APP = String(process.argv[2] || "E:\\mtnode\\apps\\dev\\wordless");
const OUT = String(process.argv[3] || path.join(os.tmpdir(), "wordless-del-latency.json"));
const MODES = String(process.argv[4] || "disk,stub").split(",").filter(Boolean);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "wordless-del-"));
app.setPath("userData", path.join(TMP, "ud"));
/* 关掉一只应用窗口不该结束本进程（默认行为会在最后一个窗口关掉时退出 → 后面几个模式全丢） */
app.on("window-all-closed", () => {});
const DATA = path.join(TMP, "data");
const APP_ID = "wordless-probe";
const STAGE_LOG = path.join(TMP, "stage.log");
const LIVE_DATA = "C:\\Users\\shaom\\AppData\\Roaming\\pipeline-console\\pipeline-console\\apps-data\\dev\\wordless\\data.json";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 崩溃 / 异常退出也必须留痕：写到 stage.log，免得只剩「进程没了」 */
process.on("uncaughtException", (e) => {
  try {
    fs.appendFileSync(STAGE_LOG, "uncaughtException " + String((e && e.stack) || e) + "\n", "utf8");
  } catch (x) {}
});
process.on("exit", (code) => {
  try {
    fs.appendFileSync(STAGE_LOG, "exit " + code + " stage=" + STAGE + "\n", "utf8");
  } catch (x) {}
});

let STAGE = "boot";
function stage(s, extra) {
  STAGE = s;
  try {
    fs.appendFileSync(STAGE_LOG, s + (extra ? " " + JSON.stringify(extra) : "") + "\n", "utf8");
  } catch (e) {}
}
function writeOut(o) {
  try {
    fs.writeFileSync(OUT, JSON.stringify(o, null, 2), "utf8");
    console.log("[out] " + OUT);
  } catch (e) {
    console.log("[out FAIL] " + String((e && e.message) || e));
  }
}

/* 真落盘计数：只数应用数据文件的 JSON 写（tmp 与最终都算） */
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

stage("require apps-store");
let store = null;
try {
  store = require(path.join(ROOT, "apps-store.js"));
  store.registerAppsIpc({
    getDataDir: () => DATA,
    getMainWin: () => null,
    t: (s) => String(s),
    authState: () => ({ loggedIn: false }),
    getAppVersion: () => "0.0.0-probe",
  });
  store.setRoot(path.join(TMP, "apps-root"));
  stage("apps-store ready");
} catch (e) {
  stage("apps-store failed", { err: String((e && e.message) || e) });
}

function copyApp(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (/^_verify$/i.test(e.name) || /\.zip$/i.test(e.name)) continue;
    if (e.isDirectory()) copyApp(path.join(src, e.name), path.join(dst, e.name));
    else fs.copyFileSync(path.join(src, e.name), path.join(dst, e.name));
  }
}

/* ── 页面探针（在应用主世界 eval） ── */
const PROBE = `(() => {
  const P = { marks: [], mut: [], frames: [], writes: [], phase: "" };
  window.__p = P;
  P.t0 = { perf: performance.now(), date: Date.now() };
  P.now = () => ({ perf: +performance.now().toFixed(2), date: Date.now() });
  P.mark = (k) => { P.marks.push(Object.assign({ k: k, ph: P.phase }, P.now())); if (P.marks.length > 5000) P.marks.splice(0, 2500); };
  try {
    const ob = new MutationObserver((list) => {
      const rec = P.now();
      for (const m of list) {
        const t = m.target;
        if (!t || !t.classList || !t.classList.contains("tile")) continue;
        P.mut.push(Object.assign({ cls: String(t.className), txt: String(t.textContent || ""), kind: m.type }, rec));
      }
      if (P.mut.length > 8000) P.mut.splice(0, 4000);
    });
    ob.observe(document.body, { subtree: true, attributes: true, childList: true, characterData: true, attributeFilter: ["class"] });
  } catch (e) {}
  /* 操作 ↔ 绘制配对：应用每次操作都会 render() 重建棋子格，所以「操作后第一条棋子变化」
     就是这次操作的绘制落点。用**同一个时钟**（页面 performance.now）算，免得跨进程对时。
     每次操作前打一个 start 标记，之后的第一条 mut 与它配对 → opToPaintMs。 */
  P.opStart = 0;
  P.pairs = [];
  P.syncPairs = () => {
    const marks = P.marks.filter((m) => m.k === "opstart");
    for (const m of marks) {
      const hit = P.mut.find((x) => x.perf >= m.perf);
      if (hit) P.pairs.push({ at: m.perf, toPaint: +(hit.perf - m.perf).toFixed(2), ph: m.ph, tag: m.tag || "" });
    }
    P.marks = P.marks.filter((m) => m.k !== "opstart");
    return P.pairs.slice(-200);
  };
  const ftick = (now) => { P.frames.push(+now.toFixed(1)); if (P.frames.length > 12000) P.frames.splice(0, 6000); requestAnimationFrame(ftick); };
  requestAnimationFrame(ftick);
  document.addEventListener("keydown", (ev) => { if (P.phase === "realkeys") P.marks.push(Object.assign({ k: "kd:" + ev.key }, P.now())); }, true);
  P.wrapWrite = (mode) => {
    if (!window.appHost || P.wrapped) return "already";
    P.wrapped = 1;
    P.mode = mode;
    const raw = window.appHost.dataWrite.bind(window.appHost);
    window.appHost.dataWrite = async function (d, o) {
      const a = performance.now();
      let r;
      if (mode === "stub" || mode === "delay") {
        if (mode === "delay") await new Promise((res) => setTimeout(res, 40));
        r = { ok: true, bytes: 0, stub: true };
      } else r = await raw(d, o);
      P.writes.push({ ms: +(performance.now() - a).toFixed(2), bytes: r && r.bytes ? r.bytes : 0 });
      return r;
    };
    return "ok";
  };
  return "ok";
})()`;

/* 逐操作：直接调应用自己的输入函数（= keydown 处理器调的那两个），全程 performance.now */
const PER_OP = `(async () => {
  const P = window.__p;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const stat = (a) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); const q = (p) => s[Math.min(s.length - 1, Math.max(0, Math.floor(s.length * p)))];
    return { n: s.length, p50: +q(0.5).toFixed(2), p95: +q(0.95).toFixed(2), max: +s[s.length - 1].toFixed(2) }; };
  const fire = (key) => document.dispatchEvent(new KeyboardEvent("keydown", { key: key, bubbles: true, cancelable: true }));
  const fireOp = (key, tag) => {
    P.marks.push({ k: "opstart", ph: P.phase, tag: tag || key, perf: +performance.now().toFixed(2), date: Date.now() });
    fire(key);
  };
  const letters = "abcdefghijklmnopqrstuvwxyz";
  const type = [], del = []; const ops = [];
  P.phase = "perop";
  /* 冷启动那一下单独取：首帧 / 首次输入往往最贵（音频上下文、字体、样式首算） */
  const first = { type: null, del: null };
  let a0 = performance.now();
  fire(letters[0]);
  first.type = +(performance.now() - a0).toFixed(2);
  await sleep(800);
  a0 = performance.now();
  fire("Backspace");
  first.del = +(performance.now() - a0).toFixed(2);
  await sleep(800);
  for (let i = 0; i < 36; i++) {
    const isDel = i % 2 === 1;
    const a = performance.now();
    if (isDel) fireOp("Backspace", "main" + i); else fireOp(letters[i % 26], "main" + i);
    const ms = +(performance.now() - a).toFixed(2);
    (isDel ? del : type).push(ms);
    ops.push({ i: i, op: isDel ? "del" : "type", ms: ms });
    await sleep(i % 6 === 5 ? 800 : 40);
  }
  await sleep(2500);
  const opPairs = P.syncPairs();
  /* 键盘上那排按钮（鼠标点击那条路）：量 click 到 render 完的耗时 */
  const keys = document.querySelectorAll("#keyboard .key");
  const clicks = [];
  for (let i = 0; i < 12 && i < keys.length; i++) {
    const b = keys[i] || keys[0];
    const a = performance.now();
    try { b.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); } catch (e) {}
    clicks.push(+(performance.now() - a).toFixed(2));
    await sleep(40);
  }
  await sleep(1200);
  /* 帧延迟：连按退格期间「这一帧到下一帧」的间隔（主线程被占住会拉大） */
  const lag = [];
  let last = performance.now();
  for (let i = 0; i < 90; i++) {
    await new Promise((r) => requestAnimationFrame(r));
    const now = performance.now();
    lag.push(+(now - last).toFixed(2));
    last = now;
  }
  const burst = [];
  const t0 = performance.now();
  while (performance.now() - t0 < 1500) {
    const a = performance.now();
    fire("Backspace");
    burst.push(+(performance.now() - a).toFixed(2));
    await new Promise((r) => setTimeout(r, 16));
  }
  await sleep(1500);
  return {
    first: first,
    typeMs: stat(type), delMs: stat(del), ops: ops,
    clickMs: stat(clicks),
    frameLag: stat(lag),
    burstMs: stat(burst), burstN: burst.length,
    opToPaint: stat((opPairs || []).map((p) => p.toPaint)),
    writes: (P.writes || []).length, writeMs: stat((P.writes || []).map((w) => w.ms)), lastWrite: (P.writes || []).slice(-1)[0] || null,
  };
})()`;

/* 真 OS 键（PowerShell SendInput）：量「发出 → 棋子真变」 */
const PS1 = `
param([string]$Plan, [string]$Done)
Add-Type -Namespace W -Name U -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
[DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
'@
$raw = [System.IO.File]::ReadAllText($Plan, [System.Text.Encoding]::UTF8)
$doc = ConvertFrom-Json -InputObject $raw
$proc = Get-Process -Id ([int]$doc.pid) -ErrorAction SilentlyContinue
if ($proc -and $proc.MainWindowHandle -ne 0) { [void][W.U]::SetForegroundWindow($proc.MainWindowHandle); Start-Sleep -Milliseconds 600 }
$rows = New-Object System.Collections.ArrayList
foreach ($c in @($doc.keys)) {
  $t0 = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  [W.U]::keybd_event([byte][int]$c, 0, 0, [UIntPtr]::Zero)
  [W.U]::keybd_event([byte][int]$c, 0, 2, [UIntPtr]::Zero)
  [void]$rows.Add([pscustomobject]@{ vk = [int]$c; sentMs = [double]$t0 })
  Start-Sleep -Milliseconds 280
}
$txt = ConvertTo-Json -InputObject @($rows) -Depth 3
[System.IO.File]::WriteAllText($Done, [string]$txt, (New-Object System.Text.UTF8Encoding($false)))
`;

const VK = { B: 0x42, O: 0x4f, K: 0x4b, C: 0x43, H: 0x48, A: 0x41, I: 0x49, R: 0x52, BACK: 0x08 };
const KEY_SEQ = ["B", "O", "O", "K", "BACK", "BACK", "BACK", "BACK", "C", "H", "A", "I", "R", "BACK", "BACK"];

async function realKeyPass(win) {
  await win.webContents.executeJavaScript(`(() => { const P = window.__p; P.phase = "realkeys"; P.mut = []; P.marks = []; P.frames = []; return "ok"; })()`);
  const planPath = path.join(TMP, "plan.json");
  const donePath = path.join(TMP, "done.json");
  fs.writeFileSync(planPath, JSON.stringify({ pid: process.pid, keys: KEY_SEQ.map((k) => VK[k]) }), "utf8");
  const ps1 = path.join(TMP, "keys.ps1");
  fs.writeFileSync(ps1, PS1, "utf8");
  const t0 = Date.now();
  const ps = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", ps1, "-Plan", planPath, "-Done", donePath], { encoding: "utf8", timeout: 120000, windowsHide: true });
  const sent = fs.existsSync(donePath) ? JSON.parse(fs.readFileSync(donePath, "utf8")) : [];
  await sleep(1500);
  const page = JSON.parse(
    await win.webContents.executeJavaScript(
      `(() => { const P = window.__p; return JSON.stringify({ mut: P.mut.slice(-800), frames: P.frames.slice(-2000), marks: P.marks.slice(-200) }); })()`,
    ),
  );
  const nameOf = (vk) => (vk === 8 ? "Backspace" : String.fromCharCode(vk).toLowerCase());
  const e2e = [];
  for (const s of sent) {
    const want = Number(s.sentMs);
    const hit = page.mut.find((m) => m.date >= want);
    const kd = page.marks.find((m) => m.date >= want - 3 && String(m.k) === "kd:" + nameOf(s.vk));
    e2e.push({
      key: nameOf(s.vk),
      paintMs: hit ? +(hit.date - want).toFixed(1) : null,
      cls: hit ? hit.cls : "",
      keydownMs: kd ? +(kd.date - want).toFixed(1) : null,
    });
  }
  const vals = e2e.map((e) => e.paintMs).filter((v) => v != null).sort((a, b) => a - b);
  const kdvals = e2e.map((e) => e.keydownMs).filter((v) => v != null).sort((a, b) => a - b);
  return {
    psStatus: ps.status,
    psErr: ps.stderr ? String(ps.stderr).slice(0, 300) : "",
    spanMs: Date.now() - t0,
    e2e: e2e,
    paintStat: vals.length ? { n: vals.length, p50: vals[Math.floor(vals.length / 2)], max: vals[vals.length - 1] } : null,
    keydownStat: kdvals.length ? { n: kdvals.length, p50: kdvals[Math.floor(kdvals.length / 2)], max: kdvals[kdvals.length - 1] } : null,
    nmut: page.mut.length,
  };
}

function frameStat(list) {
  const g = [];
  const a = list.slice().sort((x, y) => x - y);
  return { p50: a[Math.floor(a.length / 2)] || 0, p95: a[Math.floor(a.length * 0.95)] || 0, max: a[a.length - 1] || 0 };
}
function gapsOf(t) {
  const g = [];
  for (let i = 1; i < t.length; i++) g.push(+(t[i] - t[i - 1]).toFixed(1));
  return g;
}

function seedData(bloat) {
  const dir = path.join(DATA, "apps-data", "dev", APP_ID);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  let ok = false;
  let bytes = 0;
  try {
    const src = fs.existsSync(LIVE_DATA) ? fs.readFileSync(LIVE_DATA, "utf8") : "";
    let body = src;
    if (src && bloat) {
      /* 「玩久了」那种存档：把这一轮的猜测历史撑到几百 KB（应用存档没有大小上限，
         只有宿主那道 2MB 的闸），用来量「存档越大 → 每次退格越卡」这条假设。 */
      const j = JSON.parse(src);
      const words = ["about", "chair", "books", "light", "stone", "water", "house"];
      const pool = [];
      for (let i = 0; i < 6000; i++) {
        pool.push({ word: words[i % words.length], marks: ["absent", "present", "absent", "exact", "absent"] });
      }
      j.run.rounds[j.run.index].guesses = pool;
      j.big = "x".repeat(2000);
      body = JSON.stringify(j);
    }
    fs.writeFileSync(path.join(dir, "data.json"), body, "utf8");
    bytes = Buffer.byteLength(body);
    ok = !!body;
  } catch (e) {}
  return { dir: dir, seeded: ok, bytes: bytes };
}

async function runMode(mode) {
  writeLog.length = 0;
  stage("seed", { mode: mode });
  const seed = seedData(mode.indexOf("big") === 0);
  const res = { mode: mode, seeded: seed.seeded, seedBytes: seed.bytes, dataDir: seed.dir };
  const tOpen = Date.now();
  const r = store.openAppWindow(APP_ID);
  res.open = { ok: r && r.ok, reused: !!(r && r.reused), error: (r && r.error) || "" };
  const all = BrowserWindow.getAllWindows();
  const win = all[all.length - 1];
  stage("window", { mode: mode, wins: all.length, destroyed: win ? win.isDestroyed() : null });
  if (!win) return Object.assign(res, { error: "没拿到窗口" });
  res.openToWindowMs = Date.now() - tOpen;
  win.on("closed", () => stage("win-closed", { mode: mode }));
  win.webContents.on("render-process-gone", (ev, d) => stage("render-gone", { mode: mode, d: d }));
  win.webContents.on("unresponsive", () => stage("win-unresponsive", { mode: mode }));
  win.webContents.on("console-message", (a, b) => {
    try {
      const msg = typeof a === "object" && a && a.message != null ? a.message : b;
      const lvl = typeof a === "object" && a && a.level != null ? a.level : "";
      stage("page-console", { mode: mode, lvl: String(lvl), msg: String(msg).slice(0, 200) });
    } catch (e) {}
  });
  try {
    win.setBounds({ x: 60, y: 40, width: 700, height: 860 });
  } catch (e) {}
  try {
    win.focus();
  } catch (e) {}
  /* 冷启动打点：等应用自己就位（棋子出现 = render 跑过一轮） */
  let boot = null;
  for (let i = 0; i < 60; i++) {
    boot = await win.webContents
      .executeJavaScript(
        `(() => ({ tiles: document.querySelectorAll("#board .tile").length, hasHost: !!(window.appHost && window.appHost.dataWrite), foot: String((document.getElementById("footSave")||{}).textContent||""), toasts: String((document.getElementById("toast")||{}).textContent||"") }))()`,
      )
      .catch((e) => ({ err: String(e.message) }));
    if (boot && boot.tiles > 0) break;
    await sleep(200);
  }
  res.boot = boot;
  res.bootMs = Date.now() - tOpen;
  /* 装探针 + 换写通道 */
  try {
    res.probe = await win.webContents.executeJavaScript(PROBE);
    res.wrap = await win.webContents.executeJavaScript(`window.__p.wrapWrite(${JSON.stringify(mode === "disk" ? "disk" : mode)})`);
  } catch (e) {
    res.probeErr = String((e && e.message) || e);
  }
  await sleep(600);
  /* mainblock 模式：主进程连着做「读 + 解析 + 序列化 70MB JSON」——
     本机 config.json 已经长到 70MB（其中 agentSessions 48MB），一发读 180ms、解析 118ms 级。
     用它验证假设：主进程被这种同步大 JSON 占住时，应用窗口的输入处理会不会被拖慢。 */
  if (mode === "mainblock") {
    const big = path.join(TMP, "big.json");
    if (!fs.existsSync(big)) {
      const blob = { v: 1, pad: "x".repeat(1024), arr: [] };
      for (let i = 0; i < 60000; i++) blob.arr.push({ i: i, t: "s" + i, f: i % 7 === 0, w: (i % 997) / 3 });
      fs.writeFileSync(big, JSON.stringify(blob), "utf8");
    }
    res.bigBytes = fs.statSync(big).size;
    setInterval(() => {
      try {
        JSON.stringify(JSON.parse(fs.readFileSync(big, "utf8")));
      } catch (e) {}
    }, 150);
    res.blockerStarted = true;
  }
  await sleep(1500);
  try {
    res.real = await realKeyPass(win);
  } catch (e) {
    res.real = { err: String((e && e.message) || e) };
  }
  /* 再逐操作一趟 */
  try {
    res.perOp = await win.webContents.executeJavaScript(PER_OP);
  } catch (e) {
    res.perOp = { err: String((e && e.message) || e) };
  }
  try {
    const fr = JSON.parse(await win.webContents.executeJavaScript(`JSON.stringify(window.__p.frames.slice(-3000))`));
    const g = gapsOf(fr);
    res.frameGaps = Object.assign({ n: g.length, over33: g.filter((x) => x > 33).length }, frameStat(g));
  } catch (e) {
    res.frameGaps = { err: String((e && e.message) || e) };
  }
  res.diskWrites = writeLog.length;
  res.diskBytes = writeLog.reduce((a, b) => a + b.bytes, 0);
  res.diskSample = writeLog.slice(0, 5);
  try {
    res.savedOnDisk = fs.statSync(path.join(seed.dir, "data.json")).size;
  } catch (e) {
    res.savedOnDisk = 0;
  }
  stage("close", { mode: mode });
  try {
    store.closeAppWindow(APP_ID);
  } catch (e) {}
  await sleep(600);
  return res;
}

async function main() {
  const res = { app: SRC_APP, out: OUT, tmp: TMP, modes: MODES, cases: [] };
  if (!store) {
    writeOut(Object.assign(res, { error: "apps-store 加载失败" }));
    return app.exit(2);
  }
  const appDir = path.join(DATA, "apps-dev", APP_ID);
  stage("copyApp");
  copyApp(SRC_APP, appDir);
  fs.writeFileSync(
    path.join(appDir, "app.json"),
    JSON.stringify({ schema: 1, id: APP_ID, name: "wordless probe", title: "Wordless probe", version: "0.0.0", entry: "index.html", dev: true }, null, 2),
    "utf8",
  );
  res.appDir = appDir;
  stage("cases");
  for (const m of MODES) {
    stage("case", { mode: m });
    try {
      res.cases.push(await runMode(m));
    } catch (e) {
      res.cases.push({ mode: m, error: String((e && e.message) || e), stack: String((e && e.stack) || "").slice(0, 1500) });
    }
  }
  stage("done");
  writeOut(res);
  app.exit(0);
}

app.whenReady().then(() => {
  const guard = setTimeout(() => {
    writeOut({ error: "超时（300s）", stage: STAGE, tmp: TMP });
    app.exit(3);
  }, 300000);
  main()
    .then(() => clearTimeout(guard))
    .catch((err) => {
      clearTimeout(guard);
      writeOut({ error: String((err && err.message) || err), stage: STAGE, stack: String((err && err.stack) || "").slice(0, 2000), tmp: TMP });
      app.exit(1);
    });
});
