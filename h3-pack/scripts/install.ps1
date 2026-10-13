# =============================================================================
# MiniMax H3 local video backend -- step-by-step install orchestration
#
# Why this script exists: installProject used to only "check the disk -> hand the work to
# the Agent", so the UI showed a single "Agent is installing..." line and nobody could see
# which step was running or which one blew up. This script chains the two existing pack
# scripts into steps (both are still there, not one line of their logic moved) and prints a
# step line per step, so the install window lists "ComfyUI venv / torch / weights ..." and
# stops on the failing step.
#
# Reused as-is (semantics unchanged):
#   scripts/setup_env.ps1        isolated ComfyUI venv + CUDA torch + custom nodes
#                                (-SourceOnly only makes sure the ComfyUI sources are there)
#   scripts/download_models.ps1  MiniMax H3 weights from ModelScope (falls back to hf-mirror)
#
# Step ids match steps.json in the same directory: disk / comfy / venv / nodes / weights / smoke
# Step protocol lives in scripts/step.ps1. The script is re-runnable (the sub-scripts are
# idempotent / resumable themselves).
#
# Why comfy and venv use separate criteria (the trap fixed here): the previous version
# skipped both "sources" and "environment" as soon as ComfyUI\main.py existed (so setup_env.ps1
# never ran), and the venv step then failed on "venv\Scripts\python.exe is missing". Every
# site with sources pulled but no venv yet (a normal resume, or a half-finished install) was
# stuck on venv reporting "the isolated venv was not created".
# Now: the comfy step only manages the sources (pulled when missing); the venv step ALWAYS
# runs setup_env.ps1 (idempotent) and then re-checks by measurement.
#
# Failure reporting: reasons are split by evidence (environment prep did not finish / venv
# exists but cuda is unavailable / importing comfy_kitchen failed) instead of always blaming
# "driver and CUDA tier mismatch"; the failing step message carries the key error lines from
# the sub-script tail, so the user does not have to dig through the whole log; the steps that
# never ran are explicitly marked skip (the install window shows "skipped").
#
# HARD RULE -- THIS FILE MUST STAY PURE ASCII (every byte <= 0x7F) AND MUST KEEP NO BOM:
#   the host runs install scripts with powershell.exe (Windows PowerShell 5.1), which decodes
#   a BOM-less .ps1 using the machine's ANSI code page (cp936 on Chinese Windows). Non-ASCII
#   bytes get decoded as mojibake and a trailing byte can swallow the following `}` / `'` /
#   `"`, so the parser dies with "Unexpected token '}'" and the install cannot even start.
#   Step titles and hints are localized in steps.json, never here.
#
# Usage:
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

# Absolute path to this PowerShell host: a few installation paths shrink PATH (the clean-machine
# smoke test does), and a bare "powershell.exe" then fails with CommandNotFoundException.
$PS_EXE = ""
try { $PS_EXE = [string][System.Diagnostics.Process]::GetCurrentProcess().MainModule.FileName } catch { $PS_EXE = "" }
if (-not $PS_EXE -or -not (Test-Path -LiteralPath $PS_EXE)) {
    $PS_EXE = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
}
if (-not (Test-Path -LiteralPath $PS_EXE)) { $PS_EXE = "powershell.exe" }


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
  function Step-Skip { param([string]$Id,[string]$Message) Write-MTStepJson $Id "" "skip" "" $Message }
}

$ComfyRoot = Join-Path $InstallDir "ComfyUI"
$VenvDir = Join-Path $ComfyRoot "venv"
$VenvPy = Join-Path $VenvDir "Scripts\python.exe"
$ComfyMain = Join-Path $ComfyRoot "main.py"

# Step manifest (same ids as steps.json in this directory; the order is the execution order).
# The failure path uses it to mark every step that never ran as skip -- the user sees at a
# glance which steps did not run at all.
#
# Failure contract: this script prints an English `message` and a stable `code` (+ params) on a
# failing step. The localized reason and advice live in this pack's steps.json `messages` table
# and the install window resolves the code -- that is why this file has to stay pure ASCII.
#
# The pip failure path is the one users hit most: when all four indexes are exhausted the pip
# output in the step log tail says "No matching distribution found for <package>" -- that line
# is what names the missing package, and the step message carries it as the `tail` param.
$StepOrder = @("disk", "comfy", "venv", "nodes", "weights", "smoke")

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Write-Host "[h3-install] install dir: $InstallDir"

# Ring buffer for the sub-script output (only the last 200 lines): on failure the key error
# lines are pulled out of it and written into the message of the failing step.
$script:SubTail = New-Object System.Collections.ArrayList
$script:SubBad = $false
function Add-SubTail {
  param([string]$Line)
  [void]$script:SubTail.Add([string]$Line)
  while ($script:SubTail.Count -gt 200) { $script:SubTail.RemoveAt(0) }
}

# Pull the "key error lines": the last few lines matching error wording, joined on one line
# (the install window shows that as the second line of the step); when nothing matches, fall
# back to the last 2 ordinary lines. Empty when there is nothing at all.
function Get-ErrorTail {
  param([int]$MaxLines = 3, [int]$MaxChars = 600)
  $pat = '(?i)(error|failed|failure|traceback|exception|no matching distribution|could not|cannot|unable|not found|timed out|denied|fatal|abort)'
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

# Failure wrap-up: mark every step after this one that never ran as "skipped" (instead of
# leaving them in "pending").
function Skip-AfterStep {
  param([string]$StepId)
  $i = [array]::IndexOf($StepOrder, $StepId)
  if ($i -lt 0) { return }
  for ($k = $i + 1; $k -lt $StepOrder.Count; $k++) { Step-Skip $StepOrder[$k] "the previous step failed, this step did not run" }
}

# Run a sub-script: forward its output line by line to the install window in real time (long
# steps are no longer silent), keep the tail in the ring buffer for failure diagnostics, and
# judge the outcome by two signals: the exit code and an explicit failure marker in the output.
function Invoke-SubScript {
  param([string]$Path, [string]$What, [string[]]$ExtraArgs = @())
  if (-not (Test-Path $Path)) { throw "script missing: $Path (incomplete pack: reinstall or update the plugin resources)" }
  $script:SubTail.Clear()
  $script:SubBad = $false
  $psArgs = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $Path) + @($ExtraArgs)
  # pip / git / python write to stderr all the time: under the Stop preference PowerShell turns
  # those into terminating errors and the real error text is lost -- lower it to Continue for
  # this section so stderr goes into the pipeline untouched.
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    & $PS_EXE @psArgs 2>&1 | ForEach-Object {
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
  if ($code -ne 0) { throw "$What exit code $code" }
  if ($script:SubBad) { throw "$What reported failure (ok=false / FAILED / Traceback in the output)" }
}

# Probe: run a small snippet with the venv python and get back its last line plus all output
# (same reason: errors go to stderr and must not become terminating errors). The verdict
# always reads the last line, the error text is always attached to the failing step.
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

# -- 1. disk ------------------------------------------------------------------
Step-Begin "disk" "" 3 "reserve at least ${DiskHintGb}GB"
try {
  $drive = (Get-Item $InstallDir).PSDrive
  $freeGb = [math]::Round((Get-PSDrive $drive.Name).Free / 1GB, 1)
  Write-Host "[h3-install] disk free ~${freeGb}GB (hint >= ${DiskHintGb}GB)"
  if ($freeGb -lt $DiskHintGb) {
    Step-Fail "disk" (New-FailCode "h3.disk.low_space" @{ free = "$freeGb"; want = "$DiskHintGb" } "disk free ${freeGb}GB is below the suggested ${DiskHintGb}GB")
    Skip-AfterStep "disk"
    exit 1
  }
  Step-Ok "disk" 6
} catch {
  Step-Fail "disk" (New-FailCode "h3.disk.unreadable" @{ err = "$($_.Exception.Message)" } "cannot read the free space of the install drive: $($_.Exception.Message)")
  Skip-AfterStep "disk"
  exit 1
}

# -- 2. ComfyUI sources -------------------------------------------------------
Step-Begin "comfy" "" 8
try {
  if (Test-Path $ComfyMain) {
    Step-Ok "comfy" 14 "ComfyUI already at $ComfyRoot"
  } else {
    # Sources missing: only pull the sources (setup_env -SourceOnly) and leave venv / torch /
    # dependencies to the next step, so the environment prep does not run twice.
    Invoke-SubScript (Join-Path $PSScriptRoot "setup_env.ps1") "ComfyUI source setup" @("-SourceOnly")
    if (-not (Test-Path $ComfyMain)) { throw "setup_env -SourceOnly finished but ComfyUI\main.py is still missing" }
    Step-Ok "comfy" 14
  }
} catch {
  Step-Fail "comfy" (New-FailCode "h3.comfy.prep_failed" @{ err = "$($_.Exception.Message)"; tail = (Get-ErrorTail) } "ComfyUI source setup failed: $($_.Exception.Message)")
  Skip-AfterStep "comfy"
  exit 1
}

# -- 3. venv + torch (setup_env.ps1 does both; it ALWAYS runs, idempotent) -----
Step-Begin "venv" "" 16
try {
  # Cheap hardware preflight FIRST (nvidia-smi only): without an NVIDIA card, or with a
  # driver below 580, H3 cannot run at all. Failing here keeps the failure precise ("no
  # card" / "driver too old") instead of surfacing 40 minutes later as a generic venv
  # error -- and it stops us from downloading ~50MB of Python plus ~3GB of torch first.
  # The gate that decides remains the measured torch cu130 check below.
  # Guarded: an install directory whose scaffold predates this helper (or a partial copy)
  # simply skips the preflight -- an upgrade must never block because a new optional file
  # is absent.
  $preHelper = Join-Path $PSScriptRoot "base_python.ps1"
  if (Test-Path -LiteralPath $preHelper) {
    $preFailed = $false
    try {
      Invoke-SubScript $preHelper "hardware preflight" @("-SkipGpuProbe", "-Module", "h3", "-GpuRequired", "require", "-MinDriverMajor", "580")
    } catch {
      # A non-zero exit is the EXPECTED shape of a failed preflight: the stable code is already
      # in the captured output, so swallow the generic throw and report that code instead
      # (otherwise the window only ever says "hardware preflight exit code 1").
      $preFailed = $true
    }
    $preHits = @(@($script:SubTail) | Where-Object { "$_" -match '(?i)(h3\.gpu\.none|h3\.gpu\.driver_old|STATUS=fail)' })
    if ($preHits.Count -gt 0 -or $preFailed) {
      $preCode = "h3.gpu.none"
      if (($preHits -join " ") -match 'h3\.gpu\.driver_old') { $preCode = "h3.gpu.driver_old" }
      $preTail = (@(@($script:SubTail) | Where-Object { "$_" -match '(?i)^\s*(GPU-NONE|GPU|DRIVER|FAILCODE|REASON)=' } | Select-Object -Last 3) -join " / ")
      if (-not $preTail) { $preTail = (@($preHits | Select-Object -Last 2) -join " / ") }
      Step-Fail "venv" (New-FailCode $preCode @{ tail = $preTail } "this machine has no usable NVIDIA GPU / driver for H3")
      Skip-AfterStep "venv"
      exit 1
    }
  } else {
    Write-Host "[h3-install] note: scripts\base_python.ps1 is missing, skipping the GPU / driver preflight"
  }
  Write-Host "[h3-install] env prep: setup_env.ps1 (idempotent; venv / torch / deps are only topped up when needed)"
  Invoke-SubScript (Join-Path $PSScriptRoot "setup_env.ps1") "ComfyUI environment setup"
  # The shared helper (scripts/base_python.ps1) reports why no base interpreter could be
  # produced; route those codes straight into the install window instead of reporting a
  # generic "environment prep failed".
  $pyHits = @(@($script:SubTail) | Where-Object { "$_" -match '(?i)^\s*FAILCODE=(h3\.(python|gpu)\.\S+)' })
  if ($pyHits.Count -gt 0) {
    $pyCode = $Matches[1]
    $pyReason = (@(@($script:SubTail) | Where-Object { "$_" -match '^\s*REASON=' } | Select-Object -Last 1) -join " ")
    Step-Fail "venv" (New-FailCode $pyCode @{ tail = $pyReason } "base interpreter problem during environment prep")
    Skip-AfterStep "venv"
    exit 1
  }
  if (-not (Test-Path $VenvPy)) {
    Step-Fail "venv" (New-FailCode "h3.venv.pip_failed" @{ venv = "$VenvPy"; tail = (Get-ErrorTail) } "environment prep did not finish (venv still missing: $VenvPy)")
    Skip-AfterStep "venv"
    exit 1
  }
  $cuda = Invoke-VenvProbe "import torch;print('cuda' if torch.cuda.is_available() else 'nocuda')"
  if ($cuda.Last -ne "cuda") {
    Step-Fail "venv" (New-FailCode "h3.venv.cuda_unavailable" @{ tail = $cuda.Text } "torch is installed but torch.cuda.is_available() is false")
    Skip-AfterStep "venv"
    exit 1
  }
  $kit = Invoke-VenvProbe "import comfy_kitchen;print('kitchen_ok')"
  if ($kit.Last -ne "kitchen_ok") {
    Step-Fail "venv" (New-FailCode "h3.venv.kitchen_failed" @{ tail = $kit.Text } "torch is ready but importing comfy_kitchen fails")
    Skip-AfterStep "venv"
    exit 1
  }
  Step-Ok "venv" 46
} catch {
  Step-Fail "venv" (New-FailCode "h3.venv.prep_failed" @{ err = "$($_.Exception.Message)"; tail = (Get-ErrorTail) } "environment prep failed: $($_.Exception.Message)")
  Skip-AfterStep "venv"
  exit 1
}

# -- 4. custom nodes ----------------------------------------------------------
Step-Begin "nodes" "" 30
try {
  $nodes = Join-Path $ComfyRoot "custom_nodes"
  $nodeCount = if (Test-Path $nodes) { (Get-ChildItem $nodes -Directory -ErrorAction SilentlyContinue | Measure-Object).Count } else { 0 }
  if ($nodeCount -le 0) {
    throw "custom_nodes holds no custom node: the ComfyUI dependencies / nodes are not installed (see the pip and git errors in this step's log)"
  }
  Write-Host "[h3-install] custom_nodes: $nodeCount"
  Step-Ok "nodes" 55
} catch {
  Step-Fail "nodes" (New-FailCode "h3.nodes.incomplete" @{ err = "$($_.Exception.Message)"; tail = (Get-ErrorTail) } "ComfyUI dependencies / custom nodes are incomplete: $($_.Exception.Message)")
  Skip-AfterStep "nodes"
  exit 1
}

# -- 5. weights ---------------------------------------------------------------
Step-Begin "weights" "" 58
try {
  Invoke-SubScript (Join-Path $PSScriptRoot "download_models.ps1") "MiniMax H3 weights download"
  Step-Ok "weights" 90
} catch {
  Step-Fail "weights" (New-FailCode "h3.weights.download_failed" @{ err = "$($_.Exception.Message)"; tail = (Get-ErrorTail) } "weight download failed: $($_.Exception.Message)")
  Skip-AfterStep "weights"
  exit 1
}

# -- 6. wrap-up ---------------------------------------------------------------
Step-Begin "smoke" "" 92
try {
  $missing = @()
  foreach ($p in @(
    (Join-Path $ComfyRoot "main.py"),
    $VenvPy,
    (Join-Path $ComfyRoot "models\diffusion_models"),
    (Join-Path $ComfyRoot "models\text_encoders"),
    (Join-Path $ComfyRoot "models\vae")
  )) { if (-not (Test-Path $p)) { $missing += $p } }
  if ($missing.Count) { throw ("missing: " + ($missing -join " / ")) }
  New-Item -ItemType File -Force -Path (Join-Path $InstallDir ".install-ok") | Out-Null
  Step-Ok "smoke" 100
} catch {
  Step-Fail "smoke" (New-FailCode "h3.smoke.files_missing" @{ err = "$($_.Exception.Message)" } "final install check failed: $($_.Exception.Message)")
  Skip-AfterStep "smoke"
  exit 1
}

Write-Host "[h3-install] done"
exit 0
