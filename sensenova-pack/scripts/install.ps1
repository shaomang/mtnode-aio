# =============================================================================
# SenseNova（SenseNova-U1.5-8B-MoT）本地图像生成后端 —— 安装 / 修复脚本
# （PowerShell · 可重复执行 · 幂等 · 全程优先国内镜像）
#
# 做什么（每步都打 `[sensenova-install] progress: NN`，上层据此显示进度条）：
#   1.  探测 NVIDIA：nvidia-smi 显卡名 / 驱动主版本 / 显存；无 N 卡 → ok=false no_cuda；
#       显存 <20GB → ok=false vram_too_low（bf16 权重 32.66GB，官方 vram_mode 也是给 24G 卡
#       准备的，小卡装得上也出不了图；-Force 可强行跳过这道闸）；内存 <32GB → ram_too_low
#   2.  探测磁盘：安装目录所在盘剩余 <50GB 只告警（权重 32.66GB + venv 约 12GB + 产物）
#   3.  选 Python：**优先 uv 托管 3.11**（UV_PYTHON_INSTALL_MIRROR 指到 npmmirror，不翻墙），
#       没有 uv 再退本机 `py -3.11/3.12/3.13/3.10` → `python`
#       （上游 requires-python >=3.10,<3.14，参考环境是 3.11）
#   4.  建 `.venv`（`python -m venv` 优先，缺 pip 用 ensurepip 兜底，再退 `uv venv --seed`）、
#       升级 pip（清华 → 阿里云）
#   5.  装 **CUDA 版 torch 2.8.0 + torchvision 0.23.0**（官方 requirements 钉 cu128）：
#       ① SJTU 镜像（download.pytorch.org 全量镜像，PEP503 索引）
#       ② 阿里云镜像（平铺轮子 → --find-links + 清华 PyPI 装 torch 的传递依赖）
#       ③ 官方 download.pytorch.org 兜底；按驱动主版本决定 cu128 / cu126，
#       `-TorchIndex` 可整体覆盖，`-TorchWheel` 支持完全离线；装完自检 cuda.is_available()
#       （**不能只写 requirements.txt 装 torch**：PyPI / 清华上的 Windows 轮子是 CPU 版）
#   6.  装 requirements.txt（transformers≥4.57.1 / accelerate / modelscope / pillow / numpy 等）
#       并校验 transformers 版本够认 `model_type: neo_chat`
#   7.  装 **sensenova_u1 推理包**：PyPI **没有**这个包（已核实 404），按官方 pip 兼容口径从源码装 ——
#       下 GitHub tag 归档 tarball（国内代理 ghfast.top / gh-proxy.com / ghproxy.net 优先，
#       最后直连），只解 `pyproject.toml + src/`（跳过 training/evaluation 大目录），
#       然后 `pip install <dir> --no-deps`
#       （**--no-deps 是硬要求**：pyproject 里钉 torch==2.8.0，让 pip 重解会把刚装好的
#        cu128 版覆盖成 PyPI 的 CPU 版）；再探一次 flash-attn：能 import 写 `.attn-backend`=flash，
#       否则 sdpa（Windows 常态，官方不提供 flash-attn 轮子）
#   8.  下权重 **SenseNova/SenseNova-U1.5-8B-MoT**（ModelScope，国内直连免翻墙）→
#       失败回退 HuggingFace（HF_ENDPOINT=https://hf-mirror.com）；校验「8 片 safetensors +
#       config.json + index.json + 分片合计 ≥30GB」才写 `models\.ok`；断点续传＝直接重跑
#   9.  核对工程文件清单
#   10. mock 冒烟（MTNODE_SENSENOVA_MOCK=1，不加载模型）：起服务 → /health（11 个分辨率桶）→
#       /generate 出真 PNG → 并发第二次应 429 busy → /cancel → /progress done → /shutdown
#   11. 写 `.install-ok` 与 `.sensenova-agent-result`（冒烟没过只写后者为 false）
#
# 注意：本脚本**不**把服务留在后台常驻（冒烟结束即关），启停由 MTNode 负责。
# 可重复执行：装到一半失败，按 reason 修好后重跑即续传（已下好的权重不重下）。
# =============================================================================
param(
  [string]$InstallDir = "",                 # 默认脚本所在目录的上一级
  [string]$Python = "",                     # 显式指定 python.exe（离线 / 特殊环境）
  [string]$TorchIndex = "",                 # 显式覆盖 torch 的 --index-url（跳过自动镜像选择）
  [string]$TorchWheel = "",                 # 本地 torch-2.8.0*.whl（完全离线；同目录需有 torchvision whl）
  [string]$Ref = "comfyui-v0.3.0",          # sensenova_u1 的 GitHub tag（本包对接面按该 tag 核对）
  [string]$SrcTarball = "",                 # 已下载好的 SenseNova-U1 归档（.tar.gz 或已解压目录）
  [string]$ModelDir = "",                   # 已有权重目录（离线安装：目录联接进 models\，不复制 32.66GB）
  [string]$ModelScopeRepo = "SenseNova/SenseNova-U1.5-8B-MoT",
  [string]$HfRepo = "sensenova/SenseNova-U1.5-8B-MoT",
  [switch]$Cpu,                             # 装 CPU 版 torch（仅供调试；官方要求 24G 级 N 卡）
  [switch]$Force,                           # 跳过显存 / 内存门槛（明知不够仍要装）
  [switch]$SkipModels,                      # 跳过权重下载（只修 venv / 依赖 / 推理包）
  [switch]$SkipDeps,                        # 跳过 requirements.txt
  [switch]$SkipPkg,                         # 跳过 sensenova_u1 推理包安装
  [switch]$SkipTorch,                       # 跳过 torch 安装
  [switch]$SkipSmoke                        # 跳过 mock 冒烟
)

$ErrorActionPreference = "Stop"
if (-not $InstallDir) {
  $InstallDir = Split-Path -Parent $MyInvocation.MyCommand.Path | Split-Path -Parent
}

# ---------------------------------------------------------------- 输出与结果标记
function Write-Progress-Line([int]$Pct, [string]$Msg) {
  Write-Host "[sensenova-install] progress: $Pct"
  if ($Msg) { Write-Host "[sensenova-install] $Msg" }
}

function Write-AgentResult([string]$Ok, [string]$Reason) {
  $body = "ok=$Ok"
  if ($Reason) { $body = "$body`nreason=$Reason" }
  try {
    Set-Content -Path (Join-Path $InstallDir ".sensenova-agent-result") -Value $body -Encoding UTF8
  } catch {
    Write-Host "[sensenova-install] 警告：结果标记写入失败（$($_.Exception.Message)）"
  }
}

function Fail-Install([string]$Reason, [string]$Advice) {
  Write-Host ""
  Write-Host "[sensenova-install] 错误：安装未完成 reason=$Reason"
  if ($Advice) { Write-Host "[sensenova-install] 处置：$Advice" }
  Write-Host "[sensenova-install] progress: 100"
  Write-AgentResult "false" $Reason
  exit 1
}

# 跑外部命令：外部程序的 stderr 只当诊断输出，不该触发 Stop
# 注意：参数名不能叫 $Args（PowerShell 自动变量），否则 splat 语义会乱
function Invoke-Cmd {
  param([string]$Exe, [string[]]$CmdArgs)
  $prev = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    # 外部程序的 stderr 经 2>&1 后是 ErrorRecord 对象；直接 Write-Host 会被上层（宿主把控制台
    # 当日志采集 / Agent 读 console 尾部）渲染成一行 “System.Management.Automation.RemoteException”，
    # 真实报错正文全丢 —— 正是修复时最需要的那几行。统一取纯文本再打。
    & $Exe @CmdArgs 2>&1 | ForEach-Object {
      $line = if ($_ -is [System.Management.Automation.ErrorRecord]) {
        if ($_.TargetObject) { [string]$_.TargetObject } else { [string]$_.Exception.Message }
      } else { [string]$_ }
      if ($line) { Write-Host $line }
    }
    return $LASTEXITCODE
  } catch {
    Write-Host "[sensenova-install] 命令异常：$($_.Exception.Message)"
    return 1
  } finally {
    $ErrorActionPreference = $prev
  }
}

Write-Host "[sensenova-install] ================================================================"
Write-Host "[sensenova-install] SenseNova 本地图像生成后端安装（SenseNova-U1.5-8B-MoT）"
Write-Host "[sensenova-install]   权重    ：ModelScope $ModelScopeRepo（约 32.66GB / 8 片）"
Write-Host "[sensenova-install]   推理包  ：OpenSenseNova/SenseNova-U1 @$Ref（源码 + --no-deps）"
Write-Host "[sensenova-install]   PyPI    ：清华 pypi.tuna.tsinghua.edu.cn（回退阿里云）"
Write-Host "[sensenova-install]   torch   ：SJTU → 阿里云 → download.pytorch.org"
Write-Host "[sensenova-install]   要求    ：24GB 级 NVIDIA 卡 · 建议 ≥40GB 内存 · ≥60GB 磁盘"
Write-Host "[sensenova-install]   参考    ：https://github.com/OpenSenseNova/SenseNova-U1"
Write-Host "[sensenova-install] ================================================================"

if (-not (Test-Path $InstallDir)) {
  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
}
$InstallDir = (Resolve-Path $InstallDir).Path
Set-Location $InstallDir
Write-Host "[sensenova-install] install dir: $InstallDir"
Write-Progress-Line 2 ""

# 国内镜像常量（一处列全，其它用户换内网镜像只改这里）
$PipIndex = "https://pypi.tuna.tsinghua.edu.cn/simple"
$PipHost = "pypi.tuna.tsinghua.edu.cn"
$PipIndexFallback = "https://mirrors.aliyun.com/pypi/simple/"
$env:HF_ENDPOINT = "https://hf-mirror.com"
$env:HF_HUB_DISABLE_XET = "1"
$env:PYTHONIOENCODING = "utf-8"
$env:PYTHONUNBUFFERED = "1"
# pip 层也钉死国内镜像：本机全局 pip.ini 常被 NVIDIA PyIndex 之类塞入
# `extra-index-url = https://pypi.ngc.nvidia.com`（国内不可达）——每装一个包先白等 5 次
# 重试才回落到清华。用 PIP_* 环境变量覆盖 config 文件里的同名项（**不要**用 pip --isolated：
# 那会连环境变量一起忽略，反而把 ngc 放回来）。子进程（含 build 隔离环境）自动继承。
$env:PIP_INDEX_URL = $PipIndex
$env:PIP_EXTRA_INDEX_URL = $PipIndex
$env:PIP_TRUSTED_HOST = $PipHost
# 保留轮子缓存：torch 3.5GB 万一装失败，重跑不必再下一次
$env:PIP_NO_CACHE_DIR = "0"
# uv 的 python-build-standalone 下载镜像（npmmirror），避免卡在 GitHub release
$env:UV_PYTHON_INSTALL_MIRROR = "https://registry.npmmirror.com/-/binary/python-build-standalone"

try {
  [Net.ServicePointManager]::SecurityProtocol =
    [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch {
  Write-Host "[sensenova-install] 提示：无法显式设置 TLS1.2（$($_.Exception.Message)），继续尝试下载"
}

# ---------------------------------------------------------------- 1. 探测 GPU
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
$driverMajor = 0
if ($null -eq $gpu) {
  if (-not $Cpu) {
    Fail-Install "no_cuda" "SenseNova-U1.5-8B-MoT 需要 NVIDIA 显卡（官方参考环境 CUDA 12.8 + torch 2.8）。确实无卡、只想跑通安装流程，加 -Cpu（真实出图会慢到不可用）。"
  }
  Write-Host "[sensenova-install] 警告：-Cpu 已指定，将装 CPU 版 torch（仅供调试，官方不支持 CPU 推理）"
} else {
  Write-Host "[sensenova-install] GPU：$($gpu.name) · 驱动 $($gpu.driver)（主版本 $($gpu.major)）· 显存 $($gpu.memMb)MB"
  $driverMajor = $gpu.major
  # 权重 bf16 约 32.66GB > 任何单卡显存：官方 vram_mode 档位是给 24G 级卡的最低配置
  if ($gpu.memMb -gt 0 -and $gpu.memMb -lt 20000 -and -not $Force) {
    Fail-Install "vram_too_low" "显存 $($gpu.memMb)MB < 20000MB：官方最省的 vram_mode=low 也需要 24GB 级卡（4090 / 3090 / A5000 档）。低于这条线请改用云端文生图节点（proc_image）或换卡；确实要强行安装加 -Force。"
  }
  if ($gpu.memMb -lt 24000 -and $gpu.memMb -ge 20000) {
    Write-Host "[sensenova-install] 提示：显存 $($gpu.memMb)MB 略低于官方 24G 档，安装后请把 vramMode 设为 low，必要时把 numSteps 降到 30。"
  }
}

Write-Progress-Line 6 "探测内存与磁盘..."
try {
  $os = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop
  $totalGb = [math]::Round($os.TotalVisibleMemorySize / 1MB, 1)
  Write-Host "[sensenova-install] 物理内存：约 $totalGb GB（分层卸载要在内存里放未驻留的权重，建议 ≥40GB）"
  if ($totalGb -lt 32 -and -not $Force) {
    Fail-Install "ram_too_low" "物理内存约 $totalGb GB < 32GB：vram_mode=fast/balanced/low 都要在内存里驻留 32.66GB 权重，装得上也跑不动。加 -Force 可强行继续。"
  }
} catch {
  Write-Host "[sensenova-install] 提示：内存探测失败（$($_.Exception.Message)），跳过该门槛"
}
try {
  $driveName = (Get-Item $InstallDir).PSDrive.Name
  $freeGb = [math]::Round(((Get-PSDrive $driveName).Free / 1GB), 1)
  Write-Host "[sensenova-install] 磁盘 $driveName`: 剩余 $freeGb GB（建议预留 ≥60GB：权重 32.66 + venv 约 12 + 产物）"
  if ($freeGb -lt 50) {
    Write-Host "[sensenova-install] 警告：剩余空间不足 50GB，权重下载可能中途写满；换盘请重跑并加 -InstallDir <路径>"
  }
} catch {
  Write-Host "[sensenova-install] 提示：磁盘探测失败（$($_.Exception.Message)），继续"
}

# ---------------------------------------------------------------- 2. Python + venv
Write-Progress-Line 10 "准备 Python（优先 uv 托管 3.11，配 npmmirror 镜像）..."
$venvPy = Join-Path $InstallDir ".venv\Scripts\python.exe"
$uvCmd = Get-Command uv -ErrorAction SilentlyContinue

function Find-LocalPython([string[]]$Wanted) {
  if ($Python) {
    if (Test-Path $Python) { return (Resolve-Path $Python).Path }
    Write-Host "[sensenova-install] 警告：-Python 指定的路径不存在：$Python，改走自动探测"
  }
  if (Get-Command py -ErrorAction SilentlyContinue) {
    foreach ($ver in $Wanted) {
      $code = Invoke-Cmd "py" @("-$ver", "-c", "import sys")
      if ($code -eq 0) {
        $prev = $ErrorActionPreference
        try {
          $ErrorActionPreference = "Continue"
          $exe = ((& py "-$ver" -c "import sys;print(sys.executable)") 2>$null | Out-String).Trim()
        } catch { $exe = "" } finally { $ErrorActionPreference = $prev }
        if ($exe -and (Test-Path $exe)) { return $exe }
      }
    }
  }
  if (Get-Command python -ErrorAction SilentlyContinue) {
    $code = Invoke-Cmd "python" @("-c", "import sys")
    if ($code -eq 0) {
      $prev = $ErrorActionPreference
      try {
        $ErrorActionPreference = "Continue"
        $exe = ((& python -c "import sys;print(sys.executable)") 2>$null | Out-String).Trim()
      } catch { $exe = "" } finally { $ErrorActionPreference = $prev }
      if ($exe -and (Test-Path $exe)) { return $exe }
    }
  }
  return ""
}

$pyExe = ""
if (-not (Test-Path $venvPy)) {
  if ($uvCmd) {
    Write-Host "[sensenova-install] 检测到 uv：$($uvCmd.Source)"
    $prev = $ErrorActionPreference
    try {
      $ErrorActionPreference = "Continue"
      $found = ((& uv python find "3.11") 2>$null | Out-String).Trim()
      if ($LASTEXITCODE -ne 0 -or -not $found) {
        Write-Host "[sensenova-install] 本机无 uv 托管的 3.11，开始安装（约 30–60 秒，走 npmmirror）..."
        & uv python install 3.11 2>&1 | ForEach-Object { Write-Host "[uv] $_" }
        $found = ((& uv python find "3.11") 2>$null | Out-String).Trim()
      }
    } catch {
      $found = ""
    } finally {
      $ErrorActionPreference = $prev
    }
    $cand = (($found | Out-String) -split "`n")[0].Trim()
    if ($cand -and (Test-Path $cand)) {
      $pyExe = $cand
      Write-Host "[sensenova-install] 采用 uv 托管解释器：$pyExe"
    } else {
      Write-Host "[sensenova-install] 提示：uv 没给出可用的 3.11 解释器（可能镜像拉取失败），回退本机 Python"
    }
  }
  if (-not $pyExe) {
    $pyExe = Find-LocalPython @("3.11", "3.12", "3.13", "3.10")
  }
  if (-not $pyExe) {
    Fail-Install "python_not_found" "既没有 uv 也没有本机 Python 3.10–3.13。请装 uv（`pip install uv` 或官方脚本）或 Python 3.11（python.org / Microsoft Store），或用 -Python C:\path\to\python.exe 指路后重跑。"
  }
  Write-Host "[sensenova-install] 建 venv 用解释器：$pyExe"
}

if (-not (Test-Path $venvPy)) {
  Write-Progress-Line 12 "创建 venv（.venv，已存在则跳过）..."
  $code = Invoke-Cmd $pyExe @("-m", "venv", ".venv")
  if ($code -ne 0 -or -not (Test-Path $venvPy)) {
    Write-Host "[sensenova-install] python -m venv 失败（退出码 $code），试 --without-pip + ensurepip..."
    $null = Invoke-Cmd $pyExe @("-m", "venv", "--without-pip", ".venv")
    if (Test-Path $venvPy) {
      $null = Invoke-Cmd $venvPy @("-m", "ensurepip", "--upgrade")
    }
  }
  if (-not (Test-Path $venvPy) -and $uvCmd) {
    Write-Host "[sensenova-install] 退回 uv venv --seed（自带 pip）"
    $prev = $ErrorActionPreference
    try {
      $ErrorActionPreference = "Continue"
      & uv venv .venv --python 3.11 --seed 2>&1 | ForEach-Object { Write-Host "[uv] $_" }
    } finally { $ErrorActionPreference = $prev }
  }
  if (-not (Test-Path $venvPy)) {
    Fail-Install "venv_creation_failed" "删掉半成的 .venv 后重跑本脚本；仍失败请手动执行：& `"$pyExe`" -m venv .\.venv 并把报错贴出来。"
  }
} else {
  Write-Host "[sensenova-install] 已有 .venv，跳过创建（不换解释器；要换先删掉 .venv 再重跑）"
}

Write-Progress-Line 16 "校验 venv 解释器并升级 pip（清华 → 阿里云）..."
$null = Invoke-Cmd $venvPy @("-c", "import sys; print('[sensenova-install] venv python', sys.version.split()[0], sys.executable)")
$pipCode = Invoke-Cmd $venvPy @("-m", "pip", "--version")
if ($pipCode -ne 0) {
  Write-Host "[sensenova-install] venv 里没有 pip，跑 ensurepip 补上"
  $null = Invoke-Cmd $venvPy @("-m", "ensurepip", "--upgrade")
}
$code = Invoke-Cmd $venvPy @("-m", "pip", "install", "--upgrade", "pip", "-i", $PipIndex, "--trusted-host", $PipHost)
if ($code -ne 0) {
  Write-Host "[sensenova-install] 清华镜像升级 pip 失败，回退阿里云..."
  $null = Invoke-Cmd $venvPy @("-m", "pip", "install", "--upgrade", "pip", "-i", $PipIndexFallback)
}

# ---------------------------------------------------------------- 3. torch（CUDA · 国内镜像）
$torchCu = "cu128"
if ($driverMajor -gt 0 -and $driverMajor -lt 570) {
  $torchCu = "cu126"
  Write-Host "[sensenova-install] 驱动主版本 $driverMajor < 570 → 改装 $torchCu 档（cu128 需要 570+ 驱动）"
}
if ($Cpu) { $torchCu = "cpu" }

if ($SkipTorch) {
  Write-Progress-Line 30 "按 -SkipTorch 跳过 torch 安装"
} elseif ($TorchWheel -and (Test-Path $TorchWheel)) {
  Write-Progress-Line 22 "离线安装 torch：$TorchWheel（同目录自动找 torchvision whl）..."
  # 离线 whl：torch/torchvision 从本地轮子装，缺失的传递依赖（numpy / pillow / filelock…）
  # 仍从清华镜像补（PIP_* 环境变量已把全局 pip.ini 里不可达的额外索引挡在外面）。
  $code = Invoke-Cmd $venvPy @("-m", "pip", "install", $TorchWheel, "-i", $PipIndex, "--trusted-host", $PipHost)
  $tv = Get-ChildItem -Path (Split-Path -Parent $TorchWheel) -Filter "torchvision-*.whl" -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($tv) {
    $code2 = Invoke-Cmd $venvPy @("-m", "pip", "install", $tv.FullName, "-i", $PipIndex, "--trusted-host", $PipHost)
  } else {
    $code2 = Invoke-Cmd $venvPy @("-m", "pip", "install", "torchvision==0.23.0", "-i", $PipIndex, "--trusted-host", $PipHost)
    Write-Host "[sensenova-install] 提示：同目录没有 torchvision whl，改装 PyPI 版（可能与 CUDA 档位不完全对齐，仅影响预处理算子）"
  }
  if ($code -ne 0 -or $code2 -ne 0) {
    Fail-Install "torch_install_failed" "离线 whl 安装失败（torch=$code torchvision=$code2）：看上面报错，常见是 whl 的 cpXXX 标签与本 venv 的 Python 版本不匹配（本包推荐 cp311）。"
  }
} else {
  # 关键：非 CPU 档必须把**本地版本号**（+cu128 / +cu126）写进 pin —— 清华 / PyPI 上的
  # Windows torch 轮子是 CPU 版，只写 `torch==2.8.0` 很容易被解析成 CPU 版（假成功）。
  $local = if ($torchCu -eq "cpu") { "" } else { "+$torchCu" }
  $torchPins = @("torch==2.8.0$local", "torchvision==0.23.0$local")
  Write-Progress-Line 22 "安装 $($torchPins -join ' + ')（约 3.5GB，逐源尝试：SJTU → 阿里云 → 官方）..."
  $torchOk = $false
  if ($TorchIndex) {
    # 自定义源：--index-url 指过去，torch 的传递依赖仍从清华解析
    $a = @("-m","pip","install") + $torchPins + @("--index-url", $TorchIndex, "--extra-index-url", $PipIndex, "--trusted-host", $PipHost)
    $code = Invoke-Cmd $venvPy $a
    if ($code -eq 0) { $torchOk = $true } else {
      Fail-Install "torch_install_failed" "-TorchIndex 指定的源（$TorchIndex）装不上 $($torchPins -join ' + ')：确认该索引下有对应 cp311/win_amd64 轮子，或去掉该参数走自动镜像选择。"
    }
  } else {
    # ① SJTU：download.pytorch.org 的 PEP503 镜像，可直接当 --index-url；传递依赖走清华
    #    PIP_* 环境变量（见文件头）已覆盖本机全局 pip.ini 的额外索引（常被 NVIDIA PyIndex
    #    塞入 pypi.ngc.nvidia.com，国内不可达 → 每个包白等 5 次重试）。
    $a = @("-m","pip","install") + $torchPins + @("--index-url", "https://mirror.sjtu.edu.cn/pytorch-wheels/$torchCu", "--extra-index-url", $PipIndex, "--trusted-host", $PipHost)
    $code = Invoke-Cmd $venvPy $a
    if ($code -eq 0) { $torchOk = $true } else { Write-Host "[sensenova-install] SJTU 镜像失败（退出码 $code），试阿里云..." }
  }
  if (-not $torchOk -and -not $TorchIndex) {
    # ② 阿里云：平铺轮子目录 → --find-links，torch 的传递依赖仍从清华 PyPI 解析
    $a = @("-m","pip","install") + $torchPins + @("--find-links", "https://mirrors.aliyun.com/pytorch-wheels/$torchCu", "-i", $PipIndex, "--trusted-host", $PipHost)
    $code = Invoke-Cmd $venvPy $a
    if ($code -eq 0) { $torchOk = $true } else { Write-Host "[sensenova-install] 阿里云镜像失败（退出码 $code），回退官方 index..." }
  }
  if (-not $torchOk) {
    # ③ 官方兜底（该索引自带 torch 的传递依赖，单 --index-url 即可）
    $a = @("-m","pip","install") + $torchPins + @("--index-url", "https://download.pytorch.org/whl/$torchCu")
    $code = Invoke-Cmd $venvPy $a
    if ($code -eq 0) { $torchOk = $true }
  }
  if (-not $torchOk) {
    Fail-Install "torch_install_failed" "三个源都装不上 $($torchPins -join ' + ')。可：① 手动下载 torch-2.8.0$local-cp311-cp311-win_amd64.whl 后用 -TorchWheel `<路径>` 重跑；② 用 -TorchIndex 指定公司内网镜像；③ 驱动太旧就把 NVIDIA 驱动升到 570+（cu128），或让脚本自动降档（<570 走 cu126）。"
  }
}

Write-Progress-Line 30 "校验 torch 是否真能看到 CUDA..."
if (-not $Cpu) {
  $checkPy = @'
import sys
try:
    import torch
except Exception as e:
    print(f"[sensenova-install] torch 不可导入：{type(e).__name__}: {str(e)[:200]}")
    sys.exit(2)
ok = bool(torch.cuda.is_available())
print(f"[sensenova-install] torch {torch.__version__} · cuda={torch.version.cuda or '-'} · "
      f"cuda_available={ok}" + (f" · device={torch.cuda.get_device_name(0)}" if ok else ""))
sys.exit(0 if ok else 3)
'@
  $cf = Join-Path $env:TEMP ("mtnode-sensenova-torch-" + [guid]::NewGuid().ToString("N") + ".py")
  Set-Content -Path $cf -Value $checkPy -Encoding UTF8
  $code = Invoke-Cmd $venvPy @($cf)
  Remove-Item -Force $cf -ErrorAction SilentlyContinue
  if ($code -ne 0) {
    if ($Force) {
      Write-Host "[sensenova-install] 警告：torch 看不到 CUDA（退出码 $code，被 -Force 放行）。真实 /generate 会报 model_load_failed。"
    } else {
      Fail-Install "torch_no_cuda" "torch 装好了但 torch.cuda.is_available()=False —— 多半是装成了 CPU 版（清华/PyPI 上的 Windows torch 就是 CPU 版）或驱动太旧。请先 `& `"$venvPy`" -m pip uninstall -y torch torchvision`"，再重跑本脚本（会用国内镜像装 $torchCu 版；权重不会重下）。驱动低于 570 就把 NVIDIA 驱动升级，或确认脚本已按 <570 自动降 cu126。"
    }
  }
}

# ---------------------------------------------------------------- 4. 依赖
if ($SkipDeps) {
  Write-Progress-Line 40 "按 -SkipDeps 跳过 requirements.txt"
} else {
  Write-Progress-Line 34 "安装 Python 依赖（requirements.txt：transformers≥4.57.1 / accelerate / modelscope / pillow，清华镜像）..."
  $ReqFile = Join-Path $InstallDir "requirements.txt"
  if (-not (Test-Path $ReqFile)) {
    $ReqFile = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path | Split-Path -Parent) "requirements.txt"
  }
  $code = Invoke-Cmd $venvPy @("-m", "pip", "install", "-r", $ReqFile, "-i", $PipIndex, "--trusted-host", $PipHost)
  if ($code -ne 0) {
    Write-Host "[sensenova-install] 清华镜像失败，回退阿里云镜像重试..."
    $code = Invoke-Cmd $venvPy @("-m", "pip", "install", "-r", $ReqFile, "-i", $PipIndexFallback)
    if ($code -ne 0) {
      Fail-Install "requirements_install_failed" "单独重装看完整报错：& `"$venvPy`" -m pip install -r requirements.txt -i $PipIndex --trusted-host $PipHost"
    }
  }
}

Write-Progress-Line 40 "校验 transformers 版本能认 NEOChatModel 配置..."
$tfPy = @'
import sys
try:
    import transformers
except Exception as e:
    print(f"[sensenova-install] transformers 不可用：{type(e).__name__}: {str(e)[:200]}")
    sys.exit(2)
parts = tuple(int(x) for x in transformers.__version__.split(".")[:2] if x.isdigit())
print(f"[sensenova-install] transformers {transformers.__version__}（sensenova_u1 要求 >=4.57.1,<6）")
sys.exit(0 if parts >= (4, 57) else 3)
'@
$tfFile = Join-Path $env:TEMP ("mtnode-sensenova-tf-" + [guid]::NewGuid().ToString("N") + ".py")
Set-Content -Path $tfFile -Value $tfPy -Encoding UTF8
$tfCode = Invoke-Cmd $venvPy @($tfFile)
Remove-Item -Force $tfFile -ErrorAction SilentlyContinue
if ($tfCode -ne 0) {
  Fail-Install "transformers_too_old" "transformers 版本不达标（退出码 $tfCode）：低于 4.57.1 时 AutoConfig 认不出 model_type=`"neo_chat`"，加载必失败。补装：& `"$venvPy`" -m pip install -U `"transformers>=4.57.1,<6`" -i $PipIndex --trusted-host $PipHost，然后重跑本脚本。"
}

# ---------------------------------------------------------------- 5. sensenova_u1 推理包
$SrcRoot = Join-Path $InstallDir "src"
$PkgDirName = "SenseNova-U1-$($Ref -replace '[/\\]', '-')"
$PkgDir = Join-Path $SrcRoot $PkgDirName
$TarPath = Join-Path $SrcRoot "$PkgDirName.tar.gz"
$AttnFile = Join-Path $InstallDir ".attn-backend"

if ($SkipPkg) {
  Write-Progress-Line 54 "按 -SkipPkg 跳过 sensenova_u1 推理包安装"
} else {
  Write-Progress-Line 44 "获取 sensenova_u1 源码（PyPI 无此包；GitHub tag $Ref 归档，国内代理优先）..."
  New-Item -ItemType Directory -Force -Path $SrcRoot | Out-Null

  if ($SrcTarball) {
    if (Test-Path $SrcTarball -PathType Container) {
      $PkgDir = (Resolve-Path $SrcTarball).Path
      Write-Host "[sensenova-install] 使用已解压源码目录：$PkgDir"
    } elseif (Test-Path $SrcTarball) {
      Copy-Item -Force $SrcTarball $TarPath
      Write-Host "[sensenova-install] 使用已有归档：$SrcTarball"
    } else {
      Write-Host "[sensenova-install] 警告：-SrcTarball 路径不存在：$SrcTarball，改走在线下载"
    }
  }

  # 源码就绪判据：必须是**完整**的一套。只看 pyproject.toml 会把上一次解包残缺
  # （例如漏了 LICENSE）的目录误判为已就绪，于是永远跳过重解，后面 hatchling 一直报
  # `OSError: License file does not exist: LICENSE`。缺任何一项就重解（自愈）。
  function Test-PkgSourceReady([string]$dir) {
    foreach ($rel in @("pyproject.toml", "LICENSE", "src\sensenova_u1\__init__.py")) {
      if (-not (Test-Path (Join-Path $dir $rel))) {
        Write-Host "[sensenova-install] 源码缺 $rel（判为未就绪，重新解包）"
        return $false
      }
    }
    return $true
  }

  if (-not (Test-PkgSourceReady $PkgDir)) {
    if (-not (Test-Path $TarPath)) {
      $urls = @(
        "https://ghfast.top/https://github.com/OpenSenseNova/SenseNova-U1/archive/refs/tags/$Ref.tar.gz",
        "https://gh-proxy.com/https://github.com/OpenSenseNova/SenseNova-U1/archive/refs/tags/$Ref.tar.gz",
        "https://ghproxy.net/https://github.com/OpenSenseNova/SenseNova-U1/archive/refs/tags/$Ref.tar.gz",
        "https://github.com/OpenSenseNova/SenseNova-U1/archive/refs/tags/$Ref.tar.gz"
      )
      $oldProgress = $ProgressPreference
      foreach ($url in $urls) {
        try {
          Write-Host "[sensenova-install] 下载归档：$url"
          $ProgressPreference = "SilentlyContinue"
          Invoke-WebRequest -Uri $url -OutFile $TarPath -UseBasicParsing -TimeoutSec 900 `
            -Headers @{ "User-Agent" = "MTNode-SenseNova-Installer" }
          if ((Get-Item $TarPath).Length -lt 200000) {
            Write-Host "[sensenova-install] 归档过小（$((Get-Item $TarPath).Length) 字节），判为失败"
            Remove-Item -Force $TarPath -ErrorAction SilentlyContinue
            continue
          }
          Write-Host "[sensenova-install] 归档到手：$([math]::Round((Get-Item $TarPath).Length/1MB,1)) MB"
          break
        } catch {
          Write-Host "[sensenova-install] 该源失败：$($_.Exception.Message)"
          Remove-Item -Force $TarPath -ErrorAction SilentlyContinue
        } finally {
          $ProgressPreference = $oldProgress
        }
      }
    }
    if (Test-Path $TarPath) {
      Write-Progress-Line 48 "解包（只取 pyproject.toml / README.md / LICENSE / src，跳过 training / evaluation 大目录）..."
      if (Test-Path $PkgDir) { Remove-Item -Recurse -Force $PkgDir -ErrorAction SilentlyContinue }
      New-Item -ItemType Directory -Force -Path $PkgDir | Out-Null
      # 解包口径（Windows 自带 bsdtar 实测）：
      #   ① 按成员名选择时**不能**再加 --strip-components —— 成员名已含顶层目录
      #      `${PkgDirName}/pyproject.toml`，去掉一层会把文件吐到 $SrcRoot 而不是 $PkgDir，
      #      脚本随后检查 $PkgDir\pyproject.toml 就会误判“没拿到文件”（源码其实已解压）。
      #   ② LICENSE 必须一起取：pyproject 里 license = { file = "LICENSE" }，漏掉它 hatchling
      #      会在 Preparing metadata 阶段抛 `OSError: License file does not exist: LICENSE`，
      #      长得像网络/构建环境问题，实际是解包少了个文件。
      #   ③ 退回整包解压时用 --strip-components=1 并 -C $PkgDir，直接把顶层剥掉落进 $PkgDir。
      $prefix = "$PkgDirName/"
      $code = Invoke-Cmd "tar" @("-xzf", $TarPath, "-C", $SrcRoot,
        "${prefix}pyproject.toml", "${prefix}README.md", "${prefix}LICENSE", "${prefix}src")
      if ($code -ne 0 -or -not (Test-Path (Join-Path $PkgDir "pyproject.toml"))) {
        Write-Host "[sensenova-install] 按前缀解包没拿到文件（退出码 $code），退回整包解压"
        $null = Invoke-Cmd "tar" @("-xzf", $TarPath, "-C", $PkgDir, "--strip-components=1")
      }
    }
  }

  if (-not (Test-PkgSourceReady $PkgDir)) {
    Fail-Install "source_unavailable" "拿不到 sensenova_u1 源码（$Ref 归档，四个源都失败）。请手动下载 https://github.com/OpenSenseNova/SenseNova-U1/archive/refs/tags/$Ref.tar.gz 后用 -SrcTarball `<路径>` 重跑本脚本（离线机器可让同事下好拷过来）。"
  }

  Write-Progress-Line 50 "安装 sensenova_u1（--no-deps：绝不让 pip 重解 torch 依赖）..."
  # --no-deps 是硬要求：pyproject 里钉 torch==2.8.0，若让 pip 重解，它会从 PyPI/清华拉
  # Windows 的 CPU 轮子，把第 3 步辛苦装好的 cu128 版覆盖掉（官方 docs/installation 同样要求）。
  $code = Invoke-Cmd $venvPy @("-m", "pip", "install", $PkgDir, "--no-deps", "-i", $PipIndex, "--trusted-host", $PipHost)
  if ($code -ne 0) {
    Write-Host "[sensenova-install] 常规安装失败（退出码 $code），试 --no-build-isolation（先装 hatchling）..."
    $null = Invoke-Cmd $venvPy @("-m", "pip", "install", "hatchling", "-i", $PipIndex, "--trusted-host", $PipHost)
    $code = Invoke-Cmd $venvPy @("-m", "pip", "install", $PkgDir, "--no-deps", "--no-build-isolation")
    if ($code -ne 0) {
      Fail-Install "package_install_failed" "sensenova_u1 没能从 $PkgDir 装进 venv。手动跑一遍看完整报错：& `"$venvPy`" -m pip install `"$PkgDir`" --no-deps；常见原因是 build 隔离环境拉不到 hatchling（换 -i $PipIndexFallback 或加 --no-build-isolation）。"
    }
  }

  Write-Progress-Line 52 "校验 sensenova_u1 接口与注意力档位（写 $AttnFile）..."
  $pkgPy = @'
import sys

backend_file = sys.argv[1]
code = 0
try:
    import sensenova_u1
except Exception as e:
    print(f"[sensenova-install] sensenova_u1 导入失败：{type(e).__name__}: {str(e)[:300]}")
    print("[sensenova-install]   多为 transformers 太低（需 >=4.57.1），或 --no-deps 之后漏装 sentencepiece / safetensors")
    sys.exit(2)
print(f"[sensenova-install] sensenova_u1 {getattr(sensenova_u1, '__version__', 'unknown')} 导入成功（NEO-Unify 已注册进 transformers）")
try:
    from sensenova_u1.utils import (
        load_model_and_tokenizer, make_offload_ctx, vram_mode_to_prefetch_count,
        vram_mode_keeps_generation_resident, best_available_device,
    )
    modes = {m: vram_mode_to_prefetch_count(m) for m in ("full", "fast", "balanced", "low")}
    print(f"[sensenova-install] utils 接口齐 · vram_mode->prefetch={modes} · best_device={best_available_device()}")
except Exception as e:
    print(f"[sensenova-install] sensenova_u1.utils 接口不全：{type(e).__name__}: {str(e)[:200]}")
    code = 3
try:
    import flash_attn  # noqa: F401
    backend = "flash"
    print("[sensenova-install] flash_attn 可导入 → .attn-backend = flash")
except Exception:
    backend = "sdpa"
    print("[sensenova-install] 无 flash_attn（Windows 常态，官方不提供该轮子）→ .attn-backend = sdpa")
try:
    sensenova_u1.set_attn_backend(backend)
    print(f"[sensenova-install] 实际生效注意力：{sensenova_u1.effective_attn_backend()}")
except Exception as e:
    print(f"[sensenova-install] set_attn_backend({backend}) 失败：{str(e)[:160]}")
    code = code or 3
try:
    from sensenova_u1.models.neo_unify import NEOChatModel  # noqa: F401
    print("[sensenova-install] NEOChatModel 可用（t2i_generate 的宿主类）")
except Exception as e:
    print(f"[sensenova-install] NEOChatModel 不可导入：{type(e).__name__}: {str(e)[:200]}")
    code = code or 3
try:
    with open(backend_file, "w", encoding="utf-8") as f:
        f.write(backend + "\n")
except Exception as e:
    print(f"[sensenova-install] 警告：.attn-backend 写入失败：{str(e)[:160]}")
sys.exit(code)
'@
  $pkgFile = Join-Path $env:TEMP ("mtnode-sensenova-pkg-" + [guid]::NewGuid().ToString("N") + ".py")
  Set-Content -Path $pkgFile -Value $pkgPy -Encoding UTF8
  $pkgCode = Invoke-Cmd $venvPy @($pkgFile, $AttnFile)
  Remove-Item -Force $pkgFile -ErrorAction SilentlyContinue
  if ($pkgCode -eq 2) {
    Fail-Install "package_import_failed" "sensenova_u1 装上了但 import 失败（见上面报错）。按提示补依赖（最常见：& `"$venvPy`" -m pip install -U `"transformers>=4.57.1,<6`" -i $PipIndex；或 sentencepiece==0.2.1），然后重跑本脚本 —— **不要重下 32.66GB 权重**。"
  }
  if ($pkgCode -ne 0) {
    Write-Host "[sensenova-install] 警告：sensenova_u1 接口自检未完全通过（退出码 $pkgCode）；继续安装，真实 /generate 报 model_load_failed 时回到这一步查。"
  }
}

# ---------------------------------------------------------------- 6. 权重
$ModelsDir = Join-Path $InstallDir "models"
New-Item -ItemType Directory -Force -Path $ModelsDir | Out-Null
$ModelDirFlat = Join-Path $ModelsDir "SenseNova__SenseNova-U1.5-8B-MoT"

function Test-ModelComplete([string]$dir) {
  if (-not (Test-Path $dir)) { return $false }
  if (-not (Test-Path (Join-Path $dir "config.json"))) { return $false }
  if (-not (Test-Path (Join-Path $dir "model.safetensors.index.json"))) { return $false }
  $shards = @(Get-ChildItem -Path $dir -Filter "model-*-of-00008.safetensors" -ErrorAction SilentlyContinue)
  if ($shards.Count -lt 8) {
    Write-Host "[sensenova-install] 权重分片只有 $($shards.Count)/8 片，视为未下完"
    return $false
  }
  $gb = 0
  try { $gb = [math]::Round((($shards | Measure-Object -Property Length -Sum).Sum / 1GB), 2) } catch { $gb = 0 }
  if ($gb -lt 30) {
    Write-Host "[sensenova-install] 权重分片合计仅 $gb GB（应为约 32.66GB），视为未下完"
    return $false
  }
  Write-Host "[sensenova-install] 权重校验通过：8 片 / $gb GB @ $dir"
  return $true
}

Write-Progress-Line 56 "准备权重（$ModelScopeRepo · 约 32.66GB）..."
if ($ModelDir -and (Test-Path $ModelDir)) {
  if (Test-Path $ModelDirFlat) {
    Write-Host "[sensenova-install] 已有 models\SenseNova__SenseNova-U1.5-8B-MoT，忽略 -ModelDir"
  } else {
    try {
      New-Item -ItemType Junction -Path $ModelDirFlat -Target $ModelDir -ErrorAction Stop | Out-Null
      Write-Host "[sensenova-install] 已建立目录联接：$ModelDirFlat -> $ModelDir"
    } catch {
      Write-Host "[sensenova-install] 目录联接失败，改为复制（要占 32.66GB 空间）：$($_.Exception.Message)"
      Copy-Item -Recurse -Force $ModelDir $ModelDirFlat
    }
  }
}

if ($SkipModels) {
  Write-Progress-Line 78 "按 -SkipModels 跳过权重下载"
} elseif (Test-ModelComplete $ModelDirFlat) {
  Write-Progress-Line 78 "权重已就位，跳过下载"
} else {
  Write-Progress-Line 58 "下载权重：ModelScope（国内直连）优先，失败回退 hf-mirror..."
  $pyDl = @'
import os
import sys
from pathlib import Path

ms_repo, hf_repo, dest = sys.argv[1], sys.argv[2], sys.argv[3]
ignore = ["assets/*", "docs/*", "*.mp4", "*.webm", "*.gif"]


def complete(d):
    p = Path(d)
    if not (p / "config.json").is_file():
        return False
    if not (p / "model.safetensors.index.json").is_file():
        return False
    shards = list(p.glob("model-*-of-00008.safetensors"))
    if len(shards) < 8:
        print(f"[sensenova-install] 分片只有 {len(shards)}/8")
        return False
    total = sum(s.stat().st_size for s in shards) / (1024 ** 3)
    print(f"[sensenova-install] 分片 {len(shards)} 片 / {total:.2f} GB")
    return total >= 30


if complete(dest):
    print("[sensenova-install] 权重已完整，跳过下载")
    sys.exit(0)

done = False
try:
    from modelscope import snapshot_download
    print(f"[sensenova-install] ModelScope 下载 {ms_repo} -> {dest}（32.66GB，国内直连，视带宽约 20–60 分钟）")
    snapshot_download(ms_repo, local_dir=dest, ignore_patterns=ignore)
    done = complete(dest)
except Exception as e:
    print(f"[sensenova-install] ModelScope 失败：{type(e).__name__}: {str(e)[:300]}")

if not done:
    try:
        os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
        os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
        from huggingface_hub import snapshot_download as hf_snapshot
        print(f"[sensenova-install] hf-mirror 下载 {hf_repo} -> {dest}（endpoint={os.environ.get('HF_ENDPOINT')}）")
        hf_snapshot(repo_id=hf_repo, local_dir=dest, ignore_patterns=ignore)
        done = complete(dest)
    except Exception as e:
        print(f"[sensenova-install] hf-mirror 失败：{type(e).__name__}: {str(e)[:300]}")

if not done:
    print("[sensenova-install] 权重未下全（ModelScope 与 hf-mirror 都没拿到完整 8 片）。")
    print("[sensenova-install] 续传：直接重跑本脚本（已下分片不重下）；")
    print("[sensenova-install]       或浏览器/其它工具下好后用 -ModelDir <路径> 重跑本脚本。")
    sys.exit(3)
print("[sensenova-install] 权重下载完成")
'@
  $dlScript = Join-Path $env:TEMP ("mtnode-sensenova-dl-" + [guid]::NewGuid().ToString("N") + ".py")
  Set-Content -Path $dlScript -Value $pyDl -Encoding UTF8
  $dlCode = Invoke-Cmd $venvPy @($dlScript, $ModelScopeRepo, $HfRepo, $ModelDirFlat)
  Remove-Item -Force $dlScript -ErrorAction SilentlyContinue
  if ($dlCode -ne 0) {
    Write-Host "[sensenova-install] 警告：权重未齐（退出码 $dlCode）。服务仍可启动，但真实 /generate 会报 model_load_failed；重跑本脚本可续传。"
  }
}

if (Test-ModelComplete $ModelDirFlat) {
  New-Item -ItemType File -Force -Path (Join-Path $ModelsDir ".ok") | Out-Null
  Write-Host "[sensenova-install] 模型就位：SenseNova-U1.5-8B-MoT（models\.ok 已写入）"
} else {
  Write-Host "[sensenova-install] 提示：models\.ok 未创建（权重未齐）；可用 -ModelDir 指向已有目录，或去掉 -SkipModels 重跑下载"
}

# ---------------------------------------------------------------- 7. 工程文件清单
Write-Progress-Line 82 "核对工程文件清单..."
$RequiredFiles = @(
  "app\__init__.py",
  "app\__main__.py",
  "app\server.py",
  "app\engine.py",
  "scripts\install.ps1",
  "requirements.txt",
  "manifest.json",
  "start_backend.cmd"
)
$MissingFiles = @()
foreach ($rel in $RequiredFiles) {
  if (-not (Test-Path (Join-Path $InstallDir $rel))) { $MissingFiles += $rel }
}
if ($MissingFiles.Count -gt 0) {
  Write-Host "[sensenova-install] 警告：工程文件缺失：" + ($MissingFiles -join "、")
  Write-Host "[sensenova-install]       从随包脚手架（SCAFFOLD_REF\sensenova-pack）补齐 app\ 与 scripts\ 后重跑；"
  Write-Host "[sensenova-install]       app\engine.py 与 app\server.py 缺一即起不来服务。"
} else {
  Write-Host "[sensenova-install] 工程文件齐全"
}

# ---------------------------------------------------------------- 8. mock 冒烟（不加载模型，验对接面）
$smokeOk = $true
if ($SkipSmoke) {
  Write-Progress-Line 92 "按 -SkipSmoke 跳过 mock 冒烟"
} else {
  Write-Progress-Line 86 "mock 冒烟（MTNODE_SENSENOVA_MOCK=1：/health → /generate 出 PNG → busy 429 → /cancel → /progress → /shutdown）..."
  $smokePy = @'
import json, os, shutil, subprocess, sys, tempfile, threading, time, urllib.error, urllib.request, uuid
from pathlib import Path

install_dir = Path(sys.argv[1])
port = int(sys.argv[2])
log_path = Path(tempfile.gettempdir()) / f"mtnode-sensenova-smoke-{uuid.uuid4().hex}.log"
out_dir = Path(tempfile.gettempdir()) / f"mtnode-sensenova-out-{uuid.uuid4().hex}"

env = dict(os.environ)
env["MTNODE_SENSENOVA_MOCK"] = "1"
env["SENSENOVA_PORT"] = str(port)
env["SENSENOVA_MOCK_DELAY_SEC"] = "3"   # 拉长 mock，稳定复现 busy / cancel 两条路径
env["PYTHONIOENCODING"] = "utf-8"
proc = subprocess.Popen([sys.executable, "-m", "app", str(port)], cwd=str(install_dir), env=env,
                        stdout=open(log_path, "w", encoding="utf-8", errors="replace"),
                        stderr=subprocess.STDOUT)
code = 0


def post(path, body, timeout=60):
    req = urllib.request.Request("http://127.0.0.1:%d%s" % (port, path),
                                 data=json.dumps(body).encode("utf-8"),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def get(path, timeout=10):
    with urllib.request.urlopen("http://127.0.0.1:%d%s" % (port, path), timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


body = {
    "prompt": "a red cube on a white table, studio light, product photo",
    "width": 512, "height": 512, "numSteps": 4, "cfgScale": 4.0,
    "seed": 123456, "think": True, "outputDir": str(out_dir), "filename": "smoke.png",
}
try:
    health = None
    for _ in range(120):
        if proc.poll() is not None:
            break
        try:
            health = get("/health", timeout=2)
            break
        except Exception:
            time.sleep(0.5)
    if not health:
        print("[sensenova-install] 冒烟失败：/health 无响应（服务没起来，看下面日志）")
        code = 4
    else:
        print("[sensenova-install] /health -> " + json.dumps(
            {k: health.get(k) for k in ("ok", "service", "version", "model", "device", "mock",
                                        "loaded", "busy", "vramMode", "attnBackend")}, ensure_ascii=False))
        bad = []
        if health.get("mock") is not True:
            bad.append("mock!=true")
        if health.get("service") != "mtnode-sensenova":
            bad.append("service 名不符")
        if health.get("model") != "sensenova/SenseNova-U1.5-8B-MoT":
            bad.append("model repo id 不符")
        if len(health.get("resolutions") or []) != 11:
            bad.append("resolutions 应为 11 个官方分辨率桶")
        if not (health.get("defaults") or {}).get("numSteps"):
            bad.append("缺 defaults（宿主表单要用）")
        if bad:
            print("[sensenova-install] 冒烟失败：/health 契约不符 -> " + "；".join(bad))
            code = 5

    if code == 0:
        # 参考图（本轮修复）：带 refImages 时 engine 必须进图像编辑模式（mode=edit）并把参考图记进产物
        ref_png = out_dir / "ref-input.png"
        try:
            out_dir.mkdir(parents=True, exist_ok=True)
            ref_png.write_bytes(bytes.fromhex(
                "89504e470d0a1a0a0000000d4948445200000001000000010806000000"
                "1f15c4890000000d49444154789c6360000002000100ffff0300000600"
                "05570c1c0000000049454e44ae426082"))
        except Exception as e:
            print("[sensenova-install] 警告：造参考图失败（" + str(e)[:160] + "），跳过参考图联调")
            ref_png = None
        if code == 0 and ref_png is not None:
            body_ref = dict(body)
            body_ref["filename"] = "with-ref.png"
            body_ref["refImages"] = [str(ref_png).replace("\\", "/"), str(out_dir / "nope.png").replace("\\", "/")]
            ref_err = ""
            try:
                rref = post("/generate", body_ref, timeout=120)
            except Exception as e:
                ref_err = str(e)[:200]
                rref = {}
            print("[sensenova-install] 参考图 mock -> " + json.dumps(
                {k: rref.get(k) for k in ("ok", "mode", "refImagesUsed", "imagePath")}, ensure_ascii=False))
            if ref_err:
                print("[sensenova-install] 冒烟失败：带 refImages 的 /generate 异常 " + ref_err)
                code = 18
            elif rref.get("mode") != "edit" or int(rref.get("refImagesUsed") or 0) != 1:
                print("[sensenova-install] 冒烟失败：参考图未进图像编辑模式（mode/refImagesUsed 不符）")
                code = 19
            elif not Path(rref.get("imagePath") or "").is_file():
                print("[sensenova-install] 冒烟失败：带参考图的产物未落盘")
                code = 20
            else:
                settings = out_dir / "settings.json"
                try:
                    blob = json.loads(settings.read_text(encoding="utf-8"))
                except Exception as e:
                    blob = {}
                    print("[sensenova-install] 警告：读 settings.json 失败（" + str(e)[:120] + "）")
                if blob.get("mode") != "edit" or len(blob.get("refImages") or []) != 1:
                    print("[sensenova-install] 冒烟失败：settings.json 未记录参考图生效（mode/refImages 不符）")
                    code = 21

    if code == 0:
        first = {}

        def run_first():
            try:
                first["resp"] = post("/generate", body, timeout=120)
            except Exception as e:
                first["err"] = str(e)[:200]

        th = threading.Thread(target=run_first)
        th.start()
        time.sleep(0.8)  # mock 故意慢 3s，这一发必定撞上 busy
        busy_code = None
        try:
            post("/generate", body, timeout=20)
        except urllib.error.HTTPError as e:
            busy_code = e.code
            print("[sensenova-install] 并发第二发 -> HTTP " + str(e.code) + " " +
                  e.read().decode("utf-8", "replace")[:200])
        except Exception as e:
            print("[sensenova-install] 并发第二发异常：" + str(e)[:200])
        if busy_code != 429:
            print("[sensenova-install] 冒烟失败：并发生成未返回 429 busy（并发保护失效）")
            code = 6
        prog_mid = None
        try:
            prog_mid = get("/progress")
        except Exception as e:
            print("[sensenova-install] /progress（生成中）异常：" + str(e)[:160])
        if prog_mid is not None and not prog_mid.get("running"):
            print("[sensenova-install] 警告：生成中 /progress.running 不为 true（进度回推可能不可用）")
        th.join(timeout=120)
        if "err" in first:
            print("[sensenova-install] 冒烟失败：/generate 请求异常 " + first["err"])
            code = 7
        else:
            gen = first.get("resp") or {}
            print("[sensenova-install] mock 生成 -> " + json.dumps(
                {k: gen.get(k) for k in ("ok", "imagePath", "width", "height", "ratio", "seed",
                                         "mock", "vramMode", "attnBackend", "thinkPath")}, ensure_ascii=False))
            img = Path(gen.get("imagePath") or "")
            if gen.get("ok") is not True or gen.get("mock") is not True:
                print("[sensenova-install] 冒烟失败：/generate 响应不符合契约")
                code = 8
            elif not img.is_file():
                print("[sensenova-install] 冒烟失败：PNG 未落盘 " + str(img))
                code = 9
            elif img.read_bytes()[:8] != b"\x89PNG\r\n\x1a\n":
                print("[sensenova-install] 冒烟失败：产物不是合法 PNG 文件头")
                code = 10
            elif gen.get("seed") != 123456:
                print("[sensenova-install] 冒烟失败：seed 未按请求回传")
                code = 11
            elif gen.get("width") != 512 or gen.get("height") != 512:
                print("[sensenova-install] 冒烟失败：width/height 未回显")
                code = 12
            elif not gen.get("thinkPath") or not Path(gen["thinkPath"]).is_file():
                print("[sensenova-install] 冒烟失败：think 模式未落 .think.txt")
                code = 13

    if code == 0:
        prog = get("/progress")
        print("[sensenova-install] /progress -> " + json.dumps(
            {k: prog.get(k) for k in ("stage", "percent", "running", "done", "seed")}, ensure_ascii=False))
        if prog.get("stage") != "done" or prog.get("done") is not True:
            print("[sensenova-install] 冒烟失败：/progress 未回到 done")
            code = 14

    if code == 0:
        # 再来一发并中途取消：验证 cancel 生效、且取消后不残留产物
        body2 = dict(body)
        body2["filename"] = "cancelled.png"
        cres = {}

        def run_cancel():
            try:
                cres["resp"] = post("/generate", body2, timeout=60)
            except urllib.error.HTTPError as e:
                cres["http"] = e.code
                cres["body"] = e.read().decode("utf-8", "replace")[:200]
            except Exception as e:
                cres["err"] = str(e)[:200]

        th2 = threading.Thread(target=run_cancel)
        th2.start()
        time.sleep(0.8)
        cancel = post("/cancel", {}, timeout=15)
        th2.join(timeout=60)
        print("[sensenova-install] /cancel -> " + json.dumps(
            {k: cancel.get(k) for k in ("ok", "cancelled", "running")}, ensure_ascii=False))
        if cancel.get("cancelled") is not True:
            print("[sensenova-install] 冒烟失败：生成中 /cancel 未受理")
            code = 15
        elif cres.get("http") != 409:
            print("[sensenova-install] 冒烟失败：取消应回 409 cancelled，实得 " + str(cres))
            code = 16
        elif Path(out_dir / "cancelled.png").exists():
            print("[sensenova-install] 冒烟失败：取消后仍写出了产物")
            code = 17

    try:
        post("/shutdown", {}, timeout=15)
    except Exception:
        pass
finally:
    for _ in range(40):
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
            tail = log_path.read_text(encoding="utf-8", errors="replace").strip().splitlines()[-25:]
            for line in tail:
                print("[sensenova-install] log | " + line)
            log_path.unlink()
    except Exception:
        pass
    shutil.rmtree(out_dir, ignore_errors=True)

if code == 0:
    print("[sensenova-install] mock 冒烟通过（对接面与画布节点 / 宿主一致；[sensenova] ready 见上面日志尾部）")
else:
    print("[sensenova-install] mock 冒烟未通过，退出码 " + str(code))
sys.exit(code)
'@
  $smokeFile = Join-Path $env:TEMP ("mtnode-sensenova-smoke-" + [guid]::NewGuid().ToString("N") + ".py")
  Set-Content -Path $smokeFile -Value $smokePy -Encoding UTF8
  $smokePort = 8774
  if ($env:SENSENOVA_PORT) {
    try { $smokePort = [int]$env:SENSENOVA_PORT } catch { $smokePort = 8774 }
  }
  $code = Invoke-Cmd $venvPy @($smokeFile, $InstallDir, $smokePort)
  Remove-Item -Force $smokeFile -ErrorAction SilentlyContinue
  $smokeOk = ($code -eq 0)
  if (-not $smokeOk) {
    Write-Host "[sensenova-install] 警告：mock 冒烟未通过（退出码 $code）—— 服务契约有问题，真实生成前必须修好这一条（见 SKILL 的已知故障表）"
  }
}

# ---------------------------------------------------------------- 9. 标记
Write-Progress-Line 96 "写入安装标记..."
if ($smokeOk) {
  New-Item -ItemType File -Force -Path (Join-Path $InstallDir ".install-ok") | Out-Null
  Write-AgentResult "true" ""
} else {
  Write-AgentResult "false" "smoke_failed"
}

Write-Progress-Line 100 "完成"
Write-Host "[sensenova-install] 结果："
Write-Host "[sensenova-install]   venv         : $venvPy"
Write-Host "[sensenova-install]   推理包源码   : $PkgDir"
Write-Host "[sensenova-install]   权重         : $ModelDirFlat"
Write-Host "[sensenova-install]   注意力档位   : $AttnFile（内容 flash/sdpa；SENSENOVA_ATTN_BACKEND 可覆盖）"
Write-Host "[sensenova-install]   install flag : $(Join-Path $InstallDir '.install-ok')（存在即装好）"
Write-Host "[sensenova-install]   手工启动     : .venv\Scripts\python.exe -m app 8774（正常由 MTNode 启停）"
if (-not $smokeOk) {
  Write-Host "[sensenova-install] 注意：冒烟未通过，未写 .install-ok —— 修好后重跑本脚本即可（权重不重下）。"
  exit 1
}
exit 0
