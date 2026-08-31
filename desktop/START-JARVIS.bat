@echo off
chcp 65001 >nul
title JARVIS
cd /d "%~dp0"

echo.
echo   ================================
echo    JARVIS - Personal AI Assistant
echo   ================================
echo.

where node >/dev/null 2>nul
if errorlevel 1 (
  echo   [X] Node.js is not installed.
  echo.
  echo       Install Node.js LTS from:  https://nodejs.org
  echo       Then run this file again.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo   [*] First run - installing. This takes 2-3 minutes...
  echo.
  call npm install
  if errorlevel 1 (
    echo.
    echo   [X] Install failed. Check your internet connection.
    pause
    exit /b 1
  )
  echo.
)

echo   [*] Starting JARVIS...
echo.
call npm start
if errorlevel 1 (
  echo.
  echo   [X] JARVIS stopped with an error. Read the message above.
  pause
)
