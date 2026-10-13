# Paridad: reglas actuales → motor `accessEngine`

Base: `integracion/revision-2026-10` (d03ae53). Columnas: regla actual (archivo:línea) → dónde vive en el motor → nota.
El motor no reemplaza nada todavía: T10 convierte las funciones actuales en adaptadores sobre el snapshot.

## Identidad y persona

| Regla actual | Motor | Nota |
|---|---|---|
| DNI normalizado `replace(/\D/g,'')` — `lib/normalize.js:6` | `snapshotSchema.normalizeCredentialValue('dni')` | Copia exacta (no quita ceros). Se hashea `sha256("dni:<dígitos>")`. |
| DNI compartido por varias personas activas → `dni_duplicado` — `accessControl.js:308` | `decide.js` paso 1 (`findCredential` → `status:'duplicate'`) | Igual. |
| Persona no encontrada → `no_encontrado` — `accessControl.js:315` | Paso 1: credencial sin fila → `credencial_desconocida`; credencial cuya persona no está en el snapshot → `no_encontrado` | **Diferencia**: hoy "no encontrado" cubre ambos casos. |
| `active === false` → `persona_inactiva` — `accessControl.js:318` | Paso 2 (`status !== 'active'` o revocación `ch:<id>`) | Igual. |
| Visita bloqueada si persona inactiva o DNI duplicado — `accessControl.js:404` | Paso 1/2 cortan antes de evaluar pases | Igual. |
| Nómina no revive bajas/no encontrados/duplicados — `lib/accessNominaMessages.js:190-207` | No hay override: el turno es una restricción más dentro de derechos | Equivalente (la nómina nunca puede convertir un rechazo de identidad en acceso). |

## Derechos

| Regla actual | Motor | Nota |
|---|---|---|
| `allowedDoorIds` null/[] = ninguna, lista = solo esas — `lib/doorAccess.js:12-27` | Puertas directas (`cardholder.doors` / `allowedDoorIds` legado → filas `direct` 24x7); sin filas → `puerta_no_autorizada` | Igual. |
| Restricción de puerta solo en ingreso — `lib/doorAccess.js:32-54`, `accessControl.js:456`, `accessControl.js:925` | `sides.out.requireRights` (default false) → `egreso_libre` | Igual por defecto; configurable por lado. |
| Permanente con `daysOfWeek`/`timeWindow`, tolerancia 15 — `lib/accessValidation.js:3,16-26` | Schedule `sch_auto_<hash>` (T2/T10) con `toleranceBeforeMin/AfterMin=15`, `schedule.js:evaluateSchedule` | Igual. Fuera de horario → `fuera_de_horario` (antes caía a `sin_citacion_para_hoy`). |
| Ventana horaria sin cruce de medianoche — `lib/normalize.js:73-84` | `schedule.js` soporta `to <= from` (22:00–06:00) y tolerancias que cruzan medianoche | **Mejora**: hoy una ventana nocturna nunca valida. |
| Citación válida si `appointmentDate === hoy`; ventana no estricta (`STRICT_TIME_WINDOW_CITACION=false`) — `lib/accessValidation.js:4,28-41` | Grant `source:'citacion'`; `policy.citacionWindowStrict=false` → todo el día local con aviso `citacion_fuera_de_horario` | Igual. |
| Visita/temporal por rango de fechas — `lib/accessValidation.js:43-48` | Grant `temporal`/`visita` con `from/to` exactos (el compilador pone 00:00–23:59:59) | Fuera de rango → `fuera_de_vigencia` / `visita_fuera_de_ventana` / `visita_antes_de_ventana`. |
| Prioridad permanente > citación > rango — `lib/accessValidation.js:6-12,50-58` | `decide.js SOURCE_ORDER` (accessAll > grupo > directa > citación > temporal > visita > pase) | Igual; solo afecta `matched`. |
| Autorización de otra persona descartada — `accessControl.js:357-371` | Los grants están indexados por `cardholderId` en el snapshot | Estructural. |
| Fallback legacy por DNI/nombre — `accessControl.js:348` | No existe | **Diferencia intencional**: el compilador resuelve identidad una vez (T2); el motor no busca por nombre. |
| Autorización trae su propia `allowedDoorIds` — `accessControl.js:394` | `grant.doors` (lista o `'*'`) | Igual. |
| Credencial sin persona con `authorization` — `accessControl.js:831` | No soportado | Las credenciales siempre apuntan a un `cardholderId` (T10 debe migrarlas). |
| `accessAll` (D7) | `cardholder.accessAll` (no se materializa; incluye puertas futuras) | Nuevo. |

## Nómina (turno, citación obligatoria, Sistemas)

| Regla actual | Motor | Nota |
|---|---|---|
| Turno con tolerancia 30 antes / 15 después — `lib/accessNominaMessages.js:15-16,154-169` | `cardholder.shiftScheduleId` → schedule con `toleranceBeforeMin=30, toleranceAfterMin=15` | Igual. Se exige además del horario del derecho estático. |
| `fuera_dia_turno` / `sin_turno` / `fuera_horario_turno` — `lib/accessNominaMessages.js:288-303,166` | `SHIFT_REASON` en `decide.js` (`fuera_dia`/`sin_intervalos`/`fuera_horario`) | Mismos códigos. |
| Área con citación obligatoria: sin citación hoy → `sin_citacion_hoy` — `lib/accessNominaMessages.js:276-286` | `requiresGrant=true` → `sin_citacion_para_hoy` | **Código unificado** en `sin_citacion_para_hoy` (el mensaje con "próxima citación" queda para la UI/adaptador). |
| Área con citación obligatoria: ventana de la citación con tolerancia 30/15 — `lib/accessNominaMessages.js:131-152,249-257` | Grant de citación siempre estricto si `requiresGrant` (T2 debe poner `from/to` ya con tolerancia) | Igual. |
| Citación obligatoria solo en puertas de la persona | `requiresGrant`: el grant (aunque sea `'*'`) se intersecta con los derechos estáticos | Igual. |
| Sistemas: acceso permanente en sus `allowedDoorIds` — `lib/accessNominaMessages.js:234-244` | Puertas directas 24x7 sin `shiftScheduleId` | Igual; razón `puerta_directa` en vez de `sistemas_acceso_permanente` (el código viejo sigue en `reasons.es.js`). |
| Nómina "autorizado" pisa una denegación de autorización — `accessControl.js:884-916` | Unión de derechos: turno válido + puerta = acceso | Equivalente. |

## Visitas

| Regla actual | Motor | Nota |
|---|---|---|
| Ventana: esperada − 2 h hasta fin del día AR — `lib/visitasAccess.js:19,30-53` | `pass.validFrom/validTo` (los calcula T2) | Antes de la ventana → `visita_antes_de_ventana`; después → `pase_vencido` (antes `visita_fuera_de_ventana`). |
| Ingreso con estado `pendiente`/`autorizada` — `lib/visitasAccess.js:97-98` | Pase no `cancelada`/`revocada`/`egreso_registrado`; `ingreso_registrado` sigue valiendo en otras puertas (D9) | **Diferencia**: hoy, tras el primer ingreso, la visita no pasa por una segunda puerta. |
| Egreso solo con `ingreso_registrado`, sin revalidar ventana — `lib/visitasAccess.js:8-10,100,114-120` | `side:'out'`: exige `ingreso_registrado` o presencia `pass:<id>`; sin ventana → `pase_sin_ingreso` si no | Igual + presencia del hub. |
| Puerta fuera de la visita → `puerta_no_autorizada` — `lib/visitasAccess.js:122-130` | Igual | Igual. |
| Egreso de visita cierra el pase — `lib/visitasAccess.js:150-151` | `stateEffects.pass.status='egreso_registrado'` solo si el lado sale a un área exterior | **Diferencia**: salir de un edificio interno no cierra el pase. |
| Visita encontrada por DNI — `lib/visitasAccess.js:83-86` | `snap.pass(dni)` y también por QR (`pass.id`) | D10. |
| — | `maxUses` → `pase_utilizado` | Nuevo. |

## Estanco (interlock)

| Regla actual | Motor | Nota |
|---|---|---|
| Tiempos por defecto 5000/2000/120000, reset interior 3000 — `doorController.js:17-22` | `interlock.js AIRLOCK_DEFAULTS`, `INNER_OPEN_RESET_MS` | Copia. |
| `deriveAirlockPhase` — `doorController.js:126-147` | `interlock.deriveAirlockPhase` | Copia; solo instantes numéricos y `nowMs` obligatorio (test de paridad en `accessEngineUnits.test.js`). |
| `evaluateAirlockPhase` — `doorController.js:210-250` | `interlock.evaluateAirlockPhase` | Copia literal (test de paridad). Rechazos → `estanco_ocupado` / `debe_ingresar_por_exterior`. |
| `evaluateManualAirlockPhase` (`AIRLOCK_OTHER_OPEN`) — `doorController.js:257-272` | `interlock.evaluateManualAirlockPhase` + `code:'AIRLOCK_OTHER_OPEN', forcible:true` | Copia literal (test de paridad). |
| Forzar: permiso `puertas.estanco.forzar` + motivo ≥5 — `routes/access.js:136-152`, `doorController.js:334-339` | `interlock.canForce` (`sin_permiso_forzar` / `motivo_forzado_requerido`), grant `apertura_forzada_estanco` | Igual, ahora dentro del motor. |
| Rol fijo outer/inner por puerta | `timedRole`: al salir (`side:'out'`) la primera puerta que se cruza actúa como exterior; en tránsito manda `entryDoorId` | **Diferencia intencional**: hoy para salir hay que abrir la interior manualmente. |
| — | `mode:'sensor'`: todas las demás puertas `SEGURA` + DPS cerrado + bond trabado; estado desconocido = no segura | Nuevo (D5, producción). |
| Cooldown manual 3 s — `doorController.js:15` | No está en el motor | Lo maneja el controlador (máquina de estados, T5). |

## Nuevo (sin equivalente actual)

`puerta_desconocida`, `puerta_deshabilitada`, `puerta_bloqueada`, `lado_no_habilitado`, `credencial_revocada`, `fuera_de_vigencia` (persona/credencial/derecho), `feriado`, `reloj_no_confiable` (solo 24x7 con reloj dudoso), `requiere_aprobacion_guardia` (D16 → `needs_approval`), APB (`apb_advertencia`, `apb_violacion`, `apb_sin_presencia`).

## Diferencias intencionales (resumen)

1. Credencial desconocida vs persona inexistente: dos códigos (`credencial_desconocida` / `no_encontrado`).
2. Horario nocturno y tolerancias que cruzan medianoche funcionan.
3. Sin búsqueda por nombre ni autorizaciones "legacy" por DNI suelto.
4. `sin_citacion_hoy` (nómina) se unifica en `sin_citacion_para_hoy`; Sistemas responde `puerta_directa`.
5. Visita: pasa por todas sus puertas mientras está adentro; vencida → `pase_vencido`; el pase se cierra solo al salir al exterior.
6. Estanco `timed`: la secuencia se invierte al salir.
7. El egreso por credencial sigue libre por defecto, pero una baja o una credencial desconocida no generan "Egreso registrado" (hoy sí).
