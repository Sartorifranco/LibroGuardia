@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Puente BioStar -^> MSS Guard (prueba manual)
echo.
echo  Puente BioStar 2 -^> MSS Guard (modo prueba)
echo  Deja esta ventana abierta. Ctrl+C para detener.
echo.
echo  Para dejarlo permanente (recomendado en produccion):
echo    cerrá esta ventana y ejecutá 05-instalar-servicio-biostar.cmd
echo.
if not exist "configuracion-biostar.json" (
  echo  Falta configuracion-biostar.json
  echo  Copiá configuracion-biostar.ejemplo.json y completá usuario/clave.
  pause
  exit /b 1
)
node programa-biostar.js
echo.
pause
