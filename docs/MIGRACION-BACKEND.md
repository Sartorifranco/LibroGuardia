# Migración backend: Node+Mongo → Firebase Functions + Firestore

**Conclusión corta:** el hardware (molinete/SR201) **ya no depende** del API Node+Mongo. Depende de **Cloud Functions + un puente local TCP**. El backend `backend-libro-guardia` es legado CRUD y ya está cubierto (y superado) por `functions/`.

> **Nota de organización:** este documento tiene dos partes. La **Parte 1** es lo único
> que un instalador necesita hoy (qué apagar en planta, qué mantener). La **Parte 2** es
> el historial cerrado de la migración (fases de desarrollo, ya completadas) — se
> conserva como referencia pero no hace falta leerlo para instalar o dar soporte.

---

## Parte 1 — Lo operativo (vigente)

### Servicios locales en el servidor de planta

| Servicio | Script | Estado |
|----------|--------|--------|
| Puente SR201 | `scripts/sr201-bridge.js` | **Mantener** — [INSTALACION-SR201.md](./INSTALACION-SR201.md) |
| Puente citaciones Excel | `scripts/citaciones-folder-bridge.js` | **Mantener (en uso)** — [CITACIONES-FOLDER-BRIDGE.md](./CITACIONES-FOLDER-BRIDGE.md) |
| API Node+Mongo `bacarguard-api` | `legacy/backend-libro-guardia` | **Descartado** — apagar con los comandos de la sección "Apagado en planta" más abajo (pendiente ejecución física si aún no se hizo) |

### Apagado en planta (ejecutar en el servidor cuando el operador lo decida)

No requiere acceso remoto desde desarrollo: correr **en la PC de planta** (ej. `192.168.0.9`):

```powershell
# 1) Ver qué está corriendo
pm2 status

# 2) Detener y sacar del arranque automático el API Node+Mongo
pm2 stop bacarguard-api
pm2 delete bacarguard-api
pm2 save

# 3) Verificar que NO quede el proceso
pm2 status
# Esperado: no aparece bacarguard-api
# Sí pueden seguir: bacarguard-sr201-bridge y bacarguard-citaciones-bridge (o bacarguard-citaciones)
```

Si el nombre del proceso fuera distinto:

```powershell
pm2 list
# Identificar el que apunta a backend-libro-guardia / server.js / puerto 5020
pm2 stop <nombre>
pm2 delete <nombre>
pm2 save
```

Comprobar que nada escuche el puerto viejo del API:

```powershell
netstat -ano | findstr ":5020"
# Si hay PID, revisar con: tasklist /FI "PID eq <pid>"
# No matar los bridges (:5022 SR201, :5023 status citaciones)
```

**MongoDB del servidor:** no es obligatorio desinstalarlo si otras apps lo usan. Alcanza con que `bacarguard-api` no arranque ni reciba tráfico de Libro de Guardia.

Tarea programada / servicio Windows (si existiera algo aparte de PM2):

```powershell
Get-ScheduledTask | Where-Object { $_.TaskName -match 'bacar|libro|guardia|mongo' }
Get-Service | Where-Object { $_.Name -match 'bacar|mongo' }
# Deshabilitar solo lo que corresponda al API viejo, no al bridge SR201/citaciones
```

### Cómo elige el frontend qué backend usar

No hay feature flag: solo `REACT_APP_API_BASE_URL`.

| Entorno | Archivo | Valor | Destino |
|---------|---------|-------|---------|
| Dev | `.env.development` | `https://mss-guard.web.app/api` (o emulador) | **Firebase Functions** |
| Prod | `.env.production` | `/api` | Firebase Hosting rewrite → Function `api` |

El frontend **ya no apunta** a `localhost:5020` ni al API Node.

---

## Parte 2 — Historial cerrado de la migración (Fase 0, 2026-07-14)

*A partir de acá: bitácora de cómo se hizo la migración. Cerrado, no operativo. Se
conserva para contexto histórico, no hace falta seguirlo para instalar o dar soporte.*

**Alcance original:** investigación no destructiva (sin borrar ni desactivar nada).

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
| Botón "Abrir puerta" guardia | `POST /api/guard/open-door` |

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
- **API Node+Mongo (`bacarguard-api` / `backend-libro-guardia`)** = backend de datos. **Ya no es necesario** para Libro de Guardia ni para el molinete (confirmado también por `FIREBASE-SETUP.md`: "Apagar el servidor viejo").

### Nota operativa importante (alcance nube → puente)

En la doc de ejemplo aparece `URL puente = http://192.168.0.9:5022`.  
Una IP **privada** **no es alcanzable** desde Cloud Functions salvo que exista:

- túnel (Cloudflare Tunnel / ngrok / similar), o
- IP/DNS público que apunte al bridge, o
- VPN hacia la planta.

Antes de dar de baja definitivamente el API viejo en planta, verificar en Admin → Control SR201 que `bridgeUrl` sea **reachable desde internet** (o túnel) y que "Probar relevador" funcione desde producción.

---

## 4. Cómo elige el frontend qué backend usar

No hay feature flag: solo `REACT_APP_API_BASE_URL`.

| Entorno | Archivo | Valor | Destino |
|---------|---------|-------|---------|
| Dev | `.env.development` | `https://mss-guard.web.app/api` (o emulador) | **Firebase Functions** |
| Prod | `.env.production` | `/api` | Firebase Hosting rewrite → Function `api` |

El frontend **ya no apunta** a `localhost:5020` ni al API Node.

---

## 5. Qué hace Node+Mongo que Functions todavía no cubre

**Para datos y acceso: nada crítico.**  
Todo lo del `server.js` legacy tiene equivalente (mejorado) en `functions/app.js`.

**Lo "único" local que Functions no reemplaza** no es Mongo, sino:

1. Hablar TCP al SR201 en LAN → `scripts/sr201-bridge.js`
2. Watch de carpeta de planillas en una PC de transporte → `scripts/citaciones-folder-bridge.js`

Pendientes de producto (no bloquean migrar Mongo):

- Método de auth `face` (pendiente según `docs/MULTI-PUERTAS.md`)
- Timers de estanco en memoria de la Function (frágiles si la instancia se enfría; mejorar después)

---

## 6. Plan concreto: qué mover / qué eliminar

### Ya está en `functions/` (no hace falta "mover" lógica)

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
| Proceso PM2 `bacarguard-api` en `192.168.0.9` | **Descartado** — apagar en planta (Parte 1); datos Mongo sin migración |
| `backend-libro-guardia/` como dependencia de runtime | Dejar de usarlo; archivar o marcar `LEGACY` en README |
| `.env.development` → `localhost:5020` | Cambiar a Functions/emulador |
| Referencias a Mongo en docs/scripts viejas | Actualizar |

### Checklist antes de apagar Node+Mongo en planta

1. Login y libro diario en https://mss-guard.web.app  
2. Admin → Probar relevador → click físico en molinete/puerta  
3. Kiosk: DNI autorizado abre; denegado no abre  
4. Botón "Abrir puerta" registra evento  
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
- [x] Frontend apunta solo a Firebase (`.env.development` → `https://mss-guard.web.app/api`, prod → `/api`).
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

## 13. Auditoría Mongo vs Firestore — **cerrada**

### Decisión (confirmado en planta)

> **Confirmado en planta — sin datos relevantes en MongoDB. No se migra nada. Colección descartada.**

No hay datos reales/importantes que preservar. Firestore es la única fuente de verdad operativa.

### Firestore (referencia, conteo al cierre de la migración)

| Colección Firestore | Cantidad (aprox.) |
|---------------------|-------------------|
| users | 8 |
| entries | 276 |
| personalMaster / people | 1354 / 1333 |
| authorizations | 1994 |
| roles | 4 |

Detalle histórico del conteo: ver commit de auditoría / `scripts/audit-firestore-counts.js`.

### Tabla de decisión Mongo (cerrada)

| Colección Mongo (legacy) | Equivalente Firestore | ¿Ya está en Firestore? | Recomendación |
|--------------------------|----------------------|------------------------|---------------|
| users | users | Operativo en FS | **Descartar** — no migrar |
| entries | entries | Operativo en FS | **Descartar** — no migrar |
| personalmasters | personalMaster / people | Operativo en FS | **Descartar** — no migrar |
| mobiles | mobiles / vehiclesMaster | N/A | **Descartar** — no migrar |
| drivers | drivers | N/A | **Descartar** — no migrar |
| *(cualquier otra)* | — | — | **Confirmado en planta — sin datos relevantes. No se migra nada.** |

### Scripts de arranque del repo

Ningún script activo de producción inicia `legacy/backend-libro-guardia`:

| Script | ¿Levanta Node+Mongo? |
|--------|----------------------|
| `scripts/setup-servidor.ps1` | **No** — solo bridges; incluye sección para apagar `bacarguard-api` |
| `scripts/deploy-sr201-bridge.ps1` | **No** |
| `scripts/deploy-firebase.ps1` | **No** (Firebase) |
| `scripts/deploy-backend.ps1` | **Obsoleto** — sale con error y mensaje de no usar |
| `scripts/citaciones-folder-bridge.js` / install | **No** — solo citaciones |

El código queda en `legacy/backend-libro-guardia/` solo como archivo histórico.

*(Comandos de apagado del proceso en planta: ver Parte 1, arriba.)*

---

## 15. Checklist general de aceptación (cierre migración)

| Criterio | Estado |
|----------|--------|
| Sin `window.confirm` / `window.alert` | Resuelto |
| Historial unificado + paginado | Resuelto |
| Roles por categorías + plantillas | Resuelto |
| Rate limit login por usuario (no por IP compartida) | Resuelto |
| App.js shell sin lógica de dominio | Resuelto |
| Citaciones-folder-bridge documentado y en uso | Resuelto |
| Vencimientos ART/seguro/licencia/VTV + filtro por permiso en API | Resuelto |
| **Sin Node+Mongo en prod (código/flujo)** | **Resuelto** — datos Mongo descartados; API no forma parte del runtime Firebase |
| Apagar proceso `bacarguard-api` en el servidor físico | **Pendiente en planta** — comandos listos en la Parte 1 (el usuario lo ejecuta cuando confirme) |
| Probar pulso SR201 / túnel en sitio | Pendiente hardware — [INSTALACION-SR201.md](./INSTALACION-SR201.md) |
