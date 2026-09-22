@echo off
chcp 65001 >nul
title JARVIS - listen for the wake word from startup
cd /d "%~dp0"

REM Puts a shortcut to run-wake-service.vbs in the current user's Startup
REM folder (the one shell:startup opens). No admin rights, no registry, no
REM scheduled task - and removing it is deleting one file.

set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "LINK=%STARTUP%\JARVIS wake word.lnk"
set "TARGET=%~dp0run-wake-service.vbs"

if not exist "%USERPROFILE%\.jarvis\voice-extras-venv\Scripts\pythonw.exe" (
  echo   [X] The voice extras are not installed yet.
  echo       Run INSTALL-EXTRAS.bat first.
  echo.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$s=(New-Object -ComObject WScript.Shell).CreateShortcut('%LINK%');" ^
  "$s.TargetPath='%SystemRoot%\System32\wscript.exe';" ^
  "$s.Arguments='\"%TARGET%\"';" ^
  "$s.WorkingDirectory='%~dp0';" ^
  "$s.IconLocation='%~dp0..\desktop\assets\icon.png';" ^
  "$s.Description='Listens for the JARVIS wake word in the background';" ^
  "$s.Save()"

if errorlevel 1 (
  echo   [X] Could not create the shortcut.
  pause
  exit /b 1
)

if not exist "%LINK%" (
  echo   [X] The shortcut was not created. Open shell:startup and check.
  pause
  exit /b 1
)

echo.
echo   [OK] Added. From the next sign-in, saying "Hey Jarvis" wakes JARVIS,
echo        with no window of its own. See it: press Win+R, type shell:startup
echo.
echo   Starting it now as well, so you do not have to sign out.
start "" wscript.exe "%TARGET%"
echo.
echo   To undo: REMOVE-FROM-STARTUP.bat
echo   The log is in %USERPROFILE%\.jarvis\logs\jarvis-wake.log
echo.
pause
