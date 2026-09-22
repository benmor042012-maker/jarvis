@echo off
chcp 65001 >nul
title JARVIS - install the voice extras
cd /d "%~dp0"

echo.
echo   ==========================================
echo    JARVIS voice extras - one click install
echo   ==========================================
echo.
echo   Installs two optional things, both free of charge:
echo.
echo     1. A wake-word service that listens for "Hey Jarvis" in the
echo        background and wakes JARVIS. Runs entirely on this computer.
echo.
echo     2. Microsoft Edge neural voices, so JARVIS sounds human.
echo        Free, no account, no key - but the text it speaks is sent to
echo        Microsoft to be turned into sound. It needs internet.
echo        Nothing else in JARVIS works this way, and nothing switches
echo        this on by itself.
echo.

set "VENV=%USERPROFILE%\.jarvis\voice-extras-venv"

where python >nul 2>nul
if errorlevel 1 (
  echo   [X] Python is not installed.
  echo       Install it from https://www.python.org/downloads/ - tick
  echo       "Add python.exe to PATH" - then run this file again.
  echo       Or, in a terminal:  winget install Python.Python.3.12
  echo.
  pause
  exit /b 1
)

if not exist "%VENV%\Scripts\python.exe" (
  echo   [*] Making a private Python environment in %VENV%
  python -m venv "%VENV%"
  if errorlevel 1 (
    echo   [X] Could not create the environment. The message above says why.
    pause
    exit /b 1
  )
)

echo   [*] Installing the packages. A few minutes, once.
"%VENV%\Scripts\python.exe" -m pip install --upgrade pip --quiet
"%VENV%\Scripts\python.exe" -m pip install -r requirements.txt
if errorlevel 1 (
  echo.
  echo   [X] The install did not finish. The message above says why.
  pause
  exit /b 1
)

echo   [*] Downloading the wake-word models (a few hundred KB, once).
"%VENV%\Scripts\python.exe" -c "import openwakeword.utils as u; u.download_models()"

if not exist "config.json" (
  copy /y "config.example.json" "config.json" >nul
  echo   [*] Made config.json - edit it to change the voice or the threshold.
)

echo.
echo   ---------------- checking ----------------
"%VENV%\Scripts\python.exe" wake_service.py --check
echo.
"%VENV%\Scripts\python.exe" say.py --self-test
echo   -----------------------------------------
echo.
echo   Done. What you can do now:
echo.
echo     ADD-TO-STARTUP.bat        listen for "Hey Jarvis" from every boot
echo     TEST-WAKE.bat             say it once and watch what happens
echo     TEST-VOICE.bat            hear the Hebrew voice
echo     START-VOICE-SERVER.bat    keep the voice warm so replies start fast
echo.
pause
