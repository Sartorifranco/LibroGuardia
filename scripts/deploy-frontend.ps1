# Despliega el frontend a Firebase Hosting (bacarguard.web.app)
# Uso: .\scripts\deploy-frontend.ps1

$ErrorActionPreference = "Stop"
$frontend = Join-Path $PSScriptRoot "..\frontend-libro-guardia"

Write-Host ">> Build frontend..." -ForegroundColor Cyan
Set-Location $frontend
npm run build

Write-Host ">> Deploy a Firebase (bacarguard)..." -ForegroundColor Cyan
firebase deploy --only hosting:bacarguard

Write-Host ">> Listo: https://bacarguard.web.app" -ForegroundColor Green
