# Setup en PC de planta (puentes locales, NO el API Mongo)

El Libro de Guardia corre en Firebase. En planta solo hace falta:

1. **Puente SR201** — obligatorio si hay molinete/puertas (`scripts/sr201-bridge.js`)
2. **Puente citaciones** — opcional (`scripts/citaciones-folder-bridge.js`)

NO iniciar `bacarguard-api` ni MongoDB para este sistema.

---

## SR201 bridge (recomendado con PM2)

```powershell
npm install -g pm2 pm2-windows-startup
pm2-startup install

cd C:\LG\scripts   # o la carpeta donde copien scripts/
$env:SR201_HOST="192.168.0.50"
$env:SR201_PORT="6722"
$env:BRIDGE_PORT="5022"
$env:BRIDGE_SECRET="una-clave-secreta-larga"
pm2 start sr201-bridge.js --name bacarguard-sr201-bridge
pm2 save
```

Health:
```powershell
Invoke-RestMethod http://127.0.0.1:5022/health
```

Configurar en Admin → Control SR201 la **URL del puente** reachable desde internet
(túnel Cloudflare/ngrok o IP pública). Una IP LAN sola no es alcanzable desde Cloud Functions.

Ver: docs/INSTALACION-SR201.md

---

## Citaciones folder-bridge (opcional)

```powershell
cd C:\LG\scripts
copy citaciones-bridge.config.example.json citaciones-bridge.config.json
# editar watchFolder + bridgeSecret
pm2 start citaciones-folder-bridge.js --name bacarguard-citaciones-bridge
pm2 save
```

---

## Apagar el API Node+Mongo viejo (si aún corre)

```powershell
pm2 stop bacarguard-api
pm2 delete bacarguard-api
pm2 save
```

El código histórico está en `legacy/backend-libro-guardia/` (solo referencia).
