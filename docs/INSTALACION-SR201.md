# Instalación SR201 — Placa relé Ethernet (2 canales)

Producto: [SR201 Integra](https://productosintegra.com/producto/placa-rele-ethernet-ip-2-canales-sr201-interruptor-lan-iot/)  
App: https://bacarguard.web.app

---

## Pendiente de probar en sitio cuando llegue el hardware

> Checklist **único** de verificación física. No tildar hasta probar en planta.
> El código/túnel puede estar listo; el pulso real **no está verificado** desde esta máquina de desarrollo.

- [ ] Probar **"Probar relevador"** desde producción (Firebase) y confirmar que abre la puerta física.
- [ ] Confirmar latencia aceptable del pulso a través del túnel.
- [ ] Confirmar comportamiento si el túnel se cae (mensaje de error claro en el panel de puertas, no un error genérico).
- [ ] Apagar el backend Node/Mongo en planta si aún corre (`pm2 stop/delete bacarguard-api` — ver `docs/MIGRACION-BACKEND.md` §13). *Independiente del pulso SR201: los datos Mongo ya están descartados; el apagado del proceso es una confirmación operativa.*

### Servicios locales a mantener (no se retiran con Node/Mongo)

| Servicio | Docs |
|----------|------|
| Este bridge SR201 | este documento |
| Puente citaciones Excel (**en uso**) | [CITACIONES-FOLDER-BRIDGE.md](./CITACIONES-FOLDER-BRIDGE.md) |

---

## Resumen

| Item | Valor |
|------|--------|
| Control TCP | Puerto **6722** |
| Config TCP | Puerto **5111** |
| Canales | 2 (usamos canal **1** = molinete) |
| Comando pulso jog | `11*` (canal 1, ~0,5 s) |
| Comando pulso timed | `11:03` (canal 1, 3 s) |
| IP factory default | 192.168.1.100 |
| Puente local HTTP | Puerto **5022** + `BRIDGE_SECRET` |
| Acceso desde Firebase | **Cloudflare Tunnel** (recomendado) → URL pública HTTPS + secreto |

La app en Firebase **no puede** hablar TCP directo con el SR201 en la LAN. Flujo:

```
Firebase Functions  →  HTTPS (túnel)  →  sr201-bridge.js (PC planta)  →  TCP:6722  →  SR201
```

---

## Cableado

1. Alimentación 5 V al SR201 (según manual del fabricante).
2. Ethernet a switch de la red de planta.
3. **Canal 1 (COM/NO/NC)** → entrada del molinete / cerradura electromagnética.
4. Verificar con multímetro o LED del relé antes de conectar alto voltaje.

---

## Red del SR201

1. Conectar el SR201 y acceder desde una PC en la misma red.
2. IP recomendada fija, ej. `192.168.0.50` (ajustar según su red).
3. Probar desde CMD/PowerShell en planta:

```powershell
Test-NetConnection 192.168.0.50 -Port 6722
```

4. Pulso de prueba con telnet o netcat (desde PC en planta):

```
11*
```

(debe activar el relé canal 1 un instante)

---

## Puente local (obligatorio)

En una PC/servidor **siempre encendido** en planta:

```powershell
cd C:\LG\scripts
$env:SR201_HOST="192.168.0.50"
$env:SR201_PORT="6722"
$env:BRIDGE_PORT="5022"
$env:BRIDGE_SECRET="una-clave-secreta-larga"
node sr201-bridge.js
```

Verificar **en la misma PC**:

```powershell
Invoke-RestMethod http://127.0.0.1:5022/health
```

Dejar corriendo con PM2 / servicio Windows. El puente exige `Authorization: Bearer <BRIDGE_SECRET>` en `/pulse` si configuraste secreto.

---

## Túnel Cloudflare (exponer el puente a Firebase de forma segura)

Firebase Functions está en internet; el bridge escucha solo en LAN. Opciones:

1. **Cloudflare Tunnel** (recomendado): HTTPS público → `http://127.0.0.1:5022` sin abrir puertos en el router.
2. Alternativa: VPN sitio-a-sitio / IP pública con firewall estricto (no documentada aquí).

### 1) Instalar `cloudflared` en la PC de planta

1. Crear cuenta en Cloudflare y un túnel (Zero Trust → Networks → Tunnels).
2. Instalar el agente Windows según el asistente (o [descargas cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)).
3. Configurar un **Public Hostname** del túnel, por ejemplo:
   - Hostname: `sr201-bacar.tudominio.com`
   - Service: `http://127.0.0.1:5022`
4. Dejar el servicio `cloudflared` corriendo al inicio de Windows.

### 2) Autenticación (obligatoria)

El túnel da alcance de red; **no alcanza**. El bridge ya protege `/pulse` con `BRIDGE_SECRET`:

- Mismo valor en la variable de entorno del bridge y en **Admin → Puertas → Secreto puente**.
- Opcional extra en Cloudflare: Access policy (email/one-time pin) delante del hostname; si se usa, hay que adaptar las Functions (hoy hablan con Bearer del bridge, no con Cloudflare Access).

### 3) Configurar `bridgeUrl` en Admin

**Panel admin → Puertas / Control SR201**

| Campo | Ejemplo |
|-------|---------|
| URL puente | `https://sr201-bacar.tudominio.com` |
| Secreto puente | misma clave que `BRIDGE_SECRET` |
| Canal | 1 |
| Modo pulso | Jog o Temporizado 3 s |

Guardar. No uses `http://192.168.x.x:5022` desde producción salvo que Functions pueda alcanzar esa LAN (normalmente **no**).

### 4) Verificar conectividad **sin** pulsar el relé físico

Desde cualquier PC con internet (o desde la consola del navegador logueada como admin):

```powershell
# Health del bridge a través del túnel (sin opener el relé)
Invoke-RestMethod https://sr201-bacar.tudominio.com/health
```

Esperado: JSON con `"ok": true` / servicio `sr201-bridge`.

Si falla:

| Síntoma | Causa probable |
|---------|----------------|
| Timeout / DNS | Túnel caído o hostname mal apuntado |
| 502/1033 Cloudflare | `cloudflared` no está corriendo o service URL incorrecta |
| Health OK pero pulso 401 | `BRIDGE_SECRET` distinto entre Admin y bridge |

Cuando el túnel está caído, la app debe mostrar un mensaje del estilo *"No se pudo contactar el puente SR201… Revisá que el túnel (Cloudflare) y el puente local estén activos."* (no un 500 opaco).

---

## Configuración en Admin (resumen)

| Campo | Ejemplo LAN (solo prueba local) | Ejemplo producción |
|-------|----------------------------------|--------------------|
| URL puente | `http://192.168.0.9:5022` | `https://sr201-bacar.tudominio.com` |
| Secreto | `BRIDGE_SECRET` | mismo |
| IP SR201 | solo si no usa puente | vacío / irrelevante |

1. Guardar configuración.
2. Health vía túnel OK.
3. **Probar relevador** (admin) — ver checklist pendiente arriba.
4. Probar molinete con DNI autorizado.

---

## Botón «Abrir puerta» (guardia)

- Visible **siempre** en la barra superior y en pantalla molinete.
- **No depende** de si la persona está autorizada.
- **Sí depende** de que el SR201/puente/túnel estén configurados.
- Queda registrado en Firestore `accessEvents` como `manual_open`.
- Cooldown 3 s entre pulsos (anti doble-click).

---

## Flujos de apertura

| Origen | ¿Abre puerta? | Condición |
|--------|---------------|-----------|
| Molinete — escaneo autorizado | Sí | `enabled` + relevador OK |
| Molinete — denegado | No | — |
| Ingreso excepcional | Sí | Con motivo + permiso |
| Registro manual con override | Sí | Checkbox override |
| **Botón Abrir puerta** | **Sí** | Siempre (guardia) |
| Admin — Probar relevador | Sí | Solo diagnóstico |

---

## Checklist puesta en marcha (software)

- [ ] SR201 en red con IP fija
- [ ] Pulso `11*` funciona desde PC en planta
- [ ] Puente `sr201-bridge.js` activo 24/7
- [ ] Cloudflare Tunnel (u equivalente) apuntando a `127.0.0.1:5022`
- [ ] `GET /health` OK a través del hostname público
- [ ] Admin: URL puente HTTPS + secreto guardados
- [ ] (Hardware) ítems de la sección superior **Pendiente de probar en sitio**

Fecha: ___________  
Responsable: ___________
