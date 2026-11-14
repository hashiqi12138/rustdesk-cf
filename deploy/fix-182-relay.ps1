# fix-182-relay.ps1 - set .182 relay-server to full ws URL (must match phone side)
# KEY: relay-server must be a complete ws URL, otherwise check_relay_request rejects it.
# Usage (on 192.168.2.182, normal PowerShell):
#   iwr http://192.168.2.2:21129/fix-182-relay.ps1 -OutFile C:\rd\fix-182-relay.ps1 -UseBasicParsing
#   Set-ExecutionPolicy -Scope Process Bypass -Force
#   C:\rd\fix-182-relay.ps1
# ASCII-only.

$ErrorActionPreference = 'Stop'

$Domain = 'rd.hashiqi12138.ccwu.cc'
$RelayUrl = "ws://$Domain`:8080/ws/relay"

Write-Host "=== Fix .182 relay-server to full ws URL ===" -ForegroundColor Cyan
Write-Host "  domain : $Domain"
Write-Host "  relay  : $RelayUrl"
Write-Host ""

Write-Host "[1] Probe CF endpoint"
try {
    $r = Invoke-WebRequest -Uri "http://$Domain`:8080/healthz" -UseBasicParsing -TimeoutSec 20
    Write-Host "    OK (HTTP $($r.StatusCode))" -ForegroundColor Green
} catch {
    Write-Host "    probe failed: $($_.Exception.Message)" -ForegroundColor Yellow
}

Write-Host "[2] Stop RustDesk"
Get-Process rustdesk -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2

Write-Host "[3] Write RustDesk2.toml"
$cfgDir = "$env:APPDATA\RustDesk\config"
$cfg = Join-Path $cfgDir 'RustDesk2.toml'
if (Test-Path $cfg) { Copy-Item $cfg "$cfg.bak-relayfix-$(Get-Date -f yyyyMMddHHmmss)" -Force }

@"
rendezvous_server = '$Domain`:21116'
nat_type = 0
serial = 0
unlock_pin = ''

[options]
custom-rendezvous-server = '$Domain'
allow-websocket = 'Y'
websocket-port = '8080'
relay-server = '$RelayUrl'
"@ | Set-Content -Path $cfg -Encoding ASCII

Get-Content $cfg | ForEach-Object { Write-Host "    $_" }

Write-Host "[4] Start RustDesk"
Start-Process -FilePath "$env:LOCALAPPDATA\rustdesk\rustdesk.exe" -WorkingDirectory "$env:LOCALAPPDATA\rustdesk"
Start-Sleep -Seconds 18

Write-Host "[5] Verify"
$log = "$env:APPDATA\RustDesk\log\rustdesk_rCURRENT.log"
if (Test-Path $log) {
    $good = Select-String -Path $log -Pattern 'start tcp: ws://' | Select-Object -Last 1
    if ($good) { Write-Host "    $($good.Line.Trim())" -ForegroundColor Green }
    $hs = Select-String -Path $log -Pattern 'Client handshake done' | Select-Object -Last 1
    if ($hs) { Write-Host "    handshake OK" -ForegroundColor Green }
    $bad = Select-String -Path $log -Pattern 'was not offered by this peer' | Select-Object -Last 1
    if ($bad) { Write-Host "    RELAY REJECTED: $($bad.Line.Trim())" -ForegroundColor Red }
    else { Write-Host "    No relay rejection" -ForegroundColor Green }
}

Write-Host ""
Write-Host "=== Done ===" -ForegroundColor Cyan
Write-Host "relay-server is now the full ws URL, matching the phone side."
Write-Host "Restart this machine's RustDesk if the relay is still rejected."
