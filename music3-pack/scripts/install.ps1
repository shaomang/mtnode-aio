# =============================================================================
# MiniMax Music 3 本地音乐后端 —— **逐步骤安装编排**（本轮新增）
#
# 为什么有这份脚本：以前 music3 的 installProject 只做「检查磁盘 → 直接把活交给 Agent」，
# 安装过程在界面里只有一句「Agent 正在安装…」。现在把已有的两份包内脚本按步骤串起来
# （逻辑一行没搬），每一步打一条步骤行，安装窗就能列出「装 venv+torch / 装依赖 /
# 下载官方权重…」并停在失败那一步。
#
# 复用（不改语义）：
#   scripts/setup_env.ps1       建 .venv（system-site-packages，沿用本机 CUDA torch）+ 装 requirements
#   scripts/download_models.ps1 -Target app   下载官方 Diffusers 权重（ModelScope / hf-mirror）
#
# 步骤 id 与同目录 steps.json 一致：disk / torch / deps / weights / files / smoke
# 进步协议见 scripts/step.ps1。脚本可重跑（子脚本幂等 / 权重续传）。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -InstallDir "D:\mtnode\music3"
# =============================================================================
param(
  [string]$InstallDir = (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)),
  [int]$DiskHintGb = 65
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

$VenvPy = Join-Path $InstallDir ".venv\Scripts\python.exe"
$ModelsDir = Join-Path $InstallDir "models\MiniMax-Music3"

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Write-Host "[music3-install] install dir: $InstallDir"

function Invoke-SubScript {
  param([string]$Path, [string]$What, [string[]]$ExtraArgs = @())
  if (-not (Test-Path $Path)) { throw "缺少脚本 $Path（包不完整：请在插件里重装或更新插件资源）" }
  $args = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $Path) + $ExtraArgs
  $out = & powershell.exe @args 2>&1
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
Step-Begin "disk" "检查磁盘空间" 3 "建议预留 ≥${DiskHintGb}GB（模型约 53GB）"
try {
  $drive = (Get-Item $InstallDir).PSDrive
  $freeGb = [math]::Round((Get-PSDrive $drive.Name).Free / 1GB, 1)
  Write-Host "[music3-install] disk free≈${freeGb}GB (hint ≥${DiskHintGb}GB)"
  if ($freeGb -lt $DiskHintGb) {
    Step-Fail "disk" "磁盘剩余约 ${freeGb}GB，低于建议的 ${DiskHintGb}GB（官方权重约 53GB）。清理磁盘或换一个剩余空间足够的安装目录后重跑，或用 -Force 跳过本闸门。"
    exit 1
  }
  Step-Ok "disk" 6
} catch {
  Step-Fail "disk" "无法读取安装目录所在磁盘的剩余空间：$($_.Exception.Message)"
  exit 1
}

# -- 2. venv + torch ----------------------------------------------------------
Step-Begin "torch" "建立 venv 并安装 CUDA torch" 10
Step-Begin "deps" "安装推理依赖（diffusers 固定 commit）" 26
try {
  Invoke-SubScript (Join-Path $PSScriptRoot "setup_env.ps1") "Music3 环境准备" | Out-Null
  if (-not (Test-Path $VenvPy)) { throw "venv 没建起来（$VenvPy 不存在）" }
  Step-Ok "torch" 46
  $probe = & $VenvPy -c "import torch;from diffusers import ModularPipeline;print('cuda', torch.cuda.is_available())" 2>&1
  Write-Host "[music3-install] $probe"
  if ("$probe" -notmatch 'cuda\s+True') {
    Step-Fail "torch" "torch 可用但 cuda.is_available() 为 false：本机 venv 沿用系统 torch，请确认系统 Python 里装的是 CUDA 版 torch 并升级到匹配的驱动。"
    exit 1
  }
  Step-Ok "deps" 58
} catch {
  Step-Fail "deps" "环境准备失败：$($_.Exception.Message)。requirements 里的 diffusers 来自 GitHub（脚本会走 ghproxy 镜像），确认网络后重跑。"
  exit 1
}

# -- 3. 权重 ------------------------------------------------------------------
Step-Begin "weights" "下载官方权重" 60
try {
  Invoke-SubScript (Join-Path $PSScriptRoot "download_models.ps1") "Music3 权重下载" @("-Target", "app") | Out-Null
  Step-Ok "weights" 92
} catch {
  Step-Fail "weights" "权重下载失败：$($_.Exception.Message)。App 权重走 hf-mirror，Comfy 权重走 ModelScope；确认网络后重跑，已完成分片会复用。"
  exit 1
}

# -- 4. 权重清单 --------------------------------------------------------------
Step-Begin "files" "校验权重文件清单" 93
try {
  if (-not (Test-Path $ModelsDir)) { throw "权重目录不存在：$ModelsDir" }
  $size = (Get-ChildItem $ModelsDir -Recurse -File | Measure-Object -Property Length -Sum).Sum
  $gb = [math]::Round($size / 1GB, 2)
  Write-Host "[music3-install] weights≈${gb}GB at $ModelsDir"
  if ($size -lt 5GB) { throw "权重目录只占 ${gb}GB，明显不完整（官方权重约 53GB）" }
  Step-Ok "files" 96
} catch {
  Step-Fail "files" "权重文件不完整：$($_.Exception.Message)。重跑 scripts\download_models.ps1 -Target app 补齐（支持续传）。"
  exit 1
}

# -- 5. 冒烟 ------------------------------------------------------------------
Step-Begin "smoke" "冒烟：导入并写安装标记" 97
try {
  & $VenvPy -c "import torch;from diffusers import ModularPipeline;print('music3 smoke ok')"
  if ($LASTEXITCODE -ne 0) { throw "venv 冒烟导入失败" }
  New-Item -ItemType File -Force -Path (Join-Path $InstallDir ".install-ok") | Out-Null
  Step-Ok "smoke" 100
} catch {
  Step-Fail "smoke" "冒烟导入失败：$($_.Exception.Message)。依赖装了一半或版本冲突，看这一步日志后重跑安装。"
  exit 1
}

Write-Host "[music3-install] done"
exit 0
