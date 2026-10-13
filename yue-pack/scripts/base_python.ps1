# =============================================================================
# MTNode pack shared helper: base Python acquisition + GPU / driver preflight.
#
# SINGLE SOURCE OF TRUTH -- this file lives at pack-python/base_python.ps1 and every
# Python pack (h3-pack / music3-pack / yue-pack, ...) ships a BYTE-IDENTICAL copy at
# scripts/base_python.ps1. Same convention as pack-steps/step.ps1 (step protocol) and
# pack-shims/sitecustomize.py (silent shim); a smoke test hashes the copies.
# It is copied into the user's install directory together with the other scripts, so
# it MUST be standalone: no repo path, no cn-mirrors.js, no sibling file.
#
# WHY THIS FILE EXISTS (the bug it fixes):
#   h3-pack/scripts/setup_env.ps1 used to require a Python that ALREADY had
#   torch.cuda.is_available() == True before it would create the isolated venv --
#   but installing CUDA torch into that venv is exactly what the script is for.
#   On a fresh Windows machine (no conda, python.org / Microsoft Store Python on PATH,
#   no torch) every candidate failed and the script threw
#       "Need a Python with CUDA torch. Pass -CudaPython <path> or set MT_H3_CUDA_PYTHON."
#   before torch was ever installed. The prerequisite chain was broken, not the GPU.
#   Now the gate is the INTERPRETER VERSION (torch 2.9.1+cu130 wheels are cp311 / cp312 /
#   cp313), and when nothing usable exists we fetch one ourselves:
#       py launcher -> PATH python -> common conda envs -> uv -> python-build-standalone
#
# PURITY RULE: this file must stay PURE ASCII and BOM-less. install.ps1 scripts run
# under Windows PowerShell 5.1, which decodes a BOM-less .ps1 with the machine ANSI code
# page (cp936 on Chinese Windows); non-ASCII bytes become mojibake and a trailing byte
# can swallow the next `}` / quote, so the parser dies before anything runs. All
# human-readable (Chinese) text lives in each pack's steps.json `messages` table and in
# the host-side plugin-error-repair.js -- never here.
#
# CONTRACT
#   Input parameters ........ -WantedCsv -CacheRoot -ExplicitPython -Module -GpuRequired -SkipGpuProbe -Quiet
#   Exit code ............... 0 = the requested job succeeded, 1 = it did not
#   stdout .................. exactly one key=value line per finding (never localized JSON):
#                               STATUS=ok|fail
#                               PYTHON=<absolute path>        VERSION=<x.y.z>
#                               SOURCE=explicit|env|cuda-marker|conda|path|uv|standalone
#                               GPU=<name>  DRIVER=<full version>  DRIVER_MAJOR=<n>  VRAM_MB=<n>
#                               FAILCODE=<stable pack error code>
#                               REASON=<one short ASCII line>
#   Pack callers render the Chinese reason/advice from FAILCODE via their steps.json.
#
# Stable FAILCODE vocabulary (pack prefixes it, e.g. h3.python.missing / yue2.gpu.none):
#   python.missing        no usable interpreter and every fetch route failed
#   python.fetch_failed   a fetch route was found but the download / install failed
#   python.too_old        an explicit interpreter is older than the wanted versions
#   python.too_new        an explicit interpreter is newer than the wanted versions
#   gpu.none              nvidia-smi is missing / reports no NVIDIA GPU
#   gpu.driver_old        NVIDIA driver major version is below -MinDriverMajor
# =============================================================================
[CmdletBinding()]
param(
    # Interpreter versions we accept as a venv base, best first (torch cu130 wheels: cp311/312/313).
    # Passed as ONE comma-separated string ("3.11,3.12") because the pack hosts start this file
    # with `powershell -File`, where PowerShell binds array parameters positionally: writing
    # `-Wanted 3.11 3.12 -Module h3` hands "3.12" to the NEXT parameter instead of -Wanted
    # (real bug: -CacheRoot received "3.12" and a relative cache dir appeared in the app folder).
    [string]$WantedCsv = "3.11,3.12",
    # Where fetched interpreters are cached. Empty = %APPDATA%\pipeline-console\python
    # (shared by every plugin; user data never lives in the app folder).
    [string]$CacheRoot = "",
    # Explicit interpreter from -CudaPython / <PACK>_CUDA_PYTHON. Kept for backwards
    # NB: the parameter is NOT called -Explicit -- under `powershell -File` a parameter with
    # that exact name bound to an empty string (measured on PS 5.1) while every other
    # parameter bound fine, so the user-passed interpreter was silently ignored.
    # compatibility: a working path always wins, and it is reported as SOURCE=explicit.
    [string]$ExplicitPython = "",
    # Pack name, used to read MT_<PACK>_CUDA_PYTHON / MT_<PACK>_PYTHON env overrides and
    # as the FAILCODE prefix (h3 / music3 / yue2).
    [string]$Module = "",
    # GPU policy: auto (report only) / require (fail when there is no NVIDIA card) / skip.
    [ValidateSet("auto", "require", "skip")]
    [string]$GpuRequired = "auto",
    # -GpuRequired require knob: minimum NVIDIA driver major version (CUDA 13.0 needs >= 580).
    [int]$MinDriverMajor = 580,
    # Probe the GPU but do NOT fail on it (the missing-GPU FAILCODE is still emitted when
    # -GpuRequired require, so the caller can decide between a hard failure and -Cpu).
    [switch]$NoGpuFail,
    # Only run the GPU / driver preflight (no interpreter work). Prints the same lines.
    [switch]$SkipGpuProbe,
    # Print only the key=value lines (the caller wraps them with its own banner).
    [switch]$Quiet
)

$script:PyFailCode = ""
$script:PyReason = ""

# Force UTF-8 for this process so the host (which decodes our stdout as UTF-8) and every native
# tool we spawn (python / uv / curl / tar) agree on one encoding. Same lines as the pack scripts:
# without them a Chinese Windows console hands back ANSI bytes and the caller's key=value parse
# silently misses lines.
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
$OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$env:PYTHONIOENCODING = 'utf-8'

# "3.11,3.12" / "3.11;3.12" / "3.11 3.12" -> @("3.11","3.12"); keep the caller's order
$Wanted = @(@($WantedCsv -split '[,; ]+') | ForEach-Object { "$_".Trim() } | Where-Object { $_ })
if (-not $Wanted.Count) { $Wanted = @("3.11", "3.12") }

function Write-BaseLog { param([string]$Msg) if (-not $Quiet) { Write-Host "[base-python] $Msg" } }
function Write-BaseKey { param([string]$Key, [string]$Value) Write-Host "$Key=$Value" }

function Get-Code {
    param([string]$Name)
    if ($Module) { return "$Module.$Name" }
    return $Name
}

function Exit-BaseFail {
    param([string]$Code, [string]$Reason)
    Write-BaseKey "STATUS" "fail"
    Write-BaseKey "FAILCODE" (Get-Code $Code)
    if ($Reason) { Write-BaseKey "REASON" $Reason }
    exit 1
}

function Invoke-Quiet {
    # NB: the parameter must NOT be called $Args -- that name is PowerShell's automatic
    # argument array and splatting it silently duplicated every argument (real symptom:
    # nvidia-smi answered with an error string and tar.exe complained about missing flags).
    param([string]$Exe, [string[]]$ArgList)
    $prev = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $out = @(& $Exe @ArgList 2>&1)
        $code = $LASTEXITCODE
    } catch {
        $out = @("$($_.Exception.Message)")
        $code = 1
    } finally {
        $ErrorActionPreference = $prev
    }
    return @{ Code = $code; Out = $out; Text = (@($out | ForEach-Object { "$_" }) -join " / ").Trim() }
}

# Version of an interpreter, or "" when it cannot even run `import sys`.
# Deliberately does NOT look at torch: the version is what decides wheel availability,
# and torch is installed into the isolated venv afterwards.
function Get-PyVersion {
    param([string]$Exe, [string[]]$Pre = @())
    if (-not $Exe) { return "" }
    $r = Invoke-Quiet $Exe ($Pre + @("-c", "import sys;print('%d.%d.%d' % sys.version_info[:3])"))
    if ($r.Code -ne 0) { return "" }
    $v = ""
    foreach ($line in @($r.Out)) {
        $s = "$line".Trim()
        if ($s -match '^\d+\.\d+\.\d+$') { $v = $s }
    }
    return $v
}

# ------------------------------------------------------------------ 1. GPU / driver preflight
# Runs first on purpose: without an NVIDIA card there is no point downloading ~50MB of Python
# and ~3GB of torch, and the failure used to surface much later as a confusing venv error.
# By default this only REPORTS (the caller decides); -GpuRequired require turns it into a failure.
function Invoke-GpuPreflight {
    # Offline test override: MTNODE_FAKE_NO_GPU=1 answers exactly like a machine whose
    # nvidia-smi is missing (test/smoke-install-scripts.js uses it to prove the "no card"
    # path without needing a GPU-less box).
    if ($env:MTNODE_FAKE_NO_GPU -eq "1") {
        Write-BaseKey "GPU-NONE" "nvidia-smi not found (MTNODE_FAKE_NO_GPU=1)"
        if ($GpuRequired -eq "require" -and -not $NoGpuFail) { Exit-BaseFail "gpu.none" "MTNODE_FAKE_NO_GPU=1" }
        if ($GpuRequired -eq "require") { Write-BaseKey "FAILCODE" (Get-Code "gpu.none"); Write-BaseKey "REASON" "MTNODE_FAKE_NO_GPU=1" }
        return
    }
    $smi = Get-Command nvidia-smi -ErrorAction SilentlyContinue
    if (-not $smi) {
        Write-BaseKey "GPU-NONE" "nvidia-smi not found"
        if ($GpuRequired -eq "require" -and -not $NoGpuFail) { Exit-BaseFail "gpu.none" "nvidia-smi not found on PATH" }
        if ($GpuRequired -eq "require") { Write-BaseKey "FAILCODE" (Get-Code "gpu.none"); Write-BaseKey "REASON" "nvidia-smi not found on PATH" }
        return
    }
    $line = ""
    $r = Invoke-Quiet "nvidia-smi" @("--query-gpu=name,driver_version,memory.total", "--format=csv,noheader")
    # A broken driver can answer with something that is not a GPU row at all (real case: a
    # localized date string). Only accept a row whose third field is a VRAM size, otherwise
    # report gpu.none instead of inventing a GPU name out of the noise.
    foreach ($l in @($r.Out)) {
        $s = "$l".Trim()
        if ($s -match ',.*,\s*\d+\s*MiB\s*$') { $line = $s; break }
    }
    if (-not "$line".Trim()) {
        Write-BaseKey "GPU-NONE" "nvidia-smi reported no GPU"
        if ($GpuRequired -eq "require" -and -not $NoGpuFail) { Exit-BaseFail "gpu.none" "nvidia-smi reported no GPU" }
        if ($GpuRequired -eq "require") { Write-BaseKey "FAILCODE" (Get-Code "gpu.none"); Write-BaseKey "REASON" "nvidia-smi reported no GPU" }
        return
    }
    $parts = "$line".Trim() -split ','
    $name = if ($parts.Count -ge 1) { "$($parts[0])".Trim() } else { "unknown" }
    $drv = if ($parts.Count -ge 2) { "$($parts[1])".Trim() } else { "" }
    $vram = 0
    if ($parts.Count -ge 3) { try { $vram = [int](("$($parts[2])" -replace '[^0-9]', '')) } catch { $vram = 0 } }
    $major = 0
    if ($drv) { try { $major = [int](($drv -split '\.')[0]) } catch { $major = 0 } }
    Write-BaseKey "GPU" $name
    Write-BaseKey "DRIVER" $drv
    Write-BaseKey "DRIVER_MAJOR" "$major"
    Write-BaseKey "VRAM_MB" "$vram"
    if ($major -gt 0 -and $major -lt $MinDriverMajor) {
        Write-BaseLog "driver $drv (major $major) is below $MinDriverMajor (CUDA 13.0 cu130 wheels will not run)"
        if ($GpuRequired -eq "require" -and -not $NoGpuFail) { Exit-BaseFail "gpu.driver_old" "driver major $major < $MinDriverMajor" }
        if ($GpuRequired -eq "require") { Write-BaseKey "FAILCODE" (Get-Code "gpu.driver_old"); Write-BaseKey "REASON" "driver major $major < $MinDriverMajor" }
    }
}

# The probe always runs (even in -SkipGpuProbe mode, where it is the whole job). By default it
# only reports; -GpuRequired require turns a missing card / too-old driver into exit 1.
Invoke-GpuPreflight

# -SkipGpuProbe is the host-side preflight mode: report the GPU and stop (exit 0) so the
# caller can render its own step row and decide how to react.
if ($SkipGpuProbe) {
    Write-BaseKey "STATUS" "ok"
    exit 0
}

function Test-WantedVersion {
    param([string]$Version, [string[]]$Wanted)
    if (-not $Version) { return $false }
    $parts = $Version -split '\.'
    if ($parts.Count -lt 2) { return $false }
    $minor = "$($parts[0]).$($parts[1])"
    foreach ($w in $Wanted) { if ("$w".Trim() -eq $minor) { return $true } }
    return $false
}

function Resolve-Candidate {
    param([string]$Candidate, [string]$Version = "")
    if (-not $Candidate) { return $null }
    if (Test-Path -LiteralPath $Candidate) {
        $item = Get-Item -LiteralPath $Candidate -ErrorAction SilentlyContinue
        if ($item -and -not $item.PSIsContainer) { return $item.FullName }
    }
    if ($Candidate -match '[\\/]') { return $null }
    $cmd = Get-Command $Candidate -ErrorAction SilentlyContinue
    if ($cmd -and $cmd.Source -and (Test-Path -LiteralPath $cmd.Source)) { return $cmd.Source }
    if ($Version -and (Get-Command py -ErrorAction SilentlyContinue)) {
        $r = Invoke-Quiet "py" @("-$Version", "-c", "import sys;print(sys.executable)")
        if ($r.Code -eq 0) {
            $exe = (($r.Out | Where-Object { "$_".Trim() } | Select-Object -Last 1) -as [string])
            if ($exe) { $exe = $exe.Trim() }
            if ($exe -and (Test-Path -LiteralPath $exe)) { return $exe }
        }
    }
    return $null
}

# ------------------------------------------------------------------ 1. explicit override
# A user-provided interpreter always wins (and is validated by version, not by torch).
# Diagnostics on purpose: when an override exists but is not used, the log must say so --
# "the path I passed in was silently ignored" is exactly the shape of the bug this file fixes.
$explicit = @()
foreach ($e in @($ExplicitPython, $env:MT_CUDA_PYTHON)) {
    if (-not $e) { continue }
    $s = "$e".Trim()
    if (-not $s) { continue }
    Write-BaseLog "override from -ExplicitPython / MT_CUDA_PYTHON: $s"
    $explicit += $s
}
if ($Module) {
    foreach ($n in @("MT_" + $Module.ToUpperInvariant() + "_CUDA_PYTHON", "MT_" + $Module.ToUpperInvariant() + "_PYTHON")) {
        # NB: [Environment]::GetEnvironmentVariable() returns $null for an unset name; guard on
        # $null (not just on the trimmed string) so a set-but-empty variable can never push an
        # empty entry into the list.
        $v = [Environment]::GetEnvironmentVariable($n)
        if (-not $v) { continue }
        $s = "$v".Trim()
        if (-not $s) { continue }
        # NB: "${n}" needs the braces -- "$n: ..." is read as a drive/scope reference and the
        # script dies with "Variable reference is not valid. ':' was not followed by a valid
        # variable name character" (the real cause of the silently ignored override).
        Write-BaseLog "override from ${n}: $s"
        $explicit += $s
    }
}
# Legacy marker written by the previous installer versions (kept as a hint only; the
# version gate still applies).
if ($Module) {
    foreach ($mrk in @((Join-Path (Get-Location).Path ".cuda-python"), (Join-Path (Split-Path -Parent $PSScriptRoot) ".cuda-python"))) {
        if (Test-Path -LiteralPath $mrk) {
            $first = (Get-Content -LiteralPath $mrk -Encoding UTF8 -ErrorAction SilentlyContinue | Select-Object -First 1)
            if (-not $first) { continue }
            $s = "$first".Trim()
            if (-not $s) { continue }
            Write-BaseLog "override from the .cuda-python marker ($mrk): $s"
            $explicit += $s
        }
    }
}

foreach ($raw in $explicit) {
    if (-not "$raw".Trim()) { continue }
    $exe = Resolve-Candidate $raw
    if (-not $exe) {
        Write-BaseLog "explicit interpreter not found: $raw (ignored)"
        continue
    }
    $ver = Get-PyVersion $exe
    if (-not $ver) {
        Write-BaseLog "explicit interpreter cannot run: $exe (ignored)"
        continue
    }
    if (-not (Test-WantedVersion $ver $Wanted)) {
        Write-BaseLog "explicit interpreter $exe is Python $ver, not one of $($Wanted -join ' / ') -- refusing it"
        $parts = $ver -split '\.'
        $minor = [double]("$($parts[0]).$($parts[1])")
        $lowest = 99.0
        foreach ($w in $Wanted) { $x = 0.0; if ([double]::TryParse("$w", [ref]$x)) { if ($x -lt $lowest) { $lowest = $x } } }
        if ($minor -lt $lowest) { Exit-BaseFail "python.too_old" "$exe is Python $ver" }
        Exit-BaseFail "python.too_new" "$exe is Python $ver"
    }
    Write-BaseLog "using the explicit interpreter: $exe (Python $ver)"
    Write-BaseKey "STATUS" "ok"
    Write-BaseKey "PYTHON" $exe
    Write-BaseKey "VERSION" $ver
    Write-BaseKey "SOURCE" "explicit"
    exit 0
}

# ------------------------------------------------------------------ 2. local interpreters
$local = @()
$condaRoots = @(
    "C:\ProgramData\miniconda3",
    "C:\ProgramData\anaconda3",
    (Join-Path $env:USERPROFILE "miniconda3"),
    (Join-Path $env:USERPROFILE "anaconda3"),
    (Join-Path $env:LOCALAPPDATA "miniconda3"),
    (Join-Path $env:LOCALAPPDATA "anaconda3")
)
foreach ($root in $condaRoots) {
    foreach ($name in @("seg", "torch", "pytorch", "cuda", "base")) {
        $local += @{ exe = (Join-Path $root "envs\$name\python.exe"); src = "conda" }
    }
    $local += @{ exe = (Join-Path $root "python.exe"); src = "conda" }
}
foreach ($w in $Wanted) { $local += @{ exe = "py"; ver = "$w"; src = "path" } }
$local += @{ exe = "python"; src = "path" }
$local += @{ exe = "python3"; src = "path" }

$seen = @{}
foreach ($cand in $local) {
    $exe = Resolve-Candidate $cand.exe $cand.ver
    if (-not $exe) { continue }
    $k = $exe.ToLowerInvariant()
    # one interpreter is probed once, even when several candidate spellings resolve to it
    if ($seen.ContainsKey($k)) { continue }
    $seen[$k] = $true
    $ver = Get-PyVersion $exe
    if (-not $ver) {
        Write-BaseLog "skip (not runnable): $exe"
        continue
    }
    if (-not (Test-WantedVersion $ver $Wanted)) {
        Write-BaseLog "skip (Python $ver, wanted $($Wanted -join ' / ')): $exe"
        continue
    }
    Write-BaseLog "using the local interpreter: $exe (Python $ver)"
    Write-BaseKey "STATUS" "ok"
    Write-BaseKey "PYTHON" $exe
    Write-BaseKey "VERSION" $ver
    Write-BaseKey "SOURCE" $cand.src
    exit 0
}

# ------------------------------------------------------------------ 3. fetch one ourselves
if (-not $CacheRoot -or -not $CacheRoot.Trim()) {
    $base = $env:APPDATA
    if (-not $base) { $base = $env:USERPROFILE }
    if (-not $base) { $base = $env:LOCALAPPDATA }
    if (-not $base) { $base = [System.IO.Path]::GetTempPath() }
    $CacheRoot = Join-Path $base "pipeline-console\python"
    Write-BaseLog "CacheRoot not given; using $CacheRoot"
} else {
    $CacheRoot = $CacheRoot.Trim()
}
# Hard guard: the cache must never resolve to a relative path (a relative one would be
# created inside whatever directory the installer happens to run in -- and if that is the
# application folder, user data lands in the app dir, which the product forbids).
# A bare version-looking value is refused too: powershell -File binds array parameters
# positionally, so a caller that writes `-Wanted 3.11 3.12 -Module h3` can hand "3.12" to
# the NEXT parameter instead of adding it to -Wanted (real bug, caught by this guard).
if ((-not [System.IO.Path]::IsPathRooted($CacheRoot)) -or ($CacheRoot -match '^\d+(\.\d+)+$')) {
    $bad = $CacheRoot
    $base = $env:APPDATA
    if (-not $base) { $base = $env:USERPROFILE }
    if (-not $base) { $base = [System.IO.Path]::GetTempPath() }
    $CacheRoot = Join-Path $base "pipeline-console\python"
    Write-BaseLog "refused a relative / version-like CacheRoot ('$bad'); using $CacheRoot"
}
Write-BaseLog "cache: $CacheRoot"
try { New-Item -ItemType Directory -Force -Path $CacheRoot | Out-Null } catch { }

function Get-ExecutableFromDir {
    param([string]$Dir, [int]$Depth = 0)
    if (-not $Dir -or -not (Test-Path -LiteralPath $Dir)) { return "" }
    $direct = Join-Path $Dir "python.exe"
    if (Test-Path -LiteralPath $direct) { return (Get-Item -LiteralPath $direct).FullName }
    if ($Depth -ge 3) { return "" }
    $subs = @(Get-ChildItem -LiteralPath $Dir -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending)
    foreach ($d in $subs) {
        $found = Get-ExecutableFromDir $d.FullName ($Depth + 1)
        if ($found) { return $found }
    }
    return ""
}

$uv = Get-Command uv -ErrorAction SilentlyContinue
$fetchSources = @()
if ($uv) { $fetchSources += "uv" }
$fetchSources += "standalone"
$fetchErr = ""
$attempted = $false

foreach ($route in $fetchSources) {
    foreach ($w in $Wanted) {
        $ver = "$w".Trim()
        if (-not $ver) { continue }
        # per attempt: a failure recorded here must not stop the next version / route
        $fetchErr = ""
        if ($route -eq "uv") {
            $uvRoot = Join-Path $CacheRoot "uv"
            try { New-Item -ItemType Directory -Force -Path $uvRoot | Out-Null } catch { }
            Write-BaseLog "uv python install $ver (cache $uvRoot)"
            $attempted = $true
            $r = Invoke-Quiet "uv" @("python", "install", $ver, "--install-dir", $uvRoot)
            if ($r.Code -ne 0) {
                $fetchErr = "uv python install $ver failed: " + $r.Text
                Write-BaseLog $fetchErr
                continue
            }
            $exe = Get-ExecutableFromDir $uvRoot
            if (-not $exe) {
                $r2 = Invoke-Quiet "uv" @("python", "find", $ver, "--python-dir", $uvRoot)
                if ($r2.Code -eq 0) {
                    $line = (($r2.Out | Where-Object { "$_".Trim() }) | Select-Object -Last 1)
                    if ("$line".Trim() -and (Test-Path -LiteralPath "$line".Trim())) { $exe = "$line".Trim() }
                }
            }
            if (-not $exe) {
                $fetchErr = "uv python install $ver produced no python.exe under $uvRoot"
                Write-BaseLog $fetchErr
                continue
            }
            $got = Get-PyVersion $exe
            if (-not (Test-WantedVersion $got $Wanted)) {
                $fetchErr = "uv interpreter is Python $got (wanted $($Wanted -join ' / '))"
                Write-BaseLog $fetchErr
                continue
            }
            Write-BaseLog "using the uv-managed interpreter: $exe (Python $got)"
            Write-BaseKey "STATUS" "ok"
            Write-BaseKey "PYTHON" $exe
            Write-BaseKey "VERSION" $got
            Write-BaseKey "SOURCE" "uv"
            exit 0
        }

        # python-build-standalone from the npmmirror binary mirror (the same source
        # cn-mirrors.js hands to uv as UV_PYTHON_INSTALL_MIRROR).
        $dest = Join-Path $CacheRoot ("standalone\" + $ver)
        $exe = Get-ExecutableFromDir $dest
        if ($exe) {
            $got = Get-PyVersion $exe
            if (Test-WantedVersion $got $Wanted) {
                Write-BaseLog "using the cached standalone interpreter: $exe (Python $got)"
                Write-BaseKey "STATUS" "ok"
                Write-BaseKey "PYTHON" $exe
                Write-BaseKey "VERSION" $got
                Write-BaseKey "SOURCE" "standalone"
                exit 0
            }
            $exe = ""
        }
        $mirror = "https://registry.npmmirror.com/-/binary/python-build-standalone"
        Write-BaseLog "no local Python $ver; downloading python-build-standalone from npmmirror"
        $attempted = $true
        # The mirror serves a directory listing as JSON: newest date first, then any asset
        # whose name carries the requested version and is an x86_64 Windows install_only archive.
        $listing = ""
        $dirs = @()
        try {
            $resp = Invoke-WebRequest -UseBasicParsing -TimeoutSec 30 -Uri "$mirror/" -Headers @{ "User-Agent" = "mtnode" }
            $listing = [string]$resp.Content
            $dirs = @([regex]::Matches($listing, '"name":"(\d{8})/"') | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Descending | Select-Object -Unique)
        } catch {
            $fetchErr = "cannot list $mirror : $($_.Exception.Message)"
            Write-BaseLog $fetchErr
        }
        $asset = ""
        foreach ($d in $dirs | Select-Object -First 6) {
            try {
                $resp2 = Invoke-WebRequest -UseBasicParsing -TimeoutSec 30 -Uri "$mirror/$d/" -Headers @{ "User-Agent" = "mtnode" }
                $names = @([regex]::Matches([string]$resp2.Content, '"name":"([^"]+)"') | ForEach-Object { $_.Groups[1].Value })
                $hit = @($names | Where-Object { $_ -match ("^cpython-" + [regex]::Escape($ver) + "\.") -and $_ -match "x86_64-pc-windows-msvc" -and $_ -match "install_only(\.tar\.gz|_stripped\.tar\.gz)$" } | Sort-Object -Descending)
                if ($hit.Count -gt 0) {
                    $asset = "$mirror/$d/$($hit[0])"
                    break
                }
            } catch {
                Write-BaseLog "listing $d failed: $($_.Exception.Message)"
            }
        }
        if (-not $asset) {
            if (-not $fetchErr) { $fetchErr = "no python-build-standalone asset for $ver on npmmirror" }
            Write-BaseLog $fetchErr
            continue
        }
        $tmp = Join-Path $env:TEMP ("mtnode-python-" + $ver + "-" + [Guid]::NewGuid().ToString("N").Substring(0, 8) + ".tar.gz")
        $ok = $false
        $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
        if ($curl) {
            Write-BaseLog "downloading $asset"
            $r = Invoke-Quiet "curl.exe" @("-L", "--fail", "--retry", "3", "--connect-timeout", "20", "-o", $tmp, $asset)
            if ($r.Code -eq 0 -and (Test-Path -LiteralPath $tmp)) { $ok = $true } else { $fetchErr = "curl failed: " + $r.Text }
        }
        if (-not $ok) {
            try {
                Invoke-WebRequest -UseBasicParsing -TimeoutSec 600 -Uri $asset -OutFile $tmp -Headers @{ "User-Agent" = "mtnode" }
                $ok = $true
            } catch {
                $fetchErr = "download failed: $($_.Exception.Message)"
            }
        }
        if (-not $ok) {
            Write-BaseLog $fetchErr
            continue
        }
        $sizeMb = 0
        try { $sizeMb = [math]::Round((Get-Item -LiteralPath $tmp).Length / 1MB, 1) } catch { $sizeMb = -1 }
        Write-BaseLog "extracting into $dest (archive $sizeMb MB)"
        try { New-Item -ItemType Directory -Force -Path $dest | Out-Null } catch { }
        $tar = Get-Command tar.exe -ErrorAction SilentlyContinue
        if ($tar) {
            $r = Invoke-Quiet "tar.exe" @("-xzf", $tmp, "-C", $dest)
            if ($r.Code -ne 0) { $fetchErr = "tar extraction failed (archive $sizeMb MB, exit $($r.Code)): " + $r.Text }
        } else {
            $fetchErr = "tar.exe is not available (Windows 10 1803+ ships it)"
        }
        Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
        $exe = Get-ExecutableFromDir $dest
        if (-not $exe) {
            if (-not $fetchErr) { $fetchErr = "extraction produced no python.exe under $dest" }
            Write-BaseLog $fetchErr
            continue
        }
        $got = Get-PyVersion $exe
        if (-not (Test-WantedVersion $got $Wanted)) {
            $fetchErr = "fetched interpreter is Python $got (wanted $($Wanted -join ' / '))"
            Write-BaseLog $fetchErr
            continue
        }
        Write-BaseLog "using the downloaded interpreter: $exe (Python $got)"
        Write-BaseKey "STATUS" "ok"
        Write-BaseKey "PYTHON" $exe
        Write-BaseKey "VERSION" $got
        Write-BaseKey "SOURCE" "standalone"
        exit 0
    }
}

if (-not $fetchErr) { $fetchErr = "no usable Python $($Wanted -join ' / ') and no fetch route succeeded" }
# A recipe that actually ran and failed is reported separately from "no recipe at all":
# the way out differs (network / disk vs. install a Python yourself).
if ($attempted) { Exit-BaseFail "python.fetch_failed" $fetchErr }
Exit-BaseFail "python.missing" $fetchErr
