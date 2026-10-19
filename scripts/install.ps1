<#
  PC Commander - installer (Windows, no admin)
  - installs npm dependencies
  - generates your private access key (data/token.txt)
  - sets everything to auto-start at logon AND stay alive (reboot / sleep / crash)
      * the connector server (:8787)
      * the Cloudflare tunnel (only if you've set up a permanent domain)
      * a background watchdog that restarts whatever stops answering
  - prints your local settings URL

  Run from anywhere:
      powershell -ExecutionPolicy Bypass -File scripts\install.ps1
#>

$ErrorActionPreference = 'Stop'
$root     = Split-Path -Parent $PSScriptRoot        # repo root (scripts\ -> root)
$auto     = Join-Path $root 'scripts\autostart'
$startup  = [Environment]::GetFolderPath('Startup')
Set-Location $root

Write-Host "`n=== PC Commander installer ===`n" -ForegroundColor Cyan

# 1. node present?
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "Node.js is not installed or not on PATH." -ForegroundColor Red
  Write-Host "Install it from https://nodejs.org (LTS), reopen PowerShell, and run this again."
  exit 1
}
Write-Host ("node " + (node --version)) -ForegroundColor Green

# 2. dependencies
Write-Host "`nInstalling dependencies..." -ForegroundColor Cyan
npm install --no-fund --no-audit

# 3. generate the key (loadConfig creates data/ + token.txt on first call)
Write-Host "`nGenerating your private key..." -ForegroundColor Cyan
$token = (node -e "import('./src/config.mjs').then(m=>{const c=m.loadConfig();process.stdout.write(c.token)})")
if (-not $token) { Write-Host "Could not generate token." -ForegroundColor Red; exit 1 }

$wsh = New-Object -ComObject WScript.Shell
function New-StartupShortcut($name, $vbs, $desc) {
  $s = $wsh.CreateShortcut((Join-Path $startup $name))
  $s.TargetPath = 'wscript.exe'
  $s.Arguments  = "`"$vbs`""
  $s.WorkingDirectory = $root
  $s.Description = $desc
  $s.Save()
}

# 4. auto-start the server at logon (no admin needed)
Write-Host "`nSetting up auto-start at logon..." -ForegroundColor Cyan
New-StartupShortcut 'PC Commander Server.lnk' (Join-Path $auto 'start-server.vbs') 'Starts the PC Commander server at logon'
Write-Host "  - server       -> logon shortcut installed"

# 4b. tunnel (only if a Cloudflare config exists) + record the public host for the watchdog
$cfg = Join-Path $root 'cloudflared\pc-commands.yml'
if (-not (Test-Path $cfg)) {
  $cfg = Get-ChildItem (Join-Path $env:USERPROFILE '.cloudflared') -Filter '*.yml' -ErrorAction SilentlyContinue |
         Select-Object -First 1 -ExpandProperty FullName
}
if ($cfg -and (Test-Path $cfg)) {
  New-StartupShortcut 'PC Commander Tunnel.lnk' (Join-Path $auto 'start-tunnel.vbs') 'Starts the Cloudflare tunnel at logon'
  $hostLine = (Get-Content $cfg | Where-Object { $_ -match 'hostname:\s*(\S+)' } | Select-Object -First 1)
  if ($hostLine -match 'hostname:\s*(\S+)') {
    Set-Content -Path (Join-Path $auto 'probe.host') -Value $Matches[1] -Encoding ascii -NoNewline
    Write-Host "  - tunnel       -> logon shortcut installed (public host: $($Matches[1]))"
  }
} else {
  Write-Host "  - tunnel       -> skipped (no Cloudflare config yet; run scripts\setup-domain.ps1 for a permanent URL)" -ForegroundColor DarkGray
}

# 4c. the watchdog: keeps server + tunnel alive after reboot / sleep / crash
New-StartupShortcut 'PC Commander Watchdog.lnk' (Join-Path $auto 'watchdog.vbs') 'Keeps the PC Commander server + tunnel alive (reboot/sleep/crash)'
Write-Host "  - watchdog     -> logon shortcut installed"

# 5. start it all now (windowless) if not already running
$running = Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue
if (-not $running) { Start-Process wscript.exe -ArgumentList "`"$(Join-Path $auto 'start-server.vbs')`""; Start-Sleep -Seconds 2 }
$wd = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -like "*$auto*watchdog.ps1*" }
if (-not $wd) { Start-Process wscript.exe -ArgumentList "`"$(Join-Path $auto 'watchdog.vbs')`"" }

Write-Host "`n==================================================================" -ForegroundColor Green
Write-Host "  Done. Everything auto-starts at logon and heals itself if it" -ForegroundColor Green
Write-Host "  stops - after a reboot, after sleep, or after a crash." -ForegroundColor Green
Write-Host "==================================================================`n"
Write-Host "  Settings page (change Ask / Always-allow):"
Write-Host "    http://127.0.0.1:8787/?key=$token`n" -ForegroundColor Yellow
Write-Host "  Watchdog log: scripts\autostart\watchdog.log"
Write-Host "  Next: expose it so ChatGPT can reach it."
Write-Host "    - Just trying it out?   npm run quick     (temporary public URL)"
Write-Host "    - Want a permanent URL? scripts\setup-domain.ps1 (your own domain)"
Write-Host "  See the README for the ChatGPT connector steps.`n"
