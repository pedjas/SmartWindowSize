@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0package-extension.ps1" -Target all
pause