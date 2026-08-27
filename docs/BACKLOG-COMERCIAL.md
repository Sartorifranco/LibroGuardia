# Backlog comercial y operativo

Complementa el backlog de preparación de MSS para el primer cliente externo.
Los hallazgos de producción se registran separados del cambio técnico durante
el cual aparecieron, para no mezclar causa, alcance ni historial.

## Prioridad Alta

### 4.11 — Citados sin sincronizar en Bacar desde 24/07 — causa no confirmada

**Estado:** bloqueado por confirmación operativa con Bacar.

**Evidencia al 26/08/2026:**

- `GET /api/bridge/citaciones/health` informa como última sincronización
  `2026-07-24T16:56:21.008Z`.
- El último archivo informado es `Citaciones_2026_07_26.csv` (13 registros,
  sin error reportado).
- En la PC inspeccionada (`SIS5`) no hay proceso PM2, proceso Node, servicio de
  Windows ni tarea programada ejecutando el puente de Citados.
- Existe una configuración local bajo `scripts/archivo-viejo/`, pero esa
  carpeta está marcada explícitamente como no operativa. Esto no prueba qué
  archivo se ejecutó en la PC de Transporte.

**Riesgo:** no está confirmado que el listado de personal esperado se esté
alimentando hoy en el único cliente productivo. No ofrecerlo como flujo
operativo validado a un cliente nuevo hasta cerrar la causa.

**Confirmación pendiente con Bacar:**

1. Identificar si Transporte usa otra PC.
2. Obtener la ruta exacta del proceso que ejecuta el puente (PM2, servicio o
   tarea programada).
3. Confirmar si el proceso se cayó o si Transporte abandonó/cambió el flujo.
4. Si existe código desplegado fuera del repo, incorporarlo y versionarlo antes
   de reactivar.

**Criterio de cierre:** causa documentada, proceso vigente versionado en
`scripts/`, servicio con arranque automático y una sincronización real
verificada desde Bacar.

### 4.13 — Firma HMAC en el puente SR-201 (`/pulse`) — replay attack en LAN de garita

**Estado:** pendiente, sin empezar. Detectado en análisis técnico externo del
repo, verificado contra el código real antes de sumarlo.

**Problema:** el endpoint HTTP local del puente (`scripts/programa-apertura-internet.js`,
que escucha en la garita y despacha comandos TCP a la placa de relé SR-201,
puerto 6722) no valida firma criptográfica en las peticiones que recibe. Un
dispositivo en la misma red LAN de la garita podría capturar y reenviar
(replay) una petición válida de apertura sin pasar por la autorización real.

**Riesgo:** es un riesgo de seguridad física, no solo de datos — el puente
controla la apertura de molinetes/barreras. Para un sistema de control de
accesos, este es el tipo de hallazgo que conviene cerrar antes de escalar a
más clientes, no después.

**Alcance sugerido (a confirmar antes de codear):** firma HMAC-SHA256 con
timestamp en las peticiones Cloud → puente (`/pulse`), rechazando peticiones
fuera de una ventana de tiempo corta y firmas repetidas. No implica agregar
infraestructura nueva ni servicios pagos.

**Criterio de cierre:** el puente rechaza peticiones sin firma válida o con
timestamp fuera de ventana; test que confirme el rechazo de un replay; no
afecta la apertura legítima en el flujo normal (medir latencia antes/después,
el SLA de apertura no puede degradarse).

## Prioridad Media

### 4.10 — Completar `GET /estaciones/runtime-config`

`programa-estacion.js` consulta este endpoint para hot-reload. El 404 no
bloquea el arranque: los lectores ya se levantan desde el JSON local, el error
solo se registra como `Sync de estación diferido` y se reintenta cada 45 s.

Implementarlo en un cambio separado de heartbeat/4.2.

### 4.12 — Reactivación de personas dadas de baja (nómina vs. `people.js`)

**Estado:** pendiente. Hallazgo de la auditoría 4.4; no mezclar con los tests
de regresión de bugs ya corregidos.

**Problema:** hay dos caminos de alta/actualización de personas:

- El job de import de nómina (`resolvePersonCached` / `findPeopleDoc` en
  `nominaImport.js`) encuentra fichas **aunque estén inactivas**. Si reaparece
  un legajo dado de baja, el job puede actualizar el documento y dejarlo
  inactivo.
- `people.js` (`findPersonDoc` / `resolveOrCreatePerson`) filtra
  `active == true`. Un alta por citaciones u otro flujo que use ese camino
  **no ve** la ficha inactiva y puede crear un duplicado.

No es el patrón típico de Bacar (poca rotación de bajas/altas repetidas),
pero sí hay que resolverlo antes de instalar en un cliente cuya nómina se
mueva más.

**Criterio de cierre:** un empleado que vuelve a la nómina con el mismo
legajo o DNI reactiva la ficha existente (sin duplicar) en ambos caminos, con
test de regresión que falle si se vuelve a filtrar solo activos o a dejar
`active: false` en el reimport.

### 4.14 — Watchdog en daemons de garita (`programa-apertura-internet.js`, `programa-biostar.js`)

**Estado:** pendiente, sin empezar. Detectado en análisis técnico externo del
repo, verificado contra el código real antes de sumarlo.

**Problema:** los daemons que corren en la PC de garita (puente SR-201 y
puente BioStar 2) son procesos Node sueltos, sin supervisión. Si el proceso
se cae, no hay reinicio automático ni aviso — es el mismo patrón que causó
4.11 (Citados sin sincronizar durante un mes sin que nadie lo notara), pero
a nivel del daemon en sí, no solo del dato que deja de llegar.

**Relación con 4.2 (heartbeat, ya en main):** el heartbeat avisa por mail
cuando un puente deja de reportar, pero no reinicia nada — solo informa.
Este ítem es el complemento: que el proceso se recupere solo, no solo que se
avise que está caído.

**Alcance sugerido (a confirmar antes de codear):** envolver los daemons con
un supervisor de proceso (ejemplo: PM2 con `--restart` o el propio Servicio
de Windows con recuperación automática configurada), sin cambiar la lógica
interna de los puentes.

**Criterio de cierre:** matar el proceso manualmente en un entorno de prueba
y confirmar que se reinicia solo en menos de X segundos, sin intervención
manual; documentar el comando/servicio de supervisión en
`docs/RUNBOOK-INSTALACION.md` (no en el checklist que ve el cliente).
