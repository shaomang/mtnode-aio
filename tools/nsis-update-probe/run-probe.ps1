# ============================================================================
# MTNode NSIS 更新流程探针 —— 一次性验证脚本（不进 test/ 自动跑清单）
#
# 编两只假安装器并真跑三次，记录：
#   1) probe.exe      --updated          更新路径：应零点击、只剩进度页、装完自己关 + 自动重开
#   2) probe.exe      （手动安装）        对照：模式页/目录页/完成页都要点，完成页有「运行应用」勾选
#   3) probe-noabort.exe --updated        对照：不 Abort 完成页、只靠 MUI 的 SetAutoClose 会怎样
#
# 跑法：pwsh -File tools/nsis-update-probe/run-probe.ps1
# 产物：tools/nsis-update-probe/build/*.exe、runs/<n>-<name>/pages.log 等
# ============================================================================
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$root = (Resolve-Path -LiteralPath (Join-Path $here '..\..')).Path
$buildDir = Join-Path $here 'build'
$runsDir = Join-Path $here 'runs'
$probeDir = Join-Path $env:TEMP 'mtnode-nsis-probe'
$installDir = Join-Path $probeDir 'MTNodeProbe'

# ---------- 找 makensis / 模板 / 插件 ----------
$cache = Join-Path $env:LOCALAPPDATA 'electron-builder\Cache'
$makensis = $null
foreach ($cand in (Get-ChildItem -LiteralPath (Join-Path $cache 'nsis-3.0.4.1') -Directory -ErrorAction SilentlyContinue)) {
  $p = Join-Path $cand.FullName 'makensis.exe'
  if (Test-Path -LiteralPath $p) { $makensis = $p; break }
}
if (-not $makensis) { throw "找不到 makensis.exe（$cache\nsis-3.0.4.1）" }

$pluginDir = $null
foreach ($cand in (Get-ChildItem -LiteralPath (Join-Path $cache 'nsis-resources-3.4.1') -Directory -ErrorAction SilentlyContinue)) {
  $p = Join-Path $cand.FullName 'plugins\x86-unicode'
  if (Test-Path -LiteralPath (Join-Path $p 'StdUtils.dll')) { $pluginDir = $p; break }
}
if (-not $pluginDir) { throw "找不到 nsis-resources 的 x86-unicode 插件目录（StdUtils.dll）" }

$templates = Join-Path $root 'node_modules\app-builder-lib\templates\nsis'
$projectNsh = Join-Path $root 'installer.nsh'

Write-Host "[probe] makensis  : $makensis"
Write-Host "[probe] templates : $templates"
Write-Host "[probe] plugins   : $pluginDir"
Write-Host "[probe] installer : $projectNsh"

# ---------- 环境准备 ----------
foreach ($d in @($buildDir, $runsDir, $probeDir, $installDir)) {
  New-Item -ItemType Directory -Force -Path $d | Out-Null
}

& (Join-Path $here 'gen-langs.ps1') -Out (Join-Path $here 'probe-langs.nsh')

# 冒充被拉起的应用：只写标记文件，不真起程序
$fakeApp = Join-Path $probeDir 'fake-app.cmd'
@(
  '@echo off',
  ('echo %DATE% %TIME% args=[%*] >> "' + $probeDir + '\startapp-called.txt"')
) | Set-Content -LiteralPath $fakeApp -Encoding ASCII

# ---------- 编译 ----------
function Invoke-Makensis {
  param([string[]]$Defines, [string]$Label)
  $nsi = Join-Path $here 'probe.nsi'
  $argsList = @('/INPUTCHARSET', 'UTF8', '/V3') + $Defines + @($nsi)
  Write-Host ("[build] makensis " + ($argsList -join ' '))
  $out = & $makensis @argsList 2>&1
  $out | ForEach-Object { Write-Host "    $_" }
  if ($LASTEXITCODE -ne 0) { throw "$Label 编译失败（exit $LASTEXITCODE）" }
}

$commonDefines = @(
  "/DNSIS_TEMPLATES=$templates",
  "/DNSIS_PLUGINS=$pluginDir",
  "/DPROJECT_INSTALLER_NSH=$projectNsh"
)
Invoke-Makensis -Defines $commonDefines -Label 'probe.exe'
Invoke-Makensis -Defines ($commonDefines + '/DPROBE_NOABORT=1') -Label 'probe-noabort.exe'

# ---------- 点击自动化（探索 #32770 窗口并 PostMessage WM_COMMAND IDOK=1）----------
if (-not ('NsisProbeWin' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public class NsisProbeWin {
  delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassNameW(IntPtr hWnd, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr hWnd, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern IntPtr PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

  public static List<IntPtr> Dialogs(uint pid) {
    var res = new List<IntPtr>();
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p == pid && IsWindowVisible(h)) {
        var sb = new StringBuilder(128); GetClassNameW(h, sb, 128);
        if (sb.ToString() == "#32770") res.Add(h);
      }
      return true;
    }, IntPtr.Zero);
    return res;
  }

  public static string VisibleWindows(uint pid) {
    var parts = new List<string>();
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p == pid && IsWindowVisible(h)) {
        var c = new StringBuilder(128); GetClassNameW(h, c, 128);
        var t = new StringBuilder(256); GetWindowTextW(h, t, 256);
        parts.Add(c.ToString() + ":" + t.ToString());
      }
      return true;
    }, IntPtr.Zero);
    return string.Join(" | ", parts.ToArray());
  }

  public static int ClickNext(uint pid) {
    int n = 0;
    foreach (IntPtr h in Dialogs(pid)) { PostMessage(h, 0x0111, (IntPtr)1, IntPtr.Zero); n++; }
    return n;
  }
}
'@
}

# ---------- 一次实验 ----------
$script:results = @()

function Invoke-ProbeRun {
  param(
    [string]$Name,
    [string]$Exe,
    [string[]]$Arguments,
    [int]$QuietSec,          # 完全不点击地观察这么多秒：这段时间内自己退了 = 零点击
    [switch]$AutoAdvance,    # 之后开始模拟点「下一步 / 完成」
    [int]$MaxSec = 45
  )

  $runDir = Join-Path $runsDir $Name
  New-Item -ItemType Directory -Force -Path $runDir | Out-Null
  foreach ($f in @((Join-Path $probeDir 'pages.log'), (Join-Path $probeDir 'startapp-called.txt'))) {
    if (Test-Path -LiteralPath $f) { Remove-Item -LiteralPath $f -Force }
  }
  Remove-Item -LiteralPath (Join-Path $installDir '*') -Recurse -Force -ErrorAction SilentlyContinue

  $argLine = ($Arguments + @("/D=$installDir")) -join ' '
  Write-Host ""
  Write-Host "[run] $Name : $(Split-Path -Leaf $Exe) $argLine"
  # /D 必须是最后一个且不加引号（NSIS 约定），探针据此把 $INSTDIR 钉在 %TEMP% 下
  $startArgs = @()
  if ($Arguments) { $startArgs += $Arguments }
  $startArgs += "/D=$installDir"
  $proc = Start-Process -FilePath $Exe -ArgumentList $startArgs -PassThru
  $sw = [System.Diagnostics.Stopwatch]::StartNew()

  $quietExit = $proc.WaitForExit($QuietSec * 1000)
  $quietElapsed = [math]::Round($sw.Elapsed.TotalSeconds, 2)
  $windowsAtQuiet = ''
  if (-not $quietExit) {
    try { $windowsAtQuiet = [NsisProbeWin]::VisibleWindows([uint32]$proc.Id) } catch { $windowsAtQuiet = "(取窗口失败)" }
  }

  $clicks = 0
  if (-not $quietExit -and $AutoAdvance) {
    while (-not $proc.HasExited -and $sw.Elapsed.TotalSeconds -lt $MaxSec) {
      Start-Sleep -Milliseconds 900
      try {
        $n = [NsisProbeWin]::ClickNext([uint32]$proc.Id)
        if ($n -gt 0) { $clicks += $n }
      } catch { }
      if ($proc.HasExited) { break }
    }
  }

  $totalElapsed = [math]::Round($sw.Elapsed.TotalSeconds, 2)
  $exitCode = $null
  $killed = $false
  if ($proc.HasExited) {
    try { $exitCode = $proc.ExitCode } catch { }
  } else {
    $killed = $true
    try { $proc.Kill() } catch { }
    try { $proc.WaitForExit(5000) | Out-Null } catch { }
  }

  # ExecShellAsUser 是异步 shell 启动，等标记文件落盘
  Start-Sleep -Seconds 2

  $pages = @()
  $pagesFile = Join-Path $probeDir 'pages.log'
  if (Test-Path -LiteralPath $pagesFile) { $pages = @(Get-Content -LiteralPath $pagesFile -Encoding UTF8) }
  $markerFile = Join-Path $probeDir 'startapp-called.txt'
  $marker = @()
  if (Test-Path -LiteralPath $markerFile) { $marker = @(Get-Content -LiteralPath $markerFile -Encoding UTF8) }

  $files = @()
  if (Test-Path -LiteralPath $installDir) {
    $files = @(Get-ChildItem -LiteralPath $installDir -File | ForEach-Object { $_.Name })
  }

  Copy-Item -LiteralPath $pagesFile -Destination (Join-Path $runDir 'pages.log') -ErrorAction SilentlyContinue
  if (Test-Path -LiteralPath $markerFile) { Copy-Item -LiteralPath $markerFile -Destination (Join-Path $runDir 'startapp-called.txt') -ErrorAction SilentlyContinue }

  $row = [pscustomobject]@{
    run              = $Name
    exe              = (Split-Path -Leaf $Exe)
    args             = $argLine
    quietSec         = $QuietSec
    exitedWithoutClick = $quietExit
    quietElapsedSec  = $quietElapsed
    windowsAtQuiet   = $windowsAtQuiet
    clicksPosted     = $clicks
    totalElapsedSec  = $totalElapsed
    killedByScript   = $killed
    exitCode         = $exitCode
    pages            = ($pages -join ' / ')
    startApp         = ($marker -join ' / ')
    files            = ($files -join ', ')
  }
  $script:results += $row
  $row | Format-List | Out-String | Write-Host
}

# 1) 更新路径：零点击
Invoke-ProbeRun -Name '1-update' -Exe (Join-Path $buildDir 'probe.exe') -Arguments @('--updated') -QuietSec 20
# 2) 手动安装：前 6 秒不点（证明必须点），再自动点下去
Invoke-ProbeRun -Name '2-manual' -Exe (Join-Path $buildDir 'probe.exe') -Arguments @() -QuietSec 6 -AutoAdvance
# 3) 对照：不 Abort 完成页，只看 SetAutoClose
Invoke-ProbeRun -Name '3-update-noabort' -Exe (Join-Path $buildDir 'probe-noabort.exe') -Arguments @('--updated') -QuietSec 8 -AutoAdvance

Write-Host ""
Write-Host "================ 汇总 ================"
$script:results | Format-Table run, exitedWithoutClick, quietElapsedSec, clicksPosted, totalElapsedSec, killedByScript, exitCode, startApp -AutoSize | Out-String -Width 400 | Write-Host
Write-Host ""
Write-Host "页面序列（按 pages.log）："
foreach ($r in $script:results) {
  Write-Host ("  {0,-18} -> {1}" -f $r.run, $r.pages)
}
$script:results | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $runsDir 'summary.json') -Encoding UTF8
Write-Host ""
Write-Host "[probe] 明细落在 $runsDir，汇总 $runsDir\summary.json"
