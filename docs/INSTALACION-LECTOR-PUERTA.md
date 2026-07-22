# Instalación — lector GADNIC en puerta desatendida

Mini PC headless por puerta + lector GADNIC DNI/QR (USB keyboard-wedge) + relé SR201.

App: Firebase Hosting / Cloud Functions. Este documento es para **puertas sin guardia ni tablet**.

---

## Arquitectura (quién hace qué)

```
GADNIC USB  →  door-reader-bridge.js (mini PC de ESA puerta)
                    │
                    │  HTTPS  POST /api/access/kiosk-scan
                    ▼
              Cloud Functions (autoriza + dispara relé)
                    │
                    │  HTTPS (túnel Cloudflare)
                    ▼
              sr201-bridge.js (UNA PC/servidor de planta)
                    │
                    │  TCP :6722  (host/port de ESA puerta)
                    ▼
              SR201 de la puerta
```

### Un solo bridge SR201 para todas las puertas (recomendado)

Si las puertas nuevas están en la **misma LAN** que el molinete actual:

1. Dejá corriendo **un** `scripts/sr201-bridge.js` + **un** túnel Cloudflare (como hoy).
2. En Admin → Puertas, cada puerta nueva lleva su propio `device.host` / `device.port` / `channel` y el **mismo** `bridgeUrl` / `bridgeSecret`.
3. El driver SR201 envía `host`+`port` en cada pulso; el bridge local ya los acepta (`payload.host` / `payload.port`).

No hace falta un túnel ni un `sr201-bridge` por puerta.

### Sí hace falta un door-reader-bridge por puerta

El GADNIC está enchufado por USB a la mini PC física de esa puerta. Ese proceso solo reenvía lecturas a la API; no habla con el SR201.

---

## Hardware recomendado (por puerta)

| Ítem | Recomendación | Costo aprox. (USD, 2026) |
|------|---------------|---------------------------|
| Mini PC | **Raspberry Pi Zero 2 W** (Wi‑Fi) o **Pi 4 2GB** si preferís Ethernet/cable | Zero 2 W ~15–25 · Pi 4 ~35–55 |
| Alimentación | Fuente oficial 5 V (evitar hubs flojos) | 8–12 |
| Case + microSD | Case simple + microSD 16/32 GB (Raspberry Pi OS Lite 64-bit) | 10–15 |
| Lector | GADNIC DNI/QR USB (modo teclado / keyboard-wedge) | según proveedor |
| Relé | SR201 Ethernet (ya soportado) | según proveedor |

**Por qué Pi Zero 2 W / Pi 4:** barato, Linux estable, comunidad enorme para evdev/USB, bajo consumo 24/7. Si la planta exige Ethernet fijo y no Wi‑Fi, preferí **Pi 4** con cable.

No hace falta pantalla, teclado ni mouse en operación normal.

---

## 1. Configurar la puerta en LibroGuardia

1. Admin → Puertas: crear/editar la puerta (`doorId`, ej. `puerta-entrada`).
2. Device SR201: `host`/`port`/`channel` del relé de esa puerta + el `bridgeUrl` compartido de planta.
3. Lectores con dirección fija (campo `readers` en la config; el panel hoy edita los ids y conserva directions ya guardadas):

```json
"readers": [
  { "id": "lector-in", "direction": "ingreso" },
  { "id": "lector-out", "direction": "egreso" }
]
```

- `ingreso` / `egreso`: el backend **no** infiere el sentido; usa ese `movementType`.
- `ambos` (default): se mantiene la inferencia automática actual.

También podés enviar el objeto completo con `PUT /api/admin/doors-config` (permiso de gestión de puertas).

---

## 2. Usuario de sistema (auth existente)

**Criterio: un usuario por puerta** (no uno compartido para toda la planta).

- Se crea desde Admin → Usuarios como cualquier usuario.
- Rol con permiso **solo** `access.kiosk` (o permisos custom acotados a ese permiso).
- Username sugerido: `kiosk.puerta-entrada`.
- Contraseña fuerte; el bridge la guarda en el JSON local de la mini PC (no en el repo).

Motivo: auditar/revocar una puerta sin afectar las demás; si se compromete una mini PC, el blast radius es menor. Funcionalmente un usuario compartido también funcionaría (mismo permiso), pero no lo recomendamos.

El bridge hace `POST /api/auth/login` y re-loguea ante `401` o JWT vencido (~8 h).

---

## 3. Conectar el GADNIC

1. En Raspberry Pi OS Lite, enchufá el GADNIC por USB.
2. Identificá el device:

```bash
ls -l /dev/input/by-id/
# buscá algo como: usb-...-event-kbd
```

3. Agregá el usuario del servicio al grupo `input`:

```bash
sudo usermod -aG input doorreader
```

4. (Opcional) regla udev permanente si el path `by-id` cambia; en la mayoría de los GADNIC el symlink `by-id` es estable.

5. Probá captura (modo consola del bridge):

```bash
INPUT_MODE=stdin node scripts/door-reader-bridge.js
# o con el device real (ver config)
```

---

## 4. Instalar door-reader-bridge

En la mini PC (Linux):

```bash
# Node 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs git

sudo mkdir -p /opt/libro-guardia
sudo git clone <url-del-repo> /opt/libro-guardia
# o copiá solo scripts/door-reader-bridge.js + el JSON de config

sudo cp /opt/libro-guardia/scripts/door-reader.config.example.json \
        /etc/libro-guardia/door-reader.config.json
sudo nano /etc/libro-guardia/door-reader.config.json
```

Campos mínimos del JSON:

| Campo | Ejemplo |
|-------|---------|
| `apiBaseUrl` | `https://tu-cliente.web.app/api` |
| `username` / `password` | usuario kiosk de esa puerta |
| `doorId` | `puerta-entrada` |
| `readerId` | `lector-in` (debe existir en `readers` de la puerta) |
| `inputDevice` | `/dev/input/by-id/usb-....-event-kbd` |
| `logFile` | `/var/log/door-reader-bridge.log` |

Prueba manual:

```bash
export DOOR_READER_CONFIG=/etc/libro-guardia/door-reader.config.json
node /opt/libro-guardia/scripts/door-reader-bridge.js
```

Escaneá un DNI/QR: en el log deberías ver `authorized` / `denegado` y si el relé se disparó (`relayTriggered`).

---

## 5. systemd (sobrevive reinicios)

`/etc/systemd/system/door-reader-bridge.service`:

```ini
[Unit]
Description=LibroGuardia door reader bridge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=doorreader
Group=input
Environment=DOOR_READER_CONFIG=/etc/libro-guardia/door-reader.config.json
ExecStart=/usr/bin/node /opt/libro-guardia/scripts/door-reader-bridge.js
Restart=always
RestartSec=5
Nice=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo useradd -r -s /usr/sbin/nologin -G input doorreader
sudo mkdir -p /var/log
sudo touch /var/log/door-reader-bridge.log
sudo chown doorreader:doorreader /var/log/door-reader-bridge.log
sudo systemctl daemon-reload
sudo systemctl enable --now door-reader-bridge
sudo journalctl -u door-reader-bridge -f
```

---

## Diagnóstico en campo

| Síntoma | Qué mirar |
|---------|-----------|
| No hay eventos al escanear | `inputDevice`, grupo `input`, `ls -l /dev/input/by-id` |
| Login 401/403 | usuario/password; permiso `access.kiosk`; usuario activo |
| Denegado siempre | citación/nómina; `direction` del reader; doorId correcto |
| Autorizado pero no abre | `sr201-bridge` + túnel; host/port de esa puerta; canal |
| Red intermitente | el bridge reintenta con backoff; no pierde el proceso |

Logs: consola de systemd y/o `logFile` del config.

---

## Relación con docs existentes

- Puente SR201 / túnel: [INSTALACION-SR201.md](./INSTALACION-SR201.md)
- Checklist cliente nuevo: [INSTALL-CLIENTE-NUEVO.md](../INSTALL-CLIENTE-NUEVO.md)
