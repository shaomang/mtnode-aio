@echo off
setlocal
cd /d "%~dp0.."
echo [ext] build catalog
node ext-repo\build.mjs
if errorlevel 1 exit /b 1
echo [ext] upload
where python >nul 2>&1
if %errorlevel%==0 (
  python ext-repo\upload.py
) else (
  py -3 ext-repo\upload.py
)
exit /b %errorlevel%
