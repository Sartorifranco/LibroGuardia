@echo off
REM 1) Primera vez: empareja el lector con el codigo de Admin e instala el servicio.
cd /d "%~dp0"
net session >nul 2>&1
if errorlevel 1 (
  echo Solicitando privilegios de Administrador...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0_interno\instalar-estacion.ps1" %*
echo.
pause
