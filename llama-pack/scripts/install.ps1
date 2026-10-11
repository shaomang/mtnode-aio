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

# WHY Invoke-Quiet EXISTS (a real failure seen on a user machine): any native tool (pip / python /
# node / nvidia-smi / git / npm) that writes ONE line to stderr -- even a harmless
# "WARNING: Skipping uvloop as it is not installed." -- becomes a TERMINATING error under this
# script's $ErrorActionPreference = "Stop" on Windows PowerShell 5.1. The installer died right
# there; the user saw "exit 1 at the smoke step" with nothing but a warning as the last log line.
# So everywhere we do not care about stderr (nor need the native exit code) we go through
# Invoke-Quiet: it temporarily restores ErrorActionPreference to Continue and sends the child's
# stderr to $null. (Do NOT use "2>&1 | Out-Null" instead: PowerShell still forwards those error
# records to its own stderr and the host, which only drains stdout, blocks on a full pipe.)
function Invoke-Quiet {
  param([string]$Exe, [string[]]$Args, [switch]$PassThru)
  $prev = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    if ($PassThru) { return (& $Exe @Args 2>$null) }
    & $Exe @Args 2>$null | Out-Null
  } finally { $ErrorActionPreference = $prev }
}

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
#
# WHY THE MIRROR LIST IS [string[]] (a real failure: "the llama.cpp binary will not download"):
# `$urls = @("https://a/" + `$Url, ...)` is NOT an array on Windows PowerShell 5.1 -- when an array
# literal contains a "+" expression, PowerShell glues the whole thing into ONE space-joined string,
# so `foreach (`$u in `$urls)` runs once with all five URLs concatenated and Invoke-WebRequest answers
# 404 (that is the "remote server returned (404) not found" line in the log). Declare the chain as
# [string[]] with each element computed separately.
function Invoke-Download {
  param([string]$Url, [string]$Out)
  [string[]]$urls = @(
    ("https://ghfast.top/" + $Url),
    ("https://gh-proxy.com/" + $Url),
    ("https://ghproxy.net/" + $Url),
    ("https://ghproxy.com/" + $Url),
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

# When no CUDA variant can be downloaded we DO NOT fall back to the CPU build (this round's rule:
# GPU only, a silent CPU fallback is forbidden). The CPU llama-server used to be installed here
# behind the user's back: it installs, it even "runs", but inference lands on the CPU -- the user
# believes the local model is ready while it is unusably slow, and the UI cannot tell the
# difference (a real incident). Now the install stops at this step with a fix the user can act on
# (another mirror / drop the binary in by hand / upgrade the driver).
if (-not $downloaded) {
  Write-Host "[llama-install] error: no CUDA llama.cpp build could be downloaded (variants: $($cudaVariants -join ' / '))."
  Write-Host "[llama-install]        NOT falling back to the CPU build: this plugin must run on the GPU."
  Write-Host "[llama-install]        how to fix:"
  Write-Host "[llama-install]          1) check that GitHub or a gh proxy is reachable from this machine (tried: ghfast.top / gh-proxy.com / ghproxy.net / ghproxy.com / github.com)"
  Write-Host "[llama-install]          2) or download $zipName by hand and unzip it into $binDir (llama-server.exe must end up in bin\\), then rerun"
  Write-Host "[llama-install]          3) if your driver is older than CUDA 12.4 support, upgrade the NVIDIA driver first"
  Write-Host "[llama-install]        the venv and the Python dependencies already installed are kept; rerun resumes at this step."
  Step-Fail "server" "llama.cpp CUDA binary download failed (direct GitHub and the gh proxy mirrors are all unreachable). Install a CUDA build by hand into bin\ and rerun -- no CPU fallback (this backend must use the GPU)."
  throw "llama.cpp CUDA binary download failed (direct + ghproxy); CPU fallback was removed on purpose (GPU only)."
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
# There used to be a `pip uninstall -y uvloop` line here (uvicorn[standard] pulls it on Linux and it
# cannot install on Windows). It is gone on purpose: it achieved nothing (this pack requirements
# never list uvloop) while spawning one more native child process -- and the PowerShell the host
# launches has no console, so every extra child is another chance to hang at startup (measured this
# round: the install window sat forever on the smoke step right after that line).

# Smoke import: run it INLINE (no Start-Process) -- measured at ~0.1s in a command-line context.
#
# HARD RULE (a real failure this round): this script must not write a single byte to stderr.
# The host (main-llama.js) drains stdout only and feeds it to the install window; nothing reads the
# stderr pipe, so leftover native noise (pip "WARNING: Skipping uvloop...", python "Error: [Errno
# 13] Permission denied...") fills the pipe buffer and the whole installer BLOCKS on that write --
# the user sees the install window frozen on the smoke step for tens of minutes, the last log line
# still the previous one. So every native call redirects stderr to a file (or 2>`$null plus
# Invoke-Quiet for the native exit code) and never leaves it on the inherited pipe.
$smokeOut = Join-Path $env:TEMP ("mtnode-llama-smoke-" + [guid]::NewGuid().ToString("N") + ".out")
$smokeErr = $smokeOut + ".err"
$prevEap = $ErrorActionPreference
$ErrorActionPreference = "Continue"
& $venvPy -c "import fastapi; from app import server; print('ok')" 1> $smokeOut 2> $smokeErr
$smokeCode = $LASTEXITCODE
$ErrorActionPreference = $prevEap
$smokeText = (Get-Content $smokeOut -ErrorAction SilentlyContinue | Out-String).Trim()
$smokeErrText = (Get-Content $smokeErr -ErrorAction SilentlyContinue | Out-String).Trim()
if ($smokeText) { Write-Host "[llama-install] smoke stdout: $smokeText" }
if ($smokeErrText) { Write-Host "[llama-install] smoke stderr: $smokeErrText" }
Remove-Item $smokeOut, $smokeErr -Force -ErrorAction SilentlyContinue
$LASTEXITCODE = $smokeCode
if ($LASTEXITCODE -ne 0) {
  Step-Fail "smoke" "smoke import failed: fastapi or app.server inside the venv cannot be imported (dependencies only half installed / requirements out of sync with the code). Read this step's log and rerun the install."
  throw "smoke import failed"
}
Step-Ok "smoke" 100

New-Item -ItemType File -Force -Path (Join-Path $InstallDir ".install-ok") | Out-Null
Write-Host "[llama-install] progress: 100"
Write-Host "[llama-install] done"
exit 0
