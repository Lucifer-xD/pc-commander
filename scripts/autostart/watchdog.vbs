' Launches the PC Commander watchdog with no console window.
' The watchdog keeps the server (:8787) and the Cloudflare tunnel alive
' across reboots, sleep/wake, and crashes. Place a shortcut to this file
' in the Startup folder (the installer does that for you).
Set sh = CreateObject("WScript.Shell")
scriptDir = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\"))
sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & scriptDir & "watchdog.ps1""", 0, False
