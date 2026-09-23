@echo off
setlocal EnableExtensions

REM ===========================================================================
REM  MTNode AI Orchestrator - Microsoft Store (MSIX) packaging entry point
REM
REM  This file is only an entry point; it does NOT copy any packaging logic:
REM    - release chain : scripts\release.mjs         (version check, publish, upload guide)
REM    - packer        : scripts\msix\make-msix.mjs  (SDK probe, build, makeappx pack, self-check)
REM  Change behavior in those two scripts. Uploading is still manual (drag into
REM  Partner Center; this chain never auto-uploads).
REM  Manual: docs\msix-store-publish.md
REM
REM  Console output is QUIET by default: the full output of node / electron-builder
REM  goes into a log file, and the console only prints the step headings, the tail
REM  of that log and the log path - no scrolling wall of text.
REM    - add -v / --verbose (or set MTNODE_MSIX_VERBOSE=1) to stream everything
REM    - dry run and pack --help / --dump-manifest always print in full, because
REM      printing that text is the whole point of those modes
REM
REM  Usage:
REM    release-msix.cmd                 full Store release (default, = npm run release:store)
REM                                     version check, build content, pack .msix, self-check,
REM                                     copy into dist\msix-publish\ and print the upload guide
REM    release-msix.cmd -v              same, but stream the full console output
REM    release-msix.cmd --dry-run       dry run: version check and step list only, no build/pack
REM    release-msix.cmd -v --dry-run    dry run with the full console output
REM    release-msix.cmd pack [flags]    pack only: flags are forwarded to make-msix.mjs
REM                                     pack --skip-build     reuse existing dist\win-unpacked
REM                                     pack --install-test   self-sign and print local test steps
REM                                     pack --dump-manifest  print AppxManifest.xml only
REM                                     pack --help           list all make-msix flags
REM    release-msix.cmd help            show this help
REM
REM  Requires Windows 10/11 SDK (makeappx.exe); fill scripts\msix\msix.config.json first.
REM  Output lands in dist\msix-publish\ as a .msix named after identityName and version;
REM  drag that file into the Partner Center upload box.
REM  Closes automatically on success; pauses on failure to keep the error visible.
REM  Quiet-mode log file: %TEMP%\mtnode-msix-last.log
REM ===========================================================================

REM Locate the project root: works when this script sits in the project root or
REM one level above it (a sibling folder named pipeline-console).
set "ROOT=%~dp0"
if not exist "%ROOT%scripts\msix\make-msix.mjs" (
  if exist "%ROOT%pipeline-console\scripts\msix\make-msix.mjs" set "ROOT=%~dp0pipeline-console\"
)
cd /d "%ROOT%"

if not exist "%ROOT%scripts\msix\make-msix.mjs" (
  echo [release-msix] FAILED: scripts\msix\make-msix.mjs not found
  echo                run this script from the project root ^(pipeline-console or its parent^).
  set "RC=1"
  goto :fail
)
if not exist "%ROOT%scripts\release.mjs" (
  echo [release-msix] FAILED: scripts\release.mjs not found
  set "RC=1"
  goto :fail
)
where node >nul 2>&1
if errorlevel 1 (
  echo [release-msix] FAILED: node not found in PATH ^(Node.js 22.19+ required^).
  set "RC=1"
  goto :fail
)

REM ---------- optional -v / --verbose in front of the mode word ----------
set "VERBOSE="
if defined MTNODE_MSIX_VERBOSE set "VERBOSE=1"
if /i "%~1"=="-v" goto :verbose_shift
if /i "%~1"=="--verbose" goto :verbose_shift
goto :dispatch

:verbose_shift
set "VERBOSE=1"
shift

:dispatch
set "MODE=%~1"
if /i "%MODE%"=="pack"       goto :pack
if /i "%MODE%"=="store"      goto :store
if     "%MODE%"=="--dry-run" goto :dryrun
if /i "%MODE%"=="help"       goto :usage
if /i "%MODE%"=="-h"         goto :usage
if /i "%MODE%"=="--help"     goto :usage
if /i "%MODE%"=="/?"         goto :usage
if not "%MODE%"==""          goto :unknown

REM ---------- default: full Store release chain ----------
:store
if /i "%~2"=="--dry-run" goto :dryrun
if not "%~2"=="" goto :unknown
set "STEP=Store release chain - scripts\release.mjs --store-only"
set "NODE_ARGS="%ROOT%scripts\release.mjs" --store-only"
goto :run

REM ---------- dry run: version check and step list only (its text IS the output) ----------
:dryrun
set "STEP=dry run - scripts\release.mjs --store-only --dry-run"
set "NODE_ARGS="%ROOT%scripts\release.mjs" --store-only --dry-run"
set "VERBOSE=1"
goto :run

REM ---------- pack only: forward flags to make-msix.mjs ----------
:pack
set "NODE_ARGS="%ROOT%scripts\msix\make-msix.mjs""
set "PACK_ARGS="
:pack_args
shift
if "%~1"=="" goto :pack_ready
set "PACK_ARGS=%PACK_ARGS% "%~1""
goto :pack_args
:pack_ready
set "STEP=pack only - scripts\msix\make-msix.mjs%PACK_ARGS%"
set "NODE_ARGS=%NODE_ARGS%%PACK_ARGS%"
REM pack --help / --dump-manifest exist only to print text: never hide them
echo %PACK_ARGS%|findstr /i /c:"--help" /c:"-h" /c:"--dump-manifest" >nul
if not errorlevel 1 set "VERBOSE=1"
goto :run

REM ---------- run: quiet by default, full stream with -v ----------
:run
if defined VERBOSE goto :run_verbose

if not defined TEMP set "TEMP=%LOCALAPPDATA%\Temp"
set "LOG=%TEMP%\mtnode-msix-last.log"
echo [release-msix] %STEP%
echo [release-msix] quiet mode - the build output goes to the log, the window stays silent until it ends
echo [release-msix] log: %LOG%
echo [release-msix] ^(add -v for the full stream; Ctrl+C aborts^)
echo.
node %NODE_ARGS% > "%LOG%" 2>&1
set "RC=%ERRORLEVEL%"
call :quiet_report
if not "%RC%"=="0" goto :fail
goto :done

:run_verbose
echo [release-msix] %STEP%
echo.
node %NODE_ARGS%
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" goto :fail
goto :done

REM ---------- quiet report: step headings + tail of the log ----------
REM The log is UTF-8 (node writes UTF-8 when stdout is not a console), so flip the
REM console to UTF-8 just while printing it and restore the original code page:
REM the build itself ran under the code page the console already had.
:quiet_report
REM the code page number is the last word of the (localized) chcp output
set "OLDCP="
for /f "tokens=*" %%L in ('chcp') do for %%A in (%%L) do set "OLDCP=%%A"
echo %OLDCP%|findstr /r "^[0-9][0-9]*$" >nul
if errorlevel 1 set "OLDCP="
chcp 65001 >nul
echo.
echo [release-msix] steps:
findstr /r /c:"^\[[0-9]" /c:"^\[release" /c:"^\[make-msix" "%LOG%"
echo.
echo [release-msix] tail of the log:
set "SKIP=0"
for /f %%C in ('find /c /v "" ^< "%LOG%"') do set /a SKIP=%%C-30
if %SKIP% lss 0 set "SKIP=0"
more +%SKIP% "%LOG%" | findstr /r /c:"^"
if defined OLDCP chcp %OLDCP% >nul
goto :eof

REM ---------- unknown argument ----------
:unknown
echo [release-msix] FAILED: unknown argument "%MODE%"
echo.
goto :usage_fail

REM ---------- help ----------
:usage
echo.
echo MTNode AI Orchestrator - Microsoft Store (MSIX) packaging
echo.
echo Usage:
echo   release-msix.cmd                 full Store release (default, = npm run release:store)
echo                                     version check, build, pack .msix, self-check,
echo                                     then dist\msix-publish\ plus the upload guide
echo   release-msix.cmd -v              same, but stream the full console output
echo   release-msix.cmd --dry-run       dry run: version check and step list only, full output
echo   release-msix.cmd pack [flags]    pack only: flags forwarded to make-msix.mjs
echo                                     pack --skip-build     reuse existing dist\win-unpacked
echo                                     pack --install-test   self-sign plus local test steps
echo                                     pack --dump-manifest  print AppxManifest.xml only
echo                                     pack --help           list all make-msix flags
echo   release-msix.cmd help            show this help
echo.
echo Quiet by default: the build output goes to %TEMP%\mtnode-msix-last.log and the
echo console only prints the step headings, the tail of that log and its path.
echo Add -v (or set MTNODE_MSIX_VERBOSE=1) to stream everything instead.
echo.
echo Requires Windows 10/11 SDK (makeappx.exe); fill scripts\msix\msix.config.json first.
echo Output: a .msix in dist\msix-publish\ - drag it into the Partner Center upload box.
echo Manual: docs\msix-store-publish.md
echo.
endlocal
exit /b 0

:usage_fail
call :usage
endlocal
exit /b 2

:done
echo.
echo [release-msix] done - closing window
if defined LOG echo [release-msix] full log: %LOG%
endlocal
exit /b 0

:fail
if not defined RC set "RC=%ERRORLEVEL%"
echo.
echo [release-msix] ABORTED (exit code %RC%) - press any key to close
if defined LOG echo [release-msix] full log: %LOG%
pause >nul
endlocal
exit /b 1
