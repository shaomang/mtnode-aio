<#
.SYNOPSIS
  Install ComfyUI + custom nodes for MiniMax H3 (24G), using a CUDA-capable Python.

.PARAMETER CudaPython
  Optional path to a Python that already has CUDA-capable torch.
  If omitted, probes common conda/PATH locations.
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
Write-Host "============================================================"
Write-Host "[h3-setup] China mirror notes (required, especially when this machine sits on a mainland-China network):"
Write-Host "  - Python packages: Tsinghua mirror pypi.tuna.tsinghua.edu.cn by default (or USTC mirrors.ustc.edu.cn; override with MT_H3_PIP_INDEX)"
Write-Host "  - torch cu130: official download.pytorch.org first, automatically falling back to the Aliyun mirror mirrors.aliyun.com/pytorch-wheels/cu130 (override with MT_H3_TORCH_INDEX)"
Write-Host "  - Weights come from ModelScope first; if git clone fails, fall back to a ghproxy mirror"
Write-Host "============================================================"
$Root = Split-Path -Parent $PSScriptRoot
$ComfyRoot = Join-Path $Root "ComfyUI"
$VenvDir = Join-Path $ComfyRoot "venv"
$VenvPy = Join-Path $VenvDir "Scripts\python.exe"

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

function Ensure-ComfyUI {
    if (Test-Path (Join-Path $ComfyRoot "main.py")) {
        Write-Host "ComfyUI already present: $ComfyRoot"
        return
    }
    Write-Host "Cloning ComfyUI into $ComfyRoot ..."
    $git = Get-Command git -ErrorAction SilentlyContinue
    if (-not $git) { throw "git not found; cannot clone ComfyUI" }
    & git clone --depth 1 https://github.com/comfyanonymous/ComfyUI.git $ComfyRoot
    if ($LASTEXITCODE -ne 0) { throw "git clone ComfyUI failed" }
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
    & git clone --depth 1 $Url $dest
    if ($LASTEXITCODE -ne 0) { throw "clone $Name failed" }
}

Ensure-ComfyUI

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

# Avoid interference from a broken PIP_EXTRA_INDEX_URL (e.g. pypi.ngc.nvidia.com): --isolated ignores machine pip config
$env:PIP_EXTRA_INDEX_URL = ""
# China mirror: Tsinghua by default (or USTC); override with MT_H3_PIP_INDEX
$env:PIP_INDEX_URL = if ($env:MT_H3_PIP_INDEX) { $env:MT_H3_PIP_INDEX } else { "https://pypi.tuna.tsinghua.edu.cn/simple" }

Write-Host "Installing helper requirements (repo root)..."
& $VenvPy -m pip install --isolated -U pip
if ($LASTEXITCODE -ne 0) { throw "pip upgrade failed" }

# Install CUDA torch inside the venv first, so the old torch in system site-packages is never reused.
# The H3 quantized kernels need the optimized CUDA kernels from cu130; cu124/cu126 "start up but hang on the first step".
Write-Host "Installing CUDA torch (cu130) into venv (required for comfy_kitchen)..."
$torchIdx = if ($env:MT_H3_TORCH_INDEX) { $env:MT_H3_TORCH_INDEX } else { "https://download.pytorch.org/whl/cu130" }
$torchIdxMirror = "https://mirrors.aliyun.com/pytorch-wheels/cu130"
$torchPkgs = @("torch==2.9.1+cu130", "torchvision==0.24.1+cu130", "torchaudio==2.9.1+cu130")
& $VenvPy -m pip install --isolated --index-url $torchIdx @torchPkgs
if ($LASTEXITCODE -ne 0) {
    Write-Host "torch cu130 direct index failed; retrying with aliyun mirror (China mirror)..."
    & $VenvPy -m pip install --isolated --index-url $torchIdxMirror @torchPkgs
    if ($LASTEXITCODE -ne 0) {
        throw "torch cu130 install failed (direct + aliyun mirror). Please update the NVIDIA driver to one that supports CUDA 13.0, then retry."
    }
}

# Verify the driver is new enough: torch.cuda.is_available() false => the driver does not support CUDA 13.0
$cudaOk = (& $VenvPy -c "import torch; print('y' if torch.cuda.is_available() else 'n')" 2>$null).Trim()
if ($cudaOk -ne "y") {
    throw "torch cu130 loaded but torch.cuda.is_available()=False. NVIDIA driver too old for CUDA 13.0. Update the driver (>= CUDA 13.0 support) and rerun."
}

& $VenvPy -m pip install --isolated -r (Join-Path $Root "requirements.txt")
if ($LASTEXITCODE -ne 0) { throw "pip install helper requirements failed" }

Write-Host "Installing ComfyUI requirements..."
$req = Join-Path $ComfyRoot "requirements.txt"
if (Test-Path $req) {
    & $VenvPy -m pip install --isolated -r $req
    if ($LASTEXITCODE -ne 0) { throw "pip install ComfyUI requirements failed" }
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
