@echo off
rem Build (if not built yet) and run the Pascal editor project.
rem Usage: run-editor.cmd [project-dir]
setlocal

if "%~1"=="" (
  set "PROJECT=E:\dev\editor-main\editor-main"
) else (
  set "PROJECT=%~1"
)

if not exist "%PROJECT%\package.json" (
  echo [ERROR] Not a project folder: "%PROJECT%"
  exit /b 1
)

cd /d "%PROJECT%"
if errorlevel 1 (
  echo [ERROR] Cannot enter "%PROJECT%"
  exit /b 1
)

set "BUN="
where bun >nul 2>nul
if not errorlevel 1 set "BUN=bun"
if not defined BUN if exist "%USERPROFILE%\.bun\bin\bun.exe" set "BUN=%USERPROFILE%\.bun\bin\bun.exe"
if not defined BUN goto install_bun

:have_bun
echo [info] project : %PROJECT%
echo [info] bun     : %BUN%

if exist "node_modules\.bin" goto run_dev

echo [setup] dependencies missing, running bun install ...
call "%BUN%" install
if not errorlevel 1 goto run_dev

rem The root postinstall uses POSIX test syntax that Bun's Windows shell cannot
rem run, so fall back to installing without lifecycle scripts and run the one
rem package postinstall that matters here by hand.
echo [setup] bun install failed in a lifecycle script, retrying with --ignore-scripts ...
call "%BUN%" install --ignore-scripts
if errorlevel 1 (
  echo [ERROR] bun install failed
  exit /b 1
)
if exist "apps\ifc-converter\scripts\copy-web-ifc-wasm.mjs" (
  pushd "apps\ifc-converter"
  node scripts\copy-web-ifc-wasm.mjs
  popd
)

:run_dev
echo [run] starting dev server ^(http://localhost:3002^) ...
call "%BUN%" run dev
exit /b %errorlevel%

:install_bun
where npm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Neither bun nor npm found in PATH. Install Bun: https://bun.sh/
  exit /b 1
)
echo [setup] bun not found, installing bun@1.4.4 via npm ...
call npm install -g bun@1.4.4
if errorlevel 1 (
  echo [ERROR] Failed to install bun. Install it manually: https://bun.sh/
  exit /b 1
)
set "BUN=bun"
where bun >nul 2>nul
if not errorlevel 1 goto have_bun
if exist "%USERPROFILE%\.bun\bin\bun.exe" set "BUN=%USERPROFILE%\.bun\bin\bun.exe"
goto have_bun
