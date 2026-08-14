# Instalación — lector GADNIC en puerta (serie RS-232)

Mini PC / PC de planta por puerta + lector **GADNIC CODBAR14** en modo **serie (RS-232)** + relé **SR201**.

App: https://mss-guard.web.app — Firebase Hosting / Cloud Functions.

Validado en hardware real (Windows, COM3, 9600 baud, terminador **CR**). El disparo ciego del relé se probó con `scripts/test-lector-rele.js`; este documento describe el **camino de producción** (`door-reader-bridge.js` → API → autorización → relé).

---

## Arquitectura (quién hace qué)

```
GADNIC CODBAR14 (RS-232 / USB-serie)
        │  COM3 @ 9600, frame hasta CR
        â–¼
door-reader-bridge.js  (PC / mini PC de ESA puerta)
        │
        │  HTTPS  POST /api/auth/login
        │  HTTPS  POST /api/access/kiosk-scan  { rawData, doorId, readerId }
        â–¼
Cloud Functions (autoriza + dispara relé)
        │
        │  HTTPS (túnel Cloudflare / URL pública del puente)
        â–¼
sr201-bridge.js  (UNA PC/servidor de planta)
        │  TCP :6722  (host/port de ESA puerta)
        â–¼
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
| Adaptador | USB↔serie del propio lector / cable que enumera como "Dispositivo serie USB" |
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

---

## 3. Usuario de sistema (solo `access.kiosk`)

**Recomendado (emparejamiento):** Admin → **Lectores** → crear el lector → botón **Generar código de instalación** (6 dígitos, 10 min, un solo uso). En la mini PC corré `instalar-lector.cmd` (ver sección 4).

**Alternativa manual:** el panel también puede mostrar la contraseña una sola vez / **Descargar config** (JSON sin password en re-descarga; regenerá credenciales si la perdiste).

**Legado:** un usuario por puerta desde Admin → Usuarios + rol `kiosk_puerta`.

El bridge hace `POST /api/auth/login`, heartbeat cada 5 min a `/api/lectores/heartbeat`, y re-loguea ante `401` o JWT vencido (~8 h).

---

## 4. Instalar door-reader-bridge (Windows)

### Flujo recomendado — código + servicio (NSSM)

1. En Admin → Lectores, generá el **código de instalación** del lector.
2. En la mini PC, copiá la carpeta `scripts` del repo (o el paquete de despliegue) y asegurate de tener **Node.js LTS**.
3. Doble clic en `scripts\instalar-lector.cmd` (**Ejecutar como administrador**).
4. Pegá el código de 6 dígitos (y confirmá la URL de API si te la pide; default `https://mss-guard.web.app/api`).

El script:

- Canjea el código en `POST /api/auth/pairing-exchange` (obtiene JSON + password nueva).
- Guarda `door-reader.config.json` en la misma carpeta `scripts`.
- Corre `npm install`.
- Registra `door-reader-bridge.js` como servicio Windows con **NSSM** (arranque automático + reinicio si se cae).

**NSSM:** si no está en el PATH, el instalador **lo descarga solo** (portable 2.24 en `scripts\tools\nssm\`). No hace falta instalarlo a mano salvo que la PC no tenga salida a internet hacia `nssm.cc`.

Después de esta única vez **no hace falta** volver a abrir PowerShell para ese lector.

```powershell
# Equivalente sin .cmd (también como Administrador):
cd C:\ruta\LibroGuardia\scripts
powershell -ExecutionPolicy Bypass -File .\instalar-lector.ps1 -Code 482915
```

### Alternativa manual — JSON + consola (sin NSSM)

```powershell
cd C:\ruta\LibroGuardia\scripts
npm install

copy door-reader.config.example.json door-reader.config.json
notepad door-reader.config.json
```

Campos del JSON:

| Campo | Ejemplo | Descripción |
|-------|---------|-------------|
| `apiBaseUrl` | `https://mss-guard.web.app/api` | Base de la API (sin `/` final de más) |
| `username` / `password` | usuario kiosk de esa puerta | Login JWT |
| `doorId` | `puerta-p1` | ID en Admin → Puertas |
| `readerId` | `INGRESO_P1` | Debe existir en `readers` de la puerta |
| `serialPort` | `COM3` | Puerto serie del GADNIC |
| `baudRate` | `9600` | Confirmado en campo |
| `idleMs` | `120` | Flush por silencio si no hubiera CR (respaldo) |
| `inputMode` | `serial` | `stdin` solo para pruebas sin hardware |
| `logFile` | `C:\Logs\door-reader-bridge.log` | Opcional |
| `reconnectMinMs` / `reconnectMaxMs` | `2000` / `60000` | Backoff serie y red |
| `localServerPort` / `localServerSecret` | `8787` / (secreto) | Servidor HTTP LAN del bridge. El **pairing** los incluye solo si el lector tiene **estación** asignada en Admin → Estaciones. Sin estación: ausentes (servidor local deshabilitado). |
| `localServerHost` | `0.0.0.0` | Bind LAN (todas las interfaces) |

Prueba manual:

```powershell
$env:DOOR_READER_CONFIG = "C:\ruta\LibroGuardia\scripts\door-reader.config.json"
node C:\ruta\LibroGuardia\scripts\door-reader-bridge.js
```

Al arrancar: `Sesión kiosk OK`. Al escanear: `Escaneo recibido` → `Resultado kiosk-scan` con `authorized: true/false` y `relayTriggered` / `relayError`.

### Servicio permanente a mano (si no usaste el instalador)

**Opción A — NSSM**

```powershell
nssm install LibroGuardiaDoorReader "C:\Program Files\nodejs\node.exe" "C:\LG\scripts\door-reader-bridge.js"
nssm set LibroGuardiaDoorReader AppDirectory C:\LG\scripts
nssm set LibroGuardiaDoorReader AppEnvironmentExtra DOOR_READER_CONFIG=C:\LG\scripts\door-reader.config.json
nssm set LibroGuardiaDoorReader Start SERVICE_AUTO_START
nssm start LibroGuardiaDoorReader
```

**Opción B — Tarea programada** al inicio de sesión / arranque, con el mismo `node …door-reader-bridge.js` y variable `DOOR_READER_CONFIG` (ver `install-sr201-bridge-autostart.ps1` como referencia de patrón).

El proceso reconecta el COM y reintenta la red con backoff; no hace falta reiniciarlo ante un glitch corto.

---

## 4.1 Refrescar config (lector ya instalado + estación nueva)

Caso típico: el lector se instaló con el código de 6 dígitos **antes** de asignarlo a una estación (ej. «PC Franco»). El JSON de la mini PC **no** tiene `localServerPort` / `localServerSecret`, así que el bridge no levanta el HTTP local y el Centro de Control no puede abrir/consultar por LAN sin internet.

**No hace falta reinstalar Node, NSSM ni la carpeta `scripts`.** Se reutiliza el mismo emparejamiento:

1. En Admin → Estaciones: confirmá que la estación tiene **IP de red local**, **puerto** (ej. 8787) y **secreto**, y que el lector está **asignado** a esa estación.
2. En Admin → Lectores → ese lector → **Generar código de instalación** (`#`, 6 dígitos, 10 min, un solo uso).
3. En la mini PC, **como Administrador**, en la misma carpeta `scripts` donde ya está el bridge:
   ```text
   instalar-lector.cmd
   ```
   Pegá el código nuevo.
4. El instalador:
   - canjea el código (esto **regenera la password** del usuario kiosk — la anterior deja de servir; es esperado);
   - reescribe `door-reader.config.json` **incluyendo** `localServerPort` / `localServerSecret` de la estación;
   - reinicia el servicio NSSM (`LibroGuardiaDoor-<doorId>`).
5. Verificación rápida:
   - En la consola del instalador debería verse algo como `localServerPort=8787  estacion=PC Franco`.
   - En el JSON: `"localServerPort": 8787` y `"localServerSecret": "…"`.
   - Log del servicio: el bridge arranca y escucha el puerto local.
   - Si el COM no es COM3, editá `serialPort` en el JSON y `nssm restart LibroGuardiaDoor-<doorId>`.

**Alternativa** (sin regenerar password): Admin → Estaciones → descargar config unificada de la estación, fusionar a mano `localServer*` en el JSON existente, y reiniciar el servicio. El re-emparejamiento es el camino soportado y más simple.

### Versión del bridge para fallback LAN del panel (CORS)

El Centro de Control en `https://mss-guard.web.app` llama al HTTP local de la estación (`http://IP:8787/status` y `/open/...`). Eso exige:

1. Estación configurada + `localServer*` en el JSON (arriba).
2. **`door-reader-bridge.js` ≥ `1.1.0`** (`localStationApiVersion` ≥ **2**): responde **CORS** + **Private Network Access** (`Access-Control-Allow-Origin` del panel, `OPTIONS` preflight, `Access-Control-Allow-Private-Network: true`). Sin esa versión el navegador bloquea la respuesta aunque el bridge esté vivo.

Cómo ver la versión en la mini PC (con el servicio corriendo y el secreto de la estación):

```powershell
curl.exe -s -H "Authorization: Bearer TU_SECRETO" http://127.0.0.1:8787/status
```

Buscá `"bridgeVersion":"1.2.0"` y `"localStationApiVersion":3`.

**Actualizar sin reinstalar de cero:** copiá el `door-reader-bridge.js` nuevo a la carpeta `scripts` de la mini PC y reiniciá el servicio:

```powershell
# Fácil (como Administrador, desde scripts\):
.\actualizar-bridge.cmd
# o:
.\actualizar-bridge.cmd -DoorId puerta-p1

# Manual:
nssm restart LibroGuardiaDoor-puerta-p1
```

Guía detallada (pendrive + prueba HTTP): [ACTUALIZAR-BRIDGE-ESTACION.md](./ACTUALIZAR-BRIDGE-ESTACION.md).

(No hace falta re-emparejar solo por este cambio, si el JSON ya tiene `localServerPort` / `localServerSecret`.)

**Prueba local sin Mixed Content:** abrí `http://IP-DE-LA-MINI:8787/`, pegá el secreto, la IP del relé, Cargar puertas → Abrir.

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
