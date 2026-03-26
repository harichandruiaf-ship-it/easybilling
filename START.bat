@echo off
setlocal
cd /d "%~dp0"

echo.
echo Starting Easy Billing (PowerShell - no Python required)...
echo.

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-no-python.ps1"
set "ERR=%ERRORLEVEL%"

if not "%ERR%"=="0" (
  echo.
  echo If PowerShell was blocked, try:
  echo   Right-click start-no-python.ps1 -^> Run with PowerShell
  echo.
  pause
)

endlocal
exit /b %ERR%
