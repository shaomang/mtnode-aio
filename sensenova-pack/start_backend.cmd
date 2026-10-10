@echo off
REM ===========================================================================
REM SenseNova (SenseNova-U1.5-8B-MoT) local image generation backend -- manual start entry
REM   MTNode normally starts/stops it; this script is for self-check / contract smoke tests only. **Do not keep it running.**
REM
REM   Usage (from this directory): start_backend.cmd           -> default port 8774
REM                                start_backend.cmd 8899      -> explicit port
REM
REM   Install first (domestic mirrors throughout):
REM     powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1 -InstallDir .
REM
REM   Common environment variables (set them on the command line, or edit this file):
REM     SENSENOVA_PORT          port (default 8774)
REM     SENSENOVA_MODEL_DIR     weights dir (default: auto-detected .\models\SenseNova__SenseNova-U1.5-8B-MoT)
REM     SENSENOVA_VRAM_MODE     fast (default, 24G card tier) / balanced / low / full (needs 48G+)
REM     SENSENOVA_DTYPE         bfloat16 (default) / float16 / float32
REM     SENSENOVA_ATTN_BACKEND  sdpa (default; no flash-attn wheel on Windows) / auto / flash
REM     SENSENOVA_DEVICE        cuda / cuda:0 / cpu (empty = auto)
REM     MTNODE_SENSENOVA_MOCK   1 = do not load the model, write a placeholder PNG only (integration testing)
REM
REM   Step-down order when VRAM is short (the real troubleshooting order; see SKILL: sensenova-local-install):
REM     fast -> balanced -> low; still short: shut down the other VRAM-hungry backends first (H3 / Music3 ...).
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

if not exist "models\.ok" (
  echo [WARN] models\.ok missing - weights ^(32.66GB^) are probably incomplete.
  echo        Real generation will fail with model_load_failed until you finish:
  echo          powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1 -InstallDir .
  echo        ^(resume-safe: already downloaded shards are NOT re-downloaded^)
  echo.
)

echo Starting SenseNova backend (SenseNova-U1.5-8B-MoT)...
echo   entry      : -m app  ^(stdlib HTTP service; MTNode starts/stops this^)
echo   URL        : http://127.0.0.1:8774
echo   endpoints  : /health /generate /progress /cancel /shutdown
echo   model dir  : %CD%\models
echo   vram mode  : %SENSENOVA_VRAM_MODE%  ^(empty = fast^)
echo   attn       : %SENSENOVA_ATTN_BACKEND%  ^(empty = value in .attn-backend, else sdpa^)
echo   default out: %CD%\outputs
echo.
echo   smoke: curl -X POST http://127.0.0.1:8774/generate -H "Content-Type: application/json" ^
echo          -d "{\"prompt\":\"a red cube\",\"width\":2048,\"height\":2048,\"numSteps\":50}"
echo          (the first call loads the weights: expect minutes on a 24G card, so set the client timeout to 10 minutes)
echo.

".venv\Scripts\python.exe" -m app %*
set "ERR=%ERRORLEVEL%"
if not "%ERR%"=="0" (
  echo.
  echo [ERROR] Backend exited with code %ERR%
  echo   2 = port already in use: use another port ^(start_backend.cmd 8899^) or kill the process holding 8774
  echo   other = see the traceback above / run the self-check part of scripts\install.ps1
  pause
)
exit /b %ERR%
