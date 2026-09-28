param(
  [string]$InstallDir = (Split-Path -Parent $MyInvocation.MyCommand.Path | Split-Path -Parent)
)

$ErrorActionPreference = "Stop"
Set-Location $InstallDir

Write-Host "[tts-install] ============================================================"
Write-Host "[tts-install] 国内镜像说明（必须，本机位于中国大陆网络时尤其重要）："
Write-Host "[tts-install]   · Python 库：使用清华镜像 pypi.tuna.tsinghua.edu.cn（或中科院 USTC mirrors.ustc.edu.cn）"
Write-Host "[tts-install]   · HuggingFace 国内无法直连：预训练权重优先从 ModelScope(魔搭) 下载，失败自动回退 hf-mirror.com"
Write-Host "[tts-install]     （可用环境变量 TTS_MODELSCOPE_REPO 指定你的 ModelScope 仓库，默认 lj1995/GPT-SoVITS）"
Write-Host "[tts-install]   · GitHub 克隆失败自动回退 ghproxy 镜像"
Write-Host "[tts-install] ============================================================"
Write-Host "[tts-install] install dir: $InstallDir"
Write-Host "[tts-install] progress: 5"

function Find-Python {
  if (Get-Command py -ErrorAction SilentlyContinue) {
    foreach ($ver in @("3.10", "3.11", "3.12")) {
      try {
        $out = & py -$ver -c "import sys; print(sys.version_info[:2])" 2>$null
        if ($LASTEXITCODE -eq 0) { return @{ exe = "py"; args = @("-$ver") } }
      } catch {}
    }
  }
  if (Get-Command python -ErrorAction SilentlyContinue) {
    return @{ exe = "python"; args = @() }
  }
  throw "Python 3.10+ not found"
}

$pyInfo = Find-Python
$py = $pyInfo.exe
$pyArgs = $pyInfo.args

Write-Host "[tts-install] creating venv..."
Write-Host "[tts-install] progress: 10"
if ($py -eq "py") {
  & py @pyArgs -m venv .venv
} else {
  & python -m venv .venv
}

$venvPy = Join-Path $InstallDir ".venv\Scripts\python.exe"
if (-not (Test-Path $venvPy)) { throw "venv creation failed" }

$pipIndex = "https://pypi.tuna.tsinghua.edu.cn/simple"
$pipHost = "pypi.tuna.tsinghua.edu.cn"
Write-Host "[tts-install] pip install requirements..."
Write-Host "[tts-install] progress: 18"
& $venvPy -m pip install --upgrade pip -i $pipIndex --trusted-host $pipHost
Write-Host "[tts-install] progress: 28"
& $venvPy -m pip install -r requirements.txt -i $pipIndex --trusted-host $pipHost
Write-Host "[tts-install] progress: 38"

# ---- GPT-SoVITS 引擎：克隆源码 ----
$engineDir = Join-Path $InstallDir "engine"
New-Item -ItemType Directory -Force -Path $engineDir | Out-Null
$apiV2 = Join-Path $engineDir "api_v2.py"
if (-not (Test-Path $apiV2)) {
  Write-Host "[tts-install] cloning GPT-SoVITS (shallow)..."
  Write-Host "[tts-install] progress: 48"
  $git = Get-Command git -ErrorAction SilentlyContinue
  if ($git) {
    & git clone --depth 1 https://github.com/RVC-Boss/GPT-SoVITS.git $engineDir 2>&1 | Out-Host
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path $apiV2)) {
      Write-Host "[tts-install] github clone failed; trying ghproxy mirror..."
      Remove-Item -Recurse -Force $engineDir -ErrorAction SilentlyContinue
      New-Item -ItemType Directory -Force -Path $engineDir | Out-Null
      & git clone --depth 1 https://ghproxy.com/https://github.com/RVC-Boss/GPT-SoVITS.git $engineDir 2>&1 | Out-Host
      if ($LASTEXITCODE -ne 0 -or -not (Test-Path $apiV2)) { throw "GPT-SoVITS clone failed (no git or network)" }
    }
  } else {
    throw "git not found — cannot clone GPT-SoVITS"
  }
}

# ---- GPT-SoVITS 引擎训练依赖（torch + 引擎 requirements，国内镜像）----
$engineReq = Join-Path $engineDir "requirements.txt"
if (Test-Path $engineReq) {
  Write-Host "[tts-install] installing engine training deps (torch + GPT-SoVITS requirements)..."
  Write-Host "[tts-install] progress: 50"
  # torch (CUDA build; tsinghua mirror only carries CPU wheels, use aliyun cu126)
  & $venvPy -m pip install "torch==2.6.0" "torchaudio==2.6.0" --index-url https://mirrors.aliyun.com/pytorch-wheels/cu126
  if ($LASTEXITCODE -ne 0) {
    Write-Host "[tts-install] aliyun cu126 failed, falling back to pytorch official cu126 index..."
    & $venvPy -m pip install "torch==2.6.0+cu126" "torchaudio==2.6.0" --index-url https://download.pytorch.org/whl/cu126
  }
  if ($LASTEXITCODE -ne 0) { Write-Host "[tts-install] warn: torch install failed (training will not work)" }
  # engine requirements minus webui/asr/onnx bloat we do not need, minus
  # '--no-binary=opencc' (would force a source build on Windows) and minus
  # 'fastapi[standard]' (uvloop has no Windows wheel)
  $trainReq = Join-Path $engineDir "requirements-train.txt"
  Get-Content $engineReq | Where-Object {
    $_ -and $_ -notmatch '^\s*(--no-binary|gradio|funasr|onnxruntime|modelscope|fastapi\[standard\])'
  } | Set-Content -Encoding UTF8 $trainReq
  # pandas + matplotlib are imported at module top level by the engine
  # (module/AR datasets, tools.my_utils) but are not listed in requirements.txt
  # x_transformers>=2.28 hard-requires torch-einops-utils / einx / loguru; list
  # them explicitly so a partial --target install can never leave the package
  # body missing (semantic phase crash).
  # onnxruntime = g2pw 拼音推理必需（上面的过滤把它去掉了，这里补回 CPU 版）；
  # faster-whisper = 长音频自动切分后的逐段 ASR 转写必需。
  Add-Content -Encoding UTF8 $trainReq "pandas`nmatplotlib`ntorch-einops-utils`neinx`nloguru`nonnxruntime`nfaster-whisper"
  & $venvPy -m pip install -r $trainReq -i $pipIndex --trusted-host $pipHost
  if ($LASTEXITCODE -ne 0) { Write-Host "[tts-install] warn: engine deps install failed (training may not work)" }
} else {
  Write-Host "[tts-install] warn: engine requirements.txt not found — skipping engine deps"
}

$pretrained = Join-Path $engineDir "GPT_SoVITS\pretrained_models"
New-Item -ItemType Directory -Force -Path $pretrained | Out-Null
$env:HF_ENDPOINT = "https://hf-mirror.com"
$env:HF_HUB_DISABLE_XET = "1"
$msRepo = if ($env:TTS_MODELSCOPE_REPO) { $env:TTS_MODELSCOPE_REPO } else { "lj1995/GPT-SoVITS" }

Write-Host "[tts-install] downloading pretrained weights (ModelScope -> hf-mirror fallback)..."
Write-Host "[tts-install] progress: 58"

$weights = @(
  @{ rel = "GPT_SoVITS/pretrained_models/s1bert25hz-2kh-longer-epoch=68e-step=50232.ckpt"; out = "s1bert25hz-2kh-longer-epoch=68e-step=50232.ckpt" },
  @{ rel = "GPT_SoVITS/pretrained_models/s2G233k.pth"; out = "s2G233k.pth" },
  @{ rel = "GPT_SoVITS/pretrained_models/chinese-hubert-base/config.json"; out = "chinese-hubert-base/config.json" },
  @{ rel = "GPT_SoVITS/pretrained_models/chinese-hubert-base/pytorch_model.bin"; out = "chinese-hubert-base/pytorch_model.bin" },
  @{ rel = "GPT_SoVITS/pretrained_models/chinese-roberta-wwm-ext-large/config.json"; out = "chinese-roberta-wwm-ext-large/config.json" },
  @{ rel = "GPT_SoVITS/pretrained_models/chinese-roberta-wwm-ext-large/pytorch_model.bin"; out = "chinese-roberta-wwm-ext-large/pytorch_model.bin" }
)

$total = $weights.Count
$i = 0
foreach ($w in $weights) {
  $i++
  $dest = Join-Path $pretrained $w.out
  New-Item -ItemType Directory -Force -Path (Split-Path $dest) | Out-Null
  if (Test-Path $dest) { continue }
  Write-Host "[tts-install] downloading $($w.out) ($i/$total)..."
  $pct = 58 + [int]($i / $total * 22)
  Write-Host "[tts-install] progress: $pct"
  $relSlash = $w.rel -replace "\\", "/"
  # 1) ModelScope(魔搭) 国内直连优先
  $msUrl = "https://www.modelscope.cn/models/$msRepo/resolve/master/$relSlash"
  $msOk = $false
  try {
    Invoke-WebRequest -Uri $msUrl -OutFile $dest -UseBasicParsing -TimeoutSec 300
    $msOk = $true
    Write-Host "[tts-install] modelscope ok: $($w.out)"
  } catch {
    Write-Host "[tts-install] modelscope failed, fallback hf-mirror: $($w.out)"
  }
  # 2) hf-mirror 兜底
  if (-not $msOk) {
    try {
      & $venvPy -c "from huggingface_hub import hf_hub_download; p=hf_hub_download(repo_id='lj1995/GPT-SoVITS', filename='$relSlash', local_dir=r'$engineDir'); print('ok', p)"
      if ($LASTEXITCODE -ne 0) { Write-Host "[tts-install] warn: failed $($w.out) (continue)" }
    } catch {
      Write-Host "[tts-install] warn: $($_.Exception.Message)"
    }
  }
}

Write-Host "[tts-install] smoke test import..."
Write-Host "[tts-install] progress: 90"
& $venvPy -m pip uninstall -y uvloop 2>$null | Out-Null
& $venvPy -c "import fastapi; from app import server, tts; print('ok')"
if ($LASTEXITCODE -ne 0) { throw "smoke import failed" }

New-Item -ItemType File -Force -Path (Join-Path $InstallDir ".install-ok") | Out-Null
Write-Host "[tts-install] progress: 100"
Write-Host "[tts-install] done"
exit 0
