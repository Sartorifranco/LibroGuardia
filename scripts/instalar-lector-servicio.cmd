@echo off
REM Solo (re)instala el servicio NSSM usando door-reader.config.json ya guardado.
cd /d "%~dp0"
net session >nul 2>&1
if errorlevel 1 (
  echo Solicitando privilegios de Administrador...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0instalar-lector.ps1" -UseExistingConfig %*
echo.
pause
