@echo off
chcp 65001 >nul
title JARVIS - voice server
cd /d "%~dp0"

REM Keeps Python and edge-tts warm on 127.0.0.1 so the first word of a reply
REM starts in well under a second instead of waiting for Python to boot.

set "PY=%USERPROFILE%\.jarvis\voice-extras-venv\Scripts\python.exe"
if not exist "%PY%" set "PY=python"

echo.
echo   POST http://127.0.0.1:8771/say  {"text": "..."}
echo   Ctrl-C to stop.
echo.
"%PY%" say.py --serve
pause
