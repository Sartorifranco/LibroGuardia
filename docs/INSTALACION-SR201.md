# InstalaciÃ³n SR201 â€” Placa relÃ© Ethernet (2 canales)

Producto: [SR201 Integra](https://productosintegra.com/producto/placa-rele-ethernet-ip-2-canales-sr201-interruptor-lan-iot/)  
App: https://mss-guard.web.app

---

## Pendiente de probar en sitio cuando llegue el hardware

> Checklist **Ãºnico** de verificaciÃ³n fÃ­sica. No tildar hasta probar en planta.
> El cÃ³digo/tÃºnel puede estar listo; el pulso real **no estÃ¡ verificado** desde esta mÃ¡quina de desarrollo.

- [ ] Probar **"Probar relevador"** desde producciÃ³n (Firebase) y confirmar que abre la puerta fÃ­sica.
- [ ] Confirmar latencia aceptable del pulso a travÃ©s del tÃºnel.
- [ ] Confirmar comportamiento si el tÃºnel se cae (mensaje de error claro en el panel de puertas, no un error genÃ©rico).
- [ ] Apagar el backend Node/Mongo en planta si aÃºn corre (`pm2 stop/delete bacarguard-api` â€” ver `docs/MIGRACION-BACKEND.md` Â§13). *Independiente del pulso SR201: los datos Mongo ya estÃ¡n descartados; el apagado del proceso es una confirmaciÃ³n operativa.*

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
| Acceso desde Firebase | **Cloudflare Tunnel** (recomendado) â†’ URL pÃºblica HTTPS + secreto |

La app en Firebase **no puede** hablar TCP directo con el SR201 en la LAN. Flujo:

```
Firebase Functions  â†’  HTTPS (tÃºnel)  â†’  sr201-bridge.js (PC planta)  â†’  TCP:6722  â†’  SR201
```

---

## Cableado

1. AlimentaciÃ³n 5 V al SR201 (segÃºn manual del fabricante).
2. Ethernet a switch de la red de planta.
3. **Canal 1 (COM/NO/NC)** â†’ entrada del molinete / cerradura electromagnÃ©tica.
4. Verificar con multÃ­metro o LED del relÃ© antes de conectar alto voltaje.

---

## Red del SR201

1. Conectar el SR201 y acceder desde una PC en la misma red.
2. IP recomendada fija, ej. `192.168.0.50` (ajustar segÃºn su red).
3. Probar desde CMD/PowerShell en planta:

```powershell
Test-NetConnection 192.168.0.50 -Port 6722
```

4. Pulso de prueba con telnet o netcat (desde PC en planta):

```
11*
```

(debe activar el relÃ© canal 1 un instante)

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

## TÃºnel Cloudflare (exponer el puente a Firebase de forma segura)

Firebase Functions estÃ¡ en internet; el bridge escucha solo en LAN. Opciones:

1. **Cloudflare Tunnel** (recomendado): HTTPS pÃºblico â†’ `http://127.0.0.1:5022` sin abrir puertos en el router.
2. Alternativa: VPN sitio-a-sitio / IP pÃºblica con firewall estricto (no documentada aquÃ­).

### 1) Instalar `cloudflared` en la PC de planta

1. Crear cuenta en Cloudflare y un tÃºnel (Zero Trust â†’ Networks â†’ Tunnels).
2. Instalar el agente Windows segÃºn el asistente (o [descargas cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)).
3. Configurar un **Public Hostname** del tÃºnel, por ejemplo:
   - Hostname: `sr201-bacar.tudominio.com`
   - Service: `http://127.0.0.1:5022`
4. Dejar el servicio `cloudflared` corriendo al inicio de Windows.

### 2) AutenticaciÃ³n (obligatoria)

El tÃºnel da alcance de red; **no alcanza**. El bridge ya protege `/pulse` con `BRIDGE_SECRET`:

- Mismo valor en la variable de entorno del bridge y en **Admin â†’ Puertas â†’ Secreto puente**.
- Opcional extra en Cloudflare: Access policy (email/one-time pin) delante del hostname; si se usa, hay que adaptar las Functions (hoy hablan con Bearer del bridge, no con Cloudflare Access).

### 3) Configurar `bridgeUrl` en Admin

**Panel admin â†’ Puertas / Control SR201**

| Campo | Ejemplo |
|-------|---------|
| URL puente | `https://sr201-bacar.tudominio.com` |
| Secreto puente | misma clave que `BRIDGE_SECRET` |
| Canal | 1 |
| Modo pulso | Jog o Temporizado 3 s |

Guardar. No uses `http://192.168.x.x:5022` desde producciÃ³n salvo que Functions pueda alcanzar esa LAN (normalmente **no**).

### 4) Verificar conectividad **sin** pulsar el relÃ© fÃ­sico

Desde cualquier PC con internet (o desde la consola del navegador logueada como admin):

```powershell
# Health del bridge a travÃ©s del tÃºnel (sin opener el relÃ©)
Invoke-RestMethod https://sr201-bacar.tudominio.com/health
```

Esperado: JSON con `"ok": true` / servicio `sr201-bridge`.

Si falla:

| SÃ­ntoma | Causa probable |
|---------|----------------|
| Timeout / DNS | TÃºnel caÃ­do o hostname mal apuntado |
| 502/1033 Cloudflare | `cloudflared` no estÃ¡ corriendo o service URL incorrecta |
| Health OK pero pulso 401 | `BRIDGE_SECRET` distinto entre Admin y bridge |

Cuando el tÃºnel estÃ¡ caÃ­do, la app debe mostrar un mensaje del estilo *"No se pudo contactar el puente SR201â€¦ RevisÃ¡ que el tÃºnel (Cloudflare) y el puente local estÃ©n activos."* (no un 500 opaco).

---

## ConfiguraciÃ³n en Admin (resumen)

| Campo | Ejemplo LAN (solo prueba local) | Ejemplo producciÃ³n |
|-------|----------------------------------|--------------------|
| URL puente | `http://192.168.0.9:5022` | `https://sr201-bacar.tudominio.com` |
| Secreto | `BRIDGE_SECRET` | mismo |
| IP SR201 | solo si no usa puente | vacÃ­o / irrelevante |

1. Guardar configuraciÃ³n.
2. Health vÃ­a tÃºnel OK.
3. **Probar relevador** (admin) â€” ver checklist pendiente arriba.
4. Probar molinete con DNI autorizado.

---

## BotÃ³n Â«Abrir puertaÂ» (guardia)

- Visible **siempre** en la barra superior y en pantalla molinete.
- **No depende** de si la persona estÃ¡ autorizada.
- **SÃ­ depende** de que el SR201/puente/tÃºnel estÃ©n configurados.
- Queda registrado en Firestore `accessEvents` como `manual_open`.
- Cooldown 3 s entre pulsos (anti doble-click).

---

## Flujos de apertura

| Origen | Â¿Abre puerta? | CondiciÃ³n |
|--------|---------------|-----------|
| Molinete â€” escaneo autorizado | SÃ­ | `enabled` + relevador OK |
| Molinete â€” denegado | No | â€” |
| Ingreso excepcional | SÃ­ | Con motivo + permiso |
| Registro manual con override | SÃ­ | Checkbox override |
| **BotÃ³n Abrir puerta** | **SÃ­** | Siempre (guardia) |
| Admin â€” Probar relevador | SÃ­ | Solo diagnÃ³stico |

---

## Checklist puesta en marcha (software)

- [ ] SR201 en red con IP fija
- [ ] Pulso `11*` funciona desde PC en planta
- [ ] Puente `sr201-bridge.js` activo 24/7
- [ ] Cloudflare Tunnel (u equivalente) apuntando a `127.0.0.1:5022`
- [ ] `GET /health` OK a travÃ©s del hostname pÃºblico
- [ ] Admin: URL puente HTTPS + secreto guardados
- [ ] (Hardware) Ã­tems de la secciÃ³n superior **Pendiente de probar en sitio**

Fecha: ___________  
Responsable: ___________
