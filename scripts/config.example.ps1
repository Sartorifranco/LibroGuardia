# Copiá este archivo como config.ps1 y editá los valores.
#   copy config.example.ps1 config.ps1

# --- Servidor backend (Windows) ---
$ServerIP       = "192.168.0.9"
$ServerUser     = "Administrador"          # usuario Windows del servidor
$ServerBackend  = "C:\LG\backend-libro-guardia"

# --- Proyecto local ---
$LocalRoot      = "C:\Users\Admin\Desktop\LG"

# --- PM2 (nombre del proceso en el servidor) ---
$Pm2ProcessName = "bacarguard-api"
