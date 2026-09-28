param(
  [string]$InstallDir = (Split-Path -Parent $MyInvocation.MyCommand.Path | Split-Path -Parent)
)

$ErrorActionPreference = "Stop"
Set-Location $InstallDir

Write-Host "[llama-install] ============================================================"
Write-Host "[llama-install] 国内镜像说明（必须，本机位于中国大陆网络时尤其重要）："
Write-Host "[llama-install]   · Python 库：使用清华镜像 pypi.tuna.tsinghua.edu.cn（或中科院 USTC mirrors.ustc.edu.cn）"
Write-Host "[llama-install]   · llama.cpp 二进制来自 GitHub Releases，国内可能无法直连：自动回退 ghproxy 镜像下载"
Write-Host "[llama-install]   · 模型 GGUF：HuggingFace 无法直连，走 hf-mirror.com（可用 HF_ENDPOINT 覆盖）"
Write-Host "[llama-install] ============================================================"
Write-Host "[llama-install] install dir: $InstallDir"
Write-Host "[llama-install] progress: 8"

function Find-Python {
  if (Get-Command py -ErrorAction SilentlyContinue) {
    try {
      $out = & py -3.10 -c "import sys; print(sys.version_info[:2])" 2>$null
      if ($LASTEXITCODE -eq 0) { return @{ exe = "py"; args = @("-3.10") } }
    } catch {}
    try {
      $out = & py -3.11 -c "import sys; print(sys.version_info[:2])" 2>$null
      if ($LASTEXITCODE -eq 0) { return @{ exe = "py"; args = @("-3.11") } }
    } catch {}
    try {
      $out = & py -3.12 -c "import sys; print(sys.version_info[:2])" 2>$null
      if ($LASTEXITCODE -eq 0) { return @{ exe = "py"; args = @("-3.12") } }
    } catch {}
  }
  if (Get-Command python -ErrorAction SilentlyContinue) {
    return @{ exe = "python"; args = @() }
  }
  throw "Python 3.10+ not found"
}

$pyInfo = Find-Python
$py = $pyInfo.exe
$pyArgs = $pyInfo.args

Write-Host "[llama-install] creating venv..."
Write-Host "[llama-install] progress: 15"
if ($py -eq "py") {
  & py @pyArgs -m venv .venv
} else {
  & python -m venv .venv
}

$venvPy = Join-Path $InstallDir ".venv\Scripts\python.exe"
if (-not (Test-Path $venvPy)) { throw "venv creation failed" }

$pipIndex = "https://pypi.tuna.tsinghua.edu.cn/simple"
$pipHost = "pypi.tuna.tsinghua.edu.cn"
Write-Host "[llama-install] pip install requirements..."
Write-Host "[llama-install] progress: 25"
& $venvPy -m pip install --upgrade pip -i $pipIndex --trusted-host $pipHost
Write-Host "[llama-install] progress: 40"
& $venvPy -m pip install -r requirements.txt -i $pipIndex --trusted-host $pipHost
Write-Host "[llama-install] progress: 55"

# Read llama.cpp release from manifest
$manifest = Get-Content manifest.json -Raw | ConvertFrom-Json
$release = if ($manifest.llamaRelease) { $manifest.llamaRelease } else { "b10566" }

$binDir = Join-Path $InstallDir "bin"
New-Item -ItemType Directory -Force -Path $binDir | Out-Null

$cudaVariants = @("cuda-12.4", "cuda-13.3")
$zipPath = Join-Path $env:TEMP "llama-$release-bin.zip"
$downloaded = $false

# GitHub 直连失败时自动回退 ghproxy 镜像（国内网络）
function Invoke-Download {
  param([string]$Url, [string]$Out)
  try {
    Invoke-WebRequest -Uri $Url -OutFile $Out -UseBasicParsing
    return $true
  } catch {
    Write-Host "[llama-install] direct failed ($($_.Exception.Message)); trying ghproxy mirror..."
    try {
      Invoke-WebRequest -Uri ("https://ghproxy.com/" + $Url) -OutFile $Out -UseBasicParsing
      return $true
    } catch {
      Write-Host "[llama-install] ghproxy mirror failed: $($_.Exception.Message)"
      return $false
    }
  }
}

foreach ($variant in $cudaVariants) {
  $zipName = "llama-$release-bin-win-$variant-x64.zip"
  $url = "https://github.com/ggml-org/llama.cpp/releases/download/$release/$zipName"
  Write-Host "[llama-install] downloading llama.cpp $release ($variant)..."
  Write-Host "[llama-install] progress: 65"
  if (Invoke-Download -Url $url -Out $zipPath) {
    $downloaded = $true
    break
  }
}

if (-not $downloaded) {
  Write-Host "[llama-install] CUDA builds failed, trying CPU build..."
  $zipName = "llama-$release-bin-win-cpu-x64.zip"
  $url = "https://github.com/ggml-org/llama.cpp/releases/download/$release/$zipName"
  if (-not (Invoke-Download -Url $url -Out $zipPath)) {
    throw "llama.cpp binary download failed (direct + ghproxy). 请确认网络可访问 GitHub/ghproxy 镜像。"
  }
}

Write-Host "[llama-install] extracting to bin/..."
Write-Host "[llama-install] progress: 82"
Expand-Archive -Path $zipPath -DestinationPath $binDir -Force

# Flatten if nested
Get-ChildItem $binDir -Recurse -Filter "llama-server.exe" | ForEach-Object {
  $dest = Join-Path $binDir "llama-server.exe"
  if ($_.FullName -ne $dest) {
    Copy-Item $_.FullName $dest -Force
  }
}

$server = Join-Path $binDir "llama-server.exe"
if (-not (Test-Path $server)) {
  $found = Get-ChildItem $binDir -Recurse -Filter "llama-server.exe" | Select-Object -First 1
  if ($found) { Copy-Item $found.FullName $server -Force }
}
if (-not (Test-Path $server)) { throw "llama-server.exe not found after extract" }

New-Item -ItemType Directory -Force -Path (Join-Path $InstallDir "models") | Out-Null

Write-Host "[llama-install] smoke test import..."
Write-Host "[llama-install] progress: 92"
& $venvPy -m pip uninstall -y uvloop 2>$null | Out-Null
& $venvPy -c "import fastapi; from app import server; print('ok')"
if ($LASTEXITCODE -ne 0) { throw "smoke import failed" }

New-Item -ItemType File -Force -Path (Join-Path $InstallDir ".install-ok") | Out-Null
Write-Host "[llama-install] progress: 100"
Write-Host "[llama-install] done"
exit 0
