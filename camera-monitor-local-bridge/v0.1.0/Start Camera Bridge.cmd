@echo off
setlocal
cd /d "%~dp0"
if not exist "%~dp0go2rtc.exe" (
  echo go2rtc.exe is missing. Reinstall the Camera Monitor Local Bridge package.
  pause
  exit /b 1
)
curl.exe --silent --fail --max-time 2 "http://127.0.0.1:1984/" >nul 2>&1
if not errorlevel 1 (
  echo The local bridge is already running at http://127.0.0.1:1984/.
  exit /b 0
)
start "CNC Camera Bridge" "%~dp0go2rtc.exe" -config "%~dp0go2rtc.yaml"
timeout /t 2 /nobreak >nul
start "" "http://127.0.0.1:1984/"
echo The local bridge is running. Close the CNC Camera Bridge console window to stop it.
echo If the browser did not open, visit http://127.0.0.1:1984/ in a browser.
echo Use the add page to discover or test a camera, then config to save named streams.
