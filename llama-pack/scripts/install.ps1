param(
  [string]$InstallDir = (Split-Path -Parent $MyInvocation.MyCommand.Path | Split-Path -Parent)
)

# Force UTF-8 for this process so the host (which decodes our stdout as UTF-8)
# and every native tool we spawn (pip / git / python) agree on one encoding.
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
$OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$env:PYTHONIOENCODING = 'utf-8'

$ErrorActionPreference = "Stop"

# -- CN mirrors (single source of truth: repo root cn-mirrors.js; see docs/mirror-sources.md) --
# A machine-wide pip.ini often carries an unreachable extra-index-url (NVIDIA PyIndex's
# pypi.ngc.nvidia.com is the usual one). Passing --index-url on the command line does NOT
# override extra-index-url, so every package wastes 5 retries. Setting the three PIP_*
# variables below overrides index / extra-index / trusted-host inside this process and every
# child (pip / git / npm inherit them). Do NOT add `pip --isolated`: it ignores environment
# variables, which lets that unreachable extra-index back in.
$env:PIP_INDEX_URL       = if ($env:MTNODE_PIP_INDEX) { $env:MTNODE_PIP_INDEX } else { "https://pypi.tuna.tsinghua.edu.cn/simple" }
$env:PIP_EXTRA_INDEX_URL = $env:PIP_INDEX_URL
$env:PIP_TRUSTED_HOST    = "pypi.tuna.tsinghua.edu.cn"
if (-not $env:HF_ENDPOINT)         { $env:HF_ENDPOINT = "https://hf-mirror.com" }
if (-not $env:HF_HUB_DISABLE_XET)  { $env:HF_HUB_DISABLE_XET = "1" }
if (-not $env:npm_config_registry) { $env:npm_config_registry = "https://registry.npmmirror.com" }
# GitHub proxy prefix chain (single source of truth: repo root cn-mirrors.js -> ghProxyList()): the host
# passes it in MTNODE_GH_PROXIES (comma / semicolon / space separated), so the order is configurable
# there instead of being copied into this script. No env at all (hand-run script) -> the four built-in
# proxies below, then a direct github.com attempt.
$ghProxies = @()
if ($env:MTNODE_GH_PROXIES) {
  $ghProxies = @($env:MTNODE_GH_PROXIES -split '[,;\s]+' | Where-Object { $_.Trim() } | ForEach-Object { $_.Trim().TrimEnd('/') })
}
if ($ghProxies.Count -eq 0) {
  $ghProxies = @("https://ghfast.top", "https://gh-proxy.com", "https://ghproxy.net", "https://ghproxy.com")
}
Write-Host "[llama-install] mirrors: pip=$env:PIP_INDEX_URL (fallback aliyun / USTC -> official) | weights=ModelScope -> $env:HF_ENDPOINT | npm=$env:npm_config_registry"
Write-Host "[llama-install] gh proxies: $($ghProxies -join ' / ') -> direct github.com"

Set-Location $InstallDir

# Step protocol (the install window lists its steps / locates the failing step from it): the single
# source is scripts/step.ps1 in this pack
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

Write-Host "[llama-install] ============================================================"
Write-Host "[llama-install] About the China mirrors (required; especially important when this machine is on a mainland China network):"
Write-Host "[llama-install]   - Python packages: use the Tsinghua mirror pypi.tuna.tsinghua.edu.cn (or the CAS USTC mirror mirrors.ustc.edu.cn)"
Write-Host "[llama-install]   - llama.cpp binaries come from GitHub Releases, which may not be reachable directly from mainland China: we retry through the gh proxy chain printed above first (MTNODE_GH_PROXIES), direct github.com last"
Write-Host "[llama-install]   - Model GGUF files: huggingface.co cannot be reached directly, so we go through hf-mirror.com (override with HF_ENDPOINT)"
Write-Host "[llama-install] ============================================================"
Write-Host "[llama-install] install dir: $InstallDir"
Write-Host "[llama-install] progress: 8"

# WHY Invoke-Quiet EXISTS (a real failure seen on a user machine): any native tool (pip / python /
# node / nvidia-smi / git / npm) that writes ONE line to stderr -- even a harmless
# "WARNING: Skipping uvloop as it is not installed." -- becomes a TERMINATING error under this
# script's $ErrorActionPreference = "Stop" on Windows PowerShell 5.1. The installer died right
# there; the user saw "exit 1 at the smoke step" with nothing but a warning as the last log line.
# So everywhere we do not care about stderr (nor need the native exit code) we go through
# Invoke-Quiet: it temporarily restores ErrorActionPreference to Continue and sends the child's
# stderr to $null. (Do NOT use "2>&1 | Out-Null" instead: PowerShell still forwards those error
# records to its own stderr and the host, which only drains stdout, blocks on a full pipe.)
function Invoke-Quiet {
  param([string]$Exe, [string[]]$Args, [switch]$PassThru)
  $prev = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    if ($PassThru) { return (& $Exe @Args 2>$null) }
    & $Exe @Args 2>$null | Out-Null
  } finally { $ErrorActionPreference = $prev }
}

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

Step-Begin "python" "" 3
$pyInfo = Find-Python
$py = $pyInfo.exe
$pyArgs = $pyInfo.args
Write-Host "[llama-install] python: $py $($pyArgs -join ' ')"
Step-Ok "python" 8

Write-Host "[llama-install] creating venv..."
Write-Host "[llama-install] progress: 15"
Step-Begin "venv" "" 10
if ($py -eq "py") {
  & py @pyArgs -m venv .venv
} else {
  & python -m venv .venv
}

$venvPy = Join-Path $InstallDir ".venv\Scripts\python.exe"
if (-not (Test-Path $venvPy)) {
  Step-Fail "venv" "venv creation failed ($venvPy does not exist). Make sure the disk is writable and the Python install is complete (venv module included), then rerun."
  throw "venv creation failed"
}
Step-Ok "venv" 15

$pipIndex = $env:PIP_INDEX_URL
$pipHost = $env:PIP_TRUSTED_HOST
Write-Host "[llama-install] pip install requirements..."
Write-Host "[llama-install] progress: 25"
Step-Begin "pip" "" 18
& $venvPy -m pip install --upgrade pip -i $pipIndex --trusted-host $pipHost
Write-Host "[llama-install] progress: 40"
& $venvPy -m pip install -r requirements.txt -i $pipIndex --trusted-host $pipHost
if ($LASTEXITCODE -ne 0) {
  Step-Fail "pip" "pip install -r requirements.txt failed (exit code $LASTEXITCODE). It is usually a mirror / network hiccup: make sure pypi.tuna.tsinghua.edu.cn is reachable and rerun; packages already installed are not fetched again."
  throw "pip install failed"
}
Write-Host "[llama-install] progress: 55"
Step-Ok "pip" 40

# Read llama.cpp release from manifest
#
# WHY -Encoding UTF8 (a real failure: "ConvertFrom-Json : ArgumentException, Invalid object passed in"):
# PowerShell 5.1's Get-Content without -Encoding reads a text file with the system ANSI code page, and
# this file has no BOM -- on a zh-CN machine (CP936) non-ASCII bytes get decoded as GBK garbage, the
# string can lose its closing quote, and ConvertFrom-Json throws System.ArgumentException:
# "Invalid object passed in, ':' or '}' expected.".
# Two independent guards, both wanted: manifest.json is now pure ASCII (non-ASCII text lives in
# steps.json, which only Node reads -- see test/smoke-install-scripts.js [14]), AND we read it
# explicitly as UTF-8 here (works with and without a BOM). Either one alone would already fix it;
# together, no code page on earth can break this line.
$manifest = Get-Content manifest.json -Raw -Encoding UTF8 | ConvertFrom-Json
$release = if ($manifest.llamaRelease) { $manifest.llamaRelease } else { "b10566" }

$binDir = Join-Path $InstallDir "bin"
New-Item -ItemType Directory -Force -Path $binDir | Out-Null

# Download state (.part + chunk files) lives under bin\.download\, NOT in %TEMP%: the bytes a previous
# run already pulled must survive, so a rerun continues instead of starting from zero.
$dlDir = Join-Path $binDir ".download"
New-Item -ItemType Directory -Force -Path $dlDir | Out-Null
$dlChunkBytes = 8388608
$dlParallel = 7
$script:dlExpectedBytes = 0

$cudaVariants = @("cuda-12.4", "cuda-13.3")
$zipPath = Join-Path $dlDir "llama-$release-bin.zip"
$downloaded = $false

# GitHub releases: the China gh proxy chain ($ghProxies, order from the host / MTNODE_GH_PROXIES)
# plus the direct github.com URL (mainland China networks)
#
# WHY THE MIRROR LIST IS [string[]] AND COMPUTED IN A LOOP (a real failure: "the llama.cpp binary will
# not download"): `$urls = @("https://a/" + `$Url, ...)` is NOT an array on Windows PowerShell 5.1 --
# when an array literal contains a "+" expression, PowerShell glues the whole thing into ONE
# space-joined string, so `foreach (`$u in `$urls)` runs once with all five URLs concatenated and
# Invoke-WebRequest answers 404 (that is the "remote server returned (404) not found" line in the log).
# Declare the chain as [string[]], append one computed element at a time.
#
# --- layer shape (why it is not one stream any more) -----------------------------------------
# Seen on a user machine: ghfast.top answered 403 on every request and ghproxy.com hung until the
# 20s timeout, and both sat in FRONT of the mirrors that did work -- a fixed order pays that cost on
# every run. And when a single stream died half way through the 169 MB zip, the rerun started at
# byte 0 again, and a TRUNCATED zip was unzipped as if it were whole (that is where a 9 KB
# llama-server.exe came from). Hence:
#   1) Get-MirrorRank probes every mirror with a 256 KB range GET (2s cap), drops 403 / unreachable /
#      HTML-error-page answers and orders the survivors by measured speed;
#   2) Invoke-ChunkedDownload splits the archive into 8 MB ranges and pulls 7 at a time with curl.exe;
#      without curl.exe it falls back to the old single-stream Invoke-DownloadOnce;
#   3) both paths resume: .part + chunk files live in <InstallDir>\bin\.download\ and are never wiped
#      at startup, so a rerun continues from the bytes on disk (chunk-level breakpoints);
#   4) nothing is extracted before bytes == Content-Length (gate right before Expand-Archive).
# Every ~8 MB one line is printed ("downloaded X/Y MB | Z KB/s | eta Ns"); it is also the heartbeat
# the host's stall watchdog listens to.
#
# WHY HttpWebRequest AND NOT Invoke-WebRequest (a real failure: the install HUNG FOREVER):
# `Invoke-WebRequest` has NO timeout by default (-TimeoutSec 0 = infinite), so the script sat inside
# one Read() forever -- no stdout, no exit code, nothing to look at in the install window, and the
# host (which only learns "the script ended" from the child exiting) stayed busy forever (every later
# Retry answered `busy`). Every request below carries an explicit Timeout + ReadWriteTimeout.
function Get-CurlPath {
  $c = Get-Command curl.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($c) { return $c.Source }
  $sys = Join-Path $env:SystemRoot "System32\curl.exe"
  if (Test-Path $sys) { return $sys }
  return $null
}

function Test-ZipMagic {
  param([string]$Path)
  if (-not (Test-Path $Path)) { return $false }
  try {
    $fs = [System.IO.File]::OpenRead($Path)
    try {
      $b = New-Object byte[] 2
      $n = $fs.Read($b, 0, 2)
      return ($n -eq 2 -and $b[0] -eq 0x50 -and $b[1] -eq 0x4B)
    } finally { $fs.Dispose() }
  } catch { return $false }
}

function Write-DlProgress {
  param([int64]$Done, [int64]$Total, [double]$Seconds)
  $mb = [int]($Done / 1MB)
  $totMb = [int]($Total / 1MB)
  $kbps = 0
  if ($Seconds -gt 0.2) { $kbps = [int]($Done / 1024 / $Seconds) }
  $eta = 0
  if ($kbps -gt 0 -and $Total -gt $Done) { $eta = [int](($Total - $Done) / 1024 / $kbps) }
  Write-Host "[llama-install]   downloaded $mb/$totMb MB | $kbps KB/s | eta ${eta}s"
}

# One Range bytes=0-0 GET: tells us the real Content-Length and whether ranges work at all.
function Get-RemoteInfo {
  param([string]$Url)
  $req = $null
  $resp = $null
  try {
    $req = [System.Net.HttpWebRequest]::Create($Url)
    $req.UserAgent = "mtnode-llama-install"
    $req.Timeout = 20000
    $req.ReadWriteTimeout = 20000
    $req.AddRange([int64]0, [int64]0)
    $resp = $req.GetResponse()
    $code = [int]$resp.StatusCode
    $total = [int64](-1)
    $ranges = $false
    $cr = $resp.Headers["Content-Range"]
    if ($cr -and ($cr -match "/(\d+)\s*$")) { $total = [int64]$Matches[1] }
    if ($code -eq 206 -and $total -gt 0) { $ranges = $true }
    elseif ($code -eq 200 -and $resp.ContentLength -gt 0) {
      $total = [int64]$resp.ContentLength
      $ar = $resp.Headers["Accept-Ranges"]
      if ($ar -and $ar.ToLower().IndexOf("bytes") -ge 0) { $ranges = $true }
    }
    return [pscustomobject]@{ total = $total; ranges = $ranges; code = $code }
  } catch {
    return $null
  } finally {
    if ($resp) { $resp.Dispose() }
  }
}

# Probe every candidate, drop the dead ones (403 / timeout / HTML error page) and order the rest by
# measured throughput. Returning the configured order when nothing survives keeps a bad network from
# turning into "no download at all".
function Get-MirrorRank {
  param([string[]]$Candidates, [int]$ProbeBytes = 262144, [int]$ProbeMs = 2000)
  $rows = New-Object System.Collections.ArrayList
  foreach ($u in $Candidates) {
    $name = $u
    try { $name = ([System.Uri]$u).Host } catch { }
    $req = $null
    $resp = $null
    $stream = $null
    $keep = $false
    $kbps = 0
    try {
      $req = [System.Net.HttpWebRequest]::Create($u)
      $req.UserAgent = "mtnode-llama-install"
      $req.Timeout = $ProbeMs
      $req.ReadWriteTimeout = $ProbeMs
      $req.AddRange([int64]0, [int64]($ProbeBytes - 1))
      $sw = [System.Diagnostics.Stopwatch]::StartNew()
      $resp = $req.GetResponse()
      $code = [int]$resp.StatusCode
      $stream = $resp.GetResponseStream()
      $buf = New-Object byte[] 65536
      $got = [int64]0
      $magic = ""
      while ($got -lt $ProbeBytes -and $sw.ElapsedMilliseconds -lt $ProbeMs) {
        $n = $stream.Read($buf, 0, $buf.Length)
        if ($n -le 0) { break }
        if ($got -eq 0 -and $n -ge 2) { $magic = [string]([char]$buf[0]) + [string]([char]$buf[1]) }
        $got += $n
      }
      $sec = $sw.Elapsed.TotalSeconds
      if ($sec -lt 0.001) { $sec = 0.001 }
      $kbps = [int]($got / 1024 / $sec)
      if ($code -ne 200 -and $code -ne 206) {
        Write-Host "[llama-install]   probe $name -> HTTP $code, dropped"
      } elseif ($magic -ne "PK") {
        Write-Host "[llama-install]   probe $name -> HTTP $code but the body is not a zip (proxy error page), dropped"
      } elseif ($got -lt 32768) {
        Write-Host "[llama-install]   probe $name -> only $got bytes in $([int]$sw.ElapsedMilliseconds) ms, dropped"
      } else {
        Write-Host "[llama-install]   probe $name -> HTTP $code, $([int]($got / 1024)) KB in $([int]$sw.ElapsedMilliseconds) ms, $kbps KB/s"
        $keep = $true
      }
    } catch {
      $msg = $_.Exception.Message
      if ($msg.Length -gt 140) { $msg = $msg.Substring(0, 140) }
      Write-Host "[llama-install]   probe $name -> failed ($msg), dropped"
    } finally {
      if ($stream) { $stream.Dispose() }
      if ($resp) { $resp.Dispose() }
    }
    if ($keep) { [void]$rows.Add([pscustomobject]@{ url = $u; speed = $kbps }) }
  }
  if ($rows.Count -eq 0) {
    Write-Host "[llama-install]   no mirror passed the speed probe; falling back to the configured order"
    return $Candidates
  }
  $sorted = $rows | Sort-Object -Property speed -Descending
  [string[]]$ordered = @()
  [string[]]$shown = @()
  foreach ($r in $sorted) {
    $ordered += $r.url
    $shown += (([System.Uri]$r.url).Host + " (" + $r.speed + " KB/s)")
  }
  Write-Host "[llama-install]   mirror order: $($shown -join ' -> ')"
  return $ordered
}
function Invoke-DownloadOnce {
  param([string]$Url, [string]$Out, [int64]$StartAt = 0, [int64]$Total = 0)
  $req = [System.Net.HttpWebRequest]::Create($Url)
  $req.UserAgent = "mtnode-llama-install"
  $req.Timeout = 20000
  $req.ReadWriteTimeout = 60000
  # Resume: ask for the rest of the file (an explicit end offset -- AddRange has no open-ended form)
  if ($StartAt -gt 0 -and $Total -gt $StartAt) { $req.AddRange($StartAt, ($Total - 1)) }
  $resp = $null
  $inStream = $null
  $outStream = $null
  try {
    $resp = $req.GetResponse()
    $inStream = $resp.GetResponseStream()
    $mode = [System.IO.FileMode]::Create
    if ($StartAt -gt 0) { $mode = [System.IO.FileMode]::Append }
    $outStream = New-Object System.IO.FileStream($Out, $mode, [System.IO.FileAccess]::Write)
    $buf = New-Object byte[] 262144
    $done = $StartAt
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $nextReport = $StartAt + 8388608
    while ($true) {
      $n = $inStream.Read($buf, 0, $buf.Length)
      if ($n -le 0) { break }
      $outStream.Write($buf, 0, $n)
      $done += $n
      if ($done -ge $nextReport) {
        if ($Total -gt 0) { Write-DlProgress -Done $done -Total $Total -Seconds $sw.Elapsed.TotalSeconds }
        else { Write-Host "[llama-install]   downloaded $([int]($done / 1MB)) MB" }
        $nextReport = $done + 8388608
      }
    }
    return $done
  } finally {
    if ($outStream) { $outStream.Dispose() }
    if ($inStream) { $inStream.Dispose() }
    if ($resp) { $resp.Dispose() }
  }
}

# Range-chunked download: 8 MB pieces, $Parallel curl.exe processes in flight, pieces kept in
# <bin>\.download\<zip>.chunks\ so a rerun only fetches the missing ones. The .part file holds the
# final archive: everything below the last complete chunk boundary is reused as the prefix, the rest
# is stitched from the chunk files in order.
function Invoke-ChunkedDownload {
  param([string]$Url, [int64]$Total, [string]$PartPath, [string]$ChunkDir, [string]$Curl,
        [int64]$ChunkBytes = 8388608, [int]$Parallel = 7)
  New-Item -ItemType Directory -Force -Path $ChunkDir | Out-Null
  # Chunk manifest: which archive / chunk size the pieces in this folder belong to. A mismatch means
  # the leftover pieces are from another release and must not be reused.
  $manifest = Join-Path $ChunkDir "manifest.json"
  if (Test-Path $manifest) {
    $same = $false
    try {
      $m = Get-Content $manifest -Raw -Encoding UTF8 | ConvertFrom-Json
      if (([int64]$m.total -eq $Total) -and ([int64]$m.chunk -eq $ChunkBytes)) { $same = $true }
    } catch { }
    if (-not $same) {
      Write-Host "[llama-install]   chunk manifest belongs to another archive; discarding the old pieces"
      Get-ChildItem $ChunkDir -Filter "part-*.bin" -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
    }
  }
  $prefix = [int64]0
  if (Test-Path $PartPath) { $prefix = (Get-Item $PartPath).Length }
  if ($prefix -gt $Total) {
    Remove-Item $PartPath -Force -ErrorAction SilentlyContinue
    $prefix = 0
  }
  $base = [int64]([math]::Floor([double]$prefix / [double]$ChunkBytes)) * $ChunkBytes
  if ($base -gt 0) { Write-Host "[llama-install]   resume: keeping $([int]($base / 1MB)) MB already in the .part file" }
  $count = [int][math]::Ceiling([double]$Total / [double]$ChunkBytes)
  try {
    Set-Content -Path $manifest -Value ('{"total":' + $Total + ',"chunk":' + $ChunkBytes + ',"count":' + $count + ',"url":"' + $Url + '"}') -Encoding ascii -Force
  } catch { }
  # WHY TWO LISTS (a real defect, found by running the interrupted-resume case on a real machine):
  #   "complete chunk files on disk" and "bytes already inside the .part prefix" are two different
  #   things. After a kill mid-download there are finished part-NNNNN.bin files but NO .part at all,
  #   so $base is 0 -- yet the complete chunks used to be dropped from the stitch list and therefore
  #   never written into the .part. The assembled file came out short AND misaligned
  #   ("assembled 175465528 of 250963000 bytes" on a real run), which then degenerated into the
  #   single-stream fallback and pulled the archive again from that wrong offset.
  #   So: $pieces = every chunk from $base on, in order (with or without bytes) -> that is what gets
  #   stitched; $fetch = only the missing ones -> that is what curl pulls.
  #   test/smoke-llama-download.js [6] pins it (complete chunks + no .part must still stitch exact).
  $pieces = New-Object System.Collections.ArrayList
  $fetch = New-Object System.Collections.ArrayList
  $reuse = [int64]0
  for ($i = 0; $i -lt $count; $i++) {
    $start = [int64]$i * $ChunkBytes
    if ($start -lt $base) { continue }
    $size = [int64][math]::Min([double]$ChunkBytes, [double]($Total - $start))
    $cp = Join-Path $ChunkDir ("part-{0:d5}.bin" -f $i)
    $have = $false
    if (Test-Path $cp) {
      if ((Get-Item $cp).Length -eq $size) { $have = $true }
      else { Remove-Item $cp -Force -ErrorAction SilentlyContinue }
    }
    $piece = [pscustomobject]@{ start = $start; size = $size; path = $cp; have = $have }
    [void]$pieces.Add($piece)
    if ($have) { $reuse += $size } else { [void]$fetch.Add($piece) }
  }
  if ($reuse -gt 0) { Write-Host "[llama-install]   resume: reusing $([int]($reuse / 1MB)) MB of chunks already on disk (no refetch)" }
  if ($fetch.Count -eq 0) { Write-Host "[llama-install]   every chunk is already on disk" }
  else { Write-Host "[llama-install]   $($fetch.Count) chunk(s) to fetch, up to $Parallel in parallel" }

  $workers = New-Object System.Collections.ArrayList
  $idx = 0
  $failed = $false
  $swAll = [System.Diagnostics.Stopwatch]::StartNew()
  $lastDone = [int64](-1)
  $lastMove = [System.Diagnostics.Stopwatch]::StartNew()
  $nextReport = [int64]$base + [int64]$reuse + $ChunkBytes
  while ((($idx -lt $fetch.Count) -or ($workers.Count -gt 0)) -and (-not $failed)) {
    while (($workers.Count -lt $Parallel) -and ($idx -lt $fetch.Count) -and (-not $failed)) {
      $item = $fetch[$idx]
      $tag = "{0:d5}" -f $idx
      $idx++
      $outFile = Join-Path $ChunkDir ("curl-" + $tag + ".out")
      $errFile = Join-Path $ChunkDir ("curl-" + $tag + ".err")
      $range = "$($item.start)-$($item.start + $item.size - 1)"
      $argStr = '-sS -L --fail --connect-timeout 20 --max-time 900 --max-filesize ' + [string]($item.size + 65536) + ' -r ' + $range + ' -o "' + $item.path + '" "' + $Url + '"'
      try {
        $p = Start-Process -FilePath $Curl -ArgumentList $argStr -NoNewWindow -PassThru -RedirectStandardOutput $outFile -RedirectStandardError $errFile
        [void]$workers.Add([pscustomobject]@{ proc = $p; item = $item; err = $errFile; out = $outFile })
      } catch {
        Write-Host "[llama-install]   could not start curl ($($_.Exception.Message))"
        $failed = $true
      }
    }
    Start-Sleep -Milliseconds 700
    $alive = New-Object System.Collections.ArrayList
    foreach ($w in $workers) {
      if (-not $w.proc.HasExited) { [void]$alive.Add($w); continue }
      # WHY THE NULL GUARD (measured on Windows PowerShell 5.1): Start-Process -PassThru does NOT
      # populate .ExitCode once the child exits -- it is ALWAYS $null, so "($code -ne 0)" was true for
      # every finished chunk, each one was deleted, and the parallel path silently fell back to a
      # single stream on every run (no 8 MB x 7 parallelism at all). The byte count below is the real
      # gate: curl --fail writes nothing on 4xx and an interrupted transfer leaves a short file.
      # test/smoke-llama-download.js [1] pins that chunks are actually stitched, not retried as one stream.
      $code = $w.proc.ExitCode
      if ($null -eq $code) { $code = 0 }
      $got = [int64]0
      if (Test-Path $w.item.path) { $got = (Get-Item $w.item.path).Length }
      if (($code -ne 0) -or ($got -ne $w.item.size)) {
        $msg = ""
        if (Test-Path $w.err) { $msg = (Get-Content $w.err -Raw -Encoding UTF8 -ErrorAction SilentlyContinue) }
        if ($msg) { $msg = ($msg -replace "\s+", " ").Trim() }
        Write-Host "[llama-install]   chunk at $([int]($w.item.start / 1MB)) MB failed (curl exit $code, $got/$($w.item.size) bytes): $msg"
        if (Test-Path $w.item.path) { Remove-Item $w.item.path -Force -ErrorAction SilentlyContinue }
        $failed = $true
      }
      Remove-Item $w.err, $w.out -Force -ErrorAction SilentlyContinue
    }
    $workers = $alive
    $done = [int64]$base
    foreach ($item in $pieces) {
      if ($item.have) { $done += $item.size; continue }
      if (Test-Path $item.path) {
        $sz = (Get-Item $item.path).Length
        if ($sz -gt $item.size) { $sz = $item.size }
        $done += $sz
      }
    }
    if ($done -ge $nextReport) {
      Write-DlProgress -Done $done -Total $Total -Seconds $swAll.Elapsed.TotalSeconds
      $nextReport = [int64]$done + $ChunkBytes
    }
    if ($done -gt $lastDone) {
      $lastDone = $done
      $lastMove.Restart()
    } elseif ($lastMove.Elapsed.TotalSeconds -gt 60) {
      Write-Host "[llama-install]   no data moved for 60s; abandoning this mirror"
      $failed = $true
    }
  }

  if ($failed) {
    foreach ($w in $workers) {
      try { if (-not $w.proc.HasExited) { $w.proc.Kill() } } catch { }
      Remove-Item $w.item.path, $w.err, $w.out -Force -ErrorAction SilentlyContinue
    }
    return $false
  }
  foreach ($item in $pieces) {
    if (-not (Test-Path $item.path)) { return $false }
    if ((Get-Item $item.path).Length -ne $item.size) { return $false }
  }

  Write-Host "[llama-install]   stitching $([int]($Total / 1MB)) MB from chunks..."
  $fs = $null
  try {
    $fs = New-Object System.IO.FileStream($PartPath, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite)
    $fs.SetLength($base)
    $fs.Seek($base, [System.IO.SeekOrigin]::Begin) | Out-Null
    $buf = New-Object byte[] 1048576
    foreach ($item in $pieces) {
      $in = [System.IO.File]::OpenRead($item.path)
      try {
        while ($true) {
          $n = $in.Read($buf, 0, $buf.Length)
          if ($n -le 0) { break }
          $fs.Write($buf, 0, $n)
        }
      } finally { $in.Dispose() }
    }
  } catch {
    Write-Host "[llama-install]   stitching failed ($($_.Exception.Message))"
    return $false
  } finally {
    if ($fs) { $fs.Dispose() }
  }

  $final = [int64](Get-Item $PartPath).Length
  if ($final -ne $Total) {
    Write-Host "[llama-install]   assembled $final of $Total bytes; keeping the pieces for the next attempt"
    return $false
  }
  foreach ($item in $pieces) { Remove-Item $item.path -Force -ErrorAction SilentlyContinue }
  return $true
}

function Invoke-Download {
  param([string]$Url, [string]$Out)
  $part = $Out + ".part"
  $chunkDir = $Out + ".chunks"
  $curl = Get-CurlPath
  if ($curl) { Write-Host "[llama-install] download mode: parallel ranges, $dlParallel connections, $([int]($dlChunkBytes / 1MB)) MB chunks" }
  else { Write-Host "[llama-install] curl.exe not found: single-stream download (still resumable)" }

  # First run after an older build: adopt the half finished zip that build left in %TEMP% instead of
  # throwing 169 MB away. It is moved (so it can only be adopted once) and only trusted as a prefix;
  # the final size check below still decides whether the archive is usable.
  if (-not (Test-Path $part)) {
    $legacy = Join-Path $env:TEMP ("llama-" + $release + "-bin.zip")
    if ((Test-Path $legacy) -and ((Get-Item $legacy).Length -gt 1048576)) {
      try {
        Move-Item -Path $legacy -Destination $part -Force
        Write-Host "[llama-install]   adopted the partial zip left in %TEMP% ($([int]((Get-Item $part).Length / 1MB)) MB), continuing from there"
      } catch { }
    }
  }
  if ((Test-Path $part) -and (-not (Test-ZipMagic -Path $part))) {
    Write-Host "[llama-install]   the bytes already on disk are not a zip (an error page was saved once); discarding them"
    Remove-Item $part -Force -ErrorAction SilentlyContinue
  }
  if (Test-Path $part) {
    Write-Host "[llama-install]   resume: $([int]((Get-Item $part).Length / 1MB)) MB already downloaded"
  }

  # Proxy prefixes come from $ghProxies (see the mirror block: MTNODE_GH_PROXIES from cn-mirrors.js);
  # the direct github.com URL is always a candidate. Then rank them by measured speed.
  [string[]]$candidates = @()
  foreach ($p in $ghProxies) { $candidates += ($p.TrimEnd('/') + "/" + $Url) }
  $candidates += $Url
  $urls = Get-MirrorRank -Candidates $candidates

  foreach ($u in $urls) {
    for ($attempt = 1; $attempt -le 2; $attempt++) {
      $info = Get-RemoteInfo -Url $u
      if ((-not $info) -or ($info.total -le 0)) {
        Write-Host "[llama-install] ${u}: no usable Content-Length; skipping this mirror"
        break
      }
      $total = $info.total
      if (Test-Path $part) {
        $have = [int64](Get-Item $part).Length
        if ($have -eq $total) {
          if (Test-ZipMagic -Path $part) {
            Move-Item -Path $part -Destination $Out -Force
            $script:dlExpectedBytes = $total
            Write-Host "[llama-install] downloaded $([int]($total / 1MB)) MB (already complete) -> $Out"
            return $true
          }
          Remove-Item $part -Force -ErrorAction SilentlyContinue
        } elseif ($have -gt $total) {
          Write-Host "[llama-install]   the partial file is larger than the release ($have > $total); starting over"
          Remove-Item $part -Force -ErrorAction SilentlyContinue
        }
      }
      $ok = $false
      if ($info.ranges -and $curl) {
        $ok = Invoke-ChunkedDownload -Url $u -Total $total -PartPath $part -ChunkDir $chunkDir -Curl $curl -ChunkBytes $dlChunkBytes -Parallel $dlParallel
        # A proxy may advertise ranges and then ignore them: one failed chunked attempt must not
        # cost the mirror, so the same URL is retried as a plain stream.
        if (-not $ok) { Write-Host "[llama-install]   parallel ranges did not work on this mirror; retrying it as a single stream" }
      }
      if (-not $ok) {
        $start = [int64]0
        if (Test-Path $part) { $start = [int64](Get-Item $part).Length }
        if ($start -ge $total) { $start = [int64]0 }
        try {
          $bytes = Invoke-DownloadOnce -Url $u -Out $part -StartAt $start -Total $total
          $ok = ($bytes -eq $total)
          if (-not $ok) { Write-Host "[llama-install]   stopped at $([int]($bytes / 1MB))/$([int]($total / 1MB)) MB; the next attempt resumes" }
        } catch {
          Write-Host "[llama-install]   $u failed ($($_.Exception.Message)); trying the next mirror..."
          break
        }
      }
      if ($ok) {
        # Never hand a non-zip / short archive on to Expand-Archive.
        if (-not (Test-ZipMagic -Path $part)) {
          Write-Host "[llama-install]   the finished archive is not a zip; discarding and trying the next mirror"
          Remove-Item $part -Force -ErrorAction SilentlyContinue
          break
        }
        Move-Item -Path $part -Destination $Out -Force
        Remove-Item $chunkDir -Recurse -Force -ErrorAction SilentlyContinue
        $script:dlExpectedBytes = $total
        Write-Host "[llama-install] downloaded $([int]((Get-Item $Out).Length / 1MB)) MB -> $Out"
        return $true
      }
    }
  }
  return $false
}

# Already installed (a previous run got the binary, or the user dropped it in by hand): never
# re-download a 100 MB+ zip just to reach the remaining steps -- that is also what makes the
# retry path after a network failure cheap.
$server = Join-Path $binDir "llama-server.exe"
if (Test-Path $server) {
  Write-Host "[llama-install] llama-server.exe already in bin\, skipping download"
  Step-Skip "server" "llama-server.exe already present"
} else {
  foreach ($variant in $cudaVariants) {
    $zipName = "llama-$release-bin-win-$variant-x64.zip"
    $url = "https://github.com/ggml-org/llama.cpp/releases/download/$release/$zipName"
    # One .part / chunk dir per variant: a half finished cuda-12.4 archive must never be resumed as
    # if it were the cuda-13.3 one.
    $zipPath = Join-Path $dlDir $zipName
    Write-Host "[llama-install] downloading llama.cpp $release ($variant)..."
    Write-Host "[llama-install] progress: 65"
    Step-Begin "server" "" 45 "release $release | $variant"
    if (Invoke-Download -Url $url -Out $zipPath) {
      $downloaded = $true
      break
    }
  }
}

# When no CUDA variant can be downloaded we DO NOT fall back to the CPU build (this round's rule:
# GPU only, a silent CPU fallback is forbidden). The CPU llama-server used to be installed here
# behind the user's back: it installs, it even "runs", but inference lands on the CPU -- the user
# believes the local model is ready while it is unusably slow, and the UI cannot tell the
# difference (a real incident). Now the install stops at this step with a fix the user can act on
# (another mirror / drop the binary in by hand / upgrade the driver).
if (-not $downloaded -and -not (Test-Path $server)) {
  Write-Host "[llama-install] error: no CUDA llama.cpp build could be downloaded (variants: $($cudaVariants -join ' / '))."
  Write-Host "[llama-install]        NOT falling back to the CPU build: this plugin must run on the GPU."
  Write-Host "[llama-install]        how to fix:"
  Write-Host "[llama-install]          1) check that GitHub or a gh proxy is reachable from this machine (tried: $($ghProxies -join ' / ') / github.com)"
  Write-Host "[llama-install]          2) or download $zipName by hand and unzip it into $binDir (llama-server.exe must end up in bin\\), then rerun"
  Write-Host "[llama-install]          3) if your driver is older than CUDA 12.4 support, upgrade the NVIDIA driver first"
  Write-Host "[llama-install]          4) or click 'Let an agent fix it' in the install window: it opens a visible session that finishes this step by the llama-local-install skill"
  Write-Host "[llama-install]        the venv and the Python dependencies already installed are kept; rerun resumes at this step."
  Step-Fail "server" "llama.cpp CUDA binary download failed (direct GitHub and the gh proxy mirrors are all unreachable). Install a CUDA build by hand into bin\ and rerun -- no CPU fallback (this backend must use the GPU)."
  throw "llama.cpp CUDA binary download failed (direct + ghproxy); CPU fallback was removed on purpose (GPU only)."
}

if ($downloaded) {
  # HARD GATE: never unzip a half downloaded archive -- that is exactly how a 9 KB llama-server.exe
  # used to appear. Invoke-Download only returns $true when bytes == Content-Length; re-check here so
  # no later edit can quietly lower that bar.
  $expect = [int64]$script:dlExpectedBytes
  $zipBytes = [int64](Get-Item $zipPath).Length
  if (($expect -gt 0) -and ($zipBytes -ne $expect)) {
    Step-Fail "server" "the downloaded archive is incomplete ($zipBytes / $expect bytes). Rerun the install: what is already in bin\.download\ is resumed, not thrown away."
    throw "downloaded archive incomplete ($zipBytes / $expect bytes)"
  }
  if (-not (Test-ZipMagic -Path $zipPath)) {
    Remove-Item $zipPath -Force -ErrorAction SilentlyContinue
    Step-Fail "server" "the downloaded archive is not a zip (a proxy error page was saved instead). Delete bin\.download\ and rerun, or download the release by hand into bin\."
    throw "downloaded archive is not a zip"
  }
  Write-Host "[llama-install] extracting to bin/ ($([int]($zipBytes / 1MB)) MB, size verified)..."
  Write-Host "[llama-install] progress: 82"
  try {
    Expand-Archive -Path $zipPath -DestinationPath $binDir -Force
  } catch {
    Remove-Item $zipPath -Force -ErrorAction SilentlyContinue
    Step-Fail "server" "Expand-Archive failed on the downloaded release ($($_.Exception.Message)). The file was removed so the next run downloads it clean."
    throw "Expand-Archive failed"
  }

  # Flatten if nested
  Get-ChildItem $binDir -Recurse -Filter "llama-server.exe" | ForEach-Object {
    $dest = Join-Path $binDir "llama-server.exe"
    if ($_.FullName -ne $dest) {
      Copy-Item $_.FullName $dest -Force
    }
  }
  Remove-Item $zipPath -Force -ErrorAction SilentlyContinue
}

if (-not (Test-Path $server)) {
  $found = Get-ChildItem $binDir -Recurse -Filter "llama-server.exe" | Select-Object -First 1
  if ($found) { Copy-Item $found.FullName $server -Force }
}
if (-not (Test-Path $server)) {
  Step-Fail "server" "llama-server.exe was not found after extracting (the release layout may have changed). Unzip that release into bin\ by hand and rerun, or pick another release."
  throw "llama-server.exe not found after extract"
}
if ($downloaded) { Step-Ok "server" 82 }

New-Item -ItemType Directory -Force -Path (Join-Path $InstallDir "models") | Out-Null

Write-Host "[llama-install] smoke test import..."
Write-Host "[llama-install] progress: 92"
Step-Begin "smoke" "" 88
# There used to be a `pip uninstall -y uvloop` line here (uvicorn[standard] pulls it on Linux and it
# cannot install on Windows). It is gone on purpose: it achieved nothing (this pack requirements
# never list uvloop) while spawning one more native child process -- and the PowerShell the host
# launches has no console, so every extra child is another chance to hang at startup (measured this
# round: the install window sat forever on the smoke step right after that line).

# Smoke import: run it INLINE (no Start-Process) -- measured at ~0.1s in a command-line context.
#
# HARD RULE (a real failure this round): this script must not write a single byte to stderr.
# The host (main-llama.js) drains stdout only and feeds it to the install window; nothing reads the
# stderr pipe, so leftover native noise (pip "WARNING: Skipping uvloop...", python "Error: [Errno
# 13] Permission denied...") fills the pipe buffer and the whole installer BLOCKS on that write --
# the user sees the install window frozen on the smoke step for tens of minutes, the last log line
# still the previous one. So every native call redirects stderr to a file (or 2>`$null plus
# Invoke-Quiet for the native exit code) and never leaves it on the inherited pipe.
$smokeOut = Join-Path $env:TEMP ("mtnode-llama-smoke-" + [guid]::NewGuid().ToString("N") + ".out")
$smokeErr = $smokeOut + ".err"
$prevEap = $ErrorActionPreference
$ErrorActionPreference = "Continue"
& $venvPy -c "import fastapi; from app import server; print('ok')" 1> $smokeOut 2> $smokeErr
$smokeCode = $LASTEXITCODE
$ErrorActionPreference = $prevEap
$smokeText = (Get-Content $smokeOut -Encoding UTF8 -ErrorAction SilentlyContinue | Out-String).Trim()
$smokeErrText = (Get-Content $smokeErr -Encoding UTF8 -ErrorAction SilentlyContinue | Out-String).Trim()
if ($smokeText) { Write-Host "[llama-install] smoke stdout: $smokeText" }
if ($smokeErrText) { Write-Host "[llama-install] smoke stderr: $smokeErrText" }
Remove-Item $smokeOut, $smokeErr -Force -ErrorAction SilentlyContinue
$LASTEXITCODE = $smokeCode
if ($LASTEXITCODE -ne 0) {
  Step-Fail "smoke" "smoke import failed: fastapi or app.server inside the venv cannot be imported (dependencies only half installed / requirements out of sync with the code). Read this step's log and rerun the install."
  throw "smoke import failed"
}
Step-Ok "smoke" 100

New-Item -ItemType File -Force -Path (Join-Path $InstallDir ".install-ok") | Out-Null
Write-Host "[llama-install] progress: 100"
Write-Host "[llama-install] done"
exit 0
