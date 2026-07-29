# Arranca el puente SR201 local (5022) para que Firebase pueda abrir por internet
# via Cloudflare Tunnel. No configura el tunel: eso se hace una vez en Cloudflare.
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$ScriptsDir = Split-Path -Parent $PSScriptRoot

function Write-Step([string]$msg) {
  Write-Host ""
  Write-Host "==> $msg" -ForegroundColor Cyan
}

$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Write-Host "Ejecuta como Administrador." -ForegroundColor Red
  exit 1
}

$bridgeJs = Join-Path $ScriptsDir 'programa-apertura-internet.js'
$configJson = Join-Path $ScriptsDir 'configuracion-apertura-internet.json'
if (-not (Test-Path $bridgeJs)) { throw "Falta $bridgeJs" }
if (-not (Test-Path $configJson)) { throw "Falta $configJson" }

Write-Step "Instalando / reiniciando puente SR201 (puerto 5022)"
& (Join-Path $ScriptsDir '_interno\instalar-apertura-internet.ps1')

Write-Step "Health local"
try {
  $health = Invoke-RestMethod -Uri 'http://127.0.0.1:5022/health' -TimeoutSec 5
  Write-Host ("  OK local -> SR201 {0}:{1} (v{2})" -f $health.sr201Host, $health.sr201Port, $health.version) -ForegroundColor Green
} catch {
  Write-Host ("  FALLO health local: {0}" -f $_.Exception.Message) -ForegroundColor Red
  throw
}

Write-Step "Cloudflare Tunnel"
$cloudflared = Get-Command cloudflared -ErrorAction SilentlyContinue
if (-not $cloudflared) {
  Write-Host "  cloudflared NO esta instalado." -ForegroundColor Yellow
} else {
  Write-Host ("  cloudflared: {0}" -f $cloudflared.Source) -ForegroundColor Green
  $svc = Get-Service -Name 'Cloudflared' -ErrorAction SilentlyContinue
  if ($svc -and $svc.Status -eq 'Running') {
    Write-Host "  Servicio Cloudflared: Running" -ForegroundColor Green
  } else {
    Write-Host "  Servicio Cloudflared: NO corre (o no instalado)." -ForegroundColor Yellow
    Write-Host "  Sin tunel, Firebase no llega a esta PC. Por eso Admin dice Sin conexion." -ForegroundColor Yellow
  }
}

Write-Host ""
Write-Host "Siguiente (si el tunel no esta):" -ForegroundColor Cyan
Write-Host "  1) En Admin -> Puertas -> Conexion a planta, mira la URL del puente (https://...)"
Write-Host "  2) Ese hostname tiene que existir en Cloudflare Zero Trust -> Tunnels"
Write-Host "  3) Service del tunel = http://127.0.0.1:5022"
Write-Host "  4) cloudflared service install + start (con el token del tunel)"
Write-Host ""
Write-Host "Secreto del puente local (Admin y config deben coincidir):" -ForegroundColor Cyan
$cfg = Get-Content $configJson -Raw -Encoding UTF8 | ConvertFrom-Json
Write-Host ("  bridgeSecret = {0}" -f $cfg.bridgeSecret)
Write-Host ""
Read-Host "Enter para salir"

