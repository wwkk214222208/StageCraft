$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$port = 8787
$distro = 'Ubuntu'

function Get-WslIp {
  try {
    $raw = & wsl.exe -d $distro -e bash -lc "hostname -I" 2>$null
    return ($raw -split '\s+' | Where-Object { $_ -match '^\d{1,3}(\.\d{1,3}){3}$' } | Select-Object -First 1)
  } catch { return $null }
}

function Test-Url($url) {
  try {
    $r = Invoke-WebRequest -Uri $url -TimeoutSec 3 -UseBasicParsing
    return ($r.StatusCode -eq 200)
  } catch { return $false }
}

function Open-App {
  # Mirrored mode: localhost is shared with WSL -> always prefer it
  if (Test-Url "http://127.0.0.1:$port/api/room") {
    Start-Process "http://127.0.0.1:$port"
    return $true
  }
  # NAT mode: reach the WSL IP instead
  $ip = Get-WslIp
  if ($ip -and (Test-Url "http://${ip}:$port/api/room")) {
    Start-Process "http://${ip}:$port"
    return $true
  }
  return $false
}

try {
  if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) {
    throw 'WSL is not available (wsl.exe not found).'
  }

  # Already running (mirrored via localhost, or NAT via WSL IP): just open it
  if (Open-App) { exit 0 }

  # Kill a stray Windows instance first so two servers never share the DB
  Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
    ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }

  $wslRoot = '/mnt/' + $root.Substring(0, 1).ToLower() + $root.Substring(2).Replace('\', '/')
  $startScript = "$wslRoot/wsl-start.sh"
  & wsl.exe -d $distro -e bash -lc "bash '$startScript'" | Out-Host

  for ($attempt = 1; $attempt -le 20; $attempt++) {
    if (Open-App) { exit 0 }
    Start-Sleep -Seconds 1
  }

  throw "Character Tavern did not start within 20 seconds. Logs: $root\data\server.log and $root\data\server-error.log"
} catch {
  Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
  Read-Host 'Press Enter to close'
  exit 1
}
