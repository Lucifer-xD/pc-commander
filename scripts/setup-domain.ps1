<#
  PC Commander - permanent URL on your own Cloudflare domain (Option B)

  Prerequisites:
    - A domain whose nameservers are on Cloudflare (free plan is fine).
    - cloudflared installed (this script offers to install it via winget).

  Usage:
    powershell -ExecutionPolicy Bypass -File scripts\setup-domain.ps1 -Hostname pc.yourdomain.com

  What it does:
    1. logs cloudflared in to your Cloudflare account (opens a browser once)
    2. creates a named tunnel and its credentials
    3. writes cloudflared\pc-commands.yml (gitignored - stays on your PC)
    4. points <Hostname> at the tunnel (DNS CNAME)
    5. auto-starts the tunnel at every logon (no console window)
    6. prints your PERMANENT URL to paste into ChatGPT
#>

param(
  [Parameter(Mandatory=$true)][string]$Hostname,
  [string]$TunnelName = 'pc-commands'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

Write-Host "`n=== PC Commander: permanent URL setup ===`n" -ForegroundColor Cyan

# cloudflared present?
if (-not (Get-Command cloudflared -ErrorAction SilentlyContinue)) {
  Write-Host "cloudflared is not installed." -ForegroundColor Yellow
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    Write-Host "Installing via winget..." -ForegroundColor Cyan
    winget install --id Cloudflare.cloudflared -e --accept-source-agreements --accept-package-agreements
    Write-Host "If cloudflared still isn't found, close and reopen PowerShell, then rerun." -ForegroundColor Yellow
  } else {
    Write-Host "Install it from https://github.com/cloudflare/cloudflared/releases and rerun." -ForegroundColor Yellow
    exit 1
  }
}

# token (must already exist from install.ps1)
$tokenFile = Join-Path $root 'data\token.txt'
if (-not (Test-Path $tokenFile)) { Write-Host "Run scripts\install.ps1 first (no key found)." -ForegroundColor Red; exit 1 }
$token = (Get-Content $tokenFile -Raw).Trim()

# 1. login (interactive, once per machine; a browser tab opens - pick your domain)
Write-Host "`n[1/5] Authorizing cloudflared with your Cloudflare account..." -ForegroundColor Cyan
Write-Host "      A browser will open. Log in and authorize the domain for $Hostname." -ForegroundColor Gray
cloudflared tunnel login

# 2. create the tunnel (skip if it already exists)
Write-Host "`n[2/5] Creating tunnel '$TunnelName'..." -ForegroundColor Cyan
$existing = (cloudflared tunnel list 2>$null | Select-String -SimpleMatch " $TunnelName ")
if ($existing) {
  Write-Host "      Tunnel '$TunnelName' already exists - reusing it." -ForegroundColor Gray
} else {
  cloudflared tunnel create $TunnelName | Out-Host
}
# resolve its UUID
$id = ((cloudflared tunnel list 2>$null | Select-String $TunnelName) -split '\s+')[0]
if (-not $id) { Write-Host "Could not determine tunnel ID." -ForegroundColor Red; exit 1 }
$creds = Join-Path $env:USERPROFILE ".cloudflared\$id.json"
Write-Host "      id: $id" -ForegroundColor Gray

# 3. write the config (gitignored)
Write-Host "`n[3/5] Writing cloudflared\pc-commands.yml..." -ForegroundColor Cyan
$yml = @"
tunnel: $id
credentials-file: $creds
protocol: http2
loglevel: info
ingress:
  - hostname: $Hostname
    service: http://127.0.0.1:8787
  - service: http_status:404
"@
$ymlPath = Join-Path $root 'cloudflared\pc-commands.yml'
Set-Content -Path $ymlPath -Value $yml -Encoding utf8

# 4. DNS route
Write-Host "`n[4/5] Pointing $Hostname at the tunnel..." -ForegroundColor Cyan
cloudflared tunnel route dns --overwrite-dns $id $Hostname | Out-Host

# 5. auto-start the tunnel at logon
Write-Host "`n[5/5] Setting the tunnel to auto-start at logon..." -ForegroundColor Cyan
$startup = [Environment]::GetFolderPath('Startup')
$vbs = Join-Path $root 'scripts\autostart\start-tunnel.vbs'
$w = New-Object -ComObject WScript.Shell
$s = $w.CreateShortcut((Join-Path $startup 'PC Commander Tunnel.lnk'))
$s.TargetPath = 'wscript.exe'
$s.Arguments  = "`"$vbs`""
$s.WorkingDirectory = $root
$s.Description = "Starts the Cloudflare tunnel for $Hostname at logon"
$s.Save()

# start it now
Start-Process wscript.exe -ArgumentList "`"$vbs`""
Start-Sleep -Seconds 6

Write-Host "`n==================================================================" -ForegroundColor Green
Write-Host "  Permanent URL is live. This never changes." -ForegroundColor Green
Write-Host "==================================================================`n"
Write-Host "  Paste THIS into ChatGPT as the connector URL:" -ForegroundColor Cyan
Write-Host "    https://$Hostname/mcp?key=$token`n" -ForegroundColor Yellow
Write-Host "  Test it:  curl https://$Hostname/health`n"
