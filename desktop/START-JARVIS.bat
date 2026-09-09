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

REM ---------- close any JARVIS that is already running ----------
REM Electron holds a single-instance lock: if an old copy is alive, the new one
REM quits immediately and just re-shows the old window, so an update never loads.
REM Matched on the command line so other Electron apps are left alone.
echo   [*] Closing any running JARVIS...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*jarvis*' } | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch {} }" >nul 2>nul
powershell -NoProfile -Command "Start-Sleep -Milliseconds 900" >nul 2>nul

echo   [*] Starting JARVIS...
echo.
call npm start
if errorlevel 1 (
  echo.
  echo   [X] JARVIS stopped with an error. Read the message above.
  pause
)
