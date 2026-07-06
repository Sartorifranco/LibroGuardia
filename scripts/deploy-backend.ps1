# Sincroniza el backend al servidor y reinicia la API.
# Requiere: scripts/config.ps1, OpenSSH en el servidor, acceso por red.
#
# Uso: .\scripts\deploy-backend.ps1

$ErrorActionPreference = "Stop"

$configPath = Join-Path $PSScriptRoot "config.ps1"
if (-not (Test-Path $configPath)) {
    Write-Host "Falta scripts/config.ps1 — copiá config.example.ps1 y editá los datos del servidor." -ForegroundColor Red
    exit 1
}
. $configPath

$localBackend = Join-Path $LocalRoot "backend-libro-guardia"
$remoteShare  = "\\$ServerIP\C$\LG\backend-libro-guardia"

Write-Host ">> Sincronizando backend a $remoteShare ..." -ForegroundColor Cyan

# Robocopy: copia archivos nuevos/modificados sin borrar node_modules ni .env del servidor
robocopy $localBackend $remoteShare /E /XO `
    /XD node_modules Bak .git `
    /XF .env package-lock.json `
    /NFL /NDL /NJH /NJS /nc /ns /np

if ($LASTEXITCODE -ge 8) {
    Write-Host "Robocopy falló (código $LASTEXITCODE). Verificá acceso a $remoteShare" -ForegroundColor Red
    exit 1
}

Write-Host ">> Reiniciando API en el servidor..." -ForegroundColor Cyan

$remoteCmd = @"
cd $ServerBackend
if (Get-Command pm2 -ErrorAction SilentlyContinue) {
  pm2 restart $Pm2ProcessName 2>`$null
  if (`$LASTEXITCODE -ne 0) { pm2 start server.js --name $Pm2ProcessName }
} else {
  Write-Host 'PM2 no instalado. Reiniciá manualmente: npm start'
}
"@

ssh "${ServerUser}@${ServerIP}" $remoteCmd

Write-Host ">> Backend actualizado." -ForegroundColor Green
Write-Host "   Probar: http://${ServerIP}:5020/api/health" -ForegroundColor Gray
