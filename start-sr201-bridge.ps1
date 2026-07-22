# Arranca el puente SR201 (usa scripts/sr201-bridge.config.json).
# Preferí instalar el servicio: .\scripts\install-sr201-bridge-autostart.ps1

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
Set-Location $root

$bridge = Join-Path $root "scripts\sr201-bridge.js"
if (-not (Test-Path $bridge)) { throw "No encuentro scripts\sr201-bridge.js" }

Write-Host ">> Puente SR201 (config en scripts\sr201-bridge.config.json)" -ForegroundColor Cyan
node $bridge
