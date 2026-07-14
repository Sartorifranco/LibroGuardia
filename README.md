# Libro de Novedades Bacar S.A.

Sistema web para registrar personal, vehículos externos, flota interna y novedades de guardia,
con control de acceso (molinete/puertas) vía SR201.

## Arquitectura — Firebase + puente local de hardware

| Componente | Servicio |
|---|---|
| Frontend | Firebase Hosting → https://bacarguard.web.app |
| Backend / API | Cloud Functions → `/api/*` (Firestore) |
| Base de datos | **Firestore** (sin MongoDB) |
| Molinete / puertas | `scripts/sr201-bridge.js` en PC de planta (HTTP → TCP SR201) |
| Citaciones Excel (opc.) | `scripts/citaciones-folder-bridge.js` |

El frontend **no** habla con Firestore directamente (`firestore.rules` lo bloquea): todo pasa por Cloud Functions.

**Guía setup:** [FIREBASE-SETUP.md](./FIREBASE-SETUP.md)  
**Puente SR201:** [docs/INSTALACION-SR201.md](./docs/INSTALACION-SR201.md)  
**Migración backend:** [docs/MIGRACION-BACKEND.md](./docs/MIGRACION-BACKEND.md)

---

## Deploy (producción)

```powershell
# Frontend + Functions + Firestore rules/indexes
.\scripts\deploy-firebase.ps1

# Solo frontend
.\scripts\deploy-frontend.ps1
```

No hay backend Node+Mongo que desplegar. El API viejo está archivado en `legacy/backend-libro-guardia/` (**no usar**).

### Puente de hardware en planta (si usan molinete/SR201)

En una PC de la red local (siempre encendida), dejar corriendo solo el bridge:

```powershell
.\scripts\setup-servidor.ps1          # instrucciones
.\scripts\deploy-sr201-bridge.ps1     # sincroniza scripts del bridge (opcional)
```

Detalle: [docs/INSTALACION-SR201.md](./docs/INSTALACION-SR201.md).

---

## Desarrollo local

```powershell
cd frontend-libro-guardia
npm install
# .env.development apunta a https://bacarguard.web.app/api (Firebase)
npm start
```

Opcional — emuladores Firebase:

```powershell
firebase emulators:start --only functions,hosting,firestore
# ajustar REACT_APP_API_BASE_URL al puerto del emulador
```

---

## Roles de usuario

| Rol | Permisos (resumen) |
|---|---|
| `guardia` | Registro, kiosk, puertas, GPS, asistencia |
| `supervisor` | Lo anterior + maestros, flota, usuarios |
| `monitoreo` | Vehículos autorizados / botonera monitoreo |
| `admin` | Acceso completo + roles / SR201 / GPS config |

---

## Endpoints principales

- `GET /api/health`
- `POST /api/auth/login` · `GET /api/auth/me`
- `GET/POST /api/entries`
- Control de acceso: `/api/access/*`, `/api/guard/open-door`, `/api/admin/doors-config`
- Citaciones, nómina, GPS flota, roles: ver `functions/app.js`

## Legacy

`legacy/backend-libro-guardia/` — Express + Mongo histórico. **No desplegar.** Ver `legacy/README.md`.
