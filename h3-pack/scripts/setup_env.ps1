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

$ErrorActionPreference = "Stop"
Write-Host "============================================================"
Write-Host "[h3-setup] 国内镜像说明（必须，本机位于中国大陆网络时尤其重要）："
Write-Host "  · Python 库：默认使用清华镜像 pypi.tuna.tsinghua.edu.cn（或中科院 USTC mirrors.ustc.edu.cn，可用 MT_H3_PIP_INDEX 覆盖）"
Write-Host "  · torch cu130：优先官方 download.pytorch.org，失败自动回退阿里云镜像 mirrors.aliyun.com/pytorch-wheels/cu130（MT_H3_TORCH_INDEX 可覆盖）"
Write-Host "  · 权重优先 ModelScope(魔搭)，git clone 失败回退 ghproxy 镜像"
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

function Deploy-LocalCustomNode {
    # 随包脚手架自带的本地节点包：从 INSTALL_DIR\custom_nodes\<Name> 复制进
    # ComfyUI\custom_nodes\<Name>。幂等（逐文件覆盖），不清理 custom_nodes 里的其它节点。
    # 必须保留 web/ 与 *.api.py：web/ 由 __init__.py 的 WEB_DIRECTORY 指向，
    # 缺失会让插件注册/前端加载报错；*.api.py 提供 /nanfeng/* 等后端路由。
    param([string]$Name)
    $srcDir = Join-Path $Root "custom_nodes\$Name"
    $destDir = Join-Path $ComfyRoot "custom_nodes\$Name"
    if (-not (Test-Path -LiteralPath $srcDir)) {
        Write-Host "[skip] local custom node source missing: $srcDir"
        return
    }
    Write-Host "Deploying local custom node $Name -> $destDir ..."
    New-Item -ItemType Directory -Force -Path $destDir | Out-Null
    $robocopy = Get-Command robocopy -ErrorAction SilentlyContinue
    if ($robocopy) {
        # /XD __pycache__: 不复制字节码缓存（exit 0-7 均为成功）
        & robocopy $srcDir $destDir /E /XD __pycache__ /NFL /NDL /NJH /NJS /NP | Out-Null
        if ($LASTEXITCODE -ge 8) { throw "deploy $Name failed (robocopy exit $LASTEXITCODE)" }
    } else {
        Copy-Item -Path (Join-Path $srcDir '*') -Destination $destDir -Recurse -Force
        Get-ChildItem -Path $destDir -Recurse -Force -Directory -Filter '__pycache__' | Remove-Item -Recurse -Force
    }
    Write-Host "[ok] custom_nodes/$Name deployed"
}

function Ensure-LatentUpscalePlaceholder {
    # 南风节点把 latent_upscale_models 的 combo 声明为 required：该目录为空时
    # ComfyUI 返回 prompt_outputs_failed_validation / value_not_in_list，整单被拒。
    # 这里只保证「列表非空」：缺占位文件就补一个 10 字节的合法空 safetensors（0 张量），
    # 幂等；已存在（含用户真实 H3 放大模型）一律不删不改。
    $dir = Join-Path $ComfyRoot "models\latent_upscale_models"
    $dest = Join-Path $dir "h3_latent_upscaler_placeholder.safetensors"
    if (Test-Path -LiteralPath $dest) {
        Write-Host "[skip] latent upscale placeholder already present: $dest"
    } else {
        New-Item -ItemType Directory -Force -Path $dir | Out-Null
        # 合法空 safetensors = 8 字节小端 header 长度 + header JSON "{}"（0 张量）
        $jsonBytes = [System.Text.Encoding]::UTF8.GetBytes('{}')
        $lenBytes = [System.BitConverter]::GetBytes([int64]$jsonBytes.Length)
        $all = New-Object byte[] ($lenBytes.Length + $jsonBytes.Length)
        [System.Array]::Copy($lenBytes, 0, $all, 0, $lenBytes.Length)
        [System.Array]::Copy($jsonBytes, 0, $all, $lenBytes.Length, $jsonBytes.Length)
        [System.IO.File]::WriteAllBytes($dest, $all)
        Write-Host "[ok] wrote empty safetensors placeholder ($($all.Length) bytes): $dest"
    }
    $count = @(Get-ChildItem -LiteralPath $dir -File -ErrorAction SilentlyContinue).Count
    Write-Host "[ok] models/latent_upscale_models contains $count file(s)"
    if ($count -lt 1) { throw "models/latent_upscale_models is empty; nanfeng node combo would reject /prompt" }
}

Ensure-ComfyUI

if (-not (Test-Path $VenvPy)) {
    $basePy = Find-CudaPython
    if (-not $basePy) {
        throw "Need a Python with CUDA torch. Pass -CudaPython <path> or set MT_H3_CUDA_PYTHON."
    }
    # 禁止 --system-site-packages：否则会继承 conda 旧版 torch，
    # 与 ComfyUI 自带的 comfy_kitchen（list[int] 注解）冲突导致启动即崩溃。
    Write-Host "Creating isolated ComfyUI venv from $basePy (no system-site-packages)..."
    & $basePy -m venv $VenvDir
    if ($LASTEXITCODE -ne 0) { throw "venv creation failed" }
    Set-Content -Path (Join-Path $Root ".cuda-python") -Value $basePy -Encoding utf8
}

# 避免坏掉的 PIP_EXTRA_INDEX_URL（如 pypi.ngc.nvidia.com）干扰：--isolated 忽略机器 pip 配置
$env:PIP_EXTRA_INDEX_URL = ""
# 国内镜像：默认清华（或中科院 USTC），可用 MT_H3_PIP_INDEX 覆盖
$env:PIP_INDEX_URL = if ($env:MT_H3_PIP_INDEX) { $env:MT_H3_PIP_INDEX } else { "https://pypi.tuna.tsinghua.edu.cn/simple" }

Write-Host "Installing helper requirements (repo root)..."
& $VenvPy -m pip install --isolated -U pip
if ($LASTEXITCODE -ne 0) { throw "pip upgrade failed" }

# 先在 venv 内安装带 CUDA 的 torch，避免再用系统 site-packages 里的旧 torch。
# H3 量化算子需要 cu130 的优化 CUDA 算子；cu124/cu126 会“能启动但首步卡死”。
Write-Host "Installing CUDA torch (cu130) into venv (required for comfy_kitchen)..."
$torchIdx = if ($env:MT_H3_TORCH_INDEX) { $env:MT_H3_TORCH_INDEX } else { "https://download.pytorch.org/whl/cu130" }
$torchIdxMirror = "https://mirrors.aliyun.com/pytorch-wheels/cu130"
$torchPkgs = @("torch==2.9.1+cu130", "torchvision==0.24.1+cu130", "torchaudio==2.9.1+cu130")
& $VenvPy -m pip install --isolated --index-url $torchIdx @torchPkgs
if ($LASTEXITCODE -ne 0) {
    Write-Host "torch cu130 direct index failed; retrying with aliyun mirror (国内镜像)..."
    & $VenvPy -m pip install --isolated --index-url $torchIdxMirror @torchPkgs
    if ($LASTEXITCODE -ne 0) {
        throw "torch cu130 install failed (direct + aliyun mirror). Please update the NVIDIA driver to one that supports CUDA 13.0, then retry."
    }
}

# 校验驱动足够新：torch.cuda.is_available() 为假 => 驱动不支持 CUDA 13.0
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
# 4K 超分补帧后处理：RIFE VFI 补帧节点（rife 模型 + RealESRGAN 权重由 download_models.ps1 拉取）
Ensure-CustomNode -Name "ComfyUI-Frame-Interpolation" -Url "https://github.com/Fannovel16/ComfyUI-Frame-Interpolation.git"

# 随包脚手架自带的本地节点包（南风提示词 / H3 多参视频生成 V10，已禁用二采）：
# 从 scripts 同级 custom_nodes\ 部署进 ComfyUI\custom_nodes\nanfeng_prompt_nodes_v10。
# 依赖 soundfile（见 requirements.txt）；numpy / aiohttp 由 ComfyUI 自身提供。
Deploy-LocalCustomNode -Name "nanfeng_prompt_nodes_v10"

# 南风节点把 latent_upscale_models 的 combo 声明为 required；该目录为空会导致
# /prompt 校验失败（value_not_in_list）。补一个空占位保证列表非空，幂等。
Ensure-LatentUpscalePlaceholder

# 幂等：ComfyUI 新版 MiniMaxH3ReferenceToVideo 用 io.Autogrow 嵌套 refs，而插件发扁平键，
# 需给 execute 加 **legacy_refs 折叠扁平键，否则抛 comfy_execution_error。
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

# 可选的 Sage Attention 加速**故意不在这里装**：Windows 上 triton-windows 与 sageattention 预编译
# wheel 必须成对，且要按本机 Python / torch / CUDA 大版本挑轮子（PyPI 只有老的 sageattention 1.0.6）。
# 口径见 skill「minimax-h3-install · 可选依赖」；MTNode 侧由 H3 插件窗「Sage 加速」按钮
# （h3/main-h3.js → installSageAttention）按需补装并立刻自检，缺包时生成自动跳过 Sage。

Write-Host "Setup complete. Next: .\scripts\download_models.ps1"
