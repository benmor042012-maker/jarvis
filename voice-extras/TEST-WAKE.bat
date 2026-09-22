@echo off
chcp 65001 >nul
title JARVIS - test the wake word
cd /d "%~dp0"

set "PY=%USERPROFILE%\.jarvis\voice-extras-venv\Scripts\python.exe"
if not exist "%PY%" set "PY=python"

echo.
echo   Say "Hey Jarvis" out loud. It exits after the first time it hears you.
echo   Ctrl-C to give up.
echo.
"%PY%" wake_service.py --once --verbose
echo.
pause
