# Reinicia el bridge de esta PC. No abre la pagina :8787.
# Despues: https://mss-guard.web.app -> Admin -> Puertas -> Probar apertura
[CmdletBinding()]
param(
  [switch]$OpenAdmin
)

$ErrorActionPreference = 'Stop'
$ScriptsDir = $PSScriptRoot
$configPath = Join-Path $ScriptsDir 'door-reader.config.json'

function Write-Step([string]$msg) {
  Write-Host ""
  Write-Host "==> $msg" -ForegroundColor Cyan
}

function Resolve-Nssm {
  $fromPath = Get-Command nssm -ErrorAction SilentlyContinue
  if ($fromPath) { return $fromPath.Source }
  $tools = Join-Path $ScriptsDir 'tools\nssm'
  $local = Get-ChildItem -Path $tools -Filter 'nssm.exe' -Recurse -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match 'win64\\nssm\.exe$' } |
    Select-Object -First 1
  if (-not $local) {
    $local = Get-ChildItem -Path $tools -Filter 'nssm.exe' -Recurse -ErrorAction SilentlyContinue |
      Select-Object -First 1
  }
  if ($local) { return $local.FullName }
  throw "No se encontro nssm.exe en tools\nssm"
}

if (-not (Test-Path $configPath)) {
  throw "Falta door-reader.config.json en $ScriptsDir"
}

$cfg = Get-Content $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
$port = if ($cfg.localServerPort) { [int]$cfg.localServerPort } else { 8787 }
$secret = [string]$cfg.localServerSecret
$doorId = [string]$cfg.doorId
$serviceName = if ($doorId) {
  "LibroGuardiaDoor-$($doorId -replace '[^A-Za-z0-9_-]', '_')"
} else {
  'LibroGuardiaDoorReader'
}

$bridgePath = Join-Path $ScriptsDir 'door-reader-bridge.js'
$fileVer = $null
if (Test-Path $bridgePath) {
  $m = Select-String -Path $bridgePath -Pattern "BRIDGE_VERSION\s*=\s*'([^']+)'" | Select-Object -First 1
  if ($m) { $fileVer = $m.Matches[0].Groups[1].Value }
}

Write-Host ""
Write-Host "  Esta PC = la estacion." -ForegroundColor Green
Write-Host ("  Archivo bridge: {0}" -f $(if ($fileVer) { $fileVer } else { '?' }))
Write-Host ("  Servicio:       {0}" -f $serviceName)

Write-Step "Reiniciando servicio"
$nssm = Resolve-Nssm
try {
  & $nssm restart $serviceName | Out-Null
} catch {
  Write-Host "No pude reiniciar (hace falta Administrador)." -ForegroundColor Yellow
  throw
}
Start-Sleep -Seconds 2

Write-Step "Chequeando que responda"
$runningVer = $null
try {
  $headers = @{ Authorization = "Bearer $secret"; Accept = 'application/json' }
  $status = Invoke-RestMethod -Uri "http://127.0.0.1:$port/status" -Headers $headers -TimeoutSec 5
  $runningVer = $status.bridgeVersion
  Write-Host ("  OK - bridge {0} (API {1})" -f $status.bridgeVersion, $status.localStationApiVersion) -ForegroundColor Green
} catch {
  Write-Host ("  /status no respondio: {0}" -f $_.Exception.Message) -ForegroundColor Red
  Write-Host "  Mira el log: door-reader-bridge.service.log" -ForegroundColor Yellow
  throw
}

if ($fileVer -and $runningVer -and ($fileVer -ne $runningVer)) {
  Write-Host ("ATENCION: archivo={0} pero servicio={1}." -f $fileVer, $runningVer) -ForegroundColor Red
}

Write-Host ""
Write-Host "Listo. Ahora en el navegador:" -ForegroundColor Cyan
Write-Host "  1) https://mss-guard.web.app  (Ctrl+F5)" -ForegroundColor Green
Write-Host "  2) Admin -> Puertas -> Probar apertura" -ForegroundColor Green
Write-Host ""
Write-Host ("No uses la pagina http://127.0.0.1:{0}/ para operar." -f $port) -ForegroundColor Yellow
Write-Host ""

if ($OpenAdmin) {
  Start-Process "https://mss-guard.web.app/admin/doors"
}

Write-Host "Podes cerrar esta ventana." -ForegroundColor Green
Write-Host ""
Read-Host "Enter para salir"
