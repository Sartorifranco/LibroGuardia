@echo off
REM Emparejar lector + instalar servicio (NSSM). Pedir "Ejecutar como administrador".
cd /d "%~dp0"
net session >nul 2>&1
if errorlevel 1 (
  echo Solicitando privilegios de Administrador...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0instalar-lector.ps1" %*
echo.
pause
