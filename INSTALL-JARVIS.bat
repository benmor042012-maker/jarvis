@echo off
chcp 65001 >nul
title JARVIS - Setup
setlocal

set "ZIPURL=https://github.com/benmor042012-maker/jarvis/archive/refs/heads/claude/jarvis-upgrade-personal-ai-504iz4.zip"
set "TARGET=%USERPROFILE%\JARVIS"
set "ZIPFILE=%TEMP%\jarvis-latest.zip"
set "EXTRACT=%TEMP%\jarvis-extract"
set "NODEDIR=%ProgramFiles%\nodejs"

echo.
echo   ========================================
echo      JARVIS - Setup
echo   ========================================
echo.
echo   This installs everything and starts JARVIS.
echo   Nothing else is needed. Just wait.
echo.

REM ---------- 1. Node.js ----------
where node >nul 2>nul
if not errorlevel 1 goto NODE_OK

echo   [1/4] Installing Node.js...
winget install -e --id OpenJS.NodeJS.LTS --silent --accept-source-agreements --accept-package-agreements
set "PATH=%PATH%;%NODEDIR%"
where node >nul 2>nul
if not errorlevel 1 goto NODE_OK
echo.
echo   [X] Could not install Node.js automatically.
echo       Install it by hand from  https://nodejs.org
echo       (the big LTS button), then run this file again.
echo.
pause
exit /b 1

:NODE_OK
echo   [1/4] Node.js ready.

REM ---------- 2. Download latest code ----------
echo   [2/4] Downloading the latest JARVIS...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; try { [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri '%ZIPURL%' -OutFile '%ZIPFILE%' -UseBasicParsing; if (Test-Path '%EXTRACT%') { Remove-Item '%EXTRACT%' -Recurse -Force }; Expand-Archive -Path '%ZIPFILE%' -DestinationPath '%EXTRACT%' -Force; $src=(Get-ChildItem '%EXTRACT%' -Directory | Select-Object -First 1).FullName; if (-not (Test-Path '%TARGET%')) { New-Item -ItemType Directory -Path '%TARGET%' -Force | Out-Null }; Copy-Item (Join-Path $src '*') '%TARGET%' -Recurse -Force; exit 0 } catch { Write-Host $_.Exception.Message; exit 1 }"
if errorlevel 1 (
  echo.
  echo   [X] Download failed. Check your internet connection and try again.
  echo.
  pause
  exit /b 1
)
echo   [2/4] Code downloaded to %TARGET%

REM ---------- 3. Install components ----------
cd /d "%TARGET%\desktop"
echo   [3/4] Installing components. First time takes 2-3 minutes...
call npm install --no-audit --no-fund --loglevel=error
if errorlevel 1 (
  echo.
  echo   [X] Component install failed. Check your internet connection.
  echo.
  pause
  exit /b 1
)
echo   [3/4] Components ready.

REM ---------- 4. Desktop shortcut + launch ----------
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $s=(New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) 'JARVIS.lnk')); $s.TargetPath='%TARGET%\desktop\START-JARVIS.bat'; $s.WorkingDirectory='%TARGET%\desktop'; $s.Description='JARVIS'; $s.Save() } catch {}" >nul 2>nul

echo   [4/4] Starting JARVIS...
echo.
echo   From now on, use the JARVIS shortcut on your desktop.
echo.
call npm start
if errorlevel 1 (
  echo.
  echo   [X] JARVIS stopped with an error. The message is above.
  echo.
  pause
)
