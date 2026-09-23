@echo off
REM ===========================================================================
REM YuE2 本地音乐生成后端 —— 手工启动入口（正常由 MTNode 负责启停，不要常驻）
REM   用法（本目录下）：start_backend.cmd           -> 默认端口 8773
REM                     start_backend.cmd 8899      -> 指定端口
REM   入口口径：宿主（MTNode 插件）只跑  -m app.ui  （Gradio UI 入口）；
REM             本脚本走             -m app     （标准库 HTTP 服务，用于自查 / 契约冒烟）。
REM   缺 gradio 时先补装：
REM     ".venv\Scripts\python.exe" -m pip install --isolated gradio ^
REM       -i https://pypi.tuna.tsinghua.edu.cn/simple --trusted-host pypi.tuna.tsinghua.edu.cn
REM   环境变量：YUE2_PORT / YUE2_MODEL_DIR / YUE2_DEVICE / MTNODE_YUE2_MOCK ...
REM ===========================================================================
setlocal EnableExtensions
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
