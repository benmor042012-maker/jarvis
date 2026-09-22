@echo off
chcp 65001 >nul
title JARVIS - test the voice
cd /d "%~dp0"

set "PY=%USERPROFILE%\.jarvis\voice-extras-venv\Scripts\python.exe"
if not exist "%PY%" set "PY=python"

echo.
echo   Speaking one Hebrew sentence and one English sentence.
echo   This sends those two sentences to Microsoft to be turned into sound.
echo.
"%PY%" say.py --demo
echo.
echo   To hear the other voices:  say.py --list-voices he
echo.
pause
