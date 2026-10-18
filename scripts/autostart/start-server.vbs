' Starts the PC Commander connector server with NO console window.
' Portable: works from wherever the repo lives (derives the root from this file).
' The server runs in your interactive logon session so the Approve dialog can
' appear on screen when the mode is "ask".
' Requires: node on your PATH.
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")
root = fso.GetParentFolderName(fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName)))
sh.CurrentDirectory = root
sh.Run "node """ & root & "\src\server.mjs""", 0, False
