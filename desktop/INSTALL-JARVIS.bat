@echo off
chcp 65001 >nul
title JARVIS - Install
cd /d "%~dp0"

echo.
echo   ======================================
echo    JARVIS - one-click install (Windows)
echo   ======================================
echo.
echo   This installs Node.js (if missing), the app dependencies,
echo   and creates a desktop shortcut. Everything is free.
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo   [*] Node.js not found - installing via winget...
  where winget >nul 2>nul
  if errorlevel 1 (
    echo   [X] winget is not available on this PC.
    echo       Install Node.js LTS manually from https://nodejs.org and run this file again.
    pause
    exit /b 1
  )
  winget install --id OpenJS.NodeJS.LTS -e --accept-package-agreements --accept-source-agreements
  if errorlevel 1 (
    echo   [X] Node.js install failed. Install it from https://nodejs.org and run this file again.
    pause
    exit /b 1
  )
  rem winget updates PATH for new shells only; pick it up for this one.
  set "PATH=%PATH%;%ProgramFiles%\nodejs;%LocalAppData%\Programs\nodejs"
)

where node >nul 2>nul
if errorlevel 1 (
  echo   [!] Node.js installed but not yet on PATH. Close this window, open START-JARVIS.bat.
  pause
  exit /b 0
)

echo   [*] Installing JARVIS dependencies (2-3 minutes, once)...
call npm install
if errorlevel 1 (
  echo   [X] npm install failed. Check your internet connection and run again.
  pause
  exit /b 1
)

echo   [*] Creating desktop shortcut...
powershell -NoProfile -Command ^
  "$s=(New-Object -ComObject WScript.Shell).CreateShortcut([Environment]::GetFolderPath('Desktop')+'\JARVIS.lnk');" ^
  "$s.TargetPath='%~dp0START-JARVIS.bat';$s.WorkingDirectory='%~dp0';$s.Save()"

echo.
echo   [OK] Installed. Starting JARVIS now...
echo        Next time: double-click "JARVIS" on your desktop.
echo.
call START-JARVIS.bat
