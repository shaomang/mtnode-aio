<#
.SYNOPSIS
  Install ComfyUI + custom nodes for MiniMax H3 (24G), using a CUDA-capable Python.

.PARAMETER CudaPython
  Optional path to a Python that already has CUDA-capable torch.
  If omitted, probes common conda/PATH locations.

.PARAMETER SourceOnly
  Only make sure the ComfyUI source tree is in place (clone when missing), then exit 0.
  install.ps1 calls it this way for its "comfy" step, so the venv / torch / dependency work
  stays in the single (idempotent) full run that the "venv" step performs.
  Without this switch the script behaves exactly as before (source + venv + torch + deps).
#>
[CmdletBinding()]
param(
    [string]$CudaPython = "",
    [switch]$SourceOnly
)

# Force UTF-8 for this process so the host (which decodes our stdout as UTF-8)
# and every native tool we spawn (pip / git / python) agree on one encoding.
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
$OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$env:PYTHONIOENCODING = 'utf-8'

$ErrorActionPreference = "Stop"

# -- CN mirrors (single source of truth: repo root cn-mirrors.js; see docs/mirror-sources.md) --
# A machine-wide pip.ini often carries an unreachable extra-index-url (NVIDIA PyIndex's
# pypi.ngc.nvidia.com is the usual one). Passing --index-url on the command line does NOT
# override extra-index-url, so every package wastes 5 retries. Setting the three PIP_*
# variables below overrides index / extra-index / trusted-host inside this process and every
# child (pip / git / npm inherit them). Do NOT add `pip --isolated`: it ignores environment
# variables, which lets that unreachable extra-index back in.
#
# pip index fallback chain, same order as cn-mirrors.js pipIndexChain():
# Tsinghua -> Aliyun -> USTC -> official PyPI (official is the last resort only).
# Why the chain exists: a single index fails the whole step when the mirror has simply not
# synced one sub-package yet (2026-10 real case: comfyui-workflow-templates 0.11.78 needs
# comfyui-workflow-templates-media-assets-02==0.1.11; Tsinghua 404, USTC 404, Aliyun + PyPI
# both have it). pip prints "No matching distribution found for <pkg> (from versions: none)"
# and a single-index script dies on that line.
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
Write-Host "[h3-install] mirrors: pip=$env:PIP_INDEX_URL (pip chain Tsinghua -> aliyun -> USTC -> official; one index=N/4 line per attempt) | weights=ModelScope -> $env:HF_ENDPOINT | npm=$env:npm_config_registry"

Write-Host "============================================================"
Write-Host "[h3-setup] China mirror notes (required, especially when this machine sits on a mainland-China network):"
Write-Host "  - Python packages: Tsinghua mirror pypi.tuna.tsinghua.edu.cn first, then aliyun / USTC, official PyPI last (every pip call below walks that chain; override the first index with MT_H3_PIP_INDEX)"
Write-Host "  - torch cu130: the Aliyun mirror mirrors.aliyun.com/pytorch-wheels/cu130 first, falling back to the official download.pytorch.org index last (override with MT_H3_TORCH_INDEX)"
Write-Host "  - Weights come from ModelScope first; if git clone fails, fall back through the ghfast.top / gh-proxy.com / ghproxy.net / ghproxy.com proxies"
Write-Host "============================================================"
$Root = Split-Path -Parent $PSScriptRoot
$ComfyRoot = Join-Path $Root "ComfyUI"
$VenvDir = Join-Path $ComfyRoot "venv"
$VenvPy = Join-Path $VenvDir "Scripts\python.exe"

# Run one pip install against the index chain above: try Tsinghua, then aliyun, then USTC,
# official PyPI last. The first success wins; when every index fails, name the missing
# distribution and the sources that were tried, so the install window says what is really
# wrong instead of pointing at the GPU driver.
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
        Write-Host "[h3-setup] pip index=$n/$($PipIndexChain.Count) host=$host_"
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
            Write-Host "[h3-setup] pip index=$n/$($PipIndexChain.Count) host=$host_ failed (exit $last); falling back to the next index..."
        }
    }
    $miss = ""
    foreach ($l in $tail) {
        if (([string]$l) -match "(?i)No matching distribution found for\s+([^\s\(]+)") { $miss = $Matches[1] }
    }
    $tried = ($PipIndexChain -join " -> ")
    if ($miss) {
        throw "pip install failed: no matching distribution found for $miss. All pip indexes were tried ($tried). That mirror has not synced this package yet; retry install and the script automatically walks to the next index."
    }
    $t = (@($tail | ForEach-Object { ([string]$_).Trim() } | Where-Object { $_ }) -join " / ")
    if ($t.Length -gt 400) { $t = $t.Substring($t.Length - 400) }
    throw "pip install failed on every index ($tried). Last pip output: $t"
}

function Test-CudaPython {
    param([string]$Py)
    if (-not $Py -or -not (Test-Path -LiteralPath $Py)) { return $false }
    try {
        $out = & $Py -c "import torch; print('ok' if torch.cuda.is_available() else 'no')" 2>$null
        return ($LASTEXITCODE -eq 0 -and ("$out".Trim() -eq "ok"))
    } catch {
        return $false
    }
}

function Find-CudaPython {
    $candidates = @()
    if ($CudaPython) { $candidates += $CudaPython }
    if ($env:MT_H3_CUDA_PYTHON) { $candidates += $env:MT_H3_CUDA_PYTHON }
    if ($env:MT_MUSIC_CUDA_PYTHON) { $candidates += $env:MT_MUSIC_CUDA_PYTHON }

    $condaRoots = @(
        "C:\ProgramData\miniconda3",
        "C:\ProgramData\anaconda3",
        "$env:USERPROFILE\miniconda3",
        "$env:USERPROFILE\anaconda3",
        "$env:LOCALAPPDATA\miniconda3",
        "$env:LOCALAPPDATA\anaconda3"
    )
    $envNames = @("seg", "torch", "pytorch", "cuda", "base")
    foreach ($root in $condaRoots) {
        foreach ($name in $envNames) {
            $candidates += (Join-Path $root "envs\$name\python.exe")
        }
        $candidates += (Join-Path $root "python.exe")
    }

    $cmd = Get-Command python -ErrorAction SilentlyContinue
    if ($cmd) { $candidates += $cmd.Source }
    $cmd3 = Get-Command python3 -ErrorAction SilentlyContinue
    if ($cmd3) { $candidates += $cmd3.Source }
    $candidates += "C:\ProgramData\miniconda3\envs\seg\python.exe"

    $seen = @{}
    foreach ($py in $candidates) {
        $key = [string]$py
        if (-not $key -or $seen.ContainsKey($key.ToLowerInvariant())) { continue }
        $seen[$key.ToLowerInvariant()] = $true
        Write-Host "Probing CUDA python: $py"
        if (Test-CudaPython $py) {
            Write-Host "Selected CUDA python: $py"
            return $py
        }
    }
    return $null
}

# git clone through the China gh proxies: ghfast.top -> gh-proxy.com -> ghproxy.net -> ghproxy.com, direct github.com last
function Invoke-GitClone {
    param([string]$Url, [string]$Dest)
    $urls = @(
        "https://ghfast.top/$Url",
        "https://gh-proxy.com/$Url",
        "https://ghproxy.net/$Url",
        "https://ghproxy.com/$Url",
        $Url
    )
    foreach ($u in $urls) {
        Write-Host "git clone $u"
        if (Test-Path -LiteralPath $Dest) { Remove-Item -Recurse -Force -LiteralPath $Dest -ErrorAction SilentlyContinue }
        & git clone --depth 1 $u $Dest
        if ($LASTEXITCODE -eq 0) { return $true }
    }
    return $false
}

function Ensure-ComfyUI {
    if (Test-Path (Join-Path $ComfyRoot "main.py")) {
        Write-Host "ComfyUI already present: $ComfyRoot"
        return
    }
    Write-Host "Cloning ComfyUI into $ComfyRoot ..."
    $git = Get-Command git -ErrorAction SilentlyContinue
    if (-not $git) { throw "git not found; cannot clone ComfyUI" }
    if (-not (Invoke-GitClone -Url "https://github.com/comfyanonymous/ComfyUI.git" -Dest $ComfyRoot)) {
        throw "git clone ComfyUI failed (direct + gh proxies)"
    }
}

function Ensure-CustomNode {
    param([string]$Name, [string]$Url)
    $dest = Join-Path $ComfyRoot "custom_nodes\$Name"
    if (Test-Path $dest) {
        Write-Host "[skip] custom_nodes/$Name"
        return
    }
    Write-Host "Cloning $Name ..."
    New-Item -ItemType Directory -Force -Path (Join-Path $ComfyRoot "custom_nodes") | Out-Null
    if (-not (Invoke-GitClone -Url $Url -Dest $dest)) { throw "clone $Name failed (direct + gh proxies)" }
}

Ensure-ComfyUI

if ($SourceOnly) {
    Write-Host "[h3-setup] source-only: ComfyUI source is in place at $ComfyRoot (venv / torch / deps skipped)"
    exit 0
}

if (-not (Test-Path $VenvPy)) {
    $basePy = Find-CudaPython
    if (-not $basePy) {
        throw "Need a Python with CUDA torch. Pass -CudaPython <path> or set MT_H3_CUDA_PYTHON."
    }
    # Do NOT use --system-site-packages: it would inherit the old conda torch and
    # clash with the comfy_kitchen shipped by ComfyUI (list[int] annotations), which crashes on startup.
    Write-Host "Creating isolated ComfyUI venv from $basePy (no system-site-packages)..."
    & $basePy -m venv $VenvDir
    if ($LASTEXITCODE -ne 0) { throw "venv creation failed" }
    Set-Content -Path (Join-Path $Root ".cuda-python") -Value $basePy -Encoding utf8
}

# Explicit override for this package stays on top of the pinned defaults above: it replaces
# the FIRST index of the chain, the aliyun / USTC / official fallbacks stay in place.
if ($env:MT_H3_PIP_INDEX) {
    $PipIndexChain[0] = $env:MT_H3_PIP_INDEX
    Write-Host "[h3-setup] pip chain start overridden by MT_H3_PIP_INDEX: $($PipIndexChain[0])"
}

Write-Host "Installing helper requirements (repo root)..."
try { Install-PipWithFallback -PipArgs @("-U", "pip") }
catch { throw "pip upgrade failed: $($_.Exception.Message)" }

# Install CUDA torch inside the venv first, so the old torch in system site-packages is never reused.
# The H3 quantized kernels need the optimized CUDA kernels from cu130; cu124/cu126 "start up but hang on the first step".
Write-Host "Installing CUDA torch (cu130) into venv (required for comfy_kitchen)..."
# Domestic mirror first (fast in China), the pytorch.org official index only as the last resort.
$torchIdx = if ($env:MT_H3_TORCH_INDEX) { $env:MT_H3_TORCH_INDEX } else { "https://mirrors.aliyun.com/pytorch-wheels/cu130" }
$torchIdxOfficial = "https://download.pytorch.org/whl/cu130"
$torchPkgs = @("torch==2.9.1+cu130", "torchvision==0.24.1+cu130", "torchaudio==2.9.1+cu130")
& $VenvPy -m pip install --index-url $torchIdx @torchPkgs
if ($LASTEXITCODE -ne 0) {
    Write-Host "torch cu130 aliyun mirror failed; retrying with the pytorch official index (last resort)..."
    & $VenvPy -m pip install --index-url $torchIdxOfficial @torchPkgs
    if ($LASTEXITCODE -ne 0) {
        throw "torch cu130 install failed (aliyun mirror + official). Please update the NVIDIA driver to one that supports CUDA 13.0, then retry."
    }
}

# Verify the driver is new enough: torch.cuda.is_available() false => the driver does not support CUDA 13.0
$cudaOk = (& $VenvPy -c "import torch; print('y' if torch.cuda.is_available() else 'n')" 2>$null).Trim()
if ($cudaOk -ne "y") {
    throw "torch cu130 loaded but torch.cuda.is_available()=False. NVIDIA driver too old for CUDA 13.0. Update the driver (>= CUDA 13.0 support) and rerun."
}

Install-PipWithFallback -PipArgs @("-r", (Join-Path $Root "requirements.txt"))

Write-Host "Installing ComfyUI requirements..."
$req = Join-Path $ComfyRoot "requirements.txt"
if (Test-Path $req) {
    # The chain matters most here: ComfyUI requirements pin many sub-packages, and a mirror
    # that has not synced one of them fails the whole file with "No matching distribution found".
    try { Install-PipWithFallback -PipArgs @("-r", $req) }
    catch { throw "pip install ComfyUI requirements failed: $($_.Exception.Message)" }
}

Ensure-CustomNode -Name "ComfyUI-MiniMaxH3-TeaCache" -Url "https://github.com/Icyoung/ComfyUI-MiniMaxH3-TeaCache.git"
Ensure-CustomNode -Name "ComfyUI-KJNodes" -Url "https://github.com/kijai/ComfyUI-KJNodes.git"
# 4K upscale / frame-interpolation post-processing: the RIFE VFI interpolation node (the rife model + RealESRGAN weights are fetched by download_models.ps1)
Ensure-CustomNode -Name "ComfyUI-Frame-Interpolation" -Url "https://github.com/Fannovel16/ComfyUI-Frame-Interpolation.git"

# Idempotent: the newer ComfyUI MiniMaxH3ReferenceToVideo uses io.Autogrow nested refs while the plugin sends
# flat keys, so execute needs **legacy_refs to fold flat keys, otherwise it throws comfy_execution_error.
$RefsPatch = Join-Path $PSScriptRoot "patch_h3_autogrow_refs.py"
if (Test-Path -LiteralPath $RefsPatch) {
    Write-Host "Patching MiniMaxH3ReferenceToVideo to fold flat ref keys..."
    & $VenvPy $RefsPatch
    if ($LASTEXITCODE -ne 0) { throw "patch_h3_autogrow_refs failed" }
}

$PatchPy = Join-Path $PSScriptRoot "patch_comfy_kitchen_typing.py"
if (Test-Path -LiteralPath $PatchPy) {
    Write-Host "Patching comfy_kitchen typing for torch.infer_schema..."
    & $VenvPy $PatchPy
    if ($LASTEXITCODE -ne 0) { throw "patch_comfy_kitchen_typing failed" }
}

Write-Host "Smoke: torch cuda + comfy_kitchen typing..."
& $VenvPy -c @"
import torch, torchvision, torchaudio
assert torch.cuda.is_available(), 'cuda not available'
assert torch.__version__.startswith('2.9.1') and 'cu130' in torch.__version__, 'need torch>=2.9.1+cu130, got ' + torch.__version__
print('torch', torch.__version__, 'cuda ok', torch.__file__)
try:
    import comfy_kitchen
    print('comfy_kitchen ok')
except Exception as e:
    raise SystemExit('comfy_kitchen import failed: ' + str(e))
"@
if ($LASTEXITCODE -ne 0) { throw "CUDA / comfy_kitchen smoke failed" }

# The optional Sage Attention acceleration is **deliberately not installed here**: on Windows triton-windows and
# the prebuilt sageattention wheel must come as a pair, and the wheel must be picked to match this machine's
# Python / torch / CUDA major versions (PyPI only carries the old sageattention 1.0.6).
# See the skill "minimax-h3-install - optional dependencies"; on the MTNode side the H3 plugin window's
# "Sage acceleration" button (h3/main-h3.js -> installSageAttention) installs it on demand and re-checks itself
# right away; when the package is missing, generation skips Sage automatically.

Write-Host "Setup complete. Next: .\scripts\download_models.ps1"
