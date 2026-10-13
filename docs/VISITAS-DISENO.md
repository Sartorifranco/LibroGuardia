# Visitas y personas autorizadas — diseño (propuesta)

Estado: **propuesta para revisar** (2026-10-13). Referentes: Envoy, Eptura/Proxyclick, Genetec ClearID, LenelS2 / HID SAFE, Verkada Guest. Tomamos lo que tienen en común y lo adaptamos a un predio de caudales (más control, menos autoservicio).

## 1. Lo que ya existe (no se rehace)

- **Anfitrión carga visita**: `/empleado/visitas` (`EmpleadoVisitasPage.js`), API `POST /api/empleado/visitas` (`functions/routes/empleado.js`). Elige *destino* → puertas (`allowedDoorIds`).
- **Aprobación**: permisos `visitas.create` (queda autorizada) / `visitas.request` (pide aprobación) / `visitas.approve`; pantalla `Admin → Visitas` (`VisitasAdminSection.js`).
- **Invitación**: link público `/invitacion/:token` con QR; compartir a mano por WhatsApp (`wa.me`), mail (`mailto`) o copiar (`VisitaInviteQrModal.js`).
- **Paso por puerta**: la visita se compila como `visitorPasses` para el borde (`siteCompiler/build.js` `buildPass`); el motor valida ventana, puerta y egreso (`accessEngine/decide.js`). Sirve DNI o QR.
- **Guardia**: pre-registro desde `GuardAuthorizationsPanel.js`; mail SMTP ya disponible (`lib/notifications/email.js`).

## 2. Qué falta (comparado con los sistemas de primera línea)

| # | Falta | Por qué importa |
|---|---|---|
| F1 | QR con datos personales (JSON con DNI y nombre), sin firma, link sin vencimiento | Cualquiera que vea el QR ve el DNI; un link viejo sigue sirviendo |
| F2 | Uso único / por día no aplicado (`maxUses` existe pero el compilador no lo carga) | Un QR reenviado puede entrar dos veces |
| F3 | Solo visitas de **un día** | Clientes, auditores y técnicos vienen varios días o todas las semanas |
| F4 | Puertas elegidas por "destino" suelto | En los sistemas grandes se elige un **perfil de visita** (nivel de acceso) y seguridad decide qué abre cada perfil |
| F5 | La invitación no se envía sola | Depende de que el anfitrión copie y pegue |
| F6 | La visita no completa sus datos antes | Llega y el guardia tipea todo en el portón |
| F7 | El anfitrión no puede cancelar/editar ni se entera de que llegó su visita | |
| F8 | Sin lista de personas no admitidas, sin "visitas en planta ahora", sin vencidos de egreso | Clave en un predio de caudales (evacuación, control) |

## 3. Propuesta

### 3.0 Reglas del cliente (2026-10-13)

**Quién puede invitar**: solo personal con mail del dominio **@bacarsa.com.ar**.
- Configurable en Admin → Visitas: `settings/visitas.dominiosAnfitrion = ['bacarsa.com.ar']`.
- Se valida en el backend al crear, editar o solicitar una visita (`visitas.create` o `visitas.request`): si el usuario no tiene un mail de esos dominios, responde 403 con un mensaje simple.
- El admin queda exento.
- El pre-registro que hace el guardia en el portón no se toca, porque es operativo.
- El autorregistro exige **verificar el mail** con un link que se manda por SMTP antes de poder invitar. Hoy no se verifica (TODO en `lib/selfRegister.js`).

**Duración del QR** (la elige el anfitrión):

| Opción | Validez | Ingresos |
|---|---|---|
| Un solo ingreso | el día elegido (o la franja horaria) | 1 |
| Por horas | desde–hasta, el mismo día | varios, alternando entrada y salida (antipassback) |
| Todo el día | 00:00–23:59 del día elegido | varios |
| Por mes | rango de hasta 31 días, con horario diario opcional (horarios del sitio) | varios; **siempre lo aprueba Seguridad** |

El vencimiento del link (`inviteExpiresAt`) coincide con el fin de la validez.

**Implementado (etapa 1c, backend):** `GET/PUT /api/admin/visitas/settings` (dominios, caché de 5 min en `lib/visitasSettings.js`); verificación del mail con `POST /api/public/empleado/verificar` y `POST /api/auth/resend-verification` (`lib/emailVerification.js`; el admin puede marcar `emailVerified` en el usuario); campos de la visita `duracion`, `validoHasta` y `scheduleId`. La ventana se calcula en un solo lugar (`siteCompiler/build.js` `visitPassWindow`) y la usan el borde, la nube y el link. Sin `maxUses` (por horas, día o mes) se vuelve a entrar después de salir; el antipassback sigue frenando dos ingresos seguidos.

### 3.1 Tres tipos de persona externa (una sola pantalla para el anfitrión)

1. **Visita puntual** — un día o un rango corto (máx. 5 días). Lo carga un anfitrión. QR por invitación.
2. **Visita frecuente / cliente autorizado** — rango largo (hasta 6 meses), días y horario fijos (ej. lun–vie 8–17). Requiere **aprobación de Seguridad** siempre. Entra con **DNI** (y QR opcional). Al vencer se pide renovar.
3. **Contratista / proveedor** — igual que frecuente, más vehículo y empresa obligatoria (opcional fase 2: seguro/ART con vencimiento).

Todas quedan ligadas a una **persona** (`people`, tipo `visita`) para tener historial: la segunda vez que viene alguien, el anfitrión lo busca por DNI y no se recarga.

### 3.2 Perfiles de visita (en lugar de elegir puertas)

Admin → **Perfiles de visita**: nombre ("Cliente – Atención al público", "Técnico – Sala de equipos", "Auditor – Tesorería"), grupos de acceso / puertas (reutiliza `accessModel`), horario, si **necesita acompañante**, si **necesita aprobación** y de quién, duración máxima permitida.
Cada anfitrión ve solo los perfiles que tiene habilitados (ej. Comercial ve "Cliente", Sistemas ve "Técnico"). Así un empleado no puede darle a una visita acceso a tesorería.

### 3.3 Panel del anfitrión ("Mis visitas")

Para quien tiene `visitas.create` o `visitas.request`. Celular primero, en un Modal/Wizard de 3 pasos:

1. **Quién**: buscar por DNI (si ya vino, autocompleta) o cargar nombre, DNI, empresa, mail y/o celular.
2. **Cuándo y a qué**: tipo (puntual / frecuente), fecha(s) y horario, perfil de visita, motivo, patente si viene en vehículo.
3. **Revisar y enviar**: muestra si queda autorizada o pendiente de aprobación.

Lista con filtros *Hoy / Próximas / Pendientes / Historial*; acciones **Reenviar invitación**, **Editar**, **Cancelar** (revoca el pase en el borde). Carga múltiple (ej. 6 personas de una misma empresa para una reunión) con una sola invitación por persona.

### 3.4 Invitación a la persona

- **Envío automático por mail** desde el servidor (SMTP ya existe): asunto, fecha, dirección, anfitrión, botón "Ver mi pase", archivo `.ics` para el calendario y reglas de ingreso (documento, sin armas, etc.).
- **WhatsApp**: fase 1 con el botón actual (abre WhatsApp del anfitrión con el mensaje armado). Fase 2 opcional: WhatsApp Business API para envío automático (tiene costo por mensaje y requiere cuenta verificada de la empresa; decidir después).
- **Página del pase** (`/invitacion/:token`), sin login:
  - **Pre-registro**: la visita confirma nombre y DNI, saca **foto** (selfie), carga patente y acepta las reglas del predio. Opcional por perfil.
  - Muestra el **QR** grande, fecha, horario, a quién visita y cómo llegar.
  - Se puede "Agregar a la billetera" en fase 2 (Apple/Google Wallet).
- El link **vence** al terminar la visita y deja de servir si se cancela.

### 3.5 QR seguro

- El QR lleva solo un **código opaco** (`MSSV1.<id aleatorio de 128 bits>`), sin nombre ni DNI.
- Ese código se compila en `visitorPasses` (como hoy) y el borde lo busca localmente: **funciona sin internet**.
- **Usos**: puntual = un ingreso por día; frecuente = uno por día dentro del horario. Se carga `maxUses`/por día en el compilador (F2) y el antipassback ya existente evita el doble ingreso.
- Cancelar / rechazar / editar genera un código nuevo y revoca el anterior (ya existe el marcador `revoked`).
- **DNI sigue sirviendo** como alternativa (mismo pase, por `dniHash`).

### 3.6 Llegada al predio

- La visita escanea **QR o DNI** en el kiosco/lector del portón. Si el perfil pide verificación, el guardia ve **foto del pre-registro + foto del DNI** y confirma.
- Al ingresar: aviso al **anfitrión** (mail ahora; push en la app más adelante) "Llegó Juan Pérez (Empresa X)".
- Si el perfil pide **acompañante**, la visita solo habilita la primera puerta; las siguientes necesitan que el anfitrión pase su credencial junto (modo "escolta", fase 2).
- Opcional: impresión de etiqueta con foto y nombre (fase 2).

### 3.7 Control de Seguridad

- **Personas no admitidas** (lista de bloqueo por DNI, con motivo y quién la cargó). Si el anfitrión invita a alguien bloqueado, la visita queda en "pendiente de Seguridad" sin decirle el motivo al anfitrión.
- **Aprobación** por perfil: cola en Admin → Visitas (ya existe), con aviso por mail al aprobador.
- **Tablero del guardia**: *Esperadas hoy / En planta ahora / Pasadas de hora sin salir*. "En planta ahora" sirve como **lista de evacuación**.
- **Auditoría**: quién invitó, quién aprobó, cada paso por puerta, cancelaciones (ya hay auditoría; sumar estos eventos).

### 3.8 Costo (tope US$ 10/mes)

Sin polling: el tablero del guardia usa los eventos del hub (LAN/SSE) y una lectura al abrir. Las invitaciones son 1 escritura + 1 mail. La página pública lee 1 documento por apertura (cachear en el navegador). Los pases viajan en los chunks firmados que ya se compilan.

## 4. Etapas sugeridas (cada una es una tarea de Cursor)

1. **QR seguro y vencimientos**: código opaco, vencimiento del link, uso por día en el compilador, cancelar/editar desde el anfitrión con revocación.
2. **Envío por mail** de la invitación (+ `.ics`), reenvío y aviso al anfitrión cuando llega la visita.
3. **Perfiles de visita** en Admin y su uso en el formulario del anfitrión (reemplaza "destino").
4. **Visitas frecuentes / clientes autorizados**: rango de fechas, días y horario, aprobación obligatoria y aviso de vencimiento.
5. **Pre-registro de la visita** en la página pública (datos, foto, reglas).
6. **Tablero del guardia** y **lista de no admitidos**.
7. Fase 2: WhatsApp automático, escolta, billetera, etiqueta impresa, documentación de contratistas.

## 5. Decisiones

Tomadas el 2026-10-13:
- **Aprobación mixta**: las visitas puntuales quedan autorizadas directo si el anfitrión tiene `visitas.create`. Las frecuentes, los clientes autorizados y los perfiles marcados como sensibles las aprueba siempre Seguridad.
- **Envío**: mail automático desde el servidor más el botón de WhatsApp que manda el anfitrión. Sin WhatsApp Business por ahora.
- **Credencial**: QR o DNI, cualquiera de los dos.
- **Pre-registro con foto**: lo define cada perfil de visita.

Pendiente:
- ¿Qué áreas requieren acompañante? (Se define al cargar los perfiles.)
