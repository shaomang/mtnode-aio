@echo off
setlocal EnableExtensions
cd /d "%~dp0.."

if not exist ".venv\Scripts\python.exe" (
  echo [ERROR] Missing .venv. Run: scripts\setup_env.ps1
  pause
  exit /b 1
)

if not defined HF_ENDPOINT set "HF_ENDPOINT=https://hf-mirror.com"
set "HF_HUB_DISABLE_XET=1"

echo Starting MiniMax Music 3 backend...
echo URL: http://127.0.0.1:7860
echo Output dir default: %CD%\output
echo.
".venv\Scripts\python.exe" -m app.ui %*
set "ERR=%ERRORLEVEL%"
if not "%ERR%"=="0" (
  echo.
  echo [ERROR] Backend exited with code %ERR%
  pause
)
exit /b %ERR%
