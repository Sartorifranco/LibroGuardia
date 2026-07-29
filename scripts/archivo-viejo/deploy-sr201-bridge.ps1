# Sincroniza scripts/sr201-bridge.js a la PC de planta y reinicia el puente PM2.
# NO despliega API de negocio (eso es Firebase: deploy-firebase.ps1).
#
# Requiere: scripts/config.ps1, acceso por red/SSH a la PC de planta.
# Uso: .\scripts\deploy-sr201-bridge.ps1

$ErrorActionPreference = "Stop"

$configPath = Join-Path $PSScriptRoot "config.ps1"
if (-not (Test-Path $configPath)) {
    Write-Host "Falta scripts/config.ps1 — copiá config.example.ps1 y editá los datos de planta." -ForegroundColor Red
    exit 1
}
. $configPath

$localScripts = Join-Path $LocalRoot "scripts"
$remoteShare  = "\\$ServerIP\C$\LG\scripts"

if (-not $ServerScripts) { $ServerScripts = "C:\LG\scripts" }
if (-not $Pm2BridgeName) { $Pm2BridgeName = "bacarguard-sr201-bridge" }

Write-Host ">> Sincronizando puente SR201 a $remoteShare ..." -ForegroundColor Cyan

robocopy $localScripts $remoteShare "sr201-bridge.js" `
    /NFL /NDL /NJH /NJS /nc /ns /np

# También sincroniza el helper TCP desde functions/sr201.js (require relativo del bridge)
$localSr201 = Join-Path $LocalRoot "functions\sr201.js"
$remoteFnShare = "\\$ServerIP\C$\LG\functions"
New-Item -ItemType Directory -Force -Path $remoteFnShare | Out-Null
Copy-Item -Force $localSr201 (Join-Path $remoteFnShare "sr201.js")

if ($LASTEXITCODE -ge 8) {
    Write-Host "Robocopy falló (código $LASTEXITCODE). Verificá acceso a $remoteShare" -ForegroundColor Red
    exit 1
}

Write-Host ">> Reiniciando puente en planta..." -ForegroundColor Cyan

$remoteCmd = @"
cd $ServerScripts
if (Get-Command pm2 -ErrorAction SilentlyContinue) {
  pm2 restart $Pm2BridgeName 2>`$null
  if (`$LASTEXITCODE -ne 0) {
    pm2 start sr201-bridge.js --name $Pm2BridgeName
  }
} else {
  Write-Host 'PM2 no instalado. Iniciá manualmente: node sr201-bridge.js'
}
"@

ssh "${ServerUser}@${ServerIP}" $remoteCmd

Write-Host ">> Puente SR201 actualizado." -ForegroundColor Green
Write-Host "   Probar: http://${ServerIP}:5022/health" -ForegroundColor Gray
Write-Host "   API de negocio: .\scripts\deploy-firebase.ps1" -ForegroundColor Gray
