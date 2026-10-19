<#
  Rotate your private key. Generates a new one, restarts the server, and prints
  the new URL to paste into ChatGPT. Use this if your key ever leaks.
#>
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$tokenFile = Join-Path $root 'data\token.txt'
Remove-Item $tokenFile -Force -ErrorAction SilentlyContinue
$token = (node -e "import('./src/config.mjs').then(m=>{const c=m.loadConfig();process.stdout.write(c.token)})")

# restart the server so it loads the new key
$srv = Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue
if ($srv) { Stop-Process -Id $srv.OwningProcess -Force -ErrorAction SilentlyContinue; Start-Sleep 1 }
Start-Process wscript.exe -ArgumentList "`"$(Join-Path $root 'scripts\autostart\start-server.vbs')`""

Write-Host "`nNew key generated. Update your ChatGPT connector URL to end with:" -ForegroundColor Green
Write-Host "  .../mcp?key=$token`n" -ForegroundColor Yellow
Write-Host "Settings: http://127.0.0.1:8787/?key=$token`n"
