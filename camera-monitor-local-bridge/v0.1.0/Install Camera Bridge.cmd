@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install Camera Bridge.ps1"
if errorlevel 1 (
  echo Camera Bridge installation did not complete.
  pause
  exit /b 1
)
