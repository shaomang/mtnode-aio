# =============================================================================
# MTNode install step protocol (one implementation shared by every *-pack/scripts/*,
# copied verbatim into each pack as scripts/step.ps1).
#
# Why this file exists: install scripts used to print only `[xxx-install] progress: NN`,
# which the host collapsed into one progress bar -- the user could not see which step was
# running or which one failed. The install window needs a step table, per-step logs and a
# precise failure location, so it needs structured step lines. There is exactly one source
# for them; packs call it instead of writing their own.
#
# Protocol (one JSON object per stdout line, UTF-8, and the line must contain nothing else):
#   {"mtnodeStep":1,"id":"<step id>","status":"run|ok|fail|skip","pct":<0-100>,"message":"<text>"}
#   - id must match the same pack's steps.json (the install window aligns its step table by it)
#   - status="ok" may carry pct = the overall percentage when the step finished
#     (omit it and the host falls back to "step i of n")
#   - status="fail" carries a human readable `message`; it may ALSO carry a stable error code
#     plus dynamic values, and then the install window renders the localized reason and advice
#     from the same pack's steps.json `messages` table:
#       {"mtnodeStep":1,"id":"venv","status":"fail",
#        "code":"h3.venv.pip_failed","params":{"venv":"<python.exe path>","tail":"ERROR: ..."},
#        "message":"environment prep did not finish (venv still missing: ...)"}
#     `tail` is rendered with a readable prefix (English " | error tail: ", Chinese uses the
#     same separators with a localized label) and is the place for raw sub-process error lines;
#     a code the manifest does not declare falls back to the plain `message`. Why codes instead
#     of localized text: this file and every install script must stay pure ASCII (see the HARD
#     RULE below), while steps.json is JSON read as UTF-8 by Node.
#
# Step titles are NOT part of this protocol: the single source for step titles and hints is
# each pack's steps.json (localized there, zh/en). Scripts call Step-Begin with an empty
# title, and the Step-ProgressMap rows below also carry an empty title (they only translate
# progress figures into step ids), so the install window always renders titles from the manifest.
#
# Usage (each pack dot-sources this file at the top of its install script):
#   . (Join-Path $PSScriptRoot "step.ps1")
#   Step-Begin "venv" "" 15
#   ...the real work...
#   Step-Ok "venv" 25
#   # on error (the script must catch its own errors):
#   catch { Step-Fail "venv" "venv creation failed: $($_.Exception.Message)"; throw }
#
# Note: Progress-Line calls may stay (the old progress figures and the card status line are
# unchanged); this file only prints one more line.
#
# HARD RULE -- THIS FILE MUST STAY PURE ASCII (every byte <= 0x7F) AND MUST KEEP NO BOM:
#   the host runs install scripts with powershell.exe (Windows PowerShell 5.1), which decodes
#   a BOM-less .ps1 using the machine's ANSI code page (cp936 on Chinese Windows). Non-ASCII
#   bytes (Chinese comments, full-width punctuation) are then decoded as mojibake, and a
#   trailing byte can swallow the following `}` / `'` / `"` -- the parser dies with
#   "Unexpected token '}'" and EVERY pack install fails. Pure ASCII decodes identically under
#   any code page, so this cannot happen again. The same rule covers every *-pack install
#   script; test/smoke-install-scripts.js enforces it (zero non-ASCII + parse under both the
#   GBK and the UTF-8 decoding).
#
# This file writes no file, opens no network connection and needs no external module.
# =============================================================================

$script:MTStepIds = New-Object System.Collections.ArrayList
$script:MTStepPct = 0

function Write-MTStepJson {
  param(
    [string]$Id,
    [string]$Title,
    [string]$Status,
    [object]$Pct,
    [object]$Message
  )
  $obj = [ordered]@{
    mtnodeStep = 1
    id         = [string]$Id
    status     = [string]$Status
  }
  # Titles come from steps.json; a non-empty one is still passed through for callers that
  # print the fallback shape (a pack without step.ps1 next to it).
  if ("$Title" -ne "") { $obj.title = [string]$Title }
  if ($null -ne $Pct -and "$Pct" -ne "") {
    $n = 0
    if ([int]::TryParse("$Pct", [ref]$n)) { $obj.pct = $n }
  }
  # Message is either plain text or a structured failure ({ code; params; message }).
  # The parameter stays [object] on purpose: [string] would coerce that ordered dictionary into
  # "System.Collections.Specialized.OrderedDictionary" and lose the error code.
  if ($null -ne $Message) {
    if ($Message -is [string]) {
      if ("$Message" -ne "") { $obj.message = [string]$Message }
    } elseif ($Message -is [System.Collections.IDictionary]) {
      foreach ($k in @("code", "params", "message")) {
        if ($Message.Contains($k) -and $null -ne $Message[$k] -and "$($Message[$k])" -ne "") { $obj[$k] = $Message[$k] }
      }
    } else {
      $s = "$Message"
      if ($s -ne "") { $obj.message = $s }
    }
  }
  try {
    $json = $obj | ConvertTo-Json -Compress -Depth 3
  } catch {
    return
  }
  # ConvertTo-Json escapes non-ASCII as \uXXXX on older PowerShell versions -- the host
  # decodes JSON as UTF-8 and reads either shape, so print it as-is (no manual unescape,
  # which would break escapes inside strings).
  Write-Host $json
}

function Get-MTStepIndex {
  param([string]$Id)
  $i = 0
  foreach ($x in $script:MTStepIds) {
    if ("$x" -eq "$Id") { return $i }
    $i++
  }
  return -1
}

# Remember that this step started (ids that steps.json does not declare are accepted too:
# the script is always more trustworthy than the manifest).
function Step-Begin {
  param([string]$Id, [string]$Title, [object]$Pct, [string]$Message)
  if ((Get-MTStepIndex $Id) -lt 0) { [void]$script:MTStepIds.Add([string]$Id) }
  if ($null -ne $Pct -and "$Pct" -ne "") { $script:MTStepPct = [int]$Pct }
  Write-MTStepJson -Id $Id -Title $Title -Status "run" -Pct $Pct -Message $Message
}

function Step-Ok {
  param([string]$Id, [object]$Pct, [string]$Message)
  $i = Get-MTStepIndex $Id
  if ($i -lt 0) { [void]$script:MTStepIds.Add([string]$Id) }
  if ($null -ne $Pct -and "$Pct" -ne "") { $script:MTStepPct = [int]$Pct }
  Write-MTStepJson -Id $Id -Title "" -Status "ok" -Pct $Pct -Message $Message
}

# A failing step takes EITHER a plain string OR a structured failure object produced by the
# script's New-FailCode helper ([ordered]@{ code; params; message }): the install window
# resolves the code through steps.json into localized text, and falls back to `message`.
# The parameter must stay [object]: typing it [string] would coerce the structured object into
# "System.Collections.Specialized.OrderedDictionary" and the code would be lost.
function Step-Fail {
  param([string]$Id, [object]$Message)
  $i = Get-MTStepIndex $Id
  if ($i -lt 0) { [void]$script:MTStepIds.Add([string]$Id) }
  Write-MTStepJson -Id $Id -Title "" -Status "fail" -Pct "" -Message $Message
}

# This step is skipped (requirement already in place / the user skipped it): the install
# window shows "skipped" instead of "failed".
function Step-Skip {
  param([string]$Id, [object]$Message)
  Write-MTStepJson -Id $Id -Title "" -Status "skip" -Message $Message
}

# Folds "step i of n" into an overall percentage so scripts need not compute it.
function Step-Pct {
  param([int]$Step, [int]$Total)
  if ($Total -le 0) { return 0 }
  return [int][math]::Round((100.0 * $Step) / $Total)
}

# -----------------------------------------------------------------------------
# Step-Progress: a thin adapter for the big scripts that already print staged progress
# in order (sensenova / yue / breeze). It does not rewrite those flows -- it only
# TRANSLATES their existing progress lines into structured step lines.
#
# Why it exists: the install / repair logic of those scripts was tuned line by line
# (mirror fallbacks, tier probing, resume, mock smoke), so rearranging it into Step-Begin
# calls would be expensive and risky. A "progress threshold to step id" map hooks it up:
# the script keeps printing its own progress numbers, yet the install window can list the
# steps and stop at the right one when something fails.
#
# Semantics (strictly sequential, never goes backwards):
#   Step-Progress -Pct 34      -> enter the step whose threshold is <= 34: the previous
#                                 step is marked ok, this one run (printed once)
#   Step-Progress -Pct 100     -> every earlier step is ok and the overall pct becomes 100
#   Step-Progress -Fail "..."  -> mark the current step as fail (the script caught an error)
#   Step-Progress -Skip "..."  -> mark the whole batch at the same threshold as skip
#                                 (e.g. -SkipTorch / -SkipModels)
#
# The script hands the map over with Step-ProgressMap once, after it has resolved its own
# step ids (the script remains the source of truth for its steps).
# -----------------------------------------------------------------------------

function Step-ProgressMap {
  param([object[]]$Map)
  # Map: ordered array, each item @{ at = <progress threshold>; id = "<step id>"; title = "<title>" }
  $script:MTProgMap = @()
  if ($Map) { $script:MTProgMap = @($Map) }
  $script:MTProgIdx = -1
  $script:MTProgPct = 0
}

function Step-Progress {
  param([object]$Pct, [string]$Fail, [string]$Skip)
  $map = @($script:MTProgMap)
  if ($map.Count -eq 0) { return }

  if ($Fail) {
    $cur = if ($script:MTProgIdx -ge 0) { $map[$script:MTProgIdx] } else { $map[0] }
    Step-Fail $cur.id $Fail
    return
  }

  if ($null -ne $Pct -and "$Pct" -ne "") {
    $p = 0
    if (-not [int]::TryParse("$Pct", [ref]$p)) { return }
    if ($p -gt $script:MTProgPct) { $script:MTProgPct = $p }
  }
  $p = $script:MTProgPct

  # Furthest step covered so far: walk forward over every item whose threshold is <= p
  $target = $script:MTProgIdx
  $i = 0
  foreach ($m in $map) {
    if ([int]$m.at -le $p) { $target = $i }
    $i++
  }
  if ($target -lt 0) { return }

  if ($Skip) {
    # The whole batch sharing this threshold (e.g. the two torch steps at 30) is skipped together
    $i = 0
    foreach ($m in $map) {
      if ($i -le $target -and $i -gt $script:MTProgIdx) { Step-Skip $m.id $Skip }
      $i++
    }
    $script:MTProgIdx = $target
    return
  }

  if ($target -gt $script:MTProgIdx) {
    # Close the previous step (if it started) and open this one
    if ($script:MTProgIdx -ge 0) { Step-Ok $map[$script:MTProgIdx].id $map[$target].at }
    for ($k = $script:MTProgIdx + 1; $k -le $target; $k++) {
      Step-Begin $map[$k].id $map[$k].title $map[$k].at
    }
    $script:MTProgIdx = $target
  }

  if ($p -ge 100) {
    $i = 0
    foreach ($m in $map) {
      if ($i -lt $map.Count) { Step-Ok $m.id 100 }
      $i++
    }
    $script:MTProgIdx = $map.Count - 1
  }
}
