# =============================================================================
# MOSS-Music local backend -- step-by-step install orchestration
#
# What gets installed into <InstallDir>:
#   .venv\                          isolated Python 3.12 (uv), CUDA torch 2.9.1+cu128
#   source\MOSS-Music\              official inference repo (zip download, NO git)
#   models\MOSS-Music-8B-Instruct\  official weights (ModelScope first, hf-mirror fallback)
#   tools\ffmpeg\ffmpeg.exe         portable ffmpeg (audio decode / long-song slicing)
#   .env                            runtime defaults read by app\server.py
#
# Step ids match steps.json in the same directory:
#   disk / python / torch / deps / source / weights / files / env / smoke
# Step protocol lives in scripts/step.ps1.
#
# The script is re-runnable: an existing repo / weight shard / venv is reused, weight
# downloads resume, and every step reports its own stable failure code. The localized
# reason and advice for each code live in steps.json `messages` (this script stays pure
# ASCII -- see the HARD RULE in step.ps1).
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -InstallDir "D:\mtnode\moss-music"
# =============================================================================
param(
  [string]$InstallDir = (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)),
  [int]$DiskHintGb = 60,
  [switch]$ForceSource,
  [switch]$SkipWeights
)

try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
$OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$env:PYTHONIOENCODING = 'utf-8'
$ErrorActionPreference = "Stop"
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch { }

$stepLib = Join-Path $PSScriptRoot "step.ps1"
if (Test-Path -LiteralPath $stepLib) { . $stepLib }
else {
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

function New-FailCode {
  param([string]$Code, [hashtable]$Params, [string]$Message)
  $o = [ordered]@{ code = $Code }
  if ($Params -and $Params.Count) { $o.params = $Params }
  $o.message = $Message
  return $o
}

function Say {
  param([string]$Text)
  Write-Host "[moss-music-install] $Text"
}

# Run a native command with its stderr folded into the install log.
# Windows PowerShell 5.1 turns a native stderr line into an ErrorRecord; with
# $ErrorActionPreference = "Stop" (above) even `uv python install` reporting
# "already installed" / a progress line would abort the step. We keep the
# preference local to this call and let the caller judge the real exit code.
function Invoke-Logged {
  param([scriptblock]$Command)
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    & $Command 2>&1 | ForEach-Object {
      if ($_ -is [System.Management.Automation.ErrorRecord]) { Say "  $($_.Exception.Message)" }
      else { Say "  $_" }
    }
    return $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $prevEap
  }
}

function Download-File {
  param([string[]]$Urls, [string]$Dest, [int]$TimeoutSec = 900)
  foreach ($u in $Urls) {
    if (-not $u) { continue }
    try {
      Say "downloading $u"
      Invoke-WebRequest -Uri $u -OutFile $Dest -UseBasicParsing -TimeoutSec $TimeoutSec
      if ((Test-Path -LiteralPath $Dest) -and ((Get-Item -LiteralPath $Dest).Length -gt 0)) { return $true }
    } catch {
      Say "  failed: $($_.Exception.Message)"
    }
  }
  return $false
}

$VenvPy   = Join-Path $InstallDir ".venv\Scripts\python.exe"
$SourceDir = Join-Path $InstallDir "source\MOSS-Music"
$ModelsDir = Join-Path $InstallDir "models"
$ToolsDir  = Join-Path $InstallDir "tools"
$FfmpegExe = Join-Path $ToolsDir "ffmpeg\ffmpeg.exe"

New-Item -ItemType Directory -Force -Path $InstallDir, $ModelsDir, $ToolsDir | Out-Null
Say "install dir: $InstallDir"

$env:HF_ENDPOINT = if ($env:HF_ENDPOINT) { $env:HF_ENDPOINT } else { "https://hf-mirror.com" }
$env:HF_HUB_DISABLE_XET = "1"
$PipIndexes = @(
  "https://pypi.tuna.tsinghua.edu.cn/simple",
  "https://mirrors.aliyun.com/pypi/simple",
  "https://mirrors.ustc.edu.cn/pypi/simple",
  "https://pypi.org/simple"
)

# -- 1. disk ------------------------------------------------------------------
Step-Begin "disk" "" 2 "reserve at least ${DiskHintGb}GB"
try {
  $probeDir = $InstallDir
  while (-not (Test-Path -LiteralPath $probeDir)) { $probeDir = Split-Path -Parent $probeDir }
  $drive = (Get-Item -LiteralPath $probeDir).PSDrive
  $freeGb = [math]::Round((Get-PSDrive $drive.Name).Free / 1GB, 1)
  Say "disk free ~${freeGb}GB (hint >= ${DiskHintGb}GB)"
  if ($freeGb -lt $DiskHintGb) {
    Step-Fail "disk" (New-FailCode "moss.disk.low_space" @{ free = "$freeGb"; want = "$DiskHintGb" } "disk free ${freeGb}GB is below the suggested ${DiskHintGb}GB")
    exit 1
  }
  Step-Ok "disk" 4
} catch {
  Step-Fail "disk" (New-FailCode "moss.disk.unreadable" @{ err = "$($_.Exception.Message)" } "cannot read the free space of the install drive: $($_.Exception.Message)")
  exit 1
}

# -- 2. Python 3.12 + venv (uv) ----------------------------------------------
Step-Begin "python" "" 6
try {
  $uv = ""
  $cmd = Get-Command uv -ErrorAction SilentlyContinue
  if ($cmd -and $cmd.Source) { $uv = $cmd.Source }
  foreach ($cand in @((Join-Path $ToolsDir "uv\uv.exe"), (Join-Path $env:LOCALAPPDATA "uv\uv.exe"))) {
    if (-not $uv -and (Test-Path -LiteralPath $cand)) { $uv = $cand }
  }
  if (-not $uv) {
    $uvDir = Join-Path $ToolsDir "uv"
    New-Item -ItemType Directory -Force -Path $uvDir | Out-Null
    $zip = Join-Path $uvDir "uv.zip"
    $uvUrls = @(
      "https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-pc-windows-msvc.zip",
      "https://gh-proxy.com/https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-pc-windows-msvc.zip",
      "https://ghfast.top/https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-pc-windows-msvc.zip",
      "https://ghproxy.net/https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-pc-windows-msvc.zip"
    )
    if (-not (Download-File $uvUrls $zip 600)) {
      throw "uv download failed (github + three gh proxies all failed); install uv yourself (winget install astral-sh.uv) and re-run"
    }
    Expand-Archive -LiteralPath $zip -DestinationPath $uvDir -Force
    Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
    $found = Get-ChildItem -LiteralPath $uvDir -Recurse -Filter "uv.exe" -File | Select-Object -First 1
    if (-not $found) { throw "uv.exe is missing from the downloaded archive" }
    $uv = $found.FullName
  }
  Say "uv: $uv"
  $env:UV_PYTHON_INSTALL_MIRROR = if ($env:UV_PYTHON_INSTALL_MIRROR) { $env:UV_PYTHON_INSTALL_MIRROR } else { "https://registry.npmmirror.com/-/binary/python-build-standalone/" }
  $env:UV_CACHE_DIR = Join-Path $ToolsDir "uv-cache"
  $env:UV_HTTP_TIMEOUT = "120"
  # --no-bin: do not touch / overwrite an existing shim in the user's uv bin dir
  # (uv exits 1 on that collision even though the interpreter itself installed fine).
  $uvRc = Invoke-Logged { & $uv python install 3.12 --no-bin }
  if ($uvRc -ne 0) { throw "uv python install 3.12 failed (exit $uvRc)" }
  if (-not (Test-Path -LiteralPath $VenvPy)) {
    $venvRc = Invoke-Logged { & $uv venv --seed --python 3.12 (Join-Path $InstallDir ".venv") }
    if ($venvRc -ne 0) { throw "uv venv failed (exit $venvRc)" }
  }
  if (-not (Test-Path -LiteralPath $VenvPy)) { throw "the venv was not created ($VenvPy is missing)" }
  & $VenvPy -c "import sys;print('python', sys.version.split()[0])" 2>&1 | ForEach-Object { Say "  $_" }
  Step-Ok "python" 16
} catch {
  Step-Fail "python" (New-FailCode "moss.python.failed" @{ tail = "$($_.Exception.Message)" } "$($_.Exception.Message)")
  exit 1
}

# -- 3. CUDA torch ------------------------------------------------------------
Step-Begin "torch" "" 18
try {
  $torchOk = $false
  $torchErr = ""
  $torchIndexes = @(
    "https://mirror.sjtu.edu.cn/pytorch-wheels/cu128",
    "https://mirrors.aliyun.com/pytorch-wheels/cu128",
    "https://download.pytorch.org/whl/cu128"
  )
  foreach ($idx in $torchIndexes) {
    Say "torch from $idx"
    $torchRc = Invoke-Logged { & $VenvPy -m pip install --no-cache-dir --index-url $idx "torch==2.9.1+cu128" "torchaudio==2.9.1+cu128" }
    if ($torchRc -eq 0) { $torchOk = $true; break }
    $torchErr = "pip exit $torchRc from $idx"
  }
  if (-not $torchOk) { throw "torch install failed on every index (SJTU / aliyun / official): $torchErr" }
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try { $probe = & $VenvPy -c "import torch;print('torch', torch.__version__, 'cuda', torch.cuda.is_available(), torch.version.cuda)" 2>&1 }
  finally { $ErrorActionPreference = $prevEap }
  foreach ($l in @($probe)) { Say "  $l" }
  if ("$probe" -match 'cuda\s+True') { Step-Ok "torch" 40 }
  else {
    Step-Fail "torch" (New-FailCode "moss.torch.cuda_unavailable" @{ probe = "$probe" } "torch is importable but cuda.is_available() is false")
    exit 1
  }
} catch {
  Step-Fail "torch" (New-FailCode "moss.torch.install_failed" @{ tail = "$($_.Exception.Message)" } "$($_.Exception.Message)")
  exit 1
}

# -- 4. inference dependencies ------------------------------------------------
Step-Begin "deps" "" 42
try {
  $packages = @(
    "transformers==4.57.1",
    "accelerate",
    "torchcodec==0.9.*",
    "safetensors>=0.4.0",
    "numpy>=2.0",
    "soundfile>=0.12.0",
    "tiktoken>=0.12.0",
    "einops>=0.8.0",
    "scipy>=1.12.0",
    "tqdm>=4.60.0",
    "packaging",
    "requests",
    "huggingface_hub",
    "modelscope",
    "bitsandbytes"
  )
  $depsOk = $false
  $depsErr = ""
  foreach ($idx in $PipIndexes) {
    Say "dependencies from $idx"
    $depsRc = Invoke-Logged { & $VenvPy -m pip install --no-cache-dir -i $idx @packages }
    if ($depsRc -eq 0) { $depsOk = $true; break }
    $depsErr = "pip exit $depsRc from $idx"
  }
  if (-not $depsOk) { throw "dependency install failed on every index (tsinghua / aliyun / ustc / pypi): $depsErr" }
  Step-Ok "deps" 56
} catch {
  Step-Fail "deps" (New-FailCode "moss.deps.pip_failed" @{ tail = "$($_.Exception.Message)" } "$($_.Exception.Message)")
  exit 1
}

# -- 5. official inference repo (zip, no git) --------------------------------
Step-Begin "source" "" 58
try {
  $srcOk = (Test-Path -LiteralPath (Join-Path $SourceDir "src\hf_inference.py"))
  if ($srcOk -and -not $ForceSource) {
    Say "official repo already present: $SourceDir"
  } else {
    $zip = Join-Path $env:TEMP ("moss-music-" + [guid]::NewGuid().ToString("N") + ".zip")
    $srcUrls = @(
      "https://codeload.github.com/OpenMOSS/MOSS-Music/zip/refs/heads/main",
      "https://gh-proxy.com/https://codeload.github.com/OpenMOSS/MOSS-Music/zip/refs/heads/main",
      "https://ghfast.top/https://codeload.github.com/OpenMOSS/MOSS-Music/zip/refs/heads/main",
      "https://ghproxy.net/https://codeload.github.com/OpenMOSS/MOSS-Music/zip/refs/heads/main"
    )
    if (-not (Download-File $srcUrls $zip 600)) { throw "official repo zip download failed (codeload + three gh proxies all failed)" }
    $ex = Join-Path $env:TEMP ("moss-music-x-" + [guid]::NewGuid().ToString("N"))
    Expand-Archive -LiteralPath $zip -DestinationPath $ex -Force
    Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
    $inner = Get-ChildItem -LiteralPath $ex -Directory | Select-Object -First 1
    if (-not $inner) { throw "the downloaded zip holds no directory" }
    if (-not (Test-Path -LiteralPath (Join-Path $inner.FullName "src\hf_inference.py"))) {
      throw "the downloaded repo has no src\hf_inference.py (unexpected archive layout)"
    }
    if (Test-Path -LiteralPath $SourceDir) { Remove-Item -LiteralPath $SourceDir -Recurse -Force }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $SourceDir) | Out-Null
    Move-Item -LiteralPath $inner.FullName -Destination $SourceDir
    Remove-Item -LiteralPath $ex -Recurse -Force -ErrorAction SilentlyContinue
    Say "official repo ready: $SourceDir"
  }
  Step-Ok "source" 64
} catch {
  Step-Fail "source" (New-FailCode "moss.source.download_failed" @{ tail = "$($_.Exception.Message)" } "$($_.Exception.Message)")
  exit 1
}

# -- 6. weights (the 8B Instruct model) --------------------------------------
Step-Begin "weights" "" 66
try {
  if ($SkipWeights) {
    Step-Skip "weights" "skipped by -SkipWeights"
  } else {
    $dlScript = Join-Path $env:TEMP ("moss-dl-" + [guid]::NewGuid().ToString("N") + ".py")
    $dl = @'
import os
import sys

os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
os.environ["HF_HUB_DISABLE_XET"] = "1"

TARGETS = [
    (["openmoss/MOSS-Music-8B-Instruct", "OpenMOSS-Team/MOSS-Music-8B-Instruct"],
     "OpenMOSS-Team/MOSS-Music-8B-Instruct", "MOSS-Music-8B-Instruct"),
]
ROOT = sys.argv[1]


def done(dest):
    if not os.path.isdir(dest):
        return False
    total = 0
    for base, _dirs, files in os.walk(dest):
        for f in files:
            if f.endswith(".safetensors") or f.endswith(".bin"):
                total += os.path.getsize(os.path.join(base, f))
    return total > 1024 * 1024 * 1024


for ms_ids, hf_id, name in TARGETS:
    dest = os.path.join(ROOT, name)
    if done(dest):
        print("[weights] %s already present" % name, flush=True)
        continue
    ok = False
    for ms_id in ms_ids:
        try:
            from modelscope import snapshot_download as ms_download
            print("[weights] ModelScope %s -> %s" % (ms_id, dest), flush=True)
            ms_download(ms_id, local_dir=dest)
            ok = done(dest)
            if ok:
                break
            print("[weights] ModelScope returned but the files look incomplete", flush=True)
        except Exception as exc:
            print("[weights] ModelScope %s failed: %s" % (ms_id, exc), flush=True)
    if ok:
        continue
    try:
        from huggingface_hub import snapshot_download as hf_download
        print("[weights] hf-mirror %s -> %s" % (hf_id, dest), flush=True)
        hf_download(repo_id=hf_id, local_dir=dest, max_workers=4)
        ok = done(dest)
    except Exception as exc:
        print("[weights] hf-mirror failed: %s" % exc, flush=True)
    if not ok:
        print("[weights] FAILED %s" % name, flush=True)
        sys.exit(2)
print("[weights] all weights ready", flush=True)
'@
    Set-Content -LiteralPath $dlScript -Value $dl -Encoding ASCII
    $rc = Invoke-Logged { & $VenvPy $dlScript $ModelsDir }
    Remove-Item -LiteralPath $dlScript -Force -ErrorAction SilentlyContinue
    if ($rc -ne 0) { throw "weight download failed (exit $rc); finished shards are reused on re-run" }
    Step-Ok "weights" 90
  }
} catch {
  Step-Fail "weights" (New-FailCode "moss.weights.download_failed" @{ err = "$($_.Exception.Message)" } "$($_.Exception.Message)")
  exit 1
}

# -- 7. verify files ----------------------------------------------------------
Step-Begin "files" "" 91
try {
  $missing = @()
  foreach ($m in @("MOSS-Music-8B-Instruct")) {
    $d = Join-Path $ModelsDir $m
    $cfg = Join-Path $d "config.json"
    if (-not (Test-Path -LiteralPath $cfg)) { $missing += "$m\config.json"; continue }
    $bytes = (Get-ChildItem -LiteralPath $d -Recurse -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
    $gb = [math]::Round($bytes / 1GB, 2)
    Say "$m ~${gb}GB"
    if ($bytes -lt 1GB) { $missing += "$m (weights under 1GB)" }
  }
  if (-not (Test-Path -LiteralPath (Join-Path $SourceDir "src\hf_inference.py"))) { $missing += "source\MOSS-Music\src\hf_inference.py" }
  if ($missing.Count) { throw ("missing: " + ($missing -join ", ")) }
  Step-Ok "files" 94
} catch {
  Step-Fail "files" (New-FailCode "moss.files.incomplete" @{ err = "$($_.Exception.Message)" } "$($_.Exception.Message)")
  exit 1
}

# -- 8. portable ffmpeg -------------------------------------------------------
Step-Begin "ffmpeg" "" 95
try {
  if (Test-Path -LiteralPath $FfmpegExe) {
    Say "ffmpeg already present: $FfmpegExe"
    Step-Ok "ffmpeg" 96
  } else {
    $ffDir = Split-Path -Parent $FfmpegExe
    New-Item -ItemType Directory -Force -Path $ffDir | Out-Null
    $zip = Join-Path $env:TEMP ("ffmpeg-" + [guid]::NewGuid().ToString("N") + ".zip")
    $ffUrls = @(
      "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip",
      "https://ghfast.top/https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip",
      "https://gh-proxy.com/https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip",
      "https://ghproxy.net/https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip"
    )
    if (-not (Download-File $ffUrls $zip 900)) {
      throw "portable ffmpeg download failed (gyan.dev + three gh proxies); drop ffmpeg.exe into $ffDir by hand and re-run"
    }
    $ex = Join-Path $env:TEMP ("ffmpeg-x-" + [guid]::NewGuid().ToString("N"))
    Expand-Archive -LiteralPath $zip -DestinationPath $ex -Force
    Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
    $found = Get-ChildItem -LiteralPath $ex -Recurse -Filter "ffmpeg.exe" -File | Select-Object -First 1
    if (-not $found) { throw "ffmpeg.exe is missing from the downloaded archive" }
    Copy-Item -LiteralPath $found.FullName -Destination $FfmpegExe -Force
    $ffprobe = Get-ChildItem -LiteralPath $ex -Recurse -Filter "ffprobe.exe" -File | Select-Object -First 1
    if ($ffprobe) { Copy-Item -LiteralPath $ffprobe.FullName -Destination (Join-Path $ffDir "ffprobe.exe") -Force }
    Remove-Item -LiteralPath $ex -Recurse -Force -ErrorAction SilentlyContinue
    Say "ffmpeg ready: $FfmpegExe"
    Step-Ok "ffmpeg" 96
  }
} catch {
  # ffmpeg only matters for slicing / decode; the backend reports it per request, so the
  # install continues with a warning instead of failing the whole chain.
  Say "WARN: $($_.Exception.Message)"
  Step-Skip "ffmpeg" "$($_.Exception.Message)"
}

# -- 9. .env ------------------------------------------------------------------
Step-Begin "env" "" 97
try {
  $envText = @(
    "# MOSS-Music runtime defaults (written by scripts/install.ps1; app\server.py reads it)",
    "MOSS_MUSIC_PORT=8790",
    "MOSS_MUSIC_MODEL=instruct",
    "MOSS_MUSIC_QUANT=int8",
    "MOSS_MUSIC_SOURCE=$SourceDir",
    "MOSS_MUSIC_MODELS=$ModelsDir",
    "MOSS_MUSIC_FFMPEG=$FfmpegExe",
    "HF_ENDPOINT=https://hf-mirror.com",
    "HF_HUB_DISABLE_XET=1",
    "PYTHONIOENCODING=utf-8"
  ) -join "`r`n"
  Set-Content -LiteralPath (Join-Path $InstallDir ".env") -Value ($envText + "`r`n") -Encoding ASCII
  Step-Ok "env" 98
} catch {
  Step-Fail "env" (New-FailCode "moss.env.write_failed" @{ err = "$($_.Exception.Message)" } "$($_.Exception.Message)")
  exit 1
}

# -- 10. smoke (imports + repo wiring; no weight load) ------------------------
Step-Begin "smoke" "" 99
try {
  Remove-Item -LiteralPath (Join-Path $InstallDir ".install-ok") -Force -ErrorAction SilentlyContinue
  $smoke = @"
import sys
sys.path.insert(0, r'$SourceDir')
import torch, transformers
from src.hf_inference import MossMusicHFInference
print('torch', torch.__version__, 'cuda', torch.cuda.is_available())
print('transformers', transformers.__version__)
print('moss repo import ok')
if not torch.cuda.is_available():
    sys.exit(3)
"@
  $smokeFile = Join-Path $env:TEMP ("moss-smoke-" + [guid]::NewGuid().ToString("N") + ".py")
  # UTF8, not ASCII: the install path itself may hold non-ASCII characters and the path is
  # embedded in this generated probe (Python reads UTF-8 source, BOM is fine).
  Set-Content -LiteralPath $smokeFile -Value $smoke -Encoding UTF8
  $rc = Invoke-Logged { & $VenvPy $smokeFile }
  Remove-Item -LiteralPath $smokeFile -Force -ErrorAction SilentlyContinue
  if ($rc -eq 3) {
    Step-Fail "smoke" (New-FailCode "moss.smoke.cuda_unavailable" @{ probe = "cuda False" } "the venv cannot see CUDA")
    exit 1
  }
  if ($rc -ne 0) { throw "smoke import failed (exit $rc)" }
  New-Item -ItemType File -Force -Path (Join-Path $InstallDir ".install-ok") | Out-Null
  Step-Ok "smoke" 100
} catch {
  Step-Fail "smoke" (New-FailCode "moss.smoke.import_failed" @{ err = "$($_.Exception.Message)" } "$($_.Exception.Message)")
  exit 1
}

Say "done"
exit 0
