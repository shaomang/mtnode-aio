# MTNode local-backend plugins: shared torch wheel fetch library (dot-sourced by each
# *-pack/scripts/install.ps1).
#
# Why it exists (measured on this machine):
#   * `pip install torch==2.9.1+cu128 --index-url <CN mirror>` ran at only 1.5-3.9 MB/s here:
#     15-20 minutes for a 1.8GB torch wheel and close to 40 minutes for the 3.46GB one, while
#     curl pulling the very same file from the very same mirror does 76 MB/s (1.8GB in 23s).
#     The difference comes from pip's HTTP stack and metadata round trips, not from the mirror.
#   * What the user sees in the install window is "stuck for tens of minutes at the CUDA torch
#     step", which easily reads as a broken install.
#   * On top of that: installing three plugins (yue2 / breeze / sensenova) downloads the same
#     1.8-3.5GB wheel once per plugin.
#
# The two functions here do:
#   1. `Get-MTNodeTorchWheel`: curl -L --retry -C - (resume support) downloads wheels from the
#      CN mirrors into the **shared cache** `<plugin root>\_weights\wheels` and skips files that
#      are already there (reused across plugins, so a reinstall downloads nothing);
#   2. `Install-MTNodeTorchWheels`: tries the cu tiers in order with a local
#      `pip install --no-index`, and only counts as success when the installed build really is
#      the CUDA one (returns $true/$false); on failure the reason stays in the log.
#
# Usage (inside each pack's install.ps1):
#   . (Join-Path (Split-Path -Parent $PSScriptRoot) "scripts\mtnode-torch-wheel.ps1")
#   ... or use the copy shipped with the pack (path built from its own $PSScriptRoot)
#   if (Install-MTNodeTorchWheels -Python $venvPy -InstallDir $InstallDir -Tiers @("cu128","cu126") -TorchMinor "2.9.1") { ... }
#
# Convention: only win_amd64 + cp310 wheels are fetched (this plugin chain uses the ABI3
# compatible wheels of Python 3.10/3.11; a cp311 torch wheel is not interchangeable with a cp310
# one, so the tag comes from the $PyTag parameter, default cp310).
#
# NOTE: this file is an install script fragment, so it must stay pure ASCII (every byte <= 0x7F,
# no BOM): PowerShell 5.1 decodes a BOM-less .ps1 with the machine ANSI code page, and non-ASCII
# bytes break the parser. See AGENTS.md and docs/mirror-sources.md section 9.

function Get-MTNodeWheelCache {
  param([Parameter(Mandatory = $true)][string]$InstallDir)
  # The shared cache lives under the "plugin root" (next to the per-plugin install dirs), so
  # deleting or reinstalling a plugin never loses the wheels already downloaded.
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
    # Per-package version numbers: torch 2.8.0 pairs with torchvision 0.23.0 (NOT 2.8.0), so one
    # $TorchMinor cannot be reused for every package (that produced a 404 for
    # torchvision-2.8.0 when tried).
    [hashtable]$Versions = @{},
    [int]$MinMB = 4                                      # below this size the file counts as truncated (and is re-downloaded); torchvision / small wheels are only a few MB, so keep the bar low
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
        # -C - resumes: a network hiccup only fetches the missing part instead of starting over
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
