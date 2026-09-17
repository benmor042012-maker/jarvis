@echo off
chcp 65001 >nul
title JARVIS - Install voice
cd /d "%~dp0"

echo.
echo   ==========================================
echo    JARVIS - speech recognition (one click)
echo   ==========================================
echo.
echo   Downloads the free, open-source speech engine and a model that
echo   understands Hebrew, into your .jarvis folder.
echo   No account, no key, no payment. After this it works offline.
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo   [X] Node.js is not installed. Run INSTALL-JARVIS.bat first.
  pause
  exit /b 1
)

call npm run voice
if errorlevel 1 (
  echo.
  echo   [X] It did not finish. The message above says exactly what went wrong.
  pause
  exit /b 1
)

echo.
pause
