@echo off
chcp 65001 >nul
title JARVIS
cd /d "%~dp0"

echo.
echo   ==========================================
echo    JARVIS - starting the local assistant
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

node scripts\start-app.mjs
if errorlevel 1 (
  echo.
  echo   [X] JARVIS stopped with an error. The message above says why.
  pause
)
