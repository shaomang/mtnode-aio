@echo off
REM Breeze TTS 2 local management service (for manual start; the MTNode plugin uses the same entry point)
REM Default port is 8772, override it with the first argument: start_backend.cmd 8773
setlocal
chcp 65001 >nul
cd /d "%~dp0"
set PYTHONUNBUFFERED=1
set PYTHONIOENCODING=utf-8
set HF_ENDPOINT=https://hf-mirror.com
set HF_HUB_DISABLE_XET=1
set BREEZE_API_PORT=%~1
if "%BREEZE_API_PORT%"=="" set BREEZE_API_PORT=8772
".venv\Scripts\python.exe" -m app %BREEZE_API_PORT%
