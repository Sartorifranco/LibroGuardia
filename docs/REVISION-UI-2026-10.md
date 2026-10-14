# Revisión de pantallas — 2026-10-14

Recorrido de **guardia** y **administración** en mss-guard.web.app, tema oscuro, en PC (ventana de ~800 px) y celular (375 px, medido). Capturas chicas en `docs/revision-ui/`.

**A quién va:** 🆓 IA gratis · 🔒 Cursor · 🧠 Claude · 👤 Vos (igual que en `PENDIENTES.md`).

## Todas las pantallas

| # | Qué pasa | Arreglo propuesto | Quién |
|---|---|---|---|
| R.1 | Barra de arriba con 8 botones sueltos (tema, tutorial, usuario, contraseña, panel admin, áreas, salir, buscador). En celular ocupa casi un tercio de pantalla. Ver `g-personal.jpg` | Dejar buscador + estado "En línea" + un botón de usuario que abra un menú con tema, tutorial, contraseña, áreas y salir. Diseño primero | 🧠 diseño + 🆓 |
| R.2 | En admin, "Volver a operación" aparece dos veces (barra de arriba y franja de abajo) y además está la franja "Panel de control / Configuración del sistema". El contenido empieza a 240 px de arriba. Ver `a-primeros-pasos.jpg` | Sacar la franja "Volver…" (queda el botón de la barra) y achicar "Panel de control" a una línea | 🆓 |
| R.3 | Al cambiar de pantalla no vuelve arriba: se abre con el scroll de la pantalla anterior. Ver `g-citados.jpg` | `window.scrollTo(0,0)` al cambiar de ruta (un componente `ScrollToTop`) | 🧠 (pocas líneas) |
| R.4 | Títulos de guardia en rojo ("Registro de Personal", "Autorizaciones", "Historial"): parecen error | Usar el color de título normal; rojo solo para alertas | 🆓 |
| R.5 | Mayúsculas mezcladas: "Tipo de Movimiento", "Hora Real", "Registrar Flota", "Registro de Novedad" | Solo la primera palabra en mayúscula | 🆓 |
| R.6 | Botones rojos "Borrar"/"Eliminar" con poco contraste en tema oscuro (2,3:1; mínimo 4,5:1) — Lugares, Estancos, Usuarios, Roles | Aclarar el rojo del texto o usar fondo rojo con texto blanco | 🆓 |
| R.7 | Nombre "Manager **Sistem** Security" (`src/config/brand.js`) | ¿Es así la marca o es "System"? | 👤 |

## Guardia

| # | Pantalla | Qué pasa | Arreglo propuesto | Quién |
|---|---|---|---|---|
| R.8 | Inicio | Dos tableros uno debajo del otro ("Centro operativo" y "Vista general"); la lista de 22 puertas queda en el medio y empuja todo | Puertas en su pestaña (ya existe "Solo puertas"); "Vista general" solo en admin o colapsada | 🧠 diseño + 🆓 |
| R.9 | Inicio / Puertas | Arriba dice "En línea" y la puerta Ingreso Principal dice "Sin conexión". El resto dice "Todavía no se pidió abrir", que no informa nada. Ver `g-inicio-puertas.jpg` | Mostrar estado real (conectada / sin conexión / abierta) y, si no hay dato, nada. Agrupar por lugar o estanco | 🧠 diseño + 🆓 |
| R.10 | Puertas | Dos formas de "abrir en otra ventana" (recuadro con botón + ícono). Etiqueta "Ingreso principal" repite el nombre. Ver `g-puertas.jpg` | Dejar solo el ícono con ayuda; sacar la etiqueta repetida | 🆓 |
| R.11 | Inicio (celular) | Las tarjetas de números (Móviles en planta, etc.) se cortan a 375 px | Dos columnas en celular, textos que bajen de línea | 🆓 |
| R.12 | Personal | Al entrar, el botón dice "Guardando…" varios segundos (en realidad está cargando la lista de personal) | Mostrar "Cargando…" o dejar "Registrar personal" deshabilitado | 🆓 |
| R.13 | Personal / Vehículos / Flota (celular) | Reloj + barra empujan el formulario a 290 px; hay que bajar para empezar a cargar | Achicar la franja del reloj en celular | 🆓 |
| R.14 | Autorizados | "Pre-registrar visita" es un formulario fijo en la pantalla (la regla es ventana emergente) y la tabla no entra en celular. Texto "Solo consulta. Para ingreso excepcional usá la pestaña Personal" confunde. Ver `g-autorizados.jpg` | Botón "Pre-registrar visita" que abre Modal; tabla → tarjetas en celular; texto: "Para dejar pasar a alguien que no está en la lista, usá Personal" | 🆓 |
| R.15 | Autorizaciones | Botones "Aprobadas" e "Historial" blancos sobre blanco (invisibles). Ver `g-autorizaciones.jpg` | Mismo estilo de pestañas que el resto | ✅ 2026-10-14 (pestañas y tarjetas con colores del tema) |
| R.16 | Vehículos autorizados | Campos sin etiqueta (solo texto gris adentro, que desaparece al escribir) | Etiqueta arriba de cada campo, como en Vehículos | 🆓 |
| R.17 | Flota | Sin texto de ayuda (las demás pantallas lo tienen); "Hora programada" pide fecha y hora completas. Ver `g-flota.jpg` | Una línea de ayuda; solo hora (fecha = hoy) | 🆓 |
| R.18 | Historial | 22 botones de puertas + 5 de origen + 4 de fecha: pared de botones. Ver `g-historial.jpg` | Puerta y origen como listas desplegables | 🆓 |
| R.19 | Reportes | Jerga: "agregado en el servidor", "dashboard". Personal 23 ingresos / 0 egresos en 7 días. Ver `g-reportes.jpg` | Texto: "Resumen de un período. Para el día de hoy usá Inicio." Revisar por qué no hay egresos de personal | 🆓 texto + 🧠 dato |

## Administración

| # | Pantalla | Qué pasa | Arreglo propuesto | Quién |
|---|---|---|---|---|
| R.20 | Menú | 28 opciones en una sola columna. "Mis visitas" saca del panel admin (va a `/empleado/visitas`) sin avisar | Agrupar más (las secciones ya existen: colapsarlas). "Mis visitas" abrir dentro de admin o marcar que sale | 🧠 diseño + 🆓 |
| R.21 | Avisos por mail | 24 interruptores sueltos en la pantalla y el recuadro principal se ve claro/apagado en tema oscuro, como deshabilitado. Ver `a-avisos.jpg` | Tarjeta con el fondo oscuro normal; los avisos en tabla con interruptores grandes | 🆓 |
| R.22 | Personas (celular) | Cada persona trae 4 botones chicos (Editar datos, Agregar credencial, Asignar grupo, Recalcular…): más de 700 botones de menos de 32 px | Un botón "⋯" por persona con esas acciones | 🆓 |
| R.23 | Roles y permisos | El texto de los grupos de permisos en tema oscuro (ya marcado): la medición de contraste dio bien, el panel no dejó verlo a ojo | Confirmar a ojo en tu PC antes de mandarlo | 👤 |
| R.24 | Feriados, Usuarios, Registro de cambios | Tienen campos fijos en pantalla fuera de ventana (filtros o alta) | Revisar cuál es alta y pasarla a Modal | 🆓 |

## Consumo (no es pantalla, pero salió en el recorrido)

| # | Qué pasa | Quién |
|---|---|---|
| R.25 | Con una pantalla de guardia abierta la web hace ~14 pedidos por minuto (`/entries`, `/guard/alarms`, `/guard/live-alerts`, `/guard/fleet-gps/alerts`): ~20.000 por día por puesto. Confirmar que esas rutas responden de caché y no leen Firestore cada vez (tope US$ 10/mes). Relacionado con 2.3 | 🧠 revisar + 🔒 si hay que tocar |

## Orden sugerido

1. R.15, R.3, R.12, R.4–R.6 (rápidos, se ven mucho).
2. R.1 + R.2 (barra de arriba): diseño y después 🆓.
3. R.25 (consumo) antes de dejar puestos abiertos todo el día.
4. Resto por pantalla, de a una tarea por pantalla.
