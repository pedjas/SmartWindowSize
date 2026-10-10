@echo off
rem SmartWindowSize coordinated local-commit dry run. It never stages or commits.
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0commit.ps1" -WhatIf
set "DRY_RUN_EXIT_CODE=%ERRORLEVEL%"
if not "%DRY_RUN_EXIT_CODE%"=="0" echo Review the coordinated commit dry-run message above.
pause
endlocal & exit /b %DRY_RUN_EXIT_CODE%
