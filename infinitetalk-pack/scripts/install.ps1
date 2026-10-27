# =============================================================================
# InfiniteTalk local backend installer (audio-driven talking video).
#
# What it does:
#   <InstallDir>\ComfyUI                         isolated ComfyUI checkout
#   <InstallDir>\ComfyUI\venv                    isolated Python (CUDA torch)
#   <InstallDir>\ComfyUI\models\...              Wan2.1 I2V 14B fp8 + InfiniteTalk
#                                                single patch + umt5 + VAE +
#                                                wav2vec2 + lightx2v 4-step LoRA +
#                                                CLIP vision
#
# The video graph uses ComfyUI's NATIVE WanInfiniteTalkToVideo node, so there is no
# custom node pack to clone. SageAttention is a MANDATORY optimization here: the
# sage step must succeed (wheel installed + kernel smoke run) or the install fails.
#
# HARD RULE -- PURE ASCII, NO BOM. Windows PowerShell 5.1 decodes a BOM-less .ps1 with the
# machine ANSI code page; non-ASCII bytes break parsing on Chinese Windows. All user-facing
# text lives in ../steps.json (messages table), this script only prints stable error codes.
#
# Step ids must match ../steps.json: disk / comfy / venv / sage / weights / files / smoke
# =============================================================================
param(
  [string]$InstallDir = (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)),
  [int]$DiskHintGb = 55,
  [switch]$Force,
  [switch]$SkipWeights,
  [switch]$SkipSmoke
)

try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
$OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$env:PYTHONIOENCODING = 'utf-8'
$ErrorActionPreference = 'Stop'

# Ignore machine-level pip configuration: some machines carry an unreachable
# extra-index-url (e.g. pypi.ngc.nvidia.com) that makes every resolution slow or
# wrong (it can even resolve torch to a CPU wheel while a CUDA index is requested).
# Every pip call below passes its own index explicitly, so config is not needed.
$env:PIP_CONFIG_FILE = 'nul'
$env:PIP_EXTRA_INDEX_URL = ''

. (Join-Path $PSScriptRoot 'step.ps1')

$InstallDir = [System.IO.Path]::GetFullPath($InstallDir)
$ComfyRoot = Join-Path $InstallDir 'ComfyUI'
$VenvDir = Join-Path $ComfyRoot 'venv'
$VenvPy = Join-Path $VenvDir 'Scripts\python.exe'
$StepIds = @('disk', 'comfy', 'venv', 'sage', 'weights', 'files', 'smoke')

function New-FailCode {
  param([string]$Code, [hashtable]$Params, [string]$Message)
  $o = [ordered]@{ code = $Code }
  if ($Params -and $Params.Count) { $o.params = $Params }
  $o.message = $Message
  return $o
}

function Skip-Rest {
  param([string]$From)
  $seen = $false
  foreach ($id in $StepIds) {
    if ($id -eq $From) { $seen = $true; continue }
    if ($seen) { Step-Skip $id }
  }
}

function Write-Head {
  param([string]$Text)
  Write-Host "[infinitetalk-install] $Text"
}

# --- python -------------------------------------------------------------------
function Find-BasePython {
  if ($env:MT_INFINITETALK_PYTHON -and (Test-Path $env:MT_INFINITETALK_PYTHON)) { return $env:MT_INFINITETALK_PYTHON }
  $cands = @(
    @('py', @('-3.11', '-c', 'import sys;print(sys.executable)')),
    @('py', @('-3.12', '-c', 'import sys;print(sys.executable)')),
    @('python', @('-c', 'import sys;print(sys.executable)'))
  )
  foreach ($c in $cands) {
    try {
      $exe = & $c[0] @($c[1]) 2>$null
      if ($LASTEXITCODE -eq 0 -and $exe -and (Test-Path "$exe".Trim())) {
        $ver = & "$exe".Trim() -c "import sys;print('%d.%d'%sys.version_info[:2])" 2>$null
        if ("$ver".Trim() -match '^3\.(1[0-3])$') { return "$exe".Trim() }
      }
    } catch { }
  }
  return ''
}

# --- download -----------------------------------------------------------------
function Get-Curl {
  $c = Get-Command curl.exe -ErrorAction SilentlyContinue
  if ($c) { return $c.Source }
  return ''
}

function Download-File {
  param([string]$Url, [string]$Dest, [long]$MinBytes = 1048576)
  $dir = Split-Path -Parent $Dest
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force $dir | Out-Null }
  if ((Test-Path $Dest) -and ((Get-Item $Dest).Length -ge $MinBytes)) {
    Write-Head "already present: $Dest"
    return $true
  }
  $curl = Get-Curl
  for ($attempt = 1; $attempt -le 3; $attempt++) {
    try {
      if ($curl) {
        & $curl -L --fail --retry 2 -C - -o $Dest $Url
      } else {
        Invoke-WebRequest -Uri $Url -OutFile $Dest -UseBasicParsing -TimeoutSec 1800
      }
      if ((Test-Path $Dest) -and ((Get-Item $Dest).Length -ge $MinBytes)) { return $true }
    } catch {
      Write-Head "download attempt $attempt failed: $($_.Exception.Message)"
      Start-Sleep -Seconds 3
    }
  }
  return $false
}

function Invoke-GitClone {
  # git writes progress to stderr; with $ErrorActionPreference = 'Stop' that stderr would be
  # turned into a terminating error even when the clone succeeds. Keep it non-terminating and
  # decide by exit code / resulting files only.
  param([string]$Url, [string]$Dest)
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & git clone --depth 1 $Url $Dest 2>&1 | Write-Host
    return ($LASTEXITCODE -eq 0)
  } catch {
    Write-Head "git clone error: $($_.Exception.Message)"
    return $false
  } finally {
    $ErrorActionPreference = $prev
  }
}

function Invoke-Pip {
  # pip logs errors to stderr; with $ErrorActionPreference = 'Stop' that would abort the
  # whole step instead of letting the caller fall through to the next index mirror.
  param([string]$Py, [string[]]$PipArgs)
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & $Py -m pip @PipArgs 2>&1 | Write-Host
    return $LASTEXITCODE
  } catch {
    Write-Head "pip error: $($_.Exception.Message)"
    return 1
  } finally {
    $ErrorActionPreference = $prev
  }
}

function Invoke-Py {
  # Run a python one-liner and return its combined output. Same reason as Invoke-Pip:
  # a Traceback on stderr must not abort the step while we are only probing state.
  param([string]$Py, [string[]]$PyArgs)
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $out = & $Py @PyArgs 2>&1
    return (($out | ForEach-Object { "$_" }) -join "`n")
  } catch {
    return ''
  } finally {
    $ErrorActionPreference = $prev
  }
}

function Get-ComfyZip {
  param([string]$DestZip)
  $urls = @(
    'https://codeload.github.com/comfyanonymous/ComfyUI/zip/refs/heads/master',
    'https://ghfast.top/https://codeload.github.com/comfyanonymous/ComfyUI/zip/refs/heads/master',
    'https://gh-proxy.com/https://codeload.github.com/comfyanonymous/ComfyUI/zip/refs/heads/master'
  )
  foreach ($u in $urls) {
    if (Download-File -Url $u -Dest $DestZip -MinBytes 5000000) { return $true }
  }
  return $false
}

# The 7 weight files the native WanInfiniteTalkToVideo graph needs. Keeping the list in
# one place makes the files step and the download step check exactly the same set.
function Get-WeightJobs {
  param([string]$ModelsDir)
  $hf = 'https://hf-mirror.com'
  $hf2 = 'https://huggingface.co'
  $jobs = @()
  $jobs += @{
    dest = Join-Path $ModelsDir 'diffusion_models\wan2.1-i2v-14b-480p-fp8_e4m3fn_scaled.safetensors'
    min  = 15000000000
    rel  = 'Kijai/WanVideo_comfy_fp8_scaled/resolve/main/I2V/Wan2_1-I2V-14B-480p_fp8_e4m3fn_scaled_KJ.safetensors'
  }
  $jobs += @{
    dest = Join-Path $ModelsDir 'model_patches\wan2.1_infiniteTalk_single_fp16.safetensors'
    min  = 4000000000
    rel  = 'Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/model_patches/wan2.1_infiniteTalk_single_fp16.safetensors'
  }
  $jobs += @{
    dest = Join-Path $ModelsDir 'text_encoders\umt5_xxl_fp8_e4m3fn_scaled.safetensors'
    min  = 5000000000
    rel  = 'Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors'
  }
  $jobs += @{
    dest = Join-Path $ModelsDir 'vae\Wan2_1_VAE_bf16.safetensors'
    min  = 200000000
    rel  = 'Kijai/WanVideo_comfy/resolve/main/Wan2_1_VAE_bf16.safetensors'
  }
  $jobs += @{
    dest = Join-Path $ModelsDir 'audio_encoders\wav2vec2-chinese-base_fp16.safetensors'
    min  = 150000000
    rel  = 'Kijai/wav2vec2_safetensors/resolve/main/wav2vec2-chinese-base_fp16.safetensors'
  }
  $jobs += @{
    dest = Join-Path $ModelsDir 'loras\lightx2v_I2V_14B_480p_cfg_step_distill_rank64_bf16.safetensors'
    min  = 600000000
    rel  = 'Kijai/WanVideo_comfy/resolve/main/Lightx2v/lightx2v_I2V_14B_480p_cfg_step_distill_rank64_bf16.safetensors'
  }
  $jobs += @{
    dest = Join-Path $ModelsDir 'clip_vision\clip_vision_h.safetensors'
    min  = 1000000000
    rel  = 'Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/clip_vision/clip_vision_h.safetensors'
  }
  foreach ($j in $jobs) { $j.urls = @("$hf/$($j.rel)", "$hf2/$($j.rel)") }
  return $jobs
}

# =============================================================================
try {
  Write-Head "install dir: $InstallDir"
  if (-not (Test-Path $InstallDir)) { New-Item -ItemType Directory -Force $InstallDir | Out-Null }

  # -- disk -------------------------------------------------------------------
  Step-Begin 'disk' '' 2
  try {
    $drive = (Get-Item $InstallDir).PSDrive
    $freeGb = [math]::Round($drive.Free / 1GB, 1)
    Write-Head "free disk: ${freeGb}GB"
    if ($freeGb -lt $DiskHintGb) {
      Write-Host "::warning:: free disk ${freeGb}GB < ${DiskHintGb}GB"
    }
    Step-Ok 'disk' 4
  } catch {
    Step-Ok 'disk' 4
  }

  # -- comfy ------------------------------------------------------------------
  Step-Begin 'comfy' '' 8
  try {
    if (-not (Test-Path (Join-Path $ComfyRoot 'main.py'))) {
      $git = Get-Command git -ErrorAction SilentlyContinue
      $cloned = $false
      if ($git) {
        $repos = @(
          'https://github.com/comfyanonymous/ComfyUI.git',
          'https://ghfast.top/https://github.com/comfyanonymous/ComfyUI.git',
          'https://gh-proxy.com/https://github.com/comfyanonymous/ComfyUI.git'
        )
        foreach ($r in $repos) {
          try {
            if (Test-Path $ComfyRoot) { Remove-Item -Recurse -Force $ComfyRoot }
            $ok = Invoke-GitClone -Url $r -Dest $ComfyRoot
            if ($ok -and (Test-Path (Join-Path $ComfyRoot 'main.py'))) { $cloned = $true; break }
            Write-Head "git clone did not produce main.py from $r"
          } catch { Write-Head "git clone failed: $($_.Exception.Message)" }
        }
      }
      if (-not $cloned) {
        $zip = Join-Path $env:TEMP ('comfyui-' + [guid]::NewGuid().ToString('N') + '.zip')
        if (-not (Get-ComfyZip -DestZip $zip)) { throw 'comfy_download_failed' }
        $tmp = Join-Path $env:TEMP ('comfyui-' + [guid]::NewGuid().ToString('N'))
        Expand-Archive -Path $zip -DestinationPath $tmp -Force
        $inner = Get-ChildItem $tmp -Directory | Select-Object -First 1
        if (-not $inner) { throw 'comfy_unzip_empty' }
        if (Test-Path $ComfyRoot) { Remove-Item -Recurse -Force $ComfyRoot }
        Move-Item $inner.FullName $ComfyRoot
        Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
        Remove-Item -Force $zip -ErrorAction SilentlyContinue
      }
    }
    if (-not (Test-Path (Join-Path $ComfyRoot 'main.py'))) { throw 'comfy_missing_after_prepare' }
    Step-Ok 'comfy' 14
  } catch {
    $tail = "$($_.Exception.Message)"
    Step-Fail 'comfy' (New-FailCode 'infinitetalk.comfy.prep_failed' @{ tail = $tail } "comfy prepare failed: $tail")
    Skip-Rest 'comfy'
    throw
  }

  # -- venv / torch -----------------------------------------------------------
  Step-Begin 'venv' '' 16
  try {
    if (-not (Test-Path $VenvPy)) {
      $base = Find-BasePython
      if (-not $base) { throw 'python_missing' }
      Write-Head "base python: $base"
      & $base -m venv $VenvDir
      if (-not (Test-Path $VenvPy)) { throw 'venv_create_failed' }
    }
    Invoke-Pip -Py $VenvPy -PipArgs @('install', '--upgrade', 'pip', '-i', 'https://mirrors.aliyun.com/pypi/simple') | Out-Null
    # CUDA tier from the driver version (cu128 needs a recent driver; cu126 is the safe floor)
    $cudaTier = 'cu126'
    try {
      $drv = (& nvidia-smi --query-gpu=driver_version --format=csv,noheader 2>$null | Select-Object -First 1)
      if ($drv) {
        $major = [int](("$drv".Trim() -split '\.')[0])
        if ($major -ge 570) { $cudaTier = 'cu128' }
        Write-Head "driver $drv -> $cudaTier"
      }
    } catch { }
    $torchIdx = @(
      "https://mirror.sjtu.edu.cn/pytorch-wheels/$cudaTier",
      "https://mirrors.aliyun.com/pytorch-wheels/$cudaTier",
      "https://download.pytorch.org/whl/$cudaTier"
    )
    # A wheel that imports fine can still be the CPU build (some mirrors resolve the
    # plain "torch" name to the PyPI CPU wheel). Verify torch.cuda.is_available() and
    # fall through the index list until a CUDA build is really imported.
    $torchOk = $false
    $torchCuda = Invoke-Py -Py $VenvPy -PyArgs @('-c', 'import torch;print(1 if torch.cuda.is_available() else 0)')
    if ("$torchCuda".Trim() -eq '1') { $torchOk = $true; Write-Head "existing torch is CUDA-capable" }
    foreach ($idx in $torchIdx) {
      if ($torchOk) { break }
      Write-Head "torch index: $idx"
      # Uninstall first: an already-installed CPU wheel satisfies the unversioned
      # "torch" requirement, so a plain install would silently keep it.
      Invoke-Pip -Py $VenvPy -PipArgs @('uninstall', '-y', 'torch', 'torchvision', 'torchaudio') | Out-Null
      $code = Invoke-Pip -Py $VenvPy -PipArgs @('install', '--force-reinstall', 'torch', 'torchvision', 'torchaudio', '--index-url', $idx)
      if ($code -ne 0) {
        Write-Head "torch install failed on $idx"
        continue
      }
      $torchVer = Invoke-Py -Py $VenvPy -PyArgs @('-c', 'import torch;print(torch.__version__)')
      $torchCuda = Invoke-Py -Py $VenvPy -PyArgs @('-c', 'import torch;print(1 if torch.cuda.is_available() else 0)')
      Write-Head "torch $torchVer cuda=$torchCuda"
      if ("$torchCuda".Trim() -eq '1') { $torchOk = $true; break }
      Write-Head "not a CUDA build from $idx, trying next index"
    }
    if (-not $torchOk) { throw 'torch_cuda_unavailable' }
    # ComfyUI pins moving frontend / runtime versions. Aliyun lags behind those pins, so
    # fall through mirrors instead of failing the whole install on one stale index.
    $reqOk = $false
    foreach ($mi in @('https://mirrors.aliyun.com/pypi/simple', 'https://pypi.org/simple')) {
      Write-Head "requirements index: $mi"
      $code = Invoke-Pip -Py $VenvPy -PipArgs @('install', '-r', (Join-Path $ComfyRoot 'requirements.txt'), '-i', $mi)
      if ($code -eq 0) { $reqOk = $true; break }
      Write-Head "requirements failed on $mi"
    }
    if (-not $reqOk) { throw 'comfy_requirements_failed' }
    Step-Ok 'venv' 40
  } catch {
    $tail = "$($_.Exception.Message)"
    $code = 'infinitetalk.venv.pip_failed'
    if ($tail -match 'python_missing') { $code = 'infinitetalk.venv.python_missing' }
    if ($tail -match 'torch') { $code = 'infinitetalk.venv.torch_failed' }
    Step-Fail 'venv' (New-FailCode $code @{ tail = $tail } "env prep failed: $tail")
    Skip-Rest 'venv'
    throw
  }

  # -- sageattention (MANDATORY) ----------------------------------------------
  # triton-windows + a prebuilt sageattention wheel matched to this venv, then a real
  # kernel smoke run. This is a default optimization, so a failure fails the install.
  Step-Begin 'sage' '' 44
  try {
    $sagePy = Join-Path $PSScriptRoot 'sage_install.py'
    if (-not (Test-Path $sagePy)) { throw 'sage_install.py missing' }
    Write-Head 'installing SageAttention (mandatory acceleration)'
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $sageOut = ''
    try {
      $sageOut = (& $VenvPy $sagePy 2>&1 | ForEach-Object { $s = [string]$_; Write-Head $s; $s }) -join "`n"
      $sageCode = $LASTEXITCODE
    } finally {
      $ErrorActionPreference = $prevEap
    }
    $sageTail = ($sageOut -split "`n" | Where-Object { $_ -match 'SAGE-|FAILED|\[pip\]' } | Select-Object -Last 3) -join ' | '
    if ($sageCode -ne 0 -or $sageOut -notmatch 'SAGE-OK=1') {
      throw ("sage failed exit=$sageCode " + $sageTail)
    }
    Step-Ok 'sage' 52
  } catch {
    $tail = "$($_.Exception.Message)"
    Step-Fail 'sage' (New-FailCode 'infinitetalk.sage.failed' @{ tail = $tail } "SageAttention mandatory step failed: $tail")
    Skip-Rest 'sage'
    throw
  }

  # -- weights ----------------------------------------------------------------
  Step-Begin 'weights' '' 56
  if ($SkipWeights) {
    Step-Skip 'weights'
  } else {
    try {
      $models = Join-Path $ComfyRoot 'models'
      $jobs = Get-WeightJobs -ModelsDir $models
      $i = 0
      foreach ($j in $jobs) {
        $i++
        $okOne = $false
        foreach ($u in $j.urls) {
          if (Download-File -Url $u -Dest $j.dest -MinBytes $j.min) { $okOne = $true; break }
        }
        if (-not $okOne) { throw "weight_failed: $($j.dest)" }
        Step-Ok 'weights' (56 + [int]([double]$i / $jobs.Count * 28))
      }
      Step-Ok 'weights' 84
    } catch {
      $tail = "$($_.Exception.Message)"
      Step-Fail 'weights' (New-FailCode 'infinitetalk.weights.failed' @{ tail = $tail } "weights failed: $tail")
      Skip-Rest 'weights'
      throw
    }
  }

  # -- files ------------------------------------------------------------------
  Step-Begin 'files' '' 86
  try {
    if (-not (Test-Path (Join-Path $ComfyRoot 'main.py'))) { throw 'main.py missing' }
    if (-not (Test-Path $VenvPy)) { throw 'venv missing' }
    $models = Join-Path $ComfyRoot 'models'
    if (-not $SkipWeights) {
      foreach ($j in (Get-WeightJobs -ModelsDir $models)) {
        if (-not (Test-Path $j.dest)) { throw "weight missing: $($j.dest)" }
        if ((Get-Item $j.dest).Length -lt $j.min) { throw "weight too small: $($j.dest)" }
      }
    }
    $sageProbe = Invoke-Py -Py $VenvPy -PyArgs @('-c', 'import triton, sageattention;print("SAGEOK")')
    if ("$sageProbe" -notmatch 'SAGEOK') { throw "sageattention not importable: $sageProbe" }
    Step-Ok 'files' 90
  } catch {
    $tail = "$($_.Exception.Message)"
    Step-Fail 'files' (New-FailCode 'infinitetalk.files.missing' @{ tail = $tail } "layout incomplete: $tail")
    Skip-Rest 'files'
    throw
  }

  # -- smoke ------------------------------------------------------------------
  # Boot ComfyUI on CPU (no VRAM taken, no weights loaded) and ask /object_info for the
  # native WanInfiniteTalkToVideo node: that is the one thing the whole plugin depends on.
  Step-Begin 'smoke' '' 92
  if ($SkipSmoke) {
    Step-Skip 'smoke'
  } else {
    $smokePort = 8231
    $logFile = Join-Path $InstallDir 'smoke-comfy.log'
    $proc = $null
    try {
      $prevEap = $ErrorActionPreference
      $ErrorActionPreference = 'Continue'
      $proc = Start-Process -FilePath $VenvPy -ArgumentList @('main.py', '--cpu', '--listen', '127.0.0.1', '--port', "$smokePort", '--disable-auto-launch') -WorkingDirectory $ComfyRoot -PassThru -RedirectStandardOutput $logFile -RedirectStandardError (Join-Path $InstallDir 'smoke-comfy.err.log') -WindowStyle Hidden
      $ErrorActionPreference = $prevEap
      $ok = $false
      for ($t = 0; $t -lt 90; $t++) {
        Start-Sleep -Seconds 2
        try {
          $r = Invoke-WebRequest -Uri "http://127.0.0.1:$smokePort/object_info/WanInfiniteTalkToVideo" -UseBasicParsing -TimeoutSec 5
          if ($r.StatusCode -eq 200 -and ("$($r.Content)" -match 'WanInfiniteTalkToVideo')) { $ok = $true; break }
        } catch { }
        if ($proc -and $proc.HasExited) { break }
      }
      if (-not $ok) { throw 'WanInfiniteTalkToVideo not served by /object_info' }
      Step-Ok 'smoke' 99
    } catch {
      $tail = "$($_.Exception.Message)"
      $logTail = ''
      if (Test-Path $logFile) { $logTail = ((Get-Content $logFile -Tail 3 -Encoding UTF8) -join ' | ') }
      Step-Fail 'smoke' (New-FailCode 'infinitetalk.smoke.failed' @{ tail = ($tail + ' ' + $logTail) } "smoke failed: $tail")
      throw
    } finally {
      try { if ($proc -and -not $proc.HasExited) { & taskkill /PID $proc.Id /T /F 2>&1 | Out-Null } } catch { }
    }
  }

  Set-Content -Path (Join-Path $InstallDir '.install-ok') -Value ("ok`n" + (Get-Date).ToString('o')) -Encoding ASCII
  Write-Head 'install finished'
  exit 0
} catch {
  Write-Head "install failed: $($_.Exception.Message)"
  exit 1
}
