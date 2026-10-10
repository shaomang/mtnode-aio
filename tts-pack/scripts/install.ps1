param(
  [string]$InstallDir = (Split-Path -Parent $MyInvocation.MyCommand.Path | Split-Path -Parent)
)

# Force UTF-8 for this process so the host (which decodes our stdout as UTF-8)
# and every native tool we spawn (pip / git / python) agree on one encoding.
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
$OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$env:PYTHONIOENCODING = 'utf-8'

$ErrorActionPreference = "Stop"

# 步骤协议（安装窗按它列步骤 / 定位失败步）：真源是包内 scripts/step.ps1
$stepLib = Join-Path $PSScriptRoot "step.ps1"
if (Test-Path $stepLib) { . $stepLib }
else {
  function Write-MTStepJson { param([string]$Id,[string]$Title,[string]$Status,[object]$Pct,[string]$Message)
    $o = [ordered]@{ mtnodeStep = 1; id = $Id; title = $Title; status = $Status }
    if ("$Pct" -ne "") { $n = 0; if ([int]::TryParse("$Pct",[ref]$n)) { $o.pct = $n } }
    if ($Message) { $o.message = $Message }
    Write-Host ($o | ConvertTo-Json -Compress -Depth 3)
  }
  function Step-Begin { param([string]$Id,[string]$Title,[object]$Pct,[string]$Message) Write-MTStepJson $Id $Title "run" $Pct $Message }
  function Step-Ok { param([string]$Id,[object]$Pct,[string]$Message) Write-MTStepJson $Id "" "ok" $Pct $Message }
  function Step-Fail { param([string]$Id,[string]$Message) Write-MTStepJson $Id "" "fail" "" $Message }
  function Step-Skip { param([string]$Id,[string]$Message) Write-MTStepJson $Id "" "skip" "" $Message }
}
Set-Location $InstallDir

Write-Host "[tts-install] ============================================================"
Write-Host "[tts-install] About the China mirrors (required; especially important when this machine is on a mainland China network):"
Write-Host "[tts-install]   - Python packages: use the Tsinghua mirror pypi.tuna.tsinghua.edu.cn (or the CAS USTC mirror mirrors.ustc.edu.cn)"
Write-Host "[tts-install]   - huggingface.co cannot be reached directly from mainland China: pretrained weights are downloaded from ModelScope first, with an automatic fallback to hf-mirror.com"
Write-Host "[tts-install]     (set the env var TTS_MODELSCOPE_REPO to point at your own ModelScope repository; default is lj1995/GPT-SoVITS)"
Write-Host "[tts-install]   - If the GitHub clone fails we automatically fall back to the ghproxy mirror"
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

Step-Begin "python" "检查 Python 3.10+" 3
$pyInfo = Find-Python
$py = $pyInfo.exe
$pyArgs = $pyInfo.args
Write-Host "[tts-install] python: $py $($pyArgs -join ' ')"
Step-Ok "python" 5

Write-Host "[tts-install] creating venv..."
Write-Host "[tts-install] progress: 10"
Step-Begin "venv" "创建虚拟环境 .venv" 7
if ($py -eq "py") {
  & py @pyArgs -m venv .venv
} else {
  & python -m venv .venv
}

$venvPy = Join-Path $InstallDir ".venv\Scripts\python.exe"
if (-not (Test-Path $venvPy)) {
  Step-Fail "venv" "venv 创建失败（$venvPy 不存在）。确认磁盘可写、Python 安装完整（含 venv 模块）后重跑。"
  throw "venv creation failed"
}
Step-Ok "venv" 10

$pipIndex = "https://pypi.tuna.tsinghua.edu.cn/simple"
$pipHost = "pypi.tuna.tsinghua.edu.cn"
Write-Host "[tts-install] pip install requirements..."
Write-Host "[tts-install] progress: 18"
Step-Begin "pip" "安装 Python 依赖（清华镜像）" 12
& $venvPy -m pip install --upgrade pip -i $pipIndex --trusted-host $pipHost
Write-Host "[tts-install] progress: 28"
& $venvPy -m pip install -r requirements.txt -i $pipIndex --trusted-host $pipHost
if ($LASTEXITCODE -ne 0) {
  Step-Fail "pip" "pip 安装 requirements.txt 失败（退出码 $LASTEXITCODE）。确认能访问 pypi.tuna.tsinghua.edu.cn 后重跑，已装好的包不会重装。"
  throw "pip install failed"
}
Write-Host "[tts-install] progress: 38"
Step-Ok "pip" 30

# ---- GPT-SoVITS engine: clone the source tree ----
$engineDir = Join-Path $InstallDir "engine"
New-Item -ItemType Directory -Force -Path $engineDir | Out-Null
$apiV2 = Join-Path $engineDir "api_v2.py"
Step-Begin "engine" "克隆 GPT-SoVITS 推理引擎" 33
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
      if ($LASTEXITCODE -ne 0 -or -not (Test-Path $apiV2)) {
        Step-Fail "engine" "克隆 GPT-SoVITS 失败：GitHub 直连与 ghproxy 镜像都不通（或本机没装 git）。装上 git 并确认网络后重跑。"
        throw "GPT-SoVITS clone failed (no git or network)"
      }
    }
  } else {
    Step-Fail "engine" "本机找不到 git，无法克隆 GPT-SoVITS。请安装 git 并保证它在 PATH 里后重跑。"
    throw "git not found - cannot clone GPT-SoVITS"
  }
}
Step-Ok "engine" 45

# ---- GPT-SoVITS engine training deps (torch + engine requirements, China mirrors) ----
$engineReq = Join-Path $engineDir "requirements.txt"
if (Test-Path $engineReq) {
  Write-Host "[tts-install] installing engine training deps (torch + GPT-SoVITS requirements)..."
  Write-Host "[tts-install] progress: 50"
  Step-Begin "torch" "安装 CUDA torch 与训练依赖" 48
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
  # onnxruntime = required for g2pw pinyin inference (the filter above drops it, so add the CPU build back here);
  # faster-whisper = required for segment-by-segment ASR transcription after long audio is auto-split.
  Add-Content -Encoding UTF8 $trainReq "pandas`nmatplotlib`ntorch-einops-utils`neinx`nloguru`nonnxruntime`nfaster-whisper"
  & $venvPy -m pip install -r $trainReq -i $pipIndex --trusted-host $pipHost
  if ($LASTEXITCODE -ne 0) {
    Step-Fail "torch" "训练依赖安装失败（退出码 $LASTEXITCODE）。看这一步日志：多为 torch / CUDA 档位与本机驱动不匹配。纯推理可先跳过训练依赖，或装对应 CUDA 档位后重跑。"
    throw "engine deps install failed"
  }
  Step-Ok "torch" 55
} else {
  Write-Host "[tts-install] warn: engine requirements.txt not found - skipping engine deps"
  Step-Skip "torch" "引擎仓库里没有 requirements.txt：跳过训练依赖"
}

$pretrained = Join-Path $engineDir "GPT_SoVITS\pretrained_models"
New-Item -ItemType Directory -Force -Path $pretrained | Out-Null
$env:HF_ENDPOINT = "https://hf-mirror.com"
$env:HF_HUB_DISABLE_XET = "1"
$msRepo = if ($env:TTS_MODELSCOPE_REPO) { $env:TTS_MODELSCOPE_REPO } else { "lj1995/GPT-SoVITS" }

Write-Host "[tts-install] downloading pretrained weights (ModelScope -> hf-mirror fallback)..."
Write-Host "[tts-install] progress: 58"
Step-Begin "weights" "下载预训练权重" 58

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
$weightFails = @()
foreach ($w in $weights) {
  $i++
  $dest = Join-Path $pretrained $w.out
  New-Item -ItemType Directory -Force -Path (Split-Path $dest) | Out-Null
  if (Test-Path $dest) { continue }
  Write-Host "[tts-install] downloading $($w.out) ($i/$total)..."
  $pct = 58 + [int]($i / $total * 22)
  Write-Host "[tts-install] progress: $pct"
  $relSlash = $w.rel -replace "\\", "/"
  # 1) ModelScope first: reachable directly from mainland China
  $msUrl = "https://www.modelscope.cn/models/$msRepo/resolve/master/$relSlash"
  $msOk = $false
  try {
    Invoke-WebRequest -Uri $msUrl -OutFile $dest -UseBasicParsing -TimeoutSec 300
    $msOk = $true
    Write-Host "[tts-install] modelscope ok: $($w.out)"
  } catch {
    Write-Host "[tts-install] modelscope failed, fallback hf-mirror: $($w.out)"
  }
  # 2) hf-mirror fallback
  if (-not $msOk) {
    try {
      & $venvPy -c "from huggingface_hub import hf_hub_download; p=hf_hub_download(repo_id='lj1995/GPT-SoVITS', filename='$relSlash', local_dir=r'$engineDir'); print('ok', p)"
      if ($LASTEXITCODE -ne 0) { Write-Host "[tts-install] warn: failed $($w.out) (continue)"; $weightFails += $w.out }
    } catch {
      Write-Host "[tts-install] warn: $($_.Exception.Message)"
      $weightFails += $w.out
    }
  }
}

if ($weightFails.Count) {
  Step-Fail "weights" ("预训练权重下载失败：" + ($weightFails -join " / ") + "。ModelScope 与 hf-mirror 都不通或文件名变了：确认网络后重跑（已下载的会跳过）。")
  throw "weights download failed: $($weightFails -join ', ')"
}
Step-Ok "weights" 80

Write-Host "[tts-install] smoke test import..."
Write-Host "[tts-install] progress: 90"
Step-Begin "smoke" "冒烟导入检查" 88
& $venvPy -m pip uninstall -y uvloop 2>$null | Out-Null
& $venvPy -c "import fastapi; from app import server, tts; print('ok')"
if ($LASTEXITCODE -ne 0) {
  Step-Fail "smoke" "冒烟导入失败：venv 里的 fastapi 或 app.server / app.tts 导不进来（依赖装了一半）。看这一步日志后重跑安装。"
  throw "smoke import failed"
}
Step-Ok "smoke" 100

New-Item -ItemType File -Force -Path (Join-Path $InstallDir ".install-ok") | Out-Null
Write-Host "[tts-install] progress: 100"
Write-Host "[tts-install] done"
exit 0