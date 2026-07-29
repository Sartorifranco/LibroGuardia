$ErrorActionPreference = "Stop"
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Write-Host "Run as Administrator." -ForegroundColor Red
  exit 1
}
$scriptsDir = $PSScriptRoot
$bridgeJs = Join-Path $scriptsDir "sr201-bridge.js"
$configJson = Join-Path $scriptsDir "sr201-bridge.config.json"
$node = (Get-Command node -ErrorAction Stop).Source
$taskName = "BacarGuard-SR201-Bridge"
if (-not (Test-Path $bridgeJs)) { throw "Missing $bridgeJs" }
if (-not (Test-Path $configJson)) {
  @{ sr201Host = "192.168.0.38"; sr201Port = 6722; bridgePort = 5022; bridgeHost = "0.0.0.0"; bridgeSecret = "123456" } | ConvertTo-Json | Set-Content -Path $configJson -Encoding UTF8
}
$wrapper = Join-Path $scriptsDir "run-sr201-bridge-service.cmd"
$logFile = Join-Path $scriptsDir "sr201-bridge.service.log"
@(
  "@echo off",
  ("cd /d `"{0}`"" -f $scriptsDir),
  ("`"{0}`" `"{1}`" >> `"{2}`" 2>&1" -f $node, $bridgeJs, $logFile)
) | Set-Content -Path $wrapper -Encoding ASCII

# Borrar tarea previa solo si existe
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing) {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}

# Liberar puerto 5022 (bridge viejo sin /status)
Get-NetTCPConnection -LocalPort 5022 -State Listen -ErrorAction SilentlyContinue | ForEach-Object {
  $procId = $_.OwningProcess
  if ($procId -and $procId -gt 0) {
    Write-Host ("Stopping old listener PID {0}" -f $procId) -ForegroundColor Yellow
    Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
    & taskkill.exe /F /PID $procId 2>$null | Out-Null
  }
}
Start-Sleep -Seconds 1

$action = New-ScheduledTaskAction -Execute $wrapper
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
Start-Sleep -Seconds 2
try {
  $health = Invoke-RestMethod -Uri "http://127.0.0.1:5022/health" -TimeoutSec 5
  Write-Host ("OK bridge running -> {0}:{1}" -f $health.sr201Host, $health.sr201Port) -ForegroundColor Green
  if ($health.statusApi -and [int]$health.version -ge 3) {
    Write-Host "OK status API v3 (pulso timed async — kiosk no espera N s)" -ForegroundColor Green
  } elseif ($health.statusApi -and [int]$health.version -ge 2) {
    Write-Host "WARN: bridge v2 — reiniciá para v3 (OFF async, respuesta kiosk rápida)" -ForegroundColor Yellow
  } else {
    Write-Host "WARN: health sin statusApi/version 2 — reinicia con restart-sr201-bridge.ps1" -ForegroundColor Yellow
  }
} catch {
  Write-Host "Task created but health check failed. Close any manual node bridge CMD if port 5022 is busy." -ForegroundColor Yellow
}
Write-Host ("Installed scheduled task: {0}" -f $taskName) -ForegroundColor Cyan
Write-Host ("Config: {0}" -f $configJson)
Write-Host "Uninstall: Unregister-ScheduledTask -TaskName BacarGuard-SR201-Bridge -Confirm:`$false"
