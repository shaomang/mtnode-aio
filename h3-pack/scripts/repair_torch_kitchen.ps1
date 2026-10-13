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
# A mirror that has not synced one sub-package (2026-10 real case:
# comfyui-workflow-templates-media-assets-02==0.1.11 was missing on both Tsinghua and USTC)
# otherwise fails this whole script on a single "No matching distribution found" line.
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

$Root = Split-Path -Parent $PSScriptRoot
$ComfyRoot = Join-Path $Root "ComfyUI"
$VenvDir = Join-Path $ComfyRoot "venv"
$VenvPy = Join-Path $VenvDir "Scripts\python.exe"
$Cfg = Join-Path $VenvDir "pyvenv.cfg"
$PatchPy = Join-Path $PSScriptRoot "patch_comfy_kitchen_typing.py"

# Run one pip install against the index chain above: Tsinghua, then aliyun, then USTC,
# official PyPI last. First success wins; when every index fails, name the missing
# distribution so the console says what is really wrong.
function Install-PipWithFallback {
    param([string[]]$PipArgs)
    $last = 0
    $tail = @()
    for ($i = $PipChainStart; $i -lt $PipIndexChain.Count; $i++) {
        $idx = $PipIndexChain[$i]
        $host_ = $PipTrustedHostChain[$i]
        $n = $i + 1
        Write-Host "[h3-repair] pip index=$n/$($PipIndexChain.Count) host=$host_"
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
            Write-Host "[h3-repair] pip index=$n/$($PipIndexChain.Count) host=$host_ failed (exit $last); falling back to the next index..."
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

if (-not (Test-Path -LiteralPath $VenvPy)) {
    throw "ComfyUI venv missing. Run .\scripts\setup_env.ps1 first."
}

$cfgText = ""
if (Test-Path -LiteralPath $Cfg) {
    $cfgText = Get-Content -LiteralPath $Cfg -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
}
$usesSystem = $cfgText -match "(?im)^\s*include-system-site-packages\s*=\s*true"

Write-Host "venv python: $VenvPy"
Write-Host "include-system-site-packages: $usesSystem"

if ($usesSystem) {
    Write-Host "Detected system-site-packages venv - recreating isolated venv (keeps ComfyUI tree)..."
    $basePy = $null
    $dot = Join-Path $Root ".cuda-python"
    if (Test-Path -LiteralPath $dot) {
        $basePy = (Get-Content -LiteralPath $dot -Raw -Encoding UTF8).Trim()
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

# Explicit override for this package stays on top of the pinned defaults at the top of this
# script: it replaces the FIRST index of the chain, the remaining fallbacks stay in place.
if ($env:MT_H3_PIP_INDEX) {
    $PipIndexChain[0] = $env:MT_H3_PIP_INDEX
    Write-Host "[h3-repair] pip chain start overridden by MT_H3_PIP_INDEX: $($PipIndexChain[0])"
}

Write-Host "Upgrading pip + ensuring CUDA torch in venv..."
try { Install-PipWithFallback -PipArgs @("-U", "pip") } catch { throw "pip upgrade failed: $($_.Exception.Message)" }
# The H3 quantized kernels need cu130; do not fall back to cu124/cu121 (it hangs the first forward step).
# Domestic mirror first, the pytorch.org official index only as the last resort (override with MT_H3_TORCH_INDEX).
$torchIdx = if ($env:MT_H3_TORCH_INDEX) { $env:MT_H3_TORCH_INDEX } else { "https://mirrors.aliyun.com/pytorch-wheels/cu130" }
$torchPkgs = @("torch==2.9.1+cu130", "torchvision==0.24.1+cu130", "torchaudio==2.9.1+cu130")
& $VenvPy -m pip install --index-url $torchIdx @torchPkgs
if ($LASTEXITCODE -ne 0) {
    Write-Host "torch cu130 aliyun mirror failed; retrying with the pytorch official index (last resort)..."
    & $VenvPy -m pip install --index-url "https://download.pytorch.org/whl/cu130" @torchPkgs
}
if ($LASTEXITCODE -ne 0) {
    throw "torch cu130 install failed; update NVIDIA driver to a CUDA 13-capable release and retry."
}

$req = Join-Path $ComfyRoot "requirements.txt"
if (Test-Path -LiteralPath $req) {
    Write-Host "Reinstalling ComfyUI requirements..."
    try { Install-PipWithFallback -PipArgs @("-r", $req) }
    catch { throw "ComfyUI requirements failed: $($_.Exception.Message)" }
}

$helper = Join-Path $Root "requirements.txt"
if (Test-Path -LiteralPath $helper) {
    Install-PipWithFallback -PipArgs @("-r", $helper)
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
