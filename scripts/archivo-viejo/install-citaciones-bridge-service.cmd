@echo off
setlocal
cd /d "%~dp0"

echo === Dejar puente citaciones siempre activo (Windows) ===
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo Instale Node.js LTS desde https://nodejs.org/
  pause
  exit /b 1
)

call npm install -g pm2
if errorlevel 1 exit /b 1

call pm2 delete bacarguard-citaciones >nul 2>&1
call pm2 start "%~dp0citaciones-folder-bridge.js" --name bacarguard-citaciones --cwd "%~dp0"
call pm2 save

echo.
echo Puente iniciado con PM2.
echo.
echo Para que arranque solo al encender Windows y al iniciar sesion:
echo   1. Ejecute CMD como Administrador
echo   2. npm install -g pm2-windows-startup
echo   3. pm2-startup install
echo   4. pm2 save
echo.
echo Comandos utiles:
echo   pm2 status
echo   pm2 logs bacarguard-citaciones
echo   pm2 restart bacarguard-citaciones
echo.
pause
