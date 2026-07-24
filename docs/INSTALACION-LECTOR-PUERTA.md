# InstalaciÃ³n â€” lector GADNIC en puerta (serie RS-232)

Mini PC / PC de planta por puerta + lector **GADNIC CODBAR14** en modo **serie (RS-232)** + relÃ© **SR201**.

App: https://mss-guard.web.app â€” Firebase Hosting / Cloud Functions.

Validado en hardware real (Windows, COM3, 9600 baud, terminador **CR**). El disparo ciego del relÃ© se probÃ³ con `scripts/test-lector-rele.js`; este documento describe el **camino de producciÃ³n** (`door-reader-bridge.js` â†’ API â†’ autorizaciÃ³n â†’ relÃ©).

---

## Arquitectura (quiÃ©n hace quÃ©)

```
GADNIC CODBAR14 (RS-232 / USB-serie)
        â”‚  COM3 @ 9600, frame hasta CR
        â–¼
door-reader-bridge.js  (PC / mini PC de ESA puerta)
        â”‚
        â”‚  HTTPS  POST /api/auth/login
        â”‚  HTTPS  POST /api/access/kiosk-scan  { rawData, doorId, readerId }
        â–¼
Cloud Functions (autoriza + dispara relÃ©)
        â”‚
        â”‚  HTTPS (tÃºnel Cloudflare / URL pÃºblica del puente)
        â–¼
sr201-bridge.js  (UNA PC/servidor de planta)
        â”‚  TCP :6722  (host/port de ESA puerta)
        â–¼
SR201 de la puerta
```

### Importante: IP privada del SR201

`triggerRelay` **rechaza IPs privadas** (ej. `192.168.0.38`) si no hay `bridgeUrl`. En producciÃ³n la puerta **debe** tener configurado el puente SR201 + tÃºnel (Admin â†’ Puertas â†’ URL pÃºblica del tÃºnel). El script de diagnÃ³stico puede abrir el relÃ© por TCP directo en LAN; el bridge de lector **no** habla con el SR201.

### Un solo bridge SR201 para todas las puertas (recomendado)

Si las puertas estÃ¡n en la **misma LAN**:

1. Un `scripts/sr201-bridge.js` + un tÃºnel Cloudflare.
2. En Admin â†’ Puertas, cada puerta con su `host` / `port` / `channel` y el **mismo** `bridgeUrl`.
3. Un `door-reader-bridge` **por puerta** (el lector serie estÃ¡ enchufado ahÃ­).

---

## Hardware confirmado

| Ãtem | Valor real validado |
|------|---------------------|
| Lector | GADNIC CODBAR14 |
| Modo | **RS-232 / serie** (no keyboard-wedge para este bridge) |
| Puerto Windows | **COM3** (puede variar; ver Administrador de dispositivos) |
| Baud rate | **9600** 8N1 |
| Terminador de lectura | **CR** (`0x0D`) |
| Formato DNI | PDF417 argentino â†’ compatible 1:1 con `functions/dniParser.js` |
| Adaptador | USBâ†”serie del propio lector / cable que enumera como â€œDispositivo serie USBâ€ |
| RelÃ© | SR201 Ethernet (ej. `192.168.0.38:6722`) vÃ­a **puente + tÃºnel** en producciÃ³n |

---

## 1. Configurar el GADNIC en modo serie

1. EntrÃ¡ al menÃº de configuraciÃ³n del CODBAR14 (manual del fabricante / cÃ³digos de configuraciÃ³n).
2. SeleccionÃ¡ interfaz **RS-232 / Serial** (no HID teclado).
3. Baud **9600**, 8 datos, sin paridad, 1 stop.
4. Sufijo / terminador: **CR** (Carriage Return).
5. En Windows: Administrador de dispositivos â†’ Puertos (COM y LPT) â†’ anotÃ¡ el COM (ej. COM3).

VerificaciÃ³n rÃ¡pida **sin API**:

```powershell
cd C:\Users\Admin\Desktop\LG
cd scripts
npm install
cd ..
node scripts/test-lector-rele.js --port COM3 --baud 9600 --diag-only
```

Al escanear un DNI deberÃ­as ver bytes crudos con `[CR]` al final y el texto PDF417 (`tramite@apellido@nombre@...`).

---

## 2. Configurar la puerta en LibroGuardia

1. Admin â†’ Puertas: crear/editar la puerta (`doorId`, ej. `puerta-entrada`).
2. Device SR201: `host` / `port` / `channel` + **`bridgeUrl`** del tÃºnel de planta (obligatorio en producciÃ³n).
3. Lectores con direcciÃ³n fija si aplica:

```json
"readers": [
  { "id": "lector-in", "direction": "ingreso" },
  { "id": "lector-out", "direction": "egreso" }
]
```

---

---

## 3. Usuario de sistema (solo `access.kiosk`)

**Recomendado (emparejamiento):** Admin â†’ **Lectores** â†’ crear el lector â†’ botÃ³n **Generar cÃ³digo de instalaciÃ³n** (6 dÃ­gitos, 10 min, un solo uso). En la mini PC corrÃ© `instalar-lector.cmd` (ver secciÃ³n 4).

**Alternativa manual:** el panel tambiÃ©n puede mostrar la contraseÃ±a una sola vez / **Descargar config** (JSON sin password en re-descarga; regenerÃ¡ credenciales si la perdiste).

**Legado:** un usuario por puerta desde Admin â†’ Usuarios + rol `kiosk_puerta`.

El bridge hace `POST /api/auth/login`, heartbeat cada 5 min a `/api/lectores/heartbeat`, y re-loguea ante `401` o JWT vencido (~8 h).

---

## 4. Instalar door-reader-bridge (Windows)

### Flujo recomendado â€” cÃ³digo + servicio (NSSM)

1. En Admin â†’ Lectores, generÃ¡ el **cÃ³digo de instalaciÃ³n** del lector.
2. En la mini PC, copiÃ¡ la carpeta `scripts` del repo (o el paquete de despliegue) y asegurate de tener **Node.js LTS**.
3. Doble clic en `scripts\instalar-lector.cmd` (**Ejecutar como administrador**).
4. PegÃ¡ el cÃ³digo de 6 dÃ­gitos (y confirmÃ¡ la URL de API si te la pide; default `https://mss-guard.web.app/api`).

El script:

- Canjea el cÃ³digo en `POST /api/auth/pairing-exchange` (obtiene JSON + password nueva).
- Guarda `door-reader.config.json` en la misma carpeta `scripts`.
- Corre `npm install`.
- Registra `door-reader-bridge.js` como servicio Windows con **NSSM** (arranque automÃ¡tico + reinicio si se cae).

**NSSM:** si no estÃ¡ en el PATH, el instalador **lo descarga solo** (portable 2.24 en `scripts\tools\nssm\`). No hace falta instalarlo a mano salvo que la PC no tenga salida a internet hacia `nssm.cc`.

DespuÃ©s de esta Ãºnica vez **no hace falta** volver a abrir PowerShell para ese lector.

```powershell
# Equivalente sin .cmd (tambiÃ©n como Administrador):
cd C:\ruta\LibroGuardia\scripts
powershell -ExecutionPolicy Bypass -File .\instalar-lector.ps1 -Code 482915
```

### Alternativa manual â€” JSON + consola (sin NSSM)

```powershell
cd C:\ruta\LibroGuardia\scripts
npm install

copy door-reader.config.example.json door-reader.config.json
notepad door-reader.config.json
```

Campos del JSON:

| Campo | Ejemplo | DescripciÃ³n |
|-------|---------|-------------|
| `apiBaseUrl` | `https://mss-guard.web.app/api` | Base de la API (sin `/` final de mÃ¡s) |
| `username` / `password` | usuario kiosk de esa puerta | Login JWT |
| `doorId` | `puerta-p1` | ID en Admin â†’ Puertas |
| `readerId` | `INGRESO_P1` | Debe existir en `readers` de la puerta |
| `serialPort` | `COM3` | Puerto serie del GADNIC |
| `baudRate` | `9600` | Confirmado en campo |
| `idleMs` | `120` | Flush por silencio si no hubiera CR (respaldo) |
| `inputMode` | `serial` | `stdin` solo para pruebas sin hardware |
| `logFile` | `C:\Logs\door-reader-bridge.log` | Opcional |
| `reconnectMinMs` / `reconnectMaxMs` | `2000` / `60000` | Backoff serie y red |
| `localServerPort` / `localServerSecret` | `8787` / (secreto) | Servidor HTTP LAN del bridge. El **pairing** los incluye solo si el lector tiene **estaciÃ³n** asignada en Admin â†’ Estaciones. Sin estaciÃ³n: ausentes (servidor local deshabilitado). |
| `localServerHost` | `0.0.0.0` | Bind LAN (todas las interfaces) |

Prueba manual:

```powershell
$env:DOOR_READER_CONFIG = "C:\ruta\LibroGuardia\scripts\door-reader.config.json"
node C:\ruta\LibroGuardia\scripts\door-reader-bridge.js
```

Al arrancar: `SesiÃ³n kiosk OK`. Al escanear: `Escaneo recibido` â†’ `Resultado kiosk-scan` con `authorized: true/false` y `relayTriggered` / `relayError`.

### Servicio permanente a mano (si no usaste el instalador)

**OpciÃ³n A â€” NSSM**

```powershell
nssm install LibroGuardiaDoorReader "C:\Program Files\nodejs\node.exe" "C:\LG\scripts\door-reader-bridge.js"
nssm set LibroGuardiaDoorReader AppDirectory C:\LG\scripts
nssm set LibroGuardiaDoorReader AppEnvironmentExtra DOOR_READER_CONFIG=C:\LG\scripts\door-reader.config.json
nssm set LibroGuardiaDoorReader Start SERVICE_AUTO_START
nssm start LibroGuardiaDoorReader
```

**OpciÃ³n B â€” Tarea programada** al inicio de sesiÃ³n / arranque, con el mismo `node â€¦door-reader-bridge.js` y variable `DOOR_READER_CONFIG` (ver `install-sr201-bridge-autostart.ps1` como referencia de patrÃ³n).

El proceso reconecta el COM y reintenta la red con backoff; no hace falta reiniciarlo ante un glitch corto.

---

## 4.1 Refrescar config (lector ya instalado + estaciÃ³n nueva)

Caso tÃ­pico: el lector se instalÃ³ con el cÃ³digo de 6 dÃ­gitos **antes** de asignarlo a una estaciÃ³n (ej. Â«PC FrancoÂ»). El JSON de la mini PC **no** tiene `localServerPort` / `localServerSecret`, asÃ­ que el bridge no levanta el HTTP local y el Centro de Control no puede abrir/consultar por LAN sin internet.

**No hace falta reinstalar Node, NSSM ni la carpeta `scripts`.** Se reutiliza el mismo emparejamiento:

1. En Admin â†’ Estaciones: confirmÃ¡ que la estaciÃ³n tiene **IP de red local**, **puerto** (ej. 8787) y **secreto**, y que el lector estÃ¡ **asignado** a esa estaciÃ³n.
2. En Admin â†’ Lectores â†’ ese lector â†’ **Generar cÃ³digo de instalaciÃ³n** (`#`, 6 dÃ­gitos, 10 min, un solo uso).
3. En la mini PC, **como Administrador**, en la misma carpeta `scripts` donde ya estÃ¡ el bridge:
   ```text
   instalar-lector.cmd
   ```
   PegÃ¡ el cÃ³digo nuevo.
4. El instalador:
   - canjea el cÃ³digo (esto **regenera la password** del usuario kiosk â€” la anterior deja de servir; es esperado);
   - reescribe `door-reader.config.json` **incluyendo** `localServerPort` / `localServerSecret` de la estaciÃ³n;
   - reinicia el servicio NSSM (`LibroGuardiaDoor-<doorId>`).
5. VerificaciÃ³n rÃ¡pida:
   - En la consola del instalador deberÃ­a verse algo como `localServerPort=8787  estacion=PC Franco`.
   - En el JSON: `"localServerPort": 8787` y `"localServerSecret": "â€¦"`.
   - Log del servicio: el bridge arranca y escucha el puerto local.
   - Si el COM no es COM3, editÃ¡ `serialPort` en el JSON y `nssm restart LibroGuardiaDoor-<doorId>`.

**Alternativa** (sin regenerar password): Admin â†’ Estaciones â†’ descargar config unificada de la estaciÃ³n, fusionar a mano `localServer*` en el JSON existente, y reiniciar el servicio. El re-emparejamiento es el camino soportado y mÃ¡s simple.

### VersiÃ³n del bridge para fallback LAN del panel (CORS)

El Centro de Control en `https://mss-guard.web.app` llama al HTTP local de la estaciÃ³n (`http://IP:8787/status` y `/open/...`). Eso exige:

1. EstaciÃ³n configurada + `localServer*` en el JSON (arriba).
2. **`door-reader-bridge.js` â‰¥ `1.1.0`** (`localStationApiVersion` â‰¥ **2**): responde **CORS** + **Private Network Access** (`Access-Control-Allow-Origin` del panel, `OPTIONS` preflight, `Access-Control-Allow-Private-Network: true`). Sin esa versiÃ³n el navegador bloquea la respuesta aunque el bridge estÃ© vivo.

CÃ³mo ver la versiÃ³n en la mini PC (con el servicio corriendo y el secreto de la estaciÃ³n):

```powershell
curl.exe -s -H "Authorization: Bearer TU_SECRETO" http://127.0.0.1:8787/status
```

BuscÃ¡ `"bridgeVersion":"1.1.0"` y `"localStationApiVersion":2`.

**Actualizar sin reinstalar de cero:** copiÃ¡ el `door-reader-bridge.js` nuevo a la carpeta `scripts` de la mini PC y reiniciÃ¡ el servicio:

```powershell
nssm restart LibroGuardiaDoor-puerta-p1
```

(No hace falta re-emparejar solo por este cambio de CORS, si el JSON ya tiene `localServerPort` / `localServerSecret`.)

---

## 5. Raspberry Pi (futuro)

Cuando se migre de la PC Windows a Pi por puerta:

- Mismo script; `serialPort` serÃ¡ algo como `/dev/ttyUSB0` o `/dev/serial/by-id/...`.
- Servicio con **systemd** (equivalente al NSSM de Windows).
- El framing y la API no cambian.

---

## DiagnÃ³stico en campo

| SÃ­ntoma | QuÃ© mirar |
|---------|-----------|
| No abre COM | Nombre del puerto; otro programa usando el COM; cable/adaptador |
| Bytes basura | Baud rate (probar 9600); modo serie del GADNIC |
| Login 401/403 | usuario/password; permiso `access.kiosk`; usuario activo |
| Denegado siempre | citaciÃ³n/nÃ³mina; `direction` del reader; `doorId` |
| Autorizado pero no abre | `sr201-bridge` + tÃºnel; `bridgeUrl` en la puerta; host/port/canal |
| Red intermitente | backoff del bridge; no mata el proceso |

Herramienta hermana (disparo directo LAN, **sin** autorizaciÃ³n): `scripts/test-lector-rele.js`.

---

## RelaciÃ³n con docs existentes

- Puente SR201 / tÃºnel: [INSTALACION-SR201.md](./INSTALACION-SR201.md)
- Multi-puertas / API kiosk: [MULTI-PUERTAS.md](./MULTI-PUERTAS.md)
- Checklist molinete: [PRUEBA-MOLINETE.md](./PRUEBA-MOLINETE.md)
