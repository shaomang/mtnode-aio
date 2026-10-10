# =============================================================================
# SenseNova (SenseNova-U1.5-8B-MoT) local image generation backend -- install / repair script
# (PowerShell * re-runnable * idempotent * domestic mirrors preferred throughout)
#
# What it does (every step prints `[sensenova-install] progress: NN`; the host renders the progress bar from it):
#   1.  Detect NVIDIA: nvidia-smi card name / driver major version / VRAM; no N card -> ok=false no_cuda;
#       VRAM <20GB -> ok=false vram_too_low (bf16 weights are 32.66GB, and the official vram_mode is meant for 24G cards
#       too: a small card installs fine but never produces an image; -Force skips this gate); RAM <32GB -> ram_too_low
#   2.  Detect disk: less than 50GB free on the drive holding the install dir only warns (weights 32.66GB + venv about 12GB + outputs)
#   3.  Pick Python: **uv-managed 3.11 first** (UV_PYTHON_INSTALL_MIRROR points at npmmirror, no VPN needed),
#       without uv fall back to the local `py -3.11/3.12/3.13/3.10` -> `python`
#       (upstream requires-python >=3.10,<3.14; the reference environment is 3.11)
#   4.  Create `.venv` (`python -m venv` first, ensurepip as the pip-less fallback, then `uv venv --seed`),
#       upgrade pip (Tsinghua -> Aliyun)
#   5.  Install **CUDA torch 2.8.0 + torchvision 0.23.0** (official requirements pin cu128):
#       (1) SJTU mirror (full mirror of download.pytorch.org, PEP503 index)
#       (2) Aliyun mirror (flat wheel dir -> --find-links + Tsinghua PyPI for torch's transitive deps)
#       (3) official download.pytorch.org as the last resort; the driver major version decides cu128 / cu126,
#       `-TorchIndex` overrides the whole source chain and `-TorchWheel` supports a fully offline install; afterwards it self-checks cuda.is_available()
#       (**never install torch from requirements.txt alone**: the Windows wheels on PyPI / Tsinghua are CPU builds)
#   6.  Install requirements.txt (transformers>=4.57.1 / accelerate / modelscope / pillow / numpy ...)
#       and verify the transformers version is new enough to know `model_type: neo_chat`
#   7.  Install the **sensenova_u1 inference package**: PyPI does **not** have it (verified 404), so install it from source
#       the way the official pip guidance says: download the GitHub tag tarball (domestic proxies ghfast.top / gh-proxy.com / ghproxy.net first,
#       direct connection last), unpack only `pyproject.toml + src/` (skip the huge training/evaluation dirs),
#       then `pip install <dir> --no-deps`
#       (**--no-deps is mandatory**: pyproject pins torch==2.8.0, so letting pip re-resolve would overwrite the cu128 build just
#       installed with the PyPI CPU build); then probe flash-attn once more: if it imports, write `.attn-backend`=flash, otherwise
#       sdpa (the Windows norm; the official project ships no flash-attn wheel)
#   8.  Download the weights **SenseNova/SenseNova-U1.5-8B-MoT** (ModelScope, direct domestic access, no VPN) -> on failure fall back
#       to HuggingFace (HF_ENDPOINT=https://hf-mirror.com); `models\.ok` is written only after checking "8 safetensors shards +
#       config.json + index.json + shards totalling >=30GB"; resume = simply rerun this script
#   9.  Verify the project file checklist
#   10. mock smoke test (MTNODE_SENSENOVA_MOCK=1, no model load): start the service -> /health (11 resolution buckets) ->
#       /generate writes a real PNG -> a concurrent second call must answer 429 busy -> /cancel -> /progress done -> /shutdown
#   11. Write `.install-ok` and `.sensenova-agent-result` (if the smoke test failed only the latter is written, as false)
#
# Note: this script does **not** leave the service running in the background (it is stopped when the smoke test ends); MTNode owns start/stop.
# Re-runnable: if it fails halfway, fix the reason and rerun -- the download resumes (weights already fetched are not re-downloaded).
# =============================================================================
param(
  [string]$InstallDir = "",                 # default: parent dir of the script's own folder
  [string]$Python = "",                     # explicit python.exe (offline / unusual environments)
  [string]$TorchIndex = "",                 # explicitly override torch's --index-url (skip automatic mirror selection)
  [string]$TorchWheel = "",                 # local torch-2.8.0*.whl (fully offline; a torchvision whl must sit next to it)
  [string]$Ref = "comfyui-v0.3.0",          # sensenova_u1 GitHub tag (this pack's interface is checked against that tag)
  [string]$SrcTarball = "",                 # already-downloaded SenseNova-U1 archive (.tar.gz or an unpacked dir)
  [string]$ModelDir = "",                   # existing weights dir (offline install: junctioned into models\, 32.66GB not copied)
  [string]$ModelScopeRepo = "SenseNova/SenseNova-U1.5-8B-MoT",
  [string]$HfRepo = "sensenova/SenseNova-U1.5-8B-MoT",
  [switch]$Cpu,                             # install CPU torch (debugging only; the official project needs a 24G-class N card)
  [switch]$Force,                           # skip the VRAM / RAM gates (install anyway even when knowingly short)
  [switch]$SkipModels,                      # skip the weight download (repair venv / deps / inference package only)
  [switch]$SkipDeps,                        # skip requirements.txt
  [switch]$SkipPkg,                         # skip the sensenova_u1 inference package install
  [switch]$SkipTorch,                       # skip the torch install
  [switch]$SkipSmoke                        # skip the mock smoke test
)

# Force UTF-8 for this process so the host (which decodes our stdout as UTF-8)
# and every native tool we spawn (pip / git / python) agree on one encoding.
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
$OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$env:PYTHONIOENCODING = 'utf-8'

$ErrorActionPreference = "Stop"
if (-not $InstallDir) {
  $InstallDir = Split-Path -Parent $MyInvocation.MyCommand.Path | Split-Path -Parent
}

# ---------------------------------------------------------------- output and result markers
function Write-Progress-Line([int]$Pct, [string]$Msg) {
  Write-Host "[sensenova-install] progress: $Pct"
  if ($Msg) { Write-Host "[sensenova-install] $Msg" }
}

function Write-AgentResult([string]$Ok, [string]$Reason) {
  $body = "ok=$Ok"
  if ($Reason) { $body = "$body`nreason=$Reason" }
  try {
    Set-Content -Path (Join-Path $InstallDir ".sensenova-agent-result") -Value $body -Encoding UTF8
  } catch {
    Write-Host "[sensenova-install] warning: could not write the result marker ($($_.Exception.Message))"
  }
}

function Fail-Install([string]$Reason, [string]$Advice) {
  Write-Host ""
  Write-Host "[sensenova-install] error: install did not finish reason=$Reason"
  if ($Advice) { Write-Host "[sensenova-install] action: $Advice" }
  Write-Host "[sensenova-install] progress: 100"
  Write-AgentResult "false" $Reason
  exit 1
}

# Run an external command: an external program's stderr is diagnostics only and must not trigger Stop
# Note: the parameter must not be named $Args (a PowerShell automatic variable) or splatting misbehaves
function Invoke-Cmd {
  param([string]$Exe, [string[]]$CmdArgs)
  $prev = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    # After 2>&1 an external program's stderr arrives as ErrorRecord objects; writing them straight to Write-Host makes the
    # layers above (the host harvesting the console as a log / an Agent reading the console tail) render them as one line
    # "System.Management.Automation.RemoteException", losing the real error text -- the lines you need while repairing.
    & $Exe @CmdArgs 2>&1 | ForEach-Object {
      $line = if ($_ -is [System.Management.Automation.ErrorRecord]) {
        if ($_.TargetObject) { [string]$_.TargetObject } else { [string]$_.Exception.Message }
      } else { [string]$_ }
      if ($line) { Write-Host $line }
    }
    return $LASTEXITCODE
  } catch {
    Write-Host "[sensenova-install] command raised: $($_.Exception.Message)"
    return 1
  } finally {
    $ErrorActionPreference = $prev
  }
}

Write-Host "[sensenova-install] ================================================================"
Write-Host "[sensenova-install] SenseNova local image generation backend install (SenseNova-U1.5-8B-MoT)"
Write-Host "[sensenova-install]   weights  : ModelScope $ModelScopeRepo (about 32.66GB / 8 shards)"
Write-Host "[sensenova-install]   pkg      : OpenSenseNova/SenseNova-U1 @$Ref (source + --no-deps)"
Write-Host "[sensenova-install]   PyPI     : Tsinghua pypi.tuna.tsinghua.edu.cn (fallback Aliyun)"
Write-Host "[sensenova-install]   torch    : SJTU -> Aliyun -> download.pytorch.org"
Write-Host "[sensenova-install]   requires : 24GB-class NVIDIA card * >=40GB RAM recommended * >=60GB disk"
Write-Host "[sensenova-install]   ref      : https://github.com/OpenSenseNova/SenseNova-U1"
Write-Host "[sensenova-install] ================================================================"

if (-not (Test-Path $InstallDir)) {
  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
}
$InstallDir = (Resolve-Path $InstallDir).Path
Set-Location $InstallDir
Write-Host "[sensenova-install] install dir: $InstallDir"
Write-Progress-Line 2 ""

# Domestic mirror constants (all in one place: swapping to an intranet mirror means editing only here)
$PipIndex = "https://pypi.tuna.tsinghua.edu.cn/simple"
$PipHost = "pypi.tuna.tsinghua.edu.cn"
$PipIndexFallback = "https://mirrors.aliyun.com/pypi/simple/"
$env:HF_ENDPOINT = "https://hf-mirror.com"
$env:HF_HUB_DISABLE_XET = "1"
$env:PYTHONIOENCODING = "utf-8"
$env:PYTHONUNBUFFERED = "1"
# Pin the domestic mirror at the pip layer too: a machine-global pip.ini often gets `extra-index-url = https://pypi.ngc.nvidia.com`
# pushed into it by NVIDIA PyIndex and friends (unreachable from China), so every package install first waits through 5 retries
# before falling back to Tsinghua. Use the PIP_* environment variables to override the same keys of the config file (**do not**
# use pip --isolated: that ignores the environment variables too and lets ngc right back in). Child processes (including build isolation environments) inherit them automatically.
$env:PIP_INDEX_URL = $PipIndex
$env:PIP_EXTRA_INDEX_URL = $PipIndex
$env:PIP_TRUSTED_HOST = $PipHost
# Keep the wheel cache: if the 3.5GB torch install ever fails, a rerun need not fetch it again
$env:PIP_NO_CACHE_DIR = "0"
# uv's python-build-standalone download mirror (npmmirror) so we never stall on a GitHub release
$env:UV_PYTHON_INSTALL_MIRROR = "https://registry.npmmirror.com/-/binary/python-build-standalone"

try {
  [Net.ServicePointManager]::SecurityProtocol =
    [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch {
  Write-Host "[sensenova-install] note: could not set TLS1.2 explicitly ($($_.Exception.Message)), continuing to try the download"
}

# ---------------------------------------------------------------- 1. detect GPU
function Get-NvidiaInfo {
  $smi = Get-Command nvidia-smi -ErrorAction SilentlyContinue
  if (-not $smi) { return $null }
  try {
    $line = (& nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader 2>$null | Select-Object -First 1)
    if (-not $line) { return $null }
    $parts = $line -split ','
    if ($parts.Count -lt 3) { return $null }
    $mem = 0
    try { $mem = [int](($parts[2] -replace '[^0-9]', '')) } catch { $mem = 0 }
    $major = 0
    try { $major = [int](($parts[1].Trim() -split '\.')[0]) } catch { $major = 0 }
    return @{ name = $parts[0].Trim(); driver = $parts[1].Trim(); major = $major; memMb = $mem }
  } catch {
    return $null
  }
}

Write-Progress-Line 4 "detecting NVIDIA GPU and driver..."
$gpu = Get-NvidiaInfo
$driverMajor = 0
if ($null -eq $gpu) {
  if (-not $Cpu) {
    Fail-Install "no_cuda" "SenseNova-U1.5-8B-MoT needs an NVIDIA card (the official reference environment is CUDA 12.8 + torch 2.8). If you really have no card and only want the install flow to go through, add -Cpu (real image generation will be unusably slow)."
  }
  Write-Host "[sensenova-install] warning: -Cpu given, installing CPU torch (debugging only; the official project does not support CPU inference)"
} else {
  Write-Host "[sensenova-install] GPU: $($gpu.name) * driver $($gpu.driver) (major $($gpu.major)) * VRAM $($gpu.memMb)MB"
  $driverMajor = $gpu.major
  # bf16 weights are about 32.66GB > any single card's VRAM: the official vram_mode ladder is the minimum setup for a 24G-class card
  if ($gpu.memMb -gt 0 -and $gpu.memMb -lt 20000 -and -not $Force) {
    Fail-Install "vram_too_low" "VRAM $($gpu.memMb)MB < 20000MB: even the cheapest official vram_mode=low needs a 24GB-class card (4090 / 3090 / A5000 class). Below that line switch to the cloud text-to-image node (proc_image) or change the card; to force the install anyway add -Force."
  }
  if ($gpu.memMb -lt 24000 -and $gpu.memMb -ge 20000) {
    Write-Host "[sensenova-install] note: VRAM $($gpu.memMb)MB is slightly below the official 24G tier; after installing set vramMode to low and lower numSteps to 30 if needed."
  }
}

Write-Progress-Line 6 "detecting RAM and disk..."
try {
  $os = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop
  $totalGb = [math]::Round($os.TotalVisibleMemorySize / 1MB, 1)
  Write-Host "[sensenova-install] RAM: about $totalGb GB (layered offload has to hold the non-resident weights in RAM; >=40GB recommended)"
  if ($totalGb -lt 32 -and -not $Force) {
    Fail-Install "ram_too_low" "RAM is about $totalGb GB < 32GB: vram_mode=fast/balanced/low all have to keep the 32.66GB of weights resident in RAM, so it installs but will not run. Add -Force to continue anyway."
  }
} catch {
  Write-Host "[sensenova-install] note: RAM detection failed ($($_.Exception.Message)), skipping that gate"
}
try {
  $driveName = (Get-Item $InstallDir).PSDrive.Name
  $freeGb = [math]::Round(((Get-PSDrive $driveName).Free / 1GB), 1)
  Write-Host "[sensenova-install] disk $driveName`: free $freeGb GB (>=60GB recommended: weights 32.66 + venv about 12 + outputs)"
  if ($freeGb -lt 50) {
    Write-Host "[sensenova-install] warning: less than 50GB free, the weight download may fill the disk midway; to change drive rerun with -InstallDir <path>"
  }
} catch {
  Write-Host "[sensenova-install] note: disk detection failed ($($_.Exception.Message)), continuing"
}

# ---------------------------------------------------------------- 2. Python + venv
Write-Progress-Line 10 "preparing Python (uv-managed 3.11 first, npmmirror mirror)..."
$venvPy = Join-Path $InstallDir ".venv\Scripts\python.exe"
$uvCmd = Get-Command uv -ErrorAction SilentlyContinue

function Find-LocalPython([string[]]$Wanted) {
  if ($Python) {
    if (Test-Path $Python) { return (Resolve-Path $Python).Path }
    Write-Host "[sensenova-install] warning: the -Python path does not exist: $Python, falling back to auto detection"
  }
  if (Get-Command py -ErrorAction SilentlyContinue) {
    foreach ($ver in $Wanted) {
      $code = Invoke-Cmd "py" @("-$ver", "-c", "import sys")
      if ($code -eq 0) {
        $prev = $ErrorActionPreference
        try {
          $ErrorActionPreference = "Continue"
          $exe = ((& py "-$ver" -c "import sys;print(sys.executable)") 2>$null | Out-String).Trim()
        } catch { $exe = "" } finally { $ErrorActionPreference = $prev }
        if ($exe -and (Test-Path $exe)) { return $exe }
      }
    }
  }
  if (Get-Command python -ErrorAction SilentlyContinue) {
    $code = Invoke-Cmd "python" @("-c", "import sys")
    if ($code -eq 0) {
      $prev = $ErrorActionPreference
      try {
        $ErrorActionPreference = "Continue"
        $exe = ((& python -c "import sys;print(sys.executable)") 2>$null | Out-String).Trim()
      } catch { $exe = "" } finally { $ErrorActionPreference = $prev }
      if ($exe -and (Test-Path $exe)) { return $exe }
    }
  }
  return ""
}

$pyExe = ""
if (-not (Test-Path $venvPy)) {
  if ($uvCmd) {
    Write-Host "[sensenova-install] found uv: $($uvCmd.Source)"
    $prev = $ErrorActionPreference
    try {
      $ErrorActionPreference = "Continue"
      $found = ((& uv python find "3.11") 2>$null | Out-String).Trim()
      if ($LASTEXITCODE -ne 0 -or -not $found) {
        Write-Host "[sensenova-install] no uv-managed 3.11 on this machine, installing one (about 30-60 seconds, via npmmirror)..."
        & uv python install 3.11 2>&1 | ForEach-Object { Write-Host "[uv] $_" }
        $found = ((& uv python find "3.11") 2>$null | Out-String).Trim()
      }
    } catch {
      $found = ""
    } finally {
      $ErrorActionPreference = $prev
    }
    $cand = (($found | Out-String) -split "`n")[0].Trim()
    if ($cand -and (Test-Path $cand)) {
      $pyExe = $cand
      Write-Host "[sensenova-install] using the uv-managed interpreter: $pyExe"
    } else {
      Write-Host "[sensenova-install] note: uv did not yield a usable 3.11 interpreter (the mirror fetch may have failed), falling back to the local Python"
    }
  }
  if (-not $pyExe) {
    $pyExe = Find-LocalPython @("3.11", "3.12", "3.13", "3.10")
  }
  if (-not $pyExe) {
    Fail-Install "python_not_found" "Neither uv nor a local Python 3.10-3.13 is available. Install uv (`pip install uv` or the official script) or Python 3.11 (python.org / Microsoft Store), or point at one with -Python C:\path\to\python.exe and rerun."
  }
  Write-Host "[sensenova-install] venv will be created with: $pyExe"
}

if (-not (Test-Path $venvPy)) {
  Write-Progress-Line 12 "creating the venv (.venv, skipped when it already exists)..."
  $code = Invoke-Cmd $pyExe @("-m", "venv", ".venv")
  if ($code -ne 0 -or -not (Test-Path $venvPy)) {
    Write-Host "[sensenova-install] python -m venv failed (exit code $code), trying --without-pip + ensurepip..."
    $null = Invoke-Cmd $pyExe @("-m", "venv", "--without-pip", ".venv")
    if (Test-Path $venvPy) {
      $null = Invoke-Cmd $venvPy @("-m", "ensurepip", "--upgrade")
    }
  }
  if (-not (Test-Path $venvPy) -and $uvCmd) {
    Write-Host "[sensenova-install] falling back to uv venv --seed (pip included)"
    $prev = $ErrorActionPreference
    try {
      $ErrorActionPreference = "Continue"
      & uv venv .venv --python 3.11 --seed 2>&1 | ForEach-Object { Write-Host "[uv] $_" }
    } finally { $ErrorActionPreference = $prev }
  }
  if (-not (Test-Path $venvPy)) {
    Fail-Install "venv_creation_failed" "Delete the half-created .venv and rerun this script; if it still fails, run this by hand: & `"$pyExe`" -m venv .\.venv and paste the error."
  }
} else {
  Write-Host "[sensenova-install] .venv already exists, skipping creation (the interpreter is not swapped; delete .venv and rerun to change it)"
}

Write-Progress-Line 16 "verifying the venv interpreter and upgrading pip (Tsinghua -> Aliyun)..."
$null = Invoke-Cmd $venvPy @("-c", "import sys; print('[sensenova-install] venv python', sys.version.split()[0], sys.executable)")
$pipCode = Invoke-Cmd $venvPy @("-m", "pip", "--version")
if ($pipCode -ne 0) {
  Write-Host "[sensenova-install] no pip inside the venv, running ensurepip to add it"
  $null = Invoke-Cmd $venvPy @("-m", "ensurepip", "--upgrade")
}
$code = Invoke-Cmd $venvPy @("-m", "pip", "install", "--upgrade", "pip", "-i", $PipIndex, "--trusted-host", $PipHost)
if ($code -ne 0) {
  Write-Host "[sensenova-install] the Tsinghua mirror failed to upgrade pip, falling back to Aliyun..."
  $null = Invoke-Cmd $venvPy @("-m", "pip", "install", "--upgrade", "pip", "-i", $PipIndexFallback)
}

# ---------------------------------------------------------------- 3. torch (CUDA * domestic mirrors)
$torchCu = "cu128"
if ($driverMajor -gt 0 -and $driverMajor -lt 570) {
  $torchCu = "cu126"
  Write-Host "[sensenova-install] driver major $driverMajor < 570 -> switching to the $torchCu tier (cu128 needs a 570+ driver)"
}
if ($Cpu) { $torchCu = "cpu" }

if ($SkipTorch) {
  Write-Progress-Line 30 "skipping the torch install (-SkipTorch)"
} elseif ($TorchWheel -and (Test-Path $TorchWheel)) {
  Write-Progress-Line 22 "offline torch install: $TorchWheel (a torchvision whl is looked up next to it)..."
  # Offline whl: torch/torchvision come from the local wheels, while any missing transitive deps (numpy / pillow / filelock...)
  # are still filled in from the Tsinghua mirror (the PIP_* environment variables keep the unreachable global pip.ini extra index out).
  $code = Invoke-Cmd $venvPy @("-m", "pip", "install", $TorchWheel, "-i", $PipIndex, "--trusted-host", $PipHost)
  $tv = Get-ChildItem -Path (Split-Path -Parent $TorchWheel) -Filter "torchvision-*.whl" -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($tv) {
    $code2 = Invoke-Cmd $venvPy @("-m", "pip", "install", $tv.FullName, "-i", $PipIndex, "--trusted-host", $PipHost)
  } else {
    $code2 = Invoke-Cmd $venvPy @("-m", "pip", "install", "torchvision==0.23.0", "-i", $PipIndex, "--trusted-host", $PipHost)
    Write-Host "[sensenova-install] note: no torchvision whl next to it, installing the PyPI build instead (it may not match the CUDA tier exactly; only preprocessing ops are affected)"
  }
  if ($code -ne 0 -or $code2 -ne 0) {
    Fail-Install "torch_install_failed" "Offline whl install failed (torch=$code torchvision=$code2): read the error above; the usual cause is that the whl's cpXXX tag does not match this venv's Python version (this pack recommends cp311)."
  }
} else {
  # Critical: for a non-CPU tier the **local version tag** (+cu128 / +cu126) must go into the pin -- the Windows
  # torch wheels on Tsinghua / PyPI are CPU builds, so a bare `torch==2.8.0` is easily resolved to the CPU build (a false success).
  $local = if ($torchCu -eq "cpu") { "" } else { "+$torchCu" }
  $torchPins = @("torch==2.8.0$local", "torchvision==0.23.0$local")
  Write-Progress-Line 22 "installing $($torchPins -join ' + ') (about 3.5GB, trying sources in order: SJTU -> Aliyun -> official)..."
  $torchOk = $false
  if ($TorchIndex) {
    # Custom source: point --index-url at it, torch's transitive deps still resolve from Tsinghua
    $a = @("-m","pip","install") + $torchPins + @("--index-url", $TorchIndex, "--extra-index-url", $PipIndex, "--trusted-host", $PipHost)
    $code = Invoke-Cmd $venvPy $a
    if ($code -eq 0) { $torchOk = $true } else {
      Fail-Install "torch_install_failed" "The source given by -TorchIndex ($TorchIndex) cannot install $($torchPins -join ' + '): check that the index has a matching cp311/win_amd64 wheel, or drop that parameter to use automatic mirror selection."
    }
  } else {
    # (1) SJTU: a PEP503 mirror of download.pytorch.org, usable directly as --index-url; transitive deps come from
    #     Tsinghua. The PIP_* environment variables (see the file header) already override the extra index of the
    #     machine-global pip.ini (NVIDIA PyIndex likes to push pypi.ngc.nvidia.com in; unreachable -> 5 retries wasted).
    $a = @("-m","pip","install") + $torchPins + @("--index-url", "https://mirror.sjtu.edu.cn/pytorch-wheels/$torchCu", "--extra-index-url", $PipIndex, "--trusted-host", $PipHost)
    $code = Invoke-Cmd $venvPy $a
    if ($code -eq 0) { $torchOk = $true } else { Write-Host "[sensenova-install] SJTU mirror failed (exit code $code), trying Aliyun..." }
  }
  if (-not $torchOk -and -not $TorchIndex) {
    # (2) Aliyun: a flat wheel directory -> --find-links, torch's transitive deps still resolve from Tsinghua PyPI
    $a = @("-m","pip","install") + $torchPins + @("--find-links", "https://mirrors.aliyun.com/pytorch-wheels/$torchCu", "-i", $PipIndex, "--trusted-host", $PipHost)
    $code = Invoke-Cmd $venvPy $a
    if ($code -eq 0) { $torchOk = $true } else { Write-Host "[sensenova-install] Aliyun mirror failed (exit code $code), falling back to the official index..." }
  }
  if (-not $torchOk) {
    # (3) official last resort (that index carries torch's transitive deps, a single --index-url is enough)
    $a = @("-m","pip","install") + $torchPins + @("--index-url", "https://download.pytorch.org/whl/$torchCu")
    $code = Invoke-Cmd $venvPy $a
    if ($code -eq 0) { $torchOk = $true }
  }
  if (-not $torchOk) {
    Fail-Install "torch_install_failed" "All three sources failed to install $($torchPins -join ' + '). You can: (1) download torch-2.8.0$local-cp311-cp311-win_amd64.whl by hand and rerun with -TorchWheel `<path>`; (2) use -TorchIndex to point at a company intranet mirror; (3) if the driver is too old, update the NVIDIA driver to 570+ (cu128), or let the script step down automatically (<570 uses cu126)."
  }
}

Write-Progress-Line 30 "verifying that torch really sees CUDA..."
if (-not $Cpu) {
  $checkPy = @'
import sys
try:
    import torch
except Exception as e:
    print(f"[sensenova-install] torch not importable: {type(e).__name__}: {str(e)[:200]}")
    sys.exit(2)
ok = bool(torch.cuda.is_available())
print(f"[sensenova-install] torch {torch.__version__} * cuda={torch.version.cuda or '-'} * "
      f"cuda_available={ok}" + (f" * device={torch.cuda.get_device_name(0)}" if ok else ""))
sys.exit(0 if ok else 3)
'@
  $cf = Join-Path $env:TEMP ("mtnode-sensenova-torch-" + [guid]::NewGuid().ToString("N") + ".py")
  Set-Content -Path $cf -Value $checkPy -Encoding UTF8
  $code = Invoke-Cmd $venvPy @($cf)
  Remove-Item -Force $cf -ErrorAction SilentlyContinue
  if ($code -ne 0) {
    if ($Force) {
      Write-Host "[sensenova-install] warning: torch cannot see CUDA (exit code $code, let through by -Force). Real /generate will report model_load_failed."
    } else {
      Fail-Install "torch_no_cuda" "torch installed but torch.cuda.is_available()=False -- most likely the CPU build got installed (the Windows torch on Tsinghua/PyPI is the CPU build) or the driver is too old. First run `& `"$venvPy`" -m pip uninstall -y torch torchvision`", then rerun this script (it installs the $torchCu build from domestic mirrors; weights are not re-downloaded). If the driver is below 570, upgrade the NVIDIA driver, or confirm the script already stepped down to cu126 for <570."
    }
  }
}

# ---------------------------------------------------------------- 4. dependencies
if ($SkipDeps) {
  Write-Progress-Line 40 "skipping requirements.txt (-SkipDeps)"
} else {
  Write-Progress-Line 34 "installing Python dependencies (requirements.txt: transformers>=4.57.1 / accelerate / modelscope / pillow, Tsinghua mirror)..."
  $ReqFile = Join-Path $InstallDir "requirements.txt"
  if (-not (Test-Path $ReqFile)) {
    $ReqFile = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path | Split-Path -Parent) "requirements.txt"
  }
  $code = Invoke-Cmd $venvPy @("-m", "pip", "install", "-r", $ReqFile, "-i", $PipIndex, "--trusted-host", $PipHost)
  if ($code -ne 0) {
    Write-Host "[sensenova-install] the Tsinghua mirror failed, retrying with the Aliyun mirror..."
    $code = Invoke-Cmd $venvPy @("-m", "pip", "install", "-r", $ReqFile, "-i", $PipIndexFallback)
    if ($code -ne 0) {
      Fail-Install "requirements_install_failed" "Reinstall alone to see the full error: & `"$venvPy`" -m pip install -r requirements.txt -i $PipIndex --trusted-host $PipHost"
    }
  }
}

Write-Progress-Line 40 "verifying the transformers version knows the NEOChatModel config..."
$tfPy = @'
import sys
try:
    import transformers
except Exception as e:
    print(f"[sensenova-install] transformers not usable: {type(e).__name__}: {str(e)[:200]}")
    sys.exit(2)
parts = tuple(int(x) for x in transformers.__version__.split(".")[:2] if x.isdigit())
print(f"[sensenova-install] transformers {transformers.__version__} (sensenova_u1 requires >=4.57.1,<6)")
sys.exit(0 if parts >= (4, 57) else 3)
'@
$tfFile = Join-Path $env:TEMP ("mtnode-sensenova-tf-" + [guid]::NewGuid().ToString("N") + ".py")
Set-Content -Path $tfFile -Value $tfPy -Encoding UTF8
$tfCode = Invoke-Cmd $venvPy @($tfFile)
Remove-Item -Force $tfFile -ErrorAction SilentlyContinue
if ($tfCode -ne 0) {
  Fail-Install "transformers_too_old" "transformers version is below the requirement (exit code $tfCode): under 4.57.1 AutoConfig does not recognize model_type=`"neo_chat`" and loading always fails. Install it with: & `"$venvPy`" -m pip install -U `"transformers>=4.57.1,<6`" -i $PipIndex --trusted-host $PipHost, then rerun this script."
}

# ---------------------------------------------------------------- 5. sensenova_u1 inference package
$SrcRoot = Join-Path $InstallDir "src"
$PkgDirName = "SenseNova-U1-$($Ref -replace '[/\\]', '-')"
$PkgDir = Join-Path $SrcRoot $PkgDirName
$TarPath = Join-Path $SrcRoot "$PkgDirName.tar.gz"
$AttnFile = Join-Path $InstallDir ".attn-backend"

if ($SkipPkg) {
  Write-Progress-Line 54 "skipping the sensenova_u1 inference package install (-SkipPkg)"
} else {
  Write-Progress-Line 44 "fetching the sensenova_u1 source (not on PyPI; GitHub tag $Ref archive, domestic proxies first)..."
  New-Item -ItemType Directory -Force -Path $SrcRoot | Out-Null

  if ($SrcTarball) {
    if (Test-Path $SrcTarball -PathType Container) {
      $PkgDir = (Resolve-Path $SrcTarball).Path
      Write-Host "[sensenova-install] using the already-unpacked source dir: $PkgDir"
    } elseif (Test-Path $SrcTarball) {
      Copy-Item -Force $SrcTarball $TarPath
      Write-Host "[sensenova-install] using the existing archive: $SrcTarball"
    } else {
      Write-Host "[sensenova-install] warning: the -SrcTarball path does not exist: $SrcTarball, falling back to the online download"
    }
  }

  # Source-ready criterion: the set must be **complete**. Checking pyproject.toml alone would treat a directory left
  # incomplete by an earlier unpack (a missing LICENSE, say) as ready, so re-unpacking would be skipped forever and
  # hatchling would keep raising `OSError: License file does not exist: LICENSE`. Any missing item re-unpacks (self-healing).
  function Test-PkgSourceReady([string]$dir) {
    foreach ($rel in @("pyproject.toml", "LICENSE", "src\sensenova_u1\__init__.py")) {
      if (-not (Test-Path (Join-Path $dir $rel))) {
        Write-Host "[sensenova-install] source is missing $rel (treated as not ready, unpacking again)"
        return $false
      }
    }
    return $true
  }

  if (-not (Test-PkgSourceReady $PkgDir)) {
    if (-not (Test-Path $TarPath)) {
      $urls = @(
        "https://ghfast.top/https://github.com/OpenSenseNova/SenseNova-U1/archive/refs/tags/$Ref.tar.gz",
        "https://gh-proxy.com/https://github.com/OpenSenseNova/SenseNova-U1/archive/refs/tags/$Ref.tar.gz",
        "https://ghproxy.net/https://github.com/OpenSenseNova/SenseNova-U1/archive/refs/tags/$Ref.tar.gz",
        "https://github.com/OpenSenseNova/SenseNova-U1/archive/refs/tags/$Ref.tar.gz"
      )
      $oldProgress = $ProgressPreference
      foreach ($url in $urls) {
        try {
          Write-Host "[sensenova-install] downloading the archive: $url"
          $ProgressPreference = "SilentlyContinue"
          Invoke-WebRequest -Uri $url -OutFile $TarPath -UseBasicParsing -TimeoutSec 900 `
            -Headers @{ "User-Agent" = "MTNode-SenseNova-Installer" }
          if ((Get-Item $TarPath).Length -lt 200000) {
            Write-Host "[sensenova-install] archive too small ($((Get-Item $TarPath).Length) bytes), treating it as a failure"
            Remove-Item -Force $TarPath -ErrorAction SilentlyContinue
            continue
          }
          Write-Host "[sensenova-install] archive in hand: $([math]::Round((Get-Item $TarPath).Length/1MB,1)) MB"
          break
        } catch {
          Write-Host "[sensenova-install] this source failed: $($_.Exception.Message)"
          Remove-Item -Force $TarPath -ErrorAction SilentlyContinue
        } finally {
          $ProgressPreference = $oldProgress
        }
      }
    }
    if (Test-Path $TarPath) {
      Write-Progress-Line 48 "unpacking (only pyproject.toml / README.md / LICENSE / src; the huge training / evaluation dirs are skipped)..."
      if (Test-Path $PkgDir) { Remove-Item -Recurse -Force $PkgDir -ErrorAction SilentlyContinue }
      New-Item -ItemType Directory -Force -Path $PkgDir | Out-Null
      # Unpack rules (measured with the bsdtar that ships with Windows):
      #   (1) When selecting by member name you **must not** add --strip-components: the member names already carry the
      #       top-level dir `${PkgDirName}/pyproject.toml`, so stripping one level would drop the files into $SrcRoot
      #       instead of $PkgDir and the later check of $PkgDir\pyproject.toml wrongly concludes "no files came out" (the source did unpack).
      #   (2) LICENSE must be taken along: pyproject has license = { file = "LICENSE" }, and without it hatchling
      #       raises `OSError: License file does not exist: LICENSE` during Preparing metadata -- it looks like a
      #       network / build environment problem but is really one missing file.
      #   (3) The full-unpack fallback uses --strip-components=1 with -C $PkgDir, dropping the top level straight into $PkgDir.
      $prefix = "$PkgDirName/"
      $code = Invoke-Cmd "tar" @("-xzf", $TarPath, "-C", $SrcRoot,
        "${prefix}pyproject.toml", "${prefix}README.md", "${prefix}LICENSE", "${prefix}src")
      if ($code -ne 0 -or -not (Test-Path (Join-Path $PkgDir "pyproject.toml"))) {
        Write-Host "[sensenova-install] the prefix unpack produced no files (exit code $code), falling back to a full unpack"
        $null = Invoke-Cmd "tar" @("-xzf", $TarPath, "-C", $PkgDir, "--strip-components=1")
      }
    }
  }

  if (-not (Test-PkgSourceReady $PkgDir)) {
    Fail-Install "source_unavailable" "Could not get the sensenova_u1 source (the $Ref archive; all four sources failed). Download https://github.com/OpenSenseNova/SenseNova-U1/archive/refs/tags/$Ref.tar.gz by hand, then rerun this script with -SrcTarball `<path>` (on an offline machine a colleague can download it and copy it over)."
  }

  Write-Progress-Line 50 "installing sensenova_u1 (--no-deps: never let pip re-resolve the torch deps)..."
  # --no-deps is mandatory: pyproject pins torch==2.8.0, and if pip re-resolved it, it would pull the Windows CPU wheel from
  # PyPI/Tsinghua and overwrite the cu128 build step 3 worked so hard on (the official docs/installation requires the same).
  $code = Invoke-Cmd $venvPy @("-m", "pip", "install", $PkgDir, "--no-deps", "-i", $PipIndex, "--trusted-host", $PipHost)
  if ($code -ne 0) {
    Write-Host "[sensenova-install] normal install failed (exit code $code), trying --no-build-isolation (installing hatchling first)..."
    $null = Invoke-Cmd $venvPy @("-m", "pip", "install", "hatchling", "-i", $PipIndex, "--trusted-host", $PipHost)
    $code = Invoke-Cmd $venvPy @("-m", "pip", "install", $PkgDir, "--no-deps", "--no-build-isolation")
    if ($code -ne 0) {
      Fail-Install "package_install_failed" "sensenova_u1 could not be installed into the venv from $PkgDir. Run it once by hand to see the full error: & `"$venvPy`" -m pip install `"$PkgDir`" --no-deps; the usual cause is the build isolation environment failing to fetch hatchling (switch to -i $PipIndexFallback or add --no-build-isolation)."
    }
  }

  Write-Progress-Line 52 "verifying the sensenova_u1 interface and attention tier (writing $AttnFile)..."
  $pkgPy = @'
import sys

backend_file = sys.argv[1]
code = 0
try:
    import sensenova_u1
except Exception as e:
    print(f"[sensenova-install] sensenova_u1 import failed: {type(e).__name__}: {str(e)[:300]}")
    print("[sensenova-install]   usually transformers is too old (>=4.57.1 needed), or sentencepiece / safetensors is missing after --no-deps")
    sys.exit(2)
print(f"[sensenova-install] sensenova_u1 {getattr(sensenova_u1, '__version__', 'unknown')} imported OK (NEO-Unify is registered with transformers)")
try:
    from sensenova_u1.utils import (
        load_model_and_tokenizer, make_offload_ctx, vram_mode_to_prefetch_count,
        vram_mode_keeps_generation_resident, best_available_device,
    )
    modes = {m: vram_mode_to_prefetch_count(m) for m in ("full", "fast", "balanced", "low")}
    print(f"[sensenova-install] utils interface complete * vram_mode->prefetch={modes} * best_device={best_available_device()}")
except Exception as e:
    print(f"[sensenova-install] sensenova_u1.utils interface incomplete: {type(e).__name__}: {str(e)[:200]}")
    code = 3
try:
    import flash_attn  # noqa: F401
    backend = "flash"
    print("[sensenova-install] flash_attn imports -> .attn-backend = flash")
except Exception:
    backend = "sdpa"
    print("[sensenova-install] no flash_attn (the Windows norm; the official project ships no such wheel) -> .attn-backend = sdpa")
try:
    sensenova_u1.set_attn_backend(backend)
    print(f"[sensenova-install] effective attention backend: {sensenova_u1.effective_attn_backend()}")
except Exception as e:
    print(f"[sensenova-install] set_attn_backend({backend}) failed: {str(e)[:160]}")
    code = code or 3
try:
    from sensenova_u1.models.neo_unify import NEOChatModel  # noqa: F401
    print("[sensenova-install] NEOChatModel available (the host class of t2i_generate)")
except Exception as e:
    print(f"[sensenova-install] NEOChatModel not importable: {type(e).__name__}: {str(e)[:200]}")
    code = code or 3
try:
    with open(backend_file, "w", encoding="utf-8") as f:
        f.write(backend + "\n")
except Exception as e:
    print(f"[sensenova-install] warning: writing .attn-backend failed: {str(e)[:160]}")
sys.exit(code)
'@
  $pkgFile = Join-Path $env:TEMP ("mtnode-sensenova-pkg-" + [guid]::NewGuid().ToString("N") + ".py")
  Set-Content -Path $pkgFile -Value $pkgPy -Encoding UTF8
  $pkgCode = Invoke-Cmd $venvPy @($pkgFile, $AttnFile)
  Remove-Item -Force $pkgFile -ErrorAction SilentlyContinue
  if ($pkgCode -eq 2) {
    Fail-Install "package_import_failed" "sensenova_u1 installed but the import failed (see the error above). Add the deps the message points at (most often: & `"$venvPy`" -m pip install -U `"transformers>=4.57.1,<6`" -i $PipIndex; or sentencepiece==0.2.1), then rerun this script -- **do not re-download the 32.66GB of weights**."
  }
  if ($pkgCode -ne 0) {
    Write-Host "[sensenova-install] warning: the sensenova_u1 interface self-check did not fully pass (exit code $pkgCode); continuing the install -- come back to this step if real /generate reports model_load_failed."
  }
}

# ---------------------------------------------------------------- 6. weights
$ModelsDir = Join-Path $InstallDir "models"
New-Item -ItemType Directory -Force -Path $ModelsDir | Out-Null
$ModelDirFlat = Join-Path $ModelsDir "SenseNova__SenseNova-U1.5-8B-MoT"

function Test-ModelComplete([string]$dir) {
  if (-not (Test-Path $dir)) { return $false }
  if (-not (Test-Path (Join-Path $dir "config.json"))) { return $false }
  if (-not (Test-Path (Join-Path $dir "model.safetensors.index.json"))) { return $false }
  $shards = @(Get-ChildItem -Path $dir -Filter "model-*-of-00008.safetensors" -ErrorAction SilentlyContinue)
  if ($shards.Count -lt 8) {
    Write-Host "[sensenova-install] only $($shards.Count)/8 weight shards present, treating the download as unfinished"
    return $false
  }
  $gb = 0
  try { $gb = [math]::Round((($shards | Measure-Object -Property Length -Sum).Sum / 1GB), 2) } catch { $gb = 0 }
  if ($gb -lt 30) {
    Write-Host "[sensenova-install] weight shards total only $gb GB (should be about 32.66GB), treating the download as unfinished"
    return $false
  }
  Write-Host "[sensenova-install] weight check passed: 8 shards / $gb GB @ $dir"
  return $true
}

Write-Progress-Line 56 "preparing the weights ($ModelScopeRepo * about 32.66GB)..."
if ($ModelDir -and (Test-Path $ModelDir)) {
  if (Test-Path $ModelDirFlat) {
    Write-Host "[sensenova-install] models\SenseNova__SenseNova-U1.5-8B-MoT already exists, ignoring -ModelDir"
  } else {
    try {
      New-Item -ItemType Junction -Path $ModelDirFlat -Target $ModelDir -ErrorAction Stop | Out-Null
      Write-Host "[sensenova-install] directory junction created: $ModelDirFlat -> $ModelDir"
    } catch {
      Write-Host "[sensenova-install] the junction failed, copying instead (this takes 32.66GB of space): $($_.Exception.Message)"
      Copy-Item -Recurse -Force $ModelDir $ModelDirFlat
    }
  }
}

if ($SkipModels) {
  Write-Progress-Line 78 "skipping the weight download (-SkipModels)"
} elseif (Test-ModelComplete $ModelDirFlat) {
  Write-Progress-Line 78 "weights already in place, skipping the download"
} else {
  Write-Progress-Line 58 "downloading the weights: ModelScope (direct domestic access) first, falling back to hf-mirror..."
  $pyDl = @'
import os
import sys
from pathlib import Path

ms_repo, hf_repo, dest = sys.argv[1], sys.argv[2], sys.argv[3]
ignore = ["assets/*", "docs/*", "*.mp4", "*.webm", "*.gif"]


def complete(d):
    p = Path(d)
    if not (p / "config.json").is_file():
        return False
    if not (p / "model.safetensors.index.json").is_file():
        return False
    shards = list(p.glob("model-*-of-00008.safetensors"))
    if len(shards) < 8:
        print(f"[sensenova-install] only {len(shards)}/8 shards")
        return False
    total = sum(s.stat().st_size for s in shards) / (1024 ** 3)
    print(f"[sensenova-install] {len(shards)} shards / {total:.2f} GB")
    return total >= 30


if complete(dest):
    print("[sensenova-install] weights already complete, skipping the download")
    sys.exit(0)

done = False
try:
    from modelscope import snapshot_download
    print(f"[sensenova-install] ModelScope download {ms_repo} -> {dest} (32.66GB, direct domestic access, about 20-60 minutes depending on bandwidth)")
    snapshot_download(ms_repo, local_dir=dest, ignore_patterns=ignore)
    done = complete(dest)
except Exception as e:
    print(f"[sensenova-install] ModelScope failed: {type(e).__name__}: {str(e)[:300]}")

if not done:
    try:
        os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
        os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
        from huggingface_hub import snapshot_download as hf_snapshot
        print(f"[sensenova-install] hf-mirror download {hf_repo} -> {dest} (endpoint={os.environ.get('HF_ENDPOINT')})")
        hf_snapshot(repo_id=hf_repo, local_dir=dest, ignore_patterns=ignore)
        done = complete(dest)
    except Exception as e:
        print(f"[sensenova-install] hf-mirror failed: {type(e).__name__}: {str(e)[:300]}")

if not done:
    print("[sensenova-install] weights are incomplete (neither ModelScope nor hf-mirror produced all 8 shards).")
    print("[sensenova-install] resume: simply rerun this script (shards already downloaded are not fetched again);")
    print("[sensenova-install]        or download them with a browser / another tool and rerun with -ModelDir <path>.")
    sys.exit(3)
print("[sensenova-install] weight download finished")
'@
  $dlScript = Join-Path $env:TEMP ("mtnode-sensenova-dl-" + [guid]::NewGuid().ToString("N") + ".py")
  Set-Content -Path $dlScript -Value $pyDl -Encoding UTF8
  $dlCode = Invoke-Cmd $venvPy @($dlScript, $ModelScopeRepo, $HfRepo, $ModelDirFlat)
  Remove-Item -Force $dlScript -ErrorAction SilentlyContinue
  if ($dlCode -ne 0) {
    Write-Host "[sensenova-install] warning: weights are incomplete (exit code $dlCode). The service still starts, but real /generate reports model_load_failed; rerun this script to resume."
  }
}

if (Test-ModelComplete $ModelDirFlat) {
  New-Item -ItemType File -Force -Path (Join-Path $ModelsDir ".ok") | Out-Null
  Write-Host "[sensenova-install] model in place: SenseNova-U1.5-8B-MoT (models\.ok written)"
} else {
  Write-Host "[sensenova-install] note: models\.ok was not created (weights incomplete); point -ModelDir at an existing dir, or rerun the download without -SkipModels"
}

# ---------------------------------------------------------------- 7. project file checklist
Write-Progress-Line 82 "checking the project file checklist..."
$RequiredFiles = @(
  "app\__init__.py",
  "app\__main__.py",
  "app\server.py",
  "app\engine.py",
  "scripts\install.ps1",
  "requirements.txt",
  "manifest.json",
  "start_backend.cmd"
)
$MissingFiles = @()
foreach ($rel in $RequiredFiles) {
  if (-not (Test-Path (Join-Path $InstallDir $rel))) { $MissingFiles += $rel }
}
if ($MissingFiles.Count -gt 0) {
  Write-Host "[sensenova-install] warning: project files missing: " + ($MissingFiles -join ", ")
  Write-Host "[sensenova-install]       copy app\ and scripts\ from the bundled scaffold (SCAFFOLD_REF\sensenova-pack) and rerun;"
  Write-Host "[sensenova-install]       the service will not start if either app\engine.py or app\server.py is missing."
} else {
  Write-Host "[sensenova-install] project files complete"
}

# ---------------------------------------------------------------- 8. mock smoke test (no model load, verifies the interface)
$smokeOk = $true
if ($SkipSmoke) {
  Write-Progress-Line 92 "skipping the mock smoke test (-SkipSmoke)"
} else {
  Write-Progress-Line 86 "mock smoke test (MTNODE_SENSENOVA_MOCK=1: /health -> /generate writes a PNG -> busy 429 -> /cancel -> /progress -> /shutdown)..."
  $smokePy = @'
import json, os, shutil, subprocess, sys, tempfile, threading, time, urllib.error, urllib.request, uuid
from pathlib import Path

install_dir = Path(sys.argv[1])
port = int(sys.argv[2])
log_path = Path(tempfile.gettempdir()) / f"mtnode-sensenova-smoke-{uuid.uuid4().hex}.log"
out_dir = Path(tempfile.gettempdir()) / f"mtnode-sensenova-out-{uuid.uuid4().hex}"

env = dict(os.environ)
env["MTNODE_SENSENOVA_MOCK"] = "1"
env["SENSENOVA_PORT"] = str(port)
env["SENSENOVA_MOCK_DELAY_SEC"] = "3"   # stretch the mock so the busy / cancel paths reproduce reliably
env["PYTHONIOENCODING"] = "utf-8"
proc = subprocess.Popen([sys.executable, "-m", "app", str(port)], cwd=str(install_dir), env=env,
                        stdout=open(log_path, "w", encoding="utf-8", errors="replace"),
                        stderr=subprocess.STDOUT)
code = 0


def post(path, body, timeout=60):
    req = urllib.request.Request("http://127.0.0.1:%d%s" % (port, path),
                                 data=json.dumps(body).encode("utf-8"),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def get(path, timeout=10):
    with urllib.request.urlopen("http://127.0.0.1:%d%s" % (port, path), timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


body = {
    "prompt": "a red cube on a white table, studio light, product photo",
    "width": 512, "height": 512, "numSteps": 4, "cfgScale": 4.0,
    "seed": 123456, "think": True, "outputDir": str(out_dir), "filename": "smoke.png",
}
try:
    health = None
    for _ in range(120):
        if proc.poll() is not None:
            break
        try:
            health = get("/health", timeout=2)
            break
        except Exception:
            time.sleep(0.5)
    if not health:
        print("[sensenova-install] smoke failed: /health did not respond (the service did not start; see the log below)")
        code = 4
    else:
        print("[sensenova-install] /health -> " + json.dumps(
            {k: health.get(k) for k in ("ok", "service", "version", "model", "device", "mock",
                                        "loaded", "busy", "vramMode", "attnBackend")}, ensure_ascii=False))
        bad = []
        if health.get("mock") is not True:
            bad.append("mock!=true")
        if health.get("service") != "mtnode-sensenova":
            bad.append("service name mismatch")
        if health.get("model") != "sensenova/SenseNova-U1.5-8B-MoT":
            bad.append("model repo id mismatch")
        if len(health.get("resolutions") or []) != 11:
            bad.append("resolutions should be the 11 official resolution buckets")
        if not (health.get("defaults") or {}).get("numSteps"):
            bad.append("defaults missing (the host form needs them)")
        if bad:
            print("[sensenova-install] smoke failed: /health contract mismatch -> " + "; ".join(bad))
            code = 5

    if code == 0:
        # Reference image: with refImages the engine must enter image edit mode (mode=edit) and record the refs in the artifacts
        ref_png = out_dir / "ref-input.png"
        try:
            out_dir.mkdir(parents=True, exist_ok=True)
            ref_png.write_bytes(bytes.fromhex(
                "89504e470d0a1a0a0000000d4948445200000001000000010806000000"
                "1f15c4890000000d49444154789c6360000002000100ffff0300000600"
                "05570c1c0000000049454e44ae426082"))
        except Exception as e:
            print("[sensenova-install] warning: could not create the reference image (" + str(e)[:160] + "), skipping the reference-image check")
            ref_png = None
        if code == 0 and ref_png is not None:
            body_ref = dict(body)
            body_ref["filename"] = "with-ref.png"
            body_ref["refImages"] = [str(ref_png).replace("\\", "/"), str(out_dir / "nope.png").replace("\\", "/")]
            ref_err = ""
            try:
                rref = post("/generate", body_ref, timeout=120)
            except Exception as e:
                ref_err = str(e)[:200]
                rref = {}
            print("[sensenova-install] reference-image mock -> " + json.dumps(
                {k: rref.get(k) for k in ("ok", "mode", "refImagesUsed", "imagePath")}, ensure_ascii=False))
            if ref_err:
                print("[sensenova-install] smoke failed: /generate with refImages raised " + ref_err)
                code = 18
            elif rref.get("mode") != "edit" or int(rref.get("refImagesUsed") or 0) != 1:
                print("[sensenova-install] smoke failed: reference images did not enter image edit mode (mode/refImagesUsed mismatch)")
                code = 19
            elif not Path(rref.get("imagePath") or "").is_file():
                print("[sensenova-install] smoke failed: the artifact with reference images was not written to disk")
                code = 20
            else:
                settings = out_dir / "settings.json"
                try:
                    blob = json.loads(settings.read_text(encoding="utf-8"))
                except Exception as e:
                    blob = {}
                    print("[sensenova-install] warning: reading settings.json failed (" + str(e)[:120] + ")")
                if blob.get("mode") != "edit" or len(blob.get("refImages") or []) != 1:
                    print("[sensenova-install] smoke failed: settings.json does not record the reference images as active (mode/refImages mismatch)")
                    code = 21

    if code == 0:
        first = {}

        def run_first():
            try:
                first["resp"] = post("/generate", body, timeout=120)
            except Exception as e:
                first["err"] = str(e)[:200]

        th = threading.Thread(target=run_first)
        th.start()
        time.sleep(0.8)  # the mock is deliberately 3s slow, so this call is bound to hit busy
        busy_code = None
        try:
            post("/generate", body, timeout=20)
        except urllib.error.HTTPError as e:
            busy_code = e.code
            print("[sensenova-install] concurrent second call -> HTTP " + str(e.code) + " " +
                  e.read().decode("utf-8", "replace")[:200])
        except Exception as e:
            print("[sensenova-install] concurrent second call raised: " + str(e)[:200])
        if busy_code != 429:
            print("[sensenova-install] smoke failed: concurrent generation did not return 429 busy (the concurrency guard is broken)")
            code = 6
        prog_mid = None
        try:
            prog_mid = get("/progress")
        except Exception as e:
            print("[sensenova-install] /progress (while generating) raised: " + str(e)[:160])
        if prog_mid is not None and not prog_mid.get("running"):
            print("[sensenova-install] warning: /progress.running is not true while generating (progress reporting may be unusable)")
        th.join(timeout=120)
        if "err" in first:
            print("[sensenova-install] smoke failed: the /generate request raised " + first["err"])
            code = 7
        else:
            gen = first.get("resp") or {}
            print("[sensenova-install] mock generation -> " + json.dumps(
                {k: gen.get(k) for k in ("ok", "imagePath", "width", "height", "ratio", "seed",
                                         "mock", "vramMode", "attnBackend", "thinkPath")}, ensure_ascii=False))
            img = Path(gen.get("imagePath") or "")
            if gen.get("ok") is not True or gen.get("mock") is not True:
                print("[sensenova-install] smoke failed: the /generate response does not match the contract")
                code = 8
            elif not img.is_file():
                print("[sensenova-install] smoke failed: the PNG was not written " + str(img))
                code = 9
            elif img.read_bytes()[:8] != b"\x89PNG\r\n\x1a\n":
                print("[sensenova-install] smoke failed: the artifact is not a valid PNG header")
                code = 10
            elif gen.get("seed") != 123456:
                print("[sensenova-install] smoke failed: the seed was not echoed back from the request")
                code = 11
            elif gen.get("width") != 512 or gen.get("height") != 512:
                print("[sensenova-install] smoke failed: width/height were not echoed back")
                code = 12
            elif not gen.get("thinkPath") or not Path(gen["thinkPath"]).is_file():
                print("[sensenova-install] smoke failed: think mode did not write .think.txt")
                code = 13

    if code == 0:
        prog = get("/progress")
        print("[sensenova-install] /progress -> " + json.dumps(
            {k: prog.get(k) for k in ("stage", "percent", "running", "done", "seed")}, ensure_ascii=False))
        if prog.get("stage") != "done" or prog.get("done") is not True:
            print("[sensenova-install] smoke failed: /progress never returned to done")
            code = 14

    if code == 0:
        # One more run cancelled midway: verify the cancel takes effect and leaves no artifact behind
        body2 = dict(body)
        body2["filename"] = "cancelled.png"
        cres = {}

        def run_cancel():
            try:
                cres["resp"] = post("/generate", body2, timeout=60)
            except urllib.error.HTTPError as e:
                cres["http"] = e.code
                cres["body"] = e.read().decode("utf-8", "replace")[:200]
            except Exception as e:
                cres["err"] = str(e)[:200]

        th2 = threading.Thread(target=run_cancel)
        th2.start()
        time.sleep(0.8)
        cancel = post("/cancel", {}, timeout=15)
        th2.join(timeout=60)
        print("[sensenova-install] /cancel -> " + json.dumps(
            {k: cancel.get(k) for k in ("ok", "cancelled", "running")}, ensure_ascii=False))
        if cancel.get("cancelled") is not True:
            print("[sensenova-install] smoke failed: /cancel was not accepted while generating")
            code = 15
        elif cres.get("http") != 409:
            print("[sensenova-install] smoke failed: cancel should answer 409 cancelled, got " + str(cres))
            code = 16
        elif Path(out_dir / "cancelled.png").exists():
            print("[sensenova-install] smoke failed: an artifact was still written after the cancel")
            code = 17

    try:
        post("/shutdown", {}, timeout=15)
    except Exception:
        pass
finally:
    for _ in range(40):
        if proc.poll() is not None:
            break
        time.sleep(0.25)
    if proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except Exception:
            proc.kill()
    try:
        if log_path.is_file():
            tail = log_path.read_text(encoding="utf-8", errors="replace").strip().splitlines()[-25:]
            for line in tail:
                print("[sensenova-install] log | " + line)
            log_path.unlink()
    except Exception:
        pass
    shutil.rmtree(out_dir, ignore_errors=True)

if code == 0:
    print("[sensenova-install] mock smoke test passed (the interface matches the canvas node / host; see [sensenova] ready at the end of the log above)")
else:
    print("[sensenova-install] mock smoke test failed, exit code " + str(code))
sys.exit(code)
'@
  $smokeFile = Join-Path $env:TEMP ("mtnode-sensenova-smoke-" + [guid]::NewGuid().ToString("N") + ".py")
  Set-Content -Path $smokeFile -Value $smokePy -Encoding UTF8
  $smokePort = 8774
  if ($env:SENSENOVA_PORT) {
    try { $smokePort = [int]$env:SENSENOVA_PORT } catch { $smokePort = 8774 }
  }
  $code = Invoke-Cmd $venvPy @($smokeFile, $InstallDir, $smokePort)
  Remove-Item -Force $smokeFile -ErrorAction SilentlyContinue
  $smokeOk = ($code -eq 0)
  if (-not $smokeOk) {
    Write-Host "[sensenova-install] warning: the mock smoke test failed (exit code $code) -- the service contract is broken; fix this before any real generation (see the known-failure table in the SKILL)"
  }
}

# ---------------------------------------------------------------- 9. markers
Write-Progress-Line 96 "writing the install markers..."
if ($smokeOk) {
  New-Item -ItemType File -Force -Path (Join-Path $InstallDir ".install-ok") | Out-Null
  Write-AgentResult "true" ""
} else {
  Write-AgentResult "false" "smoke_failed"
}

Write-Progress-Line 100 "done"
Write-Host "[sensenova-install] result:"
Write-Host "[sensenova-install]   venv         : $venvPy"
Write-Host "[sensenova-install]   pkg source   : $PkgDir"
Write-Host "[sensenova-install]   weights      : $ModelDirFlat"
Write-Host "[sensenova-install]   attn backend : $AttnFile (contents flash/sdpa; SENSENOVA_ATTN_BACKEND can override)"
Write-Host "[sensenova-install]   install flag : $(Join-Path $InstallDir '.install-ok') (its presence means installed)"
Write-Host "[sensenova-install]   manual start : .venv\Scripts\python.exe -m app 8774 (normally started/stopped by MTNode)"
if (-not $smokeOk) {
  Write-Host "[sensenova-install] note: the smoke test failed, .install-ok was not written -- fix it and rerun this script (weights are not re-downloaded)."
  exit 1
}
exit 0
