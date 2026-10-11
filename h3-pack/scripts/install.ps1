# =============================================================================
# MiniMax H3 本地视频后端 —— **逐步骤安装编排**
#
# 为什么有这份脚本：以前 h3 的 installProject 只做「检查磁盘 → 直接把活交给 Agent」，
# 安装过程在界面里只有一句「Agent 正在安装…」，装到哪、哪一步炸了都看不见。
# 现在把已有的两份包内脚本按步骤串起来（都还在，逻辑一行没搬），每一步打一条步骤行，
# 安装窗就能列出「装 ComfyUI venv / 装 torch / 下载权重…」并停死在失败那一步。
#
# 复用（不改语义）：
#   scripts/setup_env.ps1     建立隔离 ComfyUI venv + CUDA torch + 自定义节点
#                             （-SourceOnly 只保证 ComfyUI 源码在场，本轮新增）
#   scripts/download_models.ps1  从 ModelScope 下载 MiniMax H3 权重（失败回退 hf-mirror）
#
# 步骤 id 与同目录 steps.json 一致：disk / comfy / venv / nodes / weights / smoke
# 进步协议见 scripts/step.ps1。脚本可重跑（子脚本本身幂等 / 可续传）。
#
# 为什么 comfy 与 venv 要分开判据（上一版的坑，本轮修的就是它）：
#   上一版只要 ComfyUI\main.py 已存在，就把「源码 + 环境」整段跳过（setup_env.ps1 根本没跑），
#   随后 venv 步按「venv\Scripts\python.exe 不存在」判失败。于是**任何「源码已拉下来、venv 还没建」**
#   的现场（正常的断点续装 / 上次装到一半）都会卡在 venv，报「隔离 venv 没建起来」。
#   现在：comfy 步只管源码（缺才拉）；venv 步**每次都跑** setup_env.ps1（幂等），再按实测复检。
#
# 失败口径（本轮新增）：
#   · 失败原因按证据分档（环境准备没跑成 / venv 在但 cuda 不可用 / comfy_kitchen 导入失败），
#     不再一律甩「驱动与 CUDA 档位不匹配」；
#   · 失败步的 message 直接附上子脚本输出的**关键报错行**（尾部），用户不必自己翻整段日志；
#   · 失败时把后面没跑到的步骤显式标 skip（安装窗显示「已跳过」），一眼看出哪几步压根没跑。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -InstallDir "D:\mtnode\h3"
# =============================================================================
param(
  [string]$InstallDir = (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)),
  [int]$DiskHintGb = 70
)

try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
$OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$env:PYTHONIOENCODING = 'utf-8'
$ErrorActionPreference = "Stop"

$stepLib = Join-Path $PSScriptRoot "step.ps1"
if (Test-Path $stepLib) { . $stepLib }
else {
  function Write-MTStepJson { param([string]$Id,[string]$Title,[string]$Status,[object]$Pct,[string]$Message)
    $o = [ordered]@{ mtnodeStep = 1; id = $Id; title = $Title; status = $Status }
    if ("$Pct" -ne "") { $n = 0; if ([int]::TryParse("$Pct",[ref]$n)) { $o.pct = $n } }
    if ($Message) { $o.message = $Message }
    Write-Host ($o | ConvertTo-Json -Compress -Depth 3)
  }
  function Step-Begin { param([string]$Id,[string]$Title,[object]$Pct,[string]$Message) Write-MTStepJson $Id $Title "run" $Pct $Message }
  function Step-Ok { param([string]$Id,[object]$Pct,[string]$Message) Write-MTStepJson $Id "" "ok" $Pct $Message }
  function Step-Fail { param([string]$Id,[string]$Message) Write-MTStepJson $Id "" "fail" "" $Message }
  function Step-Skip { param([string]$Id,[string]$Message) Write-MTStepJson $Id "" "skip" "" $Message }
}

$ComfyRoot = Join-Path $InstallDir "ComfyUI"
$VenvDir = Join-Path $ComfyRoot "venv"
$VenvPy = Join-Path $VenvDir "Scripts\python.exe"
$ComfyMain = Join-Path $ComfyRoot "main.py"

# 步骤清单（与同目录 steps.json 一致，顺序即执行顺序）。
# 失败收尾靠它把「还没跑过」的步骤显式标 skip —— 用户在安装窗一眼看出哪几步压根没跑。
$StepOrder = @("disk", "comfy", "venv", "nodes", "weights", "smoke")

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Write-Host "[h3-install] install dir: $InstallDir"

# 子脚本输出的环形缓冲（只留最后 200 行）：失败时从里面摘「关键报错行」写进失败步的 message。
$script:SubTail = New-Object System.Collections.ArrayList
$script:SubBad = $false
function Add-SubTail {
  param([string]$Line)
  [void]$script:SubTail.Add([string]$Line)
  while ($script:SubTail.Count -gt 200) { $script:SubTail.RemoveAt(0) }
}

# 摘「关键报错行」：命中报错字样的最后几行，单行拼接（安装窗那一步第二行直接显示它）；
# 一行都没命中就退回最后 2 行普通输出。全空则返回空串。
function Get-ErrorTail {
  param([int]$MaxLines = 3, [int]$MaxChars = 600)
  $pat = '(?i)(error|failed|failure|traceback|exception|no matching distribution|could not|cannot|unable|not found|timed out|denied|fatal|abort|失败|错误|超时|拒绝|找不到|无法)'
  $all = @()
  foreach ($l in $script:SubTail) {
    $s = ([string]$l).Trim()
    if ($s) { $all += $s }
  }
  if (-not $all.Count) { return "" }
  $hits = @($all | Where-Object { $_ -match $pat })
  $picked = if ($hits.Count -gt 0) { @($hits | Select-Object -Last $MaxLines) } else { @($all | Select-Object -Last 2) }
  $txt = (@($picked) -join " / ").Trim()
  if ($txt.Length -gt $MaxChars) { $txt = $txt.Substring($txt.Length - $MaxChars) }
  return $txt
}

# 失败步的 message：一句人话 + 子脚本输出尾部的关键报错行
function New-FailText {
  param([string]$Head, [string]$Tail)
  $t = ([string]$Tail).Trim()
  if ($t) { return ($Head + " ｜ 报错尾部：" + $t) }
  return $Head
}

# 失败收尾：把这一步之后还没跑过的步骤标「已跳过」（不留在「待执行」上）
function Skip-AfterStep {
  param([string]$StepId)
  $i = [array]::IndexOf($StepOrder, $StepId)
  if ($i -lt 0) { return }
  for ($k = $i + 1; $k -lt $StepOrder.Count; $k++) { Step-Skip $StepOrder[$k] "前一步失败，本步未执行" }
}

# 跑一个子脚本：一边**实时**把输出逐行转发给安装窗（长步骤不再整段沉默），
# 一边把尾部留在环形缓冲里供失败诊断；成败判据两条：退出码 + 输出里的明确失败标记。
function Invoke-SubScript {
  param([string]$Path, [string]$What, [string[]]$ExtraArgs = @())
  if (-not (Test-Path $Path)) { throw "缺少脚本 $Path（包不完整：请在插件里重装或更新插件资源）" }
  $script:SubTail.Clear()
  $script:SubBad = $false
  $psArgs = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $Path) + @($ExtraArgs)
  # pip / git / python 往 stderr 写是常态：Stop 档下 PowerShell 会把它们当终止性错误抛出，
  # 真正的报错文本反而丢了 —— 这一段临时降到 Continue，让 stderr 老老实实进管道。
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    & powershell.exe @psArgs 2>&1 | ForEach-Object {
      $line = [string]$_
      Add-SubTail $line
      Write-Host $line
      if (-not $script:SubBad) {
        if ($line -match '(?i)^\s*ok\s*=\s*false\b' -or $line -match '(?i)\bFAILED\b' -or $line -match 'Traceback \(most recent call last\)') {
          $script:SubBad = $true
        }
      }
    }
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $prevEap
  }
  if ($code -ne 0) { throw "$What 退出码 $code" }
  if ($script:SubBad) { throw "$What 报告失败（输出里有 ok=false / FAILED / Traceback）" }
}

# 探针：跑 venv python 的一小段代码，拿回最后一行输出 + 全部输出（同一个理由：报错在 stderr，
# 不能让它变成终止性错误）。判定一律看最后一行，报错文本一律附给失败步。
function Invoke-VenvProbe {
  param([string]$Code)
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $lines = @(& $VenvPy -c $Code 2>&1)
  } finally {
    $ErrorActionPreference = $prevEap
  }
  $txt = (@($lines | ForEach-Object { "$_" }) -join " / ").Trim()
  $last = if ($lines.Count) { "$($lines[$lines.Count - 1])".Trim() } else { "" }
  return @{ Last = $last; Text = $txt }
}

# -- 1. 磁盘 ------------------------------------------------------------------
Step-Begin "disk" "检查磁盘空间" 3 "建议预留 ≥${DiskHintGb}GB"
try {
  $drive = (Get-Item $InstallDir).PSDrive
  $freeGb = [math]::Round((Get-PSDrive $drive.Name).Free / 1GB, 1)
  Write-Host "[h3-install] disk free≈${freeGb}GB (hint ≥${DiskHintGb}GB)"
  if ($freeGb -lt $DiskHintGb) {
    Step-Fail "disk" "磁盘剩余约 ${freeGb}GB，低于建议的 ${DiskHintGb}GB（ComfyUI + torch + MiniMax H3 权重要占几十 GB）。清理磁盘或换一个剩余空间足够的安装目录后重跑。"
    Skip-AfterStep "disk"
    exit 1
  }
  Step-Ok "disk" 6
} catch {
  Step-Fail "disk" "无法读取安装目录所在磁盘的剩余空间：$($_.Exception.Message)"
  Skip-AfterStep "disk"
  exit 1
}

# -- 2. ComfyUI 源码 ----------------------------------------------------------
Step-Begin "comfy" "准备 ComfyUI 源码" 8
try {
  if (Test-Path $ComfyMain) {
    Step-Ok "comfy" 14 "ComfyUI 已在 $ComfyRoot"
  } else {
    # 源码不在就只拉源码（setup_env -SourceOnly）：venv / torch / 依赖留给下一步统一备齐，
    # 免得整段环境准备在这里跑一遍、下一步又跑一遍。
    Invoke-SubScript (Join-Path $PSScriptRoot "setup_env.ps1") "ComfyUI 源码准备" @("-SourceOnly")
    if (-not (Test-Path $ComfyMain)) { throw "setup_env -SourceOnly 跑完仍找不到 ComfyUI\main.py" }
    Step-Ok "comfy" 14
  }
} catch {
  Step-Fail "comfy" (New-FailText "ComfyUI 源码准备失败：$($_.Exception.Message)。多为 git 拉取被网络挡住（脚本先直连再走 ghproxy 镜像）；确认网络后重跑。" (Get-ErrorTail))
  Skip-AfterStep "comfy"
  exit 1
}

# -- 3. venv + torch（setup_env.ps1 一并完成；**每次都跑**，幂等） ---------------
Step-Begin "venv" "建立隔离 venv 与 CUDA torch" 16
try {
  Write-Host "[h3-install] env prep: setup_env.ps1 (idempotent; venv / torch / deps are only topped up when needed)"
  Invoke-SubScript (Join-Path $PSScriptRoot "setup_env.ps1") "ComfyUI 环境准备"
  if (-not (Test-Path $VenvPy)) {
    Step-Fail "venv" (New-FailText "环境准备没跑完（venv 仍不存在 $VenvPy）：最常见的现场是「依赖那一步的 pip 挂了」，而不是「驱动与 CUDA 档位不匹配」—— 本步日志尾部给出的 pip 原始报错才是真判据。pip 已依次试过清华 / 阿里云 / USTC / 官方 PyPI：若日志里是「No matching distribution found for 某包」，说明该包在这四个源上都还没同步，先重试一次（脚本会自动走下一级源），仍失败就按包名上报。" (Get-ErrorTail))
    Skip-AfterStep "venv"
    exit 1
  }
  $cuda = Invoke-VenvProbe "import torch;print('cuda' if torch.cuda.is_available() else 'nocuda')"
  if ($cuda.Last -ne "cuda") {
    Step-Fail "venv" (New-FailText "venv 里的 torch 装上了，但 torch.cuda.is_available() 不成立：装的是 CPU 版 torch，或本机 NVIDIA 驱动不支持所装 CUDA 档位（H3 要 cu130）。升级驱动或重装对应档位的 torch 后重跑。" $cuda.Text)
    Skip-AfterStep "venv"
    exit 1
  }
  $kit = Invoke-VenvProbe "import comfy_kitchen;print('kitchen_ok')"
  if ($kit.Last -ne "kitchen_ok") {
    Step-Fail "venv" (New-FailText "venv 里 torch 已就绪（cuda 可用），但 import comfy_kitchen 失败 —— 这多半不是驱动问题，而是 ComfyUI 依赖没装全（pip 依赖缺失），或 torch 档位与 comfy_kitchen 不匹配。pip 已依次试过清华 / 阿里云 / USTC / 官方 PyPI：先重试一次；若日志里是「No matching distribution found for 某包」，就是该包在四个源上都没同步，按包名上报。" $kit.Text)
    Skip-AfterStep "venv"
    exit 1
  }
  Step-Ok "venv" 46
} catch {
  Step-Fail "venv" (New-FailText "环境准备失败：$($_.Exception.Message)。pip / torch / git 的原始报错见本步日志尾部。" (Get-ErrorTail))
  Skip-AfterStep "venv"
  exit 1
}

# -- 4. 自定义节点 -------------------------------------------------------------
Step-Begin "nodes" "安装 ComfyUI 依赖与自定义节点" 30
try {
  $nodes = Join-Path $ComfyRoot "custom_nodes"
  $nodeCount = if (Test-Path $nodes) { (Get-ChildItem $nodes -Directory -ErrorAction SilentlyContinue | Measure-Object).Count } else { 0 }
  if ($nodeCount -le 0) {
    throw "custom_nodes 里没有任何自定义节点：ComfyUI 依赖 / 节点没装上（看本步日志里 pip 与 git 的报错）"
  }
  Write-Host "[h3-install] custom_nodes: $nodeCount 个"
  Step-Ok "nodes" 55
} catch {
  Step-Fail "nodes" (New-FailText "ComfyUI 依赖 / 自定义节点没装齐：$($_.Exception.Message)。" (Get-ErrorTail))
  Skip-AfterStep "nodes"
  exit 1
}

# -- 5. 权重 ------------------------------------------------------------------
Step-Begin "weights" "下载 MiniMax H3 权重" 58
try {
  Invoke-SubScript (Join-Path $PSScriptRoot "download_models.ps1") "MiniMax H3 权重下载"
  Step-Ok "weights" 90
} catch {
  Step-Fail "weights" (New-FailText "权重下载失败：$($_.Exception.Message)。权重来自 ModelScope（失败回退 hf-mirror），确认网络可达后重跑，已下载分片会复用。" (Get-ErrorTail))
  Skip-AfterStep "weights"
  exit 1
}

# -- 6. 收尾 ------------------------------------------------------------------
Step-Begin "smoke" "校验安装结果并写标记" 92
try {
  $missing = @()
  foreach ($p in @(
    (Join-Path $ComfyRoot "main.py"),
    $VenvPy,
    (Join-Path $ComfyRoot "models\diffusion_models"),
    (Join-Path $ComfyRoot "models\text_encoders"),
    (Join-Path $ComfyRoot "models\vae")
  )) { if (-not (Test-Path $p)) { $missing += $p } }
  if ($missing.Count) { throw ("缺件：" + ($missing -join " / ")) }
  New-Item -ItemType File -Force -Path (Join-Path $InstallDir ".install-ok") | Out-Null
  Step-Ok "smoke" 100
} catch {
  Step-Fail "smoke" "安装收尾校验不通过：$($_.Exception.Message)。缺的目录 / 文件写在上面，补齐后重跑本脚本。"
  Skip-AfterStep "smoke"
  exit 1
}

Write-Host "[h3-install] done"
exit 0
