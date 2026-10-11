# =============================================================================
# MTNode 安装步骤协议（所有 *-pack/scripts/* 共用的一份实现，随包复制到 scripts/step.ps1）
#
# 为什么存在：以前每个包的 install 脚本只打 `[xxx-install] progress: NN`，宿主把它压成
# 一条进度条 —— 用户看不到「装的是哪一步、这一步成没成」。安装窗要列步骤表 + 逐步日志 +
# 失败定位，就必须有结构化的步骤行。真源只有这一份，各包只调用、不各写一套。
#
# 协议（stdout 一行一条 JSON，UTF-8，前后无其它字符的那一行才被宿主认）：
#   {"mtnodeStep":1,"id":"<步骤id>","title":"<标题>","status":"run|ok|fail|skip","pct":<0-100>,"message":"<说明>"}
#   · id 必须与同包 steps.json 里的 id 一致（安装窗靠它对上左侧步骤表）
#   · status="ok" 时 pct 取该步结束时的整体百分比（不给也行：宿主按「第几步」折算）
#   · status="fail" 时 message 写人能看懂的原因（安装窗会把它当「建议修复」的引子）
#
# 用法（每个包在脚本开头 dot-source 本文件，然后按步骤调用）：
#   . (Join-Path $PSScriptRoot "step.ps1")
#   Step-Begin "venv" "创建 Python 虚拟环境" 15
#   ...真正干活的命令...
#   Step-Ok "venv" 25
#   # 出错时（脚本自己要能兜住）：
#   catch { Step-Fail "venv" "venv 创建失败：$($_.Exception.Message)"; throw }
#
# 说明：Progress-Line 仍可继续调用（老进度口径与卡片状态行不变），本文件只是**多打一行**。
# 不写文件、不联网、不依赖任何外部模块。
# =============================================================================

$script:MTStepIds = New-Object System.Collections.ArrayList
$script:MTStepPct = 0

function Write-MTStepJson {
  param(
    [string]$Id,
    [string]$Title,
    [string]$Status,
    [object]$Pct,
    [string]$Message
  )
  $obj = [ordered]@{
    mtnodeStep = 1
    id         = [string]$Id
    title      = [string]$Title
    status     = [string]$Status
  }
  if ($null -ne $Pct -and "$Pct" -ne "") {
    $n = 0
    if ([int]::TryParse("$Pct", [ref]$n)) { $obj.pct = $n }
  }
  if ($Message) { $obj.message = [string]$Message }
  try {
    $json = $obj | ConvertTo-Json -Compress -Depth 3
  } catch {
    return
  }
  # ConvertTo-Json 在旧版 PowerShell 里会把非 ASCII 转成 \uXXXX —— 宿主按 UTF-8 解 JSON，
  # 两种写法都能读；这里保持原样输出即可（不手工 unescape，避免破坏字符串里的转义）。
  Write-Host $json
}

function Get-MTStepIndex {
  param([string]$Id)
  $i = 0
  foreach ($x in $script:MTStepIds) {
    if ("$x" -eq "$Id") { return $i }
    $i++
  }
  return -1
}

# 记住这一步开始了（没在 steps.json 里声明过的 id 也接受：脚本永远比清单可信）
function Step-Begin {
  param([string]$Id, [string]$Title, [object]$Pct, [string]$Message)
  if ((Get-MTStepIndex $Id) -lt 0) { [void]$script:MTStepIds.Add([string]$Id) }
  if ($null -ne $Pct -and "$Pct" -ne "") { $script:MTStepPct = [int]$Pct }
  Write-MTStepJson -Id $Id -Title $Title -Status "run" -Pct $Pct -Message $Message
}

function Step-Ok {
  param([string]$Id, [object]$Pct, [string]$Message)
  $i = Get-MTStepIndex $Id
  if ($i -lt 0) { [void]$script:MTStepIds.Add([string]$Id) }
  if ($null -ne $Pct -and "$Pct" -ne "") { $script:MTStepPct = [int]$Pct }
  Write-MTStepJson -Id $Id -Title "" -Status "ok" -Pct $Pct -Message $Message
}

function Step-Fail {
  param([string]$Id, [string]$Message)
  $i = Get-MTStepIndex $Id
  if ($i -lt 0) { [void]$script:MTStepIds.Add([string]$Id) }
  Write-MTStepJson -Id $Id -Title "" -Status "fail" -Pct "" -Message $Message
}

# 本步跳过（要件已就绪 / 用户显式跳过）：安装窗显示「已跳过」而不是「失败」
function Step-Skip {
  param([string]$Id, [string]$Message)
  Write-MTStepJson -Id $Id -Title "" -Status "skip" -Message $Message
}

# 把「第 i 步 / 共 n 步」折成整体百分比，脚本不必自己算
function Step-Pct {
  param([int]$Step, [int]$Total)
  if ($Total -le 0) { return 0 }
  return [int][math]::Round((100.0 * $Step) / $Total)
}

# -----------------------------------------------------------------------------
# Step-Progress：给「本来就在按顺序打阶段性进度」的大脚本（sensenova / yue / breeze）
# 用的一层薄适配 —— 它不重写那些脚本的流程，只把已有的进度行**翻译**成结构化步骤行。
#
# 为什么要有它：这些脚本的 install / repair 逻辑是逐行调过的（镜像回退、档位探测、
# 续传、mock 冒烟），整体重排成 Step-Begin 调用既贵又危险。用一张「进度阈值 → 步骤 id」
# 表接上去，脚本里仍然只有原来的进度数字，但安装窗能列出步骤、并在失败时停在正确那一步。
#
# 语义（严格顺序执行，不回退）：
#   Step-Progress -Pct 34      → 进入门槛 ≤34 的那一步：上一步标 ok，本步标 run（只打一次）
#   Step-Progress -Pct 100     → 前面的步骤全部 ok，整体 pct 给到 100
#   Step-Progress -Fail "原因"  → 当前这一步标 fail（脚本自己 catch 到错误时调用）
#   Step-Progress -Skip "原因"  → 当前这一批（同一门槛）的步骤标 skip（如 -SkipTorch / -SkipModels）
#
# 表由脚本在完成步骤解析后调用一次 Step-ProgressMap 给出（脚本自己的步骤 id 真源）。
# -----------------------------------------------------------------------------

function Step-ProgressMap {
  param([object[]]$Map)
  # Map：有序数组，每项 @{ at = <进度阈值>; id = "<步骤id>"; title = "<标题>" }
  $script:MTProgMap = @()
  if ($Map) { $script:MTProgMap = @($Map) }
  $script:MTProgIdx = -1
  $script:MTProgPct = 0
}

function Step-Progress {
  param([object]$Pct, [string]$Fail, [string]$Skip)
  $map = @($script:MTProgMap)
  if ($map.Count -eq 0) { return }

  if ($Fail) {
    $cur = if ($script:MTProgIdx -ge 0) { $map[$script:MTProgIdx] } else { $map[0] }
    Step-Fail $cur.id $Fail
    return
  }

  if ($null -ne $Pct -and "$Pct" -ne "") {
    $p = 0
    if (-not [int]::TryParse("$Pct", [ref]$p)) { return }
    if ($p -gt $script:MTProgPct) { $script:MTProgPct = $p }
  }
  $p = $script:MTProgPct

  # 本次跨过的最后一步：从当前步往后找所有门槛 ≤ p 的项
  $target = $script:MTProgIdx
  $i = 0
  foreach ($m in $map) {
    if ([int]$m.at -le $p) { $target = $i }
    $i++
  }
  if ($target -lt 0) { return }

  if ($Skip) {
    # 同一门槛的整批（如 torch 相关两步共享 30）一起标跳过
    $i = 0
    foreach ($m in $map) {
      if ($i -le $target -and $i -gt $script:MTProgIdx) { Step-Skip $m.id $Skip }
      $i++
    }
    $script:MTProgIdx = $target
    return
  }

  if ($target -gt $script:MTProgIdx) {
    # 上一步收尾（若已开始），本步开始
    if ($script:MTProgIdx -ge 0) { Step-Ok $map[$script:MTProgIdx].id $map[$target].at }
    for ($k = $script:MTProgIdx + 1; $k -le $target; $k++) {
      Step-Begin $map[$k].id $map[$k].title $map[$k].at
    }
    $script:MTProgIdx = $target
  }

  if ($p -ge 100) {
    $i = 0
    foreach ($m in $map) {
      if ($i -lt $map.Count) { Step-Ok $m.id 100 }
      $i++
    }
    $script:MTProgIdx = $map.Count - 1
  }
}

