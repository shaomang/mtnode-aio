# =============================================================================
# MiniMax Music 3 local music backend -- step-by-step install orchestration
#
# Why this script exists: installProject used to only "check the disk -> hand the work to the
# Agent", so the UI showed a single "Agent is installing..." line and nobody could see which
# step was running or which one blew up. This script chains the two existing pack scripts into
# steps (not one line of their logic moved) and prints a step line per step, so the install
# window lists "venv+torch / dependencies / official weights ..." and stops on the failing step.
#
# Reused as-is (semantics unchanged):
#   scripts/setup_env.ps1        creates .venv (system-site-packages, reusing the local CUDA
#                                torch) and installs requirements
#   scripts/download_models.ps1 -Target app   downloads the official Diffusers weights
#                                (ModelScope / hf-mirror)
#
# Step ids match steps.json in the same directory: disk / torch / deps / weights / files / smoke
# Step protocol lives in scripts/step.ps1. The script is re-runnable (sub-scripts are idempotent
# / the weight download resumes).
#
# Failure reporting: failing steps carry a stable error code plus dynamic values, and the
# localized (Chinese) reason and advice live in this pack's steps.json `messages` table -- the
# install window resolves them. This script must therefore stay pure ASCII (see the HARD RULE
# in step.ps1: PowerShell 5.1 decodes a BOM-less .ps1 with the machine ANSI code page, and
# non-ASCII bytes break the parser outright).
#
# Usage:
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
  # Message stays [object]: Step-Fail may receive a structured failure ({ code; params; message })
  # and typing it [string] would coerce that ordered dictionary into its type name.
  function Write-MTStepJson { param([string]$Id,[string]$Title,[string]$Status,[object]$Pct,[object]$Message)
    $o = [ordered]@{ mtnodeStep = 1; id = $Id; status = $Status }
    if ("$Title" -ne "") { $o.title = $Title }
    if ("$Pct" -ne "") { $n = 0; if ([int]::TryParse("$Pct",[ref]$n)) { $o.pct = $n } }
    if ($null -ne $Message) {
      if ($Message -is [string]) { if ("$Message" -ne "") { $o.message = $Message } }
      elseif ($Message -is [System.Collections.IDictionary]) {
        foreach ($k in @("code", "params", "message")) { if ($Message.Contains($k) -and $null -ne $Message[$k] -and "$($Message[$k])" -ne "") { $o[$k] = $Message[$k] } }
      } else { $o.message = "$Message" }
    }
    Write-Host ($o | ConvertTo-Json -Compress -Depth 4)
  }
  function Step-Begin { param([string]$Id,[string]$Title,[object]$Pct,[string]$Message) Write-MTStepJson $Id $Title "run" $Pct $Message }
  function Step-Ok { param([string]$Id,[object]$Pct,[string]$Message) Write-MTStepJson $Id "" "ok" $Pct $Message }
  function Step-Fail { param([string]$Id,[object]$Message) Write-MTStepJson $Id "" "fail" "" $Message }
  function Step-Skip { param([string]$Id,[object]$Message) Write-MTStepJson $Id "" "skip" "" $Message }
}

# Structured failure: a stable error code plus dynamic values. The install window renders the
# localized (Chinese) reason and advice by looking the code up in this pack's steps.json
# `messages` table -- this script stays pure ASCII, so no human readable text belongs here.
function New-FailCode {
  param([string]$Code, [hashtable]$Params, [string]$Message)
  $o = [ordered]@{ code = $Code }
  if ($Params -and $Params.Count) { $o.params = $Params }
  $o.message = $Message
  return $o
}

$VenvPy = Join-Path $InstallDir ".venv\Scripts\python.exe"
$ModelsDir = Join-Path $InstallDir "models\MiniMax-Music3"

# Failure contract: this script prints an English `message` and a stable `code` (+ params) on a
# failing step. The localized reason and advice live in this pack's steps.json `messages` table
# and the install window resolves the code -- that is why this file has to stay pure ASCII.
#
# The pip failure path is the one users hit most: when all four indexes are exhausted the pip
# output in the step log tail says "No matching distribution found for <package>" -- that line
# is what names the missing package, and the step message carries it as the `tail` param.

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Write-Host "[music3-install] install dir: $InstallDir"

function Invoke-SubScript {
  param([string]$Path, [string]$What, [string[]]$ExtraArgs = @())
  if (-not (Test-Path $Path)) { throw "script missing: $Path (incomplete pack: reinstall or update the plugin resources)" }
  $args = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $Path) + $ExtraArgs
  $out = & powershell.exe @args 2>&1
  $code = $LASTEXITCODE
  foreach ($line in @($out)) { Write-Host "$line" }
  $text = (@($out) | Out-String)
  if ($code -ne 0) { throw "$What exit code $code" }
  if ($text -match '(?im)^\s*ok\s*=\s*false\b' -or $text -match '(?i)\bFAILED\b' -or $text -match 'Traceback \(most recent call last\)') {
    throw "$What reported failure (ok=false / FAILED / Traceback in the output)"
  }
  return $text
}

# -- 1. disk ------------------------------------------------------------------
Step-Begin "disk" "" 3 "reserve at least ${DiskHintGb}GB"
try {
  $drive = (Get-Item $InstallDir).PSDrive
  $freeGb = [math]::Round((Get-PSDrive $drive.Name).Free / 1GB, 1)
  Write-Host "[music3-install] disk free ~${freeGb}GB (hint >= ${DiskHintGb}GB)"
  if ($freeGb -lt $DiskHintGb) {
    Step-Fail "disk" (New-FailCode "music3.disk.low_space" @{ free = "$freeGb"; want = "$DiskHintGb" } "disk free ${freeGb}GB is below the suggested ${DiskHintGb}GB")
    exit 1
  }
  Step-Ok "disk" 6
} catch {
  Step-Fail "disk" (New-FailCode "music3.disk.unreadable" @{ err = "$($_.Exception.Message)" } "cannot read the free space of the install drive: $($_.Exception.Message)")
  exit 1
}

# -- 2. venv + torch ----------------------------------------------------------
Step-Begin "torch" "" 10
Step-Begin "deps" "" 26
try {
  Invoke-SubScript (Join-Path $PSScriptRoot "setup_env.ps1") "Music3 environment setup" | Out-Null
  if (-not (Test-Path $VenvPy)) { throw "the venv was not created ($VenvPy is missing)" }
  Step-Ok "torch" 46
  $probe = & $VenvPy -c "import torch;from diffusers import ModularPipeline;print('cuda', torch.cuda.is_available())" 2>&1
  Write-Host "[music3-install] $probe"
  if ("$probe" -notmatch 'cuda\s+True') {
    Step-Fail "torch" (New-FailCode "music3.torch.cuda_unavailable" @{ probe = "$probe" } "torch is importable but cuda.is_available() is false")
    exit 1
  }
  Step-Ok "deps" 58
} catch {
  Step-Fail "deps" (New-FailCode "music3.deps.prep_failed" @{ err = "$($_.Exception.Message)" } "environment prep failed: $($_.Exception.Message)")
  exit 1
}

# -- 3. weights ---------------------------------------------------------------
Step-Begin "weights" "" 60
try {
  Invoke-SubScript (Join-Path $PSScriptRoot "download_models.ps1") "Music3 weights download" @("-Target", "app") | Out-Null
  Step-Ok "weights" 92
} catch {
  Step-Fail "weights" (New-FailCode "music3.weights.download_failed" @{ err = "$($_.Exception.Message)" } "weight download failed: $($_.Exception.Message)")
  exit 1
}

# -- 4. weight manifest -------------------------------------------------------
Step-Begin "files" "" 93
try {
  if (-not (Test-Path $ModelsDir)) { throw "the weights directory is missing: $ModelsDir" }
  $size = (Get-ChildItem $ModelsDir -Recurse -File | Measure-Object -Property Length -Sum).Sum
  $gb = [math]::Round($size / 1GB, 2)
  Write-Host "[music3-install] weights ~${gb}GB at $ModelsDir"
  if ($size -lt 5GB) { throw "the weights directory holds only ${gb}GB, clearly incomplete (the official weights are about 53GB)" }
  Step-Ok "files" 96
} catch {
  Step-Fail "files" (New-FailCode "music3.files.incomplete" @{ err = "$($_.Exception.Message)" } "the weight files are incomplete: $($_.Exception.Message)")
  exit 1
}

# -- 5. smoke -----------------------------------------------------------------
Step-Begin "smoke" "" 97
try {
  & $VenvPy -c "import torch;from diffusers import ModularPipeline;print('music3 smoke ok')"
  if ($LASTEXITCODE -ne 0) { throw "the venv smoke import failed" }
  New-Item -ItemType File -Force -Path (Join-Path $InstallDir ".install-ok") | Out-Null
  Step-Ok "smoke" 100
} catch {
  Step-Fail "smoke" (New-FailCode "music3.smoke.import_failed" @{ err = "$($_.Exception.Message)" } "the smoke import failed: $($_.Exception.Message)")
  exit 1
}

Write-Host "[music3-install] done"
exit 0
