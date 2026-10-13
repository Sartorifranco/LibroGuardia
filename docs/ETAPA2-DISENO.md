# Etapa 2 — Controlador local y modelo profesional (diseño técnico)

Estado: propuesta aprobable · base `integracion/revision-2026-10` · modelo de referencia Brivo / Avigilon Alta (nube = maestra de configuración; el equipo en planta decide offline), semántica de alarmas, áreas e interlock de Gallagher / Genetec.

Restricciones del dueño: costo Firebase ≤ US$10/mes por sitio (objetivo: cuota gratis), funcionar 100 % sin internet en la LAN, guardias no técnicos, topología **una Raspberry por par de puertas** (los dos lados de un estanco siempre en el mismo equipo) + **un hub por sitio** (Pi o PC). Decisiones D1–D22 en el documento de relevamiento.

## 0. Qué se reutiliza y qué se reemplaza

| Pieza actual | Qué hacemos |
|---|---|
| `scripts/programa-estacion.js` (v1.7) | Reutilizar framing serie (`createSerialFramer`, `runSerialLoop`), `fireLocalRelay`/`sanitizeLocalRelay`, logs y `fatalHandlers`. Reemplazar allowlist JSON, cola JSON, polls, login por lector y `:8787`. |
| `scripts/lib/stationReaderPlugins.js` | Pasa a ser `ReaderDriver.parse()` sin cambios. |
| `functions/lib/doorDrivers/{sr201,genericHttp}` | Se usan tal cual en el edge como `OutputDriver`. |
| `accessControl.js` `decidirAcceso` + `accessValidation.js` + `doorAccess.js` + `visitasAccess.js` + `accessNominaMessages.js` | Reglas extraídas a un motor puro; las funciones actuales quedan como adaptadores sobre el snapshot compilado. |
| `functions/lib/doorAllowlist.js` | Reemplazado por el compilador por sitio en chunks. |
| `doorController.js` (`deriveAirlockPhase`, `evaluateAirlockPhase`, `evaluateManualAirlockPhase`) | Se mueven al motor y al controlador; Firestore deja de guardar estado de puerta. |
| `settings/doorsConfig` | Se conserva (1 lectura) y se extiende: lados, entradas, salidas, `controllerId`, áreas, `interlockGroups`. |
| `pending_local_opens`, `lectores`, `estaciones`, usuarios `kiosk_puerta`, `guardLocalStations.js` | Reemplazados por `devices` + `commands`. El guardia nunca recibe secretos de equipo (D22). |
| Frontend `services/api.js` (`/api` relativo), `DigitalDoorPanel`, `localStationClient`, `EntriesContext` | La misma build servida por el hub habla con el hub. Se elimina `localStationClient`. |

## 1. Componentes

- **Nube** (Functions `api` + Firestore, southamerica-east1): fuente de verdad de configuración y administración; compila un snapshot por sitio en chunks firmado (Ed25519); recibe lotes de eventos y arma proyecciones (`entries` compat, alarmas, mails D20); encola comandos; publica `live/summary` para la vista remota.
- **Hub de sitio** (`mss-edge --role=hub`, Pi o PC con NSSM): listener sobre `compiled/head` y `commands` (custom token de equipo); reparte el bundle firmado por LAN; junta eventos en SQLite y los sube en lotes; estado de sitio (presencia/APB, alarmas, pases emitidos offline); sirve la app de guardia + API LAN compatible + SSE; NTP de la LAN; corre `programa-biostar.js`.
- **Controlador** (`mss-edge --role=controller`, una Pi por par de puertas o una PC): autoridad de decisión de sus puertas con el motor sobre SQLite; máquina de estados de puerta e interlock local; drivers lector (serie DNI, HTTP QR+DNI, BioStar vía hub), salida (SR201 TCP, GPIO/HAT, relé del lector) y entrada (DPS, bond, REX, emergencia) vía libgpiod; eventos con secuencia propia hasta ack del hub.
- **Cliente guardia**: mismo React; origen del hub en planta, nube desde afuera.
- **Drivers** (`scripts/edge/drivers/*`): `ReaderDriver {start(onCredential), stop, health}`, `OutputDriver {pulse(ms), set(on), health}`, `InputDriver {onChange(name, value)}`. El lector de red QR+DNI con relé implementa Reader + Output.

### Modos de falla

| Falla | Comportamiento |
|---|---|
| Internet caído | Todo sigue en la LAN. Eventos acumulados en el hub (semanas). Aperturas remotas desde la nube fallan con "planta sin conexión". Mails al volver. Banner "Sin internet: config vX de hh:mm". |
| Hub caído | Controladores deciden con el último bundle y guardan eventos (>100k filas). APB duro baja a blando. UI de guardia en modo nube si hay internet; alarma "hub caído" desde la nube. |
| Controlador caído | Sus puertas en su modo físico (fail-safe/secure según cerradura). Hub detecta en 15 s, alarma `device_offline`, puertas grises en la UI. |
| Hub + internet caídos | Controladores autónomos; sin UI de guardia: llave/REX y contingencia en papel (`docs/CONTINGENCIA-BRIDGES.md`). |
| Reloj desfasado | Hub = NTP; Pi con RTC recomendada. `clockTrusted=false` si no sincronizó o deriva > 2 min: solo derechos 24/7, horario denegado con `reloj_no_confiable`. Eventos con `tsLocal`, `seq`, `clockQ`. |
| Split-brain / config | `configVersion` monotónico; el hub nunca edita config; lo offline son eventos append-only; un solo hub por sitio (lease `sites/{id}.hubDeviceId`). |
| Corte de energía / SD | SQLite WAL + `synchronous=NORMAL`; `PRAGMA integrity_check` al arrancar; si falla se pide bundle completo. SSD USB o SD industrial. |
| Config vieja | Sin "allowlist vencida → negar todo". Grants temporales traen su validez. Alarma tras `maxConfigAgeDays` (7). |

## 2. Motor de decisión puro (`functions/lib/accessEngine/`)

CommonJS sin dependencias, Node 20+; lo usan la nube (vista previa, reportes) y el edge (autoritativo).

```
decide({ snap, credential:{type,value}, doorId, side:'in'|'out', at:ms,
         state:{ interlock, presence, doorStates, clockTrusted }, mode:'scan'|'manual'|'remote', actor? })
→ { decision:'grant'|'deny'|'needs_approval', reason, cardholderId, matched:{source,id,scheduleId},
    actions:[{type:'unlock',doorId,ms}], stateEffects:{interlock?, presence?}, message }
```

`snap` = interfaz de búsqueda (`findCredential`, `cardholder`, `rightsFor`, `schedule`, `isHoliday`, `door`, `interlockGroup`, `pass`, `isRevoked`, `policy`) con implementación SQLite (edge) y en memoria (nube). Nunca lee el reloj del sistema; usa `Intl` con `site.tz`.

Orden (el primer fallo corta): credencial (`credencial_desconocida`, `credencial_revocada`, `dni_duplicado`) → persona (`persona_inactiva`, `fuera_de_vigencia`) → puerta (`puerta_deshabilitada`, `puerta_bloqueada`, `lado_no_habilitado`) → derechos (unión: `accessAll` D7, grupos (puerta, horario), puertas directas, grants temporales, pase QR, feriados; rechazos `puerta_no_autorizada`, `fuera_horario_turno`, `fuera_dia_turno`, `sin_turno`, `sin_citacion_para_hoy`, `visita_fuera_de_ventana`, `pase_vencido`) → política (`requireGuardApproval` D16 → `needs_approval`) → interlock (`estanco_ocupado`, `debe_ingresar_por_exterior`) → APB (blando `apb_advertencia`, duro `apb_violacion`). Se conservan los `denialReason` actuales.

| Regla actual | Modelo nuevo |
|---|---|
| `people.allowedDoorIds` | Puertas directas, horario `24x7`; `[]` = ninguna. |
| `authorizations` permanentes con `daysOfWeek`/`timeWindow` | Schedule autogenerado deduplicado (`sch_auto_<hash>`), tolerancia 15 min. |
| Citación | Grant temporal `{cardholderId, from, to, doors, source:'citacion', refId}`; política `citacionWindowStrict`. |
| Visita / temporal por rango | Grant temporal por rango. |
| Turno de nómina (tolerancia 30/15) | Schedule de turno; áreas con citación obligatoria → `requiresGrant=true`. |
| Área Sistemas | Schedule 24x7 sobre sus puertas directas. |
| `visitas` | `visitorPasses {dni, qrId, doors, validFrom = esperada − 2h, validTo = fin del día, estado}`; DNI y QR (D9/D10). |
| BioStar | Credencial `biostar:<userId>`; dirección por equipo (D18); coacción → alarma `duress`. |

Test de paridad con fixtures anonimizados: `decidirAcceso` actual vs motor, diferencias documentadas.

## 3. Datos

**Firestore** (fuente de verdad): `sites/{siteId}` (tz, políticas, `hubDeviceId`, `lanUrl`, `configVersion`; un proyecto por cliente → `siteId='principal'`), `sites/{s}/areas/{id}`, `settings/doorsConfig` extendido (`sides`, `readers[{id, side, driver}]`, `outputs.lock`, `inputs {dps, bond, rex, emergency}`, `controllerId`, `heldOpenSec`, `unlockSec`, `requireGuardApproval`, `sensorsRequired`), `interlockGroups` con `mode:'sensor'|'timed'` (D5), `people` + `accessAll`, `accessLevels`, `shiftScheduleId`, `requiresGrant`, `bucket`; `credentials/{id}` (`type dni|card|qr|biostar|pin`, `valueHash`, `status`, vigencia), `accessGroups/{id}` (`grp_total` = `'*'`), `schedules/{id}`, `holidays/{year}`, `visitorPasses/{id}`, `devices/{id}` (`pubKey`, `refreshHash`, `status active|revoked|replaced`).

Snapshot compilado: `sites/{s}/compiled/head` `{version, chunks:{name:{v,hash}}, sig, keyId}` + chunks `doors`, `ch-00…ch-63` (cardholders + credenciales por `hash(personId)%64`), `grants-YYYYMMDD` (D-1 a D+7), `passes`, `operators` (hash bcrypt, `passwordVersion`, posts D6). Delta por bucket sucio: ~30 lecturas + 2 escrituras por cambio; importación masiva ~2.100 R / 70 W.

Operación: `sites/{s}/journal/{YYYYMMDD}_{hubId}_{hubSeqFrom}` (≤200 eventos, id determinístico), `commands/{id}` (TTL 45 s), `alarms/{id}`, `status/hub`, `live/summary`.

**SQLite** (hub y controlador; `node:sqlite` con Node 24 LTS portable, fallback `better-sqlite3`):

```
meta(key PK, value)
chunks(name PK, version, hash, body, verified)
cardholders(id PK, status, name, valid_from, valid_to, flags_json)
credentials(type, value_hash, cardholder_id, status, valid_from, valid_to, PK(type,value_hash))
rights(cardholder_id, door_id, schedule_id, source, ref_id, valid_from, valid_to)
schedules(id PK, json); holidays(date PK, set_id); doors(id PK, json); interlocks(id PK, json)
passes(id PK, json); revocations(id PK)
events(id PK, seq INT UNIQUE, ts, clock_q, device_id, door_id, side, type, cred_type, cred_hash,
       cardholder_id, decision, reason, payload_json, acked INT, hub_seq INT)
door_state(door_id PK, state, since, dps, bond)
-- solo hub:
presence(cardholder_id PK, area_id, ts, event_id)
alarms(id PK, type, door_id, state, first_ts, last_ts, count, ack_by, ack_note)
operators(username PK, hash, pwd_version, perms_json, posts_json)
commands(id PK, source, door_id, action, status, requested_by, reason, result_json, ts)
```

Id de evento `${deviceId}:${seq}` (idempotencia de punta a punta). Retención local 90 días.

## 4. Sincronización

- **Nube → hub**: `onSnapshot` sobre `compiled/head`; lee solo chunks con hash distinto; verifica firma y hash. Fallback GET `/api/edge/v1/head` cada 5 min.
- **Hub → controladores** (LAN): `POST /edge/config/notify` + `GET /edge/config/chunks`; el bundle sigue firmado por la nube (un hub comprometido no puede inventar derechos); requests firmadas Ed25519 con ventana de 60 s; ack `configVersionApplied` visible en Admin.
- **Eventos**: controlador → hub (push + backoff, ack por seq) → nube en lotes ≤200 cada 2 min (alarmas inmediatas) vía `POST /api/edge/v1/events` → journal + proyecciones + cursor, responde `ackHubSeq`.
- **Comandos**: nube → `commands/{id}` → hub → controlador → resultado real (`relayConfirmed`, `doorOpened` por DPS). Desde la LAN: guardia → hub → controlador sin nube, auditado.
- **Identidad de equipos** (reemplaza usuarios kiosk): Admin crea equipo → código de enrolamiento de un uso (10 min, QR) → `mss-edge enroll <código>` genera par Ed25519 → `deviceId` + refresh token (la nube guarda el hash) → JWT de 1 h y, para el hub, custom token Firebase `{siteId, deviceId, kind}`. "Reemplazar equipo" hereda puertas y revoca el anterior.

## 5. Máquina de estados de puerta e interlock (controlador)

Estados: `SEGURA` → `DESBLOQUEADA` (timer `unlockSec`) → `ABIERTA_AUT` (timer `heldOpenSec`) → `RETENIDA` (alarma `held_open`); `FORZADA` (DPS abierto sin REX ni grant → `door_forced`); `FALLA` (sensor inconsistente o bond no trabó en 2 s → `lock_fault`). Debounce 50 ms; re-traba al cerrar DPS (mín. 1 s); REX desbloquea (maglock) o enmascara el forzado; emergencia → desbloqueo mantenido del grupo.

Interlock: una puerta solo se desbloquea si todas las demás del grupo están en `SEGURA` (DPS cerrado + bond trabado). `mode:'sensor'` obligatorio en producción (D5/D17); `mode:'timed'` en banco (reusa `deriveAirlockPhase`). D4: apertura manual respeta el estanco (`AIRLOCK_OTHER_OPEN`); forzar con permiso `puertas.estanco.forzar` (guardia y jefe) + motivo → evento `apertura_forzada_estanco`. Tolera interlock por hardware: si el relé se activa y el DPS no abre en `unlockSec` → "la puerta no abrió (posible bloqueo físico)", sin alarma de forzado.

## 6. Cliente guardia en la LAN

Hub sirve `frontend-libro-guardia/build` en `http://<hub>:8080`; API LAN compatible: `/api/auth/login|me|change-password`, `/api/guard/doors` (filtrado por puesto D6), `/api/guard/open-door`, `/api/guard/airlock/:id`, `/api/entries` (SQLite), `/api/guard/live-alerts`, `/api/guard/citados/today`, `/api/access/validar`, nuevos `/api/runtime` (`{mode:'lan', capabilities}`) y `/api/live` (SSE); el resto `501 EDGE_UNSUPPORTED` y la UI oculta esos menús. Auth offline: bcrypt contra el chunk `operators`, JWT firmado con clave propia del hub (nunca el `JWT_SECRET` de la nube). Descubrimiento: IP reservada + mDNS `mssguard.local` + botón "Abrir modo planta" con `sites.lanUrl`. HTTPS (cámara) en fase 2 con certificado por sitio. Vista remota: `GET /api/sites/:id/live` (1 lectura de `live/summary`, caché 15 s; el hub lo escribe ≤1/min y solo si cambió).

## 7. Costo Firebase (20 puertas, 2.000 pasos/día, 3 pantallas remotas)

| Concepto | Escrituras/día | Lecturas/día |
|---|---|---|
| Proyección `entries` (solo autorizados) | 2.000 | – |
| Journal (lotes cada 2 min) | ~500 | – |
| Heartbeat + cursor del hub (5 min) | 288 | – |
| `live/summary` (≤1/min, 12 h activas) | ≤720 | – |
| Config (50 cambios) | 100 | 200 |
| Grants, alarmas, comandos | ~80 | ~60 |
| Pantallas remotas (poll 30 s, 10 h, caché 15 s) | – | ≤3.600 |
| Health en la nube (15 min) | – | 96 |
| Admin y reportes | ~200 | ~2.500 |
| **Total** | **≈3.900 (20 % de la cuota)** | **≈6.500 (13 %)** |

~150k invocaciones/mes (gratis hasta 2M). Sin `minInstances`. Costo esperado US$0; alertas de presupuesto en US$1 y US$5.

A eliminar porque leen Firestore por escaneo o por poll: `claim-pending-opens` cada 5 s, heartbeats de lector/estación + `runtime-config`, `kiosk-scan`/`ingest` con `decidirAcceso` (~10 lecturas por paso), `buildDoorAllowlist`, transacciones `reserveDoorOpen`, `bridgeHealthPoll` sobre todos los equipos, `stationHealth` → `deviceEvents`, `guardLocalStations` en cada `/guard/doors`, `EntriesContext` cada 15 s, `offlineEntries` con un `get` por evento.

## 8. Migración y pruebas

1. Motor + compilador desplegados; `door-allowlist`, `kiosk-scan`, `ingest` resueltos con el motor sobre el snapshot en memoria; la estación v1.7 sigue igual y ya cuesta menos.
2. `functions/scripts/migrate-etapa2.js` (idempotente, `--dry-run`): `allowedDoorIds` → puertas directas, `authorizations` → schedules y grants, `visitas` → `visitorPasses`, `airlockGroups` → `interlockGroups`, `lectores`/`estaciones` → `devices` a enrolar, `grp_total`.
3. Corte por puerta: con `door.controllerId`, la nube usa `commands`; endpoints legacy `410 DOOR_MIGRATED` solo para puertas migradas.
4. La PC Windows del banco se reinstala como hub + controlador (NSSM, Node 24 portable); `mss-edge import-legacy` convierte su config.
5. Final: se desactivan usuarios `kiosk_puerta` y se eliminan polls, `pending_local_opens`, `allowlist_cache`, `doorAirlockStates`, `guardLocalStations`.

Pruebas en banco (SR201 192.168.0.38, DNI COM3, PC hub + controlador; luego Pi controlador): golden tests + paridad; corte de internet (DNI válido abre < 300 ms, desconocido niega, al volver journal exacto sin duplicados); cambio de permisos durante el corte aplicado < 60 s al volver; hub detenido; `kill -9` en ráfaga de 500 escaneos; reloj adelantado 10 min; estanco `timed` con dos canales; apertura remota con resultado real y con puerta desconectada; medición de costo 24 h; puerta legacy en paralelo.

## 9. Tareas

| # | Tarea | Archivos | Depende | Tamaño |
|---|---|---|---|---|
| T1 | Motor puro + `reasons.es.js` + contrato `snapshotSchema.js` + paridad | `functions/lib/accessEngine/**` | – | L |
| T2 | Compilador por sitio (buckets, chunks, head, firma, sucios) + snapshot en memoria | `functions/lib/siteCompiler/**` + hooks en rutas que mutan | T1 | L |
| T3 | Almacenamiento edge (SQLite, migraciones, chunk store, journal, retención) | `scripts/edge/lib/db/**` | – | M |
| T4 | API edge en la nube (devices, events, commands, head, reglas) | `functions/routes/edge.js`, `functions/lib/{devices,edgeIngest}.js`, `firestore.rules` | T2 | L |
| T5 | Runtime del controlador (estados, interlock, drivers, firma LAN) | `scripts/edge/controller/**`, `scripts/edge/drivers/**` | T1, T3 | L |
| T6 | Runtime del hub (listener, LAN, subida, presencia/APB, alarmas, comandos, NTP, lease) | `scripts/edge/hub/**` | T3, T4 | L |
| T7 | API LAN del hub para la UI (estáticos, auth offline, compat, SSE, runtime) | `scripts/edge/hub/lanApi/**` | T6 | M |
| T8 | Frontend (capabilities, SSE, sin `localStationClient`, D6, resumen remoto) | `frontend-libro-guardia/src/{services,utils,components/DigitalDoorPanel.js,context}` | T7 | M |
| T9 | Admin del modelo profesional (puertas/lados/entradas, áreas, grupos, horarios, equipos, alarmas con ack) | `frontend-libro-guardia/src/pages/Admin/**` + CRUD | T2, T4 | L |
| T10 | Migración y compatibilidad | `functions/scripts/migrate-etapa2*.js`, `functions/lib/{doorAllowlist,lectores,pendingLocalOpens,guardLocalStations}.js`, `functions/accessControl.js` | T1, T2 | M |
| T11 | Instaladores y banco (systemd, NSSM + Node portable, enroll, import-legacy, simuladores, corte de red) | `scripts/edge/install/**`, `scripts/edge/tools/**` | T5, T6 | M |
| T12 | BioStar en el hub (publica al hub; coacción → alarma) | `scripts/programa-biostar.js`, `scripts/lib/biostar*` | T6 | S |

Olas: 1 = T1, T3, esqueleto devices de T4 · 2 = T2, T5, T6 · 3 = T7, T8, T10, T12 · T9 y T11 en paralelo con 2 y 3.

**Hito 1 (demo en banco):** T1 + T3 + T2 mínimo + T4 mínimo + T5 (serie COM3 + SR201, sin GPIO) + T6 mínimo → la PC (o una Pi) decide sin internet con SQLite y el hub sincroniza config y eventos con la nube.
