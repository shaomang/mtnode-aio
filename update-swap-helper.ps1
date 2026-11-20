<#
  退出瞬间交换 helper（独立进程，不依赖主进程存活）
  ─────────────────────────────────────────────────────────────────────────────
  谁拉起它：update-swap.js —— 主进程退出前把这份脚本复制到 %LOCALAPPDATA%\MTNodeAIO-update\
            （**安装目录之外**：安装目录马上要被改名，脚本放里面等于拆自己脚下的地板），
            再用 `cmd /c powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File …`
            以 windowsHide + detached + stdio ignore 拉起，参数带 pid / 安装目录 / 旁路目录 / 新版本号。
  为什么必须是独立进程：Windows 上正在运行的 exe 与它的 CWD 会把目录 rename 卡住，
  交换只能等主应用真正退出之后做，所以干活的那个进程必须比主进程活得久。

  序列（任一步失败都回滚并写 swap-result.json，绝不留静默半成品）：
    ① 等主进程 pid 退出（WaitMs = 60s；超时即放弃，一个字节都不动，只留痕）
    ② 前置复检（安装目录在、旁路目录里有 exe）
    ③ installDir → installDir.old-<旧版本>（同卷 rename，毫秒级；失败重试 + 给出占用进程）
    ④ stageDir → installDir（失败就把 ③ 改回去）
    ⑤ 收尾：HKCU 安装键 / 卸载键写成新版本与新 InstallLocation、按安装目录修正桌面 / 开始菜单
       .lnk、拿掉 cacheDir 里旧 installer.exe 的还原备份
    ⑥ 拉起新版本（带 --updated，与 NSIS 装完自动重开同一语义）
    ⑦ 后台删 .old（失败重试；仍失败的把路径写进结果，交给主进程下次启动清理）

  结果与日志：每次运行都重写 swap-result.json（相位够细：waiting / wait_timeout / precheck_failed /
  rename_install_failed / rename_stage_failed / swapped / done），日志追加到 swap-helper.log。
#>
param(
  [int]$AppPid = 0,
  [string]$InstallDir = "",
  [string]$StageDir = "",
  [string]$ExeName = "MTNodeAIO.exe",
  [string]$OldVersion = "",
  [string]$NewVersion = "",
  [string]$AppGuid = "",
  [string]$ResultFile = "",
  [string]$LogFile = "",
  [string]$CacheDir = "",
  [string]$BackupDir = "",
  [string]$RunId = "",
  [int]$WaitMs = 60000,
  [int]$RenameRetryCount = 40,
  [int]$RenameRetryDelayMs = 500,
  [int]$CleanupRetryCount = 30,
  [int]$CleanupRetryDelayMs = 1000
)

$ErrorActionPreference = "Continue"
$ProgressPreference = "SilentlyContinue"
$script:StartedAt = Get-Date
if ($InstallDir) { $InstallDir = $InstallDir.TrimEnd('\') }
if ($StageDir) { $StageDir = $StageDir.TrimEnd('\') }
# 自己的 CWD 绝不能停在安装目录（或它旁边）：进程的工作目录也持着一个目录句柄，
# 拿它当 CWD 就等于自己把 ③ 那次 rename 锁死（cmd 拉起时的 cwd 已由 Node 侧挪走，这里再兜一层）
try { Set-Location -LiteralPath $env:SystemRoot -ErrorAction Stop } catch { }
if ($InstallDir) {
  try {
    if ((Get-Location).Path.StartsWith($InstallDir, [System.StringComparison]::OrdinalIgnoreCase)) {
      Set-Location -LiteralPath $env:SystemRoot
    }
  } catch { }
}

# ── 日志 / 结果文件 ──────────────────────────────────────────────────────────

function Write-Log([string]$msg) {
  if (-not $LogFile) { return }
  $line = "[{0}] {1}" -f (Get-Date).ToString("yyyy-MM-dd HH:mm:ss.fff"), $msg
  try { Add-Content -LiteralPath $LogFile -Value $line -Encoding UTF8 } catch { }
}

# 结果文件是主进程用 JSON.parse 读的：**不能带 BOM**（PS 5.1 的 Set-Content -Encoding UTF8 会写 BOM）
function Write-Result($obj) {
  if (-not $ResultFile) { return }
  $obj["schema"] = 1
  $obj["helperPid"] = $PID
  $obj["runId"] = $RunId
  $obj["at"] = (Get-Date).ToUniversalTime().ToString("o")
  $obj["elapsedMs"] = [int](((Get-Date) - $script:StartedAt).TotalMilliseconds)
  try {
    $json = $obj | ConvertTo-Json -Depth 8
    $tmp = $ResultFile + ".tmp"
    [System.IO.File]::WriteAllText($tmp, $json, (New-Object System.Text.UTF8Encoding($false)))
    Move-Item -LiteralPath $tmp -Destination $ResultFile -Force
  } catch {
    Write-Log ("结果文件写入失败: " + $_.Exception.Message)
  }
}

function Fail([string]$phase, [string]$reason, $extra) {
  $o = [ordered]@{
    ok = $false
    phase = $phase
    swapped = $false
    reason = $reason
    installDir = $InstallDir
    stageDir = $StageDir
    oldVersion = $OldVersion
    newVersion = $NewVersion
    backupDir = $BackupDir
    cacheDir = $CacheDir
  }
  if ($extra) { foreach ($k in $extra.Keys) { $o[$k] = $extra[$k] } }
  Write-Log ("失败相位 {0}: {1}" -f $phase, $reason)
  Write-Result $o
}

# ── 等主进程退出 ────────────────────────────────────────────────────────────

function Wait-AppExit() {
  if ($AppPid -le 0) { return $true }
  $deadline = (Get-Date).AddMilliseconds($WaitMs)
  while ((Get-Date) -lt $deadline) {
    $p = Get-Process -Id $AppPid -ErrorAction SilentlyContinue
    if (-not $p) { return $true }
    Start-Sleep -Milliseconds 250
  }
  return $false
}

# ── 目录 rename / 删除（带重试与可读原因） ───────────────────────────────────

function Move-DirRetry([string]$from, [string]$to, [int]$tries, [int]$delayMs) {
  $last = ""
  $n = [Math]::Max(1, $tries)
  for ($i = 1; $i -le $n; $i++) {
    try {
      [System.IO.Directory]::Move($from, $to)
      return @{ ok = $true; attempts = $i; reason = "" }
    } catch {
      $last = $_.Exception.Message
      if ($_.Exception.InnerException) {
        $last = $last + " / " + $_.Exception.InnerException.Message
      }
      Write-Log ("rename 第 {0}/{1} 次失败: {2} -> {3} : {4}" -f $i, $n, $from, $to, $last)
      Start-Sleep -Milliseconds $delayMs
    }
  }
  return @{ ok = $false; attempts = $n; reason = $last }
}

function Remove-DirRetry([string]$dir, [int]$tries, [int]$delayMs) {
  if (-not (Test-Path -LiteralPath $dir)) { return $true }
  $n = [Math]::Max(1, $tries)
  for ($i = 1; $i -le $n; $i++) {
    try {
      [System.IO.Directory]::Delete($dir, $true)
      return $true
    } catch {
      Write-Log ("删目录第 {0}/{1} 次失败: {2} : {3}" -f $i, $n, $dir, $_.Exception.Message)
      Start-Sleep -Milliseconds $delayMs
    }
  }
  return $false
}

# rename 失败时说清「谁占着」：ffmpeg / 插件拉起的子进程 / 托盘都可能是元凶（任务书 ⑥ 要可读原因）
function Get-BlockingProcesses([string]$dir) {
  $out = @()
  try {
    foreach ($p in Get-Process -ErrorAction SilentlyContinue) {
      try {
        $pth = $p.Path
        if ($pth -and $pth.StartsWith($dir, [System.StringComparison]::OrdinalIgnoreCase)) {
          $out += ("{0}({1})" -f $p.ProcessName, $p.Id)
        }
      } catch { }
    }
  } catch { }
  return @($out | Select-Object -Unique)
}

# 交换没成时把**老版本**拉回来（不带 --updated：什么都没更新过）。
# 不做这件事的后果是「用户点了立即重启 → 应用关掉 → 再也没起来」，那才是真正的静默失败。
function Relaunch-Old([string]$why) {
  $r = [ordered]@{ started = $false; pid = 0; error = ""; reason = $why }
  if (-not $exePath -or -not (Test-Path -LiteralPath $exePath)) {
    $r["error"] = "install_exe_missing"
    return $r
  }
  try {
    $proc = Start-Process -FilePath $exePath -WorkingDirectory $InstallDir -PassThru -ErrorAction Stop
    $r["started"] = $true
    if ($proc) { $r["pid"] = [int]$proc.Id }
    Write-Log ("交换未成立（{0}），已把老版本重新拉起: {1} (pid={2})" -f $why, $exePath, $r["pid"])
  } catch {
    $r["error"] = $_.Exception.Message
    Write-Log ("交换未成立（{0}），老版本也拉不起来: {1}" -f $why, $r["error"])
  }
  return $r
}

# ── 注册表（只碰 HKCU 的两只键） ─────────────────────────────────────────────

function Get-RegValue([string]$key, [string]$name) {
  try {
    $item = Get-ItemProperty -LiteralPath $key -Name $name -ErrorAction Stop
    return [string]$item.$name
  } catch {
    return ""
  }
}

function Set-RegString([string]$key, [string]$name, [string]$value) {
  try {
    if (-not (Test-Path -LiteralPath $key)) { New-Item -Path $key -Force | Out-Null }
    New-ItemProperty -LiteralPath $key -Name $name -Value $value -PropertyType String -Force | Out-Null
    return $true
  } catch {
    Write-Log ("注册表写入失败: {0}\{1} : {2}" -f $key, $name, $_.Exception.Message)
    return $false
  }
}

# UninstallString 这类值是 '"<目录>\Uninstall xxx.exe" /currentuser' —— 路径带引号，前缀也要连引号一起比
function Fix-PathPrefix([string]$value, [string]$oldPrefix, [string]$newPrefix) {
  if (-not $value) { return "" }
  if (-not $oldPrefix) { return $value }
  if ($value.StartsWith(('"' + $oldPrefix), [System.StringComparison]::OrdinalIgnoreCase)) {
    return '"' + $newPrefix + $value.Substring(1 + $oldPrefix.Length)
  }
  if ($value.StartsWith($oldPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    return $newPrefix + $value.Substring($oldPrefix.Length)
  }
  return $value
}

# ── 快捷方式（按安装目录修正已有 .lnk；不新建，建不建是安装器的活） ─────────

function Get-ShortcutPaths([string]$name) {
  $paths = @()
  if (-not $name) { return @() }
  $file = $name + ".lnk"
  try {
    $desktop = [Environment]::GetFolderPath("Desktop")
    if ($desktop) {
      $c = Join-Path $desktop $file
      if (Test-Path -LiteralPath $c) { $paths += $c }
    }
  } catch { }
  try {
    $menu = [Environment]::GetFolderPath("Programs")
    if ($menu -and (Test-Path -LiteralPath $menu)) {
      $hits = Get-ChildItem -LiteralPath $menu -Filter $file -Recurse -File -ErrorAction SilentlyContinue
      foreach ($h in $hits) { $paths += $h.FullName }
    }
  } catch { }
  return @($paths | Select-Object -Unique)
}

function Repair-Shortcuts([string]$name, [string]$target, [string]$workdir) {
  $r = [ordered]@{ name = $name; found = 0; fixed = 0; errors = @() }
  if (-not $name) {
    $r["errors"] = @("no_shortcut_name")
    return $r
  }
  $list = @(Get-ShortcutPaths $name)
  $r["found"] = $list.Count
  if ($list.Count -eq 0) { return $r }
  $ws = $null
  try { $ws = New-Object -ComObject WScript.Shell } catch { }
  if (-not $ws) {
    $r["errors"] = @("wscript_shell_unavailable")
    return $r
  }
  $fixed = 0
  $errors = @()
  foreach ($p in $list) {
    try {
      # 已存在的 .lnk 读进来改目标：AUMI（AppUserModelID）、快捷键等我们不认识的属性都留着
      $lnk = $ws.CreateShortcut($p)
      $lnk.TargetPath = $target
      $lnk.WorkingDirectory = $workdir
      $lnk.IconLocation = "$target,0"
      $lnk.Save()
      $fixed++
    } catch {
      $errors += ($p + ": " + $_.Exception.Message)
    }
  }
  $r["fixed"] = $fixed
  $r["errors"] = @($errors)
  return $r
}

# ── 差分基座：拿掉「旧 installer.exe 的还原备份」 ───────────────────────────

function Clear-BaseBackup([string]$dir) {
  $removed = @()
  if (-not $dir) { return @() }
  foreach ($n in @("installer.exe", "installer-base.json")) {
    $p = Join-Path $dir $n
    if (Test-Path -LiteralPath $p) {
      try {
        Remove-Item -LiteralPath $p -Force
        $removed += $p
      } catch {
        Write-Log ("还原备份删除失败: {0} : {1}" -f $p, $_.Exception.Message)
      }
    }
  }
  return @($removed)
}

# ══ 主流程 ══════════════════════════════════════════════════════════════════

Write-Log ("helper 启动: appPid={0} install={1} stage={2} {3} -> {4} helper={5}" -f $AppPid, $InstallDir, $StageDir, $OldVersion, $NewVersion, $PID)

# 先落一个 working 相位：主进程靠它确认「helper 真的起来了」再放心退出
Write-Result ([ordered]@{
  ok = $false
  phase = "waiting"
  swapped = $false
  appPid = $AppPid
  installDir = $InstallDir
  stageDir = $StageDir
  oldVersion = $OldVersion
  newVersion = $NewVersion
  waitMs = $WaitMs
})
# ① 等主进程退出
if (-not (Wait-AppExit)) {
  Write-Log ("等 pid {0} 退出超时（{1} ms）：放弃本次交换，安装目录一个字节没动" -f $AppPid, $WaitMs)
  Fail "wait_timeout" "app_still_running" ([ordered]@{ appPid = $AppPid; waitMs = $WaitMs })
  exit 2
}
Write-Log ("主进程已退出（等待 {0} ms）" -f [int](((Get-Date) - $script:StartedAt).TotalMilliseconds))

# ② 前置复检（Node 侧已判过一遍；这里再判一次，判不过就一个字节不动）
$exePath = ""
$stageExe = ""
if ($InstallDir) { $exePath = Join-Path $InstallDir $ExeName }
if ($StageDir) { $stageExe = Join-Path $StageDir $ExeName }
$problems = @()
if (-not $InstallDir) { $problems += "no_install_dir" }
if (-not $StageDir) { $problems += "no_stage_dir" }
if ($InstallDir -and -not (Test-Path -LiteralPath $InstallDir -PathType Container)) { $problems += "install_dir_missing" }
if ($stageExe -and -not (Test-Path -LiteralPath $stageExe)) { $problems += "stage_dir_incomplete" }
if ($exePath -and -not (Test-Path -LiteralPath $exePath)) { $problems += "install_exe_missing" }
if ($problems.Count -gt 0) {
  Fail "precheck_failed" ($problems -join ",") ([ordered]@{
    problems = @($problems)
    relaunch = (Relaunch-Old "precheck_failed")
  })
  exit 3
}

# ③ 安装目录 → .old-<旧版本>
$verSuffix = $OldVersion
if (-not ($verSuffix -match '^[0-9A-Za-z._-]+$')) { $verSuffix = "old" }
$oldDir = "{0}{1}{2}" -f $InstallDir, ".old-", $verSuffix
if (Test-Path -LiteralPath $oldDir) {
  Write-Log ("旧的 .old 目录已存在（上次没删干净），先试着清掉: {0}" -f $oldDir)
  if (-not (Remove-DirRetry $oldDir 10 500)) {
    $oldDir = "{0}{1}{2}-{3}" -f $InstallDir, ".old-", $verSuffix, (Get-Date -Format "yyyyMMddHHmmss")
    Write-Log ("清不掉，改用带时间戳的名字: {0}" -f $oldDir)
  }
}
$mv1 = Move-DirRetry $InstallDir $oldDir $RenameRetryCount $RenameRetryDelayMs
if (-not $mv1.ok) {
  $blocking = @(Get-BlockingProcesses $InstallDir)
  Write-Log ("正式目录改名失败；仍占着它的进程: {0}" -f ($blocking -join ", "))
  Fail "rename_install_failed" $mv1.reason ([ordered]@{
    attempts = $mv1.attempts
    oldDir = $oldDir
    blockedBy = @($blocking)
    relaunch = (Relaunch-Old "rename_install_failed")
  })
  exit 4
}

# ④ 旁路目录 → 安装目录（失败即回滚）
$mv2 = Move-DirRetry $StageDir $InstallDir $RenameRetryCount $RenameRetryDelayMs
if (-not $mv2.ok) {
  Write-Log "旁路目录改名失败，开始回滚（把 .old 改回正式目录）"
  $rb = Move-DirRetry $oldDir $InstallDir $RenameRetryCount $RenameRetryDelayMs
  Write-Log ("回滚结果: ok={0} reason={1}" -f $rb.ok, $rb.reason)
  Fail "rename_stage_failed" $mv2.reason ([ordered]@{
    attempts = $mv2.attempts
    rolledBack = [bool]$rb.ok
    rollbackReason = $rb.reason
    oldDir = $oldDir
    # 回滚成功才敢拉老版本；回滚也失败说明目录不在原处，拉了也起不来（结果里如实写着）
    relaunch = (Relaunch-Old "rename_stage_failed")
  })
  exit 5
}
$swapMs = [int](((Get-Date) - $script:StartedAt).TotalMilliseconds)
Write-Log ("交换完成（两次 rename，累计 {0} ms）：{1} -> {2}；{3} -> {1}" -f $swapMs, $InstallDir, $oldDir, $StageDir)

# 交换已经成立：先落一版结果。后面任何一步失败都不该让下次启动把这个版本再交换一次
Write-Result ([ordered]@{
  ok = $true
  phase = "swapped"
  swapped = $true
  installDir = $InstallDir
  stageDir = $StageDir
  oldDir = $oldDir
  oldVersion = $OldVersion
  newVersion = $NewVersion
  backupDir = $BackupDir
  cacheDir = $CacheDir
  swapMs = $swapMs
})

# ⑤a 注册表：安装键的 InstallLocation + 卸载键的新版本 / 新路径
$installKey = "HKCU:\Software\$AppGuid"
$uninstallKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$AppGuid"
$reg = [ordered]@{
  installLocation = $false
  displayVersion = $false
  pathsFixed = 0
  errors = @()
}
if ($AppGuid) {
  $reg["installLocation"] = Set-RegString $installKey "InstallLocation" $InstallDir
  if ($NewVersion) {
    $reg["displayVersion"] = Set-RegString $uninstallKey "DisplayVersion" $NewVersion
  }
  $regErrors = @()
  foreach ($n in @("UninstallString", "QuietUninstallString", "DisplayIcon")) {
    $cur = Get-RegValue $uninstallKey $n
    if (-not $cur) { continue }
    $new = $cur
    foreach ($prefix in @($StageDir, $oldDir)) {
      $new = Fix-PathPrefix $new $prefix $InstallDir
    }
    if ($new -ne $cur) {
      if (Set-RegString $uninstallKey $n $new) { $reg["pathsFixed"] = [int]$reg["pathsFixed"] + 1 }
      else { $regErrors += $n }
    }
  }
  $reg["errors"] = @($regErrors)
} else {
  $reg["errors"] = @("no_app_guid")
}

# ⑤b 快捷方式：按安装目录修正桌面 / 开始菜单那两个 .lnk
$shortcutName = ""
if ($AppGuid) { $shortcutName = Get-RegValue $installKey "ShortcutName" }
$links = Repair-Shortcuts $shortcutName $exePath $InstallDir

# ⑤c 差分基座：新版本那份 installer.exe 已经由安装器写进 cacheDir，还原备份该拿掉了
$baseRemoved = @(Clear-BaseBackup $BackupDir)

# ⑥ 拉起新版本（--updated 与 NSIS 装完自动重开同一语义）
$launch = [ordered]@{ started = $false; pid = 0; error = "" }
try {
  $proc = Start-Process -FilePath $exePath -ArgumentList "--updated" -WorkingDirectory $InstallDir -PassThru -ErrorAction Stop
  $launch["started"] = $true
  if ($proc) { $launch["pid"] = [int]$proc.Id }
  Write-Log ("已拉起新版本: {0} --updated (pid={1})" -f $exePath, $launch["pid"])
} catch {
  $launch["error"] = $_.Exception.Message
  Write-Log ("拉起新版本失败: " + $launch["error"])
}

# ⑦ 后台删 .old（换了新版本以后才有意义）；删不掉的把路径交给主进程下次启动清理
$cleanup = [ordered]@{ deleted = $false; leftover = "" }
if (Test-Path -LiteralPath $oldDir) {
  $cleanup["deleted"] = Remove-DirRetry $oldDir $CleanupRetryCount $CleanupRetryDelayMs
  if (-not $cleanup["deleted"]) {
    $cleanup["leftover"] = $oldDir
    Write-Log ("旧目录删不掉，留给下次启动清理: {0}" -f $oldDir)
  }
}

Write-Result ([ordered]@{
  ok = $true
  phase = "done"
  swapped = $true
  installDir = $InstallDir
  stageDir = $StageDir
  oldDir = $oldDir
  oldVersion = $OldVersion
  newVersion = $NewVersion
  backupDir = $BackupDir
  cacheDir = $CacheDir
  swapMs = $swapMs
  registry = $reg
  shortcuts = $links
  baseBackupRemoved = @($baseRemoved)
  launch = $launch
  cleanup = $cleanup
})
Write-Log "helper 结束"
exit 0
