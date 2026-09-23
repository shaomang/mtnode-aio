@echo off
REM ===========================================================================
REM SenseNova（SenseNova-U1.5-8B-MoT）本地图像生成后端 —— 手工启动入口
REM   正常由 MTNode 负责启停，本脚本只用于自查 / 契约冒烟，**不要常驻**。
REM
REM   用法（本目录下）：start_backend.cmd           -> 默认端口 8774
REM                     start_backend.cmd 8899      -> 指定端口
REM
REM   首次使用请先安装（全程国内镜像）：
REM     powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1 -InstallDir .
REM
REM   常用环境变量（都在命令行里设，或直接改本文件）：
REM     SENSENOVA_PORT          端口（默认 8774）
REM     SENSENOVA_MODEL_DIR     权重目录（默认自动探测 .\models\SenseNova__SenseNova-U1.5-8B-MoT）
REM     SENSENOVA_VRAM_MODE     fast（默认，24G 卡档）/ balanced / low / full（需 48G+）
REM     SENSENOVA_DTYPE         bfloat16（默认）/ float16 / float32
REM     SENSENOVA_ATTN_BACKEND  sdpa（默认，Windows 无 flash-attn 轮子）/ auto / flash
REM     SENSENOVA_DEVICE        cuda / cuda:0 / cpu（空 = 自动）
REM     MTNODE_SENSENOVA_MOCK   1 = 不加载模型、只造占位 PNG（联调用）
REM
REM   显存不够时的降档顺序（真实故障排查口径，详见 SKILL: sensenova-local-install）：
REM     fast -> balanced -> low；再不够就先关掉 H3 / Music3 等占显存的后端。
REM ===========================================================================
setlocal EnableExtensions
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
echo          （首次含权重加载，24G 卡上要等几分钟，客户端超时要放到 10 分钟级）
echo.

".venv\Scripts\python.exe" -m app %*
set "ERR=%ERRORLEVEL%"
if not "%ERR%"=="0" (
  echo.
  echo [ERROR] Backend exited with code %ERR%
  echo   2 = 端口被占用：换端口（start_backend.cmd 8899）或杀掉占用 8774 的进程
  echo   其它 = 看上面的 traceback / 跑 scripts\install.ps1 的自检段
  pause
)
exit /b %ERR%
