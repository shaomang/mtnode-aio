# =============================================================================
# YuE2 local music generation backend -- install / repair script (PowerShell, re-runnable, idempotent)
#
# What it does:
#   1. Probe NVIDIA (nvidia-smi / driver major / GPU name / VRAM); with no NVIDIA GPU it
#      stops the install with ok=false reason=no_cuda (-Cpu is an explicit backdoor, but the official requirement is a 24G GPU)
#   2. Probe Python and create a **3.12** venv (falls back to 3.11/3.13/3.10 with a warning when 3.12 is unavailable)
#   3. pip install requirements.txt (explicitly includes gradio, Tsinghua mirror, falls back to Aliyun; --isolated), then self-check gradio
#   4. Install **CUDA torch / torchaudio**: pick cu130 / cu128 / cu126 by driver major version,
#      downgrading one tier per failure; the CPU build is used only with -Cpu or after every CUDA tier fails
#   4b. Run scripts\probe_attention.py to probe the attention tier and write the result to
#      <InstallDir>\.attention-backend (Windows torch often has the flash-attn schema but no matching
#      kernel, so the probe must downgrade the tier to cudnn / sdpa); with no usable tier ->
#      ok=false reason=attention_backend_unsupported plus advice to install a cuDNN-capable torch / change the GPU
#   5. Install the yue2 inference package: take the official yue2_infer-0.1.5-py3-none-any.whl
#      from m-a-p/YuE2-3B (hf_hub_download -> hf-mirror direct link); on failure fall back to the
#      official repo git+https://github.com/multimodal-art-projection/YuE.git (direct -> ghproxy mirror)
#   6. Download m-a-p/YuE2-3B (~7.3GB) and m-a-p/YuE2-Vae (~0.5GB) into
#      <InstallDir>\models\ (falls back to HF_ENDPOINT=https://hf-mirror.com when the HF direct link fails)
#   7. Verify the project file manifest (including app\windows_patch.py, which must coexist with
#      app\engine.py, otherwise every sync round overwrites the Windows attention patch) and check
#      that the ui.py entry imports (python -c "import app.ui"): missing models may defer it, but ModuleNotFoundError is not allowed
#   8. Create models\.ok and .install-ok, then run one MTNODE_YUE2_MOCK=1 smoke with the venv python
#      (start service -> /health -> /generate producing audio.flac + score.abc -> /progress -> /shutdown)
#
# Progress output: [yue2-install] progress: NN (0-100, so the caller can parse it)
# Note: this script does **not** keep the service resident in the background (the smoke shuts it down); MTNode owns start/stop.
# Re-runnable (idempotent): after a half-finished failure just re-run it to resume; parameters below.
# =============================================================================
param(
  [string]$InstallDir = (Split-Path -Parent $MyInvocation.MyCommand.Path | Split-Path -Parent),
  [switch]$Cpu,              # install CPU torch (explicit backdoor for machines without an NVIDIA GPU; the official requirement is a 24G GPU)
  [string]$TorchIndex = "",  # explicit torch index-url (default: matched to the driver automatically)
  [string]$ModelDir = "",    # existing YuE2-3B model dir (offline install / reuse) -> junctioned into <InstallDir>\models
  [string]$VaeDir = "",      # existing YuE2-Vae model dir (same as above)
  [string]$WhlPath = "",     # existing yue2_infer-*.whl (offline install / reuse)
  [switch]$SkipModels,       # skip the model download (use when models are in place and only the venv / inference package needs repair)
  [switch]$SkipInfer         # skip the yue2 inference package install (venv / deps / torch / models / smoke still run)
)
# Force UTF-8 for this process so the host (which decodes our stdout as UTF-8)
# and every native tool we spawn (pip / git / python) agree on one encoding.
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
$OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$env:PYTHONIOENCODING = 'utf-8'

$ErrorActionPreference = "Stop"
$InferWhlName = "yue2_infer-0.1.5-py3-none-any.whl"
$ModelRepo = "m-a-p/YuE2-3B"
$VaeRepo = "m-a-p/YuE2-Vae"

function Write-Progress-Line([int]$Pct, [string]$Msg) {
  Write-Host "[yue2-install] progress: $Pct"
  if ($Msg) { Write-Host "[yue2-install] $Msg" }
}

function Write-AgentResult([string]$Ok, [string]$Reason) {
  $body = "ok=$Ok"
  if ($Reason) { $body = "$body`nreason=$Reason" }
  Set-Content -Path (Join-Path $InstallDir ".yue2-agent-result") -Value $body -Encoding UTF8
}

Write-Host "[yue2-install] ============================================================"
Write-Host "[yue2-install] YuE2 local music generation backend install"
Write-Host "[yue2-install]   models: m-a-p/YuE2-3B (~7.3GB, CC BY-NC 4.0) + m-a-p/YuE2-Vae (~0.5GB)"
Write-Host "[yue2-install]   inference pkg: yue2_infer-0.1.5-py3-none-any.whl (from the YuE2-3B repo)"
Write-Host "[yue2-install]   Python pkgs: Tsinghua mirror pypi.tuna.tsinghua.edu.cn"
Write-Host "[yue2-install]   torch: CUDA build from the official download.pytorch.org index (cu13x / cu12x by driver, downgrade on failure)"
Write-Host "[yue2-install]   model download: falls back to HF_ENDPOINT=https://hf-mirror.com when the HF direct link fails"
Write-Host "[yue2-install]   official requirements: Linux reference env / Python 3.10+ / 24GB NVIDIA GPU (this Windows port wants a 24G-class GPU)"
Write-Host "[yue2-install] ============================================================"
Write-Host "[yue2-install] install dir: $InstallDir"
Write-Progress-Line 2 ""

if (-not (Test-Path $InstallDir)) {
  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
}
$InstallDir = (Resolve-Path $InstallDir).Path
Set-Location $InstallDir

$PipIndex = "https://pypi.tuna.tsinghua.edu.cn/simple"
$PipHost = "pypi.tuna.tsinghua.edu.cn"
$PipIndexFallback = "https://mirrors.aliyun.com/pypi/simple/"
$env:HF_ENDPOINT = "https://hf-mirror.com"
$env:HF_HUB_DISABLE_XET = "1"

try {
  [Net.ServicePointManager]::SecurityProtocol =
    [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch {
  Write-Host "[yue2-install] note: could not force TLS1.2 ($($_.Exception.Message)); continuing with the download"
}

# ---------------------------------------------------------------- 1. probe NVIDIA
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

Write-Progress-Line 4 "probing NVIDIA GPU and driver..."
$gpu = Get-NvidiaInfo
if ($null -eq $gpu) {
  if (-not $Cpu) {
    Write-Host "[yue2-install] error: no NVIDIA GPU / nvidia-smi detected -- YuE2 officially requires a 24GB NVIDIA GPU with BF16,"
    Write-Host "[yue2-install]       an install without an NVIDIA GPU cannot possibly run. To really install the CPU build (debug only, one song may take hours) add -Cpu."
    Write-AgentResult "false" "no_cuda"
    exit 1
  }
  Write-Host "[yue2-install] warning: -Cpu was given, installing CPU torch (YuE2 on CPU is extremely slow, debug only)"
} else {
  Write-Host "[yue2-install] GPU: $($gpu.name) / driver $($gpu.driver) (major $($gpu.major)) / VRAM $($gpu.memMb)MB"
  if ($gpu.memMb -gt 0 -and $gpu.memMb -lt 20000) {
    Write-Host "[yue2-install] warning: VRAM $($gpu.memMb)MB < 20000MB -- the unquantized official build needs 24G (11~14GiB peak, leave headroom),"
    Write-Host "[yue2-install]       low VRAM may OOM; continuing the install, but generation may fail."
  }
}

# ---------------------------------------------------------------- 2. probe Python + venv
function Find-Python {
  # prefer the py launcher's 3.12 (task requirement), then fall back to other 3.1x / 3
  if (Get-Command py -ErrorAction SilentlyContinue) {
    foreach ($ver in @("3.12", "3.13", "3.11", "3.10", "3")) {
      try {
        & py "-$ver" -c "import sys; print(sys.version_info[:2])" 2>$null | Out-Null
        if ($LASTEXITCODE -eq 0) { return @{ exe = "py"; args = @("-$ver") } }
      } catch {}
    }
  }
  if (Get-Command python -ErrorAction SilentlyContinue) {
    try {
      & python -c "import sys; print(sys.version_info[:2])" 2>$null | Out-Null
      if ($LASTEXITCODE -eq 0) { return @{ exe = "python"; args = @() } }
    } catch {}
  }
  return $null
}

Write-Progress-Line 8 "probing Python..."
$pyInfo = Find-Python
if ($null -eq $pyInfo) {
  Write-Host "[yue2-install] error: no usable Python 3 found. Install Python 3.12 first (python.org or Microsoft Store),"
  Write-Host "[yue2-install]       make sure 'py -3.12' or 'python' runs from the command line, then re-run this script."
  Write-AgentResult "false" "python_not_found"
  throw "python_not_found"
}
Write-Host "[yue2-install] using Python: $($pyInfo.exe) $($pyInfo.args -join ' ')"
if (($pyInfo.args -join ' ') -notmatch "3\.12") {
  Write-Host "[yue2-install] note: Python 3.12 was not available (using $($pyInfo.args -join ' ')); YuE2 needs 3.10+ so it can run, but 3.12 is preferred."
}

Write-Progress-Line 12 "creating the venv (.venv, skipped when it already exists)..."
$venvPy = Join-Path $InstallDir ".venv\Scripts\python.exe"
if (-not (Test-Path $venvPy)) {
  if ($pyInfo.exe -eq "py") {
    & py @($pyInfo.args) -m venv .venv
  } else {
    & python -m venv .venv
  }
}
if (-not (Test-Path $venvPy)) {
  Write-AgentResult "false" "venv_creation_failed"
  throw "venv_creation_failed"
}

Write-Progress-Line 16 "upgrading pip..."
& $venvPy -m pip install --upgrade pip -i $PipIndex --trusted-host $PipHost | Out-Host
if ($LASTEXITCODE -ne 0) {
  Write-Host "[yue2-install] upgrading pip from the Tsinghua mirror failed, falling back to the Aliyun mirror..."
  & $venvPy -m pip install --upgrade pip -i $PipIndexFallback | Out-Host
}

# ---------------------------------------------------------------- 3. dependencies
$ReqFile = Join-Path $InstallDir "requirements.txt"
if (-not (Test-Path $ReqFile)) {
  $ReqFile = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path | Split-Path -Parent) "requirements.txt"
}
Write-Progress-Line 20 "installing Python dependencies (requirements.txt + gradio, Tsinghua mirror)..."
& $venvPy -m pip install --isolated -r $ReqFile gradio -i $PipIndex --trusted-host $PipHost | Out-Host
if ($LASTEXITCODE -ne 0) {
  Write-Host "[yue2-install] installing dependencies from the Tsinghua mirror failed, retrying on the Aliyun mirror..."
  & $venvPy -m pip install --isolated -r $ReqFile gradio -i $PipIndexFallback | Out-Host
  if ($LASTEXITCODE -ne 0) {
    Write-AgentResult "false" "requirements_install_failed"
    throw "requirements_install_failed"
  }
}

# gradio self-check: app/ui.py depends on it; without gradio the service fails at startup with "RuntimeError: Gradio not installed"
& $venvPy -c "import gradio; print('gradio', gradio.__version__)" | Out-Host
if ($LASTEXITCODE -ne 0) {
  Write-Host "[yue2-install] error: gradio is not properly installed (without gradio the service fails at startup with RuntimeError 'Gradio not installed')."
  Write-Host "[yue2-install]       reinstall gradio on its own: & `"$venvPy`" -m pip install --isolated gradio -i $PipIndex --trusted-host $PipHost"
  Write-Host "[yue2-install]       after reinstalling gradio just re-run this script; **do not re-download the model weights**."
  Write-AgentResult "false" "requirements_install_failed"
  throw "requirements_install_failed"
}

# ---------------------------------------------------------------- 4. torch (CUDA first)
$driverMajor = if ($gpu) { $gpu.major } else { 0 }
if ($TorchIndex) {
  $torchIndexes = @($TorchIndex)
} elseif ($Cpu) {
  $torchIndexes = @("https://download.pytorch.org/whl/cpu")
} elseif ($driverMajor -ge 580) {
  $torchIndexes = @("https://download.pytorch.org/whl/cu130", "https://download.pytorch.org/whl/cu128", "https://download.pytorch.org/whl/cu126")
} elseif ($driverMajor -ge 550) {
  $torchIndexes = @("https://download.pytorch.org/whl/cu128", "https://download.pytorch.org/whl/cu126")
} elseif ($driverMajor -ge 1) {
  $torchIndexes = @("https://download.pytorch.org/whl/cu126", "https://download.pytorch.org/whl/cu128")
} else {
  $torchIndexes = @("https://download.pytorch.org/whl/cu128", "https://download.pytorch.org/whl/cu126")
}

Write-Progress-Line 30 "installing torch / torchaudio (CUDA builds)..."
$torchOk = $false
foreach ($idx in $torchIndexes) {
  Write-Host "[yue2-install] torch index-url: $idx"
  & $venvPy -m pip install torch torchaudio --index-url $idx | Out-Host
  if ($LASTEXITCODE -eq 0) { $torchOk = $true; break }
  Write-Host "[yue2-install] this tier failed, retrying one tier down..."
}
if (-not $torchOk -and -not $Cpu -and -not $TorchIndex) {
  Write-Host "[yue2-install] every CUDA tier failed -- installing the CPU build as a last resort (the caller still treats this as no CUDA)..."
  & $venvPy -m pip install torch torchaudio --index-url https://download.pytorch.org/whl/cpu | Out-Host
  if ($LASTEXITCODE -eq 0) { $torchOk = $true }
}
if (-not $torchOk) {
  Write-AgentResult "false" "torch_install_failed"
  throw "torch_install_failed"
}

# ------------------------------------------- 4b. attention tier probe (required on Windows)
# Why probing is mandatory: on Windows torch often has the flash-attn schema but no matching kernel,
# yue2's default auto then picks flash and only the real generation reports at the Planning score stage:
#   USE_FLASH_ATTENTION was not enabled for build.
# So right after torch is installed the probe picks a genuinely usable tier (cudnn / sdpa), writes it
# to disk, and app\windows_patch.py reads and force-applies it when the service starts.
$AttentionBackendFile = Join-Path $InstallDir ".attention-backend"
$ProbeScript = Join-Path $InstallDir "scripts\probe_attention.py"
Write-Progress-Line 38 "probing the attention tier (flash / cudnn / sdpa)..."
$attentionBackend = ""
$probeNote = ""
if (-not (Test-Path $ProbeScript)) {
  $probeNote = "missing scripts\probe_attention.py"
  Write-Host "[yue2-install] warning: scripts\probe_attention.py is missing -- cannot probe the attention tier (restore that file from the scaffold and re-run this script)."
  Write-Host "[yue2-install]       without the probe yue2 auto may pick flash and the real generation will report at the Planning score stage"
  Write-Host "[yue2-install]       'USE_FLASH_ATTENTION was not enabled for build.'"
} else {
  $probeLog = Join-Path $env:TEMP ("mtnode-yue2-attn-" + [guid]::NewGuid().ToString("N") + ".log")
  $probeCode = 0
  $prevEap = $ErrorActionPreference
  try {
    # the probe's stderr is diagnostic output only; do not let it trigger Stop (this script runs with ErrorActionPreference=Stop)
    $ErrorActionPreference = "Continue"
    & $venvPy $ProbeScript 2>&1 | Tee-Object -FilePath $probeLog | Out-Host
    $probeCode = $LASTEXITCODE
  } catch {
    Write-Host "[yue2-install] the attention probe threw: $($_.Exception.Message)"
    $probeCode = 1
  } finally {
    $ErrorActionPreference = $prevEap
  }
  # tier source 1: the file the probe itself wrote, <INSTALL_DIR>\.attention-backend
  if (Test-Path $AttentionBackendFile) {
    $raw = Get-Content $AttentionBackendFile -ErrorAction SilentlyContinue | Where-Object { $_.Trim() } | Select-Object -First 1
    if ($raw) { $attentionBackend = ([string]$raw).Trim() }
  }
  # tier source 2: parse backend=<tier> / backend: <tier> out of the probe output
  if (-not $attentionBackend -and (Test-Path $probeLog)) {
    $hit = Select-String -Path $probeLog -Pattern 'backend\s*[:=]\s*([A-Za-z0-9_]+)' -AllMatches | Select-Object -First 1
    if ($hit -and $hit.Matches.Count -gt 0) { $attentionBackend = $hit.Matches[0].Groups[1].Value.Trim() }
  }
  Remove-Item -Force $probeLog -ErrorAction SilentlyContinue

  $noBackend = (-not $attentionBackend) -or (@("unsupported", "none", "null", "false") -contains $attentionBackend.ToLower())
  if ($noBackend) {
    Write-Host "[yue2-install] error: no usable attention tier at all (flash / cudnn / sdpa are all unusable, probe exit code $probeCode)."
    Write-Host "[yue2-install]       fix 1 (recommended): install a cuDNN-capable CUDA torch -- for example"
    Write-Host "[yue2-install]         .\.venv\Scripts\python.exe -m pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu128"
    Write-Host "[yue2-install]         or reinstall with this script's -TorchIndex <matching cu1xx tier>, then re-run this script so the probe re-picks the tier;"
    Write-Host "[yue2-install]       fix 2: change the GPU -- the official requirement is a 24G-class NVIDIA GPU with flash / cuDNN attention"
    Write-Host "[yue2-install]         (old-architecture cards, integrated GPUs and CPU-only torch all yield no usable tier)."
    Write-Host "[yue2-install]       Do not install flash-attn (no Windows wheels), and do not re-download the model weights for this."
    Write-AgentResult "false" "attention_backend_unsupported"
    exit 1
  }
  Write-Host "[yue2-install] attention probe selected tier: $attentionBackend"
}

# Write to disk (rewrite the same content when the probe already wrote it, so one format wins); a failed write is only logged and never blocks the install
if ($attentionBackend) {
  try {
    Set-Content -Path $AttentionBackendFile -Value $attentionBackend -Encoding UTF8
    Write-Host "[yue2-install] attention tier written to: $AttentionBackendFile ($attentionBackend)"
  } catch {
    Write-Host "[yue2-install] warning: failed to write the attention tier ($($_.Exception.Message)); the install continues with $attentionBackend,"
    Write-Host "[yue2-install]       but without .attention-backend app\windows_patch.py can only probe again at runtime; fix the write permission and re-run this script."
  }
} elseif ($probeNote) {
  Write-Host "[yue2-install] note: .attention-backend was not written ($probeNote) -- restore scripts\probe_attention.py and re-run this script to fill it in."
}

# ---------------------------------------------------------------- 5. yue2 inference package (official whl -> official repo)
$WhlLocal = Join-Path $InstallDir $InferWhlName
if ($SkipInfer) {
  Write-Progress-Line 50 "skipping the yue2 inference package install (-SkipInfer)"
} else {
  Write-Progress-Line 42 "installing the yue2 inference package ($InferWhlName / official repo fallback)..."
  if ($WhlPath -and (Test-Path $WhlPath)) {
    Copy-Item -Force $WhlPath $WhlLocal
    Write-Host "[yue2-install] using the existing whl: $WhlPath"
  } elseif (-not (Test-Path $WhlLocal)) {
    $pyWhl = @'
import os, sys
from pathlib import Path

repo, name, dest = sys.argv[1], sys.argv[2], sys.argv[3]
os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
try:
    from huggingface_hub import hf_hub_download
    p = hf_hub_download(repo_id=repo, filename=name, local_dir=dest)
    out = Path(dest) / name
    if Path(p) != out:
        out.write_bytes(Path(p).read_bytes())
    print(f"[yue2-install] hf_hub_download done: {out}")
    sys.exit(0)
except Exception as e:
    print(f"[yue2-install] hf_hub_download failed: {str(e)[:300]}")
sys.exit(3)
'@
    $whlScript = Join-Path $env:TEMP ("mtnode-yue2-whl-" + [guid]::NewGuid().ToString("N") + ".py")
    Set-Content -Path $whlScript -Value $pyWhl -Encoding UTF8
    try {
      & $venvPy $whlScript $ModelRepo $InferWhlName $InstallDir | Out-Host
    } finally {
      Remove-Item -Force $whlScript -ErrorAction SilentlyContinue
    }
    if (-not (Test-Path $WhlLocal)) {
      # direct-link fallback: hf-mirror / official HF resolve paths
      foreach ($url in @(
        "$env:HF_ENDPOINT/$ModelRepo/resolve/main/$InferWhlName",
        "https://huggingface.co/$ModelRepo/resolve/main/$InferWhlName"
      )) {
        if (Test-Path $WhlLocal) { break }
        try {
          Write-Host "[yue2-install] downloading the whl from a direct link: $url"
          $oldProgress = $ProgressPreference
          $ProgressPreference = "SilentlyContinue"
          try {
            Invoke-WebRequest -Uri $url -OutFile $WhlLocal -UseBasicParsing -TimeoutSec 300 `
              -Headers @{ "User-Agent" = "MTNode-YuE2-Installer" }
          } finally {
            $ProgressPreference = $oldProgress
          }
          if ((Test-Path $WhlLocal) -and ((Get-Item $WhlLocal).Length -lt 4096)) {
            Remove-Item -Force $WhlLocal -ErrorAction SilentlyContinue
          }
        } catch {
          Write-Host "[yue2-install] direct link failed: $($_.Exception.Message)"
        }
      }
    }
  } else {
    Write-Host "[yue2-install] whl already present, skipping the download: $WhlLocal"
  }

  $inferOk = $false
  if (Test-Path $WhlLocal) {
    & $venvPy -m pip install $WhlLocal | Out-Host
    if ($LASTEXITCODE -eq 0) { $inferOk = $true }
  }
  if (-not $inferOk) {
    Write-Host "[yue2-install] the official whl is unusable, falling back to the official repo (direct -> ghproxy mirror)..."
    foreach ($gitUrl in @(
      "git+https://github.com/multimodal-art-projection/YuE.git",
      "git+https://ghproxy.com/https://github.com/multimodal-art-projection/YuE.git",
      "git+https://ghfast.top/https://github.com/multimodal-art-projection/YuE.git"
    )) {
      if ($inferOk) { break }
      Write-Host "[yue2-install] pip install $gitUrl"
      & $venvPy -m pip install $gitUrl | Out-Host
      if ($LASTEXITCODE -eq 0) { $inferOk = $true }
    }
  }
  if (-not $inferOk) {
    Write-Host "[yue2-install] error: the yue2 inference package could not be installed (both the whl and the official repo failed)."
    Write-AgentResult "false" "infer_install_failed"
    throw "infer_install_failed"
  }
  & $venvPy -c "import yue2; print('[yue2-install] yue2 package imported:', getattr(yue2, '__version__', 'unknown'))" | Out-Host
  if ($LASTEXITCODE -ne 0) {
    Write-Host "[yue2-install] warning: the yue2 package is installed but fails to import (see the error above; likely a missing dependency, re-running this script will add it)"
  }
}

# ---------------------------------------------------------------- 6. models
$ModelsDir = Join-Path $InstallDir "models"
New-Item -ItemType Directory -Force -Path $ModelsDir | Out-Null
$ModelDirFlat = Join-Path $ModelsDir "m-a-p__YuE2-3B"
$VaeDirFlat = Join-Path $ModelsDir "m-a-p__YuE2-Vae"

function Link-Or-Copy([string]$Src, [string]$Dest, [string]$Label) {
  if (Test-Path $Dest) {
    $item = Get-Item $Dest -Force
    if ($item.LinkType -or $item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
      Write-Host "[yue2-install] $Label junction already exists, skipping: $Dest"
      return
    }
    Write-Host "[yue2-install] $Label directory already exists, skipping: $Dest"
    return
  }
  try {
    New-Item -ItemType Junction -Path $Dest -Target $Src -ErrorAction Stop | Out-Null
    Write-Host "[yue2-install] junction created: $Dest -> $Src"
  } catch {
    Write-Host "[yue2-install] junction failed, copying instead: $($_.Exception.Message)"
    Copy-Item -Recurse -Force $Src $Dest
  }
}

if ($SkipModels) {
  Write-Progress-Line 80 "skipping the model download (-SkipModels)"
} else {
  Write-Progress-Line 58 "preparing the models (YuE2-3B + YuE2-Vae)..."
  if ($ModelDir -and (Test-Path $ModelDir)) { Link-Or-Copy $ModelDir $ModelDirFlat "YuE2-3B" }
  if ($VaeDir -and (Test-Path $VaeDir)) { Link-Or-Copy $VaeDir $VaeDirFlat "YuE2-Vae" }

  $needDl = (-not (Test-Path (Join-Path $ModelDirFlat "model.safetensors"))) -or (-not (Test-Path (Join-Path $VaeDirFlat "model.safetensors")))
  if (-not $needDl) {
    Write-Progress-Line 78 "models already in place, skipping the download"
  } else {
    Write-Progress-Line 62 "downloading m-a-p/YuE2-3B (~7.3GB) and m-a-p/YuE2-Vae (~0.5GB)..."
    $pyDl = @'
import os, sys
from pathlib import Path

targets = [
    (sys.argv[1], sys.argv[2], {"assets/*", "*.md", "*.pdf", "*.svg", "*.png", "*.mp3"}),
    (sys.argv[3], sys.argv[4], {"assets/*", "*.md", "*.pdf", "*.svg", "*.png"}),
]

def ok(d):
    p = Path(d)
    return p.is_dir() and (p / "config.json").is_file() and (p / "model.safetensors").is_file()

failed = []
for repo, dest, ignore in targets:
    if ok(dest):
        print(f"[yue2-install] already present, skipping {repo}")
        continue
    done = False
    attempts = [
        ("HF_HUB", {}),
        ("hf-mirror", {"endpoint": "https://hf-mirror.com"}),
    ]
    for label, cfg in attempts:
        if done:
            break
        endpoint = cfg.get("endpoint")
        if endpoint:
            os.environ["HF_ENDPOINT"] = endpoint
        else:
            os.environ.pop("HF_ENDPOINT", None)
        try:
            from huggingface_hub import snapshot_download
            print(f"[yue2-install] {label} downloading {repo} -> {dest}")
            snapshot_download(repo_id=repo, local_dir=dest, ignore_patterns=list(ignore))
            done = ok(dest)
        except Exception as e:
            print(f"[yue2-install] {label} failed: {str(e)[:300]}")
    if not done:
        failed.append(repo)

if failed:
    print("[yue2-install] these models could not be downloaded: " + ", ".join(failed))
    sys.exit(3)
print("[yue2-install] model download complete")
'@
    $dlScript = Join-Path $env:TEMP ("mtnode-yue2-dl-" + [guid]::NewGuid().ToString("N") + ".py")
    Set-Content -Path $dlScript -Value $pyDl -Encoding UTF8
    try {
      & $venvPy $dlScript $ModelRepo $ModelDirFlat $VaeRepo $VaeDirFlat | Out-Host
      if ($LASTEXITCODE -ne 0) {
        Write-Host "[yue2-install] warning: the model download is incomplete (the service still starts, but /generate reports model_load_failed; re-run this script to resume)"
      }
    } finally {
      Remove-Item -Force $dlScript -ErrorAction SilentlyContinue
    }
  }
}

if ((Test-Path (Join-Path $ModelDirFlat "model.safetensors")) -and (Test-Path (Join-Path $VaeDirFlat "model.safetensors"))) {
  New-Item -ItemType File -Force -Path (Join-Path $ModelsDir ".ok") | Out-Null
  Write-Host "[yue2-install] models in place: YuE2-3B + YuE2-Vae"
} else {
  Write-Host "[yue2-install] note: the models are incomplete (models\.ok was not created); use -ModelDir / -VaeDir to point at existing directories and re-run"
}

# ---------------------------------------------------------------- 6b. project file manifest
# The Windows port patch app\windows_patch.py and app\engine.py must **coexist**: when only
# windows_patch.py exists, every sync round overwrites the attention downgrade logic and the real
# generation falls back to the flash tier and reports 'USE_FLASH_ATTENTION was not enabled for build.'
Write-Progress-Line 82 "verifying the project file manifest..."
$RequiredFiles = @(
  "app\__init__.py",
  "app\__main__.py",
  "app\server.py",
  "app\ui.py",
  "app\engine.py",
  "app\windows_patch.py",
  "scripts\install.ps1",
  "scripts\probe_attention.py",
  "requirements.txt",
  "manifest.json",
  "start_backend.cmd"
)
$MissingFiles = @()
foreach ($rel in $RequiredFiles) {
  if (-not (Test-Path (Join-Path $InstallDir $rel))) { $MissingFiles += $rel }
}
if ($MissingFiles.Count -gt 0) {
  Write-Host "[yue2-install] warning: project files missing: " + ($MissingFiles -join ", ")
  Write-Host "[yue2-install]       copy these two directories from the bundled scaffold (SCAFFOLD_REF / yue-pack) and re-run this script;"
  Write-Host "[yue2-install]       note in particular that app\windows_patch.py and app\engine.py must **coexist**,"
  Write-Host "[yue2-install]       otherwise every sync round overwrites the Windows attention patch and the real generation falls back to the flash tier."
} else {
  Write-Host "[yue2-install] project files complete (including app\windows_patch.py)"
}

# ---------------------------------------------------------------- 7. ui entry self-check
Write-Progress-Line 84 "checking that the ui.py entry imports (python -c \"import app.ui\")..."
$uiProbe = @'
import sys
try:
    import app.ui
except ModuleNotFoundError as e:
    print(f"[yue2-install] app.ui import failed: ModuleNotFoundError: {e.name}")
    sys.exit(2)
except Exception as e:
    print(f"[yue2-install] app.ui is not importable yet (not a missing module, may be deferred to runtime): {type(e).__name__}: {e}")
    sys.exit(0)
print("[yue2-install] app.ui entry imports OK")
sys.exit(0)
'@
$uiProbeFile = Join-Path $env:TEMP ("mtnode-yue2-ui-" + [guid]::NewGuid().ToString("N") + ".py")
Set-Content -Path $uiProbeFile -Value $uiProbe -Encoding UTF8
try {
  & $venvPy $uiProbeFile | Out-Host
  $uiCode = $LASTEXITCODE
} finally {
  Remove-Item -Force $uiProbeFile -ErrorAction SilentlyContinue
}
if ($uiCode -eq 2) {
  Write-Host "[yue2-install] error: the app\ui.py entry is missing or its dependencies are not installed (ModuleNotFoundError) -- copy missing files from the scaffold,"
  Write-Host "[yue2-install]       install missing dependencies from the Tsinghua mirror (gradio, see the self-check above), then re-run this script."
  Write-AgentResult "false" "ui_entry_import_failed"
  throw "ui_entry_import_failed"
}

# ---------------------------------------------------------------- 8. mock smoke
Write-Progress-Line 88 "mock smoke (MTNODE_YUE2_MOCK=1: start the service -> /health -> /generate writes the artifacts -> /progress -> shutdown)..."
$smoke = Join-Path $env:TEMP ("mtnode-yue2-smoke-" + [guid]::NewGuid().ToString("N") + ".py")
$smokePy = @'
import json, os, subprocess, sys, tempfile, time, urllib.request, uuid
from pathlib import Path

install_dir = Path(sys.argv[1])
port = int(sys.argv[2])
log_path = Path(tempfile.gettempdir()) / f"mtnode-yue2-smoke-{uuid.uuid4().hex}.log"
out_dir = Path(tempfile.gettempdir()) / f"mtnode-yue2-out-{uuid.uuid4().hex}"

env = dict(os.environ)
env["MTNODE_YUE2_MOCK"] = "1"
env["YUE2_PORT"] = str(port)
env["PYTHONIOENCODING"] = "utf-8"
proc = subprocess.Popen([sys.executable, "-m", "app", str(port)], cwd=str(install_dir), env=env,
                        stdout=open(log_path, "w", encoding="utf-8", errors="replace"),
                        stderr=subprocess.STDOUT)
code = 0
try:
    base = f"http://127.0.0.1:{port}"
    health = None
    for _ in range(80):
        if proc.poll() is not None:
            break
        try:
            with urllib.request.urlopen(base + "/health", timeout=2) as r:
                health = json.loads(r.read().decode("utf-8"))
            break
        except Exception:
            time.sleep(0.5)
    if not health:
        print("[yue2-install] smoke failed: /health did not respond")
        code = 4
    else:
        print("[yue2-install] /health -> " + json.dumps(health, ensure_ascii=False))
        if health.get("mock") is not True or health.get("model") != "m-a-p/YuE2-3B" or health.get("service") != "mtnode-yue2":
            print("[yue2-install] smoke failed: /health fields do not match the contract")
            code = 5
        body = {
            "style": "smoke test, lofi hip hop, warm piano",
            "lyrics": "[verse]\nsmoke test lyrics\n[chorus]\nsmoke test chorus",
            "cot": "full",
            "seed": 123456,
            "outputDir": str(out_dir),
        }
        req = urllib.request.Request(base + "/generate", data=json.dumps(body).encode("utf-8"),
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=120) as r:
            gen = json.loads(r.read().decode("utf-8"))
        print("[yue2-install] mock generate -> " + json.dumps({k: gen.get(k) for k in
              ("ok", "audioPath", "outputDir", "cot", "seed", "mock", "scoreAbc")}, ensure_ascii=False))
        if gen.get("ok") is not True or gen.get("mock") is not True:
            print("[yue2-install] smoke failed: the /generate response does not match the contract")
            code = 6
        elif not gen.get("audioPath") or not Path(gen["audioPath"]).is_file():
            print("[yue2-install] smoke failed: audio.flac was not written to disk")
            code = 7
        elif not gen.get("scoreAbc") or not Path(gen["scoreAbc"]).is_file():
            print("[yue2-install] smoke failed: score.abc was not written to disk")
            code = 8
        elif not gen.get("artifacts"):
            print("[yue2-install] smoke failed: artifacts is empty")
            code = 9
        with urllib.request.urlopen(base + "/progress", timeout=10) as r:
            prog = json.loads(r.read().decode("utf-8"))
        print("[yue2-install] /progress -> " + json.dumps({k: prog.get(k) for k in
              ("stage", "percent", "running", "done", "seed")}, ensure_ascii=False))
        if prog.get("stage") != "done" or prog.get("done") is not True:
            print("[yue2-install] smoke failed: /progress never returned to done")
            code = 10
        try:
            urllib.request.urlopen(urllib.request.Request(base + "/shutdown", data=b"{}",
                                                          headers={"Content-Type": "application/json"}), timeout=10).read()
        except Exception:
            pass
finally:
    for _ in range(20):
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
            tail = log_path.read_text(encoding="utf-8", errors="replace").strip().splitlines()[-20:]
            for line in tail:
                print("[yue2-install] log | " + line)
            log_path.unlink()
    except Exception:
        pass
    try:
        import shutil
        shutil.rmtree(out_dir, ignore_errors=True)
    except Exception:
        pass

if code == 0:
    print("[yue2-install] mock smoke passed (see [yue2] ready in the log tail above)")
else:
    print("[yue2-install] mock smoke did not pass, exit code " + str(code))
sys.exit(code)
'@
Set-Content -Path $smoke -Value $smokePy -Encoding UTF8
$smokePort = 8773
if ($env:YUE2_PORT) {
  try { $smokePort = [int]$env:YUE2_PORT } catch { $smokePort = 8773 }
}
try {
  & $venvPy $smoke $InstallDir $smokePort | Out-Host
  if ($LASTEXITCODE -ne 0) { Write-Host "[yue2-install] warning: the mock smoke did not pass (see the log above); the install marker is still written" }
} finally {
  Remove-Item -Force $smoke -ErrorAction SilentlyContinue
}

# ---------------------------------------------------------------- 9. markers
Write-Progress-Line 96 "writing the install markers..."
New-Item -ItemType File -Force -Path (Join-Path $InstallDir ".install-ok") | Out-Null
Write-AgentResult "true" ""

Write-Progress-Line 100 "done"
Write-Host "[yue2-install] complete:"
Write-Host "[yue2-install]   venv        : $venvPy"
Write-Host "[yue2-install]   yue2 whl    : $WhlLocal"
Write-Host "[yue2-install]   models      : $ModelsDir"
Write-Host "[yue2-install]   install flag: $(Join-Path $InstallDir '.install-ok')"
Write-Host "[yue2-install]   start (owned by MTNode, do not keep resident): .venv\Scripts\python.exe -m app 8773"
exit 0
