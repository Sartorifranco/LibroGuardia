# Reinicia el puente BioStar (tarea programada).
# Ejecutar como Administrador.

$ErrorActionPreference = "Stop"

$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator
)
if (-not $isAdmin) {
  Write-Host "Se necesita Administrador. Relanzando con UAC..." -ForegroundColor Yellow
  Start-Process powershell.exe -Verb RunAs -ArgumentList @(
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$PSCommandPath`""
  )
  exit 0
}

$scriptsDir = Split-Path -Parent $PSScriptRoot
$taskName = "MSSGuard-BioStar-Bridge"
$logFile = Join-Path $scriptsDir "biostar.service.log"
$installScript = Join-Path $PSScriptRoot "instalar-biostar.ps1"

Write-Host "=== Reinicio puente BioStar ===" -ForegroundColor Cyan

$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if (-not $existing) {
  Write-Host "No hay tarea instalada. Instalando ahora..." -ForegroundColor Yellow
  & $installScript
  pause
  exit 0
}

Write-Host "Deteniendo tarea..." -ForegroundColor Cyan
Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1

Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and ($_.CommandLine -like '*programa-biostar.js*') } |
  ForEach-Object {
    Write-Host ("Cerrando PID {0}..." -f $_.ProcessId) -ForegroundColor Yellow
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }

Start-Sleep -Seconds 1
Write-Host "Arrancando tarea..." -ForegroundColor Cyan
Start-ScheduledTask -TaskName $taskName
Start-Sleep -Seconds 3

$info = Get-ScheduledTaskInfo -TaskName $taskName
Write-Host ("Estado LastTaskResult={0}" -f $info.LastTaskResult) -ForegroundColor Green
Write-Host ("Log: {0}" -f $logFile)
if (Test-Path $logFile) {
  Get-Content $logFile -Tail 15 | ForEach-Object { Write-Host "  $_" }
}
Write-Host ""
Write-Host "Listo." -ForegroundColor Green
pause
