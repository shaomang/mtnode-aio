# =============================================================================
# Qwen3-ASR 本地语音识别后端 —— 安装 / 修复脚本（PowerShell，可重复执行 · 幂等）
#
# 做什么：
#   1. 建 .venv（py -3 或 python；找不到就报明确错误）
#   2. pip 装依赖（清华镜像）
#   3. 装 **只看 CUDA 版 torch**（按本机驱动自动匹配 cu13x / cu12x，失败降一档；
#      -Cpu 时改装 CPU 版 —— 这是给没有 N 卡的高级用户的显式后门）
#   4. 下载便携 ffmpeg 到 <InstallDir>\ffmpeg\（wav/mp3/flac/m4a/ogg/aac 全覆盖）；
#      多源 + 逐源重试 + TLS1.2 + zip 头校验 + 可执行校验，到位写 .ffmpeg-ok；
#      **失败即判安装不完整**（不写 .install-ok，写 ok=false reason=ffmpeg_failed）——
#      后端所有音频都要经 ffmpeg 解码，缺它等于装不上
#   5. 用 modelscope 下 Qwen/Qwen3-ASR-0.6B 与 iic/speech_fsmn_vad_zh-cn-16k-common-pytorch
#      到 <InstallDir>\models（失败回退 HF_ENDPOINT=https://hf-mirror.com）
#   6. 建 <InstallDir>\models\.ok 与 <InstallDir>\.install-ok 标记
#   7. 用 venv python 跑一次 MTNODE_ASR_MOCK=1 的 mock 冒烟（起服务 → /health → mock 转写 → 关闭）
#
# 进度输出：[asr-install] progress: NN（0-100，便于上层解析）
# 注意：本脚本**不会**把服务留在后台常驻（冒烟结束即关闭），启停由 MTNode 负责。
# 可重复执行（幂等）：装到一半失败 / 只缺 ffmpeg 时重跑本脚本即可补齐；
# 参数：-InstallDir / -Cpu / -TorchIndex / -ModelDir / -SkipModels / -FfmpegOnly / -ForceFfmpeg。
# 只想补 ffmpeg 用 -FfmpegOnly（插件控制台「补装 ffmpeg」按钮走这个口径）。
# =============================================================================
param(
  [string]$InstallDir = (Split-Path -Parent $MyInvocation.MyCommand.Path | Split-Path -Parent),
  [switch]$Cpu,          # 装 CPU 版 torch（无 N 卡机器的后门；上层默认会拦无 N 卡安装）
  [string]$TorchIndex = "",  # 显式指定 torch index-url（默认按驱动自动匹配）
  [string]$ModelDir = "",    # 已有模型目录（离线安装 / 复用）→ 软链或复制进 <InstallDir>\models
  [switch]$SkipModels,       # 跳过模型下载（模型已就位、只想修 venv 时用）
  [switch]$FfmpegOnly,       # 只补装便携 ffmpeg（venv / 依赖 / torch / 模型 / 冒烟全跳过）
  [switch]$ForceFfmpeg       # 即使 <InstallDir>\ffmpeg\bin\ffmpeg.exe 已存在也重新下载
)

$ErrorActionPreference = "Stop"
$ProgressDone = 0

function Write-Progress-Line([int]$Pct, [string]$Msg) {
  $script:ProgressDone = $Pct
  Write-Host "[asr-install] progress: $Pct"
  if ($Msg) { Write-Host "[asr-install] $Msg" }
}

Write-Host "[asr-install] ============================================================"
Write-Host "[asr-install] Qwen3-ASR 本地语音识别后端安装"
Write-Host "[asr-install]   模型：Qwen/Qwen3-ASR-0.6B（约 1.88GB，apache-2.0，固定不切换）"
Write-Host "[asr-install]   分段：iic/speech_fsmn_vad_zh-cn-16k-common-pytorch（fsmn-vad）"
Write-Host "[asr-install]   Python 库：清华镜像 pypi.tuna.tsinghua.edu.cn"
Write-Host "[asr-install]   torch：CUDA 版走 download.pytorch.org 官方 index（按驱动 cu13x / cu12x，失败降档）；-Cpu 装 CPU 版"
Write-Host "[asr-install]   模型下载：ModelScope 优先，失败回退 HF_ENDPOINT=https://hf-mirror.com"
Write-Host "[asr-install] ============================================================"
Write-Host "[asr-install] install dir: $InstallDir"
Write-Progress-Line 2 ""

if (-not (Test-Path $InstallDir)) {
  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
}
$InstallDir = (Resolve-Path $InstallDir).Path
Set-Location $InstallDir

$PipIndex = "https://pypi.tuna.tsinghua.edu.cn/simple"
$PipHost = "pypi.tuna.tsinghua.edu.cn"
$PipIndexFallback = "https://mirrors.aliyun.com/pypi/simple/"
$env:HF_ENDPOINT = "https://hf-mirror.com"
$env:HF_HUB_DISABLE_XET = "1"

# Windows PowerShell 5.1 默认可能还在 TLS1.0，导致 Invoke-WebRequest 下 HTTPS 直接失败
# （pip 自带 TLS 栈所以「依赖装得上、ffmpeg 下不动」，这正是缺 ffmpeg 的根因之一）。
try {
  [Net.ServicePointManager]::SecurityProtocol =
    [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch {
  Write-Host "[asr-install] 提示：无法显式设置 TLS1.2（$($_.Exception.Message)），继续尝试下载"
}

$ffmpegExe = Join-Path $InstallDir "ffmpeg\bin\ffmpeg.exe"

# ---------------------------------------------------------------- ffmpeg 工具
# 便携 ffmpeg：多源 + 逐源重试 + zip 头校验 + 可执行校验；成功返回 $true。
# 已有便携版（或系统 PATH 里已有 ffmpeg）视为成功 —— 后端 audio.py 也会回退 PATH。
function Install-PortableFfmpeg {
  if ((Test-Path $ffmpegExe) -and (-not $ForceFfmpeg)) {
    Write-Host "[asr-install] ffmpeg 已存在，跳过：$ffmpegExe"
    return $true
  }
  $urls = @(
    "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip",
    "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip",
    "https://ghfast.top/https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip",
    "https://ghproxy.net/https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip",
    "https://gh-proxy.com/https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip"
  )
  $ok = $false
  foreach ($url in $urls) {
    if ($ok) { break }
    for ($try = 1; $try -le 2 -and -not $ok; $try++) {
      $tmpZip = Join-Path $env:TEMP ("mtnode-asr-ffmpeg-" + [guid]::NewGuid().ToString("N") + ".zip")
      $exDir = Join-Path $env:TEMP ("mtnode-asr-ffmpeg-x-" + [guid]::NewGuid().ToString("N"))
      try {
        Write-Host "[asr-install] 下载 ffmpeg（第 $try 次）：$url"
        $oldProgress = $ProgressPreference
        $ProgressPreference = "SilentlyContinue"
        try {
          Invoke-WebRequest -Uri $url -OutFile $tmpZip -UseBasicParsing -TimeoutSec 600 `
            -Headers @{ "User-Agent" = "MTNode-ASR-Installer" }
        } finally {
          $ProgressPreference = $oldProgress
        }
        if ((-not (Test-Path $tmpZip)) -or ((Get-Item $tmpZip).Length -lt 1MB)) {
          Write-Host "[asr-install] 下载内容过小（<1MB），视为失败"
          continue
        }
        # zip 头必须是 PK —— 避免把「404 / 拦截页」当压缩包去解压
        $head = $null
        try { $head = Get-Content -Path $tmpZip -Encoding Byte -TotalCount 2 -ErrorAction Stop } catch { $head = $null }
        if ($head -and (($head[0] -ne 0x50) -or ($head[1] -ne 0x4B))) {
          Write-Host "[asr-install] 响应不是 zip（可能是错误页），换源重试"
          continue
        }
        New-Item -ItemType Directory -Force -Path $exDir | Out-Null
        Expand-Archive -Path $tmpZip -DestinationPath $exDir -Force
        $src = Get-ChildItem -Path $exDir -Recurse -Filter "ffmpeg.exe" -File | Select-Object -First 1
        if (-not $src) {
          Write-Host "[asr-install] 压缩包内没找到 ffmpeg.exe"
          continue
        }
        New-Item -ItemType Directory -Force -Path (Join-Path $InstallDir "ffmpeg\bin") | Out-Null
        Copy-Item $src.FullName $ffmpegExe -Force
        # ffprobe 一起带上（用于取时长，缺了也能跑，只是 duration_sec 退化为 0）
        $probe = Get-ChildItem -Path $exDir -Recurse -Filter "ffprobe.exe" -File | Select-Object -First 1
        if ($probe) { Copy-Item $probe.FullName (Join-Path $InstallDir "ffmpeg\bin\ffprobe.exe") -Force }
        $ok = (Test-Path $ffmpegExe)
      } catch {
        Write-Host "[asr-install] 该源下载 / 解压失败：$($_.Exception.Message)"
      } finally {
        Remove-Item -Recurse -Force $exDir -ErrorAction SilentlyContinue
        Remove-Item -Force $tmpZip -ErrorAction SilentlyContinue
      }
    }
  }
  if (-not $ok) {
    $sys = Get-Command ffmpeg -ErrorAction SilentlyContinue
    if ($sys) {
      Write-Host "[asr-install] 便携版下载失败，但系统 PATH 里已有 ffmpeg：$($sys.Source)（后端会回退 PATH）"
      return $true
    }
    Write-Host "[asr-install] 警告：ffmpeg 全部下载源失败 —— 可手动把 ffmpeg.exe 放到 $ffmpegExe，"
    Write-Host "[asr-install]       或把 ffmpeg 加入系统 PATH，然后在插件控制台点「补装 ffmpeg」重试。"
    return $false
  }
  try {
    & $ffmpegExe -version *> $null
    if ($LASTEXITCODE -ne 0) { Write-Host "[asr-install] 警告：ffmpeg.exe 已复制但执行校验未通过" }
  } catch {
    Write-Host "[asr-install] 警告：ffmpeg.exe 执行校验异常：$($_.Exception.Message)"
  }
  return $true
}

# 到位写 .ffmpeg-ok（内容 = 实际 ffmpeg 路径或 PATH），失败删掉旧标记
function Write-FfmpegMarker([bool]$Ok) {
  $m = Join-Path $InstallDir ".ffmpeg-ok"
  if ($Ok) {
    $src = if (Test-Path $ffmpegExe) { $ffmpegExe } else { "PATH" }
    Set-Content -Path $m -Value $src -Encoding UTF8
  } else {
    Remove-Item -Force $m -ErrorAction SilentlyContinue
  }
}

# 只补 ffmpeg 的快速通道：venv / 依赖 / torch / 模型 / 冒烟全部跳过
if ($FfmpegOnly) {
  Write-Host "[asr-install] 模式：仅补装便携 ffmpeg（-FfmpegOnly）"
  Write-Progress-Line 10 "补装便携 ffmpeg..."
  $ffmpegOk = Install-PortableFfmpeg
  Write-FfmpegMarker $ffmpegOk
  if (-not $ffmpegOk) {
    Write-Host "[asr-install] 错误：ffmpeg 未能就位（reason=ffmpeg_failed）"
    Set-Content -Path (Join-Path $InstallDir ".asr-agent-result") -Value "ok=false`nreason=ffmpeg_failed" -Encoding UTF8
    exit 1
  }
  Write-Progress-Line 100 "完成（仅补装 ffmpeg）"
  Write-Host "[asr-install] ffmpeg 就绪：$ffmpegExe"
  exit 0
}

# ---------------------------------------------------------------- 1. 探测 Python
function Find-Python {
  # 优先 py -3（Windows 官方启动器），再 python；都找不到就报明确错误
  if (Get-Command py -ErrorAction SilentlyContinue) {
    foreach ($ver in @("3.12", "3.11", "3.10", "3.13", "3")) {
      try {
        & py "-$ver" -c "import sys; print(sys.version_info[:2])" 2>$null | Out-Null
        if ($LASTEXITCODE -eq 0) { return @{ exe = "py"; args = @("-$ver") } }
      } catch {}
    }
  }
  if (Get-Command python -ErrorAction SilentlyContinue) {
    try {
      & python -c "import sys; print(sys.version_info[:2])" 2>$null | Out-Null
      if ($LASTEXITCODE -eq 0) { return @{ exe = "python"; args = @() } }
    } catch {}
  }
  return $null
}

Write-Progress-Line 5 "探测 Python..."
$pyInfo = Find-Python
if ($null -eq $pyInfo) {
  Write-Host "[asr-install] 错误：未找到可用的 Python 3。请先安装 Python 3.10+（python.org 或 Microsoft Store），"
  Write-Host "[asr-install]       并确保 'py -3' 或 'python' 能在命令行里跑起来，然后重跑本脚本。"
  throw "python_not_found"
}
Write-Host "[asr-install] 使用 Python：$($pyInfo.exe) $($pyInfo.args -join ' ')"

# ---------------------------------------------------------------- 2. venv
Write-Progress-Line 10 "创建 venv（已存在则跳过）..."
$venvPy = Join-Path $InstallDir ".venv\Scripts\python.exe"
if (-not (Test-Path $venvPy)) {
  if ($pyInfo.exe -eq "py") {
    & py @($pyInfo.args) -m venv .venv
  } else {
    & python -m venv .venv
  }
}
if (-not (Test-Path $venvPy)) { throw "venv_creation_failed" }

Write-Progress-Line 14 "升级 pip..."
& $venvPy -m pip install --upgrade pip -i $PipIndex --trusted-host $PipHost | Out-Host
if ($LASTEXITCODE -ne 0) {
  Write-Host "[asr-install] 清华镜像升级 pip 失败，回退阿里云镜像..."
  & $venvPy -m pip install --upgrade pip -i $PipIndexFallback | Out-Host
}

# ---------------------------------------------------------------- 3. 依赖
$ReqFile = Join-Path $InstallDir "requirements.txt"
if (-not (Test-Path $ReqFile)) { $ReqFile = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path | Split-Path -Parent) "requirements.txt" }
Write-Progress-Line 18 "安装 Python 依赖（requirements.txt，清华镜像）..."
& $venvPy -m pip install -r $ReqFile -i $PipIndex --trusted-host $PipHost | Out-Host
if ($LASTEXITCODE -ne 0) {
  Write-Host "[asr-install] 清华镜像安装依赖失败，回退阿里云镜像重试..."
  & $venvPy -m pip install -r $ReqFile -i $PipIndexFallback | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "requirements_install_failed" }
}

# ---------------------------------------------------------------- 4. torch（CUDA 优先）
# 读取本机 NVIDIA 驱动版本，映射到 PyTorch 的 CUDA 构建档位；没有 nvidia-smi
# 或读不到驱动版本时按 cu128 起步（覆盖面最广），再逐档降级。
function Get-NvidiaDriverMajor {
  $smi = Get-Command nvidia-smi -ErrorAction SilentlyContinue
  if (-not $smi) { return 0 }
  try {
    $line = (& nvidia-smi --query-gpu=driver_version --format=csv,noheader 2>$null | Select-Object -First 1)
    if (-not $line) { return 0 }
    return [int](($line -split '\.')[0])
  } catch { return 0 }
}

$driverMajor = Get-NvidiaDriverMajor
if ($driverMajor -gt 0) {
  Write-Host "[asr-install] 检测到 NVIDIA 驱动主版本：$driverMajor"
} else {
  Write-Host "[asr-install] 未检测到 nvidia-smi / NVIDIA 驱动（若是无 N 卡机器，上层应拦下安装；-Cpu 可显式装 CPU 版）"
}

if ($TorchIndex) {
  $torchIndexes = @($TorchIndex)
} elseif ($Cpu) {
  $torchIndexes = @("https://download.pytorch.org/whl/cpu")
} elseif ($driverMajor -ge 580) {
  $torchIndexes = @("https://download.pytorch.org/whl/cu130", "https://download.pytorch.org/whl/cu128", "https://download.pytorch.org/whl/cu126")
} elseif ($driverMajor -ge 550) {
  $torchIndexes = @("https://download.pytorch.org/whl/cu128", "https://download.pytorch.org/whl/cu126")
} elseif ($driverMajor -ge 1) {
  $torchIndexes = @("https://download.pytorch.org/whl/cu126", "https://download.pytorch.org/whl/cu128")
} else {
  $torchIndexes = @("https://download.pytorch.org/whl/cu128", "https://download.pytorch.org/whl/cu126")
}

Write-Progress-Line 28 "安装 torch（torch + torchaudio）..."
$torchOk = $false
foreach ($idx in $torchIndexes) {
  Write-Host "[asr-install] torch index-url: $idx"
  & $venvPy -m pip install torch torchaudio --index-url $idx | Out-Host
  if ($LASTEXITCODE -eq 0) { $torchOk = $true; break }
  Write-Host "[asr-install] 该档位失败，降一档重试..."
}
if (-not $torchOk -and -not $Cpu -and -not $TorchIndex) {
  Write-Host "[asr-install] 所有 CUDA 档位都失败 —— 作为最后兜底改装 CPU 版（上层仍会按无 CUDA 处理）..."
  & $venvPy -m pip install torch torchaudio --index-url https://download.pytorch.org/whl/cpu | Out-Host
  if ($LASTEXITCODE -eq 0) { $torchOk = $true }
}
if (-not $torchOk) { throw "torch_install_failed" }

# ---------------------------------------------------------------- 5. 便携 ffmpeg
Write-Progress-Line 50 "准备便携 ffmpeg（<InstallDir>\ffmpeg\bin\ffmpeg.exe）..."
$ffmpegOk = Install-PortableFfmpeg
Write-FfmpegMarker $ffmpegOk
$env:ASR_FFMPEG = $ffmpegExe

# ---------------------------------------------------------------- 6. 模型
$ModelsDir = Join-Path $InstallDir "models"
New-Item -ItemType Directory -Force -Path $ModelsDir | Out-Null
$AsrModelId = "Qwen/Qwen3-ASR-0.6B"
$VadModelId = "iic/speech_fsmn_vad_zh-cn-16k-common-pytorch"
$AsrModelDir = Join-Path $ModelsDir "Qwen__Qwen3-ASR-0.6B"
$VadModelDir = Join-Path $ModelsDir "iic__speech_fsmn_vad_zh-cn-16k-common-pytorch"

if ($SkipModels) {
  Write-Progress-Line 80 "按 -SkipModels 跳过模型下载"
} elseif ($ModelDir -and (Test-Path $ModelDir)) {
  Write-Progress-Line 62 "使用已有模型目录：$ModelDir"
  if (-not (Test-Path (Join-Path $ModelDir "config.json"))) {
    Write-Host "[asr-install] 提示：$ModelDir 下没有 config.json，请确认它就是 Qwen3-ASR-0.6B 的模型目录"
  }
  # Junction（目录联接）不复制 1.88GB 权重；失败就退回复制
  if (-not (Test-Path $AsrModelDir)) {
    try {
      New-Item -ItemType Junction -Path $AsrModelDir -Target $ModelDir -ErrorAction Stop | Out-Null
      Write-Host "[asr-install] 已建立目录联接：$AsrModelDir -> $ModelDir"
    } catch {
      Write-Host "[asr-install] 目录联接失败，改为复制：$($_.Exception.Message)"
      Copy-Item -Recurse -Force $ModelDir $AsrModelDir
    }
  }
} else {
  Write-Progress-Line 62 "下载模型（ModelScope 优先，失败回退 hf-mirror）..."
  $pyDownload = @'
import os, sys, traceback
from pathlib import Path

targets = [
    ("Qwen/Qwen3-ASR-0.6B", sys.argv[1]),
    ("iic/speech_fsmn_vad_zh-cn-16k-common-pytorch", sys.argv[2]),
]

def ok(d):
    p = Path(d)
    return p.is_dir() and (p / "config.json").is_file()

failed = []
for repo, dest in targets:
    if ok(dest):
        print(f"[asr-install] 已存在，跳过 {repo}")
        continue
    done = False
    try:
        from modelscope import snapshot_download
        print(f"[asr-install] ModelScope 下载 {repo} -> {dest}")
        snapshot_download(repo, local_dir=dest)
        done = ok(dest)
    except Exception as e:
        print(f"[asr-install] ModelScope 失败：{str(e)[:200]}")
    if not done:
        try:
            os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
            os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
            from huggingface_hub import snapshot_download as hf_snapshot
            print(f"[asr-install] hf-mirror 下载 {repo} -> {dest}")
            hf_snapshot(repo_id=repo, local_dir=dest)
            done = ok(dest)
        except Exception as e:
            print(f"[asr-install] hf-mirror 失败：{str(e)[:200]}")
    if not done:
        failed.append(repo)

if failed:
    print("[asr-install] 以下模型未能下载：" + ", ".join(failed))
    sys.exit(3)
print("[asr-install] 模型下载完成")
'@
  $dlScript = Join-Path $env:TEMP ("mtnode-asr-dl-" + [guid]::NewGuid().ToString("N") + ".py")
  Set-Content -Path $dlScript -Value $pyDownload -Encoding UTF8
  try {
    & $venvPy $dlScript $AsrModelDir $VadModelDir | Out-Host
    if ($LASTEXITCODE -ne 0) {
      Write-Host "[asr-install] 警告：模型下载不完整（服务仍可启动，但转写会报 model_load_failed；重跑本脚本可续传）"
    }
  } finally {
    Remove-Item -Force $dlScript -ErrorAction SilentlyContinue
  }
}

# 模型 / 安装标记：模型齐全才写 models\.ok，安装成功才写 .install-ok
if ((Test-Path (Join-Path $AsrModelDir "config.json")) -and (Test-Path (Join-Path $VadModelDir "configuration.json"))) {
  New-Item -ItemType File -Force -Path (Join-Path $ModelsDir ".ok") | Out-Null
  Write-Host "[asr-install] 模型就位：Qwen3-ASR-0.6B + fsmn-vad"
} else {
  Write-Host "[asr-install] 提示：模型未齐全（<InstallDir>\models\.ok 未创建）；可用 -ModelDir 指定已有模型目录后重跑"
}

# ---------------------------------------------------------------- 7. mock 冒烟
Write-Progress-Line 85 "mock 冒烟（MTNODE_ASR_MOCK=1：起服务 → 请求 /health 与一次 mock 转写 → 关闭）..."
$smoke = Join-Path $env:TEMP ("mtnode-asr-smoke-" + [guid]::NewGuid().ToString("N") + ".py")
$smokePy = @'
import json, os, subprocess, sys, tempfile, time, urllib.request, uuid, wave
from pathlib import Path

install_dir = Path(sys.argv[1])
port = int(sys.argv[2])
log_path = Path(tempfile.gettempdir()) / f"mtnode-asr-smoke-{uuid.uuid4().hex}.log"

# 造一个 1 秒的静音 wav 作为 mock 转写输入
wav = Path(tempfile.gettempdir()) / f"mtnode-asr-smoke-{uuid.uuid4().hex}.wav"
with wave.open(str(wav), "wb") as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000)
    w.writeframes(b"\x00\x00" * 16000)

env = dict(os.environ)
env["MTNODE_ASR_MOCK"] = "1"
env["ASR_PORT"] = str(port)
env["PYTHONIOENCODING"] = "utf-8"
proc = subprocess.Popen([sys.executable, "-m", "app", str(port)], cwd=str(install_dir), env=env,
                        stdout=open(log_path, "w", encoding="utf-8", errors="replace"),
                        stderr=subprocess.STDOUT)
code = 0
try:
    base = f"http://127.0.0.1:{port}"
    health = None
    for _ in range(80):
        if proc.poll() is not None:
            break
        try:
            with urllib.request.urlopen(base + "/health", timeout=2) as r:
                health = json.loads(r.read().decode("utf-8"))
            break
        except Exception:
            time.sleep(0.5)
    if not health:
        print("[asr-install] 冒烟失败：/health 无响应")
        code = 4
    else:
        print("[asr-install] /health -> " + json.dumps(health, ensure_ascii=False))
        if health.get("mock") is not True or health.get("model") != "Qwen/Qwen3-ASR-0.6B":
            print("[asr-install] 冒烟失败：/health 字段不符合契约")
            code = 5
        body = {"audio_path": str(wav), "hotwords": ["冒烟", "测试"], "language": "auto"}
        req = urllib.request.Request(base + "/v1/audio/transcriptions",
                                     data=json.dumps(body).encode("utf-8"),
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=60) as r:
            tr = json.loads(r.read().decode("utf-8"))
        print("[asr-install] mock 转写 -> " + json.dumps(tr, ensure_ascii=False))
        if tr.get("mock") is not True or not tr.get("text"):
            print("[asr-install] 冒烟失败：mock 转写响应不符合契约")
            code = 6
        with urllib.request.urlopen(base + "/v1/models", timeout=10) as r:
            models = json.loads(r.read().decode("utf-8"))
        if not any(m.get("id") == "Qwen/Qwen3-ASR-0.6B" for m in models.get("data", [])):
            print("[asr-install] 冒烟失败：/v1/models 未包含 Qwen/Qwen3-ASR-0.6B")
            code = 7
        try:
            urllib.request.urlopen(urllib.request.Request(base + "/api/shutdown", data=b"{}",
                                                          headers={"Content-Type": "application/json"}), timeout=10).read()
        except Exception:
            pass
finally:
    for _ in range(20):
        if proc.poll() is not None:
            break
        time.sleep(0.25)
    if proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except Exception:
            proc.kill()
    try:
        if log_path.is_file():
            tail = log_path.read_text(encoding="utf-8", errors="replace").strip().splitlines()[-20:]
            for line in tail:
                print("[asr-install] log | " + line)
            log_path.unlink()
    except Exception:
        pass
    try:
        wav.unlink()
    except Exception:
        pass

if code == 0:
    print("[asr-install] mock 冒烟通过（[asr] ready 见上面日志尾部）")
else:
    print("[asr-install] mock 冒烟未通过，退出码 " + str(code))
sys.exit(code)
'@
Set-Content -Path $smoke -Value $smokePy -Encoding UTF8
$smokePort = 8772
if ($env:ASR_PORT) { $smokePort = [int]$env:ASR_PORT }
try {
  & $venvPy $smoke $InstallDir $smokePort | Out-Host
  if ($LASTEXITCODE -ne 0) { Write-Host "[asr-install] 警告：mock 冒烟未通过（见上面日志），安装标记仍会写入" }
} finally {
  Remove-Item -Force $smoke -ErrorAction SilentlyContinue
}

if (-not $ffmpegOk) {
  Write-Host "[asr-install] 错误：便携 ffmpeg 未能就位 —— 不加 .install-ok（缺 ffmpeg 无法解码任何音频）。"
  Write-Host "[asr-install]       检查网络后重跑本脚本，或在插件控制台点「补装 ffmpeg」（-FfmpegOnly）。"
  Set-Content -Path (Join-Path $InstallDir ".asr-agent-result") -Value "ok=false`nreason=ffmpeg_failed" -Encoding UTF8
  exit 1
}

Write-Progress-Line 96 "写入安装标记..."
New-Item -ItemType File -Force -Path (Join-Path $InstallDir ".install-ok") | Out-Null

Write-Progress-Line 100 "完成"
Write-Host "[asr-install] 完成："
Write-Host "[asr-install]   venv        : $venvPy"
Write-Host "[asr-install]   ffmpeg      : $ffmpegExe"
Write-Host "[asr-install]   models      : $ModelsDir"
Write-Host "[asr-install]   install flag: $(Join-Path $InstallDir '.install-ok')"
Write-Host "[asr-install]   启动方式（由 MTNode 负责，请勿常驻）：.venv\Scripts\python.exe -m app 8772"
exit 0
