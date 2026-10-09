# API LAN del hub (app de guardia)

La misma build de la app se sirve en `http://<hub>:8080`. Con `API_BASE_URL='/api'` las llamadas quedan en el hub y no salen a internet.

Errores: `{message, code?}`, textos en español simple. CORS solo si el `Origin` coincide con el `Host` (la app y la API son el mismo origen). Otro origen no recibe `Access-Control-Allow-Origin`.

## Rutas

| Método y ruta | Qué hace |
|---|---|
| `GET /api/runtime` | `{mode:'lan', siteId, hubId, configVersion, cloudOnline, capabilities}`. Sin token. En la nube esta ruta no existe. |
| `POST /api/auth/login` | `{username, password}` → `{token, user}` como la nube. |
| `GET /api/auth/me` | El operador del token. |
| `POST /api/auth/change-password` | **501** `Cambiá tu contraseña cuando haya internet`. Hace falta token. |
| `GET /api/guard/doors` | Puertas del puesto, con `live`, `health`, `lastPulse` y `airlock` si corresponde. |
| `POST /api/guard/open-door` | Reenvía al controlador dueño. |
| `GET /api/entries` | Pasos del journal en forma de `entries`. |
| `GET /api/guard/live-alerts` | Alarmas abiertas, cada una con `kind:'alarm'`. |
| `POST /api/guard/alarms/:id/ack` | `{note}` (mínimo 3 caracteres) → `{ok}`. |
| `GET /api/live?token=` | SSE. Eventos `door`, `access`, `alarm`, `config`, `runtime`. `: ping` cada 20 s. |
| Cualquier otra `/api/*` | **501** `{code:'EDGE_UNSUPPORTED', message:'Disponible solo con internet'}`. |

`capabilities` es `['auth','doors','open','entries','alarms','live','scan']`. `scan` se anuncia para que la app sepa que el modo planta existe, pero **no hay** ruta de escaneo en este contrato: `/api/access/validar` y el resto siguen en 501.

## Auth

Los operadores salen del chunk `operators` (tabla `operators`: usuario, hash bcrypt, `passwordVersion`, permisos, puestos). `role`, `nombre`, `mustChangePassword` y `active` se leen del cuerpo del chunk si está guardado. Quien no está en la tabla no entra. `active: false` en el chunk rechaza el login.

El JWT es HS256, 8 horas, clave aleatoria en `meta.hub_lan_jwt_secret` (se crea la primera vez). No es el `JWT_SECRET` de la nube. El token lleva `passwordVersion`: si el chunk lo cambia, `/api/auth/me` y el resto responden 401.

Cinco claves mal por el mismo usuario e IP bloquean 15 minutos (`LOGIN_LOCKED`).

## Puertas (D6)

Sin `posts`, el operador ve todas las puertas habilitadas. Con `posts`, solo las que coinciden (sin mayúsculas ni acentos) con el id, `post`, `postId`, `puesto` o el nombre. Así `porton` matchea una puerta llamada `Portón`.

`live.since` es epoch en milisegundos. `live.state` pasa a `SIN_CONEXION` si el controlador no se vio en la ventana del hub. La fase `airlock.phase` es una aproximación con el estado de las otras puertas del grupo: `idle`, `this_open` u `other_open`. El controlador es quien responde 409 si el estanco no deja abrir.

La respuesta es `{defaultDoorId, doors, airlockGroups}`, como la nube. Cada puerta trae también `active` y `manualOpenAllowed` para el panel actual.

## Apertura

`POST /api/guard/open-door` exige `access.manual_open` y que la puerta esté en el puesto. Forzar el estanco exige `puertas.estanco.forzar` y un motivo de al menos 5 caracteres.

El reenvío es `POST /edge/doors/:id/open` firmado con `controllers.call` (la misma firma Ed25519 que `openDoor`). Se usa `call` porque `ControllerRegistry.openDoor` no copia el array `permissions` al cuerpo; el controlador las acepta en `permissions` o en `requestedBy.permissions`. Van las dos, más `force`, `forceAuthorized` y `forceReason`.

Respuestas: 200 `{ok, message, relayConfirmed, eventId}`, 409 `{code:'AIRLOCK_OTHER_OPEN', message, forcible}`, 403, 429 `COOLDOWN`, 502 si el controlador o el relé no responden.

`eventId` es el del journal del hub (`manual_open`, con el operador). Si el controlador devuelve el suyo, también va `controllerEventId`.

## Pasos y alarmas

`GET /api/entries` lista eventos `access` y `passage` del rango (por defecto hoy, hora de Argentina). Cada fila es `type:'personal'`, `tipoMovimiento` y `movementType` (`ingreso`/`egreso`; el historial lee `movementType`), `idNumber` enmascarado (últimos 3 dígitos), `entrySource:'edge'`, `warnings`. Concede y deniega. `manual_open` no entra en el libro.

Las alarmas abiertas son las de estado `active` o `restored` sin `ack_by`. El ack guarda la nota, escribe `alarm_ack` y avisa por SSE (`state:'acked'`).

## SSE

`index.js` tiene un `EventEmitter` (`hub.bus`). Después de ingerir eventos nuevos (sin tocar `liveState.js`) emite `ingested`. Un head que cambia la versión emite `config`. Si `cloudOnline` pasa de sí a no (o al revés) emite `runtime`. El ack emite `alarm`.

El token del SSE puede ir en `Authorization` o en `?token=`.
