# Si se cae la PC de planta — qué hacer (cliente)

MSS decide quién entra desde la nube. Las puertas físicas las abre un **proceso en una PC de la planta**. Si esa PC se apaga, el molinete/portón deja de responder aunque el panel web siga abierto.

## Cómo te vas a enterar

En **Admin → Equipos de acceso**:

- **Lectores** ya muestran En línea / Sin señal / Desconectado (heartbeat cada ~5 min).
- **Estaciones** muestran la misma conexión (el programa de estación reporta a la nube).
- **Autorizaciones (Citados)** muestra última sync y último heartbeat del puente de carpeta Excel.

Si un puente que **ya había reportado** deja de avisar ~30 minutos, el sistema manda un mail por el mismo SMTP de notificaciones (hay que tener activado el evento **Puente local sin señal**).

## Qué hacer en el momento (operación, no desarrollo)

1. Ir hasta la PC de planta y confirmar que está encendida y con red.
2. Si usa PM2: abrir una terminal y correr `pm2 status`. Los procesos deberían figurar `online`.
3. Si alguno está `errored` o `stopped`: `pm2 restart <nombre>` (los nombres habituales están en la tabla de abajo).
4. Si Windows se reinició y no arrancó solo: `pm2 resurrect` o volver a ejecutar el instalador de arranque (`pm2 startup` / `pm2-startup install` según el runbook técnico).
5. Probar abrir una puerta desde el panel. Si el lector figura En línea y el relé no dispara, el problema ya no es la PC apagada: avisar a soporte.

Apertura manual de emergencia (llave / bypass físico del molinete) queda a criterio de la planta. El software no sustituye ese protocolo.

## Procesos que tienen que estar vivos

| Qué | Proceso actual | Cómo se ve en Admin |
|---|---|---|
| Lectores + relé SR201 en planta | `programa-estacion.js` (PM2) | Equipos → Lectores y Estaciones |
| Citados (Excel/CSV) | `citaciones-folder-bridge.js` (PM2) | Autorizaciones → puente de carpeta |
| BioStar 2 | `programa-biostar.js` (PM2) | Heartbeat en nube (evento mail si se cae) |

El bridge SR201 viejo (`scripts/archivo-viejo/sr201-bridge.js`) quedó archivado: la apertura en planta pasa por la estación.

## Arranque con Windows (técnico)

En la PC de planta, una vez:

```
npm install -g pm2 pm2-windows-startup
pm2-startup install
```

Después de levantar los procesos:

```
pm2 save
```

Sin `pm2 save` + startup, un corte de luz deja la planta muda hasta que alguien inicie sesión.

## Fuera de este documento

Runbooks con PowerShell, túnel Cloudflare y secretos: `docs/INSTALACION-SR201.md`, `docs/CITACIONES-FOLDER-BRIDGE.md`, `docs/ACTUALIZAR-BRIDGE-ESTACION.md`. Eso es para el equipo técnico, no para el encargado de turno.
