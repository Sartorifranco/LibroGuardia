@echo off
REM 3) Solo si abris puertas "a distancia" por internet (tunel Cloudflare + placa).
cd /d "%~dp0"
net session >nul 2>&1
if errorlevel 1 (
  echo Solicitando privilegios de Administrador...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0_interno\arrancar-apertura-internet.ps1"
echo.
pause
