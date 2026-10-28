# =============================================================================
# SoulX-FlashHead Lite local backend installer (audio-driven real-time portrait).
#
# What it does:
#   <InstallDir>\SoulX-FlashHead                    official inference repo (zip, no git)
#   <InstallDir>\SoulX-FlashHead\venv               isolated Python (torch 2.8.0+cu128)
#   <InstallDir>\SoulX-FlashHead\models\...          SoulX-FlashHead-1_3B (Model_Lite +
#                                                   VAE_LTX) and wav2vec2-base-960h
#   <InstallDir>\SoulX-FlashHead\mtnode_server.py    the MTNode HTTP wrapper (this pack)
#
# HARD RULES (agreed with the user):
#   * flash-attn must install and its kernel must run; otherwise the install FAILS.
#     torch is pinned to 2.8.0+cu128 so the official Windows wheel
#     (flash_attn 2.8.3+cu128torch2.8.0) matches this venv.
#   * SageAttention is the second default optimisation: attempted, and reported, but a
#     failure only warns (flash-attn already carries the real-time path).
#   * the smoke step loads the real weights and runs a 4-chunk streaming benchmark
#     (printed as BENCH-OK ..., first chunk is torch.compile warm-up and is not counted),
#     so "install finished" means the model really runs.
#
# HARD RULE -- PURE ASCII, NO BOM. Windows PowerShell 5.1 decodes a BOM-less .ps1 with the
# machine ANSI code page; non-ASCII bytes break parsing on Chinese Windows. All user-facing
# text lives in ../steps.json (messages table), this script only prints stable error codes.
#
# Step ids must match ../steps.json: disk / source / venv / flashattn / sage / weights / files / smoke
# =============================================================================
param(
  [string]$InstallDir = (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)),
  [int]$DiskHintGb = 30,
  [switch]$Force,
  [switch]$SkipWeights,
  [switch]$SkipSmoke
)

try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
$OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$env:PYTHONIOENCODING = 'utf-8'
$ErrorActionPreference = 'Stop'

$env:PIP_CONFIG_FILE = 'nul'
$env:PIP_EXTRA_INDEX_URL = ''

# Explicit launcher path: the host may start us with the Store alias "powershell", and
# $env:PATH inside a child call would otherwise re-resolve to something odd.
$PS_LAUNCHER = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
if (-not (Test-Path -LiteralPath $PS_LAUNCHER)) { $PS_LAUNCHER = 'powershell.exe' }

# PyPI mirror chain -- Tsinghua FIRST. The aliyun file CDN is not reliable for the big wheels
# (measured 2026-10: the 53.8MB opencv_contrib_python wheel arrived at ~85 KB/s from aliyun
# while the same file finished in seconds from Tsinghua / files.pythonhosted.org), and pip has
# no stall timeout, so "aliyun first" is exactly how this install appeared to hang forever.
$PipIndexes = @(
  'https://pypi.tuna.tsinghua.edu.cn/simple',
  'https://mirrors.aliyun.com/pypi/simple',
  'https://pypi.org/simple'
)
$PipCommon = @('--timeout', '30', '--retries', '4', '--disable-pip-version-check')

. (Join-Path $PSScriptRoot 'step.ps1')

$InstallDir = [System.IO.Path]::GetFullPath($InstallDir)
$RepoRoot = Join-Path $InstallDir 'SoulX-FlashHead'
$VenvDir = Join-Path $RepoRoot 'venv'
$VenvPy = Join-Path $VenvDir 'Scripts\python.exe'
$ModelsDir = Join-Path $RepoRoot 'models'
$StepIds = @('disk', 'source', 'venv', 'flashattn', 'sage', 'weights', 'files', 'smoke')

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
  Write-Host "[flashhead-install] $Text"
}

# --- python -------------------------------------------------------------------
function Find-BasePython {
  if ($env:MT_FLASHHEAD_PYTHON -and (Test-Path $env:MT_FLASHHEAD_PYTHON)) { return $env:MT_FLASHHEAD_PYTHON }
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
  # Nothing usable on PATH (a fresh Windows box only carries the Store Python, or none at
  # all): the shared helper takes over -- py launcher reports -> uv -> python-build-standalone
  # from npmmirror. Byte-identical copy of pack-python/base_python.ps1 (h3 / music3 / yue2).
  $helper = Join-Path $PSScriptRoot 'base_python.ps1'
  if (Test-Path -LiteralPath $helper) {
    Write-Head 'no suitable base python on PATH; asking base_python.ps1 to fetch one'
    try {
      $out = & $PS_LAUNCHER -NoProfile -ExecutionPolicy Bypass -File $helper -WantedCsv '3.11,3.12' -Module flashhead -GpuRequired auto 2>&1
      foreach ($line in $out) {
        Write-Head ("[base-python] " + $line)
        if ("$line" -match '^PYTHON=(.+)$') {
          $p = $Matches[1].Trim()
          if (Test-Path -LiteralPath $p) { return $p }
        }
      }
    } catch {
      Write-Head ("base_python.ps1 failed: " + $_.Exception.Message)
    }
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

function Invoke-Pip {
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

function Get-DirBytes {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return [long]0 }
  $sum = (Get-ChildItem -LiteralPath $Path -Recurse -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
  if (-not $sum) { return [long]0 }
  return [long]$sum
}

# pip download under a stall watchdog.
#
# Why: pip's --timeout is a per-socket-read timeout, so a mirror that accepts the connection
# and then trickles a 50MB wheel at <100 KB/s never trips it -- pip just sits there printing
# nothing for tens of minutes. That is the reported "stuck on Downloading
# opencv_contrib_python" symptom.
# Here we watch the size of the download directory instead: no growth for $StallSec means the
# mirror is useless right now -> kill pip and let the caller move to the next mirror.
# Returns pip's exit code, or 2 when the watchdog fired.
function Invoke-PipDownloadWatch {
  param([string]$Py, [string[]]$PipArgs, [string]$WatchDir, [int]$StallSec = 75)
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $log = Join-Path $env:TEMP ('flashhead-pip-' + [guid]::NewGuid().ToString('N') + '.log')
  $errLog = $log + '.err'
  try {
    if (-not (Test-Path -LiteralPath $WatchDir)) { New-Item -ItemType Directory -Force $WatchDir | Out-Null }
    $proc = Start-Process -FilePath $Py -ArgumentList (@('-m', 'pip') + $PipArgs) -PassThru -WindowStyle Hidden -RedirectStandardOutput $log -RedirectStandardError $errLog
    # PowerShell 5.1 quirk: with -RedirectStandard* the returned object reports an EMPTY
    # ExitCode unless its handle is touched first (silently turned "0" into "failed").
    $null = $proc.Handle
    $last = Get-DirBytes $WatchDir
    $lastGrow = Get-Date
    while (-not $proc.HasExited) {
      Start-Sleep -Seconds 10
      $now = Get-DirBytes $WatchDir
      if ($now -gt $last) {
        $mb = [math]::Round($now / 1MB, 1)
        $rate = [math]::Round(($now - $last) / 1MB / 10, 2)
        Write-Head ("wheels {0} MB (+{1} MB/s)" -f $mb, $rate)
        $last = $now
        $lastGrow = Get-Date
      } elseif (((Get-Date) - $lastGrow).TotalSeconds -ge $StallSec) {
        Write-Head ("stalled: no new bytes for ${StallSec}s, killing pip and switching mirror")
        try { Stop-Process -Id $proc.Id -Force } catch { }
        return 2
      }
    }
    $proc.WaitForExit()
    foreach ($f in @($log, $errLog)) {
      if (Test-Path $f) {
        foreach ($line in (Get-Content $f -Tail 40 -Encoding UTF8)) { if ("$line".Trim()) { Write-Head "$line" } }
      }
    }
    return [int]$proc.ExitCode
  } catch {
    Write-Head "pip download error: $($_.Exception.Message)"
    return 1
  } finally {
    foreach ($f in @($log, $errLog)) { Remove-Item $f -Force -ErrorAction SilentlyContinue }
    $ErrorActionPreference = $prev
  }
}

# The inference repo is fetched as a zip (no git dependency, same shape as the other packs).
function Get-RepoZip {
  param([string]$DestZip)
  $urls = @(
    'https://codeload.github.com/Soul-AILab/SoulX-FlashHead/zip/refs/heads/main',
    'https://ghfast.top/https://codeload.github.com/Soul-AILab/SoulX-FlashHead/zip/refs/heads/main',
    'https://gh-proxy.com/https://codeload.github.com/Soul-AILab/SoulX-FlashHead/zip/refs/heads/main'
  )
  foreach ($u in $urls) {
    if (Download-File -Url $u -Dest $DestZip -MinBytes 1000000) { return $true }
  }
  return $false
}

# Weights: ModelScope first (mainland), then hf-mirror, then huggingface.co.
function Get-WeightJobs {
  $ms = 'https://modelscope.cn/models'
  $hf1 = 'https://hf-mirror.com'
  $hf2 = 'https://huggingface.co'
  $m = 'Soul-AILab/SoulX-FlashHead-1_3B'
  $w = 'facebook/wav2vec2-base-960h'
  $jobs = @()
  $jobs += @{
    dest = Join-Path $ModelsDir 'SoulX-FlashHead-1_3B\Model_Lite\config.json'
    min  = 200
    paths = @("$ms/$m/resolve/master/Model_Lite/config.json", "$hf1/$m/resolve/main/Model_Lite/config.json", "$hf2/$m/resolve/main/Model_Lite/config.json")
  }
  $jobs += @{
    dest = Join-Path $ModelsDir 'SoulX-FlashHead-1_3B\Model_Lite\diffusion_pytorch_model.safetensors'
    min  = 5500000000
    paths = @("$ms/$m/resolve/master/Model_Lite/diffusion_pytorch_model.safetensors", "$hf1/$m/resolve/main/Model_Lite/diffusion_pytorch_model.safetensors", "$hf2/$m/resolve/main/Model_Lite/diffusion_pytorch_model.safetensors")
  }
  $jobs += @{
    dest = Join-Path $ModelsDir 'SoulX-FlashHead-1_3B\VAE_LTX\config.json'
    min  = 200
    paths = @("$ms/$m/resolve/master/VAE_LTX/config.json", "$hf1/$m/resolve/main/VAE_LTX/config.json", "$hf2/$m/resolve/main/VAE_LTX/config.json")
  }
  $jobs += @{
    dest = Join-Path $ModelsDir 'SoulX-FlashHead-1_3B\VAE_LTX\diffusion_pytorch_model.safetensors'
    min  = 1500000000
    paths = @("$ms/$m/resolve/master/VAE_LTX/diffusion_pytorch_model.safetensors", "$hf1/$m/resolve/main/VAE_LTX/diffusion_pytorch_model.safetensors", "$hf2/$m/resolve/main/VAE_LTX/diffusion_pytorch_model.safetensors")
  }
  $jobs += @{
    dest = Join-Path $ModelsDir 'wav2vec2-base-960h\config.json'
    min  = 200
    paths = @("$ms/$w/resolve/master/config.json", "$hf1/$w/resolve/main/config.json", "$hf2/$w/resolve/main/config.json")
  }
  $jobs += @{
    dest = Join-Path $ModelsDir 'wav2vec2-base-960h\preprocessor_config.json'
    min  = 100
    paths = @("$ms/$w/resolve/master/preprocessor_config.json", "$hf1/$w/resolve/main/preprocessor_config.json", "$hf2/$w/resolve/main/preprocessor_config.json")
  }
  $jobs += @{
    dest = Join-Path $ModelsDir 'wav2vec2-base-960h\model.safetensors'
    min  = 300000000
    paths = @("$ms/$w/resolve/master/model.safetensors", "$hf1/$w/resolve/main/model.safetensors", "$hf2/$w/resolve/main/model.safetensors")
  }
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

  # -- source -----------------------------------------------------------------
  Step-Begin 'source' '' 6
  try {
    if (-not (Test-Path (Join-Path $RepoRoot 'generate_video.py'))) {
      $zip = Join-Path $env:TEMP ('flashhead-' + [guid]::NewGuid().ToString('N') + '.zip')
      if (-not (Get-RepoZip -DestZip $zip)) { throw 'repo_download_failed' }
      $tmp = Join-Path $env:TEMP ('flashhead-' + [guid]::NewGuid().ToString('N'))
      Expand-Archive -Path $zip -DestinationPath $tmp -Force
      $inner = Get-ChildItem $tmp -Directory | Select-Object -First 1
      if (-not $inner) { throw 'repo_unzip_empty' }
      if (Test-Path $RepoRoot) { Remove-Item -Recurse -Force $RepoRoot }
      Move-Item $inner.FullName $RepoRoot
      Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
      Remove-Item -Force $zip -ErrorAction SilentlyContinue
    }
    if (-not (Test-Path (Join-Path $RepoRoot 'flash_head'))) { throw 'repo_missing_flash_head' }
    Step-Ok 'source' 12
  } catch {
    $tail = "$($_.Exception.Message)"
    Step-Fail 'source' (New-FailCode 'flashhead.source.prep_failed' @{ tail = $tail } "repo prepare failed: $tail")
    Skip-Rest 'source'
    throw
  }

  # -- venv / torch -----------------------------------------------------------
  Step-Begin 'venv' '' 14
  try {
    if (-not (Test-Path $VenvPy)) {
      $base = Find-BasePython
      if (-not $base) { throw 'python_missing' }
      Write-Head "base python: $base"
      & $base -m venv $VenvDir
      if (-not (Test-Path $VenvPy)) { throw 'venv_create_failed' }
    }
    Invoke-Pip -Py $VenvPy -PipArgs (@('install', '--upgrade', 'pip', '-i', $PipIndexes[0]) + $PipCommon) | Out-Null
    # torch is pinned to 2.8.0+cu128 because that is the version the Windows flash-attn
    # wheel is built against (the official README says 2.7.1, which has no Windows wheel).
    $torchOk = $false
    $cur = Invoke-Py -Py $VenvPy -PyArgs @('-c', 'import torch;print(torch.__version__);print(1 if torch.cuda.is_available() else 0)')
    if ($cur -match '^2\.8\.0' -and $cur -match '(\r?\n)1\s*$') { $torchOk = $true; Write-Head 'existing torch 2.8.0 is CUDA-capable' }
    $torchIdx = @(
      'https://mirror.sjtu.edu.cn/pytorch-wheels/cu128',
      'https://mirrors.aliyun.com/pytorch-wheels/cu128',
      'https://download.pytorch.org/whl/cu128'
    )
    # Offline / resumable path: a 3.4GB wheel over a flaky link is the single most common
    # way this step dies, so a directory of pre-downloaded wheels wins over any index.
    # Set MT_FLASHHEAD_TORCH_WHEEL_DIR, or drop the wheels into <InstallDir>\wheels.
    $wheelDirs = @()
    if ($env:MT_FLASHHEAD_TORCH_WHEEL_DIR) { $wheelDirs += $env:MT_FLASHHEAD_TORCH_WHEEL_DIR }
    $wheelDirs += (Join-Path $InstallDir 'wheels')
    foreach ($wd in $wheelDirs) {
      if ($torchOk) { break }
      if (-not (Test-Path -LiteralPath $wd)) { continue }
      $tw = @(Get-ChildItem -LiteralPath $wd -Filter 'torch-*.whl' -ErrorAction SilentlyContinue)
      if (-not $tw.Count) { continue }
      Write-Head "local torch wheels: $wd"
      $files = @($tw | ForEach-Object { $_.FullName })
      foreach ($vw in @(Get-ChildItem -LiteralPath $wd -Filter 'torchvision-*.whl' -ErrorAction SilentlyContinue)) { $files += $vw.FullName }
      Invoke-Pip -Py $VenvPy -PipArgs @('uninstall', '-y', 'torch', 'torchvision', 'torchaudio') | Out-Null
      $code = Invoke-Pip -Py $VenvPy -PipArgs (@('install', '--force-reinstall') + $files + @('-i', $PipIndexes[0]) + $PipCommon)
      if ($code -ne 0) { Write-Head "local wheel install failed in $wd"; continue }
      $probe = Invoke-Py -Py $VenvPy -PyArgs @('-c', 'import torch;print(torch.__version__);print(1 if torch.cuda.is_available() else 0)')
      Write-Head "torch probe: $probe"
      if ($probe -match '^2\.8\.0' -and $probe -match '(\r?\n)1\s*$') { $torchOk = $true }
    }
    foreach ($idx in $torchIdx) {
      if ($torchOk) { break }
      Write-Head "torch index: $idx"
      Invoke-Pip -Py $VenvPy -PipArgs @('uninstall', '-y', 'torch', 'torchvision', 'torchaudio') | Out-Null
      $code = Invoke-Pip -Py $VenvPy -PipArgs @('install', '--force-reinstall', 'torch==2.8.0', 'torchvision==0.23.0', '--index-url', $idx)
      if ($code -ne 0) { Write-Head "torch install failed on $idx"; continue }
      $probe = Invoke-Py -Py $VenvPy -PyArgs @('-c', 'import torch;print(torch.__version__);print(1 if torch.cuda.is_available() else 0)')
      Write-Head "torch probe: $probe"
      if ($probe -match '^2\.8\.0' -and $probe -match '(\r?\n)1\s*$') { $torchOk = $true; break }
      Write-Head "not a usable CUDA 2.8.0 build from $idx"
    }
    if (-not $torchOk) { throw 'torch_cuda_unavailable' }
    Step-Ok 'venv' 24

    # The repo's own requirements.txt pins Linux/CUDA only pieces (nvidia-nccl-cu12,
    # xformers, decord) that have no Windows wheels and would abort the whole install.
    # The pack ships the Windows subset the single-GPU streaming path actually imports.
    $reqFile = Join-Path (Split-Path -Parent $PSScriptRoot) 'requirements.txt'
    if (-not (Test-Path $reqFile)) { throw 'requirements.txt missing in pack' }
    $reqOk = $false
    # Two phases on purpose:
    #   1. pull the wheels of the DIRECT requirements into <InstallDir>\wheels\pip, one mirror
    #      at a time, each attempt under the stall watchdog (a stuck mirror costs one retry
    #      instead of an endless silent download);
    #   2. pip install -r with --find-links on that directory, so every big wheel (opencv,
    #      opencv-contrib, mediapipe, transformers...) comes from local disk and only the small
    #      transitive deps are fetched. --no-deps in phase 1 is what keeps a PyPI torch wheel
    #      (CPU-only!) out of the wheelhouse: the venv torch must stay 2.8.0+cu128.
    $wheelhouse = Join-Path $InstallDir 'wheels\pip'
    $haveWheels = $false
    foreach ($mi in $PipIndexes) {
      Write-Head "requirements download: $mi"
      Write-Head ("wheels {0} MB already cached in the wheelhouse" -f [math]::Round((Get-DirBytes $wheelhouse) / 1MB, 1))
      $code = Invoke-PipDownloadWatch -Py $VenvPy -PipArgs (@('download', '--no-deps', '-r', $reqFile, '-d', $wheelhouse, '-i', $mi) + $PipCommon) -WatchDir $wheelhouse -StallSec 75
      if ($code -eq 0) { $haveWheels = $true; break }
      Write-Head "download from $mi gave up (exit=$code)"
    }
    if ($haveWheels) {
      $stale = @(Get-ChildItem -LiteralPath $wheelhouse -Filter 'torch*.whl' -ErrorAction SilentlyContinue)
      foreach ($w in $stale) { Write-Head "removing non-CUDA torch wheel from the wheelhouse: $($w.Name)"; Remove-Item -LiteralPath $w.FullName -Force -ErrorAction SilentlyContinue }
      $mb = [math]::Round((Get-DirBytes $wheelhouse) / 1MB, 1)
      Write-Head "wheelhouse ready: $mb MB in $wheelhouse"
    }
    foreach ($mi in $PipIndexes) {
      if ($reqOk) { break }
      Write-Head "requirements index: $mi"
      $fl = @()
      if ($haveWheels) { $fl = @('--find-links', $wheelhouse) }
      $code = Invoke-Pip -Py $VenvPy -PipArgs ((@('install', '-r', $reqFile, '-i', $mi) + $fl) + $PipCommon)
      if ($code -eq 0) { $reqOk = $true; break }
      Write-Head "requirements failed on $mi"
    }
    if (-not $reqOk) { throw 'requirements_failed' }
    Invoke-Pip -Py $VenvPy -PipArgs (@('install', 'ninja', '-i', $PipIndexes[0]) + $PipCommon) | Out-Null
    Step-Ok 'venv' 40
  } catch {
    $tail = "$($_.Exception.Message)"
    $code = 'flashhead.venv.pip_failed'
    if ($tail -match 'python_missing') { $code = 'flashhead.venv.python_missing' }
    if ($tail -match 'torch') { $code = 'flashhead.venv.torch_failed' }
    if ($tail -match 'requirements') { $code = 'flashhead.venv.requirements_failed' }
    Step-Fail 'venv' (New-FailCode $code @{ tail = $tail } "env prep failed: $tail")
    Skip-Rest 'venv'
    throw
  }

  # -- flash-attn (MANDATORY) -------------------------------------------------
  Step-Begin 'flashattn' '' 44
  try {
    $faPy = Join-Path $PSScriptRoot 'flash_attn_install.py'
    if (-not (Test-Path $faPy)) { throw 'flash_attn_install.py missing' }
    Write-Head 'installing flash-attn (mandatory acceleration)'
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $faOut = ''
    try {
      $faOut = (& $VenvPy $faPy 2>&1 | ForEach-Object { $s = [string]$_; Write-Head $s; $s }) -join "`n"
      $faCode = $LASTEXITCODE
    } finally {
      $ErrorActionPreference = $prevEap
    }
    $faTail = ($faOut -split "`n" | Where-Object { $_ -match 'FLASHATTN-|FAILED|\[pip\]' } | Select-Object -Last 3) -join ' | '
    if ($faCode -ne 0 -or $faOut -notmatch 'FLASHATTN-OK=1') {
      throw ("flash-attn failed exit=$faCode " + $faTail)
    }
    Step-Ok 'flashattn' 56
  } catch {
    $tail = "$($_.Exception.Message)"
    Step-Fail 'flashattn' (New-FailCode 'flashhead.flashattn.failed' @{ tail = $tail } "flash-attn mandatory step failed: $tail")
    Skip-Rest 'flashattn'
    throw
  }

  # -- sageattention (default optimisation, non-fatal) ------------------------
  Step-Begin 'sage' '' 58
  try {
    $sagePy = Join-Path $PSScriptRoot 'sage_install.py'
    if (-not (Test-Path $sagePy)) { throw 'sage_install.py missing' }
    Write-Head 'installing SageAttention (default optimisation)'
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $sageOut = ''
    try {
      $sageOut = (& $VenvPy $sagePy 2>&1 | ForEach-Object { $s = [string]$_; Write-Head $s; $s }) -join "`n"
      $sageCode = $LASTEXITCODE
    } finally {
      $ErrorActionPreference = $prevEap
    }
    if ($sageCode -ne 0 -or $sageOut -notmatch 'SAGE-OK=1') {
      $sageTail = ($sageOut -split "`n" | Where-Object { $_ -match 'SAGE-|FAILED' } | Select-Object -Last 2) -join ' | '
      Write-Head "WARN sage skipped: $sageTail"
      Write-Host "::warning:: SageAttention unavailable ($sageTail)"
    }
    Step-Ok 'sage' 62
  } catch {
    Write-Head "WARN sage skipped: $($_.Exception.Message)"
    Step-Ok 'sage' 62
  }

  # -- weights ----------------------------------------------------------------
  Step-Begin 'weights' '' 64
  if ($SkipWeights) {
    Step-Skip 'weights'
  } else {
    try {
      $jobs = Get-WeightJobs
      $i = 0
      foreach ($j in $jobs) {
        $i++
        $okOne = $false
        foreach ($u in $j.paths) {
          if (Download-File -Url $u -Dest $j.dest -MinBytes $j.min) { $okOne = $true; break }
        }
        if (-not $okOne) { throw "weight_failed: $($j.dest)" }
        Step-Ok 'weights' (64 + [int]([double]$i / $jobs.Count * 24))
      }
      Step-Ok 'weights' 88
    } catch {
      $tail = "$($_.Exception.Message)"
      Step-Fail 'weights' (New-FailCode 'flashhead.weights.failed' @{ tail = $tail } "weights failed: $tail")
      Skip-Rest 'weights'
      throw
    }
  }

  # -- files ------------------------------------------------------------------
  Step-Begin 'files' '' 90
  try {
    if (-not (Test-Path (Join-Path $RepoRoot 'generate_video.py'))) { throw 'repo missing' }
    if (-not (Test-Path $VenvPy)) { throw 'venv missing' }
    if (-not $SkipWeights) {
      foreach ($j in (Get-WeightJobs)) {
        if (-not (Test-Path $j.dest)) { throw "weight missing: $($j.dest)" }
        if ((Get-Item $j.dest).Length -lt $j.min) { throw "weight too small: $($j.dest)" }
      }
    }
    $serverSrc = Join-Path (Split-Path -Parent $PSScriptRoot) 'server.py'
    if (-not (Test-Path $serverSrc)) { throw 'server.py missing in pack' }
    Copy-Item $serverSrc (Join-Path $RepoRoot 'mtnode_server.py') -Force
    $faProbe = Invoke-Py -Py $VenvPy -PyArgs @('-c', 'import flash_attn;print("FAOK", flash_attn.__version__)')
    if ("$faProbe" -notmatch 'FAOK') { throw "flash_attn not importable: $faProbe" }
    # flash_head is a namespace package (no __init__.py): it is only importable when the repo
    # root is the working directory (or on sys.path), exactly like the upstream scripts assume.
    $ins = ''
    Push-Location $RepoRoot
    try {
      $ins = Invoke-Py -Py $VenvPy -PyArgs @('-c', 'import flash_head.inference as i;print("FHOK")')
    } finally {
      Pop-Location
    }
    if ("$ins" -notmatch 'FHOK') { throw "flash_head not importable: $ins" }
    Step-Ok 'files' 94
  } catch {
    $tail = "$($_.Exception.Message)"
    Step-Fail 'files' (New-FailCode 'flashhead.files.missing' @{ tail = $tail } "layout incomplete: $tail")
    Skip-Rest 'files'
    throw
  }

  # -- smoke: real weights + real streaming benchmark -------------------------
  Step-Begin 'smoke' '' 95
  if ($SkipSmoke) {
    Step-Skip 'smoke'
  } else {
    $logFile = Join-Path $InstallDir 'smoke-flashhead.log'
    try {
      $prevEap = $ErrorActionPreference
      $ErrorActionPreference = 'Continue'
      $smokeOut = ''
      try {
        $smokeOut = (& $VenvPy (Join-Path $RepoRoot 'mtnode_server.py') '--install-dir' $InstallDir '--check' 2>&1 | ForEach-Object { $s = [string]$_; Write-Head $s; $s }) -join "`n"
        $smokeCode = $LASTEXITCODE
      } finally {
        $ErrorActionPreference = $prevEap
      }
      Set-Content -Path $logFile -Value $smokeOut -Encoding UTF8
      if ($smokeCode -ne 0 -or $smokeOut -notmatch 'BENCH-OK') {
        $tail = ($smokeOut -split "`n" | Where-Object { $_ -match 'CHECK-FAIL|Error|error' } | Select-Object -Last 3) -join ' | '
        throw ("smoke exit=$smokeCode " + $tail)
      }
      $benchLine = ($smokeOut -split "`n" | Where-Object { $_ -match 'BENCH-OK' } | Select-Object -Last 1)
      $accelLine = ($smokeOut -split "`n" | Where-Object { $_ -match 'ACCEL ' } | Select-Object -Last 1)
      Write-Head $benchLine
      Write-Head $accelLine
      Step-Ok 'smoke' 99
    } catch {
      $tail = "$($_.Exception.Message)"
      Step-Fail 'smoke' (New-FailCode 'flashhead.smoke.failed' @{ tail = $tail } "smoke failed: $tail")
      throw
    }
  }

  Set-Content -Path (Join-Path $InstallDir '.install-ok') -Value ("ok`n" + (Get-Date).ToString('o')) -Encoding ASCII
  Write-Head 'install finished'
  exit 0
} catch {
  Write-Head "install failed: $($_.Exception.Message)"
  exit 1
}
