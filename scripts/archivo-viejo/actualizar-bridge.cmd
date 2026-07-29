@echo off
REM Actualiza el servicio del bridge reiniciandolo (despues de copiar door-reader-bridge.js).
REM Ejecutar como Administrador en la mini PC, desde la carpeta scripts.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0actualizar-bridge.ps1" %*
exit /b %ERRORLEVEL%
