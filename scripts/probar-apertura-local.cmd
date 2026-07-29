@echo off
REM Reinicia el bridge. NO abre la pagina :8787.
REM Despues: https://mss-guard.web.app → Admin → Puertas → Probar apertura
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0probar-apertura-local.ps1" -OpenAdmin
if errorlevel 1 pause
exit /b %ERRORLEVEL%
