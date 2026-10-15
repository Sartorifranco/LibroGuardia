# Pendientes — MSS Guard

Lista única de lo que falta. Para retomar algo: abrir una sesión nueva y decir
"seguí con el punto X de docs/PENDIENTES.md". Actualizada: 2026-10-15.

**A quién va:** 🆓 IA gratis (pantallas, textos, tests) · 🔒 Cursor (seguridad, permisos, borde) · 🧠 Claude (diseño, revisión, arreglos de pocas líneas) · 👤 Vos (decisiones, pruebas, cosas con contraseña).

## 1. Ahora (prueba del banco)

| # | Qué | Por qué importa | Quién |
|---|---|---|---|
| 1.1 | ✅ Hecho 2026-10-14: secreto `EDGE_SIGNING_PRIVATE_KEY` cargado (es la clave del banco) y hub apuntando a la nube. **Antes de producción: rotarla por una generada solo para la nube** | Sin ella ningún equipo acepta la configuración | 🔒 rotación |
| 1.2 | ✅ Supervisor ya aprueba visitas. Falta sumarle "Ver las alarmas del sitio" si corresponde | Jefe de seguridad sin alarmas | 👤 (Roles y permisos) |
| 1.3 | ✅ Probado 2026-10-14 en el banco: invitación directa abre; pedido → aprobación de Surly → abre; cancelar → rechaza en segundos. 2026-10-15: pase "un ingreso" probado (segunda pasada rechazada) | Cierra el paso 3 | 👤 |
| 1.3c | Al cancelar una visita, la puerta dice "credencial desconocida": mostrar "visita cancelada" para que el guardia entienda | Claridad en garita | 🔒 (borde) |
| 1.3b | 🟡 Probado 2026-10-15 en el banco en la red del predio (la puerta no abre sola; "Abrir" abre, "No abrir" no). Falta aprobar desde la nube (ver 1b). **No existía pantalla para que el guardia apruebe ingresos** de puertas con "¿El guardia tiene que aprobar cada ingreso?" (`requireGuardApproval`). Con esa opción la puerta nunca abre por credencial (`needs_approval`). Construirla (desde el panel de Guardia, vía hub) o no usar la opción | Bloquea portones de clientes | 🧠 diseño + 🔒 |
| 1.4 | ✅ Hecho 2026-10-15: merge `integracion/revision-2026-10` → `main` (fast-forward) y push | — | 🧠 con tu OK |

## 1b. Aviso al guardia cuando pasa una visita (pedido 2026-10-14)

Hoy, cuando una visita pasa su QR, el guardia no se entera y en "Autorizados" sigue diciendo "Esperando ingreso" (los eventos de la puerta no actualizan la visita).

Propuesta (una sola función, que también resuelve el 1.3b):
1. **Opción por puerta:** "Avisar al guardia cuando pasa una visita o un externo" (Ingreso Principal y portones). Los empleados no avisan, para no cansar al guardia.
2. **Ventana emergente en la pantalla del guardia**, con sonido: nombre, foto si la hay, empresa, anfitrión, puerta y hora. Botones **"Es la persona"** / **"No coincide"** (abre una novedad). Si la puerta pide aprobación, el mismo cartel tiene **"Abrir"**/**"No abrir"** (1.3b).
3. **En vivo desde el hub** (red del predio, funciona sin internet); en la nube llega con unos segundos de atraso.
4. **La visita pasa a "Ingresó 15:40"** cuando la nube recibe el evento de la puerta (arregla "Esperando ingreso" en Autorizados y en Mis visitas).

**✅ Hecho 2026-10-14. Desplegado y probado en el banco 2026-10-15** (functions + web, hub y controlador actualizados): aviso con sonido, "Es la persona", "No coincide" con Novedad precargada, "Ingresó HH:MM" en Autorizados y Mis visitas, y aprobación del guardia en la red del predio.
- Opción por puerta `notifyGuardOnVisitor` en Puertas ("¿Avisar al guardia cuando pasa una visita o un externo?"), compilada al borde. Externo = pase de visita o autorización temporal/citación/visita; empleados no avisan.
- Hub: evento SSE `visitor` (lanApi/visitors.js) y `GET/POST /api/guard/approvals` → controlador `/edge/approvals/:id`. Resuelve el 1.3b en la red del predio.
- Pantalla del guardia: `VisitorAlertModal` con sonido, "Es la persona" / "No coincide" (lleva a Novedad) y "Abrir" / "No abrir". Solo para quien puede abrir puertas (`access.manual_open`).
- Nube: `edgeIngest` marca la visita `ingreso_registrado` con `ingresoAt` (y `egreso_registrado`/`egresoAt`); Autorizados y Mis visitas muestran "Ingresó 15:40". El hub agrega `visitaId` al subir. Llega cuando el hub sube eventos (cada ~2 min).

**Falta:**
- Foto en el cartel (no hay foto en el pase).
- ✅ Cartel en modo nube (mss-guard.web.app): `liveAlerts` arma `visitor_pass` con las entries del borde y el hub sube esos pasos al instante; llega en hasta ~1 min (la web consulta cada 60 s). Falta: aprobar ingresos desde la nube (comando `approve`; hoy solo en la red del predio).
- ✅ 2026-10-15: "No coincide" abre Novedad con nombre, documento, anfitrión, puerta y hora precargados.

## 2. Arreglos chicos

| # | Qué | Quién |
|---|---|---|
| 2.1 | Botón "Configurar correo" arriba en Avisos por mail, con estado "Correo sin configurar / Correo: x" | 🆓 |
| 2.2 | El aviso "Confirmá tu mail" sigue hasta volver a entrar después de confirmar | 🆓 |
| 2.3 | ✅ Hecho (ca9961f): sin `alarmas.ver` no consulta. Desplegado 2026-10-15 | 🆓 |
| 2.4 | ✅ Hecho 2026-10-15: sin permiso de ver roles no pide la lista. Desplegado y probado en el banco 2026-10-15 | 🆓 |
| 2.5 | ✅ Hecho (ca9961f): la nube responde `{mode:'cloud'}` sin leer Firestore. Desplegado y verificado 2026-10-15 | 🆓 |
| 2.6 | El dominio permitido se configura en dos lugares (Autorizaciones → Configuración y Empresas). Unificar | 🧠 |
| 2.7 | Usuarios: avisar si una cuenta tiene identificador distinto de su usuario (no puede entrar nunca) | 🆓 |
| 2.8 | Roles del sistema guardados en la base no se actualizan cuando el código suma permisos | 🔒 |
| 2.9 | Hay dos pantallas llamadas "Autorizaciones" (pedidos de ingreso del guardia y aprobación de visitas). Renombrar/unificar | 🧠 diseño + 🆓 |
| 2.10 | Nube vieja (`functions/lib/visitasAccess.js`) no controla el horario (`scheduleId`); el borde sí | 🔒 |
| 2.11 | `mauricio@arcor.com.ar` tiene "aprobar visitas" como permiso extra: revisar si corresponde | 👤 |

## 3. Seguridad

| # | Qué | Quién |
|---|---|---|
| 3.1 | La contraseña SMTP se guarda en claro (`functions/lib/notifications/config.js`) → cifrar o Secret Manager | 🔒 |
| 3.2 | Cambiar las contraseñas de prueba que quedaron escritas en el chat | 👤 |

## 4. Revisión completa del sistema (sesión aparte)

✅ Recorrido hecho 2026-10-14: **25 arreglos** en `docs/REVISION-UI-2026-10.md` (por pantalla, con capturas en `docs/revision-ui/` y a quién va). Para seguir: "seguí con R.x de docs/REVISION-UI-2026-10.md".
- Primero: ~~R.15~~ (hecho 2026-10-14), R.3 (no vuelve arriba al cambiar de pantalla), R.12 ("Guardando…" falso en Personal), R.4–R.6 (títulos rojos, mayúsculas, rojo de Borrar).
- ~~Después: barra de arriba y franjas de admin (R.1, R.2)~~ (hecho 2026-10-14; 👤 falta mirarlo con usuario logueado, en compu y celular).
- R.25: ~14 pedidos por minuto por puesto de guardia; revisar que no lean Firestore cada vez.
- R.23 (grupos de permisos en tema oscuro) no se pudo confirmar a ojo: 👤 mirarlo.

## 5. Próximas etapas de visitas (`docs/VISITAS-DISENO.md` §4)

1. Mail automático con la invitación (+ archivo de calendario .ics) y aviso a Seguridad cuando entra una solicitud.
2. Aviso al anfitrión cuando su visita llega.
3. Perfiles de visita.
4. Pre-registro con foto.
5. Tablero del guardia y lista de no admitidos.

## 6. Predio

Definir SP, RRHH y la puerta que está en dos estancos ("Estanco 2 Playa", puerta-p14, figura en "Estanco Playa" y en "Estanco Sistemas y Playa").

## Quién puede hacer qué (roles)

| Rol | Para quién | Puede |
|---|---|---|
| **Guardia** | Personal de garita | Registrar ingresos, usar el lector, abrir puertas desde Guardia. No aprueba visitas |
| **Monitoreo** | Operador del portón de vehículos | Autorizar vehículos, ver novedades |
| **Supervisor** | Jefe de seguridad | Todo lo del guardia + aprobar visitas, gestionar personal y usuarios. Sin configuración técnica |
| **Administrador** | Sistemas | Todo, incluida la configuración técnica |
| **Empleado — visitas** | Empleado habilitado | Invita visitas que quedan autorizadas solas (salvo "Por mes", que aprueba Seguridad) |
| **Empleado — solicitar visitas** | Quien se registra solo | Invita, pero todo pasa por Seguridad hasta que un admin lo cambie a "Empleado — visitas" |

Los **permisos extra** (Usuarios → Editar → Opciones avanzadas) suman algo puntual a una persona sin cambiarle el rol.
