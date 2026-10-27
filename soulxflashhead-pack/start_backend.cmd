@echo off
setlocal
REM Manual launcher for the SoulX-FlashHead Lite backend (port 8198).
REM The MTNode host starts the very same command itself (soulxflashhead/main-soulxflashhead.js);
REM use this only for debugging outside MTNode.
chcp 65001 >nul
set "PYTHONIOENCODING=utf-8"
set "PYTHONUNBUFFERED=1"
set "MT_FLASHHEAD_COMPILE=1"
cd /d "%~dp0"
if not exist "SoulX-FlashHead\mtnode_server.py" (
  echo [ERROR] backend missing. Run the plugin installer first.
  exit /b 1
)
if not exist "SoulX-FlashHead\venv\Scripts\python.exe" (
  echo [ERROR] venv missing. Run the plugin installer first.
  exit /b 1
)
echo Starting SoulX-FlashHead Lite on 127.0.0.1:8198 ...
SoulX-FlashHead\venv\Scripts\python.exe SoulX-FlashHead\mtnode_server.py --install-dir "%~dp0" --port 8198 %*
