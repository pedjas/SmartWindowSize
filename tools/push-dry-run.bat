@echo off
rem SmartWindowSize coordinated push dry run. It never pushes.
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0push.ps1" -WhatIf
set "DRY_RUN_EXIT_CODE=%ERRORLEVEL%"
if not "%DRY_RUN_EXIT_CODE%"=="0" echo Review the coordinated push dry-run message above.
pause
endlocal & exit /b %DRY_RUN_EXIT_CODE%
