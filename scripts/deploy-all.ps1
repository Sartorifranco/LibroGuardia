# Despliega la app completa a Firebase (frontend + API Cloud Functions).
# El puente SR201 en planta se actualiza aparte: .\scripts\deploy-sr201-bridge.ps1
#
# Uso: .\scripts\deploy-all.ps1

$ErrorActionPreference = "Stop"
$scripts = $PSScriptRoot

& (Join-Path $scripts "deploy-firebase.ps1")

Write-Host "`n>> Deploy Firebase completo." -ForegroundColor Green
Write-Host "   Si cambió el puente SR201 en planta: .\scripts\deploy-sr201-bridge.ps1" -ForegroundColor Gray
