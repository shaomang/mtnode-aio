@echo off
setlocal
cd /d "%~dp0"

REM npm registry: registry.npmmirror.com is the default (China-friendly).
REM   --official         switch back to the official https://registry.npmjs.org
REM   --mirror           kept for compatibility: npmmirror is the default now
REM   --registry=<url>   use a custom registry
set "REGISTRY=--registry=https://registry.npmmirror.com"
if /i "%~1"=="--official" set "REGISTRY=--registry=https://registry.npmjs.org"
if /i "%~1"=="--mirror" set "REGISTRY=--registry=https://registry.npmmirror.com"
set "ARG1=%~1"
echo %ARG1% | findstr /b /i /c:"--registry=" >nul && set "REGISTRY=%ARG1%"

echo [remotion-pack] npm install %REGISTRY%
call npm install %REGISTRY%
if errorlevel 1 (
  echo [remotion-pack] npm install FAILED
  exit /b 1
)

echo [remotion-pack] install OK. Fill render.json, then run: node render.mjs
endlocal
