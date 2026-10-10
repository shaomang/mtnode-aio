<#
.SYNOPSIS
  Repair ComfyUI venv when comfy_kitchen crashes on torch infer_schema (list[int]).

Typical console error:
  ValueError: infer_schema(...): Parameter kernel_size has unsupported type list[int]
#>
[CmdletBinding()]
param()

# Force UTF-8 for this process so the host (which decodes our stdout as UTF-8)
# and every native tool we spawn (pip / git / python) agree on one encoding.
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
$OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$env:PYTHONIOENCODING = 'utf-8'

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$ComfyRoot = Join-Path $Root "ComfyUI"
$VenvDir = Join-Path $ComfyRoot "venv"
$VenvPy = Join-Path $VenvDir "Scripts\python.exe"
$Cfg = Join-Path $VenvDir "pyvenv.cfg"
$PatchPy = Join-Path $PSScriptRoot "patch_comfy_kitchen_typing.py"

if (-not (Test-Path -LiteralPath $VenvPy)) {
    throw "ComfyUI venv missing. Run .\scripts\setup_env.ps1 first."
}

$cfgText = ""
if (Test-Path -LiteralPath $Cfg) {
    $cfgText = Get-Content -LiteralPath $Cfg -Raw -ErrorAction SilentlyContinue
}
$usesSystem = $cfgText -match "(?im)^\s*include-system-site-packages\s*=\s*true"

Write-Host "venv python: $VenvPy"
Write-Host "include-system-site-packages: $usesSystem"

if ($usesSystem) {
    Write-Host "Detected system-site-packages venv - recreating isolated venv (keeps ComfyUI tree)..."
    $basePy = $null
    $dot = Join-Path $Root ".cuda-python"
    if (Test-Path -LiteralPath $dot) {
        $basePy = (Get-Content -LiteralPath $dot -Raw).Trim()
    }
    if (-not $basePy -or -not (Test-Path -LiteralPath $basePy)) {
        if ($cfgText -match "(?im)^\s*home\s*=\s*(.+)$") {
            $home = $Matches[1].Trim()
            $cand = Join-Path $home "python.exe"
            if (Test-Path -LiteralPath $cand) { $basePy = $cand }
        }
    }
    if (-not $basePy -or -not (Test-Path -LiteralPath $basePy)) {
        throw "Cannot find base CUDA python to recreate venv. Set .cuda-python or pass via setup_env."
    }
    Remove-Item -LiteralPath $VenvDir -Recurse -Force
    & $basePy -m venv $VenvDir
    if ($LASTEXITCODE -ne 0) { throw "venv recreate failed" }
    Set-Content -Path $dot -Value $basePy -Encoding utf8
}

# Avoid a broken PIP_EXTRA_INDEX_URL (e.g. an unresolvable pypi.ngc.nvidia.com)
$env:PIP_EXTRA_INDEX_URL = ""
$env:PIP_INDEX_URL = if ($env:MT_H3_PIP_INDEX) { $env:MT_H3_PIP_INDEX } else { "https://pypi.org/simple" }

Write-Host "Upgrading pip + ensuring CUDA torch in venv..."
& $VenvPy -m pip install --isolated -U pip
# The H3 quantized kernels need cu130; do not fall back to cu124/cu121 (it hangs the first forward step).
$torchIdx = if ($env:MT_H3_TORCH_INDEX) { $env:MT_H3_TORCH_INDEX } else { "https://download.pytorch.org/whl/cu130" }
& $VenvPy -m pip install --isolated --index-url $torchIdx "torch==2.9.1+cu130" "torchvision==0.24.1+cu130" "torchaudio==2.9.1+cu130"
if ($LASTEXITCODE -ne 0) {
    throw "torch cu130 install failed; update NVIDIA driver to a CUDA 13-capable release and retry."
}

$req = Join-Path $ComfyRoot "requirements.txt"
if (Test-Path -LiteralPath $req) {
    Write-Host "Reinstalling ComfyUI requirements..."
    & $VenvPy -m pip install --isolated -r $req
    if ($LASTEXITCODE -ne 0) { throw "ComfyUI requirements failed" }
}

$helper = Join-Path $Root "requirements.txt"
if (Test-Path -LiteralPath $helper) {
    & $VenvPy -m pip install --isolated -r $helper
}

# Even though torch is isolated inside the venv, torch 2.6 infer_schema can still reject list[int] -- the patch is mandatory
if (Test-Path -LiteralPath $PatchPy) {
    Write-Host "Patching comfy_kitchen typing for torch.infer_schema..."
    & $VenvPy $PatchPy
    if ($LASTEXITCODE -ne 0) { throw "patch_comfy_kitchen_typing failed" }
}

Write-Host "Smoke import..."
& $VenvPy -c "import torch; assert torch.cuda.is_available(); assert 'cu130' in torch.__version__; import comfy_kitchen; print('ok', torch.__version__, torch.__file__)"
if ($LASTEXITCODE -ne 0) { throw "smoke failed" }

Write-Host "repair_ok=1"
