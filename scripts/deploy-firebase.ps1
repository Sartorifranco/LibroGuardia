# Despliega frontend + Cloud Functions a Firebase
# Uso: .\scripts\deploy-firebase.ps1
# Puente SR201 (planta): .\scripts\deploy-sr201-bridge.ps1

$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent

Write-Host ">> Instalando dependencias de Cloud Functions..." -ForegroundColor Cyan
Set-Location (Join-Path $root "functions")
npm install

Write-Host ">> Build frontend..." -ForegroundColor Cyan
Set-Location (Join-Path $root "frontend-libro-guardia")
# Evitar que CI trate warnings de ESLint como fallo a medias / build vacío
$env:CI = "false"
npm run build
if ($LASTEXITCODE -ne 0) { throw "Build del frontend falló (exit $LASTEXITCODE)" }
$indexHtml = Join-Path (Get-Location) "build\index.html"
if (-not (Test-Path $indexHtml)) {
  throw "Build incompleto: no existe build\index.html. Abortando deploy de Hosting."
}

Write-Host ">> Deploy a Firebase (hosting + functions)..." -ForegroundColor Cyan
Set-Location $root
firebase deploy --only "hosting,functions"

Write-Host "`n>> Listo: https://bacarguard.web.app" -ForegroundColor Green
Write-Host "   API: https://bacarguard.web.app/api/health" -ForegroundColor Gray
Write-Host "   Puente SR201 (si aplica): .\scripts\deploy-sr201-bridge.ps1" -ForegroundColor Gray
