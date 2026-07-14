# LEGACY — backend Node + MongoDB (NO USAR)

Este directorio es el **API Express + MongoDB histórico**.  
**No forma parte del runtime de producción.**

## Backend real

| Componente | Ubicación |
|---|---|
| API / lógica de negocio | `functions/` (Firebase Cloud Functions + Firestore) |
| Frontend | `frontend-libro-guardia/` → Hosting |
| Hardware molinete/SR201 | `scripts/sr201-bridge.js` (puente mínimo en LAN) |
| Citaciones Excel | `scripts/citaciones-folder-bridge.js` (opcional) |

Ver: [`docs/MIGRACION-BACKEND.md`](../../docs/MIGRACION-BACKEND.md) · [`FIREBASE-SETUP.md`](../../FIREBASE-SETUP.md)

## Por qué sigue en el repo

Solo como referencia histórica / rollback de emergencia.  
**No desplegar** con PM2 ni apuntar el frontend a este servicio.

## Si necesitás consulta local

```powershell
# NO recomendado. Preferí emulador o https://bacarguard.web.app/api
cd legacy/backend-libro-guardia
npm install
# requiere MongoDB + .env propio
```

En producción: `pm2 stop bacarguard-api` / `pm2 delete bacarguard-api`.
