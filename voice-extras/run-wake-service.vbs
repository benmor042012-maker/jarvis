' Starts the wake-word service with no window and no console flash.
' pythonw.exe is the windowless Python; the 0 and False below mean "hidden"
' and "do not wait". This is what the Startup shortcut points at.
Option Explicit

Dim shell, fso, here, python, script
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

here = fso.GetParentFolderName(WScript.ScriptFullName)
python = shell.ExpandEnvironmentStrings("%USERPROFILE%") & "\.jarvis\voice-extras-venv\Scripts\pythonw.exe"
script = here & "\wake_service.py"

If Not fso.FileExists(python) Then
  python = "pythonw.exe"   ' fall back to whatever is on PATH
End If

shell.CurrentDirectory = here
shell.Run """" & python & """ """ & script & """", 0, False
