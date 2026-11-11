# MTNode repo history-rewrite verifier: after git-shrink-history.ps1 has run,
# prove -- item by item, with the numbers it is proven with -- that the rewrite
# did exactly what it promised. No "should be fine" anywhere: every check is
# PASS, FAIL or UNVERIFIED, and FAIL / UNVERIFIED are printed in red.
#
# READ-ONLY. This script never runs reset, checkout, fetch, push, gc, prune,
# reflog, filter-repo, or anything else that can change a ref, an object or a
# tracked file. The git commands it uses are: rev-parse, for-each-ref,
# tag --list, ls-tree, ls-files, status, count-objects, cat-file, rev-list.
# (git status may refresh the stat cache inside .git/index; that changes no
# content, no ref and no object.)
#
# Checks
#   A1  blobs over MaxBlobMB reachable from any ref .................... 0
#   A2  blobs over MaxBlobMB left anywhere in the object database ...... 0
#       (A2 catches "stage 5 did not really run": leftovers are unreachable
#        garbage that git gc --prune=now would drop)
#   A3  HEAD tree hash byte-identical to the pre-rewrite tree
#       -> the tracked content at HEAD is untouched; commit shas change by
#          design, only the tree is compared
#   A4  tracked file count at HEAD equal to the pre-rewrite count
#   A5  the work tree still matches HEAD (no tracked file modified)
#   A6  tags: count is ExpectedTags (13), every tag resolves to an existing
#       commit, and no tag that existed before is gone
#   A7  every branch that existed before still exists and resolves to a commit
#   A8  .git size before / after table + count-objects evidence
#       (evidence only, not pass/fail: the "before" number has to be supplied)
#
# Where "before" comes from: the mirror backup that git-shrink-history.ps1 made
# (default <repo>.git-backup next to the repo). It is opened with --git-dir and
# is never written to. Without it A3 / A4 / A7 cannot be proven, which is
# reported as UNVERIFIED (exit 2), never as OK.
#
# Pure ASCII on purpose: this is started from a plain cmd console (ANSI page).
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/git-verify-history.ps1
#   ... -BeforeBytes 2614235136        # .git size that stage 6 of the shrink printed
#   ... -ExpectedTags 13 -MaxBlobMB 20
#   ... -BackupPath D:\bak\repo.git -JsonPath D:\tmp\verify.json
#
# Exit 0 = all checks passed, 1 = at least one FAIL, 2 = nothing failed but at
# least one check could not be proven (no baseline).

param(
  [string]$RepoRoot = '',
  [string]$BackupPath = '',
  [double]$BeforeBytes = 0,
  [int]$MaxBlobMB = 20,
  [int]$ExpectedTags = 13,
  [string]$JsonPath = ''
)

$ErrorActionPreference = 'Stop'

$script:Checks = New-Object System.Collections.ArrayList
$script:FailCount = 0
$script:UnverifiedCount = 0
$script:BakGitDir = ''
$script:BakReady = $false

# ---------------------------------------------------------------- helpers
function Say([string]$m) { Write-Host $m }
function Head([string]$m) { Write-Host ''; Write-Host ('=== ' + $m + ' ===') }
function Note([string]$m) { Write-Host ('  note: ' + $m) -ForegroundColor DarkGray }

function FmtBytes([double]$b) {
  if ($b -ge 1GB) { return ('{0:N2} GB' -f ($b / 1GB)) }
  if ($b -ge 1MB) { return ('{0:N1} MB' -f ($b / 1MB)) }
  if ($b -ge 1KB) { return ('{0:N0} KB' -f ($b / 1KB)) }
  return ('{0:N0} B' -f $b)
}

function FmtInt([double]$n) { return ('{0:N0}' -f $n) }

# Abbreviated sha that never throws on an unresolved ref ("" stays "(none)").
function ShortSha([string]$s, [int]$n) {
  if (-not $s) { return '(none)' }
  if ($s.Length -le $n) { return $s }
  return $s.Substring(0, $n)
}

function DirBytes([string]$p) {
  if (-not $p) { return [double]0 }
  if (-not (Test-Path -LiteralPath $p)) { return [double]0 }
  $sum = (Get-ChildItem -LiteralPath $p -Recurse -Force -File -ErrorAction SilentlyContinue |
          Measure-Object -Property Length -Sum).Sum
  if ($null -eq $sum) { return [double]0 }
  return [double]$sum
}

# Every git call goes through here: an array of arguments in, string lines out.
# $script:GitExit keeps the real exit code so "no output" and "failed" can be
# told apart by the caller.
function GitLines([string[]]$a) {
  $out = & git @a 2>$null
  $script:GitExit = $LASTEXITCODE
  if ($LASTEXITCODE -ne 0) { return @() }
  return @($out | ForEach-Object { [string]$_ } | Where-Object { $_.Trim() -ne '' })
}

function GitOne([string[]]$a) {
  $l = @(GitLines $a)
  if ($l.Count -eq 0) { return '' }
  return $l[0]
}

# count-objects -v as a hashtable (count / size / in-pack / size-pack / garbage)
function CountObjects([string[]]$prefix) {
  $h = @{}
  $a = @()
  $a += $prefix
  $a += @('count-objects', '-v')
  foreach ($line in (GitLines $a)) {
    $m = [regex]::Match($line, '^([a-z-]+):\s+(\d+)$')
    if ($m.Success) { $h[$m.Groups[1].Value] = [double]$m.Groups[2].Value }
  }
  return $h
}

# Every object in the object database (packed and loose, reachable or not), with
# type, sha and raw size; returned as counters plus the list over the limit.
function Scan-Objects([string[]]$prefix, [double]$limit) {
  $a = @()
  $a += $prefix
  $a += @('cat-file', '--batch-all-objects', '--batch-check=%(objecttype) %(objectname) %(objectsize)')
  $out = & git @a 2>$null
  if ($LASTEXITCODE -ne 0) { return $null }
  $blobs = 0
  $bytes = [double]0
  $max = [double]0
  $over = New-Object System.Collections.ArrayList
  foreach ($line in $out) {
    $s = [string]$line
    if (-not $s.StartsWith('blob ')) { continue }
    $p = $s.Split(' ')
    if ($p.Count -lt 3) { continue }
    $blobs++
    $sz = [double]$p[2]
    $bytes += $sz
    if ($sz -gt $max) { $max = $sz }
    if ($sz -gt $limit) { [void]$over.Add([pscustomobject]@{ sha = $p[1]; size = $sz }) }
  }
  return [pscustomobject]@{ blobs = $blobs; bytes = $bytes; max = $max; over = @($over) }
}

# sha -> path for everything reachable from the refs ("" for commits / trees).
function ReachablePaths([string[]]$prefix) {
  $a = @()
  $a += $prefix
  $a += @('rev-list', '--objects', '--all')
  $map = @{}
  $out = & git @a 2>$null
  if ($LASTEXITCODE -ne 0) { return $map }
  foreach ($line in $out) {
    $s = [string]$line
    if ($s.Length -lt 40) { continue }
    $sha = $s.Substring(0, 40)
    $path = ''
    if ($s.Length -gt 41) { $path = $s.Substring(41) }
    if (-not $map.ContainsKey($sha)) { $map[$sha] = $path }
  }
  return $map
}

function Add-Check([string]$id, [string]$name, [string]$status, [string[]]$evidence) {
  [void]$script:Checks.Add([pscustomobject]@{ id = $id; name = $name; status = $status; evidence = @($evidence) })
  if ($status -eq 'PASS') {
    Write-Host ('  ' + $id.PadRight(3) + 'PASS        ' + $name) -ForegroundColor Green
  }
  elseif ($status -eq 'FAIL') {
    Write-Host ('  ' + $id.PadRight(3) + 'FAIL        ' + $name) -ForegroundColor Red
  }
  else {
    Write-Host ('  ' + $id.PadRight(3) + 'UNVERIFIED  ' + $name) -ForegroundColor Red
  }
  $col = 'Gray'
  if ($status -ne 'PASS') { $col = 'Red' }
  foreach ($e in @($evidence)) {
    if ($e) { Write-Host ('       ' + $e) -ForegroundColor $col }
  }
  if ($status -eq 'FAIL') { $script:FailCount++ }
  if ($status -eq 'UNVERIFIED') { $script:UnverifiedCount++ }
}

# ---------------------------------------------------------------- context
Say ''
Say '=== git history rewrite: verification (read-only) ==='

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Write-Host 'FAILED: git is not on PATH' -ForegroundColor Red
  exit 1
}
if (-not $RepoRoot) {
  if ($PSScriptRoot) { $RepoRoot = Split-Path -Parent $PSScriptRoot } else { $RepoRoot = (Get-Location).Path }
}
if (-not (Test-Path -LiteralPath $RepoRoot)) {
  Write-Host ('FAILED: repo not found: ' + $RepoRoot) -ForegroundColor Red
  exit 1
}
$RepoRoot = (Resolve-Path -LiteralPath $RepoRoot).Path
if (-not (Test-Path -LiteralPath (Join-Path $RepoRoot '.git'))) {
  Write-Host ('FAILED: not a git work tree (no .git): ' + $RepoRoot) -ForegroundColor Red
  exit 1
}
Push-Location -LiteralPath $RepoRoot

if (-not $BackupPath) {
  $parent = Split-Path -Parent $RepoRoot
  $name = Split-Path -Leaf $RepoRoot
  $BackupPath = Join-Path $parent ($name + '.git-backup')
}
$BackupPath = [IO.Path]::GetFullPath($BackupPath)
if ((Test-Path -LiteralPath $BackupPath) -and (Test-Path -LiteralPath (Join-Path $BackupPath 'HEAD'))) {
  $script:BakGitDir = $BackupPath
  $script:BakReady = $true
}

$limit = [double]$MaxBlobMB * 1MB

Say ('repo      : ' + $RepoRoot)
Say ('git       : ' + (& git --version 2>&1 | Select-Object -First 1))
Say ('baseline  : ' + $BackupPath)
if ($script:BakReady) {
  Say '            (mirror clone from stage 2, opened read-only with --git-dir)'
} else {
  Say '            MISSING: without it the pre-rewrite numbers cannot be proven'
}

# ---------------------------------------------------------------- measure now
$gitDir = GitOne @('rev-parse', '--absolute-git-dir')
if (-not $gitDir) { $gitDir = Join-Path $RepoRoot '.git' }

$branch = GitOne @('rev-parse', '--abbrev-ref', 'HEAD')
$headSha = GitOne @('rev-parse', 'HEAD')
$headTree = GitOne @('rev-parse', 'HEAD^{tree}')
$headFiles = @(GitLines @('ls-tree', '-r', '--name-only', 'HEAD'))
$indexFiles = @(GitLines @('ls-files'))
$dirtyTracked = @(GitLines @('status', '--porcelain', '--untracked-files=no'))
$untrackedFiles = @(GitLines @('ls-files', '--others', '--exclude-standard'))
$refsLive = @(GitLines @('for-each-ref', '--format=%(refname)'))
$headsLive = @(GitLines @('for-each-ref', '--format=%(refname)', 'refs/heads'))
$tagsLive = @(GitLines @('tag', '--list'))

$scanNow = Scan-Objects -prefix @() -limit $limit
$coNow = CountObjects -prefix @()

# ---------------------------------------------------------------- measure before
$bakTree = ''
$bakFiles = @()
$bakTags = @()
$bakHeads = @()
$scanBak = $null
if ($script:BakReady) {
  $bp = @(('--git-dir=' + $script:BakGitDir))
  $bakTree = GitOne ($bp + @('rev-parse', 'HEAD^{tree}'))
  if (-not $bakTree -and $branch) {
    $bakTree = GitOne ($bp + @('rev-parse', ('refs/heads/' + $branch + '^{tree}')))
  }
  $bakFiles = @(GitLines ($bp + @('ls-tree', '-r', '--name-only', 'HEAD')))
  if ($bakFiles.Count -eq 0 -and $branch) {
    $bakFiles = @(GitLines ($bp + @('ls-tree', '-r', '--name-only', ('refs/heads/' + $branch))))
  }
  $bakTags = @(GitLines ($bp + @('tag', '--list')))
  $bakHeads = @(GitLines ($bp + @('for-each-ref', '--format=%(refname)', 'refs/heads')))
  $scanBak = Scan-Objects -prefix $bp -limit $limit
}

# ---------------------------------------------------------------- A1 / A2
Head ('1. blobs over ' + $MaxBlobMB + ' MB')

$overReach = @()
$overLoose = @()
$pathMap = @{}
if ($null -ne $scanNow -and $scanNow.over.Count -gt 0) {
  $pathMap = ReachablePaths -prefix @()
  foreach ($o in $scanNow.over) {
    if ($pathMap.ContainsKey($o.sha)) { $overReach += $o } else { $overLoose += $o }
  }
}

$limitName = 'no blob over ' + $MaxBlobMB + ' MB is reachable from any ref'
if ($null -eq $scanNow) {
  Add-Check -id 'A1' -name $limitName -status 'UNVERIFIED' -evidence @('git cat-file --batch-all-objects failed; the object database could not be scanned')
}
else {
  $ev = @()
  $ev += ('reachable blobs over ' + $MaxBlobMB + ' MB : ' + $overReach.Count)
  if ($null -ne $scanBak) {
    $ev += ('same count in the backup (before)     : ' + $scanBak.over.Count)
    $ev += ('blobs total now / before              : ' + (FmtInt $scanNow.blobs) + ' / ' + (FmtInt $scanBak.blobs))
    $ev += ('largest blob now / before             : ' + (FmtBytes $scanNow.max) + ' / ' + (FmtBytes $scanBak.max))
  }
  else {
    $ev += 'no baseline: the pre-rewrite count is unknown'
    $ev += ('largest blob now                      : ' + (FmtBytes $scanNow.max))
  }
  if ($overReach.Count -gt 0) {
    $ev += ('blobs still reachable, first 20 of ' + $overReach.Count + ':')
    foreach ($o in @($overReach | Select-Object -First 20)) {
      $ev += ('  ' + $o.sha.Substring(0, 10) + '  ' + (FmtBytes $o.size).PadLeft(9) + '  ' + $pathMap[$o.sha])
    }
  }
  $st = 'PASS'
  if ($overReach.Count -gt 0) { $st = 'FAIL' }
  Add-Check -id 'A1' -name $limitName -status $st -evidence $ev
}

$limitName2 = 'no blob over ' + $MaxBlobMB + ' MB is left in the object database'
if ($null -eq $scanNow) {
  Add-Check -id 'A2' -name $limitName2 -status 'UNVERIFIED' -evidence @('the object database could not be scanned')
}
else {
  $ev = @()
  $overBytes = [double]0
  foreach ($o in $scanNow.over) { $overBytes += $o.size }
  $ev += ('blobs over ' + $MaxBlobMB + ' MB anywhere in .git : ' + $scanNow.over.Count +
          '  (' + (FmtBytes $overBytes) + ')')
  $ev += ('  of those: reachable ' + $overReach.Count + ', unreachable leftovers ' + $overLoose.Count)
  if ($overLoose.Count -gt 0) {
    $ev += 'unreachable leftovers mean stage 5 did not prune them: git gc --prune=now removes them'
    foreach ($o in @($overLoose | Select-Object -First 10)) {
      $ev += ('  ' + $o.sha.Substring(0, 10) + '  ' + (FmtBytes $o.size).PadLeft(9) + '  (unreachable)')
    }
  }
  $st = 'PASS'
  if ($scanNow.over.Count -gt 0) { $st = 'FAIL' }
  Add-Check -id 'A2' -name $limitName2 -status $st -evidence $ev
}

# ---------------------------------------------------------------- A3 / A4
Head '2. content at HEAD'

if (-not $script:BakReady) {
  Add-Check -id 'A3' -name 'HEAD tree hash is identical to the pre-rewrite tree' -status 'UNVERIFIED' `
    -evidence @(('tree now: ' + $headTree), ('no baseline mirror at ' + $BackupPath + ': the pre-rewrite tree hash is unknown, so "content unchanged" cannot be proven'))
}
elseif (-not $bakTree) {
  Add-Check -id 'A3' -name 'HEAD tree hash is identical to the pre-rewrite tree' -status 'UNVERIFIED' `
    -evidence @(('tree now: ' + $headTree), ('the baseline has no HEAD and no refs/heads/' + $branch + ' to read a tree from'))
}
else {
  $st = 'FAIL'
  if ($bakTree -eq $headTree) { $st = 'PASS' }
  Add-Check -id 'A3' -name 'HEAD tree hash is identical to the pre-rewrite tree' -status $st -evidence @(
    ('tree now    : ' + $headTree),
    ('tree before : ' + $bakTree),
    ('HEAD now    : ' + (ShortSha $headSha 12) + ' on ' + $branch + '  (the commit sha changes by design; only the tree is compared)')
  )
}

if (-not $script:BakReady -or $bakFiles.Count -eq 0) {
  Add-Check -id 'A4' -name 'tracked file count at HEAD equals the pre-rewrite count' -status 'UNVERIFIED' `
    -evidence @(('files at HEAD now: ' + $headFiles.Count), 'no pre-rewrite file list available (baseline missing or empty)')
}
else {
  $st = 'FAIL'
  if ($bakFiles.Count -eq $headFiles.Count) { $st = 'PASS' }
  $ev = @()
  $ev += ('files at HEAD now : ' + $headFiles.Count)
  $ev += ('files before      : ' + $bakFiles.Count)
  if ($bakFiles.Count -ne $headFiles.Count) {
    $gone = @($bakFiles | Where-Object { $headFiles -notcontains $_ })
    $added = @($headFiles | Where-Object { $bakFiles -notcontains $_ })
    if ($gone.Count -gt 0) { $ev += ('missing now, first 20: ' + (($gone | Select-Object -First 20) -join ', ')) }
    if ($added.Count -gt 0) { $ev += ('new now, first 20    : ' + (($added | Select-Object -First 20) -join ', ')) }
  }
  Add-Check -id 'A4' -name 'tracked file count at HEAD equals the pre-rewrite count' -status $st -evidence $ev
}

# ---------------------------------------------------------------- A5
$st = 'FAIL'
if ($dirtyTracked.Count -eq 0) { $st = 'PASS' }
$ev = @()
$ev += ('tracked files modified / staged / deleted : ' + $dirtyTracked.Count)
$ev += ('tracked files in the index / at HEAD      : ' + $indexFiles.Count + ' / ' + $headFiles.Count)
$ev += ('untracked files (informational)           : ' + $untrackedFiles.Count)
if ($dirtyTracked.Count -gt 0) {
  foreach ($l in @($dirtyTracked | Select-Object -First 20)) { $ev += ('  ' + $l) }
}
Add-Check -id 'A5' -name 'the work tree still matches HEAD (no tracked file was touched)' -status $st -evidence $ev

# ---------------------------------------------------------------- A6
Head '3. tags and refs'

$tagBad = @()
foreach ($t in $tagsLive) {
  $sha = GitOne @('rev-parse', '--verify', '--quiet', ('refs/tags/' + $t + '^{commit}'))
  if (-not $sha) { $tagBad += $t }
}
$tagsLost = @()
$tagsAdded = @()
if ($script:BakReady -and $bakTags.Count -gt 0) {
  $tagsLost = @($bakTags | Where-Object { $tagsLive -notcontains $_ })
  $tagsAdded = @($tagsLive | Where-Object { $bakTags -notcontains $_ })
}

$ev = @()
$ev += ('tags now : ' + $tagsLive.Count + '   expected : ' + $ExpectedTags + $(if ($script:BakReady -and $bakTags.Count -gt 0) { '   before : ' + $bakTags.Count } else { '' }))
$ev += ('each tag resolves to an existing commit : ' + ($tagsLive.Count - $tagBad.Count) + ' / ' + $tagsLive.Count)
if ($tagBad.Count -gt 0) { $ev += ('tags that do not resolve to a commit : ' + ($tagBad -join ', ')) }
if ($tagsLost.Count -gt 0) { $ev += ('tags that existed before and are gone : ' + ($tagsLost -join ', ')) }
if ($tagsAdded.Count -gt 0) { $ev += ('tags that did not exist before       : ' + ($tagsAdded -join ', ')) }
if (-not $script:BakReady) { $ev += 'no baseline: the pre-rewrite tag list could not be compared' }
$st = 'PASS'
if ($tagsLive.Count -ne $ExpectedTags) { $st = 'FAIL' }
if ($tagBad.Count -gt 0) { $st = 'FAIL' }
if ($tagsLost.Count -gt 0) { $st = 'FAIL' }
if ($tagsAdded.Count -gt 0) { $st = 'FAIL' }
Add-Check -id 'A6' -name ('tag count is ' + $ExpectedTags + ', every tag points at an existing commit, none lost') -status $st -evidence $ev

# ---------------------------------------------------------------- A7
$headsBad = @()
foreach ($h in $headsLive) {
  $sha = GitOne @('rev-parse', '--verify', '--quiet', ($h + '^{commit}'))
  if (-not $sha) { $headsBad += $h }
}
$headsLost = @()
if ($script:BakReady -and $bakHeads.Count -gt 0) {
  $headsLost = @($bakHeads | Where-Object { $headsLive -notcontains $_ })
}
$ev = @()
$ev += ('branches now : ' + $headsLive.Count + $(if ($script:BakReady -and $bakHeads.Count -gt 0) { '   before : ' + $bakHeads.Count } else { '' }))
if ($headsBad.Count -gt 0) { $ev += ('branches that do not resolve to a commit : ' + ($headsBad -join ', ')) }
if ($headsLost.Count -gt 0) { $ev += ('branches that existed before and are gone : ' + ($headsLost -join ', ')) }
$ev += ('all refs : ' + $refsLive.Count + '   HEAD : ' + $branch + ' ' + (ShortSha $headSha 12))
if (-not $script:BakReady) { $ev += 'no baseline: the pre-rewrite branch list could not be compared' }
if (-not $script:BakReady) {
  Add-Check -id 'A7' -name 'every branch that existed before still exists and resolves to a commit' -status 'UNVERIFIED' -evidence $ev
}
else {
  $st = 'PASS'
  if ($headsBad.Count -gt 0) { $st = 'FAIL' }
  if ($headsLost.Count -gt 0) { $st = 'FAIL' }
  Add-Check -id 'A7' -name 'every branch that existed before still exists and resolves to a commit' -status $st -evidence $ev
}

# ---------------------------------------------------------------- A8
Head '.git size: before -> after'

$afterBytes = DirBytes $gitDir
$before = [double]$BeforeBytes
$haveBefore = ($before -gt 0)
if (-not $haveBefore) { $before = [double]0 }

$rowFmt = '{0,-26} {1,18} {2,18} {3,18}'
Say ('  ' + ($rowFmt -f 'item', 'before', 'now', 'delta'))
Say ('  ' + ('-' * 83))

$beforeBytesText = 'n/a'
$deltaBytesText = 'n/a'
$beforeHumanText = 'n/a'
$deltaHumanText = 'n/a'
if ($haveBefore) {
  $beforeBytesText = (FmtInt $before)
  $beforeHumanText = (FmtBytes $before)
  $deltaBytesText = (FmtInt ($before - $afterBytes))
  $deltaHumanText = (FmtBytes ([Math]::Abs($before - $afterBytes)))
  if ($before -ge $afterBytes) { $deltaHumanText = '-' + $deltaHumanText } else { $deltaHumanText = '+' + $deltaHumanText }
}
Say ('  ' + ($rowFmt -f '.git size, bytes', $beforeBytesText, (FmtInt $afterBytes), $deltaBytesText))
Say ('  ' + ($rowFmt -f '.git size, human', $beforeHumanText, (FmtBytes $afterBytes), $deltaHumanText))
Say ''

if ($haveBefore) {
  if ($before -ge $afterBytes) {
    Say ('  reclaimed : ' + (FmtBytes ([double]($before - $afterBytes))) + '  (' + (FmtInt ([double]($before - $afterBytes))) + ' bytes)')
  }
  else {
    Say ('  .git grew by ' + (FmtBytes ([double]($afterBytes - $before))) + '; check the numbers above')
  }
}
else {
  Say '  before    : not supplied -- pass -BeforeBytes <bytes> (the .git size that stage 6 printed)'
  Say '              to fill the "before" and "delta" columns.'
}

$bakBytes = DirBytes $BackupPath
if ($script:BakReady) {
  Say ('  reference : the mirror backup occupies ' + (FmtBytes $bakBytes) + ' -- a re-packed copy of the')
  Say '              pre-rewrite objects, not the old .git on disk (loose objects there were ~2.4 GB).'
}

Say ''
Say ('  count-objects now : count ' + (FmtInt $coNow['count']) + '  (' + (FmtBytes ([double]$coNow['size'] * 1KB)) + ' loose), ' +
     'in-pack ' + (FmtInt $coNow['in-pack']) + '  (' + (FmtBytes ([double]$coNow['size-pack'] * 1KB)) + ' packed), ' +
     'garbage ' + (FmtInt $coNow['garbage']))
if ($null -ne $scanNow) {
  Say ('  object database   : ' + (FmtInt $scanNow.blobs) + ' blobs, ' + (FmtBytes $scanNow.bytes) + ' raw')
}

# ---------------------------------------------------------------- summary
Say ''
Say '=== summary ==='

$passed = 0
foreach ($c in $script:Checks) { if ($c.status -eq 'PASS') { $passed++ } }
Say ('  checks passed : ' + $passed + ' / ' + $script:Checks.Count)

if ($script:FailCount -gt 0) {
  $ids = @($script:Checks | Where-Object { $_.status -eq 'FAIL' } | ForEach-Object { $_.id })
  Write-Host ('  FAILED        : ' + $script:FailCount + ' (' + ($ids -join ', ') + ') -- see the red rows above') -ForegroundColor Red
}
if ($script:UnverifiedCount -gt 0) {
  $ids = @($script:Checks | Where-Object { $_.status -eq 'UNVERIFIED' } | ForEach-Object { $_.id })
  Write-Host ('  UNVERIFIED    : ' + $script:UnverifiedCount + ' (' + ($ids -join ', ') + ') -- not proven, not assumed') -ForegroundColor Red
}

$code = 0
$verdict = 'PASS'
if ($script:FailCount -gt 0) { $code = 1; $verdict = 'FAIL' }
elseif ($script:UnverifiedCount -gt 0) { $code = 2; $verdict = 'INCOMPLETE' }

Say ''
if ($code -eq 0) {
  Write-Host ('  RESULT: PASS -- every check above proves the rewrite kept the content and dropped the big blobs') -ForegroundColor Green
}
elseif ($code -eq 1) {
  Write-Host ('  RESULT: FAIL -- the rewrite does not meet the conditions; do not delete the backup') -ForegroundColor Red
}
else {
  Write-Host ('  RESULT: INCOMPLETE -- nothing failed, but ' + $script:UnverifiedCount + ' check(s) could not be proven (no baseline)') -ForegroundColor Red
}

if ($JsonPath) {
  $doc = [pscustomobject]@{
    tool              = 'git-verify-history'
    generatedAt       = (Get-Date).ToString('o')
    repo              = $RepoRoot
    baseline          = $BackupPath
    baselineAvailable = $script:BakReady
    maxBlobMB         = $MaxBlobMB
    expectedTags      = $ExpectedTags
    verdict           = $verdict
    exitCode          = $code
    checks            = @($script:Checks)
    measurements      = [pscustomobject]@{
      gitDirBytesNow   = $afterBytes
      gitDirBytesBefore = $before
      beforeSupplied   = $haveBefore
      headSha          = $headSha
      headTree         = $headTree
      headTreeBefore   = $bakTree
      filesAtHead      = $headFiles.Count
      filesAtHeadBefore = $bakFiles.Count
      tagsNow          = $tagsLive.Count
      tagsBefore       = $bakTags.Count
      branchesNow      = $headsLive.Count
      branchesBefore   = $bakHeads.Count
      blobsNow         = $(if ($null -ne $scanNow) { $scanNow.blobs } else { -1 })
      blobsOverNow     = $(if ($null -ne $scanNow) { $scanNow.over.Count } else { -1 })
      blobsOverBefore  = $(if ($null -ne $scanBak) { $scanBak.over.Count } else { -1 })
      looseCountNow    = $coNow['count']
      packedBytesNow   = [double]$coNow['size-pack'] * 1KB
    }
  }
  $json = $doc | ConvertTo-Json -Depth 6
  $utf8 = New-Object System.Text.UTF8Encoding($false)
  $full = [IO.Path]::GetFullPath($JsonPath)
  [IO.File]::WriteAllText($full, $json, $utf8)
  Say ''
  Say ('  json written: ' + $full)
}

Pop-Location
exit $code
