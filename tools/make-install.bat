@echo off
rem SmartWindowSize installation-package entry point for local double-click use.

setlocal

rem Resolve the project root from this launcher instead of relying on the current directory.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0package-extension.ps1" -Target all

rem Preserve the package script status for shells and automated callers.
set "MAKE_INSTALL_EXIT_CODE=%ERRORLEVEL%"

if not "%MAKE_INSTALL_EXIT_CODE%"=="0" (
    echo.
    echo Installation package creation failed. Review the message above.
) else (
    echo.
    echo Chrome and Firefox installation packages were created in install.
)

pause
endlocal & exit /b %MAKE_INSTALL_EXIT_CODE%
