# Prueba guiada â€” Molinete / validaciÃ³n de acceso

Sistema: **Libro de Guardia Bacar** â€” https://mss-guard.web.app  
API: `POST /api/access/validar` y kiosk `POST /api/access/kiosk-scan`

---

## Pre-requisitos

- [ ] Functions desplegadas (`firebase deploy --only functions`)
- [ ] Puente citaciones **online** en PC transporte (planillas en `C:\usr`)
- [ ] Admin â†’ Autorizaciones: citaciones del **dÃ­a de prueba** visibles
- [ ] Admin â†’ Control acceso: relevador configurado (opcional para prueba sin apertura fÃ­sica)
- [ ] Usuario guardia con permiso `access.kiosk`

---

## Casos de prueba (orden recomendado)

### Caso 1 â€” Chofer con citaciÃ³n hoy (debe **AUTORIZAR**)

**Datos:** persona importada desde planilla CSV (legajo + nombre, sin DNI en CSV).

| Paso | AcciÃ³n | Resultado esperado |
|------|--------|-------------------|
| 1 | Admin â†’ Autorizaciones â†’ filtrar **hoy** | Aparece en listado |
| 2 | Molinete â†’ escanear DNI real de esa persona | Pantalla verde / autorizado |
| 3 | Mensaje | "CitaciÃ³n del dÃ­a: [nombre]" |
| 4 | Firestore / movimientos | 1 doc en `entries`, `authorized: true` |

**Si falla:** revisar logs Functions `[accessControl] ResoluciÃ³n de persona` â€” camino `nameKey` o `dni`.

---

### Caso 2 â€” Misma persona **sin** citaciÃ³n maÃ±ana (debe **DENEGAR**)

| Paso | AcciÃ³n | Resultado esperado |
|------|--------|-------------------|
| 1 | Probar al dÃ­a siguiente (o cambiar fecha en entorno de prueba) | â€” |
| 2 | Escanear mismo DNI | Denegado |
| 3 | `denialReason` | `sin_citacion_para_hoy` |
| 4 | `entries` | `authorized: false`, igual se registra |

---

### Caso 3 â€” Empleado **permanente** Sistemas (AUTORIZAR cualquier dÃ­a/hora)

**Carga manual Admin â†’ Autorizaciones:**

- Tipo: **Permanente**
- Nombre + DNI (o legajo)
- DÃ­as: **ninguno marcado** (todos los dÃ­as)
- Horario: **vacÃ­o**

| Resultado | Autorizado siempre |

---

### Caso 4 â€” TesorerÃ­a permanent con turno (AUTORIZAR solo Lunâ€“Vie 08:00â€“17:00)

**Carga manual:**

- Tipo: **Permanente**
- DÃ­as: Lu, Ma, Mi, Ju, Vi
- Horario: 08:00 â€“ 17:00

| Momento | Resultado |
|---------|-----------|
| MiÃ©rcoles 10:00 | Autorizado (+ 15 min tolerancia) |
| SÃ¡bado 10:00 | Denegado `sin_citacion_para_hoy` |
| Lunes 20:00 | Denegado (fuera de horario) |

---

### Caso 5 â€” Cliente **visita** un solo dÃ­a

**Carga manual:**

- Tipo: **Visita**
- Desde = Hasta = **hoy**
- DNI + nombre

| Hoy | Autorizado |
| MaÃ±ana | Denegado |

---

### Caso 6 â€” Tercerizado **temporal** (rango)

**Carga manual:**

- Tipo: **Temporal**
- Desde: hoy â€” Hasta: +7 dÃ­as

| Dentro del rango | Autorizado |
| DÃ­a despuÃ©s del `endDate` | Denegado (sin acciÃ³n manual) |

---

### Caso 7 â€” Persona **inactiva** en `people`

Admin debe marcar `active: false` en people (fase posterior UI) o vÃ­a consola Firebase.

| Resultado | Denegado `persona_inactiva` â€” no consulta authorizations |

---

### Caso 8 â€” DNI **no registrado**

Persona random no en `people` ni planillas.

| Resultado | Denegado `no_encontrado`, `personId: null`, entry igual se crea |

---

## Probar vÃ­a API (Postman / curl)

```http
POST https://mss-guard.web.app/api/access/validar
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

- [ ] Caso 1 citaciÃ³n OK
- [ ] Caso 2 sin citaciÃ³n denegado
- [ ] Caso 3 o 4 permanent OK/falla segÃºn horario
- [ ] Caso 5 visita OK solo hoy
- [ ] Siempre hay registro en `entries`
- [ ] Relevador abre solo si autorizado y SR201 habilitado (opcional)

---

## Registro de prueba (completar en planta)

| # | Persona | Tipo auth | Hora | Esperado | OK/FALTA | Notas |
|---|---------|-----------|------|----------|----------|-------|
| 1 | | citacion | | AUT | | |
| 2 | | â€” | | DEN | | |
| 3 | | permanent | | AUT | | |
| 4 | | visita | | AUT | | |

Fecha prueba: ___________  
Operador: ___________
