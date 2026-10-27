@echo off
setlocal
REM Manual launcher for the InfiniteTalk ComfyUI backend (port 8199).
REM The MTNode host starts the very same command itself (infinitetalk/main-infinitetalk.js);
REM use this only for debugging outside MTNode.
REM Force UTF-8 so the backend log does not turn into mojibake.
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
echo Starting ComfyUI InfiniteTalk on 127.0.0.1:8199 ...
cd ComfyUI
venv\Scripts\python.exe main.py --listen 127.0.0.1 --port 8199 --use-sage-attention --reserve-vram 1.0 --disable-auto-launch %*
