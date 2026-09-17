@echo off
chcp 65001 >nul
title JARVIS
cd /d "%~dp0"

echo.
echo   ==========================================
echo    JARVIS - local assistant, no cloud needed
echo   ==========================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo   [X] Node.js is not installed.
  echo       Install the LTS version from https://nodejs.org and run this file again.
  echo.
  pause
  exit /b 1
)

if not exist "client\dist\index.html" (
  echo   [*] First run - installing and building. This takes a few minutes, once.
  call npm run setup
  if errorlevel 1 (
    echo.
    echo   [X] Setup failed. The message above says why.
    pause
    exit /b 1
  )
)

REM --detached so JARVIS keeps running once this window is gone. Without it the
REM agent is a child of this console and closing the window kills the tray app.
call npm start -- --detached
if errorlevel 1 (
  echo.
  echo   [X] JARVIS did not start. Read the message above.
  pause
  exit /b 1
)

echo   You can close this window - JARVIS stays in the tray.
timeout /t 6 >nul
