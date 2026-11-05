@echo off
REM ===========================================================================
REM MOSS-Music local backend -- manual start entry.
REM   MTNode normally starts/stops it (detached singleton, port 8790); use this
REM   only for a manual check. Extra args are forwarded to app\server.py, e.g.:
REM     start_backend.cmd --port 8791
REM     start_backend.cmd --check
REM   Runtime defaults come from .env next to this file (written by the installer).
REM ===========================================================================
setlocal EnableExtensions
chcp 65001 >nul
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
  echo [ERROR] Missing .venv. Run:
  echo   powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1 -InstallDir .
  pause
  exit /b 1
)

if not defined HF_ENDPOINT set "HF_ENDPOINT=https://hf-mirror.com"
set "HF_HUB_DISABLE_XET=1"
set "PYTHONIOENCODING=utf-8"
set "PYTHONUNBUFFERED=1"

echo Starting MOSS-Music backend...
echo   entry     : app\server.py
echo   URL       : http://127.0.0.1:8790
echo   endpoints : /health /load /unload /generate
echo   models    : %CD%\models
echo.

".venv\Scripts\python.exe" "app\server.py" --install-dir "%CD%" %*
set "ERR=%ERRORLEVEL%"
if not "%ERR%"=="0" (
  echo.
  echo [ERROR] Backend exited with code %ERR%
  pause
)
exit /b %ERR%
