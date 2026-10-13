<#
.SYNOPSIS
  Create .venv with CUDA torch (system-site-packages) and install requirements.

.PARAMETER CudaPython
  Optional path to a Python that already has CUDA-capable torch.
  If omitted, probes common conda/PATH locations (seg is only a fallback hint).
#>
[CmdletBinding()]
param(
    [string]$CudaPython = ""
)

# Force UTF-8 for this process so the host (which decodes our stdout as UTF-8)
# and every native tool we spawn (pip / git / python) agree on one encoding.
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


# -- CN mirrors (single source of truth: repo root cn-mirrors.js; see docs/mirror-sources.md) --
# A machine-wide pip.ini often carries an unreachable extra-index-url (NVIDIA PyIndex's
# pypi.ngc.nvidia.com is the usual one). Passing --index-url on the command line does NOT
# override extra-index-url, so every package wastes 5 retries. Setting the three PIP_*
# variables below overrides index / extra-index / trusted-host inside this process and every
# child (pip / git / npm inherit them). Do NOT add `pip --isolated`: it ignores environment
# variables, which lets that unreachable extra-index back in.
#
# pip index fallback chain, same order as cn-mirrors.js pipIndexChain():
# Tsinghua -> aliyun -> USTC -> official PyPI (official is the last resort only).
# A mirror that has not synced one sub-package otherwise fails the whole step on a single
# "No matching distribution found" line (2026-10 real case on the h3 pack:
# comfyui-workflow-templates-media-assets-02==0.1.11 was missing on both Tsinghua and USTC).
$PipIndexChain = @(
    "https://pypi.tuna.tsinghua.edu.cn/simple",
    "https://mirrors.aliyun.com/pypi/simple/",
    "https://mirrors.ustc.edu.cn/pypi/simple/",
    "https://pypi.org/simple"
)
$PipTrustedHostChain = @(
    "pypi.tuna.tsinghua.edu.cn",
    "mirrors.aliyun.com",
    "mirrors.ustc.edu.cn",
    "pypi.org"
)
$PipChainStart = 0
$env:PIP_INDEX_URL       = if ($env:MTNODE_PIP_INDEX) { $env:MTNODE_PIP_INDEX } else { $PipIndexChain[0] }
$env:PIP_EXTRA_INDEX_URL = $env:PIP_INDEX_URL
$env:PIP_TRUSTED_HOST    = "pypi.tuna.tsinghua.edu.cn"
if (-not $env:HF_ENDPOINT)         { $env:HF_ENDPOINT = "https://hf-mirror.com" }
if (-not $env:HF_HUB_DISABLE_XET)  { $env:HF_HUB_DISABLE_XET = "1" }
if (-not $env:npm_config_registry) { $env:npm_config_registry = "https://registry.npmmirror.com" }
Write-Host "[music3-install] mirrors: pip=$env:PIP_INDEX_URL (pip chain Tsinghua -> aliyun -> USTC -> official; one index=N/4 line per attempt) | weights=ModelScope -> $env:HF_ENDPOINT | npm=$env:npm_config_registry"

Write-Host "============================================================"
Write-Host "[music3-setup] About the China mirrors (required; especially important when this machine is on a mainland China network):"
Write-Host "  - Python packages: Tsinghua mirror pypi.tuna.tsinghua.edu.cn first, then aliyun / USTC, official PyPI last (every pip call below walks that chain; override the first index with MT_MUSIC_PIP_INDEX)"
Write-Host "  - The diffusers dependency comes from GitHub: if the direct connection fails we retry with the ghproxy mirror prefix"
Write-Host "  - Model weights: huggingface.co is not reachable directly, so we go through hf-mirror.com; Comfy weights prefer ModelScope"
Write-Host "============================================================"
$Root = Split-Path -Parent $PSScriptRoot
$VenvDir = Join-Path $Root ".venv"
$VenvPy = Join-Path $VenvDir "Scripts\python.exe"

# Run one pip install against the index chain above: Tsinghua, then aliyun, then USTC,
# official PyPI last. First success wins; when every index fails, name the missing
# distribution and the sources that were tried, so the install window says what is wrong.
# IMPORTANT: $PipArgs are the arguments AFTER the 'install' subcommand (e.g. "-U", "pip" or
# "-r", <requirements file>). The "-m pip install" part is added here, so passing "install" again
# would make pip look for a package literally named "install" (real 2026-10 failure mode).
function Install-PipWithFallback {
    param([string[]]$PipArgs)
    $last = 0
    $tail = @()
    for ($i = $PipChainStart; $i -lt $PipIndexChain.Count; $i++) {
        $idx = $PipIndexChain[$i]
        $host_ = $PipTrustedHostChain[$i]
        $n = $i + 1
        Write-Host "[music3-setup] pip index=$n/$($PipIndexChain.Count) host=$host_"
        $env:PIP_INDEX_URL = $idx
        $env:PIP_EXTRA_INDEX_URL = $idx
        $env:PIP_TRUSTED_HOST = $host_
        $prevEap = $ErrorActionPreference
        $ErrorActionPreference = "Continue"
        try {
            $out = @(& $VenvPy -m pip install @PipArgs 2>&1)
            $last = $LASTEXITCODE
        } finally {
            $ErrorActionPreference = $prevEap
        }
        foreach ($l in $out) { Write-Host ([string]$l) }
        $tail = @($out | Select-Object -Last 30)
        if ($last -eq 0) { return }
        if ($n -lt $PipIndexChain.Count) {
            Write-Host "[music3-setup] pip index=$n/$($PipIndexChain.Count) host=$host_ failed (exit $last); falling back to the next index..."
        }
    }
    $miss = ""
    foreach ($l in $tail) {
        if (([string]$l) -match "(?i)No matching distribution found for\s+([^\s\(]+)") { $miss = $Matches[1] }
    }
    $tried = ($PipIndexChain -join " -> ")
    if ($miss) {
        throw "pip install failed: no matching distribution found for $miss. All pip indexes were tried ($tried). That mirror has not synced this package yet; retry and the script walks to the next index."
    }
    $t = (@($tail | ForEach-Object { ([string]$_).Trim() } | Where-Object { $_ }) -join " / ")
    if ($t.Length -gt 400) { $t = $t.Substring($t.Length - 400) }
    throw "pip install failed on every index ($tried). Last pip output: $t"
}

# Base interpreter for .venv.
#
# The old contract here was "a Python that ALREADY has CUDA torch" (Test-CudaPython), which
# is backwards: installing CUDA torch is what this script does. On a fresh machine (no conda,
# python.org / Microsoft Store Python on PATH, no torch) every candidate failed and the
# install died with "Need a Python with CUDA torch. Pass -CudaPython <path> or set
# MT_MUSIC_CUDA_PYTHON." before torch was ever installed.
#
# Now the gate is the INTERPRETER VERSION, and when nothing usable exists we fetch one
# ourselves (uv, else python-build-standalone from npmmirror). -CudaPython /
# MT_MUSIC_CUDA_PYTHON / the legacy .cuda-python marker stay honoured as optional overrides.
# The shared helper keeps the probe chain identical across h3 / music3 / yue2
# (single source: pack-python/base_python.ps1).
function Get-BasePython {
    $helper = Join-Path $PSScriptRoot "base_python.ps1"
    if (-not (Test-Path -LiteralPath $helper)) {
        throw "base_python.ps1 is missing next to setup_env.ps1 (incomplete pack: reinstall or update the plugin resources)"
    }
    # NB: versions travel as ONE comma-joined -WantedCsv value -- `powershell -File` binds
    # array parameters positionally, so `-Wanted 3.11 3.12 -Module music3` would hand "3.12"
    # to the next parameter (the helper refuses such a value by design). Never pass an empty
    # string either: PowerShell drops it and the call dies on "Missing an argument".
    $hArgs = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $helper, "-WantedCsv", "3.11,3.12", "-Module", "music3", "-GpuRequired", "auto")
    $hCache = if ($env:MT_MUSIC_PYTHON_CACHE) { $env:MT_MUSIC_PYTHON_CACHE } else { "" }
    if ($hCache) { $hArgs += @("-CacheRoot", $hCache) }
    if ($CudaPython) { $hArgs += @("-ExplicitPython", $CudaPython) }
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $out = @(& $PS_EXE @hArgs 2>&1)
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $prevEap
    }
    $py = ""; $ver = ""; $src = ""; $fail = ""; $reason = ""
    foreach ($l in $out) {
        $s = [string]$l
        Write-Host $s
        if ($s -match '^\s*PYTHON=(.+)$') { $py = $Matches[1].Trim() }
        elseif ($s -match '^\s*VERSION=(.+)$') { $ver = $Matches[1].Trim() }
        elseif ($s -match '^\s*SOURCE=(.+)$') { $src = $Matches[1].Trim() }
        elseif ($s -match '^\s*FAILCODE=(.+)$') { $fail = $Matches[1].Trim() }
        elseif ($s -match '^\s*REASON=(.+)$') { $reason = $Matches[1].Trim() }
    }
    if ($code -eq 0 -and $py -and (Test-Path -LiteralPath $py)) {
        Write-Host "Selected base python: $py (Python $ver, via $src)"
        return $py
    }
    throw ("python_unusable [" + $fail + "] " + $reason)
}

# Hardware line: nothing below can work without an NVIDIA card. install.ps1 gates this
# properly (it fails the torch step with music3.gpu.none before calling us); a direct
# `.\scripts\setup_env.ps1` run gets the same probe printed instead of a mystery later.
function Write-GpuLine {
    $helper = Join-Path $PSScriptRoot "base_python.ps1"
    if (-not (Test-Path -LiteralPath $helper)) { return }
    try {
        & $PS_EXE -NoProfile -ExecutionPolicy Bypass -File $helper -SkipGpuProbe -Module music3 -GpuRequired auto -MinDriverMajor 580 2>&1 |
            ForEach-Object { Write-Host $_ }
    } catch {
        Write-Host "[music3-setup] gpu probe could not run: $($_.Exception.Message)"
    }
}

Write-GpuLine

if (-not (Test-Path $VenvPy)) {
    $basePy = Get-BasePython
    # Isolated venv, no --system-site-packages: the CUDA torch is installed INTO this venv by
    # install.ps1 (previously the script re-used whatever torch the base interpreter had,
    # which is exactly the prerequisite that a fresh machine cannot satisfy).
    Write-Host "Creating isolated .venv from $basePy (no system-site-packages)..."
    & $basePy -m venv $VenvDir
    if ($LASTEXITCODE -ne 0) { throw "venv creation failed" }
    # Persist choice for later installs / agent
    Set-Content -Path (Join-Path $Root ".cuda-python") -Value $basePy -Encoding utf8
}

# Explicit override for this package stays on top of the pinned defaults above: it replaces
# the FIRST index of the chain, the aliyun / USTC / official fallbacks stay in place.
if ($env:MT_MUSIC_PIP_INDEX) {
    $PipIndexChain[0] = $env:MT_MUSIC_PIP_INDEX
    Write-Host "[music3-setup] pip chain start overridden by MT_MUSIC_PIP_INDEX: $($PipIndexChain[0])"
}
Write-Host "Installing requirements..."
try { Install-PipWithFallback -PipArgs @("-U", "pip") }
catch { throw "pip upgrade failed: $($_.Exception.Message)" }

# CUDA torch goes INTO this venv (same reasoning as the h3 pack). The venv is isolated, so the
# old "reuse the base interpreter's torch" arrangement is gone -- and it was the reason a fresh
# machine could not install at all. PyPI mirrors only carry the CPU build on Windows, so the
# wheel must come from the pytorch wheel index (aliyun mirror first, official last), exactly
# like the torch chain in cn-mirrors.js. Requirements are installed afterwards: nothing in
# requirements.txt pins torch, and installing them first would let a CPU build slip in.
Write-Host "Installing CUDA torch into the venv (torch==2.9.1+cu130)..."
$torchIdx = if ($env:MT_MUSIC_TORCH_INDEX) { $env:MT_MUSIC_TORCH_INDEX } else { "https://mirrors.aliyun.com/pytorch-wheels/cu130" }
$torchIdxOfficial = "https://download.pytorch.org/whl/cu130"
$torchPkgs = @("torch==2.9.1+cu130", "torchvision==0.24.1+cu130", "torchaudio==2.9.1+cu130")
& $VenvPy -m pip install --index-url $torchIdx @torchPkgs
if ($LASTEXITCODE -ne 0) {
    Write-Host "torch cu130 aliyun mirror failed; retrying with the pytorch official index (last resort)..."
    & $VenvPy -m pip install --index-url $torchIdxOfficial @torchPkgs
    if ($LASTEXITCODE -ne 0) {
        throw "torch cu130 install failed (aliyun mirror + official). Update the NVIDIA driver to one that supports CUDA 13.0, then retry."
    }
}
$torchOk = (& $VenvPy -c "import torch;print('y' if torch.cuda.is_available() else 'n')" 2>$null)
if ("$torchOk".Trim() -ne "y") {
    throw "torch cu130 loaded but torch.cuda.is_available() is False. Update the NVIDIA driver (>= CUDA 13.0 support) and rerun."
}

try { Install-PipWithFallback -PipArgs @("-r", (Join-Path $Root "requirements.txt")) }
catch {
    Write-Host "requirements install failed (direct, all pip indexes); retrying with the gh proxy git mirror (China mirror)..."
    $req = Join-Path $Root "requirements.txt"
    $reqMirror = Join-Path $env:TEMP "music3-requirements-mirror.txt"
    (Get-Content -LiteralPath $req -Raw -Encoding UTF8) -replace "git\+https://github\.com/", "git+https://ghproxy.com/https://github.com/" | Set-Content -LiteralPath $reqMirror -Encoding utf8
    Install-PipWithFallback -PipArgs @("-r", $reqMirror)
}
& $VenvPy -c "import torch; from diffusers import ModularPipeline; print('torch', torch.__version__, 'cuda', torch.cuda.is_available()); print('diffusers ok')"
if ($LASTEXITCODE -ne 0) { throw "smoke import failed" }
Write-Host "Setup complete."