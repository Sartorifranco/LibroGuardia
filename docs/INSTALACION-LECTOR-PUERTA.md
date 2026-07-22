# Instalación — lector GADNIC en puerta (serie RS-232)

Mini PC / PC de planta por puerta + lector **GADNIC CODBAR14** en modo **serie (RS-232)** + relé **SR201**.

App: https://bacarguard.web.app — Firebase Hosting / Cloud Functions.

Validado en hardware real (Windows, COM3, 9600 baud, terminador **CR**). El disparo ciego del relé se probó con `scripts/test-lector-rele.js`; este documento describe el **camino de producción** (`door-reader-bridge.js` → API → autorización → relé).

---

## Arquitectura (quién hace qué)

```
GADNIC CODBAR14 (RS-232 / USB-serie)
        │  COM3 @ 9600, frame hasta CR
        ▼
door-reader-bridge.js  (PC / mini PC de ESA puerta)
        │
        │  HTTPS  POST /api/auth/login
        │  HTTPS  POST /api/access/kiosk-scan  { rawData, doorId, readerId }
        ▼
Cloud Functions (autoriza + dispara relé)
        │
        │  HTTPS (túnel Cloudflare / URL pública del puente)
        ▼
sr201-bridge.js  (UNA PC/servidor de planta)
        │  TCP :6722  (host/port de ESA puerta)
        ▼
SR201 de la puerta
```

### Importante: IP privada del SR201

`triggerRelay` **rechaza IPs privadas** (ej. `192.168.0.38`) si no hay `bridgeUrl`. En producción la puerta **debe** tener configurado el puente SR201 + túnel (Admin → Puertas → URL pública del túnel). El script de diagnóstico puede abrir el relé por TCP directo en LAN; el bridge de lector **no** habla con el SR201.

### Un solo bridge SR201 para todas las puertas (recomendado)

Si las puertas están en la **misma LAN**:

1. Un `scripts/sr201-bridge.js` + un túnel Cloudflare.
2. En Admin → Puertas, cada puerta con su `host` / `port` / `channel` y el **mismo** `bridgeUrl`.
3. Un `door-reader-bridge` **por puerta** (el lector serie está enchufado ahí).

---

## Hardware confirmado

| Ítem | Valor real validado |
|------|---------------------|
| Lector | GADNIC CODBAR14 |
| Modo | **RS-232 / serie** (no keyboard-wedge para este bridge) |
| Puerto Windows | **COM3** (puede variar; ver Administrador de dispositivos) |
| Baud rate | **9600** 8N1 |
| Terminador de lectura | **CR** (`0x0D`) |
| Formato DNI | PDF417 argentino → compatible 1:1 con `functions/dniParser.js` |
| Adaptador | USB↔serie del propio lector / cable que enumera como “Dispositivo serie USB” |
| Relé | SR201 Ethernet (ej. `192.168.0.38:6722`) vía **puente + túnel** en producción |

---

## 1. Configurar el GADNIC en modo serie

1. Entrá al menú de configuración del CODBAR14 (manual del fabricante / códigos de configuración).
2. Seleccioná interfaz **RS-232 / Serial** (no HID teclado).
3. Baud **9600**, 8 datos, sin paridad, 1 stop.
4. Sufijo / terminador: **CR** (Carriage Return).
5. En Windows: Administrador de dispositivos → Puertos (COM y LPT) → anotá el COM (ej. COM3).

Verificación rápida **sin API**:

```powershell
cd C:\Users\Admin\Desktop\LG
cd scripts
npm install
cd ..
node scripts/test-lector-rele.js --port COM3 --baud 9600 --diag-only
```

Al escanear un DNI deberías ver bytes crudos con `[CR]` al final y el texto PDF417 (`tramite@apellido@nombre@...`).

---

## 2. Configurar la puerta en LibroGuardia

1. Admin → Puertas: crear/editar la puerta (`doorId`, ej. `puerta-entrada`).
2. Device SR201: `host` / `port` / `channel` + **`bridgeUrl`** del túnel de planta (obligatorio en producción).
3. Lectores con dirección fija si aplica:

```json
"readers": [
  { "id": "lector-in", "direction": "ingreso" },
  { "id": "lector-out", "direction": "egreso" }
]
```

---

## 3. Usuario de sistema (solo `access.kiosk`)

**Recomendado:** Admin → **Lectores** → crear el lector. El panel genera el usuario kiosk,
muestra la contraseña **una sola vez** y descarga el `door-reader.config.json` listo para la mini PC.

**Manual (legado):** un usuario por puerta desde Admin → Usuarios + rol `kiosk_puerta`.

El bridge hace `POST /api/auth/login`, heartbeat cada 5 min a `/api/lectores/heartbeat`, y re-loguea ante `401` o JWT vencido (~8 h).

---

## 4. Instalar door-reader-bridge (Windows — PC de validación / mini PC)

```powershell
cd C:\ruta\LibroGuardia\scripts
npm install

copy door-reader.config.example.json door-reader.config.json
notepad door-reader.config.json
```

Campos del JSON:

| Campo | Ejemplo | Descripción |
|-------|---------|-------------|
| `apiBaseUrl` | `https://bacarguard.web.app/api` | Base de la API (sin `/` final de más) |
| `username` / `password` | usuario kiosk de esa puerta | Login JWT |
| `doorId` | `puerta-p1` | ID en Admin → Puertas |
| `readerId` | `INGRESO_P1` | Debe existir en `readers` de la puerta |
| `serialPort` | `COM3` | Puerto serie del GADNIC |
| `baudRate` | `9600` | Confirmado en campo |
| `idleMs` | `120` | Flush por silencio si no hubiera CR (respaldo) |
| `inputMode` | `serial` | `stdin` solo para pruebas sin hardware |
| `logFile` | `C:\Logs\door-reader-bridge.log` | Opcional |
| `reconnectMinMs` / `reconnectMaxMs` | `2000` / `60000` | Backoff serie y red |

Prueba manual:

```powershell
$env:DOOR_READER_CONFIG = "C:\ruta\LibroGuardia\scripts\door-reader.config.json"
node C:\ruta\LibroGuardia\scripts\door-reader-bridge.js
```

Al arrancar: `Sesión kiosk OK`. Al escanear: `Escaneo recibido` → `Resultado kiosk-scan` con `authorized: true/false` y `relayTriggered` / `relayError`.

### Servicio permanente (Windows — NSSM o Tarea programada)

**Opción A — NSSM**

```powershell
nssm install LibroGuardiaDoorReader "C:\Program Files\nodejs\node.exe" "C:\LG\scripts\door-reader-bridge.js"
nssm set LibroGuardiaDoorReader AppDirectory C:\LG\scripts
nssm set LibroGuardiaDoorReader AppEnvironmentExtra DOOR_READER_CONFIG=C:\LG\scripts\door-reader.config.json
nssm set LibroGuardiaDoorReader Start SERVICE_AUTO_START
nssm start LibroGuardiaDoorReader
```

**Opción B — Tarea programada** al inicio de sesión / arranque, con el mismo `node …door-reader-bridge.js` y variable `DOOR_READER_CONFIG`.

El proceso reconecta el COM y reintenta la red con backoff; no hace falta reiniciarlo ante un glitch corto.

---

## 5. Raspberry Pi (futuro)

Cuando se migre de la PC Windows a Pi por puerta:

- Mismo script; `serialPort` será algo como `/dev/ttyUSB0` o `/dev/serial/by-id/...`.
- Servicio con **systemd** (equivalente al NSSM de Windows).
- El framing y la API no cambian.

---

## Diagnóstico en campo

| Síntoma | Qué mirar |
|---------|-----------|
| No abre COM | Nombre del puerto; otro programa usando el COM; cable/adaptador |
| Bytes basura | Baud rate (probar 9600); modo serie del GADNIC |
| Login 401/403 | usuario/password; permiso `access.kiosk`; usuario activo |
| Denegado siempre | citación/nómina; `direction` del reader; `doorId` |
| Autorizado pero no abre | `sr201-bridge` + túnel; `bridgeUrl` en la puerta; host/port/canal |
| Red intermitente | backoff del bridge; no mata el proceso |

Herramienta hermana (disparo directo LAN, **sin** autorización): `scripts/test-lector-rele.js`.

---

## Relación con docs existentes

- Puente SR201 / túnel: [INSTALACION-SR201.md](./INSTALACION-SR201.md)
- Multi-puertas / API kiosk: [MULTI-PUERTAS.md](./MULTI-PUERTAS.md)
- Checklist molinete: [PRUEBA-MOLINETE.md](./PRUEBA-MOLINETE.md)
