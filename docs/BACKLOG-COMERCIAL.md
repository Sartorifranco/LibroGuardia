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

### 4.15 — Aviso al asignar un permiso técnico a un rol

**Estado:** pendiente, sin empezar. Detectado en análisis técnico externo del
repo, verificado contra el código real antes de sumarlo.

**Problema:** `frontend-libro-guardia/src/utils/permissions.js` ya define
`TECHNICAL_PERMISSIONS` (incluye `access.doors.manage`, `settings.permissions`,
`roles.manage`), pero esa lista no se usa en ninguna pantalla. Hoy, al tildar
un permiso en Roles (`RolesAdminPanel.js`), no hay ninguna distinción visual
entre un permiso simple (por ejemplo, ver reportes) y uno que le abre a esa
persona una pantalla técnica de configuración de hardware (IP de placa,
canal, tokens de equipos).

**Riesgo:** si se le da un rol con `access.doors.manage` a alguien no técnico
del lado del cliente, esa persona termina frente a una pantalla de
configuración de hardware sin ningún aviso de que está entrando a un terreno
distinto del resto del sistema.

**Alcance sugerido (a confirmar antes de codear):** al lado de cada permiso
marcado en `TECHNICAL_PERMISSIONS`, un ícono o etiqueta corta ("técnico") con
un tooltip breve explicando qué implica. Sin bloquear la asignación — solo
avisar antes de guardar.

**Criterio de cierre:** un permiso técnico se distingue visualmente en la
pantalla de Roles; test que confirme que `TECHNICAL_PERMISSIONS` efectivamente
se usa en el render, no solo que exista la constante.

### 4.16 — Confirmaciones inconsistentes en Puertas (diálogo nativo vs. modal propio)

**Estado:** pendiente, sin empezar. Detectado en análisis técnico externo del
repo, verificado contra el código real antes de sumarlo.

**Problema:** `DoorsAdminPanel.js` usa `window.confirm()` (el cuadro nativo y
gris del navegador) para confirmar borrado o descarte de cambios. Las
pantallas de Estaciones y Lectores usan en cambio el modal propio de la app
(`useConfirm()` de `ConfirmContext`), con el mismo diseño que el resto del
sistema.

**Riesgo:** ninguno funcional — es una inconsistencia visual. El usuario ve
un cuadro de confirmación distinto (feo, del navegador) justo en la pantalla
más técnica del sistema, mientras el resto usa el modal propio.

**Alcance sugerido:** reemplazar los tres usos de `window.confirm()` en
`DoorsAdminPanel.js` por `useConfirm()`, igual que en Estaciones y Lectores.
No cambia ningún comportamiento, solo el componente visual.

**Criterio de cierre:** las tres confirmaciones (eliminar puerta, descartar
cambios de una puerta, descartar cambios al crear otra) usan el modal propio
de la app; tests existentes de `DoorsAdminPanel` siguen en verde.

### 4.17 — Sin indicador de carga en Puertas

**Estado:** pendiente, sin empezar. Detectado en análisis técnico externo del
repo, verificado contra el código real antes de sumarlo.

**Problema:** `DoorsAdminPanel.js` no muestra ningún indicador mientras trae
la configuración inicial (puertas, conexión a planta). En una conexión lenta,
la pantalla puede parecer trabada unos segundos. Estaciones y Lectores sí
muestran un indicador de carga.

**Alcance sugerido:** agregar el mismo patrón de loading que ya usan
Estaciones/Lectores (mismo componente, sin inventar uno nuevo).

**Criterio de cierre:** al entrar a Puertas con red lenta simulada, se ve un
indicador de carga hasta que llegan los datos, igual que en Estaciones.

### 4.18 — Buscador en el listado de puertas

**Estado:** pendiente, sin empezar. Detectado en análisis técnico externo del
repo, verificado contra el código real antes de sumarlo.

**Problema:** el listado de puertas no tiene buscador ni filtro. Con las ~20
puertas previstas para el próximo cliente, encontrar una puntual implica
desplazarse por toda la lista. No es grave a esa escala, pero conviene
resolverlo antes de que un cliente con más puertas lo sienta como fricción
real.

**Alcance sugerido:** campo de búsqueda simple por nombre/código de puerta,
mismo patrón visual que el resto del panel. No requiere backend nuevo, es
filtro sobre los datos ya cargados en el frontend.

**Criterio de cierre:** escribir en el buscador filtra el listado en tiempo
real por nombre o código; no afecta el guardado ni la edición de puertas.

### 4.19 — Rama `feat/hardware-auto-detect-v1` sin mergear — decidir destino

**Estado:** hallazgo, sin decidir. Código funcional (auto-detección de
marca de hardware vía LAN), 2 commits del 18/08, basada en un main
anterior a heartbeat/HMAC/GPS actuales. No pasó por el proceso de
diseño→aprobación. No se mergea ni se borra hasta que Franco decida
si esa feature sigue en el roadmap.

**Riesgo:** ninguno mientras quede sin tocar en el remoto.

**Alcance sugerido:** ninguno todavía — es una decisión de negocio, no
técnica.

**Criterio de cierre:** decisión explícita (retomar con diseño nuevo, o
borrar la rama).
