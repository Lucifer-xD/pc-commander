# ============================================================================
#  PC Commander - watchdog
#  Keeps the connector server (:8787) and the Cloudflare tunnel alive at all
#  times: after a reboot, after waking from sleep, and after any crash.
#
#  It runs forever in the background (no window). Every loop it:
#    1. checks the local server on :8787  -> restarts it if it died
#    2. checks the Cloudflare tunnel edge -> restarts cloudflared if the public
#       URL stopped answering even though the local server is fine (this is the
#       "works locally but ChatGPT can't reach it after sleep" failure)
#
#  Every check is wrapped so the loop itself can never crash. Launched at logon
#  by watchdog.vbs (windowless). Writes a short log next to this file.
# ============================================================================

$ErrorActionPreference = 'SilentlyContinue'
$Root      = $PSScriptRoot
$Log       = Join-Path $Root 'watchdog.log'
$ServerVbs = Join-Path $Root 'start-server.vbs'
$TunnelVbs = Join-Path $Root 'start-tunnel.vbs'

$Port      = if ($env:PC_PORT) { $env:PC_PORT } else { 8787 }
$LocalUrl  = "http://127.0.0.1:$Port/health"
$Interval  = 30     # seconds between checks
$GraceSec  = 45     # don't judge the tunnel as "stale" within this long of starting it

# The public hostname used to prove the tunnel edge is alive. We DON'T guess:
# an explicit probe.host file (one line) or the PC_PUBLIC_HOST env var is the
# source of truth. Only if neither exists do we read the cloudflared config
# named in CLOUDFLARED_CONFIG (never a random *.yml - there can be several).
function Get-ProbeHost {
  $f = Join-Path $Root 'probe.host'
  if (Test-Path $f) {
    $h = (Get-Content $f -ErrorAction SilentlyContinue | Where-Object { $_ -match '\S' } | Select-Object -First 1)
    if ($h) { return $h.Trim() }
  }
  if ($env:PC_PUBLIC_HOST) { return $env:PC_PUBLIC_HOST }
  $cfg = $env:CLOUDFLARED_CONFIG
  if ($cfg -and (Test-Path $cfg)) {
    foreach ($line in Get-Content $cfg) {
      if ($line -match 'hostname:\s*(\S+)') { return $Matches[1] }
    }
  }
  return ''   # no reliable probe -> skip the edge-stale check (still restarts if cloudflared dies)
}
$ProbeHost = Get-ProbeHost

function Log($m) {
  try {
    Add-Content -Path $Log -Value ("{0}  {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m) -Encoding utf8
    $all = @(Get-Content -Path $Log -ErrorAction SilentlyContinue)
    if ($all.Count -gt 2000) { Set-Content -Path $Log -Value ($all[-1500..-1]) -Encoding utf8 }
  } catch {}
}

# Returns the HTTP status code, or 0 when nothing answered at all (timeout /
# connection refused / DNS). Cloudflare returns 530 when the tunnel edge is down,
# but 502 when the edge is UP and only the origin is down - we treat those apart.
function Get-HttpStatus($url, $sec = 8) {
  try {
    $r = Invoke-WebRequest -Uri $url -TimeoutSec $sec -UseBasicParsing -ErrorAction Stop
    return [int]$r.StatusCode
  } catch {
    $resp = $_.Exception.Response
    if ($resp -and $resp.StatusCode) { return [int]$resp.StatusCode }
    return 0
  }
}

function Start-Vbs($vbs) {
  if (Test-Path $vbs) { Start-Process -FilePath 'wscript.exe' -ArgumentList ('"{0}"' -f $vbs) -WindowStyle Hidden }
  else { Log "launcher missing: $vbs" }
}

# Only ever touch OUR tunnel, never other cloudflared processes on the machine
# (e.g. ZadLoop runs its own quick-tunnel). A unique token from our tunnel's
# command line identifies it: tunnel.match file, PC_TUNNEL_MATCH env, else the
# default below.
function Get-TunnelMatch {
  $f = Join-Path $Root 'tunnel.match'
  if (Test-Path $f) { $v = (Get-Content $f | Where-Object { $_ -match '\S' } | Select-Object -First 1); if ($v) { return $v.Trim() } }
  if ($env:PC_TUNNEL_MATCH) { return $env:PC_TUNNEL_MATCH }
  return 'pc-commands'
}
$TunnelMatch = Get-TunnelMatch
function Get-OurTunnel {
  Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*$TunnelMatch*" }
}

$script:LastTunnelStart = (Get-Date).AddMinutes(-10)
function Restart-Tunnel($why) {
  Log "tunnel $why -> restarting cloudflared ($TunnelMatch)"
  Get-OurTunnel | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 3
  Start-Vbs $TunnelVbs
  $script:LastTunnelStart = Get-Date
}

Log "watchdog started (pid $PID, port $Port, probe '$ProbeHost')"

while ($true) {
  try {
    # --- 1. local server ---------------------------------------------------
    $localStatus = Get-HttpStatus $LocalUrl 6
    $localUp = ($localStatus -ge 200 -and $localStatus -lt 500)
    if (-not $localUp) {
      Log "server :$Port down (status $localStatus) -> starting"
      Start-Vbs $ServerVbs
      Start-Sleep -Seconds 5
      $localUp = (Get-HttpStatus $LocalUrl 6) -ge 200
    }

    # --- 2. tunnel ---------------------------------------------------------
    $cf = @(Get-OurTunnel)
    $sinceStart = ((Get-Date) - $script:LastTunnelStart).TotalSeconds

    if ($cf.Count -eq 0) {
      Restart-Tunnel 'process not running'
    }
    elseif ($ProbeHost -and $localUp -and $sinceStart -gt $GraceSec) {
      $edge = Get-HttpStatus "https://$ProbeHost/health" 10
      # edge is DOWN only when Cloudflare itself didn't answer (0) or said 530.
      if ($edge -eq 0 -or $edge -eq 530) {
        Restart-Tunnel "edge stale (local ok, public status $edge)"
      }
    }
  } catch {
    try { Log ("loop error: " + $_.Exception.Message) } catch {}
  }
  Start-Sleep -Seconds $Interval
}
