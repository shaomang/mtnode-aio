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

$ErrorActionPreference = "Stop"

Write-Host "============================================================"
Write-Host "[music3-setup] 国内镜像说明（必须，本机位于中国大陆网络时尤其重要）："
Write-Host "  · Python 库：默认使用清华镜像 pypi.tuna.tsinghua.edu.cn（或中科院 USTC mirrors.ustc.edu.cn，可用 MT_MUSIC_PIP_INDEX 覆盖）"
Write-Host "  · diffusers 依赖来自 GitHub：直连失败自动用 ghproxy 镜像前缀重试"
Write-Host "  · 模型权重：HuggingFace 无法直连，走 hf-mirror.com；Comfy 权重优先 ModelScope(魔搭)"
Write-Host "============================================================"
$Root = Split-Path -Parent $PSScriptRoot
$VenvDir = Join-Path $Root ".venv"
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

    # Fallback hint from original mt-music setup
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

if (-not (Test-Path $VenvPy)) {
    $basePy = Find-CudaPython
    if (-not $basePy) {
        throw "Need a Python with CUDA torch. Pass -CudaPython <path> or set MT_MUSIC_CUDA_PYTHON."
    }
    Write-Host "Creating .venv from $basePy (system-site-packages for CUDA torch)..."
    & $basePy -m venv --system-site-packages $VenvDir
    if ($LASTEXITCODE -ne 0) { throw "venv creation failed" }
    # Persist choice for later installs / agent
    Set-Content -Path (Join-Path $Root ".cuda-python") -Value $basePy -Encoding utf8
}

# 国内镜像：默认清华（或中科院 USTC），可用 MT_MUSIC_PIP_INDEX 覆盖
$env:PIP_INDEX_URL = if ($env:MT_MUSIC_PIP_INDEX) { $env:MT_MUSIC_PIP_INDEX } else { "https://pypi.tuna.tsinghua.edu.cn/simple" }
Write-Host "Installing requirements..."
& $VenvPy -m pip install -U pip
if ($LASTEXITCODE -ne 0) { throw "pip upgrade failed" }
& $VenvPy -m pip install -r (Join-Path $Root "requirements.txt")
if ($LASTEXITCODE -ne 0) {
    Write-Host "requirements install failed (direct); retrying with ghproxy git mirror (国内镜像)..."
    $req = Join-Path $Root "requirements.txt"
    $reqMirror = Join-Path $env:TEMP "music3-requirements-mirror.txt"
    (Get-Content -LiteralPath $req -Raw) -replace "git\+https://github\.com/", "git+https://ghproxy.com/https://github.com/" | Set-Content -LiteralPath $reqMirror -Encoding utf8
    & $VenvPy -m pip install -r $reqMirror
    if ($LASTEXITCODE -ne 0) { throw "pip install requirements failed (direct + ghproxy mirror)" }
}
& $VenvPy -c "import torch; from diffusers import ModularPipeline; print('torch', torch.__version__, 'cuda', torch.cuda.is_available()); print('diffusers ok')"
if ($LASTEXITCODE -ne 0) { throw "smoke import failed" }
Write-Host "Setup complete."
