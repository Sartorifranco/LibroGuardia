# Instalación SR201 — Placa relé Ethernet (2 canales)

Producto: [SR201 Integra](https://productosintegra.com/producto/placa-rele-ethernet-ip-2-canales-sr201-interruptor-lan-iot/)  
App: https://bacarguard.web.app

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

La app en Firebase **no puede** hablar TCP directo con el SR201 en la LAN. Se usa un **puente local** en una PC de planta.

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

## Puente local (obligatorio para producción)

En una PC/servidor **siempre encendido** en planta:

```powershell
cd C:\Users\Admin\Desktop\LG\scripts
$env:SR201_HOST="192.168.0.50"
$env:SR201_PORT="6722"
$env:BRIDGE_PORT="5022"
$env:BRIDGE_SECRET="una-clave-secreta-larga"
node sr201-bridge.js
```

Verificar:

```powershell
Invoke-RestMethod http://127.0.0.1:5022/health
```

Dejar corriendo con PM2, servicio Windows o tarea programada al inicio.

---

## Configuración en Admin

**Panel admin → Control SR201**

| Campo | Ejemplo |
|-------|---------|
| Habilitar apertura automática | ✓ (para molinete autorizado) |
| IP SR201 | 192.168.0.50 (solo si no usa puente) |
| URL puente | `http://192.168.0.9:5022` |
| Secreto puente | misma clave que `BRIDGE_SECRET` |
| Canal | 1 |
| Modo pulso | Jog o Temporizado 3 s |

1. Guardar configuración.
2. **Probar relevador** (admin) — debe hacer clic físico en el relé.
3. Probar molinete con DNI autorizado.

---

## Botón «Abrir puerta» (guardia)

- Visible **siempre** en la barra superior y en pantalla molinete.
- **No depende** de si la persona está autorizada.
- **Sí depende** de que el SR201/puente esté configurado.
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

## Checklist puesta en marcha

- [ ] SR201 en red con IP fija
- [ ] Pulso `11*` funciona desde PC en planta
- [ ] Puente `sr201-bridge.js` activo 24/7
- [ ] Admin: URL puente + secreto guardados
- [ ] Probar relevador desde admin OK
- [ ] Molinete: autorizado abre puerta
- [ ] Botón guardia abre puerta
- [ ] Cable relé → molinete verificado en planta

Fecha: ___________  
Responsable: ___________
