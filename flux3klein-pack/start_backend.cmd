@echo off
setlocal
REM Manual launcher for the FLUX 3 Image Klein ComfyUI backend (port 8197).
REM The MTNode host starts the very same command itself (flux3klein/main-flux3klein.js);
REM use this only for debugging outside MTNode.
chcp 65001 >nul
set "PYTHONIOENCODING=utf-8"
set "PYTHONUNBUFFERED=1"
cd /d "%~dp0"
if not exist "ComfyUI\main.py" (
  echo [ERROR] ComfyUI missing. Run the plugin installer first.
  exit /b 1
)
if not exist "ComfyUI\venv\Scripts\python.exe" (
  echo [ERROR] venv missing. Run the plugin installer first.
  exit /b 1
)
echo Starting ComfyUI FLUX 3 Image Klein on 127.0.0.1:8197 ...
cd ComfyUI
venv\Scripts\python.exe main.py --listen 127.0.0.1 --port 8197 --disable-auto-launch %*
