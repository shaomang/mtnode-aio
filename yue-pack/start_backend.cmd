@echo off
REM ===========================================================================
REM YuE2 local music generation backend -- manual start entry (MTNode normally starts/stops it; do not keep it resident)
REM   Usage (from this directory): start_backend.cmd          -> default port 8773
REM                                start_backend.cmd 8899     -> explicit port
REM   Entry contract: the host (the MTNode plugin) only runs  -m app.ui  (the Gradio UI entry);
REM                   this script runs                         -m app     (stdlib HTTP service, for self-check / contract smoke).
REM   If gradio is missing, install it first:
REM     ".venv\Scripts\python.exe" -m pip install --isolated gradio ^
REM       -i https://pypi.tuna.tsinghua.edu.cn/simple --trusted-host pypi.tuna.tsinghua.edu.cn
REM   Environment: YUE2_PORT / YUE2_MODEL_DIR / YUE2_DEVICE / MTNODE_YUE2_MOCK ...
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

".venv\Scripts\python.exe" -c "import gradio" >nul 2>nul
if errorlevel 1 (
  echo [WARN] Gradio missing - install it first ^(do NOT re-download model weights^):
  echo   ".venv\Scripts\python.exe" -m pip install --isolated gradio -i https://pypi.tuna.tsinghua.edu.cn/simple --trusted-host pypi.tuna.tsinghua.edu.cn
  echo.
)

if not defined HF_ENDPOINT set "HF_ENDPOINT=https://hf-mirror.com"
set "HF_HUB_DISABLE_XET=1"
set "PYTHONIOENCODING=utf-8"
set "PYTHONUNBUFFERED=1"

echo Starting YuE2 backend...
echo   entry      : -m app  ^(self-check HTTP service; host uses -m app.ui Gradio UI^)
echo   URL        : http://127.0.0.1:8773
echo   endpoints  : /health /generate /progress /cancel /shutdown
echo   model dir  : %CD%\models
echo   default out: %CD%\outputs
echo.

".venv\Scripts\python.exe" -m app %*
set "ERR=%ERRORLEVEL%"
if not "%ERR%"=="0" (
  echo.
  echo [ERROR] Backend exited with code %ERR%
  pause
)
exit /b %ERR%
