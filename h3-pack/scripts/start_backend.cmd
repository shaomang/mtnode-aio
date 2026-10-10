@echo off
setlocal
REM Manual launcher. Forces UTF-8 output so the backend log (ComfyUI prints its
REM own Chinese messages) does not turn into mojibake in the console or in the
REM MTNode plugin console, which decodes this process output as UTF-8.
chcp 65001 >nul
set "PYTHONIOENCODING=utf-8"
set "PYTHONUNBUFFERED=1"
cd /d "%~dp0.."
if not exist "ComfyUI\main.py" (
  echo [ERROR] ComfyUI missing. Run scripts\setup_env.ps1 first.
  exit /b 1
)
if not exist "ComfyUI\venv\Scripts\python.exe" (
  echo [ERROR] venv missing. Run scripts\setup_env.ps1 first.
  exit /b 1
)
echo Starting ComfyUI MiniMax H3 on 127.0.0.1:8188 ...
echo VAE decode stays on GPU; the MTNode workflow unloads the model via VRAM_Debug before VAE.
echo Do NOT pass --cpu-vae (causes a float/Half dtype error in VAEDecode).
cd ComfyUI
venv\Scripts\python.exe main.py --listen 127.0.0.1 --port 8188 --disable-pinned-memory --fp16-intermediates --reserve-vram 4 %*
