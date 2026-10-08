# Almacenamiento edge (SQLite) — T3 de ETAPA2-DISENO

Base local del hub y de cada controlador. Sin dependencias de Firebase; todo sincrónico.

| Archivo | Qué hace |
|---|---|
| `driver.js` | `open(path, {readonly, driver, integrityCheck, synchronous, busyTimeoutMs})`. Usa `node:sqlite` si existe (Node 24 portable) y si no `better-sqlite3` (Node 20 del banco). Forzar con `MSS_SQLITE_DRIVER`. WAL + `synchronous=NORMAL` + `busy_timeout=5000`, `PRAGMA integrity_check` al abrir → `DbIntegrityError` (`code:'DB_INTEGRITY'`, `recoverable:true`). `openOrRecover()` aparta el archivo dañado (`.corrupt-<ts>`) y crea uno vacío. `db.transaction(fn)` / `db.tx(fn)` con savepoints anidados. |
| `migrations.js` | `migrate(db, {role})`, versión en `meta.schema_version`. Tablas comunes + solo-hub (`presence`, `alarms`, `operators`, `commands`). Idempotente; controller → hub agrega lo que falta. |
| `chunkStore.js` | Guarda y verifica chunks (sha256 del JSON canónico) y los materializa. `applyHead(head, cuerpos)` todo-o-nada; `configVersion` monotónico (`{applied:false, reason:'stale'}`). |
| `journal.js` | Eventos append-only con `seq` persistido, ingesta idempotente en el hub (`hub_seq`), `pendingBatch`, `ack`, `purge` (90 días, solo confirmados). |
| `sqliteSnapshot.js` | Implementa la interfaz `snap` del motor (`findCredential`, `cardholder`, `rightsFor`, `schedule`, `isHoliday`, `door`, `interlockGroup`, `pass`, `isRevoked`, `policy`) + `site()`, `version()`, `refresh()`. |
| `index.js` | `openEdgeDb(file, {role, deviceId, myDoorIds})` → `{db, chunks, journal, snapshot, recovered}`. |

## Uso

```js
const { openEdgeDb } = require('./edge/lib/db');
const edge = openEdgeDb('C:/mss-edge/data/edge.db', { role: 'controller', deviceId: 'ctl-a' });
if (edge.recovered) { /* base corrupta apartada: pedir bundle completo al hub */ }
const faltan = edge.chunks.needsChunks(head);           // bajar solo estos
const r = edge.chunks.applyHead(head, cuerposBajados);  // {applied, changed, removed} | {applied:false, reason}
edge.snapshot.refresh();                                 // después de aplicar config
const ev = edge.journal.append({ doorId, side, type: 'access', decision, reason, credType, credHash, cardholderId });
```

## Forma esperada de los chunks (la produce T2)

- `doors`: `{ site, policy, doors:[{id, controllerId, ...}], schedules:[{id,...}], holidays:[{date, setId}] | {setId:[fechas]}, interlockGroups:[{id, doorIds, mode}], accessGroups:[{id, doors:'*' | [doorId | {doorId, scheduleId}], scheduleId}] }`
- `ch-NN`: `{ cardholders:[{id, status, name, validFrom, validTo, accessAll, accessLevels:[groupId | {groupId, scheduleId, validFrom, validTo}], doors:[{doorId, scheduleId}], allowedDoorIds, shiftScheduleId, requiresGrant, credentials:[{type, valueHash, status, validFrom, validTo}]}], credentials?:[{..., cardholderId}] }`. Se reemplaza el bucket entero.
- `grants-YYYYMMDD`: `{ grants:[{id, cardholderId, doors:[...] | '*', from, to, source, refId, scheduleId?}] }`.
- `passes`: `{ passes:[{id (qrId), dni, doors, validFrom, validTo, ...}], revoked:[ids] }` (la tabla `revocations` sale de acá).
- `operators` (solo hub): `{ operators:[{username, hash, passwordVersion, perms, posts}] }`.

Fechas: ms epoch, ISO o `{_seconds}` → se guardan en ms. `rights` se materializa solo para las puertas del equipo (`myDoorIds`; si no se pasa, las de `doors[].controllerId === deviceId`; hub = todas). `accessAll` (D7) queda como flag de la persona, sin filas: el motor lo lee de `cardholder(id).accessAll`. Un grupo con `doors:'*'` sí genera filas, acotadas a las puertas del equipo. Horario por defecto `24x7` (builtin si no viene en el chunk).

## Diferencias con el esquema de §3 (a propósito)

- `credentials` PK `(type, value_hash, cardholder_id)`: un DNI repetido entre dos personas no se pisa; `findCredential` devuelve `status:'duplicate'` + `cardholderIds` (→ `dni_duplicado`).
- `events` `UNIQUE(device_id, seq)` (no `seq UNIQUE`): el hub guarda eventos de varios controladores con seq propios. `hub_seq` único.
- `holidays` PK `(date, set_id)`; columna `chunk` en `cardholders/credentials/rights/passes`; `passes.dni`; tabla `access_groups`; `chunks.applied_hash`.

## Pruebas

```
cd scripts
node --test edge/lib/db/
```

Si no hay driver (Node 20 sin `better-sqlite3`) los tests se omiten con un aviso. `better-sqlite3` queda fijado en `^12` porque la 13 exige Node 22+.
