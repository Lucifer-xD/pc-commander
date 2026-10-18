' Starts the Cloudflare named tunnel with NO console window.
' Portable: reads cloudflared\pc-commands.yml from the repo root.
' Only needed for the "permanent URL with your own domain" setup (Option B).
' Requires: cloudflared on your PATH, and cloudflared\pc-commands.yml created
' by scripts\setup-domain.ps1.
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")
root = fso.GetParentFolderName(fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName)))
sh.Run "cloudflared tunnel --config """ & root & "\cloudflared\pc-commands.yml"" run", 0, False
