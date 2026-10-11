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
Write-Host "[tts-install] mirrors: pip=$env:PIP_INDEX_URL (fallback aliyun / USTC -> official) | weights=ModelScope -> $env:HF_ENDPOINT | npm=$env:npm_config_registry"

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
Set-Location $InstallDir

# Native commands (git / pip / python) write their normal information to stderr, and combined with
# $ErrorActionPreference = "Stop" that turns "normal output" into a fatal error that aborts the script.
# Measured on Windows PowerShell 5.1 (the powershell.exe the host uses), fresh install of this pack:
#   & git clone --depth 1 <url> <dir> 2>&1 | Out-Host
#   -> git.exe : Cloning into 'E:\...\tts\engine'... : RemoteException, NativeCommandError
#   -> the script dies on that very line: no "that clone failed, trying the next mirror", no Step-Fail,
#      the install window just sits at progress 48. The same happens to pip / python stderr.
# So every external program call goes through this wrapper: stderr is let through for the duration of
# the call (so it can be logged instead of killing us), and success is decided solely by the exit code.
# Note: the argument array must not be named $Args (a PowerShell automatic variable).
function Invoke-Native {
  param([string]$Exe, [string[]]$CmdArgs, [switch]$Quiet)
  $prev = $ErrorActionPreference
  $code = -1
  try {
    $ErrorActionPreference = "Continue"
    # After 2>&1 an external program's stderr arrives as ErrorRecord objects; one of those written
    # straight to Write-Host renders as the useless line "System.Management.Automation.RemoteException",
    # which would also hide the real error text a user needs while repairing. Unwrap to plain text.
    & $Exe @CmdArgs 2>&1 | ForEach-Object {
      $line = if ($_ -is [System.Management.Automation.ErrorRecord]) {
        if ($_.TargetObject) { [string]$_.TargetObject } else { [string]$_.Exception.Message }
      } else { [string]$_ }
      if ($line -and -not $Quiet) { Write-Host ("  " + $line) }
    }
    $code = $LASTEXITCODE
  } catch {
    Write-Host ("[tts-install] command raised: " + $_.Exception.Message)
    $code = 1
  } finally {
    $ErrorActionPreference = $prev
  }
  return $code
}

Write-Host "[tts-install] ============================================================"
Write-Host "[tts-install] About the China mirrors (required; especially important when this machine is on a mainland China network):"
Write-Host "[tts-install]   - Python packages: use the Tsinghua mirror pypi.tuna.tsinghua.edu.cn (or the CAS USTC mirror mirrors.ustc.edu.cn)"
Write-Host "[tts-install]   - huggingface.co cannot be reached directly from mainland China: pretrained weights are downloaded from ModelScope first, with an automatic fallback to hf-mirror.com"
Write-Host "[tts-install]     (set the env var TTS_MODELSCOPE_REPO to point at your own ModelScope repository; default is XXXXRT/GPT-SoVITS-Pretrained,"
Write-Host "[tts-install]      which mirrors lj1995/GPT-SoVITS under its pretrained_models/ folder)"
Write-Host "[tts-install]   - If the GitHub clone fails we automatically retry through the ghfast.top / gh-proxy.com / ghproxy.net / ghproxy.com proxies"
Write-Host "[tts-install] ============================================================"
Write-Host "[tts-install] install dir: $InstallDir"
Write-Host "[tts-install] progress: 5"

function Find-Python {
  if (Get-Command py -ErrorAction SilentlyContinue) {
    foreach ($ver in @("3.10", "3.11", "3.12")) {
      # -Quiet: a probe that misses (that interpreter version is not installed) prints a normal
      # "not found" line on stderr, which is not a failure worth showing; the exit code decides.
      $rc = Invoke-Native "py" @("-$ver", "-c", "import sys; print(sys.version_info[:2])") -Quiet
      if ($rc -eq 0) { return @{ exe = "py"; args = @("-$ver") } }
    }
  }
  if (Get-Command python -ErrorAction SilentlyContinue) {
    return @{ exe = "python"; args = @() }
  }
  throw "Python 3.10+ not found"
}

Step-Begin "python" "check Python 3.10+" 3
$pyInfo = Find-Python
$py = $pyInfo.exe
$pyArgs = $pyInfo.args
Write-Host "[tts-install] python: $py $($pyArgs -join ' ')"
Step-Ok "python" 5

Write-Host "[tts-install] creating venv..."
Write-Host "[tts-install] progress: 10"
Step-Begin "venv" "create the .venv virtual environment" 7
$venvRc = -1
if ($py -eq "py") {
  $venvRc = Invoke-Native "py" ($pyArgs + @("-m", "venv", ".venv"))
} else {
  $venvRc = Invoke-Native "python" @("-m", "venv", ".venv")
}

$venvPy = Join-Path $InstallDir ".venv\Scripts\python.exe"
if (-not (Test-Path $venvPy)) {
  Step-Fail "venv" "venv creation failed (exit code $venvRc, $venvPy does not exist). Make sure the disk is writable and the Python install is complete (venv module included), then rerun."
  throw "venv creation failed"
}
Step-Ok "venv" 10

$pipIndex = $env:PIP_INDEX_URL
$pipHost = $env:PIP_TRUSTED_HOST
Write-Host "[tts-install] pip install requirements..."
Write-Host "[tts-install] progress: 18"
Step-Begin "pip" "install the Python dependencies (Tsinghua mirror)" 12
$pipUpRc = Invoke-Native $venvPy @("-m", "pip", "install", "--upgrade", "pip", "-i", $pipIndex, "--trusted-host", $pipHost)
if ($pipUpRc -ne 0) {
  # Not fatal: the bundled pip can install requirements.txt just fine, so a hiccup here (a mirror
  # timeout) must not kill the whole install at progress 18 - say so and keep going.
  Write-Host "[tts-install] warn: upgrading pip failed (exit code $pipUpRc), continuing with the bundled pip"
}
Write-Host "[tts-install] progress: 28"
$pipReqRc = Invoke-Native $venvPy @("-m", "pip", "install", "-r", "requirements.txt", "-i", $pipIndex, "--trusted-host", $pipHost)
if ($pipReqRc -ne 0) {
  Step-Fail "pip" "pip install -r requirements.txt failed (exit code $pipReqRc). Make sure pypi.tuna.tsinghua.edu.cn is reachable and rerun; packages already installed are not fetched again."
  throw "pip install failed"
}
Write-Host "[tts-install] progress: 38"
Step-Ok "pip" 30

# ---- GPT-SoVITS engine: clone the source tree ----
$engineDir = Join-Path $InstallDir "engine"
New-Item -ItemType Directory -Force -Path $engineDir | Out-Null
$apiV2 = Join-Path $engineDir "api_v2.py"
Step-Begin "engine" "clone the GPT-SoVITS inference engine" 33
if (-not (Test-Path $apiV2)) {
  Write-Host "[tts-install] cloning GPT-SoVITS (shallow)..."
  Write-Host "[tts-install] progress: 48"
  $git = Get-Command git -ErrorAction SilentlyContinue
  if ($git) {
    # git clone: the four gh proxies first, the direct github.com URL last (mainland China networks)
    $cloneUrls = @(
      "https://ghfast.top/https://github.com/RVC-Boss/GPT-SoVITS.git",
      "https://gh-proxy.com/https://github.com/RVC-Boss/GPT-SoVITS.git",
      "https://ghproxy.net/https://github.com/RVC-Boss/GPT-SoVITS.git",
      "https://ghproxy.com/https://github.com/RVC-Boss/GPT-SoVITS.git",
      "https://github.com/RVC-Boss/GPT-SoVITS.git"
    )
    $cloneOk = $false
    foreach ($cloneUrl in $cloneUrls) {
      Write-Host "[tts-install] git clone $cloneUrl"
      # Invoke-Native (not a bare `& git clone ...`): git writes "Cloning into ..." to stderr, and under
      # $ErrorActionPreference = "Stop" that aborted the whole install right here (progress stuck at 48).
      $cloneRc = Invoke-Native "git" @("clone", "--depth", "1", $cloneUrl, $engineDir)
      if ($cloneRc -eq 0 -and (Test-Path $apiV2)) { $cloneOk = $true; break }
      Write-Host "[tts-install] that clone failed (exit code $cloneRc), trying the next mirror..."
      # A failed clone leaves a half-written engine dir behind and git then refuses a non-empty target,
      # so every retry needs an empty dir. Do not use -ErrorAction SilentlyContinue here: a delete that
      # silently fails would surface later as a bogus "destination path already exists" from git.
      Remove-Item -Recurse -Force $engineDir
      if (Test-Path $engineDir) {
        Step-Fail "engine" "could not clear the engine directory ($engineDir) after a failed clone: it is locked by another process (an editor / a running backend). Close it, then rerun."
        throw "engine dir is locked - cannot retry the clone"
      }
      New-Item -ItemType Directory -Force -Path $engineDir | Out-Null
    }
    if (-not $cloneOk) {
      Step-Fail "engine" "GPT-SoVITS clone failed: the direct GitHub URL and all four proxies (ghfast.top / gh-proxy.com / ghproxy.net / ghproxy.com) are unreachable (or git is not installed). Install git, check the network, then rerun."
      throw "GPT-SoVITS clone failed (no git or network)"
    }
  } else {
    Step-Fail "engine" "git was not found on this machine, so GPT-SoVITS cannot be cloned. Install git, make sure it is on PATH, then rerun."
    throw "git not found - cannot clone GPT-SoVITS"
  }
}
Step-Ok "engine" 45

# ---- GPT-SoVITS engine training deps (torch + engine requirements, China mirrors) ----
$engineReq = Join-Path $engineDir "requirements.txt"
if (Test-Path $engineReq) {
  Write-Host "[tts-install] installing engine training deps (torch + GPT-SoVITS requirements)..."
  Write-Host "[tts-install] progress: 50"
  Step-Begin "torch" "install CUDA torch and the training dependencies" 48
  # torch (CUDA build; tsinghua mirror only carries CPU wheels, use aliyun cu126)
  $torchRc = Invoke-Native $venvPy @("-m", "pip", "install", "torch==2.6.0", "torchaudio==2.6.0", "--index-url", "https://mirrors.aliyun.com/pytorch-wheels/cu126")
  if ($torchRc -ne 0) {
    Write-Host "[tts-install] aliyun cu126 failed, falling back to pytorch official cu126 index..."
    $torchRc = Invoke-Native $venvPy @("-m", "pip", "install", "torch==2.6.0+cu126", "torchaudio==2.6.0", "--index-url", "https://download.pytorch.org/whl/cu126")
  }
  if ($torchRc -ne 0) { Write-Host "[tts-install] warn: torch install failed (training will not work)" }
  # engine requirements minus webui/asr/onnx bloat we do not need, minus
  # '--no-binary=opencc' (would force a source build on Windows), minus
  # 'fastapi[standard]' (uvloop has no Windows wheel), plus the fixups for the two
  # packages that upstream only ships as sources.
  #
  # The drop-prefix / replacement / shim lists are NOT spelled out here any more:
  # tts-pack/reqs-fixups.json is the shared manifest, and app/train.py reads the very same file
  # when it self-heals the training deps. The two generators used to drift, and both handed pip
  # packages that can only be built from source on Windows - pyopenjtalk compiles C code (MSVC),
  # jieba_fast ships a bare tar.gz whose setup.py always compiles an extension.
  $trainReq = Join-Path $engineDir "requirements-train.txt"
  $fixupsPath = Join-Path $InstallDir "reqs-fixups.json"
  if (-not (Test-Path $fixupsPath)) {
    Step-Fail "torch" "the requirements fixup manifest is missing: $fixupsPath. Without it requirements-train.txt cannot be generated safely, because the raw engine requirements pull pyopenjtalk and jieba_fast - both exist as sources only and a Windows source build needs MSVC. Restore tts-pack/reqs-fixups.json (copy it back from the pack), then rerun."
    throw "reqs-fixups.json not found"
  }
  try {
    $fixups = Get-Content $fixupsPath -Raw -Encoding UTF8 | ConvertFrom-Json
  } catch {
    Step-Fail "torch" "could not parse the requirements fixup manifest $fixupsPath ($($_.Exception.Message)). Restore it from the pack (or repair the JSON), then rerun."
    throw "reqs-fixups.json is not valid JSON"
  }
  $dropPrefixes = @($fixups.dropPrefixes | Where-Object { "$_" -ne "" })
  $shimNames = @($fixups.shims | Where-Object { "$_" -ne "" })
  $replacementItems = @()
  if ($fixups.replacements) { $replacementItems = @($fixups.replacements.PSObject.Properties) }

  # Package name at the start of a requirement line: it ends at the first char outside
  # [A-Za-z0-9._-] (same reading rule as the manifest describes).
  function Get-ReqPackageName {
    param([string]$Line)
    $m = [regex]::Match($Line, '^[A-Za-z0-9._-]+')
    if ($m.Success) { return $m.Value }
    return ""
  }
  # The manifest matches names case-insensitively, with '-' and '_' treated as equal.
  function Get-ReqNameKey { param([string]$Name) return ($Name -replace '_', '-').ToLowerInvariant() }

  Write-Host "[tts-install] requirements fixups from $fixupsPath : $($dropPrefixes.Count) drop prefix(es), $($replacementItems.Count) replacement(s), $($shimNames.Count) local shim(s)"
  $trainLines = New-Object System.Collections.Generic.List[string]
  foreach ($rawLine in (Get-Content $engineReq)) {
    $line = "$rawLine".Trim()
    if (-not $line) { continue }
    $drop = $false
    foreach ($p in $dropPrefixes) {
      if ($line.StartsWith([string]$p, [System.StringComparison]::OrdinalIgnoreCase)) { $drop = $true; break }
    }
    if ($drop) { continue }
    $reqName = Get-ReqPackageName $line
    $nameKey = if ($reqName) { Get-ReqNameKey $reqName } else { "" }
    $matched = $null
    foreach ($item in $replacementItems) {
      if ($nameKey -and (Get-ReqNameKey $item.Name) -eq $nameKey) { $matched = $item; break }
    }
    if (-not $matched) { $trainLines.Add($line); continue }
    if ($null -eq $matched.Value) {
      # A null value = the package is provided by the local shim dir and must never reach pip.
      Write-Host "[tts-install] reqs fixup: $reqName -> local shim (tts-pack/shims/$reqName), not sent to pip"
      continue
    }
    Write-Host "[tts-install] reqs fixup: $reqName -> $($matched.Value)"
    $trainLines.Add([string]$matched.Value)
  }
  Set-Content -Encoding UTF8 -Path $trainReq -Value $trainLines.ToArray()
  # pandas + matplotlib are imported at module top level by the engine
  # (module/AR datasets, tools.my_utils) but are not listed in requirements.txt
  # x_transformers>=2.28 hard-requires torch-einops-utils / einx / loguru; list
  # them explicitly so a partial --target install can never leave the package
  # body missing (semantic phase crash).
  # onnxruntime = required for g2pw pinyin inference (the filter above drops it, so add the CPU build back here);
  # faster-whisper = required for segment-by-segment ASR transcription after long audio is auto-split.
  Add-Content -Encoding UTF8 $trainReq "pandas`nmatplotlib`ntorch-einops-utils`neinx`nloguru`nonnxruntime`nfaster-whisper"
  $trainRc = Invoke-Native $venvPy @("-m", "pip", "install", "-r", $trainReq, "-i", $pipIndex, "--trusted-host", $pipHost)
  if ($trainRc -ne 0) {
    # Two known traps behind "training deps failed", spelled out so the user does not have to guess:
    # (1) a torch / CUDA tier that does not match this machine's driver;
    # (2) a source build of pyopenjtalk / jieba_fast - both upstream packages ship sources only and
    #     compiling them on Windows needs MSVC (Build Tools). Seeing them compile means the fixup
    #     manifest was ignored or edited (they must have been replaced per tts-pack/reqs-fixups.json).
    Step-Fail "torch" "training dependency install failed (exit code $trainRc). Read this step's log: if it shows pyopenjtalk or jieba_fast being built from source, the replacement in $fixupsPath did not apply - neither package has a usable Windows wheel, both are source-only and their source build needs MSVC / Visual Studio Build Tools. Otherwise it is usually a torch / CUDA tier that does not match this machine's driver. Restore the manifest and install the matching CUDA tier, then rerun; inference-only installs can skip the training dependencies."
    throw "engine deps install failed"
  }
  Step-Ok "torch" 55
} else {
  Write-Host "[tts-install] warn: engine requirements.txt not found - skipping engine deps"
  Step-Skip "torch" "the engine repo has no requirements.txt: skipping the training dependencies"
}

$pretrained = Join-Path $engineDir "GPT_SoVITS\pretrained_models"
New-Item -ItemType Directory -Force -Path $pretrained | Out-Null
$env:HF_ENDPOINT = "https://hf-mirror.com"
$env:HF_HUB_DISABLE_XET = "1"
# The mirror repo this pack used before (repo id lj1995/GPT-SoVITS on the ModelScope side) does not
# exist there: its /models/<id> page still renders, but every api/v1/models/<id>/... call returns 404
# and the resolve download URL 404s too (measured 2026-10-11). So "ModelScope first" silently failed
# for every file and the install then died on the hf-mirror 404s. The working mirror is
# XXXXRT/GPT-SoVITS-Pretrained: it holds the same files under a "pretrained_models/" prefix, plus the
# language-detect / ASR / UVR5 extras this plugin does not need. Measured 32 MB/s from a mainland
# network for every file below.
$msRepo = if ($env:TTS_MODELSCOPE_REPO) { $env:TTS_MODELSCOPE_REPO } else { "XXXXRT/GPT-SoVITS-Pretrained" }
$msBase = "https://www.modelscope.cn/models/$msRepo/resolve/master/pretrained_models/"
$hfBase = "https://hf-mirror.com/lj1995/GPT-SoVITS/resolve/main/"
# vocab.txt is the one file the weights bundle itself does not carry: it ships tokenizer.json only,
# and AutoTokenizer falls back to the slow BertTokenizer (which hard-requires vocab.txt) as soon as
# the fast tokenizer cannot build a decoder, so the Chinese BERT needs it from the upstream hfl repo.
$hflBase = "https://hf-mirror.com/hfl/chinese-roberta-wwm-ext-large/resolve/main/"

Write-Host "[tts-install] downloading pretrained weights (ModelScope -> hf-mirror fallback)..."
Write-Host "[tts-install] progress: 58"
Step-Begin "weights" "download the pretrained weights" 58

# "hf" = path inside lj1995/GPT-SoVITS; "ms" = path inside <repo>/pretrained_models/; "hfl" = the
# upstream hfl/chinese-roberta-wwm-ext-large repo. The previous list used the engine's own relative
# path (GPT_SoVITS/pretrained_models/<file>) as the remote path - those names exist in neither repo
# (that is what produced the 404s), and s2G233k.pth was a typo for the file the bundled v1/v2 configs
# actually load. Every entry below is a file the TTS engine really opens (see app/tts.py,
# app/train.py, GPT_SoVITS/configs/tts_infer.yaml), with its size on the mirror.
$weights = @(
  # v1 GPT (s1) + v1 SoVITS (s2) - the pair the bundled tts_infer.yaml points at
  @{ out = "s1bert25hz-2kh-longer-epoch=68e-step=50232.ckpt";  must = $true;  hf = "s1bert25hz-2kh-longer-epoch=68e-step=50232.ckpt";  ms = "s1bert25hz-2kh-longer-epoch=68e-step=50232.ckpt";  hfl = "" },   # 155.1 MB
  @{ out = "s2G488k.pth";                                     must = $true;  hf = "s2G488k.pth";                                     ms = "s2G488k.pth";                                     hfl = "" },   # 106.0 MB
  # Chinese HuBERT (content encoder): config + feature-extractor config + weights
  @{ out = "chinese-hubert-base/config.json";                 must = $true;  hf = "chinese-hubert-base/config.json";                 ms = "chinese-hubert-base/config.json";                 hfl = "" },   # 1.4 kB
  @{ out = "chinese-hubert-base/preprocessor_config.json";    must = $true;  hf = "chinese-hubert-base/preprocessor_config.json";    ms = "chinese-hubert-base/preprocessor_config.json";    hfl = "" },   # 212 B - Wav2Vec2FeatureExtractor refuses to load without it
  @{ out = "chinese-hubert-base/pytorch_model.bin";           must = $true;  hf = "chinese-hubert-base/pytorch_model.bin";           ms = "chinese-hubert-base/pytorch_model.bin";           hfl = "" },   # 188.8 MB
  # Chinese RoBERTa (text frontend): config + fast-tokenizer json + weights, plus the vocab.txt that
  # transformers falls back to. tokenizer_config.json / special_tokens_map.json are optional here.
  @{ out = "chinese-roberta-wwm-ext-large/config.json";       must = $true;  hf = "chinese-roberta-wwm-ext-large/config.json";       ms = "chinese-roberta-wwm-ext-large/config.json";       hfl = "" },   # 963 B
  @{ out = "chinese-roberta-wwm-ext-large/tokenizer.json";    must = $false; hf = "chinese-roberta-wwm-ext-large/tokenizer.json";    ms = "chinese-roberta-wwm-ext-large/tokenizer.json";    hfl = "" },   # 269.0 kB
  @{ out = "chinese-roberta-wwm-ext-large/pytorch_model.bin"; must = $true;  hf = "chinese-roberta-wwm-ext-large/pytorch_model.bin"; ms = "chinese-roberta-wwm-ext-large/pytorch_model.bin"; hfl = "" },   # 651.2 MB
  @{ out = "chinese-roberta-wwm-ext-large/vocab.txt";         must = $true;  hf = "";                                                ms = "";                                                hfl = "vocab.txt" }  # 109.5 kB
)

$total = $weights.Count
$i = 0
$weightFails = @()
$weightWarns = @()
foreach ($w in $weights) {
  $i++
  $dest = Join-Path $pretrained ($w.out -replace "/", "\")
  New-Item -ItemType Directory -Force -Path (Split-Path $dest) | Out-Null
  if (Test-Path $dest) { continue }
  Write-Host "[tts-install] downloading $($w.out) ($i/$total)..."
  $pct = 58 + [int]($i / $total * 22)
  Write-Host "[tts-install] progress: $pct"
  # ModelScope first (direct + ~30 MB/s from mainland China), then hf-mirror for the same file
  # (huggingface.co itself is unreachable from mainland China). Plain HTTP, not the python hub
  # client: that one only writes under <local_dir>/<repo_id>/<file>, which left the weights in a
  # nested directory the engine never looks at, and it made a missing hub package abort the step.
  $sources = @()
  if ($w.ms)  { $sources += , @{ name = "ms-mirror"; url = ($msBase + $w.ms) } }
  if ($w.hf)  { $sources += , @{ name = "hf-mirror";  url = ($hfBase + $w.hf) } }
  if ($w.hfl) { $sources += , @{ name = "hf-hfl";     url = ($hflBase + $w.hfl) } }
  $ok = $false
  foreach ($src in $sources) {
    try {
      Invoke-WebRequest -Uri $src.url -OutFile $dest -UseBasicParsing -TimeoutSec 900
      if ((Get-Item $dest).Length -lt 16) { throw "mirror returned $((Get-Item $dest).Length) bytes" }
      Write-Host "[tts-install] $($src.name) ok: $($w.out)"
      $ok = $true
      break
    } catch {
      # Keep going: a 500 from one mirror for one file is normal (seen for the v2 SoVITS weights),
      # and the point of the next source is to cover exactly that case.
      Write-Host "[tts-install] $($src.name) failed, try next source: $($w.out) [$($_.Exception.Message)]"
      if (Test-Path $dest) { Remove-Item $dest -Force -ErrorAction SilentlyContinue }
    }
  }
  if (-not $ok) {
    if ($w.must) {
      Write-Host "[tts-install] warn: failed $($w.out) (continue)"
      $weightFails += $w.out
    } else {
      $weightWarns += $w.out
    }
  }
}

if ($weightFails.Count) {
  Step-Fail "weights" ("pretrained weight download failed: " + ($weightFails -join " / ") + ". ModelScope and hf-mirror were both tried for each file (and the tokenizer vocab.txt via hfl/chinese-roberta-wwm-ext-large): check the network, then rerun (files already downloaded are skipped).")
  throw "weights download failed: $($weightFails -join ', ')"
}
if ($weightWarns.Count) {
  Write-Host "[tts-install] note: optional files missing (the engine runs without them): $($weightWarns -join ', ')"
}
Step-Ok "weights" 80

Write-Host "[tts-install] smoke test import..."
Write-Host "[tts-install] progress: 90"
Step-Begin "smoke" "smoke: import check" 88
$null = Invoke-Native $venvPy @("-m", "pip", "uninstall", "-y", "uvloop") -Quiet
$smokeRc = Invoke-Native $venvPy @("-c", "import fastapi; from app import server, tts; print('ok')")
if ($smokeRc -ne 0) {
  Step-Fail "smoke" "smoke import failed (exit code $smokeRc): fastapi or app.server / app.tts inside the venv cannot be imported (dependencies are only half installed). Read this step's log and rerun the install."
  throw "smoke import failed"
}

# The two packages that upstream only ships as sources have to be importable NOW, not on the first
# synthesis: pyopenjtalk must have been replaced by pyopenjtalk-plus, and jieba_fast must come from
# the local shim - which is only found through PYTHONPATH (same order the api_v2 / training
# subprocesses use: tts-pack/shims first). If the manifest was ignored, edited or the shims dir is
# gone, the install fails right here with the reason instead of crashing later mid-synthesis.
$shimDir = Join-Path $InstallDir "shims"
$env:PYTHONPATH = if ("$env:PYTHONPATH" -ne "") { "$shimDir;$env:PYTHONPATH" } else { $shimDir }
Write-Host "[tts-install] smoke: import pyopenjtalk + jieba_fast (PYTHONPATH=$shimDir)"
$fixupSmokeRc = Invoke-Native $venvPy @("-c", "import pyopenjtalk, jieba_fast; print('ok')")
if ($fixupSmokeRc -ne 0) {
  Step-Fail "smoke" "smoke import failed (exit code $fixupSmokeRc): pyopenjtalk / jieba_fast cannot be imported. Both upstream packages are source-only (a Windows source build needs MSVC), so requirements-train.txt must apply tts-pack/reqs-fixups.json: pyopenjtalk -> pyopenjtalk-plus, jieba_fast -> the local shim at $shimDir (this check puts it on PYTHONPATH). Missing / edited manifest or shims directory, or an outdated requirements-train.txt - restore them, delete the generated $trainReq so it is rebuilt, then rerun."
  throw "smoke import failed (requirements fixups not effective)"
}
Step-Ok "smoke" 100

New-Item -ItemType File -Force -Path (Join-Path $InstallDir ".install-ok") | Out-Null
Write-Host "[tts-install] progress: 100"
Write-Host "[tts-install] done"
exit 0