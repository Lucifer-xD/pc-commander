<#
  PC Commander - installer (Windows)
  - installs npm dependencies
  - generates your private access key (data/token.txt)
  - sets the server to auto-start at every logon (no console window)
  - prints your local settings URL

  Run from anywhere:
      powershell -ExecutionPolicy Bypass -File scripts\install.ps1
#>

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot        # repo root (scripts\ -> root)
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

# 4. auto-start at logon via a Startup-folder shortcut (no admin needed)
Write-Host "Setting up auto-start at logon..." -ForegroundColor Cyan
$startup = [Environment]::GetFolderPath('Startup')
$vbs = Join-Path $root 'scripts\autostart\start-server.vbs'
$w = New-Object -ComObject WScript.Shell
$s = $w.CreateShortcut((Join-Path $startup 'PC Commander Server.lnk'))
$s.TargetPath = 'wscript.exe'
$s.Arguments  = "`"$vbs`""
$s.WorkingDirectory = $root
$s.Description = 'Starts the PC Commander connector server at logon'
$s.Save()

# 5. start it now (windowless) if not already running
$running = Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue
if (-not $running) { Start-Process wscript.exe -ArgumentList "`"$vbs`""; Start-Sleep -Seconds 2 }

Write-Host "`n==================================================================" -ForegroundColor Green
Write-Host "  Done. The server auto-starts every time you log in." -ForegroundColor Green
Write-Host "==================================================================`n"
Write-Host "  Settings page (change Ask / Always-allow):"
Write-Host "    http://127.0.0.1:8787/?key=$token`n" -ForegroundColor Yellow
Write-Host "  Next: expose it so ChatGPT can reach it."
Write-Host "    - Just trying it out?   npm run quick     (temporary public URL)"
Write-Host "    - Want a permanent URL? scripts\setup-domain.ps1 (your own domain)"
Write-Host "  See the README for the ChatGPT connector steps.`n"
