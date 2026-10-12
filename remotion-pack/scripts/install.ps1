# =============================================================================
# Remotion local video backend install (PowerShell; the old install.cmd was a single
# npm install with no steps and no success/failure signal, so this round moved this pack
# onto the same step protocol as the others).
#
# Step ids match steps.json in the same directory: node / copy / npm / check
# Step protocol lives in scripts/step.ps1 (this script does not build the JSON itself).
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File install.ps1 -InstallDir "D:\mtnode\remotion"
# Parameters:
#   -InstallDir  install directory (default = the directory holding this script)
#   -Official    explicitly switch back to the official npm registry https://registry.npmjs.org
#                (the default is https://registry.npmmirror.com)
#   -Registry    <url> explicit npm registry (wins over -Official; default https://registry.npmmirror.com)
#   -Mirror      legacy switch, kept for compatibility: npmmirror is the default now
#   -SkipCopy    do not copy the project files (use when the install dir already has them; the host copies them)
# =============================================================================
param(
  [string]$InstallDir = (Split-Path -Parent $MyInvocation.MyCommand.Path),
  [switch]$Official,
  [string]$Registry = "",
  [switch]$Mirror,
  [switch]$SkipCopy
)

try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
$OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$env:PYTHONIOENCODING = 'utf-8'
$ErrorActionPreference = "Stop"

# npm default registry = npmmirror (single source of truth: repo root cn-mirrors.js); only -Official / -Registry switch back to the official one
if (-not $env:npm_config_registry) { $env:npm_config_registry = "https://registry.npmmirror.com" }

$stepLib = Join-Path $PSScriptRoot "step.ps1"
if (Test-Path $stepLib) { . $stepLib }
else {
  # An older install directory may not have step.ps1 yet (it predates this pack upgrade): provide a
  # minimal implementation with the SAME function names, so the install window still gets step lines
  # instead of the whole install failing over one missing file.
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

Set-Location $InstallDir
Write-Host "[remotion-install] install dir: $InstallDir"

# -- 1. Node / npm ------------------------------------------------------------
Step-Begin "node" "" 5
try {
  $nodeV = (& node --version) 2>$null
  $npmV = (& npm --version) 2>$null
  if (-not $nodeV -or -not $npmV) { throw "node / npm not found in PATH" }
  Write-Host "[remotion-install] node $nodeV / npm $npmV"
  Step-Ok "node" 20
} catch {
  Step-Fail "node" "No usable Node / npm found: $($_.Exception.Message). Install Node.js (>=18) first, make sure node is on PATH, then rerun the install."
  exit 1
}

# -- 2. Project files ---------------------------------------------------------
Step-Begin "copy" "" 22
if ($SkipCopy) {
  Step-Skip "copy" "the install dir already has the project (the host copies it)"
} else {
  $pkg = Join-Path $InstallDir "package.json"
  if (Test-Path $pkg) { Step-Ok "copy" 30 "the project files are already in the install dir" }
  else {
    Step-Fail "copy" "no package.json in the install dir: the host must copy the remotion scaffold in first (only -SkipCopy skips this step)."
    exit 1
  }
}

# -- 3. npm install ----------------------------------------------------------
Step-Begin "npm" "" 32
# Domestic registry by default; -Official switches to the official one and -Registry <url> picks a custom one (precedence: -Registry > -Official > default)
#
# WARNING: this bit caused a real field bug (users reported
#   `EINVALIDTAGNAME: Invalid tag name "=" of package "="`). It used to be
#   `$registry = @("--registry=$Registry")` plus `& npm install @registry` -- splatting a
#   single-element array into a NATIVE command re-splits the words, so npm actually received
#   `install --registry = https://...` and treated the bare `=` as a package tag. A native
#   command argument must be one string variable: never put it in an array and splat it.
# NOTE: this file must stay pure ASCII (see step.ps1 "HARD RULE"): PowerShell 5.1 decodes a
# BOM-less .ps1 with the machine ANSI code page and non-ASCII bytes break the parser.
if ($Registry) { $regFlag = "--registry=" + $Registry }
elseif ($Official) { $regFlag = "--registry=https://registry.npmjs.org" }
else { $regFlag = "--registry=https://registry.npmmirror.com" }
Write-Host "[remotion-install] npm install $regFlag"
try {
  & npm install "$regFlag"
  if ($LASTEXITCODE -ne 0) { throw "npm install exit $LASTEXITCODE" }
  Step-Ok "npm" 88
} catch {
  Step-Fail "npm" "npm dependency install failed: $($_.Exception.Message). The default registry is https://registry.npmmirror.com (check that it is reachable first); to switch registries rerun with -Registry <url> or -Official. Packages already downloaded are reused."
  exit 1
}

# -- 4. Verify ----------------------------------------------------------------
Step-Begin "check" "" 90
try {
  & node -e "require.resolve('remotion'); require.resolve('@remotion/renderer'); console.log('ok')"
  if ($LASTEXITCODE -ne 0) { throw "remotion / @remotion/renderer failed to resolve" }
  Step-Ok "check" 100
} catch {
  Step-Fail "check" "the dependencies installed but remotion / @remotion/renderer cannot be loaded: usually a version conflict or a half-finished install. Delete node_modules and rerun the install."
  exit 1
}

New-Item -ItemType File -Force -Path (Join-Path $InstallDir ".install-ok") | Out-Null
Write-Host "[remotion-install] done"
exit 0
