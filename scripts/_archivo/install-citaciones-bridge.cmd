@echo off
setlocal
cd /d "%~dp0"

echo === Puente carpeta citaciones Bacar Guardia ===
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo ERROR: Node.js no esta instalado en esta PC.
  echo.
  echo Instale Node.js LTS desde: https://nodejs.org/
  echo Descargue "LTS" ^(version recomendada^), ejecute el instalador
  echo y marque "Automatically install the necessary tools".
  echo Cierre esta ventana, abra CMD de nuevo y vuelva a ejecutar:
  echo   install-citaciones-bridge.cmd
  echo.
  pause
  exit /b 1
)

where npm >nul 2>&1
if errorlevel 1 (
  echo ERROR: npm no esta en el PATH. Reinstale Node.js o reinicie la PC.
  pause
  exit /b 1
)

echo Node: 
node -v
echo npm:
npm -v
echo.

call npm install
if errorlevel 1 exit /b 1

if not exist "citaciones-bridge.config.json" (
  copy /Y "citaciones-bridge.config.example.json" "citaciones-bridge.config.json" >nul
  echo Se creo citaciones-bridge.config.json — editelo antes de continuar.
)

for /f "usebackq delims=" %%F in (`powershell -NoProfile -Command "(Get-Content 'citaciones-bridge.config.json' | ConvertFrom-Json).watchFolder"`) do set "WATCH_FOLDER=%%F"

if not exist "%WATCH_FOLDER%" (
  mkdir "%WATCH_FOLDER%" 2>nul
  echo Carpeta creada: %WATCH_FOLDER%
)

echo.
echo Proximos pasos:
echo 1. En Admin ^> Autorizaciones, habilite el puente y copie el secreto en citaciones-bridge.config.json
echo 2. Indique la carpeta que usa transporte (watchFolder), ej. C:\CitacionesTransporte
echo 3. Ejecute: node citaciones-folder-bridge.js
echo 4. (Opcional) PM2 para dejarlo siempre activo:
echo    npm install -g pm2
echo    pm2 start citaciones-folder-bridge.js --name bacarguard-citaciones --cwd "%CD%"
echo    pm2 save
echo.
echo Cuando transporte guarde una planilla nueva en la carpeta, se cargara automaticamente.
echo.

endlocal
