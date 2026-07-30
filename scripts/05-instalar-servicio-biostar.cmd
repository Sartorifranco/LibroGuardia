@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Instalar servicio puente BioStar
echo.
echo  Instala el puente BioStar como servicio permanente
echo  (arranca al encender la PC; no hace falta dejar una consola abierta).
echo  Pedira permisos de Administrador.
echo.
if not exist "configuracion-biostar.json" (
  echo  Falta configuracion-biostar.json
  echo  Copiá configuracion-biostar.ejemplo.json y completá usuario/clave.
  pause
  exit /b 1
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0_interno\instalar-biostar.ps1"
echo.
pause
