# Cómo agregar un proveedor de GPS de flota

MSS **no instala hardware GPS en los vehículos**. Lee posiciones por API del proveedor que el cliente ya tenga contratado.

Hoy el único conector listo es **UBIKA**. El módulo de flota (geocercas, tránsito, libro de guardia) no habla con UBIKA directo: pide `fetchFleet()` a un proveedor registrado. Un conector nuevo se cotiza como implementación de esta interfaz, no como un refactor de flota.

## Qué hay que implementar

Archivo nuevo: `functions/lib/gpsProviders/<id>.js`, y una línea en el mapa `PROVIDERS` de `functions/lib/gpsProviders/index.js`.

Contrato mínimo:

```js
module.exports = {
  id: 'acme',                 // minúsculas, sin espacios
  displayName: 'ACME GPS',
  resolveCredentials(config) { /* apiUrl, apiKey u otros secretos */ },
  isConfigured(config) { return Boolean(/* token */); },
  missingConfigMessage: 'Configure el token de API ACME',
  async fetchDevices(config) { /* lista cruda del proveedor */ },
  async fetchPositions(config) { /* lista cruda del proveedor */ },
  async fetchFleet(config) { /* ver payload canónico abajo */ }
};
```

`fetchFleet` es lo que usa el resto del sistema. Si el proveedor es un clon de Traccar (mismos `/api/devices` y `/api/positions`), se puede reutilizar `joinDevicesAndPositions` / `withDefaultFetchFleet` de `functions/lib/gpsProviders/` como hace UBIKA.

Los movimientos del libro quedan con `entrySource: gps_<id>` (UBIKA sigue grabando `gps_ubika`).

## Payload canónico que espera flota (`fetchFleet`)

Cada ítem:

| Campo | Tipo | Notas |
|---|---|---|
| `id` | string | Identificador estable del dispositivo |
| `deviceId` | string o number | Clave de track / cruce de portón |
| `name` | string | Nombre en el proveedor (ideal: incluye patente) |
| `plate` | string o null | Si viene en el nombre, UBIKA la extrae con regex AR |
| `status` | string | p.ej. `online` / `unknown` |
| `lat` / `lng` | number | WGS84. Posiciones inválidas se descartan |
| `speed` | number | En **nudos** (así lo manda Traccar/UBIKA). El umbral de movimiento usa `minSpeedKnots` |
| `fixTime` | ISO string o null | Hora del GPS; si falta, el libro usa la hora de detección |
| `ignition` | boolean | |
| `motion` | boolean | Si `requireMotion` está activo, un móvil parado no genera ingreso/egreso |

No hace falta devolver geocerca, zona ni distancia: eso lo calcula `fleetGps.js`.

## UBIKA (referencia)

- Auth: header `Authorization: Bearer <token>`
- Env: `UBIKA_API_URL` (default `https://ubika.rastreo.com.ar`), `UBIKA_API_TOKEN`
- También se pueden guardar URL y token en `settings/fleetGps` (el token no se expone al frontend; viaja enmascarado)
- Endpoints: `GET {apiUrl}/api/devices`, `GET {apiUrl}/api/positions` (arrays JSON estilo Traccar)

Dispositivo típico: `{ id, uniqueId, name, status }`
Posición típica: `{ deviceId, valid, latitude, longitude, speed, fixTime, deviceTime, attributes: { ignition, motion } }`

## Qué pedir al proveedor nuevo (para cotizar)

1. URL base y tipo de auth (Bearer, API key en query, usuario/clave).
2. Endpoint de lista de dispositivos y de última posición (o uno solo que ya los traiga juntos).
3. Unidades de velocidad (nudos vs km/h — si es km/h hay que convertir en el conector).
4. Cómo viene la patente (campo propio vs. metida en el nombre).
5. Rate limit y si hay que cachear (el cron de MSS consulta cada ~5 min).

## Qué no hay que tocar

Geocercas, panel del guardia, registro automático de ingreso/egreso y cron `fleetGpsAutoPoll` ya consumen el payload canónico. Un segundo proveedor **no** entra en el alcance de producto hasta que se pida explícitamente; este doc sirve para acotar el esfuerzo.

El panel Admin todavía dice “UBIKA” en textos: es el único conector en producción. Si se suma otro, ahí sí hay que generalizar esas etiquetas.
