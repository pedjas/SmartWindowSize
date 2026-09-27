@echo off
rem SmartWindowSize local release dry-run entry point. It never creates a Git or GitHub release.

setlocal

rem Launch from this file's location so a double-click does not depend on the current directory.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0release.ps1" -DryRun

rem Preserve the PowerShell result after the command so this launcher returns the same outcome.
set "DRY_RUN_EXIT_CODE=%ERRORLEVEL%"

if not "%DRY_RUN_EXIT_CODE%"=="0" (
    echo.
    echo The local release dry run did not complete. Review the message above.
) else (
    echo.
    echo The local release dry run completed. Review any real-release blockers above.
)

pause
endlocal & exit /b %DRY_RUN_EXIT_CODE%
