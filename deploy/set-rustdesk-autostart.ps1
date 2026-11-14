# set-rustdesk-autostart.ps1 - enable RustDesk autostart at logon (no admin needed)
# v2: fixed schtasks error handling (query on a non-existent task returns non-zero
#     and PS 5.1 treats its stderr as a terminating error under Stop preference).
# Usage:
#   Set-ExecutionPolicy -Scope Process Bypass -Force
#   .\set-rustdesk-autostart.ps1
# ASCII-only.

Write-Host "=== RustDesk autostart setup ===" -ForegroundColor Cyan

# 1) locate exe
$candidates = @(
    "$env:LOCALAPPDATA\rustdesk\rustdesk.exe",
    "C:\Program Files\RustDesk\rustdesk.exe",
    "C:\Program Files (x86)\RustDesk\rustdesk.exe"
)
$exe = $null
foreach ($c in $candidates) {
    if (Test-Path $c) { $exe = $c; break }
}
if (-not $exe) {
    Write-Host "rustdesk.exe not found. checked:" -ForegroundColor Red
    $candidates | ForEach-Object { Write-Host "  $_" }
    exit 1
}
Write-Host "[1] exe: $exe" -ForegroundColor Green

# 2) HKCU Run key (works for current user, no admin) -- THIS IS THE ESSENTIAL PART
$runKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
if (-not (Test-Path $runKey)) { New-Item -Path $runKey -Force | Out-Null }
Set-ItemProperty -Path $runKey -Name "RustDesk" -Value "`"$exe`"" -Type String
$val = (Get-ItemProperty -Path $runKey -Name "RustDesk").RustDesk
Write-Host "[2] HKCU Run registered: $val" -ForegroundColor Green

# 3) user-level scheduled task with 30s delay (OPTIONAL backup)
# Do NOT use ErrorActionPreference=Stop around schtasks: a query on a missing task
# exits non-zero, and PS 5.1 surfaces its stderr as a terminating error.
$taskName = "RustDesk-User-Autostart"
$oldPref = $ErrorActionPreference
$ErrorActionPreference = 'Continue'

$q = schtasks /Query /TN $taskName 2>&1
if ($LASTEXITCODE -eq 0) {
    schtasks /Delete /TN $taskName /F 2>&1 | Out-Null
}

$tr = "`"$exe`""
$c = schtasks /Create /TN $taskName /TR $tr /SC ONLOGON /RL LIMITED /DELAY 0000:30 /F 2>&1
$createOk = ($LASTEXITCODE -eq 0)
$ErrorActionPreference = $oldPref

if ($createOk) {
    Write-Host "[3] scheduled task created: $taskName (ONLOGON +30s)" -ForegroundColor Green
} else {
    Write-Host "[3] scheduled task skipped (Run key alone is sufficient)" -ForegroundColor Yellow
    Write-Host "    reason: $($c -join ' ')" -ForegroundColor DarkGray
}

# 4) current process state
Write-Host "[4] current status"
$p = Get-Process -Name rustdesk -ErrorAction SilentlyContinue
if ($p) {
    Write-Host "    running, pid(s): $($p.Id -join ', ')" -ForegroundColor Green
} else {
    Write-Host "    not running" -ForegroundColor Yellow
}

# 5) confirm the Run key survives
Write-Host "[5] verify"
$check = Get-ItemProperty -Path $runKey -Name "RustDesk" -ErrorAction SilentlyContinue
if ($check) {
    Write-Host "    autostart OK: $($check.RustDesk)" -ForegroundColor Green
} else {
    Write-Host "    autostart NOT set" -ForegroundColor Red
}

Write-Host ""
Write-Host "=== Done ===" -ForegroundColor Cyan
Write-Host "RustDesk will start automatically when this user logs on."
Write-Host "To remove:"
Write-Host "  Remove-ItemProperty -Path '$runKey' -Name RustDesk"
Write-Host "  schtasks /Delete /TN '$taskName' /F"
