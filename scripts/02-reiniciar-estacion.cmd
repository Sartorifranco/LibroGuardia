@echo off
REM 2) Despues de actualizar el programa: reinicia el servicio y abre Admin.
cd /d "%~dp0"
net session >nul 2>&1
if errorlevel 1 (
  echo Solicitando privilegios de Administrador...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0_interno\reiniciar-estacion.ps1" -OpenAdmin
echo.
pause
