<#
.SYNOPSIS
  Reinicia el servicio NSSM del door-reader-bridge y muestra como verificar la version.

.DESCRIPTION
  Uso tipico en la mini PC (como Administrador), DESPUES de reemplazar door-reader-bridge.js:

    .\actualizar-bridge.cmd
    .\actualizar-bridge.cmd -DoorId puerta-p1
    .\actualizar-bridge.cmd -ServiceName LibroGuardiaDoor-puerta-p1

  No toca el JSON ni regenera passwords. Solo reinicia el proceso Node.
#>
[CmdletBinding()]
param(
  [string]$DoorId = '',
  [string]$ServiceName = '',
  [string]$Secret = '',
  [int]$Port = 8787
)

$ErrorActionPreference = 'Stop'
$ScriptsDir = $PSScriptRoot

function Write-Step([string]$msg) {
  Write-Host ""
  Write-Host "==> $msg" -ForegroundColor Cyan
}

function Resolve-Nssm {
  $fromPath = Get-Command nssm -ErrorAction SilentlyContinue
  if ($fromPath) { return $fromPath.Source }
  $tools = Join-Path $ScriptsDir 'tools\nssm'
  $local = Get-ChildItem -Path $tools -Filter 'nssm.exe' -Recurse -ErrorAction SilentlyContinue |
    Sort-Object FullName -Descending |
    Select-Object -First 1
  if ($local) { return $local.FullName }
  throw "No se encontro nssm.exe. Instala NSSM o usa scripts\tools\nssm."
}

Write-Step "Buscando servicio del bridge"
$nssm = Resolve-Nssm

if (-not $ServiceName) {
  if ($DoorId) {
    $safe = ($DoorId -replace '[^A-Za-z0-9_-]', '_')
    $ServiceName = "LibroGuardiaDoor-$safe"
  } else {
    $candidates = @(
      Get-Service -Name 'LibroGuardiaDoor*' -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty Name
    )
    if ($candidates.Count -eq 1) {
      $ServiceName = $candidates[0]
    } elseif ($candidates.Count -gt 1) {
      Write-Host "Hay varios servicios:" -ForegroundColor Yellow
      $candidates | ForEach-Object { Write-Host "  - $_" }
      throw "Pasá -DoorId o -ServiceName (ej. -DoorId puerta-p1)"
    } else {
      $ServiceName = 'LibroGuardiaDoorReader'
    }
  }
}

Write-Host "Servicio: $ServiceName"
$statusBefore = & $nssm status $ServiceName 2>&1 | Out-String
Write-Host ("Estado actual: " + $statusBefore.Trim())

$bridgePath = Join-Path $ScriptsDir 'door-reader-bridge.js'
if (-not (Test-Path $bridgePath)) {
  throw "No esta door-reader-bridge.js en $ScriptsDir. Copiá el archivo nuevo ahi primero."
}

# Mostrar version del archivo (sin arrancar Node completo si falla el require).
$versionLine = Select-String -Path $bridgePath -Pattern "BRIDGE_VERSION\s*=\s*'([^']+)'" |
  Select-Object -First 1
if ($versionLine) {
  Write-Host ("Archivo local: bridge " + $versionLine.Matches[0].Groups[1].Value) -ForegroundColor Green
}

Write-Step "Reiniciando servicio"
& $nssm restart $ServiceName
if ($LASTEXITCODE -ne 0) {
  throw "nssm restart fallo (exit $LASTEXITCODE). Probá como Administrador."
}

Start-Sleep -Seconds 2
$statusAfter = & $nssm status $ServiceName 2>&1 | Out-String
Write-Host ("Estado luego: " + $statusAfter.Trim())

Write-Step "Verificacion"
Write-Host "1) En esta PC o en otra de la planta, abri:"
Write-Host ("   http://127.0.0.1:{0}/   (o http://IP-DE-LA-MINI:{0}/)" -f $Port) -ForegroundColor Green
Write-Host "2) Pegá el secreto de Admin → Estaciones, IP del relé, Cargar puertas, Abrir."
Write-Host ""
Write-Host "Para chequear version por API (opcional):"
if ($Secret) {
  try {
    $headers = @{ Authorization = "Bearer $Secret"; Accept = 'application/json' }
    $status = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/status" -Headers $headers -TimeoutSec 5
    Write-Host ("bridgeVersion=" + $status.bridgeVersion + "  api=" + $status.localStationApiVersion) -ForegroundColor Green
  } catch {
    Write-Host ("No respondio /status: " + $_.Exception.Message) -ForegroundColor Yellow
  }
} else {
  Write-Host ("  curl.exe -s -H `"Authorization: Bearer TU_SECRETO`" http://127.0.0.1:{0}/status" -f $Port)
}

Write-Host ""
Write-Host "Listo. Si el servicio no arranca, mira el log:" -ForegroundColor Cyan
Write-Host ("  " + (Join-Path $ScriptsDir 'door-reader-bridge.service.log'))
