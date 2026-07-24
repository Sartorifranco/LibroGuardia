#requires -Version 5.1
<#
.SYNOPSIS
  Empareja un lector LibroGuardia con un codigo de 6 digitos e instala
  door-reader-bridge.js como servicio Windows (NSSM).

.DESCRIPTION
  Flujo recomendado:
    1. Admin > Lectores > "Generar codigo de instalacion"
    2. En la mini PC (como Administrador): doble clic en instalar-lector.cmd
       o:  powershell -ExecutionPolicy Bypass -File .\instalar-lector.ps1
    3. Pega el codigo. Listo: arranca solo con Windows.

  NSSM: si no esta en el PATH, el script descarga la build portable 2.24
  en scripts\tools\nssm\ (una sola vez por maquina).

.PARAMETER Code
  Codigo de 6 digitos (si se omite, se pide interactivamente).

.PARAMETER ApiBaseUrl
  URL base de la API (default: https://bacarguard.web.app/api).

.PARAMETER SkipService
  Solo guarda el JSON; no registra el servicio NSSM.
#>
param(
  [string]$Code = '',
  [string]$ApiBaseUrl = 'https://bacarguard.web.app/api',
  [switch]$SkipService
)

$ErrorActionPreference = 'Stop'
$ScriptsDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ConfigPath = Join-Path $ScriptsDir 'door-reader.config.json'
$BridgeJs = Join-Path $ScriptsDir 'door-reader-bridge.js'
$ToolsDir = Join-Path $ScriptsDir 'tools\nssm'
$NssmZipUrl = 'https://nssm.cc/release/nssm-2.24.zip'
$ServiceNameDefault = 'LibroGuardiaDoorReader'

function Write-Step([string]$msg) {
  Write-Host ""
  Write-Host "==> $msg" -ForegroundColor Cyan
}

function Assert-Admin {
  $isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator
  )
  if (-not $isAdmin -and -not $SkipService) {
    Write-Host "Este instalador necesita PowerShell como Administrador para registrar el servicio." -ForegroundColor Red
    Write-Host "Clic derecho > Ejecutar como administrador, o usa instalar-lector.cmd" -ForegroundColor Yellow
    exit 1
  }
}

function Resolve-Node {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) {
    throw "No se encontro Node.js en el PATH. Instala LTS desde https://nodejs.org/ y reabri la consola."
  }
  return $node.Source
}

function Resolve-Nssm {
  $fromPath = Get-Command nssm -ErrorAction SilentlyContinue
  if ($fromPath) { return $fromPath.Source }

  $local = Get-ChildItem -Path $ToolsDir -Filter 'nssm.exe' -Recurse -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match 'win64|win32' } |
    Select-Object -First 1
  if ($local) { return $local.FullName }

  Write-Step "NSSM no esta instalado - descargando portable a tools\nssm..."
  New-Item -ItemType Directory -Path $ToolsDir -Force | Out-Null
  $zipPath = Join-Path $ToolsDir 'nssm-2.24.zip'
  try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $NssmZipUrl -OutFile $zipPath -UseBasicParsing
  } catch {
    $errMsg = $_.Exception.Message
    throw ("No se pudo descargar NSSM automaticamente ($errMsg). " +
      "Instalalo una vez a mano: 1) Descarga https://nssm.cc/download  " +
      "2) Copia nssm.exe (win64) a $ToolsDir  3) Volve a correr este script. " +
      "O instala NSSM en el PATH del sistema.")
  }
  Expand-Archive -Path $zipPath -DestinationPath $ToolsDir -Force
  $exe = Get-ChildItem -Path $ToolsDir -Filter 'nssm.exe' -Recurse |
    Where-Object { $_.FullName -match 'win64\\nssm\.exe$' } |
    Select-Object -First 1
  if (-not $exe) {
    $exe = Get-ChildItem -Path $ToolsDir -Filter 'nssm.exe' -Recurse | Select-Object -First 1
  }
  if (-not $exe) { throw "NSSM descargado pero no se encontro nssm.exe en $ToolsDir" }
  Write-Host "NSSM listo: $($exe.FullName)" -ForegroundColor Green
  return $exe.FullName
}

Write-Host "=== Instalador lector LibroGuardia ===" -ForegroundColor Cyan
Write-Host "Carpeta: $ScriptsDir"

if (-not (Test-Path $BridgeJs)) {
  throw "No esta door-reader-bridge.js en $ScriptsDir. Copia la carpeta scripts completa."
}

Assert-Admin
$nodePath = Resolve-Node

if (-not $Code) {
  $Code = Read-Host "Codigo de instalacion (6 digitos)"
}
$Code = ($Code -replace '\s', '').Trim()
if ($Code -notmatch '^\d{6}$') {
  throw "El codigo debe ser exactamente 6 digitos numericos."
}

$ApiBaseUrl = ($ApiBaseUrl -replace '/$', '').Trim()
if (-not $ApiBaseUrl) { $ApiBaseUrl = 'https://bacarguard.web.app/api' }

$customUrl = Read-Host "URL de la API [$ApiBaseUrl] (Enter = default)"
if ($customUrl.Trim()) {
  $ApiBaseUrl = ($customUrl.Trim() -replace '/$', '')
}

Write-Step "Canjeando codigo con $ApiBaseUrl/auth/pairing-exchange ..."
$exchangeUrl = "$ApiBaseUrl/auth/pairing-exchange"
try {
  $body = @{ code = $Code } | ConvertTo-Json
  $response = Invoke-RestMethod -Method Post -Uri $exchangeUrl -ContentType 'application/json; charset=utf-8' -Body ([System.Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 30
} catch {
  $msg = $_.ErrorDetails.Message
  if (-not $msg) { $msg = $_.Exception.Message }
  throw "Emparejamiento fallo: $msg"
}

if (-not $response.config) {
  throw "La API no devolvio config. Respuesta inesperada."
}

Write-Step "Guardando door-reader.config.json"
($response.config | ConvertTo-Json -Depth 8) | Set-Content -Path $ConfigPath -Encoding UTF8
Write-Host "Config guardada: $ConfigPath" -ForegroundColor Green
Write-Host "  doorId=$($response.config.doorId)  readerId=$($response.config.readerId)  user=$($response.config.username)"

Write-Step "npm install (dependencias del bridge)..."
Push-Location $ScriptsDir
try {
  npm install --omit=dev
} finally {
  Pop-Location
}

if ($SkipService) {
  Write-Host ""
  Write-Host "SkipService: JSON listo. Para probar a mano:" -ForegroundColor Yellow
  Write-Host "  `$env:DOOR_READER_CONFIG = `"$ConfigPath`""
  Write-Host "  node `"$BridgeJs`""
  exit 0
}

$nssm = Resolve-Nssm
$doorId = [string]$response.config.doorId
$serviceName = if ($doorId) { "LibroGuardiaDoor-$($doorId -replace '[^A-Za-z0-9_-]', '_')" } else { $ServiceNameDefault }

Write-Step "Registrando servicio Windows: $serviceName"
$existing = & $nssm status $serviceName 2>$null
if ($LASTEXITCODE -eq 0 -or $existing) {
  Write-Host "Servicio previo encontrado - deteniendolo..." -ForegroundColor Yellow
  & $nssm stop $serviceName confirm 2>$null | Out-Null
  Start-Sleep -Seconds 1
  & $nssm remove $serviceName confirm 2>$null | Out-Null
}

& $nssm install $serviceName $nodePath $BridgeJs | Out-Null
& $nssm set $serviceName AppDirectory $ScriptsDir | Out-Null
& $nssm set $serviceName AppEnvironmentExtra "DOOR_READER_CONFIG=$ConfigPath" | Out-Null
& $nssm set $serviceName AppStdout (Join-Path $ScriptsDir 'door-reader-bridge.service.log') | Out-Null
& $nssm set $serviceName AppStderr (Join-Path $ScriptsDir 'door-reader-bridge.service.log') | Out-Null
& $nssm set $serviceName AppRotateFiles 1 | Out-Null
& $nssm set $serviceName AppRestartDelay 5000 | Out-Null
& $nssm set $serviceName Start SERVICE_AUTO_START | Out-Null
& $nssm start $serviceName | Out-Null

Write-Host ""
Write-Host "Listo. El lector queda como servicio permanente." -ForegroundColor Green
Write-Host "  Servicio: $serviceName"
Write-Host "  Log:      $(Join-Path $ScriptsDir 'door-reader-bridge.service.log')"
Write-Host "  Comandos utiles:"
Write-Host "    nssm status $serviceName"
Write-Host "    nssm restart $serviceName"
Write-Host "    nssm stop $serviceName"
Write-Host ""
Write-Host "No hace falta volver a abrir PowerShell en esta maquina para el lector." -ForegroundColor Green