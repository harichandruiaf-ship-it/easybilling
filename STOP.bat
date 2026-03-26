@echo off
setlocal
cd /d "%~dp0"

echo.
echo ========================================
echo   Easy Billing - STOP local server
echo ========================================
echo.

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-server.ps1"
set "ERR=%ERRORLEVEL%"

echo.
echo Note: Your browser may still show an OLD tab until you refresh.
echo After STOP, press Ctrl+Shift+R on 127.0.0.1 or close the tab.
echo (Firebase sign-in uses the internet, not the local server.)
echo ========================================
echo.
pause
endlocal
exit /b %ERR%
