param(
  [string]$InstallDir = (Split-Path -Parent $MyInvocation.MyCommand.Path | Split-Path -Parent)
)

# Force UTF-8 for this process so the host (which decodes our stdout as UTF-8)
# and every native tool we spawn (pip / git / python) agree on one encoding.
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
$OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$env:PYTHONIOENCODING = 'utf-8'

$ErrorActionPreference = "Stop"

# -- CN mirrors (single source of truth: repo root cn-mirrors.js; see docs/mirror-sources.md) --
# A machine-wide pip.ini often carries an unreachable extra-index-url (NVIDIA PyIndex's
# pypi.ngc.nvidia.com is the usual one). Passing --index-url on the command line does NOT
# override extra-index-url, so every package wastes 5 retries. Setting the three PIP_*
# variables below overrides index / extra-index / trusted-host inside this process and every
# child (pip / git / npm inherit them). Do NOT add `pip --isolated`: it ignores environment
# variables, which lets that unreachable extra-index back in.
$env:PIP_INDEX_URL       = if ($env:MTNODE_PIP_INDEX) { $env:MTNODE_PIP_INDEX } else { "https://pypi.tuna.tsinghua.edu.cn/simple" }
$env:PIP_EXTRA_INDEX_URL = $env:PIP_INDEX_URL
$env:PIP_TRUSTED_HOST    = "pypi.tuna.tsinghua.edu.cn"
if (-not $env:HF_ENDPOINT)         { $env:HF_ENDPOINT = "https://hf-mirror.com" }
if (-not $env:HF_HUB_DISABLE_XET)  { $env:HF_HUB_DISABLE_XET = "1" }
if (-not $env:npm_config_registry) { $env:npm_config_registry = "https://registry.npmmirror.com" }
Write-Host "[llama-install] mirrors: pip=$env:PIP_INDEX_URL (fallback aliyun / USTC -> official) | weights=ModelScope -> $env:HF_ENDPOINT | npm=$env:npm_config_registry"

Set-Location $InstallDir

# Step protocol (the install window lists its steps / locates the failing step from it): the single
# source is scripts/step.ps1 in this pack
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
Write-Host "[llama-install]   - llama.cpp binaries come from GitHub Releases, which may not be reachable directly from mainland China: we retry through the ghfast.top / gh-proxy.com / ghproxy.net / ghproxy.com proxies first, direct github.com last"
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

Step-Begin "python" "check Python 3.10+" 3
$pyInfo = Find-Python
$py = $pyInfo.exe
$pyArgs = $pyInfo.args
Write-Host "[llama-install] python: $py $($pyArgs -join ' ')"
Step-Ok "python" 8

Write-Host "[llama-install] creating venv..."
Write-Host "[llama-install] progress: 15"
Step-Begin "venv" "create the .venv virtual environment" 10
if ($py -eq "py") {
  & py @pyArgs -m venv .venv
} else {
  & python -m venv .venv
}

$venvPy = Join-Path $InstallDir ".venv\Scripts\python.exe"
if (-not (Test-Path $venvPy)) {
  Step-Fail "venv" "venv creation failed ($venvPy does not exist). Make sure the disk is writable and the Python install is complete (venv module included), then rerun."
  throw "venv creation failed"
}
Step-Ok "venv" 15

$pipIndex = $env:PIP_INDEX_URL
$pipHost = $env:PIP_TRUSTED_HOST
Write-Host "[llama-install] pip install requirements..."
Write-Host "[llama-install] progress: 25"
Step-Begin "pip" "install the Python dependencies (Tsinghua mirror)" 18
& $venvPy -m pip install --upgrade pip -i $pipIndex --trusted-host $pipHost
Write-Host "[llama-install] progress: 40"
& $venvPy -m pip install -r requirements.txt -i $pipIndex --trusted-host $pipHost
if ($LASTEXITCODE -ne 0) {
  Step-Fail "pip" "pip install -r requirements.txt failed (exit code $LASTEXITCODE). It is usually a mirror / network hiccup: make sure pypi.tuna.tsinghua.edu.cn is reachable and rerun; packages already installed are not fetched again."
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

# GitHub releases: retry through the China gh proxies first (ghfast.top -> gh-proxy.com -> ghproxy.net ->
# ghproxy.com) and only then the direct github.com URL (mainland China networks)
function Invoke-Download {
  param([string]$Url, [string]$Out)
  $urls = @(
    "https://ghfast.top/" + $Url,
    "https://gh-proxy.com/" + $Url,
    "https://ghproxy.net/" + $Url,
    "https://ghproxy.com/" + $Url,
    $Url
  )
  foreach ($u in $urls) {
    try {
      Invoke-WebRequest -Uri $u -OutFile $Out -UseBasicParsing
      return $true
    } catch {
      Write-Host "[llama-install] $u failed ($($_.Exception.Message)); trying the next mirror..."
    }
  }
  return $false
}

foreach ($variant in $cudaVariants) {
  $zipName = "llama-$release-bin-win-$variant-x64.zip"
  $url = "https://github.com/ggml-org/llama.cpp/releases/download/$release/$zipName"
  Write-Host "[llama-install] downloading llama.cpp $release ($variant)..."
  Write-Host "[llama-install] progress: 65"
  Step-Begin "server" "download the llama.cpp llama-server binary" 45 "release $release | $variant"
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
    Step-Fail "server" "llama.cpp binary download failed (direct GitHub and the gh proxy mirrors are all unreachable). Make sure GitHub or those mirrors are reachable, or drop llama-server into bin\ by hand and rerun."
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
  Step-Fail "server" "llama-server.exe was not found after extracting (the release layout may have changed). Unzip that release into bin\ by hand and rerun, or pick another release."
  throw "llama-server.exe not found after extract"
}
Step-Ok "server" 82

New-Item -ItemType Directory -Force -Path (Join-Path $InstallDir "models") | Out-Null

Write-Host "[llama-install] smoke test import..."
Write-Host "[llama-install] progress: 92"
Step-Begin "smoke" "smoke: import fastapi and app.server" 88
& $venvPy -m pip uninstall -y uvloop 2>$null | Out-Null
& $venvPy -c "import fastapi; from app import server; print('ok')"
if ($LASTEXITCODE -ne 0) {
  Step-Fail "smoke" "smoke import failed: fastapi or app.server inside the venv cannot be imported (dependencies only half installed / requirements out of sync with the code). Read this step's log and rerun the install."
  throw "smoke import failed"
}
Step-Ok "smoke" 100

New-Item -ItemType File -Force -Path (Join-Path $InstallDir ".install-ok") | Out-Null
Write-Host "[llama-install] progress: 100"
Write-Host "[llama-install] done"
exit 0