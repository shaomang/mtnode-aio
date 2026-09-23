"use strict";
/* ============================================================
 * 桌面 / 窗口截图（主进程侧 · 零新依赖）
 * ------------------------------------------------------------
 * 为什么必须有这一层：MTNode 已有的截图能力只有「拍自己这个 webContents」
 * （`view:captureRect` → `webContents.capturePage`），够不着别的屏幕、别的窗口。
 * 函数节点里的 JS 跑在独立线程，没有 `window.api.*`，也没有任何 Electron 能力；
 * 它要截图就只能靠主进程给的桥。本模块就是那座桥的实现侧：把「屏幕 / 窗口 / 区域」
 * 三件事收成一次调用，拍完把 PNG 落盘并把路径回给调用方（路径就是图像值）。
 *
 * 口径（Windows 口径，其它平台如实降级并说明原因）：
 *   · 屏幕枚举 / 整体桌面抓取：`System.Windows.Forms.Screen` + GDI `CopyFromScreen`
 *     （多显示器虚拟桌面一并支持；region 的 x/y 是**相对被拍对象左上角**的偏移）；
 *   · 窗口枚举 / 窗口抓取：`user32!PrintWindow`（被遮挡的窗口也能拍到自己的内容），
 *     整幅同色时退回 `CopyFromScreen`（媒体播放器等自绘窗口 PrintWindow 会全黑）；
 *   · 坐标与像素一律走**物理像素**（与 PowerShell / GDI 同一坐标系，多屏缩放下也对得上）。
 *
 * 这个文件不 require electron：主进程只注入「输出目录」与「脚本执行器」，
 * 因此 test/smoke-desktop-capture.js 能在纯 Node 下把所有纯函数与计划脚本钉住。 */

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

/* 渲染层与主进程共用同一份 i18n（UMD，照 db-store / tools-store 的惯例）：
   本模块的错误文案在英文界面下同样要有译文。循环引用不存在（i18n.js 不 require 本文件）。 */
let I18n = null;
try {
  I18n = require("./renderer/i18n.js");
} catch {}
const t = (s, vars) => {
  try {
    return I18n && typeof I18n.t === "function" ? I18n.t(s, vars) : String(s);
  } catch {
    return String(s);
  }
};

/* 脚本结果行前缀：stdout 里除它以外的内容一律当噪声（PowerShell 首次加载程序集
   会往 stderr 吐 CLIXML 进度记录，stdout 也可能有管道残留）。 */
const CAPTURE_MARK = "MTNODE_CAPTURE_RESULT ";
/* 一次脚本执行的兜底超时（Add-Type 首次编译 + 多显示器全屏位图，给足） */
const DEFAULT_TIMEOUT_MS = 30000;
/* GDI 可见屏幕外框的兜底：真实显示器布局（含横向拼接的多屏）不会超出 ±8192，
   而 Windows 把最小化窗口摆在 -32000 一带 —— 用这个方框能把「藏在屏幕外」的窗口
   判成不可见。主判据仍是 user32!IsIconic（见 windows 模式脚本），这里是兜底。 */
const VIRTUAL_SCREEN_GUARD = { x: -8192, y: -8192, w: 16384, h: 16384 };
/* 一个矩形是否落在「可见屏幕范围」内：与桌面虚拟屏幕有交叠即算可见 */
function rectLooksVisible(rect, guard) {
  const g = guard || VIRTUAL_SCREEN_GUARD;
  const r = rect || {};
  const x = Number(r.x) || 0;
  const y = Number(r.y) || 0;
  const w = Number(r.width) || 0;
  const h = Number(r.height) || 0;
  if (w <= 0 || h <= 0) return false;
  if (x + w <= g.x || y + h <= g.y) return false;
  if (x >= g.x + g.w || y >= g.y + g.h) return false;
  return true;
}

/* ─ 参数归一 ─────────────────────────────────────────────────── */

function parseNum(v) {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = String(v).trim().replace(/[，、]/g, ",");
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
function parseIntOrNull(v) {
  const n = parseNum(v);
  return n == null ? null : Math.round(n);
}

/* 目标归一：中文 / 英文 / 别名都收，认不出来时返回 ""（由调用方给错误文案）。
   screen | window | all —— all = 整块虚拟桌面（所有屏幕拼一起）。 */
function normTarget(v) {
  const s = String(v == null ? "" : v).trim().toLowerCase();
  if (!s) return "";
  if (["screen", "display", "monitor", "屏幕", "显示器", "某个屏幕"].includes(s))
    return "screen";
  if (["window", "win", "窗口", "某个窗口"].includes(s)) return "window";
  if (["all", "desktop", "virtual", "全部", "所有屏幕", "整块桌面", "桌面"].includes(s))
    return "all";
  return "";
}

/* 参数归一：把渲染层 / 工具节点 / Agent 送进来的各种写法收成一份确定形状。 */
function normCaptureParams(raw) {
  const p = raw && typeof raw === "object" ? raw : {};
  const target = normTarget(p.target != null ? p.target : p.mode);
  const screen = String(
    p.screen != null ? p.screen : p.screenId != null ? p.screenId : p.display || "",
  ).trim();
  const window = String(
    p.window != null ? p.window : p.windowTitle != null ? p.windowTitle : p.title || "",
  ).trim();
  const hwnd = parseIntOrNull(p.hwnd != null ? p.hwnd : p.handle);
  const pid = parseIntOrNull(p.pid != null ? p.pid : p.processId);
  const x = parseIntOrNull(p.x);
  const y = parseIntOrNull(p.y);
  const w = parseIntOrNull(p.w != null ? p.w : p.width);
  const h = parseIntOrNull(p.h != null ? p.h : p.height);
  const clientArea = p.clientArea === true || p.client === true;
  if (!target)
    return {
      ok: false,
      error: t(
        "target 只能是 screen（某个屏幕）/ window（某个窗口）/ all（整块桌面）：拿到 " +
          JSON.stringify(p.target != null ? p.target : p.mode),
      ),
    };
  if (target === "window" && !window && !hwnd && !pid)
    return {
      ok: false,
      error: t(
        "target=window 需要 window（窗口标题关键字，可只写一部分）/ hwnd / pid 三者之一",
      ),
    };
  if ((w == null) !== (h == null))
    return {
      ok: false,
      error: t("区域要么同时给 w 与 h，要么都不给（不给 = 整屏 / 整窗）"),
    };
  if (w != null && (w <= 0 || h <= 0))
    return { ok: false, error: t("区域尺寸必须为正：拿到 ") + w + "x" + h };
  return {
    ok: true,
    target: target,
    screen: screen,
    window: window,
    hwnd: hwnd == null || hwnd <= 0 ? null : hwnd,
    pid: pid == null || pid <= 0 ? null : pid,
    /* 只给 x 不给 y 时按 0 收（「从这个位置开始的整行」这类写法不该被拒） */
    x: x == null ? 0 : x,
    y: y == null ? 0 : y,
    w: w,
    h: h,
    clientArea: clientArea,
  };
}

/* ── PowerShell 片段 ────────────────────────────────────────── */

/* 单引号字面量（内部单引号翻倍；换行等控制字符拆掉，避免脚本被拆行） */
function psQuote(s) {
  return "'" + String(s == null ? "" : s).replace(/'/g, "''").replace(/[\r\n\t]/g, " ") + "'";
}
function psNum(v, dflt) {
  const n = parseNum(v);
  return n == null ? String(dflt) : String(Math.round(n));
}
function psBool(v) {
  return v ? "$true" : "$false";
}

const PS_COMMON = `$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms`;

const PS_WINAPI = `Add-Type @"
using System;
using System.Runtime.InteropServices;
public class MtnodeWinApi {
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint f);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@`;

/* 「整幅同色」检测：PrintWindow 对自绘窗口（播放器等）常拍出全黑一张，
   这时必须退回复制屏幕，否则用户拿到一张看起来「拍成功了的黑图」。
   按网格抽样（最多 25x25 个点），够快也够准 —— 真实界面不可能处处同色。 */
const PS_BLANK_HELPER = `function Test-MtnodeBlank($bmp) {
  $w = $bmp.Width; $h = $bmp.Height
  if ($w -lt 4 -or $h -lt 4) { return $false }
  $first = $bmp.GetPixel(0, 0)
  $stepX = [Math]::Max(1, [int]($w / 24))
  $stepY = [Math]::Max(1, [int]($h / 24))
  for ($x = 0; $x -lt $w; $x += $stepX) {
    for ($y = 0; $y -lt $h; $y += $stepY) {
      $c = $bmp.GetPixel($x, $y)
      if ($c.R -ne $first.R -or $c.G -ne $first.G -or $c.B -ne $first.B) { return $false }
    }
  }
  return $true
}`;

const PS_EMIT = (expr) => `Write-Output ("${CAPTURE_MARK}" + (${expr}))`;
const PS_FAIL_PREFIX = "__MTNODE_ERR__:";

/* PowerShell 5.1 单行 if：写成 $(if (...) { A } else { B }) 会被解析器拒，
   所以统一用「先赋值后覆盖」的显式 if 语句。 */
function psIfNum(name, cond, thenVal, elseVal) {
  return `$${name} = ${elseVal}\nif (${cond}) { $${name} = ${thenVal} }`;
}

/* 计划脚本（纯文本，可断言）：mode = screens | windows | capture。
   截图目标与区域都直接拼进脚本体（值全部经 psQuote / psNum 收口），
   不经命令行传参 —— 少一类引号与 -File 路径坑。 */
function buildPowerShell(mode, p) {
  const m = String(mode || "capture");
  const opt = p && typeof p === "object" ? p : {};

  if (m === "screens") {
    return `${PS_COMMON}
$list = @()
foreach ($s in @([System.Windows.Forms.Screen]::AllScreens)) {
  $list += [pscustomobject]@{
    index = $list.Count
    deviceName = [string]$s.DeviceName
    primary = [bool]$s.Primary
    x = [int]$s.Bounds.X
    y = [int]$s.Bounds.Y
    width = [int]$s.Bounds.Width
    height = [int]$s.Bounds.Height
  }
}
${PS_EMIT("@{ ok = $true; screens = @($list) } | ConvertTo-Json -Depth 6 -Compress")}`;
  }

  if (m === "windows") {
    return `${PS_COMMON}
${PS_WINAPI}
$rows = New-Object System.Collections.ArrayList
foreach ($p in [System.Diagnostics.Process]::GetProcesses()) {
  $h = [IntPtr]::Zero
  try { $h = $p.MainWindowHandle } catch { continue }
  if ($h -eq [IntPtr]::Zero) { continue }
  $t = ""
  try { $t = [string]$p.MainWindowTitle } catch {}
  if ($t.Trim() -eq "") { continue }
  $r = New-Object MtnodeWinApi+RECT
  if (-not [MtnodeWinApi]::GetWindowRect($h, [ref]$r)) { continue }
  $pn = ""
  try { $pn = [string]$p.ProcessName } catch {}
  $mini = $false
  try { $mini = [MtnodeWinApi]::IsIconic($h) } catch { $mini = $false }
  [void]$rows.Add([pscustomobject]@{
    hwnd = [int64]$h
    pid = [int]$p.Id
    process = $pn
    title = $t
    x = [int]$r.Left
    y = [int]$r.Top
    width = [int]($r.Right - $r.Left)
    height = [int]($r.Bottom - $r.Top)
    minimized = [bool]$mini
  })
}
${PS_EMIT("@{ ok = $true; windows = @($rows) } | ConvertTo-Json -Depth 6 -Compress")}`;
  }

  if (m !== "capture")
    return `${PS_COMMON}
Write-Output ("${CAPTURE_MARK}" + (@{ ok = $false; error = ${psQuote(t("未知截图模式：") + m)} } | ConvertTo-Json -Compress))`;

  const regionGiven = opt.w != null && opt.h != null;
  /* 脚本里的中文原因同样过 i18n（英文界面下模型 / 用户看到的是英文）：
     这些字面量是**脚本文本**，所以在这里 t() 一次、直接拼进字符串。 */
  const msg = {
    noWindow: t("没找到匹配的窗口（关键字 / hwnd / pid 都对不上）："),
    noScreen: t("没有匹配的屏幕（屏幕 id / 名称 / 序号都对不上）："),
    minimized: t("这个窗口当前最小化了（最小化的窗口拍出来只会是黑图）：先把它显示出来再拍 —— "),
    rectFail: t("取窗口位置失败（窗口可能正在创建 / 关闭）"),
    noArea: t("被拍对象当前没有可见区域（最小化了？）：先把它显示出来再拍"),
    emptyRegion: t("截图区域为空（偏移 / 尺寸超出被拍对象范围？）"),
  };
  return `${PS_COMMON}
${PS_WINAPI}
$OutPath = ${psQuote(opt.outPath)}
$Target = ${psQuote(opt.target)}
$WantScreen = ${psQuote(opt.screen || "")}
$WantWindow = ${psQuote(opt.window || "")}
$WantHwnd = [int64]${psNum(opt.hwnd, 0)}
$WantPid = ${psNum(opt.pid, 0)}
$OffX = ${psNum(opt.x, 0)}
$OffY = ${psNum(opt.y, 0)}
$RegionW = ${psNum(regionGiven ? opt.w : 0, 0)}
$RegionH = ${psNum(regionGiven ? opt.h : 0, 0)}
$screens = @([System.Windows.Forms.Screen]::AllScreens)
$virtual = [System.Windows.Forms.SystemInformation]::VirtualScreen
$FailMsg = ""
$shotTitle = ""
$method = "copyfromscreen"

function Pick-MtnodeScreen([string]$want) {
  $w = $want.Trim()
  if ($w -eq "") {
    foreach ($s in $screens) { if ($s.Primary) { return $s } }
    if ($screens.Count -gt 0) { return $screens[0] }
    return $null
  }
  foreach ($s in $screens) {
    if ($w -ieq [string]$s.DeviceName) { return $s }
    if ($w -ieq ([string]$s.Bounds.X + "," + [string]$s.Bounds.Y)) { return $s }
  }
  $n = 0
  if ([int]::TryParse($w, [ref]$n)) {
    if ($n -ge 0 -and $n -lt $screens.Count) { return $screens[$n] }
  }
  return $null
}

if ($Target -eq "window") {
  $proc = $null
  foreach ($q in [System.Diagnostics.Process]::GetProcesses()) {
    $h = [IntPtr]::Zero
    try { $h = $q.MainWindowHandle } catch { continue }
    if ($h -eq [IntPtr]::Zero) { continue }
    $t = ""
    try { $t = [string]$q.MainWindowTitle } catch {}
    if ($WantHwnd -gt 0) { if ([int64]$h -ne $WantHwnd) { continue } }
    elseif ($WantPid -gt 0) { if ([int]$q.Id -ne $WantPid) { continue } }
    elseif ($t.Trim() -ne "" -and $t.ToLower().Contains($WantWindow.Trim().ToLower())) { }
    else { continue }
    $proc = $q
    break
  }
  if ($null -eq $proc) {
    $FailMsg = ${psQuote(msg.noWindow)} + $WantWindow
  } else {
    $hw = [IntPtr]$proc.MainWindowHandle
    $mini = $false
    try { $mini = [MtnodeWinApi]::IsIconic($hw) } catch { $mini = $false }
    if ($mini) {
      $FailMsg = ${psQuote(msg.minimized)} + [string]$proc.MainWindowTitle
    } else {
      $wr = New-Object MtnodeWinApi+RECT
      if (-not [MtnodeWinApi]::GetWindowRect($hw, [ref]$wr)) {
        $FailMsg = ${psQuote(msg.rectFail)}
      } else {
        $bx = [int]$wr.Left; $by = [int]$wr.Top
        $bw = [int]($wr.Right - $wr.Left); $bh = [int]($wr.Bottom - $wr.Top)
        $shotTitle = [string]$proc.MainWindowTitle
      }
    }
  }
} else {
  if ($Target -eq "all") {
    $bx = [int]$virtual.X; $by = [int]$virtual.Y
    $bw = [int]$virtual.Width; $bh = [int]$virtual.Height
  } else {
    $sc = Pick-MtnodeScreen $WantScreen
    if ($null -eq $sc) {
      $FailMsg = ${psQuote(msg.noScreen)} + $WantScreen
    } else {
      $bx = [int]$sc.Bounds.X; $by = [int]$sc.Bounds.Y
      $bw = [int]$sc.Bounds.Width; $bh = [int]$sc.Bounds.Height
    }
  }
}

$capX = 0; $capY = 0; $capW = 0; $capH = 0
if ($FailMsg -eq "") {
  if ($bw -le 0 -or $bh -le 0) {
    $FailMsg = ${psQuote(msg.noArea)}
  } else {
    $capX = $bx + $OffX
    $capY = $by + $OffY
${psIfNum("capW", "$RegionW -gt 0", "$RegionW", "($bw - $OffX)")}
${psIfNum("capH", "$RegionH -gt 0", "$RegionH", "($bh - $OffY)")}
    if ($capW -le 0 -or $capH -le 0) {
      $FailMsg = ${psQuote(msg.emptyRegion)}
    }
  }
}

if ($FailMsg -ne "") {
  Write-Output ("${CAPTURE_MARK}" + (@{ ok = $false; error = $FailMsg; target = $Target } | ConvertTo-Json -Compress))
  exit 0
}

$bmp = New-Object System.Drawing.Bitmap($capW, $capH, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
if ($Target -eq "window") {
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $dc = $g.GetHdc()
  $pwOk = $false
  try { $pwOk = [MtnodeWinApi]::PrintWindow($hw, $dc, 2) } catch { $pwOk = $false }
  $g.ReleaseHdc($dc)
  $g.Dispose()
  if ($pwOk) { $method = "printwindow" }
  if (-not $pwOk -or (Test-MtnodeBlank $bmp)) {
    $g2 = [System.Drawing.Graphics]::FromImage($bmp)
    $g2.CopyFromScreen($bx, $by, 0, 0, (New-Object System.Drawing.Size($capW, $capH)))
    $g2.Dispose()
    $method = "copyfromscreen"
  }
} else {
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($capX, $capY, 0, 0, (New-Object System.Drawing.Size($capW, $capH)))
  $g.Dispose()
}

$dir = [System.IO.Path]::GetDirectoryName($OutPath)
if ($dir -and -not [System.IO.Directory]::Exists($dir)) {
  [void][System.IO.Directory]::CreateDirectory($dir)
}
$bmp.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
${PS_EMIT(
    "@{ ok = $true; path = $OutPath; width = $capW; height = $capH; method = $method; target = $Target; screen = $WantScreen; window = $shotTitle; x = $capX; y = $capY } | ConvertTo-Json -Compress",
  )}`;
}

/* capture 模式的完整脚本 = 空白检测函数 + 主体（Windows 分支要用到它） */
function buildCaptureScript(p) {
  return PS_BLANK_HELPER + "\n" + buildPowerShell("capture", p);
}

/* ── 脚本执行（可注入，便于纯 Node 测试）────────────────────── */

/* ─ 脚本执行（可注入，便于纯 Node 测试）────────────────────── */

/* PowerShell 可执行文件候选：先走 PATH（官方 / Store 版 / 用户自定义），
   再退到系统自带的那份绝对路径（PATH 被改坏的机器上仍然能拍）。
   Windows 自带 Windows PowerShell 5.1，正常机器上两个候选至少有一个在。 */
const PS_EXE_CANDIDATES = [
  "powershell.exe",
  "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
];

/* 单个候选执行一次 */
function runPowerShellOnce(exe, script, opts = {}) {
  const spawnFn = opts.spawn || spawn;
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const b64 = Buffer.from(String(script || ""), "utf16le").toString("base64");
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnFn(
        exe,
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", b64],
        { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch (err) {
      resolve({ ok: false, error: (err && err.message) || String(err), spawnFailed: true });
      return;
    }
    let out = "";
    let err = "";
    let done = false;
    let timer = null;
    const settle = (r) => {
      if (done) return;
      done = true;
      if (timer) {
        try {
          clearTimeout(timer);
        } catch {}
      }
      resolve(r);
    };
    timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
      settle({ ok: false, error: t("截图脚本超时（") + Math.round(timeoutMs / 1000) + t(" 秒）") });
    }, timeoutMs);
    if (child.stdout) child.stdout.on("data", (c) => (out += String(c)));
    if (child.stderr) child.stderr.on("data", (c) => (err += String(c)));
    child.on("error", (e) =>
      settle({
        ok: false,
        error: (e && e.message) || String(e),
        /* ENOENT = 这个候选根本不存在（换下一个试）；其它错误交给调用方报 */
        spawnFailed: !!(e && e.code === "ENOENT"),
      }),
    );
    child.on("close", (code) => {
      if (code !== 0 && !out.trim()) {
        const tail = String(err).trim().split(/\r?\n/).filter(Boolean).slice(-1)[0] || "";
        settle({
          ok: false,
          error: t("截图脚本退出码 ") + code + (tail ? "：" + tail.slice(0, 300) : ""),
        });
      } else settle({ ok: true, stdout: out, stderr: err, code: code });
    });
  });
}

/* 对外入口：按候选顺序试；某个候选「不存在」（ENOENT）才换下一个，
   真跑起来之后的任何结果（含非零退出）都算终局 —— 不重复执行脚本（截图有副作用）。 */
async function runPowerShellEncoded(script, opts = {}) {
  const list = Array.isArray(opts.exeList) && opts.exeList.length
    ? opts.exeList.map((s) => String(s))
    : opts.exe
      ? [String(opts.exe)]
      : PS_EXE_CANDIDATES.slice();
  let last = null;
  for (const exe of list) {
    const r = await runPowerShellOnce(exe, script, opts);
    if (r.ok === false && r.spawnFailed) {
      last = r;
      continue;
    }
    return r;
  }
  return last || { ok: false, error: t("找不到 PowerShell（桌面截图不可用）") };
}

/* stdout → 结果对象：只认带前缀的那一行（其余当噪声） */
function parseCaptureOutput(stdout) {
  const text = String(stdout == null ? "" : stdout);
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf(CAPTURE_MARK);
    if (i < 0) continue;
    const raw = line.slice(i + CAPTURE_MARK.length).trim();
    if (!raw) continue;
    try {
      return JSON.parse(raw);
    } catch {}
  }
  return null;
}

/* 文件名时间戳（可注入 now，便于断言） */
function stampOf(now) {
  const d = new Date(typeof now === "number" ? now : Date.now());
  const p = (n, w) => String(n).padStart(w || 2, "0");
  return (
    String(d.getFullYear()) +
    p(d.getMonth() + 1) +
    p(d.getDate()) +
    "-" +
    p(d.getHours()) +
    p(d.getMinutes()) +
    p(d.getSeconds()) +
    "-" +
    p(d.getMilliseconds(), 3)
  );
}

/* 截图文件名：shot-<目标>-<屏幕/窗口摘要>-<时间戳>.png（非法字符一律换 _） */
function captureFileName(p, now) {
  const what =
    p.target === "window"
      ? p.window || (p.hwnd ? "hwnd" + p.hwnd : p.pid ? "pid" + p.pid : "window")
      : p.target === "all"
        ? "desktop"
        : p.screen || "primary";
  const safe =
    String(what)
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 40) || "shot";
  return "shot-" + p.target + "-" + safe + "-" + stampOf(now) + ".png";
}

/* ── 对外工厂 ─────────────────────────────────────────────────
   deps：
     outDir        输出目录（必填；主进程给数据目录下的 captures/）
     runPowerShell 可选，替换脚本执行器（测试用）
     exe           可选，替换 powershell.exe 路径
     timeoutMs     可选，单次脚本上限
     platform      可选，覆盖 process.platform（测试用） */
function createDesktopCapture(deps = {}) {
  const outDir = String(deps.outDir || "").trim();
  const runPs = typeof deps.runPowerShell === "function" ? deps.runPowerShell : runPowerShellEncoded;
  const exe = String(deps.exe || "powershell.exe");
  const timeoutMs = Number(deps.timeoutMs) > 0 ? Number(deps.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const nowFn = typeof deps.now === "function" ? deps.now : () => Date.now();
  const platform = String(deps.platform || process.platform);

  async function run(mode, params) {
    if (!outDir) return { ok: false, error: t("桌面截图未初始化（缺少输出目录）") };
    if (platform !== "win32")
      return {
        ok: false,
        error: t(
          "桌面截图目前在 Windows 上实现（PowerShell + GDI）：本机是 " +
            platform +
            "。拍 MTNode 自己的窗口 / 画布请用画布拍照类能力。",
        ),
      };
    const script = mode === "capture" ? buildCaptureScript(params) : buildPowerShell(mode, params);
    const r = await runPs(script, { exe: exe, timeoutMs: timeoutMs, mode: mode });
    if (!r || r.ok === false)
      return { ok: false, error: (r && r.error) || t("截图脚本执行失败") };
    const parsed = parseCaptureOutput(r.stdout);
    if (!parsed)
      return {
        ok: false,
        error:
          t("截图脚本没有返回结果") +
          (r.stderr && String(r.stderr).trim()
            ? "：" + String(r.stderr).trim().split(/\r?\n/).filter(Boolean).slice(-1)[0].slice(0, 300)
            : ""),
      };
    return parsed;
  }

  return {
    outDir: outDir,
    available: () => platform === "win32",
    /* 有哪些屏幕可拍：[{index, deviceName, primary, x, y, width, height}] */
    async listScreens() {
      const r = await run("screens", {});
      if (r.ok !== true) return r;
      const screens = Array.isArray(r.screens) ? r.screens : r.screens ? [r.screens] : [];
      return { ok: true, screens: screens, outDir: outDir };
    },
    /* 有哪些窗口可拍：标题关键字 / hwnd / pid 都能原样回传给 capture */
    async listWindows() {
      const r = await run("windows", {});
      if (r.ok !== true) return r;
      const all = Array.isArray(r.windows) ? r.windows : r.windows ? [r.windows] : [];
      /* 最小化 / 藏在屏幕外的窗口：MainWindowHandle 非 0、矩形却在 -32000 一带，
         拍它必然是黑图。这里如实标出来（visible:false），不悄悄给一张黑图。 */
      const windows = all.map((w) =>
        Object.assign({}, w, {
          visible: w.minimized !== true && rectLooksVisible(w),
        }),
      );
      return { ok: true, windows: windows };
    },
    /* 拍一张：params 见 normCaptureParams；成功 → { ok, path, width, height, method, … } */
    async capture(raw) {
      const p = normCaptureParams(raw);
      if (!p.ok) return { ok: false, error: p.error };
      /* 按 hwnd / pid 拍时先确认这个窗口真的在屏幕内：最小化的窗口 PrintWindow
         只会给一整张黑图，与其让用户拿到黑图，不如直接说清要先显示窗口。 */
      if (p.target === "window" && (p.hwnd || p.pid)) {
        const lw = await this.listWindows();
        const hit = ((lw && lw.windows) || []).find(
          (w) => (p.hwnd && Number(w.hwnd) === p.hwnd) || (p.pid && Number(w.pid) === p.pid),
        );
        if (hit && hit.visible === false)
          return {
            ok: false,
            error: t(
              "这个窗口当前不在屏幕上（最小化 / 已隐藏），拍出来只会是一张黑图：" +
                String(hit.title || ""),
            ),
          };
      }
      const outPath = path.join(outDir, captureFileName(p, nowFn()));
      const r = await run("capture", Object.assign({}, p, { outPath: outPath }));
      if (r.ok !== true) return r;
      let bytes = 0;
      try {
        bytes = fs.statSync(String(r.path || outPath)).size || 0;
      } catch {}
      return Object.assign({}, r, {
        path: String(r.path || outPath),
        bytes: bytes,
        outDir: outDir,
      });
    },
  };
}

module.exports = {
  CAPTURE_MARK,
  PS_FAIL_PREFIX,
  DEFAULT_TIMEOUT_MS,
  VIRTUAL_SCREEN_GUARD,
  rectLooksVisible,
  normTarget,
  normCaptureParams,
  parseNum,
  parseIntOrNull,
  psQuote,
  psNum,
  psBool,
  PS_BLANK_HELPER,
  PS_EXE_CANDIDATES,
  buildPowerShell,
  buildCaptureScript,
  runPowerShellOnce,
  runPowerShellEncoded,
  parseCaptureOutput,
  captureFileName,
  stampOf,
  createDesktopCapture,
};