@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Puente BioStar -^> MSS Guard
echo.
echo  Puente BioStar 2 -^> MSS Guard
echo  Deja esta ventana abierta. Ctrl+C para detener.
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
