# Breeze TTS 2 本地 TTS —— 安装脚本（Windows 原生）
#
# 干四件事：
#   1. 建 .venv 并按国内镜像装依赖（torch 走 aliyun 的 pytorch-wheels 镜像）
#   2. 克隆 breeze-tts 推理引擎到 engine/（官方 clone 失败回退 ghproxy 镜像）
#   3. 下载 Breeze TTS 2 权重到 checkpoints/breeze-tts-2/（ModelScope 优先 → hf-mirror 回退 → 手填本地目录）
#   4. 下载便携 ffmpeg 到 tools/ffmpeg/（mp3 输出用；缺失不影响 wav/flac）
#
# 进度口径：[breeze-install] progress: NN  —— 宿主主进程按这个正则抓进度条。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -InstallDir "D:\mtnode\breeze"
# 可覆盖的环境变量：
#   BREEZE_WEIGHTS_DIR   已有本地权重目录（非空则跳过下载，直接软链/复制引用）
#   BREEZE_WEIGHTS_REPO  ModelScope / HF 权重仓库名（默认 BreezeBlue/breeze-tts-2）
#   BREEZE_SKIP_TORCH=1  跳过 torch 安装（调试用）
#   BREEZE_SKIP_FFMPEG=1 跳过 ffmpeg 下载
param(
  [Parameter(Mandatory = $true)][string]$InstallDir
)
$ErrorActionPreference = "Stop"
$InstallDir = (Resolve-Path -LiteralPath $InstallDir).Path
$script:Step = 0

function Say([string]$msg) { Write-Host "[breeze-install] $msg" }
function Progress([double]$pct) { Write-Host ("[breeze-install] progress: {0:N1}" -f $pct) }
function Step([string]$msg, [double]$pct) { $script:Step++; Say "── ($($script:Step)) $msg"; Progress $pct }

# 原生命令（git / pip / python）会把正常信息写 stderr，配合 $ErrorActionPreference="Stop"
# 会把「正常的输出」当成错误直接中断脚本（实测：git clone 成功、进度正常，脚本却在这一行挂掉）。
# 所以凡是调外部程序一律走这个包装：临时放行 stderr，命令自身失败仍按 $LASTEXITCODE 判定。
function Invoke-Native([string]$exe, [string[]]$cmdArgs) {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  # 顺手把 pip.ini 里可能挂着的那条不可达 extra-index 摘掉（每次调用都做，幂等）
  Remove-Item Env:\PIP_EXTRA_INDEX_URL -ErrorAction SilentlyContinue
  try {
    & $exe @cmdArgs 2>&1 | ForEach-Object { Say ("  " + $_) }
    return $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $prev
  }
}

$PIP_MIRROR  = "https://pypi.tuna.tsinghua.edu.cn/simple"
$PIP_FALLBACK= "https://mirrors.ustc.edu.cn/pypi/simple/"
$TORCH_INDEX = if ($env:BREEZE_TORCH_INDEX) { $env:BREEZE_TORCH_INDEX } else { "https://download.pytorch.org/whl/cu128" }
# torch 轮子按顺序试：官方索引（版本最全）→ 阿里云镜像（国内快，但常慢一版）
$TORCH_INDICES = @(
  $TORCH_INDEX,
  "https://mirrors.aliyun.com/pytorch-wheels/cu128",
  "https://download.pytorch.org/whl/cu126",
  "https://mirrors.aliyun.com/pytorch-wheels/cu126"
) | Select-Object -Unique
$WEIGHTS_REPO = if ($env:BREEZE_WEIGHTS_REPO) { $env:BREEZE_WEIGHTS_REPO } else { "BreezeBlue/breeze-tts-2" }
$ENGINE_DIR  = Join-Path $InstallDir "engine"
$CKPT_DIR    = Join-Path $InstallDir "checkpoints\breeze-tts-2"
$VENV        = Join-Path $InstallDir ".venv"
$VENV_PY     = Join-Path $VENV "Scripts\python.exe"
$TOOLS_DIR   = Join-Path $InstallDir "tools"

Say "InstallDir = $InstallDir"
Say "权重仓库   = $WEIGHTS_REPO"
Say "torch 镜像 = $TORCH_INDEX"
Say "许可提示   = 代码 Apache-2.0；权重与自托管输出仅限研究 / 非商用（BreezeBlue Research and Non-Commercial License）"

# ── 0. 前置：Python ────────────────────────────────────────────────
Step "检查 Python（需要 3.10+）" 1
$pyExe = $null
foreach ($cand in @("python", "python3", "py")) {
  try {
    $v = & $cand -c "import sys;print('%d.%d'%sys.version_info[:2])" 2>$null
    if ($LASTEXITCODE -eq 0 -and $v) {
      $parts = $v.Trim().Split(".")
      if ([int]$parts[0] -eq 3 -and [int]$parts[1] -ge 10) { $pyExe = $cand; Say "python = $cand ($v)"; break }
      else { Say "跳过 $cand（版本 $v < 3.10）" }
    }
  } catch { }
}
if (-not $pyExe) { throw "找不到 Python 3.10+。请先安装 Python 3.10 / 3.11 / 3.12 并勾选 Add to PATH，然后重试。" }

# ── 1. venv ───────────────────────────────────────────────────────
Step "创建虚拟环境 .venv" 5
if (-not (Test-Path -LiteralPath $VENV_PY)) {
  & $pyExe -m venv $VENV 2>&1 | ForEach-Object { Say ("  " + $_) }
  if (-not (Test-Path -LiteralPath $VENV_PY)) { throw "venv 创建失败：$VENV_PY 不存在" }
} else { Say "复用已有 .venv" }
$prevEapPip = $ErrorActionPreference
$ErrorActionPreference = "Continue"
try {
  Invoke-Native $VENV_PY @("-m", "pip", "install", "--upgrade", "pip", "--index-url", $PIP_MIRROR, "--quiet", "--disable-pip-version-check") | Out-Null
} finally { $ErrorActionPreference = $prevEapPip }
Progress 10

# ── 2. 引擎源码 ────────────────────────────────────────────────────
Step "获取 Breeze TTS 推理引擎（breeze-tts）" 14
$engineOk = Test-Path -LiteralPath (Join-Path $ENGINE_DIR "infer.py")
if ($engineOk) {
  Say "engine/ 已在，跳过克隆"
} else {
  New-Item -ItemType Directory -Force -Path $ENGINE_DIR | Out-Null
  $cloned = $false
  if (Get-Command git -ErrorAction SilentlyContinue) {
    foreach ($url in @("https://github.com/breezeblue-ai/breeze-tts", "https://ghproxy.com/https://github.com/breezeblue-ai/breeze-tts")) {
      Say "git clone $url"
      Invoke-Native "git" @("clone", "--depth", "1", $url, $ENGINE_DIR) | Out-Null
      if (Test-Path -LiteralPath (Join-Path $ENGINE_DIR "infer.py")) { $cloned = $true; break }
      if (Test-Path -LiteralPath $ENGINE_DIR) { Remove-Item -Recurse -Force -LiteralPath $ENGINE_DIR -ErrorAction SilentlyContinue }
      New-Item -ItemType Directory -Force -Path $ENGINE_DIR | Out-Null
    }
  } else { Say "未找到 git，改用 zip 下载" }
  if (-not $cloned) {
    foreach ($zip in @("https://ghproxy.com/https://github.com/breezeblue-ai/breeze-tts/archive/refs/heads/main.zip",
                       "https://github.com/breezeblue-ai/breeze-tts/archive/refs/heads/main.zip")) {
      $tmp = Join-Path $env:TEMP ("breeze-tts-" + [guid]::NewGuid().ToString("N") + ".zip")
      try {
        Say "下载 $zip"
        Invoke-WebRequest -Uri $zip -OutFile $tmp -UseBasicParsing -TimeoutSec 300
        $ex = Join-Path $env:TEMP ("breeze-tts-x-" + [guid]::NewGuid().ToString("N"))
        Expand-Archive -LiteralPath $tmp -DestinationPath $ex -Force
        $inner = Get-ChildItem -LiteralPath $ex -Directory | Select-Object -First 1
        if ($inner) { Copy-Item -Path (Join-Path $inner.FullName "*") -Destination $ENGINE_DIR -Recurse -Force }
        Remove-Item -Recurse -Force $ex, $tmp -ErrorAction SilentlyContinue
        if (Test-Path -LiteralPath (Join-Path $ENGINE_DIR "infer.py")) { $cloned = $true; break }
      } catch { Say "  失败：$($_.Exception.Message)" }
    }
  }
  if (-not $cloned) { throw "引擎源码获取失败：请检查网络，或手工把 breeze-tts 仓库内容放到 $ENGINE_DIR" }
}
Progress 20

# ── 3. Python 依赖 ─────────────────────────────────────────────────
Step "安装 Python 依赖（国内镜像）" 24
$reqFile = Join-Path $ENGINE_DIR "requirements.txt"
if (Test-Path -LiteralPath $reqFile) {
  # 掉测试/静态检查类依赖：pytest / ruff 不必装
  $filtered = Join-Path $InstallDir "requirements.breeze.txt"
  Get-Content -LiteralPath $reqFile |
    Where-Object { $_ -notmatch '^\s*(pytest|ruff)' } |
    Set-Content -LiteralPath $filtered -Encoding UTF8
  Say "依赖清单 = $filtered"
} else { throw "缺少 engine/requirements.txt（引擎源码不完整）" }

if ($env:BREEZE_SKIP_TORCH -ne "1") {
  Say "装 torch / torchaudio（CUDA 版；按顺序试 $($TORCH_INDICES -join ' → ')）"
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  $torchRc = 1
  try {
    foreach ($idx in $TORCH_INDICES) {
      Say "torch 索引：$idx"
      $torchRc = Invoke-Native $VENV_PY @("-m", "pip", "install", "torch==2.9.1", "torchaudio==2.9.1", "--index-url", $idx)
      if ($torchRc -eq 0) { Say "torch 装好了（$idx）"; break }
      Say "该索引没成功（exit $torchRc），换下一个"
    }
  } finally { $ErrorActionPreference = $prevEap }
  if ($torchRc -ne 0) {
    throw "torch 安装失败（试过的索引：$($TORCH_INDICES -join ' / ')）——见上方 pip 输出；也可用 BREEZE_TORCH_INDEX 指定自己的镜像后重跑"
  }
} else { Say "BREEZE_SKIP_TORCH=1：跳过 torch" }
Progress 54

Step "安装其余依赖" 56
# gradio 是 qwen-tts 的间接依赖且没钉版本：pip 会在 6.17~6.29 之间反复回溯，每轮都要下一个
# 31MB 的轮子（实测能磨十几分钟）。这里先按固定版本把它装上（--no-deps 绕开回溯），
# 再让 pip 按 requirements 收尾 —— 结果一致，时间从十几分钟压到一两分钟。
$TORCH_INDEX_ARG = ($TORCH_INDICES | Select-Object -First 1)
$prevEapG = $ErrorActionPreference
$ErrorActionPreference = "Continue"
try {
  Say "预装 gradio==6.29.1（避免 pip 对它反复回溯）"
  Invoke-Native $VENV_PY @("-m", "pip", "install", "--index-url", $PIP_MIRROR, "--no-deps", "gradio==6.29.1", "gradio-client==2.7.2") | Out-Null
  $depsRc = Invoke-Native $VENV_PY @("-m", "pip", "install", "-r", $filtered, "--index-url", $PIP_MIRROR, "--extra-index-url", $TORCH_INDEX_ARG)
  if ($depsRc -ne 0) {
    Say "清华镜像失败（exit $depsRc），回退 $PIP_FALLBACK"
    $depsRc = Invoke-Native $VENV_PY @("-m", "pip", "install", "-r", $filtered, "--index-url", $PIP_FALLBACK, "--extra-index-url", $TORCH_INDEX_ARG)
  }
} finally { $ErrorActionPreference = $prevEapG }
if ($depsRc -ne 0) { throw "Python 依赖安装失败（见上方 pip 输出）" }
Progress 78

# ── 4. 权重 ────────────────────────────────────────────────────────
Step "准备 Breeze TTS 2 权重" 80
New-Item -ItemType Directory -Force -Path $CKPT_DIR | Out-Null
$localWeights = if ($env:BREEZE_WEIGHTS_DIR) { $env:BREEZE_WEIGHTS_DIR } else { "" }
function Test-Ckpt([string]$dir) {
  if (-not $dir) { return $false }
  if (-not (Test-Path -LiteralPath $dir)) { return $false }
  $hasCfg = (Get-ChildItem -LiteralPath $dir -Filter "config.json" -File -ErrorAction SilentlyContinue | Measure-Object).Count -gt 0
  $hasWts = (Get-ChildItem -LiteralPath $dir -Recurse -Include "*.safetensors","*.pt","*.bin" -File -ErrorAction SilentlyContinue | Measure-Object).Count -gt 0
  return ($hasCfg -and $hasWts)
}
if (Test-Ckpt $CKPT_DIR) {
  Say "权重已在 $CKPT_DIR，跳过下载"
} elseif ($localWeights -and (Test-Ckpt $localWeights)) {
  Say "使用 BREEZE_WEIGHTS_DIR 指定的本地权重：$localWeights"
  $marker = Join-Path $CKPT_DIR "USE_LOCAL_WEIGHTS.txt"
  Set-Content -LiteralPath $marker -Value $localWeights -Encoding UTF8
} else {
  if ($localWeights) { Say "BREEZE_WEIGHTS_DIR 指向的目录不完整（缺 config.json 或权重文件），改为下载" }
  Invoke-Native $VENV_PY @("-m", "pip", "install", "--quiet", "--index-url", $PIP_MIRROR, "huggingface_hub") | Out-Null
  $dl = Join-Path $InstallDir "scripts\download_weights.py"
  $src = Join-Path $PSScriptRoot "download_weights.py"
  if (Test-Path -LiteralPath $src) { Copy-Item -LiteralPath $src -Destination $dl -Force }
  if (-not (Test-Path -LiteralPath $dl)) { throw "缺少 scripts/download_weights.py（安装脚本被拆散）" }
  $dlArgs = @($dl, "--repo", $WEIGHTS_REPO, "--dest", $CKPT_DIR)
  if ($env:BREEZE_WEIGHTS_REVISION) { $dlArgs += @("--revision", $env:BREEZE_WEIGHTS_REVISION) }
  $prevEap3 = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    & $VENV_PY @dlArgs 2>&1 |
      ForEach-Object { $s = "$_"; if ($s -match 'progress:\s*(\d+(?:\.\d+)?)') { Progress (80 + [double]$matches[1] * 0.14) }; Say ("  " + $s) }
    $dlRc = $LASTEXITCODE
  } finally { $ErrorActionPreference = $prevEap3 }
  if ($dlRc -ne 0 -or -not (Test-Ckpt $CKPT_DIR)) {
    throw "权重下载失败。可手工下载 $WEIGHTS_REPO 全部文件到 $CKPT_DIR，或设置 BREEZE_WEIGHTS_DIR 指向已有目录后重跑。"
  }
}
Progress 95

# ── 5. 便携 ffmpeg（mp3 用） ───────────────────────────────────────
if ($env:BREEZE_SKIP_FFMPEG -ne "1") {
  Step "准备便携 ffmpeg（mp3 输出用）" 96
  $ffDir = Join-Path $TOOLS_DIR "ffmpeg"
  $ffExe = Join-Path $ffDir "ffmpeg.exe"
  if (Test-Path -LiteralPath $ffExe) {
    Say "ffmpeg 已在 $ffExe"
  } else {
    New-Item -ItemType Directory -Force -Path $ffDir | Out-Null
    $ok = $false
    foreach ($url in @("https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip",
                       "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip")) {
      $tmp = Join-Path $env:TEMP ("ffmpeg-" + [guid]::NewGuid().ToString("N") + ".zip")
      try {
        Say "下载 $url"
        Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing -TimeoutSec 600
        $ex = Join-Path $env:TEMP ("ffmpeg-x-" + [guid]::NewGuid().ToString("N"))
        Expand-Archive -LiteralPath $tmp -DestinationPath $ex -Force
        $found = Get-ChildItem -LiteralPath $ex -Recurse -Filter "ffmpeg.exe" -File | Select-Object -First 1
        if ($found) { Copy-Item -LiteralPath $found.FullName -Destination $ffExe -Force; $ok = $true }
        Remove-Item -Recurse -Force $ex, $tmp -ErrorAction SilentlyContinue
        if ($ok) { break }
      } catch { Say "  失败：$($_.Exception.Message)" }
    }
    if ($ok) { Say "ffmpeg 就绪：$ffExe" }
    else { Say "ffmpeg 下载失败：不影响 wav / flac，mp3 输出会提示缺少 ffmpeg（可手工把 ffmpeg.exe 放到 $ffDir）" }
  }
} else { Say "BREEZE_SKIP_FFMPEG=1：跳过 ffmpeg" }

# ── 6. 冒烟 & 落标记（闸门：冒烟不过就不算装好） ─────────────────────
#   为什么必须是闸门：以前这里失败只打印一行，随后照样写 .install-ok —— 宿主据此认定「装好」，
#   用户点启用才炸（依赖没装全 / CPU 版 torch），而安装链的 Agent 保底（脚本非 0 退出才触发）
#   永远等不到，报错总线也收不到事件。结果就是「安装完成但用不了，而且没有任何自愈」。
#   口径与兄弟后端一致：tts / llama 是 throw，sensenova 是冒烟不过不写 .install-ok 并写 ok=false。
Step "冒烟校验（import torch / soundfile / fastapi）" 98
$smoke = @"
import sys
import soundfile, fastapi, uvicorn
import torch
print('torch', torch.__version__, 'cuda', torch.cuda.is_available(), torch.version.cuda)
if not torch.cuda.is_available():
    print('WARN: torch 看不到 CUDA —— Breeze TTS 2 需要 NVIDIA GPU（约 7.7GB 显存）')
"@
$smokeFile = Join-Path $InstallDir "scripts\_smoke_breeze.py"
Set-Content -LiteralPath $smokeFile -Value $smoke -Encoding UTF8
& $VENV_PY $smokeFile 2>&1 | ForEach-Object { Say ("  " + $_) }
$smokeRc = $LASTEXITCODE

# CUDA 可用性单独判：引擎需要 NVIDIA 显卡 + CUDA 版 torch（约 7.7GB 显存）。
# 这一条「Agent 再跑一遍也不会变好」（它变不出显卡），所以不交给 AI 修复，只写裁决给用户指路。
$cudaRc = 0
if ($smokeRc -eq 0) {
  & $VENV_PY -c "import sys, torch; sys.exit(0 if torch.cuda.is_available() else 3)" 2>&1 | ForEach-Object { Say ("  " + $_) }
  $cudaRc = $LASTEXITCODE
}

$installOk = Join-Path $InstallDir ".install-ok"
$resultMarker = Join-Path $InstallDir ".breeze-agent-result"
# 旧标记先撤：失败的重装 / 补装绝不能靠上一次的 .install-ok 冒充装好（宿主认它 + 要件）
Remove-Item -Force $installOk -ErrorAction SilentlyContinue

function Write-Verdict([string]$okFlag, [string]$reason) {
  $lines = @("ok=$okFlag")
  if ($reason) { $lines += "reason=$reason" }
  $lines += "via=script"
  Set-Content -LiteralPath $resultMarker -Value $lines -Encoding UTF8
}

New-Item -ItemType Directory -Force -Path (Join-Path $InstallDir "voices"), (Join-Path $InstallDir "logs"), (Join-Path $InstallDir "out") | Out-Null

if ($smokeRc -ne 0) {
  Say "冒烟 import 失败（exit $smokeRc）——依赖可能没装全，安装未完成，不写 .install-ok。"
  Write-Verdict "false" "smoke_failed"
  Say "已交回宿主：会自动转 Agent 按 skill 修复（不用你来读这些日志）。"
  exit 1
}
if ($cudaRc -ne 0 -and $env:BREEZE_SKIP_CUDA_CHECK -ne "1") {
  Say "torch 看不到 CUDA —— Breeze TTS 2 需要 NVIDIA 显卡与可用的 CUDA 版 torch（约 7.7GB 显存），安装未完成。"
  Say "指路：确认本机有 NVIDIA 显卡且驱动可用；确需在无卡机器上做静态排查，可设 BREEZE_SKIP_CUDA_CHECK=1 后重跑。"
  Write-Verdict "false" "no_cuda"
  exit 1
}
if ($cudaRc -ne 0) { Say "BREEZE_SKIP_CUDA_CHECK=1：跳过 CUDA 闸门，照常落标记（仅供无卡机器静态排查）。" }

Set-Content -LiteralPath $installOk -Value (Get-Date -Format o) -Encoding UTF8
Write-Verdict "true" ""
Progress 100
Say "安装完成。用「插件 · Breeze TTS 2 本地 TTS」的「开始」拉起后端（首次启动加载约 7.7GB 权重，需要一会儿）。"
exit 0
