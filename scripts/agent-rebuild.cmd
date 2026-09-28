@echo off
setlocal EnableExtensions
REM Agent helper: kill MTNode → compile win-unpacked → relaunch (no pause).
REM Usage: scripts\agent-rebuild.cmd
cd /d "%~dp0.."

set MTNODE_ROLE=
set MTNODE_PARENT_PID=
set MTNODE_PET_DATA=

set "FLAG=%CD%\.cursor\mtnode-rebuild-needed"

echo [agent-rebuild] stopping MTNodeAIO / electron...
taskkill /F /IM MTNodeAIO.exe /T >nul 2>&1
taskkill /F /IM electron.exe /T >nul 2>&1
timeout /t 2 /nobreak >nul

echo [agent-rebuild] compile (node ..\build.js --dir)...
node "%~dp0..\..\build.js" --dir
if errorlevel 1 (
  echo [agent-rebuild] COMPILE FAILED
  endlocal
  exit /b 1
)

set "EXE=%CD%\dist\win-unpacked\MTNodeAIO.exe"
if not exist "%EXE%" (
  echo [agent-rebuild] missing %EXE%
  endlocal
  exit /b 1
)

echo [agent-rebuild] launching %EXE%
start "" "%EXE%"
if exist "%FLAG%" del /f /q "%FLAG%" >nul 2>&1
echo [agent-rebuild] done
endlocal
exit /b 0
