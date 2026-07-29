# Atajo viejo: preferí scripts\03-arrancar-apertura-por-internet.cmd
$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$bridge = Join-Path $root "scripts\programa-apertura-internet.js"
if (-not (Test-Path $bridge)) { throw "No encuentro scripts\programa-apertura-internet.js" }
Write-Host ">> Apertura por internet (mejor usar 03-arrancar-apertura-por-internet.cmd)" -ForegroundColor Cyan
node $bridge
