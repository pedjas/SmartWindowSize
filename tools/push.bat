@echo off
rem SmartWindowSize coordinated push entry point. It pushes only already committed work.
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0push.ps1"
set "PUSH_EXIT_CODE=%ERRORLEVEL%"
if not "%PUSH_EXIT_CODE%"=="0" (
    echo.
    echo The coordinated push did not complete. Review the message above.
)
pause
endlocal & exit /b %PUSH_EXIT_CODE%
