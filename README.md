# Libro de Novedades Bacar S.A.

Sistema web para registrar personal, vehÃ­culos externos, flota interna y novedades de guardia,
con control de acceso (molinete/puertas) vÃ­a SR201.

## Arquitectura â€” Firebase + puente local de hardware

| Componente | Servicio |
|---|---|
| Frontend | Firebase Hosting â†’ https://mss-guard.web.app |
| Backend / API | Cloud Functions â†’ `/api/*` (Firestore) |
| Base de datos | **Firestore** (sin MongoDB) |
| Molinete / puertas | `scripts/sr201-bridge.js` en PC de planta (HTTP â†’ TCP SR201) â€” **mantener** |
| Citaciones Excel | `scripts/citaciones-folder-bridge.js` â€” **en uso, mantener** |

El frontend **no** habla con Firestore directamente (`firestore.rules` lo bloquea): todo pasa por Cloud Functions.

**GuÃ­a setup:** [FIREBASE-SETUP.md](./FIREBASE-SETUP.md)  
**InstalaciÃ³n cliente nuevo:** [INSTALL-CLIENTE-NUEVO.md](./INSTALL-CLIENTE-NUEVO.md)  
**Puente SR201:** [docs/INSTALACION-SR201.md](./docs/INSTALACION-SR201.md)  
**Lector puerta desatendida:** [docs/INSTALACION-LECTOR-PUERTA.md](./docs/INSTALACION-LECTOR-PUERTA.md)  
**Puente citaciones:** [docs/CITACIONES-FOLDER-BRIDGE.md](./docs/CITACIONES-FOLDER-BRIDGE.md)  
**MigraciÃ³n backend:** [docs/MIGRACION-BACKEND.md](./docs/MIGRACION-BACKEND.md)

---

## Deploy (producciÃ³n)

### GitHub Actions (recomendado)

En cada push/PR corre el job **Test**. En push a `main` (o vÃ­a *Actions â†’ CI â†’ Run workflow*) corre **Deploy** de Hosting + Cloud Functions, usando `.firebaserc` / `firebase.json` del repo.

**Secret requerido** (Settings â†’ Secrets and variables â†’ Actions):

| Secret | Contenido |
|--------|-----------|
| `FIREBASE_SERVICE_ACCOUNT` | JSON completo de una cuenta de servicio de Google Cloud con rol **Firebase Admin** (o equivalente para deploy de Hosting + Functions) |

**CÃ³mo generar el JSON (por instalaciÃ³n / cliente):**

1. AbrÃ­ [Google Cloud Console](https://console.cloud.google.com/) â†’ proyecto Firebase del cliente.
2. IAM y administraciÃ³n â†’ Cuentas de servicio â†’ Crear cuenta de servicio (ej. `github-deploy`).
3. OtorgÃ¡ el rol **Firebase Admin** (o *Firebase Hosting Admin* + *Cloud Functions Admin* + *Service Account User* si preferÃ­s roles mÃ¡s acotados).
4. En la cuenta â†’ Claves â†’ Agregar clave â†’ JSON â†’ descargar el archivo.
5. En el repo de GitHub del cliente: Settings â†’ Secrets â†’ New repository secret â†’ nombre `FIREBASE_SERVICE_ACCOUNT` â†’ pegÃ¡ el contenido completo del JSON.

Cada cliente tiene su propio repo/proyecto Firebase y su propio secret; el workflow no hardcodea el project id.

El puente SR201 **no** se despliega desde Actions (la PC de planta no es alcanzable desde internet). SeguÃ­ usando `.\scripts\deploy-sr201-bridge.ps1` en planta.

### Manual (fallback PowerShell)

```powershell
# Frontend + Functions + Firestore rules/indexes
.\scripts\deploy-firebase.ps1

# Solo frontend
.\scripts\deploy-frontend.ps1
```

No hay backend Node+Mongo que desplegar. El API viejo estÃ¡ archivado en `legacy/backend-libro-guardia/` (**no usar**).

### Servicios locales en planta (mantener â€” no son el API Node/Mongo)

En PCs de la red local (siempre encendidas), dejar corriendo:

| Servicio | Docs |
|----------|------|
| Puente SR201 | [docs/INSTALACION-SR201.md](./docs/INSTALACION-SR201.md) Â· `.\scripts\setup-servidor.ps1` |
| Puente citaciones Excel | [docs/CITACIONES-FOLDER-BRIDGE.md](./docs/CITACIONES-FOLDER-BRIDGE.md) |

```powershell
.\scripts\setup-servidor.ps1          # instrucciones SR201
.\scripts\deploy-sr201-bridge.ps1     # sincroniza scripts del bridge SR201 (opcional)
```

---

## Desarrollo local

```powershell
cd frontend-libro-guardia
npm install
# .env.development apunta a https://mss-guard.web.app/api (Firebase)
npm start
```

Opcional â€” emuladores Firebase:

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
| `monitoreo` | VehÃ­culos autorizados / botonera monitoreo |
| `admin` | Acceso completo + roles / SR201 / GPS config |

---

## Backend â€” estructura de rutas

`functions/app.js` solo arma Express (cors, JSON) y monta los routers.
La lÃ³gica de cada endpoint estÃ¡ en `functions/routes/*.js` (paths absolutos `/api/...`).
Middleware compartido: `functions/middleware/auth.js`.

| Archivo | Dominio |
|---------|---------|
| `routes/auth.js` | Health, bootstrap setup, login / me / change-password |
| `routes/adminUsersRoles.js` | Usuarios, roles, permisos por rol |
| `routes/masterData.js` | Personal, citaciones master, vehÃ­culos autorizados |
| `routes/authorizations.js` | Autorizaciones, imports/bridge de citaciones |
| `routes/access.js` | Access-control, puertas, airlock, kiosk, validar, scan |
| `routes/fleetGps.js` | Flota (mÃ³viles/choferes) y GPS UBIKA |
| `routes/attendance.js` | NÃ³mina, citados, alertas de asistencia |
| `routes/entries.js` | `GET/POST /api/entries` |
| `routes/peopleDoors.js` | `allowedDoorIds` por persona / puerta |
| `routes/system.js` | BÃºsqueda, actividad, auditorÃ­a, reportes, notificaciones, vencimientos |

Drivers de puerta: `functions/lib/doorDrivers/`. Reportes gerenciales: `functions/reports.js`.

## Endpoints principales

- `GET /api/health`
- `POST /api/auth/login` Â· `GET /api/auth/me` Â· `POST /api/auth/change-password`
- `GET/POST /api/entries`
- Control de acceso: `/api/access/*`, `/api/guard/open-door`, `/api/admin/doors-config`
- Reportes: `GET /api/reports/summary`
- Citaciones, nÃ³mina, GPS flota, roles, auditorÃ­a, notificaciones: ver tabla de routers arriba

## Legacy

`legacy/backend-libro-guardia/` â€” Express + Mongo histÃ³rico. **No desplegar.** Ver `legacy/README.md`.
