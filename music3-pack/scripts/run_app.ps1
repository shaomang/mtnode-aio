$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Py = Join-Path $Root ".venv\Scripts\python.exe"
if (-not (Test-Path $Py)) {
    throw "Missing .venv. Run: .\scripts\setup_env.ps1"
}
if (-not $env:HF_ENDPOINT) { $env:HF_ENDPOINT = "https://hf-mirror.com" }
$env:HF_HUB_DISABLE_XET = "1"
Set-Location $Root
& $Py -m app.ui @args
