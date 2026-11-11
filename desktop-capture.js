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
   screen | window | all | cursor ——
   all    = 整块虚拟桌面（所有屏幕拼一起）；
   cursor = 鼠标所在那块屏（在 PowerShell 自己的坐标系里判，不需要跨进程对 DPI）。 */
function normTarget(v) {
  const s = String(v == null ? "" : v).trim().toLowerCase();
  if (!s) return "";
  if (["screen", "display", "monitor", "屏幕", "显示器", "某个屏幕"].includes(s))
    return "screen";
  if (["window", "win", "窗口", "某个窗口"].includes(s)) return "window";
  if (["all", "desktop", "virtual", "全部", "所有屏幕", "整块桌面", "桌面"].includes(s))
    return "all";
  if (["cursor", "pointer", "mouse", "鼠标", "光标", "鼠标所在屏幕", "鼠标所在的屏幕"].includes(s))
    return "cursor";
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
        "target 只能是 screen（某个屏幕）/ window（某个窗口）/ all（整块桌面）/ cursor（鼠标所在那块屏）：拿到 " +
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

/* 让 PowerShell 变成「每显示器 DPI 感知」（Win10 1703+ 的 per-monitor v2，退一步 system-aware）。
   不设的话 Windows 会把桌面坐标虚拟化：Screen.Bounds / Cursor.Position / CopyFromScreen
   全按缩放折算过的尺寸说话（本机 150% 的屏会被当成 2294×960 而不是 3441×1440），
   拍出来既糊、又和主进程那边的 DIP 不是一个单位 —— 「截图只显示桌面一个角落」就是这么来的。
   Add-Type 或 API 调用失败都只是退回原来的虚拟化坐标：本脚本内部始终自洽（见 target=cursor）。 */
const PS_DPI = `$mtnodeDpiSrc = @'
using System;
using System.Runtime.InteropServices;
public class MtnodeDpi {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
'@
try {
  Add-Type -TypeDefinition $mtnodeDpiSrc -ErrorAction Stop
  $mtnodeDpiOk = $false
  try { $mtnodeDpiOk = [MtnodeDpi]::SetProcessDpiAwarenessContext([IntPtr](-4)) } catch { $mtnodeDpiOk = $false }
  if (-not $mtnodeDpiOk) { try { $mtnodeDpiOk = [MtnodeDpi]::SetProcessDPIAware() } catch { $mtnodeDpiOk = $false } }
} catch { }`;

const PS_WINAPI = `Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class MtnodeWinApi {
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint f);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetTopWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int max);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, uint attr, out int val, uint size);
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
  if (m === "screens") return `${PS_DPI}\n${PS_COMMON}\n` + screensBody();
  if (m === "windows") return `${PS_DPI}\n${PS_COMMON}\n${PS_WINAPI}\n` + windowsBody();
  if (m !== "capture") return `${PS_DPI}\n${PS_COMMON}\n` + unknownBody(m);
  const opt = p && typeof p === "object" ? p : {};
  return `${PS_DPI}\n${PS_COMMON}\n${PS_WINAPI}\n` + captureBody(opt);
}

/* 只取「主体」（不含前言）：常驻助手进程已经把 PS_DPI / PS_COMMON / PS_WINAPI / 空白检测
   跑过一次，之后每次请求只送这一小段 —— 这才有可能把唤起压到几百毫秒。 */
function buildBody(mode, p) {
  const m = String(mode || "capture");
  const opt = p && typeof p === "object" ? p : {};
  if (m === "screens") return screensBody();
  if (m === "windows") return windowsBody();
  if (m === "capture") return captureBody(opt);
  return unknownBody(m);
}

function unknownBody(m) {
  return `Write-Output ("${CAPTURE_MARK}" + (@{ ok = $false; error = ${psQuote(t("未知截图模式：") + m)} } | ConvertTo-Json -Compress))`;
}

function screensBody() {
  return `$list = @()
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

/* 窗口清单：**按 Z 序**从最上层往下枚举（GetTopWindow → GetWindow(GW_HWNDNEXT)），
   z=0 就是最顶层。以前走 Process.MainWindowHandle，拿到的顺序跟叠放层次毫无关系，
   页面只好按「面积小的优先」猜命中，于是被压在底下的窗口也会被选中（用户报的
   「选择窗口会选到被遮挡的窗口」）。顺带把「看不见的」一次剔掉：
   IsWindowVisible=false（隐藏 / 最小化到托盘）、DWM cloaked（关掉的 UWP、别的虚拟桌面里
   的窗口）、没有标题的（桌面 Progman 之类）、零尺寸的辅助窗 —— 剩下的每一个都真在屏幕上。
   pid → 进程名先建一张表：逐个窗口 Get-Process 会把枚举拖慢好几倍。 */
function windowsBody() {
  return `$procs = @{}
foreach ($pr in [System.Diagnostics.Process]::GetProcesses()) {
  try { $procs[[int]$pr.Id] = [string]$pr.ProcessName } catch {}
}
$rows = New-Object System.Collections.ArrayList
$z = 0
$h = [MtnodeWinApi]::GetTopWindow([IntPtr]::Zero)
while ($h -ne [IntPtr]::Zero) {
  $vis = $false
  try { $vis = [MtnodeWinApi]::IsWindowVisible($h) } catch { $vis = $false }
  if ($vis) {
    $cloaked = 0
    try {
      $cv = 0
      if ([MtnodeWinApi]::DwmGetWindowAttribute($h, 14, [ref]$cv, 4) -eq 0) { $cloaked = [int]$cv }
    } catch { $cloaked = 0 }
    if ($cloaked -eq 0) {
      $len = 0
      try { $len = [MtnodeWinApi]::GetWindowTextLength($h) } catch { $len = 0 }
      $t = ""
      if ($len -gt 0) {
        $sb = New-Object System.Text.StringBuilder ([Math]::Max(8, $len + 2))
        try {
          [void][MtnodeWinApi]::GetWindowText($h, $sb, $sb.Capacity)
          $t = $sb.ToString()
        } catch { $t = "" }
      }
      $r = New-Object MtnodeWinApi+RECT
      if ($t.Trim() -ne "" -and [MtnodeWinApi]::GetWindowRect($h, [ref]$r)) {
        $ww = [int]($r.Right - $r.Left)
        $hh = [int]($r.Bottom - $r.Top)
        if ($ww -gt 1 -and $hh -gt 1) {
          $wpid = [uint32]0
          try { [void][MtnodeWinApi]::GetWindowThreadProcessId($h, [ref]$wpid) } catch {}
          $pn = ""
          if ($procs.ContainsKey([int]$wpid)) { $pn = [string]$procs[[int]$wpid] }
          $mini = $false
          try { $mini = [MtnodeWinApi]::IsIconic($h) } catch { $mini = $false }
          [void]$rows.Add([pscustomobject]@{
            hwnd = [int64]$h
            z = [int]$z
            pid = [int]$wpid
            process = $pn
            title = $t
            x = [int]$r.Left
            y = [int]$r.Top
            width = $ww
            height = $hh
            visible = [bool]$vis
            minimized = [bool]$mini
          })
          $z = $z + 1
        }
      }
    }
  }
  $h = [MtnodeWinApi]::GetWindow([IntPtr]$h, 2)
}
${PS_EMIT("@{ ok = $true; windows = @($rows) } | ConvertTo-Json -Depth 6 -Compress")}`;
}

/* capture 模式的脚本主体（不含前言）：一次性脚本与常驻助手共用这一份。
   ⚠ 失败分支只能 `return`，不能 `exit` —— 常驻助手用 scriptblock 跑这段，
   `exit` 会把整只助手进程带走（第一次失败之后就再也截不了图）。 */
function captureBody(opt) {
  const regionGiven = opt.w != null && opt.h != null;
  /* 脚本里的中文原因同样过 i18n（英文界面下模型 / 用户看到的是英文）：
     这些字面量是**脚本文本**，所以在这里 t() 一次、直接拼进字符串。 */
  const msg = {
    noWindow: t("没找到匹配的窗口（关键字 / hwnd / pid 都对不上）："),
    noScreen: t("没有匹配的屏幕（屏幕 id / 名称 / 序号都对不上）："),
    noCursorScreen:
      t("鼠标当前所在的位置不属于任何屏幕（远程桌面临时断开？）：先把鼠标移到要拍的屏幕上再试"),
    minimized: t("这个窗口当前最小化了（最小化的窗口拍出来只会是黑图）：先把它显示出来再拍 —— "),
    rectFail: t("取窗口位置失败（窗口可能正在创建 / 关闭）"),
    noArea: t("被拍对象当前没有可见区域（最小化了？）：先把它显示出来再拍"),
    emptyRegion: t("截图区域为空（偏移 / 尺寸超出被拍对象范围？）"),
  };
  return `${PS_DPI}
${PS_COMMON}
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
  } elseif ($Target -eq "cursor") {
    # 鼠标所在那块屏：判屏与被拍区域全在这个进程的坐标系里，
    # 所以不管 Windows 有没有把 DPI 虚拟化、这块屏在左边还是右边，框出来的都是整块屏。
    $pt = [System.Windows.Forms.Cursor]::Position
    $sc = [System.Windows.Forms.Screen]::FromPoint($pt)
    if ($null -eq $sc) {
      $FailMsg = ${psQuote(msg.noCursorScreen)}
    } else {
      $bx = [int]$sc.Bounds.X; $by = [int]$sc.Bounds.Y
      $bw = [int]$sc.Bounds.Width; $bh = [int]$sc.Bounds.Height
      $WantScreen = [string]$sc.DeviceName
    }
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
  return
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

/* ── 常驻热进程（warm worker）────────────────────────────────────
   为什么要有它：一次性脚本每次都要付「解释器启动 158ms + Add-Type 现编 C# 约 90ms +
   程序集加载」的固定开销（本机实测 `capture(target=cursor)` 501ms）。按一次快捷键就等
   半秒多，用户感觉到的就是「按了要停一下才出来」。
   常驻助手把这些一次性开销留在进程里：启动时把前言（DPI 感知 / 程序集 / WinApi 类型 /
   空白检测函数）跑一遍，之后每次只送「主体」，回一行 JSON。热态只剩抓屏与存 PNG，
   本机实测约 300ms。
   协议（都靠前缀认，避免被别的东西的输出干扰）：
     请求  {id, script}                     —— 一行 JSON，script = buildBody(mode, p)
     回执  __MTNODE_WARM__{id, stdout}       —— 一行 JSON，stdout = 主体自己写的那行结果
   任何异常（起不来 / 没回音 / 崩了）都只是**这一条**失败：调用方退回一次性脚本。 */
const WARM_MARK = "__MTNODE_WARM__";
const WARM_IDLE_MS = 5 * 60 * 1000;

function buildWarmScript() {
  return `${PS_DPI}
${PS_COMMON}
${PS_WINAPI}
${PS_BLANK_HELPER}
$mtnodeMark = ${psQuote(WARM_MARK)}
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim() -eq "") { continue }
  $reqId = 0
  $text = ""
  try {
    $cmd = $line | ConvertFrom-Json
    $reqId = [int]$cmd.id
    $sb = [scriptblock]::Create([string]$cmd.script)
    $text = [string](@(& $sb) -join [Environment]::NewLine)
  } catch {
    $text = ${psQuote(CAPTURE_MARK)} + (@{ ok = $false; error = [string]$_.Exception.Message } | ConvertTo-Json -Compress)
  }
  $payload = @{ id = $reqId; stdout = [string]$text } | ConvertTo-Json -Compress -Depth 4
  [Console]::Out.WriteLine($mtnodeMark + $payload)
  [Console]::Out.Flush()
}`;
}

/* 进程退出时把还活着的助手收掉（否则会留下孤儿 powershell.exe） */
const liveWorkers = new Set();
let exitHookInstalled = false;
function trackWorker(w) {
  liveWorkers.add(w);
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  try {
    process.once("exit", () => {
      for (const x of liveWorkers) {
        try {
          x.dispose();
        } catch {}
      }
    });
  } catch {}
}

function createWarmWorker(opts = {}) {
  const spawnFn = typeof opts.spawn === "function" ? opts.spawn : spawn;
  const exeList =
    Array.isArray(opts.exeList) && opts.exeList.length ? opts.exeList.map(String) : PS_EXE_CANDIDATES.slice();
  const idleMs = Number(opts.idleMs) > 0 ? Number(opts.idleMs) : WARM_IDLE_MS;
  const replyMs = Number(opts.replyMs) > 0 ? Number(opts.replyMs) : DEFAULT_TIMEOUT_MS;
  const encoded = Buffer.from(buildWarmScript(), "utf16le").toString("base64");

  let child = null;
  let exeIdx = 0;
  let buf = "";
  let nextId = 1;
  let idleTimer = null;
  let disposed = false;
  const waiting = new Map();

  function failAll(reason) {
    for (const item of waiting.values()) {
      try {
        clearTimeout(item.timer);
      } catch {}
      try {
        item.resolve({ ok: false, error: reason, unavailable: true });
      } catch {}
    }
    waiting.clear();
  }
  function armIdle() {
    if (idleTimer) {
      try {
        clearTimeout(idleTimer);
      } catch {}
    }
    idleTimer = setTimeout(() => stop("idle"), idleMs);
    if (idleTimer && typeof idleTimer.unref === "function") idleTimer.unref();
  }
  function stop(reason) {
    if (idleTimer) {
      try {
        clearTimeout(idleTimer);
      } catch {}
      idleTimer = null;
    }
    const c = child;
    child = null;
    buf = "";
    if (c) {
      try {
        if (c.stdin) c.stdin.end();
      } catch {}
      try {
        c.kill();
      } catch {}
    }
    failAll(t("常驻截图进程已退出"));
    void reason;
  }
  function onStdout(chunk) {
    buf += String(chunk);
    let at = 0;
    for (;;) {
      const i = buf.indexOf("\n", at);
      if (i < 0) break;
      const line = buf.slice(at, i).trim();
      at = i + 1;
      if (!line) continue;
      const k = line.indexOf(WARM_MARK);
      if (k < 0) continue;
      let msg = null;
      try {
        msg = JSON.parse(line.slice(k + WARM_MARK.length));
      } catch {
        msg = null;
      }
      if (!msg) continue;
      const item = waiting.get(Number(msg.id));
      if (!item) continue;
      waiting.delete(Number(msg.id));
      try {
        clearTimeout(item.timer);
      } catch {}
      item.resolve({ ok: true, stdout: String(msg.stdout == null ? "" : msg.stdout) });
    }
    if (at > 0) buf = buf.slice(at);
    /* 半行垃圾别把缓冲撑爆（只在真的异常输出时才发生） */
    if (buf.length > 8 * 1024 * 1024) buf = "";
  }
  function start() {
    if (disposed) return false;
    if (child) return true;
    for (let i = exeIdx; i < exeList.length; i++) {
      const exe = exeList[i];
      let c = null;
      try {
        c = spawnFn(exe, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], {
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (err) {
        continue;
      }
      if (!c) continue;
      child = c;
      exeIdx = i;
      buf = "";
      try {
        if (c.stdout) c.stdout.on("data", onStdout);
      } catch {}
      try {
        if (c.stderr) c.stderr.on("data", () => {});
      } catch {}
      c.on("error", (e) => {
        if (child !== c) return;
        child = null;
        /* 这个可执行文件根本不存在：下次换下一个候选 */
        if (e && (e.code === "ENOENT" || e.code === "EACCES")) exeIdx = i + 1;
        failAll((e && e.message) || String(e));
      });
      c.on("close", () => {
        if (child !== c) return;
        child = null;
        failAll(t("常驻截图进程已退出"));
      });
      armIdle();
      return true;
    }
    return false;
  }
  function request(bodyScript) {
    if (disposed) return Promise.resolve({ ok: false, error: t("常驻截图进程已关闭"), unavailable: true });
    if (!start()) return Promise.resolve({ ok: false, error: t("常驻截图进程起不来"), unavailable: true });
    const c = child;
    if (!c || !c.stdin || typeof c.stdin.write !== "function")
      return Promise.resolve({ ok: false, error: t("常驻截图进程不可写"), unavailable: true });
    const id = nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (!waiting.has(id)) return;
        waiting.delete(id);
        resolve({ ok: false, error: t("常驻截图进程没有回音"), unavailable: true });
        stop("timeout");
      }, replyMs);
      waiting.set(id, { resolve, timer });
      try {
        c.stdin.write(JSON.stringify({ id: id, script: String(bodyScript) }) + "\n");
      } catch (err) {
        waiting.delete(id);
        try {
          clearTimeout(timer);
        } catch {}
        resolve({ ok: false, error: (err && err.message) || String(err), unavailable: true });
        stop("write-failed");
        return;
      }
      armIdle();
    });
  }

  const api = {
    /* 预热：发一条空请求把「前言」跑完（编译好的类型 / DPI 上下文留在进程里），
       这样用户第一次按快捷键也是热态的。 */
    warm: () => request(`Write-Output "${CAPTURE_MARK}" + (@{ ok = $true } | ConvertTo-Json -Compress)`),
    request,
    stop: () => stop("stop"),
    dispose: () => {
      disposed = true;
      liveWorkers.delete(api);
      stop("dispose");
    },
    alive: () => !!(child && !child.killed),
  };
  trackWorker(api);
  return api;
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
        : p.target === "cursor"
          ? "cursor"
          : p.screen || "primary";
  const safe =
    String(what)
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 40) || "shot";
  return ("shot-" + p.target + (safe === p.target ? "" : "-" + safe) + "-" + stampOf(now) + ".png");
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
  /* 常驻热进程：Windows 上默认开；注入了 runPowerShell 的调用方（测试 / 特殊环境）走原来
     那条一次性脚本的路，行为不变。deps.warm === false 可以显式关掉。 */
  const useWarm = platform === "win32" && deps.warm !== false && typeof deps.runPowerShell !== "function";
  let worker = null;
  function warmWorker() {
    if (!useWarm) return null;
    if (!worker) {
      worker = createWarmWorker({
        spawn: deps.spawn,
        exeList: deps.exeList,
        idleMs: deps.warmIdleMs,
        replyMs: deps.warmReplyMs,
      });
    }
    return worker;
  }
  /* 一次请求：优先常驻助手（热态），失败立刻退回一次性脚本（慢一点但一定能拍）。 */
  async function runScript(mode, params) {
    const body = buildBody(mode, params);
    const w = warmWorker();
    if (w) {
      const r = await w.request(body);
      if (r && r.ok === true) return { ok: true, stdout: r.stdout, stderr: "", mode: mode, warm: true };
    }
    const script = mode === "capture" ? buildCaptureScript(params) : buildPowerShell(mode, params);
    return runPs(script, { exe: exe, timeoutMs: timeoutMs, mode: mode });
  }

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
    const r = await runScript(mode, params);
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
    /* 预热常驻助手（应用启动后调一次）：把解释器 / C# 编译 / DPI 上下文提前付掉。
       回 { ok, ms }：ms 是「从起进程到第一条应答回来」的真实耗时，写日志用来看热态到底有没有生效。 */
    warm() {
      const w = warmWorker();
      if (!w) return Promise.resolve({ ok: false, error: t("常驻截图进程未启用") });
      const t0 = Date.now();
      return w.warm().then((r) => ({
        ok: !!(r && r.ok === true),
        ms: Date.now() - t0,
        error: r && r.error,
      }));
    },
    warmAlive: () => !!(worker && worker.alive()),
    dispose() {
      if (worker) {
        try {
          worker.dispose();
        } catch {}
        worker = null;
      }
    },
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
  PS_DPI,
  PS_EXE_CANDIDATES,
  buildPowerShell,
  buildBody,
  buildCaptureScript,
  buildWarmScript,
  WARM_MARK,
  createWarmWorker,
  runPowerShellOnce,
  runPowerShellEncoded,
  parseCaptureOutput,
  captureFileName,
  stampOf,
  createDesktopCapture,
};