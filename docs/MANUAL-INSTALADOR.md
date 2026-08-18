# Manual del instalador — MSS Guard (Libro de Guardia)

Documento único de referencia para quien instala el software y el hardware en un cliente nuevo.
No reemplaza los docs específicos del repo — los organiza y explica el "por qué" de cada uno.

---

## 1. Qué es el sistema, en una frase

MSS Guard decide **quién entra**, deja constancia de **cuándo y por dónde**, y **ordena abrir** la puerta física — pero nunca es el software el que abre: siempre hay un puente/driver de hardware en el medio que ejecuta la orden.

```
Lector (cualquier marca)  →  Bridge local / API  →  MSS Guard (nube, decide)  →  Driver de puerta  →  Relé/panel  →  Puerta física
        IDENTIFICACIÓN                                    DECISIÓN                    ACTUACIÓN
```

Separar estas tres etapas es la razón por la que se puede sumar hardware nuevo sin tocar el núcleo del sistema.

---

## 2. Arquitectura general (dónde vive cada cosa)

| Capa | Servicio | Ubicación |
|---|---|---|
| Frontend | React, Firebase Hosting | `frontend-libro-guardia/` → `mss-guard.web.app` |
| Backend / API | Cloud Functions (Express) | `functions/` → `/api/*` |
| Base de datos | Firestore | Proyecto Firebase del cliente |
| Hardware — actuación (abrir puerta) | Bridge local en PC de planta | `scripts/sr201-bridge.js` |
| Hardware — identificación (lectores biométricos/tarjeta) | Bridge/estación local | `scripts/programa-estacion.js`, `scripts/programa-biostar.js` |
| Citaciones (Excel) | Bridge de carpeta | `scripts/citaciones-folder-bridge.js` |

**Regla de oro:** el frontend nunca habla directo con Firestore (`firestore.rules` lo bloquea) ni con el hardware. Todo pasa por Cloud Functions, y el hardware de planta nunca es alcanzado directo desde internet — siempre vía el bridge local + túnel (Cloudflare Tunnel u otro).

Cada cliente = 1 proyecto Firebase propio, 1 repo propio, 1 secret de deploy propio. Nunca se comparten datos ni credenciales entre clientes. Ver `INSTALL-CLIENTE-NUEVO.md` para el checklist paso a paso de alta.

---

## 3. Los dos catálogos de integración de hardware

### 3.1 Identificación (entrante — lector → sistema)

Archivo clave: `functions/lib/accessIngest.js`. Normaliza **cualquier** payload de hardware a un formato canónico interno:

| Método | Prefijo interno | Ejemplo de origen |
|---|---|---|
| DNI | (número directo) | Lector de documento / PDF417 |
| Credencial / tarjeta | `CARD#xxxx` | HID, tarjetas RFID genéricas |
| Biométrico | `BIO#xxxx` | ZKTeco, Hikvision, Suprema |
| Manual | — | Apertura por guardia |

Catálogo de marcas homologadas: `functions/lib/accessHardwareBrands.js` (`ACCESS_HARDWARE_BRANDS`). Cada marca define:
- `kinds`: qué tipo de credencial maneja (biométrico, tarjeta, DNI)
- `setupSteps`: pasos en texto simple para el instalador
- `personFieldHint`: qué campo cargar en la ficha de la persona
- `stationPlugin`: qué plugin de estación local traduce esa marca

**Marcas ya homologadas hoy:** ZKTeco, Hikvision, Suprema, HID, lector de DNI genérico.

**Auto-detección de marca (V1):** en Admin → Lectores podés cargar la IP (y usuario/clave si aplica) del equipo y pulsar **Detectar marca**. La orden va a la **estación local** (LAN): nunca desde Cloud Functions directo al hardware. Cobertura V1:
- **Hikvision** — ISAPI `/ISAPI/System/deviceInfo` (confianza alta)
- **Suprema** — solo si la IP es un **servidor BioStar 2** (login API); no terminales standalone
- **ZKTeco** — fingerprint TCP 4370 **best-effort** (confirmá en sitio)
Si no hay match, el alta sigue con elección manual. El password del equipo no queda persistido tras el claim del job. Los jobs vencidos se borran con **TTL nativo de Firestore** sobre el campo `expireAt` (configurar una vez en Firebase Console → Firestore → TTL; sin cron).

**Backlog aparte (no mezclar con V1):** *Integración nativa Suprema vía G-SDK* (terminales standalone) — requiere diseño y aprobación propios.

**Import batch ya integrado:** BioStar 2 (`functions/lib/biostarImport.js`) — hoy es importación periódica (CSV/export), no push en tiempo real. *(Ver roadmap para pasar a webhook real.)*

### 3.2 Actuación (saliente — sistema → relé/puerta)

Archivo clave: `functions/lib/doorDrivers/index.js` — registry de drivers. Cada driver cumple el mismo contrato:

```js
triggerRelay(deviceConfig, options) → { triggered: bool, via: string, ... }
```

| Driver | Archivo | Protocolo | Cuándo usarlo |
|---|---|---|---|
| `sr201` | `doorDrivers/sr201.js` | TCP propietario (puerto 6722) | Placa relé Ethernet SR201 (Integra) |
| `generic_http` | `doorDrivers/genericHttp.js` | HTTP/webhook (`{action, seconds}`) | Cualquier controladora/ESP/Shelly con endpoint HTTP propio |

Agregar una marca nueva de **actuación** = escribir un archivo nuevo en `doorDrivers/` que respete el mismo contrato y registrarlo en `index.js`. No se toca nada del core de decisión (`functions/accessControl.js`).

### 3.3 El "conector universal" real: paneles OSDP/Wiegand

Si el panel de la puerta soporta **OSDP o Wiegand**, el panel abstrae la marca del lector conectado en el cable — MSS solo habla con el panel, no con cada lector. Esto es lo más parecido a "cualquier lector" sin desarrollo por marca. *(Ver roadmap — desarrollo pendiente, no existe aún un driver OSDP.)*

---

## 4. Estaciones y bridges locales — qué instalar en planta

| Concepto | Qué es | Dónde vive |
|---|---|---|
| **Estación** | Un proceso (mini PC / Raspberry Pi / PC de guardia) que agrupa uno o más lectores físicos y expone un servidor HTTP local | Colección Firestore `estaciones`, config en `functions/lib/estaciones.js` |
| **Bridge SR201** | Traduce HTTP (de Functions) a TCP (al SR201) | `scripts/sr201-bridge.js` |
| **Túnel** | Expone el bridge local a internet sin abrir puertos en el router | Cloudflare Tunnel (recomendado) — ver `docs/INSTALACION-SR201.md` |
| **Bridge citaciones** | Sincroniza carpeta Excel local con el sistema | `scripts/citaciones-folder-bridge.js` |

**Por qué existe el bridge:** Firebase Functions está en internet; el hardware de planta está en la LAN del cliente. Nunca se exponen los equipos directo — siempre bridge + túnel + secreto (`BRIDGE_SECRET` / `secretoLocal`).

Checklist físico de puesta en marcha de un canal SR201 — ya documentado en detalle en `docs/INSTALACION-SR201.md` (cableado, IP fija, prueba de pulso `11*`, túnel Cloudflare, verificación `/health`). **No reinventar ese documento — seguirlo tal cual.**

---

## 5. Checklist resumido: instalación cliente nuevo

(Detalle completo y actualizado siempre en `INSTALL-CLIENTE-NUEVO.md` — acá el resumen conceptual.)

1. **Branding** — `frontend-libro-guardia/src/config/brand.js` + logos/favicons.
2. **Proyecto Firebase propio** — `.firebaserc`, secrets (`JWT_SECRET`, `SETUP_KEY`, `ALLOWED_ORIGINS`).
3. **Build y test en verde** (frontend + functions) antes de deployar.
4. **Deploy** — GitHub Actions (recomendado) o manual (`firebase deploy --only "hosting,functions"`).
5. **Hardware de planta** — bridge SR201 corriendo 24/7, túnel activo, `device.driver` configurado en Admin → Puertas.
6. **Post-deploy** — bootstrap de usuarios, cambio de contraseña admin, notificaciones SMTP, verificar auditoría/reportes.

---

## 6. Multi-puerta, estancos y métodos de auth

Conceptos completos en `docs/MULTI-PUERTAS.md`. Resumen para instalador:

- Cada **puerta** = 1 canal de relé + lectores asociados (`readerId`).
- **Estanco** = 2 puertas en secuencia (exterior/interior) con retardos configurables — todo en un solo panel Admin → Puertas y acceso.
- Métodos de auth por puerta: `dni`, `credential`, `biometric` (próx. `face` dedicado), `manual`.
- Botón "Abrir puerta" del guardia **siempre** funciona (no depende de autorización), pero sí depende de que el hardware/bridge/túnel estén operativos.

---

## 7. Roles y permisos

| Rol | Alcance |
|---|---|
| `guardia` | Registro, kiosk, puertas, GPS, asistencia |
| `supervisor` | + maestros, flota, usuarios |
| `monitoreo` | Vehículos autorizados / botonera |
| `admin` | Acceso completo + roles / hardware / GPS config |

Lógica en `functions/roles.js` y `functions/permissions.js`. Middleware de auth compartido: `functions/middleware/auth.js`.

---

## 8. Mapa de archivos — "¿dónde está esto?"

| Necesito... | Archivo |
|---|---|
| Agregar marca de lector (identificación) | `functions/lib/accessHardwareBrands.js` |
| Agregar driver de puerta (actuación) | `functions/lib/doorDrivers/*.js` + registrar en `index.js` |
| Cambiar cómo se normaliza un evento entrante | `functions/lib/accessIngest.js` |
| Lógica central de decisión (autoriza o no) | `functions/accessControl.js` |
| Config de puertas/estancos | `functions/lib/doorsConfig.js`, `functions/lib/doorAccess.js` |
| Estaciones / lectores locales | `functions/lib/estaciones.js`, `functions/lib/lectores.js` |
| Import BioStar 2 | `functions/lib/biostarImport.js`, `biostarMatch.js` |
| Rutas HTTP de acceso | `functions/routes/access.js` |
| Roles/permisos | `functions/roles.js`, `functions/permissions.js` |
| Setup de cliente nuevo | `INSTALL-CLIENTE-NUEVO.md` |
| Instalación física SR201 | `docs/INSTALACION-SR201.md` |
| Lector de puerta desatendida | `docs/INSTALACION-LECTOR-PUERTA.md` |
| Multi-puerta / estancos | `docs/MULTI-PUERTAS.md` |

---

## 9. Errores comunes en campo (troubleshooting rápido)

| Síntoma | Causa probable | Dónde mirar |
|---|---|---|
| Timeout / DNS al probar relé | Túnel caído o mal apuntado | `cloudflared` en la PC de planta |
| 502 Cloudflare | Bridge local no corriendo | `sr201-bridge.js` — revisar servicio |
| Health OK pero pulso 401 | Secreto distinto entre Admin y bridge | Comparar `BRIDGE_SECRET` |
| Persona autorizada pero no abre | Driver mal configurado en la puerta (`device.driver`) | Admin → Puertas |
| Ingest 400 "faltan datos identificación" | El plugin de estación no mapea bien el evento | `accessIngest.js` — revisar `authMethod` enviado |
