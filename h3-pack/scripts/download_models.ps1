<#
.SYNOPSIS
  Download MiniMax H3 24G ComfyUI weights (ModelScope Comfy-Org/MiniMax-H3).
#>
[CmdletBinding()]
param()

# Force UTF-8 for this process so the host (which decodes our stdout as UTF-8)
# and every native tool we spawn (pip / git / python) agree on one encoding.
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
$OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$env:PYTHONIOENCODING = 'utf-8'

$ErrorActionPreference = "Stop"
# Weights: ModelScope first, hf-mirror.com as the fallback (never straight to huggingface.co).
# HF_HUB_DISABLE_XET=1 by default: xet transfers go through cas-server, which the mirror does not serve.
if (-not $env:HF_ENDPOINT)        { $env:HF_ENDPOINT = "https://hf-mirror.com" }
if (-not $env:HF_HUB_DISABLE_XET) { $env:HF_HUB_DISABLE_XET = "1" }
Write-Host "============================================================"
Write-Host "[h3-download] China mirror notes (required): HuggingFace cannot be reached directly from mainland China, so this script downloads weights from ModelScope first;"
Write-Host "  when ModelScope fails it falls back to hf-mirror.com (it never connects straight to huggingface.co)."
Write-Host "============================================================"
$Root = Split-Path -Parent $PSScriptRoot
$ComfyRoot = Join-Path $Root "ComfyUI"
$ModelsRoot = Join-Path $ComfyRoot "models"
$VenvPy = Join-Path $ComfyRoot "venv\Scripts\python.exe"

if (-not (Test-Path $VenvPy)) {
    throw "ComfyUI venv missing. Run .\scripts\setup_env.ps1 first."
}
if (-not (Test-Path (Join-Path $ComfyRoot "main.py"))) {
    throw "ComfyUI missing at $ComfyRoot"
}

New-Item -ItemType Directory -Force -Path @(
    (Join-Path $ModelsRoot "diffusion_models"),
    (Join-Path $ModelsRoot "text_encoders"),
    (Join-Path $ModelsRoot "vae")
) | Out-Null

$files = @(
    @{ Rel = "diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors"; Need = $true },
    @{ Rel = "diffusion_models/minimax_h3_ref2va_pruned_int8_convrot.safetensors"; Need = $true },
    @{ Rel = "text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors"; Need = $true },
    @{ Rel = "vae/minimax_h3_video_vae_fp16.safetensors"; Need = $true },
    @{ Rel = "vae/minimax_h3_audio_vae_fp32.safetensors"; Need = $true }
)

$modelsEsc = $ModelsRoot.Replace("\", "\\")
$total = $files.Count
$i = 0
foreach ($f in $files) {
    $i++
    $dest = Join-Path $ModelsRoot ($f.Rel -replace "/", "\")
    $pct = [int](($i - 1) / $total * 100)
    Write-Host "[$pct%] check $($f.Rel)"
    if ((Test-Path -LiteralPath $dest) -and ((Get-Item -LiteralPath $dest).Length -gt 1MB)) {
        Write-Host "[skip] $($f.Rel) already present"
        continue
    }
    Write-Host "[download] $($f.Rel) ..."
    $inc = $f.Rel
    & $VenvPy -c @"
import os, sys
os.environ.setdefault('MODELSCOPE_CACHE', r'$modelsEsc\\_ms_cache')
try:
    from modelscope.hub.file_download import model_file_download
    p = model_file_download(
        model_id='Comfy-Org/MiniMax-H3',
        file_path='$inc',
        local_dir=r'$modelsEsc',
    )
    print('saved', p)
except Exception as e1:
    print('modelscope failed:', e1)
    try:
        import os as _os
        _os.environ['HF_ENDPOINT'] = 'https://hf-mirror.com'
        _os.environ['HF_HUB_DISABLE_XET'] = '1'
        from huggingface_hub import hf_hub_download
        p = hf_hub_download(
            repo_id='Comfy-Org/MiniMax-H3',
            filename='$inc',
            local_dir=r'$modelsEsc',
        )
        print('saved', p)
    except Exception as e2:
        print('huggingface failed:', e2)
        sys.exit(1)
"@
    if ($LASTEXITCODE -ne 0) { throw "Failed to download $inc" }
    Write-Host "$([int]($i / $total * 100))% downloaded $($f.Rel)"
}

Write-Host "100% app weights ready"
Write-Host "Models under: $ModelsRoot"

# ---- 4K upscale / frame-interpolation post-processing weights ----
# RealESRGAN x4 upscale model -> ComfyUI/models/upscale_models/ (read by the core node UpscaleModelLoader)
# RealESRGAN x2 upscale model -> same directory; **optional** (the upscale node prefers it when the x2 ratio is
#   selected: intermediate tensors are only 1/4 the size of x4, so peak system memory drops a whole step; being
#   unable to fetch it does not affect the install or the x2 ratio -- in that case the x4 weights are used and
#   the output is downscaled to 2x)
# rife47.pth interpolation model -> ComfyUI-Frame-Interpolation/ckpts/rife/ (read by the RIFE VFI node;
#   the node itself tries to auto-download from GitHub, so pre-placing it here keeps China networks from stalling)
# Every entry carries its own ModelScope id and hf-mirror id: they do NOT share one repo path.
# MsRepo = "" means ModelScope has no such repo/file at all (marduk191/rife returns a hard 404
# "[E3020] file content is empty"), so that entry goes straight to the hf mirror and the install
# log never shows a red herring error line for a download that is expected to succeed there.
$postFiles = @(
    @{
        MsRepo = "ai-forever/Real-ESRGAN"; MsRel = "RealESRGAN_x4.pth";
        HfRepo = "licyk/sd-upscaler-models"; HfRel = "RealESRGAN/RealESRGAN_x4plus.pth";
        DstDir = $ModelsRoot; Out = "upscale_models\RealESRGAN_x4plus.pth"
    },
    @{
        # Official Real-ESRGAN x2plus weights (ai-forever's PyTorch port; its state_dict has the same
        # architecture as x2plus -> ComfyUI's UpscaleModelLoader identifies the architecture from the state
        # dict, so renaming it into the combo list is all it takes)
        MsRepo = "ai-forever/Real-ESRGAN"; MsRel = "RealESRGAN_x2.pth";
        HfRepo = "ai-forever/Real-ESRGAN"; HfRel = "RealESRGAN_x2.pth";
        DstDir = $ModelsRoot; Out = "upscale_models\RealESRGAN_x2plus.pth"; Optional = $true
    },
    @{
        MsRepo = ""; MsRel = "";
        HfRepo = "marduk191/rife"; HfRel = "rife47.pth";
        DstDir = Join-Path $ComfyRoot "custom_nodes\ComfyUI-Frame-Interpolation"
        Out = "ckpts\rife\rife47.pth"
    }
)
foreach ($f in $postFiles) {
    $dest = Join-Path $f.DstDir $f.Out
    if (-not (Test-Path -LiteralPath (Split-Path -Parent $dest))) {
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dest) | Out-Null
    }
    if ((Test-Path -LiteralPath $dest) -and ((Get-Item -LiteralPath $dest).Length -gt 1MB)) {
        Write-Host "[skip] post $($f.Out)"
        continue
    }
    Write-Host "[download post] $($f.Out) ..."
    # Download into a temporary subdirectory (modelscope/hf expand the repo-internal path), then move it to the target filename
    $tmpDir = Join-Path (Split-Path -Parent $dest) "_post_tmp_$PID"
    Remove-Item -Recurse -Force $tmpDir -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null
    $tmpEsc = $tmpDir.Replace("\", "\\")
    & $VenvPy -c @"
import os, sys, shutil

os.environ.setdefault('MODELSCOPE_CACHE', r'$modelsEsc\\_ms_cache')
tmp = r'$tmpEsc'
MIN = 1024 * 1024


def usable(path):
    try:
        return bool(path) and os.path.isfile(path) and os.path.getsize(path) >= MIN
    except OSError:
        return False


def from_modelscope():
    repo = '$($f.MsRepo)'
    if not repo:
        return None
    from modelscope.hub.file_download import model_file_download
    p = model_file_download(model_id=repo, file_path='$($f.MsRel)', local_dir=tmp)
    if not usable(p):
        raise RuntimeError('no usable file (empty / missing): %s' % p)
    return p


def from_hf():
    os.environ['HF_ENDPOINT'] = 'https://hf-mirror.com'
    os.environ['HF_HUB_DISABLE_XET'] = '1'
    from huggingface_hub import hf_hub_download
    p = hf_hub_download(repo_id='$($f.HfRepo)', filename='$($f.HfRel)', local_dir=tmp)
    if not usable(p):
        raise RuntimeError('no usable file (empty / missing): %s' % p)
    return p


def from_url():
    import urllib.request
    out = os.path.join(tmp, os.path.basename('$($f.HfRel)'))
    for base in ('https://hf-mirror.com', 'https://huggingface.co'):
        url = base + '/$($f.HfRepo)/resolve/main/$($f.HfRel)'
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'mtnode-h3-install'})
            with urllib.request.urlopen(req, timeout=90) as r, open(out, 'wb') as fo:
                shutil.copyfileobj(r, fo, 1024 * 1024)
            if usable(out):
                return out
            print('direct url too small:', base)
        except Exception as e:
            print('direct url failed:', base, e)
    return None


p = None
for label, fn in (('modelscope', from_modelscope), ('hf-mirror', from_hf), ('direct url', from_url)):
    try:
        p = fn()
    except Exception as e:
        print(label + ' failed:', e)
        p = None
    if p:
        break
if not p:
    print('all download sources failed')
    sys.exit(1)
print('saved', p)
"@
    if ($LASTEXITCODE -ne 0) {
        Remove-Item -Recurse -Force $tmpDir -ErrorAction SilentlyContinue
        if ($f.Optional) {
            Write-Host "[warn] optional post weight skipped: $($f.Out) (does not affect the install or the x2 ratio: without the x2 weights the x4 weights are used and the output is downscaled to 2x)"
            continue
        }
        throw "Failed to download post $($f.Out)"
    }
    # Move the downloaded file to its final path (the download may carry the repo-relative directory).
    # Skip the downloader's own ".cache" tree: it can hold an incomplete file that is bigger than 1MB.
    $downloaded = Get-ChildItem -LiteralPath $tmpDir -Recurse -File |
        Where-Object { $_.Length -gt 1MB -and $_.FullName -notmatch '\\\.cache\\' } |
        Sort-Object Length -Descending | Select-Object -First 1
    if (-not $downloaded) {
        Remove-Item -Recurse -Force $tmpDir -ErrorAction SilentlyContinue
        if ($f.Optional) {
            Write-Host "[warn] optional post weight empty: $($f.Out) (same as above, does not affect the install)"
            continue
        }
        throw "post download empty: $($f.Out)"
    }
    Move-Item -LiteralPath $downloaded.FullName -Destination $dest -Force
    Remove-Item -Recurse -Force $tmpDir -ErrorAction SilentlyContinue
    if (-not ((Get-Item -LiteralPath $dest).Length -gt 1MB)) {
        if ($f.Optional) {
            Remove-Item -LiteralPath $dest -Force -ErrorAction SilentlyContinue
            Write-Host "[warn] optional post weight too small: $($f.Out) (discarded, does not affect the install)"
            continue
        }
        throw "post file too small: $($f.Out)"
    }
}

Write-Host "100% post-processing weights ready (RealESRGAN_x4plus + RealESRGAN_x2plus(optional) + rife47)"
