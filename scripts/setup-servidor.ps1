# Ejecutar UNA VEZ en el SERVIDOR (192.168.0.9) como administrador.
# Instala PM2 para que la API quede corriendo siempre y se reinicie sola.
#
# Copiá y pegá estos comandos en PowerShell del servidor:

Write-Host @"

=== SETUP SERVIDOR (ejecutar en 192.168.0.9) ===

1. Instalar PM2 global:
   npm install -g pm2
   npm install -g pm2-windows-startup
   pm2-startup install

2. Iniciar la API:
   cd C:\LG\backend-libro-guardia
   npm install
   pm2 start server.js --name bacarguard-api
   pm2 save

3. Habilitar OpenSSH (para deploy remoto desde tu PC):
   Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
   Start-Service sshd
   Set-Service -Name sshd -StartupType Automatic

4. (Opcional) Clonar con Git en el servidor:
   cd C:\LG
   git clone https://github.com/TU_USUARIO/libro-guardia.git .
   cd backend-libro-guardia
   copy .env.example .env
   # editar .env con MongoDB y JWT_SECRET

Comandos útiles en el servidor:
   pm2 status
   pm2 logs bacarguard-api
   pm2 restart bacarguard-api

"@ -ForegroundColor Yellow
