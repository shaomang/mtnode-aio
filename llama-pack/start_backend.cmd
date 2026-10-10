@echo off
setlocal
REM Manual launcher. Forces UTF-8 output so the backend log (Chinese banners and
REM tracebacks included) does not turn into mojibake in the console or in the
REM MTNode plugin console, which decodes this process output as UTF-8.
chcp 65001 >nul
set "PYTHONIOENCODING=utf-8"
set "PYTHONUNBUFFERED=1"
cd /d "%~dp0"
if exist ".venv\Scripts\python.exe" (
  ".venv\Scripts\python.exe" -m app %*
) else (
  python -m app %*
)
