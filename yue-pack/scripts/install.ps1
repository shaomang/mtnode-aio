# =============================================================================
# YuE2 本地音乐生成后端 —— 安装 / 修复脚本（PowerShell，可重复执行 · 幂等）
#
# 做什么：
#   1. 探测 NVIDIA（nvidia-smi / 驱动主版本 / 显卡名 / 显存）；无 N 卡直接
#      ok=false reason=no_cuda 拦下安装（-Cpu 是显式后门，但官方要求 24G 显卡）
#   2. 探测 Python，建 **3.12** venv（拿不到 3.12 时退 3.11/3.13/3.10 并告警）
#   3. pip 装 requirements.txt（显式含 gradio，清华镜像，失败回退阿里云；--isolated），装完自检 gradio
#   4. 装 **CUDA 版 torch / torchaudio**：按驱动主版本选 cu130 / cu128 / cu126，
#      失败逐档降级；-Cpu 或全部 CUDA 档位失败才装 CPU 版
#   4b. 跑 scripts\probe_attention.py 探「注意力档位」，结果写 <InstallDir>\.attention-backend
#      （Windows 的 torch 常有 flash-attn 的 schema 却没有对应 kernel，必须靠探针把档位
#       降级到 cudnn / sdpa）；一个可用档都没有 → ok=false reason=attention_backend_unsupported
#       并给出「装 cudnn 可用 torch / 换卡」建议
#   5. 装 yue2 推理包：从 m-a-p/YuE2-3B 取官方 yue2_infer-0.1.5-py3-none-any.whl
#      （hf_hub_download → hf-mirror 直链），失败回退官方仓库 git+https://github.com/
#      multimodal-art-projection/YuE.git（直连 → ghproxy 镜像）
#   6. 下载 m-a-p/YuE2-3B（约 7.3GB）与 m-a-p/YuE2-Vae（约 0.5GB）到
#      <InstallDir>\models\（HF 直连失败回退 HF_ENDPOINT=https://hf-mirror.com）
#   7. 核对工程文件清单（含 app\windows_patch.py —— 与 app\engine.py 必须同时存在，
#      否则每轮 sync 会把 Windows 注意力补丁覆盖掉）并检查 ui.py 入口可导入
#      （python -c "import app.ui"）：允许因缺模型延后，但不允许 ModuleNotFoundError
#   8. 建 models\.ok 与 .install-ok，用 venv python 跑一次 MTNODE_YUE2_MOCK=1 冒烟
#      （起服务 → /health → /generate 造出 audio.flac + score.abc → /progress → /shutdown）
#
# 进度输出：[yue2-install] progress: NN（0-100，便于上层解析）
# 注意：本脚本**不会**把服务留在后台常驻（冒烟结束即关闭），启停由 MTNode 负责。
# 可重复执行（幂等）：装到一半失败重跑即可续传；参数见下。
# =============================================================================
param(
  [string]$InstallDir = (Split-Path -Parent $MyInvocation.MyCommand.Path | Split-Path -Parent),
  [switch]$Cpu,              # 装 CPU 版 torch（无 N 卡机器的显式后门；官方要求 24G 显卡）
  [string]$TorchIndex = "",  # 显式指定 torch index-url（默认按驱动自动匹配）
  [string]$ModelDir = "",    # 已有 YuE2-3B 模型目录（离线安装 / 复用）→ 联接进 <InstallDir>\models
  [string]$VaeDir = "",      # 已有 YuE2-Vae 模型目录（同上）
  [string]$WhlPath = "",     # 已有 yue2_infer-*.whl（离线安装 / 复用）
  [switch]$SkipModels,       # 跳过模型下载（模型已就位、只想修 venv / 推理包时用）
  [switch]$SkipInfer         # 跳过 yue2 推理包安装（venv / 依赖 / torch / 模型 / 冒烟照跑）
)

$ErrorActionPreference = "Stop"
$InferWhlName = "yue2_infer-0.1.5-py3-none-any.whl"
$ModelRepo = "m-a-p/YuE2-3B"
$VaeRepo = "m-a-p/YuE2-Vae"

function Write-Progress-Line([int]$Pct, [string]$Msg) {
  Write-Host "[yue2-install] progress: $Pct"
  if ($Msg) { Write-Host "[yue2-install] $Msg" }
}

function Write-AgentResult([string]$Ok, [string]$Reason) {
  $body = "ok=$Ok"
  if ($Reason) { $body = "$body`nreason=$Reason" }
  Set-Content -Path (Join-Path $InstallDir ".yue2-agent-result") -Value $body -Encoding UTF8
}

Write-Host "[yue2-install] ============================================================"
Write-Host "[yue2-install] YuE2 本地音乐生成后端安装"
Write-Host "[yue2-install]   模型：m-a-p/YuE2-3B（约 7.3GB，CC BY-NC 4.0）+ m-a-p/YuE2-Vae（约 0.5GB）"
Write-Host "[yue2-install]   推理包：yue2_infer-0.1.5-py3-none-any.whl（来自 YuE2-3B 仓库）"
Write-Host "[yue2-install]   Python 库：清华镜像 pypi.tuna.tsinghua.edu.cn"
Write-Host "[yue2-install]   torch：CUDA 版走 download.pytorch.org 官方 index（按驱动 cu13x / cu12x，失败降档）"
Write-Host "[yue2-install]   模型下载：HF 直连失败回退 HF_ENDPOINT=https://hf-mirror.com"
Write-Host "[yue2-install]   官方要求：Linux 参考环境 · Python 3.10+ · 24GB NVIDIA GPU（本机 Windows 需 24G 级显卡）"
Write-Host "[yue2-install] ============================================================"
Write-Host "[yue2-install] install dir: $InstallDir"
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

try {
  [Net.ServicePointManager]::SecurityProtocol =
    [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch {
  Write-Host "[yue2-install] 提示：无法显式设置 TLS1.2（$($_.Exception.Message)），继续尝试下载"
}

# ---------------------------------------------------------------- 1. 探测 NVIDIA
function Get-NvidiaInfo {
  $smi = Get-Command nvidia-smi -ErrorAction SilentlyContinue
  if (-not $smi) { return $null }
  try {
    $line = (& nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader 2>$null | Select-Object -First 1)
    if (-not $line) { return $null }
    $parts = $line -split ','
    if ($parts.Count -lt 3) { return $null }
    $mem = 0
    try { $mem = [int](($parts[2] -replace '[^0-9]', '')) } catch { $mem = 0 }
    $major = 0
    try { $major = [int](($parts[1].Trim() -split '\.')[0]) } catch { $major = 0 }
    return @{ name = $parts[0].Trim(); driver = $parts[1].Trim(); major = $major; memMb = $mem }
  } catch {
    return $null
  }
}

Write-Progress-Line 4 "探测 NVIDIA 显卡与驱动..."
$gpu = Get-NvidiaInfo
if ($null -eq $gpu) {
  if (-not $Cpu) {
    Write-Host "[yue2-install] 错误：未检测到 NVIDIA 显卡 / nvidia-smi —— YuE2 官方要求 24GB NVIDIA GPU 且 BF16，"
    Write-Host "[yue2-install]       无 N 卡安装必然跑不起来。确实要装 CPU 版（仅供调试，一首歌可能几小时）加 -Cpu。"
    Write-AgentResult "false" "no_cuda"
    exit 1
  }
  Write-Host "[yue2-install] 警告：-Cpu 已指定，将装 CPU 版 torch（YuE2 在 CPU 上极慢，仅供调试）"
} else {
  Write-Host "[yue2-install] GPU：$($gpu.name) · 驱动 $($gpu.driver)（主版本 $($gpu.major)）· 显存 $($gpu.memMb)MB"
  if ($gpu.memMb -gt 0 -and $gpu.memMb -lt 20000) {
    Write-Host "[yue2-install] 警告：显存 $($gpu.memMb)MB < 20000MB —— 官方未量化需要 24G（11~14GiB 峰值，需留余量），"
    Write-Host "[yue2-install]       小显存可能 OOM；继续安装，但生成可能失败。"
  }
}

# ---------------------------------------------------------------- 2. 探测 Python + venv
function Find-Python {
  # 优先 py 启动器的 3.12（任务口径），再退其它 3.1x / 3
  if (Get-Command py -ErrorAction SilentlyContinue) {
    foreach ($ver in @("3.12", "3.13", "3.11", "3.10", "3")) {
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

Write-Progress-Line 8 "探测 Python..."
$pyInfo = Find-Python
if ($null -eq $pyInfo) {
  Write-Host "[yue2-install] 错误：未找到可用的 Python 3。请先安装 Python 3.12（python.org 或 Microsoft Store），"
  Write-Host "[yue2-install]       并确保 'py -3.12' 或 'python' 能在命令行里跑起来，然后重跑本脚本。"
  Write-AgentResult "false" "python_not_found"
  throw "python_not_found"
}
Write-Host "[yue2-install] 使用 Python：$($pyInfo.exe) $($pyInfo.args -join ' ')"
if (($pyInfo.args -join ' ') -notmatch "3\.12") {
  Write-Host "[yue2-install] 提示：没拿到 Python 3.12（用 $($pyInfo.args -join ' ')）；YuE2 要求 3.10+，能跑但优先装 3.12。"
}

Write-Progress-Line 12 "创建 venv（.venv，已存在则跳过）..."
$venvPy = Join-Path $InstallDir ".venv\Scripts\python.exe"
if (-not (Test-Path $venvPy)) {
  if ($pyInfo.exe -eq "py") {
    & py @($pyInfo.args) -m venv .venv
  } else {
    & python -m venv .venv
  }
}
if (-not (Test-Path $venvPy)) {
  Write-AgentResult "false" "venv_creation_failed"
  throw "venv_creation_failed"
}

Write-Progress-Line 16 "升级 pip..."
& $venvPy -m pip install --upgrade pip -i $PipIndex --trusted-host $PipHost | Out-Host
if ($LASTEXITCODE -ne 0) {
  Write-Host "[yue2-install] 清华镜像升级 pip 失败，回退阿里云镜像..."
  & $venvPy -m pip install --upgrade pip -i $PipIndexFallback | Out-Host
}

# ---------------------------------------------------------------- 3. 依赖
$ReqFile = Join-Path $InstallDir "requirements.txt"
if (-not (Test-Path $ReqFile)) {
  $ReqFile = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path | Split-Path -Parent) "requirements.txt"
}
Write-Progress-Line 20 "安装 Python 依赖（requirements.txt + gradio，清华镜像）..."
& $venvPy -m pip install --isolated -r $ReqFile gradio -i $PipIndex --trusted-host $PipHost | Out-Host
if ($LASTEXITCODE -ne 0) {
  Write-Host "[yue2-install] 清华镜像安装依赖失败，回退阿里云镜像重试..."
  & $venvPy -m pip install --isolated -r $ReqFile gradio -i $PipIndexFallback | Out-Host
  if ($LASTEXITCODE -ne 0) {
    Write-AgentResult "false" "requirements_install_failed"
    throw "requirements_install_failed"
  }
}

# gradio 自检：app/ui.py 依赖它，缺了会「启动即 RuntimeError: Gradio 未安装」
& $venvPy -c "import gradio; print('gradio', gradio.__version__)" | Out-Host
if ($LASTEXITCODE -ne 0) {
  Write-Host "[yue2-install] 错误：gradio 未装好（缺 gradio 时服务启动即 RuntimeError「Gradio 未安装」）。"
  Write-Host "[yue2-install]       单独重装 gradio：& `"$venvPy`" -m pip install --isolated gradio -i $PipIndex --trusted-host $PipHost"
  Write-Host "[yue2-install]       重装 gradio 后重跑本脚本即可，**不要重下模型权重**。"
  Write-AgentResult "false" "requirements_install_failed"
  throw "requirements_install_failed"
}

# ---------------------------------------------------------------- 4. torch（CUDA 优先）
$driverMajor = if ($gpu) { $gpu.major } else { 0 }
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

Write-Progress-Line 30 "安装 torch / torchaudio（CUDA 版）..."
$torchOk = $false
foreach ($idx in $torchIndexes) {
  Write-Host "[yue2-install] torch index-url: $idx"
  & $venvPy -m pip install torch torchaudio --index-url $idx | Out-Host
  if ($LASTEXITCODE -eq 0) { $torchOk = $true; break }
  Write-Host "[yue2-install] 该档位失败，降一档重试..."
}
if (-not $torchOk -and -not $Cpu -and -not $TorchIndex) {
  Write-Host "[yue2-install] 所有 CUDA 档位都失败 —— 作为最后兜底改装 CPU 版（上层仍会按无 CUDA 处理）..."
  & $venvPy -m pip install torch torchaudio --index-url https://download.pytorch.org/whl/cpu | Out-Host
  if ($LASTEXITCODE -eq 0) { $torchOk = $true }
}
if (-not $torchOk) {
  Write-AgentResult "false" "torch_install_failed"
  throw "torch_install_failed"
}

# ------------------------------------------- 4b. 注意力档位探针（Windows 必需）
# 为什么必须探：Windows 上的 torch 常常「有 flash-attn 的 schema、没有对应 kernel」，
# yue2 默认 auto 会选到 flash，真实生成跑到 Planning score 阶段才报
#   USE_FLASH_ATTENTION was not enabled for build.
# 所以 torch 装好后立刻用探针选一个真正可用的档位（cudnn / sdpa），并把结果落盘，
# 由 app\windows_patch.py 在服务启动时读取并强制下发。
$AttentionBackendFile = Join-Path $InstallDir ".attention-backend"
$ProbeScript = Join-Path $InstallDir "scripts\probe_attention.py"
Write-Progress-Line 38 "探测注意力档位（flash / cudnn / sdpa）..."
$attentionBackend = ""
$probeNote = ""
if (-not (Test-Path $ProbeScript)) {
  $probeNote = "缺 scripts\probe_attention.py"
  Write-Host "[yue2-install] 警告：缺 scripts\probe_attention.py —— 无法探测注意力档位（从脚手架补齐该文件后重跑本脚本）。"
  Write-Host "[yue2-install]       没探针时 yue2 auto 可能选到 flash，真实生成会在 Planning score 阶段报"
  Write-Host "[yue2-install]       「USE_FLASH_ATTENTION was not enabled for build.」"
} else {
  $probeLog = Join-Path $env:TEMP ("mtnode-yue2-attn-" + [guid]::NewGuid().ToString("N") + ".log")
  $probeCode = 0
  $prevEap = $ErrorActionPreference
  try {
    # 探针的 stderr 只是诊断输出，别让它触发 Stop（本脚本顶层是 ErrorActionPreference=Stop）
    $ErrorActionPreference = "Continue"
    & $venvPy $ProbeScript 2>&1 | Tee-Object -FilePath $probeLog | Out-Host
    $probeCode = $LASTEXITCODE
  } catch {
    Write-Host "[yue2-install] 注意力探针执行异常：$($_.Exception.Message)"
    $probeCode = 1
  } finally {
    $ErrorActionPreference = $prevEap
  }
  # 档位来源①：探针自己写的 <INSTALL_DIR>\.attention-backend
  if (Test-Path $AttentionBackendFile) {
    $raw = Get-Content $AttentionBackendFile -ErrorAction SilentlyContinue | Where-Object { $_.Trim() } | Select-Object -First 1
    if ($raw) { $attentionBackend = ([string]$raw).Trim() }
  }
  # 档位来源②：从探针输出里解析 backend=<档位> / backend: <档位>
  if (-not $attentionBackend -and (Test-Path $probeLog)) {
    $hit = Select-String -Path $probeLog -Pattern 'backend\s*[:=]\s*([A-Za-z0-9_]+)' -AllMatches | Select-Object -First 1
    if ($hit -and $hit.Matches.Count -gt 0) { $attentionBackend = $hit.Matches[0].Groups[1].Value.Trim() }
  }
  Remove-Item -Force $probeLog -ErrorAction SilentlyContinue

  $noBackend = (-not $attentionBackend) -or (@("unsupported", "none", "null", "false") -contains $attentionBackend.ToLower())
  if ($noBackend) {
    Write-Host "[yue2-install] 错误：没有任何可用的注意力档位（flash / cudnn / sdpa 都不可用，探针退出码 $probeCode）。"
    Write-Host "[yue2-install]       处置①（推荐）：装一个带 cuDNN 的 CUDA 版 torch —— 例如"
    Write-Host "[yue2-install]         .\.venv\Scripts\python.exe -m pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu128"
    Write-Host "[yue2-install]         或用本脚本参数 -TorchIndex <对应 cu1xx 档位> 重装，装完重跑本脚本让探针重选档位；"
    Write-Host "[yue2-install]       处置②：换卡 —— 官方要求支持 flash / cuDNN 注意力的 24G 级 NVIDIA GPU"
    Write-Host "[yue2-install]         （老架构卡、核显、CPU 版 torch 都拿不到可用档位）。"
    Write-Host "[yue2-install]       不要装 flash-attn（Windows 无轮子），也不要为此重下模型权重。"
    Write-AgentResult "false" "attention_backend_unsupported"
    exit 1
  }
  Write-Host "[yue2-install] 注意力探针选定档位：$attentionBackend"
}

# 落盘（探针已写则同一份内容重写一遍保证口径统一）；写不进只打日志，不拦安装
if ($attentionBackend) {
  try {
    Set-Content -Path $AttentionBackendFile -Value $attentionBackend -Encoding UTF8
    Write-Host "[yue2-install] 注意力档位已写入：$AttentionBackendFile（$attentionBackend）"
  } catch {
    Write-Host "[yue2-install] 警告：注意力档位写入失败（$($_.Exception.Message)）；本次安装仍按 $attentionBackend 继续，"
    Write-Host "[yue2-install]       但 .attention-backend 缺失时 app\windows_patch.py 只能靠运行时再探一次，请修好写权限后重跑本脚本。"
  }
} elseif ($probeNote) {
  Write-Host "[yue2-install] 提示：未写 .attention-backend（$probeNote）—— 补齐 scripts\probe_attention.py 后重跑本脚本即可补上。"
}

# ---------------------------------------------------------------- 5. yue2 推理包（官方 whl → 官方仓库）
$WhlLocal = Join-Path $InstallDir $InferWhlName
if ($SkipInfer) {
  Write-Progress-Line 50 "按 -SkipInfer 跳过 yue2 推理包安装"
} else {
  Write-Progress-Line 42 "安装 yue2 推理包（$InferWhlName / 官方仓库回退）..."
  if ($WhlPath -and (Test-Path $WhlPath)) {
    Copy-Item -Force $WhlPath $WhlLocal
    Write-Host "[yue2-install] 使用已有 whl：$WhlPath"
  } elseif (-not (Test-Path $WhlLocal)) {
    $pyWhl = @'
import os, sys
from pathlib import Path

repo, name, dest = sys.argv[1], sys.argv[2], sys.argv[3]
os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
try:
    from huggingface_hub import hf_hub_download
    p = hf_hub_download(repo_id=repo, filename=name, local_dir=dest)
    out = Path(dest) / name
    if Path(p) != out:
        out.write_bytes(Path(p).read_bytes())
    print(f"[yue2-install] hf_hub_download 完成：{out}")
    sys.exit(0)
except Exception as e:
    print(f"[yue2-install] hf_hub_download 失败：{str(e)[:300]}")
sys.exit(3)
'@
    $whlScript = Join-Path $env:TEMP ("mtnode-yue2-whl-" + [guid]::NewGuid().ToString("N") + ".py")
    Set-Content -Path $whlScript -Value $pyWhl -Encoding UTF8
    try {
      & $venvPy $whlScript $ModelRepo $InferWhlName $InstallDir | Out-Host
    } finally {
      Remove-Item -Force $whlScript -ErrorAction SilentlyContinue
    }
    if (-not (Test-Path $WhlLocal)) {
      # 直链兜底：hf-mirror / HF 官方 resolve 路径
      foreach ($url in @(
        "$env:HF_ENDPOINT/$ModelRepo/resolve/main/$InferWhlName",
        "https://huggingface.co/$ModelRepo/resolve/main/$InferWhlName"
      )) {
        if (Test-Path $WhlLocal) { break }
        try {
          Write-Host "[yue2-install] 直链下载 whl：$url"
          $oldProgress = $ProgressPreference
          $ProgressPreference = "SilentlyContinue"
          try {
            Invoke-WebRequest -Uri $url -OutFile $WhlLocal -UseBasicParsing -TimeoutSec 300 `
              -Headers @{ "User-Agent" = "MTNode-YuE2-Installer" }
          } finally {
            $ProgressPreference = $oldProgress
          }
          if ((Test-Path $WhlLocal) -and ((Get-Item $WhlLocal).Length -lt 4096)) {
            Remove-Item -Force $WhlLocal -ErrorAction SilentlyContinue
          }
        } catch {
          Write-Host "[yue2-install] 直链失败：$($_.Exception.Message)"
        }
      }
    }
  } else {
    Write-Host "[yue2-install] 已有 whl，跳过下载：$WhlLocal"
  }

  $inferOk = $false
  if (Test-Path $WhlLocal) {
    & $venvPy -m pip install $WhlLocal | Out-Host
    if ($LASTEXITCODE -eq 0) { $inferOk = $true }
  }
  if (-not $inferOk) {
    Write-Host "[yue2-install] 官方 whl 不可用，回退官方仓库（直连 → ghproxy 镜像）..."
    foreach ($gitUrl in @(
      "git+https://github.com/multimodal-art-projection/YuE.git",
      "git+https://ghproxy.com/https://github.com/multimodal-art-projection/YuE.git",
      "git+https://ghfast.top/https://github.com/multimodal-art-projection/YuE.git"
    )) {
      if ($inferOk) { break }
      Write-Host "[yue2-install] pip install $gitUrl"
      & $venvPy -m pip install $gitUrl | Out-Host
      if ($LASTEXITCODE -eq 0) { $inferOk = $true }
    }
  }
  if (-not $inferOk) {
    Write-Host "[yue2-install] 错误：yue2 推理包未能安装（whl 与官方仓库都失败）。"
    Write-AgentResult "false" "infer_install_failed"
    throw "infer_install_failed"
  }
  & $venvPy -c "import yue2; print('[yue2-install] yue2 包导入成功:', getattr(yue2, '__version__', 'unknown'))" | Out-Host
  if ($LASTEXITCODE -ne 0) {
    Write-Host "[yue2-install] 警告：yue2 包已安装但导入失败（看上面报错；可能是依赖缺失，重跑本脚本会补）"
  }
}

# ---------------------------------------------------------------- 6. 模型
$ModelsDir = Join-Path $InstallDir "models"
New-Item -ItemType Directory -Force -Path $ModelsDir | Out-Null
$ModelDirFlat = Join-Path $ModelsDir "m-a-p__YuE2-3B"
$VaeDirFlat = Join-Path $ModelsDir "m-a-p__YuE2-Vae"

function Link-Or-Copy([string]$Src, [string]$Dest, [string]$Label) {
  if (Test-Path $Dest) {
    $item = Get-Item $Dest -Force
    if ($item.LinkType -or $item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
      Write-Host "[yue2-install] $Label 目录联接已存在，跳过：$Dest"
      return
    }
    Write-Host "[yue2-install] $Label 目录已存在，跳过：$Dest"
    return
  }
  try {
    New-Item -ItemType Junction -Path $Dest -Target $Src -ErrorAction Stop | Out-Null
    Write-Host "[yue2-install] 已建立目录联接：$Dest -> $Src"
  } catch {
    Write-Host "[yue2-install] 目录联接失败，改为复制：$($_.Exception.Message)"
    Copy-Item -Recurse -Force $Src $Dest
  }
}

if ($SkipModels) {
  Write-Progress-Line 80 "按 -SkipModels 跳过模型下载"
} else {
  Write-Progress-Line 58 "准备模型（YuE2-3B + YuE2-Vae）..."
  if ($ModelDir -and (Test-Path $ModelDir)) { Link-Or-Copy $ModelDir $ModelDirFlat "YuE2-3B" }
  if ($VaeDir -and (Test-Path $VaeDir)) { Link-Or-Copy $VaeDir $VaeDirFlat "YuE2-Vae" }

  $needDl = (-not (Test-Path (Join-Path $ModelDirFlat "model.safetensors"))) -or (-not (Test-Path (Join-Path $VaeDirFlat "model.safetensors")))
  if (-not $needDl) {
    Write-Progress-Line 78 "模型已就位，跳过下载"
  } else {
    Write-Progress-Line 62 "下载 m-a-p/YuE2-3B（约 7.3GB）与 m-a-p/YuE2-Vae（约 0.5GB）..."
    $pyDl = @'
import os, sys
from pathlib import Path

targets = [
    (sys.argv[1], sys.argv[2], {"assets/*", "*.md", "*.pdf", "*.svg", "*.png", "*.mp3"}),
    (sys.argv[3], sys.argv[4], {"assets/*", "*.md", "*.pdf", "*.svg", "*.png"}),
]

def ok(d):
    p = Path(d)
    return p.is_dir() and (p / "config.json").is_file() and (p / "model.safetensors").is_file()

failed = []
for repo, dest, ignore in targets:
    if ok(dest):
        print(f"[yue2-install] 已存在，跳过 {repo}")
        continue
    done = False
    attempts = [
        ("HF_HUB", {}),
        ("hf-mirror", {"endpoint": "https://hf-mirror.com"}),
    ]
    for label, cfg in attempts:
        if done:
            break
        endpoint = cfg.get("endpoint")
        if endpoint:
            os.environ["HF_ENDPOINT"] = endpoint
        else:
            os.environ.pop("HF_ENDPOINT", None)
        try:
            from huggingface_hub import snapshot_download
            print(f"[yue2-install] {label} 下载 {repo} -> {dest}")
            snapshot_download(repo_id=repo, local_dir=dest, ignore_patterns=list(ignore))
            done = ok(dest)
        except Exception as e:
            print(f"[yue2-install] {label} 失败：{str(e)[:300]}")
    if not done:
        failed.append(repo)

if failed:
    print("[yue2-install] 以下模型未能下载：" + ", ".join(failed))
    sys.exit(3)
print("[yue2-install] 模型下载完成")
'@
    $dlScript = Join-Path $env:TEMP ("mtnode-yue2-dl-" + [guid]::NewGuid().ToString("N") + ".py")
    Set-Content -Path $dlScript -Value $pyDl -Encoding UTF8
    try {
      & $venvPy $dlScript $ModelRepo $ModelDirFlat $VaeRepo $VaeDirFlat | Out-Host
      if ($LASTEXITCODE -ne 0) {
        Write-Host "[yue2-install] 警告：模型下载不完整（服务仍可启动，但 /generate 会报 model_load_failed；重跑本脚本可续传）"
      }
    } finally {
      Remove-Item -Force $dlScript -ErrorAction SilentlyContinue
    }
  }
}

if ((Test-Path (Join-Path $ModelDirFlat "model.safetensors")) -and (Test-Path (Join-Path $VaeDirFlat "model.safetensors"))) {
  New-Item -ItemType File -Force -Path (Join-Path $ModelsDir ".ok") | Out-Null
  Write-Host "[yue2-install] 模型就位：YuE2-3B + YuE2-Vae"
} else {
  Write-Host "[yue2-install] 提示：模型未齐全（models\.ok 未创建）；可用 -ModelDir / -VaeDir 指定已有目录后重跑"
}

# ---------------------------------------------------------------- 6b. 工程文件清单
# Windows 移植补丁 app\windows_patch.py 与 app\engine.py 必须**同时**存在：只缺 windows_patch.py
# 时每轮 sync 会把注意力降级逻辑覆盖掉，真实生成又会回到 flash 档报
# 「USE_FLASH_ATTENTION was not enabled for build.」
Write-Progress-Line 82 "核对工程文件清单..."
$RequiredFiles = @(
  "app\__init__.py",
  "app\__main__.py",
  "app\server.py",
  "app\ui.py",
  "app\engine.py",
  "app\windows_patch.py",
  "scripts\install.ps1",
  "scripts\probe_attention.py",
  "requirements.txt",
  "manifest.json",
  "start_backend.cmd"
)
$MissingFiles = @()
foreach ($rel in $RequiredFiles) {
  if (-not (Test-Path (Join-Path $InstallDir $rel))) { $MissingFiles += $rel }
}
if ($MissingFiles.Count -gt 0) {
  Write-Host "[yue2-install] 警告：工程文件缺失：" + ($MissingFiles -join "、")
  Write-Host "[yue2-install]       从随包脚手架（SCAFFOLD_REF / yue-pack）补齐这两个目录后重跑本脚本；"
  Write-Host "[yue2-install]       特别注意 app\windows_patch.py 与 app\engine.py 要**同时**存在，"
  Write-Host "[yue2-install]       否则每轮 sync 会覆盖掉 Windows 注意力补丁，真实生成会回到 flash 档。"
} else {
  Write-Host "[yue2-install] 工程文件齐全（含 app\windows_patch.py）"
}

# ---------------------------------------------------------------- 7. ui 入口自检
Write-Progress-Line 84 "检查 ui.py 入口可导入（python -c \"import app.ui\"）..."
$uiProbe = @'
import sys
try:
    import app.ui
except ModuleNotFoundError as e:
    print(f"[yue2-install] app.ui 导入失败：ModuleNotFoundError: {e.name}")
    sys.exit(2)
except Exception as e:
    print(f"[yue2-install] app.ui 暂不可导入（非模块缺失，允许延后到运行时）：{type(e).__name__}: {e}")
    sys.exit(0)
print("[yue2-install] app.ui 入口可导入")
sys.exit(0)
'@
$uiProbeFile = Join-Path $env:TEMP ("mtnode-yue2-ui-" + [guid]::NewGuid().ToString("N") + ".py")
Set-Content -Path $uiProbeFile -Value $uiProbe -Encoding UTF8
try {
  & $venvPy $uiProbeFile | Out-Host
  $uiCode = $LASTEXITCODE
} finally {
  Remove-Item -Force $uiProbeFile -ErrorAction SilentlyContinue
}
if ($uiCode -eq 2) {
  Write-Host "[yue2-install] 错误：app\ui.py 入口缺失或依赖没装（ModuleNotFoundError）—— 缺文件从脚手架补齐，"
  Write-Host "[yue2-install]       缺依赖按清华镜像补装（gradio 见上一步自检），然后重跑本脚本。"
  Write-AgentResult "false" "ui_entry_import_failed"
  throw "ui_entry_import_failed"
}

# ---------------------------------------------------------------- 8. mock 冒烟
Write-Progress-Line 88 "mock 冒烟（MTNODE_YUE2_MOCK=1：起服务 → /health → /generate 造产物 → /progress → 关闭）..."
$smoke = Join-Path $env:TEMP ("mtnode-yue2-smoke-" + [guid]::NewGuid().ToString("N") + ".py")
$smokePy = @'
import json, os, subprocess, sys, tempfile, time, urllib.request, uuid
from pathlib import Path

install_dir = Path(sys.argv[1])
port = int(sys.argv[2])
log_path = Path(tempfile.gettempdir()) / f"mtnode-yue2-smoke-{uuid.uuid4().hex}.log"
out_dir = Path(tempfile.gettempdir()) / f"mtnode-yue2-out-{uuid.uuid4().hex}"

env = dict(os.environ)
env["MTNODE_YUE2_MOCK"] = "1"
env["YUE2_PORT"] = str(port)
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
        print("[yue2-install] 冒烟失败：/health 无响应")
        code = 4
    else:
        print("[yue2-install] /health -> " + json.dumps(health, ensure_ascii=False))
        if health.get("mock") is not True or health.get("model") != "m-a-p/YuE2-3B" or health.get("service") != "mtnode-yue2":
            print("[yue2-install] 冒烟失败：/health 字段不符合契约")
            code = 5
        body = {
            "style": "smoke test, lofi hip hop, warm piano",
            "lyrics": "[verse]\n烟雾测试歌词\n[chorus]\nsmoke test chorus",
            "cot": "full",
            "seed": 123456,
            "outputDir": str(out_dir),
        }
        req = urllib.request.Request(base + "/generate", data=json.dumps(body).encode("utf-8"),
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=120) as r:
            gen = json.loads(r.read().decode("utf-8"))
        print("[yue2-install] mock 生成 -> " + json.dumps({k: gen.get(k) for k in
              ("ok", "audioPath", "outputDir", "cot", "seed", "mock", "scoreAbc")}, ensure_ascii=False))
        if gen.get("ok") is not True or gen.get("mock") is not True:
            print("[yue2-install] 冒烟失败：/generate 响应不符合契约")
            code = 6
        elif not gen.get("audioPath") or not Path(gen["audioPath"]).is_file():
            print("[yue2-install] 冒烟失败：audio.flac 未落盘")
            code = 7
        elif not gen.get("scoreAbc") or not Path(gen["scoreAbc"]).is_file():
            print("[yue2-install] 冒烟失败：score.abc 未落盘")
            code = 8
        elif not gen.get("artifacts"):
            print("[yue2-install] 冒烟失败：artifacts 为空")
            code = 9
        with urllib.request.urlopen(base + "/progress", timeout=10) as r:
            prog = json.loads(r.read().decode("utf-8"))
        print("[yue2-install] /progress -> " + json.dumps({k: prog.get(k) for k in
              ("stage", "percent", "running", "done", "seed")}, ensure_ascii=False))
        if prog.get("stage") != "done" or prog.get("done") is not True:
            print("[yue2-install] 冒烟失败：/progress 未回到 done")
            code = 10
        try:
            urllib.request.urlopen(urllib.request.Request(base + "/shutdown", data=b"{}",
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
                print("[yue2-install] log | " + line)
            log_path.unlink()
    except Exception:
        pass
    try:
        import shutil
        shutil.rmtree(out_dir, ignore_errors=True)
    except Exception:
        pass

if code == 0:
    print("[yue2-install] mock 冒烟通过（[yue2] ready 见上面日志尾部）")
else:
    print("[yue2-install] mock 冒烟未通过，退出码 " + str(code))
sys.exit(code)
'@
Set-Content -Path $smoke -Value $smokePy -Encoding UTF8
$smokePort = 8773
if ($env:YUE2_PORT) {
  try { $smokePort = [int]$env:YUE2_PORT } catch { $smokePort = 8773 }
}
try {
  & $venvPy $smoke $InstallDir $smokePort | Out-Host
  if ($LASTEXITCODE -ne 0) { Write-Host "[yue2-install] 警告：mock 冒烟未通过（见上面日志），安装标记仍会写入" }
} finally {
  Remove-Item -Force $smoke -ErrorAction SilentlyContinue
}

# ---------------------------------------------------------------- 9. 标记
Write-Progress-Line 96 "写入安装标记..."
New-Item -ItemType File -Force -Path (Join-Path $InstallDir ".install-ok") | Out-Null
Write-AgentResult "true" ""

Write-Progress-Line 100 "完成"
Write-Host "[yue2-install] 完成："
Write-Host "[yue2-install]   venv        : $venvPy"
Write-Host "[yue2-install]   yue2 whl    : $WhlLocal"
Write-Host "[yue2-install]   models      : $ModelsDir"
Write-Host "[yue2-install]   install flag: $(Join-Path $InstallDir '.install-ok')"
Write-Host "[yue2-install]   启动方式（由 MTNode 负责，请勿常驻）：.venv\Scripts\python.exe -m app 8773"
exit 0
