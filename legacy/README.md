# LEGACY â€” backend Node + MongoDB (NO USAR)

Este directorio es el **API Express + MongoDB histÃ³rico**.  
**No forma parte del runtime de producciÃ³n.**

## Backend real

| Componente | UbicaciÃ³n |
|---|---|
| API / lÃ³gica de negocio | `functions/` (Firebase Cloud Functions + Firestore) |
| Frontend | `frontend-libro-guardia/` â†’ Hosting |
| Hardware molinete/SR201 | `scripts/sr201-bridge.js` (puente mÃ­nimo en LAN) |
| Citaciones Excel | `scripts/citaciones-folder-bridge.js` (opcional) |

Ver: [`docs/MIGRACION-BACKEND.md`](../../docs/MIGRACION-BACKEND.md) Â· [`FIREBASE-SETUP.md`](../../FIREBASE-SETUP.md)

## Por quÃ© sigue en el repo

Solo como referencia histÃ³rica / rollback de emergencia.  
**No desplegar** con PM2 ni apuntar el frontend a este servicio.

## Si necesitÃ¡s consulta local

```powershell
# NO recomendado. PreferÃ­ emulador o https://mss-guard.web.app/api
cd legacy/backend-libro-guardia
npm install
# requiere MongoDB + .env propio
```

En producciÃ³n: `pm2 stop bacarguard-api` / `pm2 delete bacarguard-api`.
