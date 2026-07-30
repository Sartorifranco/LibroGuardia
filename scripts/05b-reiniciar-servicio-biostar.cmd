@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Reiniciar servicio puente BioStar
echo.
echo  Reinicia el puente BioStar (despues de cambiar config o actualizar el .js).
echo  Pedira permisos de Administrador.
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0_interno\reiniciar-biostar.ps1"
