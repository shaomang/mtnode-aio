# Breeze TTS 2 local TTS -- installer script (native Windows)
#
# Does four things:
#   1. Create .venv and install dependencies from China mirrors (torch comes from the aliyun pytorch-wheels mirror)
#   2. Clone the breeze-tts inference engine into engine/ (GitHub archive / clone falls back through
#      the ghfast.top -> gh-proxy.com -> ghproxy.net -> ghproxy.com proxies before the direct github.com URL)
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
Write-Host "[breeze-install] mirrors: pip=$env:PIP_INDEX_URL (fallback aliyun / USTC -> official) | weights=ModelScope -> $env:HF_ENDPOINT | npm=$env:npm_config_registry"

function Say([string]$msg) { Write-Host "[breeze-install] $msg" }
function Progress([double]$pct) { Write-Host ("[breeze-install] progress: {0:N1}" -f $pct) }
function Step([string]$msg, [double]$pct) { $script:Step++; Say "- ($($script:Step)) $msg"; Progress $pct }

# Step protocol (the install window lists its steps / locates the failing step from it): the single
# source is scripts/step.ps1 in this pack.
# This layer does not reorder the script: it only translates the existing Progress numbers into
# structured step lines (the map is Step-ProgressMap below).
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
  function Step-ProgressMap { param([object[]]$Map) }
  function Step-Progress { param([object]$Pct,[string]$Fail,[string]$Skip) }
}

# Native commands (git / pip / python) write their normal information to stderr, and combined with
# $ErrorActionPreference="Stop" that turns "normal output" into an error that aborts the script
# (measured: git clone succeeds, progress looks fine, yet the script dies on that very line).
# So every external program call goes through this wrapper: stderr is let through for the duration
# of the call, and a real command failure is still decided by $LASTEXITCODE.
function Invoke-Native([string]$exe, [string[]]$cmdArgs) {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  # The unreachable extra-index that pip.ini may carry is neutralised once and for all by the
  # PIP_* environment variables set at the top of this script (they take precedence over pip.ini
  # and are inherited by every child pip), so there is nothing to strip per call here.
  try {
    & $exe @cmdArgs 2>&1 | ForEach-Object { Say ("  " + $_) }
    return $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $prev
  }
}

$PIP_MIRROR  = $env:PIP_INDEX_URL
$PIP_TRUSTED = $env:PIP_TRUSTED_HOST
# pip fallback chain, domestic first, official only as the last resort
$PIP_CHAIN   = @($PIP_MIRROR, "https://mirrors.aliyun.com/pypi/simple/", "https://mirrors.ustc.edu.cn/pypi/simple/", "https://pypi.org/simple") | Select-Object -Unique
# torch source order is ranked by MEASURED SPEED on this machine: SJTU mirrors download.pytorch.org
# completely (a 1.8GB torch wheel came down in 23s, about 76 MB/s); the aliyun pytorch-wheels
# directory manages about 1.5 MB/s and the official site is effectively unreachable from mainland
# China. So: SJTU first, aliyun second, official last. The SJTU path downloads the wheel with curl
# (-C - resumes) and then installs locally with --no-index; the wheel lands in the shared library
$TORCH_SJTU  = "https://mirror.sjtu.edu.cn/pytorch-wheels/"
$TORCH_INDEX = if ($env:BREEZE_TORCH_INDEX) { $env:BREEZE_TORCH_INDEX } else { "https://mirrors.aliyun.com/pytorch-wheels/cu128" }
# torch wheels are tried in order: domestic mirrors first (fast in China, occasionally one version
# behind) -> the pytorch.org official index last (most complete versions, slow / blocked in China)
$TORCH_INDICES = @(
  $TORCH_INDEX,
  "https://mirrors.aliyun.com/pytorch-wheels/cu128",
  "https://mirrors.aliyun.com/pytorch-wheels/cu126",
  "https://download.pytorch.org/whl/cu128",
  "https://download.pytorch.org/whl/cu126"
) | Select-Object -Unique
$WEIGHTS_REPO = if ($env:BREEZE_WEIGHTS_REPO) { $env:BREEZE_WEIGHTS_REPO } else { "BreezeBlue/breeze-tts-2" }

# Progress threshold -> step id (identical to steps.json in the same directory): the original
# progress numbers keep their old meaning, this layer only translates "how far the progress got"
# into "which step".
Step-ProgressMap @(
  @{ at = 4;   id = "python";  title = "" },
  @{ at = 10;  id = "venv";    title = "" },
  @{ at = 20;  id = "engine";  title = "" },
  @{ at = 30;  id = "deps";    title = "" },
  @{ at = 54;  id = "torch";   title = "" },
  @{ at = 78;  id = "weights"; title = "" },
  @{ at = 96;  id = "ffmpeg";  title = "" },
  @{ at = 98;  id = "smoke";   title = "" }
)
Say "step protocol ready (the install window lists steps from steps.json)"

# The original Progress call sites (stage progress printed by the script itself) automatically carry
# step lines once the map is ready: define the override once, the rest of the script needs no changes.
function Progress([double]$pct) {
  Write-Host ("[breeze-install] progress: {0:N1}" -f $pct)
  Step-Progress $pct
}
$ENGINE_DIR  = Join-Path $InstallDir "engine"
$CKPT_DIR    = Join-Path $InstallDir "checkpoints\breeze-tts-2"
$VENV        = Join-Path $InstallDir ".venv"
$VENV_PY     = Join-Path $VENV "Scripts\python.exe"
$TOOLS_DIR   = Join-Path $InstallDir "tools"

Say "InstallDir = $InstallDir"
Say "weights repo = $WEIGHTS_REPO"
Say "torch index  = $TORCH_INDEX"

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
  Invoke-Native $VENV_PY @("-m", "pip", "install", "--upgrade", "pip", "--index-url", $PIP_MIRROR, "--trusted-host", $PIP_TRUSTED, "--quiet", "--disable-pip-version-check") | Out-Null
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
    foreach ($url in @(
      "https://ghfast.top/https://github.com/breezeblue-ai/breeze-tts",
      "https://gh-proxy.com/https://github.com/breezeblue-ai/breeze-tts",
      "https://ghproxy.net/https://github.com/breezeblue-ai/breeze-tts",
      "https://ghproxy.com/https://github.com/breezeblue-ai/breeze-tts",
      "https://github.com/breezeblue-ai/breeze-tts")) {
      Say "git clone $url"
      Invoke-Native "git" @("clone", "--depth", "1", $url, $ENGINE_DIR) | Out-Null
      if (Test-Path -LiteralPath (Join-Path $ENGINE_DIR "infer.py")) { $cloned = $true; break }
      if (Test-Path -LiteralPath $ENGINE_DIR) { Remove-Item -Recurse -Force -LiteralPath $ENGINE_DIR -ErrorAction SilentlyContinue }
      New-Item -ItemType Directory -Force -Path $ENGINE_DIR | Out-Null
    }
  } else { Say "git not found, falling back to a zip download" }
  if (-not $cloned) {
    foreach ($zip in @("https://ghfast.top/https://github.com/breezeblue-ai/breeze-tts/archive/refs/heads/main.zip",
                       "https://gh-proxy.com/https://github.com/breezeblue-ai/breeze-tts/archive/refs/heads/main.zip",
                       "https://ghproxy.net/https://github.com/breezeblue-ai/breeze-tts/archive/refs/heads/main.zip",
                       "https://ghproxy.com/https://github.com/breezeblue-ai/breeze-tts/archive/refs/heads/main.zip",
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
  Say "installing torch / torchaudio (CUDA build; indices tried in order: SJTU wheels -> $($TORCH_INDICES -join ' -> '))"
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  $torchRc = 1
  try {
    # (1) SJTU fast path: curl the wheel down first (resumable, lands in the shared library), then
    #     install locally with --no-index. Measured: 23s instead of 15+ minutes; reinstalls reuse it.
    $wheelCache = Join-Path (Split-Path -Parent $InstallDir) "_weights\wheels"
    New-Item -ItemType Directory -Force -Path $wheelCache | Out-Null
    $torchMinor = "2.9.1"
    foreach ($cu in @("cu128", "cu126")) {
      $w1 = Join-Path $wheelCache ("torch-" + $torchMinor + "+" + $cu + "-cp310-cp310-win_amd64.whl")
      $w2 = Join-Path $wheelCache ("torchaudio-" + $torchMinor + "+" + $cu + "-cp310-cp310-win_amd64.whl")
      $base = $TORCH_SJTU + $cu + "/"
      if (-not (Test-Path $w1)) {
        Say "downloading the torch wheel from SJTU ($cu)..."
        & curl.exe -L --retry 5 --retry-delay 3 -C - -o "$w1" ($base + "torch-" + $torchMinor + "%2B" + $cu + "-cp310-cp310-win_amd64.whl") 2>$null | Out-Null
      }
      if ((-not (Test-Path $w2)) -and (Test-Path $w1)) {
        Say "downloading the torchaudio wheel from SJTU ($cu)..."
        & curl.exe -L --retry 5 --retry-delay 3 -C - -o "$w2" ($base + "torchaudio-" + $torchMinor + "%2B" + $cu + "-cp310-cp310-win_amd64.whl") 2>$null | Out-Null
      }
      if ((Test-Path $w1) -and (Test-Path $w2)) {
        $torchRc = Invoke-Native $VENV_PY @("-m", "pip", "install", "--no-index", "--force-reinstall", "--no-deps", $w1, $w2)
        if ($torchRc -eq 0) { Say "torch installed from the SJTU wheels ($cu)"; break }
      }
    }
    # (2) if that fails, walk the original index chain (aliyun -> official)
    if ($torchRc -ne 0) {
      foreach ($idx in $TORCH_INDICES) {
        Say "torch index: $idx"
        # torch and torchaudio MUST be pinned to the SAME version (one line): pinned separately the
        # mirror resolves torchaudio to a higher minor (measured torchaudio 2.11 + torch 2.9.1) and the
        # engine then dies on import with OSError: Could not load this library:
        # ...torchaudio\lib\_torchaudio.pyd -- install all green, first synthesis broken.
        #
        # WARNING: never put "+" concatenation expressions inside an array literal (hit twice this
        # round): @("a==x+" + $v, "b==x+" + $v) is evaluated into ONE string "a==x+v b==x+v" (the
        # comma separator is swallowed) and pip answers "Invalid requirement". Compute each element
        # into its own scalar variable and pass them one by one.
        $pinTorch = if ($cu) { "torch==2.9.1+" + $cu } else { "torch==2.9.1" }
        $pinAudio = if ($cu) { "torchaudio==2.9.1+" + $cu } else { "torchaudio==2.9.1" }
        $torchRc = Invoke-Native $VENV_PY @("-m", "pip", "install", $pinTorch, $pinAudio, "--index-url", $idx)
        if ($torchRc -eq 0) { Say "torch installed ($idx): $pinTorch + $pinAudio"; break }
        Say "that index did not work (exit $torchRc), trying the next one"
      }
    }
  } finally { $ErrorActionPreference = $prevEap }
  if ($torchRc -ne 0) {
    throw "torch installation failed (SJTU wheels + indices: $($TORCH_INDICES -join ' / ')) -- see the pip output above; you can also point BREEZE_TORCH_INDEX at your own mirror and rerun"
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
  Invoke-Native $VENV_PY @("-m", "pip", "install", "--index-url", $PIP_MIRROR, "--trusted-host", $PIP_TRUSTED, "--no-deps", "gradio==6.29.1", "gradio-client==2.7.2") | Out-Null
  $depsRc = 1
  foreach ($idx in $PIP_CHAIN) {
    $depsRc = Invoke-Native $VENV_PY @("-m", "pip", "install", "-r", $filtered, "--index-url", $idx, "--trusted-host", $PIP_TRUSTED, "--extra-index-url", $TORCH_INDEX_ARG)
    if ($depsRc -eq 0) { break }
    Say "mirror $idx failed (exit $depsRc), trying the next one"
  }
} finally { $ErrorActionPreference = $prevEapG }
if ($depsRc -ne 0) { throw "Python dependency installation failed (see the pip output above)" }
Progress 78

# -- 3b. Re-assert the CUDA torch ------------------------------------------
# A real failure measured this round: the CUDA torch installed by the torch step is then REPLACED
# by the CPU build by the very next "pip install -r requirements.breeze.txt" (the qwen-tts chain
# pins torch==2.9.1, and the PyPI mirror version compares HIGHER than the +cu128 local version, so
# pip silently swaps it; the log shows "Uninstalling torch-2.9.1+cu128"). The install then finishes
# "green" with a CPU torch and only the smoke step reports "torch cannot see CUDA" -- exactly what
# the user experiences as "breeze installs but never works". The fix: after the dependency step we
# re-check and force-reinstall the CUDA build (with the +cuXXX local tag pip only accepts that
# wheel). This step runs last: no pip install after it can swap torch again.
$torchOk2 = $false
$torchVer = (& $VENV_PY -c "import torch;print(torch.__version__)" 2>$null | Out-String).Trim()
if ($torchVer -match '\+cu\d+') {
  $torchOk2 = $true
  Say "torch is already the CUDA build ($torchVer)"
} else {
  Say "torch is '$torchVer' (not a CUDA build) -- the requirements step replaced it; reinstalling the CUDA build"
  $prevEapT = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    foreach ($idx in $TORCH_INDICES) {
      $cu2 = if ($idx -match '/(cu\d+)$') { $Matches[1] } else { "" }
      $pin2 = if ($cu2) { "torch==2.9.1+" + $cu2 } else { "torch==2.9.1" }
      # torchaudio is pinned to the SAME cu version as torch: replacing only torch leaves a
      # "torch 2.9.1+cu128 + torchaudio 2.11" pair and the engine fails to load _torchaudio.pyd.
      $taPin2 = if ($cu2) { "torchaudio==2.9.1+" + $cu2 } else { "torchaudio==2.9.1" }
      Say "torch reinstall: $pin2 + $taPin2 from $idx"
      $rc = Invoke-Native $VENV_PY @("-m", "pip", "install", "--force-reinstall", "--no-deps", $pin2, $taPin2, "--index-url", $idx)
      if ($rc -eq 0) {
        $torchVer = (& $VENV_PY -c "import torch;print(torch.__version__)" 2>$null | Out-String).Trim()
        if ($torchVer -match '\+cu\d+') { $torchOk2 = $true; Say "torch is now $torchVer"; break }
        Say "installed from $idx but the version is still '$torchVer' -- trying the next index"
      } else {
        Say "that index did not work (exit $rc), trying the next one"
      }
    }
  } finally { $ErrorActionPreference = $prevEapT }
}
if (-not $torchOk2) {
  throw "could not keep a CUDA build of torch (final version: '$torchVer'). Breeze TTS 2 must run on the GPU -- a CPU torch cannot generate usable speech. Fix: check that $TORCH_INDEX is reachable, or set BREEZE_TORCH_INDEX to another cu-tagged mirror and rerun; the weights already downloaded are not re-fetched."
}
Progress 79

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
  Invoke-Native $VENV_PY @("-m", "pip", "install", "--quiet", "--index-url", $PIP_MIRROR, "--trusted-host", $PIP_TRUSTED, "huggingface_hub") | Out-Null
  $dl = Join-Path $InstallDir "scripts\download_weights.py"
  $src = Join-Path $PSScriptRoot "download_weights.py"
  # The host copies this pack into the install dir before running the script (syncPackToInstall),
  # so $PSScriptRoot is usually $InstallDir\scripts itself -- source and destination are then the very
  # same file. PowerShell 7 refuses that ("Cannot overwrite the item ... with itself") and, with
  # $ErrorActionPreference = "Stop", the script died right here at the weights step. Compare the
  # normalised paths first: skip the copy when they are the same file, copy in every other case.
  if (Test-Path -LiteralPath $src) {
    $srcFull = (Resolve-Path -LiteralPath $src).Path
    $dlFull = $dl
    if (Test-Path -LiteralPath $dl) {
      try { $dlFull = (Resolve-Path -LiteralPath $dl).Path } catch { $dlFull = $dl }
    }
    if (-not [string]::Equals($srcFull, $dlFull, [System.StringComparison]::OrdinalIgnoreCase)) {
      Copy-Item -LiteralPath $srcFull -Destination $dl -Force
    }
  }
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
                       "https://ghfast.top/https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip",
                       "https://gh-proxy.com/https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip",
                       "https://ghproxy.net/https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip",
                       "https://ghproxy.com/https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip",
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
  Step-Progress -Fail "smoke import failed (exit $smokeRc): dependencies are half installed or do not match this machine's torch. Read this step's log and rerun the installer to fill them in; if it keeps failing, hand the log to the repair session."
  Write-Verdict "false" "smoke_failed"
  Say "handed back to the host for skill-based Agent repair (no need to read logs)."
  exit 1
}
if ($cudaRc -ne 0 -and $env:BREEZE_SKIP_CUDA_CHECK -ne "1") {
  Say "torch cannot see CUDA -- Breeze TTS 2 needs an NVIDIA GPU and a working CUDA build of torch (about 7.7GB of VRAM), the install did not finish."
  Say "guidance: make sure this machine has an NVIDIA GPU with a working driver; if you really need static troubleshooting on a machine without a GPU, set BREEZE_SKIP_CUDA_CHECK=1 and rerun."
  Step-Progress -Fail "torch installed but cannot see CUDA: this machine has no usable NVIDIA GPU / driver, or a CPU-only torch is installed. This pack installs CUDA builds, so a machine without an NVIDIA card cannot get there -- switch to a machine with one, or set BREEZE_SKIP_CUDA_CHECK=1 for static troubleshooting only."
  Write-Verdict "false" "no_cuda"
  exit 1
}
if ($cudaRc -ne 0) { Say "BREEZE_SKIP_CUDA_CHECK=1: skipping the CUDA gate, writing the markers as usual (only for static troubleshooting on machines without a GPU)." }

Set-Content -LiteralPath $installOk -Value (Get-Date -Format o) -Encoding UTF8
Write-Verdict "true" ""
Progress 100
Say "install complete. Use Start on the plugin 'Breeze TTS 2 local TTS' to launch the backend (the first start loads about 7.7GB of weights and takes a while)."
exit 0
