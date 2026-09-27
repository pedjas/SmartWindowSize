@echo off
rem SmartWindowSize Draft Release entry point. Runs the guarded PowerShell release procedure.

setlocal

rem Launch the guarded Draft Release procedure from the directory containing this file.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0release.ps1"

rem Preserve the PowerShell result after the command so this launcher returns the same outcome.
set "RELEASE_EXIT_CODE=%ERRORLEVEL%"

if not "%RELEASE_EXIT_CODE%"=="0" (
    echo.
    echo The Draft Release was not created. Review the message above.
) else (
    echo.
    echo The Draft Release was created. Review and publish it manually on GitHub.
)

pause
endlocal & exit /b %RELEASE_EXIT_CODE%
