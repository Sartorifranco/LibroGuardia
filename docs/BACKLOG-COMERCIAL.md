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
