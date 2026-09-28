@echo off
cd /d E:\dev\tools\pipeline-console
echo [rebuild-detached] START %DATE% %TIME% > E:\dev\tools\pipeline-console\rebuild.log
call E:\dev\tools\pipeline-console\scripts\agent-rebuild.cmd >> E:\dev\tools\pipeline-console\rebuild.log 2>&1
echo [rebuild-detached] EXITCODE=%ERRORLEVEL% %DATE% %TIME% >> E:\dev\tools\pipeline-console\rebuild.log
exit /b %ERRORLEVEL%
