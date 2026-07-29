# Instalar puente de carpeta de citaciones (Windows)
# Ejecutar en PowerShell como administrador si quiere tarea programada al inicio.

$ErrorActionPreference = 'Stop'
$ScriptsDir = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host "=== Puente carpeta citaciones Bacar Guardia ===" -ForegroundColor Cyan

Push-Location $ScriptsDir
npm install

if (-not (Test-Path "citaciones-bridge.config.json")) {
  Copy-Item "citaciones-bridge.config.example.json" "citaciones-bridge.config.json"
  Write-Host "Se creó citaciones-bridge.config.json — edítelo antes de continuar." -ForegroundColor Yellow
}

$config = Get-Content "citaciones-bridge.config.json" | ConvertFrom-Json
$watchFolder = $config.watchFolder
if (-not (Test-Path $watchFolder)) {
  New-Item -ItemType Directory -Path $watchFolder | Out-Null
  Write-Host "Carpeta creada: $watchFolder" -ForegroundColor Green
}

Write-Host @"

Próximos pasos:
1. En Admin > Autorizaciones, habilite el puente y copie el secreto en citaciones-bridge.config.json
2. Indique la carpeta que usa transporte (watchFolder), ej. C:\CitacionesTransporte
3. Ejecute: node citaciones-folder-bridge.js
4. (Opcional) Instale PM2 para que quede siempre activo:
   npm install -g pm2
   pm2 start citaciones-folder-bridge.js --name bacarguard-citaciones --cwd "$ScriptsDir"
   pm2 save

Cuando transporte guarde una planilla nueva en la carpeta, se cargará automáticamente.

"@ -ForegroundColor White

Pop-Location
