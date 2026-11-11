# MTNode repo history shrink: one command, six stages, nothing outside them.
#
#   1. pre-flight : clean work tree, no half-finished merge / rebase / cherry-pick
#                   / revert / bisect, no stash, no extra worktree, not a shallow
#                   clone, git >= 2.36, a usable python, and the vendored
#                   scripts/tools/git-filter-repo.py in place.
#   2. backup     : a mirror clone OUTSIDE the repo; every head and every tag of
#                   the live repo must resolve to the same sha in the backup.
#   3. analyze    : filter-repo --analyze, then print the .git size now, how much
#                   is estimated to come back, and the exact list of blobs over
#                   the limit that this rewrite would drop. Waits for "yes".
#   4. rewrite    : filter-repo --force --strip-blobs-bigger-than 20M
#                   --invert-paths with dist/ , web/downloads/ , *.msix (and the
#                   appx / msi family) and *setup*.exe kept out of the strip.
#                   ALL refs are rebuilt -- every branch and every tag -- which
#                   also collapses the add-then-delete duplicate history.
#   5. reclaim    : reflog expire --expire=now --all + gc --prune=now, so the
#                   ~2.4 GB of loose objects actually leaves the disk.
#   6. report     : .git size before/after, refs and tags before/after, HEAD sha.
#
# What the happy path never does: no reset, no checkout, no edit of a tracked
# file. filter-repo itself ends with a `git reset --hard`, which is a no-op when
# the tree is clean and no kept file changes content -- hence stage 1 refuses a
# dirty tree, and stage 3 refuses to run if a blob over the limit is reachable
# from HEAD outside the excluded paths (that file would be pulled out of the
# work tree as well). Pass -AllowHeadFileLoss when that is really what you want.
#
# Why origin is removed for the duration of the rewrite: filter-repo offers to
# `git fetch` every ref from origin before rewriting (an interactive Y/N) and
# then deletes the origin remote by itself. We take origin off up front instead,
# rewrite, and put it back with its url / pushurl / fetch refspec / tagopt, so an
# unattended run never blocks on a prompt and never silently loses the remote.
#
# Every failure stops the run and prints the backup + the exact restore recipe.
#
# Pure ASCII on purpose: this is started from a plain cmd console (ANSI page).
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/git-shrink-history.ps1
#   powershell ... -File scripts/git-shrink-history.ps1 -DryRun     # stages 1-3 only
#   powershell ... -File scripts/git-shrink-history.ps1 -Yes        # no prompt
#   powershell ... -File scripts/git-shrink-history.ps1 -BackupPath D:\bak\repo.git
#
# Exit 0 = rewritten (or, with -DryRun, analysis printed), 2 = user said no,
# 1 = stopped on a failed check or a failed command.

param(
  [string]$RepoRoot = '',
  [string]$BackupPath = '',
  [string]$Python = '',
  [int]$MaxBlobMB = 20,
  [switch]$Yes,
  [switch]$DryRun,
  [switch]$RecreateBackup,
  [switch]$AllowHeadFileLoss,
  [int]$MaxList = 200
)

$ErrorActionPreference = 'Stop'

# Paths kept out of the strip. ONE rule, used twice: these exact patterns go to
# filter-repo in stage 4, and the same values classify blobs for the estimate in
# stage 3 -- so what the report promises is what the rewrite does.
$ExcludeDirs = @('dist/', 'web/downloads/')
$ExcludeRegex = @(
  '(?i)\.(msix|msixbundle|msixupload|appx|appxbundle|appxupload|msi)$',
  '(?i)[^/]*setup[^/]*\.exe$'
)

$script:Stage = 'pre-flight'
$script:BackupMade = $false
$script:OriginSaved = $null
$script:pyExe = ''
$script:FilterRepo = ''
$script:GitDir = ''

function Say([string]$m) { Write-Host $m }
function Warn([string]$m) { Write-Host ('[warn] ' + $m) }
function Head([string]$m) { Write-Host ''; Write-Host ('=== ' + $m + ' ===') }

function FmtBytes([double]$b) {
  if ($b -ge 1GB) { return ('{0:N2} GB' -f ($b / 1GB)) }
  if ($b -ge 1MB) { return ('{0:N1} MB' -f ($b / 1MB)) }
  if ($b -ge 1KB) { return ('{0:N0} KB' -f ($b / 1KB)) }
  return ('{0:N0} B' -f $b)
}

function DirBytes([string]$p) {
  if (-not (Test-Path -LiteralPath $p)) { return [double]0 }
  $sum = (Get-ChildItem -LiteralPath $p -Recurse -Force -File -ErrorAction SilentlyContinue |
          Measure-Object -Property Length -Sum).Sum
  if ($null -eq $sum) { return [double]0 }
  return [double]$sum
}

function GitLines([string[]]$a) {
  $ErrorActionPreference = 'Continue'
  $out = & git @a 2>$null
  if ($LASTEXITCODE -ne 0) { return @() }
  return @($out | Where-Object { $null -ne $_ -and ([string]$_).Trim() -ne '' } |
           ForEach-Object { [string]$_ })
}

function GitQuiet([string[]]$a) {
  $ErrorActionPreference = 'Continue'
  & git @a 2>&1 | Out-Null
  return $LASTEXITCODE
}

function ShowRestoreHelp {
  Write-Host ''
  if (-not $BackupPath) {
    Write-Host 'No backup path was resolved in this run, so nothing on disk was touched by it.'
    return
  }
  Write-Host 'Restore recipe. The backup is a full mirror clone and was never written to.'
  Write-Host ('  backup: ' + $BackupPath)
  Write-Host '  1) put every ref back from the backup, in place:'
  Write-Host ('     git fetch --force "' + $BackupPath + '" "+refs/heads/*:refs/heads/*" "+refs/tags/*:refs/tags/*"')
  Write-Host '     git reset --hard'
  Write-Host '     git reflog expire --expire=now --all'
  Write-Host '     git gc --prune=now'
  Write-Host '  2) or move this folder aside and clone the backup again:'
  Write-Host ('     git clone "' + $BackupPath + '" <new-folder>')
  Write-Host '  Nothing is lost until a gc has run: the pre-rewrite objects stay on disk'
  Write-Host '  as unreachable loose objects.'
  if ($script:OriginSaved) {
    Write-Host '  If the origin remote is gone:'
    Write-Host ('     git remote add origin ' + @($script:OriginSaved.url)[0])
  }
}

function Fail([string]$m) {
  Write-Host ''
  Write-Host ('FAILED (' + $script:Stage + '): ' + $m)
  if ($script:OriginSaved) {
    RestoreOrigin
    $script:OriginSaved = $null
  }
  ShowRestoreHelp
  exit 1
}

function RestoreOrigin {
  if (-not $script:OriginSaved) { return }
  if ((@(GitLines @('remote')) -contains 'origin')) { return }
  $originUrl = @($script:OriginSaved.url)[0]
  & git remote add origin $originUrl 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { Warn 'could not re-add the origin remote automatically'; return }
  $pushUrl = @($script:OriginSaved.push)[0]
  if ($pushUrl) { & git remote set-url --push origin $pushUrl 2>&1 | Out-Null }
  $fetchSpec = @($script:OriginSaved.fetch)[0]
  if ($fetchSpec) { & git config --replace-all remote.origin.fetch $fetchSpec 2>&1 | Out-Null }
  if ($script:OriginSaved.tagopt) { & git config remote.origin.tagOpt $script:OriginSaved.tagopt 2>&1 | Out-Null }
  Say ('origin remote restored: ' + $script:OriginSaved.url[0])
}

# ---------------------------------------------------------------- stage 1
$script:Stage = '1/6 pre-flight'
Head $script:Stage

if (-not $RepoRoot) {
  if ($PSScriptRoot) { $RepoRoot = Split-Path -Parent $PSScriptRoot } else { $RepoRoot = (Get-Location).Path }
}
if (-not (Test-Path -LiteralPath $RepoRoot)) { Fail ('repo not found: ' + $RepoRoot) }
$RepoRoot = (Resolve-Path -LiteralPath $RepoRoot).Path

if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Fail 'git is not on PATH' }
Push-Location -LiteralPath $RepoRoot

if (-not (Test-Path -LiteralPath (Join-Path $RepoRoot '.git'))) {
  Fail ('not a git work tree (no .git): ' + $RepoRoot)
}
Say ('repo          : ' + $RepoRoot)

$gitVer = (& git --version 2>&1 | Select-Object -First 1)
Say ('git           : ' + $gitVer)
$m = [regex]::Match([string]$gitVer, '(\d+)\.(\d+)')
if ($m.Success) {
  $maj = [int]$m.Groups[1].Value
  $min = [int]$m.Groups[2].Value
  if ($maj -lt 2 -or ($maj -eq 2 -and $min -lt 36)) {
    Fail ('git 2.36 or newer is required by git-filter-repo (found ' + $gitVer + ')')
  }
}

# A half-finished operation must not be rewritten underneath.
foreach ($marker in @('MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG')) {
  if (Test-Path -LiteralPath (Join-Path (Join-Path $RepoRoot '.git') $marker)) {
    Fail ('a merge / rebase / cherry-pick / revert / bisect is still in progress (' + $marker + '); finish or abort it first')
  }
}
if ((GitLines @('rev-parse', '--is-shallow-repository')) -contains 'true') {
  Fail 'this is a shallow clone; filter-repo needs full history'
}
if ((GitLines @('stash', 'list')).Count -gt 0) {
  Fail 'refs/stash exists -- drop or apply the stash first'
}
$wt = @(GitLines @('worktree', 'list', '--porcelain') | Where-Object { $_ -like 'worktree *' })
if ($wt.Count -gt 1) {
  Fail ('linked worktrees exist (' + $wt.Count + '); remove them (git worktree prune / remove) first')
}
if ((GitLines @('rev-parse', '--verify', '--quiet', 'HEAD')).Count -eq 0) {
  Fail 'HEAD does not point at a commit yet'
}

$dirty = @(GitLines @('status', '--porcelain'))
if ($dirty.Count -gt 0) {
  Say ''
  Say 'dirty work tree:'
  $dirty | Select-Object -First 40 | ForEach-Object { Say ('  ' + $_) }
  if ($dirty.Count -gt 40) { Say ('  ... ' + ($dirty.Count - 40) + ' more') }
  Fail 'the work tree must be clean: commit or stash these, then run again'
}
Say 'work tree     : clean'

$script:FilterRepo = Join-Path (Join-Path $RepoRoot 'scripts') 'tools\git-filter-repo.py'
if (-not (Test-Path -LiteralPath $script:FilterRepo)) {
  Fail ('missing ' + $script:FilterRepo + ' -- it is the vendored git-filter-repo this script drives')
}

$pyCandidates = @()
if ($Python) { $pyCandidates += $Python } else { $pyCandidates += @('python', 'py') }
$pyVer = ''
foreach ($cand in $pyCandidates) {
  if (-not (Get-Command $cand -ErrorAction SilentlyContinue)) { continue }
  $probe = & $cand -c "import sys; sys.stdout.write('%d.%d.%d' % sys.version_info[:3])" 2>&1
  if ($LASTEXITCODE -eq 0 -and ([string]$probe) -match '^\d+\.\d+\.\d+$') {
    $script:pyExe = $cand
    $pyVer = [string]$probe
    break
  }
}
if (-not $script:pyExe) {
  Fail ('no usable python found (tried: ' + ($pyCandidates -join ', ') + '); git-filter-repo needs python 3')
}
Say ('python        : ' + $script:pyExe + ' ' + $pyVer)

$script:GitDir = @(GitLines @('rev-parse', '--absolute-git-dir'))[0]
if (-not $script:GitDir) { Fail 'could not resolve the git directory' }

$headBefore = @(GitLines @('rev-parse', 'HEAD'))[0]
$branchBefore = @(GitLines @('rev-parse', '--abbrev-ref', 'HEAD'))[0]
$refsBefore = @(GitLines @('for-each-ref', '--format=%(refname)'))
$tagsBefore = @(GitLines @('tag', '--list'))
Say ('HEAD          : ' + $branchBefore + ' ' + $headBefore.Substring(0, 10))
Say ('refs / tags   : ' + $refsBefore.Count + ' refs, ' + $tagsBefore.Count + ' tags')

# ---------------------------------------------------------------- stage 2
$script:Stage = '2/6 backup'
Head $script:Stage

if (-not $BackupPath) {
  $parent = Split-Path -Parent $RepoRoot
  $name = Split-Path -Leaf $RepoRoot
  $BackupPath = Join-Path $parent ($name + '.git-backup')
}
$BackupPath = [IO.Path]::GetFullPath($BackupPath)

if ($BackupPath.TrimEnd('\', '/') -eq $RepoRoot.TrimEnd('\', '/') -or
    $BackupPath.TrimEnd('\', '/').StartsWith($RepoRoot.TrimEnd('\', '/') + '\', [StringComparison]::OrdinalIgnoreCase) -or
    $BackupPath.TrimEnd('\', '/').StartsWith($RepoRoot.TrimEnd('\', '/') + '/', [StringComparison]::OrdinalIgnoreCase)) {
  Fail ('the backup must live outside the repo: ' + $BackupPath)
}

if ($RecreateBackup -and (Test-Path -LiteralPath $BackupPath)) {
  Say ('removing the old backup: ' + $BackupPath)
  Remove-Item -LiteralPath $BackupPath -Recurse -Force
}

if (-not (Test-Path -LiteralPath $BackupPath)) {
  Say ('no backup yet, creating a mirror clone: ' + $BackupPath)
  Say '  (this is the only safety net for the rewrite; it takes as long as copying .git)'
  & { $ErrorActionPreference = 'Continue'; & git clone --mirror --no-hardlinks --quiet $RepoRoot $BackupPath }
  if ($LASTEXITCODE -ne 0) { $BackupPath = ''; Fail 'mirror clone failed' }
  $script:BackupMade = $true
}
Say ('backup        : ' + $BackupPath)

$bakRefs = @{}
foreach ($line in (GitLines @(('--git-dir=' + $BackupPath), 'for-each-ref', '--format=%(objectname) %(refname)'))) {
  $sp = $line.IndexOf(' ')
  if ($sp -gt 0) { $bakRefs[$line.Substring($sp + 1)] = $line.Substring(0, $sp) }
}
$missing = @()
$mismatch = @()
foreach ($line in (GitLines @('for-each-ref', '--format=%(objectname) %(refname)', 'refs/heads', 'refs/tags'))) {
  $sp = $line.IndexOf(' ')
  $sha = $line.Substring(0, $sp)
  $ref = $line.Substring($sp + 1)
  if (-not $bakRefs.ContainsKey($ref)) { $missing += $ref; continue }
  if ($bakRefs[$ref] -ne $sha) { $mismatch += $ref }
}
if ($missing.Count -gt 0 -or $mismatch.Count -gt 0) {
  foreach ($r in $missing) { Warn ('backup is missing ' + $r) }
  foreach ($r in $mismatch) { Warn ('backup has a different tip for ' + $r) }
  Fail 'the backup does not match the live refs; re-run with -RecreateBackup to take a fresh one'
}
Say ('verified      : all ' + $bakRefs.Count + ' backup refs, heads and tags are identical')

# ---------------------------------------------------------------- stage 3
$script:Stage = '3/6 analyze'
Head $script:Stage

$looseBefore = @{}
foreach ($line in (GitLines @('count-objects', '-v'))) {
  $m = [regex]::Match($line, '^([a-z-]+):\s+(\d+)$')
  if ($m.Success) { $looseBefore[$m.Groups[1].Value] = [long]$m.Groups[2].Value }
}
$gitBytesBefore = DirBytes $script:GitDir
$looseCount = 0
if ($looseBefore.ContainsKey('count')) { $looseCount = $looseBefore['count'] }
$looseKB = 0
if ($looseBefore.ContainsKey('size')) { $looseKB = $looseBefore['size'] }

$limitBytes = [double]$MaxBlobMB * 1MB
Say ('git dir       : ' + (FmtBytes $gitBytesBefore))
Say ('loose objects : ' + $looseCount + ' (' + (FmtBytes ([double]$looseKB * 1KB)) + ')')

# --force here only clears a previous analysis report directory.
& $script:pyExe $script:FilterRepo --analyze --force
if ($LASTEXITCODE -ne 0) { Fail 'filter-repo --analyze failed' }

$blobFile = Join-Path (Join-Path (Join-Path $script:GitDir 'filter-repo') 'analysis') 'blob-shas-and-paths.txt'
if (-not (Test-Path -LiteralPath $blobFile)) { Fail ('analysis report missing: ' + $blobFile) }

function Test-Excluded([string]$p) {
  $n = $p -replace '\\', '/'
  foreach ($d in $ExcludeDirs) {
    if ($n.StartsWith($d, [StringComparison]::Ordinal)) { return $true }
  }
  foreach ($r in $ExcludeRegex) {
    if ([regex]::IsMatch($n, $r)) { return $true }
  }
  return $false
}

$stripList = New-Object System.Collections.ArrayList
$keepList = New-Object System.Collections.ArrayList
foreach ($line in (Get-Content -LiteralPath $blobFile)) {
  $m = [regex]::Match($line, '^\s+([0-9a-f]{40})\s+(\d+)\s+(\d+)\s+(.+)$')
  if (-not $m.Success) { continue }
  $unpacked = [double]$m.Groups[2].Value
  if ($unpacked -le $limitBytes) { continue }
  $namesRaw = $m.Groups[4].Value.Trim()
  if ($namesRaw.StartsWith('[')) {
    $inner = $namesRaw.Substring(1, $namesRaw.Length - 2)
    $names = @($inner -split ', ' | ForEach-Object { $_.Trim() })
  }
  else {
    $names = @($namesRaw)
  }
  $survivors = @($names | Where-Object { -not (Test-Excluded $_) })
  $row = [pscustomobject]@{
    sha      = $m.Groups[1].Value
    unpacked = $unpacked
    packed   = [double]$m.Groups[3].Value
    names    = $names
    doomed   = ($survivors.Count -gt 0)
  }
  if ($row.doomed) { [void]$stripList.Add($row) } else { [void]$keepList.Add($row) }
}

$stripBytesUnpacked = [double]0
$stripBytesPacked = [double]0
foreach ($r in $stripList) { $stripBytesUnpacked += $r.unpacked; $stripBytesPacked += $r.packed }
$keepBytesPacked = [double]0
foreach ($r in $keepList) { $keepBytesPacked += $r.packed }

Say ''
Say ('blobs over ' + $MaxBlobMB + ' MB in history : ' + ($stripList.Count + $keepList.Count))
Say ('  excluded, kept                        : ' + $keepList.Count + '  (' + (FmtBytes $keepBytesPacked) + ' packed)')
Say ('  to be stripped out of history          : ' + $stripList.Count + '  (' + (FmtBytes $stripBytesUnpacked) + ' unpacked, ' + (FmtBytes $stripBytesPacked) + ' packed)')
Say ('estimated reclaim                      : up to ' + (FmtBytes $stripBytesPacked) + ' of packed data, plus the ')
Say ('                                         ' + (FmtBytes ([double]$looseKB * 1KB)) + ' of loose objects that the gc collects')
Say ('                                         (the real number is the .git size delta printed in stage 6)')

if ($stripList.Count -eq 0) {
  Say ''
  Say 'Nothing over the limit outside the excluded paths: there is no history to rewrite.'
  Pop-Location
  exit 0
}

Say ''
Say 'blobs that would be dropped (sha / size / path):'
$shown = 0
foreach ($r in $stripList) {
  $shown++
  if ($shown -gt $MaxList) { Say ('  ... ' + ($stripList.Count - $MaxList) + ' more (raise -MaxList to see them)'); break }
  Say ('  ' + $r.sha.Substring(0, 10) + '  ' + (FmtBytes $r.unpacked).PadLeft(9) + '  ' + ($r.names -join ' , '))
}

# A stripped blob that is still reachable from HEAD outside the excluded paths
# would also be removed from the work tree by filter-repo's final reset --hard.
$headMap = @{}
foreach ($line in (GitLines @('ls-tree', '-r', '-l', 'HEAD'))) {
  $m = [regex]::Match($line, '^\d+\s+\w+\s+([0-9a-f]{40})\s+\d+\t(.+)$')
  if ($m.Success) { $headMap[$m.Groups[1].Value] = $m.Groups[2].Value }
}
$headLoss = @()
foreach ($r in $stripList) {
  if ($headMap.ContainsKey($r.sha)) { $headLoss += $headMap[$r.sha] }
}
if ($headLoss.Count -gt 0) {
  Say ''
  Say 'WARNING: these tracked files in HEAD are over the limit and would leave the work tree:'
  foreach ($p in $headLoss) { Say ('  ' + $p) }
  if (-not $AllowHeadFileLoss) {
    Fail ('refusing to rewrite: ' + $headLoss.Count + ' file(s) at HEAD would be deleted from the work tree (pass -AllowHeadFileLoss to accept, or move them into an excluded directory)')
  }
  Say '  continuing because -AllowHeadFileLoss was given'
}

if ($DryRun) {
  Say ''
  Say 'DryRun: stages 1-3 done, nothing was rewritten.'
  Pop-Location
  exit 0
}

if (-not $Yes) {
  Say ''
  $answer = Read-Host 'Type yes to rewrite history now (anything else stops here)'
  if ($answer -ne 'yes') {
    Say 'Stopped at your word: no ref, no object and no file was touched.'
    Pop-Location
    exit 2
  }
}

# ---------------------------------------------------------------- stage 4
$script:Stage = '4/6 rewrite'
Head $script:Stage

# Save the origin remote, then take it off: filter-repo would otherwise offer an
# interactive fetch from it and delete it afterwards anyway.
$originUrls = @(GitLines @('config', '--get-all', 'remote.origin.url'))
if ($originUrls.Count -gt 0) {
  $script:OriginSaved = [pscustomobject]@{
    url    = $originUrls
    push   = @(GitLines @('config', '--get-all', 'remote.origin.pushurl'))
    fetch  = @(GitLines @('config', '--get-all', 'remote.origin.fetch'))
    tagopt = (GitLines @('config', '--get', 'remote.origin.tagOpt') | Select-Object -First 1)
  }
  Say ('origin        : ' + $originUrls[0] + ' (removed for the rewrite, restored afterwards)')
  & git remote remove origin 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { Fail 'could not remove the origin remote before the rewrite' }
}

$frArgs = @(
  '--force',
  '--strip-blobs-bigger-than', ('' + $MaxBlobMB + 'M'),
  '--invert-paths'
)
foreach ($d in $ExcludeDirs) { $frArgs += @('--path', $d) }
foreach ($r in $ExcludeRegex) { $frArgs += @('--path-regex', $r) }

Say ('cmd           : ' + $script:pyExe + ' scripts\tools\git-filter-repo.py ' + ($frArgs -join ' '))
Say ''
& $script:pyExe $script:FilterRepo @frArgs
if ($LASTEXITCODE -ne 0) { Fail ('git-filter-repo failed (exit ' + $LASTEXITCODE + ')') }

RestoreOrigin
$script:OriginSaved = $null
Say ''
Say 'rewrite done: every head and every tag was rebuilt on the new history'

# ---------------------------------------------------------------- stage 5
$script:Stage = '5/6 reclaim'
Head $script:Stage

Say 'git reflog expire --expire=now --all'
if ((GitQuiet @('reflog', 'expire', '--expire=now', '--all')) -ne 0) { Fail 'reflog expire failed' }

Say 'git gc --prune=now'
& { $ErrorActionPreference = 'Continue'; & git gc --prune=now 2>&1 | ForEach-Object { Say ('  ' + [string]$_) } }
if ($LASTEXITCODE -ne 0) { Fail 'git gc failed' }

# ---------------------------------------------------------------- stage 6
$script:Stage = '6/6 report'
Head $script:Stage

$gitBytesAfter = DirBytes $script:GitDir
$refsAfter = @(GitLines @('for-each-ref', '--format=%(refname)'))
$tagsAfter = @(GitLines @('tag', '--list'))
$headAfter = (GitLines @('rev-parse', 'HEAD') | Select-Object -First 1)
$headAfterShort = ''
if ($headAfter) { $headAfterShort = $headAfter.Substring(0, 10) }

Say ('.git size     : ' + (FmtBytes $gitBytesBefore) + '  ->  ' + (FmtBytes $gitBytesAfter) +
     '   (reclaimed ' + (FmtBytes ([Math]::Max(0, $gitBytesBefore - $gitBytesAfter))) + ')')
Say ('refs          : ' + $refsBefore.Count + '  ->  ' + $refsAfter.Count)
Say ('tags          : ' + $tagsBefore.Count + '  ->  ' + $tagsAfter.Count)
Say ('HEAD          : ' + $branchBefore + ' ' + $headBefore.Substring(0, 10) + '  ->  ' + $headAfterShort)

$tagsLost = @($tagsBefore | Where-Object { $tagsAfter -notcontains $_ })
if ($tagsLost.Count -gt 0) {
  Warn ('these tags disappeared because their commit became empty: ' + ($tagsLost -join ', '))
}

$status = @(GitLines @('status', '--porcelain'))
if ($status.Count -eq 0) {
  Say 'work tree     : clean, no tracked file changed'
}
else {
  Warn ('the work tree is not clean after the rewrite (' + $status.Count + ' entries):')
  $status | Select-Object -First 20 | ForEach-Object { Warn ('  ' + $_) }
}

$script:Stage = 'done'
$bakNote = ''
if ($script:BackupMade) { $bakNote = ' (created by this run)' }
Say ''
Say ('Backup kept at: ' + $BackupPath + $bakNote)
Say 'The remote still holds the old history; when ready, push the rewrite with:'
Say '  git push --force --all'
Say '  git push --force --tags'
Say 'Delete the backup only after the force push has been verified.'

Pop-Location
exit 0

