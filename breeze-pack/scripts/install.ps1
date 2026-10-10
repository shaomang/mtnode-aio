# Breeze TTS 2 local TTS -- installer script (native Windows)
#
# Does four things:
#   1. Create .venv and install dependencies from China mirrors (torch comes from the aliyun pytorch-wheels mirror)
#   2. Clone the breeze-tts inference engine into engine/ (falls back to the ghproxy mirror when the official clone fails)
#   3. Download the Breeze TTS 2 weights into checkpoints/breeze-tts-2/ (ModelScope first -> hf-mirror fallback -> hand-filled local directory)
#   4. Download a portable ffmpeg into tools/ffmpeg/ (used for mp3 output; missing it does not affect wav/flac)
#
# Progress contract: [breeze-install] progress: NN  -- the host main process scrapes the progress bar with this regex.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -InstallDir "D:\mtnode\breeze"
# Overridable environment variables:
#   BREEZE_WEIGHTS_DIR   existing local weights directory (when non-empty the download is skipped and it is referenced by link/copy)
#   BREEZE_WEIGHTS_REPO  ModelScope / HF weights repo name (default BreezeBlue/breeze-tts-2)
#   BREEZE_SKIP_TORCH=1  skip the torch install (for debugging)
#   BREEZE_SKIP_FFMPEG=1 skip the ffmpeg download
param(
  [Parameter(Mandatory = $true)][string]$InstallDir
)
# Force UTF-8 for this process so the host (which decodes our stdout as UTF-8)
# and every native tool we spawn (pip / git / python) agree on one encoding.
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
$OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$env:PYTHONIOENCODING = 'utf-8'
$ErrorActionPreference = "Stop"
$InstallDir = (Resolve-Path -LiteralPath $InstallDir).Path
$script:Step = 0

function Say([string]$msg) { Write-Host "[breeze-install] $msg" }
function Progress([double]$pct) { Write-Host ("[breeze-install] progress: {0:N1}" -f $pct) }
function Step([string]$msg, [double]$pct) { $script:Step++; Say "- ($($script:Step)) $msg"; Progress $pct }

# Native commands (git / pip / python) write their normal information to stderr, and combined with
# $ErrorActionPreference="Stop" that turns "normal output" into an error that aborts the script
# (measured: git clone succeeds, progress looks fine, yet the script dies on that very line).
# So every external program call goes through this wrapper: stderr is let through for the duration
# of the call, and a real command failure is still decided by $LASTEXITCODE.
function Invoke-Native([string]$exe, [string[]]$cmdArgs) {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  # Also strip that unreachable extra-index which pip.ini may carry (done on every call, idempotent)
  Remove-Item Env:\PIP_EXTRA_INDEX_URL -ErrorAction SilentlyContinue
  try {
    & $exe @cmdArgs 2>&1 | ForEach-Object { Say ("  " + $_) }
    return $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $prev
  }
}

$PIP_MIRROR  = "https://pypi.tuna.tsinghua.edu.cn/simple"
$PIP_FALLBACK= "https://mirrors.ustc.edu.cn/pypi/simple/"
$TORCH_INDEX = if ($env:BREEZE_TORCH_INDEX) { $env:BREEZE_TORCH_INDEX } else { "https://download.pytorch.org/whl/cu128" }
# torch wheels are tried in order: official index (most complete versions) -> aliyun mirror (fast in China, but usually one version behind)
$TORCH_INDICES = @(
  $TORCH_INDEX,
  "https://mirrors.aliyun.com/pytorch-wheels/cu128",
  "https://download.pytorch.org/whl/cu126",
  "https://mirrors.aliyun.com/pytorch-wheels/cu126"
) | Select-Object -Unique
$WEIGHTS_REPO = if ($env:BREEZE_WEIGHTS_REPO) { $env:BREEZE_WEIGHTS_REPO } else { "BreezeBlue/breeze-tts-2" }
$ENGINE_DIR  = Join-Path $InstallDir "engine"
$CKPT_DIR    = Join-Path $InstallDir "checkpoints\breeze-tts-2"
$VENV        = Join-Path $InstallDir ".venv"
$VENV_PY     = Join-Path $VENV "Scripts\python.exe"
$TOOLS_DIR   = Join-Path $InstallDir "tools"

Say "InstallDir = $InstallDir"
Say "weights repo = $WEIGHTS_REPO"
Say "torch index  = $TORCH_INDEX"
Say "license      = code Apache-2.0; weights and self-hosted output are research / non-commercial only (BreezeBlue Research and Non-Commercial License)"

# -- 0. Prerequisite: Python ----------------------------------------------
Step "checking Python (3.10+ required)" 1
$pyExe = $null
foreach ($cand in @("python", "python3", "py")) {
  try {
    $v = & $cand -c "import sys;print('%d.%d'%sys.version_info[:2])" 2>$null
    if ($LASTEXITCODE -eq 0 -and $v) {
      $parts = $v.Trim().Split(".")
      if ([int]$parts[0] -eq 3 -and [int]$parts[1] -ge 10) { $pyExe = $cand; Say "python = $cand ($v)"; break }
      else { Say "skipping $cand (version $v < 3.10)" }
    }
  } catch { }
}
if (-not $pyExe) { throw "Python 3.10+ not found. Install Python 3.10 / 3.11 / 3.12 first, tick Add to PATH, then retry." }

# -- 1. venv --------------------------------------------------------------
Step "creating the virtual environment .venv" 5
if (-not (Test-Path -LiteralPath $VENV_PY)) {
  & $pyExe -m venv $VENV 2>&1 | ForEach-Object { Say ("  " + $_) }
  if (-not (Test-Path -LiteralPath $VENV_PY)) { throw "venv creation failed: $VENV_PY does not exist" }
} else { Say "reusing the existing .venv" }
$prevEapPip = $ErrorActionPreference
$ErrorActionPreference = "Continue"
try {
  Invoke-Native $VENV_PY @("-m", "pip", "install", "--upgrade", "pip", "--index-url", $PIP_MIRROR, "--quiet", "--disable-pip-version-check") | Out-Null
} finally { $ErrorActionPreference = $prevEapPip }
Progress 10

# -- 2. Engine source -----------------------------------------------------
Step "fetching the Breeze TTS inference engine (breeze-tts)" 14
$engineOk = Test-Path -LiteralPath (Join-Path $ENGINE_DIR "infer.py")
if ($engineOk) {
  Say "engine/ is already there, skipping the clone"
} else {
  New-Item -ItemType Directory -Force -Path $ENGINE_DIR | Out-Null
  $cloned = $false
  if (Get-Command git -ErrorAction SilentlyContinue) {
    foreach ($url in @("https://github.com/breezeblue-ai/breeze-tts", "https://ghproxy.com/https://github.com/breezeblue-ai/breeze-tts")) {
      Say "git clone $url"
      Invoke-Native "git" @("clone", "--depth", "1", $url, $ENGINE_DIR) | Out-Null
      if (Test-Path -LiteralPath (Join-Path $ENGINE_DIR "infer.py")) { $cloned = $true; break }
      if (Test-Path -LiteralPath $ENGINE_DIR) { Remove-Item -Recurse -Force -LiteralPath $ENGINE_DIR -ErrorAction SilentlyContinue }
      New-Item -ItemType Directory -Force -Path $ENGINE_DIR | Out-Null
    }
  } else { Say "git not found, falling back to a zip download" }
  if (-not $cloned) {
    foreach ($zip in @("https://ghproxy.com/https://github.com/breezeblue-ai/breeze-tts/archive/refs/heads/main.zip",
                       "https://github.com/breezeblue-ai/breeze-tts/archive/refs/heads/main.zip")) {
      $tmp = Join-Path $env:TEMP ("breeze-tts-" + [guid]::NewGuid().ToString("N") + ".zip")
      try {
        Say "downloading $zip"
        Invoke-WebRequest -Uri $zip -OutFile $tmp -UseBasicParsing -TimeoutSec 300
        $ex = Join-Path $env:TEMP ("breeze-tts-x-" + [guid]::NewGuid().ToString("N"))
        Expand-Archive -LiteralPath $tmp -DestinationPath $ex -Force
        $inner = Get-ChildItem -LiteralPath $ex -Directory | Select-Object -First 1
        if ($inner) { Copy-Item -Path (Join-Path $inner.FullName "*") -Destination $ENGINE_DIR -Recurse -Force }
        Remove-Item -Recurse -Force $ex, $tmp -ErrorAction SilentlyContinue
        if (Test-Path -LiteralPath (Join-Path $ENGINE_DIR "infer.py")) { $cloned = $true; break }
      } catch { Say "  failed: $($_.Exception.Message)" }
    }
  }
  if (-not $cloned) { throw "could not obtain the engine source: check the network, or copy the breeze-tts repository contents into $ENGINE_DIR by hand" }
}
Progress 20

# -- 3. Python dependencies ----------------------------------------------
Step "installing the Python dependencies (China mirrors)" 24
$reqFile = Join-Path $ENGINE_DIR "requirements.txt"
if (Test-Path -LiteralPath $reqFile) {
  # Drop test / static-check dependencies: pytest / ruff are not needed
  $filtered = Join-Path $InstallDir "requirements.breeze.txt"
  Get-Content -LiteralPath $reqFile |
    Where-Object { $_ -notmatch '^\s*(pytest|ruff)' } |
    Set-Content -LiteralPath $filtered -Encoding UTF8
  Say "requirements list = $filtered"
} else { throw "engine/requirements.txt is missing (the engine source is incomplete)" }

if ($env:BREEZE_SKIP_TORCH -ne "1") {
  Say "installing torch / torchaudio (CUDA build; indices tried in order: $($TORCH_INDICES -join ' -> '))"
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  $torchRc = 1
  try {
    foreach ($idx in $TORCH_INDICES) {
      Say "torch index: $idx"
      $torchRc = Invoke-Native $VENV_PY @("-m", "pip", "install", "torch==2.9.1", "torchaudio==2.9.1", "--index-url", $idx)
      if ($torchRc -eq 0) { Say "torch installed ($idx)"; break }
      Say "that index did not work (exit $torchRc), trying the next one"
    }
  } finally { $ErrorActionPreference = $prevEap }
  if ($torchRc -ne 0) {
    throw "torch installation failed (indices tried: $($TORCH_INDICES -join ' / ')) -- see the pip output above; you can also point BREEZE_TORCH_INDEX at your own mirror and rerun"
  }
} else { Say "BREEZE_SKIP_TORCH=1: skipping torch" }
Progress 54

Step "installing the remaining dependencies" 56
# gradio is an indirect dependency of qwen-tts with no pinned version: pip keeps backtracking
# between 6.17 and 6.29 and has to fetch a 31MB wheel on every round (measured: it can grind for
# over ten minutes). So install it first at a fixed version (--no-deps sidesteps the backtracking)
# and then let pip finish from the requirements -- same result, and the time drops from over ten
# minutes to one or two.
$TORCH_INDEX_ARG = ($TORCH_INDICES | Select-Object -First 1)
$prevEapG = $ErrorActionPreference
$ErrorActionPreference = "Continue"
try {
  Say "pre-installing gradio==6.29.1 (keeps pip from backtracking on it)"
  Invoke-Native $VENV_PY @("-m", "pip", "install", "--index-url", $PIP_MIRROR, "--no-deps", "gradio==6.29.1", "gradio-client==2.7.2") | Out-Null
  $depsRc = Invoke-Native $VENV_PY @("-m", "pip", "install", "-r", $filtered, "--index-url", $PIP_MIRROR, "--extra-index-url", $TORCH_INDEX_ARG)
  if ($depsRc -ne 0) {
    Say "tsinghua mirror failed (exit $depsRc), falling back to $PIP_FALLBACK"
    $depsRc = Invoke-Native $VENV_PY @("-m", "pip", "install", "-r", $filtered, "--index-url", $PIP_FALLBACK, "--extra-index-url", $TORCH_INDEX_ARG)
  }
} finally { $ErrorActionPreference = $prevEapG }
if ($depsRc -ne 0) { throw "Python dependency installation failed (see the pip output above)" }
Progress 78

# -- 4. Weights -----------------------------------------------------------
Step "preparing the Breeze TTS 2 weights" 80
New-Item -ItemType Directory -Force -Path $CKPT_DIR | Out-Null
$localWeights = if ($env:BREEZE_WEIGHTS_DIR) { $env:BREEZE_WEIGHTS_DIR } else { "" }
function Test-Ckpt([string]$dir) {
  if (-not $dir) { return $false }
  if (-not (Test-Path -LiteralPath $dir)) { return $false }
  $hasCfg = (Get-ChildItem -LiteralPath $dir -Filter "config.json" -File -ErrorAction SilentlyContinue | Measure-Object).Count -gt 0
  $hasWts = (Get-ChildItem -LiteralPath $dir -Recurse -Include "*.safetensors","*.pt","*.bin" -File -ErrorAction SilentlyContinue | Measure-Object).Count -gt 0
  return ($hasCfg -and $hasWts)
}
if (Test-Ckpt $CKPT_DIR) {
  Say "weights are already in $CKPT_DIR, skipping the download"
} elseif ($localWeights -and (Test-Ckpt $localWeights)) {
  Say "using the local weights pointed to by BREEZE_WEIGHTS_DIR: $localWeights"
  $marker = Join-Path $CKPT_DIR "USE_LOCAL_WEIGHTS.txt"
  Set-Content -LiteralPath $marker -Value $localWeights -Encoding UTF8
} else {
  if ($localWeights) { Say "the directory BREEZE_WEIGHTS_DIR points to is incomplete (missing config.json or weight files), downloading instead" }
  Invoke-Native $VENV_PY @("-m", "pip", "install", "--quiet", "--index-url", $PIP_MIRROR, "huggingface_hub") | Out-Null
  $dl = Join-Path $InstallDir "scripts\download_weights.py"
  $src = Join-Path $PSScriptRoot "download_weights.py"
  if (Test-Path -LiteralPath $src) { Copy-Item -LiteralPath $src -Destination $dl -Force }
  if (-not (Test-Path -LiteralPath $dl)) { throw "scripts/download_weights.py is missing (the installer script has been split apart)" }
  $dlArgs = @($dl, "--repo", $WEIGHTS_REPO, "--dest", $CKPT_DIR)
  if ($env:BREEZE_WEIGHTS_REVISION) { $dlArgs += @("--revision", $env:BREEZE_WEIGHTS_REVISION) }
  $prevEap3 = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    & $VENV_PY @dlArgs 2>&1 |
      ForEach-Object { $s = "$_"; if ($s -match 'progress:\s*(\d+(?:\.\d+)?)') { Progress (80 + [double]$matches[1] * 0.14) }; Say ("  " + $s) }
    $dlRc = $LASTEXITCODE
  } finally { $ErrorActionPreference = $prevEap3 }
  if ($dlRc -ne 0 -or -not (Test-Ckpt $CKPT_DIR)) {
    throw "weight download failed. You can download every file of $WEIGHTS_REPO into $CKPT_DIR by hand, or set BREEZE_WEIGHTS_DIR to an existing directory and rerun."
  }
}
Progress 95

# -- 5. Portable ffmpeg (for mp3) -----------------------------------------
if ($env:BREEZE_SKIP_FFMPEG -ne "1") {
  Step "preparing a portable ffmpeg (for mp3 output)" 96
  $ffDir = Join-Path $TOOLS_DIR "ffmpeg"
  $ffExe = Join-Path $ffDir "ffmpeg.exe"
  if (Test-Path -LiteralPath $ffExe) {
    Say "ffmpeg is already at $ffExe"
  } else {
    New-Item -ItemType Directory -Force -Path $ffDir | Out-Null
    $ok = $false
    foreach ($url in @("https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip",
                       "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip")) {
      $tmp = Join-Path $env:TEMP ("ffmpeg-" + [guid]::NewGuid().ToString("N") + ".zip")
      try {
        Say "downloading $url"
        Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing -TimeoutSec 600
        $ex = Join-Path $env:TEMP ("ffmpeg-x-" + [guid]::NewGuid().ToString("N"))
        Expand-Archive -LiteralPath $tmp -DestinationPath $ex -Force
        $found = Get-ChildItem -LiteralPath $ex -Recurse -Filter "ffmpeg.exe" -File | Select-Object -First 1
        if ($found) { Copy-Item -LiteralPath $found.FullName -Destination $ffExe -Force; $ok = $true }
        Remove-Item -Recurse -Force $ex, $tmp -ErrorAction SilentlyContinue
        if ($ok) { break }
      } catch { Say "  failed: $($_.Exception.Message)" }
    }
    if ($ok) { Say "ffmpeg ready: $ffExe" }
    else { Say "ffmpeg download failed: wav / flac are unaffected, mp3 output will report a missing ffmpeg (you can drop ffmpeg.exe into $ffDir by hand)" }
  }
} else { Say "BREEZE_SKIP_FFMPEG=1: skipping ffmpeg" }

# -- 6. Smoke test & markers (gate: a failed smoke test means not installed) ----
#   Why it has to be a gate: this used to only print one line on failure and still write .install-ok --
#   the host took that as "installed", the user hit the wall when clicking enable (dependencies not fully
#   installed / CPU-only torch), while the installer chain's Agent safety net (only triggered by a
#   non-zero script exit) never fired and the error bus never received an event either. The result was
#   "the install finished but is unusable, and nothing self-heals".
#   Same contract as the sibling backends: tts / llama throw, sensenova skips writing .install-ok
#   when the smoke test fails and writes ok=false.
Step "smoke check (import torch / soundfile / fastapi)" 98
$smoke = @"
import sys
import soundfile, fastapi, uvicorn
import torch
print('torch', torch.__version__, 'cuda', torch.cuda.is_available(), torch.version.cuda)
if not torch.cuda.is_available():
    print('WARN: torch cannot see CUDA -- Breeze TTS 2 needs an NVIDIA GPU (about 7.7GB of VRAM)')
"@
$smokeFile = Join-Path $InstallDir "scripts\_smoke_breeze.py"
Set-Content -LiteralPath $smokeFile -Value $smoke -Encoding UTF8
& $VENV_PY $smokeFile 2>&1 | ForEach-Object { Say ("  " + $_) }
$smokeRc = $LASTEXITCODE

# CUDA availability is judged separately: the engine needs an NVIDIA card plus a CUDA build of torch
# (about 7.7GB of VRAM). This one will not get any better no matter how many times an Agent reruns it
# (it cannot conjure a GPU), so it is not handed to the AI for repair -- we only write a verdict that
# points the user in the right direction.
$cudaRc = 0
if ($smokeRc -eq 0) {
  & $VENV_PY -c "import sys, torch; sys.exit(0 if torch.cuda.is_available() else 3)" 2>&1 | ForEach-Object { Say ("  " + $_) }
  $cudaRc = $LASTEXITCODE
}

$installOk = Join-Path $InstallDir ".install-ok"
$resultMarker = Join-Path $InstallDir ".breeze-agent-result"
# Drop stale markers first: a failed reinstall / repair must never pass itself off as a good install
# via the previous .install-ok (the host trusts it plus the prerequisites)
Remove-Item -Force $installOk -ErrorAction SilentlyContinue

function Write-Verdict([string]$okFlag, [string]$reason) {
  $lines = @("ok=$okFlag")
  if ($reason) { $lines += "reason=$reason" }
  $lines += "via=script"
  Set-Content -LiteralPath $resultMarker -Value $lines -Encoding UTF8
}

New-Item -ItemType Directory -Force -Path (Join-Path $InstallDir "voices"), (Join-Path $InstallDir "logs"), (Join-Path $InstallDir "out") | Out-Null

if ($smokeRc -ne 0) {
  Say "smoke import failed (exit $smokeRc): deps may be incomplete, install unfinished, no .install-ok."
  Write-Verdict "false" "smoke_failed"
  Say "handed back to the host for skill-based Agent repair (no need to read logs)."
  exit 1
}
if ($cudaRc -ne 0 -and $env:BREEZE_SKIP_CUDA_CHECK -ne "1") {
  Say "torch cannot see CUDA -- Breeze TTS 2 needs an NVIDIA GPU and a working CUDA build of torch (about 7.7GB of VRAM), the install did not finish."
  Say "guidance: make sure this machine has an NVIDIA GPU with a working driver; if you really need static troubleshooting on a machine without a GPU, set BREEZE_SKIP_CUDA_CHECK=1 and rerun."
  Write-Verdict "false" "no_cuda"
  exit 1
}
if ($cudaRc -ne 0) { Say "BREEZE_SKIP_CUDA_CHECK=1: skipping the CUDA gate, writing the markers as usual (only for static troubleshooting on machines without a GPU)." }

Set-Content -LiteralPath $installOk -Value (Get-Date -Format o) -Encoding UTF8
Write-Verdict "true" ""
Progress 100
Say "install complete. Use Start on the plugin 'Breeze TTS 2 local TTS' to launch the backend (the first start loads about 7.7GB of weights and takes a while)."
exit 0
