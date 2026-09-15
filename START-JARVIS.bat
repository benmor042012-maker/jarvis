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

call npm start
if errorlevel 1 (
  echo.
  echo   [X] JARVIS stopped with an error. Read the message above.
  pause
)
