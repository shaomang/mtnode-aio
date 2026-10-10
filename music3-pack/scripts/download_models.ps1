<#
.SYNOPSIS
  Download MiniMax Music 3 weights for the local app and/or ComfyUI.

.PARAMETER Target
  app      - Official Diffusers weights -> <Repo>/models/MiniMax-Music3 (default)
  comfy    - Comfy-Org repack -> <ComfyRoot>/models/...
  both     - Download both

.PARAMETER ComfyRoot
  Required when Target is comfy or both. ComfyUI root containing models/.

.PARAMETER IncludeInt8Dit
  Also download Comfy DiT INT8 fallback.

.EXAMPLE
  .\scripts\download_models.ps1

.EXAMPLE
  .\scripts\download_models.ps1 -Target comfy -ComfyRoot "D:\ComfyUI"
#>
[CmdletBinding()]
param(
    [ValidateSet("app", "comfy", "both")]
    [string]$Target = "app",

    [string]$ComfyRoot,

    [switch]$IncludeInt8Dit
)

$ErrorActionPreference = "Stop"

# Force UTF-8 for this process so the host (which decodes our stdout as UTF-8)
# and every native tool we spawn (pip / git / python) agree on one encoding.
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
$OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$env:PYTHONIOENCODING = 'utf-8'

$RepoRoot = Split-Path -Parent $PSScriptRoot

Write-Host "============================================================"
Write-Host "[music3-download] About the China mirrors (required; especially important when this machine is on a mainland China network):"
Write-Host "  - huggingface.co cannot be reached directly from mainland China: Comfy weights are downloaded from ModelScope Comfy-Org/MiniMax-Music-3 first"
Write-Host "  - App (Diffusers) weights are downloaded through hf-mirror.com (HF_ENDPOINT is already set, so we never hit huggingface.co directly)"
Write-Host "  - To make the App weights go through ModelScope too, set MUSIC3_MODELSCOPE_REPO to your own ModelScope repository"
Write-Host "============================================================"

# China-friendly defaults (override by setting env before calling)
if (-not $env:HF_ENDPOINT) { $env:HF_ENDPOINT = "https://hf-mirror.com" }
$env:HF_HUB_DISABLE_XET = "1"

function Get-AppPython {
    $py = Join-Path $RepoRoot ".venv\Scripts\python.exe"
    if (Test-Path $py) { return $py }
    $py = (Get-Command python -ErrorAction SilentlyContinue).Source
    if (-not $py) { throw "python not found. Run .\scripts\setup_env.ps1 first." }
    return $py
}

function Download-AppWeights {
    $dest = Join-Path $RepoRoot "models\MiniMax-Music3"
    Write-Host "=== App weights (Diffusers) ==="
    Write-Host "Dest: $dest"
    Write-Host "HF_ENDPOINT=$env:HF_ENDPOINT"
    New-Item -ItemType Directory -Force -Path $dest | Out-Null
    $py = Get-AppPython
    $destEsc = $dest.Replace("\", "\\")
    & $py -c @"
from huggingface_hub import snapshot_download
p = snapshot_download(
    repo_id='MiniMaxAI/MiniMax-Music3',
    local_dir=r'$destEsc',
    max_workers=4,
)
print('app weights ready:', p)
"@
    if ($LASTEXITCODE -ne 0) { throw "Failed to download MiniMaxAI/MiniMax-Music3" }
}

function Download-ComfyWeights {
    if (-not $ComfyRoot) {
        throw "ComfyRoot is required for Target=comfy|both"
    }
    if (-not (Test-Path -LiteralPath $ComfyRoot)) {
        throw "ComfyRoot not found: $ComfyRoot"
    }
    $modelsRoot = Join-Path ((Resolve-Path -LiteralPath $ComfyRoot).Path) "models"
    $repo = "Comfy-Org/MiniMax-Music-3"
    Write-Host "=== ComfyUI weights ==="
    Write-Host "Dest: $modelsRoot"

    $targets = @(
        "diffusion_models/minimax_music3_dit_fp16.safetensors",
        "text_encoders/minimax_music3_text_encoder_pruned_int8_convrot.safetensors",
        "vae/minimax_music3_dav.safetensors"
    )
    if ($IncludeInt8Dit) {
        $targets += "diffusion_models/minimax_music3_dit_int8_convrot.safetensors"
    }

    $py = Get-AppPython
    $modelsEsc = $modelsRoot.Replace("\", "\\")
    foreach ($inc in $targets) {
        $destFile = Join-Path $modelsRoot ($inc -replace "/", "\")
        if (Test-Path -LiteralPath $destFile) {
            Write-Host "[skip] $inc"
            continue
        }
        Write-Host "[download] $inc"
        # 1) ModelScope first: reachable directly from mainland China
        $msUrl = "https://www.modelscope.cn/models/$repo/resolve/master/$($inc -replace '\\','/')"
        $msOk = $false
        try {
            Invoke-WebRequest -Uri $msUrl -OutFile $destFile -UseBasicParsing -TimeoutSec 600
            $msOk = $true
            Write-Host "[modelscope ok] $inc"
        } catch {
            Write-Host "[modelscope failed, fallback hf-mirror] $inc : $($_.Exception.Message)"
        }
        # 2) hf-mirror fallback
        if (-not $msOk) {
            & $py -c @"
import os
os.environ['HF_ENDPOINT'] = 'https://hf-mirror.com'
os.environ['HF_HUB_DISABLE_XET'] = '1'
from huggingface_hub import hf_hub_download
path = hf_hub_download(
    repo_id='$repo',
    filename='$inc',
    local_dir=r'$modelsEsc',
)
print(path)
"@
            if ($LASTEXITCODE -ne 0) { throw "Failed: $inc (modelscope + hf-mirror)" }
        }
    }
}

if ($Target -eq "app" -or $Target -eq "both") {
    Download-AppWeights
}
if ($Target -eq "comfy" -or $Target -eq "both") {
    Download-ComfyWeights
}

Write-Host ""
Write-Host "Done."
if ($Target -eq "app" -or $Target -eq "both") {
    Write-Host "App model: $RepoRoot\models\MiniMax-Music3"
}
if ($Target -eq "comfy" -or $Target -eq "both") {
    Write-Host "Comfy models under: $ComfyRoot\models"
}