# Fase 0 â€” MigraciÃ³n backend: Node+Mongo â†’ Firebase Functions + Firestore

**Fecha:** 2026-07-14  
**Alcance:** investigaciÃ³n no destructiva (sin borrar ni desactivar nada).  
**ConclusiÃ³n corta:** el hardware (molinete/SR201) **ya no depende** del API Node+Mongo. Depende de **Cloud Functions + un puente local TCP**. El backend `backend-libro-guardia` es legado CRUD y ya estÃ¡ cubierto (y superado) por `functions/`.

---

## 1. QuÃ© hace hoy el backend Node (`backend-libro-guardia`)

Archivo principal: `backend-libro-guardia/server.js` (Express + MongoDB, puerto 5020).

### Rutas (todas son API CRUD / auth)

| Ãrea | Rutas |
|------|--------|
| Health | `GET /api/health` |
| Auth | `POST /api/auth/register`, `login`, `GET /api/auth/me` |
| Users | CRUD `/api/admin/users` |
| Flota listas | upload/GET mÃ³viles y choferes |
| Personal | GET/POST `/api/master-data/personal` |
| Libro | GET/POST `/api/entries` |

### Hardware

**Ninguna ruta habla con SR201, relÃ©s, puertas ni IPs de placa.**  
Dependencias: solo `express`, `mongoose`, `bcryptjs`, `jsonwebtoken`, `cors`, `dotenv`.

### Modelos Mongo

`users`, `mobiles`, `drivers`, `personalmasters`, `entries`.

---

## 2. QuÃ© hace Firebase Functions respecto al control fÃ­sico

ImplementaciÃ³n **completa** de negocio + apertura en la nube:

| Capacidad | DÃ³nde |
|-----------|--------|
| Validar acceso (DNI / autorizaciones / nÃ³mina) | `functions/accessControl.js` |
| Abrir puerta/molinete (auto + manual) | `functions/doorController.js` â†’ `functions/sr201.js` |
| Multi-puerta + estancos | `functions/lib/doorsConfig.js`, `docs/MULTI-PUERTAS.md` |
| Config admin + test relay | `GET/PUT /api/admin/access-control`, `doors-config`, `POST /api/access/test-relay` |
| Kiosk / molinete | `POST /api/access/kiosk-scan`, `POST /api/access/validar` |
| BotÃ³n â€œAbrir puertaâ€ guardia | `POST /api/guard/open-door` |

Endpoints relevantes (ya en prod vÃ­a Hosting â†’ Function `api`):

- `GET/PUT /api/admin/access-control`
- `GET/PUT /api/admin/doors-config`
- `POST /api/access/test-relay`
- `GET /api/guard/doors`, `POST /api/guard/open-door`
- `GET/POST /api/guard/airlock/:groupId`
- `POST /api/access/validar`, `/kiosk-scan`, `/evaluate`
- `POST /api/guard/exceptional-entry`

AdemÃ¡s, Functions cubre **todo** lo del Node legacy (auth, users, entries, flota) **y** mucho mÃ¡s: citaciones, nÃ³mina, GPS UBIKA, roles/permisos, vehÃ­culos, asistencia, etc.

---

## 3. Puentes locales: quÃ© debe quedar en planta (â‰  backend Mongo)

La app en Firebase **no puede** abrir un socket TCP al SR201 en la LAN del cliente. Eso es normal y esperado.

### Debe mantenerse (procesos locales, no el API Mongo)

| Proceso | Archivo | Rol |
|---------|---------|-----|
| **Puente SR201** | `scripts/sr201-bridge.js` | HTTP (`/pulse`) â†’ TCP `6722` al SR201. Obligatorio para molinete/puertas en producciÃ³n. |
| **Puente citaciones** | `scripts/citaciones-folder-bridge.js` | Vigila carpeta Excel/CSV y llama a `/api/bridge/citaciones/sync`. Opcional segÃºn operaciÃ³n de transporte. |

Flujo real:

```
Guardia / kiosk (web.app)
  â†’ Cloud Function (accessControl / doorController / sr201)
    â†’ si bridgeUrl: POST {bridgeUrl}/pulse
      â†’ sr201-bridge.js (PC planta, p.ej. 192.168.0.9:5022)
        â†’ TCP SR201 (ej. 192.168.0.50:6722)
          â†’ relÃ© â†’ molinete / puerta
```

Documentado en `docs/INSTALACION-SR201.md` y `FIREBASE-SETUP.md`.

### No confundir

- **Puente local SR201/citaciones** = proceso chico en la red del cliente. **Se mantiene.**
- **API Node+Mongo (`bacarguard-api` / `backend-libro-guardia`)** = backend de datos. **Ya no es necesario** para Libro de Guardia ni para el molinete (confirmado tambiÃ©n por `FIREBASE-SETUP.md`: â€œApagar el servidor viejoâ€).

### Nota operativa importante (alcance nube â†’ puente)

En la doc de ejemplo aparece `URL puente = http://192.168.0.9:5022`.  
Una IP **privada** **no es alcanzable** desde Cloud Functions salvo que exista:

- tÃºnel (Cloudflare Tunnel / ngrok / similar), o
- IP/DNS pÃºblico que apunte al bridge, o
- VPN hacia la planta.

Antes de dar de baja definitivamente el API viejo en planta, verificar en Admin â†’ Control SR201 que `bridgeUrl` sea **reachable desde internet** (o tÃºnel) y que â€œProbar relevadorâ€ funcione desde producciÃ³n.

---

## 4. CÃ³mo elige el frontend quÃ© backend usar

No hay feature flag: solo `REACT_APP_API_BASE_URL`.

| Entorno | Archivo | Valor | Destino |
|---------|---------|-------|---------|
| Dev | `.env.development` | `https://mss-guard.web.app/api` (o emulador) | **Firebase Functions** |
| Prod | `.env.production` | `/api` | Firebase Hosting rewrite â†’ Function `api` |

El frontend **ya no apunta** a `localhost:5020` ni al API Node.

---

## 5. QuÃ© hace Node+Mongo que Functions todavÃ­a no cubre

**Para datos y acceso: nada crÃ­tico.**  
Todo lo del `server.js` legacy tiene equivalente (mejorado) en `functions/app.js`.

**Lo â€œÃºnicoâ€ local que Functions no reemplaza** no es Mongo, sino:

1. Hablar TCP al SR201 en LAN â†’ `scripts/sr201-bridge.js`
2. Watch de carpeta de planillas en una PC de transporte â†’ `scripts/citaciones-folder-bridge.js`

Pendientes de producto (no bloquean migrar Mongo):

- MÃ©todo de auth `face` (pendiente segÃºn `docs/MULTI-PUERTAS.md`)
- Timers de estanco en memoria de la Function (frÃ¡giles si la instancia se enfrÃ­a; mejorar despuÃ©s)

---

## 6. Plan concreto: quÃ© mover / quÃ© eliminar

### Ya estÃ¡ en `functions/` (no hace falta â€œmoverâ€ lÃ³gica)

- Auth, users, roles, permissions  
- Entries / libro  
- Personal, vehÃ­culos, flota, citaciones, nÃ³mina  
- Access control, multi-puertas, SR201 client  
- GPS flota, asistencia, kiosk  

### Mantener (fuera de Firebase, en planta)

- `scripts/sr201-bridge.js` (+ PM2/servicio Windows)  
- `scripts/citaciones-folder-bridge.js` (si usan sync de carpeta)  
- DocumentaciÃ³n de instalaciÃ³n de ambos  

### Eliminar / retirar (despuÃ©s de checklist verde)

| Ãtem | AcciÃ³n |
|------|--------|
| Proceso PM2 `bacarguard-api` en `192.168.0.9` | **Descartado** â€” apagar en planta (Â§13); datos Mongo sin migraciÃ³n |
| `backend-libro-guardia/` como dependencia de runtime | Dejar de usarlo; archivar o marcar `LEGACY` en README |
| `.env.development` â†’ `localhost:5020` | Cambiar a Functions/emulador |
| Referencias a Mongo en docs/scripts viejas | Actualizar |

### Checklist antes de apagar Node+Mongo en planta

1. Login y libro diario en https://mss-guard.web.app  
2. Admin â†’ Probar relevador â†’ click fÃ­sico en molinete/puerta  
3. Kiosk: DNI autorizado abre; denegado no abre  
4. BotÃ³n â€œAbrir puertaâ€ registra evento  
5. `bridgeUrl` alcanzable desde la nube (no solo IP LAN sin tÃºnel)  
6. Citaciones: sync por upload o por folder-bridge â†’ Firestore  
7. GPS / roles / dashboards OK (ya solo viven en Functions)

### Orden sugerido (fases siguientes, sin romper)

1. ~~**Fase 1 â€” Frontend apunta solo a Functions**~~ â†’ hecha (secciÃ³n 8).  
2. **Fase 2 â€” Modularizar `App.js` por dominio** (sin cambiar contratos API).  
3. **Fase 3 â€” UX/intuitividad / a prueba de errores** (hallazgos acordados).  
4. Commits **separados por tema**, nunca un commit gigante.

---

## 8. Estado Fase 1 (2026-07-14)

Completado:

- [x] Confirmado: ninguna ruta de `server.js` Node faltaba en `functions/app.js` (Functions es un superconjunto).
- [x] Frontend apunta solo a Firebase (`.env.development` â†’ `https://mss-guard.web.app/api`, prod â†’ `/api`).
- [x] `backend-libro-guardia/` movido a `legacy/backend-libro-guardia/` (marcado LEGACY, no desplegar).
- [x] Puente SR201 documentado como servicio mÃ­nimo (`scripts/sr201-bridge.js` + `deploy-sr201-bridge.ps1`).
- [x] README y scripts de deploy actualizados (Firebase = app; bridge = hardware).

Siguiente: **Fase 2 â€” modularizar `App.js` por dominio**.

---

## 9. Estado Fase 2 (2026-07-14)

Completado (refactor puro, sin cambio de UX intencional):

- [x] `services/api.js` â€” cliente HTTP centralizado (`apiFetch`)
- [x] Contextos: Auth, Toast, Entries, ClockPrefill
- [x] Pages: Login, Home, Personal, VehiculosExternos, FlotaInterna, Novedad, Historial, Admin
- [x] `App.js` como shell (~360 lÃ­neas): layout, routing por `activeTab`, providers

Siguiente: **Fase 3 â€” UX / sesiÃ³n / manejo de errores** (conectar `api.js` con sesiÃ³n expirada).

---

## 10. Estado Fase 3 (2026-07-14)

Completado:

- [x] `apiFetch` centralizado: Bearer automÃ¡tico, 401/403 â†’ logout + "Tu sesiÃ³n expirÃ³â€¦", red tipada, message del backend, genÃ©rico honesto
- [x] Cero `fetch` sueltos en frontend (salvo el interior de `services/api.js`)
- [x] Toasts: error manual / Ã©xito 5s (sin cambio de polÃ­tica)
- [x] `allowForbidden` donde 403 es "sin permiso" esperado (roles, access-control kiosk)

---

## 11. Estado Fase 4 (2026-07-14)

Completado:

- [x] Pantalla Ãºnica **Historial** (reemplaza Reportes + Todos los registros)
- [x] Presets de fecha: Hoy (default) / 7 dÃ­as / Ãšltimo mes / Personalizado
- [x] Filtro por tipo + bÃºsqueda; export CSV/PDF/Excel con mismos filtros
- [x] `filterHistorialEntries` Ãºnico en `utils/historialFilters.js`
- [x] Sidebar: un Ã­tem Historial si `entries.view` **o** `reports.export` (export visible solo con `reports.export`)
- [x] Formulario **Cargar novedad** se mantiene (alta operativa, no era pantalla de consulta)

---

## 12. Estado Fase 5 (2026-07-14)

Completado:

- [x] `GET /api/entries?startDate&endDate&limit&cursor&type&q` con paginaciÃ³n
- [x] Home poll solo del dÃ­a actual (no histÃ³rico completo)
- [x] Historial consulta el rango elegido + botÃ³n **Cargar mÃ¡s**
- [x] Export carga pÃ¡ginas del rango (tope 1000)
- [x] Ãndice Firestore `entries`: type + timestamp

---

## 13. AuditorÃ­a Mongo vs Firestore â€” **cerrada (Fase 15)**

### DecisiÃ³n (2026-07-14, confirmado en planta)

> **Confirmado en planta â€” sin datos relevantes en MongoDB. No se migra nada. ColecciÃ³n descartada.**

No hay datos reales/importantes que preservar. Firestore es la Ãºnica fuente de verdad operativa.

### Firestore (referencia, conteo 2026-07-14)

| ColecciÃ³n Firestore | Cantidad (aprox.) |
|---------------------|-------------------|
| users | 8 |
| entries | 276 |
| personalMaster / people | 1354 / 1333 |
| authorizations | 1994 |
| roles | 4 |

Detalle histÃ³rico del conteo: ver commit de auditorÃ­a / `scripts/audit-firestore-counts.js`.

### Tabla de decisiÃ³n Mongo (cerrada)

| ColecciÃ³n Mongo (legacy) | Equivalente Firestore | Cant. Mongo | Â¿Ya estÃ¡ en Firestore? | RecomendaciÃ³n |
|--------------------------|----------------------|-------------|------------------------|---------------|
| users | users | N/D (sin datos relevantes) | Operativo en FS | **Descartar** â€” no migrar |
| entries | entries | N/D (sin datos relevantes) | Operativo en FS | **Descartar** â€” no migrar |
| personalmasters | personalMaster / people | N/D (sin datos relevantes) | Operativo en FS | **Descartar** â€” no migrar |
| mobiles | mobiles / vehiclesMaster | N/D (sin datos relevantes) | N/A | **Descartar** â€” no migrar |
| drivers | drivers | N/D (sin datos relevantes) | N/A | **Descartar** â€” no migrar |
| *(cualquier otra)* | â€” | â€” | â€” | **Confirmado en planta â€” sin datos relevantes en MongoDB. No se migra nada. ColecciÃ³n descartada.** |

### Scripts de arranque del repo

NingÃºn script activo de producciÃ³n inicia `legacy/backend-libro-guardia`:

| Script | Â¿Levanta Node+Mongo? |
|--------|----------------------|
| `scripts/setup-servidor.ps1` | **No** â€” solo bridges; incluye secciÃ³n para apagar `bacarguard-api` |
| `scripts/deploy-sr201-bridge.ps1` | **No** |
| `scripts/deploy-firebase.ps1` | **No** (Firebase) |
| `scripts/deploy-backend.ps1` | **Obsoleto** â€” sale con error y mensaje de no usar |
| `scripts/citaciones-folder-bridge.js` / install | **No** â€” solo citaciones |

El cÃ³digo queda en `legacy/backend-libro-guardia/` solo como archivo histÃ³rico.

### Apagado en planta (ejecutar en el servidor cuando el operador lo decida)

No requiere acceso remoto desde desarrollo: correr **en la PC de planta** (ej. `192.168.0.9`):

```powershell
# 1) Ver quÃ© estÃ¡ corriendo
pm2 status

# 2) Detener y sacar del arranque automÃ¡tico el API Node+Mongo
pm2 stop bacarguard-api
pm2 delete bacarguard-api
pm2 save

# 3) Verificar que NO quede el proceso
pm2 status
# Esperado: no aparece bacarguard-api
# SÃ­ pueden seguir: bacarguard-sr201-bridge y bacarguard-citaciones-bridge (o bacarguard-citaciones)
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

**MongoDB del servidor:** no es obligatorio desinstalarlo si otras apps lo usan. Alcanza con que `bacarguard-api` no arranque ni reciba trÃ¡fico de Libro de Guardia.

Tarea programada / servicio Windows (si existiera algo aparte de PM2):

```powershell
Get-ScheduledTask | Where-Object { $_.TaskName -match 'bacar|libro|guardia|mongo' }
Get-Service | Where-Object { $_.Name -match 'bacar|mongo' }
# Deshabilitar solo lo que corresponda al API viejo, no al bridge SR201/citaciones
```

### Citaciones folder bridge â€” en uso, mantener

Confirmado en operaciÃ³n: **sÃ­ se usa** en planta.  
Docs: [CITACIONES-FOLDER-BRIDGE.md](./CITACIONES-FOLDER-BRIDGE.md).

No se retira con Node+Mongo. Debe seguir en PM2 junto al bridge SR201.

---

## 14. Servicios locales en el servidor de planta

| Servicio | Script | Estado |
|----------|--------|--------|
| Puente SR201 | `scripts/sr201-bridge.js` | **Mantener** â€” [INSTALACION-SR201.md](./INSTALACION-SR201.md) |
| Puente citaciones Excel | `scripts/citaciones-folder-bridge.js` | **Mantener (en uso)** â€” [CITACIONES-FOLDER-BRIDGE.md](./CITACIONES-FOLDER-BRIDGE.md) |
| API Node+Mongo `bacarguard-api` | `legacy/backend-libro-guardia` | **Descartado** â€” apagar con comandos de Â§13 (pendiente ejecuciÃ³n fÃ­sica en planta) |

---

## 15. Checklist general de aceptaciÃ³n (cierre migraciÃ³n)

| Criterio | Estado |
|----------|--------|
| Sin `window.confirm` / `window.alert` | Resuelto |
| Historial unificado + paginado | Resuelto |
| Roles por categorÃ­as + plantillas | Resuelto |
| Rate limit login por usuario (no por IP compartida) | Resuelto |
| App.js shell sin lÃ³gica de dominio | Resuelto |
| Citaciones-folder-bridge documentado y en uso | Resuelto |
| Vencimientos ART/seguro/licencia/VTV + filtro por permiso en API | Resuelto |
| **Sin Node+Mongo en prod (cÃ³digo/flujo)** | **Resuelto** â€” datos Mongo descartados; API no forma parte del runtime Firebase |
| Apagar proceso `bacarguard-api` en el servidor fÃ­sico | **Pendiente en planta** â€” comandos listos en Â§13 (el usuario lo ejecuta cuando confirme) |
| Probar pulso SR201 / tÃºnel en sitio | Pendiente hardware â€” [INSTALACION-SR201.md](./INSTALACION-SR201.md) |
