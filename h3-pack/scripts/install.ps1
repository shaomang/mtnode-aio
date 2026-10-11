# =============================================================================
# MiniMax H3 本地视频后端 —— **逐步骤安装编排**（本轮新增）
#
# 为什么有这份脚本：以前 h3 的 installProject 只做「检查磁盘 → 直接把活交给 Agent」，
# 安装过程在界面里只有一句「Agent 正在安装…」，装到哪、哪一步炸了都看不见。
# 现在把已有的两份包内脚本按步骤串起来（都还在，逻辑一行没搬），每一步打一条步骤行，
# 安装窗就能列出「装 ComfyUI venv / 装 torch / 下载权重…」并停死在失败那一步。
#
# 复用（不改语义）：
#   scripts/setup_env.ps1     建立隔离 ComfyUI venv + CUDA torch + 自定义节点
#   scripts/download_models.ps1  从 ModelScope 下载 MiniMax H3 权重（失败回退 hf-mirror）
#
# 步骤 id 与同目录 steps.json 一致：disk / comfy / venv / nodes / weights / smoke
# 进步协议见 scripts/step.ps1。脚本可重跑（子脚本本身幂等 / 可续传）。
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
$VenvPy = Join-Path $ComfyRoot "venv\Scripts\python.exe"

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Write-Host "[h3-install] install dir: $InstallDir"

# 跑一个子脚本：输出一边打（安装窗按行收日志），一边判成败。
# 判据两条：退出码 + 输出里的明确失败标记（子脚本用 throw / "FAILED" / ok=false 报错）。
function Invoke-SubScript {
  param([string]$Path, [string]$What)
  if (-not (Test-Path $Path)) { throw "缺少脚本 $Path（包不完整：请在插件里重装或更新插件资源）" }
  $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Path 2>&1
  $code = $LASTEXITCODE
  foreach ($line in @($out)) { Write-Host "$line" }
  $text = (@($out) | Out-String)
  if ($code -ne 0) { throw "$What 退出码 $code" }
  if ($text -match '(?im)^\s*ok\s*=\s*false\b' -or $text -match '(?i)\bFAILED\b' -or $text -match 'Traceback \(most recent call last\)') {
    throw "$What 报告失败（输出里有 ok=false / FAILED / Traceback）"
  }
  return $text
}

# -- 1. 磁盘 ------------------------------------------------------------------
Step-Begin "disk" "检查磁盘空间" 3 "建议预留 ≥${DiskHintGb}GB"
try {
  $drive = (Get-Item $InstallDir).PSDrive
  $freeGb = [math]::Round((Get-PSDrive $drive.Name).Free / 1GB, 1)
  Write-Host "[h3-install] disk free≈${freeGb}GB (hint ≥${DiskHintGb}GB)"
  if ($freeGb -lt $DiskHintGb) {
    Step-Fail "disk" "磁盘剩余约 ${freeGb}GB，低于建议的 ${DiskHintGb}GB（ComfyUI + torch + MiniMax H3 权重要占几十 GB）。清理磁盘或换一个剩余空间足够的安装目录后重跑。"
    exit 1
  }
  Step-Ok "disk" 6
} catch {
  Step-Fail "disk" "无法读取安装目录所在磁盘的剩余空间：$($_.Exception.Message)"
  exit 1
}

# -- 2. ComfyUI 源码 ----------------------------------------------------------
Step-Begin "comfy" "准备 ComfyUI 源码" 8
try {
  if (Test-Path (Join-Path $ComfyRoot "main.py")) {
    Step-Ok "comfy" 14 "ComfyUI 已在 $ComfyRoot"
  } else {
    Invoke-SubScript (Join-Path $PSScriptRoot "setup_env.ps1") "ComfyUI 环境准备" | Out-Null
    if (-not (Test-Path (Join-Path $ComfyRoot "main.py"))) { throw "setup_env 跑完仍找不到 ComfyUI\main.py" }
    Step-Ok "comfy" 14
  }
} catch {
  Step-Fail "comfy" "ComfyUI 源码准备失败：$($_.Exception.Message)。多数是 git 拉取被网络挡住（脚本会先直连再走 ghproxy）；确认网络后重跑。"
  exit 1
}

# -- 3. venv + torch（setup_env.ps1 一并完成，这里按步骤如实标注） ------------
Step-Begin "venv" "建立隔离 venv 与 CUDA torch" 16
Step-Begin "nodes" "安装 ComfyUI 依赖与自定义节点" 30
try {
  if (-not (Test-Path $VenvPy)) {
    Step-Fail "venv" "隔离 venv 没建起来（$VenvPy 不存在）：看这一步的日志里 torch / pip 的报错，多半是驱动与 CUDA 档位不匹配。"
    exit 1
  }
  $cuda = & $VenvPy -c "import torch;print('ok' if torch.cuda.is_available() else 'no')" 2>&1
  if ("$cuda".Trim() -ne "ok") {
    Step-Fail "venv" "torch 装上了但 cuda.is_available() 为 false：装的是 CPU 版或与本机驱动不匹配。请升级驱动或重装对应 CUDA 档位的 torch。"
    exit 1
  }
  Step-Ok "venv" 46
  $nodes = Join-Path $ComfyRoot "custom_nodes"
  $nodeCount = if (Test-Path $nodes) { (Get-ChildItem $nodes -Directory -ErrorAction SilentlyContinue | Measure-Object).Count } else { 0 }
  if ($nodeCount -le 0) {
    Step-Fail "nodes" "custom_nodes 里没有任何自定义节点：ComfyUI 依赖 / 节点没装上，看这一步日志里 pip 与 git 的报错。"
    exit 1
  }
  Write-Host "[h3-install] custom_nodes: $nodeCount 个"
  Step-Ok "nodes" 55
} catch {
  Step-Fail "venv" "环境校验失败：$($_.Exception.Message)"
  exit 1
}

# -- 4. 权重 ------------------------------------------------------------------
Step-Begin "weights" "下载 MiniMax H3 权重" 58
try {
  Invoke-SubScript (Join-Path $PSScriptRoot "download_models.ps1") "MiniMax H3 权重下载" | Out-Null
  Step-Ok "weights" 90
} catch {
  Step-Fail "weights" "权重下载失败：$($_.Exception.Message)。权重来自 ModelScope（失败回退 hf-mirror），确认网络可达后重跑，已下载分片会复用。"
  exit 1
}

# -- 5. 收尾 ------------------------------------------------------------------
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
  exit 1
}

Write-Host "[h3-install] done"
exit 0
