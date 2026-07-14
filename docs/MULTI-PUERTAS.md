# Multi-puertas, estancos y métodos de acceso

## Conceptos

| Concepto | Descripción |
|----------|-------------|
| **Puerta** | Punto de acceso físico con un canal SR201 (u otro dispositivo en el puente) |
| **Lector** | Identificador del kiosk/terminal (`readerId`) que determina qué puerta abrir |
| **Estanco** | Dos puertas en secuencia: la interior solo se habilita tras cierre + retardo de la exterior |
| **Métodos de auth** | `dni`, `credential`, `face` (próximo), `manual` (guardia) |

## Configuración (Admin → Puertas y acceso)

Todo el control SR201, multi-puerta y estancos se configura en **un solo panel** (Admin → **Puertas y acceso**). La sección «GPS flota» quedó separada porque es independiente del hardware de puertas.

Si venía usando la configuración antigua de «Control SR201», al abrir el panel se importa automáticamente como **puerta principal**. Guarde una vez para consolidar.

### Puerta individual
- Nombre e ID
- Canal SR201 (1–8), IP o URL puente propia (opcional; hereda global si vacío)
- Lectores asociados (ej. `default`, `molinete-norte`, `estanco-ext`)
- Métodos de autenticación habilitados
- Rol en estanco: `outer` / `inner` / ninguno

### Estanco
- Puerta exterior + puerta interior
- **Cierre exterior (ms):** tiempo estimado hasta considerar la puerta exterior cerrada tras el pulso
- **Retardo entre puertas (ms):** espera adicional antes de habilitar la interior
- **Timeout tránsito (ms):** reinicio automático si nadie completa el paso

## Flujo estanco (automático)

1. Persona autorizada escanea en **puerta exterior** → se abre exterior, fase `outer_open`
2. Tras `outerCloseDelayMs` → fase `outer_closed_pending`
3. Tras `interDoorDelayMs` adicional → fase `inner_allowed`
4. Persona escanea en **puerta interior** → se abre interior, luego reset a `idle`

Si intenta la interior antes: *«Espere a que la puerta exterior cierre por completo»*.

## Credenciales especiales

Formatos reconocidos en el lector:
- Prefijo `CARD:`, `CRED:`, `TARJETA:`, `RFID:`
- Código hex 6–16 caracteres

Vincular en Firestore:
- Campo `accessCard` en `people`, o
- Autorización activa con `credentialCode`

## Rostro (face)

Marcado en configuración de puerta; integración con cámara/biometría pendiente de lector dedicado.

## APIs

| Método | Ruta | Uso |
|--------|------|-----|
| GET | `/api/admin/doors-config` | Config completa |
| PUT | `/api/admin/doors-config` | Guardar puertas y estancos |
| GET | `/api/guard/doors` | Listado para botón guardia |
| POST | `/api/guard/open-door` | Apertura manual `{ doorId, bypassAirlock }` |
| POST | `/api/access/kiosk-scan` | `{ rawData, doorId, readerId }` |
| GET | `/api/guard/airlock/:groupId` | Estado del estanco |
| POST | `/api/guard/airlock/:groupId/reset` | Reinicio manual |

## Ejemplo: dos SR201, un estanco

| Puerta | SR201 | Canal | Lector | Rol |
|--------|-------|-------|--------|-----|
| Portón calle | 192.168.0.50 | 1 | `estanco-ext` | outer |
| Molinete hall | 192.168.0.51 | 1 | `estanco-int` | inner |

Estanco `ingreso-principal`: retardo 5 s cierre + 2 s entre puertas.
