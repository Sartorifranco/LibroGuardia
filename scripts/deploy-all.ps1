# Despliega frontend (Firebase) + backend (servidor)
# Uso: .\scripts\deploy-all.ps1

$ErrorActionPreference = "Stop"
$scripts = $PSScriptRoot

& (Join-Path $scripts "deploy-backend.ps1")
& (Join-Path $scripts "deploy-frontend.ps1")

Write-Host "`n>> Deploy completo." -ForegroundColor Green
