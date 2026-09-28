@echo off
setlocal EnableExtensions EnableDelayedExpansion
REM ============================================================
REM  MTNode temporary verify build  (scripts\verify-build.cmd)
REM
REM  Goal: compile a win-unpacked copy into a FIXED path and open
REM        it right away, WITHOUT closing the MTNode instance that
REM        is currently running and WITHOUT touching dist\.
REM
REM  Usage:
REM    scripts\verify-build.cmd            -> build into the fixed path, then OPEN it
REM    scripts\verify-build.cmd -NoRun     -> build only, do not open
REM    scripts\verify-build.cmd -SameData  -> open it with the current data dir
REM    scripts\verify-build.cmd -Clean     -> wipe the output folder first
REM    scripts\verify-build.cmd -Out D:\v1 -> build into an explicit folder instead
REM    scripts\verify-build.cmd -Keep      -> leave this console window open when done
REM    scripts\verify-build.cmd -h         -> usage
REM
REM  Console window: this script closes its OWN console window once the app is
REM  up. That matters because "start <file>.cmd" (Windows itself, and MTNode's
REM  execute node which launches via "cmd /c start "" target") opens the batch
REM  with cmd.exe /K, and /K keeps the window alive after the batch ends -
REM  leaving a dead console behind. A shell the script was typed into is a
REM  guest window and is never touched. Use -Keep to opt out.
REM
REM  Fixed output path (no timestamp - same folder every run):
REM    <parent of project root>\pipeline-console-verify
REM    e.g. E:\dev\tools\pipeline-console-verify\win-unpacked\MTNodeAIO.exe
REM  It sits OUTSIDE the repo on purpose: no repo pollution, no dist\
REM  write, and it survives %TEMP% cleanup so the exe stays findable.
REM
REM  Compared with existing scripts:
REM    - scripts\agent-rebuild.cmd kills MTNode and rebuilds dist\ (use it to
REM      REPLACE the running app). This script never kills the user's running
REM      instance and never writes dist\, it only produces a second copy.
REM    - It DOES stop a previous verify instance started from the same fixed
REM      output folder, because Windows locks that exe while it runs and the
REM      next build would fail with a file-in-use error. The check is scoped
REM      strictly to that folder (path prefix), so dist\win-unpacked is safe.
REM    - ..\build.js --dir also writes dist\ and kills locks; not for verify.
REM
REM  NOTE 1: keep this file pure ASCII. cmd.exe mis-parses non-ASCII bytes,
REM          which breaks the script.
REM  NOTE 2: never put a literal "(" or ")" inside an echo that sits in an
REM          if-block - cmd.exe counts it as a block boundary and derails the
REM          whole branch. Keep branch bodies flat and bracket-free.
REM  NOTE 3: closing the window must use a BARE "exit" (no /b) - with /K only
REM          that ends the cmd.exe process, which is what destroys the window.
REM          Whether this window is ours is decided by %CMDCMDLINE% (a launcher
REM          that named this script owns the window; a shell we were typed into
REM          does not), compared by string substitution so no shell character
REM          from the command line can break the test.
REM ============================================================

set "ROOT=%~dp0.."
pushd "%ROOT%" || goto noroot
set "ROOT=%CD%"

REM ---------------- fixed output path ----------------
for %%I in ("%ROOT%\..") do set "PARENT=%%~fI"
set "OUT=%PARENT%\pipeline-console-verify"

REM ---------------- arguments ----------------
set "RUN_AFTER=1"
set "SAME_DATA=0"
set "CLEAN=0"
set "KEEP=0"

:parse
if "%~1"=="" goto parsed
REM branch bodies below only run set/shift/goto - no echo text, so the cmd.exe
REM if-block bracket rule cannot be tripped here.
if /I "%~1"=="-Run" (
  set "RUN_AFTER=1"
  shift
  goto parse
)
if /I "%~1"=="-NoRun" (
  set "RUN_AFTER=0"
  shift
  goto parse
)
if /I "%~1"=="-SameData" (
  set "SAME_DATA=1"
  shift
  goto parse
)
if /I "%~1"=="-Clean" (
  set "CLEAN=1"
  shift
  goto parse
)
if /I "%~1"=="-Keep" (
  set "KEEP=1"
  shift
  goto parse
)
if /I "%~1"=="-Out" (
  set "OUT=%~2"
  shift
  shift
  goto parse
)
if /I "%~1"=="-h" goto usage
if /I "%~1"=="--help" goto usage
if /I "%~1"=="/?" goto usage
echo [verify-build] unknown argument: %~1
goto usage

:parsed
if defined OUT goto out_ready
set "OUT=%PARENT%\pipeline-console-verify"
goto out_ready

:out_ready
REM ---------------- does this console window belong to this script? ----------------
REM A launcher that put this script on the cmd command line ("clicked", "start
REM file.cmd" -> cmd /K, "cmd /c file.cmd") owns a window that exists only for
REM this run: closing it at the end is exactly what the user wants. A shell we
REM were typed into has a bare "cmd.exe" command line, so its window is left
REM alone. String substitution is used instead of echo|find so that no quote,
REM "&" or "(" coming from the command line can derail the test.
set "OWNS_CONSOLE=0"
set "CL=!CMDCMDLINE!"
set "CL_NAKED=!CL:%~nx0=!"
if not "!CL_NAKED!"=="!CL!" set "OWNS_CONSOLE=1"

REM ---------------- preflight ----------------
if not exist "node_modules\electron-builder\cli.js" goto no_builder
if not exist "build.json" goto no_config

set "APPVER="
for /f "usebackq delims=" %%v in ("version") do set "APPVER=%%v"
set "APPVER=!APPVER: =!"

echo ============================================================
echo [verify-build] project root : %ROOT%
echo [verify-build] version      : v!APPVER!
echo [verify-build] output       : !OUT!   [FIXED path, reused every run, not dist]
echo [verify-build] command      : electron-builder --win --dir --config build.json
echo [verify-build]                --config.directories.output=!OUT!
echo [verify-build] no taskkill on the running app, no writes into dist\
if "!OWNS_CONSOLE!"=="1" echo [verify-build] console       : own window - closes itself when done
if not "!OWNS_CONSOLE!"=="1" echo [verify-build] console       : guest shell - window is left open
echo ============================================================

tasklist /FI "IMAGENAME eq MTNodeAIO.exe" 2>nul | find /I "MTNodeAIO.exe" >nul
if not errorlevel 1 echo [i] MTNodeAIO.exe is running - leaving it alone unless it lives in the output folder

where node >nul 2>&1
if errorlevel 1 goto no_node

REM ---------------- release the fixed output folder ----------------
REM Strictly path-scoped: only processes whose exe lives under !OUT! are
REM stopped (that is last run's verify copy). The user's dist\win-unpacked
REM instance does not match this prefix and is never touched.
set "MTNODE_VERIFY_OUT=!OUT!"
powershell -NoProfile -Command "$o=$env:MTNODE_VERIFY_OUT; $p=@(Get-Process -Name MTNodeAIO -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($o,[System.StringComparison]::OrdinalIgnoreCase) }); if ($p.Count -gt 0) { Write-Host ('[verify-build] stopping previous verify instance from the output folder: ' + $p.Count + ' process'); $p | Stop-Process -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 2 }"

if not "!CLEAN!"=="1" goto clean_done
if not exist "!OUT!" goto clean_done
echo [verify-build] -Clean: wiping !OUT!
rd /s /q "!OUT!"
if exist "!OUT!" goto clean_failed
goto clean_done

:clean_failed
echo [verify-build] could not remove !OUT! - close the app started from it and retry
goto fail

:clean_done
if not exist "!OUT!" mkdir "!OUT!"

REM ---------------- build ----------------
REM Same env as build.js: CN mirrors + no code-sign probing; clear pet-role vars.
set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
set "ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/"
set "CSC_IDENTITY_AUTO_DISCOVERY=false"
set "MTNODE_ROLE="
set "MTNODE_PARENT_PID="
set "MTNODE_PET_DATA="
REM MTNode's own Agent/terminal environment carries ELECTRON_RUN_AS_NODE=1. If the
REM verify build inherits it, Electron runs as plain node, prints "bad option" and
REM exits immediately instead of showing a window. Clear it so the auto-open works.
set "ELECTRON_RUN_AS_NODE="
REM Keep this set to 1 for the launched copy: Electron otherwise attaches itself
REM to the console it was started from, and an attached process keeps that
REM console window alive for as long as the app runs - the window could then
REM never close itself. Measured: with this set the window closes, without it
REM the conhost and its window survive until the app exits.
set "ELECTRON_NO_ATTACH_CONSOLE=1"

echo.
echo [verify-build] compiling - first run is slow, output is a few hundred MB ...
node "node_modules\electron-builder\cli.js" --win --dir --config build.json --config.directories.output="!OUT!" --publish never
if errorlevel 1 goto build_failed

set "EXE=!OUT!\win-unpacked\MTNodeAIO.exe"
if not exist "!EXE!" goto artifact_missing

if exist "!OUT!\win-unpacked\resources\app-update.yml" goto yml_ok
echo [warn] resources\app-update.yml missing - afterPack did not write it; updater would ENOENT at runtime
goto yml_done

:yml_ok
echo [ok] resources\app-update.yml present

:yml_done
echo.
echo ============================================================
echo [verify-build] build OK  v!APPVER!
echo [verify-build] artifact  : !EXE!
echo ============================================================

REM ---------------- auto open ----------------
if not "!RUN_AFTER!"=="1" goto launch_done
set "MTNODE_VERIFY_EXE=!EXE!"
if not "!SAME_DATA!"=="1" goto launch_isolated

echo [i] launching with the CURRENT data directory - same config and workflows
goto launch_now

:launch_isolated
set "MTNODE_DATA_DIR=!OUT!\userdata"
echo [i] launching with an ISOLATED data dir: !MTNODE_DATA_DIR!
echo [i] the running instance keeps its own data and the app folder untouched

:launch_now
REM Start-Process (not "start"): "start" lets the GUI inherit this process'
REM stdout pipe, so a caller that captures output would hang until the app
REM exits. Then poll for the app's own top-level window, so this console is
REM closed exactly when the user can really see MTNode; 60 s cap and a window
REM that never shows is a warning, not an error. Only processes running THIS
REM exe match, so the instance the user already has is not confused with it.
REM Together with ELECTRON_NO_ATTACH_CONSOLE=1 above this is what actually
REM makes the window close while the verify copy keeps running.
powershell -NoProfile -Command "$e=$env:MTNODE_VERIFY_EXE; Start-Process -FilePath $e; for($i=0;$i -lt 120;$i++){ $p=@(Get-Process -Name MTNodeAIO -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path -ieq $e -and $_.MainWindowHandle -ne 0 }); if($p.Count -gt 0){ Write-Host '[i] app window is up'; exit 0 }; Start-Sleep -Milliseconds 500 }; Write-Host '[warn] app window not seen within 60 s - closing anyway'"

:launch_done
if "!RUN_AFTER!"=="1" echo [i] the verify copy is open - this console window closes itself
echo.
echo [verify-build] output folder: !OUT!
popd
if "!OWNS_CONSOLE!"=="1" if not "!KEEP!"=="1" goto close_console
endlocal
exit /b 0

:close_console
REM Bare "exit" ends this cmd.exe. When the window was opened for this script
REM that process is its only attached one, so the window disappears - which is
REM what is wanted, because "start file.cmd" runs batches with cmd.exe /K and
REM /K would otherwise leave the finished console on screen forever.
echo [i] closing this console window - the verify copy keeps running
endlocal
exit 0

:noroot
echo [verify-build] cannot enter project root
exit /b 1

:no_builder
echo [verify-build] node_modules\electron-builder is missing - run "npm install" first
goto fail
:no_config
echo [verify-build] build.json is missing
goto fail
:no_node
echo [verify-build] node was not found in PATH
goto fail

:build_failed
echo.
echo [verify-build] build FAILED. Usual causes: interrupted electron-builder binary
echo [verify-build] download, or not enough free disk space. Partial output: !OUT!
goto fail

:artifact_missing
echo [verify-build] builder reported success but the artifact is missing:
echo [verify-build]   !EXE!
goto fail

:usage
echo Usage:
echo   scripts\verify-build.cmd            build into the fixed path, then OPEN it
echo   scripts\verify-build.cmd -NoRun     build only, do not open
echo   scripts\verify-build.cmd -SameData  open with the current data dir
echo   scripts\verify-build.cmd -Clean     wipe the output folder first
echo   scripts\verify-build.cmd -Out ^<folder^>  explicit output folder
echo   scripts\verify-build.cmd -Keep      leave this console window open
echo.
echo This window closes itself when the app is up unless -Keep is given.
echo.
echo Fixed path: %%PARENT-of-project%%\pipeline-console-verify
popd
endlocal
exit /b 2

:fail
popd
endlocal
exit /b 1