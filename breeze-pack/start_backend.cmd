@echo off
REM Breeze TTS 2 本地管理服务（手工启动用；MTNode 插件走同一个入口）
REM 端口默认 8772，可用第一个参数覆盖：start_backend.cmd 8773
setlocal
cd /d "%~dp0"
set PYTHONUNBUFFERED=1
set PYTHONIOENCODING=utf-8
set HF_ENDPOINT=https://hf-mirror.com
set HF_HUB_DISABLE_XET=1
set BREEZE_API_PORT=%~1
if "%BREEZE_API_PORT%"=="" set BREEZE_API_PORT=8772
".venv\Scripts\python.exe" -m app %BREEZE_API_PORT%
