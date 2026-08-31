@echo off
setlocal
cd /d "%~dp0"

set "REGISTRY="
if /i "%~1"=="--mirror" set "REGISTRY=--registry=https://registry.npmmirror.com"

echo [remotion-pack] npm install %REGISTRY%
call npm install %REGISTRY%
if errorlevel 1 (
  echo [remotion-pack] npm install FAILED
  exit /b 1
)

echo [remotion-pack] install OK. Fill render.json, then run: node render.mjs
endlocal
