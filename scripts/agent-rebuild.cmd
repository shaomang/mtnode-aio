@echo off
setlocal EnableExtensions
REM One code page for the whole run: build.js prints Chinese and the log is read by
REM humans afterwards. Without this the console CP and PowerShell's decoder disagree and
REM the log ends up with mojibake (and, worse, two different encodings in one file).
chcp 65001 >nul 2>&1
REM MTNode rebuild helper: (wait for the running app to exit) -> compile win-unpacked -> relaunch.
REM Usage: scripts\agent-rebuild.cmd [--wait-pid <pid>] [--no-relaunch] [--dry-run]
REM
REM --wait-pid   wait until that process id is gone before touching dist\win-unpacked.
REM              The statusbar button passes the app's own pid here: the app quits first,
REM              so this script must NOT kill its own process tree (a /T kill of the still
REM              running app would take the console window down with it).
REM --no-relaunch compile only, never start the exe.
REM --relaunch-only skip wait/kill/compile, only start the exe (checks the launch path).
REM --ack <path>  touch this file as soon as the script is really running. The app waits
REM              for it before quitting, so a console window that never opened cannot
REM              leave the user with no window and no build.
REM --dry-run     stop right after the wait: print what it would do, touch nothing.
REM
REM Keep this file pure ASCII: it runs inside a plain cmd console on an ANSI code page.
REM NOTE: take %~dp0 into HERE *before* parsing arguments. `shift` also moves %0, so
REM %~dp0 read after a shift resolves against an argument instead of this file
REM (seen here: "--wait-pid 1234" made the script look for E:\build.js).

set "HERE=%~dp0"
cd /d "%HERE%.."

set "WAITPID="
set "NOREL=0"
set "DRY=0"
set "RELONLY=0"
set "ACK="
:parse
if "%~1"=="" goto parsed
if /I "%~1"=="--wait-pid" (
  set "WAITPID=%~2"
  shift
  shift
  goto parse
)
if /I "%~1"=="--ack" (
  set "ACK=%~2"
  shift
  shift
  goto parse
)
if /I "%~1"=="--no-relaunch" (
  set "NOREL=1"
  shift
  goto parse
)
if /I "%~1"=="--dry-run" (
  set "DRY=1"
  shift
  goto parse
)
if /I "%~1"=="--relaunch-only" (
  set "RELONLY=1"
  shift
  goto parse
)
shift
goto parse
:parsed

REM Log goes to the user data dir, never inside the app folder.
if defined MTNODE_DATA_DIR (
  set "LOGDIR=%MTNODE_DATA_DIR%\logs"
) else (
  set "LOGDIR=%APPDATA%\pipeline-console\logs"
)
if not exist "%LOGDIR%" mkdir "%LOGDIR%" >nul 2>&1
set "STAMP="
for /f "delims=" %%I in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmmss"') do set "STAMP=%%I"
if not defined STAMP set "STAMP=%RANDOM%"
set "LOG=%LOGDIR%\rebuild-%STAMP%.log"

set "EXE=%CD%\dist\win-unpacked\MTNodeAIO.exe"
set "FLAG=%CD%\.cursor\mtnode-rebuild-needed"

echo [agent-rebuild] log: %LOG%
echo [agent-rebuild] START %DATE% %TIME% pid=%WAITPID% > "%LOG%"
REM Tell the app "this window is alive and running": it only quits after seeing this file.
if defined ACK echo started>"%ACK%"

for %%I in ("%HERE%..\..\build.js") do set "BUILDJS=%%~fI"
if not exist "%BUILDJS%" (
  echo [agent-rebuild] ERROR: missing build.js: %BUILDJS%
  set "RC=1"
  goto fail
)
where node >nul 2>&1
if errorlevel 1 (
  echo [agent-rebuild] ERROR: node not found in PATH
  set "RC=1"
  goto fail
)

set "PS=powershell"
where powershell >nul 2>&1
if errorlevel 1 set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"

if not defined WAITPID goto stopped
echo [agent-rebuild] waiting for pid %WAITPID% to exit...
set "TRY=0"
:waitloop
set /a TRY+=1
tasklist /FI "PID eq %WAITPID%" 2>nul | find /I "%WAITPID%" >nul
if errorlevel 1 goto stopped
if %TRY% GEQ 120 (
  echo [agent-rebuild] ERROR: app pid %WAITPID% is still running after 120s, nothing done
  set "RC=1"
  goto fail
)
ping -n 2 127.0.0.1 >nul
goto waitloop

:stopped
if "%DRY%"=="1" (
  echo [agent-rebuild] dry-run: would stop leftover MTNodeAIO / electron
  echo [agent-rebuild] dry-run: would run "%BUILDJS%" --dir
  echo [agent-rebuild] dry-run: would start "%EXE%"
  echo [agent-rebuild] EXITCODE=0 %DATE% %TIME% >> "%LOG%"
  endlocal & exit /b 0
)
if "%RELONLY%"=="1" goto launch
echo [agent-rebuild] stopping leftover MTNodeAIO / electron...
taskkill /F /IM MTNodeAIO.exe /T >nul 2>&1
taskkill /F /IM electron.exe /T >nul 2>&1
ping -n 3 127.0.0.1 >nul

echo [agent-rebuild] compile build.js --dir ...
REM Tee to the log line by line in UTF-8: Tee-Object writes UTF-16, which turned the log
REM into a mix of encodings (and made it unreadable with any normal editor).
"%PS%" -NoProfile -ExecutionPolicy Bypass -Command "[Console]::OutputEncoding=[Text.Encoding]::UTF8; & { node '%BUILDJS%' --dir 2>&1 | ForEach-Object { $_; Add-Content -LiteralPath '%LOG%' -Value $_ -Encoding UTF8 }; exit $LASTEXITCODE }"
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
  echo [agent-rebuild] COMPILE FAILED rc=%RC%
  goto fail
)

if not exist "%EXE%" (
  echo [agent-rebuild] ERROR: missing %EXE%
  set "RC=1"
  goto fail
)
if "%NOREL%"=="1" (
  echo [agent-rebuild] done, no relaunch
  echo [agent-rebuild] EXITCODE=0 %DATE% %TIME% >> "%LOG%"
  endlocal & exit /b 0
)

REM Launch through relaunch-app.ps1: start it, then prove a new process is actually
REM up and stays up. A single bare `start` used to be the whole relaunch step, and when
REM it failed (fresh exe still being flushed, launcher race) the script exited 0 and the
REM user was left with no window -- exactly the "build finished but app never came back"
REM report this fixes.
:launch
echo [agent-rebuild] launching %EXE%
echo [agent-rebuild] launching %EXE% >> "%LOG%"
"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%HERE%relaunch-app.ps1" -Exe "%EXE%" -Log "%LOG%"
if errorlevel 1 goto launchfail
if exist "%FLAG%" del /f /q "%FLAG%" >nul 2>&1
echo [agent-rebuild] relaunched
echo [agent-rebuild] EXITCODE=0 %DATE% %TIME% >> "%LOG%"
endlocal & exit /b 0

:launchfail
echo.
echo [agent-rebuild] BUILD OK, but the app did not come back up.
echo [agent-rebuild] exe: %EXE%
echo [agent-rebuild] log: %LOG%
echo [agent-rebuild] Start it by hand with the path above and check the log.
echo [agent-rebuild] EXITCODE=1 %DATE% %TIME% >> "%LOG%"
pause
endlocal & exit /b 1

:fail
echo.
echo [agent-rebuild] FAILED rc=%RC% - full log: %LOG%
echo [agent-rebuild] EXITCODE=%RC% %DATE% %TIME% >> "%LOG%"
if "%NOREL%"=="1" goto failend
if exist "%EXE%" (
  echo [agent-rebuild] relaunching the previous build: %EXE%
  "%PS%" -NoProfile -ExecutionPolicy Bypass -File "%HERE%relaunch-app.ps1" -Exe "%EXE%" -Log "%LOG%"
) else (
  echo [agent-rebuild] the previous build is gone - electron-builder cleared dist\win-unpacked.
  echo [agent-rebuild] fix the error above, then run scripts\agent-rebuild.cmd by hand.
)
:failend
echo.
pause
endlocal & exit /b 1
