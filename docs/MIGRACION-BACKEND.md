# Fase 0 — Migración backend: Node+Mongo → Firebase Functions + Firestore

**Fecha:** 2026-07-14  
**Alcance:** investigación no destructiva (sin borrar ni desactivar nada).  
**Conclusión corta:** el hardware (molinete/SR201) **ya no depende** del API Node+Mongo. Depende de **Cloud Functions + un puente local TCP**. El backend `backend-libro-guardia` es legado CRUD y ya está cubierto (y superado) por `functions/`.

---

## 1. Qué hace hoy el backend Node (`backend-libro-guardia`)

Archivo principal: `backend-libro-guardia/server.js` (Express + MongoDB, puerto 5020).

### Rutas (todas son API CRUD / auth)

| Área | Rutas |
|------|--------|
| Health | `GET /api/health` |
| Auth | `POST /api/auth/register`, `login`, `GET /api/auth/me` |
| Users | CRUD `/api/admin/users` |
| Flota listas | upload/GET móviles y choferes |
| Personal | GET/POST `/api/master-data/personal` |
| Libro | GET/POST `/api/entries` |

### Hardware

**Ninguna ruta habla con SR201, relés, puertas ni IPs de placa.**  
Dependencias: solo `express`, `mongoose`, `bcryptjs`, `jsonwebtoken`, `cors`, `dotenv`.

### Modelos Mongo

`users`, `mobiles`, `drivers`, `personalmasters`, `entries`.

---

## 2. Qué hace Firebase Functions respecto al control físico

Implementación **completa** de negocio + apertura en la nube:

| Capacidad | Dónde |
|-----------|--------|
| Validar acceso (DNI / autorizaciones / nómina) | `functions/accessControl.js` |
| Abrir puerta/molinete (auto + manual) | `functions/doorController.js` → `functions/sr201.js` |
| Multi-puerta + estancos | `functions/lib/doorsConfig.js`, `docs/MULTI-PUERTAS.md` |
| Config admin + test relay | `GET/PUT /api/admin/access-control`, `doors-config`, `POST /api/access/test-relay` |
| Kiosk / molinete | `POST /api/access/kiosk-scan`, `POST /api/access/validar` |
| Botón “Abrir puerta” guardia | `POST /api/guard/open-door` |

Endpoints relevantes (ya en prod vía Hosting → Function `api`):

- `GET/PUT /api/admin/access-control`
- `GET/PUT /api/admin/doors-config`
- `POST /api/access/test-relay`
- `GET /api/guard/doors`, `POST /api/guard/open-door`
- `GET/POST /api/guard/airlock/:groupId`
- `POST /api/access/validar`, `/kiosk-scan`, `/evaluate`
- `POST /api/guard/exceptional-entry`

Además, Functions cubre **todo** lo del Node legacy (auth, users, entries, flota) **y** mucho más: citaciones, nómina, GPS UBIKA, roles/permisos, vehículos, asistencia, etc.

---

## 3. Puentes locales: qué debe quedar en planta (≠ backend Mongo)

La app en Firebase **no puede** abrir un socket TCP al SR201 en la LAN del cliente. Eso es normal y esperado.

### Debe mantenerse (procesos locales, no el API Mongo)

| Proceso | Archivo | Rol |
|---------|---------|-----|
| **Puente SR201** | `scripts/sr201-bridge.js` | HTTP (`/pulse`) → TCP `6722` al SR201. Obligatorio para molinete/puertas en producción. |
| **Puente citaciones** | `scripts/citaciones-folder-bridge.js` | Vigila carpeta Excel/CSV y llama a `/api/bridge/citaciones/sync`. Opcional según operación de transporte. |

Flujo real:

```
Guardia / kiosk (web.app)
  → Cloud Function (accessControl / doorController / sr201)
    → si bridgeUrl: POST {bridgeUrl}/pulse
      → sr201-bridge.js (PC planta, p.ej. 192.168.0.9:5022)
        → TCP SR201 (ej. 192.168.0.50:6722)
          → relé → molinete / puerta
```

Documentado en `docs/INSTALACION-SR201.md` y `FIREBASE-SETUP.md`.

### No confundir

- **Puente local SR201/citaciones** = proceso chico en la red del cliente. **Se mantiene.**
- **API Node+Mongo (`bacarguard-api` / `backend-libro-guardia`)** = backend de datos. **Ya no es necesario** para Libro de Guardia ni para el molinete (confirmado también por `FIREBASE-SETUP.md`: “Apagar el servidor viejo”).

### Nota operativa importante (alcance nube → puente)

En la doc de ejemplo aparece `URL puente = http://192.168.0.9:5022`.  
Una IP **privada** **no es alcanzable** desde Cloud Functions salvo que exista:

- túnel (Cloudflare Tunnel / ngrok / similar), o
- IP/DNS público que apunte al bridge, o
- VPN hacia la planta.

Antes de dar de baja definitivamente el API viejo en planta, verificar en Admin → Control SR201 que `bridgeUrl` sea **reachable desde internet** (o túnel) y que “Probar relevador” funcione desde producción.

---

## 4. Cómo elige el frontend qué backend usar

No hay feature flag: solo `REACT_APP_API_BASE_URL`.

| Entorno | Archivo | Valor | Destino |
|---------|---------|-------|---------|
| Dev | `.env.development` | `https://bacarguard.web.app/api` (o emulador) | **Firebase Functions** |
| Prod | `.env.production` | `/api` | Firebase Hosting rewrite → Function `api` |

El frontend **ya no apunta** a `localhost:5020` ni al API Node.

---

## 5. Qué hace Node+Mongo que Functions todavía no cubre

**Para datos y acceso: nada crítico.**  
Todo lo del `server.js` legacy tiene equivalente (mejorado) en `functions/app.js`.

**Lo “único” local que Functions no reemplaza** no es Mongo, sino:

1. Hablar TCP al SR201 en LAN → `scripts/sr201-bridge.js`
2. Watch de carpeta de planillas en una PC de transporte → `scripts/citaciones-folder-bridge.js`

Pendientes de producto (no bloquean migrar Mongo):

- Método de auth `face` (pendiente según `docs/MULTI-PUERTAS.md`)
- Timers de estanco en memoria de la Function (frágiles si la instancia se enfría; mejorar después)

---

## 6. Plan concreto: qué mover / qué eliminar

### Ya está en `functions/` (no hace falta “mover” lógica)

- Auth, users, roles, permissions  
- Entries / libro  
- Personal, vehículos, flota, citaciones, nómina  
- Access control, multi-puertas, SR201 client  
- GPS flota, asistencia, kiosk  

### Mantener (fuera de Firebase, en planta)

- `scripts/sr201-bridge.js` (+ PM2/servicio Windows)  
- `scripts/citaciones-folder-bridge.js` (si usan sync de carpeta)  
- Documentación de instalación de ambos  

### Eliminar / retirar (después de checklist verde)

| Ítem | Acción |
|------|--------|
| Proceso PM2 `bacarguard-api` en `192.168.0.9` | Detener cuando checklist OK (`FIREBASE-SETUP.md`) |
| `backend-libro-guardia/` como dependencia de runtime | Dejar de usarlo; archivar o marcar `LEGACY` en README |
| `.env.development` → `localhost:5020` | Cambiar a Functions/emulador |
| Referencias a Mongo en docs/scripts viejas | Actualizar |

### Checklist antes de apagar Node+Mongo en planta

1. Login y libro diario en https://bacarguard.web.app  
2. Admin → Probar relevador → click físico en molinete/puerta  
3. Kiosk: DNI autorizado abre; denegado no abre  
4. Botón “Abrir puerta” registra evento  
5. `bridgeUrl` alcanzable desde la nube (no solo IP LAN sin túnel)  
6. Citaciones: sync por upload o por folder-bridge → Firestore  
7. GPS / roles / dashboards OK (ya solo viven en Functions)

### Orden sugerido (fases siguientes, sin romper)

1. ~~**Fase 1 — Frontend apunta solo a Functions**~~ → hecha (sección 8).  
2. **Fase 2 — Modularizar `App.js` por dominio** (sin cambiar contratos API).  
3. **Fase 3 — UX/intuitividad / a prueba de errores** (hallazgos acordados).  
4. Commits **separados por tema**, nunca un commit gigante.

---

## 8. Estado Fase 1 (2026-07-14)

Completado:

- [x] Confirmado: ninguna ruta de `server.js` Node faltaba en `functions/app.js` (Functions es un superconjunto).
- [x] Frontend apunta solo a Firebase (`.env.development` → `https://bacarguard.web.app/api`, prod → `/api`).
- [x] `backend-libro-guardia/` movido a `legacy/backend-libro-guardia/` (marcado LEGACY, no desplegar).
- [x] Puente SR201 documentado como servicio mínimo (`scripts/sr201-bridge.js` + `deploy-sr201-bridge.ps1`).
- [x] README y scripts de deploy actualizados (Firebase = app; bridge = hardware).

Siguiente: **Fase 2 — modularizar `App.js` por dominio**.

---

## 9. Estado Fase 2 (2026-07-14)

Completado (refactor puro, sin cambio de UX intencional):

- [x] `services/api.js` — cliente HTTP centralizado (`apiFetch`)
- [x] Contextos: Auth, Toast, Entries, ClockPrefill
- [x] Pages: Login, Home, Personal, VehiculosExternos, FlotaInterna, Novedad, Historial, Admin
- [x] `App.js` como shell (~360 líneas): layout, routing por `activeTab`, providers

Siguiente: **Fase 3 — UX / sesión / manejo de errores** (conectar `api.js` con sesión expirada).

---

## 10. Estado Fase 3 (2026-07-14)

Completado:

- [x] `apiFetch` centralizado: Bearer automático, 401/403 → logout + "Tu sesión expiró…", red tipada, message del backend, genérico honesto
- [x] Cero `fetch` sueltos en frontend (salvo el interior de `services/api.js`)
- [x] Toasts: error manual / éxito 5s (sin cambio de política)
- [x] `allowForbidden` donde 403 es "sin permiso" esperado (roles, access-control kiosk)

---

## 11. Estado Fase 4 (2026-07-14)

Completado:

- [x] Pantalla única **Historial** (reemplaza Reportes + Todos los registros)
- [x] Presets de fecha: Hoy (default) / 7 días / Último mes / Personalizado
- [x] Filtro por tipo + búsqueda; export CSV/PDF/Excel con mismos filtros
- [x] `filterHistorialEntries` único en `utils/historialFilters.js`
- [x] Sidebar: un ítem Historial si `entries.view` **o** `reports.export` (export visible solo con `reports.export`)
- [x] Formulario **Cargar novedad** se mantiene (alta operativa, no era pantalla de consulta)

---

## 12. Estado Fase 5 (2026-07-14)

Completado:

- [x] `GET /api/entries?startDate&endDate&limit&cursor&type&q` con paginación
- [x] Home poll solo del día actual (no histórico completo)
- [x] Historial consulta el rango elegido + botón **Cargar más**
- [x] Export carga páginas del rango (tope 1000)
- [x] Índice Firestore `entries`: type + timestamp

---

## 13. Auditoría de datos históricos Mongo vs Firestore (2026-07-14)

**Objetivo:** decidir con números reales si hace falta migrar, no migrar ni borrar todavía.

### Firestore (conteo real — `scripts/audit-firestore-counts.js`)

Ejecutado el 2026-07-14 contra proyecto `legajosonline-959f6`:

| Colección Firestore | Cantidad | Más antiguo | Más reciente |
|---------------------|----------|-------------|--------------|
| users | 8 | 2025-12-09 | 2026-07-08 |
| entries | 276 | 2025-12-05 | 2026-07-14 |
| personalMaster | 1354 | 2026-07-03 | 2026-07-06 |
| people | 1333 | 2026-07-03 | 2026-07-06 |
| authorizations | 1994 | 2026-07-03 | 2026-07-13 |
| vehiclesMaster | 0 | — | — |
| mobiles / drivers | 0 | — | — |
| citaciones (colección legacy) | 0 | — | — |
| roles | 4 | 2026-07-08 | 2026-07-08 |
| accessEvents | 15 | 2026-07-06 | 2026-07-06 |
| citacionesImports | 51 | — | — |
| nominaImports | 3 | — | — |

### Mongo legacy (intento de conteo)

Desde esta estación de trabajo **no se pudo conectar** a Mongo en planta:

- `192.168.0.9:27017` → no alcanzable (TCP fail)
- `127.0.0.1:27017` → no hay instancia local
- `legacy/backend-libro-guardia/.env` → **no existe** (solo `.env.example` con `mongodb://localhost:27017/libro_guardia_db`)

**Script listo para correr en el servidor de planta** (solo lectura):

```powershell
cd C:\LG\legacy\backend-libro-guardia   # o la ruta real del .env con MONGODB_URI
# asegurar MONGODB_URI en .env
node C:\LG\scripts\audit-mongo-legacy.js
```

Colecciones esperadas según el schema legacy (`users`, `entries`, `personalmasters`, `mobiles`, `drivers`).

### Tabla de decisión (rellenar cantidades Mongo al ejecutar el script)

| Colección Mongo (legacy) | Equivalente Firestore | Cant. Mongo | ¿Ya está en Firestore? | Recomendación |
|--------------------------|----------------------|-------------|------------------------|---------------|
| users | users | *pendiente script* | Parcialmente (8 users en FS desde dic-2025) | Comparar listas de username; migrar faltantes si los hay |
| entries | entries | *pendiente script* | Parcialmente (276 en FS; hay desde dic-2025) | Si Mongo tiene mucho más volumen histórico → **migrar** rango faltante; si similar → **descartar** Mongo |
| personalmasters | personalMaster / people | *pendiente script* | Sí parece poblado (1354 / 1333, jul-2026) | Si conteo Mongo ≈ FS → **descartar**; si Mongo >> FS → revisar huecos y **migrar** |
| mobiles | mobiles / vehiclesMaster | *pendiente script* | FS en 0 | Si Mongo tiene flota → **migrar**; si vacío → **descartar** |
| drivers | drivers | *pendiente script* | FS en 0 | Igual que mobiles |

> Hasta no tener el JSON del script en planta, **no migrar ni apagar Mongo**. El apagado del proceso `bacarguard-api` puede hacerse cuando el checklist de hardware en `docs/INSTALACION-SR201.md` esté OK; el dump de datos es decisión aparte.

### Citaciones folder bridge — en uso, mantener

Confirmado en operación (2026-07-14): **sí se usa** en planta.  
Documentación completa: [CITACIONES-FOLDER-BRIDGE.md](./CITACIONES-FOLDER-BRIDGE.md).

No forma parte de lo que se retira al apagar Node+Mongo. Debe seguir en PM2 junto al bridge SR201.

---

## 14. Servicios locales que deben seguir en el servidor de planta

| Servicio | Script | Estado |
|----------|--------|--------|
| Puente SR201 | `scripts/sr201-bridge.js` | **Mantener** — [INSTALACION-SR201.md](./INSTALACION-SR201.md) |
| Puente citaciones Excel | `scripts/citaciones-folder-bridge.js` | **Mantener (en uso)** — [CITACIONES-FOLDER-BRIDGE.md](./CITACIONES-FOLDER-BRIDGE.md) |
| API Node+Mongo `bacarguard-api` | `legacy/backend-libro-guardia` | **Retirar** cuando checklist hardware OK |
