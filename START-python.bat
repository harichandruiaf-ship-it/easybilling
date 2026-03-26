@echo off
setlocal EnableDelayedExpansion
cd /d "%~dp0"
set "PORT=8080"
set "PYCMD="
where python >nul 2>nul
if not errorlevel 1 set "PYCMD=python"
if not defined PYCMD (
  where py >nul 2>nul
  if not errorlevel 1 set "PYCMD=py"
)
if not defined PYCMD (
  echo Python not found. Use START.bat instead ^(no Python^).
  pause
  exit /b 1
)
echo Easy Billing — Python server http://127.0.0.1:%PORT%/
start "" cmd /c "ping -n 2 127.0.0.1 >nul && start http://127.0.0.1:%PORT%/"
%PYCMD% -m http.server %PORT% --bind 127.0.0.1
endlocal
