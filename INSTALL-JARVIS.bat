@echo off
chcp 65001 >nul
title JARVIS - Install
cd /d "%~dp0"

echo.
echo   ======================================
echo    JARVIS - one-click install (Windows)
echo   ======================================
echo.
echo   Installs Node.js if missing, then the open-source dependencies,
echo   builds the interface and creates a desktop shortcut.
echo   Nothing here needs an account, an API key or a payment.
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo   [*] Node.js not found - installing via winget...
  where winget >nul 2>nul
  if errorlevel 1 (
    echo   [X] winget is not available on this PC.
    echo       Install Node.js LTS from https://nodejs.org and run this file again.
    pause
    exit /b 1
  )
  winget install --id OpenJS.NodeJS.LTS -e --accept-package-agreements --accept-source-agreements
  if errorlevel 1 (
    echo   [X] Node.js install failed. Install it from https://nodejs.org and run this file again.
    pause
    exit /b 1
  )
  set "PATH=%PATH%;%ProgramFiles%\nodejs;%LocalAppData%\Programs\nodejs"
)

where node >nul 2>nul
if errorlevel 1 (
  echo   [!] Node.js is installed but not on PATH yet. Close this window and run START-JARVIS.bat.
  pause
  exit /b 0
)

call npm run setup
if errorlevel 1 (
  echo   [X] Setup failed. The message above says why.
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
echo        JARVIS runs in the tray - closing this window does not stop it.
echo.
call START-JARVIS.bat
