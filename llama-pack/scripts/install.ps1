param(
  [string]$InstallDir = (Split-Path -Parent $MyInvocation.MyCommand.Path | Split-Path -Parent)
)

# Force UTF-8 for this process so the host (which decodes our stdout as UTF-8)
# and every native tool we spawn (pip / git / python) agree on one encoding.
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
$OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$env:PYTHONIOENCODING = 'utf-8'

$ErrorActionPreference = "Stop"
Set-Location $InstallDir

# 步骤协议（安装窗按它列步骤 / 定位失败步）：真源是包内 scripts/step.ps1
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

Write-Host "[llama-install] ============================================================"
Write-Host "[llama-install] About the China mirrors (required; especially important when this machine is on a mainland China network):"
Write-Host "[llama-install]   - Python packages: use the Tsinghua mirror pypi.tuna.tsinghua.edu.cn (or the CAS USTC mirror mirrors.ustc.edu.cn)"
Write-Host "[llama-install]   - llama.cpp binaries come from GitHub Releases, which may not be reachable directly from mainland China: we automatically fall back to the ghproxy mirror"
Write-Host "[llama-install]   - Model GGUF files: huggingface.co cannot be reached directly, so we go through hf-mirror.com (override with HF_ENDPOINT)"
Write-Host "[llama-install] ============================================================"
Write-Host "[llama-install] install dir: $InstallDir"
Write-Host "[llama-install] progress: 8"

function Find-Python {
  if (Get-Command py -ErrorAction SilentlyContinue) {
    try {
      $out = & py -3.10 -c "import sys; print(sys.version_info[:2])" 2>$null
      if ($LASTEXITCODE -eq 0) { return @{ exe = "py"; args = @("-3.10") } }
    } catch {}
    try {
      $out = & py -3.11 -c "import sys; print(sys.version_info[:2])" 2>$null
      if ($LASTEXITCODE -eq 0) { return @{ exe = "py"; args = @("-3.11") } }
    } catch {}
    try {
      $out = & py -3.12 -c "import sys; print(sys.version_info[:2])" 2>$null
      if ($LASTEXITCODE -eq 0) { return @{ exe = "py"; args = @("-3.12") } }
    } catch {}
  }
  if (Get-Command python -ErrorAction SilentlyContinue) {
    return @{ exe = "python"; args = @() }
  }
  throw "Python 3.10+ not found"
}

Step-Begin "python" "检查 Python 3.10+" 3
$pyInfo = Find-Python
$py = $pyInfo.exe
$pyArgs = $pyInfo.args
Write-Host "[llama-install] python: $py $($pyArgs -join ' ')"
Step-Ok "python" 8

Write-Host "[llama-install] creating venv..."
Write-Host "[llama-install] progress: 15"
Step-Begin "venv" "创建虚拟环境 .venv" 10
if ($py -eq "py") {
  & py @pyArgs -m venv .venv
} else {
  & python -m venv .venv
}

$venvPy = Join-Path $InstallDir ".venv\Scripts\python.exe"
if (-not (Test-Path $venvPy)) {
  Step-Fail "venv" "venv 创建失败（$venvPy 不存在）。确认磁盘可写、Python 安装完整（含 venv 模块）后重跑。"
  throw "venv creation failed"
}
Step-Ok "venv" 15

$pipIndex = "https://pypi.tuna.tsinghua.edu.cn/simple"
$pipHost = "pypi.tuna.tsinghua.edu.cn"
Write-Host "[llama-install] pip install requirements..."
Write-Host "[llama-install] progress: 25"
Step-Begin "pip" "安装 Python 依赖（清华镜像）" 18
& $venvPy -m pip install --upgrade pip -i $pipIndex --trusted-host $pipHost
Write-Host "[llama-install] progress: 40"
& $venvPy -m pip install -r requirements.txt -i $pipIndex --trusted-host $pipHost
if ($LASTEXITCODE -ne 0) {
  Step-Fail "pip" "pip 安装 requirements.txt 失败（退出码 $LASTEXITCODE）。多为镜像 / 网络抖动：确认能访问 pypi.tuna.tsinghua.edu.cn 后重跑，已装好的包不会重装。"
  throw "pip install failed"
}
Write-Host "[llama-install] progress: 55"
Step-Ok "pip" 40

# Read llama.cpp release from manifest
$manifest = Get-Content manifest.json -Raw | ConvertFrom-Json
$release = if ($manifest.llamaRelease) { $manifest.llamaRelease } else { "b10566" }

$binDir = Join-Path $InstallDir "bin"
New-Item -ItemType Directory -Force -Path $binDir | Out-Null

$cudaVariants = @("cuda-12.4", "cuda-13.3")
$zipPath = Join-Path $env:TEMP "llama-$release-bin.zip"
$downloaded = $false

# Fall back to the ghproxy mirror automatically when GitHub is not reachable directly (mainland China networks)
function Invoke-Download {
  param([string]$Url, [string]$Out)
  try {
    Invoke-WebRequest -Uri $Url -OutFile $Out -UseBasicParsing
    return $true
  } catch {
    Write-Host "[llama-install] direct failed ($($_.Exception.Message)); trying ghproxy mirror..."
    try {
      Invoke-WebRequest -Uri ("https://ghproxy.com/" + $Url) -OutFile $Out -UseBasicParsing
      return $true
    } catch {
      Write-Host "[llama-install] ghproxy mirror failed: $($_.Exception.Message)"
      return $false
    }
  }
}

foreach ($variant in $cudaVariants) {
  $zipName = "llama-$release-bin-win-$variant-x64.zip"
  $url = "https://github.com/ggml-org/llama.cpp/releases/download/$release/$zipName"
  Write-Host "[llama-install] downloading llama.cpp $release ($variant)..."
  Write-Host "[llama-install] progress: 65"
  Step-Begin "server" "下载 llama.cpp llama-server 二进制" 45 "release $release · $variant"
  if (Invoke-Download -Url $url -Out $zipPath) {
    $downloaded = $true
    break
  }
}

if (-not $downloaded) {
  Write-Host "[llama-install] CUDA builds failed, trying CPU build..."
  $zipName = "llama-$release-bin-win-cpu-x64.zip"
  $url = "https://github.com/ggml-org/llama.cpp/releases/download/$release/$zipName"
  if (-not (Invoke-Download -Url $url -Out $zipPath)) {
    Step-Fail "server" "llama.cpp 二进制下载失败（GitHub 直连与 ghproxy 镜像都不通）。确认网络可达 GitHub 或该镜像，或手动把 llama-server 放进 bin\ 后重跑。"
    throw "llama.cpp binary download failed (direct + ghproxy). Please make sure GitHub / the ghproxy mirror is reachable from this network."
  }
}

Write-Host "[llama-install] extracting to bin/..."
Write-Host "[llama-install] progress: 82"
Expand-Archive -Path $zipPath -DestinationPath $binDir -Force

# Flatten if nested
Get-ChildItem $binDir -Recurse -Filter "llama-server.exe" | ForEach-Object {
  $dest = Join-Path $binDir "llama-server.exe"
  if ($_.FullName -ne $dest) {
    Copy-Item $_.FullName $dest -Force
  }
}

$server = Join-Path $binDir "llama-server.exe"
if (-not (Test-Path $server)) {
  $found = Get-ChildItem $binDir -Recurse -Filter "llama-server.exe" | Select-Object -First 1
  if ($found) { Copy-Item $found.FullName $server -Force }
}
if (-not (Test-Path $server)) {
  Step-Fail "server" "解压后找不到 llama-server.exe（安装包结构可能变了）。把该 release 的 zip 手动解压到 bin\ 后重跑，或换一个 release 版本。"
  throw "llama-server.exe not found after extract"
}
Step-Ok "server" 82

New-Item -ItemType Directory -Force -Path (Join-Path $InstallDir "models") | Out-Null

Write-Host "[llama-install] smoke test import..."
Write-Host "[llama-install] progress: 92"
Step-Begin "smoke" "冒烟：导入 fastapi 与 app.server" 88
& $venvPy -m pip uninstall -y uvloop 2>$null | Out-Null
& $venvPy -c "import fastapi; from app import server; print('ok')"
if ($LASTEXITCODE -ne 0) {
  Step-Fail "smoke" "冒烟导入失败：venv 里的 fastapi 或 app.server 导不进来（依赖装了一半 / requirements 与代码不匹配）。看这一步日志后重跑安装。"
  throw "smoke import failed"
}
Step-Ok "smoke" 100

New-Item -ItemType File -Force -Path (Join-Path $InstallDir ".install-ok") | Out-Null
Write-Host "[llama-install] progress: 100"
Write-Host "[llama-install] done"
exit 0