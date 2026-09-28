<#
.SYNOPSIS
  Download MiniMax H3 24G ComfyUI weights (ModelScope Comfy-Org/MiniMax-H3).
#>
[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
Write-Host "============================================================"
Write-Host "[h3-download] 国内镜像说明（必须）：HuggingFace 国内无法直连，本脚本优先从 ModelScope(魔搭) 下载权重；"
Write-Host "  ModelScope 失败时回退 hf-mirror.com（不会直连 huggingface.co）。"
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

# ---- 4K 超分补帧后处理权重 ----
# RealESRGAN x4 超分模型 → ComfyUI/models/upscale_models/（核心节点 UpscaleModelLoader 读取）
# RealESRGAN x2 超分模型 → 同一目录；**可选**（超分节点选 x2 倍率时优先用它：中间张量只有 x4 的 1/4，
#   峰值系统内存直接降一档；拉不到不影响安装与 x2 倍率 —— 此时用 x4 权重 + 输出端缩到 2 倍）
# rife47.pth 补帧模型 → ComfyUI-Frame-Interpolation/ckpts/rife/（RIFE VFI 节点读取；
#   节点本身会尝试从 GitHub 自动下载，国内网络下这里预先放好避免卡住）
$postFiles = @(
    @{
        Repo = "licyk/sd-upscaler-models"; Rel = "RealESRGAN/RealESRGAN_x4plus.pth";
        DstDir = $ModelsRoot; Out = "upscale_models\RealESRGAN_x4plus.pth"
    },
    @{
        # 官方 Real-ESRGAN x2plus 权重（ai-forever 的 PyTorch 移植版，state_dict 与 x2plus 同架构 →
        # ComfyUI 的 UpscaleModelLoader 按 state dict 认架构，改名放进 combo 即可用）
        Repo = "ai-forever/Real-ESRGAN"; Rel = "RealESRGAN_x2.pth";
        DstDir = $ModelsRoot; Out = "upscale_models\RealESRGAN_x2plus.pth"; Optional = $true
    },
    @{
        Repo = "marduk191/rife"; Rel = "rife47.pth";
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
    # 下载到临时子目录（modelscope/hf 会按 repo 内部路径展开），再移动到目标文件名
    $tmpDir = Join-Path (Split-Path -Parent $dest) "_post_tmp_$PID"
    New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null
    $tmpEsc = $tmpDir.Replace("\", "\\")
    & $VenvPy -c @"
import os, sys, shutil
os.environ.setdefault('MODELSCOPE_CACHE', r'$modelsEsc\\_ms_cache')
def dl():
    try:
        from modelscope.hub.file_download import model_file_download
        return model_file_download(model_id='$($f.Repo)', file_path='$($f.Rel)', local_dir=r'$tmpEsc')
    except Exception as e1:
        print('modelscope failed:', e1)
        os.environ['HF_ENDPOINT'] = 'https://hf-mirror.com'
        os.environ['HF_HUB_DISABLE_XET'] = '1'
        from huggingface_hub import hf_hub_download
        return hf_hub_download(repo_id='$($f.Repo)', filename='$($f.Rel)', local_dir=r'$tmpEsc')
p = dl()
print('saved', p)
"@
    if ($LASTEXITCODE -ne 0) {
        Remove-Item -Recurse -Force $tmpDir -ErrorAction SilentlyContinue
        if ($f.Optional) {
            Write-Host "[warn] optional post weight skipped: $($f.Out)（不影响安装与 x2 倍率：缺 x2 权重时用 x4 权重 + 输出端缩到 2 倍）"
            continue
        }
        throw "Failed to download post $($f.Out)"
    }
    # 把下载文件挪到最终路径（下载可能带 repo 内相对目录）
    $downloaded = Get-ChildItem -LiteralPath $tmpDir -Recurse -File | Where-Object { $_.Length -gt 1MB } | Select-Object -First 1
    if (-not $downloaded) {
        Remove-Item -Recurse -Force $tmpDir -ErrorAction SilentlyContinue
        if ($f.Optional) {
            Write-Host "[warn] optional post weight empty: $($f.Out)（同上，不影响安装）"
            continue
        }
        throw "post download empty: $($f.Out)"
    }
    Move-Item -LiteralPath $downloaded.FullName -Destination $dest -Force
    Remove-Item -Recurse -Force $tmpDir -ErrorAction SilentlyContinue
    if (-not ((Get-Item -LiteralPath $dest).Length -gt 1MB)) {
        if ($f.Optional) {
            Remove-Item -LiteralPath $dest -Force -ErrorAction SilentlyContinue
            Write-Host "[warn] optional post weight too small: $($f.Out)（已丢弃，不影响安装）"
            continue
        }
        throw "post file too small: $($f.Out)"
    }
}

Write-Host "100% post-processing weights ready (RealESRGAN_x4plus + RealESRGAN_x2plus(可选) + rife47)"
