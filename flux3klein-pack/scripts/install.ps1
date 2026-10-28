# =============================================================================
# FLUX 3 Image Klein local backend installer (ComfyUI + official INT8/BF16 weights).
#
# Produces:
#   <InstallDir>\ComfyUI                     isolated ComfyUI checkout
#   <InstallDir>\ComfyUI\venv                isolated Python (CUDA torch)
#   <InstallDir>\ComfyUI\models\...          flux3-image-klein-int8-convrot /
#                                            flux3-image-klein-bf16 + qwen3vl_4b encoders
#                                            + flux2-vae
#
# Weights: ModelScope first, then hf-mirror.com (official repo, gated => token needed),
# then the ungated byte-identical mirror ml-resources/flux-3-image-klein-comfy.
# A pre-downloaded folder can be supplied with -WeightsDir (files are copied, not re-downloaded).
#
# HARD RULE -- PURE ASCII, NO BOM. Windows PowerShell 5.1 decodes a BOM-less .ps1 with the
# machine ANSI code page; non-ASCII bytes break parsing on Chinese Windows. All user-facing
# text lives in ../steps.json (messages table), this script only prints stable error codes.
#
# Step ids must match ../steps.json: disk / comfy / venv / weights / files / smoke
# =============================================================================
param(
  [string]$InstallDir = "",
  [int]$DiskHintGb = 40,
  [switch]$Force,
  [switch]$SkipWeights,
  [switch]$SkipSmoke,
  [switch]$SkipBf16,
  [string]$WeightsDir = ""
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

. (Join-Path $PSScriptRoot 'step.ps1')

if (-not $env:HF_ENDPOINT) { $env:HF_ENDPOINT = 'https://hf-mirror.com' }
$env:PYTHONIOENCODING = 'utf-8'
$StepIds = @('disk', 'comfy', 'venv', 'weights', 'files', 'smoke')
$script:Seen = @{}
function Begin-Step([string]$id, [int]$pct) {
  $script:Seen[$id] = $true
  Step-Begin $id '' $pct
}
function Write-Head([string]$msg) { Write-Host ("[flux3klein-install] " + $msg) }
function Fail([string]$id, [string]$code, [string]$msg, $params) {
  Step-Fail $id ([ordered]@{ code = $code; params = $params; message = $msg })
  Write-Head ("FAILED at " + $id + ": " + $msg)
  exit 1
}
# Native tools (pip / curl / python) print progress and retry warnings on stderr.
# With $ErrorActionPreference = 'Stop' those stderr lines become terminating errors and
# abort the whole install on a single transient pip retry -- run them with 'Continue'
# and decide by exit code instead.
# True only when the venv torch can actually see the GPU. ComfyUI dies at import time with
# "Torch not compiled with CUDA enabled", so the installer has to check instead of assuming.
function Test-Cuda([string]$py) {
  $old = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $out = & $py -c "import torch;print(int(torch.cuda.is_available()))" 2>&1
    $lines = @($out | ForEach-Object { ("" + $_).Trim() } | Where-Object { $_ -ne '' })
    if ($lines.Count -eq 0) { return $false }
    return ($lines[$lines.Count - 1] -eq '1')
  } catch { return $false } finally { $ErrorActionPreference = $old }
}

function Invoke-Native([string]$exe, [string[]]$exeArgs) {
  $old = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & $exe @exeArgs 2>&1 | ForEach-Object { Write-Head $_ }
    return $LASTEXITCODE
  } finally { $ErrorActionPreference = $old }
}

# The py launcher happily returns 3.10 for "py -3"; ComfyUI's newer wheels want 3.11/3.12,
# so check the interpreter version instead of trusting the launcher/exit code.
function Get-PythonVersion([string]$exe, [string[]]$pre) {
  $old = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $out = & $exe @pre -c "import sys;print('%d.%d' % (sys.version_info[0], sys.version_info[1]))" 2>$null
    if ($LASTEXITCODE -ne 0) { return '' }
    $line = @($out | ForEach-Object { ("" + $_).Trim() } | Where-Object { $_ -match '^\d+\.\d+$' } | Select-Object -Last 1)
    if ($line.Count -eq 0) { return '' }
    return $line[0]
  } catch { return '' } finally { $ErrorActionPreference = $old }
}

function Get-UvPython([string]$v) {
  $old = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $p = ((& uv python find $v 2>$null | Out-String).Trim())
    if ($LASTEXITCODE -ne 0) { return '' }
    return $p
  } catch { return '' } finally { $ErrorActionPreference = $old }
}

# Order: installed launchers -> PATH python -> uv-managed 3.11/3.12. uv is only used when
# the machine has no matching interpreter; its download mirror is npmmirror (no GitHub).
function Resolve-BasePython {
  $cands = @(
    @{ exe = 'py'; pre = @('-3.11') },
    @{ exe = 'py'; pre = @('-3.12') },
    @{ exe = 'python'; pre = @() },
    @{ exe = 'python3'; pre = @() }
  )
  if (Get-Command uv -ErrorAction SilentlyContinue) {
    foreach ($v in @('3.11', '3.12')) {
      $p = Get-UvPython $v
      if ($p -and (Test-Path $p)) { $cands += @{ exe = $p; pre = @() } }
    }
  }
  foreach ($c in $cands) {
    $v = Get-PythonVersion $c.exe $c.pre
    if ($v -eq '3.11' -or $v -eq '3.12') {
      return @{ exe = $c.exe; pre = $c.pre; version = $v }
    }
  }
  return $null
}

$MsRepo = 'black-forest-labs/flux-3-image-klein-comfy'
$HfRepo = 'black-forest-labs/flux-3-image-klein-comfy'
$MirrorRepo = 'ml-resources/flux-3-image-klein-comfy'

try {
  if (-not $InstallDir) { $InstallDir = Join-Path $env:LOCALAPPDATA 'pipeline-console\flux3-klein-local' }
  $InstallDir = [System.IO.Path]::GetFullPath($InstallDir)
  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
  $ComfyDir = Join-Path $InstallDir 'ComfyUI'
  $ModelsDir = Join-Path $ComfyDir 'models'
  Write-Head ("install dir: " + $InstallDir)

  # ---------------------------------------------------------------- disk
  Begin-Step 'disk' 2
  try {
    $root = [System.IO.Path]::GetPathRoot($InstallDir)
    $freeGb = [math]::Round((New-Object System.IO.DriveInfo($root)).AvailableFreeSpace / 1GB, 1)
  } catch { $freeGb = -1 }
  if ($freeGb -ge 0 -and $freeGb -lt $DiskHintGb) {
    Fail 'disk' 'flux3klein.disk.low_space' ("free disk about " + $freeGb + "GB, below the suggested " + $DiskHintGb + "GB") @{ free = $freeGb; want = $DiskHintGb }
  }
  Write-Head ("free disk: " + $freeGb + "GB")
  Step-Ok 'disk' 5

  # ---------------------------------------------------------------- comfy
  Begin-Step 'comfy' 8
  if (-not (Test-Path (Join-Path $ComfyDir 'main.py'))) {
    $zip = Join-Path $env:TEMP 'comfyui-flux3klein.zip'
    # ghfast returns a 24-byte 403 page for this repo, so it is not a usable source.
    # gh-proxy and codeload were both verified to return a 13 MB application/zip.
    $comfyZipUrls = @(
      'https://gh-proxy.com/https://github.com/comfyanonymous/ComfyUI/archive/refs/heads/master.zip',
      'https://codeload.github.com/comfyanonymous/ComfyUI/zip/refs/heads/master',
      'https://github.com/comfyanonymous/ComfyUI/archive/refs/heads/master.zip'
    )
    $ok = $false
    $extract = Join-Path $env:TEMP 'comfyui-flux3klein-extract'
    foreach ($u in $comfyZipUrls) {
      try {
        Write-Head ("downloading ComfyUI: " + $u)
        if (Test-Path $zip) { Remove-Item $zip -Force }
        $code = Invoke-Native 'curl.exe' @('-L', '--fail', '--retry', '3', '--connect-timeout', '30', '--max-time', '900', '-o', $zip, $u)
        if ($code -ne 0 -or -not (Test-Path $zip) -or ((Get-Item $zip).Length -lt 1000000)) {
          Write-Head ("ComfyUI download failed (curl exit " + $code + ")")
          continue
        }
        # A proxy can return HTTP 200 with an HTML error page; require the ZIP magic "PK".
        $fh = [System.IO.File]::OpenRead($zip)
        try { $b1 = $fh.ReadByte(); $b2 = $fh.ReadByte() } finally { $fh.Close() }
        if ($b1 -ne 0x50 -or $b2 -ne 0x4B) {
          Write-Head 'ComfyUI archive is not a zip file'
          continue
        }
        if (Test-Path $extract) { Remove-Item $extract -Recurse -Force }
        Expand-Archive -Path $zip -DestinationPath $extract -Force
        $src = Get-ChildItem -Path $extract -Directory | Select-Object -First 1
        if (-not $src -or -not (Test-Path (Join-Path $src.FullName 'main.py'))) {
          Write-Head 'ComfyUI archive did not contain main.py'
          continue
        }
        if (Test-Path $ComfyDir) { Remove-Item $ComfyDir -Recurse -Force }
        Move-Item -Path $src.FullName -Destination $ComfyDir
        $ok = $true
        break
      } catch {
        Write-Head ("ComfyUI download/extract failed: " + $_.Exception.Message)
      }
    }
    if (-not $ok) { Fail 'comfy' 'flux3klein.comfy.download_failed' 'could not download the ComfyUI source archive' @{ urls = ($comfyZipUrls -join ' '); tail = '' } }
  } else {
    Write-Head 'ComfyUI already present'
  }
  Step-Ok 'comfy' 20

  # ---------------------------------------------------------------- venv
  Begin-Step 'venv' 25
  $Py = Join-Path $ComfyDir 'venv\Scripts\python.exe'
  if (Test-Path $Py) {
    $venvVer = Get-PythonVersion $Py @()
    if ($venvVer -eq '3.11' -or $venvVer -eq '3.12') {
      Write-Head ("existing venv python: " + $venvVer)
    } else {
      Write-Head ("existing venv python " + $venvVer + " is not 3.11/3.12 -- recreating")
      Remove-Item (Join-Path $ComfyDir 'venv') -Recurse -Force
    }
  }
  if (-not (Test-Path $Py)) {
    $base = Resolve-BasePython
    if (-not $base -and (Get-Command uv -ErrorAction SilentlyContinue)) {
      if (-not $env:UV_PYTHON_INSTALL_MIRROR) {
        $env:UV_PYTHON_INSTALL_MIRROR = 'https://registry.npmmirror.com/-/binary/python-build-standalone'
      }
      foreach ($v in @('3.11', '3.12')) {
        Write-Head ("installing Python " + $v + " with uv")
        $code = Invoke-Native 'uv' @('python', 'install', $v)
        if ($code -ne 0) { continue }
        $p = Get-UvPython $v
        if ($p -and (Test-Path $p)) { $base = @{ exe = $p; pre = @(); version = $v }; break }
      }
    }
    if (-not $base) { Fail 'venv' 'flux3klein.venv.no_python' 'no usable Python 3.11/3.12 found on PATH' @{ tail = '' } }
    Write-Head ("base python: " + $base.version + " (" + $base.exe + ")")
    $venvArgs = @($base.pre) + @('-m', 'venv', (Join-Path $ComfyDir 'venv'))
    $venvCode = Invoke-Native $base.exe $venvArgs
    if ($venvCode -ne 0) { Fail 'venv' 'flux3klein.venv.create_failed' 'python -m venv failed' @{ venv = $Py; tail = '' } }
  }
  $pipIndex = if ($env:PIP_INDEX_URL) { $env:PIP_INDEX_URL } else { 'https://pypi.tuna.tsinghua.edu.cn/simple' }
  $pipIndexes = @($pipIndex, 'https://pypi.org/simple') | Select-Object -Unique
  $netArgs = @('--no-cache-dir', '--retries', '5', '--timeout', '30', '--disable-pip-version-check')
  # A global pip.ini on the machine may add an unreachable extra-index-url (it does on some
  # boxes: pypi.ngc.nvidia.com), which makes every pip call retry then fail. PIP_CONFIG_FILE
  # alone does not stop that (pip still merges the machine-wide config), and --isolated makes
  # pip ignore the env override too -- so set PIP_EXTRA_INDEX_URL explicitly for every call.
  # A non-empty env value wins over the global extra-index-url; an empty one does not.
  $env:PIP_CONFIG_FILE = Join-Path $InstallDir 'pip.ini'
  Set-Content -Path $env:PIP_CONFIG_FILE -Encoding ASCII -Value @('[global]', 'no-cache-dir = true', ('index-url = ' + $pipIndex), 'timeout = 30', 'retries = 5')
  $env:PIP_EXTRA_INDEX_URL = 'https://pypi.org/simple'
  Write-Head ("pip config: " + $env:PIP_CONFIG_FILE)
  # Upgrading pip is best effort: an old pip can still install the dependencies.
  Invoke-Native $Py (@('-m', 'pip', 'install', '--upgrade', 'pip', '-i', $pipIndex) + $netArgs) | Out-Null
  # Torch must come from the CUDA index ONLY. With the PyPI extra index still in play pip is
  # happy to resolve plain "torch" to the CPU wheel of the same version (it did: 124MB
  # torch-2.14.1-cp310-win_amd64.whl instead of the 2.6GB +cu126 build), which installs fine
  # and only fails the later CUDA probe -- two wasted downloads.
  function Install-CudaTorch([string]$py, [string]$idx, [string[]]$more) {
    $saved = $env:PIP_EXTRA_INDEX_URL
    $env:PIP_EXTRA_INDEX_URL = $idx
    try {
      return Invoke-Native $py (@('-m', 'pip', 'install') + $more + @('torch', 'torchvision', '--index-url', $idx) + $netArgs)
    } finally { $env:PIP_EXTRA_INDEX_URL = $saved }
  }
  # requirements.txt lists torch too, and a plain index serves the CPU wheel there: install
  # the requirements FIRST, then force the CUDA build on top. A plain "pip install torch"
  # after requirements is a no-op ("Requirement already satisfied"), which is why the CUDA
  # step below always force-reinstalls instead of relying on pip to notice the index change.
  Write-Head 'installing ComfyUI requirements'
  $reqOk = $false
  foreach ($idx in $pipIndexes) {
    $code = Invoke-Native $Py (@('-m', 'pip', 'install', '-r', (Join-Path $ComfyDir 'requirements.txt'), '-i', $idx) + $netArgs)
    if ($code -eq 0) { $reqOk = $true; break }
    Write-Head ("requirements install failed (exit " + $code + ") on " + $idx)
  }
  if (-not $reqOk) { Fail 'venv' 'flux3klein.venv.pip_failed' 'ComfyUI requirements could not be installed' @{ venv = $Py; tail = '' } }
  $torchOk = $false
  foreach ($idx in @('https://download.pytorch.org/whl/cu128', 'https://mirrors.aliyun.com/pytorch-wheels/cu128', 'https://download.pytorch.org/whl/cu126')) {
    Write-Head ("installing torch from " + $idx)
    $code = Install-CudaTorch $Py $idx @('--force-reinstall', '--no-deps')
    if ($code -eq 0 -and (Test-Cuda $Py)) { $torchOk = $true; break }
    Write-Head ("torch install from " + $idx + " did not take (exit " + $code + ")")
  }
  if (-not $torchOk) { Fail 'venv' 'flux3klein.venv.torch_failed' 'CUDA torch could not be installed' @{ venv = $Py; tail = '' } }
  Write-Head 'torch cuda: ok'
  Step-Ok 'venv' 50

  # ---------------------------------------------------------------- weights
  Begin-Step 'weights' 55
  $want = @(
    @{ rel = 'diffusion_models/flux3-image-klein-int8-convrot.safetensors'; mb = 5828 },
    @{ rel = 'text_encoders/qwen3vl_4b_int8_convrot.safetensors'; mb = 4859 },
    @{ rel = 'vae/flux2-vae.safetensors'; mb = 336 }
  )
  if (-not $SkipBf16) {
    $want += @{ rel = 'diffusion_models/flux3-image-klein-bf16.safetensors'; mb = 11097 }
    $want += @{ rel = 'text_encoders/qwen3vl_4b_bf16.safetensors'; mb = 8876 }
  }
  # $mb is the decimal size the model page lists (5828 MB for the INT8 UNET), so compare
  # against decimal bytes -- 1MB (binary) would make a complete file look 4.9% short, and
  # 98% would be "complete" with a 220 MB hole in the 11 GB BF16 UNET (ComfyUI only fails
  # much later with a safetensors header error). Completeness is 99.5%; anything between
  # 1% and 99.5% is a resumable partial.
  $Complete = 0.995
  function Get-Needed([int]$mb) { return [int64]([double]$mb * 1000000 * $Complete) }
  function Test-Weight([string]$path, [int]$mb) {
    if (-not (Test-Path $path)) { return $false }
    return ((Get-Item $path).Length -ge (Get-Needed $mb))
  }
  function Fetch-One([string]$rel, [int]$mb) {
    $dest = Join-Path $ModelsDir ($rel -replace '/', '\')
    New-Item -ItemType Directory -Force -Path (Split-Path $dest -Parent) | Out-Null
    $expect = [int64]$mb * 1000000
    if (Test-Weight $dest $mb) { Write-Head ("present: " + $rel); return }
    # A partial file is only worth resuming when it really is a prefix of the weight: a few
    # dozen bytes are an error page / an aborted first request, and appending 11 GB behind
    # that garbage yields a file of the right length with a broken tensor header.
    if (Test-Path $dest) {
      $len = (Get-Item $dest).Length
      if ($len -lt [int64]($expect * 0.01) -or $len -gt [int64]($expect * 1.05)) {
        Write-Head ("dropping unusable partial " + $rel + " (" + $len + " bytes)")
        Remove-Item $dest -Force
      } else {
        Write-Head ("resuming " + $rel + " at " + $len + " of about " + $expect + " bytes")
      }
    }
    if ($WeightsDir) {
      # Accept the models root itself, a ComfyUI checkout, or a flat folder of files, so a
      # previous install can be reused as-is (-WeightsDir <dir>\ComfyUI\models).
      foreach ($root in @($WeightsDir, (Join-Path $WeightsDir 'models'), (Join-Path $WeightsDir 'ComfyUI\models'))) {
        if (-not (Test-Path $root)) { continue }
        $cand = Join-Path $root ($rel -replace '/', '\')
        if (-not (Test-Path $cand)) { $cand = Join-Path $root (Split-Path $rel -Leaf) }
        if (-not (Test-Path $cand)) { continue }
        if (-not (Test-Weight $cand $mb)) {
          Write-Head ("skipping incomplete local copy " + $cand)
          continue
        }
        Write-Head ("copying from " + $cand)
        # Copy-Item -Force over a longer existing file keeps its tail, so drop it first.
        if (Test-Path $dest) { Remove-Item $dest -Force }
        Copy-Item $cand $dest -Force
        if (Test-Weight $dest $mb) { Write-Head ("copied: " + $rel); return }
        Write-Head 'copy did not produce a complete file, falling back to download'
        break
      }
    }
    $urls = @(
      ('https://www.modelscope.cn/models/' + $MsRepo + '/resolve/master/' + $rel),
      ('https://www.modelscope.cn/api/v1/models/' + $MsRepo + '/repo?Revision=master&FilePath=' + $rel),
      ($env:HF_ENDPOINT + '/' + $HfRepo + '/resolve/main/' + $rel),
      ($env:HF_ENDPOINT + '/' + $MirrorRepo + '/resolve/main/' + $rel)
    )
    # Two rounds over every source: a stalled mirror usually resumes fine on the next one
    # (-C - keeps the partial file), and 12 GB files simply do not land in one clean pass.
    foreach ($round in 1..2) {
      foreach ($u in $urls) {
        Write-Head ("downloading " + $rel + " <- " + $u)
        $code = Invoke-Native 'curl.exe' @('-L', '-sS', '--fail', '--retry', '3', '--retry-all-errors', '--retry-delay', '3', '-C', '-', '--connect-timeout', '30', '--speed-time', '60', '--speed-limit', '2048', '-o', $dest, $u)
        if (Test-Weight $dest $mb) { Write-Head ("done: " + $rel); return }
        $have = 0
        if (Test-Path $dest) { $have = (Get-Item $dest).Length }
        Write-Head ("incomplete (" + $have + " of about " + $expect + " bytes, curl exit " + $code + "), trying next source")
      }
    }
    # Last resort: a source that answers a Range request with 200/416 can never finish a
    # partial file ("HTTP server does not seem to support byte ranges"), so drop the partial
    # and give every source one clean pass from zero before reporting failure.
    if (Test-Path $dest) {
      Write-Head ("restarting " + $rel + " from zero (" + (Get-Item $dest).Length + " partial bytes discarded)")
      Remove-Item $dest -Force
    }
    foreach ($u in $urls) {
      Write-Head ("downloading " + $rel + " <- " + $u)
      $code = Invoke-Native 'curl.exe' @('-L', '-sS', '--fail', '--retry', '3', '--retry-all-errors', '--retry-delay', '3', '--connect-timeout', '30', '--speed-time', '60', '--speed-limit', '2048', '-o', $dest, $u)
      if (Test-Weight $dest $mb) { Write-Head ("done: " + $rel); return }
    }
    throw ("weight download failed: " + $rel)
  }
  if (-not $SkipWeights) {
    foreach ($w in $want) {
      try { Fetch-One $w.rel $w.mb }
      catch { Fail 'weights' 'flux3klein.weights.download_failed' $_.Exception.Message @{ tail = '' } }
    }
  } else {
    Write-Head 'weights skipped (-SkipWeights)'
  }
  Step-Ok 'weights' 85

  # ---------------------------------------------------------------- files
  Begin-Step 'files' 90
  $required = @(
    @{ rel = 'main.py'; min = 5000 },
    @{ rel = 'venv\Scripts\python.exe'; min = 5000 }
  )
  # Same list (and the same 99.5% bar) as the weights step: existence alone is not enough,
  # a truncated download only fails later inside ComfyUI when it loads the tensor.
  foreach ($w in $want) { $required += @{ rel = ('models\' + ($w.rel -replace '/', '\')); min = (Get-Needed $w.mb) } }
  $missing = @()
  foreach ($r in $required) {
    $p = Join-Path $ComfyDir $r.rel
    if (-not (Test-Path $p)) { $missing += ($r.rel + ' [absent]'); continue }
    $len = (Get-Item $p).Length
    if ($len -lt $r.min) { $missing += ($r.rel + ' [' + $len + ' of at least ' + $r.min + ' bytes]') }
  }
  if ($missing.Count -gt 0) {
    Fail 'files' 'flux3klein.files.missing' ('missing: ' + ($missing -join ', ')) @{ err = ($missing -join ', ') }
  }
  Step-Ok 'files' 94

  # ---------------------------------------------------------------- smoke
  Begin-Step 'smoke' 96
  if (-not $SkipSmoke) {
    # 8197 is the documented smoke port, but the real backend (or a crashed earlier run) can
    # be holding it: binding a listener is the only reliable test, and falling forward to the
    # next free port keeps the smoke meaningful instead of failing on a leftover socket.
    $port = 0
    for ($p = 8197; $p -le 8217; $p++) {
      $free = $true
      try {
        $probe = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $p)
        $probe.Start(); $probe.Stop()
      } catch { $free = $false }
      if ($free) { $port = $p; break }
    }
    if ($port -eq 0) {
      Fail 'smoke' 'flux3klein.smoke.backend_failed' 'no free port in 8197-8217 for the smoke run' @{ err = 'ports 8197-8217 busy'; tail = '' }
    }
    Write-Head ("smoke port: " + $port)
    $log = Join-Path $InstallDir 'install-smoke.log'
    foreach ($f in @($log, ($log + '.err'))) { if (Test-Path $f) { try { Remove-Item $f -Force } catch { } } }
    $proc = $null
    try {
      $proc = Start-Process -FilePath $Py -ArgumentList @('main.py', '--port', "$port", '--listen', '127.0.0.1', '--disable-auto-launch') -WorkingDirectory $ComfyDir -RedirectStandardOutput $log -RedirectStandardError ($log + '.err') -PassThru -WindowStyle Hidden
      $ready = $false
      # A cold start imports torch/CUDA and every comfy_extras module before the port opens;
      # 180s was not enough on a first run after a reboot, so wait up to 600s (300 probes).
      $deadline = (Get-Date).AddSeconds(600)
      $waited = 0
      while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 2
        $waited += 2
        try {
          $r = Invoke-WebRequest -UseBasicParsing -Uri ("http://127.0.0.1:" + $port + "/object_info/ReferenceMultiLatent") -TimeoutSec 5
          if ($r.StatusCode -eq 200 -and $r.Content -match 'ReferenceMultiLatent') { $ready = $true; break }
        } catch { }
        if ($proc.HasExited) { break }
        if (($waited % 60) -eq 0) { Write-Head ("waiting for ComfyUI on port " + $port + " (" + $waited + "s)") }
      }
      if (-not $ready) {
        $tail = ''
        try { $tail = (Get-Content $log -Tail 20 -Encoding UTF8) -join ' | ' } catch { }
        $err = 'ReferenceMultiLatent missing on port ' + $port
        Fail 'smoke' 'flux3klein.smoke.backend_failed' ('ComfyUI did not expose ReferenceMultiLatent (port ' + $port + ', log: ' + $tail + ')') @{ err = $err; tail = $tail }
      }
    } finally {
      if ($proc -and -not $proc.HasExited) { try { & taskkill /PID $proc.Id /T /F 2>&1 | Out-Null } catch { } }
    }
  }
  Set-Content -Path (Join-Path $InstallDir '.install-ok') -Value ("ok`n" + (Get-Date).ToString('o')) -Encoding ASCII
  Step-Ok 'smoke' 100
  Write-Head 'install finished'
  exit 0
} catch {
  Write-Head ("install failed: " + $_.Exception.Message)
  foreach ($id in $StepIds) { if (-not $script:Seen[$id]) { try { Step-Skip $id } catch { } } }
  exit 1
}
