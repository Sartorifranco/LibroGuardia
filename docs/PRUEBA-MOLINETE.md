# Prueba guiada — Molinete / validación de acceso

Sistema: **Libro de Guardia Bacar** — https://bacarguard.web.app  
API: `POST /api/access/validar` y kiosk `POST /api/access/kiosk-scan`

---

## Pre-requisitos

- [ ] Functions desplegadas (`firebase deploy --only functions`)
- [ ] Puente citaciones **online** en PC transporte (planillas en `C:\usr`)
- [ ] Admin → Autorizaciones: citaciones del **día de prueba** visibles
- [ ] Admin → Control acceso: relevador configurado (opcional para prueba sin apertura física)
- [ ] Usuario guardia con permiso `access.kiosk`

---

## Casos de prueba (orden recomendado)

### Caso 1 — Chofer con citación hoy (debe **AUTORIZAR**)

**Datos:** persona importada desde planilla CSV (legajo + nombre, sin DNI en CSV).

| Paso | Acción | Resultado esperado |
|------|--------|-------------------|
| 1 | Admin → Autorizaciones → filtrar **hoy** | Aparece en listado |
| 2 | Molinete → escanear DNI real de esa persona | Pantalla verde / autorizado |
| 3 | Mensaje | "Citación del día: [nombre]" |
| 4 | Firestore / movimientos | 1 doc en `entries`, `authorized: true` |

**Si falla:** revisar logs Functions `[accessControl] Resolución de persona` — camino `nameKey` o `dni`.

---

### Caso 2 — Misma persona **sin** citación mañana (debe **DENEGAR**)

| Paso | Acción | Resultado esperado |
|------|--------|-------------------|
| 1 | Probar al día siguiente (o cambiar fecha en entorno de prueba) | — |
| 2 | Escanear mismo DNI | Denegado |
| 3 | `denialReason` | `sin_citacion_para_hoy` |
| 4 | `entries` | `authorized: false`, igual se registra |

---

### Caso 3 — Empleado **permanente** Sistemas (AUTORIZAR cualquier día/hora)

**Carga manual Admin → Autorizaciones:**

- Tipo: **Permanente**
- Nombre + DNI (o legajo)
- Días: **ninguno marcado** (todos los días)
- Horario: **vacío**

| Resultado | Autorizado siempre |

---

### Caso 4 — Tesorería permanent con turno (AUTORIZAR solo Lun–Vie 08:00–17:00)

**Carga manual:**

- Tipo: **Permanente**
- Días: Lu, Ma, Mi, Ju, Vi
- Horario: 08:00 – 17:00

| Momento | Resultado |
|---------|-----------|
| Miércoles 10:00 | Autorizado (+ 15 min tolerancia) |
| Sábado 10:00 | Denegado `sin_citacion_para_hoy` |
| Lunes 20:00 | Denegado (fuera de horario) |

---

### Caso 5 — Cliente **visita** un solo día

**Carga manual:**

- Tipo: **Visita**
- Desde = Hasta = **hoy**
- DNI + nombre

| Hoy | Autorizado |
| Mañana | Denegado |

---

### Caso 6 — Tercerizado **temporal** (rango)

**Carga manual:**

- Tipo: **Temporal**
- Desde: hoy — Hasta: +7 días

| Dentro del rango | Autorizado |
| Día después del `endDate` | Denegado (sin acción manual) |

---

### Caso 7 — Persona **inactiva** en `people`

Admin debe marcar `active: false` en people (fase posterior UI) o vía consola Firebase.

| Resultado | Denegado `persona_inactiva` — no consulta authorizations |

---

### Caso 8 — DNI **no registrado**

Persona random no en `people` ni planillas.

| Resultado | Denegado `no_encontrado`, `personId: null`, entry igual se crea |

---

## Probar vía API (Postman / curl)

```http
POST https://bacarguard.web.app/api/access/validar
Authorization: Bearer <token_guardia>
Content-Type: application/json

{
  "dni": "30461597",
  "nombre": "Miguel Angel Fernando",
  "apellido": "Acevedo",
  "tipoMovimiento": "ingreso",
  "channel": "molinete",
  "guardId": null
}
```

Respuesta esperada:

```json
{
  "authorized": true|false,
  "denialReason": null|"sin_citacion_para_hoy"|...,
  "personId": "...",
  "personName": "...",
  "authorizationType": "citacion"|"permanent"|...,
  "entryId": "..."
}
```

---

## Checklist final molinete

- [ ] Caso 1 citación OK
- [ ] Caso 2 sin citación denegado
- [ ] Caso 3 o 4 permanent OK/falla según horario
- [ ] Caso 5 visita OK solo hoy
- [ ] Siempre hay registro en `entries`
- [ ] Relevador abre solo si autorizado y SR201 habilitado (opcional)

---

## Registro de prueba (completar en planta)

| # | Persona | Tipo auth | Hora | Esperado | OK/FALTA | Notas |
|---|---------|-----------|------|----------|----------|-------|
| 1 | | citacion | | AUT | | |
| 2 | | — | | DEN | | |
| 3 | | permanent | | AUT | | |
| 4 | | visita | | AUT | | |

Fecha prueba: ___________  
Operador: ___________
