@echo off
chcp 65001 >nul
title JARVIS - stop listening from startup
cd /d "%~dp0"

set "LINK=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\JARVIS wake word.lnk"

if exist "%LINK%" (
  del /f /q "%LINK%"
  echo   [OK] Removed from startup.
) else (
  echo   [*] It was not in startup.
)

echo   [*] Stopping the service if it is running.
taskkill /f /im pythonw.exe >nul 2>nul

echo.
echo   JARVIS itself is untouched - its own wake word in the window still works.
echo.
pause
