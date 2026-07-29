@echo off
REM Generado por instalar-apertura-internet — no editar a mano salvo ruta de Node.
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo No se encontro node en el PATH.
  exit /b 1
)
node "%~dp0programa-apertura-internet.js" >> "%~dp0apertura-internet.service.log" 2>&1
