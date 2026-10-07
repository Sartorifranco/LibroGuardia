@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Reiniciar apertura por internet
echo.
echo  Reinicia el puente de apertura por internet (despues de cambiar config o actualizar el .js).
echo  Pedira permisos de Administrador.
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0_interno\reiniciar-apertura-internet.ps1"
