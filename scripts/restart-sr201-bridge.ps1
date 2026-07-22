# Reinicia el bridge SR201 con la version que incluye /status (estado fisico en tiempo real).
# Ejecutar como Administrador (clic derecho -> Ejecutar con PowerShell como administrador).
$ErrorActionPreference = "Stop"
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Write-Host "Se necesita Administrador. Relanzando con UAC..." -ForegroundColor Yellow
  Start-Process powershell.exe -Verb RunAs -ArgumentList @(
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$PSCommandPath`""
  )
  exit 0
}

$scriptsDir = $PSScriptRoot
$bridgeJs = Join-Path $scriptsDir "sr201-bridge.js"
$configJson = Join-Path $scriptsDir "sr201-bridge.config.json"
$node = (Get-Command node -ErrorAction Stop).Source
$taskName = "BacarGuard-SR201-Bridge"

Write-Host "Deteniendo tarea programada (si existe)..." -ForegroundColor Cyan
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing) {
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 1
}

Write-Host "Liberando puerto 5022..." -ForegroundColor Cyan
Get-NetTCPConnection -LocalPort 5022 -State Listen -ErrorAction SilentlyContinue | ForEach-Object {
  $procId = $_.OwningProcess
  if ($procId -and $procId -gt 0) {
    Write-Host "  Matando PID $procId"
    Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
    & taskkill.exe /F /PID $procId 2>$null | Out-Null
  }
}
Start-Sleep -Seconds 2

$busy = Get-NetTCPConnection -LocalPort 5022 -State Listen -ErrorAction SilentlyContinue
if ($busy) {
  Write-Host "ERROR: el puerto 5022 sigue ocupado por PID $($busy.OwningProcess). Cerra la ventana CMD del bridge viejo y volve a intentar." -ForegroundColor Red
  pause
  exit 1
}

Write-Host "Instalando / arrancando servicio..." -ForegroundColor Cyan
& (Join-Path $scriptsDir "install-sr201-bridge-autostart.ps1")
Start-Sleep -Seconds 2

$health = Invoke-RestMethod -Uri "http://127.0.0.1:5022/health" -TimeoutSec 5
Write-Host ("Health: " + ($health | ConvertTo-Json -Compress)) -ForegroundColor Green
if (-not $health.statusApi -or [int]$health.version -lt 2) {
  Write-Host "ADVERTENCIA: el bridge no reporta statusApi/version 2. Puede seguir siendo codigo viejo." -ForegroundColor Yellow
}

$cfg = Get-Content $configJson -Raw | ConvertFrom-Json
$body = @{ host = $cfg.sr201Host; port = $cfg.sr201Port } | ConvertTo-Json
$status = Invoke-RestMethod -Uri "http://127.0.0.1:5022/status" -Method POST -ContentType "application/json" -Headers @{ Authorization = "Bearer $($cfg.bridgeSecret)" } -Body $body -TimeoutSec 8
Write-Host ("Status OK: " + ($status | ConvertTo-Json -Compress)) -ForegroundColor Green
Write-Host ""
Write-Host "Listo. Recarga Admin -> Puertas. El estado fisico deberia actualizarse cada ~1.5 s." -ForegroundColor Green
Write-Host "Si usas Cloudflare Tunnel, asegurate de que apunte a http://127.0.0.1:5022" -ForegroundColor Cyan
pause
