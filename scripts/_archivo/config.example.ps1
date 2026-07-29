# Copiá este archivo como config.ps1 y editá los valores.
#   copy config.example.ps1 config.ps1
#
# Solo se usa para sincronizar el puente SR201 a la PC de planta.
# El API de negocio vive en Firebase (no hay deploy de backend Node).

# --- PC / servidor de planta (Windows) ---
$ServerIP       = "192.168.0.9"
$ServerUser     = "Administrador"
$ServerScripts  = "C:\LG\scripts"

# --- Proyecto local ---
$LocalRoot      = "C:\Users\Admin\Desktop\LG"

# --- PM2 (puente SR201) ---
$Pm2BridgeName  = "bacarguard-sr201-bridge"
