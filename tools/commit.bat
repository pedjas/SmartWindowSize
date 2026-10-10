@echo off
rem SmartWindowSize coordinated local-commit entry point.
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0commit.ps1"
set "COMMIT_EXIT_CODE=%ERRORLEVEL%"
if not "%COMMIT_EXIT_CODE%"=="0" echo Review the commit workflow message above.
pause
endlocal & exit /b %COMMIT_EXIT_CODE%
