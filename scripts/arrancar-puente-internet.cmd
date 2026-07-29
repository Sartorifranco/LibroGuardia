@echo off
REM Arranca el puente SR201 (puerto 5022) para apertura por internet.
REM Requiere: Cloudflare Tunnel apuntando a http://127.0.0.1:5022
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0arrancar-puente-internet.ps1"
if errorlevel 1 pause
exit /b %ERRORLEVEL%
