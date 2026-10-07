# Corre cada 1 minuto (tarea MSSGuard-Estacion-Watchdog).
# Si http://127.0.0.1:<puerto>/status no responde 3 veces seguidas, reinicia el servicio NSSM.
# NSSM solo reinicia cuando el proceso se cierra; esto cubre el caso de proceso colgado.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'watchdog-common.ps1')

$ScriptsDir = Split-Path -Parent $PSScriptRoot
$logPath = Join-Path $ScriptsDir 'estacion.watchdog.log'
$configPath = Join-Path $ScriptsDir 'configuracion-estacion.json'
if (-not (Test-Path -LiteralPath $configPath)) {
  $legacy = Join-Path $ScriptsDir 'door-reader.config.json'
  if (Test-Path -LiteralPath $legacy) { $configPath = $legacy }
}

if (-not (Test-Path -LiteralPath $configPath)) {
  Write-StationHealthLog -LogPath $logPath -Message 'Sin configuracion-estacion.json: no se vigila /status.'
  exit 0
}

$cfg = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
$port = 0
if ($null -ne $cfg.localServerPort) { $port = [int]$cfg.localServerPort }
if ($port -le 0) {
  Write-StationHealthLog -LogPath $logPath -Message 'localServerPort es 0: el servidor local no esta activo.'
  exit 0
}

$doorId = [string]$cfg.doorId
$serviceName = if ($doorId) {
  "LibroGuardiaDoor-$($doorId -replace '[^A-Za-z0-9_-]', '_')"
} else {
  'LibroGuardiaDoorReader'
}

function Resolve-NssmPath {
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
  throw 'No se encontro nssm.exe en tools\nssm'
}

$nssm = Resolve-NssmPath
$headers = @{ Accept = 'application/json' }
$secret = [string]$cfg.localServerSecret
if ($secret) {
  $headers.Authorization = "Bearer $secret"
}

$safeName = $serviceName -replace '[^A-Za-z0-9_-]', '_'
$statePath = Join-Path $PSScriptRoot "estacion-health-state-$safeName.json"

Invoke-NssmHttpHealthWatch `
  -ServiceName $serviceName `
  -HealthUri "http://127.0.0.1:$port/status" `
  -Headers $headers `
  -FailureThreshold 3 `
  -StatePath $statePath `
  -NssmPath $nssm `
  -LogPath $logPath `
  -TimeoutSec 5 | Out-Null
