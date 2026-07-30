# Instala el puente BioStar -> MSS como tarea programada de Windows.
# Arranca al iniciar la PC, reintenta si se cae, no depende de una consola abierta.
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
$bridgeJs = Join-Path $scriptsDir "programa-biostar.js"
$configJson = Join-Path $scriptsDir "configuracion-biostar.json"
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
  throw "No se encontro Node.js en el PATH. Instala Node y volve a intentar."
}
$node = $nodeCmd.Source
$taskName = "MSSGuard-BioStar-Bridge"
$wrapper = Join-Path $scriptsDir "arrancar-biostar-servicio.cmd"
$logFile = Join-Path $scriptsDir "biostar.service.log"

Write-Host "=== Instalador puente BioStar (servicio permanente) ===" -ForegroundColor Cyan
Write-Host "Carpeta: $scriptsDir"

if (-not (Test-Path $bridgeJs)) {
  throw "Falta programa-biostar.js en $scriptsDir"
}
if (-not (Test-Path $configJson)) {
  throw @"
Falta configuracion-biostar.json.

1) Copia configuracion-biostar.ejemplo.json a configuracion-biostar.json
2) Completa claves BioStar + MSS y defaultDoorId
3) Volve a correr este instalador
"@
}

# Detener procesos manuales del puente (ventana CMD abierta)
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and ($_.CommandLine -like '*programa-biostar.js*') } |
  ForEach-Object {
    Write-Host ("Cerrando puente manual PID {0}..." -f $_.ProcessId) -ForegroundColor Yellow
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }

$wrapperText = @"
@echo off
REM Generado por instalar-biostar - no editar a mano salvo ruta de Node.
cd /d "$scriptsDir"
where node >nul 2>&1
if errorlevel 1 (
  echo No se encontro node en el PATH.
  exit /b 1
)
"$node" "$bridgeJs" >> "$logFile" 2>&1
"@
Set-Content -Path $wrapper -Value $wrapperText -Encoding ASCII

$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing) {
  Write-Host "Tarea previa encontrada - reemplazando..." -ForegroundColor Yellow
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}

$action = New-ScheduledTaskAction -Execute $wrapper
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -StartWhenAvailable
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest

Register-ScheduledTask `
  -TaskName $taskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Principal $principal `
  -Description "Puente BioStar 2 a MSS Guard (usuarios y eventos)" `
  -Force | Out-Null

Start-ScheduledTask -TaskName $taskName
Start-Sleep -Seconds 3

$info = Get-ScheduledTaskInfo -TaskName $taskName
Write-Host ""
Write-Host "Listo. El puente queda permanente." -ForegroundColor Green
Write-Host ("  Tarea:     {0}" -f $taskName)
Write-Host ("  LastTaskResult: {0}" -f $info.LastTaskResult)
Write-Host ("  Config:    {0}" -f $configJson)
Write-Host ("  Log:       {0}" -f $logFile)
Write-Host ("  Wrapper:   {0}" -f $wrapper)
Write-Host ""
Write-Host "Arranca solo al encender la PC. No hace falta dejar una consola abierta." -ForegroundColor Green
Write-Host "Para reiniciar despues de cambiar la config: 05b-reiniciar-servicio-biostar.cmd" -ForegroundColor Cyan
Write-Host ("Desinstalar: Unregister-ScheduledTask -TaskName {0} -Confirm:`$false" -f $taskName)
Write-Host ""
Write-Host "Revisa las ultimas lineas del log:" -ForegroundColor Cyan
if (Test-Path $logFile) {
  Get-Content $logFile -Tail 12 | ForEach-Object { Write-Host "  $_" }
} else {
  Write-Host "  (todavia no hay log; espera unos segundos y abri biostar.service.log)" -ForegroundColor Yellow
}
