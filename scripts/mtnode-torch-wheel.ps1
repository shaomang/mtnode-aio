# MTNode 本地后端插件 · torch wheel 共享获取库（被各 *-pack/scripts/install.ps1 dot-source）
#
# 为什么需要它（本轮实测的真事故）：
#   * `pip install torch==2.9.1+cu128 --index-url <国内镜像>` 在本机实测只有 1.5-3.9 MB/s，
#     1.8GB 的 torch wheel 要 15-20 分钟，3.46GB 的要接近 40 分钟；而**同一个镜像**
#     用 curl 直接拉是 76 MB/s（23 秒拉完 1.8GB）。差别来自 pip 的 HTTP 栈与元数据往返，
#     不是镜像本身慢。
#   * 用户在安装窗看到的就是「装到 CUDA torch 这一步卡死几十分钟」，很容易以为装坏了。
#   * 另外：一次装 3 个插件（yue2 / breeze / sensenova）就要各下一次 1.8-3.5GB 的同一个 wheel。
#
# 这套函数干两件事：
#   1. `Get-MTNodeTorchWheel`：curl -L --retry -C -（断点续传）从国内镜像把 wheel 下到
#      **共享库** `<插件根>\_weights\wheels`，已存在就跳过（跨插件复用，重装不再下载）；
#   2. `Install-MTNodeTorchWheels`：按 cu 档位依次尝试，本地 `pip install --no-index`，
#      装完全是 CUDA 版才算成功（返回 $true/$false），失败就把原因留在日志里。
#
# 用法（在各 pack 的 install.ps1 里）：
#   . (Join-Path (Split-Path -Parent $PSScriptRoot) "scripts\mtnode-torch-wheel.ps1")
#   ... 或直接用包根那份（随包发布，路径按各自的 $PSScriptRoot 拼）
#   if (Install-MTNodeTorchWheels -Python $venvPy -InstallDir $InstallDir -Tiers @("cu128","cu126") -TorchMinor "2.9.1") { ... }
#
# 约定：只下 win_amd64 + cp310 的 wheel（本插件链统一用 Python 3.10/3.11 的 ABI3 兼容轮子；
# cp311 与 cp310 的 torch wheel 不通用，所以按 $PyTag 参数决定，默认 cp310）。

function Get-MTNodeWheelCache {
  param([Parameter(Mandatory = $true)][string]$InstallDir)
  # 共享库放在「插件根」下（与各插件安装目录并列），插件目录被删/重装都不影响已下好的 wheel
  $root = Split-Path -Parent $InstallDir
  $cache = Join-Path $root "_weights\wheels"
  New-Item -ItemType Directory -Force -Path $cache | Out-Null
  return $cache
}

function Get-MTNodeTorchWheel {
  param(
    [Parameter(Mandatory = $true)][string]$Cache,
    [Parameter(Mandatory = $true)][string]$Cu,          # cu130 / cu128 / cu126 ...
    [string]$TorchMinor = "2.9.1",
    [string]$PyTag = "cp310",
    [string]$Base = "https://mirror.sjtu.edu.cn/pytorch-wheels/",
    [string[]]$Packages = @("torch", "torchaudio"),
    # 每个包自己的版本号：torch 2.8.0 配 torchvision 0.23.0（**不是** 2.8.0），
    # 所以不能拿一个 $TorchMinor 套所有包（本轮实测踩过：拼出 torchvision-2.8.0 直接 404）。
    [hashtable]$Versions = @{},
    [int]$MinMB = 4                                      # 小于这个体积视为没下完（会被重下）；torchvision/小轮子本身只有几 MB，门槛别定高
  )
  $out = @()
  foreach ($pkg in $Packages) {
    $ver = if ($Versions.ContainsKey($pkg)) { [string]$Versions[$pkg] } else { $TorchMinor }
    $name = $pkg + "-" + $ver + "+" + $Cu + "-" + $PyTag + "-" + $PyTag + "-win_amd64.whl"
    $path = Join-Path $Cache $name
    $ok = $false
    if (Test-Path $path) {
      $mb = [int]((Get-Item $path).Length / 1MB)
      if ($mb -ge $MinMB) { $ok = $true; Write-Host "[torch-wheel] cached: $name ($mb MB)" }
      else { Write-Host "[torch-wheel] cached file looks truncated ($mb MB), re-downloading: $name"; Remove-Item $path -Force -ErrorAction SilentlyContinue }
    }
    if (-not $ok) {
      $url = $Base.TrimEnd('/') + "/" + $Cu + "/" + ($name -replace '\+', '%2B')
      Write-Host "[torch-wheel] downloading $name ..."
      $prev = $ErrorActionPreference
      $ErrorActionPreference = "Continue"
      try {
        # -C - 断点续传：网络抖动只补差额，不从头再来
        & curl.exe -L --retry 5 --retry-delay 3 -C - -o "$path" "$url" 2>$null | Out-Null
      } finally { $ErrorActionPreference = $prev }
      if (Test-Path $path) {
        $mb = [int]((Get-Item $path).Length / 1MB)
        Write-Host "[torch-wheel] got $name ($mb MB)"
        if ($mb -ge $MinMB) { $ok = $true }
      }
    }
    if ($ok) { $out += $path }
  }
  if ($out.Count -ne $Packages.Count) { return @() }
  return $out
}

function Install-MTNodeTorchWheels {
  param(
    [Parameter(Mandatory = $true)][string]$Python,
    [Parameter(Mandatory = $true)][string]$InstallDir,
    [string[]]$Tiers = @("cu128", "cu126"),
    [string]$TorchMinor = "2.9.1",
    [string]$PyTag = "cp310",
    [string]$Base = "https://mirror.sjtu.edu.cn/pytorch-wheels/",
    [string[]]$Packages = @("torch", "torchaudio"),
    [hashtable]$Versions = @{},
    [int]$MinMB = 4
  )
  $cache = Get-MTNodeWheelCache -InstallDir $InstallDir
  foreach ($cu in $Tiers) {
    $whls = Get-MTNodeTorchWheel -Cache $cache -Cu $cu -TorchMinor $TorchMinor -PyTag $PyTag -Base $Base -Packages $Packages -Versions $Versions -MinMB $MinMB
    if (-not $whls -or $whls.Count -eq 0) { Write-Host "[torch-wheel] $cu wheels unavailable, trying the next tier"; continue }
    Write-Host "[torch-wheel] installing from the local wheels ($cu)"
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
      & $Python -m pip install --no-index --force-reinstall --no-deps @whls | Out-Host
      $rc = $LASTEXITCODE
    } finally { $ErrorActionPreference = $prevEap }
    if ($rc -eq 0) {
      $ver = (& $Python -c "import torch;print(torch.__version__)" 2>$null | Out-String).Trim()
      Write-Host "[torch-wheel] installed torch $ver ($cu)"
      return $true
    }
    Write-Host "[torch-wheel] install from the $cu wheels failed (exit $rc), trying the next tier"
  }
  return $false
}
